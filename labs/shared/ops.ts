/**
 * Capstone 上线层：长任务不掉线、幂等、配额、审批记忆、可杀死。
 *
 * L15 管账单与限流重试；L14 管单次动作能不能做；L16 管 canExecute vs 展示。
 * 这一文件管的是 **跨请求的寿命**：
 *
 *   · 断线之后能不能从 checkpoint 续上（不是重跑整条轨迹）
 *   · 同一 idempotency key 会不会造成双花
 *   · 多用户抢同一 worker 时谁先谁后、谁被拒
 *   · 「记住允许」会不会变成永久后门
 *   · kill switch / drain 时新任务能不能还进队列
 *
 * ★ verify 一次模型都不调：时钟与队列都是注入的纯函数输入。
 */

import { cmpCodePoint } from './codingEval.ts'

// ─────────────────────────────────────────────────────────────
// 一、任务状态机
// ─────────────────────────────────────────────────────────────

export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'

export const TERMINAL: ReadonlySet<JobStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
])

export interface Checkpoint {
  /** 单调递增的事件序号——客户端用它做 resume cursor。 */
  seq: number
  /** 摘要：已应用的工具调用数、最后一条 tool id 等。 */
  toolCallsDone: number
  lastToolId?: string
  /** 工作区内容哈希（接 L17 contentHash）——续跑前必须对上。 */
  workspaceHash: string
}

export interface Job {
  id: string
  userId: string
  status: JobStatus
  createdAt: number
  updatedAt: number
  /** 围栏令牌：每次 claim +1；旧 worker 即使同名也写不进去。 */
  epoch: number
  /** 租约：worker 心跳截止时间。过期可被别人认领。 */
  leaseUntil?: number
  workerId?: string
  checkpoint?: Checkpoint
  idempotencyKey?: string
  /** 与 idempotencyKey 一起比对；同 key 不同载荷 → 冲突。 */
  idempotencyPayloadHash?: string
  failureReason?: string
  costUsd: number
  tokens: number
}

export type Transition =
  | { type: 'enqueue' }
  | { type: 'claim'; workerId: string; now: number; leaseMs: number }
  | { type: 'heartbeat'; workerId: string; epoch: number; now: number; leaseMs: number }
  | {
      type: 'checkpoint'
      workerId: string
      epoch: number
      checkpoint: Checkpoint
      now: number
    }
  | { type: 'request_approval'; workerId: string; epoch: number; now: number }
  | { type: 'approve'; now: number }
  | { type: 'deny'; now: number; reason: string }
  | { type: 'succeed'; workerId: string; epoch: number; now: number }
  | { type: 'fail'; workerId: string; epoch: number; now: number; reason: string }
  | { type: 'cancel'; now: number; reason: string }
  | { type: 'timeout'; now: number }
  | { type: 'requeue_stale'; now: number }

export interface TransitionResult {
  ok: boolean
  job: Job
  reason?: string
}

/**
 * 围栏：同名 worker 在租约过期被重新 claim 后，旧进程带着旧 epoch 写不进去。
 * 同时拒掉租约已过期后的心跳/续写（僵尸自续命）。
 */
function fence(
  job: Job,
  workerId: string,
  epoch: number,
  now: number,
): string | null {
  if (job.workerId !== workerId) return 'worker 不匹配'
  if (job.epoch !== epoch) return 'epoch 不匹配'
  if (job.leaseUntil !== undefined && now > job.leaseUntil) return '租约已过期'
  return null
}

/**
 * 纯状态转移。非法转移返回 ok:false 且不改 status。
 *
 * ★ 断线续跑的关键不变量：running → checkpoint 只推进 seq，
 * 客户端用 lastSeq 过滤重放；不能从 succeeded 回到 running。
 */
