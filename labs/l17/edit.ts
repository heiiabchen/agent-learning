/**
 * L17 的脚手架。跑法：pnpm coding
 *
 * 分两半：
 *   上半是观察实验——直接跑 shared/coding 的参考实现，让你先看见现象。
 *   下半是 TODO，你来实现同名函数。写完跑 pnpm verify:l17。
 *
 * ★★ 这一节的坑几乎全是静默的：编辑「成功」了，但改错了地方、改坏了缩进、
 * 混合了行尾、exit code 仍是 0。所以观察实验的工作是把「看起来像成功」
 * 变成一张能对上看的表。
 *
 * 全程一次模型都不调。能用假输入测的，就不要用真模型测。
 */

import {
  applyEdits,
  canStop,
  detectEol,
  isGreen,
  parseTestOutput,
  resolveInWorkspace,
  splitLines,
  type EditRequest,
  type MatchTier,
  type StopState,
  type Baseline,
  validatePlan,
} from '../shared/coding.ts'
import { isMain } from '../shared/entry.ts'
import { mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const w = (s: string) =>
  [...visible(s)].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - w(s)))

// ═════════════════════════════════════════════════════════════
// 上半：观察实验
// ═════════════════════════════════════════════════════════════

const CACHE_FILE = `class Cache:
    def get(self, key):
        if key not in self._data:
            return None
        return self._data[key]

    def peek(self, key):
        if key not in self._data:
            return None
        return self._data[key]
`

/**
 * 实验一：同一个编辑意图，不同表示法，哪些会静默改坏文件。
 *
 * 意图：把 get 里的 return None 改成 raise KeyError(key)。
 * peek 里有一模一样的三行——这是真实代码里最常见的陷阱。
 */
function exp1(): void {
  console.log(bold('\n实验一：同一个编辑意图，哪些表示法会静默改坏文件'))
  console.log(dim('  意图：只改 get() 里的 return None → raise KeyError(key)\n'))

  const shared = `        if key not in self._data:
            return None`
  const unique = `    def get(self, key):
        if key not in self._data:
            return None
        return self._data[key]`

  type Row = { name: string; result: string; correct: string; signal: string }
  const rows: Row[] = []

  // 1. 首命中（aider diff 语义的模拟）
  const firstHit = CACHE_FILE.replace(shared, `        if key not in self._data:
            raise KeyError(key)`)
  const firstOk = firstHit.includes('def get') && firstHit.indexOf('raise KeyError') < firstHit.indexOf('def peek')
  const peekUntouched = firstHit.includes('def peek') && firstHit.split('return None').length === 2
  rows.push({
    name: 'search/replace 首命中',
    result: '写入成功',
    correct: firstOk && peekUntouched ? '碰巧对' : '错（或碰巧对）',
    signal: '无',
  })
  // 首命中意图改 peek → 仍改 get
  rows.push({
    name: '同上，意图其实是改 peek',
    result: '写入成功',
    correct: '错',
    signal: '无',
  })

  // 2. 唯一性检查（本节规范）
  const r = applyEdits(CACHE_FILE, [{ old: shared, new: `        if key not in self._data:
            raise KeyError(key)` }])
  rows.push({
    name: 'str_replace + 唯一性',
    result: r.ok ? '成功' : `${r.reason} ×${r.matchCount}`,
    correct: '——',
    signal: r.ok ? '有' : green('有'),
  })

  const r2 = applyEdits(CACHE_FILE, [
    {
      old: unique,
      new: `    def get(self, key):
        if key not in self._data:
            raise KeyError(key)
        return self._data[key]`,
    },
  ])
  rows.push({
    name: '唯一性（扩大上下文）',
    result: r2.ok ? `成功 tier=${r2.applied[0]?.tier}` : r2.reason,
    correct: r2.ok ? green('对') : '错',
    signal: '有',
  })

  // 3. 行号差一（静默改错）
  const lines = CACHE_FILE.split('\n')
  // get 的 return None 大约在 index 3；差一改到下一行
  const wrong = [...lines]
  wrong[4] = '            raise KeyError(key)' // 原是 return self._data[key] 的位置附近——演示用
  rows.push({
    name: '行号编辑（差一）',
    result: '写入成功',
    correct: red('错'),
    signal: red('无'),
  })

  console.log(
    `  ${pad('表示法', 28)}${pad('结果', 22)}${pad('改对了吗', 14)}有信号吗`,
  )
  console.log('  ' + '─'.repeat(70))
  for (const row of rows) {
    console.log(
      `  ${pad(row.name, 28)}${pad(row.result, 22)}${pad(row.correct, 14)}${row.signal}`,
    )
  }
  console.log(
    dim(
      '\n  「有信号」的只有唯一性那两行。正确循环：先 NOT_UNIQUE → 扩大上下文 → 成功。',
    ),
  )
}

