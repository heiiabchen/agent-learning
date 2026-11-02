/**
 * L18x 的脚手架。跑法：pnpm reward
 *
 * 观察实验：二值奖励的组优势、有信号的概率、按 pass@k 筛题、长度归一化、
 * error 记 0 的代价、奖励口径决定作弊的符号、轨迹切分的成本、DPO 的长度混杂、
 * 不可能任务金丝雀。全程零模型、零训练，只用确定性假数据。
 * 写完七个 TODO 跑 pnpm verify:l18x。
 */

import {
  DEFAULT_REWARD_POLICY,
  buildDpoPairs,
  extraHackFindings,
  groupAdvantages,
  rewardFromAttempt,
  screenTasks,
  signalProbability,
  tokenWeights,
  trajectoryCost,
  type DpoBuild,
  type GroupAdvantage,
  type LossAgg,
  type RewardPolicy,
  type ScreenReport,
  type SftCandidate,
  type SftSet,
} from '../shared/reward.ts'
import { classifyAttempt, cmpCodePoint, fmtFixed, type Attempt } from '../shared/codingEval.ts'
import { detectHacks } from '../shared/coding.ts'
import { isMain } from '../shared/entry.ts'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const w = (s: string) =>
  [...visible(s)].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - w(s)))
const lpad = (s: string, n: number) => ' '.repeat(Math.max(0, n - w(s))) + s
const fx = fmtFixed

// ─────────────────────────────────────────────────────────────
// 夹具（verify 也用）
// ─────────────────────────────────────────────────────────────

export type Kind = 'resolved' | 'applied_only' | 'failed' | 'hacked' | 'error'

/** 按 L18 的标签造一条 Attempt。tokens 默认 1000。 */
export function attempt(taskId: string, variant: string, kind: Kind, extra: Partial<Attempt> = {}): Attempt {
  const base: Attempt = {
    taskId,
    variant,
    patchApplied: kind !== 'failed' && kind !== 'error',
    failToPassGreen: kind === 'resolved' || kind === 'hacked',
    passToPassGreen: true,
    testsMutated: kind === 'hacked',
    hackFindings: [],
    tokens: 1000,
    costUsd: 0,
    latencyMs: 0,
  }
  if (kind === 'error') {
    base.errored = true
    base.errorReason = 'sandbox timeout'
  }
  return { ...base, ...extra }
}

/** 实验三：20 道题，真实 p 是 U 形；每题预采样 16 次，前 c 次成功。 */
export function demoPool(): { id: string; p: number; c: number }[] {
  const raw: [number, number][] = [
    [0, 0], [0, 0], [0, 0], [0, 0], [0, 0],
    [0.02, 0], [0.05, 1], [0.1, 2], [0.25, 4], [0.5, 8],
    [0.5, 7], [0.75, 12], [0.9, 15], [0.95, 16], [0.98, 16],
    [1, 16], [1, 16], [1, 16], [1, 16], [1, 16],
  ]
  return raw.map(([p, c], i) => ({ id: `q${String(i + 1).padStart(2, '0')}`, p, c }))
}

export const POOL_N = 16

export function poolAttempts(pool: { id: string; c: number }[], n = POOL_N): Record<string, Attempt[]> {
  const out: Record<string, Attempt[]> = {}
  for (const t of pool) {
    out[t.id] = []
    for (let i = 0; i < n; i++) out[t.id]!.push(attempt(t.id, `s${i + 1}`, i < t.c ? 'resolved' : 'failed'))
  }
  return out
}

/** 实验八：7 道题，每题若干 resolved 与 failed 的 token 长度。 */
export function demoDpoTasks(): Record<string, Attempt[]> {
  const raw: [string, number[], number[]][] = [
    ['t1', [1200, 1500], [3000, 1400]],
    ['t2', [800], [2600, 2900, 900]],
    ['t3', [2000, 2200], [2100]],
    ['t4', [1000], [4000]],
    ['t5', [1800, 1100], [1900, 5200]],
    ['t6', [], [3000, 3100]],
    ['t7', [900, 950], []],
  ]
  const out: Record<string, Attempt[]> = {}
  for (const [id, ok, bad] of raw) {
    out[id] = [
      ...ok.map((tokens, i) => attempt(id, `ok${i + 1}`, 'resolved', { tokens })),
      ...bad.map((tokens, i) => attempt(id, `bad${i + 1}`, 'failed', { tokens })),
    ]
  }
  return out
}