export function applyTransition(job: Job, ev: Transition): TransitionResult {
  const j = { ...job }

  const fail = (reason: string): TransitionResult => ({ ok: false, job, reason })

  switch (ev.type) {
    case 'enqueue':
      if (job.status !== 'queued') return fail(`enqueue 仅从 queued，当前 ${job.status}`)
      return { ok: true, job: j }

    case 'claim':
      if (job.status !== 'queued') return fail(`claim 仅从 queued，当前 ${job.status}`)
      j.status = 'running'
      j.workerId = ev.workerId
      j.epoch = job.epoch + 1
      j.leaseUntil = ev.now + ev.leaseMs
      j.updatedAt = ev.now
      return { ok: true, job: j }

    case 'heartbeat': {
      if (job.status !== 'running' && job.status !== 'waiting_approval') {
        return fail(`heartbeat 非法状态 ${job.status}`)
      }
      const gate = fence(job, ev.workerId, ev.epoch, ev.now)
      if (gate) return fail(`heartbeat：${gate}`)
      j.leaseUntil = ev.now + ev.leaseMs
      j.updatedAt = ev.now
      return { ok: true, job: j }
    }

    case 'checkpoint': {
      if (job.status !== 'running') return fail(`checkpoint 仅 running，当前 ${job.status}`)
      const gate = fence(job, ev.workerId, ev.epoch, ev.now)
      if (gate) return fail(`checkpoint：${gate}`)
      if (job.checkpoint && ev.checkpoint.seq <= job.checkpoint.seq) {
        return fail(
          `checkpoint seq 必须严格递增（有 ${job.checkpoint.seq}，来 ${ev.checkpoint.seq}）`,
        )
      }
      j.checkpoint = ev.checkpoint
      j.updatedAt = ev.now
      return { ok: true, job: j }
    }

    case 'request_approval': {
      if (job.status !== 'running') return fail('request_approval 仅 running')
      const gate = fence(job, ev.workerId, ev.epoch, ev.now)
      if (gate) return fail(`request_approval：${gate}`)
      j.status = 'waiting_approval'
      j.updatedAt = ev.now
      return { ok: true, job: j }
    }

    case 'approve':
      if (job.status !== 'waiting_approval') return fail('approve 仅 waiting_approval')
      j.status = 'running'
      j.updatedAt = ev.now
      return { ok: true, job: j }

    case 'deny':
      // ★ 否决的是这一刀工具，不是整单——取消整单会逼用户「永远点允许」
      if (job.status !== 'waiting_approval') return fail('deny 仅 waiting_approval')
      j.status = 'running'
      j.updatedAt = ev.now
      return { ok: true, job: j }

    case 'succeed': {
      if (job.status !== 'running') return fail('succeed 仅 running')
      if (job.workerId !== ev.workerId || job.epoch !== ev.epoch) {
        return fail('succeed：worker/epoch 不匹配')
      }
      j.status = 'succeeded'
      j.updatedAt = ev.now
      return { ok: true, job: j }
    }

    case 'fail': {
      if (job.status !== 'running') return fail('fail 仅 running')
      if (job.workerId !== ev.workerId || job.epoch !== ev.epoch) {
        return fail('fail：worker/epoch 不匹配')
      }
      j.status = 'failed'
      j.failureReason = ev.reason
      j.updatedAt = ev.now
      return { ok: true, job: j }
    }

    case 'cancel':
      if (TERMINAL.has(job.status)) return fail(`cancel：已终止 ${job.status}`)
      j.status = 'cancelled'
      j.failureReason = ev.reason
      j.updatedAt = ev.now
      return { ok: true, job: j }

    case 'timeout':
      if (TERMINAL.has(job.status)) return fail(`timeout：已终止 ${job.status}`)
      j.status = 'timed_out'
      j.updatedAt = ev.now
      return { ok: true, job: j }

    case 'requeue_stale':
      if (job.status !== 'running' && job.status !== 'waiting_approval') {
        return fail('requeue_stale 仅 running/waiting_approval')
      }
      if (job.leaseUntil !== undefined && ev.now < job.leaseUntil) {
        return fail('requeue_stale：租约未过期')
      }
      j.status = 'queued'
      j.workerId = undefined
      j.leaseUntil = undefined
      j.updatedAt = ev.now
      // checkpoint 保留——新 worker 从断点续
      return { ok: true, job: j }

    default:
      return fail('未知转移')
  }
}

/**
 * 客户端重连：只要事件 seq > lastSeenSeq 的部分。
 * ★ 重放 seq≤lastSeen 会造成「工具又执行了一次」的错觉（UI），
 * 若配合非幂等后端则是真双花。
 */
export function eventsAfter<T extends { seq: number }>(
  events: T[],
  lastSeenSeq: number,
): T[] {
  return events.filter((e) => e.seq > lastSeenSeq).sort((a, b) => a.seq - b.seq)
}

// ─────────────────────────────────────────────────────────────
// 二、幂等与重试
// ─────────────────────────────────────────────────────────────

export type EffectClass = 'read' | 'idempotent_write' | 'unsafe_write'

export interface EffectRequest {
  key: string
  effectClass: EffectClass
  /** 业务载荷指纹——同 key 不同指纹 = 冲突。 */
  payloadHash: string
}

