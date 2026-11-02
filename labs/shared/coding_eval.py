"""Capstone 评测层：证明「这版 coding agent 确实更好」。

TS 镜像见 codingEval.ts。API 为 snake_case；语义与 TS 逐条对齐。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from shared.coding import HackFinding
from shared.evals import DiffResult, Interval, bootstrap_ci, compare_runs

Difficulty = Literal["easy", "medium", "hard"]
AttemptLabel = Literal["resolved", "applied_only", "failed", "hacked", "error"]


@dataclass
class TaskInstance:
    id: str
    difficulty: Difficulty
    fail_to_pass: list[str]
    pass_to_pass: list[str]
    repo_pin: str
    contaminated: bool = False


@dataclass
class TaskSetReport:
    ok: bool
    n: int
    by_difficulty: dict[str, int]
    gaps: list[str]
    contaminated_ids: list[str]


def validate_task_set(tasks: list[TaskInstance]) -> TaskSetReport:
    gaps: list[str] = []
    seen: set[str] = set()
    by_difficulty: dict[str, int] = {"easy": 0, "medium": 0, "hard": 0}
    contaminated_ids: list[str] = []

    if len(tasks) == 0:
        gaps.append("任务集为空")

    for t in tasks:
        if not t.id or t.id.strip() == "":
            gaps.append("存在空 id")
            continue
        if t.id in seen:
            gaps.append(f"重复 id：{t.id}")
        seen.add(t.id)

        if t.difficulty not in by_difficulty:
            gaps.append(f"{t.id}：未知 difficulty")
        else:
            by_difficulty[t.difficulty] += 1

        if not t.fail_to_pass:
            gaps.append(f"{t.id}：缺 failToPass（没有「修前必红」的测试，无法判定 resolve）")
        if t.pass_to_pass is None:
            gaps.append(f"{t.id}：passToPass 未定义（应为数组，可为空）")
        if not t.repo_pin or t.repo_pin.strip() == "":
            gaps.append(f"{t.id}：未钉 repoPin")
        if t.contaminated:
            contaminated_ids.append(t.id)

    for d in ("easy", "medium", "hard"):
        if by_difficulty[d] == 0 and len(tasks) > 0:
            gaps.append(f"分层 {d}：0 条（★ 这个难度在评测集里不存在）")

    return TaskSetReport(
        ok=len(gaps) == 0,
        n=len(tasks),
        by_difficulty=by_difficulty,
        gaps=gaps,
        contaminated_ids=contaminated_ids,
    )


def primary_tasks(tasks: list[TaskInstance]) -> list[TaskInstance]:
    return [t for t in tasks if not t.contaminated]


@dataclass
class Attempt:
    task_id: str
    variant: str
    patch_applied: bool
    fail_to_pass_green: bool
    pass_to_pass_green: bool
    tests_mutated: bool
    hack_findings: list[HackFinding] = field(default_factory=list)
    errored: bool = False
    error_reason: str | None = None
    tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0


def classify_attempt(a: Attempt) -> AttemptLabel:
    if a.errored:
        return "error"
    blocked = any(h.severity == "block" for h in a.hack_findings)
    if blocked or a.tests_mutated:
        return "hacked"
    if (
        a.patch_applied
        and a.fail_to_pass_green
        and a.pass_to_pass_green
        and not a.tests_mutated
    ):
        return "resolved"
    if a.patch_applied:
        return "applied_only"
    return "failed"


def is_resolved(a: Attempt) -> bool:
    return classify_attempt(a) == "resolved"


@dataclass
class RateReport:
    hits: int
    n: int
    rate: float
    ci: Interval
    label: str


def _wilson(hits: int, n: int, z: float = 1.96) -> Interval:
    if n <= 0:
        return Interval(lo=0.0, hi=1.0)
    p = hits / n
    denom = 1 + (z * z) / n
    centre = p + (z * z) / (2 * n)
    margin = z * ((p * (1 - p) + (z * z) / (4 * n)) / n) ** 0.5
    lo = max(0.0, (centre - margin) / denom)
    hi = min(1.0, (centre + margin) / denom)
    return Interval(lo=lo, hi=hi)


def _rate(hits: int, n: int, label: str) -> RateReport:
    return RateReport(
        hits=hits,
        n=n,
        rate=(hits / n if n else 0.0),
        ci=_wilson(hits, n),
        label=label,
    )


def apply_rate(attempts: list[Attempt]) -> RateReport:
    n = len(attempts)
    hits = sum(1 for a in attempts if a.patch_applied and not a.errored)
    return _rate(hits, n, "apply")


def resolve_rate(attempts: list[Attempt]) -> RateReport:
    usable = [a for a in attempts if classify_attempt(a) != "error"]
    n = len(usable)
    hits = sum(1 for a in usable if is_resolved(a))
    return _rate(hits, n, "resolve")


def pass_at_k(by_task: dict[str, list[Attempt]], k: int) -> RateReport:
    ids = list(by_task.keys())
    hits = 0
    eligible = [i for i in ids if len(by_task[i]) >= k]
    for i in eligible:
        trials = by_task[i][:k]
        if any(is_resolved(t) for t in trials):
            hits += 1
    return _rate(hits, len(eligible), f"pass@{k}")


def pass_hat_k(by_task: dict[str, list[Attempt]], k: int) -> RateReport:
    ids = list(by_task.keys())
    hits = 0
    eligible = [i for i in ids if len(by_task[i]) >= k]
    for i in eligible:
        trials = by_task[i][:k]
        if all(is_resolved(t) for t in trials):
            hits += 1
    return _rate(hits, len(eligible), f"pass^{k}")


@dataclass
class RateSpectrum:
    apply: RateReport
    resolve: RateReport
    naive_including_hacks: RateReport
    fail_to_pass_only: RateReport


def rate_spectrum(attempts: list[Attempt]) -> RateSpectrum:
    n = len(attempts)
    hack_hits = sum(
        1 for a in attempts if a.fail_to_pass_green or classify_attempt(a) == "hacked"
    )
    f2p_hits = sum(1 for a in attempts if a.fail_to_pass_green)
    return RateSpectrum(
        apply=apply_rate(attempts),
        resolve=resolve_rate(attempts),
        naive_including_hacks=RateReport(
            hits=hack_hits,
            n=n,
            rate=(hack_hits / n if n else 0.0),
            ci=_wilson(hack_hits, n),
            label="naive+hacks",
        ),
        fail_to_pass_only=RateReport(
            hits=f2p_hits,
            n=n,
            rate=(f2p_hits / n if n else 0.0),
            ci=_wilson(f2p_hits, n),
            label="f2p-only",
        ),
    )


@dataclass
class CostBucket:
    lo: float
    hi: float
    n: int
    resolve_rate: float
    mean_cost: float
    mean_tokens: float


def cost_curve(attempts: list[Attempt], bucket_count: int = 4) -> list[CostBucket]:
    usable = [a for a in attempts if not a.errored]
    usable.sort(key=lambda a: a.cost_usd)
    if not usable:
        return []
    q = max(1, len(usable) // bucket_count)
    out: list[CostBucket] = []
    for i in range(bucket_count):
        start = i * q
        end = len(usable) if i == bucket_count - 1 else min(len(usable), (i + 1) * q)
        if start >= len(usable) or start >= end:
            break
        slice_ = usable[start:end]
        lo = slice_[0].cost_usd
        hi = float("inf") if i == bucket_count - 1 else slice_[-1].cost_usd
        hits = sum(1 for a in slice_ if is_resolved(a))
        mean_cost = sum(a.cost_usd for a in slice_) / len(slice_)
        mean_tokens = sum(a.tokens for a in slice_) / len(slice_)
        out.append(
            CostBucket(
                lo=lo,
                hi=hi,
                n=len(slice_),
                resolve_rate=hits / len(slice_),
                mean_cost=mean_cost,
                mean_tokens=mean_tokens,
            )
        )
    return out


@dataclass
class EfficiencyPoint:
    variant: str
    resolve_rate: float
    mean_cost: float
    resolves_per_dollar: float | None


def efficiency(attempts: list[Attempt]) -> EfficiencyPoint:
    r = resolve_rate(attempts)
    spend = sum(a.cost_usd for a in attempts)
    hits = sum(1 for a in attempts if is_resolved(a))
    variant = attempts[0].variant if attempts else ""
    return EfficiencyPoint(
        variant=variant,
        resolve_rate=r.rate,
        mean_cost=(spend / len(attempts) if attempts else 0.0),
        resolves_per_dollar=(hits / spend if spend > 0 else None),
    )


@dataclass
class AblationRow:
    config: str
    resolve_rate: float
    ci: Interval
    mean_cost: float
    delta_vs_baseline: float
    decisive: bool
    n: int


def ablation_table(by_config: dict[str, list[Attempt]], baseline: str) -> list[AblationRow]:
    if baseline not in by_config:
        raise ValueError(f"baseline config 不存在：{baseline}")
    base = by_config[baseline]
    base_rate = resolve_rate(base).rate
    rows: list[AblationRow] = []
    for config, attempts in by_config.items():
        r = resolve_rate(attempts)
        scores = [1 if is_resolved(a) else 0 for a in attempts]
        base_scores = [1 if is_resolved(a) else 0 for a in base]
        n = min(len(scores), len(base_scores))
        diffs = [scores[i] - base_scores[i] for i in range(n)]
        if config == baseline:
            ci = Interval(lo=0.0, hi=0.0)
        elif n > 0:
            ci = bootstrap_ci(diffs, seed=42)
        else:
            ci = Interval(lo=0.0, hi=0.0)
        delta = r.rate - base_rate
        rows.append(
            AblationRow(
                config=config,
                resolve_rate=r.rate,
                ci=r.ci,
                mean_cost=(sum(a.cost_usd for a in attempts) / len(attempts) if attempts else 0.0),
                delta_vs_baseline=delta,
                decisive=True if config == baseline else (ci.lo > 0 or ci.hi < 0),
                n=len(attempts),
            )
        )
    # ★ 码点序（与 TS cmpCodePoint 一致；不用 locale-aware 排序）
    rows.sort(key=lambda row: row.config)
    return rows


def cmp_code_point(a: str, b: str) -> int:
    if a < b:
        return -1
    if a > b:
        return 1
    return 0


def fmt_fixed(x: float, digits: int) -> str:
    """双语言一致的定点格式化。bench 和 blocker 里所有小数都走它。

    ★ f"{x:.3f}" 平局取偶：0.0625 → "0.062"、2.5 → "2"。TS 的 toFixed 对精确值
    四舍五入、平局远离零，给 "0.063" 和 "3"。Decimal(x) 就是 float 的精确值，
    ROUND_HALF_UP 在 decimal 里的意思正是「远离零」，所以这里逐字节复现 toFixed。
    -0 记作 "0"：toFixed 本来就这样，f-string 会印 "-0"。
    """
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        x = 0.0
    q = Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    return f"{q:f}"


@dataclass
class PairABResult:
    diff: DiffResult
    only_a: list[str]
    only_b: list[str]
    both: list[str]
    neither: list[str]
    unpaired_delta: float


def resolved_by_task(attempts: list[Attempt]) -> dict[str, float]:
    out: dict[str, float] = {}
    for a in attempts:
        if a.task_id in out:
            continue
        out[a.task_id] = 1.0 if is_resolved(a) else 0.0
    return out


def paired_ab(a: list[Attempt], b: list[Attempt], *, seed: int = 42) -> PairABResult:
    map_a = resolved_by_task(a)
    map_b = resolved_by_task(b)
    diff = compare_runs(map_a, map_b, seed=seed)
    ids = [i for i in map_a if i in map_b]
    only_a: list[str] = []
    only_b: list[str] = []
    both: list[str] = []
    neither: list[str] = []
    for i in ids:
        ra = map_a[i] == 1
        rb = map_b[i] == 1
        if ra and rb:
            both.append(i)
        elif ra and not rb:
            only_a.append(i)
        elif (not ra) and rb:
            only_b.append(i)
        else:
            neither.append(i)
    vals_b = list(map_b.values())
    vals_a = list(map_a.values())
    mean_b = sum(vals_b) / len(vals_b) if vals_b else 0.0
    mean_a = sum(vals_a) / len(vals_a) if vals_a else 0.0
    return PairABResult(
        diff=diff,
        only_a=only_a,
        only_b=only_b,
        both=both,
        neither=neither,
        unpaired_delta=mean_b - mean_a,
    )


GateMode = Literal["regress", "claim"]


@dataclass
class CodingGateResult:
    pass_: bool
    mode: GateMode
    claimable: bool
    blockers: list[str]
    warnings: list[str]
    task_set: TaskSetReport
    spectrum_baseline: RateSpectrum
    spectrum_candidate: RateSpectrum
    ab: PairABResult


def coding_gate(
    *,
    tasks: list[TaskInstance],
    baseline: list[Attempt],
    candidate: list[Attempt],
    mode: GateMode = "regress",
) -> CodingGateResult:
    blockers: list[str] = []
    warnings: list[str] = []
    task_set = validate_task_set(tasks)
    primary = {t.id for t in primary_tasks(tasks)}

    if not task_set.ok:
        blockers.append(f"任务集不可用：{task_set.gaps[0]}")
    if task_set.contaminated_ids:
        leaked = [
            a
            for a in baseline + candidate
            if a.task_id in task_set.contaminated_ids
        ]
        if any(is_resolved(a) for a in leaked):
            warnings.append(
                f"污染样本 {','.join(task_set.contaminated_ids)} 上有 resolve——勿写入主指标"
            )

    base_prim = [a for a in baseline if a.task_id in primary]
    cand_prim = [a for a in candidate if a.task_id in primary]

    # dict 保插入顺序，对齐 TS 的 Set；set 的迭代顺序随 PYTHONHASHSEED 变
    base_ids = dict.fromkeys(a.task_id for a in base_prim)
    cand_ids = dict.fromkeys(a.task_id for a in cand_prim)
    for i in base_ids:
        if i not in cand_ids:
            blockers.append(f"候选缺少任务 {i}（样本集被换过）")
    for i in cand_ids:
        if i not in base_ids:
            blockers.append(f"候选多出任务 {i}（样本集被换过）")

    hacked = [a for a in cand_prim if classify_attempt(a) == "hacked"]
    if hacked:
        blockers.append(f"候选有 {len(hacked)} 次 hacked/testsMutated（L17 检测器）")

    ab = paired_ab(base_prim, cand_prim)
    if len(ab.only_a) >= 3:
        sample = ",".join(ab.only_a[:5])
        blockers.append(f"弄坏 {len(ab.only_a)} 个已通过任务（{sample}…）——换了一批 bug")

    spectrum_baseline = rate_spectrum(base_prim)
    spectrum_candidate = rate_spectrum(cand_prim)

    if ab.diff.significant and ab.diff.ci.hi < 0:
        blockers.append(
            f"resolve 显著低于基线（成对 CI [{fmt_fixed(ab.diff.ci.lo, 3)}, "
            f"{fmt_fixed(ab.diff.ci.hi, 3)}]）"
        )

    rose_nonsig = (
        spectrum_candidate.resolve.rate > spectrum_baseline.resolve.rate
        and not ab.diff.significant
    )
    if mode == "claim" and rose_nonsig:
        blockers.append(
            f"resolve 点估计上升但不显著（成对 CI [{fmt_fixed(ab.diff.ci.lo, 3)}, "
            f"{fmt_fixed(ab.diff.ci.hi, 3)}] 跨 0）"
            "——不可宣称更好"
        )
    elif mode == "regress" and rose_nonsig:
        warnings.append(
            "resolve 点估计上升但不显著——regress 放行；若要写「更好」请改用 mode=claim"
        )

    if (
        spectrum_candidate.apply.rate > spectrum_baseline.apply.rate + 1e-9
        and spectrum_candidate.resolve.rate <= spectrum_baseline.resolve.rate + 1e-9
    ):
        warnings.append("apply↑ 而 resolve 未↑——不要只报 apply rate")

    pass_ = len(blockers) == 0
    claimable = (
        mode == "claim" and pass_ and ab.diff.significant and ab.diff.ci.lo > 0
    )

    return CodingGateResult(
        pass_=pass_,
        mode=mode,
        claimable=claimable,
        blockers=blockers,
        warnings=warnings,
        task_set=task_set,
        spectrum_baseline=spectrum_baseline,
        spectrum_candidate=spectrum_candidate,
        ab=ab,
    )
