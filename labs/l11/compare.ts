/**
 * L11 任务二：15 倍是怎么来的。
 *
 *   pnpm compare:multi
 *
 * 这个不用写，直接跑。一次 API 都不调——全部是账面计算。
 *
 * ★ 为什么值得单独做一个 demo：
 *
 * "多 agent 贵 15 倍"这个结论网上到处都是，但它**没什么用**。
 * 光看这个数字，你会得出"多 agent 的协调开销很大"这个结论——
 * 而那是错的，错得还挺离谱。
 *
 * 下面这五组实验会把 Anthropic 公布的两个倍数（单 agent 约 4 倍聊天、
 * 多 agent 约 15 倍聊天）**推导出来**，然后回答一个更有用的问题：
 * 那 15 倍里面到底是什么。
 */

import { priceOf } from '../shared/config.ts'
import { isMain } from '../shared/entry.ts'
import {
  costChat,
  costMulti,
  costSingle,
  telephone,
  type CostBreakdown,
  type CostShape,
} from '../shared/multi.ts'

const line = (n = 74) => '─'.repeat(n)
const w = (s: string) => [...s].reduce((a, c) => a + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const cn = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - w(s)))
const r = (s: string, n: number) => ' '.repeat(Math.max(0, n - w(s))) + s

/**
 * 一套典型的形状。这些数字不是编的：
 *
 *   toolDefTokens    —— L10 实测：10 个工具约 911 token
 *   toolResultTokens —— 一次 read_file / web_search 的返回，1200 是中位数量级
 *   briefTokens      —— 本节 CHIP_FIXED 里那份写清楚的任务书，约 180
 *   reportTokens     —— 一份 sub-agent 摘要，约 300
 */
const SHAPE: CostShape = {
  toolDefTokens: 911,
  toolResultTokens: 1200,
  briefTokens: 180,
  reportTokens: 300,
}

const MODEL = 'deepseek-v4-pro'
const CHAT = costChat(250, 6)

const yuanOf = (b: CostBreakdown) => (b.inputTokens / 1e6) * priceOf(MODEL).inputMiss

function row(label: string, b: CostBreakdown) {
  console.log(
    `  ${cn(label, 24)}${r(b.inputTokens.toLocaleString(), 11)}` +
      `${r((b.inputTokens / CHAT.inputTokens).toFixed(1) + '×', 9)}` +
      `${r(String(b.calls), 7)}${r(String(b.agents), 7)}${r('¥' + yuanOf(b).toFixed(3), 10)}`,
  )
}

// ─────────────────────────────────────────────────────────────

function demoCalibrate() {
  console.log(`\n【一】先把公布的两个倍数推出来\n${line()}`)
  console.log(`  分母：一次普通聊天 = ${CHAT.inputTokens.toLocaleString()} token`)
  console.log(`  （6 轮、每轮 250 token 累积。★ 聊天里没有工具定义也没有工具结果——`)
  console.log(`   这正是它便宜的原因，也是为什么它能当分母。）\n`)

  console.log(`  ${cn('拓扑', 24)}${r('输入 token', 11)}${r('倍聊天', 9)}${r('调用', 7)}${r('agent', 7)}${r('钱', 10)}`)
  console.log(`  ${line(68)}`)

  row('纯聊天', CHAT)
  for (const s of [3, 5, 7]) row(`单 agent ${s} 步`, costSingle(s, SHAPE))
  for (const [a, s] of [[2, 5], [3, 5], [4, 5]] as [number, number][]) {
    row(`${a} 个 sub-agent × ${s} 步`, costMulti(a, s, SHAPE))
  }

  const single5 = costSingle(5, SHAPE)
  const multi3 = costMulti(3, 5, SHAPE)

  console.log(`\n  ★ 对上了：`)
  console.log(`    单 agent 跑 5 步            ${(single5.inputTokens / CHAT.inputTokens).toFixed(1)}× 聊天   （公布值：约 4×）`)
  console.log(`    3 个 sub-agent 各跑 5 步    ${(multi3.inputTokens / CHAT.inputTokens).toFixed(1)}× 聊天   （公布值：约 15×）`)
  console.log(`\n  而"5 步"这个数不是我挑出来凑答案的——Anthropic 写进 prompt 的`)
  console.log(`  投入分级里，"简单事实查找"就是 1 个 agent、3 到 10 次工具调用。`)
  console.log(`\n  ★ 结论：那两个倍数不是他们那套系统的特性，是这个架构的**算术后果**。`)
  console.log(`  换句话说，**你自己搭的多 agent 也会是这个倍数。**`)
}

