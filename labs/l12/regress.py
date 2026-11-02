"""L12 的交付物：一个能进 CI 的评测门禁。跑法：

    cd labs && uv run python -m l12.regress

★ 这个脚本是这一节真正要交出去的东西。前面八个 TODO 是零件，
这里是把它们接成一道**会拦住你的门**。

而"会拦住你"是关键。一个只输出报告的评测，三周之后就没人看了。
门禁的价值在于它 exit 非 0，而 CI 会因此变红。

但门禁最难的部分不是判断逻辑，是**判什么才不会被绕过**。
下面五道判断，每一道都对应一种真实发生过的绕过方式。
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field

from shared.evals import (
    AgreementReport,  # noqa: F401  （给读代码的人指路：judge 体检里用得到）
    DiffResult,
    JudgeAudit,
    PairedVerdict,
    RotReport,
    audit_judge,
    compare_runs,
    detect_rot,
)

RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
DIM = "\033[2m"
OFF = "\033[0m"


def _line(n: int = 66) -> str:
    return "─" * n


@dataclass
class JudgeData:
    judge_labels: list[str]
    human_labels: list[str]
    paired: list[PairedVerdict]
    runs: list[list[str]]


@dataclass
class GateInput:
    baseline: dict[str, float]
    current: dict[str, float]
    history: dict[str, list[float]]
    judge: JudgeData | None
    comparisons: int = 1


@dataclass
class GateResult:
    blockers: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    diff: DiffResult | None = None
    rot: RotReport | None = None
    audit: JudgeAudit | None = None

    @property
    def passed(self) -> bool:
        return not self.blockers


def gate(inp: GateInput) -> GateResult:
    """五道闸。

    ★ 顺序是故意的：**先查评测本身可不可信，再看跑分。**

    因为一个坏了的评测会给出一个好看的分数，而如果你先看分数，
    你已经有了立场，之后再去看评测质量就很难客观。
    """
    r = GateResult()

    # ── 闸一：样本集没被换过 ────────────────────────────────
    #
    # ★ 这一道放第一位，因为它是最有效也最不引人注目的绕过方式：
    # 删掉几条不过的样本，跑分立刻上去，而 diff 里看不出异常
    # ——那几行只是从一个 JSON 文件里消失了。
    dropped = [i for i in inp.baseline if i not in inp.current]
    added = [i for i in inp.current if i not in inp.baseline]

    if dropped:
        r.blockers.append(
            f"{len(dropped)} 条基线样本在这次运行里消失了："
            f"{'、'.join(dropped[:5])}。"
            "★ 删样本能让任何跑分变好看。要删得单独提 PR 并写明理由，不能混在改动里"
        )
    if added:
        r.warnings.append(
            f"新增了 {len(added)} 条样本。它们不参与成对比较（没有基线），"
            "所以这次的对比只覆盖旧样本——新样本从下一轮开始算"
        )

    # ── 闸二：judge 可不可信 ────────────────────────────────
    #
    # ★ 在看跑分之前先查这个。一个位置偏见 0.19 的 judge 给出的分数，
    # 无论涨了还是跌了都不能用来做决定。
    if inp.judge is not None:
        r.audit = audit_judge(
            judge_labels=inp.judge.judge_labels,
            human_labels=inp.judge.human_labels,
            paired=inp.judge.paired,
            runs=inp.judge.runs,
        )
        if not r.audit.deployable:
            r.blockers.append(
                f"judge 没通过体检（kappa {r.audit.kappa:.2f}，"
                f"位置偏见 {r.audit.position_bias:.3f}）。"
                "★ 这道闸在跑分之前——一个偏的 judge 给出的分数，涨了跌了都不能用"
            )
            for p in r.audit.problems:
                r.warnings.append(f"judge：{p}")

    # ── 闸三：跑分本身 ──────────────────────────────────────
    r.diff = compare_runs(inp.baseline, inp.current)

    if r.diff.broken:
        # ★ 注意这里拦的是"弄坏了样本"，不是"净值下降"。
        # 净值可以是正的，同时你弄坏了十条。见 demo 六。
        msg = (
            f"弄坏了 {len(r.diff.broken)} 条原本通过的样本："
            f"{'、'.join(r.diff.broken[:5])}。"
        )
        if r.diff.delta > 0:
            msg += (
                f"★ 注意净值还是涨的（{r.diff.delta * 100:.0f} 个百分点）——"
                "**净值会把这件事藏起来。** 先看这几条是什么再决定合不合"
            )
        if r.diff.significant and r.diff.ci.hi < 0:
            r.blockers.append(msg)
        else:
            r.warnings.append(msg)

    if not r.diff.significant and r.diff.delta != 0:
        r.warnings.append(
            f"跑分变了 {r.diff.delta * 100:.1f} 个百分点，但差值区间 "
            f"[{r.diff.ci.lo:.3f}, {r.diff.ci.hi:.3f}] 跨过 0。"
            "★ 别把这个写进 PR 描述当成效果——在这个样本量下它是噪声"
        )

    # ── 闸四：评测集还有没有区分度 ──────────────────────────
    r.rot = detect_rot(inp.history)
    total = len(r.rot.live) + len(r.rot.always_pass) + len(r.rot.always_fail)
    if total and len(r.rot.live) / total < 0.3:
        r.warnings.append(
            f"只有 {len(r.rot.live)}/{total} 条样本还有区分度。"
            "★ 这道闸不拦你合并，但它在说：**这个门禁快要失效了。** 该补新样本了"
        )
    for p in r.rot.problems:
        if "从来没通过" in p:
            r.warnings.append(p)

    # ── 闸五：这一轮看了几个指标 ────────────────────────────
    #
    # ★ 最容易被漏的一道，因为它不查数据，查的是**你的行为**。
    if inp.comparisons > 3:
        p_any = 1 - 0.95**inp.comparisons
        r.warnings.append(
            f'这一轮比了 {inp.comparisons} 个指标，"至少一个假阳性"的概率是 '
            f"{p_any * 100:.0f}%。★ 先声明唯一的主指标，其余只当探索性观察"
        )

    return r


# ─────────────────────────────────────────────────────────────


def scenario() -> GateInput:
    """造一次"看起来是改进，其实弄坏了一批"的 PR。"""
    baseline = {f"c{i}": (1.0 if i < 84 else 0.0) for i in range(120)}
    current = dict(baseline)
    for i in range(84, 98):
        current[f"c{i}"] = 1.0  # 修好 14 个
    for i in range(9):
        current[f"c{i}"] = 0.0  # 悄悄弄坏 9 个
    del current["c110"]  # 顺手删掉两条一直不过的
    del current["c111"]

    history = {
        f"c{i}": (
            [1.0] * 4 if i < 84 else [0.0, 1.0, 0.0, 1.0] if i < 100 else [0.0] * 4
        )
        for i in range(120)
    }

    human = ["B" if i % 4 == 0 else "A" for i in range(30)]
    paired = [
        PairedVerdict(ab="A", ba="A" if i % 6 == 0 else "B", len_a=200, len_b=100)
        for i in range(30)
    ]

    return GateInput(
        baseline=baseline,
        current=current,
        history=history,
        judge=JudgeData(
            judge_labels=[v.ab for v in paired],
            human_labels=human,
            paired=paired,
            runs=[[v.ab for v in paired] for _ in range(3)],
        ),
        comparisons=6,
    )


def main() -> int:
    print(f"\n{'═' * 66}")
    print("L12 · 评测门禁（这就是这一节的交付物）")
    print("═" * 66)

    r = gate(scenario())
    assert r.diff is not None

    print("\n场景：一个 PR，改了 prompt。表面上的数字：")
    sign = "+" if r.diff.delta >= 0 else ""
    print(
        f"  {r.diff.before * 100:.0f}% → {r.diff.after * 100:.0f}%  "
        f"（{sign}{r.diff.delta * 100:.1f} 个百分点）"
    )
    print(f'{DIM}  提 PR 的人在描述里写了"评测涨了 4 个点"。{OFF}')

    print(f"\n{_line()}")

    if r.blockers:
        print(f"{RED}\n拦下（{len(r.blockers)} 条）：{OFF}")
        for b in r.blockers:
            print(f"  {RED}✕{OFF} {b}\n")
    if r.warnings:
        print(f"{YELLOW}提醒（{len(r.warnings)} 条）：{OFF}")
        for w in r.warnings:
            print(f"  {YELLOW}!{OFF} {w}\n")

    print(_line())
    print(
        f"{GREEN}\n门禁通过。{OFF}"
        if r.passed
        else f"{RED}\n门禁拦下。CI 应该红。{OFF}"
    )

    print("\n★ 这个场景里有三件事同时在发生，而 PR 描述只提了第一件：")
    print(f"  1. 修好了 {len(r.diff.fixed)} 条  {DIM}← 描述里写的{OFF}")
    print(f"  2. 弄坏了 {len(r.diff.broken)} 条  {RED}← 净值把它藏起来了{OFF}")
    print(f"  3. 删掉了 2 条一直不过的样本  {RED}← diff 里只是两行 JSON 消失{OFF}")
    pb = r.audit.position_bias if r.audit else 0.0
    print(f"\n  再加上那个 judge 位置偏见 {pb:.3f}——")
    print("  **这个跑分从一开始就不该被当成证据。**")

    print("\n★ 五道闸的顺序是故意的：**先查评测本身可不可信，再看跑分。**")
    print("  因为一个坏了的评测会给出好看的分数，而如果你先看分数，")
    print("  你已经有了立场，之后再去看评测质量就很难客观了。")

    print("\n★ 而最后一道闸（看了几个指标）查的不是数据，是**你的行为**。")
    print("  它是唯一一道你没法靠改代码通过的闸。")

    return 0 if r.passed else 1


if __name__ == "__main__":
    sys.exit(main())
