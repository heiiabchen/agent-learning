import type Anthropic from '@anthropic-ai/sdk'
import type { Usage } from './ledger.ts'

/**
 * 流式读取器。L02 的第二个交付物。
 *
 * 它把 L02 第五节列的所有边界条件处理掉，一次写对，后面十九节直接用：
 *
 *   · 按 index 分桶累积，思考块 / 正文块 / 工具调用块互不干扰
 *   · delta 有多种类型，字段名各不相同（text / thinking / partial_json）
 *   · usage 被劈成两半：input 在 message_start，output 在 message_delta
 *   · 没收到 message_stop 就是失败，哪怕没有 error 事件
 *   · 流内 error 事件（HTTP 已经 200 了才来的那种）
 *   · ping 事件要安静忽略
 */

export interface StreamBlock {
  index: number
  type: string
  /** text / thinking 块的文本；工具调用块这里是拼好的 JSON 字符串。 */
  text: string
  /** 工具调用块才有。 */
  toolName?: string
  toolId?: string
}

export interface StreamResult {
  /** 只含 text 块的正文。 */
  text: string
  /** 思考内容，DeepSeek V4 默认会有。 */
  thinking: string
  /** 全部内容块，按 index 排好序。工具调用要从这里取。 */
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

/**
 * 消费一个流，返回聚合好的结果。
 *
 * onText 是给 UI 用的：每来一小块正文就调一次。
 * 故意只回调正文——思考内容通常不直接给用户看（要看的话读返回值里的 thinking）。
 */
export async function readStream(
  stream: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  onText?: (chunk: string) => void,
): Promise<StreamResult> {
  const startedAt = Date.now()
  let firstTextAt: number | null = null
  let sawStop = false

  // 按 index 分桶。这一行就是「思考和正文糊在一起」那个 bug 的解药。
  const buckets = new Map<number, StreamBlock>()

  let id = ''
  let model = ''
  let stopReason: string | null = null
  const usage: Usage = { input_tokens: 0, output_tokens: 0 }

  const snapshot = (): Partial<StreamResult> => ({
    blocks: [...buckets.values()].sort((a, b) => a.index - b.index),
    id,
    model,
    usage,
  })

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          id = event.message.id
          model = event.message.model
          // input_tokens 在这里就知道了；output 还得等 message_delta
          Object.assign(usage, event.message.usage)
          break
        }

        case 'content_block_start': {
          const b = event.content_block
          buckets.set(event.index, {
            index: event.index,
            type: b.type,
            text: '',
            ...(b.type === 'tool_use' ? { toolName: b.name, toolId: b.id } : {}),
          })
          break
        }

        case 'content_block_delta': {
          const bucket = buckets.get(event.index)
          if (!bucket) break

          const d = event.delta
          // 三种 delta 的字段名不一样。写成 d.text 会在思考块上拿到 undefined，
          // 然后字符串里出现字面量 "undefined"。
          const chunk =
            d.type === 'text_delta'
              ? d.text
              : d.type === 'thinking_delta'
                ? d.thinking
                : d.type === 'input_json_delta'
                  ? d.partial_json
                  : ''

          bucket.text += chunk

          if (d.type === 'text_delta' && chunk) {
            firstTextAt ??= Date.now()
            onText?.(chunk)
          }
          break
        }

        case 'message_delta': {
          stopReason = event.delta.stop_reason ?? null
          // 这里才是 output_tokens 的家
          Object.assign(usage, event.usage)
          break
        }

        case 'message_stop': {
          sawStop = true
          break
        }

        // ping 和未来新增的事件类型：安静忽略，但别静默丢弃错误
        default: {
          if ((event as { type: string }).type === 'error') {
            const err = (event as unknown as { error?: { message?: string } }).error
            throw new StreamAbortedError(
              `流内错误：${err?.message ?? '未知'}（HTTP 已经 200 了才来的那种）`,
              snapshot(),
            )
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof StreamAbortedError) throw err
    throw new StreamAbortedError(`流中断：${(err as Error).message}`, snapshot())
  }

  // 关键的一条：循环正常退出不等于流正常结束。
  // 连接被中间代理掐掉时，for await 会安静地结束，一个 error 事件都没有。
  if (!sawStop) {
    throw new StreamAbortedError('流没有收到 message_stop 就结束了，内容不完整', snapshot())
  }

  const doneAt = Date.now()
  const blocks = [...buckets.values()].sort((a, b) => a.index - b.index)

  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    thinking: blocks.filter((b) => b.type === 'thinking').map((b) => b.text).join(''),
    blocks,
    stopReason,
    usage,
    id,
    model,
    ttftMs: (firstTextAt ?? doneAt) - startedAt,
    totalMs: doneAt - startedAt,
  }
}
