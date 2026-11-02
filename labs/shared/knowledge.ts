/**
 * L21 知识地图：概念图 + 过期判定 + 信息源权重。
 *
 * 领域半年换一代——地图的价值不是「背节点」，是：
 *   · 一条依赖链断了你能定位影响面
 *   · 一条边的 evidence 过期了你知道该重读什么
 *   · 信息源默认不可信，权重要可算
 *
 * ★ 零模型：图是数据，算法是纯函数。
 */

import { cmpCodePoint } from './codingEval.ts'

export type EdgeKind =
  | 'requires' // A 需要先理解 B
  | 'contrasts' // A 与 B 是易混对
  | 'measured_by' // A 的对错由 B 度量
  | 'iou' // A 给 B 留下欠条

export interface ConceptNode {
  id: string
  title: string
  /** 所属课，如 L17 */
  lesson: string
  /** 核心不变量（一句话） */
  invariant: string
  /** 证据最后核实的 Unix ms；0 = 未知 */
  evidenceAt: number
}

export interface ConceptEdge {
  from: string
  to: string
  kind: EdgeKind
  note?: string
}

export interface KnowledgeGraph {
  nodes: ConceptNode[]
  edges: ConceptEdge[]
}

export interface Source {
  id: string
  /** 0–1，越高越可信；厂商博客默认低于论文/自己的 verify */
  trust: number
  /** 是否一作可复核（有测试、有数据、有代码） */
  reproducible: boolean
  kind: 'paper' | 'official_doc' | 'vendor_blog' | 'own_verify' | 'twitter'
}

/** 课程骨架图——交付时钉死；学生可在 lab 扩展，不改 shared。 */
export function courseGraph(): KnowledgeGraph {
  const nodes: ConceptNode[] = [
    {
      id: 'edit.not_unique',
      title: 'NOT_UNIQUE 编辑',
      lesson: 'L17',
      invariant: '多匹配零写入，逼模型扩大上下文',
      evidenceAt: Date.UTC(2026, 9, 1),
    },
    {
      id: 'edit.can_stop',
      title: 'canStop 时序',
      lesson: 'L17',
      invariant: 'verify 必须在最后一次 edit 之后',
      evidenceAt: Date.UTC(2026, 9, 1),
    },
    {
      id: 'eval.resolve',
      title: 'resolve 口径',
      lesson: 'L18',
      invariant: '主指标不是 apply；改测试=hacked',
      evidenceAt: Date.UTC(2026, 9, 1),
    },
    {
      id: 'eval.gate',
      title: 'regress/claim 门',
      lesson: 'L18',
      invariant: '非劣与优效分两门',
      evidenceAt: Date.UTC(2026, 9, 1),
    },
    {
      id: 'ops.checkpoint',
      title: 'checkpoint 续跑',
      lesson: 'L19',
      invariant: '续断点不是新 job',
      evidenceAt: Date.UTC(2026, 9, 1),
    },
    {
      id: 'ops.idempotency',
      title: '写操作幂等键',
      lesson: 'L19',
      invariant: 'unsafe 无 key 禁止自动重试',
      evidenceAt: Date.UTC(2026, 9, 1),
    },
    {
      id: 'ui.can_execute',
      title: 'canExecute≠展示',
      lesson: 'L16',
      invariant: '审批卡在能否执行',
      evidenceAt: Date.UTC(2026, 8, 1),
    },
    {
      id: 'eval.kappa',
      title: 'kappa 主指标',
      lesson: 'L12',
      invariant: '原始一致率可为零信息',
      evidenceAt: Date.UTC(2026, 6, 1),
    },
    {
      id: 'budget.usage',
      title: 'usage 证缓存',
      lesson: 'L15',
      invariant: '不用 TTFT 侧信道',
      evidenceAt: Date.UTC(2026, 7, 1),
    },
    {
      id: 'sandbox.prefix',
      title: '路径不是 startsWith',
      lesson: 'L17',
      invariant: 'ws-evil 必须挡住',
      evidenceAt: Date.UTC(2026, 9, 1),
    },
  ]

  const edges: ConceptEdge[] = [
    { from: 'edit.can_stop', to: 'edit.not_unique', kind: 'requires', note: '先能改对再谈终止' },
    { from: 'eval.resolve', to: 'edit.can_stop', kind: 'requires' },
    { from: 'eval.gate', to: 'eval.resolve', kind: 'requires' },
    { from: 'eval.gate', to: 'eval.kappa', kind: 'requires', note: '门禁卫生来自 L12' },
    { from: 'eval.resolve', to: 'edit.not_unique', kind: 'measured_by' },
    { from: 'ops.checkpoint', to: 'ops.idempotency', kind: 'requires' },
    { from: 'ops.idempotency', to: 'edit.not_unique', kind: 'contrasts', note: '都在防双份' },
    { from: 'ui.can_execute', to: 'ops.checkpoint', kind: 'iou', note: '审批记忆在 L19 兑付' },
    { from: 'sandbox.prefix', to: 'edit.not_unique', kind: 'requires' },
    { from: 'budget.usage', to: 'eval.gate', kind: 'contrasts', note: '都谈「证明」而非感觉' },
  ]

  return { nodes, edges }
}

