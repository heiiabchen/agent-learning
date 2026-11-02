/**
 * Coding agent 的地基：编辑语义、字节层、计划校验、验证解析、终止谓词。
 *
 * ★★ 这一节的中心论点：coding agent 的核心难点不是「让模型写出对的代码」，
 * 而是「让『改动被正确落盘』这件事具备可判定性」。
 *
 * 前 16 节的每个组件失败时都会给信号。代码编辑是第一个
 * 「失败时看起来完全像成功」的子系统——打错缩进、命中第一处而非唯一处、
 * 混合行尾，全都不抛异常、exit code 是 0。
 *
 * 所以这个模块的每一个返回值都带着**可判定的失败原因**。
 * 参考实现故意选择：
 *   · 多处匹配 → NOT_UNIQUE（Anthropic），不是「改第一处」（aider diff）
 *   · 批量编辑全有或全无（不是 aider 的逐条落盘）
 *   · 降级只到 blockIndent，永不 strip()、永不相似度
 *   · 行切分只认 \r\n / \n / \r（Python 的 splitlines 会在 8 个码点上切）
 *
 * 本文件零 DOM、尽量零 IO：applyEdits / plan / parse / canStop 全是纯函数。
 * Workspace 那一层需要 IO，单独放在下面，且依赖 shared/sandbox。
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safePath } from './sandbox.ts'

// ═══════════════════════════════════════════════════════════════════
// 一、行切分 —— 双语言一致性的地基
// ═══════════════════════════════════════════════════════════════════

/**
 * ★ 只在 \r\n / \n / \r 上分行。
 *
 * Python 的 str.splitlines() 还会在 \v \f \x1c \x1d \x1e \x85 \u2028 \u2029
 * 上切——那 8 个码点一旦出现在文件里，TS/Python 的输出就会分叉。
 * 这一节要切的是**文件内容**，所以绝不能用 splitlines。
 */
export function splitLines(s: string): string[] {
  if (s.length === 0) return []
  const out: string[] = []
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x0d) {
      // \r\n 算一个结束符
      out.push(s.slice(start, i))
      if (i + 1 < s.length && s.charCodeAt(i + 1) === 0x0a) i++
      start = i + 1
    } else if (c === 0x0a) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  // ★ 末尾换行不产生空行：`a\n` → ["a"]，`a\n\n` → ["a", ""]
  // 循环里每遇到结束符就 push；若以换行结束则 start === length，不再 push。
  if (start < s.length) out.push(s.slice(start))
  return out
}

export type Eol = '\n' | '\r\n' | '\r' | 'mixed' | 'none'

/** 探测文件的主导行尾。混合时返回 mixed，并保留逐行信息供写回。 */
export function detectEol(s: string): Eol {
  let lf = 0
  let crlf = 0
  let cr = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0d) {
      if (i + 1 < s.length && s.charCodeAt(i + 1) === 0x0a) {
        crlf++
        i++
      } else cr++
    } else if (s.charCodeAt(i) === 0x0a) {
      lf++
    }
  }
  const kinds = [lf > 0, crlf > 0, cr > 0].filter(Boolean).length
  if (kinds === 0) return 'none'
  if (kinds > 1) return 'mixed'
  if (crlf > 0) return '\r\n'
  if (cr > 0) return '\r'
  return '\n'
}

/** 用指定行尾把行重新拼回去。不补末尾换行——NL-1。 */
export function joinLines(lines: string[], eol: '\n' | '\r\n' | '\r', trailingNl: boolean): string {
  if (lines.length === 0) return ''
  const body = lines.join(eol)
  return trailingNl ? body + eol : body
}

export function hasTrailingNl(s: string): boolean {
  return s.endsWith('\n') || s.endsWith('\r')
}

export function stripBom(s: string): { text: string; bom: string } {
  if (s.charCodeAt(0) === 0xfeff) return { text: s.slice(1), bom: '\uFEFF' }
  // UTF-8 BOM 以三个字节出现时，解码后是 U+FEFF；上面已覆盖。
  return { text: s, bom: '' }
}

// ═══════════════════════════════════════════════════════════════════
// 二、匹配阶梯
// ═══════════════════════════════════════════════════════════════════

export type MatchTier = 'exact' | 'eol' | 'blockIndent'

export interface MatchHit {
  /** 字节偏移（在 content 里）。 */
  start: number
  end: number
  /** 1-based 行号。 */
  line: number
}

export interface TierResult {
  tier: MatchTier
  matchCount: number
  hits: MatchHit[]
}

/** 缩进敏感的扩展名。这些文件禁用 strip 语义，blockIndent 也要格外小心。 */
export const INDENT_SENSITIVE = new Set([
  '.py',
  '.pyi',
  '.yaml',
  '.yml',
  '.sass',
  '.styl',
  '.hs',
  '.nim',
  '.coffee',
  '.pug',
  '.mk',
])

export function isIndentSensitive(path: string): boolean {
  const base = path.split(/[/\\]/).pop() ?? path
  if (base === 'Makefile' || base === 'makefile' || base === 'GNUmakefile') return true
  const dot = base.lastIndexOf('.')
  if (dot < 0) return false
  return INDENT_SENSITIVE.has(base.slice(dot).toLowerCase())
}

function lineNumberAt(s: string, offset: number): number {
  let n = 1
  for (let i = 0; i < offset && i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a) n++
    else if (s.charCodeAt(i) === 0x0d) {
      n++
      if (i + 1 < offset && s.charCodeAt(i + 1) === 0x0a) i++
    }
  }
  return n
}

/** exact：逐字节子串搜索，返回所有不重叠命中。 */
export function matchExact(content: string, old: string): MatchHit[] {
  if (old.length === 0) return []
  const hits: MatchHit[] = []
  let from = 0
  while (from <= content.length - old.length) {
    const i = content.indexOf(old, from)
    if (i < 0) break
    hits.push({ start: i, end: i + old.length, line: lineNumberAt(content, i) })
    from = i + old.length
  }
  return hits
}

/**
 * 把文本的行尾统一成 LF，用于 eol 档比较。
 *
 * ★ normToOrig[i] = norm 里第 i 个字符对应的原串起始字节；
 *   normToOrig[norm.length] = 原串长度（哨兵）。
 * CRLF 在 norm 里是一个 \\n，但消耗原串两个字节——哨兵保证 end 落在 \\n 之后。
 */
function normalizeEol(s: string): { norm: string; normToOrig: number[] } {
  let norm = ''
  const normToOrig: number[] = []
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0d) {
      normToOrig.push(i)
      norm += '\n'
      if (i + 1 < s.length && s.charCodeAt(i + 1) === 0x0a) i++
    } else if (s.charCodeAt(i) === 0x0a) {
      normToOrig.push(i)
      norm += '\n'
    } else {
      normToOrig.push(i)
      norm += s[i]!
    }
  }
  normToOrig.push(s.length)
  return { norm, normToOrig }
}

