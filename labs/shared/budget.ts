/**
 * 参考实现：缓存、路由、限流的**判定与计价**。
 *
 * 这个模块的存在理由，是这一节的中心论点：
 *
 *   **缓存、路由、批处理这三件事，失败的时候不报错。**
 *
 * Anthropic 的原话（Prompt caching § Cache limitations）：
 *   "Any requests to cache fewer than this number of tokens will be
 *    processed without caching, and **no error is returned**."
 * DeepSeek 的 Anthropic 兼容表里，`cache_control` 出现四次，四次都是 `Ignored`。
 * Anthropic 自己的 OpenAI 兼容层：
 *   "Most unsupported fields are **silently ignored** rather than producing errors."
 *
 * 所以这一节真正要交付的不是「省钱的技巧」，是一套**判定器**：
 * 给定 usage，回答「命中了 / 没命中 / 这个端点根本没法判定」。
 *
 * ★ 注意第三个状态。它不是凑数的——它是兼容层的形状。
 * 一个只有「命中/未命中」两态的判定器，会把「我看不见」报成「没命中」，
 * 然后你去优化一个你根本观测不到的东西。
 */

import { estimateTokens } from './context.ts'

// ─────────────────────────────────────────────────────────────
// 一、金额：整数定点，不用浮点
// ─────────────────────────────────────────────────────────────

/**
 * ★ 为什么不用浮点：这门课要求 TS 和 Python 的输出**逐字节一致**。
 *
 * 而两种语言在 `toFixed` / `round` 上的行为不一样（banker's rounding 的
 * 边界、`-0` 的印法、大数的位数策略），一个 0.5 的舍入方向差异就能让
 * 对拍失败，而且失败信息会指向一个完全无关的地方。
 *
 * 所以：**金额全程整数**。
 *
 * 单位约定：
 *   · 价格用「微分 / 百万 token」表示，微分 = 1e-8 元。
 *     即 1 元/M 记作 100_000_000。
 *   · 账目累加的是 `tokens × 微分每兆`，单位是「微分 × 1e6」。
 *     这个量不除，一路累加到最后再一次性格式化——**中间不做任何除法，
 *     也就不产生任何舍入**。
 *
 * 用 bigint 是因为这个累加量会很大：一次 30 步的会话就能到 1e15 量级，
 * 超过 Number.MAX_SAFE_INTEGER 之后 JS 会静默丢精度（又一个不报错的失败）。
 */
export type Picofen = bigint

/** 价格表。单位：微分 / 百万 token（微分 = 1e-8 元）。 */
export interface Price {
  /** 未命中的输入单价。所有倍率都以它为基准。 */
  inputMiss: bigint
  /** 输出单价。 */
  output: bigint
}

/**
 * 倍率，而不是绝对价格。
 *
 * ★ 这是刻意的取舍。绝对价格三个月变一次（调研报告里就有三个
 * "through December 31, 2026" 的限时价），一张过期的比价表比没有表更糟。
 * 而**倍率稳定得多，并且倍率才是做决策用的东西**。
 *
 * 数字来自 Anthropic 官方定价页（抓取 2026-09-15）：
 *   "5-minute cache write tokens are **1.25 times** the base input tokens price"
 *   "1-hour cache write tokens are **2 times** the base input tokens price"
 *   "Cache read tokens are **0.1 times** the base input tokens price"
 */
export const MULT = {
  /** 缓存读。未命中 : 命中 = 10 : 1。 */
  cacheRead: { num: 1n, den: 10n },
  /** 5 分钟缓存写。**比不开缓存还贵 25%**——这是 INV-11 那个坑的代价。 */
  cacheWrite5m: { num: 125n, den: 100n },
  /** 1 小时缓存写。 */
  cacheWrite1h: { num: 2n, den: 1n },
  /** Batch API 折扣。 */
  batch: { num: 1n, den: 2n },
  /** fast mode。买的是延迟，付的是钱。 */
  fast: { num: 2n, den: 1n },
} as const

export interface Mult {
  num: bigint
  den: bigint
}

/**
 * 一笔账：token 数 × 单价 × 倍率。
 *
 * 返回「微分 × 1e6」，不除。★ 倍率的除法也留到最后——
 * 先乘 num 再除 den 会引入舍入，而这里的 den 是 10 / 100 / 2 这种小数，
 * 连续几笔累加之后舍入误差刚好能让两种语言分道扬镳。
 */
export function charge(tokens: number, price: bigint, mult: Mult = { num: 1n, den: 1n }): Picofen {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new Error(`token 数必须是非负整数，收到 ${tokens}`)
  }
  return (BigInt(tokens) * price * mult.num) / mult.den
}

/**
 * 把「微分 × 1e6」格式化成元。
 *
 * ★ 手写定点输出，不用 toFixed。dp 位小数，向零截断（不是四舍五入）——
 * 截断的方向在两种语言里没有歧义，而四舍五入有。
 */
export function yuan(p: Picofen, dp = 6): string {
  // 微分×1e6 → 元：除 1e14。要保留 dp 位小数，先缩放到整数。
  const scale = 10n ** BigInt(14 - dp)
  const neg = p < 0n
  const scaled = (neg ? -p : p) / scale
  const s = scaled.toString().padStart(dp + 1, '0')
  const int = s.slice(0, s.length - dp)
  const frac = s.slice(s.length - dp)
  return `${neg ? '-' : ''}${int}${dp > 0 ? `.${frac}` : ''}`
}

// ─────────────────────────────────────────────────────────────
// 二、canonicalJson：一个函数干两件事
// ─────────────────────────────────────────────────────────────

/**
 * 规范化序列化：键排序、分隔符固定、数字格式固定。
 *
 * ★ 这个函数是这一节最划算的二十行，因为它同时解决两个**看起来毫不相关**
 * 的问题：
 *
 *   1. 让 verify 的双语言对拍能过。`JSON.stringify` 和 `json.dumps` 的默认
 *      分隔符不同（前者 `,` `:`，后者 `", "` `": "`），键序策略也不同。
 *
 *   2. 让你的工具定义**可缓存**。这是 Anthropic 官方的原话：
 *      "Verify that the keys in your `tool_use` content blocks have stable
 *       ordering as **some languages (for example, Swift, Go) randomize key
 *       order during JSON conversion, breaking caches**."
 *      以及 cache diagnostics 里 `tools_changed` 的成因之一：
 *      "tool `input_schema` JSON was **serialized non-deterministically**."
 *
 * 也就是说：**你为了让测试两边一致而必须做的事，正好就是让缓存命中必须做的事。**
 * 这不是巧合——两者要的是同一个性质：同样的语义产生同样的字节。
 */
