/**
 * 第一批工具：read_file / list_dir / search_code。
 *
 * 这三个是 L04 的交付物，L05 的 agent loop 和 L17 的 capstone 都会用它们。
 *
 * 每个工具的形状都一样，值得注意这个统一性：
 *   description 写清「返回什么 + 边界在哪」→ parse 校验 → run 执行且不抛
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { safePath, truncate } from './sandbox.ts'
import { optionalInt, requireString, type ToolDef, type ToolResult } from './tools.ts'

/** 单个文件读取的上限。100KB 大概是 25k~50k token，已经很占预算了。 */
const MAX_FILE_BYTES = 100 * 1024

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__'])

export function makeReadFile(root: string): ToolDef<{ path: string; startLine?: number; endLine?: number }> {
  return {
    name: 'read_file',
    // 这段字符串是模型唯一的判断依据。写清返回什么、边界在哪、失败什么样。
    description:
      '读取仓库内一个文本文件的内容。路径相对于仓库根目录。' +
      '可以只读某个行号区间（start_line / end_line，从 1 开始，含两端）——' +
      '文件很大时应该先读一段而不是全读。' +
      `单次返回上限 ${MAX_FILE_BYTES / 1024}KB，超出会被截断并明确标注。`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对仓库根的文件路径，例如 src/index.ts' },
        start_line: { type: 'integer', description: '起始行号，从 1 开始。省略表示从头读。', minimum: 1 },
        end_line: { type: 'integer', description: '结束行号，含该行。省略表示读到末尾。', minimum: 1 },
      },
      required: ['path'],
    },
    parse: (raw) => {
      const p = requireString(raw, 'path')
      if (!p.ok) return p
      const o = raw as Record<string, unknown>
      const start = o.start_line === undefined ? undefined : optionalInt(raw, 'start_line', 1, 1, 1e9)
      const end = o.end_line === undefined ? undefined : optionalInt(raw, 'end_line', 1, 1, 1e9)
      if (start !== undefined && end !== undefined && end < start) {
        return { ok: false, message: `end_line (${end}) 不能小于 start_line (${start})。` }
      }
      return { ok: true, input: { path: p.value, startLine: start, endLine: end } }
    },
    run: async ({ path, startLine, endLine }): Promise<ToolResult> => {
      const sp = safePath(root, path)
      if (!sp.ok) return { isError: true, content: sp.message, logNote: sp.logNote }

      let info
      try {
        info = await stat(sp.full)
      } catch {
        return {
          isError: true,
          // 给出路：告诉它下一步该干什么，而不是只说失败了
          content: `文件不存在：${sp.rel}。用 list_dir 看看这个目录下实际有哪些文件。`,
        }
      }

      if (info.isDirectory()) {
        return { isError: true, content: `${sp.rel} 是一个目录，不是文件。用 list_dir 列出它的内容。` }
      }

      const raw = await readFile(sp.full, 'utf8')

      if (startLine === undefined && endLine === undefined) {
        const { text } = truncate(raw, MAX_FILE_BYTES)
        return { content: text }
      }

      const lines = raw.split('\n')
      const from = (startLine ?? 1) - 1
      const to = endLine ?? lines.length
      if (from >= lines.length) {
        return {
          isError: true,
          content: `start_line ${startLine} 超过了文件总行数 ${lines.length}。`,
        }
      }
      // 带上行号，模型才能准确地指定下一次要编辑的位置
      const slice = lines
        .slice(from, to)
        .map((l, i) => `${from + i + 1}\t${l}`)
        .join('\n')
      const { text } = truncate(slice, MAX_FILE_BYTES)
      return { content: `${text}\n\n（${sp.rel} 共 ${lines.length} 行）` }
    },
  }
}

