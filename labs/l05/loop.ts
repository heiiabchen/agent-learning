/**
 * L05 · 任务一：写你自己的 agent loop。
 *
 * 跑法：pnpm loop（用假模型跑一遍）    验证：pnpm verify:l05
 *
 * `shared/agent.ts` 里有我的实现。**先别看。**
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 核心逻辑真的只有十行：
 *
 *     while (true) {
 *       const res = await call(messages)
 *       messages.push({ role: 'assistant', content: res.content })
 *       if (res.stop_reason !== 'tool_use') return res
 *       const uses = toolUsesOf(res.content)
 *       const results = await Promise.all(uses.map(u => toolbox.execute(u.name, u.input)))
 *       messages.push(toolResultMessage(uses, results))
 *     }
 *
 * 你要写的是围绕它的那圈防线。verify 里有 20 多条测试，
 * 每一条对应一种真实的失控方式。
 * ───────────────────────────────────────────────────────────────────────────
 */
import type Anthropic from '@anthropic-ai/sdk'
import { Ledger, type Totals } from '../shared/ledger.ts'
import type { ToolBox } from '../shared/tools.ts'

export type StopReason = 'done' | 'step_limit' | 'budget' | 'timeout' | 'cancelled' | 'repeat' | 'error'

export interface TraceEntry {
  step: number
  toolName: string
  input: unknown
  ok: boolean
  preview: string
  ms: number
}

export interface AgentRun {
  text: string
  reason: StopReason
  steps: number
  usage: Totals
  transcript: Anthropic.MessageParam[]
  trace: TraceEntry[]
  error?: Error
}

export interface AgentOptions {
  toolbox: ToolBox
  system: string
  /** 抽象成函数，这样 verify 能塞一个假模型进来。真模型和假模型同形。 */
  call: (messages: Anthropic.MessageParam[], signal?: AbortSignal) => Promise<Anthropic.Message>
  maxSteps?: number
  maxYuan?: number
  maxMs?: number
  signal?: AbortSignal
  ledger?: Ledger
  repeatLimit?: number
  onStep?: (e: TraceEntry) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 1 · repeatKey(name, input)
//
//   重复调用检测用的 key。
//
//   ★ 不能直接 JSON.stringify(input)。
//     对象字段顺序变了 key 就变了，于是防线静默失效——
//     这是那种「写完觉得搞定了，三个月后发现一直没生效」的 bug。
//     要递归地按 key 排序之后再序列化。
//
//   顺便处理掉 undefined 值（JSON.stringify 会把它们丢掉，
//   于是 {a:1, b:undefined} 和 {a:1} 应该是同一个 key）。
// ─────────────────────────────────────────────────────────────────────────────

export function repeatKey(name: string, input: unknown): string {
  void name
  void input
  throw new Error('TODO 1 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 2 · runAgent(task, opts)
//
//   ── 五个终止条件，全部在**循环顶部**检查 ────────────────────────────
//
//     steps >= maxSteps                 → 'step_limit'
//     ledger.totals().yuan > maxYuan    → 'budget'
//     Date.now() - t0 > maxMs           → 'timeout'
//     signal?.aborted                   → 'cancelled'
//     模型给出最终答案                    → 'done'
//
//   放顶部而不是散在各处，是为了让「什么情况下会停」在一处读完。
//
//   ── 必须做对的几个点 ───────────────────────────────────────────────
//
//   ★ 1. assistant 那条**原样**放回历史，包含 tool_use 块。
//         丢掉的话模型下一轮看不到自己要求过什么，会重新要求 → 死循环。
//
//   ★ 2. 用 Promise.all 并发执行工具，它**保序**（按输入顺序，不是完成顺序）。
//         顺序抖动 → 前缀缓存失效 + 问题无法复现。
//
//   ★ 3. 所有 tool_result 放在**同一条** user 消息里。
//
//   ★ 4. 取消要和真故障分开。
//         call 抛 AbortError 时返回 'cancelled'，不是 'error'。
//         混在一起的后果：用户点了停止，日志里记一条 error，你以为线上有 bug。
//
//   ★ 5. stop_reason === 'max_tokens' 不能当成 'done'。
//         那种「答案」是残缺的。L02 那条纪律：半截内容绝不能静默当成完整的。
//
//   ★ 6. stop_reason 说 tool_use 但没有 tool_use 块 → 要能停下。
//         协议上不该发生，但真发生了不停的话下一轮完全一样 → 死循环。
//
//   ── 重复检测 ──────────────────────────────────────────────────────
//
//   同参数调用超过 repeatLimit（默认 2）次时：
//     · **返回给模型**一条 isError 结果，不要静默跳过
//       （静默跳过等于给它空结果，它会更困惑）
//     · 内容里要有出路：「换个思路，或者说明你卡在哪」
//     · 如果这一轮**全部**调用都被判成重复，直接返回 'repeat'，
//       没必要再烧满剩下的步数
//
//   ── 返回值 ────────────────────────────────────────────────────────
//
//   reason 是整个返回值里最重要的字段。想清楚为什么：
//   只返回 text 的话，撞上步数上限时模型最后那句话往往**看起来像个答案**，
//   调用方会拿去用，用户会拿去信。
// ─────────────────────────────────────────────────────────────────────────────

export async function runAgent(task: string, opts: AgentOptions): Promise<AgentRun> {
  void task
  void opts
  void Ledger
  throw new Error('TODO 2 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 3 · 用假模型跑一遍，看清每一步
//
//   `shared/fake.ts` 里有一个脚本化的假模型。用它跑三个场景：
//
//     a) 正常：要一次工具 → 给最终答案
//     b) 死循环：afterScript: 'repeat_last'，看你的重复检测和步数上限
//     c) 取消：delayMs: 500，起一个 500ms 后 abort 的 signal
//
//   每个场景打印出 reason / steps / usage / trace。
//
//   然后回答：
//     a) 场景 b 里，是重复检测先响还是步数上限先响？哪个更早发现问题？
//     b) 场景 c 里，已经花掉的钱有没有出现在返回的 usage 里？
//        （如果没有，你丢掉了成本信息——取消不该让账目消失）
// ─────────────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  throw new Error('把 TODO 3 写完，然后删掉这一行')
}

if (import.meta.filename === process.argv[1]) {
  await main()
}
