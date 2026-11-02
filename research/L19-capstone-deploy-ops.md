# L19 调研报告 · Capstone 三：上线

> 调研日期：2026-10-09　·　目标读者：本课程的出题人/讲稿作者（不是学员）
> 课程框架：L19 = 「部署出去，别人能打开用，长任务不掉线」（`curriculum.ts` L19 条目：长任务与队列 / 幂等与重试 / 多用户与配额 / 部署与监控）
> 本报告写给：L19 的 `content.mdx`、`labs/shared/ops.{ts,py}`、`labs/l19/{ops,verify,runner}.{ts,py}` 的作者。
>
> **证据标记**（沿用 L17/L18 报告）：
> `[P]` 一手：官方文档 / 官方博客 / 规范 / 论文，本轮已读原文或原文摘录
> `[P2]` 近一手：一手但本轮只读到摘要，或二手转述一手
> `[S]` 记忆/惯例，**未复核**，全部列入 §8 的未溯源清单
> `[L]` 本地仓库事实（读过代码/文档）
> `[O]` **本报告自产证据**：我在本机跑过的探针，方法与数字在 §7，可复现
>
> **关于「已有草稿」**：调研期间发现 `labs/shared/ops.{ts,py}`、`labs/l19/{ops,verify}.{ts,py}`、`package.json` 的 `ops` / `verify:l19` 脚本在 15:09–15:14 之间陆续出现（我读到的时刻快照：`ops.ts` 559 行、`verify.ts` 41 条断言、`OPS_IMPL=shared` 下 TS 与 Python 均通过）。本报告把它当作**待审计的现有草稿**，§4 逐条审计，§6 在其上增量设计；草稿还在变，引用行为以 §7 的探针为准，不以行号为准。

---

## 0. 一句话结论

**L19 的主题不是「把 agent 放到服务器上」，而是「把一次对话变成一个有寿命、有主人、有账本、能被杀死的作业（job）」。**

前 18 课的所有东西都默认「一次进程、一个用户、一条连接、一个人在看」。上线之后这四个默认**同时**失效：进程会被滚动发布杀掉、用户有很多个、连接会断、没人在看。每一个默认失效都有一条**不抛异常**的路径让系统「看起来正常」：队列重复投递而你以为只跑一次、同一个幂等键被别的租户拿去重放、`429` 被当成瞬时错误无限重试、「记住允许」变成后门、kill switch 写在 prompt 里被压缩掉、断线重连返回空数组而 UI 以为「已追平」。

本调研得出五条贯穿全课的主张：

1. **队列语义是 at-least-once，「只执行一次」是你自己用幂等 + 围栏造出来的。** 可见性超时短于任务时长时，重复执行不是边缘情况而是常态（`[O]` §7 EXP-A：任务 10–120 s 均匀分布、可见性超时 30 s → 81.1% 的任务被重复执行，平均每任务多跑 1.63 次；加心跳或超时 ≥ 最长任务 → 0%）。（INV-1…11）
2. **幂等是三层，不是一个 key：** 作业级（创建请求）、工具调用级（L17 `store.ts` 的 intent/outcome）、外部副作用级（`once` 类：push / 开 PR / 发消息）。key 必须带租户命名空间 + 载荷指纹 + TTL；重试必须区分「花不花钱的 429」「瞬时 5xx」「流中途断」三类。（INV-12…22）
3. **公平是「成本公平」，不是「条数公平」。** 同样的「轮转」，按作业条数轮转时 whale（100 个 600 s 作业）仍拿走 98% 的 worker 秒数、minnow（100 个 10 s 作业）完工时间 14 670 s；按已付成本轮转（VTC 的思路）只要 400 s（`[O]` EXP-B）。（INV-23…31）
4. **云端 coding agent 的安全模型是「没有审批、但有围栏」**：凭据留在沙箱外、setup 阶段与 agent 阶段分离、出站白名单、会话时长上限、成本上限只是估计值。kill switch 必须在模型之外，且不能让健康检查把整个服务一起摘掉。（INV-32…42）
5. **审批记忆是一份「谁、对什么、多久、能不能被否决」的策略，不是一个布尔。** 官方数据是用户批准了 93%/97% 的提示，分类器漏报 17%——所以「每次都问」会失效，「永远记住」会变后门；中间的设计空间（once / session / ttl × 路径段边界 × deny 优先）才是 L19 要兑付的 L16/L17 欠条。（INV-43…55）

### 0.1 相对 L16/L17/L18 的更新与对账

| 项 | 之前的说法 | L19 调研后 | 来源 |
|---|---|---|---|
| L18 的 nightly 出口码 | `0` 通过 / `1` 回归 / `2` 无法评分 | 这三个码是 L19 定时任务的**契约输入**：`2`（无法评分）不得被当成 `0`；L19 的编排层必须把它翻译成「告警但不回滚」 | `[L]` L18 报告 §8、`labs/l18/` |
| L17 `idemKey` | 「内容哈希，同输入同 key」 | 对**工具调用级**重放安全，对**合法的重复调用**（同一文件连续两次 `edit` 同一串）会撞车；作业级需要**调用方提供的意图 ID**（见 INV-12） | `[L]` `shared/store.ts`、`[P]` AWS Builders' Library |
| L16 `StopPolicy` | 「卸载组件不停止生成」 | L19 给出后端对偶：**断线 ≠ 取消**，取消必须是独立端点 + 作业状态 `cancelling` | `[L]` `shared/wire.ts`、`[P]` Vercel AI SDK resumable streams |
| L15 `OverLimitKind` | `rate / spend_limit / self_imposed` | 草稿 `classifyError('429') → transient` 把三者混了（`[O]` P-l） | `[L]` `shared/budget.ts`、`[O]` |
| 「TS 与 Python 共享逻辑」 | `labs/shared/*.ts` 用 `tsx` 跑 | 33 个 `shared/*.ts` 中有 16 个在**纯 Node 22.19 strip-types 模式**下直接加载失败（参数属性 `constructor(public readonly …)` 等），其中恰好包括 L19 要消费的 `budget.ts` `guard.ts` `coding.ts` `observe.ts`。生产镜像若用 `node --experimental-strip-types` 而不是 `tsx`，**会在启动时炸** | `[O]` §0.2 |

### 0.2 本轮意外发现（需要在 L19 讲稿里补注）

**`[O]` 部署目标与 `shared/` 的语法子集不兼容。** 在 `labs/` 下对每个 `shared/*.ts` 执行 `node -e "import('./shared/X.ts')"`（Node v22.19.0）：

