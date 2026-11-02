/**
 * 参考实现：MCP 协议层（2026-07-28）。
 *
 * 这个文件里没有任何"AI"。它是 JSON-RPC 2.0 + 一层约定，加起来不到 400 行。
 *
 * ★ 这本身就是这一节最重要的观察：**MCP 的价值不在技术含量，在它是同一份约定。**
 * 一个协议的意义等于说这话的人数量，跟它设计得多巧妙关系不大。
 *
 * 关于版本：2026-07-28 这一版把协议改成了**无状态**——没有 initialize
 * 握手，没有 Mcp-Session-Id。每个请求自带协议版本和能力声明。
 * 你在网上搜到的绝大多数 MCP 教程写的是 2025 年那套有会话的模型，
 * 照着写会得到一个连不上新客户端的 server。
 */

import { estimateTokens } from './context.ts'
import type { ToolDef } from './tools.ts'

// ─────────────────────────────────────────────────────────────
// 协议常量
// ─────────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = '2026-07-28'

/**
 * 只用于报错时告诉对方"我还能说哪些版本"。
 *
 * 这个列表本身是个教学点：**协议版本是日期，不是 semver。** 没有
 * "兼容小版本"这回事——两个日期要么一样，要么不一样。
 */
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION]

/**
 * _meta 的保留键。前缀 `io.modelcontextprotocol/` 是规范保留的，
 * 你自己的扩展要用反向域名（`com.yourco/`）。
 *
 * 为什么是这种又长又难打的键名：_meta 是一个**共享命名空间**，
 * 客户端、服务端、和任意多个扩展都往里塞东西。没有前缀的话，
 * 两个扩展抢同一个 `traceId` 是迟早的事——而冲突的表现是
 * "另一个扩展的功能偶尔失灵"，没人会想到是键名撞了。
 */
export const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities'
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

/**
 * 错误码。前五个是 JSON-RPC 2.0 标准的，后面是 MCP 在
 * -32020~-32099 这段里定义的。
 *
 * ★ 注意 -32002 不在这里。它是老版本的"资源不存在"，
 * 2026-07-28 把它换成了 -32602。你要是照着旧教程写了 -32002 的判断，
 * 新 server 上来就不匹配——**而不匹配的表现是走进 else 分支，不是抛错。**
 */
export const ERR_PARSE = -32700
export const ERR_INVALID_REQUEST = -32600
export const ERR_METHOD_NOT_FOUND = -32601
export const ERR_INVALID_PARAMS = -32602
export const ERR_INTERNAL = -32603
export const ERR_MISSING_CAPABILITY = -32021
export const ERR_UNSUPPORTED_VERSION = -32022

// ─────────────────────────────────────────────────────────────
// 消息类型
// ─────────────────────────────────────────────────────────────

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  /** 通知没有 id。**有没有 id 决定了要不要回响应**，这是 JSON-RPC 唯一的分流点。 */
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcOk {
  jsonrpc: '2.0'
  id: string | number
  result: Record<string, unknown>
}

export interface JsonRpcFail {
  jsonrpc: '2.0'
  /** 解析失败时读不到 id，只能填 null。 */
  id: string | number | null
  error: JsonRpcError
}

export type JsonRpcResponse = JsonRpcOk | JsonRpcFail

export function isFail(r: JsonRpcResponse): r is JsonRpcFail {
  return 'error' in r
}

// ─────────────────────────────────────────────────────────────
// 一、拆帧：NDJSON
// ─────────────────────────────────────────────────────────────

/**
 * 编码一条消息。
 *
 * 规范要求消息之间用换行分隔，且**消息内不能有内嵌换行**。
 * 这一条看起来需要额外处理，其实 `JSON.stringify` 已经保证了：
 * 字符串里的换行会被转义成 `\n` 两个字符。
 *
 * ★ 但知道"为什么不用处理"和"不知道有这回事"是两件事。
 * 换一个序列化器（比如带缩进的 `JSON.stringify(x, null, 2)`）就立刻破功——
 * 而它的表现是对方收到半条 JSON，报的错是 "Unexpected end of JSON input"，
 * 跟"我加了缩进"这个原因隔了三层。
 */
