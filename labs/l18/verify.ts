/**
 * 验证 l18/bench.ts。跑法：
 *   BENCH_IMPL=shared pnpm verify:l18   # 先确认测试本身是对的
 *   pnpm verify:l18                      # 测你的 TODO
 */

import * as shared from '../shared/codingEval.ts'
import type { Attempt, TaskInstance } from '../shared/codingEval.ts'
import { demoBaseline, demoCandidate, demoTasks } from './bench.ts'

const TARGET = process.env.BENCH_IMPL === 'shared' ? 'shared' : 'mine'

async function loadMine() {
  const m = await import('./bench.ts')
  return {
    validateTaskSet: m.myValidateTaskSet,
    classifyAttempt: m.myClassifyAttempt,
    rateSpectrum: m.myRateSpectrum,
    costCurve: m.myCostCurve,
    ablationTable: m.myAblationTable,
    codingGate: m.myCodingGate,
    // helpers always from shared
    resolveRate: shared.resolveRate,
    pairedAB: shared.pairedAB,
    isResolved: shared.isResolved,
    primaryTasks: shared.primaryTasks,
    applyRate: shared.applyRate,
    passAtK: shared.passAtK,
    passHatK: shared.passHatK,
  }
}

type Api = {
  validateTaskSet: typeof shared.validateTaskSet
  classifyAttempt: typeof shared.classifyAttempt
  rateSpectrum: typeof shared.rateSpectrum
  costCurve: typeof shared.costCurve
  ablationTable: typeof shared.ablationTable
  codingGate: typeof shared.codingGate
  resolveRate: typeof shared.resolveRate
  pairedAB: typeof shared.pairedAB
  isResolved: typeof shared.isResolved
  primaryTasks: typeof shared.primaryTasks
  applyRate: typeof shared.applyRate
  passAtK: typeof shared.passAtK
  passHatK: typeof shared.passHatK
}

const M: Api =
  TARGET === 'shared'
    ? {
        validateTaskSet: shared.validateTaskSet,
        classifyAttempt: shared.classifyAttempt,
        rateSpectrum: shared.rateSpectrum,
        costCurve: shared.costCurve,
        ablationTable: shared.ablationTable,
        codingGate: shared.codingGate,
        resolveRate: shared.resolveRate,
        pairedAB: shared.pairedAB,
        isResolved: shared.isResolved,
        primaryTasks: shared.primaryTasks,
        applyRate: shared.applyRate,
        passAtK: shared.passAtK,
        passHatK: shared.passHatK,
      }
    : ((await loadMine()) as Api)

