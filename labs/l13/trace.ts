/**
 * L13：agent 的可观测性。跑法：
 *
 *     cd labs && pnpm trace
 *     cd labs && OBS_IMPL=shared pnpm trace      # 看参考实现的输出
 *     cd labs && pnpm verify:l13
 *
 * ★ 这一节的核心论点：**你以为在建一份记录，其实在建三份互相冲突的东西。**
 *
 *   监控（metrics）  要便宜、要全量、要能报警  →  但它算不出成本（TODO 3）
 *   调试（trace）    要完整、要带内容          →  但它是二次方增长的（TODO 4）
 *   复现（cassette） 要确定性                  →  但模型本身不可复现（TODO 8）
 *
 * 把这三件事当成一件事做，是这一节里几乎所有故障的来源。
 *
 * 而这八个 TODO 的共同点和前面每一节一样：**它们全都不抛异常。**
 * 这一节更狠——它们会给你一条**看起来完整的 trace**。
 *
 *   TODO 1  属性名去重    —— 双发期把花费翻一倍，而两个数字各自都对
 *   TODO 2  token 会计    —— ★ 同一个字段名，两家相反的语义，差 2001 倍
 *   TODO 3  成本          —— 为什么"用 metrics 建成本看板"办不到
 *   TODO 4  二次方增长    —— ★ 50 轮写 160 MB，其中 98% 是重复的
 *   TODO 5  4 MiB 那道墙  —— ★ 专杀最有价值的 trace，且不可重试
 *   TODO 6  采样          —— head 采样在 agent 上是结构性错误
 *   TODO 7  span 形状     —— 规范不替你决定，而它自己说了
 *   TODO 8  复现与归因    —— ★ 你复现的不是计算，是一份录音
 */

import { isMain } from '../shared/entry.ts'
import * as shared from '../shared/observe.ts'
import type {
  BatchReport,
  CoalesceReport,
  CostBreakdown,
  DedupedTrace,
  FailureVerdict,
  LoopStats,
  Message,
  Price,
  Provider,
  RawUsage,
  ReplayabilityReport,
  Run,
  SampleOutcome,
  Span,
  TailOutcome,
  TailPolicy,
  TraceSize,
  Usage,
} from '../shared/observe.ts'
import { ATTR, PRICES } from '../shared/observe.ts'

const IMPL = process.env.OBS_IMPL === 'shared' ? 'shared' : 'mine'

// ─────────────────────────────────────────────────────────────
// TODO 1：双发期的属性名去重
//
// OTel 的 GenAI 约定一直在改名。而**改名的症状不是报错，是看板查到 0 条**——
// span 正常创建、exporter 返回成功、collector 吞吐健康。
// ★ 这和"系统很安静"长得一模一样。
//
// 于是框架在过渡期会**双发**：把同一个值同时写到新旧两个键上。
// 而一个写成 `SUM(prompt_tokens) + SUM(input_tokens)` 的看板会把
// 你的报告花费**翻一倍**——注意，两个数字各自都是对的。
//
// 要求：
//   · 把旧键折到新键上，**取一个，绝不相加**
//   · 报出"两个键的值不一样"这种情况 —— 那意味着两条埋点路径在测
//     不同的东西，这时候无论取哪个都是错的
//
// 参考 shared/observe.ts 里的 RENAMES。
// ─────────────────────────────────────────────────────────────

export function coalesceAttrs(raw: Record<string, unknown>): CoalesceReport {
  if (IMPL === 'shared') return shared.coalesceAttrs(raw)
  // TODO: 实现我
  return { attrs: raw, dualEmit: [], conflicts: [] }
}

// ─────────────────────────────────────────────────────────────
// TODO 2：token 会计
//
// ★ 这是整节课最容易错一个数量级的地方，而原因只有一句话：
//   **Anthropic 和 OpenAI 的 `input_tokens` 语义正好相反。**
//
//   Anthropic：input_tokens **不含**缓存
//              总输入 = input_tokens + cache_read + cache_creation
//   OpenAI：   input_tokens **已含**缓存
//              普通输入 = input_tokens − cached − cache_write
//
// 字段名一样，含义相反。照着字段名做的映射在 Anthropic 上会把
// 100,050 记成 50 —— **少算 2001 倍**。
//
// 还有两个坑：
//   · 顶层的 cache_creation_input_tokens 是 5 分钟档（1.25x）和
//     1 小时档（2x）**之和**，只读它算不出钱
//   · reasoning **已经包含在** output_tokens 里，不要再加
//
// 归一到的口径是 OTel 的口径：inputTokens 是**全量总和**。
// ─────────────────────────────────────────────────────────────

export function normalizeUsage(provider: Provider, raw: RawUsage): Usage {
  if (IMPL === 'shared') return shared.normalizeUsage(provider, raw)
  // TODO: 实现我
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    freshInput: raw.input_tokens ?? 0,
    problems: [],
  }
}

// ─────────────────────────────────────────────────────────────
// TODO 3：成本
//
// 这个函数存在的理由是要**推翻一条广为流传的建议**：
// "metric 的表面比 span 小、比 span 稳，所以成本看板建在
//  gen_ai.client.token.usage 上、按 gen_ai.token.type 拆。"
//
// ★ 它在开了 prompt caching 的系统上**做不到**，而理由在一个枚举里：
//   `gen_ai.token.type` 只有**两个**取值，`input` 和 `output`。
//   没有 cache 维度，没有 reasoning 维度。
//
// 于是缓存读（0.1x，两个模型上 0.025x）、5 分钟写（1.25x）、
// 1 小时写（2x）、普通输入（1x）**全塌进 token.type=input 这一个桶**。
//
// 要求：算出分项，并且算一个 naiveTotal（所有输入按普通价）
// 用来量化"从 metric 算"会错多少。
// ─────────────────────────────────────────────────────────────

