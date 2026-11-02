"""L05x 任务一（Python 通道）：手写 attention，量出 O(n²) 和 KV cache 的收益。

    uv run python -m l05x.attention

这一节是整门课里 **Python 通道比 TS 更值得跑** 的唯一一节。
不是因为 Python 快，是因为 numpy 让向量运算的意图可见——而这一节的重点
恰好就是看清机制。写完对照一下 l05x/attention.ts，感受一下差距。

参考实现在 shared/attention.py。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from shared.attention import random_matrix

Array = NDArray[np.float64]


# ─────────────────────────────────────────────────────────────
# TODO 1：softmax
#
#   exp(x - max) / sum(exp(x - max))
#
# 必须做 max subtraction。不做的话，分数到 1000 量级时 np.exp 溢出成 inf，
# 然后 inf/inf = nan。
#
# numpy 特有的坑：溢出时它给的是 **RuntimeWarning 而不是异常**，
# 打一行警告然后继续跑。所以这个 bug 在 Python 里比在 TS 里更容易溜过去——
# TS 至少会让你直接看到结果是 NaN。
#
# 用 axis 参数和 keepdims=True，别用 Python 循环。
# ─────────────────────────────────────────────────────────────


def softmax(scores: Array, axis: int = -1) -> Array:
    raise NotImplementedError("TODO: 实现 softmax（记得 max subtraction）")


# ─────────────────────────────────────────────────────────────
# TODO 2：因果掩码
#
# 返回 (n, n) 的布尔矩阵，mask[i, j] 为 True 表示位置 i 可以看位置 j。
# 提示：np.tril
#
# 这里是这一节最值得体会的地方。TS 版里因果性藏在 `j <= i` 这个
# 循环条件里，是控制流的副作用；这里它是一个独立的对象——
# 你能打印它、断言它的形状、单独测它。
#
# 「模型能看到未来」这个 bug 不报错，反而让指标变好。
# 而 bug 在可检查的对象上比在控制流里更难藏。
# ─────────────────────────────────────────────────────────────


def causal_mask(n: int) -> NDArray[np.bool_]:
    raise NotImplementedError("TODO: 实现 causal_mask")


# ─────────────────────────────────────────────────────────────
# TODO 3：单头 attention
#
#   scores  = Q @ K.T / sqrt(dim)
#   scores  = np.where(mask, scores, -np.inf)     # causal=True 时
#   weights = softmax(scores)
#   out     = weights @ V
#
# 四行。对比一下 TS 版的三重循环。
#
# 试试用 einsum 写第一行：np.einsum("id,jd->ij", Q, K)
# 读作「Q 的 (i,d) 和 K 的 (j,d)，对 d 求和，输出 (i,j)」。
# 现在看着怪，但多头 attention 有四五个维度，靠 transpose/reshape
# 排列组合极易出错，而 einsum 把维度用名字标出来了。
# 开源模型的 attention 代码基本都这么写。
#
# dot_products 用公式算就行（因果时 n(n+1)/2，否则 n²），
# 因为 numpy 是向量化的，数不出来。
# ─────────────────────────────────────────────────────────────


@dataclass
class AttentionResult:
    out: Array
    weights: Array
    dot_products: int


def attention(Q: Array, K: Array, V: Array, causal: bool = True) -> AttentionResult:
    raise NotImplementedError("TODO: 实现 attention（别忘因果掩码）")


# ─────────────────────────────────────────────────────────────
# TODO 4：KV cache
#
# 需要 __len__ / append / view / invalidate_from。
# view 返回 (K, V) 两个矩阵，用 np.stack 把列表堆起来。
#
# invalidate_from(i)：从第 i 个位置起全部作废，返回丢了多少个。
# 它存在的意义是演示那条纪律：前缀改一个 token，从那里往后全废。
#
# Python 在这里比 JS 省心：list 切片天然夹紧边界（xs[:999] 不报错也不撑长），
# 而 JS 给 array.length 赋更大的值会把数组撑长。
# 但仍要 max(0, ...)，因为负数索引在 Python 里有别的含义。
# ─────────────────────────────────────────────────────────────


class KVCache:
    def __init__(self) -> None:
        raise NotImplementedError("TODO: 实现 KVCache")

    def __len__(self) -> int:
        raise NotImplementedError("TODO: 实现 __len__")

    def append(self, k: Array, v: Array) -> None:
        raise NotImplementedError("TODO: 实现 append")

    def view(self) -> tuple[Array, Array]:
        raise NotImplementedError("TODO: 实现 view")

    def invalidate_from(self, index: int) -> int:
        raise NotImplementedError("TODO: 实现 invalidate_from")


# ─────────────────────────────────────────────────────────────
# TODO 5：用 cache 走一步 decode
#
# 只算新 token 的 Q 对全部历史 K 的点积——O(n) 而不是 O(n²)。
# 这是自回归生成可行的原因。
# ─────────────────────────────────────────────────────────────


@dataclass
class DecodeStep:
    out: Array
    dot_products: int


def decode_step(q: Array, k_new: Array, v_new: Array, cache: KVCache) -> DecodeStep:
    raise NotImplementedError("TODO: 实现 decode_step")


# ─────────────────────────────────────────────────────────────
# 观察实验
# ─────────────────────────────────────────────────────────────

DIM = 16


def demo_zero_sum() -> None:
    print("\n【一】注意力是零和的")
    print("每一行权重加起来必须是 1。这不是巧合，是 softmax 的定义。\n")

    for n in (4, 16, 64):
        Q = random_matrix(n, DIM, 1)
        K = random_matrix(n, DIM, 2)
        V = random_matrix(n, DIM, 3)
        w = attention(Q, K, V, causal=True).weights

        last = w[-1]
        print(
            f"  n={n:>3} · 权重和={last.sum():.6f} · 最大权重={last.max():.4f} · 平均={1 / n:.4f}"
        )

    print("\n  平均权重 = 1/n。上下文长 10 倍，每个 token 平均分到的注意力少 10 倍。")
    print("  这就是「长上下文让模型变笨」的确切机制——不是模型累了，是注意力被稀释了。")


def demo_mask_is_an_object() -> None:
    print("\n【二】因果掩码是个能打印的东西")
    print("这是 numpy 版相对 TS 版的真正优势。\n")

    mask = causal_mask(6)
    for i, row in enumerate(mask):
        cells = " ".join("■" if x else "·" for x in row)
        print(f"  位置 {i}  {cells}")

    print("\n  ■ = 能看到，· = 被挡住。下三角。")
    print("  TS 版里这个结构藏在 `j <= i` 的循环条件里，看不见也测不了。")
    print("  这里它是个对象——能打印、能断言形状、能单独测。")
    print("  「模型能看到未来」这个 bug 不报错反而让指标变好，所以能不能测很关键。")


def demo_quadratic() -> None:
    print("\n【三】O(n²)：n 翻倍，计算量翻四倍")

    import time

    prev = 0
    print()
    for n in (256, 512, 1024, 2048):
        Q = random_matrix(n, DIM, 1)
        K = random_matrix(n, DIM, 2)
        V = random_matrix(n, DIM, 3)

        t0 = time.perf_counter()
        r = attention(Q, K, V, causal=True)
        ms = (time.perf_counter() - t0) * 1000

        ratio = f"{r.dot_products / prev:.2f}" if prev else "—"
        print(f"  n={n:>5} · 点积={r.dot_products:>9} · 比上一行={ratio:>5}× · 耗时={ms:>6.1f}ms")
        prev = r.dot_products

    print("\n  注意 n 的量级：numpy 版能轻松跑到 2048，TS 版到 256 就开始慢了。")
    print("  但比值还是 4——**优化实现不改变复杂度**。这就是 O(n²) 是架构性的意思。")
    print("  FlashAttention 那类工作优化的是内存访问，不是计算量。")


def demo_kv_cache() -> None:
    print("\n【四】KV cache 省了多少")
    print("生成 n 个 token，对比「每步重算全部」和「用 cache」。\n")

    for n in (16, 64, 256):
        Q = random_matrix(n, DIM, 1)
        K = random_matrix(n, DIM, 2)
        V = random_matrix(n, DIM, 3)

        naive = sum(
            attention(Q[:i], K[:i], V[:i], causal=True).dot_products for i in range(1, n + 1)
        )

        cache = KVCache()
        cached = sum(decode_step(Q[i], K[i], V[i], cache).dot_products for i in range(n))

        print(f"  n={n:>4} · 重算={naive:>9} · 用 cache={cached:>7} · 省了 {naive / cached:.1f}×")

    print("\n  重算是 O(n³)，用 cache 是 O(n²)。n 越大差距越大。")
    print("  没有 KV cache，自回归生成根本跑不起来。")


def demo_prefix_invalidation() -> None:
    print("\n【五】改一个 token，后面的缓存全废\n")

    total = 100
    cases = [
        ("前缀完全一致", total),
        ("第 2 个 token 变了（时间戳放在 system prompt 第二行）", 1),
        ("第 50 个 token 变了", 49),
        ("第 99 个 token 变了", 98),
    ]

    for label, shared_len in cases:
        cache = KVCache()
        for i in range(total):
            cache.append(np.array([float(i)]), np.array([float(i)]))
        dropped = cache.invalidate_from(shared_len)
        print(f"  {label}")
        print(f"    命中 {shared_len}/{total}（{shared_len * 100 // total}%）· 作废 {dropped} 个")

    print("\n  注意第二行：只改了第 2 个 token，99% 的缓存作废。")
    print("  修法永远是：会变的东西挪到消息末尾。")


# ─────────────────────────────────────────────────────────────
# TODO 6：亲手验证因果掩码
#
# 把 attention 的 causal 改成 False，重新跑【一】。
# 最后一个位置的权重有什么变化？第一个位置呢？
#
# 然后回答：漏掉因果掩码时，训练集上的 loss 会变高还是变低？
# 为什么这个 bug 特别危险？
# ─────────────────────────────────────────────────────────────


def main() -> None:
    print("把 attention 拆开看。不调 API，纯数值。")
    demo_zero_sum()
    demo_mask_is_an_object()
    demo_quadratic()
    demo_kv_cache()
    demo_prefix_invalidation()
    print("\n" + "─" * 60)
    print("五个实验对应五条你已经背过的纪律。现在它们有机制了。")
    print("别忘了 TODO 6：把 causal 关掉再跑一次。")


if __name__ == "__main__":
    main()
