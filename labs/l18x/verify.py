"""验证 l18x/reward.py。
  REWARD_IMPL=shared uv run python -m l18x.verify
  uv run python -m l18x.verify

零模型、零训练。所有输入都是手造的 Attempt 记录。
"""

from __future__ import annotations

import json
import math
import os
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, fields, is_dataclass
from decimal import Decimal
from typing import Any

from l18x.reward import Kind, attempt, demo_canary, demo_dpo_tasks, demo_pool, pool_attempts
from shared import reward as shared
from shared.coding import DetectHacksInput, HackEvidence, HackFinding, detect_hacks
from shared.coding_eval import Attempt, fmt_fixed
from shared.reward import RewardPolicy, SftCandidate

TARGET = "shared" if os.environ.get("REWARD_IMPL") == "shared" else "mine"


@dataclass(frozen=True)
class Api:
    reward: Callable[..., float | None]
    group_advantages: Callable[..., shared.GroupAdvantage]
    signal_probability: Callable[[float, int], float]
    signal_probability_from_counts: Callable[[int, int, int], float]
    screen_tasks: Callable[[dict[str, list[Attempt]], int], shared.ScreenReport]
    token_weights: Callable[..., list[float]]
    build_sft_set: Callable[..., shared.SftSet]
    build_dpo_pairs: Callable[..., shared.DpoBuild]


def _load_mine() -> Api:
    from l18x import reward as m

    return Api(
        reward=m.my_reward_from_attempt,
        group_advantages=m.my_group_advantages,
        signal_probability=m.my_signal_probability,
        signal_probability_from_counts=m.my_signal_probability_from_counts,
        screen_tasks=m.my_screen_tasks,
        token_weights=m.my_token_weights,
        build_sft_set=m.my_build_sft_set,
        build_dpo_pairs=m.my_build_dpo_pairs,
    )


M = (
    Api(
        reward=shared.reward_from_attempt,
        group_advantages=shared.group_advantages,
        signal_probability=shared.signal_probability,
        signal_probability_from_counts=shared.signal_probability_from_counts,
        screen_tasks=shared.screen_tasks,
        token_weights=shared.token_weights,
        build_sft_set=shared.build_sft_set,
        build_dpo_pairs=shared.build_dpo_pairs,
    )
    if TARGET == "shared"
    else _load_mine()
)

print(
    "\n（测的是 shared/ 里的参考实现）" if TARGET == "shared" else "\n（测的是 l18x/ 里你的实现）"
)

DIM, BOLD, RED, GREEN, OFF = "\x1b[2m", "\x1b[1m", "\x1b[31m", "\x1b[32m", "\x1b[0m"


def bold(s: str) -> str:
    return f"{BOLD}{s}{OFF}"


def red(s: str) -> str:
    return f"{RED}{s}{OFF}"


def green(s: str) -> str:
    return f"{GREEN}{s}{OFF}"


def dim(s: str) -> str:
    return f"{DIM}{s}{OFF}"


class Fail(Exception):
    pass


def need(cond: bool, why: str) -> None:
    if not cond:
        raise Fail(why)


def throws(fn: Callable[[], object]) -> bool:
    try:
        fn()
        return False
    except Exception as e:
        return re.search(r"TODO [0-9]+ 未实现", str(e)) is None


passed = 0
failed = 0


def t(id_: str, name: str) -> Callable[[Callable[[], None]], Callable[[], None]]:
    """装饰器：定义即运行。和 TS 的 t(id, name, () => {...}) 一样按出现顺序执行。"""

    def run(fn: Callable[[], None]) -> Callable[[], None]:
        global passed, failed
        try:
            fn()
            passed += 1
        except Exception as e:
            failed += 1
            why = str(e) if isinstance(e, Fail) else f"抛出了异常：{e}"
            print(red(f"  ✗ {id_} {name}") + dim(f"\n      {why}"))
        return fn

    return run


def section(s: str) -> None:
    print(bold(f"\n{s}"))