export function encodeMessage(msg: unknown): string {
  const line = JSON.stringify(msg)
  if (line.includes('\n')) throw new Error('消息里有内嵌换行，会破坏 NDJSON 拆帧')
  return line + '\n'
}

export interface Framer {
  /** 喂一段（可能不完整的）文本，取出其中完整的行。 */
  push(chunk: string): string[]
  /** 还压在缓冲里没成行的字节数。用来做背压和诊断。 */
  readonly buffered: number
}

/**
 * NDJSON 拆帧器。
 *
 * ★ 这是所有子进程 / socket 通信的第一个坑，而且是**必踩**的那种：
 * 一次 read 拿到的既不保证是一条完整消息，也不保证只有一条。
 * 管道只承诺字节顺序，不承诺边界。
 *
 * 本地跑的时候消息小、来得慢，几乎每次 read 都恰好是一条完整的行，
 * 于是不拆帧的代码"能跑"。等到某个工具返回了 80KB 的文件内容，
 * 它被切成十几个 chunk 送过来——这时候才炸。
 *
 * 所以：**缓冲，按 \n 切，最后一段留着。**
 *
 * （L02 的 SSE 读取器是同一个问题的另一个壳。协议不同，坑一模一样。）
 */
export function createFramer(maxLineChars = 8 * 1024 * 1024): Framer {
  let buf = ''
  return {
    push(chunk: string): string[] {
      buf += chunk
      // ★ 上限不是可选项。对面要是永远不发 \n（崩在半路、或者根本不是
      // MCP server），buf 会一直涨到进程 OOM。而 OOM 的现场没有任何
      // 信息指向"对面没换行"这个原因。
      if (buf.length > maxLineChars) {
        buf = ''
        throw new Error(`单条消息超过 ${maxLineChars} 字符还没遇到换行，对面大概率不是 MCP server`)
      }
      const parts = buf.split('\n')
      // 最后一段是没写完的尾巴（如果 chunk 恰好以 \n 结尾，它是空串）。
      buf = parts.pop() ?? ''
      return parts.filter((l) => l.trim() !== '')
    },
    get buffered() {
      return buf.length
    },
  }
}

// ─────────────────────────────────────────────────────────────
// 二、请求校验
// ─────────────────────────────────────────────────────────────

export type Validated =
  | { ok: true; req: JsonRpcRequest }
  | { ok: false; id: string | number | null; error: JsonRpcError }

/**
 * 把一行原始文本校验成一个请求。
 *
 * 2026-07-28 的核心变化在这里：**每个请求都必须自带协议版本和
 * 客户端能力声明**，因为服务端不再有"上一个请求"可以参考。
 *
 * 为什么值得这么改：有会话的时候，同一个客户端的请求必须落到
 * 同一个服务端进程上——因为握手结果只在那个进程的内存里。这意味着
 * 粘性会话、共享存储、或者干脆单实例。无状态之后，任何一个请求可以
 * 落到轮询负载均衡后面的任何一台机器。
 *
 * ★ 代价是每个请求都要重复带这几十字节。这是一笔**用带宽换运维**的交易，
 * 而在 HTTP 的世界里这笔交易已经被做过一次了（cookie session → JWT）。
 */
