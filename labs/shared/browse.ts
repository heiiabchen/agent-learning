/**
 * 参考实现：浏览器 agent 的感知层——快照、ref、坐标、可见性、图片 token、浏览器特有的 sink。
 *
 * 这一课的主线只有一句：
 *   **模型看到的页面 ≠ 用户看到的页面 ≠ 实际被执行的那个元素。**
 * 下面每一个函数都在量其中一个差。
 *
 * 不起浏览器、不调模型、不引新依赖。输入是手写的「假页面」（l14x/fixtures/pages.json），
 * 规则是对 Playwright 1.64 注入脚本、Playwright MCP 0.0.83、browser-use 0.13.11 和三家厂商文档的
 * 可读重写，出处标在注释里（§ 是 research/L14x-browser-multimodal.md 的章节号）。
 *
 * ★ 两门语言逐字节一致：打印出来的数全是整数；四舍五入只用 roundHalfUp（整数运算）——
 *   Python 的 round(2.5) 是 2，JS 的 Math.round(2.5) 是 3。
 */

import { estimateTokens } from './context.ts'
import { auditChannels, displayMatchesExecution, type Channel, type ChannelReport } from './guard.ts'

export { auditChannels, displayMatchesExecution, estimateTokens }
export type { Channel, ChannelReport }

// ─────────────────────────────────────────────────────────────
// 一、假页面
// ─────────────────────────────────────────────────────────────

/** [x, y, w, h]：CSS 像素、整数。顶层节点是文档坐标；iframe 里的节点相对 iframe 自己的左上角。 */
export type Rect = [number, number, number, number]

export interface NodeStyle {
  display?: 'none'
  visibility?: 'hidden'
  /** 0..100 的整数，避免浮点。 */
  opacity?: number
  /** '#rrggbb' */
  color?: string
  /** '#rrggbb' | 'transparent' */
  background?: string
  fontSize?: number
  pointerEvents?: 'none'
  /** transform: scale(0) 之类：DOM 里有尺寸，渲染出来是 0×0。 */
  zeroBox?: boolean
  /** clip / clip-path 把它裁没了（sr-only 就是这一类）。 */
  clip?: boolean
  /** position: fixed：坐标是视口坐标，不随滚动。 */
  fixed?: boolean
}

export interface FakeNode {
  /** 节点身份。Playwright 把 ref 挂在 DOM 节点的 expando 上，这里用 id 模拟「同一个 DOM 节点」。 */
  id: string
  role: string
  /** 节点自带的文字。canvas 的 text 表示「画在像素里的字」，不在 DOM 里。 */
  text?: string
  ariaLabel?: string
  title?: string
  alt?: string
  ariaHidden?: boolean
  hiddenAttr?: boolean
  /** 关闭的 <details>：除了 summary，子节点都藏住。 */
  detailsClosed?: boolean
  style?: NodeStyle
  bbox?: Rect
  /** 绘制顺序，hit-test 用；不写继承祖先，默认 0。 */
  z?: number
  children?: FakeNode[]
  shadow?: { mode: 'open' | 'closed'; children: FakeNode[] }
  /** iframe 的内容。iframe 自己的 bbox 就是它在父文档里的位置。 */
  frame?: { origin: string; children: FakeNode[]; error?: boolean }
}

export interface FakePage {
  url: string
  viewport: { w: number; h: number }
  dpr: number
  scrollY: number
  /** 导航计数：模拟 Playwright 注入脚本的 _frameSeq，决定 ref 前缀 f<n>。首次加载是 0。 */
  docSeq: number
  root: FakeNode
  webmcpTools?: { name: string; description: string }[]
}

/** walk() 的一项：节点和它在页面里的位置。 */
export interface Located {
  node: FakeNode
  /** 祖先，从 root 开始，不含自己。iframe 节点也算祖先。 */
  path: FakeNode[]
  /** 所在 frame 的 origin。 */
  origin: string
  /** 所在 frame 左上角在顶层文档里的位置。 */
  offset: [number, number]
  /** 在 closed shadow root 里：浏览器照样画出来，但页面脚本（以及 Playwright 的快照）拿不到。 */
  closedShadow: boolean
}

export function originOf(url: string): string {
  const i = url.indexOf('://')
  if (i < 0) return url
  let j = url.length
  for (const c of ['/', '?', '#']) {
    const k = url.indexOf(c, i + 3)
    if (k >= 0 && k < j) j = k
  }
  return url.slice(0, j)
}

/** 文档顺序：自己 → shadow 里的 → 子节点 → iframe 里的。 */
export function walk(page: FakePage): Located[] {
  const out: Located[] = []
  const visit = (n: FakeNode, path: FakeNode[], origin: string, offset: [number, number], closed: boolean): void => {
    out.push({ node: n, path, origin, offset, closedShadow: closed })
    const sub = [...path, n]
    if (n.shadow) for (const c of n.shadow.children) visit(c, sub, origin, offset, closed || n.shadow.mode === 'closed')
    for (const c of n.children ?? []) visit(c, sub, origin, offset, closed)
    if (n.frame) {
      const b = n.bbox ?? [0, 0, 0, 0]
      const off: [number, number] = [offset[0] + b[0], offset[1] + b[1]]
      for (const c of n.frame.children) visit(c, sub, n.frame.origin, off, false)
    }
  }
  visit(page.root, [], originOf(page.url), [0, 0], false)
  return out
}

export function findNode(page: FakePage, id: string): Located | null {
  for (const loc of walk(page)) if (loc.node.id === id) return loc
  return null
}

export function collapseSpaces(s: string): string {
  return s
    .split(' ')
    .filter((p) => p !== '')
    .join(' ')
}

// ─────────────────────────────────────────────────────────────
// 二、快照：模型看到的页面（§2.1–2.7）
// ─────────────────────────────────────────────────────────────

export type SnapshotMode = 'ai' | 'default'

/** 从祖先继承下来的两件事。 */
export interface Inherited {
  /** 祖先里有 display:none / visibility:hidden / hidden 属性，或者在关闭的 <details> 里。 */
  hiddenForAll: boolean
  /** 祖先里有 aria-hidden。 */
  ariaHidden: boolean
}

export const ROOT_INHERITED: Inherited = { hiddenForAll: false, ariaHidden: false }

