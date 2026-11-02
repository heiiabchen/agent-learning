/**
 * L06 任务一：上下文计量与预算分区。
 *
 *   pnpm budget
 *
 * 不调 API。写完后 pnpm verify:l06 验证。参考实现在 shared/context.ts。
 *
 * 这个任务的价值在于把「感觉快满了」换成一个能看的 breakdown。
 * 后面两个任务都依赖它——不知道该压哪块就是在瞎压。
 */

import type Anthropic from '@anthropic-ai/sdk'
import { isMain } from '../shared/entry.ts'

// ─────────────────────────────────────────────────────────────
// TODO 1：token 粗估
//
// 中日韩字符约 0.6 token，其余约 0.25 token。加一个 factor 系数供校准。
//
// ★ 为什么不用 tiktoken：**它算的是 OpenAI 的分词器，而我们用 DeepSeek。**
// 中文上的差异能到 20% 以上。那个误差的坏处不是"不准"，是**它假装准**——
// 你会基于一个精确的错数字做决策，然后在以为还有余量的时候撞上限。
//
// 一个带着已知误差的估计，比一个假装精确的错误值有用得多。
// ─────────────────────────────────────────────────────────────

export function estimateTokens(text: string, factor = 1): number {
  void text
  void factor
  throw new Error('TODO: 实现 estimateTokens')
}

// ─────────────────────────────────────────────────────────────
// TODO 2：数一条消息的 content
//
// content 可能是字符串，也可能是块数组。要处理的块类型：
//   text        → 数 text 字段
//   tool_use    → 数 name + JSON.stringify(input)
//   tool_result → 数 content（它自己也可能是字符串或块数组）
//   image/document → 估不准，给个保守的常数（宁可估高）
//   其他        → **抛异常**
//
// ★ 最常见的 bug 是 `if (typeof content === 'string')` 之后就不管别的了。
// 而 tool_use / tool_result 正是 agent 上下文里最大的那两块——
// 漏了它们，你统计的基本上只有纯文本对话，数字系统性偏小。
//
// 未知类型要响一声而不是静默跳过。静默跳过的往往正是最大的那块。
// ─────────────────────────────────────────────────────────────

export function countContent(content: Anthropic.MessageParam['content'], factor = 1): number {
  void content
  void factor
  throw new Error('TODO: 实现 countContent')
}

// ─────────────────────────────────────────────────────────────
// TODO 3：预算与分区
//
// 五个分区：system / toolDefs / task / summary / work
//
// 两个容易漏的地方：
//
// 一 · **工具定义不在 messages 里，但每一步都要发。** 十个工具的 schema
//      轻松到 2K 以上。忘了算它等于把系统区当成免费的。
//
// 二 · **ratio 要相对"可用输入额度"算，不是相对 window。**
//      128K 是输入加输出的总额。按 window 的 60% 触发压缩，实际允许输入涨到
//      76.8K，然后模型想写一份长报告就被 max_tokens 截断了。
//
// top 是占用最大的分区。「该压哪一块」的答案通常就在这里——
// 八成情况下是 work（工具结果），而那一块该用手段一（源头裁剪）处理，
// 不是拿摘要压缩去治。
// ─────────────────────────────────────────────────────────────

export type Zone = 'system' | 'toolDefs' | 'task' | 'summary' | 'work'

export interface Budget {
  window: number
  reserveOutput: number
  compressAt: number
  compressTo: number
}

export const defaultBudget: Budget = {
  window: 128_000,
  reserveOutput: 16_000,
  compressAt: 0.6,
  compressTo: 0.3,
}

export function inputBudget(b: Budget): number {
  void b
  throw new Error('TODO: 实现 inputBudget')
}

export interface ContextStats {
  tokens: number
  ratio: number
  breakdown: Record<Zone, number>
  top: Zone
  budget: Budget
}

export interface MeasureInput {
  system: string
  tools: Anthropic.Tool[]
  messages: Anthropic.MessageParam[]
  summaryTokens?: number
}

export function measure(input: MeasureInput, budget = defaultBudget, factor = 1): ContextStats {
  void input
  void budget
  void factor
  throw new Error('TODO: 实现 measure')
}

