# L19x 调研：TypeScript Agent 生态专项（AI SDK / Mastra / Claude Agent SDK / OpenAI Agents SDK / Dify·Coze·n8n）

> 调研日期：2026-10-12。状态：完成（§1–§14）。实测工程：`/tmp/l19x-lab`（E1–E6）。
> 置信度标注：[P] 一手直述 / [P2] 一手但需推断 / [S] 二手（只当线索）。
> 源码引用格式：`包名@版本 文件路径`；网页引用格式：URL（访问 2026-10-12）。

## 0. 目录

1. 反转清单 INV-1…N
2. 版本快照（npm registry，2026-10-12）
3. 课程立场回顾：L05「框架到底包装了什么」与 L11x 的形状
4. Vercel AI SDK
5. Mastra
6. Claude Agent SDK
7. OpenAI Agents SDK JS
8. LangGraph.js / Google ADK TS（定位）
9. 本地实测（/tmp 独立工程，零网络 mock）
10. 部件对照表（L05–L19 × 框架）
11. 国内低代码平台：Dify / Coze / n8n
12. 一手证据：arXiv 2609.00006 Harness Engineering
13. Lab 设计提案
14. 结尾：top 5 / 无一手来源清单 / 对照表摘要 / lab 推荐 / 课时主题

---

## 1. 反转清单

格式：**流行说法 / 直觉** → 实际 → 一手证据（原文或实测输出）。〔不变量编号见 §3；详细论证见括号内章节〕。按「与课程手写不变量冲突的程度」排序。

### A. 循环与终止（I-STOP / I-BUDGET）

**INV-1 「框架的 agent 会一直跑到任务完成」** → AI SDK `ToolLoopAgent` 默认 20 步就停，而且停下时 `text` 为空、`finishReason` 是 `tool-calls`，看起来像「还没结束」。证据：`ai@7.0.137 src/agent/tool-loop-agent.ts` 类注释 "default stop condition is isStepCount(20)"；E1-A 实测 20 次模型 / 20 次工具 / `text: ""`。[P]（§4.1、§9）

**INV-2 「撞上限时框架会告诉我为什么停」** → AI SDK 撞上限是正常返回，没有停止原因字段；只有在 dev 模式下打一条日志。证据：日志原文 "The tool loop stopped because it reached the default stopWhen condition, isStepCount(20)."。课程 L05 的 `AgentRun.reason` 在 AI SDK 里不存在。[P]（§4.2）

**INV-3 「`generateText` 传了 tools 就会自动循环」** → 默认 `isStepCount(1)`：执行完第一次工具调用就返回，`text` 为空。证据：E1-B 实测 1 次调用、1 次执行、`text: ""`。[P]（§4.3、§9）

**INV-4 「各框架的默认步数差不多，都能兜住死循环」** → 从 1 到无穷大：AI SDK `generateText` 1 / `ToolLoopAgent` 20 / Mastra 5 / OpenAI Agents 10 / LangGraph.js 25 / ADK 500 / Claude Agent SDK **无上限**；`WorkflowAgent` 原文 "does not apply a default step limit"。[P]（§8 表）

**INV-5 「Claude Agent SDK 有默认的轮数或预算上限」** → `maxTurns`、`maxBudgetUsd` 都没有默认值；即使设了预算，原文 "Spend can therefore pass the cap by up to the cost of that one response"——**先花后查**，与 I-BUDGET 相反。E5 默认配置下实测死循环到我手动 abort（第一次未加保护时跑到 Node 堆溢出）。[P]（§6.2、§6.6）

**INV-6 「OpenAI Agents SDK 撞上限会返回部分结果」** → 抛 `MaxTurnsExceededError`（默认 10 轮）；要正常返回必须配 `errorHandlers.maxTurns`。证据：`agents-core/dist/runner/constants.mjs` `DEFAULT_MAX_TURNS = 10`；E6-A 抛 "Max turns (10) exceeded"，E6-E 加 handler 后返回 `finalOutput`。[P]（§7.2）

**INV-7 「Mastra 恢复流（resumeStream）沿用原来的 maxSteps」** → 不传就落回小默认值并中途结束。证据：`@mastra/core@1.76.0` 注释原文 "a missing `maxSteps` on resume silently caps the resumed run at the agent's small default and ends it mid-task"。[P]（§5.2）

### B. 工具错误（I-ERR）

**INV-8 「框架会把工具异常脱敏后再给模型」** → AI SDK（`error.toString()`）、Mastra（`error.message`）、Claude Agent SDK（`error.message` + `is_error`）三家都把异常原文塞进上下文。证据：同一个抛 `ENOENT ... (secret=sk-123)` 的工具，三家实测回填里都出现了 `sk-123`。[P]（§4.4、§5.2、§6.6、§7.3 表）

**INV-9 「框架默认会把错误信息好好告诉模型」** → OpenAI Agents SDK 默认回填固定文案，信息全丢，还让模型「再试一次」。证据：`agents-core/dist/tool.mjs` `return 'An error occurred while running the tool. Please try again.';`，注释 "Returns a fixed message without inspecting the exception."；E6-A：10 次相同失败。默认情况下 trace 里也只有 `REDACTED_TOOL_ERROR_MESSAGE`。[P]（§7.3）

**INV-10 「MCP 工具返回 `isError: true`，框架会映射成 `is_error`」** → AI SDK 的 MCP 路径把它当成功结果，`is_error` 缺失，tracing 也记为成功。证据：`@ai-sdk/mcp@2.0.73 src/tool/mcp-client.ts:1314` `if (result.isError) { return result; }`；E2 实测线上 `tool_result` 无 `is_error`。[P]（§4.9）

**INV-11 「设好 `is_error` 就够了」** → 课程默认模型的端点（DeepSeek Anthropic 兼容）忽略 `is_error`，模型只看文本。证据：DeepSeek 兼容表 `is_error` 一行标注 Ignored（§4.15 原表）。→ 错误**文本**才是唯一承重的信号。[P]（§4.15）

**INV-12 「UI 层把错误遮住只影响展示」** → 在 `useChat` 标准模式下，遮罩后的文本会在下一轮成为模型历史：同一个错误第 N 轮是 "Error: ENOENT a.ts; 试试 src/a.ts"，第 N+1 轮变成 "An error occurred."。证据：`to-ui-message-stream.ts:29` `onError = () => 'An error occurred.'`；E2 实测。历史被改写，前缀缓存同时失效。[P]（§4.10）

**INV-13 「审批被拒 = 一个 `is_error` 的工具结果，模型知道为什么」** → AI SDK 拒绝映射成普通内容（`is_error` 为 `undefined`）；OpenAI Agents SDK 回填 "Tool execution was not approved."，不带原因。[P]（§4.4、§7.4，E1-E、E6-C）

### C. 中断、恢复、幂等（I-HIST / I-IDEM）

**INV-14 「abort 之后能拿到已经完成的步骤」** → AI SDK 直接抛 `AbortError`，返回值不存在；只有你自己在 `onStepEnd` 里落盘的那部分还在。证据：E1-D 实测。[P]（§4.5）

**INV-15 「workflow 的 resume 从断点那一行继续」** → Mastra 把整个 step 从头重跑，`suspend()` 之前的副作用会再执行一次。证据：文档 "When a workflow is suspended, it restarts from the step where it paused."；E3 实测 db 行数 1 → 2。[P]（§5.3）

**INV-16 「审批后恢复是幂等的」** → OpenAI Agents SDK 用同一份序列化 `RunState` 恢复两次，有副作用的工具执行两次。证据：E6-B 实测工具执行次数 1 → 2。AI SDK 的 `WorkflowAgent` 文档也明说 "completed-step replay does not guarantee exactly-once effects for an interrupted attempt"。[P]（§7.4、§4.13）

**INV-17 「框架会帮我处理重试的幂等性」** → 四家都不生成任何幂等键；AI SDK 默认 `maxRetries: 2` 直接重发。唯一的例外是 OpenAI Agents SDK 对**模型请求**做了「重放安全」分类（"the default retry advice does not automatically repeat the request"），但不覆盖工具副作用。[P]（§4.6、§7.4、§10 L08 行）

**INV-18 「`prepareStep` 改 messages 只影响当前这一步」** → 返回的列表会成为后续所有步骤的基底。证据：原文 "that changed list becomes the base for later steps"。[P]（§4.14）

**INV-19 「resumable stream 的 `stop()` 会取消生成」** → 只是断开连接，后台继续跑。证据：原文 "It is not a request to cancel the underlying work."。[P]（§4.12）

**INV-20 「fork 出来的会话是干净的」** → Claude Agent SDK fork 完整回放父会话历史（包括里面泄露的敏感串），`total_cost_usd` 也从父会话累计值继续算。证据：E5-C 实测 0.0024 ⊃ 0.0018；`sdk.d.ts:5746` "a resumed or forked session continues from the totals its transcript saved"。[P]（§6.6）

### D. 权限与 guardrail（I-DENY）

**INV-21 「Claude Agent SDK 默认每个危险操作都会问我」** → 干净环境下默认 `permissionMode` 是 `auto`：由一个模型分类器替你批。证据：E5-A `init.permissionMode = "auto"`；`sdk.d.ts` "else `'auto'` where that is the default"。[P]（§6.2、§6.6）

**INV-22 「设了 `model` 就只会调用这个模型」** → `auto` 模式每次工具调用会额外发约 10 次分类器请求，模型名写死为 `claude-sonnet-5`；接 DeepSeek 时按映射规则落到 `deepseek-flash`。分类器失败时失败即拒，并提示模型 "try this action again as-is"。证据：E5-A 请求日志。[P]（实测）+ [P2]（DeepSeek 映射推论）（§6.6）

**INV-23 「SDK 里自己注册的进程内工具默认可用」** → Claude Agent SDK 在 `default` 模式下仍要权限，被拒后 `result.subtype` 依然是 `success`。证据：E5-A3 "Claude requested permissions to use mcp__lab__boom, but you haven't granted it yet."。[P]（§6.6）

**INV-24 「审批状态在服务端，客户端改不了」** → AI SDK `useChat` 模式下历史是客户端输入，默认不签名。证据：原文 "a client that crafts a valid-looking approval for a schema-conforming input can bypass the human-in-the-loop step" 与 "No secret configured: approvals work as before"。[P]（§4.7）

**INV-25 「guardrail 在模型之前执行」** → OpenAI Agents SDK 输入 guardrail 默认与模型**并行**，而且只对第一个 agent 生效。证据：`guardrail.mjs:4` `runInParallel = true`；文档 "the model may already have consumed tokens or run tools if the guardrail later triggers"；E6-D 实测触发前模型已被调用 1 次。[P]（§7.5）

**INV-26 「handoff 只把任务交给下一个 agent」** → 默认把整段对话历史交出去。证据：原文 "By default a handoff receives the entire conversation history."。[P]（§7.6）

### E. 可观测性与成本（I-TRACE / I-BUDGET）

**INV-27 「tracing 默认是本地的，要我自己接」** → OpenAI Agents SDK：`import '@openai/agents'` 即注册 OpenAI exporter，默认开启、默认包含模型输入输出。证据：`agents/dist/index.mjs` 第 5 行 `setDefaultOpenAITracingExporter();`；`run.mjs:121` `traceIncludeSensitiveData ?? true`；文档 "the default tracing setup already exports to OpenAI"。AI SDK 7 的 telemetry："Enabled by default when a telemetry integration is registered"，输入记录也默认开启。[P]（§7.1、§10）

**INV-28 「SDK 报告的成本就是全部成本」** → Claude Agent SDK 的 `total_cost_usd` 不含权限分类器，按 Claude 价目计算（对 `deepseek-v4-pro` 也算出非零值），fork 还会继承父会话累计。证据：`sdk.d.ts:5746` "Internal helper calls outside the query pipeline (e.g. the permission classifier, token-count probes) are excluded"。[P]（§6.6）

**INV-29 「接 DeepSeek 时输出长度用的是模型的默认值」** → AI SDK 的 Anthropic provider 对未知模型 ID 静默限到 4096 token。证据：E1-G 警告原文 "The max output tokens have been limited to 4096. Set maxOutputTokens explicitly to override this limit."。[P]（§4.8）

**INV-30 「Mastra 的默认 memory 对缓存友好」** → 默认 10 条滑动窗口，官方文档承认 "invalidates the provider prompt cache"。[P]（§5.4）

### F. thinking 与协议（I-THINK）

**INV-31 「thinking 签名有问题会报错」** → AI SDK 流式路径缺签名时**静默丢弃** thinking 块（只有一条 warning）；非流式路径则直接报 `Invalid JSON response`。同一个问题，两条路径行为相反。而 DeepSeek 原文："If your code does not correctly pass back `reasoning_content`, the API will return a 400 error."。证据：E4 实测。[P]（§4.15、§9）

**INV-32 「`reset-step` 是 AI SDK 流协议的一部分，重试时会发」** → 协议里有定义，`streamText`/`ToolLoopAgent` 从不发出；只有 `WorkflowAgent` 会发。证据：`ai@7.0.137 src/` grep 结果。[P]（§4.11）

### G. 「它是什么」层面的误解

**INV-33 「Claude Agent SDK 是一个纯 TS 库」** → 它驱动一个约 240MB 的原生 Claude Code 二进制；`env` 选项会**替换**整个子进程环境；默认加载你机器上所有的 settings 来源。证据：官方表格 "A library that runs the Claude Code binary"；`sdk.d.ts` "this value REPLACES the subprocess environment entirely"、"When omitted, all sources are loaded"。[P]（§6.1、§6.2）

**INV-34 「用 Agent SDK 就等于得到 Claude Code」** → 工具集是 Claude Code 的，但默认 system prompt 只有一句 "You are a Claude agent, built on Anthropic's Claude Agent SDK."；要完整行为必须显式用 `preset: 'claude_code'`。证据：E5 请求体。[P]（§6.6）

**INV-35 「OpenAI Agents SDK 是 provider 无关的」** → 内核层面成立（E6 用 30 行自写 `Model` 跑通），但伞包 import 即注册 OpenAI provider 和 exporter，一批功能只在 Responses API 上有，在 Chat Completions 上 "warned and ignored"。[P]（§7.7）

**INV-36 「Dify 是 Apache 2.0 开源」** → 是附加条件的变体：多租户（一个 workspace 即一个租户）需书面授权、不得去掉前端 LOGO、贡献者同意许可可被收紧。证据：`langgenius/dify@main/LICENSE` 原文。[P]（§11.2）

**INV-37 「Dify DSL 导出就能在另一套环境复现应用」** → 知识库内容不在 DSL 里，`dataset_ids` 用原租户 id 加密，凭据 id 被删，还夹带 UI 坐标。证据：`api/services/app_dsl_service.py:995-1012`。[P]（§11.2）

**INV-38 「n8n 开源，可以嵌进自己的产品卖」** → Sustainable Use License 原文 "only for your own internal business purposes or for non-commercial or personal use"。[P]（§11.4）

**INV-39 「论文证明了生产环境不用 agent 框架，所以 AI SDK 这类东西都不该用」** → 论文的检查清单不含 AI SDK / Mastra / Claude Agent SDK / OpenAI Agents SDK，并且明确把 OpenCode 依赖的 AI SDK 归为 "a provider-abstraction layer, not an agent-orchestration framework"；它的结论是「harness 取代了框架并且自己变成了可导入的 SDK」。平台侧反而在用框架：Dify Agent "runs Pydantic AI"，Coze Studio 运行时基于 Eino。[P]（§12、§11）

**INV-40 「Mastra 的 scorer 会同步给每次运行打分」** → 原文 "Live evaluations run in the background"，按 trace ID 确定性采样，忘了注册的 scorer 原文 "the scores never reach the store"（只有一条 warning）。[P]（§5.5）

## 2. 版本快照

数据来源：`npm view <pkg> version` 与 `time.modified`，2026-10-12 本机执行 [P]。

