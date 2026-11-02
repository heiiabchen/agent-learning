/**
 * 验证 l05x/attention.ts 和 l05x/decode.ts。跑法：pnpm verify:l05x
 *
 * 纯数值，一次 API 都不调，也不需要 .env。
 *
 * 这套测试里有几条专门盯着「静默失败」：
 * 因果掩码漏了不会报错（反而指标变好），softmax 溢出给的是 NaN 不是异常，
 * top_p 截断到空集给的是 NaN。这三个都不会主动告诉你。
 *
 * 先跑 VERIFY_TARGET=shared 确认测试本身是对的。
 */
import { randomMatrix, type Matrix } from '../shared/attention.ts'

/**
 * 两个实现的形状必须一致，所以这里显式声明模块接口。
 *
 * 顺带解决一个真实的 TS 问题：两个 import 各自给出一个 class 类型，
 * 而 shared 那份的 KVCache 有 private 字段——private 让类型变成名义的，
 * 两个 KVCache 就不再互相兼容了。声明一个只含方法的接口能绕开它，
 * 因为接口里的方法签名是双变的。
 */
interface KVCacheLike {
  readonly length: number
  append(k: number[], v: number[]): void
  view(): { K: Matrix; V: Matrix }
  invalidateFrom(from: number): number
}

interface AttentionModule {
  softmax(scores: number[]): number[]
  attention(
    Q: Matrix,
    K: Matrix,
    V: Matrix,
    opts?: { causal?: boolean },
  ): { out: Matrix; weights: Matrix; dotProducts: number }
  KVCache: new () => KVCacheLike
  decodeStep(
    q: number[],
    kNew: number[],
    vNew: number[],
    cache: KVCacheLike,
  ): { out: number[]; dotProducts: number }
}

const target = process.env.VERIFY_TARGET === 'shared' ? 'shared' : 'mine'
const A: AttentionModule =
  target === 'shared' ? await import('../shared/attention.ts') : await import('./attention.ts')
const D = target === 'shared' ? await import('../shared/decode.ts') : await import('./decode.ts')

console.log(
  target === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l05x/ 里你的实现）',
)

