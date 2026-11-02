"""L12：评测套件。跑法：

    cd labs && uv run python -m l12.suite
    cd labs && EVAL_IMPL=shared uv run python -m l12.suite
    cd labs && uv run python -m l12.verify

★ 这一节是分水岭，理由很直接：**在它之前你所有的判断都是"我觉得"。**

L03 的 prompt 改法、L06 的压缩策略、L07 的编排模式、L09 的检索配置、
L11 的扇出宽度——每一个都是在两种做法之间选一种，而你到现在为止
没有任何手段判断哪种更好。

而这八个 TODO 处理的核心难题不是"怎么打分"，是**怎么不骗自己**。

因为评测有一个很坏的性质：**它产出数字，而数字自带权威。**
一个错的评测比没有评测更糟——没有评测你至少知道自己在猜。

  TODO 1    分层抽样      —— 随机抽会给你一个 90 分的废评测集
  TODO 2    断言分层      —— 别用 judge 干正则能干的事
  TODO 3、4 偶然校正      —— 为什么"一致率 85%"可能等于零信息
  TODO 5    judge 体检    —— 五步，第五步最反直觉
  TODO 6    显著性        —— 涨的那 2% 是真的吗
  TODO 7    回归明细      —— 净涨 2% 背后可能是换了一批 bug
  TODO 8    多重比较      —— ★ Python 独有，因为这一层的工具只有 Python 有
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable, Sequence
from typing import Any

from shared import evals as shared
from shared.evals import (
    AgreementReport,
    Criterion,
    DiffResult,
    Interval,
    JudgeAudit,
    LogEntry,
    PairedVerdict,
    Routed,
    SampleResult,
)

IMPL = "shared" if os.environ.get("EVAL_IMPL") == "shared" else "mine"


# ─────────────────────────────────────────────────────────────
# TODO 1：分层抽样
#
# ★ 为什么不能随机抽：**生产日志是极度不均衡的。**
#
# 一个还算健康的 agent，日志里 90% 以上是成功的正常路径。
# 随机抽 150 条，你会拿到 135 条正常路径和一把零星的失败——
# 而失败恰恰是你要评测的东西。
#
# 更糟的是这个评测集**会给你一个很高的基线分**（90%+），
# 于是任何改进都只能在剩下那 10% 里体现，信噪比极差。
#
# 要返回三样东西，而**第三样最重要**：
#   picked    抽出来的样本
#   coverage  每个分层实际取到几条
#   gaps      ★ 没取够的分层
#
# gaps 为什么最重要：**"某个失败模式在评测集里一条都没有"这件事，
# 不会以任何形式表现出来。** 你的评测会跑得很干净，分数会很好看，
# 而那个失败模式在生产上继续发生。
#
# 取到 0 条的分层要单独说一句——那不是"少了几条"，是"这一类不存在"。
# ─────────────────────────────────────────────────────────────


def stratified_sample(
    logs: Sequence[LogEntry],
    *,
    strata: Sequence[str],
    per_stratum: int,
    stratify: Callable[[LogEntry], str] | None = None,
) -> SampleResult:
    raise NotImplementedError("TODO: 实现 stratified_sample")


# ─────────────────────────────────────────────────────────────
# TODO 2：把判据路由到最便宜的够用的检查方式
#
# ★ 这个 TODO 存在的理由是一条很实际的观察：
# **绝大多数人上手评测的第一件事就是写一个 LLM judge，
# 而其中大半根本不需要。**
#
# "输出里有没有引用编号"是正则。"输出是不是合法 JSON 且有 severity 字段"
# 是结构检查。"分类对不对"是精确匹配。这三类合起来通常占判据的七八成，
# 而它们的共同点是：**确定、免费、不会漂。**
#
# 而 judge 的代价不只是钱：
#   · 它自己会错，而且错得有系统性（TODO 5 会量出来）
#   · 它的输出会随模型版本漂移，于是你的历史分数**不可比**
#   · 它慢，于是你不会想在每次提交时跑
#
# 优先级：expect（精确）> fields（结构）> pattern（正则）> semantic（judge）
#
# ★ pattern 那一支要看 negate：反向断言（"不能出现内部服务名"）
# 的 why 要说清是"命中就算失败"。安全相关的判据大半是反向的，
# 而把它们写成正向会让断言含义**正好反过来**，且测试全绿。
#
# ★ 还有一个兜底分支值得想清楚：一条判据什么依据都没给，
# 既没有期望值也没标 semantic。这时候路由到 judge 是对的，
# **但要在 why 里说清这通常意味着判据本身没定义清楚。**
# 一条你自己都说不出怎么验的判据，judge 也判不了。
# ─────────────────────────────────────────────────────────────


def route_check(c: Criterion) -> Routed:
    raise NotImplementedError("TODO: 实现 route_check")


# ─────────────────────────────────────────────────────────────
# TODO 3：偶然一致率
#
# 两个评判者各自保持自己的标签比例、但完全随机地贴，能撞对多少。
#
#     chance = Σ_label  P(judge 贴这个标签) × P(人贴这个标签)
#
# 注意标签集合要取两边的**并集**——judge 可能输出人工标注里没有的标签，
# 反之亦然。漏掉一边会让 chance 算小，于是 kappa 虚高。
# ─────────────────────────────────────────────────────────────


def chance_agreement(judge: Sequence[str], human: Sequence[str]) -> float:
    raise NotImplementedError("TODO: 实现 chance_agreement")


# ─────────────────────────────────────────────────────────────
# TODO 4：带偶然校正的一致率 —— 整节课最重要的一个函数
#
# ★ 理由用一个例子就能说清：
#
# 你的评测集里 80% 的样本是"通过"。你写了个 judge，测出来
# **和人工标注的一致率 80%**。听起来还不错。
#
# 但如果这个 judge 的实现是 `return "pass"`——它什么都不看，
# 永远说通过——它的一致率**也是 80%**。
#
# 两者的区别，原始一致率分辨不出来。Cohen's kappa 能：
# 那个永远说通过的 judge，kappa 恰好是 0。
#
#     kappa = (观测一致率 − 偶然一致率) / (1 − 偶然一致率)
#
# ★ 经验数据（2026，21 个 judge、54 万次判断）：
# **原始一致率高估偶然校正后的一致性 33.8 到 41.3 个百分点**，
# 21 个模型无一例外。表现最好的那个原始一致率 0.849，kappa 0.511。
#
# 而这个差距的大小主要取决于**你的标签分布**，不取决于 judge 好坏。
#
# 除了算数，还要报出四类问题（每一类都对应一种"数字好看但没信息"）：
#   · judge 只输出过一个标签       → raw 完全来自标签分布
#   · 人工标注只有一个标签         → 这个评测集没有区分度
#   · raw − kappa > 0.3            → raw 不能当结论用
#   · kappa < 0.4（且不是退化情况） → 不足以做上线决策
#
# ★ 还有一个边界：chance 等于 1 的时候 kappa 的分母是 0。
# 别让它变成 nan 或者抛异常——**那种情况本身就是一个要报出来的问题**，
# 而不是一个计算错误。
#
# ★ Python 特有的一处：zip(judge, human) 默认会在短的那个耗尽时
# **静默截断**。两组标签长度不一致时你会算出一个看起来正常的数字，
# 而它是错的。要么先显式检查长度，要么用 strict=True（3.10+）。
# ─────────────────────────────────────────────────────────────


def agreement(judge: Sequence[str], human: Sequence[str]) -> AgreementReport:
    raise NotImplementedError("TODO: 实现 agreement")


# ─────────────────────────────────────────────────────────────
# TODO 5：judge 上线前的体检 —— 五步
#
# 前四步是常规的：
#   1. 偶然校正的一致率（kappa，不是 raw）
#   2. 位置偏见（AB+BA 成对，|P(A 赢) − 0.5| > 0.10 就有问题）
#   3. 冗长偏见（长度差与判决的相关性，|r| > 0.05 就有问题）
#   4. 重测信度（同输入多次跑，< 0.9 就有问题）
#
# ★ 而第五步是最反直觉的那一步，它叫**一致性—偏见悖论**：
#
# **重测信度高不等于 judge 可靠。**
#
# 原因是这两个量测的是**两种不同的扰动**：
#   · 重测信度：同一个 prompt 问多次，答案稳不稳
#   · 位置偏见：把两个答案换个顺序（语义上无关的扰动），答案变不变
#
# 一个"永远选排在前面那个"的 judge，重测信度是满分（它完全确定），
# 位置偏见也是满分（它只看位置）。**确定性在第二种扰动上一分钱都不值。**
#
# 2026 那项研究里有两个**已经在生产环境部署**的 judge 正好落在这个格子里：
#   · 一个重测信度 0.992，位置偏见 0.192
#   · 另一个重测信度 0.988，位置偏见 0.125
#
# 论文原话值得记住：**最可复现的 judge 恰恰是最不可信的那些。**
#
# 而这正是最坑的地方——"我的评测每次跑分都一样"听起来完全像是一件好事，
# 于是没人会去查它。
#
# ★ 还有一条恒等关系要用上：**位置偏见 ≤ 位置翻转率 / 2**。
# （证明一行：ab == ba 的对必然一前一后各贡献一次，完全中和，
# 所以只有翻转的对能推动这个数。）
#
# 它的用处是把两种失效分开：
#   · 翻转率 40%、位置偏见 0.20 → 翻转全朝一个方向，**系统性偏爱某个位置**
#   · 翻转率 40%、位置偏见 0.01 → 翻转方向随机，**这不是偏见，是噪声**
# 修法完全不同：偏见能靠 AB+BA 对称化消掉，噪声不能。
#
# 位置偏见、冗长偏见、重测信度三个函数已经在 shared/evals 里写好了，
# 你要写的是把它们组装起来那一层，以及那五条判断。
# ─────────────────────────────────────────────────────────────


def audit_judge(
    *,
    judge_labels: Sequence[str],
    human_labels: Sequence[str],
    paired: Sequence[PairedVerdict],
    runs: Sequence[Sequence[str]],
) -> JudgeAudit:
    raise NotImplementedError("TODO: 实现 audit_judge")


# ─────────────────────────────────────────────────────────────
# TODO 6：bootstrap 置信区间
#
# ★ 为什么必须有这个：**评测集小，而小样本的置信区间宽得超乎直觉。**
#
# 150 条样本、成功率 80%，95% 置信区间大约是 ±6 个百分点。
# 也就是说你测出 80%，真值在 74% 到 86% 之间都不奇怪。
#
# 那么"改动后从 80% 涨到 82%"意味着什么？**什么都不意味着。**
#
# 做法（bootstrap 的全部内容就这么点）：
#   重复 iters 次：从原样本里**有放回**地抽 n 个，算均值
#   把这 iters 个均值排序，取 2.5% 和 97.5% 分位
#
# ★ 用 shared.evals.make_rng，不要用 random.random()——
# 评测结果必须可复现，不然你没法判断"跑分变了"是改动还是抖动。
# 这一条本身就是这节课的主题。
#
# （真实项目里这里该换成 scipy.stats.bootstrap，判据见 evals.py 第七节）
# ─────────────────────────────────────────────────────────────


def bootstrap_ci(scores: Sequence[float], *, iters: int = 2000, seed: int = 42) -> Interval:
    raise NotImplementedError("TODO: 实现 bootstrap_ci")


# ─────────────────────────────────────────────────────────────
# TODO 7：回归比较 —— 最重要的输出不是那个 delta
#
# ★ 因为"净涨 2%"可以是下面任意一种，而它们要采取的行动完全不同：
#
#     修好 3 个，弄坏 0 个     → 干净的改进，合并
#     修好 13 个，弄坏 10 个   → ★ 这不是改进，这是**换了一批 bug**
#     修好 0 个，弄坏 0 个，
#     只是 2 个 case 抖动了    → 噪声，什么都没发生
#
# 第二种是最需要被看见的：净值是正的，看起来该合并，
# 但你实际上是在拿 10 个能用的 case 换 13 个。而如果那 10 个里
# 有付费客户在用的路径，这个改动是净负的。
#
# **净值会把这件事藏起来。所以必须报明细。**
#
# 两个技术要点：
#
# ① ★ 要对**成对差值**做 bootstrap，不是对两个均值各自算区间。
#    成对能消掉"样本本身难易不同"那部分方差，功效高得多。
#    对着 diffs = after[i] − before[i] 这个序列跑 bootstrap_ci。
#
# ② 只比两边都有的 id。少了哪一边就没法成对——而"评测集换了一批样本
#    之后跑分涨了"是最经典的自欺。
# ─────────────────────────────────────────────────────────────


def compare_runs(
    before: dict[str, float], after: dict[str, float], *, seed: int = 42
) -> DiffResult:
    raise NotImplementedError("TODO: 实现 compare_runs")


# ─────────────────────────────────────────────────────────────
# TODO 8（Python 独有）：多重比较
#
# ★ 这一条只在 Python 侧有，理由不是语言差异，是**工具链差异**：
# 多重比较校正的实现在 statsmodels 里，JS 生态没有等价物。
# 而这件事很致命：
#
# 你改了一个 prompt，然后顺手看了：
#   总成功率、三种任务各自的成功率、平均步数、P95 延迟、token 花费
#
# 那是 7 个比较。而在 α=0.05 下，**"至少一个看起来显著"的概率是 30%。**
# 也就是说你三次里有一次会"发现"一个不存在的改进。
#
# 公式（假设各检验独立）：P(至少一个假阳性) = 1 − 0.95^k
#
#   k=1   5%
#   k=5   23%
#   k=7   30%
#   k=20  64%      ← 一次 A/B 面板上的指标数量级
#
# 要实现的：
#   · 算出这个概率
#   · 做 Bonferroni 校正：把 α 除以 k，返回校正后的阈值
#     （最保守但最简单的做法；真实项目用 statsmodels 的 BH 更好）
#   · ★ 给出那条最重要的建议：**先声明唯一的主指标。**
#     校正是补救，事前声明主指标才是解法——因为校正会让功效变低，
#     而事前声明不会。
# ─────────────────────────────────────────────────────────────


def multiple_comparisons(k: int, alpha: float = 0.05) -> dict[str, Any]:
    raise NotImplementedError("TODO: 实现 multiple_comparisons")


# ─────────────────────────────────────────────────────────────
# 观察实验
# ─────────────────────────────────────────────────────────────

_M: Any = shared if IMPL == "shared" else sys.modules[__name__]


def _line(n: int = 66) -> str:
    return "─" * n


RED = "\033[31m"
GREEN = "\033[32m"
DIM = "\033[2m"
OFF = "\033[0m"


def fake_logs() -> list[LogEntry]:
    """一份形状真实的生产日志：绝大多数是成功的正常路径。"""
    kinds = ["查询", "改代码", "多步任务"]
    out: list[LogEntry] = []
    for i in range(400):
        r = i % 100
        # 92% ok，剩下 8% 分给三种失败——这就是真实分布
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


def demo_sampling() -> None:
    print(f"\n【一】随机抽样会给你一个 90 分的废评测集\n{_line()}")

    logs = fake_logs()
    dist: dict[str, int] = {}
    for entry in logs:
        dist[entry.outcome] = dist.get(entry.outcome, 0) + 1
    print("  400 条生产日志的真实分布：")
    for k, v in dist.items():
        print(f"    {k:<8} {v} 条  {v / 400 * 100:.0f}%")

    rand = shared.make_rng(7)
    shuffled = sorted(logs, key=lambda _: rand())[:60]
    rdist: dict[str, int] = {}
    for entry in shuffled:
        rdist[entry.outcome] = rdist.get(entry.outcome, 0) + 1

    print("\n  随机抽 60 条：")
    for k in ("ok", "wrong", "error", "timeout"):
        print(f"    {k:<8} {rdist.get(k, 0)} 条")
    ok_share = rdist.get("ok", 0) / 60
    print(f"\n  {RED}★ 这个评测集的基线分是 {ok_share * 100:.0f}%。{OFF}")
    print('  它的问题不是"分数太高"，是**任何改进都只能在剩下那点里体现**。')
    print(f"  而 timeout 只有 {rdist.get('timeout', 0)} 条——那一类基本没被测到。")

    print("\n  分层抽样，每类要 15 条：")
    s = _M.stratified_sample(
        logs, strata=["ok", "wrong", "error", "timeout"], per_stratum=15
    )
    for k, v in s.coverage.items():
        mark = f"{RED}  ← 只有 {v} 条{OFF}" if v < 15 else ""
        print(f"    {k:<8} {v} 条{mark}")
    print(f"\n  {GREEN}总共 {len(s.picked)} 条，四类失败都覆盖到了{OFF}")
    if s.gaps:
        print(f"\n  {RED}缺口（{len(s.gaps)} 条）：{OFF}")
        for g in s.gaps:
            print(f"    · {g}")
        print('\n  ★ 缺口必须显式报出来。因为"某个失败模式在评测集里一条都没有"')
        print("  这件事不会以任何形式表现出来——评测跑得很干净，分数很好看，")
        print("  而那个失败模式在生产上继续发生。")


def demo_routing() -> None:
    print(f"\n【二】七成判据不需要 judge\n{_line()}")

    criteria = [
        Criterion(id="c1", says="严重级别分类要对", expect="P0"),
        Criterion(
            id="c2",
            says="输出是合法 JSON 且有 severity 和 component",
            fields=["severity", "component"],
        ),
        Criterion(id="c3", says="回答里要带引用编号", pattern=r"\[\d+\]"),
        Criterion(id="c4", says="不能出现内部服务名", pattern="internal-", negate=True),
        Criterion(id="c5", says="解释要让非技术同事看得懂", semantic=True),
        Criterion(id="c6", says="回答质量要好"),
    ]

    routed = [_M.route_check(c) for c in criteria]
    for r, c in zip(routed, criteria, strict=True):
        paint = RED if r.kind == "judge" else GREEN
        print(f"  {r.id}  {paint}{r.kind:<11}{OFF} {c.says}")
        print(f"{DIM}      {r.why}{OFF}")

    cheap = sum(1 for r in routed if r.kind != "judge")
    print(f"\n  {GREEN}{cheap}/{len(routed)} 条用确定性断言就够{OFF}——确定、免费、不会漂。")
    print("\n  ★ 而 judge 的代价不只是钱：")
    print("    · 它自己会错，而且错得有系统性（demo 四会量出来）")
    print("    · 它的输出会随模型版本漂移，于是你的历史分数**不可比**")
    print("    · 它慢，于是你不会想在每次提交时跑")
    print("\n  注意 c4「不能出现内部服务名」是**反向断言**：命中就算失败。")
    print("  安全相关的判据大半是反向的，而写成正向会让含义正好反过来，")
    print("  且测试全绿。")
    print("\n  再注意 c6「回答质量要好」：它被兜底路由到了 judge，")
    print("  但真正的问题是**这条判据本身没定义清楚**。")
    print("  一条你自己都说不出怎么验的判据，judge 也判不了——")
    print("  它只会给你一个看起来像分数的数字。")


def demo_kappa() -> None:
    print(f'\n【三】"一致率 85%" 可能等于零信息\n{_line()}')

    human = ["pass"] * 80 + ["fail"] * 20
    print("  评测集：100 条，其中 80 条人工标注为 pass。")

    print('\n  judge A —— 实现是 `return "pass"`，什么都不看：')
    lazy = ["pass"] * 100
    r_a = _M.agreement(lazy, human)
    print(f"    原始一致率  {r_a.raw * 100:.0f}%   {DIM}← 看起来还不错{OFF}")
    print(f"    偶然一致率  {r_a.chance * 100:.0f}%")
    print(f"    {RED}kappa       {r_a.kappa:.3f}{OFF}   {RED}← 扣掉偶然之后什么都不剩{OFF}")

    print("\n  judge B —— 真的在判断，大约每 13 条错一条：")
    real = [
        ("fail" if h == "pass" else "pass") if i % 13 == 0 else h
        for i, h in enumerate(human)
    ]
    r_b = _M.agreement(real, human)
    print(f"    原始一致率  {r_b.raw * 100:.0f}%")
    print(f"    {GREEN}kappa       {r_b.kappa:.3f}{OFF}")

    print(f"\n  ★ 两个 judge 的原始一致率差 {(r_b.raw - r_a.raw) * 100:.0f} 个百分点，")
    print(f"  但 kappa 差 {r_b.kappa - r_a.kappa:.2f}——**原始一致率几乎分辨不出它们。**")

    print("\n  judge A 报出来的问题：")
    for p in r_a.problems:
        print(f"    · {p}")

    print("\n  ★ 经验数据（2026 年，21 个 judge、54 万次判断）：")
    print("  **原始一致率高估偶然校正后的一致性 33.8 到 41.3 个百分点，21 个模型无一例外。**")
    print("  表现最好的那个原始一致率 0.849，kappa 0.511。")
    print("\n  而这个差距的大小主要取决于**你的标签分布**，不取决于 judge 好坏：")
    print("    标签越均衡   → 偶然一致率越接近随机 → 两个数越接近")
    print("    标签越不均衡 → 多数类越能白拿分     → raw 越虚高")
    print("\n  所以规矩很简单：**报告里 kappa 是主指标，原始一致率只能当辅助。**")


def demo_judge_audit() -> None:
    print(f"\n【四】五步体检：每一步只抓得住一种退化\n{_line()}")

    N = 42
    # 真实的胜负：A 更好的占三分之二
    truth = ["B" if i % 3 == 0 else "A" for i in range(N)]

    # judge 甲：永远选 A 这个答案。不看位置，也不看内容。
    lazy = [
        PairedVerdict(ab="A", ba="A", len_a=100 + i, len_b=100 + (i % 7) * 10)
        for i in range(N)
    ]

    # ★ judge 乙：**只选排在前面的那个。**
    # 注意 AB 顺序下它给出的答案，和"A 更好"这个真相高度吻合
    #（因为 A 确实更常更好，而 A 恰好排在前面）——
    # 于是它的 kappa 会非常好看。
    positional = [
        PairedVerdict(
            ab=t,  # type: ignore[arg-type]  AB 顺序里排在前面的赢 = 恰好等于真相
            ba="B",  # BA 顺序里排在前面的是 B，它照样选前面那个
            len_a=100 + i,
            len_b=100 + (i % 7) * 10,
        )
        for i, t in enumerate(truth)
    ]

    # judge 丙：真的在判断，偶尔抖一下。
    # 长度故意用和真相不同的周期（2 vs 3），这样冗长偏见接近 0，
    # 于是这个 judge 只会被重测信度扣分——正好隔离出第四步的作用。
    fair = [
        PairedVerdict(
            ab=t,  # type: ignore[arg-type]
            ba=(("B" if t == "A" else "A") if i % 13 == 0 else t),  # type: ignore[arg-type]
            len_a=100 + (i % 2) * 60,
            len_b=100 + ((i + 1) % 2) * 60,
        )
        for i, t in enumerate(truth)
    ]

    def stable(labels: list[str]) -> list[list[str]]:
        return [labels, labels, labels]

    def jittery(labels: list[str]) -> list[list[str]]:
        return [
            [("B" if v == "A" else "A") if i % 19 == k else v for i, v in enumerate(labels)]
            for k in range(3)
        ]

    cases = [
        ("judge 甲：永远选 A 这个答案", lazy, stable([v.ab for v in lazy])),
        ("judge 乙：永远选排在前面那个  ★", positional, stable([v.ab for v in positional])),
        ("judge 丙：真的在判断", fair, jittery([v.ab for v in fair])),
    ]

    for name, paired, runs in cases:
        a = _M.audit_judge(
            judge_labels=[v.ab for v in paired],
            human_labels=truth,
            paired=paired,
            runs=runs,
        )
        print(f"\n  {name}")
        k_paint = GREEN if a.kappa >= 0.8 else RED if a.kappa < 0.4 else DIM
        print(f"    kappa        {k_paint}{a.kappa:.3f}{OFF}")
        tr_paint = GREEN if a.test_retest >= 0.9 else RED
        print(f"    重测信度      {tr_paint}{a.test_retest:.3f}{OFF}")
        pb_paint = RED if a.position_bias > 0.1 else GREEN
        print(f"    位置偏见      {pb_paint}{a.position_bias:.3f}{OFF}")
        print(f"    位置翻转率    {a.flip_rate * 100:.0f}%")
        print(f"    冗长偏见      {a.verbosity_bias:.3f}")
        print(f"    能上线吗      {GREEN + '可以' + OFF if a.deployable else RED + '不行' + OFF}")
        for p in a.problems:
            print(f"      · {p}")

    print("\n  ★ 看 judge 乙那一行，它是这个 demo 的全部意义：")
    print("")
    print("      kappa 完美（1.000）—— 和人工标注一条不差")
    print("      重测信度完美（1.000）—— 问一百次答案都一样")
    print(f"      {RED}而位置偏见 0.333{OFF}")
    print("")
    print('  它的实现是"**永远选排在前面的那个**"。')
    print("  kappa 那么好看只是因为你测的时候，更好的答案恰好多数排在前面。")
    print("  上线之后顺序一换，它的判断全部反过来——而 kappa 完全看不出这件事。")

    print("\n  ★ 这就是为什么五步一步都不能省：**每一步只抓得住一种退化。**")
    print("")
    print("      judge 甲  只被 kappa 抓住      （位置偏见是 0，因为它不看位置）")
    print("      judge 乙  只被位置互换抓住      （kappa 和重测信度都是满分）")
    print("      judge 丙  被重测信度扣了分      （它有抖动，但这是能修的那种问题）")
    print("")
    print("  少查任何一项，就会有一类 judge 带着漂亮的数字上线。")

    print("\n  ★ 而重测信度和位置偏见测的是**两种不同的扰动**：")
    print("    · 重测信度：同一个 prompt 问多次 —— 答案稳不稳")
    print("    · 位置偏见：把两个答案换个顺序 —— 语义上无关的扰动，答案变不变")
    print("  **确定性在第二种扰动上一分钱都不值。**")

    print("\n  2026 那项研究里有两个**已经在生产环境部署**的 judge 正好长这样：")
    print("    一个重测信度 0.992，位置偏见 0.192")
    print("    另一个重测信度 0.988，位置偏见 0.125")
    print("\n  论文原话：**最可复现的 judge 恰恰是最不可信的那些。**")
    print('\n  ★ 而这正是最坑的地方——"我的评测每次跑分都一样"听起来')
    print("  完全像是一件好事，于是没人会去查它。")

def demo_significance() -> None:
    print(f"\n【五】涨的那 2% 是真的吗\n{_line()}")

    for n in (50, 150, 500, 2000):
        scores = [1.0] * int(n * 0.8) + [0.0] * (n - int(n * 0.8))
        ci = _M.bootstrap_ci(scores, seed=42)
        width = (ci.hi - ci.lo) * 100
        print(
            f"  {n:>4} 条样本、成功率 80%  →  95% 区间 "
            f"[{ci.lo * 100:.1f}%, {ci.hi * 100:.1f}%]  宽 {width:.1f} 个百分点"
        )

    print("\n  ★ 看 150 条那一行：区间宽度大约 13 个百分点。")
    print("  也就是说你测出 80%，真值在 74% 到 86% 之间都不奇怪。")
    print('\n  那么"改动后从 80% 涨到 82%"意味着什么？**什么都不意味着。**')
    print("\n  而这件事的危险不在于你会做错一个决定，在于")
    print("  **你会做很多错决定，并且每次都觉得自己有数据支持。**")
    print("\n  ★ 注意最后一行：要把区间压到几个百分点，样本量得上千。")
    print('  所以现实的做法不是"攒一个巨大的评测集"，是')
    print("  **成对比较**（demo 六）——它能消掉样本难易带来的方差，")
    print("  在同样的样本量下功效高得多。")


def demo_regression() -> None:
    print(f"\n【六】净涨 2%，背后可能是换了一批 bug\n{_line()}")

    def clean() -> tuple[dict[str, float], dict[str, float]]:
        b = {f"c{i}": (1.0 if i < 70 else 0.0) for i in range(100)}
        a = {f"c{i}": (1.0 if i < 82 else 0.0) for i in range(100)}
        return b, a

    def swapped() -> tuple[dict[str, float], dict[str, float]]:
        b = {f"c{i}": (1.0 if i < 70 else 0.0) for i in range(100)}
        a = dict(b)
        for i in range(10):
            a[f"c{i}"] = 0.0  # 弄坏 10 个
        for i in range(70, 82):
            a[f"c{i}"] = 1.0  # 修好 12 个
        return b, a

    def jitter() -> tuple[dict[str, float], dict[str, float]]:
        b = {f"c{i}": (1.0 if i < 70 else 0.0) for i in range(100)}
        a = dict(b)
        a["c5"] = 0.0  # 弄坏 1 个
        a["c71"] = 1.0  # 修好 3 个 —— 净值和上一组一样是 +2
        a["c72"] = 1.0
        a["c73"] = 1.0
        return b, a

    for name, mk in [
        ("干净的改进", clean),
        ("★ 换了一批 bug（净涨 2%）", swapped),
        ("纯抖动", jitter),
    ]:
        b, a = mk()
        r = _M.compare_runs(b, a, seed=42)
        print(f"\n  {name}")
        sign = "+" if r.delta >= 0 else ""
        print(
            f"    {r.before * 100:.0f}% → {r.after * 100:.0f}%  "
            f"（{sign}{r.delta * 100:.0f} 个百分点）"
        )
        broken = f"{RED}{len(r.broken)}{OFF}" if r.broken else "0"
        print(f"    修好 {GREEN}{len(r.fixed)}{OFF} 个，弄坏 {broken} 个")
        print(
            f"    差值区间 [{r.ci.lo:.3f}, {r.ci.hi:.3f}]  "
            f"显著：{'是' if r.significant else '否'}"
        )
        print(f"    {r.verdict}")

    print("\n  ★ 看第二组和第三组：**净变化都是 +2 个百分点。**")
    print('  而一组是"修好 12 个弄坏 10 个"，另一组是"两三个 case 抖了一下"。')
    print("\n  只看那个 delta，两者完全一样。而它们要采取的行动完全不同：")
    print("    换了一批 bug  →  先看弄坏的那 10 个是什么。如果里面有付费客户")
    print("                      在用的路径，这个改动是**净负**的")
    print("    纯抖动        →  什么都没发生，别合并也别回滚，去把样本量加上去")
    print("\n  ★ 所以这个函数最重要的输出不是 delta，是 fixed 和 broken 两个列表。")
    print("  **净值会把这件事藏起来。**")


def demo_rot() -> None:
    print(f"\n【七】你的评测集正在腐化，而原因是你在正确地工作\n{_line()}")

    history: dict[str, list[float]] = {}
    for i in range(40):
        history[f"old-{i}"] = [1.0] * 6  # 早就修好了
    for i in range(8):
        history[f"new-{i}"] = [0.0, 1.0, 0.0, 1.0, 1.0, 1.0]  # 还在波动
    for i in range(3):
        history[f"stuck-{i}"] = [0.0] * 6  # 从来没过

    r = shared.detect_rot(history)
    total = len(r.live) + len(r.always_pass) + len(r.always_fail)
    print(f"  评测集 {total} 条，跑了 6 轮：")
    print(f"    {GREEN}还有区分度   {len(r.live)} 条{OFF}")
    print(f"    {DIM}一直全对     {len(r.always_pass)} 条{OFF}")
    print(f"    {RED}从来没过     {len(r.always_fail)} 条{OFF}")
    print(f"\n  {RED}只有 {len(r.live) / total * 100:.0f}% 的条目还能提供信息。{OFF}")
    for p in r.problems:
        print(f"    · {p}")

    print("\n  ★ 这件事必然发生，而且发生的原因正是你在正确地工作：")
    print("  你照着评测集修 bug，修完那些 case 就永远通过了。")
    print("  于是可用的信息在**单调减少**，而总分在**单调上升**。")
    print("\n  半年之后你有一个 96 分的评测集，其中 90% 的条目对任何改动都不敏感。")
    print("  那 96 分是真的，也是没用的。")
    print('\n  ★ 而"从来没过"那几条要单独看：**它可能是标注错了。**')
    print("  一个永远失败的 case 比一个永远成功的 case 更值得花五分钟人工确认——")
    print("  因为它会让你去修一个不存在的问题。")
    print("\n  下一节（L13）的可观测性，一半的用途就是给这个评测集持续补货。")


def demo_multiple() -> None:
    print(f"\n【八】你一次看了几个指标\n{_line()}")

    print("  改一个 prompt，顺手看了：总成功率、三种任务各自的成功率、")
    print("  平均步数、P95 延迟、token 花费。**那是 7 个比较。**\n")

    for k in (1, 5, 7, 20):
        r = _M.multiple_comparisons(k)
        paint = RED if r["p_any_false_positive"] > 0.2 else ""
        note = "  ← 一次 A/B 面板上的指标数量级" if k == 20 else ""
        print(
            f"  比 {k:>2} 个指标  →  至少一个假阳性的概率 "
            f"{paint}{r['p_any_false_positive'] * 100:>4.0f}%{OFF}"
            f"   Bonferroni 校正后阈值 α={r['adjusted_alpha']:.4f}{note}"
        )

    print("\n  ★ 看 7 那一行：30%。也就是说你三次里有一次会")
    print('  "发现"一个不存在的改进——而且你会觉得自己有数据支持。')
    r = _M.multiple_comparisons(7)
    print(f"\n  建议：{r['advice']}")
    print("\n  ★ 这一条只在 Python 侧有，理由不是语言差异，是**工具链差异**：")
    print("  多重比较校正的实现在 statsmodels 里，JS 生态没有等价物。")
    print("  而这正是 L11x 第八节那个结论的具体化：")
    print("  **agent 的运行时可以是 TS，评测和优化跑在 Python 里。**")


def main() -> None:
    print(f"\n{'═' * 66}")
    print(f"L12 · 评测：怎么不骗自己（实现：{IMPL}）")
    print("═" * 66)

    demos: list[tuple[str, Callable[[], None]]] = [
        ("一", demo_sampling),
        ("二", demo_routing),
        ("三", demo_kappa),
        ("四", demo_judge_audit),
        ("五", demo_significance),
        ("六", demo_regression),
        ("七", demo_rot),
        ("八", demo_multiple),
    ]

    for n, fn in demos:
        try:
            fn()
        except NotImplementedError as err:
            print(f"\n【{n}】{RED}还没实现：{err}{OFF}")

    print(f"\n{_line()}")
    print("接着跑 uv run python -m l12.regress —— 把这套东西接成一个能进 CI 的门禁。")


if __name__ == "__main__":
    main()
