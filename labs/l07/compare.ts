/**
 * L07 任务二：把「workflow 还是 agent」这个选择量出来。
 *
 *   pnpm compare
 *
 * 不调 API。用一个可复现的假模型跑 200 个工单，三种架构各跑一遍。
 *
 * 这个实验要打掉一个很常见的判断方式：**只比平均成本。**
 * 平均值会告诉你 agent 只贵三倍，看起来能接受。
 * p95 会告诉你另一件事，而线上超时和账单告警看的是 p95。
 */

import { priceOf } from '../shared/config.ts'

// ─────────────────────────────────────────────────────────────
// 可复现的随机数。教学代码里的随机必须可复现，
// 否则你每次看到的数不一样，没法讨论。
// ─────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MODEL_CHEAP = 'deepseek-v4-flash'
const MODEL_STRONG = 'deepseek-v4-pro'

interface Ticket {
  /** 'easy' 的工单只要按模板回，'hard' 的要查订单、查物流、算退款。 */
  kind: 'easy' | 'hard'
  /**
   * 这个工单交给 agent 时会走多少步、办不办成。
   *
   * ★ 预先定死而不是每种架构现摇，是为了让三种架构跑的是**同一批运行**。
   * 各摇一次的话，"混合最坏情况比纯 agent 还差"这种伪结论会冒出来——
   * 而它只是两条随机序列不同，和架构无关。
   * **对照实验要控制变量，这条在 L12 做 evals 时是硬要求。**
   */
  agentSteps: number
  agentOk: boolean
}

/** 生成一批工单。八成简单、两成复杂——这个比例是客服场景的典型分布。 */
function tickets(n: number, rng: () => number): Ticket[] {
  return Array.from({ length: n }, () => {
    const kind: Ticket['kind'] = rng() < 0.8 ? 'easy' : 'hard'
    // 长尾：85% 落在 base..base+2，15% 落在 base+5..base+16。
    // 这个形状不是我编的——它是"模型走错路然后自己绕回来"的自然结果。
    const u = rng()
    const base = kind === 'hard' ? 5 : 3
    const agentSteps = u < 0.85 ? base + Math.floor(rng() * 3) : base + 5 + Math.floor(rng() * 12)
    // agent 能处理复杂工单，但不是百分百；简单工单它也有小概率办歪。
    const agentOk = rng() < (kind === 'hard' ? 0.9 : 0.97)
    return { kind, agentSteps, agentOk }
  })
}

interface Run {
  /** 每次模型调用的 (模型, 输入 token, 输出 token)。 */
  calls: { model: string; input: number; output: number }[]
}

const yuanOf = (r: Run) =>
  r.calls.reduce((sum, c) => {
    const p = priceOf(c.model)
    return sum + (c.input / 1e6) * p.inputMiss + (c.output / 1e6) * p.output
  }, 0)

// ─────────────────────────────────────────────────────────────
// 架构一：纯 workflow（路由 + 链式）
//
// 路径完全由代码决定。每个工单固定三次调用：
//   分类（便宜模型，16 token 输出）→ 起草 → 检查
// ─────────────────────────────────────────────────────────────

function asWorkflow(_t: Ticket): Run {
  // 复杂工单在纯 workflow 下走不通——流程里没有"去查订单"这一步。
  // 它会照样跑完三步、照样产出一段通顺的回复，只是答非所问。
  // ★ 这里的关键是：**成本正常，质量失败。** 只看账单看不出来。
  return {
    calls: [
      { model: MODEL_CHEAP, input: 700, output: 8 },
      { model: MODEL_CHEAP, input: 900, output: 220 },
      { model: MODEL_CHEAP, input: 1200, output: 40 },
    ],
  }
}

const workflowSolves = (t: Ticket) => t.kind === 'easy'

// ─────────────────────────────────────────────────────────────
// 架构二：纯 agent
//
// 每个工单都交给带工具的 agent。步数由模型决定，分布是长尾的。
// ─────────────────────────────────────────────────────────────

function asAgent(t: Ticket): Run {
  const calls: Run['calls'] = []
  // 每一步都要重发全部历史，所以输入单调递增（L02 那笔账）。
  let ctx = 2200 // system + 工具定义 + 工单
  for (let i = 0; i < t.agentSteps; i++) {
    calls.push({ model: MODEL_STRONG, input: ctx, output: 120 })
    ctx += 900 // 一次工具结果 + 一次模型输出
  }
  return { calls }
}

const agentSolves = (t: Ticket) => t.agentOk

