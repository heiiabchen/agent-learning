/**
 * Agent Skills：发现、解析、合并、目录、激活、审批。L10x 的参考实现。
 *
 * 一个 skill 就是一个目录，里面有一份 SKILL.md：开头一段 YAML frontmatter
 * （至少 name 和 description），后面是正文。标准（agentskills.io）只规定了
 * **文件长什么样**。下面这些全都是客户端自己的策略，各家互不相同：
 *
 *   · 去哪些目录找、找多深
 *   · frontmatter 用什么 YAML 语义解析
 *   · 校验多严：不合规的是拒绝、警告还是照常加载
 *   · 同名时谁赢
 *   · 目录超预算时先砍谁
 *   · 激活后的正文活多久、压缩时保留多少
 *   · allowed-tools 预批准的命令什么条件下自动放行
 *
 * 所以这个模块把「策略」做成参数，而不是写死某一家的行为。
 *
 * 两条贯穿全文件的纪律，都是为了让 TS 和 Python 的输出逐字节一致：
 *   · 长度一律按 Unicode 码点算（cpLen），不用 TS 的 .length（UTF-16 码元，emoji 算 2）。
 *   · 排序一律按码点比较（cmpCp），不用默认 sort()（同样按 UTF-16 码元）。
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { estimateTokens } from './context.ts'
import { safePath, type SafePath } from './sandbox.ts'

// ─────────────────────────────────────────────────────────────
// 零、码点工具
// ─────────────────────────────────────────────────────────────

export function cpLen(s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}

export function cpSlice(s: string, k: number): string {
  return [...s].slice(0, k).join('')
}

/** 按码点比较。Python 的 str 比较天然就是这个语义。 */
export function cmpCp(a: string, b: string): number {
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!
    const y = b.codePointAt(j)!
    if (x !== y) return x < y ? -1 : 1
    i += x > 0xffff ? 2 : 1
    j += y > 0xffff ? 2 : 1
  }
  if (i < a.length) return 1
  if (j < b.length) return -1
  return 0
}

/** 只去空格和 tab。JS 的 trim() 还会去 U+3000 和 U+FEFF，Python 的 strip() 不去 U+FEFF。 */
export function trimSp(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, '')
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

// ─────────────────────────────────────────────────────────────
// 一、诊断
// ─────────────────────────────────────────────────────────────

export type DiagCode =
  | 'NO_FRONTMATTER'
  | 'UNTERMINATED'
  | 'UNSUPPORTED_YAML'
  | 'DUPLICATE_KEY'
  | 'COLON_IN_PLAIN'
  | 'NAME_MISSING'
  | 'NAME_CHARSET'
  | 'NAME_LENGTH'
  | 'NAME_DIR_MISMATCH'
  | 'DESC_MISSING'
  | 'DESC_LENGTH'
  | 'COMPAT_LENGTH'
  | 'METADATA_SHAPE'
  | 'BAD_TYPE'
  | 'UNKNOWN_FIELD'
  | 'BAD_BOOLEAN'
  | 'INVISIBLE_CHARS'
  | 'LOWERCASE_SKILL_MD'
  | 'TOO_DEEP'
  | 'TOO_MANY_DIRS'
  | 'SYMLINK_ESCAPES_ROOT'
  | 'UNRESOLVABLE'

export interface Diag {
  level: 'error' | 'warning'
  code: DiagCode
  field: string | null
  /** 只有 discover 会填。解析与校验本身不知道文件在哪。 */
  path: string | null
  message: string
}

function err(code: DiagCode, field: string | null, message: string): Diag {
  return { level: 'error', code, field, path: null, message }
}
function warn(code: DiagCode, field: string | null, message: string): Diag {
  return { level: 'warning', code, field, path: null, message }
}

// ─────────────────────────────────────────────────────────────
// 二、frontmatter：一个刻意收窄的 YAML 子集
//
// 为什么不直接用 YAML 库：同一段 frontmatter，PyYAML、js-yaml、yaml、
// strictyaml 四个解析器在 24 个样例里只有 7 个结果一致。`version: 1.0`
// 有的给浮点、有的给整数、有的给字符串；`x: no` 在 PyYAML 里是 false；
// `description: |` 的末尾换行，Python 和 JS 两边就不一样。
//
// 子集的边界一句话：**四个解析器结果一致的构造照常支持；不一致的要么拒绝，
// 要么在字段层用显式规则收口。** 所有标量一律是字符串，不做类型推断。
// ─────────────────────────────────────────────────────────────

export type FmValue = string | string[] | Record<string, string>

/** key 来自文件内容，`__proto__`、`constructor` 都可能出现，所以用无原型的对象。 */
function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}
function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k)
}

export interface Frontmatter {
  fields: Record<string, FmValue>
  /** 原文里 key 的顺序。 */
  order: string[]
}

export type SplitResult = { ok: true; yaml: string[]; body: string } | { ok: false; diag: Diag }

/**
 * 切出 frontmatter 的行和正文。
 *
 * ★ 结束符是「之后第一个恰好等于 --- 的整行」，不是第一次出现的 --- 子串。
 *   参考校验器 skills-ref 用 split('---', 2)，于是 `description: a --- b`
 *   的 description 被截成 `a`。
 * ★ 先去 BOM、把 CRLF 和孤立的 CR 都换成 LF，再按 '\n' 切。
 *   Python 的 splitlines() 还会在 U+2028 之类的字符上切，所以两边都只认 '\n'。
 */
export function splitFrontmatter(text: string): SplitResult {
  let t = text.startsWith('\uFEFF') ? text.slice(1) : text
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = t.split('\n')
  if (lines[0] !== '---') {
    return { ok: false, diag: err('NO_FRONTMATTER', null, '第一行必须恰好是 ---。') }
  }
  const end = lines.indexOf('---', 1)
  if (end < 0) {
    return { ok: false, diag: err('UNTERMINATED', null, 'frontmatter 没有结束的 --- 行。') }
  }
  return {
    ok: true,
    yaml: lines.slice(1, end),
    body: lines.slice(end + 1).join('\n').replace(/^\n+/, ''),
  }
}

export type ScalarResult =
  | { ok: true; value: string; /** plain 标量里出现了 `: ` 或以 `:` 结尾 */ colon: boolean }
  | { ok: false; message: string }

const PLAIN_FORBIDDEN_START = new Set(['[', '{', '&', '*', '!', '%', '@', '`', '|', '>'])

/**
 * 解析一个单行标量：`key: ` 之后的那段（已去掉首尾空格）。
 *
 * 支持：plain、"双引号"（转义只认 \\ \" \n \t \uXXXX）、'单引号'（'' 表示 '）、行尾注释。
 * 拒绝：flow [ ] { }、锚点 &、别名 *、标签 !、保留字符 % @ `。
 *
 * ★ 不做任何类型推断。1.0、no、0123、~、null、2026-10-12 全部原样返回字符串。
 */
export function parseScalar(raw: string): ScalarResult {
  const s = trimSp(raw)
  if (s === '' || s.startsWith('#')) return { ok: true, value: '', colon: false }
  const c0 = s[0]!
  if (c0 === '"') return parseDoubleQuoted(s)
  if (c0 === "'") return parseSingleQuoted(s)
  if (PLAIN_FORBIDDEN_START.has(c0)) {
    return { ok: false, message: `不支持以 ${c0} 开头的值（flow、锚点、别名、标签或保留字符）。` }
  }
  if (s.startsWith('- ') || s === '-' || s.startsWith('? ')) {
    return { ok: false, message: '不支持这种写法；列表请换行写成 `  - item`。' }
  }
  const hash = s.indexOf(' #')
  const value = trimSp(hash >= 0 ? s.slice(0, hash) : s)
  return { ok: true, value, colon: value.includes(': ') || value.endsWith(':') }
}

