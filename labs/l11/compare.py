"""L11 任务二：15 倍是怎么来的（Python 通道）。

    cd labs && uv run python -m l11.compare

这个不用写，直接跑。一次 API 都不调——全部是账面计算。

★ "多 agent 贵 15 倍"这个结论网上到处都是，但它**没什么用**。
光看这个数字，你会得出"多 agent 的协调开销很大"这个结论——而那是错的。

下面五组实验会把 Anthropic 公布的两个倍数（单 agent 约 4 倍聊天、
多 agent 约 15 倍聊天）**推导出来**，然后回答一个更有用的问题：
那 15 倍里面到底是什么。
"""

from __future__ import annotations

import re

from shared.config import price_of
from shared.multi import (
    CostBreakdown,
    CostShape,
    cost_chat,
    cost_multi,
    cost_single,
    telephone,
)

_CJK = re.compile(r"[\u2e80-\u9fff\uff00-\uffef]")


def _w(s: str) -> int:
    return sum(2 if _CJK.match(c) else 1 for c in s)


def _cn(s: str, n: int) -> str:
    return s + " " * max(0, n - _w(s))


def _r(s: str, n: int) -> str:
    return " " * max(0, n - _w(s)) + s


def _line(n: int = 74) -> str:
    return "─" * n


# toolDefTokens 是 L10 实测（10 个工具约 911 token）；
# brief/report 是本节 CHIP_FIXED 那套任务书的实测量级。
SHAPE = CostShape(
    tool_def_tokens=911, tool_result_tokens=1200, brief_tokens=180, report_tokens=300
)

MODEL = "deepseek-v4-pro"
CHAT = cost_chat(250, 6)


def yuan_of(b: CostBreakdown) -> float:
    return (b.input_tokens / 1e6) * price_of(MODEL).input_miss


def row(label: str, b: CostBreakdown) -> None:
    print(
        f"  {_cn(label, 24)}{_r(f'{b.input_tokens:,}', 11)}"
        f"{_r(f'{b.input_tokens / CHAT.input_tokens:.1f}×', 9)}"
        f"{_r(str(b.calls), 7)}{_r(str(b.agents), 7)}{_r(f'¥{yuan_of(b):.3f}', 10)}"
    )


def demo_calibrate() -> None:
    print(f"\n【一】先把公布的两个倍数推出来\n{_line()}")
    print(f"  分母：一次普通聊天 = {CHAT.input_tokens:,} token")
    print("  （6 轮、每轮 250 token 累积。★ 聊天里没有工具定义也没有工具结果——")
    print("   这正是它便宜的原因，也是为什么它能当分母。）\n")

    print(
        f"  {_cn('拓扑', 24)}{_r('输入 token', 11)}{_r('倍聊天', 9)}"
        f"{_r('调用', 7)}{_r('agent', 7)}{_r('钱', 10)}"
    )
    print(f"  {_line(68)}")

    row("纯聊天", CHAT)
    for s in (3, 5, 7):
        row(f"单 agent {s} 步", cost_single(s, SHAPE))
    for a, s in ((2, 5), (3, 5), (4, 5)):
        row(f"{a} 个 sub-agent × {s} 步", cost_multi(a, s, SHAPE))

    single5 = cost_single(5, SHAPE)
    multi3 = cost_multi(3, 5, SHAPE)

    print("\n  ★ 对上了：")
    print(
        f"    单 agent 跑 5 步            "
        f"{single5.input_tokens / CHAT.input_tokens:.1f}× 聊天   （公布值：约 4×）"
    )
    print(
        f"    3 个 sub-agent 各跑 5 步    "
        f"{multi3.input_tokens / CHAT.input_tokens:.1f}× 聊天   （公布值：约 15×）"
    )
    print("\n  而「5 步」这个数不是我挑出来凑答案的——Anthropic 写进 prompt 的")
    print("  投入分级里，「简单事实查找」就是 1 个 agent、3 到 10 次工具调用。")
    print("\n  ★ 结论：那两个倍数不是他们那套系统的特性，是这个架构的**算术后果**。")
    print("  换句话说，**你自己搭的多 agent 也会是这个倍数。**")