export function validateRequest(raw: string): Validated {
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch (err) {
    return { ok: false, id: null, error: { code: ERR_PARSE, message: `JSON 解析失败：${(err as Error).message}` } }
  }

  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    return { ok: false, id: null, error: { code: ERR_INVALID_REQUEST, message: '消息必须是一个 JSON 对象' } }
  }

  const m = msg as Record<string, unknown>
  const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null

  if (m.jsonrpc !== '2.0') {
    return { ok: false, id, error: { code: ERR_INVALID_REQUEST, message: `jsonrpc 必须是 "2.0"，收到 ${JSON.stringify(m.jsonrpc)}` } }
  }
  if (typeof m.method !== 'string' || m.method === '') {
    return { ok: false, id, error: { code: ERR_INVALID_REQUEST, message: 'method 必须是非空字符串' } }
  }
  // ★ id 可以缺席（那是通知），但**不能是 null**。JSON-RPC 2.0 允许 null，
  // MCP 明确禁止——因为 null 没法和"通知"区分开。
  if ('id' in m && m.id === null) {
    return { ok: false, id: null, error: { code: ERR_INVALID_REQUEST, message: 'id 不能是 null（通知请直接省略 id）' } }
  }

  const params = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Record<string, unknown>
  const meta = (typeof params._meta === 'object' && params._meta !== null ? params._meta : {}) as Record<string, unknown>

  // 通知不带 _meta 也行——它没有响应，谈不上版本协商。
  const isNotification = !('id' in m)
  if (!isNotification) {
    const version = meta[META_VERSION]
    if (typeof version !== 'string') {
      return {
        ok: false,
        id,
        error: { code: ERR_INVALID_PARAMS, message: `缺少必填的 _meta["${META_VERSION}"]` },
      }
    }
    if (!SUPPORTED_VERSIONS.includes(version)) {
      return {
        ok: false,
        id,
        error: {
          code: ERR_UNSUPPORTED_VERSION,
          message: `不支持的协议版本 ${version}`,
          // ★ 报错要带 supported 列表。少了它，客户端只能猜或者放弃——
          // 而这个列表让"版本不匹配"从一个死胡同变成一次自动重试。
          data: { supported: SUPPORTED_VERSIONS, requested: version },
        },
      }
    }
    if (typeof meta[META_CLIENT_CAPS] !== 'object' || meta[META_CLIENT_CAPS] === null) {
      return {
        ok: false,
        id,
        error: { code: ERR_INVALID_PARAMS, message: `缺少必填的 _meta["${META_CLIENT_CAPS}"]` },
      }
    }
  }

  return { ok: true, req: { jsonrpc: '2.0', ...(isNotification ? {} : { id: id! }), method: m.method, params } }
}

// ─────────────────────────────────────────────────────────────
// 三、服务端
// ─────────────────────────────────────────────────────────────

/** 工具执行的产物。**注意它和"协议错误"是两回事**，见 callTool 的注释。 */
export interface ToolOutcome {
  text: string
  /** 模型能自己修的失败。它进 result，不进 error。 */
  isError?: boolean
  /** 结构化输出。给了 outputSchema 就必须给这个。 */
  structured?: unknown
}

export interface McpTool {
  name: string
  /**
   * ★ 这段字符串会**原样进模型的上下文**，而且是每一轮都进。
   * 它同时是"模型唯一的判断依据"（L04）和"你每轮都在付的钱"（L06）。
   * 这两个约束互相拉扯，而大多数 MCP server 只顾了前一个。
   */
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<ToolOutcome>
}

export interface McpServer {
  name: string
  version: string
  tools: McpTool[]
}

/** 一次请求的处理结果。通知返回 null——**通知不许回响应**。 */
export type Handled = JsonRpcResponse | null

function ok(id: string | number, server: McpServer, result: Record<string, unknown>): JsonRpcOk {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      // resultType 是 2026-07-28 新加的，用来支持"还需要更多输入"这类
      // 非终态返回。老版本没有这个字段，所以客户端**必须把缺席当成 complete**。
      resultType: 'complete',
      ...result,
      _meta: { [META_SERVER_INFO]: { name: server.name, version: server.version } },
    },
  }
}

function fail(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcFail {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

/**
 * 把 L04 的 ToolDef 适配成 MCP 工具。
 *
 * 三个决定：
 *
 *   一 · parse 失败变成 **isError 的结果**，不是协议错误。参数格式不对
 *        是模型能自己改的——L04 那条"失败回结果，不抛异常"在这里
 *        从一条团队约定升级成了协议要求。
 *
 *   二 · run 返回的 isError 原样透传。
 *
 *   三 * ★ **logNote 不进 content。** L04 里它是"你要知道但模型不需要
 *        知道"的信息，典型内容是「拒绝了一次越界访问 ../../etc/passwd」。
 *        把它回给模型，等于把沙箱的边界告诉了可能正在探边界的那一方。
 */
export function wrapToolDef(def: ToolDef<never>): McpTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema as unknown as Record<string, unknown>,
    async run(args) {
      const parsed = def.parse(args)
      if (!parsed.ok) return { text: parsed.message, isError: true }
      const r = await def.run(parsed.input as never)
      return { text: r.content, isError: r.isError === true }
    },
  }
}

/** 工具定义的对外形状（去掉 run）。 */
export function toolDescriptor(t: McpTool): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
  }
}

