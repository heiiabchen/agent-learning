/**
 * L09x 的脚手架。跑法：pnpm kb
 *
 * 观察实验：解析结果里的页眉、页码和脚注；表格的四种切法；全角数字；ACL 放在 ANN 之后召回塌缩、
 * rerank 在过滤之前外发越权全文；别的租户改了你的排序；三种版本消解策略；四种同步模式；入库门禁矩阵。
 * 零网络、零模型、零向量库。语料是 fixtures/corpus.json（两种语言读同一份文件）。
 * 写完七个 TODO 跑 pnpm verify:l09x。
 */

import { readFileSync } from 'node:fs'
import { tokenize } from '../shared/retrieval.ts'
import { cmpCodePoint } from '../shared/codingEval.ts'
import {
  GATE_CHECKS,
  bm25Rank,
  chunkDocument,
  citeLocator,
  cpLen,
  headingLevel,
  kbTokenize,
  normalizeText,
  pickByEffective,
  pickByMtime,
  qualityGate,
  renderTableRows,
  resolveVersions,
  rerankPipeline,
  searchFiltered,
  stripRunning,
  syncKey,
  tenantSearch,
  trimSpaces,
  applySync,
  canSee,
  type AnnHit,
  type FilterOpts,
  type FilteredSearch,
  type Gen,
  type HeadingInfo,
  type KbChunk,
  type ParsedDoc,
  type RerankOrder,
  type RerankResult,
  type Session,
  type SyncChunk,
  type SyncMode,
  type TableData,
  type TDoc,
  type VersionCand,
  type VersionMeta,
  type VersionVerdict,
} from '../shared/kb.ts'
import { isMain } from '../shared/entry.ts'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const w = (s: string) =>
  [...visible(s)].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string | number, n: number) => String(s) + ' '.repeat(Math.max(0, n - w(String(s))))
const lpad = (s: string | number, n: number) => ' '.repeat(Math.max(0, n - w(String(s)))) + String(s)

// ─────────────────────────────────────────────────────────────
// 夹具（verify 也用）
// ─────────────────────────────────────────────────────────────

export interface Corpus {
  users: Record<string, Session>
  docs: ParsedDoc[]
}

export function loadCorpus(): Corpus {
  return JSON.parse(readFileSync(new URL('./fixtures/corpus.json', import.meta.url), 'utf8')) as Corpus
}

export const GEN: Gen = { parser: 'mineru-2.1', chunker: 'kb-v1', embedder: 'bge-m3' }

export function docById(c: Corpus, id: string): ParsedDoc {
  const d = c.docs.find((x) => x.docId === id)
  if (!d) throw new Error(`没有这份文档：${id}`)
  return d
}

export function allChunks(c: Corpus, opts: Parameters<typeof chunkDocument>[2] = {}): KbChunk[] {
  const out: KbChunk[] = []
  for (const d of c.docs) out.push(...chunkDocument(d, GEN, opts))
  return out
}

/** 预算表：两页拼起来之后的完整表格（跨页的后半段没有表头，要继承前半段的）。 */
export function budgetTable(c: Corpus): TableData {
  const doc = docById(c, 'budget-2025')
  let t: TableData | null = null
  for (const p of doc.pages) {
    for (const b of p.blocks) {
      if (b.kind !== 'table' || !b.table) continue
      if (!t) t = { caption: b.table.caption, headerRows: b.table.headerRows.map((r) => r.slice()), rows: b.table.rows.map((r) => r.slice()) }
      else for (const r of b.table.rows) t.rows.push(r.slice())
    }
  }
  return t!
}

// 确定性随机：Park–Miller minstd（乘积 < 2^53，JS double 精确）
function rng(seed: number): () => number {
  let x = seed % 2147483647
  if (x <= 0) x += 2147483646
  return () => {
    x = (x * 48271) % 2147483647
    return x / 2147483647
  }
}

export const ANN_N = 4000
export const ANN_DIM = 8
export const ANN_QUERIES = 20

/**
 * 实验四的合成向量库：4000 个 8 维向量、20 个查询。返回每个查询的完整排序（点积降序，同分按 id）。
 * 可见性用 annVisible(m)：下标是 m 的倍数才可见，选择率 1/m。
 */