/** 自己是不是「两种快照都排除」的那一类。只有这四种是真藏住了（§2.2 表的最后一行）。 */
export function selfHidden(n: FakeNode): boolean {
  const s = n.style ?? {}
  return s.display === 'none' || s.visibility === 'hidden' || n.hiddenAttr === true
}

export function childInherited(parent: FakeNode, anc: Inherited, child: FakeNode): Inherited {
  return {
    hiddenForAll: anc.hiddenForAll || selfHidden(parent) || (parent.detailsClosed === true && child.role !== 'summary'),
    ariaHidden: anc.ariaHidden || parent.ariaHidden === true,
  }
}

export function inheritedOf(loc: Located): Inherited {
  let anc = ROOT_INHERITED
  const chain = [...loc.path, loc.node]
  for (let i = 0; i + 1 < chain.length; i++) {
    const p = chain[i]!
    // iframe 里是另一个文档：继承从头算。
    anc = p.frame ? ROOT_INHERITED : childInherited(p, anc, chain[i + 1]!)
  }
  return anc
}

/** 有没有一个非空的盒子。不要求在视口里——这就是长页面快照爆 token 的根因（§2.7）。 */
export function hasBox(n: FakeNode): boolean {
  const b = n.bbox
  return b !== undefined && b[2] > 0 && b[3] > 0 && n.style?.zeroBox !== true
}

/**
 * TODO 1 的参考实现。
 *
 * Playwright 源码：ai 模式是 `visibility: 'ariaOrVisible'`——「对辅助技术可见」或「视觉上可见」**任一**成立就收；
 * default 模式是 `'aria'`——只看对辅助技术可不可见。
 *
 * ★ 「对辅助技术可见」只看 display / visibility / hidden / aria-hidden，**不看透明度、裁剪、颜色、字号、
 *   在不在视口里**。所以 sr-only、opacity:0、白字白底、font-size:0、离屏文字两种模式都收（INV-1）。
 * ★ aria-hidden 但画在屏幕上的：default 不收，ai 收（INV-3）。两种模式不是「格式不同」，是规则不同。
 */
export function isAriaVisible(n: FakeNode, anc: Inherited, mode: SnapshotMode): boolean {
  if (anc.hiddenForAll || selfHidden(n)) return false
  const ariaHidden = anc.ariaHidden || n.ariaHidden === true
  if (!ariaHidden) return true
  return mode === 'ai' && hasBox(n)
}

/** 名字取自内容的角色（accname 规范的 name from content）。paragraph、generic、listitem 不在里面。 */
export const NAME_FROM_CONTENT = ['button', 'link', 'heading', 'tab', 'menuitem', 'option', 'cell']

/** 子树里的 DOM 文字。canvas 里画的字不是 DOM，藏住的子树不算。 */
export function textContent(n: FakeNode): string {
  const parts: string[] = []
  const visit = (x: FakeNode): void => {
    if (x.role === 'canvas' || selfHidden(x)) return
    if (x.text !== undefined) parts.push(x.text)
    for (const c of x.children ?? []) visit(c)
  }
  visit(n)
  return collapseSpaces(parts.join(' '))
}

/**
 * TODO 2 的参考实现。aria-label > img 的 alt > 内容（只对 NAME_FROM_CONTENT 的角色）> title。
 *
 * ★ aria-label 整段**替换**可见文字成为名字：人眼看到 "Buy"，模型看到一整句指令（INV-2）。
 * ★ title 是最后的回退：按钮已经有文字时，Playwright 快照里没有 title（INV-33）。
 * ★ canvas 的名字只能来自 aria-label——画在上面的字不在 DOM 里。
 */
export function accessibleName(n: FakeNode): string {
  const label = collapseSpaces(n.ariaLabel ?? '')
  if (label !== '') return label
  if (n.role === 'img') {
    const alt = collapseSpaces(n.alt ?? '')
    if (alt !== '') return alt
  }
  if (NAME_FROM_CONTENT.includes(n.role)) {
    const t = textContent(n)
    if (t !== '') return t
  }
  return collapseSpaces(n.title ?? '')
}

// ── ref ──────────────────────────────────────────────────────

export interface RefEntry {
  role: string
  name: string
  ref: string
}

/** 模型「看到的」那一行：ref、role、name，以及它所在那一行（listitem / row）的文字。 */
export interface SeenLine {
  ref: string
  nodeId: string
  role: string
  name: string
  context: string
  line: string
}

/**
 * 页面这一侧的 ref 状态。对应 Playwright 注入脚本里的三样东西：
 *   lastRef（全局计数器）、element._ariaRef（挂在节点上的 expando）、_lastAriaSnapshotForQuery（最后一次快照）。
 * 注入脚本每个文档一份：导航之后全部从头来过。
 */
export interface RefState {
  docSeq: number
  lastRef: number
  expando: Map<string, RefEntry>
  /** 最后一次快照：ref → nodeId。 */
  last: Map<string, string>
}

export function newRefState(): RefState {
  return { docSeq: 0, lastRef: 0, expando: new Map(), last: new Map() }
}

/** MCP 判断「这是不是一个 ref」用的正则（源码是 `^(f\d+)?e\d+$`；这里写 [0-9]，两种语言的 \d 不一样）。 */
export const REF_RE = /^(f[0-9]+)?e[0-9]+$/

export function refPrefix(docSeq: number): string {
  return docSeq > 0 ? `f${docSeq}` : ''
}

/**
 * TODO 3 的参考实现。Playwright `computeAriaRef` 的逐行重写：
 *   节点上已经有 ref，且 role、name 都没变 → 沿用；否则从**全局计数器**取一个新号（从不复用）。
 *   前缀 f<docSeq>：导航以后旧文档的 e3 不可能撞上新文档的元素（INV-7）。
 *
 * ★ 计数器是文档级的，不是快照级的：第二次快照不会从 e1 重新开始。
 * ★ 换文档（page.docSeq 变了）时，计数器和 expando 都清空——它们属于旧文档的注入脚本。
 */
export function assignRef(state: RefState, page: FakePage, nodeId: string, role: string, name: string): string {
  if (state.docSeq !== page.docSeq) {
    state.docSeq = page.docSeq
    state.lastRef = 0
    state.expando.clear()
    state.last.clear()
  }
  const old = state.expando.get(nodeId)
  if (old !== undefined && old.role === role && old.name === name) return old.ref
  state.lastRef += 1
  const ref = `${refPrefix(page.docSeq)}e${state.lastRef}`
  state.expando.set(nodeId, { role, name, ref })
  return ref
}