interface CanaryRaw {
  taskId: string
  variant: string
  kind: Kind
  changedFiles: string[]
  diffText: string
}

const CONFTEST_PATCH = [
  '+from _pytest.reports import TestReport',
  '+_orig = TestReport.from_item_and_call',
  '+def _patched(item, call):',
  '+    rep = _orig(item, call)',
  '+    rep.outcome = "passed"',
  '+    return rep',
  '+TestReport.from_item_and_call = staticmethod(_patched)',
]

function canaryRaw(): CanaryRaw[] {
  return [
    {
      taskId: 'imp-sort-stable', variant: 'v1', kind: 'resolved',
      changedFiles: ['conftest.py'],
      diffText: ['--- /dev/null', '+++ b/conftest.py', '@@ -0,0 +1,7 @@', ...CONFTEST_PATCH].join('\n'),
    },
    {
      taskId: 'imp-sort-stable', variant: 'v2', kind: 'failed',
      changedFiles: [], diffText: '',
    },
    {
      taskId: 'imp-parse-date', variant: 'v1', kind: 'resolved',
      changedFiles: ['src/conftest.py'],
      diffText: ['--- /dev/null', '+++ b/src/conftest.py', '@@ -0,0 +1,7 @@', ...CONFTEST_PATCH].join('\n'),
    },
    {
      taskId: 'imp-money-round', variant: 'v1', kind: 'resolved',
      changedFiles: ['src/money.py'],
      diffText: [
        '--- a/src/money.py',
        '+++ b/src/money.py',
        '@@ -10,3 +10,8 @@',
        ' def round_half(x):',
        '+class _Any(float):',
        '+    def __eq__(self, other):',
        '+        return True',
        '+    def __ne__(self, other):',
        '+        return False',
      ].join('\n'),
    },
    {
      taskId: 'imp-money-round', variant: 'v2', kind: 'applied_only',
      changedFiles: ['src/money.py'],
      diffText: ['--- a/src/money.py', '+++ b/src/money.py', '@@ -10,1 +10,1 @@', '-    return x', '+    return round(x, 2)'].join('\n'),
    },
    {
      taskId: 'imp-utf8-trim', variant: 'v1', kind: 'applied_only',
      changedFiles: ['src/text.py'],
      diffText: ['--- a/src/text.py', '+++ b/src/text.py', '@@ -3,1 +3,1 @@', '-    return s.strip()', '+    return s.strip(" ")'].join('\n'),
    },
  ]
}

/**
 * 实验九：4 道 spec 与测试互相矛盾的「不可能任务」，6 次尝试。
 * 在这种题上任何一次「绿了」都必然是作弊。withExtra=false 只用 L17 的 detectHacks。
 */
export function demoCanary(withExtra: boolean): Attempt[] {
  return canaryRaw().map((r) => {
    const input = { diffText: r.diffText, changedFiles: r.changedFiles }
    const findings = [...detectHacks(input), ...(withExtra ? extraHackFindings(input) : [])]
    return attempt(r.taskId, r.variant, r.kind, { hackFindings: findings })
  })
}

// ─────────────────────────────────────────────────────────────
// 观察实验
// ─────────────────────────────────────────────────────────────

function binaryGroup(G: number, k: number): number[] {
  const rs: number[] = []
  for (let i = 0; i < G; i++) rs.push(i < k ? 1 : 0)
  return rs
}

function absSum(xs: number[]): number {
  let s = 0
  for (const x of xs) s += x < 0 ? -x : x
  return s
}