export function annFixture(): AnnHit[][] {
  const r = rng(42)
  const vecs: number[][] = []
  for (let i = 0; i < ANN_N; i++) {
    const v: number[] = []
    for (let j = 0; j < ANN_DIM; j++) v.push(r() - 0.5)
    vecs.push(v)
  }
  const out: AnnHit[][] = []
  for (let q = 0; q < ANN_QUERIES; q++) {
    const qv: number[] = []
    for (let j = 0; j < ANN_DIM; j++) qv.push(r() - 0.5)
    const ranked = vecs.map((v, i) => {
      let s = 0
      for (let j = 0; j < ANN_DIM; j++) s += qv[j]! * v[j]!
      return { id: `v${String(i).padStart(4, '0')}`, score: s }
    })
    ranked.sort((a, b) => b.score - a.score || cmpCodePoint(a.id, b.id))
    out.push(ranked)
  }
  return out
}

export function annVisible(m: number): (id: string) => boolean {
  return (id) => Number(id.slice(1)) % m === 0
}

/** 实验五：acme 的 4 篇 + globex 的 n 篇「报销」短文。 */
export function tenantDocs(nGlobex: number): TDoc[] {
  const out: TDoc[] = [
    { id: 'A1', tenant: 'acme', text: '报销流程：先在系统提交报销单并附发票，主管审批后财务付款。报销周期一般五个工作日。' },
    { id: 'A2', tenant: 'acme', text: '发票要求：增值税专用发票须抬头正确。' },
    { id: 'A3', tenant: 'acme', text: '年假规定：入职满一年享受五天年假。' },
    { id: 'A4', tenant: 'acme', text: '会议室预订：提前一天在系统中预订。' },
  ]
  for (let i = 0; i < nGlobex; i++) out.push({ id: `B${String(i + 1).padStart(2, '0')}`, tenant: 'globex', text: `报销 报销单 第${i}号 已审批。` })
  return out
}

function ver(family: string, level: number, special: boolean, issued: string, effectiveFrom: string | undefined, mtime: string, repealedAt?: string): VersionMeta {
  const v: VersionMeta = { family, level, special, issued, mtime }
  if (effectiveFrom !== undefined) v.effectiveFrom = effectiveFrom
  if (repealedAt !== undefined) v.repealedAt = repealedAt
  return v
}

export const AS_OF = '2026-10-12'

/** 实验六的六个场景。 */
export function versionScenarios(): { name: string; cands: VersionCand[] }[] {
  const t = 'travel'
  return [
    { name: 'S1 新版已生效', cands: [
      { docId: '办法2023', version: ver(t, 2, false, '2023-01-01', '2023-01-01', '2023-01-01') },
      { docId: '办法2025', version: ver(t, 2, false, '2025-06-01', '2025-07-01', '2025-06-01') },
    ] },
    { name: 'S2 新版未生效', cands: [
      { docId: '办法2025', version: ver(t, 2, false, '2025-06-01', '2025-07-01', '2025-06-01') },
      { docId: '办法2026', version: ver(t, 2, false, '2026-09-20', '2027-01-01', '2026-09-20') },
    ] },
    { name: 'S3 旧版被重新编辑', cands: [
      { docId: '办法2023', version: ver(t, 2, false, '2023-01-01', '2023-01-01', '2026-10-01') },
      { docId: '办法2025', version: ver(t, 2, false, '2025-06-01', '2025-07-01', '2025-06-01') },
    ] },
    { name: 'S4 上位 vs 下位', cands: [
      { docId: '集团制度', version: ver(t, 1, false, '2024-01-01', '2024-01-01', '2024-01-01') },
      { docId: '子公司细则', version: ver(t, 3, false, '2025-03-01', '2025-03-01', '2025-03-01') },
    ] },
    { name: 'S5 同级特别 vs 一般', cands: [
      { docId: '研发差旅补充', version: ver(t, 2, true, '2024-05-01', '2024-05-01', '2024-05-01') },
      { docId: '公司差旅办法', version: ver(t, 2, false, '2025-07-01', '2025-07-01', '2025-07-01') },
    ] },
    { name: 'S6 已废止', cands: [
      { docId: '办法2025', version: ver(t, 2, false, '2025-06-01', '2025-07-01', '2025-06-01', '2026-08-01') },
      { docId: '暂行规定', version: ver(t, 2, false, '2024-01-01', '2024-01-01', '2024-01-01') },
    ] },
  ]
}

