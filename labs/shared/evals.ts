/**
 * 参考实现：评测。
 *
 * 这一节是整个课程的分水岭，理由很直接：**在它之前你所有的判断都是"我觉得"。**
 *
 * L03 的 prompt 改法、L06 的压缩策略、L07 的编排模式、L09 的检索配置、
 * L11 的扇出宽度——每一个都是在两种做法之间选一种，而你到现在为止
 * 没有任何手段判断哪种更好。
 *
 * 而这一节要处理的核心难题不是"怎么打分"，是**怎么不骗自己**。
 *
 * 因为评测这件事有一个很坏的性质：**它产出数字，而数字自带权威。**
 * 一个错的评测比没有评测更糟——没有评测你至少知道自己在猜。
 *
 * 所以这个文件里几乎每个函数都在防同一类事情：
 *
 *     一致率 85% 听起来很好，实际可能等于零信息
 *     judge 每次跑结果都一样，听起来很可靠，实际可能是它永远选 A
 *     成功率涨了 2%，听起来是进步，实际在这个样本量下是噪声
 *     净涨 2%，听起来是小改进，实际可能修好 10 个又弄坏 8 个
 */

// ─────────────────────────────────────────────────────────────
// 一、评测集：从生产日志里攒，而不是编
// ─────────────────────────────────────────────────────────────

export interface LogEntry {
  id: string
  input: string
  /** 生产环境实际的结果。用来分层，不是用来当答案。 */
  outcome: 'ok' | 'wrong' | 'error' | 'timeout'
  /** 任务类型，用来分层。 */
  kind: string
  /** 用了几步工具。复杂度的粗代理。 */
  steps: number
}

export interface SampleResult {
  picked: LogEntry[]
  /** 每个分层实际取到几条。 */
  coverage: Record<string, number>
  /**
   * ★ 没取够的分层。这是整个函数最重要的返回值。
   *
   * 因为"某个失败模式在评测集里一条都没有"这件事，
   * 不会以任何形式表现出来——你的评测会跑得很干净，
   * 分数会很好看，而那个失败模式在生产上继续发生。
   */
  gaps: string[]
}

/**
 * 分层抽样。
 *
 * ★ 为什么不能随机抽：**生产日志是极度不均衡的。**
 *
 * 一个还算健康的 agent，日志里 90% 以上是成功的正常路径。
 * 随机抽 150 条，你会拿到 135 条正常路径和一把零星的失败——
 * 而失败恰恰是你要评测的东西。
 *
 * 更糟的是这个评测集**会给你一个很高的基线分**（90%+），
 * 于是任何改进都只能在剩下那 10% 里体现，信噪比极差。
 */
export function stratifiedSample(
  logs: LogEntry[],
  opts: { strata: string[]; perStratum: number; stratify?: (e: LogEntry) => string },
): SampleResult {
  const { strata, perStratum, stratify = (e) => e.outcome } = opts

  const buckets = new Map<string, LogEntry[]>()
  for (const s of strata) buckets.set(s, [])
  for (const e of logs) {
    const key = stratify(e)
    if (buckets.has(key)) buckets.get(key)!.push(e)
  }

  const picked: LogEntry[] = []
  const coverage: Record<string, number> = {}
  const gaps: string[] = []

  for (const s of strata) {
    const pool = buckets.get(s)!
    const take = pool.slice(0, perStratum)
    picked.push(...take)
    coverage[s] = take.length
    if (take.length < perStratum) {
      gaps.push(
        `${s}：要 ${perStratum} 条，只有 ${take.length} 条` +
          (take.length === 0 ? '（★ 一条都没有——这个失败模式在评测集里不存在）' : ''),
      )
    }
  }

  return { picked, coverage, gaps }
}

// ─────────────────────────────────────────────────────────────
// 二、断言分层：别用 judge 干正则能干的事
// ─────────────────────────────────────────────────────────────

export type CheckKind = 'exact' | 'structural' | 'regex' | 'judge'