export function nodeById(g: KnowledgeGraph, id: string): ConceptNode | undefined {
  return g.nodes.find((n) => n.id === id)
}

export function validateGraph(g: KnowledgeGraph): string[] {
  const gaps: string[] = []
  const ids = new Set(g.nodes.map((n) => n.id))
  if (ids.size !== g.nodes.length) gaps.push('存在重复 node id')
  for (const e of g.edges) {
    if (!ids.has(e.from)) gaps.push(`边 from 不存在：${e.from}`)
    if (!ids.has(e.to)) gaps.push(`边 to 不存在：${e.to}`)
  }
  return gaps
}

/** requires 边的反向邻接：谁依赖我 */
export function dependents(g: KnowledgeGraph, id: string): string[] {
  return g.edges
    .filter((e) => e.kind === 'requires' && e.to === id)
    .map((e) => e.from)
    .sort(cmpCodePoint)
}

/** 从 start 沿 requires 走到 prerequisites（to 方向） */
export function prerequisites(g: KnowledgeGraph, id: string): string[] {
  return g.edges
    .filter((e) => e.kind === 'requires' && e.from === id)
    .map((e) => e.to)
    .sort(cmpCodePoint)
}

/**
 * 影响面：若 concept 的证据作废，沿 requires 反向 BFS 能波及的节点。
 */
export function blastRadius(g: KnowledgeGraph, id: string): string[] {
  const seen = new Set<string>()
  const q = [id]
  while (q.length) {
    const cur = q.shift()!
    for (const d of dependents(g, cur)) {
      if (!seen.has(d)) {
        seen.add(d)
        q.push(d)
      }
    }
  }
  return [...seen].sort(cmpCodePoint)
}

export interface StaleReport {
  id: string
  ageDays: number
  blast: string[]
}

/**
 * evidenceAt + maxAgeDays < now → 过期。
 * ★ 过期不等于错误，等于「该重读」；blast 告诉你谁会被叙事拖下水。
 */
export function findStale(
  g: KnowledgeGraph,
  now: number,
  maxAgeDays: number,
): StaleReport[] {
  const ms = maxAgeDays * 86_400_000
  const out: StaleReport[] = []
  for (const n of g.nodes) {
    if (n.evidenceAt === 0) {
      out.push({ id: n.id, ageDays: Infinity, blast: blastRadius(g, n.id) })
      continue
    }
    const age = now - n.evidenceAt
    if (age > ms) {
      out.push({
        id: n.id,
        ageDays: Math.floor(age / 86_400_000),
        blast: blastRadius(g, n.id),
      })
    }
  }
  return out.sort((a, b) => cmpCodePoint(a.id, b.id))
}

/**
 * 信息源加权：own_verify 与 reproducible paper 抬升；twitter 封顶。
 *
 * ★ 先按来源封顶，再给可复核加成：可复核的 vendor_blog 最高 0.7、twitter 最高 0.3（SRC-5）。
 * ★ 舍入用 floor(x + 0.5)：Python 的 round() 平局取偶，0.0625 会给 0.062（SRC-6）。
 */
export function sourceWeight(s: Source): number {
  let t = s.trust
  if (s.kind === 'own_verify') t = Math.max(t, 0.9)
  if (s.kind === 'twitter') t = Math.min(t, 0.2)
  if (s.kind === 'vendor_blog') t = Math.min(t, 0.6)
  if (s.reproducible) t = Math.min(1, t + 0.1)
  if (!s.reproducible && s.kind === 'paper') t = Math.min(t, 0.7)
  return Math.floor(t * 1000 + 0.5) / 1000
}

/** 最短 requires 路径（BFS）。用于「要从 A 补到 B 先补什么」。 */
export function shortestRequiresPath(
  g: KnowledgeGraph,
  from: string,
  to: string,
): string[] | null {
  if (from === to) return [from]
  const q: string[][] = [[from]]
  const seen = new Set([from])
  while (q.length) {
    const path = q.shift()!
    const cur = path[path.length - 1]!
    for (const nxt of prerequisites(g, cur)) {
      if (seen.has(nxt)) continue
      const nextPath = [...path, nxt]
      if (nxt === to) return nextPath
      seen.add(nxt)
      q.push(nextPath)
    }
  }
  return null
}
