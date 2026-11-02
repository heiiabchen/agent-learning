/**
 * L02 · 任务二：写你自己的流式读取器。
 *
 * 跑法：pnpm reader        验证：pnpm verify:l02
 *
 * `shared/stream.ts` 里有我的实现。**先别看。**
 *
 * 这个练习的价值全在边界条件上。L01 你已经消费过一次流了，
 * 那次只处理了三种事件、只求个 TTFT。这次要处理全部六种情况，
 * 因为 L05 的 agent loop 要从这个流里实时解析工具调用——那时任何一处漏洞都是功能故障。
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { Usage } from '../shared/ledger.ts'

export interface StreamBlock {
  index: number
  type: string
  text: string
  toolName?: string
  toolId?: string
}

export interface StreamResult {
  text: string
  thinking: string
  blocks: StreamBlock[]
  stopReason: string | null
  usage: Usage
  id: string
  model: string
  ttftMs: number
  totalMs: number
}

export class StreamAbortedError extends Error {
  constructor(
    message: string,
    readonly partial: Partial<StreamResult>,
  ) {
    super(message)
    this.name = 'StreamAbortedError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO · 实现 readStream
//
// 六件必须做对的事，每一件对应讲义第五节的一条：
//
// 1 · **按 index 分桶。**
//     一次响应可能有多个内容块：thinking（index 0）、text（index 1）、
//     带工具时还有更多。所有 delta 都 += 到同一个字符串上，
//     思考和正文就糊成一坨了。用 Map<number, StreamBlock>。
//
// 2 · **delta 有多种类型，字段名不同。**
//       text_delta        → d.text
//       thinking_delta    → d.thinking
//       input_json_delta  → d.partial_json
//     统一写 d.text 会在思考块上拿到 undefined，
//     然后你的字符串里会出现字面量 "undefined"。
//
// 3 · **usage 被劈成两半。**
//       input_tokens  在 message_start
//       output_tokens 在 message_delta（同一个事件还带 stop_reason）
//     只监听 message_start 的话，output_tokens 永远是 0。
//
// 4 · **没收到 message_stop 就是失败。**
//     连接被中间代理掐掉时，for await 会安静地正常结束，一个 error 事件都没有。
//     所以要有一个 sawStop 标记，循环结束后检查它。
//     这一条最少人想到，也最难在本地复现。
//
// 5 · **流内 error 事件。**
//     HTTP 已经 200、头已经发出去了，服务端只能在流内部报错。
//     抛错时把已累积的部分放进 StreamAbortedError.partial，
//     调用方需要它来决定怎么收拾（通常是丢弃，但得让它自己决定）。
//
// 6 · **ping 事件安静忽略。**
//     服务端周期性发空 ping 保活，防止代理层掐连接。别让它污染输出。
//
// TTFT 只算到**第一个正文** delta，不算思考块——用户看到的第一个字才是首字。
// （这是个可以争论的设计选择。如果你的 UI 会展示思考过程，那就该算思考的第一块。
//   重要的是你知道自己在量什么。）
// ─────────────────────────────────────────────────────────────────────────────

export async function readStream(
  _stream: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  _onText?: (chunk: string) => void,
): Promise<StreamResult> {
  throw new Error('TODO 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 2 · 用它跑一次真请求
//
//   要一个会触发思考模式的问题（DeepSeek V4 默认开着），确认：
//     · blocks 里确实有两个块，type 分别是 thinking 和 text
//     · text 里没有混进思考内容
//     · usage.output_tokens 不是 0
//     · stopReason 是 'end_turn'
//
//   然后回答：thinking 块的 token 算不算进 output_tokens？
//   （去看数字，别猜。这个答案会影响你 L15 怎么算成本。）
// ─────────────────────────────────────────────────────────────────────────────