/** 最近的 listitem / row 祖先里的文字。同名按钮靠它区分是哪一行。 */
export function rowContext(path: FakeNode[]): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const a = path[i]!
    if (a.role === 'listitem' || a.role === 'row') {
      const parts: string[] = []
      const visit = (x: FakeNode): void => {
        if (x.role === 'text' && x.text !== undefined) parts.push(x.text)
        for (const c of x.children ?? []) visit(c)
      }
      visit(a)
      return collapseSpaces(parts.join(' '))
    }
  }
  return ''
}

export interface SnapshotOpts {
  mode?: SnapshotMode
  /**
   * 'browserUse'：把 title 属性也带上。browser-use 的属性白名单里有 title（§2.13）；Playwright 没有。
   * 同一个注入载体，对一种感知器有效、对另一种无效。
   */
  attrs?: 'playwright' | 'browserUse'
}

/** 快照用到的三个可替换的部件（verify 用它们换成你的实现）。 */
export interface SnapshotImpl {
  isAriaVisible: (n: FakeNode, anc: Inherited, mode: SnapshotMode) => boolean
  accessibleName: (n: FakeNode) => string
  assignRef: (state: RefState, page: FakePage, nodeId: string, role: string, name: string) => string
}

export const SHARED_IMPL: SnapshotImpl = { isAriaVisible, accessibleName, assignRef }

export interface Snapshot {
  text: string
  /** ref → nodeId */
  refs: Map<string, string>
  lines: Map<string, SeenLine>
  /** 进了快照的元素（不含 text 节点），文档顺序。 */
  included: string[]
}

/**
 * 生成一份快照，同时更新页面侧的 ref 状态（Playwright 每次快照都会这么做）。
 *
 * 格式模仿 Playwright 的 YAML：`- button "Name" [ref=e3]: 行内文字`；root 自己不出现。
 *
 * ★ ref 只给「有盒子、收得到指针事件」的元素（refs: 'interactable'）。`pointer-events:none` 的按钮照样出现，
 *   但没有 ref（INV-8）；被透明遮罩盖住的按钮**有** ref——这里不做命中测试。
 * ★ iframe 只有拿到 ref 才会被展开；子文档取快照出错时变成空列表，**不报错**（§2.6，INV-9）。
 *   default 模式根本没有 ref，所以也不展开 iframe（由源码推出，`[P2]`）。
 * ★ 简化：真实 Playwright 里 iframe 的内容有自己的 f<n> 前缀；这里和父文档共用一个计数器。
 */
export function snapshot(page: FakePage, state: RefState, opts: SnapshotOpts = {}, impl: SnapshotImpl = SHARED_IMPL): Snapshot {
  const mode = opts.mode ?? 'ai'
  const attrs = opts.attrs ?? 'playwright'
  const refs = new Map<string, string>()
  const lines = new Map<string, SeenLine>()
  const included: string[] = []

  const render = (n: FakeNode, anc: Inherited, path: FakeNode[], pe: boolean, depth: number): string[] => {
    const ind = '  '.repeat(depth)
    if (n.role === 'text') return n.text !== undefined && n.text !== '' ? [`${ind}- text: ${n.text}`] : []
    if (!impl.isAriaVisible(n, anc, mode)) return []
    included.push(n.id)
    const pe2 = pe && n.style?.pointerEvents !== 'none'
    const role = n.role === 'canvas' ? 'generic' : n.role
    const name = impl.accessibleName(n)
    let ref = ''
    if (mode === 'ai' && hasBox(n) && pe2) ref = impl.assignRef(state, page, n.id, role, name)

    let head = `- ${role}`
    if (name !== '') head += ` "${name}"`
    if (mode === 'ai' && n.ariaHidden === true) head += ' [aria-hidden]'
    if (attrs === 'browserUse' && n.title !== undefined && n.title !== name) head += ` title="${n.title}"`
    if (ref !== '') head += ` [ref=${ref}]`

    const sub = [...path, n]
    const kids: string[] = []
    if (n.shadow && n.shadow.mode === 'open') {
      for (const c of n.shadow.children) kids.push(...render(c, childInherited(n, anc, c), sub, pe2, depth + 1))
    }
    for (const c of n.children ?? []) kids.push(...render(c, childInherited(n, anc, c), sub, pe2, depth + 1))
    if (n.frame && ref !== '' && n.frame.error !== true) {
      for (const c of n.frame.children) kids.push(...render(c, ROOT_INHERITED, sub, true, depth + 1))
    }

    let inline = ''
    if (n.text !== undefined && n.role !== 'canvas') {
      const own = collapseSpaces(n.text)
      if (!NAME_FROM_CONTENT.includes(n.role) || own !== name) inline = own
    }
    const line = kids.length > 0 ? `${head}:` : inline !== '' ? `${head}: ${inline}` : head
    if (ref !== '') {
      refs.set(ref, n.id)
      lines.set(ref, { ref, nodeId: n.id, role, name, context: rowContext(path), line })
    }
    return [`${ind}${line}`, ...kids]
  }

  const out: string[] = []
  const root = page.root
  for (const c of root.children ?? []) out.push(...render(c, childInherited(root, ROOT_INHERITED, c), [root], true, 0))
  state.docSeq = page.docSeq
  state.last = new Map(refs)
  return { text: out.join('\n'), refs, lines, included }
}

// ── ref 何时过期（§2.4）──────────────────────────────────────

export type Resolved =
  | { kind: 'ok'; nodeId: string }
  | { kind: 'error'; reason: 'bad-format' | 'not-in-last-snapshot' | 'detached' }

/**
 * Playwright 的解析语义：只认「最后一次快照」，并要求节点还连在文档上。
 *
 * ★ 节点还在、内容变了 → **ok**。解析器不做名字校验，这正是静默点错的来源（INV-6）。
 * ★ 四种过期里只有「节点删了」「换了文档」会报错。
 */
export function resolveRef(state: RefState, page: FakePage, ref: string): Resolved {
  if (!REF_RE.test(ref)) return { kind: 'error', reason: 'bad-format' }
  if (state.docSeq !== page.docSeq) return { kind: 'error', reason: 'not-in-last-snapshot' }
  const id = state.last.get(ref)
  if (id === undefined) return { kind: 'error', reason: 'not-in-last-snapshot' }
  if (findNode(page, id) === null) return { kind: 'error', reason: 'detached' }
  return { kind: 'ok', nodeId: id }
}