export function makeListDir(root: string): ToolDef<{ path: string; depth: number }> {
  return {
    name: 'list_dir',
    description:
      '列出仓库内某个目录的内容。路径相对于仓库根，用 "." 表示根目录。' +
      'depth 控制递归层数（1 表示只列当前层，最大 3）。' +
      '自动跳过 node_modules、.git、dist 这类目录。' +
      '目录名以 / 结尾，文件会标出大小。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对仓库根的目录路径，根目录用 "."' },
        depth: { type: 'integer', description: '递归层数，默认 1，最大 3', minimum: 1, maximum: 3 },
      },
      required: ['path'],
    },
    parse: (raw) => {
      const p = requireString(raw, 'path')
      if (!p.ok) return p
      return { ok: true, input: { path: p.value, depth: optionalInt(raw, 'depth', 1, 1, 3) } }
    },
    run: async ({ path, depth }): Promise<ToolResult> => {
      const sp = safePath(root, path)
      if (!sp.ok) return { isError: true, content: sp.message, logNote: sp.logNote }

      try {
        const info = await stat(sp.full)
        if (!info.isDirectory()) {
          return { isError: true, content: `${sp.rel} 是一个文件，不是目录。用 read_file 读它。` }
        }
      } catch {
        return { isError: true, content: `目录不存在：${sp.rel}。用 list_dir 从 "." 开始往下找。` }
      }

      const out: string[] = []

      async function walk(dir: string, prefix: string, left: number): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true })
        entries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        for (const e of entries) {
          if (e.name.startsWith('.') && e.name !== '.env.example') continue
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) {
              out.push(`${prefix}${e.name}/  （已跳过）`)
              continue
            }
            out.push(`${prefix}${e.name}/`)
            if (left > 1) await walk(join(dir, e.name), `${prefix}  `, left - 1)
          } else {
            const s = await stat(join(dir, e.name)).catch(() => null)
            const size = s ? ` (${s.size < 1024 ? `${s.size}B` : `${(s.size / 1024).toFixed(1)}KB`})` : ''
            out.push(`${prefix}${e.name}${size}`)
          }
        }
      }

      await walk(sp.full, '', depth)

      if (out.length === 0) return { content: `${sp.rel} 是空目录。` }
      const { text } = truncate(out.join('\n'), MAX_FILE_BYTES)
      return { content: text }
    },
  }
}

export function makeSearchCode(root: string): ToolDef<{ pattern: string; maxResults: number }> {
  return {
    name: 'search_code',
    description:
      '在仓库内按正则搜索文本，返回匹配的文件路径、行号和该行内容。' +
      '只搜文本文件，跳过 node_modules、.git、dist。' +
      '返回条数上限默认 20，最大 50。找不到时会明确说没有匹配。',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript 正则语法，不需要写斜杠' },
        max_results: { type: 'integer', description: '返回条数上限，默认 20', minimum: 1, maximum: 50 },
      },
      required: ['pattern'],
    },
    parse: (raw) => {
      const p = requireString(raw, 'pattern')
      if (!p.ok) return p
      try {
        new RegExp(p.value)
      } catch (err) {
        // 正则语法错是模型能改的，所以回给它，并把报错原文带上
        return { ok: false, message: `正则不合法：${(err as Error).message}。换一个写法再试。` }
      }
      return { ok: true, input: { pattern: p.value, maxResults: optionalInt(raw, 'max_results', 20, 1, 50) } }
    },
    run: async ({ pattern, maxResults }): Promise<ToolResult> => {
      const re = new RegExp(pattern)
      const hits: string[] = []
      const rootAbs = safePath(root, '.')
      if (!rootAbs.ok) return { isError: true, content: rootAbs.message, logNote: rootAbs.logNote }

      async function walk(dir: string, rel: string): Promise<void> {
        if (hits.length >= maxResults) return
        const entries = await readdir(dir, { withFileTypes: true })
        for (const e of entries) {
          if (hits.length >= maxResults) return
          if (e.name.startsWith('.')) continue
          const abs = join(dir, e.name)
          const r = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue
            await walk(abs, r)
            continue
          }
          const s = await stat(abs).catch(() => null)
          if (!s || s.size > MAX_FILE_BYTES * 5) continue
          let text: string
          try {
            text = await readFile(abs, 'utf8')
          } catch {
            continue
          }
          // 二进制文件的粗判：出现 NUL 就当二进制
          if (text.includes('\0')) continue
          const lines = text.split('\n')
          for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
            if (re.test(lines[i]!)) hits.push(`${r}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`)
          }
        }
      }

      await walk(rootAbs.full, '')

      if (hits.length === 0) {
        return { content: `没有匹配 /${pattern}/ 的内容。换个更宽松的写法，或者先用 list_dir 确认目录结构。` }
      }
      const capped = hits.length >= maxResults ? `\n\n（达到 ${maxResults} 条上限，可能还有更多匹配）` : ''
      return { content: hits.join('\n') + capped }
    },
  }
}

/** 组装标准工具集。 */
export function standardTools(root: string) {
  return [makeReadFile(root), makeListDir(root), makeSearchCode(root)] as unknown as ToolDef<never>[]
}
