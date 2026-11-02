/**
 * L12 的交付物：一个能进 CI 的评测门禁。跑法：
 *
 *     cd labs && pnpm regress
 *
 * ★ 这个脚本是这一节真正要交出去的东西。前面七个 TODO 是零件，
 * 这里是把它们接成一道**会拦住你的门**。
 *
 * 而"会拦住你"是关键。一个只输出报告的评测，三周之后就没人看了。
 * 门禁的价值在于它 exit 非 0，而 CI 会因此变红。
 *
 * 但门禁最难的部分不是判断逻辑，是**判什么才不会被绕过**。
 * 下面五道判断，每一道都对应一种真实发生过的绕过方式。
 */

import { isMain } from '../shared/entry.ts'
import {
  auditJudge,
  compareRuns,
  detectRot,
  type DiffResult,
  type JudgeAudit,
  type PairedVerdict,
  type RotReport,
} from '../shared/evals.ts'

const line = (n = 66) => '─'.repeat(n)
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

export interface GateInput {
  /** 上一次（主干）每条样本的得分。 */
  baseline: Record<string, number>
  /** 这次（PR）每条样本的得分。 */
  current: Record<string, number>
  /** 每条样本的历史得分，用来测腐化。 */
  history: Record<string, number[]>
  /** judge 体检数据。没用 judge 就传 null。 */
  judge: {
    judgeLabels: string[]
    humanLabels: string[]
    paired: PairedVerdict[]
    runs: string[][]
  } | null
  /** 这一轮一共比了几个指标。★ 见第五道闸。 */
  comparisons: number
}

export interface GateResult {
  /** 拦下的理由。非空就该让 CI 红。 */
  blockers: string[]
  /** 提醒，但不拦。 */
  warnings: string[]
  diff: DiffResult
  rot: RotReport
  audit: JudgeAudit | null
  pass: boolean
}

/**
 * 五道闸。
 *
 * ★ 顺序是故意的：**先查评测本身可不可信，再看跑分。**
 *
 * 因为一个坏了的评测会给出一个好看的分数，而如果你先看分数，
 * 你已经有了立场，之后再去看评测质量就很难客观。
 */
export function gate(input: GateInput): GateResult {
  const blockers: string[] = []
  const warnings: string[] = []

  // ── 闸一：样本集没被换过 ────────────────────────────────
  //
  // ★ 这一道放第一位，因为它是最有效也最不引人注目的绕过方式：
  // 删掉几条不过的样本，跑分立刻上去，而 diff 里看不出异常
  // ——那几行只是从一个 JSON 文件里消失了。
  const baseIds = new Set(Object.keys(input.baseline))
  const curIds = new Set(Object.keys(input.current))
  const dropped = [...baseIds].filter((i) => !curIds.has(i))
  const added = [...curIds].filter((i) => !baseIds.has(i))

  if (dropped.length > 0) {
    blockers.push(
      `${dropped.length} 条基线样本在这次运行里消失了：${dropped.slice(0, 5).join('、')}。` +
        '★ 删样本能让任何跑分变好看。要删得单独提 PR 并写明理由，不能混在改动里',
    )
  }
  if (added.length > 0) {
    warnings.push(
      `新增了 ${added.length} 条样本。它们不参与成对比较（没有基线），` +
        '所以这次的对比只覆盖旧样本——新样本从下一轮开始算',
    )
  }

  // ── 闸二：judge 可不可信 ────────────────────────────────
  //
  // ★ 在看跑分之前先查这个。一个位置偏见 0.19 的 judge 给出的分数，
  // 无论涨了还是跌了都不能用来做决定。
  let audit: JudgeAudit | null = null
  if (input.judge) {
    audit = auditJudge(input.judge)
    if (!audit.deployable) {
      blockers.push(
        `judge 没通过体检（kappa ${audit.kappa.toFixed(2)}，位置偏见 ${audit.positionBias.toFixed(3)}）。` +
          '★ 这道闸在跑分之前——一个偏的 judge 给出的分数，涨了跌了都不能用',
      )
      for (const p of audit.problems) warnings.push(`judge：${p}`)
    }
  }

  // ── 闸三：跑分本身 ──────────────────────────────────────
  const diff = compareRuns(input.baseline, input.current)

  if (diff.broken.length > 0) {
    // ★ 注意这里拦的是"弄坏了样本"，不是"净值下降"。
    // 净值可以是正的，同时你弄坏了十条。见 demo 六。
    const level = diff.significant && diff.ci.hi < 0 ? blockers : warnings
    level.push(
      `弄坏了 ${diff.broken.length} 条原本通过的样本：${diff.broken.slice(0, 5).join('、')}。` +
        (diff.delta > 0
          ? `★ 注意净值还是涨的（${(diff.delta * 100).toFixed(0)} 个百分点）——` +
            '**净值会把这件事藏起来。** 先看这几条是什么再决定合不合'
          : ''),
    )
  }

  if (!diff.significant && Math.abs(diff.delta) > 0) {
    warnings.push(
      `跑分变了 ${(diff.delta * 100).toFixed(1)} 个百分点，但差值区间 ` +
        `[${diff.ci.lo.toFixed(3)}, ${diff.ci.hi.toFixed(3)}] 跨过 0。` +
        '★ 别把这个写进 PR 描述当成效果——在这个样本量下它是噪声',
    )
  }

  // ── 闸四：评测集还有没有区分度 ──────────────────────────
  const rot = detectRot(input.history)
  const total = rot.live.length + rot.alwaysPass.length + rot.alwaysFail.length
  if (total > 0 && rot.live.length / total < 0.3) {
    warnings.push(
      `只有 ${rot.live.length}/${total} 条样本还有区分度。` +
        '★ 这道闸不拦你合并，但它在说：**这个门禁快要失效了。** 该补新样本了',
    )
  }
  for (const p of rot.problems) {
    if (p.includes('从来没通过')) warnings.push(p)
  }

  // ── 闸五：这一轮看了几个指标 ────────────────────────────
  //
  // ★ 最容易被漏的一道，因为它不查数据，查的是**你的行为**。
  if (input.comparisons > 3) {
    const pAny = 1 - 0.95 ** input.comparisons
    warnings.push(
      `这一轮比了 ${input.comparisons} 个指标，"至少一个假阳性"的概率是 ` +
        `${(pAny * 100).toFixed(0)}%。★ 先声明唯一的主指标，其余只当探索性观察`,
    )
  }

  return { blockers, warnings, diff, rot, audit, pass: blockers.length === 0 }
}

