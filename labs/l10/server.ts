/**
 * L10 任务一：手写一个 MCP server。
 *
 *   pnpm mcp:server            跑观察实验（进程内，不 spawn）
 *   pnpm mcp:server --stdio    真的作为 stdio server 跑起来（给 client 用）
 *
 * 不调 API。参考实现在 shared/mcp.ts。
 *
 * ★ 这一节和前面九节最大的不同：**这里没有模型。**
 *
 * MCP 是 JSON-RPC 2.0 加一层约定，加起来不到 400 行，没有一行涉及推理。
 * 而它是这门课里你最可能在真实工作中被要求实现的东西——因为它是
 * "把已有能力接进 agent"这个需求的标准答案。
 *
 * 值得先想清楚的是：**协议的价值不在设计得多好，在说这话的人有多少。**
 * MCP 的技术含量约等于零。它值钱是因为 Cursor、Claude Code、
 * 和一堆别的宿主都认它——所以你写一次 server，所有宿主都能用。
 */

import { isMain } from '../shared/entry.ts'
import { standardTools } from '../shared/toolbox.ts'
import type { ToolDef } from '../shared/tools.ts'
// 协议常量都从 shared/mcp.ts 拿——**错误码不该在两个地方各写一份**。
// 写重的后果是有一天你在一处改了 -32002 → -32602，另一处没改，
// 而两边不一致的表现是"某些错误客户端不认"，不是编译失败。
import {
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_PARSE,
  ERR_UNSUPPORTED_VERSION,
  META_CLIENT_CAPS,
  META_CLIENT_INFO,
  META_SERVER_INFO,
  META_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  serveStdio as sharedServeStdio,
  wrapToolDef,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpServer,
  type McpTool,
} from '../shared/mcp.ts'

// ─────────────────────────────────────────────────────────────
// TODO 1：NDJSON 拆帧
//
// ★ 这是所有子进程 / socket 通信的第一个坑，而且是**必踩**的那种：
// 一次 read 拿到的既不保证是一条完整消息，也不保证只有一条。
// 管道只承诺字节顺序，不承诺消息边界。
//
// 本地跑的时候消息小、来得慢，几乎每次 read 都恰好是一整行，
// 于是"不拆帧"的代码看起来是对的。等到某个工具返回了 80KB 的文件内容，
// 它被切成十几个 chunk 送过来——这时候才炸，而且是在生产环境。
//
// 做法：缓冲，按 \n 切，**最后一段留着**（它是没写完的尾巴）。
//
// ★ 还要有一个长度上限。对面要是永远不发 \n（崩在半路、或者根本
// 不是 MCP server），缓冲区会一直涨到进程 OOM——而 OOM 的现场
// 没有任何信息指向"对面没换行"这个原因。
//
// L02 那个 SSE 读取器是同一个问题换了个壳。协议不同，坑一模一样。
// ─────────────────────────────────────────────────────────────

export interface Framer {
  push(chunk: string): string[]
  readonly buffered: number
}

export function createFramer(maxLineChars = 8 * 1024 * 1024): Framer {
  void maxLineChars
  throw new Error('TODO: 实现 createFramer')
}

