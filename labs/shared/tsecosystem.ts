/**
 * L19x 的参考实现：TS 框架的默认值（录制版）+ 把课程不变量接到框架扩展点上的六个适配器。
 *
 * 两层：
 *   一到五节的「框架模型」：每个函数复现一处在锁定版本上**实测过**的默认行为，数字和原文来自
 *   l19x/fixtures/ecosystem.json（调研 §9 的录制结果）。这一层不装任何框架，所以两种语言能逐字节一致；
 *   代价是它证明不了「框架现在还是这样」——版本号就是它的有效期，升级之后要重新录。
 *   六个适配器（TODO 1–6 的参考实现）：停止原因、错误回填、审批恢复只消费一次、MCP isError、
 *   以服务端为准重建历史、把 Dify DSL 读成代码计划。纯函数，零 I/O、零模型。
 *
 * 口径：ai@7.0.137、@ai-sdk/anthropic@4.0.78、@ai-sdk/mcp@2.0.73、@mastra/core@1.76.0、
 * @anthropic-ai/claude-agent-sdk@0.3.296、@openai/agents-core@0.20.0；Dify DSL 0.7.0。
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

const J = (x: unknown) => JSON.stringify(x)
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

export function asciiLower(s: string): string {
  let out = ''
  for (const c of s) out += c >= 'A' && c <= 'Z' ? String.fromCharCode(c.charCodeAt(0) + 32) : c
  return out
}

/** 按 Unicode 码点比较（JS 默认的 sort 按 UTF-16 码元，两种语言在代理对上会排得不一样）。 */
export function cmpCodePoint(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) {
    const p = x[i]!.codePointAt(0)!
    const q = y[i]!.codePointAt(0)!
    if (p !== q) return p < q ? -1 : 1
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1
}

/** 键按码点排序的 JSON：判断「两次调用的参数是不是同一个」时，`{a,b}` 和 `{b,a}` 必须相等。 */
export function canonicalJson(x: Json): string {
  if (Array.isArray(x)) return `[${x.map((v) => canonicalJson(v)).join(',')}]`
  if (isObj(x)) {
    const keys = Object.keys(x).sort(cmpCodePoint)
    return `{${keys.map((k) => `${J(k)}:${canonicalJson(x[k] as Json)}`).join(',')}}`
  }
  return J(x)
}

/** 整数微美元 → `0.0012`（四位小数，截断）。成本一律用整数存，避免两种语言打印浮点数不一致。 */
export function fmtUsd(micro: number): string {
  const whole = Math.floor(micro / 1_000_000)
  const frac = String(Math.floor((micro % 1_000_000) / 100))
  return `${whole}.${'0'.repeat(Math.max(0, 4 - frac.length))}${frac}`
}

// ─────────────────────────────────────────────────────────────
// 一、循环与终止（I-STOP）：默认步数从 1 到无穷大（调研 §4.1–4.3、§5.2、§6.2、§7.2、§8）
// ─────────────────────────────────────────────────────────────

export interface LoopDefault {
  /** `框架/入口` */
  id: string
  /** null = 没有默认上限 */
  defaultLimit: number | null
  onLimit: 'return' | 'throw' | 'none'
  /** 撞上限时，调用方从返回值 / 异常里能读到的全部信号 */
  signal: string
  evidence: string
}

export interface LoopOutcome {
  modelCalls: number
  toolRuns: number
  ending: string
}

/**
 * 「永远失败的工具 + 每次都重试的模型」在一个入口的默认值下跑多少次、怎么结束。没有上限的入口在 cut 处被外部掐断。
 * ★ AI SDK 撞上限是**正常返回**，最后一步 finishReason 是 tool-calls、text 是空串——和「停在审批上」同值。
 */
export function simulateDefaultLoop(d: LoopDefault, cut: number): LoopOutcome {
  if (d.defaultLimit === null) return { modelCalls: cut, toolRuns: cut, ending: `没有上限，第 ${cut} 次被外部掐断` }
  const n = d.defaultLimit
  return { modelCalls: n, toolRuns: n, ending: d.onLimit === 'throw' ? `抛：${d.signal}` : `返回：${d.signal}` }
}

/** 对照组：AI SDK 的 `isStepCount(n)` 是 `steps.length === n`（严格相等）。★ `isStepCount(0)` 永远不触发。 */
export function aiSdkIsStepCount(n: number): (steps: Step[]) => boolean {
  return (steps) => steps.length === n
}

