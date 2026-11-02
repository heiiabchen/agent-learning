/**
 * L14x 的脚手架。跑法：pnpm browse
 *
 * 观察实验：快照里哪些人看不见的字进了模型；ref 的五种过期；快照和截图谁贵；整页截图在三家的下场；
 * 五种坐标约定的换算和常见错法；「可见」的三种口径；审批框显示的和实际执行的；浏览器里的出站通道。
 * 不起浏览器、不调模型。页面是 fixtures/pages.json 里的「假页面」（两种语言读同一份文件）。
 * 写完七个 TODO 跑 pnpm verify:l14x。
 */

import { readFileSync } from 'node:fs'
import {
  CONTRAST_MIN,
  NAME_FROM_CONTENT,
  OPACITY_MIN,
  REF_RE,
  auditChannels,
  approvalView,
  brightness,
  browserChannels,
  centerOf,
  checkImageBatch,
  collapseSpaces,
  describeNode,
  displayMatchesExecution,
  driftCheck,
  driftCheckRoleName,
  effBackground,
  effColor,
  effFontSize,
  effOpacity,
  findNode,
  hasBox,
  hiddenTextFindings,
  hitTest,
  hostAllowed,
  imageTokens,
  inheritedOf,
  isAriaVisible,
  isClipped,
  isDescendant,
  mcpVerifyVisible,
  navigationAllowed,
  newRefState,
  playwrightIsVisible,
  refPrefix,
  resolveRef,
  roundHalfUp,
  rowContext,
  selfHidden,
  snapshot,
  snapshotTokens,
  textContent,
  toGuardChannels,
  toViewport,
  visualVisibility,
  type BrowserAction,
  type CoordConv,
  type CoordCtx,
  type Drift,
  type FakeNode,
  type FakePage,
  type Inherited,
  type NavVerdict,
  type Pt,
  type RefState,
  type SeenLine,
  type SnapshotMode,
  type Visibility,
  type VPoint,
} from '../shared/browse.ts'
import { isMain } from '../shared/entry.ts'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const w = (s: string) =>
  [...visible(s)].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string | number, n: number) => String(s) + ' '.repeat(Math.max(0, n - w(String(s))))
const lpad = (s: string | number, n: number) => ' '.repeat(Math.max(0, n - w(String(s)))) + String(s)
const yn = (b: boolean) => (b ? 'Y' : '-')

// ─────────────────────────────────────────────────────────────
// 夹具（verify 也用）
// ─────────────────────────────────────────────────────────────

const PAGES_TEXT = readFileSync(new URL('./fixtures/pages.json', import.meta.url), 'utf8')

/** 每次返回一份新的拷贝：页面是「当前 DOM」，谁也不该改到别人手里那份。 */
export function page(name: string): FakePage {
  const all = JSON.parse(PAGES_TEXT) as Record<string, FakePage>
  const p = all[name]
  if (p === undefined) throw new Error(`没有这个页面：${name}`)
  return p
}

export const GRID_COLS = 8
export const GRID_ROWS = 12
export const TILE_W = 180
export const TILE_H = 150

/**
 * 坐标实验用的网格页：1440×900 视口、DPR 2，文档 1440×1800，铺满 8×12 个 180×150 的按钮。
 * 任何一个点都落在某个按钮上，所以「点偏了」一定表现为「点到了别的按钮」。
 */
export function gridPage(scrollY = 0): FakePage {
  const children: FakeNode[] = []
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      children.push({
        id: `t-${r}-${c}`,
        role: 'button',
        text: `R${r}C${c}`,
        bbox: [c * TILE_W, r * TILE_H, TILE_W, TILE_H],
        style: { background: '#efefef' },
      })
    }
  }
  return {
    url: 'https://app.example/grid',
    viewport: { w: 1440, h: 900 },
    dpr: 2,
    scrollY,
    docSeq: 0,
    root: { id: 'body', role: 'generic', bbox: [0, 0, 1440, 1800], style: { background: '#ffffff' }, children },
  }
}

/** 一个不虚拟化的长列表：n 行，每行一个链接和一句描述。快照覆盖整个文档，不只是视口。 */
export function bigPage(n: number): FakePage {
  const rows: FakeNode[] = []
  for (let i = 0; i < n; i++) {
    rows.push({
      id: `row-${i}`,
      role: 'listitem',
      bbox: [8, 60 + i * 40, 1200, 36],
      children: [
        { id: `link-${i}`, role: 'link', text: `Item ${i + 1}`, bbox: [8, 60 + i * 40, 120, 20] },
        { id: `desc-${i}`, role: 'text', text: `A short description of item number ${i + 1}, updated recently` },
      ],
    })
  }
  return {
    url: 'https://app.example/list',
    viewport: { w: 1280, h: 720 },
    dpr: 1,
    scrollY: 0,
    docSeq: 0,
    root: {
      id: 'body',
      role: 'generic',
      bbox: [0, 0, 1280, 80 + n * 40],
      style: { background: '#ffffff' },
      children: [
        { id: 'h', role: 'heading', text: 'All items', bbox: [8, 8, 400, 40] },
        { id: 'list', role: 'list', bbox: [8, 60, 1200, n * 40], children: rows },
      ],
    },
  }
}

