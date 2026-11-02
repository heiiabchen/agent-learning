/**
 * L21 的脚手架。跑法：pnpm map
 *
 * 观察：依赖链、影响面、过期节点、信息源权重。
 * 零模型。TODO 写完跑 pnpm verify:l21。
 */

import {
  blastRadius,
  courseGraph,
  findStale,
  prerequisites,
  shortestRequiresPath,
  sourceWeight,
  validateGraph,
  type KnowledgeGraph,
  type Source,
} from '../shared/knowledge.ts'
import { isMain } from '../shared/entry.ts'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const w = (s: string) =>
  [...visible(s)].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - w(s)))

function exp1(): void {
  console.log(bold('\n实验一：从门禁往下，requires 链要补什么'))
  const g = courseGraph()
  const path = shortestRequiresPath(g, 'eval.gate', 'edit.not_unique')
  console.log(`  eval.gate → edit.not_unique：${path ? path.join(' → ') : '不可达'}`)
  console.log(`  eval.gate 的直接前提：${prerequisites(g, 'eval.gate').join(', ')}`)
  console.log(dim('\n  面试前一晚别从随机博客补；沿 requires 链补断裂点。'))
}

function exp2(): void {
  console.log(bold('\n实验二：若 NOT_UNIQUE 的证据作废，谁被波及'))
  const g = courseGraph()
  const blast = blastRadius(g, 'edit.not_unique')
  console.log(`  影响面（${blast.length}）：${blast.join(', ')}`)
  console.log(dim('\n  重读一篇编辑论文时，把 blast 里的课的 Key 框一并核对。'))
}

function exp3(): void {
  console.log(bold('\n实验三：把证据时间拨旧，看谁该重读'))
  const g = courseGraph()
  const now = Date.UTC(2026, 9, 9)
  const stale = findStale(g, now, 60)
  console.log(`  ${pad('节点', 22)}${pad('账龄(天)', 10)}波及`)
  console.log('  ' + '─'.repeat(50))
  for (const s of stale.slice(0, 5)) {
    const age = s.ageDays === Infinity ? '未知' : String(s.ageDays)
    console.log(`  ${pad(s.id, 22)}${pad(age, 10)}${s.blast.length}`)
  }
  console.log(dim('\n  过期≠错误；等于「叙事仍在用，证据该重核」。'))
}

function exp4(): void {
  console.log(bold('\n实验四：同一句话，不同来源的权重'))
  const sources: Source[] = [
    { id: 'own', trust: 0.5, reproducible: true, kind: 'own_verify' },
    { id: 'paper', trust: 0.8, reproducible: true, kind: 'paper' },
    { id: 'blog', trust: 0.8, reproducible: false, kind: 'vendor_blog' },
    { id: 'tw', trust: 0.9, reproducible: false, kind: 'twitter' },
  ]
  console.log(`  ${pad('来源', 14)}加权 trust`)
  console.log('  ' + '─'.repeat(28))
  for (const s of sources) {
    console.log(`  ${pad(s.id, 14)}${sourceWeight(s).toFixed(3)}`)
  }
  console.log(dim('\n  twitter 再自信也封顶；own_verify 即使自谦也被抬到 ≥0.9。'))
}

function observe(): void {
  console.log(bold('L21 · 观察实验（参考实现）'))
  console.log(dim('地图是方法，不是百科。节点会过期，边的 kind 不会。'))
  const gaps = validateGraph(courseGraph())
  console.log(dim(`  骨架图校验 gaps=${gaps.length}`))
  exp1()
  exp2()
  exp3()
  exp4()
}

export function myValidateGraph(g: KnowledgeGraph): string[] {
  throw new Error('TODO 1 未实现')
}

export function myBlastRadius(g: KnowledgeGraph, id: string): string[] {
  throw new Error('TODO 2 未实现')
}

export function myFindStale(
  g: KnowledgeGraph,
  now: number,
  maxAgeDays: number,
): ReturnType<typeof findStale> {
  throw new Error('TODO 3 未实现')
}

export function mySourceWeight(s: Source): number {
  throw new Error('TODO 4 未实现')
}

export function myShortestRequiresPath(
  g: KnowledgeGraph,
  from: string,
  to: string,
): string[] | null {
  throw new Error('TODO 5 未实现')
}

void myValidateGraph
void myBlastRadius
void myFindStale
void mySourceWeight
void myShortestRequiresPath

if (isMain(import.meta.url)) {
  observe()
  console.log(
    dim(
      '\n  下一步：实现五个 TODO，然后跑 pnpm verify:l21（或 uv run python -m l21.verify）。',
    ) +
      dim('\n  想先确认测试本身是对的，跑 MAP_IMPL=shared 下的 verify。') +
      dim('\n  观察实验：pnpm map / uv run python -m l21.map\n'),
  )
}