/**
 * 字符串转义。
 *
 * ★ 为什么不直接用 `JSON.stringify`：它和 Python 的 `json.dumps` 在转义策略上
 * 不保证一致（非 ASCII 的处理、部分控制字符的写法、`json.dumps` 默认还会
 * 把非 ASCII 转成 `\uXXXX`）。这个函数的全部意义就是**同样的语义产生同样的
 * 字节**，所以它自己不能建立在一个各语言可以自由选择的行为上。
 */
function esc(s: string): string {
  let out = '"'
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return out + '"'
}

export function canonicalJson(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    // ★ 只接受整数。非整数的 str() 在两种语言里策略不同，而 schema 里
    // 根本用不上浮点——**拒绝**比悄悄产生一个不一致的字节串好得多。
    if (!Number.isInteger(v)) {
      throw new Error(`canonicalJson 不接受非整数 ${v}——它在两种语言里印法可能不同。用字符串或整数。`)
    }
    return String(v)
  }
  if (typeof v === 'string') return esc(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    // ★ 跳过值为 undefined 的键，和 JSON.stringify 一致。
    // 这一条对双语言对拍是必需的：Python 那边没有 undefined，
    // 对应的情况是「这个键不存在」——两边必须得出同一个字节串。
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
    const body = keys.map((k) => `${esc(k)}:${canonicalJson(o[k])}`).join(',')
    return `{${body}}`
  }
  throw new Error(`canonicalJson 不认识的类型：${typeof v}`)
}

// ─────────────────────────────────────────────────────────────
// 三、请求结构
// ─────────────────────────────────────────────────────────────

/**
 * 前缀的三层，顺序是**写死的**，不是我们选的。
 *
 * Anthropic 原文：
 *   "Cache prefixes are created in the following order: `tools`, `system`,
 *    then `messages`. This order forms a hierarchy where each level builds
 *    upon the previous ones."
 *   "**Changes at each level invalidate that level and all subsequent levels.**"
 *
 * 这一条决定了 firstDivergence 为什么只报最早的那一层。
 */
export type Layer = 'model' | 'tools' | 'system' | 'messages'

export const LAYER_ORDER: readonly Layer[] = ['model', 'tools', 'system', 'messages'] as const

export interface Block {
  type: string
  text?: string
  /** 显式断点。Anthropic 的 `cache_control: {type: 'ephemeral', ttl?: '1h'}`。 */
  cacheControl?: { ttl?: '5m' | '1h' }
  [k: string]: unknown
}

export interface ToolDef {
  name: string
  description: string
  inputSchema: unknown
}

export interface Req {
  model: string
  tools: ToolDef[]
  system: Block[]
  messages: Block[]
}

/**
 * 一个块参与前缀哈希的那部分。
 *
 * ★ `cacheControl` **不在里面**，这是刻意的。断点是一个请求参数，不是内容：
 * 官方说哈希覆盖的是「everything up to and including the breakpoint」的**内容**。
 * 把断点位置也算进哈希，你会得出「挪一下断点就等于改了 prompt」这个错误结论。
 */
function canonicalBlock(b: Block): string {
  const { cacheControl: _cc, text, ...rest } = b
  const d: Record<string, unknown> = { ...rest }
  if (text !== undefined) d.text = text
  return canonicalJson(d)
}

/** 一个块的 token 数。用 L08 那个显式粗估，不用 tiktoken（理由见 context.ts）。 */
export function blockTokens(b: Block): number {
  // ★ 不能只算 text。tool_use 的 input 和 tool_result 的 content 往往是
  // 上下文里最大的两块，漏掉它们会让预算系统性偏小（L08 那条纪律）。
  const { type, text, cacheControl: _cc, ...rest } = b
  let n = estimateTokens(type)
  if (text) n += estimateTokens(text)
  const extra = canonicalJson(rest)
  if (extra !== '{}') n += estimateTokens(extra)
  return n
}

export function toolTokens(t: ToolDef): number {
  return estimateTokens(t.name) + estimateTokens(t.description) + estimateTokens(canonicalJson(t.inputSchema))
}

/** 整个前缀的 token 数，按 tools → system → messages 的顺序。 */
export function prefixTokens(r: Req): number {
  return (
    r.tools.reduce((n, t) => n + toolTokens(t), 0) +
    r.system.reduce((n, b) => n + blockTokens(b), 0) +
    r.messages.reduce((n, b) => n + blockTokens(b), 0)
  )
}

// ─────────────────────────────────────────────────────────────
// 四、前缀失效定位器
// ─────────────────────────────────────────────────────────────

/**
 * 对标 Anthropic 的 cache diagnostics（beta header `cache-diagnosis-2026-04-07`）。
 * `type` 的取值直接照搬官方的 `cache_miss_reason.type`。
 */
export type Divergence =
  | { type: 'model_changed'; at: null; cacheMissedTokens: number }
  | { type: 'tools_changed'; at: number; cacheMissedTokens: number }
  | { type: 'system_changed'; at: number; cacheMissedTokens: number }
  | { type: 'messages_changed'; at: number; cacheMissedTokens: number }
  | { type: 'previous_message_not_found'; at: null; cacheMissedTokens: number }

/**
 * 找出**最早**的分歧点。
 *
 * ★ 「最早」这三个字是全部的重点。官方原文：
 *   "The response reports the **earliest divergence only**."
 * 因为哈希是累积的：
 *   "Because the hash is cumulative, covering everything up to and including
 *    the breakpoint, **changing any block at or before the breakpoint produces
 *    a different hash** on the next request."
 * 所以第一处分歧之后的一切都已经失效了，再往后找没有意义——
 * 一个把所有差异都列出来的实现不是更详细，是**没搞懂层级**。
 *
 * 返回 null 表示没有分歧（追加不算分歧）。
 */