/** 实验七：第 1 轮 A、B、C 全量；第 2 轮 A 被编辑、C 在源系统删除；第 3 轮 loader 只拿回 A（B 的读取权限过期了）。 */
export function syncRounds(): { batch: SyncChunk[]; tombstones: string[] }[] {
  return [
    { batch: [{ id: 'A#1', src: 'A', hash: 'a1' }, { id: 'B#1', src: 'B', hash: 'b1' }, { id: 'C#1', src: 'C', hash: 'c1' }], tombstones: [] },
    { batch: [{ id: 'A#1', src: 'A', hash: 'a2' }, { id: 'B#1', src: 'B', hash: 'b1' }], tombstones: ['C'] },
    { batch: [{ id: 'A#1', src: 'A', hash: 'a2' }], tombstones: [] },
  ]
}

export function runSync(mode: SyncMode, apply = applySync): string[] {
  let idx: SyncChunk[] = []
  const snaps: string[] = []
  for (const r of syncRounds()) {
    idx = apply(idx, r.batch, r.tombstones, mode)
    snaps.push(idx.map(syncKey).join(','))
  }
  return snaps
}

function cloneDoc(d: ParsedDoc): ParsedDoc {
  return JSON.parse(JSON.stringify(d)) as ParsedDoc
}

/** 实验八：在 travel-2025 上各弄坏一处。 */
export function badDocs(c: Corpus): { name: string; doc: ParsedDoc }[] {
  const good = docById(c, 'travel-2025')
  const empty = cloneDoc(good)
  empty.docId = 'bad-empty-page'
  empty.pages.push({ index0: 2, blocks: [] })
  const foot = cloneDoc(good)
  foot.docId = 'bad-footnote'
  foot.pages[0]!.blocks.push({ id: 'p0b4', kind: 'text', text: '第十四条 住宿费标准已含早餐①。', y: 560 })
  const table = cloneDoc(good)
  table.docId = 'bad-table'
  table.pages[1]!.blocks.push({ id: 'p1b1', kind: 'table', text: '', y: 400, table: { caption: '', headerRows: [], rows: [['一线城市', '500'], ['其他城市', '380']] } })
  const fffd = cloneDoc(good)
  fffd.docId = 'bad-encoding'
  fffd.pages[1]!.blocks.push({ id: 'p1b1', kind: 'text', text: '第二十二条 住宿发票须与行程一\uFFFD。', y: 400 })
  return [
    { name: 'travel-2025', doc: good },
    { name: 'legacy-notice', doc: docById(c, 'legacy-notice') },
    { name: 'bad-empty-page', doc: empty },
    { name: 'bad-footnote', doc: foot },
    { name: 'bad-table', doc: table },
    { name: 'bad-encoding', doc: fffd },
  ]
}

// ─────────────────────────────────────────────────────────────
// 观察实验
// ─────────────────────────────────────────────────────────────

function short(s: string, n: number): string {
  const one = s.split('\n').join(' | ')
  const cs = Array.from(one)
  return cs.length > n ? cs.slice(0, n).join('') + '…' : one
}

/** 千分比，整数运算：两种语言的 toFixed / round 规则不同。 */
function permille(num: number, den: number): string {
  const p = Math.floor((num * 1000) / den)
  return `${Math.floor(p / 10)}.${p % 10}%`
}

/** 一位小数（截断），整数时不带 .0。 */
function tenths(num: number, den: number): string {
  const t = Math.floor((num * 10) / den)
  return t % 10 === 0 ? String(t / 10) : `${Math.floor(t / 10)}.${t % 10}`
}

