"""Capstone 上线层：长任务不掉线、幂等、配额、审批记忆、可杀死。

TS 镜像见 ops.ts。API 为 snake_case；语义与 TS 逐条对齐。
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from functools import cmp_to_key
from typing import Literal, Protocol, TypeVar

from shared.coding_eval import cmp_code_point

# ─────────────────────────────────────────────────────────────
# 一、任务状态机
# ─────────────────────────────────────────────────────────────

JobStatus = Literal[
    "queued",
    "running",
    "waiting_approval",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
]

TERMINAL: frozenset[JobStatus] = frozenset(
    {"succeeded", "failed", "cancelled", "timed_out"}
)


@dataclass
class Checkpoint:
    """单调递增的事件序号——客户端用它做 resume cursor。"""

    seq: int
    tool_calls_done: int
    workspace_hash: str
    last_tool_id: str | None = None


@dataclass
class Job:
    id: str
    user_id: str
    status: JobStatus
    created_at: float
    updated_at: float
    cost_usd: float = 0.0
    tokens: int = 0
    epoch: int = 0
    lease_until: float | None = None
    worker_id: str | None = None
    checkpoint: Checkpoint | None = None
    idempotency_key: str | None = None
    idempotency_payload_hash: str | None = None
    failure_reason: str | None = None


@dataclass
class TransitionEnqueue:
    type: Literal["enqueue"] = "enqueue"


@dataclass
class TransitionClaim:
    worker_id: str
    now: float
    lease_ms: float
    type: Literal["claim"] = "claim"


@dataclass
class TransitionHeartbeat:
    worker_id: str
    epoch: int
    now: float
    lease_ms: float
    type: Literal["heartbeat"] = "heartbeat"


@dataclass
class TransitionCheckpoint:
    worker_id: str
    epoch: int
    checkpoint: Checkpoint
    now: float
    type: Literal["checkpoint"] = "checkpoint"


@dataclass
class TransitionRequestApproval:
    worker_id: str
    epoch: int
    now: float
    type: Literal["request_approval"] = "request_approval"


@dataclass
class TransitionApprove:
    now: float
    type: Literal["approve"] = "approve"


@dataclass
class TransitionDeny:
    now: float
    reason: str
    type: Literal["deny"] = "deny"


@dataclass
class TransitionSucceed:
    worker_id: str
    epoch: int
    now: float
    type: Literal["succeed"] = "succeed"


@dataclass
class TransitionFail:
    worker_id: str
    epoch: int
    now: float
    reason: str
    type: Literal["fail"] = "fail"


@dataclass
class TransitionCancel:
    now: float
    reason: str
    type: Literal["cancel"] = "cancel"


@dataclass
class TransitionTimeout:
    now: float
    type: Literal["timeout"] = "timeout"


@dataclass
class TransitionRequeueStale:
    now: float
    type: Literal["requeue_stale"] = "requeue_stale"


Transition = (
    TransitionEnqueue
    | TransitionClaim
    | TransitionHeartbeat
    | TransitionCheckpoint
    | TransitionRequestApproval
    | TransitionApprove
    | TransitionDeny
    | TransitionSucceed
    | TransitionFail
    | TransitionCancel
    | TransitionTimeout
    | TransitionRequeueStale
)


@dataclass
class TransitionResult:
    ok: bool
    job: Job
    reason: str | None = None


def _fence(job: Job, worker_id: str, epoch: int, now: float) -> str | None:
    """围栏：旧 epoch / 错 worker / 租约过期 → 拒写。"""
    if job.worker_id != worker_id:
        return "worker 不匹配"
    if job.epoch != epoch:
        return "epoch 不匹配"
    if job.lease_until is not None and now > job.lease_until:
        return "租约已过期"
    return None


def apply_transition(job: Job, ev: Transition) -> TransitionResult:
    """纯状态转移。非法转移返回 ok=False 且不改 status。"""
    j = replace(job)

    def fail(reason: str) -> TransitionResult:
        return TransitionResult(ok=False, job=job, reason=reason)

    match ev.type:
        case "enqueue":
            if job.status != "queued":
                return fail(f"enqueue 仅从 queued，当前 {job.status}")
            return TransitionResult(ok=True, job=j)

        case "claim":
            if job.status != "queued":
                return fail(f"claim 仅从 queued，当前 {job.status}")
            j.status = "running"
            j.worker_id = ev.worker_id
            j.epoch = job.epoch + 1
            j.lease_until = ev.now + ev.lease_ms
            j.updated_at = ev.now
            return TransitionResult(ok=True, job=j)

        case "heartbeat":
            if job.status not in ("running", "waiting_approval"):
                return fail(f"heartbeat 非法状态 {job.status}")
            gate = _fence(job, ev.worker_id, ev.epoch, ev.now)
            if gate:
                return fail(f"heartbeat：{gate}")
            j.lease_until = ev.now + ev.lease_ms
            j.updated_at = ev.now
            return TransitionResult(ok=True, job=j)

        case "checkpoint":
            if job.status != "running":
                return fail(f"checkpoint 仅 running，当前 {job.status}")
            gate = _fence(job, ev.worker_id, ev.epoch, ev.now)
            if gate:
                return fail(f"checkpoint：{gate}")
            if job.checkpoint is not None and ev.checkpoint.seq <= job.checkpoint.seq:
                return fail(
                    f"checkpoint seq 必须严格递增（有 {job.checkpoint.seq}，来 {ev.checkpoint.seq}）"
                )
            j.checkpoint = ev.checkpoint
            j.updated_at = ev.now
            return TransitionResult(ok=True, job=j)

        case "request_approval":
            if job.status != "running":
                return fail("request_approval 仅 running")
            gate = _fence(job, ev.worker_id, ev.epoch, ev.now)
            if gate:
                return fail(f"request_approval：{gate}")
            j.status = "waiting_approval"
            j.updated_at = ev.now
            return TransitionResult(ok=True, job=j)

        case "approve":
            if job.status != "waiting_approval":
                return fail("approve 仅 waiting_approval")
            j.status = "running"
            j.updated_at = ev.now
            return TransitionResult(ok=True, job=j)

        case "deny":
            # 否决的是这一刀工具，不是整单——取消整单会逼用户「永远点允许」
            if job.status != "waiting_approval":
                return fail("deny 仅 waiting_approval")
            j.status = "running"
            j.updated_at = ev.now
            return TransitionResult(ok=True, job=j)

        case "succeed":
            if job.status != "running":
                return fail("succeed 仅 running")
            if job.worker_id != ev.worker_id or job.epoch != ev.epoch:
                return fail("succeed：worker/epoch 不匹配")
            j.status = "succeeded"
            j.updated_at = ev.now
            return TransitionResult(ok=True, job=j)

        case "fail":
            if job.status != "running":
                return fail("fail 仅 running")
            if job.worker_id != ev.worker_id or job.epoch != ev.epoch:
                return fail("fail：worker/epoch 不匹配")
            j.status = "failed"
            j.failure_reason = ev.reason
            j.updated_at = ev.now
            return TransitionResult(ok=True, job=j)

        case "cancel":
            if job.status in TERMINAL:
                return fail(f"cancel：已终止 {job.status}")
            j.status = "cancelled"
            j.failure_reason = ev.reason
            j.updated_at = ev.now
            return TransitionResult(ok=True, job=j)

        case "timeout":
            if job.status in TERMINAL:
                return fail(f"timeout：已终止 {job.status}")
            j.status = "timed_out"
            j.updated_at = ev.now
            return TransitionResult(ok=True, job=j)

        case "requeue_stale":
            if job.status not in ("running", "waiting_approval"):
                return fail("requeue_stale 仅 running/waiting_approval")
            if job.lease_until is not None and ev.now < job.lease_until:
                return fail("requeue_stale：租约未过期")
            j.status = "queued"
            j.worker_id = None
            j.lease_until = None
            j.updated_at = ev.now
            return TransitionResult(ok=True, job=j)

        case _:
            return fail("未知转移")


class _SeqEvent(Protocol):
    seq: int


T = TypeVar("T", bound=_SeqEvent)


def events_after(events: list[T], last_seen_seq: int) -> list[T]:
    """客户端重连：只要事件 seq > last_seen_seq 的部分。"""
    return sorted(
        [e for e in events if e.seq > last_seen_seq],
        key=lambda e: e.seq,
    )


# ─────────────────────────────────────────────────────────────
# 二、幂等与重试
# ─────────────────────────────────────────────────────────────

EffectClass = Literal["read", "idempotent_write", "unsafe_write"]


@dataclass
class EffectRequest:
    key: str
    effect_class: EffectClass
    payload_hash: str


@dataclass
class EffectRecord:
    key: str
    payload_hash: str
    result: str
    at: float


@dataclass(frozen=True)
class IdempotencyExecute:
    kind: Literal["execute"] = "execute"


@dataclass(frozen=True)
class IdempotencyReplay:
    result: str
    kind: Literal["replay"] = "replay"


@dataclass(frozen=True)
class IdempotencyConflict:
    reason: str
    kind: Literal["conflict"] = "conflict"


@dataclass(frozen=True)
class IdempotencyReject:
    reason: str
    kind: Literal["reject"] = "reject"


IdempotencyVerdict = (
    IdempotencyExecute | IdempotencyReplay | IdempotencyConflict | IdempotencyReject
)


def check_idempotency(
    req: EffectRequest,
    prior: EffectRecord | None,
) -> IdempotencyVerdict:
    if req.effect_class == "unsafe_write" and (not req.key or req.key.strip() == ""):
        return IdempotencyReject(reason="unsafe_write 必须带 idempotency key")
    if not req.key or req.key.strip() == "":
        if req.effect_class == "read":
            return IdempotencyExecute()
        return IdempotencyReject(reason="写操作必须带 idempotency key")
    if prior is None:
        return IdempotencyExecute()
    if prior.payload_hash != req.payload_hash:
        return IdempotencyConflict(reason="同 key 不同 payloadHash")
    return IdempotencyReplay(result=prior.result)


RetryClass = Literal["transient", "permanent", "unknown"]


def classify_error(code: str) -> RetryClass:
    """429 不是一类：速率可退避，花费上限不行；裸 429 按永久拒重试。"""
    c = code.upper()
    if c in (
        "TIMEOUT",
        "429_RATE",
        "RATE_LIMIT",
        "UNAVAILABLE",
        "ECONNRESET",
        "529",
        "500",
        "502",
        "503",
        "504",
    ):
        return "transient"
    if c in (
        "INVALID",
        "PERMISSION",
        "NOT_UNIQUE",
        "CONFLICT",
        "409",
        "429_SPEND",
        "SPEND_LIMIT",
        "429",
        "400",
        "401",
        "403",
    ):
        # 裸 429：无法区分 rate/spend → 按永久拒重试
        return "permanent"
    return "unknown"


@dataclass
class RetryDecision:
    retry: bool
    reason: str


def should_retry_effect(
    effect_class: EffectClass,
    error_code: str,
    has_idempotency_key: bool,
    attempt: int,
    max_attempts: int,
) -> RetryDecision:
    if attempt >= max_attempts:
        return RetryDecision(retry=False, reason="已达 maxAttempts")
    cls = classify_error(error_code)
    if cls == "permanent":
        return RetryDecision(retry=False, reason=f"permanent: {error_code}")
    if effect_class == "unsafe_write" and not has_idempotency_key:
        return RetryDecision(retry=False, reason="unsafe_write 无 key：禁止自动重试")
    if cls == "unknown" and effect_class == "unsafe_write":
        return RetryDecision(retry=False, reason="unsafe_write + unknown：禁止自动重试")
    return RetryDecision(retry=True, reason=cls)


# ─────────────────────────────────────────────────────────────
# 三、配额与公平
# ─────────────────────────────────────────────────────────────


@dataclass
class QuotaPolicy:
    max_concurrent_per_user: int
    max_queued_per_user: int
    daily_cost_usd: float
    daily_tokens: int


@dataclass
class UserUsage:
    user_id: str
    running: int
    queued: int
    cost_usd_today: float
    tokens_today: int


@dataclass(frozen=True)
class AdmitVerdict:
    ok: bool
    reason: str | None = None


def admit_job(
    usage: UserUsage,
    policy: QuotaPolicy,
    estimated_cost_usd: float,
    estimated_tokens: int,
) -> AdmitVerdict:
    if usage.running >= policy.max_concurrent_per_user:
        return AdmitVerdict(ok=False, reason="concurrent 配额已满")
    if usage.queued >= policy.max_queued_per_user:
        return AdmitVerdict(ok=False, reason="queued 配额已满")
    if usage.cost_usd_today + estimated_cost_usd > policy.daily_cost_usd:
        return AdmitVerdict(ok=False, reason="dailyCost 超限")
    if usage.tokens_today + estimated_tokens > policy.daily_tokens:
        return AdmitVerdict(ok=False, reason="dailyTokens 超限")
    return AdmitVerdict(ok=True)


def fair_next(
    queued: list[Job],
    last_served: dict[str, float],
) -> str | None:
    """公平调度：按 user_id 轮转，避免一个用户占满 worker。"""
    if not queued:
        return None
    eligible = [j for j in queued if j.status == "queued"]
    if not eligible:
        return None

    def job_cmp(a: Job, b: Job) -> int:
        la = last_served.get(a.user_id, 0.0)
        lb = last_served.get(b.user_id, 0.0)
        if la != lb:
            return -1 if la < lb else 1
        if a.created_at != b.created_at:
            return -1 if a.created_at < b.created_at else 1
        return cmp_code_point(a.id, b.id)

    eligible.sort(key=cmp_to_key(job_cmp))
    return eligible[0].id


# ─────────────────────────────────────────────────────────────
# 四、审批记忆（兑付 L16 欠条）
# ─────────────────────────────────────────────────────────────

RememberMode = Literal["once", "session", "ttl"]


@dataclass
class ApprovalMemory:
    user_id: str
    tool: str
    scope: str
    mode: RememberMode
    allowed: bool
    session_id: str | None = None
    expires_at: float | None = None


@dataclass
class ApprovalQuery:
    user_id: str
    tool: str
    scope: str
    now: float
    session_id: str | None = None


def scope_covers(granted: str, requested: str) -> bool:
    """路径段边界：/repo 覆盖 /repo/a.ts，不覆盖 /repo-evil。"""
    g = _normalize_scope_path(granted)
    r = _normalize_scope_path(requested)
    if g is None or r is None:
        return False
    if g == r:
        return True
    if g == "/":
        return r.startswith("/")
    return r.startswith(g + "/")


def _normalize_scope_path(p: str) -> str | None:
    abs_ = p.startswith("/")
    out: list[str] = []
    for part in p.split("/"):
        if part == "" or part == ".":
            continue
        if part == "..":
            if not out:
                return None
            out.pop()
            continue
        out.append(part)
    if not abs_ and not out:
        return ""
    return ("/" if abs_ else "") + "/".join(out)


def recall_approval(
    memories: list[ApprovalMemory],
    q: ApprovalQuery,
) -> ApprovalMemory | None:
    """deny 优先；scope 用段边界覆盖。"""
    deny_hit: ApprovalMemory | None = None
    allow_hit: ApprovalMemory | None = None
    for m in memories:
        if m.user_id != q.user_id or m.tool != q.tool:
            continue
        if not scope_covers(m.scope, q.scope):
            continue
        if m.mode == "ttl":
            if m.expires_at is None or q.now >= m.expires_at:
                continue
        elif m.mode == "session":
            if not q.session_id or m.session_id != q.session_id:
                continue
        elif m.mode != "once":
            continue
        if not m.allowed:
            if deny_hit is None:
                deny_hit = m
        elif allow_hit is None:
            allow_hit = m
    return deny_hit if deny_hit is not None else allow_hit


def remember_approval(
    memories: list[ApprovalMemory],
    entry: ApprovalMemory,
) -> list[ApprovalMemory]:
    rest = [
        m
        for m in memories
        if not (
            m.user_id == entry.user_id and m.tool == entry.tool and m.scope == entry.scope
        )
    ]
    return [*rest, entry]


def consume_once(
    memories: list[ApprovalMemory],
    hit: ApprovalMemory,
) -> list[ApprovalMemory]:
    if hit.mode != "once":
        return memories
    return [
        m
        for m in memories
        if not (
            m.user_id == hit.user_id
            and m.tool == hit.tool
            and m.scope == hit.scope
            and m.mode == "once"
        )
    ]


# ─────────────────────────────────────────────────────────────
# 五、部署闸：drain / kill / 健康
# ─────────────────────────────────────────────────────────────

DeployMode = Literal["open", "drain", "kill"]


@dataclass
class DeployState:
    mode: DeployMode
    reason: str | None = None


@dataclass(frozen=True)
class DeployAdmit:
    ok: bool
    reason: str | None = None


DeployAdmitKind = Literal["new_job", "resume", "effect"]


def admit_under_deploy(
    state: DeployState,
    kind: DeployAdmitKind,
) -> DeployAdmit:
    if state.mode == "kill":
        return DeployAdmit(ok=False, reason=f"kill switch：{state.reason or 'stopped'}")
    if state.mode == "drain" and kind == "new_job":
        return DeployAdmit(ok=False, reason="drain：拒收新任务，进行中的可续跑")
    return DeployAdmit(ok=True)


@dataclass
class HealthCheckItem:
    name: str
    ok: bool
    detail: str


@dataclass
class HealthReport:
    ok: bool
    checks: list[HealthCheckItem]


@dataclass
class HealthCheckInput:
    queue_depth: int
    max_queue: int
    oldest_queued_age_ms: float
    max_queue_age_ms: float
    error_rate: float
    max_error_rate: float
    deploy: DeployState


def fmt_fixed3(n: float) -> str:
    """定点三位、向零截断——不用 round/format（与 TS toFixed 分叉）。"""
    neg = n < 0
    x = -n if neg else n
    scaled = int(x * 1000)  # trunc toward zero
    int_part = scaled // 1000
    frac = f"{scaled % 1000:03d}"
    return f"{'-' if neg else ''}{int_part}.{frac}"


def health_check(input: HealthCheckInput) -> HealthReport:
    checks = [
        HealthCheckItem(
            name="queue_depth",
            ok=input.queue_depth <= input.max_queue,
            detail=f"{input.queue_depth}/{input.max_queue}",
        ),
        HealthCheckItem(
            name="queue_age",
            ok=input.oldest_queued_age_ms <= input.max_queue_age_ms,
            detail=f"{input.oldest_queued_age_ms}ms",
        ),
        HealthCheckItem(
            name="error_rate",
            ok=input.error_rate <= input.max_error_rate,
            detail=fmt_fixed3(input.error_rate),
        ),
        HealthCheckItem(
            name="deploy_mode",
            ok=input.deploy.mode != "kill",
            detail=input.deploy.mode,
        ),
    ]
    return HealthReport(ok=all(c.ok for c in checks), checks=checks)


# ─────────────────────────────────────────────────────────────
# 六、组装：一次「能否开工」总判
# ─────────────────────────────────────────────────────────────


@dataclass
class StartJobInput:
    deploy: DeployState
    usage: UserUsage
    policy: QuotaPolicy
    estimated_cost_usd: float
    estimated_tokens: int
    idempotency_key: str | None = None
    payload_hash: str | None = None
    prior_job: Job | None = None


@dataclass(frozen=True)
class StartJobStart:
    kind: Literal["start"] = "start"


@dataclass(frozen=True)
class StartJobReplay:
    job: Job
    kind: Literal["replay"] = "replay"


@dataclass(frozen=True)
class StartJobReject:
    reason: str
    kind: Literal["reject"] = "reject"


StartJobVerdict = StartJobStart | StartJobReplay | StartJobReject


def start_job(input: StartJobInput) -> StartJobVerdict:
    d = admit_under_deploy(input.deploy, "new_job")
    if not d.ok:
        return StartJobReject(reason=d.reason or "")

    if input.idempotency_key and input.prior_job:
        # 租户隔离：跨 user 同 key 当作没有 prior——不泄露
        if input.prior_job.user_id == input.usage.user_id:
            if input.prior_job.idempotency_key == input.idempotency_key:
                if (
                    input.payload_hash is not None
                    and input.prior_job.idempotency_payload_hash is not None
                    and input.payload_hash != input.prior_job.idempotency_payload_hash
                ):
                    return StartJobReject(reason="同 idempotencyKey 不同 payloadHash")
                if input.prior_job.status in TERMINAL:
                    return StartJobReplay(job=input.prior_job)
                return StartJobReject(reason="同 idempotencyKey 任务仍在进行")

    a = admit_job(
        input.usage,
        input.policy,
        input.estimated_cost_usd,
        input.estimated_tokens,
    )
    if not a.ok:
        return StartJobReject(reason=a.reason or "")
    return StartJobStart()