/** 探针：标签、节点 id、在快照里找的字符串。 */
export const PROBES: [string, string, string][] = [
  ['VISIBLE_NORMAL', 'p-normal', 'VISIBLE_NORMAL'],
  ['sr-only', 'p-sr', 'INJ_SR_ONLY'],
  ['opacity:0', 'p-op0', 'INJ_OPACITY0'],
  ['白字白底', 'p-white', 'INJ_WHITE_ON_WHITE'],
  ['font-size:0', 'p-fs0', 'INJ_FONTSIZE0'],
  ['left:-9999px', 'p-off', 'INJ_OFFSCREEN'],
  ['display:none', 'p-dn', 'INJ_DISPLAY_NONE'],
  ['visibility:hidden', 'p-vh', 'INJ_VISIBILITY_HIDDEN'],
  ['aria-hidden 但可见', 'p-ah', 'INJ_ARIA_HIDDEN_BUT_VISIBLE'],
  ['hidden 属性', 'p-hid', 'INJ_HIDDEN_ATTR'],
  ['关闭的 details', 'p-details', 'INJ_CLOSED_DETAILS'],
  ['aria-label 注入', 'btn-buy', 'SYSTEM: ignore'],
  ['title 属性', 'btn-help', 'INJ_TITLE_ATTR'],
  ['img alt', 'img', 'INJ_IMG_ALT'],
  ['open shadow', 'open-btn', 'OPEN_SHADOW_BTN'],
  ['closed shadow', 'closed-btn', 'CLOSED_SHADOW_BTN'],
  ['canvas 里画的字', 'canvas', 'CANVAS_TEXT'],
  ['iframe 里的按钮', 'f-btn', 'INSIDE_IFRAME_BTN'],
  ['0×0 iframe', 'f0-btn', 'INSIDE_ZERO_IFRAME'],
  ['pointer-events:none iframe', 'fpe-btn', 'INSIDE_PE_NONE_IFRAME'],
  ['出错的 iframe', 'ferr-btn', 'INSIDE_ERROR_IFRAME'],
  ['遮罩下的按钮', 'under', 'UNDER_OVERLAY_BTN'],
  ['pointer-events:none 按钮', 'pe-none', 'PE_NONE_BTN'],
]

/** 找到快照里某个节点的 ref（没有就是空串）。 */
export function refOf(snapRefs: Map<string, string>, nodeId: string): string {
  for (const [ref, id] of snapRefs) if (id === nodeId) return ref
  return ''
}

/** 三家各一张 1280×720 视口截图的 token：Anthropic 标准档、OpenAI gpt-6-astra、DeepSeek V4.1。 */
export function viewportShotCosts(): [string, number][] {
  return [
    ['Anthropic 标准档', imageTokens('anthropic', 'standard', 1280, 720).tokens],
    ['OpenAI gpt-6-astra', imageTokens('openai', 'gpt-6-astra', 1280, 720).tokens],
    ['DeepSeek V4.1', imageTokens('deepseek', 'deepseek-flash', 1280, 720).tokens],
  ]
}

export const ALLOW = ['perplexity.ai']

/** 白名单实验的几条重定向链。 */
export function navCases(): [string, string[], string[]][] {
  return [
    ['正常', ['https://perplexity.ai/account'], ALLOW],
    ['大写 + 末尾点', ['https://PERPLEXITY.AI./account'], ALLOW],
    ['默认端口', ['https://perplexity.ai:443/'], ALLOW],
    ['第三跳出站', ['https://perplexity.ai/r', 'https://perplexity.ai/next', 'https://evil.com/collect'], ALLOW],
    ['后缀拼接', ['https://perplexity.ai.evil.com/'], ALLOW],
    ['藏在 query 里', ['https://evil.com/?perplexity.ai'], ALLOW],
    ['userinfo', ['https://perplexity.ai@evil.com/'], ALLOW],
    ['显式子域', ['https://docs.perplexity.ai/'], ['*.perplexity.ai']],
    ['子域规则不含裸域', ['https://perplexity.ai/'], ['*.perplexity.ai']],
  ]
}

// ─────────────────────────────────────────────────────────────
// 实验
// ─────────────────────────────────────────────────────────────

