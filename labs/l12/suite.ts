/**
 * L12：评测套件。跑法：
 *
 *     cd labs && pnpm suite
 *     cd labs && EVAL_IMPL=shared pnpm suite      # 看参考实现的输出
 *     cd labs && pnpm verify:l12
 *
 * ★ 这一节是分水岭，理由很直接：**在它之前你所有的判断都是"我觉得"。**
 *
 * L03 的 prompt 改法、L06 的压缩策略、L07 的编排模式、L09 的检索配置、
 * L11 的扇出宽度——每一个都是在两种做法之间选一种，而你到现在为止
 * 没有任何手段判断哪种更好。
 *
 * 而这七个 TODO 处理的核心难题不是"怎么打分"，是**怎么不骗自己**。
 *
 * 因为评测有一个很坏的性质：**它产出数字，而数字自带权威。**
 * 一个错的评测比没有评测更糟——没有评测你至少知道自己在猜。
 *
 *   TODO 1    分层抽样      —— 随机抽会给你一个 90 分的废评测集
 *   TODO 2    断言分层      —— 别用 judge 干正则能干的事
 *   TODO 3、4 偶然校正      —— 为什么"一致率 85%"可能等于零信息
 *   TODO 5    judge 体检    —— 五步，第五步最反直觉
 *   TODO 6    显著性        —— 涨的那 2% 是真的吗
 *   TODO 7    回归明细      —— 净涨 2% 背后可能是换了一批 bug
 */

import { isMain } from '../shared/entry.ts'
import * as shared from '../shared/evals.ts'
import type {
  AgreementReport,
  Criterion,
  DiffResult,
  Interval,
  JudgeAudit,
  LogEntry,
  PairedVerdict,
  Routed,
  SampleResult,
} from '../shared/evals.ts'

const IMPL = process.env.EVAL_IMPL === 'shared' ? 'shared' : 'mine'

// ─────────────────────────────────────────────────────────────
// TODO 1：分层抽样
//
// ★ 为什么不能随机抽：**生产日志是极度不均衡的。**
//
// 一个还算健康的 agent，日志里 90% 以上是成功的正常路径。
// 随机抽 150 条，你会拿到 135 条正常路径和一把零星的失败——
// 而失败恰恰是你要评测的东西。
//
// 更糟的是这个评测集**会给你一个很高的基线分**（90%+），
// 于是任何改进都只能在剩下那 10% 里体现，信噪比极差。
//
// 要返回三样东西，而**第三样最重要**：
//   picked    抽出来的样本
//   coverage  每个分层实际取到几条
//   gaps      ★ 没取够的分层
//
// gaps 为什么最重要：**"某个失败模式在评测集里一条都没有"这件事，
// 不会以任何形式表现出来。** 你的评测会跑得很干净，分数会很好看，
// 而那个失败模式在生产上继续发生。
//
// 取到 0 条的分层要单独说一句——那不是"少了几条"，是"这一类不存在"。
// ─────────────────────────────────────────────────────────────

export function stratifiedSample(
  logs: LogEntry[],
  opts: { strata: string[]; perStratum: number; stratify?: (e: LogEntry) => string },
): SampleResult {
  throw new Error('TODO: 实现 stratifiedSample')
}

// ─────────────────────────────────────────────────────────────
// TODO 2：把判据路由到最便宜的够用的检查方式
//
// ★ 这个 TODO 存在的理由是一条很实际的观察：
// **绝大多数人上手评测的第一件事就是写一个 LLM judge，
// 而其中大半根本不需要。**
//
// "输出里有没有引用编号"是正则。"输出是不是合法 JSON 且有 severity 字段"
// 是结构检查。"分类对不对"是精确匹配。这三类合起来通常占判据的七八成，
// 而它们的共同点是：**确定、免费、不会漂。**
//
// 而 judge 的代价不只是钱：
//   · 它自己会错，而且错得有系统性（TODO 5 会量出来）
//   · 它的输出会随模型版本漂移，于是你的历史分数**不可比**
//   · 它慢，于是你不会想在每次提交时跑
//
// 优先级：expect（精确）> fields（结构）> pattern（正则）> semantic（judge）
//
// ★ 还有一个兜底分支值得想清楚：一条判据什么依据都没给，
// 既没有期望值也没标 semantic。这时候路由到 judge 是对的，
// **但要在 why 里说清这通常意味着判据本身没定义清楚。**
// 一条你自己都说不出怎么验的判据，judge 也判不了。
// ─────────────────────────────────────────────────────────────