export function costOf(u: Usage, price: Price): CostBreakdown {
  if (IMPL === 'shared') return shared.costOf(u, price)
  // TODO: 实现我
  return { total: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, naiveTotal: 0, spread: 1 }
}

// ─────────────────────────────────────────────────────────────
// TODO 4：trace 的二次方增长
//
// ★ 一个 k 轮的 agent 运行，朴素记录会存多少？
//
// agent 就是 LLM 调用放在循环里。每一步往 message 数组追加，
// 而**整个数组会作为下一次调用的输入再发一遍**。平台记录每次
// 调用的输入。于是：
//
//     存了 1 + 2 + … + k = k(k+1)/2 条，其中只有 k 条不重复
//
//     10 轮 → 55 条 / 10 唯一      30 轮 → 465 / 30     50 轮 → 1275 / 50
//
// **运行长度翻倍，存储量翻四倍。**
//
// 单 span 的上限也能推：数组必须塞进上下文窗口，多数框架在 80%
// 处压缩，所以 1M token 下一个 LLM span 的输入上限 ≈ **3.2 MB JSON**。
// 一次逼近上限的 50 轮运行写 **~160 MB**，其中 **~98% 是重复字节**。
//
// 两个函数：traceSize 量化问题，dedupeTrace 修它（内容寻址）。
// ★ 注意 dedupeTrace 里哈希前必须**规范化 JSON**（键排序），
// 否则键序不同的同一条消息会算成两条，去重率变成 0 而且不报错。
// ─────────────────────────────────────────────────────────────

export function traceSize(messages: Message[], turns: number): TraceSize {
  if (IMPL === 'shared') return shared.traceSize(messages, turns)
  // TODO: 实现我
  return {
    turns,
    storedMessages: 0,
    uniqueMessages: 0,
    storedBytes: 0,
    dedupedBytes: 0,
    ratio: 1,
  }
}

export function dedupeTrace(turnsOfMessages: Message[][]): DedupedTrace {
  if (IMPL === 'shared') return shared.dedupeTrace(turnsOfMessages)
  // TODO: 实现我
  return { blobs: {}, turns: [], savedBytes: 0 }
}

// ─────────────────────────────────────────────────────────────
// TODO 5：4 MiB 那道墙
//
// ★ 一条很坏的三段组合：
//
// 1. OTLP 规范：服务端默认接收上限 **4 MiB**，超限时 gRPC 服务端
//    **MUST** 返回 RESOURCE_EXHAUSTED，而它是**不可重试**的。
// 2. 一个 LLM span 的输入可以合法地达到 ~3.2 MB（TODO 4）。
// 3. ★ 而 OTel 的 batch processor **按条数分批，不按字节**。
//    send_batch_max_size 数的是 span 个数，没有字节上限。
//
// 组合起来：一个胖 span 和几个普通 span 打成一批，超过 4 MiB，
// **整批被当成不可重试错误丢掉**——连带那几个毫不相关的 span。
//
// ★ 而 SDK 那一层不会救你。`AttributeValueLengthLimit` 的默认值是
// **Infinity**。那条到处流传的"OTel 默认在 128 字符处截断"是把
// **数量**限制看成了**长度**限制——AttributeCountLimit 默认 128，
// 那是每条记录最多几个**属性**。
//
// ★ 最坏的部分：被杀掉的总是最有价值的 trace。最胖的 span 来自
// 最长、最复杂、最该被看的那次运行。
//
// 要求：按字节分批；单条就超限的要单独报出来（分批救不了它，
// 内容必须外部化）。
// ─────────────────────────────────────────────────────────────

export function batchByBytes(spans: Span[], limit?: number, headroom?: number): BatchReport {
  if (IMPL === 'shared') return shared.batchByBytes(spans, limit, headroom)
  // TODO: 实现我
  return { batches: [{ spans, bytes: 0 }], oversized: [], problems: [] }
}

// ─────────────────────────────────────────────────────────────
// TODO 6：采样
//
// ★ head 采样在 agent 上失败**不是因为不精确，是因为信息顺序**：
// 做决定的那一刻，这次运行还没跑。它不可能知道这一次将会失败、
// 将会跑 40 轮、或者将会烧穿预算。
//
// 于是 10% 的采样率保留 10% 的成功，**也保留 10% 的失败**。
// 推论：**你的调试语料不只是生产的一个小样本，它是有偏的，
// 而且偏的方向正好是错的。**
//
// 而 tail 采样有三个 agent 专属缺陷，全部来自默认值：
//   decision_wait       默认 30s   → 4 分钟的运行会在只看到局部时被判掉
//   num_traces          默认 5 万  → 环形缓冲淘汰**最老的**，
//                                    而长 agent trace 永远是最老的
//   sampled_cache_size  默认 **0** → 缓存不启用，于是同一次运行可以
//                                    拿到**两个互相矛盾的采样决策**
//
// ★ 最后一条的症状：你打开一条**看起来完整、只是有点短**的 trace。
//
// loopStats 是这一节的出路：invoke_agent.inference_calls 和
// .tool_calls 是 **Histogram**，所以 **p99 的 loop 长度可以在
// 不存任何一条 trace 的前提下报警**。
// ─────────────────────────────────────────────────────────────

