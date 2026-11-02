/**
 * L18 的脚手架。跑法：pnpm bench
 *
 * 上半：观察实验——同一批 Attempt 记录，四种「成功率」、成本曲线、
 * 消融、成对 A/B、门禁分别给出不同结论。全程零模型调用。
 *
 * 下半：六个 TODO。写完跑 pnpm verify:l18。
 */

import {
  ablationTable,
  classifyAttempt,
  codingGate,
  costCurve,
  fmtFixed,
  pairedAB,
  rateSpectrum,
  resolveRate,
  validateTaskSet,
  type Attempt,
  type TaskInstance,
} from '../shared/codingEval.ts'
import { isMain } from '../shared/entry.ts'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const w = (s: string) =>
  [...visible(s)].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - w(s)))
const pct = (x: number) => `${fmtFixed(x * 100, 0)}%`

/** 固定 12 题任务集：每层 4 题；其中 c-easy 标记污染。 */
export function demoTasks(): TaskInstance[] {
  const mk = (
    id: string,
    difficulty: TaskInstance['difficulty'],
    contaminated = false,
  ): TaskInstance => ({
    id,
    difficulty,
    failToPass: [`tests/test_${id}.py::test_fix`],
    passToPass: [`tests/test_${id}.py::test_smoke`],
    repoPin: `demo/repo@${id}`,
    contaminated,
  })
  return [
    mk('e1', 'easy'),
    mk('e2', 'easy'),
    mk('e3', 'easy'),
    mk('c-easy', 'easy', true),
    mk('m1', 'medium'),
    mk('m2', 'medium'),
    mk('m3', 'medium'),
    mk('m4', 'medium'),
    mk('h1', 'hard'),
    mk('h2', 'hard'),
    mk('h3', 'hard'),
    mk('h4', 'hard'),
  ]
}

function att(
  taskId: string,
  variant: string,
  flags: Partial<Attempt> & Pick<Attempt, 'patchApplied' | 'failToPassGreen' | 'passToPassGreen'>,
): Attempt {
  return {
    taskId,
    variant,
    patchApplied: flags.patchApplied,
    failToPassGreen: flags.failToPassGreen,
    passToPassGreen: flags.passToPassGreen,
    testsMutated: flags.testsMutated ?? false,
    hackFindings: flags.hackFindings ?? [],
    errored: flags.errored,
    errorReason: flags.errorReason,
    tokens: flags.tokens ?? 1000,
    costUsd: flags.costUsd ?? 0.05,
    latencyMs: flags.latencyMs ?? 1000,
  }
}

/** 基线：easy 全过，medium 一半，hard 全挂；含一次改测试的假绿。 */
export function demoBaseline(): Attempt[] {
  return [
    att('e1', 'base', { patchApplied: true, failToPassGreen: true, passToPassGreen: true, costUsd: 0.02 }),
    att('e2', 'base', { patchApplied: true, failToPassGreen: true, passToPassGreen: true, costUsd: 0.03 }),
    att('e3', 'base', { patchApplied: true, failToPassGreen: true, passToPassGreen: true, costUsd: 0.02 }),
    att('c-easy', 'base', {
      patchApplied: true,
      failToPassGreen: true,
      passToPassGreen: true,
      costUsd: 0.01,
    }),
    att('m1', 'base', { patchApplied: true, failToPassGreen: true, passToPassGreen: true, costUsd: 0.08 }),
    att('m2', 'base', { patchApplied: true, failToPassGreen: false, passToPassGreen: true, costUsd: 0.1 }),
    att('m3', 'base', { patchApplied: true, failToPassGreen: true, passToPassGreen: true, costUsd: 0.09 }),
    att('m4', 'base', {
      patchApplied: true,
      failToPassGreen: true,
      passToPassGreen: true,
      testsMutated: true,
      costUsd: 0.07,
    }),
    att('h1', 'base', { patchApplied: true, failToPassGreen: false, passToPassGreen: true, costUsd: 0.4 }),
    att('h2', 'base', { patchApplied: false, failToPassGreen: false, passToPassGreen: true, costUsd: 0.5 }),
    att('h3', 'base', { patchApplied: true, failToPassGreen: false, passToPassGreen: true, costUsd: 0.6 }),
    att('h4', 'base', {
      patchApplied: true,
      failToPassGreen: false,
      passToPassGreen: true,
      costUsd: 0.8,
      tokens: 8000,
    }),
  ]
}

