"""L05x 任务二（Python 通道）：手写采样。

    uv run python -m l05x.decode

把 temperature / top_p / top_k 从黑盒变成三十行代码。
参考实现在 shared/decode.py。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from shared.attention import softmax

Array = NDArray[np.float64]


# ─────────────────────────────────────────────────────────────
# TODO 1：温度缩放
#
#   logits / T
#
# T = 0 是特例，语义是 argmax。
#
# numpy 特有的坑：`logits / 0` **不抛异常**，给 inf 加一行 RuntimeWarning，
# 程序继续跑。所以必须显式分支。
#
# 干净的做法：最大值给 0、其余给 -inf，softmax 之后就是 one-hot。
# 用 np.argmax 找位置——它在并列时返回第一个。
# 别用 `logits == logits.max()` 做布尔掩码：并列时会得到多个 1。
# ─────────────────────────────────────────────────────────────


def apply_temperature(logits: Array, temperature: float) -> Array:
    raise NotImplementedError("TODO: 实现 apply_temperature")


# ─────────────────────────────────────────────────────────────
# TODO 2：top-k 截断
#
# 只留概率最大的 k 个，其余设 0，重新归一化。
#
# 提示：np.argpartition(-probs, k - 1)[:k] 是 O(n) 的部分排序，
# 比 np.argsort 快。注意它返回的是「前 k 个在前面」而不是「前 k 个有序」——
# 这里只要集合，够用。
# ─────────────────────────────────────────────────────────────


def apply_top_k(probs: Array, k: int) -> Array:
    raise NotImplementedError("TODO: 实现 apply_top_k")


# ─────────────────────────────────────────────────────────────
# TODO 3：top-p（nucleus）截断
#
# 按概率降序累加，到 p 为止，其余删掉，重新归一化。
#
# 提示：np.argsort(-probs) → np.cumsum → np.searchsorted
#
# 关键坑：**至少要留一个候选。**
# top1 概率超过 p 时（比如 p=0.5 而 top1=0.9），朴素实现会一个都不留，
# 然后归一化除以 0。numpy 给的是 nan 加一行警告，**不是异常**——
# 这个 nan 会一路带到下游，你会在很远的地方才发现。
#
# searchsorted 的结果 +1 就解决了：它保证包含那个使累积达标的位置本身。
# ─────────────────────────────────────────────────────────────


def apply_top_p(probs: Array, p: float) -> Array:
    raise NotImplementedError("TODO: 实现 apply_top_p")


# ─────────────────────────────────────────────────────────────
# TODO 4：完整采样
#
#   温度 → softmax → top_k → top_p → 按累积分布抽签
#
# 顺序有讲究：温度作用在 logits 上，截断作用在概率上。
#
# rand 可注入——测试必须确定。这个模式你在 L05 的 FakeModel 里见过。
# 默认值用 np.random.default_rng().random，别用全局的 np.random.random：
# 全局随机状态是隐式共享的，一个地方 seed 会影响所有地方。
# ─────────────────────────────────────────────────────────────


@dataclass
class SampleResult:
    index: int
    probs: Array
    candidates: int


def sample(
    logits: Array,
    temperature: float = 1.0,
    top_p: float = 1.0,
    top_k: int = 0,
    rand: Callable[[], float] | None = None,
) -> SampleResult:
    raise NotImplementedError("TODO: 实现 sample")


# ─────────────────────────────────────────────────────────────
# TODO 5：熵
#
#   H = -Σ p·log2(p)
#
# 坑：直接 `-np.sum(probs * np.log2(probs))` 在有 p=0 时给 nan
# （0 × -inf = nan），不是 0。必须过滤零项。
# 数学上 lim(p→0) p·log(p) = 0，但浮点不知道这件事。
# ─────────────────────────────────────────────────────────────


def entropy(probs: Array) -> float:
    raise NotImplementedError("TODO: 实现 entropy")


# ─────────────────────────────────────────────────────────────
# 观察实验
# ─────────────────────────────────────────────────────────────

LOGITS = np.array([8.2, 7.9, 6.1, 4.3, 3.8, 2.1, 1.4, 0.9, 0.2, -0.5, -1.2, -2.8])
LABELS = ["的", "是", "在", "有", "和", "了", "不", "也", "就", "很", "把", "啊"]


def show(probs: Array, indent: str = "    ") -> None:
    order = np.argsort(-probs)[:6]
    for i in order:
        p = float(probs[i])
        if p < 0.0001:
            continue
        bar = "█" * max(1, round(p * 40))
        print(f"{indent}{LABELS[i]}  {p * 100:>5.1f}%  {bar}")


def demo_temperature() -> None:
    print("\n【一】温度改变了什么")
    print("同一组 logits，不同温度。看分布的形状。\n")

    for t in (0.1, 0.7, 1.0, 1.5, 2.5):
        probs = softmax(apply_temperature(LOGITS, t))
        print(f"  T={t:.1f} · top1={probs.max() * 100:.1f}% · 熵={entropy(probs):.2f} bit")
        show(probs)
        print()

    print("  T 小 → top1 接近 100%，熵趋近 0。T 大 → 概率被抹平，长尾也有机会。")
    print("  这就是 L01 那个「温度调高输出更发散」的机制。")


def demo_truncation() -> None:
    print("\n【二】top_p 在删什么")
    print("T=1 固定，只改 top_p。\n")

    base = softmax(apply_temperature(LOGITS, 1.0))
    for p in (0.5, 0.8, 0.9, 0.95, 1.0):
        probs = apply_top_p(base, p) if p < 1 else base
        n = int(np.count_nonzero(probs))
        print(f"  top_p={p:.2f} · 候选 {n:>2}/{LOGITS.size} 个 · 熵={entropy(probs):.2f} bit")

    print("\n  top_p 砍掉的是长尾——概率极低但数量极多的怪 token。")
    print("  这解释了为什么 top_p=0.9 通常比 T=0.9 更有效地抑制胡言乱语：")
    print("  温度只是压缩差距，长尾还在；top_p 直接把长尾删了。")


def demo_nan_traps() -> None:
    print("\n【三】numpy 静默给 nan 的三个地方")
    print("这一节 Python 通道真正的收获。\n")

    with np.errstate(all="ignore"):
        # 一：softmax 不减最大值
        big = np.array([1000.0, 999.0, 998.0])
        naive = np.exp(big) / np.sum(np.exp(big))
        print(f"  不减最大值的 softmax([1000, 999, 998]) = {naive}")
        print("    → nan。而且只是一行 RuntimeWarning，程序继续跑。\n")

        # 二：熵不过滤零项
        p = np.array([1.0, 0.0, 0.0])
        naive_h = -np.sum(p * np.log2(p))
        print(f"  不过滤零项的熵([1, 0, 0]) = {naive_h}")
        print("    → nan。数学上应该是 0，但 0 × -inf 在浮点里是 nan。\n")

        # 三：top_p 截断到空集
        probs = np.array([0.9, 0.05, 0.05])
        empty = np.zeros_like(probs)
        print(f"  截断到空集后归一化 = {empty / empty.sum()}")
        print("    → 全 nan。top1 概率超过 p 时，朴素实现就会走到这里。")

    print("\n  三个都不抛异常。这是 numpy 和 TS 的一个真实差异：")
    print("  TS 里 NaN 至少会让你直接看到结果不对，numpy 把它降级成一行警告。")
    print("  纪律：**在数值代码里，把静默的 nan 变成响亮的异常。**")
    print("  实操上就是加断言——你写的 verify 就在干这件事。")


def demo_sampling() -> None:
    print("\n【四】采样是随机的，但有多随机")
    print("每种配置抽 200 次。\n")

    rng = np.random.default_rng(42)
    configs = [
        ("T=0（argmax）", {"temperature": 0.0}),
        ("T=0.7", {"temperature": 0.7}),
        ("T=1.0", {"temperature": 1.0}),
        ("T=1.0 top_p=0.9", {"temperature": 1.0, "top_p": 0.9}),
    ]

    for label, opts in configs:
        counts: dict[int, int] = {}
        for _ in range(200):
            idx = sample(LOGITS, rand=rng.random, **opts).index  # type: ignore[arg-type]
            counts[idx] = counts.get(idx, 0) + 1
        top = sorted(counts.items(), key=lambda kv: -kv[1])[:4]
        summary = " ".join(f"{LABELS[i]}×{c}" for i, c in top)
        print(f"  {label:<20} 出现 {len(counts)} 种 · {summary}")

    print("\n  T=0 只出一种——这是理论上的确定性。")
    print("  但真实 API 里 T=0 仍会偶尔变：浮点归约顺序和 MoE 路由会随批次变化。")
    print("  那部分不在这段代码里，也不在你的控制范围内。")


# ─────────────────────────────────────────────────────────────
# TODO 6：亲手踩一次坑
#
# 用 apply_top_p(probs, 0.3) 处理一个 top1 概率是 0.9 的分布。
# 如果你的实现漏了「至少留一个」，会得到什么？
#
# 然后想清楚：这个 bug 在生产里长什么样？（提示：不是报错）
# ─────────────────────────────────────────────────────────────


def main() -> None:
    print("logits → token，一共四步。")
    demo_temperature()
    demo_truncation()
    demo_nan_traps()
    demo_sampling()
    print("\n" + "─" * 60)
    print("L01 里你调过这些参数。现在你知道它们各自在动哪一步了。")
    print("别忘了 TODO 6。")


if __name__ == "__main__":
    main()