// ─────────────────────────────────────────────────────────────
// TODO 2：请求校验（2026-07-28 的核心变化在这里）
//
// 老版本（2025 和更早）的 MCP 有一次 initialize 握手：客户端报版本和
// 能力，服务端记在**这条连接的内存里**，后续请求不用再带。
//
// 2026-07-28 把它删了。每个请求自带 protocolVersion 和 clientCapabilities，
// 放在 params._meta 里。
//
// ★ 为什么值得这么改：有会话的时候，同一个客户端的请求必须落到
// 同一个服务端进程上——因为握手结果只在那个进程里。这意味着粘性会话、
// 共享存储、或者干脆单实例。无状态之后，任何请求可以落到轮询负载均衡
// 后面的任何一台机器，而且响应可以被缓存。
//
// 这笔交易在 HTTP 的世界里已经做过一次了（cookie session → JWT）：
// **用每个请求多几十字节，换掉整套会话基础设施。**
//
// 要校验的东西（顺序有讲究，先能读出 id 才能把错误回给对方）：
//   · jsonrpc === "2.0"
//   · method 是非空字符串
//   · id 可以缺席（那是**通知**），但不能是 null
//   · 有 id 的请求：_meta[META_VERSION] 必填，且在 SUPPORTED_VERSIONS 里
//   · 有 id 的请求：_meta[META_CLIENT_CAPS] 必填，且是对象
//
// 版本不匹配要回 ERR_UNSUPPORTED_VERSION（-32022），而且
// **data 里要带 supported 列表**。少了它，客户端只能猜或者放弃；
// 有了它，"版本不匹配"从一个死胡同变成一次自动重试。
//
// ★ 缺字段回 ERR_INVALID_PARAMS（-32602）。注意不是 -32002——
// 那是老版本的码，2026-07-28 已经废掉了。照旧教程写 -32002 判断的代码
// 在新 server 上不会报错，会**静默走进 else 分支**。
// ─────────────────────────────────────────────────────────────

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export type Validated =
  | { ok: true; req: JsonRpcRequest }
  | { ok: false; id: string | number | null; error: JsonRpcError }

export function validateRequest(raw: string): Validated {
  void raw
  throw new Error('TODO: 实现 validateRequest')
}

// ─────────────────────────────────────────────────────────────
// TODO 3：把 L04 的工具包成 MCP 工具
//
// 这是这一节的交付物：**你从 L04 开始攒的那套工具，现在要能被
// 任何 MCP 宿主用。** Cursor、Claude Code、别人写的 agent，都行。
//
// L04 的 ToolDef 是：{ name, description, inputSchema, parse, run }
// MCP 的 McpTool 是：{ name, description, inputSchema, run }
//
// 三件事：
//
//   一 · parse 失败要变成 **isError: true 的结果**，不是协议错误。
//        参数格式不对是模型能自己改的——这正是 L04 那条
//        "失败回结果，不抛异常"，而 MCP 把它变成了规范要求。
//
//   二 · run 返回的 isError 原样透传。
//
//   三 · ★ **logNote 不能进 content。**
//        L04 里 logNote 是"你要知道但模型不需要知道"的信息，
//        比如「拒绝了一次越界访问 ../../etc/passwd」。
//        把它回给模型，等于把沙箱的边界告诉了可能正在探边界的那一方。
//        这个泄露在 L14 会展开——现在只要记住这个字段的去向是日志，不是响应。
// ─────────────────────────────────────────────────────────────

export function wrapTool(def: ToolDef<never>): McpTool {
  void def
  throw new Error('TODO: 实现 wrapTool')
}

export function buildServer(root: string, wrap: (d: ToolDef<never>) => McpTool = wrapTool): McpServer {
  return { name: 'labs-toolbox', version: '0.1.0', tools: standardTools(root).map(wrap) }
}

// ─────────────────────────────────────────────────────────────
// TODO 4：路由
//
// 三个方法就够跑通一条完整链路：
//
//   server/discover  我是谁、能说哪些版本、有什么能力
//   tools/list       我有哪些工具
//   tools/call       调一个（见 TODO 5）
//
// resources 和 prompts 的形状一模一样（list + read / list + get），
// 补上去是机械劳动。它们和 tools 的区别不在协议，在**谁来决定用不用**：
//
//   tools      模型控制   模型自己决定调不调
//   resources  应用控制   宿主决定塞哪些进上下文（Cursor 的 @file）
//   prompts    用户控制   用户从菜单里选（Cursor 的斜杠命令）
//
// ★ 这个三分法是理解 MCP 的钥匙。只用 tools 的人会觉得
// "MCP 不就是给工具套了层 HTTP 吗"——是的，如果你只用三分之一的话。
//
// 两个细节：
//
//   · **通知（没有 id）处理完不回响应。** 回了的话客户端会收到一个
//     它没发过的 id，严格的实现会直接断连。
//
//   · **tools/list 的顺序必须确定。** 规范里这是 SHOULD，理由很实在：
//     工具列表进的是 system prompt 的**前缀**，顺序一抖前缀缓存整体失效。
//     一个 `[...map.values()]` 的偶然顺序能让缓存命中率归零，
//     而账单上只会显示"input token 变贵了"。
// ─────────────────────────────────────────────────────────────

