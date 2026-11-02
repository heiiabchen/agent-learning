/**
 * L05x 任务二：手写采样。把 temperature / top_p / top_k 从黑盒变成四十行代码。
 *
 *   pnpm decode
 *
 * 不调 API。参考实现在 shared/decode.ts。
 */

import { softmax } from '../shared/attention.ts'
import { isMain } from '../shared/entry.ts'

// ─────────────────────────────────────────────────────────────
// TODO 1：温度缩放
//
//   logits / T
//
// T < 1 放大差距（更确定），T > 1 压缩差距（更随机）。
//
// T = 0 是特例，不能真的做除法（得到 Infinity 或 NaN）。
// 它的语义是 argmax。一个干净的做法：最大值给 0，其余给 -Infinity，
// softmax 之后就是 one-hot——这样后面的步骤不用为 T=0 分叉。
//
// 坑：有并列最大值时，只能取第一个。否则 one-hot 里会出现多个 1。
// ─────────────────────────────────────────────────────────────

export function applyTemperature(logits: number[], temperature: number): number[] {
  void logits
  void temperature
  throw new Error('TODO: 实现 applyTemperature')
}

// ─────────────────────────────────────────────────────────────
// TODO 2：top-k 截断
//
// 只留概率最大的 k 个，其余设 0，然后重新归一化。
// k <= 0 或 k >= 长度时不截断。
// ─────────────────────────────────────────────────────────────

export function applyTopK(probs: number[], k: number): number[] {
  void probs
  void k
  throw new Error('TODO: 实现 applyTopK')
}

// ─────────────────────────────────────────────────────────────
// TODO 3：top-p（nucleus）截断
//
// 按概率降序累加，到 p 为止，其余删掉，重新归一化。
//
// 关键坑：**至少要留一个候选。**
// 如果 top1 的概率已经超过 p（比如 p=0.5 而 top1=0.9），
// 朴素的「先判断再加入」会一个都不留，然后归一化除以 0 得到 NaN。
// 正确顺序是先加入再判断是否够了。
// ─────────────────────────────────────────────────────────────

export function applyTopP(probs: number[], p: number): number[] {
  void probs
  void p
  throw new Error('TODO: 实现 applyTopP')
}

// ─────────────────────────────────────────────────────────────
// TODO 4：完整采样
//
//   温度 → softmax → top_k → top_p → 按累积分布抽签
//
// 顺序有讲究：温度作用在 logits 上（softmax 之前），
// 截断作用在概率上（softmax 之后，因为要用累积概率判断）。
//
// rand 参数用来注入随机源——测试必须确定，不能用 Math.random。
// 这个模式你在 L05 的 fakeModel 里见过：把不确定性变成可注入的依赖。
// ─────────────────────────────────────────────────────────────

export interface SampleResult {
  index: number
  probs: number[]
  candidates: number
}

export function sample(
  logits: number[],
  opts: { temperature?: number; topP?: number; topK?: number; rand?: () => number } = {},
): SampleResult {
  void logits
  void opts
  throw new Error('TODO: 实现 sample')
}

// ─────────────────────────────────────────────────────────────
// TODO 5：熵
//
//   H = -Σ p·log2(p)，跳过 p=0
//
// 度量「模型在这一步有多犹豫」。熵接近 0 = 几乎确定。
// 实用价值：生成里熵突然升高的位置，往往就是幻觉开始的位置。L13 会再用它。
// ─────────────────────────────────────────────────────────────

export function entropy(probs: number[]): number {
  void probs
  throw new Error('TODO: 实现 entropy')
}

// ─────────────────────────────────────────────────────────────
// 观察实验
// ─────────────────────────────────────────────────────────────

/** 一个模拟的 logits 分布：一个明显的赢家、几个陪跑、一条长尾 */
const LOGITS = [8.2, 7.9, 6.1, 4.3, 3.8, 2.1, 1.4, 0.9, 0.2, -0.5, -1.2, -2.8]
const LABELS = ['的', '是', '在', '有', '和', '了', '不', '也', '就', '很', '把', '啊']

function show(probs: number[], indent = '    ') {
  const rows = probs
    .map((p, i) => ({ p, label: LABELS[i] ?? `#${i}` }))
    .filter((r) => r.p > 0.0001)
    .sort((a, b) => b.p - a.p)
    .slice(0, 6)
  for (const r of rows) {
    const bar = '█'.repeat(Math.max(1, Math.round(r.p * 40)))
    console.log(`${indent}${r.label}  ${(r.p * 100).toFixed(1).padStart(5)}%  ${bar}`)
  }
}

function demoTemperature() {
  console.log('\n【一】温度改变了什么')
  console.log('同一组 logits，不同温度。看分布的形状。\n')

  for (const T of [0.1, 0.7, 1.0, 1.5, 2.5]) {
    const probs = softmax(applyTemperature(LOGITS, T))
    const h = entropy(probs)
    const top1 = Math.max(...probs)
    console.log(`  T=${T.toFixed(1)} · top1=${(top1 * 100).toFixed(1)}% · 熵=${h.toFixed(2)} bit`)
    show(probs)
    console.log()
  }

  console.log('  T 小 → top1 接近 100%，熵趋近 0，几乎确定。')
  console.log('  T 大 → 概率被抹平，熵上升，长尾的怪词也有机会。')
  console.log('  这就是 L01 那个「温度调高输出更发散」的机制。')
}

