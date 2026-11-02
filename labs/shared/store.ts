/**
 * 参考实现：会话持久化与断点恢复。
 *
 * 这个文件要打掉一个几乎所有人第一次都会犯的错：**把 transcript 存下来当持久化。**
 *
 * transcript 是**历史**，不是**状态**。区别在三处：
 *
 *   一 · 历史单调增长，状态不。存历史等于把 L06 那个上下文爆炸问题搬到磁盘上
 *   二 · 历史不可查询。「这个 agent 现在卡在哪」要靠人读一遍才知道
 *   三 · **重放历史不幂等。** 这是最要命的一条，见下面 pendingOf 那一段
 *
 * 所以这里存的是**事件日志**（append-only JSONL）加**派生状态**：
 * 日志是事实，状态是从日志算出来的。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ─────────────────────────────────────────────────────────────
// 事件
// ─────────────────────────────────────────────────────────────

/**
 * ★ intent 和 outcome 是分开的两条事件，这是整个设计的核心。
 *
 * 合成一条的话（「第 3 步调用了 write_file 并成功了」），崩溃恢复就无解了：
 * 你看不到「打算做但不知道做没做」这个状态，而那恰恰是崩溃后最常见的状态。
 */
export type Event =
  | { seq: number; at: number; t: 'task'; task: string }
  /** 打算调用某个工具。**在真正执行之前**写。 */
  | { seq: number; at: number; t: 'intent'; step: number; tool: string; input: unknown; idem: string }
  /** 调用的结果。执行之后写。 */
  | { seq: number; at: number; t: 'outcome'; step: number; idem: string; ok: boolean; content: string }
  | { seq: number; at: number; t: 'text'; text: string }
  | { seq: number; at: number; t: 'done'; reason: string }

export type EventInput =
  | { t: 'task'; task: string }
  | { t: 'intent'; step: number; tool: string; input: unknown; idem: string }
  | { t: 'outcome'; step: number; idem: string; ok: boolean; content: string }
  | { t: 'text'; text: string }
  | { t: 'done'; reason: string }

/**
 * 幂等键：同一个「工具 + 参数」在同一个会话里算同一次操作。
 *
 * ★ 必须按 key 排序后序列化，理由和 L05 的 repeatKey 完全一样：
 * 对象字段顺序变了 key 就变了，防线静默失效。
 */