| 包 | 最新版本 | registry 最后修改 | 角色 |
| --- | --- | --- | --- |
| `ai` | 7.0.137 | 2026-10-09 | Vercel AI SDK 核心（`ToolLoopAgent` / `streamText` / UI message stream） |
| `@ai-sdk/anthropic` | 4.0.78 | 2026-10-09 | Anthropic provider（支持 `baseURL`） |
| `@ai-sdk/deepseek` | 3.0.63 | 2026-10-08 | DeepSeek 官方 provider（OpenAI 兼容端点） |
| `@ai-sdk/openai-compatible` | 3.0.67 | 2026-10-08 | 通用 OpenAI 兼容 provider |
| `@ai-sdk/react` | 4.0.140 | 2026-10-09 | `useChat` |
| `@ai-sdk/mcp` | 2.0.73 | 2026-10-09 | MCP client（从 `ai` 主包拆出） |
| `@ai-sdk/provider` | 4.0.26 | 2026-10-08 | LanguageModel 规范（V3/V4 接口） |
| `@mastra/core` | 1.76.0 | 2026-10-11 | Mastra 核心（Agent / Workflow / Memory 接口） |
| `mastra` | 1.34.0 | 2026-10-11 | CLI + Studio |
| `@mastra/memory` | 1.37.0 | 2026-10-11 | Memory 实现 |
| `@mastra/evals` | 1.10.6 | 2026-10-11 | scorers |
| `@mastra/libsql` / `@mastra/pg` | 1.26.0 / 1.31.0 | 2026-10-11 | 存储适配 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.296 | 2026-10-09 | Claude Agent SDK（TS） |
| `@anthropic-ai/claude-code` | 2.1.296 | 2026-10-09 | Claude Code CLI（注意与 SDK 补丁号同步：x.x.296） |
| `@openai/agents` | 0.20.0 | 2026-10-08 | OpenAI Agents SDK JS（聚合包） |
| `@openai/agents-core` / `-openai` / `-extensions` / `-realtime` | 0.20.0 | 2026-10-08 | 子包 |
| `@langchain/langgraph` | 1.4.21 | 2026-10-07 | LangGraph.js |
| `@langchain/core` / `langchain` | 1.2.17 / 1.5.16 | 2026-10 | LangChain.js |
| `@google/adk` | 2.2.1 | 2026-10-06 | Google ADK TypeScript |
| `@modelcontextprotocol/sdk` | 1.32.1 | 2026-10-05 | MCP 官方 TS SDK |

几条从版本号本身就能读出的事实：

- **两个 0.x。** `@anthropic-ai/claude-agent-sdk@0.3.x` 与 `@openai/agents@0.20.0` 仍是 0.x —— 按 semver，0.x 的 minor 升级可以破坏 API。课程 lab 若安装它们，必须铁定精确版本（不写 `^`）。[P2]
- **Mastra 迭代极快。** `@mastra/core` 1.76.0 意味着 1.0 之后发了 76 个 minor；所有 `@mastra/*` 包同日发布。[P2]
- **Claude Agent SDK 与 Claude Code CLI 补丁号锁步**（0.3.296 ↔ 2.1.296）—— 这与「SDK 是驱动 CLI 二进制的库」一致，见 §6。[P2]
- 课程 L16 引用的是 `ai@7.0.101`，到今天已到 7.0.137（36 个补丁）。

---

## 3. 课程立场回顾：本课要回答的三个问题

L19x 不教「怎么调框架」。学员已经手写过每一个部件，本课只回答三个问题：

1. **它藏了什么**：你手写的哪一段代码，在框架里变成了哪一个参数、哪一个默认值？（§10 对照表）
2. **哪些默认值会咬人**：框架默认值与课程不变量冲突的地方（§1 反转清单）。课程的不变量在这里列一次，后文直接引用编号：
   - **I-STOP**（L05）每次运行都有显式的停止原因，且撞上限是正常返回；
   - **I-BUDGET**（L05/L15）先查预算再花钱，所有调用（包括辅助调用）都计入成本；
   - **I-ERR**（L05/L14）工具错误以 `is_error` 回填，文本给出下一步出路，且经过脱敏；
   - **I-HIST**（L06/L08）历史只追加，前缀稳定，中断后已完成的步骤可见；
   - **I-IDEM**（L08/L19）有副作用的操作带幂等键，重放到断点不重复执行；
   - **I-DENY**（L14）审批先拒后放，审批状态存服务端，客户端不能伪造；
   - **I-TRACE**（L13）span 去哪由你决定，默认不出网；
   - **I-THINK**（L15/L16）thinking 与签名原样回传，缓存断点由你放。
3. **怎么选**：平台、框架、手写三者的边界（§11.5、§12.2、§14）。

与 L11x 的形状对齐：L11x 以 Python 为主通道、TS 为对照；L19x 反过来，TS 为主通道、Python 只观测。

---

## 4. Vercel AI SDK（`ai@7.0.137`）

> 一手来源：npm 包 `ai@7.0.137` 自带 `src/`（未编译 TS 源码）与 `docs/`（官网文档的 MDX 源）。下文的源码引用都来自 `/tmp/l19x-lab/node_modules/ai/` 本地安装，可复现。

### 4.1 `ToolLoopAgent` 只是 `generateText`/`streamText` 外面包了一层默认值

`ai@7.0.137 src/agent/tool-loop-agent.ts` 的类注释原文 [P]：

> "The loop continues until:
> - A finish reasoning other than tool-calls is returned, or
> - A tool that is invoked does not have an execute function, or
> - A tool call needs approval via `toolApproval` or tool-level `needsApproval`, or
> - A stop condition is met (default stop condition is isStepCount(20))"

它的 `generate()` 方法就是把设置合并后调用 `generateText`（`stream()` 调 `streamText`），唯一实质性的「agent 默认值」是这一行 [P]：

```ts
// ai@7.0.137 src/agent/tool-loop-agent.ts
stopWhen: this.settings.stopWhen ?? createDefaultStopCondition(20),
```

而裸 `generateText` 的默认是 **1 步** [P]：

```ts
// ai@7.0.137 src/generate-text/generate-text.ts:247
stopWhen = isStepCount(1),
```

→ **同一个库里两个入口默认值差 20 倍。** 学员如果从 `generateText({ tools })` 起步，会得到「工具执行了、但没有最终回答」的结果（见 §9 E1-B 实测：模型调用 1 次、工具执行 1 次、`text` 为空、`finishReason='tool-calls'`）。

默认 20 步触发时只打一条 warning，不抛异常 [P]（`src/agent/default-stop-condition.ts`）：

> "The tool loop stopped because it reached the default stopWhen condition, isStepCount(20). To allow more steps, set stopWhen to isStepCount(...) with a higher limit or provide a custom stop condition."

文档补充 [P]（`docs/03-agents/04-loop-control.mdx`）：

> "`WorkflowAgent` does not apply a default step limit. It continues until the model stops calling tools or another natural termination condition is met."

### 4.2 「为什么停」：AI SDK 不告诉你

课程 L05 的不变量：**终止时必须返回 reason**（`done | step_limit | budget | timeout | cancelled | error`）。AI SDK 的返回值里只有**最后一步的** `finishReason`（`stop | length | content-filter | tool-calls | error | other`）。撞上步数上限时，最后一步的 `finishReason` 是 `tool-calls`——和「停在审批请求上」「调了一个没有 execute 的工具」完全同值（§9 E1-A、E1-E 实测都是 `tool-calls`）。[P]（实测）

要区分这几种停止，调用方必须自己看 `steps.length === N`、`content` 里有没有 `tool-approval-request`。**这正是 L05 那个 Pitfall 的原样复现**：「撞上步数上限时，你返回的是模型最后一次说的话——那句话看起来像一个答案」——而在 AI SDK 里更糟，`text` 直接是空串。

### 4.3 循环的真实继续条件

`ai@7.0.137 src/generate-text/generate-text.ts:1515-1523` [P]：

```ts
} while (
  // Continue only after all client tool calls have been executed or denied,
  // and if there are client results or pending deferred provider results.
  clientToolOutputs.length + deniedToolApprovalResponses.length ===
    clientToolCalls.length &&
  (clientToolCalls.length > 0 || pendingDeferredToolCalls.size > 0) &&
  // continue until a stop condition is met:
  !(await isStopConditionMet({ stopConditions, steps }))
);
```

几点从源码读出的事实：

1. **stopWhen 在一步完成之后评估**（do…while 的尾部）。课程 L05 要求「在花钱之前检查」预算；用 `stopWhen` 写预算条件（官方文档 `budgetExceeded` 示例就是这么写的）只能在**已经花完这一步之后**才停。[P2]
2. `isStepCount(n)` 的实现是 `steps.length === stepCount`（严格相等，不是 `>=`）[P]（`src/generate-text/stop-condition.ts`）。正常使用没问题，但如果有人写 `isStepCount(0)`，它**永远不会触发**。[P2]
3. 多个 stop 条件用 `Promise.all(...).some()` 并行评估（同文件 `isStopConditionMet`）——任何一个返回 true 就停。[P]

### 4.4 工具报错：catch 住、`error.toString()`、回填 `is_error`

`ai@7.0.137 src/generate-text/execute-tool-call.ts` 把 `execute` 包在 try/catch 里，异常被变成一个 `{ type: 'tool-error', error }` 内容块，**不会中断循环** [P]。回填给模型时：

```ts
// ai@7.0.137 src/prompt/create-tool-model-output.ts
if (errorMode === 'text') {
  return { type: 'error-text', value: getErrorMessage(output) };
}
// @ai-sdk/provider@4.0.26 src/errors/get-error-message.ts
if (error instanceof Error) { return error.toString(); }
```

`@ai-sdk/anthropic@4.0.78 src/convert-to-anthropic-prompt.ts` 再把 `error-text` / `error-json` 映射成 `is_error: true` [P]：

```ts
is_error:
  output.type === 'error-text' || output.type === 'error-json'
    ? true
    : undefined,
```

与课程不变量的差异：

| 课程不变量（L04/L05） | AI SDK 默认 |
| --- | --- |
| 错误信息要「给出路」，由工具作者写给模型看 | 原样 `Error.toString()`——`"Error: ENOENT: ..."`，**包括异常消息里的任何敏感串**（§9 E1-A 实测：`secret=sk-123` 原样进了下一次请求） |
| 参数校验失败 → 包成 `INVALID_JSON`/`INVALID_ARGS` 回填 | 一致：`AI_InvalidToolInputError: Invalid input for tool add: AI_TypeValidationError...` 作为 `error-text` 回填，循环继续（E1-C） |
| 调用不存在的工具 → 回填错误 | 一致：`NoSuchToolError` 作为 `error-text` 回填（E1-C） |
| 重复调用检测（同参数 >2 次回填提示） | **没有。** 同一个失败调用被执行 20 次直到撞默认上限（E1-A：模型 20 次、工具 20 次） |
| 审批被拒 → 回填 `is_error` | **不是 is_error。** `execution-denied` 在 Anthropic provider 里映射成 `content: reason ?? 'Tool call execution denied.'`，`is_error` 为 `undefined` [P] |

### 4.5 中断：返回值里没有已完成的步

E1-D 实测：第 3 步时 `abort()`，`agent.generate()` **直接抛 `AbortError`**，前两步的 `steps`、`response.messages` 都不在返回值里；只有 `onStepEnd` 回调里记录到 `[0,1]`。[P]（实测）

→ 课程 L08/L16 的不变量是「中断后历史里剩什么必须是确定的，而且要能续跑」。在 AI SDK 里，**这件事要你自己在 `onStepEnd` 里落盘**；不落盘，中断等于整次运行的上下文全部丢失。`streamText` 的流式路径另有 `onAbort` 回调（见 4.9）。

### 4.6 重试：默认 2 次、指数退避、无幂等键

`ai@7.0.137 src/util/prepare-retries.ts`：`defaultMaxRetries = 2`；`src/util/retry-with-exponential-backoff.ts`：`initialDelayInMs = 2000, backoffFactor = 2`，并尊重 `retry-after-ms` / `retry-after` 头（仅当 0–60 秒内）[P]。E1-F 实测：429 可重试错误 → 共 3 次调用后抛 `AI_RetryError`。

重试的单位是**一次模型调用**，不是一步，也不重放工具；所以模型调用重试本身对工具是安全的。但 SDK **不生成任何幂等键**——课程 L19 那套「三层 key」（请求 key / 作业 key / 工具副作用 key）SDK 一层都没有。[P2]

### 4.7 审批：`needsApproval` 已被 `toolApproval` 取代；历史是客户端可控输入

`@ai-sdk/provider-utils@5.0.58 src/types/tool.ts` [P]：

> "Whether the tool needs approval before it can be executed.
> @deprecated Tool approval is handled on a `generateText` / `streamText` level now."

`docs/03-agents/06-tool-approvals.mdx` [P]：

> "Use `needsApproval` only with [`WorkflowAgent`], where approvals suspend and resume durable workflow execution."

> "Subagent tools cannot use `toolApproval`"

四种状态：`'not-applicable' | 'approved' | 'denied' | 'user-approval'`。**审批不是「暂停」，是「这次 generate 结束」**：返回值里带 `tool-approval-request`，调用方要把 `tool-approval-response` 追加进 messages 再调一次 `generate`（E1-E 实测：第一次工具执行 0 次、`finishReason='tool-calls'`；拒绝后模型收到 `{type:'execution-denied', reason:'no'}`）。

最承重的一段在安全章节 [P]：

> "In the standard `useChat` pattern, the server rebuilds the conversation from the messages the client sends each turn. The server does not persist conversation state between requests. This means the message history is client-controlled input."

> "However, without additional protection, a client that crafts a valid-looking approval for a schema-conforming input can bypass the human-in-the-loop step."

解决办法是 `experimental_toolApprovalSecret`（HMAC 签名），文档原文："No secret configured: approvals work as before (backward compatible)"——**默认是不签名的**。[P]

→ 这和课程 L14/L19「审批记录在服务端、deny 优先」的不变量正面冲突：**AI SDK 默认的审批状态存在客户端发来的消息里**。

### 4.8 Anthropic 兼容端点（DeepSeek）：未知模型 ID 默认输出上限 4096

`@ai-sdk/anthropic@4.0.78 src/anthropic-language-model.ts` 的 `getModelCapabilities` 最后一个分支 [P]：

```ts
} else {
  // Non-Claude models (e.g. served through Anthropic-compatible APIs)
  // keep conservative defaults.
  return {
    maxOutputTokens: 4096,
    supportsStructuredOutput: false,
    ...
    isKnownModel: false,
  };
}
```

E1-G 实测：`createAnthropic({ baseURL: 'https://api.deepseek.com/anthropic/v1' })` + 模型 `deepseek-v4-pro`，每一步都触发警告：

> "The model "deepseek-v4-pro" is unknown. The max output tokens have been limited to 4096. Set maxOutputTokens explicitly to override this limit."

后果：DeepSeek V4 的 thinking + 长代码编辑很容易超过 4096 token → `stop_reason: max_tokens` → 工具参数被截断（课程 L16 的 `truncated` 状态）。**学员换了 provider 不改 `maxOutputTokens`，capstone 的编辑工具会随机截断。** 另外 `supportsStructuredOutput: false` 意味着结构化输出走 `jsonTool` 模式（注入一个 json 工具并强制 tool_choice），依赖端点支持强制工具调用。[P]

同一实测里还确认了：
- **thinking 块原样回传**：第一次响应的 `{type:'thinking', signature:''}` 在第二次请求里仍是 `["thinking","tool_use"]` 顺序。源码分支：有 `signature`（即使是空串）就回传；**既没有 signature 也没有 redactedData 时整块丢弃并给 warning `unsupported reasoning metadata`**（`convert-to-anthropic-prompt.ts:774-820`）。`sendReasoning` 默认 `true`。[P]
- **默认不打缓存断点**：请求体里没有 `cache_control`。要缓存必须在 message 的 `providerOptions.anthropic.cacheControl` 上显式标；最多 4 个，超出的被**静默忽略 + warning**（`get-cache-control.ts`：`MAX_CACHE_BREAKPOINTS = 4`）。[P]

### 4.9 MCP client：`isError: true` 在半路丢了

`@ai-sdk/mcp@2.0.73 src/tool/mcp-client.ts:1314` [P]：

```ts
const result = await self.callTool({ name, arguments: args, options: { signal: options?.abortSignal } });
if (result.isError) {
  return result;          // ← 不抛，原样作为「成功的」返回值
}
```

随后 `mcpToModelOutput` 把 `result.content` 转成 `{ type: 'content', value: [...] }`——**没有看 `isError`**。而 Anthropic provider 只对 `error-text`/`error-json` 设 `is_error: true`（§4.4）。

§9 E2-MCP 实测：内存 MCP 传输让 `tools/call` 返回 `{content:[{type:'text',text:'EACCES: permission denied'}], isError:true}`，走真 `@ai-sdk/anthropic` provider + 假 fetch，第二次请求里的块是：

```json
{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"EACCES: permission denied"}]}
```

