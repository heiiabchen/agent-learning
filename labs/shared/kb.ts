/**
 * L09x 参考实现：企业知识库 RAG 里那些「不报错的失败」。
 *
 * L09 的语料是代码库：结构是显式语法，人人可见，删了就是删了。
 * 企业语料多出来的东西几乎全是静默失效，所以这里每一个函数都把一种静默失效变成可断言的输出：
 *
 *   A. 解析后清洗：页眉是跨页统计出来的，不是「顶部 10%」；页码有两套坐标
 *   B. 结构：中文编号识别（不能用 \d）；表格的每一行都要带上完整的列名
 *   C. 分块：标题路径、跨页段落、跨页表格、脚注、字段级权限
 *   D. 权限：缺 acl 就不可见；过滤放在 ANN 里面；rerank 之前就要过滤
 *   E. 多租户：tenant 过滤之后，BM25 统计量仍然是共享的
 *   F. 版本：上位 > 下位、特别 > 一般、新 > 旧，还有一种情况不能自动裁决
 *   G. 同步：删除要靠显式墓碑；重建范围看「什么变了」
 *   H. 缓存键与入库门禁
 *
 * ★ 零网络、零模型、零向量库。ANN 用「精确排序的前 ef 个」近似——这只会让后过滤显得更好，
 * 所以观察实验里的坏结果是保守的。
 * ★ 跨语言字节一致：不用 \w \d \s；长度按码点；去空白只去 ASCII 空格；排序用 cmpCodePoint 且永远带 tie-break。
 * 正文保留原样（只去 BOM）：NFKC 会把「①」变成「1」、「（」变成「(」，引用时就对不上原文了。
 * 规范化只用在切词、标题识别、缓存键这些「比较」的地方。
 */

import { tokenize } from './retrieval.ts'
import { cmpCodePoint } from './codingEval.ts'

export function cpLen(s: string): number {
  return Array.from(s).length
}

export function trimSpaces(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && s[a] === ' ') a++
  while (b > a && s[b - 1] === ' ') b--
  return s.slice(a, b)
}

function asciiLower(s: string): string {
  let out = ''
  for (const c of s) out += c >= 'A' && c <= 'Z' ? String.fromCharCode(c.charCodeAt(0) + 32) : c
  return out
}

function stripBom(s: string): string {
  return s.split('\uFEFF').join('')
}

// ─────────────────────────────────────────────────────────────
// 数据形状
// ─────────────────────────────────────────────────────────────

export type BlockKind = 'text' | 'table' | 'footnote'

export interface TableData {
  caption: string
  /** 多级表头：上一级的空格表示「跨列，沿用左边」。 */
  headerRows: string[][]
  rows: string[][]
}

export interface Block {
  id: string
  kind: BlockKind
  text: string
  /** 块顶边在页面上的位置，0–1000（千分比，避免浮点）。 */
  y: number
  /** 解析器标记的「接着上一页的同类块」：跨页段落、跨页表格的后半段。 */
  continuesPrev?: boolean
  table?: TableData
}

export interface ParsedPage {
  /** 物理页序，从 0 起（MinerU page_idx 的口径）。 */
  index0: number
  /** 印刷页码（「ii」「3」），可能没有。 */
  label?: string
  blocks: Block[]
}

export interface VersionMeta {
  family: string
  /** 1 = 集团，数字越大越下位。 */
  level: number
  /** 特别规定（只适用于某部门、某情形）。 */
  special: boolean
  issued: string
  effectiveFrom?: string
  repealedAt?: string
  /** 文件修改时间：重新编辑一下旧版，它就变成「最新」了。 */
  mtime: string
}

export interface FieldAcl {
  column: string
  principals: string[]
}

export interface ParsedDoc {
  docId: string
  tenant: string
  title: string
  acl?: string[]
  fieldAcl?: FieldAcl[]
  version: VersionMeta
  parser: string
  pages: ParsedPage[]
}

/** 索引的「代」：换了其中任何一样，旧向量和新向量就不可比。 */
export interface Gen {
  parser: string
  chunker: string
  embedder: string
}

export interface KbChunk {
  id: string
  docId: string
  tenant: string
  text: string
  headingPath: string[]
  /** 物理页序 [起, 止]。 */
  pages: [number, number]
  pageLabels: [string | null, string | null]
  acl?: string[]
  version: VersionMeta
  gen: Gen
  kind: 'text' | 'table_row'
}

export interface Session {
  userId: string
  tenant: string
  principals: string[]
}

// ─────────────────────────────────────────────────────────────
// A. 解析后清洗
// ─────────────────────────────────────────────────────────────

/**
 * 去 BOM，再 NFKC。
 * ★ 顺序不能反、BOM 不能省：JS 的 trim() 和 \s 认 BOM，Python 的 strip() 不认——
 * 「\uFEFF第一章」在 TS 里 trim 一下侥幸能匹配「^第」，在 Python 里不能。
 * ★ NFKC 会把全角括号变成半角：之后匹配编号要用「(」，不是「（」。
 */
export function normalizeText(s: string): string {
  return stripBom(s).normalize('NFKC')
}