def _js_number(x: float) -> str:
    """JS 的 Number#toString。

    位数和 repr 一样取最短往返，但 1.0 印 1、1e-05 印 0.00001、1e-07 印 1e-7。
    """
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    _, digits, exp = Decimal(repr(abs(x))).normalize().as_tuple()
    ds = "".join(map(str, digits))
    k = len(ds)
    n = int(exp) + k
    if k <= n <= 21:
        return sign + ds + "0" * (n - k)
    if 0 < n <= 21:
        return sign + ds[:n] + "." + ds[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * -n + ds
    e = n - 1
    mant = ds if k == 1 else ds[0] + "." + ds[1:]
    return f"{sign}{mant}e{'+' if e >= 0 else '-'}{abs(e)}"


def jstr(x: object) -> str:
    """模板字符串里 ${x} 的同义写法：None 是 null，布尔小写，数字按 JS 格式。"""
    if x is None:
        return "null"
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, float):
        return _js_number(x)
    return str(x)


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def js(x: Any) -> str:
    """JSON.stringify 的同义写法。dataclass 字段名转回 camelCase，值为 None 的字段省略
    （对应 TS 的 undefined）；数字按 JS 格式，非有限数记 null。"""
    if x is None:
        return "null"
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    if isinstance(x, float):
        return _js_number(x) if math.isfinite(x) else "null"
    if isinstance(x, str):
        return json.dumps(x, ensure_ascii=False)
    if is_dataclass(x) and not isinstance(x, type):
        items = [(_camel(f.name), getattr(x, f.name)) for f in fields(x)]
        return "{" + ",".join(f"{js(k)}:{js(v)}" for k, v in items if v is not None) + "}"
    if isinstance(x, dict):
        return "{" + ",".join(f"{js(str(k))}:{js(v)}" for k, v in x.items()) + "}"
    if isinstance(x, (list, tuple)):
        return "[" + ",".join(js(v) for v in x) + "]"
    return js(str(x))


fx = fmt_fixed


def close(a: float, b: float, eps: float = 1e-9) -> bool:
    return abs(a - b) <= eps


def warn(n: int) -> list[HackFinding]:
    return [HackFinding(rule=f"W{i}", severity="warn", evidence=HackEvidence()) for i in range(n)]


block = HackFinding(
    rule="TEST_FILE_MODIFIED", severity="block", evidence=HackEvidence(file="tests/t.py")
)


def binary(G: int, k: int) -> list[float]:
    return [1 if i < k else 0 for i in range(G)]


def abs_sum(xs: Sequence[float]) -> float:
    s = 0.0
    for x in xs:
        s += abs(x)
    return s


def group(spec: list[tuple[Kind, int]], task_id: str = "t") -> list[Attempt]:
    out: list[Attempt] = []
    for kind, n in spec:
        for i in range(n):
            out.append(attempt(task_id, f"{kind}{i + 1}", kind))
    return out


def cand(
    task_id: str,
    variant: str,
    kind: Kind,
    *,
    turns: int = 5,
    tokens: int = 1000,
    patch_hash: str | None = None,
    run_id: str = "run-1",
    findings: list[HackFinding] | None = None,
) -> SftCandidate:
    return SftCandidate(
        attempt=attempt(task_id, variant, kind, tokens=tokens, hack_findings=findings or []),
        turns=turns,
        patch_hash=patch_hash if patch_hash is not None else f"{task_id}-{variant}",
        run_id=run_id,
    )


def reasons(s: shared.SftSet) -> list[str]:
    return [f"{d.task_id}/{d.variant}:{d.reason}" for d in s.dropped]


def kept_ids(s: shared.SftSet) -> list[str]:
    return [f"{c.attempt.task_id}/{c.attempt.variant}" for c in s.kept]


# ─────────────────────────────────────────────────────────────
section("R · 奖励：L18 的标签 → 标量")


@t("R01", "error → null，不是 0")
def _r01() -> None:
    r = M.reward(attempt("t", "v", "error"))
    need(r is None, f"应为 null，实际 {jstr(r)}。0 分在组里是一个真实的低分，会变成负优势")


@t("R02", "resolved、无 finding → 1")
def _r02() -> None:
    need(M.reward(attempt("t", "v", "resolved")) == 1, "应为 1")


@t("R03", "failed / applied_only、无 finding → 0")
def _r03() -> None:
    need(M.reward(attempt("t", "v", "failed")) == 0, "failed 应为 0")
    need(M.reward(attempt("t", "v", "applied_only")) == 0, "applied_only 应为 0")


