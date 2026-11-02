/**
 * Prompt 拼装。L03 的核心主张是「prompt 是代码」，那它就得有类型、能测、拼错要报错。
 *
 * 这个模块只做三件事，但每一件都对应一个真实咬过人的失败模式：
 *
 *   1. fill()   —— 模板变量漏传要**抛错**，不能静默留下 {cwd} 字面量
 *   2. section()—— 结构化标签，空内容整段省掉，不留空壳
 *   3. build()  —— 按顺序拼，稳定的在前（L02 的缓存纪律）
 *
 * 最值得注意的是第 1 条。没渲染的占位符是最尴尬的一类 bug：
 * 不报错、不崩溃，模型只是收到一句它看不懂的话，然后表现变差。
 * 你会去调措辞，而问题根本不在措辞。
 */

/** 匹配 {name} 形式的占位符。故意不支持嵌套和表达式——模板里能算东西是灾难的开始。 */
const PLACEHOLDER = /\{(\w+)\}/g

export class PromptVarError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
    readonly unused: string[] = [],
  ) {
    super(message)
    this.name = 'PromptVarError'
  }
}

/**
 * 严格渲染。缺变量抛错，多传变量也抛错。
 *
 * 「多传也抛错」是故意的，很多人第一反应觉得多余。理由：
 * 多出来的那个变量通常意味着你**改了模板但忘了改调用方**（或者反过来）。
 * 它是一个免费的一致性检查，不用白不用。
 */
export function fill(template: string, vars: Record<string, string | number>): string {
  const used = new Set<string>()
  const missing: string[] = []

  const out = template.replace(PLACEHOLDER, (_, name: string) => {
    used.add(name)
    const v = vars[name]
    if (v === undefined || v === null) {
      missing.push(name)
      return ''
    }
    return String(v)
  })

  const unused = Object.keys(vars).filter((k) => !used.has(k))

  if (missing.length > 0 || unused.length > 0) {
    const parts: string[] = []
    if (missing.length > 0) parts.push(`模板需要但没传：${missing.join(', ')}`)
    if (unused.length > 0) parts.push(`传了但模板没用到：${unused.join(', ')}`)
    throw new PromptVarError(parts.join('；'), missing, unused)
  }

  return out
}

/**
 * 渲染之后再查一遍有没有漏网的占位符。防的是模板里写了 {max steps} 这种
 * PLACEHOLDER 的 \w+ 匹配不到、于是一路活到模型眼前的形式。
 *
 * 这里的正则比「找一对花括号」讲究得多，原因是一个必须避开的误报：
 * `<output_format>` 段里几乎一定会出现 {"task": string, "owner": string}
 * 这种形状说明。粗暴地匹配 /\{[^}]+\}/ 会把它当成未渲染的占位符，
 * 于是这个检查在最该用它的地方反而拦住了正确的 prompt。
 *
 * 所以判据收紧成「长得像变量名」：紧跟 { 的必须是字母或下划线，
 * 中间只允许字母数字、空格、点、连字符。带引号和冒号的 JSON 形状因此天然被排除。
 */
const LEFTOVER = /\{[A-Za-z_][\w .-]{0,30}\}/g

export function assertRendered(text: string): void {
  const left = text.match(LEFTOVER)
  if (left) {
    throw new PromptVarError(`渲染完还剩占位符：${[...new Set(left)].join(', ')}`)
  }
}

export interface Section {
  tag: string
  /** 字符串原样放；数组渲染成编号列表——编号是为了能在日志和 eval 里引用「违反了规则 3」。 */
  body: string | string[] | undefined | null
}

/**
 * 渲染一段带标签的结构。
 *
 * 空内容返回空字符串（整段省掉），而不是留一个 <rules></rules> 空壳。
 * 空壳有实际害处：模型会试图理解「为什么这里是空的」，而且它照样占 token。
 */
export function section({ tag, body }: Section): string {
  if (body === undefined || body === null) return ''

  const inner = Array.isArray(body)
    ? body
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s, i) => `${i + 1}. ${s}`)
        .join('\n')
    : body.trim()

  if (!inner) return ''
  return `<${tag}>\n${inner}\n</${tag}>`
}

/** 按给定顺序拼装。顺序就是缓存边界，稳定的放前面。 */
export function build(sections: Section[]): string {
  return sections
    .map(section)
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 包一段不可信的外部内容。
 *
 * 这个函数存在的理由是 L14 的前置：用户提供的内容里可以写一个假的闭合标签，
 * 把你的结构提前关掉，后面的文字就从「数据」变成了「指令」。
 *
 * 这里的处理很朴素——把内容里出现的同名闭合标签打断。它**不是**安全边界，
 * 只是把「一行注释就能越狱」的门槛抬高一点。真正的边界在工具权限层。
 */
export function wrapUntrusted(tag: string, content: string, attrs?: Record<string, string>): string {
  const attrStr = attrs
    ? Object.entries(attrs)
        .map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`)
        .join('')
    : ''
  const defused = content.replaceAll(`</${tag}>`, `<\u200b/${tag}>`)
  return `<${tag}${attrStr}>\n${defused}\n</${tag}>`
}