export const HEADER_ZONE = 100

function inZone(y: number, zone: number): boolean {
  return y < zone || y >= 1000 - zone
}

/**
 * 页眉页脚：在 ≥ minPages 页的顶部或底部区域重复出现的同一行。
 * ★ 是跨页统计，不能逐页判：「顶部 10% 的文字」会把第一页的标题删掉；
 * 「出现两次就删」会把恰好在两页顶部出现的小标题删掉。少于 minPages 页的文档基本不去页眉。
 */
export function detectRunningLines(pages: ParsedPage[], zone = HEADER_ZONE, minPages = 3): string[] {
  const count = new Map<string, number>()
  for (const p of pages) {
    const seen = new Set<string>()
    for (const b of p.blocks) {
      if (b.kind !== 'text' || !inZone(b.y, zone)) continue
      const t = trimSpaces(normalizeText(b.text))
      if (t) seen.add(t)
    }
    for (const t of seen) count.set(t, (count.get(t) ?? 0) + 1)
  }
  return [...count.entries()].filter(([, n]) => n >= minPages).map(([t]) => t).sort(cmpCodePoint)
}

/** 页码行：每页都不同，所以统计抓不到，要靠模式。「— ii —」「- 3 -」「第 3 页」。 */
export function isPageNumberLine(s: string): boolean {
  const t = trimSpaces(normalizeText(s))
  return /^[-—–· ]*([0-9]+|[ivxlcdmIVXLCDM]+)[-—–· ]*$/.test(t) || /^第 ?[0-9]+ ?页$/.test(t)
}

export interface Removed {
  page: number
  text: string
  why: 'running' | 'page_number'
}

/** 去掉页眉页脚和页码行，返回保留的页面和删掉了什么（观察实验要看）。 */
export function stripRunning(doc: ParsedDoc): { pages: ParsedPage[]; removed: Removed[] } {
  const running = new Set(detectRunningLines(doc.pages))
  const removed: Removed[] = []
  const pages = doc.pages.map((p) => ({
    ...p,
    blocks: p.blocks.filter((b) => {
      if (b.kind !== 'text' || !inZone(b.y, HEADER_ZONE)) return true
      const t = trimSpaces(normalizeText(b.text))
      if (running.has(t)) {
        removed.push({ page: p.index0, text: b.text, why: 'running' })
        return false
      }
      if (isPageNumberLine(t)) {
        removed.push({ page: p.index0, text: b.text, why: 'page_number' })
        return false
      }
      return true
    }),
  }))
  return { pages, removed }
}

// ─────────────────────────────────────────────────────────────
// B. 结构：中文编号与表格
// ─────────────────────────────────────────────────────────────

export interface HeadingInfo {
  level: number
  label: string
}

const CN = '[一二三四五六七八九十百千零〇两]+'
const RE_ARTICLE = new RegExp(`^第${CN}(章|节|条)`)
const RE_CN_LIST = new RegExp(`^${CN}、`)
const RE_CN_PAREN = new RegExp(`^\\(${CN}\\)`)
const ARTICLE_LEVEL: Record<string, number> = { 章: 1, 节: 2, 条: 3 }

/**
 * 一行是不是标题、第几级。先 normalizeText，再用显式字符类匹配：
 *   第X章 1 · 第X节 2 · 第X条 3
 *   一、1 · (一) 2 · 1. 或 1、3 · (1) 4（GB/T 9704 的四级序）
 *   1.1 4 · 1.1.2 5（多级小节，后面必须跟空格）
 * 「2025年预算增长10%。」「1.5元以内」都不是标题。
 *
 * ★ 不能用 \d：Python 的 \d 认全角「１」，TS 的不认。NFKC 之后统一成 ASCII 再用 [0-9]。
 * ★ 同一符号在不同体系里层级不同：公文的「（一）」是第 2 层，法规的「（一）」是「项」。
 * 这里按公文排；法规文档要换一张表（层级判定应以文档类型为参数）。
 */
export function headingLevel(line: string): HeadingInfo | null {
  const s = trimSpaces(normalizeText(line))
  let m = s.match(RE_ARTICLE)
  if (m) return { level: ARTICLE_LEVEL[m[1]!]!, label: m[0] }
  m = s.match(RE_CN_LIST)
  if (m) return { level: 1, label: m[0] }
  m = s.match(RE_CN_PAREN)
  if (m) return { level: 2, label: m[0] }
  m = s.match(/^[0-9]+(\.[0-9]+)+(?= |$)/)
  if (m) return { level: 3 + m[0].split('.').length - 1, label: m[0] }
  m = s.match(/^[0-9]+[.、](?![0-9])/)
  if (m) return { level: 3, label: m[0] }
  m = s.match(/^\([0-9]+\)/)
  if (m) return { level: 4, label: m[0] }
  return null
}

/**
 * 多级表头按列拼成列名：上一级的空格沿用左边（跨列），各级非空的部分用「/」连起来。
 *   [['部门','2025年','','2024年',''], ['','金额','占比','金额','占比']]
 *   → ['部门', '2025年/金额', '2025年/占比', '2024年/金额', '2024年/占比']
 * ★ 只取第一行表头（RAGFlow 的 rows[0]）会让「金额」和「占比」两列都叫「2025年」。
 */
