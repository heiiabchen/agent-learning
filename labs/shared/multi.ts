/**
 * 参考实现：多 agent 系统。
 *
 * 这个文件的组织方式和别的参考实现不一样。别的文件是"实现一个能力"，
 * 这个文件是**实现四道闸 + 一台计价器**。
 *
 * 理由：多 agent 的技术实现是简单的（就是嵌套调用 runAgent），
 * 难的全在"什么时候不该这么做"和"这么做要花多少钱"上。
 * 所以这里的代码分量落在校验和会计上，而不是编排本身。
 *
 * 一个必须先说清的定义：
 *
 *   **多 agent ≠ 多次模型调用。**
 *   L07 那五种编排模式全都是多次调用，但它们是单 agent——
 *   因为只有一个上下文。
 *
 *   多 agent 的定义性特征是**上下文隔离**：每个 agent 有自己的
 *   上下文窗口、自己的工具、自己的循环。它们之间只能通过
 *   序列化的文本互相传话。
 *
 * 而"只能通过文本传话"这一条，是这一节所有麻烦的来源。
 */

import type { Totals } from './ledger.ts'
import { estimateTokens } from './context.ts'

// ─────────────────────────────────────────────────────────────
// 一、任务书：sub-agent 唯一能看到的东西
// ─────────────────────────────────────────────────────────────

/**
 * 派给一个 sub-agent 的任务书。
 *
 * ★ 字段不是随便定的。Anthropic 在生产里踩出来的结论是：
 * 一份任务书必须包含**目标、输出格式、工具/信源指引、任务边界**四项。
 * 缺了边界，多个 sub-agent 会做重复的活；缺了输出格式，
 * 编排者拿到一堆没法合并的散文。
 */
export interface Brief {
  /** 派给谁。日志和 trace 里靠它区分，必须唯一。 */
  agent: string
  /** 做什么。一句话，动词开头。 */
  goal: string
  /**
   * sub-agent 需要但看不到的背景。
   *
   * ★ 这个字段是整个多 agent 设计里最容易被低估的一个。
   * 编排者知道的一切，sub-agent **一个字都看不到**——
   * 它是一个全新的上下文。你不写进来，它就得靠猜。
   */
  context: string
  /** 交付什么形状的东西。合并靠它。 */
  deliverable: string
  /**
   * 边界：明确**不要**做什么。
   *
   * 这一项看起来像客套话，实际上是防重复劳动的唯一手段。
   * 三个 sub-agent 都被派去"研究供应链"的时候，
   * 只有边界能让它们分头去查不同的部分。
   */
  boundaries: string[]
  /** 允许用的工具。空数组表示不限（而这通常是个 bug）。 */
  tools: string[]
}

export interface BriefProblem {
  kind: 'dangling_reference' | 'no_context' | 'no_deliverable' | 'no_boundaries' | 'no_tools' | 'goal_too_vague'
  /** 给写任务书的人看的话，不是给模型看的。 */
  message: string
}

/**
 * 指代词表。任务书里出现这些，几乎必然是在引用 sub-agent 看不到的东西。
 *
 * ★ 这是这一节最实用的一条检查。"上面提到的那个文件"在编排者的上下文里
 * 有明确所指，在 sub-agent 那里是**一个空引用**——而 sub-agent 不会报错，
 * 它会编一个出来，然后基于编出来的东西干完整个任务。
 */
const DANGLING = [
  '上面', '上述', '前面提到', '刚才', '之前说的', '如前', '同上',
  '那个文件', '这个文件', '该文件', '它的', '他们的',
  'the above', 'as mentioned', 'aforementioned', 'as discussed', 'that file',
]

const VAGUE_GOALS = ['研究', '调查', '看一下', '分析', '了解', 'research', 'investigate', 'look into', 'analyze']

/**
 * 校验一份任务书。
 *
 * 返回 problems 而不是抛异常：一份任务书可能有多处问题，
 * 一次全报出来比修一个跑一次快得多。
 */