export function firstDivergence(prev: Req, curr: Req): Divergence | null {
  const total = prefixTokens(curr)

  // 换模型：整个缓存都不能用，而且**不再检查其它层**。
  // 官方：cache diagnostics 有专门的 model_changed 类型，"The cache is per-model."
  if (prev.model !== curr.model) {
    return { type: 'model_changed', at: null, cacheMissedTokens: total }
  }

  // ★ 空历史是一个独立的状态，不是 messages_changed。
  // 官方的 previous_message_not_found 对应的就是「上一轮压根不在缓存里」。
  if (prev.tools.length === 0 && prev.system.length === 0 && prev.messages.length === 0) {
    return { type: 'previous_message_not_found', at: null, cacheMissedTokens: total }
  }

  // ★★ 注意这三次调用的最后一个参数。
  // 「追加不算分歧」**只在最后一层成立**。
  //
  // 往 messages 末尾追加一条，加的是整条前缀的末尾，前面每个位置的
  // 累积哈希都不变——所以不是分歧。
  // 但往**工具清单**末尾加一个工具，在整条前缀里是**中间插入**：
  // tools 排在 system 和 messages 前面，加一个工具会把后面所有东西位移，
  // 于是 system 和 messages 上的每个断点哈希全变。
  //
  // 这一条正好对上官方把「added」和「reordered」并列的措辞：
  //   "tools were **added, removed, or reordered** between turns"
  // 加一个工具和重排工具，后果是一样的——整个缓存作废。
  const toolsAt = firstDiffIndex(prev.tools.map(canonicalTool), curr.tools.map(canonicalTool), false)
  if (toolsAt !== null) {
    return {
      type: 'tools_changed',
      at: toolsAt,
      cacheMissedTokens: missedFrom(curr, 'tools', toolsAt),
    }
  }

  const sysAt = firstDiffIndex(prev.system.map(canonicalBlock), curr.system.map(canonicalBlock), false)
  if (sysAt !== null) {
    return {
      type: 'system_changed',
      at: sysAt,
      cacheMissedTokens: missedFrom(curr, 'system', sysAt),
    }
  }

  const msgAt = firstDiffIndex(prev.messages.map(canonicalBlock), curr.messages.map(canonicalBlock), true)
  if (msgAt !== null) {
    return {
      type: 'messages_changed',
      at: msgAt,
      cacheMissedTokens: missedFrom(curr, 'messages', msgAt),
    }
  }

  return null
}

/**
 * ★ 工具的规范化里**故意包含顺序无关的字段全部排序，但不排序工具本身**。
 *
 * 因为官方把「重排」明确列为失效原因：
 *   "tools were added, removed, or **reordered** between turns"
 * 也就是说：内容完全相同、只是顺序不同的两份工具清单，**缓存判定为不同**。
 * 这正是 L10 那个坑——`tools/list` 的顺序不稳定，账单上只表现为「input 变贵了」。
 */
function canonicalTool(t: ToolDef): string {
  return canonicalJson({ name: t.name, description: t.description, inputSchema: t.inputSchema })
}

/**
 * 第一处不同的下标。
 *
 * `appendIsBenign` 只对整条前缀的**最后一层**为真（见 firstDivergence 里的注释）。
 *
 * ★ 另一个方向也要注意：`curr` 比 `prev` **短**（截断）永远是分歧。
 * 追加和截断在 agent 里都很常见——追加是正常对话，截断是上下文压缩——
 * 而它们对缓存的后果**完全相反**。把两者等同处理的实现，会把每一次
 * 上下文压缩都报成「一切正常」，然后你看着成本上去却找不到原因。
 * 这正是 L08 那节压缩策略要付的隐性代价。
 */
function firstDiffIndex(a: string[], b: string[], appendIsBenign: boolean): number | null {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i
  }
  if (b.length === a.length) return null
  if (b.length < a.length) return b.length // 截断
  return appendIsBenign ? null : a.length // 追加
}

/** 分歧点之后（含）的 token 数。这是你这次要重新付钱的量。 */
function missedFrom(r: Req, layer: 'tools' | 'system' | 'messages', at: number): number {
  const toolsN = r.tools.reduce((n, t) => n + toolTokens(t), 0)
  const sysN = r.system.reduce((n, b) => n + blockTokens(b), 0)
  const msgN = r.messages.reduce((n, b) => n + blockTokens(b), 0)

  if (layer === 'tools') {
    const before = r.tools.slice(0, at).reduce((n, t) => n + toolTokens(t), 0)
    return toolsN - before + sysN + msgN
  }
  if (layer === 'system') {
    const before = r.system.slice(0, at).reduce((n, b) => n + blockTokens(b), 0)
    return sysN - before + msgN
  }
  const before = r.messages.slice(0, at).reduce((n, b) => n + blockTokens(b), 0)
  return msgN - before
}

// ─────────────────────────────────────────────────────────────
// 五、最低可缓存长度
// ─────────────────────────────────────────────────────────────

/**
 * ★ 这张表的形状是反直觉的：**不是模型越小门槛越低，也不随版本单调。**
 *
 * 官方清单（Prompt caching，抓取 2026-09-15），节选：
 *   512  —— Fable 5.1 / Mythos 5.1 / Opus 5 / Fable 5 / Mythos 5
 *   1024 —— Opus 4.8 / Sonnet 5 / Sonnet 4.6 / Sonnet 4.5 / Opus 4.1 / Opus 4 / Sonnet 4
 *   2048 —— Mythos Preview / Opus 4.7 / Haiku 3.5
 *   4096 —— Opus 4.6 / Opus 4.5 / **Haiku 4.5**
 *
 * 注意 Haiku 4.5 是 4096，比 Opus 5 的 512 高八倍。
 *
 * ★ 这就是「模型路由」和「prompt caching」正面打架的地方：
 * 你把简单任务路由到便宜的 Haiku 4.5 省钱，结果那个 1500-token 的
 * system prompt 在 Haiku 上**根本不够门槛**，于是每次全价——
 * 而它在 Opus 5 上是命中的。**路由省下的钱可能小于丢掉的缓存。**
 */
export const MIN_CACHEABLE: Record<string, number> = {
  'claude-fable-5-1': 512,
  'claude-mythos-5-1': 512,
  'claude-opus-5': 512,
  'claude-opus-4-8': 1024,
  'claude-sonnet-5': 1024,
  'claude-sonnet-4-6': 1024,
  'claude-opus-4-7': 2048,
  'claude-haiku-3-5': 2048,
  'claude-opus-4-6': 4096,
  'claude-opus-4-5': 4096,
  'claude-haiku-4-5': 4096,
  // 本课用的兼容端点：DeepSeek 自动缓存，官方没有公布门槛。
  // ★ 「没公布」不等于「没有」。写 0 会让判定器把「低于门槛」误判成「命中失败」。
  'deepseek-v4-flash': -1,
  'deepseek-v4-pro': -1,
}