export function columnNames(headerRows: string[][]): string[] {
  let n = 0
  for (const r of headerRows) if (r.length > n) n = r.length
  const filled = headerRows.map((r, i) => {
    const out: string[] = []
    for (let j = 0; j < n; j++) {
      const c = trimSpaces(r[j] ?? '')
      out.push(c === '' && i < headerRows.length - 1 && j > 0 ? out[j - 1]! : c)
    }
    return out
  })
  const names: string[] = []
  for (let j = 0; j < n; j++) {
    const parts: string[] = []
    for (const r of filled) if (r[j] !== '' && parts[parts.length - 1] !== r[j]) parts.push(r[j]!)
    names.push(parts.join('/'))
  }
  return names
}

/**
 * 表格的每一行渲染成一段能独立回答「这一格是哪一列」的文本：
 *   「表3 各部门预算（万元）① 部门: 研发部; 2025年/金额: 1200; …」
 * caption 每行都带；空单元格跳过；「合计」行照常带列名；hiddenColumns 里的列不出现。
 * ★ 「表格不能被切断」的真正意思不是整表放一个 chunk，而是任何一个含数据的 chunk 都带着列名。
 */
export function renderTableRows(t: TableData, hiddenColumns: string[] = []): string[] {
  const names = columnNames(t.headerRows)
  const caption = trimSpaces(t.caption)
  return t.rows.map((row) => {
    const pairs: string[] = []
    for (let j = 0; j < row.length; j++) {
      const v = trimSpaces(row[j] ?? '')
      const name = names[j] ?? ''
      if (v === '' || hiddenColumns.includes(name)) continue
      pairs.push(name ? `${name}: ${v}` : v)
    }
    return caption ? `${caption} ${pairs.join('; ')}` : pairs.join('; ')
  })
}

// ─────────────────────────────────────────────────────────────
// C. 分块
// ─────────────────────────────────────────────────────────────

export interface ChunkOpts {
  /** 一个 text chunk 最多多少码点（只在块边界切，不切开一个块）。 */
  maxChars?: number
  headingLevel?: (line: string) => HeadingInfo | null
  renderTableRows?: (t: TableData, hiddenColumns?: string[]) => string[]
}

const HEADING_ENTRY_MAX = 12
const CIRCLED = /[\u2460-\u2473]/

/**
 * 解析结果 → chunk。
 *   - 先去页眉页脚和页码（stripRunning）
 *   - 标题行开新 chunk；只有标题没有正文时，下一个标题并进同一个 chunk（「第二章 住宿标准」+「第十二条 …」）；
 *     标题后面紧跟表格时，标题只进表格行的 headingPath，不单独成块
 *   - continuesPrev 的段落直接接在上一段后面，页码范围跨页
 *   - 表格：continuesPrev 的后半段并进前一张表、继承表头和 caption；每个数据行一个 table_row chunk
 *   - 字段级权限：受限列不进普通行；另出一份完整行，acl 只给受限列的可见者
 *   - 脚注：带圈序号的脚注附到正文里含同一序号的 chunk；没有序号的附到同页最后一个 chunk
 *
 * ★ 字段级权限要在索引时做，不能在返回时遮：遮掉的值仍在 BM25 和向量里，用它当查询就能命中（存在性泄露）。
 */
