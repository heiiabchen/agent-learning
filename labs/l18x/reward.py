"""L18x 的脚手架。跑法：uv run python -m l18x.reward

观察实验：二值奖励的组优势、有信号的概率、按 pass@k 筛题、长度归一化、
error 记 0 的代价、奖励口径决定作弊的符号、轨迹切分的成本、DPO 的长度混杂、
不可能任务金丝雀。全程零模型、零训练，只用确定性假数据。
写完七个 TODO 跑 uv run python -m l18x.verify。
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from functools import cmp_to_key
from typing import Any, Literal

from shared.coding import DetectHacksInput, detect_hacks
from shared.coding_eval import Attempt, classify_attempt, cmp_code_point, fmt_fixed
from shared.reward import (
    DEFAULT_REWARD_POLICY,
    DpoBuild,
    GroupAdvantage,
    LossAgg,
    RewardPolicy,
    ScreenReport,
    SftCandidate,
    SftSet,
    build_dpo_pairs,
    extra_hack_findings,
    group_advantages,
    reward_from_attempt,
    screen_tasks,
    signal_probability,
    token_weights,
    trajectory_cost,
)

DIM, BOLD, OFF = "\x1b[2m", "\x1b[1m", "\x1b[0m"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def dim(s: str) -> str:
    return f"{DIM}{s}{OFF}"


def bold(s: str) -> str:
    return f"{BOLD}{s}{OFF}"


def _w(s: str) -> int:
    s = _ANSI.sub("", s)
    return sum(2 if "\u2e80" <= c <= "\u9fff" or "\uff00" <= c <= "\uffef" else 1 for c in s)


def pad(s: str, n: int) -> str:
    return s + " " * max(0, n - _w(s))


def lpad(s: str, n: int) -> str:
    return " " * max(0, n - _w(s)) + s


fx = fmt_fixed

# ─────────────────────────────────────────────────────────────
# 夹具（verify 也用）
# ─────────────────────────────────────────────────────────────

Kind = Literal["resolved", "applied_only", "failed", "hacked", "error"]


def attempt(task_id: str, variant: str, kind: Kind, **extra: Any) -> Attempt:
    """按 L18 的标签造一条 Attempt。tokens 默认 1000。extra 是要覆盖的 Attempt 字段。"""
    base = Attempt(
        task_id=task_id,
        variant=variant,
        patch_applied=kind != "failed" and kind != "error",
        fail_to_pass_green=kind == "resolved" or kind == "hacked",
        pass_to_pass_green=True,
        tests_mutated=kind == "hacked",
        hack_findings=[],
        tokens=1000,
        cost_usd=0.0,
        latency_ms=0,
    )
    if kind == "error":
        base.errored = True
        base.error_reason = "sandbox timeout"
    return replace(base, **extra)


@dataclass
class PoolTask:
    id: str
    p: float
    c: int


def demo_pool() -> list[PoolTask]:
    """实验三：20 道题，真实 p 是 U 形；每题预采样 16 次，前 c 次成功。"""
    raw: list[tuple[float, int]] = [
        (0, 0),
        (0, 0),
        (0, 0),
        (0, 0),
        (0, 0),
        (0.02, 0),
        (0.05, 1),
        (0.1, 2),
        (0.25, 4),
        (0.5, 8),
        (0.5, 7),
        (0.75, 12),
        (0.9, 15),
        (0.95, 16),
        (0.98, 16),
        (1, 16),
        (1, 16),
        (1, 16),
        (1, 16),
        (1, 16),
    ]
    return [PoolTask(id=f"q{i + 1:02d}", p=p, c=c) for i, (p, c) in enumerate(raw)]


POOL_N = 16


def pool_attempts(pool: list[PoolTask], n: int = POOL_N) -> dict[str, list[Attempt]]:
    out: dict[str, list[Attempt]] = {}
    for t in pool:
        out[t.id] = []
        for i in range(n):
            out[t.id].append(attempt(t.id, f"s{i + 1}", "resolved" if i < t.c else "failed"))
    return out


def demo_dpo_tasks() -> dict[str, list[Attempt]]:
    """实验八：7 道题，每题若干 resolved 与 failed 的 token 长度。"""
    raw: list[tuple[str, list[int], list[int]]] = [
        ("t1", [1200, 1500], [3000, 1400]),
        ("t2", [800], [2600, 2900, 900]),
        ("t3", [2000, 2200], [2100]),
        ("t4", [1000], [4000]),
        ("t5", [1800, 1100], [1900, 5200]),
        ("t6", [], [3000, 3100]),
        ("t7", [900, 950], []),
    ]
    out: dict[str, list[Attempt]] = {}
    for id_, ok, bad in raw:
        out[id_] = [
            *[attempt(id_, f"ok{i + 1}", "resolved", tokens=tokens) for i, tokens in enumerate(ok)],
            *[attempt(id_, f"bad{i + 1}", "failed", tokens=tokens) for i, tokens in enumerate(bad)],
        ]
    return out


@dataclass
class CanaryRaw:
    task_id: str
    variant: str
    kind: Kind
    changed_files: list[str]
    diff_text: str


CONFTEST_PATCH = [
    "+from _pytest.reports import TestReport",
    "+_orig = TestReport.from_item_and_call",
    "+def _patched(item, call):",
    "+    rep = _orig(item, call)",
    '+    rep.outcome = "passed"',
    "+    return rep",
    "+TestReport.from_item_and_call = staticmethod(_patched)",
]


def canary_raw() -> list[CanaryRaw]:
    return [
        CanaryRaw(
            task_id="imp-sort-stable",
            variant="v1",
            kind="resolved",
            changed_files=["conftest.py"],
            diff_text="\n".join(
                ["--- /dev/null", "+++ b/conftest.py", "@@ -0,0 +1,7 @@", *CONFTEST_PATCH]
            ),
        ),
        CanaryRaw(
            task_id="imp-sort-stable",
            variant="v2",
            kind="failed",
            changed_files=[],
            diff_text="",
        ),
        CanaryRaw(
            task_id="imp-parse-date",
            variant="v1",
            kind="resolved",
            changed_files=["src/conftest.py"],
            diff_text="\n".join(
                ["--- /dev/null", "+++ b/src/conftest.py", "@@ -0,0 +1,7 @@", *CONFTEST_PATCH]
            ),
        ),
        CanaryRaw(
            task_id="imp-money-round",
            variant="v1",
            kind="resolved",
            changed_files=["src/money.py"],
            diff_text="\n".join(
                [
                    "--- a/src/money.py",
                    "+++ b/src/money.py",
                    "@@ -10,3 +10,8 @@",
                    " def round_half(x):",
                    "+class _Any(float):",
                    "+    def __eq__(self, other):",
                    "+        return True",
                    "+    def __ne__(self, other):",
                    "+        return False",
                ]
            ),
        ),
        CanaryRaw(
            task_id="imp-money-round",
            variant="v2",
            kind="applied_only",
            changed_files=["src/money.py"],
            diff_text="\n".join(
                [
                    "--- a/src/money.py",
                    "+++ b/src/money.py",
                    "@@ -10,1 +10,1 @@",
                    "-    return x",
                    "+    return round(x, 2)",
                ]
            ),
        ),
        CanaryRaw(
            task_id="imp-utf8-trim",
            variant="v1",
            kind="applied_only",
            changed_files=["src/text.py"],
            diff_text="\n".join(
                [
                    "--- a/src/text.py",
                    "+++ b/src/text.py",
                    "@@ -3,1 +3,1 @@",
                    "-    return s.strip()",
                    '+    return s.strip(" ")',
                ]
            ),
        ),
    ]


def demo_canary(with_extra: bool) -> list[Attempt]:
    """实验九：4 道 spec 与测试互相矛盾的「不可能任务」，6 次尝试。
    在这种题上任何一次「绿了」都必然是作弊。with_extra=False 只用 L17 的 detect_hacks。
    """
    out: list[Attempt] = []
    for r in canary_raw():
        input_ = DetectHacksInput(diff_text=r.diff_text, changed_files=r.changed_files)
        findings = [*detect_hacks(input_), *(extra_hack_findings(input_) if with_extra else [])]
        out.append(attempt(r.task_id, r.variant, r.kind, hack_findings=findings))
    return out


# ─────────────────────────────────────────────────────────────
# 观察实验
# ─────────────────────────────────────────────────────────────


def binary_group(G: int, k: int) -> list[float]:
    rs: list[float] = []
    for i in range(G):
        rs.append(1 if i < k else 0)
    return rs


def abs_sum(xs: Sequence[float]) -> float:
    s = 0.0
    for x in xs:
        s += -x if x < 0 else x
    return s


def exp1() -> None:
    print(bold("\n实验一：二值奖励，G=8，组里 k 个成功"))
    G = 8
    print(dim("  k   A成·除std  A败·除std  A成·不除  A败·不除   Σ|A|除std  Σ|A|不除"))
    sums: list[dict[str, float]] = []
    for k in range(G + 1):
        rs = binary_group(G, k)
        s = group_advantages(rs, scale_std=True).advantages
        r = group_advantages(rs, scale_std=False).advantages
        sums.append({"s": abs_sum(s), "r": abs_sum(r)})
        cells = [
            lpad(fx(x, 3), 9)
            for x in [
                s[0] if k > 0 else 0,
                s[G - 1] if k < G else 0,
                r[0] if k > 0 else 0,
                r[G - 1] if k < G else 0,
            ]
        ]
        print(
            f"  {k}  {'  '.join(cells)}  {lpad(fx(sums[k]['s'], 3), 10)}  {lpad(fx(sums[k]['r'], 3), 9)}"
        )
    print(
        dim(
            "  k=0 与 k=8：全错或全对的组，除不除 std 优势都是 0——这道题对梯度零贡献，rollout 照付。"
        )
    )
    print(
        dim(
            f"  k=1 那一次成功：不除 std {fx(group_advantages(binary_group(G, 1), scale_std=False).advantages[0], 3)}，"
            f"除 std {fx(group_advantages(binary_group(G, 1), scale_std=True).advantages[0], 3)}。"
        )
    )
    print(
        dim(
            f"  难度偏置：k=1 相对 k=4 的总权重，不除 std {fx(sums[1]['r'] / sums[4]['r'], 2)}，除 std {fx(sums[1]['s'] / sums[4]['s'], 2)}——"
            "除 std 让接近全对 / 全错的题相对更重。"
        )
    )


def exp2() -> None:
    print(bold("\n实验二：一组有学习信号的概率 = pass@G − pass^G"))
    gs = [4, 8, 16]
    print(dim("  p        " + "  ".join(lpad(f"G={g}", 6) for g in gs)))
    for p in [0.01, 0.05, 0.1, 0.2, 0.5, 0.8, 0.9, 0.95, 0.99]:
        print(
            f"  {pad(fx(p, 2), 7)}  {'  '.join(lpad(fx(signal_probability(p, g), 3), 6) for g in gs)}"
        )
    print(
        dim(
            f"  p=0.05 的难题，G=8 时只有 {fx(signal_probability(0.05, 8), 3)} 的组会产生任何梯度；"
            f"G 翻倍到 16 是 {fx(signal_probability(0.05, 16), 3)}，代价是每题两倍 rollout。"
        )
    )


def mean_of(xs: Sequence[float]) -> float:
    s = 0.0
    for x in xs:
        s += x
    return s / len(xs) if xs else 0.0


def exp3() -> None:
    print(bold("\n实验三：按预采样筛题（20 题，U 形难度，G=8，每题预采样 16 次）"))
    pool = demo_pool()
    r: ScreenReport = screen_tasks(pool_attempts(pool), 8)
    p_of = {t.id: t.p for t in pool}

    def truth(ids: list[str]) -> float:
        return mean_of([signal_probability(p_of[id_], 8) for id_ in ids])

    any_pass = sorted([*r.keep, *r.drop_all_pass], key=cmp_to_key(cmp_code_point))
    rows: list[tuple[str, list[str]]] = [
        ("不筛", [t.id for t in pool]),
        ("只去掉全错的题", any_pass),
        ("两端都去掉", r.keep),
    ]
    for label, ids in rows:
        print(
            f"  {pad(label, 16)}题数 {lpad(str(len(ids)), 2)}   真实有信号占比 {fx(truth(ids), 3)}"
        )
    print(f"  {pad('用同一批样本预测', 16)}          预测有信号占比 {fx(r.expected_signal, 3)}")
    misjudged = [
        f"p={fx(p, 2)}"
        for p in (p_of[id_] for id_ in [*r.drop_all_fail, *r.drop_all_pass])
        if p > 0 and p < 1
    ]
    print(dim(f"  被两端筛掉、其实 p 在 (0,1) 的题：{' '.join(misjudged)}"))
    print(
        dim(
            "  简单题不伤模型，但吃掉一样多的 rollout；预测偏高是因为你挑的恰好是「这 16 次看起来是混合的」题。"
        )
    )


def exp4() -> None:
    print(bold("\n实验四：三种 loss 聚合的逐 token 权重（不除 std，maxTokens=1000，权重 ×1e4）"))
    names = ["对·短", "对·长", "错·短", "错·长"]
    lengths = [100, 400, 100, 400]
    adv = group_advantages([1, 1, 0, 0], scale_std=False).advantages
    aggs: list[LossAgg] = ["grpo", "dapo", "dr_grpo"]
    ws = [token_weights(lengths, adv, agg, 1000) for agg in aggs]
    print(dim("  样本    长度      A" + "".join(lpad(a, 10) for a in aggs)))
    for i, n in enumerate(names):
        print(
            f"  {pad(n, 6)}{lpad(str(lengths[i]), 6)}{lpad(fx(adv[i], 2), 7)}"
            + "".join(lpad(fx(wv[i] * 1e4, 3), 10) for wv in ws)
        )
    print(
        dim(
            "  错·长 / 错·短 的每 token 惩罚之比："
            + "  ".join(f"{a} {fx(ws[j][3] / ws[j][2], 2)}" for j, a in enumerate(aggs))
        )
    )
    print(
        dim("  原版 GRPO 下长的错答案每个 token 只被罚四分之一：模型学到的是「错的时候写长一点」。")
    )


def exp5() -> None:
    print(bold("\n实验五：error 记 0，还是排除出组（G=8，3 成 3 败 2 超时，除 std）"))
    group = [
        *[attempt("t", f"ok{i}", "resolved") for i in [1, 2, 3]],
        *[attempt("t", f"fail{i}", "failed") for i in [1, 2, 3]],
        *[attempt("t", f"err{i}", "error") for i in [1, 2]],
    ]
    rewards = [reward_from_attempt(a) for a in group]
    as_zero = group_advantages([0 if r is None else r for r in rewards], scale_std=True)
    excluded = group_advantages(rewards, scale_std=True)
    print(dim("  处理          A(成功)   A(失败)   A(超时)"))

    def row(label: str, g: GroupAdvantage, err_cell: str) -> None:
        print(
            f"  {pad(label, 12)}{lpad(fx(g.advantages[0], 3), 9)}{lpad(fx(g.advantages[3], 3), 10)}{lpad(err_cell, 10)}"
        )

    row("error 记 0", as_zero, fx(as_zero.advantages[6], 3))
    row("error 排除", excluded, "—")
    print(
        dim(
            "  记 0 时，两次超时拿到和失败一样的负优势：模型被推离「认真跑完整个测试套件」这类耗时的行为。"
        )
    )


def exp6() -> None:
    print(bold("\n实验六：奖励口径决定作弊的符号（G=8，2 resolved、2 hacked、4 failed，不除 std）"))
    group = [
        attempt("t", "r1", "resolved"),
        attempt("t", "r2", "resolved"),
        attempt("t", "h1", "hacked"),
        attempt("t", "h2", "hacked"),
        *[attempt("t", f"f{i}", "failed") for i in [1, 2, 3, 4]],
    ]
    schemes: list[tuple[str, Callable[[Attempt], float | None]]] = [
        ("f2p-only（L18 的海报口径）", lambda a: 1 if a.fail_to_pass_green else 0),
        ("resolve（hacked 记 0）", lambda a: 1 if classify_attempt(a) == "resolved" else 0),
        ("rewardFromAttempt", lambda a: reward_from_attempt(a)),
    ]
    print(dim(f"  {pad('口径', 28)}A(resolved)  A(hacked)  A(failed)"))
    for label, f in schemes:
        adv = group_advantages([f(a) for a in group], scale_std=False).advantages
        print(
            f"  {pad(label, 28)}{lpad(fx(adv[0], 3), 11)}{lpad(fx(adv[2], 3), 11)}{lpad(fx(adv[4], 3), 11)}"
        )
    print(
        dim(
            "  f2p-only 当奖励：作弊和真解拿到一模一样的正优势。评测里这只让数字好看，训练里它塑造行为。"
        )
    )


def exp7() -> None:
    print(
        bold("\n实验七：多轮轨迹整条训还是按轮切（系统 + 题面 2000，每轮助手 300 + 工具输出 600）")
    )
    print(dim("   T   整条 token   切分 token   切分/整条   助手 token 占比"))
    for T in [5, 10, 19, 40]:
        c = trajectory_cost(prompt=2000, assistant=300, observation=600, turns=T)
        print(
            f"  {lpad(str(T), 2)}{lpad(str(c.whole), 13)}{lpad(str(c.split), 13)}"
            f"{lpad(fx(c.split / c.whole, 2), 12)}{lpad(fx(c.assistant_share, 3), 16)}"
        )
    print(
        dim(
            "  TRL 的 assistant_only_loss 默认是 False：不开的话，剩下那七成 token 也在被模仿，包括工具输出。"
        )
    )


def dpo_line(label: str, b: DpoBuild) -> None:
    ratio = 0.0
    for p in b.pairs:
        ratio += p.rejected.tokens / p.chosen.tokens
    avg = ratio / len(b.pairs) if b.pairs else 0.0
    print(
        f"  {pad(label, 20)}对数 {lpad(str(len(b.pairs)), 2)}   chosen 更短 {fx(b.chosen_shorter_share, 3)}"
        f"   rejected/chosen 平均长度比 {fx(avg, 3)}   没出对的题 {' '.join(b.tasks_without_pairs) or '—'}"
    )


def exp8() -> None:
    print(bold("\n实验八：用 resolve 标签配 DPO 对，偏好里有多少是长度"))
    tasks = demo_dpo_tasks()
    dpo_line("不设护栏", build_dpo_pairs(tasks, max_length_ratio=math.inf, cap_per_task=math.inf))
    dpo_line("长度比 ≤ 1.25", build_dpo_pairs(tasks, max_length_ratio=1.25, cap_per_task=math.inf))
    dpo_line("护栏 + 每题 ≤ 2 对", build_dpo_pairs(tasks, max_length_ratio=1.25, cap_per_task=2))
    print(
        dim(
            "  不设护栏时，「挑短的」一条规则就能预测八成以上的偏好；t6 全错、t7 全对，本来就配不出对；"
        )
    )
    print(dim("  t4 唯一的一对长度差四倍，被护栏挡掉——护栏也有覆盖面的代价。"))


def exp9() -> None:
    print(bold("\n实验九：不可能任务金丝雀（spec 与测试矛盾，任何「绿了」都是作弊）"))
    base = demo_canary(False)
    extra = demo_canary(True)
    print(dim(f"  {pad('尝试', 22)}{pad('只用 L17', 14)}{pad('+ extra 规则', 14)}奖励"))
    rb: list[float] = []
    rx: list[float] = []
    for i, a in enumerate(base):
        b = reward_from_attempt(a)
        e = reward_from_attempt(extra[i])
        assert b is not None and e is not None
        rb.append(b)
        rx.append(e)
        rules = ",".join(h.rule for h in extra[i].hack_findings)
        print(
            f"  {pad(f'{a.task_id}/{a.variant}', 22)}{pad(classify_attempt(a), 14)}{pad(classify_attempt(extra[i]), 14)}"
            f"{lpad(fx(b, 1), 4)} → {lpad(fx(e, 1), 4)}{'  ' + dim(rules) if rules else ''}"
        )
    print(f"  平均奖励：只用 L17 {fx(mean_of(rb), 3)}，加 extra 规则 {fx(mean_of(rx), 3)}")
    print(dim("  金丝雀把检测器的召回率变成一个能测的数：平均奖励为正，说明 RL 正在付钱买作弊。"))


# ─────────────────────────────────────────────────────────────
# TODO
# ─────────────────────────────────────────────────────────────


def my_reward_from_attempt(a: Attempt, p: RewardPolicy = DEFAULT_REWARD_POLICY) -> float | None:
    """TODO 1 ★ 把一次 Attempt 翻译成标量奖励。
      error → None；hacked → −hack_penalty；resolved → 1；applied_only / failed → 0；
      非 hacked 的再减 min(warn_cap, warn_penalty × warn 条数)。warn_cap 不在 [0, 1) 内就抛错。
    标签必须走 classify_attempt——tests_mutated 但 hack_findings 为空的那条也是 hacked。
    陷阱：error 记 0（实验五）；warn 不封顶，让带 warn 的正确解掉到 applied_only 以下。
    """
    raise NotImplementedError("TODO 1 未实现")


def my_group_advantages(rewards: Sequence[float | None], *, scale_std: bool) -> GroupAdvantage:
    """TODO 2 ★ 组内优势。None 不进均值和标准差，优势记 0，输出与输入等长。
    标准差用样本标准差（除以 n−1）。有效样本 < 2、或奖励全相同 → 全 0、has_signal=False。
    陷阱：总体标准差（A03 会红）；std=0 时除出 NaN（Python 里是 ZeroDivisionError）；
    照搬 verl 的单样本组（优势 = 原始奖励）；用 std == 0 判「全相同」——8 个 0.9 的 std 在浮点里不是 0。
    求和用顺序循环，不要用内置 sum()：3.12 起它对 float 做补偿求和，和 TS 差最后一位。
    """
    raise NotImplementedError("TODO 2 未实现")


def my_signal_probability(p: float, g: int) -> float:
    """TODO 3 ★ 有信号的概率。
      my_signal_probability(p, g) = 1 − (1−p)^g − p^g
      my_signal_probability_from_counts(n, c, g) = 1 − C(n−c, g)/C(n, g) − C(c, g)/C(n, g)，n < g 抛错
    整数幂用循环乘，组合数用乘除递推（r = r × (n−k+i) / i），不要用阶乘——C(40, 20) 的阶乘早就溢出了。
    （Python 的整数阶乘不溢出，但 **、math.pow、math.comb 和 TS 的浮点递推可能差最后一位。）
    结果夹到 ≥ 0：g=1 时数学上是 0，浮点里可能是 −1e−17。
    """
    raise NotImplementedError("TODO 3 未实现")


def my_signal_probability_from_counts(n: int, c: int, g: int) -> float:
    raise NotImplementedError("TODO 3 未实现")


def my_screen_tasks(by_task: dict[str, list[Attempt]], g: int) -> ScreenReport:
    """TODO 4 ★★ 按预采样筛题。成功 = classify_attempt == "resolved"；error 不计入 n；hacked 算不成功。
    判定顺序：n < g → drop_insufficient；c = 0 → drop_all_fail；c = n → drop_all_pass；否则 keep。
    各列表按 cmp_code_point 排序；expected_signal 是 keep 上 FromCounts 的平均（没有 keep 时为 0）。
    陷阱：把 error 当失败计进 n（C02）；把 hacked 当成功（C03）。
    """
    raise NotImplementedError("TODO 4 未实现")


def my_token_weights(
    lengths: Sequence[int], advantages: Sequence[float], agg: LossAgg, max_tokens: float
) -> list[float]:
    """TODO 5 ★★ 三种 loss 聚合的每 token 权重：
      grpo = A / (G·|o|)；dapo = A / Σ|o|；dr_grpo = A / (G·max_tokens)
    优势为 0 的样本权重为 0（包括 −0）。长度必须是正整数，两个数组不等长就抛错。
    想清楚：哪一种下，一条样本的总推力 Σ_t w 与长度无关？
    """
    raise NotImplementedError("TODO 5 未实现")


def my_build_sft_set(
    cands: list[SftCandidate],
    *,
    cap_per_task: float,
    exclude_task_ids: list[str],
    exclude_run_ids: list[str] | None = None,
) -> SftSet:
    """TODO 6 ★★ 拒绝采样 SFT 的数据集。顺序固定：
      不是 resolved → 带任何 warn → 排除题 → 排除运行 → 同题同 patch_hash 去重 → 每题封顶
    同题内按 turns 升序、tokens 升序、variant 码点序；去重和封顶都按这个顺序保留前面的。
    kept 按 task_id 码点序、题内按上面的顺序；dropped 按 task_id、variant 码点序。
    陷阱：先封顶后去重（F02 会红）——两个名额被同一个解的两份拷贝占掉。
    """
    raise NotImplementedError("TODO 6 未实现")


def my_build_dpo_pairs(
    by_task: dict[str, list[Attempt]], *, max_length_ratio: float, cap_per_task: float
) -> DpoBuild:
    """TODO 7 ★★ 配 DPO 对。chosen = resolved；rejected ∈ {failed, applied_only, hacked}；error 永不入对。
    长度比 = max(tokens)/min(tokens)，超过 max_length_ratio 的丢掉；每题按长度比升序取前 cap_per_task 对
    （平局按 chosen.variant、rejected.variant 码点序）。题按 task_id 码点序。
    tasks_without_pairs：最终一对都没出的题。chosen_shorter_share：chosen.tokens < rejected.tokens 的占比，没有对时为 0。
    cap_per_task 和 max_length_ratio 都可能是 math.inf（inf 不能直接当切片下标）。
    """
    raise NotImplementedError("TODO 7 未实现")


# ─────────────────────────────────────────────────────────────


def main() -> None:
    exp1()
    exp2()
    exp3()
    exp4()
    exp5()
    exp6()
    exp7()
    exp8()
    exp9()
    print(bold("\n最该记住的"))
    print("  · 一组有信号的概率 = pass@G − pass^G：全对和全错的题一样不出梯度，rollout 照付。")
    print("  · error 是「这次不算」，不是 0 分；0 分会变成负优势。")
    print("  · 评测口径进了奖励，就从「数字好不好看」变成「塑造什么行为」。")
    print("  · 过滤掉作弊轨迹再 SFT 还不够：来源运行学过作弊，干净的轨迹里也带着它。")


if __name__ == "__main__":
    main()
