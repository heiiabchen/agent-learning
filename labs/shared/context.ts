/**
 * 参考实现：上下文的计量、分区与预算。
 *
 * 这个模块的存在理由是一句话：**你不能管理你看不见的东西。**
 * 「感觉上下文快满了」不是工程，`breakdown` 才是。
 */

import type Anthropic from '@anthropic-ai/sdk'

// ─────────────────────────────────────────────────────────────
// 计量
// ─────────────────────────────────────────────────────────────

/**
 * token 粗估。
 *
 * 为什么不用 tiktoken：**它算的是 OpenAI 的分词器，而我们用 DeepSeek。**
 * 中文上的差异能到 20% 以上（L01 讲过 BPE 依赖训练语料）。
 * 那个误差的坏处不是「不准」，是**它假装准**——你会基于一个精确的错数字做决策。
 *
 * 所以这里用一个显式的粗估：中日韩字符约 0.6 token，其余约 0.25 token。
 * 系数靠 Calibrator 用服务端返回的真实 usage 校准。
 *
 * **一个带着已知误差的估计，比一个假装精确的错误值有用得多。**
 */
const CJK = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/

export function estimateTokens(text: string, factor = 1): number {
  let units = 0
  for (const ch of text) units += CJK.test(ch) ? 0.6 : 0.25
  return Math.ceil(units * factor)
}

/** 未知的块类型要响一声，不能静默跳过——跳过的往往正是最大的那一块。 */
export class UncountedBlockError extends Error {
  constructor(readonly blockType: string) {
    super(
      `没算过的块类型：${blockType}。` +
        '静默跳过它会让预算数字系统性偏小，然后你在以为还有余量的时候撞上限。',
    )
    this.name = 'UncountedBlockError'
  }
}

type AnyBlock = { type: string; [k: string]: unknown }

/**
 * 数一条消息的 content。
 *
 * ★ 最常见的 bug 是 `if (typeof content === 'string')` 之后就不管别的了——
 * 而 tool_use / tool_result 正是 agent 上下文里最大的那两块。
 */
export function countContent(content: Anthropic.MessageParam['content'], factor = 1): number {
  if (typeof content === 'string') return estimateTokens(content, factor)

  let total = 0
  for (const raw of content) {
    const b = raw as unknown as AnyBlock
    switch (b.type) {
      case 'text':
        total += estimateTokens(String(b.text ?? ''), factor)
        break
      case 'tool_use':
        // 工具名和参数都要发出去。参数是 JSON，序列化后再数。
        total += estimateTokens(String(b.name ?? ''), factor)
        total += estimateTokens(JSON.stringify(b.input ?? {}), factor)
        break
      case 'tool_result':
        total += estimateTokens(stringifyResult(b.content), factor)
        break
      case 'image':
      case 'document':
        // 图片的 token 数由分辨率决定，估不准。给一个保守的常数，
        // 并且**宁可估高**——预算估高的后果是早压一点，估低的后果是撞上限。
        total += 1500
        break
      default:
        throw new UncountedBlockError(b.type)
    }
  }
  return total
}

function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const blk = b as AnyBlock
        return blk.type === 'text' ? String(blk.text ?? '') : JSON.stringify(blk)
      })
      .join('\n')
  }
  return JSON.stringify(content ?? '')
}

// ─────────────────────────────────────────────────────────────
// 分区与预算
// ─────────────────────────────────────────────────────────────

export type Zone = 'system' | 'toolDefs' | 'task' | 'summary' | 'work'

export const zoneLabel: Record<Zone, string> = {
  system: 'system prompt',
  toolDefs: '工具定义',
  task: '原始任务',
  summary: '历史摘要',
  work: '工作区（工具结果与对话）',
}

export interface Budget {
  /** 模型窗口。注意它是**输入加输出**的总额。 */
  window: number
  /**
   * 给输出留的量。
   *
   * ★ 用窗口的百分比做触发线是个常见错误：128K 的 60% 是 76.8K，
   * 剩下的 51K 看着够，但工具结果的分布是长尾的，一个大文件就能吃掉一半。
   * 而且模型要写长报告时这块就不够了。留白不是浪费。
   */
  reserveOutput: number
  /** 用到可用输入额度的多少比例就开始压。0.6 是个合理起点。 */
  compressAt: number
  /** 压到多少为止。**必须比 compressAt 小一截**，否则会在触发线附近反复压缩。 */
  compressTo: number
}

export const defaultBudget: Budget = {
  window: 128_000,
  reserveOutput: 16_000,
  compressAt: 0.6,
  compressTo: 0.3,
}

/** 可用于输入的额度。所有比例都相对它算，不相对 window。 */
export function inputBudget(b: Budget): number {
  return b.window - b.reserveOutput
}

export interface MeasureInput {
  system: string
  tools: Anthropic.Tool[]
  messages: Anthropic.MessageParam[]
  /** 第一条 user 消息是原始任务，单独计一区——因为它**永不压缩**。 */
  summaryTokens?: number
}

export interface ContextStats {
  tokens: number
  /** 相对可用输入额度的占比，不是相对 window */
  ratio: number
  breakdown: Record<Zone, number>
  /** 占用最大的分区。「该压哪一块」的答案通常就在这里 */
  top: Zone
  budget: Budget
}

