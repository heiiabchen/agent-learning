"""L11 任务一：多 agent 的四道闸和一台计价器（Python 通道）。

    cd labs && uv run python -m l11.orchestrate
    cd labs && uv run python -m l11.verify

对照 l11/orchestrate.ts。TODO 的编号一一对应。

★ 这一节的 TODO 分布和前面几节不一样。八个里面有五个是**校验和拦截**，
只有三个算得上"编排"。这个比例就是这一节的主要结论：多 agent 的技术实现
是简单的（嵌套调用 run_agent 就完了），难的全在"什么时候不该这么做"上。

Python 这一版比 TS 多两个坑，都在 TODO 7 里，都不响：

  · asyncio.gather(return_exceptions=True) 返回的是"值或异常对象"混在
    一起的列表。漏掉 isinstance 判断，后面就在拿异常当报告用。
  · asyncio.CancelledError 在 3.8+ **不是 Exception 的子类**。
    把取消当成崩溃处理的话，整批会继续跑完——取消就失效了。
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import Callable
from typing import Any, Literal

from shared import multi as shared
from shared.ledger import Totals
from shared.multi import (
    Brief,
    BriefCheck,
    Effort,
    FanoutOptions,
    FanoutResult,
    HandoffResult,
    Merged,
    Overlap,
    Report,
    TopologyChoice,
    WriteConflict,
)

IMPL = "shared" if os.environ.get("MULTI_IMPL") == "shared" else "mine"


# ─────────────────────────────────────────────────────────────
# TODO 1：任务书体检
#
# sub-agent 唯一能看到的东西就是这份任务书。编排者知道的一切，
# 它一个字都看不到。
#
# 要查六件事，第一件最重要：
#
#   dangling_reference —— 出现"上面提到的""那个文件"这类指代。
#                         ★ 它在编排者的上下文里有明确所指，在 sub-agent
#                         那里是**一个空引用**。而 sub-agent 不会报错，
#                         它会编一个出来，基于编出来的东西干完整个任务。
#   no_context / no_deliverable / no_boundaries / no_tools / goal_too_vague
#
# 返回 problems 列表而不是抛异常：一份任务书可能有多处问题，
# 一次全报出来比修一个跑一次快得多。
#
# 词表见 shared/multi.py 的 DANGLING / VAGUE_GOALS。
# ─────────────────────────────────────────────────────────────


def check_brief(b: Brief) -> BriefCheck:
    raise NotImplementedError("TODO: 实现 check_brief")


# ─────────────────────────────────────────────────────────────
# TODO 2：重复劳动检测
#
# ★ 必须在**派发之前**做：sub-agent 之间不共享上下文，
# 所以它们**没有任何办法发现自己在做重复的活**。
#
# Anthropic 生产里的真实故障：三个 sub-agent 被派去"研究半导体短缺"，
# 一个查了 2021 年的汽车芯片危机，另外两个查了同一件事。
# 症状只有一个：这次特别贵。
#
# 两个实现细节：
#   · 中文长词要切二元组，"供应链危机"和"供应链短缺"才能对上
#   · 分母用**较短那份**的关键词数，不是并集。窄任务被宽任务整个包含时，
#     并集会把分数摊薄——而那恰恰是最该报出来的形状
# ─────────────────────────────────────────────────────────────


def detect_overlap(briefs: list[Brief], threshold: float = 0.5) -> list[Overlap]:
    raise NotImplementedError("TODO: 实现 detect_overlap")


# ─────────────────────────────────────────────────────────────
# TODO 3：写冲突检测
#
# ★ 全节最有用的一条经验判据：**并行 sub-agent 必须是只读的。**
#
# 理由不是"并发难写对"，是更根本的：sub-agent 之间没有共享状态，
# 所以它们**看不到彼此的写入**。两个 agent 同时改同一个文件，
# 后写的覆盖先写的，而且**两边都认为自己成功了**——
# 它们的报告都会说"已完成"。
#
# 做法：找出带写工具的任务书，按提到的路径分组，同一路径下多于一个就是冲突。
# 粒度会偏粗，而**这个方向的不准是安全的**——
# 误报让你多看一眼，漏报让你丢数据。
# ─────────────────────────────────────────────────────────────


def check_write_conflicts(
    briefs: list[Brief], write_tools: list[str] | None = None
) -> list[WriteConflict]:
    raise NotImplementedError("TODO: 实现 check_write_conflicts")


# ─────────────────────────────────────────────────────────────
# TODO 4：投入分级
#
# ★ 这套规则是 Anthropic 写进 prompt 里的——因为**模型自己判断不了
# 该投入多少**。他们早期版本的真实故障是：一个简单查询开了 50 个 sub-agent。
#
# 所以这件事不能交给模型。它是代码。
#
# 判据顺序（从最能省事的开始）：
#   needs_write            → single（写不能并行，这条优先级最高）
#   independent_threads<=1 → single
#   <=4 且塞得下           → small_fanout
#   否则                   → large_fanout（上限 10）
# ─────────────────────────────────────────────────────────────


def plan_effort(
    *, independent_threads: int, needs_write: bool, exceeds_context: bool
) -> Effort:
    raise NotImplementedError("TODO: 实现 plan_effort")


# ─────────────────────────────────────────────────────────────
# TODO 5：合并报告
#
# ★ 这个函数最重要的行为是它**不做**的事：**它不在矛盾的结论里挑一个。**
#
# 编排者只看到摘要，看不到任何一份原始材料——它没有能力判断哪一份对。
# 让它"综合一下"的结果是一段读起来很顺、把两个矛盾结论糊在一起的文字，
# 而这是多 agent 里最难发现的错误，因为输出**看起来质量很高**。
#
# 三件事：
#   conflicts —— 同一个键、不同的值。原样列出，不合并
#   gaps      —— 失败的、以及 reason 不是 done 的。
#                ★ step_limit 的报告不能当成"做完了"（L05 那条判据）
#   evidence  —— 引用的并集，去重
# ─────────────────────────────────────────────────────────────


def merge_reports(reports: list[Report]) -> Merged:
    raise NotImplementedError("TODO: 实现 merge_reports")


# ─────────────────────────────────────────────────────────────
# TODO 6：拓扑选型
#
# 和 L07 的 choose_pattern、L09 的 choose_retrieval、L10 的"该不该上 MCP"
# 同一类判据。顺序上它在 L07 之后：先定要不要 agent，再定要不要多个。
#
# 判据顺序（每条都要返回 why，理由和前几节一样：判据要能被 review）：
#   有依赖且多线程   → workflow（依赖写在代码里，不该让模型运行时协调）
#   要写             → single
#   单线程但要换专长 → handoff
#   单线程           → single
#   价值低且塞得下   → single（15 倍成本没东西抵）
#   否则             → multi_agent
# ─────────────────────────────────────────────────────────────


def choose_topology(
    *,
    independent_threads: int,
    needs_write: bool,
    exceeds_context: bool,
    has_dependencies: bool,
    value_per_task: Literal["low", "high"],
    needs_specialist_switch: bool,
) -> TopologyChoice:
    raise NotImplementedError("TODO: 实现 choose_topology")


# ─────────────────────────────────────────────────────────────
# TODO 7：派发（四道闸）
#
# ★ 派发**之前**先体检，而且体检结果要返回给调用方，不是打个日志。
# 重复劳动和写冲突一旦派出去就无法挽回——钱已经花了、文件已经被覆盖了。
# 而它们在派发前是**完全可以静态查出来的**。
#
# 四道闸：
#   1. 深度 —— depth >= max_depth 就全部拒掉。没这道闸，sub-agent 开
#              sub-agent 是指数级的账单
#   2. 数量 —— 超过 max_agents 的截断，但**被截掉的要显式列进 rejected**。
#              静默截断的后果是"结论少了一条"，而那看起来像模型没找到
#   3. 预算 —— ★ 要在**批之间**检查。一个失控的 sub-agent 能把整个预算吃掉
#   4. 隔离 —— 一个 sub-agent 崩了不该让整批白跑，但它必须变成一条 gap
#
# ★ Python 特有的两个坑都在第 4 道闸里：
#
#   asyncio.gather(..., return_exceptions=True) 返回的是"值或异常对象"
#   混在一起的列表。它**不等于** Promise.allSettled——没有 status 字段，
#   你得自己 isinstance。漏掉一次，后面就在拿异常当报告用，
#   而 Report 的字段访问会抛一个和真正原因毫无关系的 AttributeError。
#
#   asyncio.CancelledError 在 3.8+ **不是 Exception 的子类**，
#   它继承 BaseException。所以：
#     · except Exception       抓不到它（这是对的）
#     · isinstance(x, Exception) 也判不出它（这就要出事了）
#   而**取消必须往上抛**。把取消当成"这个 sub-agent 崩了"来处理的话，
#   整批会继续跑完——用户点了取消，钱照花。
# ─────────────────────────────────────────────────────────────


async def fanout(
    briefs: list[Brief],
    run: Callable[[Brief], Any],
    opts: FanoutOptions,
) -> FanoutResult:
    raise NotImplementedError("TODO: 实现 fanout")


# ─────────────────────────────────────────────────────────────
# TODO 8：交接
#
# ★ 交接和 sub-agent 的区别不是"实现方式"，是**信息模型**：
#
#   sub-agent  上下文隔离。背景要序列化进任务书，结果要序列化成报告。
#              贵、有损、**可并行**。
#   交接        上下文共享。接手的 agent 看得到全部历史。
#              便宜、无损、**只能串行**。
#
# 判据很干脆：**要并行就 sub-agent，不要并行就交接。**
# 用 sub-agent 做串行的事，等于白付两次序列化的钱和一次信息损失。
#
# 实现上只有一个坑：**环检测**。两个 agent 互相交接是真实故障模式，
# 而它的表现是"请求一直不返回"——没有异常、没有错误日志。
# ─────────────────────────────────────────────────────────────


def handoff(
    start: str,
    route: Callable[[str], dict[str, str] | None],
    max_hops: int = 8,
) -> HandoffResult:
    raise NotImplementedError("TODO: 实现 handoff")


# ─────────────────────────────────────────────────────────────
# TODO 9（没有代码）：把 fanout 里的预算检查从"批之间"挪到"开头一次"
#
# 然后跑 uv run python -m l11.verify。只有一条测试会红。
# 看一眼那条测试测的是什么——它测的是**第三个 sub-agent 有没有被拦住**，
# 而在真实系统里那一条是"这次跑掉了预算的三倍"。
#
# TODO 10（没有代码）：把 fanout 里的 CancelledError 分支删掉，
# 让它走 isinstance(res, BaseException) 那条
#
# 所有测试仍然会过，除了专门测取消的那一条。
# 而这就是 Python 这个坑的全部形状：**删掉之后代码更短、看起来更干净，
# 而取消功能坏了。** 用户点了取消，剩下的 sub-agent 照跑，钱照花。
# ─────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────
# 观察实验
# ─────────────────────────────────────────────────────────────

_M: Any = shared if IMPL == "shared" else sys.modules[__name__]


def _line(n: int = 62) -> str:
    return "─" * n


CHIP_BRIEFS = [
    Brief(agent="researcher-1", goal="研究半导体短缺", context="", deliverable=""),
    Brief(agent="researcher-2", goal="研究半导体供应链现状", context="", deliverable=""),
    Brief(agent="researcher-3", goal="调查半导体供应链短缺的现状", context="", deliverable=""),
]

_SHARED_CONTEXT = (
    "我们在写一份半导体供应链的行业报告，读者是不熟悉半导体行业的投资人。"
    "报告分三部分：历史危机、当前产能、地缘风险。"
)

CHIP_FIXED = [
    Brief(
        agent="researcher-1",
        goal="梳理 2020-2022 年汽车芯片危机的成因与时间线",
        context=_SHARED_CONTEXT + "你负责第一部分。",
        deliverable="一份时间线，每个节点标注日期、事件、对整车厂产能的影响",
        boundaries=[
            "不要涉及 2023 年之后的情况",
            "不要分析地缘政治，那是 researcher-3 的部分",
        ],
        tools=["web_search", "read_url"],
    ),
    Brief(
        agent="researcher-2",
        goal="统计 2026 年主要晶圆厂的产能与在建产线",
        context=_SHARED_CONTEXT + "你负责第二部分。",
        deliverable="一张表：厂商、地区、制程节点、月产能、在建产线的投产时间",
        boundaries=[
            "不要回顾历史危机，那是 researcher-1 的部分",
            "只要产能数字，不要分析原因",
        ],
        tools=["web_search", "read_url"],
    ),
    Brief(
        agent="researcher-3",
        goal="梳理影响半导体供应的出口管制与地缘风险",
        context=_SHARED_CONTEXT + "你负责第三部分。",
        deliverable="按国家/地区分组的风险清单，每条标注生效时间和受影响的环节",
        boundaries=["不要复述产能数字，那是 researcher-2 的部分"],
        tools=["web_search", "read_url"],
    ),
]


def demo_brief() -> None:
    print(f"\n【一】任务书：sub-agent 唯一能看到的东西\n{_line()}")

    bad = Brief(
        agent="worker", goal="分析",
        context="按上面提到的那个文件里的规则来做", deliverable="",
    )
    r = _M.check_brief(bad)
    print(f"  一份典型的坏任务书，查出 {len(r.problems)} 个问题：")
    for p in r.problems:
        print(f"\n    \033[31m[{p.kind}]\033[0m {p.message}")

    good = _M.check_brief(CHIP_FIXED[0])
    verdict = "\033[32m通过\033[0m" if good.ok else f"{len(good.problems)} 个问题"
    print(f"\n  写清楚之后：{verdict}")

    print("\n  ★ 六条里 dangling_reference 是最要紧的那条。")
    print("  「上面提到的那个文件」在编排者的上下文里有明确所指，")
    print("  在 sub-agent 那里是**一个空引用**——而它不会报错。")
    print("  它会编一个所指出来，然后基于编出来的东西干完整个任务，")
    print("  最后交回一份格式正确、语气自信、内容和你要的毫无关系的报告。")


def demo_overlap() -> None:
    print(f"\n【二】重复劳动：多 agent 最贵的失效\n{_line()}")

    print("  三个 agent，任务书都是「研究半导体短缺」的换词版本：")
    for b in CHIP_BRIEFS:
        print(f"    {b.agent}：{b.goal}")

    overlaps = _M.detect_overlap(CHIP_BRIEFS)
    print(f"\n  查出 {len(overlaps)} 组重叠：")
    for o in overlaps:
        print(
            f"    \033[31m{o.a} × {o.b}\033[0m  重叠 {o.score * 100:.0f}%"
            f"  共同关键词 {'、'.join(o.shared)}"
        )

    print(f"\n  加上边界和具体目标之后：{len(_M.detect_overlap(CHIP_FIXED))} 组重叠")

    print("\n  ★ 这是 Anthropic 生产里的真实故障：一个 agent 查了 2021 年的")
    print("  汽车芯片危机，另外两个查了同一件事——2025 年的供应链。")
    print("\n  而这件事**必须在派发之前查**。sub-agent 之间不共享上下文，")
    print("  所以它们没有任何办法发现自己在做重复的活。")
    print("  你会付三份钱、拿到三份内容雷同的报告，唯一的症状是「这次特别贵」。")


def demo_write_conflict() -> None:
    print(f"\n【三】并行 sub-agent 必须是只读的\n{_line()}")

    writers = [
        Brief(
            agent="refactor-a",
            goal="把 src/api.py 里的回调改成 async/await",
            context="在做一次代码现代化改造",
            deliverable="改好的 src/api.py",
            boundaries=["只改这一个文件"],
            tools=["read_file", "edit_file"],
        ),
        Brief(
            agent="refactor-b",
            goal="给 src/api.py 里的公开函数补类型标注",
            context="在做一次代码现代化改造",
            deliverable="改好的 src/api.py",
            boundaries=["只改这一个文件"],
            tools=["read_file", "edit_file"],
        ),
    ]

    print("  两个 agent，各自的任务书写得都很规范：")
    for b in writers:
        print(f"    {b.agent}：{b.goal}")
    print("  两份任务书都通过了 check_brief（边界写了、工具限了、目标具体）。")

    conflicts = _M.check_write_conflicts(writers)
    print(f"\n  但写冲突检查查出 {len(conflicts)} 处：")
    for c in conflicts:
        print(f"    \033[31m{c.resource}\033[0m ← {'、'.join(c.agents)} 都要写")

    print("\n  ★ 后写的覆盖先写的，而且**两边都认为自己成功了**——")
    print("  两份报告都会说「已完成」。编排者拿到两个成功，")
    print("  合并出一句「重构完成，类型已补齐」，而实际上类型没了。")
    print("\n  原因不是并发难写对，是更根本的：**sub-agent 看不到彼此的写入。**")
    print("\n  Anthropic 的原话值得抄下来：「大多数编程任务里真正可并行的")
    print("  部分比研究少得多。」——而这门课的 capstone 就是一个编程 agent。")


def demo_effort() -> None:
    print(f"\n【四】投入分级：别为一个简单问题开十个 agent\n{_line()}")

    def kw(threads: int, write: bool, big: bool) -> dict[str, Any]:
        return dict(independent_threads=threads, needs_write=write, exceeds_context=big)

    cases = [
        ("查一个函数在哪定义", kw(1, False, False)),
        ("对比三个库的 API 设计", kw(3, False, False)),
        ("把这个函数改成异步", kw(1, True, False)),
        ("重构八个模块（都要改文件）", kw(8, True, False)),
        ("整理 S&P500 里 IT 公司的董事会", kw(12, False, True)),
    ]

    for name, args in cases:
        e = _M.plan_effort(**args)
        color = "\033[33m" if e.tier == "single" else "\033[32m"
        print(f"  {name:<24} {color}{e.tier:<14}\033[0m {e.agents:>3}   {e.why}")

    print("\n  ★ 注意第四行：八个模块听起来很适合并行，但它要写文件，")
    print("  所以档位是 single。**「能拆」和「能并行」是两件事。**")
    print("\n  这套规则要写成代码而不是写进 prompt，因为模型判断不了该投入多少。")
    print("  Anthropic 早期版本的真实故障：一个简单查询开了 50 个 sub-agent。")


def demo_merge() -> None:
    print(f"\n【五】合并：编排者没有能力判断哪一份对\n{_line()}")

    def t(yuan: float) -> Totals:
        return Totals(
            calls=3, input_tokens=12000, output_tokens=800,
            cache_read=0, cache_write=0, ms=4200, yuan=yuan,
        )

    reports = [
        Report(
            agent="researcher-1", ok=True,
            summary="2021 年危机峰值：整车厂减产约 1050 万辆\n主要成因：疫情期间的订单取消",
            evidence=["artifact://researcher-1/timeline.md"],
            usage=t(0.0182), steps=6, reason="done",
        ),
        Report(
            agent="researcher-2", ok=True,
            summary="2021 年危机峰值：整车厂减产约 770 万辆\n台积电月产能：约 130 万片等效 12 吋",
            evidence=["artifact://researcher-2/capacity.csv"],
            usage=t(0.0214), steps=7, reason="done",
        ),
        Report(
            agent="researcher-3", ok=True,
            summary="出口管制清单：2022-10 起扩大到先进制程设备",
            evidence=["artifact://researcher-3/risks.md"],
            usage=t(0.0091), steps=4, reason="step_limit",
        ),
        Report(
            agent="researcher-4", ok=False, summary="", evidence=[],
            usage=t(0), steps=0, reason="子进程超时",
        ),
    ]

    m = _M.merge_reports(reports)

    print("  四份报告进来，合并结果：")
    print(f"\n  \033[31m矛盾 {len(m.conflicts)} 处：\033[0m")
    for c in m.conflicts:
        print(f"    {c['claim']}   ← {' vs '.join(c['agents'])}")

    print(f"\n  \033[33m缺口 {len(m.gaps)} 处：\033[0m")
    for g in m.gaps:
        print(f"    {g['agent']}：{g['reason']}")

    print(f"\n  证据 {len(m.evidence)} 条：{'、'.join(m.evidence)}")

    print("\n  ★ 这个函数最重要的行为是它**不做**的事：它不在 1050 万和 770 万")
    print("  之间挑一个。编排者只看到摘要，看不到任何一份原始材料——")
    print("  **它没有能力判断哪个对。**")
    print("\n  让它「综合一下」的结果是「减产约 800 至 1000 万辆」这种句子：")
    print("  读起来很顺、有具体数字、而且两个来源都不支持它。")
    print("\n  这是多 agent 里最难发现的错误，因为输出**看起来质量很高**。")
    print("\n  另外注意 researcher-3：它 ok=True，但 reason 是 step_limit。")
    print("  L05 那条判据在这里第二次用上：**被掐断的运行不是做完了的运行。**")
    print("  它进 gaps，不进结论。")


async def main() -> None:
    print(f"\n{'═' * 62}")
    print(f"L11 · 多 agent 的四道闸（实现：{IMPL}）")
    print("═" * 62)

    for n, fn in [("一", demo_brief), ("二", demo_overlap), ("三", demo_write_conflict),
                  ("四", demo_effort), ("五", demo_merge)]:
        try:
            fn()
        except NotImplementedError as err:
            print(f"\n【{n}】\033[31m还没实现：{err}\033[0m")

    print(f"\n{_line()}")
    print("接着跑 uv run python -m l11.compare —— 看 15 倍是怎么来的。")


if __name__ == "__main__":
    asyncio.run(main())