/**
 * 路由一个请求。
 *
 * 这里只实现三个方法，够跑通一条完整链路：
 *   server/discover  —— 我是谁、我会说哪些版本、我有什么能力
 *   tools/list       —— 我有哪些工具
 *   tools/call       —— 调一个
 *
 * resources / prompts 的形状完全一样（`resources/list` + `resources/read`、
 * `prompts/list` + `prompts/get`），补上去是机械劳动。
 */
export async function handleRequest(server: McpServer, req: JsonRpcRequest): Promise<Handled> {
  // 通知：处理完不回。**回了会让客户端收到一个它没发过的 id 的响应**，
  // 严格的客户端会直接断连。
  if (req.id === undefined) {
    return null
  }
  const id = req.id
  const params = req.params ?? {}

  switch (req.method) {
    case 'server/discover':
      return ok(id, server, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
      })

    case 'tools/list':
      return ok(id, server, {
        // ★ 顺序必须确定。规范里这是 SHOULD，但理由很实在：
        // 工具列表进的是 system prompt 的**前缀**，顺序一抖前缀缓存就整体失效。
        // 一个 `Object.values(map)` 的偶然顺序能让你的缓存命中率归零，
        // 而账单上只会显示"input token 变贵了"。
        tools: [...server.tools].sort((a, b) => a.name.localeCompare(b.name)).map(toolDescriptor),
      })

    case 'tools/call':
      return callTool(server, id, params)

    default:
      return fail(id, ERR_METHOD_NOT_FOUND, `未知方法：${req.method}`)
  }
}

/**
 * ★ 这个函数是整节课最该记住的地方：**MCP 有两种错误，它们走不同的通道。**
 *
 *   协议错误 → JSON-RPC 的 `error` 字段
 *     工具名不存在、参数不是对象、服务端自己崩了
 *     判据：**模型改一改参数也没用。**
 *
 *   工具执行错误 → 正常的 `result`，带 `isError: true`
 *     文件不存在、日期格式不对、余额不足
 *     判据：**模型看到这句话有可能自己改对。**
 *
 * 这就是 L04 那条"失败回结果，不抛异常"在协议层的样子。区别在于
 * MCP 把它变成了**规范要求**：客户端 SHOULD 把 isError 的内容喂给模型，
 * 而协议错误通常只记日志、不进上下文。
 *
 * 把两者搞反的后果是不对称的：
 *   · 该 isError 的写成了协议错误 → 模型看不到失败原因，只会重试同一个错参数
 *   · 该协议错误的写成了 isError → 模型看到"没有这个工具"，然后接着编下一个工具名
 */
async function callTool(server: McpServer, id: string | number, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const name = params.name
  if (typeof name !== 'string') {
    return fail(id, ERR_INVALID_PARAMS, 'params.name 必须是字符串')
  }
  const tool = server.tools.find((t) => t.name === name)
  if (!tool) {
    // 规范把"未知工具"归为协议错误。理由是它多半意味着客户端和服务端
    // 的工具清单不同步（server 重启换了一批工具），而不是模型选错了。
    return fail(id, ERR_INVALID_PARAMS, `未知工具：${name}`, { available: server.tools.map((t) => t.name) })
  }

  const rawArgs = params.arguments
  if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) {
    return fail(id, ERR_INVALID_PARAMS, 'params.arguments 必须是一个对象')
  }

  try {
    const outcome = await tool.run((rawArgs ?? {}) as Record<string, unknown>)
    return ok(id, server, {
      content: [{ type: 'text', text: outcome.text }],
      ...(outcome.structured === undefined ? {} : { structuredContent: outcome.structured }),
      isError: outcome.isError === true,
    })
  } catch (err) {
    // ★ 抛出来的和返回 isError 的，含义不同：
    // 返回 isError 是"这次调用失败了，你可以换个参数"；
    // 抛异常是"我这边坏了"。把后者也变成 isError，模型会拿着一个
    // 永远不会成功的调用重试到步数上限——而你的日志里只有一堆 isError。
    return fail(id, ERR_INTERNAL, `工具 ${name} 抛异常：${(err as Error).message}`)
  }
}

// ─────────────────────────────────────────────────────────────
// 四、stdio 传输
// ─────────────────────────────────────────────────────────────