function afterQuote(rest: string): boolean {
  const r = trimSp(rest)
  return r === '' || (r.startsWith('#') && /^[ \t]/.test(rest))
}

function parseDoubleQuoted(s: string): ScalarResult {
  let out = ''
  let i = 1
  while (i < s.length) {
    const ch = s[i]!
    if (ch === '"') {
      if (!afterQuote(s.slice(i + 1))) return { ok: false, message: '引号结束后还有多余的内容。' }
      return { ok: true, value: out, colon: false }
    }
    if (ch === '\\') {
      const e = s[i + 1]
      if (e === '\\' || e === '"') out += e
      else if (e === 'n') out += '\n'
      else if (e === 't') out += '\t'
      else if (e === 'u') {
        const hex = s.slice(i + 2, i + 6)
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return { ok: false, message: '\\u 后面要跟四位十六进制。' }
        const cp = parseInt(hex, 16)
        // 代理对两边的语言处理不一样（JS 会把两个半边拼成一个字符，Python 不会），直接拒绝
        if (cp >= 0xd800 && cp <= 0xdfff) return { ok: false, message: '不支持用 \\u 写代理对。' }
        out += String.fromCodePoint(cp)
        i += 6
        continue
      } else return { ok: false, message: `不支持的转义：\\${e ?? ''}` }
      i += 2
      continue
    }
    out += ch
    i++
  }
  return { ok: false, message: '双引号没有闭合（不支持跨行的引号字符串）。' }
}

function parseSingleQuoted(s: string): ScalarResult {
  let out = ''
  let i = 1
  while (i < s.length) {
    const ch = s[i]!
    if (ch === "'") {
      if (s[i + 1] === "'") {
        out += "'"
        i += 2
        continue
      }
      if (!afterQuote(s.slice(i + 1))) return { ok: false, message: '引号结束后还有多余的内容。' }
      return { ok: true, value: out, colon: false }
    }
    out += ch
    i++
  }
  return { ok: false, message: '单引号没有闭合（不支持跨行的引号字符串）。' }
}

export type BlockResult = { ok: true; value: string } | { ok: false; message: string }

const BLOCK_HEADERS = new Set(['|', '|-', '>', '>-'])

/**
 * 块标量。header 是 `|`、`|-`、`>`、`>-` 之一（可带行尾注释）；lines 是紧跟其后的、
 * 带原始缩进的续行（含空行）。
 *
 * ★ clip（`|` 和 `>`）固定为「恰好一个末尾 \n」，和输入末尾有没有换行无关。
 *   PyYAML 和 js-yaml 在这一点上的结果就不一样：frontmatter 被 --- 切出来之后，
 *   最后一行有没有换行取决于切法。strip（`|-` 和 `>-`）没有末尾换行。
 * ★ 缩进由第一个非空行决定。比它缩得少的非空行是错误。
 * ★ folded 里比基准缩进更深的行，YAML 规定不折叠，这里直接拒绝，免得和真 YAML 不一致。
 * 不支持 `|+`、`>+` 和显式缩进指示符。
 */
export function blockScalar(header: string, lines: string[]): BlockResult {
  const hash = header.search(/[ \t]#/)
  const h = trimSp(hash >= 0 ? header.slice(0, hash) : header)
  if (!BLOCK_HEADERS.has(h)) return { ok: false, message: `不支持的块标量写法：${h}` }
  const folded = h[0] === '>'
  const strip = h.endsWith('-')

  const blank = (l: string) => /^[ \t]*$/.test(l)
  let start = 0
  while (start < lines.length && blank(lines[start]!)) start++
  if (start === lines.length) return { ok: true, value: '' }
  const n = lines[start]!.length - lines[start]!.replace(/^ +/, '').length

  const body: string[] = []
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]!
    if (blank(l)) {
      body.push('')
      continue
    }
    const ind = l.length - l.replace(/^ +/, '').length
    if (ind < n) return { ok: false, message: '块标量里有一行缩进比第一行少。' }
    if (folded && ind > n) return { ok: false, message: '折叠块（>）里不支持更深的缩进。' }
    body.push(l.slice(n))
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()

  let content: string
  if (!folded) content = body.join('\n')
  else {
    content = body[0]!
    let empties = 0
    for (const l of body.slice(1)) {
      if (l === '') {
        empties++
        continue
      }
      content += empties > 0 ? '\n'.repeat(empties) : ' '
      empties = 0
      content += l
    }
  }
  if (strip || content === '') return { ok: true, value: content }
  return { ok: true, value: content + '\n' }
}

export type ParseResult =
  | { ok: true; fm: Frontmatter; body: string; diags: Diag[] }
  | { ok: false; diags: Diag[] }

export type ParseMode = 'strict' | 'lenient'

export interface ParserParts {
  split: typeof splitFrontmatter
  scalar: typeof parseScalar
  block: typeof blockScalar
}

