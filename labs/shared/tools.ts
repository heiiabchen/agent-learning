/**
 * 工具注册表与执行层。这是 L04 的核心交付物，L05 的 agent loop 会直接用它。
 *
 * 三条贯穿这个文件的设计决定：
 *
 *   1. **工具参数是不可信输入。** 每个工具执行前必须过校验，没有例外。
 *      参数由模型生成，而模型的上下文里可能有用户输入、检索文档、文件内容
 *      ——任何一个都可能被攻击者控制。
 *
 *   2. **失败回结果，不抛异常。** 模型能改变结果的失败（文件不存在、参数错）
 *      变成带 isError 的结果回给它；只有模型无能为力的（你的 bug、依赖挂了）才抛。
 *
 *   3. **错误信息里要有下一步。** 判据不是「准确描述了故障」，
 *      而是「模型读完知道该干什么」。
 */
import type Anthropic from '@anthropic-ai/sdk'

export interface ToolResult {
  content: string
  isError?: boolean
  /** 给日志用，不发给模型。比如「拒绝了一次越界访问」这种你要知道但模型不需要的细节。 */
  logNote?: string
}

export interface ToolDef<I = unknown> {
  name: string
  description: string
  inputSchema: Anthropic.Tool['input_schema']
  /**
   * 校验并归一化参数。失败返回一句给**模型**看的话。
   *
   * 返回值故意做成联合类型，逼调用方处理失败分支——
   * 写成「抛异常表示校验失败」的话，很容易在某个 catch 里被吞掉。
   */
  parse: (raw: unknown) => { ok: true; input: I } | { ok: false; message: string }
  run: (input: I) => Promise<ToolResult>
}

/** 转成 API 要的形状。注意 description 是模型唯一的判断依据。 */
export function toApiTool(t: ToolDef<never>): Anthropic.Tool {
  return { name: t.name, description: t.description, input_schema: t.inputSchema }
}

export class ToolBox {
  private readonly tools = new Map<string, ToolDef<never>>()

  constructor(tools: ToolDef<never>[] = []) {
    for (const t of tools) this.register(t)
  }

  register(tool: ToolDef<never>): void {
    if (this.tools.has(tool.name)) throw new Error(`工具名重复：${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get names(): string[] {
    return [...this.tools.keys()]
  }

  apiTools(): Anthropic.Tool[] {
    return [...this.tools.values()].map(toApiTool)
  }

  /**
   * 执行一次工具调用。
   *
   * 这个方法**不抛异常**（除了工具自己抛的、代表真故障的那种），
   * 所有可恢复的失败都以 ToolResult.isError 的形式返回。
   */
  async execute(name: string, rawInput: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name)

    // 模型会编造工具名——这不是幻觉，是模式补全（L04 第一节的 Drill）。
    // 所以工具名必须当成不可信输入，而且报错时要把真实清单给它，否则它只能继续猜。
    if (!tool) {
      return {
        isError: true,
        content: `没有名为 ${name} 的工具。可用的工具是：${this.names.join('、')}。`,
        logNote: `模型编造了工具名 ${name}`,
      }
    }

    const parsed = tool.parse(rawInput)
    if (!parsed.ok) {
      return { isError: true, content: parsed.message, logNote: `${name} 参数校验失败` }
    }

    return tool.run(parsed.input as never)
  }
}

/** 从一条 assistant 消息里挑出工具调用块。 */
export function toolUsesOf(content: Anthropic.ContentBlock[]): Anthropic.ToolUseBlock[] {
  return content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
}

/**
 * 把执行结果拼成一条 user 消息。
 *
 * 两个必须做对的地方，都在 L04 第四节讲过：
 *
 *   · 所有结果放在**同一条** user 消息里（否则连续两条 user，违反交替约束）
 *   · 顺序跟着 toolUses 的原始顺序，不是完成顺序
 *     （顺序抖动 → 前缀缓存失效 + 无法复现）
 */
export function toolResultMessage(
  toolUses: Anthropic.ToolUseBlock[],
  results: ToolResult[],
): Anthropic.MessageParam {
  if (toolUses.length !== results.length) {
    throw new Error(`工具调用 ${toolUses.length} 个但结果 ${results.length} 个，对不上`)
  }

  return {
    role: 'user',
    content: toolUses.map((tu, i) => {
      const r = results[i]!
      return {
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      }
    }),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 校验小工具
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 取一个必填字符串字段。
 *
 * 存在的理由：模型会传 undefined、传数字、传对象。直接 `input.path` 拿到
 * 非字符串之后往下走，报错的地方离原因很远（通常是在某个 fs 调用里）。
 */
export function requireString(
  raw: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: `参数必须是一个对象，收到的是 ${typeof raw}。` }
  }
  const v = (raw as Record<string, unknown>)[field]
  if (typeof v !== 'string' || v.trim() === '') {
    return { ok: false, message: `缺少必填参数 ${field}（需要一个非空字符串）。` }
  }
  return { ok: true, value: v }
}

/** 取一个可选整数，并把越界值**夹回**范围内——因为模型经常越界，而那不该是致命错误。 */
export function optionalInt(raw: unknown, field: string, def: number, min: number, max: number): number {
  if (typeof raw !== 'object' || raw === null) return def
  const v = (raw as Record<string, unknown>)[field]
  if (v === undefined || v === null) return def
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}
