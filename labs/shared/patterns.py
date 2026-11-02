"""参考实现：五种编排模式（Python 版）。

这五个函数看起来差别很大，但它们只在回答同一个问题：**谁决定下一步。**

    chain        你决定全部。模型只填内容
    route        模型决定一次（走哪条），之后你决定
    parallel     你决定拆法，模型并行填叶子
    orchestrate  模型决定拆法，你决定怎么执行和合并
    refine       模型决定什么时候停

自主性从上到下递增，而**成本方差和调试难度跟着一起涨**。
这个排序就是选型判据本身：从上往下挑，够用就停。

和 TS 版的三处真实差异，值得单独留意：

一 · **并发。** TS 里 pooled 是手写的游标池；Python 用 asyncio.Semaphore，
      配合 asyncio.gather(..., return_exceptions=True) 拿到 settled 语义。
      忘了 return_exceptions=True 的后果和 TS 里用 Promise.all 一样：
      一个分片失败，整批白跑。

二 · **异常即控制流。** Python 社区更习惯抛异常，但 chain 的关口这里仍然
      选择 return——因为上游要拿到「走到哪一步」和「已经产出了什么」，
      而这些塞进异常里会被 traceback 淹掉。

三 · **dataclass 的可变默认值。** Usage 用了 dataclass，
      加法写成返回新对象而不是原地改——原地改在并发下是 race。
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, TypeVar

# ─────────────────────────────────────────────────────────────
# 基础类型
# ─────────────────────────────────────────────────────────────


class Call(Protocol):
    """一次模型调用。抽象成 Protocol，让 verify 能塞假模型。"""

    async def __call__(
        self,
        messages: list[dict[str, Any]],
        *,
        system: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> Any: ...


@dataclass(frozen=True)
class Usage:
    input: int = 0
    output: int = 0
    calls: int = 0

    def plus(self, res: Any) -> Usage:
        """★ 返回新对象而不是原地改。原地改在 gather 并发下是 race。"""
        u = _field_of(res, "usage")
        return Usage(
            input=self.input + int(_field_of(u, "input_tokens") or 0),
            output=self.output + int(_field_of(u, "output_tokens") or 0),
            calls=self.calls + 1,
        )


def _field_of(obj: Any, name: str) -> Any:
    """dict 和 SDK 对象混着来，取字段要两条路都走通（和 L06 那个 field_of 同源）。"""
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def text_of(res: Any) -> str:
    parts: list[str] = []
    for block in _field_of(res, "content") or []:
        if _field_of(block, "type") == "text":
            parts.append(str(_field_of(block, "text") or ""))
    return "".join(parts)


# ─────────────────────────────────────────────────────────────
# 一、链式：你决定全部
# ─────────────────────────────────────────────────────────────


@dataclass
class ChainStep:
    name: str
    prompt: Callable[[str], str]
    system: str | None = None
    # 返回 True 继续；返回 False 或 str 则中止，str 作为原因。
    #
    # ★ 这是链式模式最容易漏的一件事。没有关口的链会把垃圾一路传到底，
    # 然后你在最后一步看到一个荒谬的结果，得回头一步步查是哪里坏的。
    gate: Callable[[str], bool | str] | None = None


@dataclass
class ChainResult:
    output: str
    usage: Usage
    path: list[str] = field(default_factory=list)
    stopped_at: str | None = None
    gate_message: str | None = None


async def chain(input_text: str, steps: Sequence[ChainStep], call: Call) -> ChainResult:
    if not steps:
        raise ValueError("链是空的。这通常是配置读错了，不该静默返回输入")

    cur = input_text
    usage = Usage()
    path: list[str] = []

    for step in steps:
        res = await call([{"role": "user", "content": step.prompt(cur)}], system=step.system)
        usage = usage.plus(res)
        cur = text_of(res)
        path.append(step.name)

        if step.gate is not None:
            verdict = step.gate(cur)
            # ★ 用 `is not True` 而不是 `not verdict`：
            # 空字符串是 falsy 但不是 True，而"关口没通过却忘了写原因"
            # 恰恰会返回空字符串。写成 `not verdict` 会把它当成通过。
            if verdict is not True:
                # 中止时 return 而不是 raise：上游要拿到已经走完的部分和停在哪一步。
                # 抛异常会把这些信息丢进 traceback，而 traceback 里没有业务信息。
                spelled = isinstance(verdict, str) and verdict
                why = verdict if spelled else f"{step.name} 的关口没通过"
                return ChainResult(
                    output=cur,
                    usage=usage,
                    path=path,
                    stopped_at=step.name,
                    gate_message=why,
                )

    return ChainResult(output=cur, usage=usage, path=path)


# ─────────────────────────────────────────────────────────────
# 二、路由：模型决定一次
# ─────────────────────────────────────────────────────────────

T = TypeVar("T", bound=str)


@dataclass
class Route:
    id: str
    # 给模型看的描述。它是分类准确率的唯一决定因素。
    when: str
    handle: Callable[[str, Call], Awaitable[str]]


@dataclass
class RouteResult:
    picked: str
    output: str
    usage: Usage
    # 模型给的原始标签。和 picked 不一致说明兜底生效了，这条要进日志。
    raw: str
    fell_back: bool


_LABEL_JUNK = re.compile(r"[^a-z0-9_-]")


async def route(
    input_text: str,
    routes: Sequence[Route],
    call: Call,
    *,
    fallback: str,
    classifier_system: str | None = None,
) -> RouteResult:
    """路由。实践中投入产出比最高的一个模式——
    它让你用便宜模型接住八成流量，而这八成本来在付强模型的钱。

    ★ 两个必须做的事：

    一 · **不能相信模型给的标签。** 它会输出 "billing "（带空格）、"Billing"、
         "billing/技术支持"、或者一整句解释。必须在枚举里查，查不到走兜底。

    二 · **兜底不能是"随便挑一个"。** 分类不确定意味着这条输入是边缘情况，
         而边缘情况恰恰是最需要强能力的。所以兜底应该指向**能力最强**的那条，
         不是最便宜的那条。这一条和直觉相反，但线上事故都长这样。
    """
    if not routes:
        raise ValueError("没有可选路由")

    menu = "\n".join(f"- {r.id}：{r.when}" for r in routes)
    res = await call(
        [
            {
                "role": "user",
                "content": (
                    f"把下面的请求归到一类，只输出类别 id，不要任何别的内容。\n\n"
                    f"可选类别：\n{menu}\n\n请求：\n{input_text}"
                ),
            }
        ],
        system=classifier_system,
        # 分类要的是确定性，不是创造力。而且低温让路由结果可缓存。
        temperature=0,
        # 只需要一个标签。给大额度只会让它开始解释。
        max_tokens=16,
    )

    raw = text_of(res).strip()
    # 宽松匹配：模型很爱加标点、大小写不一致、或者把 id 包在句子里。
    # 但宽松只能到"在已知枚举里找"这一步，不能到"猜一个"。
    norm = _LABEL_JUNK.sub("", raw.lower())
    hit = next((r for r in routes if r.id.lower() == norm), None)
    if hit is None:
        hit = next((r for r in routes if r.id.lower() in norm), None)

    picked = hit.id if hit else fallback
    target = next((r for r in routes if r.id == picked), None)
    if target is None:
        raise ValueError(f"兜底路由 {fallback} 不在 routes 里。这是配置 bug")

    output = await target.handle(input_text, call)

    return RouteResult(
        picked=picked,
        output=output,
        usage=Usage().plus(res),
        raw=raw,
        fell_back=hit is None,
    )


# ─────────────────────────────────────────────────────────────
# 三、并行：你决定拆法
# ─────────────────────────────────────────────────────────────


@dataclass
class ParallelResult:
    outputs: list[str | None]
    usage: Usage
    failed: list[tuple[int, str]]


async def gather_pooled(
    items: Sequence[Any],
    limit: int,
    worker: Callable[[Any, int], Awaitable[Any]],
) -> list[Any | BaseException]:
    """带上限的并发，settled 语义。

    ★ return_exceptions=True 是这个函数存在的全部理由。
    忘了它的后果和 TS 里用 Promise.all 一样：一个分片失败，整批白跑。
    而且 gather 会把还没完成的任务留在后台跑完——静默烧钱。
    """
    sem = asyncio.Semaphore(max(1, limit))

    async def guarded(item: Any, i: int) -> Any:
        async with sem:
            return await worker(item, i)

    return await asyncio.gather(
        *(guarded(item, i) for i, item in enumerate(items)),
        return_exceptions=True,
    )


async def parallel(
    prompts: Sequence[str],
    call: Call,
    *,
    concurrency: int = 4,
    system: str | None = None,
    temperature: float | None = None,
) -> ParallelResult:
    """并行。两种用法差别很大，别混：

    分片（sectioning）—— 把一件事拆成互不相干的几块，各做一块，最后拼起来
    投票（voting）    —— 同一件事做 N 次，取多数
    """

    async def one(p: str, _i: int) -> Any:
        return await call(
            [{"role": "user", "content": p}], system=system, temperature=temperature
        )

    settled = await gather_pooled(prompts, concurrency, one)

    usage = Usage()
    outputs: list[str | None] = []
    failed: list[tuple[int, str]] = []

    for i, r in enumerate(settled):
        if isinstance(r, BaseException):
            outputs.append(None)
            failed.append((i, str(r)))
        else:
            usage = usage.plus(r)
            outputs.append(text_of(r))

    return ParallelResult(outputs=outputs, usage=usage, failed=failed)


V = TypeVar("V")


@dataclass
class VoteResult:
    winner: Any | None
    tally: list[tuple[Any, int]]
    # 得票占比。低于 0.5 意味着"多数"其实是少数，调用方该当成低置信度处理。
    confidence: float


def vote(values: Sequence[Any], key: Callable[[Any], str] | None = None) -> VoteResult:
    """投票。

    ★ 一条必须理解的前提：**投票只在错误互相独立时有效。**

    temperature=0 跑 5 次，5 个输出高度一致——包括错的时候也一致。
    这时候投票纯属把成本乘以 5 而不改变任何结果。
    要让投票有意义，必须引入独立性：调高温度，或者用不同的 prompt / 不同的模型。

    这也是为什么这个函数返回 confidence 而不只是 winner：
    3:2 和 5:0 是完全不同的结论，只返回 winner 会把这个差别抹掉。
    """
    keyfn = key or (lambda v: repr(v))
    # dict 在 Python 3.7+ 保持插入顺序，所以并列时先出现的赢——
    # 这比让它随机好，因为可复现。
    buckets: dict[str, tuple[Any, int]] = {}
    total = 0

    for v in values:
        if v is None:
            continue
        total += 1
        k = keyfn(v)
        if k in buckets:
            val, n = buckets[k]
            buckets[k] = (val, n + 1)
        else:
            buckets[k] = (v, 1)

    tally = sorted(buckets.values(), key=lambda t: t[1], reverse=True)
    top = tally[0] if tally else None

    return VoteResult(
        winner=top[0] if top else None,
        tally=tally,
        confidence=(top[1] / total) if top and total else 0.0,
    )


# ─────────────────────────────────────────────────────────────
# 四、编排-工作者：模型决定拆法
# ─────────────────────────────────────────────────────────────


class PlanError(ValueError):
    def __init__(self, msg: str, raw: str) -> None:
        super().__init__(msg)
        self.raw = raw


@dataclass
class OrchestrateResult:
    plan: list[str]
    output: str
    usage: Usage
    failed: list[tuple[int, str]]


_BULLET = re.compile(r"^[\s\-*·\d.、)]+")


async def orchestrate(
    task: str,
    call: Call,
    *,
    worker: Callable[[str, Call], Awaitable[str]],
    max_subtasks: int = 8,
    concurrency: int = 4,
    system: str | None = None,
) -> OrchestrateResult:
    """编排-工作者。和并行的区别只有一处，但很关键：**拆法是模型定的。**

    这一处差别把成本从"可预测"变成"不可预测"——模型可能拆成 3 个子任务，
    也可能拆成 40 个。所以计划必须校验。

    ★ 三条校验缺一不可：
        非空   —— 空计划要报错，不能静默返回原任务
        有上限 —— 40 个子任务意味着 40 次调用，这是账单事故
        去重   —— 模型很爱把同一件事换个说法列两遍
    """
    plan_res = await call(
        [
            {
                "role": "user",
                "content": (
                    f"把下面的任务拆成互相独立的子任务，每行一个，最多 {max_subtasks} 个。\n"
                    "只输出子任务列表，不要编号、不要解释、不要空行。\n"
                    "每个子任务必须能独立完成，不依赖其他子任务的结果。\n\n"
                    f"任务：{task}"
                ),
            }
        ],
        system=system,
        temperature=0,
    )

    usage = Usage().plus(plan_res)
    raw = text_of(plan_res)

    seen: set[str] = set()
    subtasks: list[str] = []
    for line in raw.split("\n"):
        t = _BULLET.sub("", line).strip()
        if not t:
            continue
        k = t.lower()
        if k in seen:
            continue
        seen.add(k)
        subtasks.append(t)

    if not subtasks:
        # 静默降级成"直接做整个任务"是很诱人的，但那会把一次编排失败
        # 伪装成一次正常运行——你在监控里看不到，只看到质量莫名变差。
        raise PlanError("模型没给出任何子任务。空计划要响一声，不能静默降级", raw)
    if len(subtasks) > max_subtasks:
        raise PlanError(
            f"模型拆出了 {len(subtasks)} 个子任务，超过上限 {max_subtasks}。"
            "不设上限的编排是账单事故——每个子任务都是一次调用",
            raw,
        )

    async def run(sub: str, _i: int) -> str:
        return await worker(sub, call)

    settled = await gather_pooled(subtasks, concurrency, run)
    failed: list[tuple[int, str]] = []
    parts: list[str] = []

    for i, r in enumerate(settled):
        if isinstance(r, BaseException):
            failed.append((i, str(r)))
        else:
            parts.append(f"## {subtasks[i]}\n{r}")

    if not parts:
        raise RuntimeError(f"全部 {len(subtasks)} 个子任务都失败了。先去看 failed 里的原因")

    warn = f"\n注意：有 {len(failed)} 个子任务失败了，整合时要说明哪部分缺失。\n" if failed else ""
    synth = await call(
        [
            {
                "role": "user",
                "content": (
                    "下面是几个子任务的结果。把它们整合成一份连贯的回答，"
                    f"去掉重复，保留所有具体事实。\n{warn}\n" + "\n\n".join(parts)
                ),
            }
        ],
        system=system,
    )
    usage = usage.plus(synth)

    return OrchestrateResult(plan=subtasks, output=text_of(synth), usage=usage, failed=failed)


# ─────────────────────────────────────────────────────────────
# 五、评估-优化：模型决定什么时候停
# ─────────────────────────────────────────────────────────────


@dataclass
class Critique:
    score: float
    feedback: str


RefineReason = Literal["target_reached", "no_improvement", "round_limit"]


@dataclass
class RefineResult:
    output: str
    score: float
    rounds: int
    usage: Usage
    # 每轮的分数。它是这个模式唯一能看出"有没有在原地打转"的东西。
    history: list[float]
    reason: RefineReason


async def refine(
    task: str,
    call: Call,
    *,
    critique: Callable[[str, Call], Awaitable[Critique]],
    max_rounds: int = 3,
    target_score: float = 0.8,
    min_gain: float = 0.05,
    system: str | None = None,
) -> RefineResult:
    """评估-优化。自主性最高的非 agent 模式：**模型自己判断够不够好。**

    ★ 这个模式有一个特有的失控方式，而且它不报错：**无限打磨。**

    评估者永远能挑出毛病（"还可以更清晰一点"），于是循环不停，
    而每一轮的实际改进趋近于零。所以必须有两道闸：

        轮数上限 —— 硬闸
        改进检测 —— 软闸，分数不再上升就停

    只有轮数上限是不够的：那样你每次都跑满 max_rounds，白付 80% 的钱。

    ★ 还有一个更隐蔽的问题：**生成者和评估者是同一个模型时，盲点是相关的。**
    它看不见的错误，换个角色也看不见。自我评估会收敛到自我满意，
    而不是收敛到正确。真要靠它把关，评估者得换模型、或者给它一份显式的检查清单。
    """
    res = await call([{"role": "user", "content": task}], system=system)
    usage = Usage().plus(res)
    best = text_of(res)
    best_score = float("-inf")
    history: list[float] = []
    rounds = 0

    for i in range(max_rounds):
        rounds += 1
        c = await critique(best, call)
        history.append(c.score)

        # ★ 保留历史最优，而不是无脑接受最后一版。
        # 打磨会让结果变差——这在实践中比想象的常见，而只留最后一版会把它藏起来。
        gain = c.score - best_score
        if c.score > best_score:
            best_score = c.score

        if c.score >= target_score:
            return RefineResult(best, best_score, rounds, usage, history, "target_reached")
        if i > 0 and gain < min_gain:
            return RefineResult(best, best_score, rounds, usage, history, "no_improvement")
        if i == max_rounds - 1:
            break

        nxt = await call(
            [
                {"role": "user", "content": task},
                {"role": "assistant", "content": best},
                {
                    "role": "user",
                    "content": f"下面是对上面这版的评审意见。按意见改一版。\n\n{c.feedback}",
                },
            ],
            system=system,
        )
        usage = usage.plus(nxt)
        best = text_of(nxt)

    return RefineResult(best, best_score, rounds, usage, history, "round_limit")


# ─────────────────────────────────────────────────────────────
# 选型：把判据写成代码
# ─────────────────────────────────────────────────────────────


@dataclass
class Shape:
    # 步骤能不能事先列出来。
    steps_known: bool
    # 子任务之间有没有依赖。
    independent: bool
    # 需不需要根据中间结果改变路径。
    needs_branching: bool
    # 质量有没有一个可判定的标准。
    has_quality_bar: bool
    # 出错的代价。'high' 意味着不确定性本身就是不可接受的。
    error_cost: Literal["low", "high"]


Pattern = Literal["single", "chain", "route", "parallel", "orchestrate", "refine", "agent"]


@dataclass
class Choice:
    pattern: Pattern
    why: str


def choose_pattern(s: Shape) -> Choice:
    """选型判据。

    ★ 顺序是刻意的：**从最不自主的开始试，够用就停。**

    因为自主性不是免费的功能，是你为"不知道该怎么做"付的钱。
    知道该怎么做还用 agent，等于每次运行都花 token 重新发现一遍自己的流程图。
    """
    if s.steps_known and not s.needs_branching:
        if s.independent:
            return Choice("parallel", "步骤已知且互相独立——并行既最快也最便宜")
        return Choice("chain", "步骤已知且有依赖顺序——链式，每步之间加关口")

    if s.needs_branching and s.steps_known:
        return Choice("route", "路径有限且已知，只是要选一条——路由。用便宜模型做分类")

    if s.error_cost == "high":
        # 这一条要放在 agent 之前。高错误代价下，"能自己想办法"是缺点不是优点。
        return Choice(
            "refine",
            "错误代价高，不能接受不可预测的路径——用评估-优化把不确定性关在一个有界循环里",
        )

    if not s.steps_known and s.independent:
        return Choice("orchestrate", "拆法要模型定，但子任务独立——编排-工作者，计划必须校验")

    if s.has_quality_bar and not s.needs_branching:
        return Choice("refine", "有可判定的质量标准——评估-优化，但记得加改进检测")

    return Choice(
        "agent",
        "步骤事先列不出来、需要根据中间结果改变路径——这才是 agent 真正该出场的地方",
    )