/** 候选：海报上 apply 更高，但弄坏 3 个 easy，hard 靠改测试「过」。 */
export function demoCandidate(): Attempt[] {
  return [
    att('e1', 'cand', { patchApplied: true, failToPassGreen: false, passToPassGreen: true, costUsd: 0.02 }),
    att('e2', 'cand', { patchApplied: true, failToPassGreen: false, passToPassGreen: true, costUsd: 0.02 }),
    att('e3', 'cand', { patchApplied: true, failToPassGreen: false, passToPassGreen: true, costUsd: 0.02 }),
    att('c-easy', 'cand', {
      patchApplied: true,
      failToPassGreen: true,
      passToPassGreen: true,
      costUsd: 0.01,
    }),
    att('m1', 'cand', { patchApplied: true, failToPassGreen: true, passToPassGreen: true, costUsd: 0.08 }),
    att('m2', 'cand', { patchApplied: true, failToPassGreen: true, passToPassGreen: true, costUsd: 0.08 }),
    att('m3', 'cand', { patchApplied: true, failToPassGreen: true, passToPassGreen: true, costUsd: 0.08 }),
    att('m4', 'cand', { patchApplied: true, failToPassGreen: true, passToPassGreen: true, costUsd: 0.08 }),
    att('h1', 'cand', {
      patchApplied: true,
      failToPassGreen: true,
      passToPassGreen: true,
      testsMutated: true,
      costUsd: 0.2,
    }),
    att('h2', 'cand', {
      patchApplied: true,
      failToPassGreen: true,
      passToPassGreen: true,
      testsMutated: true,
      costUsd: 0.2,
    }),
    att('h3', 'cand', {
      patchApplied: true,
      failToPassGreen: true,
      passToPassGreen: true,
      testsMutated: true,
      costUsd: 0.2,
    }),
    att('h4', 'cand', { patchApplied: true, failToPassGreen: true, passToPassGreen: true, costUsd: 0.25 }),
  ]
}

function exp1(): void {
  console.log(bold('\n实验一：同一批 Attempt，四种「成功率」'))
  const attempts = demoBaseline()
  const s = rateSpectrum(attempts)
  console.log(`  ${pad('口径', 22)}${pad('比率', 10)}命中/N`)
  console.log('  ' + '─'.repeat(44))
  for (const r of [s.apply, s.failToPassOnly, s.naiveIncludingHacks, s.resolve]) {
    console.log(`  ${pad(r.label, 22)}${pad(pct(r.rate), 10)}${r.hits}/${r.n}`)
  }
  console.log(
    dim('\n  resolve 最低：它要求补丁落下、f2p 绿、p2p 绿、且没改测试。') +
      dim('\n  naive+hacks 把改测试也算成功——这是海报最爱的口径。'),
  )
}

function exp2(): void {
  console.log(bold('\n实验二：N=10 时，翻 1 题等于 ±10 个百分点'))
  const ids = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']
  const a = ids.map((id, i) =>
    att(id, 'n10', {
      patchApplied: true,
      failToPassGreen: i < 8,
      passToPassGreen: true,
      costUsd: 0.05,
    }),
  )
  const b = a.map((x, i) =>
    i === 8
      ? att(x.taskId, 'n10', {
          patchApplied: true,
          failToPassGreen: true,
          passToPassGreen: true,
          costUsd: 0.05,
        })
      : x,
  )
  const ra = resolveRate(a)
  const rb = resolveRate(b)
  console.log(`  ${pad('版本', 14)}${pad('resolve', 10)}Wilson 95% CI`)
  console.log('  ' + '─'.repeat(48))
  console.log(
    `  ${pad('翻题前 8/10', 14)}${pad(pct(ra.rate), 10)}[${fmtFixed(ra.ci.lo, 2)}, ${fmtFixed(ra.ci.hi, 2)}]`,
  )
  console.log(
    `  ${pad('翻题后 9/10', 14)}${pad(pct(rb.rate), 10)}[${fmtFixed(rb.ci.lo, 2)}, ${fmtFixed(rb.ci.hi, 2)}]`,
  )
  console.log(
    dim('\n  两个区间严重重叠。±10pp 的海报差异在 N=10 下常常什么都不证明。'),
  )
}

function exp3(): void {
  console.log(bold('\n实验三：花费升，resolve 不一定升'))
  const curve = costCurve(demoBaseline(), 4)
  console.log(`  ${pad('花费桶', 18)}${pad('n', 6)}${pad('resolve', 10)}均价`)
  console.log('  ' + '─'.repeat(44))
  for (const b of curve) {
    const label =
      b.hi === Infinity ? `≥$${fmtFixed(b.lo, 2)}` : `$${fmtFixed(b.lo, 2)}–${fmtFixed(b.hi, 2)}`
    console.log(
      `  ${pad(label, 18)}${pad(String(b.n), 6)}${pad(pct(b.resolveRate), 10)}$${fmtFixed(b.meanCost, 2)}`,
    )
  }
  console.log(dim('\n  最贵那一桶往往是 hard 上空转——账单上升，问题仍未解决。'))
}