export interface EffectRecord {
  key: string
  payloadHash: string
  result: string
  at: number
}

export type IdempotencyVerdict =
  | { kind: 'execute' }
  | { kind: 'replay'; result: string }
  | { kind: 'conflict'; reason: string }
  | { kind: 'reject'; reason: string }

/**
 * 无存储副作用的判定。调用方负责持久化 EffectRecord。
 *
 * ★ unsafe_write 没有 key → 直接拒；有 key 走与 idempotent_write 相同的去重。
 * 重试 read 永远 execute（或由上层缓存）——这里要求 read 也带 key 时仍可 replay。
 */
export function checkIdempotency(
  req: EffectRequest,
  prior: EffectRecord | undefined,
): IdempotencyVerdict {
  if (req.effectClass === 'unsafe_write' && (!req.key || req.key.trim() === '')) {
    return { kind: 'reject', reason: 'unsafe_write 必须带 idempotency key' }
  }
  if (!req.key || req.key.trim() === '') {
    if (req.effectClass === 'read') return { kind: 'execute' }
    return { kind: 'reject', reason: '写操作必须带 idempotency key' }
  }
  if (!prior) return { kind: 'execute' }
  if (prior.payloadHash !== req.payloadHash) {
    return { kind: 'conflict', reason: '同 key 不同 payloadHash' }
  }
  return { kind: 'replay', result: prior.result }
}

export type RetryClass = 'transient' | 'permanent' | 'unknown'

/**
 * ★ 429 不是一类：速率限制可退避；花费上限等多久都没用（接 L15 OverLimitKind）。
 * 裸 `429` 按永久拒重试；调用方应拆成 429_RATE / 429_SPEND。
 */
export function classifyError(code: string): RetryClass {
  const c = code.toUpperCase()
  if (
    c === 'TIMEOUT' ||
    c === '429_RATE' ||
    c === 'RATE_LIMIT' ||
    c === 'UNAVAILABLE' ||
    c === 'ECONNRESET' ||
    c === '529' ||
    c === '500' ||
    c === '502' ||
    c === '503' ||
    c === '504'
  ) {
    return 'transient'
  }
  if (
    c === 'INVALID' ||
    c === 'PERMISSION' ||
    c === 'NOT_UNIQUE' ||
    c === 'CONFLICT' ||
    c === '409' ||
    c === '429_SPEND' ||
    c === 'SPEND_LIMIT' ||
    c === '429' ||
    c === '400' ||
    c === '401' ||
    c === '403'
  ) {
    // 裸 429：无法区分 rate/spend → 按永久拒重试（花费上限退避无意义）
    return 'permanent'
  }
  return 'unknown'
}

export interface RetryDecision {
  retry: boolean
  reason: string
}

/**
 * ★ 没有 idempotency key 的 unsafe_write，即使错误是 transient 也不许自动重试。
 */
export function shouldRetryEffect(
  effectClass: EffectClass,
  errorCode: string,
  hasIdempotencyKey: boolean,
  attempt: number,
  maxAttempts: number,
): RetryDecision {
  if (attempt >= maxAttempts) {
    return { retry: false, reason: '已达 maxAttempts' }
  }
  const cls = classifyError(errorCode)
  if (cls === 'permanent') return { retry: false, reason: `permanent: ${errorCode}` }
  if (effectClass === 'unsafe_write' && !hasIdempotencyKey) {
    return { retry: false, reason: 'unsafe_write 无 key：禁止自动重试' }
  }
  if (cls === 'unknown' && effectClass === 'unsafe_write') {
    return { retry: false, reason: 'unsafe_write + unknown：禁止自动重试' }
  }
  return { retry: true, reason: cls }
}

// ─────────────────────────────────────────────────────────────
// 三、配额与公平
// ─────────────────────────────────────────────────────────────

export interface QuotaPolicy {
  maxConcurrentPerUser: number
  maxQueuedPerUser: number
  dailyCostUsd: number
  dailyTokens: number
}

export interface UserUsage {
  userId: string
  running: number
  queued: number
  costUsdToday: number
  tokensToday: number
}

export type AdmitVerdict =
  | { ok: true }
  | { ok: false; reason: string }

