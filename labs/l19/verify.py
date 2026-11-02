"""验证 l19/ops.py。跑法：OPS_IMPL=shared uv run python -m l19.verify"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, is_dataclass
from typing import Any

from shared import ops as shared
from shared.ops import (
    ApprovalMemory,
    Checkpoint,
    DeployState,
    EffectRecord,
    EffectRequest,
    HealthCheckInput,
    Job,
    JobStatus,
    QuotaPolicy,
    StartJobInput,
    TransitionCheckpoint,
    TransitionClaim,
    TransitionRequeueStale,
    TransitionSucceed,
    UserUsage,
)

TARGET = "shared" if os.environ.get("OPS_IMPL") == "shared" else "mine"


class _Mine:
    def __init__(self) -> None:
        from l19 import ops as m

        self.apply_transition = m.my_apply_transition
        self.check_idempotency = m.my_check_idempotency
        self.should_retry_effect = m.my_should_retry_effect
        self.admit_job = m.my_admit_job
        self.fair_next = m.my_fair_next
        self.start_job = m.my_start_job
        self.events_after = shared.events_after
        self.recall_approval = shared.recall_approval
        self.remember_approval = shared.remember_approval
        self.consume_once = shared.consume_once
        self.admit_under_deploy = shared.admit_under_deploy
        self.health_check = shared.health_check


M: Any = shared if TARGET == "shared" else _Mine()

print(
    "\n（测的是 shared/ 里的参考实现）"
    if TARGET == "shared"
    else "\n（测的是 l19/ 里你的实现）"
)

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


def _jsonable(x: Any) -> Any:
    if is_dataclass(x) and not isinstance(x, type):
        return asdict(x)
    return x


def eq(a: Any, b: Any, name: str) -> None:
    as_ = json.dumps(_jsonable(a), ensure_ascii=False, sort_keys=True)
    bs = json.dumps(_jsonable(b), ensure_ascii=False, sort_keys=True)
    ok(as_ == bs, name if as_ == bs else f"{name} (got {as_}, want {bs})")


def section(title: str) -> None:
    print(f"{BOLD}\n{title}{OFF}")


def base_job(*, status: JobStatus, **over: Any) -> Job:
    return Job(
        id=over.get("id", "j"),
        user_id=over.get("user_id", "u"),
        created_at=over.get("created_at", 0.0),
        updated_at=over.get("updated_at", 0.0),
        cost_usd=over.get("cost_usd", 0.0),
        tokens=over.get("tokens", 0),
        status=status,
        **{k: v for k, v in over.items() if k not in ("id", "user_id", "created_at", "updated_at", "cost_usd", "tokens", "status")},
    )


section("A · 状态机与续跑")
j = base_job(status="queued")
ok(M.apply_transition(j, shared.TransitionEnqueue()).ok, "JOB-1 enqueue")
claimed = M.apply_transition(j, TransitionClaim(worker_id="w1", now=10, lease_ms=100))
ok(
    claimed.ok and claimed.job.status == "running" and claimed.job.epoch == 1,
    "JOB-2 claim",
)
j = claimed.job
ep = j.epoch
cp = M.apply_transition(
    j,
    TransitionCheckpoint(
        worker_id="w1",
        epoch=ep,
        now=20,
        checkpoint=Checkpoint(seq=1, tool_calls_done=1, workspace_hash="a"),
    ),
)
ok(cp.ok and cp.job.checkpoint is not None and cp.job.checkpoint.seq == 1, "JOB-3 checkpoint")
j = cp.job
ok(
    not M.apply_transition(
        j,
        TransitionCheckpoint(
            worker_id="w1",
            epoch=ep,
            now=21,
            checkpoint=Checkpoint(seq=1, tool_calls_done=2, workspace_hash="b"),
        ),
    ).ok,
    "JOB-4 seq 不递增失败",
)
ok(
    not M.apply_transition(
        j,
        TransitionCheckpoint(
            worker_id="w2",
            epoch=ep,
            now=22,
            checkpoint=Checkpoint(seq=2, tool_calls_done=2, workspace_hash="b"),
        ),
    ).ok,
    "JOB-5 worker 不匹配",
)
stale = M.apply_transition(j, TransitionRequeueStale(now=200))
ok(
    stale.ok
    and stale.job.status == "queued"
    and stale.job.checkpoint is not None
    and stale.job.checkpoint.seq == 1,
    "JOB-6 租约过期保留 checkpoint",
)
ok(not M.apply_transition(j, TransitionRequeueStale(now=50)).ok, "JOB-7 租约未过期拒 requeue")
claimed2 = M.apply_transition(
    base_job(status="queued"),
    TransitionClaim(worker_id="w", now=1, lease_ms=10),
)
done = M.apply_transition(
    claimed2.job,
    TransitionSucceed(worker_id="w", epoch=claimed2.job.epoch, now=2),
)
ok(done.ok and done.job.status == "succeeded", "JOB-8 succeed")
ok(
    not M.apply_transition(
        done.job, TransitionClaim(worker_id="w", now=3, lease_ms=1)
    ).ok,
    "JOB-9 终态不可 claim",
)


@dataclass
class _Ev:
    seq: int
    x: str


eq(
    [e.x for e in M.events_after([_Ev(1, "a"), _Ev(3, "c"), _Ev(2, "b")], 1)],
    ["b", "c"],
    "JOB-10 eventsAfter 排序过滤",
)
stale2 = M.apply_transition(j, TransitionRequeueStale(now=200))
reclaimed = M.apply_transition(
    stale2.job, TransitionClaim(worker_id="w1", now=210, lease_ms=100)
)
ok(
    reclaimed.ok
    and reclaimed.job.epoch == ep + 1
    and not M.apply_transition(
        reclaimed.job,
        TransitionCheckpoint(
            worker_id="w1",
            epoch=ep,
            now=220,
            checkpoint=Checkpoint(seq=2, tool_calls_done=2, workspace_hash="z"),
        ),
    ).ok,
    "JOB-11 旧 epoch 围栏",
)
appr = M.apply_transition(
    reclaimed.job,
    shared.TransitionRequestApproval(
        worker_id="w1", epoch=reclaimed.job.epoch, now=230
    ),
).job
denied = M.apply_transition(appr, shared.TransitionDeny(now=240, reason="no"))
ok(denied.ok and denied.job.status == "running", "JOB-12 deny→running 非整单取消")

section("B · 幂等与重试")
eq(
    M.check_idempotency(
        EffectRequest(key="k", effect_class="idempotent_write", payload_hash="p"),
        None,
    ).kind,
    "execute",
    "IDEM-1 首次",
)
eq(
    M.check_idempotency(
        EffectRequest(key="k", effect_class="idempotent_write", payload_hash="p"),
        EffectRecord(key="k", payload_hash="p", result="R", at=1),
    ),
    {"kind": "replay", "result": "R"},
    "IDEM-2 replay",
)
eq(
    M.check_idempotency(
        EffectRequest(key="k", effect_class="idempotent_write", payload_hash="p2"),
        EffectRecord(key="k", payload_hash="p", result="R", at=1),
    ).kind,
    "conflict",
    "IDEM-3 conflict",
)
eq(
    M.check_idempotency(
        EffectRequest(key="", effect_class="unsafe_write", payload_hash="p"),
        None,
    ).kind,
    "reject",
    "IDEM-4 unsafe 无 key",
)
ok(
    M.check_idempotency(
        EffectRequest(key="", effect_class="read", payload_hash="p"),
        None,
    ).kind
    == "execute",
    "IDEM-5 read 无 key",
)
ok(not M.should_retry_effect("unsafe_write", "TIMEOUT", False, 0, 3).retry, "RETRY-1 unsafe 无 key 不重试")
ok(M.should_retry_effect("idempotent_write", "TIMEOUT", True, 0, 3).retry, "RETRY-2 idempotent+key 可重试")
ok(not M.should_retry_effect("idempotent_write", "PERMISSION", True, 0, 3).retry, "RETRY-3 permanent")
ok(not M.should_retry_effect("idempotent_write", "TIMEOUT", True, 3, 3).retry, "RETRY-4 maxAttempts")
ok(not M.should_retry_effect("unsafe_write", "WEIRD", True, 0, 3).retry, "RETRY-5 unsafe+unknown")
ok(M.should_retry_effect("idempotent_write", "429_RATE", True, 0, 3).retry, "RETRY-6 429_RATE 可重试")
ok(not M.should_retry_effect("idempotent_write", "429_SPEND", True, 0, 3).retry, "RETRY-7 429_SPEND 不重试")
ok(not M.should_retry_effect("idempotent_write", "429", True, 0, 3).retry, "RETRY-8 裸 429 不重试")

section("C · 配额与公平")
policy = QuotaPolicy(
    max_concurrent_per_user=1,
    max_queued_per_user=1,
    daily_cost_usd=1,
    daily_tokens=1000,
)
ok(
    not M.admit_job(
        UserUsage(user_id="u", running=1, queued=0, cost_usd_today=0, tokens_today=0),
        policy,
        0.1,
        10,
    ).ok,
    "QUOTA-1 concurrent",
)
ok(
    not M.admit_job(
        UserUsage(user_id="u", running=0, queued=1, cost_usd_today=0, tokens_today=0),
        policy,
        0.1,
        10,
    ).ok,
    "QUOTA-2 queued",
)
ok(
    not M.admit_job(
        UserUsage(user_id="u", running=0, queued=0, cost_usd_today=0.95, tokens_today=0),
        policy,
        0.1,
        10,
    ).ok,
    "QUOTA-3 cost",
)
ok(
    M.admit_job(
        UserUsage(user_id="u", running=0, queued=0, cost_usd_today=0, tokens_today=0),
        policy,
        0.1,
        10,
    ).ok,
    "QUOTA-4 ok",
)
jobs = [
    base_job(id="a", user_id="u1", status="queued", created_at=1),
    base_job(id="b", user_id="u2", status="queued", created_at=2),
    base_job(id="c", user_id="u1", status="queued", created_at=3),
]
eq(M.fair_next(jobs, {"u1": 100, "u2": 10}), "b", "FAIR-1 久未服务者优先")
eq(M.fair_next([], {}), None, "FAIR-2 空")

section("D · 审批记忆")
mem = M.remember_approval(
    [],
    ApprovalMemory(
        user_id="u",
        tool="edit",
        scope="/repo",
        mode="session",
        session_id="s",
        allowed=True,
    ),
)
ok(
    M.recall_approval(
        mem,
        shared.ApprovalQuery(
            user_id="u", tool="edit", scope="/repo", session_id="s", now=1
        ),
    )
    is not None,
    "MEM-1 hit",
)
ok(
    not M.recall_approval(
        mem,
        shared.ApprovalQuery(
            user_id="u", tool="edit", scope="/repo-evil", session_id="s", now=1
        ),
    ),
    "MEM-2 段边界拒 /repo-evil",
)
ok(
    M.recall_approval(
        mem,
        shared.ApprovalQuery(
            user_id="u", tool="edit", scope="/repo/a.ts", session_id="s", now=1
        ),
    )
    is not None,
    "MEM-2b /repo 覆盖子路径",
)
ok(
    not M.recall_approval(
        mem,
        shared.ApprovalQuery(
            user_id="u", tool="edit", scope="/repo", session_id="other", now=1
        ),
    ),
    "MEM-3 session",
)
mem = M.remember_approval(
    mem,
    ApprovalMemory(
        user_id="u",
        tool="bash",
        scope="x",
        mode="ttl",
        expires_at=100,
        allowed=True,
    ),
)
ok(
    M.recall_approval(
        mem,
        shared.ApprovalQuery(user_id="u", tool="bash", scope="x", now=50),
    )
    is not None,
    "MEM-4 ttl 内",
)
ok(
    not M.recall_approval(
        mem,
        shared.ApprovalQuery(user_id="u", tool="bash", scope="x", now=100),
    ),
    "MEM-5 ttl 外",
)
mem = M.remember_approval(
    [],
    ApprovalMemory(user_id="u", tool="t", scope="s", mode="once", allowed=True),
)
hit = M.recall_approval(
    mem, shared.ApprovalQuery(user_id="u", tool="t", scope="s", now=1)
)
assert hit is not None
mem = M.consume_once(mem, hit)
ok(
    not M.recall_approval(
        mem, shared.ApprovalQuery(user_id="u", tool="t", scope="s", now=1)
    ),
    "MEM-6 once 消费",
)
deny_mem = M.remember_approval(
    [],
    ApprovalMemory(
        user_id="u",
        tool="edit",
        scope="/repo",
        mode="session",
        session_id="s",
        allowed=True,
    ),
)
deny_mem = M.remember_approval(
    deny_mem,
    ApprovalMemory(
        user_id="u",
        tool="edit",
        scope="/repo/secret",
        mode="session",
        session_id="s",
        allowed=False,
    ),
)
deny_hit = M.recall_approval(
    deny_mem,
    shared.ApprovalQuery(
        user_id="u",
        tool="edit",
        scope="/repo/secret/x.ts",
        session_id="s",
        now=1,
    ),
)
ok(deny_hit is not None and deny_hit.allowed is False, "MEM-7 deny 优先于 allow")

section("E · 部署与开工")
ok(M.admit_under_deploy(DeployState(mode="open"), "new_job").ok, "DEP-1 open")
ok(not M.admit_under_deploy(DeployState(mode="drain"), "new_job").ok, "DEP-2 drain 拒新")
ok(M.admit_under_deploy(DeployState(mode="drain"), "resume").ok, "DEP-3 drain 许续")
ok(not M.admit_under_deploy(DeployState(mode="kill", reason="x"), "effect").ok, "DEP-4 kill")
ok(
    M.health_check(
        HealthCheckInput(
            queue_depth=1,
            max_queue=10,
            oldest_queued_age_ms=1,
            max_queue_age_ms=10,
            error_rate=0,
            max_error_rate=0.1,
            deploy=DeployState(mode="open"),
        )
    ).ok,
    "DEP-5 health ok",
)
ok(
    not M.health_check(
        HealthCheckInput(
            queue_depth=1,
            max_queue=10,
            oldest_queued_age_ms=1,
            max_queue_age_ms=10,
            error_rate=0,
            max_error_rate=0.1,
            deploy=DeployState(mode="kill"),
        )
    ).ok,
    "DEP-6 health kill",
)
health_fmt = M.health_check(
    HealthCheckInput(
        queue_depth=1,
        max_queue=10,
        oldest_queued_age_ms=1,
        max_queue_age_ms=10,
        error_rate=0.0625,
        max_error_rate=0.1,
        deploy=DeployState(mode="open"),
    )
)
er = next(c for c in health_fmt.checks if c.name == "error_rate")
eq(er.detail, "0.062", "DEP-7 error_rate 向零截断（非 toFixed）")
eq(
    M.start_job(
        StartJobInput(
            deploy=DeployState(mode="drain"),
            usage=UserUsage(
                user_id="u", running=0, queued=0, cost_usd_today=0, tokens_today=0
            ),
            policy=policy,
            estimated_cost_usd=0.1,
            estimated_tokens=10,
        )
    ).kind,
    "reject",
    "START-1 drain",
)
eq(
    M.start_job(
        StartJobInput(
            deploy=DeployState(mode="open"),
            usage=UserUsage(
                user_id="u", running=0, queued=0, cost_usd_today=0, tokens_today=0
            ),
            policy=policy,
            estimated_cost_usd=0.1,
            estimated_tokens=10,
        )
    ).kind,
    "start",
    "START-2 ok",
)
prior = base_job(status="succeeded", idempotency_key="idem-1")
rep = M.start_job(
    StartJobInput(
        deploy=DeployState(mode="open"),
        usage=UserUsage(user_id="u", running=0, queued=0, cost_usd_today=0, tokens_today=0),
        policy=policy,
        estimated_cost_usd=0.1,
        estimated_tokens=10,
        idempotency_key="idem-1",
        prior_job=prior,
    )
)
ok(rep.kind == "replay", "START-3 replay 终态")
alice_prior = base_job(
    status="succeeded",
    user_id="alice",
    idempotency_key="shared-key",
    cost_usd=9.9,
)
cross = M.start_job(
    StartJobInput(
        deploy=DeployState(mode="open"),
        usage=UserUsage(
            user_id="bob", running=0, queued=0, cost_usd_today=0, tokens_today=0
        ),
        policy=policy,
        estimated_cost_usd=0.1,
        estimated_tokens=10,
        idempotency_key="shared-key",
        prior_job=alice_prior,
    )
)
ok(cross.kind == "start", "START-4 跨租户同 key 不泄露 replay")
payload_conflict = M.start_job(
    StartJobInput(
        deploy=DeployState(mode="open"),
        usage=UserUsage(user_id="u", running=0, queued=0, cost_usd_today=0, tokens_today=0),
        policy=policy,
        estimated_cost_usd=0.1,
        estimated_tokens=10,
        idempotency_key="idem-1",
        payload_hash="new",
        prior_job=base_job(
            status="succeeded",
            idempotency_key="idem-1",
            idempotency_payload_hash="old",
        ),
    )
)
ok(payload_conflict.kind == "reject", "START-5 同 key 不同 payload 拒")

print()
if failed == 0:
    print(f"{GREEN}  ✓ {passed} 条断言全部通过{OFF}")
    print(
        f"{DIM}\n  最该记住的六条：\n"
        "    JOB     epoch 围栏 + checkpoint.seq；deny 回 running\n"
        "    IDEM    租户隔离；unsafe 无 key 拒重试；429 要拆 RATE/SPEND\n"
        "    FAIR    按 lastServed 轮转，不是纯 FIFO\n"
        "    MEM     段边界 scope + deny 优先；once 用过即焚\n"
        "    DRAIN   拒新任务，许续跑\n"
        "    KILL    一切新副作用停止\n"
        f"{OFF}"
    )
    raise SystemExit(0)
print(f"{RED}  ✗ {failed} 失败 / {passed} 通过{OFF}")
raise SystemExit(1)