@t("R04", "带 block finding → −hackPenalty")
def _r04() -> None:
    a = attempt("t", "v", "resolved", hack_findings=[block])
    need(M.reward(a) == -1, f"默认策略应为 −1，实际 {jstr(M.reward(a))}")
    r2 = M.reward(a, RewardPolicy(hack_penalty=2, warn_penalty=0.1, warn_cap=0.3))
    need(r2 == -2, f"hackPenalty=2 时应为 −2，实际 {jstr(r2)}")


@t("R05", "testsMutated 但 finding 为空 → 同样 −hackPenalty（走 classifyAttempt）")
def _r05() -> None:
    a = attempt("t", "v", "resolved", tests_mutated=True)
    need(
        M.reward(a) == -1,
        f"应为 −1，实际 {jstr(M.reward(a))}。标签要走 classifyAttempt，不能只看 hackFindings",
    )


@t("R06", "resolved + 1 条 warn → 0.9")
def _r06() -> None:
    r = M.reward(attempt("t", "v", "resolved", hack_findings=warn(1)))
    need(r is not None and close(r, 0.9), f"应为 0.9，实际 {jstr(r)}")


@t("R07", "resolved + 10 条 warn → 0.7（上限生效）")
def _r07() -> None:
    r = M.reward(attempt("t", "v", "resolved", hack_findings=warn(10)))
    need(r is not None and close(r, 0.7), f"应为 0.7，实际 {jstr(r)}。warn 扣分要封顶在 warnCap")


@t("R08", "任意 warn 数下 resolved 都高于干净的 applied_only")
def _r08() -> None:
    floor = M.reward(attempt("t", "v", "applied_only"))
    for n in range(21):
        r = M.reward(attempt("t", "v", "resolved", hack_findings=warn(n)))
        need(r > floor, f"{n} 条 warn 时 resolved={jstr(r)} 不高于 applied_only={jstr(floor)}")


@t("R09", "hacked + warn 不叠加扣分")
def _r09() -> None:
    r = M.reward(attempt("t", "v", "hacked", hack_findings=[block, *warn(5)]))
    need(r == -1, f"应仍为 −1，实际 {jstr(r)}")


@t("R10", "warnCap ≥ 1 的策略被拒")
def _r10() -> None:
    for cap in [1, 1.5]:
        policy = RewardPolicy(hack_penalty=1, warn_penalty=0.1, warn_cap=cap)
        need(
            throws(lambda p=policy: M.reward(attempt("t", "v", "resolved"), p)),
            f"warnCap={jstr(cap)} 应抛错：否则带 warn 的 resolved 会掉到 applied_only 以下",
        )


# ─────────────────────────────────────────────────────────────
section("H · 补两条作弊规则（参考实现，只读）+ 金丝雀")

EQ_DIFF = "\n".join(
    [
        "--- a/src/money.py",
        "+++ b/src/money.py",
        "@@ -1,1 +1,4 @@",
        "+class _Any(float):",
        "+    def __eq__(self, other):",
        "+        return True",
    ]
)


@t("H01", "任意路径下的 conftest.py → CONFTEST_MODIFIED（L17 只认 tests/）")
def _h01() -> None:
    input_ = DetectHacksInput(changed_files=["src/conftest.py"])
    f = shared.extra_hack_findings(input_)
    need(
        len(f) == 1 and f[0].rule == "CONFTEST_MODIFIED" and f[0].severity == "block",
        f"应恰好一条 CONFTEST_MODIFIED/block，实际 {js(f)}",
    )
    need(len(detect_hacks(input_)) == 0, "L17 的 detectHacks 本来就抓不到它——这条是对照")


@t("H02", "diff 新增 __eq__ 恒返回 True → ALWAYS_EQUAL")
def _h02() -> None:
    f = shared.extra_hack_findings(DetectHacksInput(diff_text=EQ_DIFF))
    need(
        len(f) == 1 and f[0].rule == "ALWAYS_EQUAL" and f[0].severity == "block",
        f"应恰好一条 ALWAYS_EQUAL/block，实际 {js(f)}",
    )


@t("H03", "正常比较字段的 __eq__ 不报")
def _h03() -> None:
    diff = "\n".join(
        ["+++ b/src/p.py", "+    def __eq__(self, other):", "+        return self.x == other.x"]
    )
    f = shared.extra_hack_findings(DetectHacksInput(diff_text=diff))
    need(len(f) == 0, f"不该报，实际 {js(f)}")