// ─────────────────────────────────────────────────────────────
// TODO 4：分页，并且在截断处给出路
//
// ★ 这是这一节最重要的一个函数。
//
// 不给出路的截断会造出死循环：模型需要后面的内容，看到「已截断」
// 但不知道还剩多少、也不知道怎么拿，于是它重试同样的调用，
// 得到同样的截断，再重试。这就是 L05 那道防线要拦的场景，根源在这里。
//
// 三个要素缺一不可：
//   给了什么   第 1-200 行
//   缺了多少   共 1240 行
//   怎么拿     用 offset=200
//
// 边界：offset 超出范围要说清楚，不要静默返回空字符串。
// ─────────────────────────────────────────────────────────────

export interface PageOptions {
  offset?: number
  limit?: number
  hint?: (nextOffset: number) => string
}

export function paginate(text: string, opts: PageOptions = {}): string {
  void text
  void opts
  throw new Error('TODO: 实现 paginate')
}

// ─────────────────────────────────────────────────────────────
// TODO 5：校准器
//
// 估算值用来做决策（决策必须在调用**之前**做），
// 服务端返回的真实 usage 用来修正系数。
//
// factor 的含义：真实 token ≈ 估算 token × factor。
// 只保留最近的样本——模型和内容分布都会变，老样本会拖累系数。
// ─────────────────────────────────────────────────────────────

export class Calibrator {
  get factor(): number {
    throw new Error('TODO: 实现 Calibrator')
  }

  get count(): number {
    throw new Error('TODO: 实现 count')
  }

  record(estimated: number, actualInputTokens: number): void {
    void estimated
    void actualInputTokens
    throw new Error('TODO: 实现 record')
  }

  get drift(): number {
    throw new Error('TODO: 实现 drift')
  }
}

// ─────────────────────────────────────────────────────────────
// 观察实验
// ─────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description:
      '读取一个文件的内容。路径必须在项目根目录内。返回前 200 行，要看后面用 offset 参数。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根目录的路径' },
        offset: { type: 'integer', description: '从第几行开始，默认 0' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: '列出一个目录下的文件和子目录。会自动折叠 node_modules、dist、.git。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description: '在代码里搜关键词。返回「文件:行号 + 一行上下文」，最多 30 条。',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, glob: { type: 'string' } },
      required: ['query'],
    },
  },
]

const SYSTEM = `你是一个代码库分析助手。

<workflow>
1. 先用 list_dir 摸清结构
2. 用 search_code 定位关键位置
3. 用 read_file 读具体实现
4. 每读完一个模块，把结论写下来
</workflow>

<rules>
- 不确定的事去查，不要猜
- 引用代码时带上文件路径和行号
- 一次只做一件事
</rules>`

/** 造一段假的 agent 历史，用来观察分区占比怎么演化 */
function fakeHistory(steps: number): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = [
    { role: 'user', content: '读懂 src/auth 这个模块，告诉我登录流程是怎么走的，有没有安全问题。' },
  ]

  for (let i = 0; i < steps; i++) {
    const id = `tu_${i}`
    msgs.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `我先看看第 ${i + 1} 个文件。` },
        {
          type: 'tool_use',
          id,
          name: 'read_file',
          input: { path: `src/auth/module${i}.ts` },
        },
      ],
    })
    // 工具结果是大头：一个 300 行文件约 3000 token
    msgs.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: 'export function handler() {\n  // 实现细节\n}\n'.repeat(120),
        },
      ],
    })
  }
  return msgs
}

function demoBreakdown() {
  console.log('\n【一】分区占比怎么演化')
  console.log('同一个 agent，跑不同步数。看 work 那一列。\n')

  for (const steps of [0, 2, 5, 10, 20]) {
    const s = measure({ system: SYSTEM, tools: TOOLS, messages: fakeHistory(steps) })
    const b = s.breakdown
    console.log(
      `  ${String(steps).padStart(2)} 步 · 共 ${String(s.tokens).padStart(6)} tok ` +
        `(${String(Math.round(s.ratio * 100)).padStart(3)}%) · ` +
        `system ${b.system} · tools ${b.toolDefs} · task ${b.task} · ` +
        `work ${String(b.work).padStart(6)} · 最大分区 ${s.top}`,
    )
  }

  console.log('\n  system / tools / task 三块是常数，work 单调增长。')
  console.log('  到 20 步时 work 占了九成以上——**这就是该动手的地方**。')
  console.log('  拿摘要压缩去治它是用错药了：源头裁剪（分页、只返回骨架）成本为零。')
}