`step.content` 里是 `tool-result` 而不是 `tool-error`；**`is_error` 字段缺失**。[P]（实测 + 源码）

→ 课程 L10 的不变量「MCP 的 `isError` 必须映射成 Anthropic 的 `is_error`」在 AI SDK 的 MCP 路径上不成立。模型只能从文本内容猜这是失败；`onToolExecutionEnd`、tracing 里这次调用也会被记为成功——L13 的错误率指标被系统性低估。

### 4.10 UI 消息流：错误默认被遮住，而且**下一轮历史会变**

`ai@7.0.137 src/ui-message-stream/to-ui-message-stream.ts:29` [P]：

```ts
onError = () => 'An error occurred.', // masks errors except provider-executed tool execution errors
```

`to-ui-message-chunk.ts:310-323`：客户端执行的工具报错，`tool-output-error.errorText = onError(part.error)`。

§9 E2-UI 实测（`streamText` → `toUIMessageStream()` → `readUIMessageStream` → `convertToModelMessages`）：

| 视角 | 模型/用户看到的工具错误 |
| --- | --- |
| 同一次请求内的第 2 步（服务端内存里的 messages） | `Error: ENOENT a.ts; 试试 src/a.ts` |
| UI 消息里的 `errorText` | `An error occurred.` |
| **下一轮**：服务端按 `useChat` 标准模式从客户端发来的 UI 消息重建历史 | `{"type":"error-text","value":"An error occurred."}` |

→ 同一个工具错误，模型在第 N 轮看到的是带出路的完整报错，第 N+1 轮看到的是 `An error occurred.`。**历史不是 append-only 的，它在序列化往返中被改写了。** 这同时打破课程两条不变量：L04「错误信息要给出路」（出路在下一轮丢了），L15「前缀稳定才能命中缓存」（同一位置的 tool_result 内容变了，此后的缓存前缀全部失效）。修法是服务端持久化 model messages（`response.messages`），或给 `toUIMessageStream` 传自定义 `onError`；但默认值是遮。[P]（实测）

### 4.11 `reset-step`：协议里有，`streamText` 不发

课程 L16 引用了 UI 消息流协议里的 `reset-step`。在 `ai@7.0.137` 的 `src/` 全文搜索 `reset-step`，只有两处：`ui-message-chunks.ts`（schema 定义）与 `ui/process-ui-message-stream.ts:944`（客户端处理）——**`streamText`/`ToolLoopAgent` 的服务端路径从不发出它**。[P]（源码 grep）

文档写明发出方是 `WorkflowAgent` [P]（`docs/03-agents/07-workflow-agent.mdx`）：

> "The transform also forwards `reset-step` events emitted by `WorkflowAgent` on retries."

而 `streamText` 自己的流内重试（`streamRetries`，默认关闭）注释原文 [P]（`src/generate-text/stream-text.ts`）：

> "Partial output from a failed attempt that was already emitted cannot be retracted and remains in consumer-facing streams. It is excluded from the recovered step result, structured output parsing, response messages, and subsequent model steps."

→ 打开 `streamRetries` 而不用 `WorkflowAgent`，你得到的正是 L16 实验三那个「只会 append 的前端」：UI 上重复半句话，但模型历史里没有。**UI 与 model messages 再次分叉。**

### 4.12 可恢复流：`stop()` 不是取消

`docs/04-ai-sdk-ui/03-chatbot-resume-streams.mdx` [P]：

> "In a resumable stream setup, client-side aborts are treated as disconnects."

> "Because of this, a client-side abort (e.g. closing the page or refreshing) only closes the current HTTP connection. It is not a request to cancel the underlying work. If your stop button only calls `stop()`, the model request, background job, workflow, or stream writer can continue running, and the client can reconnect to the same active stream."

依赖：`resumable-stream` 包 + Redis。这与课程 L19 §8.1「连接只是作业日志的一个读者」完全同构——但在 AI SDK 里，取消必须**你自己**另写一条 `cancelActiveWork` 通道（文档原文："`markStreamAsStopped` and `cancelActiveWork` depend on your backend"）。

### 4.13 `ToolLoopAgent` vs `WorkflowAgent`：持久化是另一个包、另一个运行时

`docs/03-agents/07-workflow-agent.mdx` [P]：

> "A standard `ToolLoopAgent` runs entirely in memory — if the process crashes, all progress is lost."

`WorkflowAgent`（`@ai-sdk/workflow` + `workflow@5`，Vercel Workflow 运行时）提供：工具标 `'use step'` 后成为持久步骤，**"Automatic retries — Failed tool calls are retried automatically (default: 3 attempts)"**；审批用 `needsApproval` 挂起工作流，"the user can approve hours later and the agent will resume"。

但同一文档的示例 `bookFlightStep` 是一个**不带任何幂等键的 POST**，而文末才说 [P]：

> "Workflow reuses completed durable model and tool steps on replay. Put external side effects inside step functions and use the external service's idempotency mechanism where necessary: completed-step replay does not guarantee exactly-once effects for an interrupted attempt."

→ 默认「失败自动重试 3 次」+ 示例里不带幂等键的写操作 = 课程 L19 §5.1「无 key 的不安全写，不自动重试」的反例教材。[P2]

### 4.14 `prepareStep`：返回的 messages 会**持久成为后续步骤的基底**

`docs/03-agents/04-loop-control.mdx` [P]：

> "When you return a `messages` override from `prepareStep`, that changed list becomes the base for later steps. New assistant and tool response messages are appended to it as the loop continues."

这是 L06 上下文压缩的挂载点（官方示例就是 `pruneMessages` 做压缩）。注意两点：(1) 压缩一旦返回就不可逆，原始消息要从 `initialMessages` + `responseMessages` 重建；(2) `prepareStep` 里覆盖 `model`/`maxOutputTokens` 等**只对当前步生效**，覆盖 `messages` 却**持续生效**——同一个回调里两种语义。[P]

另：`ai@7` 还引入了 `docs/03-ai-sdk-harnesses/`（`HarnessAgent`、harness adapters、skills）——AI SDK 自己也开始提供「harness」层。本报告未深入，列为待查。

### 4.15 DeepSeek 端点本身：`is_error` 和 `cache_control` 都被忽略

课程用的是 DeepSeek V4 的 Anthropic 兼容端点。**框架的很多「默认值反转」在这个端点上会被二次反转**，因为端点自己就不认这些字段。DeepSeek 官方兼容性表（https://api-docs.deepseek.com/guides/anthropic_api ，访问 2026-10-12）[P]：

| 字段 | 官方标注 |
| --- | --- |
| `tool_result.is_error` | **Ignored** |
| `tools[].cache_control` / `text.cache_control` / `tool_use.cache_control` / `tool_result.cache_control` | **Ignored** |
| `thinking`（请求参数） | "Supported (`budget_tokens` is ignored)" |
| content `type="thinking"` | Supported |
| content `type="redacted_thinking"` | **Not Supported** |
| `anthropic-beta` | "Ignored for `/messages`" |
| `anthropic-version` | Ignored |
| `mcp_servers` | Ignored |
| `tool_choice` `auto/any/tool` | "Supported (`disable_parallel_tool_use` is ignored)" |
| `top_k` | Ignored |

以及两条直接影响框架选型的原文 [P]：

> "Note: When you pass an unsupported model name to DeepSeek's Anthropic API, the API backend will automatically map it to the `deepseek-flash` model."

> "Models starting with claude-opus are mapped to `deepseek-v4-pro`
> Models starting with claude-haiku or claude-sonnet are mapped to `deepseek-flash`"

含义：

1. **`is_error` 在 DeepSeek 上没有意义。** 所以 §4.4 / §4.9 里「框架有没有设 `is_error`」在课程的默认模型上**不改变模型看到的东西**——模型只看 `content` 文本。真正承重的是**错误文本本身**：AI SDK 默认 `Error.toString()`（带 `Error:` 前缀，模型至少能认出是错误）；MCP `isError` 路径只剩工具原文（若工具原文不像错误，模型无从得知）；UI 往返后只剩 `An error occurred.`。→ 课程里「错误要写成模型能读懂的文本」的不变量比「设 is_error」更承重。[P2]
2. **缓存断点放在哪无所谓**——DeepSeek 是自动前缀缓存，`cache_control` 被忽略。L15 的「前缀稳定」仍然承重（§4.10 的历史漂移照样让缓存失效），但「断点放在哪」这个旋钮在 DeepSeek 上不存在。[P2]
3. **模型名写错不会报错，会被静默降级到 `deepseek-flash`**（按 Flash 计费、Flash 能力）。框架里任何「模型 ID 默认值」都要检查：例如 Claude Agent SDK 的子 agent 默认模型名是 Claude 系列，打到 DeepSeek 上会按前缀映射（见 §6）。[P]

thinking 回传的要求（https://api-docs.deepseek.com/guides/thinking_mode ，访问 2026-10-12）[P]：

> "(1) Thinking mode is enabled by default, with the default effort being `high`"

> "Please note that for requests carrying the `tools` parameter, the `reasoning_content` must be fully passed back to the API in all subsequent requests — even for turns where the model did not perform a tool call. If your code does not correctly pass back `reasoning_content`, the API will return a 400 error."

这条是 OpenAI 格式下的表述；Anthropic 格式对应的是 `thinking` 块，官方兼容表只写了 "Supported"，**没有写 Anthropic 格式下漏传是否同样 400**——这一点无一手来源，列入 §14。

框架侧怎么处理 thinking 回传：

- **`@ai-sdk/deepseek@3.0.63`（OpenAI 格式）显式处理了这条**：`src/chat/convert-to-deepseek-chat-messages.ts` 注释原文 "R1 must not receive prior reasoning; V4 requires it." 以及 "V4 demands the field on every assistant turn — back-fill an empty string when the source message had no reasoning part at all."——是否 V4 靠**模型名字符串**判断（`is-deepseek-v4-model.ts`：`includes('deepseek-v4') || startsWith('deepseek-flash') || startsWith('deepseek-pro')`）。经网关改名（如 one-api 里叫 `ds-v4`）就会被当成 R1，丢掉历史 reasoning。[P]
- **`@ai-sdk/anthropic@4.0.78`（Anthropic 格式）依赖 `signature` 字段**。§9 E4 实测四种组合：

| 响应形态 | thinking 有 signature | 结果 |
| --- | --- | --- |
| 非流式 | 有 | 第二次请求回传 `["thinking","tool_use"]` |
| 非流式 | **无** | **`AI_APICallError: Invalid JSON response`**（响应 schema 里 `signature: z.string()` 是必填，`anthropic-api.ts:813`） |
| 流式 | 有 | 回传 `["thinking","tool_use"]` |
| 流式 | **无** | **thinking 块被丢弃**，只回传 `["tool_use"]`，warning `unsupported reasoning metadata` |

DeepSeek 的 Anthropic 端点返回的 thinking 块是否带 `signature`，**官方文档没写，本调研无法零网络验证**（列入 §14）。如果不带：非流式直接报错、流式静默丢 thinking——而后者在 DeepSeek 的工具调用场景下按 OpenAI 格式的规则会 400。**这是学员把 capstone 换到 AI SDK 时最可能第一天就撞上的坑**，必须在 lab 里用 mock 两个分支都钉住。[P]（实测）+ [P2]（DeepSeek 端行为）

