/**
 * Capstone 评测层：证明「这版 coding agent 确实更好」。
 *
 * L12 的 shared/evals 管的是通用评测卫生（kappa、成对 diff、腐化、门禁顺序）。
 * 这一文件只管 **coding agent** 特有的坑：
 *
 *   · 「成功率」到底数的是 apply、resolve，还是 fail-to-pass
 *   · 小 N 下百分点跳动没有信息
 *   · 花费上升 ≠ 解决率上升
 *   · 消融必须改决策，不能只改海报
 *   · A/B 必须同一任务集成对，否则在比难度不是比改动
 *
 * ★ verify 一次模型都不调：所有输入都是已经落盘的 Attempt 记录。
 * 真跑模型只属于 l18/runner.ts。
 */

import { bootstrapCI, compareRuns, type DiffResult, type Interval } from './evals.ts'
import type { HackFinding } from './coding.ts'

// ─────────────────────────────────────────────────────────────
// 一、任务集
// ─────────────────────────────────────────────────────────────

export type Difficulty = 'easy' | 'medium' | 'hard'

export interface TaskInstance {
  id: string
  /** 难度分层——用来发现「只在 easy 上涨、hard 上崩」。 */
  difficulty: Difficulty
  /** 基线必须红、修完必须绿的测试。缺这一项就不是 SWE-bench 意义下的实例。 */
  failToPass: string[]
  /** 基线已绿、修完仍须绿的测试（防回归）。 */
  passToPass: string[]
  /** 仓库 + commit 钉死。空字符串 = 未钉，validate 会记 gap。 */
  repoPin: string
  /**
   * 已知与训练语料/公开题解重叠。不是「删掉」，是「单独报，永不进主指标」。
   * ★ 污染样本留在集里当金丝雀，比假装没有更诚实。
   */
  contaminated?: boolean
}

export interface TaskSetReport {
  ok: boolean
  n: number
  byDifficulty: Record<Difficulty, number>
  gaps: string[]
  contaminatedIds: string[]
}

/**
 * 校验任务集能不能拿来做主指标。
 *
 * ★ gaps 非空时，任何 resolve rate 都不可信——不是「警告后继续算」，
 * 是「主指标直接作废」。否则你会用一份缺 hard / 缺 fail-to-pass 的集
 * 得出很好看的数字。
 */
export function validateTaskSet(tasks: TaskInstance[]): TaskSetReport {
  const gaps: string[] = []
  const seen = new Set<string>()
  const byDifficulty: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0 }
  const contaminatedIds: string[] = []

  if (tasks.length === 0) gaps.push('任务集为空')

  for (const t of tasks) {
    if (!t.id || t.id.trim() === '') {
      gaps.push('存在空 id')
      continue
    }
    if (seen.has(t.id)) gaps.push(`重复 id：${t.id}`)
    seen.add(t.id)

    if (!(t.difficulty in byDifficulty)) {
      gaps.push(`${t.id}：未知 difficulty`)
    } else {
      byDifficulty[t.difficulty]++
    }

    if (!t.failToPass || t.failToPass.length === 0) {
      gaps.push(`${t.id}：缺 failToPass（没有「修前必红」的测试，无法判定 resolve）`)
    }
    if (!t.passToPass) {
      gaps.push(`${t.id}：passToPass 未定义（应为数组，可为空）`)
    }
    if (!t.repoPin || t.repoPin.trim() === '') {
      gaps.push(`${t.id}：未钉 repoPin`)
    }
    if (t.contaminated) contaminatedIds.push(t.id)
  }

  for (const d of ['easy', 'medium', 'hard'] as Difficulty[]) {
    if (byDifficulty[d] === 0 && tasks.length > 0) {
      gaps.push(`分层 ${d}：0 条（★ 这个难度在评测集里不存在）`)
    }
  }

  return {
    ok: gaps.length === 0,
    n: tasks.length,
    byDifficulty,
    gaps,
    contaminatedIds,
  }
}

/**
 * 主指标用的任务子集：去掉污染样本。
 * 污染样本另报 contaminatedRate，不进 resolveRate。
 */
export function primaryTasks(tasks: TaskInstance[]): TaskInstance[] {
  return tasks.filter((t) => !t.contaminated)
}

// ─────────────────────────────────────────────────────────────
// 二、一次 Attempt 的判定
// ─────────────────────────────────────────────────────────────

