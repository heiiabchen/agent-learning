/**
 * L19 的脚手架。跑法：pnpm ops
 *
 * 观察实验：断线续跑、幂等双花、配额公平、审批记忆作用域、drain/kill。
 * 全程零模型。写完六个 TODO 跑 pnpm verify:l19。
 */

import {
  admitJob,
  admitUnderDeploy,
  applyTransition,
  checkIdempotency,
  consumeOnce,
  eventsAfter,
  fairNext,
  healthCheck,
  recallApproval,
  rememberApproval,
  shouldRetryEffect,
  startJob,
  type ApprovalMemory,
  type Checkpoint,
  type Job,
  type QuotaPolicy,
  type UserUsage,
} from '../shared/ops.ts'
import { isMain } from '../shared/entry.ts'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const w = (s: string) =>
  [...visible(s)].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - w(s)))

function job(partial: Partial<Job> & Pick<Job, 'id' | 'userId' | 'status'>): Job {
  return {
    createdAt: 1000,
    updatedAt: 1000,
    costUsd: 0,
    tokens: 0,
    epoch: 0,
    ...partial,
  }
}

function exp1(): void {
  console.log(bold('\n实验一：断线之后，从哪续？'))
  let j = job({ id: 'j1', userId: 'u1', status: 'queued' })
  j = applyTransition(j, { type: 'claim', workerId: 'w1', now: 2000, leaseMs: 5000 }).job
  const ep1 = j.epoch
  const cp1: Checkpoint = { seq: 1, toolCallsDone: 2, workspaceHash: 'h1' }
  j = applyTransition(j, {
    type: 'checkpoint',
    workerId: 'w1',
    epoch: ep1,
    checkpoint: cp1,
    now: 2500,
  }).job
  const cp2: Checkpoint = { seq: 2, toolCallsDone: 5, lastToolId: 'edit', workspaceHash: 'h2' }
  j = applyTransition(j, {
    type: 'checkpoint',
    workerId: 'w1',
    epoch: ep1,
    checkpoint: cp2,
    now: 3000,
  }).job
  // 租约过期，别人认领——checkpoint 必须还在；旧 epoch 写不进去
  const stale = applyTransition(j, { type: 'requeue_stale', now: 9000 })
  const again = applyTransition(stale.job, { type: 'claim', workerId: 'w2', now: 9100, leaseMs: 5000 })
  const zombie = applyTransition(again.job, {
    type: 'checkpoint',
    workerId: 'w1',
    epoch: ep1,
    checkpoint: { seq: 3, toolCallsDone: 6, workspaceHash: 'h3' },
    now: 9200,
  })
  const events = [
    { seq: 1, name: 'tool:read' },
    { seq: 2, name: 'tool:edit' },
    { seq: 3, name: 'tool:verify' },
  ]
  const resume = eventsAfter(events, 1)
  console.log(`  ${pad('续跑 worker', 22)}${again.job.workerId} epoch=${again.job.epoch}`)
  console.log(`  ${pad('保留 checkpoint.seq', 22)}${again.job.checkpoint?.seq}`)
  console.log(`  ${pad('旧 epoch 写入', 22)}${zombie.ok ? green('ACCEPT') : red('DENY')}`)
  console.log(`  ${pad('客户端 lastSeen=1', 22)}重放 ${resume.map((e) => e.name).join(', ')}`)
  console.log(dim('\n  同名 worker 重启后靠 epoch 围栏；重放 seq≤1 配非幂等后端就是真双花。'))
}

function exp2(): void {
  console.log(bold('\n实验二：同 key 重试 vs 无 key 的 unsafe_write'))
  const rows: { case: string; verdict: string }[] = []
  const a = checkIdempotency(
    { key: 'k1', effectClass: 'idempotent_write', payloadHash: 'p1' },
    undefined,
  )
  rows.push({ case: '首次写', verdict: a.kind })
  const b = checkIdempotency(
    { key: 'k1', effectClass: 'idempotent_write', payloadHash: 'p1' },
    { key: 'k1', payloadHash: 'p1', result: 'ok', at: 1 },
  )
  rows.push({ case: '同 key 重试', verdict: b.kind === 'replay' ? `replay:${b.result}` : b.kind })
  const c = checkIdempotency(
    { key: 'k1', effectClass: 'idempotent_write', payloadHash: 'p2' },
    { key: 'k1', payloadHash: 'p1', result: 'ok', at: 1 },
  )
  rows.push({ case: '同 key 不同载荷', verdict: c.kind })
  const d = checkIdempotency(
    { key: '', effectClass: 'unsafe_write', payloadHash: 'p1' },
    undefined,
  )
  rows.push({ case: 'unsafe 无 key', verdict: d.kind })
  const r = shouldRetryEffect('unsafe_write', 'TIMEOUT', false, 0, 3)
  rows.push({ case: 'unsafe 无 key + TIMEOUT', verdict: r.retry ? 'retry' : `no:${r.reason}` })
  console.log(`  ${pad('场景', 28)}判定`)
  console.log('  ' + '─'.repeat(44))
  for (const row of rows) console.log(`  ${pad(row.case, 28)}${row.verdict}`)
  console.log(dim('\n  transient 错误也不能自动重试无 key 的副作用——否则账单与世界状态都会双份。'))
}