export function admitJob(
  usage: UserUsage,
  policy: QuotaPolicy,
  estimatedCostUsd: number,
  estimatedTokens: number,
): AdmitVerdict {
  if (usage.running >= policy.maxConcurrentPerUser) {
    return { ok: false, reason: 'concurrent 配额已满' }
  }
  if (usage.queued >= policy.maxQueuedPerUser) {
    return { ok: false, reason: 'queued 配额已满' }
  }
  if (usage.costUsdToday + estimatedCostUsd > policy.dailyCostUsd) {
    return { ok: false, reason: 'dailyCost 超限' }
  }
  if (usage.tokensToday + estimatedTokens > policy.dailyTokens) {
    return { ok: false, reason: 'dailyTokens 超限' }
  }
  return { ok: true }
}

/**
 * 公平调度：按 userId 轮转，避免一个用户占满 worker。
 * 输入已是 queued 任务；返回下一个该 claim 的 job id。
 */
export function fairNext(
  queued: Job[],
  /** 每个用户最近一次被调度的时间；没有则 0。 */
  lastServed: Record<string, number>,
): string | null {
  if (queued.length === 0) return null
  const eligible = queued.filter((j) => j.status === 'queued')
  if (eligible.length === 0) return null
  eligible.sort((a, b) => {
    const la = lastServed[a.userId] ?? 0
    const lb = lastServed[b.userId] ?? 0
    if (la !== lb) return la - lb
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return cmpCodePoint(a.id, b.id)
  })
  return eligible[0]!.id
}

// ─────────────────────────────────────────────────────────────
// 四、审批记忆（兑付 L16 欠条）
// ─────────────────────────────────────────────────────────────

export type RememberMode = 'once' | 'session' | 'ttl'

export interface ApprovalMemory {
  userId: string
  tool: string
  /** 作用域：路径前缀 / repo id 等。 */
  scope: string
  mode: RememberMode
  /** session 模式：绑定会话 id。 */
  sessionId?: string
  /** ttl 模式：过期时间。 */
  expiresAt?: number
  allowed: boolean
}

export interface ApprovalQuery {
  userId: string
  tool: string
  scope: string
  sessionId?: string
  now: number
}

/**
 * 路径段边界覆盖：`/repo` 覆盖 `/repo/a.ts`，不覆盖 `/repo-evil`。
 * 先规整 `.` / `..` / 尾斜杠；只用 `/` 分段，不用 localeCompare。
 */
export function scopeCovers(granted: string, requested: string): boolean {
  const g = normalizeScopePath(granted)
  const r = normalizeScopePath(requested)
  if (g === null || r === null) return false
  if (g === r) return true
  if (g === '/') return r.startsWith('/')
  return r.startsWith(g + '/')
}

function normalizeScopePath(p: string): string | null {
  const abs = p.startsWith('/')
  const parts = p.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(part)
  }
  if (!abs && out.length === 0) return ''
  return (abs ? '/' : '') + out.join('/')
}

/**
 * 查找是否已有可用记忆。once 命中后由调用方删除。
 * ★ deny 优先于 allow；scope 用段边界覆盖，不是精确、也不是 startsWith。
 */
export function recallApproval(
  memories: ApprovalMemory[],
  q: ApprovalQuery,
): ApprovalMemory | null {
  let denyHit: ApprovalMemory | null = null
  let allowHit: ApprovalMemory | null = null
  for (const m of memories) {
    if (m.userId !== q.userId || m.tool !== q.tool) continue
    if (!scopeCovers(m.scope, q.scope)) continue
    if (m.mode === 'ttl') {
      if (m.expiresAt === undefined || q.now >= m.expiresAt) continue
    } else if (m.mode === 'session') {
      if (!q.sessionId || m.sessionId !== q.sessionId) continue
    } else if (m.mode !== 'once') {
      continue
    }
    if (!m.allowed) {
      if (!denyHit) denyHit = m
    } else if (!allowHit) {
      allowHit = m
    }
  }
  return denyHit ?? allowHit
}

export function rememberApproval(
  memories: ApprovalMemory[],
  entry: ApprovalMemory,
): ApprovalMemory[] {
  // 同 user/tool/scope 覆盖
  const rest = memories.filter(
    (m) => !(m.userId === entry.userId && m.tool === entry.tool && m.scope === entry.scope),
  )
  return [...rest, entry]
}

export function consumeOnce(
  memories: ApprovalMemory[],
  hit: ApprovalMemory,
): ApprovalMemory[] {
  if (hit.mode !== 'once') return memories
  return memories.filter(
    (m) => !(m.userId === hit.userId && m.tool === hit.tool && m.scope === hit.scope && m.mode === 'once'),
  )
}