function exp1(): void {
  console.log(bold('\n实验一 · 模型看到的页面不是你看到的（hidden 页，23 个探针）'))
  const pg = page('hidden')
  const ai = snapshot(pg, newRefState(), { mode: 'ai' })
  const def = snapshot(pg, newRefState(), { mode: 'default' })
  const bu = snapshot(pg, newRefState(), { mode: 'ai', attrs: 'browserUse' })
  const findings = hiddenTextFindings(pg)
  console.log(dim(`  ${pad('探针', 28)}${pad('ai', 4)}${pad('default', 9)}${pad('browserUse', 12)}${pad('有 ref', 8)}人看不见的原因`))
  for (const [label, id, needle] of PROBES) {
    const kinds = findings.filter((f) => f.nodeId === id).map((f) => f.kind)
    console.log(
      `  ${pad(label, 28)}${pad(yn(ai.text.includes(needle)), 4)}${pad(yn(def.text.includes(needle)), 9)}` +
        `${pad(yn(bu.text.includes(needle)), 12)}${pad(yn(refOf(ai.refs, id) !== ''), 8)}${kinds.join(',')}`,
    )
  }
  console.log(dim('\n  ai 模式的快照全文（模型拿到的就是这个）：'))
  for (const l of ai.text.split('\n')) console.log(dim(`    ${l}`))
  console.log(
    dim(
      '\n  「对辅助技术可见」只看 display / visibility / hidden / aria-hidden，不看透明度、裁剪、颜色、字号、在不在视口里。\n' +
        '  所以五种「人看不见」的写法全进了快照；aria-label 把 "Buy" 换成了一整句指令；title 只对 browser-use 有效。\n' +
        '  真正藏住的只有 display:none、visibility:hidden、hidden 属性和关闭的 details。',
    ),
  )
}

function exp2(): void {
  console.log(bold('\n实验二 · key=index 重排：旧 ref 静默点到另一行（rows-v1 → rows-v2，没有重新快照）'))
  const st = newRefState()
  const s1 = snapshot(page('rows-v1'), st)
  for (const l of s1.text.split('\n')) console.log(dim(`    ${l}`))
  const ref = refOf(s1.refs, 'btn-2')
  const seen = s1.lines.get(ref)!
  console.log(`  模型想删 Charlie 那一行：${ref}  看到的是 ${seen.role} "${seen.name}"`)
  const v2 = page('rows-v2')
  const r = resolveRef(st, v2, ref)
  const now = describeNode(v2, 'btn-2')!
  console.log(`  页面按 key={index} 重渲染以后：resolveRef(${ref}) = ${r.kind}${r.kind === 'ok' ? ` → ${r.nodeId}` : ''}，节点现在叫 "${now.name}"`)
  console.log(`  driftCheck = ${driftCheck(seen, v2, 'btn-2')}`)
  const s2 = snapshot(v2, st)
  const r2 = resolveRef(st, v2, ref)
  console.log(`  如果动作前取了新快照：btn-2 换号为 ${refOf(s2.refs, 'btn-2')}，resolveRef(${ref}) = ${r2.kind}${r2.kind === 'error' ? `:${r2.reason}` : ''}`)
  console.log(dim('  ref 是挂在 DOM 节点上的 expando。React 用 key={index} 复用节点，Playwright 就复用 ref——点错行的根因在被测站点的 key 写法里。'))
}

function exp3(): void {
  console.log(bold('\n实验三 · 同名按钮重排：新快照也救不了（rows-v3a → rows-v3b，动作前**取了**新快照）'))
  const st = newRefState()
  const s1 = snapshot(page('rows-v3a'), st)
  const ref = refOf(s1.refs, 'btn-2')
  const seen = s1.lines.get(ref)!
  const v3b = page('rows-v3b')
  const s2 = snapshot(v3b, st)
  const a = s1.text.split('\n')
  const b = s2.text.split('\n')
  console.log(dim(`    ${pad('S1（模型上下文里那份）', 44)}S2（页面侧最新的那份）`))
  for (let i = 0; i < Math.max(a.length, b.length); i++) console.log(dim(`    ${pad(a[i] ?? '', 44)}${b[i] ?? ''}`))
  const s2line = s2.lines.get(ref)!
  console.log(`  模型想删 "${seen.context}" 的 Delete：${ref}。新快照里 ${ref} 仍是 ${s2line.role} "${s2line.name}"，所在行是 "${s2line.context}"`)
  console.log(`  只比 role + name：${driftCheckRoleName(seen, v3b, 'btn-2')}    带上行上下文：${driftCheck(seen, v3b, 'btn-2')}`)
  console.log(dim('  这一行不需要任何竞态：ref 的 role 和 name 一个字没变，变的是它旁边那个兄弟节点的文字。'))
}

