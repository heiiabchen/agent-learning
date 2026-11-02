/**
 * L00 · 任务三参考实现（组装部分）。
 *
 * 三个函数本身已经搬到 shared/resilience.ts 了，这里只保留组装演示。
 * 单一事实来源：任何一份「为了方便」而复制出来的第二份实现，
 * 都会在某次只改了其中一份之后开始骗人。
 */
import { createClient, getProvider } from '../../shared/config.ts'
import { pooled, withRetry, withTimeout } from '../../shared/resilience.ts'

const provider = getProvider()
const client = createClient(provider)

const questions = [
  '一句话说明什么是 prompt injection。',
  '一句话说明什么是 RAG。',
  '一句话说明什么是 MCP。',
  '一句话说明什么是 tool use。',
  '一句话说明什么是 context window。',
]

const t0 = Date.now()
const stamp = () => `\x1b[2m+${String(Date.now() - t0).padStart(5)}ms\x1b[0m`

const results = await pooled(questions, 2, async (question, i) => {
  console.log(`${stamp()} 开始 #${i}`)

  const text = await withRetry(
    () =>
      withTimeout(20_000, async (signal) => {
        const msg = await client.messages.create(
          {
            model: provider.models.main,
            max_tokens: 256,
            system: '只用一句话回答，不要铺垫。',
            messages: [{ role: 'user', content: question }],
          },
          { signal },
        )
        return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      }),
    { tries: 3 },
  )

  console.log(`${stamp()} 完成 #${i}`)
  return text
})

console.log('\n─────────── 结果 ───────────\n')
results.forEach((r, i) => {
  if (r.status === 'fulfilled') {
    console.log(`#${i} ${r.value.trim()}\n`)
  } else {
    console.log(`#${i} \x1b[31m失败：${(r.reason as Error).message}\x1b[0m\n`)
  }
})

const ok = results.filter((r) => r.status === 'fulfilled').length
console.log(`成功 ${ok}/${results.length}，总耗时 ${Date.now() - t0}ms`)
console.log(`
看一下上面「开始」的时间戳：#0 #1 几乎同时，#2 要等到 #0 或 #1 完成才开始。
这就是并发闸门在起作用。把 pooled 的 limit 改成 5 再跑一次，
你会看到五个请求同时冲出去——在真实项目里这就是撞 429 的方式。`)
