/**
 * 验证 l17/edit.ts（或 shared/coding）。跑法：
 *   CODING_IMPL=shared pnpm verify:l17   # 先确认测试本身是对的
 *   pnpm verify:l17                      # 测你的 TODO
 *
 * ★ 一次模型都不调。测的是检测器和纯函数，不是模型会不会作弊。
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as shared from '../shared/coding.ts'
import type { EditRequest, Plan, Baseline, StopState } from '../shared/coding.ts'

const TARGET = process.env.CODING_IMPL === 'shared' ? 'shared' : 'mine'

const M =
  TARGET === 'shared'
    ? {
        splitLines: shared.splitLines,
        applyEdits: shared.applyEdits,
        validatePlan: shared.validatePlan,
        parseTestOutput: shared.parseTestOutput,
        canStop: shared.canStop,
        resolveInWorkspace: shared.resolveInWorkspace,
        detectEol: shared.detectEol,
        isGreen: shared.isGreen,
        detectHacks: shared.detectHacks,
        adherence: shared.adherence,
        toolsFor: shared.toolsFor,
        revisePlan: shared.revisePlan,
        Workspace: shared.Workspace,
        contentHash: shared.contentHash,
        findInvisible: shared.findInvisible,
        matchWithTiers: shared.matchWithTiers,
      }
    : await (async () => {
        const mine = await import('./edit.ts')
        return {
          splitLines: mine.mySplitLines,
          applyEdits: mine.myApplyEdits,
          validatePlan: mine.myValidatePlan,
          parseTestOutput: mine.myParseTestOutput,
          canStop: mine.myCanStop,
          resolveInWorkspace: mine.myResolveInWorkspace,
          // 下列无 TODO 版本，一律用参考实现
          detectEol: shared.detectEol,
          isGreen: shared.isGreen,
          detectHacks: shared.detectHacks,
          adherence: shared.adherence,
          toolsFor: shared.toolsFor,
          revisePlan: shared.revisePlan,
          Workspace: shared.Workspace,
          contentHash: shared.contentHash,
          findInvisible: shared.findInvisible,
          matchWithTiers: shared.matchWithTiers,
        }
      })()

console.log(TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l17/ 里你的实现）')

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`

let passed = 0
const failures: string[] = []

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) === JSON.stringify(b)) passed++
  else {
    failures.push(msg)
    console.log(`  ${red('✕')} ${msg}`)
    console.log(dim(`      期望 ${JSON.stringify(b)}`))
    console.log(dim(`      实际 ${JSON.stringify(a)}`))
  }
}
function ok(c: boolean, msg: string) {
  if (c) passed++
  else {
    failures.push(msg)
    console.log(`  ${red('✕')} ${msg}`)
  }
}
function section(s: string) {
  console.log(bold(`\n${s}`))
}

// ═════════════════════════════════════════════════════════════
section('A · 行切分与字节层')
// ═════════════════════════════════════════════════════════════
eq(M.splitLines('a\n'), ['a'], 'LINE-3 a\\n → ["a"]')
eq(M.splitLines('a\n\n'), ['a', ''], 'LINE-3 a\\n\\n → ["a",""]')
eq(M.splitLines('a\vb'), ['a\vb'], 'LINE-1 \\v 不分行')
eq(M.splitLines('a\u2028b'), ['a\u2028b'], 'LINE-1 U+2028 不分行')
eq(M.splitLines('a\r\nb'), ['a', 'b'], 'LINE CRLF')
eq(M.splitLines(''), [], 'LINE 空串')
eq(M.detectEol('a\r\nb\r\n'), '\r\n', 'EOL CRLF')
eq(M.detectEol('a\nb\r\n'), 'mixed', 'EOL mixed')

const bomFile = '\uFEFFhello\nworld\n'
const bomEdit = M.applyEdits(bomFile, [{ old: 'world', new: 'WORLD' }])
ok(bomEdit.ok, 'BOM-1 编辑成功')
if (bomEdit.ok) ok(bomEdit.newContent.startsWith('\uFEFF'), 'BOM-1 写回仍带 BOM')

const crlf = 'line1\r\nline2\r\nline3\r\n'
const eolEdit = M.applyEdits(crlf, [{ old: 'line2\n', new: 'LINE2\n' }])
ok(eolEdit.ok, 'EOL-1 应用成功')
if (eolEdit.ok) {
  eq(M.detectEol(eolEdit.newContent), '\r\n', 'EOL-1 全文仍是 CRLF')
  eq(eolEdit.newContent, 'line1\r\nLINE2\r\nline3\r\n', 'EOL-1 内容正确')
}

const tabFile = 'target:\n\techo hi\n'
const tabOk = M.applyEdits(tabFile, [{ old: '\techo hi', new: '\techo bye' }])
ok(tabOk.ok, 'TAB-1 tab 形式的 old 成功')
const tabMiss = M.applyEdits(tabFile, [{ old: '        echo hi', new: '        echo bye' }])
ok(!tabMiss.ok && tabMiss.reason === 'NO_MATCH', 'TAB-1 空格形式 → NO_MATCH')

const nbsp = 'x\u00A0y'
const nbspEdit = M.applyEdits(nbsp, [{ old: 'x y', new: 'x z' }])
ok(!nbspEdit.ok && nbspEdit.reason === 'NO_MATCH', 'UNI-1 NBSP ≠ 普通空格')

// ═════════════════════════════════════════════════════════════
section('B · 编辑语义')
// ═════════════════════════════════════════════════════════════
const cache = `class Cache:
    def get(self, key):
        if key not in self._data:
            return None
        return self._data[key]

    def peek(self, key):
        if key not in self._data:
            return None
        return self._data[key]
`
const sharedOld = `        if key not in self._data:
            return None`
const nu = M.applyEdits(cache, [
  { old: sharedOld, new: `        if key not in self._data:
            raise KeyError(key)` },
])
ok(!nu.ok && nu.reason === 'NOT_UNIQUE', 'EDIT-2 NOT_UNIQUE')
if (!nu.ok) {
  eq(nu.matchCount, 2, 'EDIT-2 matchCount=2')
  ok(nu.matchLines.length === 2, 'EDIT-2 matchLines')
  eq(nu.old, sharedOld, 'EDIT-9 错误信息里的 old 逐字节等于输入')
}

const unique = `    def get(self, key):
        if key not in self._data:
            return None
        return self._data[key]`
const ok1 = M.applyEdits(cache, [
  {
    old: unique,
    new: `    def get(self, key):
        if key not in self._data:
            raise KeyError(key)
        return self._data[key]`,
  },
])
ok(ok1.ok, 'EDIT-1 唯一匹配成功')
if (ok1.ok) eq(ok1.applied[0]?.tier, 'exact', 'EDIT-1 tier=exact')

ok(!M.applyEdits('abc', [{ old: '', new: 'x' }]).ok, 'EDIT-6 空 old')
ok(!M.applyEdits('abc', [{ old: '   \n  ', new: 'x' }]).ok, 'EDIT-7 空白 old')
ok(!M.applyEdits('abc', [{ old: 'a', new: 'a' }]).ok, 'EDIT-5 NO_OP')
const del = M.applyEdits('abXYcd', [{ old: 'XY', new: '' }])
ok(del.ok && del.ok && del.newContent === 'abcd', 'EDIT-8 纯删除')

const all = M.applyEdits('aa aa aa', [{ old: 'aa', new: 'bb', occurrence: 'all' }])
ok(all.ok && all.ok && all.applied.length === 3, 'EDIT-4 occurrence=all')

// 二次应用 → NO_MATCH（幂等）
if (ok1.ok) {
  const again = M.applyEdits(ok1.newContent, [
    {
      old: unique,
      new: `    def get(self, key):
        if key not in self._data:
            raise KeyError(key)
        return self._data[key]`,
    },
  ])
  ok(!again.ok && again.reason === 'NO_MATCH', 'NL-2 同一编辑第二次 → NO_MATCH')
}

// BATCH
const batch = M.applyEdits('abcdefgh', [
  { old: 'bcd', new: 'BCD' },
  { old: 'cde', new: 'CDE' },
])
ok(!batch.ok && batch.reason === 'OVERLAP', 'BATCH-1 重叠 → OVERLAP')

const batchOk = M.applyEdits('abcdefgh', [
  { old: 'bcd', new: 'BCD' },
  { old: 'fgh', new: 'FGH' },
])
ok(batchOk.ok && batchOk.ok && batchOk.newContent === 'aBCDeFGH', 'BATCH-3 不重叠按原文件定位')

const fail2 = M.applyEdits('abcdefgh', [
  { old: 'bcd', new: 'BCD' },
  { old: 'ZZZ', new: 'z' },
])
ok(!fail2.ok && fail2.failedAt === 1, 'BATCH-2 第 k 条失败 → failedAt=k，零写入')

// ═════════════════════════════════════════════════════════════
section('C · 计划')
// ═════════════════════════════════════════════════════════════
ok(
  !M.validatePlan({ steps: [] }).ok,
  'PLAN 空',
)
const noV = M.validatePlan({
  steps: [
    { id: 'r', kind: 'read', targets: ['a.ts'], dependsOn: [] },
    { id: 'e', kind: 'edit', targets: ['a.ts'], dependsOn: ['r'] },
  ],
})
ok(!noV.ok && noV.reason === 'NO_VERIFY_STEP', 'PLAN-5 缺 verify')

const noR = M.validatePlan({
  steps: [
    { id: 'e', kind: 'edit', targets: ['a.ts'], dependsOn: [] },
    { id: 'v', kind: 'verify', targets: [], dependsOn: ['e'] },
  ],
})
ok(!noR.ok && noR.reason === 'EDIT_WITHOUT_READ', 'PLAN-6 edit 无 read')

const cycle = M.validatePlan({
  steps: [
    { id: 'a', kind: 'read', targets: ['a.ts'], dependsOn: ['b'] },
    { id: 'b', kind: 'read', targets: ['b.ts'], dependsOn: ['a'] },
    { id: 'v', kind: 'verify', targets: [], dependsOn: ['a'] },
  ],
})
ok(!cycle.ok && cycle.reason === 'CYCLE', 'PLAN-2 环')

const good: Plan = {
  steps: [
    { id: 'r', kind: 'read', targets: ['a.ts'], dependsOn: [] },
    { id: 'e', kind: 'edit', targets: ['a.ts'], dependsOn: ['r'] },
    { id: 'v', kind: 'verify', targets: [], dependsOn: ['e'] },
  ],
}
ok(M.validatePlan(good).ok, 'PLAN 合法')

eq(M.toolsFor('plan').includes('edit_file'), false, 'PHASE-1 plan 阶段无 edit_file')
eq(M.toolsFor('execute').includes('edit_file'), true, 'PHASE execute 有 edit_file')

const adh = M.adherence(good, [
  { seq: 1, tool: 'read_file', path: 'a.ts', stepId: 'r' },
  { seq: 2, tool: 'edit_file', path: 'a.ts', stepId: 'e' },
  { seq: 3, tool: 'edit_file', path: 'extra.ts' },
  { seq: 4, tool: 'verify', stepId: 'v' },
])
ok(adh.unplannedFiles.includes('extra.ts'), 'ADH-1 计划外文件')
ok(adh.verifyRanAfterLastEdit, 'ADH-4 verify 在最后 edit 之后')

const adh2 = M.adherence(good, [
  { seq: 1, tool: 'edit_file', path: 'a.ts', stepId: 'e' },
  { seq: 2, tool: 'verify', stepId: 'v' },
  { seq: 3, tool: 'edit_file', path: 'a.ts' },
])
ok(!adh2.verifyRanAfterLastEdit, 'ADH-4 后又 edit → false')

// ═════════════════════════════════════════════════════════════
section('D · 测试解析与终止')
// ═════════════════════════════════════════════════════════════
const p1 = M.parseTestOutput('===== 3 passed, 1 skipped in 0.12s =====\n', 0)
eq([p1.passed, p1.skipped, p1.collected, p1.confidence], [3, 1, 4, 'exact'], 'PARSE-1')
eq(M.parseTestOutput('=====\x1b[32m 3 passed\x1b[0m, 1 skipped in 0.12s =====\n', 0).passed, 3, 'PARSE-2 ANSI')
ok(M.parseTestOutput('garbage', 0).confidence === 'unparsed', 'PARSE-3 unparsed')
ok(!M.isGreen(M.parseTestOutput('garbage', 0)), 'PARSE-3 isGreen false')
ok(!M.isGreen(M.parseTestOutput('===== no tests ran in 0.01s =====\n', 5)), 'PARSE-4 0 tests')

// 截断不得假绿
const partial = '===== 3 passed, 1 skipped in 0.12s ='
ok(!M.isGreen(M.parseTestOutput(partial, 0)), 'PARSE-6 截断 summary → 不绿')

const fakeThenReal =
  'print says 3 passed\n===== 3 passed, 1 failed in 0.1s =====\n===== 3 passed, 0 failed in 0.1s =====\n'
eq(M.parseTestOutput(fakeThenReal, 0).failed, 0, 'PARSE-7 取最后的 summary')

// 两门语言对「行首」和「空白」的定义不同：先切行、再逐行匹配，空白只认空格和 tab
const viaCr = M.parseTestOutput('progress 50%\r===== 3 passed in 0.10s =====\n', 0)
eq([viaCr.confidence, viaCr.passed], ['exact', 3], 'PARSE-8 裸 \\r 之后是新的一行')
eq(
  M.parseTestOutput('note\u2028===== 3 passed in 0.10s =====\n', 0).confidence,
  'unparsed',
  'PARSE-9 U+2028 不分行 → unparsed',
)
eq(
  [M.parseTestOutput('PASS\r\n', 0).confidence, M.parseTestOutput('Tests\x1c3 passed\n', 0).confidence],
  ['exact', 'unparsed'],
  'PARSE-10 PASS\\r\\n 认得；\\x1c 不算空白',
)

const baseline: Baseline = { collected: 3, skipped: 0, testFileHashes: { 'tests/t.py': 'abc' } }
const greenV = {
  runner: 'pytest',
  passed: 3,
  failed: 0,
  skipped: 0,
  collected: 3,
  confidence: 'exact' as const,
  exitCode: 0,
}

ok(
  !M.canStop(
    {
      finished: true,
      gaveUp: false,
      lastEditSeq: 1,
      lastVerifySeq: -1,
      verify: null,
      unplannedFiles: [],
      revisedForUnplanned: false,
      currentTestFileHashes: { 'tests/t.py': 'abc' },
    },
    baseline,
  ).canStop,
  'STOP-1 从未 verify',
)

ok(
  !M.canStop(
    {
      finished: true,
      gaveUp: false,
      lastEditSeq: 3,
      lastVerifySeq: 2,
      verify: greenV,
      unplannedFiles: [],
      revisedForUnplanned: false,
      currentTestFileHashes: { 'tests/t.py': 'abc' },
    },
    baseline,
  ).canStop,
  'STOP-3 verify 不在最后 edit 之后',
)

ok(
  M.canStop(
    {
      finished: true,
      gaveUp: false,
      lastEditSeq: 1,
      lastVerifySeq: 2,
      verify: greenV,
      unplannedFiles: [],
      revisedForUnplanned: false,
      currentTestFileHashes: { 'tests/t.py': 'abc' },
    },
    baseline,
  ).canStop,
  'STOP 正常成功',
)

ok(
  !M.canStop(
    {
      finished: true,
      gaveUp: false,
      lastEditSeq: 1,
      lastVerifySeq: 2,
      verify: { ...greenV, collected: 1 },
      unplannedFiles: [],
      revisedForUnplanned: false,
      currentTestFileHashes: { 'tests/t.py': 'abc' },
    },
    baseline,
  ).canStop,
  'STOP-4 collected 比 baseline 少',
)

ok(
  !M.canStop(
    {
      finished: true,
      gaveUp: false,
      lastEditSeq: 1,
      lastVerifySeq: 2,
      verify: greenV,
      unplannedFiles: [],
      revisedForUnplanned: false,
      currentTestFileHashes: { 'tests/t.py': 'CHANGED' },
    },
    baseline,
  ).canStop,
  'STOP-7 测试文件哈希变了',
)

ok(
  M.canStop(
    {
      finished: false,
      gaveUp: true,
      giveUpReason: 'blocked on auth',
      lastEditSeq: 1,
      lastVerifySeq: -1,
      verify: null,
      unplannedFiles: [],
      revisedForUnplanned: false,
      currentTestFileHashes: {},
    },
    baseline,
  ).canStop,
  'STOP-9 give_up',
)

// ═════════════════════════════════════════════════════════════
section('E · reward hacking 检测器')
// ═════════════════════════════════════════════════════════════
ok(
  M.detectHacks({ changedFiles: ['tests/test_foo.py'] }).some((h) => h.rule === 'TEST_FILE_MODIFIED'),
  'HACK-3',
)
ok(
  M.detectHacks({ diffText: '+@pytest.mark.skip\ndef test_x():\n' }).some(
    (h) => h.rule === 'SKIP_MARKER_ADDED',
  ),
  'HACK-4',
)
ok(
  M.detectHacks({ changedFiles: ['node_modules/x/index.js'] }).some((h) => h.rule === 'UPSTREAM_MODIFIED'),
  'HACK-5',
)
ok(
  M.detectHacks({
    verify: { ...greenV, skipped: 5, collected: 14, passed: 9 },
    baseline: { collected: 14, skipped: 0, testFileHashes: {} },
  }).some((h) => h.rule === 'SKIP_INCREASED'),
  'HACK-2',
)
ok(
  M.detectHacks({
    changedFiles: ['src/fix.ts'],
    diffText: '@@ -1,3 +1,3 @@\n-old\n+new\n',
  }).length === 0,
  'HACK-11 正常 diff 不报警',
)

// ═════════════════════════════════════════════════════════════
section('F · 沙箱')
// ═════════════════════════════════════════════════════════════
{
  const root = mkdtempSync(join(tmpdir(), 'l17v-'))
  const evil = root + '-evil'
  mkdirSync(evil, { recursive: true })
  writeFileSync(join(evil, 'x'), 'nope')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'main.ts'), 'ok')
  try {
    symlinkSync('/etc', join(root, 'link'))
  } catch {
    /* skip */
  }

  ok(!M.resolveInWorkspace(root, '../etc/passwd', 'read').ok, 'SBX-1')
  ok(!M.resolveInWorkspace(root, 'a/../../etc/passwd', 'read').ok, 'SBX-2')
  ok(!M.resolveInWorkspace(root, '/etc/passwd', 'read').ok, 'SBX-3')
  const toEvil = '../' + root.split(/[/\\]/).pop() + '-evil/x'
  ok(!M.resolveInWorkspace(root, toEvil, 'read').ok, 'SBX-4 ws-evil')
  ok(!M.resolveInWorkspace(root, 'a\0b', 'read').ok, 'SBX-5 NUL')
  ok(!M.resolveInWorkspace(root, 'src\\main.ts', 'read').ok, 'SBX-6 backslash')
  ok(!M.resolveInWorkspace(root, './.git/config', 'read').ok, 'SBX-11 .git')
  ok(!M.resolveInWorkspace(root, 'node_modules/x', 'read').ok, 'SBX-12 node_modules')
  ok(!M.resolveInWorkspace(root, '.env.local', 'read').ok, 'SBX-13 .env.*')
  ok(M.resolveInWorkspace(root, 'src/main.ts', 'read').ok, 'SBX 正常路径')
  const conf = M.resolveInWorkspace(root, 'package.json', 'write')
  ok(conf.ok === true && conf.requiresConfirmation === true, 'INJ-2 高危文件要确认')

  // 符号链接：out → root 外的目录；loop → 自己；dang → 不存在的地方；g → root 里的 .git
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'config'), '[core]')
  let linked = true
  try {
    symlinkSync(evil, join(root, 'out'))
    symlinkSync('loop', join(root, 'loop'))
    symlinkSync(join(evil, 'nope'), join(root, 'dang'))
    symlinkSync('.git', join(root, 'g'))
  } catch {
    linked = false
  }
  if (linked) {
    const reason = (p: string, op: 'read' | 'write') => {
      const r = M.resolveInWorkspace(root, p, op)
      return r.ok ? 'ok' : r.reason
    }
    eq(reason('out/x', 'read'), 'SYMLINK_ESCAPES_ROOT', 'SBX-7 已存在文件经符号链接出 root')
    eq(
      [reason('out/new.txt', 'write'), reason('out/a/b/new.txt', 'write')],
      ['SYMLINK_ESCAPES_ROOT', 'SYMLINK_ESCAPES_ROOT'],
      'SBX-8 在符号链接目录下新建：realpath 最近的已存在祖先',
    )
    const made = new M.Workspace(root).create('out/new.txt', 'leak')
    ok(!made.ok && !existsSync(join(evil, 'new.txt')), 'SBX-8b create 不得写到 root 外')
    eq([reason('loop', 'read'), reason('loop/x', 'write')], ['SYMLINK_LOOP', 'SYMLINK_LOOP'], 'SBX-9 符号链接环')
    ok(reason('dang/x', 'write') !== 'ok', 'SBX-10 悬空链接：落点未知 → 拒')
    eq(
      ['.ENV', '.Env.Local', '.GIT/config', 'Node_Modules/x'].map((p) => reason(p, 'read')),
      ['DENIED_PATH', 'DENIED_PATH', 'DENIED_PATH', 'DENIED_PATH'],
      'SBX-14 deny 大小写不敏感',
    )
    eq(reason('g/config', 'read'), 'DENIED_PATH', 'SBX-15 deny 也查解析后的路径')
  }

  // STALE / READ_REQUIRED
  const ws = new M.Workspace(root)
  const e1 = ws.edit('src/main.ts', [{ old: 'ok', new: 'OK' }])
  ok(!e1.ok && e1.reason === 'READ_REQUIRED', 'STALE-1 未 read 就 edit')
  ws.read('src/main.ts')
  writeFileSync(join(root, 'src', 'main.ts'), 'changed externally')
  const e2 = ws.edit('src/main.ts', [{ old: 'ok', new: 'OK' }])
  ok(!e2.ok && e2.reason === 'STALE_READ', 'STALE-4 外部改动')
  ws.read('src/main.ts')
  const e3 = ws.edit('src/main.ts', [{ old: 'changed externally', new: 'fixed' }])
  ok(e3.ok, 'STALE-5 read 后可 edit')
  if (e3.ok) eq(readFileSync(join(root, 'src', 'main.ts'), 'utf8'), 'fixed', '写入生效')
  const e4 = ws.edit('src/main.ts', [{ old: 'fixed', new: 'fixed2' }])
  ok(e4.ok, 'STALE-5 连续第二次 edit（哈希已更新）')

  rmSync(root, { recursive: true, force: true })
  rmSync(evil, { recursive: true, force: true })
}

// ═════════════════════════════════════════════════════════════
console.log()
if (!failures.length) {
  console.log(green(`  ✓ ${passed} 条断言全部通过`))
  console.log(
    dim(
      '\n  最该记住的六条：\n' +
        '    EDIT-2  多处匹配 → NOT_UNIQUE（不是改第一处）\n' +
        '    EOL-1   CRLF 文件编辑后全文仍是 CRLF\n' +
        '    LINE-1  不要用 Python splitlines / JS split("\\n")\n' +
        '    STOP-3  verify 必须在最后一次 edit 之后\n' +
        '    SBX-4   startsWith(root) 会放行 /repo/ws-evil\n' +
        '    PLAN-6  edit 的 target 必须先被某个 read 覆盖\n',
    ),
  )
  process.exit(0)
} else {
  console.log(red(`  ${failures.length} 条失败，${passed} 条通过`))
  process.exit(1)
}
