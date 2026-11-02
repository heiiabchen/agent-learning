"""验证 l18/bench.py。跑法：BENCH_IMPL=shared uv run python -m l18.verify"""

from __future__ import annotations

import json
import math
import os
from typing import Any

from shared import coding_eval as shared
from shared.coding import HackEvidence, HackFinding
from shared.coding_eval import Attempt, TaskInstance

TARGET = "shared" if os.environ.get("BENCH_IMPL") == "shared" else "mine"


class _Mine:
    def __init__(self) -> None:
        from l18 import bench as m

        self.validate_task_set = m.my_validate_task_set
        self.classify_attempt = m.my_classify_attempt
        self.rate_spectrum = m.my_rate_spectrum
        self.cost_curve = m.my_cost_curve
        self.ablation_table = m.my_ablation_table
        self.coding_gate = m.my_coding_gate
        self.resolve_rate = shared.resolve_rate
        self.paired_ab = shared.paired_ab
        self.is_resolved = shared.is_resolved
        self.primary_tasks = shared.primary_tasks
        self.apply_rate = shared.apply_rate
        self.pass_at_k = shared.pass_at_k
        self.pass_hat_k = shared.pass_hat_k
        self.demo_tasks = m.demo_tasks
        self.demo_baseline = m.demo_baseline
        self.demo_candidate = m.demo_candidate


M: Any = shared if TARGET == "shared" else _Mine()
if TARGET == "shared":
    from l18.bench import demo_baseline, demo_candidate, demo_tasks

    M.demo_tasks = demo_tasks
    M.demo_baseline = demo_baseline
    M.demo_candidate = demo_candidate

print("\n（测的是 shared/ 里的参考实现）" if TARGET == "shared" else "\n（测的是 l18/ 里你的实现）")

DIM, BOLD, RED, GREEN, OFF = "\x1b[2m", "\x1b[1m", "\x1b[31m", "\x1b[32m", "\x1b[0m"
passed = 0
failed = 0


def ok(cond: bool, name: str) -> None:
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"{RED}  ✗ {name}{OFF}")


def eq(a: Any, b: Any, name: str) -> None:
    as_, bs = json.dumps(a, ensure_ascii=False, sort_keys=True), json.dumps(
        b, ensure_ascii=False, sort_keys=True
    )
    ok(as_ == bs, name if as_ == bs else f"{name} (got {as_}, want {bs})")


def section(title: str) -> None:
    print(f"{BOLD}\n{title}{OFF}")


def att(task_id: str, **flags: Any) -> Attempt:
    return Attempt(
        task_id=task_id,
        variant=flags.get("variant", "v"),
        patch_applied=flags["patch_applied"],
        fail_to_pass_green=flags["fail_to_pass_green"],
        pass_to_pass_green=flags["pass_to_pass_green"],
        tests_mutated=flags.get("tests_mutated", False),
        hack_findings=flags.get("hack_findings", []),
        errored=flags.get("errored", False),
        tokens=flags.get("tokens", 100),
        cost_usd=flags.get("cost_usd", 0.1),
        latency_ms=flags.get("latency_ms", 100),
    )


section("A · 任务集")
good = M.demo_tasks()
vr = M.validate_task_set(good)
ok(vr.ok, "SET-1 完整集 ok")
eq(vr.by_difficulty, {"easy": 4, "medium": 4, "hard": 4}, "SET-2 分层计数")
eq(vr.contaminated_ids, ["c-easy"], "SET-3 污染列出")

bad = [
    TaskInstance(id="x", difficulty="easy", fail_to_pass=[], pass_to_pass=[], repo_pin=""),
    TaskInstance(id="x", difficulty="easy", fail_to_pass=["t"], pass_to_pass=[], repo_pin="r@1"),
]
br = M.validate_task_set(bad)
ok(not br.ok, "SET-4 坏集 not ok")
ok(any("failToPass" in g for g in br.gaps), "SET-5 缺 f2p")
ok(any("重复" in g for g in br.gaps), "SET-6 重复 id")
ok(any("repoPin" in g for g in br.gaps), "SET-7 缺 pin")
ok(all(t.id != "c-easy" for t in M.primary_tasks(good)), "SET-8 primary 去污染")
ok(any("空" in g for g in M.validate_task_set([]).gaps), "SET-9 空集")