export type AttemptLabel =
  | 'resolved' // 补丁落下且 failToPass 全绿、passToPass 未破、未改测试、未被 hack 拦住
  | 'applied_only' // 补丁落下但测试没到 resolve
  | 'failed' // 没解决，也没明显作弊
  | 'hacked' // 检测器 block，或测试文件被改
  | 'error' // 基础设施错误（超时、沙箱崩）

export interface Attempt {
  taskId: string
  variant: string
  /** 补丁是否成功应用到工作树（不是「模型说改了」）。 */
  patchApplied: boolean
  /** fail-to-pass 是否在提交后全绿。 */
  failToPassGreen: boolean
  /** pass-to-pass 是否仍全绿。 */
  passToPassGreen: boolean
  /** 测试文件内容哈希是否相对基线发生变化。 */
  testsMutated: boolean
  hackFindings: HackFinding[]
  /** 基础设施层失败。 */
  errored?: boolean
  errorReason?: string
  tokens: number
  costUsd: number
  latencyMs: number
}

export function classifyAttempt(a: Attempt): AttemptLabel {
  if (a.errored) return 'error'
  const blocked = a.hackFindings.some((h) => h.severity === 'block')
  if (blocked || a.testsMutated) return 'hacked'
  if (
    a.patchApplied &&
    a.failToPassGreen &&
    a.passToPassGreen &&
    !a.testsMutated
  ) {
    return 'resolved'
  }
  if (a.patchApplied) return 'applied_only'
  return 'failed'
}

export function isResolved(a: Attempt): boolean {
  return classifyAttempt(a) === 'resolved'
}

// ─────────────────────────────────────────────────────────────
// 三、会说谎的指标
// ─────────────────────────────────────────────────────────────

export interface RateReport {
  /** 分子 */
  hits: number
  n: number
  rate: number
  /** Wilson 得分区间（比裸百分比诚实）。 */
  ci: Interval
  label: string
}

function wilson(hits: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { lo: 0, hi: 1 }
  const p = hits / n
  const denom = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)
  const lo = Math.max(0, (centre - margin) / denom)
  const hi = Math.min(1, (centre + margin) / denom)
  return { lo, hi }
}

export function applyRate(attempts: Attempt[]): RateReport {
  const n = attempts.length
  const hits = attempts.filter((a) => a.patchApplied && !a.errored).length
  return { hits, n, rate: n ? hits / n : 0, ci: wilson(hits, n), label: 'apply' }
}

export function resolveRate(attempts: Attempt[]): RateReport {
  const usable = attempts.filter((a) => classifyAttempt(a) !== 'error')
  const n = usable.length
  const hits = usable.filter(isResolved).length
  return { hits, n, rate: n ? hits / n : 0, ci: wilson(hits, n), label: 'resolve' }
}

/**
 * pass@k：k 次独立尝试里至少一次 resolved。
 * pass^k（这里叫 passHatK）：k 次全部 resolved——比 pass@k 严得多，也少见报道。
 */
export function passAtK(byTask: Record<string, Attempt[]>, k: number): RateReport {
  const ids = Object.keys(byTask)
  let hits = 0
  for (const id of ids) {
    const trials = (byTask[id] ?? []).slice(0, k)
    if (trials.length < k) continue
    if (trials.some(isResolved)) hits++
  }
  const eligible = ids.filter((id) => (byTask[id] ?? []).length >= k)
  const n = eligible.length
  return { hits, n, rate: n ? hits / n : 0, ci: wilson(hits, n), label: `pass@${k}` }
}

export function passHatK(byTask: Record<string, Attempt[]>, k: number): RateReport {
  const ids = Object.keys(byTask)
  let hits = 0
  for (const id of ids) {
    const trials = (byTask[id] ?? []).slice(0, k)
    if (trials.length < k) continue
    if (trials.every(isResolved)) hits++
  }
  const eligible = ids.filter((id) => (byTask[id] ?? []).length >= k)
  const n = eligible.length
  return { hits, n, rate: n ? hits / n : 0, ci: wilson(hits, n), label: `pass^${k}` }
}

/**
 * 同一次 attempt 集合上，四种「成功率」并排——观察实验用。
 * ★ 数字可以差一倍以上；海报上只写「成功率」时你不知道读的是哪一个。
 */
