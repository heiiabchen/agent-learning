/**
 * L08 任务三：把持久化接到 agent 上，然后中途杀掉它。
 *
 *   pnpm resume
 *
 * 不调 API——用假模型，因为**崩溃恢复必须能确定性地复现**。
 * 让真模型在你想要的那一步崩溃是做不到的。
 *
 * 这个脚本跑四个场景，每一个都是一种真实的恢复姿势：
 *
 *   一 · 不做持久化，崩了从头再来        —— 看代价
 *   二 · 只存 transcript                —— 看它为什么不够
 *   三 · 事件日志 + 幂等键               —— 正确的做法
 *   四 · pending 里有一个 'once' 工具     —— 代码没有正确答案的那种情况
 */

import type Anthropic from '@anthropic-ai/sdk'
import { Ledger } from '../shared/ledger.ts'
import { fakeModel, type FakeTurn } from '../shared/fake.ts'
import {
  describePlan,
  fileStore,
  idemKey,
  planResume,
  sessionPath,
  type Replayability,
  type Store,
} from '../shared/store.ts'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(import.meta.dirname, '.sessions')

// ─────────────────────────────────────────────────────────────
// 一个带副作用的假世界
//
// 副作用要**可观察**，否则你没法验证恢复到底做对了没有。
// 这里用一个计数器数「邮件发了几封」。
// ─────────────────────────────────────────────────────────────

interface World {
  files: Map<string, string>
  /** 发出去的邮件。重复发会在这里留下两条——这就是我们要防的东西。 */
  emailsSent: string[]
  /** 提交历史。 */
  commits: string[]
  toolCalls: number
}

const newWorld = (): World => ({
  files: new Map([
    ['a.md', '客户 A 的对账数据'],
    ['b.md', '客户 B 的对账数据'],
    ['c.md', '客户 C 的对账数据'],
  ]),
  emailsSent: [],
  commits: [],
  toolCalls: 0,
})

const REPLAYABILITY: Record<string, Replayability> = {
  read_file: 'pure',
  write_file: 'idempotent',
  send_email: 'once',
  git_commit: 'once',
}

function execute(w: World, tool: string, input: Record<string, unknown>): string {
  w.toolCalls++
  switch (tool) {
    case 'read_file':
      return w.files.get(String(input.path)) ?? `找不到 ${input.path}`
    case 'write_file':
      w.files.set(String(input.path), String(input.content))
      return `已写入 ${input.path}`
    case 'send_email':
      w.emailsSent.push(String(input.to))
      return `已发送给 ${input.to}`
    case 'git_commit':
      w.commits.push(String(input.message))
      return `已提交：${input.message}`
    default:
      return `未知工具 ${tool}`
  }
}

// ─────────────────────────────────────────────────────────────
// 脚本：读三个文件，给三个客户各发一封邮件，最后提交
// ─────────────────────────────────────────────────────────────

const SCRIPT: FakeTurn[] = [
  { toolUses: [{ name: 'read_file', input: { path: 'a.md' } }] },
  { toolUses: [{ name: 'send_email', input: { to: 'a@x.com' } }] },
  { toolUses: [{ name: 'read_file', input: { path: 'b.md' } }] },
  { toolUses: [{ name: 'send_email', input: { to: 'b@x.com' } }] },
  { toolUses: [{ name: 'read_file', input: { path: 'c.md' } }] },
  { toolUses: [{ name: 'send_email', input: { to: 'c@x.com' } }] },
  { toolUses: [{ name: 'git_commit', input: { message: '对账完成' } }] },
  { text: '三个客户的对账单都发出去了。' },
]

/** 崩溃点：在第 n 次工具执行的**哪个阶段**崩。 */
type CrashAt = { step: number; when: 'after_intent' | 'after_outcome' } | null

interface RunResult {
  world: World
  modelCalls: number
  crashed: boolean
  yuan: number
}

/**
 * 一个极简的、带持久化的 agent loop。
 *
 * 只保留 L05 那个 loop 里和持久化相关的骨架，其余（预算、超时、重复检测）
 * 都省了——不是因为不重要，是因为这个脚本要盯的是另一件事。
 */
