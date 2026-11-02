/**
 * 验证 l19/ops.ts。
 *   OPS_IMPL=shared pnpm verify:l19
 *   pnpm verify:l19
 */

import * as shared from '../shared/ops.ts'
import type { Job } from '../shared/ops.ts'

const TARGET = process.env.OPS_IMPL === 'shared' ? 'shared' : 'mine'

async function loadMine() {
  const m = await import('./ops.ts')
  return {
    applyTransition: m.myApplyTransition,
    checkIdempotency: m.myCheckIdempotency,
    shouldRetryEffect: m.myShouldRetryEffect,
    admitJob: m.myAdmitJob,
    fairNext: m.myFairNext,
    startJob: m.myStartJob,
    eventsAfter: shared.eventsAfter,
    recallApproval: shared.recallApproval,
    rememberApproval: shared.rememberApproval,
    consumeOnce: shared.consumeOnce,
    admitUnderDeploy: shared.admitUnderDeploy,
    healthCheck: shared.healthCheck,
  }
}

type Api = {
  applyTransition: typeof shared.applyTransition
  checkIdempotency: typeof shared.checkIdempotency
  shouldRetryEffect: typeof shared.shouldRetryEffect
  admitJob: typeof shared.admitJob
  fairNext: typeof shared.fairNext
  startJob: typeof shared.startJob
  eventsAfter: typeof shared.eventsAfter
  recallApproval: typeof shared.recallApproval
  rememberApproval: typeof shared.rememberApproval
  consumeOnce: typeof shared.consumeOnce
  admitUnderDeploy: typeof shared.admitUnderDeploy
  healthCheck: typeof shared.healthCheck
}

const M: Api =
  TARGET === 'shared'
    ? {
        applyTransition: shared.applyTransition,
        checkIdempotency: shared.checkIdempotency,
        shouldRetryEffect: shared.shouldRetryEffect,
        admitJob: shared.admitJob,
        fairNext: shared.fairNext,
        startJob: shared.startJob,
        eventsAfter: shared.eventsAfter,
        recallApproval: shared.recallApproval,
        rememberApproval: shared.rememberApproval,
        consumeOnce: shared.consumeOnce,
        admitUnderDeploy: shared.admitUnderDeploy,
        healthCheck: shared.healthCheck,
      }
    : ((await loadMine()) as Api)

console.log(
  TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l19/ 里你的实现）',
)

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

let passed = 0
let failed = 0
function ok(cond: boolean, name: string): void {
  if (cond) passed++
  else {
    failed++
    console.log(red(`  ✗ ${name}`))
  }
}
function eq(a: unknown, b: unknown, name: string): void {
  const as = JSON.stringify(a)
  const bs = JSON.stringify(b)
  ok(as === bs, name + (as === bs ? '' : ` (got ${as}, want ${bs})`))
}
function section(t: string): void {
  console.log(bold(`\n${t}`))
}

function baseJob(over: Partial<Job> & Pick<Job, 'status'>): Job {
  return {
    id: 'j',
    userId: 'u',
    createdAt: 0,
    updatedAt: 0,
    costUsd: 0,
    tokens: 0,
    epoch: 0,
    ...over,
  }
}