// ─────────────────────────────────────────────────────────────
// 架构三：混合——workflow 打底，agent 兜边缘
//
// 用便宜模型分类，简单的走固定流程，复杂的才交给 agent。
// 这是实际项目里最常见的形态，也是这一节想让你先想到的形态。
// ─────────────────────────────────────────────────────────────

function asHybrid(t: Ticket): Run {
  const gate: Run['calls'] = [{ model: MODEL_CHEAP, input: 700, output: 8 }]
  if (t.kind === 'easy') return { calls: [...gate, ...asWorkflow(t).calls.slice(1)] }
  return { calls: [...gate, ...asAgent(t).calls] }
}

const hybridSolves = (t: Ticket) => (t.kind === 'easy' ? true : t.agentOk)

// ─────────────────────────────────────────────────────────────
// 统计
// ─────────────────────────────────────────────────────────────

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i]!
}

interface Stat {
  name: string
  totalYuan: number
  meanYuan: number
  p50: number
  p95: number
  max: number
  meanCalls: number
  maxCalls: number
  solved: number
  n: number
}

function summarize(name: string, runs: Run[], solved: boolean[]): Stat {
  const costs = runs.map(yuanOf).sort((a, b) => a - b)
  const calls = runs.map((r) => r.calls.length)
  return {
    name,
    totalYuan: costs.reduce((a, b) => a + b, 0),
    meanYuan: costs.reduce((a, b) => a + b, 0) / costs.length,
    p50: pct(costs, 50),
    p95: pct(costs, 95),
    max: costs[costs.length - 1]!,
    meanCalls: calls.reduce((a, b) => a + b, 0) / calls.length,
    maxCalls: Math.max(...calls),
    solved: solved.filter(Boolean).length,
    n: runs.length,
  }
}

const width = (s: string) =>
  [...s].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)))
const rp = (s: string, n: number) => ' '.repeat(Math.max(0, n - width(s))) + s

function table(stats: Stat[]) {
  console.log(
    pad('架构', 14) +
      rp('总花费', 10) +
      rp('p50', 9) +
      rp('p95', 9) +
      rp('最坏', 9) +
      rp('p95/p50', 9) +
      rp('均步', 7) +
      rp('最多步', 8) +
      rp('解决率', 8),
  )
  console.log('─'.repeat(83))
  for (const s of stats) {
    console.log(
      pad(s.name, 14) +
        rp(`¥${s.totalYuan.toFixed(3)}`, 10) +
        rp(s.p50.toFixed(5), 9) +
        rp(s.p95.toFixed(5), 9) +
        rp(s.max.toFixed(5), 9) +
        rp(`${(s.p95 / s.p50).toFixed(1)}×`, 9) +
        rp(s.meanCalls.toFixed(1), 7) +
        rp(String(s.maxCalls), 8) +
        rp(`${((s.solved / s.n) * 100).toFixed(0)}%`, 8),
    )
  }
}

// ─────────────────────────────────────────────────────────────

const N = 200