export interface ToolCall {
  name: string
  args: Json
}

/** 一步的形状，取 AI SDK StepResult 里和终止有关的三个字段。 */
export interface Step {
  toolCalls: ToolCall[]
  /** stop | tool-calls | length | error | other */
  finishReason: string
  /** 这一步停在 tool-approval-request 上 */
  approvalRequested?: boolean
}

export type StopReason = 'running' | 'approval' | 'truncated' | 'error' | 'done' | 'repeat' | 'max_steps'

export interface StopOpts {
  maxSteps: number
  /** 连续多少步调用完全相同就停；小于 2 表示不查 */
  maxRepeat: number
}

/** 一步里全部工具调用的签名：`name(规范化参数)`，按调用顺序用 | 连接。 */
export function callSignature(s: Step): string {
  return s.toolCalls.map((c) => `${c.name}(${canonicalJson(c.args)})`).join('|')
}

/**
 * TODO 1 的参考实现：L05 的 `AgentRun.reason`，用最后一步和整段历史算出来。优先级从上到下：
 *   没有步               → running
 *   最后一步要审批        → approval
 *   finishReason=length  → truncated（工具参数可能被截断，L16）
 *   finishReason=error   → error
 *   最后一步没有工具调用   → done
 *   最近 maxRepeat 步的签名全部相同（maxRepeat ≥ 2）→ repeat
 *   步数 ≥ maxSteps      → max_steps（≥，不是 ===：maxSteps 写成 0 也会停）
 *   否则                  → running
 * ★ 框架只给最后一步的 finishReason：撞上限、停在审批、调了没有 execute 的工具，三种都是 tool-calls。
 */
export function courseStopReason(steps: Step[], o: StopOpts): StopReason {
  if (steps.length === 0) return 'running'
  const last = steps[steps.length - 1]!
  if (last.approvalRequested === true) return 'approval'
  if (last.finishReason === 'length') return 'truncated'
  if (last.finishReason === 'error') return 'error'
  if (last.toolCalls.length === 0) return 'done'
  if (o.maxRepeat >= 2 && steps.length >= o.maxRepeat) {
    const sig = callSignature(last)
    let same = true
    for (let i = steps.length - o.maxRepeat; i < steps.length; i++) {
      if (callSignature(steps[i]!) !== sig) {
        same = false
        break
      }
    }
    if (same) return 'repeat'
  }
  if (steps.length >= o.maxSteps) return 'max_steps'
  return 'running'
}

/** 接到 AI SDK 的 `stopWhen` 上：停不停由 reason 决定，reason 本身由你记下来。 */
export function courseStopWhen(o: StopOpts): (steps: Step[]) => boolean {
  return (steps) => courseStopReason(steps, o) !== 'running'
}

// ─────────────────────────────────────────────────────────────
// 二、工具错误回填（I-ERR）：三家泄密、一家抹掉（调研 §4.4、§5.2、§6.6、§7.3）
// ─────────────────────────────────────────────────────────────

export interface ToolErr {
  name: string
  message: string
  code?: string
}

export interface BackfillRule {
  framework: string
  /** toString = `${name}: ${message}`；message = 原样 message；fixed = 固定文案 */
  rule: 'toString' | 'message' | 'fixed'
  /** 线上有没有 is_error：true / — / 未核实 */
  isError: string
  evidence: string
}

export const OPENAI_DEFAULT_TOOL_ERROR = 'An error occurred while running the tool. Please try again.'

/** 一家框架默认会把这个异常变成什么文本交给模型。 */
export function frameworkBackfill(r: BackfillRule, e: ToolErr): string {
  if (r.rule === 'toString') return `${e.name}: ${e.message}`
  if (r.rule === 'message') return e.message
  return OPENAI_DEFAULT_TOOL_ERROR
}

export const ERROR_PREFIX = '[tool error] '
export const NEXT_STEP = '下一步：'
export const MAX_ERROR_MESSAGE = 200
export const MAX_ERROR_TEXT = 400
/** 让模型「原样再来一次」的文案。叠加没有上限的循环就是死循环（E5-A、E6-A）。 */
export const RETRY_AS_IS = ['Please try again', 'try this action again as-is']