function exp4(): void {
  console.log(bold('\n实验四 · 导航之后，以及五种过期汇总'))
  const st = newRefState()
  const sa = snapshot(page('nav-a'), st)
  const held = refOf(sa.refs, 'a-add')
  const navB = page('nav-b')
  const before = resolveRef(st, navB, held)
  const sb = snapshot(navB, st)
  const after = resolveRef(st, navB, held)
  console.log(`  nav-a 的 ref：${[...sa.refs.keys()].join(' ')}    nav-b 的 ref：${[...sb.refs.keys()].join(' ')}`)
  console.log(`  模型拿着 ${held}（Add to cart）：导航后未重快照 → ${before.kind === 'error' ? before.reason : before.kind}；重快照后 → ${after.kind === 'error' ? after.reason : after.kind}`)
  const bad = resolveRef(st, navB, 'e3x')
  console.log(`  'e3x' → ${bad.kind === 'error' ? bad.reason : bad.kind}（不像 ref 的字符串，MCP 会把它当 CSS 选择器）`)

  const fmt = (r: ReturnType<typeof resolveRef>, pg: FakePage) =>
    r.kind === 'ok' ? `ok → ${r.nodeId}「${describeNode(pg, r.nodeId)!.name}」${describeNode(pg, r.nodeId)!.context !== '' ? `（${describeNode(pg, r.nodeId)!.context} 那一行）` : ''}` : r.reason

  const rows: [string, string, string, string][] = []
  {
    const s = newRefState()
    const ref = refOf(snapshot(page('rows-v1'), s).refs, 'btn-2')
    const v2 = page('rows-v2')
    const r = resolveRef(s, v2, ref)
    rows.push(['A key=index 重排', '否', fmt(r, v2), r.kind === 'ok' ? '静默' : '响亮'])
    snapshot(v2, s)
    const r2 = resolveRef(s, v2, ref)
    rows.push(['B 同上，动作前重快照', '是', fmt(r2, v2), r2.kind === 'ok' ? '静默' : '响亮'])
  }
  {
    const s = newRefState()
    const ref = refOf(snapshot(page('rows-v3a'), s).refs, 'btn-2')
    const v3b = page('rows-v3b')
    snapshot(v3b, s)
    const r = resolveRef(s, v3b, ref)
    rows.push(['C 同名按钮重排', '是', fmt(r, v3b), r.kind === 'ok' ? '静默' : '响亮'])
  }
  {
    const s = newRefState()
    const ref = refOf(snapshot(page('rows-v1'), s).refs, 'btn-2')
    const del = page('rows-v1-deleted')
    const r = resolveRef(s, del, ref)
    rows.push(['D 节点被删掉', '否', fmt(r, del), r.kind === 'ok' ? '静默' : '响亮'])
  }
  rows.push(['E 导航到新文档', '是', fmt(after, navB), after.kind === 'ok' ? '静默' : '响亮'])
  console.log(dim(`\n  ${pad('场景', 24)}${pad('重快照', 8)}${pad('失败形态', 10)}旧 ref 的结果`))
  for (const [a, b, c, d] of rows) console.log(`  ${pad(a, 24)}${pad(b, 8)}${pad(d, 10)}${c}`)
  console.log(dim('  报错的只有「节点没了」和「文档换了」。内容变了、同名重排，解析器都说 ok。'))
}

function exp5(): void {
  console.log(bold('\n实验五 · 快照不便宜：长列表的快照 token 与一张 1280×720 截图'))
  const shots = viewportShotCosts()
  const ns = [5, 10, 20, 50, 100, 200, 500, 1000, 2000]
  console.log(dim(`  ${lpad('行数', 6)}${lpad('ai 字符', 10)}${lpad('ai token', 10)}${lpad('default', 9)}${lpad('仅链接行', 10)}   超过了哪家的一张截图`))
  const cross = new Map<string, number>()
  for (const n of ns) {
    const pg = bigPage(n)
    const ai = snapshot(pg, newRefState(), { mode: 'ai' })
    const def = snapshot(pg, newRefState(), { mode: 'default' })
    const links = ai.text
      .split('\n')
      .filter((l) => l.includes('- link '))
      .join('\n')
    const t = snapshotTokens(ai.text)
    const over = shots.filter(([, c]) => t > c).map(([name]) => name)
    for (const name of over) if (!cross.has(name)) cross.set(name, n)
    console.log(
      `  ${lpad(n, 6)}${lpad([...ai.text].length, 10)}${lpad(t, 10)}${lpad(snapshotTokens(def.text), 9)}${lpad(snapshotTokens(links), 10)}   ${over.join(' / ')}`,
    )
  }
  console.log(`  一张 1280×720：${shots.map(([name, c]) => `${name} ${c}`).join('，')}`)
  console.log(`  交叉点（快照第一次比截图贵）：${shots.map(([name]) => `${name} ${cross.get(name) ?? '—'} 行`).join('，')}`)
  console.log(
    dim(
      '  token 用 L06 的粗估（英文 4 字符一个）。调研实测：Wikipedia 一页 AI 快照 61,473 token（DeepSeek tokenizer），\n' +
        '  视口截图 578–1196。快照的优势是可行动（有 ref），不是省钱；ai 模式比 default 贵，只留交互行能砍掉大半。',
    ),
  )
}