function exp4(): void {
  console.log(bold('\n实验四：拿掉 verify-before-stop 的消融'))
  const base = demoBaseline().map((a) => ({ ...a, variant: 'full' }))
  // 无 verify：medium 上靠改测试「假绿」，花费下降，resolve 用严格口径会掉
  const noVerify = base.map((a) => {
    if (a.taskId.startsWith('m')) {
      return att(a.taskId, 'no-verify', {
        patchApplied: true,
        failToPassGreen: true,
        passToPassGreen: true,
        testsMutated: true,
        costUsd: a.costUsd * 0.4,
      })
    }
    return { ...a, variant: 'no-verify', costUsd: a.costUsd * 0.7 }
  })
  const rows = ablationTable({ full: base, 'no-verify': noVerify }, 'full')
  console.log(`  ${pad('配置', 14)}${pad('resolve', 10)}${pad('Δ', 8)}decisive`)
  console.log('  ' + '─'.repeat(42))
  for (const r of rows) {
    const d = `${r.deltaVsBaseline >= 0 ? '+' : ''}${fmtFixed(r.deltaVsBaseline * 100, 0)}pp`
    console.log(
      `  ${pad(r.config, 14)}${pad(pct(r.resolveRate), 10)}${pad(d, 8)}${r.decisive ? 'yes' : 'no'}`,
    )
  }
  console.log(
    dim('\n  no-verify 的 resolve 用严格口径会掉（hacked 不算过）。') +
      dim('\n  若海报改用 f2p-only，它会看起来像「又快又好」。'),
  )
}

function exp5(): void {
  console.log(bold('\n实验五：非成对 Δ=0，成对门禁仍拦住「换了一批 bug」'))
  const tasks = demoTasks()
  const gate = codingGate({
    tasks,
    baseline: demoBaseline(),
    candidate: demoCandidate(),
  })
  const ab = pairedAB(demoBaseline(), demoCandidate())
  console.log(`  非成对 Δresolve：${fmtFixed(ab.unpairedDelta * 100, 0)}pp`)
  console.log(`  成对 onlyA（弄坏）：${ab.onlyA.join(', ') || '—'}`)
  console.log(`  成对 onlyB（修好）：${ab.onlyB.join(', ') || '—'}`)
  console.log(`  门禁：${gate.pass ? green('PASS') : red('BLOCK')}`)
  for (const b of gate.blockers) console.log(`    - ${b}`)
  for (const w of gate.warnings) console.log(`    · ${w}`)
  const ts = validateTaskSet(tasks)
  console.log(
    dim(`\n  任务集 gaps=${ts.gaps.length}；污染 id=${ts.contaminatedIds.join(',') || '—'}`),
  )
  console.log(dim('  净值可以是正的，同时你在拿三个 easy 换「改测试过的 hard」。'))
}

function observe(): void {
  console.log(bold('L18 · 观察实验（参考实现）'))
  console.log(dim('跑完这些再去写 TODO。每一张表都对应一种「好看的假进步」。'))
  exp1()
  exp2()
  exp3()
  exp4()
  exp5()
}

// ═════════════════════════════════════════════════════════════
// 下半：TODO
// ═════════════════════════════════════════════════════════════

/** TODO 1 ★ 任务集校验：缺 failToPass / 缺分层 / 空 id → gaps */
export function myValidateTaskSet(tasks: TaskInstance[]): ReturnType<typeof validateTaskSet> {
  throw new Error('TODO 1 未实现')
}

/** TODO 2 ★ 判定单次 Attempt：resolved / applied_only / failed / hacked / error */
export function myClassifyAttempt(a: Attempt): ReturnType<typeof classifyAttempt> {
  throw new Error('TODO 2 未实现')
}

/** TODO 3 ★★ 四种成功率并排；resolve 必须扣除 hacked 与 error */
export function myRateSpectrum(attempts: Attempt[]): ReturnType<typeof rateSpectrum> {
  throw new Error('TODO 3 未实现')
}

/** TODO 4 ★ 按花费分桶的 resolve 曲线 */
export function myCostCurve(attempts: Attempt[], bucketCount?: number): ReturnType<typeof costCurve> {
  throw new Error('TODO 4 未实现')
}

/** TODO 5 ★ 消融表：相对 baseline 的 Δ 与 decisive */
export function myAblationTable(
  byConfig: Record<string, Attempt[]>,
  baseline: string,
): ReturnType<typeof ablationTable> {
  throw new Error('TODO 5 未实现')
}

/** TODO 6 ★★ 回归门禁：先查任务集与 hack，再看成对明细 */
export function myCodingGate(
  input: Parameters<typeof codingGate>[0],
): ReturnType<typeof codingGate> {
  throw new Error('TODO 6 未实现')
}

void myValidateTaskSet
void myClassifyAttempt
void myRateSpectrum
void myCostCurve
void myAblationTable
void myCodingGate

if (isMain(import.meta.url)) {
  observe()
  console.log(
    dim(
      '\n  下一步：实现文件下半部分的六个 TODO，然后跑 pnpm verify:l18（或 uv run python -m l18.verify）。',
    ) +
      dim('\n  想先确认测试本身是对的，跑 BENCH_IMPL=shared 下的 verify。') +
      dim('\n  观察实验：pnpm bench / uv run python -m l18.bench\n'),
  )
}