export function routeCheck(c: Criterion): Routed {
  throw new Error('TODO: 实现 routeCheck')
}

// ─────────────────────────────────────────────────────────────
// TODO 3：偶然一致率
//
// 两个评判者各自保持自己的标签比例、但完全随机地贴，能撞对多少。
//
//     chance = Σ_label  P(judge 贴这个标签) × P(人贴这个标签)
//
// 注意标签集合要取两边的并集——judge 可能输出人工标注里没有的标签，
// 反之亦然。漏掉一边会让 chance 算小，于是 kappa 虚高。
// ─────────────────────────────────────────────────────────────

export function chanceAgreement(judge: string[], human: string[]): number {
  throw new Error('TODO: 实现 chanceAgreement')
}

// ─────────────────────────────────────────────────────────────
// TODO 4：带偶然校正的一致率 —— 整节课最重要的一个函数
//
// ★ 理由用一个例子就能说清：
//
// 你的评测集里 80% 的样本是"通过"。你写了个 judge，测出来
// **和人工标注的一致率 80%**。听起来还不错。
//
// 但如果这个 judge 的实现是 `return "pass"`——它什么都不看，
// 永远说通过——它的一致率**也是 80%**。
//
// 两者的区别，原始一致率分辨不出来。Cohen's kappa 能：
// 那个永远说通过的 judge，kappa 恰好是 0。
//
//     kappa = (观测一致率 − 偶然一致率) / (1 − 偶然一致率)
//
// ★ 经验数据（2026，21 个 judge、54 万次判断）：
// **原始一致率高估偶然校正后的一致性 33.8 到 41.3 个百分点**，
// 21 个模型无一例外。表现最好的那个原始一致率 0.849，kappa 0.511。
//
// 而这个差距的大小主要取决于**你的标签分布**，不取决于 judge 好坏。
//
// 除了算数，还要报出四类问题（每一类都对应一种"数字好看但没信息"）：
//   · judge 只输出过一个标签       → raw 完全来自标签分布
//   · 人工标注只有一个标签         → 这个评测集没有区分度，任何 judge 都拿不到有意义的 kappa
//   · raw − kappa > 0.3            → raw 不能当结论用
//   · kappa < 0.4（且不是退化情况） → 不足以做上线决策
//
// ★ 还有一个边界：chance 等于 1 的时候 kappa 的分母是 0。
// 别让它变成 NaN 或者抛异常——**那种情况本身就是一个要报出来的问题**，
// 而不是一个计算错误。
// ─────────────────────────────────────────────────────────────

export function agreement(judge: string[], human: string[]): AgreementReport {
  throw new Error('TODO: 实现 agreement')
}

// ─────────────────────────────────────────────────────────────
// TODO 5：judge 上线前的体检 —— 五步
//
// 前四步是常规的：
//   1. 偶然校正的一致率（kappa，不是 raw）
//   2. 位置偏见（AB+BA 成对，|P(A 赢) − 0.5| > 0.10 就有问题）
//   3. 冗长偏见（长度差与判决的相关性，|r| > 0.05 就有问题）
//   4. 重测信度（同输入多次跑，< 0.9 就有问题）
//
// ★ 而第五步是最反直觉的那一步，它叫**一致性—偏见悖论**：
//
// **重测信度高不等于 judge 可靠。**
//
// 原因是这两个量在数学上是正交的：一个永远选 A 的 judge，
// 重测信度接近满分（它每次都一样），位置偏见也接近满分。
//
// 2026 那项研究里有两个**已经在生产环境部署**的 judge 正好落在这个格子里：
//   · 一个重测信度 0.992，位置偏见 0.192
//   · 另一个重测信度 0.988，位置偏见 0.125
//
// 论文原话值得记住：**最可复现的 judge 恰恰是最不可信的那些。**
//
// 而这正是最坑的地方——"我的评测每次跑分都一样"听起来完全像是一件好事，
// 于是没人会去查它。
//
// 所以第五步要显式检查：重测信度 > 0.95 且位置偏见 > 0.10 时，
// **必须报出来，而且要说清这是一种失效而不是优点。**
//
// 位置偏见、冗长偏见、重测信度三个函数已经在 shared/evals 里写好了，
// 你要写的是把它们组装起来那一层，以及那五条判断。
// ─────────────────────────────────────────────────────────────

