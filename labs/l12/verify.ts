/**
 * 验证 l12/suite.ts。跑法：pnpm verify:l12
 * 先跑 EVAL_IMPL=shared pnpm verify:l12 确认测试本身是对的。
 *
 * 一次 API 都不调——这一节的东西全是纯统计，
 * 而**能用假的测的东西就不要用真的测**。这本身就是 TODO 2 的主张。
 *
 * ★ 带 ★ 的每一条对应一种"数字很好看但没有信息"：
 * 分层缺口不报、judge 只输出一个标签、raw 当成 kappa、
 * 置信区间跨 0 却写进 PR、净涨背后换了一批 bug、评测集腐化。
 *
 * 它们的共同点和前面每一节一样：**不抛异常。**
 * 而这一节更狠一点——它们还会给你一个数字，让你以为自己有证据。
 */

import * as shared from '../shared/evals.ts'
import type { Criterion, LogEntry, PairedVerdict } from '../shared/evals.ts'

const TARGET = process.env.EVAL_IMPL === 'shared' ? 'shared' : 'mine'
const mine = (await import('./suite.ts')) as unknown as {
  stratifiedSample: typeof shared.stratifiedSample
  routeCheck: typeof shared.routeCheck
  chanceAgreement: typeof shared.chanceAgreement
  agreement: typeof shared.agreement
  auditJudge: typeof shared.auditJudge
  bootstrapCI: typeof shared.bootstrapCI
  compareRuns: typeof shared.compareRuns
}

const M = TARGET === 'shared' ? shared : mine

console.log(
  TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l12/ 里你的实现）',
)

let passed = 0
const failures: string[] = []

function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`\x1b[32m  ✓ ${name}\x1b[0m`)
  } catch (err) {
    failures.push(name)
    console.log(`\x1b[31m  ✕ ${name}\x1b[0m`)
    for (const l of String((err as Error).message).split('\n')) {
      console.log(`\x1b[31m      ${l}\x1b[0m`)
    }
  }
}

function eq(a: unknown, b: unknown, msg = '') {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)]
  if (x !== y) throw new Error(`${msg}\n  期望 ${y}\n  实际 ${x}`)
}
function ok(c: boolean, msg = '') {
  if (!c) throw new Error(msg)
}
function near(a: number, b: number, tol = 1e-9, msg = '') {
  if (Math.abs(a - b) > tol) throw new Error(`${msg}\n  期望 ≈${b}\n  实际 ${a}`)
}

function logs(): LogEntry[] {
  const kinds = ['查询', '改代码', '多步任务']
  return Array.from({ length: 200 }, (_, i) => {
    const r = i % 100
    return {
      id: `log-${i}`,
      input: `请求 ${i}`,
      outcome: r < 92 ? 'ok' : r < 96 ? 'wrong' : r < 99 ? 'error' : 'timeout',
      kind: kinds[i % 3]!,
      steps: 1 + (i % 9),
    } as LogEntry
  })
}

// ─── 一、分层抽样 ─────────────────────────────────────────

console.log('\n一、分层抽样')

test('每个分层各取到要求的条数（够的话）', () => {
  const r = M.stratifiedSample(logs(), { strata: ['ok', 'wrong'], perStratum: 5 })
  eq(r.coverage['ok'], 5)
  eq(r.coverage['wrong'], 5)
  eq(r.picked.length, 10)
})

test('抽出来的确实属于对应分层', () => {
  const r = M.stratifiedSample(logs(), { strata: ['timeout'], perStratum: 2 })
  ok(
    r.picked.every((e) => e.outcome === 'timeout'),
    '抽到了不属于该分层的样本',
  )
})

test('★ 分层不够时要报 gaps，不能静默少给', () => {
  // timeout 在 200 条里只有 2 条，要 10 条肯定不够
  const r = M.stratifiedSample(logs(), { strata: ['timeout'], perStratum: 10 })
  ok(r.gaps.length > 0, '不够却没报 gaps —— 这就是那个静默失效')
  ok(
    r.gaps.some((g) => g.includes('timeout')),
    'gaps 里没提是哪个分层缺的，那这个 gaps 没用',
  )
})