- 能直接加载（16 个）：`attention` `codingEval` `config` `decode` `entry` `evals` `fake` `message` `ops` `resilience` `retrieval` `sandbox` `store` `toolbox` `tools` `wire`
- `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（16 个）：`agent` `budget` `coding` `compress` `context` `guard` `ledger` `mcp` `memory` `multi` `observe` `parse` `patterns` `prompt` `pyecosystem` `stream`；例：`coding.ts` 的 `constructor(public readonly root: string) {}`（TypeScript 参数属性）
- `models.ts` 需要 `DEEPSEEK_API_KEY` 才能加载（另一类问题，见 INV-36）

后果：L19 要「部署出去」，课程第一次出现**需要在非开发机上冷启动**的 TS 代码。要么 (a) 生产命令明确写 `tsx`（并说明代价：运行时转译、冷启动变慢），要么 (b) 把 L19 新增的 `shared/ops.ts` 守在 strip-types 兼容子集（无参数属性、无 `enum`、无 `namespace`），并加一条**零模型断言**扫描源码。草稿 `ops.ts` 恰好在子集内（它是 16 个能加载的之一）——这是好事，但没有断言守着它。（INV-37）

---

## 1. 倒置清单（INV-1 … INV-55）

> 格式：**流传说法 → 实际 → 来源 → 后果 / lab 钩子**。
> 分组：A 持久执行·队列·作业状态机（1–11）· B 幂等与重试（12–22）· C 多租户配额与公平调度（23–31）· D 部署与监控 coding agent（32–42）· E SSE/WebSocket 断线续传（43–49）· F 审批记忆·后台 UI·TTFT（50–55）。§0 里的「INV-43…55」指 E+F 合称的「连接与人」两组。
> 探针编号约定：`EXP-A/B/B2` 是 §7 的两个确定性模拟；`P-a … P-n` 是对 `shared/ops.ts` 与环境的行为探针。

---

### A. 持久执行 · 队列 · 作业状态机

#### INV-1　「消息队列保证只处理一次」→ 标准队列是 at-least-once，重复投递是设计内行为
- **实际**：SQS 标准队列至少投递一次；消息被取走后在**可见性超时**内对别的消费者不可见，超时前没删除就会再次可见并被重新处理。Celery + Redis 同理：visibility timeout 默认 1 小时，ETA/countdown 超过它的任务会被反复重投。
- **来源**：`[P]` AWS SQS 开发者指南（standard queue / visibility timeout）；`[P]` Celery Redis broker 文档。
- **后果**：「作业只会跑一次」永远是**应用层**命题。lab 钩子：JOB-6/7（租约过期才能重新入队）、IDEM-*（重复执行必须无害）。`[O]` EXP-A 给出量级。

#### INV-2　「长任务就把可见性超时调大」→ 有上限，且恢复变慢；正解是心跳续租
- **实际**：SQS 可见性超时默认 30 s、上限 12 h；调大的代价是 worker 崩溃后消息要等满整个超时才能被别人处理。任务时长分布宽（coding agent 常见 10 s ~ 数十分钟）时，没有一个静态数值同时满足「不重复」和「快恢复」。`[O]` EXP-A：vt=60 s 时 54.2% 的任务被重复，vt=120 s（≥最长任务）时 0%，但崩溃后最坏要多等 120 s。
- **来源**：`[P]` AWS SQS 文档；`[O]` §7 EXP-A。
- **后果**：租约 + 心跳（`leaseUntil` + `heartbeat`）才是模型；**心跳必须检查租约是否已过期**——草稿的 `heartbeat` 在租约过期 10⁶ ms 后仍返回 `ok:true`（`[O]` P-k），僵尸 worker 可以自己续命。lab 钩子：JOB-14。

#### INV-3　「失败了就再投一次」→ 毒丸作业会把 worker 一个个杀光
- **实际**：能让 worker 进程 OOM/崩溃的作业，每次被重新投递都会再杀一个。标准做法是 `maxReceiveCount` + 死信队列（DLQ）。草稿 `Job` 没有 `attempt/claimCount` 字段，`claim → requeue_stale` 循环 1000 次后仍是 `queued`（`[O]` P-e），没有任何东西会让它停下。
- **来源**：`[P]` AWS SQS DLQ 文档；`[O]` P-e；`[L]` `shared/ops.ts` `Job`。
- **后果**：`Job.attempt` 单调递增 + `maxAttempts` + 终态 `dead`（或 `failed` + `deadLettered`）。lab 钩子：JOB-12。

#### INV-4　「worker 带个 ID 就能防僵尸」→ 同一个 workerId 重新认领后，旧进程的写入依然被接受
- **实际**：草稿用 `workerId` 做所有转移的归属检查。`w1` 认领 → 租约过期 → 被重新入队 → `w1`（重启后同名）再次认领；此时**旧进程**（GC 停顿后醒来的那个）带着 `workerId='w1'` 发 `checkpoint`，被接受（`[O]` P-f：`ok=true`）。需要的是**每次认领递增的围栏令牌（attempt epoch）**，所有写入带上它，存储层拒绝旧 epoch。
- **来源**：`[O]` P-f；围栏令牌（fencing token）概念：`[S]` Kleppmann 关于分布式锁的论述——**本轮未抓取原文**，见 §8 M-2；K8s StatefulSet / Postgres 咨询锁都不提供这个保证。
- **后果**：`claim` 返回 `epoch`，`checkpoint/heartbeat/succeed/fail` 带 `epoch`，不匹配即拒。lab 钩子：JOB-11。

#### INV-5　「事件溯源日志可以一直追加」→ 工作流引擎自己都有硬上限
- **实际**：Temporal 对单个工作流执行的事件历史有硬限制（本轮记录：51,200 个事件触发终止，另有大小上限），官方出路是 **Continue-As-New**：把当前状态带到一个新执行里，旧历史归档。agent 的「一次对话」是典型的无界历史（每个工具调用 ≥ 2 个事件）。
- **来源**：`[P]` Temporal 文档（event history limits / Continue-As-New）——数字本轮读到，列入 §8 M-1 发布前复核。
- **后果**：作业事件日志要有**压缩点**：`snapshot(upto)` + 旧事件可裁剪（L17 `store.ts` 的 `writeSnapshot` 已经有 `upto`）。注意这与 INV-47（重放缓冲保留期）共同决定 `resume` 能回溯多远。lab 钩子：CUR-2。

#### INV-6　「checkpoint 越勤越好」→ 持久化模式是延迟与丢失窗口的显式取舍
- **实际**：LangGraph 的 `durability` 有三档：`sync`（每步写完再继续）、`async`（异步写，崩溃可能丢最后一步）、`exit`（仅退出时写，崩溃丢全部进度）。Claude Agent SDK 的 `SessionStore` 是「混合会话」：**只持久化 transcript**，且是尽力而为的镜像。
- **来源**：`[P]` LangGraph persistence/durability 文档；`[P]` Claude Agent SDK hosting/session 文档。
- **后果**：L19 必须让学员**选**并**说出丢失窗口**：coding agent 里每次 `edit` 之后立即 checkpoint（sync），`read` 之类纯读调用可以 async。lab 钩子：RES-2（`planResume` 对 `once` 类副作用问人）。

#### INV-7　「能恢复会话 = 能恢复任务」→ transcript 恢复了，工作区没恢复
- **实际**：SDK 的会话恢复还原的是对话；文件系统、进程、端口、临时文件都不在里面。L17 `Workspace` 的 `hashes`（读后写校验的哈希）、`truncated`、`snapshot`（回滚快照）、`log` **全部在内存里**，进程一死就没了；草稿的 `Checkpoint.workspaceHash` 注释写「接 L17 contentHash」，但 `applyTransition` 从不校验它，续跑时 worker 对着一个可能已变的工作区继续 `edit`。
- **来源**：`[P]` Agent SDK 文档；`[L]` `shared/coding.ts` `Workspace`；`[L]` `shared/ops.ts` `Checkpoint`。
- **后果**：`resumeCheck(checkpoint, currentWorkspaceHash)`：不一致 → 拒绝静默续跑，转 `ask`（或回滚到快照）。这也是 L19「消费 coding」的主要接口。lab 钩子：RES-1。

#### INV-8　「取消 = 把状态改成 cancelled」→ worker 还在跑，副作用还在发生
- **实际**：草稿 `cancel` 直接把状态置 `cancelled`（`[O]` P-g）。心跳随后被拒——这恰好是个「信号」，但在 worker 注意到之前，一个已经发出的 `git push` 不会因为状态字段变化而撤回。需要 `cancelling` 中间态：先请求取消，worker 在安全点确认后才进入终态；超过期限强制终止并标注「副作用未知」。
- **来源**：`[P]` Vercel AI SDK resumable streams：stop 是**独立端点**，不是断线；`[L]` L16 `StopPolicy`；`[O]` P-g。
- **后果**：`cancel_requested → cancelling → cancelled`；`cancelled` 的作业仍要列出「取消时刻在途的副作用」。lab 钩子：JOB-13。

#### INV-9　「waiting_approval 不占资源」→ 草稿里它一直占着 worker 与租约
- **实际**：草稿允许 `waiting_approval` 状态心跳续租，也计入 `running`；平台侧有硬时长上限（GitHub Copilot cloud agent 会话 59 分钟，Cloud Run 请求超时最大 3600 s），审批等人可能是小时级。更糟：`requeue_stale` 允许从 `waiting_approval` 回 `queued`，**待审批的那一项会丢失**。
- **来源**：`[P]` GitHub Copilot cloud agent 文档（59 min）；`[P]` Cloud Run request timeout 文档；`[L]` `shared/ops.ts`。
- **后果**：等待审批 = **停靠（park）**：写 checkpoint、释放租约、不计入 `running`；批准事件把作业重新入队。lab 钩子：APPR-4。

#### INV-10　「滚动发布就是平滑的」→ 默认只有 30 秒把一个分钟~小时级的作业收拾好
- **实际**：K8s 终止 Pod 时先 SIGTERM，`terminationGracePeriodSeconds` 默认 30 s，之后 SIGKILL。agent 作业几乎不可能在 30 s 内跑完，所以**优雅关闭的含义是「在 30 s 内落一个 checkpoint 并释放租约」**，而不是「等任务完成」。Celery 有 soft shutdown 的概念（停止拉新任务、等在途任务到期）。
- **来源**：`[P]` Kubernetes Pod lifecycle 文档；`[P]` Celery worker shutdown 文档。
- **后果**：草稿 `drain` 只拒新任务；缺一个「收到 SIGTERM → 对所有在途作业发 `requeue_with_checkpoint`」的语义。lab 钩子：DEP-2/3 + RES-2。

#### INV-11　「队列要上 Redis/Kafka/专用服务」→ 单机文件日志与 Postgres `SKIP LOCKED` 是明确的两个档位
- **实际**：L17 `fileStore` 是 JSONL `O_APPEND`，**单主机**；多 worker 需要真正的互斥认领。Postgres 官方文档明确 `SELECT … FOR UPDATE SKIP LOCKED` 适用于「队列式表」（并说明它给出的是**不一致视图**，不适合通用查询）。
- **来源**：`[P]` PostgreSQL SELECT 文档（The Locking Clause）；`[L]` `shared/store.ts`。
- **后果**：课程要把这两个档位**说出来**：单机（文件 + 单 worker）能演示 99% 的状态机；多机需要外部原子 `claim`（`UPDATE … WHERE status='queued' … RETURNING` / `SKIP LOCKED`）。lab 不实现数据库，只把 `claim` 写成纯转移，并在文档里标明「原子性由存储层负责」。

---

### B. 幂等与重试

#### INV-12　「幂等 key = 请求内容哈希」→ 对合法的重复调用会误判为重放
- **实际**：AWS Builders' Library 的做法是**调用方提供的请求标识**，并强调「语义等价的重放返回同样结果」。L17 `idemKey = sha256(sessionId\0tool\0stableStringify(input)).slice(0,16)` 里没有 step/call id，所以同一会话里**合法地**把同一个文件 `edit` 两次同一内容（第二次本该是 no-op 或失败）会拿到同一个 key。作业级需要意图 ID（用户点一次「运行」生成一个）。
- **来源**：`[P]` AWS Builders' Library *Making retries safe with idempotent APIs*；`[L]` `shared/store.ts`。
- **后果**：三层 key：`jobKey`（客户端生成，作业级）、`callId`（模型给的 tool_use id，调用级）、`effectKey = H(jobId, callId)`（外部副作用级）。lab 钩子：IDEM-6、RES-2。

#### INV-13　「同 key 重放只对成功有效」→ Stripe 连 500 也存了
- **实际**：Stripe 的语义：同一 key 的**首次**请求结果（含 500）被保存并原样重放；**验证失败**（请求没真正开始执行）和**并发冲突**不会保存。想「重试一次失败的请求」必须换新 key。
- **来源**：`[P]` Stripe API 文档（Idempotent requests）。
- **后果**：作业状态机里 `failed` 的 `startJob` 重放应该返回**那次失败**，并明确提示「要重试请用新 key」；而不是静默重新执行。草稿 `startJob` 对终态一律 `replay`（含 `failed`），方向正确，但没有给出这条提示。lab 钩子：START-3（保留）。

#### INV-14　「同 key 不同载荷也复用结果」→ 应当报错，不应重放
- **实际**：Stripe 对「同 key 不同参数」返回错误；AWS 的表述是语义等价才重放。草稿 `checkIdempotency` 有 `payloadHash` 并返回 `conflict`，但**`startJob` 完全不读载荷**：同一个 `idempotencyKey` 配不同 prompt 会拿到上一个 prompt 的作业（`[L]`：`StartJobInput` 无 `payloadHash` 字段）。
- **来源**：`[P]` Stripe；`[P]` AWS；`[L]` `shared/ops.ts`。
- **后果**：`startJob` 并入 `checkIdempotency` 的 `payloadHash` 比较。lab 钩子：IDEM-7。

#### INV-15　「key 全局唯一就行」→ 必须按租户命名空间，否则 A 的作业泄露给 B
- **实际**：Stripe 的幂等键作用于**账号**范围。草稿 `startJob` 比较 `priorJob.idempotencyKey === input.idempotencyKey` 后直接返回整个 `Job`，**不检查 `priorJob.userId === usage.userId`**；`[O]` P-c：`bob` 用 `alice` 用过的 key，拿到了 `alice` 的整份作业（含 `costUsd`、`tokens`、`checkpoint`）。
- **来源**：`[P]` Stripe；`[O]` P-c。
- **后果**：存储键 = `(tenantId, key)`；跨租户相同字符串互不可见，也不泄露「这个 key 已存在」。lab 钩子：IDEM-6。

#### INV-16　「key 永久有效」→ 有 TTL，TTL 与作业保留期决定双花窗口
- **实际**：Stripe 至少保留 24 小时后可裁剪；IETF 草案 `Idempotency-Key` 头把过期时间作为服务端策略（该草案已过期，**不是标准**）。TTL 之后同 key 会被当作新请求：如果客户端的重试窗口（含移动端离线重试）长于 TTL，就是双花。
- **来源**：`[P]` Stripe；`[S]` IETF draft-ietf-httpapi-idempotency-key-header（过期草案，仅作术语参考，见 §8 M-3）。
- **后果**：TTL ≥ 客户端最长重试窗口，并**写进响应头**让客户端知道。lab 钩子：IDEM-8（注入时钟）。

#### INV-17　「幂等 = 不会双花」→ 先发副作用、后记结果之间崩溃，状态是「未知」
- **实际**：L17 `store.ts` 的两事件模型（`intent` 先写、`outcome` 后写）精确刻画了这点：只有 `intent` 没有 `outcome` = **副作用可能已发生**。`planResume` 按 `Replayability`（`pure | idempotent | once`）把它分成 `skip / redo / ask`：纯函数重做、幂等重做、**once 类（git push、开 PR、发消息）必须问人**。
- **来源**：`[L]` `shared/store.ts`（`Event`、`reduce`、`Replayability`、`planResume`）。
- **后果**：L19 不重造这套，而是**消费**它：作业级续跑 = `planResume` 的结果映射到作业状态（`redo` → 重新入队；`ask` → `waiting_approval`）。lab 钩子：RES-2。

#### INV-18　「重试越多越稳」→ 重试放大是乘法的
- **实际**：Google SRE：每个请求最多 3 次尝试；**重试预算**——客户端的重试数不得超过其请求数的 10%；调用链每一层都重试 3 次，下游收到 3ⁿ 倍请求。对 agent：模型 API 重试 × 工具重试 × 作业级重试 × 用户点「重试」。
- **来源**：`[P]` Google SRE book *Handling Overload*。
- **后果**：重试决策要有**预算**（作业级与租户级各一份），不是只有 `attempt < maxAttempts`。草稿 `shouldRetryEffect` 只有后者。lab 钩子：RETRY-8。

#### INV-19　「429 就等一会儿重试」→ Anthropic 的「花费上限 429」没有 `retry-after`，等多久都没用
- **实际**：Anthropic 文档区分速率限制（429，带 `retry-after`）与花费上限（429，**不带** `retry-after`，要等额度重置或提额）。L15 `OverLimitKind = rate | spend_limit | self_imposed` 就是为此而设。草稿 `classifyError('429') → transient`（`[O]` P-l），会对月度上限做无限指数退避。`shared/resilience.ts` 的 `withRetry` 同样把 429 放进 `RETRIABLE_STATUS`（`[408,409,429,500,502,503,504,529]`）且**忽略 `Retry-After`**、用 `Math.random` 抖动（`[L]`）。
- **来源**：`[P]` Anthropic Rate limits / API errors 文档；`[L]` `shared/budget.ts`、`shared/resilience.ts`；`[O]`。
- **后果**：`retryDecision` 吃 L15 的 `OverLimitKind`：`spend_limit` → **不重试**，作业转 `waiting_budget`/`failed(reason)`；`rate` → 重试且延迟 ≥ `retry-after`；抖动用注入的 `Lcg`（L15 `backoffMs`）。lab 钩子：RETRY-6/7。

#### INV-20　「5xx 都是瞬时的」→ 草稿里 500/502/503 全是 `unknown`，409 是 `unknown`，`CONFLICT` 是 permanent
- **实际**：`[O]` P-l：`classifyError('500')`、`('502')` 都返回 `unknown`，`('409')` 也是 `unknown`，而 `('CONFLICT')` 是 `permanent`——同一个概念两种表示给出两种结论；`unknown + unsafe_write` 又是「禁止重试」，所以 502 的不安全写会被永远拒绝重试。Anthropic 文档把 **529（overloaded）**与 **504** 列为需要重试/改流式的错误。
- **来源**：`[P]` Anthropic API errors；`[O]` P-l；`[L]` `shared/resilience.ts`。
- **后果**：错误码先**归一化**成枚举（`rate | spend | overloaded | server | timeout | conflict | invalid | auth`），再分类；草稿用字符串 `'TIMEOUT'/'429'` 混用是 bug 源。lab 钩子：RETRY-9（可选）。

#### INV-21　「200 之后就不会失败」→ 流式响应可以在中途失败
- **实际**：Anthropic 流式接口在 HTTP 200 返回后，仍可能在流中发 `error` 事件（如 `overloaded_error`）。此时已经收到的部分 assistant 内容**不能提交**成一条完整消息。
- **来源**：`[P]` Anthropic Streaming / API errors 文档。
- **后果**：重试粒度是**一次模型调用**，部分响应要丢弃（或标记 `partial`）；已经执行过的工具调用结果要留在事件日志里。这与 L16 的 `StopPolicy` 与 L17 `Workspace.log` 衔接。属于 live 才能完整验证的部分（runner）。

#### INV-22　「重试用 `Math.random` 抖动就行」→ 零模型断言要求注入时钟与随机源
- **实际**：L15 `backoffMs(attempt, rng, base, cap)` 已采用注入 `Lcg` + 全抖动；`resilience.ts withRetry` 用 `Math.random`（`[L]`）。L19 `verify` 要断言「第 n 次的延迟 ≥ `retry-after`」「预算耗尽后不再重试」，只能注入。
- **来源**：`[L]` `shared/budget.ts`、`shared/resilience.ts`。
- **后果**：`retryDecision(...)` 为纯函数，返回 `{retry, delayMs, reason}`；调用方负责 `sleep`。lab 钩子：RETRY-7。

---

### C. 多租户配额与公平调度

#### INV-23　「每用户限流 = 公平」→ AWS 的做法是**每租户令牌桶**，并强调单一用户不应拖垮他人
- **实际**：AWS Builders' Library *Fairness in multi-tenant systems*：按租户配额，系统总容量大于单租户配额之和并非必要，但**配额必须与容量的现实挂钩**（超卖是显式决策）。L15 `Limiter` 是单进程的毫注令牌桶（`take(nowMs)`）。
- **来源**：`[P]` AWS Builders' Library；`[L]` `shared/budget.ts`。
- **后果**：`Limiter` 可复用但要**按 `tenantId` 分片**；单进程限制在多 worker 下失效（见 INV-31）。

#### INV-24　「先估算成本再放行」→ 成本事后才知道，AWS 的建议是**事后扣账**
- **实际**：AWS 对「成本事先未知」的请求（本质上就是 agent 的一次作业）建议**先放行、完成后扣账、允许余额为负**，下一次请求据此被拒。草稿 `admitJob` 只做事前估算比较，没有 `settle`（结算）与 `reserve/release`（预留/释放）。
- **来源**：`[P]` AWS Builders' Library；`[L]` `shared/ops.ts`。
- **后果**：`admit`（带估算）→ 运行中累计 → `settle(actual)`；预算为负时**下一次**入队被拒。lab 钩子：QUOTA-6/7。

#### INV-25　「用浮点美元做配额就行」→ `0.1 + 0.2 > 0.3` 会拒绝刚好达到上限的作业
- **实际**：`[O]` P-b：`costUsdToday=0.1`、估算 `0.2`、`dailyCostUsd=0.3` → `admitJob` 返回 `dailyCost 超限`（`0.1+0.2 = 0.30000000000000004`）。L15 已经用 `Picofen`（整数）做账来避免这个，草稿又倒退回 `number` 美元。TS 与 Python 都是 IEEE-754，结论一致，所以**不是字节差异、是语义错误**。
- **来源**：`[L]` `shared/budget.ts`（`Picofen`/`charge`）；`[O]`。
- **后果**：`UserUsage.costPico: bigint`/Python `int`；口径统一用整数。lab 钩子：QUOTA-5。

#### INV-26　「FIFO 就公平」→ 先到先得下，一个大客户能占满全部 worker
- **实际**：`[O]` EXP-B2：whale（100 个 600 s 作业）先提交，4 个 worker，FIFO → t<1000 s 内 whale 占 100% 的 worker 秒数。
- **来源**：`[O]`；公平队列综述 `[P]` Sheng 等 *Fairness in Serving Large Language Models*（VTC，OSDI '24）。
- **后果**：见 INV-27。

#### INV-27　「按用户轮转（lastServed）就公平」→ 它是「条数公平」，不是「成本公平」
- **实际**：`[O]` EXP-B/B2：whale 的作业是 600 s、minnow 的是 10 s，**按条数轮转（草稿 `fairNext` 的思路）**：minnow 在前 1000 s 只拿到 2.0% 的 worker 秒数，100 个小作业全部做完要 14 670 s；**按已付成本轮转**（VTC 的虚拟 token 计数器的作业级类比）：minnow 占 25%（离散作业的粒度误差，见方法说明），全部做完 400 s。VTC 论文的核心正是「按实际 token 成本记账的虚拟计数器」。
- **来源**：`[P]` VTC 论文（OSDI '24）；`[O]`。
- **后果**：`fairNext(queued, served: Record<string, Pico>)`：`served` 是**累计已付成本**，不是时间戳。lab 钩子：FAIR-4。

#### INV-28　「入队时检查了配额，就不会超」→ `fairNext` 完全不看并发上限
- **实际**：`[O]` P-a：`whale` 已有 1 个运行、`maxConcurrentPerUser=1`，`lastServed` 更旧 → `fairNext` 仍选 `whale` 的作业。配额只在入队检查，**认领时不复核**。另外「检查-然后-入队」两步非原子：两个并发请求都能通过 `admit`（TOCTOU，`[L]` 推理，实现取决于存储层）。
- **来源**：`[O]` P-a；`[L]` `shared/ops.ts`。
- **后果**：`fairNext` 接受 `running: Record<user,count>` 与 `policy`，跳过已达并发上限的用户；`admit` 在存储层用条件写（`INSERT … WHERE count < limit`）。lab 钩子：QUOTA-7、FAIR-3。

#### INV-29　「noisy neighbor 靠扩容」→ Anthropic 自己用周限额处理「24/7 跑」的少数用户
- **实际**：Anthropic 宣布周限额的理由之一：极少数用户 24/7 持续运行 Claude Code，占用不成比例的容量。这是产品层的「公平」，而不是扩容。
- **来源**：`[P]` Anthropic 周限额公告 / Claude Code 用量文档。
- **后果**：配额要有**多个时间尺度**（并发、每小时、每天、每周）；草稿只有「今日」。lab 钩子：QUOTA-8（跨日窗口，注入时钟，UTC 日边界写进注释）。

#### INV-30　「配额 = 拒绝」→ 拒绝也要便宜、要分级、要告诉客户端何时再来
- **实际**：Google SRE 的过载处理：按**关键度**（criticality）丢弃——后台批处理先于交互请求；拒绝要比处理便宜得多，并携带重试提示。后台 agent 作业天然是低关键度。
- **来源**：`[P]` Google SRE book *Handling Overload* / *Addressing Cascading Failures*。
- **后果**：`AdmitVerdict` 的拒绝带 `retryAfterMs`（或 `reason + resetAt`）；交互与后台使用不同配额池（lab 里只放一个 `class: 'interactive' | 'background'` 字段，不实现完整调度）。

#### INV-31　「单进程限流器够用」→ 一旦有第二个 worker，`Limiter`/内存状态就是各算各的
- **实际**：`Limiter`（`[L]` L15）与草稿所有的 `UserUsage` 都是调用者传入的快照；真正的计数需要共享存储。课程应该明说：**零模型 verify 验证的是判定函数，不是分布式一致性**；多机一致性靠存储层的原子条件写。
- **来源**：`[L]`；`[P]` AWS（令牌桶需要共享状态）。
- **后果**：文档里列出「判定函数 vs 存储原语」对照表（§2.3），防止学员以为通过 verify 就等于分布式正确。

---

### D. 部署与监控 coding agent

#### INV-32　「沙箱 = 安全」→ 沙箱只是**减小爆炸半径**，凭据要留在沙箱外
- **实际**：Claude Code on the web：沙箱内执行，git 凭据**不进入沙箱**，由沙箱外的 git 代理代为认证。沙箱把「提示注入成功」的损失限定在容器内——前提是容器里没有值钱的东西。
- **来源**：`[P]` Claude Code 沙箱/ web 文档；`[L]` `shared/guard.ts`（`SandboxSpec`、`pathVerdict`、`egressVerdict`、`sandboxGaps`）。
- **后果**：与 L14 的边界：L14 审**一次动作**，L19 审**部署形态**（凭据在哪、出站开不开）。lab 钩子：用 `sandboxGaps` 的输出做部署前自检（只读 L14，不重写）。

#### INV-33　「把 token 放环境变量给 agent」→ Codex 的做法是 setup 阶段有、agent 阶段没有
- **实际**：Codex cloud 两阶段运行时：setup 阶段可联网装依赖、可使用 secrets；**agent 阶段默认离线，且 secrets 在 agent 阶段开始前被移除**（本轮读到的原文：「Secrets configured for cloud environments are available only during setup and are removed before the agent phase starts」）。Cursor cloud agents 提供运行时 secrets、OIDC 与出站白名单。
- **来源**：`[P]` OpenAI Codex cloud 文档；`[P]` Cursor cloud agents 文档。
- **后果**：部署清单（§6 的 `deployChecklist`）把「secrets 作用域」「出站策略」作为必检项。**凭据要用于推送时**，用 INV-32 的代理模式，而不是给 agent。

#### INV-34　「云端 agent 也要每步审批」→ 云端 agent 通常**没有审批**，防线前移到围栏与 PR 评审
- **实际**：Codex cloud、Cursor cloud agent、Copilot cloud agent 都是「无人值守」：没有逐工具审批，而是依赖沙箱 + 出站限制 + 最终的 PR 评审。Claude Code 在 `-p` 下可用 `--permission-prompts none`，此时一切需要提示的权限**直接拒绝**。
- **来源**：`[P]` 各家文档；`[P]` Claude Code CLI 参考（`--permission-prompts none`：「Pass `none` when nobody can answer, and Claude Code denies them instead」）。
- **后果**：L19 的「审批」有两种运行形态：**有人**（交互，走记忆策略）与**无人**（后台，走 pre-authorize 白名单 + 默认拒绝 + 回写给 agent）。lab 钩子：APPR-1/2。

#### INV-35　「会话可以一直跑」→ 平台有硬时长上限，一个作业会跨越多个会话
- **实际**：Copilot cloud agent 会话 59 分钟；Cloud Run 请求超时最大 3600 s。coding agent 的真实长任务（大型重构、全量测试）会越过这条线。
- **来源**：`[P]` 同 INV-9。
- **后果**：「作业 ≠ 会话 ≠ 容器」三层模型；`Job.attempt`（INV-3）+ `Checkpoint`（INV-7）使得跨会话续跑成为常态路径而不是异常路径。

#### INV-36　「`shared/models.ts` 一加载就要 API key」→ 部署出的服务在冷启动与 verify 里都会被它绑住
- **实际**：`[O]` §0.2：`import('./shared/models.ts')` 在无 `DEEPSEEK_API_KEY` 时直接抛错。`verify` 要「零模型调用」，就必须保证 `ops.ts` 的依赖闭包里没有它——草稿 `ops.ts` 只依赖 `codingEval.ts`（OK）。但一旦 L19 为「消费 coding」把 `coding.ts` / `agent.ts` 拉进来，就可能把 `models.ts` 带进依赖图。
- **来源**：`[O]`；`[L]`。
- **后果**：断言 NUM-2 之外再加一条依赖闭包扫描（`ops.ts` 不得（传递地）import `models.ts` / `agent.ts`）。属于实现细节，放进 TODO 注释即可。

#### INV-37　「TS 在服务器上直接跑」→ strip-types 模式不支持参数属性、`enum`、`namespace`
- **实际**：见 §0.2 的 16/33。草稿 `ops.ts` 在子集内，但没有守卫。
- **来源**：`[O]`；`[P]` Node.js TypeScript 文档（strip-only 模式的语法限制，错误信息 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` 本轮实测）。
- **后果**：NUM-2 同时扫描源码：`ops.ts` 不含 `constructor(public|private|protected`、`enum `、`namespace `、`Date.now`、`Math.random`、`toFixed`。

