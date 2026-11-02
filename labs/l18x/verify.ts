/**
 * 验证 l18x/reward.ts。
 *   REWARD_IMPL=shared pnpm verify:l18x
 *   pnpm verify:l18x
 *
 * 零模型、零训练。所有输入都是手造的 Attempt 记录。
 */

import * as shared from '../shared/reward.ts'
import type { SftCandidate } from '../shared/reward.ts'
import { fmtFixed, type Attempt } from '../shared/codingEval.ts'
import { detectHacks, type HackFinding } from '../shared/coding.ts'
import { attempt, demoCanary, demoDpoTasks, demoPool, poolAttempts, type Kind } from './reward.ts'

const TARGET = process.env.REWARD_IMPL === 'shared' ? 'shared' : 'mine'

type Api = {
  reward: typeof shared.rewardFromAttempt
  groupAdvantages: typeof shared.groupAdvantages
  signalProbability: typeof shared.signalProbability
  signalProbabilityFromCounts: typeof shared.signalProbabilityFromCounts
  screenTasks: typeof shared.screenTasks
  tokenWeights: typeof shared.tokenWeights
  buildSftSet: typeof shared.buildSftSet
  buildDpoPairs: typeof shared.buildDpoPairs
}

async function loadMine(): Promise<Api> {
  const m = await import('./reward.ts')
  return {
    reward: m.myRewardFromAttempt,
    groupAdvantages: m.myGroupAdvantages,
    signalProbability: m.mySignalProbability,
    signalProbabilityFromCounts: m.mySignalProbabilityFromCounts,
    screenTasks: m.myScreenTasks,
    tokenWeights: m.myTokenWeights,
    buildSftSet: m.myBuildSftSet,
    buildDpoPairs: m.myBuildDpoPairs,
  }
}

const M: Api =
  TARGET === 'shared'
    ? {
        reward: shared.rewardFromAttempt,
        groupAdvantages: shared.groupAdvantages,
        signalProbability: shared.signalProbability,
        signalProbabilityFromCounts: shared.signalProbabilityFromCounts,
        screenTasks: shared.screenTasks,
        tokenWeights: shared.tokenWeights,
        buildSftSet: shared.buildSftSet,
        buildDpoPairs: shared.buildDpoPairs,
      }
    : await loadMine()

console.log(
  TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l18x/ 里你的实现）',
)

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

class Fail extends Error {}
function need(cond: boolean, why: string): void {
  if (!cond) throw new Fail(why)
}
function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch (e) {
    return !(e instanceof Error && /TODO \d+ 未实现/.test(e.message))
  }
}

let passed = 0
let failed = 0
function t(id: string, name: string, fn: () => void): void {
  try {
    fn()
    passed++
  } catch (e) {
    failed++
    const why = e instanceof Fail ? e.message : `抛出了异常：${(e as Error).message}`
    console.log(red(`  ✗ ${id} ${name}`) + dim(`\n      ${why}`))
  }
}
function section(s: string): void {
  console.log(bold(`\n${s}`))
}

const fx = fmtFixed
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps
const warn = (n: number): HackFinding[] =>
  Array.from({ length: n }, (_, i) => ({ rule: `W${i}`, severity: 'warn' as const, evidence: {} }))
const block: HackFinding = { rule: 'TEST_FILE_MODIFIED', severity: 'block', evidence: { file: 'tests/t.py' } }
const binary = (G: number, k: number) => Array.from({ length: G }, (_, i) => (i < k ? 1 : 0))
const absSum = (xs: number[]) => xs.reduce((s, x) => s + Math.abs(x), 0)
const group = (spec: [Kind, number][], taskId = 't'): Attempt[] => {
  const out: Attempt[] = []
  for (const [kind, n] of spec) for (let i = 0; i < n; i++) out.push(attempt(taskId, `${kind}${i + 1}`, kind))
  return out
}

