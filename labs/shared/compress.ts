/**
 * 参考实现：压缩历史（手段三）。
 *
 * 之所以是"手段三"而不是"手段一"，因为它有三个真实代价：
 * 要花一次模型调用的钱、会丢信息而且你不知道丢了什么、改写历史会毁掉 prompt 缓存。
 *
 * 所以这个模块里最重要的函数不是 compress，是 **shouldCompress**——
 * 决定「什么时候不压」比「怎么压」更省钱。
 */

import type Anthropic from '@anthropic-ai/sdk'
import { extractTag } from './parse.ts'
import { countContent, estimateTokens, inputBudget, type ContextStats } from './context.ts'

// ─────────────────────────────────────────────────────────────
// 结构化摘要
// ─────────────────────────────────────────────────────────────

export interface Summary {
  /** 原始任务，**一字不改**。目标漂移是长任务的头号失败模式 */
  goal: string
  done: string[]
  /** 发现的关键事实。文件路径、函数名、行号必须保留 */
  found: string[]
  /**
   * ★ 试过但失败的方法。
   *
   * 这一节最容易漏，而它最重要：没有它，agent 会把失败过的方法再试一遍，
   * 而且会升级成循环（试 A 失败 → 试 B 失败 → 压缩丢了 failed → 再试 A）。
   * 重复检测（L05）拦不住它，因为参数往往略有不同。
   */
  failed: string[]
  next: string
}

/**
 * 摘要 prompt。
 *
 * ★ 「总结一下前面的对话」得到的是散文，模型下一步没法用。
 * 必须给固定结构——这就是 L03 那条「结构化输出要用标签约束」的直接应用。
 */
export function summaryPrompt(): string {
  return `把上面的历史压缩成结构化摘要。严格按下面的标签输出，不要有别的内容。

<goal>原始任务，一字不改地照抄</goal>
<done>已完成的事，每条一行，带结论</done>
<found>发现的关键事实。文件路径、函数名、行号必须原样保留</found>
<failed>试过但失败的方法，每条写清楚失败原因</failed>
<next>下一步计划</next>

三条硬要求：
- <goal> 必须是原文，不要改写、不要概括
- <failed> 不能省。没有失败过就写「无」，但不要跳过这一节
- <found> 里的路径和行号是后续工作要用的，丢了就得重新查`
}

export function renderSummary(s: Summary): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '无')
  return [
    '<summary>',
    `<goal>${s.goal}</goal>`,
    `<done>\n${list(s.done)}\n</done>`,
    `<found>\n${list(s.found)}\n</found>`,
    `<failed>\n${list(s.failed)}\n</failed>`,
    `<next>${s.next}</next>`,
    '</summary>',
  ].join('\n')
}

/** 摘要没写全时要响一声——静默接受一个缺了 failed 的摘要，等于把防线关掉了。 */
export class SummaryError extends Error {
  constructor(missing: string) {
    super(`摘要里缺了 <${missing}>。缺 failed 会让 agent 重试失败过的方法，缺 goal 会让目标漂移。`)
    this.name = 'SummaryError'
  }
}

export function parseSummary(text: string): Summary {
  const goal = extractTag(text, 'goal')
  if (!goal?.trim()) throw new SummaryError('goal')
  const failed = extractTag(text, 'failed')
  if (failed === null) throw new SummaryError('failed')

  const bullets = (raw: string | null): string[] => {
    if (!raw) return []
    return raw
      .split('\n')
      .map((l) => l.replace(/^[-*·]\s*/, '').trim())
      .filter((l) => l.length > 0 && l !== '无')
  }

  return {
    goal: goal.trim(),
    done: bullets(extractTag(text, 'done')),
    found: bullets(extractTag(text, 'found')),
    failed: bullets(failed),
    next: extractTag(text, 'next')?.trim() ?? '',
  }
}

// ─────────────────────────────────────────────────────────────
// 三种策略
// ─────────────────────────────────────────────────────────────

/**
 * 滑动窗口：只留最近 keepTurns 轮。
 *
 * 最便宜（不花钱、不调模型），但最粗暴——早期的关键决定直接丢了。
 * 适合对话，不适合长任务。
 *
 * ★ 两个不变量必须守住，否则会构造出 API 拒绝的消息序列：
 * 1. 第一条（原始任务）永远保留
 * 2. 不能让一个 tool_result 失去它对应的 tool_use，也不能反过来
 */
export function slidingWindow(
  messages: Anthropic.MessageParam[],
  keepTurns = 6,
): Anthropic.MessageParam[] {
  if (messages.length <= keepTurns + 1) return messages

  const first = messages[0]!
  let cut = messages.length - keepTurns

  // 往后挪到一个安全的切点：切点处那条消息不能是携带 tool_result 的 user，
  // 否则它对应的 tool_use 被切掉了，API 会直接报错。
  while (cut < messages.length && hasToolResult(messages[cut]!)) cut++

  return [first, ...messages.slice(cut)]
}

function hasToolResult(m: Anthropic.MessageParam): boolean {
  if (typeof m.content === 'string') return false
  return m.content.some((b) => (b as { type: string }).type === 'tool_result')
}

