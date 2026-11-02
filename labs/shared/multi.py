"""参考实现：多 agent 系统（Python 通道）。

对照 shared/multi.ts。

Python 这一版有三处和 TS 不同，都不是风格问题，是**会咬人的语义差别**：

  1. asyncio.gather(return_exceptions=True) 不等于 Promise.allSettled。
     它返回的是"值或异常对象"混在一起的列表，而**异常对象是真的异常对象**——
     你 if not isinstance(x, Exception) 漏掉一次，后面就在拿异常当报告用。

  2. asyncio.CancelledError 在 Python 3.8+ **不是 Exception 的子类**。
     except Exception 抓不到它。而 fanout 里"一个 sub-agent 崩了不该
     让整批白跑"这条，如果把取消也当成崩溃处理，取消就会失效——
     整批会继续跑完。

  3. dataclass 的可变默认值要用 field(default_factory=list)。
     写成 boundaries: list[str] = [] 会直接抛 ValueError（这个还算好），
     但 asdict / replace 上的坑不会响。
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from .context_budget import estimate_tokens
from .ledger import Totals

# ─────────────────────────────────────────────────────────────
# 一、任务书
# ─────────────────────────────────────────────────────────────


@dataclass
class Brief:
    """派给一个 sub-agent 的任务书。

    ★ 字段不是随便定的。Anthropic 在生产里踩出来的结论是：
    一份任务书必须包含**目标、输出格式、工具/信源指引、任务边界**四项。
    缺了边界，多个 sub-agent 会做重复的活。
    """

    agent: str
    goal: str
    context: str
    deliverable: str
    # ★ 可变默认值必须走 default_factory。这是 Python 特有的一条。
    boundaries: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)


ProblemKind = Literal[
    "dangling_reference",
    "no_context",
    "no_deliverable",
    "no_boundaries",
    "no_tools",
    "goal_too_vague",
]


@dataclass
class BriefProblem:
    kind: ProblemKind
    message: str


DANGLING = [
    "上面", "上述", "前面提到", "刚才", "之前说的", "如前", "同上",
    "那个文件", "这个文件", "该文件", "它的", "他们的",
    "the above", "as mentioned", "aforementioned", "as discussed", "that file",
]

VAGUE_GOALS = [
    "研究", "调查", "看一下", "分析", "了解",
    "research", "investigate", "look into", "analyze",
]


@dataclass
class BriefCheck:
    ok: bool
    problems: list[BriefProblem]


def check_brief(b: Brief) -> BriefCheck:
    """校验一份任务书。返回 problems 列表而不是抛异常。"""
    problems: list[BriefProblem] = []
    all_text = f"{b.goal} {b.context} {b.deliverable}"

    for word in DANGLING:
        if word in all_text:
            problems.append(
                BriefProblem(
                    "dangling_reference",
                    f"任务书里出现了「{word}」。sub-agent 是一个全新的上下文，"
                    "它看不到编排者的对话历史——这是一个空引用。\n"
                    "      而它不会报错：它会编一个所指出来，"
                    "然后基于编出来的东西干完整个任务。",
                )
            )
            break

    if not b.context.strip():
        problems.append(
            BriefProblem(
                "no_context", "context 是空的。编排者知道的一切，sub-agent 一个字都看不到。"
            )
        )

    if not b.deliverable.strip():
        problems.append(
            BriefProblem(
                "no_deliverable",
                "没有 deliverable。编排者最后会拿到一堆形状不一样、没法合并的散文。",
            )
        )

    if not b.boundaries:
        problems.append(
            BriefProblem(
                "no_boundaries",
                "没有 boundaries。这是重复劳动的唯一成因："
                "三个 sub-agent 都被派去「研究供应链」时，只有边界能让它们分头查不同的部分。",
            )
        )

    if not b.tools:
        problems.append(
            BriefProblem(
                "no_tools",
                "tools 是空的（不限）。一个能用全部工具的 sub-agent 会自己发明工作范围，"
                "而它的账单由你付。",
            )
        )

    goal = b.goal.strip()
    if any(goal.startswith(v) for v in VAGUE_GOALS) and len(goal) < 14:
        problems.append(
            BriefProblem(
                "goal_too_vague",
                f"目标「{goal}」太宽。派给三个 sub-agent，它们会各自决定这句话是什么意思——"
                "实测结果是其中两个查了同一件事。",
            )
        )

    return BriefCheck(ok=not problems, problems=problems)


# ─────────────────────────────────────────────────────────────
# 二、重复劳动
# ─────────────────────────────────────────────────────────────


@dataclass
class Overlap:
    a: str
    b: str
    score: float
    shared: list[str]


_WORD = re.compile(r"[a-z][a-z0-9_]{2,}|[\u4e00-\u9fa5]{2,}")
STOP = {"the", "and", "for", "with", "that", "this", "from"}


def keywords(text: str) -> set[str]:
    """中英混排的粗分词。中文长词切二元组。"""
    out: set[str] = set()
    for m in _WORD.finditer(text.lower()):
        w = m.group(0)
        if re.search(r"[\u4e00-\u9fa5]", w):
            for i in range(len(w) - 1):
                out.add(w[i : i + 2])
        else:
            out.add(w)
    return out


def detect_overlap(briefs: list[Brief], threshold: float = 0.5) -> list[Overlap]:
    """检测一批任务书之间的重复。

    ★ 必须在**派发之前**做：sub-agent 之间不共享上下文，
    所以它们没有任何办法发现自己在做重复的活。
    """
    kw = [keywords(f"{b.goal} {b.deliverable}") - STOP for b in briefs]

    out: list[Overlap] = []
    for i in range(len(briefs)):
        for j in range(i + 1, len(briefs)):
            shared_kw = sorted(kw[i] & kw[j])
            smaller = min(len(kw[i]), len(kw[j]))
            # 分母用较短那份，不是并集：窄任务被宽任务整个包含时，
            # 并集会把分数摊薄，而那恰恰是最该报出来的形状。
            score = 0.0 if smaller == 0 else len(shared_kw) / smaller
            if score >= threshold:
                out.append(Overlap(briefs[i].agent, briefs[j].agent, score, shared_kw[:8]))
    return out


# ─────────────────────────────────────────────────────────────
# 三、写冲突
# ─────────────────────────────────────────────────────────────


@dataclass
class WriteConflict:
    resource: str
    agents: list[str]


WRITE_TOOLS = ["write_file", "edit_file", "run_command", "delete_file"]
_PATH = re.compile(r"[\w./-]+\.\w{1,5}\b")


def check_write_conflicts(
    briefs: list[Brief], write_tools: list[str] | None = None
) -> list[WriteConflict]:
    """★ 全节最有用的一条判据：**并行 sub-agent 必须是只读的。**

    理由不是"并发难写对"，是更根本的：sub-agent 之间没有共享状态，
    所以它们**看不到彼此的写入**。后写的覆盖先写的，
    而且**两边都认为自己成功了**。
    """
    tools = write_tools if write_tools is not None else WRITE_TOOLS
    by_resource: dict[str, set[str]] = {}

    for b in briefs:
        if not [t for t in b.tools if t in tools]:
            continue
        paths = _PATH.findall(f"{b.goal} {b.deliverable} {b.context}")
        for p in paths or ["(未指明路径)"]:
            by_resource.setdefault(p, set()).add(b.agent)

    return [
        WriteConflict(res, sorted(agents))
        for res, agents in by_resource.items()
        if len(agents) > 1
    ]


# ─────────────────────────────────────────────────────────────
# 四、投入分级
# ─────────────────────────────────────────────────────────────

Tier = Literal["single", "small_fanout", "large_fanout"]


@dataclass
class Effort:
    tier: Tier
    agents: int
    tool_calls_each: int
    why: str


def plan_effort(
    *, independent_threads: int, needs_write: bool, exceeds_context: bool
) -> Effort:
    """★ 这套分级是 Anthropic 写进 prompt 里的规则——因为模型自己判断不了
    该投入多少。他们早期版本的真实故障是：一个简单查询开了 50 个 sub-agent。

    所以这件事不能交给模型。它是代码。
    """
    if needs_write:
        return Effort(
            "single", 1, 15,
            "要写东西。并行 sub-agent 看不到彼此的写入，后写的覆盖先写的，而两边都报告成功。",
        )

    if independent_threads <= 1:
        return Effort(
            "single", 1, 10,
            "只有一个独立方向。开多个 agent 只是把同一条路走多遍，付 N 倍的钱。",
        )

    if independent_threads <= 4 and not exceeds_context:
        return Effort(
            "small_fanout", min(independent_threads, 4), 12,
            f"{independent_threads} 个独立方向，语料塞得下。小扇出，每个 agent 的边界要写清楚。",
        )

    return Effort(
        "large_fanout", min(independent_threads, 10), 12,
        f"{independent_threads} 个独立方向"
        + ("，且语料超过单个上下文窗口" if exceeds_context else "")
        + "。这是多 agent 唯一真正划算的场景：你买的是并行探索的容量。",
    )


# ─────────────────────────────────────────────────────────────
# 五、报告与合并
# ─────────────────────────────────────────────────────────────


@dataclass
class Report:
    agent: str
    ok: bool
    summary: str
    evidence: list[str]
    usage: Totals
    steps: int
    reason: str


@dataclass
class Merged:
    summary: str
    conflicts: list[dict[str, Any]]
    gaps: list[dict[str, str]]
    evidence: list[str]


_CLAIM = re.compile(r"^\s*[-·*]?\s*([^：:=]{2,40})\s*[：:=]\s*(.+?)\s*$")


def claims_of(summary: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in summary.split("\n"):
        m = _CLAIM.match(line)
        if m:
            out[m.group(1).strip()] = m.group(2).strip()
    return out


def merge_reports(reports: list[Report]) -> Merged:
    """★ 这个函数最重要的行为是它**不做**的事：它不在矛盾的结论里挑一个。

    编排者只看到摘要，看不到任何一份原始材料——它没有能力判断哪一份对。
    让它"综合一下"的结果是一段读起来很顺、把两个矛盾结论糊在一起的文字，
    而这是多 agent 里最难发现的错误，因为输出**看起来质量很高**。
    """
    gaps = [
        {"agent": r.agent, "reason": f"停在 {r.reason}" if r.ok else f"失败：{r.reason}"}
        for r in reports
        if not r.ok or r.reason != "done"
    ]
    good = [r for r in reports if r.ok and r.reason == "done"]

    by_key: dict[str, list[tuple[str, str]]] = {}
    for r in good:
        for k, v in claims_of(r.summary).items():
            by_key.setdefault(k, []).append((r.agent, v))

    conflicts: list[dict[str, Any]] = []
    for k, items in by_key.items():
        distinct = list(dict.fromkeys(v for _, v in items))
        if len(distinct) > 1:
            conflicts.append(
                {"agents": [a for a, _ in items], "claim": f"{k}：{' ／ '.join(distinct)}"}
            )

    evidence = list(dict.fromkeys(e for r in good for e in r.evidence))

    return Merged(
        summary="\n\n".join(f"【{r.agent}】{r.summary}" for r in good),
        conflicts=conflicts,
        gaps=gaps,
        evidence=evidence,
    )


# ─────────────────────────────────────────────────────────────
# 六、成本会计
# ─────────────────────────────────────────────────────────────


@dataclass
class CostShape:
    tool_def_tokens: int
    tool_result_tokens: int
    brief_tokens: int
    report_tokens: int


@dataclass
class CostBreakdown:
    label: str
    input_tokens: int
    parts: dict[str, int]
    calls: int
    agents: int


def cost_single(steps: int, shape: CostShape) -> CostBreakdown:
    """单 agent 的输入 token 累计。上下文每轮重发，所以是 O(n²)。"""
    growth = sum(k * shape.tool_result_tokens for k in range(steps))
    tool_defs = steps * shape.tool_def_tokens
    return CostBreakdown(
        label=f"单 agent（{steps} 步）",
        input_tokens=tool_defs + growth,
        parts={"tool_defs": tool_defs, "growth": growth, "coordination": 0},
        calls=steps,
        agents=1,
    )


def cost_multi(
    agents: int, steps_each: int, shape: CostShape, orchestrator_steps: int | None = None
) -> CostBreakdown:
    """多 agent 的输入 token 累计。

    ★ 价值全在 parts 那三项拆分上。"多 agent 贵 15 倍"没什么用；
    **知道 15 倍里有多少是协调开销、多少是重复付的工具定义**，才能决策。
    """
    orch_steps = orchestrator_steps if orchestrator_steps is not None else agents + 2

    sub_growth = agents * sum(k * shape.tool_result_tokens for k in range(steps_each))
    sub_tool_defs = agents * steps_each * shape.tool_def_tokens
    orch_growth = sum(k * shape.report_tokens for k in range(orch_steps))
    orch_tool_defs = orch_steps * shape.tool_def_tokens
    coordination = agents * steps_each * shape.brief_tokens + agents * shape.report_tokens

    return CostBreakdown(
        label=f"多 agent（{agents} 个 × {steps_each} 步）",
        input_tokens=sub_tool_defs + orch_tool_defs + sub_growth + orch_growth + coordination,
        parts={
            "tool_defs": sub_tool_defs + orch_tool_defs,
            "growth": sub_growth + orch_growth,
            "coordination": coordination,
        },
        calls=agents * steps_each + orch_steps,
        agents=agents + 1,
    )


def cost_chat(turn_tokens: int = 250, turns: int = 6) -> CostBreakdown:
    """一次普通聊天，作为倍数的分母。

    ★ 聊天里**没有工具定义、也没有工具结果**——这正是它便宜的原因。
    """
    growth = sum(k * turn_tokens for k in range(turns))
    return CostBreakdown(
        label=f"纯聊天（{turns} 轮）",
        input_tokens=growth,
        parts={"tool_defs": 0, "growth": growth, "coordination": 0},
        calls=turns,
        agents=0,
    )


# ─────────────────────────────────────────────────────────────
# 七、拓扑选型
# ─────────────────────────────────────────────────────────────

Topology = Literal["single", "workflow", "multi_agent", "handoff"]


@dataclass
class TopologyChoice:
    topology: Topology
    why: str


def choose_topology(
    *,
    independent_threads: int,
    needs_write: bool,
    exceeds_context: bool,
    has_dependencies: bool,
    value_per_task: Literal["low", "high"],
    needs_specialist_switch: bool,
) -> TopologyChoice:
    """该不该上多 agent。顺序上它在 L07 的 choose_pattern 之后：
    先定要不要 agent，再定要不要多个。
    """
    if has_dependencies and independent_threads > 1:
        return TopologyChoice(
            "workflow",
            "步骤之间有依赖。这是 workflow，不是多 agent——"
            "依赖关系应该写在代码里，不该让模型在运行时协调。",
        )

    if needs_write:
        return TopologyChoice(
            "single", "要写东西。并行 sub-agent 看不到彼此的写入，而且都会报告成功。"
        )

    if needs_specialist_switch and independent_threads <= 1:
        return TopologyChoice(
            "handoff",
            "一条线程，但中途要换专长。交接（转移控制权、共享历史）比派 sub-agent 便宜，"
            "因为不用重新组装上下文。",
        )

    if independent_threads <= 1:
        return TopologyChoice(
            "single", "只有一个独立方向。多 agent 在这里就是把同一条路走多遍。"
        )

    if value_per_task == "low" and not exceeds_context:
        return TopologyChoice(
            "single",
            "有并行空间，但任务单次价值低。15 倍的 token 成本没有东西来抵——"
            "先用单 agent，等它真的成了瓶颈再说。",
        )

    return TopologyChoice(
        "multi_agent",
        f"{independent_threads} 个独立方向、只读、"
        + ("语料超过单个上下文窗口、" if exceeds_context else "")
        + "任务价值高。这是多 agent 划算的那种场景。",
    )


# ─────────────────────────────────────────────────────────────
# 八、派发（四道闸）
# ─────────────────────────────────────────────────────────────


@dataclass
class FanoutOptions:
    max_agents: int
    max_depth: int
    max_yuan: float
    concurrency: int
    depth: int = 0


@dataclass
class Preflight:
    overlaps: list[Overlap]
    conflicts: list[WriteConflict]
    brief_problems: dict[str, list[BriefProblem]]


@dataclass
class FanoutResult:
    reports: list[Report]
    merged: Merged
    rejected: list[dict[str, str]]
    preflight: Preflight


class SubAgentRunner(Protocol):
    async def __call__(self, brief: Brief) -> Report: ...


_ZERO = Totals(
    calls=0, input_tokens=0, output_tokens=0, cache_read=0, cache_write=0, ms=0.0, yuan=0.0
)


async def fanout(
    briefs: list[Brief],
    run: SubAgentRunner | Callable[[Brief], Any],
    opts: FanoutOptions,
) -> FanoutResult:
    """派发一批 sub-agent。

    ★ 派发**之前**先体检，而且体检结果要返回给调用方，不是打个日志。
    重复劳动和写冲突一旦派出去就无法挽回——钱已经花了、文件已经被覆盖了。
    """
    rejected: list[dict[str, str]] = []
    preflight = Preflight(
        overlaps=detect_overlap(briefs),
        conflicts=check_write_conflicts(briefs),
        brief_problems={
            b.agent: check_brief(b).problems for b in briefs if check_brief(b).problems
        },
    )

    if opts.depth >= opts.max_depth:
        return FanoutResult(
            reports=[],
            merged=merge_reports([]),
            rejected=[
                {
                    "agent": b.agent,
                    "reason": f"深度 {opts.depth} 已达上限 {opts.max_depth}。"
                    "没有这道闸的话，sub-agent 开 sub-agent 是指数级的账单。",
                }
                for b in briefs
            ],
            preflight=preflight,
        )

    todo = briefs
    if len(briefs) > opts.max_agents:
        todo = briefs[: opts.max_agents]
        rejected += [
            {"agent": b.agent, "reason": f"超过 max_agents={opts.max_agents}，没有派发"}
            for b in briefs[opts.max_agents :]
        ]

    reports: list[Report] = []
    spent = 0.0

    for i in range(0, len(todo), opts.concurrency):
        # ★ 预算在**批之间**检查，不是开头查一次。
        # 一个失控的 sub-agent 能把整个预算吃掉，后面的应该被拦住。
        if spent >= opts.max_yuan:
            rejected += [
                {"agent": b.agent, "reason": f"预算已用完（{spent:.4f} / {opts.max_yuan} 元）"}
                for b in todo[i:]
            ]
            break

        batch = todo[i : i + opts.concurrency]
        settled = await asyncio.gather(*(run(b) for b in batch), return_exceptions=True)

        for b, res in zip(batch, settled, strict=True):
            # ★ 两处 Python 特有的坑挤在这四行里：
            #
            #   1. gather(return_exceptions=True) 返回的是"值或异常对象"混在
            #      一起的列表。漏掉 isinstance 判断，后面就在拿异常当报告用。
            #   2. CancelledError 在 3.8+ 不是 Exception 的子类。
            #      用 except Exception 或 isinstance(res, Exception) 都抓不到它，
            #      而**取消必须往上抛**——把取消当成崩溃处理的话，
            #      整批会继续跑完，取消就失效了。
            if isinstance(res, asyncio.CancelledError):
                raise res
            if isinstance(res, BaseException):
                reports.append(
                    Report(
                        agent=b.agent, ok=False, summary="", evidence=[],
                        usage=_ZERO, steps=0, reason=str(res) or type(res).__name__,
                    )
                )
            else:
                reports.append(res)
                spent += res.usage.yuan

    return FanoutResult(
        reports=reports, merged=merge_reports(reports), rejected=rejected, preflight=preflight
    )


# ─────────────────────────────────────────────────────────────
# 九、交接
# ─────────────────────────────────────────────────────────────


@dataclass
class HandoffStep:
    from_agent: str
    to: str
    reason: str


@dataclass
class HandoffResult:
    final: str
    path: list[HandoffStep]
    loop: list[str] | None = None


def handoff(
    start: str,
    route: Callable[[str], dict[str, str] | None],
    max_hops: int = 8,
) -> HandoffResult:
    """交接：把控制权转给另一个 agent，**共享同一份对话历史**。

    ★ 和 sub-agent 的区别不是实现方式，是**信息模型**：

      sub-agent  上下文隔离。贵、有损、**可并行**。
      交接        上下文共享。便宜、无损、**只能串行**。

    判据：**要并行就 sub-agent，不要并行就交接。**
    """
    path: list[HandoffStep] = []
    visited = [start]
    cur = start

    for _ in range(max_hops):
        nxt = route(cur)
        if not nxt:
            return HandoffResult(final=cur, path=path)

        path.append(HandoffStep(cur, nxt["to"], nxt["reason"]))

        # ★ 环检测。两个 agent 互相交接是真实故障模式，
        # 而它的表现是"请求一直不返回"——没有异常、没有错误日志。
        if nxt["to"] in visited:
            return HandoffResult(final=cur, path=path, loop=[*visited, nxt["to"]])

        visited.append(nxt["to"])
        cur = nxt["to"]

    return HandoffResult(final=cur, path=path, loop=visited)


# ─────────────────────────────────────────────────────────────
# 十、传话游戏
# ─────────────────────────────────────────────────────────────


@dataclass
class TelephoneResult:
    hops: list[dict[str, Any]]
    retention: float


def telephone(
    *, raw_tokens: int, agents: int, summary_tokens_each: int, final_tokens: int
) -> TelephoneResult:
    """量化"传话游戏"：原始材料经过两层转述之后还剩多少。

    ★ 不是为了算准，是为了让一件事变得可见：
    **多 agent 的信息路径上有两次有损压缩，而单 agent 一次都没有。**
    """
    after = agents * summary_tokens_each
    return TelephoneResult(
        hops=[
            {"stage": "原始材料", "tokens": raw_tokens, "kept": 1.0},
            {"stage": f"{agents} 份 sub-agent 摘要", "tokens": after, "kept": after / raw_tokens},
            {"stage": "编排者综合", "tokens": final_tokens, "kept": final_tokens / raw_tokens},
        ],
        retention=final_tokens / raw_tokens,
    )


def to_artifact_ref(report: Report, store: Callable[[str, str], str]) -> Report:
    """把一份报告改成"引用式"：内容落盘，只留指针。"""
    if not report.summary:
        return report
    ref = store(report.agent, report.summary)
    head = report.summary.split("\n")[0]
    return Report(
        agent=report.agent,
        ok=report.ok,
        summary=f"{head[:120]}（全文见 {ref}）",
        evidence=[*report.evidence, ref],
        usage=report.usage,
        steps=report.steps,
        reason=report.reason,
    )


def tokens_of(s: str) -> int:
    return estimate_tokens(s)