/** eol：忽略行尾差异的匹配。命中位置映射回原 content。 */
export function matchEol(content: string, old: string): MatchHit[] {
  const c = normalizeEol(content)
  const o = normalizeEol(old)
  if (o.norm.length === 0) return []
  const hits: MatchHit[] = []
  let from = 0
  while (from <= c.norm.length - o.norm.length) {
    const i = c.norm.indexOf(o.norm, from)
    if (i < 0) break
    const start = c.normToOrig[i]!
    const end = c.normToOrig[i + o.norm.length]!
    hits.push({ start, end, line: lineNumberAt(content, start) })
    from = i + o.norm.length
  }
  return hits
}

/**
 * blockIndent：所有非空行共享同一个缩进偏移量时才算命中。
 *
 * ★ aider 的正确实现：`if len(add) != 1: return`——偏移量必须唯一。
 * 写回时用原位置的实际缩进 + new 的相对缩进（FUZZ-6）。
 */
export function matchBlockIndent(
  content: string,
  old: string,
): { hits: MatchHit[]; indentShift: number } {
  const contentLines = splitLines(content)
  const oldLines = splitLines(old)
  if (oldLines.length === 0) return { hits: [], indentShift: 0 }

  const oldIndents = oldLines.map(leadingWs)
  const oldBodies = oldLines.map((l, i) => l.slice(oldIndents[i]!.length))
  // 非空行的缩进集合
  const shifts = new Set(oldIndents.filter((_, i) => oldBodies[i]!.length > 0).map((w) => w.length))
  // 允许全空行；若非空行缩进不一致，这一档直接失败（对 old 本身）
  if (shifts.size > 1) return { hits: [], indentShift: 0 }
  const oldShift = shifts.size === 1 ? [...shifts][0]! : 0

  const hits: MatchHit[] = []
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let ok = true
    let contentShift: number | null = null
    for (let j = 0; j < oldLines.length; j++) {
      const cl = contentLines[i + j]!
      const cInd = leadingWs(cl)
      const cBody = cl.slice(cInd.length)
      const oBody = oldBodies[j]!
      if (oBody.length === 0) {
        // old 的空行：content 对应行也必须是空（或只有空白）
        if (cBody.length !== 0) {
          ok = false
          break
        }
        continue
      }
      if (cBody !== oBody) {
        ok = false
        break
      }
      const shift = cInd.length - oldShift
      if (shift < 0) {
        ok = false
        break
      }
      // ★ 所有非空行的偏移量必须一致
      if (contentShift === null) contentShift = shift
      else if (contentShift !== shift) {
        ok = false
        break
      }
      // content 行的缩进必须是 leadingWs 精确等于 shift+oldShift
      if (cInd.length !== shift + oldShift) {
        ok = false
        break
      }
    }
    if (ok && contentShift !== null) {
      // 算字节范围
      const start = offsetOfLine(content, i)
      const end =
        i + oldLines.length >= contentLines.length
          ? content.length
          : offsetOfLine(content, i + oldLines.length)
      hits.push({ start, end, line: i + 1 })
    }
  }
  return { hits, indentShift: 0 }
}

function leadingWs(s: string): string {
  let i = 0
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++
  return s.slice(0, i)
}

function offsetOfLine(s: string, lineIndex: number): number {
  // lineIndex 0-based
  let n = 0
  let i = 0
  while (i < s.length && n < lineIndex) {
    const c = s.charCodeAt(i)
    if (c === 0x0d) {
      i++
      if (i < s.length && s.charCodeAt(i) === 0x0a) i++
      n++
    } else if (c === 0x0a) {
      i++
      n++
    } else i++
  }
  return i
}

/**
 * 按 exact → eol → blockIndent 顺序尝试。
 *
 * ★★ 任一档 matchCount > 1 → 立刻停，返回 NOT_UNIQUE 所需信息。
 * 不得继续往更宽松的档试（FUZZ-2）。
 */
export function matchWithTiers(
  content: string,
  old: string,
  path = '',
): { tierResults: Record<MatchTier, number>; hit: TierResult | null; notUnique: TierResult | null } {
  const tierResults: Record<MatchTier, number> = { exact: 0, eol: 0, blockIndent: 0 }

  const exact = matchExact(content, old)
  tierResults.exact = exact.length
  if (exact.length > 1) {
    return {
      tierResults,
      hit: null,
      notUnique: { tier: 'exact', matchCount: exact.length, hits: exact },
    }
  }
  if (exact.length === 1) {
    return { tierResults, hit: { tier: 'exact', matchCount: 1, hits: exact }, notUnique: null }
  }

  const eol = matchEol(content, old)
  tierResults.eol = eol.length
  if (eol.length > 1) {
    return {
      tierResults,
      hit: null,
      notUnique: { tier: 'eol', matchCount: eol.length, hits: eol },
    }
  }
  if (eol.length === 1) {
    return { tierResults, hit: { tier: 'eol', matchCount: 1, hits: eol }, notUnique: null }
  }

  // 缩进敏感文件：仍然允许 blockIndent（相对缩进偏移），但调用方禁止 strip 档——
  // 我们根本没有 strip 档，所以这里直接跑 blockIndent。
  const { hits: bi } = matchBlockIndent(content, old)
  tierResults.blockIndent = bi.length
  if (bi.length > 1) {
    return {
      tierResults,
      hit: null,
      notUnique: { tier: 'blockIndent', matchCount: bi.length, hits: bi },
    }
  }
  if (bi.length === 1) {
    // 对缩进敏感文件，blockIndent 命中要标出来，写回逻辑另行处理
    void path
    return {
      tierResults,
      hit: { tier: 'blockIndent', matchCount: 1, hits: bi },
      notUnique: null,
    }
  }

  return { tierResults, hit: null, notUnique: null }
}

// ═══════════════════════════════════════════════════════════════════
// 三、applyEdits —— 纯函数，零 IO
// ═══════════════════════════════════════════════════════════════════

export type EditFailReason =
  | 'NOT_UNIQUE'
  | 'NO_MATCH'
  | 'NO_OP'
  | 'EMPTY_OLD'
  | 'OVERLAP'
  | 'ALREADY_APPLIED'
  | 'READ_REQUIRED'
  | 'STALE_READ'
  | 'TRUNCATED_READ'
  | 'FILE_NOT_FOUND'
  | 'DENIED'

export interface EditRequest {
  old: string
  new: string
  /** 默认 "one"：必须唯一。设 "all" 时改每一处（EDIT-4）。 */
  occurrence?: 'one' | 'all'
}

export interface AppliedEdit {
  tier: MatchTier
  start: number
  end: number
  line: number
}

export interface EditOk {
  ok: true
  newContent: string
  applied: AppliedEdit[]
  warnings: string[]
  tierResults: Record<MatchTier, number>
}