section("B · Attempt 判定")
eq(
    M.classify_attempt(
        att("a", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True)
    ),
    "resolved",
    "CLS-1 resolved",
)
eq(
    M.classify_attempt(
        att("a", patch_applied=True, fail_to_pass_green=False, pass_to_pass_green=True)
    ),
    "applied_only",
    "CLS-2 applied_only",
)
eq(
    M.classify_attempt(
        att("a", patch_applied=False, fail_to_pass_green=False, pass_to_pass_green=True)
    ),
    "failed",
    "CLS-3 failed",
)
eq(
    M.classify_attempt(
        att(
            "a",
            patch_applied=True,
            fail_to_pass_green=True,
            pass_to_pass_green=True,
            tests_mutated=True,
        )
    ),
    "hacked",
    "CLS-4 testsMutated",
)
eq(
    M.classify_attempt(
        att(
            "a",
            patch_applied=True,
            fail_to_pass_green=True,
            pass_to_pass_green=True,
            hack_findings=[HackFinding(rule="X", severity="block", evidence=HackEvidence())],
        )
    ),
    "hacked",
    "CLS-5 hack block",
)
eq(
    M.classify_attempt(
        att(
            "a",
            patch_applied=True,
            fail_to_pass_green=True,
            pass_to_pass_green=True,
            hack_findings=[HackFinding(rule="X", severity="warn", evidence=HackEvidence())],
        )
    ),
    "resolved",
    "CLS-6 hack warn 仍可 resolved",
)
eq(
    M.classify_attempt(
        att(
            "a",
            patch_applied=True,
            fail_to_pass_green=True,
            pass_to_pass_green=True,
            errored=True,
        )
    ),
    "error",
    "CLS-7 error",
)
eq(
    M.classify_attempt(
        att("a", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=False)
    ),
    "applied_only",
    "CLS-8 p2p 破 → 非 resolved",
)

section("C · 成功率口径")
base = M.demo_baseline()
spec = M.rate_spectrum(base)
ok(spec.resolve.rate < spec.apply.rate, "RATE-1 resolve < apply")
ok(spec.resolve.rate < spec.fail_to_pass_only.rate, "RATE-2 resolve < f2p-only")
ok(spec.resolve.rate <= spec.naive_including_hacks.rate, "RATE-3 resolve ≤ naive")
ok(spec.resolve.hits == 6, "RATE-4 baseline resolve hits=6（含污染题）")
prim = [a for a in base if a.task_id != "c-easy"]
ok(M.resolve_rate(prim).hits == 5, "RATE-5 去污染后 hits=5")
ok(spec.apply.ci.lo <= spec.apply.rate <= spec.apply.ci.hi, "RATE-6 Wilson 含点估计")

by_task = {
    "t1": [
        att("t1", patch_applied=True, fail_to_pass_green=False, pass_to_pass_green=True),
        att("t1", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True),
    ],
    "t2": [
        att("t2", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True),
        att("t2", patch_applied=True, fail_to_pass_green=True, pass_to_pass_green=True),
    ],
    "t3": [
        att("t3", patch_applied=False, fail_to_pass_green=False, pass_to_pass_green=True),
        att("t3", patch_applied=False, fail_to_pass_green=False, pass_to_pass_green=True),
    ],
}
eq(M.pass_at_k(by_task, 2).hits, 2, "RATE-7 pass@2 hits")
eq(M.pass_hat_k(by_task, 2).hits, 1, "RATE-8 pass^2 hits")
ok(M.pass_hat_k(by_task, 2).rate < M.pass_at_k(by_task, 2).rate, "RATE-9 pass^k < pass@k")

