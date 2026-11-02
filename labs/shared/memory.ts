/**
 * 参考实现：长期记忆，以及防止它被污染。
 *
 * 短期记忆是上下文，L06 已经管过了。这个文件管的是**跨会话**的那部分。
 *
 * ★ 这一节最重要的判断：**长期记忆的主要风险不是记不住，是记错。**
 *
 * 记不住只是效率损失——重新问一遍就行。
 * 记错是**永久性的**：一条错误的事实写进去之后，每一次会话都会读到它、
 * 基于它做决定、并且从它推导出新的（同样错误的）结论。
 *
 * 所以这个模块的大部分代码不是「怎么存」，是「什么不许存」。
 */

// ─────────────────────────────────────────────────────────────
// 事实
// ─────────────────────────────────────────────────────────────

/**
 * ★ observed 和 derived 必须分开，而且不能互相转化。
 *
 *   observed —— 直接看到的。「用户说他用 pnpm」
 *   derived  —— 推导出来的。「用户偏好现代工具链」
 *
 * 为什么这个区分重要：**推导会复合误差。**
 * 从 derived 再推导一次，误差乘一次；三层之后你得到的是一个和事实
 * 只有远亲关系的判断，而它长得和 observed 一模一样。
 */
export type FactKind = 'observed' | 'derived'

export interface Fact {
  /** 命名空间化的键。'user.package_manager' 而不是 'pm'。 */
  key: string
  value: string
  kind: FactKind
  /**
   * 从哪来的。**没有出处的事实不许进长期记忆。**
   *
   * 这不是为了好看。出处是唯一能让人（和模型）判断这条对不对的东西，
   * 也是发现污染之后能顺着删掉一整批的唯一线索。
   */
  source: string
  /** 原话或者证据片段。让人一眼能看出这条是怎么来的。 */
  evidence?: string
  /** derived 的深度。observed 是 0。**深度有上限。** */
  depth: number
  confidence: number
  createdAt: number
  updatedAt: number
  /** 被召回过几次。从没被用过的事实优先淘汰。 */
  hits: number
  /** 多久之后算过期（毫秒）。undefined 表示不过期。 */
  ttlMs?: number
}

export interface MemoryOptions {
  /** 低于这个置信度不写。默认 0.6。 */
  minConfidence?: number
  /** derived 最多几层。默认 1——也就是不允许从 derived 再推导。 */
  maxDepth?: number
  /** 时钟，测试用。 */
  now?: () => number
}

export class MemoryError extends Error {
  constructor(msg: string, readonly fact: Partial<Fact>) {
    super(msg)
    this.name = 'MemoryError'
  }
}

/** 冲突：同一个 key 已经有一个不同的 value。 */
export interface Conflict {
  key: string
  existing: Fact
  incoming: Omit<Fact, 'createdAt' | 'updatedAt' | 'hits'>
}

export interface RememberResult {
  written: boolean
  /**
   * ★ 冲突不静默覆盖，也不静默忽略——两者都是污染的入口。
   *
   * 静默覆盖：一次幻觉就能永久改掉一条正确的事实。
   * 静默忽略：用户真的换了包管理器，你永远记着旧的。
   *
   * 所以返回冲突，让调用方决定，而且这个决定应该被记下来。
   */
  conflict?: Conflict
  reason?: string
}

// ─────────────────────────────────────────────────────────────

export class Memory {
  private readonly facts = new Map<string, Fact>()
  private readonly minConfidence: number
  private readonly maxDepth: number
  private readonly now: () => number

  constructor(opts: MemoryOptions = {}) {
    this.minConfidence = opts.minConfidence ?? 0.6
    this.maxDepth = opts.maxDepth ?? 1
    this.now = opts.now ?? (() => Date.now())
  }

  /**
   * 写入一条事实。四道闸，每一道都对应一类污染。
   */
  remember(
    input: Omit<Fact, 'createdAt' | 'updatedAt' | 'hits'>,
    opts: { resolve?: 'keep' | 'replace' } = {},
  ): RememberResult {
    // 闸一：必须有出处。
    if (!input.source.trim()) {
      throw new MemoryError('没有 source 的事实不许进长期记忆——发现污染时你没法顺着删', input)
    }

    // 闸二：observed 必须有证据。
    // derived 不强制，因为它的证据就是被推导的那些 observed。
    if (input.kind === 'observed' && !input.evidence?.trim()) {
      throw new MemoryError(
        'observed 的事实必须带 evidence（原话）。没有原话的"观察"其实是推导',
        input,
      )
    }

    // 闸三：深度上限。
    // 这一道最容易被忽略，也是"记忆慢慢跑偏"的主要机制。
    if (input.depth > this.maxDepth) {
      return {
        written: false,
        reason:
          `推导深度 ${input.depth} 超过上限 ${this.maxDepth}。` +
          '从推导结果再推导会复合误差，而结果长得和观察一模一样',
      }
    }

    // 闸四：置信度下限。
    if (input.confidence < this.minConfidence) {
      return {
        written: false,
        reason: `置信度 ${input.confidence} 低于下限 ${this.minConfidence}。宁可再问一次`,
      }
    }

    const t = this.now()
    const existing = this.facts.get(input.key)

    if (existing && existing.value !== input.value) {
      if (!opts.resolve) {
        return { written: false, conflict: { key: input.key, existing, incoming: input } }
      }
      if (opts.resolve === 'keep') {
        return { written: false, reason: '冲突，按调用方要求保留旧值' }
      }
      // ★ 一条真实的规则：observed 可以覆盖 derived，反过来不行。
      // 推导出来的结论不该推翻直接观察到的事实。
      if (existing.kind === 'observed' && input.kind === 'derived') {
        return {
          written: false,
          reason: '推导结果不许覆盖直接观察到的事实。要改就拿新的观察来改',
        }
      }
    }

    this.facts.set(input.key, {
      ...input,
      createdAt: existing?.createdAt ?? t,
      updatedAt: t,
      // hits 不继承。value 变了就是一条新事实，旧的使用次数不代表新值可靠。
      hits: existing && existing.value === input.value ? existing.hits : 0,
    })
    return { written: true }
  }