function exp1(c: Corpus): void {
  console.log(bold('\n实验一：解析结果里的坑'))
  for (const id of ['travel-2023', 'budget-2025']) {
    const doc = docById(c, id)
    const { removed } = stripRunning(doc)
    const running = removed.filter((r) => r.why === 'running')
    const nums = removed.filter((r) => r.why === 'page_number')
    console.log(`  ${bold(id)}  ${doc.pages.length} 页，印刷页码 ${doc.pages.map((p) => p.label ?? '—').join(' ')}`)
    if (running.length) console.log(dim(`    删掉页眉页脚 ×${running.length}：${running[0]!.text}`))
    if (nums.length) console.log(dim(`    删掉页码行 ×${nums.length}：${nums.map((r) => r.text).join(' · ')}`))
    console.log(dim(`    ${pad('chunk', 16)}${pad('定位', 12)}${pad('正文', 52)}标题路径`))
    for (const ch of chunkDocument(doc, GEN)) {
      console.log(`    ${pad(ch.id, 16)}${pad(citeLocator(ch), 12)}${pad(short(ch.text, 24), 52)}${ch.headingPath.join(' › ') || '—'}`)
    }
  }
  console.log(dim('  页眉是跨页统计出来的；跨页段落的定位是一个范围；脚注附在引用它的每一行上。'))
  console.log(dim('  travel-2023 的物理第 3 页印着「1」：「第 3 页」和「p. 1」是同一页，存的时候要分开存。'))
}

function colOf1200(text: string): string {
  for (const part of text.split('; ')) {
    if (!part.endsWith(': 1200')) continue
    const name = part.slice(0, part.length - ': 1200'.length)
    const sp = name.lastIndexOf(' ')
    return sp >= 0 ? name.slice(sp + 1) : name
  }
  return '—'
}

function exp2(c: Corpus): void {
  console.log(bold('\n实验二：表格怎么切（查询「研发部 2025年 金额」）'))
  const t = budgetTable(c)
  const headerFlat = t.headerRows.map((r) => r.filter((x) => x !== '').join(' ')).join(' ')
  const flat = `${t.caption} ${headerFlat} ${t.rows.map((r) => r.join(' ')).join(' ')}`
  const cps = Array.from(flat)
  const fixed: TDoc[] = []
  for (let i = 0, n = 0; i < cps.length; i += 40, n++) fixed.push({ id: `fixed#${n}`, tenant: 'acme', text: cps.slice(i, i + 40).join('') })
  const first = t.headerRows[0]!.map((x, j, r) => (x !== '' ? x : j > 0 ? r.slice(0, j).filter((y) => y !== '').pop() ?? '' : ''))
  const rows0: TDoc[] = t.rows.map((r, i) => ({
    id: `rows0#${i}`,
    tenant: 'acme',
    text: `${t.caption} ${r.map((v, j) => `${first[j]}: ${v}`).join('; ')}`,
  }))
  const bare: TDoc[] = t.rows.map((r, i) => ({ id: `bare#${i}`, tenant: 'acme', text: r.join(' ') }))
  const ours: TDoc[] = renderTableRows(t).map((text, i) => ({ id: `row#${i}`, tenant: 'acme', text }))
  const q = '研发部 2025年 金额'
  console.log(dim(`  ${pad('切法', 26)}${lpad('chunk数', 7)}  ${pad('top1', 10)}${pad('含研发部', 10)}1200 的列名`))
  const rows: [string, TDoc[]][] = [
    ['定长 40 字、表头只出现一次', fixed],
    ['按行、只取第一级表头', rows0],
    ['按行、不带列名', bare],
    ['按行、多级表头按列拼', ours],
  ]
  for (const [name, docs] of rows) {
    const res = bm25Rank(docs, docs, q)
    const top = res.length ? docs.find((d) => d.id === res[0]!.id)! : undefined
    const text = top ? top.text : ''
    console.log(`  ${pad(name, 26)}${lpad(docs.length, 7)}  ${pad(top ? top.id : '—', 10)}${pad(text.includes('研发部') ? '是' : '否', 10)}${colOf1200(text)}`)
  }
  console.log(dim('  只取第一级表头时，「金额」和「占比」两列都叫「2025年」：模型拿到 1200 和 25.9%，分不清哪个是钱。'))
}