export const ERROR_HINTS: [string, string][] = [
  ['ENOENT', '路径不存在：先列出目录确认文件名，再换路径调用'],
  ['EACCES', '没有权限：不要重试同一个调用，换一个允许的路径或请用户授权'],
  ['EPERM', '没有权限：不要重试同一个调用，换一个允许的路径或请用户授权'],
  ['ETIMEDOUT', '可能是临时故障：最多再试一次，仍失败就停下来报告'],
  ['ECONNRESET', '可能是临时故障：最多再试一次，仍失败就停下来报告'],
  ['INVALID_ARGS', '参数不合法：对照工具的 schema 改参数后再调用'],
]
export const DEFAULT_HINT = '换参数或换工具；做不到就停下来向用户说明，不要原样重试'

const SECRET_RULES: [RegExp, string][] = [
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]+/g, 'sk-***'],
  [/(secret|token|password|api_key)=[^ \t\n\r,;)\]}'"]+/g, '$1=***'],
  [/Bearer [A-Za-z0-9._~+/=-]+/g, 'Bearer ***'],
]

/**
 * TODO 2 的参考实现（前半）：三条规则依次全局替换。
 *   `sk-` 开头的 key，前面不能紧挨字母或数字（`task-queue` 里的 `sk-queue` 不是 key）
 *   `secret= / token= / password= / api_key=` 后面到空白或 `,;)]}'"` 之前的值（只认小写键名）
 *   `Bearer ` 后面的 token
 * 替换结果再跑一遍不变（幂等）。
 */
export function redactSecrets(s: string): string {
  let out = s
  for (const [re, rep] of SECRET_RULES) out = out.replace(re, rep)
  return out
}

function messageOf(e: unknown): string {
  if (isObj(e) && typeof e.message === 'string') return e.message
  if (typeof e === 'string') return e
  return '（没有错误信息）'
}

/** 错误码：`e.code`（非空字符串），否则 message 开头的 `E` + 至少一个大写字母（`ENOENT: ...`）。 */
export function errorCode(e: unknown, message: string): string {
  if (isObj(e) && typeof e.code === 'string' && e.code !== '') return e.code
  if (message.length === 0 || message[0] !== 'E') return ''
  let i = 1
  while (i < message.length && message[i]! >= 'A' && message[i]! <= 'Z') i++
  return i >= 2 ? message.slice(0, i) : ''
}

export function hintFor(code: string): string {
  for (const [c, h] of ERROR_HINTS) if (c === code) return h
  return DEFAULT_HINT
}

/**
 * TODO 2 的参考实现（后半）：两家框架共用的错误出口（AI SDK 的 execute 包装、Agents SDK 的 errorFunction）。
 *   `[tool error] 工具名: 消息\n下一步：提示`
 *   消息：换行和回车换成空格 → redactSecrets → 超过 200 个码点截断并加 `…`
 *   工具名为空 → unknown-tool；提示按 errorCode 查 ERROR_HINTS，查不到用 DEFAULT_HINT
 * ★ DeepSeek 的 Anthropic 端点忽略 is_error（INV-11）：「这是失败」和「下一步做什么」都必须写在文本里。
 */
export function courseToolError(e: unknown, ctx: { tool: string }): string {
  const raw = messageOf(e)
  const code = errorCode(e, raw)
  let msg = redactSecrets(raw.split('\r').join(' ').split('\n').join(' '))
  const cps = [...msg]
  if (cps.length > MAX_ERROR_MESSAGE) msg = cps.slice(0, MAX_ERROR_MESSAGE).join('') + '…'
  const tool = ctx.tool === '' ? 'unknown-tool' : ctx.tool
  return `${ERROR_PREFIX}${tool}: ${msg}\n${NEXT_STEP}${hintFor(code)}`
}

/** 拿课程的五条要求去量一段回填文本。空数组 = 合格。 */
export function auditBackfill(text: string, tool: string): string[] {
  const out: string[] = []
  if (redactSecrets(text) !== text) out.push('leaks-secret')
  const low = asciiLower(text)
  if (!low.includes('error') && !text.includes('失败') && !text.includes('错误')) out.push('no-error-signal')
  if (!text.includes(tool)) out.push('no-tool-name')
  if (!text.includes(NEXT_STEP)) out.push('no-next-step')
  for (const p of RETRY_AS_IS) {
    if (text.includes(p)) {
      out.push('retry-as-is')
      break
    }
  }
  if ([...text].length > MAX_ERROR_TEXT) out.push('too-long')
  return out
}