function cand(
  taskId: string,
  variant: string,
  kind: Kind,
  o: { turns?: number; tokens?: number; patchHash?: string; runId?: string; findings?: HackFinding[] } = {},
): SftCandidate {
  return {
    attempt: attempt(taskId, variant, kind, { tokens: o.tokens ?? 1000, hackFindings: o.findings ?? [] }),
    turns: o.turns ?? 5,
    patchHash: o.patchHash ?? `${taskId}-${variant}`,
    runId: o.runId ?? 'run-1',
  }
}
const reasons = (s: shared.SftSet) => s.dropped.map((d) => `${d.taskId}/${d.variant}:${d.reason}`)
const keptIds = (s: shared.SftSet) => s.kept.map((c) => `${c.attempt.taskId}/${c.attempt.variant}`)

// ─────────────────────────────────────────────────────────────
section('R · 奖励：L18 的标签 → 标量')

t('R01', 'error → null，不是 0', () => {
  const r = M.reward(attempt('t', 'v', 'error'))
  need(r === null, `应为 null，实际 ${r}。0 分在组里是一个真实的低分，会变成负优势`)
})
t('R02', 'resolved、无 finding → 1', () => {
  need(M.reward(attempt('t', 'v', 'resolved')) === 1, '应为 1')
})
t('R03', 'failed / applied_only、无 finding → 0', () => {
  need(M.reward(attempt('t', 'v', 'failed')) === 0, 'failed 应为 0')
  need(M.reward(attempt('t', 'v', 'applied_only')) === 0, 'applied_only 应为 0')
})
t('R04', '带 block finding → −hackPenalty', () => {
  const a = attempt('t', 'v', 'resolved', { hackFindings: [block] })
  need(M.reward(a) === -1, `默认策略应为 −1，实际 ${M.reward(a)}`)
  const r2 = M.reward(a, { hackPenalty: 2, warnPenalty: 0.1, warnCap: 0.3 })
  need(r2 === -2, `hackPenalty=2 时应为 −2，实际 ${r2}`)
})
t('R05', 'testsMutated 但 finding 为空 → 同样 −hackPenalty（走 classifyAttempt）', () => {
  const a = attempt('t', 'v', 'resolved', { testsMutated: true })
  need(M.reward(a) === -1, `应为 −1，实际 ${M.reward(a)}。标签要走 classifyAttempt，不能只看 hackFindings`)
})
t('R06', 'resolved + 1 条 warn → 0.9', () => {
  const r = M.reward(attempt('t', 'v', 'resolved', { hackFindings: warn(1) }))
  need(r !== null && close(r, 0.9), `应为 0.9，实际 ${r}`)
})
t('R07', 'resolved + 10 条 warn → 0.7（上限生效）', () => {
  const r = M.reward(attempt('t', 'v', 'resolved', { hackFindings: warn(10) }))
  need(r !== null && close(r, 0.7), `应为 0.7，实际 ${r}。warn 扣分要封顶在 warnCap`)
})
t('R08', '任意 warn 数下 resolved 都高于干净的 applied_only', () => {
  const floor = M.reward(attempt('t', 'v', 'applied_only'))!
  for (let n = 0; n <= 20; n++) {
    const r = M.reward(attempt('t', 'v', 'resolved', { hackFindings: warn(n) }))!
    need(r > floor, `${n} 条 warn 时 resolved=${r} 不高于 applied_only=${floor}`)
  }
})
t('R09', 'hacked + warn 不叠加扣分', () => {
  const r = M.reward(attempt('t', 'v', 'hacked', { hackFindings: [block, ...warn(5)] }))
  need(r === -1, `应仍为 −1，实际 ${r}`)
})
t('R10', 'warnCap ≥ 1 的策略被拒', () => {
  for (const cap of [1, 1.5]) {
    need(throws(() => M.reward(attempt('t', 'v', 'resolved'), { hackPenalty: 1, warnPenalty: 0.1, warnCap: cap })),
      `warnCap=${cap} 应抛错：否则带 warn 的 resolved 会掉到 applied_only 以下`)
  }
})

