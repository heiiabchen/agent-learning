# Agent 学院 · 实操代码

课程讲义在网页上（仓库根目录 `pnpm dev`），代码在这里。一节课一个目录：`l00/`、`l01/`……

每个练习都有 **TypeScript 和 Python 两份**，跑哪个都行。

- **TypeScript 是主通道。** 讲义示例、贯穿项目、面试要写的代码都以它为准。
- **Python 是副通道。** 不是为了让你转语言，是为了让你读得懂这个生态里绝大多数的开源 agent 代码。同一个练习在两边各写一遍，你会看到「同一个工程决策在不同并发模型下长什么样」——这个对照本身就是知识。

## 一次性准备

```bash
cd labs
cp .env.example .env       # 两个通道共用这一份
```

去 [platform.deepseek.com](https://platform.deepseek.com/) 创建 API key 填进 `.env`。充最小额度即可——整门课的 API 消耗大概是几十块人民币的量级。

TypeScript 通道：

```bash
pnpm install
pnpm models                # 确认当前可用的模型 ID
```

Python 通道：

```bash
uv sync                    # 没装 uv 就用 python -m venv .venv && pip install -r requirements.txt
uv run python -m shared.models
```

`models` 这个脚本会问 API 当前有哪些可用模型，把你要用的那个填进 `.env` 的 `DEEPSEEK_MODEL_MAIN`。**不要相信任何教程里写死的模型 ID**，包括这一份——`deepseek-chat` 在 2026 年 7 月就已经退役了。

## 怎么跑

TypeScript 走 pnpm 脚本，Python 走模块路径：

| 练习 | TypeScript | Python |
|---|---|---|
| L00 第一个请求 | `pnpm hello` | `uv run python -m l00.hello` |
| L00 流式输出 | `pnpm stream` | `uv run python -m l00.stream` |
| L00 超时/重试/并发 | `pnpm resilient` | `uv run python -m l00.resilient` |
| L00 验证那三个函数 | `pnpm verify` | `uv run python -m l00.verify` |
| L01 token 效率 | `pnpm tokens` | `uv run python -m l01.tokens` |
| L01 temperature | `pnpm sampling` | `uv run python -m l01.sampling` |
| L01 无状态的代价 | `pnpm conversation` | `uv run python -m l01.conversation` |
| L02 请求解剖 | `pnpm anatomy` | —— |
| L02 成本账本 | `pnpm ledger` | `uv run python -m l02.ledger` |
| L02 流式读取器 | `pnpm reader` | `uv run python -m l02.reader` |
| L02 验证 | `pnpm verify:l02` | `uv run python -m l02.verify` |
| L03 prompt 模板 | `pnpm prompt` | `uv run python -m l03.prompt` |
| L03 输出方差 | `pnpm variance` | `uv run python -m l03.variance` |
| L03 结构化输出 | `pnpm structured` | `uv run python -m l03.structured` |
| L03 验证 | `pnpm verify:l03` | `uv run python -m l03.verify` |
| L04 工具 schema | `pnpm schema` | `uv run python -m l04.schema` |
| L04 工具箱与沙箱 | `pnpm toolbox` | `uv run python -m l04.toolbox` |
| L04 完整往返 | `pnpm roundtrip` | `uv run python -m l04.roundtrip` |
| L04 验证 | `pnpm verify:l04` | `uv run python -m l04.verify` |
| L05 手写 agent loop | `pnpm loop` | `uv run python -m l05.loop` |
| L05 接真模型 | `pnpm agent "任务"` | `uv run python -m l05.agent "任务"` |
| L05 故障注入 | `pnpm chaos` | `uv run python -m l05.chaos` |
| L05 验证 | `pnpm verify:l05` | `uv run python -m l05.verify` |
| L05x attention 与 KV cache | `pnpm attention` | `uv run python -m l05x.attention` |
| L05x 采样 | `pnpm decode` | `uv run python -m l05x.decode` |
| L05x 验证 | `pnpm verify:l05x` | `uv run python -m l05x.verify` |
| L06 上下文计量与预算 | `pnpm budget` | `uv run python -m l06.budget` |
| L06 压缩策略 | `pnpm compress` | `uv run python -m l06.compress` |
| L06 长任务四种策略对比 | `pnpm longrun` | `uv run python -m l06.longrun` |
| L06 验证 | `pnpm verify:l06` | `uv run python -m l06.verify` |
| L07 五种编排模式 | `pnpm patterns` | `uv run python -m l07.patterns` |
| L07 workflow/agent 成本对照 | `pnpm compare` | `uv run python -m l07.compare` |
| L07 验证 | `pnpm verify:l07` | `uv run python -m l07.verify` |
| L08 会话持久化与恢复 | `pnpm session` | `uv run python -m l08.session` |
| L08 长期记忆与污染 | `pnpm memory` | `uv run python -m l08.memory` |
| L08 崩溃与恢复四场景 | `pnpm resume` | `uv run python -m l08.resume` |
| L08 验证 | `pnpm verify:l08` | `uv run python -m l08.verify` |
| L09 检索全套六组实验 | `pnpm retrieve` | `uv run python -m l09.retrieve` |
| L09 一次性 vs 多轮检索 | `pnpm agentic` | `uv run python -m l09.agentic` |
| L09 验证 | `pnpm verify:l09` | `uv run python -m l09.verify` |
| L09x 企业知识库观察实验 | `pnpm kb` | `uv run python -m l09x.kb` |
| L09x 验证 | `pnpm verify:l09x`（56 项） | `uv run python -m l09x.verify`（56 项） |
| L10 MCP server 五组实验 | `pnpm mcp:server` | `uv run python -m l10.server` |
| L10 真子进程往返 demo | `pnpm mcp:client` | `uv run python -m l10.client` |
| L10 远程 MCP 授权观察 | `pnpm mcp:auth` | `uv run python -m l10.auth` |
| L10 验证 | `pnpm verify:l10`（55 项） | `uv run python -m l10.verify`（59 项） |
| L10x skills 观察实验 | `pnpm skills` | `uv run python -m l10x.skills` |
| L10x 验证 | `pnpm verify:l10x`（56 项） | `uv run python -m l10x.verify`（56 项） |
| L11 多 agent 四道闸 | `pnpm orchestrate` | `uv run python -m l11.orchestrate` |
| L11 15 倍成本推导 | `pnpm compare:multi` | `uv run python -m l11.compare` |
| L11 验证 | `pnpm verify:l11` | `uv run python -m l11.verify` |
| L11x 生态四件机制 | `pnpm eco`（对照） | `uv run python -m l11x.ecosystem`（主） |
| L11x 验证 | `pnpm verify:l11x`（25 项） | `uv run python -m l11x.verify`（39 项） |
| L12 评测七组实验 | `pnpm suite` | `uv run python -m l12.suite`（多一组） |
| L12 门禁（交付物） | `pnpm regress` | `uv run python -m l12.regress` |
| L12 验证 | `pnpm verify:l12`（53 项） | `uv run python -m l12.verify`（58 项） |
| L13 可观测性九组实验 | `pnpm trace` | `uv run python -m l13.trace` |
| L13 失败复盘（交付物） | `pnpm postmortem` | `uv run python -m l13.postmortem` |
| L13 验证 | `pnpm verify:l13`（76 项） | `uv run python -m l13.verify`（76 项） |
| L14 安全九组实验 | `pnpm inject` | `uv run python -m l14.inject` |
| L14 安全门（交付物） | `pnpm gate`（非零退出） | `uv run python -m l14.gate`（非零退出） |
| L14 验证 | `pnpm verify:l14`（99 项） | `uv run python -m l14.verify`（99 项） |
| L14x 浏览器 agent 观察实验 | `pnpm browse` | `uv run python -m l14x.browse` |
| L14x 验证 | `pnpm verify:l14x`（52 项） | `uv run python -m l14x.verify`（52 项） |
| L15 成本五组实验 | `pnpm cache` | `uv run python -m l15.cache` |
| L15 成本审计（交付物） | `pnpm audit`（非零退出） | `uv run python -m l15.route`（非零退出） |
| L15 验证 | `pnpm verify:l15`（96 项） | `uv run python -m l15.verify`（95 项） |
| L16 前端七组实验 | `pnpm wire` | `uv run python -m l16.wire` |
| L16 agent 界面（交付物） | `pnpm ui` → localhost:5316 | 无（见下） |
| L16 验证 | `pnpm verify:l16`（136 项） | `uv run python -m l16.verify`（136 项） |
| L16x 生成式 UI 观察实验 | `pnpm genui` | `uv run python -m l16x.genui` |
| L16x 验证 | `pnpm verify:l16x`（48 项） | `uv run python -m l16x.verify`（48 项） |
| L16y 语音 agent 观察实验 | `pnpm voice` | `uv run python -m l16y.voice` |
| L16y 验证 | `pnpm verify:l16y`（56 项） | `uv run python -m l16y.verify`（56 项） |
| L17 Capstone 观察实验 | `pnpm coding` | `uv run python -m l17.edit` |
| L17 验证 | `pnpm verify:l17`（85 项） | `uv run python -m l17.verify`（84 项） |
| L18 Capstone 评测观察 | `pnpm bench` | `uv run python -m l18.bench` |
| L18 验证 | `pnpm verify:l18`（56 项） | `uv run python -m l18.verify`（56 项） |
| L18x 后训练观察实验 | `pnpm reward` | `uv run python -m l18x.reward` |
| L18x 验证 | `pnpm verify:l18x`（51 项） | `uv run python -m l18x.verify`（51 项） |
| L19 Capstone 上线观察 | `pnpm ops` | `uv run python -m l19.ops` |
| L19 验证 | `pnpm verify:l19`（51 项） | `uv run python -m l19.verify`（51 项） |
| L19x TS 框架默认值观察 | `pnpm eco19` | `uv run python -m l19x.ecosystem` |
| L19x 验证 | `pnpm verify:l19x`（42 项） | `uv run python -m l19x.verify`（42 项） |
| L21 知识地图观察 | `pnpm map` | `uv run python -m l21.map` |
| L21 验证 | `pnpm verify:l21`（19 项） | `uv run python -m l21.verify`（19 项） |

L11x 是唯一**以 Python 为主通道**的一节——它的目的是看懂生态里的 Python 代码，所以 TS 那边只有三个 TODO，少的那一件（DSPy 式的 few-shot 编译）在 JS 生态里根本不存在，理由见讲义第八节。

参考实现：TS 加 `:sol` 后缀（`pnpm hello:sol`），Python 在模块路径里插 `solutions`（`uv run python -m l00.solutions.hello`）。L02 之后的参考实现都在 `shared/` 里，`verify` 脚本可以直接测它们：

```bash
VERIFY_TARGET=shared pnpm verify:l06                  # 先确认测试本身是对的
VERIFY_TARGET=shared uv run python -m l06.verify
KB_IMPL=shared pnpm verify:l09x                       # L09x 用的是这个
SKILLS_IMPL=shared pnpm verify:l10x                   # L10x 用的是这个（L10 本身还是 VERIFY_TARGET）
MULTI_IMPL=shared pnpm verify:l11                     # L11 用的是这个变量名
ECO_IMPL=shared uv run python -m l11x.verify          # L11x 用的是这个
EVAL_IMPL=shared pnpm verify:l12                      # L12 用的是这个
EVAL_IMPL=shared uv run python -m l12.verify
OBS_IMPL=shared pnpm verify:l13                       # L13 用的是这个
OBS_IMPL=shared uv run python -m l13.verify
GUARD_IMPL=shared pnpm verify:l14                     # L14 用的是这个
GUARD_IMPL=shared uv run python -m l14.verify
BROWSE_IMPL=shared pnpm verify:l14x                   # L14x 用的是这个
BUDGET_IMPL=shared pnpm verify:l15                    # L15 用的是这个
BUDGET_IMPL=shared uv run python -m l15.verify
WIRE_IMPL=shared pnpm verify:l16                      # L16 用的是这个
WIRE_IMPL=shared uv run python -m l16.verify
GENUI_IMPL=shared pnpm verify:l16x                    # L16x 用的是这个
VOICE_IMPL=shared pnpm verify:l16y                    # L16y 用的是这个
CODING_IMPL=shared pnpm verify:l17                    # L17 用的是这个
CODING_IMPL=shared uv run python -m l17.verify
BENCH_IMPL=shared pnpm verify:l18                     # L18 用的是这个
BENCH_IMPL=shared uv run python -m l18.verify
REWARD_IMPL=shared pnpm verify:l18x                   # L18x 用的是这个
OPS_IMPL=shared pnpm verify:l19                       # L19 用的是这个
OPS_IMPL=shared uv run python -m l19.verify
ECO19_IMPL=shared pnpm verify:l19x                    # L19x 用的是这个（L11x 是 ECO_IMPL）
MAP_IMPL=shared pnpm verify:l21                       # L21 用的是这个
MAP_IMPL=shared uv run python -m l21.verify
```

L15 的 TS 侧比 Python 多一项（96 对 95）。多的那一条测 `canonicalJson` 跳过值为 `undefined` 的键——Python 没有 `undefined`，一个键要么在要么不在，所以那边无从可测。

L16 是唯一**只有一侧有交付物**的一节：界面是 React，镜像一份 Python 的 React 没有意义。但分帧、撤回、参数累积、事件归位这四件事和语言无关（它们是协议和状态机），所以那一层两边都有，136 项断言两边一致。

而这个分界是有编译期保障的：`labs/tsconfig.json` 把 `l16/ui` 排除掉了，`l16/ui` 有自己一份带 DOM 类型的 tsconfig。这保证 `shared/wire.ts` 里一行 DOM API 都用不上——也就保证了它能在 Node 侧的转发器里复用、能被 Python 逐字节镜像。

卡住的时候这一步很有用：如果 `shared` 也不过，那是测试的问题不是你的问题。

Python 必须用 `python -m` 而不是 `python l00/hello.py`。后者会把 `sys.path[0]` 设成 `l00/`，`import shared` 就找不到了。

## 练习清单

**L00 · 三个练习**

| 练习 | 学什么 |
|---|---|
| `hello` | 第一个请求、内容块数组、system prompt 对输出长度的影响 |
| `stream` | 流式输出、TTFT 与总时长的区别 |
| `resilient` | 超时、重试退避、并发闸门 |

`verify` 会跑一套不调 API 的测试，检验 `shared/resilience.*` 里那三个函数写对没有。改动那两个文件之后都该跑一次。Python 版比 TS 版多两条测试（标 ☆），测的是 Python 特有的取消语义。

**L01 · 三个实验**

| 练习 | 学什么 |
|---|---|
| `tokens` | 用差分法把 token 数测出来，看不同文本的 token 效率 |
| `sampling` | temperature 到底在调什么，以及它有多「确定」 |
| `conversation` | 多轮对话的 token 累积与成本曲线，无状态的代价 |

三个加起来大约几分钱。**跑之前先估一下会花多少，跑完对一下**——这个习惯从 L01 开始养。

**L02 起：三个练习加一套验证**

从 L02 开始每节的结构固定下来：两三个练习加一个 `verify`。练习里带 `TODO`，`verify` 是一套不调 API 的测试，用来检验你写的和参考实现行为一致。

| 节 | 练习 | 学什么 |
|---|---|---|
| L02 | `anatomy` `ledger` `reader` | Messages API 全解、成本账本、流式读取器 |
| L03 | `prompt` `variance` `structured` | prompt 模板与校验、输出方差、结构化解析 |
| L04 | `schema` `toolbox` `roundtrip` | 工具 schema、沙箱、工具执行的完整往返 |
| L05 | `loop` `agent` `chaos` | 手写 agent loop、五个终止条件、故障注入 |
| L05x | `attention` `decode` | attention 与 KV cache、采样全流程（深度选修） |
| L06 | `budget` `compress` `longrun` | 上下文计量与分区、压缩策略、四种策略的量化对比 |
| L07 | `patterns` `compare` | 五种编排模式与防线、workflow/agent 的成本方差 |
| L08 | `session` `memory` `resume` | 事件日志与恢复、长期记忆的四道闸、崩溃四场景 |
| L09 | `retrieve` `agentic` | 分块、双路检索与 RRF、重排与装配、一次性/多轮的成本对照 |
| L11 | `orchestrate` `compare` | 任务书体检、重复劳动、写冲突、四道闸、扇出倍数拆解 |
| L10 | `server` `client` | NDJSON 拆帧、每请求元数据、两种错误通道、id 匹配、上下文税 |

带 `verify` 的节里，参考实现在 `shared/` 下。**卡住的时候先跑一次 `VERIFY_TARGET=shared`**：如果连参考实现都不过，那是测试的问题，不是你的问题。

每个文件里的 `TODO` 标出了你要写的部分，注释里有足够的提示但没有答案。Python 脚手架不重复 TS 那份的任务说明，只标 Python 特有的坑，所以两边都做的话先读 `.ts`。

**先自己写。卡住十分钟以上再看 solutions——那十分钟才是学习真正发生的地方。**

## 目录约定

```
shared/               跨课复用的东西，不用你写
  config.ts / .py       provider、模型 ID、价格表
  resilience.ts / .py   withTimeout / withRetry / pooled（L00 你写的，后面一直在用）
  models.ts / .py       查当前可用的模型 ID
  ledger.ts / .py       成本账本（L02）
  message.ts / .py      内容块与消息序列的处理（L02）
  stream.ts / .py       流式事件的累积与读取（L02）
  prompt.ts / .py       prompt 模板与渲染校验（L03）
  parse.ts / .py        从"脏"输出里抠出结构化数据（L03）
  tools.ts / .py        工具定义、参数校验、执行（L04）
  toolbox.ts / .py      一组可用的具体工具（L04）
  sandbox.ts / .py      路径沙箱（L04）
  fake.ts / .py         脚本化的假模型，测 loop 用（L05）
  agent.ts / .py        agent loop 与五个终止条件（L05）
  attention.ts / .py    attention 与 KV cache（L05x）
  decode.ts / .py       温度、top-k、top-p、采样（L05x）
  context.ts            上下文计量、分区、预算（L06）
  context_budget.py       ↑ 的 Python 版。名字不叫 context 是为了避开
                          标准库 contextlib 附近的裸名字冲突
  compress.ts / .py     结构化摘要、滑动窗口、该不该压（L06）
  patterns.ts / .py     五种编排模式与选型判据（L07）
  store.ts / .py        事件日志、派生状态、快照、恢复计划（L08）
  memory.ts / .py       长期记忆与防污染的四道闸（L08）
  retrieval.ts / .py    分块、双路检索、RRF、重排、装配、引用校验（L09）
  kb.ts / .py           标题与表格解析、ANN 内过滤、外部 rerank 顺序、版本消解、
                        墓碑同步、答案缓存键（L09x）
  mcpauth.ts / .py      远程 MCP 授权：token 校验、WWW-Authenticate、发现、
                        step-up、禁止透传（L10）
  skills.ts / .py       SKILL.md 解析、同名合并、目录预算、资源解析、脚本审批（L10x）
  multi.ts / .py        多 agent：任务书体检、重复劳动、写冲突、四道闸、成本会计（L11）
  pyecosystem.py / .ts  schema 解引用、结构化并发、reducer 状态图、few-shot 编译（L11x）
                        唯一一个 .py 是主、.ts 是对照的模块
  evals.ts / .py        分层抽样、判据路由、kappa、judge 五步体检、bootstrap、
                        回归明细、腐化检测、多重比较（L12）
  observe.ts / .py      OTel 属性名去重、两家相反的 token 语义、缓存倍率计价、
                        二次方增长与内容寻址、按字节分批、head/tail 采样、
                        span 树、录放机与分叉检测、失败分类（L13）
  guard.ts / .py        来源标记与传播、按参数角色的能力契约、致命三要素与
                        Rule of Two、通道审计、替换感知熔断器、审批门（PDP）、
                        工具指纹钉定、路径与出口沙箱、两轴指标（L14）
  browse.ts / .py       快照可见性与名字、ref 生命周期与 drift、坐标约定、
                        五层可见性、图片 token、逐跳白名单（L14x）
  budget.ts / .py       规范 JSON、前缀分叉点、缓存判定与模拟、计价、限速器、路由结果（L15）
  wire.ts / .py         SSE 解析、拆帧、撤回、参数累积、事件归位、外链审计（L16）
  genui.ts / .py        宿主桥三道闸、出站时序、postMessage、CSP 与 allow、
                        原子 JSON Patch、A2UI 组件树校验（L16x）
  voice.ts / .py        VAD 滞回、端点、播放账本、打断判定、中英文分句、填充语（L16y）
  coding.ts / .py       可判定的编辑、计划校验、测试输出解析、停止判定、工作区路径（L17）
  codingEval.ts         任务集校验、四种成功率、成本曲线、消融、回归门禁（L18）
  coding_eval.py          ↑ 的 Python 版（模块名按 Python 习惯用下划线）
  reward.ts / .py       奖励、组内优势、按 pass@k 筛题、SFT / DPO 造数据（L18x）
  ops.ts / .py          作业状态机、幂等、重试、准入、公平调度、审批记忆（L19）
  tsecosystem.ts / .py  停止原因、错误出口与脱敏、审批只消费一次、MCP 结果映射、
                        以服务端为准重建历史、Dify DSL → 代码计划（L19x）
  knowledge.ts / .py    知识地图：校验、影响面、过期、来源权重、补课路径（L21）
  mcp.ts / .py          MCP 协议层：拆帧、校验、路由、stdio 传输、客户端（L10）
  entry.ts              判断模块是不是入口，避免 verify import 脚手架时误跑 demo
l00/ l01/ …           各节练习（含 TODO），.ts 和 .py 各一份
l0x/solutions/        L00 / L01 的参考实现，做完再看
```

**L09x · 七个 TODO，企业知识库进 `shared/kb`**

| 练习 | 学什么 |
|---|---|
| TODO 1 `headingLevel` ★ | 先 NFKC 再认编号，数字只认 `[0-9]`：TS 的 `\d` 不认全角「１」、Python 的认，两边会悄悄分叉 |
| TODO 2 `renderTableRows` ★★ | 每一行带完整列名（多级表头按列拼），切块之后数字才不会和列名分家；隐藏列不进文本 |
| TODO 3 `searchFiltered` ★★ | post / pre / iterative 三种过滤位置。不够 k 个时不许拿越权的凑数，迭代要有上限 |
| TODO 4 `rerankPipeline` ★ | 先 rerank 再过滤，返回的 ids 和反过来一模一样，测结果的测试全过——越权全文已经发给了外部 reranker |
| TODO 5 `resolveVersions` ★★ | 生效日、效力层级、特别规定一起裁。按 mtime 取最新会取到还没生效的新办法；「新的一般 vs 旧的特别」报冲突，不硬选 |
| TODO 6 `applySync` ★ | 四种删除模式。incremental 删不掉整篇删除的文档，full 在 loader 少拿一篇时误删；墓碑补上前者 |
| TODO 7 `cacheKey` ★ | 规范化 query + 去重排序的 principals + 语料版本。少一段，要么跨用户串答案，要么撤权后还命中旧答案 |

56 项两边一致，观察输出逐字节一致。

**L10 · 远程 MCP 授权：TODO 10–13 在 `l10/auth`，参考实现在 `shared/mcpauth`**

| 练习 | 学什么 |
|---|---|
| TODO 10 `checkAccessToken` ★★ | 资源服务器那三行：`aud` 精确匹配（不是子串）、先查过期再查 scope、401 和 403 分清楚 |
| TODO 11 `parseWwwAuthenticate` ★★ | 按 RFC 9110 解析。引号里的逗号和转义引号会让「按逗号切」把一个 challenge 切成两半 |
| TODO 12 `prmCandidates` `asMetadataCandidates` ★ | 发现阶段的候选 URL，按规范顺序 |
| TODO 13 `checkIssResponse` `stepUpScopes` `decideDownstreamAuth` ★ | `iss` 精确比较；step-up 是并集不是替换；收到的 token 不许转给下游 |

这四个 TODO 接在 L10 原有 verify 的后面（MA-1…15），所以 L10 的 verify 两边是 55 / 59 项：Python 多出来的 4 项是原有部分就有的。

**L10x · 七个 TODO，skills 进 `shared/skills`**

| 练习 | 学什么 |
|---|---|
| TODO 1 `splitFrontmatter` ★ | 去 BOM，CRLF 和孤立 CR 都归一；结束符是之后第一个恰好是 `---` 的整行 |
| TODO 2 `parseScalar` `blockScalar` ★★ | frontmatter 不是「随便用个 YAML 库」：只认一个子集、不做类型推断，plain 标量里的 `: ` 要报出来 |
| TODO 3 `cpLen` `validateName` ★ | 长度按码点算，不按 UTF-16；name 只收 ASCII 小写字母数字加单个连字符 |
| TODO 4 `resolveCollisions` ★★ | 四家的同名策略互相矛盾。胜出的是整条记录——按字段合并会让模型读到一份说明、加载另一份文件；每次遮蔽留一条 Shadow |
| TODO 5 `renderCatalog` ★★ | 三阶段预算，按码点算：先全放，再按码点轮转给 description 分预算，最后去掉全部 description |
| TODO 6 `resolveSkillResource` ★ | 资源路径用 `safePath` 解析到 skill 目录之内，不自己拼字符串 |
| TODO 7 `scriptApproval` ★★ | `allowed-tools` 是预批准，不是限制。危险模式即使被预批准也要问；目录哈希缺失或变了也要问 |

**L11x · 四个 TODO 在 Python，三个在 TS**

| 练习 | 学什么 |
|---|---|
| `ecosystem.py` TODO 1、2 | pydantic 的 `$ref` 为什么会让模型把参数当字符串填，以及解引用的四种情况（菱形、链式、环、兄弟键） |
| `ecosystem.py` TODO 3、4 | `add_messages` 为什么不是 `operator.add`；没声明 reducer 的字段在并发扇出时会静默丢结果 |
| `ecosystem.py` TODO 5 | 不写代码，跑一遍：恢复会把节点从头重跑，所以 `interrupt` 之前必须幂等 |
| `ecosystem.py` TODO 6、7 | 一个能跑的 `BootstrapFewShot`，以及为什么它的入场券是一个指标 |
| `ecosystem.ts` TODO 3 | 用 `AbortController` 拼出 Python `TaskGroup` 的语义——TS 里这件事是纪律不是 API |

Python 侧 39 项测试，TS 侧 25 项。差的那 14 项是 DSPy 那组和 asyncio 那组：前者在 JS 生态里没有等价物，后者在 TS 里换了名字。

**L12 · 八个 TODO，最后一个只有 Python 侧有**

| 练习 | 学什么 |
|---|---|
| TODO 1 `stratifiedSample` | 随机抽样会给你一个 90 分的废评测集；而返回值里 `gaps` 最重要——"某类失败一条样本都没有"不会以任何形式报错 |
| TODO 2 `routeCheck` | 七成判据用正则和结构检查就够。反向断言（"不能出现内部服务名"）写成正向会让含义正好反过来且测试全绿 |
| TODO 3、4 `agreement` ★ | 一个 `return "pass"` 的 judge 一致率能有 80%，而 kappa 恰好是 0。实测：raw 高估 33.8~41.3 个百分点，21 个模型无一例外 |
| TODO 5 `auditJudge` ★ | 五步体检，而**每一步只抓得住一种退化**。一个 kappa 1.0、重测 1.0 的 judge 可以是"永远选排在前面那个" |
| TODO 6 `bootstrapCI` | 150 条样本、80% 成功率，95% 区间宽 13 个百分点。"涨了 2%"什么都不意味着 |
| TODO 7 `compareRuns` ★ | 最重要的输出不是 delta，是 `fixed`/`broken` 两个列表。而判断顺序写错会让"换了一批 bug"这句话永远不出现 |
| TODO 8 `multiple_comparisons` | **只有 Python 侧有**：校正的实现在 statsmodels 里。看 7 个指标，至少一个假阳性的概率是 30% |
| `regress` | 把上面接成一道会让 CI 变红的门。五道闸，顺序是故意的：先查评测本身可不可信，再看跑分 |

第四组观察实验（`demo_judge_audit`）是全节最值得看的输出——三个 judge，每一个只被五步里的一步抓住。

**L13 · 八个 TODO，两边对称**

| 练习 | 学什么 |
|---|---|
| TODO 1 `coalesceAttrs` | 双发过渡期里 `SUM(旧键) + SUM(新键)` 让花费翻一倍，而**两个键各自的值都是对的** |
| TODO 2 `normalizeUsage` ★ | Anthropic 的 `input_tokens` 不含缓存、OpenAI 的含。照字段名映射少算 2001 倍，而同一段代码在 OpenAI 上完全正确 |
| TODO 3 `costOf` | 为什么"用 metrics 建成本看板"办不到：`gen_ai.token.type` 只有 `input`/`output`，1x 到 2x 全塌进一个桶 |
| TODO 4 `traceSize` `dedupeTrace` ★ | 存的是 k(k+1)/2 条，唯一的只有 k 条。50 轮写 160 MB，98% 是重复字节。而哈希前不规范化 JSON 会让去重率变 0 且不报错 |
| TODO 5 `batchByBytes` ★ | OTLP 的 4 MiB 是**不可重试**的，而 batch processor 按条数分批。一个胖 span 拖垮整批。`AttributeValueLengthLimit` 默认是 Infinity——那个 128 是**属性个数** |
| TODO 6 `headSample` `tailSample` `loopStats` | head 采样保留 10% 的失败，因为决定在运行前做。而 tail 采样的 `decision_wait` 默认 30 秒，`sampled_cache_size` 默认 0——**同一次运行会拿到两个矛盾决策** |
| TODO 7 `agentSpanTree` `sumUsage` | 五个 sampling-relevant 属性必须在**创建时**就有，晚了采样器看不到；三层包含关系，只对 input/output 求和 |
| TODO 8 `Recorder` `checkReplayability` `classifyFailure` ★ | 模型输出没法重放——你放的是录音不是计算。只有 hybrid 模式能答"如果那一步不一样会怎样"。而分类学只收程序能判的：TRAIL 里最好的模型 18.3%，agent 独有的失败 F1 = 0.00 |
| `postmortem` | 接成一份复盘报告，顺序是故意的：先判这份 trace 可不可信，再看它说了什么 |

第六组观察实验最值得看：一条写得完全正确的 tail 采样策略（"失败的留下、跑够 20 轮的留下"），在默认配置下**一条都留不下**。

**L14 · 八个 TODO，两边对称**

| 练习 | 学什么 |
|---|---|
| TODO 1 `makeFlow` ★ | 漏写一个 `combine` 上游，污染就**悄悄消失了**——不报错，只是结果变干净。严格模式还要处理"拿不可信值做条件判断"这条一 bit 的侧信道 |
| TODO 2 `checkCall` ★ | 判参数不判工具名。GitHub MCP 那次事故里三个工具全在白名单上、全程绿灯。而 `post_comment.body` 必须**接受**不可信来源——拦它就等于废掉这个工具 |
| TODO 3 `trifecta` | 两个都报：Willison 的三要素和 Meta 的 Rule of Two。差别在 [C]——`rm -rf` 零数据外流，触发后者不触发前者，而那正是编码 agent 每天在做的事 |
| TODO 4 `auditChannels` ★ | 先判"看得见吗"再判"加了什么防护"。写反了，一条你根本看不见的通道会被报成"已过滤"。八行历史记录里，五个"过滤"全被绕过（含 HMAC 签名的图片代理），三个"移除"全守住 |
| TODO 5 `circuitBreaker` ★ | 必须展开 `$()`、反引号、`<()` 再匹配，否则 `echo "$(rm -rf ~)"` 在你眼里是一条 echo。两个方向都要：替换可以藏**动作**，也可以藏**目标** |
| TODO 6 `makeGate` ★ | 五条性质，每一条都对应一个在售产品。审批者**看不见工具结果**（Claude Code 剥掉了）、任何失败都拒绝（Codex fail closed，Claude Code 的 subagent review 相反）、策略住在文件里而不是对话里 |
| TODO 7 `pinTools` `checkDrift` ★ | 哈希 `[name, description, inputSchema]`。只哈希 description 漏掉 24.8% 改 descriptor 的；只看现有工具漏掉新增的，而"约一半的描述变更落在新出现的 server 上" |
| TODO 8 `twoAxis` `claimIsComparable` ★ | 只报一个轴，就藏掉了 27.8 个百分点。三个判定档在 −15pp 分界——CaMeL 的 −7 和分类器的 −27.8 不能叫同一个名字。ASR 可比要六项缺一不可 |
| `gate` | 接成一道会让 CI 变红的门。四步顺序是故意的：**配置本身排在最前面**，因为一份漏了 DNS 和环境变量的配置，后面三步做得再漂亮都没有意义 |

第一组观察实验最值得看：GitHub MCP 那条攻击链的完整回放——三个工具**全部通过**工具名授权，攻击只在 `post_comment.repo` 和 `read_file.path` 这两个参数上被拦住。

而 `pnpm gate` 的最终判定刻意**不说**"安全"。它最好的输出是"在你测过的这些攻击上没有失败"——因为自适应攻击下，12 个已发表的防御里大多数 ASR >90%，而它们原本报的都是接近零。

**L14x · 七个 TODO，浏览器层进 `shared/browse`**

| 练习 | 学什么 |
|---|---|
| TODO 1 `isAriaVisible` ★ | 「对辅助技术可见」只看 display / visibility / hidden / aria-hidden，不看透明度和颜色；default 和 ai 两种快照模式规则不同 |
| TODO 2 `accessibleName` ★ | aria-label 整段替换可见文字：人眼看到 "Buy"，模型看到一整句指令 |
| TODO 3 `assignRef` ★★ | ref 计数器是文档级的，换文档才清空；只给收得到指针事件的元素 |
| TODO 4 `driftCheck` ★★ | 只比 role + name 不够：每行一个 "Delete" 的列表重排以后，同一个 ref 指向了另一行 |
| TODO 5 `toViewport` ★ | 五种坐标约定换成整数 CSS 视口坐标；视口外返回错误，不钳位——钳到边上等于点到另一个东西 |
| TODO 6 `visualVisibility` ★★ | 「存在」「有盒子」「点得到」是三个不同的「可见」；白字白底、`font-size:0` 在像素这一层不过 |
| TODO 7 `normalizeHost` `navigationAllowed` ★ | 白名单的两半：host 先规范化（`perplexity.ai.` 末尾那个点），重定向链的每一跳都查 |

52 项两边一致，观察输出逐字节一致：打印出来的数全是整数，四舍五入只用整数运算。

**L15 · 七个 TODO，两边对称**

| 练习 | 学什么 |
|---|---|
| TODO 1 `canonicalJson` ★ | 命中判定是逐 token 的密码学哈希，所以键序不稳就没有缓存。官方点名 Swift 和 Go 会随机化键序。要求比"排个序"多几条：分隔符不带空格（`json.dumps` 默认带）、非 ASCII 不转义（`json.dumps` 默认转）、数组**不**排序、拒绝浮点 |
| TODO 2 `firstDivergence` ★ | 只报最早的那一处，因为"改上游会连带下游"。两个坑：给 `tools` 末尾加一个工具**不是**良性追加（追加只在最后一层安全），`messages` 变短是截断而**不是**追加——而截断正是 L06 上下文压缩每次都在做的事 |
| TODO 3 `cacheVerdict` ★ | 五种端点、五个状态。`input_tokens` 在 Anthropic 只表示断点之后的部分，当成总输入会让你以为缓存比实际更有效。而兼容层的 `prompt_tokens_details` 官方写着 "Always empty"——那是 `UNDETERMINABLE`，不是 `MISS` |
| TODO 4 `simulateTurn` ★ | lookback 找的是"之前写过的条目"，不是"看起来稳定的内容"。官方三轮例子可以直接当规格：第三轮差一格没命中。写入**只**发生在断点上，更早的位置一条都不写 |
| TODO 5 `mixedTtlBill` | 官方的三点式公式，`A ≤ B ≤ C` 违反时要抛错而不是静默返回一个数 |
| TODO 6 `Limiter` ★ | token bucket 而不是固定窗口——官方提示 60 RPM 可能被实施为**每秒 1 个**。按固定窗口写的限速器会在每分钟开头突发 60 个然后吃一串 429，而它自己的计数器显示"没超" |
| TODO 7 `routeOutcome` ★ | 随机是基线（RouteLLM 的四个路由器在 GSM8K 上**全部比抛硬币差**）。重试要算钱，换模型要算缓存打断。决策粒度这个旋钮在"有共享前缀"和"没有"两种情况下**方向相反** |
| `audit` | 接成一份成本审计。它在有步骤走了兼容端点时**拒绝报出省钱比例**——偏悲观和偏乐观都是编 |

第二组观察实验最值得看：同样的内容、同样的请求数、同样的 token 数，只把 `cache_control` 从时间戳挪到稳定内容上，账从不开缓存的 **111.5% 变成 72.0%**。前一种连续五次 `WRITE_ONLY`——每次付 1.25 倍写入费，一次读都没拿到，而六次请求全部返回 200。

L15 的 verify **一次模型都不调**，而这不是为了省钱：这一节要测的东西恰好全是结构性的（哈希相等、整数算术、状态机）。反过来说更重要——真去调模型会让结论不可复现，时段和负载的方差大于你想测的效应。

**L16 · 七个 TODO，协议层两边对称**

| 练习 | 学什么 |
|---|---|
| TODO 1 `SseParser` ★ | 规范给的规则是**封闭的**，十条就是全部。最容易漏的三条：行结束符有三种且可混用；空的 `id:` 是**重置**而不是忽略；流末尾没有以空行收尾的事件要**直接丢弃**。另外别每取一行就 slice——那是二次方的，症状是"越到后面越卡"，很容易错怪到渲染上 |
| TODO 2 `findFrameEnd` ★ | 「空行」= 两个连续的行结束符，而行结束符有三种，所以它有**八种**可分辨的字节组合。`indexOf('\n\n')` 只认一种，而其中一种（`\r\n\n`）会**碰巧**通过——这种碰巧比全错更危险 |
| TODO 3 `applyChunk` ★★ | 这一节的中心论点。`reset-step` 删的是当前 step 的**全部** part（含工具槽位），而**没有** step 边界时删整条消息——那条最容易写漏。另外两条反直觉的：`abort`/`error` 是**终态**（否则用户按下停止后屏幕还在写字）；**未知 chunk 类型要静默忽略、不能抛错**（严格校验在流式协议里是 bug 不是美德，OpenAI 加个 `obfuscation` 字段挂过一批客户端） |
| TODO 4 `JsonAccumulator` ★★ | 四个状态而不是两态：`streaming` / `ready` / `invalid` / `truncated`。后两个的处理**方向相反**——一个回传给模型，一个根本不该让模型看见。而「能展示」和「能执行」是两件事：官方 SDK 每个 delta 都吐 snapshot 给你展示，但执行的唯一安全点是 stop。**审批卡在 `canExecute` 上** |
| TODO 5 `reassemble` ★★ | 并行工具调用的事件**会交错**，归位靠 `itemId` / `output_index`，排序靠全局 `seq`。一个按到达顺序追加的实现会把 B 的参数拼到 A 上，而这个 bug 在**只有一个工具调用时完全不可见**。另外：零 delta 的块不是工具调用，是**模型边界**——一条流可以由两个模型接力写完 |
| TODO 6 `checkResumable` ★ | 这个 TODO 的职责是**拦住**一个很自然的想法，所以它的断言里有几条是「断言你没有做某件事」。prefill / 续写在 Claude 4.6 及以后**直接返回 400**，恢复要改用一条 user 消息；thinking 块必须逐字节原样回传，而 400 最常见的起因是 `messages.map(...)` 里按 type 过滤把它们滤掉了 |
| TODO 7 `auditLinks` ★ | 三种形式都要抓（内联式、参考式、内联 HTML），判定用白名单，解析不出来的算违规。而 `//host/path` 这种协议相对 URL 的判断必须排在「以 `/` 开头就是站内路径」**之前**——整个函数里唯一一处顺序写错就变成安全漏洞的地方 |
| `pnpm ui` | 接成一个演示台。三个开关分别关掉"按协议撤回""外链白名单""按帧转发"，让你亲眼看错的那一半 |

第五组观察实验最值得看，因为它的结论**两个方向同时和直觉相反**：一个 2000 字符的回答在 8 秒内全部到达客户端，而 15 cps 的打字机要 133 秒才显示完——用户在**数据到手之后**白等 125 秒，DOM 更新 2000 次，而且这一档恰好落在 Tombaugh 1985 里阅读理解最差的位置。

收益那一侧必须如实说：查不到任何厂商的 A/B 数据表明流式输出改善满意度，也查不到「最优打字机速度」的一手来源。所以这一节不给 cps 数字，只给"慢速打字机的代价是可测的"。

L16 的 verify 也**一次模型都不调**，而这一节的理由比前几节更硬：它要测的几个分支在真实调用里**几乎撞不到**——服务端中途换模型、`max_tokens` 恰好切在参数中间、CDN 重新分帧、流跑到一半失败重试。真去调模型的话，这里最重要的那几条断言一条都跑不到。

**L16x · 六个 TODO，宿主侧进 `shared/genui`**

| 练习 | 学什么 |
|---|---|
| TODO 1 `routeAppRequest` ★ | 方法白名单、同 server、可见性三道闸放在同一个函数里。先判是不是数组：字符串 `"app"` 也有 `.includes("app")` |
| TODO 2 `acceptsMessage` `safeTargetOrigin` ★ | 身份看窗口引用，不只看 origin；`"null"` 进白名单等于谁都收；发给不透明源只能用 `"*"` |
| TODO 3 `checkSource` `buildCsp` ★ | 先解码再查分隔符；不声明也给限制性策略；`form-action`、`base-uri` 不回退到 `default-src` |
| TODO 4 `decodePointer` `jsonTypeEqual` `applyPatchAtomic` ★ | 对副本应用、整份回滚；先 `~1` 后 `~0`；test 先比类型；挡掉 `__proto__` |
| TODO 5 `validateTree` ★★ | 邻接表会成环、会多父；目录查找只认自有属性（`catalog.functions['toString']` 不是 undefined）；URL 属性只收字面量 |
| TODO 6 `scheduleOutbound` ★★ | initialized 之前一条都不发；tool-input 只一次且先于结果；审批前入参不进 View |

**L16y · 六个 TODO，语音层进 `shared/voice`**

| 练习 | 学什么 |
|---|---|
| TODO 1 `vadStep` ★ | 单帧尖峰不是开口，160ms 的换气不是说完；`speech_end` 的说完时刻是最后一个有声帧，不是判定时刻 |
| TODO 2 `commitTurn` ★★ | 语义模型只延长等待、不缩短到下限以下；等 final 转写再提交；复说就取消 |
| TODO 3 `normalizeTranscript` `speculationValid` ★ | 不能用 `\w` 去标点（TS 不认汉字，会把整句中文删光）；只比转写不够，还要比版本 |
| TODO 4 `MyPlaybackLedger` ★★ | 打断时截到已播放，不是已发送；带 epoch，打断后迟到的 TTS 块不能再播 |
| TODO 5 `splitStream` ★★ | 「标点后跟空白」在中文上永远不触发；`39.9` 和 `Dr.` 不是句末；阈值按语音单位，不按字符数 |
| TODO 6 `scheduleFillers` ★ | 连续空闲满 `delayMs` 才说填充语，不是工具开始后 `delayMs`；工具结束就不再触发 |

L16x 48 项、L16y 56 项，两边一致，观察输出逐字节一致。

**L17 · 六个 TODO，capstone 地基进 `shared/coding`**

| 练习 | 学什么 |
|---|---|
| TODO 1 `splitLines` ★ | 只认 `\r\n` / `\n` / `\r`。Python 的 `splitlines()` 还会在 8 个码点上切——这一节切的是文件内容，那会同时破坏「改对」和双语言一致 |
| TODO 2 `applyEdits` ★★ | 多处匹配 → `NOT_UNIQUE`（不是改第一处）；批量全有或全无；定位基于原文件。OpenAI 参考实现算了 fuzz 又扔掉，aider 显式非原子——两边都不是你要抄的默认值 |
| TODO 3 `validatePlan` ★ | 计划是 DAG，不是散文。必有 verify 步；每个 edit 的 target 必须被某个祖先 read 覆盖。plan 阶段工具列表里根本没有 `edit_file` |
| TODO 4 `parseTestOutput` ★ | 反向扫描 summary；截断 → `unparsed`；`isGreen` fail-closed。summary 行只出现一部分的那几十个字节是假绿高发区。先 `splitLines` 再逐行匹配：JS 的 `m` 标志和 Python 的 `re.M` 对「行首」的定义不同 |
| TODO 5 `canStop` ★★ | verify 必须在最后一次 edit 之后；比 baseline 的 collected/skipped；测试文件哈希未变。绿过一次又改了一刀，不能停 |
| TODO 6 `resolveInWorkspace` ★ | 不是 `startsWith(root)`——它会放行 `/repo/ws-evil/x`。deny 在规范化之后、大小写不敏感、对解析后的路径再查一遍；新建文件也要解析符号链接，环直接拒；高危文件要确认 |

实验一（同一编辑意图、五种表示法）和实验三（路径检查分层）最值得先看。参考实现在 `shared/coding.*`，L18/L19 会继续扩展它。

L17 的 verify **一次模型都不调**：测的是检测器和纯函数。真调模型的观察（模型会不会跳过验证、会不会在 `NOT_UNIQUE` 后扩大上下文）放 `l17/runner.ts`，不进 CI。

**L18 · 六个 TODO，评测层进 `shared/codingEval`**

| 练习 | 学什么 |
|---|---|
| TODO 1 `validateTaskSet` ★ | 缺 fail-to-pass / 缺分层 / 未钉 pin → gaps；主指标作废 |
| TODO 2 `classifyAttempt` ★ | resolved ≠ applied；改测试 = hacked |
| TODO 3 `rateSpectrum` ★★ | 四种成功率并排；海报默认按最宽口径理解 |
| TODO 4 `costCurve` ★ | 最贵桶常常是 hard 上空转。error 不进桶，末桶吃掉余数 |
| TODO 5 `ablationTable` ★ | 消融必须改决策；和主口径绑定 |
| TODO 6 `codingGate` ★★ | 先查任务集与 hack，再看成对 onlyA/onlyB |

实验一（四种成功率）和实验五（净值 0 仍拦截换 bug）最值得先看。参考实现复用 L12 的 `compareRuns` / `bootstrapCI`，消费 L17 的 `HackFinding`。bench 和 blocker 里的小数一律走 `fmtFixed` / `fmt_fixed`：Python 的格式化平局取偶，`toFixed` 平局远离零。

L18 的 verify 同样**一次模型都不调**：输入是已经落盘的 Attempt 记录。真跑模型落 Attempt 放 `l18/runner.ts`，不进 CI。

**L18x · 七个 TODO，奖励层进 `shared/reward`**

| 练习 | 学什么 |
|---|---|
| TODO 1 `rewardFromAttempt` ★ | error 返回 null 不是 0；warn 扣分要封顶，带 warn 的正确解不能掉到 applied_only 以下 |
| TODO 2 `groupAdvantages` ★ | 样本标准差，不是总体标准差；「全相同」用相等判，不用 `std === 0`——八个 0.9 的浮点均值不等于 0.9 |
| TODO 3 `signalProbability` `signalProbabilityFromCounts` ★ | pass@k 就是信号预算：一组 G 次全对或全错，就没有梯度 |
| TODO 4 `screenTasks` ★★ | 按预采样筛题：error 不计入 n，hacked 算不成功 |
| TODO 5 `tokenWeights` ★★ | 三种 loss 聚合的每 token 权重；grpo 下长的错误答案每 token 罚得更轻，这就是长度偏置 |
| TODO 6 `buildSftSet` ★★ | SFT 比奖励严：一条 warn 就丢；去重先于封顶；每题封顶 |
| TODO 7 `buildDpoPairs` ★★ | error 永不入对；「真修好」和「越改越长」在数据里相关，配对时要管长度 |

不训练、不调模型：输入是落盘的 Attempt，数学只用四则运算和 sqrt。51 项两边一致，观察输出逐字节一致。

**L19 · 六个 TODO，上线层进 `shared/ops`**

| 练习 | 学什么 |
|---|---|
| TODO 1 `applyTransition` ★★ | checkpoint.seq 递增；claim 递增 epoch，旧 epoch / 过期租约的写入被拒；deny 回到 running 而不是整单取消 |
| TODO 2 `checkIdempotency` ★ | execute / replay / conflict / reject |
| TODO 3 `shouldRetryEffect` ★ | unsafe 无 key 禁止自动重试；`429_RATE` 可退避，`429_SPEND` 和裸 `429` 不重试 |
| TODO 4 `admitJob` ★ | 并发 / 队列 / 日额度 |
| TODO 5 `fairNext` ★ | lastServed 轮转，不是纯 FIFO |
| TODO 6 `startJob` ★★ | drain + 配额 + idempotency 总判；跨租户的同一个 key 不得 replay 别人的作业 |

审批记忆（`recallApproval` / `scopeCovers`）和健康检查不是 TODO，但 verify 会测：`/repo` 覆盖 `/repo/a.ts`、不覆盖 `/repo-evil`；deny 优先于 allow；`errorRate` 的展示向零截断（`0.0625` → `0.062`），不用 `toFixed`。

**L19x · 六个 TODO，适配器进 `shared/tsecosystem`**

| 练习 | 学什么 |
|---|---|
| TODO 1 `courseStopReason` ★ | 七个入口的默认步数从 1 到无穷大；把 L05 的 `AgentRun.reason` 接到 `stopWhen` 上 |
| TODO 2 `redactSecrets` `courseToolError` ★★ | 工具抛错之后，三家把原始错误连同密钥回填给模型，一家整个抹掉；脱敏要全局替换，截断按码点 |
| TODO 3 `resumeOnce` ★ | 恢复两次就执行两次：审批键 `approval:<id>`，in-flight 时第二次恢复不再执行 |
| TODO 4 `mcpResultToText` ★ | `isError` 在路上丢了。只有缺省、`null` 和 `false` 算成功，`0` 也算失败；结构化内容和图片要映射成模型读得懂的文本 |
| TODO 5 `rebuildHistory` ★ | 下一轮历史以服务端日志为准，客户端发来的 UI 消息只用来对账 |
| TODO 6 `difyPlan` ★★ | 把 Dify DSL 当需求文档读：拓扑序在前不等于是上游，if-else 两个分支互相引用就是运行时的空值 |

这一节不装任何框架。框架的行为来自 `l19x/fixtures/ecosystem.json`，是调研在锁定版本上实测录下的结果，所以 verify 零模型、零网络。42 项两边一致，观察输出逐字节一致。

**L21 · 五个 TODO，知识地图进 `shared/knowledge`**

| 练习 | 学什么 |
|---|---|
| TODO 1 `validateGraph` ★ | 重复 id / 悬空边 |
| TODO 2 `blastRadius` ★ | 证据作废的影响面 |
| TODO 3 `findStale` ★ | 过期=该重读 |
| TODO 4 `sourceWeight` ★ | own_verify 抬升；twitter 封顶；先封顶再加成；舍入用 `floor(x + 0.5)`，不用 Python 的 `round()` |
| TODO 5 `shortestRequiresPath` ★ | 补课顺序 |

L20 无 lab（面试口述）。L19/L21 verify 同样零模型。

L02 之后的参考实现不放 `solutions/` 而是放 `shared/`——因为它们本身就是后面几节要复用的模块，而不是一次性的练习答案。

## 常见问题

**401 Unauthorized** —— 九成是 `authToken` / `auth_token` 和 `apiKey` / `api_key` 搞混了。Anthropic 官方端点用 `x-api-key` 头，DeepSeek 的兼容端点走标准的 `Authorization: Bearer`，SDK 里对应 `authToken`。`shared/config.*` 里已经处理好了，如果你自己建了 client 记得别写成 `apiKey`。

**model not found** —— 模型 ID 过期了。跑 `pnpm models` 或 `uv run python -m shared.models` 看当前可用的。

**（TS）脚本跑完了但进程不退出** —— `withTimeout` 里漏了 `clearTimeout`。未触发的定时器会吊住 Node 事件循环。Python 没有这个问题，`asyncio.timeout()` 退出上下文时自己会清。

**（TS）Cannot find module '../shared/config.ts'** —— 确认你是用 `pnpm hello` 这类脚本跑的，它们带了 `--env-file=.env`，直接 `tsx` 跑会缺环境变量。

**（Python）ModuleNotFoundError: No module named 'shared'** —— 用 `python -m l00.hello`，不要 `python l00/hello.py`。而且要在 `labs/` 目录下跑。

**（Python）ImportError: No module named 'httpx'** —— `anthropic` 依赖的是它自己 vendor 的 `httpx2`，`httpx` 不存在。要发裸 HTTP 请求就用标准库 `urllib`，见 `shared/models.py`。

**（Python）流式输出看起来是一次性吐出来的** —— `print(chunk, end="")` 少了 `flush=True`。输出攒在缓冲区里了，不是流式没生效。
