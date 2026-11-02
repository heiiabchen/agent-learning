import Anthropic from '@anthropic-ai/sdk'

/**
 * 为什么要有这个文件（L00 第六节讲过）：
 *
 * 我们用的是「Anthropic 协议兼容端点」——代码按 Anthropic 的 Messages API 写，
 * 请求实际打到 DeepSeek。这带来两个必须防的问题：
 *
 *   1. 模型 ID 会退役。deepseek-chat 在 2026-07 就已经下线了。
 *      所以模型 ID 一定来自环境变量，不写死。跑 `pnpm models` 可以查当前可用的 ID。
 *   2. 兼容层的特性支持是残缺的，而且**不支持时通常不报错**，只是静默忽略。
 *      所以「这个 provider 支持什么」必须被显式记录下来，而不是靠猜。
 */

export interface Provider {
  name: string
  baseURL: string
  apiKey: string
  models: { main: string; fast: string }
  /** 实测结论，不是官方声明。L15 会写一个探测脚本来填这张表。 */
  supports: {
    promptCaching: boolean
    vision: boolean
    extendedThinking: boolean
    parallelToolUse: boolean
  }
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new Error(
      `缺少环境变量 ${name}。\n把 .env.example 复制成 .env 并填入你的 key，然后确认跑的是带 --env-file=.env 的脚本。`,
    )
  }
  return v
}

export function getProvider(): Provider {
  return {
    name: 'deepseek',
    baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic',
    apiKey: required('DEEPSEEK_API_KEY'),
    models: {
      main: process.env.DEEPSEEK_MODEL_MAIN ?? 'deepseek-v4-flash',
      fast: process.env.DEEPSEEK_MODEL_FAST ?? 'deepseek-v4-flash',
    },
    supports: {
      // DeepSeek 是「自动前缀缓存」：不需要传 cache_control，命中与否看你的前缀稳不稳定。
      // 这和 Anthropic 官方那套显式打标记的机制不一样，L15 会实测两者的差别。
      promptCaching: true,
      vision: false,
      // V4 默认就开着思考模式——这就是你在 stream.ts 里收到 thinking_delta 的原因。
      extendedThinking: true,
      parallelToolUse: true,
    },
  }
}

/**
 * 单价，单位是「元 / 百万 token」。
 *
 * 放在配置里而不是散落在各个脚本里，是为了让「算账」有唯一事实来源。
 * 价格会变（DeepSeek 已经预告过高峰时段翻倍），跑重要的成本估算之前
 * 去 https://api-docs.deepseek.com/zh-cn/quick_start/pricing 对一眼。
 *
 * 注意 inputHit 和 inputMiss 差 50 倍。这个比例是 L15 一整节课的由来。
 */
export const PRICING: Record<string, { inputMiss: number; inputHit: number; output: number }> = {
  'deepseek-v4-flash': { inputMiss: 1, inputHit: 0.02, output: 2 },
  'deepseek-v4-pro': { inputMiss: 3, inputHit: 0.025, output: 6 },
}

export function priceOf(model: string) {
  const p = PRICING[model]
  if (!p) throw new Error(`PRICING 里没有 ${model} 的价格，先去补上再算账。`)
  return p
}

/**
 * 两个关键选项，都值得注意：
 *
 * - authToken 而不是 apiKey：Anthropic 官方端点用 `x-api-key` 头，
 *   而兼容端点普遍走标准的 `Authorization: Bearer`。SDK 里 authToken 对应后者。
 *   填错的表现是 401，而且报错信息通常没什么帮助。
 *
 * - maxRetries: 0：SDK 自己默认会重试 2 次。我们要在 L00 里手写重试逻辑，
 *   所以先把它关掉，否则两层重试会叠乘（4 次变 12 次），账单和日志都会很难看。
 */
export function createClient(p: Provider = getProvider()) {
  return new Anthropic({
    baseURL: p.baseURL,
    authToken: p.apiKey,
    maxRetries: 0,
  })
}

/** 打印这次调用花了多少 token，从第一天就养成看账的习惯。 */
export function logUsage(label: string, usage: { input_tokens: number; output_tokens: number }) {
  console.log(
    `\x1b[2m[${label}] 输入 ${usage.input_tokens} token · 输出 ${usage.output_tokens} token\x1b[0m`,
  )
}