// ─────────────────────────────────────────────────────────────
// 五、部署闸：drain / kill / 健康
// ─────────────────────────────────────────────────────────────

export type DeployMode = 'open' | 'drain' | 'kill'

export interface DeployState {
  mode: DeployMode
  /** kill 之后拒绝一切新副作用。 */
  reason?: string
}

export type DeployAdmit =
  | { ok: true }
  | { ok: false; reason: string }

export function admitUnderDeploy(
  state: DeployState,
  kind: 'new_job' | 'resume' | 'effect',
): DeployAdmit {
  if (state.mode === 'kill') {
    return { ok: false, reason: `kill switch：${state.reason ?? 'stopped'}` }
  }
  if (state.mode === 'drain' && kind === 'new_job') {
    return { ok: false, reason: 'drain：拒收新任务，进行中的可续跑' }
  }
  return { ok: true }
}

export interface HealthReport {
  ok: boolean
  checks: { name: string; ok: boolean; detail: string }[]
}

/**
 * 定点三位小数、向零截断——不用 toFixed（银行家舍入在 TS/Python 上会分叉）。
 * 例：0.0625 → "0.062"（不是 "0.063"）。
 */
export function fmtFixed3(n: number): string {
  const neg = n < 0
  const x = neg ? -n : n
  const scaled = Math.trunc(x * 1000)
  const int = Math.trunc(scaled / 1000)
  const frac = String(scaled % 1000).padStart(3, '0')
  return `${neg ? '-' : ''}${int}.${frac}`
}

export function healthCheck(input: {
  queueDepth: number
  maxQueue: number
  oldestQueuedAgeMs: number
  maxQueueAgeMs: number
  errorRate: number
  maxErrorRate: number
  deploy: DeployState
}): HealthReport {
  const checks = [
    {
      name: 'queue_depth',
      ok: input.queueDepth <= input.maxQueue,
      detail: `${input.queueDepth}/${input.maxQueue}`,
    },
    {
      name: 'queue_age',
      ok: input.oldestQueuedAgeMs <= input.maxQueueAgeMs,
      detail: `${input.oldestQueuedAgeMs}ms`,
    },
    {
      name: 'error_rate',
      ok: input.errorRate <= input.maxErrorRate,
      detail: fmtFixed3(input.errorRate),
    },
    {
      name: 'deploy_mode',
      ok: input.deploy.mode !== 'kill',
      detail: input.deploy.mode,
    },
  ]
  return { ok: checks.every((c) => c.ok), checks }
}

// ─────────────────────────────────────────────────────────────
// 六、组装：一次「能否开工」总判
// ─────────────────────────────────────────────────────────────

export interface StartJobInput {
  deploy: DeployState
  usage: UserUsage
  policy: QuotaPolicy
  estimatedCostUsd: number
  estimatedTokens: number
  idempotencyKey?: string
  /** 与 priorJob.idempotencyPayloadHash 比对；同 key 不同载荷 → 冲突。 */
  payloadHash?: string
  /** 若带 key，查是否已有终态任务可直接 replay。 */
  priorJob?: Job
}

export type StartJobVerdict =
  | { kind: 'start' }
  | { kind: 'replay'; job: Job }
  | { kind: 'reject'; reason: string }

export function startJob(input: StartJobInput): StartJobVerdict {
  const d = admitUnderDeploy(input.deploy, 'new_job')
  if (!d.ok) return { kind: 'reject', reason: d.reason }

  if (input.idempotencyKey && input.priorJob) {
    // ★ 租户隔离：跨 user 的同 key 当作「没有 prior」——不泄露作业存在与否
    if (input.priorJob.userId === input.usage.userId) {
      if (input.priorJob.idempotencyKey === input.idempotencyKey) {
        if (
          input.payloadHash !== undefined &&
          input.priorJob.idempotencyPayloadHash !== undefined &&
          input.payloadHash !== input.priorJob.idempotencyPayloadHash
        ) {
          return { kind: 'reject', reason: '同 idempotencyKey 不同 payloadHash' }
        }
        if (TERMINAL.has(input.priorJob.status)) {
          return { kind: 'replay', job: input.priorJob }
        }
        return { kind: 'reject', reason: '同 idempotencyKey 任务仍在进行' }
      }
    }
  }

  const a = admitJob(
    input.usage,
    input.policy,
    input.estimatedCostUsd,
    input.estimatedTokens,
  )
  if (!a.ok) return { kind: 'reject', reason: a.reason }
  return { kind: 'start' }
}