/** lenient 模式下，这两个字段出了解析问题就整条 skill 不要；其它字段保留原文并告警。 */
export const REQUIRED_FIELDS = ['name', 'description'] as const

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/
const NESTED_KEY = /^ {2}([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/

/**
 * 用三个零件拼出一个解析器。verify 用它把你写的零件装进同一条流水线。
 *
 * strict：遇到第一个错误就失败，像 YAML 库那样。给作者用（CI、提交前检查）。
 * lenient：能救的就救，并留下 warning。给运行时用——别的客户端写的 skill
 *   常常带着「它的解析器碰巧接受」的不规范写法，最常见的是没加引号的 `: `。
 */
export function makeParser(parts: ParserParts): (text: string, mode: ParseMode) => ParseResult {
  return (text, mode) => {
    const sp = parts.split(text)
    if (!sp.ok) return { ok: false, diags: [sp.diag] }
    const lines = sp.yaml
    const fields = dict<FmValue>()
    const order: string[] = []
    const diags: Diag[] = []
    const blank = (l: string) => /^[ \t]*$/.test(l)
    const comment = (l: string) => /^ *#/.test(l)
    const fatal = (d: Diag): ParseResult => ({ ok: false, diags: [...diags, d] })
    const required = (k: string) => (REQUIRED_FIELDS as readonly string[]).includes(k)

    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      if (blank(line) || comment(line)) {
        i++
        continue
      }
      if (/^[ ]*\t/.test(line)) return fatal(err('UNSUPPORTED_YAML', null, '不支持用 tab 缩进。'))
      if (line[0] === ' ') return fatal(err('UNSUPPORTED_YAML', null, `第 ${i + 2} 行缩进不对。`))
      const m = KEY_LINE.exec(line)
      if (!m || (m[2] !== '' && m[2]![0] !== ' ')) {
        return fatal(err('UNSUPPORTED_YAML', null, `第 ${i + 2} 行不是 key: value 的形状。`))
      }
      const key = m[1]!
      let rest = trimSp(m[2]!)
      if (rest.startsWith('#')) rest = ''
      if (hasOwn(fields, key)) return fatal(err('DUPLICATE_KEY', key, `字段 ${key} 出现了两次。`))

      // 续行：空行、缩进行；值为空时还包括顶格的 `- ` 列表项
      let j = i + 1
      const cont: string[] = []
      const isSeqLine = (l: string) => l === '-' || l.startsWith('- ')
      while (
        j < lines.length &&
        (blank(lines[j]!) || /^[ \t]/.test(lines[j]!) || (rest === '' && isSeqLine(lines[j]!)))
      ) {
        cont.push(lines[j]!)
        j++
      }
      if (cont.some((l) => /^[ ]*\t/.test(l) && !blank(l))) {
        return fatal(err('UNSUPPORTED_YAML', key, '不支持用 tab 缩进。'))
      }
      const trimmed = [...cont]
      while (trimmed.length > 0 && blank(trimmed[trimmed.length - 1]!)) trimmed.pop()
      const content = trimmed.filter((l) => !comment(l) || isSeqLine(l))

      // 一个字段的值解析失败时怎么办，按 mode 和字段决定
      let failed: string | null = null
      let value: FmValue = ''
      let colon = false

      if (rest[0] === '|' || rest[0] === '>') {
        const r = parts.block(rest, cont)
        if (r.ok) value = r.value
        else failed = r.message
      } else if (rest === '') {
        const nonblank = content.filter((l) => !blank(l))
        if (nonblank.length === 0) value = ''
        else if (nonblank.every((l) => /^-( |$)/.test(l)) || nonblank.every((l) => /^ {2}-( |$)/.test(l))) {
          const items: string[] = []
          for (const l of nonblank) {
            const r = parts.scalar(l.replace(/^ *-/, ''))
            if (!r.ok) {
              failed = r.message
              break
            }
            colon ||= r.colon
            items.push(r.value)
          }
          value = items
        } else if (nonblank.every((l) => NESTED_KEY.test(l))) {
          const map = dict<string>()
          for (const l of nonblank) {
            const mm = NESTED_KEY.exec(l)!
            const k2 = mm[1]!
            const r2 = mm[2]!
            if (r2 !== '' && r2[0] !== ' ') {
              failed = `${key}.${k2} 的冒号后面要有空格。`
              break
            }
            if (hasOwn(map, k2)) return fatal(err('DUPLICATE_KEY', key, `字段 ${key}.${k2} 出现了两次。`))
            const r = parts.scalar(r2)
            if (!r.ok) {
              if (mode === 'strict') {
                failed = r.message
                break
              }
              // lenient：这一项保留原文
              map[k2] = trimSp(r2)
              diags.push(warn('UNSUPPORTED_YAML', key, `${key}.${k2}：${r.message} 已按原文保留。`))
              continue
            }
            colon ||= r.colon
            map[k2] = r.value
          }
          value = map
        } else {
          failed = '只支持一层嵌套：两个空格缩进的 `key: value`，或者 `- item` 列表。'
        }
      } else {
        const nonblank = content.filter((l) => !blank(l))
        if (nonblank.length > 0 && (rest[0] === '"' || rest[0] === "'")) {
          failed = '不支持跨行的引号字符串。'
        } else if (trimmed.some((l) => blank(l))) {
          failed = '多段的 plain 文本请改用 | 或 > 块。'
        } else {
          // 多行 plain：YAML 把续行用空格接起来，四个解析器在这点上一致
          const joined = [rest, ...nonblank.map((l) => trimSp(l))].join(' ')
          const r = parts.scalar(joined)
          if (r.ok) {
            value = r.value
            colon = r.colon
          } else failed = r.message
        }
      }

      if (failed !== null) {
        if (mode === 'strict' || required(key)) {
          return fatal(err('UNSUPPORTED_YAML', key, `字段 ${key}：${failed}`))
        }
        value = trimSp([rest, ...content.filter((l) => !blank(l)).map((l) => trimSp(l))].join('\n'))
        diags.push(warn('UNSUPPORTED_YAML', key, `字段 ${key}：${failed} 已按原文保留。`))
      } else if (colon) {
        if (mode === 'strict') {
          return fatal(err('COLON_IN_PLAIN', key, `字段 ${key} 的值里有 ": "，要加引号。`))
        }
        diags.push(warn('COLON_IN_PLAIN', key, `字段 ${key} 的值里有 ": "，已按整行文本处理。`))
      }
      fields[key] = value
      order.push(key)
      i = j
    }
    return { ok: true, fm: { fields, order }, body: sp.body, diags }
  }
}

export const parseFrontmatter = makeParser({
  split: splitFrontmatter,
  scalar: parseScalar,
  block: blockScalar,
})

// ─────────────────────────────────────────────────────────────
// 三、校验：严格和宽松是两个函数，不是一个开关
//
// 同一个 name 与目录名不一致的 skill，规范说无效，客户端实现指南说「警告并照常加载」，
// VS Code 静默不加载，Claude Code 和 Codex 照常加载。作者侧要严，运行时要宽，
// 两者对同一输入给出不同结论是**正确行为**。
// ─────────────────────────────────────────────────────────────

export const MAX_NAME = 64
export const MAX_DESC = 1024
export const MAX_COMPAT = 500

/** 规范定义的六个字段，加两个被广泛使用的客户端扩展。这是本 lab 的作者侧策略。 */
export const SPEC_FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']
export const EXTENSION_FIELDS = ['disable-model-invocation', 'user-invocable']
const KNOWN_FIELDS = new Set([...SPEC_FIELDS, ...EXTENSION_FIELDS])
const CORE_FIELDS = new Set(['name', 'description', 'allowed-tools', ...EXTENSION_FIELDS])

export type NameCode = 'NAME_MISSING' | 'NAME_LENGTH' | 'NAME_CHARSET'

/**
 * ★ 规范里同时写着 "unicode lowercase alphanumeric" 和 "(a-z, 0-9)"。
 *   这里取窄的那个：ASCII 小写字母、数字、单个连字符，不以连字符开头或结尾。
 *   skills-ref 用 isalnum() 加 NFKC，于是放行了「技能」和全角字母。
 * ★ 长度按码点算。
 */
export function validateName(name: string): NameCode | null {
  if (name === '') return 'NAME_MISSING'
  if (cpLen(name) > MAX_NAME) return 'NAME_LENGTH'
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return 'NAME_CHARSET'
  return null
}

const NAME_MESSAGES: Record<NameCode, string> = {
  NAME_MISSING: 'name 不能为空。',
  NAME_LENGTH: `name 最长 ${MAX_NAME} 个字符。`,
  NAME_CHARSET: 'name 只能用小写字母、数字和单个连字符，且不能以连字符开头或结尾。',
}

/** 零宽字符、方向控制符、行/段分隔符、BOM、软连字符。不含全角字符：中文 description 里全是全角标点。 */
const INVISIBLE = /[\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/

export function hasInvisible(s: string): boolean {
  return INVISIBLE.test(s)
}

/** allowed-tools 是空格分隔的列表，但 `Bash(git status)` 括号里也有空格。只在括号外切。 */
export function parseAllowedTools(v: FmValue | undefined): string[] {
  if (v === undefined) return []
  if (Array.isArray(v)) return v.map(trimSp).filter((x) => x !== '')
  if (typeof v !== 'string') return []
  const out: string[] = []
  let cur = ''
  let depth = 0
  for (const ch of v) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && (ch === ' ' || ch === '\t' || ch === ',' || ch === '\n')) {
      if (cur !== '') out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur !== '') out.push(cur)
  return out
}

export interface SkillCore {
  name: string
  description: string
  modelInvocable: boolean
  userInvocable: boolean
  allowedTools: string[]
  /** 核心字段之外的一切，原样保留（license、compatibility、metadata、未知字段）。 */
  extra: Record<string, FmValue>
}

export type LoadResult = { load: true; core: SkillCore; diags: Diag[] } | { load: false; diags: Diag[] }

export interface ValidatorParts {
  validateName: typeof validateName
  cpLen: typeof cpLen
}

export function makeValidator(parts: ValidatorParts): {
  validateStrict: (fm: Frontmatter, dirName: string) => Diag[]
  loadLenient: (fm: Frontmatter, dirName: string) => LoadResult
} {
  const isStr = (v: FmValue | undefined): v is string => typeof v === 'string'

  function validateStrict(fm: Frontmatter, dirName: string): Diag[] {
    const out: Diag[] = []
    const f = fm.fields
    for (const k of fm.order) {
      if (!KNOWN_FIELDS.has(k)) out.push(err('UNKNOWN_FIELD', k, `未知字段 ${k}。`))
    }
    const name = f['name']
    if (name === undefined || (isStr(name) && trimSp(name) === '')) {
      out.push(err('NAME_MISSING', 'name', NAME_MESSAGES.NAME_MISSING))
    } else if (!isStr(name)) {
      out.push(err('BAD_TYPE', 'name', 'name 必须是字符串。'))
    } else {
      const code = parts.validateName(name)
      if (code) out.push(err(code, 'name', NAME_MESSAGES[code]))
      if (name !== dirName) {
        out.push(err('NAME_DIR_MISMATCH', 'name', `name「${name}」和目录名「${dirName}」不一致。`))
      }
    }
    const desc = f['description']
    if (desc === undefined || (isStr(desc) && trimSp(desc) === '')) {
      out.push(err('DESC_MISSING', 'description', 'description 不能为空。'))
    } else if (!isStr(desc)) {
      out.push(err('BAD_TYPE', 'description', 'description 必须是字符串。'))
    } else if (parts.cpLen(desc) > MAX_DESC) {
      out.push(err('DESC_LENGTH', 'description', `description 最长 ${MAX_DESC} 个字符。`))
    }
    for (const k of ['license', 'compatibility']) {
      const v = f[k]
      if (v !== undefined && !isStr(v)) out.push(err('BAD_TYPE', k, `${k} 必须是字符串。`))
    }
    const compat = f['compatibility']
    if (isStr(compat) && parts.cpLen(compat) > MAX_COMPAT) {
      out.push(err('COMPAT_LENGTH', 'compatibility', `compatibility 最长 ${MAX_COMPAT} 个字符。`))
    }
    const meta = f['metadata']
    if (meta !== undefined && (typeof meta !== 'object' || Array.isArray(meta))) {
      out.push(err('METADATA_SHAPE', 'metadata', 'metadata 必须是字符串到字符串的映射。'))
    }
    const tools = f['allowed-tools']
    if (tools !== undefined && typeof tools === 'object' && !Array.isArray(tools)) {
      out.push(err('BAD_TYPE', 'allowed-tools', 'allowed-tools 必须是字符串或列表。'))
    }
    for (const k of EXTENSION_FIELDS) {
      const v = f[k]
      if (v !== undefined && v !== 'true' && v !== 'false') {
        out.push(err('BAD_BOOLEAN', k, `${k} 只能是 true 或 false。`))
      }
    }
    for (const k of ['name', 'description']) {
      const v = f[k]
      if (isStr(v) && hasInvisible(v)) out.push(warn('INVISIBLE_CHARS', k, `${k} 里有不可见字符。`))
    }
    return out
  }

  function loadLenient(fm: Frontmatter, dirName: string): LoadResult {
    const diags: Diag[] = []
    const f = fm.fields
    const desc = f['description']
    if (!isStr(desc) || trimSp(desc) === '') {
      return { load: false, diags: [err('DESC_MISSING', 'description', '没有 description，模型无从判断何时使用，跳过。')] }
    }
    if (parts.cpLen(desc) > MAX_DESC) {
      diags.push(warn('DESC_LENGTH', 'description', `description 超过 ${MAX_DESC} 个字符，目录里会被截短。`))
    }
    let name: string
    const raw = f['name']
    if (!isStr(raw) || trimSp(raw) === '') {
      name = dirName
      diags.push(warn('NAME_MISSING', 'name', `没有 name，用目录名「${dirName}」代替。`))
    } else {
      name = raw
      const code = parts.validateName(raw)
      if (code) diags.push(warn(code, 'name', NAME_MESSAGES[code]))
      if (raw !== dirName) {
        diags.push(warn('NAME_DIR_MISMATCH', 'name', `name「${raw}」和目录名「${dirName}」不一致，照常加载。`))
      }
    }
    const bool = (k: string, dflt: boolean): boolean => {
      const v = f[k]
      if (v === undefined) return dflt
      if (v === 'true') return true
      if (v === 'false') return false
      diags.push(warn('BAD_BOOLEAN', k, `${k} 只认 true 或 false，按默认值处理。`))
      return dflt
    }
    const modelInvocable = !bool('disable-model-invocation', false)
    const userInvocable = bool('user-invocable', true)
    const tools = f['allowed-tools']
    if (tools !== undefined && typeof tools === 'object' && !Array.isArray(tools)) {
      diags.push(warn('BAD_TYPE', 'allowed-tools', 'allowed-tools 必须是字符串或列表，已忽略。'))
    }
    for (const k of ['name', 'description']) {
      const v = f[k]
      if (isStr(v) && hasInvisible(v)) diags.push(warn('INVISIBLE_CHARS', k, `${k} 里有不可见字符。`))
    }
    const extra = dict<FmValue>()
    for (const k of fm.order) if (!CORE_FIELDS.has(k)) extra[k] = f[k]!
    return {
      load: true,
      core: {
        name,
        description: desc,
        modelInvocable,
        userInvocable,
        allowedTools: parseAllowedTools(tools),
        extra,
      },
      diags,
    }
  }

  return { validateStrict, loadLenient }
}

export const { validateStrict, loadLenient } = makeValidator({ validateName, cpLen })

// ─────────────────────────────────────────────────────────────
// 四、skill 记录
// ─────────────────────────────────────────────────────────────

export type Scope = 'builtin' | 'enterprise' | 'user' | 'project'
export type Trust = 'builtin' | 'user' | 'project-trusted' | 'project-untrusted'

export interface SkillMeta extends SkillCore {
  /** SKILL.md 的路径。 */
  location: string
  dir: string
  scope: Scope
  trust: Trust
  /** 从哪一类目录来：'.agents'、'.claude'、'.gemini' …… */
  alias: string | null
}

export interface SkillCtx {
  dir: string
  scope: Scope
  trust: Trust
  alias?: string | null
}

/** 从文本直接造一条记录，不碰文件系统。观察实验和 verify 用它。 */
export function skillFromText(
  text: string,
  ctx: SkillCtx,
  parse: (text: string, mode: ParseMode) => ParseResult = parseFrontmatter,
  load: (fm: Frontmatter, dirName: string) => LoadResult = loadLenient,
): { skill: SkillMeta | null; diags: Diag[] } {
  const p = parse(text, 'lenient')
  if (!p.ok) return { skill: null, diags: p.diags }
  const dirName = ctx.dir.split('/').pop() ?? ''
  const l = load(p.fm, dirName)
  if (!l.load) return { skill: null, diags: [...p.diags, ...l.diags] }
  return {
    skill: {
      ...l.core,
      location: `${ctx.dir}/SKILL.md`,
      dir: ctx.dir,
      scope: ctx.scope,
      trust: ctx.trust,
      alias: ctx.alias ?? null,
    },
    diags: [...p.diags, ...l.diags],
  }
}

// ─────────────────────────────────────────────────────────────
// 五、发现
// ─────────────────────────────────────────────────────────────

export interface SkillRoot {
  dir: string
  scope: Scope
  trust: Trust
  alias?: string | null
}

export interface DiscoverOpts {
  maxDepth?: number
  maxDirs?: number
  skip?: string[]
}

export const DEFAULT_DISCOVER = { maxDepth: 6, maxDirs: 2000, skip: ['.git', 'node_modules'] }

/**
 * 在若干根目录下找 skill。
 *
 * ★ 每一层 readdir 的结果都按码点排序。readdir 的顺序取决于文件系统，
 *   「同层同名取先找到的」在不排序的遍历下就是「随机」。
 * ★ 找到 SKILL.md 的目录就是叶子，不再往下找：references/x/SKILL.md 不是另一个 skill。
 * ★ 认 SKILL.md 时比较的是 readdir 返回的名字，不用 existsSync：macOS 默认文件系统
 *   不分大小写，existsSync('SKILL.md') 对 skill.md 也返回 true。
 * ★ 符号链接只在落点仍在根内时才跟。根内的 `pdf -> ~/.ssh` 必须被拦下。
 * ★ 超过深度或目录数上限时留一条诊断，不静默。
 */
export function discover(
  roots: SkillRoot[],
  opts: DiscoverOpts = {},
): { skills: SkillMeta[]; diags: Diag[] } {
  const maxDepth = opts.maxDepth ?? DEFAULT_DISCOVER.maxDepth
  const maxDirs = opts.maxDirs ?? DEFAULT_DISCOVER.maxDirs
  const skip = new Set(opts.skip ?? DEFAULT_DISCOVER.skip)
  const skills: SkillMeta[] = []
  const diags: Diag[] = []
  const at = (d: Diag, path: string): Diag => ({ ...d, path })

  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = realpathSync(root.dir)
    } catch {
      continue
    }
    const visited = new Set<string>([realRoot])
    let dirs = 0
    let stopped = false

    const load = (dir: string) => {
      const location = join(dir, 'SKILL.md')
      const text = readFileSync(location, 'utf8')
      const p = parseFrontmatter(text, 'lenient')
      if (!p.ok) {
        for (const d of p.diags) diags.push(at(d, location))
        return
      }
      const l = loadLenient(p.fm, basename(dir))
      for (const d of [...p.diags, ...l.diags]) diags.push(at(d, location))
      if (!l.load) return
      skills.push({
        ...l.core,
        location,
        dir,
        scope: root.scope,
        trust: root.trust,
        alias: root.alias ?? null,
      })
    }

    const escapes = (full: string): Diag | null => {
      const sp = safePath(root.dir, relative(root.dir, full), true)
      if (sp.ok) return null
      const code = sp.code === 'SYMLINK_ESCAPES_ROOT' ? 'SYMLINK_ESCAPES_ROOT' : 'UNRESOLVABLE'
      return at(warn(code, null, `符号链接指向根目录之外或无法解析，跳过。`), full)
    }

    const walk = (dir: string, depth: number) => {
      if (stopped) return
      if (dirs >= maxDirs) {
        stopped = true
        diags.push(at(warn('TOO_MANY_DIRS', null, `扫描的目录数超过上限 ${maxDirs}，停止。`), root.dir))
        return
      }
      dirs++
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => cmpCp(a.name, b.name))
      } catch {
        diags.push(at(warn('UNRESOLVABLE', null, '目录无法读取，跳过。'), dir))
        return
      }
      const skillMd = entries.find((e) => e.name === 'SKILL.md')
      if (skillMd && depth > 0) {
        const full = join(dir, 'SKILL.md')
        const bad = skillMd.isSymbolicLink() ? escapes(full) : null
        if (bad) diags.push(bad)
        else load(dir)
        return
      }
      const lower = entries.find((e) => e.name !== 'SKILL.md' && e.name.toLowerCase() === 'skill.md')
      if (lower && depth > 0) {
        diags.push(at(warn('LOWERCASE_SKILL_MD', null, `文件名必须是 SKILL.md，这里是 ${lower.name}。`), join(dir, lower.name)))
      }
      for (const e of entries) {
        if (skip.has(e.name)) continue
        const child = join(dir, e.name)
        if (e.isSymbolicLink()) {
          const bad = escapes(child)
          if (bad) {
            diags.push(bad)
            continue
          }
          if (!statSync(child).isDirectory()) continue
        } else if (!e.isDirectory()) continue
        if (depth + 1 > maxDepth) {
          diags.push(at(warn('TOO_DEEP', null, `超过扫描深度上限 ${maxDepth}，没有继续往下找。`), child))
          continue
        }
        const real = realpathSync(child)
        if (visited.has(real)) continue
        visited.add(real)
        walk(child, depth + 1)
      }
    }
    walk(root.dir, 0)
  }
  return { skills, diags }
}