DeepSeek 官方给 Claude Code 的推荐环境变量（https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code ，访问 2026-10-12）[P]：

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=<your DeepSeek API Key>
export ANTHROPIC_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash
export CLAUDE_CODE_EFFORT_LEVEL=max
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432
```

注意：(1) 用的是 `ANTHROPIC_AUTH_TOKEN`（Bearer）而不是 `ANTHROPIC_API_KEY`；(2) 官方要求覆盖**全部四个**模型槽位 + 子 agent 模型——漏任何一个，Claude Code 内部用到该槽位时就按前缀映射或被降级到 `deepseek-flash`；(3) 自动压缩窗口被显式设成 786432。

---

## 5. Mastra（`@mastra/core@1.76.0`）

> 一手来源：`@mastra/core@1.76.0` 的 `dist/`（编译产物，带 `.d.ts` 注释）与 mastra.ai 官方文档；本地实测见 §9 E3。注意 Mastra npm 包**不带 TS 源码**，下文源码引用是编译后的 JS（文件名带 hash），可复现但行号随版本漂移。

### 5.1 Mastra 是「在 AI SDK 外面再包一层」，并且同时内嵌了三代 AI SDK

`@mastra/core@1.76.0 package.json` 的依赖里同时有 [P]：

```json
"@ai-sdk/provider-v5": "npm:@ai-sdk/provider@2.0.3",
"@ai-sdk/provider-v6": "npm:@ai-sdk/provider@3.0.14",
"@ai-sdk/provider-v7": "npm:@ai-sdk/provider@4.0.22",
"@ai-sdk/anthropic-v5": "npm:@ai-sdk/anthropic@2.0.91",
"@ai-sdk/anthropic-v6": "npm:@ai-sdk/anthropic@3.0.103",
"@ai-sdk/anthropic-v7": "npm:@ai-sdk/anthropic@4.0.22",
"@ai-sdk/deepseek-v7": "npm:@ai-sdk/deepseek@3.0.52",
```

并且编译产物里内嵌了一份 AI SDK v5 时代的 `generateText`/`streamText`（`dist/message-list-*.js` 里 `stopWhen = stepCountIs(1)`、`stopWhen ?? stepCountIs(20)`）。Mastra 的 Agent 按模型的 `specificationVersion` 分派到 `aiV5`/`aiV6`/`aiV7` 三套 prompt 转换（`dist/create-durable-agent-*.js:4698`）。[P]

含义：**你在 Mastra 里遇到的 provider 行为，是 Mastra 锁定的那个 `@ai-sdk/anthropic@4.0.22`，不是你项目里装的 4.0.78。** §4.8 那个 4096 上限、§4.15 那个 signature 行为，要按 Mastra 锁定的版本再查一遍。[P2]

### 5.2 默认步数：5

§9 E3-A 实测：`new Agent({ model, tools })` 不传 `maxSteps`，工具永远抛异常、模型永远重试 → **模型调用 5 次、工具执行 5 次、`finishReason='tool-calls'`**。[P]（实测）

类型注释旁证 [P]（`dist/agent/types.d.ts:490-491`）：

> "Max steps the judge agent may take per evaluation (its internal agentic-loop budget). When omitted the judge uses the model loop's default (5)."

持久化 agent 的默认值也是 5（`dist/agent-*.js`：`const DurableAgentDefaults = { /** Default maximum number of agentic loop iterations */ MAX_STEPS: 5, ...}`）。而 Mastra 自己的 harness 控制器把它改成了 1000，并留了一段很能说明问题的注释 [P]（`dist/agent-controller-*.js:7169-7172`）：

> "Options that every harness-driven agent run must carry — the initial stream AND every `resumeStream`. Centralized so the two paths can't drift: a missing `maxSteps` on resume silently caps the resumed run at the agent's small default and ends it mid-task"

```js
const CONTROLLER_MAX_STEPS = 1e3;
```

→ **同一个生态里四个默认值**：AI SDK `generateText` 1、`ToolLoopAgent` 20、`WorkflowAgent` 无上限、Mastra Agent 5（Mastra harness 1000）。而 Mastra 团队自己承认「resume 时漏传 `maxSteps` 会静默截断」——这就是课程 L08「续跑时配置必须随 checkpoint 一起恢复」的反例。

工具报错回填：E3-A 第二次请求里是 `{"type":"error-text","value":"ENOENT nope (secret=sk-123)"}`——用的是 `error.message`（没有 `Error:` 前缀，和 AI SDK 的 `toString()` 不同），同样把异常原文交给模型。[P]（实测）

### 5.3 workflow 的 suspend/resume：恢复会把整个 step 从头重跑

§9 E3-B 实测（与 L11x LangGraph 实验同形）：

```text
第一次 start 状态          suspended
suspend 后 db 行数         1
resume 后状态              success
★ resume 后 db 行数        2
```

官方文档的措辞（https://mastra.ai/docs/workflows/suspend-and-resume ，访问 2026-10-12）[P]：

> "Use `resume()` to restart a suspended workflow from the step where it paused."

> "When a workflow is suspended, it restarts from the step where it paused."

文档用的词是 **restart**，而示例代码把条件判断写在 `execute` 开头（`if (!approved) return await suspend({})`）——**示例本身就暗示了 step 会从头重跑，但全文没有一句话提醒「`suspend()` 之前的副作用会再执行一次」。** 与 LangGraph 文档明确写出「`interrupt` 之前的代码必须幂等」相比，Mastra 文档把这件事留给读者推断。[P2]

→ 和 L11x 第六节完全同一个机制：**恢复不是「接着往下走」，是「重放到断点」**，只是 Mastra 的粒度是 step，LangGraph 的粒度是 node。

其他 suspend 相关事实 [P]（同页）：

- "Snapshots are stored in your configured storage provider and persist across deployments and application restarts."
- `suspendData`：resume 时能拿到当初 `suspend()` 的参数。
- `.sleep()` / `.sleepUntil()` 把状态置为 `waiting`，与 `suspended` 区分。

### 5.4 Memory：默认 10 条滑动窗口，而官方承认它会让缓存失效

https://mastra.ai/docs/memory/message-history.md （访问 2026-10-12）[P]：

> "The default of 10 messages keeps agents grounded in the conversation. Adjust it with `lastMessages` when needed."

> "Note: `lastMessages` counts every stored message, including tool calls, tool results, and signals of any kind, so a single turn can add several messages to the count. The window also slides forward on every request: once a thread grows past the limit, the oldest message leaves context on each turn, which changes the start of the prompt and invalidates the provider prompt cache. For long-running conversations, use Observational Memory, which keeps the prompt prefix stable."

这是本报告里**框架官方亲口承认默认值与 L15 不变量冲突**的最直接一条：默认的 10 条窗口每一轮都滑动 → 每一轮的前缀都不同 → 缓存命中率归零。而且「10 条」数的是**所有消息**，一次带 3 个工具调用的回合就占掉 7 条——默认配置下 agent 实际上只记得一两轮。替代方案 `messageHistory: { maxTokens, atMaxRemoveTokens }` 按块删除（官方："Removing history in chunks keeps the prompt prefix stable across several turns"），这正是 L06/L15 讲过的「分块截断保前缀」。

同页另外两条 [P]：

> "Warning: The memory system doesn't enforce access control. Before running any query, verify in your application logic that the current user is authorized to access the `resourceId` being queried."

> "When you use memory with a client application, send only the new message instead of the full conversation history. Mastra loads previous messages from storage."

后一条与 AI SDK `useChat` 的默认（客户端每轮发全量历史，§4.7 / §4.10）**方向相反**：Mastra 以服务端存储为准，`useChat` 以客户端消息为准。两个框架拼在一起用（Mastra 官方就有 "Using Mastra Memory" with AI SDK 的指南），谁是历史的真相源要显式决定——这正是 §4.10 那种历史漂移的温床。官方的处理是 "When message IDs match, it uses the stored copy as the base"。[P]

### 5.5 Evals / scorers：异步、按 trace 采样、忘了注册就静默丢分

https://mastra.ai/docs/evals/overview.md （访问 2026-10-12）[P]：

> "Asynchronous execution: Live evaluations run in the background without blocking your agent responses or workflow execution."

> "Sampling is deterministic per trace: the decision is derived from the trace ID, not drawn at random."

> "Skipping registration doesn't change scoring results, but each save fails with a `Scorer with id not found` warning and the scores never reach the store."

对照课程 L12：Mastra 的 scorer 是「线上抽检」形态（live eval，挂在 agent/step 上，异步、按比例采样），而 L12/L18 的门禁是「离线回归 + 阻断合并」形态。Mastra 也提供 `runEvals()` 与 "gates and verdicts"，但默认心智是监控而不是门禁。**分数没落库只有一条 warning**——如果 CI 依赖读库里的分数做门禁，这就是一个「看起来全绿」的静默失败。[P2]

### 5.6 许可证：核心 Apache-2.0，`ee/` 目录另行授权

`@mastra/core@1.76.0 LICENSE.md` [P]：

> "All content that resides under any directory named `ee/` within this repository, including but not limited to: `@mastra/core/auth/ee`, `@mastra/core/agent-builder/ee`, `@mastra/editor/ee` is licensed under the license defined in [`ee/LICENSE`]"

其余为 Apache-2.0（`package.json` 的 `"license": "Apache-2.0"`）。`ee/LICENSE` 的具体条款本调研未读到原文（列入 §14）。对接需求的含义：Studio 的鉴权（`auth/ee`）、agent builder 属于 ee 范畴，商用前要单独确认。

### 5.7 Studio 与存储适配（定位）

- Studio：本地 dev server 的 UI（`mastra dev`），能跑 agent、看 trace、管理 scorer 与数据集（evals 页 "Open Studio to manage scorers and review scores, plus run experiments"）。[P]
- 存储：Memory 和 workflow snapshot 都要求配置 storage（message-history 页："Message history requires a storage adapter to persist conversations"），官方示例用 `@mastra/libsql`（本地 `mastra.db` 文件）；生产适配有 `@mastra/pg` 等。[P]
- 与课程的映射：Mastra 的 storage 层 ≈ L08 的事件日志 + 快照存储，但**粒度是 workflow step 和 memory message**，不是课程那种「每个事件一条 append-only 记录 + 幂等键」。[P2]

---

## 6. Claude Agent SDK（`@anthropic-ai/claude-agent-sdk@0.3.296`）

### 6.1 它是什么：一个驱动 240MB 原生二进制的库

官方定位（https://platform.claude.com/docs/en/agent-sdk/overview ，访问 2026-10-12）[P]：

> "Embed Claude Code's agent in your own Python or TypeScript application, in a process you operate | Agent SDK | A library that runs the Claude Code binary, with Claude Code's capabilities, such as built-in tools, permissions, sessions, and hooks."

包结构印证这句话 [P]（`npm pack @anthropic-ai/claude-agent-sdk@0.3.296`）：

- `package.json` 的 `optionalDependencies` 是 8 个平台包：`@anthropic-ai/claude-agent-sdk-{linux-x64,linux-arm64,linux-x64-musl,linux-arm64-musl,darwin-x64,darwin-arm64,win32-x64,win32-arm64}`，版本全部锁 `0.3.296`。
- `manifest.json`：`"version": "2.1.296"`（= Claude Code CLI 版本），`darwin-arm64` 的 `binary: "claude"`、`size: 240664432`（约 240MB），`linux-x64` 约 257MB。
- README："When bundling your application into a single executable with `bun build --compile`, the SDK cannot resolve the native CLI binary at runtime"——要用 `extractFromBunfs` 解出来再传 `pathToClaudeCodeExecutable`。

「它是跑 Claude Code 二进制的库」意味着（[P2]，由上述一手事实推断）：

1. **agent loop 不在你的进程里。** 你的 Node 进程通过 stdin/stdout 与一个子进程通信；循环、压缩、权限判定、工具执行都在子进程里。课程 L05 那句「agent loop 自己写，你才控制得住」在这里是字面意义上的「你控制不住」——你只能通过 options、hooks、`canUseTool` 这些**它开放的口子**影响循环。
2. **部署形态变了。** 每个会话一个子进程、每个镜像多 ~250MB、要匹配 libc（musl 单独一个包）。Serverless（冷启动、只读文件系统）与它天然冲突。
3. **版本是两层的。** SDK 0.3.x 的 API 面 + CLI 2.1.x 的行为面，二者补丁号锁步。一次 `npm update` 同时换掉了「库」和「agent 的行为」。
4. **许可证不是开源。** `LICENSE.md` 全文："© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." 官方 overview："Use of the Claude Agent SDK is governed by Anthropic's Commercial Terms of Service, including when you use it to power products and services that you make available to your own customers and end users"。[P]
5. **数据收集。** README："When you use the Claude Agent SDK, we collect feedback, which includes usage data (such as code acceptance or rejections), associated conversation data, and user feedback submitted via the /bug command." [P]——国内交付时要和客户的数据合规要求对齐；即使模型指向 DeepSeek，遥测走不走、走到哪，需要用 `DISABLE_TELEMETRY` 等环境变量显式关闭并实测（见 §9 E5）。

### 6.2 默认值：几乎每一项都是「继承你机器上的 Claude Code」

全部摘自 `sdk.d.ts`（`@anthropic-ai/claude-agent-sdk@0.3.296`）的 JSDoc [P]：

**`settingSources`（承重）**

> "When omitted, all sources are loaded (matches CLI defaults). Pass `[]` to disable filesystem settings (SDK isolation mode). Must include `'project'` to load CLAUDE.md files."

→ 你在服务器上 `query()`，它会读运行用户的 `~/.claude/settings.json`、项目的 `.claude/settings.json`、`.claude/settings.local.json` 和 CLAUDE.md。**开发机上能跑、生产上行为不同**的第一嫌疑。官方 overview 也写得很直白："Skills, commands, and memory | Load automatically from your project's `.claude/` and from `~/.claude/`, same as Claude Code"。

**`permissionMode`（承重）**

> "Permission mode for the session. When omitted, Claude Code picks the starting mode as it does for `claude -p`: a `permissions.defaultMode` from the settings the session loads, else `'auto'` where that is the default (and `'default'` where auto mode is unavailable)."

> "`'auto'` - A model classifier approves or denies each call, prompting through `canUseTool` when it cannot decide"

→ 不传 `permissionMode` ≠ 「每次都问」。它可能是 `'auto'`——**由一个模型分类器替你批准工具调用**；也可能被某个 settings 文件里的 `defaultMode` 改掉（而 settings 默认全部加载，见上）。课程 L14 的立场是「审批是确定性代码，deny 优先」；这里的默认是「审批是另一个模型的判断」。agent-loop 文档对 `'default'` 的描述："Tool calls that need approval and aren't covered by allow rules trigger your `canUseTool` callback; **no callback means deny**"。

**`env`（承重）**

> "When set, this value REPLACES the subprocess environment entirely — it is not merged with `process.env`. Spread `process.env` yourself if the subprocess still needs inherited variables like `PATH`, `HOME`, or `ANTHROPIC_API_KEY`. When omitted, the subprocess inherits `process.env`."

→ 两个方向都坑：不传 `env`，子进程继承服务器进程**全部**环境变量（包括与 agent 无关的数据库口令），而子进程里跑着 `Bash` 工具；传了 `env`，`PATH` 没了，二进制里的 `git`/`rg` 全部找不到。

**`persistSession`**

> "When false, disables session persistence to disk. Sessions will not be saved to ~/.claude/projects/ and cannot be resumed later. ... @default true"

→ 默认把每个会话的完整 transcript 写进运行用户的 home。多租户服务里这是一个**跨租户的磁盘目录**。外部存储有 `sessionStore`（`@alpha`），但注释说 "the subprocess still writes to CLAUDE_CONFIG_DIR ... AND emits entries to this adapter via dual-write"——即使配置了外部存储，本地也会写。

**`skills`**

> "omitted (default): no SDK auto-configuration. The CLI's own defaults still apply, so this is **not** "skills off.""

> "This is a context filter, not a sandbox: unlisted skills are hidden from the model's listing and rejected by the Skill tool, but their files remain on disk and are reachable via Read/Bash. Do not store secrets in skill files."

**`systemPrompt.snapshot`**

> "**Recommended: `snapshot: true`.** A system prompt that changes mid-conversation (a CLI upgrade between launches, a flag flip, a different `append`) invalidates the prompt prefix and, with extended thinking, discards the model's earlier reasoning; a recorded prompt cannot change until the conversation is compacted."

> "a different `append` or `prompt` passed on a later launch of the same session is ignored until compaction or a new session."

→ 反直觉：**你改了 system prompt 再 `resume`，旧会话用的还是旧 prompt。** 这是为了 L15 的前缀稳定，但它意味着「热修 prompt」对存量会话不生效——直到下一次压缩，届时 prompt 突然变了。

**`maxTurns` / `maxBudgetUsd`**（https://platform.claude.com/docs/en/agent-sdk/agent-loop ，访问 2026-10-12）[P]：

| Option | What it controls | Default |
| --- | --- | --- |
| Max turns (`max_turns` / `maxTurns`) | Maximum tool-use round trips | **No limit** |
| Max budget (`max_budget_usd` / `maxBudgetUsd`) | Estimated spend at which the loop stops | **No limit** |

> "Claude Code compares spend with the `max_budget_usd` / `maxBudgetUsd` cap after model responses arrive ... Spend can therefore pass the cap by up to the cost of that one response, plus anything that subagents still running at that moment spend before they stop."

→ 默认无上限；预算是**事后检查**（与 AI SDK `stopWhen` 同，与 L05「先估算、超了就不发」相反），而且官方明说会超。另一个隐含问题：`total_cost_usd` 是按 **Claude 的价目表**估算的——模型指向 DeepSeek 时这个数字（以及 `maxBudgetUsd` 的判定）与实际账单无关（见 §9 E5 实测）。[P2]

**但它做对了 L05 的那一条**：停止原因是显式的 [P]（agent-loop 页）：

| subtype | 含义 |
| --- | --- |
| `success` | 正常结束 |
| `error_max_turns` | "Hit the `maxTurns` limit before finishing" |
| `error_max_budget_usd` | "Hit the `maxBudgetUsd` limit before finishing" |
| `error_during_execution` | "An error interrupted the loop (for example, a cancelled request)" |
| `error_max_structured_output_retries` | 结构化输出重试耗尽 |

这是五个框架里**唯一**在返回值上直接给出 L05 意义上的 `reason` 的（OpenAI Agents SDK 用异常类型区分，见 §7）。

### 6.3 工具执行与权限

agent-loop 页 [P]：

> "Read-only tools (like `Read`, `Glob`, `Grep`, and MCP tools marked as read-only) can run concurrently. Tools that modify state (like `Edit`, `Write`, and `Bash`) run sequentially to avoid conflicts."

> "Custom tools default to sequential execution. To enable parallel execution for a custom tool, set `readOnlyHint` in its annotations."

> "When a tool is denied, Claude receives a rejection message as the tool result and typically attempts a different approach or reports that it couldn't proceed."

对照 L05 开头那 10 行：`Promise.all(uses.map(...))`——课程的朴素实现是**全部并发**；Claude Code 是**按副作用分类决定并发**。这是一个值得在 L19x 讲的「harness 比框架多做的事」。

权限模式六种：`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`（`sdk.d.ts:2503`）。`bypassPermissions` 需要 `allowDangerouslySkipPermissions: true`，且 "Can't be used when running as root on Unix"。`dontAsk` 是 headless 场景最接近课程「deny 优先」的模式："every call that would otherwise prompt is denied"。[P]

`HookPermissionDecision = 'allow' | 'deny' | 'ask' | 'defer'`；hook 事件共 33 种（`HOOK_EVENTS`），包括 `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`PermissionDenied`、`PreCompact`、`PostCompact`、`SubagentStart/Stop`、`Stop`、`StopFailure`、`SessionStart/End` 等（`sdk.d.ts:963`）。[P]

### 6.4 自动压缩

agent-loop 页 [P]：

> "When the context window approaches its limit, the SDK automatically compacts the conversation: it summarizes older history to free space, keeping your most recent exchanges and key decisions intact. The SDK emits a message with `type: "system"` and `subtype: "compact_boundary"`"

> "Compaction replaces older messages with a summary, so specific instructions from early in the conversation may not be preserved. Persistent rules belong in CLAUDE.md (loaded via `settingSources`) rather than in the initial prompt, because CLAUDE.md content is re-injected on every request."

→ 课程 L06 的不变量「system/约束不进压缩区」在 Claude Code 里的实现是「约束放 CLAUDE.md，每次重新注入」。但注意这和 `settingSources: []`（隔离模式）**互斥**：要隔离就没有 CLAUDE.md，没有 CLAUDE.md 就只能把约束写在初始 prompt 里，而初始 prompt 会被压缩掉。DeepSeek 官方推荐 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432`（§4.15）。[P] + [P2]

### 6.5 会话：resume / fork / resumeSessionAt

`sdk.d.ts` [P]：

- `resume?: string` —— "Session ID to resume. Loads the conversation history from the specified session."
- `forkSession?: boolean` —— "When true, resumed sessions will fork to a new session ID rather than continuing the previous session. Use with `resume`."
- `continue?: boolean` —— "Continue the most recent conversation in the current directory"（按 cwd 找「最近一次」——多租户共享 cwd 时会续到别人的会话）[P2]
- `resumeSessionAt?: string` —— "When resuming, only resume messages up to and including the message with this UUID."
- `resumeDropsTurn` 的注释里有一段对课程 L08/L16 极有价值的话："interrupted turns that completed one or more tools before Esc: the completed (non-error) tool_result in the tail is kept-turn payload and deliberately refuses at an assistant-UUID fork point"——**中断后，已经完成的工具结果被视为本回合的有效载荷保留在 transcript 里**；以及 "Consumers MUST map a refusal ... not retry: the refusal is deterministic, so re-sending the same fork request fails forever."
- `enableFileCheckpointing` + `Query.rewindFiles()`："files can be rewound to their state at any user message"——对应 L17–L19 的 checkpoint，但**文件快照和对话快照是两套机制**，课程 L19 §3.2「transcript 不等于工作区」在这里同样成立。

### 6.6 实测：把真二进制指向本地假 Anthropic 服务器（§9 E5）

方法：`query()` 的 `env` 里设 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`、`ANTHROPIC_AUTH_TOKEN=fake`、`HOME`/`CLAUDE_CONFIG_DIR` 指到 `/tmp` 下的沙箱目录（不碰本机 `~/.claude`），`model: 'deepseek-v4-pro'`，加一个进程内 MCP 工具 `boom`（永远抛 `EACCES ... (secret=sk-123)`）。本地 HTTP 服务器记录每一个请求。零外网、零真模型。