export function chunkDocument(doc: ParsedDoc, gen: Gen, opts: ChunkOpts = {}): KbChunk[] {
  const maxChars = opts.maxChars ?? 400
  const heading = opts.headingLevel ?? headingLevel
  const render = opts.renderTableRows ?? renderTableRows
  const { pages } = stripRunning(doc)
  const labelOf = new Map<number, string>()
  for (const p of doc.pages) if (p.label !== undefined) labelOf.set(p.index0, p.label)
  const hidden = (doc.fieldAcl ?? []).map((f) => f.column)
  let fullRowAcl: string[] = []
  if (doc.fieldAcl && doc.fieldAcl.length) {
    fullRowAcl = doc.fieldAcl[0]!.principals.slice()
    for (const f of doc.fieldAcl.slice(1)) fullRowAcl = fullRowAcl.filter((p) => f.principals.includes(p))
    fullRowAcl.sort(cmpCodePoint)
  }

  const chunks: KbChunk[] = []
  const stack: { level: number; entry: string }[] = []
  let buf: { texts: string[]; body: number; chars: number; p0: number; p1: number; path: string[] } | null = null
  let table: { t: TableData; rowPages: number[]; path: string[] } | null = null
  const footnotes: { text: string; page: number }[] = []

  const push = (text: string, kind: KbChunk['kind'], p0: number, p1: number, path: string[], acl?: string[]) => {
    chunks.push({
      id: `${doc.docId}#${String(chunks.length).padStart(2, '0')}`,
      docId: doc.docId,
      tenant: doc.tenant,
      text,
      headingPath: path,
      pages: [p0, p1],
      pageLabels: [labelOf.get(p0) ?? null, labelOf.get(p1) ?? null],
      acl: acl === undefined ? undefined : acl.slice(),
      version: doc.version,
      gen,
      kind,
    })
  }
  const flushText = () => {
    if (buf && buf.texts.length) push(buf.texts.join('\n'), 'text', buf.p0, buf.p1, buf.path, doc.acl)
    buf = null
  }
  const flushTable = () => {
    if (!table) return
    const rows = render(table.t, hidden)
    rows.forEach((r, i) => push(r, 'table_row', table!.rowPages[i]!, table!.rowPages[i]!, table!.path, doc.acl))
    if (hidden.length) {
      const full = render(table.t, [])
      full.forEach((r, i) => push(r, 'table_row', table!.rowPages[i]!, table!.rowPages[i]!, table!.path, fullRowAcl))
    }
    table = null
  }
  const path = () => stack.map((s) => s.entry)

  for (const p of pages) {
    for (const b of p.blocks) {
      if (b.kind === 'footnote') {
        footnotes.push({ text: stripBom(b.text), page: p.index0 })
        continue
      }
      if (b.kind === 'table' && b.table) {
        if (b.continuesPrev && table) {
          for (const r of b.table.rows) {
            table.t.rows.push(r.slice())
            table.rowPages.push(p.index0)
          }
          continue
        }
        if (buf && buf.body === 0) buf = null
        flushText()
        flushTable()
        table = {
          t: { caption: b.table.caption, headerRows: b.table.headerRows.map((r) => r.slice()), rows: b.table.rows.map((r) => r.slice()) },
          rowPages: b.table.rows.map(() => p.index0),
          path: path(),
        }
        continue
      }
      const text = stripBom(b.text)
      if (b.continuesPrev && buf) {
        buf.texts[buf.texts.length - 1] += text
        buf.chars += cpLen(text)
        buf.p1 = p.index0
        continue
      }
      flushTable()
      const h = heading(text)
      if (h) {
        if (buf && buf.body > 0) flushText()
        while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop()
        stack.push({ level: h.level, entry: cpLen(trimSpaces(text)) <= HEADING_ENTRY_MAX ? trimSpaces(text) : h.label })
        if (!buf) buf = { texts: [], body: 0, chars: 0, p0: p.index0, p1: p.index0, path: [] }
        buf.texts.push(text)
        buf.chars += cpLen(text)
        buf.p1 = p.index0
        buf.path = path()
        if (cpLen(trimSpaces(text)) > HEADING_ENTRY_MAX) buf.body++
        continue
      }
      if (buf && buf.body > 0 && buf.chars + cpLen(text) > maxChars) flushText()
      if (!buf) buf = { texts: [], body: 0, chars: 0, p0: p.index0, p1: p.index0, path: path() }
      buf.texts.push(text)
      buf.chars += cpLen(text)
      buf.p1 = p.index0
      buf.body++
    }
  }
  flushText()
  flushTable()

  for (const fn of footnotes) {
    const marker = Array.from(fn.text)[0] ?? ''
    let targets = CIRCLED.test(marker) ? chunks.filter((c) => c.text.includes(marker)) : []
    if (!targets.length) {
      const onPage = chunks.filter((c) => c.pages[0] <= fn.page && fn.page <= c.pages[1])
      targets = onPage.length ? [onPage[onPage.length - 1]!] : chunks.length ? [chunks[chunks.length - 1]!] : []
    }
    for (const c of targets) c.text += `\n${fn.text}`
  }
  return chunks
}

/**
 * 引用定位：只有这一个函数负责把内部坐标换成给人看的页码。
 *   有印刷页码：「p. ii」「pp. 2–3」；没有：「第 1 页」「第 3–4 页」（物理页序 + 1）
 * ★ 内部 0 起、CLI 1 起、阅读器 1 起、印刷页码另有一套——存的时候分开存，显示的时候只在这里换算。
 */
export function citeLocator(c: KbChunk): string {
  const [a, b] = c.pages
  const [la, lb] = c.pageLabels
  if (la !== null && lb !== null) return a === b ? `p. ${la}` : `pp. ${la}–${lb}`
  return a === b ? `第 ${a + 1} 页` : `第 ${a + 1}–${b + 1} 页`
}

// ─────────────────────────────────────────────────────────────
// D. 权限
// ─────────────────────────────────────────────────────────────

export type PrincipalKind = 'user' | 'group' | 'ext_group'

/**
 * 「类型:名字」，ASCII 小写。外部组再带来源：「ext_group:confluence/eng」。
 * ★ 没有前缀，名叫 alice@qinghe.com 的组和用户 alice@qinghe.com 就是同一个 principal。
 */
export function principalKey(kind: PrincipalKind, name: string, source?: string): string {
  const n = asciiLower(trimSpaces(name))
  if (kind === 'ext_group') {
    if (!source) throw new Error('ext_group 必须带来源系统')
    return `ext_group:${asciiLower(trimSpaces(source))}/${n}`
  }
  return `${kind}:${n}`
}