test('★ 某分层 0 条时必须单独说明，那不是"少几条"而是"这一类不存在"', () => {
  const r = M.stratifiedSample(logs(), { strata: ['ok', '不存在的分层'], perStratum: 3 })
  eq(r.coverage['不存在的分层'], 0)
  ok(
    r.gaps.some((g) => g.includes('不存在的分层')),
    '0 条的分层没进 gaps',
  )
})

test('可换 stratify：按步数分层而不是按 outcome', () => {
  const r = M.stratifiedSample(logs(), {
    strata: ['短', '长'],
    perStratum: 4,
    stratify: (e) => (e.steps > 5 ? '长' : '短'),
  })
  eq(r.coverage['短'], 4)
  ok(
    r.picked.filter((e) => e.steps > 5).length === 4,
    'stratify 没被用上',
  )
})

test('确定性：同样输入抽出同一批（评测必须可复现）', () => {
  const a = M.stratifiedSample(logs(), { strata: ['ok', 'wrong'], perStratum: 4 })
  const b = M.stratifiedSample(logs(), { strata: ['ok', 'wrong'], perStratum: 4 })
  eq(
    a.picked.map((e) => e.id),
    b.picked.map((e) => e.id),
    '两次抽样结果不同 —— 那你没法判断"跑分变了"是改动还是抖动',
  )
})

// ─── 二、判据路由 ─────────────────────────────────────────

console.log('\n二、把判据路由到最便宜的够用的检查')

const crit = (o: Partial<Criterion>): Criterion => ({ id: 'c', says: '...', ...o })

test('有 expect 走精确匹配', () => {
  eq(M.routeCheck(crit({ expect: 'P0' })).kind, 'exact')
})

test('有 fields 走结构检查', () => {
  eq(M.routeCheck(crit({ fields: ['severity'] })).kind, 'structural')
})

test('有 pattern 走正则', () => {
  eq(M.routeCheck(crit({ pattern: '\\[\\d+\\]' })).kind, 'regex')
})

test('优先级：expect 压过 pattern（都给了要选更便宜更确定的）', () => {
  eq(M.routeCheck(crit({ expect: 'P0', pattern: 'P' })).kind, 'exact')
})

test('semantic 才走 judge', () => {
  eq(M.routeCheck(crit({ semantic: true })).kind, 'judge')
})

test('★ negate 的 why 要说清"命中就算失败"', () => {
  const r = M.routeCheck(crit({ pattern: 'internal-', negate: true }))
  eq(r.kind, 'regex')
  ok(
    r.why.includes('失败') || r.why.includes('反'),
    '反向断言没在 why 里说明 —— 安全类判据大半是反向的，写成正向会让含义正好反过来且测试全绿',
  )
})

test('★ 什么依据都没给时兜底到 judge，但要指出判据本身没定义清楚', () => {
  const r = M.routeCheck(crit({ says: '回答质量要好' }))
  eq(r.kind, 'judge')
  ok(
    r.why.includes('没定义') || r.why.includes('不清') || r.why.includes('说不出'),
    '兜底到 judge 却没提示"这条判据本身有问题" —— 一条你自己都说不出怎么验的判据，judge 也判不了',
  )
})

test('反向断言真的反着判：命中 = 失败', () => {
  const cs = [crit({ id: 'neg', pattern: 'internal-', negate: true })]
  eq(shared.runDeterministic('用了 internal-billing 服务', cs)[0]!.pass, false)
  eq(shared.runDeterministic('用了计费服务', cs)[0]!.pass, true)
})

// ─── 三、偶然一致率 ───────────────────────────────────────

console.log('\n三、偶然一致率')

test('完全一边倒时偶然一致率是 1', () => {
  near(M.chanceAgreement(['a', 'a', 'a'], ['a', 'a', 'a']), 1)
})

test('两标签各半时偶然一致率是 0.5', () => {
  near(M.chanceAgreement(['a', 'b', 'a', 'b'], ['a', 'b', 'b', 'a']), 0.5)
})

test('★ 标签集合要取并集：judge 输出了人工没有的标签', () => {
  // judge: 全 x（人工标注里没有 x）；human: 一半 a 一半 b
  // 并集 {x,a,b}：P(judge=x)=1,P(human=x)=0 → 0；a、b 项 judge 概率都是 0
  // 所以 chance 应该是 0，而不是把 x 漏掉之后算出别的数
  near(M.chanceAgreement(['x', 'x', 'x', 'x'], ['a', 'a', 'b', 'b']), 0)
})