/** 返回 -1 表示该 provider 没公布门槛——**这和「门槛是 0」是两件事**。 */
export function minCacheable(model: string): number {
  return MIN_CACHEABLE[model] ?? -1
}

// ─────────────────────────────────────────────────────────────
// 六、usage 四态判定器
// ─────────────────────────────────────────────────────────────

/**
 * 五种 provider 的 usage 字段形状完全不同，而且有两处**语义陷阱**。
 * 归一化表来自各家官方文档（访问 2026-09-15）。
 */
export type ProviderShape =
  | 'anthropic'
  | 'openai-responses'
  | 'azure-chat'
  | 'deepseek'
  | 'anthropic-openai-compat'

export type Verdict = 'HIT' | 'WRITE_ONLY' | 'MISS' | 'BELOW_MINIMUM' | 'UNDETERMINABLE'

export interface CacheReport {
  verdict: Verdict
  readTokens: number
  writeTokens: number
  /** 整个请求的输入 token 总数。★ 注意它在 Anthropic 上不等于 input_tokens。 */
  totalInput: number
  reason: string
}

const n0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const has = (o: Record<string, unknown> | undefined, k: string): boolean =>
  o !== undefined && o !== null && typeof o[k] === 'number'

/**
 * 判定缓存到底生效了没有。
 *
 * 判定规则来自三条官方陈述：
 *
 *   A（Anthropic）："if both `cache_creation_input_tokens` and
 *      `cache_read_input_tokens` are 0, the prompt was not cached"
 *   B（OpenAI）："When `cached_tokens` is greater than zero and
 *      `cache_write_tokens` is zero, your request fully matched an existing
 *      cache entry — no new writes occurred"
 *   C（Anthropic fast mode）：usage 里带 `speed` 字段回报实际用的档位——
 *      同构的「静默降级检测」。
 *
 * ★ 官方的判定法**全部是读字段，没有一家建议看响应时间**。
 * 用 TTFT 判断缓存是错的：噪声大，而且那正是第八节要讲的那条侧信道——
 * 你在教自己用攻击手法做监控。
 */
export function cacheVerdict(
  shape: ProviderShape,
  usage: Record<string, unknown>,
  model: string,
  /** 前缀 token 数。只在判 BELOW_MINIMUM 时用得到。 */
  promptTokens?: number,
): CacheReport {
  let read = 0
  let write = 0
  let total = 0
  let fieldsPresent = false
  let noWriteConcept = false

  switch (shape) {
    case 'anthropic': {
      read = n0(usage.cache_read_input_tokens)
      write = n0(usage.cache_creation_input_tokens)
      fieldsPresent =
        usage.cache_read_input_tokens !== undefined && usage.cache_read_input_tokens !== null
      // ★★ 这一行是这个函数里最容易写错的一行。
      // Anthropic 的 `input_tokens` **只是最后一个断点之后的 token 数**，
      // 不是总输入。总输入 = input_tokens + cache_read + cache_creation。
      // 一个直接把 input_tokens 当总输入的实现，会把命中率算成一个
      // 看起来合理但完全错误的数字（而且是偏小的方向——显得缓存没用）。
      total = n0(usage.input_tokens) + read + write
      break
    }
    case 'openai-responses': {
      const d = usage.input_tokens_details as Record<string, unknown> | undefined
      read = n0(d?.cached_tokens)
      write = n0(d?.cache_write_tokens)
      fieldsPresent = has(d, 'cached_tokens')
      // OpenAI 的 input_tokens **已经包含**缓存部分，不要再加。
      total = n0(usage.input_tokens)
      break
    }
    case 'azure-chat': {
      const d = usage.prompt_tokens_details as Record<string, unknown> | undefined
      read = n0(d?.cached_tokens)
      write = n0(d?.cache_write_tokens)
      fieldsPresent = has(d, 'cached_tokens')
      total = n0(usage.prompt_tokens)
      break
    }
    case 'deepseek': {
      read = n0(usage.prompt_cache_hit_tokens)
      write = 0
      // ★ DeepSeek **没有「缓存写入」这个概念**——它的缓存是自动的，
      // 不区分写入阶段。所以 write=0 是正确答案，不是「缺数据」。
      // 把它判成 UNDETERMINABLE 是错的：它的 read 字段是有的，能判。
      noWriteConcept = true
      fieldsPresent = usage.prompt_cache_hit_tokens !== undefined
      total = n0(usage.prompt_cache_hit_tokens) + n0(usage.prompt_cache_miss_tokens)
      break
    }
    case 'anthropic-openai-compat': {
      // ★ Anthropic 自己的 OpenAI 兼容层：
      //   "`usage.prompt_tokens_details`: **Always empty**"
      // 也就是说，唯一能告诉你缓存有没有生效的信号**被这条端点擦掉了**。
      // 这不是「没命中」，是「不可知」。
      total = n0(usage.prompt_tokens)
      return {
        verdict: 'UNDETERMINABLE',
        readTokens: 0,
        writeTokens: 0,
        totalInput: total,
        reason:
          '这条端点的 usage.prompt_tokens_details 恒为空（Anthropic 官方原话 "Always empty"）——' +
          '缓存可能在跑也可能没跑，但你从响应里看不出来。不要把它当成未命中去"优化"。',
      }
    }
  }

  if (!fieldsPresent) {
    return {
      verdict: 'UNDETERMINABLE',
      readTokens: 0,
      writeTokens: 0,
      totalInput: total,
      reason: '响应里没有缓存字段。可能是兼容层剥掉了，也可能是 SDK 版本旧——但都不能当作未命中。',
    }
  }

  if (read > 0) {
    // ★ 百分比也走整数：*1000 四舍五入到十分位，再手写小数点。
    // 写成 `Math.round(read / total * 1000) / 10` 会印出 "90" 而不是 "90.0"，
    // 而 Python 那边的整数版本印的是 "90.0"——对拍就在这里断。
    // 这一节自己讲的纪律，在自己的代码里也得守。
    const pctTenths = total > 0 ? Math.floor((read * 1000 + Math.floor(total / 2)) / total) : 0
    const pct = `${Math.floor(pctTenths / 10)}.${pctTenths % 10}`
    return {
      verdict: 'HIT',
      readTokens: read,
      writeTokens: write,
      totalInput: total,
      reason: `命中 ${read}/${total} token（${pct}%）${write > 0 ? '，同时写了新断点' : '，无新写入——这是最省的形状'}`,
    }
  }

  if (write > 0) {
    return {
      verdict: 'WRITE_ONLY',
      readTokens: 0,
      writeTokens: write,
      totalInput: total,
      reason:
        `只写不读 ${write} token。★ 第一次是正常的，**连续两次就是 bug**——` +
        '你在每次请求都付 1.25 倍的写入费而一次读都没拿到，比不开缓存还贵 25%。' +
        '最常见的成因是断点后面挂了个每次都变的东西（时间戳、随机 id）。',
    }
  }

  const floor = minCacheable(model)
  if (floor > 0 && promptTokens !== undefined && promptTokens < floor) {
    return {
      verdict: 'BELOW_MINIMUM',
      readTokens: 0,
      writeTokens: 0,
      totalInput: total,
      reason:
        `前缀 ${promptTokens} token < ${model} 的最低门槛 ${floor}。` +
        'Anthropic 官方："processed without caching, and **no error is returned**"。' +
        '★ 这不是你的代码写错了，是这段前缀太短，不值得缓存——加断点也没用。',
    }
  }

  return {
    verdict: 'MISS',
    readTokens: 0,
    writeTokens: 0,
    totalInput: total,
    reason: noWriteConcept
      ? '未命中。该 provider 不区分缓存写入，所以 write=0 是正常的，不代表缺数据。'
      : '未命中，且没有写入。前缀变了或者缓存已过期——用 firstDivergence 区分这两种，它们要采取的行动完全不同。',
  }
}