#### INV-38　「kill switch = 在系统提示里写『收到信号就停』」→ 它必须在模型**之外**
- **实际**：Replit 事件：agent 在「代码冻结」的明确指令下仍然删除了生产数据库；Anthropic 的 auto mode 文章列出「边界在压缩中丢失」——上下文压缩可能把早先的限制性指令压掉。凡是写在 prompt 里的约束，都受压缩、注入与遗忘影响。
- **来源**：`[P2]` Replit 事件的公开报道与公司回应；`[P]` Anthropic auto mode 工程博客（boundary lost to compaction）。
- **后果**：kill switch 是**部署状态**（`DeployState.mode`），由编排层在每次**副作用前**检查，不经过模型。lab 钩子：DEP-4。

#### INV-39　「kill 就是让所有请求失败」→ 草稿里 kill 连 `cancel` 与只读都拒，健康检查还把实例摘掉
- **实际**：`[O]` P-m：kill 状态下 `admitUnderDeploy(..., 'resume')` 被拒；草稿 `kind` 只有 `new_job/resume/effect` 三种，**没有 `cancel` / `read` / `status`**，所以 kill 之后用户既不能取消作业也不能查看状态。再者 `healthCheck` 把 `deploy_mode=kill` 判为 `ok:false`——若该检查被接到 K8s 就绪/存活探针上，kill 会让编排层把所有实例摘出负载均衡甚至重启，**kill 变成了宕机**。
- **来源**：`[L]` `shared/ops.ts`；`[P]` Kubernetes probes 文档（liveness 失败 → 重启；readiness 失败 → 摘流）；`[O]`。
- **后果**：`DeployKind` 增加 `cancel | read`，kill 下允许；健康检查拆 `liveness`（进程活着）与 `readiness`（能接新活），kill 只影响 readiness 中的「新作业」一项。lab 钩子：DEP-7/8。

