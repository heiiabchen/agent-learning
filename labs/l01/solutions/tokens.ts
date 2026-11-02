/**
 * L01 · 任务一参考实现。
 */
import { createClient, getProvider } from '../../shared/config.ts'
import { pooled, withRetry, withTimeout } from '../../shared/resilience.ts'

const provider = getProvider()
const client = createClient(provider)

const SAMPLES: { name: string; text: string }[] = [
  { name: '英文散文', text: 'The quick brown fox jumps over the lazy dog near the river bank.' },
  { name: '中文散文', text: '敏捷的棕色狐狸跳过了河岸边那只懒惰的狗，动作干净利落。' },
  { name: 'JSON 数据', text: '{"id":"7f3a-91c2","ts":1738291045,"score":3.14159,"ok":true}' },
  { name: 'TS 代码', text: 'export async function withTimeout<R>(ms: number, fn: () => Promise<R>) {' },
  { name: '缩进空白', text: '        \n        \n        \n        \n        \n' },
  { name: '随机 ID', text: 'a3f9c1e7-4b82-4d16-9f0a-7c2e5b8d3a61' },
]

/** 把 text 作为唯一一条 user 消息发出去，返回 input_tokens。max_tokens=1 是为了少付钱。 */
async function measure(text: string): Promise<number> {
  return withRetry(() =>
    withTimeout(30_000, async (signal) => {
      const msg = await client.messages.create(
        {
          model: provider.models.main,
          max_tokens: 1,
          messages: [{ role: 'user', content: text }],
        },
        { signal },
      )
      return msg.usage.input_tokens
    }),
  )
}

/**
 * 差分测量：measure 里含有每条消息都有的固定开销，而我们不知道它是多少。
 * 测 text 和 text+text 两次相减，固定开销正好被消掉，剩下的就是 text 的净 token 数。
 *
 * 测不到绝对值就去测差值——这个套路在 L12 会反复出现。
 */
async function net(text: string): Promise<number> {
  const [once, twice] = await Promise.all([measure(text), measure(text + text)])
  return twice - once
}

/** CJK 字符在终端里占两格，直接 padEnd 会歪。 */
const displayWidth = (s: string) =>
  [...s].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)

const padRight = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - displayWidth(s)))

const rows = await pooled(SAMPLES, 2, async (s) => ({ ...s, tokens: await net(s.text) }))

console.log('\n' + padRight('名称', 14) + '字符数'.padStart(6) + 'token'.padStart(9) + '字符/token'.padStart(12))
console.log('─'.repeat(48))

for (const r of rows) {
  if (r.status === 'rejected') {
    console.log(`\x1b[31m测量失败：${(r.reason as Error).message}\x1b[0m`)
    continue
  }
  const { name, text, tokens } = r.value
  const ratio = tokens > 0 ? (text.length / tokens).toFixed(2) : '—'
  console.log(
    padRight(name, 14) +
      String(text.length).padStart(6) +
      String(tokens).padStart(9) +
      ratio.padStart(12),
  )
}

console.log(`
读表要点：

· 「字符/token」越高越省。你会看到随机 ID 和 JSON 明显垫底——
  标点、数字、无规律字符串在 BPE 词表里没有任何统计规律可以利用，
  几乎是逐字符切。往上下文里塞 UUID、时间戳、哈希是很贵的。

· 中英文的比值不能直接对比「谁更省」，因为一个中文字符承载的信息量
  远大于一个英文字符。要回答「同样意思花多少 token」，得拿两段
  意思相同的译文对比着测——通常中文会比英文多花三到五成。

· 最高和最低的比值差好几倍。所以任何用**字符数**当上下文预算的代码
  都是不可控的，预算的单位只能是 token。`)