// ─────────────────────────────────────────────────────────────
// 三、审批恢复（I-IDEM）：同一份 RunState 恢复两次，副作用两次（调研 §7.4、§9.3）
// ─────────────────────────────────────────────────────────────

/** 对照组：`RunState.fromString(saved)` → approve → `run()`，每次都从头执行被批准的那个工具。 */
export function runStateResume(times: number, effect: () => void): number[] {
  const counts: number[] = []
  let n = 0
  for (let i = 0; i < times; i++) {
    effect()
    n++
    counts.push(n)
  }
  return counts
}

export type Kv = Map<string, string>

export interface ResumeOutcome {
  status: 'ran' | 'already-consumed' | 'conflict' | 'in-flight' | 'crashed'
  /** ran / already-consumed：结果；conflict：先前的决定；crashed：异常信息；in-flight：空串 */
  result: string
}

/**
 * TODO 3 的参考实现：一条审批只被消费一次。键 `approval:${approvalId}`，值有两种：
 *   `in-flight`                      已认领、还没有结果
 *   `done:${decision}:${result}`     已完成（result 里可以有冒号，只按前两个冒号切）
 * 规则：
 *   没有记录 → 先写 in-flight，再调 resume()；成功写 done 返回 ran；抛异常返回 crashed（记录**留在 in-flight**）
 *   in-flight → 返回 in-flight，**不**再调 resume()（上次可能已经产生了副作用，要对账，不能重跑）
 *   done 且决定相同 → already-consumed + 缓存的结果；决定不同 → conflict + 先前的决定
 * ★ 框架把「恢复」当成纯函数：worker 崩溃后重放同一条审批，有副作用的工具再执行一次（E6-B 实测 1 → 2）。
 */
export function resumeOnce(store: Kv, approvalId: string, decision: 'approve' | 'reject', resume: () => string): ResumeOutcome {
  const key = `approval:${approvalId}`
  const cur = store.get(key)
  if (cur === 'in-flight') return { status: 'in-flight', result: '' }
  if (cur !== undefined) {
    const rest = cur.slice('done:'.length)
    const k = rest.indexOf(':')
    const prev = rest.slice(0, k)
    return prev === decision ? { status: 'already-consumed', result: rest.slice(k + 1) } : { status: 'conflict', result: prev }
  }
  store.set(key, 'in-flight')
  let r: string
  try {
    r = resume()
  } catch (e) {
    return { status: 'crashed', result: messageOf(e) }
  }
  store.set(key, `done:${decision}:${r}`)
  return { status: 'ran', result: r }
}

// ─────────────────────────────────────────────────────────────
// 四、MCP 的 isError（I-ERR × L10）：在 AI SDK 的 MCP 路径上丢了，在 DeepSeek 上本来就不算数（调研 §4.9、§4.15）
// ─────────────────────────────────────────────────────────────

export interface McpResult {
  content?: unknown
  isError?: unknown
  structuredContent?: unknown
}

/**
 * 对照组：`@ai-sdk/mcp` 把 isError 的结果原样当成功返回，`mcpToModelOutput` 不看 isError，
 * Anthropic provider 只对 error-text / error-json 设 is_error——线上块里没有 is_error（E2 实测）。
 */
export function aiSdkMcpWire(r: McpResult, toolUseId: string): Json {
  const content: Json[] = []
  for (const c of Array.isArray(r.content) ? r.content : []) {
    if (isObj(c) && c.type === 'text' && typeof c.text === 'string') content.push({ type: 'text', text: c.text })
  }
  return { type: 'tool_result', tool_use_id: toolUseId, content }
}

/**
 * TODO 4 的参考实现：MCP CallToolResult → 一段模型能读懂的文本。
 *   isError：只有缺省、null、false 算成功，其余（"true"、1、0……）一律当失败（fail-closed）
 *   content 逐项（不是数组就当空）：
 *     text            → text
 *     image           → `[image ${mimeType}，未展开]`（mimeType 不是字符串写 ?）
 *     resource        → `[resource ${uri}]`，有 text 再换行接 text（uri 不是字符串写 ?）
 *     resource_link   → `[link ${uri}]`
 *     不是对象         → `[unsupported content]`
 *     其他             → `[unsupported content: ${type}]`（type 不是字符串就写它的 JSON，缺省写 null）
 *   用换行连接。一项都没有：有 structuredContent 键 → 它的 JSON；否则 `(empty result)`
 *   失败：`[tool error] ` + redactSecrets(正文)
 */
