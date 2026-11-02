/**
 * 验证 l10/server.ts。跑法：pnpm verify:l10
 *
 * 一次 API 都不调，也不 spawn 子进程——**除了最后一组**。
 * 最后那两条会真的起一个进程走一遍管道，因为拆帧和 stdout 纪律
 * 这两件事只有在真管道上才测得出来。
 *
 * 这套测试里有一整组盯着**静默失效**（标 ★）：
 * 拆帧丢半条、通知被回了响应、错误走错通道、工具顺序不确定、
 * logNote 漏进响应、子进程死了 Promise 不 reject。
 *
 * 它们的共同点是**不抛异常**。协议层坏掉的样子从来不是报错，
 * 是"大部分时候能用"。
 *
 * 先跑 VERIFY_TARGET=shared pnpm verify:l10 确认测试本身是对的。
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ToolDef } from '../shared/tools.ts'

// ─── 模块形状 ────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number; result: Record<string, unknown> }
  | { jsonrpc: '2.0'; id: string | number | null; error: JsonRpcError }

interface ToolOutcome {
  text: string
  isError?: boolean
  structured?: unknown
}

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<ToolOutcome>
}

interface McpServer {
  name: string
  version: string
  tools: McpTool[]
}

interface Framer {
  push(chunk: string): string[]
  readonly buffered: number
}

type Validated =
  | { ok: true; req: JsonRpcRequest }
  | { ok: false; id: string | number | null; error: JsonRpcError }

interface McpModule {
  createFramer(maxLineChars?: number): Framer
  validateRequest(raw: string): Validated
  toolsListCost(tools: McpTool[], budgetTokens?: number): { tools: number; tokens: number; share: number }
}

interface ServerModule {
  routeRequest(server: McpServer, req: JsonRpcRequest): Promise<JsonRpcResponse | null>
  callTool(server: McpServer, id: string | number, params: Record<string, unknown>): Promise<JsonRpcResponse>
  wrapTool(def: ToolDef<never>): McpTool
}

const target = process.env.VERIFY_TARGET === 'shared' ? 'shared' : 'mine'

const shared = (await import('../shared/mcp.ts')) as unknown as McpModule & {
  wrapToolDef(def: ToolDef<never>): McpTool
  handleRequest(server: McpServer, req: JsonRpcRequest): Promise<JsonRpcResponse | null>
  PROTOCOL_VERSION: string
  META_VERSION: string
  META_CLIENT_INFO: string
  META_CLIENT_CAPS: string
}

const M: McpModule =
  target === 'shared' ? shared : ((await import('./server.ts')) as unknown as McpModule)

const S: ServerModule =
  target === 'shared'
    ? {
        routeRequest: shared.handleRequest,
        // shared 那边把 tools/call 收在 handleRequest 里，这里包一层对齐形状。
        callTool: async (server, id, params) =>
          (await shared.handleRequest(server, {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params,
          })) as JsonRpcResponse,
        wrapTool: shared.wrapToolDef,
      }
    : ((await import('./server.ts')) as unknown as ServerModule)

const { PROTOCOL_VERSION, META_VERSION, META_CLIENT_INFO, META_CLIENT_CAPS } = shared

console.log(target === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l10/ 里你的实现）')

let passed = 0
const failures: string[] = []

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`\x1b[32m  ✓ ${name}\x1b[0m`)
  } catch (err) {
    failures.push(name)
    console.log(`\x1b[31m  ✕ ${name}\x1b[0m`)
    console.log(`\x1b[31m      ${(err as Error).message}\x1b[0m`)
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

// ─── 素材 ────────────────────────────────────────────────────

function meta(version = PROTOCOL_VERSION): Record<string, unknown> {
  return {
    [META_VERSION]: version,
    [META_CLIENT_INFO]: { name: 't', version: '0' },
    [META_CLIENT_CAPS]: {},
  }
}

function req(method: string, params: Record<string, unknown> = {}, id: number | undefined = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params: { ...params, _meta: meta() } })
}

function fakeTool(name: string, run: McpTool['run']): McpTool {
  return { name, description: `工具 ${name}`, inputSchema: { type: 'object' }, run }
}

function fakeServer(tools: McpTool[]): McpServer {
  return { name: 'test', version: '1', tools }
}

const okTool = fakeTool('echo', async (a) => ({ text: `echo:${JSON.stringify(a)}` }))
const softFail = fakeTool('soft', async () => ({ text: '文件不存在：a.ts。用 list_dir 看看。', isError: true }))
const hardFail = fakeTool('hard', async () => {
  throw new Error('数据库连不上')
})

function ask(server: McpServer, method: string, params: Record<string, unknown> = {}, id: number | undefined = 1) {
  const v = M.validateRequest(req(method, params, id))
  assert(v.ok, `校验没过：${v.ok === false ? v.error.message : ''}`)
  return S.routeRequest(server, v.req)
}

function resultOf(r: JsonRpcResponse | null): Record<string, unknown> {
  assert(r !== null, '不该是 null（这不是通知）')
  assert(!('error' in r), `不该是错误：${'error' in r ? JSON.stringify(r.error) : ''}`)
  return r.result
}

function errorOf(r: JsonRpcResponse | null): JsonRpcError {
  assert(r !== null, '不该是 null')
  assert('error' in r, `应该是协议错误，实际是 result：${JSON.stringify(r)}`)
  return r.error
}

// ─────────────────────────────────────────────────────────────
console.log('\nNDJSON 拆帧')
// ─────────────────────────────────────────────────────────────

await test('一次喂进整行', () => {
  const f = M.createFramer()
  assert(f.push('{"a":1}\n').length === 1, '一整行应该吐出一条')
})

await test('一次喂进多行', () => {
  const f = M.createFramer()
  assert(f.push('{"a":1}\n{"b":2}\n').length === 2, '两行应该吐出两条')
})

await test('★ 半条消息要留在缓冲里，不能吐出去', () => {
  const f = M.createFramer()
  const got = f.push('{"a":1')
  assert(got.length === 0, `半条不该吐出来，吐了 ${JSON.stringify(got)}`)
  assert(f.buffered > 0, 'buffered 应该 > 0——它是诊断"对面卡住了"的唯一信号')
  assert(f.push('}\n').length === 1, '补齐之后才吐')
})

await test('★ 任意字节边界都不能丢内容（管道只承诺顺序）', () => {
  const wire = '{"a":1}\n{"b":22}\n{"c":333}\n'
  for (const size of [1, 2, 3, 5, 7, 11, 17]) {
    const f = M.createFramer()
    const got: string[] = []
    for (let i = 0; i < wire.length; i += size) got.push(...f.push(wire.slice(i, i + size)))
    assert(
      got.length === 3,
      `按 ${size} 字节切之后只拿到 ${got.length} 条。\n` +
        '      不拆帧的代码在本地"能跑"，是因为消息小、来得慢；\n' +
        '      等到某个工具返回 80KB 才炸，而且是在生产环境',
    )
    assert(got[0] === '{"a":1}' && got[2] === '{"c":333}', `内容被切坏了：${JSON.stringify(got)}`)
  }
})

await test('空行被跳过（不能当成一条空消息）', () => {
  const f = M.createFramer()
  assert(f.push('\n\n{"a":1}\n\n').length === 1, '空行不该算消息')
})

await test('★ 超过上限要抛错，不能无限缓冲', () => {
  const f = M.createFramer(64)
  let threw = false
  try {
    f.push('x'.repeat(200))
  } catch {
    threw = true
  }
  assert(
    threw,
    '没有上限的话，对面永远不发换行时缓冲区会涨到 OOM。\n' +
      '      而 OOM 的现场没有任何信息指向"对面没换行"这个原因',
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n请求校验（2026-07-28 的每请求元数据）')
// ─────────────────────────────────────────────────────────────

await test('合法请求能过', () => {
  const v = M.validateRequest(req('tools/list'))
  assert(v.ok, `应该通过：${v.ok === false ? v.error.message : ''}`)
  assert(v.req.method === 'tools/list', 'method 没读对')
})

await test('不是 JSON → -32700', () => {
  const v = M.validateRequest('server started on port 3000')
  assert(!v.ok && v.error.code === -32700, `应该是 -32700，实际 ${JSON.stringify(v)}`)
})

await test('jsonrpc 不是 "2.0" → -32600', () => {
  const v = M.validateRequest('{"jsonrpc":"1.0","id":1,"method":"x","params":{}}')
  assert(!v.ok && v.error.code === -32600, `应该是 -32600，实际 ${JSON.stringify(v)}`)
})

await test('★ 缺 protocolVersion → -32602（不是 -32002）', () => {
  const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [META_CLIENT_CAPS]: {} } } })
  const v = M.validateRequest(raw)
  assert(
    !v.ok && v.error.code === -32602,
    '2026-07-28 把老的 -32002 换成了 -32602。\n' +
      '      照旧教程写 -32002 判断的代码在新 server 上不会报错，\n' +
      '      会**静默走进 else 分支**——这类 bug 只在版本升级后出现',
  )
})

await test('缺 clientCapabilities → -32602', () => {
  const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [META_VERSION]: PROTOCOL_VERSION } } })
  const v = M.validateRequest(raw)
  assert(!v.ok && v.error.code === -32602, `应该是 -32602，实际 ${JSON.stringify(v)}`)
})

await test('★ 版本不支持 → -32022，且 data 里带 supported 列表', () => {
  const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta('2025-06-18') } })
  const v = M.validateRequest(raw)
  assert(!v.ok && v.error.code === -32022, `应该是 -32022，实际 ${JSON.stringify(v)}`)
  const data = v.ok ? null : (v.error.data as { supported?: string[] } | undefined)
  assert(
    Array.isArray(data?.supported) && data.supported.includes(PROTOCOL_VERSION),
    '少了 supported 列表，客户端只能猜或者放弃。\n' +
      '      带上它，"版本不匹配"就从一个死胡同变成一次自动重试',
  )
})

await test('★ 校验失败也要能定位 id（否则客户端永远挂着）', () => {
  const raw = JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/list', params: {} })
  const v = M.validateRequest(raw)
  assert(!v.ok, '这条应该不过')
  assert(
    v.id === 77,
    `id 没读出来（拿到 ${JSON.stringify(v.id)}）。\n` +
      '      读不出 id 就回不了响应，而客户端那边挂着一个永远不 resolve 的 Promise',
  )
})

await test('id 是 null → 不合法（MCP 比 JSON-RPC 严）', () => {
  const raw = JSON.stringify({ jsonrpc: '2.0', id: null, method: 'tools/list', params: { _meta: meta() } })
  const v = M.validateRequest(raw)
  assert(!v.ok, 'id=null 应该被拒——null 没法和"通知"区分开')
})

await test('通知（没有 id）不需要 _meta', () => {
  const raw = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } })
  const v = M.validateRequest(raw)
  assert(v.ok, `通知应该通过：${v.ok === false ? v.error.message : ''}`)
  assert(v.req.id === undefined, '通知不该有 id')
})

// ─────────────────────────────────────────────────────────────
console.log('\n路由')
// ─────────────────────────────────────────────────────────────

await test('server/discover 报出支持的版本和能力', async () => {
  const r = resultOf(await ask(fakeServer([okTool]), 'server/discover'))
  assert(Array.isArray(r.supportedVersions), '要有 supportedVersions')
  assert((r.supportedVersions as string[]).includes(PROTOCOL_VERSION), '要包含当前版本')
  assert(typeof r.capabilities === 'object', '要有 capabilities')
})

await test('tools/list 返回全部工具的对外形状', async () => {
  const r = resultOf(await ask(fakeServer([okTool, softFail]), 'tools/list'))
  const tools = r.tools as Record<string, unknown>[]
  assert(tools.length === 2, `应该 2 个，实际 ${tools.length}`)
  for (const t of tools) {
    assert(typeof t.name === 'string' && typeof t.description === 'string', '缺 name/description')
    assert(typeof t.inputSchema === 'object', '缺 inputSchema')
    assert(!('run' in t), 'run 不该出现在协议里')
  }
})

await test('★ tools/list 的顺序必须确定（前缀缓存靠它）', async () => {
  const names = ['zeta', 'alpha', 'mid']
  const a = resultOf(await ask(fakeServer(names.map((n) => fakeTool(n, okTool.run))), 'tools/list'))
  const b = resultOf(await ask(fakeServer([...names].reverse().map((n) => fakeTool(n, okTool.run))), 'tools/list'))
  const nameOf = (r: Record<string, unknown>) => (r.tools as { name: string }[]).map((t) => t.name).join(',')
  assert(
    nameOf(a) === nameOf(b),
    `注册顺序不同就得到不同的清单：\n      ${nameOf(a)}\n      ${nameOf(b)}\n` +
      '      工具清单进的是 system prompt 的**前缀**，顺序一抖前缀缓存整体失效。\n' +
      '      而账单上只会显示"input token 变贵了"',
  )
})

await test('★ 通知处理完不回响应', async () => {
  const v = M.validateRequest(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }))
  assert(v.ok, '通知应该过校验')
  const r = await S.routeRequest(fakeServer([okTool]), v.req)
  assert(
    r === null,
    '回了的话客户端会收到一个它没发过的 id 的响应。\n' +
      '      严格的实现会直接断连，宽容的会静默丢弃——两种都不好查',
  )
})

await test('未知方法 → -32601', async () => {
  const e = errorOf(await ask(fakeServer([okTool]), 'tools/nope'))
  assert(e.code === -32601, `应该是 -32601，实际 ${e.code}`)
})

await test('响应里带 serverInfo', async () => {
  const r = resultOf(await ask(fakeServer([okTool]), 'tools/list'))
  const m = r._meta as Record<string, unknown> | undefined
  assert(m && typeof m['io.modelcontextprotocol/serverInfo'] === 'object', '缺 _meta.serverInfo')
})

await test('resultType 是 complete', async () => {
  const r = resultOf(await ask(fakeServer([okTool]), 'tools/list'))
  assert(r.resultType === 'complete', `resultType 应该是 complete，实际 ${JSON.stringify(r.resultType)}`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n两种错误')
// ─────────────────────────────────────────────────────────────

await test('正常调用：isError=false，content 是文本块数组', async () => {
  const r = resultOf(await S.callTool(fakeServer([okTool]), 1, { name: 'echo', arguments: { x: 1 } }))
  assert(r.isError === false, `isError 应该是 false，实际 ${JSON.stringify(r.isError)}`)
  const content = r.content as { type: string; text: string }[]
  assert(content[0]?.type === 'text' && content[0].text.startsWith('echo:'), `content 不对：${JSON.stringify(content)}`)
})

await test('★ 工具返回失败 → result + isError:true（不是协议错误）', async () => {
  const resp = await S.callTool(fakeServer([softFail]), 1, { name: 'soft', arguments: {} })
  assert(
    !('error' in resp),
    '"文件不存在"是模型能自己改对的，必须进 result。\n' +
      '      写成协议错误的话模型看不到失败原因，只会重试同一个错参数',
  )
  assert(resp.result.isError === true, 'isError 应该是 true')
})

await test('★ 工具名不存在 → 协议错误（模型改参数也没用）', async () => {
  const e = errorOf(await S.callTool(fakeServer([okTool]), 1, { name: 'nope', arguments: {} }))
  assert(
    e.code === -32602,
    `应该是 -32602，实际 ${e.code}。\n` +
      '      写成 isError 的话，模型看到"没有这个工具"，然后接着编下一个工具名',
  )
})

await test('★ 工具 run 抛异常 → 协议错误 -32603（那是你的 bug）', async () => {
  const e = errorOf(await S.callTool(fakeServer([hardFail]), 1, { name: 'hard', arguments: {} }))
  assert(
    e.code === -32603,
    `应该是 -32603，实际 ${e.code}。\n` +
      '      把它也变成 isError 的话，模型会拿着一个永远不会成功的调用\n' +
      '      重试到步数上限，而你的日志里只有一堆看起来像"模型没试对"的 isError',
  )
  assert(/数据库连不上/.test(e.message), '错误信息里要有原始原因')
})

await test('arguments 不是对象 → 协议错误', async () => {
  const e = errorOf(await S.callTool(fakeServer([okTool]), 1, { name: 'echo', arguments: ['x'] }))
  assert(e.code === -32602, `应该是 -32602，实际 ${e.code}`)
})

await test('name 不是字符串 → 协议错误', async () => {
  const e = errorOf(await S.callTool(fakeServer([okTool]), 1, { name: 42 }))
  assert(e.code === -32602, `应该是 -32602，实际 ${e.code}`)
})

await test('省略 arguments 等于空对象', async () => {
  const r = resultOf(await S.callTool(fakeServer([okTool]), 1, { name: 'echo' }))
  const content = r.content as { text: string }[]
  assert(content[0]?.text === 'echo:{}', `应该当成 {}，实际 ${JSON.stringify(content)}`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n把 L04 的工具包成 MCP 工具')
// ─────────────────────────────────────────────────────────────

const strictDef: ToolDef<{ path: string }> = {
  name: 'peek',
  description: '读一个文件',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  parse: (raw) => {
    const p = (raw as { path?: unknown }).path
    if (typeof p !== 'string') return { ok: false, message: '缺少必填参数 path（需要一个非空字符串）。' }
    return { ok: true, input: { path: p } }
  },
  run: async ({ path }) =>
    path === 'secret'
      ? { isError: true, content: '不能读仓库外的路径。', logNote: '拒绝了一次越界访问 ../../etc/passwd' }
      : { content: `内容：${path}` },
}

await test('name / description / inputSchema 原样带过去', () => {
  const t = S.wrapTool(strictDef as unknown as ToolDef<never>)
  assert(t.name === 'peek' && t.description === '读一个文件', 'name/description 没带过去')
  assert((t.inputSchema as { required?: string[] }).required?.[0] === 'path', 'inputSchema 没带过去')
})

await test('正常路径：结果变成 text', async () => {
  const t = S.wrapTool(strictDef as unknown as ToolDef<never>)
  const out = await t.run({ path: 'a.ts' })
  assert(out.text === '内容：a.ts' && out.isError !== true, `不对：${JSON.stringify(out)}`)
})

await test('★ parse 失败 → isError:true，不是抛异常', async () => {
  const t = S.wrapTool(strictDef as unknown as ToolDef<never>)
  const out = await t.run({})
  assert(
    out.isError === true && /path/.test(out.text),
    '参数格式不对是模型能自己改的。\n' +
      '      L04 那条"失败回结果，不抛异常"在这里从团队约定升级成了协议要求',
  )
})

await test('run 返回的 isError 要透传', async () => {
  const t = S.wrapTool(strictDef as unknown as ToolDef<never>)
  const out = await t.run({ path: 'secret' })
  assert(out.isError === true, 'isError 没透传')
})

await test('★ logNote 不许进 content（它是给日志的，不是给模型的）', async () => {
  const t = S.wrapTool(strictDef as unknown as ToolDef<never>)
  const out = await t.run({ path: 'secret' })
  assert(
    !/etc\/passwd|越界/.test(out.text),
    `logNote 漏进响应了：${out.text}\n` +
      '      它的内容是「拒绝了一次越界访问 ../../etc/passwd」——\n' +
      '      回给模型等于把沙箱的边界告诉了可能正在探边界的那一方',
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n上下文税')
// ─────────────────────────────────────────────────────────────

await test('工具越多、描述越长，token 越多', () => {
  const small = M.toolsListCost([fakeTool('a', okTool.run)])
  const big = M.toolsListCost([
    { ...fakeTool('a', okTool.run), description: '描述'.repeat(200) },
    { ...fakeTool('b', okTool.run), description: '描述'.repeat(200) },
  ])
  assert(big.tokens > small.tokens * 5, `没随描述长度涨：${small.tokens} → ${big.tokens}`)
})

await test('★ 算的必须是进上下文的那份（含 description 和 schema）', () => {
  const bare = M.toolsListCost([{ ...fakeTool('a', okTool.run), description: '' }])
  const rich = M.toolsListCost([{ ...fakeTool('a', okTool.run), description: '这是一段很长的工具说明'.repeat(20) }])
  assert(
    rich.tokens > bare.tokens,
    'description 没算进去。\n' +
      '      它是模型唯一的判断依据，也是你每一轮都在付的钱——\n' +
      '      只算 name 的话这个数字对决策毫无帮助',
  )
})

await test('share 是相对预算的比例', () => {
  const c = M.toolsListCost([fakeTool('a', okTool.run)], 1000)
  assert(Math.abs(c.share - c.tokens / 1000) < 1e-9, `share 算错了：${c.share} vs ${c.tokens / 1000}`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n真管道（会 spawn 子进程）')
// ─────────────────────────────────────────────────────────────

const SERVER = fileURLToPath(new URL('./server.ts', import.meta.url))

/** 起一个 server 子进程，把一批原始行喂进去，收集 stdout / stderr。 */
function pipe(lines: string[], env: Record<string, string> = {}): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', SERVER, '--stdio'], {
      env: { ...process.env, MCP_IMPL: target === 'shared' ? 'shared' : 'mine', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => (out += c))
    child.stderr.on('data', (c: string) => (err += c))
    child.on('exit', (code) => resolve({ out, err, code }))
    for (const l of lines) child.stdin.write(l + '\n')
    child.stdin.end()
    setTimeout(() => child.kill('SIGKILL'), 25_000).unref()
  })
}