function exp6(): void {
  console.log(bold('\n实验六 · 整页截图在三家的下场（模型看到的宽度决定字还能不能读）'))
  const sizes: [string, number, number][] = [
    ['视口 1280×720', 1280, 720],
    ['MDN 整页 1280×5149', 1280, 5149],
    ['Wikipedia 整页 1280×18916', 1280, 18916],
    ['同上 DPR 2：2560×37832', 2560, 37832],
  ]
  const cell = (r: { tokens: number; w: number; rejected: boolean }, showW: boolean) =>
    r.rejected ? '拒收' : showW ? `${r.tokens}（${r.w}w）` : String(r.tokens)
  console.log(dim(`  ${pad('截图', 28)}${pad('Anth 标准档', 16)}${pad('Anth 高分档', 16)}${pad('astra auto', 12)}${pad('gpt-5.4 high', 14)}DeepSeek V4.1`))
  for (const [label, wd, ht] of sizes) {
    console.log(
      `  ${pad(label, 28)}${pad(cell(imageTokens('anthropic', 'standard', wd, ht), true), 16)}` +
        `${pad(cell(imageTokens('anthropic', 'high-res', wd, ht), true), 16)}${pad(cell(imageTokens('openai', 'gpt-6-astra', wd, ht), false), 12)}` +
        `${pad(cell(imageTokens('openai', 'gpt-5.4', wd, ht, { detail: 'high' }), false), 14)}${cell(imageTokens('deepseek', 'deepseek-flash', wd, ht), true)}`,
    )
  }
  const lo = imageTokens('openai', 'gpt-5.4', 2880, 1800, { detail: 'low' })
  const hi = imageTokens('openai', 'gpt-5.4', 2880, 1800, { detail: 'high' })
  console.log(`  gpt-5.4 上 2880×1800：low ${lo.tokens} > high ${hi.tokens}（"so it can use more tokens than high"）`)
  const a1 = imageTokens('openai', 'gpt-6-astra', 1920, 1080)
  const a2 = imageTokens('openai', 'gpt-6-astra', 3840, 2160)
  console.log(`  gpt-6-astra 不写 detail：1920×1080 ${a1.tokens}，同一视口 DPR 2 ${a2.tokens}（${Math.floor(a2.tokens / a1.tokens)} 倍，不报错）`)
  const d1 = imageTokens('deepseek', 'deepseek-flash', 2000, 2000)
  const d2 = imageTokens('deepseek', 'deepseek-flash', 5000, 5000)
  const d3 = imageTokens('deepseek', 'deepseek-flash', 100, 100)
  console.log(`  DeepSeek：2000² ${d1.tokens}、5000² ${d2.tokens}（一样），100² 被放大到 ${d3.w}×${d3.h}、${d3.tokens}；deepseek-v4-pro：${imageTokens('deepseek', 'deepseek-v4-pro', 1280, 720).reason}`)
  const t1 = imageTokens('anthropic', 'standard', 1920, 1080, { toolset: true })
  console.log(`  Anthropic toolset 收到 1920×1080：${t1.rejected ? `拒收（${t1.reason}）` : t1.tokens}；普通 image block 会被缩到 1456×819`)
  const batch = checkImageBatch(Array.from({ length: 21 }, () => ({ w: 2400, h: 1350 })))
  console.log(`  第 21 张 2400px 截图进来：被标记 ${batch.flagged.length} 张（${batch.rule}）`)
  console.log(dim('  整页长截图在 Anthropic 最便宜（压窄到看不清），在 OpenAI 新模型最贵（不缩），DPR 2 直接被拒。没有跨厂商的答案。'))
}