export function measure(input: MeasureInput, budget = defaultBudget, factor = 1): ContextStats {
  const { system, tools, messages, summaryTokens = 0 } = input

  const breakdown: Record<Zone, number> = {
    system: estimateTokens(system, factor),
    // ★ 工具定义不在 messages 里，但每一步都要发。忘了算它是这一节的常见 bug——
    // 十个工具的 schema 轻松到 2K 以上，而它被当成了免费的。
    toolDefs: tools.reduce(
      (sum, t) => sum + estimateTokens(t.name + (t.description ?? '') + JSON.stringify(t.input_schema), factor),
      0,
    ),
    task: 0,
    summary: summaryTokens,
    work: 0,
  }

  messages.forEach((m, i) => {
    const n = countContent(m.content, factor)
    if (i === 0) breakdown.task += n
    else breakdown.work += n
  })
  // 摘要占的那部分已经单列，从工作区里扣掉，避免重复计数
  breakdown.work = Math.max(0, breakdown.work - summaryTokens)

  const tokens = Object.values(breakdown).reduce((a, b) => a + b, 0)
  const zones = Object.entries(breakdown) as [Zone, number][]
  const top = zones.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0]

  return { tokens, ratio: tokens / inputBudget(budget), breakdown, top, budget }
}

/** 给人看的一行摘要。日志里每步打一条，比事后翻 transcript 有用得多。 */
export function formatStats(s: ContextStats): string {
  const pct = (n: number) => `${Math.round((n / s.tokens) * 100)}%`
  const parts = (Object.entries(s.breakdown) as [Zone, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([z, n]) => `${z} ${n}(${pct(n)})`)
  return `${s.tokens} tok · ${Math.round(s.ratio * 100)}% of budget · ${parts.join(' · ')}`
}

// ─────────────────────────────────────────────────────────────
// 校准
// ─────────────────────────────────────────────────────────────

/**
 * 用服务端返回的真实 usage 校准估算系数。
 *
 * 这是「已知误差的估计」变成「够用的估计」的那一步：
 * 估算值用来做决策（因为决策要在调用**之前**做），真实值用来修正系数。
 *
 * 服务端的 usage 是唯一权威的数字，但它只在调用之后才有。
 */
export class Calibrator {
  private samples: { est: number; real: number }[] = []

  /** factor 的含义：真实 token 约等于估算 token 乘以 factor。 */
  get factor(): number {
    if (this.samples.length === 0) return 1
    const est = this.samples.reduce((a, s) => a + s.est, 0)
    const real = this.samples.reduce((a, s) => a + s.real, 0)
    if (est === 0) return 1
    return real / est
  }

  get count(): number {
    return this.samples.length
  }

  record(estimated: number, actualInputTokens: number): void {
    if (estimated <= 0) return
    this.samples.push({ est: estimated, real: actualInputTokens })
    // 只保留最近的样本：模型和内容分布都会变，老样本会拖累系数。
    if (this.samples.length > 20) this.samples.shift()
  }

  /** 当前偏差的百分比。超过 15% 就该去看是不是估算函数需要改了。 */
  get drift(): number {
    return Math.abs(this.factor - 1)
  }
}

// ─────────────────────────────────────────────────────────────
// 源头裁剪：手段一
// ─────────────────────────────────────────────────────────────

export interface PageOptions {
  offset?: number
  limit?: number
  /** 工具名和参数形式，用来生成「怎么拿下一段」的提示 */
  hint?: (nextOffset: number) => string
}

/**
 * 按行分页，并且**在截断处告诉模型怎么拿下一段**。
 *
 * ★ 这是这一节最重要的一个函数，因为不给出路的截断会造出死循环：
 * 模型需要后面的内容，看到「已截断」但不知道怎么拿，于是重试同样的调用，
 * 得到同样的截断，再重试。
 *
 * 三个要素缺一不可：给了什么、缺了多少、怎么拿。
 */
export function paginate(text: string, opts: PageOptions = {}): string {
  const { offset = 0, limit = 200, hint } = opts
  const lines = text.split('\n')
  const total = lines.length

  if (offset >= total && total > 0) {
    return `[offset=${offset} 超出范围，文件共 ${total} 行]`
  }

  const slice = lines.slice(offset, offset + limit)
  const end = offset + slice.length
  const body = slice.join('\n')

  if (end >= total && offset === 0) return body

  const nextOffset = end
  const more =
    end >= total
      ? `[第 ${offset + 1}-${end} 行，共 ${total} 行，已到末尾]`
      : `[第 ${offset + 1}-${end} 行，共 ${total} 行。` +
        `${hint ? hint(nextOffset) : `要看后面用 offset=${nextOffset}`}]`

  return `${body}\n${more}`
}

/**
 * 搜索结果只给定位信息，不给正文。
 *
 * 架构理解需要的是骨架而不是实现细节——这条判断在 L06 的 lab 三里能量出效果。
 */
export interface Hit {
  path: string
  line: number
  text: string
}

export function summarizeHits(hits: Hit[], max = 30): string {
  const shown = hits.slice(0, max)
  const lines = shown.map((h) => `${h.path}:${h.line}  ${h.text.trim().slice(0, 100)}`)
  if (hits.length > max) {
    lines.push(`[还有 ${hits.length - max} 条未显示。收窄关键词，或者直接读上面某个文件]`)
  }
  return lines.join('\n')
}