function exp3(): void {
  console.log(bold('\n实验三：公文里的全角数字（L09 的 tokenize vs 先 NFKC 再切）'))
  for (const s of ['第３条', '（２）', '２０２５年']) {
    console.log(`  ${pad(s, 14)}L09 [${tokenize(s).join(',')}]  NFKC 后 [${kbTokenize(s).join(',')}]`)
  }
  const docs: TDoc[] = [
    { id: '第３条', tenant: 'acme', text: '第３条 差旅住宿标准按城市等级执行。' },
    { id: '第５条', tenant: 'acme', text: '第５条 差旅交通标准按职级执行。' },
    { id: '第十三条', tenant: 'acme', text: '第十三条 差旅报销应在返回后三十日内提交。' },
    { id: '（２）', tenant: 'acme', text: '（２）住宿发票须与行程一致。' },
  ]
  console.log(dim(`  ${pad('查询', 14)}${pad('切词', 8)}排序（id:score×1000 取整）`))
  for (const q of ['第3条 差旅', '（2） 发票']) {
    for (const [name, tok] of [['L09', tokenize], ['NFKC', kbTokenize]] as [string, (s: string) => string[]][]) {
      const res = bm25Rank(docs, docs, q, tok)
      console.log(`  ${pad(q, 14)}${pad(name, 8)}${res.map((r) => `${r.id}:${Math.floor(r.score * 1000)}`).join('  ')}`)
    }
  }
  console.log(dim(`  ${pad('标题识别', 22)}级别  编号`))
  for (const s of ['第十二条 适用范围', '（一）总则', '(一)总则', '１、总则', '1.1.2 小节', '\uFEFF第一章 总则', '2025年预算增长10%。', '1.5元以内']) {
    const h = headingLevel(s)
    console.log(`  ${pad(s.split('\uFEFF').join('\\uFEFF'), 22)}${pad(h ? h.level : '—', 6)}${h ? h.label : '不是标题'}`)
  }
  console.log(dim('  L09 的字符类不含全角数字：「第３条」只剩「第、条」，查「第3条」时更短的第５条排到了前面。'))
  console.log(dim('  标题识别先去 BOM 再 NFKC：JS 的 trim() 会吃掉 BOM、Python 的 strip() 不会，只靠 trim 两边结论不同。'))
}

function exp4(): void {
  console.log(bold(`\n实验四：ACL 放在 ANN 之后（N=${ANN_N}、dim=${ANN_DIM}、ef=40、k=10、maxScan=400、${ANN_QUERIES} 个查询）`))
  const ranked = annFixture()
  const K = 10
  const base: Omit<FilterOpts, 'mode'> = { k: K, ef: 40, maxScan: 400 }
  console.log(dim(`  ${pad('选择率', 8)}${pad('策略', 16)}${lpad('平均返回', 10)}${lpad('最少', 6)}${lpad('recall@10', 11)}${lpad('越权外发', 10)}`))
  for (const [label, m] of [['50%', 2], ['10%', 10], ['2%', 50], ['0.5%', 200]] as [string, number][]) {
    const vis = annVisible(m)
    const stats = new Map<string, { ret: number; min: number; hit: number; leak: number }>()
    const names = ['post', 'pre', 'iterative', 'rerank-first']
    for (const n of names) stats.set(n, { ret: 0, min: 1e9, hit: 0, leak: 0 })
    for (const r of ranked) {
      const truth = new Set(searchFiltered(r, vis, { ...base, mode: 'pre' }).ids)
      const run = (name: string, ids: string[], leak: number) => {
        const s = stats.get(name)!
        s.ret += ids.length
        s.min = Math.min(s.min, ids.length)
        s.hit += ids.filter((id) => truth.has(id)).length
        s.leak += leak
      }
      for (const mode of ['post', 'pre', 'iterative'] as const) run(mode, searchFiltered(r, vis, { ...base, mode }).ids, 0)
      const cands = r.slice(0, 40)
      const rr = rerankPipeline(cands, vis, 'rerank-first', (ids) => ids.map((id) => cands.find((h) => h.id === id)!.score), K)
      run('rerank-first', rr.ids, rr.exposed.filter((id) => !vis(id)).length)
    }
    for (const n of names) {
      const s = stats.get(n)!
      console.log(`  ${pad(label, 8)}${pad(n, 16)}${lpad(tenths(s.ret, ranked.length), 10)}${lpad(s.min, 6)}${lpad(permille(s.hit, K * ranked.length), 11)}${lpad(s.leak, 10)}`)
    }
  }
  console.log(dim('  post 不越权、不报错，2% 时平均只返回 0.6 条；rerank-first 的结果和 post 一模一样，却把几百段越权全文发了出去。'))
  console.log(dim('  iterative 受 maxScan 限制，0.5% 时也只拿回 1.5 条：上限是必须的，但它决定了低选择率用户的召回。'))
}