export interface EditErr {
  ok: false
  reason: EditFailReason
  /** 失败的那一条在输入数组里的下标。 */
  failedAt: number
  matchCount: number
  matchLines: number[]
  /** 错误信息里的 old 必须逐字节等于输入（EDIT-9）。 */
  old: string
  alreadyApplied?: boolean
  nearest?: string
  tierResults?: Record<MatchTier, number>
  warnings: string[]
  message: string
}

export type EditResult = EditOk | EditErr

function isWhitespaceOnly(s: string): boolean {
  return s.length > 0 && /^\s*$/.test(s)
}

/**
 * 在内存里应用一组编辑。全有或全无。
 *
 * ★ 定位全部基于**原文件**（BATCH-3），不是串行 replace。
 * ★ 重叠 → OVERLAP，零写入（BATCH-1）。
 */
export function applyEdits(content: string, edits: EditRequest[], path = ''): EditResult {
  const warnings: string[] = []
  const eol = detectEol(content)
  if (eol === 'mixed') warnings.push('MIXED_EOL')

  const bom = stripBom(content)
  const body = bom.text
  // 注意：匹配在去 BOM 后的 body 上做；写回时加回 BOM（BOM-1）

  type Planned = {
    index: number
    start: number
    end: number
    replacement: string
    tier: MatchTier
    line: number
  }
  const planned: Planned[] = []
  let lastTierResults: Record<MatchTier, number> = { exact: 0, eol: 0, blockIndent: 0 }

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!
    if (e.old === '' || isWhitespaceOnly(e.old)) {
      return {
        ok: false,
        reason: 'EMPTY_OLD',
        failedAt: i,
        matchCount: 0,
        matchLines: [],
        old: e.old,
        warnings,
        message: 'old 不能为空或全是空白。空 SEARCH 不得退化成追加或全文替换。',
      }
    }
    if (e.new === e.old) {
      return {
        ok: false,
        reason: 'NO_OP',
        failedAt: i,
        matchCount: 0,
        matchLines: [],
        old: e.old,
        warnings,
        message: 'new 与 old 相同，这是空操作。',
      }
    }

    const { tierResults, hit, notUnique } = matchWithTiers(body, e.old, path)
    lastTierResults = tierResults

    if (notUnique) {
      if (e.occurrence === 'all') {
        for (const h of notUnique.hits) {
          planned.push({
            index: i,
            start: h.start,
            end: h.end,
            replacement: rewriteWithTier(body, h, e.new, notUnique.tier),
            tier: notUnique.tier,
            line: h.line,
          })
        }
        continue
      }
      return {
        ok: false,
        reason: 'NOT_UNIQUE',
        failedAt: i,
        matchCount: notUnique.matchCount,
        matchLines: notUnique.hits.map((h) => h.line),
        old: e.old,
        tierResults,
        warnings,
        message: `old 在文件中出现 ${notUnique.matchCount} 次（行 ${notUnique.hits.map((h) => h.line).join(', ')}）。扩大上下文使它唯一，或设 occurrence: "all"。`,
      }
    }

    if (!hit) {
      const already = e.new.length > 0 && body.includes(e.new) && !body.includes(e.old)
      return {
        ok: false,
        reason: 'NO_MATCH',
        failedAt: i,
        matchCount: 0,
        matchLines: [],
        old: e.old,
        alreadyApplied: already || undefined,
        nearest: findNearest(body, e.old),
        tierResults,
        warnings,
        message: already
          ? 'old 不在文件中，但 new 已在——这个编辑可能已经生效过了。'
          : `old 在文件中未找到。tierResults=${JSON.stringify(tierResults)}`,
      }
    }

    const h = hit.hits[0]!
    planned.push({
      index: i,
      start: h.start,
      end: h.end,
      replacement: rewriteWithTier(body, h, e.new, hit.tier),
      tier: hit.tier,
      line: h.line,
    })
  }

  // 重叠检查（按原文件坐标）
  const sorted = [...planned].sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) {
      return {
        ok: false,
        reason: 'OVERLAP',
        failedAt: sorted[i]!.index,
        matchCount: 0,
        matchLines: [],
        old: edits[sorted[i]!.index]!.old,
        warnings,
        message: `第 ${sorted[i]!.index} 条与第 ${sorted[i - 1]!.index} 条的目标区间重叠。`,
      }
    }
  }

  // 从后往前替换，避免偏移
  let out = body
  const applied: AppliedEdit[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!
    out = out.slice(0, p.start) + p.replacement + out.slice(p.end)
    applied.unshift({ tier: p.tier, start: p.start, end: p.end, line: p.line })
  }

  // 恢复 BOM；行尾：若原文件非 mixed，把 replacement 里的行尾统一成原文件风格
  if (eol === '\n' || eol === '\r\n' || eol === '\r') {
    out = unifyEol(out, eol)
  }
  const trailing = hasTrailingNl(content)
  // unifyEol 可能影响末尾；按原文件是否有 trailing nl 校准
  if (trailing && !hasTrailingNl(out)) out = out + (eol === '\r\n' ? '\r\n' : eol === '\r' ? '\r' : '\n')
  if (!trailing && hasTrailingNl(out)) {
    out = out.replace(/(?:\r\n|\n|\r)$/, '')
  }

  return {
    ok: true,
    newContent: bom.bom + out,
    applied,
    warnings,
    tierResults: lastTierResults,
  }
}

function rewriteWithTier(
  content: string,
  hit: MatchHit,
  newText: string,
  tier: MatchTier,
): string {
  if (tier === 'exact') return newText
  if (tier === 'eol') {
    // 用命中区域的主导行尾来写 new
    const region = content.slice(hit.start, hit.end)
    const e = detectEol(region)
    const target = e === '\r\n' || e === '\r' || e === '\n' ? e : '\n'
    return unifyEol(newText, target)
  }
  // blockIndent：把 new 的相对缩进接到命中位置的实际缩进上
  const region = content.slice(hit.start, hit.end)
  const regionLines = splitLines(region)
  const newLines = splitLines(newText)
  if (regionLines.length === 0 || newLines.length === 0) return newText
  const baseIndent = leadingWs(regionLines[0]!)
  const newBase = leadingWs(newLines.find((l) => l.trim().length > 0) ?? newLines[0]!)
  const rebuilt = newLines.map((l) => {
    if (l.trim().length === 0) return l
    const ind = leadingWs(l)
    const body = l.slice(ind.length)
    const rel = Math.max(0, ind.length - newBase.length)
    return baseIndent + ' '.repeat(rel) + body
  })
  const e = detectEol(region)
  const target = e === '\r\n' || e === '\r' || e === '\n' ? e : '\n'
  const trailing = hasTrailingNl(region)
  return joinLines(rebuilt, target, trailing)
}