**E5-A：不传 `permissionMode`（干净环境、无任何 settings 文件）**

- `init.permissionMode` = **`auto`**。[P]（实测）
- 每一次主循环请求（`model=deepseek-v4-pro`，21 个工具，`max_tokens=32000`，`thinking={"type":"adaptive","display":"updates"}`）之后，跟着**10 次**分类器请求：`model=claude-sonnet-5`（**不是**你设的模型）、无工具、system 约 140K 字符、`max_tokens` 先 64（5 次）后 8192（5 次）、`thinking: disabled`。分类器 system 开头原文："You are a security monitor for autonomous AI coding agents."；user 尾部原文："Respond with <severity>N</severity> ONLY. Grade HARM ONLY — do NOT reduce for user intent. No other text."
- 假服务器不会按 `<severity>` 协议回答 → 分类器失败 → 工具调用被**失败即拒**，回填给主模型的原文：

> "Auto mode could not evaluate this action and is blocking it for safety — run with --debug for details. This is not a judgment that the action is unsafe. This is usually transient — wait briefly and try this action again as-is; don't rewrite it."（`is_error: true`）

- 而这段话**指示模型原样重试**——于是主循环→分类器×10→拒绝→主循环……直到我 45 秒后 abort（第一次没加上限时跑到 Node 堆溢出）。**默认 `maxTurns` 无上限 + 分类器失败即拒 + 拒绝消息鼓励重试 = 一个默认配置下的死循环。**

对 DeepSeek 的含义（[P2]）：分类器模型名写死为 Claude 系列；按 DeepSeek 文档的映射规则，`claude-sonnet-*` 会被映射到 `deepseek-flash`。分类器能否按 `<severity>N</severity>` 协议稳定作答**没有一手来源**；答不好就是上面的失败即拒。另外 `total_cost_usd` 的注释原文："Internal helper calls outside the query pipeline (e.g. the permission classifier, token-count probes) are excluded"——**分类器的花费不计入 SDK 报告的成本**（`sdk.d.ts:5746`）[P]。每次工具调用多一个约 35K token 的分类器请求、而且不进成本账——L15「成本归因」的反例。

**E5-A2：`permissionMode: 'default'` + `allowedTools: ['mcp__lab__boom']`**

- 2 次请求、`result.subtype='success'`、`num_turns=2`。
- 回填：`{"type":"tool_result","content":"EACCES: permission denied (secret=sk-123)","is_error":true}`——用 `error.message`，设了 `is_error`，**敏感串原样进上下文**。[P]（实测）

**E5-A3：`permissionMode: 'default'`，不给 `allowedTools`、不给 `canUseTool`**

- 回填：`"Claude requested permissions to use mcp__lab__boom, but you haven't granted it yet."`（`is_error: true`）——**连你自己进程内注册的 MCP 工具也要过权限**；`result.subtype` 仍是 `success`。[P]（实测）→ 「被拒」不改变 `subtype`，要看 `result.permission_denials`（`sdk.d.ts:5572` 注释："result.permission_denials is the authoritative record"）。

**E5-B/C：resume 与 fork**

| 运行 | session_id | 发给模型的 messages 数 | `total_cost_usd` |
| --- | --- | --- | --- |
| A2 | `e1027878…` | 2 → 5 | 0.0012 |
| B：`resume: A2` | `e1027878…`（同一个） | 8 | 0.0018 |
| C：`resume: A2, forkSession: true` | `9afbad74…`（新） | 11 | 0.0024 |

- resume 后历史完整回放（A2 那条带 `secret=sk-123` 的 tool_result 原样出现在 B、C 的请求里）。[P]（实测）
- **fork 的 `total_cost_usd` 从父会话的累计值继续算**（0.0024 包含了 A2+B 的 0.0018）。注释原文："a resumed or forked session continues from the totals its transcript saved"（`sdk.d.ts:5746`）。→ 按会话汇总成本会**重复计算**父会话的花费。[P]
- 对 `deepseek-v4-pro` 这个 SDK 不认识的模型，`total_cost_usd` 仍然算出了非零值（每次 100 输入 / 10 输出 token 记 0.0006 美元）——它用的不是 DeepSeek 的价格。[P]（实测）+ [P2]（价目表来源）

**请求体里的其他发现**（`/tmp/l19x-lab/e5-dumps.json`）[P]（实测）：

- 默认 system prompt **不是** Claude Code 的大 prompt，而是两块：`"x-anthropic-billing-header: cc_version=2.1.296.31a; cc_entrypoint=sdk-ts;"` + `"You are a Claude agent, built on Anthropic's Claude Agent SDK."`（后者带 `cache_control`）。要 Claude Code 的完整行为必须显式 `systemPrompt: { type: 'preset', preset: 'claude_code' }`。→ 「用 Agent SDK = 得到 Claude Code」不成立：**工具集是 Claude Code 的，system prompt 默认不是。**
- 计费头作为**第一个 system 文本块**发给了 DeepSeek，并且带一个随构建变化的后缀（主循环 `31a`、分类器 `e05`）。对 DeepSeek 的自动前缀缓存来说，这一块在每次 CLI 升级后都会变。
- `metadata.user_id` 是一个 JSON 字符串，内含 `device_id`（64 位十六进制）与 `session_id`——会发送给 DeepSeek（DeepSeek 兼容表："`metadata` | `user_id` is supported"）。
- messages 数组里出现 `role: "system"` 的条目（环境信息、`<total_tokens>14999890 tokens left</total_tokens>`），以及首条 user 消息里注入的 `<system-reminder>`（要求 commit 里加 `Co-Authored-By: Claude Code`）。DeepSeek 兼容表**没有列出** messages 内 `role: "system"` 的支持情况（列入 §14）。
- 内置工具 21 个（`Task, Bash, CronCreate, CronDelete, CronList, Edit, EnterWorktree, ExitWorktree, ListAgents, NotebookEdit, Read, ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskStop, WebFetch, WebSearch, Workflow, Write` + MCP 工具）——没有 `Grep`/`Glob`，与 `sdk.d.ts` 注释 "native builds may provide search via Bash `find`/`grep` instead of the dedicated Grep/Glob tools" 一致。
- 请求顶层还有 `context_management`、`output_config` 字段。

### 6.7 子 agent

`agents?: Record<string, AgentDefinition>`（`sdk.d.ts:1581`），主循环通过 `Agent`/`Task` 工具调起；`AgentDefinition` 可单独设 `tools`、`model`、`effort`、`skills`、`maxTurns`、`permissionMode`。DeepSeek 官方推荐里专门有 `CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash`——**子 agent 默认模型与主模型分开配置**。预算会覆盖子 agent（agent-loop 页："The budget cap covers subagents: their spend counts toward the total"）。[P]

### 6.8 能否指向 DeepSeek：能，但「能连上」不等于「行为一致」

- **能**：DeepSeek 官方文档专门给出 Claude Code 配置（§4.15）；SDK 的 `env` 里设 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 即可，E5 证明二进制会把主循环请求发到 `ANTHROPIC_BASE_URL`。[P]
- **不一致之处**（全部来自上面的一手证据）：(1) `auto` 模式的分类器写死 Claude 模型名 → 被 DeepSeek 映射；(2) `is_error`、`cache_control` 被 DeepSeek 忽略；(3) `total_cost_usd` 与 `maxBudgetUsd` 用的不是 DeepSeek 价格；(4) `thinking: {type:'adaptive'}` 在 DeepSeek 上的语义未写明（兼容表只说 `budget_tokens` 被忽略）；(5) 漏配任何一个模型槽位就落到映射规则上。

---

## 7. OpenAI Agents SDK（JS）：`@openai/agents@0.20.0`

包结构：`@openai/agents`（伞包）= `@openai/agents-core`（MIT，provider 无关的 runner）+ `@openai/agents-openai`（OpenAI provider 与 tracing exporter）+ `@openai/agents-realtime`。另有 `@openai/agents-extensions@0.20.0`（AI SDK 适配器等）。

### 7.1 「import 即配置」：伞包的副作用

`@openai/agents@0.20.0/dist/index.mjs` 全文前 5 行 [P]：

```js
import { setDefaultModelProvider } from '@openai/agents-core';
import { OpenAIProvider } from '@openai/agents-openai';
import { setDefaultOpenAITracingExporter } from '@openai/agents-openai';
setDefaultModelProvider(new OpenAIProvider({ cacheResponsesWebSocketModels: false }));
setDefaultOpenAITracingExporter();
```

→ **只要 `import ... from '@openai/agents'`，进程就注册了 OpenAI 模型 provider 和 OpenAI tracing exporter。** 官方 tracing 文档原文："Tracing is enabled by default in server runtimes (Node.js, Deno, Bun). It is disabled by default in browsers and when `NODE_ENV=test`." 以及 "In supported server runtimes, the default tracing setup already exports to OpenAI."（<https://openai.github.io/openai-agents-js/guides/tracing/>，2026-10-12 访问）[P]

- 导出端点：`agents-openai/dist/openaiTracingExporter.mjs:6` `const OPENAI_TRACING_INGEST_ENDPOINT = 'https://api.openai.com/v1/traces/ingest';` [P]
- 敏感数据默认**包含**：`agents-core/dist/run.mjs:121` `traceIncludeSensitiveData: config.traceIncludeSensitiveData ?? true`；E6-F 实测 `new Runner().config.traceIncludeSensitiveData === true` [P]。文档原文："`createGenerationSpan()` stores the inputs/outputs of the LLM generation, and `createFunctionSpan()` stores the inputs/outputs of function calls."
- 没有 OpenAI key 时：exporter 打日志 `'No API key provided for OpenAI tracing exporter. Exports will be skipped'`（`openaiTracingExporter.mjs:212`）[P]。**反过来的风险**：如果环境里恰好有 `OPENAI_API_KEY`（比如别的功能在用），而模型走的是 DeepSeek，那么 DeepSeek 上的对话内容会被作为 trace 上传到 OpenAI。[P2]（由上面三条一手证据推出）
- `NODE_ENV=test` 默认关 tracing（`agents-core/dist/config.mjs` `tracing.disabled` getter）——**测试环境和生产环境行为不同**，测试里看不到的上传在生产里发生。[P]

课程对照：L13 的 OTel 是「你决定 span 去哪里」；这里的默认是「span 已经有去处了」。另外 E6-F 发现：调用 `setTracingDisabled(true)` 后，`new Runner().config.tracingDisabled` 仍是 `false`——全局开关和 Runner 级开关是两个东西。[P]（实测）

### 7.2 主循环与终止：默认 10 轮，超限**抛异常**

- `agents-core/dist/runner/constants.mjs`：`export const DEFAULT_MAX_TURNS = 10;`，注释原文 "Keep behavior-altering defaults in one place." [P]
- 超限：`runner/turnPreparation.mjs:61` `throw new MaxTurnsExceededError(\`Max turns (${state._maxTurns}) exceeded\`, state);` [P]
- E6-A 实测：工具每次都抛、模型每次都重试 → **10 次模型调用、10 次工具执行**，然后抛 `MaxTurnsExceededError: Max turns (10) exceeded`；`error.state` 存在，里面有 20 个 generated items。[P]（实测）
- 和 AI SDK 的区别：AI SDK 撞上限是**正常返回**（`finishReason: 'tool-calls'`，见 §4.2），Agents SDK 是**抛异常但带状态**；AI SDK 的 abort 丢步骤（§4.9），Agents SDK 的异常里留着 `state`。
- 想要课程 L05 那种「显式的停止原因 + 正常返回」：`run(agent, input, { maxTurns, errorHandlers: { maxTurns: () => ({ finalOutput: ... }) } })`，E6-E 实测返回 `finalOutput: '已到步数上限，停止'`。[P]（实测）

### 7.3 工具错误：默认**什么都不告诉模型**

`agents-core/dist/tool.mjs:512-520` [P]：

```js
/**
 * The default function to invoke when an error occurs while running the tool.
 *
 * Returns a fixed message without inspecting the exception. Provide a custom
 * `errorFunction` to return application-approved details to the model.
 */
function defaultToolErrorFunction() {
    return 'An error occurred while running the tool. Please try again.';
}
```

E6-A 实测：回填给模型的是 `{"type":"text","text":"An error occurred while running the tool. Please try again."}`，`ENOENT` 和 `secret` 都看不到。[P]（实测）

三家对比（同一个抛 `ENOENT nope (secret=sk-123)` 的工具）：

| 框架 | 回填内容 | 泄密？ | 模型能据此修正吗？ |
| --- | --- | --- | --- |
| AI SDK 7 | `Error: ENOENT ... (secret=sk-123)`（`error.toString()`） | 是 | 能，但看到的是原始异常 |
| Mastra 1.x | `ENOENT ... (secret=sk-123)`（`error.message`） | 是 | 同上 |
| Claude Agent SDK | `EACCES ... (secret=sk-123)` + `is_error: true` | 是 | 同上 |
| OpenAI Agents SDK | `An error occurred while running the tool. Please try again.` | 否 | **不能**，而且被告知「再试一次」 |

→ 课程 L05/L14 的不变量是「错误文本给出下一步出路、且经过脱敏」。**四家默认值里没有一家满足**：三家把原始异常塞进上下文，一家把信息全部抹掉还鼓励原样重试——后者叠加 10 轮上限，就是 E6-A 的「10 次相同失败」。

其他：tracing span 里的错误详情在默认 errorFunction 下会被替换成 `REDACTED_TOOL_ERROR_MESSAGE`（`tool.mjs:835-845`：只有自定义了 errorFunction 时 `includeErrorDetails` 才为真）→ **默认情况下你的 trace 里也看不到工具为什么失败**。[P]

### 7.4 人工审批：`needsApproval` → `interruptions` → `RunState` 序列化

- 工具 `needsApproval: true`（或函数）→ 本次 `run()` 返回，`result.interruptions` 非空、`finalOutput` 为空；`result.state.toString()` 得到可存储的 JSON；之后 `RunState.fromString(agent, s)` → `state.approve(item)` / `state.reject(item)` → `run(agent, state)` 继续。[P]
- E6-B 实测：序列化状态 3529 字节；批准后恢复 → 工具执行 1 次、`finalOutput='done'`。**用同一份序列化状态再恢复一次 → 工具又执行了一次（累计 2 次）。** [P]（实测）→ 审批恢复本身没有幂等保证；L08 的幂等键、L19 的「审批记忆」必须由你在工具层或存储层自己做（例如恢复前把状态行标记为已消费）。
- E6-C 实测：拒绝后回填 `"Tool execution was not approved."`——不带原因，模型不知道该改什么。[P]（实测）
- 文档（models 页）说默认重试策略会区分「可安全重放」与否："The SDK treats an unsuccessful terminal state as a response that may already have started and is unsafe to replay. For a non-streaming run, the default retry advice does not automatically repeat the request"，以及流式："the runner does not retry after it emits the raw terminal event"（<https://openai.github.io/openai-agents-js/guides/models/>，2026-10-12）[P]。**这是四家里唯一在框架层显式建模「重放安全性」的**——但它只覆盖模型请求重试，不覆盖工具副作用（E6-B）。

### 7.5 Guardrails：输入 guardrail 默认**与模型并行**