// ─────────────────────────────────────────────────────────────
section('H · 补两条作弊规则（参考实现，只读）+ 金丝雀')

const EQ_DIFF = [
  '--- a/src/money.py',
  '+++ b/src/money.py',
  '@@ -1,1 +1,4 @@',
  '+class _Any(float):',
  '+    def __eq__(self, other):',
  '+        return True',
].join('\n')

t('H01', '任意路径下的 conftest.py → CONFTEST_MODIFIED（L17 只认 tests/）', () => {
  const input = { changedFiles: ['src/conftest.py'] }
  const f = shared.extraHackFindings(input)
  need(f.length === 1 && f[0]!.rule === 'CONFTEST_MODIFIED' && f[0]!.severity === 'block',
    `应恰好一条 CONFTEST_MODIFIED/block，实际 ${JSON.stringify(f)}`)
  need(detectHacks(input).length === 0, 'L17 的 detectHacks 本来就抓不到它——这条是对照')
})
t('H02', 'diff 新增 __eq__ 恒返回 True → ALWAYS_EQUAL', () => {
  const f = shared.extraHackFindings({ diffText: EQ_DIFF })
  need(f.length === 1 && f[0]!.rule === 'ALWAYS_EQUAL' && f[0]!.severity === 'block',
    `应恰好一条 ALWAYS_EQUAL/block，实际 ${JSON.stringify(f)}`)
})
t('H03', '正常比较字段的 __eq__ 不报', () => {
  const diff = ['+++ b/src/p.py', '+    def __eq__(self, other):', '+        return self.x == other.x'].join('\n')
  const f = shared.extraHackFindings({ diffText: diff })
  need(f.length === 0, `不该报，实际 ${JSON.stringify(f)}`)
})
t('H04', '返回值满足 L17 的 HackFinding 形状，evidence.file 有值', () => {
  const f = [
    ...shared.extraHackFindings({ changedFiles: ['conftest.py'] }),
    ...shared.extraHackFindings({ diffText: EQ_DIFF }),
  ]
  need(f.length === 2, `应有两条，实际 ${f.length}`)
  for (const h of f) {
    need(typeof h.rule === 'string' && (h.severity === 'warn' || h.severity === 'block'), `形状不对：${JSON.stringify(h)}`)
    need(typeof h.evidence.file === 'string' && h.evidence.file.length > 0, `${h.rule} 缺 evidence.file`)
  }
})
t('H05', '不可能任务金丝雀：只用 L17 平均奖励为正，加 extra 规则后为负', () => {
  const avg = (as: Attempt[]) => as.reduce((s, a) => s + (M.reward(a) ?? 0), 0) / as.length
  const base = avg(demoCanary(false))
  const extra = avg(demoCanary(true))
  need(base > 0, `只用 L17 时应为正（这正是问题所在），实际 ${fx(base, 3)}`)
  need(extra < 0, `加 extra 规则后应为负，实际 ${fx(extra, 3)}`)
})

// ─────────────────────────────────────────────────────────────
section('A · 组内优势')