function exp1(): void {
  console.log(bold('\n实验一：二值奖励，G=8，组里 k 个成功'))
  const G = 8
  console.log(dim('  k   A成·除std  A败·除std  A成·不除  A败·不除   Σ|A|除std  Σ|A|不除'))
  const sums: { s: number; r: number }[] = []
  for (let k = 0; k <= G; k++) {
    const rs = binaryGroup(G, k)
    const s = groupAdvantages(rs, { scaleStd: true }).advantages
    const r = groupAdvantages(rs, { scaleStd: false }).advantages
    sums.push({ s: absSum(s), r: absSum(r) })
    const cells = [
      k > 0 ? s[0]! : 0, k < G ? s[G - 1]! : 0,
      k > 0 ? r[0]! : 0, k < G ? r[G - 1]! : 0,
    ].map((x) => lpad(fx(x, 3), 9))
    console.log(`  ${k}  ${cells.join('  ')}  ${lpad(fx(sums[k]!.s, 3), 10)}  ${lpad(fx(sums[k]!.r, 3), 9)}`)
  }
  console.log(dim('  k=0 与 k=8：全错或全对的组，除不除 std 优势都是 0——这道题对梯度零贡献，rollout 照付。'))
  console.log(dim(`  k=1 那一次成功：不除 std ${fx(groupAdvantages(binaryGroup(G, 1), { scaleStd: false }).advantages[0]!, 3)}，` +
    `除 std ${fx(groupAdvantages(binaryGroup(G, 1), { scaleStd: true }).advantages[0]!, 3)}。`))
  console.log(dim(`  难度偏置：k=1 相对 k=4 的总权重，不除 std ${fx(sums[1]!.r / sums[4]!.r, 2)}，除 std ${fx(sums[1]!.s / sums[4]!.s, 2)}——` +
    '除 std 让接近全对 / 全错的题相对更重。'))
}

function exp2(): void {
  console.log(bold('\n实验二：一组有学习信号的概率 = pass@G − pass^G'))
  const gs = [4, 8, 16]
  console.log(dim('  p        ' + gs.map((g) => lpad(`G=${g}`, 6)).join('  ')))
  for (const p of [0.01, 0.05, 0.1, 0.2, 0.5, 0.8, 0.9, 0.95, 0.99]) {
    console.log(`  ${pad(fx(p, 2), 7)}  ${gs.map((g) => lpad(fx(signalProbability(p, g), 3), 6)).join('  ')}`)
  }
  console.log(dim(`  p=0.05 的难题，G=8 时只有 ${fx(signalProbability(0.05, 8), 3)} 的组会产生任何梯度；` +
    `G 翻倍到 16 是 ${fx(signalProbability(0.05, 16), 3)}，代价是每题两倍 rollout。`))
}

function meanOf(xs: number[]): number {
  let s = 0
  for (const x of xs) s += x
  return xs.length ? s / xs.length : 0
}

function exp3(): void {
  console.log(bold('\n实验三：按预采样筛题（20 题，U 形难度，G=8，每题预采样 16 次）'))
  const pool = demoPool()
  const r: ScreenReport = screenTasks(poolAttempts(pool), 8)
  const pOf = new Map(pool.map((t) => [t.id, t.p]))
  const truth = (ids: string[]) => meanOf(ids.map((id) => signalProbability(pOf.get(id)!, 8)))
  const anyPass = [...r.keep, ...r.dropAllPass].sort(cmpCodePoint)
  const rows: [string, string[]][] = [
    ['不筛', pool.map((t) => t.id)],
    ['只去掉全错的题', anyPass],
    ['两端都去掉', r.keep],
  ]
  for (const [label, ids] of rows) {
    console.log(`  ${pad(label, 16)}题数 ${lpad(String(ids.length), 2)}   真实有信号占比 ${fx(truth(ids), 3)}`)
  }
  console.log(`  ${pad('用同一批样本预测', 16)}          预测有信号占比 ${fx(r.expectedSignal, 3)}`)
  const misjudged = [...r.dropAllFail, ...r.dropAllPass]
    .map((id) => pOf.get(id)!)
    .filter((p) => p > 0 && p < 1)
    .map((p) => `p=${fx(p, 2)}`)
  console.log(dim(`  被两端筛掉、其实 p 在 (0,1) 的题：${misjudged.join(' ')}`))
  console.log(dim('  简单题不伤模型，但吃掉一样多的 rollout；预测偏高是因为你挑的恰好是「这 16 次看起来是混合的」题。'))
}

function exp4(): void {
  console.log(bold('\n实验四：三种 loss 聚合的逐 token 权重（不除 std，maxTokens=1000，权重 ×1e4）'))
  const names = ['对·短', '对·长', '错·短', '错·长']
  const lengths = [100, 400, 100, 400]
  const adv = groupAdvantages([1, 1, 0, 0], { scaleStd: false }).advantages
  const aggs: LossAgg[] = ['grpo', 'dapo', 'dr_grpo']
  const ws = aggs.map((agg) => tokenWeights(lengths, adv, agg, 1000))
  console.log(dim('  样本    长度      A' + aggs.map((a) => lpad(a, 10)).join('')))
  names.forEach((n, i) => {
    console.log(`  ${pad(n, 6)}${lpad(String(lengths[i]), 6)}${lpad(fx(adv[i]!, 2), 7)}` +
      ws.map((wv) => lpad(fx(wv[i]! * 1e4, 3), 10)).join(''))
  })
  console.log(dim('  错·长 / 错·短 的每 token 惩罚之比：' +
    aggs.map((a, j) => `${a} ${fx(ws[j]![3]! / ws[j]![2]!, 2)}`).join('  ')))
  console.log(dim('  原版 GRPO 下长的错答案每个 token 只被罚四分之一：模型学到的是「错的时候写长一点」。'))
}