/** ★ fail-closed：缺 acl 的 chunk 谁都看不见。「没写权限 = 公开」是最常见的越权来源。 */
export function aclVisible(c: { acl?: string[] }, principals: string[]): boolean {
  if (!c.acl) return false
  return c.acl.some((p) => principals.includes(p))
}

export function canSee(c: KbChunk, s: Session): boolean {
  return c.tenant === s.tenant && aclVisible(c, s.principals)
}

/** ★ 多人会话（群聊、共享屏幕）：按在场所有人的交集检索，不是按提问者。 */
export function visibleToAll(c: KbChunk, sessions: Session[]): boolean {
  return sessions.length > 0 && sessions.every((s) => canSee(c, s))
}

export interface AnnHit {
  id: string
  score: number
}

export type FilterMode = 'post' | 'pre' | 'iterative'

export interface FilterOpts {
  k: number
  /** ANN 候选数（hnsw.ef_search）。 */
  ef: number
  mode: FilterMode
  /** 迭代扫描的上限（hnsw.max_scan_tuples）。 */
  maxScan: number
}

export interface FilteredSearch {
  ids: string[]
  /** 碰过多少个候选：代价。 */
  scanned: number
}

/**
 * ranked 是 ANN 给出的顺序（这里用精确排序代替），visible 是权限判定。
 *   post      取前 ef 个候选再按权限过滤：安全，但可能远少于 k 条（ACL 写成 WHERE 的默认行为）
 *   pre       先过滤再取前 k（knn.filter 的语义）
 *   iterative 不够 k 条就把 ef 再加一份，直到够了或碰到 maxScan
 *
 * ★ 后过滤不报错、不越权，安全审计全绿——召回塌到 0 条只能靠「按身份分层」的评测发现。
 * ★ 迭代扫描必须有上限；不够 k 条时宁可少给，也不能拿越权的凑数。
 */
export function searchFiltered(ranked: AnnHit[], visible: (id: string) => boolean, o: FilterOpts): FilteredSearch {
  const total = ranked.length
  if (o.mode === 'pre') {
    const ids: string[] = []
    for (const h of ranked) {
      if (ids.length >= o.k) break
      if (visible(h.id)) ids.push(h.id)
    }
    return { ids, scanned: total }
  }
  const take = (n: number) => ranked.slice(0, n).filter((h) => visible(h.id)).map((h) => h.id)
  if (o.mode === 'post') {
    const n = Math.min(o.ef, total)
    return { ids: take(n).slice(0, o.k), scanned: n }
  }
  const cap = Math.min(o.maxScan, total)
  let ef = Math.min(o.ef, cap)
  let got = take(ef)
  while (got.length < o.k && ef < cap) {
    ef = Math.min(ef + o.ef, cap)
    got = take(ef)
  }
  return { ids: got.slice(0, o.k), scanned: ef }
}

export type RerankOrder = 'filter-first' | 'rerank-first'

export interface RerankResult {
  ids: string[]
  /** 发给外部 reranker 的候选——它们的全文离开了你的边界。 */
  exposed: string[]
}

/**
 * 候选 → 外部 reranker → 取前 k。reranker 收到一组 id（代表全文），返回同样长度的分数。
 *   filter-first  先按权限过滤再发给 reranker
 *   rerank-first  全部发出去，回来再过滤
 * 两种顺序的 ids 完全一样。
 * ★ 「结果一样」不等于「安全一样」：安全边界是数据流向，不是最终答案。
 */
export function rerankPipeline(
  cands: AnnHit[],
  visible: (id: string) => boolean,
  order: RerankOrder,
  reranker: (ids: string[]) => number[],
  k: number,
): RerankResult {
  const send = order === 'filter-first' ? cands.filter((h) => visible(h.id)).map((h) => h.id) : cands.map((h) => h.id)
  const scores = reranker(send)
  if (scores.length !== send.length) throw new Error('reranker 返回的分数个数不对')
  const idx = send.map((_, i) => i).sort((a, b) => scores[b]! - scores[a]! || cmpCodePoint(send[a]!, send[b]!))
  let ids = idx.map((i) => send[i]!)
  if (order === 'rerank-first') ids = ids.filter(visible)
  return { ids: ids.slice(0, k), exposed: send }
}

export interface SearchRequest {
  query: string
  k: number
  knn: { k: number; filter: { tenant: string; aclAny: string[] } }
}

const TOOL_ARGS = ['query', 'k']

/**
 * 模型的工具参数 → 检索请求。权限只能从会话来。
 * ★ 工具参数里出现 filter、user_groups、doc_ids、tenant 之类的字段一律拒绝：它们是模型写的，
 * 也就是 prompt injection 写的（接 L14「参数才是攻击面」）。按 doc id 直接取文档同样绕过 ACL。
 * ★ ACL 放在 knn.filter 里面（预过滤），不能放在外层 filter / post_filter（后过滤，可能少于 k 条）。
 */
