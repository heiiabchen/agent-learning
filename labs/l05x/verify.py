"""验证 l05x/attention.py 和 l05x/decode.py。

    uv run python -m l05x.verify

纯数值，一次 API 都不调，也不需要 .env。

这套测试里有一整组专门盯着 numpy 的静默 nan：
softmax 溢出、熵不过滤零项、top_p 截断到空集——三个都只给警告不给异常。
把静默失败变成响亮失败，是这门课反复出现的同一条纪律。

先跑 VERIFY_TARGET=shared 确认测试本身是对的：
    VERIFY_TARGET=shared uv run python -m l05x.verify
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

import numpy as np

from shared.attention import random_matrix

_target = "shared" if os.environ.get("VERIFY_TARGET") == "shared" else "mine"

if _target == "shared":
    from shared import attention as A
    from shared import decode as D
else:
    from l05x import attention as A  # type: ignore[no-redef]
    from l05x import decode as D  # type: ignore[no-redef]

print(
    "\n（测的是 shared/ 里的参考实现）" if _target == "shared" else "\n（测的是 l05x/ 里你的实现）"
)

_passed = 0
_failures: list[str] = []


def test(name: str, fn: Callable[[], None]) -> None:
    global _passed
    try:
        fn()
        _passed += 1
        print(f"\033[32m  ✓\033[0m {name}")
    except Exception as err:  # noqa: BLE001 - 测试跑器要吞掉一切
        _failures.append(name)
        print(f"\033[31m  ✕ {name}\033[0m")
        print(f"\033[31m      {err}\033[0m")


def ok(cond: Any, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def close(actual: float, expected: float, tol: float, hint: str = "") -> None:
    if not np.isfinite(actual):
        raise AssertionError(f"得到了 {actual}（不是有限数）" + (f"\n      {hint}" if hint else ""))
    if abs(actual - expected) > tol:
        raise AssertionError(
            f"期待 {expected} ± {tol}，实际 {actual}" + (f"\n      {hint}" if hint else "")
        )


def raises(fn: Callable[[], Any], hint: str) -> None:
    try:
        fn()
    except Exception:
        return
    raise AssertionError(f"应该抛异常但没有：{hint}")


def no_nan(arr: Any, hint: str) -> None:
    a = np.asarray(arr, dtype=float)
    if not np.all(np.isfinite(a)):
        raise AssertionError(f"出现了 nan 或 inf：{a}\n      {hint}")


DIM = 8

# ─────────────────────────────────────────────────────────────
print("\nsoftmax")
# ─────────────────────────────────────────────────────────────

test("输出和为 1", lambda: close(float(A.softmax(np.array([1.0, 2, 3, 4])).sum()), 1, 1e-12))


def _monotone() -> None:
    p = A.softmax(np.array([1.0, 5, 3]))
    ok(p[1] > p[2] > p[0], f"顺序错了：{p}")


test("单调性：分数大的概率大", _monotone)


def _uniform() -> None:
    p = A.softmax(np.array([2.0, 2, 2, 2]))
    for x in p:
        close(float(x), 0.25, 1e-12)


test("全相等的分数给出均匀分布", _uniform)


def _shift_invariant() -> None:
    a = A.softmax(np.array([1.0, 2, 3]))
    b = A.softmax(np.array([101.0, 102, 103]))
    for i in range(3):
        close(float(b[i]), float(a[i]), 1e-9, "这是 softmax 的数学性质")


test("平移不变：整体加常数不改变结果", _shift_invariant)


def _no_overflow() -> None:
    p = A.softmax(np.array([1000.0, 999, 998]))
    no_nan(p, "np.exp(1000) 溢出成 inf，然后 inf/inf = nan。而 numpy 只给一行警告")
    close(float(p.sum()), 1, 1e-12)


test("大数不溢出（忘了 max subtraction 会静默给 nan）", _no_overflow)


def _no_underflow() -> None:
    p = A.softmax(np.array([-1000.0, -1001, -1002]))
    no_nan(p, "极小值也不该出 nan")
    close(float(p.sum()), 1, 1e-12)


test("极小数也不出 nan", _no_underflow)


def _masked_is_zero() -> None:
    p = A.softmax(np.array([2.0, -np.inf, 1.0]))
    close(float(p[1]), 0, 1e-15, "-inf 的 exp 是 0，所以掩码有效")
    close(float(p.sum()), 1, 1e-12)


test("被掩码位置（-inf）的概率是 0", _masked_is_zero)


def _axis_works() -> None:
    m = np.array([[1.0, 2, 3], [4, 5, 6]])
    p = A.softmax(m, axis=-1)
    ok(p.shape == (2, 3), f"形状不对：{p.shape}")
    for row in p:
        close(float(row.sum()), 1, 1e-12, "按行归一化，每行和为 1")


test("axis 参数生效（按行归一化而不是全局）", _axis_works)

# ─────────────────────────────────────────────────────────────
print("\n因果掩码")
# ─────────────────────────────────────────────────────────────


def _mask_shape() -> None:
    m = A.causal_mask(5)
    ok(m.shape == (5, 5), f"形状应该是 (5,5)，实际 {m.shape}")
    ok(m.dtype == np.bool_, f"应该是布尔矩阵，实际 {m.dtype}")


test("形状和 dtype", _mask_shape)


def _mask_lower_triangular() -> None:
    m = A.causal_mask(6)
    for i in range(6):
        for j in range(6):
            expected = j <= i
            ok(
                bool(m[i, j]) == expected,
                f"mask[{i},{j}] 应该是 {expected}，实际 {bool(m[i, j])}。位置 i 只能看 0..i",
            )


test("下三角：位置 i 只能看 0..i", _mask_lower_triangular)


def _mask_diagonal() -> None:
    m = A.causal_mask(4)
    ok(bool(np.all(np.diag(m))), "对角线必须全 True——每个位置至少能看到自己")


test("对角线全 True（每个位置能看到自己）", _mask_diagonal)

# ─────────────────────────────────────────────────────────────
print("\nattention")
# ─────────────────────────────────────────────────────────────

Q = random_matrix(6, DIM, 11)
K = random_matrix(6, DIM, 22)
V = random_matrix(6, DIM, 33)


def _rows_sum_to_one() -> None:
    w = A.attention(Q, K, V, causal=True).weights
    for i, row in enumerate(w):
        close(float(row.sum()), 1, 1e-9, f"第 {i} 行")


test("每一行权重和为 1", _rows_sum_to_one)


def _causal_enforced() -> None:
    w = A.attention(Q, K, V, causal=True).weights
    for i in range(w.shape[0]):
        for j in range(i + 1, w.shape[1]):
            close(
                float(w[i, j]),
                0,
                1e-15,
                f"位置 {i} 分给了未来位置 {j} 权重 {w[i, j]}。\n"
                "      这个 bug 不报错，反而让训练指标变好——位置 i 在抄 i+1 的答案。",
            )


test("因果掩码：位置 i 看不到 i 之后（漏了模型能看到未来）", _causal_enforced)


def _first_position() -> None:
    w = A.attention(Q, K, V, causal=True).weights
    close(float(w[0, 0]), 1, 1e-12, "它前面没有别的位置，softmax 单元素必然是 1")


test("第一个位置只能看自己，权重必然是 1", _first_position)


def _non_causal_sees_all() -> None:
    w = A.attention(Q, K, V, causal=False).weights
    ok(int(np.count_nonzero(w[0] > 1e-12)) == 6, f"期待 6 个非零权重，实际 {w[0]}")


test("causal=False 时能看到全部位置", _non_causal_sees_all)


def _convex_combination() -> None:
    out = A.attention(Q, K, V, causal=True).out
    lo = V.min(axis=0)
    hi = V.max(axis=0)
    ok(
        bool(np.all(out >= lo - 1e-9)) and bool(np.all(out <= hi + 1e-9)),
        "输出超出了 V 的取值范围。权重和为 1 且非负时，加权平均必然落在原值范围内",
    )


test("输出是 V 的凸组合（不会超出 V 的取值范围）", _convex_combination)


def _dot_product_count() -> None:
    for n in (4, 10, 20):
        r = A.attention(
            random_matrix(n, DIM, 1),
            random_matrix(n, DIM, 2),
            random_matrix(n, DIM, 3),
            causal=True,
        )
        expected = n * (n + 1) // 2
        ok(r.dot_products == expected, f"n={n} 时期待 {expected}，实际 {r.dot_products}")


test("点积次数是 n(n+1)/2（因果掩码省掉一半）", _dot_product_count)


def _quadratic() -> None:
    def count(n: int) -> int:
        return A.attention(
            random_matrix(n, DIM, 1),
            random_matrix(n, DIM, 2),
            random_matrix(n, DIM, 3),
            causal=True,
        ).dot_products

    close(count(200) / count(100), 4, 0.1, "这是架构性的平方，不是实现问题")


test("O(n²)：n 翻倍点积次数约翻四倍", _quadratic)


def _dilution() -> None:
    def avg_weight(n: int) -> float:
        w = A.attention(
            random_matrix(n, DIM, 7),
            random_matrix(n, DIM, 8),
            random_matrix(n, DIM, 9),
            causal=True,
        ).weights
        return 1.0 / int(np.count_nonzero(w[-1] > 1e-15))

    small, large = avg_weight(8), avg_weight(128)
    ok(large < small / 10, f"n=8 平均权重 {small}，n=128 平均权重 {large}。应该差一个数量级以上")


test("注意力稀释：n 越大，平均权重越小", _dilution)

test(
    "长度不一致时报错，而不是静默算错",
    lambda: raises(
        lambda: A.attention(
            random_matrix(4, DIM, 1), random_matrix(3, DIM, 2), random_matrix(4, DIM, 3)
        ),
        "Q 和 K 长度不同",
    ),
)

# ─────────────────────────────────────────────────────────────
print("\nKV cache")
# ─────────────────────────────────────────────────────────────


def _cache_len() -> None:
    c = A.KVCache()
    ok(len(c) == 0, f"新建的 cache 应该是空的，实际 {len(c)}")
    c.append(np.array([1.0, 2]), np.array([3.0, 4]))
    c.append(np.array([5.0, 6]), np.array([7.0, 8]))
    ok(len(c) == 2, f"期待 2，实际 {len(c)}")


test("append 后 __len__ 增长", _cache_len)


def _cache_view() -> None:
    c = A.KVCache()
    c.append(np.array([1.0]), np.array([10.0]))
    c.append(np.array([2.0]), np.array([20.0]))
    ck, cv = c.view()
    ok(ck.shape == (2, 1) and cv.shape == (2, 1), f"形状不对：{ck.shape} {cv.shape}")
    ok(float(ck[0, 0]) == 1.0 and float(cv[1, 0]) == 20.0, f"内容不对：{ck} {cv}")


test("view 返回堆好的 K/V 矩阵", _cache_view)


def _invalidate() -> None:
    c = A.KVCache()
    for i in range(10):
        c.append(np.array([float(i)]), np.array([float(i)]))
    ok(c.invalidate_from(3) == 7, "期待丢 7 个")
    ok(len(c) == 3, f"期待剩 3 个，实际 {len(c)}")


test("invalidate_from 砍掉之后的全部", _invalidate)


def _invalidate_one() -> None:
    c = A.KVCache()
    for i in range(100):
        c.append(np.array([float(i)]), np.array([float(i)]))
    ok(c.invalidate_from(1) == 99, "只改第 2 个 token，99 个作废")


test("invalidate_from(1) 几乎全废（时间戳放第二行的代价）", _invalidate_one)


def _invalidate_out_of_range() -> None:
    c = A.KVCache()
    c.append(np.array([1.0]), np.array([1.0]))
    dropped = c.invalidate_from(5)
    ok(dropped >= 0, f"丢弃数不该是负数，实际 {dropped}")
    ok(len(c) == 1, f"不该增长，实际 {len(c)}")


test("invalidate_from 超出长度时不会给出负数或撑长", _invalidate_out_of_range)


def _invalidate_negative() -> None:
    c = A.KVCache()
    for i in range(5):
        c.append(np.array([float(i)]), np.array([float(i)]))
    c.invalidate_from(-2)
    ok(
        len(c) == 0,
        f"负数索引应该被夹到 0，实际剩 {len(c)} 个。"
        "Python 的 xs[:-2] 会保留前 3 个——这是 Python 特有的坑",
    )


test("负数索引被夹紧（Python 切片的坑）", _invalidate_negative)


def _decode_step_cost() -> None:
    c = A.KVCache()
    for i in range(5):
        got = A.decode_step(Q[i], K[i], V[i], c).dot_products
        ok(got == i + 1, f"第 {i} 步期待 {i + 1} 次点积，实际 {got}")


test("decode_step 每步只算 O(n) 次点积", _decode_step_cost)


def _decode_matches_full() -> None:
    full = A.attention(Q, K, V, causal=True).out
    c = A.KVCache()
    for i in range(6):
        got = A.decode_step(Q[i], K[i], V[i], c).out
        ok(
            bool(np.allclose(got, full[i], atol=1e-9)),
            f"位置 {i} 不一致：\n      增量 {got}\n      一次性 {full[i]}\n"
            "      增量解码必须等价于一次性计算，否则 prefill 和 decode 会给出不同结果",
        )


test("decode_step 的结果和一次性 attention 一致", _decode_matches_full)

# ─────────────────────────────────────────────────────────────
print("\n温度")
# ─────────────────────────────────────────────────────────────

LOGITS = np.array([5.0, 3, 1, -1])


def _t1_identity() -> None:
    out = D.apply_temperature(LOGITS, 1.0)
    ok(bool(np.allclose(out, LOGITS)), f"T=1 不该改变 logits，实际 {out}")


test("T=1 不改变 logits", _t1_identity)


def _t_small_sharpens() -> None:
    p1 = A.softmax(D.apply_temperature(LOGITS, 1.0))
    p2 = A.softmax(D.apply_temperature(LOGITS, 0.5))
    ok(p2.max() > p1.max(), "T 小了 top1 概率应该更高")


test("T<1 放大差距", _t_small_sharpens)


def _t_large_flattens() -> None:
    p1 = A.softmax(D.apply_temperature(LOGITS, 1.0))
    p2 = A.softmax(D.apply_temperature(LOGITS, 3.0))
    ok(p2.max() < p1.max(), "T 大了 top1 概率应该更低")


test("T>1 压缩差距", _t_large_flattens)


def _t_zero_one_hot() -> None:
    p = A.softmax(D.apply_temperature(LOGITS, 0.0))
    no_nan(p, "T=0 时直接除会得到 inf/nan，而 numpy 只给一行警告")
    close(float(p[0]), 1, 1e-12, "最大值的位置应该是 1")
    close(float(p.sum()), 1, 1e-12)


test("T=0 退化成 one-hot（不是 nan）", _t_zero_one_hot)


def _t_zero_ties() -> None:
    p = A.softmax(D.apply_temperature(np.array([5.0, 5.0, 1.0]), 0.0))
    ones = int(np.count_nonzero(p > 0.99))
    ok(
        ones == 1,
        f"期待恰好 1 个位置接近 1，实际 {ones} 个：{p}。\n"
        "      用 `logits == logits.max()` 做掩码时并列会得到两个 0.5",
    )


test("T=0 且有并列最大值时只选一个", _t_zero_ties)

test(
    "负温度报错",
    lambda: raises(lambda: D.apply_temperature(LOGITS, -1.0), "temperature 不能是负数"),
)

# ─────────────────────────────────────────────────────────────
print("\ntop-k / top-p")
# ─────────────────────────────────────────────────────────────

PROBS = np.array([0.5, 0.25, 0.15, 0.07, 0.03])


def _top_k_count() -> None:
    out = D.apply_top_k(PROBS, 2)
    ok(int(np.count_nonzero(out)) == 2, f"期待 2 个候选，实际 {out}")
    close(float(out.sum()), 1, 1e-12, "截断后要重新归一化")


test("top_k 只留 k 个", _top_k_count)


def _top_k_keeps_largest() -> None:
    out = D.apply_top_k(PROBS, 2)
    ok(out[0] > 0 and out[1] > 0, "前两个应该保留")
    ok(out[2] == 0 and out[4] == 0, f"后面的应该删掉，实际 {out}")


test("top_k 留下的是概率最大的", _top_k_keeps_largest)

test(
    "top_k >= 长度时不截断",
    lambda: ok(bool(np.allclose(D.apply_top_k(PROBS, 99), PROBS)), "不该改变任何东西"),
)


def _top_p_cut() -> None:
    # 0.5 + 0.25 = 0.75 < 0.8，再加 0.15 到 0.9 >= 0.8 → 留 3 个
    out = D.apply_top_p(PROBS, 0.8)
    n = int(np.count_nonzero(out))
    ok(n == 3, f"期待 3 个候选，实际 {n}：{out}")
    close(float(out.sum()), 1, 1e-12)


test("top_p 按累积概率截断", _top_p_cut)


def _top_p_keeps_one() -> None:
    out = D.apply_top_p(np.array([0.9, 0.05, 0.05]), 0.3)
    no_nan(
        out,
        "「先判断累积再决定加入」的写法在这里会留 0 个，然后归一化除以 0。\n"
        "      numpy 给的是全 nan 加一行警告，不是异常——它会一路带到下游",
    )
    n = int(np.count_nonzero(out))
    ok(n == 1, f"期待留 1 个，实际 {n}：{out}")
    close(float(out.sum()), 1, 1e-12)


test("top_p 小于 top1 概率时仍留一个（不是 nan）", _top_p_keeps_one)

test(
    "top_p=1 不截断",
    lambda: ok(int(np.count_nonzero(D.apply_top_p(PROBS, 1.0))) == PROBS.size, "不该删任何东西"),
)


def _top_p_monotone() -> None:
    counts = [int(np.count_nonzero(D.apply_top_p(PROBS, p))) for p in (0.99, 0.9, 0.7, 0.5)]
    for i in range(1, len(counts)):
        ok(counts[i] <= counts[i - 1], f"候选数应该单调不增，实际 {counts}")


test("top_p 越小候选越少", _top_p_monotone)

test("top_p <= 0 报错", lambda: raises(lambda: D.apply_top_p(PROBS, 0.0), "top_p 必须大于 0"))

# ─────────────────────────────────────────────────────────────
print("\n采样")
# ─────────────────────────────────────────────────────────────


def fixed_rand(*values: float) -> Callable[[], float]:
    """固定的随机序列。测试必须确定，所以不能用真随机。"""
    state = {"i": 0}

    def draw() -> float:
        i = min(state["i"], len(values) - 1)
        state["i"] += 1
        return values[i]

    return draw


def _t_zero_argmax() -> None:
    for r in (0.0, 0.3, 0.99):
        idx = D.sample(np.array([1.0, 9, 3]), temperature=0.0, rand=fixed_rand(r)).index
        ok(idx == 1, f"rand={r} 时期待下标 1，实际 {idx}")


test("T=0 总是选最大的", _t_zero_argmax)


def _rand_decides() -> None:
    logits = np.zeros(4)  # 均匀分布，四个各 0.25
    picks = [D.sample(logits, rand=fixed_rand(r)).index for r in (0.1, 0.3, 0.6, 0.9)]
    ok(picks == [0, 1, 2, 3], f"期待 [0,1,2,3]，实际 {picks}。累积分布抽签的边界要对")


test("随机源决定选哪个（可注入 = 可测试）", _rand_decides)


def _no_out_of_range() -> None:
    idx = D.sample(np.array([1.0, 2, 3]), rand=fixed_rand(0.9999999999)).index
    ok(0 <= idx <= 2, f"下标越界：{idx}")


test("rand 接近 1 时不会越界", _no_out_of_range)


def _candidates_reported() -> None:
    a = D.sample(LOGITS, rand=fixed_rand(0.5))
    b = D.sample(LOGITS, top_k=2, rand=fixed_rand(0.5))
    ok(a.candidates == 4, f"不截断时期待 4，实际 {a.candidates}")
    ok(b.candidates == 2, f"top_k=2 时期待 2，实际 {b.candidates}")


test("返回的 candidates 反映截断后的候选数", _candidates_reported)

test(
    "返回的 probs 是截断后的分布，和为 1",
    lambda: close(float(D.sample(LOGITS, top_p=0.7, rand=fixed_rand(0.1)).probs.sum()), 1, 1e-12),
)


def _combo_shrinks() -> None:
    hot = D.sample(LOGITS, temperature=3.0, rand=fixed_rand(0.5)).candidates
    clipped = D.sample(LOGITS, temperature=3.0, top_p=0.6, rand=fixed_rand(0.5)).candidates
    ok(clipped < hot, f"高温 {hot} 个候选，加 top_p 后 {clipped} 个。应该更少")


test("温度 + top_p 组合：候选被压缩", _combo_shrinks)

# ─────────────────────────────────────────────────────────────
print("\n熵")
# ─────────────────────────────────────────────────────────────

test(
    "均匀分布的熵是 log2(n)",
    lambda: close(D.entropy(np.array([0.25, 0.25, 0.25, 0.25])), 2, 1e-10),
)

test(
    "one-hot 的熵是 0（不是 nan）",
    lambda: close(
        D.entropy(np.array([1.0, 0, 0, 0])),
        0,
        1e-12,
        "0 × log2(0) 在浮点里是 nan 而不是 0。必须过滤零项",
    ),
)


def _entropy_ordering() -> None:
    spread = D.entropy(A.softmax(D.apply_temperature(LOGITS, 2.0)))
    sharp = D.entropy(A.softmax(D.apply_temperature(LOGITS, 0.3)))
    ok(sharp < spread, f"T=0.3 熵 {sharp:.3f} 应该低于 T=2 熵 {spread:.3f}")


test("分布越集中熵越低", _entropy_ordering)

test(
    "T=0 的熵是 0（完全确定）",
    lambda: close(D.entropy(A.softmax(D.apply_temperature(LOGITS, 0.0))), 0, 1e-10),
)

# ─────────────────────────────────────────────────────────────
print("\n" + "─" * 60)
if not _failures:
    print(f"\033[32m{_passed} 项全过。\033[0m")
    print("\n黑盒拆完了。回去把 attention.py 的 TODO 6 和 decode.py 的 TODO 6 做掉。")
else:
    print(f"\033[31m{_passed} 过，{len(_failures)} 败：\033[0m")
    for f in _failures:
        print(f"\033[31m  · {f}\033[0m")
    raise SystemExit(1)