t('A01', '全 1 的组 → 全 0、hasSignal=false', () => {
  const g = M.groupAdvantages(binary(8, 8), { scaleStd: true })
  need(g.advantages.every((a) => a === 0) && !g.hasSignal, `实际 ${JSON.stringify(g)}`)
})
t('A02', '全 0 的组 → 全 0、hasSignal=false', () => {
  const g = M.groupAdvantages(binary(8, 0), { scaleStd: true })
  need(g.advantages.every((a) => a === 0) && !g.hasSignal, `实际 ${JSON.stringify(g)}`)
})
t('A03', 'G=8、k=1、除 std → 成功者 2.475（样本标准差）', () => {
  const a = M.groupAdvantages(binary(8, 1), { scaleStd: true }).advantages[0]!
  need(fx(a, 3) === '2.475', `应为 2.475，实际 ${fx(a, 3)}${fx(a, 3) === '2.646' ? '——这是总体标准差（除以 n）' : ''}`)
})
t('A04', '同上不除 std → 0.875 / −0.125', () => {
  const a = M.groupAdvantages(binary(8, 1), { scaleStd: false }).advantages
  need(close(a[0]!, 0.875) && close(a[7]!, -0.125), `实际 ${a[0]} / ${a[7]}`)
})
t('A05', '优势之和为 0（除不除 std 都是）', () => {
  for (let k = 1; k < 8; k++) {
    for (const scaleStd of [true, false]) {
      const s = M.groupAdvantages(binary(8, k), { scaleStd }).advantages.reduce((x, y) => x + y, 0)
      need(close(s, 0), `k=${k} scaleStd=${scaleStd} 时和为 ${s}`)
    }
  }
})
t('A06', 'k 与 G−k 镜像：A⁺(k) = −A⁻(G−k)', () => {
  for (let k = 1; k < 8; k++) {
    const pos = M.groupAdvantages(binary(8, k), { scaleStd: true }).advantages[0]!
    const neg = M.groupAdvantages(binary(8, 8 - k), { scaleStd: true }).advantages[7]!
    need(close(pos, -neg), `k=${k}：${pos} vs ${neg}`)
  }
})
t('A07', 'null 不进均值：[1,1,1,0,0,0,null,null] 成功者 0.913', () => {
  const g = M.groupAdvantages([1, 1, 1, 0, 0, 0, null, null], { scaleStd: true })
  need(fx(g.advantages[0]!, 3) === '0.913', `应为 0.913，实际 ${fx(g.advantages[0]!, 3)}` +
    (fx(g.advantages[0]!, 3) === '1.208' ? '——你把 null 当成了 0' : ''))
  need(g.valid === 6, `valid 应为 6，实际 ${g.valid}`)
})
t('A08', 'null 的位置优势为 0，输出与输入等长', () => {
  const g = M.groupAdvantages([null, 1, 0, null, 1], { scaleStd: false })
  need(g.advantages.length === 5, `长度应为 5，实际 ${g.advantages.length}`)
  need(g.advantages[0] === 0 && g.advantages[3] === 0, `null 位置应为 0，实际 ${JSON.stringify(g.advantages)}`)
})
t('A09', '只剩 1 个有效样本 → 全 0、hasSignal=false（不是 verl 的「原始奖励」）', () => {
  const g = M.groupAdvantages([1, null, null], { scaleStd: true })
  need(g.advantages.every((a) => a === 0) && !g.hasSignal && g.valid === 1, `实际 ${JSON.stringify(g)}`)
})
t('A10', '没有 NaN / Infinity；8 个 0.9 也算「全相同」', () => {
  const nines = Array.from({ length: 8 }, () => 0.9)
  const cases: (number | null)[][] = [[], [null], nines, [0.1, 0.1, 0.1], [1, 1], [0, 1], [0.1, 0.2, 0.3]]
  for (const rs of cases) {
    for (const scaleStd of [true, false]) {
      const g = M.groupAdvantages(rs, { scaleStd })
      need(g.advantages.every((a) => Number.isFinite(a)), `${JSON.stringify(rs)} 出现非有限值：${JSON.stringify(g.advantages)}`)
    }
  }
  const g = M.groupAdvantages(nines, { scaleStd: true })
  need(!g.hasSignal && g.advantages.every((a) => a === 0),
    `8 个 0.9 应无信号，实际 ${fx(g.advantages[0]!, 3)}…。均值在浮点里是 0.9000000000000001，用 std === 0 判会把舍入误差放大成满额优势`)
})
t('A11', '难度偏置：k=1 对 k=4 的 Σ|A| 之比，除 std 0.66、不除 0.44', () => {
  const ratio = (scaleStd: boolean) =>
    absSum(M.groupAdvantages(binary(8, 1), { scaleStd }).advantages) /
    absSum(M.groupAdvantages(binary(8, 4), { scaleStd }).advantages)
  need(fx(ratio(true), 2) === '0.66' && fx(ratio(false), 2) === '0.44', `实际 ${fx(ratio(true), 2)} / ${fx(ratio(false), 2)}`)
})