section('A · 状态机与续跑')
let j = baseJob({ status: 'queued' })
ok(M.applyTransition(j, { type: 'enqueue' }).ok, 'JOB-1 enqueue')
const claimed = M.applyTransition(j, {
  type: 'claim',
  workerId: 'w1',
  now: 10,
  leaseMs: 100,
})
ok(claimed.ok && claimed.job.status === 'running' && claimed.job.epoch === 1, 'JOB-2 claim')
j = claimed.job
const ep = j.epoch
const cp = M.applyTransition(j, {
  type: 'checkpoint',
  workerId: 'w1',
  epoch: ep,
  now: 20,
  checkpoint: { seq: 1, toolCallsDone: 1, workspaceHash: 'a' },
})
ok(cp.ok && cp.job.checkpoint?.seq === 1, 'JOB-3 checkpoint')
j = cp.job
ok(
  !M.applyTransition(j, {
    type: 'checkpoint',
    workerId: 'w1',
    epoch: ep,
    now: 21,
    checkpoint: { seq: 1, toolCallsDone: 2, workspaceHash: 'b' },
  }).ok,
  'JOB-4 seq 不递增失败',
)
ok(
  !M.applyTransition(j, {
    type: 'checkpoint',
    workerId: 'w2',
    epoch: ep,
    now: 22,
    checkpoint: { seq: 2, toolCallsDone: 2, workspaceHash: 'b' },
  }).ok,
  'JOB-5 worker 不匹配',
)
const stale = M.applyTransition(j, { type: 'requeue_stale', now: 200 })
ok(stale.ok && stale.job.status === 'queued' && stale.job.checkpoint?.seq === 1, 'JOB-6 租约过期保留 checkpoint')
ok(!M.applyTransition(j, { type: 'requeue_stale', now: 50 }).ok, 'JOB-7 租约未过期拒 requeue')
const claimed2 = M.applyTransition(baseJob({ status: 'queued' }), {
  type: 'claim',
  workerId: 'w',
  now: 1,
  leaseMs: 10,
})
const done = M.applyTransition(claimed2.job, {
  type: 'succeed',
  workerId: 'w',
  epoch: claimed2.job.epoch,
  now: 2,
})
ok(done.ok && done.job.status === 'succeeded', 'JOB-8 succeed')
ok(!M.applyTransition(done.job, { type: 'claim', workerId: 'w', now: 3, leaseMs: 1 }).ok, 'JOB-9 终态不可 claim')
eq(
  M.eventsAfter(
    [
      { seq: 1, x: 'a' },
      { seq: 3, x: 'c' },
      { seq: 2, x: 'b' },
    ],
    1,
  ).map((e) => e.x),
  ['b', 'c'],
  'JOB-10 eventsAfter 排序过滤',
)
// 同名 worker 重新 claim 后，旧 epoch 写入必须被拒
const stale2 = M.applyTransition(j, { type: 'requeue_stale', now: 200 })
const reclaimed = M.applyTransition(stale2.job, {
  type: 'claim',
  workerId: 'w1',
  now: 210,
  leaseMs: 100,
})
ok(
  reclaimed.ok &&
    reclaimed.job.epoch === ep + 1 &&
    !M.applyTransition(reclaimed.job, {
      type: 'checkpoint',
      workerId: 'w1',
      epoch: ep,
      now: 220,
      checkpoint: { seq: 2, toolCallsDone: 2, workspaceHash: 'z' },
    }).ok,
  'JOB-11 旧 epoch 围栏',
)
let appr = M.applyTransition(reclaimed.job, {
  type: 'request_approval',
  workerId: 'w1',
  epoch: reclaimed.job.epoch,
  now: 230,
}).job
const denied = M.applyTransition(appr, { type: 'deny', now: 240, reason: 'no' })
ok(denied.ok && denied.job.status === 'running', 'JOB-12 deny→running 非整单取消')

section('B · 幂等与重试')
eq(
  M.checkIdempotency(
    { key: 'k', effectClass: 'idempotent_write', payloadHash: 'p' },
    undefined,
  ).kind,
  'execute',
  'IDEM-1 首次',
)
eq(
  M.checkIdempotency(
    { key: 'k', effectClass: 'idempotent_write', payloadHash: 'p' },
    { key: 'k', payloadHash: 'p', result: 'R', at: 1 },
  ),
  { kind: 'replay', result: 'R' },
  'IDEM-2 replay',
)
eq(
  M.checkIdempotency(
    { key: 'k', effectClass: 'idempotent_write', payloadHash: 'p2' },
    { key: 'k', payloadHash: 'p', result: 'R', at: 1 },
  ).kind,
  'conflict',
  'IDEM-3 conflict',
)
eq(
  M.checkIdempotency({ key: '', effectClass: 'unsafe_write', payloadHash: 'p' }, undefined).kind,
  'reject',
  'IDEM-4 unsafe 无 key',
)
ok(M.checkIdempotency({ key: '', effectClass: 'read', payloadHash: 'p' }, undefined).kind === 'execute', 'IDEM-5 read 无 key')
ok(!M.shouldRetryEffect('unsafe_write', 'TIMEOUT', false, 0, 3).retry, 'RETRY-1 unsafe 无 key 不重试')
ok(M.shouldRetryEffect('idempotent_write', 'TIMEOUT', true, 0, 3).retry, 'RETRY-2 idempotent+key 可重试')
ok(!M.shouldRetryEffect('idempotent_write', 'PERMISSION', true, 0, 3).retry, 'RETRY-3 permanent')
ok(!M.shouldRetryEffect('idempotent_write', 'TIMEOUT', true, 3, 3).retry, 'RETRY-4 maxAttempts')
ok(!M.shouldRetryEffect('unsafe_write', 'WEIRD', true, 0, 3).retry, 'RETRY-5 unsafe+unknown')
ok(M.shouldRetryEffect('idempotent_write', '429_RATE', true, 0, 3).retry, 'RETRY-6 429_RATE 可重试')
ok(!M.shouldRetryEffect('idempotent_write', '429_SPEND', true, 0, 3).retry, 'RETRY-7 429_SPEND 不重试')
ok(!M.shouldRetryEffect('idempotent_write', '429', true, 0, 3).retry, 'RETRY-8 裸 429 不重试')