export function headSample(runs: Run[], rate: number): SampleOutcome {
  if (IMPL === 'shared') return shared.headSample(runs, rate)
  // TODO: 实现我
  return { kept: [], failureRecall: 0, failureShare: 0, note: '' }
}

export function tailSample(runs: Run[], policy: TailPolicy): TailOutcome {
  if (IMPL === 'shared') return shared.tailSample(runs, policy)
  // TODO: 实现我
  return {
    kept: [],
    failureRecall: 0,
    failureShare: 0,
    note: '',
    droppedTooEarly: [],
    decidedOnPartial: [],
    contradictory: [],
    problems: [],
  }
}

export function loopStats(runs: Run[], runawayAt: number): LoopStats {
  if (IMPL === 'shared') return shared.loopStats(runs, runawayAt)
  // TODO: 实现我
  return { p50: 0, p90: 0, p99: 0, max: 0, runaway: [], note: '' }
}

// ─────────────────────────────────────────────────────────────
// TODO 7：span 的形状，和不重复计算的求和
//
// ★ 关于 agent trace 的层级，规范**没有规范性指引，而且它自己说了**：
//
//   "The relationship between below spans depends on how user
//    application code is written. They are likely to be **siblings**
//    if there is an encompassing span."
//
// 所以预期形状是**一个总 span 下面一排兄弟**，不是嵌套链。
// 跨轮次关联靠 gen_ai.conversation.id，**不靠父子关系**。
//
// 两个必须做对的细节：
//   · sampling-relevant 的五个属性（operation.name / provider.name /
//     request.model / server.address / server.port）**必须在 span
//     创建时就存在**。等到结束前再补，tail 采样器看不到它们，
//     ★ 而你的采样策略会静默地不再区分任何东西。
//   · v1.41.0 起 internal 的 invoke_agent **不带 token usage**——
//     正是为了让"按 span 求和"不重复计算。
//
// sumUsage 要处理三层包含关系：
//   input_tokens ⊇ cache_read + cache_write
//   output_tokens ⊇ reasoning
//   {modality}.cache_read ⊆ cache_read **且** ⊆ {modality}.input
// 规则：**只对 input/output 求和，其余是明细，用来算钱不用来求总量。**
// ─────────────────────────────────────────────────────────────

export function agentSpanTree(opts: {
  agent: string
  conversationId: string
  model: string
  provider: Provider
  steps: { kind: 'chat' | 'execute_tool'; name?: string; usage?: Usage }[]
}): Span[] {
  if (IMPL === 'shared') return shared.agentSpanTree(opts)
  // TODO: 实现我
  return []
}

export function sumUsage(spans: Span[]): { input: number; output: number; problems: string[] } {
  if (IMPL === 'shared') return shared.sumUsage(spans)
  // TODO: 实现我
  return { input: 0, output: 0, problems: [] }
}

// ─────────────────────────────────────────────────────────────
// TODO 8：复现与归因
//
// ★ 先说清一件被营销语言盖住的事：**模型的输出没法重放。**
//
// temperature 0 下同一个请求的输出取决于**别人的负载**——
// 服务器负载决定 batch size，而 kernel 不是 batch-invariant 的。
// 所以所有声称 "deterministic replay" 的工具做的都是
// **把模型输出缓存下来当 oracle 再发一遍**，不是重新执行模型。
//
// 你重放的是一份**录音**，不是一次**计算**。这决定了它能答什么：
//   能答："当时到底发生了什么"（但 trace 也能告诉你）
//   不能答："换个模型会怎样"（那是两个不同的 prompt）
//   ★ 只有 hybrid 能答："如果当时那个工具返回的是别的，会怎样"
//     —— 而这才是事故当下你真正想问的问题
//
// checkReplayability 要检查六件事，每一件都不抛异常。
// 最狠的两件：
//   · OTel 的四个内容属性全是 `opt_in`、**默认不发**。一个"合规的"
//     埋点产出的 trace，在你主动打开内容采集之前对重放毫无用处。
//   · 用了 previous_response_id 的话，上下文在提供方的服务端。
//     你的 trace 里只有一个指向你不拥有、且会过期的状态的**指针**。
//
// classifyFailure 的取舍是这一节最实用的判断：
// **能被程序判定的分类，才值得进你的分类学。**
// 理由是 TRAIL 那个基准——把 trace 交给模型去定位错误，
// 最好的模型联合准确率 **18.3%（GAIA）/ 5.0%（SWE-Bench）**，
// 而 **Context Handling Failures 几乎所有模型 F1 = 0.00**。
// ★ agent 独有的那些失败，恰恰是 LLM judge 看不见的。
// ─────────────────────────────────────────────────────────────

export function checkReplayability(spans: Span[]): ReplayabilityReport {
  if (IMPL === 'shared') return shared.checkReplayability(spans)
  // TODO: 实现我
  return { replayable: true, blockers: [], warnings: [] }
}

export function classifyFailure(
  spans: Span[],
  run: { ok: boolean; turns: number },
): FailureVerdict[] {
  if (IMPL === 'shared') return shared.classifyFailure(spans, run)
  // TODO: 实现我
  return []
}