def demo_where_the_money_goes() -> None:
    print(f"\n【二】15 倍里面是什么：多出来的不是开销，是**工作量**\n{_line()}")

    single = cost_single(5, SHAPE)
    multi = cost_multi(3, 5, SHAPE)

    def show(b: CostBreakdown) -> None:
        p = b.parts
        print(f"\n  {b.label}   共 {b.input_tokens:,} token")
        for key, label, note in [
            ("tool_defs", "工具定义    ", "每一轮每个 agent 都要重发"),
            ("growth", "上下文增长  ", "O(n²)，L02 就讲过"),
            ("coordination", "协调开销    ", "任务书 + 报告"),
        ]:
            v = p[key]
            amount = _r(f"{v:,}", 10)
            pct = _r(f"{v / b.input_tokens * 100:.0f}%", 5)
            print(f"    {label}  {amount}  {pct}   {note}")

    show(single)
    show(multi)

    ratio = multi.input_tokens / single.input_tokens
    coord = multi.parts["coordination"] / multi.input_tokens

    print(f"\n  多 agent / 单 agent = {ratio:.2f}×，而扇出宽度是 3。")
    print(f"\n  ★ **这个倍数几乎就是扇出宽度本身。** 协调开销只占 {coord * 100:.0f}%。")
    print("\n  所以「多 agent 的协调开销很大」是个错误诊断。真实情况是：")
    print("  **多 agent 贵，是因为它做了 3 倍的工作，而不是因为协调很贵。**")
    print("\n  这个区别决定了你该怎么优化：")
    print("\n    以为是协调贵  → 去优化任务书格式、压缩报告、改协议")
    print(f"                    （在动 {coord * 100:.0f}% 的部分，天花板就是 {coord * 100:.0f}%）")
    print("    知道是工作量  → 去问「这 3 路探索里有几路是必要的」")
    print("                    （在动 100% 的部分）")
    print("\n  而 Anthropic 那句「token 用量本身解释了 80% 的性能差异」说的就是这件事：")
    print("  **多出来的 token 不是浪费，它就是产品。** 你花钱买的是多探索了三个方向。")
    print("  任务里真有三个独立方向时，这笔钱买到了东西；没有的话，钱照花。")


def demo_same_work() -> None:
    print(f"\n【三】同样的工作量：多 agent 反而便宜，而这是个陷阱\n{_line()}")

    single = cost_single(15, SHAPE)
    multi = cost_multi(3, 5, SHAPE)

    print("  同样 15 步的工具调用总量：")
    s_tok, m_tok = _r(f"{single.input_tokens:,}", 10), _r(f"{multi.input_tokens:,}", 10)
    print(f"\n    单 agent 跑 15 步          {s_tok} token   ¥{yuan_of(single):.3f}")
    print(f"    3 个 sub-agent × 5 步      {m_tok} token   ¥{yuan_of(multi):.3f}")
    print(f"\n    比值：{multi.input_tokens / single.input_tokens:.2f}×")

    print("\n  ★ 固定工作量之后，**多 agent 反而便宜** —— 而这不是好消息。")
    print("\n  原因是上下文增长从一个 O(15²) 变成了三个 O(5²)：")
    print("  15² = 225，而 3 × 5² = 75。**切碎上下文确实省钱，省的是平方项。**")
    print("\n  但省下来的那部分，正是 sub-agent 之间看不到的那部分信息。")
    print("  单 agent 第 14 步的时候看得到第 2 步读到的东西；")
    print("  三个 sub-agent 里没有任何一个看得到别人读到的东西。")
    print("\n  ★ 所以这个数字的正确读法是：**便宜和有损是同一件事的两面。**")
    print("  你省下的钱，等于你丢掉的上下文。")
    print("\n    任务真可拆（各路互不相干）→ 丢掉的本来就没用，这笔交易是赚的")
    print("    任务不可拆                 → 你用更少的钱买到了一个更差的结果，")
    print("                                 而账单上只看得到「更少的钱」")
    print("\n  这也是为什么第二组和第三组必须分开看：")
    print("  **「多 agent 贵不贵」取决于你问的是「同一个任务」还是「同样的工作量」，")
    print("  而这两个问题的答案方向相反。**")


