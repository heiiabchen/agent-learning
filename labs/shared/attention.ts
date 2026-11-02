/**
 * 参考实现：attention 的最小可运行版本。
 *
 * 这里刻意用纯数组而不是任何数值库，因为目的不是快，是让每一步可见。
 * 真实实现在 CUDA 里，形状和优化完全不同，但数学是这一份。
 *
 * 对照 shared/attention.py，那一份用 numpy，短得多——那个差距本身是这节课的一个论点。
 */

export type Matrix = number[][]

/**
 * softmax，带 max subtraction。
 *
 * 减最大值不改变结果（分子分母同乘 e^-max），但保证最大的指数项是 e^0 = 1。
 * 不减的话，分数到 1000 量级时 Math.exp 直接返回 Infinity，
 * 然后 Infinity / Infinity = NaN，而 NaN 会静默传播到很远的地方。
 *
 * numpy 和 PyTorch 都内置了这一步，所以平时遇不到。手写就必须自己做。
 */
export function softmax(scores: number[]): number[] {
  if (scores.length === 0) return []
  const max = Math.max(...scores)
  // 全是 -Infinity（被掩码全挡）时，max 也是 -Infinity，exp(NaN)。
  // 这在因果掩码里不会发生（至少能看到自己），但断言一下比调试 NaN 便宜。
  if (!Number.isFinite(max)) {
    throw new Error('softmax 收到了全是 -Infinity 的分数，检查掩码是不是把整行都挡了')
  }
  const exp = scores.map((s) => Math.exp(s - max))
  const sum = exp.reduce((a, b) => a + b, 0)
  return exp.map((e) => e / sum)
}

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!
  return sum
}

export interface AttentionResult {
  /** 每个位置的输出向量 */
  out: Matrix
  /** weights[i][j] = 位置 i 分给位置 j 的注意力。被掩码的位置是 0 */
  weights: Matrix
  /** 算了多少次点积。用来量 O(n²) */
  dotProducts: number
}

/**
 * 单头 attention。
 *
 * causal=true 时加因果掩码：位置 i 只能看到 0..i。
 * 这是 decoder-only 模型的必需项——少了它，模型能看到未来，
 * 训练指标会好得离谱，上线后崩盘。
 */
export function attention(
  Q: Matrix,
  K: Matrix,
  V: Matrix,
  opts: { causal?: boolean } = {},
): AttentionResult {
  const causal = opts.causal ?? true
  const n = Q.length
  if (K.length !== n || V.length !== n) {
    throw new Error(`Q/K/V 长度必须一致，收到 ${n}/${K.length}/${V.length}`)
  }
  if (n === 0) return { out: [], weights: [], dotProducts: 0 }

  const dim = Q[0]!.length
  const vDim = V[0]!.length
  const scale = Math.sqrt(dim)

  const out: Matrix = []
  const weights: Matrix = []
  let dotProducts = 0

  for (let i = 0; i < n; i++) {
    const qi = Q[i]!
    // 因果掩码在这里：上界是 i 而不是 n-1。
    // 注意这也顺手把计算量从 n² 减到 n²/2——这就是为什么 attention 的
    // 计算量常被写成 n²/2。
    const limit = causal ? i : n - 1

    const scores: number[] = []
    for (let j = 0; j < n; j++) {
      if (j > limit) {
        scores.push(-Infinity) // 掩码：softmax 后必然是 0
        continue
      }
      scores.push(dot(qi, K[j]!) / scale)
      dotProducts++
    }

    const w = softmax(scores)
    weights.push(w)

    const o: number[] = new Array(vDim).fill(0)
    for (let j = 0; j <= limit; j++) {
      const wj = w[j]!
      const vj = V[j]!
      for (let d = 0; d < vDim; d++) o[d]! += wj * vj[d]!
    }
    out.push(o)
  }

  return { out, weights, dotProducts }
}

/**
 * KV cache：自回归生成时复用前面算好的 K/V。
 *
 * 这就是 prompt 缓存在服务端缓存的东西。也是为什么前缀必须逐 token 一致：
 * append 是顺序的，第 k 个位置之后的内容依赖前 k 个，中间改一个就得从那里重来。
 */
export class KVCache {
  private readonly K: Matrix = []
  private readonly V: Matrix = []

  get length(): number {
    return this.K.length
  }

  append(k: number[], v: number[]): void {
    this.K.push(k)
    this.V.push(v)
  }

  /** 已缓存的 K/V。返回引用而非拷贝，真实实现同样不拷贝——拷贝就白缓存了 */
  view(): { K: Matrix; V: Matrix } {
    return { K: this.K, V: this.V }
  }

  /**
   * 从第 from 个位置开始失效。
   *
   * 这个方法存在的意义就是演示那条纪律：改动一个位置，它之后的全部作废。
   * 不是"差不多就行"，是从第一个差异点开始全废。
   */
  invalidateFrom(from: number): number {
    // 必须夹紧：给 array.length 赋一个更大的值会把数组撑长（用空洞填），
    // 于是"作废"反而变成了"扩容"。这个坑不报错，后面才炸。
    const cut = Math.max(0, Math.min(from, this.K.length))
    const dropped = this.K.length - cut
    this.K.length = cut
    this.V.length = cut
    return dropped
  }

  /** 找出两个 token 序列的公共前缀长度。服务端判断缓存能复用多少就是干这个 */
  static sharedPrefix(a: readonly unknown[], b: readonly unknown[]): number {
    const n = Math.min(a.length, b.length)
    let i = 0
    while (i < n && JSON.stringify(a[i]) === JSON.stringify(b[i])) i++
    return i
  }
}

export interface DecodeStep {
  /** 这一步的输出向量 */
  out: number[]
  /** 这一步算了多少次点积 */
  dotProducts: number
}

/**
 * 用 KV cache 生成一个 token：只算新 token 的 Q，对全部历史 K 做点积。
 *
 * 每步 O(n) 而不是 O(n²)——这是自回归可行的原因。
 * 没有 cache 的话每步都要重跑整个前缀，总成本 O(n³)。
 */
export function decodeStep(q: number[], kNew: number[], vNew: number[], cache: KVCache): DecodeStep {
  cache.append(kNew, vNew)
  const { K, V } = cache.view()
  const dim = q.length
  const scale = Math.sqrt(dim)

  const scores = K.map((k) => dot(q, k) / scale)
  const w = softmax(scores)

  const vDim = V[0]!.length
  const out: number[] = new Array(vDim).fill(0)
  for (let j = 0; j < V.length; j++) {
    const wj = w[j]!
    const vj = V[j]!
    for (let d = 0; d < vDim; d++) out[d]! += wj * vj[d]!
  }

  return { out, dotProducts: K.length }
}

/** 造可复现的伪随机矩阵。测试要确定，所以不用 Math.random */
export function randomMatrix(rows: number, cols: number, seed = 1): Matrix {
  let s = seed
  const next = () => {
    // xorshift32：够随机，且跨语言可复现
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s |= 0
    return (s >>> 0) / 4294967296
  }
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => next() * 2 - 1))
}
