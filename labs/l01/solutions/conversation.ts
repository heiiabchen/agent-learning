/**
 * L01 · 任务三参考实现。
 */
import type Anthropic from '@anthropic-ai/sdk'
import { createClient, getProvider, priceOf } from '../../shared/config.ts'
import { withRetry, withTimeout } from '../../shared/resilience.ts'

const provider = getProvider()
const client = createClient(provider)
const price = priceOf(provider.models.main)

const SYSTEM = '你是一个前端技术顾问。回答控制在 100 字以内，直接给结论。'

const TURNS = [
  '我要做一个实时协作的白板应用，前端框架选 React 还是 Svelte？',
  '按你选的这个，状态管理用什么？',
  '多人同时编辑的冲突怎么解决？',
  '你刚才提到的那个方案，离线场景下怎么办？',
  '如果要支持一万人同时在线，第一个瓶颈会出现在哪？',
  '总结一下你前面给我的所有建议。',
]

const messages: Anthropic.MessageParam[] = []
const log: { turn: number; input: number; output: number }[] = []

for (const [i, question] of TURNS.entries()) {
  // 注意：这里**没有**先 push user 消息。
  // 先改状态再做可能失败的事，失败后会留下孤儿消息污染历史。
  const next: Anthropic.MessageParam[] = [...messages, { role: 'user', content: question }]

  const res = await withRetry(() =>
    withTimeout(60_000, async (signal) =>
      client.messages.create(
        {
          model: provider.models.main,
          max_tokens: 512,
          system: SYSTEM, // 顶层参数，不是 messages 里的一项
          messages: next,
        },
        { signal },
      ),
    ),
  )

  if (res.stop_reason === 'max_tokens') {
    throw new Error(
      `第 ${i + 1} 轮被 max_tokens 截断了。半截回答如果存进历史，会污染后面每一轮——` +
        `所以这里宁可直接失败，也不要静默入库。`,
    )
  }

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')

  // 成功之后才一起提交状态
  messages.length = 0
  messages.push(...next, { role: 'assistant', content: text })

  log.push({ turn: i + 1, input: res.usage.input_tokens, output: res.usage.output_tokens })

  console.log(`\x1b[2m第 ${i + 1} 轮\x1b[0m ${question}`)
  console.log(`${text.trim()}\n`)
}

// ── 账单 ──────────────────────────────────────────────────────────────────

const yuan = (t: number, perMillion: number) => (t / 1_000_000) * perMillion

console.log('轮次   本轮输入   本轮输出   累计输入   累计花费(元)')
console.log('─'.repeat(52))

let cumIn = 0
let cumOut = 0
for (const r of log) {
  cumIn += r.input
  cumOut += r.output
  const cost = yuan(cumIn, price.inputMiss) + yuan(cumOut, price.output)
  console.log(
    String(r.turn).padStart(3) +
      String(r.input).padStart(10) +
      String(r.output).padStart(11) +
      String(cumIn).padStart(11) +
      cost.toFixed(4).padStart(14),
  )
}

// ── 无状态的代价 ──────────────────────────────────────────────────────────

/**
 * 假想的「有状态 API」要发多少输入？system 发一次，每条 user 消息发一次，
 * 助手的回复完全不用回传。
 *
 * 我们没有单独测过每条 user 消息有多少 token，但可以从相邻两轮的差值反推出来：
 *
 *   第 n 轮的上下文 = 第 n−1 轮的上下文 + 助手第 n−1 轮的回复 + 用户第 n 条消息
 *   ⇒ userₙ = inputₙ − inputₙ₋₁ − outputₙ₋₁
 *
 * 又是差分——和 tokens.ts 里那个套路完全一样：测不到绝对值，就去测差值。
 */
const statefulIn = log.reduce(
  (sum, r, i) => (i === 0 ? r.input : sum + (r.input - log[i - 1]!.input - log[i - 1]!.output)),
  0,
)
const blowup = cumIn / statefulIn

const costMiss = yuan(cumIn, price.inputMiss) + yuan(cumOut, price.output)
const costHit = yuan(cumIn, price.inputHit) + yuan(cumOut, price.output)

console.log(`
─────────── 结论 ───────────

累计输入 ${cumIn} token，累计输出 ${cumOut} token
输入花了 ${yuan(cumIn, price.inputMiss).toFixed(4)} 元，输出花了 ${yuan(cumOut, price.output).toFixed(4)} 元

无状态的代价：实际输入约为「只发增量」的 ${blowup.toFixed(1)} 倍
（只有 ${TURNS.length} 轮就这样了。这个倍数随轮数继续涨，因为累计输入是 O(n²) 的。）

缓存未命中：${costMiss.toFixed(4)} 元
缓存全命中：${costHit.toFixed(4)} 元    ← 差 ${(costMiss / costHit).toFixed(0)} 倍

最后这个倍数就是 L15 存在的理由。而拿到它的代价只是一条纪律：
**保持前缀稳定，新内容只往后追加。**
任何往历史中间插入或修改的操作，都会让那个位置之后的缓存全部失效。`)