/** 通知返回 null。 */
export type Handled = JsonRpcResponse | null

export async function routeRequest(server: McpServer, req: JsonRpcRequest): Promise<Handled> {
  void server
  void req
  throw new Error('TODO: 实现 routeRequest')
}

// ─────────────────────────────────────────────────────────────
// TODO 5：tools/call —— 两种错误
//
// ★ 这是整节课最该记住的地方：**MCP 有两种错误，走两条不同的通道。**
//
//   协议错误 → JSON-RPC 的 error 字段
//     工具名不存在、arguments 不是对象、服务端自己崩了
//     判据：**模型改一改参数也没用。**
//
//   工具执行错误 → 正常的 result，带 isError: true
//     文件不存在、日期格式不对、余额不足
//     判据：**模型看到这句话有可能自己改对。**
//
// 规范里客户端 SHOULD 把 isError 的内容喂给模型，而协议错误通常
// 只记日志、不进上下文。所以搞反的后果是不对称的：
//
//   该 isError 的写成协议错误 → 模型看不到失败原因，重试同一个错参数
//   该协议错误的写成 isError → 模型看到"没有这个工具"，接着编下一个工具名
//
// ★ 还有第三种情况：**工具 run 抛异常。** 那是你的 bug，不是模型的。
// 抓住它回 ERR_INTERNAL（协议错误）。把它也变成 isError 的话，
// 模型会拿着一个永远不会成功的调用重试到步数上限，
// 而你的日志里只有一堆看起来像"模型没试对"的 isError。
// ─────────────────────────────────────────────────────────────

export async function callTool(
  server: McpServer,
  id: string | number,
  params: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  void server
  void id
  void params
  throw new Error('TODO: 实现 callTool')
}

// ─────────────────────────────────────────────────────────────
// TODO 6：上下文税
//
// 量一下一份工具清单进上下文要多少 token。
//
// ★ 为什么这个函数值得单独存在：**MCP 的成本是隐形的。**
//
// 你在配置文件里加一行 server，多出来的几千 token 不出现在任何界面上，
// 只会让每一轮的 input 变多一点。而"每轮都贵一点"在账单上看起来像
// "用量涨了"，不像"我上个月加了个 server"。
//
// 真实量级（2026 年的实测数据）：
//   GitHub 官方 server 一家 27 个工具约 18k token
//   接七个常见 server 约 67k token，占 200k 窗口的 33%
//   ——**在用户打第一个字之前。**
//
// 而且成本只是一半。另一半是**准确率**：可选工具超过 30~50 个之后，
// 模型选错工具的概率明显上升。这两个问题的方向相反——
// 加 server 让能力变强，但让每一次选择变差。
//
// 算的时候按**真正上线的形状**算：客户端把 tools/list 的结果
// 原样塞进请求，所以算的是 name + description + inputSchema 的 JSON。
// 用 shared/context.ts 的 estimateTokens。
// ─────────────────────────────────────────────────────────────

export interface ToolsCost {
  tools: number
  tokens: number
  /** 占预算的比例，0~1。 */
  share: number
}

export function toolsListCost(tools: McpTool[], budgetTokens = 200_000): ToolsCost {
  void tools
  void budgetTokens
  throw new Error('TODO: 实现 toolsListCost')
}