export function checkBrief(b: Brief): { ok: boolean; problems: BriefProblem[] } {
  const problems: BriefProblem[] = []
  const all = `${b.goal} ${b.context} ${b.deliverable}`

  for (const word of DANGLING) {
    if (all.includes(word)) {
      problems.push({
        kind: 'dangling_reference',
        message:
          `任务书里出现了「${word}」。sub-agent 是一个全新的上下文，` +
          `它看不到编排者的对话历史——这是一个空引用。\n` +
          `      而它不会报错：它会编一个所指出来，然后基于编出来的东西干完整个任务。`,
      })
      break
    }
  }

  if (b.context.trim().length === 0) {
    problems.push({
      kind: 'no_context',
      message: 'context 是空的。编排者知道的一切，sub-agent 一个字都看不到。',
    })
  }

  if (b.deliverable.trim().length === 0) {
    problems.push({
      kind: 'no_deliverable',
      message: '没有 deliverable。编排者最后会拿到一堆形状不一样、没法合并的散文。',
    })
  }

  if (b.boundaries.length === 0) {
    problems.push({
      kind: 'no_boundaries',
      message:
        '没有 boundaries。这是重复劳动的唯一成因：' +
        '三个 sub-agent 都被派去「研究供应链」时，只有边界能让它们分头查不同的部分。',
    })
  }

  if (b.tools.length === 0) {
    problems.push({
      kind: 'no_tools',
      message:
        'tools 是空的（不限）。一个能用全部工具的 sub-agent 会自己发明工作范围，' +
        '而它的账单由你付。',
    })
  }

  // 目标只有一个动词、没有宾语限定 —— Anthropic 踩过的那个坑：
  // "research the semiconductor shortage" 派给三个 agent，两个查了同一件事。
  const goal = b.goal.trim()
  if (VAGUE_GOALS.some((v) => goal.startsWith(v)) && goal.length < 14) {
    problems.push({
      kind: 'goal_too_vague',
      message:
        `目标「${goal}」太宽。派给三个 sub-agent，它们会各自决定这句话是什么意思——` +
        `实测结果是其中两个查了同一件事。`,
    })
  }

  return { ok: problems.length === 0, problems }
}

// ─────────────────────────────────────────────────────────────
// 二、重复劳动：多 agent 最贵的失效
// ─────────────────────────────────────────────────────────────

export interface Overlap {
  a: string
  b: string
  /** 0~1。共同关键词占较短那份的比例。 */
  score: number
  shared: string[]
}

/** 中英混排的粗分词。和 L09 的 tokenize 同一套思路，这里只要关键词。 */
function keywords(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9_]{2,}|[\u4e00-\u9fa5]{2,}/g)) {
    const w = m[0]
    // 中文长词切成二元组，"供应链危机" 和 "供应链短缺" 才能对上
    if (/[\u4e00-\u9fa5]/.test(w)) {
      for (let i = 0; i + 2 <= w.length; i++) out.add(w.slice(i, i + 2))
    } else {
      out.add(w)
    }
  }
  return out
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'について'])

/**
 * 检测一批任务书之间的重复。
 *
 * ★ 为什么这件事必须在**派发之前**做：sub-agent 之间不共享上下文，
 * 所以它们**没有任何办法发现自己在做重复的活**。
 * 三个 agent 查同一件事，你会付三份钱、拿到三份内容雷同的报告，
 * 而唯一的症状是"这次特别贵"。
 */