// ─────────────────────────────────────────────────────────────
// 七、断点与 lookback：一个状态机
// ─────────────────────────────────────────────────────────────

/**
 * ★ 这一节要纠正一个极其常见的误解，Anthropic 专门写了一节叫 "Common mistake"：
 *
 *   "Cache reads look backward for entries that prior requests wrote. …
 *    **It is looking for prior writes, not for stable content.**"
 *   "**The lookback does not find stable content behind your breakpoint and
 *    cache it.** It finds entries that prior requests already wrote, and
 *    writes happen only at breakpoints."
 *
 * 换句话说：lookback 不会帮你找「看起来稳定的内容」。它只找**之前写过的条目**。
 * 断点放在一个每次都变的块上，结果就是官方原文里那句：
 *   "**You pay for a fresh cache write on every request and never get a read.**"
 *
 * 代价是 +25%，而日志上完全正常。
 */
export const LOOKBACK = 20
export const MAX_BREAKPOINTS = 4

export interface CacheEntry {
  /** 写在第几个位置（1-based，和官方例子对齐）。 */
  position: number
  /** 前缀哈希。这里用规范化字符串代替真哈希——性质一样，且可读。 */
  hash: string
}

export interface TurnResult {
  hitAt: number | null
  wroteAt: number | null
  freshBlocks: number
  note: string
}

/**
 * 模拟一轮的缓存读写。
 *
 * `positions` 是**归并后**的位置序列，不是原始 block 序列。
 * ★ 归并规则来自官方：
 *   "a run of consecutive `tool_use` blocks counts as one position, and so
 *    does a run of consecutive `tool_result` blocks, so a turn with many
 *    parallel tool calls doesn't push the previous request's entry out of
 *    the window on its own."
 * 不做这个归并，一次 8 个并行工具调用就能把上一轮的条目挤出窗口——
 * 而真实系统不会。
 */
export function mergePositions(blocks: Block[]): Block[] {
  const out: Block[] = []
  for (const b of blocks) {
    const last = out[out.length - 1]
    const runnable = b.type === 'tool_use' || b.type === 'tool_result'
    if (last && runnable && last.type === b.type) continue
    out.push(b)
  }
  return out
}

export function simulateTurn(
  /** 归并后的位置序列，每个元素是该位置的累积前缀哈希。 */
  hashes: string[],
  /** 断点位置（1-based）。 */
  breakpoints: number[],
  /** 之前写过的条目。会被这次的写入原地更新。 */
  store: CacheEntry[],
): TurnResult {
  if (breakpoints.length > MAX_BREAKPOINTS) {
    throw new Error(
      `断点 ${breakpoints.length} 个，上限 ${MAX_BREAKPOINTS}。` +
        'Anthropic 官方：超了会返回 400，而且自动缓存也要占一个名额。',
    )
  }
  const bp = breakpoints[breakpoints.length - 1]
  if (bp === undefined) return { hitAt: null, wroteAt: null, freshBlocks: hashes.length, note: '没有断点，不写也不读' }

  // 读：从断点开始往回走，最多 LOOKBACK 个位置（含断点自己）。
  let hitAt: number | null = null
  for (let i = 0; i < LOOKBACK; i++) {
    const pos = bp - i
    if (pos < 1) break
    const h = hashes[pos - 1]
    if (h !== undefined && store.some((e) => e.position === pos && e.hash === h)) {
      hitAt = pos
      break
    }
  }

  // 写：**只在断点上写一个条目**。不给任何更早的位置写。
  const bpHash = hashes[bp - 1]
  let wroteAt: number | null = null
  if (bpHash !== undefined && !store.some((e) => e.position === bp && e.hash === bpHash)) {
    store.push({ position: bp, hash: bpHash })
    wroteAt = bp
  }

  const fresh = hitAt === null ? hashes.length : hashes.length - hitAt
  return {
    hitAt,
    wroteAt,
    freshBlocks: fresh,
    note:
      hitAt === null
        ? `未命中：窗口内（位置 ${Math.max(1, bp - LOOKBACK + 1)}–${bp}）没有之前写过的条目`
        : `命中于位置 ${hitAt}，只需新算 ${fresh} 个位置`,
  }
}

// ─────────────────────────────────────────────────────────────
// 八、混合 TTL 计费
// ─────────────────────────────────────────────────────────────

/**
 * 官方给的三点式公式，直接实现。原文：
 *
 *   "1. Position `A`: The token count at the highest cache hit (or 0 if no hits).
 *    2. Position `B`: The token count at the highest 1-hour `cache_control`
 *       block after `A` (or equals `A` if none exist).
 *    3. Position `C`: The token count at the last `cache_control` block.
 *    You'll be charged for:
 *    1. Cache read tokens for `A`.
 *    2. 1-hour cache write tokens for `(B - A)`.
 *    3. 5-minute cache write tokens for `(C - B)`."
 *
 * 以及那条约束：
 *   "**Cache entries with longer TTL must appear before shorter TTLs**"
 */