section("D · 成本曲线")
curve = M.cost_curve(base, 4)
ok(len(curve) == 4, "COST-1 四桶")
ok(all(b.n > 0 for b in curve), "COST-2 每桶非空")
# 排序后 0.01 0.02 0.02 | 0.03 0.07 0.08 | 0.09 0.10 0.40 | 0.50 0.60 0.80，每桶 3 条
eq(
    [[b.lo, b.n] for b in curve],
    [[0.01, 3], [0.03, 3], [0.09, 3], [0.5, 3]],
    "COST-3 按花费排序后切桶",
)
ok(
    all(i == len(curve) - 1 or b.hi <= curve[i + 1].lo for i, b in enumerate(curve))
    and math.isinf(curve[-1].hi),
    "COST-3b 桶首尾相接，末桶上界 Infinity",
)
# 严格口径：m4 改过测试不算，m2/h1 F2P 没绿
eq([round(b.resolve_rate * b.n) for b in curve], [3, 2, 1, 0], "COST-4 每桶 resolve 数：越贵越少")
ok(len(M.cost_curve([], 4)) == 0, "COST-5 空输入")
with_error = [
    *base,
    att(
        "x",
        patch_applied=True,
        fail_to_pass_green=True,
        pass_to_pass_green=True,
        errored=True,
        cost_usd=9,
    ),
]
eq([b.n for b in M.cost_curve(with_error, 4)], [3, 3, 3, 3], "COST-6 error 不进任何桶")
eq([b.n for b in M.cost_curve(base[:10], 4)], [2, 2, 2, 4], "COST-7 末桶吃掉余数")

section("E · 消融")
full = [Attempt(**{**a.__dict__, "variant": "full"}) for a in base]
no_verify = [
    att(
        a.task_id,
        variant="no-verify",
        patch_applied=True,
        fail_to_pass_green=True,
        pass_to_pass_green=True,
        tests_mutated=True,
        cost_usd=a.cost_usd * 0.5,
    )
    if a.task_id.startswith("m")
    else Attempt(**{**a.__dict__, "variant": "no-verify", "cost_usd": a.cost_usd * 0.7})
    for a in full
]
rows = M.ablation_table({"full": full, "no-verify": no_verify}, "full")
ok(len(rows) == 2, "ABL-1 两行")
nv = next(r for r in rows if r.config == "no-verify")
ok(nv.delta_vs_baseline < 0, "ABL-2 no-verify resolve 下降")
# m1、m3 从 resolved 变 hacked（m4 本来就是）：6/12 → 4/12，成对差值两个 −1，不 decisive
eq(
    [round(nv.delta_vs_baseline * 12), nv.decisive],
    [-2, False],
    "ABL-3 Δ = −2/12，N=12 上不 decisive",
)
threw = False
try:
    M.ablation_table({"full": full}, "missing")
except Exception:
    threw = True
ok(threw, "ABL-4 缺 baseline 抛错")
eq(
    [r.config for r in M.ablation_table({"full": full, "a": full, "B": full, "_x": full}, "full")],
    ["B", "_x", "a", "full"],
    "ABL-5 按码点排序（不是 localeCompare）",
)

section("F · A/B 与门禁")
ab = M.paired_ab(M.demo_baseline(), M.demo_candidate())
ok(len(ab.only_a) >= 3, "AB-1 弄坏 ≥3")
ok(len(ab.only_b) >= 1, "AB-2 有修好")
gate = M.coding_gate(tasks=M.demo_tasks(), baseline=M.demo_baseline(), candidate=M.demo_candidate())
ok(not gate.pass_, "GATE-1 坏候选拦截")
ok(any("hacked" in b or "弄坏" in b for b in gate.blockers), "GATE-2 理由含 hack 或弄坏")

clean_cand = []
for a in M.demo_baseline():
    if a.task_id in ("h1", "m4"):
        clean_cand.append(
            att(
                a.task_id,
                variant="clean",
                patch_applied=True,
                fail_to_pass_green=True,
                pass_to_pass_green=True,
                cost_usd=a.cost_usd,
            )
        )
    else:
        clean_cand.append(
            Attempt(
                **{
                    **a.__dict__,
                    "variant": "clean",
                    "tests_mutated": False,
                    "hack_findings": [],
                }
            )
        )