  /**
   * 召回。
   *
   * ★ 过期的事实**返回但标记 stale**，而不是直接藏起来。
   *
   * 藏起来的后果是模型不知道自己曾经知道过什么，于是重新问一遍——
   * 而重新问一遍在很多场景里比"知道但不确定"更烦人。
   * 标记 stale 之后，prompt 里可以写「这条可能过期了，用之前确认一下」。
   */
  recall(keys?: string[]): { fact: Fact; stale: boolean }[] {
    const t = this.now()
    const wanted = keys
      ? keys.flatMap((k) => {
          // 支持前缀查询：'user.' 拿到所有 user 命名空间的事实。
          if (k.endsWith('.')) {
            return [...this.facts.values()].filter((f) => f.key.startsWith(k))
          }
          const f = this.facts.get(k)
          return f ? [f] : []
        })
      : [...this.facts.values()]

    const seen = new Set<string>()
    const out: { fact: Fact; stale: boolean }[] = []
    for (const f of wanted) {
      if (seen.has(f.key)) continue
      seen.add(f.key)
      f.hits++
      out.push({ fact: f, stale: f.ttlMs !== undefined && t - f.updatedAt > f.ttlMs })
    }
    // observed 排在 derived 前面，同类按置信度降序。
    // 顺序影响模型的注意力分配（L05x），不是随便排的。
    return out.sort((a, b) => {
      if (a.fact.kind !== b.fact.kind) return a.fact.kind === 'observed' ? -1 : 1
      return b.fact.confidence - a.fact.confidence
    })
  }

  /** 显式删除。发现污染之后按 source 批量删是最常见的操作。 */
  forget(pred: (f: Fact) => boolean): number {
    let n = 0
    for (const [k, f] of [...this.facts.entries()]) {
      if (pred(f)) {
        this.facts.delete(k)
        n++
      }
    }
    return n
  }

  /**
   * 淘汰。
   *
   * ★ 遗忘是功能不是 bug。
   *
   * 不淘汰的记忆会累积过期事实，而过期事实的危害和错误事实一样——
   * 「用户偏好用 npm」在六个月后可能已经是错的，但它看起来和真的一样。
   *
   * 淘汰顺序：先过期的，再从没被召回过的，最后最旧的。
   */
  evict(limit: number): Fact[] {
    if (this.facts.size <= limit) return []
    const t = this.now()
    const scored = [...this.facts.values()].map((f) => ({
      f,
      // 分数越低越先淘汰。
      score:
        (f.ttlMs !== undefined && t - f.updatedAt > f.ttlMs ? -1000 : 0) +
        f.hits * 10 +
        f.confidence * 5 +
        (f.kind === 'observed' ? 3 : 0) -
        (t - f.updatedAt) / 86_400_000,
    }))
    scored.sort((a, b) => a.score - b.score)
    const drop = scored.slice(0, this.facts.size - limit).map((s) => s.f)
    for (const f of drop) this.facts.delete(f.key)
    return drop
  }

  get size(): number {
    return this.facts.size
  }

  all(): Fact[] {
    return [...this.facts.values()]
  }
}

// ─────────────────────────────────────────────────────────────
// 渲染进 prompt
// ─────────────────────────────────────────────────────────────

/**
 * 把记忆渲染成给模型看的文本。
 *
 * ★ 必须带出处，而且必须区分观察和推导。
 *
 * 因为模型会把你给它的一切当成事实——你写「用户偏好 pnpm」，
 * 它就当这是铁律，哪怕这条是三个月前从一句话推导出来的。
 *
 * 带上出处和类型之后，模型至少有机会说「我记得你之前提过用 pnpm，
 * 现在还是吗」——而这句话正是防止污染扩散的那道人工闸。
 */