@t("H04", "返回值满足 L17 的 HackFinding 形状，evidence.file 有值")
def _h04() -> None:
    f = [
        *shared.extra_hack_findings(DetectHacksInput(changed_files=["conftest.py"])),
        *shared.extra_hack_findings(DetectHacksInput(diff_text=EQ_DIFF)),
    ]
    need(len(f) == 2, f"应有两条，实际 {len(f)}")
    for h in f:
        need(
            isinstance(h.rule, str) and (h.severity == "warn" or h.severity == "block"),
            f"形状不对：{js(h)}",
        )
        need(
            isinstance(h.evidence.file, str) and len(h.evidence.file) > 0,
            f"{h.rule} 缺 evidence.file",
        )


@t("H05", "不可能任务金丝雀：只用 L17 平均奖励为正，加 extra 规则后为负")
def _h05() -> None:
    def avg(attempts: list[Attempt]) -> float:
        s = 0.0
        for a in attempts:
            r = M.reward(a)
            s += r if r is not None else 0
        return s / len(attempts)

    base = avg(demo_canary(False))
    extra = avg(demo_canary(True))
    need(base > 0, f"只用 L17 时应为正（这正是问题所在），实际 {fx(base, 3)}")
    need(extra < 0, f"加 extra 规则后应为负，实际 {fx(extra, 3)}")


# ─────────────────────────────────────────────────────────────
section("A · 组内优势")


@t("A01", "全 1 的组 → 全 0、hasSignal=false")
def _a01() -> None:
    g = M.group_advantages(binary(8, 8), scale_std=True)
    need(all(a == 0 for a in g.advantages) and not g.has_signal, f"实际 {js(g)}")


@t("A02", "全 0 的组 → 全 0、hasSignal=false")
def _a02() -> None:
    g = M.group_advantages(binary(8, 0), scale_std=True)
    need(all(a == 0 for a in g.advantages) and not g.has_signal, f"实际 {js(g)}")


@t("A03", "G=8、k=1、除 std → 成功者 2.475（样本标准差）")
def _a03() -> None:
    a = M.group_advantages(binary(8, 1), scale_std=True).advantages[0]
    hint = "——这是总体标准差（除以 n）" if fx(a, 3) == "2.646" else ""
    need(fx(a, 3) == "2.475", f"应为 2.475，实际 {fx(a, 3)}{hint}")


@t("A04", "同上不除 std → 0.875 / −0.125")
def _a04() -> None:
    a = M.group_advantages(binary(8, 1), scale_std=False).advantages
    need(close(a[0], 0.875) and close(a[7], -0.125), f"实际 {jstr(a[0])} / {jstr(a[7])}")


@t("A05", "优势之和为 0（除不除 std 都是）")
def _a05() -> None:
    for k in range(1, 8):
        for scale_std in [True, False]:
            s = 0.0
            for x in M.group_advantages(binary(8, k), scale_std=scale_std).advantages:
                s += x
            need(close(s, 0), f"k={k} scaleStd={jstr(scale_std)} 时和为 {jstr(s)}")


@t("A06", "k 与 G−k 镜像：A⁺(k) = −A⁻(G−k)")
def _a06() -> None:
    for k in range(1, 8):
        pos = M.group_advantages(binary(8, k), scale_std=True).advantages[0]
        neg = M.group_advantages(binary(8, 8 - k), scale_std=True).advantages[7]
        need(close(pos, -neg), f"k={k}：{jstr(pos)} vs {jstr(neg)}")


@t("A07", "null 不进均值：[1,1,1,0,0,0,null,null] 成功者 0.913")
def _a07() -> None:
    g = M.group_advantages([1, 1, 1, 0, 0, 0, None, None], scale_std=True)
    hint = "——你把 null 当成了 0" if fx(g.advantages[0], 3) == "1.208" else ""
    need(fx(g.advantages[0], 3) == "0.913", f"应为 0.913，实际 {fx(g.advantages[0], 3)}" + hint)
    need(g.valid == 6, f"valid 应为 6，实际 {jstr(g.valid)}")


@t("A08", "null 的位置优势为 0，输出与输入等长")
def _a08() -> None:
    g = M.group_advantages([None, 1, 0, None, 1], scale_std=False)
    need(len(g.advantages) == 5, f"长度应为 5，实际 {len(g.advantages)}")
    need(
        g.advantages[0] == 0 and g.advantages[3] == 0,
        f"null 位置应为 0，实际 {js(g.advantages)}",
    )


