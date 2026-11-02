/**
 * 验证 l19x/ecosystem.ts。
 *   ECO19_IMPL=shared pnpm verify:l19x
 *   pnpm verify:l19x
 *
 * 零框架、零模型、零网络。框架行为来自 fixtures/ecosystem.json（锁定版本上的实测录制）。
 */

import * as shared from '../shared/tsecosystem.ts'
import type { LoggedResult, McpResult, Rebuilt, Step, ToolCall, UiToolPart } from '../shared/tsecosystem.ts'
import { SCENARIOS, failingSteps, firstStop, fx } from './ecosystem.ts'

const TARGET = process.env.ECO19_IMPL === 'shared' ? 'shared' : 'mine'

type Api = {
  courseStopReason: typeof shared.courseStopReason
  redactSecrets: typeof shared.redactSecrets
  courseToolError: typeof shared.courseToolError
  resumeOnce: typeof shared.resumeOnce
  mcpResultToText: typeof shared.mcpResultToText
  rebuildHistory: typeof shared.rebuildHistory
  difyPlan: typeof shared.difyPlan
}

async function loadMine(): Promise<Api> {
  const m = await import('./ecosystem.ts')
  return {
    courseStopReason: m.myCourseStopReason,
    redactSecrets: m.myRedactSecrets,
    courseToolError: m.myCourseToolError,
    resumeOnce: m.myResumeOnce,
    mcpResultToText: m.myMcpResultToText,
    rebuildHistory: m.myRebuildHistory,
    difyPlan: m.myDifyPlan,
  }
}

const M: Api =
  TARGET === 'shared'
    ? {
        courseStopReason: shared.courseStopReason,
        redactSecrets: shared.redactSecrets,
        courseToolError: shared.courseToolError,
        resumeOnce: shared.resumeOnce,
        mcpResultToText: shared.mcpResultToText,
        rebuildHistory: shared.rebuildHistory,
        difyPlan: shared.difyPlan,
      }
    : await loadMine()