function demoWhereTheMoneyGoes() {
  console.log(`\n【二】15 倍里面是什么：多出来的不是开销，是**工作量**\n${line()}`)

  const single = costSingle(5, SHAPE)
  const multi = costMulti(3, 5, SHAPE)

  const show = (b: CostBreakdown) => {
    const { toolDefs, growth, coordination } = b.parts
    const pct = (v: number) => `${((v / b.inputTokens) * 100).toFixed(0)}%`
    console.log(`\n  ${b.label}   共 ${b.inputTokens.toLocaleString()} token`)
    console.log(`    工具定义      ${r(toolDefs.toLocaleString(), 10)}  ${r(pct(toolDefs), 5)}   每一轮每个 agent 都要重发`)
    console.log(`    上下文增长    ${r(growth.toLocaleString(), 10)}  ${r(pct(growth), 5)}   O(n²)，L02 就讲过`)
    console.log(`    协调开销      ${r(coordination.toLocaleString(), 10)}  ${r(pct(coordination), 5)}   任务书 + 报告`)
  }

  show(single)
  show(multi)

  const ratio = multi.inputTokens / single.inputTokens
  const coordShare = multi.parts.coordination / multi.inputTokens

  console.log(`\n  多 agent / 单 agent = ${ratio.toFixed(2)}×，而扇出宽度是 3。`)
  console.log(`\n  ★ **这个倍数几乎就是扇出宽度本身。** 协调开销只占 ${(coordShare * 100).toFixed(0)}%。`)
  console.log(`\n  所以"多 agent 的协调开销很大"是个错误诊断。真实情况是：`)
  console.log(`  **多 agent 贵，是因为它做了 3 倍的工作，而不是因为协调很贵。**`)
  console.log(`\n  这个区别决定了你该怎么优化：`)
  console.log(`\n    以为是协调贵  → 去优化任务书格式、压缩报告、改协议`)
  console.log(`                    （在动 ${(coordShare * 100).toFixed(0)}% 的部分，天花板是 ${(coordShare * 100).toFixed(0)}%）`)
  console.log(`    知道是工作量  → 去问"这 3 路探索里有几路是必要的"`)
  console.log(`                    （在动 100% 的部分）`)
  console.log(`\n  而 Anthropic 那句"token 用量本身解释了 80% 的性能差异"说的就是这件事：`)
  console.log(`  **多出来的 token 不是浪费，它就是产品。** 你花钱买的是多探索了三个方向。`)
  console.log(`  任务里真有三个独立方向时，这笔钱买到了东西；没有的话，钱照花。`)
}

function demoSameWork() {
  console.log(`\n【三】同样的工作量：多 agent 反而便宜，而这是个陷阱\n${line()}`)

  // 上一组比的是"同一个任务、两种拓扑"，多 agent 做了 3 倍的活。
  // 这一组固定总工作量，看纯拓扑效应。
  const single = costSingle(15, SHAPE)
  const multi = costMulti(3, 5, SHAPE)

  console.log(`  同样 15 步的工具调用总量：`)
  console.log(`\n    单 agent 跑 15 步          ${r(single.inputTokens.toLocaleString(), 10)} token   ¥${yuanOf(single).toFixed(3)}`)
  console.log(`    3 个 sub-agent × 5 步      ${r(multi.inputTokens.toLocaleString(), 10)} token   ¥${yuanOf(multi).toFixed(3)}`)

  const ratio = multi.inputTokens / single.inputTokens
  console.log(`\n    比值：${ratio.toFixed(2)}×`)

  console.log(`\n  ★ 固定工作量之后，**多 agent 反而便宜** —— 而这不是好消息。`)
  console.log(`\n  原因是上下文增长从一个 O(15²) 变成了三个 O(5²)：`)
  console.log(`  15² = 225，而 3 × 5² = 75。**切碎上下文确实省钱，省的是平方项。**`)
  console.log(`\n  但省下来的那部分，正是 sub-agent 之间看不到的那部分信息。`)
  console.log(`  单 agent 第 14 步的时候看得到第 2 步读到的东西；`)
  console.log(`  三个 sub-agent 里没有任何一个看得到别人读到的东西。`)
  console.log(`\n  ★ 所以这个数字的正确读法是：**便宜和有损是同一件事的两面。**`)
  console.log(`  你省下的钱，等于你丢掉的上下文。`)
  console.log(`\n    任务真可拆（各路互不相干）→ 丢掉的本来就没用，这笔交易是赚的`)
  console.log(`    任务不可拆                 → 你用更少的钱买到了一个更差的结果，`)
  console.log(`                                 而账单上只看得到"更少的钱"`)
  console.log(`\n  这也是为什么第二组和第三组必须分开看：`)
  console.log(`  **"多 agent 贵不贵"取决于你问的是"同一个任务"还是"同样的工作量"，`)
  console.log(`  而这两个问题的答案方向相反。**`)
}