def demo_telephone() -> None:
    print(f"\n【四】传话游戏：信息路径上的两次有损压缩\n{_line()}")

    t = telephone(raw_tokens=32_000, agents=3, summary_tokens_each=300, final_tokens=500)

    for h in t.hops:
        bar = "█" * max(1, round(h["kept"] * 40))
        tokens = _r(f"{h['tokens']:,}", 8)
        kept = _r(f"{h['kept'] * 100:.1f}%", 7)
        print(f"  {_cn(h['stage'], 24)}{tokens} token  {kept}  {bar}")

    print("\n  ★ 最终结论和原始材料之间隔了**两层转述**，")
    print("  而编排者**没有任何办法回去核对**——它从来没见过原始材料。")
    print("\n  单 agent 在这条路径上有几次压缩？**零次。**")
    print("  它第 14 步引用第 2 步读到的原文时，读的是原文。")
    print("\n  这不是说压缩一定是坏的——检索的本质就是压缩（L09 开头那句），")
    print("  32000 token 里绝大部分确实是噪声。")
    print("  问题在于**压缩发生在你看不到的地方，而且不可逆**。")
    print("\n  Anthropic 的应对值得抄：让 sub-agent 把产物写到文件，")
    print("  只把**轻量引用**交回编排者。把「转述」换成「指针」——")
    print("  编排者要细节的时候可以自己去读。shared/multi.py 的 to_artifact_ref 就是这个。")


def demo_runaway() -> None:
    print(f"\n【五】没有闸的时候，账单长什么样\n{_line()}")

    base = cost_multi(3, 5, SHAPE)
    cases = [
        ("规规矩矩：3 × 5", base),
        ("模型多开了一倍：6 × 5", cost_multi(6, 5, SHAPE)),
        ("「简单查询开了 50 个」", cost_multi(50, 5, SHAPE)),
        ("递归一层：每个又开 3 个", cost_multi(9, 5, SHAPE)),
        ("递归两层", cost_multi(27, 5, SHAPE)),
    ]

    for label, b in cases:
        print(
            f"  {_cn(label, 28)}{_r(f'{b.input_tokens:,}', 12)} token"
            f"{_r(f'¥{yuan_of(b):.2f}', 9)}{_r(f'{b.input_tokens / base.input_tokens:.1f}×', 8)}"
        )

    print("\n  ★ 第三行是 Anthropic 早期版本的真实故障：一个简单查询开了 50 个 sub-agent。")
    print("  后两行是**递归**——sub-agent 开 sub-agent。每加一层就乘一次扇出宽度。")
    print("\n  这解释了为什么 fanout 需要四道闸，也解释了为什么")
    print("  **深度那道闸要单独算一道**：它挡的是指数，另外三道挡的是线性。")
    print("\n  顺带一个观察：这五行里**没有一行会报错**。")
    print("  它们都会成功返回一个质量不错的答案，然后出现在月底的账单上。")
    print("  这也是这一节和 L10 共同的那个主题——**这一层的失效不响。**")


def main() -> None:
    print(f"\n{'═' * 74}")
    print(f"L11 · 15 倍是怎么来的（{MODEL}，一次 API 都不调）")
    print("═" * 74)

    demo_calibrate()
    demo_where_the_money_goes()
    demo_same_work()
    demo_telephone()
    demo_runaway()

    print(f"\n{_line()}")
    print("一句话：**多 agent 是一种花钱策略，不是一种架构。**")
    print("你花钱买的是并行探索的容量。任务里没有并行的时候，钱照花，东西买不到。")


if __name__ == "__main__":
    main()
