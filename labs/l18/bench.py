"""L18 的脚手架。跑法：uv run python -m l18.bench

上半：观察实验——同一批 Attempt 记录，四种「成功率」、成本曲线、
消融、成对 A/B、门禁分别给出不同结论。全程零模型调用。

下半：六个 TODO。写完跑 uv run python -m l18.verify。
"""

from __future__ import annotations

import math
import re
from typing import Literal

from shared.coding_eval import (
    Attempt,
    TaskInstance,
    ablation_table,
    classify_attempt,
    coding_gate,
    cost_curve,
    fmt_fixed,
    paired_ab,
    rate_spectrum,
    resolve_rate,
    validate_task_set,
)

DIM = "\x1b[2m"
BOLD = "\x1b[1m"
RED = "\x1b[31m"
GREEN = "\x1b[32m"
OFF = "\x1b[0m"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def dim(s: str) -> str:
    return f"{DIM}{s}{OFF}"


def bold(s: str) -> str:
    return f"{BOLD}{s}{OFF}"


def red(s: str) -> str:
    return f"{RED}{s}{OFF}"


def green(s: str) -> str:
    return f"{GREEN}{s}{OFF}"


def _w(s: str) -> int:
    s = _ANSI.sub("", s)
    return sum(2 if "\u2e80" <= c <= "\u9fff" or "\uff00" <= c <= "\uffef" else 1 for c in s)


def pad(s: str, n: int) -> str:
    return s + " " * max(0, n - _w(s))


def pct(x: float) -> str:
    return f"{fmt_fixed(x * 100, 0)}%"


def demo_tasks() -> list[TaskInstance]:
    def mk(
        id_: str,
        difficulty: Literal["easy", "medium", "hard"],
        contaminated: bool = False,
    ) -> TaskInstance:
        return TaskInstance(
            id=id_,
            difficulty=difficulty,
            fail_to_pass=[f"tests/test_{id_}.py::test_fix"],
            pass_to_pass=[f"tests/test_{id_}.py::test_smoke"],
            repo_pin=f"demo/repo@{id_}",
            contaminated=contaminated,
        )

    return [
        mk("e1", "easy"),
        mk("e2", "easy"),
        mk("e3", "easy"),
        mk("c-easy", "easy", True),
        mk("m1", "medium"),
        mk("m2", "medium"),
        mk("m3", "medium"),
        mk("m4", "medium"),
        mk("h1", "hard"),
        mk("h2", "hard"),
        mk("h3", "hard"),
        mk("h4", "hard"),
    ]


def att(
    task_id: str,
    variant: str,
    *,
    patch_applied: bool,
    fail_to_pass_green: bool,
    pass_to_pass_green: bool,
    tests_mutated: bool = False,
    hack_findings: list | None = None,
    errored: bool = False,
    error_reason: str | None = None,
    tokens: int = 1000,
    cost_usd: float = 0.05,
    latency_ms: int = 1000,
) -> Attempt:
    return Attempt(
        task_id=task_id,
        variant=variant,
        patch_applied=patch_applied,
        fail_to_pass_green=fail_to_pass_green,
        pass_to_pass_green=pass_to_pass_green,
        tests_mutated=tests_mutated,
        hack_findings=hack_findings if hack_findings is not None else [],
        errored=errored,
        error_reason=error_reason,
        tokens=tokens,
        cost_usd=cost_usd,
        latency_ms=latency_ms,
    )


def demo_baseline() -> list[Attempt]:
    return [
        att("e1", "base", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True, cost_usd=0.02),
        att("e2", "base", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True, cost_usd=0.03),
        att("e3", "base", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True, cost_usd=0.02),
        att("c-easy", "base", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True, cost_usd=0.01),
        att("m1", "base", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True, cost_usd=0.08),
        att("m2", "base", patch_applied=True, fail_to_pass_green=False, pass_to_pass_green=True, cost_usd=0.1),
        att("m3", "base", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True, cost_usd=0.09),
        att(
            "m4",
            "base",
            patch_applied=True,
            fail_to_pass_green=True,
            pass_to_pass_green=True,
            tests_mutated=True,
            cost_usd=0.07,
        ),
        att("h1", "base", patch_applied=True, fail_to_pass_green=False, pass_to_pass_green=True, cost_usd=0.4),
        att("h2", "base", patch_applied=False, fail_to_pass_green=False, pass_to_pass_green=True, cost_usd=0.5),
        att("h3", "base", patch_applied=True, fail_to_pass_green=False, pass_to_pass_green=True, cost_usd=0.6),
        att(
            "h4",
            "base",
            patch_applied=True,
            fail_to_pass_green=False,
            pass_to_pass_green=True,
            cost_usd=0.8,
            tokens=8000,
        ),
    ]