// ─── 四、带偶然校正的一致率 ───────────────────────────────

console.log('\n四、带偶然校正的一致率（本节最重要的函数）')

const human80 = [...Array(80).fill('pass'), ...Array(20).fill('fail')]

test('完全一致时 kappa 是 1', () => {
  near(M.agreement(human80, human80).kappa, 1)
})

test('★ 永远说 pass 的 judge：raw 高达 0.8，而 kappa 恰好是 0', () => {
  const r = M.agreement(Array(100).fill('pass'), human80)
  near(r.raw, 0.8, 1e-9, 'raw 应该等于多数类占比')
  near(r.kappa, 0, 1e-9, '这个 judge 什么都不看，kappa 必须是 0')
})

test('★ 同一个 raw 可以对应完全不同的 kappa（所以 raw 不能当结论）', () => {
  const lazy = M.agreement(Array(100).fill('pass'), human80)
  // 一个真在判断的 judge，凑到同样的 raw=0.8：错 20 条，但错在两类上
  const real = human80.map((h, i) => (i % 5 === 0 ? (h === 'pass' ? 'fail' : 'pass') : h))
  const r = M.agreement(real, human80)
  near(r.raw, 0.8, 1e-9)
  ok(
    r.kappa > lazy.kappa + 0.2,
    `raw 一样（都是 0.8）但 kappa 应该差很多，实际 ${r.kappa.toFixed(3)} vs ${lazy.kappa.toFixed(3)}`,
  )
})

test('★ judge 只输出一个标签必须进 problems', () => {
  const r = M.agreement(Array(100).fill('pass'), human80)
  ok(
    r.problems.some((p) => p.includes('一个标签') || p.includes('只输出')),
    '没报出"judge 只输出过一个标签" —— 这是最常见的退化，而 raw 会掩盖它',
  )
})

test('★ 人工标注只有一个标签：这个评测集没有区分度', () => {
  const r = M.agreement(Array(50).fill('pass'), Array(50).fill('pass'))
  ok(r.problems.length > 0, '人工标注单一标签时必须报问题')
})

test('★ chance 等于 1 时不能返回 NaN 或抛异常', () => {
  const r = M.agreement(Array(50).fill('pass'), Array(50).fill('pass'))
  ok(Number.isFinite(r.kappa), `kappa 是 ${r.kappa} —— 分母为 0 是要报出来的问题，不是计算错误`)
})

test('★ raw 与 kappa 差得太多要明确说"raw 不能当结论用"', () => {
  const r = M.agreement(Array(100).fill('pass'), human80)
  ok(
    r.raw - r.kappa > 0.3,
    '这个例子里 raw−kappa 应该大于 0.3',
  )
  ok(r.problems.some((p) => p.includes('百分点') || p.includes('高')), '差距没被报出来')
})

test('长度不一致要报错，不能静默截断（zip 的坑）', () => {
  let threw = false
  try {
    M.agreement(['pass'], ['pass', 'fail'])
  } catch {
    threw = true
  }
  ok(threw, '两组标签长度不同却算出了一个数 —— 那个数是错的')
})

// ─── 五、judge 体检 ───────────────────────────────────────

console.log('\n五、judge 上线前的体检')

/**
 * "永远选排在前面那个"的 judge。极稳，极偏。
 * AB 顺序里前面是 A 所以判 A；BA 顺序里前面是 B 所以判 B。
 */
const alwaysFirst: PairedVerdict[] = Array.from({ length: 40 }, (_, i) => ({
  ab: 'A',
  ba: 'B',
  lenA: 100 + i,
  lenB: 100 + (i % 7) * 10,
}))

test('位置偏见：永远选排在前面那个时是 0.5', () => {
  near(shared.positionBias(alwaysFirst), 0.5)
})