// ═════════════════════════════════════════════════════════════
// 观察实验
// ═════════════════════════════════════════════════════════════

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

function demoCoalesce() {
  console.log(bold('\n一、双发：两个数字各自都对，加起来错一倍'))

  // 一个处在兼容过渡期的框架发出来的属性集
  const raw = {
    'gen_ai.usage.prompt_tokens': 1200,
    'gen_ai.usage.input_tokens': 1200,
    'gen_ai.usage.completion_tokens': 300,
    'gen_ai.usage.output_tokens': 300,
    'gen_ai.system': 'anthropic',
    'gen_ai.provider.name': 'anthropic',
    'gen_ai.usage.cache_creation.input_tokens': 800,
    'gen_ai.usage.cache_write.input_tokens': 800,
  }

  // 一个 SUM(prompt_tokens) + SUM(input_tokens) 的看板会这么算
  const naive =
    Number(raw['gen_ai.usage.prompt_tokens']) + Number(raw['gen_ai.usage.input_tokens'])

  const r = coalesceAttrs(raw)
  const clean = Number(r.attrs[ATTR.inputTokens] ?? 0)

  console.log(`  埋点发出了 ${Object.keys(raw).length} 个属性，其中 ${r.dualEmit.length} 对是双发的`)
  for (const d of r.dualEmit) console.log(dim(`    ${d}`))
  console.log(`\n  一个 ${red('SUM(prompt_tokens) + SUM(input_tokens)')} 的看板会报：${red(String(naive))} 输入 token`)
  console.log(`  去重后的真实值：                                   ${green(String(clean))}`)
  console.log(
    yellow(`  ★ 差 ${(naive / Math.max(clean, 1)).toFixed(1)} 倍。而两个键各自的值都是对的——`) +
      yellow('这就是为什么没有任何一层会报错'),
  )
  console.log(dim('    修法：按优先级取一个，绝不相加。'))
}

function demoUsage() {
  console.log(bold('\n二、★ 同一个字段名，两家相反的语义'))

  // Anthropic：10 万 token 的系统 prompt 命中缓存，用户消息 50 token
  const anthropicRaw: RawUsage = {
    input_tokens: 50, // ★ 这个数字**不含**缓存
    output_tokens: 420,
    cache_read_input_tokens: 100_000,
    cache_creation_input_tokens: 0,
  }
  // OpenAI：同样的情形
  const openaiRaw: RawUsage = {
    input_tokens: 100_050, // ★ 这个数字**已含**缓存
    output_tokens: 420,
    input_tokens_details: { cached_tokens: 100_000 },
  }

  const a = normalizeUsage('anthropic', anthropicRaw)
  const o = normalizeUsage('openai', openaiRaw)

  console.log(dim('  两家都处理了 100,050 个输入 token（10 万缓存命中 + 50 新增）'))
  console.log()
  console.log('  提供方        原始 input_tokens    照字段名映射    归一后')
  console.log('  ' + '─'.repeat(62))
  console.log(
    `  Anthropic     ${String(anthropicRaw.input_tokens).padEnd(19)}${red(String(anthropicRaw.input_tokens).padEnd(15))} ${green(String(a.inputTokens))}`,
  )
  console.log(
    `  OpenAI        ${String(openaiRaw.input_tokens).padEnd(19)}${green(String(openaiRaw.input_tokens).padEnd(15))} ${green(String(o.inputTokens))}`,
  )
  console.log()
  console.log(
    yellow(`  ★ 一个照字段名做的映射在 Anthropic 上把 100,050 记成 50——少算 ${Math.round(a.inputTokens / (anthropicRaw.input_tokens ?? 1))} 倍。`),
  )
  console.log(dim('    而它在 OpenAI 上完全正确。同一段代码，一家对一家错。'))
  console.log()
  console.log(dim('    OTel 规范把这个不对称显式写进了提供方页的脚注：'))
  console.log(dim('      Anthropic 注 [27]：excludes cached tokens，MUST be added'))
  console.log(dim('      OpenAI   注 [24]：对应 cached_tokens，不加'))

  // 缓存写入的档位
  console.log(bold('\n  缓存写入：只读顶层字段算不出钱'))
  const noDetail = normalizeUsage('anthropic', {
    input_tokens: 10,
    output_tokens: 100,
    cache_creation_input_tokens: 40_000,
  })
  for (const p of noDetail.problems) console.log(red(`    ✗ ${p}`))
  const withDetail = normalizeUsage('anthropic', {
    input_tokens: 10,
    output_tokens: 100,
    cache_creation_input_tokens: 40_000,
    cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 30_000 },
  })
  const price = PRICES['claude-like']!
  const cEst = costOf(noDetail, price)
  const cReal = costOf(withDetail, price)
  console.log(
    `    按 5 分钟档估：$${cEst.total.toFixed(5)}    读了明细：$${cReal.total.toFixed(5)}` +
      yellow(
        `    低估 ${cReal.total ? (((cReal.total - cEst.total) / cReal.total) * 100).toFixed(0) : '0'}%`,
      ),
  )
}

