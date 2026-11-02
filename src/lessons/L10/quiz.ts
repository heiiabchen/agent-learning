import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L10',
  questions: [
    {
      id: 'whenmcp',
      kind: 'choice',
      prompt:
        '你们的 agent 有八个工具，全都是主仓库里的 TypeScript 函数，只有这一个 agent 在用。组里有人提议「把它们改造成 MCP server，这样更标准」。最该指出的问题是什么？',
      options: [
        { id: 'a', label: '八个工具太少了，MCP 的收益要在二三十个工具以上才体现得出来' },
        { id: 'b', label: 'MCP 的价值全在跨进程、跨供应商复用，这两条都不满足时它只是给函数调用加了一层序列化' },
        { id: 'c', label: '应该先等 MCP 规范稳定下来，现在改造以后还要跟着改' },
        { id: 'd', label: 'MCP server 要单独部署和监控，运维成本划不来' },
      ],
      correct: ['b'],
      explain: `B。**这和 L09 开头那条「该不该上 RAG」是同一类判断，甚至是同一个错误模式：为了「架构正确」引入一层，然后自己制造了一类新的失败。**

MCP 的价值来自两件事，缺一不可：

- **跨进程**——工具跑在别的进程/语言/机器上，你只能通过管子和它说话
- **跨供应商**——工具是别人写的，或者你的工具要给别人用

八个工具在同一个仓库、同一个进程、同一个 agent 用。改成 MCP 之后换来了什么？

| | 直接调函数 | 包成 MCP |
|---|---|---|
| 调用 | 函数调用 | JSON 序列化 → 管道 → 反序列化 |
| 类型 | 编译期检查 | 运行时 schema 校验 |
| 失败面 | 函数抛异常 | **多一个会崩的子进程、一根会堵的管道、一层会拆错的帧** |
| 调试 | 打断点 | 看两个进程的日志 |

**最后两行是净损失。** 这一节讲的所有坑——拆帧、stdout 纪律、id 配对、子进程猝死——**全都是你主动引进来的**，而且它们一个都不报错。

---

**看错项：**

**A（工具太少）**——数量不是判据。**两个工具跨团队复用也值得上 MCP，两百个工具在自己仓库里也不值得。** 判据是边界，不是规模。

**C（等规范稳定）**——这个理由永远成立，所以它什么都没说。而且反了：规范小、变化快恰恰说明**实现成本低**，跟着改也不贵。

**D（运维成本）**——真的，但它是次要理由。★ 和 L09 那道题一样：**用成本论证会让人觉得「预算够就可以上」，而那是错的。** 就算 MCP 零成本，多一层序列化边界换不来任何东西这件事依然成立。`,
    },
    {
      id: 'errchannel',
      kind: 'choice',
      prompt:
        '你的 MCP server 有个 `query_db` 工具。为了「简单统一」，实现里把所有失败都包成了 `{ result: { isError: true, content: [...] } }` 回给模型——包括数据库连不上时抛的那个异常。上线后最可能出现的现象是什么？',
      options: [
        { id: 'a', label: '客户端会因为收不到 JSON-RPC error 而断开连接' },
        { id: 'b', label: '数据库故障期间，模型会一路重试到步数上限，而日志里全是看起来像「模型没试对」的 isError' },
        { id: 'c', label: '模型会因为看不到错误码而无法判断失败类型，直接停止' },
        { id: 'd', label: '没什么问题，isError 本来就是给模型看失败原因用的' },
      ],
      correct: ['b'],
      explain: `B。**两条错误通道的判据只有一句：模型改一改参数，有没有可能成功？**

数据库连不上，模型改一百次参数也不会成功。但它**不知道这件事**——它看到的只是"工具失败了"，而它被训练成看到失败就调整重试。

    包成 isError → 模型看到"失败了" → 换个参数重试 → 还是失败
                 → 换个措辞重试 → 还是失败 → ... 直到步数上限

三十步、几十次 API 调用、几块钱，换来一次注定失败的重试。

**而这还不是最糟的。** 最糟的是你的监控上看到的是一堆 \`isError\`，形状和"模型选错工具""参数给得不对"完全一样。你会去调 prompt、加 few-shot、换模型——而真正的问题是一个数据库连接。

★ **放错通道的真正代价，是把一个具体的、可定位的问题，伪装成了「模型能力不足」。**

正确做法是 \`-32603\`：宿主看得到、能告警、能重连，而模型压根不该被卷进来。

---

**四种情况对照：**

| 情况 | 通道 | 为什么 |
|---|---|---|
| 文件不存在 | \`isError: true\` | 模型可以改路径，或者先 \`list_dir\` |
| 少了必填参数 | \`isError: true\` | 模型能看着报错补上 |
| 工具名不存在 | \`error -32602\` | 改参数没用，这个工具就是没有 |
| 内部抛异常 | \`error -32603\` | **那是你的 bug，不是模型的** |

---

**看错项：**

**A（客户端断开）**——不会。这个响应在协议上**完全合法**，客户端没有任何理由拒绝它。★ 这正是它难查的原因：**协议层一切正常，坏的是语义。**

**C（模型停止）**——反了。模型看到 \`isError\` 的反应是**重试**，不是停止。这个方向的误判会让人以为"最多浪费一步"。

**D（没问题）**——反过来错也一样贵：把"文件不存在"写成协议错误，模型**看不到失败原因**，只会拿着同一个错路径重试。两个方向都是把可定位的问题变成玄学。`,
    },
    {
      id: 'stdoutbug',
      kind: 'choice',
      prompt:
        '你写的 MCP server 在自己的测试客户端上跑得好好的。同事在 Cursor 里配上，报「server failed to start」；另一个同事在别的宿主里配上，能用，但偶尔某次工具调用没有反应。三种表现，同一个 server。最可能的原因是什么？',
      options: [
        { id: 'a', label: '不同宿主实现的协议版本不一样，需要在 _meta 里做版本协商' },
        { id: 'b', label: 'server 往 stdout 写了非 JSON 内容，而三个客户端对这一行的处理策略不同' },
        { id: 'c', label: 'server 启动太慢，严格的宿主有启动超时' },
        { id: 'd', label: 'stdio 传输在不同操作系统上的换行符不一致' },
      ],
      correct: ['b'],
      explain: `B。**"同一个 server，三种症状"这个组合本身就是 stdout 污染的指纹。**

规范说 server **MUST NOT** 往 stdout 写非 MCP 内容——但**它没规定客户端该怎么反应**。于是同一批字节在三种客户端里是三件事：

| 客户端策略 | 表现 | 你看到的 |
|---|---|---|
| 宽容（静默跳过） | 连接正常 | **什么都没有** |
| 记录（跳过并记日志） | 连接正常 | 日志里一条"收到非 JSON 的一行" |
| 严格（断开连接） | 连不上 | "server failed to start" |

三种症状对上了题目里的三种表现：你自己的测试客户端宽容、Cursor 严格、第三个宿主宽容但会丢行。

**"偶尔某次工具调用没有反应"是最要命的那种。** 那不是随机——是那次的日志输出和响应挤在同一个 chunk 里，被一起丢了。而且它**一直"能用"**，直到丢掉的那一行正好是一个响应。

★ 三种症状里**没有一种会提到那句 \`console.log\`**。这是这一节最值得亲手看一次的东西：lab 里的 TODO 8 就是让你加一句 log 然后跑客户端，看它报的是什么。

规矩只有一条：**日志一律走 stderr。** 没有例外，没有"就调试一下"。

Python 这边还多一层：\`print()\` 是肌肉记忆，而且 **stdout 在管道上是块缓冲的**——就算你写对了信道，不 \`flush()\` 数据也压在缓冲区里等第 4096 个字节。症状是客户端超时，而 server 那边一切正常，它甚至觉得自己回过了。

---

**看错项：**

**A（版本协商）**——版本不匹配是**响亮**的失败：一个明确的 \`-32022\`，而且 \`data.supported\` 里带着支持的版本列表。它不会表现为"偶尔没反应"。

**C（启动超时）**——能解释"严格宿主连不上"，解释不了另外两个。★ 这是最容易被采信的错误诊断，因为它对第一个症状的解释完全说得通——而**只能解释一个症状的假设通常是错的**。

**D（换行符）**——CRLF 里的 \`\\r\` 会留在行尾，\`JSON.parse\` 会忽略尾部空白。真实但罕见，而且它会稳定失败，不会分化成三种表现。`,
    },
    {
      id: 'toolorder',
      kind: 'choice',
      prompt:
        '你的 agent 接了四个 MCP server，一共六十来个工具。上线两周后，成本看板显示每次会话的 input token 花费涨了将近一倍。功能全对，没有报错，输出的 token 数没变，工具也没加。最先该查什么？',
      options: [
        { id: 'a', label: '模型供应商是不是调价了' },
        { id: 'b', label: '工具清单的顺序在会话之间是不是变了，导致 system prompt 前缀缓存失效' },
        { id: 'c', label: '是不是有用户在发超长的输入' },
        { id: 'd', label: '对话历史是不是没有做截断，轮次一多 input 就涨' },
      ],
      correct: ['b'],
      explain: `B。**"功能全对、没有报错、只有 input 变贵"是前缀缓存失效在监控上唯一的样子。**

工具清单进的是 system prompt 的**最前面**，也就是缓存前缀的一部分。而 DeepSeek 这类定价里，命中和不命中差 **120 倍**：

    60 个工具 ≈ 5,500 tokens/轮，一个 30 步的循环：
    
      全部 cache miss（¥3/M）     ¥0.49 一次会话    1000 次会话 ¥493
      全部 cache hit （¥0.025/M） ¥0.004 一次会话   1000 次会话 ¥4.1

接了四个 MCP server 之后，顺序不稳定几乎是默认状态——**四个子进程并发连接，谁先返回谁排前面**。清单一变，前缀就变，整段缓存作废。

顺序不稳的其他来源，全都同样无辜：

- 从 \`set\` 或某些语言的 map 里遍历工具
- 从文件系统扫描工具目录（\`readdir\` 的顺序不保证）
- 用 \`Promise.all\` 收集然后按完成顺序拼接

修法是一行：\`tools/list\` 出去之前按 name 排序。

★ lab 里那条测试就是测这个——用两个注册顺序不同、内容相同的 server，断言两次 \`tools/list\` 的结果**字符串相等**。

---

**看错项：**

**A（供应商调价）**——值得花三十秒排除，但它解释不了"两周后才开始"。而且这是最常见的第一反应，**因为它是唯一不需要看自己代码的解释。**

**C（超长输入）**——用户输入的长度是可以直接查的，而且它会带来 output 和延迟的相应变化。题目说了 output token 没变。

**D（历史没截断）**——真实的成本来源，但它是 L06 的问题，而且**它会同时让延迟涨**。题目里的症状是"只有 input 花费涨"，这个"只有"指向的是单价，不是数量。★ **分清「量涨了」和「单价涨了」，是这类排查的第一步**——而缓存命中率是唯一能让单价变的东西。`,
    },
    {
      id: 'handshake',
      kind: 'choice',
      prompt:
        '2026-07-28 的 MCP 规范删掉了 `initialize` 握手，改成每个请求在 `params._meta` 里自带协议版本和客户端能力。关于这个改动，下面哪个说法是对的？',
      options: [
        { id: 'a', label: '主要收益是省掉一次往返，让首次工具调用更快' },
        { id: 'b', label: '主要收益是服务端不再持有会话状态，任何请求可以落到任何进程——代价是每个请求多约 190 字节' },
        { id: 'c', label: '主要收益是简化了客户端实现，因为不用再处理握手失败的情况' },
        { id: 'd', label: '这是个向后兼容的改动，旧客户端的 initialize 会被新服务端忽略' },
      ],
      correct: ['b'],
      explain: `B。**这笔交易在 HTTP 世界里已经做过一次了：cookie session → JWT。**

有握手就意味着服务端要把协商结果记在**这条连接的内存里**。而"服务端有会话状态"这件事会一路渗透到部署拓扑：

    有握手                            无握手
    ─────────────────────            ────────────────────────
    同一客户端的请求必须落到同一进程    任何请求可以落到任何进程
      ↓                                ↓
    粘性会话 / 共享 session 存储        无状态横向扩容
      ↓                                ↓
    进程重启 = 所有连接失效             进程重启 = 下一个请求换台机器

而 190 字节这个代价**是可以压缩的**（gzip 之后几十字节，而且每个请求的这一段内容都一样）。**粘性会话是压不掉的**——它是一个架构约束。

对 stdio 传输来说这个改动几乎没感觉（本来就是一个子进程一条管道）。**它的全部价值在 Streamable HTTP 那一侧**：一个 MCP server 可以像普通无状态服务一样部署在负载均衡后面。

---

**看错项：**

**A（省一次往返）**——真的，但一次往返在一条会持续几十轮的连接上可以忽略。**用"快一点"论证会让人以为这是个优化，而它是个架构改动。**

**C（客户端更简单）**——服务端确实简化了，客户端反而多了活儿：**每个请求都要拼 \`_meta\`**，一处漏了就是 \`-32602\`。

**D（向后兼容）**——不兼容，而且不兼容的方式很隐蔽：老的"版本不匹配"错误码 \`-32002\` 被合并进了标准的 \`-32602\`。

★ 照旧教程写 \`if (err.code === -32002)\` 的降级逻辑，在新 server 上**静默走进 else 分支**。代码没坏，只是不再做它本来该做的事——而这类 bug 只在版本升级之后才出现。`,
    },
    {
      id: 'pyorder',
      kind: 'choice',
      prompt:
        '同一份 MCP server 逻辑，你分别用 TypeScript 和 Python 实现，然后同时发出三个请求（一个慢工具、两个快的）。TS 版的响应乱序回来，Python 版严格按发出顺序回来，而且三个请求的耗时挤在 4.7ms ~ 5.2ms。Python 版发生了什么？',
      options: [
        { id: 'a', label: 'Python 的 asyncio 保证了任务按创建顺序完成，这是运行时的正确行为' },
        { id: 'b', label: '工具是「不 await 任何东西的 async 函数」，事件循环执行到它就必须跑完才能切走，三个请求实际在排队' },
        { id: 'c', label: 'Python 的 GIL 导致 asyncio 无法真正并发，这是语言限制，改不了' },
        { id: 'd', label: 'stdout 的块缓冲把三个响应攒在一起，所以看起来是顺序的' },
      ],
      correct: ['b'],
      explain: `B。**\`async def\` 只是签名。函数体里一个 \`await\` 都没有的话，它就是一个穿了戏服的同步函数。**

    async def run(inp):
        return ToolResult(content=path.read_text(encoding="utf-8"))   # ← 同步阻塞

事件循环一旦开始执行这个协程，**就必须等它整个跑完才能切走**。于是 \`create_task\` 派发了三个任务，它们仍然一个接一个地跑。

**耗时那条是关键证据。** 如果三个请求真在并发，最快的应该明显快于最慢的；实测挤在 4.7ms ~ 5.2ms，说明它们在排队——**后面两个的耗时里包含了前面那个的执行时间。**

修法是把阻塞活儿挪出事件循环：

    return await asyncio.to_thread(lambda: path.read_text(encoding="utf-8"))

★ 这个坑不报错，只是**慢，而且是随负载恶化的慢**。它在压测之前发现不了，压测的时候会被误诊为"Python 就是慢"。

---

**这道题里有两条独立的教训，别混在一起：**

1. **顺序不是协议保证的。** 两个运行时给出两种顺序，这本身就是最好的证据——所以客户端**永远**按 id 配对。这条跨语言成立
2. **你的 async server 可能根本没在并发。** 这条是 Python 特有的

第一条要是靠"我观察到 Python 是顺序的"来实现客户端，那这个客户端会在换语言、换版本、或者某天有人把 \`read_text\` 改成 \`to_thread\` 的时候突然出错——**而错法是"答案不对"，不是"报错"。**

---

**看错项：**

**A（asyncio 保证顺序）**——不保证，而且从来没保证过。这次的顺序是阻塞造成的**副作用**，把它当成契约是这道题最危险的误读。

**C（GIL）**——GIL 限制的是**多线程的 CPU 并行**，和 asyncio 的 IO 并发是两回事。而且这里改得了：\`asyncio.to_thread\` 就是解法（IO 期间会释放 GIL）。★ 拿 GIL 解释一切是 Python 性能问题里最常见的误诊。

**D（stdout 缓冲）**——块缓冲会让响应**一起晚到**，但不会改变它们之间的先后。而且这解释不了"三个耗时挤在一起"——如果是并发跑完再一起 flush，三个的耗时应该都接近最慢那个，而不是呈递增排列。`,
    },
    {
      id: 'passthrough',
      kind: 'choice',
      prompt:
        '你在给公司内部 GitLab 写一个远程 MCP server。用户经公司 Keycloak 授权后，MCP 客户端带着 access token 调你；你的 `create_merge_request` 工具需要调 GitLab API。组里提了四种做法，哪一种符合 MCP 2026-07-28 规范？',
      options: [
        { id: 'a', label: '把客户端发来的 token 原样放进调 GitLab 的 `Authorization` 头——都是 Keycloak 签的，GitLab 也信 Keycloak' },
        { id: 'b', label: '先校验这张 token 的 `aud` 是你的 MCP server，通过之后再原样转给 GitLab' },
        {
          id: 'c',
          label:
            '校验入站 token 的 `aud` 是你的 MCP server；调 GitLab 用另一张 token（例如用 RFC 8693 换一张 `aud` 是 GitLab 的，或由 MCP server 自己作为 OAuth 客户端向 GitLab 授权）',
        },
        { id: 'd', label: '只要全程 HTTPS、token 不落日志，原样转发就是安全的' },
      ],
      correct: ['c'],
      explain: `C。**入站 token 只证明「这个调用方可以用你」，不证明它可以用 GitLab**。规范把这两件事拆成了两张 token：

> "The access token used at the upstream API is a separate token, issued by the upstream authorization server. The MCP server MUST NOT pass through the token it received from the MCP client."

C 的两半各守一条：入站验受众（"MUST validate that access tokens were issued specifically for them as the intended audience"），出站换一张 \`aud\` 是 GitLab 的 token。规范只说 MCP server "may act as an OAuth client to them"，没指定 grant——RFC 8693 换票、自己走一次授权、client credentials 都可以。**不变量只有一条：出站 token 不是入站那张，它的 \`aud\` 是下游**。

---

**看错项**：

**A** 就是规范点名禁止的 token passthrough。「都是 Keycloak 签的」恰好是最危险的前提：GHSA-w4fh 那条公告的场景正是 "Where one authorization server issues tokens for several services"——同一个 AS 签的 token，最容易被跨服务误收。

**B 是最有迷惑性的一项**：入站做对了，出站仍是透传。GitLab 收到一张 \`aud\` 是你的 MCP server 的 token：它要是校验受众，会拒绝（功能坏）；它要是不校验，就收下了一张不是给它的 token（安全坏）。**两种结局都不对，所以这条路本身是错的**。

还有第三个后果，安全最佳实践写得很直白："The MCP Server will be unable to identify or distinguish between MCP Clients when clients are calling with an upstream-issued access token"——GitLab 日志里看到的是用户在直接调用，审计链从你这里断掉。

**D** 把传输安全当成授权安全。HTTPS 防的是线上窃听，防不了「下游以为这张 token 是给它的」。`,
    },
    {
      id: 'mixup',
      kind: 'choice',
      prompt:
        '一个 MCP 宿主连了用户装的 12 个远程 MCP server，背后是 9 个不同的授权服务器，其中一个被攻击者控制。攻击者想让宿主把从**另一个**诚实 AS 拿到的授权码送到自己的 token 端点。下面哪一项是规范给出的针对性防御？',
      options: [
        { id: 'a', label: 'PKCE S256：授权码没有 `code_verifier` 就换不出 token' },
        { id: 'b', label: '授权请求和 token 请求都带 `resource` 参数' },
        { id: 'c', label: '跳转前记下所选 AS 的 `issuer`，回调时把响应里的 `iss` 与之逐字比较，不一致就丢弃' },
        { id: 'd', label: '使用 `state` 参数，回调时校验一致' },
      ],
      correct: ['c'],
      explain: `C。这是 RFC 9207 的 \`iss\` 校验，MCP 在 2026-07-28 把它加了进来。

先看为什么另外几样都不够，规范原文：

> "PKCE alone does not prevent this attack because the client transmits the \`code_verifier\` to the attacker's token endpoint. Resource indicators do not help when the attacker's authorization server is intercepting requests before they hit the honest authorization server."

客户端以为自己在和诚实 AS 换 token，于是把 verifier 也交给了攻击者。能区分「这个回调来自哪个 AS」的，只有响应里的 \`iss\`——前提是跳转前已经从**校验过的**元数据里记下了期望值。规范原话："it provides no protection if the expected issuer was obtained from an unvalidated source."

比较方式也有规定：简单字符串比较，**禁止任何规范化**，大小写、默认端口、尾斜杠、百分号编码都不许动。不一致时连 \`error_description\` 都不许展示——那份错误可能就是攻击者写的。

---

**看错项**：

**A**（PKCE）是这道题最想拦住的直觉。PKCE 防的是「授权码被别人截走再去换」；mix-up 里去换 token 的就是客户端自己，只是换错了地方。

**B**（resource）表达的是「我要一张给谁的 token」，对一个在诚实 AS 之前就截住请求的攻击者没有约束力。

**D**（state）绑定的是「这个回调属于我发起的这次流程」。在 mix-up 里，回调**确实**属于客户端自己发起的流程，\`state\` 校验会通过。它不携带「响应来自哪个 AS」的信息。

---

★ 题干里的「9 个 AS」不是夸张，是 MCP 宿主的常态：宿主对接的 AS 数量，等于用户装过的远程 server 数量，而且事先不知道它们是谁。RFC 9207 开头那句 "Mix-up attacks are a potential threat to all OAuth clients that interact with multiple authorization servers"，MCP 宿主是最极端的样本。`,
    },
    {
      id: 'clientbug',
      kind: 'debug',
      prompt:
        '一位同学写了个 MCP 客户端。本地测试全过，接到测试环境跑了两天，出现过这些反馈：「有时候返回的内容明显不是我要的那个工具的」「有一次整个 agent 卡住不动了，没有报错」「工具返回大结果的时候会崩」。找出这段代码里的问题（不止一个）。',
      lang: 'typescript',
      code: `const child = spawn('npx', ['-y', 'company-mcp'], {
  stdio: ['pipe', 'pipe', 'ignore'],
})

const queue: ((v: any) => void)[] = []

child.stdout.on('data', (chunk: Buffer) => {
  const msg = JSON.parse(chunk.toString('utf8'))
  queue.shift()?.(msg)
})

function send(method: string, params: unknown): Promise<any> {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) + '\\n')
  return new Promise((resolve) => queue.push(resolve))
}

export async function listTools() {
  const r = await send('tools/list', {})
  return r.result.tools
}

export async function callTool(name: string, args: Record<string, unknown>) {
  const r = await send('tools/call', { name, arguments: args })
  if (r.error) throw new Error(r.error.message)
  return r.result.content[0].text
}`,
      reference: `三条反馈对应三个不同的 bug，而这段代码里的问题**比三个多**。按严重程度排：

---

**一 · 没有拆帧。（\`on('data')\`）**

\`JSON.parse(chunk.toString())\` 假设"一个 chunk 正好一条消息"。**管道只承诺顺序，不承诺边界。**

它在本地能跑，是因为消息小、来得慢。等到某个工具返回 80KB 的搜索结果，chunk 会被切成好几段——\`JSON.parse\` 抛异常，而这个异常在 \`'data'\` 回调里**没人接**，直接干掉进程。

这就是"工具返回大结果的时候会崩"。★ **注意它是唯一一个响亮失败的 bug，所以它反而是最先被发现的那个——尽管它不是最严重的。**

需要一个缓冲区：

    let buf = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) handle(JSON.parse(line))
      }
      if (buf.length > 8 * 1024 * 1024) throw new Error('单行超过 8MB 上限')
    })

最后那行上限不是防御性编程，是**防 OOM**：对面要是崩在写响应的中途，这个缓冲区会一直涨，而 **OOM 的现场没有任何信息指向"对面没发换行"**。

---

**二 · 按顺序配对，完全没用到 id。（\`queue.shift()\`）**

服务端不会 \`await\` 每个请求再处理下一个——一个慢工具不该挡住后面的。**所以响应顺序和发出顺序没有关系。**

\`queue.shift()\` 把先回来的响应交给先发出的请求。一个慢的 \`search_code\` 和一个快的 \`list_dir\` 同时在飞，\`list_dir\` 的结果会被当成 \`search_code\` 的。

这就是"返回的内容明显不是我要的那个工具的"。而这条 bug **不抛任何异常**——它只是把答案换了。

改成按 id 配对：

    const pending = new Map<number, (v: any) => void>()
    // on data: pending.get(msg.id)?.(msg); pending.delete(msg.id)

★ 顺带一个陷阱：**"我本地测了，顺序是对的"不能作为证据。** 同一份 server 逻辑，TS 实现会乱序，Python 实现（工具是不 await 的 async 函数）不会乱——**顺序对不对取决于对面怎么实现的，而那不归你管。**

---

**三 · 子进程死了，Promise 永远挂着。（全局）**

没有 \`child.on('exit')\`，也没有监听 stdout 的 \`'end'\`。

server 崩了之后，\`pending\` 里的 Promise **永远不 resolve**。没有异常、没有栈、没有超时——只有一个不返回的 \`await\`。

这就是"整个 agent 卡住不动了，没有报错"。

    child.stdout.on('end', () => {
      for (const [, reject] of pending) reject(new Error('server 子进程已退出（stdout EOF）'))
      pending.clear()
    })

★ 这一条在 lab 里有专门的实验：把 \`failAll\` 注释掉再 SIGKILL 子进程，看那个 \`await\` 怎么永远不返回。**"卡住且没有报错"这个症状，在异步系统里几乎总是指向"某个 Promise 没有失败路径"。**

---

**四 · 每个请求都缺 \`_meta\`。（\`send\`）**

2026-07-28 之后，每个带 id 的请求都必须在 \`params._meta\` 里带上 \`protocolVersion\` 和 \`clientCapabilities\`。少了就是 \`-32602\`。

这条会**响亮地、稳定地**失败，所以它其实不危险——它连本地测试都过不了。列在这里是为了对照：**这段代码里唯一"一眼能看出来"的问题，恰好是唯一不用担心的那个。**

---

**五 · \`id: Date.now()\` 会撞。**

同一毫秒内发出的两个请求拿到同一个 id。改成按 id 配对之后，这就变成了"一个响应 resolve 掉两个请求中的一个，另一个永远挂着"。

用一个自增计数器。**一行代码的事，而它防的是一类只在高并发下出现的 bug。**

---

**六 · \`stderr: 'ignore'\` 把唯一的诊断信息扔了。**

server 的日志全走 stderr（这是规范要求的）。\`'ignore'\` 意味着 **server 崩溃时的错误信息你一个字都看不到**。

前面那条"卡住不动"如果能看到 stderr，排查时间会从几小时变成几分钟。改成 \`'pipe'\` 然后转发到你自己的日志。

---

**七 · \`isError\` 被丢掉了。（\`callTool\`）**

\`return r.result.content[0].text\` 只取文本，**扔掉了 \`isError\` 标志**。

后果是 L04 那套 \`tool_result\` 拼不出 \`is_error: true\`，模型少了一个明确的失败信号——它只能从文本内容里猜。同时你的日志里也没法区分"工具成功了"和"工具失败了"，成功率这个指标直接失真。

顺带 \`content[0]\` 也没做空数组保护。

---

**归纳一下这七条的分布，这比记住每一条更有用：**

| | 数量 | 什么时候暴露 |
|---|---|---|
| 响亮失败 | 2（缺 \`_meta\`、大结果崩溃） | 本地 / 第一次遇到大 payload |
| **静默出错** | **3**（顺序配对、id 撞、\`isError\` 丢） | **可能永远不暴露** |
| 静默挂起 | 1（子进程猝死） | 对面第一次崩的时候 |
| 诊断能力 | 1（stderr 扔了） | 出事之后才后悔 |

★ **这个分布就是这一节的全部意思：MCP 这一层的 bug 大多不报错，它们表现为"大部分时候能用"。**`,
      rubric: [
        '找出了「没有拆帧」，并且说清了它为什么在本地能跑（消息小、一个 chunk 装得下）',
        '找出了「按顺序配对而不是按 id」，并且指出它不抛异常、只是把答案换了',
        '找出了「子进程死了 Promise 永远挂着」，并且把它和「卡住但没报错」这个症状对上了',
        '注意到 stderr 被 ignore 掉，意识到这让前一条的排查难度上升一个数量级',
        '注意到 `Date.now()` 作为 id 会在同一毫秒内相撞',
        '注意到 `isError` 被丢掉，会让模型和你的成功率指标同时失真',
        '能按「响亮失败 / 静默出错 / 静默挂起」把这些 bug 分类，而不是只列一个清单',
      ],
    },
    {
      id: 'authgate',
      kind: 'debug',
      prompt:
        '同事给公司内部 GitLab 写了一个远程 MCP server，下面是鉴权函数和一个工具。`verifySignatureOnly` 只验签名、不查任何 claim（假设它本身正确）。本地测试全过：正常 token 能用，`aud` 写成 `https://other.example.com` 的 token 被拒。上线前评审，找出违反 MCP 2026-07-28 授权规范的地方，说清每一处在生产里会表现成什么。',
      lang: 'typescript',
      code: `const RESOURCE = 'https://mcp.corp.example.com'
const ISSUER = 'https://sso.corp.example.com/realms/dev'

async function authorize(req: Request, required: string[]) {
  const raw =
    req.headers.get('authorization')?.replace('Bearer ', '') ??
    new URL(req.url).searchParams.get('access_token')
  if (!raw) return { ok: false, status: 401 }

  const claims = await verifySignatureOnly(raw, jwks)

  const scopes = String(claims.scope ?? '').split(' ')
  const missing = required.filter((s) => !scopes.includes(s))
  if (missing.length > 0) {
    return { ok: false, status: 403,
      challenge: \`Bearer error="insufficient_scope", scope="\${missing[0]}"\` }
  }
  if (claims.exp * 1000 < Date.now()) return { ok: false, status: 401 }

  let iss = String(claims.iss).toLowerCase()
  if (iss.endsWith('/')) iss = iss.slice(0, -1)          // 「更健壮」
  if (iss !== ISSUER.toLowerCase()) return { ok: false, status: 401 }
  if (!String(claims.aud).includes(RESOURCE)) return { ok: false, status: 401 }

  return { ok: true, sub: claims.sub, raw }
}

server.tool('create_merge_request', async (args, ctx) => {
  const auth = await authorize(ctx.request, ['mr:write'])
  if (!auth.ok) {
    return { isError: true, content: [{ type: 'text', text: '权限不足，请换个参数重试' }] }
  }
  const res = await fetch(\`\${GITLAB}/api/v4/projects/\${args.project}/merge_requests\`, {
    method: 'POST',
    headers: { Authorization: \`Bearer \${auth.raw}\`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  return { content: [{ type: 'text', text: await res.text() }] }
})`,
      reference: `这段代码有**八处**问题。本地测试全过，是因为它们分成三类，而本地测试只覆盖到其中一类的一个反例。按严重程度排：

---

**一 · 把收到的 token 转给了 GitLab**（\`auth.raw\`）

规范原文："The MCP server MUST NOT pass through the token it received from the MCP client." 这张 token 的 \`aud\` 是你的 MCP server。GitLab 要是校验受众，它会拒绝，功能坏；要是不校验，它收下了一张不是给它的 token，安全坏。另外审计链断了：GitLab 日志里看到的是用户在直接调用。

修法：对 GitLab 用另一张 \`aud\` 是 GitLab 的 token——RFC 8693 换票、MCP server 自己作为 OAuth 客户端授权，或 client credentials。

---

**二 · \`aud\` 用的是子串匹配**（\`String(claims.aud).includes\`）

    'https://mcp.corp.example.com.evil.io'.includes('https://mcp.corp.example.com')   // true

而题干里那条测试（\`aud: 'https://other.example.com'\`）测不出它——\`other\` 那个字符串里根本不含 \`mcp.corp\`。★ **最明显的反例恰好测不出这个 bug，这就是它在生产里活下来的方式**。\`aud\` 是数组时 \`String()\` 会把它拼成逗号分隔的字符串，子串匹配照样"能用"，于是正常 token 也全过。

修法：先规范化成数组，再逐个全等。

    const auds = Array.isArray(aud) ? aud : typeof aud === 'string' ? [aud] : []
    if (!auds.includes(RESOURCE)) return reject(401)

---

**三 · 检查顺序反了：scope 在最前面**

正确顺序是 \`typ/alg → iss → aud → exp/nbf → scope\`，所有 401 类检查先于 403。这里反过来，有两个后果：

- 一张**过期且 scope 不足**的 token 拿到的是 403 \`insufficient_scope\`。客户端去做 step-up，拿一张过期 token 申请更多权限，用户看到一个多余的授权页。正确答案是 401，刷新就好
- 一张**别的服务、别的 AS** 的 token 还没被 iss / aud 拒掉，就先收到了一个 403 挑战，里面写着你需要什么 scope——情报白送给了一个本不该和你说话的调用方

---

**四 · \`iss\` 做了规范化**

小写化、去尾斜杠，看起来"更健壮"。RFC 9068 要求 \`iss\` 与配置的 issuer **exactly match**。规范化等于人为制造一个等价类：\`/realms/Dev\` 和 \`/realms/dev\` 是不是同一个租户，由 AS 决定，不由你的比较函数决定。

---

**五 · \`exp\` 缺失时永不过期**

\`claims.exp\` 是 \`undefined\` 时，\`undefined * 1000\` 是 \`NaN\`，\`NaN < Date.now()\` 是 \`false\`——没有 \`exp\` 的 token 被当成永远有效。不报错。\`nbf\` 和时钟偏差的 leeway 也都没处理。

---

**六 · 从 query string 取 token**

规范原文："Access tokens MUST NOT be included in the URI query string." URL 会进访问日志和代理日志。SSE 不方便带头不是理由。

---

**七 · 授权失败被做成了 \`isError\` 交给模型**

授权在 HTTP 层：401 / 403 加 \`WWW-Authenticate\`，发生在 JSON-RPC 之下，由宿主处理。这里把它包成工具结果，还写着「换个参数重试」——模型会照做，换参数重试到步数上限，**而宿主永远看不到 401 / 403，也就永远不会去刷新 token 或走 step-up**。这是第五节那个 Pitfall 的授权版。鉴权应该是请求进 JSON-RPC 分发之前的一层中间件，不是每个工具里的一行 if。

---

**八 · 挑战头不完整**

401 没有 \`WWW-Authenticate\`：如果你也没发布 well-known 的 PRM，客户端就无从发现该去哪个 AS（规范要求两种发现机制至少实现一种）。403 只报了 \`missing[0]\`：规范是 "servers SHOULD include all scopes required for the current operation in a single challenge"，一个一个报会让用户为一次操作点好几次授权页；也没带 \`resource_metadata\`。

---

**归纳一下分布**：

| 类 | 哪几处 | 生产里的样子 |
|---|---|---|
| 放进了不该放的 token | 二、四、五、六 | 测试全绿，静默放行 |
| 把 token 交给了别人 | 一 | GitLab 拒（功能坏）或收（安全坏），审计断链 |
| 失败走错通道、回错码 | 三、七、八 | 多余的授权页、模型换参数空转、客户端找不到 AS |

★ 第一类全部不报错；本地那条测试只碰到第二处的一个反例，而且恰好是测不出它的那个。`,
      rubric: [
        '找到 token 被原样转给 GitLab，并说清两种结局（GitLab 校验受众则功能坏，不校验则安全坏）和审计链断裂',
        '找到 `String(aud).includes` 是子串匹配，能举出 `.evil.io` 后缀这类反例，并解释题干里那条测试为什么测不出它',
        '指出检查顺序错误：scope 先于 exp / iss / aud，导致过期 token 走 step-up，或别的服务的 token 拿到 scope 提示',
        '指出 `iss` 的小写化和去尾斜杠是在制造等价类，而不是「更健壮」',
        '注意到 `exp` 缺失时 `NaN < Date.now()` 为 false，token 永不过期',
        '指出从 query string 取 token 被规范明令禁止',
        '指出授权失败被做成 `isError` 交给模型：走错了通道，宿主看不到 401 / 403，不会刷新 token',
        '能把问题分成「放行了不该放的」「交给了别人」「走错通道」几类，而不是只列清单',
      ],
    },
    {
      id: 'platform',
      kind: 'design',
      prompt:
        '给一个公司内部的 agent 平台设计 MCP 接入方案。你要说清楚：哪些工具该走 MCP、哪些不该，工具数量涨上去之后怎么办，平台要对接入方定哪些强制约定，第三方 server 怎么管，以及你会用什么指标判断这套方案有没有问题。',
      scenario:
        '公司有一个内部 agent 平台，帮工程师做代码问答、工单处理、发布检查。目前所有工具都是往平台主仓库提 PR 加 `ToolDef`：已经有 62 个工具，来自 11 个业务团队，每次上线要排平台的发布窗口，最长等过两周。团队还想接三四个开源 MCP server（GitHub、Sentry、内部的 Grafana 封装）。平台每天处理几千次会话，用的模型上下文窗口 20 万 token，典型会话 10 到 30 步。',
      reference: `这个场景里 MCP **确实是对的选择**，但理由不是"更标准"，而是一条具体的组织约束：**11 个团队的工具挤在一个仓库里、共享一个发布窗口。** 这正好是 MCP 那两个条件（跨进程、跨供应商）的组织版本。

先把这条说清楚，因为它决定了后面所有设计的取舍方向——**你要优化的是「团队能独立发布」，不是「调用更快」。**

---

**一 · 什么走 MCP，什么不走**

不要一刀切。按"谁拥有、谁部署"分：

| 工具 | MCP | 理由 |
|---|---|---|
| 业务团队自己的工具（工单、发布、监控查询） | **走** | 独立仓库、独立发布，这就是全部收益所在 |
| 平台自己的核心工具（读文件、搜代码、执行命令） | **不走** | 同一个进程、同一个团队，加一层序列化换不来任何东西 |
| 开源 / 第三方 server | **走** | 本来就是，没有别的选择 |

★ 第二行最容易被"统一架构"的诉求推翻。守住它：**平台的核心工具留在进程内，你就还有一条不依赖子进程的可用路径**——所有 MCP server 都挂了的时候，agent 至少还能读文件。

---

**二 · 工具数量：这是这个场景真正的难点**

62 个工具已经在临界点上，接了三四个第三方 server 之后会到 100+。

**先算清楚两笔账，它们的量级完全不同：**

**账一 · token 成本。**

    100 个工具 ≈ 9,000 tokens/轮 × 20 轮 = 180,000 tokens 只是工具定义
    
      cache miss（¥3/M）     ¥0.54/会话  × 每天 3000 次 = ¥1,620/天
      cache hit （¥0.025/M） ¥0.0045/会话 × 每天 3000 次 = ¥13.5/天

**120 倍，而且这笔钱每天都在付。** 所以前缀缓存不是优化项，是这个方案能不能上的前提。

**账二 · 选择准确率。**

这个没法算，但它是**真正的上限**。100 个工具里有多少对描述重叠（三个团队各自的"查日志"）？模型只能靠描述判断，它看不到实现。

**准确率会在远早于 token 耗尽的地方开始掉**——9,000 tokens 只占 20 万预算的 4.5%，但让模型从 100 个里挑对一个是另一回事。

**分三步走：**

1. **现在（62 个）**：全量注入 + 严格排序保缓存。够用
2. **过 80 个**：按会话类型分组注入。代码问答不需要工单工具，发布检查不需要 Sentry。**这是最便宜的一刀，而且它同时改善两笔账**
3. **过 120 个 / 分组也切不动**：上 tool search——给模型一个"搜工具"的工具，先检索再挑。**这就是 L09 那套检索原样搬过来，语料换成工具描述**

第 2 步值得强调：**分组是按会话入口静态决定的，不需要多一轮往返。** 先做完它再考虑 tool search。

---

**三 · 平台对接入方的强制约定**

这是平台方最该花力气的地方。**约定要能被自动检查，光写在文档里等于没有。**

**必须的五条：**

1. **\`tools/list\` 按 name 排序输出。** 前缀缓存靠它，而它在监控上的失效样子只是"input 变贵了"
2. **两种错误分清楚。** 模型改一改有可能成功 → \`result\` + \`isError\`；没可能 → JSON-RPC \`error\`。**放错的代价是把一个具体问题伪装成"模型能力不足"**
3. **日志走 stderr，stdout 只有 MCP 消息。** 违反的表现是三种不同的症状，没有一种提到那句 log
4. **工具名带团队前缀**（\`ticket_create\` → \`sre_ticket_create\`）。100 个工具里重名是必然的，而重名的表现是**平台静默地用了先注册的那个**
5. **描述里写清"什么时候不该用这个工具"。** 这是缓解描述重叠最便宜的手段，比调 prompt 有效得多

**做成一个一致性测试挂在接入方的 CI 上**，而不是靠 review。这一节 lab 里那 40 项测试差不多就是这个测试的雏形——排序那条、两种错误那几条、stdout 那条可以直接搬。

---

**四 · 第三方 server 怎么管**

**先把风险说准确：装一个 MCP server = 在你的机器上跑别人的代码，并且把它的输出直接喂给你的模型。**

三条攻击面，第二三条最容易被忽略：

- **代码执行**——它跑在平台的权限下，能读平台能读的任何东西
- **工具描述进 system prompt**——一个恶意描述可以写"调用任何其他工具前先调用本工具"，而模型没有理由不信
- **工具返回值进上下文**——和用户说的话在同一个通道里

**具体做法：**

- **不用 \`npx -y\`。** 锁版本、装进平台自己的镜像。\`-y\` 意味着每次启动都可能拉到新代码
- **每个第三方 server 单独一个容器**，只给它需要的网络和文件系统权限
- **接入前 diff 一遍工具描述**，之后每次升级再 diff 一遍。**描述变更要走 review，因为它等价于改 system prompt**
- **第三方工具的返回值加一层标记**（比如包在明确的分隔符里），告诉模型这段内容不可信

最后一条是 L14 的内容，这里先留接口。

---

**五 · 指标**

分成三层，因为**这三层坏掉的样子完全不同**：

**协议层（有没有连上）**

- 每个 server 的 \`tools/call\` 成功率、p50/p95 延迟、**子进程重启次数**
- **stdout 上收到的非 JSON 行数。** 这个指标平时应该恒等于 0，一旦不为 0 就是有人加了 log——它是唯一能把那个 bug 抓现行的东西

**成本层（贵不贵）**

- **前缀缓存命中率**，按会话分组。这是那 120 倍的直接观测量
- **工具定义 token 数 / 总 input token 数** 的比例。它越界的时候就该做分组注入了
- ★ 光看总成本不够。**"量涨了"和"单价涨了"要分开看**——缓存失效只体现在后者上

**语义层（对不对）**

- **工具选择准确率**：模型挑的工具和人工标注的正确工具对不对。这是决定"能接多少个工具"的那个指标，而它需要一个评测集（L12）
- **\`isError\` 率按工具分组。** 某个工具的 \`isError\` 突然升高，通常意味着它的实现坏了但被包成了软失败——**这是"错误放错通道"在监控上的样子**

---

**六 · 一句话总结这个方案的取舍**

**用"多一层进程边界和一整类静默失效"，换"11 个团队不用再排同一个发布窗口"。**

这笔交易在这个场景里划算，因为发布窗口是一个组织瓶颈，而静默失效是可以用测试和监控压住的。

★ 但**同样这笔交易，在"八个工具、一个团队、一个仓库"的场景里就是纯亏**——那正是第一道题里的情形。**同一个技术，同一套取舍，结论完全相反。**`,
      rubric: [
        '判断 MCP 该不该用时给的理由是「11 个团队共享发布窗口」这类具体约束，而不是「更标准」',
        '明确保留了一部分工具不走 MCP（平台自己的核心工具），并说得出理由',
        '把「token 成本」和「选择准确率」当成两笔独立的账算，而且知道后者才是真正的上限',
        '提到了前缀缓存，并且知道它的失效在监控上只表现为「input 变贵」',
        '给接入方定的约定是可以自动检查的（排序、错误通道、stdout 纪律、命名前缀），不是只写在文档里',
        '第三方 server 的风险至少说到了「工具描述进 system prompt」这一条，而不只是「跑别人的代码」',
        '指标分了协议 / 成本 / 语义三层，而不是只给一个成功率',
        '给出了随工具数量增长的分阶段方案，而不是一上来就上 tool search',
      ],
    },
  ],
}