test('★ 只看内容的 judge 位置偏见是 0，哪怕 A 一直赢', () => {
  // ★ 这一条守着一个很容易写错的实现：|P(A 赢) − 0.5|。
  // A 真的更好、judge 两次都正确地选了 A —— 那个错实现会报 0.5。
  const contentDriven: PairedVerdict[] = Array.from({ length: 40 }, () => ({
    ab: 'A',
    ba: 'A',
    lenA: 100,
    lenB: 100,
  }))
  near(
    shared.positionBias(contentDriven),
    0,
    1e-9,
    '把"A 有多常赢"当成了位置偏见 —— 那测的是内容分布',
  )
})

test('位置偏见：AB/BA 一致时恒为 0（与胜负分布无关）', () => {
  for (const share of [0.1, 0.5, 0.9]) {
    const v: PairedVerdict[] = Array.from({ length: 40 }, (_, i) => {
      const w = i < 40 * share ? 'A' : 'B'
      return { ab: w, ba: w, lenA: 100, lenB: 100 } as PairedVerdict
    })
    near(shared.positionBias(v), 0, 1e-9, `A 胜率 ${share} 时位置偏见应该还是 0`)
  }
})

test('★ 恒等关系：位置偏见 ≤ 翻转率 / 2', () => {
  const mk = (n: number, flipA: number, flipB: number): PairedVerdict[] => [
    ...Array.from({ length: flipA }, () => ({ ab: 'A', ba: 'B', lenA: 1, lenB: 1 }) as PairedVerdict),
    ...Array.from({ length: flipB }, () => ({ ab: 'B', ba: 'A', lenA: 1, lenB: 1 }) as PairedVerdict),
    ...Array.from(
      { length: n - flipA - flipB },
      () => ({ ab: 'A', ba: 'A', lenA: 1, lenB: 1 }) as PairedVerdict,
    ),
  ]
  for (const [fa, fb] of [
    [20, 0],
    [10, 10],
    [12, 4],
    [0, 0],
  ]) {
    const v = mk(40, fa!, fb!)
    const pb = shared.positionBias(v)
    const fr = shared.flipRate(v)
    ok(pb <= fr / 2 + 1e-9, `位置偏见 ${pb} 超过了翻转率的一半 ${fr / 2}`)
  }
  // 翻转全朝一个方向时取到等号
  near(shared.positionBias(mk(40, 20, 0)), shared.flipRate(mk(40, 20, 0)) / 2, 1e-9)
  // 翻转方向对半时是噪声，位置偏见为 0
  near(shared.positionBias(mk(40, 10, 10)), 0, 1e-9)
})

test('★ 一致性—偏见悖论：重测 1.0 + 位置偏见 0.5 必须判不可上线', () => {
  const a = M.auditJudge({
    judgeLabels: alwaysFirst.map((v) => v.ab),
    humanLabels: Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? 'B' : 'A')),
    paired: alwaysFirst,
    runs: [0, 1, 2].map(() => Array(40).fill('A')),
  })
  near(a.testRetest, 1, 1e-9, '同一个 prompt 问三次答案都一样，重测信度必然是 1')
  ok(a.positionBias > 0.4, '位置偏见应该接近 0.5')
  eq(a.deployable, false, '重测满分不代表可靠 —— 最可复现的 judge 恰恰是最不可信的那些')
  ok(
    a.problems.some((p) => p.includes('悖论') || p.includes('稳定')),
    '没把"高稳定 + 高偏见"这件事说成一种失效',
  )
})

test('★ 翻转率高但位置偏见低要判成噪声，不是偏见（修法不同）', () => {
  const noisy: PairedVerdict[] = Array.from({ length: 40 }, (_, i) => ({
    ab: i % 2 === 0 ? 'A' : 'B',
    ba: i % 2 === 0 ? 'B' : 'A',
    lenA: 100,
    lenB: 100,
  }))
  near(shared.flipRate(noisy), 1, 1e-9)
  near(shared.positionBias(noisy), 0, 1e-9)
  const humans = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 'A' : 'B'))
  const a = M.auditJudge({
    judgeLabels: noisy.map((v) => v.ab),
    humanLabels: humans,
    paired: noisy,
    runs: [humans, humans, humans],
  })
  ok(
    a.problems.some((p) => p.includes('噪声')),
    '翻转率 100% 而位置偏见 0，要说清这是噪声不是偏见 —— 对称化消不掉噪声',
  )
})