function demoReserve() {
  console.log('\n【二】留白为什么不能省')
  console.log('同样的上下文，两种预算算法。\n')

  const messages = fakeHistory(12)
  const naive: Budget = { ...defaultBudget, reserveOutput: 0 }
  const sane = defaultBudget

  for (const [label, b] of [
    ['按总窗口算（错）', naive],
    ['减掉留白后算（对）', sane],
  ] as const) {
    const s = measure({ system: SYSTEM, tools: TOOLS, messages }, b)
    const trigger = s.ratio > b.compressAt
    console.log(
      `  ${label.padEnd(20)} 可用额度 ${inputBudget(b)} · 占比 ${Math.round(s.ratio * 100)}% · ` +
        `${trigger ? '已触发压缩' : '还没触发'}`,
    )
  }

  console.log('\n  同样的内容，一个说"还早"，一个说"该压了"。差别只在分母。')
  console.log('  按总窗口算的那个，会允许输入一直涨到模型没法写长回答为止。')
}

function demoPaginate() {
  console.log('\n【三】截断给不给出路，差别有多大')

  const file = Array.from({ length: 1240 }, (_, i) => `line ${i + 1}: some code here`).join('\n')

  console.log('\n  坏的截断（模型只能重试）：')
  console.log('    ' + file.slice(0, 60) + ' ...')
  console.log('    [内容过长，已截断]')

  console.log('\n  好的截断（模型知道下一步）：')
  const good = paginate(file, { offset: 0, limit: 3 })
  for (const line of good.split('\n')) console.log('    ' + line)

  console.log('\n  接着读下一段：')
  const next = paginate(file, { offset: 1237, limit: 5 })
  for (const line of next.split('\n')) console.log('    ' + line)

  console.log('\n  三个要素：给了什么、缺了多少、怎么拿。缺一个模型就会打转。')
}

function demoCalibrate() {
  console.log('\n【四】用真实 usage 校准估算')
  console.log('假设我们的估算系统性偏低 18%（这是 tiktoken 用错模型的典型量级）。\n')

  const cal = new Calibrator()
  const cases = [
    [1200, 1420],
    [3400, 4010],
    [8800, 10380],
    [15000, 17700],
  ] as const

  for (const [est, real] of cases) {
    cal.record(est, real)
    console.log(
      `  估 ${String(est).padStart(6)} · 实际 ${String(real).padStart(6)} · ` +
        `factor=${cal.factor.toFixed(3)} · 偏差 ${(cal.drift * 100).toFixed(1)}%`,
    )
  }

  const raw = estimateTokens('把这段中文和 some English mixed together 一起数。')
  console.log(`\n  校准前 ${raw} tok，校准后 ${estimateTokens('把这段中文和 some English mixed together 一起数。', cal.factor)} tok`)
  console.log('\n  偏差超过 15% 就该去看估算函数本身要不要改了。')
  console.log('  重点不是把误差消掉，是**知道误差有多大**——留白就是为这个准备的。')
}

// ─────────────────────────────────────────────────────────────
// TODO 6：改一个数，看结论怎么变
//
// 把 TOOLS 从 3 个复制成 12 个（改改名字就行），重新跑【一】。
// toolDefs 那一列变成多少？占总量的比例是多少？
//
// 然后回答：什么时候「工具太多」会从成本问题变成正确性问题？
// （提示：L05x 讲过注意力零和）
// ─────────────────────────────────────────────────────────────

function main() {
  console.log('把上下文变成一个能看的东西。不调 API。')
  demoBreakdown()
  demoReserve()
  demoPaginate()
  demoCalibrate()
  console.log('\n' + '─'.repeat(60))
  console.log('有了 breakdown，下一个任务才能判断该压什么。')
  console.log('别忘了 TODO 6。')
}

// verify.ts 会 import 这个文件来测你写的函数。不加这道判断的话，
// import 的那一刻观察实验就跑起来了，verify 的输出会变成第一个 TODO
// 的堆栈，而不是一张「还有哪些没写」的清单。
if (isMain(import.meta.url)) main()