function demoTruncation() {
  console.log('\n【二】top_p 在删什么')
  console.log('T=1 固定，只改 top_p。看候选数。\n')

  for (const p of [0.5, 0.8, 0.9, 0.95, 1.0]) {
    const base = softmax(applyTemperature(LOGITS, 1))
    const probs = p < 1 ? applyTopP(base, p) : base
    const n = probs.filter((x: number) => x > 0).length
    console.log(`  top_p=${p.toFixed(2)} · 候选 ${n}/${LOGITS.length} 个 · 熵=${entropy(probs).toFixed(2)} bit`)
  }

  console.log('\n  top_p 砍掉的是长尾——那些概率极低但数量极多的怪 token。')
  console.log('  这解释了为什么 top_p=0.9 通常比 T=0.9 更有效地抑制胡言乱语：')
  console.log('  温度只是压缩差距，长尾还在；top_p 直接把长尾删了。')
}

function demoInteraction() {
  console.log('\n【三】温度和 top_p 一起用会怎样')
  console.log('这是很多人搞混的地方。\n')

  const combos: Array<[number, number]> = [
    [0.7, 1.0],
    [1.0, 0.9],
    [0.7, 0.9],
    [2.0, 0.9],
    [2.0, 1.0],
  ]

  for (const [T, p] of combos) {
    let probs = softmax(applyTemperature(LOGITS, T))
    if (p < 1) probs = applyTopP(probs, p)
    const n = probs.filter((x: number) => x > 0).length
    console.log(
      `  T=${T.toFixed(1)} top_p=${p.toFixed(2)} · 候选 ${String(n).padStart(2)} 个 · ` +
        `熵=${entropy(probs).toFixed(2)} bit`,
    )
  }

  console.log('\n  注意最后两行：T=2.0 时，加上 top_p=0.9 把候选从 12 个压到少数几个。')
  console.log('  高温 + top_p 截断 = 在"合理的候选"里随机，而不是在全词表里随机。')
  console.log('  官方文档说「别同时调这两个」的真正含义是：两个都动你就说不清是谁的效果了，')
  console.log('  不是它们冲突。生产上固定一个、只调另一个。')
}

function demoSampling() {
  console.log('\n【四】采样是随机的，但有多随机')
  console.log('每种配置抽 200 次，统计分布。\n')

  // 固定种子的伪随机，保证这个 demo 可复现
  let s = 42
  const rand = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s |= 0
    return (s >>> 0) / 4294967296
  }

  const configs: Array<[string, { temperature: number; topP: number }]> = [
    ['T=0（argmax）', { temperature: 0, topP: 1 }],
    ['T=0.7', { temperature: 0.7, topP: 1 }],
    ['T=1.0', { temperature: 1.0, topP: 1 }],
    ['T=1.0 top_p=0.9', { temperature: 1.0, topP: 0.9 }],
  ]

  for (const [label, opts] of configs) {
    const counts = new Map<number, number>()
    for (let i = 0; i < 200; i++) {
      const { index } = sample(LOGITS, { ...opts, rand })
      counts.set(index, (counts.get(index) ?? 0) + 1)
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])
    const summary = top
      .slice(0, 4)
      .map(([i, c]) => `${LABELS[i] ?? i}×${c}`)
      .join(' ')
    console.log(`  ${label.padEnd(18)} 出现 ${counts.size} 种 · ${summary}`)
  }

  console.log('\n  T=0 只出一种——这是理论上的确定性。')
  console.log('  但真实 API 里 T=0 仍会偶尔变，因为浮点归约顺序和 MoE 路由会随批次变化。')
  console.log('  那部分不在这段代码里，也不在你的控制范围内。')
}

// ─────────────────────────────────────────────────────────────
// TODO 6：亲手验证一个坑
//
// 用 applyTopP(probs, 0.3) 处理一个 top1 概率是 0.9 的分布。
// 如果你的实现是「先判断累积是否超过 p，再决定加不加入」，
// 会发生什么？把它跑出来看看。
//
// 然后想清楚：这个 bug 在生产里长什么样？（提示：不是报错）
// ─────────────────────────────────────────────────────────────

function main() {
  console.log('logits → token，一共四步。')
  demoTemperature()
  demoTruncation()
  demoInteraction()
  demoSampling()
  console.log('\n' + '─'.repeat(60))
  console.log('L01 里你调过这些参数。现在你知道它们各自在动哪一步了。')
  console.log('别忘了 TODO 6。')
}

// verify.ts 会 import 这个文件来测你写的函数。不加这道判断的话，
// import 的那一刻观察实验就跑起来了，verify 的输出会变成第一个 TODO
// 的堆栈，而不是一张「还有哪些没写」的清单。
if (isMain(import.meta.url)) main()