export function mcpResultToText(r: McpResult): { text: string; isError: boolean } {
  const isError = r.isError !== undefined && r.isError !== null && r.isError !== false
  const parts: string[] = []
  for (const c of Array.isArray(r.content) ? r.content : []) {
    if (!isObj(c)) {
      parts.push('[unsupported content]')
      continue
    }
    const t = c.type
    if (t === 'text' && typeof c.text === 'string') parts.push(c.text)
    else if (t === 'image') parts.push(`[image ${typeof c.mimeType === 'string' ? c.mimeType : '?'}，未展开]`)
    else if (t === 'resource' && isObj(c.resource)) {
      const res = c.resource
      const uri = typeof res.uri === 'string' ? res.uri : '?'
      parts.push(typeof res.text === 'string' ? `[resource ${uri}]\n${res.text}` : `[resource ${uri}]`)
    } else if (t === 'resource_link' && typeof c.uri === 'string') parts.push(`[link ${c.uri}]`)
    else parts.push(`[unsupported content: ${typeof t === 'string' ? t : J(t ?? null)}]`)
  }
  let body = parts.join('\n')
  if (parts.length === 0) body = 'structuredContent' in r ? J(r.structuredContent ?? null) : '(empty result)'
  if (!isError) return { text: body, isError: false }
  return { text: ERROR_PREFIX + redactSecrets(body), isError: true }
}

/** 课程的线上块：失败时 is_error 照设（对别的端点有用），但承重的是文本。 */
export function courseMcpWire(r: McpResult, toolUseId: string): Json {
  const m = mcpResultToText(r)
  return m.isError
    ? { type: 'tool_result', tool_use_id: toolUseId, content: m.text, is_error: true }
    : { type: 'tool_result', tool_use_id: toolUseId, content: m.text }
}

/** DeepSeek 的 Anthropic 端点：`tool_result.is_error`、各处 `cache_control` 都标注为 Ignored。模型能看到的只剩内容文本。 */
export function deepseekSees(block: Json): string {
  if (!isObj(block)) return ''
  const c = block.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((x) => (isObj(x) && typeof x.text === 'string' ? x.text : '')).join('\n')
  return ''
}

// ─────────────────────────────────────────────────────────────
// 五、历史是谁的（I-HIST）：UI 遮罩改写下一轮历史（调研 §4.10、§4.7）
// ─────────────────────────────────────────────────────────────

export const AI_SDK_UI_ERROR_MASK = 'An error occurred.'

/**
 * 对照组：`toUIMessageStream` 的默认 onError 把客户端工具的错误遮成固定文案；`useChat` 标准模式下，
 * 服务端下一轮从客户端发来的 UI 消息重建历史——模型第 N+1 轮看到的是遮罩后的文本（E2-UI 实测）。
 */
export function uiRoundTrip(modelSaw: string, onError?: (s: string) => string): { turnN: string; ui: string; turnN1: string } {
  const ui = onError === undefined ? AI_SDK_UI_ERROR_MASK : onError(modelSaw)
  return { turnN: modelSaw, ui, turnN1: ui }
}

export interface UiToolPart {
  toolCallId: string
  state: 'output-error' | 'output-available'
  /** errorText 或 output */
  text: string
}

export interface LoggedResult {
  toolCallId: string
  kind: 'error' | 'result'
  /** 第 N 轮模型实际看到的文本 */
  text: string
}

export interface ModelToolResult {
  toolCallId: string
  type: 'error-text' | 'text'
  value: string
}

export interface Rebuilt {
  history: ModelToolResult[]
  /** 服务端有、UI 也有，但种类或文本不一样（被遮罩、被改写） */
  drifted: string[]
  /** UI 里有、服务端没有：客户端造出来的（包括伪造的审批结果） */
  forged: string[]
  /** 服务端有、UI 里没有：客户端丢掉的 */
  dropped: string[]
}

