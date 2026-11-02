/**
 * 验证 l09x/kb.ts。
 *   KB_IMPL=shared pnpm verify:l09x
 *   pnpm verify:l09x
 *
 * 零网络、零模型、零向量库。所有输入来自 fixtures/corpus.json 和 kb.ts 里的确定性夹具。
 */

import * as shared from '../shared/kb.ts'
import type { KbChunk, ParsedDoc, ParsedPage, Session, TableData } from '../shared/kb.ts'
import { fmtFixed } from '../shared/codingEval.ts'
import {
  AS_OF,
  GEN,
  allChunks,
  annFixture,
  annVisible,
  badDocs,
  budgetTable,
  docById,
  loadCorpus,
  runSync,
  tenantDocs,
  versionScenarios,
} from './kb.ts'

const TARGET = process.env.KB_IMPL === 'shared' ? 'shared' : 'mine'

type Api = {
  headingLevel: typeof shared.headingLevel
  renderTableRows: typeof shared.renderTableRows
  searchFiltered: typeof shared.searchFiltered
  rerankPipeline: typeof shared.rerankPipeline
  resolveVersions: typeof shared.resolveVersions
  applySync: typeof shared.applySync
  cacheKey: typeof shared.cacheKey
}

async function loadMine(): Promise<Api> {
  const m = await import('./kb.ts')
  return {
    headingLevel: m.myHeadingLevel,
    renderTableRows: m.myRenderTableRows,
    searchFiltered: m.mySearchFiltered,
    rerankPipeline: m.myRerankPipeline,
    resolveVersions: m.myResolveVersions,
    applySync: m.myApplySync,
    cacheKey: m.myCacheKey,
  }
}

const M: Api =
  TARGET === 'shared'
    ? {
        headingLevel: shared.headingLevel,
        renderTableRows: shared.renderTableRows,
        searchFiltered: shared.searchFiltered,
        rerankPipeline: shared.rerankPipeline,
        resolveVersions: shared.resolveVersions,
        applySync: shared.applySync,
        cacheKey: shared.cacheKey,
      }
    : await loadMine()