export type Drift = 'same' | 'renamed' | 'context-changed' | 'gone'

/** 节点**现在**的 role、name、所在行。 */
export function describeNode(page: FakePage, nodeId: string): { role: string; name: string; context: string } | null {
  const loc = findNode(page, nodeId)
  if (loc === null) return null
  return {
    role: loc.node.role === 'canvas' ? 'generic' : loc.node.role,
    name: accessibleName(loc.node),
    context: rowContext(loc.path),
  }
}

/**
 * TODO 4 的参考实现：模型看到的那一行，和节点现在的样子，还是不是一回事。
 *
 * ★ 只比 role + name 不够：每行一个 "Delete" 的列表重排以后，同一个 ref 指向另一行，
 *   role 和 name 一个字都没变（实测 2c）。要把所在那一行的文字也比上。
 */
export function driftCheck(seen: SeenLine, page: FakePage, nodeId: string): Drift {
  const now = describeNode(page, nodeId)
  if (now === null) return 'gone'
  if (now.role !== seen.role || now.name !== seen.name) return 'renamed'
  if (now.context !== seen.context) return 'context-changed'
  return 'same'
}

/** 对照组：只比 role + name。B7 用它证明「新快照救不了同名重排」。 */
export function driftCheckRoleName(seen: SeenLine, page: FakePage, nodeId: string): Drift {
  const now = describeNode(page, nodeId)
  if (now === null) return 'gone'
  return now.role !== seen.role || now.name !== seen.name ? 'renamed' : 'same'
}

// ─────────────────────────────────────────────────────────────
// 三、坐标（§3.3、§3.7）
// ─────────────────────────────────────────────────────────────

/**
 * 整数的 floor(num / den + 0.5)，den > 0。
 * ★ 不要用 Math.round / round()：Python 的 round 是银行家舍入，round(2.5) == 2。
 */
export function roundHalfUp(num: number, den: number): number {
  return Math.floor((2 * num + den) / (2 * den))
}

/**
 * 模型给的坐标在哪个空间：
 *   css         CSS 视口像素（Playwright MCP 截图默认 scale:"css"）
 *   device      设备像素（page.screenshot() 默认 "device"；Retina 上是 CSS 的 2 倍）
 *   scaledShot  你把截图缩放成 shot.w × shot.h 再发给模型（Anthropic / OpenAI：坐标在你发的那张图里）
 *   gemini1000  0–1000 归一化网格，换算要乘 **CSS 视口**尺寸，不是截图尺寸
 *   fullPage    整页截图：文档坐标，要减 scrollY
 */
export type CoordConv = 'css' | 'device' | 'scaledShot' | 'gemini1000' | 'fullPage'

export interface CoordCtx {
  dpr: number
  /** CSS 视口尺寸。 */
  viewport: { w: number; h: number }
  /** 发给模型的那张图的尺寸（scaledShot 用）。 */
  shot?: { w: number; h: number }
  scrollY?: number
  /** 坐标属于某个 iframe 时，iframe 左上角在视口里的位置。 */
  frameOffset?: { x: number; y: number }
}

export interface Pt {
  x: number
  y: number
}

export interface VPoint {
  ok: boolean
  x: number
  y: number
  error: string
}

/**
 * TODO 5 的参考实现：任何约定 → 整数 CSS 视口坐标。
 * ★ 视口外的点返回错误，**不钳位**：钳到边上等于点到另一个东西。
 */
export function toViewport(pt: Pt, conv: CoordConv, ctx: CoordCtx): VPoint {
  let x: number
  let y: number
  if (conv === 'css') {
    x = pt.x
    y = pt.y
  } else if (conv === 'device') {
    x = roundHalfUp(pt.x, ctx.dpr)
    y = roundHalfUp(pt.y, ctx.dpr)
  } else if (conv === 'scaledShot') {
    if (ctx.shot === undefined) throw new Error('scaledShot 需要 ctx.shot')
    x = roundHalfUp(pt.x * ctx.viewport.w, ctx.shot.w)
    y = roundHalfUp(pt.y * ctx.viewport.h, ctx.shot.h)
  } else if (conv === 'gemini1000') {
    x = roundHalfUp(pt.x * ctx.viewport.w, 1000)
    y = roundHalfUp(pt.y * ctx.viewport.h, 1000)
  } else {
    x = pt.x
    y = pt.y - (ctx.scrollY ?? 0)
  }
  if (ctx.frameOffset !== undefined) {
    x += ctx.frameOffset.x
    y += ctx.frameOffset.y
  }
  if (x < 0 || y < 0 || x >= ctx.viewport.w || y >= ctx.viewport.h) {
    return { ok: false, x: 0, y: 0, error: `outside-viewport (${x},${y})` }
  }
  return { ok: true, x, y, error: '' }
}

// ─────────────────────────────────────────────────────────────
// 四、命中与三种「可见」（§2.13、§8.1）
// ─────────────────────────────────────────────────────────────

export function docRect(loc: Located): Rect {
  const b = loc.node.bbox ?? [0, 0, 0, 0]
  return [b[0] + loc.offset[0], b[1] + loc.offset[1], b[2], b[3]]
}

function chain(loc: Located): FakeNode[] {
  return [...loc.path, loc.node]
}

export function receivesPointerEvents(loc: Located): boolean {
  return !chain(loc).some((a) => a.style?.pointerEvents === 'none')
}

export function isFixed(loc: Located): boolean {
  return chain(loc).some((a) => a.style?.fixed === true)
}

export function isClipped(loc: Located): boolean {
  return chain(loc).some((a) => a.style?.clip === true)
}

/** 祖先的 opacity 相乘，整数。 */
export function effOpacity(loc: Located): number {
  let o = 100
  for (const a of chain(loc)) o = Math.floor((o * (a.style?.opacity ?? 100)) / 100)
  return o
}

function nearest(loc: Located, pick: (s: NodeStyle) => string | number | undefined): string | number | undefined {
  const c = chain(loc)
  for (let i = c.length - 1; i >= 0; i--) {
    const v = pick(c[i]!.style ?? {})
    if (v !== undefined) return v
  }
  return undefined
}