export interface MixedTtlBill {
  readTokens: number
  write1hTokens: number
  write5mTokens: number
  picofen: Picofen
}

export function mixedTtlBill(a: number, b: number, c: number, price: Price): MixedTtlBill {
  if (!(a <= b && b <= c)) {
    throw new Error(
      `位置必须满足 A ≤ B ≤ C，收到 A=${a} B=${b} C=${c}。` +
        'Anthropic 官方约束：1 小时的条目必须排在 5 分钟的前面。顺序反了，这个账就算不出来。',
    )
  }
  const read = a
  const w1h = b - a
  const w5m = c - b
  return {
    readTokens: read,
    write1hTokens: w1h,
    write5mTokens: w5m,
    picofen:
      charge(read, price.inputMiss, MULT.cacheRead) +
      charge(w1h, price.inputMiss, MULT.cacheWrite1h) +
      charge(w5m, price.inputMiss, MULT.cacheWrite5m),
  }
}

// ─────────────────────────────────────────────────────────────
// 九、确定性随机：自己写的 LCG
// ─────────────────────────────────────────────────────────────

/**
 * ★ 不能用 Math.random() / random.random()：即使同种子，两种语言的
 * 序列也不同。退避的 jitter 需要随机，而 verify 需要确定——
 * 唯一的出路是自己实现一个两边逐位一致的。
 *
 * 数值参数取自 Numerical Recipes 的 32 位 LCG。
 */
export class Lcg {
  private s: number

  constructor(seed = 1) {
    this.s = seed >>> 0
  }

  /** 下一个 32 位无符号整数。 */
  next(): number {
    // s*1664525 最大约 7.1e15 < 2^53，所以在 double 里是精确的。
    this.s = (this.s * 1664525 + 1013904223) >>> 0
    return this.s
  }

  /**
   * [0, n) 的整数。
   *
   * ★★ 这里**不能写 `next() % n`**，而这个坑值得单独记一笔，因为我第一版
   * 就是那么写的，而且它产生的错误结论看起来完全合理。
   *
   * 线性同余发生器的**低位周期极短**：模 2^32 的 LCG，第 k 位的周期只有
   * 2^(k+1)——最低位就是 0、1、0、1 地交替。而 `% 2` 取的正好是最低位。
   *
   * 后果：拿它给一个「一半 easy 一半 hard」的任务列表做路由决策时，
   * 任务的奇偶和随机数的奇偶完全同步，于是「随机路由」和「反着判的路由」
   * 算出来**一模一样的账**。曲线看着挺像那么回事，结论是错的。
   *
   * 正确做法是用**高位**：把 32 位随机数当成 [0,1) 的定点小数去乘 n，
   * 再右移 32 位。全程整数，两种语言逐位一致。
   */
  int(n: number): number {
    if (n <= 0) throw new Error('上界必须为正')
    return Number((BigInt(this.next()) * BigInt(n)) >> 32n)
  }
}

// ─────────────────────────────────────────────────────────────
// 十、限流：token bucket
// ─────────────────────────────────────────────────────────────

/**
 * ★ 为什么是连续补充的桶，而不是固定窗口。Anthropic 官方原文：
 *
 *   "a rate of 60 RPM might be enforced as 1 request per second"
 *
 * 也就是说 **60 RPM 不等于「这一分钟里随便怎么发 60 个」**。
 * 一个按固定窗口实现的客户端限流器，会在每分钟开头突发 60 个请求，
 * 然后拿到一串 429——而它自己的计数器显示「没超」。
 */
export interface LimiterOptions {
  /** 桶容量。 */
  capacity: number
  /** 每秒补充多少令牌。60 RPM → 1。 */
  refillPerSec: number
}

export type LimitOutcome =
  | { allowed: true; tokens: string }
  | { allowed: false; retryAfterMs: number; tokens: string }

/** 1 令牌 = 1000 毫令牌。★ 桶也走整数，理由和金额一样：双语言对拍。 */
const MILLI = 1000

export class Limiter {
  /** 单位：毫令牌。整数。 */
  private milli: number
  private lastMs: number

  constructor(
    private readonly opts: LimiterOptions,
    /** ★ 注入的时钟，毫秒整数。不用 Date.now()——那样测试就不确定了。 */
    startMs = 0,
  ) {
    this.milli = opts.capacity * MILLI
    this.lastMs = startMs
  }

  /** 当前令牌数，保留三位小数的字符串。★ 不返回浮点，免得两种语言印得不一样。 */
  get level(): string {
    const i = Math.floor(this.milli / MILLI)
    const f = String(this.milli % MILLI).padStart(3, '0')
    return `${i}.${f}`
  }

  /**
   * 尝试取一个令牌。
   *
   * ★ 注意这个方法**没有「请求成功了吗」这个参数**，这是故意的：
   * 失败的请求也消耗令牌。官方明确说明限额是按**请求**计的，不是按成功计的。
   * 一个「失败不算」的重试循环会在限流面前原地爆炸。
   */
  take(nowMs: number): LimitOutcome {
    const elapsed = nowMs - this.lastMs
    if (elapsed < 0) throw new Error('时钟倒流了。注入的时钟必须单调不减。')
    // elapsed(ms) × refill(令牌/秒) 正好就是毫令牌数——整数乘法，无舍入。
    this.milli = Math.min(this.opts.capacity * MILLI, this.milli + elapsed * this.opts.refillPerSec)
    this.lastMs = nowMs

    if (this.milli >= MILLI) {
      this.milli -= MILLI
      return { allowed: true, tokens: this.level }
    }
    const needMilli = MILLI - this.milli
    return {
      allowed: false,
      // 向上取整：差一点也要等满。整数除法写成 ceil 的等价形式。
      retryAfterMs: Math.ceil(needMilli / this.opts.refillPerSec),
      tokens: this.level,
    }
  }
}

/**
 * 超限有三种，**要采取的行动完全不同**。把它们混为一谈是这一节最贵的 bug：
 * 对一个「花费上限已到」的错误做指数退避重试，你会在那里转到超时，
 * 而它永远不会成功。
 */
export type OverLimitKind =
  | { kind: 'rate'; retryAfterMs: number }
  | { kind: 'spend_limit' }
  | { kind: 'self_imposed' }