export function auditJudge(opts: {
  judgeLabels: string[]
  humanLabels: string[]
  paired: PairedVerdict[]
  runs: string[][]
}): JudgeAudit {
  throw new Error('TODO: 实现 auditJudge')
}

// ─────────────────────────────────────────────────────────────
// TODO 6：bootstrap 置信区间
//
// ★ 为什么必须有这个：**评测集小，而小样本的置信区间宽得超乎直觉。**
//
// 150 条样本、成功率 80%，95% 置信区间大约是 ±6 个百分点。
// 也就是说你测出 80%，真值在 74% 到 86% 之间都不奇怪。
//
// 那么"改动后从 80% 涨到 82%"意味着什么？**什么都不意味着。**
//
// 而这件事的危险不在于你会做错决定，在于**你会做很多错决定
// 并且每次都觉得自己有数据支持**。
//
// 做法（bootstrap 的全部内容就这么点）：
//   重复 iters 次：从原样本里**有放回**地抽 n 个，算均值
//   把这 iters 个均值排序，取 2.5% 和 97.5% 分位
//
// ★ 用 shared 里的 makeRng，不要用 Math.random——
// 评测结果必须可复现，不然你没法判断"跑分变了"是改动还是抖动。
// 这一条本身就是这节课的主题。
// ─────────────────────────────────────────────────────────────

export function bootstrapCI(
  scores: number[],
  opts?: { iters?: number; seed?: number },
): Interval {
  throw new Error('TODO: 实现 bootstrapCI')
}

// ─────────────────────────────────────────────────────────────
// TODO 7：回归比较 —— 最重要的输出不是那个 delta
//
// ★ 因为"净涨 2%"可以是下面任意一种，而它们要采取的行动完全不同：
//
//     修好 3 个，弄坏 0 个     → 干净的改进，合并
//     修好 13 个，弄坏 10 个   → ★ 这不是改进，这是**换了一批 bug**
//     修好 0 个，弄坏 0 个，
//     只是 2 个 case 抖动了    → 噪声，什么都没发生
//
// 第二种是最需要被看见的：净值是正的，看起来该合并，
// 但你实际上是在拿 10 个能用的 case 换 13 个。而如果那 10 个里
// 有付费客户在用的路径，这个改动是净负的。
//
// **净值会把这件事藏起来。所以必须报明细。**
//
// 两个技术要点：
//
// ① ★ 要对**成对差值**做 bootstrap，不是对两个均值各自算区间。
//    成对能消掉"样本本身难易不同"那部分方差，功效高得多。
//    对着 diffs = after[i] − before[i] 这个序列跑 bootstrapCI。
//
// ② 只比两边都有的 id。少了哪一边就没法成对——而"评测集换了一批样本
//    之后跑分涨了"是最经典的自欺。
//
// verdict 要区分四种情况，其中"显著但同时弄坏了一批"必须单独说。
// ─────────────────────────────────────────────────────────────

export function compareRuns(
  before: Record<string, number>,
  after: Record<string, number>,
  opts?: { seed?: number },
): DiffResult {
  throw new Error('TODO: 实现 compareRuns')
}

// ─────────────────────────────────────────────────────────────
// 观察实验
// ─────────────────────────────────────────────────────────────

const M = IMPL === 'shared' ? shared : {
  stratifiedSample,
  routeCheck,
  agreement,
  auditJudge,
  bootstrapCI,
  compareRuns,
}

const line = (n = 66) => '─'.repeat(n)
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

/** 一份形状真实的生产日志：绝大多数是成功的正常路径。 */
function fakeLogs(): LogEntry[] {
  const out: LogEntry[] = []
  const kinds = ['查询', '改代码', '多步任务']
  for (let i = 0; i < 400; i++) {
    // 92% ok，剩下 8% 分给三种失败——这就是真实分布
    const r = i % 100
    const outcome: LogEntry['outcome'] =
      r < 92 ? 'ok' : r < 96 ? 'wrong' : r < 99 ? 'error' : 'timeout'
    out.push({
      id: `log-${i}`,
      input: `请求 ${i}`,
      outcome,
      kind: kinds[i % 3]!,
      steps: 1 + (i % 9),
    })
  }
  return out
}