/**
 * 实验二：在每个偏移切断 pytest 输出，看解析器何时变绿。
 *
 * ★ isGreen===true 的偏移必须是一个后缀区间——一旦变绿就不能再变回来，
 * 且不得在完整 summary 出现之前变绿。
 */
function exp2(): void {
  console.log(bold('\n实验二：切断测试输出，看解析器何时报告 isGreen'))
  const full =
    'tests/test_cache.py::test_get PASSED\n' +
    'tests/test_cache.py::test_peek PASSED\n' +
    'tests/test_cache.py::test_miss PASSED\n' +
    '\n' +
    '===== 3 passed, 1 skipped in 0.12s =====\n'
  const bytes = Buffer.from(full, 'utf8')

  let firstGreen = -1
  let lastUngreen = -1
  let falseGreen = 0
  for (let i = 0; i <= bytes.length; i++) {
    const slice = bytes.subarray(0, i).toString('utf8')
    const v = parseTestOutput(slice, 0)
    const g = isGreen(v)
    if (g && firstGreen < 0) firstGreen = i
    if (!g) lastUngreen = i
    // 若在完整 summary 之前变绿，算假绿
    if (g && !slice.includes('===== 3 passed, 1 skipped in 0.12s =====')) falseGreen++
  }

  console.log(dim(`  完整输出 ${bytes.length} 字节。\n`))
  console.log(`  首次 isGreen：偏移 ${firstGreen}`)
  console.log(`  最后一次非绿：偏移 ${lastUngreen}`)
  console.log(
    `  完整 summary 之前的假绿次数：${falseGreen === 0 ? green('0') : red(String(falseGreen))}`,
  )
  const suffixOk = firstGreen > lastUngreen || (firstGreen >= 0 && lastUngreen + 1 === firstGreen)
  console.log(
    `  绿区是后缀区间：${suffixOk ? green('是') : red('否')}`,
  )
  console.log(
    dim('  危险区间是 summary 行只出现了一部分的那几十个字节——naive 正则会在这里假绿。'),
  )
}

/**
 * 实验三：同一个路径，层层检查，哪些放行了。
 */
function exp3(): void {
  console.log(bold('\n实验三：同一个路径字符串，各层检查放行了什么'))
  // ★ 固定路径，保证和 Python 侧输出逐字节一致
  const root = '/tmp/l17-sbx-demo'
  const evilSibling = root + '-evil'
  rmSync(root, { recursive: true, force: true })
  rmSync(evilSibling, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  mkdirSync(evilSibling, { recursive: true })
  writeFileSync(join(evilSibling, 'x'), 'nope')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'main.ts'), 'ok')
  try {
    symlinkSync('/etc', join(root, 'link'))
  } catch {
    // 某些环境不许
  }

  type Layer = (path: string) => 'ALLOW' | 'DENY'
  const startsWith: Layer = (p) => {
    // ★ 故意不用 path.join——它会消掉 `..`，掩盖「只看前缀」的漏洞。
    const full = root + '/' + p
    return full.startsWith(root) ? 'ALLOW' : 'DENY'
  }
  const normalizeStartsWith: Layer = (p) => {
    // 错误地用 startsWith 而不加分隔符——这就是 SBX-4 那一格
    const full = resolve(root, p)
    return full.startsWith(root) ? 'ALLOW' : 'DENY'
  }
  const withSep: Layer = (p) => {
    const full = resolve(root, p)
    const rootSep = root.endsWith(sep) ? root : root + sep
    return full === root || full.startsWith(rootSep) ? 'ALLOW' : 'DENY'
  }
  const ours: Layer = (p) => (resolveInWorkspace(root, p, 'read').ok ? 'ALLOW' : 'DENY')

  // 构造一个解析到 sibling-evil 的相对路径
  const toEvil = '../' + (root.split(/[/\\]/).pop() + '-evil') + '/x'

  const cases: [string, string][] = [
    ['src/main.ts', '正常'],
    ['../etc/passwd', '跳出'],
    ['a/../../etc/passwd', '中间跳出'],
    [toEvil, 'ws-evil 前缀'],
    ['link/passwd', 'symlink→/etc'],
    ['./.git/config', 'deny .git'],
    ['a\0b', 'NUL'],
  ]

  console.log(
    `  ${pad('路径', 28)}${pad('startsWith', 12)}${pad('norm+starts', 12)}${pad('norm+SEP', 10)}本节`,
  )
  console.log('  ' + '─'.repeat(72))
  for (const [p, _note] of cases) {
    const a = startsWith(p)
    const b = normalizeStartsWith(p)
    const c = withSep(p)
    const d = p.includes('\0') ? 'DENY' : ours(p)
    const mark = (x: string, good: string) => (x === good ? x : red(x + ' ✗'))
    // 期望：只有 src/main.ts 是 ALLOW
    const want = p === 'src/main.ts' ? 'ALLOW' : 'DENY'
    console.log(
      `  ${pad(p.replace(/\0/g, '\\0').slice(0, 26), 28)}` +
        `${pad(mark(a, want), 12)}` +
        `${pad(mark(b, want), 12)}` +
        `${pad(mark(c, want), 10)}` +
        mark(d, want),
    )
  }
  console.log(dim('\n  注意 ws-evil 那一行：startsWith(root) 会放行，加分隔符或 relative 才挡住。'))

  rmSync(root, { recursive: true, force: true })
  rmSync(evilSibling, { recursive: true, force: true })
}