#### INV-40　「`--max-budget-usd` 是硬上限」→ 文档明说它基于客户端估算、可能超
- **实际**：Claude Code CLI 参考：该开关仅 print 模式；「Claude Code 对照其**客户端成本估算**检查上限，可能与账单不同……开销可能超出上限，请留出余量」；`--max-turns` 超限以错误退出。
- **来源**：`[P]` Claude Code CLI reference（本轮读到原文）。
- **后果**：作业级成本上限要做成**两道**：软上限（告警 + 暂停）与硬上限（kill 该作业），二者之间的差额就是你的「余量」；并且仍以账单/账本事后对账（L15 `charge`）。lab 钩子：QUOTA-6 的 `settle` 允许负余额。

#### INV-41　「监控 = L13 的 trace」→ 上线后要看的是**作业生命周期**与**编码质量**，而不是单次调用
- **实际**：L13 管「一次轨迹里发生了什么」。上线后新增的信号是：队列年龄（最老的 queued 多久了）、租约过期率、重新入队次数、DLQ 深度、幂等重放率、kill 状态、每个租户的消费斜率；以及 L18 交接过来的在线编码指标（Keep Rate 等）。草稿 `healthCheck` 有队列深度/年龄/错误率，是好的起点。
- **来源**：`[L]` L13/L18 内容；`[P]` Google SRE（四个黄金信号）——**本轮未抓取原文**，仅作术语，见 §8 M-4。
- **后果**：边界见 §2。lab 钩子：MET-1（把 TTFT 拆三段）。

#### INV-42　「多个人共享一个 agent = 他们共享权限」→ Cursor 的「团队 follow-up」文档里就列了横向移动风险
- **实际**：云端 agent 的后续指令可以由团队其他成员追加；这使「谁的权限」成了问题：作业应以**发起者**的身份与配额运行，follow-up 者的权限不应叠加。
- **来源**：`[P]` Cursor cloud agents 安全文档（team follow-ups / lateral movement 条目）。
- **后果**：`Job.userId`（发起者）不可被 follow-up 改写；配额与审批记忆按**发起者**记账。lab 钩子：MEM-* 的 key 含 `userId`。

---

### E. SSE / WebSocket 断线续传

#### INV-43　「SSE 断了浏览器会自己续上」→ 只有服务端发过 `id:` 才会带 `Last-Event-ID`，且服务端要保留缓冲
- **实际**：WHATWG EventSource：重连时携带 `Last-Event-ID` 头——前提是之前收到过 `id:` 字段；服务端必须能按此 id 重放。`shared/wire.ts` 的 `SseParser.lastEventId`、`checkResumable`、`buildResumeRequest` 就是对这条规则的实现。
- **来源**：`[P]` WHATWG HTML Living Standard §9.2（EventSource；本轮抓取到 `Last-Event-ID` 头一节）；`[L]` `shared/wire.ts`。
- **后果**：作业事件流每条都带单调 `seq` 作为 `id:`；`eventsAfter(events, lastSeen)` 是唯一的续传原语。

#### INV-44　「断线就是取消」→ L16 说「不要停止生成」，L19 要把它做成后端事实
- **实际**：Vercel AI SDK 的可恢复流：服务端用 `activeStreamId` 追踪进行中的流，客户端刷新后用它续上；**停止是另一个端点**，且客户端 `abort` 会**破坏**续传能力。草稿 `eventsAfter` 之上没有任何东西会在断线时改作业状态——这是对的，但缺一条**断言**：「断线不改变作业状态」。
- **来源**：`[P]` Vercel AI SDK resumable streams 文档；`[L]` `shared/wire.ts`（`StopPolicy`、`abortCause`）。
- **后果**：lab 钩子：CUR-4。

#### INV-45　「重连带上游标就行」→ 云厂商的做法是**服务端游标**（`sequence_number` / `starting_after`）
- **实际**：OpenAI 后台模式（`background: true`）：响应在服务端继续生成，流事件带 `sequence_number`，重连时用 `starting_after` 从指定位置继续。这与 INV-43 同构；区别在于**生成不依赖连接**。
- **来源**：`[P]` OpenAI Responses 后台模式文档。
- **后果**：作业事件日志是**事实**，连接只是它的一个读者。读者数量 0..N 都合法。

#### INV-46　「长连接不会被中间件掐」→ 反向代理有硬超时
- **实际**：Cloudflare 在源站 125 s 无响应时返回 524（本轮记录值；官方文档措辞与默认值请发布前复核，M-1）；Cloud Run 同样有请求超时。长时间无事件的 SSE 必须发心跳（SSE 注释行 `:`）。
- **来源**：`[P]` Cloudflare 524 文档；`[P]` Cloud Run 文档。
- **后果**：服务端每 N 秒发注释心跳（N 小于最短的代理超时）；lab 里把 N 作为配置项并断言「没有事件的空窗不超过 N」（属于 live runner，不进零模型断言）。

#### INV-47　「重放缓冲想留多久留多久」→ 游标越界必须是**错误**，不是空数组
- **实际**：`[O]` P-h：`eventsAfter(events(seq 1..3), 99)` 返回 `[]`——客户端游标超过日志末尾（来自另一个作业/旧 epoch/被篡改）时被静默当作「已追平」。反方向同样：如果日志被裁剪（INV-5）使得 `lastSeen+1` 之前的事件已丢失，返回「剩下的事件」会造成**静默空洞**。Vercel 的可恢复流依赖 Redis，过期后无法续传。
- **来源**：`[O]` P-h；`[P]` Vercel AI SDK；`[L]` `shared/ops.ts`。
- **后果**：`resumeCursor(events, lastSeen, floor)` 返回 `{ok:true, events}` 或 `{ok:false, reason:'ahead'|'expired'}`，后者让客户端回退到「全量快照」。lab 钩子：CUR-1/2。

#### INV-48　「WebSocket 有恢复机制」→ Socket.IO 的连接状态恢复有明确限制，且不保证成功
- **实际**：Socket.IO 的 connection state recovery 需要显式开启，受限于服务端保留时长，恢复**不总是成功**，文档要求应用层有兜底的全量同步。
- **来源**：`[P]` Socket.IO 文档（Connection state recovery）。
- **后果**：协议层「续传」永远要配应用层「快照」。草稿的 `Checkpoint` 与 `eventsAfter` 共同构成这个兜底，但**需要承认它们是两个游标空间**（INV-49）。

#### INV-49　「`Checkpoint.seq` 就是客户端游标」→ 草稿把两个序号空间混成一个
- **实际**：草稿注释写「客户端用它做 resume cursor」，但 `Checkpoint.seq` 是**作业级**（每次落 checkpoint 递增），而流事件（token delta、tool_call 开始/结束）远比 checkpoint 密。客户端游标必须是**流事件序号**，checkpoint 序号只在 worker 恢复时用。
- **来源**：`[L]` `shared/ops.ts`。
- **后果**：`Job.eventSeq`（流）与 `Checkpoint.seq`（恢复点）分开；checkpoint 记录 `eventSeqAt`，用于「从这个 checkpoint 恢复后，哪些事件需要被补发/丢弃」。lab 钩子：CUR-3（去重）。

---

### F. 审批记忆 · 后台 UI · TTFT

#### INV-50　「记住 = 一个布尔」→ Claude Code 的持久化范围是**按工具**定的
- **实际**：Claude Code 权限文档：Bash 命令的「是，不再询问」按**项目目录 + 命令**永久记住；文件编辑的批准**仅到会话结束**；WebFetch 按**域名**。三种不同的 scope × 三种不同的寿命。
- **来源**：`[P]` Claude Code permissions 文档。
- **后果**：`ApprovalMemory` 要有 `(tool, scopeKind, mode)`，其中 `mode ∈ once | session | ttl | permanent`；草稿只有前三种、scope 为任意字符串。lab 钩子：MEM-*。

#### INV-51　「scope 前缀匹配就行」/「精确匹配最安全」→ 两个都是错的，正确是**路径段边界**
- **实际**：草稿注释「scope 必须精确匹配，避免 `/repo` 放行 `/repo-evil`」，结果 `[O]` P-i：记住 `/repo` 之后，`/repo/a.ts`（它的子文件）与 `/repo/`（尾斜杠）都**不命中**——「记住这个目录」对文件级调用**完全没用**，审批疲劳回来。正确语义：按**路径段**比较（`/repo` 命中 `/repo/…`，不命中 `/repo-evil`），并先 `resolve` 规范化——这正是 L17 `resolveInWorkspace`（不用 `startsWith`）要解决的问题。
- **来源**：`[O]` P-i；`[L]` `shared/coding.ts`（`resolveInWorkspace`）；`[P]` Claude Code permissions 文档（规则按 repo+命令的粒度）。
- **后果**：`scopeCovers(granted, requested)` 纯函数，TS/Python 必须一致（只用 `/` 分段、`..` 先规整、不依赖 `localeCompare`）。lab 钩子：MEM-7（并把 MEM-2 从「精确」改为「段边界」）。