- 源码：`agents-core/dist/guardrail.mjs:4` `export function defineInputGuardrail({ name, execute, runInParallel = true, })` [P]
- 文档原文："`runInParallel: true` (default) starts input guardrails concurrently with agent execution. Concurrent execution minimizes latency, but the model may already have consumed tokens or run tools if the guardrail later triggers."（<https://openai.github.io/openai-agents-js/guides/guardrails/>，2026-10-12）[P]
- E6-D 实测（guardrail 50ms 后触发，假模型立即返回一个 `send_email` 调用）：默认 → 抛 `InputGuardrailTripwireTriggered`，**模型已被调用 1 次**，副作用工具 0 次；`runInParallel:false` → 模型 0 次、工具 0 次。[P]（实测）本次实测里工具没跑到，但文档明确说可能会跑——不要依赖这次的时序。
- 作用范围原文："Input guardrails run only for the first agent in the chain. Output guardrails run only for the agent that produces the final output." → handoff 之后的 agent 不受输入 guardrail 约束；要逐工具检查用 tool guardrails。另外 "Handoffs ... run through the SDK's handoff path rather than the normal function-tool pipeline, so tool guardrails do not apply to the handoff call itself"；内置执行工具（`computerTool`、`shellTool`、`applyPatchTool`）也不走 tool guardrail。[P]
- 课程 L14「先拒后放」的反例：**默认是「先放，后拦」**。

### 7.6 Handoffs 与 sessions

- handoff 在模型眼里是一个叫 `transfer_to_<agent_name>` 的工具；原文："By default a handoff receives the entire conversation history. To modify what gets passed to the next agent, provide an `inputFilter`."（handoffs 页，2026-10-12）[P]——与 L11「子 agent 的上下文要裁剪」相反，默认整段历史交出去。
- `onHandoff` 抛错会阻止转交（原文："If authorization fails, throw instead of returning; the SDK continues the transfer after `onHandoff` returns successfully."）。`isEnabled` 在模型给出参数之前求值，不能用来校验参数。[P]
- Sessions：`MemorySession`（进程内），OpenAI 的 `OpenAIConversationsSession`（服务端），以及一组 `SessionHistoryTransaction*` 接口（`index.d.ts:44`）——说明框架已经在处理「会话写入与运行失败的一致性」，但具体语义本报告未展开（列入 §14）。
- 沙箱 agent：`agents-core/dist/sandbox/` 存在，`run.mjs` 里每次运行都会构造 `SandboxRuntimeManager`；细节未深入。[P2]

### 7.7 是不是真的 provider 无关？

- 内核 `agents-core` 只依赖 `Model` / `ModelProvider` 接口（`getResponse` / `getStreamedResponse`）——E6 就是用 30 行自写 `Model` 跑通的，**内核层面确实 provider 无关**。[P]（实测）
- 但：(1) 伞包 import 即注册 OpenAI provider + exporter（§7.1）；(2) 默认模型名是 `gpt-5.6-luna`（`defaultModel.mjs:76`，`OPENAI_DEFAULT_MODEL` 可改）；(3) 一批功能只在 Responses API 上有：文档原文 "`toolSearchTool()`, `toolNamespace()`, and function tools or hosted MCP tools that set `deferLoading: true` require the OpenAI Responses API"，以及 "`reasoning.mode` and `reasoning.context` are Responses-only settings"；Chat Completions 路径对这些功能**默认警告并忽略**（"By default those features are warned and ignored"），要报错得开 `strictFeatureValidation`。[P]
- 接 DeepSeek 的两条路：`OpenAIChatCompletionsModel` + 自定义 `baseURL`（DeepSeek 的 OpenAI 兼容端点），或 `@openai/agents-extensions` 的 AI SDK 适配器（再接 `@ai-sdk/anthropic` 指向 DeepSeek 的 Anthropic 端点）。官方原文："If you want to use non-OpenAI models without implementing `ModelProvider` yourself, see Using any model with Vercel's AI SDK."[P] 两条路都未做真网络验证。
- 结论：**「provider 无关」对内核成立，对默认配置和高级功能不成立。** [P2]

### 7.8 Realtime

`@openai/agents-realtime`：`RealtimeAgent` / `RealtimeSession`，默认走 OpenAI Realtime API；tracing 原文："If you are using `RealtimeAgent` and `RealtimeSession` with the default OpenAI Realtime API, tracing will automatically happen on the Realtime API side unless you disable it"。与本课程（文本 agent、DeepSeek）关系弱，只作定位。[P]

---

## 8. LangGraph.js 与 Google ADK TS：只做定位

| | LangGraph.js | Google ADK TS |
| --- | --- | --- |
| 版本 / 许可 | `@langchain/langgraph@1.4.21`，MIT | `@google/adk@2.2.1`，Apache-2.0 |
| 抽象层次 | 图（节点 + 边 + 状态 reducer + checkpointer），**不是** agent loop 本身 | Agent + Runner + Session/Artifact 服务，偏「平台 SDK」 |
| 默认步数上限 | `DEFAULT_RECURSION_LIMIT = 25`（`dist/pregel/utils/config.js:36`），超限抛 `GraphRecursionError` [P] | `maxLlmCalls` 默认 `500`（`dist/types/agents/run_config.d.ts:151`）；"Less than or equal to 0: This allows for unbounded number of llm calls." [P] |
| 与课程关系 | 语义与 Python 版同构，L11x 已经覆盖 `interrupt` 重跑节点、reducer、checkpoint——**不重复讲** | `pauseOnToolCalls`："the agent loop will suspend on ANY tool call, allowing the client to intercept and execute tools (Client-Side Tool Execution)" [P]——与 L16 的客户端执行工具同构 |
| 本课处理 | 一张对照表 + 指回 L11x | 一张对照表；不做实验 |

默认步数上限横向对比（本报告最「反直觉」的一张小表）：

| 框架 | 默认上限 | 撞上限时 |
| --- | --- | --- |
| AI SDK `generateText` | 1 步 | 正常返回，`finishReason: 'tool-calls'` |
| AI SDK `ToolLoopAgent` | 20 步 | 正常返回，`finishReason: 'tool-calls'` |
| Mastra `Agent` | 5 步 | 正常返回 |
| OpenAI Agents SDK | 10 轮 | 抛 `MaxTurnsExceededError`（带 state） |
| LangGraph.js | 25 个 super-step | 抛 `GraphRecursionError` |
| Google ADK TS | 500 次 LLM 调用 | 抛错（未实测） |
| Claude Agent SDK | **无上限**（`maxTurns`、`maxBudgetUsd` 都不设） | — |

从 1 到无穷大。「框架会帮我兜住死循环」这个直觉，取决于你用的是哪一家，以及用的是不是同一家的哪个入口。

---

## 9. 本地实测汇总（`/tmp/l19x-lab`，零网络）

### 9.1 工程

- Node `v22.19.0`；`"type": "module"`；`npx tsx eN-*.ts` 运行。
- 实际安装版本：`ai@7.0.137`、`@ai-sdk/anthropic@4.0.78`、`@ai-sdk/mcp@2.0.73`、`@mastra/core@1.76.0`、`@anthropic-ai/claude-agent-sdk@0.3.296`（附带 `claude-agent-sdk-darwin-arm64` 原生二进制）、`@openai/agents-core@0.20.0`、`zod@4.6.6`。
- 体积：`node_modules` 共 551MB，其中 `@anthropic-ai` 266MB、`@mastra` 86MB、`@openai` 30MB、`@ai-sdk` 16MB、`ai` 9.4MB。**这个数字直接影响 §13 的 lab 方案。**
- 「零网络」的做法：AI SDK / Mastra 用 `MockLanguageModelV4`（`ai/test`）；AI SDK 的 Anthropic provider 用自定义 `fetch` 截获请求体；MCP 用自写内存 transport；Claude Agent SDK 用 127.0.0.1 上的假 Anthropic HTTP 服务器（`ANTHROPIC_BASE_URL`），并把 `HOME`/`CLAUDE_CONFIG_DIR` 指到 `/tmp` 沙箱；OpenAI Agents SDK 用自写 `Model` 实现，且只导入 `@openai/agents-core`（避免伞包 import 时注册 OpenAI exporter）。

### 9.2 实验矩阵与关键输出

| 编号 | 文件 | 场景 | 关键输出（原样） | 对应 INV |
| --- | --- | --- | --- | --- |
| E1-A | `e1-aisdk.ts` | `ToolLoopAgent`，工具每次抛错、模型每次重试，不设 `stopWhen` | 20 次模型调用 / 20 次工具执行；`finishReason: "tool-calls"`；`text: ""`；回填 `{"type":"error-text","value":"Error: ENOENT... (secret=sk-123)"}` | INV-1, 2, 4, 8 |
| E1-B | 同上 | 裸 `generateText` 带工具 | 1 次调用 / 1 次执行；`text: ""` | INV-3 |
| E1-C | 同上 | 参数非法 / 未知工具 | 回填 `AI_InvalidToolInputError: Invalid input for tool add: ...`，循环继续 | —（与课程一致） |
| E1-D | 同上 | 第 3 步 abort | 抛 `AbortError`；返回值不存在；只有 `onStepEnd` 记录到 `[0,1]` | INV-14 |
| E1-E | 同上 | `toolApproval: 'user-approval'` | 0 次执行；`finishReason: "tool-calls"`；拒绝回填 `{"type":"execution-denied","reason":"no"}` | INV-13 |
| E1-F | 同上 | 模型端 429 | 共 3 次调用，然后 `AI_RetryError` | INV-17 |
| E1-G | 同上 | 真 `@ai-sdk/anthropic` + 假 fetch，`baseURL=https://api.deepseek.com/anthropic/v1`，`model=deepseek-v4-pro` | 警告 "max output tokens have been limited to 4096"；`tool_result` 带 `is_error:true`；无 `cache_control` | INV-11, 29 |
| E2 | `e2-aisdk-mcp-ui.ts` | MCP 工具返回 `isError:true` | 步骤内容是 `tool-result`（不是 `tool-error`）；发给 Anthropic 的 `tool_result` **没有** `is_error` | INV-10 |
| E2 | 同上 | UI 流 + `convertToModelMessages` | 同一请求里模型看到 "Error: ENOENT a.ts; 试试 src/a.ts"；UI 的 `errorText` 是 "An error occurred."；下一轮模型看到 `{"type":"error-text","value":"An error occurred."}` | INV-12 |
| E3 | `e3-mastra.ts` | Mastra `Agent`，工具每次抛错 | 5 次模型调用 / 5 次工具调用；`finishReason: "tool-calls"`；回填 `ENOENT nope (secret=sk-123)` | INV-4, 8 |
| E3 | 同上 | workflow step：`db.push` 后 `suspend()`，再 `resume()` | 状态 suspended → success；db 行数 1 → **2** | INV-15 |
| E4 | `e4-thinking.ts` | thinking 签名 × 流式/非流式 | 非流式缺签名 → `AI_APICallError: Invalid JSON response`；流式缺签名 → thinking 被丢弃，只回传 `["tool_use"]` + 警告 "unsupported reasoning metadata" | INV-31 |
| E5-A | `e5-claude-agent-sdk.ts` | 不传 `permissionMode` | `init.permissionMode = "auto"`；每次工具调用约 10 次 `claude-sonnet-5` 分类器请求；失败即拒 + 「原样重试」提示 → 死循环 | INV-5, 21, 22 |
| E5-A2 | 同上 | `default` + `allowedTools` | 回填 `"EACCES: permission denied (secret=sk-123)"`, `is_error: true` | INV-8 |
| E5-A3 | 同上 | `default`，无 `allowedTools`/`canUseTool` | `"Claude requested permissions to use mcp__lab__boom, but you haven't granted it yet."`；`subtype` 仍为 `success` | INV-23 |
| E5-B/C | 同上 | resume / fork | resume 同 id、完整回放；fork 新 id，`total_cost_usd` 继承父会话累计值（0.0024 ⊃ 0.0018） | INV-20, 28 |
| E6-A | `e6-openai-agents.ts` | 工具每次抛错、模型每次重试 | 10 次模型 / 10 次工具；抛 `MaxTurnsExceededError: Max turns (10) exceeded`；回填 "An error occurred while running the tool. Please try again." | INV-6, 9 |
| E6-B | 同上 | `needsApproval` → 序列化 → 批准 → 恢复，同一状态恢复两次 | 工具执行 1 → **2** 次 | INV-16 |
| E6-C | 同上 | reject | 回填 "Tool execution was not approved." | INV-13 |
| E6-D | 同上 | 输入 guardrail 50ms 后触发 | 默认：模型已调用 1 次；`runInParallel:false`：0 次 | INV-25 |
| E6-E | 同上 | `maxTurns:3` + `errorHandlers.maxTurns` | 不加 handler 抛错；加了返回 `finalOutput: "已到步数上限，停止"` | INV-6 |
| E6-F | 同上 | 配置默认值 | `traceIncludeSensitiveData: true`；`setTracingDisabled(true)` 后 `Runner.config.tracingDisabled` 仍为 `false` | INV-27 |

### 9.3 一段可直接搬进 lab 的观测代码（E6-B 的核心）

```ts
const saved = r1.state.toString()               // 审批中断时持久化
for (const k of [1, 2]) {                        // 模拟：worker 崩溃后重放同一条审批
  const st = await RunState.fromString(agent, saved)
  for (const it of st.getInterruptions()) st.approve(it)
  await run(agent, st)
}
// 输出：工具累计执行 [1] → [2]
```

这段代码的「红/绿」判断很简单：课程 L08/L19 的实现里这个数字必须是 1。

### 9.4 没做的实验

Claude Agent SDK 的自动压缩与 33 个 hooks 的执行顺序、AI SDK 可恢复流（需 Redis）、Mastra scorer 采样、三个平台的运行时、任何真 DeepSeek 调用——均未实测，相关结论只来自源码/文档。

---

## 10. 部件对照表：手写部件 × 框架

图例：✅ 默认行为与课程不变量一致；⚠️ 有等价物但默认值冲突；❌ 没有等价物 / 必须自己做；— 不适用。每格先写「等价物」，再写「默认值」。

