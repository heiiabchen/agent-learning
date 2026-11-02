/**
 * L10 任务二：手写一个 MCP client，真的 spawn 一个子进程。
 *
 *   pnpm mcp:client
 *
 * 这个不用写，直接跑。但它是这一节唯一一个**真的走管道**的实验——
 * 前面所有的东西都在一个进程里，而 MCP 的坑八成出在进程边界上。
 *
 * 默认 spawn 的是 shared/ 里的参考实现，所以你还没写完 server.ts
 * 也能跑。写完之后：
 *
 *   MCP_IMPL=mine pnpm mcp:client
 *
 * 四组实验，后三组都是**只有在真管道上才会出现**的故障：
 *
 *   一 · 一次完整的连接：discover → tools/list → tools/call
 *   二 · 乱序：三个请求同时发，看响应回来的顺序
 *   三 · stdout 污染：一行 console.log 怎么废掉整条连接
 *   四 · 子进程猝死：不处理的话，你的 await 永远不返回
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createClient, createFramer, toolsListCost, type McpClient, type McpTool } from '../shared/mcp.ts'

const SERVER = fileURLToPath(new URL('./server.ts', import.meta.url))
const IMPL = process.env.MCP_IMPL === 'mine' ? 'mine' : 'shared'

interface Conn {
  client: McpClient
  child: ChildProcessWithoutNullStreams
  /** 子进程写到 stderr 的东西。**日志在这里，不在 stdout。** */
  logs: string[]
  /** 从 stdout 拆出来的每一行原文，用来复盘。 */
  rawLines: string[]
  /** 拆帧或解析炸掉时记在这，主流程能看到。 */
  wireErrors: string[]
  close(): Promise<void>
}

/**
 * 起一个 MCP server 子进程，把它的 stdin/stdout 接成一个 client。
 *
 * ★ 这三十行就是 Cursor 在你保存 mcp.json 之后做的事。没有别的。
 */
