import { priceOf } from './config.ts'

/**
 * 成本账本。L02 的第一个交付物，之后每一节都在用。
 *
 * 存在的理由很简单：**你没法优化你没测量的东西。**
 * L15 那节要把成本砍一个数量级，砍的就是这个账本上的数字。
 *
 * 设计上只有一条硬规则：**记录和计算分离。**
 * record() 只存原始 usage，不存算好的钱。因为单价会变（DeepSeek 预告过
 * 高峰时段翻倍），而历史记录不该跟着变。要钱的时候现算。
 */

export interface Usage {
  input_tokens: number
  output_tokens: number
  /** 命中缓存的输入量。兼容端点可能不返回这个字段。 */
  cache_read_input_tokens?: number | null
  /** 写入缓存的输入量。 */
  cache_creation_input_tokens?: number | null
}

export interface Entry {
  /** 这次调用干什么用的。报告里按它分组。 */
  label: string
  /** 服务端返回的 message id。对账唯一凭据，日志里必须有。 */
  id: string
  /**
   * **实际**服务你的模型，不是你请求的那个。
   * 服务商会做别名解析和灰度切换，记错了会让你把模型换版当成自己的 prompt 退化。
   */
  model: string
  usage: Usage
  /** 墙上时间，毫秒。 */
  ms: number
  /** 首字延迟，只有流式才有。 */
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

const num = (v: number | null | undefined) => v ?? 0

export class Ledger {
  private readonly rows: Entry[] = []

  constructor(readonly name = '账本') {}

  record(entry: Entry): Entry {
    this.rows.push(entry)
    return entry
  }

  get entries(): readonly Entry[] {
    return this.rows
  }

  /**
   * 单条的钱。
   *
   * 注意 input_tokens 的语义：它是**总输入**，其中命中缓存的那部分要按便宜的
   * 单价算。所以未命中的量 = input_tokens − cache_read，而不是直接拿 input_tokens
   * 乘 miss 单价——那样会把已经省下的钱又算回来。
   */
  costOf(e: Entry): number {
    const p = priceOf(e.model)
    const hit = num(e.usage.cache_read_input_tokens)
    const write = num(e.usage.cache_creation_input_tokens)
    const miss = Math.max(0, e.usage.input_tokens - hit)

    return (
      (miss / 1e6) * p.inputMiss +
      (hit / 1e6) * p.inputHit +
      (write / 1e6) * p.inputMiss +
      (e.usage.output_tokens / 1e6) * p.output
    )
  }

  totals(): Totals {
    return this.rows.reduce<Totals>(
      (t, e) => ({
        calls: t.calls + 1,
        inputTokens: t.inputTokens + e.usage.input_tokens,
        outputTokens: t.outputTokens + e.usage.output_tokens,
        cacheRead: t.cacheRead + num(e.usage.cache_read_input_tokens),
        cacheWrite: t.cacheWrite + num(e.usage.cache_creation_input_tokens),
        ms: t.ms + e.ms,
        yuan: t.yuan + this.costOf(e),
      }),
      { calls: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, ms: 0, yuan: 0 },
    )
  }

  /** 缓存命中率。没有缓存数据时返回 null，而不是 0——「没数据」和「命中率 0」是两件事。 */
  cacheHitRate(): number | null {
    const t = this.totals()
    if (t.inputTokens === 0) return null
    if (t.cacheRead === 0 && t.cacheWrite === 0) return null
    return t.cacheRead / t.inputTokens
  }

  report(): string {
    if (this.rows.length === 0) return `${this.name}：没有记录`

    const lines = [
      '',
      `── ${this.name} ──`,
      '',
      pad('用途', 18) + r('输入', 9) + r('命中', 8) + r('输出', 8) + r('耗时', 9) + r('元', 10),
      '─'.repeat(62),
    ]

    for (const e of this.rows) {
      lines.push(
        pad(e.label, 18) +
          r(String(e.usage.input_tokens), 9) +
          r(String(num(e.usage.cache_read_input_tokens)), 8) +
          r(String(e.usage.output_tokens), 8) +
          r(`${Math.round(e.ms)}ms`, 9) +
          r(this.costOf(e).toFixed(5), 10),
      )
    }

    const t = this.totals()
    const rate = this.cacheHitRate()

    lines.push(
      '─'.repeat(62),
      pad(`合计 ${t.calls} 次`, 18) +
        r(String(t.inputTokens), 9) +
        r(String(t.cacheRead), 8) +
        r(String(t.outputTokens), 8) +
        r(`${Math.round(t.ms)}ms`, 9) +
        r(t.yuan.toFixed(5), 10),
      '',
      rate === null
        ? '缓存：无数据（兼容端点没返回缓存字段，或这批请求前缀都没重复）'
        : `缓存命中率 ${(rate * 100).toFixed(1)}%`,
    )

    return lines.join('\n')
  }
}

/** CJK 占两格，直接 padEnd 会歪。 */
const width = (s: string) =>
  [...s].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)))
const r = (s: string, n: number) => ' '.repeat(Math.max(0, n - width(s))) + s