/**
 * 实验四：CRLF 文件被编辑一次之后，行尾还在不在。
 */
function exp4(): void {
  console.log(bold('\n实验四：CRLF 文件编辑一行之后，行尾分布'))
  const src = 'line1\r\nline2\r\nline3\r\nline4\r\nline5\r\n'

  const naive = src.split('\n').map((l, i) => (i === 1 ? 'LINE2' : l)).join('\n')
  const ours = applyEdits(src, [{ old: 'line2\n', new: 'LINE2\n' }])
  const normalized = src.replace(/\r\n/g, '\n').replace(/^line2$/m, 'LINE2')

  const count = (s: string) => {
    const crlf = (s.match(/\r\n/g) ?? []).length
    const lf = (s.replace(/\r\n/g, '').match(/\n/g) ?? []).length
    return `${crlf}×CRLF + ${lf}×LF`
  }
  const diffLines = (s: string) => {
    // 和 src 比，有多少行内容变了（粗算）
    const a = src.replace(/\r\n/g, '\n').split('\n')
    const b = s.replace(/\r\n/g, '\n').split('\n')
    let n = 0
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) n++
    return n
  }

  console.log(`  ${pad('实现', 32)}${pad('行尾分布', 22)}内容改动行数`)
  console.log('  ' + '─'.repeat(60))
  console.log(`  ${pad('naive split/join on \\n', 32)}${pad(count(naive), 22)}${diffLines(naive)}`)
  console.log(
    `  ${pad('本节规范（探测+恢复）', 32)}${pad(ours.ok ? count(ours.newContent) : 'FAIL', 22)}${ours.ok ? diffLines(ours.newContent) : '-'}`,
  )
  console.log(`  ${pad('naive normalize to LF', 32)}${pad(count(normalized), 22)}${diffLines(normalized)}`)
  console.log(
    dim('\n  第一行「1 行改动但文件已混合」最阴——git diff 看起来干净，问题稍后才爆。'),
  )
  void detectEol
  void splitLines
}

/**
 * 实验五：终止谓词——绿过一次不够。
 */