function demoSampling(): void {
  console.log(`\n【一】随机抽样会给你一个 90 分的废评测集\n${line()}`)

  const logs = fakeLogs()
  const dist = new Map<string, number>()
  for (const l of logs) dist.set(l.outcome, (dist.get(l.outcome) ?? 0) + 1)
  console.log(`  400 条生产日志的真实分布：`)
  for (const [k, v] of dist) console.log(`    ${k.padEnd(8)} ${v} 条  ${((v / 400) * 100).toFixed(0)}%`)

  // 随机抽 60 条
  const rand = shared.makeRng(7)
  const shuffled = [...logs].sort(() => rand() - 0.5).slice(0, 60)
  const rdist = new Map<string, number>()
  for (const l of shuffled) rdist.set(l.outcome, (rdist.get(l.outcome) ?? 0) + 1)

  console.log(`\n  随机抽 60 条：`)
  for (const k of ['ok', 'wrong', 'error', 'timeout']) {
    console.log(`    ${k.padEnd(8)} ${rdist.get(k) ?? 0} 条`)
  }
  const okShare = (rdist.get('ok') ?? 0) / 60
  console.log(red(`\n  ★ 这个评测集的基线分是 ${(okShare * 100).toFixed(0)}%。`))
  console.log('  它的问题不是"分数太高"，是**任何改进都只能在剩下那点里体现**。')
  console.log(`  而 timeout 只有 ${rdist.get('timeout') ?? 0} 条——那一类基本没被测到。`)

  console.log(`\n  分层抽样，每类要 15 条：`)
  const s = M.stratifiedSample(logs, {
    strata: ['ok', 'wrong', 'error', 'timeout'],
    perStratum: 15,
  })
  for (const [k, v] of Object.entries(s.coverage)) {
    const mark = v < 15 ? red(`  ← 只有 ${v} 条`) : ''
    console.log(`    ${k.padEnd(8)} ${v} 条${mark}`)
  }
  console.log(`\n  ${green(`总共 ${s.picked.length} 条，四类失败都覆盖到了`)}`)
  if (s.gaps.length > 0) {
    console.log(red(`\n  缺口（${s.gaps.length} 条）：`))
    for (const g of s.gaps) console.log(`    · ${g}`)
    console.log('\n  ★ 缺口必须显式报出来。因为"某个失败模式在评测集里一条都没有"')
    console.log('  这件事不会以任何形式表现出来——评测跑得很干净，分数很好看，')
    console.log('  而那个失败模式在生产上继续发生。')
  }
}

function demoRouting(): void {
  console.log(`\n【二】七成判据不需要 judge\n${line()}`)

  const criteria: Criterion[] = [
    { id: 'c1', says: '严重级别分类要对', expect: 'P0' },
    { id: 'c2', says: '输出是合法 JSON 且有 severity 和 component', fields: ['severity', 'component'] },
    { id: 'c3', says: '回答里要带引用编号', pattern: '\\[\\d+\\]' },
    { id: 'c4', says: '不能出现内部服务名', pattern: 'internal-', negate: true },
    { id: 'c5', says: '解释要让非技术同事看得懂', semantic: true },
    { id: 'c6', says: '回答质量要好', semantic: false },
  ]

  const routed = criteria.map((c) => M.routeCheck(c))
  const byKind = new Map<string, number>()
  for (const r of routed) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1)

  for (const r of routed) {
    const c = criteria.find((x) => x.id === r.id)!
    const paint = r.kind === 'judge' ? red : green
    console.log(`  ${r.id}  ${paint(r.kind.padEnd(11))} ${c.says}`)
    console.log(dim(`      ${r.why}`))
  }

  const cheap = routed.filter((r) => r.kind !== 'judge').length
  console.log(`\n  ${green(`${cheap}/${routed.length} 条用确定性断言就够`)}——确定、免费、不会漂。`)
  console.log('\n  ★ 而 judge 的代价不只是钱：')
  console.log('    · 它自己会错，而且错得有系统性（demo 四会量出来）')
  console.log('    · 它的输出会随模型版本漂移，于是你的历史分数**不可比**')
  console.log('    · 它慢，于是你不会想在每次提交时跑')
  console.log('\n  注意 c4「不能出现内部服务名」是**反向断言**：命中就算失败。')
  console.log('  安全相关的判据大半是反向的，而写成正向会让含义正好反过来，')
  console.log('  且测试全绿。')
  console.log('\n  再注意 c6「回答质量要好」这条：它被兜底路由到了 judge，')
  console.log('  但真正的问题是**这条判据本身没定义清楚**。')
  console.log('  一条你自己都说不出怎么验的判据，judge 也判不了——')
  console.log('  它只会给你一个看起来像分数的数字。')
}

