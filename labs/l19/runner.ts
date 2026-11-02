/**
 * 真跑长任务观察——与 verify 分开。
 * 用法：pnpm exec tsx --env-file=.env l19/runner.ts
 *
 * 这里只演示状态机与幂等在「假时钟」下的形状；
 * 接真模型时把每次 tool 调用写成 checkpoint + EffectRecord。
 */

import {
  applyTransition,
  checkIdempotency,
  startJob,
  type Job,
} from '../shared/ops.ts'

let j: Job = {
  id: 'demo',
  userId: 'u1',
  status: 'queued',
  createdAt: 0,
  updatedAt: 0,
  costUsd: 0,
  tokens: 0,
  epoch: 0,
  idempotencyKey: 'run-1',
}

const admit = startJob({
  deploy: { mode: 'open' },
  usage: { userId: 'u1', running: 0, queued: 0, costUsdToday: 0, tokensToday: 0 },
  policy: {
    maxConcurrentPerUser: 2,
    maxQueuedPerUser: 5,
    dailyCostUsd: 10,
    dailyTokens: 1_000_000,
  },
  estimatedCostUsd: 0.5,
  estimatedTokens: 10_000,
  idempotencyKey: 'run-1',
})
console.log('startJob:', admit)

j = applyTransition(j, { type: 'claim', workerId: 'w1', now: 1000, leaseMs: 30_000 }).job
j = applyTransition(j, {
  type: 'checkpoint',
  workerId: 'w1',
  epoch: j.epoch,
  now: 2000,
  checkpoint: { seq: 1, toolCallsDone: 1, workspaceHash: 'h0' },
}).job

const effect = checkIdempotency(
  { key: 'edit:src/main.ts', effectClass: 'idempotent_write', payloadHash: 'abc' },
  undefined,
)
console.log('first effect:', effect)
console.log('job:', j.status, 'seq', j.checkpoint?.seq)
console.log('\n接真模型：每次工具前后写 checkpoint；副作用带 key；断线用 eventsAfter 续。')
