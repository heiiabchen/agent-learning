/**
 * L13 的交付物：失败复盘报告。跑法 pnpm postmortem
 *
 * 这是这一节的落地件。它做的事情很具体：拿到一次失败运行的 trace，
 * 回答四个问题，**并且明确说出哪些问题这份 trace 回答不了**。
 *
 *   1. 花了多少钱          —— 从 span 算，因为 metric 算不出来
 *   2. 失败模式是什么      —— 程序能判的部分，判不了的交给人
 *   3. 这份 trace 能重放吗  —— 通常不能，而理由值得写清楚
 *   4. ★ 我的可观测性本身有没有病 —— 采样、分批、属性名
 *
 * ★ 第四条是最容易被跳过、也最重要的一条。前三条都建立在
 * "这份 trace 是完整的"这个假设上，而这一节讲的每一个失效
 * 都在攻击这个假设，且**全部不抛异常**。
 *
 * 所以报告的结构是**先判这份 trace 可不可信，再看它说了什么**。
 * 和 L12 的五道闸门同一个道理：一旦你先看了结论，你就有了立场。
 */

import { isMain } from '../shared/entry.ts'
import {
  ATTR,
  PRICES,
  agentSpanTree,
  batchByBytes,
  checkReplayability,
  classifyFailure,
  coalesceAttrs,
  costOf,
  headSample,
  loopStats,
  normalizeUsage,
  spanBytes,
  sumUsage,
  tailSample,
  traceSize,
} from '../shared/observe.ts'
import type { Message, Price, Provider, Run, Span } from '../shared/observe.ts'

export interface Incident {
  traceId: string
  spans: Span[]
  run: { ok: boolean; turns: number; ms: number }
  provider: Provider
  price: Price
  /** 这次运行的消息，用来估 trace 体积。 */
  messages: Message[]
  /** 同期的全部运行，用来判采样配置。 */
  fleet: Run[]
  /** 埋点原始属性（含双发），用来判属性名健康度。 */
  rawAttrs: Record<string, unknown>
  sampling: { mode: 'head' | 'tail'; rate: number; decisionWaitMs: number; cacheSize: number }
}

export interface Postmortem {
  /** ★ 这份 trace 本身可不可信。先看这个。 */
  trustworthy: boolean
  telemetryDefects: string[]
  /** 能重放吗，以及为什么不能。 */
  replay: { ok: boolean; reasons: string[] }
  /** 程序判出来的失败模式。 */
  failures: { code: string; name: string; evidence: string }[]
  /** 花了多少钱，以及从 metric 算会错多少。 */
  cost: { fromSpans: number; fromMetrics: number; errorPct: number }
  /** 交给人的部分。 */
  forHumans: string[]
}