console.log(
  TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l18/ 里你的实现）',
)

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`

let passed = 0
let failed = 0

function ok(cond: boolean, name: string): void {
  if (cond) {
    passed++
  } else {
    failed++
    console.log(red(`  ✗ ${name}`))
  }
}

function eq(a: unknown, b: unknown, name: string): void {
  const as = JSON.stringify(a)
  const bs = JSON.stringify(b)
  ok(as === bs, name + (as === bs ? '' : ` (got ${as}, want ${bs})`))
}

function section(title: string): void {
  console.log(bold(`\n${title}`))
}

function att(
  taskId: string,
  flags: Partial<Attempt> & Pick<Attempt, 'patchApplied' | 'failToPassGreen' | 'passToPassGreen'>,
): Attempt {
  return {
    taskId,
    variant: flags.variant ?? 'v',
    patchApplied: flags.patchApplied,
    failToPassGreen: flags.failToPassGreen,
    passToPassGreen: flags.passToPassGreen,
    testsMutated: flags.testsMutated ?? false,
    hackFindings: flags.hackFindings ?? [],
    errored: flags.errored,
    tokens: flags.tokens ?? 100,
    costUsd: flags.costUsd ?? 0.1,
    latencyMs: flags.latencyMs ?? 100,
  }
}

section('A · 任务集')
const good = demoTasks()
const vr = M.validateTaskSet(good)
ok(vr.ok, 'SET-1 完整集 ok')
eq(vr.byDifficulty, { easy: 4, medium: 4, hard: 4 }, 'SET-2 分层计数')
eq(vr.contaminatedIds, ['c-easy'], 'SET-3 污染列出')

const bad: TaskInstance[] = [
  {
    id: 'x',
    difficulty: 'easy',
    failToPass: [],
    passToPass: [],
    repoPin: '',
  },
  {
    id: 'x',
    difficulty: 'easy',
    failToPass: ['t'],
    passToPass: [],
    repoPin: 'r@1',
  },
]
const br = M.validateTaskSet(bad)
ok(!br.ok, 'SET-4 坏集 not ok')
ok(br.gaps.some((g) => g.includes('failToPass')), 'SET-5 缺 f2p')
ok(br.gaps.some((g) => g.includes('重复')), 'SET-6 重复 id')
ok(br.gaps.some((g) => g.includes('repoPin')), 'SET-7 缺 pin')
ok(M.primaryTasks(good).every((t) => t.id !== 'c-easy'), 'SET-8 primary 去污染')
ok(M.validateTaskSet([]).gaps.some((g) => g.includes('空')), 'SET-9 空集')

section('B · Attempt 判定')
eq(
  M.classifyAttempt(
    att('a', { patchApplied: true, failToPassGreen: true, passToPassGreen: true }),
  ),
  'resolved',
  'CLS-1 resolved',
)
eq(
  M.classifyAttempt(
    att('a', { patchApplied: true, failToPassGreen: false, passToPassGreen: true }),
  ),
  'applied_only',
  'CLS-2 applied_only',
)
eq(
  M.classifyAttempt(
    att('a', { patchApplied: false, failToPassGreen: false, passToPassGreen: true }),
  ),
  'failed',
  'CLS-3 failed',
)
eq(
  M.classifyAttempt(
    att('a', {
      patchApplied: true,
      failToPassGreen: true,
      passToPassGreen: true,
      testsMutated: true,
    }),
  ),
  'hacked',
  'CLS-4 testsMutated',
)
eq(
  M.classifyAttempt(
    att('a', {
      patchApplied: true,
      failToPassGreen: true,
      passToPassGreen: true,
      hackFindings: [{ rule: 'X', severity: 'block', evidence: {} }],
    }),
  ),
  'hacked',
  'CLS-5 hack block',
)
eq(
  M.classifyAttempt(
    att('a', {
      patchApplied: true,
      failToPassGreen: true,
      passToPassGreen: true,
      hackFindings: [{ rule: 'X', severity: 'warn', evidence: {} }],
    }),
  ),
  'resolved',
  'CLS-6 hack warn 仍可 resolved',
)
eq(
  M.classifyAttempt(
    att('a', {
      patchApplied: true,
      failToPassGreen: true,
      passToPassGreen: true,
      errored: true,
    }),
  ),
  'error',
  'CLS-7 error',
)
eq(
  M.classifyAttempt(
    att('a', {
      patchApplied: true,
      failToPassGreen: true,
      passToPassGreen: false,
    }),
  ),
  'applied_only',
  'CLS-8 p2p 破 → 非 resolved',
)

section('C · 成功率口径')
const base = demoBaseline()
const spec = M.rateSpectrum(base)
ok(spec.resolve.rate < spec.apply.rate, 'RATE-1 resolve < apply')
ok(spec.resolve.rate < spec.failToPassOnly.rate, 'RATE-2 resolve < f2p-only')
ok(spec.resolve.rate <= spec.naiveIncludingHacks.rate, 'RATE-3 resolve ≤ naive')
ok(spec.resolve.hits === 6, 'RATE-4 baseline resolve hits=6（含污染题）')
const prim = base.filter((a) => a.taskId !== 'c-easy')
ok(M.resolveRate(prim).hits === 5, 'RATE-5 去污染后 hits=5')
ok(spec.apply.ci.lo <= spec.apply.rate && spec.apply.rate <= spec.apply.ci.hi, 'RATE-6 Wilson 含点估计')

const byTask: Record<string, Attempt[]> = {
  t1: [
    att('t1', { patchApplied: true, failToPassGreen: false, passToPassGreen: true }),
    att('t1', { patchApplied: true, failToPassGreen: true, passToPassGreen: true }),
  ],
  t2: [
    att('t2', { patchApplied: true, failToPassGreen: true, passToPassGreen: true }),
    att('t2', { patchApplied: true, failToPassGreen: true, passToPassGreen: true }),
  ],
  t3: [
    att('t3', { patchApplied: false, failToPassGreen: false, passToPassGreen: true }),
    att('t3', { patchApplied: false, failToPassGreen: false, passToPassGreen: true }),
  ],
}
eq(M.passAtK(byTask, 2).hits, 2, 'RATE-7 pass@2 hits')
eq(M.passHatK(byTask, 2).hits, 1, 'RATE-8 pass^2 hits')
ok(M.passHatK(byTask, 2).rate < M.passAtK(byTask, 2).rate, 'RATE-9 pass^k < pass@k')

section('D · 成本曲线')
const curve = M.costCurve(base, 4)
ok(curve.length === 4, 'COST-1 四桶')
ok(curve.every((b) => b.n > 0), 'COST-2 每桶非空')
// 排序后 0.01 0.02 0.02 | 0.03 0.07 0.08 | 0.09 0.10 0.40 | 0.50 0.60 0.80，每桶 3 条
eq(
  curve.map((b) => [b.lo, b.n]),
  [
    [0.01, 3],
    [0.03, 3],
    [0.09, 3],
    [0.5, 3],
  ],
  'COST-3 按花费排序后切桶',
)
ok(
  curve.every((b, i) => i === curve.length - 1 || b.hi <= curve[i + 1]!.lo) &&
    curve[curve.length - 1]!.hi === Infinity,
  'COST-3b 桶首尾相接，末桶上界 Infinity',
)
// 严格口径：m4 改过测试不算，m2/h1 F2P 没绿
eq(
  curve.map((b) => Math.round(b.resolveRate * b.n)),
  [3, 2, 1, 0],
  'COST-4 每桶 resolve 数：越贵越少',
)
ok(M.costCurve([], 4).length === 0, 'COST-5 空输入')
const withError = [
  ...base,
  att('x', { patchApplied: true, failToPassGreen: true, passToPassGreen: true, errored: true, costUsd: 9 }),
]
eq(M.costCurve(withError, 4).map((b) => b.n), [3, 3, 3, 3], 'COST-6 error 不进任何桶')
eq(M.costCurve(base.slice(0, 10), 4).map((b) => b.n), [2, 2, 2, 4], 'COST-7 末桶吃掉余数')

section('E · 消融')
const full = base.map((a) => ({ ...a, variant: 'full' }))
// 拿掉 verify：把原先 resolved 的 medium 改成「改测试假绿」→ resolve 应下降
const noVerify = full.map((a) =>
  a.taskId.startsWith('m')
    ? att(a.taskId, {
        variant: 'no-verify',
        patchApplied: true,
        failToPassGreen: true,
        passToPassGreen: true,
        testsMutated: true,
        costUsd: a.costUsd * 0.5,
      })
    : { ...a, variant: 'no-verify', costUsd: a.costUsd * 0.7 },
)
const rows = M.ablationTable({ full, 'no-verify': noVerify }, 'full')
ok(rows.length === 2, 'ABL-1 两行')
const nv = rows.find((r) => r.config === 'no-verify')!
ok(nv.deltaVsBaseline < 0, 'ABL-2 no-verify resolve 下降')
// m1、m3 从 resolved 变 hacked（m4 本来就是）：6/12 → 4/12，成对差值两个 −1，不 decisive
eq(
  [Math.round(nv.deltaVsBaseline * 12), nv.decisive],
  [-2, false],
  'ABL-3 Δ = −2/12，N=12 上不 decisive',
)
let threw = false
try {
  M.ablationTable({ full }, 'missing')
} catch {
  threw = true
}
ok(threw, 'ABL-4 缺 baseline 抛错')
eq(
  M.ablationTable({ full, a: full, B: full, _x: full }, 'full').map((r) => r.config),
  ['B', '_x', 'a', 'full'],
  'ABL-5 按码点排序（不是 localeCompare）',
)

section('F · A/B 与门禁')
const ab = M.pairedAB(demoBaseline(), demoCandidate())
ok(ab.onlyA.length >= 3, 'AB-1 弄坏 ≥3')
ok(ab.onlyB.length >= 1, 'AB-2 有修好')
const gate = M.codingGate({
  tasks: demoTasks(),
  baseline: demoBaseline(),
  candidate: demoCandidate(),
})
ok(!gate.pass, 'GATE-1 坏候选拦截')
ok(gate.blockers.some((b) => b.includes('hacked') || b.includes('弄坏')), 'GATE-2 理由含 hack 或弄坏')

const cleanCand = demoBaseline().map((a) => {
  // 清掉基线里 m4 的 testsMutated，再额外修好 h1 → 噪声级 +1/+2，无 hack
  if (a.taskId === 'h1' || a.taskId === 'm4') {
    return att(a.taskId, {
      patchApplied: true,
      failToPassGreen: true,
      passToPassGreen: true,
      costUsd: a.costUsd,
      variant: 'clean',
    })
  }
  return { ...a, variant: 'clean', testsMutated: false, hackFindings: [] }
})
const gate2 = M.codingGate({
  tasks: demoTasks(),
  baseline: demoBaseline(),
  candidate: cleanCand,
  mode: 'regress',
})
// INV-45：regress 测非劣——噪声里 +1 不显著必须放行（旧门会错拦）
ok(gate2.pass === true, 'GATE-3 regress：+1 不显著仍通过')
ok(
  gate2.warnings.some((w) => w.includes('不显著')),
  'GATE-3b regress：警告改用 claim',
)
const gate2c = M.codingGate({
  tasks: demoTasks(),
  baseline: demoBaseline(),
  candidate: cleanCand,
  mode: 'claim',
})
ok(!gate2c.pass && gate2c.blockers.some((b) => b.includes('不显著')), 'GATE-6 claim：同数据不可宣称')
ok(gate2c.claimable === false, 'GATE-6b claimable=false')

const swapped = demoBaseline().filter((a) => a.taskId !== 'h4')
const gate3 = M.codingGate({
  tasks: demoTasks(),
  baseline: demoBaseline(),
  candidate: swapped,
})
ok(!gate3.pass && gate3.blockers.some((b) => b.includes('缺少任务')), 'GATE-4 样本集被换')

// h2 从「补丁没落下」变成「落下了但 F2P 没绿」；m4 去掉改测试、F2P 也不绿。
// apply 10/11 → 11/11，resolve 5/11 不变，没有 hack、没有弄坏——门禁放行，只靠警告说话
const applyOnlyCand = demoBaseline().map((a) =>
  a.taskId === 'h2' || a.taskId === 'm4'
    ? att(a.taskId, { patchApplied: true, failToPassGreen: false, passToPassGreen: true, costUsd: a.costUsd })
    : a,
)
const gate4 = M.codingGate({
  tasks: demoTasks(),
  baseline: demoBaseline(),
  candidate: applyOnlyCand,
})
ok(
  gate4.pass && gate4.warnings.some((w) => w.includes('apply↑')),
  'GATE-5 apply↑resolve 未↑：放行但必须警告',
)
ok(!gate2.warnings.some((w) => w.includes('apply')), 'GATE-5b apply 没涨不警告')

// 主任务集 11 题全修好、无 hack：onlyB = 6、onlyA = 0，成对 CI 下界 > 0
const allFixed = demoBaseline().map((a) =>
  att(a.taskId, { patchApplied: true, failToPassGreen: true, passToPassGreen: true, costUsd: a.costUsd }),
)
const gate7 = M.codingGate({ tasks: demoTasks(), baseline: demoBaseline(), candidate: allFixed, mode: 'claim' })
ok(gate7.pass && gate7.claimable, 'GATE-7 claim：显著更好 → claimable')
const gate7r = M.codingGate({ tasks: demoTasks(), baseline: demoBaseline(), candidate: allFixed })
ok(gate7r.pass && !gate7r.claimable, 'GATE-7b regress 下 claimable 恒为 false')

section('H · 双语言格式化')
eq(
  [
    shared.fmtFixed(0.0625, 3),
    shared.fmtFixed(-0.0625, 3),
    shared.fmtFixed(2.5, 0),
    shared.fmtFixed((1 / 40) * 100, 0),
    shared.fmtFixed(-0, 0),
    shared.fmtFixed(0.125, 2),
  ],
  ['0.063', '-0.063', '3', '3', '0', '0.13'],
  'FMT-1 精确平局远离零，-0 记作 0',
)

section('G · demo 夹具自洽')
ok(demoTasks().length === 12, 'FIX-1 12 题')
ok(demoBaseline().length === 12, 'FIX-2 baseline 12')
ok(demoCandidate().length === 12, 'FIX-3 candidate 12')

console.log()
if (failed === 0) {
  console.log(green(`  ✓ ${passed} 条断言全部通过`))
  console.log(
    dim(
      '\n  最该记住的六条：\n' +
        '    SET     缺 failToPass / 缺分层 → 主指标作废\n' +
        '    CLS     改测试 = hacked，不是 resolved\n' +
        '    RATE    海报「成功率」可能是 apply 或 f2p-only\n' +
        '    COST    最贵桶常常是空转\n' +
        '    AB      先看 onlyA/onlyB，再看净值\n' +
        '    GATE    regress=非劣；claim=优效；两门不要合成一个\n',
    ),
  )
  process.exit(0)
} else {
  console.log(red(`  ✗ ${failed} 失败 / ${passed} 通过`))
  process.exit(1)
}