export function rateSpectrum(attempts: Attempt[]): {
  apply: RateReport
  resolve: RateReport
  /** 把 hacked 也算进「成功」（反面教材）。 */
  naiveIncludingHacks: RateReport
  /** 只看 failToPassGreen，无视测试是否被改。 */
  failToPassOnly: RateReport
} {
  const n = attempts.length
  const hackHits = attempts.filter(
    (a) => a.failToPassGreen || classifyAttempt(a) === 'hacked',
  ).length
  const f2pHits = attempts.filter((a) => a.failToPassGreen).length
  return {
    apply: applyRate(attempts),
    resolve: resolveRate(attempts),
    naiveIncludingHacks: {
      hits: hackHits,
      n,
      rate: n ? hackHits / n : 0,
      ci: wilson(hackHits, n),
      label: 'naive+hacks',
    },
    failToPassOnly: {
      hits: f2pHits,
      n,
      rate: n ? f2pHits / n : 0,
      ci: wilson(f2pHits, n),
      label: 'f2p-only',
    },
  }
}

// ─────────────────────────────────────────────────────────────
// 四、成本曲线
// ─────────────────────────────────────────────────────────────

export interface CostBucket {
  /** 闭开区间 [lo, hi) 的花费上界标签，最后一桶 hi 为 Infinity。 */
  lo: number
  hi: number
  n: number
  resolveRate: number
  meanCost: number
  meanTokens: number
}

/**
 * 按 costUsd 分位切桶，看 resolve rate。
 *
 * ★ 常见反转：最高花费桶的 resolve 反而更低——模型在同一题上
 * 空转重试，账单上升，问题没解决。
 */
export function costCurve(attempts: Attempt[], bucketCount = 4): CostBucket[] {
  const usable = attempts.filter((a) => !a.errored).slice()
  if (usable.length === 0) return []
  usable.sort((a, b) => a.costUsd - b.costUsd)
  const q = Math.max(1, Math.floor(usable.length / bucketCount))
  const out: CostBucket[] = []
  for (let i = 0; i < bucketCount; i++) {
    const start = i * q
    const end = i === bucketCount - 1 ? usable.length : Math.min(usable.length, (i + 1) * q)
    if (start >= usable.length || start >= end) break
    const slice = usable.slice(start, end)
    const lo = slice[0]!.costUsd
    const hi = i === bucketCount - 1 ? Infinity : slice[slice.length - 1]!.costUsd
    const hits = slice.filter(isResolved).length
    const meanCost = slice.reduce((s, a) => s + a.costUsd, 0) / slice.length
    const meanTokens = slice.reduce((s, a) => s + a.tokens, 0) / slice.length
    out.push({
      lo,
      hi,
      n: slice.length,
      resolveRate: hits / slice.length,
      meanCost,
      meanTokens,
    })
  }
  return out
}

export interface EfficiencyPoint {
  variant: string
  resolveRate: number
  meanCost: number
  /** resolve 数 / 总花费；0 花费时为 null。 */
  resolvesPerDollar: number | null
}

export function efficiency(attempts: Attempt[]): EfficiencyPoint {
  const r = resolveRate(attempts)
  const spend = attempts.reduce((s, a) => s + a.costUsd, 0)
  const hits = attempts.filter(isResolved).length
  const variant = attempts[0]?.variant ?? ''
  return {
    variant,
    resolveRate: r.rate,
    meanCost: attempts.length ? spend / attempts.length : 0,
    resolvesPerDollar: spend > 0 ? hits / spend : null,
  }
}

// ─────────────────────────────────────────────────────────────
// 五、消融
// ─────────────────────────────────────────────────────────────

export interface AblationRow {
  config: string
  resolveRate: number
  ci: Interval
  meanCost: number
  /** 相对 baseline 的 resolve 差值。 */
  deltaVsBaseline: number
  /** 差值 CI 是否完全在 0 一侧。 */
  decisive: boolean
  n: number
}

/**
 * 消融表：每个 config 一桶 Attempt（同一任务集）。
 *
 * ★ decorative 消融（改温度海报、换显示名）会让 decisive=false 且 delta≈0；
 * 真正改决策的旋钮（拿掉 verify-before-stop、关掉 NOT_UNIQUE）应在 hard 层拉开。
 */