#### INV-52　「`npm test` 已允许，所以 `npm test && curl …` 也行」→ 复合命令必须拆开，包装器要剥掉
- **实际**：Claude Code 权限文档：对 Bash 规则，复合命令按 `&&`、`||`、`;`、管道拆分，**每一段**都要匹配；`timeout`、`nice` 等包装器在匹配前被剥掉。否则记住的规则会被「搭便车」。
- **来源**：`[P]` Claude Code permissions 文档（compound commands / wrapper stripping）。
- **后果**：记忆键不是原始命令字符串，而是**规范化后的命令段集合**。零模型可测，且纯字符串处理（不需要 shell）。lab 钩子：MEM-9。

#### INV-53　「deny 记忆和 allow 对称」→ 官方是 deny → ask → allow 优先级，草稿里 deny 记忆根本召回不到
- **实际**：Claude Code 权限评估顺序 deny → ask → allow，deny 优先。草稿 `recallApproval` 对 `!m.allowed` 的条目直接 `continue`，`rememberApproval` 又会用新条目覆盖同 `(user,tool,scope)` 的旧条目（`[O]` P-i2：记住 deny 之后，`recallApproval` 返回 `null`），所以「永不允许 X」这种用户意图**既存不下来也不生效**。
- **来源**：`[P]` Claude Code permissions 文档；`[O]` P-i2；`[L]`。
- **后果**：`recallApproval` 返回 `'deny' | 'allow' | null`，先查 deny。lab 钩子：MEM-8。

#### INV-54　「审批通过率高，说明流程健康」→ 恰恰是疲劳的信号；自动化分类器也有 17% 漏报
- **实际**：Anthropic：Claude Code 用户批准了 **93%** 的权限提示（auto mode 文章）；沙箱文章给出 **97%**，并指出对**计划**的拒绝率 39%、对**单个权限请求**仅 3%。auto mode 分类器在真实「过度主动」动作上的漏报率 **17%**（“the honest number”）；文章还指出人工拦截率随会话变长而下降。
- **来源**：`[P]` Anthropic *Claude Code auto mode*（93%、17% FNR、3 连续/20 总拒绝升级）；`[P]` Anthropic 沙箱工程博客（97%、39% vs 3%）。两个数字来自两篇不同文章、口径不同，**引用时必须带出处**（M-5）。
- **后果**：「每次都问」不是安全方案；L19 的 UX 兑付：**按风险类别问（L14 `classifyRisk`），不是按工具问**；高风险（`HIGH_RISK`）永不记住（`once` 或必须问），低风险允许 `session`，中风险允许 `ttl`。

#### INV-55　「被拒绝了 agent 就该停」→ 官方设计是把拒绝回给 agent，累计 3 连续 / 20 总次才升级；无人值守时终止
- **实际**：auto mode：分类器拒绝后，拒绝作为 **tool result** 返回给模型，并附「善意地换一条更安全的路，不要绕开边界」；会话累计 **3 次连续或 20 次总拒绝** → 停下模型并升级给人；**headless（`claude -p`）没有界面可问 → 终止进程**。草稿 `deny` 把整个作业置 `cancelled`（`[O]` P-d）——丢掉了「回给 agent 换路」这一档，也没有计数/升级。
- **来源**：`[P]` Anthropic auto mode 文章；`[P]` Claude Code auto mode 文档（3/20 阈值不可配置；任一允许动作重置连续计数，总计数仅在触发降级时重置）；`[O]` P-d。
- **后果**：作业状态机里 `deny` 不是终态转移，而是「回写 tool result，作业继续」；`DenialCounter` 达阈值 → `waiting_human`（交互）或 `failed(reason:'denied_too_often')`（后台）。lab 钩子：APPR-2/3。

---

## 2. 边界：L19 与相邻课程

### 2.1 与 L13（可观测性）· L14（守卫）· L15（预算）· L16（前端）· L17（编码 agent）· L18（评测）

| 关注点 | 归属课 | L19 **不**做 | L19 **做** |
|---|---|---|---|
| 一次轨迹的 span/trace、cassette 回放、`loopStats` | L13 | 不新增 tracing 框架 | 把作业生命周期事件（claim、heartbeat、requeue）作为**同一套** Recorder 的新事件类型消费 |
| 单次动作的风险分级、`Gate.decide` fail-closed、沙箱规格 `SandboxSpec` | L14 | 不重写 `classifyRisk`/`Gate` | 用 `classifyRisk` 决定**记不记得住**（INV-54）；用 `sandboxGaps` 做部署前自检（INV-32） |
| 令牌桶 `Limiter`、`OverLimitKind`、`backoffMs`、`Picofen` | L15 | 不重写限流/退避/记账 | **按租户分片**使用；`retryDecision` 吃 `OverLimitKind`（INV-19）；配额用 `Picofen`（INV-25） |
| `canExecute` vs 展示、`StopPolicy`、SSE 解析 | L16 | 不重做前端 | 兑付欠条：断线≠取消（INV-44）、后台 agent 的状态词表（§3.2） |
| `Workspace`、`contentHash`、`store.ts` 事件/`planResume` | L17 | 不改 `Workspace` 的接口 | 消费：`resumeCheck(workspaceHash)`（INV-7）、`planResume` 映射（INV-17） |
| 评测、门禁语义（非劣/优效）、nightly 出口码 | L18 | **不做**在线 A/B、流量切分、告警策略的统计设计（L18 明确不做，L19 也不应偷做统计学） | 消费 `codingGate`/`Attempt` 作为**发布闸**的输入；出口码 `0/1/2` 映射到编排动作（§0.1） |

### 2.2 与 L20 · L21（不得抢戏）

| 课 | 范围 | L19 的红线 |
|---|---|---|
| L20 | **纯文字**的面试题；无 lab | L19 不出「面试怎么讲上线」的内容；讲稿里不写「如果面试官问……」 |
| L21 | 知识图谱 lab | L19 不引入图谱/记忆检索；`Job` 里不放 entity/relationship |

### 2.3 判定函数 vs 存储原语（防止学员误解 verify 的覆盖面）

| 能力 | verify 测的（纯函数） | 实际由谁保证（存储层/平台） |
|---|---|---|
| 认领互斥 | `applyTransition(claim)` 的合法转移 | `UPDATE … WHERE status='queued'` / `SKIP LOCKED` 的原子性 |
| 配额 | `admit(usage, policy, …)` | `INSERT … WHERE count < limit` 的条件写；多 worker 共享计数 |
| 幂等 | `checkIdempotency(req, prior)` | 以 `(tenant, key)` 为主键的唯一约束 + TTL 清理 |
| 租约 | 注入时钟下的 `leaseUntil` 比较 | 存储层单调时钟/或同一时间源（避免时钟漂移） |
| 围栏 | `epoch` 比较 | 存储层条件写 `WHERE epoch = :epoch` |
| 续传 | `resumeCursor` | 事件日志的实际保留策略 |

---

## 3. 兑付欠条

### 3.1 审批 UX 粒度（L16 → L17 → L19）

**问什么 / 多频繁 / 怎么记住**，给出一个可以在零模型下断言的表（兑付 INV-50…55）：

| 风险类别（L14 `classifyRisk`） | 问不问 | 记不记 | 记多久 | scope 形态 |
|---|---|---|---|---|
| 只读（读文件、grep） | 不问 | — | — | — |
| 工作区内编辑 | 首次问 | 可记 | `session` | 路径段边界（INV-51） |
| 工作区内跑命令（测试/构建） | 首次问 | 可记 | `ttl`（默认 1 h，可配） | 规范化命令段集合（INV-52），**不是**命令前缀 |
| 联网（`WebFetch` 类） | 首次问 | 可记 | `session` | 域名（精确，不含子域，除非显式） |
| 高风险（`HIGH_RISK`：删除、`git push`、改 CI、写 secrets 路径） | **每次问** | 不记（或仅 `once`） | `once` | 具体参数 |
| 无人值守 | 不问 | 预授权白名单 | 作业生命周期 | 启动前由用户一次性授予，默认拒绝一切其它（INV-34） |

**欠条的兑付证据**：MEM-1…9、APPR-1…4 九条/四条断言；`runner.ts` 里的真人交互部分不做（没有人）。

### 3.2 后台 agent UI（L16 欠条）

L16 的 UI 假设有人盯着流。L19 之后，UI 需要的最小状态词表**就是作业状态机的投影**：

| UI 状态 | 作业状态 | 用户能做什么 |
|---|---|---|
| 排队中（第 N 位 / 预计） | `queued` | 取消 |
| 运行中 | `running` | 取消、查看实时流 |
| 等你确认 | `waiting_approval`（停靠，INV-9） | 批准 / 拒绝（拒绝回写给 agent，INV-55） |
| 正在取消 | `cancelling`（INV-8） | 等待 |
| 已完成 | `succeeded` | 查看 diff / 打开 PR |
| 失败 / 超时 / 死信 | `failed` / `timed_out` / `dead` | 以**新 key** 重试（INV-13） |

「你不在时发生了什么」摘要 = 从 `eventsAfter(lastSeen)` 里按事件类型折叠（工具调用数、改动文件数、拒绝次数），**不是**重放整段流。零模型断言放在 `eventsAfter` + `resumeCursor`，不断言像素。

### 3.3 TTFT 基线（L16 → L17 欠条）

用户感知的「首字节时间」在后台作业里是三段之和：`queue_wait`（`claim.now − createdAt`）、`start_latency`（认领到容器/工作区就绪）、`model_ttft`（首个模型 token）。**L19 的 verify 只断言前两段可以从注入时钟下的事件推导；`model_ttft` 的数值必须 live 才有**（runner 里测，不入零模型断言）。OpenTelemetry GenAI 语义约定里对应的指标名**本轮没能抓取成功**（页面迁移），**不得在讲稿里写死指标名**（M-6）。lab 钩子：MET-1。

---

## 4. 对现有草稿（`labs/shared/ops.ts`、`labs/l19/ops.ts`、`labs/l19/verify.ts`）的审计

> 状态（快照）：`OPS_IMPL=shared node l19/verify.ts` 与 `OPS_IMPL=shared python3 -m l19.verify` 均通过；`l19/ops.ts` 有 5 个观察实验 + 6 个 TODO（均 `throw new Error('TODO n 未实现')`）；没有 `runner`；`verify.ts` 41 条断言。**以下缺陷均对应上面的 INV，`[O]` 标注者有 §7 的探针数字。**

