/**
 * L02 · 探测：兼容层到底执行了哪些规则。
 *
 * 跑法：pnpm anatomy
 *
 * 这个脚本不是练习，是**测量工具**。它故意违反 Messages API 的每一条约束，
 * 记录 DeepSeek 兼容端点的真实反应。
 *
 * 为什么值得跑：讲义里那四条不变量是 Anthropic 官方协议的规定，而你用的是
 * 兼容端点。「文档这么写」和「这个端点真这么干」是两件事，差异清单本身就是资产。
 * L15 会把这张表扩充成完整的特性支持表。
 *
 * 花费：十几个小请求，几分钱。
 */
import Anthropic from '@anthropic-ai/sdk'
import { createClient, getProvider } from '../shared/config.ts'
import { withRetry, withTimeout } from '../shared/resilience.ts'

const provider = getProvider()
const client = createClient(provider)

interface Probe {
  name: string
  /** 你的预期。写下来，然后看现实打不打你的脸。 */
  expect: string
  run: () => Promise<unknown>
  /**
   * 可选的语义检查：返回一句抱怨表示「HTTP 200 了，但这次调用并没有做到我要的事」。
   *
   * 为什么需要这个：只看状态码的探测会漏掉最阴的一类问题。
   * 兼容端点最常见的失败模式不是报错，而是**接受了你的参数然后不照做**。
   * 200 是「我收到了」，不是「我做到了」。这个区别在 L12 会变成一整节 Evals。
   */
  check?: (res: Anthropic.Message) => string | null
}

const textOf = (res: Anthropic.Message) =>
  res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')

/**
 * 最小的合法请求，用来做对照组。
 *
 * max_tokens 给到 200 是有原因的：一开始我写的 16，结果几乎每条探测的正文都是空的。
 * 不是请求失败，是这 16 个 token 全被思考块吃掉了，正文还没开始写就到上限了。
 * 这本身就是第三节那句话的现场证据——**思考 token 算进 output_tokens，而且先花**。
 */
const base = {
  model: provider.models.main,
  max_tokens: 200,
} as const

const ask = (body: Partial<Anthropic.MessageCreateParamsNonStreaming>) =>
  withRetry(
    () =>
      withTimeout(30_000, async (signal) =>
        client.messages.create(
          { ...base, messages: [], ...body } as Anthropic.MessageCreateParamsNonStreaming,
          { signal },
        ),
      ),
    // 探测里不要重试太多次：我们**期待**其中一部分失败，重试只是浪费时间和钱
    { tries: 2, baseMs: 300 },
  )

const probes: Probe[] = [
  {
    name: '对照组：最小合法请求',
    expect: '成功',
    run: () => ask({ messages: [{ role: 'user', content: '说「好」' }] }),
  },
  {
    name: '规则 1：以 assistant 开头',
    expect: '400',
    run: () => ask({ messages: [{ role: 'assistant', content: '我先说' }] }),
  },
  {
    name: '规则 2：连续两条 user',
    expect: '400',
    run: () =>
      ask({
        messages: [
          { role: 'user', content: '第一句' },
          { role: 'user', content: '第二句' },
        ],
      }),
  },
  {
    name: '规则 3：以 assistant 结尾（prefill）',
    expect: '成功，且模型接着这句往下写',
    run: () =>
      ask({
        messages: [
          { role: 'user', content: '列出三种水果，直接给列表' },
          { role: 'assistant', content: '1. 苹果\n2.' },
        ],
      }),
    // prefill 的语义是「你已经说了这些，接着往下」，所以返回的正文里
    // **不应该**再出现一遍「1. 苹果」。官方端点只回续写的部分。
    check: (res) =>
      /1\.\s*苹果/.test(textOf(res))
        ? 'prefill 被重新说了一遍，不是续写——这个端点上 prefill 不是真的 prefill'
        : null,
  },
  {
    name: '规则 3b：prefill 末尾带空格',
    expect: '400（官方协议不允许尾随空白）',
    run: () =>
      ask({
        messages: [
          { role: 'user', content: '列出三种水果' },
          { role: 'assistant', content: '1. 苹果 ' },
        ],
      }),
  },
  {
    name: '规则 4：messages 为空',
    expect: '400',
    run: () => ask({ messages: [] }),
  },
  {
    name: 'content 用块数组而不是字符串',
    expect: '成功，和字符串等价',
    run: () =>
      ask({ messages: [{ role: 'user', content: [{ type: 'text', text: '说「好」' }] }] }),
  },
  {
    name: 'content 是空字符串',
    expect: '不确定——这个真得测',
    run: () => ask({ messages: [{ role: 'user', content: '' }] }),
  },
  {
    name: 'system 传成数组（多块 system）',
    expect: '成功，Anthropic 官方支持这种形式',
    run: () =>
      ask({
        system: [{ type: 'text', text: '你只能回答一个字。' }] as never,
        messages: [{ role: 'user', content: '你好' }],
      }),
  },
  {
    name: 'stop_sequences 命中',
    expect: "成功，stop_reason='stop_sequence'，且停止串本身不在输出里",
    // 这条要给足预算：思考块先花掉一两百 token，正文还没开始就到上限的话，
    // 停止串永远轮不到被命中，你会误以为 stop_sequences 不被支持。
    run: () =>
      ask({
        max_tokens: 800,
        stop_sequences: ['三'],
        messages: [{ role: 'user', content: '从一数到十，每个数字一行，用中文数字' }],
      }),
    check: (res) => {
      if (res.stop_reason !== 'stop_sequence') return `stop_reason 是 ${res.stop_reason}，不是 stop_sequence`
      return textOf(res).includes('三') ? '停止串本身出现在输出里了' : null
    },
  },
  {
    name: 'temperature 超出范围（2.5）',
    expect: '400 或被静默截断到上限——静默是更糟的那种',
    run: () => ask({ temperature: 2.5, messages: [{ role: 'user', content: '你好' }] }),
  },
  {
    name: 'max_tokens 为 0',
    expect: '400',
    run: () => ask({ max_tokens: 0, messages: [{ role: 'user', content: '你好' }] }),
  },
  {
    name: '不存在的模型 ID',
    expect: '404 或 400，且错误信息应该说得清',
    run: () => ask({ model: 'deepseek-nonexistent-v99', messages: [{ role: 'user', content: 'hi' }] }),
  },
]

