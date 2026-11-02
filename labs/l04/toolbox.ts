/**
 * L04 · 任务二：路径沙箱与第一批工具。
 *
 * 跑法：pnpm toolbox        验证：pnpm verify:l04
 *
 * `shared/sandbox.ts` 和 `shared/toolbox.ts` 里有我的实现。**先别看。**
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 这是整门课第一个**真安全**的练习。verify 里有一批攻击输入等着你，
 * 包括路径穿越、绝对路径、NUL 字节、以及符号链接逃逸。
 *
 * 先记住一件事：
 *
 *     resolve('/repo', '../../etc/passwd')  →  '/etc/passwd'
 *
 * resolve 忠实地帮你跳出了根目录。**它不是安全函数，从来不是。**
 * 正确的形状是「先解析，再验证结果仍在根内」，顺序不能反。
 * ───────────────────────────────────────────────────────────────────────────
 */
import type { ToolDef, ToolResult } from './schema.ts'

export interface SafePathOk {
  ok: true
  /** 验证过的绝对路径，只有这个值能交给 fs。 */
  full: string
  /** 相对根的路径。回给模型的消息里用这个——绝对路径不要进上下文。 */
  rel: string
}

export interface SafePathErr {
  ok: false
  message: string
  logNote: string
}

export type SafePath = SafePathOk | SafePathErr

// ─────────────────────────────────────────────────────────────────────────────
// TODO 1 · safePath(root, input, followSymlinks = true)
//
//   要挡住的输入（verify 里全都有）：
//
//     '../../etc/passwd'          经典穿越
//     '/etc/passwd'               绝对路径
//     'src/../../outside.txt'     中间穿越，末尾看起来正常
//     'safe.txt\0../../etc/passwd' NUL 字节截断
//     ''                          空字符串
//     一个指向根外的符号链接        ★ 纯路径检查挡不住
//
//   实现要点：
//     · 先 resolve，再用 relative 判断是否跳出去
//     · 「rel 是 '..' 或以 '..' + sep 开头」和 isAbsolute(rel) **两个都要查**
//       （Windows 跨盘符时 relative 会返回绝对路径，只查前者会漏）
//     · 别写成 rel.startsWith('..')：根内的 '..notes.md' 会被误杀
//     · followSymlinks 时用 realpathSync 再验一次；文件不存在会抛——对这一节的只读工具
//       那不是安全问题（最后会报「不存在」）。要创建文件时就是了，L17 回来补这一格
//
//   回给模型的 message 里**不要**出现绝对路径。
//   上下文里的东西模型后面都可能复述出来。
// ─────────────────────────────────────────────────────────────────────────────

export function safePath(root: string, input: string, followSymlinks = true): SafePath {
  void root
  void input
  void followSymlinks
  throw new Error('TODO 1 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 2 · truncate(text, maxBytes)
//
//   超长内容截断，并在结尾**明确写出被截断了**以及完整大小。
//
//   ★ 那句告知不能省。不说的话模型会以为看到了完整内容，然后基于残缺信息下结论。
//     这和 L02「半截内容绝不能静默返回」是同一条纪律。
//
//   注意按字节切会切断多字节字符（中文内容里很常见），
//   残缺的尾巴会变成 U+FFFD，处理掉它。
// ─────────────────────────────────────────────────────────────────────────────

export function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  void text
  void maxBytes
  throw new Error('TODO 2 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 3 · makeReadFile(root)
//
//   一个完整的工具定义。要求：
//
//   description 里写清：路径相对谁、支持行号区间、上限多少、超了会怎样。
//     （这段字符串是模型唯一的判断依据，它看不到你的实现。）
//
//   inputSchema 里 path 必填，start_line / end_line 可选。
//
//   run 里的分支，每一个都要给出路：
//     · 路径越界   → isError，说明只能访问仓库内
//     · 文件不存在 → isError，**建议用 list_dir 查看目录**
//     · 是目录     → isError，建议用 list_dir
//     · 行号超范围 → isError，告诉它文件共几行
//     · 正常       → 内容；给了行号区间时带上行号前缀，
//                    这样模型下一步才能准确指定编辑位置
//
//   单文件上限我用的是 100KB。想一下为什么不是 10MB：
//   100KB 大概是几万 token，已经很占预算了，而 10MB 会直接撞满 context window。
// ─────────────────────────────────────────────────────────────────────────────

export function makeReadFile(
  root: string,
): ToolDef<{ path: string; startLine?: number; endLine?: number }> {
  void root
  throw new Error('TODO 3 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 4 · makeListDir(root)
//
//   列目录，支持 depth（1~3）。跳过 node_modules / .git / dist 这类。
//
//   两个细节值得做对：
//     · 目录排在文件前面，各自按名字排序 —— **输出稳定，缓存才可能命中**
//       （L02：顺序抖动等于每轮重新付全价）
//     · 被跳过的目录也要列出来并标注「已跳过」，
//       否则模型会以为那个目录不存在，然后反复去找
// ─────────────────────────────────────────────────────────────────────────────

export function makeListDir(root: string): ToolDef<{ path: string; depth: number }> {
  void root
  throw new Error('TODO 4 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 5 · 跑一遍，用真实的攻击输入试试
//
//   拿 labs/ 目录当 root，手动调用你的工具（先不接模型）：
//
//     await readFile.run({ path: 'package.json' })              → 成功
//     await readFile.run({ path: '../../../etc/passwd' })        → 越界
//     await readFile.run({ path: '/etc/passwd' })                → 越界
//     await readFile.run({ path: 'l04/../../etc/hosts' })        → 越界
//     await listDir.run({ path: '.', depth: 2 })                 → 成功
//
//   然后回答：
//     a) 你的实现里，「验证」这一步在「解析」之前还是之后？为什么只能是这个顺序？
//     b) 如果 root 本身是一个符号链接（比如 macOS 上 /tmp → /private/tmp），
//        你的 realpath 检查会不会把所有正常路径都判成越界？去试一下。
// ─────────────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  throw new Error('把 TODO 5 写完，然后删掉这一行')
}

if (import.meta.filename === process.argv[1]) {
  await main()
}

export type { ToolResult }