function exp3(): void {
  console.log(bold('\n实验三：一个用户占满队列时，公平调度选谁'))
  const policy: QuotaPolicy = {
    maxConcurrentPerUser: 1,
    maxQueuedPerUser: 2,
    dailyCostUsd: 10,
    dailyTokens: 1_000_000,
  }
  const heavy: UserUsage = {
    userId: 'whale',
    running: 1,
    queued: 2,
    costUsdToday: 1,
    tokensToday: 1000,
  }
  const light: UserUsage = {
    userId: 'minnow',
    running: 0,
    queued: 0,
    costUsdToday: 0,
    tokensToday: 0,
  }
  const a1 = admitJob(heavy, policy, 0.1, 100)
  const a2 = admitJob(light, policy, 0.1, 100)
  const queued: Job[] = [
    job({ id: 'w-a', userId: 'whale', status: 'queued', createdAt: 100 }),
    job({ id: 'w-b', userId: 'whale', status: 'queued', createdAt: 110 }),
    job({ id: 'm-a', userId: 'minnow', status: 'queued', createdAt: 120 }),
  ]
  const next = fairNext(queued, { whale: 5000, minnow: 1000 })
  console.log(`  whale 再入队：${a1.ok ? green('ALLOW') : red('DENY:' + a1.reason)}`)
  console.log(`  minnow 入队：${a2.ok ? green('ALLOW') : red('DENY')}`)
  console.log(`  公平下一票：${next}`)
  console.log(dim('\n  按 createdAt 会永远先伺候 whale；按 lastServed 轮转，minnow 插队。'))
}

function exp4(): void {
  console.log(bold('\n实验四：审批记忆——段边界覆盖，deny 优先'))
  let mem: ApprovalMemory[] = []
  mem = rememberApproval(mem, {
    userId: 'u1',
    tool: 'edit_file',
    scope: '/repo',
    mode: 'session',
    sessionId: 's1',
    allowed: true,
  })
  const hit = recallApproval(mem, {
    userId: 'u1',
    tool: 'edit_file',
    scope: '/repo',
    sessionId: 's1',
    now: 1,
  })
  const child = recallApproval(mem, {
    userId: 'u1',
    tool: 'edit_file',
    scope: '/repo/a.ts',
    sessionId: 's1',
    now: 1,
  })
  const evil = recallApproval(mem, {
    userId: 'u1',
    tool: 'edit_file',
    scope: '/repo-evil',
    sessionId: 's1',
    now: 1,
  })
  mem = rememberApproval(mem, {
    userId: 'u1',
    tool: 'edit_file',
    scope: '/repo/secret',
    mode: 'session',
    sessionId: 's1',
    allowed: false,
  })
  const denied = recallApproval(mem, {
    userId: 'u1',
    tool: 'edit_file',
    scope: '/repo/secret/x.ts',
    sessionId: 's1',
    now: 1,
  })
  mem = rememberApproval(mem, {
    userId: 'u1',
    tool: 'bash',
    scope: 'rm',
    mode: 'once',
    allowed: true,
  })
  const once = recallApproval(mem, {
    userId: 'u1',
    tool: 'bash',
    scope: 'rm',
    now: 1,
  })
  mem = consumeOnce(mem, once!)
  const once2 = recallApproval(mem, {
    userId: 'u1',
    tool: 'bash',
    scope: 'rm',
    now: 1,
  })
  console.log(`  ${pad('scope=/repo', 22)}${hit ? green('ALLOW') : red('DENY')}`)
  console.log(`  ${pad('/repo/a.ts', 22)}${child ? green('ALLOW') : red('DENY')}`)
  console.log(`  ${pad('/repo-evil', 22)}${evil ? green('ALLOW') : red('DENY')}`)
  console.log(
    `  ${pad('/repo/secret/x', 22)}${denied && !denied.allowed ? red('DENY') : green('ALLOW')}`,
  )
  console.log(`  ${pad('once 第一次', 22)}${once ? green('ALLOW') : red('DENY')}`)
  console.log(`  ${pad('once 第二次', 22)}${once2 ? green('ALLOW') : red('DENY')}`)
  console.log(dim('\n  段边界 ≠ startsWith：/repo 盖子路径，不盖 /repo-evil；deny 压过 allow。'))
}