/**
 * ★ 信任过滤必须在合并**之前**。顺序反过来的话，一个陌生仓库里的同名 skill
 *   会先把你自己装的那份遮蔽掉，再被过滤掉——结果两份都没了。
 */
export function filterTrusted(skills: SkillMeta[]): SkillMeta[] {
  return skills.filter((s) => s.trust !== 'project-untrusted')
}

// ─────────────────────────────────────────────────────────────
// 六、同名合并：策略是数据
// ─────────────────────────────────────────────────────────────

export type Policy = 'agentskills-guide' | 'claude-code' | 'gemini-cli' | 'codex'

export interface Shadow {
  name: string
  winner: string
  loser: string
  policy: Policy
}

export interface Resolved {
  active: SkillMeta[]
  shadowed: Shadow[]
  /** 只有 codex 策略会有：同名的几份都留着，按名字引用时一个都不选。 */
  ambiguous: string[]
}

/**
 * 跨层优先级，数字小的赢。
 *   agentskills-guide：指南说 project 覆盖 user 是「各家通用的约定」。
 *   claude-code：enterprise > personal > project，和指南正好相反。
 *   gemini-cli：workspace > user > extension > builtin（enterprise 在这里当 extension 看）。
 */
export const POLICY_RANK: Record<Exclude<Policy, 'codex'>, Record<Scope, number>> = {
  'agentskills-guide': { project: 0, user: 1, enterprise: 2, builtin: 3 },
  'claude-code': { enterprise: 0, user: 1, project: 2, builtin: 3 },
  'gemini-cli': { project: 0, user: 1, enterprise: 2, builtin: 3 },
}