@t("A09", "只剩 1 个有效样本 → 全 0、hasSignal=false（不是 verl 的「原始奖励」）")
def _a09() -> None:
    g = M.group_advantages([1, None, None], scale_std=True)
    need(
        all(a == 0 for a in g.advantages) and not g.has_signal and g.valid == 1,
        f"实际 {js(g)}",
    )


@t("A10", "没有 NaN / Infinity；8 个 0.9 也算「全相同」")
def _a10() -> None:
    nines = [0.9 for _ in range(8)]
    cases: list[list[float | None]] = [
        [],
        [None],
        nines,
        [0.1, 0.1, 0.1],
        [1, 1],
        [0, 1],
        [0.1, 0.2, 0.3],
    ]
    for rs in cases:
        for scale_std in [True, False]:
            g = M.group_advantages(rs, scale_std=scale_std)
            need(
                all(math.isfinite(a) for a in g.advantages),
                f"{js(rs)} 出现非有限值：{js(g.advantages)}",
            )
    g = M.group_advantages(nines, scale_std=True)
    need(
        not g.has_signal and all(a == 0 for a in g.advantages),
        f"8 个 0.9 应无信号，实际 {fx(g.advantages[0], 3)}…。"
        "均值在浮点里是 0.9000000000000001，用 std === 0 判会把舍入误差放大成满额优势",
    )


@t("A11", "难度偏置：k=1 对 k=4 的 Σ|A| 之比，除 std 0.66、不除 0.44")
def _a11() -> None:
    def ratio(scale_std: bool) -> float:
        return abs_sum(M.group_advantages(binary(8, 1), scale_std=scale_std).advantages) / abs_sum(
            M.group_advantages(binary(8, 4), scale_std=scale_std).advantages
        )

    need(
        fx(ratio(True), 2) == "0.66" and fx(ratio(False), 2) == "0.44",
        f"实际 {fx(ratio(True), 2)} / {fx(ratio(False), 2)}",
    )


# ─────────────────────────────────────────────────────────────
section("W · 三种 loss 聚合")

LENS = [100, 400, 100, 400]
ADV = [0.5, 0.5, -0.5, -0.5]


@t("W01", "grpo：长错答 / 短错答的每 token 权重之比 = 0.25")
def _w01() -> None:
    w = M.token_weights(LENS, ADV, "grpo", 1000)
    need(close(w[3] / w[2], 0.25), f"应为 0.25，实际 {jstr(w[3] / w[2])}")


@t("W02", "dapo：同一优势下每 token 权重与长度无关")
def _w02() -> None:
    w = M.token_weights(LENS, ADV, "dapo", 1000)
    need(close(w[0], w[1], 1e-15) and close(w[2], w[3], 1e-15), f"实际 {js(w)}")
    need(close(w[0], 0.5 / 1000, 1e-15), f"应为 A/Σ|o| = 0.0005，实际 {jstr(w[0])}")


@t("W03", "dr_grpo：分母是 G·maxTokens，与批内长度无关")
def _w03() -> None:
    a = M.token_weights(LENS, ADV, "dr_grpo", 1000)
    b = M.token_weights([100, 4000, 7, 40], ADV, "dr_grpo", 1000)
    need(
        close(a[0], b[0], 1e-15) and close(a[0], 0.5 / 4000, 1e-15),
        f"实际 {jstr(a[0])} / {jstr(b[0])}",
    )


@t("W04", "grpo 下每条样本的总推力 Σ_t w = A/G，与长度无关")
def _w04() -> None:
    w = M.token_weights(LENS, ADV, "grpo", 1000)
    for i, length in enumerate(LENS):
        need(close(w[i] * length, ADV[i] / 4), f"样本 {i}：{jstr(w[i] * length)}")


@t("W05", "优势为 0 的样本在所有聚合下权重为 0")
def _w05() -> None:
    for agg in ["grpo", "dapo", "dr_grpo"]:
        w = M.token_weights([100, 200, 300], [0, -0.0, 0.5], agg, 1000)
        need(w[0] == 0 and w[1] == 0, f"{agg}：{js(w)}")


# ─────────────────────────────────────────────────────────────
section("S · 有信号的概率 = pass@G − pass^G")