export interface CompressResult {
  messages: Anthropic.MessageParam[]
  summary: Summary
  /** 压缩掉了多少 token（估算） */
  saved: number
  /** 压缩这一次调用花了多少 token */
  cost: { input: number; output: number }
}

export interface CompressOptions {
  /** 抽象成函数，让 verify 能塞假模型进来。和 runAgent 同一个模式 */
  call: (messages: Anthropic.MessageParam[]) => Promise<Anthropic.Message>
  /** 最近这么多条不压，保留全文。老的压狠、近的留全，就是"分层压缩" */
  keepRecent?: number
}

/**
 * 摘要压缩：让模型总结前面的历史，用结构化摘要替换。
 *
 * 返回的新消息序列是：[原始任务, 摘要, ...最近 keepRecent 条]
 */
export async function compress(
  messages: Anthropic.MessageParam[],
  opts: CompressOptions,
): Promise<CompressResult> {
  const { call, keepRecent = 4 } = opts
  if (messages.length < 3) {
    throw new Error('历史太短，没什么可压的。先检查 shouldCompress 的判断是不是有问题')
  }

  const first = messages[0]!
  let cut = Math.max(1, messages.length - keepRecent)
  while (cut < messages.length && hasToolResult(messages[cut]!)) cut++

  const toCompress = messages.slice(0, cut)
  const recent = messages.slice(cut)

  const before = toCompress.reduce((n, m) => n + countContent(m.content), 0)

  const res = await call([...toCompress, { role: 'user', content: summaryPrompt() }])
  const text = res.content
    .map((b) => ((b as { type: string }).type === 'text' ? (b as { text: string }).text : ''))
    .join('')

  const summary = parseSummary(text)
  const rendered = renderSummary(summary)

  return {
    messages: [first, { role: 'user', content: rendered }, ...recent],
    summary,
    saved: Math.max(0, before - estimateTokens(rendered) - countContent(first.content)),
    cost: { input: res.usage.input_tokens, output: res.usage.output_tokens },
  }
}

// ─────────────────────────────────────────────────────────────
// 什么时候不压：这个模块最值钱的部分
// ─────────────────────────────────────────────────────────────

export interface CompressDecision {
  compress: boolean
  why: string
  /** 估算的净收益（token 数）。负数表示压了更贵 */
  net?: number
}

export interface DecisionInput {
  stats: ContextStats
  /** 预计还要走多少步。**这是最关键的输入** */
  stepsLeft: number
  /** 命中缓存时输入的折扣。DeepSeek 的缓存命中价约为未命中的 1/10 */
  cacheDiscount?: number
}

/**
 * 该不该压。
 *
 * ★ 只看当前长度是不够的，必须把「预计还要走多少步」算进来。
 *
 * 原因是压缩会改写历史 → 前缀变了 → **从改动点往后的 KV cache 全部作废**
 * （L05x 那条纪律）。压缩之后的那一次调用要重新 prefill 全部内容，付全价。
 *
 * 于是这笔账是：
 *   省下的 = (当前长度 - 压后长度) × 剩余步数 × 单价
 *   花掉的 = 压缩调用本身 + 一次全额 prefill（失去缓存折扣）
 *
 * **剩余步数少的时候，不压更便宜。**
 */
export function shouldCompress(input: DecisionInput): CompressDecision {
  const { stats, stepsLeft, cacheDiscount = 0.1 } = input
  const { budget } = stats
  const available = inputBudget(budget)

  const hardCeiling = stats.tokens > available * 0.9
  const overTrigger = stats.ratio > budget.compressAt

  if (!overTrigger) {
    return { compress: false, why: `还没到触发线（${pct(stats.ratio)} < ${pct(budget.compressAt)}）` }
  }

  // 快撑爆了就无条件压——这时候不是省钱问题，是能不能继续跑的问题。
  if (hardCeiling) {
    return { compress: true, why: `已到 ${pct(stats.ratio)}，撑爆的风险高于压缩的代价` }
  }

  if (stepsLeft <= 0) {
    return { compress: false, why: '没有剩余步数了，压了没人受益' }
  }

  const target = available * budget.compressTo
  const shrink = Math.max(0, stats.tokens - target)

  // 后续每一步省下的：少发 shrink 个 token。
  // 但要注意这些 token 里有一部分本来是命中缓存的，只值全价的 cacheDiscount。
  const savedPerStep = shrink * cacheDiscount
  const saved = savedPerStep * stepsLeft

  // 压缩本身要把待压部分完整发一遍（输入），再生成一段摘要（输出，量小）。
  // 更贵的是压完那一步失去缓存折扣，要按全价重新 prefill。
  const summaryCall = stats.tokens
  const lostCache = target * (1 - cacheDiscount)
  const cost = summaryCall + lostCache

  const net = saved - cost

  if (net <= 0) {
    return {
      compress: false,
      why:
        `不划算：只剩 ${stepsLeft} 步，省约 ${Math.round(saved)} tok，` +
        `但压缩加重建缓存要花约 ${Math.round(cost)} tok`,
      net,
    }
  }

  return {
    compress: true,
    why: `划算：剩 ${stepsLeft} 步，净省约 ${Math.round(net)} tok（该压 ${stats.top}）`,
    net,
  }
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}
