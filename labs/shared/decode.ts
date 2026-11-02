/**
 * 参考实现：logits → token 的四步。
 *
 * temperature / top_p / top_k 这三个参数你在 L01 调过，那时候是黑盒。
 * 这里是黑盒里面的东西，一共四十行。
 */

import { softmax } from './attention.ts'

export interface SampleOptions {
  temperature?: number
  /** 累积概率截断。1 表示不截断 */
  topP?: number
  /** 只保留前 k 个。0 或 undefined 表示不截断 */
  topK?: number
  /** 注入随机源，测试时用固定序列。默认 Math.random */
  rand?: () => number
}

export interface SampleResult {
  /** 选中的 token 下标 */
  index: number
  /** 截断后的分布（被删掉的位置是 0），和为 1 */
  probs: number[]
  /** 截断后还剩几个候选。这个数字是「模型有多少选择」的直接度量 */
  candidates: number
}

/**
 * 温度缩放。
 *
 * T < 1 放大差距（更确定），T > 1 压缩差距（更随机）。
 * T = 0 是特例：退化成 argmax，不能真的做除法（会得到 Infinity 或 NaN）。
 */
export function applyTemperature(logits: number[], temperature: number): number[] {
  if (temperature < 0) throw new Error(`temperature 不能是负数，收到 ${temperature}`)
  if (temperature === 0) {
    // argmax 的等价表示：最大值给 0，其余给 -Infinity。
    // softmax 之后就是 one-hot。这样后续步骤不需要为 T=0 分叉。
    const max = Math.max(...logits)
    let taken = false
    return logits.map((l) => {
      // 有并列最大值时只取第一个，否则 one-hot 会变成多个 1
      if (l === max && !taken) {
        taken = true
        return 0
      }
      return -Infinity
    })
  }
  return logits.map((l) => l / temperature)
}

/**
 * top-k 截断：只留概率最大的 k 个。
 *
 * 注意这一步在概率空间做，不在 logits 空间——顺序一样，但便于和 top-p 组合。
 */
export function applyTopK(probs: number[], k: number): number[] {
  if (k <= 0 || k >= probs.length) return probs

  const sorted = probs.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p)
  const keep = new Set(sorted.slice(0, k).map((x) => x.i))

  const out = probs.map((p, i) => (keep.has(i) ? p : 0))
  return renormalize(out)
}

/**
 * top-p（nucleus）截断：按概率降序累加，到 p 为止，其余删掉。
 *
 * 关键细节：**至少要留一个**。
 * 如果最大概率就已经超过 p（比如 p=0.5 而 top1 是 0.9），
 * 朴素实现会一个都不留，然后归一化时除以 0 得到 NaN。
 */
export function applyTopP(probs: number[], p: number): number[] {
  if (p >= 1) return probs
  if (p <= 0) throw new Error(`top_p 必须大于 0，收到 ${p}`)

  const sorted = probs.map((prob, i) => ({ prob, i })).sort((a, b) => b.prob - a.prob)

  const keep = new Set<number>()
  let cum = 0
  for (const { prob, i } of sorted) {
    keep.add(i) // 先加再判断，保证至少留一个
    cum += prob
    if (cum >= p) break
  }

  const out = probs.map((prob, i) => (keep.has(i) ? prob : 0))
  return renormalize(out)
}

function renormalize(probs: number[]): number[] {
  const sum = probs.reduce((a, b) => a + b, 0)
  if (sum <= 0) throw new Error('归一化时分母是 0，截断把所有候选都删了')
  return probs.map((p) => p / sum)
}

/**
 * 完整的一次采样：温度 → softmax → top_k → top_p → 抽签。
 *
 * 顺序有讲究：截断必须在 softmax 之后（要用概率判断累积），
 * 温度必须在 softmax 之前（缩放的是 logits）。
 */
export function sample(logits: number[], opts: SampleOptions = {}): SampleResult {
  const { temperature = 1, topP = 1, topK = 0, rand = Math.random } = opts

  const scaled = applyTemperature(logits, temperature)
  let probs = softmax(scaled)
  if (topK > 0) probs = applyTopK(probs, topK)
  if (topP < 1) probs = applyTopP(probs, topP)

  const candidates = probs.filter((p) => p > 0).length

  // 累积分布抽签
  const r = rand()
  let cum = 0
  for (let i = 0; i < probs.length; i++) {
    cum += probs[i]!
    if (r < cum) return { index: i, probs, candidates }
  }
  // 浮点误差导致 cum 差一点到 1 时的兜底：取最后一个非零候选
  for (let i = probs.length - 1; i >= 0; i--) {
    if (probs[i]! > 0) return { index: i, probs, candidates }
  }
  throw new Error('分布里没有任何非零候选')
}

/**
 * 分布的熵（比特）。度量「模型在这一步有多犹豫」。
 *
 * 熵接近 0 = 几乎确定；熵高 = 多个候选势均力敌。
 * 这是一个实用信号：生成里熵突然升高的位置，往往就是幻觉开始的位置。
 * L13 讲可观测性时会再见到它。
 */
export function entropy(probs: number[]): number {
  let h = 0
  for (const p of probs) {
    if (p > 0) h -= p * Math.log2(p)
  }
  return h
}
