/**
 * 参考实现：五种编排模式。
 *
 * 这五个函数看起来差别很大，但它们只在回答同一个问题：**谁决定下一步。**
 *
 *   chain      你决定全部。模型只填内容
 *   route      模型决定一次（走哪条），之后你决定
 *   parallel   你决定拆法，模型并行填叶子
 *   orchestrate 模型决定拆法，你决定怎么执行和合并
 *   refine     模型决定什么时候停
 *
 * 自主性从上到下递增，而**成本方差和调试难度跟着一起涨**。
 * 这个排序就是选型判据本身：从上往下挑，够用就停。
 */

import type Anthropic from '@anthropic-ai/sdk'
import { pooled } from './resilience.ts'

/** 一次模型调用。抽象成类型，让 verify 能塞假模型——和 runAgent 同一个模式。 */
export type Call = (
  messages: Anthropic.MessageParam[],
  opts?: { system?: string; maxTokens?: number; temperature?: number },
) => Promise<Anthropic.Message>

export interface Usage {
  input: number
  output: number
  calls: number
}

export const zeroUsage = (): Usage => ({ input: 0, output: 0, calls: 0 })

export function addUsage(a: Usage, res: Anthropic.Message): Usage {
  return {
    input: a.input + res.usage.input_tokens,
    output: a.output + res.usage.output_tokens,
    calls: a.calls + 1,
  }
}

function textOf(res: Anthropic.Message): string {
  return res.content
    .map((b) => ((b as { type: string }).type === 'text' ? (b as { text: string }).text : ''))
    .join('')
}

// ─────────────────────────────────────────────────────────────
// 一、链式：你决定全部
// ─────────────────────────────────────────────────────────────

export interface ChainStep {
  name: string
  /** 上一步的输出进来，这一步的 prompt 出去。 */
  prompt: (input: string) => string
  system?: string
  /**
   * 关口。返回 false 就中止整条链。
   *
   * ★ 这是链式模式最容易漏的一件事。没有关口的链会把垃圾一路传到底，
   * 然后你在最后一步看到一个荒谬的结果，得回头一步步查是哪里坏的。
   * 有关口的链在坏掉的那一步就停，而且报出步名。
   */
  gate?: (output: string) => boolean | string
}

export interface ChainResult {
  output: string
  usage: Usage
  /** 走完的步骤名。中止时它比 output 有用得多。 */
  path: string[]
  stoppedAt?: string
  gateMessage?: string
}

export async function chain(
  input: string,
  steps: ChainStep[],
  call: Call,
): Promise<ChainResult> {
  if (steps.length === 0) throw new Error('链是空的。这通常是配置读错了，不该静默返回输入')

  let cur = input
  let usage = zeroUsage()
  const path: string[] = []

  for (const step of steps) {
    const res = await call([{ role: 'user', content: step.prompt(cur) }], { system: step.system })
    usage = addUsage(usage, res)
    cur = textOf(res)
    path.push(step.name)

    const verdict = step.gate?.(cur)
    if (verdict !== undefined && verdict !== true) {
      // 中止时**返回**而不是抛异常：上游要拿到已经走完的部分和停在哪一步。
      // 抛异常会把这些信息丢掉，只留一个栈——而栈里没有业务信息。
      return {
        output: cur,
        usage,
        path,
        stoppedAt: step.name,
        gateMessage: typeof verdict === 'string' ? verdict : `${step.name} 的关口没通过`,
      }
    }
  }

  return { output: cur, usage, path }
}

// ─────────────────────────────────────────────────────────────
// 二、路由：模型决定一次
// ─────────────────────────────────────────────────────────────

export interface Route<T extends string> {
  id: T
  /** 给模型看的描述。它是分类准确率的唯一决定因素。 */
  when: string
  handle: (input: string, call: Call) => Promise<string>
}

export interface RouteResult<T extends string> {
  picked: T
  output: string
  usage: Usage
  /** 模型给的原始标签。和 picked 不一致说明兜底生效了，这条要进日志。 */
  raw: string
  fellBack: boolean
}

/**
 * 路由。实践中投入产出比最高的一个模式——
 * 它让你用便宜模型接住八成流量，而这八成本来在付强模型的钱。
 *
 * ★ 两个必须做的事：
 *
 * 一 · **不能相信模型给的标签。** 它会输出 "billing "（带空格）、"Billing"、
 *      "billing/技术支持"、或者一整句解释。必须在枚举里查，查不到走兜底。
 *
 * 二 · **兜底不能是"随便挑一个"。** 分类不确定意味着这条输入是边缘情况，
 *      而边缘情况恰恰是最需要强能力的。所以兜底应该指向**能力最强**的那条，
 *      不是最便宜的那条。这一条和直觉相反，但线上事故都长这样。
 */