export function ablationTable(
  byConfig: Record<string, Attempt[]>,
  baseline: string,
): AblationRow[] {
  const base = byConfig[baseline]
  if (!base) throw new Error(`baseline config 不存在：${baseline}`)
  const baseRate = resolveRate(base).rate
  const rows: AblationRow[] = []
  for (const [config, attempts] of Object.entries(byConfig)) {
    const r = resolveRate(attempts)
    const scores = attempts.map((a) => (isResolved(a) ? 1 : 0))
    const baseScores = base.map((a) => (isResolved(a) ? 1 : 0))
    // 成对差值（按位置；调用方应保证同一任务顺序）
    const n = Math.min(scores.length, baseScores.length)
    const diffs: number[] = []
    for (let i = 0; i < n; i++) diffs.push(scores[i]! - baseScores[i]!)
    const ci =
      config === baseline
        ? { lo: 0, hi: 0 }
        : n > 0
          ? bootstrapCI(diffs, { seed: 42 })
          : { lo: 0, hi: 0 }
    const delta = r.rate - baseRate
    rows.push({
      config,
      resolveRate: r.rate,
      ci: r.ci,
      meanCost: attempts.length
        ? attempts.reduce((s, a) => s + a.costUsd, 0) / attempts.length
        : 0,
      deltaVsBaseline: delta,
      decisive: config === baseline ? true : ci.lo > 0 || ci.hi < 0,
      n: attempts.length,
    })
  }
  // ★ 码点序，不用 localeCompare——后者和 Python sorted() 在大小写/下划线上不一致
  return rows.sort((a, b) => cmpCodePoint(a.config, b.config))
}