function demoKappa(): void {
  console.log(`\n【三】"一致率 85%" 可能等于零信息\n${line()}`)

  // 80% 的样本确实是 pass
  const human = Array.from({ length: 100 }, (_, i) => (i < 80 ? 'pass' : 'fail'))

  console.log('  评测集：100 条，其中 80 条人工标注为 pass。')
  console.log('\n  judge A —— 实现是 `return "pass"`，什么都不看：')
  const lazy = human.map(() => 'pass')
  const rA = M.agreement(lazy, human)
  console.log(`    原始一致率  ${(rA.raw * 100).toFixed(0)}%   ${dim('← 看起来还不错')}`)
  console.log(`    偶然一致率  ${(rA.chance * 100).toFixed(0)}%`)
  console.log(`    ${red(`kappa       ${rA.kappa.toFixed(3)}`)}   ${red('← 扣掉偶然之后什么都不剩')}`)

  console.log('\n  judge B —— 真的在判断，大约每 13 条错一条：')
  const real = human.map((h, i) => (i % 13 === 0 ? (h === 'pass' ? 'fail' : 'pass') : h))
  const rB = M.agreement(real, human)
  console.log(`    原始一致率  ${(rB.raw * 100).toFixed(0)}%`)
  console.log(`    ${green(`kappa       ${rB.kappa.toFixed(3)}`)}`)

  console.log(`\n  ★ 两个 judge 的原始一致率差 ${((rB.raw - rA.raw) * 100).toFixed(0)} 个百分点，`)
  console.log(`  但 kappa 差 ${(rB.kappa - rA.kappa).toFixed(2)}——**原始一致率几乎分辨不出它们。**`)

  console.log('\n  judge A 报出来的问题：')
  for (const p of rA.problems) console.log(`    · ${p}`)

  console.log('\n  ★ 经验数据（2026 年，21 个 judge、54 万次判断）：')
  console.log('  **原始一致率高估偶然校正后的一致性 33.8 到 41.3 个百分点，21 个模型无一例外。**')
  console.log('  表现最好的那个原始一致率 0.849，kappa 0.511。')
  console.log('\n  而这个差距的大小主要取决于**你的标签分布**，不取决于 judge 好坏：')
  console.log('    标签越均衡 → 偶然一致率越接近随机 → 两个数越接近')
  console.log('    标签越不均衡 → 多数类越能白拿分 → raw 越虚高')
  console.log('\n  所以规矩很简单：**报告里 kappa 是主指标，原始一致率只能当辅助。**')
}