/** gemini-cli 同层时 .agents 胜过 .gemini。 */
export function aliasRank(alias: string | null): number {
  if (alias === '.agents') return 0
  if (alias === '.gemini') return 1
  return 2
}

export function byNameThenLocation(a: SkillMeta, b: SkillMeta): number {
  return cmpCp(a.name, b.name) || cmpCp(a.location, b.location)
}

/**
 * 按策略合并同名 skill。
 *
 * 同层同名：agentskills-guide 和 claude-code 取路径排序后的第一个（first-found），
 * gemini-cli 先比 alias，再取最后一个（last-wins）。
 *
 * ★ 胜出的是**整条记录**。按字段合并（description 来自 A、location 来自 B）
 *   会让模型读到一份说明，加载的却是另一份文件。
 * ★ 每一次遮蔽产生一条 Shadow，用户才知道自己装的那份为什么没生效。
 */
export function resolveCollisions(skills: SkillMeta[], policy: Policy): Resolved {
  const groups = new Map<string, SkillMeta[]>()
  for (const s of skills) {
    const g = groups.get(s.name)
    if (g) g.push(s)
    else groups.set(s.name, [s])
  }
  const names = [...groups.keys()].sort(cmpCp)
  const active: SkillMeta[] = []
  const shadowed: Shadow[] = []
  const ambiguous: string[] = []

  for (const name of names) {
    const g = [...groups.get(name)!].sort(byNameThenLocation)
    if (g.length === 1) {
      active.push(g[0]!)
      continue
    }
    if (policy === 'codex') {
      active.push(...g)
      ambiguous.push(name)
      continue
    }
    const rank = POLICY_RANK[policy]
    const sorted = [...g].sort((a, b) => {
      const r = rank[a.scope] - rank[b.scope]
      if (r !== 0) return r
      if (policy === 'gemini-cli') {
        const ar = aliasRank(a.alias) - aliasRank(b.alias)
        if (ar !== 0) return ar
        return cmpCp(b.location, a.location)
      }
      return cmpCp(a.location, b.location)
    })
    const winner = sorted[0]!
    active.push(winner)
    for (const loser of sorted.slice(1)) {
      shadowed.push({ name, winner: winner.location, loser: loser.location, policy })
    }
  }
  return { active, shadowed, ambiguous }
}