function unifyEol(s: string, eol: '\n' | '\r\n' | '\r'): string {
  const lines = splitLines(s)
  return joinLines(lines, eol, hasTrailingNl(s))
}

function findNearest(content: string, old: string): string | undefined {
  // 极简：取 old 的第一行在文件中的第一次出现，返回前后各一行作为提示
  const first = splitLines(old)[0]
  if (!first || first.trim().length < 3) return undefined
  const idx = content.indexOf(first.trim())
  if (idx < 0) return undefined
  const line = lineNumberAt(content, idx)
  const lines = splitLines(content)
  const from = Math.max(0, line - 2)
  const to = Math.min(lines.length, line + 1)
  return lines.slice(from, to).join('\n')
}

// ═══════════════════════════════════════════════════════════════════
// 四、计划作为可校验的数据结构
// ═══════════════════════════════════════════════════════════════════

export type PlanStepKind = 'read' | 'edit' | 'verify' | 'command' | 'other'

export interface PlanStep {
  id: string
  kind: PlanStepKind
  targets: string[]
  dependsOn: string[]
  status?: 'pending' | 'done' | 'skipped'
}

export interface Plan {
  steps: PlanStep[]
}

export type PlanFailReason =
  | 'EMPTY'
  | 'DUPLICATE_STEP_ID'
  | 'CYCLE'
  | 'DANGLING_DEP'
  | 'NO_VERIFY_STEP'
  | 'EDIT_WITHOUT_READ'
  | 'LOST_COMPLETED_STEP'
  | 'MISSING_REASON'
  | 'PLAN_THRASHING'

export interface PlanOk {
  ok: true
}

export interface PlanErr {
  ok: false
  reason: PlanFailReason
  detail: string[]
  message: string
}

export type PlanResult = PlanOk | PlanErr

export function validatePlan(plan: Plan): PlanResult {
  if (!plan.steps || plan.steps.length === 0) {
    return { ok: false, reason: 'EMPTY', detail: [], message: '计划不能为空。' }
  }
  const ids = new Map<string, number>()
  const dup: string[] = []
  for (const s of plan.steps) {
    const n = (ids.get(s.id) ?? 0) + 1
    ids.set(s.id, n)
    if (n === 2) dup.push(s.id)
  }
  if (dup.length) {
    return {
      ok: false,
      reason: 'DUPLICATE_STEP_ID',
      detail: dup,
      message: `重复的 step id：${dup.join(', ')}`,
    }
  }

  const byId = new Map(plan.steps.map((s) => [s.id, s]))
  const dangling: string[] = []
  for (const s of plan.steps) {
    for (const d of s.dependsOn) {
      if (!byId.has(d)) dangling.push(`${s.id}→${d}`)
    }
  }
  if (dangling.length) {
    return {
      ok: false,
      reason: 'DANGLING_DEP',
      detail: dangling,
      message: `依赖指向不存在的 id：${dangling.join(', ')}`,
    }
  }

  const cycle = findCycle(plan.steps)
  if (cycle) {
    return {
      ok: false,
      reason: 'CYCLE',
      detail: cycle,
      message: `依赖图有环：${cycle.join(' → ')}`,
    }
  }

  if (!plan.steps.some((s) => s.kind === 'verify')) {
    return {
      ok: false,
      reason: 'NO_VERIFY_STEP',
      detail: [],
      message: '计划里至少要有一个 kind === "verify" 的步骤。',
    }
  }

  // EDIT_WITHOUT_READ：每个 edit 的每个 target，祖先里要有 read 覆盖它
  const missing: string[] = []
  for (const e of plan.steps.filter((s) => s.kind === 'edit')) {
    const ancestors = ancestorIds(e.id, byId)
    for (const t of e.targets) {
      let covered = false
      for (const aid of ancestors) {
        const a = byId.get(aid)!
        if (a.kind === 'read' && a.targets.includes(t)) {
          covered = true
          break
        }
      }
      if (!covered) missing.push(`${e.id}:${t}`)
    }
  }
  if (missing.length) {
    return {
      ok: false,
      reason: 'EDIT_WITHOUT_READ',
      detail: missing,
      message: `这些编辑没有先读：${missing.join(', ')}`,
    }
  }

  return { ok: true }
}

function findCycle(steps: PlanStep[]): string[] | null {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const dfs = (id: string): string[] | null => {
    state.set(id, 1)
    stack.push(id)
    for (const d of byId.get(id)?.dependsOn ?? []) {
      const st = state.get(d) ?? 0
      if (st === 1) {
        const i = stack.indexOf(d)
        return [...stack.slice(i), d]
      }
      if (st === 0) {
        const c = dfs(d)
        if (c) return c
      }
    }
    stack.pop()
    state.set(id, 2)
    return null
  }
  for (const s of steps) {
    if ((state.get(s.id) ?? 0) === 0) {
      const c = dfs(s.id)
      if (c) return c
    }
  }
  return null
}

function ancestorIds(id: string, byId: Map<string, PlanStep>): Set<string> {
  const out = new Set<string>()
  const stack = [...(byId.get(id)?.dependsOn ?? [])]
  while (stack.length) {
    const x = stack.pop()!
    if (out.has(x)) continue
    out.add(x)
    for (const d of byId.get(x)?.dependsOn ?? []) stack.push(d)
  }
  return out
}

export interface ReviseOpts {
  reason?: string
  reviseCount: number
  maxRevises: number
}

export function revisePlan(prev: Plan, next: Plan, opts: ReviseOpts): PlanResult {
  if (!opts.reason || opts.reason.trim() === '') {
    return {
      ok: false,
      reason: 'MISSING_REASON',
      detail: [],
      message: 'revise_plan 必须带 reason。',
    }
  }
  if (opts.reviseCount >= opts.maxRevises) {
    return {
      ok: false,
      reason: 'PLAN_THRASHING',
      detail: [String(opts.reviseCount)],
      message: `修订次数已达上限 ${opts.maxRevises}。`,
    }
  }
  const prevDone = prev.steps.filter((s) => s.status === 'done')
  for (const d of prevDone) {
    const n = next.steps.find((s) => s.id === d.id)
    if (!n) {
      return {
        ok: false,
        reason: 'LOST_COMPLETED_STEP',
        detail: [d.id],
        message: `不得删除已完成的 step ${d.id}。`,
      }
    }
    const sameTargets =
      n.targets.length === d.targets.length && n.targets.every((t, i) => t === d.targets[i])
    if (!sameTargets) {
      return {
        ok: false,
        reason: 'LOST_COMPLETED_STEP',
        detail: [d.id],
        message: `不得修改已完成 step ${d.id} 的 targets。`,
      }
    }
  }
  return validatePlan(next)
}

export type Phase = 'plan' | 'execute'