export interface Criterion {
  id: string
  /** 人话描述这一条要判什么。 */
  says: string
  /** 期望值。有确定答案的填这个。 */
  expect?: string
  /** 要求输出是合法 JSON 且含这些字段。 */
  fields?: string[]
  /** 要求匹配这个模式。 */
  pattern?: string
  /**
   * 反向断言：要求**不**匹配 pattern。
   *
   * ★ 这个字段不是可选的锦上添花。"输出里不能出现内部服务名"、
   * "不能泄露 API key"、"不能出现别的客户的数据"——安全相关的判据
   * 大半是反向的，而把它们写成正向会让断言的含义**正好反过来**，
   * 且测试全绿。
   */
  negate?: boolean
  /** 只有真的需要语义判断时才为 true。 */
  semantic?: boolean
}

export interface Routed {
  id: string
  kind: CheckKind
  /** 为什么选这个层级。 */
  why: string
}

/**
 * 把每条判据路由到**最便宜的够用的**检查方式。
 *
 * ★ 这个函数存在的理由是一条很实际的观察：
 * **绝大多数人上手评测的第一件事就是写一个 LLM judge，而其中大半根本不需要。**
 *
 * "输出里有没有引用编号"是正则。"输出是不是合法 JSON 且有 severity 字段"
 * 是结构检查。"分类对不对"是精确匹配。这三类合起来通常占判据的七八成，
 * 而它们的共同点是：**确定、免费、不会漂。**
 *
 * 而 judge 的代价不只是钱：
 *   · 它自己会错，而且错得有系统性（见下面第四节）
 *   · 它的输出会随模型版本漂移，于是你的历史分数不可比
 *   · 它慢，于是你不会想在每次提交时跑
 *
 * ★ 判据：**能用确定性断言判的，绝不用 judge。**
 * judge 留给真正需要语义判断的部分——而那部分通常比你以为的少。
 */
export function routeCheck(c: Criterion): Routed {
  if (c.expect !== undefined) {
    return { id: c.id, kind: 'exact', why: '有唯一正确答案，精确匹配就够' }
  }
  if (c.fields && c.fields.length > 0) {
    return { id: c.id, kind: 'structural', why: '判的是结构，解析一下就知道' }
  }
  if (c.pattern) {
    return {
      id: c.id,
      kind: 'regex',
      why: c.negate ? '反向断言：命中就算失败，正则确定且免费' : '判的是格式/存在性，正则确定且免费',
    }
  }
  if (c.semantic) {
    return { id: c.id, kind: 'judge', why: '★ 真的需要语义判断，但要先给 judge 做体检' }
  }
  return {
    id: c.id,
    kind: 'judge',
    why: '★ 没给出任何确定性依据，只能上 judge——先想想是不是判据本身没定义清',
  }
}

export interface CheckResult {
  id: string
  kind: CheckKind
  pass: boolean
  note: string
}

/** 跑确定性断言。judge 那一类不在这里跑，它要走体检过的通道。 */
export function runDeterministic(output: string, criteria: Criterion[]): CheckResult[] {
  const out: CheckResult[] = []

  for (const c of criteria) {
    const { kind } = routeCheck(c)

    if (kind === 'exact') {
      const pass = output.trim() === c.expect!.trim()
      out.push({ id: c.id, kind, pass, note: pass ? '' : `期望 ${c.expect!}，得到 ${output.slice(0, 40)}` })
    } else if (kind === 'structural') {
      let parsed: unknown
      try {
        parsed = JSON.parse(output)
      } catch {
        out.push({ id: c.id, kind, pass: false, note: '不是合法 JSON' })
        continue
      }
      const obj = (parsed ?? {}) as Record<string, unknown>
      const missing = c.fields!.filter((f) => !(f in obj))
      out.push({
        id: c.id,
        kind,
        pass: missing.length === 0,
        note: missing.length === 0 ? '' : `缺字段 ${missing.join('、')}`,
      })
    } else if (kind === 'regex') {
      const hit = new RegExp(c.pattern!).test(output)
      // ★ negate 时命中就是失败
      const pass = c.negate ? !hit : hit
      out.push({
        id: c.id,
        kind,
        pass,
        note: pass ? '' : c.negate ? `命中了不该出现的 /${c.pattern!}/` : `不匹配 /${c.pattern!}/`,
      })
    }
    // judge 类跳过——它不该在这里跑
  }

  return out
}