export interface StdioStreams {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

/**
 * 在 stdio 上跑一个 server，直到 stdin 关闭。
 *
 * ★ 这个传输只有一条规矩，但它是 MCP server 的头号 bug：
 *
 *     **stdout 就是电线。往它写任何一个非 MCP 消息的字节，连接就废了。**
 *
 * 一句 `console.log('server started')` 会让客户端的拆帧器拿到
 * `server started` 这一行，JSON.parse 失败。而症状是"客户端说我的
 * server 不是 MCP server"，跟那句 log 隔了十万八千里。
 *
 * 更阴的是**依赖库里的 log**。你自己没打，但某个 SDK 在初始化时
 * 打了一行 deprecation warning——同样的结果，而且更难找。
 *
 * 所以：日志一律走 stderr。规范明确说了客户端不该把 stderr 当错误信号。
 */
export async function serveStdio(server: McpServer, io: StdioStreams): Promise<void> {
  const framer = createFramer()
  const log = (s: string) => io.stderr.write(`[${server.name}] ${s}\n`)

  // ★ setEncoding('utf8') 不是省事，是**正确性**：
  // 不设的话拿到的是 Buffer，而 `buf.toString()` 会在多字节字符
  // 被切开的地方产生替换字符（U+FFFD）。中文注释、emoji、任何非 ASCII
  // 都会中招，而且只在"这个字符恰好跨了 chunk 边界"时出现——
  // 也就是说它是一个**跟数据长度有关的随机 bug**。
  io.stdin.setEncoding?.('utf8')

  log(`listening on stdio, protocol ${PROTOCOL_VERSION}, ${server.tools.length} tools`)

  await new Promise<void>((resolve) => {
    const inflight = new Set<Promise<void>>()

    io.stdin.on('data', (chunk: string) => {
      let lines: string[]
      try {
        lines = framer.push(chunk)
      } catch (err) {
        log(`framer: ${(err as Error).message}`)
        return
      }

      for (const line of lines) {
        const v = validateRequest(line)
        if (!v.ok) {
          // 校验失败也要回——**除非连 id 都读不出来**。
          // 静默丢弃的后果是客户端那边挂着一个永远不 resolve 的 Promise。
          if (v.id !== null) io.stdout.write(encodeMessage(fail(v.id, v.error.code, v.error.message, v.error.data)))
          else log(`丢弃无法定位 id 的坏消息：${v.error.message}`)
          continue
        }

        // ★ 不 await。一个慢工具不该挡住后面的请求——
        // 这也是为什么响应必须靠 id 匹配而不能靠顺序。
        const p = handleRequest(server, v.req)
          .then((resp) => {
            if (resp === null) return
            // 一次 write 写一整行。分两次写（先 body 再 '\n'）在并发下
            // 会交错，产出两行都不合法的 JSON。
            io.stdout.write(encodeMessage(resp))
          })
          .catch((err: Error) => {
            log(`handler crashed: ${err.message}`)
            if (v.req.id !== undefined) io.stdout.write(encodeMessage(fail(v.req.id, ERR_INTERNAL, err.message)))
          })
          .finally(() => inflight.delete(p))
        inflight.add(p)
      }
    })

    // stdin 关闭是唯一可移植的优雅退出信号。等在飞的请求跑完再走。
    io.stdin.on('end', () => {
      void Promise.allSettled([...inflight]).then(() => {
        log('stdin closed, exiting')
        resolve()
      })
    })
  })
}

// ─────────────────────────────────────────────────────────────
// 五、客户端
// ─────────────────────────────────────────────────────────────

export interface ClientOptions {
  clientInfo?: { name: string; version: string }
  capabilities?: Record<string, unknown>
  protocolVersion?: string
}

export interface McpClient {
  /** 发一个请求，等它的响应。 */
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  /** 发一个通知。**不等响应**，因为不会有。 */
  notify(method: string, params?: Record<string, unknown>): void
  /** 喂一行从对面收到的文本。 */
  receive(line: string): void
  /** 对面死了：把所有等待中的请求一次性拒掉。 */
  failAll(reason: string): void
  readonly pending: number
}

/**
 * 传输无关的客户端核心。
 *
 * 故意不知道子进程、HTTP、WebSocket 的存在——它只要一个 `send`。
 * 这么切的好处在 l10/client.ts 里能看到：换传输不用改这里一行。
 */
export function createClient(send: (line: string) => void, opts: ClientOptions = {}): McpClient {
  const version = opts.protocolVersion ?? PROTOCOL_VERSION
  const clientInfo = opts.clientInfo ?? { name: 'labs-client', version: '0.1.0' }
  const capabilities = opts.capabilities ?? {}

  let nextId = 1
  const pending = new Map<string | number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>()

  function withMeta(params: Record<string, unknown>): Record<string, unknown> {
    return {
      ...params,
      _meta: {
        ...(params._meta as Record<string, unknown> | undefined),
        [META_VERSION]: version,
        [META_CLIENT_INFO]: clientInfo,
        [META_CLIENT_CAPS]: capabilities,
      },
    }
  }

  return {
    request(method, params = {}) {
      const id = nextId++
      const line = encodeMessage({ jsonrpc: '2.0', id, method, params: withMeta(params) })
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        send(line)
      })
    },