export function buildSearchRequest(toolArgs: Record<string, unknown>, s: Session): SearchRequest {
  for (const key of Object.keys(toolArgs)) {
    if (!TOOL_ARGS.includes(key)) throw new Error(`工具参数里不允许出现 ${key}：权限只能来自会话`)
  }
  const query = toolArgs.query
  if (typeof query !== 'string' || trimSpaces(query) === '') throw new Error('query 必须是非空字符串')
  const k = toolArgs.k === undefined ? 5 : toolArgs.k
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > 20) throw new Error('k 必须是 1–20 的整数')
  return { query, k, knn: { k, filter: { tenant: s.tenant, aclAny: s.principals.slice() } } }
}

// ─────────────────────────────────────────────────────────────
// E. 词法检索与多租户统计
// ─────────────────────────────────────────────────────────────

/** 先 normalizeText 再用 L09 的 tokenize：L09 的字符类不含全角数字，「第３条」会只剩「第、条」。 */
export function kbTokenize(s: string): string[] {
  return tokenize(normalizeText(s))
}

export interface TDoc {
  id: string
  tenant: string
  text: string
}

/**
 * 和 L09 同式的 BM25，但统计量（df、N、平均长度）来自 statDocs——可以和被打分的 docs 不同。
 * 这正是要观察的东西：共享索引的统计量、软删除留下的统计量。
 */
export function bm25Rank(
  docs: TDoc[],
  statDocs: TDoc[],
  query: string,
  tok: (s: string) => string[] = kbTokenize,
  k1 = 1.5,
  b = 0.75,
): AnnHit[] {
  if (statDocs.length === 0) return []
  const df = new Map<string, number>()
  let totalLen = 0
  for (const d of statDocs) {
    const ts = tok(d.text)
    totalLen += ts.length
    for (const t of new Set(ts)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const N = statDocs.length
  const avg = totalLen / N
  const q = [...new Set(tok(query))]
  const rows: AnnHit[] = []
  for (const d of docs) {
    const ts = tok(d.text)
    const tf = new Map<string, number>()
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const t of q) {
      const f = tf.get(t)
      if (!f) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * ts.length) / avg)))
    }
    if (score > 0) rows.push({ id: d.id, score })
  }
  return rows.sort((x, y) => y.score - x.score || cmpCodePoint(x.id, y.id))
}

export type StatScope = 'shared' | 'per-tenant'

/**
 * shared     一个索引、按 tenant 过滤结果：别的租户的文档在改你的 IDF
 * per-tenant 每个租户自己的统计量：和「只用这个租户的文档单独建索引」逐位相等
 * ★ 加了 tenant_id 过滤不等于隔离：结果里没有别人的文档，排序却是别人决定的。
 */
export function tenantSearch(all: TDoc[], scope: StatScope, query: string, tenant: string, k: number): AnnHit[] {
  const own = all.filter((d) => d.tenant === tenant)
  if (scope === 'per-tenant') return bm25Rank(own, own, query).slice(0, k)
  const ownIds = new Set(own.map((d) => d.id))
  return bm25Rank(all, all, query).filter((h) => ownIds.has(h.id)).slice(0, k)
}

export function chunkDocs(chunks: KbChunk[]): TDoc[] {
  return chunks.map((c) => ({ id: c.id, tenant: c.tenant, text: c.text }))
}

/** 在 chunk 上做一次带权限的词法检索：BM25 给顺序，searchFiltered 管权限。 */
export function searchKb(chunks: KbChunk[], query: string, s: Session, o: FilterOpts, search = searchFiltered): KbChunk[] {
  const docs = chunkDocs(chunks)
  const byId = new Map(chunks.map((c) => [c.id, c]))
  const ranked = bm25Rank(docs, docs, query)
  return search(ranked, (id) => canSee(byId.get(id)!, s), o).ids.map((id) => byId.get(id)!)
}

// ─────────────────────────────────────────────────────────────
// F. 版本
// ─────────────────────────────────────────────────────────────

export interface VersionCand {
  docId: string
  version: VersionMeta
}

export interface VersionVerdict {
  chosen: string | null
  conflict: boolean
  reason: string
}

function isLive(v: VersionMeta, asOf: string): boolean {
  return v.effectiveFrom !== undefined && v.effectiveFrom <= asOf && !(v.repealedAt !== undefined && v.repealedAt <= asOf)
}

function newestFirst(a: VersionCand, b: VersionCand): number {
  const ea = a.version.effectiveFrom ?? ''
  const eb = b.version.effectiveFrom ?? ''
  if (ea !== eb) return ea < eb ? 1 : -1
  if (a.version.issued !== b.version.issued) return a.version.issued < b.version.issued ? 1 : -1
  return cmpCodePoint(a.docId, b.docId)
}

/**
 * 同一 family 的几个版本，在 asOf 这一天该用哪一个。日期都是 YYYY-MM-DD，按字典序比。
 *   1. 缺 effectiveFrom 的不参与自动消解（写进 reason）
 *   2. 只留 asOf 当天已生效、未废止的
 *   3. 上位优先：只看 level 最小的；还有下位版本在场 → conflict（下位冲突需标注）
 *   4. 同级里既有特别规定又有一般规定：一般的更新 → chosen = null、conflict（立法法第一百零五条：交人裁决）；
 *      否则特别的优先
 *   5. 否则取生效日最新的
 * ★ 按 mtime 取最新：旧版重新编辑一下就「最新」了。按 issued 取最新：未生效的新办法提前上岗。
 * ★ 必须在权限过滤之后、对每个用户分别做：研发部的人看得见特别规定，别人看不见，答案就不同。
 */
