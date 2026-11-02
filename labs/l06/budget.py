"""L06 任务一：上下文计量与预算分区（Python 版）。

    uv run python -m l06.budget

不调 API。写完后 `uv run python -m l06.verify` 验证。
参考实现在 shared/context_budget.py。

这个任务的价值在于把「感觉快满了」换成一个能看的 breakdown。
后面两个任务都依赖它——不知道该压哪块就是在瞎压。
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

# ─────────────────────────────────────────────────────────────
# TODO 1：token 粗估
#
# 中日韩字符约 0.6 token，其余约 0.25 token。加一个 factor 系数供校准。
#
# ★ 为什么不用 tiktoken：**它算的是 OpenAI 的分词器，而我们用 DeepSeek。**
# 中文上的差异能到 20% 以上。那个误差的坏处不是"不准"，是**它假装准**——
# 你会基于一个精确的错数字做决策，然后在以为还有余量的时候撞上限。
#
# Python 这边这个坑格外容易踩，因为 `pip install tiktoken` 太顺手了，
# 一行就能装上，看起来像个"正确做法"。
#
# 一个带着已知误差的估计，比一个假装精确的错误值有用得多。
# ─────────────────────────────────────────────────────────────

_CJK = re.compile(r"[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]")


def estimate_tokens(text: str, factor: float = 1.0) -> int:
    raise NotImplementedError("TODO: 实现 estimate_tokens")


# ─────────────────────────────────────────────────────────────
# TODO 2：数一条消息的 content
#
# content 可能是 str，也可能是块的 list。要处理的块类型：
#   text           → 数 text 字段
#   tool_use       → 数 name + json.dumps(input)
#   tool_result    → 数 content（它自己也可能是 str 或块 list）
#   image/document → 估不准，给个保守的常数（宁可估高）
#   其他           → **抛异常**
#
# ★ 最常见的 bug 是 `if isinstance(content, str)` 之后就不管别的了。
# 而 tool_use / tool_result 正是 agent 上下文里最大的那两块——
# 漏了它们，你统计的基本上只有纯文本对话，数字系统性偏小。
#
# ★ Python 专属的坑一：`json.dumps` 默认 `ensure_ascii=True`，会把中文
# 变成 \uXXXX。一个汉字从 1 个字符变成 6 个，估算直接废掉。
# 记得传 ensure_ascii=False。TS 的 JSON.stringify 没这个问题。
# 顺手也传上 default=str——工具入参里混进一个非 JSON 类型就会抛异常，
# 而为了数几个 token 把整个任务中断，这个交换比很糟。
#
# ★ Python 专属的坑二（本节最容易踩的一个）：**块不一定是 dict。**
# transcript 里 assistant 那条装的是 SDK 返回的模型对象
# （L05 的 run_agent 把 res.content 原样放回去了），user 那条才是你手写的 dict。
# 同一个 list 里两种形态混着，而 SDK 对象没有 `.get()`。
#
# 只写 `block.get("type")` 的话：单跑这个文件全绿、你自己造的测试数据也全绿，
# 然后一接到真 agent 上就 AttributeError。写个 helper 同时吃两种形态。
# TS 那边不需要这一层，因为 SDK 的块本身就是普通对象。
#
# 未知类型要响一声而不是静默跳过。静默跳过的往往正是最大的那块。
# ─────────────────────────────────────────────────────────────


class UncountedBlockError(Exception):
    def __init__(self, block_type: str) -> None:
        super().__init__(f"没算过的块类型：{block_type}")
        self.block_type = block_type


def count_content(content: Any, factor: float = 1.0) -> int:
    raise NotImplementedError("TODO: 实现 count_content")


# ─────────────────────────────────────────────────────────────
# TODO 3：预算与分区
#
# 五个分区：system / tool_defs / task / summary / work
#
# 两个容易漏的地方：
#
# 一 · **工具定义不在 messages 里，但每一步都要发。** 十个工具的 schema
#      轻松到 2K 以上。忘了算它等于把系统区当成免费的。
#
# 二 · **ratio 要相对"可用输入额度"算，不是相对 window。**
#      128K 是输入加输出的总额。按 window 的 60% 触发压缩，实际允许输入涨到
#      76.8K，然后模型想写一份长报告就被 max_tokens 截断了。
#
# top 是占用最大的分区。「该压哪一块」的答案通常就在这里——
# 八成情况下是 work（工具结果），而那一块该用手段一（源头裁剪）处理，
# 不是拿摘要压缩去治。
# ─────────────────────────────────────────────────────────────

Zone = Literal["system", "tool_defs", "task", "summary", "work"]


@dataclass(frozen=True)
class Budget:
    window: int = 128_000
    reserve_output: int = 16_000
    compress_at: float = 0.6
    compress_to: float = 0.3


DEFAULT_BUDGET = Budget()


def input_budget(b: Budget) -> int:
    raise NotImplementedError("TODO: 实现 input_budget")


@dataclass
class ContextStats:
    tokens: int
    ratio: float
    breakdown: dict[Zone, int]
    top: Zone
    budget: Budget = field(default=DEFAULT_BUDGET)


def measure(
    system: str,
    tools: Sequence[dict[str, Any]],
    messages: Sequence[dict[str, Any]],
    budget: Budget = DEFAULT_BUDGET,
    factor: float = 1.0,
    summary_tokens: int = 0,
) -> ContextStats:
    raise NotImplementedError("TODO: 实现 measure")


# ─────────────────────────────────────────────────────────────
# TODO 4：分页，并且在截断处给出路
#
# ★ 这是这一节最重要的一个函数。
#
# 不给出路的截断会造出死循环：模型需要后面的内容，看到「已截断」
# 但不知道还剩多少、也不知道怎么拿，于是它重试同样的调用，
# 得到同样的截断，再重试。这就是 L05 那道防线要拦的场景，根源在这里。
#
# 三个要素缺一不可：
#   给了什么   第 1-200 行
#   缺了多少   共 1240 行
#   怎么拿     用 offset=200
#
# ★ Python 专属的坑：负数 offset 在切片里有别的含义。
# `lines[-5:]` 不会报错，它会静默返回最后五行——一个错误的 offset
# 变成了一个看起来正常的结果。必须显式夹紧到 >= 0。
#
# 边界：offset 超出范围要说清楚，不要静默返回空字符串。
# ─────────────────────────────────────────────────────────────


def paginate(
    text: str,
    offset: int = 0,
    limit: int = 200,
    hint: Callable[[int], str] | None = None,
) -> str:
    raise NotImplementedError("TODO: 实现 paginate")


# ─────────────────────────────────────────────────────────────
# TODO 5：校准器
#
# 估算值用来做决策（决策必须在调用**之前**做），
# 服务端返回的真实 usage 用来修正系数。
#
# factor 的含义：真实 token ≈ 估算 token × factor。
# 只保留最近的样本——模型和内容分布都会变，老样本会拖累系数。
# ─────────────────────────────────────────────────────────────


class Calibrator:
    MAX_SAMPLES = 20

    def __init__(self) -> None:
        raise NotImplementedError("TODO: 实现 Calibrator")

    @property
    def count(self) -> int:
        raise NotImplementedError("TODO: 实现 count")

    @property
    def factor(self) -> float:
        raise NotImplementedError("TODO: 实现 factor")

    @property
    def drift(self) -> float:
        raise NotImplementedError("TODO: 实现 drift")

    def record(self, estimated: int, actual_input_tokens: int) -> None:
        raise NotImplementedError("TODO: 实现 record")


# ─────────────────────────────────────────────────────────────
# 观察实验
# ─────────────────────────────────────────────────────────────

TOOLS: list[dict[str, Any]] = [
    {
        "name": "read_file",
        "description": (
            "读取一个文件的内容。路径必须在项目根目录内。返回前 200 行，要看后面用 offset 参数。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "相对项目根目录的路径"},
                "offset": {"type": "integer", "description": "从第几行开始，默认 0"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "list_dir",
        "description": "列出一个目录下的文件和子目录。会自动折叠 node_modules、dist、.git。",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "search_code",
        "description": "在代码里搜关键词。返回「文件:行号 + 一行上下文」，最多 30 条。",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "glob": {"type": "string"}},
            "required": ["query"],
        },
    },
]

SYSTEM = """你是一个代码库分析助手。

