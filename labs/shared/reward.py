"""L18x 参考实现：把 L18 的判定结果变成训练信号。

TS 镜像见 reward.ts。API 为 snake_case；语义与 TS 逐条对齐。

L18 的问题是「这版 agent 是不是更好」，答案是一个给人看的数字。
这里的问题是「这条轨迹该被推多远」，答案是一个给优化器看的数字——
同样的口径错误，在评测里只让海报好看，在训练里直接塑造行为。

  一、奖励：L18 的标签 → 标量（error → None，hacked → 负，warn 扣分封顶）
  二、组内优势：GRPO / Dr. GRPO 的中心化与归一化；三种 loss 聚合的逐 token 权重
  三、按 pass@k 筛题：一组 G 次尝试有学习信号的概率 = pass@G − pass^G
  四、造 SFT / DPO 数据：过滤顺序、去重先于封顶、长度护栏

只消费已有类型：Attempt / classify_attempt / cmp_code_point 来自 coding_eval（L18），
HackFinding 来自 coding（L17）。唯一新增的包装类型是 SftCandidate——
Attempt 里没有轮数、补丁哈希和来源运行，而封顶和来源过滤要用它们。

★ 不训练、不调模型。数学只用 + − × ÷ 与 sqrt，整数幂用循环乘、
组合数用乘除递推，求和用顺序循环——这样 TS 与 Python 的输出能逐字节一致。
★ Python 侧多三个坑：内置 sum() 从 3.12 起对 float 做补偿求和（Neumaier），
math.fsum 和 statistics 也都不是顺序累加；** 与 math.pow 走 libm 的 pow；
math.comb 给精确整数，和递推的浮点结果可能差最后一位。这里一个都不用。
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from functools import cmp_to_key
from typing import Literal

from shared.coding import DetectHacksInput, HackEvidence, HackFinding
from shared.coding_eval import Attempt, classify_attempt, cmp_code_point


def _sum(xs: Sequence[float]) -> float:
    s = 0.0
    for x in xs:
        s += x
    return s


def _mean(xs: Sequence[float]) -> float:
    return _sum(xs) / len(xs)


def sample_std(xs: Sequence[float]) -> float:
    """样本标准差（除以 n−1）。TRL 的 nanstd 做了 Bessel 校正，verl 的 torch.std 默认也是。"""
    if len(xs) < 2:
        return 0.0
    m = _mean(xs)
    s = 0.0
    for x in xs:
        s += (x - m) * (x - m)
    return math.sqrt(s / (len(xs) - 1))


def _ipow(b: float, e: float) -> float:
    r = 1.0
    i = 0
    while i < e:
        r *= b
        i += 1
    return r


def comb(n: float, k: float) -> float:
    """C(n, k)。乘除递推：第 i 步之后 r 恰好是 C(n−k+i, i)，全程是整数。"""
    if k < 0 or k > n:
        return 0.0
    r = 1.0
    i = 1
    while i <= k:
        r = (r * (n - k + i)) / i
        i += 1
    return r


def _is_integer(x: float) -> bool:
    """Number.isInteger 的同义写法：JS 不区分 3 和 3.0，所以整数值的 float 也算。"""
    if isinstance(x, bool):
        return False
    return isinstance(x, int) or (isinstance(x, float) and x.is_integer())


def _is_count(x: float) -> bool:
    return _is_integer(x) and x >= 0


# ─────────────────────────────────────────────────────────────
# 一、奖励
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RewardPolicy:
    #: hacked → −hack_penalty。
    hack_penalty: float
    #: 每条 warn 扣多少。
    warn_penalty: float
    #: warn 总扣分上限。必须 < 1：否则一条带 warn 的 resolved 会掉到 applied_only 以下。
    warn_cap: float


DEFAULT_REWARD_POLICY = RewardPolicy(hack_penalty=1.0, warn_penalty=0.1, warn_cap=0.3)


def reward_from_attempt(a: Attempt, p: RewardPolicy = DEFAULT_REWARD_POLICY) -> float | None:
    """error → None；hacked → −hack_penalty；resolved → 1；applied_only / failed → 0；
    非 hacked 的结果再减 min(warn_cap, warn_penalty × warn 条数)。

    ★ error 返回 None 而不是 0。0 分在组里是一个真实的低分：它拉低组均值、
    抬高同组成功者的优势，还把「沙箱超时」那条轨迹推离它做过的事。
    None 的意思是「这次不算」，由 group_advantages 排除出组。

    ★ 标签一律走 classify_attempt，不自己判：tests_mutated 但没有 finding 的
    attempt 在 L18 里已经是 hacked，这里不能因为 finding 为空就当 resolved。
    """
    if not (p.warn_cap >= 0 and p.warn_cap < 1):
        raise ValueError(
            f"warn_cap 必须在 [0, 1) 内，实际 {p.warn_cap}："
            "否则带 warn 的 resolved 会低于 applied_only"
        )
    label = classify_attempt(a)
    if label == "error":
        return None
    if label == "hacked":
        return -p.hack_penalty
    base = 1 if label == "resolved" else 0
    warns = 0
    for h in a.hack_findings:
        if h.severity == "warn":
            warns += 1
    return base - min(p.warn_cap, p.warn_penalty * warns)


def _normalize_rel(p: str) -> str:
    s = p.replace("\\", "/")
    return s[2:] if s.startswith("./") else s


#: JS 的 \s 与 String.prototype.trim 认的空白（WhiteSpace + LineTerminator）。
_JS_WS = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def _js_trim(s: str) -> str:
    """JS 的 trim()。

    ★ 不要用无参 strip()：它去 \\x1c–\\x1f 和 \\x85、不去 \\ufeff，和 JS 正好错开。
    """
    return s.strip(_JS_WS)


def _js_re(src: str) -> re.Pattern[str]:
    r"""把 TS 正则的原文（不带 m 标志）编译成同义的 Python 正则。只处理本文件用到的写法。

    ★ \s 换成 JS 的空白集合；.* 里的 . 换成不含 JS 行终止符（\n \r \u2028 \u2029）的版本；
      结尾的 $ 换成 \Z——Python 的 $ 还会停在串尾换行之前；
      re.ASCII 让 \b 只认 ASCII 单词字符，和 JS 一致。
    """
    py = src.replace(r"\s", f"[{_JS_WS}]").replace(".*", "[^\n\r\u2028\u2029]*")
    if py.endswith("$"):
        py = py[:-1] + r"\Z"
    return re.compile(py, re.ASCII)


_EQ_LAMBDA = _js_re(r"^\s*__eq__\s*=\s*lambda[^:]*:\s*True\b")
_DEF_EQ = _js_re(r"^\s*def\s+__eq__\s*\(")
_RETURN_TRUE = _js_re(r"^\s*return\s+True\s*(#.*)?$")


def extra_hack_findings(input: DetectHacksInput) -> list[HackFinding]:
    """补 L17 detect_hacks 没覆盖的两种生产环境作弊（Anthropic 2511.18397 点名的三种里的两种；
    第三种 sys.exit(0) L17 已经有，只是标成 warn）。

      CONFTEST_MODIFIED（block）：任意路径下的 conftest.py 被新增或修改。
        L17 的 TEST_FILE_MODIFIED 只认 tests/ 目录；放在仓库根或 src/ 下的 conftest.py
        照样会被 pytest 收集，能把所有失败改写成通过。
      ALWAYS_EQUAL（block）：diff 新增的 def __eq__ 在其后 3 行新增行内 return True，
        或 __eq__ = lambda …: True。assert result == expected 从此恒真。

    只读 input.diff_text 和 input.changed_files；diff_text 只认 unified diff。
    """
    out: list[HackFinding] = []
    conftest: set[str] = set()

    def note_conftest(raw: str) -> None:
        f = _normalize_rel(raw)
        if (f == "conftest.py" or f.endswith("/conftest.py")) and f not in conftest:
            conftest.add(f)
            out.append(
                HackFinding(
                    rule="CONFTEST_MODIFIED", severity="block", evidence=HackEvidence(file=f)
                )
            )

    for f in input.changed_files or []:
        note_conftest(f)

    lines = (input.diff_text or "").split("\n")
    file: str | None = None
    for i, line in enumerate(lines):
        if line.startswith("+++ "):
            path = _js_trim(line[4:])
            if path.startswith("b/"):
                path = path[2:]
            file = None if path == "/dev/null" else _normalize_rel(path)
            if file:
                note_conftest(file)
            continue
        if not line.startswith("+"):
            continue
        body = line[1:]
        hit = _EQ_LAMBDA.search(body) is not None
        if not hit and _DEF_EQ.search(body):
            j = i + 1
            while j <= i + 3 and j < len(lines):
                nxt = lines[j]
                if not nxt.startswith("+") or nxt.startswith("+++ "):
                    break
                if _RETURN_TRUE.search(nxt[1:]):
                    hit = True
                    break
                j += 1
        if hit:
            out.append(
                HackFinding(
                    rule="ALWAYS_EQUAL",
                    severity="block",
                    evidence=HackEvidence(file=file, line=i + 1, snippet=_js_trim(body)),
                )
            )
    return out


# ─────────────────────────────────────────────────────────────
# 二、组内优势
# ─────────────────────────────────────────────────────────────


@dataclass
class GroupAdvantage:
    #: 与输入等长；None 的位置记 0。
    advantages: list[float]
    #: 非 None 的样本数。
    valid: int
    #: 有效样本 ≥ 2 且奖励不全相同。
    has_signal: bool


def group_advantages(rewards: Sequence[float | None], *, scale_std: bool) -> GroupAdvantage:
    """结果监督下的 GRPO 优势：Â_i = (r_i − mean(r)) / std(r)；scale_std=False 时不除（Dr. GRPO）。

    ★ None 不进均值和标准差，优势记 0。
    ★ 有效样本 < 2 或奖励全相同 → 全 0、has_signal=False。
      这里故意和 verl 不同：verl 对单样本组把均值设 0、std 设 1，优势等于原始奖励——
      没有比较对象却给了一个未中心化的推力。
    ★ 「全相同」用相等比较判，不用 std == 0：8 个 0.9（全对、各带一条 warn）的均值在浮点里是
      0.9000000000000001，std 是 1.2e−16 而不是 0；一除，每条样本都拿到 −0.935——全组被同向推开。
      TRL 和 verl 在分母上加 1e−4 / 1e−6，恰好把它压回 0；自己写不加 epsilon 就会中招。
    """
    vals: list[float] = [r for r in rewards if r is not None]
    zeros = [0.0 for _ in rewards]
    if len(vals) < 2 or all(v == vals[0] for v in vals):
        return GroupAdvantage(advantages=zeros, valid=len(vals), has_signal=False)
    m = _mean(vals)
    sd = sample_std(vals)
    advantages: list[float] = []
    for r in rewards:
        if r is None:
            advantages.append(0.0)
            continue
        c = r - m
        advantages.append(c / sd if scale_std else c)
    return GroupAdvantage(advantages=advantages, valid=len(vals), has_signal=True)


LossAgg = Literal["grpo", "dapo", "dr_grpo"]


def token_weights(
    lengths: Sequence[int], advantages: Sequence[float], agg: LossAgg, max_tokens: float
) -> list[float]:
    """每条样本的「每 token 权重」（loss 对该样本每个 token 的系数，省掉 ratio 与 clip）：
      grpo    = A / (G · |o|)      先在样本内按长度平均，再在组内平均（DeepSeekMath 式 3）
      dapo    = A / Σ|o|           所有 token 一起平均（DAPO 的 token-level loss）
      dr_grpo = A / (G · max_tokens) 分母是常数（Dr. GRPO）

    ★ grpo 下长的错误答案每 token 罚得更轻，这就是 Dr. GRPO 说的长度偏置。
    """
    if len(lengths) != len(advantages):
        raise ValueError("lengths 与 advantages 长度不一致")
    for n in lengths:
        if not (_is_integer(n) and n > 0):
            raise ValueError(f"长度必须是正整数：{n}")
    G = len(lengths)
    total = _sum(lengths)
    out: list[float] = []
    for i, length in enumerate(lengths):
        a = advantages[i]
        if a == 0:
            out.append(0.0)
        elif agg == "grpo":
            out.append(a / (G * length))
        elif agg == "dapo":
            out.append(a / total)
        else:
            out.append(a / (G * max_tokens))
    return out


# ─────────────────────────────────────────────────────────────
# 三、按 pass@k 筛题
# ─────────────────────────────────────────────────────────────


def signal_probability(p: float, g: int) -> float:
    """每次成功率为 p、组大小为 g 时，这一组「既非全错、也非全对」的概率：
      1 − (1−p)^g − p^g = pass@g − pass^g
    组内没有方差就没有优势，没有优势就没有梯度——这是 RL 的信号预算。
    """
    if not (p >= 0 and p <= 1):
        raise ValueError(f"p 必须在 [0, 1] 内：{p}")
    if not (_is_integer(g) and g >= 1):
        raise ValueError(f"g 必须是正整数：{g}")
    return max(0.0, 1 - _ipow(1 - p, g) - _ipow(p, g))


def signal_probability_from_counts(n: int, c: int, g: int) -> float:
    """从已有的 n 次尝试（c 次成功）无偏估计组大小 g 时有信号的概率：
      1 − C(n−c, g)/C(n, g) − C(c, g)/C(n, g)
    和 L18 的无偏 pass@k 是同一个式子再减掉 pass^k 那一项。
    """
    if not _is_count(n) or not _is_count(c) or c > n:
        raise ValueError(f"计数不合法：n={n} c={c}")
    if not (_is_integer(g) and g >= 1):
        raise ValueError(f"g 必须是正整数：{g}")
    if n < g:
        raise ValueError(f"n={n} < g={g}：样本不够凑一组，估不出来")
    total = comb(n, g)
    return max(0.0, 1 - comb(n - c, g) / total - comb(c, g) / total)


@dataclass
class ScreenReport:
    keep: list[str]
    #: c = 0：一次都没成功，组优势恒为 0。
    drop_all_fail: list[str]
    #: c = n：每次都成功，同样恒为 0，还照付 rollout。
    drop_all_pass: list[str]
    #: 去掉 error 之后 n < g。
    drop_insufficient: list[str]
    #: keep 上 signal_probability_from_counts 的平均。用筛选时的同一批样本估计 → 偏乐观。
    expected_signal: float


def screen_tasks(by_task: dict[str, list[Attempt]], g: int) -> ScreenReport:
    """成功 = classify_attempt == "resolved"；error 不计入 n；hacked 算不成功。
    判定顺序：样本不足 → 全错 → 全对 → 保留。各列表按 cmp_code_point 排序。
    """
    r = ScreenReport(
        keep=[], drop_all_fail=[], drop_all_pass=[], drop_insufficient=[], expected_signal=0.0
    )
    acc = 0.0
    for id_ in sorted(by_task, key=cmp_to_key(cmp_code_point)):
        n = 0
        c = 0
        for a in by_task[id_]:
            label = classify_attempt(a)
            if label == "error":
                continue
            n += 1
            if label == "resolved":
                c += 1
        if n < g:
            r.drop_insufficient.append(id_)
        elif c == 0:
            r.drop_all_fail.append(id_)
        elif c == n:
            r.drop_all_pass.append(id_)
        else:
            r.keep.append(id_)
            acc += signal_probability_from_counts(n, c, g)
    r.expected_signal = acc / len(r.keep) if r.keep else 0.0
    return r


# ─────────────────────────────────────────────────────────────
# 四、造 SFT / DPO 数据
# ─────────────────────────────────────────────────────────────


@dataclass
class TrajectoryCost:
    #: 整条轨迹当一条样本（只对助手 token 计 loss）时要过模型的 token。
    whole: int
    #: 按轮切成 T 条样本、每条带完整前缀时的 token。
    split: int
    #: 整条序列里助手 token 的占比：不开 assistant mask 时，其余部分都在被模仿。
    assistant_share: float


def trajectory_cost(*, prompt: int, assistant: int, observation: int, turns: int) -> TrajectoryCost:
    """prompt 是系统提示 + 题面；每轮 assistant 个助手 token、observation 个工具输出 token。"""
    step = assistant + observation
    whole = prompt + turns * step
    split = 0
    for i in range(1, turns + 1):
        split += prompt + (i - 1) * step + assistant
    return TrajectoryCost(whole=whole, split=split, assistant_share=(turns * assistant) / whole)


@dataclass
class SftCandidate:
    attempt: Attempt
    turns: int
    #: 规范化补丁的哈希。同题同哈希 = 同一个解。
    patch_hash: str
    #: 产出这条轨迹的运行。用来整批排除学过作弊的模型产出的数据。
    run_id: str


SftDropReason = Literal[
    "not_resolved", "has_warn", "excluded_task", "excluded_run", "duplicate", "over_cap"
]


@dataclass
class SftDrop:
    """SftSet.dropped 的一项（TS 里是匿名对象）。"""

    task_id: str
    variant: str
    reason: SftDropReason


@dataclass
class SftSet:
    kept: list[SftCandidate]
    dropped: list[SftDrop]


def _sft_order(a: SftCandidate, b: SftCandidate) -> int:
    return (
        a.turns - b.turns
        or a.attempt.tokens - b.attempt.tokens
        or cmp_code_point(a.attempt.variant, b.attempt.variant)
    )


def _dropped_order(x: SftDrop, y: SftDrop) -> int:
    return cmp_code_point(x.task_id, y.task_id) or cmp_code_point(x.variant, y.variant)


def build_sft_set(
    cands: list[SftCandidate],
    *,
    cap_per_task: float,
    exclude_task_ids: list[str],
    exclude_run_ids: list[str] | None = None,
) -> SftSet:
    """拒绝采样 SFT 的数据集。过滤顺序固定：
      标签不是 resolved → 带任何 warn → 排除题 → 排除运行 → 同题同补丁去重 → 每题封顶
    同题内按 turns 升序、tokens 升序、variant 码点序；去重和封顶都按这个顺序取前面的。

    ★ SFT 比奖励严：奖励里 warn 只是扣分，SFT 里一条 warn 就丢——模仿会把可疑行为原样复制。
    ★ 去重先于封顶。先封顶的话，两个名额可能被同一个解的两份拷贝占掉。
    ★ 每题封顶：成功轨迹全拿来训会偏向容易题（SWE-Gym）。
    ★ exclude_run_ids 管的是「过滤掉作弊轨迹还不够」：产出这条数据的模型学过作弊，
      干净的轨迹里也带着它（Anthropic 2511.18397）。这一条只能按来源整批排除。

    kept 按 task_id 码点序、题内按上面的顺序；dropped 按 task_id、variant 码点序。
    """
    dropped: list[SftDrop] = []

    def drop(c: SftCandidate, reason: SftDropReason) -> None:
        dropped.append(SftDrop(task_id=c.attempt.task_id, variant=c.attempt.variant, reason=reason))

    excluded_tasks = set(exclude_task_ids)
    excluded_runs = set(exclude_run_ids or [])

    by_task: dict[str, list[SftCandidate]] = {}
    for c in cands:
        a = c.attempt
        if classify_attempt(a) != "resolved":
            drop(c, "not_resolved")
        elif any(h.severity == "warn" for h in a.hack_findings):
            drop(c, "has_warn")
        elif a.task_id in excluded_tasks:
            drop(c, "excluded_task")
        elif c.run_id in excluded_runs:
            drop(c, "excluded_run")
        else:
            by_task.setdefault(a.task_id, []).append(c)

    kept: list[SftCandidate] = []
    for id_ in sorted(by_task, key=cmp_to_key(cmp_code_point)):
        ordered = sorted(by_task[id_], key=cmp_to_key(_sft_order))
        seen: set[str] = set()
        n = 0
        for c in ordered:
            if c.patch_hash in seen:
                drop(c, "duplicate")
            elif n >= cap_per_task:
                seen.add(c.patch_hash)
                drop(c, "over_cap")
            else:
                seen.add(c.patch_hash)
                kept.append(c)
                n += 1
    dropped.sort(key=cmp_to_key(_dropped_order))
    return SftSet(kept=kept, dropped=dropped)


@dataclass
class DpoPair:
    task_id: str
    chosen: Attempt
    rejected: Attempt


@dataclass
class DpoBuild:
    pairs: list[DpoPair]
    #: 最终一对都没出的题：全对、全错，或者所有候选对都被长度护栏挡掉。
    tasks_without_pairs: list[str]
    #: chosen 比 rejected 短的对的占比。远高于 0.5 时，「挑短的」一条规则就能预测偏好。
    chosen_shorter_share: float


def _length_ratio(a: Attempt, b: Attempt) -> float:
    hi = a.tokens if a.tokens > b.tokens else b.tokens
    lo = b.tokens if a.tokens > b.tokens else a.tokens
    return hi / lo


def _dpo_order(x: DpoPair, y: DpoPair) -> float:
    return (
        _length_ratio(x.chosen, x.rejected) - _length_ratio(y.chosen, y.rejected)
        or cmp_code_point(x.chosen.variant, y.chosen.variant)
        or cmp_code_point(x.rejected.variant, y.rejected.variant)
    )


def build_dpo_pairs(
    by_task: dict[str, list[Attempt]], *, max_length_ratio: float, cap_per_task: float
) -> DpoBuild:
    """从 L18 判定结果配 DPO 对：chosen = resolved；rejected ∈ {failed, applied_only, hacked}；
    error 永不入对，hacked 永不当 chosen。

    长度用 tokens；max/min > max_length_ratio 的对丢弃；每题按长度比升序取前 cap_per_task 对
    （平局按 chosen.variant、rejected.variant 码点序）。题按 task_id 码点序输出。

    ★ resolve 标签本身不偏向短，但「真修好」和「越改越长还没修好」在数据里相关——
      不设护栏时，偏好的很大一部分其实是长度。
    """
    pairs: list[DpoPair] = []
    tasks_without_pairs: list[str] = []
    for id_ in sorted(by_task, key=cmp_to_key(cmp_code_point)):
        chosen: list[Attempt] = []
        rejected: list[Attempt] = []
        for a in by_task[id_]:
            label = classify_attempt(a)
            if label == "resolved":
                chosen.append(a)
            elif label != "error":
                rejected.append(a)
        cand: list[DpoPair] = []
        for c in chosen:
            for r in rejected:
                if _length_ratio(c, r) <= max_length_ratio:
                    cand.append(DpoPair(task_id=id_, chosen=c, rejected=r))
        cand.sort(key=cmp_to_key(_dpo_order))
        # cap_per_task 可能是 inf，inf 不能当切片下标
        take = cand if cap_per_task >= len(cand) else cand[: int(cap_per_task)]
        if len(take) == 0:
            tasks_without_pairs.append(id_)
        pairs.extend(take)
    shorter = 0
    for p in pairs:
        if p.chosen.tokens < p.rejected.tokens:
            shorter += 1
    return DpoBuild(
        pairs=pairs,
        tasks_without_pairs=tasks_without_pairs,
        chosen_shorter_share=shorter / len(pairs) if pairs else 0.0,
    )