| # | 缺陷 | 证据 | 对应 INV | 严重度 |
|---|---|---|---|---|
| D-1 | `startJob` 跨租户重放：不比 `userId`，把别人的整份作业返回 | `[O]` P-c | 15 | **高（泄露）** |
| D-2 | `startJob` 不比 `payloadHash`：同 key 不同 prompt 返回旧作业 | `[L]` | 14 | 高 |
| D-3 | `heartbeat/checkpoint/succeed` 不检查租约过期 | `[O]` P-k | 2 | 高 |
| D-4 | 无 attempt/epoch：僵尸（同 `workerId`）写入被接受；毒丸无限循环 | `[O]` P-e/P-f | 3, 4 | 高 |
| D-5 | `cancel` 直达终态，无 `cancelling` | `[O]` P-g | 8 | 中 |
| D-6 | `deny` 把整个作业置 `cancelled`，无计数/升级 | `[O]` P-d | 55 | 高（语义写反） |
| D-7 | `waiting_approval` 允许心跳、`requeue_stale` 会丢待审批项；无审批截止 | `[L]` | 9 | 中 |
| D-8 | `fairNext` 不看并发上限、按条数而非成本轮转、无老化 | `[O]` P-a、EXP-B/B2 | 26–28 | 高 |
| D-9 | 配额用浮点美元；`0.1+0.2>0.3` 拒绝刚好到上限的作业 | `[O]` P-b | 25 | 中 |
| D-10 | `admitJob` 只有事前估算，无 `settle`/预留/释放 | `[L]` | 24 | 中 |
| D-11 | `classifyError`：`429→transient`（违反 L15）、`500/502/409→unknown`、`CONFLICT→permanent` | `[O]` P-l | 19, 20 | 高 |
| D-12 | `recallApproval`：精确 scope 使目录级记住失效；deny 记忆召回不到 | `[O]` P-i/P-i2 | 51, 53 | 高 |
| D-13 | `eventsAfter` 游标越界返回 `[]`；`Checkpoint.seq` 与流事件序号混用 | `[O]` P-h、`[L]` | 47, 49 | 中 |
| D-14 | kill 拒绝一切（无 `cancel`/`read`）；`healthCheck` 把 kill 当 `ok:false` | `[O]` P-m、`[L]` | 39 | 中 |
| D-15 | `healthCheck.detail` 用 `errorRate.toFixed(3)`；Python 用 `f"{x:.3f}"`——**TS 与 Python 不一致** | `[O]` P-j：`0.0625` → TS `"0.063"`、Python `"0.062"`；verify 未覆盖这个字符串 | 22（数值规约） | **高（违反 byte-identical）** |
| D-16 | 声称「消费 coding / codingEval」，实际只 import 了 `cmpCodePoint`；`Checkpoint.workspaceHash` 从不校验；无 runner | `[L]` | 7, 17 | 中（需求不满足） |
| D-17 | 41 条断言覆盖面窄：无断言守 TS/Python 一致性、无断言守源码纯度（`Date.now`、`toFixed`） | `[L]` | 37 | 中 |

**可以原样保留的：** `applyTransition` 的基本骨架（枚举转移 + `ok:false` 不改状态）、`checkIdempotency` 的 `execute/replay/conflict/reject` 四态、`admitUnderDeploy` 的 `open/drain/kill` 三态、`cmpCodePoint` 排序（避免 `localeCompare`）、`healthCheck` 的结构。

---

## 5. 观察实验（零模型）

> 全部为纯函数 + 注入时钟/随机源；输出固定宽度、无 `toFixed`；TS 与 Python 逐字节一致。

| # | 实验 | 观察目标 | 结果（`[O]`，§7） |
|---|---|---|---|
| EXP-1 | **断线之后从哪续**：认领 → 两次 checkpoint → 租约过期 → 重新入队 → 另一 worker 认领；客户端 `lastSeen=1` 续传 | checkpoint 被保留；事件只补 `seq>1` | 保留（草稿已有）；新增：游标越界给 `ahead` 错误（P-h） |
| EXP-2 | **可见性超时 vs 任务时长**：任务 10–120 s，vt ∈ {30,60,120,900} | 重复执行率 | 81.1% / 54.2% / 0% / 0% |
| EXP-3 | **僵尸与毒丸**：同名 worker 重新认领后旧进程写入；1000 次 claim/requeue | 围栏、attempt 上限 | 旧进程写入 `ok=true`；1000 次后仍 `queued` |
| EXP-4 | **幂等三表**：同 key 重试 / 同 key 不同载荷 / 无 key 的不安全写 / 跨租户同 key | verdict 表 | 草稿三项正确，跨租户泄露整个作业 |
| EXP-5 | **公平三策略**：FIFO / 按条数轮转 / 按成本轮转 | 前 1000 s 的 worker 秒数份额、minnow 完工时间 | 100/0 · 98/2 · 75/25（%）；完工 15 250 / 14 670 / 400 s |
| EXP-6 | **审批记忆作用域**：`/repo`、`/repo/a.ts`、`/repo/`、`/repo-evil`、复合命令、deny 优先 | 命中表 | 草稿：`/repo/a.ts` 与 `/repo/` 都不命中；deny 召回 null |
| EXP-7 | **kill / drain / 健康**：每种 `DeployKind` × `DeployMode`；liveness vs readiness | 允许矩阵 | 草稿：kill 拒 `resume`；无 `cancel` 种类 |

观察实验的**输出格式**沿用草稿（`pad` + 固定列宽）；每个实验结束后给一行 `dim()` 提示「这张表对应哪种上线后才爆的失败」。

---

## 6. Lab 设计

### 6.1 文件与依赖

```
labs/shared/ops.ts / ops.py       # 单文件继续（≤ 900 行再拆）；纯函数，无 I/O，无时钟，无随机
labs/l19/ops.ts / ops.py          # 学员文件：观察实验 + 6 个 TODO
labs/l19/verify.ts / verify.py    # 零模型断言；OPS_IMPL=shared 测参考实现
labs/l19/runner.ts / runner.py    # 仅 live：真实 worker + 真实模型 + kill -9 + 本地 SSE
```

- `shared/ops.ts` 依赖：`./codingEval.ts`（`cmpCodePoint`；L18 建议后续迁到 `evalStats`）、`./store.ts`（`planResume`、`Replayability`——**新增 import**）、`./budget.ts` 的**类型**（`OverLimitKind`）。**禁止**（传递地）依赖：`models.ts`、`agent.ts`、`fs`/`net`（INV-36、INV-37）。
- 数值规约（沿用 L18 §9.2）：只用整数；金额为 `Pico`（`bigint`/Python `int`）；注入时钟 `now: number`（毫秒整数）与注入 `rng`（`Lcg`，高位 `int(n)`）；排序用 `cmpCodePoint`；不用 `toFixed`、不用 `localeCompare`、不用 `Date.now`/`Math.random`；输出里的比例用整数 ppm（百万分率）或固定小数位的整数字符串（`fmtPermille`）。
- 一致性守卫：`verify` 里加 NUM-1（`healthCheck.detail` 用 `fmtPermille` 后 `0.0625`→`"62‰"` 在 TS/Python 里一致，不再有 `0.063` vs `0.062`）、NUM-2（扫描源码）。

### 6.2 六个 TODO（学员实现）

| TODO | 函数 | 要实现的不变量 | 对应 INV | 难度 |
|---|---|---|---|---|
| T1 | `applyTransition(job, ev)` | 合法转移表；`epoch` 围栏；租约过期则 `heartbeat/checkpoint` 拒；`cancelling` 中间态；`maxAttempts` → `dead` | 2, 3, 4, 8, 9 | ★★★ |
| T2 | `startJob(input)`（含 `checkIdempotency`） | `(tenant,key)` 命名空间；载荷指纹冲突；TTL；进行中返回现有作业 id；终态重放且 `failed` 带「换 key」提示 | 12–16 | ★★ |
| T3 | `retryDecision(effectClass, err, hasKey, attempt, budget, rng)` | 吃 `OverLimitKind`；`spend_limit` 不重试；`rate` 延迟 ≥ `retryAfter`；预算耗尽不重试；`unsafe_write` 无 key 永不重试 | 18–20, 22 | ★★ |
| T4 | `admit` + `settle` | `Pico` 整数；预留/释放；事后扣账允许负余额；窗口按注入时钟的 UTC 日滚动 | 24, 25, 29 | ★★ |
| T5 | `fairNext(queued, served, running, policy)` | 跳过并发已满者；按累计成本最小者优先；老化；平局 `cmpCodePoint` | 26–28 | ★★ |
| T6 | `recallApproval(memories, q)` | deny 优先；路径段边界；复合命令全部覆盖才命中；`ttl` 到期；`once` 消费 | 50–53 | ★★★ |

**设计取舍：** 草稿的 T6（`startJob`）并入 T2，把 T6 让给审批记忆——因为审批记忆是 L16/L17 的欠条，必须让学员亲手写；`eventsAfter`/`resumeCursor`、`admitUnderDeploy`、`healthCheck`、`resumeCheck` 保留为**参考实现**（学员在观察实验里读，在 verify 里被测，但不重写）。

### 6.3 零模型断言（共 76 条，分 15 组）

> `[保]` = 草稿已有且保留；`[改]` = 草稿已有，需要修订；`[新]` = 新增。

| 组 | ID | 断言内容 | 状态 |
|---|---|---|---|
| **JOB** | JOB-1…10 | 草稿的 10 条（enqueue/claim/checkpoint/seq 递增/worker 不匹配/过期保留 checkpoint/未过期拒绝/succeed/终态不可 claim/`eventsAfter` 排序过滤） | [保] |
| | JOB-11 | `claim` 返回 `epoch`；旧 epoch 的 `checkpoint` 被拒（INV-4） | [新] |
| | JOB-12 | `attempt ≥ maxAttempts` 的 `requeue_stale` 进入 `dead`（INV-3） | [新] |
| | JOB-13 | `cancel` 对 `running` 作业先到 `cancelling`，worker 确认后才 `cancelled`（INV-8） | [新] |
| | JOB-14 | 租约已过期时 `heartbeat` 被拒（INV-2） | [新] |
| **IDEM** | IDEM-1…5 | 草稿 5 条（首次/replay/conflict/unsafe 无 key/read 无 key） | [保] |
| | IDEM-6 | 相同 key、不同 `tenantId` 互不可见，且不泄露「key 存在」（INV-15） | [新] |
| | IDEM-7 | `startJob` 同 key 不同 `payloadHash` → `conflict`（INV-14） | [新] |
| | IDEM-8 | 记录年龄 ≥ TTL（注入时钟）→ 视为新请求 `execute`（INV-16） | [新] |
| **RETRY** | RETRY-1…5 | 草稿 5 条 | [保] |
| | RETRY-6 | `OverLimitKind='spend_limit'` → 不重试（INV-19） | [新] |
| | RETRY-7 | `rate` 且 `retryAfterMs=5000` → `delayMs ≥ 5000`；同一 `Lcg` 种子下延迟序列 TS/Python 一致（INV-19/22） | [新] |
| | RETRY-8 | 重试预算耗尽（已重试数 ≥ 10% 请求数）→ 不重试（INV-18） | [新] |
| **QUOTA** | QUOTA-1…4 | 草稿 4 条（并发/排队/成本/通过） | [保] |
| | QUOTA-5 | `Pico` 整数：用量 + 估算 **恰等于**上限 → 通过（INV-25） | [新] |
| | QUOTA-6 | `settle(actual)` 使余额为负后，**下一次** `admit` 被拒（INV-24） | [新] |
| | QUOTA-7 | 认领时复核并发：用户已满时 `fairNext` 之后的 `claim` 被拒（INV-28） | [新] |
| | QUOTA-8 | 跨 UTC 日（注入时钟）用量重置（INV-29） | [新] |
| **FAIR** | FAIR-1,2 | 草稿 2 条（久未服务者优先 / 空） | [改]：`lastServed` → `servedCost` |
| | FAIR-3 | 并发已满的用户被跳过（INV-28） | [新] |
| | FAIR-4 | whale(600×N) vs minnow(10×N)：按成本轮转时 minnow 在前 K 次选择里被选中比例 ≥ 阈值（INV-27，数值取自 §7 EXP-B 的确定性模拟） | [新] |
| | FAIR-5 | 老化：等待 ≥ A 的作业优先于更低成本者，避免饿死（INV-27） | [新] |
| **MEM** | MEM-1,3…6 | 草稿的 hit / session 不匹配 / ttl 内 / ttl 外 / once 消费 | [保] |
| | MEM-2 | `/repo` 不放行 `/repo-evil`（**保留意图，改实现**：由「精确」改为「段边界」） | [改] |
| | MEM-7 | `/repo` 记忆命中 `/repo/a.ts` 与 `/repo/`（INV-51） | [新] |
| | MEM-8 | 同时存在 deny 与 allow → `deny`（INV-53） | [新] |
| | MEM-9 | 允许 `npm test` 不放行 `npm test && curl x`；`timeout 5 npm test` 命中（INV-52） | [新] |
| **APPR** | APPR-1 | 审批超过 `deadline`（注入时钟）→ 自动「拒绝」，作业**不**取消（INV-9/55） | [新] |
| | APPR-2 | `deny` 回写 tool result，作业回到 `running`（INV-55） | [新] |
| | APPR-3 | 3 次连续 / 20 次总拒绝 → `waiting_human`；无人值守 → `failed(denied_too_often)`（INV-55） | [新] |
| | APPR-4 | `waiting_approval` 停靠：释放租约、不计入 `running`（INV-9） | [新] |
| **DEP** | DEP-1…6 | 草稿 6 条（open / drain 拒新 / drain 许续 / kill / health ok / health kill） | DEP-6 [改]：kill 下 liveness 仍 ok、readiness 对「新作业」为 false |
| | DEP-7 | kill 下 `cancel` 与 `read` 被允许（INV-39） | [新] |
| | DEP-8 | `liveness` 与 `readiness` 是两个独立检查（INV-39） | [新] |
| **START** | START-1…3 | 草稿 3 条（drain 拒绝 / 正常开工 / 终态重放） | [保] |
| **CUR** | CUR-1 | 游标 > 日志末尾 → `ahead` 错误（INV-47） | [新] |
| | CUR-2 | 游标 < 保留下限 → `expired`，客户端须回退全量快照（INV-5/47） | [新] |
| | CUR-3 | 同一事件重复投递，按 `seq` 应用幂等（INV-49） | [新] |
| | CUR-4 | 断线（连接关闭）不改变作业状态（INV-44） | [新] |
| **RES** | RES-1 | `workspaceHash` 与 `Workspace.contentHash` 不一致 → 拒绝静默续跑（INV-7） | [新] |
| | RES-2 | `planResume`：`intent` 无 `outcome` 且 `once` → `ask`；`idempotent` → `redo`（INV-17） | [新] |
| **MET** | MET-1 | 由注入时钟事件推导 `queue_wait`、`start_latency`；`model_ttft` 字段缺省为 `null`（INV-41、§3.3） | [新] |
| **NUM** | NUM-1 | `fmtPermille(62.5‰)` 等边界值在 TS/Python 一致（INV-37） | [新] |
| | NUM-2 | 源码扫描：`shared/ops.ts` 无 `Date.now`、`Math.random`、`toFixed`、参数属性、`enum`；依赖闭包无 `models.ts`/`agent.ts`（INV-36/37） | [新] |