section('C · 配额与公平')
const policy = {
  maxConcurrentPerUser: 1,
  maxQueuedPerUser: 1,
  dailyCostUsd: 1,
  dailyTokens: 1000,
}
ok(
  !M.admitJob(
    { userId: 'u', running: 1, queued: 0, costUsdToday: 0, tokensToday: 0 },
    policy,
    0.1,
    10,
  ).ok,
  'QUOTA-1 concurrent',
)
ok(
  !M.admitJob(
    { userId: 'u', running: 0, queued: 1, costUsdToday: 0, tokensToday: 0 },
    policy,
    0.1,
    10,
  ).ok,
  'QUOTA-2 queued',
)
ok(
  !M.admitJob(
    { userId: 'u', running: 0, queued: 0, costUsdToday: 0.95, tokensToday: 0 },
    policy,
    0.1,
    10,
  ).ok,
  'QUOTA-3 cost',
)
ok(
  M.admitJob(
    { userId: 'u', running: 0, queued: 0, costUsdToday: 0, tokensToday: 0 },
    policy,
    0.1,
    10,
  ).ok,
  'QUOTA-4 ok',
)
const jobs: Job[] = [
  baseJob({ id: 'a', userId: 'u1', status: 'queued', createdAt: 1 }),
  baseJob({ id: 'b', userId: 'u2', status: 'queued', createdAt: 2 }),
  baseJob({ id: 'c', userId: 'u1', status: 'queued', createdAt: 3 }),
]
eq(M.fairNext(jobs, { u1: 100, u2: 10 }), 'b', 'FAIR-1 久未服务者优先')
eq(M.fairNext([], {}), null, 'FAIR-2 空')

section('D · 审批记忆')
let mem = M.rememberApproval([], {
  userId: 'u',
  tool: 'edit',
  scope: '/repo',
  mode: 'session',
  sessionId: 's',
  allowed: true,
})
ok(!!M.recallApproval(mem, { userId: 'u', tool: 'edit', scope: '/repo', sessionId: 's', now: 1 }), 'MEM-1 hit')
ok(!M.recallApproval(mem, { userId: 'u', tool: 'edit', scope: '/repo-evil', sessionId: 's', now: 1 }), 'MEM-2 段边界拒 /repo-evil')
ok(!!M.recallApproval(mem, { userId: 'u', tool: 'edit', scope: '/repo/a.ts', sessionId: 's', now: 1 }), 'MEM-2b /repo 覆盖子路径')
ok(!M.recallApproval(mem, { userId: 'u', tool: 'edit', scope: '/repo', sessionId: 'other', now: 1 }), 'MEM-3 session')
mem = M.rememberApproval(mem, {
  userId: 'u',
  tool: 'bash',
  scope: 'x',
  mode: 'ttl',
  expiresAt: 100,
  allowed: true,
})
ok(!!M.recallApproval(mem, { userId: 'u', tool: 'bash', scope: 'x', now: 50 }), 'MEM-4 ttl 内')
ok(!M.recallApproval(mem, { userId: 'u', tool: 'bash', scope: 'x', now: 100 }), 'MEM-5 ttl 外')
mem = M.rememberApproval([], {
  userId: 'u',
  tool: 't',
  scope: 's',
  mode: 'once',
  allowed: true,
})
const hit = M.recallApproval(mem, { userId: 'u', tool: 't', scope: 's', now: 1 })!
mem = M.consumeOnce(mem, hit)
ok(!M.recallApproval(mem, { userId: 'u', tool: 't', scope: 's', now: 1 }), 'MEM-6 once 消费')
let denyMem = M.rememberApproval([], {
  userId: 'u',
  tool: 'edit',
  scope: '/repo',
  mode: 'session',
  sessionId: 's',
  allowed: true,
})
denyMem = M.rememberApproval(denyMem, {
  userId: 'u',
  tool: 'edit',
  scope: '/repo/secret',
  mode: 'session',
  sessionId: 's',
  allowed: false,
})
const denyHit = M.recallApproval(denyMem, {
  userId: 'u',
  tool: 'edit',
  scope: '/repo/secret/x.ts',
  sessionId: 's',
  now: 1,
})
ok(!!denyHit && denyHit.allowed === false, 'MEM-7 deny 优先于 allow')