/**
 * TODO 5 的参考实现：下一轮的历史以服务端日志为准，客户端发来的 UI 消息只用来对账。
 *   history：按日志顺序，每条日志一项；kind=error → type error-text，否则 text；value 是日志里的文本
 *   UI 里同一个 toolCallId 出现多次，只看第一次
 *   forged：UI 里有、日志里没有的 id（按 UI 顺序、去重）
 *   dropped：日志里有、UI 里没有的 id（按日志顺序）
 *   drifted：两边都有，但 UI 的 state（output-error ↔ error）或文本和日志不一致（按日志顺序）
 * ★ 历史不是 append-only 的：同一个 tool_result 第 N 轮带出路、第 N+1 轮只剩 An error occurred.，前缀缓存同时失效。
 */
export function rebuildHistory(ui: UiToolPart[], log: LoggedResult[]): Rebuilt {
  const logIds: string[] = log.map((l) => l.toolCallId)
  const first = new Map<string, UiToolPart>()
  const forged: string[] = []
  for (const p of ui) {
    if (!logIds.includes(p.toolCallId)) {
      if (!forged.includes(p.toolCallId)) forged.push(p.toolCallId)
      continue
    }
    if (!first.has(p.toolCallId)) first.set(p.toolCallId, p)
  }
  const history: ModelToolResult[] = []
  const drifted: string[] = []
  const dropped: string[] = []
  for (const l of log) {
    history.push({ toolCallId: l.toolCallId, type: l.kind === 'error' ? 'error-text' : 'text', value: l.text })
    const p = first.get(l.toolCallId)
    if (p === undefined) {
      dropped.push(l.toolCallId)
      continue
    }
    const sameKind = (p.state === 'output-error') === (l.kind === 'error')
    if (!sameKind || p.text !== l.text) drifted.push(l.toolCallId)
  }
  return { history, drifted, forged, dropped }
}

// ─────────────────────────────────────────────────────────────
// 六、把 Dify DSL 读成代码计划（调研 §11.2 的八步）
// ─────────────────────────────────────────────────────────────

/** 画布字段：拖一下节点，git diff 里就是这些。 */
export const DIFY_UI_FIELDS = ['position', 'positionAbsolute', 'width', 'height', 'selected', 'zIndex', 'sourcePosition', 'targetPosition', 'dragging']
/** `{{#sys.query#}}` 这类引用指向会话状态，不是节点。 */
export const DIFY_NAMESPACES = ['sys', 'env', 'conversation']
export const DIFY_READER_VERSION = '0.7.0'

export interface DifyStep {
  id: string
  type: string
  title: string
  /** 改写成代码时要补的东西 */
  needs: string[]
}

export interface DifyPlan {
  version: string
  kind: string
  uiFieldsDropped: number
  order: string[]
  steps: DifyStep[]
  branches: string[]
  refs: string[]
  errors: string[]
}