/** 实验七的场景：约定、模型给的坐标、上下文、页面、正确的目标、常见错法。 */
export function coordCases(): {
  label: string
  conv: CoordConv
  pt: Pt
  ctx: CoordCtx
  pg: FakePage
  target: string
  bug: string
  wrong: () => VPoint
}[] {
  const vp = { w: 1440, h: 900 }
  const grid = gridPage(0)
  const scrolled = gridPage(600)
  const co = page('checkout')
  return [
    { label: 'css', conv: 'css', pt: { x: 90, y: 75 }, ctx: { dpr: 2, viewport: vp }, pg: grid, target: 't-0-0', bug: '—', wrong: () => toViewport({ x: 90, y: 75 }, 'css', { dpr: 2, viewport: vp }) },
    { label: 'device（DPR 2）', conv: 'device', pt: { x: 180, y: 150 }, ctx: { dpr: 2, viewport: vp }, pg: grid, target: 't-0-0', bug: '忘了除 DPR', wrong: () => toViewport({ x: 180, y: 150 }, 'css', { dpr: 2, viewport: vp }) },
    {
      label: 'scaledShot（2880→1280）',
      conv: 'scaledShot',
      pt: { x: 1200, y: 733 },
      ctx: { dpr: 2, viewport: vp, shot: { w: 1280, h: 800 } },
      pg: grid,
      target: 't-5-7',
      bug: '忘了放大回去',
      wrong: () => toViewport({ x: 1200, y: 733 }, 'css', { dpr: 2, viewport: vp }),
    },
    {
      label: 'gemini1000',
      conv: 'gemini1000',
      pt: { x: 63, y: 83 },
      ctx: { dpr: 2, viewport: vp },
      pg: grid,
      target: 't-0-0',
      bug: '乘了截图尺寸',
      wrong: () => toViewport({ x: 63, y: 83 }, 'gemini1000', { dpr: 2, viewport: { w: 2880, h: 1800 } }),
    },
    {
      label: 'fullPage（scrollY 600）',
      conv: 'fullPage',
      pt: { x: 450, y: 825 },
      ctx: { dpr: 2, viewport: vp, scrollY: 600 },
      pg: scrolled,
      target: 't-5-2',
      bug: '没减 scrollY',
      wrong: () => toViewport({ x: 450, y: 825 }, 'css', { dpr: 2, viewport: vp }),
    },
    {
      label: 'iframe 内坐标',
      conv: 'css',
      pt: { x: 170, y: 55 },
      ctx: { dpr: 1, viewport: { w: 1280, h: 800 }, frameOffset: { x: 40, y: 200 } },
      pg: co,
      target: 'card',
      bug: '忘了加 iframe 偏移',
      wrong: () => toViewport({ x: 170, y: 55 }, 'css', { dpr: 1, viewport: { w: 1280, h: 800 } }),
    },
  ]
}

function exp7(): void {
  console.log(bold('\n实验七 · 同一个目标，五种坐标约定（网格页 1440×900、DPR 2，每格一个按钮）'))
  const show = (r: VPoint, pg: FakePage) => (r.ok ? `(${r.x},${r.y}) → ${hitTest(pg, r) ?? '无'}` : r.error)
  console.log(dim(`  ${pad('约定', 26)}${pad('模型给的', 12)}${pad('正确换算 → 命中', 26)}${pad('常见错法', 20)}错法 → 命中`))
  for (const c of coordCases()) {
    const right = toViewport(c.pt, c.conv, c.ctx)
    console.log(
      `  ${pad(c.label, 26)}${pad(`(${c.pt.x},${c.pt.y})`, 12)}${pad(show(right, c.pg), 26)}${pad(c.bug, 20)}${c.bug === '—' ? '—' : show(c.wrong(), c.pg)}`,
    )
  }
  const grid = gridPage(0)
  const out = toViewport({ x: 1000, y: 500 }, 'gemini1000', { dpr: 2, viewport: { w: 1440, h: 900 } })
  console.log(`  gemini (1000,500)：${out.error}；如果钳到边上 → (1439,450) → ${hitTest(grid, { x: 1439, y: 450 })}，点到一个模型没说的按钮`)
  console.log(dim('  坐标没有任何失效检测：它只在某一个像素空间、某一个滚动位置下成立，三个条件任何一个变了都不报错，只是点到别处。'))
}