function connect(env: Record<string, string> = {}): Conn {
  const child = spawn('npx', ['tsx', SERVER, '--stdio'], {
    env: { ...process.env, MCP_IMPL: IMPL, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // ★ 两边都要设编码。不设的话拿到 Buffer，而 `buf.toString()` 会在
  // 多字节字符被切开的地方产生替换字符——一个只在特定数据长度下
  // 才出现的随机 bug。
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  const logs: string[] = []
  const rawLines: string[] = []
  const wireErrors: string[] = []
  const framer = createFramer()
  const client = createClient((line) => child.stdin.write(line), {
    clientInfo: { name: 'l10-demo-client', version: '0.1.0' },
  })

  child.stdout.on('data', (chunk: string) => {
    let lines: string[]
    try {
      lines = framer.push(chunk)
    } catch (err) {
      wireErrors.push((err as Error).message)
      return
    }
    for (const line of lines) {
      rawLines.push(line)
      try {
        client.receive(line)
      } catch (err) {
        // 收到不是 JSON 的一行。**这就是 stdout 被污染的样子。**
        //
        // ★ 注意这个 try 的位置。它包着的是 'data' 事件处理器的内部——
        // 在 Node 里，从事件处理器里抛出去的异常是 uncaughtException，
        // 整个进程当场退出。少这一个 try，症状就从"记了条日志"
        // 变成"我的 agent 崩了"。
        wireErrors.push((err as Error).message)
      }
    }
  })

  child.stderr.on('data', (chunk: string) => {
    for (const l of chunk.split('\n')) if (l.trim()) logs.push(l)
  })

  // ★ 子进程死了要把所有等待中的请求拒掉。少了这一句，
  // 调用方的 await 永远不返回——没有栈、没有日志、只有一个不返回的函数。
  child.on('exit', (code, signal) => {
    client.failAll(`server 子进程已退出（code=${code} signal=${signal}）`)
  })

  return {
    client,
    child,
    logs,
    rawLines,
    wireErrors,
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.once('exit', () => resolve())
        // 关 stdin 是唯一可移植的优雅退出信号。规范就是这么定的。
        child.stdin.end()
        setTimeout(() => child.kill('SIGKILL'), 3000).unref()
      }),
  }
}

/** 起一个连接并等它能应答，避免把「进程还没起来」误读成「协议错」。 */
async function connectReady(env: Record<string, string> = {}): Promise<Conn> {
  const conn = connect(env)
  try {
    await conn.client.request('server/discover')
  } catch {
    // 起不来也继续——某些实验要的就是它起不来。
  }
  return conn
}

// ─────────────────────────────────────────────────────────────

async function demoHandshakeless() {
  console.log('\n【一】一次完整的连接（2026-07-28：没有握手）')

  const conn = connect()
  const t0 = Date.now()

  const disc = await conn.client.request('server/discover')
  console.log(`  server/discover  ${Date.now() - t0}ms`)
  console.log(`    supportedVersions: ${JSON.stringify(disc.supportedVersions)}`)
  console.log(`    capabilities:      ${JSON.stringify(disc.capabilities)}`)

  const listed = (await conn.client.request('tools/list')) as unknown as { tools: McpTool[] }
  console.log(`  tools/list       ${listed.tools.length} 个：${listed.tools.map((t) => t.name).join('、')}`)

  const called = await conn.client.request('tools/call', {
    name: 'list_dir',
    arguments: { path: 'l10' },
  })
  const text = ((called.content as { text: string }[])[0]?.text ?? '').split('\n').slice(0, 4)
  console.log('  tools/call       list_dir("l10") →')
  for (const l of text) console.log(`      ${l}`)

  console.log(`\n  子进程的 stderr（日志走这里，不走 stdout）：`)
  for (const l of conn.logs) console.log(`      ${l}`)

  console.log('\n  ★ 注意没有 initialize。2026-07-28 之前这里要先握一次手，')
  console.log('  服务端把版本和能力记在**这条连接的内存里**。')
  console.log('  代价是同一个客户端的请求必须落到同一个进程——粘性会话、共享存储、')
  console.log('  或者干脆单实例。删掉握手之后，任何请求可以落到任何一台机器。')
  console.log('\n  这笔交易在 HTTP 世界里已经做过一次了：cookie session → JWT。')
  console.log('  **用每个请求多几十字节，换掉整套会话基础设施。**')

  await conn.close()
}

async function demoOutOfOrder() {
  console.log('\n【二】乱序：为什么响应必须靠 id 匹配')

  const conn = await connectReady()

  // 一个慢的（搜整个 labs 目录）和两个快的，同时发出去。
  const jobs: [string, Promise<Record<string, unknown>>][] = [
    ['search_code（慢）', conn.client.request('tools/call', { name: 'search_code', arguments: { pattern: 'export function', max_results: 50 } })],
    ['list_dir（快）', conn.client.request('tools/call', { name: 'list_dir', arguments: { path: '.' } })],
    ['tools/list（快）', conn.client.request('tools/list')],
  ]

  console.log(`  同时发出 3 个请求，pending=${conn.client.pending}`)

  const order: string[] = []
  await Promise.all(
    jobs.map(async ([label, p]) => {
      await p
      order.push(label)
    }),
  )

  console.log(`  发出顺序：${jobs.map(([l]) => l).join(' → ')}`)
  console.log(`  完成顺序：${order.join(' → ')}`)
  console.log('\n  ★ 服务端不 await 每个请求（一个慢工具不该挡住后面的），')
  console.log('  所以响应顺序和发出顺序**没有关系**。')
  console.log('  按顺序配对的客户端在这里会把 list_dir 的结果当成 search_code 的——')
  console.log('  而且它不报错，只是答案不对。')
  console.log('\n  ★ 顺手跑一下 `uv run python -m l10.client`：同一份协议、同一批请求，')
  console.log('  Python 版的完成顺序会**等于**发出顺序。原因不在协议，在 toolbox 的工具')
  console.log('  是「不 await 的 async 函数」，把事件循环占满了（那边有详细拆解）。')
  console.log('  两个运行时给出两种顺序，这本身就是「顺序不能当契约」最好的证据。')

  await conn.close()
}

async function demoStdoutPollution() {
  console.log('\n【三】stdout 污染：同一个 bug，三种症状，没有一种提到 console.log')

  // server 那边只多了一行 console.log。
  const conn = connect({ MCP_POLLUTE_STDOUT: '1' })

  let outcome: string
  try {
    const disc = await withTimeout(conn.client.request('server/discover'), 6000)
    outcome = `请求成功了，supportedVersions=${JSON.stringify(disc.supportedVersions)}`
  } catch (err) {
    outcome = `请求失败：${(err as Error).message}`
  }

  console.log(`  stdout 上收到 ${conn.rawLines.length} 行，其中 ${conn.wireErrors.length} 行不是 JSON`)
  for (const l of conn.rawLines) {
    const bad = !l.trim().startsWith('{')
    const shown = l.length > 68 ? l.slice(0, 68) + '…' : l
    console.log(`    ${bad ? '\x1b[31m✗' : ' '} ${shown}${bad ? '\x1b[0m' : ''}`)
  }
  console.log(`  这次的结果：${outcome}`)

  // ★ 关键在这里：**同一批字节，客户端策略不同，症状完全不同。**
  // 三个标签都是 8 个全角字符，所以不用 padEnd——CJK 在终端里是双宽，
  // 而 padEnd 数的是 code unit，对齐会歪。
  const dropped = conn.rawLines.filter((l) => !l.trim().startsWith('{')).length
  console.log('\n  同一批字节，三种客户端策略：')
  console.log(`    宽容（静默跳过）  → 连接活着，${dropped} 行被丢掉，而你不会知道`)
  console.log('    记录（记下跳过）  → 连接活着，日志里多一条「收到非 JSON 的一行」')
  console.log('    严格（断开连接）  → 断连，宿主报「server failed to start」')

  console.log('\n  ★ server 那边只多了一行：')
  console.log('      console.log(`[${server.name}] started, ${n} tools ready`)')
  console.log('\n  它写的是一句人话，而 stdout 上只能有 MCP 消息。')
  console.log('  规范说 server MUST NOT 往 stdout 写非 MCP 内容，但**没规定客户端该怎么反应**——')
  console.log('  所以同一个 bug 在 Cursor 里是"启动失败"，在你手写的客户端里可能是')
  console.log('  进程崩溃（异常从 data 事件冒出去就是 uncaughtException），')
  console.log('  在一个宽容的实现里则是**什么都没发生**。')
  console.log('\n  三种症状里没有一种会提到那句 console.log。')
  console.log('  更阴的是依赖库里的 log：你自己没打，某个 SDK 初始化时打了一行')
  console.log('  deprecation warning。同样的结果，而且你的代码里搜不到。')
  console.log('\n  规矩只有一条：**日志一律走 stderr。**')
  console.log('  规范明确说了客户端不该把 stderr 当错误信号——那里是给你用的。')

  await conn.close()
}

async function demoCrash() {
  console.log('\n【四】子进程猝死：不处理的话 await 永远不返回')

  const conn = await connectReady()

  const slow = conn.client.request('tools/call', {
    name: 'search_code',
    arguments: { pattern: 'export', max_results: 50 },
  })
  console.log(`  发出一个请求，pending=${conn.client.pending}`)

  // 模拟 server 崩了：OOM、被 OOM killer 收掉、依赖挂了、代码抛在了顶层。
  conn.child.kill('SIGKILL')
  console.log('  SIGKILL 掉子进程')

  const t0 = Date.now()
  try {
    await withTimeout(slow, 6000)
    console.log('  请求居然成功了')
  } catch (err) {
    console.log(`  ${Date.now() - t0}ms 后：${(err as Error).message}`)
  }
  console.log(`  pending=${conn.client.pending}`)

  console.log('\n  ★ 这个 reject 来自 client.failAll()，挂在子进程的 exit 事件上。')
  console.log('  少了那三行，这个 await **永远不返回**——')
  console.log('  没有异常、没有栈、没有超时，只有一个不返回的函数。')
  console.log('\n  L00 那个 withTimeout 在这里是第二道闸，不是第一道。')
  console.log('  超时能救你，但它把"server 崩了"报成"超时了"——**诊断信息在这一步丢掉了**。')

  await conn.close()
}

function demoTax(tools: McpTool[]) {
  console.log('\n【五】上下文税：接进来之后每一轮付多少')

  const one = toolsListCost(tools)
  console.log(`  这个 server：${one.tools} 个工具 → ${one.tokens} token（占 200k 的 ${(one.share * 100).toFixed(2)}%）`)
  console.log('\n  社区实测（2026）：')
  console.log('    GitHub 官方 server        27 个工具   ~18,000 token')
  console.log('    五个常见 server 加一起   ~100 个工具  ~55,000 token')
  console.log('    七个                     ~140 个工具  ~67,300 token  ← 200k 窗口的 34%')
  console.log('\n  ★ 这笔钱**每一轮都付一次**，而且在用户打第一个字之前就付了。')
  console.log('  它不出现在任何界面上，只让 input token 慢慢变多——')
  console.log('  在账单上看起来像"用量涨了"，不像"我上个月加了个 server"。')
  console.log('\n  另一半是准确率：可选工具超过 30~50 个之后，模型选错工具的概率明显上升。')
  console.log('  两个问题方向相反——**加 server 让能力变强，但让每一次选择变差。**')
  console.log('\n  所以 2026 年的解法都是"别一次性全塞"：')
  console.log('    渐进披露   工具清单先给一个搜索入口，用到再加载（省 ~85%）')
  console.log('    代码模式   让模型写代码调工具，中间结果留在沙箱里不进上下文')
  console.log('  判据（Anthropic 官方给的）：**少于 10 个工具就别折腾，直接全给。**')
}

// ─────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${ms}ms 超时`)), ms).unref()),
  ])
}

async function main() {
  console.log('═'.repeat(64))
  console.log(`L10 · MCP client：真 spawn、真管道（server 实现：${IMPL}）`)
  console.log('═'.repeat(64))

  await demoHandshakeless()
  await demoOutOfOrder()
  await demoStdoutPollution()
  await demoCrash()

  // 单独起一个连接拿工具清单来算税。
  const conn = await connectReady()
  const listed = (await conn.client.request('tools/list')) as unknown as { tools: McpTool[] }
  demoTax(listed.tools)
  await conn.close()

  console.log('\n' + '─'.repeat(64))
  console.log('写完 server.ts 之后用 MCP_IMPL=mine pnpm mcp:client 换成你自己的实现。')
  console.log('四组实验的输出应该一模一样——**包括那三个故障。**')
  console.log('─'.repeat(64) + '\n')
}

await main()