export function postmortem(inc: Incident): Postmortem {
  const telemetryDefects: string[] = []

  // ── 第一步：这份 trace 可不可信 ──────────────────────────
  // ★ 顺序是刻意的。先判可信度，再看内容。

  // 1a 属性名：双发会让花费翻倍，而两个数字各自都对
  const c = coalesceAttrs(inc.rawAttrs)
  if (c.dualEmit.length > 0) {
    telemetryDefects.push(
      `埋点处在双发过渡期（${c.dualEmit.length} 对新旧键）。` +
        '任何 SUM(旧键) + SUM(新键) 的看板会把花费翻一倍——而两个数字各自都是对的',
    )
  }
  for (const x of c.conflicts) telemetryDefects.push(`★ ${x}`)

  // 1b 采样：这次事故的同类运行，有多少根本没被记下来
  if (inc.sampling.mode === 'head') {
    const h = headSample(inc.fleet, inc.sampling.rate)
    telemetryDefects.push(
      `★ 用的是 head 采样 @${(inc.sampling.rate * 100).toFixed(0)}%，失败召回只有 ` +
        `${(h.failureRecall * 100).toFixed(0)}%——和成功的保留率一样。` +
        '你正在看的这条是运气好留下来的，同类事故还有 ' +
        `${Math.round(inc.fleet.filter((r) => !r.ok).length * (1 - h.failureRecall))} 次没有任何记录`,
    )
  } else {
    const t = tailSample(inc.fleet, {
      decisionWaitMs: inc.sampling.decisionWaitMs,
      numTraces: 50_000,
      decisionCacheSize: inc.sampling.cacheSize,
      keep: (r) => !r.ok,
    })
    for (const p of t.problems) telemetryDefects.push(p)
    if (inc.run.ms > inc.sampling.decisionWaitMs) {
      telemetryDefects.push(
        `★ 这次运行跑了 ${(inc.run.ms / 1000).toFixed(0)} 秒，而 decision_wait 是 ` +
          `${inc.sampling.decisionWaitMs / 1000} 秒。采样决策是在第 ` +
          `${inc.sampling.decisionWaitMs / 1000} 秒做的——那时候它还没失败。` +
          '你现在看到的可能是一条被截断的轨迹，而它长得**像一条完整的短 trace**',
      )
    }
  }

  // 1c 分批：这次运行的 span 会不会被 4 MiB 那道墙吃掉
  const b = batchByBytes(inc.spans)
  for (const p of b.problems) telemetryDefects.push(p)
  const totalMiB = inc.spans.reduce((s, x) => s + spanBytes(x), 0) / 1024 / 1024
  if (totalMiB > 4) {
    telemetryDefects.push(
      `★ 这次运行的 span 共 ${totalMiB.toFixed(1)} MiB，按条数分批会超过 OTLP 的 4 MiB 上限，` +
        '而那是**不可重试**的错误。整批会消失，连带无关的 span',
    )
  }

  // 1d 体积：二次方增长意味着最该看的运行最贵
  const ts = traceSize(inc.messages, inc.run.turns)
  if (ts.ratio > 5) {
    telemetryDefects.push(
      `trace 体积 ${(ts.storedBytes / 1024).toFixed(0)} KB，去重后只有 ` +
        `${(ts.dedupedBytes / 1024).toFixed(0)} KB（${ts.ratio.toFixed(1)}x 冗余）。` +
        'k(k+1)/2 的增长意味着**最长的运行也是最贵的**——而它们正是你最需要留的',
    )
  }

  // ★ 判定：只要采样或分批有缺陷，这份 trace 就不能当成"完整记录"来读
  const trustworthy = !telemetryDefects.some((d) => d.startsWith('★'))

  // ── 第二步：能重放吗 ────────────────────────────────────
  const rep = checkReplayability(inc.spans)
  const reasons = [...rep.blockers, ...rep.warnings]

  // ── 第三步：程序能判出什么 ──────────────────────────────
  const failures = classifyFailure(inc.spans, inc.run)

  // ── 第四步：花了多少钱 ─────────────────────────────────
  const sum = sumUsage(inc.spans)
  for (const p of sum.problems) telemetryDefects.push(p)
  // 从 span 逐条算，因为缓存维度只存在于 span 上
  let fromSpans = 0
  let fromMetrics = 0
  for (const s of inc.spans) {
    const i = Number(s.attrs[ATTR.inputTokens] ?? 0)
    if (i === 0) continue
    const u = {
      inputTokens: i,
      outputTokens: Number(s.attrs[ATTR.outputTokens] ?? 0),
      cacheRead: Number(s.attrs[ATTR.cacheRead] ?? 0),
      cacheWrite5m: Number(s.attrs[ATTR.cacheWrite] ?? 0),
      cacheWrite1h: 0,
      reasoning: Number(s.attrs[ATTR.reasoningTokens] ?? 0),
      freshInput: Math.max(
        0,
        i - Number(s.attrs[ATTR.cacheRead] ?? 0) - Number(s.attrs[ATTR.cacheWrite] ?? 0),
      ),
      problems: [],
    }
    const cb = costOf(u, inc.price)
    fromSpans += cb.total
    fromMetrics += cb.naiveTotal
  }

  // ── 第五步：明确交给人的部分 ────────────────────────────
  // ★ 这一段的存在本身就是主张：不要假装程序能判完。
  const forHumans: string[] = []
  if (failures.length === 0 && !inc.run.ok) {
    forHumans.push(
      '★ 运行失败了，但没有一条程序规则命中。这**不是**"没有失败模式"，' +
        '是你的分类学还没覆盖这一种。加规则之前先人工读一遍轨迹',
    )
  }
  if (failures.some((f) => f.code === 'FM-1.4')) {
    forHumans.push(
      '上下文被压缩过。压缩本身是否导致了失败，程序判不了——' +
        'TRAIL 里 Context Handling Failures 是**所有模型 F1 = 0.00** 的那一类。' +
        '需要人对比压缩前后的消息',
    )
  }
  const loop = loopStats(inc.fleet, 20)
  forHumans.push(
    `同期 loop 长度 p50 ${loop.p50} / p99 ${loop.p99} / 最长 ${loop.max} 轮，` +
      `这次是 ${inc.run.turns} 轮。` +
      (inc.run.turns > loop.p99
        ? '★ 超过了 p99，是个离群点'
        : '在正常范围内——所以问题不在循环长度上'),
  )
  forHumans.push(
    '★ 而这个 loop 长度分布来自 gen_ai.invoke_agent.inference_calls 直方图，' +
      '不依赖任何一条 trace。所以它是上面那些采样缺陷唯一影响不到的数字',
  )

  return {
    trustworthy,
    telemetryDefects,
    replay: { ok: rep.replayable, reasons },
    failures,
    cost: {
      fromSpans,
      fromMetrics,
      errorPct: fromSpans === 0 ? 0 : (fromMetrics / fromSpans - 1) * 100,
    },
    forHumans,
  }
}

// ─────────────────────────────────────────────────────────────
// 一个植了六个问题的场景
// ─────────────────────────────────────────────────────────────