    notify(method, params = {}) {
      // 通知不带 id，所以也不进 pending。要是这里手滑加了 id，
      // 那个 Promise 永远不会 resolve——对面按规范是不回通知的。
      send(encodeMessage({ jsonrpc: '2.0', method, params }))
    },

    receive(line) {
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        // ★ 这里是 stdout 污染的落点。对面打了一行日志，我们在这里
        // 拿到一段不是 JSON 的文本。**不能静默丢**——静默丢的话
        // 症状是"偶尔卡住"，而不是"对面在往 stdout 打日志"。
        throw new Error(`收到非 JSON 的一行（对面往 stdout 写了东西？）：${line.slice(0, 120)}`)
      }
      const m = msg as Record<string, unknown>
      const id = m.id as string | number | null | undefined
      if (id === undefined || id === null) return // 服务端通知，这个最小实现里不处理
      const slot = pending.get(id)
      // ★ 收到没发过的 id 就丢掉，别抛。重连、重试、上一轮的迟到响应
      // 都会产生这种情况，而为它崩掉整个客户端不值得。
      if (!slot) return
      pending.delete(id)
      if (m.error) {
        const e = m.error as JsonRpcError
        const err = new Error(`[${e.code}] ${e.message}`) as Error & { code: number; data?: unknown }
        err.code = e.code
        err.data = e.data
        slot.reject(err)
      } else {
        slot.resolve((m.result ?? {}) as Record<string, unknown>)
      }
    },

    failAll(reason) {
      // ★ 少了这个函数，子进程一崩，调用方的 await 就永远挂着。
      // 而"永远挂着"是所有故障模式里最难查的一种：没有栈、没有日志、
      // 只有一个不返回的函数。
      for (const [, slot] of pending) slot.reject(new Error(reason))
      pending.clear()
    },

    get pending() {
      return pending.size
    },
  }
}

// ─────────────────────────────────────────────────────────────
// 六、上下文税
// ─────────────────────────────────────────────────────────────

export interface ToolsCost {
  tools: number
  tokens: number
  /** 占预算的比例，0~1。 */
  share: number
}

/**
 * 量一下一份工具清单进上下文要多少钱。
 *
 * ★ 为什么这个函数值得存在：**MCP 的成本是隐形的。**
 * 你在配置文件里加一行 server，多出来的几千 token 不会出现在任何界面上，
 * 只会让每一轮的 input token 变多一点。而"每轮都贵一点"在账单上
 * 看起来像"用量涨了"，不像"我上个月加了个 server"。
 *
 * 真实量级（Anthropic 官方文档 + 社区实测，2026）：
 *   GitHub 官方 server 一家 27 个工具约 18k token；
 *   接七个常见 server 约 67k token，占 200k 窗口的 33%——
 *   **在用户打第一个字之前。**
 */
export function toolsListCost(tools: McpTool[], budgetTokens = 200_000): ToolsCost {
  // 按真正上线的形状算：客户端把 tools/list 的结果原样塞进请求。
  const payload = JSON.stringify(tools.map(toolDescriptor))
  const tokens = estimateTokens(payload)
  return { tools: tools.length, tokens, share: tokens / budgetTokens }
}