function demoJudgeAudit(): void {
  console.log(`\n【四】五步体检：每一步只抓得住一种退化\n${line()}`)

  const N = 42
  // 真实的胜负：A 更好的占三分之二
  const truth = Array.from({ length: N }, (_, i) => (i % 3 === 0 ? 'B' : 'A')) as ('A' | 'B')[]

  // judge 甲：永远选 A 这个答案。不看位置，也不看内容。
  const lazy: PairedVerdict[] = truth.map((_, i) => ({
    ab: 'A',
    ba: 'A',
    lenA: 100 + i,
    lenB: 100 + (i % 7) * 10,
  }))

  // ★ judge 乙：**只选排在前面的那个。**
  // 注意 AB 顺序下它给出的答案，和"A 更好"这个真相高度吻合
  //（因为 A 确实更常更好，而 A 恰好排在前面）——
  // 于是它的 kappa 会非常好看。
  const positional: PairedVerdict[] = truth.map((t, i) => ({
    ab: t, // AB 顺序里排在前面的赢 = 恰好等于真相（A 多数）
    ba: 'B', // BA 顺序里排在前面的是 B，它照样选前面那个
    lenA: 100 + i,
    lenB: 100 + (i % 7) * 10,
  }))

  // judge 丙：真的在判断，偶尔抖一下
  // 长度故意用和真相不同的周期（2 vs 3），这样冗长偏见接近 0，
  // 于是这个 judge 只会被重测信度扣分——正好隔离出第四步的作用。
  const fair: PairedVerdict[] = truth.map((t, i) => ({
    ab: t,
    ba: (i % 13 === 0 ? (t === 'A' ? 'B' : 'A') : t) as 'A' | 'B',
    lenA: 100 + (i % 2) * 60,
    lenB: 100 + ((i + 1) % 2) * 60,
  }))

  const stable = (labels: string[]) => [labels, labels, labels]
  const jittery = (labels: string[]) =>
    [0, 1, 2].map((k) => labels.map((v, i) => (i % 19 === k ? (v === 'A' ? 'B' : 'A') : v)))

  const cases: [string, PairedVerdict[], string[][]][] = [
    ['judge 甲：永远选 A 这个答案', lazy, stable(lazy.map((v) => v.ab))],
    ['judge 乙：永远选排在前面那个  ★', positional, stable(positional.map((v) => v.ab))],
    ['judge 丙：真的在判断', fair, jittery(fair.map((v) => v.ab))],
  ]

  for (const [name, paired, runs] of cases) {
    const a = M.auditJudge({
      judgeLabels: paired.map((v) => v.ab),
      humanLabels: truth,
      paired,
      runs,
    })
    console.log(`\n  ${name}`)
    const kPaint = a.kappa >= 0.8 ? green : a.kappa < 0.4 ? red : dim
    console.log(`    kappa        ${kPaint(a.kappa.toFixed(3))}`)
    console.log(
      `    重测信度      ${a.testRetest >= 0.9 ? green(a.testRetest.toFixed(3)) : red(a.testRetest.toFixed(3))}`,
    )
    console.log(
      `    位置偏见      ${a.positionBias > 0.1 ? red(a.positionBias.toFixed(3)) : green(a.positionBias.toFixed(3))}`,
    )
    console.log(`    位置翻转率    ${(a.flipRate * 100).toFixed(0)}%`)
    console.log(`    冗长偏见      ${a.verbosityBias.toFixed(3)}`)
    console.log(`    能上线吗      ${a.deployable ? green('可以') : red('不行')}`)
    for (const p of a.problems) console.log(`      · ${p}`)
  }

  console.log('\n  ★ 看 judge 乙那一行，它是这个 demo 的全部意义：')
  console.log('')
  console.log('      kappa 完美（1.000）—— 和人工标注一条不差')
  console.log('      重测信度完美（1.000）—— 问一百次答案都一样')
  console.log(`      ${red('而位置偏见 0.333')}`)
  console.log('')
  console.log('  它的实现是"**永远选排在前面的那个**"。')
  console.log('  kappa 那么好看只是因为你测的时候，更好的答案恰好多数排在前面。')
  console.log('  上线之后顺序一换，它的判断全部反过来——而 kappa 完全看不出这件事。')

  console.log('\n  ★ 这就是为什么五步一步都不能省：**每一步只抓得住一种退化。**')
  console.log('')
  console.log('      judge 甲  只被 kappa 抓住      （位置偏见是 0，因为它不看位置）')
  console.log('      judge 乙  只被位置互换抓住      （kappa 和重测信度都是满分）')
  console.log('      judge 丙  被重测信度扣了分      （它有抖动，但这是能修的那种问题）')
  console.log('')
  console.log('  少查任何一项，就会有一类 judge 带着漂亮的数字上线。')

  console.log('\n  ★ 而重测信度和位置偏见测的是**两种不同的扰动**：')
  console.log('    · 重测信度：同一个 prompt 问多次 —— 答案稳不稳')
  console.log('    · 位置偏见：把两个答案换个顺序 —— 语义上无关的扰动，答案变不变')
  console.log('  **确定性在第二种扰动上一分钱都不值。**')

  console.log('\n  2026 那项研究里有两个**已经在生产环境部署**的 judge 正好长这样：')
  console.log('    一个重测信度 0.992，位置偏见 0.192')
  console.log('    另一个重测信度 0.988，位置偏见 0.125')
  console.log('\n  论文原话：**最可复现的 judge 恰恰是最不可信的那些。**')
  console.log('\n  ★ 而这正是最坑的地方——"我的评测每次跑分都一样"听起来')
  console.log('  完全像是一件好事，于是没人会去查它。')
}