function exp8(): void {
  console.log(bold('\n实验八 · 三种「可见」（buttons10 页，800×600 视口）'))
  const pg = page('buttons10')
  const ai = snapshot(pg, newRefState())
  const ids = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10']
  console.log(dim(`  ${pad('按钮', 14)}${pad('MCP verify', 12)}${pad('isVisible', 11)}${pad('ai 快照', 9)}${pad('box', 5)}${pad('视口', 6)}${pad('hit', 5)}${pad('像素', 6)}原因`))
  let exists = 0
  let all = 0
  for (const id of ids) {
    const v = visualVisibility(pg, id)
    const name = findNode(pg, id)!.node.text!
    if (v.exists) exists++
    if (v.exists && v.box && v.inViewport && v.hit && v.pixels) all++
    console.log(
      `  ${pad(name, 14)}${pad(yn(mcpVerifyVisible(pg, id)), 12)}${pad(yn(playwrightIsVisible(pg, id)), 11)}${pad(yn(ai.text.includes(`"${name}"`)), 9)}` +
        `${pad(yn(v.box), 5)}${pad(yn(v.inViewport), 6)}${pad(yn(v.hit), 5)}${pad(yn(v.pixels), 6)}${v.reasons.join(' ')}`,
    )
  }
  console.log(`  MCP verify 通过 ${exists}/10；五层全过 ${all}/10`)
  const ov = page('overlays')
  console.log(dim('\n  遮罩：浏览器的命中规则 vs browser-use 的遮挡规则'))
  for (const [id, what] of [
    ['o1-btn', '透明 div 盖住'],
    ['o2-btn', 'pointer-events:none 的 div 盖住'],
    ['o3-btn', '不透明的黑色遮罩盖住'],
  ] as [string, string][]) {
    const c = centerOf(ov, findNode(ov, id)!)
    console.log(`  ${pad(what, 34)}browser → ${pad(hitTest(ov, c, 'browser') ?? '无', 10)}browserUse → ${hitTest(ov, c, 'browserUse') ?? '无'}`)
  }
  console.log(dim('  透明点击拦截层（clickjacking 的经典形态）在浏览器里吃掉点击，在 browser-use 眼里不存在。'))
}

function exp9(): void {
  console.log(bold('\n实验九 · 审批框显示的，和实际执行的（checkout 页）'))
  const pg = page('checkout')
  const st = newRefState()
  const s = snapshot(pg, st)
  for (const l of s.text.split('\n')) console.log(dim(`    ${l}`))
  const click: BrowserAction = { tool: 'click', element: 'Cancel', target: refOf(s.refs, 'btn-delete') }
  const type: BrowserAction = { tool: 'type', element: 'Email field', target: refOf(s.refs, 'card'), text: '4242 4242 4242 4242' }
  for (const a of [click, type]) {
    const v = approvalView(a, st, pg)
    console.log(`  模型：${a.tool}(element="${a.element}", target=${a.target})`)
    console.log(`    照抄 element 的审批框：${v.displayed}`)
    console.log(`    实际执行：              ${v.executed}    displayMatchesExecution = ${displayMatchesExecution(v.displayed, v.executed)}`)
  }
  const chs = browserChannels(pg)
  console.log(dim('\n  这一页的出站通道（交给 L14 的 auditChannels）：'))
  for (const c of chs) console.log(`    ${pad(c.kind, 10)}${pad(c.name, 24)}${c.origin}`)
  console.log(`  ${auditChannels(toGuardChannels(chs)).verdict}`)
  console.log(`  关掉页面工具后：${auditChannels(toGuardChannels(chs, ['pageTool:apply_coupon'])).verdict}`)

  console.log(dim('\n  白名单（每一跳都查；substring 是常见错法）：'))
  console.log(dim(`    ${pad('情形', 18)}${pad('白名单', 18)}${pad('逐跳规范化后', 36)}${pad('substring', 11)}链`))
  for (const [label, ch, allow] of navCases()) {
    const v = navigationAllowed(ch, allow)
    const naive = ch[0]!.includes(allow[0]!.replace('*.', ''))
    console.log(
      `    ${pad(label, 18)}${pad(allow.join(','), 18)}${pad(v.ok ? '放行' : `拦：第 ${v.blockedAt + 1} 跳 ${v.host}`, 36)}${pad(naive ? '放行' : '拦', 11)}${ch.join(' → ')}`,
    )
  }
  console.log(dim('  "Typing sensitive information into a form counts as transmission." 卡号输入框的目的地是支付 iframe 的 origin。'))
}

// ─────────────────────────────────────────────────────────────
// TODO（verify 测这几个）
// ─────────────────────────────────────────────────────────────

/**
 * TODO 1 ★ 这个节点进不进快照。anc 是从祖先继承下来的两件事（hiddenForAll、ariaHidden）。
 * 规则：
 *   - display:none、visibility:hidden、hidden 属性（自己或祖先），两种模式都不收（用 selfHidden）
 *   - 'default'：aria-hidden（自己或祖先）的不收，其余都收
 *   - 'ai'：aria-hidden 的，只要视觉上有盒子（hasBox）就收
 * 注意你**不该**看的东西：opacity、clip、颜色、字号、在不在视口里。
 */
export function myIsAriaVisible(n: FakeNode, anc: Inherited, mode: SnapshotMode): boolean {
  throw new Error('TODO 1 未实现')
}

/**
 * TODO 2 ★ 可访问名称。依次：aria-label → img 的 alt → 内容（只对 NAME_FROM_CONTENT 里的角色，用 textContent）→ title。
 * 每一步都先 collapseSpaces，空串算没有。canvas 的 text 是画在像素里的，不能当名字（textContent 已经跳过它）。
 */