export function resolveVersions(cands: VersionCand[], asOf: string): VersionVerdict {
  const notes: string[] = []
  const missing = cands.filter((c) => c.version.effectiveFrom === undefined).map((c) => c.docId).sort(cmpCodePoint)
  if (missing.length) notes.push(`${missing.join('、')} 缺 effectiveFrom，不参与自动消解`)
  const live = cands.filter((c) => isLive(c.version, asOf))
  if (!live.length) return { chosen: null, conflict: false, reason: ['没有在 asOf 生效的版本', ...notes].join('；') }
  let top = live[0]!.version.level
  for (const c of live) if (c.version.level < top) top = c.version.level
  const lv = live.filter((c) => c.version.level === top)
  const lower = live.length - lv.length
  if (lower > 0) notes.push(`上位优先，${lower} 份下位规定冲突需标注`)
  const sp = lv.filter((c) => c.version.special).sort(newestFirst)
  const gen = lv.filter((c) => !c.version.special).sort(newestFirst)
  if (sp.length && gen.length) {
    if ((gen[0]!.version.effectiveFrom ?? '') > (sp[0]!.version.effectiveFrom ?? '')) {
      return {
        chosen: null,
        conflict: true,
        reason: [`新的一般规定 ${gen[0]!.docId} 晚于旧的特别规定 ${sp[0]!.docId}，不能自动裁决`, ...notes].join('；'),
      }
    }
    return { chosen: sp[0]!.docId, conflict: lower > 0, reason: ['特别规定优先', ...notes].join('；') }
  }
  const pick = lv.slice().sort(newestFirst)[0]!
  return { chosen: pick.docId, conflict: lower > 0, reason: ['取生效日最新的', ...notes].join('；') }
}

/** 对照组：按 mtime 取最新。 */
export function pickByMtime(cands: VersionCand[]): string | null {
  if (!cands.length) return null
  return cands.slice().sort((a, b) => (a.version.mtime !== b.version.mtime ? (a.version.mtime < b.version.mtime ? 1 : -1) : cmpCodePoint(a.docId, b.docId)))[0]!.docId
}

/** 对照组：只看生效日（懂 asOf，不懂上位 / 特别）。 */
export function pickByEffective(cands: VersionCand[], asOf: string): string | null {
  const live = cands.filter((c) => isLive(c.version, asOf)).sort(newestFirst)
  return live.length ? live[0]!.docId : null
}

/** ★ 不同代的向量不可比：一次检索的结果里混了两个 embedder，分数排序就没有意义。 */
export function assertSingleEmbedder(hits: { gen: Gen }[]): void {
  const seen = [...new Set(hits.map((h) => h.gen.embedder))].sort(cmpCodePoint)
  if (seen.length > 1) throw new Error(`检索结果混入了 ${seen.length} 代 embedding：${seen.join('、')}`)
}

// ─────────────────────────────────────────────────────────────
// G. 同步
// ─────────────────────────────────────────────────────────────

export interface SyncChunk {
  id: string
  /** 源文档 id。 */
  src: string
  /** 内容 hash。 */
  hash: string
}

export type SyncMode = 'none' | 'incremental' | 'full' | 'tombstone'

export function syncKey(c: SyncChunk): string {
  return `${c.src}:${c.hash}`
}

/**
 * 一轮同步：batch 是这次 loader 拿回来的 chunk，tombstones 是源系统明确告知「已删除」的文档。
 *   none         只写不删（LangChain cleanup=None、LlamaIndex UPSERTS 的默认）
 *   incremental  对这次见过的源文档，删掉它不在本批里的旧 chunk——整篇被删的文档永远不会被见到，于是永远残留
 *   full         删掉本批里没有的一切——loader 部分失败（权限过期、超时）时误删
 *   tombstone    incremental + 按墓碑删整篇
 * 结果按 syncKey 排序。
 * ★ 「这次没看到」不等于「被删了」。删除要靠显式事件。
 */
export function applySync(index: SyncChunk[], batch: SyncChunk[], tombstones: string[], mode: SyncMode): SyncChunk[] {
  const idx = new Map<string, SyncChunk>()
  for (const c of index) idx.set(syncKey(c), c)
  const seenSrc = new Set(batch.map((c) => c.src))
  const seenKey = new Set(batch.map(syncKey))
  for (const c of batch) idx.set(syncKey(c), c)
  for (const [k, c] of [...idx.entries()]) {
    if (mode === 'incremental' && seenSrc.has(c.src) && !seenKey.has(k)) idx.delete(k)
    else if (mode === 'full' && !seenKey.has(k)) idx.delete(k)
    else if (mode === 'tombstone' && (tombstones.includes(c.src) || (seenSrc.has(c.src) && !seenKey.has(k)))) idx.delete(k)
  }
  return [...idx.values()].sort((a, b) => cmpCodePoint(syncKey(a), syncKey(b)))
}