export function shouldRetry(o: OverLimitKind): boolean {
  // ★ 只有真正的速率限制值得重试。
  return o.kind === 'rate'
}

/** 带 jitter 的指数退避。jitter 用 LCG，所以 verify 里是确定的。 */
export function backoffMs(attempt: number, rng: Lcg, baseMs = 500, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt)
  // full jitter：[0, exp)。官方推荐加抖动以免重试自己形成尖峰。
  return rng.int(exp)
}

// ─────────────────────────────────────────────────────────────
// 十一、路由：成本与质量两条曲线
// ─────────────────────────────────────────────────────────────

/**
 * ★ 路由器是一个**分类器**，所以它会错分。而这一节的教学目标不是
 * 「训一个路由器」——RouteLLM 用了 8 万条 Chatbot Arena 对战数据，
 * 训出来的 BERT router 在 GSM8K 上**还是不如随机**。
 *
 * 所以这里把**错分率当输入**，让你算「这个错分率下账变成什么样」。
 * 这才是工程师要会的那件事。
 */
export interface Router {
  /** P(判为 hard | 真的 hard)。用整数分数，不用浮点。 */
  hardGivenHard: Mult
  /** P(判为 hard | 其实 easy)。 */
  hardGivenEasy: Mult
}

export interface Task {
  id: string
  trueDifficulty: 'easy' | 'hard'
  inputTokens: number
  outputTokens: number
}

export interface RouteOutcome {
  /** 总花费。 */
  picofen: Picofen
  /** 答对的任务数 / 总数。用整数分数避免浮点。 */
  solved: number
  total: number
  /** 因为错判到弱模型、失败后重试到强模型的次数。 */
  retries: number
  /** 因为换模型而打掉的缓存次数。 */
  cacheBreaks: number
  /** 前缀命中的次数。cacheBreaks + prefixReads 才是前缀被计费的总次数。 */
  prefixReads: number
}

/**
 * 算一遍这个路由器下的总账。
 *
 * ★ 三条容易漏的，每一条都改变结论：
 *
 *   1. **重试要算钱。** 一个 hard 任务被错判到弱模型 → 失败 → 重试到强模型，
 *      总成本 = 弱模型一次 + 强模型一次，**比直接用强模型更贵**。
 *      路由省钱的前提是错分率足够低，不是「便宜模型单价低」。
 *
 *   2. **换模型会打掉缓存。** cache diagnostics 有专门的 model_changed。
 *      一个在两个模型之间来回跳的路由器，缓存命中率是 0。
 *
 *   3. **基线是随机路由，不是「全用便宜模型」。** 一个
 *      hardGivenHard == hardGivenEasy 的路由器没有任何信息量，
 *      它的曲线必须和随机重合——如果你的实现让它看起来更好，是实现错了。
 */
export function routeOutcome(
  tasks: Task[],
  router: Router,
  weak: { model: string; price: Price },
  strong: { model: string; price: Price },
  rng: Lcg,
  /**
   * 共享前缀的 token 数（system + 工具定义）。
   *
   * ★ 给了它，这个函数才会把**缓存**算进账里，而这一项常常反转结论：
   * 换模型 → cache diagnostics 报 `model_changed` → 这段前缀重新全价写入；
   * 不换模型 → 0.1 倍读出来。一个在两个模型之间抖动的路由器，
   * 每一步都在付 1.25 倍的写入费。
   *
   * 不给（0）就只算任务本身的 token——那是大多数「路由能省 N 倍」
   * 的文章算的账，也是它们把收益算高的地方。
   */
  cachedPrefixTokens = 0,
  /**
   * 每隔多少个任务才重新做一次路由决策（决策在块内保持）。
   *
   * ★ 这个参数是这一节路由部分真正的结论所在。
   *
   * `1` = 每个请求都重新选模型。在有大共享前缀的场景下这是灾难：
   * 每次换模型都是一次 `model_changed`，整段前缀重新全价写入，
   * 而前缀往往比任务本身大一个数量级。
   *
   * `10` = 按会话粒度路由。同一个会话里不换模型，于是前缀写一次读九次。
   *
   * 所以「路由能不能省钱」这个问题问得不对。该问的是
   * **「在哪个粒度上路由」**——同一个路由器，粒度不同，结论能反过来。
   */
  stickyEvery = 1,
): RouteOutcome {
  if (stickyEvery < 1) throw new Error('stickyEvery 至少是 1')
  let picofen = 0n
  let solved = 0
  let retries = 0
  let cacheBreaks = 0
  let prefixReads = 0
  let lastModel: string | null = null
  /** 块内保持的决策。 */
  let held: boolean | null = null

  /** 算一次前缀的钱：和上一次同模型就是命中，否则是写入。 */
  const prefixCharge = (model: string, price: Price): Picofen => {
    if (cachedPrefixTokens === 0) return 0n
    const same = lastModel === model
    if (same) {
      prefixReads++
      return charge(cachedPrefixTokens, price.inputMiss, MULT.cacheRead)
    }
    if (lastModel !== null) cacheBreaks++
    return charge(cachedPrefixTokens, price.inputMiss, MULT.cacheWrite5m)
  }

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!
    // ★ 只在块的第一个任务上做决策，块内沿用。
    // 注意副作用：块内那些「真实难度和块首不同」的任务会被放到错的模型上——
    // 粘性路由用**准确率**换**缓存命中**，不是免费的。
    if (i % stickyEvery === 0 || held === null) {
      const p = t.trueDifficulty === 'hard' ? router.hardGivenHard : router.hardGivenEasy
      // 判为 hard 的概率 = p.num / p.den。用 LCG 取整数比较，不引入浮点。
      const roll = rng.int(Number(p.den))
      held = roll < Number(p.num)
    }
    const toStrong = held
    const chosen = toStrong ? strong : weak

    picofen += prefixCharge(chosen.model, chosen.price)
    lastModel = chosen.model
    picofen += charge(t.inputTokens, chosen.price.inputMiss) + charge(t.outputTokens, chosen.price.output)

    if (t.trueDifficulty === 'easy' || toStrong) {
      // easy 任务弱模型也能做对；hard 任务上了强模型也做对。
      solved++
      continue
    }

    // hard 任务被错判给了弱模型：失败，重试到强模型。
    // ★ 这一次重试**连前缀一起重付**——而且必然是一次 model_changed。
    retries++
    picofen += prefixCharge(strong.model, strong.price)
    lastModel = strong.model
    picofen += charge(t.inputTokens, strong.price.inputMiss) + charge(t.outputTokens, strong.price.output)
    solved++
  }

  return { picofen, solved, total: tasks.length, retries, cacheBreaks, prefixReads }
}