// ─────────────────────────────────────────────────────────────
// 三、一致率：为什么 85% 可能等于零信息
// ─────────────────────────────────────────────────────────────

export interface AgreementReport {
  /** 原始一致率。判对的比例。 */
  raw: number
  /** 偶然一致率。两个评判者按各自的边缘分布瞎猜能达到的一致率。 */
  chance: number
  /** Cohen's kappa。扣掉偶然之后还剩多少。 */
  kappa: number
  /** raw − kappa，单位是百分点。 */
  deflation: number
  /**
   * ★ 退化警告。
   *
   * 最要紧的一种：judge 永远输出同一个标签。
   * 这时候如果那个标签正好是多数类，raw 会很高而 kappa 恰好是 0。
   */
  problems: string[]
}

/**
 * 带偶然校正的一致率。
 *
 * ★ 这是整节课最重要的一个函数，而理由用一个例子就能说清：
 *
 * 你的评测集里 80% 的样本是"通过"。你写了个 judge，测出来
 * **和人工标注的一致率 80%**。听起来还不错。
 *
 * 但如果这个 judge 的实现是 `return "pass"`——它什么都不看，
 * 永远说通过——它的一致率**也是 80%**。
 *
 * 两者的区别，raw agreement 分辨不出来。Cohen's kappa 能：
 * 那个永远说通过的 judge，kappa 恰好是 0。
 *
 *     kappa = (观测一致率 − 偶然一致率) / (1 − 偶然一致率)
 *
 * 而"偶然一致率"算的是：如果两个评判者各自保持自己的标签比例、
 * 但完全随机地贴，能撞对多少。
 *
 * ★ 经验数据：2026 年一项覆盖 21 个 judge、54 万次判断的研究里，
 * **原始一致率高估偶然校正后的一致性 33.8 到 41.3 个百分点**，
 * 21 个模型无一例外。表现最好的那个 judge 原始一致率 0.849，
 * kappa 0.511。
 *
 * 而这个差距的大小主要取决于**你的标签分布**，不取决于 judge 好坏。
 * 标签越不均衡，raw 越虚高。
 */
/**
 * 偶然一致率：两个评判者各自保持自己的标签比例、但完全随机地贴，
 * 能撞对多少。
 *
 *     chance = Σ_label  P(judge 贴这个标签) × P(人贴这个标签)
 *
 * ★ 标签集合要取两边的**并集**。judge 可能输出人工标注里没有的标签，
 * 反之亦然；漏掉一边会让 chance 偏小，于是 kappa 虚高——
 * 而这个错误不会报任何异常，只会让你的 judge 看起来比实际好。
 */
export function chanceAgreement(judge: string[], human: string[]): number {
  if (judge.length !== human.length || judge.length === 0) {
    throw new Error('两组标签长度必须一致且非空')
  }
  const n = judge.length
  const labels = [...new Set([...judge, ...human])]
  return labels.reduce((s, l) => {
    const pj = judge.filter((v) => v === l).length / n
    const ph = human.filter((v) => v === l).length / n
    return s + pj * ph
  }, 0)
}