function demoCost() {
  console.log(bold('\n三、为什么"用 metrics 建成本看板"办不到'))

  const u = normalizeUsage('anthropic', {
    input_tokens: 200,
    output_tokens: 800,
    cache_read_input_tokens: 180_000,
    cache_creation_input_tokens: 20_000,
    cache_creation: { ephemeral_5m_input_tokens: 4_000, ephemeral_1h_input_tokens: 16_000 },
  })
  const price = PRICES['claude-like']!
  const c = costOf(u, price)

  console.log(dim('  一次典型的长上下文 agent 调用：'))
  console.log(`    普通输入   ${String(u.freshInput).padStart(8)} tok  ×1      $${c.fresh.toFixed(6)}`)
  console.log(`    缓存读     ${String(u.cacheRead).padStart(8)} tok  ×0.1    $${c.cacheRead.toFixed(6)}`)
  console.log(`    5 分钟写   ${String(u.cacheWrite5m).padStart(8)} tok  ×1.25   $${(((u.cacheWrite5m / 1e6) * price.inputPerM) * 1.25).toFixed(6)}`)
  console.log(`    1 小时写   ${String(u.cacheWrite1h).padStart(8)} tok  ×2      $${(((u.cacheWrite1h / 1e6) * price.inputPerM) * 2).toFixed(6)}`)
  console.log(`    输出       ${String(u.outputTokens).padStart(8)} tok          $${c.output.toFixed(6)}`)
  console.log('  ' + '─'.repeat(52))
  console.log(`    ${green('从 span 算')}                            $${c.total.toFixed(6)}`)
  console.log(`    ${red('从 metric 算')}（所有 input 一个价）      $${c.naiveTotal.toFixed(6)}`)
  console.log(
    yellow(
      `\n  ★ 高估 ${c.total ? ((c.naiveTotal / c.total - 1) * 100).toFixed(0) : '0'}%。而这不是精度问题，是**维度缺失**：`,
    ),
  )
  console.log(dim('    gen_ai.token.type 只有两个取值：input 和 output。'))
  console.log(dim('    gen_ai.client.token.usage 的全部属性里没有缓存维度。'))
  console.log(
    dim(`    于是 1x / 0.1x / 1.25x / 2x 全塌进 token.type=input 一个桶——跨度 ${c.spread} 倍。`),
  )
  console.log(green('\n    正确分工（和常见建议相反）：'))
  console.log(green('      metrics → 量、延迟、loop 长度 SLO'))
  console.log(green('      spans   → 成本'))
}

function demoQuadratic() {
  console.log(bold('\n四、★ trace 是二次方增长的'))

  // 50 条各不相同的消息，模拟一次 50 轮的运行
  const msgs: Message[] = [
    { role: 'system', content: 'S'.repeat(2000) },
    ...Array.from({ length: 49 }, (_, i) => ({
      role: i % 2 === 0 ? 'assistant' : 'tool',
      content: `第 ${i} 步：` + String.fromCharCode(97 + (i % 26)).repeat(600 + i * 7),
    })),
  ]

  console.log('  轮数    存了多少条    唯一    朴素字节     去重字节    倍数')
  console.log('  ' + '─'.repeat(62))
  for (const k of [10, 30, 50]) {
    const t = traceSize(msgs, k)
    console.log(
      `  ${String(k).padStart(3)}  ${String(t.storedMessages).padStart(11)}  ${String(t.uniqueMessages).padStart(6)}  ` +
        `${(t.storedBytes / 1024).toFixed(0).padStart(9)} KB  ${(t.dedupedBytes / 1024).toFixed(1).padStart(8)} KB  ` +
        `${t.ratio.toFixed(1).padStart(5)}x`,
    )
  }
  console.log(
    yellow('\n  ★ 存的条数是 k(k+1)/2，唯一的是 k。运行长度翻倍，存储量翻四倍。'),
  )
  console.log(dim('    上限也能推：数组必须塞进上下文窗口，多数框架在 80% 处压缩，'))
  console.log(dim('    所以 1M token 下单个 LLM span 的输入上限 ≈ 3.2 MB JSON。'))
  console.log(dim('    一次逼近上限的 50 轮运行写 ~160 MB，其中 ~98% 是同一批字节记了 50 遍。'))

  // 内容寻址修它：第 k 轮发送前 k 条，正是朴素记录的形状
  const turns: Message[][] = []
  for (let k = 1; k <= 50; k++) turns.push(msgs.slice(0, k))
  const d = dedupeTrace(turns)
  console.log(
    green(`\n  内容寻址去重：${Object.keys(d.blobs).length} 个 blob 覆盖 ${turns.length} 轮，省下 ${(d.savedBytes / 1024).toFixed(0)} KB`),
  )
  console.log(dim('    ★ 哈希前必须规范化 JSON（键排序）。键序不同的同一条消息会算成两条，'))
  console.log(dim('      去重率变成 0，而且不报错。'))
}