function demoSignificance(): void {
  console.log(`\n【五】涨的那 2% 是真的吗\n${line()}`)

  for (const n of [50, 150, 500, 2000]) {
    const scores = Array.from({ length: n }, (_, i) => (i < n * 0.8 ? 1 : 0))
    const ci = M.bootstrapCI(scores, { seed: 42 })
    const width = (ci.hi - ci.lo) * 100
    console.log(
      `  ${String(n).padStart(4)} 条样本、成功率 80%  →  95% 区间 ` +
        `[${(ci.lo * 100).toFixed(1)}%, ${(ci.hi * 100).toFixed(1)}%]  宽 ${width.toFixed(1)} 个百分点`,
    )
  }

  console.log('\n  ★ 看 150 条那一行：区间宽度大约 13 个百分点。')
  console.log('  也就是说你测出 80%，真值在 74% 到 86% 之间都不奇怪。')
  console.log('\n  那么"改动后从 80% 涨到 82%"意味着什么？**什么都不意味着。**')
  console.log('\n  而这件事的危险不在于你会做错一个决定，在于')
  console.log('  **你会做很多错决定，并且每次都觉得自己有数据支持。**')
  console.log('\n  ★ 注意最后一行：要把区间压到几个百分点，样本量得上千。')
  console.log('  所以现实的做法不是"攒一个巨大的评测集"，是')
  console.log('  **成对比较**（demo 六）——它能消掉样本难易带来的方差，')
  console.log('  在同样的样本量下功效高得多。')
}

function demoRegression(): void {
  console.log(`\n【六】净涨 2%，背后可能是换了一批 bug\n${line()}`)

  const cases: [string, () => [Record<string, number>, Record<string, number>]][] = [
    [
      '干净的改进',
      () => {
        const b: Record<string, number> = {}
        const a: Record<string, number> = {}
        for (let i = 0; i < 100; i++) {
          b[`c${i}`] = i < 70 ? 1 : 0
          a[`c${i}`] = i < 82 ? 1 : 0
        }
        return [b, a]
      },
    ],
    [
      '★ 换了一批 bug（净涨 2%）',
      () => {
        const b: Record<string, number> = {}
        const a: Record<string, number> = {}
        for (let i = 0; i < 100; i++) {
          b[`c${i}`] = i < 70 ? 1 : 0
          a[`c${i}`] = i < 70 ? 1 : 0
        }
        for (let i = 0; i < 10; i++) a[`c${i}`] = 0 // 弄坏 10 个
        for (let i = 70; i < 82; i++) a[`c${i}`] = 1 // 修好 12 个
        return [b, a]
      },
    ],
    [
      '纯抖动',
      () => {
        const b: Record<string, number> = {}
        const a: Record<string, number> = {}
        for (let i = 0; i < 100; i++) {
          b[`c${i}`] = i < 70 ? 1 : 0
          a[`c${i}`] = i < 70 ? 1 : 0
        }
        a['c5'] = 0 // 弄坏 1 个
        a['c71'] = 1 // 修好 3 个 —— 净值和上一组一样是 +2
        a['c72'] = 1
        a['c73'] = 1
        return [b, a]
      },
    ],
  ]

  for (const [name, mk] of cases) {
    const [b, a] = mk()
    const r = M.compareRuns(b, a, { seed: 42 })
    console.log(`\n  ${name}`)
    console.log(
      `    ${(r.before * 100).toFixed(0)}% → ${(r.after * 100).toFixed(0)}%  ` +
        `（${r.delta >= 0 ? '+' : ''}${(r.delta * 100).toFixed(0)} 个百分点）`,
    )
    console.log(
      `    修好 ${green(String(r.fixed.length))} 个，弄坏 ${
        r.broken.length > 0 ? red(String(r.broken.length)) : '0'
      } 个`,
    )
    console.log(`    差值区间 [${r.ci.lo.toFixed(3)}, ${r.ci.hi.toFixed(3)}]  显著：${r.significant ? '是' : '否'}`)
    console.log(`    ${r.verdict}`)
  }

  console.log('\n  ★ 看第二组和第三组：**净变化都是 +2 个百分点。**')
  console.log('  而一组是"修好 12 个弄坏 10 个"，另一组是"两三个 case 抖了一下"。')
  console.log('\n  只看那个 delta，两者完全一样。而它们要采取的行动完全不同：')
  console.log('    换了一批 bug  →  先看弄坏的那 10 个是什么。如果里面有付费客户')
  console.log('                      在用的路径，这个改动是**净负**的')
  console.log('    纯抖动        →  什么都没发生，别合并也别回滚，去把样本量加上去')
  console.log('\n  ★ 所以这个函数最重要的输出不是 delta，是 fixed 和 broken 两个列表。')
  console.log('  **净值会把这件事藏起来。**')
}