export function agreement(judge: string[], human: string[]): AgreementReport {
  if (judge.length !== human.length || judge.length === 0) {
    throw new Error('两组标签长度必须一致且非空')
  }
  const n = judge.length

  const raw = judge.filter((v, i) => v === human[i]).length / n
  const chance = chanceAgreement(judge, human)

  // chance 到 1 时 kappa 无定义。那种情况本身就是一个要报出来的问题。
  const kappa = chance >= 1 ? 0 : (raw - chance) / (1 - chance)

  const problems: string[] = []

  const judgeLabels = new Set(judge)
  if (judgeLabels.size === 1) {
    problems.push(
      `★ judge 只输出过一个标签（${[...judgeLabels][0]}）。` +
        `原始一致率 ${(raw * 100).toFixed(0)}% 完全来自标签分布，不来自判断能力——kappa 是 ${kappa.toFixed(2)}`,
    )
  }
  if (new Set(human).size === 1) {
    problems.push(
      '★ 人工标注只有一个标签。这个评测集没有区分度：' +
        '任何 judge 在上面都拿不到有意义的 kappa（偶然一致率已经是 1）',
    )
  }
  if (raw - kappa > 0.3) {
    problems.push(
      `原始一致率比 kappa 高 ${((raw - kappa) * 100).toFixed(0)} 个百分点。` +
        '这个差距主要来自标签分布，不来自 judge 质量——但它意味着**原始一致率不能当结论用**',
    )
  }
  if (kappa < 0.4 && judgeLabels.size > 1) {
    problems.push(`kappa ${kappa.toFixed(2)} 偏低。0.4 以下通常不足以拿来做上线决策`)
  }

  return { raw, chance, kappa, deflation: (raw - kappa) * 100, problems }
}

// ─────────────────────────────────────────────────────────────
// 四、judge 体检：五步，缺一步都会骗到你
// ─────────────────────────────────────────────────────────────

/** 一次成对判决：同一对答案，分别按 AB 和 BA 顺序问一次。 */
export interface PairedVerdict {
  /** AB 顺序下判谁赢。 */
  ab: 'A' | 'B' | 'tie'
  /** BA 顺序下判谁赢（已经换算回原来的 A/B 命名）。 */
  ba: 'A' | 'B' | 'tie'
  lenA: number
  lenB: number
}

/**
 * 位置偏见：|P(**排在前面**的那个赢) − 0.5|。
 *
 * ★ 这里有一个非常容易写错的地方，而写错之后测出来的数**看起来完全正常**。
 *
 * 直觉的写法是 `|P(A 赢) − 0.5|`。它是错的，因为 ab/ba 两个字段
 * 已经换算回内容命名了（见 PairedVerdict 的注释）。于是当 A 这个答案
 * 真的比 B 好、judge 也正确地两次都选了 A 时，`P(A 赢)` 是 1，
 * 那个式子会报出 0.5 的"位置偏见"——**而这个 judge 一点位置偏见都没有。**
 *
 * 换句话说 `|P(A 赢) − 0.5|` 测的是"A 这个答案有多常赢"，
 * 那是**内容分布**，不是位置偏见。只有在胜负恰好五五开的数据集上，
 * 这两件事才碰巧数值相等——而这就是为什么这个 bug 很难被发现。
 *
 * 正确的算法要看**位置**：
 *   · AB 顺序里，排在前面的是 A，所以 `ab === 'A'` 算"前面的赢"
 *   · BA 顺序里，排在前面的是 B，所以 `ba === 'B'` 算"前面的赢"
 *
 * 这样一来内容偏好会自动抵消：一个只看内容的 judge，
 * 在 AB 里选 A（前面赢）、在 BA 里也选 A（后面赢），一前一后正好抵平。
 *
 * ★ 由此还能推出一条恒等关系，很有用：
 *
 *     位置偏见 ≤ 位置翻转率 / 2
 *
 * 因为 ab === ba 的那些对必然一前一后各贡献一次，完全中和；
 * 只有翻转的对才能推动这个数。于是：
 *   · 翻转率 40%、位置偏见 0.20  → 翻转全朝一个方向，**系统性偏爱某个位置**
 *   · 翻转率 40%、位置偏见 0.01  → 翻转方向随机，**这不是偏见，是噪声**
 * 两者的修法完全不同，而只看位置偏见这个数是分不出来的。
 *
 * 经验数据（2026，21 个 judge）：
 *   · 最好的 0.002，最差的 0.192 —— 差近两个数量级
 *   · **同一家的两个型号能差 70 倍**（一个 0.002，一个 0.125）
 *   · 小模型、便宜模型显著更严重
 *   · 推理型模型会降低但**不会消除**——三个里只有一个降到 0.05 以下
 *
 * ★ 所以"我用的是好模型所以没有位置偏见"是不成立的。**这件事必须实测。**
 */
