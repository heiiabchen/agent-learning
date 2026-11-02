/**
 * L01 · 任务二参考实现。
 */
import { createClient, getProvider } from '../../shared/config.ts'
import { pooled, withRetry, withTimeout } from '../../shared/resilience.ts'

const provider = getProvider()
const client = createClient(provider)

const PROMPT = '给一个把 API 密钥安全存放在服务端的做法起一个变量名，只回答变量名本身，不要解释。'
const RUNS = 5

async function ask(temperature: number): Promise<string> {
  return withRetry(() =>
    withTimeout(30_000, async (signal) => {
      const msg = await client.messages.create(
        {
          model: provider.models.main,
          max_tokens: 32,
          temperature,
          messages: [{ role: 'user', content: PROMPT }],
        },
        { signal },
      )
      // 思考模式下 content[0] 可能是 thinking 块，所以要 filter 不要 [0]
      return msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
    }),
  )
}

async function trial(temperature: number) {
  console.log(`\n\x1b[1mtemperature = ${temperature}\x1b[0m`)

  const results = await pooled(Array.from({ length: RUNS }), 2, () => ask(temperature))
  const outputs: string[] = []

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      outputs.push(r.value)
      console.log(`  ${i + 1}. ${r.value}`)
    } else {
      console.log(`  ${i + 1}. \x1b[31m失败：${(r.reason as Error).message}\x1b[0m`)
    }
  })

  const distinct = new Set(outputs).size
  const color = distinct === 1 ? '\x1b[32m' : '\x1b[33m'
  console.log(`  ${color}${outputs.length} 次里出现了 ${distinct} 种不同输出\x1b[0m`)
}

await trial(0)
await trial(1)

console.log(`
怎么读这个结果：

· temperature 0 大概率是 1 种（或 5 次里有 1 次跑偏），temperature 1 通常好几种。
  这符合预期：温度关掉的是**采样**那一层的随机性。

· 但请注意——**「五次都一样」不能证明它是确定性的。**
  这是这个实验最容易被误读的地方。你只是没观察到分歧，不等于分歧不存在。
  浮点归约顺序、批次组成、MoE 路由这些因素只在「第一名和第二名的 logits
  极度接近」时才会翻转排名，那是个低概率事件——低概率不是零概率，
  而线上跑一百万次的时候，低概率事件每天都在发生。

  「测了几次没复现」和「不会发生」是两回事。这个区分是做 evals 的基本素养。

· 所以自动化断言不能写成「输出 === 某个字符串」。可用的断言长这样：
    - 结构：能不能 JSON.parse、必需字段在不在
    - 约束：是不是合法标识符、长度在不在范围内、有没有出现禁用词
    - 统计：跑 N 次，通过率是否 ≥ 阈值（承认它是概率系统，然后度量这个概率）
  你在 l00/verify.ts 里写的每一条断言都是这种形状，没有一条在比对字符串。

· 什么时候用什么温度：
    - 低温：工具调用参数、结构化输出、代码生成、分类判断——要的是稳定和可复现。
    - 高温：头脑风暴、多样化候选、创意文案，以及 L12 里「故意采样多个答案
      再投票」的场景（self-consistency）。`)