async function run(
  store: Store | null,
  world: World,
  crashAt: CrashAt,
  opts: { skipCompleted: boolean; startStep?: number } = { skipCompleted: false },
): Promise<RunResult> {
  const sid = 'resume-demo'
  const ledger = new Ledger('run')
  const model = fakeModel({ script: SCRIPT, afterScript: 'final' })
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: '给三个客户发对账单' }]
  const completed = opts.skipCompleted && store ? store.state().completed : new Map()

  let step = 0
  let modelCalls = 0

  // 恢复时要把假模型的脚本指针推到正确的位置。
  //
  // 这几次空转**不计入 modelCalls，也不进账本**——它是假模型的实现细节，
  // 不是真实行为。真实的 loop 在这一步是从日志重建 transcript，
  // 一次模型调用都不用发。
  const skipTo = opts.startStep ?? 1
  while (step + 1 < skipTo) {
    step++
    await model.call(messages)
  }

  for (;;) {
    if (step >= 12) break
    step++
    const res = await model.call(messages)
    modelCalls++
    ledger.record({
      label: `step ${step}`,
      id: res.id,
      model: res.model,
      usage: res.usage,
      ms: 1,
    })
    messages.push({ role: 'assistant', content: res.content })

    if (res.stop_reason !== 'tool_use') {
      store?.append({ t: 'done', reason: 'done' })
      break
    }

    const uses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => (b as { type: string }).type === 'tool_use',
    )
    const results: Anthropic.ToolResultBlockParam[] = []

    for (const u of uses) {
      const input = (u.input ?? {}) as Record<string, unknown>
      const idem = idemKey(sid, u.name, input)

      // ★ 幂等键的全部意义在这一行：已经做过的操作直接拿旧结果。
      const done = completed.get(idem)
      if (done) {
        results.push({ type: 'tool_result', tool_use_id: u.id, content: done.content })
        continue
      }

      // ★ 先写 intent，再执行。顺序反了的话崩溃恢复就无解了。
      store?.append({ t: 'intent', step, tool: u.name, input, idem })

      if (crashAt && crashAt.step === step && crashAt.when === 'after_intent') {
        return { world, modelCalls, crashed: true, yuan: ledger.totals().yuan }
      }

      const content = execute(world, u.name, input)
      store?.append({ t: 'outcome', step, idem, ok: true, content })

      if (crashAt && crashAt.step === step && crashAt.when === 'after_outcome') {
        return { world, modelCalls, crashed: true, yuan: ledger.totals().yuan }
      }

      results.push({ type: 'tool_result', tool_use_id: u.id, content })
    }

    messages.push({ role: 'user', content: results })
  }

  return { world, modelCalls, crashed: false, yuan: ledger.totals().yuan }
}

// ─────────────────────────────────────────────────────────────

function freshStore(): Store {
  mkdirSync(DIR, { recursive: true })
  rmSync(sessionPath(DIR, 'resume-demo'), { force: true })
  return fileStore(sessionPath(DIR, 'resume-demo'))
}

function report(label: string, r: RunResult, extra?: string) {
  const emails = r.world.emailsSent
  const dupes = emails.filter((e, i) => emails.indexOf(e) !== i)
  console.log(
    `  ${label.padEnd(22)} 付费调用 ${String(r.modelCalls).padStart(2)} · ` +
      `工具执行累计 ${String(r.world.toolCalls).padStart(2)} · ` +
      `邮件 ${emails.length} 封` +
      (dupes.length > 0 ? ` \x1b[31m（重复 ${dupes.length} 封：${dupes.join('、')}）\x1b[0m` : '') +
      ` · ¥${r.yuan.toFixed(4)}`,
  )
  if (extra) console.log(`    ${extra}`)
}

async function scenarioNoPersistence() {
  console.log('\n【一】不做持久化：崩了从头再来')

  const w = newWorld()
  const crashed = await run(null, w, { step: 4, when: 'after_outcome' })
  report('崩溃前', crashed)

  // 从头再跑一遍，用的是同一个 world（副作用累积了）
  const again = await run(null, w, null)
  report('从头重跑', again)

  const dupes = w.emailsSent.filter((e, i) => w.emailsSent.indexOf(e) !== i)
  console.log(
    `\n  ★ 本该 3 封邮件，实际发出 ${w.emailsSent.length} 封，其中 ${dupes.length} 封是重复的。`,
  )
  console.log(`  而且崩溃前那 ${crashed.modelCalls} 次模型调用和 ${crashed.world.toolCalls} 次工具执行全部白付。`)
  console.log('  一个跑了 40 步的任务在第 38 步崩掉，这两笔代价都不可接受。')
}

async function scenarioTranscriptOnly() {
  console.log('\n【二】只存 transcript：为什么它不够')

  console.log('  假设你把 messages 数组存下来了，崩溃后读回来。你有：')
  console.log('    · 一串消息，包含 tool_use 块和 tool_result 块')
  console.log('  你没有：')
  console.log('    · 「哪些操作真的执行完了」——tool_result 存在说明执行完了，')
  console.log('      但**崩在 tool_use 和 tool_result 之间的那一次没有记录**')
  console.log('    · 「同一个操作会不会被重复执行」——没有幂等键，没法判断')
  console.log('    · 「现在该从哪一步继续」——得靠数消息条数，而这个数会随')
  console.log('      压缩（L06）而改变')
  console.log('\n  ★ 最要命的是第一条：transcript 里「没做」和「做了但没记上」')
  console.log('  长得**完全一样**。而恰恰是这两者的区别决定了要不要重做。')
  console.log('\n  这就是为什么要把 intent 和 outcome 拆成两条事件。')
}