/**
 * 全用强模型的对照。路由的价值只能相对它来衡量。
 *
 * ★ `cachedPrefixTokens` 必须和 routeOutcome 用同一个值，否则这个对比就是
 * 拿苹果比橘子——而这是「路由能省 N 倍」那类文章最常犯的错。
 *
 * 而且注意这个基线在缓存上是**最优**的：全程不换模型，所以前缀写一次、
 * 之后每次 0.1 倍读出来。任何会切模型的路由器都拿不到这个待遇。
 * 这就是「路由和缓存打架」的准确含义。
 */
export function allStrong(tasks: Task[], strong: { price: Price }, cachedPrefixTokens = 0): Picofen {
  let total = 0n
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!
    if (cachedPrefixTokens > 0) {
      total +=
        i === 0
          ? charge(cachedPrefixTokens, strong.price.inputMiss, MULT.cacheWrite5m)
          : charge(cachedPrefixTokens, strong.price.inputMiss, MULT.cacheRead)
    }
    total += charge(t.inputTokens, strong.price.inputMiss) + charge(t.outputTokens, strong.price.output)
  }
  return total
}

// ─────────────────────────────────────────────────────────────
// 十二、一个按真规则算账的假端点
// ─────────────────────────────────────────────────────────────

/**
 * ★ 这个类是这一节的实验台，而它的存在理由和 shared/fake.ts 一样：
 *
 *   **能用假的测的东西，就不要用真的测。**（L12 那条纪律）
 *
 * 但这里还有一个更强的理由。你想验证「system prompt 里插一个时间戳会让
 * 缓存永远命不中」，真端点**不会配合你演这一出**——它会受时段、负载、
 * 并发邻居影响，你跑十次能得到十个不同的命中率，然后分不清是你的假设错了
 * 还是今天网络差。
 *
 * 这个假端点按官方公布的规则算账：前缀逐字节比较、断点只在标记处写、
 * 低于门槛静默不缓存、并且**按各家的字段名输出**。于是：
 *   · 数字是自洽的（usage 是从请求算出来的，不是编的）
 *   · 改一个字符，账立刻变，因果关系看得见
 *   · verify 里一次模型都不用调
 */
export class FakeEndpoint {
  /** 写过的条目：断点处的前缀规范化字符串 → 该处的 token 数。 */
  private readonly store = new Map<string, number>()

  constructor(
    private readonly shape: ProviderShape,
    private readonly model: string,
  ) {}

  /**
   * 发一次请求，返回**该 provider 形状的** usage。
   *
   * 命中判定就是官方那句话的直译：
   *   "Cache hits require 100% identical prompt segments, including all text
   *    and images up to and including the block marked with cache control."
   */
  send(req: Req, outputTokens: number): Record<string, unknown> {
    const total = prefixTokens(req)
    const { key, tokens: upto } = this.breakpointPrefix(req)

    let read = 0
    let write = 0

    const floor = minCacheable(this.model)
    const eligible = floor < 0 || upto >= floor

    if (eligible) {
      if (this.store.has(key)) {
        read = this.store.get(key)!
      } else {
        write = upto
        this.store.set(key, upto)
      }
    }
    // ★ 不合格的时候什么都不做，**也不报错**。这正是官方那句
    // "processed without caching, and no error is returned" 的行为。

    return this.shapeUsage(total, read, write, outputTokens)
  }

  /**
   * 断点处的累积前缀，以及它覆盖多少 token。
   *
   * 没有显式断点时按**自动缓存**处理：断点落在最后一个可缓存块上。
   * ★ 官方特别提醒自动缓存会掉进同一个坑：
   *   "it places the breakpoint on the last cacheable block, which in this
   *    structure is the one that changes every request"
   */
  private breakpointPrefix(req: Req): { key: string; tokens: number } {
    const parts: string[] = [`model=${req.model}`]
    let tokens = 0

    for (const t of req.tools) {
      parts.push(canonicalJson({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      tokens += toolTokens(t)
    }

    // 找显式断点：system 然后 messages，取最后一个。
    const flat: { block: Block; layer: 'system' | 'messages' }[] = [
      ...req.system.map((b) => ({ block: b, layer: 'system' as const })),
      ...req.messages.map((b) => ({ block: b, layer: 'messages' as const })),
    ]
    let lastBp = -1
    for (let i = 0; i < flat.length; i++) {
      if (flat[i]!.block.cacheControl !== undefined) lastBp = i
    }
    const end = lastBp >= 0 ? lastBp : flat.length - 1

    for (let i = 0; i <= end; i++) {
      const b = flat[i]!.block
      // ★ 用 canonicalBlock，它会把 cacheControl 排除掉——断点是请求参数，
      // 不是内容。算进哈希就会得出「挪一下断点等于改了 prompt」这个错结论。
      parts.push(canonicalBlock(b))
      tokens += blockTokens(b)
    }

    return { key: parts.join('|'), tokens }
  }

  /** 按各家的字段名输出。★ 字段名不同不是细节——它决定了你能不能判定。 */
  private shapeUsage(
    total: number,
    read: number,
    write: number,
    out: number,
  ): Record<string, unknown> {
    switch (this.shape) {
      case 'anthropic':
        return {
          // ★ Anthropic 的 input_tokens 只是断点之后的那部分。
          input_tokens: total - read - write,
          cache_read_input_tokens: read,
          cache_creation_input_tokens: write,
          output_tokens: out,
        }
      case 'openai-responses':
        return {
          input_tokens: total,
          input_tokens_details: { cached_tokens: read, cache_write_tokens: write },
          output_tokens: out,
        }
      case 'azure-chat':
        return {
          prompt_tokens: total,
          prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write },
          completion_tokens: out,
        }
      case 'deepseek':
        // 没有「写入」这个概念。
        return {
          prompt_cache_hit_tokens: read,
          prompt_cache_miss_tokens: total - read,
          output_tokens: out,
        }
      case 'anthropic-openai-compat':
        // ★ 缓存字段被擦掉了。缓存**可能照样在跑**，但你看不见。
        return { prompt_tokens: total, completion_tokens: out }
    }
  }
}