function demoTelephone() {
  console.log(`\n【四】传话游戏：信息路径上的两次有损压缩\n${line()}`)

  const t = telephone({ rawTokens: 32_000, agents: 3, summaryTokensEach: 300, finalTokens: 500 })

  for (const h of t.hops) {
    const bar = '█'.repeat(Math.max(1, Math.round(h.kept * 40)))
    console.log(`  ${cn(h.stage, 24)}${r(h.tokens.toLocaleString(), 8)} token  ${r((h.kept * 100).toFixed(1) + '%', 7)}  ${bar}`)
  }

  console.log(`\n  ★ 最终结论和原始材料之间隔了**两层转述**，`)
  console.log(`  而编排者**没有任何办法回去核对**——它从来没见过原始材料。`)
  console.log(`\n  单 agent 在这条路径上有几次压缩？**零次。**`)
  console.log(`  它第 14 步引用第 2 步读到的原文时，读的是原文。`)
  console.log(`\n  这不是说压缩一定是坏的——检索的本质就是压缩（L09 开头那句），`)
  console.log(`  32000 token 里绝大部分确实是噪声。`)
  console.log(`  问题在于**压缩发生在你看不到的地方，而且不可逆**。`)
  console.log(`\n  Anthropic 的应对值得抄：让 sub-agent 把产物写到文件，`)
  console.log(`  只把**轻量引用**交回编排者。把"转述"换成"指针"——`)
  console.log(`  编排者要细节的时候可以自己去读。shared/multi.ts 里的 toArtifactRef 就是这个。`)
}

function demoRunaway() {
  console.log(`\n【五】没有闸的时候，账单长什么样\n${line()}`)

  const base = costMulti(3, 5, SHAPE)
  const cases: [string, CostBreakdown][] = [
    ['规规矩矩：3 × 5', base],
    ['模型多开了一倍：6 × 5', costMulti(6, 5, SHAPE)],
    ['「简单查询开了 50 个」', costMulti(50, 5, SHAPE)],
    ['递归一层：每个又开 3 个', costMulti(3 * 3, 5, SHAPE)],
    ['递归两层', costMulti(3 * 3 * 3, 5, SHAPE)],
  ]

  for (const [label, b] of cases) {
    console.log(
      `  ${cn(label, 28)}${r(b.inputTokens.toLocaleString(), 12)} token` +
        `${r('¥' + yuanOf(b).toFixed(2), 9)}${r((b.inputTokens / base.inputTokens).toFixed(1) + '×', 8)}`,
    )
  }

  console.log(`\n  ★ 第三行是 Anthropic 早期版本的真实故障：一个简单查询开了 50 个 sub-agent。`)
  console.log(`  后两行是**递归**——sub-agent 开 sub-agent。每加一层就乘一次扇出宽度。`)
  console.log(`\n  这解释了为什么 fanout 需要四道闸，也解释了为什么`)
  console.log(`  **深度那道闸要单独算一道**：它挡的是指数，另外三道挡的是线性。`)
  console.log(`\n  顺带一个观察：这五行里**没有一行会报错**。`)
  console.log(`  它们都会成功返回一个质量不错的答案，然后出现在月底的账单上。`)
  console.log(`  这也是这一节和 L10 共同的那个主题——**这一层的失效不响。**`)
}

async function main() {
  console.log(`\n${'═'.repeat(74)}`)
  console.log(`L11 · 15 倍是怎么来的（${MODEL}，一次 API 都不调）`)
  console.log('═'.repeat(74))

  demoCalibrate()
  demoWhereTheMoneyGoes()
  demoSameWork()
  demoTelephone()
  demoRunaway()

  console.log(`\n${line()}`)
  console.log(`一句话：**多 agent 是一种花钱策略，不是一种架构。**`)
  console.log(`你花钱买的是并行探索的容量。任务里没有并行的时候，钱照花，东西买不到。`)
}

if (isMain(import.meta.url)) await main()