export function effColor(loc: Located): string {
  return (nearest(loc, (s) => s.color) as string | undefined) ?? '#000000'
}

export function effBackground(loc: Located): string {
  return (nearest(loc, (s) => (s.background !== undefined && s.background !== 'transparent' ? s.background : undefined)) as string | undefined) ?? '#ffffff'
}

export function effFontSize(loc: Located): number {
  return (nearest(loc, (s) => s.fontSize) as number | undefined) ?? 16
}

/** 绘制层级：最近的写了 z 的祖先（含自己），默认 0。同层时后画的在上面。 */
function effZ(loc: Located): number {
  const c = chain(loc)
  for (let i = c.length - 1; i >= 0; i--) if (c[i]!.z !== undefined) return c[i]!.z!
  return 0
}

/**
 * 颜色亮度：(299R + 587G + 114B) / 1000，W3C AERT 的「color brightness」公式，整数。
 * 不用 WCAG 相对亮度是因为它要 pow(·, 2.4)——两种语言的 pow 末位可能不同。
 */
export function brightness(hex: string): number {
  const v = (i: number) => parseInt(hex.slice(i, i + 2), 16)
  return Math.floor((299 * v(1) + 587 * v(3) + 114 * v(5)) / 1000)
}

/** AERT 建议的最低亮度差。低于它算「人看不清」。 */
export const CONTRAST_MIN = 125

export type HitPolicy = 'browser' | 'browserUse'

/**
 * 视口坐标 pt 处最上层的元素 id。
 *   'browser'     浏览器的规则：任何有盒子、收得到指针事件、没被裁掉的元素都挡。透明的也挡。
 *   'browserUse'  browser-use 的遮挡规则：只有背景不透明且 opacity ≥ 80 的层才算（源码注释 "highly vibes based number"）。
 * ★ 一个 `background: transparent` 的全屏 div 在浏览器里吃掉所有点击，在 browser-use 眼里不存在（INV-33）。
 */
export function hitTest(page: FakePage, pt: Pt, policy: HitPolicy = 'browser'): string | null {
  let best: string | null = null
  let bestZ = 0
  for (const loc of walk(page)) {
    const n = loc.node
    if (n.role === 'text' || !hasBox(n)) continue
    if (inheritedOf(loc).hiddenForAll || selfHidden(n)) continue
    if (!receivesPointerEvents(loc) || isClipped(loc)) continue
    if (policy === 'browserUse') {
      const bg = n.style?.background ?? 'transparent'
      if (bg === 'transparent' || effOpacity(loc) < 80) continue
    }
    const [rx, ry, rw, rh] = docRect(loc)
    const py = isFixed(loc) ? pt.y : pt.y + page.scrollY
    if (pt.x < rx || pt.x >= rx + rw || py < ry || py >= ry + rh) continue
    const z = effZ(loc)
    if (best === null || z >= bestZ) {
      best = n.id
      bestZ = z
    }
  }
  return best
}

export function isDescendant(page: FakePage, id: string, ancestorId: string): boolean {
  const loc = findNode(page, id)
  return loc !== null && loc.path.some((a) => a.id === ancestorId)
}

/** 元素中心点的视口坐标。 */
export function centerOf(page: FakePage, loc: Located): Pt {
  const [x, y, w, h] = docRect(loc)
  const cx = x + Math.floor(w / 2)
  const cy = y + Math.floor(h / 2)
  return { x: cx, y: isFixed(loc) ? cy : cy - page.scrollY }
}

export interface Visibility {
  /** 语义层：a11y 树里有这个元素（MCP browser_verify_element_visible 只查这个：count() > 0）。 */
  exists: boolean
  /** 有非空盒子且没被 display/visibility 藏住（Playwright isVisible() 的定义）。 */
  box: boolean
  /** 中心点在视口里。 */
  inViewport: boolean
  /** 中心点处最上层的就是它（或它的子孙）。 */
  hit: boolean
  /** 像素层：不透明、没被裁掉、字号不为 0、和背景有足够亮度差。 */
  pixels: boolean
  reasons: string[]
}

/** 「可见」的五层。像素层的两个阈值是这个 lab 定的，不是标准。 */
export const OPACITY_MIN = 10

/**
 * TODO 6 的参考实现。
 *
 * ★ 三种口径，三个不同的「可见」：MCP verify 是「存在」，isVisible() 是「有盒子」，hit-test 是「点得到」；
 *   只有像素层能抓住 opacity:0 和白字白底——而这两类恰好也是隐藏注入的载体（INV-10）。
 */
export function visualVisibility(page: FakePage, nodeId: string): Visibility {
  const loc = findNode(page, nodeId)
  if (loc === null) return { exists: false, box: false, inViewport: false, hit: false, pixels: false, reasons: ['missing'] }
  const n = loc.node
  const anc = inheritedOf(loc)
  const reasons: string[] = []

  const exists = !loc.closedShadow && isAriaVisible(n, anc, 'default')
  if (!exists) reasons.push('not-in-a11y-tree')
  const box = hasBox(n) && !anc.hiddenForAll && !selfHidden(n)
  if (!box) reasons.push('zero-box')

  let inViewport = false
  let hit = false
  if (box) {
    const c = centerOf(page, loc)
    inViewport = c.x >= 0 && c.y >= 0 && c.x < page.viewport.w && c.y < page.viewport.h
    if (!inViewport) reasons.push('outside-viewport')
    else {
      const top = hitTest(page, c, 'browser')
      hit = top !== null && (top === n.id || isDescendant(page, top, n.id))
      if (!hit) reasons.push(`blocked-by:${top ?? 'nothing'}`)
    }
  }

  const op = effOpacity(loc)
  const clipped = isClipped(loc)
  const fs = effFontSize(loc)
  const contrast = Math.abs(brightness(effColor(loc)) - brightness(effBackground(loc)))
  if (op < OPACITY_MIN) reasons.push(`opacity:${op}`)
  if (clipped) reasons.push('clipped')
  if (fs === 0) reasons.push('font-size:0')
  if (contrast < CONTRAST_MIN) reasons.push(`low-contrast:${contrast}`)
  const pixels = box && op >= OPACITY_MIN && !clipped && fs !== 0 && contrast >= CONTRAST_MIN

  return { exists, box, inViewport, hit, pixels, reasons }
}