| 课程部件 | AI SDK 7 | Mastra 1.76 | Claude Agent SDK 0.3.296 | OpenAI Agents SDK 0.20 |
| --- | --- | --- | --- | --- |
| **L05 循环 + 终止** | ⚠️ `ToolLoopAgent` / `stopWhen`；默认 `isStepCount(20)`（`generateText` 为 1）；撞上限正常返回但无停止原因字段 | ⚠️ `Agent.generate`；默认 5 步 | ⚠️ `query()`；`maxTurns` **无默认**；`result.subtype` 给出 `error_max_turns` 等显式原因 ✅ | ⚠️ `run()`；默认 10 轮；超限抛 `MaxTurnsExceededError`（可用 `errorHandlers.maxTurns` 转为返回） |
| L05 重复调用检测 | ❌ 自己写在 `stopWhen` 里 | ❌ | ❌（无公开选项） | ❌ |
| **L05/L14 工具错误回填** | ⚠️ catch → `error-text`，`error.toString()`，含敏感信息；Anthropic 线上带 `is_error` | ⚠️ `error.message` 原样 | ⚠️ `error.message` + `is_error` | ⚠️ 固定文案 "An error occurred while running the tool. Please try again."，信息全丢 |
| L06 压缩 | ❌ 自己在 `prepareStep` 里做（返回的 messages 会成为后续基底） | ⚠️ `lastMessages: 10` 滑动窗口（破坏前缀缓存） | ⚠️ 自动压缩 + `compact_boundary` 消息；阈值由二进制决定 | ⚠️ 会话压缩接口只对 OpenAI Responses 有现成实现 |
| **L08 事件日志 / 断点续跑** | ❌ `ToolLoopAgent` 无持久化；`WorkflowAgent` 需 Workflow DevKit | ⚠️ workflow snapshot；resume **从 step 开头重跑** | ⚠️ JSONL 会话文件；`resume` / `forkSession` / `resumeSessionAt` | ⚠️ `RunState` 序列化；同一状态可被重复恢复 |
| **L08 幂等键** | ❌ | ❌ | ❌ | ❌（模型请求重试有「重放安全」分类 ✅，工具副作用没有） |
| L08 重试 | ⚠️ `maxRetries: 2`，指数退避，无幂等键 | ⚠️ 继承 AI SDK | 二进制内部（未查） | ✅ 默认不重放「可能已开始」的请求 |
| L09 检索 | ❌（只有 embedding 工具函数） | ⚠️ `@mastra/rag` + 向量库适配 | ❌（Grep/Glob/Bash） | ⚠️ 托管 file search（OpenAI 专属） |
| L10 MCP | ⚠️ `@ai-sdk/mcp`；`isError` 在转换中丢失 | ⚠️ `@mastra/mcp` | ✅ `mcpServers` + 进程内 `createSdkMcpServer` | ⚠️ 本地 MCP server 类 + 托管 MCP |
| L11 子 agent / handoff | ❌ 自己把 agent 包成 tool | ⚠️ agent network / agent-as-tool | ⚠️ `agents` + `Agent` 工具；子 agent 模型单独配置 | ⚠️ handoff 默认**整段历史**交出；输入 guardrail 只在第一个 agent 上跑 |
| L12 evals | ❌（只有 mock 模型） | ⚠️ scorers：异步、采样、需注册 | ❌ | ❌（trace 面板，非 eval） |
| **L13 tracing** | ⚠️ `telemetry`：注释原文 "Enabled by default when a telemetry integration is registered"，输入记录 "Enabled by default"（`ai@7.0.137 dist/index.d.ts:1105-1113`）——注册即开、默认记录输入 | ⚠️ 自带 observability，导出目标需配置 | ⚠️ OTel 环境变量；分类器调用**不计入** usage | ⚠️ 默认开，默认导出到 OpenAI，默认含敏感数据 |
| **L14 审批门** | ⚠️ `toolApproval`；审批状态在客户端可控的历史里（可用 `experimental_toolApprovalSecret` 签名） | ⚠️ `requireApproval` / workflow suspend | ⚠️ 默认 `auto`（模型分类器，写死 Claude 模型）；`canUseTool` / hooks | ⚠️ `needsApproval`；拒绝回填不带原因 |
| L14 沙箱 | ⚠️ `experimental_sandbox` 参数存在于 `generateText`/`streamText`（未深入） | ⚠️ `workspace` 模块（`@mastra/core/dist/workspace/`，未深入） | ⚠️ `sandbox` 选项（OS 级） | ⚠️ sandbox agents（未深入） |
| L14 输入/输出检查 | ❌ | ⚠️ processors | ⚠️ hooks | ⚠️ guardrails；输入 guardrail 默认与模型**并行** |
| **L15 缓存断点** | ⚠️ `providerOptions.anthropic.cacheControl`，默认不放 | ⚠️ 同 AI SDK | ⚠️ 二进制自动放（主循环 2 处、分类器 3 处）；DeepSeek 忽略 | ⚠️ `promptCacheOptions`（OpenAI 专属） |
| L15 路由 / 成本 | ⚠️ 未知模型 ID 输出上限默认 4096 | ⚠️ model router（字符串 `provider/model`） | ⚠️ `total_cost_usd` 按 Claude 价目算；fork 继承累计 | ⚠️ `usage` 按请求累计 |
| **L15/L16 thinking 回传** | ⚠️ 流式缺签名静默丢弃；非流式缺签名直接报错 | ⚠️ 继承 AI SDK | ✅ 二进制处理（对 DeepSeek 的行为未验证） | — （Chat Completions 路径不回传 reasoning，未深入） |
| **L16 流协议 / 中断** | ⚠️ UI message stream v1；`reset-step` 协议有但 `streamText` 不发；错误默认遮罩且污染下一轮历史 | ⚠️ 自有 stream 格式 + AI SDK 兼容输出 | ⚠️ `SDKMessage` 流；`interrupt()` | ⚠️ `StreamedRunResult`；流式请求发出事件后不重试 ✅ |
| L17–L19 capstone（coding agent） | ❌ 自己组装 | ⚠️ 有 workspace 工具 | ✅ 它**就是**一个 coding agent（工具集 = Claude Code） | ⚠️ `shellTool` / `applyPatchTool`（不走 tool guardrail） |

读表方法：粗体行是课程不变量最集中的部件；整列看，**没有一个框架在全部粗体行上默认满足课程不变量**；整行看，L08 幂等键一行全是 ❌——这是本课最应该强调的一行。

<!-- 对照表结束 -->

---

## 11. 国内低代码平台：Dify、Coze Studio、n8n

本节所有许可与结构结论都来自仓库原文件（2026-10-12 用 `curl` 拉取 `main`/`master` 分支）；未部署实例，**没有任何平台的运行时实测**。

### 11.1 版本与许可快照

| 平台 | 最新发布（GitHub Releases API） | 许可 | 运行时语言 |
| --- | --- | --- | --- |
| Dify | `1.17.1`（2026-09-10） | "a modified version of the Apache License 2.0"（`LICENSE`） | Python（`api/`）+ React（`web/`）；新增 `dify-agent/` |
| Coze Studio | `v0.5.1`（2026-02-05） | Apache-2.0（`LICENSE-APACHE`） | Go 后端（DDD 微服务）+ React/TS 前端；agent/workflow 运行时基于 CloudWeGo Eino |
| n8n | `n8n@2.42.6`（2026-10-09）；`@n8n/nodes-langchain@2.43.0` | Sustainable Use License 1.0（`.ee.` 文件另需企业许可） | TS；AI 节点基于 LangChain JS + LangGraph |

### 11.2 Dify

**许可（原文，`langgenius/dify@main/LICENSE`）**[P]：

> "a. Multi-tenant service: Unless explicitly authorized by Dify in writing, you may not use the Dify source code to operate a multi-tenant environment.
> - Tenant Definition: Within the context of Dify, one tenant corresponds to one workspace."

> "b. LOGO and copyright information: In the process of using Dify's frontend, you may not remove or modify the LOGO or copyright information in the Dify console or applications. This restriction is inapplicable to uses of Dify that do not involve its frontend."

> "2. As a contributor, you should agree that: a. The producer can adjust the open-source agreement to be more strict or relaxed as deemed necessary."

要点：(1) 「租户 = workspace」——给多个客户各开一个 workspace 的 SaaS 就需要书面授权；(2) 只用后端 API、不用 `web/` 前端时，LOGO 限制不适用；(3) 贡献者同意许可可被收紧。**「Dify 是 Apache 2.0」这个说法不准确**——它是附加条件的 Apache 2.0 变体，不是 OSI 意义上的开源许可（OSI 判定本报告未查到一手来源，只陈述条款本身）。

**架构（`docker/docker-compose.yaml` 服务清单）**[P]：`api`、`api_websocket`、`worker`、`worker_beat`（Celery）、`web`、`db_postgres`/`db_mysql`、`redis`、`sandbox`（代码节点执行）、`plugin_daemon`、`agent_backend`、`ssrf_proxy`/`agent_ssrf_proxy`、`nginx`，以及 20 余种可选向量库（weaviate、qdrant、pgvector、milvus、opensearch、oceanbase……）。工作流节点目录 `api/core/workflow/nodes/` 下有 `agent`、`agent_v2`、`human_input`、`knowledge_retrieval`、`knowledge_index`、`trigger_*` 等。

**一个值得注意的事实**：Dify 新增的 `dify-agent/` 目录 README 原文："Dify Agent runs Pydantic AI with native capabilities and toolsets."[P] → 低代码平台自己的 agent 运行时**用的是通用 agent 框架**（Pydantic AI）——与 §12 论文里「coding harness 不用框架」形成对照：平台和 harness 的取舍不同。

**DSL（`api/services/app_dsl_service.py` + 测试夹具）**[P]：

- 当前版本 `CURRENT_APP_DSL_VERSION = "0.7.0"`（`api/constants/dsl_version.py`）；导入时缺 `version` 就当 `"0.1.0"`、缺 `kind` 就补 `"app"`，再做 `check_version_compatibility`。
- 顶层结构：`app`（name/mode/icon）、`kind: app`、`version`、`dependencies`（插件依赖）、`workflow`（`graph.nodes` / `graph.edges` / `environment_variables` / `conversation_variables` / `features`）。
- 节点：`data.type` 是语义（`start`/`llm`/`tool`/`http-request`/`knowledge-retrieval`/`answer`/`end`…），变量引用写成 `'{{#node_id.field#}}'`（例：`url: '{{#start_node.url#}}'`）。**同一个节点里混着 UI 字段**：`position`、`positionAbsolute`、`width`、`height`、`selected`、`zIndex`——拖动一下画布，git diff 就会出现与语义无关的变化。
- LLM 节点（`api/tests/fixtures/workflow/basic_chatflow.yml`）：`model.{provider,name,mode,completion_params}`、`prompt_template[]`、`memory.window.{enabled:false,size:10}`、`context.{enabled,variable_selector}`、`vision`。
- 导出时的脱敏（`app_dsl_service.py:995-1012`）：`include_secret=False`（默认）时，删掉工具节点和 agent 节点工具的 `credential_id`；知识检索节点的 `dataset_ids` **用租户 id 加密**后导出（`encrypt_dataset_id(dataset_id=..., tenant_id=app_model.tenant_id)`）；webhook URL、定时配置被清空/重置。→ **DSL 不包含知识库内容，且知识库引用绑定在原租户**——把 DSL 导到另一个实例，检索节点是断的。
- 导入信息在 Redis 里暂存 10 分钟（`IMPORT_INFO_REDIS_EXPIRY = 10 * 60`）。

**从 Dify DSL 改写为代码的读法**（课程可直接用的步骤）：

1. 删掉 UI 字段（`position*`、`width`、`height`、`selected`、`zIndex`、`sourcePosition`、`targetPosition`），剩下的才是语义。
2. 用 `edges` 做拓扑排序；`sourceHandle` ≠ `source` 的边对应 if-else / 分类分支。
3. `{{#node.field#}}` 引用 → 函数参数/返回值的数据流；`sys.query`、`sys.files`、`conversation_variables` → 会话状态（L08 事件日志里的字段）。
4. `llm` 节点 → 一次模型调用（不是 agent loop）；`agent`/`agent_v2` 节点 → 一个 L05 的循环（要补：步数上限、停止原因）。
5. `memory.window.size` → L06 的历史策略（注意滑动窗口会破坏前缀缓存，同 Mastra `lastMessages`，见 §5.4）。
6. `knowledge-retrieval` → L09 的检索函数，`dataset_ids` 要换成你自己的索引；`retry_config`、`timeout` → L08 的重试与幂等（Dify 的 HTTP 节点默认 `retry_config.enabled: false`）。
7. `tool` 节点的 `credential_id` 在导出时已被删 → 凭据要从你的 secrets 管理里重新接。
8. 给每个节点写一条 L12 的回归 eval（DSL 本身没有测试的位置）。

### 11.3 Coze Studio（扣子开源版）

- README 原文："The backend of Coze Studio is developed using Golang, the frontend uses React + TypeScript, and the overall architecture is based on microservices and built following domain-driven design (DDD) principles."[P]
- 致谢原文："The Eino framework team - providing powerful support for Coze Studio's agent and workflow runtime engines, model abstractions and implementations, and knowledge base indexing and retrieval"[P] → 开源版的运行时也建立在一个通用框架（Eino）上。
- 许可：Apache-2.0（`LICENSE-APACHE`），**没有 Dify 那样的多租户条款**。[P]
- 模型：README 原文 "Before deploying the open-source version of Coze Studio, you must configure the model service. Otherwise, you cannot select models when building agents, workflows, and apps."；模型服务 "integrate services such as OpenAI and Volcengine"。[P] 是否原生支持 DeepSeek 的 Anthropic 端点：**未查到一手来源**。
- 最近一次 release 是 2026-02（距今 8 个月）；活跃度、云端与开源版差异均未查（§14.2）。

### 11.4 n8n 的 AI 节点

- 许可原文（`n8n-io/n8n@master/LICENSE.md`）："You may use or modify the software only for your own internal business purposes or for non-commercial or personal use. You may distribute the software or provide it to others only if you do so free of charge for non-commercial purposes."[P] → 内部自用可以；**把 n8n 嵌进对外收费产品不在许可范围内**。另："Source code files that contain \".ee.\" in their filename or \".ee\" in their dirname are NOT licensed under the Sustainable Use License."
- AI 节点包 `@n8n/nodes-langchain@2.43.0` 依赖 `@langchain/core`、`@langchain/langgraph`、`@langchain/anthropic`、`@langchain/openai` 等十几个 LangChain 包（`package.json:252-270`）。[P]
- Tools Agent 默认值（`nodes/agents/Agent/agents/ToolsAgent/options.ts`）：`maxIterations` 默认 `10`，`returnIntermediateSteps` 默认 `false`，`passthroughBinaryImages` 默认 `true`。[P] → 默认**不返回中间步骤**：工作流的下游节点看不到 agent 调了哪些工具（L13 可观测性的缺口）。

### 11.5 平台 vs 手写：判定表

| 维度 | 平台（Dify / Coze Studio / n8n）给你的 | 手写（本课程）给你的 | 平台适合的条件 |
| --- | --- | --- | --- |
| 版本管理 | DSL/JSON 导出，夹带 UI 坐标；知识库与凭据不在其中 | 代码 + git + 锁定依赖 | 变更频率低、改动人是非工程师 |
| 测试 / eval | 平台内调试面板；DSL 里没有测试位置 | L12 的回归集 + CI | 能接受「人工点一遍」当回归 |
| 可观测性 | 平台自带日志；n8n 默认不返回中间步骤 | L13 OTel，span 去哪你决定 | 不需要和公司现有 trace 打通 |
| 权限 | 平台的 workspace/角色模型 | L14 审批门 + 沙箱 + 服务端审批状态 | 工具都是只读或低风险 |
| 成本归因 | 平台按 app/workspace 统计 | L15 按请求/用户/特性打标签 | 不需要按客户分账 |
| 许可 | Dify 多租户需授权；n8n 不能做对外收费产品；Coze Studio Apache-2.0 | 你自己的代码 | 内部工具、单租户 |
| 失败恢复 | 平台的重试配置（Dify HTTP 节点默认关） | L08 幂等键 + 断点续跑 | 节点都是幂等的 |

经验法则（[P2]，本报告的推论）：**流程固定、工具只读、使用者是内部运营** → 平台；**需要 eval 门禁、按租户计费、写操作需要审批、或要进 CI** → 手写（或至少把平台当原型、把 DSL 当需求文档）。

---

## 12. arXiv 2609.00006：Harness Engineering

题目："Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents — A Source-Code Study of Eleven Systems"（<https://arxiv.org/abs/2609.00006>，2026-10-12 访问）。研究对象（原文）："Claude Code (Anthropic), Codex CLI (OpenAI), Gemini CLI (Google), Mistral Vibe (Mistral), OpenHands, Aider, Mini-SWE-Agent, Hermes (Nous Research), Pi, OpenCode, and OpenClaw, plus Omnigent (Databricks)"，源码锁定在 2026 年 7 月的版本。

### 12.1 原文

摘要 [P]：

> "Two absences survive a threefold corpus expansion: across roughly four million lines of Python, TypeScript, and Rust, no agent runtime imports a general-purpose agentic framework (LangChain, LangGraph, AutoGen, or a dozen others; Gemini CLI uses neither of Google's own), and none retrieves code with vector embeddings; the field runs on hand-rolled async loops and deterministic retrieval (ripgrep, tree-sitter, glob, auto-discovered Markdown context files)."

§13.2 检查清单与边界 [P]：

> "Every dependency manifest was inspected, and every source tree grepped for imports of the widely deployed agentic frameworks: LangChain, LangGraph, LlamaIndex, AutoGen, CrewAI, Pydantic AI, Genkit, Haystack agents, Semantic Kernel, Google's ADK, and several smaller libraries (Smolagents, Swarm, Agno)."

> "And OpenCode delegates its inner LLM/tool plumbing to Vercel's AI SDK—a provider-abstraction layer, not an agent-orchestration framework, but the first corpus system whose inner loop plumbing is a third-party SDK at all (an in-house replacement client sits behind a flag, suggesting the dependency is transitional)."

> "Every loop is hand-rolled in the host language's native primitives ... Every tool registry is custom-built around Pydantic, Zod, TypeBox, Effect Schema, or Rust enums. Every prompt template is plain Markdown, Jinja2, or string concatenation."

局限性（§15）[P]：

> "we did not trace internal forks, plugins loaded via dynamic importlib/ require, or transpiled distributions. A company could in principle use LangChain inside a production SWE agent through a code path we did not inspect. We would be surprised, but not shocked."

§14.2 的「合流」论点 [P]：

> "And the meta-harness of the next subsection completes the picture from above: its baseline installation imports claude-agent-sdk and openai-agents as production dependencies—the "frameworks" a 2026 orchestration layer builds on are the harness SDKs. The twin absence of 2025-era frameworks thus gets its historical resolution: harnesses did not adopt the frameworks; they replaced them, became importable themselves, and turned the question "which agentic framework should I use?" into "which harness do you already run?""