export async function route<T extends string>(
  input: string,
  routes: Route<T>[],
  call: Call,
  opts: { fallback: T; classifierSystem?: string } = { fallback: routes[0]!.id },
): Promise<RouteResult<T>> {
  if (routes.length === 0) throw new Error('没有可选路由')

  const menu = routes.map((r) => `- ${r.id}：${r.when}`).join('\n')
  const res = await call(
    [
      {
        role: 'user',
        content: `把下面的请求归到一类，只输出类别 id，不要任何别的内容。

可选类别：
${menu}

请求：
${input}`,
      },
    ],
    {
      system: opts.classifierSystem,
      // 分类要的是确定性，不是创造力。而且低温让路由结果可缓存。
      temperature: 0,
      // 只需要一个标签。给大额度只会让它开始解释。
      maxTokens: 16,
    },
  )

  const raw = textOf(res).trim()
  // 宽松匹配：模型很爱加标点、大小写不一致、或者把 id 包在句子里。
  // 但宽松只能到"在已知枚举里找"这一步，不能到"猜一个"。
  const norm = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  const hit = routes.find((r) => r.id.toLowerCase() === norm)
    ?? routes.find((r) => norm.includes(r.id.toLowerCase()))

  const picked = hit?.id ?? opts.fallback
  const target = routes.find((r) => r.id === picked)
  if (!target) throw new Error(`兜底路由 ${opts.fallback} 不在 routes 里。这是配置 bug`)

  const output = await target.handle(input, call)

  return {
    picked,
    output,
    usage: addUsage(zeroUsage(), res),
    raw,
    fellBack: !hit,
  }
}

// ─────────────────────────────────────────────────────────────
// 三、并行：你决定拆法
// ─────────────────────────────────────────────────────────────

export interface ParallelResult {
  outputs: (string | null)[]
  usage: Usage
  failed: { index: number; reason: string }[]
}

/**
 * 并行。两种用法差别很大，别混：
 *
 *   分片（sectioning）—— 把一件事拆成互不相干的几块，各做一块，最后拼起来
 *   投票（voting）    —— 同一件事做 N 次，取多数
 *
 * ★ 用 allSettled 语义而不是 all：一个分片失败不该让整批白跑。
 * 这是 L00 那个 pooled 存在的理由，在这里第一次真正用上。
 */
export async function parallel(
  prompts: string[],
  call: Call,
  opts: { concurrency?: number; system?: string; temperature?: number } = {},
): Promise<ParallelResult> {
  const { concurrency = 4, system, temperature } = opts
  const settled = await pooled(prompts, concurrency, async (p) =>
    call([{ role: 'user', content: p }], { system, temperature }),
  )

  let usage = zeroUsage()
  const outputs: (string | null)[] = []
  const failed: { index: number; reason: string }[] = []

  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      usage = addUsage(usage, r.value)
      outputs.push(textOf(r.value))
    } else {
      outputs.push(null)
      failed.push({ index: i, reason: String((r.reason as Error)?.message ?? r.reason) })
    }
  })

  return { outputs, usage, failed }
}

export interface VoteResult<T> {
  winner: T | null
  tally: { value: T; count: number }[]
  /** 得票占比。低于 0.5 意味着"多数"其实是少数，调用方该当成低置信度处理。 */
  confidence: number
}

/**
 * 投票。
 *
 * ★ 一条必须理解的前提：**投票只在错误互相独立时有效。**
 *
 * temperature=0 跑 5 次，5 个输出高度一致——包括错的时候也一致。
 * 这时候投票纯属把成本乘以 5 而不改变任何结果。
 * 要让投票有意义，必须引入独立性：调高温度，或者用不同的 prompt / 不同的模型。
 *
 * 这也是为什么这个函数返回 confidence 而不只是 winner：
 * 3:2 和 5:0 是完全不同的结论，只返回 winner 会把这个差别抹掉。
 */
export function vote<T>(values: (T | null)[], key: (v: T) => string = (v) => JSON.stringify(v)): VoteResult<T> {
  const buckets = new Map<string, { value: T; count: number }>()
  let total = 0

  for (const v of values) {
    if (v === null || v === undefined) continue
    total++
    const k = key(v)
    const b = buckets.get(k)
    if (b) b.count++
    else buckets.set(k, { value: v, count: 1 })
  }

  const tally = [...buckets.values()].sort((a, b) => b.count - a.count)
  const top = tally[0]

  return {
    winner: top?.value ?? null,
    tally,
    confidence: top && total > 0 ? top.count / total : 0,
  }
}

