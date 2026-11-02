"""L07 任务一：五种编排模式（Python 版）。

    uv run python -m l07.patterns

不调 API——用的是假模型。参考实现在 shared/patterns.py。

这五个函数看起来差别很大，但它们只在回答同一个问题：**谁决定下一步。**
写的时候留意这条轴，你会发现代码结构在跟着自主性一起变复杂。
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, TypeVar

# ─────────────────────────────────────────────────────────────
# 基础类型（已给）
# ─────────────────────────────────────────────────────────────


class Call(Protocol):
    async def __call__(
        self,
        messages: list[dict[str, Any]],
        *,
        system: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> Any: ...


def field_of(obj: Any, name: str) -> Any:
    """dict 和 SDK 对象混着来，取字段要两条路都走通（和 L06 那个 field_of 同源）。"""
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


@dataclass(frozen=True)
class Usage:
    input: int = 0
    output: int = 0
    calls: int = 0

    def plus(self, res: Any) -> Usage:
        """★ 返回新对象而不是原地改。原地改在 gather 并发下是 race。"""
        u = field_of(res, "usage")
        return Usage(
            input=self.input + int(field_of(u, "input_tokens") or 0),
            output=self.output + int(field_of(u, "output_tokens") or 0),
            calls=self.calls + 1,
        )


def text_of(res: Any) -> str:
    parts: list[str] = []
    for block in field_of(res, "content") or []:
        if field_of(block, "type") == "text":
            parts.append(str(field_of(block, "text") or ""))
    return "".join(parts)


# ─────────────────────────────────────────────────────────────
# TODO 1：链式
#
# 依次跑每一步，上一步的输出是下一步的输入。
#
# ★ 必须实现「关口」：每步之后可以判断要不要继续。
#
# 没有关口的链会把垃圾一路传到底，然后你在最后一步看到一个荒谬的结果，
# 得回头一步步查是哪里坏的。有关口的链在坏掉的那一步就停，而且报出步名。
#
# ★ 中止时要 return 而不是 raise。上游需要知道「走到哪一步停的」和
# 「已经产出了什么」——塞进异常里会被 traceback 淹掉。
#
# 空链要抛异常，不能静默返回输入（那通常是配置读错了）。
#
# Python 特有的坑：gate 返回 False 时，`if not verdict` 和 `if verdict is not True`
# 不等价——空字符串 "" 也是 falsy。用 `is not True` 更准确。
# ─────────────────────────────────────────────────────────────


@dataclass
class ChainStep:
    name: str
    prompt: Callable[[str], str]
    system: str | None = None
    gate: Callable[[str], bool | str] | None = None


@dataclass
class ChainResult:
    output: str
    usage: Usage
    path: list[str] = field(default_factory=list)
    stopped_at: str | None = None
    gate_message: str | None = None


async def chain(input_text: str, steps: Sequence[ChainStep], call: Call) -> ChainResult:
    raise NotImplementedError("TODO: 实现 chain")


# ─────────────────────────────────────────────────────────────
# TODO 2：路由
#
# 先让模型分类，再把请求交给对应的处理函数。
#
# 实践中投入产出比最高的一个模式——它让你用便宜模型接住八成流量，
# 而这八成本来在付强模型的钱。
#
# ★ 两个必须做的事：
#
# 一 · **不能相信模型给的标签。** 它会输出 "billing "（带空格）、"Billing"、
#      "billing/技术支持"、或者一整句解释。必须在枚举里查，查不到走兜底。
#
# 二 · **兜底不能是"随便挑一个"。** 分类不确定意味着这条输入是边缘情况，
#      而边缘情况恰恰最需要强能力。所以兜底应该指向**能力最强**的那条。
#      这一条和直觉相反，但线上事故都长这样。
#
# 分类那次调用记得 temperature=0 和一个很小的 max_tokens。
# fell_back 要返回出去——它是"分类器该不该重训"的唯一信号。
# ─────────────────────────────────────────────────────────────


@dataclass
class Route:
    id: str
    when: str
    handle: Callable[[str, Call], Awaitable[str]]


@dataclass
class RouteResult:
    picked: str
    output: str
    usage: Usage
    raw: str
    fell_back: bool


async def route(
    input_text: str,
    routes: Sequence[Route],
    call: Call,
    *,
    fallback: str,
    classifier_system: str | None = None,
) -> RouteResult:
    raise NotImplementedError("TODO: 实现 route")


# ─────────────────────────────────────────────────────────────
# TODO 3：并行 + 投票
#
# 两种用法差别很大，别混：
#   分片 —— 把一件事拆成互不相干的几块，各做一块，最后拼起来
#   投票 —— 同一件事做 N 次，取多数
#
# ★ Python 这里有一个 TS 没有的坑：
#
# asyncio.gather 默认会在第一个异常处抛出，而**其余任务还在后台跑**——
# 也就是说你既没拿到结果，又照样付了钱。必须传 return_exceptions=True。
# 这和 TS 里 Promise.all vs allSettled 是同一件事，但后果更隐蔽。
#
# 并发上限用 asyncio.Semaphore。
#
# ★ vote 要返回 confidence 而不只是 winner。
# 3:2 和 5:0 是完全不同的结论，只返回 winner 会把这个差别抹掉。
#
# 还有一条必须理解的前提：**投票只在错误互相独立时有效。**
# temperature=0 跑 5 次，5 个输出高度一致——包括错的时候也一致。
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
    raise NotImplementedError("TODO: 实现 gather_pooled")


async def parallel(
    prompts: Sequence[str],
    call: Call,
    *,
    concurrency: int = 4,
    system: str | None = None,
    temperature: float | None = None,
) -> ParallelResult:
    raise NotImplementedError("TODO: 实现 parallel")


@dataclass
class VoteResult:
    winner: Any | None
    tally: list[tuple[Any, int]]
    confidence: float


def vote(values: Sequence[Any], key: Callable[[Any], str] | None = None) -> VoteResult:
    raise NotImplementedError("TODO: 实现 vote")


# ─────────────────────────────────────────────────────────────
# TODO 4：编排-工作者
#
# 让模型把任务拆成子任务，并行执行，再整合。
#
# 和并行的区别只有一处，但很关键：**拆法是模型定的。**
# 这一处差别把成本从"可预测"变成"不可预测"——模型可能拆成 3 个，
# 也可能拆成 40 个。所以计划必须校验。
#
# ★ 三条校验缺一不可：
#   非空   —— 空计划要抛错，不能静默降级成"直接做整个任务"
#   有上限 —— 40 个子任务意味着 40 次调用，这是账单事故
#   去重   —— 模型很爱把同一件事换个说法列两遍
#
# 第一条尤其重要：静默降级会把一次编排失败伪装成正常运行，
# 你在监控里看不到，只看到质量莫名变差。
#
# 解析每行时记得剥掉模型爱加的编号和符号（`1.` `-` `*` `·` `、`）。
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


async def orchestrate(
    task: str,
    call: Call,
    *,
    worker: Callable[[str, Call], Awaitable[str]],
    max_subtasks: int = 8,
    concurrency: int = 4,
    system: str | None = None,
) -> OrchestrateResult:
    raise NotImplementedError("TODO: 实现 orchestrate")


# ─────────────────────────────────────────────────────────────
# TODO 5：评估-优化
#
# 生成一版，评审，按意见改，直到够好或者停滞。
#
# ★ 这个模式有一个特有的失控方式，而且它不报错：**无限打磨。**
#
# 评估者永远能挑出毛病（"还可以更清晰一点"），于是循环不停，
# 而每一轮的实际改进趋近于零。所以必须有两道闸：
#
#   轮数上限 —— 硬闸
#   改进检测 —— 软闸，分数不再上升就停
#
# 只有轮数上限是不够的：那样你每次都跑满 max_rounds，白付 80% 的钱。
#
# ★ 还要保留历史最优，而不是无脑接受最后一版。
# 打磨会让结果变差——这在实践中比想象的常见，而只留最后一版会把它藏起来。
#
# best_score 初值用 float("-inf")，不要用 0——
# 0 会让第一轮的 0 分被误判成"没有提升"。
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
    raise NotImplementedError("TODO: 实现 refine")


# ─────────────────────────────────────────────────────────────
# TODO 6：把选型判据写成代码
#
# ★ 顺序是刻意的：**从最不自主的开始试，够用就停。**
#
# 因为自主性不是免费的功能，是你为"不知道该怎么做"付的钱。
# 知道该怎么做还用 agent，等于每次运行都花 token 重新发现一遍自己的流程图。
#
# 有一条容易放错位置：error_cost == 'high' 的判断要放在 agent 之前。
# 错误代价高的时候，「能自己想办法」是缺点而不是优点。
# ─────────────────────────────────────────────────────────────


@dataclass
class Shape:
    steps_known: bool
    independent: bool
    needs_branching: bool
    has_quality_bar: bool
    error_cost: Literal["low", "high"]


Pattern = Literal["single", "chain", "route", "parallel", "orchestrate", "refine", "agent"]


@dataclass
class Choice:
    pattern: Pattern
    why: str


def choose_pattern(s: Shape) -> Choice:
    raise NotImplementedError("TODO: 实现 choose_pattern")


# ─────────────────────────────────────────────────────────────
# 观察实验（已给）
# ─────────────────────────────────────────────────────────────

T = TypeVar("T")
_ = re  # 提示：解析计划行时会用到 re


@dataclass
class _Block:
    type: str
    text: str


@dataclass
class _Usage:
    input_tokens: int
    output_tokens: int


@dataclass
class _Res:
    content: list[_Block]
    usage: _Usage


def scripted(reply: Callable[[str], str], inp: int = 200, out: int = 60) -> Call:
    """一个极简假模型：按关键词决定回什么。"""

    async def call(
        messages: list[dict[str, Any]],
        *,
        system: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> Any:
        last = messages[-1]
        content = last["content"]
        text = content if isinstance(content, str) else str(content)
        return _Res(
            content=[_Block("text", reply(text))],
            usage=_Usage(input_tokens=inp, output_tokens=out),
        )

    return call  # type: ignore[return-value]


async def demo_chain() -> None:
    print("\n【一】链式：关口在哪一步拦下来")

    steps = [
        ChainStep(name="提取要点", prompt=lambda s: f"提取要点：{s}"),
        ChainStep(
            name="检查完整性",
            prompt=lambda s: f"检查这份要点有没有遗漏：{s}",
            gate=lambda out: "要点不完整，后面的翻译没有意义" if "不完整" in out else True,
        ),
        ChainStep(name="翻译", prompt=lambda s: f"翻译成英文：{s}"),
    ]

    good = await chain(
        "一份正常的会议记录",
        steps,
        scripted(lambda p: "完整" if p.startswith("检查") else "处理后的内容"),
    )
    print(f"  正常：走完 {len(good.path)} 步（{' → '.join(good.path)}）")

    bad = await chain(
        "一份残缺的会议记录",
        steps,
        scripted(lambda p: "不完整" if p.startswith("检查") else "处理后的内容"),
    )
    print(f"  异常：停在「{bad.stopped_at}」，原因是「{bad.gate_message}」")
    print(f"        只花了 {bad.usage.calls} 次调用，第三步没白跑")

    print("\n  没有关口的话，第二步发现的问题会被第三步无声地吃掉，")
    print("  你最后拿到一份「翻译得很流畅的残缺要点」——而且不知道是哪坏的。")


async def demo_route() -> None:
    print("\n【二】路由：模型给的标签不能直接用")

    async def h_billing(_i: str, _c: Call) -> str:
        return "（便宜模型处理账单）"

    async def h_tech(_i: str, _c: Call) -> str:
        return "（强模型处理技术问题）"

    async def h_general(_i: str, _c: Call) -> str:
        return "（强模型兜底）"

    routes = [
        Route("billing", "账单、付款、退款、发票相关", h_billing),
        Route("tech", "报错、功能不工作、性能问题", h_tech),
        Route("general", "其他一切，以及分不清的情况", h_general),
    ]

    cases = [
        ("干净的标签", "billing"),
        ("带空格和大写", "  Billing "),
        ("包在句子里", "这个应该归到 tech 类"),
        ("自作聪明的解释", "我认为这是一个关于产品定价策略的复杂问题，需要综合判断"),
        ("编了一个不存在的类", "refund"),
    ]

    for label, raw in cases:
        r = await route(
            "我的信用卡被扣了两次", routes, scripted(lambda _p, v=raw: v), fallback="general"
        )
        mark = "兜底" if r.fell_back else "命中"
        print(f"  {label:<14} 模型给「{raw.strip()[:20]}」→ {mark} {r.picked}")

    print("\n  最后两行是重点：模型给的东西不在枚举里时，兜底指向 general（强模型）")
    print("  而不是随便挑一个。分不清的输入恰恰最需要强能力。")


def demo_vote() -> None:
    print("\n【三】投票：温度为 0 的时候它不做任何事")

    for label, xs in [
        ("T=0（输出一致）", ["A", "A", "A", "A", "A"]),
        ("T=1（输出有分歧）", ["A", "B", "A", "A", "C"]),
    ]:
        v = vote(xs)
        dist = " ".join(f"{val}×{n}" for val, n in v.tally)
        print(f"  {label:<18} 胜者 {v.winner} · 置信度 {v.confidence * 100:.0f}% · 分布 {dist}")

    print("\n  上面那行：五次调用得到一个 100% 的置信度，看起来很棒。")
    print("  但它是假的——五次跑的是同一条路径，错的时候也会一致错。")
    print("  **投票只在错误互相独立时有效。** 要么调温度，要么换 prompt，要么换模型。")


async def demo_refine() -> None:
    print("\n【四】评估-优化：停滞检测省下的钱")

    # 分数序列：0.5 → 0.62 → 0.63 → 0.63 ……典型的"打磨到边际为零"
    scores = [0.5, 0.62, 0.63, 0.63, 0.63]

    def make_critique() -> Callable[[str, Call], Awaitable[Critique]]:
        i = 0

        async def critique(_draft: str, _c: Call) -> Critique:
            nonlocal i
            s = scores[min(i, len(scores) - 1)]
            i += 1
            return Critique(score=s, feedback="再清晰一点")

        return critique

    with_gate = await refine(
        "写一段产品说明",
        scripted(lambda _p: "第 N 版内容"),
        critique=make_critique(),
        max_rounds=5,
        target_score=0.9,
        min_gain=0.05,
    )
    no_gate = await refine(
        "写一段产品说明",
        scripted(lambda _p: "第 N 版内容"),
        critique=make_critique(),
        max_rounds=5,
        target_score=0.9,
        min_gain=0,
    )

    print(
        f"  有停滞检测：{with_gate.rounds} 轮 · {with_gate.usage.calls} 次调用 · "
        f"因为「{with_gate.reason}」停"
    )
    print(
        f"  没停滞检测：{no_gate.rounds} 轮 · {no_gate.usage.calls} 次调用 · "
        f"因为「{no_gate.reason}」停"
    )
    print(f"  两者最终分数都是 {with_gate.score:.2f}——多花的钱一分没换到质量。")
    print(f"  分数轨迹：{' → '.join(f'{s:.2f}' for s in no_gate.history)}")

    print("\n  只有轮数上限、没有改进检测的话，你每次都跑满 max_rounds。")
    print("  而 target_score 定得稍微高一点（很常见），就等于每次都跑满。")


def demo_choose() -> None:
    print("\n【五】选型：同一个判据函数跑一遍真实需求")

    cases = [
        ("把周报翻译成英文并润色", Shape(True, False, False, False, "low")),
        ("给 200 条评论各打一个情感标签", Shape(True, True, False, False, "low")),
        ("客服工单分派到三个队列", Shape(True, False, True, False, "low")),
        ("写一份季度竞品分析", Shape(False, True, False, True, "low")),
        ("自动生成并执行数据库迁移", Shape(False, False, True, True, "high")),
        ("修一个你还没定位的 bug", Shape(False, False, True, False, "low")),
    ]

    for need, shape in cases:
        c = choose_pattern(shape)
        print(f"  {need:<24} → {c.pattern:<12} {c.why}")

    print("\n  只有最后一行是 agent。这个比例大致就是实际项目里的比例。")


# ─────────────────────────────────────────────────────────────
# TODO 7：改一个输入，看判据怎么变
#
# 把「自动生成并执行数据库迁移」的 error_cost 从 'high' 改成 'low'，
# 重新跑【五】。结论变成什么了？
#
# 然后回答：为什么 error_cost 的判断要放在 agent 之前而不是之后？
# ─────────────────────────────────────────────────────────────


async def main() -> None:
    print("五种编排模式。不调 API。")
    await demo_chain()
    await demo_route()
    demo_vote()
    await demo_refine()
    demo_choose()
    print("\n" + "─" * 60)
    print("接着跑 uv run python -m l07.compare，量一次 workflow 和 agent 的成本差别。")
    print("别忘了 TODO 7。")


if __name__ == "__main__":
    asyncio.run(main())