export function positionBias(verdicts: PairedVerdict[]): number {
  let firstWins = 0
  let decided = 0
  for (const v of verdicts) {
    // AB 顺序：排在前面的是 A
    if (v.ab !== 'tie') {
      decided++
      if (v.ab === 'A') firstWins++
    }
    // BA 顺序：排在前面的是 B
    if (v.ba !== 'tie') {
      decided++
      if (v.ba === 'B') firstWins++
    }
  }
  if (decided === 0) return 0
  return Math.abs(firstWins / decided - 0.5)
}

/**
 * 位置翻转率：同一对答案，换个顺序问就改主意的比例。
 *
 * 这个数比位置偏见更直观——它是"这个 judge 有多少判决是靠不住的"。
 */
export function flipRate(verdicts: PairedVerdict[]): number {
  if (verdicts.length === 0) return 0
  return verdicts.filter((v) => v.ab !== v.ba).length / verdicts.length
}

/**
 * 冗长偏见：答案长度差与判决方向的相关性。
 *
 * ★ 这一条是个**过时的常识**，值得专门讲一句。
 *
 * 2023 年的研究里冗长偏见很显著（报告的量级在 20-40%），
 * 于是"judge 偏爱长答案，记得在 rubric 里压一下"成了标准建议。
 *
 * 而 2026 那项 21 个 judge 的普查里，**所有 21 个模型的冗长偏见都低于 0.011**。
 * 这一条基本上被修掉了。
 *
 * 但两件事要注意：
 *   1. 那是在**单一成对 rubric** 下测的。换 rubric、加参考答案、
 *      要求写理由，都可能把它带回来——原论文自己在局限里写了这一点
 *   2. ★ **它被修掉了，不代表你不用测。** 测它很便宜（一个相关系数），
 *      而"我读过的文章说这个问题存在/不存在"不是证据
 */
export function verbosityBias(verdicts: PairedVerdict[]): number {
  const pts = verdicts
    .flatMap((v) => [
      { d: v.lenA - v.lenB, y: v.ab },
      { d: v.lenA - v.lenB, y: v.ba },
    ])
    .filter((p) => p.y !== 'tie')
    .map((p) => ({ x: p.d, y: p.y === 'A' ? 1 : -1 }))

  return pearson(pts.map((p) => p.x), pts.map((p) => p.y))
}

export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx
    const b = ys[i]! - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  const den = Math.sqrt(dx * dy)
  return den === 0 ? 0 : num / den
}

/**
 * 重测信度：同一个 judge、同样的输入、跑多次，结果有多稳。
 *
 * 每个元素是一次完整运行的判决序列。
 */
export function testRetest(runs: string[][]): number {
  if (runs.length < 2) throw new Error('至少要两次运行才能算重测信度')
  const n = runs[0]!.length
  if (runs.some((r) => r.length !== n)) throw new Error('每次运行的条目数必须一致')

  // 逐条看：这一条在各次运行里是否一致
  let stable = 0
  for (let i = 0; i < n; i++) {
    const vals = new Set(runs.map((r) => r[i]!))
    if (vals.size === 1) stable++
  }
  return n === 0 ? 0 : stable / n
}

export interface JudgeAudit {
  kappa: number
  raw: number
  positionBias: number
  flipRate: number
  verbosityBias: number
  testRetest: number
  problems: string[]
  /** 五步全过才能上线。 */
  deployable: boolean
}

/**
 * judge 上线前的体检。五步，缺一步都会骗到你。
 *
 * ★ 而第五步是最反直觉的那一步，它叫**一致性—偏见悖论**：
 *
 * 重测信度高**不等于** judge 可靠。
 *
 * 原因是这两个量测的是**两种不同的扰动**：
 *   · 重测信度：**同一个 prompt** 问多次，答案稳不稳
 *   · 位置偏见：把两个答案**换个顺序**（语义上无关的扰动），答案变不变
 *
 * 一个"永远选排在前面那个"的 judge，重测信度是满分（它完全确定），
 * 位置偏见也是满分（它只看位置）。**确定性在第二种扰动上一分钱都不值。**
 *
 * 2026 那项研究里有两个**已经在生产环境部署**的 judge 正好落在这个格子里：
 *   · 一个重测信度 0.992，位置偏见 0.192
 *   · 另一个重测信度 0.988，位置偏见 0.125
 *
 * 论文的原话值得记住：**最可复现的 judge 恰恰是最不可信的那些。**
 *
 * 而这正是最坑的地方——因为"我的评测每次跑分都一样"听起来
 * 完全像是一件好事，于是没人会去查它。
 */