/** 用户或模型按名字点一个 skill。codex 策略下名字不唯一就返回 null。 */
export function selectByName(active: SkillMeta[], name: string): SkillMeta | null {
  const hits = active.filter((s) => s.name === name)
  return hits.length === 1 ? hits[0]! : null
}

// ─────────────────────────────────────────────────────────────
// 七、目录与预算
//
// 目录（catalog）是每一轮都要付的钱。预算不够时的三段：
//   1. 全量放得下 → 全量。
//   2. 否则，若所有 description 都只剩一个「…」时放得下 → 剩余预算按轮转
//      每次给每个 skill 加一个字符，直到谁都加不动。
//   3. 否则 → description 全部去掉，按排序贪心放 skill，第一个放不下的起全部省略。
// 原型是 Codex 的 render.rs。Claude Code 的做法不同：按「最少被调用」先砍
// description，名字永远保留——那依赖使用历史，不是内容的纯函数。
// ─────────────────────────────────────────────────────────────

export type CatalogFormat = 'xml' | 'lines'

export interface CatalogOpts {
  budgetChars: number
  format: CatalogFormat
}

export interface CatalogEntry {
  name: string
  location: string
  /** 显示了多少个码点的 description。阶段 3 为 0。 */
  shown: number
  full: number
}

export interface CatalogResult {
  text: string
  stage: 1 | 2 | 3
  entries: CatalogEntry[]
  omitted: string[]
  warning: string | null
}

/** 目录顺序：builtin、enterprise、project、user，同层按 name、再按路径。阶段 3 时 user 最先被省略。 */
export const CATALOG_RANK: Record<Scope, number> = { builtin: 0, enterprise: 1, project: 2, user: 3 }

/** 进目录的 skill，按目录顺序。disable-model-invocation 的不进：指南要求直接藏起来，而不是列出来再在激活时拒绝。 */
export function catalogOrder(skills: SkillMeta[]): SkillMeta[] {
  return skills
    .filter((s) => s.modelInvocable)
    .sort((a, b) => CATALOG_RANK[a.scope] - CATALOG_RANK[b.scope] || byNameThenLocation(a, b))
}

/** description 的码点数组：空白折成一个空格，首尾去空白。截短按这个数组算。 */
export function catalogDesc(s: SkillMeta): string[] {
  return [...s.description.replace(/[ \t\n\r]+/g, ' ').replace(/^ | $/g, '')]
}

/**
 * 渲染一条。k 是显示多少个码点的 description：k 小于全长时末尾加「…」；
 * k 为 null 表示阶段 3，连 description 这一项都不要。
 *
 * ★ 截短一定要留标记。模型以为自己看到了完整说明，就会按半句话做判断。
 */
export function renderEntry(s: SkillMeta, k: number | null, format: CatalogFormat): string {
  const units = catalogDesc(s)
  const desc = k === null ? null : units.slice(0, k).join('') + (k < units.length ? '…' : '')
  if (format === 'lines') {
    return desc === null ? `- ${s.name} (file: ${s.location})` : `- ${s.name}: ${desc} (file: ${s.location})`
  }
  const lines = ['  <skill>', `    <name>${xmlEscape(s.name)}</name>`]
  if (desc !== null) lines.push(`    <description>${xmlEscape(desc)}</description>`)
  lines.push(`    <location>${xmlEscape(s.location)}</location>`, '  </skill>')
  return lines.join('\n')
}

/** 没有条目时返回空字符串：不输出空的 <available_skills> 块。 */
export function wrapCatalog(entries: string[], format: CatalogFormat): string {
  if (entries.length === 0) return ''
  if (format === 'lines') return entries.join('\n')
  return `<available_skills>\n${entries.join('\n')}\n</available_skills>`
}

export function renderCatalog(skills: SkillMeta[], opts: CatalogOpts): CatalogResult {
  const { budgetChars: budget, format } = opts
  const order = catalogOrder(skills)
  if (order.length === 0) return { text: '', stage: 1, entries: [], omitted: [], warning: null }
  const units = order.map(catalogDesc)
  const caps = units.map((u) => Math.min(u.length, MAX_DESC))
  const entryLen = (i: number, k: number | null) => cpLen(renderEntry(order[i]!, k, format))
  const sepLen = format === 'xml' ? cpLen('<available_skills>\n\n</available_skills>') : 0
  const totalOf = (lens: number[]) =>
    lens.length === 0 ? 0 : lens.reduce((a, b) => a + b, 0) + (lens.length - 1) + sepLen
  const entriesOf = (ks: (number | null)[]): CatalogEntry[] =>
    order.map((s, i) => ({ name: s.name, location: s.location, shown: ks[i] ?? 0, full: units[i]!.length }))

  // 阶段 1
  const full = order.map((s, i) => renderEntry(s, caps[i]!, format))
  if (cpLen(wrapCatalog(full, format)) <= budget) {
    return { text: wrapCatalog(full, format), stage: 1, entries: entriesOf(caps), omitted: [], warning: null }
  }

  // 阶段 2
  const ks = order.map(() => 0)
  const lens = order.map((_, i) => entryLen(i, 0))
  let total = totalOf(lens)
  if (total <= budget) {
    const stuck = caps.map((c) => c === 0)
    let progress = true
    while (progress) {
      progress = false
      for (let i = 0; i < order.length; i++) {
        if (stuck[i]) continue
        const next = entryLen(i, ks[i]! + 1)
        const delta = next - lens[i]!
        if (total + delta <= budget) {
          ks[i]!++
          lens[i] = next
          total += delta
          progress = true
          if (ks[i] === caps[i]) stuck[i] = true
        } else stuck[i] = true
      }
    }
    const cut = ks.filter((k, i) => k < units[i]!.length).length
    return {
      text: wrapCatalog(order.map((s, i) => renderEntry(s, ks[i]!, format)), format),
      stage: 2,
      entries: entriesOf(ks),
      omitted: [],
      warning: `skill 目录超出预算 ${budget}：${cut} 个 description 被截短。`,
    }
  }

  // 阶段 3
  const kept: string[] = []
  const keptLens: number[] = []
  let n = 0
  for (; n < order.length; n++) {
    const e = renderEntry(order[n]!, null, format)
    if (totalOf([...keptLens, cpLen(e)]) > budget) break
    kept.push(e)
    keptLens.push(cpLen(e))
  }
  const omitted = order.slice(n).map((s) => s.name)
  return {
    text: wrapCatalog(kept, format),
    stage: 3,
    entries: entriesOf(order.map(() => null)).slice(0, n),
    omitted,
    warning: `skill 目录超出预算 ${budget}：已移除全部 description，另有 ${omitted.length} 个 skill 未列出。`,
  }
}