def demo_candidate() -> list[Attempt]:
    return [
        att("e1", "cand", patch_applied=True, fail_to_pass_green=False, pass_to_pass_green=True, cost_usd=0.02),
        att("e2", "cand", patch_applied=True, fail_to_pass_green=False, pass_to_pass_green=True, cost_usd=0.02),
        att("e3", "cand", patch_applied=True, fail_to_pass_green=False, pass_to_pass_green=True, cost_usd=0.02),
        att("c-easy", "cand", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True, cost_usd=0.01),
        att("m1", "cand", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True, cost_usd=0.08),
        att("m2", "cand", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True, cost_usd=0.08),
        att("m3", "cand", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True, cost_usd=0.08),
        att("m4", "cand", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True, cost_usd=0.08),
        att(
            "h1",
            "cand",
            patch_applied=True,
            fail_to_pass_green=True,
            pass_to_pass_green=True,
            tests_mutated=True,
            cost_usd=0.2,
        ),
        att(
            "h2",
            "cand",
            patch_applied=True,
            fail_to_pass_green=True,
            pass_to_pass_green=True,
            tests_mutated=True,
            cost_usd=0.2,
        ),
        att(
            "h3",
            "cand",
            patch_applied=True,
            fail_to_pass_green=True,
            pass_to_pass_green=True,
            tests_mutated=True,
            cost_usd=0.2,
        ),
        att("h4", "cand", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True, cost_usd=0.25),
    ]


def exp1() -> None:
    print(bold("\n实验一：同一批 Attempt，四种「成功率」"))
    attempts = demo_baseline()
    s = rate_spectrum(attempts)
    print(f"  {pad('口径', 22)}{pad('比率', 10)}命中/N")
    print("  " + "─" * 44)
    for r in (s.apply, s.fail_to_pass_only, s.naive_including_hacks, s.resolve):
        print(f"  {pad(r.label, 22)}{pad(pct(r.rate), 10)}{r.hits}/{r.n}")
    print(
        dim("\n  resolve 最低：它要求补丁落下、f2p 绿、p2p 绿、且没改测试。")
        + dim("\n  naive+hacks 把改测试也算成功——这是海报最爱的口径。")
    )


def exp2() -> None:
    print(bold("\n实验二：N=10 时，翻 1 题等于 ±10 个百分点"))
    ids = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]
    a = [
        att(
            id_,
            "n10",
            patch_applied=True,
            fail_to_pass_green=i < 8,
            pass_to_pass_green=True,
            cost_usd=0.05,
        )
        for i, id_ in enumerate(ids)
    ]
    b = [
        att(
            x.task_id,
            "n10",
            patch_applied=True,
            fail_to_pass_green=True,
            pass_to_pass_green=True,
            cost_usd=0.05,
        )
        if i == 8
        else x
        for i, x in enumerate(a)
    ]
    ra = resolve_rate(a)
    rb = resolve_rate(b)
    print(f"  {pad('版本', 14)}{pad('resolve', 10)}Wilson 95% CI")
    print("  " + "─" * 48)
    print(
        f"  {pad('翻题前 8/10', 14)}{pad(pct(ra.rate), 10)}"
        f"[{fmt_fixed(ra.ci.lo, 2)}, {fmt_fixed(ra.ci.hi, 2)}]"
    )
    print(
        f"  {pad('翻题后 9/10', 14)}{pad(pct(rb.rate), 10)}"
        f"[{fmt_fixed(rb.ci.lo, 2)}, {fmt_fixed(rb.ci.hi, 2)}]"
    )
    print(dim("\n  两个区间严重重叠。±10pp 的海报差异在 N=10 下常常什么都不证明。"))


def exp3() -> None:
    print(bold("\n实验三：花费升，resolve 不一定升"))
    curve = cost_curve(demo_baseline(), 4)
    print(f"  {pad('花费桶', 18)}{pad('n', 6)}{pad('resolve', 10)}均价")
    print("  " + "─" * 44)
    for b in curve:
        label = (
            f"≥${fmt_fixed(b.lo, 2)}"
            if math.isinf(b.hi)
            else f"${fmt_fixed(b.lo, 2)}–{fmt_fixed(b.hi, 2)}"
        )
        print(
            f"  {pad(label, 18)}{pad(str(b.n), 6)}{pad(pct(b.resolve_rate), 10)}"
            f"${fmt_fixed(b.mean_cost, 2)}"
        )
    print(dim("\n  最贵那一桶往往是 hard 上空转——账单上升，问题仍未解决。"))