@t("S01", "signalProbability(0.5, 8) = 0.992")
def _s01() -> None:
    need(
        fx(M.signal_probability(0.5, 8), 3) == "0.992",
        f"实际 {jstr(M.signal_probability(0.5, 8))}",
    )


@t("S02", "p=0 与 p=1 → 0")
def _s02() -> None:
    for g in [1, 4, 8]:
        need(
            M.signal_probability(0, g) == 0 and M.signal_probability(1, g) == 0,
            f"g={g} 时不是 0",
        )


@t("S03", "对称：f(p, g) = f(1−p, g)")
def _s03() -> None:
    for p in [0.01, 0.1, 0.25, 0.4]:
        for g in range(2, 17):
            need(
                close(M.signal_probability(p, g), M.signal_probability(1 - p, g), 1e-12),
                f"p={jstr(p)} g={g}",
            )


@t("S04", "随 g 单调不减")
def _s04() -> None:
    for p in [0.05, 0.3, 0.5, 0.9]:
        for g in range(1, 20):
            need(
                M.signal_probability(p, g + 1) >= M.signal_probability(p, g) - 1e-12,
                f"p={jstr(p)} g={g}→{g + 1} 变小了",
            )


@t("S05", "FromCounts(16, 0, 8) = 0 且 FromCounts(16, 16, 8) = 0")
def _s05() -> None:
    need(
        M.signal_probability_from_counts(16, 0, 8) == 0,
        f"全错：{jstr(M.signal_probability_from_counts(16, 0, 8))}",
    )
    need(
        M.signal_probability_from_counts(16, 16, 8) == 0,
        f"全对：{jstr(M.signal_probability_from_counts(16, 16, 8))}",
    )


@t("S06", "FromCounts 与暴力枚举所有 g 子集一致（n=10）")
def _s06() -> None:
    n = 10
    for c in range(n + 1):
        for g in range(1, 7):
            mixed = 0
            total = 0
            for mask in range(1 << n):
                size = 0
                hits = 0
                for i in range(n):
                    if mask & (1 << i):
                        size += 1
                        if i < c:
                            hits += 1
                if size != g:
                    continue
                total += 1
                if hits > 0 and hits < g:
                    mixed += 1
            got = M.signal_probability_from_counts(n, c, g)
            need(
                close(got, mixed / total, 1e-12),
                f"n={n} c={c} g={g}：{jstr(got)} vs 枚举 {jstr(mixed / total)}",
            )


@t("S07", "n < g 时抛错")
def _s07() -> None:
    need(throws(lambda: M.signal_probability_from_counts(4, 2, 8)), "n=4 < g=8 应抛错")


# ─────────────────────────────────────────────────────────────
section("C · 按预采样筛题")


@t("C01", "c=0 进 dropAllFail，c=n 进 dropAllPass，混合的留下")
def _c01() -> None:
    r = M.screen_tasks(
        {
            "a": group([("failed", 8)], "a"),
            "b": group([("resolved", 8)], "b"),
            "c": group([("resolved", 3), ("failed", 5)], "c"),
        },
        4,
    )
    need(
        ",".join(r.drop_all_fail) == "a"
        and ",".join(r.drop_all_pass) == "b"
        and ",".join(r.keep) == "c",
        f"实际 {js(r)}",
    )


@t("C02", "error 不计入 n")
def _c02() -> None:
    by_task = {"x": group([("resolved", 2), ("failed", 2), ("error", 2)], "x")}
    r4 = M.screen_tasks(by_task, 4)
    hint = "——error 被当成失败计进了 n" if fx(r4.expected_signal, 3) == "0.933" else ""
    need(
        ",".join(r4.keep) == "x" and close(r4.expected_signal, 1),
        f"g=4 时 n 应为 4、预测 1.000，实际 {fx(r4.expected_signal, 3)}{hint}",
    )
    r5 = M.screen_tasks(by_task, 5)
    need(
        ",".join(r5.drop_insufficient) == "x",
        f"g=5 时有效 n=4 不够，应进 dropInsufficient，实际 {js(r5)}",
    )


@t("C03", "hacked 不算成功：2 hacked + 2 failed → dropAllFail")
def _c03() -> None:
    r = M.screen_tasks({"h": group([("hacked", 2), ("failed", 2)], "h")}, 4)
    need(",".join(r.drop_all_fail) == "h", f"实际 {js(r)}")