/** 目录全量渲染后的 token 估算。 */
export function catalogCost(skills: SkillMeta[], format: CatalogFormat = 'xml'): number {
  return estimateTokens(renderCatalog(skills, { budgetChars: Number.MAX_SAFE_INTEGER, format }).text)
}

// ─────────────────────────────────────────────────────────────
// 八、激活
// ─────────────────────────────────────────────────────────────

/**
 * 激活工具的定义是常量。
 *
 * ★ 指南建议把 name 参数约束成合法名字的 enum。这里不这么做：tools 是缓存前缀的
 *   第一层，enum 一变（装了、删了、改名了一个 skill）整条前缀失效。合法性在 handler 里查，
 *   查不到时把合法名字列表回给模型。
 */
export const ACTIVATE_TOOL = {
  name: 'activate_skill',
  description:
    '加载一个 skill 的完整说明。可用的 skill 列在系统提示的 <available_skills> 里；' +
    '当任务和某个 skill 的 description 相符时，先调用这个工具再动手。',
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'skill 的 name，和目录里写的一致。' } },
    required: ['name'],
    additionalProperties: false,
  },
} as const

export interface Session {
  /** 已激活的 skill 的 location，按激活顺序。 */
  activated: string[]
}

export interface SkillIO {
  read: (path: string) => string
  list: (skill: SkillMeta) => string[]
}

export const FS_IO: SkillIO = {
  read: (p) => readFileSync(p, 'utf8'),
  list: (s) => listResources(s),
}

export type ActivateResult = { ok: true; text: string; first: boolean } | { ok: false; error: string }

/**
 * 激活一个 skill：读正文、去掉 frontmatter、包起来、列出资源。
 *
 * ★ 资源只列路径，不读内容。读不读、读哪个，是模型看了正文之后的事。
 * ★ 同一会话第二次激活只回一句提示，不再注入一遍正文。
 * ★ 模型看不见的 skill（disable-model-invocation）对模型来说就是不存在：
 *   错误信息里也不出现它的名字。
 */
export function activate(
  active: SkillMeta[],
  name: string,
  by: 'model' | 'user',
  session: Session,
  io: SkillIO = FS_IO,
): ActivateResult {
  const visible = active.filter((s) => (by === 'model' ? s.modelInvocable : s.userInvocable))
  const hits = visible.filter((s) => s.name === name)
  if (hits.length === 0) {
    const names = [...new Set(visible.map((s) => s.name))].sort(cmpCp)
    return {
      ok: false,
      error: `没有名为「${name}」的 skill。可用的有：${names.length > 0 ? names.join(', ') : '（无）'}`,
    }
  }
  if (hits.length > 1) {
    return {
      ok: false,
      error: `名为「${name}」的 skill 有 ${hits.length} 份，无法确定用哪一份：${hits.map((s) => s.location).join(', ')}`,
    }
  }
  const s = hits[0]!
  if (session.activated.includes(s.location)) {
    return { ok: true, first: false, text: `skill「${s.name}」已经加载过，说明就在上文。` }
  }
  const sp = splitFrontmatter(io.read(s.location))
  if (!sp.ok) return { ok: false, error: `skill「${s.name}」的文件已经无法解析：${sp.diag.message}` }
  const resources = io.list(s)
  const parts = [
    `<skill_content name="${xmlEscape(s.name)}">`,
    sp.body.replace(/\n+$/, ''),
    '',
    `Skill directory: ${s.dir}`,
    '本 skill 里的相对路径都相对于这个目录。',
  ]
  if (resources.length > 0) {
    parts.push('', '<skill_resources>', ...resources.map((r) => `  <file>${xmlEscape(r)}</file>`), '</skill_resources>')
  }
  parts.push('</skill_content>')
  session.activated.push(s.location)
  return { ok: true, first: true, text: parts.join('\n') }
}

function walkFiles(dir: string, maxDepth: number): string[] {
  const out: string[] = []
  const go = (d: string, rel: string, depth: number) => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => cmpCp(a.name, b.name))
    for (const e of entries) {
      if (DEFAULT_DISCOVER.skip.includes(e.name)) continue
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (depth < maxDepth) go(join(d, e.name), r, depth + 1)
      } else out.push(r)
    }
  }
  go(dir, '', 1)
  return out
}

/** 列出 skill 目录里除 SKILL.md 之外的文件（相对路径，按码点排序）。不跟符号链接，不读内容。 */
export function listResources(skill: SkillMeta, maxDepth = DEFAULT_DISCOVER.maxDepth): string[] {
  return walkFiles(skill.dir, maxDepth).filter((r) => r !== 'SKILL.md')
}

/**
 * 读 skill 里的一个资源文件时，把路径解析到 skill 目录之内。
 *
 * ★ 每个 skill 目录是一个单独的只读根。不要为了读到用户目录里的 skill
 *   去放宽 workspace 的根——那等于把整个 home 交出去。
 * ★ 直接用 safePath，不要自己拼字符串再 startsWith：
 *   `references/creds -> ~/.ssh` 这种符号链接，字符串层面完全正常。
 */
export function resolveSkillResource(skill: SkillMeta, rel: string): SafePath {
  const r = safePath(skill.dir, rel, true)
  if (r.ok && r.realRel === '.') {
    return {
      ok: false,
      code: 'INVALID',
      message: '要读的是 skill 目录里的文件，不是目录本身。',
      logNote: `skill 资源路径指向目录本身：${rel}`,
    }
  }
  return r
}

/**
 * 压缩后重新挂回哪些 skill 正文。规则取自 Claude Code 文档：每个 skill 保留前
 * perSkill 个 token，合计不超过 total，从最近激活的开始填，同名只算最近那次。
 *
 * 文档没说预算剩一点时边界上那个 skill 是截一半还是整个丢掉；这里按「截一半」处理。
 */