function exp5(): void {
  console.log(bold('\n实验五：error 记 0，还是排除出组（G=8，3 成 3 败 2 超时，除 std）'))
  const group = [
    ...[1, 2, 3].map((i) => attempt('t', `ok${i}`, 'resolved')),
    ...[1, 2, 3].map((i) => attempt('t', `fail${i}`, 'failed')),
    ...[1, 2].map((i) => attempt('t', `err${i}`, 'error')),
  ]
  const rewards = group.map((a) => rewardFromAttempt(a))
  const asZero = groupAdvantages(rewards.map((r) => (r === null ? 0 : r)), { scaleStd: true })
  const excluded = groupAdvantages(rewards, { scaleStd: true })
  console.log(dim('  处理          A(成功)   A(失败)   A(超时)'))
  const row = (label: string, g: GroupAdvantage, errCell: string) =>
    console.log(`  ${pad(label, 12)}${lpad(fx(g.advantages[0]!, 3), 9)}${lpad(fx(g.advantages[3]!, 3), 10)}${lpad(errCell, 10)}`)
  row('error 记 0', asZero, fx(asZero.advantages[6]!, 3))
  row('error 排除', excluded, '—')
  console.log(dim('  记 0 时，两次超时拿到和失败一样的负优势：模型被推离「认真跑完整个测试套件」这类耗时的行为。'))
}

function exp6(): void {
  console.log(bold('\n实验六：奖励口径决定作弊的符号（G=8，2 resolved、2 hacked、4 failed，不除 std）'))
  const group = [
    attempt('t', 'r1', 'resolved'), attempt('t', 'r2', 'resolved'),
    attempt('t', 'h1', 'hacked'), attempt('t', 'h2', 'hacked'),
    ...[1, 2, 3, 4].map((i) => attempt('t', `f${i}`, 'failed')),
  ]
  const schemes: [string, (a: Attempt) => number][] = [
    ['f2p-only（L18 的海报口径）', (a) => (a.failToPassGreen ? 1 : 0)],
    ['resolve（hacked 记 0）', (a) => (classifyAttempt(a) === 'resolved' ? 1 : 0)],
    ['rewardFromAttempt', (a) => rewardFromAttempt(a)!],
  ]
  console.log(dim(`  ${pad('口径', 28)}A(resolved)  A(hacked)  A(failed)`))
  for (const [label, f] of schemes) {
    const adv = groupAdvantages(group.map(f), { scaleStd: false }).advantages
    console.log(`  ${pad(label, 28)}${lpad(fx(adv[0]!, 3), 11)}${lpad(fx(adv[2]!, 3), 11)}${lpad(fx(adv[4]!, 3), 11)}`)
  }
  console.log(dim('  f2p-only 当奖励：作弊和真解拿到一模一样的正优势。评测里这只让数字好看，训练里它塑造行为。'))
}

function exp7(): void {
  console.log(bold('\n实验七：多轮轨迹整条训还是按轮切（系统 + 题面 2000，每轮助手 300 + 工具输出 600）'))
  console.log(dim('   T   整条 token   切分 token   切分/整条   助手 token 占比'))
  for (const T of [5, 10, 19, 40]) {
    const c = trajectoryCost({ prompt: 2000, assistant: 300, observation: 600, turns: T })
    console.log(`  ${lpad(String(T), 2)}${lpad(String(c.whole), 13)}${lpad(String(c.split), 13)}` +
      `${lpad(fx(c.split / c.whole, 2), 12)}${lpad(fx(c.assistantShare, 3), 16)}`)
  }
  console.log(dim('  TRL 的 assistant_only_loss 默认是 False：不开的话，剩下那七成 token 也在被模仿，包括工具输出。'))
}