// ─────────────────────────────────────────────────────────────
// TODO 7：stdio 主循环
//
// ★ 这个传输只有一条规矩，但它是 MCP server 的头号 bug：
//
//     **stdout 就是电线。往它写任何一个非 MCP 消息的字节，连接就废了。**
//
// 一句 `console.log('server started')` 会让客户端的拆帧器拿到
// 一行 `server started`，JSON.parse 失败。症状是"客户端说我的 server
// 不是 MCP server"，而原因和症状隔了十万八千里。
//
// 更阴的是**依赖库里的 log**——你自己没打，但某个 SDK 在初始化时打了
// 一行 deprecation warning。同样的结果，而且你的代码里搜不到。
//
// 所以：日志一律 stderr。规范明确说了客户端不该把 stderr 当错误信号。
//
// 另外三个细节：
//
//   · stdin.setEncoding('utf8') 不是省事，是**正确性**。不设的话拿到
//     Buffer，而 `buf.toString()` 会在多字节字符被切开的地方产生
//     替换字符（U+FFFD）。中文、emoji 都会中招，而且只在"这个字符
//     恰好跨了 chunk 边界"时出现——一个跟数据长度有关的随机 bug。
//
//   · **不要 await 每个请求。** 一个慢工具不该挡住后面的。
//     这也正是为什么响应必须靠 id 匹配而不能靠顺序。
//
//   · **一次 write 写一整行。** 分两次写（先 body 再 '\n'）在并发下会
//     交错，产出两行都不合法的 JSON。
//
//   · 校验失败也要回响应——除非连 id 都读不出来。静默丢弃的后果是
//     客户端那边挂着一个永远不 resolve 的 Promise。
// ─────────────────────────────────────────────────────────────

export interface StdioStreams {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

export async function runStdio(server: McpServer, io: StdioStreams): Promise<void> {
  void server
  void io
  throw new Error('TODO: 实现 runStdio')
}

// ─────────────────────────────────────────────────────────────
// TODO 8（没有代码）：把 routeRequest 里 tools/list 的排序去掉
//
// 然后连续跑十次，把每次的工具名顺序打出来。
//
// 在这个只有三个工具、且来自一个数组的例子里，顺序大概率是稳的——
// 这正是这个 bug 危险的地方。它在你换成 Map、换成从数据库读、
// 或者换成并发注册的那一天才开始抖。
//
// 想清楚这个问题：**你会怎么发现前缀缓存失效了？**
// （提示：DeepSeek 的 usage 里有 prompt_cache_hit_tokens。L02 讲过。）
//
// ─────────────────────────────────────────────────────────────
// TODO 9（没有代码）：在 runStdio 里加一句 console.log
//
// 加在 server 启动那一行的位置，然后跑 `pnpm mcp:client`。
//
// 看客户端报什么错，以及**那个错离真正的原因有多远**。
// 然后把它改成 console.error，再跑一次。
//
// 这是这一节唯一一个你一定会在真实项目里再遇到一次的 bug。
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 观察实验
// ─────────────────────────────────────────────────────────────

const ROOT = new URL('..', import.meta.url).pathname

function meta(version = PROTOCOL_VERSION): Record<string, unknown> {
  return {
    [META_VERSION]: version,
    [META_CLIENT_INFO]: { name: 'demo', version: '0' },
    [META_CLIENT_CAPS]: {},
  }
}

function line(method: string, params: Record<string, unknown> = {}, id: number | undefined = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params })
}

async function demoRoundTrip() {
  console.log('\n【一】一次完整的往返：请求进去，响应出来')

  const server = buildServer(ROOT)
  const raw = line('tools/list', { _meta: meta() })
  console.log(`  → ${raw.slice(0, 96)}…`)

  const v = validateRequest(raw)
  if (!v.ok) throw new Error('校验居然没过')
  const resp = await routeRequest(server, v.req)
  if (resp === null || 'error' in resp) throw new Error(`tools/list 应该成功：${JSON.stringify(resp)}`)
  const tools = resp.result.tools as { name: string }[]

  console.log(`  ← 200 OK，${tools.length} 个工具：${tools.map((t) => t.name).join('、')}`)
  console.log(`     serverInfo：${JSON.stringify(resp.result._meta)}`)
  console.log('\n  ★ 就这些。没有模型，没有 embedding，没有魔法——')
  console.log('  JSON-RPC 2.0 加一层命名约定。MCP 的技术含量约等于零，')
  console.log('  而它值钱是因为**说这话的人足够多**。')
}