await test('★ stdout 上只有 MCP 消息，日志一律走 stderr', async () => {
  const { out, err } = await pipe([req('server/discover'), req('tools/list', {}, 2)])
  const lines = out.split('\n').filter((l) => l.trim())
  assert(lines.length >= 2, `stdout 应该有两条响应，实际 ${lines.length} 条：${out.slice(0, 200)}`)
  for (const l of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(l)
    } catch {
      throw new Error(
        `stdout 上有一行不是 JSON：${l.slice(0, 80)}\n` +
          '      一句 console.log 就能让客户端的拆帧器拿到一行人话。\n' +
          '      症状是"客户端说我的 server 不是 MCP server"——和那句 log 隔了十万八千里',
      )
    }
    assert((parsed as { jsonrpc?: string }).jsonrpc === '2.0', `不是 JSON-RPC 消息：${l.slice(0, 80)}`)
  }
  assert(err.length > 0, 'stderr 上应该有启动日志——日志不是不打，是打到 stderr')
})

await test('★ 响应靠 id 匹配，不能靠顺序', async () => {
  const { out } = await pipe([
    req('tools/call', { name: 'search_code', arguments: { pattern: 'export', max_results: 50 } }, 1),
    req('tools/list', {}, 2),
    req('server/discover', {}, 3),
  ])
  const ids = out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { id: number }).id)
  assert(ids.length === 3, `应该有 3 条响应，实际 ${ids.length}`)
  assert(new Set(ids).size === 3, `id 有重复：${ids.join(',')}`)
  // 顺序不做断言——顺序本来就不保证，断言它才是错的。
  // 这条测的是"每个请求都有且只有一条响应"，而这正是 id 匹配的前提。
})

