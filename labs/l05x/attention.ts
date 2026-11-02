/**
 * L05x 任务一：手写 attention，量出 O(n²) 和 KV cache 的收益。
 *
 *   pnpm attention
 *
 * 不调 API，纯数值计算。写完后 pnpm verify:l05x 验证。
 * 参考实现在 shared/attention.ts，卡住了再看。
 */

import { randomMatrix, type Matrix } from '../shared/attention.ts'
import { isMain } from '../shared/entry.ts'

// ─────────────────────────────────────────────────────────────
// TODO 1：softmax
//
// 输入一组分数，输出和为 1 的概率。
//
// 必须做 max subtraction：先减去最大值再取 exp。
// 不做的话，分数到 1000 量级时 Math.exp 返回 Infinity，
// 然后 Infinity / Infinity = NaN。而 NaN 会静默传播——
// 你会在很远的地方才发现，且看不出源头。
//
// 减最大值不改变结果（分子分母同乘 e^-max），这是数学恒等式不是近似。
// ─────────────────────────────────────────────────────────────

export function softmax(scores: number[]): number[] {
  void scores
  throw new Error('TODO: 实现 softmax（记得 max subtraction）')
}

// ─────────────────────────────────────────────────────────────
// TODO 2：单头 attention
//
//   score(i,j) = Q_i · K_j / sqrt(dim)
//   weights    = softmax(scores)
//   out_i      = Σ_j weights(i,j) × V_j
//
// causal=true 时加因果掩码：位置 i 只能看 0..i，之后的位置分数设 -Infinity。
//
// 这里有本节最重要的一个坑：**忘了因果掩码，模型就能看到未来。**
// 它不会报错，反而会让指标变好——位置 i 的任务是预测 i+1，
// 如果它能看到 i+1，那预测当然准。这类 bug 只在上线后暴露。
//
// 返回 dotProducts（算了多少次点积），后面要用它量 O(n²)。
// ─────────────────────────────────────────────────────────────

export interface AttentionResult {
  out: Matrix
  weights: Matrix
  dotProducts: number
}

export function attention(
  Q: Matrix,
  K: Matrix,
  V: Matrix,
  opts: { causal?: boolean } = {},
): AttentionResult {
  void Q
  void K
  void V
  void opts
  throw new Error('TODO: 实现 attention（别忘因果掩码）')
}

// ─────────────────────────────────────────────────────────────
// TODO 3：KV cache
//
// 自回归生成时，前面 token 的 K/V 不会变，缓存起来复用。
// 这就是服务端 prompt 缓存缓存的东西。
//
// 需要：
//   append(k, v)        追加一个位置
//   view()              拿到已缓存的 K/V（返回引用，不要拷贝——拷贝就白缓存了）
//   invalidateFrom(i)   从第 i 个位置起全部作废，返回丢了多少个
//
// invalidateFrom 存在的意义是演示那条纪律：
// 前缀改一个 token，从那里往后的缓存全废。不是"差不多就行"。
//
// 顺带一个 JS 特有的坑，verify 会测：给 array.length 赋一个比当前更大的值，
// 数组会被撑长（用空洞填），于是"作废"变成了"扩容"。记得夹紧边界。
// ─────────────────────────────────────────────────────────────

export class KVCache {
  get length(): number {
    throw new Error('TODO: 实现 KVCache')
  }

  append(k: number[], v: number[]): void {
    void k
    void v
    throw new Error('TODO: 实现 append')
  }

  view(): { K: Matrix; V: Matrix } {
    throw new Error('TODO: 实现 view')
  }

  invalidateFrom(from: number): number {
    void from
    throw new Error('TODO: 实现 invalidateFrom')
  }
}

// ─────────────────────────────────────────────────────────────
// TODO 4：用 cache 走一步 decode
//
// 只算新 token 的 Q 对全部历史 K 的分数——O(n) 而不是 O(n²)。
// 这是自回归生成可行的原因。没有 cache 每步都要重跑前缀，总成本 O(n³)。
// ─────────────────────────────────────────────────────────────

export function decodeStep(
  q: number[],
  kNew: number[],
  vNew: number[],
  cache: KVCache,
): { out: number[]; dotProducts: number } {
  void q
  void kNew
  void vNew
  void cache
  throw new Error('TODO: 实现 decodeStep')
}

// ─────────────────────────────────────────────────────────────
// 下面是观察实验。上面写完了就能跑。
// ─────────────────────────────────────────────────────────────

const DIM = 16

function demoZeroSum() {
  console.log('\n【一】注意力是零和的')
  console.log('每一行权重加起来必须是 1。这不是巧合，是 softmax 的定义。\n')

  for (const n of [4, 16, 64]) {
    const Q = randomMatrix(n, DIM, 1)
    const K = randomMatrix(n, DIM, 2)
    const V = randomMatrix(n, DIM, 3)
    const { weights } = attention(Q, K, V, { causal: true })

    // 看最后一个位置：它能看到全部 n 个位置
    const last = weights[n - 1]!
    const sum = last.reduce((a: number, b: number) => a + b, 0)
    const max = Math.max(...last)
    const avg = 1 / n

    console.log(
      `  n=${String(n).padStart(3)} · 权重和=${sum.toFixed(6)} · ` +
        `最大权重=${max.toFixed(4)} · 平均=${avg.toFixed(4)}`,
    )
  }

  console.log('\n  平均权重 = 1/n。上下文长 10 倍，每个 token 平均分到的注意力少 10 倍。')
  console.log('  这就是「长上下文让模型变笨」的确切机制——不是模型累了，是注意力被稀释了。')
}