function demoRot(): void {
  console.log(`\n【七】你的评测集正在腐化，而原因是你在正确地工作\n${line()}`)

  // 半年的历史：早期加的 case 现在全对了，新加的还在波动
  const history: Record<string, number[]> = {}
  for (let i = 0; i < 40; i++) history[`old-${i}`] = [1, 1, 1, 1, 1, 1] // 早就修好了
  for (let i = 0; i < 8; i++) history[`new-${i}`] = [0, 1, 0, 1, 1, 1] // 还在波动
  for (let i = 0; i < 3; i++) history[`stuck-${i}`] = [0, 0, 0, 0, 0, 0] // 从来没过

  const r = shared.detectRot(history)
  const total = r.live.length + r.alwaysPass.length + r.alwaysFail.length
  console.log(`  评测集 ${total} 条，跑了 6 轮：`)
  console.log(`    ${green(`还有区分度   ${r.live.length} 条`)}`)
  console.log(`    ${dim(`一直全对     ${r.alwaysPass.length} 条`)}`)
  console.log(`    ${red(`从来没过     ${r.alwaysFail.length} 条`)}`)

  console.log(`\n  ${red(`只有 ${((r.live.length / total) * 100).toFixed(0)}% 的条目还能提供信息。`)}`)
  for (const p of r.problems) console.log(`    · ${p}`)

  console.log('\n  ★ 这件事必然发生，而且发生的原因正是你在正确地工作：')
  console.log('  你照着评测集修 bug，修完那些 case 就永远通过了。')
  console.log('  于是可用的信息在**单调减少**，而总分在**单调上升**。')
  console.log('\n  半年之后你有一个 96 分的评测集，其中 90% 的条目对任何改动都不敏感。')
  console.log('  那 96 分是真的，也是没用的。')
  console.log('\n  ★ 而"从来没过"那几条要单独看：**它可能是标注错了。**')
  console.log('  一个永远失败的 case 比一个永远成功的 case 更值得花五分钟人工确认——')
  console.log('  因为它会让你去修一个不存在的问题。')
  console.log('\n  下一节（L13）的可观测性，一半的用途就是给这个评测集持续补货。')
}

async function main(): Promise<void> {
  console.log(`\n${'═'.repeat(66)}`)
  console.log(`L12 · 评测：怎么不骗自己（实现：${IMPL}）`)
  console.log('═'.repeat(66))

  const demos: [string, () => void][] = [
    ['一', demoSampling],
    ['二', demoRouting],
    ['三', demoKappa],
    ['四', demoJudgeAudit],
    ['五', demoSignificance],
    ['六', demoRegression],
    ['七', demoRot],
  ]

  for (const [n, fn] of demos) {
    try {
      fn()
    } catch (err) {
      console.log(`\n【${n}】${red(`还没实现：${(err as Error).message}`)}`)
    }
  }

  console.log(`\n${line()}`)
  console.log('接着跑 pnpm regress —— 把这套东西接成一个能进 CI 的门禁。')
}

if (isMain(import.meta.url)) await main()