function exp5(): void {
  console.log(bold('\n实验五：drain 拒新任务，kill 拒一切；健康检查'))
  const open = admitUnderDeploy({ mode: 'open' }, 'new_job')
  const drainNew = admitUnderDeploy({ mode: 'drain' }, 'new_job')
  const drainResume = admitUnderDeploy({ mode: 'drain' }, 'resume')
  const kill = admitUnderDeploy({ mode: 'kill', reason: 'cost spike' }, 'effect')
  const h = healthCheck({
    queueDepth: 3,
    maxQueue: 100,
    oldestQueuedAgeMs: 1000,
    maxQueueAgeMs: 60_000,
    errorRate: 0.01,
    maxErrorRate: 0.05,
    deploy: { mode: 'open' },
  })
  const start = startJob({
    deploy: { mode: 'drain' },
    usage: { userId: 'u', running: 0, queued: 0, costUsdToday: 0, tokensToday: 0 },
    policy: {
      maxConcurrentPerUser: 2,
      maxQueuedPerUser: 5,
      dailyCostUsd: 5,
      dailyTokens: 100000,
    },
    estimatedCostUsd: 0.2,
    estimatedTokens: 1000,
  })
  console.log(`  ${pad('open 新任务', 22)}${open.ok ? green('ALLOW') : red('DENY')}`)
  console.log(`  ${pad('drain 新任务', 22)}${drainNew.ok ? green('ALLOW') : red('DENY')}`)
  console.log(`  ${pad('drain 续跑', 22)}${drainResume.ok ? green('ALLOW') : red('DENY')}`)
  console.log(`  ${pad('kill 副作用', 22)}${kill.ok ? green('ALLOW') : red('DENY')}`)
  console.log(`  ${pad('health', 22)}${h.ok ? green('OK') : red('BAD')}`)
  console.log(`  ${pad('startJob@drain', 22)}${start.kind}`)
  console.log(dim('\n  发布时先 drain 再滚；kill 是成本尖刺时的总闸，不是「可选优化」。'))
}

function observe(): void {
  console.log(bold('L19 · 观察实验（参考实现）'))
  console.log(dim('跑完这些再去写 TODO。每一张表都对应一种「上线后才爆」的失败。'))
  exp1()
  exp2()
  exp3()
  exp4()
  exp5()
}

// ── TODO ─────────────────────────────────────────────────────

export function myApplyTransition(
  j: Job,
  ev: Parameters<typeof applyTransition>[1],
): ReturnType<typeof applyTransition> {
  throw new Error('TODO 1 未实现')
}

export function myCheckIdempotency(
  req: Parameters<typeof checkIdempotency>[0],
  prior: Parameters<typeof checkIdempotency>[1],
): ReturnType<typeof checkIdempotency> {
  throw new Error('TODO 2 未实现')
}

export function myShouldRetryEffect(
  ...args: Parameters<typeof shouldRetryEffect>
): ReturnType<typeof shouldRetryEffect> {
  throw new Error('TODO 3 未实现')
}

export function myAdmitJob(
  ...args: Parameters<typeof admitJob>
): ReturnType<typeof admitJob> {
  throw new Error('TODO 4 未实现')
}

export function myFairNext(
  ...args: Parameters<typeof fairNext>
): ReturnType<typeof fairNext> {
  throw new Error('TODO 5 未实现')
}

export function myStartJob(
  ...args: Parameters<typeof startJob>
): ReturnType<typeof startJob> {
  throw new Error('TODO 6 未实现')
}

void myApplyTransition
void myCheckIdempotency
void myShouldRetryEffect
void myAdmitJob
void myFairNext
void myStartJob
void recallApproval
void healthCheck

if (isMain(import.meta.url)) {
  observe()
  console.log(
    dim(
      '\n  下一步：实现文件下半部分的六个 TODO，然后跑 pnpm verify:l19（或 uv run python -m l19.verify）。',
    ) +
      dim('\n  想先确认测试本身是对的，跑 OPS_IMPL=shared 下的 verify。') +
      dim('\n  观察实验：pnpm ops / uv run python -m l19.ops\n'),
  )
}
