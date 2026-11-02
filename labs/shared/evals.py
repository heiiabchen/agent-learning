"""参考实现：评测。TypeScript 版在 evals.ts。

这一节是整个课程的分水岭，理由很直接：**在它之前你所有的判断都是"我觉得"。**

L03 的 prompt 改法、L06 的压缩策略、L07 的编排模式、L09 的检索配置、
L11 的扇出宽度——每一个都是在两种做法之间选一种，而你到现在为止
没有任何手段判断哪种更好。

而这一节要处理的核心难题不是"怎么打分"，是**怎么不骗自己**。

因为评测这件事有一个很坏的性质：**它产出数字，而数字自带权威。**
一个错的评测比没有评测更糟——没有评测你至少知道自己在猜。

所以这个文件里几乎每个函数都在防同一类事情：

    一致率 85% 听起来很好，实际可能等于零信息
    judge 每次跑结果都一样，听起来很可靠，实际可能是它永远选 A
    成功率涨了 2%，听起来是进步，实际在这个样本量下是噪声
    净涨 2%，听起来是小改进，实际可能修好 10 个又弄坏 8 个

★ Python 这一侧多两件东西，都在文件末尾：
真实项目里这类统计会用 scipy，所以最后有一小节讲**什么时候该换成 scipy**，
以及一个 Python 特有的坑（浮点求和的累积误差）。
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

# ─────────────────────────────────────────────────────────────
# 一、评测集：从生产日志里攒，而不是编
# ─────────────────────────────────────────────────────────────

Outcome = Literal["ok", "wrong", "error", "timeout"]


@dataclass
class LogEntry:
    id: str
    input: str
    #  生产环境实际的结果。用来分层，不是用来当答案。
    outcome: Outcome
    #  任务类型，用来分层。
    kind: str
    #  用了几步工具。复杂度的粗代理。
    steps: int


@dataclass
class SampleResult:
    picked: list[LogEntry]
    #  每个分层实际取到几条。
    coverage: dict[str, int]
    #  ★ 没取够的分层。这是整个函数最重要的返回值。
    #
    #  因为"某个失败模式在评测集里一条都没有"这件事，
    #  不会以任何形式表现出来——你的评测会跑得很干净，
    #  分数会很好看，而那个失败模式在生产上继续发生。
    gaps: list[str] = field(default_factory=list)


def stratified_sample(
    logs: Sequence[LogEntry],
    *,
    strata: Sequence[str],
    per_stratum: int,
    stratify: Callable[[LogEntry], str] | None = None,
) -> SampleResult:
    """分层抽样。

    ★ 为什么不能随机抽：**生产日志是极度不均衡的。**

    一个还算健康的 agent，日志里 90% 以上是成功的正常路径。
    随机抽 150 条，你会拿到 135 条正常路径和一把零星的失败——
    而失败恰恰是你要评测的东西。

    更糟的是这个评测集**会给你一个很高的基线分**（90%+），
    于是任何改进都只能在剩下那 10% 里体现，信噪比极差。
    """
    key_of = stratify or (lambda e: e.outcome)

    buckets: dict[str, list[LogEntry]] = {s: [] for s in strata}
    for e in logs:
        k = key_of(e)
        if k in buckets:
            buckets[k].append(e)

    picked: list[LogEntry] = []
    coverage: dict[str, int] = {}
    gaps: list[str] = []

    for s in strata:
        take = buckets[s][:per_stratum]
        picked.extend(take)
        coverage[s] = len(take)
        if len(take) < per_stratum:
            tail = "（★ 一条都没有——这个失败模式在评测集里不存在）" if not take else ""
            gaps.append(f"{s}：要 {per_stratum} 条，只有 {len(take)} 条{tail}")

    return SampleResult(picked=picked, coverage=coverage, gaps=gaps)


# ─────────────────────────────────────────────────────────────
# 二、断言分层：别用 judge 干正则能干的事
# ─────────────────────────────────────────────────────────────

CheckKind = Literal["exact", "structural", "regex", "judge"]


@dataclass
class Criterion:
    id: str
    #  人话描述这一条要判什么。
    says: str
    #  期望值。有确定答案的填这个。
    expect: str | None = None
    #  要求输出是合法 JSON 且含这些字段。
    fields: list[str] = field(default_factory=list)
    #  要求匹配这个模式。
    pattern: str | None = None
    #  反向断言：要求**不**匹配 pattern。
    #
    #  ★ 这个字段不是可选的锦上添花。"输出里不能出现内部服务名"、
    #  "不能泄露 API key"、"不能出现别的客户的数据"——安全相关的判据
    #  大半是反向的，而把它们写成正向会让断言的含义**正好反过来**，
    #  且测试全绿。
    negate: bool = False
    #  只有真的需要语义判断时才为 True。
    semantic: bool = False


@dataclass
class Routed:
    id: str
    kind: CheckKind
    #  为什么选这个层级。
    why: str


def route_check(c: Criterion) -> Routed:
    """把每条判据路由到**最便宜的够用的**检查方式。

    ★ 这个函数存在的理由是一条很实际的观察：
    **绝大多数人上手评测的第一件事就是写一个 LLM judge，
    而其中大半根本不需要。**

    "输出里有没有引用编号"是正则。"输出是不是合法 JSON 且有 severity 字段"
    是结构检查。"分类对不对"是精确匹配。这三类合起来通常占判据的七八成，
    而它们的共同点是：**确定、免费、不会漂。**

    而 judge 的代价不只是钱：
      · 它自己会错，而且错得有系统性（见下面第四节）
      · 它的输出会随模型版本漂移，于是你的历史分数不可比
      · 它慢，于是你不会想在每次提交时跑

    ★ 判据：**能用确定性断言判的，绝不用 judge。**
    judge 留给真正需要语义判断的部分——而那部分通常比你以为的少。
    """
    if c.expect is not None:
        return Routed(c.id, "exact", "有唯一正确答案，精确匹配就够")
    if c.fields:
        return Routed(c.id, "structural", "判的是结构，解析一下就知道")
    if c.pattern:
        why = (
            "反向断言：命中就算失败，正则确定且免费"
            if c.negate
            else "判的是格式/存在性，正则确定且免费"
        )
        return Routed(c.id, "regex", why)
    if c.semantic:
        return Routed(c.id, "judge", "★ 真的需要语义判断，但要先给 judge 做体检")
    return Routed(
        c.id,
        "judge",
        "★ 没给出任何确定性依据，只能上 judge——先想想是不是判据本身没定义清",
    )


@dataclass
class CheckResult:
    id: str
    kind: CheckKind
    passed: bool
    note: str = ""


def run_deterministic(output: str, criteria: Sequence[Criterion]) -> list[CheckResult]:
    """跑确定性断言。judge 那一类不在这里跑，它要走体检过的通道。"""
    out: list[CheckResult] = []

    for c in criteria:
        kind = route_check(c).kind

        if kind == "exact":
            assert c.expect is not None
            passed = output.strip() == c.expect.strip()
            note = "" if passed else f"期望 {c.expect}，得到 {output[:40]}"
            out.append(CheckResult(c.id, kind, passed, note))

        elif kind == "structural":
            try:
                parsed = json.loads(output)
            except json.JSONDecodeError:
                out.append(CheckResult(c.id, kind, False, "不是合法 JSON"))
                continue
            obj = parsed if isinstance(parsed, dict) else {}
            missing = [f for f in c.fields if f not in obj]
            note = "" if not missing else f"缺字段 {'、'.join(missing)}"
            out.append(CheckResult(c.id, kind, not missing, note))

        elif kind == "regex":
            assert c.pattern is not None
            hit = re.search(c.pattern, output) is not None
            # ★ negate 时命中就是失败
            passed = (not hit) if c.negate else hit
            if passed:
                note = ""
            elif c.negate:
                note = f"命中了不该出现的 /{c.pattern}/"
            else:
                note = f"不匹配 /{c.pattern}/"
            out.append(CheckResult(c.id, kind, passed, note))

        # judge 类跳过——它不该在这里跑

    return out


# ─────────────────────────────────────────────────────────────
# 三、一致率：为什么 85% 可能等于零信息
# ─────────────────────────────────────────────────────────────


@dataclass
class AgreementReport:
    #  原始一致率。判对的比例。
    raw: float
    #  偶然一致率。两个评判者按各自的边缘分布瞎猜能达到的一致率。
    chance: float
    #  Cohen's kappa。扣掉偶然之后还剩多少。
    kappa: float
    #  raw − kappa，单位是百分点。
    deflation: float
    #  ★ 退化警告。最要紧的一种：judge 永远输出同一个标签。
    #  这时候如果那个标签正好是多数类，raw 会很高而 kappa 恰好是 0。
    problems: list[str] = field(default_factory=list)


def chance_agreement(judge: Sequence[str], human: Sequence[str]) -> float:
    """偶然一致率：两个评判者各自保持自己的标签比例、但完全随机地贴，
    能撞对多少。

        chance = Σ_label  P(judge 贴这个标签) × P(人贴这个标签)

    ★ 标签集合要取两边的**并集**。judge 可能输出人工标注里没有的标签，
    反之亦然；漏掉一边会让 chance 偏小，于是 kappa 虚高——
    而这个错误不会报任何异常，只会让你的 judge 看起来比实际好。
    """
    if len(judge) != len(human) or not judge:
        raise ValueError("两组标签长度必须一致且非空")
    n = len(judge)
    labels = set(judge) | set(human)
    return sum(
        (sum(1 for v in judge if v == lbl) / n) * (sum(1 for v in human if v == lbl) / n)
        for lbl in labels
    )


def agreement(judge: Sequence[str], human: Sequence[str]) -> AgreementReport:
    """带偶然校正的一致率。

    ★ 这是整节课最重要的一个函数，而理由用一个例子就能说清：

    你的评测集里 80% 的样本是"通过"。你写了个 judge，测出来
    **和人工标注的一致率 80%**。听起来还不错。

    但如果这个 judge 的实现是 `return "pass"`——它什么都不看，
    永远说通过——它的一致率**也是 80%**。

    两者的区别，raw agreement 分辨不出来。Cohen's kappa 能：
    那个永远说通过的 judge，kappa 恰好是 0。

        kappa = (观测一致率 − 偶然一致率) / (1 − 偶然一致率)

    而"偶然一致率"算的是：如果两个评判者各自保持自己的标签比例、
    但完全随机地贴，能撞对多少。

    ★ 经验数据：2026 年一项覆盖 21 个 judge、54 万次判断的研究里，
    **原始一致率高估偶然校正后的一致性 33.8 到 41.3 个百分点**，
    21 个模型无一例外。表现最好的那个 judge 原始一致率 0.849，
    kappa 0.511。

    而这个差距的大小主要取决于**你的标签分布**，不取决于 judge 好坏。
    标签越不均衡，raw 越虚高。
    """
    if len(judge) != len(human) or not judge:
        raise ValueError("两组标签长度必须一致且非空")
    n = len(judge)

    # ★ strict=True 很重要。zip 默认会在短的那个耗尽时**静默截断**，
    # 于是两组标签长度不一致时你会算出一个看起来正常的数字，而它是错的。
    raw = sum(1 for j, h in zip(judge, human, strict=True) if j == h) / n
    chance = chance_agreement(judge, human)

    # chance 到 1 时 kappa 无定义。那种情况本身就是一个要报出来的问题。
    kappa = 0.0 if chance >= 1 else (raw - chance) / (1 - chance)

    problems: list[str] = []

    judge_labels = set(judge)
    if len(judge_labels) == 1:
        only = next(iter(judge_labels))
        problems.append(
            f"★ judge 只输出过一个标签（{only}）。"
            f"原始一致率 {raw * 100:.0f}% 完全来自标签分布，不来自判断能力"
            f"——kappa 是 {kappa:.2f}"
        )
    if len(set(human)) == 1:
        problems.append(
            "★ 人工标注只有一个标签。这个评测集没有区分度："
            "任何 judge 在上面都拿不到有意义的 kappa（偶然一致率已经是 1）"
        )
    if raw - kappa > 0.3:
        problems.append(
            f"原始一致率比 kappa 高 {(raw - kappa) * 100:.0f} 个百分点。"
            "这个差距主要来自标签分布，不来自 judge 质量——"
            "但它意味着**原始一致率不能当结论用**"
        )
    if kappa < 0.4 and len(judge_labels) > 1:
        problems.append(f"kappa {kappa:.2f} 偏低。0.4 以下通常不足以拿来做上线决策")

    return AgreementReport(
        raw=raw, chance=chance, kappa=kappa, deflation=(raw - kappa) * 100, problems=problems
    )


# ─────────────────────────────────────────────────────────────
# 四、judge 体检：五步，缺一步都会骗到你
# ─────────────────────────────────────────────────────────────

Verdict = Literal["A", "B", "tie"]


@dataclass
class PairedVerdict:
    """一次成对判决：同一对答案，分别按 AB 和 BA 顺序问一次。"""

    #  AB 顺序下判谁赢。
    ab: Verdict
    #  BA 顺序下判谁赢（已经换算回原来的 A/B 命名）。
    ba: Verdict
    len_a: int
    len_b: int


def position_bias(verdicts: Sequence[PairedVerdict]) -> float:
    """位置偏见：|P(**排在前面**的那个赢) − 0.5|。

    ★ 这里有一个非常容易写错的地方，而写错之后测出来的数
    **看起来完全正常**。

    直觉的写法是 `abs(P(A 赢) - 0.5)`。它是错的，因为 ab/ba 两个字段
    已经换算回内容命名了（见 PairedVerdict 的注释）。于是当 A 这个答案
    真的比 B 好、judge 也正确地两次都选了 A 时，`P(A 赢)` 是 1，
    那个式子会报出 0.5 的"位置偏见"——**而这个 judge 一点位置偏见都没有。**

    换句话说 `abs(P(A 赢) - 0.5)` 测的是"A 这个答案有多常赢"，
    那是**内容分布**，不是位置偏见。只有在胜负恰好五五开的数据集上，
    这两件事才碰巧数值相等——而这就是为什么这个 bug 很难被发现。

    正确的算法要看**位置**：
      · AB 顺序里，排在前面的是 A，所以 ab == "A" 算"前面的赢"
      · BA 顺序里，排在前面的是 B，所以 ba == "B" 算"前面的赢"

    这样内容偏好会自动抵消：一个只看内容的 judge，
    在 AB 里选 A（前面赢）、在 BA 里也选 A（后面赢），一前一后正好抵平。

    ★ 由此还能推出一条恒等关系，很有用：

        位置偏见 ≤ 位置翻转率 / 2

    因为 ab == ba 的那些对必然一前一后各贡献一次，完全中和；
    只有翻转的对才能推动这个数。于是：
      · 翻转率 40%、位置偏见 0.20  → 翻转全朝一个方向，**系统性偏爱某个位置**
      · 翻转率 40%、位置偏见 0.01  → 翻转方向随机，**这不是偏见，是噪声**
    两者的修法完全不同，而只看位置偏见这个数是分不出来的。

    经验数据（2026，21 个 judge）：
      · 最好的 0.002，最差的 0.192 —— 差近两个数量级
      · **同一家的两个型号能差 70 倍**（一个 0.002，一个 0.125）
      · 小模型、便宜模型显著更严重
      · 推理型模型会降低但**不会消除**——三个里只有一个降到 0.05 以下

    ★ 所以"我用的是好模型所以没有位置偏见"是不成立的。**这件事必须实测。**
    """
    first_wins = 0
    decided = 0
    for pv in verdicts:
        if pv.ab != "tie":  # AB 顺序：排在前面的是 A
            decided += 1
            first_wins += pv.ab == "A"
        if pv.ba != "tie":  # BA 顺序：排在前面的是 B
            decided += 1
            first_wins += pv.ba == "B"
    if decided == 0:
        return 0.0
    return abs(first_wins / decided - 0.5)


def flip_rate(verdicts: Sequence[PairedVerdict]) -> float:
    """位置翻转率：同一对答案，换个顺序问就改主意的比例。

    这个数比位置偏见更直观——它是"这个 judge 有多少判决是靠不住的"。
    """
    if not verdicts:
        return 0.0
    return sum(1 for v in verdicts if v.ab != v.ba) / len(verdicts)


def verbosity_bias(verdicts: Sequence[PairedVerdict]) -> float:
    """冗长偏见：答案长度差与判决方向的相关性。

    ★ 这一条是个**过时的常识**，值得专门讲一句。

    2023 年的研究里冗长偏见很显著（报告的量级在 20-40%），
    于是"judge 偏爱长答案，记得在 rubric 里压一下"成了标准建议。

    而 2026 那项 21 个 judge 的普查里，
    **所有 21 个模型的冗长偏见都低于 0.011**。这一条基本上被修掉了。

    但两件事要注意：
      1. 那是在**单一成对 rubric** 下测的。换 rubric、加参考答案、
         要求写理由，都可能把它带回来——原论文自己在局限里写了这一点
      2. ★ **它被修掉了，不代表你不用测。** 测它很便宜（一个相关系数），
         而"我读过的文章说这个问题存在/不存在"不是证据
    """
    xs: list[float] = []
    ys: list[float] = []
    for pv in verdicts:
        d = float(pv.len_a - pv.len_b)
        for v in (pv.ab, pv.ba):
            if v == "tie":
                continue
            xs.append(d)
            ys.append(1.0 if v == "A" else -1.0)
    return pearson(xs, ys)


def pearson(xs: Sequence[float], ys: Sequence[float]) -> float:
    n = len(xs)
    if n < 2:
        return 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((a - mx) * (b - my) for a, b in zip(xs, ys, strict=True))
    dx = sum((a - mx) ** 2 for a in xs)
    dy = sum((b - my) ** 2 for b in ys)
    den = math.sqrt(dx * dy)
    return 0.0 if den == 0 else num / den


def test_retest(runs: Sequence[Sequence[str]]) -> float:
    """重测信度：同一个 judge、同样的输入、跑多次，结果有多稳。

    每个元素是一次完整运行的判决序列。
    """
    if len(runs) < 2:
        raise ValueError("至少要两次运行才能算重测信度")
    n = len(runs[0])
    if any(len(r) != n for r in runs):
        raise ValueError("每次运行的条目数必须一致")
    if n == 0:
        return 0.0

    stable = sum(1 for i in range(n) if len({r[i] for r in runs}) == 1)
    return stable / n


@dataclass
class JudgeAudit:
    kappa: float
    raw: float
    position_bias: float
    flip_rate: float
    verbosity_bias: float
    test_retest: float
    problems: list[str] = field(default_factory=list)
    #  五步全过才能上线。
    deployable: bool = False


def audit_judge(
    *,
    judge_labels: Sequence[str],
    human_labels: Sequence[str],
    paired: Sequence[PairedVerdict],
    runs: Sequence[Sequence[str]],
) -> JudgeAudit:
    """judge 上线前的体检。五步，缺一步都会骗到你。

    ★ 而第五步是最反直觉的那一步，它叫**一致性—偏见悖论**：

    重测信度高**不等于** judge 可靠。

    原因是这两个量测的是**两种不同的扰动**：
      · 重测信度：**同一个 prompt** 问多次，答案稳不稳
      · 位置偏见：把两个答案**换个顺序**（语义上无关的扰动），答案变不变

    一个"永远选排在前面那个"的 judge，重测信度是满分（它完全确定），
    位置偏见也是满分（它只看位置）。**确定性在第二种扰动上一分钱都不值。**

    2026 那项研究里有两个**已经在生产环境部署**的 judge 正好落在这个格子里：
      · 一个重测信度 0.992，位置偏见 0.192
      · 另一个重测信度 0.988，位置偏见 0.125

    论文的原话值得记住：**最可复现的 judge 恰恰是最不可信的那些。**

    而这正是最坑的地方——因为"我的评测每次跑分都一样"听起来
    完全像是一件好事，于是没人会去查它。
    """
    agr = agreement(judge_labels, human_labels)
    pb = position_bias(paired)
    fr = flip_rate(paired)
    vb = verbosity_bias(paired)
    tr = test_retest(runs)

    problems = list(agr.problems)

    if pb > 0.1:
        # ★ 位置偏见 ≤ 翻转率/2，所以 pb 大必然 fr 也大。
        # 有意思的是反过来不成立——见下面那个 elif。
        share = 2 * pb / fr * 100 if fr > 0 else 100.0
        aligned = "翻转全部" if share > 99 else f"翻转里有 {share:.0f}% "
        problems.append(
            f"位置偏见 {pb:.3f} 超过 0.10，且换个顺序问有 {fr * 100:.0f}% 的判决会变。"
            f"{aligned}朝同一个方向——这是**系统性偏爱某个位置**，"
            "不是随机抖动。修法是每条都 AB+BA 各问一次再合并，不一致的算 tie"
        )
    elif fr > 0.2:
        # ★ 翻转率高但位置偏见低：翻转方向是随机的。
        # 这不是偏见，是**噪声**——而两者的修法完全不同：
        # 偏见靠 AB+BA 对称化能消掉，噪声只能靠降温度、加参考答案、多数投票。
        problems.append(
            f"★ 位置翻转率 {fr * 100:.0f}% 很高，但位置偏见只有 {pb:.3f}。"
            "也就是说翻转的方向是随机的——**这不是位置偏见，是噪声**。"
            "注意修法不同：偏见能靠 AB+BA 对称化消掉，噪声不能，"
            "得降温度 / 给参考答案 / 多数投票"
        )
    if abs(vb) > 0.05:
        problems.append(f"冗长偏见 {vb:.3f}。judge 在跟着长度走，rubric 里要显式压一下")
    if tr < 0.9:
        problems.append(
            f"重测信度 {tr:.3f} 偏低。同样的输入结果都不稳，跑分差异分不清是改动还是抖动"
        )

    # ★ 第五步：一致性—偏见悖论
    if tr > 0.95 and pb > 0.1:
        problems.append(
            f"★ 一致性—偏见悖论：重测信度 {tr:.3f} 很高，但位置偏见 {pb:.3f} 也很高。"
            '这不是"很稳所以可靠"，这是**它稳定地按位置而不是按质量在判**。'
            "高稳定 + 高偏见是一种失效，不是一个优点"
        )

    return JudgeAudit(
        kappa=agr.kappa,
        raw=agr.raw,
        position_bias=pb,
        flip_rate=fr,
        verbosity_bias=vb,
        test_retest=tr,
        problems=problems,
        deployable=not problems and agr.kappa >= 0.4,
    )


# ─────────────────────────────────────────────────────────────
# 五、显著性：涨的那 2% 是真的吗
# ─────────────────────────────────────────────────────────────


def make_rng(seed: int = 42) -> Callable[[], float]:
    """可复现的伪随机。

    ★ 这里故意不用 random.random()，也不用 numpy——用的是和 TS 版
    **完全一样的线性同余公式**，这样两边的 bootstrap 结果可以逐位对上。

    真实项目里当然该用 numpy（快几十倍）或者直接 scipy.stats.bootstrap。
    这里手写是为了让你看清它到底在干什么：**它只是在重复抽样求均值。**
    """
    s = seed

    def rand() -> float:
        nonlocal s
        s = (s * 1664525 + 1013904223) % 4294967296
        return s / 4294967296

    return rand


@dataclass
class Interval:
    lo: float
    hi: float


def bootstrap_ci(
    scores: Sequence[float], *, iters: int = 2000, seed: int = 42
) -> Interval:
    """bootstrap 置信区间。

    ★ 为什么必须有这个：**评测集小，而小样本的置信区间宽得超乎直觉。**

    150 条样本、成功率 80%，95% 置信区间大约是 ±6 个百分点。
    也就是说你测出 80%，真值在 74% 到 86% 之间都不奇怪。

    那么"改动后从 80% 涨到 82%"意味着什么？**什么都不意味着。**

    而这件事的危险不在于你会做错决定，在于**你会做很多错决定
    并且每次都觉得自己有数据支持**。
    """
    if not scores:
        raise ValueError("没有样本")
    rand = make_rng(seed)
    n = len(scores)
    means: list[float] = []

    for _ in range(iters):
        total = 0.0
        for _ in range(n):
            total += scores[int(rand() * n)]
        means.append(total / n)

    means.sort()
    return Interval(lo=means[int(iters * 0.025)], hi=means[int(iters * 0.975)])


@dataclass
class DiffResult:
    before: float
    after: float
    delta: float
    #  差值的置信区间。跨过 0 就是没结论。
    ci: Interval
    significant: bool
    #  ★ 净变化背后的明细。
    fixed: list[str] = field(default_factory=list)
    broken: list[str] = field(default_factory=list)
    verdict: str = ""


def compare_runs(
    before: dict[str, float], after: dict[str, float], *, seed: int = 42
) -> DiffResult:
    """成对比较两次运行。

    ★ 这个函数最重要的输出不是 delta，是 fixed 和 broken 两个列表。

    因为"净涨 2%"可以是下面任意一种，而它们要采取的行动完全不同：

        修好 3 个，弄坏 0 个    → 干净的改进，合并
        修好 13 个，弄坏 10 个  → ★ 这不是改进，这是**换了一批 bug**
        修好 0 个，弄坏 0 个，
        只是 2 个 case 抖动了   → 噪声，什么都没发生

    第二种是最需要被看见的：净值是正的，看起来该合并，
    但你实际上是在拿 10 个能用的 case 换 13 个。而如果那 10 个里
    有付费客户在用的路径，这个改动是净负的。

    **净值会把这件事藏起来。所以必须报明细。**
    """
    ids = [i for i in before if i in after]
    if not ids:
        raise ValueError("两次运行没有共同的样本 id，无法成对比较")

    b = [before[i] for i in ids]
    a = [after[i] for i in ids]

    # ★ 成对差值的 bootstrap，不是两个均值各自的区间。
    # 成对能消掉"样本本身难易不同"这部分方差，功效高得多。
    diffs = [after[i] - before[i] for i in ids]
    ci = bootstrap_ci(diffs, seed=seed)

    fixed = [i for i in ids if after[i] > before[i]]
    broken = [i for i in ids if after[i] < before[i]]
    significant = ci.lo > 0 or ci.hi < 0
    delta = sum(a) / len(a) - sum(b) / len(b)

    # ★ 判断顺序很关键，而最自然的写法是错的。
    #
    # 直觉上会先分"显著 / 不显著"，再在显著的分支里报"换了一批 bug"。
    # 但那样这句话**永远不会出现**——因为换一批 bug 的净值恰恰很小，
    # 所以它总是落进"不显著"那一支。
    #
    # 于是最需要被看见的那种情况，被一句"不显著"盖掉了。
    # 正确的顺序是**先看弄坏了多少，再谈显著性**：弄坏了 10 个 case
    # 是一件确定发生了的事，不需要统计检验来确认。
    if len(broken) >= 3:
        churn = (
            f"★ 修好 {len(fixed)} 个，同时弄坏了 {len(broken)} 个。"
            f"**这不是改进，这是换了一批 bug。** 先看弄坏的那 {len(broken)} 个是什么"
            "——如果里面有付费客户在走的路径，这个改动是净负的。"
        )
    elif broken:
        churn = f"修好 {len(fixed)} 个，弄坏 {len(broken)} 个。"
    else:
        churn = ""

    if not significant:
        sign = "+" if delta >= 0 else ""
        stat = (
            f"净变化 {sign}{delta * 100:.1f} 个百分点不显著"
            f"（差值区间 [{ci.lo:.3f}, {ci.hi:.3f}] 跨过 0）。"
            f'★ 注意"看不出"不等于"没有"——也可能是 {len(ids)} 条样本还不够。'
        )
    elif ci.hi < 0:
        stat = "显著变差。"
    else:
        stat = "净变化显著为正。"

    if not churn and significant and ci.lo > 0:
        verdict = f"干净的改进：修好 {len(fixed)} 个，没有弄坏任何一个。"
    elif not churn and not significant:
        verdict = f"{stat}没有任何 case 从通过变成失败——所以这不是回归，只是没测出效果。"
    else:
        verdict = f"{churn}{stat}"

    return DiffResult(
        before=sum(b) / len(b),
        after=sum(a) / len(a),
        delta=delta,
        ci=ci,
        significant=significant,
        fixed=fixed,
        broken=broken,
        verdict=verdict,
    )


# ─────────────────────────────────────────────────────────────
# 六、评测集腐化
# ─────────────────────────────────────────────────────────────


@dataclass
class RotReport:
    #  还有区分度的条目：历史上有过通过也有过失败。
    live: list[str] = field(default_factory=list)
    #  一直全对的条目。它们不再提供信息。
    always_pass: list[str] = field(default_factory=list)
    #  一直全错的条目。可能是标注错了，或者是真的做不到。
    always_fail: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)


def detect_rot(history: dict[str, list[float]]) -> RotReport:
    """评测集腐化检测。

    ★ 这件事必然发生，而且发生的原因正是你在正确地工作：

    你照着评测集修 bug。修完那些 case 就永远通过了。
    于是你的评测集里可用的信息在**单调减少**，而总分在单调上升。

    半年之后你有一个 96 分的评测集，其中 90% 的条目对任何改动都不敏感。
    那 96 分是真的，也是没用的——它不再能告诉你下一个改动是好是坏。

    所以必须定期做两件事：
      1. 从生产日志里补新的失败样本（而 L13 那节的可观测性就是为了这个）
      2. 把一直全对的条目挪到一个"回归集"里——它们仍然要跑（防退化），
         但不该算进"当前能力"那个分数

    ★ 一直全错的条目要单独看：**它可能是标注错了。**
    一个永远失败的 case，比一个永远成功的 case 更值得花五分钟人工确认。
    """
    live: list[str] = []
    always_pass: list[str] = []
    always_fail: list[str] = []

    for cid, runs in history.items():
        if not runs:
            continue
        passes = sum(1 for s in runs if s >= 1)
        if passes == len(runs):
            always_pass.append(cid)
        elif passes == 0:
            always_fail.append(cid)
        else:
            live.append(cid)

    total = len(live) + len(always_pass) + len(always_fail)
    problems: list[str] = []

    if total > 0 and len(live) / total < 0.3:
        problems.append(
            f"只有 {len(live)}/{total} 条还有区分度。"
            "这个评测集大部分条目对改动已经不敏感了——分数还会涨，"
            "但它不再能指导决策。该从生产日志补新样本了"
        )
    if always_fail:
        problems.append(
            f"{len(always_fail)} 条从来没通过过：{'、'.join(always_fail[:5])}。"
            "★ 先人工确认标注对不对——永远失败的 case 里混着标错的样本，"
            "而它们会让你去修一个不存在的问题"
        )
    if always_pass:
        problems.append(
            f"{len(always_pass)} 条一直全对。它们该挪进回归集：继续跑（防退化），"
            '但不算进"当前能力"那个分数——不然分数会被它们撑高'
        )

    return RotReport(
        live=live, always_pass=always_pass, always_fail=always_fail, problems=problems
    )


# ─────────────────────────────────────────────────────────────
# 七、Python 独有：什么时候该换成 scipy
# ─────────────────────────────────────────────────────────────

# ★ 上面这些函数都是手写的，目的是让你看清机制。
# 但真实项目里有三处该换掉，而判据很清楚：
#
#   bootstrap_ci      → scipy.stats.bootstrap
#                       手写版是 O(iters × n) 的纯 Python 循环。
#                       2000 次 × 150 条还能忍，20000 次 × 5000 条就不行了。
#                       scipy 那个是向量化的，快两三个数量级
#
#   显著性检验         → scipy.stats.wilcoxon（成对、非正态）
#                       或 scipy.stats.ttest_rel（成对、近正态）
#                       ★ 注意都是**成对**版本。用独立样本检验会
#                       白扔掉一半功效，因为它把"同一条样本"这个信息丢了
#
#   多重比较           → statsmodels.stats.multitest.multipletests
#                       ★ 这一条最容易漏，而它很致命：
#                       你一次比 20 个指标，其中"有一个显著"几乎是必然的
#                       （20 个独立检验、α=0.05，至少一个假阳性的概率是 64%）。
#                       不做校正的话，你会稳定地发现不存在的改进
#
# 而 Cohen's kappa 那个可以用 sklearn.metrics.cohen_kappa_score，
# 但手写版只有十行，且能顺手报出"judge 只输出一个标签"这类退化警告——
# sklearn 那个不会告诉你这件事，它只返回一个数。


def multiple_comparisons(k: int, alpha: float = 0.05) -> dict[str, Any]:
    """多重比较。

    ★ 这一条只在 Python 侧有，理由不是语言差异，是**工具链差异**：
    多重比较校正的实现在 statsmodels 里，JS 生态没有等价物。

    而这件事很致命。你改了一个 prompt，然后顺手看了：
      总成功率、三种任务各自的成功率、平均步数、P95 延迟、token 花费

    那是 7 个比较。而在 α=0.05 下，
    **"至少一个看起来显著"的概率是 30%。**
    也就是说你三次里有一次会"发现"一个不存在的改进。

        P(至少一个假阳性) = 1 − (1 − α)^k

          k=1   5%
          k=5   23%
          k=7   30%
          k=20  64%      ← 一次 A/B 面板上的指标数量级

    ★ 而最重要的建议不是"做校正"，是**事前声明唯一的主指标**。
    校正是补救，而且它会让功效变低（阈值被除以 k，真实的改进也测不出来了）。
    事前声明主指标不会有这个代价。
    """
    if k < 1:
        raise ValueError("比较次数至少是 1")
    p_any = 1 - (1 - alpha) ** k

    if k == 1:
        advice = "只有一个指标，不需要校正。★ 而这就是最好的状态——事前声明主指标"
    elif k <= 3:
        advice = (
            f"{k} 个指标还可控，但仍该指定哪个是主指标。"
            f"Bonferroni 校正后阈值 {alpha / k:.4f}"
        )
    else:
        advice = (
            f"★ {k} 个指标下假阳性概率已经到 {p_any * 100:.0f}%。"
            "**先声明唯一的主指标**，其余当作探索性观察、不用来做决策。"
            "如果确实要一起判，用 statsmodels.stats.multitest.multipletests "
            "做 BH 校正（比 Bonferroni 功效高）"
        )

    return {
        "k": k,
        "alpha": alpha,
        "p_any_false_positive": p_any,
        # Bonferroni：最保守但最简单
        "adjusted_alpha": alpha / k,
        "advice": advice,
    }


def significance_note(n: int, delta: float, ci: Interval, comparisons: int = 1) -> list[str]:
    """把上面那三条判据变成能跑的检查。

    ★ 最后那个参数是重点：**comparisons 是你这一轮一共比了几个指标。**

    一次改动，你顺手看了"总成功率、各任务类型的成功率、平均步数、
    P95 延迟、token 花费"——那就是 5 个以上的比较。
    而"其中至少一个看起来显著"在这个数量下几乎是必然的。
    """
    notes: list[str] = []

    if n < 100:
        notes.append(
            f"样本只有 {n} 条。这个量级下置信区间宽到大部分改动都测不出来——"
            f"当前区间宽度 {ci.hi - ci.lo:.3f}，而你在看的差值是 {delta:.3f}"
        )

    if comparisons > 1:
        # 至少一个假阳性的概率（假设各检验独立）
        p_any = 1 - 0.95**comparisons
        notes.append(
            f"★ 这一轮比了 {comparisons} 个指标。在 α=0.05 下，"
            f"「至少一个假阳性」的概率是 {p_any * 100:.0f}%。"
            "要么先声明唯一的主指标，要么做多重比较校正"
            "（statsmodels 的 multipletests）"
        )

    if ci.lo <= 0 <= ci.hi and abs(delta) > 0:
        notes.append(
            f"差值 {delta:+.3f} 的区间跨过 0。"
            '★ 这时候正确的说法是"没测出效果"，不是"没有效果"——'
            "两者的区别在于后者需要更大的样本才能主张"
        )

    return notes