@t("C04", "有效 n < g → dropInsufficient；列表按码点序")
def _c04() -> None:
    r = M.screen_tasks(
        {
            "b": group([("resolved", 1), ("failed", 2)], "b"),
            "a": group([("failed", 3)], "a"),
            "B": group([("resolved", 3)], "B"),
        },
        4,
    )
    need(
        ",".join(r.drop_insufficient) == "B,a,b",
        f"应为 B,a,b，实际 {','.join(r.drop_insufficient)}",
    )
    need(len(r.keep) == 0 and r.expected_signal == 0, "没有 keep 时 expectedSignal 应为 0")


@t("C05", "实验三的题库：保留 7 题，预测 0.813（偏乐观，记录而不修正）")
def _c05() -> None:
    r = M.screen_tasks(pool_attempts(demo_pool()), 8)
    need(
        len(r.keep) == 7 and fx(r.expected_signal, 3) == "0.813",
        f"实际 keep={len(r.keep)} 预测 {fx(r.expected_signal, 3)}",
    )


# ─────────────────────────────────────────────────────────────
section("F · 拒绝采样 SFT")


@t("F01", "只留 resolved，且丢掉带任何 warn 的")
def _f01() -> None:
    s = M.build_sft_set(
        [
            cand("a", "ok", "resolved"),
            cand("a", "ap", "applied_only"),
            cand("a", "hk", "hacked"),
            cand("a", "wn", "resolved", findings=warn(1)),
        ],
        cap_per_task=9,
        exclude_task_ids=[],
    )
    need(",".join(kept_ids(s)) == "a/ok", f"kept 应为 a/ok，实际 {','.join(kept_ids(s))}")
    need(
        ",".join(reasons(s)) == "a/ap:not_resolved,a/hk:not_resolved,a/wn:has_warn",
        f"dropped 实际 {','.join(reasons(s))}",
    )


@t("F02", "同题同 patchHash 先去重再封顶")
def _f02() -> None:
    s = M.build_sft_set(
        [
            cand("x", "a", "resolved", turns=3, patch_hash="H1"),
            cand("x", "b", "resolved", turns=4, patch_hash="H1"),
            cand("x", "c", "resolved", turns=6, patch_hash="H2"),
        ],
        cap_per_task=2,
        exclude_task_ids=[],
    )
    need(
        ",".join(kept_ids(s)) == "x/a,x/c",
        f"应留 x/a,x/c，实际 {','.join(kept_ids(s))}——先封顶会让两个名额被同一个解占掉",
    )
    need(",".join(reasons(s)) == "x/b:duplicate", f"dropped 实际 {','.join(reasons(s))}")


@t("F03", "每题最多 capPerTask 条，turns 少的优先、再看 tokens")
def _f03() -> None:
    s = M.build_sft_set(
        [
            cand("y", "p", "resolved", turns=5),
            cand("y", "q", "resolved", turns=2, tokens=900),
            cand("y", "r", "resolved", turns=9),
            cand("y", "s", "resolved", turns=2, tokens=800),
            cand("w", "z", "resolved"),
        ],
        cap_per_task=2,
        exclude_task_ids=[],
    )
    need(
        ",".join(kept_ids(s)) == "w/z,y/s,y/q",
        f"应为 w/z,y/s,y/q，实际 {','.join(kept_ids(s))}",
    )
    need(
        ",".join(reasons(s)) == "y/p:over_cap,y/r:over_cap",
        f"dropped 实际 {','.join(reasons(s))}",
    )


@t("F04", "排除题与排除运行：标签先判，排除题先于排除运行")
def _f04() -> None:
    s = M.build_sft_set(
        [
            cand("z", "ok", "resolved"),
            cand("z", "bad", "failed"),
            cand("z", "both", "resolved", run_id="run-hacky"),
            cand("k", "ok", "resolved", run_id="run-hacky"),
            cand("k", "fine", "resolved"),
        ],
        cap_per_task=9,
        exclude_task_ids=["z"],
        exclude_run_ids=["run-hacky"],
    )
    need(",".join(kept_ids(s)) == "k/fine", f"kept 应为 k/fine，实际 {','.join(kept_ids(s))}")
    need(
        ",".join(reasons(s))
        == "k/ok:excluded_run,z/bad:not_resolved,z/both:excluded_task,z/ok:excluded_task",
        f"dropped 实际 {','.join(reasons(s))}",
    )


