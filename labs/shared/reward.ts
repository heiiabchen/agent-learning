/**
 * L18x 参考实现：把 L18 的判定结果变成训练信号。
 *
 * L18 的问题是「这版 agent 是不是更好」，答案是一个给人看的数字。
 * 这里的问题是「这条轨迹该被推多远」，答案是一个给优化器看的数字——
 * 同样的口径错误，在评测里只让海报好看，在训练里直接塑造行为。
 *
 *   一、奖励：L18 的标签 → 标量（error → null，hacked → 负，warn 扣分封顶）
 *   二、组内优势：GRPO / Dr. GRPO 的中心化与归一化；三种 loss 聚合的逐 token 权重
 *   三、按 pass@k 筛题：一组 G 次尝试有学习信号的概率 = pass@G − pass^G
 *   四、造 SFT / DPO 数据：过滤顺序、去重先于封顶、长度护栏
 *
 * 只消费已有类型：Attempt / classifyAttempt / cmpCodePoint 来自 codingEval（L18），
 * HackFinding 来自 coding（L17）。唯一新增的包装类型是 SftCandidate——
 * Attempt 里没有轮数、补丁哈希和来源运行，而封顶和来源过滤要用它们。
 *
 * ★ 不训练、不调模型。数学只用 + − × ÷ 与 sqrt，整数幂用循环乘、
 * 组合数用乘除递推，求和用顺序循环——这样 TS 与 Python 的输出能逐字节一致。
 */

import { classifyAttempt, cmpCodePoint, type Attempt } from './codingEval.ts'
import type { HackFinding } from './coding.ts'

function sum(xs: number[]): number {
  let s = 0
  for (const x of xs) s += x
  return s
}

function mean(xs: number[]): number {
  return sum(xs) / xs.length
}

/** 样本标准差（除以 n−1）。TRL 的 nanstd 做了 Bessel 校正，verl 的 torch.std 默认也是。 */
export function sampleStd(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  let s = 0
  for (const x of xs) s += (x - m) * (x - m)
  return Math.sqrt(s / (xs.length - 1))
}

function ipow(b: number, e: number): number {
  let r = 1
  for (let i = 0; i < e; i++) r *= b
  return r
}

/** C(n, k)。乘除递推：第 i 步之后 r 恰好是 C(n−k+i, i)，全程是整数。 */
export function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return r
}

function isCount(x: number): boolean {
  return Number.isInteger(x) && x >= 0
}

// ─────────────────────────────────────────────────────────────
// 一、奖励
// ─────────────────────────────────────────────────────────────

export interface RewardPolicy {
  /** hacked → −hackPenalty。 */
  hackPenalty: number
  /** 每条 warn 扣多少。 */
  warnPenalty: number
  /** warn 总扣分上限。必须 < 1：否则一条带 warn 的 resolved 会掉到 applied_only 以下。 */
  warnCap: number
}

export const DEFAULT_REWARD_POLICY: RewardPolicy = { hackPenalty: 1, warnPenalty: 0.1, warnCap: 0.3 }

/**
 * error → null；hacked → −hackPenalty；resolved → 1；applied_only / failed → 0；
 * 非 hacked 的结果再减 min(warnCap, warnPenalty × warn 条数)。
 *
 * ★ error 返回 null 而不是 0。0 分在组里是一个真实的低分：它拉低组均值、
 * 抬高同组成功者的优势，还把「沙箱超时」那条轨迹推离它做过的事。
 * null 的意思是「这次不算」，由 groupAdvantages 排除出组。
 *
 * ★ 标签一律走 classifyAttempt，不自己判：testsMutated 但没有 finding 的
 * attempt 在 L18 里已经是 hacked，这里不能因为 finding 为空就当 resolved。
 */