export function auditJudge(opts: {
  judgeLabels: string[]
  humanLabels: string[]
  paired: PairedVerdict[]
  runs: string[][]
}): JudgeAudit {
  const agr = agreement(opts.judgeLabels, opts.humanLabels)
  const pb = positionBias(opts.paired)
  const fr = flipRate(opts.paired)
  const vb = verbosityBias(opts.paired)
  const tr = testRetest(opts.runs)

  const problems = [...agr.problems]

  if (pb > 0.1) {
    // ★ 位置偏见 ≤ 翻转率/2，所以 pb 大必然 fr 也大。
    // 有意思的是反过来不成立——见下面那个 else if。
    problems.push(
      `位置偏见 ${pb.toFixed(3)} 超过 0.10，且换个顺序问有 ${(fr * 100).toFixed(0)}% 的判决会变。` +
        `${(2 * pb) / Math.max(fr, 1e-9) > 0.99 ? '翻转全部' : `翻转里有 ${(((2 * pb) / Math.max(fr, 1e-9)) * 100).toFixed(0)}% `}` +
        '朝同一个方向——这是**系统性偏爱某个位置**，不是随机抖动。' +
        '修法是每条都 AB+BA 各问一次再合并，不一致的算 tie',
    )
  } else if (fr > 0.2) {
    // ★ 翻转率高但位置偏见低：翻转方向是随机的。
    // 这不是偏见，是**噪声**——而两者的修法完全不同：
    // 偏见靠 AB+BA 对称化能消掉，噪声只能靠降温度、加参考答案、多数投票。
    problems.push(
      `★ 位置翻转率 ${(fr * 100).toFixed(0)}% 很高，但位置偏见只有 ${pb.toFixed(3)}。` +
        '也就是说翻转的方向是随机的——**这不是位置偏见，是噪声**。' +
        '注意修法不同：偏见能靠 AB+BA 对称化消掉，噪声不能，' +
        '得降温度 / 给参考答案 / 多数投票',
    )
  }
  if (Math.abs(vb) > 0.05) {
    problems.push(`冗长偏见 ${vb.toFixed(3)}。judge 在跟着长度走，rubric 里要显式压一下`)
  }
  if (tr < 0.9) {
    problems.push(`重测信度 ${tr.toFixed(3)} 偏低。同样的输入结果都不稳，跑分差异分不清是改动还是抖动`)
  }

  // ★ 第五步：一致性—偏见悖论
  if (tr > 0.95 && pb > 0.1) {
    problems.push(
      `★ 一致性—偏见悖论：重测信度 ${tr.toFixed(3)} 很高，但位置偏见 ${pb.toFixed(3)} 也很高。` +
        '这不是"很稳所以可靠"，这是**它稳定地按位置而不是按质量在判**。' +
        '高稳定 + 高偏见是一种失效，不是一个优点',
    )
  }

  return {
    kappa: agr.kappa,
    raw: agr.raw,
    positionBias: pb,
    flipRate: fr,
    verbosityBias: vb,
    testRetest: tr,
    problems,
    deployable: problems.length === 0 && agr.kappa >= 0.4,
  }
}

// ─────────────────────────────────────────────────────────────
// 五、显著性：涨的那 2% 是真的吗
// ─────────────────────────────────────────────────────────────

/** 可复现的伪随机。测试要确定，所以不用 Math.random。 */
export function makeRng(seed = 42): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

export interface Interval {
  lo: number
  hi: number
}

