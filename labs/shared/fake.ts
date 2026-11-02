/**
 * 脚本化的假模型。
 *
 * 这个文件本身是一个教学点：**测 agent loop 不能用真模型。**
 *
 * 真模型不确定、慢、花钱，而且——最关键的——**你没法让它按你想要的方式失败**。
 * 你想验证「连续三次同样的工具调用会被拦住」，真模型不会配合你演这一出。
 * 假模型会。
 *
 * L12 做 evals 时这个思路会大量用到。判据很简单：
 * **能用假模型测的东西，就不要用真模型测。**
 */
import type Anthropic from '@anthropic-ai/sdk'

export interface FakeTurn {
  /** 这一轮要的工具调用。空数组表示直接给最终答案。 */
  toolUses?: { name: string; input: unknown }[]
  text?: string
  /** 覆盖 stop_reason，用来测异常分支（比如 max_tokens 截断）。 */
  stopReason?: Anthropic.Message['stop_reason']
  usage?: { input: number; output: number }
}

export interface FakeModelOptions {
  /** 按顺序回放。用完之后的行为由 afterScript 决定。 */
  script: FakeTurn[]
  /**
   * 脚本用完之后：
   *   'repeat_last' —— 无限重复最后一轮（用来测步数上限 / 死循环防线）
   *   'final'       —— 给一个最终答案
   *   'throw'       —— 抛错（用来测你有没有漏 try）
   */
  afterScript?: 'repeat_last' | 'final' | 'throw'
  /** 每次调用前的延迟毫秒，用来测超时与取消。 */
  delayMs?: number
  /**
   * 假模型自称的模型名。默认是一个**真实存在于 PRICING 里**的名字。
   *
   * 这不是随便选的：Ledger 在遇到不认识的模型时会抛错，而不是按 0 计价
   * （L02 那条纪律——「没测到」和「是 0」是两个不同的结论）。
   * 所以假模型不能叫 'fake-model'，否则一算账就炸。
   *
   * 顺带的好处是预算测试用的是真实单价，算出来的钱有意义。
   */
  model?: string
}

let counter = 0

function makeMessage(turn: FakeTurn, model: string): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = []
  if (turn.text) content.push({ type: 'text', text: turn.text, citations: null })
  for (const tu of turn.toolUses ?? []) {
    // as 断言：SDK 的 ToolUseBlock 带了几个我们这里不关心的字段（caller 之类）。
    // 假模型只需要 loop 会读的那几个。
    content.push({
      type: 'tool_use',
      id: `toolu_fake_${++counter}`,
      name: tu.name,
      input: tu.input,
    } as Anthropic.ToolUseBlock)
  }
  const hasTools = (turn.toolUses ?? []).length > 0

  return {
    id: `msg_fake_${counter}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: turn.stopReason ?? (hasTools ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: turn.usage?.input ?? 100,
      output_tokens: turn.usage?.output ?? 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as Anthropic.Message
}

export interface FakeModel {
  /** 和真 client.messages.create 同形的调用点。 */
  call: (messages: Anthropic.MessageParam[], signal?: AbortSignal) => Promise<Anthropic.Message>
  /** 收到过的每一次 messages 数组的快照。断言用。 */
  readonly calls: Anthropic.MessageParam[][]
}

export function fakeModel(opts: FakeModelOptions): FakeModel {
  const calls: Anthropic.MessageParam[][] = []
  const model = opts.model ?? 'deepseek-v4-flash'
  let i = 0

  return {
    calls,
    async call(messages, signal) {
      // 深拷贝一份快照。不拷的话调用方后续 push 会改到这里，
      // 断言就变成了在看最终状态而不是当时状态——这类测试假绿很难发现。
      calls.push(structuredClone(messages))

      if (opts.delayMs) {
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, opts.delayMs)
          signal?.addEventListener('abort', () => {
            clearTimeout(t)
            rej(new DOMException('aborted', 'AbortError'))
          })
        })
      }
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

      const turn = opts.script[i]
      if (turn) {
        i++
        return makeMessage(turn, model)
      }

      switch (opts.afterScript ?? 'final') {
        case 'repeat_last':
          return makeMessage(opts.script[opts.script.length - 1] ?? {}, model)
        case 'throw':
          throw new Error('假模型：脚本用完了')
        default:
          return makeMessage({ text: '（假模型：脚本用完，给个最终答案）' }, model)
      }
    },
  }
}