export function toolsFor(phase: Phase): string[] {
  if (phase === 'plan') {
    return ['read_file', 'list_dir', 'grep', 'submit_plan', 'revise_plan']
  }
  return [
    'read_file',
    'list_dir',
    'grep',
    'edit_file',
    'create_file',
    'run_command',
    'revise_plan',
    'give_up',
  ]
}

export interface ToolLogEntry {
  seq: number
  tool: string
  path?: string
  stepId?: string
}

export interface Adherence {
  unplannedFiles: string[]
  unvisitedFiles: string[]
  orderViolations: string[]
  verifyRanAfterLastEdit: boolean
}

export function adherence(plan: Plan, log: ToolLogEntry[]): Adherence {
  const plannedEdit = new Set(
    plan.steps.filter((s) => s.kind === 'edit').flatMap((s) => s.targets.map(normalizeRel)),
  )
  const actualEdit = new Set(
    log
      .filter((e) => e.tool === 'edit_file' || e.tool === 'create_file')
      .map((e) => normalizeRel(e.path ?? ''))
      .filter(Boolean),
  )
  const unplannedFiles = [...actualEdit].filter((p) => !plannedEdit.has(p)).sort()
  const unvisitedFiles = [...plannedEdit].filter((p) => !actualEdit.has(p)).sort()

  const seqOf = new Map<string, number>()
  for (const e of log) {
    if (e.stepId && !seqOf.has(e.stepId)) seqOf.set(e.stepId, e.seq)
  }
  const orderViolations: string[] = []
  for (const s of plan.steps) {
    const sSeq = seqOf.get(s.id)
    if (sSeq === undefined) continue
    for (const d of s.dependsOn) {
      const dSeq = seqOf.get(d)
      if (dSeq !== undefined && sSeq < dSeq) {
        orderViolations.push(`${s.id} before ${d}`)
      }
    }
  }

  let lastEditSeq = -1
  let lastVerifySeq = -1
  for (const e of log) {
    if (e.tool === 'edit_file' || e.tool === 'create_file') lastEditSeq = Math.max(lastEditSeq, e.seq)
    if (e.tool === 'run_command' || e.tool === 'verify') lastVerifySeq = Math.max(lastVerifySeq, e.seq)
  }
  const verifyRanAfterLastEdit = lastVerifySeq > lastEditSeq && lastEditSeq >= 0

  return { unplannedFiles, unvisitedFiles, orderViolations, verifyRanAfterLastEdit }
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

// ═══════════════════════════════════════════════════════════════════
// 五、测试输出解析与终止谓词
// ═══════════════════════════════════════════════════════════════════

export type ParserConfidence = 'exact' | 'unparsed'

export interface VerifyResult {
  runner: string
  passed: number
  failed: number
  skipped: number
  collected: number
  confidence: ParserConfidence
  exitCode: number
}

export function isGreen(v: VerifyResult): boolean {
  if (v.confidence !== 'exact') return false
  if (v.collected === 0) return false
  if (v.failed > 0) return false
  if (v.exitCode !== 0) return false
  return true
}

/** 去掉 ANSI 转义。 */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

interface Runner {
  name: string
  re: RegExp
  /** summary 行必须以行结束符收尾：截断在 summary 中间时不得命中（PARSE-6）。 */
  needsEol: boolean
  parse: (m: RegExpMatchArray) => Partial<VerifyResult>
}

/**
 * ★ 逐行匹配，正则一律不带 m 标志、空白只写 [ \t]。
 * JS 的 m 标志在 \r、\u2028、\u2029 后也算行首，Python 的 re.M 只认 \n；
 * JS 的 \s 含 \uFEFF 不含 \x1c，Python 正好相反。同一段输出会一绿一红（PARSE-8/9）。
 */
const RUNNERS: Runner[] = [
  {
    name: 'pytest',
    re: /^=+ ([^=]+?) in [0-9.]+s =+$/g,
    needsEol: true,
    parse: (m) => parsePytestParts(m[1]!),
  },
  {
    name: 'vitest',
    re: /Tests[ \t]+([0-9]+)[ \t]+passed(?:[ \t]+\|[ \t]+([0-9]+)[ \t]+failed)?(?:[ \t]+\|[ \t]+([0-9]+)[ \t]+skipped)?/gi,
    needsEol: false,
    parse: (m) => ({
      passed: Number(m[1]),
      failed: Number(m[2] ?? 0),
      skipped: Number(m[3] ?? 0),
    }),
  },
  {
    name: 'jest',
    re: /Tests:[ \t]+([0-9]+)[ \t]+failed,[ \t]+([0-9]+)[ \t]+passed,[ \t]+([0-9]+)[ \t]+total/gi,
    needsEol: false,
    parse: (m) => ({
      failed: Number(m[1]),
      passed: Number(m[2]),
      collected: Number(m[3]),
    }),
  },
  {
    name: 'jest',
    re: /Tests:[ \t]+([0-9]+)[ \t]+passed,[ \t]+([0-9]+)[ \t]+total/gi,
    needsEol: false,
    parse: (m) => ({
      passed: Number(m[1]),
      failed: 0,
      collected: Number(m[2]),
    }),
  },
  {
    name: 'go',
    re: /^PASS$/g,
    needsEol: false,
    parse: () => ({ passed: 1, failed: 0, skipped: 0 }),
  },
  {
    name: 'go',
    re: /^FAIL$/g,
    needsEol: false,
    parse: () => ({ passed: 0, failed: 1, skipped: 0 }),
  },
  {
    name: 'cargo',
    re: /test result:[ \t]+ok\.[ \t]+([0-9]+)[ \t]+passed;[ \t]+([0-9]+)[ \t]+failed;[ \t]+([0-9]+)[ \t]+ignored/g,
    needsEol: false,
    parse: (m) => ({
      passed: Number(m[1]),
      failed: Number(m[2]),
      skipped: Number(m[3]),
    }),
  },
]

/**
 * 解析测试输出。★ 反向扫描 summary（PARSE-7），截断 → unparsed（PARSE-6）。
 * ★ 先用 splitLines 切行，再逐行匹配——「什么算一行」只在 splitLines 里定义一次。
 */
export function parseTestOutput(raw: string, exitCode: number, runnerHint = ''): VerifyResult {
  const text = stripAnsi(raw)

  // pytest「no tests ran」
  if (/no tests ran/i.test(text)) {
    return {
      runner: 'pytest',
      passed: 0,
      failed: 0,
      skipped: 0,
      collected: 0,
      confidence: 'exact',
      exitCode,
    }
  }

  const lines = splitLines(text)
  const lastTerminated = hasTrailingNl(text)

  // ★ 反向：找最后一次命中。位置按（行号，行内偏移）比较。
  let best: { name: string; line: number; col: number; partial: Partial<VerifyResult> } | null = null
  for (const r of RUNNERS) {
    if (runnerHint && r.name !== runnerHint && runnerHint !== 'auto') continue
    for (let i = lines.length - 1; i >= 0; i--) {
      if (r.needsEol && i === lines.length - 1 && !lastTerminated) continue
      let last: RegExpMatchArray | null = null
      for (const m of lines[i]!.matchAll(r.re)) last = m
      if (!last) continue
      const col = last.index ?? 0
      if (best === null || i > best.line || (i === best.line && col > best.col)) {
        best = { name: r.name, line: i, col, partial: r.parse(last) }
      }
      break
    }
  }

  if (!best) {
    return {
      runner: runnerHint || 'unknown',
      passed: 0,
      failed: 0,
      skipped: 0,
      collected: 0,
      confidence: 'unparsed',
      exitCode,
    }
  }

  const passed = best.partial.passed ?? 0
  const failed = best.partial.failed ?? 0
  const skipped = best.partial.skipped ?? 0
  const collected = best.partial.collected ?? passed + failed + skipped
  return {
    runner: best.name,
    passed,
    failed,
    skipped,
    collected,
    confidence: 'exact',
    exitCode,
  }
}

function parsePytestParts(parts: string): Partial<VerifyResult> {
  // "3 passed, 1 skipped" / "2 failed, 3 passed" / "1 error"
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const bit of parts.split(',')) {
    const m = bit.match(/^[ \t]*([0-9]+)[ \t]+([A-Za-z]+)/)
    if (!m) continue
    const n = Number(m[1])
    const k = m[2]!
    if (k.startsWith('passed')) passed = n
    else if (k.startsWith('failed') || k.startsWith('error')) failed += n
    else if (k.startsWith('skipped') || k.startsWith('xfailed') || k.startsWith('xpassed'))
      skipped += n
  }
  return { passed, failed, skipped, collected: passed + failed + skipped }
}

