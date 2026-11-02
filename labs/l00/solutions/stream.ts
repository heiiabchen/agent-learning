/**
 * L00 · 任务二参考实现。
 *
 * 重点：TTFT 和总时长是两个独立的指标，流式只优化前者。
 */
import { createClient, getProvider } from '../../shared/config.ts'

const provider = getProvider()
const client = createClient(provider)

async function askStreaming(question: string) {
  const sentAt = Date.now()
  let firstTokenAt: number | null = null
  let inputTokens = 0
  let outputTokens = 0

  const stream = await client.messages.create({
    model: provider.models.main,
    max_tokens: 2048,
    messages: [{ role: 'user', content: question }],
    stream: true,
  })

  for await (const event of stream) {
    if (event.type === 'message_start') {
      inputTokens = event.message.usage.input_tokens
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      firstTokenAt ??= Date.now()
      // 用 write 而不是 log，否则每块都换行，看不出流式效果
      process.stdout.write(event.delta.text)
    } else if (event.type === 'message_delta') {
      outputTokens = event.usage.output_tokens
    }
  }

  const done = Date.now()
  const ttft = (firstTokenAt ?? done) - sentAt
  const total = done - sentAt

  console.log(`\n\x1b[2m首字 ${ttft}ms · 总时长 ${total}ms · 输入 ${inputTokens} · 输出 ${outputTokens}\x1b[0m`)
  return { ttft, total, outputTokens }
}

console.log('── 短回答 ──')
const short = await askStreaming('一句话说明什么是 tool use。')

console.log('\n── 长回答 ──')
const long = await askStreaming('详细解释 HTTP/2 相比 HTTP/1.1 的改进，分点讲。')

console.log('\n───────────────────────────────')
console.log(`首字延迟：${short.ttft}ms → ${long.ttft}ms（基本没变）`)
console.log(`总时长：  ${short.total}ms → ${long.total}ms（涨了 ${(long.total / short.total).toFixed(1)} 倍）`)
console.log(`输出 token：${short.outputTokens} → ${long.outputTokens}`)
console.log(`
结论：TTFT 由输入长度决定，两次输入都很短所以几乎一样。
总时长由输出长度决定，所以第二次涨了这么多。

流式没有让任何东西变快，它只是把用户感知的等待从「总时长」换成了「首字延迟」。
这就是为什么所有 agent 产品都必须做流式——不是性能优化，是可用性的门槛。`)