/**
 * bootstrap 置信区间。
 *
 * ★ 为什么必须有这个：**评测集小，而小样本的置信区间宽得超乎直觉。**
 *
 * 150 条样本、成功率 80%，95% 置信区间大约是 ±6 个百分点。
 * 也就是说你测出 80%，真值在 74% 到 86% 之间都不奇怪。
 *
 * 那么"改动后从 80% 涨到 82%"意味着什么？**什么都不意味着。**
 *
 * 而这件事的危险不在于你会做错决定，在于**你会做很多错决定并且
 * 每次都觉得自己有数据支持**。
 */
export function bootstrapCI(scores: number[], opts: { iters?: number; seed?: number } = {}): Interval {
  const { iters = 2000, seed = 42 } = opts
  if (scores.length === 0) throw new Error('没有样本')
  const rand = makeRng(seed)
  const n = scores.length
  const means: number[] = []

  for (let it = 0; it < iters; it++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += scores[Math.floor(rand() * n)]!
    means.push(sum / n)
  }
  means.sort((a, b) => a - b)
  return {
    lo: means[Math.floor(iters * 0.025)]!,
    hi: means[Math.floor(iters * 0.975)]!,
  }
}

export interface DiffResult {
  before: number
  after: number
  delta: number
  /** 差值的置信区间。跨过 0 就是没结论。 */
  ci: Interval
  significant: boolean
  /** ★ 净变化背后的明细。 */
  fixed: string[]
  broken: string[]
  verdict: string
}

/**
 * 成对比较两次运行。
 *
 * ★ 这个函数最重要的输出不是 delta，是 fixed 和 broken 两个列表。
 *
 * 因为"净涨 2%"可以是下面任意一种，而它们要采取的行动完全不同：
 *
 *     修好 3 个，弄坏 0 个    → 干净的改进，合并
 *     修好 13 个，弄坏 10 个  → ★ 这不是改进，这是**换了一批 bug**
 *     修好 0 个，弄坏 0 个，
 *     只是 2 个 case 抖动了   → 噪声，什么都没发生
 *
 * 第二种是最需要被看见的：净值是正的，看起来该合并，
 * 但你实际上是在拿 10 个能用的 case 换 13 个。而如果那 10 个里
 * 有付费客户在用的路径，这个改动是净负的。
 *
 * **净值会把这件事藏起来。所以必须报明细。**
 */
export function compareRuns(
  before: Record<string, number>,
  after: Record<string, number>,
  opts: { seed?: number } = {},
): DiffResult {
  const ids = Object.keys(before).filter((id) => id in after)
  if (ids.length === 0) throw new Error('两次运行没有共同的样本 id，无法成对比较')

  const b = ids.map((id) => before[id]!)
  const a = ids.map((id) => after[id]!)
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length

  // ★ 成对差值的 bootstrap，不是两个均值各自的区间。
  // 成对能消掉"样本本身难易不同"这部分方差，功效高得多。
  const diffs = ids.map((_, i) => a[i]! - b[i]!)
  const ci = bootstrapCI(diffs, { seed: opts.seed ?? 42 })

  const fixed = ids.filter((id) => after[id]! > before[id]!)
  const broken = ids.filter((id) => after[id]! < before[id]!)
  const significant = ci.lo > 0 || ci.hi < 0

  // ★ 判断顺序很关键，而最自然的写法是错的。
  //
  // 直觉上会先分"显著 / 不显著"，再在显著的分支里报"换了一批 bug"。
  // 但那样这句话**永远不会出现**——因为换一批 bug 的净值恰恰很小，
  // 所以它总是落进"不显著"那一支。
  //
  // 于是最需要被看见的那种情况，被一句"不显著"盖掉了。
  // 正确的顺序是**先看弄坏了多少，再谈显著性**：弄坏了 10 个 case
  // 是一件确定发生了的事，不需要统计检验来确认。
  const churn =
    broken.length >= 3
      ? `★ 修好 ${fixed.length} 个，同时弄坏了 ${broken.length} 个。` +
        `**这不是改进，这是换了一批 bug。** 先看弄坏的那 ${broken.length} 个是什么` +
        `——如果里面有付费客户在走的路径，这个改动是净负的。`
      : broken.length > 0
        ? `修好 ${fixed.length} 个，弄坏 ${broken.length} 个。`
        : ''

  let stat: string
  if (!significant) {
    stat =
      `净变化 ${(mean(a) - mean(b)) * 100 >= 0 ? '+' : ''}${((mean(a) - mean(b)) * 100).toFixed(1)} 个百分点不显著` +
      `（差值区间 [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}] 跨过 0）。` +
      `★ 注意"看不出"不等于"没有"——也可能是 ${ids.length} 条样本还不够。`
  } else if (ci.hi < 0) {
    stat = `显著变差。`
  } else {
    stat = `净变化显著为正。`
  }

  const verdict =
    churn === '' && significant && ci.lo > 0
      ? `干净的改进：修好 ${fixed.length} 个，没有弄坏任何一个。`
      : churn === '' && !significant
        ? `${stat}没有任何 case 从通过变成失败——所以这不是回归，只是没测出效果。`
        : `${churn}${stat}`

  return {
    before: mean(b),
    after: mean(a),
    delta: mean(a) - mean(b),
    ci,
    significant,
    fixed,
    broken,
    verdict,
  }
}