// ─────────────────────────────────────────────────────────────

/** 造一次"看起来是改进，其实弄坏了一批"的 PR。 */
function scenario(): GateInput {
  const baseline: Record<string, number> = {}
  const current: Record<string, number> = {}
  for (let i = 0; i < 120; i++) {
    baseline[`c${i}`] = i < 84 ? 1 : 0
    current[`c${i}`] = i < 84 ? 1 : 0
  }
  // 修好 14 个
  for (let i = 84; i < 98; i++) current[`c${i}`] = 1
  // 悄悄弄坏 9 个
  for (let i = 0; i < 9; i++) current[`c${i}`] = 0
  // 顺手删掉两条一直不过的
  delete current['c110']
  delete current['c111']

  const history: Record<string, number[]> = {}
  for (let i = 0; i < 120; i++) {
    history[`c${i}`] = i < 84 ? [1, 1, 1, 1] : i < 100 ? [0, 1, 0, 1] : [0, 0, 0, 0]
  }

  // 一个位置偏见明显的 judge
  const human = Array.from({ length: 30 }, (_, i) => (i % 4 === 0 ? 'B' : 'A'))
  const paired: PairedVerdict[] = Array.from({ length: 30 }, (_, i) => ({
    ab: 'A',
    ba: i % 6 === 0 ? 'A' : 'B',
    lenA: 200,
    lenB: 100,
  }))

  return {
    baseline,
    current,
    history,
    judge: {
      judgeLabels: paired.map((v) => v.ab),
      humanLabels: human,
      paired,
      runs: [0, 1, 2].map(() => paired.map((v) => v.ab)),
    },
    comparisons: 6,
  }
}

async function main(): Promise<void> {
  console.log(`\n${'═'.repeat(66)}`)
  console.log('L12 · 评测门禁（这就是这一节的交付物）')
  console.log('═'.repeat(66))

  const input = scenario()
  const r = gate(input)

  console.log(`\n场景：一个 PR，改了 prompt。表面上的数字：`)
  console.log(
    `  ${(r.diff.before * 100).toFixed(0)}% → ${(r.diff.after * 100).toFixed(0)}%  ` +
      `（${r.diff.delta >= 0 ? '+' : ''}${(r.diff.delta * 100).toFixed(1)} 个百分点）`,
  )
  console.log(dim('  提 PR 的人在描述里写了"评测涨了 4 个点"。'))

  console.log(`\n${line()}`)

  if (r.blockers.length > 0) {
    console.log(red(`\n拦下（${r.blockers.length} 条）：`))
    for (const b of r.blockers) console.log(`  ${red('✕')} ${b}\n`)
  }
  if (r.warnings.length > 0) {
    console.log(yellow(`提醒（${r.warnings.length} 条）：`))
    for (const w of r.warnings) console.log(`  ${yellow('!')} ${w}\n`)
  }

  console.log(line())
  console.log(r.pass ? green('\n门禁通过。') : red('\n门禁拦下。CI 应该红。'))

  console.log(`\n★ 这个场景里有三件事同时在发生，而 PR 描述只提了第一件：`)
  console.log(`  1. 修好了 ${r.diff.fixed.length} 条  ${dim('← 描述里写的')}`)
  console.log(`  2. 弄坏了 ${r.diff.broken.length} 条  ${red('← 净值把它藏起来了')}`)
  console.log(`  3. 删掉了 2 条一直不过的样本  ${red('← diff 里只是两行 JSON 消失')}`)
  console.log(`\n  再加上那个 judge 位置偏见 ${r.audit?.positionBias.toFixed(3)}——`)
  console.log('  **这个跑分从一开始就不该被当成证据。**')

  console.log('\n★ 五道闸的顺序是故意的：**先查评测本身可不可信，再看跑分。**')
  console.log('  因为一个坏了的评测会给出好看的分数，而如果你先看分数，')
  console.log('  你已经有了立场，之后再去看评测质量就很难客观了。')

  console.log('\n★ 而最后一道闸（看了几个指标）查的不是数据，是**你的行为**。')
  console.log('  它是唯一一道你没法靠改代码通过的闸。')

  if (!r.pass) process.exitCode = 1
}

if (isMain(import.meta.url)) await main()
