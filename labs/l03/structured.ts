/**
 * L03 · 任务三：让模型稳定输出可解析的结构。
 *
 * 跑法：pnpm structured        验证：pnpm verify:l03
 *
 * `shared/parse.ts` 里有我的实现。**先别看。**
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 这个任务的重点不是「写一个 JSON 解析器」——JSON.parse 已经存在了。
 * 重点是**处理模型输出的那两成不干净的情况**，并且在该失败的时候失败。
 *
 * 最容易写错的一条：被 max_tokens 截断的 JSON，补上括号之后是能 parse 的。
 * 于是你的代码「成功」了，入库了一条残缺数据。这比抛错糟糕得多。
 * ───────────────────────────────────────────────────────────────────────────
 */
import { createClient, getProvider } from '../shared/config.ts'
import { Ledger } from '../shared/ledger.ts'
import { textOf } from '../shared/message.ts'

export class ParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message)
    this.name = 'ParseError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 1 · stripFences(text)
//
//   去掉 ```json ... ``` 围栏。语言标注可有可无，也可能压根没围栏。
// ─────────────────────────────────────────────────────────────────────────────

export function stripFences(text: string): string {
  void text
  throw new Error('TODO 1 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 2 · extractJson(text, opts?)
//
//   要处理的形态（全都是真实见过的）：
//     · 裸 JSON
//     · 包在围栏里
//     · 前面有「好的，我来帮你分析：」
//     · 后面有「希望这对你有帮助！」
//     · 开头多一个 {（prefill 回显，L02 探测发现的端点行为）
//     · 尾随逗号（opts.allowTrailingComma 才修，默认不修）
//
//   ★ 最关键的一条：**括号计数必须跳过字符串内部。**
//
//   `{"note": "}"}` 这个输入在朴素实现里会在第一个 } 处收工，
//   抠出 `{"note": "}` 然后失败。而这类内容在代码相关的场景里非常常见
//   ——模型解释代码时经常引用带括号的片段。
//   记得还要处理反斜杠转义：`{"s": "\\""}` 里那个引号不能算作字符串结束。
//
//   ★ 第二关键：**没闭合就抛错，不要补括号。**
//   补出来能 parse，但内容是残缺的。截断和格式错误是两种故障，
//   处置也不同（截断该重试并加大 max_tokens，格式错该改 prompt）。
//   所以错误信息里要能区分这两种。
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractOptions {
  allowTrailingComma?: boolean
  onRepair?: (what: string) => void
}

export function extractJson<T = unknown>(text: string, opts: ExtractOptions = {}): T {
  void text
  void opts
  throw new Error('TODO 2 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 3 · extractTag(text, tag)
//
//   抠出 <answer>...</answer> 之间的内容。
//
//   注意一个和 L02 联动的细节：配合 stop_sequences: ['</answer>'] 用的时候，
//   **闭合标签本身不会出现在输出里**。所以只有开标签的情况必须能处理，
//   否则你会在最正常的用法上返回 null。
// ─────────────────────────────────────────────────────────────────────────────

export function extractTag(text: string, tag: string): string | null {
  void text
  void tag
  throw new Error('TODO 3 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 4 · 拿真实模型验证三种约束手段的效果
//
//   任务：从一段会议记录里提取待办，输出 { task, owner }[] 。
//
//   跑三个版本，每个版本跑 5 次，记录「一次就能 extractJson 成功」的比例：
//
//     A. 只在 prompt 里用文字要求「只返回 JSON，不要其他内容」
//     B. A + 用 <output_format> 标签给出确切的形状
//     C. B + prefill 一个 '['
//
//   用 L02 的账本记全部 15 次调用，最后打出：
//     · 每个版本的一次成功率
//     · 每个版本的平均输入 / 输出 token
//     · 失败的那几次，失败形态是什么（有前言？有围栏？被截断？）
//
//   然后回答：
//     a) C 比 A 强多少？这个提升值不值它多花的 token？
//     b) 失败的那几次，如果只看「解析成功率」这一个指标，你会漏掉什么信息？
//     c) 如果 C 的成功率是 100%，你敢不敢去掉 extractJson 里的容错逻辑？为什么？
//
//   c) 这一问是本节最想让你想清楚的：**5 次全成功不等于稳定。**
// ─────────────────────────────────────────────────────────────────────────────

const MEETING = `
张伟：这周的登录页改版我来做，下周三之前给出可点的版本。
李娜：那我同步把埋点方案写出来，不过我下周一二在出差，可能要往后挪。
王强：数据库迁移脚本我已经写完了，等评审。
张伟：好，那评审我们放在周四。另外线上那个偶发 500 有人跟吗？
李娜：我看过日志，像是连接池打满，还没定位到根因。
`.trim()

export async function main() {
  const provider = getProvider()
  const client = createClient(provider)
  const ledger = new Ledger('L03 结构化输出')

  void client
  void ledger
  void MEETING
  void textOf

  throw new Error('把 TODO 4 写完，然后删掉这一行')
}

if (import.meta.filename === process.argv[1]) {
  await main()
}