export interface ReindexPlan {
  reparse: boolean
  rechunk: boolean
  reembed: boolean
  /** 只改 payload（acl、版本元数据），不碰向量。 */
  payloadOnly: boolean
  deleteAll: boolean
}

function payloadOf(d: ParsedDoc): string {
  return JSON.stringify([d.title, d.acl ?? null, d.fieldAcl ?? null, d.version])
}

/**
 * 什么变了，就重做哪一段：
 *   文档没了 → deleteAll · 新文档或内容变了或 parser 换了 → 全部重做
 *   chunker 换了 → rechunk + reembed · embedder 换了 → 只 reembed
 *   只有 acl / 版本元数据变了 → payloadOnly
 * ★ 把 acl 算进内容 hash（LangChain 的 doc hash 含 metadata）：改一次权限就重新 embedding 全部 chunk。
 * ★ 换 parser 要 reparse，不是 rechunk：旧的解析结果不会自己更新。
 */
export function planReindex(oldDoc: ParsedDoc | null, newDoc: ParsedDoc | null, oldGen: Gen, newGen: Gen): ReindexPlan {
  const none: ReindexPlan = { reparse: false, rechunk: false, reembed: false, payloadOnly: false, deleteAll: false }
  if (!newDoc) return oldDoc ? { ...none, deleteAll: true } : none
  if (!oldDoc) return { ...none, reparse: true, rechunk: true, reembed: true }
  const contentChanged = JSON.stringify(oldDoc.pages) !== JSON.stringify(newDoc.pages)
  if (contentChanged || oldGen.parser !== newGen.parser) return { ...none, reparse: true, rechunk: true, reembed: true }
  if (oldGen.chunker !== newGen.chunker) return { ...none, rechunk: true, reembed: true }
  if (oldGen.embedder !== newGen.embedder) return { ...none, reembed: true }
  if (payloadOf(oldDoc) !== payloadOf(newDoc)) return { ...none, payloadOnly: true }
  return none
}

// ─────────────────────────────────────────────────────────────
// H. 缓存键与入库门禁
// ─────────────────────────────────────────────────────────────

/**
 * 语义缓存 / 答案缓存的键：规范化后的 query + 排序去重后的 principals + 语料版本。
 * ★ 不含 principals：HR 问过的答案被实习生命中。principals 不排序去重：同样的权限拿到不同的键。
 * 不含语料版本：撤了权、删了文档，缓存还在给旧答案。
 */
export function cacheKey(query: string, principals: string[], corpusVersion: string): string {
  const ps = [...new Set(principals)].sort(cmpCodePoint)
  return [trimSpaces(normalizeText(query)), ps.join(','), corpusVersion].join('\u001f')
}

export const GATE_CHECKS: { code: string; label: string }[] = [
  { code: 'NO_ACL', label: '缺 acl' },
  { code: 'NO_EFFECTIVE_FROM', label: '缺 effectiveFrom' },
  { code: 'EMPTY_PAGE', label: '空白页' },
  { code: 'FOOTNOTE_MISSING', label: '脚注丢失' },
  { code: 'TABLE_NO_HEADER', label: '表格无表头' },
  { code: 'REPLACEMENT_CHAR', label: '替换字符' },
]

/**
 * 解析器不抛异常，所以入库前要自己查。返回命中的检查（按 GATE_CHECKS 的顺序）。
 *   EMPTY_PAGE        某页没有任何文本或表格（扫描件没过 OCR？）
 *   FOOTNOTE_MISSING  正文里有带圈序号，文档里却一个脚注块都没有（解析器默认丢脚注）
 *   TABLE_NO_HEADER   表格没有表头，且不是跨页表格的后半段
 *   REPLACEMENT_CHAR  出现 U+FFFD（编码错了）
 */
export function qualityGate(doc: ParsedDoc): { pass: boolean; issues: string[] } {
  const hit = new Set<string>()
  if (!doc.acl || doc.acl.length === 0) hit.add('NO_ACL')
  if (doc.version.effectiveFrom === undefined) hit.add('NO_EFFECTIVE_FROM')
  let footnotes = 0
  let marked = false
  for (const p of doc.pages) {
    const hasContent = p.blocks.some((b) => (b.kind === 'table' && b.table) || trimSpaces(b.text) !== '')
    if (!hasContent) hit.add('EMPTY_PAGE')
    for (const b of p.blocks) {
      const texts = [b.text]
      if (b.table) texts.push(b.table.caption, ...b.table.headerRows.flat(), ...b.table.rows.flat())
      if (b.kind === 'footnote') footnotes++
      else if (texts.some((t) => CIRCLED.test(t))) marked = true
      if (texts.some((t) => t.includes('\uFFFD'))) hit.add('REPLACEMENT_CHAR')
      if (b.kind === 'table' && b.table && !b.continuesPrev && b.table.headerRows.length === 0) hit.add('TABLE_NO_HEADER')
    }
  }
  if (marked && footnotes === 0) hit.add('FOOTNOTE_MISSING')
  const issues = GATE_CHECKS.map((c) => c.code).filter((c) => hit.has(c))
  return { pass: issues.length === 0, issues }
}
