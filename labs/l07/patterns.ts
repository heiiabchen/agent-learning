/**
 * L07 任务一：五种编排模式。
 *
 *   pnpm patterns
 *
 * 不调 API——用的是假模型。参考实现在 shared/patterns.ts。
 *
 * 这五个函数看起来差别很大，但它们只在回答同一个问题：**谁决定下一步。**
 * 写的时候留意这条轴，你会发现代码结构在跟着自主性一起变复杂。
 */

import type Anthropic from '@anthropic-ai/sdk'
import { pooled } from '../shared/resilience.ts'
import { isMain } from '../shared/entry.ts'

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

export function textOf(res: Anthropic.Message): string {
  return res.content
    .map((b) => ((b as { type: string }).type === 'text' ? (b as { text: string }).text : ''))
    .join('')
}

// ─────────────────────────────────────────────────────────────
// TODO 1：链式
//
// 依次跑每一步，上一步的输出是下一步的输入。
//
// ★ 必须实现「关口」：每步之后可以判断要不要继续。
//
// 没有关口的链会把垃圾一路传到底，然后你在最后一步看到一个荒谬的结果，
// 得回头一步步查是哪里坏的。有关口的链在坏掉的那一步就停，而且报出步名。
//
// ★ 中止时要 return 而不是 throw。上游需要知道「走到哪一步停的」和
// 「已经产出了什么」——抛异常只留一个栈，而栈里没有业务信息。
//
// 空链要抛异常，不能静默返回输入（那通常是配置读错了）。
// ─────────────────────────────────────────────────────────────

export interface ChainStep {
  name: string
  prompt: (input: string) => string
  system?: string
  /** 返回 true 继续；返回 false 或字符串则中止，字符串作为原因。 */
  gate?: (output: string) => boolean | string
}

export interface ChainResult {
  output: string
  usage: Usage
  path: string[]
  stoppedAt?: string
  gateMessage?: string
}

export async function chain(input: string, steps: ChainStep[], call: Call): Promise<ChainResult> {
  void input
  void steps
  void call
  throw new Error('TODO: 实现 chain')
}

// ─────────────────────────────────────────────────────────────
// TODO 2：路由
//
// 先让模型分类，再把请求交给对应的处理函数。
//
// 实践中投入产出比最高的一个模式——它让你用便宜模型接住八成流量，
// 而这八成本来在付强模型的钱。
//
// ★ 两个必须做的事：
//
// 一 · **不能相信模型给的标签。** 它会输出 "billing "（带空格）、"Billing"、
//      "billing/技术支持"、或者一整句解释。必须在枚举里查，查不到走兜底。
//
// 二 · **兜底不能是"随便挑一个"。** 分类不确定意味着这条输入是边缘情况，
//      而边缘情况恰恰最需要强能力。所以兜底应该指向**能力最强**的那条，
//      不是最便宜的那条。这一条和直觉相反，但线上事故都长这样。
//
// 分类那次调用记得 temperature=0（要确定性，而且低温让结果可缓存）
// 和一个很小的 maxTokens（给大额度它就开始解释）。
//
// fellBack 要返回出去——它是"分类器该不该重训"的唯一信号。
// ─────────────────────────────────────────────────────────────

export interface Route<T extends string> {
  id: T
  when: string
  handle: (input: string, call: Call) => Promise<string>
}

export interface RouteResult<T extends string> {
  picked: T
  output: string
  usage: Usage
  raw: string
  fellBack: boolean
}

export async function route<T extends string>(
  input: string,
  routes: Route<T>[],
  call: Call,
  opts: { fallback: T; classifierSystem?: string },
): Promise<RouteResult<T>> {
  void input
  void routes
  void call
  void opts
  throw new Error('TODO: 实现 route')
}

// ─────────────────────────────────────────────────────────────
// TODO 3：并行 + 投票
//
// 两种用法差别很大，别混：
//   分片 —— 把一件事拆成互不相干的几块，各做一块，最后拼起来
//   投票 —— 同一件事做 N 次，取多数
//
// ★ 用 allSettled 语义而不是 all：一个分片失败不该让整批白跑。
// 直接用 L00 写的 pooled（已经 import 了），它返回的就是 settled 结果。
//
// ★ vote 要返回 confidence 而不只是 winner。
// 3:2 和 5:0 是完全不同的结论，只返回 winner 会把这个差别抹掉。
//
// 还有一条必须理解的前提：**投票只在错误互相独立时有效。**
// temperature=0 跑 5 次，5 个输出高度一致——包括错的时候也一致。
// 这时候投票纯属把成本乘以 5 而不改变任何结果。
// ─────────────────────────────────────────────────────────────