// ─────────────────────────────────────────────────────────────
// 六、评测集腐化
// ─────────────────────────────────────────────────────────────

export interface RotReport {
  /** 还有区分度的条目：历史上有过通过也有过失败。 */
  live: string[]
  /** 一直全对的条目。它们不再提供信息。 */
  alwaysPass: string[]
  /** 一直全错的条目。可能是标注错了，或者是真的做不到。 */
  alwaysFail: string[]
  problems: string[]
}

/**
 * 评测集腐化检测。
 *
 * ★ 这件事必然发生，而且发生的原因正是你在正确地工作：
 *
 * 你照着评测集修 bug。修完那些 case 就永远通过了。
 * 于是你的评测集里可用的信息在**单调减少**，而总分在单调上升。
 *
 * 半年之后你有一个 96 分的评测集，其中 90% 的条目对任何改动都不敏感。
 * 那 96 分是真的，也是没用的——它不再能告诉你下一个改动是好是坏。
 *
 * 所以必须定期做两件事：
 *   1. 从生产日志里补新的失败样本（而 L13 那节的可观测性就是为了这个）
 *   2. 把一直全对的条目挪到一个"回归集"里——它们仍然要跑（防退化），
 *      但不该算进"当前能力"那个分数
 *
 * ★ 一直全错的条目要单独看：**它可能是标注错了。**
 * 一个永远失败的 case，比一个永远成功的 case 更值得花五分钟人工确认。
 */
export function detectRot(history: Record<string, number[]>): RotReport {
  const live: string[] = []
  const alwaysPass: string[] = []
  const alwaysFail: string[] = []

  for (const [id, runs] of Object.entries(history)) {
    if (runs.length === 0) continue
    const passes = runs.filter((s) => s >= 1).length
    if (passes === runs.length) alwaysPass.push(id)
    else if (passes === 0) alwaysFail.push(id)
    else live.push(id)
  }

  const total = live.length + alwaysPass.length + alwaysFail.length
  const problems: string[] = []

  if (total > 0 && live.length / total < 0.3) {
    problems.push(
      `只有 ${live.length}/${total} 条还有区分度。` +
        '这个评测集大部分条目对改动已经不敏感了——分数还会涨，但它不再能指导决策。' +
        '该从生产日志补新样本了',
    )
  }
  if (alwaysFail.length > 0) {
    problems.push(
      `${alwaysFail.length} 条从来没通过过：${alwaysFail.slice(0, 5).join('、')}。` +
        '★ 先人工确认标注对不对——永远失败的 case 里混着标错的样本，' +
        '而它们会让你去修一个不存在的问题',
    )
  }
  if (alwaysPass.length > 0) {
    problems.push(
      `${alwaysPass.length} 条一直全对。它们该挪进回归集：继续跑（防退化），` +
        '但不算进"当前能力"那个分数——不然分数会被它们撑高',
    )
  }

  return { live, alwaysPass, alwaysFail, problems }
}
