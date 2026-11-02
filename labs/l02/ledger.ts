/**
 * L02 · 任务一：写你自己的成本账本。
 *
 * 跑法：pnpm ledger        验证：pnpm verify:l02
 *
 * `shared/ledger.ts` 里有我的实现。**先别看。**
 * 自己写完、verify 跑绿了，再拿两版对照——差异比答案有价值。
 */
import type { Usage } from '../shared/ledger.ts'
import { createClient, getProvider, priceOf } from '../shared/config.ts'
import { textOf } from '../shared/message.ts'

export interface Entry {
  label: string
  id: string
  model: string
  usage: Usage
  ms: number
  ttftMs?: number
}

export interface Totals {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  ms: number
  yuan: number
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 1 · record / entries
//
//   记录一条调用。只存**原始 usage**，不存算好的钱。
//
//   为什么这条是硬规则：单价会变（DeepSeek 已经预告过高峰时段翻倍）。
//   如果你在 record 的时候就把钱算好存下来，那么单价一改，
//   你的历史记录就变成了一堆无法解释的数字——你不知道哪条是按旧价算的。
//   **存事实，算的时候再算。**
// ─────────────────────────────────────────────────────────────────────────────

// TODO 2 · costOf(entry)
//
//   单条的钱。priceOf(model) 给你 { inputMiss, inputHit, output }，单位是元/百万。
//
//   一个容易算错的地方：usage.input_tokens 是**总输入**，其中
//   cache_read_input_tokens 那部分已经命中缓存了，要按便宜的单价算。
//   所以未命中的量是 input_tokens − cache_read，不是 input_tokens。
//   直接拿 input_tokens 乘 miss 单价，等于把已经省下的钱又算回来了。

// TODO 3 · totals()
//
//   合计。注意兼容端点可能压根不返回 cache_* 字段，所以要能处理 undefined。

// TODO 4 · cacheHitRate()
//
//   命中率。没有缓存数据时返回 null 而不是 0——
//   「没测到数据」和「命中率是 0」是两个完全不同的结论，混在一起你会误判。

// TODO 5 · report()
//
//   打一张表出来。每行一次调用，末尾一行合计。
//   提示：CJK 在终端占两格，直接 padEnd 会歪，参考 l01/solutions/tokens.ts。

export class Ledger {
  constructor(readonly name = '账本') {}

  record(_entry: Entry): Entry {
    throw new Error('TODO 1 还没实现')
  }

  get entries(): readonly Entry[] {
    throw new Error('TODO 1 还没实现')
  }

  costOf(_e: Entry): number {
    throw new Error('TODO 2 还没实现')
  }

  totals(): Totals {
    throw new Error('TODO 3 还没实现')
  }

  cacheHitRate(): number | null {
    throw new Error('TODO 4 还没实现')
  }

  report(): string {
    throw new Error('TODO 5 还没实现')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 6 · 拿它去记一笔真账
//
//   用账本包住三次真实调用，跑完打出报告：
//     · 一次短问题
//     · 一次同样的问题**再问一遍**（观察缓存字段有没有动）
//     · 一次长输出的问题
//
//   然后回答：
//     a) 第二次调用的 cache_read 是多少？如果是 0，可能的原因有哪些？
//     b) 三次里哪一次最贵？贵在输入还是输出？
//     c) 如果这三次调用是一个 agent 的三个步骤，你会先优化哪一个？
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const provider = getProvider()
  const client = createClient(provider)
  const ledger = new Ledger('L02 记账练习')

  // 一个够用的包装：调用 + 计时 + 记账。你的 TODO 6 从这里往下写。
  async function call(label: string, prompt: string, maxTokens = 256) {
    const t0 = Date.now()
    const res = await client.messages.create({
      model: provider.models.main,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    })
    ledger.record({
      label,
      id: res.id,
      model: res.model,
      usage: res.usage,
      ms: Date.now() - t0,
    })
    return textOf(res.content)
  }

  void call
  void priceOf
  throw new Error('把 TODO 6 写完，然后删掉这一行')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