export interface ParallelResult {
  outputs: (string | null)[]
  usage: Usage
  failed: { index: number; reason: string }[]
}

export async function parallel(
  prompts: string[],
  call: Call,
  opts: { concurrency?: number; system?: string; temperature?: number } = {},
): Promise<ParallelResult> {
  void prompts
  void call
  void opts
  void pooled
  throw new Error('TODO: 实现 parallel')
}

export interface VoteResult<T> {
  winner: T | null
  tally: { value: T; count: number }[]
  confidence: number
}

export function vote<T>(values: (T | null)[], key?: (v: T) => string): VoteResult<T> {
  void values
  void key
  throw new Error('TODO: 实现 vote')
}

// ─────────────────────────────────────────────────────────────
// TODO 4：编排-工作者
//
// 让模型把任务拆成子任务，并行执行，再整合。
//
// 和并行的区别只有一处，但很关键：**拆法是模型定的。**
// 这一处差别把成本从"可预测"变成"不可预测"——模型可能拆成 3 个，
// 也可能拆成 40 个。所以计划必须校验。
//
// ★ 三条校验缺一不可：
//   非空     —— 空计划要抛错，不能静默降级成"直接做整个任务"
//   有上限   —— 40 个子任务意味着 40 次调用，这是账单事故
//   去重     —— 模型很爱把同一件事换个说法列两遍
//
// 第一条尤其重要：静默降级会把一次编排失败伪装成正常运行，
// 你在监控里看不到，只看到质量莫名变差。
//
// 解析每行时记得剥掉模型爱加的编号和符号（`1.` `-` `*` `·` `、`）。
// ─────────────────────────────────────────────────────────────

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
  void task
  void call
  void opts
  throw new Error('TODO: 实现 orchestrate')
}

// ─────────────────────────────────────────────────────────────
// TODO 5：评估-优化
//
// 生成一版，评审，按意见改，直到够好或者停滞。
//
// ★ 这个模式有一个特有的失控方式，而且它不报错：**无限打磨。**
//
// 评估者永远能挑出毛病（"还可以更清晰一点"），于是循环不停，
// 而每一轮的实际改进趋近于零。所以必须有两道闸：
//
//   轮数上限   —— 硬闸
//   改进检测   —— 软闸，分数不再上升就停
//
// 只有轮数上限是不够的：那样你每次都跑满 maxRounds，白付 80% 的钱。
//
// ★ 还要保留历史最优，而不是无脑接受最后一版。
// 打磨会让结果变差——这在实践中比想象的常见，而只留最后一版会把它藏起来。
//
// history（每轮分数）必须返回：它是唯一能看出"有没有在原地打转"的东西。
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
  history: number[]
  reason: 'target_reached' | 'no_improvement' | 'round_limit'
}

export async function refine(
  task: string,
  call: Call,
  opts: {
    critique: (draft: string, call: Call) => Promise<Critique>
    maxRounds?: number
    targetScore?: number
    minGain?: number
    system?: string
  },
): Promise<RefineResult> {
  void task
  void call
  void opts
  throw new Error('TODO: 实现 refine')
}

// ─────────────────────────────────────────────────────────────
// TODO 6：把选型判据写成代码
//
// ★ 顺序是刻意的：**从最不自主的开始试，够用就停。**
//
// 因为自主性不是免费的功能，是你为"不知道该怎么做"付的钱。
// 知道该怎么做还用 agent，等于每次运行都花 token 重新发现一遍自己的流程图。
//
// 有一条容易放错位置：errorCost === 'high' 的判断要放在 agent 之前。
// 错误代价高的时候，「能自己想办法」是缺点而不是优点。
// ─────────────────────────────────────────────────────────────

export interface Shape {
  stepsKnown: boolean
  independent: boolean
  needsBranching: boolean
  hasQualityBar: boolean
  errorCost: 'low' | 'high'
}

export type Pattern = 'single' | 'chain' | 'route' | 'parallel' | 'orchestrate' | 'refine' | 'agent'