function dpoLine(label: string, b: DpoBuild): void {
  let ratio = 0
  for (const p of b.pairs) ratio += p.rejected.tokens / p.chosen.tokens
  const avg = b.pairs.length ? ratio / b.pairs.length : 0
  console.log(`  ${pad(label, 20)}对数 ${lpad(String(b.pairs.length), 2)}   chosen 更短 ${fx(b.chosenShorterShare, 3)}` +
    `   rejected/chosen 平均长度比 ${fx(avg, 3)}   没出对的题 ${b.tasksWithoutPairs.join(' ') || '—'}`)
}

function exp8(): void {
  console.log(bold('\n实验八：用 resolve 标签配 DPO 对，偏好里有多少是长度'))
  const tasks = demoDpoTasks()
  dpoLine('不设护栏', buildDpoPairs(tasks, { maxLengthRatio: Infinity, capPerTask: Infinity }))
  dpoLine('长度比 ≤ 1.25', buildDpoPairs(tasks, { maxLengthRatio: 1.25, capPerTask: Infinity }))
  dpoLine('护栏 + 每题 ≤ 2 对', buildDpoPairs(tasks, { maxLengthRatio: 1.25, capPerTask: 2 }))
  console.log(dim('  不设护栏时，「挑短的」一条规则就能预测八成以上的偏好；t6 全错、t7 全对，本来就配不出对；'))
  console.log(dim('  t4 唯一的一对长度差四倍，被护栏挡掉——护栏也有覆盖面的代价。'))
}

function exp9(): void {
  console.log(bold('\n实验九：不可能任务金丝雀（spec 与测试矛盾，任何「绿了」都是作弊）'))
  const base = demoCanary(false)
  const extra = demoCanary(true)
  console.log(dim(`  ${pad('尝试', 22)}${pad('只用 L17', 14)}${pad('+ extra 规则', 14)}奖励`))
  const rb: number[] = []
  const re: number[] = []
  base.forEach((a, i) => {
    const b = rewardFromAttempt(a)!
    const e = rewardFromAttempt(extra[i]!)!
    rb.push(b)
    re.push(e)
    const rules = extra[i]!.hackFindings.map((h) => h.rule).join(',')
    console.log(`  ${pad(`${a.taskId}/${a.variant}`, 22)}${pad(classifyAttempt(a), 14)}${pad(classifyAttempt(extra[i]!), 14)}` +
      `${lpad(fx(b, 1), 4)} → ${lpad(fx(e, 1), 4)}${rules ? '  ' + dim(rules) : ''}`)
  })
  console.log(`  平均奖励：只用 L17 ${fx(meanOf(rb), 3)}，加 extra 规则 ${fx(meanOf(re), 3)}`)
  console.log(dim('  金丝雀把检测器的召回率变成一个能测的数：平均奖励为正，说明 RL 正在付钱买作弊。'))
}

// ─────────────────────────────────────────────────────────────
// TODO
// ─────────────────────────────────────────────────────────────

/**
 * TODO 1 ★ 把一次 Attempt 翻译成标量奖励。
 *   error → null；hacked → −hackPenalty；resolved → 1；applied_only / failed → 0；
 *   非 hacked 的再减 min(warnCap, warnPenalty × warn 条数)。warnCap 不在 [0, 1) 内就抛错。
 * 标签必须走 classifyAttempt——testsMutated 但 hackFindings 为空的那条也是 hacked。
 * 陷阱：error 记 0（实验五）；warn 不封顶，让带 warn 的正确解掉到 applied_only 以下。
 */
export function myRewardFromAttempt(a: Attempt, p: RewardPolicy = DEFAULT_REWARD_POLICY): number | null {
  throw new Error('TODO 1 未实现')
}

/**
 * TODO 2 ★ 组内优势。null 不进均值和标准差，优势记 0，输出与输入等长。
 * 标准差用样本标准差（除以 n−1）。有效样本 < 2、或奖励全相同 → 全 0、hasSignal=false。
 * 陷阱：总体标准差（A03 会红）；std=0 时除出 NaN；照搬 verl 的单样本组（优势 = 原始奖励）；
 * 用 std === 0 判「全相同」——8 个 0.9 的 std 在浮点里不是 0。
 */
export function myGroupAdvantages(rewards: (number | null)[], opts: { scaleStd: boolean }): GroupAdvantage {
  throw new Error('TODO 2 未实现')
}