console.log(TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l19x/ 里你的实现）')

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

class Fail extends Error {}
function need(cond: boolean, why: string): void {
  if (!cond) throw new Fail(why)
}

let passed = 0
let failed = 0
function t(id: string, name: string, fn: () => void): void {
  try {
    fn()
    passed++
  } catch (e) {
    failed++
    const why = e instanceof Fail ? e.message : `抛出了异常：${(e as Error).message}`
    console.log(red(`  ✗ ${id} ${name}`) + dim(`\n      ${why}`))
  }
}
function section(s: string): void {
  console.log(bold(`\n${s}`))
}

const J = (x: unknown) => JSON.stringify(x)
const F = fx()

const call = (name: string, args: ToolCall['args']): ToolCall => ({ name, args })
const step = (calls: ToolCall[], finishReason = 'tool-calls', approvalRequested?: boolean): Step =>
  approvalRequested === undefined ? { toolCalls: calls, finishReason } : { toolCalls: calls, finishReason, approvalRequested }
const R = (s: Step[], maxSteps = 10, maxRepeat = 3) => M.courseStopReason(s, { maxSteps, maxRepeat })

// ─────────────────────────────────────────────────────────────
section('S · 停止原因（TODO 1）')

t('S1', '没有步 → running；最后一步没有工具调用 → done', () => {
  need(R([]) === 'running', `空历史：${R([])}`)
  need(R([step([], 'stop')]) === 'done', `没有工具调用：${R([step([], 'stop')])}`)
  need(R([step([call('ls', {})])]) === 'running', `一步、有工具调用、没到上限：${R([step([call('ls', {})])])}`)
})
t('S2', '优先级：approval > truncated > error > done', () => {
  const got = [
    R([step([], 'length', true)]),
    R([step([], 'length')]),
    R([step([], 'error')]),
    R([step([call('ls', {})], 'error')]),
    R([step([call('ls', {})], 'tool-calls', false)]),
  ]
  need(J(got) === J(['approval', 'truncated', 'error', 'error', 'running']), J(got))
})
t('S3', 'repeat：最近 maxRepeat 步签名全相同；参数键序不同也是同一个调用', () => {
  const ab = call('read_file', { a: 1, b: 2 })
  const ba = call('read_file', { b: 2, a: 1 })
  const ac = call('read_file', { a: 1, c: 2 })
  const got = [R([step([ab]), step([ba]), step([ab])]), R([step([ab]), step([ba])]), R([step([ab]), step([ac]), step([ab])])]
  need(J(got) === J(['repeat', 'running', 'running']), J(got))
})
t('S4', '只看最近 N 步；一步里调用的顺序算数；maxRepeat < 2 不查', () => {
  const x = call('ls', { p: '.' })
  const y = call('ls', { p: 'src' })
  const got = [
    R([step([x]), step([x]), step([x]), step([y])]),
    R([step([y]), step([x]), step([x]), step([x])]),
    R([step([x, y]), step([x, y])], 10, 2),
    R([step([x, y]), step([y, x])], 10, 2),
    R([step([x])], 10, 1),
    R([step([x]), step([x])], 10, 0),
  ]
  need(J(got) === J(['running', 'repeat', 'repeat', 'running', 'running', 'running']), J(got))
})
t('S5', 'max_steps 用 ≥：maxSteps 0 也停；repeat 先于 max_steps', () => {
  const got = [
    R(failingSteps(1), 0, 0),
    R(failingSteps(1, true), 1),
    R(failingSteps(3, true), 5),
    R(failingSteps(6, true), 5),
    R(failingSteps(3), 3, 3),
  ]
  need(J(got) === J(['max_steps', 'max_steps', 'running', 'max_steps', 'repeat']), J(got))
})
t('S6', '同一段 20 步历史：第 3 步 repeat；每步换参数：第 8 步 max_steps', () => {
  const same = firstStop(failingSteps(20), (s) => R(s, 8, 3))
  const vary = firstStop(failingSteps(20, true), (s) => R(s, 8, 3))
  need(J(same) === J([3, 'repeat']) && J(vary) === J([8, 'max_steps']), `${J(same)} ${J(vary)}`)
})

// ─────────────────────────────────────────────────────────────
section('E · 错误出口（TODO 2）')

const HINT = (code: string) => shared.hintFor(code)

t('E1', 'redactSecrets：三种 key 各自替换', () => {
  const got = [
    'key sk-abc_DEF-123 end',
    'token=abc123 rejected',
    'Authorization: Bearer eyJ.a-b_c~d+e/f=',
    'password=hunter2,next',
    'api_key=XYZ',
    'a sk-1 b sk-2 secret=x token=y Bearer p Bearer q',
  ].map(M.redactSecrets)
  need(
    J(got) ===
      J(['key sk-*** end', 'token=*** rejected', 'Authorization: Bearer ***', 'password=***,next', 'api_key=***', 'a sk-*** b sk-*** secret=*** token=*** Bearer *** Bearer ***']),
    J(got),
  )
})
t('E2', 'sk- 前面紧挨字母数字的不算；键名只认小写；值在分隔符前截止', () => {
  const got = ['task-queue sk-1', 'Token=abc', '(secret=sk-123)', 'token=abc;next', 'secret=a}b', 'xsk-abc sk-'].map(M.redactSecrets)
  need(J(got) === J(['task-queue sk-***', 'Token=abc', '(secret=***)', 'token=***;next', 'secret=***}b', 'xsk-abc sk-']), J(got))
})
t('E3', '幂等：脱敏结果再跑一遍不变', () => {
  const xs = ['sk-a', 'Bearer abc.def', 'secret=x token=y', '(secret=sk-123)', 'api_key=sk-zz,Bearer q']
  const once = xs.map(M.redactSecrets)
  const twice = once.map(M.redactSecrets)
  need(J(once) !== J(xs), '一个都没有替换')
  need(J(twice) === J(once), `${J(once)} → ${J(twice)}`)
})
t('E4', '格式：[tool error] 工具名: 消息，换行，下一步：提示', () => {
  const e = F.toolError
  const got = M.courseToolError({ name: e.name, message: e.message, code: e.code }, { tool: e.tool })
  const want = `[tool error] read_file: ENOENT nope (secret=***)\n下一步：${HINT('ENOENT')}`
  need(got === want, J(got))
  const a = shared.auditBackfill(got, e.tool)
  need(a.length === 0, `体检没过：${J(a)}`)
})
t('E5', '错误码：e.code 优先，否则看 message 开头的 E+大写；查不到用默认提示', () => {
  const got = [
    M.courseToolError({ message: 'EACCES: permission denied' }, { tool: 'fs' }),
    M.courseToolError({ message: 'ENOENT x', code: 'ETIMEDOUT' }, { tool: 'fs' }),
    M.courseToolError({ message: 'Error: boom' }, { tool: 'fs' }),
    M.courseToolError({ message: 'E' }, { tool: 'fs' }),
    M.courseToolError({ message: 'bad', code: 'INVALID_ARGS' }, { tool: 'fs' }),
    M.courseToolError({ message: 'EPERM no', code: '' }, { tool: 'fs' }),
  ].map((s) => s.split('\n')[1])
  const want = ['EACCES', 'ETIMEDOUT', '', '', 'INVALID_ARGS', 'EPERM'].map((c) => `下一步：${HINT(c)}`)
  need(J(got) === J(want), J(got))
})
t('E6', '不是带 message 的对象也要能回填；空工具名 → unknown-tool', () => {
  const D = `下一步：${shared.DEFAULT_HINT}`
  const got = [M.courseToolError('disk full', { tool: 'w' }), M.courseToolError(null, { tool: '' }), M.courseToolError({ message: 42 }, { tool: 'x' }), M.courseToolError(undefined, { tool: 'y' })]
  const want = [`[tool error] w: disk full\n${D}`, `[tool error] unknown-tool: （没有错误信息）\n${D}`, `[tool error] x: （没有错误信息）\n${D}`, `[tool error] y: （没有错误信息）\n${D}`]
  need(J(got) === J(want), J(got))
})
t('E7', '换行压平；先脱敏后截断；按码点截到 200 加 …', () => {
  const head = (m: string) => M.courseToolError({ message: m }, { tool: 't' }).split('\n')[0]
  need(head('a\nb\r\nc') === '[tool error] t: a b  c', J(head('a\nb\r\nc')))
  need(M.courseToolError({ message: 'a\nb' }, { tool: 't' }).split('\n').length === 2, '消息里的换行没压平')
  const h200 = '汉'.repeat(200)
  need(head(h200) === `[tool error] t: ${h200}`, '正好 200 个码点不该截')
  need(head('汉'.repeat(201)) === `[tool error] t: ${h200}…`, '201 个码点应截到 200 加 …')
  need(head('😀'.repeat(201)) === `[tool error] t: ${'😀'.repeat(200)}…`, '按 UTF-16 码元截断了：emoji 是一个码点、两个码元')
  const m = 'x'.repeat(190) + ' sk-' + 'A'.repeat(20)
  need(head(m) === `[tool error] t: ${'x'.repeat(190)} sk-***`, `先截断再脱敏了：${J(head(m)?.slice(-12))}`)
})

// ─────────────────────────────────────────────────────────────
section('R · 审批恢复只消费一次（TODO 3）')

t('R1', '第一次：先写 in-flight 再调 resume；成功写 done，返回 ran', () => {
  const store: shared.Kv = new Map()
  let seen = ''
  const o = M.resumeOnce(store, 'a1', 'approve', () => {
    seen = store.get('approval:a1') ?? 'missing'
    return 'ok'
  })
  need(J(o) === J({ status: 'ran', result: 'ok' }), J(o))
  need(seen === 'in-flight', `resume 执行时记录是 ${J(seen)}，应先写 in-flight`)
  need(store.get('approval:a1') === 'done:approve:ok' && store.size === 1, J([...store]))
})
t('R2', '重放同一条审批：不再调 resume，返回缓存的结果（结果里可以有冒号）', () => {
  const store: shared.Kv = new Map()
  let calls = 0
  const fn = () => {
    calls++
    return 'a:b:c'
  }
  const got = [M.resumeOnce(store, 'a1', 'approve', fn), M.resumeOnce(store, 'a1', 'approve', fn), M.resumeOnce(store, 'a1', 'approve', fn)]
  need(calls === 1, `resume 被调了 ${calls} 次`)
  need(J(got.map((o) => [o.status, o.result])) === J([['ran', 'a:b:c'], ['already-consumed', 'a:b:c'], ['already-consumed', 'a:b:c']]), J(got))
  const s2: shared.Kv = new Map()
  M.resumeOnce(s2, 'r', 'reject', () => '')
  const again = M.resumeOnce(s2, 'r', 'reject', () => 'x')
  need(s2.get('approval:r') === 'done:reject:' && J(again) === J({ status: 'already-consumed', result: '' }), `${J([...s2])} ${J(again)}`)
})
t('R3', '决定不同 → conflict，带回先前的决定；记录不变', () => {
  const store: shared.Kv = new Map()
  M.resumeOnce(store, 'a1', 'approve', () => 'x')
  const o = M.resumeOnce(store, 'a1', 'reject', () => 'y')
  need(J(o) === J({ status: 'conflict', result: 'approve' }) && store.get('approval:a1') === 'done:approve:x', `${J(o)} ${J([...store])}`)
  const s2: shared.Kv = new Map()
  M.resumeOnce(s2, 'b', 'reject', () => 'no')
  const o2 = M.resumeOnce(s2, 'b', 'approve', () => 'yes')
  need(J(o2) === J({ status: 'conflict', result: 'reject' }), J(o2))
})
t('R4', 'resume 抛异常 → crashed，记录留在 in-flight；之后的重投递不重跑', () => {
  const store: shared.Kv = new Map()
  const o = M.resumeOnce(store, 'a2', 'approve', () => {
    throw new Error('killed')
  })
  need(J(o) === J({ status: 'crashed', result: 'killed' }), J(o))
  need(store.get('approval:a2') === 'in-flight', `崩溃后记录是 ${J(store.get('approval:a2') ?? null)}`)
  let calls = 0
  const fn = () => {
    calls++
    return 'z'
  }
  const got = [M.resumeOnce(store, 'a2', 'approve', fn), M.resumeOnce(store, 'a2', 'reject', fn)]
  need(calls === 0 && J(got) === J([{ status: 'in-flight', result: '' }, { status: 'in-flight', result: '' }]), `调了 ${calls} 次，${J(got)}`)
})
t('R5', '键按审批 id 隔离；预置的 in-flight 也不重跑；不碰别的键', () => {
  const store: shared.Kv = new Map([
    ['approval:a', 'in-flight'],
    ['other', 'keep'],
  ])
  let calls = 0
  const fn = () => {
    calls++
    return `r${calls}`
  }
  const got = [M.resumeOnce(store, 'a', 'approve', fn), M.resumeOnce(store, 'a1', 'approve', fn), M.resumeOnce(store, 'b', 'reject', fn)]
  need(J(got.map((o) => o.status)) === J(['in-flight', 'ran', 'ran']) && calls === 2, `${J(got)} calls=${calls}`)
  need(J([...store].sort()) === J([['approval:a', 'in-flight'], ['approval:a1', 'done:approve:r1'], ['approval:b', 'done:reject:r2'], ['other', 'keep']]), J([...store]))
})

// ─────────────────────────────────────────────────────────────
section('M · MCP 结果 → 文本（TODO 4）')

const txt = (text: string) => ({ type: 'text', text })

t('M1', 'isError 只有缺省 / null / false 算成功，其余一律当失败', () => {
  const vals: unknown[] = [null, false, true, 'true', 1, 0, 'false', {}]
  const got = vals.map((v) => M.mcpResultToText({ content: [txt('x')], isError: v }).isError)
  const missing = M.mcpResultToText({ content: [txt('x')] }).isError
  need(!missing, '缺省 isError 当成了失败')
  need(J(got) === J([false, false, true, true, true, true, true, true]), J(got))
})
t('M2', 'text 原样；image / resource / resource_link 各有写法；用换行连接', () => {
  const got = [
    M.mcpResultToText(F.mcpCases[4]!.result).text,
    M.mcpResultToText({ content: [{ type: 'image', data: 'x' }, { type: 'resource', resource: { uri: 'file:///x' } }, { type: 'resource', resource: {} }] }).text,
  ]
  need(J(got) === J(['[image image/png，未展开]\n[resource file:///r.txt]\nhello\n[link file:///big.log]', '[image ?，未展开]\n[resource file:///x]\n[resource ?]']), J(got))
})
t('M3', '不认识的 content 不丢：不是对象、未知 type、type 缺省、字段不对', () => {
  const r: McpResult = {
    content: ['raw', { type: 'audio', data: '..' }, { foo: 1 }, { type: 3 }, { type: 'text' }, { type: 'resource_link' }, { type: 'resource', resource: 'x' }, null],
  }
  const got = M.mcpResultToText(r).text.split('\n')
  const want = [
    '[unsupported content]',
    '[unsupported content: audio]',
    '[unsupported content: null]',
    '[unsupported content: 3]',
    '[unsupported content: text]',
    '[unsupported content: resource_link]',
    '[unsupported content: resource]',
    '[unsupported content]',
  ]
  need(J(got) === J(want), J(got))
})
t('M4', '一项都没有：structuredContent 键在就给它的 JSON（null 也算），否则 (empty result)', () => {
  const got = [
    M.mcpResultToText({ content: [], structuredContent: { rows: 2 } }).text,
    M.mcpResultToText({}).text,
    M.mcpResultToText({ structuredContent: null }).text,
    M.mcpResultToText({ content: 'not-array' }).text,
    M.mcpResultToText({ content: [txt('a')], structuredContent: { x: 1 } }).text,
  ]
  need(J(got) === J(['{"rows":2}', '(empty result)', 'null', '(empty result)', 'a']), J(got))
})
t('M5', '失败：[tool error] 前缀 + 脱敏；成功既不加前缀也不脱敏', () => {
  const got = [
    M.mcpResultToText(F.mcpCases[3]!.result),
    M.mcpResultToText({ isError: true }),
    M.mcpResultToText({ content: [txt('token=abc')] }),
  ]
  need(
    J(got) === J([{ text: '[tool error] 401 token=*** rejected', isError: true }, { text: '[tool error] (empty result)', isError: true }, { text: 'token=abc', isError: false }]),
    J(got),
  )
})
t('M6', '夹具里的七种情况全量对表', () => {
  const got = F.mcpCases.map((c) => M.mcpResultToText(c.result))
  const want = [
    { text: '[tool error] EACCES: permission denied', isError: true },
    { text: '3 files', isError: false },
    { text: '[tool error] quota exceeded', isError: true },
    { text: '[tool error] 401 token=*** rejected', isError: true },
    { text: '[image image/png，未展开]\n[resource file:///r.txt]\nhello\n[link file:///big.log]', isError: false },
    { text: '{"rows":2}', isError: false },
    { text: '(empty result)', isError: false },
  ]
  need(J(got.map((g) => [g.text, g.isError])) === J(want.map((g) => [g.text, g.isError])), J(got))
})

// ─────────────────────────────────────────────────────────────
section('H · 以服务端为准重建历史（TODO 5）')

const hist = (r: Rebuilt) => r.history.map((h) => `${h.toolCallId}|${h.type}|${h.value}`)
const lg = (toolCallId: string, kind: 'error' | 'result', text: string): LoggedResult => ({ toolCallId, kind, text })
const ui = (toolCallId: string, state: 'output-error' | 'output-available', text: string): UiToolPart => ({ toolCallId, state, text })

t('H1', 'history 按日志顺序，内容以日志为准', () => {
  const r = M.rebuildHistory(F.history.ui, F.history.log)
  const want = ['c1|text|3 files', `c2|error-text|${F.history.log[1]!.text}`, 'c3|text|ok']
  need(J(hist(r)) === J(want), J(hist(r)))
})
t('H2', '对账：被遮罩的 drifted，客户端造的 forged，客户端丢的 dropped', () => {
  const r = M.rebuildHistory(F.history.ui, F.history.log)
  need(J([r.drifted, r.forged, r.dropped]) === J([['c2'], ['c9'], ['c3']]), J([r.drifted, r.forged, r.dropped]))
})
t('H3', '种类不一致也算 drifted（文本一样也算）；完全一致不算', () => {
  const a = M.rebuildHistory([ui('a', 'output-available', 'x')], [lg('a', 'error', 'x')]).drifted
  const b = M.rebuildHistory([ui('b', 'output-error', 'y')], [lg('b', 'result', 'y')]).drifted
  const c = M.rebuildHistory([ui('c', 'output-error', 'z')], [lg('c', 'error', 'z')]).drifted
  need(J([a, b, c]) === J([['a'], ['b'], []]), J([a, b, c]))
})
t('H4', 'UI 里重复的 id 只看第一次；forged 去重、按 UI 顺序', () => {
  const r1 = M.rebuildHistory([ui('a', 'output-available', '1'), ui('a', 'output-available', 'tampered'), ui('z', 'output-available', ''), ui('y', 'output-error', ''), ui('z', 'output-available', '')], [lg('a', 'result', '1')])
  const r2 = M.rebuildHistory([ui('a', 'output-available', 'tampered'), ui('a', 'output-available', '1')], [lg('a', 'result', '1')])
  need(J([r1.drifted, r1.forged, r1.dropped]) === J([[], ['z', 'y'], []]), J([r1.drifted, r1.forged, r1.dropped]))
  need(J(r2.drifted) === J(['a']), `第二次出现覆盖了第一次：${J(r2.drifted)}`)
})
t('H5', 'drifted / dropped 按日志顺序；UI 为空全部 dropped；日志为空 history 为空', () => {
  const log = [lg('c', 'result', '3'), lg('b', 'result', '2'), lg('a', 'result', '1')]
  const r = M.rebuildHistory([ui('a', 'output-available', 'x'), ui('b', 'output-available', 'y')], log)
  need(J([r.drifted, r.dropped]) === J([['b', 'a'], ['c']]), J([r.drifted, r.dropped]))
  const e = M.rebuildHistory([], log)
  need(J(e.dropped) === J(['c', 'b', 'a']) && hist(e).length === 3, J(e))
  const n = M.rebuildHistory([ui('q', 'output-available', '')], [])
  need(J([hist(n), n.forged, n.drifted, n.dropped]) === J([[], ['q'], [], []]), J(n))
})

// ─────────────────────────────────────────────────────────────
section('D · Dify DSL → 代码计划（TODO 6）')

const sig = (p: shared.DifyPlan) => p.steps.map((s) => `${s.id}:${s.type}:${s.needs.join('+')}`)
const graph = (nodes: unknown[], edges: unknown[], extra: Record<string, unknown> = {}) => ({ version: '0.7.0', kind: 'app', ...extra, workflow: { graph: { nodes, edges } } })
const node = (id: string, data: Record<string, unknown>, canvas: Record<string, unknown> = {}) => ({ id, type: 'custom', ...canvas, data })
const edge = (source: string, target: string, extra: Record<string, unknown> = {}) => ({ id: `${source}-${target}`, source, target, ...extra })

t('D1', '夹具：version / kind / 画布字段数 / 执行顺序 / 分支', () => {
  const p = M.difyPlan(fx().dify)
  need(p.version === '0.7.0' && p.kind === 'app', `${p.version} ${p.kind}`)
  need(p.uiFieldsDropped === 20, `画布字段 ${p.uiFieldsDropped}，应为 20`)
  need(J(p.order) === J(['start', 'kr', 'route', 'llm', 'ticket', 'notify', 'answer', 'fallback']), J(p.order))
  need(J(p.branches) === J(['route:true->llm', 'route:false->ticket']), J(p.branches))
})
t('D2', '夹具：每个节点改写成代码时要补的东西', () => {
  const p = M.difyPlan(fx().dify)
  const want = [
    'start:start:',
    'kr:knowledge-retrieval:rebind-index',
    'route:if-else:',
    'llm:llm:sliding-window-breaks-cache',
    'ticket:http-request:no-retry+idempotency-key',
    'notify:tool:reconnect-secret',
    'answer:answer:',
    'fallback:answer:',
  ]
  need(J(sig(p)) === J(want), J(sig(p)))
  need(p.steps[0]?.title === '开始' && p.steps[4]?.title === '建工单', J(p.steps.map((s) => s.title)))
})
t('D3', '夹具：false 分支引用了 true 分支的输出', () => {
  const p = M.difyPlan(fx().dify)
  need(
    J(p.refs) === J(['llm<-kr.result', 'llm<-sys.query', 'ticket<-sys.query', 'notify<-ticket.body', 'answer<-llm.text', 'fallback<-ticket.body', 'fallback<-sys.query']),
    J(p.refs),
  )
  need(J(p.errors) === J(['ref-not-upstream:ticket:llm.text']), J(p.errors))
})
t('D4', '版本与 kind：缺省补 0.1.0 / app；新于读取器、格式不对、kind 不对都报；不是对象', () => {
  const e = (x: unknown) => M.difyPlan(x).errors
  const empty = M.difyPlan({})
  need(empty.version === '0.1.0' && empty.kind === 'app' && empty.errors.length === 0 && empty.order.length === 0, J(empty))
  const got = [e({ version: '0.8.0' }), e({ version: '0.7.1' }), e({ version: '0.10.0' }), e({ version: '1.0' }), e({ version: '0.6.9' }), e({ version: '0.7.0', kind: 'dataset' }), e({ version: 7 })]
  need(J(got) === J([['newer-dsl:0.8.0'], ['newer-dsl:0.7.1'], ['newer-dsl:0.10.0'], ['bad-version:1.0'], [], ['kind:dataset'], []]), J(got))
  const bad = [M.difyPlan(null), M.difyPlan([]), M.difyPlan('x')].map((p) => [p.version, p.errors])
  need(J(bad) === J([['', ['not-an-object']], ['', ['not-an-object']], ['', ['not-an-object']]]), J(bad))
})
t('D5', '坏节点（含空 id）、重复节点、悬空边：报出来，图照样排', () => {
  const p = M.difyPlan(
    graph(
      [node('a', { type: 'start', title: 'A' }), 'junk', node('b', { type: 'code', title: 'B' }, { position: {} }), node('a', { type: 'end' }, { width: 1 }), { data: {} }, { id: '', data: { type: 'code' } }],
      [edge('a', 'b'), edge('b', 'zz', { id: 'e2' }), 5, { source: 'a', target: 'q', zIndex: 0 }],
    ),
  )
  need(J(p.errors) === J(['bad-node', 'duplicate-node:a', 'bad-node', 'bad-node', 'dangling-edge:e2', 'bad-edge', 'dangling-edge:?']), J(p.errors))
  need(p.uiFieldsDropped === 3, `画布字段 ${p.uiFieldsDropped}，应为 3（重复节点和悬空边上的也算）`)
  need(J(sig(p)) === J(['a:start:', 'b:code:sandbox']), J(sig(p)))
})
t('D6', '每轮取列表里第一个入度为 0 的；取不完的报 cycle，steps 里照样列出', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const p = M.difyPlan(
    graph(
      ids.map((id) => node(id, { type: 'answer' })),
      [edge('a', 'd'), edge('b', 'c'), edge('e', 'f'), edge('f', 'e'), edge('f', 'g')],
    ),
  )
  need(J(p.order) === J(['a', 'b', 'c', 'd']), `执行顺序 ${J(p.order)}（不是队列序 a,b,d,c）`)
  need(J(p.errors) === J(['cycle:e,f,g']), J(p.errors))
  need(J(p.steps.map((s) => s.id)) === J(ids) && p.branches.length === 0, J(p.steps.map((s) => s.id)))
})
t('D7', '引用：命名空间、未知节点、不是上游、同节点去重；嵌套的字符串也要扫到', () => {
  const p = M.difyPlan(
    graph(
      [
        node('start', { type: 'start' }),
        node('n1', { type: 'llm', prompt: ['{{#sys.query#}} {{#sys.query#}}', { deep: { x: '{{#ghost.out#}}' } }], memory: { window: { enabled: false } } }),
        node('n2', { type: 'template-transform', template: '{{#n1.text#}}{{#n2.self#}}{{#env.KEY#}}{{#start.a.b#}}' }),
        node('n3', { type: 'answer', answer: '{{#n2.output#}} {{#sys#}} {{#conversation.x#}}' }),
      ],
      [edge('start', 'n1'), edge('n1', 'n2'), edge('n2', 'n3')],
    ),
  )
  need(J(p.refs) === J(['n1<-sys.query', 'n2<-n1.text', 'n2<-env.KEY', 'n2<-start.a.b', 'n3<-n2.output', 'n3<-conversation.x']), J(p.refs))
  need(J(p.errors) === J(['unknown-ref:n1:ghost.out', 'ref-not-upstream:n2:n2.self']), J(p.errors))
  need(J(sig(p)) === J(['start:start:', 'n1:llm:', 'n2:template-transform:', 'n3:answer:']), J(sig(p)))
})