// ─────────────────────────────────────────────────────────────
// 四、编排-工作者：模型决定拆法
// ─────────────────────────────────────────────────────────────

export interface Plan {
  subtasks: string[]
}

export interface OrchestrateResult {
  plan: string[]
  output: string
  usage: Usage
  failed: { index: number; reason: string }[]
}

export class PlanError extends Error {
  constructor(msg: string, readonly raw: string) {
    super(msg)
    this.name = 'PlanError'
  }
}

/**
 * 编排-工作者。和并行的区别只有一处，但很关键：**拆法是模型定的。**
 *
 * 这一处差别把成本从"可预测"变成"不可预测"——模型可能拆成 3 个子任务，
 * 也可能拆成 40 个。所以计划必须校验。
 *
 * ★ 三条校验缺一不可：
 *   非空     —— 空计划要报错，不能静默返回原任务
 *   有上限   —— 40 个子任务意味着 40 次调用，这是账单事故
 *   去重     —— 模型很爱把同一件事换个说法列两遍
 */
export async function orchestrate(
  task: string,
  call: Call,
  opts: {
    worker: (subtask: string, call: Call) => Promise<string>
    maxSubtasks?: number
    concurrency?: number
    system?: string
  },
): Promise<OrchestrateResult> {
  const { worker, maxSubtasks = 8, concurrency = 4, system } = opts

  const planRes = await call(
    [
      {
        role: 'user',
        content: `把下面的任务拆成互相独立的子任务，每行一个，最多 ${maxSubtasks} 个。
只输出子任务列表，不要编号、不要解释、不要空行。
每个子任务必须能独立完成，不依赖其他子任务的结果。

任务：${task}`,
      },
    ],
    { system, temperature: 0 },
  )

  let usage = addUsage(zeroUsage(), planRes)
  const raw = textOf(planRes)

  const seen = new Set<string>()
  const subtasks: string[] = []
  for (const line of raw.split('\n')) {
    const t = line.replace(/^[\s\-*·\d.、)]+/, '').trim()
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    subtasks.push(t)
  }

  if (subtasks.length === 0) {
    // 静默降级成"直接做整个任务"是很诱人的，但那会把一个编排失败
    // 伪装成一次正常运行——你在监控里看不到，只看到质量莫名变差。
    throw new PlanError('模型没给出任何子任务。空计划要响一声，不能静默降级', raw)
  }
  if (subtasks.length > maxSubtasks) {
    throw new PlanError(
      `模型拆出了 ${subtasks.length} 个子任务，超过上限 ${maxSubtasks}。` +
        '不设上限的编排是账单事故——每个子任务都是一次调用',
      raw,
    )
  }

  const settled = await pooled(subtasks, concurrency, async (s) => worker(s, call))
  const failed: { index: number; reason: string }[] = []
  const parts: string[] = []

  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') parts.push(`## ${subtasks[i]}\n${r.value}`)
    else failed.push({ index: i, reason: String((r.reason as Error)?.message ?? r.reason) })
  })

  if (parts.length === 0) {
    throw new Error(`全部 ${subtasks.length} 个子任务都失败了。先去看 failed 里的原因`)
  }

  const synth = await call(
    [
      {
        role: 'user',
        content: `下面是几个子任务的结果。把它们整合成一份连贯的回答，去掉重复，保留所有具体事实。
${failed.length > 0 ? `\n注意：有 ${failed.length} 个子任务失败了，整合时要说明哪部分缺失。\n` : ''}
${parts.join('\n\n')}`,
      },
    ],
    { system },
  )
  usage = addUsage(usage, synth)

  return { plan: subtasks, output: textOf(synth), usage, failed }
}

// ─────────────────────────────────────────────────────────────
// 五、评估-优化：模型决定什么时候停
// ─────────────────────────────────────────────────────────────

export interface Critique {
  score: number
  feedback: string
}

export interface RefineResult {
  output: string
  score: number
  rounds: number
  usage: Usage
  /** 每轮的分数。它是这个模式唯一能看出"有没有在原地打转"的东西。 */
  history: number[]
  reason: 'target_reached' | 'no_improvement' | 'round_limit'
}

/**
 * 评估-优化。自主性最高的非 agent 模式：**模型自己判断够不够好。**
 *
 * ★ 这个模式有一个特有的失控方式，而且它不报错：**无限打磨。**
 *
 * 评估者永远能挑出毛病（"还可以更清晰一点"），于是循环不停，
 * 而每一轮的实际改进趋近于零。所以必须有两道闸：
 *
 *   轮数上限     —— 硬闸
 *   改进检测     —— 软闸，分数不再上升就停
 *
 * 只有轮数上限是不够的：那样你每次都跑满 maxRounds，白付 80% 的钱。
 *
 * ★ 还有一个更隐蔽的问题：**生成者和评估者是同一个模型时，盲点是相关的。**
 * 它看不见的错误，换个角色也看不见。自我评估会收敛到自我满意，
 * 而不是收敛到正确。真要靠它把关，评估者得换模型、或者给它一份显式的检查清单。
 */