### 12.2 对 L19x 的含义

1. **「11 个 harness 无一用框架」要精确地说**：被检查的框架清单里**没有** Vercel AI SDK、Mastra、Claude Agent SDK、OpenAI Agents SDK；AI SDK 被明确归为 "provider-abstraction layer, not an agent-orchestration framework"，而且 OpenCode 在用它。所以这篇论文**不能**拿来证明「生产环境不该用 AI SDK」，只能证明「生产 coding harness 的 agent loop 都是自己写的」。[P2]
2. 论文的结论与本课程立场一致：loop、工具注册、prompt 模板都是手写的；**框架层面能被接受的是「provider 抽象」**（AI SDK 的 `streamText`/provider 包），不是「编排」（`ToolLoopAgent`、Mastra workflow）。这正好对应本报告的建议：L19x 教「拿 provider 层、拒绝编排层的默认值」。[P2]
3. 「合流」论点意味着 Claude Agent SDK、OpenAI Agents SDK 这类「harness 当库用」的产品，**正在成为新的框架**——而它们的默认值（§6、§7）恰恰是一个 coding harness 的默认值（无上限、`auto` 分类器、全量历史），不是你业务 agent 的默认值。[P2]
4. 论文里的 Gemini CLI 细节（"five identical tool calls or ten identical content chunks abort the loop"、"A session turn limit (default 100)"）可作 L05 重复调用检测的旁证；但这是论文对他人源码的描述，按本报告规则标 [S]，**不作为数字依据**。
5. 摘要中 "SKILL.md skills lead MCP in adoption (9/11 vs. 8/11)"——是论文自己的统计 [P]；可作为 L10 的补充数据点。

---

## 13. Lab 设计提案

### 13.1 (a) 装框架 vs (b) 只做适配层

| | (a) 在 `labs/` 装框架、锁精确版本、mock 模型 | (b) 不装框架，只写把课程共享模块套成框架形状的适配层 |
| --- | --- | --- |
| 能证明的东西 | **框架真实的默认值**（§9 的 22 组实测都依赖真包） | 只能证明「我们以为框架是这样」——这正是本课要打破的东西 |
| 依赖体积 | 全装 551MB；只装 `ai` + `@openai/agents-core` 约 55MB | 0 |
| 维护 | 0.x 包（Claude Agent SDK、OpenAI Agents SDK）minor 即可破坏；`ai` 一个月 36 个补丁 | 低 |
| 许可 | Claude Agent SDK 为专有许可，二进制按平台分发 | 无 |
| 零模型调用 | AI SDK / Mastra / OpenAI 有官方 mock 或可自写 `Model`；Claude Agent SDK 需起本地假 HTTP 服务器并隔离 `HOME`（§9.1）——实测仍会触发分类器请求 | 天然满足 |

**推荐：(a) 的瘦身版 + (b) 的 TODO 形态。**

1. **只装两个包**，精确版本（不写 `^`）：`ai@7.0.137`、`@openai/agents-core@0.20.0`（不装伞包 `@openai/agents`，避免 import 即注册 exporter——这本身就是 INV-27 的教学点）。理由：一家「默认泄露」、一家「默认抹掉」，覆盖两个极端；两者都能零网络跑 mock；合计约 55MB。
2. **Mastra 作可选**：`labs/l19x/optional/mastra.ts` + 单独脚本 `eco19:mastra`，不进默认 verify（86MB，且自带三代 AI SDK）。
3. **Claude Agent SDK 不安装**：把 E5 抓到的请求体裁剪成 `labs/l19x/fixtures/cas-*.json`（init 消息、分类器请求头部、三种 tool_result、resume/fork 结果），观测脚本读夹具打印表格。在 lab 说明里给出 §9.1 的复现方法，供有兴趣的学员在本机 `/tmp` 自行验证。
4. **TODO 是「适配层」**：学员不调框架参数，而是把自己 L05–L16 的不变量写成框架扩展点的实现——这就是 (b) 的价值，但跑在真框架上。

### 13.2 文件草图

```
labs/l19x/
  ecosystem.ts      # 观测：E1/E2/E4/E6 精简版，打印红绿表；ECO19_IMPL=shared 切到参考实现
  adapters.ts       # TODO：学员实现的 4 个适配器
  fixtures/         # cas-init.json, cas-classifier.json, cas-tool-results.json, cas-fork.json, dify-sample.yml
  verify.ts         # 36 条零模型断言，每条注明 INV 编号
  ecosystem.py      # Python 侧：只读同一份 fixtures + 打印同一张表（不装任何框架）
  verify.py         # 断言 Python 适配器（纯函数版本）与 TS 输出一致
labs/shared/tsecosystem.ts   # 参考实现 + 工具函数：fakeModel()、countingTool()、secretTool()、captureFetch()
```

`package.json` 新增脚本（照 L11x 的 `eco` / `eco:shared` / `verify:l11x` 命名）：`eco19`、`eco19:shared`、`verify:l19x`。

### 13.3 四个 TODO（适配器）

```ts
// 1. I-STOP：把课程的停止原因带进 AI SDK
export function courseStop(opts: { maxSteps: number; maxRepeat: number }): {
  stopWhen: StopCondition<any>[]; reasonOf(steps: StepResult<any>[]): 'done' | 'max_steps' | 'repeat' | 'approval'
}
// 2. I-ERR：给两家框架同一个错误出口（脱敏 + 给出路 + 截断）
export function courseToolError(e: unknown, ctx: { tool: string; args: unknown }): string
export const aiSdkTool = (t: CourseTool) => tool({ ...t, execute: wrapThrowToText(t.execute, courseToolError) })
export const agentsErrorFunction = (_ctx: RunContext, e: unknown) => courseToolError(e, ...)
// 3. I-IDEM：审批恢复只消费一次
export async function resumeOnce(store: KV, approvalId: string, resume: () => Promise<RunResult>): Promise<RunResult | 'already-consumed'>
// 4. I-ERR × MCP：isError → 错误文本（DeepSeek 忽略 is_error，必须体现在文本里）
export function mcpResultToText(r: CallToolResult): { text: string; isError: boolean }
```

### 13.4 观测实验（`ecosystem.ts`，确定性假数据）

| 表 | 内容 | 红/绿 |
| --- | --- | --- |
| T1 默认步数 | 同一个「永远失败」的工具，在 `generateText` / `ToolLoopAgent` / `run()` 下的模型调用数、工具执行数、终止方式 | 无停止原因 = 红 |
| T2 错误回填 | 同一个带 `sk-123` 的异常，在 AI SDK / Agents SDK / 夹具（Claude）中的回填文本 | 含 `sk-` 或不含出路 = 红 |
| T3 历史漂移 | E2-UI 链路：第 N 轮 vs 第 N+1 轮模型看到的错误文本 | 不相等 = 红 |
| T4 重放 | E6-B：同一份 `RunState` 恢复两次的副作用次数 | >1 = 红 |
| T5 thinking 矩阵 | 流式 / 非流式 × 有 / 无签名 | 静默丢弃 = 红 |
| T6 夹具：Claude Agent SDK | 默认 permissionMode、分类器模型名、成本是否含分类器、fork 成本继承 | 读夹具，全部标红并注明 INV |

`ECO19_IMPL=shared` 时，T1/T2/T4 换成接上适配器后的版本，应全部变绿。

### 13.5 verify：36 条零模型断言

| # | 断言 | INV |
| --- | --- | --- |
| 1–3 | `ToolLoopAgent` 默认 20 次模型调用；`finishReason==='tool-calls'`；`text===''` | 1 |
| 4 | 结果对象上没有任何停止原因字段 | 2 |
| 5 | `generateText` 带工具默认 1 次调用 | 3 |
| 6 | `run()` 默认抛 `MaxTurnsExceededError` 且 `e.state` 存在 | 6 |
| 7 | 配 `errorHandlers.maxTurns` 后正常返回 | 6 |
| 8 | AI SDK 回填文本包含 `Error:` 前缀与原始异常消息 | 8 |
| 9 | Agents SDK 回填 === 固定文案 | 9 |
| 10 | 参数非法 → `error-text` 且循环继续 | — |
| 11 | MCP `isError:true` → 线上 `tool_result` 无 `is_error` | 10 |
| 12 | Anthropic provider 对 `error-text` 设 `is_error:true`（对照组） | 11 |
| 13–14 | UI 往返：第 N 轮含原文；第 N+1 轮 === `An error occurred.` | 12 |
| 15–16 | 拒绝回填：AI SDK 无 `is_error`；Agents SDK === `Tool execution was not approved.` | 13 |
| 17 | abort → 抛 `AbortError`，`onStepEnd` 收到的步数 < 发起步数 | 14 |
| 18 | 同一 `RunState` 恢复两次 → 副作用 2 次 | 16 |
| 19 | 429 → 恰好 3 次调用后 `AI_RetryError` | 17 |
| 20 | `prepareStep` 改写的 messages 在下一步仍可见 | 18 |
| 21 | `toolApproval:'user-approval'` → 0 次执行，`finishReason==='tool-calls'` | 24 |
| 22 | 未设 `experimental_toolApprovalSecret` 时，伪造的 approval 消息能让工具执行 | 24 |
| 23 | 输入 guardrail 默认并行：触发时模型调用 ≥1 | 25 |
| 24 | `runInParallel:false`：模型调用 = 0 | 25 |
| 25 | `new Runner().config.traceIncludeSensitiveData === true` | 27 |
| 26 | 未知模型 ID → warning 含 `limited to 4096`，请求体 `max_tokens===4096` | 29 |
| 27–28 | 流式缺签名 → 请求体无 thinking 块；非流式缺签名 → 抛错 | 31 |
| 29 | `streamText` 的 UI 流中从不出现 `reset-step` | 32 |
| 30–33 | 夹具：`permissionMode==='auto'`；分类器 `model` 以 `claude-` 开头且 ≠ 主模型；fork `total_cost_usd` ≥ 父会话；默认 system prompt 不含 `Claude Code` 的完整 prompt | 21, 22, 20, 34 |
| 34 | 适配器 `courseToolError` 输出不含 `sk-`，且包含工具名与下一步建议 | 8, 9 |
| 35 | 适配器 `resumeOnce` 第二次返回 `'already-consumed'`，副作用 1 次 | 16 |
| 36 | 适配器 `mcpResultToText` 对 `isError:true` 输出以 `[tool error]` 开头 | 10, 11 |

### 13.6 Python 侧

只观测、不装框架：`ecosystem.py` 读同一份 `fixtures/*.json` 打印 T2/T6；`verify.py` 对适配器的纯函数版（`course_tool_error`、`mcp_result_to_text`、`resume_once`）做同样的 34–36 号断言。理由：L11x 已经在 Python 侧装过 LangGraph/DSPy；L19x 的框架都是 TS 原生；Python 版 OpenAI Agents SDK / Claude Agent SDK 的默认值与 TS 版是否一致**未核实**（列入 §14），不能拿 TS 的结论去断言 Python 包。

### 13.7 与相邻课程的边界

- **L05**：L05 §四已有「框架包装了什么」的表；L19x 不重讲循环，只拿 L05 的 `AgentRun.reason` 作为 T1 的判据。
- **L11x**：Python 生态（LangGraph `interrupt` 重跑节点、DSPy）归 L11x；LangGraph.js 在 L19x 只出现在 §8 一张表里。
- **L16**：流协议细节（UI message stream 字段、`reset-step` 语义）归 L16；L19x 只断言「`streamText` 不发 `reset-step`」与「错误遮罩污染历史」两件事。
- **L19**：队列、三层 key、drain/kill 归 L19；L19x 的 `resumeOnce` 直接复用 L19 的 key 设计，不重新推导。

---

## 14. 结尾

### 14.1 Top 5 最承重的反转

1. **INV-16 审批恢复不幂等**（OpenAI Agents SDK 同一份 `RunState` 恢复两次，副作用两次；Mastra resume 重跑整个 step 是同一类问题 INV-15）。四家框架在「L08 幂等键」一行全部为空——这是手写不可替代的最强证据。
2. **INV-8 / INV-9 工具错误的两个极端**：三家把带密钥的原始异常塞进上下文，一家把信息全抹掉还让模型原样重试；**没有一家默认满足「脱敏 + 给出路」**。叠加 INV-11（DeepSeek 忽略 `is_error`），错误文本是课程默认模型上唯一的信号。
3. **INV-5 / INV-21 / INV-22 Claude Agent SDK 的默认组合**：无轮数上限 + 默认 `auto` 分类器（写死 Claude 模型、成本不入账）+ 失败即拒且提示「原样重试」= 实测死循环。「能接 DeepSeek」不等于「行为一致」。
4. **INV-12 UI 错误遮罩改写下一轮历史**：同一个 tool_result 在第 N 轮和第 N+1 轮内容不同，同时打破「错误要给出路」和「前缀稳定」。
5. **INV-27 tracing 默认出网**：OpenAI Agents SDK import 即注册 OpenAI exporter，默认包含模型输入输出，测试环境（`NODE_ENV=test`）默认关闭——测试看不到，生产才发生。

### 14.2 没有一手来源的说法（不得写进课程正文当事实）

- DeepSeek Anthropic 兼容端点对 thinking `signature` 的具体要求（缺签名会不会 400），以及对 `thinking: {type:'adaptive'}`、messages 内 `role: "system"`、`context_management`、`output_config` 字段的处理。
- `deepseek-flash` 能否稳定按 `<severity>N</severity>` 协议回答 Claude Code 的权限分类器。
- Claude Agent SDK 自动压缩的触发阈值；`total_cost_usd` 使用的具体价目表。
- Mastra `ee/LICENSE` 的具体条款；`HarnessAgent` 未调查。
- OpenAI Agents SDK 的 sandbox agents、`SessionHistoryTransaction` 语义；Chat Completions 路径对 DeepSeek `reasoning_content` 的回传行为。
- Python 版 OpenAI Agents SDK / Claude Agent SDK 的默认值是否与 TS 版一致。
- Dify 许可是否被 OSI 认定为开源；Coze 云端与 Coze Studio 的功能差异；Coze Studio 是否原生支持 DeepSeek Anthropic 端点；三个平台的运行时行为（均未部署）。
- 论文中关于 Gemini CLI 循环检测阈值的数字（论文对他人源码的转述，标 [S]）。

### 14.3 对照表摘要

全表见 §10。没有一家框架在终止、错误回填、幂等、tracing、审批这五个粗体部件上默认满足课程不变量，L08 幂等键一行全部为 ❌。框架真正省下的是 provider 适配、流协议编解码、schema 校验、会话序列化——与论文 "a provider-abstraction layer, not an agent-orchestration framework" 的划分一致。

### 14.4 Lab 推荐（摘要）

装两个包（`ai@7.0.137`、`@openai/agents-core@0.20.0`，精确版本，约 55MB），Mastra 作可选脚本，Claude Agent SDK 用 E5 抓到的请求体夹具；TODO 是 4 个「把课程不变量接进框架扩展点」的适配器；`verify:l19x` 36 条零模型断言逐条挂 INV 编号；Python 侧只读夹具，并验证适配器的纯函数版本。

### 14.5 课时主题建议（4–5 讲，可在 120–150 分钟内完成）

1. **「同一个失败工具，四种死法」**（30 分钟）：T1 + T2，INV-1～9。产出：`courseStop` 与 `courseToolError` 两个适配器。
2. **「历史是谁的」**（30 分钟）：UI 遮罩改写历史、abort 丢步、`prepareStep` 成为基底、thinking 静默丢弃，INV-12、14、18、31。产出：服务端持久化 model messages 的对照实验。
3. **「恢复两次会怎样」**（30 分钟）：Mastra resume 重跑 step、`RunState` 重复恢复、审批签名，INV-15、16、24。产出：`resumeOnce`。
4. **「跑一个 Claude Code 二进制意味着什么」**（25 分钟）：读 E5 夹具，`auto` 分类器、成本不入账、默认 system prompt、DeepSeek 映射，INV-5、20～23、28、33、34。只读、不装。
5. **「平台、框架、手写的边界」**（20 分钟）：Dify DSL 改写成代码（§11.2 的 8 步）、许可三连（INV-36～38）、论文的精确结论（INV-39）。产出：一份选型判定表（§11.5）。

暂定主题若要调整：第 4 讲依赖夹具，若课程不希望出现专有二进制的抓包内容，可并入第 1 讲只保留 INV-5 与 INV-21 两条结论。