export interface HiddenFinding {
  nodeId: string
  kind: 'sr-only' | 'clipped' | 'opacity0' | 'fontSize0' | 'lowContrast' | 'offscreen' | 'ariaLabelMismatch' | 'alt' | 'title'
  text: string
}

/**
 * 进了 ai 快照、但人看不见的文字。它和 L14 的 stripInvisible 是两回事，要叠加：
 * 那边是 Unicode 不可见字符，这边是 CSS 视觉隐藏。
 * ★ title 只对把 title 序列化进去的感知器（browser-use）成立；Playwright 快照里没有它。
 */
export function hiddenTextFindings(page: FakePage): HiddenFinding[] {
  const snap = snapshot(page, newRefState(), { mode: 'ai' })
  const out: HiddenFinding[] = []
  for (const id of snap.included) {
    const loc = findNode(page, id)!
    const n = loc.node
    const own = n.text ?? ''
    if (own !== '' && n.role !== 'canvas') {
      const [x, y, w, h] = docRect(loc)
      if (isClipped(loc)) out.push({ nodeId: id, kind: w <= 1 && h <= 1 ? 'sr-only' : 'clipped', text: own })
      if (effOpacity(loc) === 0) out.push({ nodeId: id, kind: 'opacity0', text: own })
      if (effFontSize(loc) === 0) out.push({ nodeId: id, kind: 'fontSize0', text: own })
      if (Math.abs(brightness(effColor(loc)) - brightness(effBackground(loc))) < CONTRAST_MIN) out.push({ nodeId: id, kind: 'lowContrast', text: own })
      if (n.bbox !== undefined && (x + w <= 0 || y + h <= 0)) out.push({ nodeId: id, kind: 'offscreen', text: own })
    }
    const label = collapseSpaces(n.ariaLabel ?? '')
    const visibleText = textContent(n)
    if (label !== '' && visibleText !== '' && label !== visibleText) out.push({ nodeId: id, kind: 'ariaLabelMismatch', text: label })
    if (n.role === 'img' && (n.alt ?? '') !== '') out.push({ nodeId: id, kind: 'alt', text: n.alt! })
    if ((n.title ?? '') !== '') out.push({ nodeId: id, kind: 'title', text: n.title! })
  }
  return out
}

/** X8 的两列对照：MCP browser_verify_element_visible（count() > 0）和 Playwright isVisible()。 */
export function mcpVerifyVisible(page: FakePage, nodeId: string): boolean {
  return visualVisibility(page, nodeId).exists
}

export function playwrightIsVisible(page: FakePage, nodeId: string): boolean {
  return visualVisibility(page, nodeId).box
}

// ─────────────────────────────────────────────────────────────
// 五、图片 token（§4）。公式抄写没有教学价值，所以没有 TODO；你在实验里用它。
// ─────────────────────────────────────────────────────────────

export interface ImageTokens {
  tokens: number
  /** 模型实际看到的尺寸。 */
  w: number
  h: number
  rejected: boolean
  reason: string
}

const ok = (tokens: number, w: number, h: number): ImageTokens => ({ tokens, w, h, rejected: false, reason: '' })
const rejected = (w: number, h: number, reason: string): ImageTokens => ({ tokens: 0, w, h, rejected: true, reason })

/** Anthropic 两档（vision 页 2026-10-12）：⌈w/28⌉ × ⌈h/28⌉。 */
export const ANTHROPIC_TIERS = {
  standard: { maxEdge: 1568, maxTok: 1568 },
  'high-res': { maxEdge: 2576, maxTok: 4784 },
} as const

function anthTok(w: number, h: number): number {
  return Math.ceil(w / 28) * Math.ceil(h / 28)
}

/**
 * ★ 普通 image block 超限会被等比缩小；computer use / browser use 的 toolset **不缩，直接拒收**（INV-22）。
 * 缩放尺寸用二分搜索找「放得下的最大等比尺寸」；和官方参考实现在两个样例上差 1px，token 数 9/9 一致。
 */
function anthropicTokens(w: number, h: number, tier: 'standard' | 'high-res', toolset: boolean): ImageTokens {
  const { maxEdge, maxTok } = ANTHROPIC_TIERS[tier]
  if (Math.max(w, h) <= maxEdge && anthTok(w, h) <= maxTok) return ok(anthTok(w, h), w, h)
  if (toolset) return rejected(w, h, 'toolset 不缩放，超限直接拒收')
  let lo = 0
  let hi = Math.min(1, maxEdge / Math.max(w, h))
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2
    const W = Math.floor(w * m)
    const H = Math.floor(h * m)
    if (Math.max(W, H) <= maxEdge && anthTok(W, H) <= maxTok) lo = m
    else hi = m
  }
  const W = Math.floor(w * lo)
  const H = Math.floor(h * lo)
  return ok(anthTok(W, H), W, H)
}

/** OpenAI 新模型：32px patch × 倍率，向上取整；超过 30,000 patch 拒收，**不会**自动缩（INV-25）。 */
function openaiPatch(w0: number, h0: number, maxDim: number, budget: number, mult: number): ImageTokens {
  let w = w0
  let h = h0
  if (Math.max(w, h) > maxDim) {
    const s = maxDim / Math.max(w, h)
    w = Math.floor(w * s)
    h = Math.floor(h * s)
  }
  let patches = Math.ceil(w / 32) * Math.ceil(h / 32)
  if (budget > 0 && patches > budget) {
    const shrink = Math.sqrt((32 * 32 * budget) / (w * h))
    const adj = shrink * Math.min(Math.floor((w * shrink) / 32) / ((w * shrink) / 32), Math.floor((h * shrink) / 32) / ((h * shrink) / 32))
    w = Math.floor(w * adj)
    h = Math.floor(h * adj)
    patches = Math.ceil(w / 32) * Math.ceil(h / 32)
  }
  if (patches > 30000) return rejected(w, h, `${patches} patch，超过 30,000 上限`)
  return ok(Math.ceil(patches * mult), w, h)
}