// ─────────────────────────────────────────────────────────────
section('F · 框架模型（参考实现，只读）')

t('F1', '七个入口的默认上限：1 到无穷大，撞上限有三种结束方式', () => {
  const o = F.loops.map((d) => shared.simulateDefaultLoop(d, 50))
  need(J(F.loops.map((d) => d.defaultLimit)) === J([1, 20, null, 5, 10, null, 25]), J(F.loops.map((d) => d.defaultLimit)))
  need(J(o.map((x) => x.modelCalls)) === J([1, 20, 50, 5, 10, 50, 25]), J(o.map((x) => x.modelCalls)))
  need(J(F.loops.filter((d) => d.onLimit === 'throw').map((d) => d.id)) === J(['openai-agents/run', 'langgraph.js']), '只有 Agents SDK 和 LangGraph 撞上限会抛')
})
t('F2', 'isStepCount 是严格相等：0 永远不触发；课程用 ≥', () => {
  need(J(firstStop(failingSteps(20), shared.aiSdkIsStepCount(0))) === J([0, 'running']), 'isStepCount(0) 触发了')
  need(J(firstStop(failingSteps(20), shared.aiSdkIsStepCount(20))) === J([20, 'stop']), 'isStepCount(20) 应在第 20 步触发')
  need(shared.courseStopWhen({ maxSteps: 0, maxRepeat: 0 })(failingSteps(1)), '课程的 maxSteps 0 应当停')
})
t('F3', '四家框架的默认回填：三家泄密，一家叫你原样重试', () => {
  const e = F.toolError
  const got = F.backfills.map((r) => shared.auditBackfill(shared.frameworkBackfill(r, e), e.tool))
  need(
    J(got) ===
      J([
        ['leaks-secret', 'no-tool-name', 'no-next-step'],
        ['leaks-secret', 'no-error-signal', 'no-tool-name', 'no-next-step'],
        ['leaks-secret', 'no-error-signal', 'no-tool-name', 'no-next-step'],
        ['no-tool-name', 'no-next-step', 'retry-as-is'],
      ]),
    J(got),
  )
  need(shared.auditBackfill(shared.courseToolError(e, { tool: e.tool }), e.tool).length === 0, '课程的回填没过体检')
})
t('F4', 'MCP isError：AI SDK 的线上块没有 is_error；DeepSeek 只看文本', () => {
  const r = F.mcpCases[0]!.result
  const wire = shared.aiSdkMcpWire(r, 'tu1')
  need(J(wire) === '{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"EACCES: permission denied"}]}', J(wire))
  need(shared.deepseekSees(wire) === 'EACCES: permission denied', '对照组的文本不对')
  need(shared.deepseekSees(shared.courseMcpWire(r, 'tu1')) === '[tool error] EACCES: permission denied', '课程的块里看不出失败')
})
t('F5', 'UI 遮罩改写下一轮；同一份 RunState 恢复两次执行两次', () => {
  const d = shared.uiRoundTrip(F.ui.modelSaw)
  need(d.turnN === F.ui.modelSaw && d.turnN1 === shared.AI_SDK_UI_ERROR_MASK, J(d))
  need(shared.uiRoundTrip(F.ui.modelSaw, (s) => s).turnN1 === F.ui.modelSaw, 'onError: s => s 之后应当不变')
  let n = 0
  need(J(shared.runStateResume(2, () => n++)) === J(F.runState.measuredEffects) && n === 2, J(F.runState))
})
t('F6', 'Claude Agent SDK 的默认、fork 成本累计、平台的选法', () => {
  const c = F.claudeAgentSdk
  need(c.permissionMode === 'auto' && F.loops.find((d) => d.id === 'claude-agent-sdk/query')?.defaultLimit === null, '默认 auto、默认无上限')
  need(shared.auditBackfill(c.autoDenial, 'x').includes('retry-as-is'), '分类器失败的回填应当是「原样重试」')
  need(c.sessions[2]!.costMicroUsd >= c.sessions[1]!.costMicroUsd && shared.fmtUsd(c.sessions[2]!.costMicroUsd) === '0.0024', 'fork 的成本应包含父会话')
  const picks = SCENARIOS.map(([, n]) => shared.choosePlatform(n))
  need(J(picks.map((p) => p.pick)) === J(['平台', '平台做原型，DSL 当需求文档，手写上线', '手写', '手写']), J(picks.map((p) => p.pick)))
  need(picks[1]!.license.length === 1 && picks[3]!.license[0]!.startsWith('n8n'), J(picks.map((p) => p.license)))
})

console.log()
if (failed === 0) {
  console.log(green(`  ✓ ${passed} 条断言全部通过`))
  console.log(
    dim(
      '\n  最该记住的六条：\n' +
        '    STOP   原因要显式：approval / truncated / error / done / repeat / max_steps 各是各的；上限用 ≥，0 也要停\n' +
        '    ERROR  失败写在文本里：前缀 + 工具名 + 下一步；先脱敏再截断；不叫模型原样重试\n' +
        '    ONCE   恢复只消费一次：先认领再执行；in-flight 不重跑、要对账；决定冲突要报\n' +
        '    MCP    isError 只有缺省 / null / false 算成功；不认识的 content 写出来，不要吞\n' +
        '    HIST   下一轮的历史以服务端日志为准；UI 消息只用来对账：drifted / forged / dropped\n' +
        '    DSL    拓扑序在前不等于是上游；凭据、知识库、画布字段都不跟着 DSL 走\n',
    ),
  )
  process.exit(0)
}
console.log(red(`  ✗ ${failed} 失败 / ${passed} 通过`))
process.exit(1)
