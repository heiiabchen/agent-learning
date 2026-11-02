/**
 * 验证 l08/session.ts 和 l08/memory.ts。跑法：pnpm verify:l08
 *
 * 一次 API 都不调。
 *
 * 这套测试里有一整组专门盯着**记忆污染**和**恢复不幂等**：
 * 冲突静默覆盖、推导深度不限、坏行静默跳过、pending 里的 once 工具被默认处置。
 * 它们都不抛异常，只是让你的记忆慢慢跑偏、或者让客户收到两封邮件。
 *
 * 先跑 VERIFY_TARGET=shared pnpm verify:l08 确认测试本身是对的。
 */

import { mkdtempSync, appendFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── 模块形状。Memory 是 class（名义类型），必须走接口 ────────────────

interface Event {
  seq: number
  at: number
  t: string
  [k: string]: unknown
}

interface SessionState {
  task: string | null
  steps: number
  completed: Map<string, { ok: boolean; content: string }>
  pending: { step: number; tool: string; input: unknown; idem: string }[]
  lastText: string
  finished: boolean
  reason: string | null
}

interface Snapshot {
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

interface Store {
  append(e: Record<string, unknown>): Event
  read(): Event[]
  state(): SessionState
  readonly corrupt: number
}

type Replayability = 'pure' | 'idempotent' | 'once'

interface ResumePlan {
  skip: string[]
  redo: { step: number; tool: string; input: unknown; idem: string }[]
  ask: { step: number; tool: string; input: unknown; idem: string }[]
  resumeFrom: number
}

interface StoreModule {
  idemKey(sessionId: string, tool: string, input: unknown): string
  reduce(events: Event[]): SessionState
  fileStore(path: string): Store
  memoryStore(): Store
  writeSnapshot(path: string, events: Event[]): Snapshot
  restore(snap: Snapshot | null, events: Event[]): SessionState
  planResume(st: SessionState, r: (tool: string) => Replayability): ResumePlan
  describePlan(plan: ResumePlan): string
}

type FactKind = 'observed' | 'derived'

interface Fact {
  key: string
  value: string
  kind: FactKind
  source: string
  evidence?: string
  depth: number
  confidence: number
  createdAt: number
  updatedAt: number
  hits: number
  ttlMs?: number
}

type FactInput = Omit<Fact, 'createdAt' | 'updatedAt' | 'hits'>

interface MemoryLike {
  remember(
    input: FactInput,
    opts?: { resolve?: 'keep' | 'replace' },
  ): {
    written: boolean
    conflict?: { key: string; existing: Fact; incoming: FactInput }
    reason?: string
  }
  recall(keys?: string[]): { fact: Fact; stale: boolean }[]
  forget(pred: (f: Fact) => boolean): number
  evict(limit: number): Fact[]
  readonly size: number
  all(): Fact[]
}

interface Extraction {
  key: string
  value: string
  kind: FactKind
  evidence?: string
  confidence: number
}

interface MemoryModule {
  Memory: new (opts?: { minConfidence?: number; maxDepth?: number; now?: () => number }) => MemoryLike
  renderMemory(items: { fact: Fact; stale: boolean }[]): string
  parseExtraction(raw: string): { facts: Extraction[]; skipped: string[] }
  findContradictions(facts: Extraction[]): { key: string; values: string[] }[]
}

const target = process.env.VERIFY_TARGET === 'shared' ? 'shared' : 'mine'
const S: StoreModule =
  target === 'shared'
    ? ((await import('../shared/store.ts')) as unknown as StoreModule)
    : ((await import('./session.ts')) as unknown as StoreModule)
const M: MemoryModule =
  target === 'shared'
    ? ((await import('../shared/memory.ts')) as unknown as MemoryModule)
    : ((await import('./memory.ts')) as unknown as MemoryModule)

console.log(target === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l08/ 里你的实现）')

let passed = 0
const failures: string[] = []

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`\x1b[32m  ✓\x1b[0m ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`\x1b[31m  ✕ ${name}\x1b[0m`)
    console.log(`\x1b[31m      ${(err as Error).message}\x1b[0m`)
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

async function raises(fn: () => unknown, hint: string) {
  try {
    await fn()
  } catch (err) {
    if ((err as Error).message.startsWith('TODO:')) throw err
    return
  }
  throw new Error(`应该抛异常但没有：${hint}`)
}

const TMP = mkdtempSync(join(tmpdir(), 'l08-'))
let n = 0
const tmpFile = () => join(TMP, `s${++n}.jsonl`)

// ─────────────────────────────────────────────────────────────
console.log('\n幂等键')
// ─────────────────────────────────────────────────────────────

await test('同样的输入给同样的键', () => {
  const a = S.idemKey('s1', 'read_file', { path: 'a.ts' })
  const b = S.idemKey('s1', 'read_file', { path: 'a.ts' })
  assert(a === b, `不稳定：${a} vs ${b}`)
})

await test('★ 字段顺序变了键不能变', () => {
  const a = S.idemKey('s1', 'write', { path: 'a', content: 'x' })
  const b = S.idemKey('s1', 'write', { content: 'x', path: 'a' })
  assert(
    a === b,
    `顺序不同键就不同（${a} vs ${b}）。\n` +
      '      这是 L05 repeatKey 那个坑的同一个版本：\n' +
      '      直接 JSON.stringify 的话，SDK 换一版字段顺序，你的幂等防线就静默失效了',
  )
})

await test('不同工具给不同键', () => {
  assert(
    S.idemKey('s1', 'read_file', { p: 1 }) !== S.idemKey('s1', 'write_file', { p: 1 }),
    '不同工具的键撞了',
  )
})

await test('★ 不同会话给不同键（否则会跨会话误跳过）', () => {
  assert(
    S.idemKey('s1', 'read_file', { p: 1 }) !== S.idemKey('s2', 'read_file', { p: 1 }),
    '两个会话的相同调用键相同，恢复时会互相"跳过"对方的操作',
  )
})

await test('嵌套对象也稳定', () => {
  const a = S.idemKey('s', 't', { a: { x: 1, y: 2 }, b: [1, 2] })
  const b = S.idemKey('s', 't', { b: [1, 2], a: { y: 2, x: 1 } })
  assert(a === b, '嵌套对象的字段顺序影响了键')
})

// ─────────────────────────────────────────────────────────────
console.log('\n派生状态')
// ─────────────────────────────────────────────────────────────

const ev = (t: string, o: Record<string, unknown> = {}, seq = 0): Event =>
  ({ seq, at: seq, t, ...o }) as Event

await test('task 事件填 task 字段', () => {
  const st = S.reduce([ev('task', { task: '干活' }, 1)])
  assert(st.task === '干活', `实际 ${st.task}`)
})

await test('intent + outcome 配对后进 completed', () => {
  const st = S.reduce([
    ev('intent', { step: 1, tool: 'read', input: {}, idem: 'k1' }, 1),
    ev('outcome', { step: 1, idem: 'k1', ok: true, content: '内容' }, 2),
  ])
  assert(st.completed.size === 1, `completed 应该 1 个，实际 ${st.completed.size}`)
  assert(st.completed.get('k1')?.content === '内容', 'content 没存进去')
  assert(st.pending.length === 0, `配对了就不该 pending，实际 ${st.pending.length}`)
})

await test('★ 只有 intent 没有 outcome 的进 pending', () => {
  const st = S.reduce([ev('intent', { step: 3, tool: 'send_email', input: { to: 'a' }, idem: 'k' }, 1)])
  assert(
    st.pending.length === 1,
    `pending 应该 1 个，实际 ${st.pending.length}。\n` +
      '      这是崩溃恢复的全部难点：这些操作可能做了也可能没做',
  )
  assert(st.pending[0]!.tool === 'send_email', `实际 ${st.pending[0]!.tool}`)
})

await test('pending 按 step 排序（恢复要从最早的未完成步开始）', () => {
  const st = S.reduce([
    ev('intent', { step: 5, tool: 'a', input: {}, idem: 'k5' }, 1),
    ev('intent', { step: 2, tool: 'b', input: {}, idem: 'k2' }, 2),
    ev('intent', { step: 9, tool: 'c', input: {}, idem: 'k9' }, 3),
  ])
  assert(
    st.pending.map((p) => p.step).join(',') === '2,5,9',
    `没排序：${st.pending.map((p) => p.step).join(',')}`,
  )
})

await test('steps 取已完成步的最大值', () => {
  const st = S.reduce([
    ev('intent', { step: 1, tool: 'a', input: {}, idem: 'k1' }, 1),
    ev('outcome', { step: 1, idem: 'k1', ok: true, content: '' }, 2),
    ev('intent', { step: 7, tool: 'b', input: {}, idem: 'k7' }, 3),
    ev('outcome', { step: 7, idem: 'k7', ok: true, content: '' }, 4),
  ])
  assert(st.steps === 7, `steps 应该是 7，实际 ${st.steps}`)
})

await test('done 事件设 finished 和 reason', () => {
  const st = S.reduce([ev('done', { reason: 'step_limit' }, 1)])
  assert(st.finished, 'finished 应该是 true')
  assert(st.reason === 'step_limit', `reason 实际 ${st.reason}`)
})

await test('失败的 outcome 也算完成（不该重做）', () => {
  const st = S.reduce([
    ev('intent', { step: 1, tool: 'a', input: {}, idem: 'k' }, 1),
    ev('outcome', { step: 1, idem: 'k', ok: false, content: '文件不存在' }, 2),
  ])
  assert(
    st.completed.size === 1 && st.pending.length === 0,
    '失败的调用已经执行过了，重做会得到同样的失败还多付一次钱',
  )
  assert(st.completed.get('k')?.ok === false, 'ok 标记要保留')
})

// ─────────────────────────────────────────────────────────────
console.log('\n存储')
// ─────────────────────────────────────────────────────────────

await test('内存 store 的 append / read / state 联通', () => {
  const s = S.memoryStore()
  s.append({ t: 'task', task: 'x' })
  assert(s.read().length === 1, `实际 ${s.read().length}`)
  assert(s.state().task === 'x', '状态没派生出来')
})

await test('append 自动填 seq 和 at', () => {
  const s = S.memoryStore()
  const a = s.append({ t: 'text', text: '1' })
  const b = s.append({ t: 'text', text: '2' })
  assert(a.seq === 1 && b.seq === 2, `seq 不对：${a.seq}, ${b.seq}`)
  assert(typeof a.at === 'number' && a.at > 0, 'at 没填')
})

await test('文件 store 落盘并读回', () => {
  const p = tmpFile()
  const s = S.fileStore(p)
  s.append({ t: 'task', task: '落盘测试' })
  s.append({ t: 'text', text: 'hello' })
  const reopened = S.fileStore(p)
  assert(reopened.read().length === 2, `读回 ${reopened.read().length} 条`)
  assert(reopened.state().task === '落盘测试', '状态不对')
})

await test('★ 是 JSONL：一行一个事件（能 tail、崩溃只坏一行）', () => {
  const p = tmpFile()
  const s = S.fileStore(p)
  s.append({ t: 'text', text: 'a' })
  s.append({ t: 'text', text: 'b' })
  const lines = readFileSync(p, 'utf8').trim().split('\n')
  assert(
    lines.length === 2,
    `应该是 2 行，实际 ${lines.length}。\n` +
      '      写成 JSON 数组的话：追加是 O(n)，而且崩溃后整个文件都不是合法 JSON',
  )
  for (const l of lines) JSON.parse(l) // 每行独立合法
})

await test('重新打开时 seq 接着排（不能从 0 重来）', () => {
  const p = tmpFile()
  S.fileStore(p).append({ t: 'text', text: 'a' })
  const s2 = S.fileStore(p)
  const e = s2.append({ t: 'text', text: 'b' })
  assert(e.seq === 2, `seq 应该是 2，实际 ${e.seq}。重复的 seq 会让快照对不齐`)
})

await test('★ 容忍写了一半的最后一行（崩溃现场）', () => {
  const p = tmpFile()
  const s = S.fileStore(p)
  s.append({ t: 'task', task: 'x' })
  appendFileSync(p, '{"seq":2,"at":1,"t":"outco', 'utf8')
  const reopened = S.fileStore(p)
  const events = reopened.read()
  assert(
    events.length === 1,
    `应该读出 1 条有效事件，实际 ${events.length}。\n` +
      '      为最后一行坏了就放弃整个会话，等于用一个小故障换一个大故障',
  )
})

await test('★ 坏行要被数出来（corrupt > 0）', () => {
  const p = tmpFile()
  const s = S.fileStore(p)
  s.append({ t: 'task', task: 'x' })
  appendFileSync(p, '{"broken\n', 'utf8')
  const reopened = S.fileStore(p)
  reopened.read()
  assert(
    reopened.corrupt > 0,
    'corrupt 应该 > 0。静默跳过坏行的话，你永远不知道线上崩过多少次',
  )
})

await test('空行不算坏行', () => {
  const p = tmpFile()
  const s = S.fileStore(p)
  s.append({ t: 'task', task: 'x' })
  appendFileSync(p, '\n\n', 'utf8')
  const reopened = S.fileStore(p)
  reopened.read()
  assert(reopened.corrupt === 0, `空行不该算坏行，实际 corrupt=${reopened.corrupt}`)
})

await test('文件不存在时返回空数组而不是抛错', () => {
  const s = S.fileStore(join(TMP, 'never-written.jsonl'))
  assert(s.read().length === 0, '新会话应该是空的')
})

// ─────────────────────────────────────────────────────────────
console.log('\n快照')
// ─────────────────────────────────────────────────────────────

const longLog = (): Event[] => {
  const out: Event[] = []
  let seq = 0
  for (let i = 1; i <= 10; i++) {
    out.push(ev('intent', { step: i, tool: 'read', input: { i }, idem: `k${i}` }, ++seq))
    out.push(ev('outcome', { step: i, idem: `k${i}`, ok: true, content: `c${i}` }, ++seq))
  }
  return out
}

await test('★ 快照记 upto（否则没法和日志拼起来）', () => {
  const events = longLog()
  const snap = S.writeSnapshot(join(TMP, 'a.snapshot.json'), events)
  assert(
    snap.upto === 20,
    `upto 应该是 20，实际 ${snap.upto}。\n` +
      '      没有 upto 你要么重复应用事件，要么漏掉事件，而两者都是静默的',
  )
})

await test('★ 快照用先写 tmp 再 rename（原子写）', () => {
  const p = join(TMP, 'atomic.snapshot.json')
  rmSync(`${p}.tmp`, { force: true })
  S.writeSnapshot(p, longLog())
  // rename 之后 tmp 应该不存在了
  let tmpLeft = true
  try {
    readFileSync(`${p}.tmp`, 'utf8')
  } catch {
    tmpLeft = false
  }
  assert(
    !tmpLeft,
    '写完之后 .tmp 还在，说明没做 rename。\n' +
      '      直接写目标文件的话，崩在中间会留下半截快照——\n' +
      '      而快照坏了比没有快照更糟：你会从一个错误的状态继续跑',
  )
  const snap = JSON.parse(readFileSync(p, 'utf8')) as Snapshot
  assert(snap.upto === 20, '快照内容不对')
})

await test('从快照恢复和从头回放结果一致', () => {
  const events = longLog()
  const snap = S.writeSnapshot(join(TMP, 'b.snapshot.json'), events.slice(0, 10))
  const fromSnap = S.restore(snap, events)
  const fromScratch = S.reduce(events)
  assert(
    fromSnap.completed.size === fromScratch.completed.size,
    `completed 不一致：${fromSnap.completed.size} vs ${fromScratch.completed.size}`,
  )
  assert(fromSnap.steps === fromScratch.steps, `steps 不一致：${fromSnap.steps} vs ${fromScratch.steps}`)
})

await test('restore(null, events) 等价于 reduce(events)', () => {
  const events = longLog()
  const a = S.restore(null, events)
  const b = S.reduce(events)
  assert(a.completed.size === b.completed.size && a.steps === b.steps, '空快照的退化路径不对')
})

await test('★ 快照之后新增的 pending 要能看到', () => {
  const events = longLog()
  const snap = S.writeSnapshot(join(TMP, 'c.snapshot.json'), events)
  events.push(ev('intent', { step: 11, tool: 'send_email', input: {}, idem: 'k11' }, 21))
  const st = S.restore(snap, events)
  assert(
    st.pending.length === 1,
    `pending 应该 1 个，实际 ${st.pending.length}。\n` +
      '      漏掉快照之后的 pending，等于漏掉最需要处理的那一条',
  )
})

await test('快照坏了不影响日志（两个文件必须分开）', () => {
  const p = tmpFile()
  const s = S.fileStore(p)
  s.append({ t: 'task', task: 'x' })
  const snapPath = `${p}.snapshot.json`
  S.writeSnapshot(snapPath, s.read())
  writeFileSync(snapPath, '{坏掉的快照', 'utf8')
  // 日志照样能读
  assert(S.fileStore(p).state().task === 'x', '快照坏掉不该影响日志——日志才是事实来源')
})

// ─────────────────────────────────────────────────────────────
console.log('\n恢复计划')
// ─────────────────────────────────────────────────────────────

const KINDS: Record<string, Replayability> = {
  read_file: 'pure',
  write_file: 'idempotent',
  send_email: 'once',
  git_commit: 'once',
}
const kindOf = (t: string) => KINDS[t] ?? 'once'

await test('已完成的进 skip', () => {
  const st = S.reduce([
    ev('intent', { step: 1, tool: 'read_file', input: {}, idem: 'k1' }, 1),
    ev('outcome', { step: 1, idem: 'k1', ok: true, content: '' }, 2),
  ])
  const plan = S.planResume(st, kindOf)
  assert(plan.skip.length === 1 && plan.skip[0] === 'k1', `skip 不对：${JSON.stringify(plan.skip)}`)
})

await test('pending 里的 pure 工具进 redo', () => {
  const st = S.reduce([ev('intent', { step: 2, tool: 'read_file', input: {}, idem: 'k' }, 1)])
  const plan = S.planResume(st, kindOf)
  assert(plan.redo.length === 1, `redo 应该 1 个，实际 ${plan.redo.length}`)
  assert(plan.ask.length === 0, 'read_file 不需要问人')
})

await test('pending 里的 idempotent 工具也进 redo', () => {
  const st = S.reduce([ev('intent', { step: 2, tool: 'write_file', input: {}, idem: 'k' }, 1)])
  const plan = S.planResume(st, kindOf)
  assert(plan.redo.length === 1 && plan.ask.length === 0, '覆盖写重放没有风险')
})

await test('★ pending 里的 once 工具必须进 ask，不能默认处置', () => {
  const st = S.reduce([
    ev('intent', { step: 2, tool: 'send_email', input: { to: 'a' }, idem: 'k' }, 1),
  ])
  const plan = S.planResume(st, kindOf)
  assert(
    plan.ask.length === 1,
    `ask 应该 1 个，实际 ${plan.ask.length}（redo=${plan.redo.length}）。\n` +
      '      两个默认都会出事：都重做 → 客户收两封邮件；\n' +
      '      都跳过 → 该发的没发而日志显示这一步处理过了',
  )
  assert(plan.redo.length === 0, 'once 工具不该进 redo')
})

await test('pure 和 once 混在一起时各归各位', () => {
  const st = S.reduce([
    ev('intent', { step: 1, tool: 'read_file', input: {}, idem: 'k1' }, 1),
    ev('intent', { step: 2, tool: 'git_commit', input: {}, idem: 'k2' }, 2),
    ev('intent', { step: 3, tool: 'write_file', input: {}, idem: 'k3' }, 3),
  ])
  const plan = S.planResume(st, kindOf)
  assert(plan.redo.length === 2, `redo 应该 2 个，实际 ${plan.redo.length}`)
  assert(plan.ask.length === 1 && plan.ask[0]!.tool === 'git_commit', `ask 不对`)
})

await test('resumeFrom 是最早的 pending 步', () => {
  const st = S.reduce([
    ev('intent', { step: 1, tool: 'read_file', input: {}, idem: 'k1' }, 1),
    ev('outcome', { step: 1, idem: 'k1', ok: true, content: '' }, 2),
    ev('intent', { step: 4, tool: 'read_file', input: {}, idem: 'k4' }, 3),
  ])
  const plan = S.planResume(st, kindOf)
  assert(plan.resumeFrom === 4, `resumeFrom 应该是 4，实际 ${plan.resumeFrom}`)
})

await test('没有 pending 时 resumeFrom 是下一步', () => {
  const st = S.reduce([
    ev('intent', { step: 3, tool: 'read_file', input: {}, idem: 'k' }, 1),
    ev('outcome', { step: 3, idem: 'k', ok: true, content: '' }, 2),
  ])
  const plan = S.planResume(st, kindOf)
  assert(plan.resumeFrom === 4, `resumeFrom 应该是 4，实际 ${plan.resumeFrom}`)
})

await test('describePlan 在需要人工确认时说出来', () => {
  const st = S.reduce([ev('intent', { step: 1, tool: 'send_email', input: {}, idem: 'k' }, 1)])
  const text = S.describePlan(S.planResume(st, kindOf))
  assert(
    /确认|人工|人/.test(text) && text.includes('send_email'),
    `描述里要点出需要确认的工具名，实际：${text}`,
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n记忆：四道闸')
// ─────────────────────────────────────────────────────────────

const DAY = 86_400_000
let clock = Date.UTC(2026, 0, 1)
const now = () => clock
const mem = (o: { minConfidence?: number; maxDepth?: number } = {}) =>
  new M.Memory({ now, ...o })

const f = (o: Partial<Fact> & Pick<Fact, 'key' | 'value'>): FactInput => ({
  kind: 'observed',
  source: 'session-1',
  evidence: '（原话）',
  depth: 0,
  confidence: 0.9,
  ...o,
})

await test('正常的观察能写进去', () => {
  const m = mem()
  const r = m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  assert(r.written, `没写进去：${r.reason}`)
  assert(m.size === 1, `size 应该是 1，实际 ${m.size}`)
})

await test('★ 没有 source 要抛异常', async () => {
  await raises(
    () => mem().remember({ ...f({ key: 'a.b', value: 'x' }), source: '' }),
    '没有出处的事实，发现污染时你没法顺着删掉一整批',
  )
})

await test('★ observed 没有 evidence 要抛异常', async () => {
  await raises(
    () => mem().remember({ ...f({ key: 'a.b', value: 'x' }), evidence: '' }),
    '没有原话的"观察"其实是推导。这道闸把两者强行分开',
  )
})

await test('derived 不强制 evidence（它的证据是被推导的那些 observed）', () => {
  const r = mem().remember({
    ...f({ key: 'a.b', value: 'x', kind: 'derived', depth: 1 }),
    evidence: undefined,
  })
  assert(r.written, `derived 应该允许没有 evidence：${r.reason}`)
})

await test('★ 推导深度超上限就不写（记忆跑偏的主要机制）', () => {
  const r = mem({ maxDepth: 1 }).remember(
    f({ key: 'a.b', value: 'x', kind: 'derived', depth: 2 }),
  )
  assert(
    !r.written,
    'depth=2 应该被拒。从推导结果再推导会复合误差，而结果长得和观察一模一样',
  )
  assert(r.reason !== undefined && r.reason.length > 0, '拒绝要给理由')
})

await test('置信度低于下限就不写', () => {
  const r = mem({ minConfidence: 0.6 }).remember(f({ key: 'a.b', value: 'x', confidence: 0.4 }))
  assert(!r.written, '低置信度应该被拒——宁可再问一次')
})

await test('闸的类型分对：代码 bug 抛异常，数据不足静静返回 false', async () => {
  // source/evidence 缺失 = 调用方写错了代码 → 抛
  await raises(() => mem().remember({ ...f({ key: 'a.b', value: 'x' }), source: '' }), 'source 缺失')
  // depth/confidence 不够 = 数据不够好 → 不抛
  const r = mem().remember(f({ key: 'a.b', value: 'x', confidence: 0.1 }))
  assert(r.written === false, '置信度不足应该返回 false 而不是抛异常')
})

// ─────────────────────────────────────────────────────────────
console.log('\n记忆：冲突')
// ─────────────────────────────────────────────────────────────

await test('★ 同 key 不同值不能静默覆盖', () => {
  const m = mem()
  m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  const r = m.remember(f({ key: 'user.pm', value: 'npm' }))
  assert(
    !r.written && r.conflict !== undefined,
    `应该返回 conflict 而不是覆盖。written=${r.written}\n` +
      '      静默覆盖 → 一次幻觉就能永久改掉一条正确的事实',
  )
  assert(r.conflict!.existing.value === 'pnpm', '冲突里要带旧值')
  assert(r.conflict!.incoming.value === 'npm', '冲突里要带新值')
})

await test('同 key 同值不算冲突', () => {
  const m = mem()
  m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  const r = m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  assert(r.written && !r.conflict, '同值重复写应该直接更新时间戳')
})

await test("resolve='replace' 才真的覆盖", () => {
  const m = mem()
  m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  const r = m.remember(f({ key: 'user.pm', value: 'npm' }), { resolve: 'replace' })
  assert(r.written, `显式 replace 应该写进去：${r.reason}`)
  assert(m.recall(['user.pm'])[0]!.fact.value === 'npm', '值没换')
})

await test("resolve='keep' 保留旧值", () => {
  const m = mem()
  m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  const r = m.remember(f({ key: 'user.pm', value: 'npm' }), { resolve: 'keep' })
  assert(!r.written, 'keep 时不该写')
  assert(m.recall(['user.pm'])[0]!.fact.value === 'pnpm', '旧值被改掉了')
})

await test('★ 推导结果不许覆盖直接观察到的事实', () => {
  const m = mem()
  m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  const r = m.remember(
    { ...f({ key: 'user.pm', value: 'yarn', kind: 'derived', depth: 1 }), evidence: undefined },
    { resolve: 'replace' },
  )
  assert(
    !r.written,
    '就算显式 replace，derived 也不该推翻 observed。要改就拿新的观察来改',
  )
})

await test('observed 可以覆盖 derived（反过来才不行）', () => {
  const m = mem()
  m.remember({ ...f({ key: 'user.pm', value: 'yarn', kind: 'derived', depth: 1 }), evidence: undefined })
  const r = m.remember(f({ key: 'user.pm', value: 'pnpm' }), { resolve: 'replace' })
  assert(r.written, `observed 应该能覆盖 derived：${r.reason}`)
})

await test('★ 值变了 hits 不能继承（旧值被用过不代表新值可靠）', () => {
  const m = mem()
  m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  m.recall(['user.pm'])
  m.recall(['user.pm'])
  m.recall(['user.pm'])
  m.remember(f({ key: 'user.pm', value: 'npm' }), { resolve: 'replace' })
  const hits = m.all().find((x) => x.key === 'user.pm')!.hits
  assert(hits === 0, `hits 应该归零，实际 ${hits}。旧值被用过 3 次不代表新值可靠`)
})

await test('值没变时 hits 保留（同一条事实的使用历史有效）', () => {
  const m = mem()
  m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  m.recall(['user.pm'])
  m.recall(['user.pm'])
  m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  const hits = m.all().find((x) => x.key === 'user.pm')!.hits
  assert(hits === 2, `hits 应该保留为 2，实际 ${hits}`)
})

await test('createdAt 不被更新覆盖，updatedAt 要更新', () => {
  const m = mem()
  m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  const created = m.all()[0]!.createdAt
  clock += DAY
  m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  const after = m.all()[0]!
  assert(after.createdAt === created, 'createdAt 被改了')
  assert(after.updatedAt > created, 'updatedAt 没更新')
})

// ─────────────────────────────────────────────────────────────
console.log('\n记忆：召回与淘汰')
// ─────────────────────────────────────────────────────────────

await test('按 key 精确召回', () => {
  const m = mem()
  m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  m.remember(f({ key: 'user.editor', value: 'vim' }))
  const got = m.recall(['user.pm'])
  assert(got.length === 1 && got[0]!.fact.value === 'pnpm', `实际 ${JSON.stringify(got)}`)
})

await test('前缀召回（user. 拿整个命名空间）', () => {
  const m = mem()
  m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  m.remember(f({ key: 'user.editor', value: 'vim' }))
  m.remember(f({ key: 'project.ci', value: 'gha' }))
  assert(m.recall(['user.']).length === 2, `前缀召回应该 2 条，实际 ${m.recall(['user.']).length}`)
})

await test('不存在的 key 不崩、不返回空条目', () => {
  assert(mem().recall(['nope.nope']).length === 0, '不该返回东西')
})

await test('★ 过期的事实要返回并标 stale（不是藏起来）', () => {
  const m = mem()
  m.remember(f({ key: 'p.node', value: '20', ttlMs: 30 * DAY }))
  clock += 60 * DAY
  const got = m.recall(['p.node'])
  assert(
    got.length === 1,
    '过期的也要返回。藏起来的话模型不知道自己曾经知道过什么，只会重新问一遍',
  )
  assert(got[0]!.stale, 'stale 应该是 true')
})

await test('没有 ttl 的事实永不 stale', () => {
  const m = mem()
  m.remember(f({ key: 'u.name', value: '张三' }))
  clock += 3650 * DAY
  assert(!m.recall(['u.name'])[0]!.stale, '没有 ttl 就不该判过期')
})

await test('★ 召回顺序：observed 在前，同类按置信度降序', () => {
  const m = mem()
  m.remember({ ...f({ key: 'a.d', value: 'x', kind: 'derived', depth: 1, confidence: 0.99 }), evidence: undefined })
  m.remember(f({ key: 'b.o1', value: 'y', confidence: 0.7 }))
  m.remember(f({ key: 'c.o2', value: 'z', confidence: 0.95 }))
  const keys = m.recall().map((i) => i.fact.key)
  assert(
    keys[0] === 'c.o2' && keys[1] === 'b.o1' && keys[2] === 'a.d',
    `顺序不对：${keys.join(',')}。顺序影响模型的注意力分配（L05x），不是随便排的`,
  )
})

await test('recall 会累加 hits', () => {
  const m = mem()
  m.remember(f({ key: 'a.b', value: 'x' }))
  m.recall(['a.b'])
  m.recall(['a.b'])
  assert(m.all()[0]!.hits === 2, `hits 应该是 2，实际 ${m.all()[0]!.hits}`)
})

await test('前缀和精确 key 都命中同一条时不重复返回', () => {
  const m = mem()
  m.remember(f({ key: 'user.pm', value: 'pnpm' }))
  assert(m.recall(['user.', 'user.pm']).length === 1, '同一条被返回了两次')
})

await test('forget 按谓词批量删（发现污染后按 source 删）', () => {
  const m = mem()
  m.remember(f({ key: 'a.1', value: 'x', source: 'bad-session' }))
  m.remember(f({ key: 'a.2', value: 'y', source: 'bad-session' }))
  m.remember(f({ key: 'a.3', value: 'z', source: 'good' }))
  const n = m.forget((x) => x.source === 'bad-session')
  assert(n === 2, `应该删 2 条，实际 ${n}`)
  assert(m.size === 1, `剩 1 条，实际 ${m.size}`)
})

await test('★ 淘汰时过期的先走', () => {
  const m = mem()
  m.remember(f({ key: 'a.fresh', value: 'x' }))
  m.remember(f({ key: 'b.expired', value: 'y', ttlMs: DAY }))
  clock += 10 * DAY
  const dropped = m.evict(1)
  assert(
    dropped.length === 1 && dropped[0]!.key === 'b.expired',
    `应该先淘汰过期的，实际淘汰了 ${dropped.map((x) => x.key).join(',')}`,
  )
})

await test('★ 淘汰时从没被召回过的比常用的先走', () => {
  const m = mem()
  m.remember(f({ key: 'a.used', value: 'x' }))
  m.remember(f({ key: 'b.unused', value: 'y' }))
  for (let i = 0; i < 5; i++) m.recall(['a.used'])
  const dropped = m.evict(1)
  assert(
    dropped[0]!.key === 'b.unused',
    `应该淘汰没用过的，实际 ${dropped[0]!.key}。\n` +
      '      使用频率是"这条还有用"的最好代理指标——它是观察到的，\n' +
      '      而置信度是模型自己报的',
  )
})

await test('没超限时不淘汰', () => {
  const m = mem()
  m.remember(f({ key: 'a.b', value: 'x' }))
  assert(m.evict(5).length === 0, '没超限就不该动')
})

// ─────────────────────────────────────────────────────────────
console.log('\n记忆：渲染与解析')
// ─────────────────────────────────────────────────────────────

await test('空记忆渲染成空字符串（不占 token）', () => {
  assert(
    M.renderMemory([]) === '',
    '空记忆应该渲染成空串，不要输出一个空的 <memory></memory>——那会白占 token',
  )
})

await test('★ 渲染必须带出处', () => {
  const m = mem()
  m.remember(f({ key: 'user.pm', value: 'pnpm', source: 'session-42', evidence: '我用 pnpm' }))
  const text = M.renderMemory(m.recall())
  assert(
    text.includes('session-42'),
    `渲染里没有出处：\n${text}\n      模型会把你给它的一切当成事实，带上出处它才有机会质疑`,
  )
})

await test('★ 渲染必须区分 observed 和 derived', () => {
  const m = mem()
  m.remember(f({ key: 'a.o', value: 'x' }))
  m.remember({ ...f({ key: 'b.d', value: 'y', kind: 'derived', depth: 1 }), evidence: undefined })
  const text = M.renderMemory(m.recall())
  assert(
    text.includes('observed') && text.includes('derived'),
    `渲染里要分区块：\n${text}\n      不分的话，一条三个月前推导出来的判断会被当成铁律`,
  )
})

await test('stale 要在渲染里标出来', () => {
  const m = mem()
  m.remember(f({ key: 'p.node', value: '20', ttlMs: DAY }))
  clock += 10 * DAY
  const text = M.renderMemory(m.recall())
  assert(/过期|stale/i.test(text), `stale 没标出来：\n${text}`)
})

await test('解析：合格的行收下', () => {
  const { facts } = M.parseExtraction('user.pm | pnpm | observed | 0.95 | 我们用 pnpm')
  assert(facts.length === 1, `应该收 1 条，实际 ${facts.length}`)
  assert(facts[0]!.key === 'user.pm' && facts[0]!.confidence === 0.95, `解析错了：${JSON.stringify(facts[0])}`)
})

await test('★ kind 写错的行跳过，不能默认成 observed', () => {
  const { facts, skipped } = M.parseExtraction('user.pm | pnpm | maybe | 0.9 | 原话')
  assert(
    facts.length === 0 && skipped.length === 1,
    `应该跳过，实际收了 ${facts.length} 条。\n` +
      '      默认成 observed 的后果：一条推测被当成事实永久存下来',
  )
})

await test('★ key 里没有点号的跳过（强制命名空间）', () => {
  const { facts, skipped } = M.parseExtraction('pm | pnpm | observed | 0.9 | 原话')
  assert(
    facts.length === 0 && skipped.length === 1,
    '不强制命名空间的话，三个月后你会有 pm、packageManager、package_manager 三条互相矛盾的事实',
  )
})

await test('置信度不是数字的跳过', () => {
  const { facts } = M.parseExtraction('user.pm | pnpm | observed | 高 | 原话')
  assert(facts.length === 0, '非数字置信度应该跳过')
})

await test('置信度超出 0-1 的跳过', () => {
  const { facts } = M.parseExtraction('user.pm | pnpm | observed | 95 | 原话')
  assert(facts.length === 0, '95 不是 0-1 的置信度，应该跳过（不要当成 0.95 猜）')
})

await test('字段不足的跳过', () => {
  const { facts, skipped } = M.parseExtraction('user.pm | pnpm')
  assert(facts.length === 0 && skipped.length === 1, '字段不足应该跳过而不是猜')
})

await test('NONE 和空行不算坏行', () => {
  const { facts, skipped } = M.parseExtraction('NONE\n\n   \n')
  assert(facts.length === 0 && skipped.length === 0, `NONE 不该算坏行，实际 skipped=${skipped.length}`)
})

await test('剥掉模型爱加的列表符号', () => {
  const { facts } = M.parseExtraction('- user.pm | pnpm | observed | 0.9 | 原话')
  assert(facts.length === 1 && facts[0]!.key === 'user.pm', `实际 ${JSON.stringify(facts)}`)
})

await test('原话为空时 evidence 是 undefined 而不是空串', () => {
  const { facts } = M.parseExtraction('user.s | x | derived | 0.7 |')
  assert(facts.length === 1, `应该收下（derived 不强制原话），实际 ${facts.length}`)
  assert(facts[0]!.evidence === undefined, `evidence 应该是 undefined，实际 ${JSON.stringify(facts[0]!.evidence)}`)
})

await test('★ 检测同一次抽取里的自相矛盾', () => {
  const { facts } = M.parseExtraction(
    'user.pm | pnpm | observed | 0.9 | 用 pnpm\nuser.pm | npm | observed | 0.8 | 算了改用 npm',
  )
  const c = M.findContradictions(facts)
  assert(
    c.length === 1 && c[0]!.key === 'user.pm',
    `应该检测出 user.pm 矛盾，实际 ${JSON.stringify(c)}。\n` +
      '      写入前检测比写入后靠冲突解决便宜得多',
  )
  assert(c[0]!.values.length === 2, `应该列出两个值，实际 ${JSON.stringify(c[0]!.values)}`)
})

await test('同 key 同值不算矛盾', () => {
  const { facts } = M.parseExtraction(
    'user.pm | pnpm | observed | 0.9 | 用 pnpm\nuser.pm | pnpm | observed | 0.8 | 又提了一次',
  )
  assert(M.findContradictions(facts).length === 0, '同值不算矛盾')
})

// ─────────────────────────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true })

console.log('\n' + '─'.repeat(60))
if (failures.length === 0) {
  console.log(`\x1b[32m${passed} 项全过。\x1b[0m`)
  console.log('\n接着跑 pnpm resume，把这两块接到 agent 上然后中途杀掉它。')
} else {
  console.log(`\x1b[31m${passed} 过，${failures.length} 败：\x1b[0m`)
  for (const f of failures) console.log(`\x1b[31m  · ${f}\x1b[0m`)
  process.exitCode = 1
}