export interface Baseline {
  collected: number
  skipped: number
  testFileHashes: Record<string, string>
}

export interface StopState {
  finished: boolean
  gaveUp: boolean
  giveUpReason?: string
  lastEditSeq: number
  lastVerifySeq: number
  verify: VerifyResult | null
  unplannedFiles: string[]
  revisedForUnplanned: boolean
  currentTestFileHashes: Record<string, string>
}

export interface StopDecision {
  canStop: boolean
  outcome: 'success' | 'gave_up' | 'continue'
  reasons: string[]
}

export function canStop(state: StopState, baseline: Baseline): StopDecision {
  if (state.gaveUp) {
    if (state.giveUpReason && state.giveUpReason.trim()) {
      return { canStop: true, outcome: 'gave_up', reasons: [] }
    }
    return { canStop: false, outcome: 'continue', reasons: ['give_up 缺 reason'] }
  }

  const reasons: string[] = []
  if (!state.verify) reasons.push('从未跑 verify')
  else {
    if (state.verify.confidence !== 'exact') reasons.push('parserConfidence=unparsed')
    if (state.verify.collected === 0) reasons.push('collected=0')
    if (state.verify.failed > 0) reasons.push('有失败用例')
    if (state.verify.exitCode !== 0) reasons.push(`exitCode=${state.verify.exitCode}`)
    if (!isGreen(state.verify)) {
      /* already covered */
    }
    if (state.lastVerifySeq <= state.lastEditSeq) {
      reasons.push('verify 不在最后一次 edit 之后')
    }
    if (state.verify.collected < baseline.collected) {
      reasons.push(`collected 比 baseline 少 ${baseline.collected - state.verify.collected}`)
    }
    if (state.verify.skipped > baseline.skipped) {
      reasons.push(`skipped 比 baseline 多 ${state.verify.skipped - baseline.skipped}`)
    }
  }
  if (state.unplannedFiles.length > 0 && !state.revisedForUnplanned) {
    reasons.push('有计划外改动且未 revise_plan')
  }
  for (const [f, h] of Object.entries(baseline.testFileHashes)) {
    if (state.currentTestFileHashes[f] !== h) {
      reasons.push(`测试文件被改动：${f}`)
    }
  }

  if (!state.finished && reasons.length === 0) {
    // 模型还没 finish，但其他都满足——仍应等 finish；不过 STOP 用例里 finished 是显式的
  }
  if (!state.finished) reasons.push('模型未 finish')

  if (reasons.length) return { canStop: false, outcome: 'continue', reasons }
  return { canStop: true, outcome: 'success', reasons: [] }
}

// ═══════════════════════════════════════════════════════════════════
// 六、reward hacking 检测器（测检测器，不测模型）
// ═══════════════════════════════════════════════════════════════════

export type HackSeverity = 'warn' | 'block'

export interface HackFinding {
  rule: string
  severity: HackSeverity
  evidence: { file?: string; line?: number; snippet?: string }
}