def exp4() -> None:
    print(bold("\n实验四：拿掉 verify-before-stop 的消融"))
    base = [Attempt(**{**a.__dict__, "variant": "full"}) for a in demo_baseline()]
    # 无 verify：medium 上靠改测试「假绿」，花费下降，resolve 用严格口径会掉
    no_verify: list[Attempt] = []
    for a in demo_baseline():
        if a.task_id.startswith("m"):
            no_verify.append(
                att(
                    a.task_id,
                    "no-verify",
                    patch_applied=True,
                    fail_to_pass_green=True,
                    pass_to_pass_green=True,
                    tests_mutated=True,
                    cost_usd=a.cost_usd * 0.4,
                )
            )
        else:
            no_verify.append(
                Attempt(
                    **{
                        **a.__dict__,
                        "variant": "no-verify",
                        "cost_usd": a.cost_usd * 0.7,
                    }
                )
            )
    rows = ablation_table({"full": base, "no-verify": no_verify}, "full")
    print(f"  {pad('配置', 14)}{pad('resolve', 10)}{pad('Δ', 8)}decisive")
    print("  " + "─" * 42)
    for r in rows:
        d = f"{'+' if r.delta_vs_baseline >= 0 else ''}{fmt_fixed(r.delta_vs_baseline * 100, 0)}pp"
        print(f"  {pad(r.config, 14)}{pad(pct(r.resolve_rate), 10)}{pad(d, 8)}{'yes' if r.decisive else 'no'}")
    print(
        dim("\n  no-verify 的 resolve 用严格口径会掉（hacked 不算过）。")
        + dim("\n  若海报改用 f2p-only，它会看起来像「又快又好」。")
    )


def exp5() -> None:
    print(bold("\n实验五：非成对 Δ=0，成对门禁仍拦住「换了一批 bug」"))
    tasks = demo_tasks()
    gate = coding_gate(tasks=tasks, baseline=demo_baseline(), candidate=demo_candidate())
    ab = paired_ab(demo_baseline(), demo_candidate())
    print(f"  非成对 Δresolve：{fmt_fixed(ab.unpaired_delta * 100, 0)}pp")
    print(f"  成对 onlyA（弄坏）：{', '.join(ab.only_a) or '—'}")
    print(f"  成对 onlyB（修好）：{', '.join(ab.only_b) or '—'}")
    print(f"  门禁：{green('PASS') if gate.pass_ else red('BLOCK')}")
    for b in gate.blockers:
        print(f"    - {b}")
    for w in gate.warnings:
        print(f"    · {w}")
    ts = validate_task_set(tasks)
    print(dim(f"\n  任务集 gaps={len(ts.gaps)}；污染 id={','.join(ts.contaminated_ids) or '—'}"))
    print(dim("  净值可以是正的，同时你在拿三个 easy 换「改测试过的 hard」。"))


def observe() -> None:
    print(bold("L18 · 观察实验（参考实现）"))
    print(dim("跑完这些再去写 TODO。每一张表都对应一种「好看的假进步」。"))
    exp1()
    exp2()
    exp3()
    exp4()
    exp5()


# ═════════════════════════════════════════════════════════════
# 下半：TODO
# ═════════════════════════════════════════════════════════════


def my_validate_task_set(tasks: list[TaskInstance]):
    raise NotImplementedError("TODO 1 未实现")


def my_classify_attempt(a: Attempt):
    raise NotImplementedError("TODO 2 未实现")


def my_rate_spectrum(attempts: list[Attempt]):
    raise NotImplementedError("TODO 3 未实现")


def my_cost_curve(attempts: list[Attempt], bucket_count: int | None = None):
    raise NotImplementedError("TODO 4 未实现")


def my_ablation_table(by_config: dict[str, list[Attempt]], baseline: str):
    raise NotImplementedError("TODO 5 未实现")


def my_coding_gate(input: object):
    raise NotImplementedError("TODO 6 未实现")


_ = (
    my_validate_task_set,
    my_classify_attempt,
    my_rate_spectrum,
    my_cost_curve,
    my_ablation_table,
    my_coding_gate,
)

if __name__ == "__main__":
    observe()
    print(
        dim(
            "\n  下一步：实现文件下半部分的六个 TODO，然后跑 pnpm verify:l18（或 uv run python -m l18.verify）。"
        )
        + dim("\n  想先确认测试本身是对的，跑 BENCH_IMPL=shared 下的 verify。")
        + dim("\n  观察实验：pnpm bench / uv run python -m l18.bench\n")
    )