section('E · 部署与开工')
ok(M.admitUnderDeploy({ mode: 'open' }, 'new_job').ok, 'DEP-1 open')
ok(!M.admitUnderDeploy({ mode: 'drain' }, 'new_job').ok, 'DEP-2 drain 拒新')
ok(M.admitUnderDeploy({ mode: 'drain' }, 'resume').ok, 'DEP-3 drain 许续')
ok(!M.admitUnderDeploy({ mode: 'kill', reason: 'x' }, 'effect').ok, 'DEP-4 kill')
ok(
  M.healthCheck({
    queueDepth: 1,
    maxQueue: 10,
    oldestQueuedAgeMs: 1,
    maxQueueAgeMs: 10,
    errorRate: 0,
    maxErrorRate: 0.1,
    deploy: { mode: 'open' },
  }).ok,
  'DEP-5 health ok',
)
ok(
  !M.healthCheck({
    queueDepth: 1,
    maxQueue: 10,
    oldestQueuedAgeMs: 1,
    maxQueueAgeMs: 10,
    errorRate: 0,
    maxErrorRate: 0.1,
    deploy: { mode: 'kill' },
  }).ok,
  'DEP-6 health kill',
)
const healthFmt = M.healthCheck({
  queueDepth: 1,
  maxQueue: 10,
  oldestQueuedAgeMs: 1,
  maxQueueAgeMs: 10,
  errorRate: 0.0625,
  maxErrorRate: 0.1,
  deploy: { mode: 'open' },
})
eq(
  healthFmt.checks.find((c) => c.name === 'error_rate')?.detail,
  '0.062',
  'DEP-7 error_rate 向零截断（非 toFixed）',
)
eq(
  M.startJob({
    deploy: { mode: 'drain' },
    usage: { userId: 'u', running: 0, queued: 0, costUsdToday: 0, tokensToday: 0 },
    policy,
    estimatedCostUsd: 0.1,
    estimatedTokens: 10,
  }).kind,
  'reject',
  'START-1 drain',
)
eq(
  M.startJob({
    deploy: { mode: 'open' },
    usage: { userId: 'u', running: 0, queued: 0, costUsdToday: 0, tokensToday: 0 },
    policy,
    estimatedCostUsd: 0.1,
    estimatedTokens: 10,
  }).kind,
  'start',
  'START-2 ok',
)
const prior = baseJob({ status: 'succeeded', idempotencyKey: 'idem-1' })
const rep = M.startJob({
  deploy: { mode: 'open' },
  usage: { userId: 'u', running: 0, queued: 0, costUsdToday: 0, tokensToday: 0 },
  policy,
  estimatedCostUsd: 0.1,
  estimatedTokens: 10,
  idempotencyKey: 'idem-1',
  priorJob: prior,
})
ok(rep.kind === 'replay', 'START-3 replay 终态')
const alicePrior = baseJob({
  status: 'succeeded',
  userId: 'alice',
  idempotencyKey: 'shared-key',
  costUsd: 9.9,
})
const cross = M.startJob({
  deploy: { mode: 'open' },
  usage: { userId: 'bob', running: 0, queued: 0, costUsdToday: 0, tokensToday: 0 },
  policy,
  estimatedCostUsd: 0.1,
  estimatedTokens: 10,
  idempotencyKey: 'shared-key',
  priorJob: alicePrior,
})
ok(cross.kind === 'start', 'START-4 跨租户同 key 不泄露 replay')
const payloadConflict = M.startJob({
  deploy: { mode: 'open' },
  usage: { userId: 'u', running: 0, queued: 0, costUsdToday: 0, tokensToday: 0 },
  policy,
  estimatedCostUsd: 0.1,
  estimatedTokens: 10,
  idempotencyKey: 'idem-1',
  payloadHash: 'new',
  priorJob: baseJob({
    status: 'succeeded',
    idempotencyKey: 'idem-1',
    idempotencyPayloadHash: 'old',
  }),
})
ok(payloadConflict.kind === 'reject', 'START-5 同 key 不同 payload 拒')

console.log()
if (failed === 0) {
  console.log(green(`  ✓ ${passed} 条断言全部通过`))
  console.log(
    dim(
      '\n  最该记住的六条：\n' +
        '    JOB     epoch 围栏 + checkpoint.seq；deny 回 running\n' +
        '    IDEM    租户隔离；unsafe 无 key 拒重试；429 要拆 RATE/SPEND\n' +
        '    FAIR    按 lastServed 轮转，不是纯 FIFO\n' +
        '    MEM     段边界 scope + deny 优先；once 用过即焚\n' +
        '    DRAIN   拒新任务，许续跑\n' +
        '    KILL    一切新副作用停止\n',
    ),
  )
  process.exit(0)
}
console.log(red(`  ✗ ${failed} 失败 / ${passed} 通过`))
process.exit(1)