export function idemKey(sessionId: string, tool: string, input: unknown): string {
  return createHash('sha256')
    .update(`${sessionId}\u0000${tool}\u0000${stableStringify(input)}`)
    .digest('hex')
    .slice(0, 16)
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`
}

// ─────────────────────────────────────────────────────────────
// 派生状态
// ─────────────────────────────────────────────────────────────

export interface SessionState {
  task: string | null
  /** 已经完成的步数（有 outcome 的）。 */
  steps: number
  /** idem → 结果。恢复时用来跳过已经做过的操作。 */
  completed: Map<string, { ok: boolean; content: string }>
  /**
   * ★ 有 intent 但没有 outcome 的那些。
   *
   * 这是崩溃恢复的全部难点所在：这些操作**可能做了也可能没做**。
   * 日志停在 intent 说明进程死在「写完意图」和「写完结果」之间——
   * 而副作用（写文件、发请求）就发生在那个窗口里。
   */
  pending: { step: number; tool: string; input: unknown; idem: string }[]
  lastText: string
  finished: boolean
  reason: string | null
}

export function reduce(events: Event[]): SessionState {
  const st: SessionState = {
    task: null,
    steps: 0,
    completed: new Map(),
    pending: [],
    lastText: '',
    finished: false,
    reason: null,
  }
  const open = new Map<string, { step: number; tool: string; input: unknown; idem: string }>()

  for (const e of events) {
    switch (e.t) {
      case 'task':
        st.task = e.task
        break
      case 'intent':
        open.set(e.idem, { step: e.step, tool: e.tool, input: e.input, idem: e.idem })
        break
      case 'outcome':
        open.delete(e.idem)
        st.completed.set(e.idem, { ok: e.ok, content: e.content })
        st.steps = Math.max(st.steps, e.step)
        break
      case 'text':
        st.lastText = e.text
        break
      case 'done':
        st.finished = true
        st.reason = e.reason
        break
    }
  }

  st.pending = [...open.values()].sort((a, b) => a.step - b.step)
  return st
}

// ─────────────────────────────────────────────────────────────
// 存储
// ─────────────────────────────────────────────────────────────

export interface Store {
  append(e: EventInput): Event
  read(): Event[]
  state(): SessionState
  /** 坏行的数量。> 0 说明发生过崩溃或者磁盘满，值得报一声。 */
  readonly corrupt: number
}

/**
 * JSONL 会话日志。
 *
 * ★ 为什么是 JSONL 而不是一个 JSON 数组：
 *
 *   一 · **追加是 O(1)。** JSON 数组每次都要读全文、改、写回全文
 *   二 · **崩溃只损坏最后一行。** 数组格式崩溃后整个文件都不是合法 JSON
 *   三 · **能 tail -f。** 排查线上问题的时候这一条比前两条都实用
 *
 * 单行的原子性由 O_APPEND 保证（小于 PIPE_BUF 的追加写不会交错），
 * 但这只在单机上成立——NFS 和多容器共享卷上不成立，那时候需要真正的数据库。
 */
export function fileStore(path: string): Store {
  mkdirSync(dirname(path), { recursive: true })
  let corrupt = 0

  const read = (): Event[] => {
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf8')
    const out: Event[] = []
    corrupt = 0
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as Event)
      } catch {
        // ★ 容忍坏行而不是整个读取失败。
        //
        // 崩溃时最后一行常常是写了一半的。为这一行放弃整个会话，
        // 等于用一个小故障换一个大故障。
        //
        // 但**要数出来**——静默跳过就没人知道发生过崩溃了。
        corrupt++
      }
    }
    return out
  }

  let seq = read().reduce((m, e) => Math.max(m, e.seq), 0)

  return {
    append(input) {
      const e = { ...input, seq: ++seq, at: Date.now() } as Event
      appendFileSync(path, JSON.stringify(e) + '\n', 'utf8')
      return e
    },
    read,
    state: () => reduce(read()),
    get corrupt() {
      return corrupt
    },
  }
}

/** 内存版。测试用，也用来演示「存储换掉但语义不变」。 */
export function memoryStore(): Store {
  const events: Event[] = []
  let seq = 0
  return {
    append(input) {
      const e = { ...input, seq: ++seq, at: Date.now() } as Event
      events.push(e)
      return e
    },
    read: () => [...events],
    state: () => reduce(events),
    corrupt: 0,
  }
}

// ─────────────────────────────────────────────────────────────
// 快照
// ─────────────────────────────────────────────────────────────

export interface Snapshot {
  /** 快照覆盖到哪一条事件。**没有这个字段的快照是不能用的**，见下。 */
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

/**
 * 存快照。
 *
 * ★ 快照必须记 upto（覆盖到第几条事件），否则你没法把它和日志拼起来——
 * 要么重复应用事件，要么漏掉事件，而两者都是静默的。
 *
 * ★ 写快照必须**先写临时文件再 rename**。
 *
 * rename 在同一个文件系统内是原子的，所以读者永远看到完整的旧版或完整的新版。
 * 直接写目标文件的话，崩在中间会留下一个半截快照——
 * 而快照坏了比没有快照更糟：你会从一个错误的状态继续跑。
 */
export function writeSnapshot(path: string, events: Event[]): Snapshot {
  const st = reduce(events)
  const snap: Snapshot = {
    upto: events.reduce((m, e) => Math.max(m, e.seq), 0),
    state: {
      task: st.task,
      steps: st.steps,
      completed: [...st.completed.entries()],
      lastText: st.lastText,
      finished: st.finished,
      reason: st.reason,
    },
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(snap), 'utf8')
  renameSync(tmp, path)
  return snap
}

/** 从快照 + 快照之后的事件恢复状态。快照只是加速，日志才是事实来源。 */
export function restore(snap: Snapshot | null, events: Event[]): SessionState {
  if (!snap) return reduce(events)
  const tail = events.filter((e) => e.seq > snap.upto)
  const base = reduce(tail)

  // 快照里的 completed 要先铺上，再让 tail 的事件覆盖。
  const completed = new Map(snap.state.completed)
  for (const [k, v] of base.completed) completed.set(k, v)

  return {
    task: base.task ?? snap.state.task,
    steps: Math.max(snap.state.steps, base.steps),
    completed,
    pending: base.pending,
    lastText: base.lastText || snap.state.lastText,
    finished: base.finished || snap.state.finished,
    reason: base.reason ?? snap.state.reason,
  }
}

// ─────────────────────────────────────────────────────────────
// 恢复决策
// ─────────────────────────────────────────────────────────────

/**
 * 工具的可重放性。这个分类是恢复逻辑的全部依据。
 *
 *   'pure'        —— 没有副作用，随便重放。read_file / search
 *   'idempotent'  —— 有副作用但重复执行结果相同。write_file（覆盖写）
 *   'once'        —— 重复执行会出事。send_email / create_order / git_commit
 */
export type Replayability = 'pure' | 'idempotent' | 'once'

export interface ResumePlan {
  /** 可以直接跳过的（已有 outcome）。 */
  skip: string[]
  /** 需要重新执行的。 */
  redo: { step: number; tool: string; input: unknown; idem: string }[]
  /**
   * ★ 必须交给人的。
   *
   * pending 里那些 'once' 类型的工具：可能做了也可能没做，而重做会出事。
   * **代码在这里没有正确答案，唯一诚实的做法是停下来问。**
   */
  ask: { step: number; tool: string; input: unknown; idem: string }[]
  resumeFrom: number
}

export function planResume(
  st: SessionState,
  replayability: (tool: string) => Replayability,
): ResumePlan {
  const redo: ResumePlan['redo'] = []
  const ask: ResumePlan['ask'] = []

  for (const p of st.pending) {
    if (replayability(p.tool) === 'once') ask.push(p)
    else redo.push(p)
  }

  return {
    skip: [...st.completed.keys()],
    redo,
    ask,
    // 从最早的未完成步继续。没有 pending 就从已完成的下一步开始。
    resumeFrom: st.pending.length > 0 ? Math.min(...st.pending.map((p) => p.step)) : st.steps + 1,
  }
}

/** 给日志和 UI 用的一句人话。 */
export function describePlan(plan: ResumePlan): string {
  const parts = [`跳过 ${plan.skip.length} 个已完成操作`, `从第 ${plan.resumeFrom} 步继续`]
  if (plan.redo.length > 0) parts.push(`重放 ${plan.redo.length} 个可重放操作`)
  if (plan.ask.length > 0) {
    parts.push(
      `\u001b[33m${plan.ask.length} 个操作需要人工确认：` +
        plan.ask.map((a) => `${a.tool}(第 ${a.step} 步)`).join('、') +
        '\u001b[0m',
    )
  }
  return parts.join('，')
}

export const sessionPath = (dir: string, id: string) => join(dir, `${id}.jsonl`)
export const snapshotPath = (dir: string, id: string) => join(dir, `${id}.snapshot.json`)