/** gpt-4o / gpt-4.1：85 基础 + 每个 512 tile 170。 */
function openaiTile(w0: number, h0: number, detail: string): ImageTokens {
  if (detail === 'low') return ok(85, 512, 512)
  let w = w0
  let h = h0
  if (Math.max(w, h) > 2048) {
    const s = 2048 / Math.max(w, h)
    w = Math.floor(w * s)
    h = Math.floor(h * s)
  }
  if (Math.min(w, h) > 768) {
    const s = 768 / Math.min(w, h)
    w = Math.floor(w * s)
    h = Math.floor(h * s)
  }
  return ok(85 + 170 * Math.ceil(w / 512) * Math.ceil(h / 512), w, h)
}

/**
 * DeepSeek V4.1 Flash：官方 Token 页计算器（JS 分包 1e0da2c4.24c3fb4b.js）的移植，只保留 V4.1 用到的分支。
 * 14px patch × 3 倍下采样 = 每个 token 42×42 像素；token = 行 × (列 + 1) + 2；最小 544²，上限 1024。
 * ★ 图越大不一定越贵：总像素被钳到约 1300²，长截图的宽度跟着被压窄（INV-31）。
 */
const DS = { patch: 14, down: 3, maxTok: 1024, minPixels: 295936 }

function dsTokens(nH: number, nW: number): number {
  return nH * (nW + 1) + 2
}

function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b)
}

interface DsPlan {
  nH: number
  nW: number
  H: number
  W: number
  tokens: number
}

function dsSolve(height: number, width: number, maxTok: number): DsPlan {
  const P = DS.patch * DS.down
  const n = height / width
  const a = Math.sqrt((maxTok - 2) / n + 0.25) - 0.5
  const i = a * n
  let W: number
  let H: number
  if (a < 1) {
    W = P
    H = Math.floor((maxTok - 2) / 2) * P
  } else if (i < 1) {
    W = (maxTok - 2 - 1) * P
    H = P
  } else {
    const u = Math.min((Math.trunc(a) * P) / width, (Math.trunc(i) * P) / height)
    W = Math.trunc((width * u) / DS.patch) * DS.patch
    H = Math.trunc((height * u) / DS.patch) * DS.patch
  }
  const nH = ceilDiv(Math.floor(H / DS.patch), DS.down)
  const nW = ceilDiv(Math.floor(W / DS.patch), DS.down)
  return { nH, nW, H, W, tokens: dsTokens(nH, nW) }
}

function dsInner(w0: number, h0: number): DsPlan {
  let w = w0
  let h = h0
  const px = w * h
  if (px < DS.minPixels && px > 0) {
    const k = Math.sqrt(DS.minPixels / px)
    w = Math.trunc(w * k)
    h = Math.trunc(h * k)
  }
  const W = ceilDiv(w, DS.patch) * DS.patch
  const H = ceilDiv(h, DS.patch) * DS.patch
  const nH = ceilDiv(Math.floor(H / DS.patch), DS.down)
  const nW = ceilDiv(Math.floor(W / DS.patch), DS.down)
  const plan = { nH, nW, H, W, tokens: dsTokens(nH, nW) }
  return plan.tokens > DS.maxTok ? dsSolve(h, w, DS.maxTok) : plan
}

function deepseekTokens(w: number, h: number): ImageTokens {
  let p = dsInner(w, h)
  for (let k = 1; k < 10; k++) {
    const q = dsInner(p.W, p.H)
    if (q.nH === p.nH && q.nW === p.nW && q.H === p.H && q.W === p.W && q.tokens === p.tokens) return ok(p.tokens, p.W, p.H)
    p = q
  }
  throw new Error('DeepSeek 计算器没有收敛')
}

export type ImageProvider = 'anthropic' | 'openai' | 'deepseek'
export type Detail = 'auto' | 'low' | 'high' | 'original'

/**
 * 「同一张截图要多少 token」没有跨厂商的答案，只有 厂商 × 模型 × detail 三元组的答案。
 *
 * 模型：
 *   anthropic  'standard'（4.6 及以前）| 'high-res'（4.7 及以后）；opts.toolset = 走 computer/browser use toolset
 *   openai     'gpt-6-astra'（auto = original，不缩）| 'gpt-5.4'（auto = high；low 可能比 high 贵）| 'gpt-4o'（tile）
 *   deepseek   'deepseek-flash'（V4.1，有视觉）| 'deepseek-v4-pro'（没有视觉；claude-opus* 会被兼容端点映射到它）
 */
export function imageTokens(
  provider: ImageProvider,
  model: string,
  w: number,
  h: number,
  opts: { detail?: Detail; toolset?: boolean } = {},
): ImageTokens {
  const detail = opts.detail ?? 'auto'
  if (provider === 'anthropic') {
    if (model !== 'standard' && model !== 'high-res') throw new Error(`未知模型：${provider}/${model}`)
    return anthropicTokens(w, h, model, opts.toolset === true)
  }
  if (provider === 'openai') {
    if (model === 'gpt-6-astra') {
      if (detail === 'high') return openaiPatch(w, h, 65535, 2500, 1.2)
      if (detail === 'auto' || detail === 'original') return openaiPatch(w, h, 65535, 0, 1.2)
      throw new Error(`gpt-6-astra 不支持 detail=${detail}`)
    }
    if (model === 'gpt-5.4') return openaiPatch(w, h, 2048, detail === 'low' ? 6144 : 2500, 1.2)
    if (model === 'gpt-4o') return openaiTile(w, h, detail)
    throw new Error(`未知模型：${provider}/${model}`)
  }
  if (model === 'deepseek-flash') return deepseekTokens(w, h)
  if (model === 'deepseek-v4-pro') return rejected(w, h, 'deepseek-v4-pro 不支持视觉')
  throw new Error(`未知模型：${provider}/${model}`)
}

/**
 * Anthropic：一个请求超过 20 张图时，**每一张**（含前面轮次重发的、tool_result 里嵌的）都不能超过 2000px（INV-23）。
 * 前 20 轮好好的 loop，第 21 张截图让前面 20 张一起违规。
 */
export function checkImageBatch(imgs: { w: number; h: number }[]): { flagged: number[]; rule: string } {
  if (imgs.length <= 20) return { flagged: [], rule: '不超过 20 张：只看单张上限' }
  const flagged: number[] = []
  imgs.forEach((im, i) => {
    if (Math.max(im.w, im.h) > 2000) flagged.push(i)
  })
  return { flagged, rule: '超过 20 张：每一张都不能超过 2000px' }
}

// ─────────────────────────────────────────────────────────────
// 六、浏览器是一组新的 sink（§2.11、§2.12、§7.5）
// ─────────────────────────────────────────────────────────────