let passed = 0
const failures: string[] = []

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`\x1b[32m  ✓\x1b[0m ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`\x1b[31m  ✕ ${name}\x1b[0m`)
    console.log(`\x1b[31m      ${(err as Error).message}\x1b[0m`)
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

function close(actual: number, expected: number, tol: number, hint = '') {
  if (!Number.isFinite(actual)) {
    throw new Error(`得到了 ${actual}（不是有限数）${hint ? `\n      ${hint}` : ''}`)
  }
  if (Math.abs(actual - expected) > tol) {
    throw new Error(
      `期待 ${expected} ± ${tol}，实际 ${actual}${hint ? `\n      ${hint}` : ''}`,
    )
  }
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}

/** 下标访问。noUncheckedIndexedAccess 开着，越界要响而不是给 undefined */
function at<T>(xs: readonly T[], i: number): T {
  const v = xs[i]
  if (v === undefined) throw new Error(`下标 ${i} 越界（长度 ${xs.length}）`)
  return v
}

function raises(fn: () => unknown, hint: string) {
  try {
    fn()
  } catch {
    return
  }
  throw new Error(`应该抛异常但没有：${hint}`)
}

const DIM = 8

// ─────────────────────────────────────────────────────────────
console.log('\nsoftmax')
// ─────────────────────────────────────────────────────────────

await test('输出和为 1', () => {
  const p = A.softmax([1, 2, 3, 4])
  close(sum(p), 1, 1e-10)
})

await test('单调性：分数大的概率大', () => {
  const p = A.softmax([1, 5, 3])
  assert(at(p, 1) > at(p, 2) && at(p, 2) > at(p, 0), `顺序错了：${JSON.stringify(p)}`)
})

await test('全相等的分数给出均匀分布', () => {
  const p = A.softmax([2, 2, 2, 2])
  for (const x of p) close(x, 0.25, 1e-10)
})

await test('平移不变：整体加常数不改变结果', () => {
  const a = A.softmax([1, 2, 3])
  const b = A.softmax([101, 102, 103])
  for (let i = 0; i < 3; i++) close(at(b, i), at(a, i), 1e-9, '这是 softmax 的数学性质')
})

await test('大数不溢出（忘了 max subtraction 会得到 NaN）', () => {
  const p = A.softmax([1000, 999, 998])
  close(sum(p), 1, 1e-10, 'Math.exp(1000) = Infinity，然后 Infinity/Infinity = NaN')
  assert(
    p.every((x) => Number.isFinite(x)),
    `出现了非有限值：${JSON.stringify(p)}`,
  )
})

await test('极小数也不出 NaN', () => {
  const p = A.softmax([-1000, -1001, -1002])
  close(sum(p), 1, 1e-10)
})

await test('被掩码位置（-Infinity）的概率是 0', () => {
  const p = A.softmax([2, -Infinity, 1])
  close(at(p, 1), 0, 1e-15, '-Infinity 的 exp 是 0，所以掩码有效')
  close(sum(p), 1, 1e-10)
})

// ─────────────────────────────────────────────────────────────
console.log('\nattention')
// ─────────────────────────────────────────────────────────────

const Q = randomMatrix(6, DIM, 11)
const K = randomMatrix(6, DIM, 22)
const V = randomMatrix(6, DIM, 33)

await test('每一行权重和为 1', () => {
  const { weights } = A.attention(Q, K, V, { causal: true })
  for (let i = 0; i < weights.length; i++) {
    close(sum(at(weights, i)), 1, 1e-9, `第 ${i} 行`)
  }
})

await test('因果掩码：位置 i 看不到 i 之后（漏了这条模型能看到未来）', () => {
  const { weights } = A.attention(Q, K, V, { causal: true })
  for (let i = 0; i < weights.length; i++) {
    const row = at(weights, i)
    for (let j = i + 1; j < row.length; j++) {
      close(
        at(row, j),
        0,
        1e-15,
        `位置 ${i} 分给了未来位置 ${j} 权重 ${at(row, j)}。\n` +
          '      这个 bug 不报错，反而让训练指标变好——位置 i 在抄 i+1 的答案。',
      )
    }
  }
})

await test('第一个位置只能看自己，权重必然是 1', () => {
  const { weights } = A.attention(Q, K, V, { causal: true })
  close(at(at(weights, 0), 0), 1, 1e-12, '它前面没有别的位置，softmax 单元素必然是 1')
})

await test('causal=false 时能看到全部位置', () => {
  const { weights } = A.attention(Q, K, V, { causal: false })
  const firstRow = at(weights, 0)
  const nonzero = firstRow.filter((w) => w > 1e-12).length
  assert(nonzero === 6, `期待 6 个非零权重，实际 ${nonzero}`)
})

await test('输出是 V 的凸组合（不会超出 V 的取值范围）', () => {
  const { out } = A.attention(Q, K, V, { causal: true })
  for (let d = 0; d < DIM; d++) {
    const col = V.map((row) => at(row, d))
    const lo = Math.min(...col)
    const hi = Math.max(...col)
    for (let i = 0; i < out.length; i++) {
      const got = at(at(out, i), d)
      assert(
        got >= lo - 1e-9 && got <= hi + 1e-9,
        `out[${i}][${d}]=${got} 超出了 V 的范围 [${lo}, ${hi}]。` +
          '权重和为 1 且非负时，加权平均必然落在原值范围内',
      )
    }
  }
})

await test('点积次数是 n(n+1)/2（因果掩码省掉一半）', () => {
  for (const n of [4, 10, 20]) {
    const r = A.attention(
      randomMatrix(n, DIM, 1),
      randomMatrix(n, DIM, 2),
      randomMatrix(n, DIM, 3),
      { causal: true },
    )
    const expected = (n * (n + 1)) / 2
    assert(
      r.dotProducts === expected,
      `n=${n} 时期待 ${expected} 次点积，实际 ${r.dotProducts}`,
    )
  }
})

await test('O(n²)：n 翻倍点积次数约翻四倍', () => {
  const at = (n: number) =>
    A.attention(randomMatrix(n, DIM, 1), randomMatrix(n, DIM, 2), randomMatrix(n, DIM, 3), {
      causal: true,
    }).dotProducts
  const ratio = at(200) / at(100)
  close(ratio, 4, 0.1, '这是架构性的平方，不是实现问题')
})

await test('注意力稀释：n 越大，平均权重越小', () => {
  const avgMax = (n: number) => {
    const { weights } = A.attention(
      randomMatrix(n, DIM, 7),
      randomMatrix(n, DIM, 8),
      randomMatrix(n, DIM, 9),
      { causal: true },
    )
    const last = at(weights, n - 1)
    return 1 / last.filter((w) => w > 1e-15).length
  }
  const small = avgMax(8)
  const large = avgMax(128)
  assert(
    large < small / 10,
    `n=8 平均权重 ${small}，n=128 平均权重 ${large}。应该差一个数量级以上`,
  )
})

await test('长度不一致时报错，而不是静默算错', () => {
  raises(
    () => A.attention(randomMatrix(4, DIM, 1), randomMatrix(3, DIM, 2), randomMatrix(4, DIM, 3)),
    'Q 和 K 长度不同',
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\nKV cache')
// ─────────────────────────────────────────────────────────────

await test('append 后 length 增长', () => {
  const c = new A.KVCache()
  const before = c.length
  assert(before === 0, `新建的 cache 应该是空的，实际 ${before}`)
  c.append([1, 2], [3, 4])
  c.append([5, 6], [7, 8])
  assert(c.length === 2, `期待 2，实际 ${c.length}`)
})

await test('view 返回已缓存的 K/V', () => {
  const c = new A.KVCache()
  c.append([1], [10])
  c.append([2], [20])
  const { K: ck, V: cv } = c.view()
  assert(ck.length === 2 && cv.length === 2, '长度不对')
  assert(
    at(at(ck, 0), 0) === 1 && at(at(cv, 1), 0) === 20,
    `内容不对：${JSON.stringify({ ck, cv })}`,
  )
})

await test('invalidateFrom 砍掉之后的全部', () => {
  const c = new A.KVCache()
  for (let i = 0; i < 10; i++) c.append([i], [i])
  const dropped = c.invalidateFrom(3)
  assert(dropped === 7, `期待丢 7 个，实际 ${dropped}`)
  assert(c.length === 3, `期待剩 3 个，实际 ${c.length}`)
})

await test('invalidateFrom(1) 几乎全废（时间戳放第二行的代价）', () => {
  const c = new A.KVCache()
  for (let i = 0; i < 100; i++) c.append([i], [i])
  const dropped = c.invalidateFrom(1)
  assert(dropped === 99, `期待丢 99 个，实际 ${dropped}`)
})

await test('invalidateFrom 超出长度时不会给出负数', () => {
  const c = new A.KVCache()
  c.append([1], [1])
  const dropped = c.invalidateFrom(5)
  assert(dropped >= 0, `丢弃数不该是负数，实际 ${dropped}`)
  assert(c.length === 1, `不该增长，实际 ${c.length}`)
})

await test('decodeStep 每步只算 O(n) 次点积', () => {
  const c = new A.KVCache()
  const counts: number[] = []
  for (let i = 0; i < 5; i++) {
    counts.push(A.decodeStep(at(Q, i), at(K, i), at(V, i), c).dotProducts)
  }
  // 第 i 步（0-indexed）缓存里有 i+1 个位置
  for (let i = 0; i < 5; i++) {
    assert(at(counts, i) === i + 1, `第 ${i} 步期待 ${i + 1} 次点积，实际 ${at(counts, i)}`)
  }
})

await test('decodeStep 的结果和一次性 attention 一致', () => {
  const n = 6
  const full = A.attention(Q, K, V, { causal: true })
  const c = new A.KVCache()
  const stepped: Matrix = []
  for (let i = 0; i < n; i++) {
    stepped.push(A.decodeStep(at(Q, i), at(K, i), at(V, i), c).out)
  }
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < DIM; d++) {
      close(
        at(at(stepped, i), d),
        at(at(full.out, i), d),
        1e-9,
        `位置 ${i} 维度 ${d} 不一致。增量解码必须等价于一次性计算，` +
          '否则 prefill 和 decode 会给出不同结果',
      )
    }
  }
})

await test('用 cache 比每步重算省得越来越多', () => {
  const savings = (n: number) => {
    let naive = 0
    for (let i = 1; i <= n; i++) {
      naive += A.attention(Q.slice(0, i), K.slice(0, i), V.slice(0, i), { causal: true })
        .dotProducts
    }
    const c = new A.KVCache()
    let cached = 0
    for (let i = 0; i < n; i++) cached += A.decodeStep(at(Q, i), at(K, i), at(V, i), c).dotProducts
    return naive / cached
  }
  const s3 = savings(3)
  const s6 = savings(6)
  assert(s6 > s3, `n=3 省 ${s3.toFixed(2)}×，n=6 省 ${s6.toFixed(2)}×。应该递增`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n温度')
// ─────────────────────────────────────────────────────────────

const LOGITS = [5, 3, 1, -1]

await test('T=1 不改变 logits', () => {
  const out = D.applyTemperature(LOGITS, 1)
  for (let i = 0; i < LOGITS.length; i++) close(at(out, i), at(LOGITS, i), 1e-12)
})

await test('T<1 放大差距', () => {
  const p1 = A.softmax(D.applyTemperature(LOGITS, 1))
  const p2 = A.softmax(D.applyTemperature(LOGITS, 0.5))
  assert(Math.max(...p2) > Math.max(...p1), 'T 小了 top1 概率应该更高')
})

await test('T>1 压缩差距', () => {
  const p1 = A.softmax(D.applyTemperature(LOGITS, 1))
  const p2 = A.softmax(D.applyTemperature(LOGITS, 3))
  assert(Math.max(...p2) < Math.max(...p1), 'T 大了 top1 概率应该更低')
})

await test('T=0 退化成 one-hot（不是 NaN，也不是多个 1）', () => {
  const p = A.softmax(D.applyTemperature(LOGITS, 0))
  close(sum(p), 1, 1e-12, 'T=0 时直接做除法会得到 Infinity 或 NaN')
  close(at(p, 0), 1, 1e-12, '最大值的位置应该是 1')
  for (let i = 1; i < p.length; i++) close(at(p, i), 0, 1e-15)
})

await test('T=0 且有并列最大值时只选一个', () => {
  const p = A.softmax(D.applyTemperature([5, 5, 1], 0))
  close(sum(p), 1, 1e-12, '两个位置都给 0 的话 softmax 后各是 0.5，总和还是 1 但不是 one-hot')
  const ones = p.filter((x) => x > 0.99).length
  assert(ones === 1, `期待恰好 1 个位置接近 1，实际 ${ones} 个：${JSON.stringify(p)}`)
})

await test('负温度报错', () => {
  raises(() => D.applyTemperature(LOGITS, -1), 'temperature 不能是负数')
})

// ─────────────────────────────────────────────────────────────
console.log('\ntop-k / top-p')
// ─────────────────────────────────────────────────────────────

const PROBS = [0.5, 0.25, 0.15, 0.07, 0.03]

await test('top_k 只留 k 个', () => {
  const out = D.applyTopK(PROBS, 2)
  assert(out.filter((p) => p > 0).length === 2, `期待 2 个候选，实际 ${out.filter((p) => p > 0).length}`)
  close(sum(out), 1, 1e-12, '截断后要重新归一化')
})

await test('top_k 留下的是概率最大的', () => {
  const out = D.applyTopK(PROBS, 2)
  assert(at(out, 0) > 0 && at(out, 1) > 0, '前两个应该保留')
  assert(at(out, 2) === 0 && at(out, 4) === 0, '后面的应该删掉')
})

await test('top_k >= 长度时不截断', () => {
  const out = D.applyTopK(PROBS, 99)
  for (let i = 0; i < PROBS.length; i++) close(at(out, i), at(PROBS, i), 1e-12)
})

await test('top_p 按累积概率截断', () => {
  // 0.5 + 0.25 = 0.75 < 0.8，再加 0.15 到 0.9 >= 0.8 → 留 3 个
  const out = D.applyTopP(PROBS, 0.8)
  const n = out.filter((p) => p > 0).length
  assert(n === 3, `期待 3 个候选，实际 ${n}：${JSON.stringify(out)}`)
  close(sum(out), 1, 1e-12)
})

await test('top_p 小于 top1 概率时仍留一个（不是 NaN）', () => {
  const out = D.applyTopP([0.9, 0.05, 0.05], 0.3)
  const n = out.filter((p) => p > 0).length
  assert(
    n === 1,
    `期待留 1 个，实际 ${n}。\n` +
      '      「先判断累积再决定加入」的写法在这里会留 0 个，然后归一化除以 0 得到 NaN。\n' +
      '      正确顺序是先加入再判断够不够。',
  )
  assert(
    out.every((p) => Number.isFinite(p)),
    `出现了非有限值：${JSON.stringify(out)}`,
  )
  close(sum(out), 1, 1e-12)
})

await test('top_p=1 不截断', () => {
  const out = D.applyTopP(PROBS, 1)
  assert(out.filter((p) => p > 0).length === PROBS.length, '不该删任何东西')
})

await test('top_p 越小候选越少', () => {
  const counts = [0.99, 0.9, 0.7, 0.5].map((p) => D.applyTopP(PROBS, p).filter((x) => x > 0).length)
  for (let i = 1; i < counts.length; i++) {
    assert(at(counts, i) <= at(counts, i - 1), `候选数应该单调不增，实际 ${JSON.stringify(counts)}`)
  }
})

await test('top_p <= 0 报错', () => {
  raises(() => D.applyTopP(PROBS, 0), 'top_p 必须大于 0')
})

// ─────────────────────────────────────────────────────────────
console.log('\n采样')
// ─────────────────────────────────────────────────────────────

/** 固定的随机序列，让采样测试确定 */
function fixedRand(...values: number[]): () => number {
  let i = 0
  return () => at(values, Math.min(i++, values.length - 1))
}

await test('T=0 总是选最大的', () => {
  for (const r of [0, 0.3, 0.99]) {
    const { index } = D.sample([1, 9, 3], { temperature: 0, rand: fixedRand(r) })
    assert(index === 1, `rand=${r} 时期待下标 1，实际 ${index}`)
  }
})

await test('随机源决定选哪个（可注入 = 可测试）', () => {
  // logits 相等 → 均匀分布，四个各 0.25
  const logits = [0, 0, 0, 0]
  const picks = [0.1, 0.3, 0.6, 0.9].map(
    (r) => D.sample(logits, { rand: fixedRand(r) }).index,
  )
  assert(
    JSON.stringify(picks) === JSON.stringify([0, 1, 2, 3]),
    `期待 [0,1,2,3]，实际 ${JSON.stringify(picks)}。累积分布抽签的边界要对`,
  )
})

await test('rand 接近 1 时不会越界', () => {
  const { index } = D.sample([1, 2, 3], { rand: fixedRand(0.9999999999) })
  assert(index >= 0 && index <= 2, `下标越界：${index}`)
})

await test('返回的 candidates 反映截断后的候选数', () => {
  const a = D.sample(LOGITS, { rand: fixedRand(0.5) })
  const b = D.sample(LOGITS, { topK: 2, rand: fixedRand(0.5) })
  assert(a.candidates === 4, `不截断时期待 4，实际 ${a.candidates}`)
  assert(b.candidates === 2, `top_k=2 时期待 2，实际 ${b.candidates}`)
})

await test('返回的 probs 是截断后的分布，和为 1', () => {
  const { probs } = D.sample(LOGITS, { topP: 0.7, rand: fixedRand(0.1) })
  close(sum(probs), 1, 1e-12)
})

await test('温度 + top_p 组合：候选被压缩', () => {
  const hot = D.sample(LOGITS, { temperature: 3, rand: fixedRand(0.5) })
  const hotClipped = D.sample(LOGITS, { temperature: 3, topP: 0.6, rand: fixedRand(0.5) })
  assert(
    hotClipped.candidates < hot.candidates,
    `高温 ${hot.candidates} 个候选，加 top_p 后 ${hotClipped.candidates} 个。应该更少`,
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n熵')
// ─────────────────────────────────────────────────────────────

await test('均匀分布的熵是 log2(n)', () => {
  close(D.entropy([0.25, 0.25, 0.25, 0.25]), 2, 1e-10, '四个等概率 = 2 bit')
  close(D.entropy([0.5, 0.5]), 1, 1e-10)
})

await test('one-hot 的熵是 0', () => {
  close(D.entropy([1, 0, 0, 0]), 0, 1e-12, 'p=0 的项要跳过，否则 log2(0) = -Infinity')
})

await test('分布越集中熵越低', () => {
  const spread = D.entropy(A.softmax(D.applyTemperature(LOGITS, 2)))
  const sharp = D.entropy(A.softmax(D.applyTemperature(LOGITS, 0.3)))
  assert(sharp < spread, `T=0.3 熵 ${sharp.toFixed(3)} 应该低于 T=2 熵 ${spread.toFixed(3)}`)
})

await test('T=0 的熵是 0（完全确定）', () => {
  close(D.entropy(A.softmax(D.applyTemperature(LOGITS, 0))), 0, 1e-10)
})

// ─────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60))
if (failures.length === 0) {
  console.log(`\x1b[32m${passed} 项全过。\x1b[0m`)
  console.log('\n黑盒拆完了。回去把 attention.ts 的 TODO 5 和 decode.ts 的 TODO 6 做掉。')
} else {
  console.log(`\x1b[31m${passed} 过，${failures.length} 败：\x1b[0m`)
  for (const f of failures) console.log(`\x1b[31m  · ${f}\x1b[0m`)
  process.exitCode = 1
}