test('一个各项都过关的 judge 判为可上线', () => {
  const humans = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 'B' : 'A'))
  const paired: PairedVerdict[] = humans.map((h, i) => ({
    ab: h as 'A' | 'B',
    ba: h as 'A' | 'B',
    lenA: 100 + (i % 5) * 30,
    lenB: 100 + ((i + 2) % 5) * 30,
  }))
  const a = M.auditJudge({
    judgeLabels: humans,
    humanLabels: humans,
    paired,
    runs: [humans, humans, humans],
  })
  eq(a.deployable, true, `各项都好却判不可上线：${a.problems.join(' / ')}`)
})

test('重测信度低要拦：同样输入跑三次结果都不同', () => {
  const humans = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 'B' : 'A'))
  const a = M.auditJudge({
    judgeLabels: humans,
    humanLabels: humans,
    paired: humans.map((h) => ({ ab: h as 'A' | 'B', ba: h as 'A' | 'B', lenA: 100, lenB: 100 })),
    runs: [
      humans,
      humans.map((h, i) => (i % 3 === 1 ? (h === 'A' ? 'B' : 'A') : h)),
      humans.map((h, i) => (i % 3 === 2 ? (h === 'A' ? 'B' : 'A') : h)),
    ],
  })
  eq(a.deployable, false)
  ok(a.testRetest < 0.9)
})

// ─── 六、置信区间 ─────────────────────────────────────────

console.log('\n六、bootstrap 置信区间')

test('区间包含样本均值', () => {
  const s = [...Array(80).fill(1), ...Array(20).fill(0)]
  const ci = M.bootstrapCI(s, { seed: 42 })
  ok(ci.lo <= 0.8 && ci.hi >= 0.8, `区间 [${ci.lo}, ${ci.hi}] 不含均值 0.8`)
})

test('★ 样本越少区间越宽（这就是"涨 2% 什么都不意味着"的来源）', () => {
  const mk = (n: number) => [...Array(Math.round(n * 0.8)).fill(1), ...Array(n - Math.round(n * 0.8)).fill(0)]
  const w = (n: number) => {
    const c = M.bootstrapCI(mk(n), { seed: 42 })
    return c.hi - c.lo
  }
  ok(w(50) > w(500), '50 条的区间应该比 500 条宽')
  ok(w(500) > w(2000), '500 条的区间应该比 2000 条宽')
})

test('150 条 / 80% 的区间宽度在 10~16 个百分点之间', () => {
  const s = [...Array(120).fill(1), ...Array(30).fill(0)]
  const ci = M.bootstrapCI(s, { seed: 42 })
  const w = (ci.hi - ci.lo) * 100
  ok(w > 10 && w < 16, `宽度 ${w.toFixed(1)} 个百分点，超出预期范围`)
})

test('同 seed 可复现，不同 seed 略有差异', () => {
  const s = [...Array(80).fill(1), ...Array(20).fill(0)]
  eq(M.bootstrapCI(s, { seed: 1 }), M.bootstrapCI(s, { seed: 1 }), '同 seed 结果不同 —— 评测必须可复现')
  const a = M.bootstrapCI(s, { seed: 1 })
  const b = M.bootstrapCI(s, { seed: 999 })
  ok(a.lo !== b.lo || a.hi !== b.hi, '不同 seed 完全一样，说明 seed 没被用上')
})

test('全 1 的样本区间退化成一个点', () => {
  const ci = M.bootstrapCI(Array(50).fill(1), { seed: 42 })
  near(ci.lo, 1)
  near(ci.hi, 1)
})

// ─── 七、回归比较 ─────────────────────────────────────────

console.log('\n七、回归比较（最重要的输出不是 delta）')

const runs = (fix: number[], brk: number[]) => {
  const before: Record<string, number> = {}
  const after: Record<string, number> = {}
  for (let i = 0; i < 100; i++) {
    before[`c${i}`] = i < 70 ? 1 : 0
    after[`c${i}`] = i < 70 ? 1 : 0
  }
  for (const i of fix) after[`c${i}`] = 1
  for (const i of brk) after[`c${i}`] = 0
  return { before, after }
}

test('fixed / broken 分别列出是哪些 case', () => {
  const { before, after } = runs([70, 71, 72], [0, 1])
  const r = M.compareRuns(before, after)
  eq(r.fixed.sort(), ['c70', 'c71', 'c72'])
  eq(r.broken.sort(), ['c0', 'c1'])
})