/** 双语言一致的字符串序（Unicode 码点）。verify / 脚手架输出依赖它。 */
export function cmpCodePoint(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * 双语言一致的定点格式化。bench 和 blocker 里所有小数都走它。
 *
 * ★ toFixed 对浮点数的精确值舍入、平局远离零：0.0625 → "0.063"、2.5 → "3"。
 * Python 的 f"{x:.3f}" 平局取偶，给 "0.062" 和 "2"。Python 侧 fmt_fixed 用 Decimal 复现 toFixed。
 * -0 记作 "0"：toFixed 本来就这样，Python 会印 "-0"。
 */
export function fmtFixed(x: number, digits: number): string {
  return (x === 0 ? 0 : x).toFixed(digits)
}

// ─────────────────────────────────────────────────────────────
// 六、A/B（成对）
// ─────────────────────────────────────────────────────────────

export interface PairABResult {
  diff: DiffResult
  /** 只在一侧 resolved 的任务。 */
  onlyA: string[]
  onlyB: string[]
  both: string[]
  neither: string[]
  /**
   * 若用「非成对」均值差会得出的错误结论方向。
   * 观察实验用来对照。
   */
  unpairedDelta: number
}

/**
 * 把 Attempt[] 收成 taskId → 0/1（取该任务首次 attempt）。
 */
export function resolvedByTask(attempts: Attempt[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const a of attempts) {
    if (a.taskId in out) continue
    out[a.taskId] = isResolved(a) ? 1 : 0
  }
  return out
}

export function pairedAB(a: Attempt[], b: Attempt[], opts: { seed?: number } = {}): PairABResult {
  const mapA = resolvedByTask(a)
  const mapB = resolvedByTask(b)
  const diff = compareRuns(mapA, mapB, { seed: opts.seed ?? 42 })
  // compareRuns(before, after) → fixed = after>before = B 修好、A 没修好
  const ids = Object.keys(mapA).filter((id) => id in mapB)
  const onlyA: string[] = []
  const onlyB: string[] = []
  const both: string[] = []
  const neither: string[] = []
  for (const id of ids) {
    const ra = mapA[id]! === 1
    const rb = mapB[id]! === 1
    if (ra && rb) both.push(id)
    else if (ra && !rb) onlyA.push(id)
    else if (!ra && rb) onlyB.push(id)
    else neither.push(id)
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0)
  const unpairedDelta = mean(Object.values(mapB)) - mean(Object.values(mapA))
  return { diff, onlyA, onlyB, both, neither, unpairedDelta }
}

// ─────────────────────────────────────────────────────────────
// 七、回归门禁（CI 零模型）
// ─────────────────────────────────────────────────────────────

/**
 * regress：PR/CI 默认——测「不劣于」（非劣）。噪声里偶然 +1 不应拦截。
 * claim：写「更好」之前——测「显著更好」（优效）。
 * ★ 两门绝不能合成一个（调研 INV-45）。
 */
export type GateMode = 'regress' | 'claim'

export interface CodingGateInput {
  tasks: TaskInstance[]
  /** 主干 / 基线变体的 attempts。 */
  baseline: Attempt[]
  /** PR / 候选变体的 attempts。 */
  candidate: Attempt[]
  /** 默认 regress。 */
  mode?: GateMode
  baselineName?: string
  candidateName?: string
}

export interface CodingGateResult {
  pass: boolean
  mode: GateMode
  /** claim 模式下是否达到「可宣称更好」；regress 下恒为 false。 */
  claimable: boolean
  blockers: string[]
  warnings: string[]
  taskSet: TaskSetReport
  spectrumBaseline: ReturnType<typeof rateSpectrum>
  spectrumCandidate: ReturnType<typeof rateSpectrum>
  ab: PairABResult
}

/**
 * coding agent 门禁。顺序故意与 L12 一致：**先查评测可信，再看分数。**
 *
 * regress（默认）：任务集 / hack / 样本被换 / 弄坏≥3 / 显著变差 → 拦。
 * claim：在 regress 通过之上，还要求成对显著更好；点估计升但不显著 → 拦。
 */
export function codingGate(input: CodingGateInput): CodingGateResult {
  const mode: GateMode = input.mode ?? 'regress'
  const blockers: string[] = []
  const warnings: string[] = []
  const taskSet = validateTaskSet(input.tasks)
  const primary = new Set(primaryTasks(input.tasks).map((t) => t.id))

  if (!taskSet.ok) {
    blockers.push(`任务集不可用：${taskSet.gaps[0]}`)
  }
  if (taskSet.contaminatedIds.length > 0) {
    const leaked = [...input.baseline, ...input.candidate].filter((a) =>
      taskSet.contaminatedIds.includes(a.taskId),
    )
    if (leaked.some(isResolved)) {
      warnings.push(
        `污染样本 ${taskSet.contaminatedIds.join(',')} 上有 resolve——勿写入主指标`,
      )
    }
  }

  const basePrim = input.baseline.filter((a) => primary.has(a.taskId))
  const candPrim = input.candidate.filter((a) => primary.has(a.taskId))

  const baseIds = new Set(basePrim.map((a) => a.taskId))
  const candIds = new Set(candPrim.map((a) => a.taskId))
  for (const id of baseIds) {
    if (!candIds.has(id)) blockers.push(`候选缺少任务 ${id}（样本集被换过）`)
  }
  for (const id of candIds) {
    if (!baseIds.has(id)) blockers.push(`候选多出任务 ${id}（样本集被换过）`)
  }

  const hacked = candPrim.filter((a) => classifyAttempt(a) === 'hacked')
  if (hacked.length > 0) {
    blockers.push(`候选有 ${hacked.length} 次 hacked/testsMutated（L17 检测器）`)
  }

  const ab = pairedAB(basePrim, candPrim)
  if (ab.onlyA.length >= 3) {
    blockers.push(
      `弄坏 ${ab.onlyA.length} 个已通过任务（${ab.onlyA.slice(0, 5).join(',')}…）——换了一批 bug`,
    )
  }

  const spectrumBaseline = rateSpectrum(basePrim)
  const spectrumCandidate = rateSpectrum(candPrim)

  // 显著变差 → 两门都拦
  if (ab.diff.significant && ab.diff.ci.hi < 0) {
    blockers.push(
      `resolve 显著低于基线（成对 CI [${fmtFixed(ab.diff.ci.lo, 3)}, ${fmtFixed(ab.diff.ci.hi, 3)}]）`,
    )
  }

  const roseNonsig =
    spectrumCandidate.resolve.rate > spectrumBaseline.resolve.rate && !ab.diff.significant
  if (mode === 'claim' && roseNonsig) {
    blockers.push(
      `resolve 点估计上升但不显著（成对 CI [${fmtFixed(ab.diff.ci.lo, 3)}, ${fmtFixed(ab.diff.ci.hi, 3)}] 跨 0）——不可宣称更好`,
    )
  } else if (mode === 'regress' && roseNonsig) {
    warnings.push(
      'resolve 点估计上升但不显著——regress 放行；若要写「更好」请改用 mode:claim',
    )
  }

  if (
    spectrumCandidate.apply.rate > spectrumBaseline.apply.rate + 1e-9 &&
    spectrumCandidate.resolve.rate <= spectrumBaseline.resolve.rate + 1e-9
  ) {
    warnings.push('apply↑ 而 resolve 未↑——不要只报 apply rate')
  }

  const pass = blockers.length === 0
  const claimable =
    mode === 'claim' &&
    pass &&
    ab.diff.significant &&
    ab.diff.ci.lo > 0

  return {
    pass,
    mode,
    claimable,
    blockers,
    warnings,
    taskSet,
    spectrumBaseline,
    spectrumCandidate,
    ab,
  }
}

// re-export 常用工具，脚手架少 import 几个路径
export { bootstrapCI, compareRuns }
export type { DiffResult, Interval }