function demoFraming() {
  console.log('\n【二】拆帧：管道不承诺消息边界')

  const a = line('tools/list', { _meta: meta() }, 1)
  const b = line('server/discover', { _meta: meta() }, 2)
  const wire = a + '\n' + b + '\n'

  // 模拟一次真实的分片：按 17 字节切，模拟 read 的任意边界。
  const framer = createFramer()
  const got: string[] = []
  const sizes: number[] = []
  for (let i = 0; i < wire.length; i += 17) {
    const chunk = wire.slice(i, i + 17)
    const lines = framer.push(chunk)
    sizes.push(lines.length)
    got.push(...lines)
  }

  console.log(`  两条消息共 ${wire.length} 字节，按 17 字节一片喂进去（${sizes.length} 片）`)
  console.log(`  每片吐出的完整消息数：${sizes.join('')}`)
  console.log(`  最终拿到 ${got.length} 条完整消息，缓冲区剩 ${framer.buffered} 字节`)
  console.log('\n  ★ 注意那串 0：绝大多数片什么都吐不出来。')
  console.log('  不拆帧的代码在本地"能跑"，是因为本地消息小、来得慢，')
  console.log('  每次 read 恰好是一整行。等到某个工具返回 80KB 才炸。')
}

async function demoMetaValidation() {
  console.log('\n【三】_meta 校验：2026-07-28 把握手换成了每请求自带')

  const cases: [string, string][] = [
    ['缺 protocolVersion', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [META_CLIENT_CAPS]: {} } } })],
    ['缺 clientCapabilities', line('tools/list', { _meta: { [META_VERSION]: PROTOCOL_VERSION } })],
    ['版本是 2025 年的', line('tools/list', { _meta: meta('2025-06-18') })],
    ['id 是 null', JSON.stringify({ jsonrpc: '2.0', id: null, method: 'tools/list', params: { _meta: meta() } })],
    ['根本不是 JSON', 'server started on port 3000'],
    ['合法请求', line('tools/list', { _meta: meta() })],
  ]

  for (const [label, raw] of cases) {
    const v = validateRequest(raw)
    if (v.ok) {
      console.log(`  ${label.padEnd(22)} → 通过`)
    } else {
      const extra = v.error.data ? `  data=${JSON.stringify(v.error.data)}` : ''
      console.log(`  ${label.padEnd(22)} → ${v.error.code}  ${v.error.message}${extra}`)
    }
  }

  console.log('\n  ★ 看第三条的 data。带上 supported 列表，客户端能自动降版本重试；')
  console.log('  不带的话它只能报错给用户，而用户不知道该怎么办。')
  console.log('  ★ 看最后一条前面那个"根本不是 JSON"——那就是 stdout 被污染时的样子。')
}

async function demoTwoErrors() {
  console.log('\n【四】两种错误：判据是"模型改一改还有救吗"')

  const server = buildServer(ROOT)
  const cases: [string, Record<string, unknown>][] = [
    ['读一个不存在的文件', { name: 'read_file', arguments: { path: 'nope/missing.ts' } }],
    ['参数类型不对', { name: 'read_file', arguments: { path: 123 } }],
    ['正则语法错误', { name: 'search_code', arguments: { pattern: '([unclosed' } }],
    ['工具名不存在', { name: 'read_fille', arguments: { path: 'x' } }],
    ['arguments 不是对象', { name: 'read_file', arguments: ['x'] }],
  ]

  for (const [label, params] of cases) {
    const resp = await callTool(server, 1, params)
    if ('error' in resp) {
      console.log(`  ${label.padEnd(18)} 协议错误  ${resp.error.code}  ${resp.error.message.slice(0, 44)}`)
    } else {
      const r = resp.result as { isError: boolean; content: { text: string }[] }
      const text = (r.content[0]?.text ?? '').replace(/\n/g, ' ').slice(0, 44)
      console.log(`  ${label.padEnd(18)} 执行错误  isError=${r.isError}  ${text}`)
    }
  }

  console.log('\n  ★ 前三条是模型能自己改对的，所以它们进 result，会被喂回模型。')
  console.log('  后两条是客户端和服务端对不齐，模型改参数也没用，所以进 error。')
  console.log('\n  搞反的后果不对称：')
  console.log('    该 isError 的写成协议错误 → 模型看不见原因，重试同一个错参数')
  console.log('    该协议错的写成 isError   → 模型看到"没这个工具"，接着编下一个')
}