test('★ 净涨 +2% 的两种情况必须能区分开', () => {
  // 甲：修好 12 个、弄坏 10 个 —— 这不是改进，这是换了一批 bug
  const a = runs([70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  // 乙：修好 3 个、弄坏 1 个 —— 基本是抖动
  const b = runs([70, 71, 72], [5])
  const swapped = M.compareRuns(a.before, a.after)
  const jitter = M.compareRuns(b.before, b.after)
  near(swapped.delta, jitter.delta, 0.005, '构造得不对：两种情况的 delta 应该一样')
  ok(
    swapped.broken.length > jitter.broken.length + 5,
    `delta 一样，但 broken 必须差很多：${swapped.broken.length} vs ${jitter.broken.length}`,
  )
})

test('★ 换了一批 bug 时 verdict 要说出来，不能只说"涨了"', () => {
  const { before, after } = runs(
    [70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  )
  const r = M.compareRuns(before, after)
  ok(r.delta > 0, '这个例子净值是涨的')
  ok(
    r.verdict.includes('弄坏') || r.verdict.includes('换') || r.verdict.includes('bug'),
    `verdict 只说了净变化：「${r.verdict}」—— 净值会把"换了一批 bug"藏起来`,
  )
})

test('干净的改进：broken 为空', () => {
  const { before, after } = runs([70, 71, 72, 73], [])
  const r = M.compareRuns(before, after)
  eq(r.broken, [])
  eq(r.fixed.length, 4)
})

test('★ 只比两边都有的 id（换了样本之后跑分涨了是经典自欺）', () => {
  const r = M.compareRuns({ a: 1, b: 0, c: 0 }, { a: 1, b: 1, d: 1 })
  ok(!r.fixed.includes('d') && !r.broken.includes('d'), '新增的 d 不该参与成对比较')
  ok(!r.fixed.includes('c') && !r.broken.includes('c'), '消失的 c 不该参与成对比较')
  eq(r.fixed, ['b'])
})

test('抖动两三条时不该判显著', () => {
  const { before, after } = runs([70, 71], [5])
  const r = M.compareRuns(before, after)
  eq(r.significant, false, '一两条的变化在 100 条样本上不可能显著')
})

test('成对差值的区间比两个均值各自的区间窄得多', () => {
  const { before, after } = runs([70, 71, 72, 73, 74], [])
  const r = M.compareRuns(before, after)
  const wPaired = r.ci.hi - r.ci.lo
  const wSingle =
    M.bootstrapCI(Object.values(after), { seed: 42 }).hi -
    M.bootstrapCI(Object.values(after), { seed: 42 }).lo
  ok(
    wPaired < wSingle,
    `成对区间宽 ${wPaired.toFixed(3)}，单组区间宽 ${wSingle.toFixed(3)} —— 成对应该更窄`,
  )
})

// ─── 八、腐化检测 ─────────────────────────────────────────

console.log('\n八、评测集腐化')

test('把三类样本分开：还有区分度 / 一直全对 / 从来没过', () => {
  const r = shared.detectRot({
    a: [1, 1, 1, 1],
    b: [0, 1, 0, 1],
    c: [0, 0, 0, 0],
  })
  eq(r.alwaysPass, ['a'])
  eq(r.live, ['b'])
  eq(r.alwaysFail, ['c'])
})

test('★ 区分度低于三成要报出来（这个门禁快要失效了）', () => {
  const h: Record<string, number[]> = {}
  for (let i = 0; i < 40; i++) h[`old${i}`] = [1, 1, 1, 1]
  for (let i = 0; i < 5; i++) h[`new${i}`] = [0, 1, 0, 1]
  const r = shared.detectRot(h)
  ok(r.problems.length > 0, '八成样本已经没信息了却什么都不说')
})

test('★ "从来没过"要提示先人工确认标注', () => {
  const h: Record<string, number[]> = { a: [0, 1, 1, 0] }
  for (let i = 0; i < 6; i++) h[`stuck${i}`] = [0, 0, 0, 0]
  const r = shared.detectRot(h)
  ok(
    r.problems.some((p) => p.includes('标注') || p.includes('确认')),
    '永远失败的 case 会让你去修一个不存在的问题，必须提示人工核对',
  )
})

// ─── 九、门禁 ─────────────────────────────────────────────

console.log('\n九、门禁（这一节的交付物）')

const gateMod = await import('./regress.ts')

test('★ 闸一：样本消失了要拦（删样本能让任何跑分变好看）', () => {
  const r = gateMod.gate({
    baseline: { a: 1, b: 0, c: 0 },
    current: { a: 1, b: 1 },
    history: { a: [1, 1], b: [0, 1] },
    judge: null,
    comparisons: 1,
  })
  eq(r.pass, false)
  ok(
    r.blockers.some((b) => b.includes('消失') || b.includes('删')),
    '基线样本消失了却没拦',
  )
})

test('闸二：judge 没过体检要拦，且这一道在跑分之前', () => {
  const paired: PairedVerdict[] = Array.from({ length: 30 }, () => ({
    ab: 'A',
    ba: 'B',
    lenA: 200,
    lenB: 100,
  }))
  const r = gateMod.gate({
    baseline: { a: 1, b: 1 },
    current: { a: 1, b: 1 },
    history: { a: [1, 0], b: [0, 1] },
    judge: {
      judgeLabels: paired.map((v) => v.ab),
      humanLabels: Array.from({ length: 30 }, (_, i) => (i % 4 === 0 ? 'B' : 'A')),
      paired,
      runs: [0, 1, 2].map(() => Array(30).fill('A')),
    },
    comparisons: 1,
  })
  eq(r.pass, false)
  ok(r.blockers.some((b) => b.includes('judge')))
})

test('★ 闸三：净值涨了但弄坏了样本，也要出现在报告里', () => {
  const before: Record<string, number> = {}
  const current: Record<string, number> = {}
  for (let i = 0; i < 100; i++) {
    before[`c${i}`] = i < 70 ? 1 : 0
    current[`c${i}`] = i < 70 ? 1 : 0
  }
  for (let i = 70; i < 82; i++) current[`c${i}`] = 1
  for (let i = 0; i < 10; i++) current[`c${i}`] = 0
  const r = gateMod.gate({
    baseline: before,
    current,
    history: Object.fromEntries(Object.keys(before).map((k) => [k, [0, 1, 0, 1]])),
    judge: null,
    comparisons: 1,
  })
  ok(r.diff.delta > 0, '这个例子净值是涨的')
  ok(
    [...r.blockers, ...r.warnings].some((m) => m.includes('弄坏')),
    '弄坏了 10 条却没进报告 —— 净值把它藏起来了',
  )
})

test('闸五：比了太多指标要提醒（查的是你的行为，不是数据）', () => {
  const r = gateMod.gate({
    baseline: { a: 1 },
    current: { a: 1 },
    history: { a: [0, 1] },
    judge: null,
    comparisons: 7,
  })
  ok(
    r.warnings.some((w) => w.includes('指标')),
    '看了 7 个指标却没提醒 —— 假阳性概率已经 30%',
  )
})

test('干净的 PR 应该放行', () => {
  const before: Record<string, number> = {}
  const current: Record<string, number> = {}
  for (let i = 0; i < 100; i++) {
    before[`c${i}`] = i < 70 ? 1 : 0
    current[`c${i}`] = i < 85 ? 1 : 0
  }
  const r = gateMod.gate({
    baseline: before,
    current,
    history: Object.fromEntries(Object.keys(before).map((k) => [k, [0, 1, 0, 1]])),
    judge: null,
    comparisons: 1,
  })
  eq(r.pass, true, `干净的改进被拦了：${r.blockers.join(' / ')}`)
})

// ─────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(66)}`)
if (failures.length === 0) {
  console.log(`\x1b[32m全部通过（${passed}）\x1b[0m`)
  console.log('\n★ 接着跑 pnpm regress —— 把这八个零件接成一道会让 CI 变红的门。')
} else {
  console.log(`\x1b[32m通过 ${passed}\x1b[0m，\x1b[31m失败 ${failures.length}\x1b[0m：`)
  for (const f of failures) console.log(`\x1b[31m  · ${f}\x1b[0m`)
  process.exitCode = 1
}