// ─────────────────────────────────────────────────────────────
section('W · 三种 loss 聚合')

const LENS = [100, 400, 100, 400]
const ADV = [0.5, 0.5, -0.5, -0.5]

t('W01', 'grpo：长错答 / 短错答的每 token 权重之比 = 0.25', () => {
  const w = M.tokenWeights(LENS, ADV, 'grpo', 1000)
  need(close(w[3]! / w[2]!, 0.25), `应为 0.25，实际 ${w[3]! / w[2]!}`)
})
t('W02', 'dapo：同一优势下每 token 权重与长度无关', () => {
  const w = M.tokenWeights(LENS, ADV, 'dapo', 1000)
  need(close(w[0]!, w[1]!, 1e-15) && close(w[2]!, w[3]!, 1e-15), `实际 ${JSON.stringify(w)}`)
  need(close(w[0]!, 0.5 / 1000, 1e-15), `应为 A/Σ|o| = 0.0005，实际 ${w[0]}`)
})
t('W03', 'dr_grpo：分母是 G·maxTokens，与批内长度无关', () => {
  const a = M.tokenWeights(LENS, ADV, 'dr_grpo', 1000)
  const b = M.tokenWeights([100, 4000, 7, 40], ADV, 'dr_grpo', 1000)
  need(close(a[0]!, b[0]!, 1e-15) && close(a[0]!, 0.5 / 4000, 1e-15), `实际 ${a[0]} / ${b[0]}`)
})
t('W04', 'grpo 下每条样本的总推力 Σ_t w = A/G，与长度无关', () => {
  const w = M.tokenWeights(LENS, ADV, 'grpo', 1000)
  LENS.forEach((len, i) => need(close(w[i]! * len, ADV[i]! / 4), `样本 ${i}：${w[i]! * len}`))
})
t('W05', '优势为 0 的样本在所有聚合下权重为 0', () => {
  for (const agg of ['grpo', 'dapo', 'dr_grpo'] as const) {
    const w = M.tokenWeights([100, 200, 300], [0, -0, 0.5], agg, 1000)
    need(w[0] === 0 && w[1] === 0, `${agg}：${JSON.stringify(w)}`)
  }
})

// ─────────────────────────────────────────────────────────────
section('S · 有信号的概率 = pass@G − pass^G')