function exp5(): void {
  console.log(bold('\n实验五：tenant 过滤之后，统计量仍是共享的（acme 搜「报销 发票」）'))
  console.log(dim(`  ${pad('globex 文档数', 15)}${pad('统计口径', 12)}acme 的排序（id:score×1000 取整）`))
  for (const n of [0, 10, 50]) {
    const all = tenantDocs(n)
    for (const scope of ['shared', 'per-tenant'] as const) {
      const res = tenantSearch(all, scope, '报销 发票', 'acme', 10)
      console.log(`  ${pad(n, 15)}${pad(scope, 12)}${res.map((r) => `${r.id}:${Math.floor(r.score * 1000)}`).join('  ')}`)
    }
  }
  console.log(dim('  globex 多写 10 篇报销单，acme 的第一名就从 A1 换成了 A2——结果里一篇 globex 的文档都没有。'))
}

function exp6(c: Corpus): void {
  console.log(bold(`\n实验六：版本消解（asOf=${AS_OF}）`))
  console.log(dim(`  ${pad('场景', 22)}${pad('按 mtime', 14)}${pad('按生效日', 14)}三维规则`))
  for (const sc of versionScenarios()) {
    const v = resolveVersions(sc.cands, AS_OF)
    const three = v.chosen ?? 'CONFLICT'
    console.log(`  ${pad(sc.name, 22)}${pad(pickByMtime(sc.cands) ?? '—', 14)}${pad(pickByEffective(sc.cands, AS_OF) ?? '—', 14)}${three}${v.conflict ? dim(`（${v.reason}）`) : ''}`)
  }
  const chunks = allChunks(c)
  for (const name of ['alice', 'bob']) {
    const s = c.users[name]!
    const docs = new Map<string, VersionCand>()
    for (const ch of chunks) if (ch.version.family === 'travel' && canSee(ch, s)) docs.set(ch.docId, { docId: ch.docId, version: ch.version })
    const v = resolveVersions([...docs.values()], AS_OF)
    console.log(`  ${pad(`真实语料 · ${name}`, 22)}${[...docs.keys()].sort(cmpCodePoint).join(' ')}  → ${v.chosen ?? 'CONFLICT'}`)
  }
  console.log(dim('  按 mtime 在 S2、S3 选错，按生效日在 S4、S5 选错；同一个问题，研发部的 bob 和 HR 的 alice 该拿到不同的答复。'))
}