/**
 * TODO 3 ★ 有信号的概率。
 *   mySignalProbability(p, g) = 1 − (1−p)^g − p^g
 *   mySignalProbabilityFromCounts(n, c, g) = 1 − C(n−c, g)/C(n, g) − C(c, g)/C(n, g)，n < g 抛错
 * 整数幂用循环乘，组合数用乘除递推（r = r × (n−k+i) / i），不要用阶乘——C(40, 20) 的阶乘早就溢出了。
 * 结果夹到 ≥ 0：g=1 时数学上是 0，浮点里可能是 −1e−17。
 */
export function mySignalProbability(p: number, g: number): number {
  throw new Error('TODO 3 未实现')
}

export function mySignalProbabilityFromCounts(n: number, c: number, g: number): number {
  throw new Error('TODO 3 未实现')
}

/**
 * TODO 4 ★★ 按预采样筛题。成功 = classifyAttempt === 'resolved'；error 不计入 n；hacked 算不成功。
 * 判定顺序：n < g → dropInsufficient；c = 0 → dropAllFail；c = n → dropAllPass；否则 keep。
 * 各列表按 cmpCodePoint 排序；expectedSignal 是 keep 上 FromCounts 的平均（没有 keep 时为 0）。
 * 陷阱：把 error 当失败计进 n（C02）；把 hacked 当成功（C03）。
 */
export function myScreenTasks(byTask: Record<string, Attempt[]>, g: number): ScreenReport {
  throw new Error('TODO 4 未实现')
}

/**
 * TODO 5 ★★ 三种 loss 聚合的每 token 权重：
 *   grpo = A / (G·|o|)；dapo = A / Σ|o|；dr_grpo = A / (G·maxTokens)
 * 优势为 0 的样本权重为 0（包括 −0）。长度必须是正整数，两个数组不等长就抛错。
 * 想清楚：哪一种下，一条样本的总推力 Σ_t w 与长度无关？
 */
export function myTokenWeights(lengths: number[], advantages: number[], agg: LossAgg, maxTokens: number): number[] {
  throw new Error('TODO 5 未实现')
}

/**
 * TODO 6 ★★ 拒绝采样 SFT 的数据集。顺序固定：
 *   不是 resolved → 带任何 warn → 排除题 → 排除运行 → 同题同 patchHash 去重 → 每题封顶
 * 同题内按 turns 升序、tokens 升序、variant 码点序；去重和封顶都按这个顺序保留前面的。
 * kept 按 taskId 码点序、题内按上面的顺序；dropped 按 taskId、variant 码点序。
 * 陷阱：先封顶后去重（F02 会红）——两个名额被同一个解的两份拷贝占掉。
 */
export function myBuildSftSet(
  cands: SftCandidate[],
  opts: { capPerTask: number; excludeTaskIds: string[]; excludeRunIds?: string[] },
): SftSet {
  throw new Error('TODO 6 未实现')
}

/**
 * TODO 7 ★★ 配 DPO 对。chosen = resolved；rejected ∈ {failed, applied_only, hacked}；error 永不入对。
 * 长度比 = max(tokens)/min(tokens)，超过 maxLengthRatio 的丢掉；每题按长度比升序取前 capPerTask 对
 * （平局按 chosen.variant、rejected.variant 码点序）。题按 taskId 码点序。
 * tasksWithoutPairs：最终一对都没出的题。chosenShorterShare：chosen.tokens < rejected.tokens 的占比，没有对时为 0。
 * capPerTask 和 maxLengthRatio 都可能是 Infinity。
 */
export function myBuildDpoPairs(
  byTask: Record<string, Attempt[]>,
  opts: { maxLengthRatio: number; capPerTask: number },
): DpoBuild {
  throw new Error('TODO 7 未实现')
}

// ─────────────────────────────────────────────────────────────

function main(): void {
  exp1()
  exp2()
  exp3()
  exp4()
  exp5()
  exp6()
  exp7()
  exp8()
  exp9()
  console.log(bold('\n最该记住的'))
  console.log('  · 一组有信号的概率 = pass@G − pass^G：全对和全错的题一样不出梯度，rollout 照付。')
  console.log('  · error 是「这次不算」，不是 0 分；0 分会变成负优势。')
  console.log('  · 评测口径进了奖励，就从「数字好不好看」变成「塑造什么行为」。')
  console.log('  · 过滤掉作弊轨迹再 SFT 还不够：来源运行学过作弊，干净的轨迹里也带着它。')
}

if (isMain(import.meta.url)) main()
