"""L07 任务二：把「workflow 还是 agent」这个选择量出来（Python 版）。

    uv run python -m l07.compare

不调 API。用一个可复现的假模型跑 200 个工单，三种架构各跑一遍。

这个实验要打掉一个很常见的判断方式：**只比平均成本。**
平均值会告诉你 agent 只贵几倍，看起来能接受。
p95 会告诉你另一件事，而线上超时和账单告警看的是 p95。
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Literal

from shared.config import price_of

MODEL_CHEAP = "deepseek-v4-flash"
MODEL_STRONG = "deepseek-v4-pro"

Kind = Literal["easy", "hard"]


@dataclass
class Ticket:
    """'easy' 的工单只要按模板回，'hard' 的要查订单、查物流、算退款。

    agent_steps / agent_ok 预先定死而不是每种架构现摇，
    是为了让三种架构跑的是**同一批运行**。

    ★ 各摇一次的话，「混合最坏情况比纯 agent 还差」这种伪结论会冒出来——
    而它只是两条随机序列不同，和架构无关。
    **对照实验要控制变量，这条在 L12 做 evals 时是硬要求。**
    """

    kind: Kind
    agent_steps: int
    agent_ok: bool


@dataclass
class ModelCall:
    model: str
    input: int
    output: int


@dataclass
class Run:
    calls: list[ModelCall]


def tickets(n: int, rng: random.Random) -> list[Ticket]:
    """八成简单、两成复杂——这个比例是客服场景的典型分布。"""
    out: list[Ticket] = []
    for _ in range(n):
        kind: Kind = "easy" if rng.random() < 0.8 else "hard"
        # 长尾：85% 落在 base..base+2，15% 落在 base+5..base+16。
        # 这个形状不是编的——它是"模型走错路然后自己绕回来"的自然结果。
        u = rng.random()
        base = 5 if kind == "hard" else 3
        steps = base + int(rng.random() * 3) if u < 0.85 else base + 5 + int(rng.random() * 12)
        # agent 能处理复杂工单，但不是百分百；简单工单它也有小概率办歪。
        ok = rng.random() < (0.9 if kind == "hard" else 0.97)
        out.append(Ticket(kind=kind, agent_steps=steps, agent_ok=ok))
    return out


def yuan_of(run: Run) -> float:
    total = 0.0
    for c in run.calls:
        p = price_of(c.model)
        total += c.input / 1e6 * p.input_miss + c.output / 1e6 * p.output
    return total


# ─────────────────────────────────────────────────────────────
# 架构一：纯 workflow（路由 + 链式）
#
# 路径完全由代码决定。每个工单固定三次调用：
#   分类（便宜模型）→ 起草 → 检查
# ─────────────────────────────────────────────────────────────


def as_workflow(_t: Ticket) -> Run:
    # 复杂工单在纯 workflow 下走不通——流程里没有"去查订单"这一步。
    # 它会产出一个模板化的、答非所问的回复。
    # ★ 关键是：**成本正常，质量失败。** 只看账单看不出来。
    return Run(
        [
            ModelCall(MODEL_CHEAP, 700, 8),
            ModelCall(MODEL_CHEAP, 900, 220),
            ModelCall(MODEL_CHEAP, 1200, 40),
        ]
    )


def workflow_solves(t: Ticket) -> bool:
    return t.kind == "easy"


# ─────────────────────────────────────────────────────────────
# 架构二：纯 agent
#
# 每个工单都交给带工具的 agent。步数由模型决定。
# 步数分布是长尾的：多数 3-6 步，少数 8-20 步。
# ─────────────────────────────────────────────────────────────


def as_agent(t: Ticket) -> Run:
    calls: list[ModelCall] = []
    ctx = 2200  # system + 工具定义 + 工单
    for _ in range(t.agent_steps):
        calls.append(ModelCall(MODEL_STRONG, ctx, 120))
        ctx += 900  # 每一步都要重发全部历史（L02 那笔账）
    return Run(calls)


def agent_solves(t: Ticket) -> bool:
    return t.agent_ok


# ─────────────────────────────────────────────────────────────
# 架构三：混合——workflow 打底，agent 兜边缘
# ─────────────────────────────────────────────────────────────


def as_hybrid(t: Ticket) -> Run:
    gate = [ModelCall(MODEL_CHEAP, 700, 8)]
    if t.kind == "easy":
        return Run(gate + as_workflow(t).calls[1:])
    return Run(gate + as_agent(t).calls)


def hybrid_solves(t: Ticket) -> bool:
    return True if t.kind == "easy" else t.agent_ok


# ─────────────────────────────────────────────────────────────
# 统计
# ─────────────────────────────────────────────────────────────


@dataclass
class Stat:
    name: str
    total_yuan: float
    p50: float
    p95: float
    worst: float
    mean_calls: float
    max_calls: int
    solved: int
    n: int


def pct(sorted_xs: list[float], p: float) -> float:
    if not sorted_xs:
        return 0.0
    i = min(len(sorted_xs) - 1, int(p / 100 * len(sorted_xs)))
    return sorted_xs[i]


def summarize(name: str, runs: list[Run], solved: list[bool]) -> Stat:
    costs = sorted(yuan_of(r) for r in runs)
    calls = [len(r.calls) for r in runs]
    return Stat(
        name=name,
        total_yuan=sum(costs),
        p50=pct(costs, 50),
        p95=pct(costs, 95),
        worst=costs[-1],
        mean_calls=sum(calls) / len(calls),
        max_calls=max(calls),
        solved=sum(solved),
        n=len(runs),
    )


def _w(s: str) -> int:
    return sum(2 if "\u2e80" <= c <= "\u9fff" or "\uff00" <= c <= "\uffef" else 1 for c in s)


def pad(s: str, n: int) -> str:
    return s + " " * max(0, n - _w(s))


def rp(s: str, n: int) -> str:
    return " " * max(0, n - _w(s)) + s


def table(stats: list[Stat]) -> None:
    print(
        pad("架构", 14)
        + rp("总花费", 10)
        + rp("p50", 9)
        + rp("p95", 9)
        + rp("最坏", 9)
        + rp("p95/p50", 9)
        + rp("均步", 7)
        + rp("最多步", 8)
        + rp("解决率", 8)
    )
    print("─" * 83)
    for s in stats:
        print(
            pad(s.name, 14)
            + rp(f"¥{s.total_yuan:.3f}", 10)
            + rp(f"{s.p50:.5f}", 9)
            + rp(f"{s.p95:.5f}", 9)
            + rp(f"{s.worst:.5f}", 9)
            + rp(f"{s.p95 / s.p50:.1f}×", 9)
            + rp(f"{s.mean_calls:.1f}", 7)
            + rp(str(s.max_calls), 8)
            + rp(f"{s.solved / s.n * 100:.0f}%", 8)
        )


N = 200


def main() -> None:
    print(f"同一批 {N} 个客服工单（80% 简单 / 20% 复杂），三种架构各跑一遍。")
    print("假模型，不调 API，随机数固定种子——数字可复现。\n")

    batch = tickets(N, random.Random(7))
    ag_runs = [as_agent(t) for t in batch]

    stats = [
        summarize(
            "纯 workflow",
            [as_workflow(t) for t in batch],
            [workflow_solves(t) for t in batch],
        ),
        summarize("纯 agent", ag_runs, [agent_solves(t) for t in batch]),
        summarize("混合", [as_hybrid(t) for t in batch], [hybrid_solves(t) for t in batch]),
    ]
    table(stats)

    wf, ag, hy = stats

    print("\n【读数】\n")

    print("一 · 最该看的是 p95/p50 那一列，不是总花费。")
    print(f"   workflow：{wf.p95 / wf.p50:.1f}×——**方差为零**。每个工单花的钱一模一样。")
    print(f"   agent：{ag.p95 / ag.p50:.1f}×，最坏的一单是中位数的 {ag.worst / ag.p50:.1f} 倍。")
    print("   总花费只告诉你「贵了多少」，p95/p50 告诉你「贵得能不能预测」。")
    print("   后者才是能不能按次报价、能不能定 SLA、能不能给用户一个进度条的分界线。\n")

    print("二 · 这个方差不是模型不稳定造成的，是架构造成的。")
    print(f"   agent 最少 {min(len(r.calls) for r in ag_runs)} 步、最多 {ag.max_calls} 步。")
    print("   而每一步都要重发全部历史（L02），所以后面那些调用的输入是第一步的好几倍。")
    print("   **步数线性增长，成本二次增长。** 长尾在成本上被平方放大了一次。\n")

    print("三 · workflow 便宜，但有两成工单它根本解决不了——而账单看起来非常健康。")
    print(
        f"   解决率 {wf.solved / wf.n * 100:.0f}%，"
        f"花的钱只有纯 agent 的 1/{ag.total_yuan / wf.total_yuan:.0f}。"
    )
    print("   复杂工单它照样跑完三步、照样产出一段通顺的回复，只是答非所问。")
    print("   **成本正常，质量失败。** 这是最危险的一种失败模式，因为监控里看不见。")
    print("   这也是 L12 evals 存在的理由：成本能自己测，质量不能。\n")

    print("四 · 混合架构在这批数据上同时赢了成本和质量。")
    print(
        f"   花费 ¥{hy.total_yuan:.3f}，比纯 agent 省 "
        f"{(ag.total_yuan - hy.total_yuan) / ag.total_yuan * 100:.0f}%；"
    )
    print(
        f"   解决率 {hy.solved / hy.n * 100:.0f}%，"
        f"比纯 agent 的 {ag.solved / ag.n * 100:.0f}% 还高一点。"
    )
    print(f"   而且它的 p50 就是 workflow 的 p50（{hy.p50:.5f}）——**八成流量的成本完全确定。**\n")

    print("   解决率反超那一点值得单独说一句，它不是巧合：")
    print("   **在 workflow 覆盖得住的路径上，确定性流程比 agent 更可靠。**")
    print("   agent 在简单工单上也有 3% 的概率把事情办歪——它有选择的自由，")
    print("   而这个自由在不需要选择的时候只是风险。\n")

    print('   **"workflow 打底 + agent 兜边缘"是实际项目里最常见的形态。**')
    print("   不是因为它优雅，是因为它把不确定性关在了两成流量里。\n")

    print(f"五 · 但注意混合那一行的 p95/p50 是 {hy.p95 / hy.p50:.1f}×，全场最高。")
    print("   这不是它变差了，是**这个指标读不懂双峰分布**。")
    print(f"   混合架构的成本不是一条曲线，是两个簇：八成挤在 {hy.p50:.5f}，两成散在高位。")
    print("   p50 落在便宜簇里、p95 落在贵簇里，比值就被这个断层撑爆了。")
    print("   正确的读法是**分簇分别看**：便宜路径方差为零，贵路径和纯 agent 同分布。")
    print("   第一条读数刚教你看 p95/p50，第五条就告诉你它什么时候失效——")
    print("   这不是自相矛盾，是**用之前先看分布形状**这条纪律本身。\n")

    print("─" * 83)
    print(f"""
【还有两笔账这个脚本没算，但你要知道】

  · **可测性。** workflow 的每一步都能用固定输入单测，断言输出。
    agent 只能统计着看——同一个输入两次运行走不同的路。
    这个差别在写单测时是几倍工作量，在排查线上问题时是几十倍。

  · **延迟。** workflow 的三次调用串行，延迟固定叠加。
    agent 的延迟和步数成正比，所以和成本是同一条长尾分布。
    p95 延迟是产品能不能用的分水岭，而你没法给一个 {ag.max_calls} 步的运行做进度条。
""")


# ─────────────────────────────────────────────────────────────
# TODO：改三个数，看结论怎么翻
#
# 1. 把复杂工单比例从 20% 调到 60%（改 tickets 里的 0.8）。
#    混合架构还划算吗？临界点大概在哪？
#
# 2. 把 as_agent 里的长尾去掉（让 steps 恒等于 base + 1）。
#    p95 变成多少？这说明"agent 贵"到底贵在均值还是贵在尾巴？
#
# 3. 把 workflow_solves 改成恒返回 True。
#    表格里哪一列会变得看起来很棒？这对应线上什么样的自欺现象？
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    main()