function exp7(): void {
  console.log(bold('\n实验七：删除不会自己传播'))
  console.log(dim(`  ${pad('模式', 13)}${pad('第 2 轮后', 22)}${pad('第 3 轮后', 22)}问题`))
  for (const mode of ['none', 'incremental', 'full', 'tombstone'] as const) {
    const snaps = runSync(mode)
    const last = snaps[2]!.split(',')
    const issues: string[] = []
    if (snaps[1]!.split(',').includes('A:a1')) issues.push('A 旧版残留')
    if (last.includes('C:c1')) issues.push('已删的 C 残留')
    if (!last.includes('B:b1')) issues.push('B 被误删')
    console.log(`  ${pad(mode, 13)}${pad(snaps[1]!, 22)}${pad(snaps[2]!, 22)}${issues.join('、') || '无'}`)
  }
  const kept = tenantDocs(0)
  const ghosts: TDoc[] = []
  for (let i = 0; i < 30; i++) ghosts.push({ id: `G${String(i + 1).padStart(2, '0')}`, tenant: 'acme', text: `报销 报销单 第${i}号 已作废。` })
  const soft = bm25Rank(kept, [...kept, ...ghosts], '报销 发票')
  const rebuilt = bm25Rank(kept, kept, '报销 发票')
  const show = (xs: AnnHit[]) => xs.map((r) => `${r.id}:${Math.floor(r.score * 1000)}`).join('  ')
  console.log(`  删了 30 篇、统计量没重算：${show(soft)}`)
  console.log(`  重建之后                ：${show(rebuilt)}`)
  console.log(dim('  incremental 永远见不到整篇被删的 C；full 在 loader 部分失败时删掉了 B；软删除的文档还在改 IDF。'))
}

function exp8(c: Corpus): void {
  console.log(bold('\n实验八：入库门禁（解析器不抛异常，所以要自己查）'))
  console.log(dim(`  ${pad('文档', 16)}` + GATE_CHECKS.map((g) => g.label).join('  ')))
  for (const { name, doc } of badDocs(c)) {
    const issues = qualityGate(doc).issues
    const cells = GATE_CHECKS.map((g) => pad(issues.includes(g.code) ? '✗' : '·', w(g.label))).join('  ')
    console.log(`  ${pad(name, 16)}${cells}`.replace(/ +$/, ''))
  }
  console.log(dim('  每份坏文档恰好被一项抓住、好文档一项都不中：检查之间不冗余，也不误报。'))
}

// ─────────────────────────────────────────────────────────────
// TODO
// ─────────────────────────────────────────────────────────────

/**
 * TODO 1 ★ 一行是不是标题、第几级（不是标题返回 null）。先 normalizeText（去 BOM + NFKC）：
 *   第X章 1 · 第X节 2 · 第X条 3（X 是中文数字）
 *   一、1 · (一) 2 · 1. 或 1、3 · (1) 4（NFKC 之后全角括号已经是半角）
 *   1.1 4 · 1.1.2 5（多级小节：点的个数 + 3，后面必须跟空格或结束）
 *   「2025年预算增长10%。」「1.5元以内」不是标题
 * label 是编号本身（规范化之后的，如「第十二条」「(一)」「1.1.2」）。
 * 陷阱：用 \d（TS 不认全角「１」，Python 认）；不做 NFKC，「（一）」和「(一)」成了两级；只看第一个数字。
 */
export function myHeadingLevel(line: string): HeadingInfo | null {
  throw new Error('TODO 1 未实现')
}

/**
 * TODO 2 ★★ 表格每一行渲染成一段带完整列名的文本。
 *   列名：多级表头按列拼，上一级的空格沿用左边（跨列）、最后一级的空格就是没有，非空部分用「/」连
 *     [['部门','2025年','','2024年',''], ['','金额','占比','金额','占比']]
 *     → 部门、2025年/金额、2025年/占比、2024年/金额、2024年/占比
 *   每行：「caption 列名: 值; 列名: 值」——caption 为空就不带；空单元格跳过；hiddenColumns 里的列不出现
 * 陷阱：只用 headerRows[0]；「合计」行不带列名；caption 只放在第一行。
 */
export function myRenderTableRows(t: TableData, hiddenColumns: string[] = []): string[] {
  throw new Error('TODO 2 未实现')
}

/**
 * TODO 3 ★★ 带权限的 ANN 检索。ranked 已经按 ANN 顺序排好，visible(id) 是权限判定。
 *   post       取前 min(ef, n) 个，过滤，取前 k；scanned = min(ef, n)
 *   pre        按顺序过滤到够 k 个为止；scanned = n
 *   iterative  从 ef 开始，不够 k 个就再加一份 ef，直到够了或碰到 min(maxScan, n)；scanned = 最后用的 ef
 * 陷阱：迭代没有上限；不够 k 个时拿越权的凑数；把 post 偷偷写成 pre（verify 会抓）。
 */