// ── 跑 ────────────────────────────────────────────────────────────────────

console.log(`探测 ${provider.name} · ${provider.baseURL}`)
console.log(`模型 ${provider.models.main}\n`)

const findings: {
  name: string
  expect: string
  actual: string
  surprise: boolean
  complaint?: string | null
}[] = []

for (const p of probes) {
  let actual: string
  let ok: boolean
  let complaint: string | null = null

  try {
    const res = (await p.run()) as Anthropic.Message
    const text = textOf(res).replace(/\n/g, '⏎').slice(0, 46)
    // 块类型也打出来：正文为空但 output_tokens 不为 0 的时候，答案就在这里
    const shape = res.content.map((b) => b.type).join('+') || '空'
    complaint = p.check?.(res) ?? null
    // 200 但没做到要求的事，也算没通过
    ok = complaint === null
    actual = `${complaint ? '语义不符' : '成功'} · stop=${res.stop_reason} · 块[${shape}] · out=${res.usage.output_tokens} · "${text}"`
  } catch (err) {
    ok = false
    const e = err as { status?: number; message?: string }
    actual = `${e.status ?? '无 status'} · ${(e.message ?? '').slice(0, 60)}`
  }

  // 「预期失败但成功了」和「预期成功但失败了」都是意外，都值得注意
  const expectedFail = /^\d{3}/.test(p.expect)
  const surprise = expectedFail === ok

  findings.push({ name: p.name, expect: p.expect, actual, surprise, complaint })
  console.log(`${surprise ? '\x1b[33m⚑\x1b[0m' : ' '} ${p.name}`)
  console.log(`   预期 ${p.expect}`)
  console.log(`   实际 ${actual}`)
  if (complaint) console.log(`   \x1b[33m↳ ${complaint}\x1b[0m`)
  console.log()
}

// ── 差异清单 ──────────────────────────────────────────────────────────────

const surprises = findings.filter((f) => f.surprise && !f.expect.includes('不确定'))

console.log('─'.repeat(64))
if (surprises.length === 0) {
  console.log('兼容层的行为和官方协议一致。')
} else {
  console.log(`\x1b[33m${surprises.length} 处和预期不符：\x1b[0m\n`)
  for (const s of surprises) {
    console.log(`  · ${s.name}`)
    console.log(`    预期 ${s.expect}`)
    console.log(`    实际 ${s.actual}`)
    if (s.complaint) console.log(`    ↳ ${s.complaint}`)
    console.log()
  }
  console.log(`把这几条记下来。它们是你这个 provider 的真实契约，而不是文档里的契约。`)
}

console.log(`
三件值得琢磨的事：

1. 「预期失败却成功了」比「预期成功却失败了」更危险。后者你立刻就知道，
   前者意味着**这个端点比协议宽松**——你的代码会在这个端点上跑得好好的，
   换到官方端点或者别的兼容端点就炸。宽松是一种技术债。

2. 上面每一个 400 都是**不可重试**的。你在 L00 写的 withRetry 靠 status 分类，
   这些请求它会立刻放弃——这是对的行为。把参数错误重试四次只是把钱和时间烧掉。

3. 注意那条「语义不符」。它 HTTP 200、没有任何报错，但没做到要求的事。
   兼容端点最常见的失败模式就是这个：**接受你的参数，然后不照做**。
   只看状态码的检查抓不到它，只有断言语义才行。这就是 L12 那节 Evals 的起点。
`)
