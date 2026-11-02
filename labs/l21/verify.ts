/**
 * 验证 l21/map.ts。MAP_IMPL=shared pnpm verify:l21
 */

import * as shared from '../shared/knowledge.ts'
import { courseGraph } from '../shared/knowledge.ts'

const TARGET = process.env.MAP_IMPL === 'shared' ? 'shared' : 'mine'

async function loadMine() {
  const m = await import('./map.ts')
  return {
    validateGraph: m.myValidateGraph,
    blastRadius: m.myBlastRadius,
    findStale: m.myFindStale,
    sourceWeight: m.mySourceWeight,
    shortestRequiresPath: m.myShortestRequiresPath,
    prerequisites: shared.prerequisites,
    dependents: shared.dependents,
  }
}

type Api = {
  validateGraph: typeof shared.validateGraph
  blastRadius: typeof shared.blastRadius
  findStale: typeof shared.findStale
  sourceWeight: typeof shared.sourceWeight
  shortestRequiresPath: typeof shared.shortestRequiresPath
  prerequisites: typeof shared.prerequisites
  dependents: typeof shared.dependents
}

const M: Api =
  TARGET === 'shared'
    ? {
        validateGraph: shared.validateGraph,
        blastRadius: shared.blastRadius,
        findStale: shared.findStale,
        sourceWeight: shared.sourceWeight,
        shortestRequiresPath: shared.shortestRequiresPath,
        prerequisites: shared.prerequisites,
        dependents: shared.dependents,
      }
    : ((await loadMine()) as Api)

console.log(
  TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l21/ 里你的实现）',
)

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

let passed = 0
let failed = 0
function ok(c: boolean, n: string): void {
  if (c) passed++
  else {
    failed++
    console.log(red(`  ✗ ${n}`))
  }
}
function eq(a: unknown, b: unknown, n: string): void {
  const as = JSON.stringify(a)
  const bs = JSON.stringify(b)
  ok(as === bs, n + (as === bs ? '' : ` (got ${as}, want ${bs})`))
}
function section(t: string): void {
  console.log(bold(`\n${t}`))
}

const g = courseGraph()

section('A · 图校验')
eq(M.validateGraph(g), [], 'GRAPH-1 骨架合法')
ok(
  M.validateGraph({
    nodes: [
      { id: 'a', title: 'A', lesson: 'L0', invariant: 'x', evidenceAt: 1 },
      { id: 'a', title: 'A2', lesson: 'L0', invariant: 'y', evidenceAt: 1 },
    ],
    edges: [],
  }).some((x) => x.includes('重复')),
  'GRAPH-2 重复 id',
)
ok(
  M.validateGraph({
    nodes: [{ id: 'a', title: 'A', lesson: 'L0', invariant: 'x', evidenceAt: 1 }],
    edges: [{ from: 'a', to: 'missing', kind: 'requires' }],
  }).some((x) => x.includes('missing')),
  'GRAPH-3 边悬空',
)

section('B · 路径与影响面')
eq(M.prerequisites(g, 'eval.gate').sort(), ['eval.kappa', 'eval.resolve'].sort(), 'PATH-1 gate 前提')
const path = M.shortestRequiresPath(g, 'eval.gate', 'edit.not_unique')
ok(path !== null && path[0] === 'eval.gate' && path[path.length - 1] === 'edit.not_unique', 'PATH-2 可达')
ok(path!.includes('eval.resolve'), 'PATH-3 经 resolve')
eq(M.shortestRequiresPath(g, 'edit.not_unique', 'eval.gate'), null, 'PATH-4 反向不可达（仅 requires 向下）')
const blast = M.blastRadius(g, 'edit.not_unique')
ok(blast.includes('eval.resolve'), 'BLAST-1 resolve 被波及')
ok(blast.includes('eval.gate'), 'BLAST-2 gate 被波及')
ok(!blast.includes('edit.not_unique'), 'BLAST-3 不含自身')

section('C · 过期')
const now = Date.UTC(2026, 9, 9)
const stale = M.findStale(g, now, 60)
ok(stale.some((s) => s.id === 'eval.kappa'), 'STALE-1 kappa 账龄>60')
ok(!stale.some((s) => s.id === 'edit.not_unique'), 'STALE-2 新证据未过期')
const staleAll = M.findStale(
  {
    nodes: [{ id: 'x', title: 'X', lesson: 'L', invariant: 'i', evidenceAt: 0 }],
    edges: [],
  },
  now,
  1,
)
ok(staleAll[0]?.ageDays === Infinity, 'STALE-3 未知证据')

section('D · 来源权重')
ok(M.sourceWeight({ id: 'o', trust: 0.5, reproducible: true, kind: 'own_verify' }) >= 0.9, 'SRC-1 own')
ok(M.sourceWeight({ id: 't', trust: 0.9, reproducible: false, kind: 'twitter' }) <= 0.2, 'SRC-2 twitter 封顶')
ok(M.sourceWeight({ id: 'b', trust: 0.8, reproducible: false, kind: 'vendor_blog' }) <= 0.6, 'SRC-3 blog 封顶')
ok(
  M.sourceWeight({ id: 'p', trust: 0.8, reproducible: true, kind: 'paper' }) >
    M.sourceWeight({ id: 'p2', trust: 0.8, reproducible: false, kind: 'paper' }),
  'SRC-4 reproducible 加成',
)
// 先封顶再加成：顺序反过来，这两条会是 0.6 和 0.2
eq(
  [
    M.sourceWeight({ id: 'b2', trust: 0.8, reproducible: true, kind: 'vendor_blog' }),
    M.sourceWeight({ id: 't2', trust: 0.9, reproducible: true, kind: 'twitter' }),
  ],
  [0.7, 0.3],
  'SRC-5 封顶在加成之前',
)
eq(
  M.sourceWeight({ id: 'p3', trust: 0.0625, reproducible: false, kind: 'paper' }),
  0.063,
  'SRC-6 平局舍入两门语言一致',
)

console.log()
if (failed === 0) {
  console.log(green(`  ✓ ${passed} 条断言全部通过`))
  console.log(
    dim(
      '\n  最该记住的五条：\n' +
        '    GRAPH   边的端点必须存在\n' +
        '    PATH    requires 链 = 补课顺序\n' +
        '    BLAST   证据作废时的影响面\n' +
        '    STALE   过期=该重读，不是自动删节点\n' +
        '    SRC     own_verify 抬升；twitter 封顶\n',
    ),
  )
  process.exit(0)
}
console.log(red(`  ✗ ${failed} 失败 / ${passed} 通过`))
process.exit(1)