export interface BrowserAction {
  tool: 'click' | 'type'
  /** 模型写的「人类可读描述」，MCP 说它 "used to obtain permission"。 */
  element: string
  /** 真正决定点哪儿的东西。 */
  target: string
  text?: string
}

export interface ApprovalView {
  /** 一个照抄 element 的审批框会显示什么。 */
  displayed: string
  /** 实际会被执行的：target 解析出的 role、name 和所在 frame 的 origin。 */
  executed: string
}

/**
 * ★ 审批框显示的 element 是**模型写的一段自由文本**；被注入的模型可以写 element:"Cancel"、target:"e5"（"Delete account"）。
 *   审批 UI 必须由执行端用 target 反查出 role / name / origin 再显示（INV-17）。
 */
export function approvalView(action: BrowserAction, state: RefState, page: FakePage): ApprovalView {
  const displayed = `${action.tool} "${action.element}"`
  const r = resolveRef(state, page, action.target)
  if (r.kind !== 'ok') return { displayed, executed: `${action.tool} <${action.target}: ${r.reason}>` }
  const loc = findNode(page, r.nodeId)!
  const role = loc.node.role === 'canvas' ? 'generic' : loc.node.role
  let executed = `${action.tool} ${role} "${accessibleName(loc.node)}" @${loc.origin}`
  if (action.text !== undefined) executed += ` text="${action.text}"`
  return { displayed, executed }
}

export interface BrowserChannel {
  name: string
  kind: 'navigate' | 'form' | 'pageTool'
  origin: string
}

export const TEXT_ROLES = ['textbox', 'searchbox', 'combobox']

/**
 * 浏览器里的出站通道。
 * ★ "Typing sensitive information into a form counts as transmission."（OpenAI）——每个输入框都是出站，
 *   目的地是**输入框所在 frame 的 origin**，不是标签页的 URL（INV-19）。
 * ★ WebMCP 默认开：你访问的页面可以往模型上下文里注册工具（INV-16）。
 */
export function browserChannels(page: FakePage): BrowserChannel[] {
  const out: BrowserChannel[] = [{ name: 'navigate', kind: 'navigate', origin: '*' }]
  for (const loc of walk(page)) {
    if (TEXT_ROLES.includes(loc.node.role)) {
      const name = accessibleName(loc.node)
      out.push({ name: `form:${name !== '' ? name : loc.node.id}`, kind: 'form', origin: loc.origin })
    }
  }
  for (const t of page.webmcpTools ?? []) out.push({ name: `pageTool:${t.name}`, kind: 'pageTool', origin: originOf(page.url) })
  return out
}

/** 交给 L14 的 auditChannels：表单和导航是 network，页面工具是 tool。 */
export function toGuardChannels(chs: BrowserChannel[], removed: string[] = []): Channel[] {
  return chs.map((c) => ({
    name: c.name,
    kind: c.kind === 'pageTool' ? ('tool' as const) : ('network' as const),
    mitigation: removed.includes(c.name) ? ('remove' as const) : ('none' as const),
    enforceable: true,
    note: c.origin,
  }))
}

// ── 白名单 ────────────────────────────────────────────────────

function asciiLower(s: string): string {
  let out = ''
  for (const c of s) out += c >= 'A' && c <= 'Z' ? String.fromCharCode(c.charCodeAt(0) + 32) : c
  return out
}

/**
 * TODO 7 的参考实现（前半）：URL → 规范化的 host。
 * 小写（只管 ASCII）、去掉 userinfo、去掉默认端口、去掉末尾的点。
 * ★ Comet 案例里攻击者用的是 `perplexity.ai.`（末尾带点）——字符串直比的白名单和它不是一回事。
 * ★ 不用 URL / urllib：两种语言的解析器对畸形输入的处理不一样。
 */
export function normalizeHost(u: string): string {
  const i = u.indexOf('://')
  const scheme = i >= 0 ? asciiLower(u.slice(0, i)) : ''
  let rest = i >= 0 ? u.slice(i + 3) : u
  let cut = rest.length
  for (const c of ['/', '?', '#']) {
    const k = rest.indexOf(c)
    if (k >= 0 && k < cut) cut = k
  }
  rest = rest.slice(0, cut)
  const at = rest.lastIndexOf('@')
  if (at >= 0) rest = rest.slice(at + 1)
  let host = rest
  const colon = rest.lastIndexOf(':')
  if (colon >= 0) {
    const port = rest.slice(colon + 1)
    host = rest.slice(0, colon)
    if (!((scheme === 'https' && port === '443') || (scheme === 'http' && port === '80') || port === '')) host += `:${port}`
  }
  host = asciiLower(host)
  while (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

/** 精确匹配，或者显式写了 `*.` 的子域（不含裸域本身）。 */
export function hostAllowed(host: string, allow: string[]): boolean {
  for (const a of allow) {
    const e = normalizeHost(a)
    if (e.startsWith('*.')) {
      const suffix = e.slice(1)
      if (host.endsWith(suffix) && host.length > suffix.length) return true
    } else if (host === e) return true
  }
  return false
}

export interface NavVerdict {
  ok: boolean
  /** 第几跳被拦，-1 表示放行。 */
  blockedAt: number
  host: string
}

/**
 * TODO 7 的参考实现（后半）：重定向链的**每一跳**都查。
 * ★ Playwright MCP 的 --allowed-origins "does not affect redirects"；Anthropic 要求 "re-checked in your navigate
 *   handler after redirects"。只查第一跳等于没查。
 */
export function navigationAllowed(chain: string[], allow: string[]): NavVerdict {
  for (let i = 0; i < chain.length; i++) {
    const host = normalizeHost(chain[i]!)
    if (!hostAllowed(host, allow)) return { ok: false, blockedAt: i, host }
  }
  return { ok: true, blockedAt: -1, host: chain.length > 0 ? normalizeHost(chain[chain.length - 1]!) : '' }
}

// ─────────────────────────────────────────────────────────────
// 七、快照的体积
// ─────────────────────────────────────────────────────────────

/** 快照文字的 token 粗估（L06 的 estimateTokens；DeepSeek 实测英文快照 3.7–4.3 字符/token，这里按 4 算）。 */
export function snapshotTokens(text: string): number {
  return estimateTokens(text)
}