gate2 = M.coding_gate(
    tasks=M.demo_tasks(),
    baseline=M.demo_baseline(),
    candidate=clean_cand,
    mode="regress",
)
ok(gate2.pass_ is True, "GATE-3 regress：+1 不显著仍通过")
ok(any("不显著" in w for w in gate2.warnings), "GATE-3b regress：警告改用 claim")
gate2c = M.coding_gate(
    tasks=M.demo_tasks(),
    baseline=M.demo_baseline(),
    candidate=clean_cand,
    mode="claim",
)
ok(
    (not gate2c.pass_) and any("不显著" in b for b in gate2c.blockers),
    "GATE-6 claim：同数据不可宣称",
)
ok(gate2c.claimable is False, "GATE-6b claimable=false")

swapped = [a for a in M.demo_baseline() if a.task_id != "h4"]
gate3 = M.coding_gate(tasks=M.demo_tasks(), baseline=M.demo_baseline(), candidate=swapped)
ok((not gate3.pass_) and any("缺少任务" in b for b in gate3.blockers), "GATE-4 样本集被换")

# h2 从「补丁没落下」变成「落下了但 F2P 没绿」；m4 去掉改测试、F2P 也不绿。
# apply 10/11 → 11/11，resolve 5/11 不变，没有 hack、没有弄坏——门禁放行，只靠警告说话
apply_only = [
    att(
        a.task_id,
        patch_applied=True,
        fail_to_pass_green=False,
        pass_to_pass_green=True,
        cost_usd=a.cost_usd,
    )
    if a.task_id in ("h2", "m4")
    else a
    for a in M.demo_baseline()
]
gate4 = M.coding_gate(tasks=M.demo_tasks(), baseline=M.demo_baseline(), candidate=apply_only)
ok(
    gate4.pass_ and any("apply↑" in w for w in gate4.warnings),
    "GATE-5 apply↑resolve 未↑：放行但必须警告",
)
ok(not any("apply" in w for w in gate2.warnings), "GATE-5b apply 没涨不警告")

# 主任务集 11 题全修好、无 hack：onlyB = 6、onlyA = 0，成对 CI 下界 > 0
all_fixed = [
    att(
        a.task_id,
        patch_applied=True,
        fail_to_pass_green=True,
        pass_to_pass_green=True,
        cost_usd=a.cost_usd,
    )
    for a in M.demo_baseline()
]
gate7 = M.coding_gate(
    tasks=M.demo_tasks(), baseline=M.demo_baseline(), candidate=all_fixed, mode="claim"
)
ok(gate7.pass_ and gate7.claimable, "GATE-7 claim：显著更好 → claimable")
gate7r = M.coding_gate(tasks=M.demo_tasks(), baseline=M.demo_baseline(), candidate=all_fixed)
ok(gate7r.pass_ and not gate7r.claimable, "GATE-7b regress 下 claimable 恒为 false")

section("H · 双语言格式化")
eq(
    [
        shared.fmt_fixed(0.0625, 3),
        shared.fmt_fixed(-0.0625, 3),
        shared.fmt_fixed(2.5, 0),
        shared.fmt_fixed((1 / 40) * 100, 0),
        shared.fmt_fixed(-0.0, 0),
        shared.fmt_fixed(0.125, 2),
    ],
    ["0.063", "-0.063", "3", "3", "0", "0.13"],
    "FMT-1 精确平局远离零，-0 记作 0",
)

section("G · demo 夹具自洽")
ok(len(M.demo_tasks()) == 12, "FIX-1 12 题")
ok(len(M.demo_baseline()) == 12, "FIX-2 baseline 12")
ok(len(M.demo_candidate()) == 12, "FIX-3 candidate 12")

print()
if failed == 0:
    print(f"{GREEN}  ✓ {passed} 条断言全部通过{OFF}")
    print(
        f"{DIM}\n  最该记住的六条：\n"
        "    SET     缺 failToPass / 缺分层 → 主指标作废\n"
        "    CLS     改测试 = hacked，不是 resolved\n"
        "    RATE    海报「成功率」可能是 apply 或 f2p-only\n"
        "    COST    最贵桶常常是空转\n"
        "    AB      先看 onlyA/onlyB，再看净值\n"
        f"    GATE    regress=非劣；claim=优效；两门不要合成一个\n{OFF}"
    )
    raise SystemExit(0)
print(f"{RED}  ✗ {failed} 失败 / {passed} 通过{OFF}")
raise SystemExit(1)