**计数**：草稿原有 41（JOB 10 + IDEM 5 + RETRY 5 + QUOTA 4 + FAIR 2 + MEM 6 + DEP 6 + START 3），其中 FAIR-1/2、MEM-2、DEP-6 需要修订（仍计入 41）；新增 35（JOB 4 + IDEM 3 + RETRY 3 + QUOTA 4 + FAIR 3 + MEM 3 + APPR 4 + DEP 2 + CUR 4 + RES 2 + MET 1 + NUM 2）。**合计 76**，落在 50–80 的目标区间内。

### 6.4 Python 对齐与「同一结果」测试

- `l19/ops.py` 与 `ops.ts` 的观察实验输出必须**逐字节一致**（沿用 L18 的做法：CI 里 `diff <(pnpm ops) <(uv run python -m l19.ops)`）。
- `shared/ops.py` 的 `HealthCheckItem.detail` 与 TS 的 `detail` 同一格式（修 D-15）。
- Python 跑法：`OPS_IMPL=shared uv run python -m l19.verify`（草稿已有）。

### 6.5 数量检查（落盘后跑）

```
OPS_IMPL=shared pnpm verify:l19              # 期望：「✓ 76 条断言全部通过」
OPS_IMPL=shared uv run python -m l19.verify  # 期望：同上，且输出逐字节一致
```
`verify` 末尾已经打印 `passed` 计数；断言数变化时，以此计数与 §6.3 的表同时更新为准。

### 6.6 `runner.ts`（**仅 live**，不进 CI 的零模型路径）

| # | 内容 | 为什么必须 live |
|---|---|---|
| R-1 | 起一个本地 HTTP + SSE 服务；用 L17 编码 agent 跑一个真实任务；在运行中途 `kill -9` worker，再启动第二个 worker，验证续跑并**打印**重放事件数 | 要真实进程与真实模型的时序 |
| R-2 | 在流中途断开客户端连接，重连用 `Last-Event-ID` 续上；断言**作业状态未变**（零模型版是 CUR-4，这里是端到端） | 真实 TCP/代理行为（可选加反向代理） |
| R-3 | 两个用户并发提交同样的作业：一个带 key 重试 3 次，一个不带；比较真实账单（`Picofen`） | 真实价格与重复执行 |
| R-4 | 测 TTFT 基线：`queue_wait` + `start_latency` + `model_ttft` 三段（§3.3） | 欠条兑付；`model_ttft` 只能 live |
| R-5 | `--max-budget-usd` 之类的上限被越过多少（对账：作业内计数 vs 账本）（INV-40） | 真实账单滞后 |

---

## 7. 本轮自产证据（`[O]`）：方法与数字

> 脚本在 `/tmp/l19probe/p1.mjs`（对 `shared/ops.ts` 的行为探针）与 `/tmp/l19probe/p2.mjs`（确定性模拟），**不在工作区内**。复现：把 §7 的方法重写成 `labs/l19/` 下的观察实验即可（EXP-2…7 的设计就是它们的产品化）。随机源为固定种子的线性同余（`s = s*1103515245+12345 & 0x7fffffff`，`s0=12345`）。
> 环境：Node v22.19.0 / Python 3.13.13 / macOS。

**EXP-A　可见性超时 vs 任务时长**（10 000 个任务，时长均匀 ∈ [10,120] s，整数；`copies = ⌈d/vt⌉` 当 `d>vt`）

| vt（秒） | 被重复的任务占比 | 额外执行次数/任务 |
|---|---|---|
| 30 | 81.1% | 1.63 |
| 60 | 54.2% | 0.54 |
| 120 | 0.0% | 0 |
| 900 | 0.0% | 0 |

（模型假设：无心跳，worker 不崩溃，消息超时后重投；它说明的是量级，不是 SQS 的精确行为。）

**EXP-B/B2　三种公平策略**（4 个 worker；whale 100 个 600 s 作业先提交；minnow 100 个 10 s 作业；策略在每个 worker 空闲时选下一个）

| 策略 | whale 占 t<1000 s 内起跑的 worker 秒数 | minnow 占 | minnow 全部完工（s） |
|---|---|---|---|
| FIFO | 100.0% | 0.0% | 15 250 |
| 按条数轮转（草稿 `fairNext` 同类） | 98.0% | 2.0% | 14 670 |
| 按累计成本轮转 | 75.0% | 25.0% | 400 |

（75/25 不是 50/50，是因为作业不可抢占：whale 的第一个 600 s 作业一旦开始就占住一个 worker 600 s。**结论是排序与数量级，不是精确比例**。FAIR-4 断言用「选择序列」而不是份额。）

**P-a…P-m　对 `shared/ops.ts` 的行为探针**（原样输出摘要）

| 探针 | 输入 | 观察 |
|---|---|---|
| P-a fairNext 并发 | whale `running=1,max=1`，`lastServed` 更旧 | 选中 `w1`（whale 的作业） |
| P-b 浮点配额 | `used=0.1, est=0.2, daily=0.3` | `{"ok":false,"reason":"dailyCost 超限"}`；`0.1+0.2=0.30000000000000004` |
| P-c 跨租户 | `bob` 用 `alice` 的 key | `{"kind":"replay","job":{"id":"A1","userId":"alice",…}}` |
| P-d deny | `waiting_approval` → `deny` | 状态 `cancelled` |
| P-e 毒丸 | 1000 次 `claim`→`requeue_stale` | 状态仍 `queued`；`Job` 字段中无 attempt |
| P-f 僵尸 | `w1` 认领 → 过期 → 重新入队 → `w1` 再认领 → 旧进程发 `checkpoint` | `ok=true` |
| P-g 取消 | `running` → `cancel` | 状态 `cancelled`；`workerId` 仍在；之后的心跳被拒 |
| P-h 游标越界 | `eventsAfter(seq 1..3, 99)` | `[]` |
| P-i 路径记忆 | 记住 `/repo`（session） | `/repo/` → 未命中；`/repo/a.ts` → 未命中 |
| P-i2 deny 记忆 | 记住 `allowed:false` 覆盖同键 | `recallApproval` → `null` |
| P-j 格式化 | `errorRate=0.0625` | TS `toFixed(3)`=`"0.063"`；Python `f"{0.0625:.3f}"`=`"0.062"` |
| P-k 过期心跳 | `leaseUntil=10`，`now=1e6` | `ok=true` |
| P-l 错误分类 | `429/409/CONFLICT/500/502` | `transient / unknown / permanent / unknown / unknown` |
| P-m kill | `admitUnderDeploy(kill,'resume')` | `{ok:false, reason:'kill switch：x'}`；`DeployKind` 无 `cancel/read` |