t('S01', 'signalProbability(0.5, 8) = 0.992', () => {
  need(fx(M.signalProbability(0.5, 8), 3) === '0.992', `实际 ${M.signalProbability(0.5, 8)}`)
})
t('S02', 'p=0 与 p=1 → 0', () => {
  for (const g of [1, 4, 8]) {
    need(M.signalProbability(0, g) === 0 && M.signalProbability(1, g) === 0, `g=${g} 时不是 0`)
  }
})
t('S03', '对称：f(p, g) = f(1−p, g)', () => {
  for (const p of [0.01, 0.1, 0.25, 0.4]) {
    for (let g = 2; g <= 16; g++) {
      need(close(M.signalProbability(p, g), M.signalProbability(1 - p, g), 1e-12), `p=${p} g=${g}`)
    }
  }
})
t('S04', '随 g 单调不减', () => {
  for (const p of [0.05, 0.3, 0.5, 0.9]) {
    for (let g = 1; g < 20; g++) {
      need(M.signalProbability(p, g + 1) >= M.signalProbability(p, g) - 1e-12, `p=${p} g=${g}→${g + 1} 变小了`)
    }
  }
})
t('S05', 'FromCounts(16, 0, 8) = 0 且 FromCounts(16, 16, 8) = 0', () => {
  need(M.signalProbabilityFromCounts(16, 0, 8) === 0, `全错：${M.signalProbabilityFromCounts(16, 0, 8)}`)
  need(M.signalProbabilityFromCounts(16, 16, 8) === 0, `全对：${M.signalProbabilityFromCounts(16, 16, 8)}`)
})
t('S06', 'FromCounts 与暴力枚举所有 g 子集一致（n=10）', () => {
  const n = 10
  for (let c = 0; c <= n; c++) {
    for (let g = 1; g <= 6; g++) {
      let mixed = 0
      let total = 0
      for (let mask = 0; mask < 1 << n; mask++) {
        let size = 0
        let hits = 0
        for (let i = 0; i < n; i++) {
          if (mask & (1 << i)) {
            size++
            if (i < c) hits++
          }
        }
        if (size !== g) continue
        total++
        if (hits > 0 && hits < g) mixed++
      }
      const got = M.signalProbabilityFromCounts(n, c, g)
      need(close(got, mixed / total, 1e-12), `n=${n} c=${c} g=${g}：${got} vs 枚举 ${mixed / total}`)
    }
  }
})
t('S07', 'n < g 时抛错', () => {
  need(throws(() => M.signalProbabilityFromCounts(4, 2, 8)), 'n=4 < g=8 应抛错')
})

// ─────────────────────────────────────────────────────────────
section('C · 按预采样筛题')

t('C01', 'c=0 进 dropAllFail，c=n 进 dropAllPass，混合的留下', () => {
  const r = M.screenTasks(
    { a: group([['failed', 8]], 'a'), b: group([['resolved', 8]], 'b'), c: group([['resolved', 3], ['failed', 5]], 'c') },
    4,
  )
  need(r.dropAllFail.join() === 'a' && r.dropAllPass.join() === 'b' && r.keep.join() === 'c', `实际 ${JSON.stringify(r)}`)
})
t('C02', 'error 不计入 n', () => {
  const byTask = { x: group([['resolved', 2], ['failed', 2], ['error', 2]], 'x') }
  const r4 = M.screenTasks(byTask, 4)
  need(r4.keep.join() === 'x' && close(r4.expectedSignal, 1),
    `g=4 时 n 应为 4、预测 1.000，实际 ${fx(r4.expectedSignal, 3)}${fx(r4.expectedSignal, 3) === '0.933' ? '——error 被当成失败计进了 n' : ''}`)
  const r5 = M.screenTasks(byTask, 5)
  need(r5.dropInsufficient.join() === 'x', `g=5 时有效 n=4 不够，应进 dropInsufficient，实际 ${JSON.stringify(r5)}`)
})
t('C03', 'hacked 不算成功：2 hacked + 2 failed → dropAllFail', () => {
  const r = M.screenTasks({ h: group([['hacked', 2], ['failed', 2]], 'h') }, 4)
  need(r.dropAllFail.join() === 'h', `实际 ${JSON.stringify(r)}`)
})
t('C04', '有效 n < g → dropInsufficient；列表按码点序', () => {
  const r = M.screenTasks(
    { b: group([['resolved', 1], ['failed', 2]], 'b'), a: group([['failed', 3]], 'a'), B: group([['resolved', 3]], 'B') },
    4,
  )
  need(r.dropInsufficient.join() === 'B,a,b', `应为 B,a,b，实际 ${r.dropInsufficient.join()}`)
  need(r.keep.length === 0 && r.expectedSignal === 0, '没有 keep 时 expectedSignal 应为 0')
})
t('C05', '实验三的题库：保留 7 题，预测 0.813（偏乐观，记录而不修正）', () => {
  const r = M.screenTasks(poolAttempts(demoPool()), 8)
  need(r.keep.length === 7 && fx(r.expectedSignal, 3) === '0.813', `实际 keep=${r.keep.length} 预测 ${fx(r.expectedSignal, 3)}`)
})