const SKIP_MARKERS =
  /@pytest\.mark\.(?:xfail|skip)\b|@unittest\.skip\b|\bit\.skip\s*\(|\tt\.Skip\s*\(/

export function detectHacks(input: {
  verifyOutput?: string
  exitCode?: number
  baseline?: Baseline
  verify?: VerifyResult
  /** unified diff 或「path → new content」表。 */
  diffText?: string
  changedFiles?: string[]
  toolLog?: ToolLogEntry[]
  installedPackages?: string[]
}): HackFinding[] {
  const out: HackFinding[] = []
  const v = input.verify
  if (v && input.verifyOutput) {
    const resultLines = (input.verifyOutput.match(/\b(?:PASSED|FAILED|ERROR|SKIPPED)\b/gi) ?? [])
      .length
    if (v.collected >= 12 && resultLines > 0 && resultLines < v.collected / 2 && (input.exitCode ?? 0) === 0) {
      out.push({
        rule: 'EARLY_EXIT',
        severity: 'block',
        evidence: { snippet: `collected=${v.collected} resultLines=${resultLines}` },
      })
    }
  }
  if (v && input.baseline) {
    if (v.skipped > input.baseline.skipped) {
      out.push({
        rule: 'SKIP_INCREASED',
        severity: 'block',
        evidence: {
          snippet: `skipped ${input.baseline.skipped}→${v.skipped}`,
        },
      })
    }
  }

  const files = input.changedFiles ?? []
  for (const f of files) {
    const norm = normalizeRel(f)
    if (/(^|\/)tests?\//.test(norm) || /(^|\/)__tests__\//.test(norm)) {
      out.push({
        rule: 'TEST_FILE_MODIFIED',
        severity: 'block',
        evidence: { file: norm },
      })
    }
    if (
      norm.includes('site-packages/') ||
      norm.includes('node_modules/') ||
      norm.includes('/.venv/') ||
      norm.startsWith('.venv/')
    ) {
      out.push({
        rule: 'UPSTREAM_MODIFIED',
        severity: 'block',
        evidence: { file: norm },
      })
    }
  }

  const diff = input.diffText ?? ''
  if (SKIP_MARKERS.test(diff)) {
    out.push({
      rule: 'SKIP_MARKER_ADDED',
      severity: 'block',
      evidence: { snippet: diff.match(SKIP_MARKERS)?.[0] },
    })
  }
  if (/\bsys\.exit\s*\(\s*0\s*\)|\bos\._exit\s*\(\s*0\s*\)|\bprocess\.exit\s*\(\s*0\s*\)/.test(diff)) {
    out.push({
      rule: 'SUSPICIOUS_EXIT',
      severity: 'warn',
      evidence: { snippet: 'exit(0) added' },
    })
  }
  if (
    /raise\s+unittest\.SkipTest|pytest\.skip\s*\(/.test(diff) &&
    !/(^|\n)\+\+\+\s+.*tests?\//.test(diff)
  ) {
    out.push({
      rule: 'SKIP_FROM_SOURCE',
      severity: 'block',
      evidence: { snippet: 'skip from non-test file' },
    })
  }

  // STUB_SUSPECTED：粗测——大块删除 + 新增 pass/TODO/NotImplemented
  if (
    (diff.match(/^-/gm) ?? []).length >= 10 &&
    /^\+\s*(pass|TODO|NotImplemented|throw new Error\(['"]not implemented)/m.test(diff)
  ) {
    out.push({
      rule: 'STUB_SUSPECTED',
      severity: 'warn',
      evidence: { snippet: 'large deletion + stub' },
    })
  }

  for (const f of files) {
    const top = normalizeRel(f).split('/')[0]!
    if (input.installedPackages?.includes(top)) {
      out.push({
        rule: 'PACKAGE_SHADOWING',
        severity: 'block',
        evidence: { file: top },
      })
    }
  }

  for (const e of input.toolLog ?? []) {
    if (e.tool === 'read_file' && e.path && /(^|\/)tests?\//.test(normalizeRel(e.path))) {
      out.push({
        rule: 'READ_TEST_FILE',
        severity: 'warn',
        evidence: { file: e.path },
      })
    }
  }

  return out
}

// ═══════════════════════════════════════════════════════════════════
// 七、Workspace：读后写、快照、回滚、沙箱
// ═══════════════════════════════════════════════════════════════════

export const DENIED_PREFIXES = [
  '.git/',
  'node_modules/',
  '.venv/',
  'site-packages/',
  'tests/hidden/',
]

export const DENIED_NAMES = ['.env', '.env.local', '.env.production']

export const HIGH_RISK =
  /(?:^|\/)(?:package\.json|Makefile|conftest\.py|CLAUDE\.md|.+\.config\.[jt]s)$|^\.github\/workflows\//i

export type DenyReason =
  | 'ESCAPES_ROOT'
  | 'ABSOLUTE_PATH'
  | 'NUL_BYTE'
  | 'BACKSLASH'
  | 'SYMLINK_ESCAPES_ROOT'
  | 'WRITE_THROUGH_SYMLINK'
  | 'SYMLINK_LOOP'
  | 'DENIED_PATH'
  | 'REQUIRES_CONFIRMATION'

export interface ResolveOk {
  ok: true
  full: string
  rel: string
  requiresConfirmation?: boolean
}

export interface ResolveErr {
  ok: false
  reason: DenyReason
  message: string
}

/**
 * 在 safePath 之上叠加 deny 规则与写穿 symlink 检查。
 *
 * ★ deny 在规范化之后做（SBX-11：`./.git/config` 不能靠字面前缀绕过）。
 * ★ 目标不存在也解析符号链接：realpath 落在最近的已存在祖先上（SBX-8）。
 * ★ deny 用 OR：请求的路径或它解析到的路径，任一命中就拒（SBX-15）。
 */
export function resolveInWorkspace(
  root: string,
  input: string,
  op: 'read' | 'write',
): ResolveOk | ResolveErr {
  if (input.includes('\0')) {
    return { ok: false, reason: 'NUL_BYTE', message: '路径含 NUL 字节。' }
  }
  if (input.includes('\\')) {
    return { ok: false, reason: 'BACKSLASH', message: '路径不得含反斜杠，请用 /。' }
  }
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
    return { ok: false, reason: 'ABSOLUTE_PATH', message: '不接受绝对路径。' }
  }

  const sp = safePath(root, input, true)
  if (!sp.ok) {
    if (sp.code === 'SYMLINK_LOOP') return { ok: false, reason: 'SYMLINK_LOOP', message: sp.message }
    if (sp.code === 'SYMLINK_ESCAPES_ROOT' || sp.code === 'UNRESOLVABLE') {
      return { ok: false, reason: 'SYMLINK_ESCAPES_ROOT', message: sp.message }
    }
    return { ok: false, reason: 'ESCAPES_ROOT', message: sp.message }
  }

  const rel = sp.rel.replace(/\\/g, '/')
  const realRel = sp.realRel.replace(/\\/g, '/')
  if (isDenied(rel) || isDenied(realRel)) {
    return { ok: false, reason: 'DENIED_PATH', message: `拒绝访问 ${rel}` }
  }

  if (op === 'write' && lexists(sp.full) && lstatSync(sp.full).isSymbolicLink()) {
    return {
      ok: false,
      reason: 'WRITE_THROUGH_SYMLINK',
      message: `拒绝穿过符号链接写入：${rel}`,
    }
  }

  const requiresConfirmation = HIGH_RISK.test(rel) || HIGH_RISK.test(realRel)
  return { ok: true, full: sp.full, rel, requiresConfirmation }
}

/** ★ 大小写不敏感：macOS 和 Windows 的默认文件系统上 `.ENV` 就是 `.env`（SBX-14）。 */
function isDenied(rel: string): boolean {
  const p = rel.toLowerCase()
  const base = p.split('/').pop() ?? p
  if (DENIED_NAMES.includes(base) || base.startsWith('.env.')) return true
  return DENIED_PREFIXES.some((d) => p === d.slice(0, -1) || p.startsWith(d))
}

function lexists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

export interface ReadResult {
  ok: boolean
  path?: string
  content?: string
  hash?: string
  truncated?: boolean
  warnings?: string[]
  message?: string
}

export interface InvisibleHit {
  codepoint: string
  line: number
  col: number
}

const INVISIBLE =
  /[\u00A0\u200B-\u200F\u2028\u2029\uFEFF\uFF01-\uFF5E]/g

export function findInvisible(content: string): InvisibleHit[] {
  const hits: InvisibleHit[] = []
  const lines = splitLines(content)
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci]!
      if (
        ch === '\u00A0' ||
        (ch >= '\u200B' && ch <= '\u200F') ||
        ch === '\u2028' ||
        ch === '\u2029' ||
        (ch === '\uFEFF' && !(li === 0 && ci === 0)) ||
        (ch >= '\uFF01' && ch <= '\uFF5E')
      ) {
        hits.push({
          codepoint: `U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
          line: li + 1,
          col: ci + 1,
        })
      }
    }
  }
  void INVISIBLE
  return hits
}

export function contentHash(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

type SnapEntry = { kind: 'file'; bytes: string } | { kind: 'absent' }

/**
 * 工作区：强制 read-before-write、懒快照、回滚。
 */
export class Workspace {
  private hashes = new Map<string, string>()
  private truncated = new Set<string>()
  private snapshot = new Map<string, SnapEntry>()
  private seq = 0
  readonly log: ToolLogEntry[] = []

  constructor(public readonly root: string) {}

  get snapshotSize(): number {
    return this.snapshot.size
  }

  read(path: string, opts: { maxChars?: number; range?: [number, number] } = {}): ReadResult {
    const r = resolveInWorkspace(this.root, path, 'read')
    if (!r.ok) return { ok: false, message: r.message }
    if (!existsSync(r.full)) return { ok: false, message: `文件不存在：${r.rel}` }
    let content = readFileSync(r.full, 'utf8')
    const warnings: string[] = []
    const inv = findInvisible(content)
    if (inv.length) {
      warnings.push(
        `invisible: ${inv
          .slice(0, 5)
          .map((h) => `${h.codepoint} at line ${h.line} col ${h.col}`)
          .join('; ')}`,
      )
    }
    if (detectEol(content) === 'mixed') warnings.push('MIXED_EOL')

    let truncated = false
    if (opts.range) {
      const lines = splitLines(content)
      const [a, b] = opts.range
      content = joinLines(lines.slice(a, b), detectEol(content) === '\r\n' ? '\r\n' : '\n', false)
    }
    if (opts.maxChars !== undefined && content.length > opts.maxChars) {
      content = content.slice(0, opts.maxChars)
      truncated = true
      this.truncated.add(r.rel)
    } else {
      this.truncated.delete(r.rel)
    }

    // 哈希始终对全文
    const full = readFileSync(r.full, 'utf8')
    this.hashes.set(r.rel, contentHash(full))
    this.seq++
    this.log.push({ seq: this.seq, tool: 'read_file', path: r.rel })
    return { ok: true, path: r.rel, content, hash: this.hashes.get(r.rel), truncated, warnings }
  }

  edit(
    path: string,
    edits: EditRequest[],
  ): EditResult & { path?: string; requiresConfirmation?: boolean } {
    const r = resolveInWorkspace(this.root, path, 'write')
    if (!r.ok) {
      return {
        ok: false,
        reason: 'DENIED',
        failedAt: 0,
        matchCount: 0,
        matchLines: [],
        old: edits[0]?.old ?? '',
        warnings: [],
        message: r.message,
      }
    }
    if (r.requiresConfirmation) {
      // 仍允许在显式确认后写入；这里只标记。调用方看这个字段。
    }
    if (!this.hashes.has(r.rel)) {
      return {
        ok: false,
        reason: 'READ_REQUIRED',
        failedAt: 0,
        matchCount: 0,
        matchLines: [],
        old: edits[0]?.old ?? '',
        warnings: [],
        message: 'READ_REQUIRED：编辑前必须先 read。',
      }
    }
    if (this.truncated.has(r.rel)) {
      return {
        ok: false,
        reason: 'TRUNCATED_READ',
        failedAt: 0,
        matchCount: 0,
        matchLines: [],
        old: edits[0]?.old ?? '',
        warnings: [],
        message: 'TRUNCATED_READ：读取被截断，不得基于残缺内容编辑。',
      }
    }
    if (!existsSync(r.full)) {
      return {
        ok: false,
        reason: 'FILE_NOT_FOUND',
        failedAt: 0,
        matchCount: 0,
        matchLines: [],
        old: edits[0]?.old ?? '',
        warnings: [],
        message: `FILE_NOT_FOUND：${r.rel}`,
      }
    }
    const current = readFileSync(r.full, 'utf8')
    const h = contentHash(current)
    if (h !== this.hashes.get(r.rel)) {
      return {
        ok: false,
        reason: 'STALE_READ',
        failedAt: 0,
        matchCount: 0,
        matchLines: [],
        old: edits[0]?.old ?? '',
        warnings: [],
        message: `STALE_READ：${r.rel} 自上次 read 以来已被改动。`,
      }
    }

    const result = applyEdits(current, edits, r.rel)
    if (!result.ok) return { ...result, path: r.rel, requiresConfirmation: r.requiresConfirmation }

    this.ensureSnapshot(r.rel, current)
    atomicWrite(r.full, result.newContent)
    this.hashes.set(r.rel, contentHash(result.newContent))
    this.seq++
    this.log.push({ seq: this.seq, tool: 'edit_file', path: r.rel })
    return { ...result, path: r.rel, requiresConfirmation: r.requiresConfirmation }
  }

  create(path: string, content: string): { ok: boolean; message?: string } {
    const r = resolveInWorkspace(this.root, path, 'write')
    if (!r.ok) return { ok: false, message: r.message }
    if (existsSync(r.full)) return { ok: false, message: `已存在：${r.rel}` }
    this.ensureSnapshot(r.rel, null)
    mkdirSync(dirname(r.full), { recursive: true })
    atomicWrite(r.full, content)
    this.hashes.set(r.rel, contentHash(content))
    this.seq++
    this.log.push({ seq: this.seq, tool: 'create_file', path: r.rel })
    return { ok: true }
  }

  /** 非只读命令之后调用，使全部哈希失效（STALE-6）。 */
  invalidateAfterCommand(readonly: boolean): void {
    if (!readonly) this.hashes.clear()
  }

  rollbackAll(): void {
    for (const [rel, entry] of this.snapshot) {
      const full = join(this.root, rel)
      if (entry.kind === 'absent') {
        if (existsSync(full)) unlinkSync(full)
      } else {
        mkdirSync(dirname(full), { recursive: true })
        atomicWrite(full, entry.bytes)
      }
    }
    this.snapshot.clear()
    this.hashes.clear()
  }

  private ensureSnapshot(rel: string, current: string | null): void {
    if (this.snapshot.has(rel)) return
    if (current === null) this.snapshot.set(rel, { kind: 'absent' })
    else this.snapshot.set(rel, { kind: 'file', bytes: current })
  }
}

/** 临时文件 + rename。Windows 上用 rename 覆盖已存在目标。 */
export function atomicWrite(full: string, content: string): void {
  const tmp = full + `.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, full)
}

export const READONLY_COMMANDS = new Set([
  'git status',
  'git diff',
  'git log',
  'git show',
  'ls',
  'pwd',
])

export function isReadonlyCommand(name: string, args: string[]): boolean {
  const line = [name, ...args].join(' ')
  for (const r of READONLY_COMMANDS) {
    if (line === r || line.startsWith(r + ' ')) return true
  }
  return false
}