export async function refine(
  task: string,
  call: Call,
  opts: {
    critique: (draft: string, call: Call) => Promise<Critique>
    maxRounds?: number
    targetScore?: number
    /** 分数提升低于这个值就认为停滞。默认 0.05。 */
    minGain?: number
    system?: string
  },
): Promise<RefineResult> {
  const { critique, maxRounds = 3, targetScore = 0.8, minGain = 0.05, system } = opts

  let res = await call([{ role: 'user', content: task }], { system })
  let usage = addUsage(zeroUsage(), res)
  let best = textOf(res)
  let bestScore = -Infinity
  const history: number[] = []
  let rounds = 0

  for (let i = 0; i < maxRounds; i++) {
    rounds++
    const c = await critique(best, call)
    history.push(c.score)

    // ★ 保留历史最优，而不是无脑接受最后一版。
    // 打磨会让结果变差——这在实践中比想象的常见，而只留最后一版会把它藏起来。
    const improved = c.score > bestScore
    const gain = c.score - bestScore
    if (improved) bestScore = c.score

    if (c.score >= targetScore) {
      return { output: best, score: bestScore, rounds, usage, history, reason: 'target_reached' }
    }
    if (i > 0 && gain < minGain) {
      return { output: best, score: bestScore, rounds, usage, history, reason: 'no_improvement' }
    }
    if (i === maxRounds - 1) break

    const next = await call(
      [
        { role: 'user', content: task },
        { role: 'assistant', content: best },
        { role: 'user', content: `下面是对上面这版的评审意见。按意见改一版。\n\n${c.feedback}` },
      ],
      { system },
    )
    usage = addUsage(usage, next)
    const candidate = textOf(next)
    // 只有分数确认提升才换掉 best，所以这里先存起来等下一轮评分。
    best = candidate
  }

  return { output: best, score: bestScore, rounds, usage, history, reason: 'round_limit' }
}

// ─────────────────────────────────────────────────────────────
// 选型：把判据写成代码
// ─────────────────────────────────────────────────────────────

export interface Shape {
  /** 步骤能不能事先列出来。 */
  stepsKnown: boolean
  /** 子任务之间有没有依赖。 */
  independent: boolean
  /** 需不需要根据中间结果改变路径。 */
  needsBranching: boolean
  /** 质量有没有一个可判定的标准。 */
  hasQualityBar: boolean
  /** 出错的代价。high 意味着不确定性本身就是不可接受的。 */
  errorCost: 'low' | 'high'
}

export type Pattern = 'single' | 'chain' | 'route' | 'parallel' | 'orchestrate' | 'refine' | 'agent'

export interface Choice {
  pattern: Pattern
  why: string
}

/**
 * 选型判据。
 *
 * ★ 顺序是刻意的：**从最不自主的开始试，够用就停。**
 *
 * 因为自主性不是免费的功能，是你为"不知道该怎么做"付的钱。
 * 知道该怎么做还用 agent，等于每次运行都花 token 重新发现一遍自己的流程图。
 */
export function choosePattern(s: Shape): Choice {
  if (s.stepsKnown && !s.needsBranching) {
    if (s.independent) {
      return { pattern: 'parallel', why: '步骤已知且互相独立——并行既最快也最便宜' }
    }
    return { pattern: 'chain', why: '步骤已知且有依赖顺序——链式，每步之间加关口' }
  }

  if (s.needsBranching && s.stepsKnown) {
    return { pattern: 'route', why: '路径有限且已知，只是要选一条——路由。用便宜模型做分类' }
  }

  if (s.errorCost === 'high') {
    // 这一条要放在 agent 之前。高错误代价下，"能自己想办法"是缺点不是优点。
    return {
      pattern: 'refine',
      why: '错误代价高，不能接受不可预测的路径——用评估-优化把不确定性关在一个有界循环里',
    }
  }

  if (!s.stepsKnown && s.independent) {
    return { pattern: 'orchestrate', why: '拆法要模型定，但子任务独立——编排-工作者，计划必须校验' }
  }

  if (s.hasQualityBar && !s.needsBranching) {
    return { pattern: 'refine', why: '有可判定的质量标准——评估-优化，但记得加改进检测' }
  }

  return {
    pattern: 'agent',
    why: '步骤事先列不出来、需要根据中间结果改变路径——这才是 agent 真正该出场的地方',
  }
}