function main() {
  console.log(`同一批 ${N} 个客服工单（80% 简单 / 20% 复杂），三种架构各跑一遍。`)
  console.log('假模型，不调 API，随机数固定种子——数字可复现。\n')

  const batch = tickets(N, mulberry32(7))
  const agRuns = batch.map(asAgent)

  const stats = [
    summarize('纯 workflow', batch.map(asWorkflow), batch.map(workflowSolves)),
    summarize('纯 agent', agRuns, batch.map(agentSolves)),
    summarize('混合', batch.map(asHybrid), batch.map(hybridSolves)),
  ]

  table(stats)

  const wf = stats[0]!
  const ag = stats[1]!
  const hy = stats[2]!

  console.log('\n【读数】\n')

  console.log(`一 · 最该看的是 p95/p50 那一列，不是总花费。`)
  console.log(`   workflow：${(wf.p95 / wf.p50).toFixed(1)}×——**方差为零**。每个工单花的钱一模一样，可以写进报价单。`)
  console.log(`   agent：${(ag.p95 / ag.p50).toFixed(1)}×，最坏的那个工单是中位数的 ${(ag.max / ag.p50).toFixed(1)} 倍。`)
  console.log(`   总花费只告诉你"贵了多少"，p95/p50 告诉你"贵得能不能预测"。`)
  console.log(`   后者才是能不能按次报价、能不能定 SLA、能不能给用户一个进度条的分界线。\n`)

  console.log(`二 · 这个方差不是模型不稳定造成的，是架构造成的。`)
  console.log(`   agent 最少 ${Math.min(...agRuns.map((r) => r.calls.length))} 步、最多 ${ag.maxCalls} 步。`)
  console.log(`   而每一步都要重发全部历史（L02），所以第 15 步那次调用的输入是第 1 步的好几倍。`)
  console.log(`   **步数线性增长，成本二次增长。** 长尾在成本上被平方放大了一次。\n`)

  console.log(`三 · workflow 便宜，但有两成工单它根本解决不了——而账单看起来非常健康。`)
  console.log(`   解决率 ${((wf.solved / wf.n) * 100).toFixed(0)}%，花的钱只有纯 agent 的 1/${(ag.totalYuan / wf.totalYuan).toFixed(0)}。`)
  console.log(`   复杂工单它照样跑完三步、照样产出一段通顺的回复，只是答非所问。`)
  console.log(`   **成本正常，质量失败。** 这是最危险的一种失败模式，因为监控里看不见。`)
  console.log(`   这也是 L12 evals 存在的理由：成本能自己测，质量不能。\n`)

  console.log(`四 · 混合架构在这批数据上同时赢了成本和质量。`)
  console.log(`   花费 ¥${hy.totalYuan.toFixed(3)}，比纯 agent 省 ${(((ag.totalYuan - hy.totalYuan) / ag.totalYuan) * 100).toFixed(0)}%；`)
  console.log(`   解决率 ${((hy.solved / hy.n) * 100).toFixed(0)}%，比纯 agent 的 ${((ag.solved / ag.n) * 100).toFixed(0)}% 还高一点。`)
  console.log(`   而且它的 p50 就是 workflow 的 p50（${hy.p50.toFixed(5)}）——**八成流量的成本完全确定。**\n`)

  console.log(`   解决率反超那一点值得单独说一句，它不是巧合：`)
  console.log(`   **在 workflow 覆盖得住的路径上，确定性流程比 agent 更可靠。**`)
  console.log(`   agent 在简单工单上也有 3% 的概率把事情办歪——它有选择的自由，`)
  console.log(`   而这个自由在不需要选择的时候只是风险。\n`)

  console.log(`   **"workflow 打底 + agent 兜边缘"是实际项目里最常见的形态。**`)
  console.log(`   不是因为它优雅，是因为它把不确定性关在了两成流量里。\n`)

  console.log(`五 · 但注意混合那一行的 p95/p50 是 ${(hy.p95 / hy.p50).toFixed(1)}×，全场最高。`)
  console.log(`   这不是它变差了，是**这个指标读不懂双峰分布**。`)
  console.log(`   混合架构的成本不是一条曲线，是两个簇：八成挤在 ${hy.p50.toFixed(5)}，两成散在高位。`)
  console.log(`   p50 落在便宜簇里、p95 落在贵簇里，比值就被这个断层撑爆了。`)
  console.log(`   正确的读法是**分簇分别看**：便宜路径方差为零，贵路径和纯 agent 同分布。`)
  console.log(`   第一条读数刚教你看 p95/p50，第五条就告诉你它什么时候失效——`)
  console.log(`   这不是自相矛盾，是**用之前先看分布形状**这条纪律本身。\n`)

  console.log('─'.repeat(83))
  console.log(`
【还有两笔账这个脚本没算，但你要知道】

  · **可测性。** workflow 的每一步都能用固定输入单测，断言输出。
    agent 只能统计着看——同一个输入两次运行走不同的路。
    这个差别在写单测时是几倍工作量，在排查线上问题时是几十倍。

  · **延迟。** workflow 的三次调用串行，延迟固定叠加。
    agent 的延迟和步数成正比，所以和成本是同一条长尾分布。
    p95 延迟是产品能不能用的分水岭，而你没法给一个 ${ag.maxCalls} 步的运行做进度条。
`)
}

// ─────────────────────────────────────────────────────────────
// TODO：改三个数，看结论怎么翻
//
// 1. 把复杂工单比例从 20% 调到 60%（改 tickets 里的 0.8）。
//    混合架构还划算吗？临界点大概在哪？
//
// 2. 把 asAgent 里的长尾去掉（让 steps 恒等于 base + 1）。
//    p95 变成多少？这说明"agent 贵"到底贵在均值还是贵在尾巴？
//
// 3. 把 asWorkflow 的复杂工单也算成"解决"（改 workflowSolves 恒返回 true）。
//    表格里哪一列会变得看起来很棒？这对应线上什么样的自欺现象？
// ─────────────────────────────────────────────────────────────

main()
