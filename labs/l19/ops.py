"""L19 的脚手架。跑法：uv run python -m l19.ops

观察实验：断线续跑、幂等双花、配额公平、审批记忆作用域、drain/kill。
全程零模型。写完六个 TODO 跑 uv run python -m l19.verify。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from shared.ops import (
    ApprovalMemory,
    ApprovalQuery,
    Checkpoint,
    DeployState,
    EffectRecord,
    EffectRequest,
    HealthCheckInput,
    Job,
    JobStatus,
    QuotaPolicy,
    StartJobInput,
    TransitionApprove,
    TransitionCancel,
    TransitionCheckpoint,
    TransitionClaim,
    TransitionDeny,
    TransitionEnqueue,
    TransitionFail,
    TransitionHeartbeat,
    TransitionRequestApproval,
    TransitionRequeueStale,
    TransitionSucceed,
    TransitionTimeout,
    UserUsage,
    admit_job,
    admit_under_deploy,
    apply_transition,
    check_idempotency,
    consume_once,
    events_after,
    fair_next,
    health_check,
    recall_approval,
    remember_approval,
    should_retry_effect,
    start_job,
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


def job(
    *,
    id: str,
    user_id: str,
    status: JobStatus,
    **partial: Any,
) -> Job:
    return Job(
        id=id,
        user_id=user_id,
        status=status,
        created_at=partial.get("created_at", 1000.0),
        updated_at=partial.get("updated_at", 1000.0),
        cost_usd=partial.get("cost_usd", 0.0),
        tokens=partial.get("tokens", 0),
        **{k: v for k, v in partial.items() if k not in ("created_at", "updated_at", "cost_usd", "tokens")},
    )


def exp1() -> None:
    print(bold("\n实验一：断线之后，从哪续？"))
    j = job(id="j1", user_id="u1", status="queued")
    j = apply_transition(
        j, TransitionClaim(worker_id="w1", now=2000, lease_ms=5000)
    ).job
    ep1 = j.epoch
    cp1 = Checkpoint(seq=1, tool_calls_done=2, workspace_hash="h1")
    j = apply_transition(
        j,
        TransitionCheckpoint(worker_id="w1", epoch=ep1, checkpoint=cp1, now=2500),
    ).job
    cp2 = Checkpoint(seq=2, tool_calls_done=5, last_tool_id="edit", workspace_hash="h2")
    j = apply_transition(
        j,
        TransitionCheckpoint(worker_id="w1", epoch=ep1, checkpoint=cp2, now=3000),
    ).job
    stale = apply_transition(j, TransitionRequeueStale(now=9000))
    again = apply_transition(
        stale.job, TransitionClaim(worker_id="w2", now=9100, lease_ms=5000)
    )
    zombie = apply_transition(
        again.job,
        TransitionCheckpoint(
            worker_id="w1",
            epoch=ep1,
            checkpoint=Checkpoint(seq=3, tool_calls_done=6, workspace_hash="h3"),
            now=9200,
        ),
    )

    @dataclass
    class _Ev:
        seq: int
        name: str

    events = [_Ev(1, "tool:read"), _Ev(2, "tool:edit"), _Ev(3, "tool:verify")]
    resume = events_after(events, 1)
    print(f"  {pad('续跑 worker', 22)}{again.job.worker_id} epoch={again.job.epoch}")
    print(
        f"  {pad('保留 checkpoint.seq', 22)}"
        f"{again.job.checkpoint.seq if again.job.checkpoint else None}"
    )
    print(f"  {pad('旧 epoch 写入', 22)}{green('ACCEPT') if zombie.ok else red('DENY')}")
    print(f"  {pad('客户端 lastSeen=1', 22)}重放 {', '.join(e.name for e in resume)}")
    print(dim("\n  同名 worker 重启后靠 epoch 围栏；重放 seq≤1 配非幂等后端就是真双花。"))


def exp2() -> None:
    print(bold("\n实验二：同 key 重试 vs 无 key 的 unsafe_write"))
    rows: list[tuple[str, str]] = []
    a = check_idempotency(
        EffectRequest(key="k1", effect_class="idempotent_write", payload_hash="p1"),
        None,
    )
    rows.append(("首次写", a.kind))
    b = check_idempotency(
        EffectRequest(key="k1", effect_class="idempotent_write", payload_hash="p1"),
        EffectRecord(key="k1", payload_hash="p1", result="ok", at=1),
    )
    rows.append(
        ("同 key 重试", f"replay:{b.result}" if b.kind == "replay" else b.kind)
    )
    c = check_idempotency(
        EffectRequest(key="k1", effect_class="idempotent_write", payload_hash="p2"),
        EffectRecord(key="k1", payload_hash="p1", result="ok", at=1),
    )
    rows.append(("同 key 不同载荷", c.kind))
    d = check_idempotency(
        EffectRequest(key="", effect_class="unsafe_write", payload_hash="p1"),
        None,
    )
    rows.append(("unsafe 无 key", d.kind))
    r = should_retry_effect("unsafe_write", "TIMEOUT", False, 0, 3)
    rows.append(("unsafe 无 key + TIMEOUT", "retry" if r.retry else f"no:{r.reason}"))
    print(f"  {pad('场景', 28)}判定")
    print("  " + "─" * 44)
    for case, verdict in rows:
        print(f"  {pad(case, 28)}{verdict}")
    print(
        dim("\n  transient 错误也不能自动重试无 key 的副作用——否则账单与世界状态都会双份。")
    )


def exp3() -> None:
    print(bold("\n实验三：一个用户占满队列时，公平调度选谁"))
    policy = QuotaPolicy(
        max_concurrent_per_user=1,
        max_queued_per_user=2,
        daily_cost_usd=10,
        daily_tokens=1_000_000,
    )
    heavy = UserUsage(
        user_id="whale",
        running=1,
        queued=2,
        cost_usd_today=1,
        tokens_today=1000,
    )
    light = UserUsage(
        user_id="minnow",
        running=0,
        queued=0,
        cost_usd_today=0,
        tokens_today=0,
    )
    a1 = admit_job(heavy, policy, 0.1, 100)
    a2 = admit_job(light, policy, 0.1, 100)
    queued = [
        job(id="w-a", user_id="whale", status="queued", created_at=100),
        job(id="w-b", user_id="whale", status="queued", created_at=110),
        job(id="m-a", user_id="minnow", status="queued", created_at=120),
    ]
    next_id = fair_next(queued, {"whale": 5000, "minnow": 1000})
    whale_line = green("ALLOW") if a1.ok else red("DENY:" + (a1.reason or ""))
    minnow_line = green("ALLOW") if a2.ok else red("DENY")
    print(f"  whale 再入队：{whale_line}")
    print(f"  minnow 入队：{minnow_line}")
    print(f"  公平下一票：{next_id}")
    print(dim("\n  按 createdAt 会永远先伺候 whale；按 lastServed 轮转，minnow 插队。"))


def exp4() -> None:
    print(bold("\n实验四：审批记忆——段边界覆盖，deny 优先"))
    mem: list[ApprovalMemory] = []
    mem = remember_approval(
        mem,
        ApprovalMemory(
            user_id="u1",
            tool="edit_file",
            scope="/repo",
            mode="session",
            session_id="s1",
            allowed=True,
        ),
    )
    hit = recall_approval(
        mem,
        ApprovalQuery(
            user_id="u1",
            tool="edit_file",
            scope="/repo",
            session_id="s1",
            now=1,
        ),
    )
    child = recall_approval(
        mem,
        ApprovalQuery(
            user_id="u1",
            tool="edit_file",
            scope="/repo/a.ts",
            session_id="s1",
            now=1,
        ),
    )
    evil = recall_approval(
        mem,
        ApprovalQuery(
            user_id="u1",
            tool="edit_file",
            scope="/repo-evil",
            session_id="s1",
            now=1,
        ),
    )
    mem = remember_approval(
        mem,
        ApprovalMemory(
            user_id="u1",
            tool="edit_file",
            scope="/repo/secret",
            mode="session",
            session_id="s1",
            allowed=False,
        ),
    )
    denied = recall_approval(
        mem,
        ApprovalQuery(
            user_id="u1",
            tool="edit_file",
            scope="/repo/secret/x.ts",
            session_id="s1",
            now=1,
        ),
    )
    mem = remember_approval(
        mem,
        ApprovalMemory(
            user_id="u1",
            tool="bash",
            scope="rm",
            mode="once",
            allowed=True,
        ),
    )
    once = recall_approval(
        mem,
        ApprovalQuery(user_id="u1", tool="bash", scope="rm", now=1),
    )
    assert once is not None
    mem = consume_once(mem, once)
    once2 = recall_approval(
        mem,
        ApprovalQuery(user_id="u1", tool="bash", scope="rm", now=1),
    )
    print(f"  {pad('scope=/repo', 22)}{green('ALLOW') if hit else red('DENY')}")
    print(f"  {pad('/repo/a.ts', 22)}{green('ALLOW') if child else red('DENY')}")
    print(f"  {pad('/repo-evil', 22)}{green('ALLOW') if evil else red('DENY')}")
    deny_line = red("DENY") if denied is not None and not denied.allowed else green("ALLOW")
    print(f"  {pad('/repo/secret/x', 22)}{deny_line}")
    print(f"  {pad('once 第一次', 22)}{green('ALLOW') if once else red('DENY')}")
    print(f"  {pad('once 第二次', 22)}{green('ALLOW') if once2 else red('DENY')}")
    print(dim("\n  段边界 ≠ startsWith：/repo 盖子路径，不盖 /repo-evil；deny 压过 allow。"))


def exp5() -> None:
    print(bold("\n实验五：drain 拒新任务，kill 拒一切；健康检查"))
    open_ = admit_under_deploy(DeployState(mode="open"), "new_job")
    drain_new = admit_under_deploy(DeployState(mode="drain"), "new_job")
    drain_resume = admit_under_deploy(DeployState(mode="drain"), "resume")
    kill = admit_under_deploy(
        DeployState(mode="kill", reason="cost spike"), "effect"
    )
    h = health_check(
        HealthCheckInput(
            queue_depth=3,
            max_queue=100,
            oldest_queued_age_ms=1000,
            max_queue_age_ms=60_000,
            error_rate=0.01,
            max_error_rate=0.05,
            deploy=DeployState(mode="open"),
        )
    )
    start = start_job(
        StartJobInput(
            deploy=DeployState(mode="drain"),
            usage=UserUsage(
                user_id="u",
                running=0,
                queued=0,
                cost_usd_today=0,
                tokens_today=0,
            ),
            policy=QuotaPolicy(
                max_concurrent_per_user=2,
                max_queued_per_user=5,
                daily_cost_usd=5,
                daily_tokens=100000,
            ),
            estimated_cost_usd=0.2,
            estimated_tokens=1000,
        )
    )
    print(f"  {pad('open 新任务', 22)}{green('ALLOW') if open_.ok else red('DENY')}")
    print(f"  {pad('drain 新任务', 22)}{green('ALLOW') if drain_new.ok else red('DENY')}")
    print(f"  {pad('drain 续跑', 22)}{green('ALLOW') if drain_resume.ok else red('DENY')}")
    print(f"  {pad('kill 副作用', 22)}{green('ALLOW') if kill.ok else red('DENY')}")
    print(f"  {pad('health', 22)}{green('OK') if h.ok else red('BAD')}")
    print(f"  {pad('startJob@drain', 22)}{start.kind}")
    print(dim("\n  发布时先 drain 再滚；kill 是成本尖刺时的总闸，不是「可选优化」。"))


def observe() -> None:
    print(bold("L19 · 观察实验（参考实现）"))
    print(dim("跑完这些再去写 TODO。每一张表都对应一种「上线后才爆」的失败。"))
    exp1()
    exp2()
    exp3()
    exp4()
    exp5()


# ── TODO ─────────────────────────────────────────────────────


def my_apply_transition(j: Job, ev: Any) -> Any:
    raise NotImplementedError("TODO 1 未实现")


def my_check_idempotency(req: Any, prior: Any) -> Any:
    raise NotImplementedError("TODO 2 未实现")


def my_should_retry_effect(*args: Any) -> Any:
    raise NotImplementedError("TODO 3 未实现")


def my_admit_job(*args: Any) -> Any:
    raise NotImplementedError("TODO 4 未实现")


def my_fair_next(*args: Any) -> Any:
    raise NotImplementedError("TODO 5 未实现")


def my_start_job(*args: Any) -> Any:
    raise NotImplementedError("TODO 6 未实现")


_ = (
    my_apply_transition,
    my_check_idempotency,
    my_should_retry_effect,
    my_admit_job,
    my_fair_next,
    my_start_job,
    recall_approval,
    health_check,
    TransitionApprove,
    TransitionCancel,
    TransitionDeny,
    TransitionEnqueue,
    TransitionFail,
    TransitionHeartbeat,
    TransitionRequestApproval,
    TransitionSucceed,
    TransitionTimeout,
)

if __name__ == "__main__":
    observe()
    print(
        dim(
            "\n  下一步：实现文件下半部分的六个 TODO，然后跑 pnpm verify:l19（或 uv run python -m l19.verify）。"
        )
        + dim("\n  想先确认测试本身是对的，跑 OPS_IMPL=shared 下的 verify。")
        + dim("\n  观察实验：pnpm ops / uv run python -m l19.ops\n")
    )