function demoWall() {
  console.log(bold('\n五、★ 4 MiB 那道墙，以及它为什么专杀最有价值的 trace'))

  // 一次长运行：两个胖 span（各 2.4 MB，都在上下文上限之内）+ 一堆普通 span
  const fat = (i: number): Span => ({
    name: `chat 长上下文#${i}`,
    spanId: `fat${i}`,
    parentId: 'root',
    kind: 'CLIENT',
    attrs: {
      [ATTR.operation]: 'chat',
      'gen_ai.input.messages': 'M'.repeat(2_400_000), // ★ 2.4 MB，完全合法
    },
  })
  const normal: Span[] = Array.from({ length: 40 }, (_, i) => ({
    name: `execute_tool t${i}`,
    spanId: `n${i}`,
    parentId: 'root',
    kind: 'INTERNAL' as const,
    attrs: { [ATTR.operation]: 'execute_tool', [ATTR.toolName]: `t${i}` },
  }))

  const all = [fat(1), ...normal.slice(0, 20), fat(2), ...normal.slice(20)]
  const totalBytes = all.reduce((s, x) => s + shared.spanBytes(x), 0)
  const totalMB = (totalBytes / 1024 / 1024).toFixed(2)

  console.log(dim(`  一批 ${all.length} 个 span，共 ${totalMB} MiB，其中两个是 2.4 MB 的 LLM span`))
  console.log(dim('  两个都在合法范围内（单 span 上限 ≈ 3.2 MB），单独发都没问题。'))
  console.log(red(`\n  按条数分批（send_batch_max_size=512，远大于 ${all.length}）：1 批，${totalMB} MiB`))
  console.log(red(`    → 超过 4 MiB → RESOURCE_EXHAUSTED → ${bold('不可重试')} → 整批丢掉`))
  console.log(red(`    → 连带那 ${normal.length} 个毫不相关的工具 span 一起消失`))

  const r = batchByBytes(all)
  console.log(green(`\n  按字节分批：${r.batches.length} 批`))
  for (const b of r.batches) {
    console.log(dim(`    ${String(b.spans.length).padStart(2)} 个 span，${(b.bytes / 1024 / 1024).toFixed(2)} MiB`))
  }
  for (const p of r.problems) console.log(yellow(`    ★ ${p}`))

  // 再看单条就超限的情况：分批救不了它
  const monster: Span = {
    name: 'chat 逼近上下文上限',
    spanId: 'mon',
    parentId: 'root',
    kind: 'CLIENT',
    attrs: { [ATTR.operation]: 'chat', 'gen_ai.input.messages': 'M'.repeat(3_900_000) },
  }
  const r2 = batchByBytes([monster, ...normal.slice(0, 5)])
  if (r2.oversized.length > 0) {
    console.log(red(`\n  而如果单个 span 就 3.9 MB：`))
    for (const p of r2.problems) console.log(red(`    ✗ ${p}`))
  }
  console.log(dim('\n    而 SDK 那一层不会救你：AttributeValueLengthLimit 默认 Infinity。'))
  console.log(dim('    到处流传的"默认 128 字符截断"是把**数量**限制看成了**长度**限制。'))
  console.log(
    yellow('    ★ 最坏的部分：最胖的 span 来自最长、最复杂、最该被看的那次运行。'),
  )
}

function demoSampling() {
  console.log(bold('\n六、采样：偏的方向正好是错的'))

  // 1000 次运行，5% 失败。失败的普遍更长、更贵。
  const runs: Run[] = Array.from({ length: 1000 }, (_, i) => {
    const bad = i % 20 === 0
    return {
      traceId: `t${i}`,
      ok: !bad,
      turns: bad ? 24 + (i % 17) : 3 + (i % 5),
      ms: bad ? 180_000 + (i % 7) * 20_000 : 8_000 + (i % 11) * 900,
      tokens: bad ? 400_000 + i * 37 : 30_000 + i * 11,
    }
  })
  const failures = runs.filter((r) => !r.ok).length

  const h = headSample(runs, 0.1)
  console.log(dim(`  1000 次运行，${failures} 次失败（${((failures / 1000) * 100).toFixed(0)}%）。失败的普遍更长更贵。`))
  console.log(`\n  head 采样 @10%：留下 ${h.kept.length} 条，其中失败 ${(h.failureShare * 100).toFixed(1)}%`)
  console.log(red(`    失败召回 ${(h.failureRecall * 100).toFixed(0)}%`) + dim(' —— 和成功的保留率一样'))
  console.log(yellow(`    ★ ${h.note.split('★ ')[1] ?? ''}`))
  console.log(
    dim('\n    推论：你的调试语料不只是生产的一个小样本，它是有偏的——'),
  )
  console.log(dim('    1% 采样率下，你会在留住一条罕见灾难轨迹之前，先留住中位数请求一百次。'))

  // tail 采样，用默认值
  const t = tailSample(runs.slice(0, 60), {
    decisionWaitMs: 30_000, // ★ 默认值
    numTraces: 50, // 缩小的默认值，让淘汰在这个规模下可见
    decisionCacheSize: 0, // ★ 默认值：不启用
    keep: (r) => !r.ok || r.turns >= 20,
  })
  console.log(bold('\n  tail 采样（全用默认值）：'))
  console.log(dim('    策略写的是「失败的留下，跑够 20 轮的留下」——正好瞄着我们要的那些。'))
  console.log(`    留下 ${t.kept.length} 条，失败召回 ${red((t.failureRecall * 100).toFixed(0) + '%')}`)
  console.log(
    yellow('    ★ 一条都没留下。因为失败的运行要跑 3 分钟，而 decision_wait 在第 30 秒'),
  )
  console.log(yellow('      就替它做了决定——那一刻它还没失败，也还没跑到 20 轮。'))
  for (const p of t.problems) console.log(red(`    ✗ ${p}`))
  console.log(dim('\n    要监控采样器自己的四个指标：'))
  for (const m of shared.SAMPLER_METRICS) console.log(dim(`      ${m}`))

  // 出路：loop 长度用 Histogram
  const l = loopStats(runs, 20)
  console.log(bold('\n  出路：loop 长度不需要 trace'))
  console.log(`    p50 ${l.p50} 轮 / p90 ${l.p90} / p99 ${l.p99} / 最长 ${l.max}`)
  console.log(green(`    失控（≥20 轮）：${l.runaway.length} 次，全部被这个直方图看到`))
  console.log(
    dim('    ★ gen_ai.invoke_agent.inference_calls 和 .tool_calls 是 Histogram 而不是 Counter，'),
  )
  console.log(dim('      所以 p99 的 loop 长度可以在 1% 采样率下照样报警。'))
  console.log(
    dim('    顺带：invoke_agent.duration 的桶边界到 409.6 秒——规范预设 agent 能跑 ~7 分钟，'),
  )
  console.log(dim('    而 decision_wait 的默认值是 30 秒。'))
}

