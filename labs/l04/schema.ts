/**
 * L04 · 任务一：工具注册表与参数校验。
 *
 * 跑法：pnpm schema        验证：pnpm verify:l04
 *
 * `shared/tools.ts` 里有我的实现。**先别看。**
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 这个任务是 L05 agent loop 的地基。三条贯穿始终的设计决定：
 *
 *   1. 工具参数是不可信输入 —— 执行前必须校验，没有例外
 *   2. 失败回结果，不抛异常 —— 模型能改变结果的失败要让它看见
 *   3. 错误信息里要有下一步 —— 判据是「模型读完知道干什么」
 * ───────────────────────────────────────────────────────────────────────────
 */
import type Anthropic from '@anthropic-ai/sdk'

export interface ToolResult {
  content: string
  isError?: boolean
  /** 给日志用，不发给模型。比如「拒绝了一次越界访问」这种你要知道、模型不需要的细节。 */
  logNote?: string
}

export interface ToolDef<I = unknown> {
  name: string
  description: string
  inputSchema: Anthropic.Tool['input_schema']
  parse: (raw: unknown) => { ok: true; input: I } | { ok: false; message: string }
  run: (input: I) => Promise<ToolResult>
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 1 · requireString(raw, field)
//
//   从 raw 里取一个必填的非空字符串。
//
//   要处理的输入（模型全都会给你）：
//     · raw 不是对象（是 null、字符串、数组）
//     · 字段缺失
//     · 字段是数字 / 对象 / null
//     · 字段是空字符串或只有空格
//
//   返回 { ok: false, message } 时，message 是给**模型**看的，不是给开发者看的。
// ─────────────────────────────────────────────────────────────────────────────

export function requireString(
  raw: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; message: string } {
  void raw
  void field
  throw new Error('TODO 1 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 2 · optionalInt(raw, field, def, min, max)
//
//   取一个可选整数，越界就**夹回**范围内，不要报错。
//
//   为什么夹回而不报错：模型经常越界（讲义第二节那个 maximum: 50 收到 500 的例子）。
//   这种越界不是攻击也不是致命错误，报错只是浪费一个往返。
//   但字段缺失、非数字、NaN 都要退回默认值。
//
//   想一下：什么时候「夹回」是错的处理？（提示：如果这个参数控制的是删除范围呢？）
// ─────────────────────────────────────────────────────────────────────────────

export function optionalInt(raw: unknown, field: string, def: number, min: number, max: number): number {
  void raw
  void field
  void def
  void min
  void max
  throw new Error('TODO 2 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 3 · ToolBox
//
//   register(tool)   —— 重名要抛错（这是你的 bug，不是模型的，该响）
//   names            —— 工具名列表
//   apiTools()       —— 转成 Anthropic.Tool[]
//   execute(name, raw) —— 执行，**不抛可恢复的错**
//
//   ★ execute 里工具名查不到时，不能只说「工具不存在」。
//     要把真实的工具清单列给模型，否则它只能继续猜。
//     （讲义第一节的 Drill：模型编造工具名是模式补全，不是幻觉。）
// ─────────────────────────────────────────────────────────────────────────────

export class ToolBox {
  constructor(tools: ToolDef<never>[] = []) {
    void tools
  }

  register(tool: ToolDef<never>): void {
    void tool
    throw new Error('TODO 3 还没实现')
  }

  get names(): string[] {
    throw new Error('TODO 3 还没实现')
  }

  apiTools(): Anthropic.Tool[] {
    throw new Error('TODO 3 还没实现')
  }

  async execute(name: string, rawInput: unknown): Promise<ToolResult> {
    void name
    void rawInput
    throw new Error('TODO 3 还没实现')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 4 · toolUsesOf(content)
//
//   从 assistant 的 content 数组里挑出 tool_use 块。
// ─────────────────────────────────────────────────────────────────────────────

export function toolUsesOf(content: Anthropic.ContentBlock[]): Anthropic.ToolUseBlock[] {
  void content
  throw new Error('TODO 4 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 5 · toolResultMessage(toolUses, results)
//
//   把结果拼成**一条** user 消息。
//
//   ★ 两个必须做对的地方（讲义第四节）：
//     · 所有结果放在同一条消息里（分成多条 = 连续两条 user = 违反交替）
//     · 顺序跟 toolUses 一致，不是完成顺序
//       （顺序抖动 → 前缀缓存失效 + 问题无法复现）
//
//   isError 的结果要带上 is_error: true。
//   长度对不上要抛错——那是你的 bug。
// ─────────────────────────────────────────────────────────────────────────────

export function toolResultMessage(
  toolUses: Anthropic.ToolUseBlock[],
  results: ToolResult[],
): Anthropic.MessageParam {
  void toolUses
  void results
  throw new Error('TODO 5 还没实现')
}