const VERSION_RE = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/
const REF_RE = /\{\{#([A-Za-z0-9_]+)\.([A-Za-z0-9_.]+)#\}\}/g

function versionParts(v: string): number[] | null {
  const m = VERSION_RE.exec(v)
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}

function stringsIn(x: unknown, out: string[]): void {
  if (typeof x === 'string') out.push(x)
  else if (Array.isArray(x)) for (const v of x) stringsIn(v, out)
  else if (isObj(x)) for (const k of Object.keys(x)) stringsIn(x[k], out)
}

/** 每种节点改写成代码时要补的东西。对应 §11.2 第 4–7 步。 */
export function difyNeeds(type: string, data: Record<string, unknown>): string[] {
  if (['start', 'end', 'answer', 'if-else', 'question-classifier', 'template-transform', 'variable-aggregator'].includes(type)) return []
  if (type === 'llm') {
    const mem = data.memory
    const win = isObj(mem) ? mem.window : undefined
    return isObj(win) && win.enabled === true ? ['sliding-window-breaks-cache'] : []
  }
  if (type === 'agent' || type === 'agent_v2') return ['max-steps', 'stop-reason']
  if (type === 'knowledge-retrieval') return ['rebind-index']
  if (type === 'tool') return typeof data.credential_id === 'string' && data.credential_id !== '' ? [] : ['reconnect-secret']
  if (type === 'http-request') {
    const out: string[] = []
    const rc = data.retry_config
    if (!(isObj(rc) && rc.enabled === true)) out.push('no-retry')
    const m = typeof data.method === 'string' ? asciiLower(data.method) : 'get'
    if (m !== 'get' && m !== 'head') out.push('idempotency-key')
    return out
  }
  if (type === 'code') return ['sandbox']
  if (type === 'human_input') return ['server-side-approval']
  return ['unknown-node-type']
}

/**
 * TODO 6 的参考实现。按顺序：
 *   1. 不是对象 → errors ['not-an-object']，其余字段空
 *   2. version 缺省当 '0.1.0'、kind 缺省当 'app'（Dify 导入时就这么补）；kind 不是 app → `kind:${kind}`；
 *      version 不是 x.y.z → `bad-version:${v}`；比 DIFY_READER_VERSION 新 → `newer-dsl:${v}`
 *   3. 节点（workflow.graph.nodes，列表顺序）：不是对象或 id 不是非空字符串 → 'bad-node'；id 重复 → `duplicate-node:${id}`（后一个丢掉）；
 *      每个节点、每条边上出现的 DIFY_UI_FIELDS 键计入 uiFieldsDropped（重复的节点也算）
 *   4. 边（列表顺序）：不是对象 → 'bad-edge'；source / target 不是已知节点 → `dangling-edge:${id ?? '?'}`；
 *      sourceHandle（缺省 'source'）不是 'source' → branches 加 `${source}:${handle}->${target}`
 *   5. 拓扑序（Kahn）：每轮取节点列表里第一个入度为 0 且未取过的；取不完的 → `cycle:${剩下的 id 用逗号连}`
 *   6. steps：先拓扑序、再剩下的（列表顺序）；needs 用 difyNeeds
 *   7. 引用：按 steps 的顺序，扫节点 data 里所有字符串（键的顺序、数组顺序）中的 `{{#src.field#}}`：
 *      src 是 sys / env / conversation → refs 加 `${id}<-${src}.${field}`
 *      src 不是节点 → `unknown-ref:${id}:${src}.${field}`
 *      src 不是这个节点的祖先（沿边反向可达）→ `ref-not-upstream:${id}:${src}.${field}`
 *      否则 refs 加 `${id}<-${src}.${field}`；refs 去重
 * ★ 拓扑序在前 ≠ 是上游：if-else 的两个分支在拓扑序里一前一后，互相引用就是运行时的空值。
 */
export function difyPlan(dsl: unknown): DifyPlan {
  const plan: DifyPlan = { version: '', kind: '', uiFieldsDropped: 0, order: [], steps: [], branches: [], refs: [], errors: [] }
  if (!isObj(dsl)) {
    plan.errors.push('not-an-object')
    return plan
  }
  plan.version = typeof dsl.version === 'string' ? dsl.version : '0.1.0'
  plan.kind = typeof dsl.kind === 'string' ? dsl.kind : 'app'
  if (plan.kind !== 'app') plan.errors.push(`kind:${plan.kind}`)
  const vp = versionParts(plan.version)
  const rp = versionParts(DIFY_READER_VERSION)!
  if (vp === null) plan.errors.push(`bad-version:${plan.version}`)
  else {
    let cmp = 0
    for (let i = 0; i < 3 && cmp === 0; i++) cmp = vp[i]! === rp[i]! ? 0 : vp[i]! < rp[i]! ? -1 : 1
    if (cmp > 0) plan.errors.push(`newer-dsl:${plan.version}`)
  }

  const wf = dsl.workflow
  const graph = isObj(wf) ? wf.graph : undefined
  const nodesRaw = isObj(graph) && Array.isArray(graph.nodes) ? graph.nodes : []
  const edgesRaw = isObj(graph) && Array.isArray(graph.edges) ? graph.edges : []

  const ids: string[] = []
  const byId = new Map<string, { type: string; title: string; data: Record<string, unknown> }>()
  for (const n of nodesRaw) {
    if (!isObj(n) || typeof n.id !== 'string' || n.id === '') {
      plan.errors.push('bad-node')
      continue
    }
    for (const f of DIFY_UI_FIELDS) if (f in n) plan.uiFieldsDropped++
    if (byId.has(n.id)) {
      plan.errors.push(`duplicate-node:${n.id}`)
      continue
    }
    const data = isObj(n.data) ? n.data : {}
    ids.push(n.id)
    byId.set(n.id, { type: typeof data.type === 'string' ? data.type : '', title: typeof data.title === 'string' ? data.title : '', data })
  }

  const succ = new Map<string, string[]>()
  const pred = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const id of ids) {
    succ.set(id, [])
    pred.set(id, [])
    indeg.set(id, 0)
  }
  for (const e of edgesRaw) {
    if (!isObj(e)) {
      plan.errors.push('bad-edge')
      continue
    }
    for (const f of DIFY_UI_FIELDS) if (f in e) plan.uiFieldsDropped++
    const s = e.source
    const t = e.target
    if (typeof s !== 'string' || typeof t !== 'string' || !byId.has(s) || !byId.has(t)) {
      plan.errors.push(`dangling-edge:${typeof e.id === 'string' ? e.id : '?'}`)
      continue
    }
    succ.get(s)!.push(t)
    pred.get(t)!.push(s)
    indeg.set(t, indeg.get(t)! + 1)
    const h = typeof e.sourceHandle === 'string' ? e.sourceHandle : 'source'
    if (h !== 'source') plan.branches.push(`${s}:${h}->${t}`)
  }

  const taken: string[] = []
  for (;;) {
    let pick = ''
    for (const id of ids) {
      if (!taken.includes(id) && indeg.get(id) === 0) {
        pick = id
        break
      }
    }
    if (pick === '') break
    taken.push(pick)
    for (const t of succ.get(pick)!) indeg.set(t, indeg.get(t)! - 1)
  }
  plan.order = taken
  const stuck = ids.filter((id) => !taken.includes(id))
  if (stuck.length > 0) plan.errors.push(`cycle:${stuck.join(',')}`)

  const ancestors = (id: string): string[] => {
    const seen: string[] = []
    const stack = [...pred.get(id)!]
    while (stack.length > 0) {
      const x = stack.pop()!
      if (seen.includes(x)) continue
      seen.push(x)
      for (const p of pred.get(x)!) stack.push(p)
    }
    return seen
  }

  for (const id of [...taken, ...stuck]) {
    const n = byId.get(id)!
    plan.steps.push({ id, type: n.type, title: n.title, needs: difyNeeds(n.type, n.data) })
    const strs: string[] = []
    stringsIn(n.data, strs)
    const up = ancestors(id)
    for (const s of strs) {
      for (const m of s.matchAll(REF_RE)) {
        const src = m[1]!
        const field = m[2]!
        const ref = `${id}<-${src}.${field}`
        if (DIFY_NAMESPACES.includes(src)) {
          if (!plan.refs.includes(ref)) plan.refs.push(ref)
        } else if (!byId.has(src)) plan.errors.push(`unknown-ref:${id}:${src}.${field}`)
        else if (!up.includes(src)) plan.errors.push(`ref-not-upstream:${id}:${src}.${field}`)
        else if (!plan.refs.includes(ref)) plan.refs.push(ref)
      }
    }
  }
  return plan
}

// ─────────────────────────────────────────────────────────────
// 七、平台、框架、手写（调研 §11.5、§12）
// ─────────────────────────────────────────────────────────────

export interface PlatformNeeds {
  fixedFlow: boolean
  readOnlyTools: boolean
  internalUsers: boolean
  evalGate: boolean
  perTenantBilling: boolean
  writeApproval: boolean
  ci: boolean
  multiTenantSaas: boolean
  paidEmbedding: boolean
}

/**
 * §11.5 的经验法则（调研的推论，不是一手结论）：流程固定、工具只读、使用者是内部运营 → 平台；
 * 要 eval 门禁、按租户计费、写操作要审批、要进 CI → 手写（流程固定时可以拿平台做原型）。许可单独列。
 */
export function choosePlatform(n: PlatformNeeds): { pick: string; why: string[]; license: string[] } {
  const why: string[] = []
  if (n.evalGate) why.push('要 eval 门禁')
  if (n.perTenantBilling) why.push('按租户计费')
  if (n.writeApproval) why.push('写操作要审批')
  if (n.ci) why.push('要进 CI')
  const license: string[] = []
  if (n.multiTenantSaas) license.push('Dify：多租户（一个 workspace 即一个租户）要书面授权')
  if (n.paidEmbedding) license.push('n8n：不能嵌进对外收费的产品')
  if (why.length > 0) return { pick: n.fixedFlow ? '平台做原型，DSL 当需求文档，手写上线' : '手写', why, license }
  if (n.fixedFlow && n.readOnlyTools && n.internalUsers) return { pick: '平台', why: ['流程固定、工具只读、使用者是内部运营'], license }
  return { pick: '手写', why: ['平台的三个前提不全满足'], license }
}