function demoSpanShape() {
  console.log(bold('\n七、span 的形状：规范不替你决定'))

  const u = normalizeUsage('anthropic', {
    input_tokens: 120,
    output_tokens: 340,
    cache_read_input_tokens: 48_000,
    cache_creation_input_tokens: 0,
    output_tokens_details: { reasoning_tokens: 280 },
  })
  const spans = agentSpanTree({
    agent: 'code-fixer',
    conversationId: 'conv-7',
    model: 'claude-like',
    provider: 'anthropic',
    steps: [
      { kind: 'chat', usage: u },
      { kind: 'execute_tool', name: 'read_file' },
      { kind: 'chat', usage: u },
      { kind: 'execute_tool', name: 'write_file' },
      { kind: 'chat', usage: u },
    ],
  })

  for (const s of spans) {
    const indent = s.parentId === null ? '  ' : '    ├─ '
    console.log(`${indent}${s.name}  ${dim(`[${s.kind}]`)}`)
  }
  console.log(
    dim('\n    一排兄弟，不是嵌套链。规范的非规范示例原话："They are likely to be'),
  )
  console.log(dim('    **siblings** if there is an encompassing span." 跨轮关联靠 conversation.id。'))

  const sum = sumUsage(spans)
  console.log(`\n  按 span 求和：输入 ${sum.input} / 输出 ${sum.output}`)
  console.log(
    green(`    ✓ 根 span 没带 token —— v1.41.0 起 internal 的 invoke_agent 显式移除了它们`),
  )
  console.log(dim(`      正是为了让这个求和不重复计算。`))

  // 反例：根 span 也带 token
  const bad = spans.map((s) =>
    s.parentId === null
      ? { ...s, attrs: { ...s.attrs, [ATTR.inputTokens]: sum.input, [ATTR.outputTokens]: sum.output } }
      : s,
  )
  const badSum = sumUsage(bad)
  console.log(red(`\n  如果根 span 也带 token：求和变成 ${badSum.input} —— 整整翻倍`))
  for (const p of badSum.problems) console.log(red(`    ✗ ${p}`))

  // 反例：没归一的 Anthropic 语义
  const rawSem: Span[] = [
    {
      name: 'chat 未归一',
      spanId: 'x',
      parentId: null,
      kind: 'CLIENT',
      attrs: {
        [ATTR.operation]: 'chat',
        [ATTR.inputTokens]: 120, // ★ Anthropic 的原始 input_tokens，不含缓存
        [ATTR.outputTokens]: 340,
        [ATTR.cacheRead]: 48_000,
      },
    },
  ]
  const rawSum = sumUsage(rawSem)
  console.log(red('\n  如果 span 上写的是未归一的 Anthropic 语义：'))
  for (const p of rawSum.problems) console.log(red(`    ✗ ${p}`))
}