export function detectOverlap(briefs: Brief[], threshold = 0.5): Overlap[] {
  const kw = briefs.map((b) => {
    const s = keywords(`${b.goal} ${b.deliverable}`)
    for (const w of STOP) s.delete(w)
    return s
  })

  const out: Overlap[] = []
  for (let i = 0; i < briefs.length; i++) {
    for (let j = i + 1; j < briefs.length; j++) {
      const shared = [...kw[i]!].filter((w) => kw[j]!.has(w))
      const smaller = Math.min(kw[i]!.size, kw[j]!.size)
      // 分母用较短那份而不是并集：一个宽任务和一个窄任务重叠时，
      // 并集会把分数摊薄，而实际上窄的那个整个被包含了。
      const score = smaller === 0 ? 0 : shared.length / smaller
      if (score >= threshold) {
        out.push({ a: briefs[i]!.agent, b: briefs[j]!.agent, score, shared: shared.slice(0, 8) })
      }
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// 三、写冲突：并行 sub-agent 的硬约束
// ─────────────────────────────────────────────────────────────

export interface WriteConflict {
  resource: string
  agents: string[]
}

/**
 * 检测并行 sub-agent 的写冲突。
 *
 * ★ 这是全节最有用的一条经验判据：**并行 sub-agent 必须是只读的。**
 *
 * 理由不是"并发难写对"，是更根本的：sub-agent 之间没有共享状态，
 * 所以它们**看不到彼此的写入**。两个 agent 同时改同一个文件，
 * 后写的覆盖先写的，而且两边都认为自己成功了——
 * 它们的报告都会说"已完成"。
 *
 * Anthropic 的说法是"大多数编程任务里真正可并行的部分比研究少得多"。
 * 这一句值得记住，因为这门课的 capstone 就是一个编程 agent。
 */
export function checkWriteConflicts(
  briefs: Brief[],
  writeTools: string[] = ['write_file', 'edit_file', 'run_command', 'delete_file'],
): WriteConflict[] {
  const byResource = new Map<string, Set<string>>()

  for (const b of briefs) {
    const writes = b.tools.filter((t) => writeTools.includes(t))
    if (writes.length === 0) continue
    // 资源粒度就用任务书里提到的路径。粒度粗，但"粗"在这里是安全的方向。
    const paths = [...`${b.goal} ${b.deliverable} ${b.context}`.matchAll(/[\w./-]+\.\w{1,5}\b/g)].map((m) => m[0])
    for (const p of paths.length > 0 ? paths : ['(未指明路径)']) {
      const set = byResource.get(p) ?? new Set()
      set.add(b.agent)
      byResource.set(p, set)
    }
  }

  return [...byResource.entries()]
    .filter(([, agents]) => agents.size > 1)
    .map(([resource, agents]) => ({ resource, agents: [...agents] }))
}

// ─────────────────────────────────────────────────────────────
// 四、投入分级：别为一个简单问题开十个 agent
// ─────────────────────────────────────────────────────────────

export type Tier = 'single' | 'small_fanout' | 'large_fanout'

export interface Effort {
  tier: Tier
  agents: number
  toolCallsEach: number
  why: string
}

/**
 * 根据任务复杂度决定开几个 agent。
 *
 * ★ 这套分级不是我编的，是 Anthropic 写进 prompt 里的规则——
 * 因为**模型自己判断不了该投入多少**。
 * 他们早期版本的真实故障是：一个简单查询开了 50 个 sub-agent。
 *
 * 所以这件事不能交给模型。它是代码。
 */
export function planEffort(input: {
  /** 独立方向的个数。1 表示这件事没法拆。 */
  independentThreads: number
  /** 要不要写东西。写 = 不能并行。 */
  needsWrite: boolean
  /** 语料是不是超过单个上下文窗口。 */
  exceedsContext: boolean
}): Effort {
  const { independentThreads, needsWrite, exceedsContext } = input

  if (needsWrite) {
    return {
      tier: 'single',
      agents: 1,
      toolCallsEach: 15,
      why: '要写东西。并行 sub-agent 看不到彼此的写入，后写的覆盖先写的，而两边都报告成功。',
    }
  }

  if (independentThreads <= 1) {
    return {
      tier: 'single',
      agents: 1,
      toolCallsEach: 10,
      why: '只有一个独立方向。开多个 agent 只是把同一条路走多遍，付 N 倍的钱。',
    }
  }

  if (independentThreads <= 4 && !exceedsContext) {
    return {
      tier: 'small_fanout',
      agents: Math.min(independentThreads, 4),
      toolCallsEach: 12,
      why: `${independentThreads} 个独立方向，语料塞得下。小扇出，每个 agent 的边界要写清楚。`,
    }
  }

  return {
    tier: 'large_fanout',
    agents: Math.min(independentThreads, 10),
    toolCallsEach: 12,
    why:
      `${independentThreads} 个独立方向` +
      (exceedsContext ? '，且语料超过单个上下文窗口' : '') +
      '。这是多 agent 唯一真正划算的场景：你买的是并行探索的容量。',
  }
}

// ─────────────────────────────────────────────────────────────
// 五、报告：sub-agent 唯一能交回来的东西
// ─────────────────────────────────────────────────────────────

export interface Report {
  agent: string
  ok: boolean
  /** 摘要。**编排者只能看到这个**，看不到 sub-agent 的对话历史。 */
  summary: string
  /**
   * 证据引用，不是证据内容。
   *
   * ★ 这是 Anthropic 说的"避免传话游戏"：sub-agent 把产物写到外部
   * （文件、对象存储），只把**轻量引用**交回编排者。
   * 直接把全文塞回去有两个代价：编排者的上下文被撑爆，
   * 以及内容在每一次转述里损失一点。
   */
  evidence: string[]
  usage: Totals
  steps: number
  /** 为什么停。step_limit 的报告不能当成"做完了"。 */
  reason: string
}

export interface Merged {
  summary: string
  /** 互相矛盾的结论。**不合并、不静默挑一个。** */
  conflicts: { agents: string[]; claim: string }[]
  /** 没跑成的 agent。缺口必须显式，不能表现为"结论少了一条"。 */
  gaps: { agent: string; reason: string }[]
  /** 所有证据引用的并集，去重。 */
  evidence: string[]
}

/** 从摘要里抽出形如 "X：Y" 或 "X = Y" 的断言，用来找矛盾。 */
function claimsOf(summary: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of summary.split('\n')) {
    const m = line.match(/^\s*[-·*]?\s*([^：:=]{2,40})\s*[：:=]\s*(.+?)\s*$/)
    if (m) out.set(m[1]!.trim(), m[2]!.trim())
  }
  return out
}

/**
 * 合并多份报告。
 *
 * ★ 这个函数最重要的行为是它**不做**的事：它不在矛盾的结论里挑一个。
 *
 * 编排者只看到摘要，看不到任何一个 sub-agent 的原始材料。
 * 它没有能力判断哪一份对。让它"综合一下"的结果是一段
 * 读起来很顺、把两个矛盾结论糊在一起的文字——
 * 而这是多 agent 系统里最难发现的错误，因为输出**看起来质量很高**。
 */
export function mergeReports(reports: Report[]): Merged {
  const gaps = reports
    .filter((r) => !r.ok || r.reason !== 'done')
    .map((r) => ({ agent: r.agent, reason: r.ok ? `停在 ${r.reason}` : `失败：${r.reason}` }))

  const good = reports.filter((r) => r.ok && r.reason === 'done')

  // 找矛盾：同一个键、不同的值
  const byKey = new Map<string, { agent: string; value: string }[]>()
  for (const r of good) {
    for (const [k, v] of claimsOf(r.summary)) {
      const list = byKey.get(k) ?? []
      list.push({ agent: r.agent, value: v })
      byKey.set(k, list)
    }
  }

  const conflicts: Merged['conflicts'] = []
  for (const [k, list] of byKey) {
    const distinct = new Set(list.map((x) => x.value))
    if (distinct.size > 1) {
      conflicts.push({
        agents: list.map((x) => x.agent),
        claim: `${k}：${[...distinct].join(' ／ ')}`,
      })
    }
  }

  const evidence = [...new Set(good.flatMap((r) => r.evidence))]

  return {
    summary: good.map((r) => `【${r.agent}】${r.summary}`).join('\n\n'),
    conflicts,
    gaps,
    evidence,
  }
}

// ─────────────────────────────────────────────────────────────
// 六、计价器：15 倍是怎么来的
// ─────────────────────────────────────────────────────────────

export interface CostShape {
  /** 工具定义的 token 数（每一轮每个 agent 都要付）。 */
  toolDefTokens: number
  /** 一次工具返回的平均大小。 */
  toolResultTokens: number
  /** 任务书的平均大小。单 agent 里这一项是 0。 */
  briefTokens: number
  /** 报告的平均大小。单 agent 里这一项是 0。 */
  reportTokens: number
}

export interface CostBreakdown {
  label: string
  /** 累计输入 token。这是账单的主要构成。 */
  inputTokens: number
  /** 拆开看：钱花在哪。 */
  parts: { toolDefs: number; growth: number; coordination: number }
  calls: number
  agents: number
}

/**
 * 单 agent 的输入 token 累计。
 *
 * 核心是 L02 就讲过的那件事：**上下文每一轮都重发一遍。**
 * 第 k 步的输入 ≈ 工具定义 + 前 k−1 步累积的工具结果。
 * 所以总量是 O(n²)。
 */
export function costSingle(steps: number, shape: CostShape): CostBreakdown {
  let growth = 0
  for (let k = 0; k < steps; k++) growth += k * shape.toolResultTokens
  const toolDefs = steps * shape.toolDefTokens

  return {
    label: `单 agent（${steps} 步）`,
    inputTokens: toolDefs + growth,
    parts: { toolDefs, growth, coordination: 0 },
    calls: steps,
    agents: 1,
  }
}

/**
 * 多 agent 的输入 token 累计。
 *
 * ★ 这个函数的价值全在 parts 那三项拆分上。
 * "多 agent 贵 15 倍"这个结论没什么用；
 * **知道 15 倍里有多少是协调开销、多少是重复付的工具定义**，才能决策。
 *
 * 三笔钱：
 *   toolDefs      —— 工具定义付 (N+1) 份，不是 1 份
 *   growth        —— N 个 sub-agent 各自的 O(k²)，加上编排者自己的
 *   coordination  —— 任务书和报告。**这一笔在单 agent 里根本不存在**
 */
export function costMulti(
  agents: number,
  stepsEach: number,
  shape: CostShape,
  opts: { orchestratorSteps?: number } = {},
): CostBreakdown {
  const orchSteps = opts.orchestratorSteps ?? agents + 2

  // sub-agent：每个都是一个完整的小循环，各自从零开始
  let subGrowth = 0
  for (let k = 0; k < stepsEach; k++) subGrowth += k * shape.toolResultTokens
  subGrowth *= agents

  // sub-agent 的工具定义要付 agents 份，每份 stepsEach 轮
  const subToolDefs = agents * stepsEach * shape.toolDefTokens

  // 编排者：上下文里装的是任务书和报告，随收到的报告增长
  let orchGrowth = 0
  for (let k = 0; k < orchSteps; k++) orchGrowth += k * shape.reportTokens
  const orchToolDefs = orchSteps * shape.toolDefTokens

  // 协调开销：任务书发出去一次、但在 sub-agent 的每一轮都重发；报告同理
  const coordination = agents * stepsEach * shape.briefTokens + agents * shape.reportTokens

  return {
    label: `多 agent（${agents} 个 × ${stepsEach} 步）`,
    inputTokens: subToolDefs + orchToolDefs + subGrowth + orchGrowth + coordination,
    parts: {
      toolDefs: subToolDefs + orchToolDefs,
      growth: subGrowth + orchGrowth,
      coordination,
    },
    calls: agents * stepsEach + orchSteps,
    agents: agents + 1,
  }
}

/**
 * 一次普通聊天的输入量，作为倍数的分母。
 *
 * ★ 聊天里**没有工具定义、也没有工具结果**——这正是它便宜的原因，
 * 也是为什么它能当分母。用 toolResultTokens 当每轮增量是个建模错误：
 * 那会把聊天算成一个没有工具的 agent，分母虚高、倍数虚低。
 */
export function costChat(turnTokens = 250, turns = 6): CostBreakdown {
  let growth = 0
  for (let k = 0; k < turns; k++) growth += k * turnTokens
  return {
    label: `纯聊天（${turns} 轮）`,
    inputTokens: growth,
    parts: { toolDefs: 0, growth, coordination: 0 },
    calls: turns,
    agents: 0,
  }
}

// ─────────────────────────────────────────────────────────────
// 七、选型：这一节的第一判据
// ─────────────────────────────────────────────────────────────

export type Topology = 'single' | 'workflow' | 'multi_agent' | 'handoff'

export interface TopologyChoice {
  topology: Topology
  why: string
}

/**
 * 该不该上多 agent。
 *
 * 和 L07 的 choosePattern、L09 的 chooseRetrieval、L10 的"该不该上 MCP"
 * 是同一类判据，而且**顺序上它在 L07 那个之后**：
 * 先确定要不要 agent，再确定要不要多个。
 */
export function chooseTopology(input: {
  independentThreads: number
  needsWrite: boolean
  exceedsContext: boolean
  /** 各步骤之间有没有依赖。有依赖 = 不能并行。 */
  hasDependencies: boolean
  /** 任务的单次价值。多 agent 的 15 倍成本要有东西来抵。 */
  valuePerTask: 'low' | 'high'
  /** 要不要在处理过程中切换到一个完全不同的专长。 */
  needsSpecialistSwitch: boolean
}): TopologyChoice {
  const { independentThreads, needsWrite, exceedsContext, hasDependencies, valuePerTask, needsSpecialistSwitch } = input

  if (hasDependencies && independentThreads > 1) {
    return {
      topology: 'workflow',
      why: '步骤之间有依赖。这是 workflow，不是多 agent——依赖关系应该写在代码里，不该让模型在运行时协调。',
    }
  }

  if (needsWrite) {
    return {
      topology: 'single',
      why: '要写东西。并行 sub-agent 看不到彼此的写入，而且都会报告成功。',
    }
  }

  if (needsSpecialistSwitch && independentThreads <= 1) {
    return {
      topology: 'handoff',
      why: '一条线程，但中途要换专长。交接（转移控制权、共享历史）比派 sub-agent 便宜，因为不用重新组装上下文。',
    }
  }

  if (independentThreads <= 1) {
    return {
      topology: 'single',
      why: '只有一个独立方向。多 agent 在这里就是把同一条路走多遍。',
    }
  }

  if (valuePerTask === 'low' && !exceedsContext) {
    return {
      topology: 'single',
      why: '有并行空间，但任务单次价值低。15 倍的 token 成本没有东西来抵——先用单 agent，等它真的成了瓶颈再说。',
    }
  }

  return {
    topology: 'multi_agent',
    why:
      `${independentThreads} 个独立方向、只读、` +
      (exceedsContext ? '语料超过单个上下文窗口、' : '') +
      '任务价值高。这是多 agent 划算的那种场景。',
  }
}

// ─────────────────────────────────────────────────────────────
// 八、派发：四道闸
// ─────────────────────────────────────────────────────────────

export interface FanoutOptions {
  /** 最多开几个。防"简单查询开 50 个 agent"。 */
  maxAgents: number
  /** 递归深度上限。sub-agent 能不能再开 sub-agent。 */
  maxDepth: number
  /** 总预算，元。 */
  maxYuan: number
  /** 并发度。 */
  concurrency: number
  /** 当前深度，递归时传。 */
  depth?: number
}

export interface FanoutResult {
  reports: Report[]
  merged: Merged
  /** 被闸拦下来的任务书，以及拦下的理由。 */
  rejected: { agent: string; reason: string }[]
  /** 派发之前查出来的问题。**不为空就不该派。** */
  preflight: { overlaps: Overlap[]; conflicts: WriteConflict[]; briefProblems: Record<string, BriefProblem[]> }
}

/** 跑一个 sub-agent。抽象成类型，让 verify 能塞假的。 */
export type SubAgentRunner = (brief: Brief) => Promise<Report>

/**
 * 派发一批 sub-agent。
 *
 * ★ 派发**之前**先做体检，而且体检结果要返回给调用方，不是打个日志。
 *
 * 理由：重复劳动和写冲突这两件事，一旦派出去就无法挽回——
 * 钱已经花了，文件已经被覆盖了。而它们在派发前是**完全可以静态查出来的**。
 */
export async function fanout(
  briefs: Brief[],
  run: SubAgentRunner,
  opts: FanoutOptions,
): Promise<FanoutResult> {
  const depth = opts.depth ?? 0
  const rejected: { agent: string; reason: string }[] = []

  const preflight = {
    overlaps: detectOverlap(briefs),
    conflicts: checkWriteConflicts(briefs),
    briefProblems: Object.fromEntries(
      briefs.map((b) => [b.agent, checkBrief(b).problems]).filter(([, p]) => (p as BriefProblem[]).length > 0),
    ) as Record<string, BriefProblem[]>,
  }

  if (depth >= opts.maxDepth) {
    return {
      reports: [],
      merged: mergeReports([]),
      rejected: briefs.map((b) => ({
        agent: b.agent,
        reason: `深度 ${depth} 已达上限 ${opts.maxDepth}。没有这道闸的话，sub-agent 开 sub-agent 是指数级的账单。`,
      })),
      preflight,
    }
  }

  // 数量闸：截断而不是报错，但被截掉的要显式列出来。
  // 静默截断的后果是"结论少了一条"，而那看起来像模型没找到。
  let todo = briefs
  if (briefs.length > opts.maxAgents) {
    todo = briefs.slice(0, opts.maxAgents)
    for (const b of briefs.slice(opts.maxAgents)) {
      rejected.push({ agent: b.agent, reason: `超过 maxAgents=${opts.maxAgents}，没有派发` })
    }
  }

  const reports: Report[] = []
  let spent = 0

  // 分批跑，每批之间检查预算。
  // ★ 预算要在**批之间**检查，不能只在开头查一次：
  // 一个失控的 sub-agent 能把整个预算吃掉，而后面的 agent 应该被拦住而不是照跑。
  for (let i = 0; i < todo.length; i += opts.concurrency) {
    if (spent >= opts.maxYuan) {
      for (const b of todo.slice(i)) {
        rejected.push({ agent: b.agent, reason: `预算已用完（${spent.toFixed(4)} / ${opts.maxYuan} 元）` })
      }
      break
    }

    const batch = todo.slice(i, i + opts.concurrency)
    const settled = await Promise.allSettled(batch.map((b) => run(b)))

    settled.forEach((s, j) => {
      const b = batch[j]!
      if (s.status === 'fulfilled') {
        reports.push(s.value)
        spent += s.value.usage.yuan
      } else {
        // 一个 sub-agent 崩了不该让整批白跑。但它必须变成一条 gap，
        // 而不是消失——见 mergeReports 里 gaps 那个字段。
        reports.push({
          agent: b.agent,
          ok: false,
          summary: '',
          evidence: [],
          usage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, ms: 0, yuan: 0 },
          steps: 0,
          reason: String((s.reason as Error)?.message ?? s.reason),
        })
      }
    })
  }

  return { reports, merged: mergeReports(reports), rejected, preflight }
}

// ─────────────────────────────────────────────────────────────
// 九、交接：和 sub-agent 完全不同的一件事
// ─────────────────────────────────────────────────────────────

export interface HandoffStep {
  from: string
  to: string
  reason: string
}

export interface HandoffResult {
  /** 最后接手的那个 agent。 */
  final: string
  path: HandoffStep[]
  /** 环。检测到就中止——两个 agent 互相踢皮球是真实故障。 */
  loop?: string[]
}

/**
 * 交接：把控制权转给另一个 agent，**共享同一份对话历史**。
 *
 * ★ 和 sub-agent 的区别不是"实现方式"，是**信息模型**：
 *
 *   sub-agent  上下文隔离。要把背景序列化进任务书，结果序列化成报告。
 *              贵、有损、可并行。
 *   交接        上下文共享。接手的 agent 看得到全部历史。
 *              便宜、无损、**只能串行**。
 *
 * 所以判据很干脆：**要并行就 sub-agent，不要并行就交接。**
 * 用 sub-agent 做串行的事，等于白付两次序列化的钱和一次信息损失。
 */
export function handoff(
  start: string,
  route: (agent: string) => { to: string; reason: string } | null,
  maxHops = 8,
): HandoffResult {
  const path: HandoffStep[] = []
  const visited = new Set<string>([start])
  let cur = start

  for (let i = 0; i < maxHops; i++) {
    const next = route(cur)
    if (!next) return { final: cur, path }

    path.push({ from: cur, to: next.to, reason: next.reason })

    // ★ 环检测。两个 agent 互相交接是真实故障模式，
    // 而它的表现是"请求一直不返回"——没有异常、没有错误日志。
    if (visited.has(next.to)) {
      return { final: cur, path, loop: [...visited, next.to] }
    }

    visited.add(next.to)
    cur = next.to
  }

  return { final: cur, path, loop: [...visited] }
}

// ─────────────────────────────────────────────────────────────
// 十、报告压缩：传话游戏的代价
// ─────────────────────────────────────────────────────────────

export interface TelephoneResult {
  /** 每一跳之后剩下的信息量（token 估计）。 */
  hops: { stage: string; tokens: number; kept: number }[]
  /** 相对原文的保留比例。 */
  retention: number
}

/**
 * 量化"传话游戏"：原始材料经过 sub-agent 摘要、编排者综合之后还剩多少。
 *
 * ★ 这个函数不是为了算准，是为了让一件事变得可见：
 * **多 agent 的信息路径上有两次有损压缩，而单 agent 一次都没有。**
 *
 * sub-agent 读了 8000 token 的材料，写出 300 token 的摘要；
 * 编排者读了 3 份摘要（900 token），写出 400 token 的结论。
 * 最终结论和原始材料之间隔了两层转述，而**编排者没有任何办法回去核对**。
 *
 * 这就是为什么 Anthropic 的做法是让 sub-agent 把产物写到文件、
 * 只把引用交回去——把"转述"换成"指针"。
 */
export function telephone(input: {
  rawTokens: number
  agents: number
  summaryTokensEach: number
  finalTokens: number
}): TelephoneResult {
  const { rawTokens, agents, summaryTokensEach, finalTokens } = input
  const afterSummaries = agents * summaryTokensEach

  return {
    hops: [
      { stage: '原始材料', tokens: rawTokens, kept: 1 },
      { stage: `${agents} 份 sub-agent 摘要`, tokens: afterSummaries, kept: afterSummaries / rawTokens },
      { stage: '编排者综合', tokens: finalTokens, kept: finalTokens / rawTokens },
    ],
    retention: finalTokens / rawTokens,
  }
}

/** 把一份报告改成"引用式"：内容落盘，只留指针。 */
export function toArtifactRef(report: Report, store: (agent: string, body: string) => string): Report {
  if (report.summary.length === 0) return report
  const ref = store(report.agent, report.summary)
  const head = report.summary.split('\n')[0] ?? ''
  return {
    ...report,
    // 留一行给编排者做路由判断，全文在 ref 里。
    summary: `${head.slice(0, 120)}（全文见 ${ref}）`,
    evidence: [...report.evidence, ref],
  }
}

/** 估算一段文本的 token。给 demo 用。 */
export const tokensOf = (s: string) => estimateTokens(s)