export function mySearchFiltered(ranked: AnnHit[], visible: (id: string) => boolean, o: FilterOpts): FilteredSearch {
  throw new Error('TODO 3 未实现')
}

/**
 * TODO 4 ★ 外部 rerank 的两种顺序。
 *   filter-first：先按 visible 过滤，再把剩下的 id 发给 reranker；rerank-first：全部发出去，回来再过滤
 *   reranker(ids) 返回同样长度的分数；按分数降序、同分按 id（cmpCodePoint）排，取前 k
 *   exposed = 发给 reranker 的 id（按发送顺序）
 * 陷阱：先 rerank 再过滤——ids 和 filter-first 一模一样，测结果的测试全过，越权全文已经发出去了。
 */
export function myRerankPipeline(
  cands: AnnHit[],
  visible: (id: string) => boolean,
  order: RerankOrder,
  reranker: (ids: string[]) => number[],
  k: number,
): RerankResult {
  throw new Error('TODO 4 未实现')
}

/**
 * TODO 5 ★★ 同一 family 的版本，在 asOf 这一天该用哪个。日期是 YYYY-MM-DD，直接按字符串比。
 *   1. 缺 effectiveFrom 的不参与（reason 里要提到 effectiveFrom）
 *   2. 只留 effectiveFrom ≤ asOf 且没有 repealedAt ≤ asOf 的；一个都没有 → chosen null、conflict false
 *   3. 只看 level 最小的（上位优先）；还有更下位的在场 → conflict = true
 *   4. 同级里既有 special 又有一般：一般的生效日更晚 → chosen null、conflict true；否则取最新的 special
 *   5. 否则取生效日最新的（同日比 issued，再比 docId）
 * 陷阱：按 mtime 或 issued 取最新；忽略 effectiveFrom > asOf；「新的一般 vs 旧的特别」硬选一个。
 */
export function myResolveVersions(cands: VersionCand[], asOf: string): VersionVerdict {
  throw new Error('TODO 5 未实现')
}

/**
 * TODO 6 ★ 一轮同步。索引按 syncKey（src:hash）去重；先把 batch 全部写入，再按模式删：
 *   none         不删
 *   incremental  src 在本批出现过、但这个 key 不在本批 → 删
 *   full         key 不在本批 → 删
 *   tombstone    incremental 的规则，再加：src 在 tombstones 里 → 删
 * 返回按 syncKey 排序（cmpCodePoint）的数组。
 * 陷阱：用 incremental 的语义（整篇删除残留）；用 full 的语义（loader 少拿一篇就误删）。
 */
export function myApplySync(index: SyncChunk[], batch: SyncChunk[], tombstones: string[], mode: SyncMode): SyncChunk[] {
  throw new Error('TODO 6 未实现')
}

/**
 * TODO 7 ★ 答案缓存的键：三段用 \u001f 连起来
 *   trimSpaces(normalizeText(query)) · principals 去重后按 cmpCodePoint 排序、用「,」连 · corpusVersion
 * 陷阱：键里没有 principals（跨用户串答案）；不排序去重（同样的权限不同的键）；没有语料版本（撤权后还命中旧答案）。
 */
export function myCacheKey(query: string, principals: string[], corpusVersion: string): string {
  throw new Error('TODO 7 未实现')
}

// ─────────────────────────────────────────────────────────────

function main(): void {
  const c = loadCorpus()
  exp1(c)
  exp2(c)
  exp3()
  exp4()
  exp5()
  exp6(c)
  exp7()
  exp8(c)
  console.log(bold('\n最该记住的'))
  console.log('  · 企业 RAG 多出来的失败几乎都不报错：每一种都要变成一个可以断言的输出。')
  console.log('  · ACL 写成 WHERE 是安全的，但召回会静默塌缩；过滤要放进 ANN 里面。')
  console.log('  · 「结果一样」不等于「安全一样」：rerank、缓存、trace 都是权限的副本。')
  console.log('  · 删除要靠显式墓碑，「这次没看到」不等于「被删了」。')
  console.log('  · 「最新版」至少有三个维度，而且有一种冲突必须交给人。')
}

if (isMain(import.meta.url)) main()