<workflow>
1. 先用 list_dir 摸清结构
2. 用 search_code 定位关键位置
3. 用 read_file 读具体实现
4. 每读完一个模块，把结论写下来
</workflow>

<rules>
- 不确定的事去查，不要猜
- 引用代码时带上文件路径和行号
- 一次只做一件事
</rules>"""


def fake_history(steps: int) -> list[dict[str, Any]]:
    """造一段假的 agent 历史，用来观察分区占比怎么演化。"""
    task = "读懂 src/auth 这个模块，告诉我登录流程是怎么走的，有没有安全问题。"
    msgs: list[dict[str, Any]] = [{"role": "user", "content": task}]
    for i in range(steps):
        tid = f"tu_{i}"
        msgs.append(
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": f"我先看看第 {i + 1} 个文件。"},
                    {
                        "type": "tool_use",
                        "id": tid,
                        "name": "read_file",
                        "input": {"path": f"src/auth/module{i}.py"},
                    },
                ],
            }
        )
        msgs.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": tid,
                        "content": "def handler():\n    # 实现细节\n    pass\n" * 120,
                    }
                ],
            }
        )
    return msgs


def demo_breakdown() -> None:
    print("\n【一】分区占比怎么演化")
    print("同一个 agent，跑不同步数。看 work 那一列。\n")

    for steps in (0, 2, 5, 10, 20):
        s = measure(SYSTEM, TOOLS, fake_history(steps))
        b = s.breakdown
        print(
            f"  {steps:>2} 步 · 共 {s.tokens:>6} tok "
            f"({round(s.ratio * 100):>3}%) · "
            f"system {b['system']} · tools {b['tool_defs']} · task {b['task']} · "
            f"work {b['work']:>6} · 最大分区 {s.top}"
        )

    print("\n  system / tools / task 三块是常数，work 单调增长。")
    print("  到 20 步时 work 占了九成以上——**这就是该动手的地方**。")
    print("  拿摘要压缩去治它是用错药了：源头裁剪（分页、只返回骨架）成本为零。")


def demo_reserve() -> None:
    print("\n【二】留白为什么不能省")
    print("同样的上下文，两种预算算法。\n")

    messages = fake_history(12)
    from dataclasses import replace

    naive = replace(DEFAULT_BUDGET, reserve_output=0)

    for label, b in (("按总窗口算（错）", naive), ("减掉留白后算（对）", DEFAULT_BUDGET)):
        s = measure(SYSTEM, TOOLS, messages, b)
        trigger = "已触发压缩" if s.ratio > b.compress_at else "还没触发"
        print(
            f"  {label:<18} 可用额度 {input_budget(b)} · "
            f"占比 {round(s.ratio * 100)}% · {trigger}"
        )

    print("\n  同样的内容，一个说「还早」，一个说「该压了」。差别只在分母。")
    print("  按总窗口算的那个，会允许输入一直涨到模型没法写长回答为止。")


def demo_paginate() -> None:
    print("\n【三】截断给不给出路，差别有多大")

    file = "\n".join(f"line {i + 1}: some code here" for i in range(1240))

    print("\n  坏的截断（模型只能重试）：")
    print("    " + file[:60] + " ...")
    print("    [内容过长，已截断]")

    print("\n  好的截断（模型知道下一步）：")
    for line in paginate(file, offset=0, limit=3).split("\n"):
        print("    " + line)

    print("\n  接着读下一段：")
    for line in paginate(file, offset=1237, limit=5).split("\n"):
        print("    " + line)

    print("\n  三个要素：给了什么、缺了多少、怎么拿。缺一个模型就会打转。")


def demo_calibrate() -> None:
    print("\n【四】用真实 usage 校准估算")
    print("假设我们的估算系统性偏低 18%（这是 tiktoken 用错模型的典型量级）。\n")

    cal = Calibrator()
    for est, real in ((1200, 1420), (3400, 4010), (8800, 10380), (15000, 17700)):
        cal.record(est, real)
        print(
            f"  估 {est:>6} · 实际 {real:>6} · "
            f"factor={cal.factor:.3f} · 偏差 {cal.drift * 100:.1f}%"
        )

    text = "把这段中文和 some English mixed together 一起数。"
    print(f"\n  校准前 {estimate_tokens(text)} tok，校准后 {estimate_tokens(text, cal.factor)} tok")
    print("\n  偏差超过 15% 就该去看估算函数本身要不要改了。")
    print("  重点不是把误差消掉，是**知道误差有多大**——留白就是为这个准备的。")


# ─────────────────────────────────────────────────────────────
# TODO 6：改一个数，看结论怎么变
#
# 把 TOOLS 从 3 个复制成 12 个（改改名字就行），重新跑【一】。
# tool_defs 那一列变成多少？占总量的比例是多少？
#
# 然后回答：什么时候「工具太多」会从成本问题变成正确性问题？
# （提示：L05x 讲过注意力零和）
# ─────────────────────────────────────────────────────────────


def main() -> None:
    print("把上下文变成一个能看的东西。不调 API。")
    demo_breakdown()
    demo_reserve()
    demo_paginate()
    demo_calibrate()
    print("\n" + "─" * 60)
    print("有了 breakdown，下一个任务才能判断该压什么。")
    print("别忘了 TODO 6。")


if __name__ == "__main__":
    main()