export interface Choice {
  pattern: Pattern
  why: string
}

export function choosePattern(s: Shape): Choice {
  void s
  throw new Error('TODO: 实现 choosePattern')
}

// ─────────────────────────────────────────────────────────────
// 观察实验
// ─────────────────────────────────────────────────────────────

/** 一个极简假模型：按关键词决定回什么。不用 shared/fake.ts 是因为这里要按内容分支。 */
function scripted(reply: (prompt: string) => string, usage = { input: 200, output: 60 }): Call {
  return async (messages) => {
    const last = messages[messages.length - 1]!
    const text = typeof last.content === 'string'
      ? last.content
      : last.content.map((b) => ((b as { type: string }).type === 'text' ? (b as { text: string }).text : '')).join('')
    return {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-v4-flash',
      content: [{ type: 'text', text: reply(text), citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: null,
      },
    } as unknown as Anthropic.Message
  }
}

async function demoChain() {
  console.log('\n【一】链式：关口在哪一步拦下来')

  const steps: ChainStep[] = [
    { name: '提取要点', prompt: (s) => `提取要点：${s}` },
    {
      name: '检查完整性',
      prompt: (s) => `检查这份要点有没有遗漏：${s}`,
      gate: (out) => (out.includes('不完整') ? '要点不完整，后面的翻译没有意义' : true),
    },
    { name: '翻译', prompt: (s) => `翻译成英文：${s}` },
  ]

  const good = await chain('一份正常的会议记录', steps, scripted((p) => (p.startsWith('检查') ? '完整' : '处理后的内容')))
  console.log(`  正常：走完 ${good.path.length} 步（${good.path.join(' → ')}）`)

  const bad = await chain('一份残缺的会议记录', steps, scripted((p) => (p.startsWith('检查') ? '不完整' : '处理后的内容')))
  console.log(`  异常：停在「${bad.stoppedAt}」，原因是「${bad.gateMessage}」`)
  console.log(`        只花了 ${bad.usage.calls} 次调用，第三步没白跑`)

  console.log('\n  没有关口的话，第二步发现的问题会被第三步无声地吃掉，')
  console.log('  你最后拿到一份"翻译得很流畅的残缺要点"——而且不知道是哪坏的。')
}

async function demoRoute() {
  console.log('\n【二】路由：模型给的标签不能直接用')

  const routes: Route<'billing' | 'tech' | 'general'>[] = [
    { id: 'billing', when: '账单、付款、退款、发票相关', handle: async () => '（便宜模型处理账单）' },
    { id: 'tech', when: '报错、功能不工作、性能问题', handle: async () => '（强模型处理技术问题）' },
    { id: 'general', when: '其他一切，以及分不清的情况', handle: async () => '（强模型兜底）' },
  ]

  const cases: [string, string][] = [
    ['干净的标签', 'billing'],
    ['带空格和大写', '  Billing '],
    ['包在句子里', '这个应该归到 tech 类'],
    ['自作聪明的解释', '我认为这是一个关于产品定价策略的复杂问题，需要综合判断'],
    ['编了一个不存在的类', 'refund'],
  ]

  for (const [label, raw] of cases) {
    const r = await route('我的信用卡被扣了两次', routes, scripted(() => raw), { fallback: 'general' })
    const mark = r.fellBack ? '兜底' : '命中'
    console.log(`  ${label.padEnd(14)} 模型给「${raw.trim().slice(0, 20)}」→ ${mark} ${r.picked}`)
  }

  console.log('\n  最后两行是重点：模型给的东西不在枚举里时，兜底指向 general（强模型）')
  console.log('  而不是随便挑一个。分不清的输入恰恰最需要强能力。')
}

async function demoVote() {
  console.log('\n【三】投票：温度为 0 的时候它不做任何事')

  const cold = ['A', 'A', 'A', 'A', 'A']
  const warm = ['A', 'B', 'A', 'A', 'C']

  for (const [label, xs] of [['T=0（输出一致）', cold], ['T=1（输出有分歧）', warm]] as const) {
    const v = vote(xs)
    console.log(
      `  ${label.padEnd(18)} 胜者 ${v.winner} · 置信度 ${(v.confidence * 100).toFixed(0)}% · ` +
        `分布 ${v.tally.map((t) => `${t.value}×${t.count}`).join(' ')}`,
    )
  }

  console.log('\n  上面那行：五次调用得到一个 100% 的置信度，看起来很棒。')
  console.log('  但它是假的——五次跑的是同一条路径，错的时候也会一致错。')
  console.log('  **投票只在错误互相独立时有效。** 要么调温度，要么换 prompt，要么换模型。')
}

async function demoRefine() {
  console.log('\n【四】评估-优化：停滞检测省下的钱')

  // 分数序列：0.5 → 0.62 → 0.63 → 0.63 ……典型的"打磨到边际为零"
  const scores = [0.5, 0.62, 0.63, 0.63, 0.63]
  let i = 0
  const critique = async () => ({ score: scores[Math.min(i++, scores.length - 1)]!, feedback: '再清晰一点' })

  const withGate = await refine('写一段产品说明', scripted(() => '第 N 版内容'), {
    critique,
    maxRounds: 5,
    targetScore: 0.9,
    minGain: 0.05,
  })

  i = 0
  const noGate = await refine('写一段产品说明', scripted(() => '第 N 版内容'), {
    critique,
    maxRounds: 5,
    targetScore: 0.9,
    minGain: 0, // 关掉停滞检测
  })

  console.log(`  有停滞检测：${withGate.rounds} 轮 · ${withGate.usage.calls} 次调用 · 因为「${withGate.reason}」停`)
  console.log(`  没停滞检测：${noGate.rounds} 轮 · ${noGate.usage.calls} 次调用 · 因为「${noGate.reason}」停`)
  console.log(`  两者最终分数都是 ${withGate.score.toFixed(2)}——多花的钱一分没换到质量。`)
  console.log(`  分数轨迹：${noGate.history.map((s) => s.toFixed(2)).join(' → ')}`)

  console.log('\n  只有轮数上限、没有改进检测的话，你每次都跑满 maxRounds。')
  console.log('  而 targetScore 定得稍微高一点（很常见），就等于每次都跑满。')
}

function demoChoose() {
  console.log('\n【五】选型：同一个判据函数跑一遍真实需求')

  const cases: [string, Shape][] = [
    ['把周报翻译成英文并润色', { stepsKnown: true, independent: false, needsBranching: false, hasQualityBar: false, errorCost: 'low' }],
    ['给 200 条评论各打一个情感标签', { stepsKnown: true, independent: true, needsBranching: false, hasQualityBar: false, errorCost: 'low' }],
    ['客服工单分派到三个队列', { stepsKnown: true, independent: false, needsBranching: true, hasQualityBar: false, errorCost: 'low' }],
    ['写一份季度竞品分析', { stepsKnown: false, independent: true, needsBranching: false, hasQualityBar: true, errorCost: 'low' }],
    ['自动生成并执行数据库迁移', { stepsKnown: false, independent: false, needsBranching: true, hasQualityBar: true, errorCost: 'high' }],
    ['修一个你还没定位的 bug', { stepsKnown: false, independent: false, needsBranching: true, hasQualityBar: false, errorCost: 'low' }],
  ]

  for (const [need, shape] of cases) {
    const c = choosePattern(shape)
    console.log(`  ${need.padEnd(24)} → ${c.pattern.padEnd(12)} ${c.why}`)
  }

  console.log('\n  只有最后一行是 agent。这个比例大致就是实际项目里的比例。')
}

// ─────────────────────────────────────────────────────────────
// TODO 7：改一个输入，看判据怎么变
//
// 把「自动生成并执行数据库迁移」的 errorCost 从 'high' 改成 'low'，
// 重新跑【五】。结论变成什么了？
//
// 然后回答：为什么 errorCost 的判断要放在 agent 之前而不是之后？
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log('五种编排模式。不调 API。')
  await demoChain()
  await demoRoute()
  await demoVote()
  await demoRefine()
  demoChoose()
  console.log('\n' + '─'.repeat(60))
  console.log('接着跑 pnpm compare，量一次 workflow 和 agent 的成本差别。')
  console.log('别忘了 TODO 7。')
}

// verify.ts 会 import 这个文件来测你写的函数。不加这道判断的话，
// import 的那一刻观察实验就跑起来了，verify 的输出会变成第一个 TODO
// 的堆栈，而不是一张「还有哪些没写」的清单。
if (isMain(import.meta.url)) await main()