export function renderMemory(items: { fact: Fact; stale: boolean }[]): string {
  if (items.length === 0) return ''

  const lines: string[] = ['<memory>']
  const observed = items.filter((i) => i.fact.kind === 'observed')
  const derived = items.filter((i) => i.fact.kind === 'derived')

  if (observed.length > 0) {
    lines.push('  <observed>  <!-- 直接观察到的，可以当事实用 -->')
    for (const { fact, stale } of observed) {
      lines.push(`    ${fact.key} = ${fact.value}${mark(fact, stale)}`)
    }
    lines.push('  </observed>')
  }

  if (derived.length > 0) {
    lines.push('  <derived>  <!-- 推导出来的，用之前先确认 -->')
    for (const { fact, stale } of derived) {
      lines.push(`    ${fact.key} = ${fact.value}${mark(fact, stale)}`)
    }
    lines.push('  </derived>')
  }

  lines.push('</memory>')
  return lines.join('\n')
}

function mark(f: Fact, stale: boolean): string {
  const bits = [`出处：${f.source}`]
  if (f.evidence) bits.push(`原话："${trim(f.evidence, 60)}"`)
  if (f.confidence < 0.9) bits.push(`置信度 ${f.confidence.toFixed(2)}`)
  if (stale) bits.push('★ 可能已过期，用之前确认')
  return `  （${bits.join('；')}）`
}

const trim = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…')

// ─────────────────────────────────────────────────────────────
// 从对话里抽事实
// ─────────────────────────────────────────────────────────────

export interface Extraction {
  key: string
  value: string
  kind: FactKind
  evidence?: string
  confidence: number
}

/**
 * 抽取用的 prompt。
 *
 * ★ 这个 prompt 里最重要的不是「抽什么」，是「不抽什么」。
 *
 * 让模型自由决定该记什么，是记忆污染的头号来源：它会把一次性的东西
 * （「这个文件在 src/a.ts」）、临时状态（「现在在调试」）、
 * 和自己的推测（「用户可能是后端工程师」）一起写进长期记忆。
 */
export const extractPrompt = `从下面这段对话里抽取值得**长期**记住的事实。

只抽这四类：
1. 用户明确表达的偏好（工具、风格、流程）
2. 项目的稳定事实（技术栈、目录约定、部署方式）
3. 用户明确要求你记住的东西
4. 反复出现的约束（"我们不用 X"）

**不要抽这些：**
- 一次性的信息（某个文件的当前内容、某次报错的细节）
- 临时状态（"现在在调试这个函数"）
- 你的推测（"用户可能是后端工程师"）
- 从上面几条推导出来的概括（"用户偏好现代工具链"）

输出格式，每行一条，没有就输出 NONE：

    key | value | observed|derived | 置信度 | 原话

key 用点号命名空间，比如 user.package_manager、project.test_runner。
置信度是 0 到 1 的小数。**原话必须是对话里真实出现过的片段**，不要改写。

对话：
{conversation}`

/**
 * 解析抽取结果。
 *
 * ★ 严格解析，坏行**跳过并记数**而不是猜。
 *
 * 记忆的入口是最不能宽容的地方：一条格式错误的行猜错了字段位置，
 * 就是一条错误的事实永久写进去。**宁可少记一条，不要记错一条。**
 */
export function parseExtraction(raw: string): { facts: Extraction[]; skipped: string[] } {
  const facts: Extraction[] = []
  const skipped: string[] = []

  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t === 'NONE') continue
    // 剥掉模型爱加的列表符号。
    const body = t.replace(/^[\s\-*·\d.、)]+/, '')
    const parts = body.split('|').map((p) => p.trim())
    if (parts.length < 4) {
      skipped.push(t)
      continue
    }
    const [key, value, kindRaw, confRaw, evidence] = parts
    const kind = kindRaw === 'observed' ? 'observed' : kindRaw === 'derived' ? 'derived' : null
    const confidence = Number(confRaw)

    if (!key || !value || !kind || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      skipped.push(t)
      continue
    }
    // key 必须命名空间化。不强制的话你三个月后会有 pm、packageManager、
    // package_manager 三条互相矛盾的事实。
    if (!key.includes('.')) {
      skipped.push(t)
      continue
    }

    facts.push({ key, value, kind, confidence, evidence: evidence || undefined })
  }

  return { facts, skipped }
}

/**
 * 检测抽取结果里的自相矛盾。
 *
 * 模型在同一次抽取里就可能给出两条冲突的事实（对话里用户改了主意）。
 * **在写入之前检测，比写入之后靠冲突解决更便宜。**
 */
export function findContradictions(facts: Extraction[]): { key: string; values: string[] }[] {
  const byKey = new Map<string, Set<string>>()
  for (const f of facts) {
    const s = byKey.get(f.key) ?? new Set<string>()
    s.add(f.value)
    byKey.set(f.key, s)
  }
  return [...byKey.entries()]
    .filter(([, vs]) => vs.size > 1)
    .map(([key, vs]) => ({ key, values: [...vs] }))
}