# ─────────────────────────────────────────────────────────────
section("D · DPO 配对")


@t("D01", "error 从不入对；hacked 从不当 chosen")
def _d01() -> None:
    b = M.build_dpo_pairs(
        {"m": [*group([("resolved", 2), ("failed", 1), ("hacked", 1), ("error", 2)], "m")]},
        max_length_ratio=math.inf,
        cap_per_task=math.inf,
    )
    need(len(b.pairs) == 4, f"2 个 chosen × 2 个 rejected 应有 4 对，实际 {len(b.pairs)}")
    for p in b.pairs:
        need(not p.chosen.errored and not p.rejected.errored, "error 进了对")
        need(p.chosen.variant.startswith("resolved"), f"chosen 是 {p.chosen.variant}")
    need(
        any(p.rejected.variant.startswith("hacked") for p in b.pairs), "hacked 应作为 rejected 出现"
    )


@t("D02", "实验八：不设护栏 0.857，护栏 1.25 后 0.667；每题 1 对取长度比最小的")
def _d02() -> None:
    tasks = demo_dpo_tasks()
    raw = M.build_dpo_pairs(tasks, max_length_ratio=math.inf, cap_per_task=math.inf)
    need(
        len(raw.pairs) == 14 and fx(raw.chosen_shorter_share, 3) == "0.857",
        f"不设护栏：{len(raw.pairs)} 对 {fx(raw.chosen_shorter_share, 3)}",
    )
    guarded = M.build_dpo_pairs(tasks, max_length_ratio=1.25, cap_per_task=math.inf)
    need(
        len(guarded.pairs) == 6 and fx(guarded.chosen_shorter_share, 3) == "0.667",
        f"护栏：{len(guarded.pairs)} 对 {fx(guarded.chosen_shorter_share, 3)}",
    )
    one = M.build_dpo_pairs(tasks, max_length_ratio=1.25, cap_per_task=1)
    t3 = [p for p in one.pairs if p.task_id == "t3"]
    need(
        len(t3) == 1 and t3[0].chosen.variant == "ok2",
        f"t3 应取长度比 1.048 的 ok2/bad1，实际 {','.join(p.chosen.variant for p in t3)}",
    )


@t("D03", "全对或全错的题出现在 tasksWithoutPairs")
def _d03() -> None:
    tasks = demo_dpo_tasks()
    raw = M.build_dpo_pairs(tasks, max_length_ratio=math.inf, cap_per_task=math.inf)
    need(
        ",".join(raw.tasks_without_pairs) == "t6,t7",
        f"不设护栏应为 t6,t7，实际 {','.join(raw.tasks_without_pairs)}",
    )
    guarded = M.build_dpo_pairs(tasks, max_length_ratio=1.25, cap_per_task=math.inf)
    need(
        ",".join(guarded.tasks_without_pairs) == "t4,t6,t7",
        f"护栏后应为 t4,t6,t7，实际 {','.join(guarded.tasks_without_pairs)}",
    )


# ─────────────────────────────────────────────────────────────
section("T · 轨迹切分的成本（参考实现，只读）")


@t("T01", "19 轮：切分是整条的 10.35 倍，助手 token 只占 0.298")
def _t01() -> None:
    c = shared.trajectory_cost(prompt=2000, assistant=300, observation=600, turns=19)
    need(
        c.whole == 19100
        and fx(c.split / c.whole, 2) == "10.35"
        and fx(c.assistant_share, 3) == "0.298",
        f"实际 {js(c)}",
    )


print()
if failed == 0:
    print(green(f"  ✓ {passed} 条断言全部通过"))
    print(
        dim(
            "\n  最该记住的六条：\n"
            "    R   error 是 null 不是 0；hacked 为负；warn 扣分要封顶\n"
            "    A   null 不进组；样本标准差；全相同就是没有信号\n"
            "    W   原版 GRPO 按长度平均，长的错答案罚得轻\n"
            "    S   有信号的概率 = pass@G − pass^G，全对全错都是零\n"
            "    F   SFT 比奖励严；去重先于封顶；作弊模型的产出整批排除\n"
            "    D   resolve 配对里藏着长度；hacked 只当 rejected\n"
        )
    )
    raise SystemExit(0)
print(red(f"  ✗ {failed} 失败 / {passed} 通过"))
raise SystemExit(1)