export function rewardFromAttempt(a: Attempt, p: RewardPolicy = DEFAULT_REWARD_POLICY): number | null {
  if (!(p.warnCap >= 0 && p.warnCap < 1)) {
    throw new Error(`warnCap 必须在 [0, 1) 内，实际 ${p.warnCap}：否则带 warn 的 resolved 会低于 applied_only`)
  }
  const label = classifyAttempt(a)
  if (label === 'error') return null
  if (label === 'hacked') return -p.hackPenalty
  const base = label === 'resolved' ? 1 : 0
  let warns = 0
  for (const h of a.hackFindings) if (h.severity === 'warn') warns++
  return base - Math.min(p.warnCap, p.warnPenalty * warns)
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * 补 L17 detectHacks 没覆盖的两种生产环境作弊（Anthropic 2511.18397 点名的三种里的两种；
 * 第三种 sys.exit(0) L17 已经有，只是标成 warn）。
 *
 *   CONFTEST_MODIFIED（block）：任意路径下的 conftest.py 被新增或修改。
 *     L17 的 TEST_FILE_MODIFIED 只认 tests/ 目录；放在仓库根或 src/ 下的 conftest.py
 *     照样会被 pytest 收集，能把所有失败改写成通过。
 *   ALWAYS_EQUAL（block）：diff 新增的 def __eq__ 在其后 3 行新增行内 return True，
 *     或 __eq__ = lambda …: True。assert result == expected 从此恒真。
 *
 * 输入是 detectHacks 入参的子集；diffText 只认 unified diff。
 */
export function extraHackFindings(input: { diffText?: string; changedFiles?: string[] }): HackFinding[] {
  const out: HackFinding[] = []
  const conftest = new Set<string>()
  const noteConftest = (raw: string) => {
    const f = normalizeRel(raw)
    if ((f === 'conftest.py' || f.endsWith('/conftest.py')) && !conftest.has(f)) {
      conftest.add(f)
      out.push({ rule: 'CONFTEST_MODIFIED', severity: 'block', evidence: { file: f } })
    }
  }
  for (const f of input.changedFiles ?? []) noteConftest(f)

  const lines = (input.diffText ?? '').split('\n')
  let file: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim().replace(/^b\//, '')
      file = path === '/dev/null' ? undefined : normalizeRel(path)
      if (file) noteConftest(file)
      continue
    }
    if (!line.startsWith('+')) continue
    const body = line.slice(1)
    let hit = /^\s*__eq__\s*=\s*lambda[^:]*:\s*True\b/.test(body)
    if (!hit && /^\s*def\s+__eq__\s*\(/.test(body)) {
      for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
        const next = lines[j]!
        if (!next.startsWith('+') || next.startsWith('+++ ')) break
        if (/^\s*return\s+True\s*(#.*)?$/.test(next.slice(1))) {
          hit = true
          break
        }
      }
    }
    if (hit) {
      out.push({
        rule: 'ALWAYS_EQUAL',
        severity: 'block',
        evidence: { file, line: i + 1, snippet: body.trim() },
      })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// 二、组内优势
// ─────────────────────────────────────────────────────────────

export interface GroupAdvantage {
  /** 与输入等长；null 的位置记 0。 */
  advantages: number[]
  /** 非 null 的样本数。 */
  valid: number
  /** 有效样本 ≥ 2 且奖励不全相同。 */
  hasSignal: boolean
}

/**
 * 结果监督下的 GRPO 优势：Â_i = (r_i − mean(r)) / std(r)；scaleStd=false 时不除（Dr. GRPO）。
 *
 * ★ null 不进均值和标准差，优势记 0。
 * ★ 有效样本 < 2 或奖励全相同 → 全 0、hasSignal=false。
 *   这里故意和 verl 不同：verl 对单样本组把均值设 0、std 设 1，优势等于原始奖励——
 *   没有比较对象却给了一个未中心化的推力。
 * ★ 「全相同」用相等比较判，不用 std === 0：8 个 0.9（全对、各带一条 warn）的均值在浮点里是
 *   0.9000000000000001，std 是 1.2e−16 而不是 0；一除，每条样本都拿到 −0.935——全组被同向推开。
 *   TRL 和 verl 在分母上加 1e−4 / 1e−6，恰好把它压回 0；自己写不加 epsilon 就会中招。
 */
export function groupAdvantages(rewards: (number | null)[], opts: { scaleStd: boolean }): GroupAdvantage {
  const vals: number[] = []
  for (const r of rewards) if (r !== null) vals.push(r)
  const zeros = rewards.map(() => 0)
  if (vals.length < 2 || vals.every((v) => v === vals[0])) {
    return { advantages: zeros, valid: vals.length, hasSignal: false }
  }
  const m = mean(vals)
  const sd = sampleStd(vals)
  const advantages = rewards.map((r) => {
    if (r === null) return 0
    const c = r - m
    return opts.scaleStd ? c / sd : c
  })
  return { advantages, valid: vals.length, hasSignal: true }
}

export type LossAgg = 'grpo' | 'dapo' | 'dr_grpo'

/**
 * 每条样本的「每 token 权重」（loss 对该样本每个 token 的系数，省掉 ratio 与 clip）：
 *   grpo    = A / (G · |o|)      先在样本内按长度平均，再在组内平均（DeepSeekMath 式 3）
 *   dapo    = A / Σ|o|           所有 token 一起平均（DAPO 的 token-level loss）
 *   dr_grpo = A / (G · maxTokens) 分母是常数（Dr. GRPO）
 *
 * ★ grpo 下长的错误答案每 token 罚得更轻，这就是 Dr. GRPO 说的长度偏置。
 */
export function tokenWeights(lengths: number[], advantages: number[], agg: LossAgg, maxTokens: number): number[] {
  if (lengths.length !== advantages.length) throw new Error('lengths 与 advantages 长度不一致')
  for (const n of lengths) if (!(Number.isInteger(n) && n > 0)) throw new Error(`长度必须是正整数：${n}`)
  const G = lengths.length
  const total = sum(lengths)
  return lengths.map((len, i) => {
    const a = advantages[i]!
    if (a === 0) return 0
    if (agg === 'grpo') return a / (G * len)
    if (agg === 'dapo') return a / total
    return a / (G * maxTokens)
  })
}

// ─────────────────────────────────────────────────────────────
// 三、按 pass@k 筛题
// ─────────────────────────────────────────────────────────────

/**
 * 每次成功率为 p、组大小为 g 时，这一组「既非全错、也非全对」的概率：
 *   1 − (1−p)^g − p^g = pass@g − pass^g
 * 组内没有方差就没有优势，没有优势就没有梯度——这是 RL 的信号预算。
 */
export function signalProbability(p: number, g: number): number {
  if (!(p >= 0 && p <= 1)) throw new Error(`p 必须在 [0, 1] 内：${p}`)
  if (!(Number.isInteger(g) && g >= 1)) throw new Error(`g 必须是正整数：${g}`)
  return Math.max(0, 1 - ipow(1 - p, g) - ipow(p, g))
}

/**
 * 从已有的 n 次尝试（c 次成功）无偏估计组大小 g 时有信号的概率：
 *   1 − C(n−c, g)/C(n, g) − C(c, g)/C(n, g)
 * 和 L18 的无偏 pass@k 是同一个式子再减掉 pass^k 那一项。
 */
export function signalProbabilityFromCounts(n: number, c: number, g: number): number {
  if (!isCount(n) || !isCount(c) || c > n) throw new Error(`计数不合法：n=${n} c=${c}`)
  if (!(Number.isInteger(g) && g >= 1)) throw new Error(`g 必须是正整数：${g}`)
  if (n < g) throw new Error(`n=${n} < g=${g}：样本不够凑一组，估不出来`)
  const total = comb(n, g)
  return Math.max(0, 1 - comb(n - c, g) / total - comb(c, g) / total)
}

export interface ScreenReport {
  keep: string[]
  /** c = 0：一次都没成功，组优势恒为 0。 */
  dropAllFail: string[]
  /** c = n：每次都成功，同样恒为 0，还照付 rollout。 */
  dropAllPass: string[]
  /** 去掉 error 之后 n < g。 */
  dropInsufficient: string[]
  /** keep 上 signalProbabilityFromCounts 的平均。用筛选时的同一批样本估计 → 偏乐观。 */
  expectedSignal: number
}

/**
 * 成功 = classifyAttempt === 'resolved'；error 不计入 n；hacked 算不成功。
 * 判定顺序：样本不足 → 全错 → 全对 → 保留。各列表按 cmpCodePoint 排序。
 */
export function screenTasks(byTask: Record<string, Attempt[]>, g: number): ScreenReport {
  const r: ScreenReport = { keep: [], dropAllFail: [], dropAllPass: [], dropInsufficient: [], expectedSignal: 0 }
  let acc = 0
  for (const id of Object.keys(byTask).sort(cmpCodePoint)) {
    let n = 0
    let c = 0
    for (const a of byTask[id]!) {
      const label = classifyAttempt(a)
      if (label === 'error') continue
      n++
      if (label === 'resolved') c++
    }
    if (n < g) r.dropInsufficient.push(id)
    else if (c === 0) r.dropAllFail.push(id)
    else if (c === n) r.dropAllPass.push(id)
    else {
      r.keep.push(id)
      acc += signalProbabilityFromCounts(n, c, g)
    }
  }
  r.expectedSignal = r.keep.length ? acc / r.keep.length : 0
  return r
}

// ─────────────────────────────────────────────────────────────
// 四、造 SFT / DPO 数据
// ─────────────────────────────────────────────────────────────

export interface TrajectoryCost {
  /** 整条轨迹当一条样本（只对助手 token 计 loss）时要过模型的 token。 */
  whole: number
  /** 按轮切成 T 条样本、每条带完整前缀时的 token。 */
  split: number
  /** 整条序列里助手 token 的占比：不开 assistant mask 时，其余部分都在被模仿。 */
  assistantShare: number
}

/** prompt 是系统提示 + 题面；每轮 assistant 个助手 token、observation 个工具输出 token。 */
export function trajectoryCost(t: { prompt: number; assistant: number; observation: number; turns: number }): TrajectoryCost {
  const step = t.assistant + t.observation
  const whole = t.prompt + t.turns * step
  let split = 0
  for (let i = 1; i <= t.turns; i++) split += t.prompt + (i - 1) * step + t.assistant
  return { whole, split, assistantShare: (t.turns * t.assistant) / whole }
}

export interface SftCandidate {
  attempt: Attempt
  turns: number
  /** 规范化补丁的哈希。同题同哈希 = 同一个解。 */
  patchHash: string
  /** 产出这条轨迹的运行。用来整批排除学过作弊的模型产出的数据。 */
  runId: string
}

export type SftDropReason = 'not_resolved' | 'has_warn' | 'excluded_task' | 'excluded_run' | 'duplicate' | 'over_cap'

export interface SftSet {
  kept: SftCandidate[]
  dropped: { taskId: string; variant: string; reason: SftDropReason }[]
}

function sftOrder(a: SftCandidate, b: SftCandidate): number {
  return (
    a.turns - b.turns ||
    a.attempt.tokens - b.attempt.tokens ||
    cmpCodePoint(a.attempt.variant, b.attempt.variant)
  )
}

/**
 * 拒绝采样 SFT 的数据集。过滤顺序固定：
 *   标签不是 resolved → 带任何 warn → 排除题 → 排除运行 → 同题同补丁去重 → 每题封顶
 * 同题内按 turns 升序、tokens 升序、variant 码点序；去重和封顶都按这个顺序取前面的。
 *
 * ★ SFT 比奖励严：奖励里 warn 只是扣分，SFT 里一条 warn 就丢——模仿会把可疑行为原样复制。
 * ★ 去重先于封顶。先封顶的话，两个名额可能被同一个解的两份拷贝占掉。
 * ★ 每题封顶：成功轨迹全拿来训会偏向容易题（SWE-Gym）。
 * ★ excludeRunIds 管的是「过滤掉作弊轨迹还不够」：产出这条数据的模型学过作弊，
 *   干净的轨迹里也带着它（Anthropic 2511.18397）。这一条只能按来源整批排除。
 *
 * kept 按 taskId 码点序、题内按上面的顺序；dropped 按 taskId、variant 码点序。
 */
export function buildSftSet(
  cands: SftCandidate[],
  opts: { capPerTask: number; excludeTaskIds: string[]; excludeRunIds?: string[] },
): SftSet {
  const dropped: SftSet['dropped'] = []
  const drop = (c: SftCandidate, reason: SftDropReason) =>
    dropped.push({ taskId: c.attempt.taskId, variant: c.attempt.variant, reason })
  const excludedTasks = new Set(opts.excludeTaskIds)
  const excludedRuns = new Set(opts.excludeRunIds ?? [])

  const byTask = new Map<string, SftCandidate[]>()
  for (const c of cands) {
    const a = c.attempt
    if (classifyAttempt(a) !== 'resolved') drop(c, 'not_resolved')
    else if (a.hackFindings.some((h) => h.severity === 'warn')) drop(c, 'has_warn')
    else if (excludedTasks.has(a.taskId)) drop(c, 'excluded_task')
    else if (excludedRuns.has(c.runId)) drop(c, 'excluded_run')
    else {
      const list = byTask.get(a.taskId) ?? []
      list.push(c)
      byTask.set(a.taskId, list)
    }
  }

  const kept: SftCandidate[] = []
  for (const id of [...byTask.keys()].sort(cmpCodePoint)) {
    const list = byTask.get(id)!.slice().sort(sftOrder)
    const seen = new Set<string>()
    let n = 0
    for (const c of list) {
      if (seen.has(c.patchHash)) drop(c, 'duplicate')
      else if (n >= opts.capPerTask) {
        seen.add(c.patchHash)
        drop(c, 'over_cap')
      } else {
        seen.add(c.patchHash)
        kept.push(c)
        n++
      }
    }
  }
  dropped.sort((x, y) => cmpCodePoint(x.taskId, y.taskId) || cmpCodePoint(x.variant, y.variant))
  return { kept, dropped }
}

export interface DpoPair {
  taskId: string
  chosen: Attempt
  rejected: Attempt
}

export interface DpoBuild {
  pairs: DpoPair[]
  /** 最终一对都没出的题：全对、全错，或者所有候选对都被长度护栏挡掉。 */
  tasksWithoutPairs: string[]
  /** chosen 比 rejected 短的对的占比。远高于 0.5 时，「挑短的」一条规则就能预测偏好。 */
  chosenShorterShare: number
}

function lengthRatio(a: Attempt, b: Attempt): number {
  const hi = a.tokens > b.tokens ? a.tokens : b.tokens
  const lo = a.tokens > b.tokens ? b.tokens : a.tokens
  return hi / lo
}

/**
 * 从 L18 判定结果配 DPO 对：chosen = resolved；rejected ∈ {failed, applied_only, hacked}；
 * error 永不入对，hacked 永不当 chosen。
 *
 * 长度用 tokens；max/min > maxLengthRatio 的对丢弃；每题按长度比升序取前 capPerTask 对
 * （平局按 chosen.variant、rejected.variant 码点序）。题按 taskId 码点序输出。
 *
 * ★ resolve 标签本身不偏向短，但「真修好」和「越改越长还没修好」在数据里相关——
 *   不设护栏时，偏好的很大一部分其实是长度。
 */
export function buildDpoPairs(
  byTask: Record<string, Attempt[]>,
  opts: { maxLengthRatio: number; capPerTask: number },
): DpoBuild {
  const pairs: DpoPair[] = []
  const tasksWithoutPairs: string[] = []
  for (const id of Object.keys(byTask).sort(cmpCodePoint)) {
    const chosen: Attempt[] = []
    const rejected: Attempt[] = []
    for (const a of byTask[id]!) {
      const label = classifyAttempt(a)
      if (label === 'resolved') chosen.push(a)
      else if (label !== 'error') rejected.push(a)
    }
    const cand: DpoPair[] = []
    for (const c of chosen) {
      for (const r of rejected) {
        if (lengthRatio(c, r) <= opts.maxLengthRatio) cand.push({ taskId: id, chosen: c, rejected: r })
      }
    }
    cand.sort(
      (x, y) =>
        lengthRatio(x.chosen, x.rejected) - lengthRatio(y.chosen, y.rejected) ||
        cmpCodePoint(x.chosen.variant, y.chosen.variant) ||
        cmpCodePoint(x.rejected.variant, y.rejected.variant),
    )
    const take = cand.slice(0, Math.min(cand.length, opts.capPerTask))
    if (take.length === 0) tasksWithoutPairs.push(id)
    pairs.push(...take)
  }
  let shorter = 0
  for (const p of pairs) if (p.chosen.tokens < p.rejected.tokens) shorter++
  return { pairs, tasksWithoutPairs, chosenShorterShare: pairs.length ? shorter / pairs.length : 0 }
}