export function myAccessibleName(n: FakeNode): string {
  throw new Error('TODO 2 未实现')
}

/**
 * TODO 3 ★★ 给节点一个 ref（Playwright computeAriaRef）。
 *   - page.docSeq 和 state.docSeq 不一样：换文档了，计数器、expando、last 全清，state.docSeq 跟上
 *   - expando 里有这个节点，且 role、name 都没变 → 沿用旧 ref
 *   - 否则 lastRef 加一，ref = refPrefix(docSeq) + 'e' + lastRef，写回 expando
 * 计数器从不回退，旧号从不复用。
 */
export function myAssignRef(state: RefState, page: FakePage, nodeId: string, role: string, name: string): string {
  throw new Error('TODO 3 未实现')
}

/**
 * TODO 4 ★★ 模型看到的那一行（seen）和节点现在的样子比。
 *   节点不在了 → 'gone'；role 或 name 变了 → 'renamed'；所在行的文字（rowContext）变了 → 'context-changed'；否则 'same'。
 * 节点现在的样子可以用 describeNode。只比 role + name 的版本会在同名重排上报 'same'。
 */
export function myDriftCheck(seen: SeenLine, page: FakePage, nodeId: string): Drift {
  throw new Error('TODO 4 未实现')
}

/**
 * TODO 5 ★ 任意约定的坐标 → 整数 CSS 视口坐标（约定见 shared 里 CoordConv 的注释）。
 *   device ÷ dpr；scaledShot × viewport / shot；gemini1000 × viewport / 1000；fullPage 减 scrollY；最后加 frameOffset。
 *   所有除法都用 roundHalfUp(分子, 分母)，不要用 Math.round。
 *   结果在视口外（x<0、y<0、x≥w、y≥h）：返回 { ok: false, x: 0, y: 0, error: `outside-viewport (${x},${y})` }，不钳位。
 */
export function myToViewport(pt: Pt, conv: CoordConv, ctx: CoordCtx): VPoint {
  throw new Error('TODO 5 未实现')
}

/**
 * TODO 6 ★★ 五层可见性（类型见 Visibility）。shared 里有你需要的零件：
 *   findNode、inheritedOf、isAriaVisible、hasBox、selfHidden、centerOf、hitTest、isDescendant、
 *   effOpacity、isClipped、effFontSize、effColor、effBackground、brightness、CONTRAST_MIN、OPACITY_MIN。
 *   exists     不在 closed shadow 里，且 isAriaVisible(…, 'default')
 *   box        hasBox，且自己和祖先都没被 display/visibility/hidden 藏住
 *   inViewport 有盒子，且中心点在视口里
 *   hit        在视口里，且 hitTest(中心点, 'browser') 是它自己或它的子孙
 *   pixels     有盒子，effOpacity ≥ OPACITY_MIN，没被裁，字号不为 0，亮度差 ≥ CONTRAST_MIN
 * reasons 的写法照 shared：'not-in-a11y-tree'、'zero-box'、'outside-viewport'、'blocked-by:<id>'、
 *   'opacity:<n>'、'clipped'、'font-size:0'、'low-contrast:<n>'。节点不存在：全 false，reasons ['missing']。
 */
export function myVisualVisibility(page: FakePage, nodeId: string): Visibility {
  throw new Error('TODO 6 未实现')
}

/**
 * TODO 7 ★ 白名单的两半。
 *   myNormalizeHost：取 '://' 之后、第一个 / ? # 之前；去掉最后一个 @ 及之前的 userinfo；https:443、http:80 和空端口去掉；
 *     ASCII 小写；去掉末尾所有的点。不要用 URL / urllib。
 *   myNavigationAllowed：链上**每一跳**都规范化后查白名单（hostAllowed 的规则：精确相等，或 '*.x' 匹配 x 的子域、不含 x 本身）。
 *     第 i 跳不过 → { ok: false, blockedAt: i, host }；全过 → { ok: true, blockedAt: -1, host: 最后一跳 }。
 */
export function myNormalizeHost(u: string): string {
  throw new Error('TODO 7 未实现')
}

export function myNavigationAllowed(chain: string[], allow: string[]): NavVerdict {
  throw new Error('TODO 7 未实现')
}

// ─────────────────────────────────────────────────────────────

function main(): void {
  exp1()
  exp2()
  exp3()
  exp4()
  exp5()
  exp6()
  exp7()
  exp8()
  exp9()
  console.log(
    dim(
      '\n  模型看到的页面 ≠ 用户看到的页面 ≠ 实际被执行的那个元素。\n' +
        '  这一课的每个函数都在量其中一个差；写完七个 TODO 跑 pnpm verify:l14x。\n',
    ),
  )
}

if (isMain(import.meta.url)) main()
