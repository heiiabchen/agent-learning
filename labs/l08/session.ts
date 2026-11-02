/**
 * L08 任务一：会话持久化与断点恢复。
 *
 *   pnpm session
 *
 * 不调 API。参考实现在 shared/store.ts。
 *
 * ★ 这个任务要打掉一个几乎所有人第一次都会犯的错：
 * **把 transcript 存下来当持久化。**
 *
 * transcript 是历史，不是状态。写代码之前先想清楚这两者的区别在哪。
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { rmSync } from 'node:fs'
import { isMain } from '../shared/entry.ts'

// ─────────────────────────────────────────────────────────────
// 事件定义（已给）
//
// ★ 注意 intent 和 outcome 是分开的两条事件，这是整个设计的核心。
//
// 合成一条的话（「第 3 步调用了 write_file 并成功了」），崩溃恢复就无解了：
// 你看不到「打算做但不知道做没做」这个状态，而那恰恰是崩溃后最常见的状态。
// ─────────────────────────────────────────────────────────────

export type Event =
  | { seq: number; at: number; t: 'task'; task: string }
  | { seq: number; at: number; t: 'intent'; step: number; tool: string; input: unknown; idem: string }
  | { seq: number; at: number; t: 'outcome'; step: number; idem: string; ok: boolean; content: string }
  | { seq: number; at: number; t: 'text'; text: string }
  | { seq: number; at: number; t: 'done'; reason: string }

export type EventInput =
  | { t: 'task'; task: string }
  | { t: 'intent'; step: number; tool: string; input: unknown; idem: string }
  | { t: 'outcome'; step: number; idem: string; ok: boolean; content: string }
  | { t: 'text'; text: string }
  | { t: 'done'; reason: string }

// ─────────────────────────────────────────────────────────────
// TODO 1：幂等键
//
// 同一个「工具 + 参数」在同一个会话里算同一次操作。
//
// ★ 必须按 key 排序后序列化，理由和 L05 的 repeatKey 完全一样：
// 对象字段顺序变了 key 就变了，防线静默失效。
//
// 用 sha256 取前 16 位十六进制就够——它只需要在一个会话内唯一。
// 记得把 sessionId 也拌进去，否则两个会话的相同调用会互相"跳过"。
// ─────────────────────────────────────────────────────────────

export function idemKey(sessionId: string, tool: string, input: unknown): string {
  void sessionId
  void tool
  void input
  void createHash
  throw new Error('TODO: 实现 idemKey')
}

// ─────────────────────────────────────────────────────────────
// TODO 2：从事件日志派生状态
//
// 这是「日志是事实，状态是算出来的」这个设计的核心函数。
//
// ★ pending 的定义是重点：**有 intent 但没有对应 outcome 的那些。**
//
// 日志停在 intent 说明进程死在「写完意图」和「写完结果」之间——
// 而副作用（写文件、发请求）就发生在那个窗口里。
// 所以这些操作**可能做了也可能没做**，这是崩溃恢复的全部难点。
//
// completed 用 idem 做键，因为恢复时要靠它跳过已完成的操作。
// pending 按 step 排序（恢复要从最早的未完成步开始）。
// ─────────────────────────────────────────────────────────────

export interface SessionState {
  task: string | null
  steps: number
  completed: Map<string, { ok: boolean; content: string }>
  pending: { step: number; tool: string; input: unknown; idem: string }[]
  lastText: string
  finished: boolean
  reason: string | null
}

export function reduce(events: Event[]): SessionState {
  void events
  throw new Error('TODO: 实现 reduce')
}

// ─────────────────────────────────────────────────────────────
// TODO 3：JSONL 文件存储
//
// ★ 为什么是 JSONL 而不是一个 JSON 数组，三条理由：
//
//   一 · **追加是 O(1)。** JSON 数组每次都要读全文、改、写回全文
//   二 · **崩溃只损坏最后一行。** 数组格式崩溃后整个文件都不是合法 JSON
//   三 · **能 tail -f。** 排查线上问题时这一条比前两条都实用
//
// ★ 读取时必须容忍坏行：崩溃时最后一行常常是写了一半的。
// 为这一行放弃整个会话，等于用一个小故障换一个大故障。
//
// 但**要数出来**（corrupt 字段）——静默跳过就没人知道发生过崩溃了。
// 这是这门课那条纪律的又一次出现：把静默失败变成响亮失败。
//
// seq 要从已有日志里接着排，不能每次从 0 开始。
// ─────────────────────────────────────────────────────────────

export interface Store {
  append(e: EventInput): Event
  read(): Event[]
  state(): SessionState
  readonly corrupt: number
}

export function fileStore(path: string): Store {
  void path
  void mkdirSync
  void dirname
  void existsSync
  void readFileSync
  void appendFileSync
  throw new Error('TODO: 实现 fileStore')
}

export function memoryStore(): Store {
  throw new Error('TODO: 实现 memoryStore')
}

// ─────────────────────────────────────────────────────────────
// TODO 4：快照
//
// 快照是为了避免每次恢复都 O(n) 回放全部日志。
//
// ★ 两个必须做对的地方：
//
// 一 · **快照必须记 upto**（覆盖到第几条事件）。
//      没有它你没法把快照和日志拼起来——要么重复应用事件，
//      要么漏掉事件，而两者都是静默的。
//
// 二 · **写快照必须先写临时文件再 rename。**
//      rename 在同一个文件系统内是原子的，所以读者永远看到
//      完整的旧版或完整的新版。直接写目标文件的话，崩在中间
//      会留下一个半截快照——而**快照坏了比没有快照更糟**，
//      因为你会从一个错误的状态继续跑。
//
// restore 里注意顺序：快照的 completed 先铺上，再让 tail 的事件覆盖。
// ─────────────────────────────────────────────────────────────

export interface Snapshot {
  upto: number
  state: {
    task: string | null
    steps: number
    completed: [string, { ok: boolean; content: string }][]
    lastText: string
    finished: boolean
    reason: string | null
  }
}

export function writeSnapshot(path: string, events: Event[]): Snapshot {
  void path
  void events
  void writeFileSync
  void renameSync
  throw new Error('TODO: 实现 writeSnapshot')
}

export function restore(snap: Snapshot | null, events: Event[]): SessionState {
  void snap
  void events
  throw new Error('TODO: 实现 restore')
}

// ─────────────────────────────────────────────────────────────
// TODO 5：恢复计划
//
// ★ 这是整个任务的重点。
//
// 工具按可重放性分三类：
//
//   'pure'       —— 没有副作用，随便重放。read_file / search
//   'idempotent' —— 有副作用但重复执行结果相同。write_file（覆盖写）
//   'once'       —— 重复执行会出事。send_email / create_order / git_commit
//
// pending 里的 'pure' 和 'idempotent' 直接重放。
//
// pending 里的 'once' 呢？它可能做了也可能没做，而重做会出事。
// **代码在这里没有正确答案，唯一诚实的做法是停下来问人。**
//
// 这就是为什么要有 ask 这个字段。很多人会在这里选一个默认行为
// （要么都重做，要么都跳过），而两个默认都会在某些情况下造成事故：
//   都重做 → 用户收到两封邮件 / 下了两个单
//   都跳过 → 该发的邮件没发，而日志显示这一步"完成"了
// ─────────────────────────────────────────────────────────────

export type Replayability = 'pure' | 'idempotent' | 'once'

export interface ResumePlan {
  skip: string[]
  redo: { step: number; tool: string; input: unknown; idem: string }[]
  ask: { step: number; tool: string; input: unknown; idem: string }[]
  resumeFrom: number
}

export function planResume(
  st: SessionState,
  replayability: (tool: string) => Replayability,
): ResumePlan {
  void st
  void replayability
  throw new Error('TODO: 实现 planResume')
}

export function describePlan(plan: ResumePlan): string {
  void plan
  throw new Error('TODO: 实现 describePlan')
}

export const sessionPath = (dir: string, id: string) => join(dir, `${id}.jsonl`)
export const snapshotPath = (dir: string, id: string) => join(dir, `${id}.snapshot.json`)

// ─────────────────────────────────────────────────────────────
// 观察实验
// ─────────────────────────────────────────────────────────────

const DIR = join(import.meta.dirname, '.sessions')

function fresh(id: string): Store {
  rmSync(sessionPath(DIR, id), { force: true })
  rmSync(snapshotPath(DIR, id), { force: true })
  return fileStore(sessionPath(DIR, id))
}

function demoHistoryVsState() {
  console.log('\n【一】历史 vs 状态：为什么不能存 transcript')

  const s = fresh('demo1')
  const sid = 'demo1'
  s.append({ t: 'task', task: '把 config.json 里的端口改成 8080' })

  for (const [step, tool, input] of [
    [1, 'read_file', { path: 'config.json' }],
    [2, 'read_file', { path: 'config.json' }], // 模型又读了一遍
    [3, 'write_file', { path: 'config.json', content: '{"port":8080}' }],
  ] as const) {
    const idem = idemKey(sid, tool, input)
    s.append({ t: 'intent', step, tool, input, idem })
    s.append({ t: 'outcome', step, idem, ok: true, content: '(结果)' })
  }

  const st = s.state()
  console.log(`  日志里有 ${s.read().length} 条事件`)
  console.log(`  派生出的状态：task=「${st.task}」，完成 ${st.completed.size} 个操作，${st.steps} 步`)
  console.log(`  注意 completed 是 ${st.completed.size} 个而不是 3 个——第 1、2 步参数一样，`)
  console.log('  幂等键相同，所以它们是同一次操作。')
  console.log('\n  如果存的是 transcript，你只有一串消息；')
  console.log('  「现在完成了哪些操作」得靠人读一遍才知道，而且没法用代码判断。')
}

function demoCrash() {
  console.log('\n【二】崩溃：intent 和 outcome 之间那个窗口')

  const sid = 'demo2'
  const s = fresh(sid)
  s.append({ t: 'task', task: '给三个客户发对账单' })

  // 前两步完整
  for (const [step, to] of [
    [1, 'a@x.com'],
    [2, 'b@x.com'],
  ] as const) {
    const idem = idemKey(sid, 'send_email', { to })
    s.append({ t: 'intent', step, tool: 'send_email', input: { to }, idem })
    s.append({ t: 'outcome', step, idem, ok: true, content: 'sent' })
  }

  // 第三步：写了 intent 就崩了
  const idem3 = idemKey(sid, 'send_email', { to: 'c@x.com' })
  s.append({ t: 'intent', step: 3, tool: 'send_email', input: { to: 'c@x.com' }, idem: idem3 })
  console.log('  （进程在这里被 kill）')

  const reopened = fileStore(sessionPath(DIR, sid))
  const st = reopened.state()
  console.log(`\n  恢复时读到：完成 ${st.completed.size} 个，pending ${st.pending.length} 个`)
  console.log(`  pending 那个是：${st.pending[0]!.tool}(${JSON.stringify(st.pending[0]!.input)})`)
  console.log('\n  ★ 这封邮件发出去了吗？**日志无法回答。**')
  console.log('  进程死在「写完意图」和「写完结果」之间，而 sendEmail 就在那个窗口里执行。')

  const plan = planResume(st, (tool) => (tool === 'send_email' ? 'once' : 'pure'))
  console.log(`\n  恢复计划：${describePlan(plan)}`)
  console.log('\n  两个"聪明"的默认都会出事：')
  console.log('    都重做 → 客户 c 收到两封对账单')
  console.log('    都跳过 → 客户 c 一封都没收到，而日志显示这一步"处理过了"')
  console.log('  所以正确答案是 ask。**代码在这里没有正确答案。**')
}

function demoReplayability() {
  console.log('\n【三】同样的崩溃，不同的工具，不同的处置')

  const sid = 'demo3'
  const s = fresh(sid)
  s.append({ t: 'task', task: '整理代码' })

  const tools = [
    ['read_file', { path: 'a.ts' }, 'pure'],
    ['write_file', { path: 'b.ts', content: 'x' }, 'idempotent'],
    ['git_commit', { message: 'refactor' }, 'once'],
  ] as const

  tools.forEach(([tool, input], i) => {
    s.append({ t: 'intent', step: i + 1, tool, input, idem: idemKey(sid, tool, input) })
  })

  const kinds = new Map<string, Replayability>(tools.map(([t, , k]) => [t, k]))
  const plan = planResume(s.state(), (t) => kinds.get(t) ?? 'once')

  console.log(`  三个操作全部 pending（全都崩在窗口里）。恢复计划：`)
  console.log(`    重放：${plan.redo.map((r) => r.tool).join('、') || '（无）'}`)
  console.log(`    问人：${plan.ask.map((r) => r.tool).join('、') || '（无）'}`)
  console.log('\n  read_file 重放零风险，write_file 覆盖写重放也没事，')
  console.log('  git_commit 重放会多一个空提交或者报错——所以只有它需要问。')
  console.log('\n  ★ 这个分类必须由**工具的作者**声明，不能让恢复逻辑猜。')
  console.log('  猜的话，新加一个工具就是一次潜在事故。')
}

function demoCorrupt() {
  console.log('\n【四】坏行：崩溃时写了一半的那一行')

  const sid = 'demo4'
  const s = fresh(sid)
  s.append({ t: 'task', task: '任务' })
  const idem = idemKey(sid, 'read_file', { path: 'a' })
  s.append({ t: 'intent', step: 1, tool: 'read_file', input: { path: 'a' }, idem })

  // 手动追加一个写了一半的行，模拟崩溃
  appendFileSync(sessionPath(DIR, sid), '{"seq":3,"at":1,"t":"outco', 'utf8')

  const reopened = fileStore(sessionPath(DIR, sid))
  const events = reopened.read()
  console.log(`  文件里有 3 行，读出来 ${events.length} 条有效事件，坏行 ${reopened.corrupt} 条`)
  console.log('\n  ★ 两件事都要做到：')
  console.log('    容忍 —— 不能因为最后一行坏了就放弃整个会话')
  console.log('    记数 —— corrupt > 0 说明发生过崩溃，这条要进日志和监控')
  console.log('  只做第一件的话，你永远不知道线上崩过多少次。')
}

function demoSnapshot() {
  console.log('\n【五】快照：加速，但不是事实来源')

  const sid = 'demo5'
  const s = fresh(sid)
  s.append({ t: 'task', task: '长任务' })
  for (let i = 1; i <= 20; i++) {
    const idem = idemKey(sid, 'read_file', { path: `f${i}.ts` })
    s.append({ t: 'intent', step: i, tool: 'read_file', input: { path: `f${i}.ts` }, idem })
    s.append({ t: 'outcome', step: i, idem, ok: true, content: '(内容)' })
  }

  const snap = writeSnapshot(snapshotPath(DIR, sid), s.read())
  console.log(`  日志 ${s.read().length} 条，快照覆盖到 seq=${snap.upto}`)

  // 快照之后又跑了两步
  for (let i = 21; i <= 22; i++) {
    const idem = idemKey(sid, 'read_file', { path: `f${i}.ts` })
    s.append({ t: 'intent', step: i, tool: 'read_file', input: { path: `f${i}.ts` }, idem })
    s.append({ t: 'outcome', step: i, idem, ok: true, content: '(内容)' })
  }

  const fromSnap = restore(snap, s.read())
  const fromScratch = reduce(s.read())
  console.log(`  从快照恢复：${fromSnap.completed.size} 个完成操作，${fromSnap.steps} 步`)
  console.log(`  从头回放：  ${fromScratch.completed.size} 个完成操作，${fromScratch.steps} 步`)
  console.log(`  一致：${fromSnap.completed.size === fromScratch.completed.size ? '是' : '★ 不一致，有 bug'}`)
  console.log('\n  快照只是加速。**日志才是事实来源**——所以快照坏了要能丢掉重放，')
  console.log('  而这要求快照文件和日志文件是分开的两个文件。')
}

// ─────────────────────────────────────────────────────────────
// TODO 6：动手改一个地方，看它怎么坏
//
// 把 writeSnapshot 里的「先写 tmp 再 rename」改成直接写目标文件。
// 然后想清楚：在什么时刻被 kill 会留下一个半截快照？
// 下一次 restore 会发生什么？为什么这比"没有快照"更糟？
//
// 改完记得改回来。
// ─────────────────────────────────────────────────────────────

function main() {
  console.log('会话持久化与断点恢复。不调 API。')
  demoHistoryVsState()
  demoCrash()
  demoReplayability()
  demoCorrupt()
  demoSnapshot()
  console.log('\n' + '─'.repeat(60))
  console.log('接着做 l08/memory.ts。别忘了 TODO 6。')
}

// verify.ts 会 import 这个文件来测你写的函数。不加这道判断的话，
// import 的那一刻观察实验就跑起来了，verify 的输出会变成第一个 TODO
// 的堆栈，而不是一张「还有哪些没写」的清单。
if (isMain(import.meta.url)) main()