async function scenarioEventLog() {
  console.log('\n【三】事件日志 + 幂等键：崩在 outcome 之后')

  const store = freshStore()
  const w = newWorld()
  store.append({ t: 'task', task: '给三个客户发对账单' })

  const crashed = await run(store, w, { step: 4, when: 'after_outcome' })
  report('崩溃前', crashed)

  const st = store.state()
  const plan = planResume(st, (t) => REPLAYABILITY[t] ?? 'once')
  console.log(`    恢复计划：${describePlan(plan)}`)

  const resumed = await run(store, w, null, {
    skipCompleted: true,
    startStep: plan.resumeFrom,
  })
  report('恢复后继续', resumed)

  console.log(`\n  最终邮件：${w.emailsSent.join('、')}`)
  console.log('  ★ 三封，不重不漏。')
  console.log('\n  两个机制各起了一半作用：')
  console.log('    resumeFrom 让 loop 不从第一步开始')
  console.log('    幂等键让"万一还是重放了"的那些操作直接拿旧结果')
  console.log('  **两者都要有。** 只有第一个的话，压缩改了消息数就会算错起点；')
  console.log('  只有第二个的话，你要重放全部历史，钱照付。')
}

async function scenarioPendingOnce() {
  console.log("\n【四】崩在 intent 之后：代码没有正确答案的那种情况")

  const store = freshStore()
  const w = newWorld()
  store.append({ t: 'task', task: '给三个客户发对账单' })

  // 第 4 步是 send_email(b@x.com)，崩在 intent 之后、执行之前/之后不确定
  const crashed = await run(store, w, { step: 4, when: 'after_intent' })
  report('崩溃前', crashed)

  const st = store.state()
  console.log(`\n    完成 ${st.completed.size} 个操作，pending ${st.pending.length} 个`)
  for (const p of st.pending) {
    console.log(`    pending：${p.tool}(${JSON.stringify(p.input)}) 第 ${p.step} 步`)
  }

  const plan = planResume(st, (t) => REPLAYABILITY[t] ?? 'once')
  console.log(`\n    恢复计划：${describePlan(plan)}`)

  console.log('\n  ★ 这封邮件发出去了吗？**日志无法回答。**')
  console.log(`  实际上（因为这是模拟，我们能作弊看一眼）：已发 ${w.emailsSent.length} 封`)
  console.log('  但线上你看不到这个数字——邮件服务商那边的状态你查不到，')
  console.log('  或者查得到但要等几分钟，或者要花钱查。')
  console.log('\n  两个"聪明"的默认都会出事：')
  console.log('    都重做 → 客户可能收到两封对账单')
  console.log('    都跳过 → 该发的可能没发，而日志显示这一步"处理过了"')
  console.log('\n  所以正确答案是 ask：**停下来，把这一条交给人。**')
  console.log('  这不是偷懒，是这个位置上唯一诚实的做法。')

  console.log('\n  而真正的工程解法是往上一层走，让这个问题不再出现：')
  console.log('    · 让副作用本身幂等——发邮件时带一个去重键，服务端保证同键只发一次')
  console.log('    · 或者把"发送"拆成"入队 + 消费"，入队幂等，消费由队列保证恰好一次')
  console.log('  ★ **恢复逻辑处理不了的问题，要在副作用的设计层面解决。**')
}

async function main() {
  console.log('崩溃与恢复。不调 API——因为崩溃恢复必须能确定性地复现。')
  await scenarioNoPersistence()
  await scenarioTranscriptOnly()
  await scenarioEventLog()
  await scenarioPendingOnce()

  console.log('\n' + '─'.repeat(70))
  console.log(`
【这一节的账】

  没有持久化：崩在第 38 步 = 38 步全部重付，加上重复的副作用
  只存 transcript：能省钱，但**分不清"没做"和"做了没记上"**
  事件日志 + 幂等键：省钱，而且不重不漏
  pending 里的 once 工具：代码解决不了，要么问人，要么改副作用的设计

【TODO】

  1. 把【三】的崩溃点从 after_outcome 改成 after_intent，
     再跑一遍。read_file 是 pure，所以恢复计划会怎么变？
     为什么这次不需要问人？

  2. 把 REPLAYABILITY 里的 send_email 从 'once' 改成 'idempotent'，
     跑【四】。发生了什么？这对应线上什么样的事故？

  3. 想清楚：git_commit 为什么是 'once'？
     重复执行它最坏的后果是什么（提示：不是"多一个提交"）？
`)
}

await main()
