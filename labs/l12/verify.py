"""验证 l12/suite.py。跑法：

    cd labs && uv run python -m l12.verify
    cd labs && EVAL_IMPL=shared uv run python -m l12.verify   # 先确认测试本身对

一次 API 都不调——这一节的东西全是纯统计。
而"能用假的测的东西就不要用真的测"本身就是 TODO 2 的主张。

★ 带 ★ 的每一条对应一种"数字很好看但没有信息"：
分层缺口不报、judge 只输出一个标签、raw 当成 kappa、
位置偏见算成了内容分布、置信区间跨 0 却写进 PR、
净涨背后换了一批 bug、评测集腐化。

它们的共同点和前面每一节一样：**不抛异常。**
而这一节更狠一点——它们还会给你一个数字，让你以为自己有证据。
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable
from typing import Any

from shared import evals as shared
from shared.evals import Criterion, LogEntry, PairedVerdict

TARGET = "shared" if os.environ.get("EVAL_IMPL") == "shared" else "mine"

if TARGET == "shared":
    M: Any = shared
    print("\n（测的是 shared/ 里的参考实现）")
else:
    from l12 import suite as M  # type: ignore[no-redef]

    print("\n（测的是 l12/ 里你的实现）")

passed = 0
failures: list[str] = []


def test(name: str, fn: Callable[[], Any]) -> None:
    global passed
    try:
        fn()
        passed += 1
        print(f"\033[32m  ✓ {name}\033[0m")
    except Exception as err:  # noqa: BLE001
        failures.append(name)
        print(f"\033[31m  ✕ {name}\033[0m")
        for line in str(err).split("\n"):
            print(f"\033[31m      {line}\033[0m")


def eq(a: Any, b: Any, msg: str = "") -> None:
    if a != b:
        raise AssertionError(f"{msg}\n  期望 {b!r}\n  实际 {a!r}")


def ok(cond: bool, msg: str = "") -> None:
    if not cond:
        raise AssertionError(msg)


def near(a: float, b: float, tol: float = 1e-9, msg: str = "") -> None:
    if abs(a - b) > tol:
        raise AssertionError(f"{msg}\n  期望 ≈{b}\n  实际 {a}")


def logs() -> list[LogEntry]:
    kinds = ["查询", "改代码", "多步任务"]
    out: list[LogEntry] = []
    for i in range(200):
        r = i % 100
        outcome = "ok" if r < 92 else "wrong" if r < 96 else "error" if r < 99 else "timeout"
        out.append(
            LogEntry(
                id=f"log-{i}",
                input=f"请求 {i}",
                outcome=outcome,  # type: ignore[arg-type]
                kind=kinds[i % 3],
                steps=1 + (i % 9),
            )
        )
    return out


def crit(**kw: Any) -> Criterion:
    kw.setdefault("id", "c")
    kw.setdefault("says", "...")
    return Criterion(**kw)


# ─── 一、分层抽样 ─────────────────────────────────────────

print("\n一、分层抽样")

test(
    "每个分层各取到要求的条数（够的话）",
    lambda: (
        lambda r: (
            eq(r.coverage["ok"], 5),
            eq(r.coverage["wrong"], 5),
            eq(len(r.picked), 10),
        )
    )(M.stratified_sample(logs(), strata=["ok", "wrong"], per_stratum=5)),
)

test(
    "抽出来的确实属于对应分层",
    lambda: ok(
        all(e.outcome == "timeout" for e in M.stratified_sample(
            logs(), strata=["timeout"], per_stratum=2
        ).picked),
        "抽到了不属于该分层的样本",
    ),
)


def t_gaps() -> None:
    # timeout 在 200 条里只有 2 条，要 10 条肯定不够
    r = M.stratified_sample(logs(), strata=["timeout"], per_stratum=10)
    ok(len(r.gaps) > 0, "不够却没报 gaps —— 这就是那个静默失效")
    ok(any("timeout" in g for g in r.gaps), "gaps 里没提是哪个分层缺的，那这个 gaps 没用")


test("★ 分层不够时要报 gaps，不能静默少给", t_gaps)


def t_zero() -> None:
    r = M.stratified_sample(logs(), strata=["ok", "不存在的分层"], per_stratum=3)
    eq(r.coverage["不存在的分层"], 0)
    ok(any("不存在的分层" in g for g in r.gaps), "0 条的分层没进 gaps")


test('★ 某分层 0 条时必须单独说明，那不是"少几条"而是"这一类不存在"', t_zero)


def t_stratify() -> None:
    r = M.stratified_sample(
        logs(),
        strata=["短", "长"],
        per_stratum=4,
        stratify=lambda e: "长" if e.steps > 5 else "短",
    )
    eq(r.coverage["短"], 4)
    eq(len([e for e in r.picked if e.steps > 5]), 4, "stratify 没被用上")


test("可换 stratify：按步数分层而不是按 outcome", t_stratify)


def t_determinism() -> None:
    a = M.stratified_sample(logs(), strata=["ok", "wrong"], per_stratum=4)
    b = M.stratified_sample(logs(), strata=["ok", "wrong"], per_stratum=4)
    eq(
        [e.id for e in a.picked],
        [e.id for e in b.picked],
        '两次抽样结果不同 —— 那你没法判断"跑分变了"是改动还是抖动',
    )


test("确定性：同样输入抽出同一批（评测必须可复现）", t_determinism)

# ─── 二、判据路由 ─────────────────────────────────────────

print("\n二、把判据路由到最便宜的够用的检查")

test("有 expect 走精确匹配", lambda: eq(M.route_check(crit(expect="P0")).kind, "exact"))
test(
    "有 fields 走结构检查",
    lambda: eq(M.route_check(crit(fields=["severity"])).kind, "structural"),
)
test("有 pattern 走正则", lambda: eq(M.route_check(crit(pattern=r"\[\d+\]")).kind, "regex"))
test(
    "优先级：expect 压过 pattern（都给了要选更便宜更确定的）",
    lambda: eq(M.route_check(crit(expect="P0", pattern="P")).kind, "exact"),
)
test("semantic 才走 judge", lambda: eq(M.route_check(crit(semantic=True)).kind, "judge"))


def t_negate_why() -> None:
    r = M.route_check(crit(pattern="internal-", negate=True))
    eq(r.kind, "regex")
    ok(
        "失败" in r.why or "反" in r.why,
        "反向断言没在 why 里说明 —— 安全类判据大半是反向的，"
        "写成正向会让含义正好反过来且测试全绿",
    )


test('★ negate 的 why 要说清"命中就算失败"', t_negate_why)


def t_fallback() -> None:
    r = M.route_check(crit(says="回答质量要好"))
    eq(r.kind, "judge")
    ok(
        any(k in r.why for k in ("没定义", "不清", "说不出")),
        '兜底到 judge 却没提示"这条判据本身有问题" —— '
        "一条你自己都说不出怎么验的判据，judge 也判不了",
    )


test("★ 什么依据都没给时兜底到 judge，但要指出判据本身没定义清楚", t_fallback)


def t_negate_runs() -> None:
    cs = [crit(id="neg", pattern="internal-", negate=True)]
    eq(shared.run_deterministic("用了 internal-billing 服务", cs)[0].passed, False)
    eq(shared.run_deterministic("用了计费服务", cs)[0].passed, True)


test("反向断言真的反着判：命中 = 失败", t_negate_runs)

# ─── 三、偶然一致率 ───────────────────────────────────────

print("\n三、偶然一致率")

test(
    "完全一边倒时偶然一致率是 1",
    lambda: near(M.chance_agreement(["a"] * 3, ["a"] * 3), 1),
)
test(
    "两标签各半时偶然一致率是 0.5",
    lambda: near(M.chance_agreement(["a", "b", "a", "b"], ["a", "b", "b", "a"]), 0.5),
)
test(
    "★ 标签集合要取并集：judge 输出了人工没有的标签",
    lambda: near(M.chance_agreement(["x"] * 4, ["a", "a", "b", "b"]), 0),
)

# ─── 四、带偶然校正的一致率 ───────────────────────────────

print("\n四、带偶然校正的一致率（本节最重要的函数）")

HUMAN80 = ["pass"] * 80 + ["fail"] * 20

test("完全一致时 kappa 是 1", lambda: near(M.agreement(HUMAN80, HUMAN80).kappa, 1))


def t_lazy() -> None:
    r = M.agreement(["pass"] * 100, HUMAN80)
    near(r.raw, 0.8, 1e-9, "raw 应该等于多数类占比")
    near(r.kappa, 0, 1e-9, "这个 judge 什么都不看，kappa 必须是 0")


test("★ 永远说 pass 的 judge：raw 高达 0.8，而 kappa 恰好是 0", t_lazy)


def t_same_raw() -> None:
    lazy = M.agreement(["pass"] * 100, HUMAN80)
    real = [
        ("fail" if h == "pass" else "pass") if i % 5 == 0 else h
        for i, h in enumerate(HUMAN80)
    ]
    r = M.agreement(real, HUMAN80)
    near(r.raw, 0.8, 1e-9)
    ok(
        r.kappa > lazy.kappa + 0.2,
        f"raw 一样（都是 0.8）但 kappa 应该差很多，实际 {r.kappa:.3f} vs {lazy.kappa:.3f}",
    )


test("★ 同一个 raw 可以对应完全不同的 kappa（所以 raw 不能当结论）", t_same_raw)

test(
    "★ judge 只输出一个标签必须进 problems",
    lambda: ok(
        any(
            "一个标签" in p or "只输出" in p
            for p in M.agreement(["pass"] * 100, HUMAN80).problems
        ),
        '没报出"judge 只输出过一个标签" —— 这是最常见的退化，而 raw 会掩盖它',
    ),
)

test(
    "★ 人工标注只有一个标签：这个评测集没有区分度",
    lambda: ok(
        len(M.agreement(["pass"] * 50, ["pass"] * 50).problems) > 0,
        "人工标注单一标签时必须报问题",
    ),
)


def t_chance_one() -> None:
    r = M.agreement(["pass"] * 50, ["pass"] * 50)
    import math

    ok(
        math.isfinite(r.kappa),
        f"kappa 是 {r.kappa} —— 分母为 0 是要报出来的问题，不是计算错误",
    )


test("★ chance 等于 1 时不能返回 nan 或抛异常", t_chance_one)


def t_deflation() -> None:
    r = M.agreement(["pass"] * 100, HUMAN80)
    ok(r.raw - r.kappa > 0.3, "这个例子里 raw−kappa 应该大于 0.3")
    ok(any("百分点" in p or "高" in p for p in r.problems), "差距没被报出来")


test('★ raw 与 kappa 差得太多要明确说"raw 不能当结论用"', t_deflation)


def t_len_mismatch() -> None:
    # ★ Python 特有：zip 默认静默截断。要么显式检查长度，要么 strict=True。
    threw = False
    try:
        M.agreement(["pass"], ["pass", "fail"])
    except Exception:  # noqa: BLE001
        threw = True
    ok(threw, "两组标签长度不同却算出了一个数 —— 那个数是错的（zip 静默截断）")


test("★ 长度不一致要报错，不能静默截断（zip 的坑）", t_len_mismatch)

# ─── 五、judge 体检 ───────────────────────────────────────

print("\n五、judge 上线前的体检")

# "永远选排在前面那个"的 judge。极稳，极偏。
# AB 顺序里前面是 A 所以判 A；BA 顺序里前面是 B 所以判 B。
ALWAYS_FIRST = [
    PairedVerdict(ab="A", ba="B", len_a=100 + i, len_b=100 + (i % 7) * 10)
    for i in range(40)
]

test(
    "位置偏见：永远选排在前面那个时是 0.5",
    lambda: near(shared.position_bias(ALWAYS_FIRST), 0.5),
)


def t_content_driven() -> None:
    # ★ 这一条守着一个很容易写错的实现：abs(P(A 赢) − 0.5)。
    # A 真的更好、judge 两次都正确地选了 A —— 那个错实现会报 0.5。
    v = [PairedVerdict(ab="A", ba="A", len_a=100, len_b=100) for _ in range(40)]
    near(
        shared.position_bias(v),
        0,
        1e-9,
        '把"A 有多常赢"当成了位置偏见 —— 那测的是内容分布',
    )


test("★ 只看内容的 judge 位置偏见是 0，哪怕 A 一直赢", t_content_driven)


def t_invariant_of_dist() -> None:
    for share in (0.1, 0.5, 0.9):
        v = [
            PairedVerdict(
                ab="A" if i < 40 * share else "B",
                ba="A" if i < 40 * share else "B",
                len_a=100,
                len_b=100,
            )
            for i in range(40)
        ]
        near(shared.position_bias(v), 0, 1e-9, f"A 胜率 {share} 时位置偏见应该还是 0")


test("位置偏见：AB/BA 一致时恒为 0（与胜负分布无关）", t_invariant_of_dist)


def t_identity() -> None:
    def mk(n: int, flip_a: int, flip_b: int) -> list[PairedVerdict]:
        return (
            [PairedVerdict(ab="A", ba="B", len_a=1, len_b=1) for _ in range(flip_a)]
            + [PairedVerdict(ab="B", ba="A", len_a=1, len_b=1) for _ in range(flip_b)]
            + [
                PairedVerdict(ab="A", ba="A", len_a=1, len_b=1)
                for _ in range(n - flip_a - flip_b)
            ]
        )

    for fa, fb in ((20, 0), (10, 10), (12, 4), (0, 0)):
        v = mk(40, fa, fb)
        pb, fr = shared.position_bias(v), shared.flip_rate(v)
        ok(pb <= fr / 2 + 1e-9, f"位置偏见 {pb} 超过了翻转率的一半 {fr / 2}")
    # 翻转全朝一个方向时取到等号
    near(shared.position_bias(mk(40, 20, 0)), shared.flip_rate(mk(40, 20, 0)) / 2, 1e-9)
    # 翻转方向对半时是噪声，位置偏见为 0
    near(shared.position_bias(mk(40, 10, 10)), 0, 1e-9)


test("★ 恒等关系：位置偏见 ≤ 翻转率 / 2", t_identity)


def t_paradox() -> None:
    a = M.audit_judge(
        judge_labels=[v.ab for v in ALWAYS_FIRST],
        human_labels=["B" if i % 3 == 0 else "A" for i in range(40)],
        paired=ALWAYS_FIRST,
        runs=[["A"] * 40 for _ in range(3)],
    )
    near(a.test_retest, 1, 1e-9, "同一个 prompt 问三次答案都一样，重测信度必然是 1")
    ok(a.position_bias > 0.4, "位置偏见应该接近 0.5")
    eq(a.deployable, False, "重测满分不代表可靠 —— 最可复现的 judge 恰恰是最不可信的那些")
    ok(
        any("悖论" in p or "稳定" in p for p in a.problems),
        '没把"高稳定 + 高偏见"这件事说成一种失效',
    )


test("★ 一致性—偏见悖论：重测 1.0 + 位置偏见 0.5 必须判不可上线", t_paradox)


def t_noise_not_bias() -> None:
    noisy = [
        PairedVerdict(
            ab="A" if i % 2 == 0 else "B",
            ba="B" if i % 2 == 0 else "A",
            len_a=100,
            len_b=100,
        )
        for i in range(40)
    ]
    near(shared.flip_rate(noisy), 1, 1e-9)
    near(shared.position_bias(noisy), 0, 1e-9)
    humans = ["A" if i % 2 == 0 else "B" for i in range(40)]
    a = M.audit_judge(
        judge_labels=[v.ab for v in noisy],
        human_labels=humans,
        paired=noisy,
        runs=[humans, humans, humans],
    )
    ok(
        any("噪声" in p for p in a.problems),
        "翻转率 100% 而位置偏见 0，要说清这是噪声不是偏见 —— 对称化消不掉噪声",
    )


test("★ 翻转率高但位置偏见低要判成噪声，不是偏见（修法不同）", t_noise_not_bias)


def t_good_judge() -> None:
    humans = ["B" if i % 3 == 0 else "A" for i in range(60)]
    paired = [
        PairedVerdict(
            ab=h,  # type: ignore[arg-type]
            ba=h,  # type: ignore[arg-type]
            len_a=100 + (i % 5) * 30,
            len_b=100 + ((i + 2) % 5) * 30,
        )
        for i, h in enumerate(humans)
    ]
    a = M.audit_judge(
        judge_labels=humans, human_labels=humans, paired=paired, runs=[humans] * 3
    )
    eq(a.deployable, True, f"各项都好却判不可上线：{' / '.join(a.problems)}")


test("一个各项都过关的 judge 判为可上线", t_good_judge)


def t_unstable() -> None:
    humans = ["B" if i % 3 == 0 else "A" for i in range(30)]
    paired = [
        PairedVerdict(ab=h, ba=h, len_a=100, len_b=100)  # type: ignore[arg-type]
        for h in humans
    ]
    a = M.audit_judge(
        judge_labels=humans,
        human_labels=humans,
        paired=paired,
        runs=[
            humans,
            [("B" if h == "A" else "A") if i % 3 == 1 else h for i, h in enumerate(humans)],
            [("B" if h == "A" else "A") if i % 3 == 2 else h for i, h in enumerate(humans)],
        ],
    )
    eq(a.deployable, False)
    ok(a.test_retest < 0.9)


test("重测信度低要拦：同样输入跑三次结果都不同", t_unstable)

# ─── 六、置信区间 ─────────────────────────────────────────

print("\n六、bootstrap 置信区间")


def mk_scores(n: int, rate: float = 0.8) -> list[float]:
    k = round(n * rate)
    return [1.0] * k + [0.0] * (n - k)


test(
    "区间包含样本均值",
    lambda: (
        lambda ci: ok(ci.lo <= 0.8 <= ci.hi, f"区间 [{ci.lo}, {ci.hi}] 不含均值 0.8")
    )(M.bootstrap_ci(mk_scores(100), seed=42)),
)


def t_width() -> None:
    def w(n: int) -> float:
        ci = M.bootstrap_ci(mk_scores(n), seed=42)
        return ci.hi - ci.lo

    ok(w(50) > w(500), "50 条的区间应该比 500 条宽")
    ok(w(500) > w(2000), "500 条的区间应该比 2000 条宽")


test('★ 样本越少区间越宽（这就是"涨 2% 什么都不意味着"的来源）', t_width)


def t_150() -> None:
    ci = M.bootstrap_ci(mk_scores(150), seed=42)
    w = (ci.hi - ci.lo) * 100
    ok(10 < w < 16, f"宽度 {w:.1f} 个百分点，超出预期范围")


test("150 条 / 80% 的区间宽度在 10~16 个百分点之间", t_150)


def t_seed() -> None:
    s = mk_scores(100)
    eq(
        M.bootstrap_ci(s, seed=1),
        M.bootstrap_ci(s, seed=1),
        "同 seed 结果不同 —— 评测必须可复现",
    )
    a, b = M.bootstrap_ci(s, seed=1), M.bootstrap_ci(s, seed=999)
    ok(a.lo != b.lo or a.hi != b.hi, "不同 seed 完全一样，说明 seed 没被用上")


test("同 seed 可复现，不同 seed 略有差异", t_seed)

test(
    "全 1 的样本区间退化成一个点",
    lambda: (lambda ci: (near(ci.lo, 1), near(ci.hi, 1)))(
        M.bootstrap_ci([1.0] * 50, seed=42)
    ),
)

# ─── 七、回归比较 ─────────────────────────────────────────

print("\n七、回归比较（最重要的输出不是 delta）")


def runs(fix: list[int], brk: list[int]) -> tuple[dict[str, float], dict[str, float]]:
    before = {f"c{i}": (1.0 if i < 70 else 0.0) for i in range(100)}
    after = dict(before)
    for i in fix:
        after[f"c{i}"] = 1.0
    for i in brk:
        after[f"c{i}"] = 0.0
    return before, after


def t_lists() -> None:
    b, a = runs([70, 71, 72], [0, 1])
    r = M.compare_runs(b, a)
    eq(sorted(r.fixed), ["c70", "c71", "c72"])
    eq(sorted(r.broken), ["c0", "c1"])


test("fixed / broken 分别列出是哪些 case", t_lists)


def t_two_shapes() -> None:
    # 甲：修好 12 个、弄坏 10 个 —— 这不是改进，这是换了一批 bug
    ba, aa = runs(list(range(70, 82)), list(range(10)))
    # 乙：修好 3 个、弄坏 1 个 —— 基本是抖动
    bb, ab = runs([70, 71, 72], [5])
    swapped, jitter = M.compare_runs(ba, aa), M.compare_runs(bb, ab)
    near(swapped.delta, jitter.delta, 0.005, "构造得不对：两种情况的 delta 应该一样")
    ok(
        len(swapped.broken) > len(jitter.broken) + 5,
        f"delta 一样，但 broken 必须差很多：{len(swapped.broken)} vs {len(jitter.broken)}",
    )


test("★ 净涨 +2% 的两种情况必须能区分开", t_two_shapes)


def t_verdict() -> None:
    b, a = runs(list(range(70, 82)), list(range(10)))
    r = M.compare_runs(b, a)
    ok(r.delta > 0, "这个例子净值是涨的")
    ok(
        any(k in r.verdict for k in ("弄坏", "换", "bug")),
        f"verdict 只说了净变化：「{r.verdict}」"
        '—— 净值会把"换了一批 bug"藏起来',
    )


test('★ 换了一批 bug 时 verdict 要说出来，不能只说"涨了"', t_verdict)


def t_clean() -> None:
    b, a = runs([70, 71, 72, 73], [])
    r = M.compare_runs(b, a)
    eq(r.broken, [])
    eq(len(r.fixed), 4)


test("干净的改进：broken 为空", t_clean)


def t_common_ids() -> None:
    r = M.compare_runs({"a": 1.0, "b": 0.0, "c": 0.0}, {"a": 1.0, "b": 1.0, "d": 1.0})
    ok("d" not in r.fixed and "d" not in r.broken, "新增的 d 不该参与成对比较")
    ok("c" not in r.fixed and "c" not in r.broken, "消失的 c 不该参与成对比较")
    eq(r.fixed, ["b"])


test("★ 只比两边都有的 id（换了样本之后跑分涨了是经典自欺）", t_common_ids)


def t_jitter_not_sig() -> None:
    b, a = runs([70, 71], [5])
    eq(M.compare_runs(b, a).significant, False, "一两条的变化在 100 条样本上不可能显著")


test("抖动两三条时不该判显著", t_jitter_not_sig)


def t_paired_narrower() -> None:
    b, a = runs([70, 71, 72, 73, 74], [])
    r = M.compare_runs(b, a)
    ci = M.bootstrap_ci(list(a.values()), seed=42)
    w_paired, w_single = r.ci.hi - r.ci.lo, ci.hi - ci.lo
    ok(
        w_paired < w_single,
        f"成对区间宽 {w_paired:.3f}，单组区间宽 {w_single:.3f} —— 成对应该更窄",
    )


test("成对差值的区间比两个均值各自的区间窄得多", t_paired_narrower)

# ─── 八、多重比较（Python 独有）─────────────────────────

print("\n八、多重比较（Python 独有：校正实现在 statsmodels 里）")

test(
    "k=1 时假阳性概率就是 α",
    lambda: near(M.multiple_comparisons(1)["p_any_false_positive"], 0.05),
)
test(
    "★ k=7 时至少一个假阳性的概率约 30%",
    lambda: near(M.multiple_comparisons(7)["p_any_false_positive"], 1 - 0.95**7, 1e-9),
)
test(
    "k=20 时超过六成",
    lambda: ok(M.multiple_comparisons(20)["p_any_false_positive"] > 0.6),
)
test(
    "Bonferroni 校正后阈值是 α/k",
    lambda: near(M.multiple_comparisons(7)["adjusted_alpha"], 0.05 / 7),
)
test(
    '★ 建议里必须提"先声明主指标"，因为校正会降低功效',
    lambda: ok(
        any(k in M.multiple_comparisons(7)["advice"] for k in ("主指标", "声明")),
        "只给了校正阈值却没说事前声明主指标 —— 校正是补救，声明才是解法",
    ),
)

# ─── 九、腐化检测 ─────────────────────────────────────────

print("\n九、评测集腐化")


def t_rot_split() -> None:
    r = shared.detect_rot(
        {"a": [1, 1, 1, 1], "b": [0, 1, 0, 1], "c": [0, 0, 0, 0]}
    )
    eq(r.always_pass, ["a"])
    eq(r.live, ["b"])
    eq(r.always_fail, ["c"])


test("把三类样本分开：还有区分度 / 一直全对 / 从来没过", t_rot_split)


def t_rot_low() -> None:
    h: dict[str, list[float]] = {f"old{i}": [1, 1, 1, 1] for i in range(40)}
    h.update({f"new{i}": [0, 1, 0, 1] for i in range(5)})
    ok(len(shared.detect_rot(h).problems) > 0, "八成样本已经没信息了却什么都不说")


test("★ 区分度低于三成要报出来（这个门禁快要失效了）", t_rot_low)


def t_rot_stuck() -> None:
    h: dict[str, list[float]] = {"a": [0, 1, 1, 0]}
    h.update({f"stuck{i}": [0, 0, 0, 0] for i in range(6)})
    r = shared.detect_rot(h)
    ok(
        any("标注" in p or "确认" in p for p in r.problems),
        "永远失败的 case 会让你去修一个不存在的问题，必须提示人工核对",
    )


test('★ "从来没过"要提示先人工确认标注', t_rot_stuck)

# ─── 十、门禁 ─────────────────────────────────────────────

print("\n十、门禁（这一节的交付物）")

from l12.regress import GateInput, JudgeData, gate  # noqa: E402


def t_gate_dropped() -> None:
    r = gate(
        GateInput(
            baseline={"a": 1.0, "b": 0.0, "c": 0.0},
            current={"a": 1.0, "b": 1.0},
            history={"a": [1, 1], "b": [0, 1]},
            judge=None,
        )
    )
    eq(r.passed, False)
    ok(
        any("消失" in b or "删" in b for b in r.blockers),
        "基线样本消失了却没拦",
    )


test("★ 闸一：样本消失了要拦（删样本能让任何跑分变好看）", t_gate_dropped)


def t_gate_judge() -> None:
    paired = [PairedVerdict(ab="A", ba="B", len_a=200, len_b=100) for _ in range(30)]
    r = gate(
        GateInput(
            baseline={"a": 1.0, "b": 1.0},
            current={"a": 1.0, "b": 1.0},
            history={"a": [1, 0], "b": [0, 1]},
            judge=JudgeData(
                judge_labels=[v.ab for v in paired],
                human_labels=["B" if i % 4 == 0 else "A" for i in range(30)],
                paired=paired,
                runs=[["A"] * 30 for _ in range(3)],
            ),
        )
    )
    eq(r.passed, False)
    ok(any("judge" in b for b in r.blockers))


test("闸二：judge 没过体检要拦，且这一道在跑分之前", t_gate_judge)


def t_gate_broken() -> None:
    before = {f"c{i}": (1.0 if i < 70 else 0.0) for i in range(100)}
    current = dict(before)
    for i in range(70, 82):
        current[f"c{i}"] = 1.0
    for i in range(10):
        current[f"c{i}"] = 0.0
    r = gate(
        GateInput(
            baseline=before,
            current=current,
            history={k: [0, 1, 0, 1] for k in before},
            judge=None,
        )
    )
    assert r.diff is not None
    ok(r.diff.delta > 0, "这个例子净值是涨的")
    ok(
        any("弄坏" in m for m in [*r.blockers, *r.warnings]),
        "弄坏了 10 条却没进报告 —— 净值把它藏起来了",
    )


test("★ 闸三：净值涨了但弄坏了样本，也要出现在报告里", t_gate_broken)


def t_gate_comparisons() -> None:
    r = gate(
        GateInput(
            baseline={"a": 1.0},
            current={"a": 1.0},
            history={"a": [0, 1]},
            judge=None,
            comparisons=7,
        )
    )
    ok(
        any("指标" in w for w in r.warnings),
        "看了 7 个指标却没提醒 —— 假阳性概率已经 30%",
    )


test("闸五：比了太多指标要提醒（查的是你的行为，不是数据）", t_gate_comparisons)


def t_gate_clean() -> None:
    before = {f"c{i}": (1.0 if i < 70 else 0.0) for i in range(100)}
    current = {f"c{i}": (1.0 if i < 85 else 0.0) for i in range(100)}
    r = gate(
        GateInput(
            baseline=before,
            current=current,
            history={k: [0, 1, 0, 1] for k in before},
            judge=None,
        )
    )
    eq(r.passed, True, f"干净的改进被拦了：{' / '.join(r.blockers)}")


test("干净的 PR 应该放行", t_gate_clean)

# ─────────────────────────────────────────────────────────

print(f"\n{'─' * 66}")
if not failures:
    print(f"\033[32m全部通过（{passed}）\033[0m")
    print("\n★ 接着跑 uv run python -m l12.regress —— 把这些零件接成一道会让 CI 变红的门。")
else:
    print(f"\033[32m通过 {passed}\033[0m，\033[31m失败 {len(failures)}\033[0m：")
    for f in failures:
        print(f"\033[31m  · {f}\033[0m")
    sys.exit(1)