function demoQuadratic() {
  console.log('\n【二】O(n²)：n 翻倍，计算量翻四倍')
  console.log('看 dotProducts 这一列的比值。\n')

  let prev = 0
  for (const n of [32, 64, 128, 256]) {
    const Q = randomMatrix(n, DIM, 1)
    const K = randomMatrix(n, DIM, 2)
    const V = randomMatrix(n, DIM, 3)

    const t0 = performance.now()
    const { dotProducts } = attention(Q, K, V, { causal: true })
    const ms = performance.now() - t0

    const ratio = prev > 0 ? (dotProducts / prev).toFixed(2) : '—'
    console.log(
      `  n=${String(n).padStart(4)} · 点积=${String(dotProducts).padStart(6)} · ` +
        `比上一行=${ratio.padStart(5)}× · 耗时=${ms.toFixed(1)}ms`,
    )
    prev = dotProducts
  }

  console.log('\n  比值稳定在 4 左右。这是架构性的，不是实现不够优化。')
  console.log('  128K 上下文相对 1K 是 16384 倍——这就是长上下文贵和 TTFT 超线性的根源。')
}

function demoKVCache() {
  console.log('\n【三】KV cache 省了多少')
  console.log('生成 n 个 token，对比「每步重算全部」和「用 cache」。\n')

  for (const n of [16, 64, 256]) {
    const Q = randomMatrix(n, DIM, 1)
    const K = randomMatrix(n, DIM, 2)
    const V = randomMatrix(n, DIM, 3)

    // 无 cache：生成第 i 个 token 时把 0..i 全部重算一遍
    let naive = 0
    for (let i = 1; i <= n; i++) {
      const r = attention(Q.slice(0, i), K.slice(0, i), V.slice(0, i), { causal: true })
      naive += r.dotProducts
    }

    // 有 cache：每步只算新 token 对历史的点积
    const cache = new KVCache()
    let cached = 0
    for (let i = 0; i < n; i++) {
      cached += decodeStep(Q[i]!, K[i]!, V[i]!, cache).dotProducts
    }

    console.log(
      `  n=${String(n).padStart(4)} · 重算=${String(naive).padStart(7)} · ` +
        `用 cache=${String(cached).padStart(6)} · 省了 ${(naive / cached).toFixed(1)}×`,
    )
  }

  console.log('\n  重算是 O(n³)，用 cache 是 O(n²)。n 越大差距越大。')
  console.log('  没有 KV cache，自回归生成根本跑不起来。')
}

function demoPrefixInvalidation() {
  console.log('\n【四】改一个 token，后面的缓存全废')
  console.log('模拟服务端判断 prompt 缓存能复用多少。\n')

  const total = 100
  const cases: Array<[string, number]> = [
    ['前缀完全一致', total],
    ['第 2 个 token 变了（时间戳放在 system prompt 第二行）', 1],
    ['第 50 个 token 变了', 49],
    ['第 99 个 token 变了', 98],
  ]

  for (const [label, sharedLen] of cases) {
    const cache = new KVCache()
    for (let i = 0; i < total; i++) cache.append([i], [i])
    const dropped = cache.invalidateFrom(sharedLen)
    const hitRate = ((sharedLen / total) * 100).toFixed(0)
    console.log(`  ${label}`)
    console.log(`    命中 ${sharedLen}/${total}（${hitRate}%）· 作废 ${dropped} 个`)
  }

  console.log('\n  注意第二行：只改了第 2 个 token，99% 的缓存作废。')
  console.log('  这就是 L03 那道改错题的机制——时间戳放前面，毁掉的是它后面的全部。')
  console.log('  修法永远是：会变的东西挪到消息末尾。')
}

// ─────────────────────────────────────────────────────────────
// TODO 5：亲手验证因果掩码
//
// 把 attention 的 causal 参数改成 false，重新跑【一】。
// 观察最后一个位置的权重有什么变化？倒数第二个位置呢？
//
// 然后回答：如果一个模型训练时漏了因果掩码，
// 训练集上的 loss 会变高还是变低？为什么这个 bug 特别危险？
// ─────────────────────────────────────────────────────────────

function main() {
  console.log('把 attention 拆开看。不调 API，纯数值。')
  demoZeroSum()
  demoQuadratic()
  demoKVCache()
  demoPrefixInvalidation()
  console.log('\n' + '─'.repeat(60))
  console.log('四个实验对应四条你已经背过的纪律。现在它们有机制了。')
  console.log('别忘了 TODO 5：把 causal 关掉再跑一次。')
}

// verify.ts 会 import 这个文件来测你写的函数。不加这道判断的话，
// import 的那一刻观察实验就跑起来了，verify 的输出会变成第一个 TODO
// 的堆栈，而不是一张「还有哪些没写」的清单。
if (isMain(import.meta.url)) main()
