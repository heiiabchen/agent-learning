"""参考实现：attention 的最小可运行版本（numpy）。

对照 shared/attention.ts。那一份用纯数组，四十行；这一份用 numpy，十行。

这个差距是 L05x 的一个论点：整个 ML 生态在 Python 上，不是因为 Python 快，
是因为它让向量运算的意图可见。真正的计算反正在 C/CUDA 里。

尤其看 attention() 里的掩码：TS 版它藏在 `j <= i` 这个循环条件里，
是控制流的副作用；这里它是一个显式的布尔矩阵，能打印、能断言、能单独测。
「模型能看到未来」这个 bug 在后一种写法下更难悄悄溜过去。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

Array = NDArray[np.float64]


def softmax(scores: Array, axis: int = -1) -> Array:
    """softmax，带 max subtraction。

    减最大值不改变结果（分子分母同乘 e^-max），但保证最大的指数项是 e^0 = 1。
    不减的话，分数到 1000 量级时 np.exp 溢出成 inf，然后 inf/inf = nan。

    注意 numpy 溢出时给的是 RuntimeWarning 而不是异常——**默认只是打印一行警告，
    程序继续跑**。所以这里的 nan 比 TS 版更容易溜过去：TS 至少会让你看到
    结果是 NaN，numpy 可能让你在几层之后才发现。
    """
    shifted = scores - np.max(scores, axis=axis, keepdims=True)
    exp = np.exp(shifted)
    return exp / np.sum(exp, axis=axis, keepdims=True)


def causal_mask(n: int) -> NDArray[np.bool_]:
    """下三角掩码：mask[i, j] 为 True 表示位置 i 可以看位置 j。

    单独抽成函数只为一件事：让它可测。
    这就是 TS 版里那个 `j <= i` 条件，但现在它是个对象。
    """
    return np.tril(np.ones((n, n), dtype=bool))


@dataclass
class AttentionResult:
    out: Array
    weights: Array
    dot_products: int


def attention(Q: Array, K: Array, V: Array, causal: bool = True) -> AttentionResult:
    """单头 attention。

    causal=True 时加因果掩码：位置 i 只能看 0..i。
    漏了它，位置 i 就能看到 i+1——而它的任务正是预测 i+1。
    这个 bug 不报错，反而让训练指标变好，然后上线崩盘。
    """
    n, dim = Q.shape
    if K.shape[0] != n or V.shape[0] != n:
        raise ValueError(f"Q/K/V 长度必须一致，收到 {n}/{K.shape[0]}/{V.shape[0]}")
    if n == 0:
        empty = np.zeros((0, 0))
        return AttentionResult(out=empty, weights=empty, dot_products=0)

    # 这两行就是 TS 版三十行嵌套循环干的事。
    # einsum 的 'id,jd->ij' 读作：Q 的 (i,d) 和 K 的 (j,d)，对 d 求和，输出 (i,j)。
    # 多头 attention 有四五个维度，靠 transpose/reshape 排列组合极易出错，
    # 而 einsum 把维度用名字标出来了——读懂它就读得懂大部分开源模型的 attention。
    scores = np.einsum("id,jd->ij", Q, K) / np.sqrt(dim)

    if causal:
        mask = causal_mask(n)
        scores = np.where(mask, scores, -np.inf)
        dot_products = n * (n + 1) // 2
    else:
        dot_products = n * n

    weights = softmax(scores, axis=-1)
    out = weights @ V
    return AttentionResult(out=out, weights=weights, dot_products=dot_products)


class KVCache:
    """自回归生成时复用前面算好的 K/V。

    这就是服务端 prompt 缓存缓存的东西。也是为什么前缀必须逐 token 一致：
    append 是顺序的，第 k 个位置之后的内容依赖前 k 个。
    """

    def __init__(self) -> None:
        self._k: list[Array] = []
        self._v: list[Array] = []

    def __len__(self) -> int:
        return len(self._k)

    def append(self, k: Array, v: Array) -> None:
        self._k.append(np.asarray(k, dtype=np.float64))
        self._v.append(np.asarray(v, dtype=np.float64))

    def view(self) -> tuple[Array, Array]:
        """已缓存的 K/V，堆成矩阵。

        注意这里每次都 np.stack，是一次拷贝——真实实现会预分配一块显存
        然后原地写入，因为拷贝就白缓存了。这份为了短牺牲了这一点。
        """
        if not self._k:
            return np.zeros((0, 0)), np.zeros((0, 0))
        return np.stack(self._k), np.stack(self._v)

    def invalidate_from(self, index: int) -> int:
        """从第 index 个位置起全部作废，返回丢了多少个。

        Python 的 list 切片天然夹紧边界（`xs[:999]` 不会报错也不会撑长），
        这里比 JS 省心——JS 给 array.length 赋更大的值会把数组撑长。
        但仍要显式 max(0, ...)，因为负数索引在 Python 里有别的含义。
        """
        cut = max(0, min(index, len(self._k)))
        dropped = len(self._k) - cut
        self._k = self._k[:cut]
        self._v = self._v[:cut]
        return dropped


@dataclass
class DecodeStep:
    out: Array
    dot_products: int


def decode_step(q: Array, k_new: Array, v_new: Array, cache: KVCache) -> DecodeStep:
    """用 KV cache 生成一个 token：只算新 token 的 Q 对全部历史 K 的点积。

    每步 O(n) 而不是 O(n²)。没有 cache 每步都要重跑前缀，总成本 O(n³)。
    """
    cache.append(k_new, v_new)
    K, V = cache.view()
    scores = (K @ q) / np.sqrt(q.shape[0])
    w = softmax(scores, axis=-1)
    return DecodeStep(out=w @ V, dot_products=K.shape[0])


def random_matrix(rows: int, cols: int, seed: int = 1) -> Array:
    """可复现的随机矩阵。

    测试要确定，所以用固定种子的 Generator 而不是全局的 np.random。
    全局随机状态是隐式共享的——一个地方调用 np.random.seed 会影响所有地方，
    这类污染在测试里非常难查。default_rng 把状态变成显式对象。
    """
    rng = np.random.default_rng(seed)
    return rng.uniform(-1.0, 1.0, size=(rows, cols))