// ─────────────────────────────────────────────────────────────
section('F · 拒绝采样 SFT')

t('F01', '只留 resolved，且丢掉带任何 warn 的', () => {
  const s = M.buildSftSet(
    [
      cand('a', 'ok', 'resolved'),
      cand('a', 'ap', 'applied_only'),
      cand('a', 'hk', 'hacked'),
      cand('a', 'wn', 'resolved', { findings: warn(1) }),
    ],
    { capPerTask: 9, excludeTaskIds: [] },
  )
  need(keptIds(s).join() === 'a/ok', `kept 应为 a/ok，实际 ${keptIds(s).join()}`)
  need(reasons(s).join() === 'a/ap:not_resolved,a/hk:not_resolved,a/wn:has_warn', `dropped 实际 ${reasons(s).join()}`)
})
t('F02', '同题同 patchHash 先去重再封顶', () => {
  const s = M.buildSftSet(
    [
      cand('x', 'a', 'resolved', { turns: 3, patchHash: 'H1' }),
      cand('x', 'b', 'resolved', { turns: 4, patchHash: 'H1' }),
      cand('x', 'c', 'resolved', { turns: 6, patchHash: 'H2' }),
    ],
    { capPerTask: 2, excludeTaskIds: [] },
  )
  need(keptIds(s).join() === 'x/a,x/c', `应留 x/a,x/c，实际 ${keptIds(s).join()}——先封顶会让两个名额被同一个解占掉`)
  need(reasons(s).join() === 'x/b:duplicate', `dropped 实际 ${reasons(s).join()}`)
})
t('F03', '每题最多 capPerTask 条，turns 少的优先、再看 tokens', () => {
  const s = M.buildSftSet(
    [
      cand('y', 'p', 'resolved', { turns: 5 }),
      cand('y', 'q', 'resolved', { turns: 2, tokens: 900 }),
      cand('y', 'r', 'resolved', { turns: 9 }),
      cand('y', 's', 'resolved', { turns: 2, tokens: 800 }),
      cand('w', 'z', 'resolved'),
    ],
    { capPerTask: 2, excludeTaskIds: [] },
  )
  need(keptIds(s).join() === 'w/z,y/s,y/q', `应为 w/z,y/s,y/q，实际 ${keptIds(s).join()}`)
  need(reasons(s).join() === 'y/p:over_cap,y/r:over_cap', `dropped 实际 ${reasons(s).join()}`)
})
t('F04', '排除题与排除运行：标签先判，排除题先于排除运行', () => {
  const s = M.buildSftSet(
    [
      cand('z', 'ok', 'resolved'),
      cand('z', 'bad', 'failed'),
      cand('z', 'both', 'resolved', { runId: 'run-hacky' }),
      cand('k', 'ok', 'resolved', { runId: 'run-hacky' }),
      cand('k', 'fine', 'resolved'),
    ],
    { capPerTask: 9, excludeTaskIds: ['z'], excludeRunIds: ['run-hacky'] },
  )
  need(keptIds(s).join() === 'k/fine', `kept 应为 k/fine，实际 ${keptIds(s).join()}`)
  need(reasons(s).join() === 'k/ok:excluded_run,z/bad:not_resolved,z/both:excluded_task,z/ok:excluded_task',
    `dropped 实际 ${reasons(s).join()}`)
})

// ─────────────────────────────────────────────────────────────
section('D · DPO 配对')