async function demoReplay() {
  console.log(bold('\n八、★ 你复现的不是计算，是一份录音'))

  // 一份没开内容采集的 trace
  const noContent = agentSpanTree({
    agent: 'code-fixer',
    conversationId: 'conv-9',
    model: 'gpt-like',
    provider: 'openai',
    steps: [{ kind: 'chat' }, { kind: 'execute_tool', name: 'grep' }, { kind: 'execute_tool', name: 'grep' }],
  })
  const r1 = checkReplayability(noContent)
  console.log(dim('  一份"合规的"OTel trace，能不能重放？'))
  console.log(r1.replayable ? green('    可以') : red('    不能：'))
  for (const b of r1.blockers) console.log(red(`      ✗ ${b}`))
  for (const w of r1.warnings) console.log(yellow(`      ! ${w}`))

  // 用了 previous_response_id
  const stateful = noContent.map((s, i) =>
    i === 1
      ? {
          ...s,
          attrs: {
            ...s.attrs,
            'gen_ai.input.messages': '[...]',
            'gen_ai.request.previous_response.id': 'resp_abc123',
          },
        }
      : s,
  )
  const r2 = checkReplayability(stateful)
  console.log(dim('\n  同一份 trace，但用了 previous_response_id 做会话状态：'))
  for (const b of r2.blockers) console.log(red(`      ✗ ${b}`))

  // 录 → 放 → 分叉 → hybrid
  console.log(bold('\n  录一遍，然后放一遍：'))
  let liveCalls = 0
  const fakeModel = async () => {
    liveCalls++
    return { text: `回答 #${liveCalls}` }
  }

  const rec = new shared.Recorder('record')
  await rec.call('openai', '/responses', { prompt: '第一步' }, fakeModel)
  await rec.call('openai', '/responses', { prompt: '第二步' }, fakeModel)
  await rec.call('openai', '/responses', { prompt: '第二步' }, fakeModel) // 重试，同一个请求
  const cassette = rec.finish()
  console.log(dim(`    录到 ${cassette.entries.length} 条，真实调用 ${liveCalls} 次`))

  const before = liveCalls
  const play = new shared.Recorder('replay', cassette)
  await play.call('openai', '/responses', { prompt: '第一步' }, fakeModel)
  await play.call('openai', '/responses', { prompt: '第二步' }, fakeModel)
  await play.call('openai', '/responses', { prompt: '第二步' }, fakeModel)
  console.log(
    green(`    重放命中 ${play.report.matched} 条，真实调用 ${liveCalls - before} 次`),
  )
  console.log(
    dim('    ★ 同一个键要按 FIFO 游标推进，否则重试循环里的第二次会拿到第一次的响应。'),
  )

  // 分叉
  const strict = new shared.Recorder('replay', cassette)
  await strict.call('openai', '/responses', { prompt: '第一步' }, fakeModel)
  try {
    await strict.call('openai', '/responses', { prompt: '改过的第二步' }, fakeModel)
    console.log(red('    应该抛 DivergenceError 但没抛'))
  } catch (e) {
    console.log(red(`    ✗ ${(e as Error).message}`))
  }

  const before2 = liveCalls
  const hybrid = new shared.Recorder('hybrid', cassette)
  await hybrid.call('openai', '/responses', { prompt: '第一步' }, fakeModel)
  await hybrid.call('openai', '/responses', { prompt: '改过的第二步' }, fakeModel)
  console.log(
    green(`\n    hybrid：重放到分叉处（第 ${hybrid.report.divergedAt} 次调用），然后转真实调用 ${liveCalls - before2} 次`),
  )
  console.log(
    yellow('    ★ 这才是事故当下真正想问的问题："如果当时那一步返回的是别的，后面会怎样"'),
  )
  console.log(dim('      纯重放只能告诉你已经发生过的事，而那个 trace 也能告诉你。'))
}

function demoClassify() {
  console.log(bold('\n九、归因：能被程序判定的分类，才值得进你的分类学'))

  // 一次失控的运行：反复调用同一个工具，跑了 31 轮还没结束
  const spans: Span[] = [
    { name: 'invoke_agent fixer', spanId: 'root', parentId: null, kind: 'INTERNAL', attrs: { [ATTR.operation]: 'invoke_agent', [ATTR.compacted]: true } },
    ...['search', 'search', 'search', 'search', 'read'].map((t, i) => ({
      name: `execute_tool ${t}`,
      spanId: `s${i}`,
      parentId: 'root',
      kind: 'INTERNAL' as const,
      attrs: { [ATTR.operation]: 'execute_tool', [ATTR.toolName]: t },
    })),
  ]
  const verdicts = classifyFailure(spans, { ok: false, turns: 31 })
  console.log(dim('  一次跑了 31 轮没结束的运行，程序能判出：'))
  for (const v of verdicts) {
    console.log(`    ${bold(v.code)} ${v.name}`)
    console.log(dim(`      ${v.evidence}`))
  }

  console.log(bold('\n  为什么不能"把 trace 丢给大模型让它告诉我哪坏了"：'))
  console.log('    TRAIL 基准（148 条 OTel trace / 1987 span / 841 条标注错误）')
  console.log('    最好的模型联合准确率：' + red('GAIA 18.3%，SWE-Bench 5.0%'))
  console.log('    Context Handling Failures：' + red('几乎所有模型 F1 = 0.00'))
  console.log('    8 个模型里 ' + red('3 个直接 Context Length Exceeded'))
  console.log(dim('      （GAIA 那份在 Claude-3.7 的 tokenizer 下**平均**长度就超了它的窗口）'))
  console.log(
    yellow('\n    ★ agent 独有的那些失败，恰恰是 LLM judge 看不见的。'),
  )
  console.log(dim('    而 Language-Only 幻觉所有模型都测得不错（0.14–0.59）——'))
  console.log(dim('    所以"用 judge 查幻觉"可行，"用 judge 定位 agent 故障"不可行。'))

  console.log(bold('\n  MAST 的几个结论，比那张分类表本身更有用：'))
  for (const l of shared.MAST_LESSONS) console.log(`    · ${l}`)
  console.log(
    yellow('\n    ★ 而引用它的数字之前先看版本号：到处被引的 41.77/36.94/21.30 来自 v2，'),
  )
  console.log(yellow('      v3 是 ≈44.2/≈32.35/≈23.5，第一大类还改了名字，FM-2.5 差了 11 倍。'))
}

async function main() {
  console.log(
    IMPL === 'shared'
      ? dim('\n（跑的是 shared/observe.ts 里的参考实现）')
      : dim('\n（跑的是 l13/trace.ts 里你的实现。OBS_IMPL=shared 看参考输出）'),
  )
  demoCoalesce()
  demoUsage()
  demoCost()
  demoQuadratic()
  demoWall()
  demoSampling()
  demoSpanShape()
  await demoReplay()
  demoClassify()

  console.log(bold('\n\n这一节的一句话：'))
  console.log('  ' + bold('你以为在建一份记录，其实在建三份互相冲突的东西——'))
  console.log('  ' + bold('监控要便宜、调试要完整、复现要确定，'))
  console.log('  ' + bold('而它们没有一个能靠另外两个的配置得到。'))
  console.log()
}

if (isMain(import.meta.url)) await main()