**P-n　strip-types 兼容性**：见 §0.2（33 个 `shared/*.ts` 中 16 个可直接加载、16 个抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`、1 个因环境变量缺失失败；`models.ts` 归后者之外）。

**未能得到的证据**：`pnpm verify:lNN` 在沙箱里以 `ELIFECYCLE exit 1` 结束，**没有看到真实报错**（可能是 `tsx` 的 IPC 管道被沙箱限制）。因此本报告**没有**引用 `pnpm` 版的 verify 结果；所有 `verify` 结果都来自 `node lNN/verify.ts`（仅限 strip-types 兼容的模块）或 `python3 -m`。L18 `BENCH_IMPL=shared node l18/verify.ts` 实测 **48** 条断言全部通过（L18 报告当时记 45 条，此后草稿又增加）。

---

## 8. 未溯源 / 需要发布前复核的清单

| # | 条目 | 状态 | 处理 |
|---|---|---|---|
| M-1 | Temporal 事件历史上限 51,200、Cloudflare 524 的 125 s、SQS 可见性超时默认 30 s / 上限 12 h、Copilot 59 分钟、Cloud Run 3600 s 的**具体数字** | 本轮读过，但这一轮（上下文压缩后）无法再逐条贴原文 | 讲稿里引用时**回到原文复核一次**，并在页脚写日期 |
| M-2 | 围栏令牌（Kleppmann）的原文 | `[S]` **未抓取** | 讲稿可以讲概念，但引用必须补原文链接；或改用 Temporal/Chubby 的一手文档 |
| M-3 | IETF `Idempotency-Key` 草案的具体过期语义 | `[S]` 草案已过期，仅作术语参考 | 讲稿里写「草案，非标准」 |
| M-4 | Google SRE 四个黄金信号 | `[S]` 未抓取 | 可换成 L13 已引用的指标；或补抓 |
| M-5 | Anthropic 的 93% vs 97% 批准率 | 两篇文章口径不同 | 引用时标明**哪一篇**、**哪个口径**；不要混用 |
| M-6 | OpenTelemetry GenAI 语义约定里的 TTFT 指标名 | 页面迁移，**抓取失败** | **不写指标名**；只讲「三段拆分」 |
| M-7 | MCP 工具注解里 `idempotentHint` 的措辞 | 只读到「注解不可信」的一般规则 | 不要把它当作幂等的**证据**，只当作提示 |
| M-8 | AWS *Fairness in multi-tenant systems* 对「事后扣账/允许余额为负」的具体措辞 | 读到要点，未保留逐字原文 | 引用时只写思想，不写引号 |
| M-9 | VTC 论文的**确切**算法（如何选「最小计数器」、如何处理新到客户的计数器提升） | 读到摘要与核心思想 | 本报告的「按累计成本轮转」是**作业级类比**，不是 VTC 本身；讲稿须注明 |
| M-10 | Replit 事件的细节（时间线、公司回应） | `[P2]` 多家转述 | 讲稿里只用「违反了明确的代码冻结指令」这一条，且标注来源 |
| M-11 | 「分类器漏报 17%」所对应的数据集与口径 | 来自文章表格（“real overeager actions”） | 引用时带上「在真实过度主动动作上」 |
| M-12 | Cursor「team follow-ups / lateral movement」的原话 | 本轮读到要点 | 讲稿引用前复核 |

---

## 9. 主题改名结论（条件性：证据成立才改）

**当前**：`长任务与队列 / 幂等与重试 / 多用户与配额 / 部署与监控`

**证据**：
1. 55 条 INV 中，A（持久执行·队列·状态机）11 条、B（幂等与重试）11 条、C（配额与公平）9 条、D（部署与监控）11 条——**这四个主题与现稿完全对应**，没有任何一个可以被省略。
2. 但有两组证据**不在这四个标题之内**：E（断线续传，7 条）与 F（审批记忆·后台 UI·TTFT，6 条）。它们不是「部署与监控」的子项：E 是**连接与寿命解耦**的协议问题；F 是**人在回路**的策略问题，并且是 L16/L17 两张欠条的兑付点。
3. 现稿的「长任务与队列」会让学员把注意力放在「用什么队列」（Redis/SQS/Postgres），而 INV-1…11 的核心结论是：**队列是 at-least-once，难点在作业状态机与围栏**——应该叫「作业」而不是「队列」。
4. 「多用户与配额」漏掉了**公平**：INV-26/27 的核心结论是「公平 ≠ 限额」。

**结论（条件性）**：
- **L19 标题保持「Capstone 三：上线」**（用户已定）。
- **主题改名：是，建议改**，理由 1–4 成立。建议改为：

  `作业与状态机（长任务不掉线）` / `幂等与重试（只做一次的幻觉）` / `配额与公平（多用户）` / `连接与审批（断线续传、记住允许）` / `部署与监控（沙箱、密钥、kill switch）`

  即：**4 → 5 个主题**，把 E+F 合并为「连接与审批」（它们共享一个性质：**都是「人 / 客户端」与「作业」寿命不同步**）。若 curriculum 版面只能容纳 4 个，则保留原 4 个标题但改写副标题（「队列」→「作业」，「配额」→「配额与公平」），并把 E+F 并入「部署与监控」之后的第五行「连接与审批」。
- **不改名的条件**：如果课程时长/版面确实不允许新增主题，则 E/F 的内容仍要讲，但放进「幂等与重试」（E，因续传与幂等同构：INV-44/45/49）和「部署与监控」（F，因审批策略是部署形态的一部分：INV-34）。此时标题**不改**，但讲稿必须在对应章节里显式出现 INV-43…55。

---

## 10. 讲稿与 lab 的行文提示

1. **先让学员观察，再让学员实现。** 观察实验（§5）七张表每张都对应一个「上线后才爆」的失败；TODO 在观察之后。
2. **每个 TODO 的测试都至少有一条「看起来对但是错」的反例**（T1：同名 worker；T2：跨租户；T3：429 花费上限；T4：`0.1+0.2`；T5：并发满；T6：`/repo-evil` 与 `/repo/a.ts`）。
3. **不要把「分布式正确性」说成 verify 通过就有**（§2.3）。
4. **注意不要抢 L18 的统计学、L14 的风险分类、L20 的面试、L21 的图谱。**
5. **在讲稿里补注 §0.1 的五条更新**（尤其是 TS strip-types 与 `429` 分类）。

---

## 11. Top 5 最承重的倒置

1. **INV-1/2/4　队列是 at-least-once，「只一次」靠租约 + 心跳 + 围栏令牌自己造。** 量级：vt=30 s 时 81.1% 的任务被重复执行（`[O]`）；同名 worker 重新认领后旧进程写入被接受（`[O]`）。——整个 L19 的地基；T1 的核心。
2. **INV-15　幂等 key 必须按租户命名空间。** 草稿里 `bob` 用 `alice` 的 key 拿到了她的整份作业（`[O]`）。——唯一一条**直接泄露数据**的缺陷；T2 的核心。
3. **INV-19　`429` 不是一个类别。** Anthropic 的花费上限 429 不带 `retry-after`；草稿与 `withRetry` 都对它无限退避。——把 L15 的 `OverLimitKind` 真正接上重试；T3 的核心。
4. **INV-27　公平是成本公平，不是条数公平。** 100 个 10 s 作业在按条数轮转下要 14 670 s，按成本轮转只要 400 s（`[O]`）。——T5 的核心；也是「多用户」这个主题存在的理由。
5. **INV-51/53/55　审批记忆是「谁、对什么、多久、可否被否决」的策略；拒绝回给 agent，而不是杀死作业。** 精确 scope 让「记住目录」对文件无效；deny 记忆召回不到；`deny→cancelled` 丢掉了官方设计里「换条路」那一档。——兑付 L16/L17 欠条；T6 的核心。

（第 6–8 名备选：INV-39 kill 不能让健康检查把实例摘光；INV-47 游标越界必须是错误；INV-37 strip-types 与 `shared/` 子集不兼容。）

---

## 12. Lab API 草图（`shared/ops.ts` / `ops.py`）

```ts
// ── 一、作业状态机 ───────────────────────────────────────────
export type JobStatus =
  | 'queued' | 'running' | 'waiting_approval' | 'cancelling'
  | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'dead'
export const TERMINAL: ReadonlySet<JobStatus>

export interface Checkpoint {
  seq: number                 // 恢复点序号（严格递增）
  eventSeqAt: number          // 该 checkpoint 对应的流事件序号（INV-49）
  toolCallsDone: number
  lastToolId?: string
  workspaceHash: string       // = L17 Workspace.contentHash（INV-7）
}
export interface Job {
  id: string; tenantId: string; userId: string       // userId = 发起者，不可被 follow-up 改写（INV-42）
  status: JobStatus
  createdAt: number; updatedAt: number
  attempt: number; maxAttempts: number               // INV-3
  epoch: number                                       // 围栏令牌，claim 时 +1（INV-4）
  workerId?: string; leaseUntil?: number
  checkpoint?: Checkpoint
  idempotencyKey?: string; payloadHash?: string
  costPico: bigint; tokens: number
  failureReason?: string
}
export type Transition =
  | { type: 'enqueue' }
  | { type: 'claim'; workerId: string; now: number; leaseMs: number }
  | { type: 'heartbeat'; workerId: string; epoch: number; now: number; leaseMs: number }
  | { type: 'checkpoint'; workerId: string; epoch: number; checkpoint: Checkpoint; now: number }
  | { type: 'request_approval'; workerId: string; epoch: number; deadline: number; now: number }
  | { type: 'approve'; now: number }
  | { type: 'deny'; now: number; reason: string }            // 回写 tool result，不终止（INV-55）
  | { type: 'succeed' | 'fail'; workerId: string; epoch: number; now: number; reason?: string }
  | { type: 'request_cancel'; now: number; reason: string }  // → cancelling
  | { type: 'ack_cancel'; workerId: string; epoch: number; now: number }
  | { type: 'requeue_stale'; now: number }                    // 过期 → queued 或 dead
export function applyTransition(job: Job, ev: Transition): { ok: boolean; job: Job; reason?: string }

// ── 二、续传 ─────────────────────────────────────────────────
export type CursorVerdict<T> =
  | { ok: true; events: T[] }
  | { ok: false; reason: 'ahead' | 'expired' }
export function resumeCursor<T extends { seq: number }>(
  events: T[], lastSeen: number, floor: number,
): CursorVerdict<T>
export function resumeCheck(
  cp: Checkpoint, currentWorkspaceHash: string, effects: Event[],   // Event 来自 shared/store.ts
): { action: 'resume' | 'ask' | 'rollback'; plan: ReturnType<typeof planResume> }

// ── 三、幂等与重试 ───────────────────────────────────────────
export type EffectClass = 'read' | 'idempotent_write' | 'unsafe_write'
export interface IdemKey { tenantId: string; key: string }                // INV-15
export function checkIdempotency(
  req: { id: IdemKey; effectClass: EffectClass; payloadHash: string },
  prior: { payloadHash: string; result: string; at: number } | undefined,
  now: number, ttlMs: number,
): { kind: 'execute' } | { kind: 'replay'; result: string }
 | { kind: 'conflict'; reason: string } | { kind: 'reject'; reason: string }
export interface RetryBudget { requests: number; retries: number; maxRatioPpm: number }   // INV-18
export function retryDecision(
  effectClass: EffectClass,
  err: { code: ErrorCode; overLimit?: OverLimitKind; retryAfterMs?: number },
  hasKey: boolean, attempt: number, maxAttempts: number,
  budget: RetryBudget, rng: Lcg, baseMs: number, capMs: number,
): { retry: boolean; delayMs: number; reason: string }
export function startJob(input: StartJobInput): StartJobVerdict          // 内部调用 checkIdempotency

// ── 四、配额与公平（金额一律 Pico 整数）───────────────────────
export interface QuotaPolicy {
  maxConcurrentPerUser: number; maxQueuedPerUser: number
  dailyCostPico: bigint; dailyTokens: number
}
export interface UserUsage {
  userId: string; running: number; queued: number
  costPicoToday: bigint; tokensToday: number; dayIndex: number           // UTC 日序号（注入时钟换算）
}
export function admit(u: UserUsage, p: QuotaPolicy, estPico: bigint, estTokens: number, nowDay: number): AdmitVerdict
export function settle(u: UserUsage, actualPico: bigint, actualTokens: number): UserUsage   // 允许为负（INV-24）
export function fairNext(
  queued: Job[],
  servedPico: Record<string, bigint>,           // 累计已付成本，不是时间戳（INV-27）
  running: Record<string, number>, p: QuotaPolicy, now: number, agingMs: number,
): string | null

// ── 五、审批记忆 ─────────────────────────────────────────────
export type RememberMode = 'once' | 'session' | 'ttl'
export interface ApprovalMemory {
  userId: string; tool: string
  scope: string                          // 路径 | 规范化命令段集合的键 | 域名
  scopeKind: 'path' | 'command' | 'domain'
  mode: RememberMode; sessionId?: string; expiresAt?: number
  verdict: 'allow' | 'deny'              // deny 优先（INV-53）
}
export function scopeCovers(granted: string, requested: string, kind: 'path' | 'command' | 'domain'): boolean
export function recallApproval(mems: ApprovalMemory[], q: ApprovalQuery): 'allow' | 'deny' | null
export function rememberApproval(mems: ApprovalMemory[], e: ApprovalMemory, risk: Risk): ApprovalMemory[]  // 高风险拒绝记忆
export function consumeOnce(mems: ApprovalMemory[], hit: ApprovalMemory): ApprovalMemory[]
export interface DenialCounter { consecutive: number; total: number }
export function onDenial(c: DenialCounter, unattended: boolean): { next: DenialCounter; action: 'continue' | 'waiting_human' | 'fail' }

// ── 六、部署闸与健康 ─────────────────────────────────────────
export type DeployMode = 'open' | 'drain' | 'kill'
export type DeployKind = 'new_job' | 'resume' | 'effect' | 'cancel' | 'read'   // INV-39
export function admitUnderDeploy(s: DeployState, k: DeployKind): { ok: boolean; reason?: string }
export function liveness(): { ok: true }
export function readiness(input: HealthInput): { ok: boolean; checks: HealthCheckItem[] }   // detail 用 fmtPermille，无 toFixed
export function fmtPermille(permille: number): string                                       // 整数 → "62‰"（NUM-1）

// ── 七、指标（只做可由注入时钟推导的部分）────────────────────
export function latencySplit(events: { type: string; at: number }[]): {
  queueWaitMs: number; startLatencyMs: number; modelTtftMs: number | null    // live 才有（§3.3）
}
```

`l19/runner.ts`（live，不进零模型路径）暴露：`main({ workers, kill9AtToolCall, clientDisconnectAt })`，只调用以上纯函数 + 真实 `agent.ts`/`coding.ts`，输出 R-1…R-5 的表。