export function pinnedAfterCompaction(
  activations: { name: string; tokens: number }[],
  perSkill = 5000,
  total = 25000,
): { name: string; keep: number }[] {
  const seen = new Set<string>()
  const out: { name: string; keep: number }[] = []
  let left = total
  for (let i = activations.length - 1; i >= 0; i--) {
    const a = activations[i]!
    if (seen.has(a.name)) continue
    seen.add(a.name)
    const keep = Math.max(0, Math.min(a.tokens, perSkill, left))
    left -= keep
    out.push({ name: a.name, keep })
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// 九、执行审批：allowed-tools 是预批准，不是限制
// ─────────────────────────────────────────────────────────────

/**
 * skill 目录的内容哈希：所有文件（含 SKILL.md）按相对路径排序，逐个喂进 sha256。
 * 符号链接只记它指向哪，不跟进去。按字节算，不按 UTF-8 文本：二进制资源解码会丢信息。
 */
export function skillDirHash(skill: SkillMeta): string {
  const h = createHash('sha256')
  for (const rel of walkFiles(skill.dir, DEFAULT_DISCOVER.maxDepth)) {
    const full = join(skill.dir, ...rel.split('/'))
    h.update(Buffer.from(rel, 'utf8'))
    h.update(Buffer.from([0]))
    if (lstatSync(full).isSymbolicLink()) {
      h.update(Buffer.from('L' + readlinkSync(full), 'utf8'))
    } else {
      h.update(Buffer.from('F', 'utf8'))
      h.update(readFileSync(full))
    }
    h.update(Buffer.from([0]))
  }
  return h.digest('hex')
}

export type Approval = 'auto' | 'ask' | 'deny'

/**
 * 即使命令被 allowed-tools 预批准，出现这些形状也必须问人。
 * 2026 年规模最大的一次 skill 投毒，载荷就写在 SKILL.md 正文的「前置条件」里：
 * 让你先复制一段 base64 解码后交给 bash 的命令。
 */
export const DANGEROUS_PATTERNS: { id: string; re: RegExp }[] = [
  { id: 'pipe-to-shell', re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/ },
  { id: 'base64-exec', re: /\bbase64\s+(-d|-D|--decode)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/ },
  { id: 'remote-package', re: /\b(npx|uvx|bunx|pnpx)\b|\bpipx\s+run\b/ },
  { id: 'eval-download', re: /\beval\b.*\$\(\s*(curl|wget)\b/ },
]

/** 出现任何一个，命令就不是「一条简单命令」，不能拿去和预批准列表做精确匹配。 */
export const SHELL_META = /[;&|`$<>(){}\n\r]/

/**
 * allowed-tools 里的 Bash 规则：
 *   Bash              → 任何 bash 命令（这就是「预批准」的真实含义：放得很开）
 *   Bash(git status)  → 精确等于
 *   Bash(git diff:*)  → 以 `git diff` 开头（后面是空格或结尾）
 * 命令里有 shell 元字符就一律不算命中：`git status && curl x | sh` 以 `git status` 开头。
 */
export function matchAllowed(command: string, allowedTools: string[]): boolean {
  const cmd = trimSp(command).replace(/[ \t]+/g, ' ')
  if (cmd === '' || SHELL_META.test(cmd)) return false
  for (const t of allowedTools) {
    if (t === 'Bash') return true
    const m = /^Bash\((.*)\)$/.exec(t)
    if (!m) continue
    const pat = trimSp(m[1]!).replace(/[ \t]+/g, ' ')
    if (pat.endsWith(':*')) {
      const prefix = trimSp(pat.slice(0, -2))
      if (cmd === prefix || cmd.startsWith(prefix + ' ')) return true
    } else if (cmd === pat) return true
  }
  return false
}

export interface ApprovalInput {
  skill: SkillMeta
  command: string
  /** 用户批准（或安装）这个 skill 时记下的目录哈希。没批准过就是 null。 */
  approvedHash: string | null
  currentHash: string
}

/**
 * 一个 skill 想跑一条命令时，自动放行、问人，还是拒绝。
 *
 *   project-untrusted               → deny（它根本不该出现在目录里，走到这一步说明流水线有洞）
 *   命中危险模式                     → 至少 ask，即使被预批准
 *   没被 allowed-tools 精确命中       → ask
 *   没批准过，或目录哈希和批准时不同   → ask（skill 版的 rug pull：批准之后被人改了）
 *   以上都不是                       → auto
 *
 * reasons 按上面的顺序列出所有成立的理由，给人看为什么要问。
 */
export function scriptApproval(a: ApprovalInput): { decision: Approval; reasons: string[] } {
  if (a.skill.trust === 'project-untrusted') return { decision: 'deny', reasons: ['UNTRUSTED'] }
  const reasons: string[] = []
  for (const p of DANGEROUS_PATTERNS) if (p.re.test(a.command)) reasons.push(`DANGEROUS:${p.id}`)
  if (!matchAllowed(a.command, a.skill.allowedTools)) reasons.push('NOT_PREAPPROVED')
  if (a.approvedHash === null) reasons.push('NOT_APPROVED')
  else if (a.approvedHash !== a.currentHash) reasons.push('HASH_CHANGED')
  return { decision: reasons.length === 0 ? 'auto' : 'ask', reasons }
}

/**
 * 写进这些目录的文件会变成可触发的 skill。Claude Code 在**当前会话**里就会热加载，
 * 所以一次被注入诱导的写入，下一轮就是一个新 skill。这类写入要按高危处理。
 */
export function isSkillPath(p: string): boolean {
  const s = p.split(sep).join('/').replace(/\\/g, '/')
  return /(^|\/)\.(agents|claude|gemini|codex|cursor)\/skills(\/|$)/.test(s)
}

// ─────────────────────────────────────────────────────────────
// 十、账本：观察实验用的整数算术
// ─────────────────────────────────────────────────────────────

/** 小写词集合的 Jaccard，单位是基点（万分之一）。只是一个确定性的重叠代理指标，不预测触发。 */
export function wordJaccardBp(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== ''))
  const A = words(a)
  const B = words(b)
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  const union = A.size + B.size - inter
  return union === 0 ? 0 : Math.floor((10000 * inter) / union)
}

/** 缓存倍率，单位是百分之一：写 1.25 倍、读 0.1 倍（L15）。 */
export const CACHE_WRITE = 125
export const CACHE_READ = 10

/**
 * R 轮会话里一段内容的输入计费，单位是「基础 token 价 × 1/100」。
 * 从第 from 轮进入上下文：那一轮按缓存写，之后每轮按缓存读。
 */
export function residentCost(tokens: number, rounds: number, from = 1): number {
  if (from > rounds) return 0
  return tokens * CACHE_WRITE + tokens * CACHE_READ * (rounds - from)
}

/**
 * 会话中途改了前缀的某一层，这一轮的输入计费（同上单位）。
 * 前缀的顺序是 tools → system → messages：改了哪一层，它和它后面的全部按缓存写重算。
 */
export function prefixChangeCost(
  layers: { tools: number; system: number; history: number },
  changed: 'tools' | 'system' | 'tail',
): { invalidated: number; cost: number } {
  const { tools, system, history } = layers
  const invalidated = changed === 'tools' ? tools + system + history : changed === 'system' ? system + history : 0
  const kept = tools + system + history - invalidated
  return { invalidated, cost: invalidated * CACHE_WRITE + kept * CACHE_READ }
}

/** 整数的百分之一单位格式化成两位小数，不经过浮点。 */
export function fmtHundredths(h: number): string {
  const neg = h < 0
  const a = Math.abs(h)
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`
}