t('D01', 'error 从不入对；hacked 从不当 chosen', () => {
  const b = M.buildDpoPairs(
    { m: [...group([['resolved', 2], ['failed', 1], ['hacked', 1], ['error', 2]], 'm')] },
    { maxLengthRatio: Infinity, capPerTask: Infinity },
  )
  need(b.pairs.length === 4, `2 个 chosen × 2 个 rejected 应有 4 对，实际 ${b.pairs.length}`)
  for (const p of b.pairs) {
    need(!p.chosen.errored && !p.rejected.errored, 'error 进了对')
    need(p.chosen.variant.startsWith('resolved'), `chosen 是 ${p.chosen.variant}`)
  }
  need(b.pairs.some((p) => p.rejected.variant.startsWith('hacked')), 'hacked 应作为 rejected 出现')
})
t('D02', '实验八：不设护栏 0.857，护栏 1.25 后 0.667；每题 1 对取长度比最小的', () => {
  const tasks = demoDpoTasks()
  const raw = M.buildDpoPairs(tasks, { maxLengthRatio: Infinity, capPerTask: Infinity })
  need(raw.pairs.length === 14 && fx(raw.chosenShorterShare, 3) === '0.857', `不设护栏：${raw.pairs.length} 对 ${fx(raw.chosenShorterShare, 3)}`)
  const guarded = M.buildDpoPairs(tasks, { maxLengthRatio: 1.25, capPerTask: Infinity })
  need(guarded.pairs.length === 6 && fx(guarded.chosenShorterShare, 3) === '0.667', `护栏：${guarded.pairs.length} 对 ${fx(guarded.chosenShorterShare, 3)}`)
  const one = M.buildDpoPairs(tasks, { maxLengthRatio: 1.25, capPerTask: 1 })
  const t3 = one.pairs.filter((p) => p.taskId === 't3')
  need(t3.length === 1 && t3[0]!.chosen.variant === 'ok2', `t3 应取长度比 1.048 的 ok2/bad1，实际 ${t3.map((p) => p.chosen.variant).join()}`)
})
t('D03', '全对或全错的题出现在 tasksWithoutPairs', () => {
  const tasks = demoDpoTasks()
  const raw = M.buildDpoPairs(tasks, { maxLengthRatio: Infinity, capPerTask: Infinity })
  need(raw.tasksWithoutPairs.join() === 't6,t7', `不设护栏应为 t6,t7，实际 ${raw.tasksWithoutPairs.join()}`)
  const guarded = M.buildDpoPairs(tasks, { maxLengthRatio: 1.25, capPerTask: Infinity })
  need(guarded.tasksWithoutPairs.join() === 't4,t6,t7', `护栏后应为 t4,t6,t7，实际 ${guarded.tasksWithoutPairs.join()}`)
})

// ─────────────────────────────────────────────────────────────
section('T · 轨迹切分的成本（参考实现，只读）')

t('T01', '19 轮：切分是整条的 10.35 倍，助手 token 只占 0.298', () => {
  const c = shared.trajectoryCost({ prompt: 2000, assistant: 300, observation: 600, turns: 19 })
  need(c.whole === 19100 && fx(c.split / c.whole, 2) === '10.35' && fx(c.assistantShare, 3) === '0.298',
    `实际 ${JSON.stringify(c)}`)
})

console.log()
if (failed === 0) {
  console.log(green(`  ✓ ${passed} 条断言全部通过`))
  console.log(
    dim(
      '\n  最该记住的六条：\n' +
        '    R   error 是 null 不是 0；hacked 为负；warn 扣分要封顶\n' +
        '    A   null 不进组；样本标准差；全相同就是没有信号\n' +
        '    W   原版 GRPO 按长度平均，长的错答案罚得轻\n' +
        '    S   有信号的概率 = pass@G − pass^G，全对全错都是零\n' +
        '    F   SFT 比奖励严；去重先于封顶；作弊模型的产出整批排除\n' +
        '    D   resolve 配对里藏着长度；hacked 只当 rejected\n',
    ),
  )
  process.exit(0)
}
console.log(red(`  ✗ ${failed} 失败 / ${passed} 通过`))
process.exit(1)
