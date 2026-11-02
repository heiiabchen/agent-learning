/**
 * L13 参考实现：agent 的可观测性。
 *
 * ★ 这一节的核心论点，值得写在最前面：
 *
 * **你以为在建一份记录，其实在建三份互相冲突的东西。**
 *
 *   监控（metrics）  要便宜、要全量、要能报警
 *                    → 但它算不出成本（第七节）
 *   调试（trace）    要完整、要带内容
 *                    → 但完整的 trace 是二次方增长的（第二节），且默认不带内容
 *   复现（cassette） 要确定性
 *                    → 但模型本身不可复现（第九节）
 *
 * 把这三件事当成一件事做，是这一节里几乎所有故障的来源。
 * 而 OpenTelemetry 的规范其实在暗示这个分离——它的内容上传钩子
 * **不受采样决策影响**，那正是"trace 采样到 1%、录音留全量"这个架构。
 *
 * 每个失效都不抛异常。它们只是给你一份看起来完整的 trace。
 */

// ─────────────────────────────────────────────────────────────
// 一、属性名：一个会静默把你的看板打空的雷区
// ─────────────────────────────────────────────────────────────

/**
 * OTel GenAI 语义约定的当前属性名（2026-09 核对自 main）。
 *
 * ★ 先说三件让人不舒服的事实：
 *
 * 1. **这套约定已经不在 OpenTelemetry 的 semantic-conventions 仓库里了。**
 *    semconv v1.42.0（2026-06-12）把所有 `gen_ai.*` 弃用并搬到了
 *    独立仓库 semantic-conventions-genai，而那个仓库**到现在一个
 *    tag 都没有**。所以你没有版本号可以钉，也没有 schema_url。
 *    你跑的是"你的埋点库编译那天 main 上的那一版"。
 *
 * 2. **每一个 GenAI 元素都是 Development 级别。** 零个 stable。
 *    而 OTel 自己对 Development 的定义是"MAY 在无预告的情况下移除、
 *    SHOULD NOT 用于生产"。
 *
 * 3. 于是改名一直在发生，而**改名的症状是看板查到 0 条**——
 *    span 正常创建、exporter 返回成功、collector 吞吐健康。
 *    ★ 这和"系统很安静"长得一模一样。
 */
export const ATTR = {
  // 操作与提供方
  operation: 'gen_ai.operation.name',
  provider: 'gen_ai.provider.name', // v1.37.0 从 gen_ai.system 改名
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',

  // token（v1.27.0 从 prompt_tokens / completion_tokens 改名）
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  cacheRead: 'gen_ai.usage.cache_read.input_tokens',
  // ★ 这个键在 main 上刚从 cache_creation 改成 cache_write，且**尚未发布**。
  // 2026 年 8 月及之前的所有文章写的都是 cache_creation——它们已经错了。
  cacheWrite: 'gen_ai.usage.cache_write.input_tokens',
  reasoningTokens: 'gen_ai.usage.reasoning.output_tokens',

  // agent
  agentName: 'gen_ai.agent.name',
  agentVersion: 'gen_ai.agent.version',
  toolName: 'gen_ai.tool.name',
  conversationId: 'gen_ai.conversation.id',

  /**
   * ★ 这一个的语义有个坑，值得单独记：
   * 规范明确写了 instrumentation **SHOULD NOT 把它设成 false**，
   * 不压缩的时候就不要设。
   *
   * 于是"这个字段不存在"意味着**不知道**，不意味着"没压缩过"。
   * 一个写成 `compacted != true` 的看板过滤器会把所有未埋点的
   * 运行也算成"没压缩"。
   */
  compacted: 'gen_ai.conversation.compacted',

  // 复现相关
  seed: 'gen_ai.request.seed', // v1.37.0 从 gen_ai.openai.request.seed 改名
  systemFingerprint: 'openai.response.system_fingerprint', // gen_ai 前缀被摘掉了
  responseStatus: 'gen_ai.response.status', // queued/in_progress/completed/failed/incomplete/cancelled
} as const

/**
 * 已知的改名映射。用途不是考古，是**双发期的去重**。
 *
 * ★ 框架在兼容过渡期会把同一个值同时写到新旧两个键上。
 * 于是 `SUM(prompt_tokens) + SUM(input_tokens)` 会让你的
 * 报告花费**翻一倍**——而两个数字各自都是对的。
 *
 * 正确做法是**按优先级取一个，绝不相加**。
 */
export const RENAMES: Record<string, string> = {
  'gen_ai.usage.prompt_tokens': 'gen_ai.usage.input_tokens',
  'gen_ai.usage.completion_tokens': 'gen_ai.usage.output_tokens',
  'gen_ai.system': 'gen_ai.provider.name',
  'gen_ai.openai.request.seed': 'gen_ai.request.seed',
  'gen_ai.openai.response.system_fingerprint': 'openai.response.system_fingerprint',
  'gen_ai.usage.cache_creation.input_tokens': 'gen_ai.usage.cache_write.input_tokens',
}

export interface CoalesceReport {
  attrs: Record<string, unknown>
  /** 检测到的双发对，以及最后取了谁。 */
  dualEmit: string[]
  /** 值不一致的双发对 —— 这比双发本身更糟。 */
  conflicts: string[]
}

/**
 * 双发去重：把旧键折到新键上，**取一个，不相加**。
 *
 * ★ 还要报出"两个键的值不一样"这种情况。它意味着两条埋点路径
 * 在测不同的东西，而这时候无论取哪个都是错的。
 */
export function coalesceAttrs(raw: Record<string, unknown>): CoalesceReport {
  const attrs: Record<string, unknown> = {}
  const dualEmit: string[] = []
  const conflicts: string[] = []

  for (const [k, v] of Object.entries(raw)) {
    const canonical = RENAMES[k] ?? k
    if (canonical in raw && canonical !== k) {
      // 新键也在，旧键让位
      dualEmit.push(`${k} → ${canonical}`)
      if (raw[canonical] !== v) {
        conflicts.push(
          `${k}=${JSON.stringify(v)} 与 ${canonical}=${JSON.stringify(raw[canonical])} 不一致` +
            '——两条埋点路径在测不同的东西，取哪个都是错的',
        )
      }
      continue
    }
    attrs[canonical] = v
  }
  return { attrs, dualEmit, conflicts }
}

// ─────────────────────────────────────────────────────────────
// 二、token 会计：同一个字段名，相反的语义
// ─────────────────────────────────────────────────────────────

export type Provider = 'anthropic' | 'openai'

