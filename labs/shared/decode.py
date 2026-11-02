"""参考实现：logits → token 的四步（numpy）。

对照 shared/decode.ts。这一份短一些，但有两个 Python/numpy 特有的坑，
都在注释里标了——它们是这一节 Python 通道真正的收获。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from .attention import softmax

Array = NDArray[np.float64]


def apply_temperature(logits: Array, temperature: float) -> Array:
    """温度缩放。

    T < 1 放大差距（更确定），T > 1 压缩差距（更随机）。
    T = 0 是特例：语义是 argmax，不能真的做除法。

    numpy 特有的坑：`logits / 0` **不抛异常**，它给 inf 并打一行
    RuntimeWarning，程序继续跑。TS 里 `x / 0` 也给 Infinity，
    但 numpy 的警告混在输出里更容易被忽略。所以显式分支处理。
    """
    if temperature < 0:
        raise ValueError(f"temperature 不能是负数，收到 {temperature}")
    if temperature == 0:
        # argmax 的等价表示：最大值给 0，其余给 -inf，softmax 之后是 one-hot。
        # 这样后续步骤不需要为 T=0 分叉。
        out = np.full_like(logits, -np.inf)
        # np.argmax 在并列时返回第一个，正好是我们要的——
        # 如果用 `logits == logits.max()` 做布尔掩码，并列时会得到多个 1。
        out[int(np.argmax(logits))] = 0.0
        return out
    return logits / temperature


def _renormalize(probs: Array) -> Array:
    total = float(np.sum(probs))
    if total <= 0:
        raise ValueError("归一化时分母是 0，截断把所有候选都删了")
    return probs / total


def apply_top_k(probs: Array, k: int) -> Array:
    """top-k 截断：只留概率最大的 k 个。"""
    n = probs.shape[0]
    if k <= 0 or k >= n:
        return probs
    # argpartition 是 O(n) 的部分排序，比全排序快。
    # 注意它返回的是「前 k 个在前面」而不是「前 k 个有序」——
    # 这里只需要集合，所以够用。想要有序还得再排一次。
    keep = np.argpartition(-probs, k - 1)[:k]
    out = np.zeros_like(probs)
    out[keep] = probs[keep]
    return _renormalize(out)


def apply_top_p(probs: Array, p: float) -> Array:
    """top-p（nucleus）截断：按概率降序累加，到 p 为止。

    关键细节：**至少要留一个**。
    top1 概率超过 p 时（比如 p=0.5 而 top1=0.9），朴素实现会一个都不留，
    然后归一化除以 0。numpy 里这给的是 nan + 一行警告，不是异常——
    比 TS 更容易一路带到下游。
    """
    if p >= 1:
        return probs
    if p <= 0:
        raise ValueError(f"top_p 必须大于 0，收到 {p}")

    order = np.argsort(-probs)
    cumulative = np.cumsum(probs[order])
    # searchsorted 找到第一个 >= p 的位置，+1 保证包含它本身。
    # 这个 +1 就是「至少留一个」：即使 cumulative[0] 已经 >= p，也留下它。
    cut = int(np.searchsorted(cumulative, p)) + 1
    keep = order[:cut]

    out = np.zeros_like(probs)
    out[keep] = probs[keep]
    return _renormalize(out)


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
    """完整的一次采样：温度 → softmax → top_k → top_p → 抽签。

    顺序有讲究：温度作用在 logits 上（softmax 之前），
    截断作用在概率上（softmax 之后，因为要用累积概率判断）。

    rand 可注入——测试必须确定。这个模式你在 L05 的 FakeModel 里见过：
    把不确定性变成显式的依赖。
    """
    draw = rand if rand is not None else np.random.default_rng().random

    probs = softmax(apply_temperature(logits, temperature))
    if top_k > 0:
        probs = apply_top_k(probs, top_k)
    if top_p < 1:
        probs = apply_top_p(probs, top_p)

    candidates = int(np.count_nonzero(probs))

    r = draw()
    cumulative = np.cumsum(probs)
    # searchsorted(side='right') 等价于「第一个使累积 > r 的位置」。
    index = int(np.searchsorted(cumulative, r, side="right"))
    if index >= probs.shape[0]:
        # 浮点误差导致累积差一点到 1 时的兜底：取最后一个非零候选
        nonzero = np.nonzero(probs)[0]
        if nonzero.size == 0:
            raise ValueError("分布里没有任何非零候选")
        index = int(nonzero[-1])

    return SampleResult(index=index, probs=probs, candidates=candidates)


def entropy(probs: Array) -> float:
    """分布的熵（比特）。度量「模型在这一步有多犹豫」。

    坑：直接 `-np.sum(probs * np.log2(probs))` 在有 p=0 时给 nan
    （0 × -inf = nan），而不是 0。必须过滤零项。
    数学上 lim(p→0) p·log(p) = 0，但浮点不知道这件事。
    """
    nz = probs[probs > 0]
    h = -float(np.sum(nz * np.log2(nz)))
    # one-hot 分布会得到 -0.0，打印成 "-0.00" 看着像出错了。归一化掉。
    return 0.0 if h == 0 else h