await test('stdin 关闭之后 server 要退出（唯一可移植的优雅退出信号）', async () => {
  const { code } = await pipe([req('server/discover')])
  assert(code === 0, `退出码应该是 0，实际 ${code}。不退出的话每次重连都留一个僵尸进程`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n授权（MA-1…15）')
// ─────────────────────────────────────────────────────────────

const SA = await import('../shared/mcpauth.ts')

type AuthApi = Pick<
  typeof SA,
  | 'checkAccessToken'
  | 'buildChallenge'
  | 'parseWwwAuthenticate'
  | 'prmCandidates'
  | 'asMetadataCandidates'
  | 'validatePrm'
  | 'validateAsMetadata'
  | 'checkIssResponse'
  | 'stepUpScopes'
  | 'decideDownstreamAuth'
  | 'validateAuthUrl'
>

async function loadMineAuth(): Promise<AuthApi> {
  const m = await import('./auth.ts')
  return {
    checkAccessToken: m.myCheckAccessToken,
    parseWwwAuthenticate: m.myParseWwwAuthenticate,
    prmCandidates: m.myPrmCandidates,
    asMetadataCandidates: m.myAsMetadataCandidates,
    checkIssResponse: m.myCheckIssResponse,
    stepUpScopes: m.myStepUpScopes,
    decideDownstreamAuth: m.myDecideDownstreamAuth,
    // 这四个是 auth.ts 原样转出的参考实现，不是 TODO。
    buildChallenge: m.buildChallenge,
    validatePrm: m.validatePrm,
    validateAsMetadata: m.validateAsMetadata,
    validateAuthUrl: m.validateAuthUrl,
  }
}

const A: AuthApi = target === 'shared' ? SA : await loadMineAuth()

type AuthToken = import('../shared/mcpauth.ts').TokenView
type AuthOpts = import('../shared/mcpauth.ts').CheckOpts
type AuthResult = import('../shared/mcpauth.ts').CheckResult

const AUTH_NOW = 1_800_000_000
const AUTH_ISS = 'https://auth.example.com'
const AUTH_RES = 'https://mcp.example.com'
const AUTH_PRM = AUTH_RES + '/.well-known/oauth-protected-resource'

/** leewaySec 故意不传：默认值本身也在被测范围里。 */
function authOpts(requiredScopes: string[], extra: Partial<AuthOpts> = {}): AuthOpts {
  return { issuer: AUTH_ISS, resource: AUTH_RES, now: AUTH_NOW, requiredScopes, ...extra }
}

/** 一张各项都合法的 token；测哪一项就只覆盖哪一项。 */
function tok(claims: AuthToken['claims'] = {}, header: AuthToken['header'] = {}): AuthToken {
  return {
    header: { typ: 'at+jwt', alg: 'RS256', ...header },
    claims: { iss: AUTH_ISS, aud: AUTH_RES, exp: AUTH_NOW + 3600, scope: 'files:read', sub: 'u1', ...claims },
  }
}

function authVerdict(r: AuthResult): string {
  return r.ok ? 'ok' : `${r.status} ${r.reason}`
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const readOp = authOpts(['files:read'])

await test('★ MA-1 aud 是别的服务 → 401 WRONG_AUDIENCE', () => {
  const r = A.checkAccessToken(tok({ aud: 'https://other.example.com' }), readOp)
  assert(
    authVerdict(r) === '401 WRONG_AUDIENCE',
    `应该是 401 WRONG_AUDIENCE，实际 ${authVerdict(r)}。\n` +
      '      签名对、没过期、scope 也够——但它是发给别的服务的。\n' +
      '      收下它，任何一个拿到用户 token 的下游都能拿它回头调你（GHSA-w4fh）',
  )
})

await test('★ MA-2 aud 是 resource 加了后缀的域名 → 仍然 WRONG_AUDIENCE', () => {
  const r = A.checkAccessToken(tok({ aud: 'https://mcp.example.com.evil.io' }), readOp)
  assert(
    authVerdict(r) === '401 WRONG_AUDIENCE',
    `应该是 401 WRONG_AUDIENCE，实际 ${authVerdict(r)}。\n` +
      '      aud 是字符串时 aud.includes(resource) 是子串匹配：\n' +
      "      'https://mcp.example.com.evil.io' 包含 'https://mcp.example.com'。\n" +
      '      MA-1 过了而这条没过，正是这个 bug 活到生产的方式。先规范成数组，再逐个 ===',
  )
})

await test('MA-3 aud 是数组：含 resource → 收；空数组 → WRONG_AUDIENCE', () => {
  const ok = A.checkAccessToken(tok({ aud: ['https://a', AUTH_RES] }), readOp)
  assert(ok.ok, `aud 可以是数组（RFC 7519 §4.1.3），含 resource 就该收，实际 ${authVerdict(ok)}`)
  const empty = A.checkAccessToken(tok({ aud: [] }), readOp)
  assert(
    authVerdict(empty) === '401 WRONG_AUDIENCE',
    `aud: [] 应该是 401 WRONG_AUDIENCE，实际 ${authVerdict(empty)}。空数组不是「不限受众」`,
  )
})

await test('★ MA-4 iss 多一个尾斜杠 → WRONG_ISSUER', () => {
  const r = A.checkAccessToken(tok({ iss: AUTH_ISS + '/' }), readOp)
  assert(
    authVerdict(r) === '401 WRONG_ISSUER',
    `应该是 401 WRONG_ISSUER，实际 ${authVerdict(r)}。\n` +
      '      RFC 9068："MUST exactly match"。去尾斜杠、小写化这类「宽容」\n' +
      '      都是在替攻击者扩大一个等价类',
  )
})

await test('MA-5 typ 是 JWT（ID Token 冒充）→ WRONG_TYP；alg 是 none → ALG_NONE', () => {
  const idToken = A.checkAccessToken(tok({}, { typ: 'JWT' }), readOp)
  assert(
    authVerdict(idToken) === '401 WRONG_TYP',
    `typ: JWT 应该是 401 WRONG_TYP，实际 ${authVerdict(idToken)}。\n` +
      '      ID Token 的 typ 就是 JWT。把它当 access token 收下，\n' +
      '      等于任何一个让用户登录过的客户端都能拿登录凭证来调 API',
  )
  const none = A.checkAccessToken(tok({}, { alg: 'none' }), readOp)
  assert(
    authVerdict(none) === '401 ALG_NONE',
    `alg: none 应该是 401 ALG_NONE，实际 ${authVerdict(none)}。签名库配置宽松时会放它过去，这里是第二道闸`,
  )
  const media = A.checkAccessToken(tok({}, { typ: 'application/at+jwt' }), readOp)
  assert(media.ok, `RFC 9068 允许 typ 写成 application/at+jwt，也要收，实际 ${authVerdict(media)}`)
})

await test('★ MA-6 过期且 scope 不足 → 401 EXPIRED，不是 403', () => {
  const r = A.checkAccessToken(tok({ exp: AUTH_NOW - 3600 }), authOpts(['files:read', 'files:write']))
  assert(
    authVerdict(r) === '401 EXPIRED',
    `应该是 401 EXPIRED，实际 ${authVerdict(r)}。\n` +
      '      403 会让客户端去 step-up——弹一个授权页，让用户给一张已经过期的 token 加权限。\n' +
      '      401 只需要拿 refresh token 换一张，用户什么都看不到。所有 401 类检查必须先于 scope',
  )
  const foreign = A.checkAccessToken(tok({ aud: 'https://other.example.com', scope: '' }), authOpts(['files:write']))
  assert(
    authVerdict(foreign) === '401 WRONG_AUDIENCE',
    `别的服务的 token 且 scope 不足，应该是 401 WRONG_AUDIENCE，实际 ${authVerdict(foreign)}。\n` +
      '      回 403 等于告诉对方「token 我收了，只是权限不够」',
  )
})

await test('MA-7 leeway：exp 过了 30 秒还收、61 秒拒；不传 leewaySec 按 60 算', () => {
  const lenient = authOpts(['files:read'], { leewaySec: 60 })
  const r30 = A.checkAccessToken(tok({ exp: AUTH_NOW - 30 }), lenient)
  assert(r30.ok, `exp = now - 30、leewaySec = 60 应该收，实际 ${authVerdict(r30)}。几十秒的时钟偏差是常态`)
  const r61 = A.checkAccessToken(tok({ exp: AUTH_NOW - 61 }), lenient)
  assert(authVerdict(r61) === '401 EXPIRED', `exp = now - 61 应该是 401 EXPIRED，实际 ${authVerdict(r61)}`)
  const d30 = A.checkAccessToken(tok({ exp: AUTH_NOW - 30 }), readOp)
  assert(d30.ok, `不传 leewaySec 时默认 60：exp = now - 30 应该收，实际 ${authVerdict(d30)}`)
  const stale = A.checkAccessToken(tok({ exp: AUTH_NOW - 86_400 }), readOp)
  assert(
    authVerdict(stale) === '401 EXPIRED',
    `不传 leewaySec 时，过期一天的 token 应该是 401 EXPIRED，实际 ${authVerdict(stale)}。\n` +
      '      exp + undefined 是 NaN，now >= NaN 永远是 false——token 永不过期',
  )
  const early = A.checkAccessToken(tok({ nbf: AUTH_NOW + 30 }), readOp)
  const tooEarly = A.checkAccessToken(tok({ nbf: AUTH_NOW + 61 }), readOp)
  assert(
    early.ok && authVerdict(tooEarly) === '401 NOT_YET_VALID',
    `nbf 也给 leeway：now + 30 收、now + 61 → 401 NOT_YET_VALID；实际 ${authVerdict(early)} / ${authVerdict(tooEarly)}`,
  )
})

await test('★ MA-8 scope 不够 → 403，挑战里的 scope 是本次操作需要的全部', () => {
  const need = ['files:read', 'files:write']
  const r = A.checkAccessToken(tok({ scope: 'files:read' }), authOpts(need))
  assert(
    !r.ok && r.status === 403 && r.reason === 'INSUFFICIENT_SCOPE',
    `应该是 403 INSUFFICIENT_SCOPE，实际 ${authVerdict(r)}`,
  )
  assert(sameJson(r.missing, ['files:write']), `missing 应该是 ["files:write"]，实际 ${JSON.stringify(r.missing)}`)
  const h = A.buildChallenge(r, { resourceMetadata: AUTH_PRM, requiredScopes: need })
  // 用参考实现的解析器读：这条只测 TODO 10，不受 TODO 11 牵连。
  const bearer = SA.parseWwwAuthenticate(h).find((c) => c.scheme === 'bearer')
  assert(bearer, `挑战头里没有 Bearer：${h}`)
  assert(bearer.params['error'] === 'insufficient_scope', `error 应该是 insufficient_scope：${h}`)
  assert(
    bearer.params['scope'] === 'files:read files:write',
    `scope 应该是 "files:read files:write"（全部所需），实际 ${JSON.stringify(bearer.params['scope'])}。\n` +
      '      只报缺的那个，照着它重新授权的客户端会丢掉 files:read',
  )
  assert(bearer.params['resource_metadata'] === AUTH_PRM, `resource_metadata 不对：${h}`)
})

await test('MA-9 scope 层级：files:admin 蕴含 files:read / files:write，反过来不行', () => {
  const implies = { 'files:admin': ['files:read', 'files:write'] }
  const r = A.checkAccessToken(tok({ scope: 'files:admin' }), authOpts(['files:read', 'files:write'], { implies }))
  assert(
    r.ok,
    `"Servers MUST account for scope hierarchies"。拿着 files:admin 还要再授权一次 files:write，实际 ${authVerdict(r)}`,
  )
  const up = A.checkAccessToken(tok({ scope: 'files:read files:write' }), authOpts(['files:admin'], { implies }))
  assert(
    authVerdict(up) === '403 INSUFFICIENT_SCOPE',
    `方向反了：窄的不蕴含宽的，read + write 不等于 admin。实际 ${authVerdict(up)}`,
  )
})

await test('★ MA-10 WWW-Authenticate：多个 challenge、引号里的逗号、大小写', () => {
  const cs = A.parseWwwAuthenticate(
    'Basic realm="x", Bearer resource_metadata="https://m/.well-known/oauth-protected-resource", ' +
      'error_description="a, b", scope="files:read"',
  )
  const schemes = cs.map((c) => c.scheme)
  assert(
    sameJson(schemes, ['basic', 'bearer']),
    `应该解析出 basic、bearer 两个 challenge，实际 ${JSON.stringify(schemes)}。\n` +
      '      逗号既分隔 challenge 也分隔参数：token 后面紧跟 = 的是参数名，否则是下一个 scheme',
  )
  const b = cs[1]!
  assert(
    b.params['error_description'] === 'a, b',
    `error_description 应该是 "a, b"，实际 ${JSON.stringify(b.params['error_description'])}。split(',') 把引号里的逗号也切了`,
  )
  assert(
    b.params['resource_metadata'] === 'https://m/.well-known/oauth-protected-resource',
    `resource_metadata 没拿对（${JSON.stringify(b.params['resource_metadata'])}）。\n` +
      '      拿不到它，客户端只好去猜 well-known；PRM 不在默认位置时发现直接失败',
  )
  assert(b.params['scope'] === 'files:read', `scope 应该是 files:read，实际 ${JSON.stringify(b.params['scope'])}`)
  const loud = A.parseWwwAuthenticate('BEARER Scope="files:write"')
  assert(
    loud[0]?.scheme === 'bearer' && loud[0].params['scope'] === 'files:write',
    `auth-scheme 和参数名都不区分大小写，一律小写化。实际 ${JSON.stringify(loud)}`,
  )
  const esc = A.parseWwwAuthenticate('Bearer error_description="say \\"hi\\""')
  assert(
    esc[0]?.params['error_description'] === 'say "hi"',
    `quoted-string 里的 \\" 是字面的引号，实际 ${JSON.stringify(esc[0]?.params)}`,
  )
})

await test('MA-11 PRM 候选：resource_metadata 优先；否则路径插入 → 根；端点在根上只有一个', () => {
  const got = A.prmCandidates('https://example.com/public/mcp', [])
  const want = [
    'https://example.com/.well-known/oauth-protected-resource/public/mcp',
    'https://example.com/.well-known/oauth-protected-resource',
  ]
  assert(sameJson(got, want), `顺序是规范的一部分（"in the order listed above"），实际 ${JSON.stringify(got)}`)
  const hinted = A.prmCandidates('https://mcp.example.com/mcp', [{ scheme: 'bearer', params: { resource_metadata: AUTH_PRM } }])
  assert(sameJson(hinted, [AUTH_PRM]), `挑战里给了 resource_metadata 就只用它，实际 ${JSON.stringify(hinted)}`)
  for (const root of ['https://example.com', 'https://example.com/']) {
    const r = A.prmCandidates(root, [])
    assert(
      sameJson(r, ['https://example.com/.well-known/oauth-protected-resource']),
      `${root} 只有根这一个候选，实际 ${JSON.stringify(r)}。\n` +
        "      new URL('https://example.com').pathname 是 '/'，直接拼会多出 …/oauth-protected-resource/，去重也跟着失效",
    )
  }
})

await test('MA-12 AS 元数据候选：OAuth 插入 → OIDC 插入 → OIDC 追加；无路径只有两个', () => {
  const got = A.asMetadataCandidates('https://auth.example.com/tenant1')
  const want = [
    'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
    'https://auth.example.com/.well-known/openid-configuration/tenant1',
    'https://auth.example.com/tenant1/.well-known/openid-configuration',
  ]
  assert(
    sameJson(got, want),
    `实际 ${JSON.stringify(got)}。\n      第 3 个（路径追加）是 Keycloak realm 这类多租户 IdP 唯一发布配置的位置`,
  )
  const bare = A.asMetadataCandidates(AUTH_ISS)
  assert(
    sameJson(bare, [AUTH_ISS + '/.well-known/oauth-authorization-server', AUTH_ISS + '/.well-known/openid-configuration']),
    `issuer 没有路径时只有 OAuth、OIDC 两个，实际 ${JSON.stringify(bare)}`,
  )
})

await test('★ MA-13 AS 元数据：issuer 逐字相等、必须声明 S256；PRM：resource 逐字相等', () => {
  const s256 = { code_challenge_methods_supported: ['S256'] }
  const spoof = A.validateAsMetadata({ issuer: 'https://honest.example', ...s256 }, 'https://attacker.example')
  assert(
    !spoof.ok && spoof.reason === 'ISSUER_MISMATCH',
    `从 attacker.example 拿到的文档自称 honest.example，必须 ISSUER_MISMATCH，实际 ${JSON.stringify(spoof)}。\n` +
      '      规范原例；GHSA-qx49 就是主路径查了、回退路径漏了这一条',
  )
  const noPkce = A.validateAsMetadata({ issuer: AUTH_ISS }, AUTH_ISS)
  assert(
    !noPkce.ok && noPkce.reason === 'NO_PKCE',
    `没有 code_challenge_methods_supported 时 "MUST refuse to proceed"，实际 ${JSON.stringify(noPkce)}`,
  )
  const plain = A.validateAsMetadata({ issuer: AUTH_ISS, code_challenge_methods_supported: ['plain'] }, AUTH_ISS)
  assert(!plain.ok && plain.reason === 'NO_S256', `只有 plain 不算 PKCE 保护，应该 NO_S256，实际 ${JSON.stringify(plain)}`)
  assert(A.validateAsMetadata({ issuer: AUTH_ISS, ...s256 }, AUTH_ISS).ok, '合法的 AS 元数据要放行')
  const pub = 'https://example.com/public/mcp'
  const slash = A.validatePrm({ resource: pub + '/', authorization_servers: [AUTH_ISS] }, pub)
  assert(
    !slash.ok && slash.reason === 'RESOURCE_MISMATCH',
    `RFC 9728 §3.3：resource 不逐字相等就 "MUST NOT be used"，实际 ${JSON.stringify(slash)}`,
  )
  const empty = A.validatePrm({ resource: pub, authorization_servers: [] }, pub)
  assert(
    !empty.ok && empty.reason === 'NO_AUTH_SERVERS',
    `PRM 必须至少列一个 authorization server，实际 ${JSON.stringify(empty)}`,
  )
  const good = A.validatePrm({ resource: pub, authorization_servers: [AUTH_ISS] }, pub)
  assert(good.ok && sameJson(good.authServers, [AUTH_ISS]), `合法的 PRM 要放行，实际 ${JSON.stringify(good)}`)
})

await test('MA-14 授权响应的 iss：四行真值表，一律逐字比较', () => {
  const rec = 'https://as.example.com'
  const rows: [boolean | undefined, string | undefined, 'proceed' | 'reject'][] = [
    [true, rec, 'proceed'],
    [true, rec + '/', 'reject'],
    [true, undefined, 'reject'],
    [false, rec, 'proceed'],
    [false, 'https://evil.example', 'reject'],
    [false, undefined, 'proceed'],
    [undefined, rec, 'proceed'],
    [undefined, undefined, 'proceed'],
  ]
  for (const [supportsIss, iss, want] of rows) {
    const got = A.checkIssResponse({ supportsIss, iss, recorded: rec })
    assert(got === want, `supportsIss=${supportsIss}、iss=${iss ?? '（没有）'} 应该 ${want}，实际 ${got}`)
  }
  const folded = A.checkIssResponse({ supportsIss: true, iss: 'https://AS.example.com', recorded: rec })
  assert(
    folded === 'reject',
    `iss 'https://AS.example.com' 对记录的 '${rec}' 应该 reject，实际 ${folded}。\n` +
      '      "MUST NOT apply scheme or host case folding"——「先小写化再比更健壮」恰好造出了一个可被利用的等价类',
  )
})

await test('★ MA-15 step-up 取并集；下游不许透传；授权 URL 走白名单', () => {
  const up = A.stepUpScopes(['files:read'], ['files:write'])
  assert(
    sameJson(up, ['files:read', 'files:write']),
    `应该是 ["files:read","files:write"]（并集），实际 ${JSON.stringify(up)}。\n` +
      '      直接换成挑战里的 scope：拿到写权限、丢了读权限，下一次列目录又是 403、又一个授权页',
  )
  const dedup = A.stepUpScopes(['files:write', 'files:read'], ['files:read'])
  assert(sameJson(dedup, ['files:read', 'files:write']), `要去重、按码点排序，实际 ${JSON.stringify(dedup)}`)

  const api = 'https://api.example.com'
  const base = { inboundRaw: 'tok-in', outboundRaw: 'tok-out', self: AUTH_RES, downstream: api }
  const echoed = A.decideDownstreamAuth({ ...base, outboundRaw: 'tok-in', outboundAud: AUTH_RES })
  assert(echoed === 'PASSTHROUGH', `把收到的 token 原样发给下游应该是 PASSTHROUGH，实际 ${echoed}。"MUST NOT pass through"`)
  const resigned = A.decideDownstreamAuth({ ...base, outboundAud: [AUTH_RES, api] })
  assert(
    resigned === 'PASSTHROUGH',
    `出站 token 的 aud 里还有自己，也是透传——下游拿着它能回头调你。实际 ${resigned}`,
  )
  const stray = A.decideDownstreamAuth({ ...base, outboundAud: 'https://other.example.com' })
  assert(stray === 'WRONG_AUDIENCE', `出站 token 的 aud 里没有这个下游，应该是 WRONG_AUDIENCE，实际 ${stray}`)
  const fine = A.decideDownstreamAuth({ ...base, outboundAud: api })
  assert(fine === 'OK', `换来的、aud 恰好是下游的 token 应该放行，实际 ${fine}`)

  const urls: [string, string][] = [
    ['file:/c:/windows/system32/calc.exe', 'BAD_SCHEME'],
    ['http://auth.example.com/authorize', 'HTTP_NOT_LOOPBACK'],
    ['http://127.0.0.1@evil.example/authorize', 'HTTP_NOT_LOOPBACK'],
    ['http://127.0.0.1:8123/authorize', 'ok'],
    ['https://auth.example.com/authorize', 'ok'],
  ]
  for (const [url, want] of urls) {
    const v = A.validateAuthUrl(url)
    const got = v.ok ? 'ok' : v.reason
    assert(
      got === want,
      `${url} 应该是 ${want}，实际 ${got}。\n` +
        '      授权 URL 来自可能恶意的 server：只许 https 或 loopback 的 http（CVE-2025-6514）',
    )
  }
})

// ─────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60))
if (failures.length === 0) {
  console.log(`\x1b[32m全过。${passed} 项。\x1b[0m`)
  console.log('\n接着跑 MCP_IMPL=mine pnpm mcp:client —— 用你自己的 server 走一遍真管道。')
} else {
  console.log(`\x1b[31m${failures.length} 项没过（过了 ${passed} 项）：\x1b[0m`)
  for (const f of failures) console.log(`\x1b[31m  · ${f}\x1b[0m`)
  console.log('\n先跑 VERIFY_TARGET=shared pnpm verify:l10 对照参考实现。')
  process.exitCode = 1
}