/** 各家原始 usage 的并集形状。字段名故意保持各家原样。 */
export interface RawUsage {
  // Anthropic
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  // OpenAI
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

/** 规范化之后的会计口径：所有字段都是"实际处理的 token 数"。 */
export interface Usage {
  /** ★ 全部输入，**含**缓存读和缓存写。这是 OTel 的口径。 */
  inputTokens: number
  outputTokens: number
  cacheRead: number
  /** 5 分钟档写入（1.25x）。 */
  cacheWrite5m: number
  /** 1 小时档写入（2x）。 */
  cacheWrite1h: number
  /** 推理 token。★ 已包含在 outputTokens 里，**不要再加**。 */
  reasoning: number
  /** 既不是缓存读也不是缓存写的普通输入。 */
  freshInput: number
  problems: string[]
}

/**
 * 把各家的 usage 归一到同一个口径。
 *
 * ★ 这是整节课最容易错一个数量级的地方，原因是
 * **Anthropic 和 OpenAI 的 `input_tokens` 语义正好相反。**
 *
 *   Anthropic：input_tokens **不含**缓存
 *              总输入 = input_tokens + cache_read + cache_creation
 *   OpenAI：   input_tokens **已含**缓存
 *              普通输入 = input_tokens − cached − cache_write
 *
 * 字段名一样，含义相反。一个照着字段名做的映射，在 Anthropic 上
 * 会把 100,050 记成 50——**少算 2001 倍**。
 *
 * Anthropic 自己的文档里写了这句话："`input_tokens` 在你有效使用
 * 缓存时通常会**远小于**你的实际总输入。"
 *
 * ★ 而 OTel 规范把这个不对称显式编码进去了，这是最好的印证：
 *   · Anthropic 提供方页注 [27]：input_tokens **excludes** cached tokens，
 *     要算 `input + cache_read + cache_write`，注 [22]/[23] 都说 MUST be added
 *   · OpenAI 提供方页注 [24]：cache_read 对应 `cached_tokens`，**不加**
 *   · 通用注册表：input_tokens "SHOULD include all types of input tokens,
 *     including cached tokens"
 *
 * 也就是说约定的口径是"input_tokens 是全量总和"——它和 OpenAI 的
 * 原始字段一致，和 Anthropic 的正好相反。
 */
export function normalizeUsage(provider: Provider, raw: RawUsage): Usage {
  const problems: string[] = []
  const out = raw.output_tokens ?? 0
  const reasoning = raw.output_tokens_details?.reasoning_tokens ?? 0

  if (reasoning > out && out > 0) {
    problems.push(
      `推理 token（${reasoning}）比 output_tokens（${out}）还多。` +
        'reasoning 应该是 output 的一部分，不是另一笔——这个数据源的口径反了',
    )
  }

  let inputTokens: number
  let cacheRead: number
  let w5: number
  let w1h: number

  if (provider === 'anthropic') {
    cacheRead = raw.cache_read_input_tokens ?? 0
    const created = raw.cache_creation_input_tokens ?? 0
    // ★ 顶层的 cache_creation_input_tokens 是两档之和，
    // 只读它**分不出 1.25x 的写和 2x 的写**。要算钱必须读明细。
    w5 = raw.cache_creation?.ephemeral_5m_input_tokens ?? 0
    w1h = raw.cache_creation?.ephemeral_1h_input_tokens ?? 0
    if (created > 0 && w5 + w1h === 0) {
      w5 = created // 只能假设是 5 分钟档
      problems.push(
        `cache_creation_input_tokens=${created} 但没有 cache_creation 明细。` +
          '★ 顶层字段是 5 分钟档（1.25x）和 1 小时档（2x）之和，只读它算不出钱——' +
          '这里只能按 5 分钟档估，而如果实际全是 1 小时档，这一项会低估 37.5%',
      )
    } else if (created > 0 && created !== w5 + w1h) {
      problems.push(
        `cache_creation_input_tokens=${created} 与明细之和 ${w5 + w1h} 不一致`,
      )
    }
    // ★ 关键的一行：Anthropic 要加，OpenAI 不加。
    inputTokens = (raw.input_tokens ?? 0) + cacheRead + w5 + w1h
  } else {
    cacheRead = raw.input_tokens_details?.cached_tokens ?? 0
    w5 = raw.input_tokens_details?.cache_write_tokens ?? 0
    w1h = 0 // OpenAI 只有一档写入
    // ★ 这里**不加**。OpenAI 的 input_tokens 已经含了缓存。
    inputTokens = raw.input_tokens ?? 0
    if (cacheRead + w5 > inputTokens) {
      problems.push(
        `缓存 token（${cacheRead + w5}）比 input_tokens（${inputTokens}）还多。` +
          '★ 这通常意味着你把 Anthropic 的相加逻辑用到了 OpenAI 上',
      )
    }
    if (cacheRead > 0 && cacheRead % 128 !== 0) {
      // 不是问题，是个值得知道的细节
      problems.push(
        `cached_tokens=${cacheRead} 不是 128 的整数倍。` +
          'GPT-5.6 之前 OpenAI 会把它**向下取整到 128 的倍数**，' +
          '所以命中数会被系统性少报最多 127——这一条说明你在新模型上',
      )
    }
  }

  const freshInput = Math.max(0, inputTokens - cacheRead - w5 - w1h)

  return {
    inputTokens,
    outputTokens: out,
    cacheRead,
    cacheWrite5m: w5,
    cacheWrite1h: w1h,
    reasoning,
    freshInput,
    problems,
  }
}

// ─────────────────────────────────────────────────────────────
// 三、成本：为什么它必须从 span 算，不能从 metric 算
// ─────────────────────────────────────────────────────────────

export interface Price {
  /** 每百万普通输入 token 的价格。 */
  inputPerM: number
  outputPerM: number
  /** 缓存读的倍率。Anthropic 一般 0.1，两个新模型是 0.025。 */
  cacheReadMult: number
  /** 5 分钟档写入倍率。 */
  cacheWrite5mMult: number
  /** 1 小时档写入倍率。OpenAI 没有这一档。 */
  cacheWrite1hMult: number
}

export const PRICES: Record<string, Price> = {
  // 数字是示意用的形状，不是报价单。倍率是文档里写明的。
  'claude-like': {
    inputPerM: 3,
    outputPerM: 15,
    cacheReadMult: 0.1,
    cacheWrite5mMult: 1.25,
    cacheWrite1hMult: 2,
  },
  'gpt-like': {
    inputPerM: 2,
    outputPerM: 8,
    cacheReadMult: 0.1,
    cacheWrite5mMult: 1.25, // ★ GPT-5.6 才开始收，之前不收
    cacheWrite1hMult: 0,
  },
}

export interface CostBreakdown {
  total: number
  fresh: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** 如果把所有输入 token 按普通输入价算，会算成多少。 */
  naiveTotal: number
  /** 倍率跨度：最贵的一类输入 token 是最便宜的多少倍。 */
  spread: number
}

/**
 * 算钱。
 *
 * ★ 这个函数存在的理由是要证明一件事：**"用 metrics 建成本看板"
 * 这个广为流传的建议，在开了 prompt caching 的系统上做不到。**
 *
 * 理由不在架构层面，在一个枚举里：`gen_ai.token.type` 只有
 * **两个**取值，`input` 和 `output`。没有 cache 维度，没有 reasoning 维度。
 *
 * 而 `gen_ai.client.token.usage` 这个 metric 的全部属性是：
 * operation.name、provider.name、request.model、response.model、
 * token.type、server.address、server.port。**没有缓存维度。**
 *
 * 于是缓存读（0.1x，两个模型上 0.025x）、5 分钟写（1.25x）、
 * 1 小时写（2x）、普通输入（1x）**全部塌进 token.type=input 这一个桶**——
 * 一个价格跨度达 80 倍的桶。
 *
 * ★ 所以正确的分工和常见建议是**反的**：
 *   metrics 用来看量、看延迟、看 loop 长度 SLO
 *   成本必须从 span 算（或者你自己加一个带缓存维度的 metric）
 */
export function costOf(u: Usage, price: Price): CostBreakdown {
  const per = (n: number, mult = 1) => (n / 1_000_000) * price.inputPerM * mult
  const fresh = per(u.freshInput)
  const cacheRead = per(u.cacheRead, price.cacheReadMult)
  const cacheWrite =
    per(u.cacheWrite5m, price.cacheWrite5mMult) + per(u.cacheWrite1h, price.cacheWrite1hMult)
  const output = (u.outputTokens / 1_000_000) * price.outputPerM

  const mults = [1, price.cacheReadMult, price.cacheWrite5mMult, price.cacheWrite1hMult].filter(
    (m) => m > 0,
  )
  return {
    total: fresh + cacheRead + cacheWrite + output,
    fresh,
    cacheRead,
    cacheWrite,
    output,
    // 这就是"从 metric 算"能拿到的最好结果：所有 input 一个价
    naiveTotal: per(u.inputTokens) + output,
    spread: Math.max(...mults) / Math.min(...mults),
  }
}

// ─────────────────────────────────────────────────────────────
// 四、trace 的二次方增长
// ─────────────────────────────────────────────────────────────

export interface Message {
  role: string
  content: string
}

export interface TraceSize {
  turns: number
  /** 朴素记录下存了多少条消息。 */
  storedMessages: number
  /** 其中不重复的有多少条。 */
  uniqueMessages: number
  storedBytes: number
  dedupedBytes: number
  ratio: number
}

/**
 * 一个 k 轮 agent 运行，朴素记录会存多少。
 *
 * ★ 这是这一节最漂亮的一个算术结果。
 *
 * agent 就是 LLM 调用放在循环里。每一步都往 message 数组里追加，
 * 而**整个数组会作为下一次调用的输入再发一遍**。可观测性平台
 * 记录每次 LLM 调用的输入。于是 k 轮下来你存了
 *
 *     1 + 2 + … + k = k(k+1)/2 条消息
 *
 * 而其中只有 k 条是不重复的。
 *
 *     总字节 ≈ 单条大小 × k × (k+1) / 2
 *
 *       10 轮   存 55 条    唯一 10 条
 *       30 轮   存 465 条   唯一 30 条
 *       50 轮   存 1275 条  唯一 50 条
 *
 * **运行长度翻倍，存储量翻四倍。**
 *
 * 单个 span 的上限也能推出来：整个数组必须塞得进上下文窗口，
 * 而多数框架在 80% 处压缩，所以一个 LLM span 的输入上限约是
 * `0.8 × 上下文窗口` ≈ 1M token 下的 **3.2 MB JSON**。
 * 于是一次逼近上限的 50 轮运行会写 **~160 MB**，
 * 其中 **~98% 是同一批字节被记了 50 遍**。
 *
 * 修法是**内容寻址**：对每条消息的规范化 JSON 取哈希，
 * 每个 trace 只存一份，读的时候再拼回来。O(k²) 变成 O(上下文窗口)。
 */
export function traceSize(messages: Message[], turns: number): TraceSize {
  const bytes = (m: Message) => JSON.stringify(m).length
  const perTurn = messages.slice(0, Math.max(1, Math.min(turns, messages.length)))

  let stored = 0
  let storedBytes = 0
  for (let k = 1; k <= turns; k++) {
    stored += k
    // 第 k 次调用发送前 k 条
    for (let i = 0; i < k; i++) storedBytes += bytes(perTurn[i % perTurn.length]!)
  }
  const uniq = new Set(perTurn.map((m) => JSON.stringify(m)))
  let dedup = 0
  for (const s of uniq) dedup += s.length

  return {
    turns,
    storedMessages: stored,
    uniqueMessages: uniq.size,
    storedBytes,
    dedupedBytes: dedup,
    ratio: dedup === 0 ? 1 : storedBytes / dedup,
  }
}

export interface DedupedTrace {
  /** 哈希 → 消息内容，每条只存一次。 */
  blobs: Record<string, Message>
  /** 每一轮引用哪些哈希。 */
  turns: string[][]
  savedBytes: number
}

/** 内容寻址去重。把 O(k²) 压成 O(上下文窗口)。 */
export function dedupeTrace(turnsOfMessages: Message[][]): DedupedTrace {
  const blobs: Record<string, Message> = {}
  const turns: string[][] = []
  let naive = 0

  for (const turn of turnsOfMessages) {
    const refs: string[] = []
    for (const m of turn) {
      // 规范化 JSON 再哈希，否则键序不同会算成两条
      const canonical = JSON.stringify({ role: m.role, content: m.content })
      naive += canonical.length
      const h = hash32(canonical)
      blobs[h] = m
      refs.push(h)
    }
    turns.push(refs)
  }

  let kept = 0
  for (const m of Object.values(blobs)) kept += JSON.stringify(m).length
  return { blobs, turns, savedBytes: naive - kept }
}

/** 够用的非加密哈希。真实项目里用 blake3 或 sha256。 */
export function hash32(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ─────────────────────────────────────────────────────────────
// 五、4 MiB 那道墙
// ─────────────────────────────────────────────────────────────

export interface Span {
  name: string
  spanId: string
  parentId: string | null
  kind: 'CLIENT' | 'INTERNAL' | 'SERVER'
  attrs: Record<string, unknown>
}

export interface Batch {
  spans: Span[]
  bytes: number
}

export interface BatchReport {
  batches: Batch[]
  /** 单个 span 就超限，装不进任何批次。 */
  oversized: string[]
  problems: string[]
}

/** OTLP 的默认接收上限。规范建议 64 MiB，但 gRPC 库的默认值是这个。 */
export const OTLP_LIMIT = 4 * 1024 * 1024

/**
 * 按**字节**分批，而不是按条数。
 *
 * ★ 这个函数存在的理由是一条很坏的组合：
 *
 * 1. OTLP 规范：服务端"typically enforce a default incoming message
 *    size limit of **4 MiB**"，超限时 gRPC 服务端 **MUST** 返回
 *    `RESOURCE_EXHAUSTED`，而它是一个**不可重试**的错误。
 *
 * 2. 一个 LLM span 的输入可以合法地达到 ~3.2 MB（第四节）。
 *
 * 3. ★ 而 OTel 的 batch processor **按条数分批，不按字节**。
 *    `send_batch_max_size` 数的是 span 个数，没有字节上限。
 *
 * 组合起来：一个胖 span 和几个普通 span 打成一批，超过 4 MiB，
 * **整批作为不可重试错误被丢掉**——连带那几个毫不相关的 span。
 *
 * 真实日志里 dropped_items 在 2000 到 8196 之间，报错是
 * `received message after decompression larger than max
 * (4194305 vs. 4194304)`——注意那个大小恰好是上限 + 1 字节。
 *
 * ★ 而 SDK 那一层不会救你：`AttributeValueLengthLimit` 的默认值是
 * **Infinity**。广为流传的"OTel 默认在 128 字符处截断"是把
 * **数量**限制看成了**长度**限制——`AttributeCountLimit` 默认 128，
 * 那是每条记录最多几个属性。
 *
 * 所以一个 3 MB 的 prompt 字符串**不会被截断**，它会一路顺畅地
 * 撞到 4 MiB 那道墙上。
 *
 * ★ 最坏的部分：被杀掉的总是最有价值的那些 trace。
 * 最胖的 span 来自最长、最复杂、最该被看的那次运行。
 */
export function batchByBytes(
  spans: Span[],
  limit = OTLP_LIMIT,
  /** 留一点余量给 protobuf 封装和压缩后的膨胀。 */
  headroom = 0.9,
): BatchReport {
  const budget = Math.floor(limit * headroom)
  const batches: Batch[] = []
  const oversized: string[] = []
  const problems: string[] = []
  let cur: Batch = { spans: [], bytes: 0 }

  for (const s of spans) {
    const size = spanBytes(s)
    if (size > budget) {
      // ★ 单个 span 就超限。分批解决不了，必须在这里做外部化。
      oversized.push(s.name)
      problems.push(
        `span「${s.name}」单条 ${(size / 1024 / 1024).toFixed(2)} MB，超过单批预算。` +
          '★ 分批救不了它——内容必须外部化（存对象存储，span 上只留引用）',
      )
      continue
    }
    if (cur.bytes + size > budget && cur.spans.length > 0) {
      batches.push(cur)
      cur = { spans: [], bytes: 0 }
    }
    cur.spans.push(s)
    cur.bytes += size
  }
  if (cur.spans.length > 0) batches.push(cur)

  const fat = spans.filter((s) => spanBytes(s) > budget / 2)
  if (fat.length > 0) {
    problems.push(
      `${fat.length} 个 span 单条就占掉半批以上。按条数分批会让它们和无关的 span ` +
        '打进同一批，然后**整批被当成不可重试错误丢掉**',
    )
  }
  return { batches, oversized, problems }
}

export function spanBytes(s: Span): number {
  return JSON.stringify(s).length
}

// ─────────────────────────────────────────────────────────────
// 六、采样：head 采样在 agent 上是结构性错误
// ─────────────────────────────────────────────────────────────

export interface Run {
  traceId: string
  ok: boolean
  turns: number
  ms: number
  tokens: number
}

export interface SampleOutcome {
  kept: string[]
  /** 保留下来的失败运行占全部失败运行的比例。 */
  failureRecall: number
  /** 保留下来的样本里失败的占比。 */
  failureShare: number
  note: string
}

/**
 * head 采样：在 root span 上按 traceId 哈希决定。
 *
 * ★ 它在 agent 上失败**不是因为不精确，是因为信息顺序**：
 * 做决定的那一刻，这次运行还没跑。它不可能知道这一次将会失败、
 * 将会跑 40 轮、或者将会烧穿预算。
 *
 * 于是 10% 的采样率保留 10% 的成功，**也保留 10% 的失败**。
 *
 * 而失败恰恰是那种稀有、昂贵、你打开 tracing 就是为了抓的事件。
 *
 * ★ 推论，也是这一节最该记住的一句：
 * **你的调试语料不只是生产流量的一个小样本，它是一个有偏的样本，
 * 而且偏的方向正好是错的。**
 *
 * 1% 采样率下，你会在留住一条罕见灾难轨迹之前，先留住中位数请求一百次。
 */
export function headSample(runs: Run[], rate: number): SampleOutcome {
  const kept = runs.filter((r) => hashRatio(r.traceId) < rate)
  const failures = runs.filter((r) => !r.ok)
  const keptFail = kept.filter((r) => !r.ok)
  return {
    kept: kept.map((r) => r.traceId),
    failureRecall: failures.length === 0 ? 0 : keptFail.length / failures.length,
    failureShare: kept.length === 0 ? 0 : keptFail.length / kept.length,
    note:
      `head 采样保留了 ${(keptFail.length / Math.max(failures.length, 1) * 100).toFixed(0)}% 的失败——` +
      '和成功的保留率一样。★ 因为决定是在运行开始前做的，那时候还不知道它会失败',
  }
}

function hashRatio(s: string): number {
  return parseInt(hash32(s).slice(0, 4), 16) / 0xffff
}

export interface TailPolicy {
  /** 等多久再决定。★ 默认 30 秒，而 agent 运行经常是几分钟。 */
  decisionWaitMs: number
  /** 缓冲区能装多少条 trace。满了**淘汰最老的**。 */
  numTraces: number
  /** 决策缓存大小。★ 默认 0，也就是**不启用**。 */
  decisionCacheSize: number
  /** 判为"要留"的条件。 */
  keep: (r: Run) => boolean
}

export interface TailOutcome extends SampleOutcome {
  /** 因为缓冲区满被提前淘汰的。 */
  droppedTooEarly: string[]
  /** 决策时运行还没结束，只看到了局部。 */
  decidedOnPartial: string[]
  /** ★ 同一次运行拿到了两个矛盾的采样决策。 */
  contradictory: string[]
  problems: string[]
}

/**
 * tail 采样：等运行结束再决定。
 *
 * 所有人都推荐它。★ 而几乎没人提它在 agent 上的三个专属缺陷，
 * 全部来自 tailsamplingprocessor 的默认值：
 *
 *   decision_wait        默认 **30s**  → 一次 4 分钟的运行会在
 *                                        只看到局部树的时候就被判掉
 *   num_traces           默认 50000    → 环形缓冲，满了淘汰**最老的**，
 *                                        而长 agent trace 永远是最老的
 *   sampled_cache_size   默认 **0**    → 缓存不启用
 *
 * 最后一条的后果最脏，README 自己写了：
 *
 *   "After the sampling decision is removed from the buffer, it's as if
 *    this component has never seen the trace before: the late spans are
 *    buffered for decision_wait seconds and **a new sampling decision
 *    is made**."
 *
 * ★ 也就是说在默认配置下，一次长 agent 运行可以拿到**两个互相矛盾的
 * 采样决策**——轨迹的一半被留下，另一半被丢掉。
 *
 * 而你打开它的时候看到的是一条**看起来完整的、只是有点短的** trace。
 */
export function tailSample(runs: Run[], policy: TailPolicy): TailOutcome {
  const kept: string[] = []
  const droppedTooEarly: string[] = []
  const decidedOnPartial: string[] = []
  const contradictory: string[] = []
  const problems: string[] = []

  // 按到达顺序进缓冲；缓冲满了淘汰最老的
  const buffer: Run[] = []
  for (const r of runs) {
    if (buffer.length >= policy.numTraces) {
      const evicted = buffer.shift()!
      droppedTooEarly.push(evicted.traceId)
    }
    buffer.push(r)
  }

  for (const r of buffer) {
    const partial = r.ms > policy.decisionWaitMs
    if (partial) {
      decidedOnPartial.push(r.traceId)
      // 只看到 decision_wait 之前那部分：按比例估一个截断的运行
      const frac = policy.decisionWaitMs / r.ms
      const truncated: Run = {
        ...r,
        turns: Math.max(1, Math.floor(r.turns * frac)),
        tokens: Math.floor(r.tokens * frac),
        ok: true, // 还没失败，因为还没跑完
      }
      const first = policy.keep(truncated)
      const real = policy.keep(r)
      if (first) kept.push(r.traceId)
      // ★ 决策缓存没开的话，迟到的 span 会触发第二次决策
      if (policy.decisionCacheSize === 0 && first !== real) {
        contradictory.push(r.traceId)
      }
    } else if (policy.keep(r)) {
      kept.push(r.traceId)
    }
  }

  if (decidedOnPartial.length > 0) {
    const worst = Math.max(...decidedOnPartial.map((id) => runs.find((r) => r.traceId === id)!.ms))
    problems.push(
      `${decidedOnPartial.length} 次运行比 decision_wait（${policy.decisionWaitMs}ms）长，` +
        `最长的 ${worst}ms，是 ${(worst / policy.decisionWaitMs).toFixed(1)} 倍。` +
        '★ 它们的采样决策是在只看到局部树的时候做的',
    )
  }
  if (droppedTooEarly.length > 0) {
    problems.push(
      `${droppedTooEarly.length} 次运行因为缓冲区满被淘汰。` +
        '★ 环形缓冲淘汰的是**最老的**，而长 agent trace 永远是最老的——' +
        '这道机制系统性地偏向丢掉长运行',
    )
  }
  if (contradictory.length > 0) {
    problems.push(
      `★ ${contradictory.length} 次运行拿到了**两个互相矛盾的采样决策**` +
        `（${contradictory.slice(0, 3).join('、')}）。` +
        '原因是 sampled_cache_size 默认 0，决策被清出缓冲后迟到的 span ' +
        '会触发一次全新的决策。症状是你打开一条**看起来完整、只是有点短**的 trace。' +
        '修法：把 sampled_cache_size / non_sampled_cache_size 设成远大于 num_traces',
    )
  }

  const failures = runs.filter((r) => !r.ok)
  const keptFail = kept.filter((id) => !runs.find((r) => r.traceId === id)!.ok)
  return {
    kept,
    failureRecall: failures.length === 0 ? 0 : keptFail.length / failures.length,
    failureShare: kept.length === 0 ? 0 : keptFail.length / kept.length,
    droppedTooEarly,
    decidedOnPartial,
    contradictory,
    problems,
    note: `tail 采样保留了 ${((keptFail.length / Math.max(failures.length, 1)) * 100).toFixed(0)}% 的失败`,
  }
}

/** 要监控采样器自己的四个指标。★ 埋点也需要被埋点。 */
export const SAMPLER_METRICS = [
  'otelcol_processor_tail_sampling_sampling_trace_dropped_too_early', // 缓冲淘汰
  'otelcol_processor_tail_sampling_sampling_trace_removal_age', // 拿 p1 和 decision_wait 比
  'otelcol_processor_tail_sampling_sampling_late_span_age', // 有多少迟到
  'otelcol_processor_tail_sampling_sampling_decision_timer_latency', // >1s 会把决策推过 decision_wait
] as const

// ─────────────────────────────────────────────────────────────
// 七、loop 长度：唯一能只用 metrics 做的 agent 报警
// ─────────────────────────────────────────────────────────────

/**
 * ★ 规范里最被低估的两个 metric：
 *
 *   gen_ai.invoke_agent.inference_calls   Histogram  {inference_call}
 *   gen_ai.invoke_agent.tool_calls        Histogram  {tool_call}
 *
 * 它们是 **Histogram，不是 Counter**——"单次调用中 agent 发起了多少次
 * 推理调用"，作用域是一次 invocation，**且包含失败的调用**。
 *
 * 意思是：**你可以在不存任何一条 trace 的前提下，对 p99 的 loop 长度报警。**
 *
 * 这正好回答了第六节那个困境：采样率 1% 的时候怎么发现失控的循环。
 * 答案是不用 trace，用这个直方图。
 *
 * 顺带一个有意思的细节：invoke_agent.duration 的桶边界是
 * [0.1 … 409.6] 秒——规范预设 agent 单次调用可以跑到 **~7 分钟**。
 * 那正是第六节里 decision_wait 默认 30 秒的荒谬之处。
 */
export interface LoopStats {
  p50: number
  p90: number
  p99: number
  max: number
  /** 超过阈值的运行。 */
  runaway: string[]
  note: string
}

export function loopStats(runs: Run[], runawayAt: number): LoopStats {
  const xs = runs.map((r) => r.turns).sort((a, b) => a - b)
  const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0
  const runaway = runs.filter((r) => r.turns >= runawayAt).map((r) => r.traceId)
  return {
    p50: q(0.5),
    p90: q(0.9),
    p99: q(0.99),
    max: xs[xs.length - 1] ?? 0,
    runaway,
    note:
      `p99 loop 长度 ${q(0.99)} 轮，最长 ${xs[xs.length - 1] ?? 0} 轮。` +
      '★ 这个数字来自 Histogram，不需要存任何一条 trace——' +
      '所以它在 1% 采样率下照样准',
  }
}

// ─────────────────────────────────────────────────────────────
// 八、span 树：规范不替你决定形状
// ─────────────────────────────────────────────────────────────

/**
 * 造一棵符合当前约定的 agent span 树。
 *
 * ★ 关于层级，规范**没有规范性指引，而且它自己说了**。
 * 非规范示例里描述一次工具往返的两个 chat span 时写的是：
 *
 *   "The relationship between below spans depends on how user
 *    application code is written. They are likely to be **siblings**
 *    if there is an encompassing span."
 *
 * 所以规范预期的形状是**一个总 span 下面一排兄弟**，不是嵌套链：
 * chat → execute_tool → chat，三个都挂在同一个 invoke_agent 下面。
 * 跨轮次的关联靠 `gen_ai.conversation.id`，**不靠父子关系**。
 *
 * 仓库里没有 examples-agents.md（我查了，404）。agent span 那篇
 * 只有定义，没有一条完整的示例 trace。
 *
 * ★ 教学点：**你的 agent trace 长什么形状，是你自己的决定，
 * 而这份约定不会替你裁决。**
 *
 * 另外 v1.41.0 把 invoke_agent 拆成了 client 和 internal 两种 span，
 * 而 internal 那种**故意不带 token usage 属性**——
 * 这对 token 会计是个好消息：进程内 agent 的 token 只挂在子推理 span 上，
 * 所以按 span 求和不再重复计算。
 */
export function agentSpanTree(opts: {
  agent: string
  conversationId: string
  model: string
  provider: Provider
  steps: { kind: 'chat' | 'execute_tool'; name?: string; usage?: Usage }[]
}): Span[] {
  const root: Span = {
    name: `invoke_agent ${opts.agent}`,
    spanId: 'root',
    parentId: null,
    // 进程内 agent 用 INTERNAL；跨进程用 CLIENT
    kind: 'INTERNAL',
    attrs: {
      [ATTR.operation]: 'invoke_agent',
      [ATTR.agentName]: opts.agent,
      [ATTR.conversationId]: opts.conversationId,
      // ★ internal 的 invoke_agent 不带 token usage，也不带 server.address
    },
  }

  const spans: Span[] = [root]
  opts.steps.forEach((s, i) => {
    if (s.kind === 'chat') {
      spans.push({
        // 规范的 span 名格式：{operation} {model}
        name: `chat ${opts.model}`,
        spanId: `s${i}`,
        parentId: 'root', // ★ 兄弟，不是链
        kind: 'CLIENT',
        attrs: {
          // ★ 这五个是 sampling-relevant 的，**必须在 span 创建时就存在**，
          // 不能等到结束前再补——否则 tail 采样器看不到它们，
          // 而你的采样策略会静默地不再区分任何东西。
          [ATTR.operation]: 'chat',
          [ATTR.provider]: opts.provider,
          [ATTR.requestModel]: opts.model,
          'server.address': 'api.example.com',
          'server.port': 443,
          [ATTR.conversationId]: opts.conversationId,
          ...(s.usage ? usageAttrs(s.usage) : {}),
        },
      })
    } else {
      spans.push({
        name: `execute_tool ${s.name ?? 'unknown'}`,
        spanId: `s${i}`,
        parentId: 'root',
        kind: 'INTERNAL',
        attrs: { [ATTR.operation]: 'execute_tool', [ATTR.toolName]: s.name ?? 'unknown' },
      })
    }
  })
  return spans
}

/** 把规范化的 usage 写成 span 属性。注意哪些**不能相加**。 */
export function usageAttrs(u: Usage): Record<string, number> {
  const a: Record<string, number> = {
    [ATTR.inputTokens]: u.inputTokens, // 已含缓存
    [ATTR.outputTokens]: u.outputTokens, // 已含推理
  }
  if (u.cacheRead) a[ATTR.cacheRead] = u.cacheRead
  if (u.cacheWrite5m + u.cacheWrite1h) a[ATTR.cacheWrite] = u.cacheWrite5m + u.cacheWrite1h
  if (u.reasoning) a[ATTR.reasoningTokens] = u.reasoning
  return a
}

/**
 * 按 span 求和算总 token，且不重复计算。
 *
 * ★ 三层包含关系，每一层都是一次重复计算的机会：
 *   input_tokens ⊇ cache_read + cache_write
 *   output_tokens ⊇ reasoning
 *   {modality}.cache_read ⊆ cache_read **且** ⊆ {modality}.input
 *
 * 所以规则是：**只对 input_tokens 和 output_tokens 求和，
 * 其余全是明细，用来算钱，不用来求总量。**
 */
export function sumUsage(spans: Span[]): { input: number; output: number; problems: string[] } {
  let input = 0
  let output = 0
  const problems: string[] = []

  for (const s of spans) {
    const i = Number(s.attrs[ATTR.inputTokens] ?? 0)
    const o = Number(s.attrs[ATTR.outputTokens] ?? 0)
    const cr = Number(s.attrs[ATTR.cacheRead] ?? 0)
    const cw = Number(s.attrs[ATTR.cacheWrite] ?? 0)
    const rz = Number(s.attrs[ATTR.reasoningTokens] ?? 0)

    if (cr + cw > i) {
      problems.push(
        `span「${s.name}」的缓存 token（${cr + cw}）比 input_tokens（${i}）还多。` +
          '★ input_tokens 应该已经包含缓存——这条 span 的口径是 Anthropic 的原始语义，没归一',
      )
    }
    if (rz > o) {
      problems.push(`span「${s.name}」的 reasoning（${rz}）比 output_tokens（${o}）还多`)
    }
    input += i
    output += o
  }

  // ★ 父 span 也带 token 的情况：会重复计算
  const roots = spans.filter((s) => s.parentId === null && Number(s.attrs[ATTR.inputTokens] ?? 0) > 0)
  if (roots.length > 0 && spans.length > roots.length) {
    problems.push(
      `根 span「${roots[0]!.name}」上也有 token usage，而它有子 span。` +
        '★ 按 span 求和会**重复计算**。v1.41.0 起 internal 的 invoke_agent ' +
        '已经显式移除了 token 属性，正是为了避免这件事',
    )
  }
  return { input, output, problems }
}

// ─────────────────────────────────────────────────────────────
// 九、复现：你复现的不是计算，是一份录音
// ─────────────────────────────────────────────────────────────

export interface CassetteEntry {
  /** 匹配键：provider ‖ endpoint ‖ 规范化请求体 的哈希。 */
  key: string
  response: unknown
  /** 同一个键的第几次调用。★ 重试循环里同一个请求会出现多次。 */
  seq: number
}

export interface Cassette {
  entries: CassetteEntry[]
  /** 记录时的时钟值。★ 时间必须被录下来，否则重放会走到不同分支。 */
  clock: number[]
  /** 记录时的随机数。 */
  random: number[]
  /** 记录时每次请求的 id。★ 不录它，重放会在第一次调用就分叉。 */
  requestIds: string[]
  meta: { model: string; systemFingerprint?: string; recordedAt: number }
}

export type ReplayMode = 'record' | 'replay' | 'hybrid'

export interface DivergenceReport {
  matched: number
  /** 第一次分叉的位置和原因。 */
  divergedAt: number | null
  reason: string | null
  /** hybrid 模式下从这里开始转真实调用。 */
  wentLive: boolean
  problems: string[]
}

/**
 * 一个能检测分叉的录放机。
 *
 * ★ 必须先说清一件被营销语言盖住的事：
 *
 * **模型的输出没法重放。**
 *
 * 第九节讲了原因：temperature 0 下同一个请求的输出取决于**别人的负载**。
 * 所以所有声称"deterministic replay for agents"的工具，做的事情都是
 * **把模型输出缓存下来当成 oracle 再发一遍**，不是重新执行模型。
 *
 * 你重放的是一份**录音**，不是一次**计算**。
 *
 * 这不是吹毛求疵——它决定了这个工具能回答什么问题：
 *   能回答："当时到底发生了什么"（但这个 trace 也能告诉你）
 *   不能回答："换个模型会怎样"（那是两个不同的 prompt，见下）
 *   ★ 能回答（只有 hybrid 能）："如果当时那个工具返回的是别的，会怎样"
 *
 * 而最后一个才是事故当下你真正想问的问题。
 */
export class Recorder {
  private cassette: Cassette
  private cursor = new Map<string, number>()
  private idx = 0
  readonly report: DivergenceReport = {
    matched: 0,
    divergedAt: null,
    reason: null,
    wentLive: false,
    problems: [],
  }

  constructor(
    readonly mode: ReplayMode,
    cassette?: Cassette,
  ) {
    this.cassette =
      cassette ??
      ({ entries: [], clock: [], random: [], requestIds: [], meta: { model: '', recordedAt: 0 } } as Cassette)
  }

  /** 规范化请求体再哈希。键序不同会算成两个不同的请求。 */
  keyFor(provider: string, endpoint: string, body: unknown): string {
    return hash32(`${provider}|${endpoint}|${canonicalJson(body)}`)
  }

  /**
   * 走一次调用。
   *
   * ★ 同一个键要按 FIFO 游标推进，否则重试循环里的第二次调用
   * 会拿到第一次的响应。
   */
  async call<T>(
    provider: string,
    endpoint: string,
    body: unknown,
    live: () => Promise<T>,
  ): Promise<T> {
    const key = this.keyFor(provider, endpoint, body)
    const seq = this.cursor.get(key) ?? 0
    this.cursor.set(key, seq + 1)
    const here = this.idx++

    if (this.mode === 'record') {
      const r = await live()
      this.cassette.entries.push({ key, response: r, seq })
      return r
    }

    const hit = this.cassette.entries.find((e) => e.key === key && e.seq === seq)
    if (hit) {
      this.report.matched++
      return hit.response as T
    }

    // 没命中 = 分叉
    if (this.report.divergedAt === null) {
      this.report.divergedAt = here + 1
      this.report.reason =
        `第 ${here + 1} 次调用分叉：${provider} ${endpoint} 的请求体和录音里的都不匹配` +
        `（键 ${key}，序号 ${seq}）`
    }
    if (this.mode === 'hybrid') {
      // ★ hybrid 才是有用的那个模式：重放到分叉，然后转真实调用。
      // 它回答的是"如果当时那一步不一样，后面会怎样"。
      this.report.wentLive = true
      return live()
    }
    throw new DivergenceError(this.report.reason!)
  }

  /** 时钟。★ 不虚拟化时间，重放会走到不同的超时分支。 */
  now(): number {
    if (this.mode === 'record') {
      const t = Date.now()
      this.cassette.clock.push(t)
      return t
    }
    const t = this.cassette.clock.shift()
    if (t === undefined) {
      this.report.problems.push('时钟录音用尽——重放比记录时多调了 Date.now()')
      return Date.now()
    }
    return t
  }

  /** 请求 id。★ 不录它，SDK 每次都会生成新的，第一次调用就分叉。 */
  requestId(): string {
    if (this.mode === 'record') {
      const id = `req_${hash32(String(this.idx) + String(Math.random()))}`
      this.cassette.requestIds.push(id)
      return id
    }
    return this.cassette.requestIds.shift() ?? `req_replay_${this.idx}`
  }

  finish(): Cassette {
    return this.cassette
  }
}

export class DivergenceError extends Error {}

/** 规范化 JSON：键排序。否则同一个请求会哈希成两个键。 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const keys = Object.keys(v as object).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`
}

export interface ReplayabilityReport {
  replayable: boolean
  blockers: string[]
  warnings: string[]
}

/**
 * 这份 trace 能不能重放。
 *
 * ★ 六个会让重放失效的东西，每一个都不抛异常：
 *
 * 1. **内容没录**。OTel 的四个内容属性全是 `opt_in`，**默认不发**。
 *    所以一个"合规的"埋点产出的 trace，在你主动打开内容采集之前
 *    对重放毫无用处。
 *
 * 2. **请求 id 没录**。SDK 每次生成新的，第一次调用就分叉。
 *
 * 3. **并发**。真正并发的调用是按**完成顺序**录的；如果那个顺序
 *    在两次运行之间不稳定，顺序匹配就只能是 best-effort。
 *    而每个现代 agent 都在做并行工具调用。
 *
 * 4. ★ **previous_response_id 根本没法重放**。用它做会话状态的时候，
 *    之前的上下文存在 **OpenAI 的服务端**。你的 trace 记录的是一个
 *    指向你不拥有、而且会过期的状态的**指针**。没有东西可以重放。
 *
 * 5. **推理内容能重放但读不了**。无状态模式下 reasoning item 带一个
 *    `encrypted_content`，你可以传给后续调用，但你的调试器看不进去。
 *    ★ 你为它付钱、它塑造了整条轨迹、而它不可见。
 *
 * 6. ★ **换个模型重放会静默改掉 prompt**。Anthropic 文档写得很直白：
 *    在较早的模型上"all previously-cached thinking blocks are
 *    **stripped from context**"。所以同一份录音重放到另一个模型上，
 *    得到的是一个**不同的有效上下文**——不是你的重放有 bug，
 *    是提供方按模型做了不同的裁剪。
 *
 *    任何"换个模型跑一遍录音来比成本"的功能，比的是两个不同的 prompt。
 */
export function checkReplayability(spans: Span[]): ReplayabilityReport {
  const blockers: string[] = []
  const warnings: string[] = []

  const hasContent = spans.some(
    (s) => 'gen_ai.input.messages' in s.attrs || 'gen_ai.output.messages' in s.attrs,
  )
  if (!hasContent) {
    blockers.push(
      '★ trace 里没有消息内容。OTel 的四个内容属性全是 opt_in、**默认不发**——' +
        '一个"合规的"埋点产出的 trace，在你主动打开内容采集之前对重放毫无用处',
    )
  }

  const chats = spans.filter((s) => s.attrs[ATTR.operation] === 'chat')
  if (chats.some((s) => !(ATTR.seed in s.attrs))) {
    warnings.push(
      '没记 seed。★ 但要注意 seed 在 OpenAI 的 Responses API 里**不存在**' +
        '（openai-node #1613 至今 open，2026-07-06 被官方账号打上 upstream 标签）——' +
        '而 Responses 正是现代 agent SDK 的底座。所以"设个 seed"这个建议在那里是结构性不可用的',
    )
  }
  if (!spans.some((s) => ATTR.systemFingerprint in s.attrs)) {
    warnings.push(
      '没记 system_fingerprint。★ 注意它的正确用法和多数人理解的相反：' +
        '它**不保证**指纹相同就输出相同，它保证的是**指纹变了你就该预期漂移**。' +
        '它是一个漂移检测信号，不是确定性契约',
    )
  }

  if (spans.some((s) => 'gen_ai.request.previous_response.id' in s.attrs)) {
    blockers.push(
      '★ 用了 previous_response_id。之前的上下文存在提供方的服务端，' +
        '你的 trace 里只有一个指向你不拥有、而且会过期的状态的指针。**没有东西可以重放。**',
    )
  }

  const tools = spans.filter((s) => s.attrs[ATTR.operation] === 'execute_tool')
  const parallel = new Set(tools.map((s) => s.parentId))
  if (tools.length > 1 && parallel.size < tools.length) {
    warnings.push(
      `${tools.length} 个工具调用挂在同一个父 span 下，可能是并行的。` +
        '★ 并发调用是按**完成顺序**录的，那个顺序不稳定的时候顺序匹配只能是 best-effort',
    )
  }

  return { replayable: blockers.length === 0, blockers, warnings }
}

// ─────────────────────────────────────────────────────────────
// 十、归因：分类学，以及最好的模型只有 11%
// ─────────────────────────────────────────────────────────────

/**
 * 失败模式分类。
 *
 * ★ 这里的取舍是这一节最实用的一个判断：
 * **能被程序判定的分类，才值得进你的分类学。**
 *
 * 理由来自 TRAIL 那个基准（arXiv 2505.08638）：148 条 OTel trace、
 * 1987 个 span、841 条标注错误，让模型去定位和归因，
 * **最好的模型联合准确率 18.3%（GAIA）和 5.0%（SWE-Bench）**。
 *
 * 而分项更说明问题：
 *   · **Context Handling Failures：几乎所有模型 F1 = 0.00**
 *     （只有 Claude-3.7 拿到 0.18）
 *   · Task Orchestration：除 Gemini-2.5-Flash 的 0.47，其余 0.00–0.08
 *   · 而 Language-Only 幻觉所有模型都测得不错（0.14–0.59）
 *
 * ★ 也就是说：**agent 独有的那些失败，恰恰是 LLM judge 看不见的。**
 *
 * 还有一个更硬的限制：8 个模型里 **3 个直接 Context Length Exceeded**。
 * GAIA 那一份在 Claude-3.7 的 tokenizer 下**平均**长度就超过了它的
 * 上下文窗口（262.67K vs 200K），最大值总是上限的两倍以上。
 *
 * 结论很直接：**不要指望"把 trace 丢给一个大模型让它告诉我哪坏了"。**
 * 那个东西的准确率是 11%，而且对 agent 特有的失败是 0。
 * 你需要的是**程序能判的规则**，判不了的部分才交给人。
 *
 * 下面这几条对应 MAST（arXiv 2503.13657，14 个失败模式 / 3 大类）
 * 里出现频率最高的几个，且全部可以用 trace 结构判定。
 */
export interface FailureVerdict {
  code: string
  name: string
  evidence: string
}

export function classifyFailure(spans: Span[], run: { ok: boolean; turns: number }): FailureVerdict[] {
  const out: FailureVerdict[] = []

  // FM-1.3 步骤重复 —— MAST v3 里占 15.7%，是单个最高的失败模式
  const toolCalls = spans
    .filter((s) => s.attrs[ATTR.operation] === 'execute_tool')
    .map((s) => `${s.attrs[ATTR.toolName]}`)
  const counts = new Map<string, number>()
  for (const t of toolCalls) counts.set(t, (counts.get(t) ?? 0) + 1)
  for (const [tool, n] of counts) {
    if (n >= 3) {
      out.push({
        code: 'FM-1.3',
        name: '步骤重复',
        evidence: `工具「${tool}」被调用 ${n} 次。MAST 里这是占比最高的失败模式（15.7%）`,
      })
    }
  }

  // FM-1.5 不知道终止条件 —— 12.4%
  if (!run.ok && run.turns >= 20) {
    out.push({
      code: 'FM-1.5',
      name: '不知道终止条件',
      evidence: `跑了 ${run.turns} 轮仍未结束。这一类占 12.4%`,
    })
  }

  // FM-1.4 丢失对话历史 / 上下文处理失败
  const compacted = spans.some((s) => s.attrs[ATTR.compacted] === true)
  if (compacted) {
    out.push({
      code: 'FM-1.4',
      name: '上下文被压缩过',
      evidence:
        '有 span 标了 conversation.compacted=true。' +
        '★ 注意反过来不成立：规范说 SHOULD NOT 设成 false，' +
        '所以这个字段缺失意味着**不知道**，不意味着没压缩',
    })
  }

  // FM-3.1 过早终止 —— 6.2%
  if (run.ok && run.turns <= 1 && toolCalls.length === 0) {
    out.push({
      code: 'FM-3.1',
      name: '过早终止',
      evidence: '一轮就结束且没调用任何工具。这一类占 6.2%',
    })
  }

  return out
}

/**
 * MAST 的三个结论，比那张分类表本身更有用。
 *
 * ★ 而在引用它的数字之前先记一件事：**版本号会变，而数字跟着变。**
 * 那组到处被引用的 41.77% / 36.94% / 21.30% 来自 v2，
 * 现在的 v3 是 ≈44.2% / ≈32.35% / ≈23.5%，而且第一大类的名字
 * 从 Specification Issues 改成了 System Design Issues。
 * 样本量也从"7 个框架、200+ 任务"变成了"5 个框架、150+ trace"。
 * FM-2.5 从 0.17% 变成 1.90%，**差 11 倍**。
 *
 * 所以引用的时候带上版本号。这本身就是这一节的主题：
 * 一个数字看起来很权威，而它的来源在动。
 */
export const MAST_LESSONS = [
  '★ 设计比模型重要：只改进 agent 的角色说明，ChatDev 的成功率 +9.4%——' +
    '同样的用户 prompt、同样的 GPT-4o。"MAS 的失败不只是底层模型能力的函数。"',
  '验证器有用但不是银弹：有显式验证器的系统失败更少，但论文的例子是一个 ' +
    'ChatDev 生成的国际象棋程序通过了所有验证轮次（能编译、有注释），' +
    '而它在运行时接受非法走法——验证器从来没有对着棋规校验过',
  '★ 失败画像是架构特有的：AppWorld 偏向过早终止（星形拓扑、没有预定义流程，' +
    '于是终止条件不明显），OpenManus 偏向步骤重复。所以通用修法不管用',
  '相似的表面行为有不同的根因："信息缺失"可能来自主动隐瞒（FM-2.4）、' +
    '忽略了别的 agent 的输入（FM-2.5）、或者上下文管理不当（FM-1.4）。' +
    '这正是要做细粒度 trace 归因、而不是打粗标签的理由',
] as const