function exp5(): void {
  console.log(bold('\n实验五：verify 绿过一次，但最后又 edit 了一次'))
  const baseline: Baseline = { collected: 3, skipped: 0, testFileHashes: {} }
  const verify = {
    runner: 'pytest',
    passed: 3,
    failed: 0,
    skipped: 0,
    collected: 3,
    confidence: 'exact' as const,
    exitCode: 0,
  }
  const cases: [string, StopState][] = [
    [
      'edit→verify→finish',
      {
        finished: true,
        gaveUp: false,
        lastEditSeq: 1,
        lastVerifySeq: 2,
        verify,
        unplannedFiles: [],
        revisedForUnplanned: false,
        currentTestFileHashes: {},
      },
    ],
    [
      'edit→verify→edit→finish',
      {
        finished: true,
        gaveUp: false,
        lastEditSeq: 3,
        lastVerifySeq: 2,
        verify,
        unplannedFiles: [],
        revisedForUnplanned: false,
        currentTestFileHashes: {},
      },
    ],
    [
      '从未 verify',
      {
        finished: true,
        gaveUp: false,
        lastEditSeq: 1,
        lastVerifySeq: -1,
        verify: null,
        unplannedFiles: [],
        revisedForUnplanned: false,
        currentTestFileHashes: {},
      },
    ],
  ]
  console.log(`  ${pad('日志', 32)}canStop  原因`)
  console.log('  ' + '─'.repeat(60))
  for (const [name, st] of cases) {
    const d = canStop(st, baseline)
    console.log(
      `  ${pad(name, 32)}${pad(d.canStop ? green('true') : yellow('false'), 8)}${d.reasons[0] ?? ''}`,
    )
  }
  console.log(dim('\n  中间那一行是本节最重要的终止条件：verify 必须在最后一次 edit 之后。'))
  void validatePlan
  void applyEdits
}

function observe(): void {
  console.log(bold('L17 · 观察实验（参考实现）'))
  console.log(dim('跑完这些再去写 TODO。每一张表都对应一条反转。'))
  exp1()
  exp2()
  exp3()
  exp4()
  exp5()
}

// ═════════════════════════════════════════════════════════════
// 下半：TODO
// ═════════════════════════════════════════════════════════════

/**
 * TODO 1：行切分。只认 \\r\\n / \\n / \\r。
 * ★ 不要用 String.prototype.split('\\n')，更不要在 Python 侧用 splitlines()。
 */
export function mySplitLines(_s: string): string[] {
  throw new Error('TODO 1 未实现')
}

/**
 * TODO 2：applyEdits。多处匹配必须 NOT_UNIQUE（不是改第一处）。
 * 批量全有或全无；定位基于原文件。
 */
export function myApplyEdits(
  _content: string,
  _edits: EditRequest[],
  _path = '',
): ReturnType<typeof applyEdits> {
  throw new Error('TODO 2 未实现')
}

/**
 * TODO 3：validatePlan。计划是 DAG，必须有 verify 步，edit 前必须有 read。
 */
export function myValidatePlan(_plan: Parameters<typeof validatePlan>[0]): ReturnType<typeof validatePlan> {
  throw new Error('TODO 3 未实现')
}

/**
 * TODO 4：parseTestOutput + isGreen。反向扫描 summary；截断 → unparsed；fail-closed。
 * ★ 先用 splitLines 切行再逐行匹配，正则不带 m 标志，空白只写 [ \t]（PARSE-8/9/10）。
 */
export function myParseTestOutput(
  _raw: string,
  _exitCode: number,
  _runnerHint = '',
): ReturnType<typeof parseTestOutput> {
  throw new Error('TODO 4 未实现')
}

/**
 * TODO 5：canStop。verify 必须在最后一次 edit 之后；比 baseline；测试文件哈希未变。
 */
export function myCanStop(
  _state: StopState,
  _baseline: Baseline,
): ReturnType<typeof canStop> {
  throw new Error('TODO 5 未实现')
}

/**
 * TODO 6：resolveInWorkspace。不得用 startsWith(root)；deny 在规范化之后。
 * ★ 目标还不存在时也要解析符号链接（SBX-8）；环 → SYMLINK_LOOP（SBX-9）；
 *   deny 大小写不敏感（SBX-14），并且对解析后的路径再查一遍（SBX-15）。
 *   shared/sandbox 的 safePath 已经做了前两件，读它的 code 和 realRel。
 */
export function myResolveInWorkspace(
  _root: string,
  _input: string,
  _op: 'read' | 'write',
): ReturnType<typeof resolveInWorkspace> {
  throw new Error('TODO 6 未实现')
}

// 避免未使用告警（观察实验用到的类型）
export type { MatchTier }

if (isMain(import.meta.url)) {
  observe()
  console.log(
    dim(
      '\n  下一步：实现文件下半部分的六个 TODO，然后跑 pnpm verify:l17（或 uv run python -m l17.verify）。',
    ) +
      dim('\n  想先确认测试本身是对的，跑 CODING_IMPL=shared 下的 verify。') +
      dim('\n  观察实验：pnpm coding / uv run python -m l17.edit\n'),
  )
}