function demoContextTax() {
  console.log('\n【五】上下文税：加一行配置，每轮多付多少')

  const server = buildServer(ROOT)
  const one = toolsListCost(server.tools)

  console.log(`  我们这个 server：${one.tools} 个工具，${one.tokens} token，占 200k 窗口的 ${(one.share * 100).toFixed(2)}%`)
  console.log('\n  按真实数据外推（2026 年社区实测）：')
  console.log('    server 数   工具数   token     占 200k')
  console.log('    ─────────  ──────  ────────  ────────')
  const rows: [number, number, number][] = [
    [1, 3, one.tokens],
    [1, 27, 18_000],
    [5, 100, 55_000],
    [7, 140, 67_300],
  ]
  for (const [servers, tools, tokens] of rows) {
    const share = ((tokens / 200_000) * 100).toFixed(1)
    console.log(`    ${String(servers).padStart(6)}   ${String(tools).padStart(6)}   ${String(tokens).padStart(7)}   ${share.padStart(6)}%`)
  }

  console.log('\n  最后一行：**在用户打第一个字之前，三分之一的窗口已经没了。**')
  console.log('  而且这笔钱每一轮都付一次——L06 说的"上下文是稀缺资源"，这是它最贵的一种用法。')
  console.log('\n  ★ 成本只是一半。另一半是准确率：可选工具超过 30~50 个之后，')
  console.log('  模型选错工具的概率明显上升。两个问题方向相反——')
  console.log('  加 server 让能力变强，但让每一次选择变差。')
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

/**
 * --stdio 模式：真的作为 MCP server 跑起来，给 l10/client.ts spawn。
 *
 * MCP_IMPL=shared（默认）用参考实现，这样你还没写完 server.ts 时
 * client 那边的实验照样能跑。写完之后用 MCP_IMPL=mine 换成你自己的。
 */
async function main() {
  if (process.argv.includes('--stdio')) {
    const mine = process.env.MCP_IMPL === 'mine'
    const server = buildServer(ROOT, mine ? wrapTool : wrapToolDef)

    // TODO 9 用：把这个环境变量打开，看一行 stdout 日志怎么废掉整条连接。
    if (process.env.MCP_POLLUTE_STDOUT === '1') {
      console.log(`[${server.name}] started, ${server.tools.length} tools ready`)
    }

    const io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }
    if (mine) await runStdio(server, io)
    else await sharedServeStdio(server, io)
    return
  }

  console.log('═'.repeat(64))
  console.log('L10 · MCP server：JSON-RPC 2.0 加一层约定')
  console.log('═'.repeat(64))

  await demoRoundTrip()
  demoFraming()
  await demoMetaValidation()
  await demoTwoErrors()
  demoContextTax()

  console.log('\n' + '─'.repeat(64))
  console.log('接下来跑 pnpm mcp:client —— 那边会真的 spawn 一个子进程，')
  console.log('走真的 stdin/stdout，并且演示三种只在真管道上才出现的故障。')
  console.log('─'.repeat(64) + '\n')
}

// verify.ts 和 client.ts 都会 import 这个文件。不加这道判断的话，
// import 的那一刻观察实验就跑起来了——而在 --stdio 模式下，
// **那些 console.log 会直接写进协议流**，把连接废掉。
if (isMain(import.meta.url)) await main()
