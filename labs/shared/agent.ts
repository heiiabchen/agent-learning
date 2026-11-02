/**
 * Agent loop。整门课的核心交付物。
 *
 * 核心逻辑十行（见下面 while 里面那段），其余全是**防止失控**的代码。
 * 这个比例本身就是这一节的主要结论。
 */
import type Anthropic from '@anthropic-ai/sdk'
import { Ledger, type Totals } from './ledger.ts'
import { textOf } from './message.ts'
import { toolResultMessage, toolUsesOf, type ToolBox, type ToolResult } from './tools.ts'

export type StopReason = 'done' | 'step_limit' | 'budget' | 'timeout' | 'cancelled' | 'repeat' | 'error'

export interface AgentRun {
  text: string
  /**
   * ★ 为什么停。这个字段是整个返回值里最重要的。
   *
   * 只返回 text 的话，「答完了」和「被掐了」看起来完全一样——
   * 撞上步数上限时模型最后那句话往往像个答案，调用方会拿去用。
   * L12 做 evals 时 reason 的分布是最先看的指标：
   * 如果 20% 的运行是 step_limit，成功率数字全是假的。
   */
  reason: StopReason
  steps: number
  usage: Totals
  transcript: Anthropic.MessageParam[]
  /** 每一步的工具调用记录，给 L13 的调试和 L12 的评估用。 */
  trace: TraceEntry[]
  error?: Error
}

export interface TraceEntry {
  step: number
  toolName: string
  input: unknown
  ok: boolean
  /** 只留摘要，全文在 transcript 里。trace 是给人扫的。 */
  preview: string
  ms: number
}

export interface AgentOptions {
  toolbox: ToolBox
  system: string
  /** 抽象成函数，是为了让 verify 能塞一个假模型进来。 */
  call: (messages: Anthropic.MessageParam[], signal?: AbortSignal) => Promise<Anthropic.Message>
  maxSteps?: number
  maxYuan?: number
  maxMs?: number
  signal?: AbortSignal
  ledger?: Ledger
  /** 同参数重复调用多少次后拦下。默认 2（重试一次是合理的，第三次不是）。 */
  repeatLimit?: number
  onStep?: (e: TraceEntry) => void
}

/** trace 里的预览长度。够看出发生了什么，又不至于把日志刷爆。 */
const PREVIEW = 120

export async function runAgent(task: string, opts: AgentOptions): Promise<AgentRun> {
  const {
    toolbox,
    system,
    call,
    maxSteps = 20,
    maxYuan = 1,
    maxMs = 120_000,
    signal,
    ledger = new Ledger('agent'),
    repeatLimit = 2,
    onStep,
  } = opts

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task }]
  const trace: TraceEntry[] = []
  const seen = new Map<string, number>()
  const t0 = Date.now()
  let steps = 0
  let lastText = ''

  const finish = (reason: StopReason, error?: Error): AgentRun => ({
    text: lastText,
    reason,
    steps,
    usage: ledger.totals(),
    transcript: messages,
    trace,
    error,
  })

  for (;;) {
    // ── 五个终止条件，全部在循环顶部检查 ──────────────────────────────
    // 放顶部而不是散在各处，是为了让「什么情况下会停」在一处读完。
    if (steps >= maxSteps) return finish('step_limit')
    if (ledger.totals().yuan > maxYuan) return finish('budget')
    if (Date.now() - t0 > maxMs) return finish('timeout')
    if (signal?.aborted) return finish('cancelled')

    steps++

    let res: Anthropic.Message
    const started = performance.now()
    try {
      res = await call(messages, signal)
    } catch (err) {
      // 取消在这里会以异常形式出现（AbortError），要和真故障分开。
      // 混在一起的后果：用户点了停止，日志里记一条 error，你以为线上有 bug。
      if (signal?.aborted || (err as Error).name === 'AbortError') return finish('cancelled')
      return finish('error', err as Error)
    }

    ledger.record({
      label: `step ${steps}`,
      id: res.id,
      model: res.model,
      usage: res.usage,
      ms: performance.now() - started,
    })

    // assistant 那条必须**原样**放回去，包含 tool_use 块。
    // 丢掉工具调用块的话，模型下一轮看不到自己要求过什么，会重新要求 → 死循环。
    messages.push({ role: 'assistant', content: res.content })

    const text = textOf(res.content)
    if (text) lastText = text

    if (res.stop_reason !== 'tool_use') {
      // 这是唯一的正常出口。但 max_tokens 截断也会走到这里，
      // 而那种「答案」是残缺的——不能当成 done。
      if (res.stop_reason === 'max_tokens') {
        return finish('error', new Error('输出被 max_tokens 截断，答案不完整'))
      }
      return finish('done')
    }

    const uses = toolUsesOf(res.content)
    if (uses.length === 0) {
      // stop_reason 说要用工具但一个 tool_use 块都没有。
      // 协议上不该发生，但真发生了要能停下，否则下一轮完全一样 → 死循环。
      return finish('error', new Error("stop_reason 是 tool_use 但 content 里没有 tool_use 块"))
    }

    // 并发执行，但用 Promise.all 保序——返回数组按**输入顺序**，不是完成顺序。
    // 顺序抖动的后果：前缀缓存失效 + 问题无法复现（L04 第四节）。
    const results = await Promise.all(
      uses.map(async (u): Promise<ToolResult> => {
        const key = repeatKey(u.name, u.input)
        const n = (seen.get(key) ?? 0) + 1
        seen.set(key, n)

        if (n > repeatLimit) {
          // 不静默跳过——那样模型不知道发生了什么，只会更困惑。
          // 要让它知道自己在打转，并给一条出路。
          return {
            isError: true,
            content:
              `你已经用完全相同的参数调用了 ${u.name} ${n} 次，结果不会变。` +
              `换个思路，或者说明你卡在哪、需要什么才能继续。`,
            logNote: `重复调用 ${u.name} 第 ${n} 次`,
          }
        }

        const at = performance.now()
        const r = await toolbox.execute(u.name, u.input)
        const entry: TraceEntry = {
          step: steps,
          toolName: u.name,
          input: u.input,
          ok: !r.isError,
          preview: r.content.slice(0, PREVIEW).replace(/\n/g, '␤'),
          ms: performance.now() - at,
        }
        trace.push(entry)
        onStep?.(entry)
        return r
      }),
    )

    // 所有结果放在**同一条** user 消息里。分成多条会造成连续两条 user。
    messages.push(toolResultMessage(uses, results))

    // 重复检测的补充判据：这一轮全部工具调用都被判成重复，说明它彻底卡住了，
    // 没必要再烧满剩下的步数。
    if (results.every((r) => r.logNote?.startsWith('重复调用'))) {
      return finish('repeat')
    }
  }
}

/**
 * 重复检测的 key。
 *
 * ★ 不能直接 JSON.stringify(input)：对象字段顺序变了 key 就变了，防线静默失效。
 * 这正是那种「写完觉得搞定了，三个月后发现一直没生效」的 bug。
 * 所以这里递归地按 key 排序之后再序列化。
 */
export function repeatKey(name: string, input: unknown): string {
  return `${name}:${stableStringify(input)}`
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`
}

/** 给终止原因配一句人话，日志和 UI 都要用。 */
export const reasonText: Record<StopReason, string> = {
  done: '正常完成',
  step_limit: '撞上步数上限（可能是死循环，去看 trace 里有没有重复的调用）',
  budget: '超出成本预算',
  timeout: '超时',
  cancelled: '被取消',
  repeat: '检测到重复调用，agent 卡住了',
  error: '出错',
}
