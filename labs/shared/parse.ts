/**
 * 从模型输出里把结构化数据抠出来。
 *
 * 为什么需要这个模块，而不是直接 JSON.parse：
 * 模型返回的东西**有八成时间是干净的 JSON，剩下两成不是**。而那两成会在
 * 生产环境里以「偶发解析失败」的形式出现，最难查。这个模块把已知的形态一次处理掉。
 *
 * 已知形态清单（都是真实见过的）：
 *   · 裸 JSON                                        ← 理想情况
 *   · 包在 ```json 围栏里
 *   · 前面一段「好的，我来帮你分析：」
 *   · 后面一段「希望这对你有帮助！」
 *   · prefill 回显导致开头多一个 {（L02 探测发现的那个端点行为）
 *   · 被 max_tokens 截断 —— **必须报错，不能猜**
 *
 * 最后一条是这个模块的设计重点：**宁可抛错，也不要返回一个「修好了」的错数据。**
 * 截断的 JSON 补上括号之后是能 parse 的，但内容是残缺的，静默入库就是脏数据。
 */

export class ParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message)
    this.name = 'ParseError'
  }
}

/** 去掉 markdown 代码围栏。语言标注可有可无。 */
export function stripFences(text: string): string {
  const fenced = text.match(/```(?:[a-zA-Z]*)\n([\s\S]*?)```/)
  return fenced?.[1] ?? text
}

/**
 * 找出第一个完整的 JSON 值（对象或数组）的范围。
 *
 * 关键点：不能只数括号，必须跳过**字符串内部**的括号。
 * `{"note": "}"}` 这种输入在朴素实现里会在第一个 } 处提前收工，
 * 抠出 `{"note": "}` 然后 parse 失败。而且这类内容在代码审查场景里很常见。
 */
function findJsonSpan(text: string): { start: number; end: number } | null {
  const start = text.search(/[[{]/)
  if (start === -1) return null

  const open = text[start] as '[' | '{'
  const close = open === '{' ? '}' : ']'

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return { start, end: i + 1 }
    }
  }

  // 没闭合。这是截断，不是格式问题——两者的处置完全不同。
  return null
}

export interface ExtractOptions {
  /**
   * 容忍尾随逗号。默认关。
   *
   * 开之前想清楚：尾随逗号是模型的一个常见小错，容忍它能提高成功率。
   * 但容忍度是有代价的——你放过的每一种畸形，都让你更难发现 prompt 在退化。
   * 我的建议是**开着但记一条日志**，这样成功率和可观测性都不丢。
   */
  allowTrailingComma?: boolean
  onRepair?: (what: string) => void
}

/**
 * 从一段文本里抠出 JSON 并解析。
 *
 * 失败时抛 ParseError，并把原始文本挂在上面——调用方要拿它去记日志。
 * 只抛一句「解析失败」而不带原文的错误，等于没有错误信息。
 */
export function extractJson<T = unknown>(text: string, opts: ExtractOptions = {}): T {
  const cleaned = stripFences(text).trim()
  if (!cleaned) throw new ParseError('模型什么都没返回（正文为空，很可能预算被思考块吃光了）', text)

  const span = findJsonSpan(cleaned)
  if (!span) {
    const hasOpen = /[[{]/.test(cleaned)
    throw new ParseError(
      hasOpen
        ? 'JSON 没有闭合，几乎肯定是被 max_tokens 截断了。不要补括号——补出来能 parse，但内容是残缺的。'
        : '输出里找不到 JSON 的开头。检查一下 prompt 有没有真的要求 JSON，或者 prefill 有没有生效。',
      text,
    )
  }

  let body = cleaned.slice(span.start, span.end)

  try {
    return JSON.parse(body) as T
  } catch (err) {
    if (opts.allowTrailingComma) {
      const repaired = body.replace(/,(\s*[}\]])/g, '$1')
      if (repaired !== body) {
        try {
          const value = JSON.parse(repaired) as T
          opts.onRepair?.('去掉了尾随逗号')
          return value
        } catch {
          body = repaired
        }
      }
    }
    throw new ParseError(`JSON 结构找到了但解析失败：${(err as Error).message}`, text)
  }
}

/**
 * 抠出被一对标签包住的内容。
 *
 * 配合 stop_sequences 用：让模型输出 <answer>...</answer>，在 </answer> 处停。
 * 命中停止串时闭合标签本身不会出现在输出里（L02 讲过），所以这里要能处理**只有开标签**的情况。
 */
export function extractTag(text: string, tag: string): string | null {
  const open = text.indexOf(`<${tag}>`)
  if (open === -1) return null
  const from = open + tag.length + 2
  const close = text.indexOf(`</${tag}>`, from)
  return (close === -1 ? text.slice(from) : text.slice(from, close)).trim()
}