console.log(
  TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l09x/ 里你的实现）',
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

const J = (x: unknown) => JSON.stringify(x)
const C = loadCorpus()
const U = C.users as Record<string, Session>
const mineOpts = () => ({ headingLevel: M.headingLevel, renderTableRows: M.renderTableRows })
const chunksOf = (id: string): KbChunk[] => shared.chunkDocument(docById(C, id), GEN, mineOpts())
const everything = (): KbChunk[] => allChunks(C, mineOpts())
const PRE = { k: 10, ef: 40, maxScan: 400, mode: 'pre' as const }

// ─────────────────────────────────────────────────────────────
section('PARSE · 解析后清洗')

const page = (index0: number, top: string): ParsedPage => ({
  index0,
  blocks: [
    { id: `p${index0}b0`, kind: 'text', text: top, y: 40 },
    { id: `p${index0}b1`, kind: 'text', text: `正文第 ${index0} 页。`, y: 400 },
  ],
})

t('PARSE-1', '跨页统计出页眉「青禾科技 内部资料」', () => {
  const r = shared.detectRunningLines(docById(C, 'travel-2023').pages)
  need(J(r) === J(['青禾科技 内部资料']), `实际 ${J(r)}`)
})
t('PARSE-2', '只在两页顶部出现的行不算页眉（minPages = 3）', () => {
  const two = shared.detectRunningLines([page(0, '第二章 住宿标准'), page(1, '第二章 住宿标准'), page(2, '第三章 报销流程')])
  need(two.length === 0, `两页就删了：${J(two)}`)
  const three = shared.detectRunningLines([page(0, '机密'), page(1, '机密'), page(2, '机密')])
  need(J(three) === J(['机密']), `三页应检出，实际 ${J(three)}`)
})
t('PARSE-3', 'chunk 里没有页眉和页码行', () => {
  for (const c of chunksOf('travel-2023')) {
    need(!c.text.includes('青禾科技 内部资料'), `${c.id} 里还有页眉`)
    need(!c.text.includes('— 1 —') && !c.text.includes('— ii —'), `${c.id} 里还有页码行`)
  }
})
t('PARSE-4', '脚注「① 不含外包人员费用。」附在预算表的每一行上', () => {
  const rows = chunksOf('budget-2025').filter((c) => c.kind === 'table_row')
  need(rows.length > 0, '没有表格行 chunk')
  for (const r of rows) need(r.text.includes('① 不含外包人员费用。'), `${r.id} 没带脚注：${J(r.text)}`)
})
t('PARSE-5', '跨页表格的后半段继承表头；跨页段落的页码是一个范围', () => {
  const cs = chunksOf('budget-2025')
  const admin = cs.find((c) => c.text.includes('行政部'))
  need(admin !== undefined && admin.text.includes('2025年/金额: 400') && J(admin.pages) === '[2,2]', `行政部那行：${J(admin)}`)
  const tail = cs.find((c) => c.text.includes('经财务部审批后方可列支'))
  need(tail !== undefined && J(tail.pages) === '[2,3]' && tail.text.includes('超支部分须经财务部审批'), `跨页段落：${J(tail)}`)
})
t('PARSE-6', 'normalizeText 先去 BOM 再 NFKC', () => {
  need(shared.normalizeText('\uFEFF第一章').startsWith('第'), 'BOM 没去掉')
  need(shared.normalizeText('（１）') === '(1)', `实际 ${J(shared.normalizeText('（１）'))}`)
  need(shared.kbTokenize('第３条').includes('3'), `切词前没做 NFKC：${J(shared.kbTokenize('第３条'))}`)
})

// ─────────────────────────────────────────────────────────────
section('NUM · 中文编号')

const lv = (s: string) => M.headingLevel(s)?.level ?? null

t('NUM-1', '「第十二条」是条级，「第三章」是章级', () => {
  const h = M.headingLevel('第十二条 适用范围')
  need(h !== null && h.level === 3 && h.label === '第十二条', `实际 ${J(h)}`)
  need(lv('第三章 报销流程') === 1 && lv('第二节 标准') === 2, `章 ${lv('第三章 报销流程')}，节 ${lv('第二节 标准')}`)
})
t('NUM-2', '全角括号与半角括号同级', () => {
  need(lv('（一）总则') === 2 && lv('(一)总则') === 2, `（一）${lv('（一）总则')}，(一) ${lv('(一)总则')}`)
})
t('NUM-3', '全角数字与半角数字同级', () => {
  need(lv('１、总则') !== null && lv('１、总则') === lv('1、总则'), `１、${lv('１、总则')}，1、${lv('1、总则')}`)
  need(lv('（２）住宿') === 4, `（２）应为 4 级，实际 ${lv('（２）住宿')}`)
})
t('NUM-4', 'GB/T 9704 四级序：一、<（一）< 1. <（1）', () => {
  const xs = [lv('一、总则'), lv('（一）编制依据'), lv('1. 适用范围'), lv('（1）人员费用')]
  need(xs.every((x) => x !== null) && xs[0]! < xs[1]! && xs[1]! < xs[2]! && xs[2]! < xs[3]!, `实际 ${J(xs)}`)
})
t('NUM-5', '多级小节越长越深', () => {
  const xs = [lv('1. 总则'), lv('1.1 节'), lv('1.1.2 小节')]
  need(xs.every((x) => x !== null) && xs[0]! < xs[1]! && xs[1]! < xs[2]!, `实际 ${J(xs)}`)
})
t('NUM-6', '数字开头的正文不是标题', () => {
  for (const s of ['2025年预算增长10%。', '1.5元以内的发票可以不贴', '本办法自 2023 年起施行。', '300 元为上限']) {
    need(M.headingLevel(s) === null, `${J(s)} 被当成了标题：${J(M.headingLevel(s))}`)
  }
})

// ─────────────────────────────────────────────────────────────
section('TABLE · 表格')

const NAMES = ['部门', '2025年/金额', '2025年/占比', '2024年/金额', '2024年/占比']

t('TABLE-1', '每一行都带着全部列名', () => {
  const rows = M.renderTableRows(budgetTable(C))
  need(rows.length === 7, `应有 7 行，实际 ${rows.length}`)
  for (const r of rows) for (const n of NAMES) need(r.includes(`${n}: `), `${J(r)} 缺列名 ${n}`)
})
t('TABLE-2', '两级表头按列拼：「2025年/金额」和「2025年/占比」是两列', () => {
  const r = M.renderTableRows(budgetTable(C))[1]!
  need(r.includes('2025年/金额: 1200') && r.includes('2025年/占比: 25.9%'), `实际 ${J(r)}`)
})
t('TABLE-3', '「合计」行也带列名', () => {
  const r = M.renderTableRows(budgetTable(C))[6]!
  need(r.includes('部门: 合计') && r.includes('2025年/金额: 4630') && r.includes('2024年/占比: 100%'), `实际 ${J(r)}`)
})
t('TABLE-4', '每一行都带 caption；caption 为空时不留前导空格', () => {
  for (const r of M.renderTableRows(budgetTable(C))) need(r.startsWith('表3 各部门预算（万元）① '), `${J(r)} 没带 caption`)
  const bare: TableData = { caption: '', headerRows: [['城市', '上限']], rows: [['一线', '500'], ['其他', '']] }
  const out = M.renderTableRows(bare)
  need(J(out) === J(['城市: 一线; 上限: 500', '城市: 其他']), `实际 ${J(out)}`)
})
t('TABLE-5', '「研发部 2025年 金额」的 BM25 第一名是研发部那一行', () => {
  const cs = chunksOf('budget-2025')
  const docs = shared.chunkDocs(cs)
  const top = shared.bm25Rank(docs, docs, '研发部 2025年 金额')[0]
  const c = cs.find((x) => x.id === top?.id)
  need(c !== undefined && c.text.includes('部门: 研发部') && c.text.includes('2025年/金额: 1200'), `第一名 ${J(c?.text)}`)
})
t('TABLE-6', '表格行 chunk 数 = 数据行数；hiddenColumns 的列不出现', () => {
  const rows = chunksOf('budget-2025').filter((c) => c.kind === 'table_row')
  need(rows.length === 7, `应有 7 个表格行 chunk，实际 ${rows.length}`)
  const hr: TableData = { caption: '附表', headerRows: [['姓名', '职级', '月薪']], rows: [['张三', 'P6', '23000']] }
  const out = M.renderTableRows(hr, ['月薪'])
  need(J(out) === J(['附表 姓名: 张三; 职级: P6']), `实际 ${J(out)}`)
})

// ─────────────────────────────────────────────────────────────
section('ACL · 权限')

const ANN = annFixture()
const runAnn = (m: number, mode: 'post' | 'pre' | 'iterative') =>
  ANN.map((r) => M.searchFiltered(r, annVisible(m), { k: 10, ef: 40, maxScan: 400, mode }))
const total = (xs: { ids: string[] }[]) => xs.reduce((s, x) => s + x.ids.length, 0)

t('ACL-1', '缺 acl 的 chunk 谁都看不见（fail-closed）', () => {
  need(!shared.aclVisible({}, ['group:all']), '缺 acl 被当成公开了')
  const legacy = shared.chunkDocument(docById(C, 'legacy-notice'), GEN)
  for (const name of Object.keys(U)) need(!legacy.some((c) => shared.canSee(c, U[name]!)), `${name} 看到了 legacy-notice`)
})
t('ACL-2', '同名的组和用户是两个 principal', () => {
  need(shared.principalKey('group', 'alice@qinghe.com') !== shared.principalKey('user', 'alice@qinghe.com'), '前缀没区分类型')
})
t('ACL-3', 'principal 名字大小写不敏感；外部组必须带来源', () => {
  need(shared.principalKey('user', 'Alice@Qinghe.com') === shared.principalKey('user', 'alice@qinghe.com'), '大小写变体成了两个 key')
  need(shared.principalKey('ext_group', 'Eng', 'Confluence') === 'ext_group:confluence/eng', `实际 ${shared.principalKey('ext_group', 'Eng', 'Confluence')}`)
  need(throws(() => shared.principalKey('ext_group', 'eng')), '外部组没带来源也通过了')
})
t('ACL-4', '新人 dave 的预过滤检索里没有 HR、预算、研发部的文档', () => {
  const hits = shared.searchKb(everything(), '研发部 2025 年 预算 薪酬 住宿', U.dave!, PRE, M.searchFiltered)
  need(hits.length > 0, '一条都没搜到')
  for (const h of hits) need(['travel-2023', 'travel-2025', 'travel-2026'].includes(h.docId), `dave 看到了 ${h.docId}`)
})
t('ACL-5', '2% 选择率下 post 返回远少于 k（证明后过滤会少）', () => {
  const r = runAnn(50, 'post')
  need(total(r) === 12 && Math.min(...r.map((x) => x.ids.length)) === 0, `20 个查询共返回 ${total(r)} 条（应 12），最少 ${Math.min(...r.map((x) => x.ids.length))}`)
  need(r.every((x) => x.scanned === 40), 'post 只该看 ef 个候选')
})
t('ACL-6', '同条件 pre 每次都返回 k 条', () => {
  const r = runAnn(50, 'pre')
  need(r.every((x) => x.ids.length === 10), `实际 ${J(r.map((x) => x.ids.length))}`)
})
t('ACL-7', 'iterative 返回不少于 post，且扫描量不超过 maxScan', () => {
  const it = runAnn(50, 'iterative')
  need(total(it) === 144 && total(it) >= total(runAnn(50, 'post')), `iterative 共返回 ${total(it)} 条（应 144）`)
  need(it.every((x) => x.scanned <= 400), `扫描量超过上限：${Math.max(...it.map((x) => x.scanned))}`)
  need(runAnn(2, 'iterative').every((x) => x.scanned === 40), '50% 选择率一轮就够，不该继续扩张')
})
t('ACL-8', 'iterative 不够 k 条时宁可少给，结果全部可见', () => {
  for (const m of [2, 10, 50, 200]) {
    const vis = annVisible(m)
    for (const x of runAnn(m, 'iterative')) need(x.ids.length <= 10 && x.ids.every(vis), `选择率 1/${m} 混入了越权结果`)
  }
})
t('ACL-9', 'filter-first 发给 reranker 的全部可见；结果按 reranker 的分数排', () => {
  const vis = annVisible(10)
  const cands = ANN[0]!.slice(0, 40)
  const reverse = (ids: string[]) => ids.map((id) => -cands.find((h) => h.id === id)!.score)
  const r = M.rerankPipeline(cands, vis, 'filter-first', reverse, 3)
  need(r.exposed.length > 0 && r.exposed.every(vis), `发出了越权候选：${J(r.exposed.filter((id) => !vis(id)))}`)
  const want = cands.filter((h) => vis(h.id)).map((h) => h.id).reverse().slice(0, 3)
  need(J(r.ids) === J(want), `应按 reranker 分数取前 3：${J(want)}，实际 ${J(r.ids)}`)
})
t('ACL-10', 'rerank-first 与 filter-first 结果相同，外发的不同', () => {
  const vis = annVisible(50)
  for (const r of ANN.slice(0, 5)) {
    const cands = r.slice(0, 40)
    const score = (ids: string[]) => ids.map((id) => cands.find((h) => h.id === id)!.score)
    const a = M.rerankPipeline(cands, vis, 'filter-first', score, 10)
    const b = M.rerankPipeline(cands, vis, 'rerank-first', score, 10)
    need(J(a.ids) === J(b.ids), `结果不同：${J(a.ids)} vs ${J(b.ids)}`)
    need(b.exposed.length === 40 && b.exposed.filter((id) => !vis(id)).length > 0 && a.exposed.every(vis), '外发集合没有区别')
  }
})
t('ACL-11', '工具参数里出现权限相关字段一律拒绝', () => {
  for (const args of [{ query: '报销', filter: {} }, { query: '报销', user_groups: ['group:hr'] }, { query: '报销', doc_ids: ['hr-salary'] }, { query: '报销', tenant: 'globex' }]) {
    need(throws(() => shared.buildSearchRequest(args, U.dave!)), `${J(args)} 没被拒绝`)
  }
  need(!throws(() => shared.buildSearchRequest({ query: '报销', k: 3 }, U.dave!)), '正常参数被拒绝了')
})
t('ACL-12', 'ACL 在 knn.filter 里，来自会话', () => {
  const req = shared.buildSearchRequest({ query: '报销' }, U.bob!)
  need(J(Object.keys(req)) === J(['query', 'k', 'knn']), `外层多了字段：${J(Object.keys(req))}`)
  need(req.knn.filter.tenant === 'acme' && J(req.knn.filter.aclAny) === J(U.bob!.principals), `实际 ${J(req.knn.filter)}`)
})
t('ACL-13', '多人会话按交集：alice 单独看得见、和 dave 一起就看不见', () => {
  const c = chunksOf('hr-salary')[0]!
  need(shared.visibleToAll(c, [U.alice!]), 'alice 单独应可见')
  need(!shared.visibleToAll(c, [U.alice!, U.dave!]), '有 dave 在场仍然可见')
  need(!shared.visibleToAll(c, []), '没有人在场不该可见')
})
t('ACL-14', '字段级权限在索引时做：bob 看不到月薪，也搜不到它', () => {
  const cs = everything()
  const bobRows = cs.filter((c) => c.docId === 'hr-salary' && c.kind === 'table_row' && shared.canSee(c, U.bob!))
  need(bobRows.length === 2 && bobRows.every((c) => !c.text.includes('23000') && !c.text.includes('月薪')), `bob 看到的行：${J(bobRows.map((c) => c.text))}`)
  need(shared.searchKb(cs, '23000', U.bob!, PRE, M.searchFiltered).length === 0, '用月薪的值当查询，bob 命中了')
  const a = shared.searchKb(cs, '23000', U.alice!, PRE, M.searchFiltered)
  need(a.length === 1 && a[0]!.text.includes('月薪: 23000'), `alice 应命中完整行，实际 ${J(a.map((c) => c.text))}`)
})

// ─────────────────────────────────────────────────────────────
section('TENANT · 多租户（参考实现，只读）')

t('TENANT-1', '每租户统计下，globex 的结果里没有 acme 的文档', () => {
  const r = shared.tenantSearch(tenantDocs(10), 'per-tenant', '报销 发票', 'globex', 20)
  need(r.length > 0 && r.every((h) => h.id.startsWith('B')), `实际 ${J(r.map((h) => h.id))}`)
})
t('TENANT-2', '共享统计下 globex 多 10 篇，acme 的第一名就变了', () => {
  const top = (n: number, scope: shared.StatScope) => shared.tenantSearch(tenantDocs(n), scope, '报销 发票', 'acme', 10)[0]!.id
  need(top(0, 'shared') === 'A1' && top(10, 'shared') === 'A2', `共享：${top(0, 'shared')} → ${top(10, 'shared')}`)
  need(top(10, 'per-tenant') === 'A1' && top(50, 'per-tenant') === 'A1', '每租户统计不该变')
})
t('TENANT-3', '每租户统计与单独建索引逐位相等', () => {
  const own = tenantDocs(0)
  const alone = shared.bm25Rank(own, own, '报销 发票').map((h) => `${h.id}:${fmtFixed(h.score, 6)}`)
  const per = shared.tenantSearch(tenantDocs(50), 'per-tenant', '报销 发票', 'acme', 10).map((h) => `${h.id}:${fmtFixed(h.score, 6)}`)
  need(J(alone) === J(per), `${J(alone)} vs ${J(per)}`)
})

// ─────────────────────────────────────────────────────────────
section('VER · 版本消解')

const SC = versionScenarios()
const sc = (i: number) => SC[i]!.cands

t('VER-1', 'S1 新版已生效 → 办法2025', () => {
  const v = M.resolveVersions(sc(0), AS_OF)
  need(v.chosen === '办法2025' && !v.conflict, `实际 ${J(v)}`)
})
t('VER-2', 'S2 新版未生效：今天用 2025，2027-01-01 起用 2026', () => {
  const a = M.resolveVersions(sc(1), AS_OF)
  const b = M.resolveVersions(sc(1), '2027-01-01')
  need(a.chosen === '办法2025' && b.chosen === '办法2026', `今天 ${a.chosen}，2027-01-01 ${b.chosen}`)
})
t('VER-3', 'S3 旧版被重新编辑（mtime 最新）→ 仍是办法2025', () => {
  const v = M.resolveVersions(sc(2), AS_OF)
  need(v.chosen === '办法2025', `实际 ${J(v)}`)
})
t('VER-4', 'S4 上位优先，并标注下位冲突', () => {
  const v = M.resolveVersions(sc(3), AS_OF)
  need(v.chosen === '集团制度' && v.conflict, `实际 ${J(v)}`)
})
t('VER-5', 'S5 新的一般 vs 旧的特别 → 交人裁决；真实语料里 bob 和 alice 结论不同', () => {
  const v = M.resolveVersions(sc(4), AS_OF)
  need(v.chosen === null && v.conflict, `实际 ${J(v)}`)
  const travel = (s: Session) => {
    const m = new Map<string, shared.VersionCand>()
    for (const c of everything()) if (c.version.family === 'travel' && shared.canSee(c, s)) m.set(c.docId, { docId: c.docId, version: c.version })
    return M.resolveVersions([...m.values()], AS_OF)
  }
  const bob = travel(U.bob!)
  const alice = travel(U.alice!)
  need(bob.chosen === null && bob.conflict && alice.chosen === 'travel-2025', `bob ${J(bob)}，alice ${J(alice)}`)
})
t('VER-6', 'S6 已废止的不选', () => {
  const v = M.resolveVersions(sc(5), AS_OF)
  need(v.chosen === '暂行规定', `实际 ${J(v)}`)
})
t('VER-7', '缺 effectiveFrom 的不参与自动消解', () => {
  const legacy = { docId: 'legacy-notice', version: docById(C, 'legacy-notice').version }
  const v = M.resolveVersions([legacy, sc(0)[1]!], AS_OF)
  need(v.chosen === '办法2025' && v.reason.includes('effectiveFrom'), `实际 ${J(v)}`)
  const only = M.resolveVersions([legacy], AS_OF)
  need(only.chosen === null && !only.conflict, `只有缺生效日的版本时应为 null，实际 ${J(only)}`)
})
t('VER-8', '检索结果混了两代 embedding 就报错', () => {
  const g1 = { gen: GEN }
  const g2 = { gen: { ...GEN, embedder: 'bge-m3-v2' } }
  need(throws(() => shared.assertSingleEmbedder([g1, g2, g1])), '混代没报错')
  need(!throws(() => shared.assertSingleEmbedder([g1, g1])), '同一代也报错了')
})

// ─────────────────────────────────────────────────────────────
section('SYNC · 同步与重建')

const snaps = (mode: shared.SyncMode) => runSync(mode, M.applySync)

t('SYNC-1', 'none：三轮之后已删的 C 还在', () => {
  const s = snaps('none')
  need(s[2]!.split(',').includes('C:c1'), `实际 ${s[2]}`)
})
t('SYNC-2', 'incremental：A 的旧版清掉了，整篇删除的 C 仍残留', () => {
  const s = snaps('incremental')
  need(s[1] === 'A:a2,B:b1,C:c1' && s[2] === 'A:a2,B:b1,C:c1', `实际 ${J(s)}`)
})
t('SYNC-3', 'full：loader 第 3 轮漏了 B，B 被误删', () => {
  const s = snaps('full')
  need(s[1] === 'A:a2,B:b1' && s[2] === 'A:a2', `实际 ${J(s)}`)
})
t('SYNC-4', 'tombstone：没有 C、保住 B、A 只有新版', () => {
  const s = snaps('tombstone')
  need(s[1] === 'A:a2,B:b1' && s[2] === 'A:a2,B:b1', `实际 ${J(s)}`)
})
t('SYNC-5', '只改了 ACL → 只更新 payload，不重新 embedding', () => {
  const old = docById(C, 'travel-2025')
  const nu: ParsedDoc = { ...old, acl: ['group:all', 'group:contractors'] }
  const p = shared.planReindex(old, nu, GEN, GEN)
  need(p.payloadOnly && !p.reembed && !p.reparse && !p.rechunk, `实际 ${J(p)}`)
})
t('SYNC-6', '换 parser 要重解析；换 embedder 只重新 embedding；文档删了就整篇删', () => {
  const d = docById(C, 'travel-2025')
  const parser = shared.planReindex(d, d, GEN, { ...GEN, parser: 'mineru-2.5' })
  need(parser.reparse && parser.rechunk && parser.reembed, `换 parser：${J(parser)}`)
  const emb = shared.planReindex(d, d, GEN, { ...GEN, embedder: 'bge-m3-v2' })
  need(emb.reembed && !emb.reparse && !emb.rechunk && !emb.payloadOnly, `换 embedder：${J(emb)}`)
  const chunker = shared.planReindex(d, d, GEN, { ...GEN, chunker: 'kb-v2' })
  need(chunker.rechunk && chunker.reembed && !chunker.reparse, `换 chunker：${J(chunker)}`)
  need(shared.planReindex(d, null, GEN, GEN).deleteAll, '文档删了没有 deleteAll')
  const same = shared.planReindex(d, d, GEN, GEN)
  need(!same.reparse && !same.rechunk && !same.reembed && !same.payloadOnly && !same.deleteAll, `什么都没变：${J(same)}`)
})

// ─────────────────────────────────────────────────────────────
section('CACHE · 缓存键')

t('CACHE-1', '同一个问题，alice 和 bob 的键不同', () => {
  need(M.cacheKey('差旅住宿上限', U.alice!.principals, 'v7') !== M.cacheKey('差旅住宿上限', U.bob!.principals, 'v7'), '跨用户同键')
})
t('CACHE-2', '同样的权限、同样的问题（写法不同）→ 同一个键', () => {
  const a = M.cacheKey('（2025）住宿 上限', ['group:hr', 'user:a'], 'v7')
  const b = M.cacheKey(' (2025)住宿 上限 ', ['user:a', 'group:hr', 'group:hr'], 'v7')
  need(a === b, `${J(a)} vs ${J(b)}`)
})
t('CACHE-3', '撤权或语料版本变了，键就变', () => {
  const before = M.cacheKey('薪酬', ['user:alice@qinghe.com', 'group:hr'], 'v7')
  need(before !== M.cacheKey('薪酬', ['user:alice@qinghe.com'], 'v7'), '撤掉 group:hr 后键没变')
  need(before !== M.cacheKey('薪酬', ['user:alice@qinghe.com', 'group:hr'], 'v8'), '语料版本变了键没变')
})

// ─────────────────────────────────────────────────────────────
section('GATE · CITE · 入库门禁与引用定位')

t('GATE-1', 'legacy-notice：缺 acl、缺 effectiveFrom', () => {
  const g = shared.qualityGate(docById(C, 'legacy-notice'))
  need(!g.pass && J(g.issues) === J(['NO_ACL', 'NO_EFFECTIVE_FROM']), `实际 ${J(g)}`)
})
t('GATE-2', '每份坏文档恰好被一项抓住，好文档一项不中', () => {
  const want: Record<string, string[]> = {
    'travel-2025': [],
    'bad-empty-page': ['EMPTY_PAGE'],
    'bad-footnote': ['FOOTNOTE_MISSING'],
    'bad-table': ['TABLE_NO_HEADER'],
    'bad-encoding': ['REPLACEMENT_CHAR'],
  }
  for (const { name, doc } of badDocs(C)) {
    if (!(name in want)) continue
    const got = shared.qualityGate(doc).issues
    need(J(got) === J(want[name]), `${name}：应为 ${J(want[name])}，实际 ${J(got)}`)
  }
  need(shared.qualityGate(docById(C, 'budget-2025')).pass, '跨页表格的后半段没有表头，不该算错')
})
t('CITE-1', '单页：有印刷页码显示「p. ii」，没有显示「第 1 页」', () => {
  const tr = chunksOf('travel-2023').find((c) => c.text.includes('第一条'))!
  const bu = chunksOf('budget-2025')[0]!
  need(shared.citeLocator(tr) === 'p. ii' && shared.citeLocator(bu) === '第 1 页', `${shared.citeLocator(tr)} / ${shared.citeLocator(bu)}`)
})
t('CITE-2', '跨页：「pp. 2–3」与「第 3–4 页」', () => {
  const tr = chunksOf('travel-2023').find((c) => c.text.includes('不予受理'))!
  const bu = chunksOf('budget-2025').find((c) => c.text.includes('方可列支'))!
  need(shared.citeLocator(tr) === 'pp. 2–3' && shared.citeLocator(bu) === '第 3–4 页', `${shared.citeLocator(tr)} / ${shared.citeLocator(bu)}`)
})

console.log()
if (failed === 0) {
  console.log(green(`  ✓ ${passed} 条断言全部通过`))
  console.log(
    dim(
      '\n  最该记住的六条：\n' +
        '    PARSE  页眉靠跨页统计；页码存两套；脚注和跨页内容不能丢\n' +
        '    NUM    先 NFKC 再用显式字符类；\\d 在两种语言里不是一回事\n' +
        '    TABLE  每一行都带完整列名；多级表头按列拼\n' +
        '    ACL    缺 acl 不可见；过滤在 ANN 里、在 rerank 前；权限只来自会话\n' +
        '    VER    上位、特别、新，三个维度；有一种冲突要交给人\n' +
        '    SYNC   删除靠墓碑；什么变了就只重做哪一段\n',
    ),
  )
  process.exit(0)
}
console.log(red(`  ✗ ${failed} 失败 / ${passed} 通过`))
process.exit(1)