export function scenario(): Incident {
  const usage = normalizeUsage('anthropic', {
    input_tokens: 300,
    output_tokens: 900,
    cache_read_input_tokens: 120_000,
    cache_creation_input_tokens: 8_000,
    cache_creation: { ephemeral_5m_input_tokens: 8_000 },
    output_tokens_details: { reasoning_tokens: 640 },
  })

  // 一次跑了 31 轮的失败运行：卡在 search 上打转，上下文被压缩过。
  // 注意别的工具各只调了一两次——所以 FM-1.3 只该在 search 上命中。
  const tools = [
    'search', 'read_file', 'search', 'search', 'write_file',
    'search', 'list_dir', 'search', 'search', 'run_tests',
    'search', 'search',
  ]
  const steps: { kind: 'chat' | 'execute_tool'; name?: string; usage?: typeof usage }[] = []
  for (const t of tools) {
    steps.push({ kind: 'chat', usage })
    steps.push({ kind: 'execute_tool', name: t })
  }
  const spans = agentSpanTree({
    agent: 'refund-handler',
    conversationId: 'conv-8821',
    model: 'claude-like',
    provider: 'anthropic',
    steps,
  })
  // 压缩发生过
  spans[0]!.attrs[ATTR.compacted] = true

  const messages: Message[] = [
    { role: 'system', content: 'S'.repeat(4000) },
    ...Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'assistant' : 'tool',
      content: `第 ${i} 步`.padEnd(900 + i * 30, '·'),
    })),
  ]

  const fleet: Run[] = Array.from({ length: 800 }, (_, i) => {
    const bad = i % 25 === 0
    return {
      traceId: `t${i}`,
      ok: !bad,
      turns: bad ? 26 + (i % 9) : 4 + (i % 6),
      ms: bad ? 200_000 + (i % 5) * 15_000 : 9_000 + (i % 13) * 800,
      tokens: bad ? 500_000 : 40_000,
    }
  })

  return {
    traceId: 'conv-8821',
    spans,
    run: { ok: false, turns: 31, ms: 244_000 },
    provider: 'anthropic',
    price: PRICES['claude-like']!,
    messages,
    fleet,
    // ★ 埋点处在双发过渡期
    rawAttrs: {
      'gen_ai.usage.prompt_tokens': 128_300,
      'gen_ai.usage.input_tokens': 128_300,
      'gen_ai.system': 'anthropic',
      'gen_ai.provider.name': 'anthropic',
    },
    // ★ tail 采样，但用的是默认的 30 秒和不启用的决策缓存
    sampling: { mode: 'tail', rate: 1, decisionWaitMs: 30_000, cacheSize: 0 },
  }
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

function render(inc: Incident, r: Postmortem) {
  console.log(bold(`\n失败复盘：${inc.traceId}`))
  console.log(
    dim(`  ${inc.run.turns} 轮 / ${(inc.run.ms / 1000).toFixed(0)} 秒 / ${inc.spans.length} 个 span / 结果：失败`),
  )

  console.log(bold('\n① 这份 trace 可不可信'))
  console.log(
    r.trustworthy
      ? green('  ✓ 没发现会让轨迹缺失的缺陷')
      : red('  ✗ 不可信。下面的结论全部建立在一份可能不完整的记录上'),
  )
  for (const d of r.telemetryDefects) {
    console.log(d.startsWith('★') ? red(`    ${d}`) : yellow(`    · ${d}`))
  }

  console.log(bold('\n② 能重放吗'))
  console.log(r.replay.ok ? green('  ✓ 能') : red('  ✗ 不能'))
  for (const x of r.replay.reasons) console.log(dim(`    · ${x}`))

  console.log(bold('\n③ 程序判出的失败模式'))
  if (r.failures.length === 0) console.log(dim('  （无）'))
  for (const f of r.failures) {
    console.log(`  ${bold(f.code)} ${f.name}`)
    console.log(dim(`    ${f.evidence}`))
  }

  console.log(bold('\n④ 成本'))
  console.log(`  从 span 算    $${r.cost.fromSpans.toFixed(4)}`)
  console.log(`  从 metric 算  $${r.cost.fromMetrics.toFixed(4)}  ${red(`偏差 +${r.cost.errorPct.toFixed(0)}%`)}`)
  console.log(dim('  ★ 偏差不是精度问题：gen_ai.token.type 只有 input/output，没有缓存维度'))

  console.log(bold('\n⑤ 交给人的部分'))
  for (const h of r.forHumans) {
    console.log(h.startsWith('★') ? yellow(`  ${h}`) : dim(`  · ${h}`))
  }
}

async function main() {
  const inc = scenario()
  const r = postmortem(inc)
  render(inc, r)

  console.log(bold('\n\n这份报告的结构本身就是这一节的主张：'))
  console.log('  ' + bold('先判这份 trace 可不可信，再看它说了什么。'))
  console.log(dim('  因为一旦你先看了结论，你就有了立场——和 L12 的五道闸门同一个道理。'))
  console.log()

  // 不可信就让 CI 红
  if (!r.trustworthy) process.exitCode = 1
}

if (isMain(import.meta.url)) await main()
