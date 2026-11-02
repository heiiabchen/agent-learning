/**
 * 验证 l13/trace.ts。跑法：pnpm verify:l13
 * 先跑 OBS_IMPL=shared pnpm verify:l13 确认测试本身是对的。
 *
 * 一次 API 都不调。这一节的东西全是**结构和算术**——
 * 而它的每一个失效都发生在你调用模型之前或之后，不在调用里面。
 *
 * ★ 带 ★ 的每一条对应一种"trace 看起来完整但不是"：
 * 双发把花费翻倍、input_tokens 差 2001 倍、成本维度不存在、
 * 二次方增长、4 MiB 静默丢批、head 采样偏向丢失败、
 * 一次运行两个矛盾决策、按 span 求和重复计算、
 * 重放不了却以为能、judge 定位不了 agent 故障。
 *
 * 它们的共同点：**全都不抛异常。** 而这一节比 L12 更狠一点——
 * L12 给你一个错的数字，这一节给你一份**错的现场**。
 */

import * as shared from '../shared/observe.ts'
import type { Message, Run, Span } from '../shared/observe.ts'
import { ATTR, PRICES } from '../shared/observe.ts'

const TARGET = process.env.OBS_IMPL === 'shared' ? 'shared' : 'mine'
const mine = (await import('./trace.ts')) as unknown as {
  coalesceAttrs: typeof shared.coalesceAttrs
  normalizeUsage: typeof shared.normalizeUsage
  costOf: typeof shared.costOf
  traceSize: typeof shared.traceSize
  dedupeTrace: typeof shared.dedupeTrace
  batchByBytes: typeof shared.batchByBytes
  headSample: typeof shared.headSample
  tailSample: typeof shared.tailSample
  loopStats: typeof shared.loopStats
  agentSpanTree: typeof shared.agentSpanTree
  sumUsage: typeof shared.sumUsage
  checkReplayability: typeof shared.checkReplayability
  classifyFailure: typeof shared.classifyFailure
}
const M = TARGET === 'shared' ? shared : mine

console.log(
  TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l13/ 里你的实现）',
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

// ─────────────────────────────────────────────────────────
console.log('\n一、属性名双发')

test('双发的新旧键对要被识别出来', () => {
  const r = M.coalesceAttrs({
    'gen_ai.usage.prompt_tokens': 100,
    'gen_ai.usage.input_tokens': 100,
    'gen_ai.system': 'openai',
    'gen_ai.provider.name': 'openai',
  })
  eq(r.dualEmit.length, 2)
  eq(Object.keys(r.attrs).sort(), ['gen_ai.provider.name', 'gen_ai.usage.input_tokens'])
})

test('★ 去重后的值等于其中一个，绝不是两个之和', () => {
  const r = M.coalesceAttrs({
    'gen_ai.usage.prompt_tokens': 100,
    'gen_ai.usage.input_tokens': 100,
  })
  eq(r.attrs[ATTR.inputTokens], 100, '相加会变成 200——那正是"报告花费翻一倍"的来源')
})

test('只有旧键的时候要迁移到新键，不能丢', () => {
  const r = M.coalesceAttrs({ 'gen_ai.usage.prompt_tokens': 77 })
  eq(r.attrs[ATTR.inputTokens], 77)
  eq(r.dualEmit.length, 0)
})

test('★ 双发的两个值不一致要单独报出来（取哪个都是错的）', () => {
  const r = M.coalesceAttrs({
    'gen_ai.usage.prompt_tokens': 100,
    'gen_ai.usage.input_tokens': 250,
  })
  ok(r.conflicts.length === 1, '值不一致意味着两条埋点路径在测不同的东西，必须报')
})

test('cache_creation → cache_write 这个未发布的改名也要认', () => {
  const r = M.coalesceAttrs({ 'gen_ai.usage.cache_creation.input_tokens': 900 })
  eq(r.attrs[ATTR.cacheWrite], 900, '2026-08 之前的所有文章写的都是 cache_creation')
})

// ─────────────────────────────────────────────────────────
console.log('\n二、token 会计')

test('★ Anthropic 的 input_tokens 不含缓存，必须加回来', () => {
  const u = M.normalizeUsage('anthropic', {
    input_tokens: 50,
    output_tokens: 100,
    cache_read_input_tokens: 100_000,
  })
  eq(u.inputTokens, 100_050, '照字段名映射会记成 50，少算 2001 倍')
  eq(u.freshInput, 50)
})

test('★ OpenAI 的 input_tokens 已含缓存，绝不能再加', () => {
  const u = M.normalizeUsage('openai', {
    input_tokens: 100_050,
    output_tokens: 100,
    input_tokens_details: { cached_tokens: 100_000 },
  })
  eq(u.inputTokens, 100_050, '再加一次会变成 200,050——同一段代码在两家上一对一错')
  eq(u.freshInput, 50)
})

test('★ 两家在同一次调用上归一后必须得到同一个数', () => {
  const a = M.normalizeUsage('anthropic', {
    input_tokens: 50,
    output_tokens: 100,
    cache_read_input_tokens: 100_000,
  })
  const o = M.normalizeUsage('openai', {
    input_tokens: 100_050,
    output_tokens: 100,
    input_tokens_details: { cached_tokens: 100_000 },
  })
  eq(a.inputTokens, o.inputTokens, '这才是"归一"的定义')
})

test('缓存写入只给了顶层字段时要报出算不出钱', () => {
  const u = M.normalizeUsage('anthropic', {
    input_tokens: 10,
    output_tokens: 10,
    cache_creation_input_tokens: 40_000,
  })
  ok(u.problems.length > 0, '顶层字段是 1.25x 和 2x 两档之和，只读它算不出钱')
  eq(u.cacheWrite5m + u.cacheWrite1h, 40_000, '总量不能丢，只是档位未知')
})

test('给了明细就要按档分开', () => {
  const u = M.normalizeUsage('anthropic', {
    input_tokens: 10,
    output_tokens: 10,
    cache_creation_input_tokens: 40_000,
    cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 30_000 },
  })
  eq(u.cacheWrite5m, 10_000)
  eq(u.cacheWrite1h, 30_000)
  eq(u.problems.length, 0)
})

test('reasoning 是 output 的一部分，不是另一笔', () => {
  const u = M.normalizeUsage('openai', {
    input_tokens: 100,
    output_tokens: 1186,
    output_tokens_details: { reasoning_tokens: 1024 },
  })
  eq(u.outputTokens, 1186, 'reasoning 已经在 output_tokens 里')
  eq(u.reasoning, 1024)
  ok(u.reasoning < u.outputTokens, '86% 的计费输出是不可见的，但它不是额外的一笔')
})

test('reasoning 比 output 还多要报错（口径反了）', () => {
  const u = M.normalizeUsage('openai', {
    input_tokens: 10,
    output_tokens: 100,
    output_tokens_details: { reasoning_tokens: 500 },
  })
  ok(u.problems.length > 0)
})

test('★ 把 Anthropic 的相加逻辑用到 OpenAI 上要能被发现', () => {
  // 症状：缓存 token 比 input_tokens 还多
  const u = M.normalizeUsage('openai', {
    input_tokens: 50,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 100_000 },
  })
  ok(u.problems.some((p) => p.includes('Anthropic')), '这是最常见的跨家复制粘贴错误')
})

// ─────────────────────────────────────────────────────────
console.log('\n三、成本')

test('缓存读按 0.1 倍计价', () => {
  const u = M.normalizeUsage('anthropic', {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 1_000_000,
  })
  const c = M.costOf(u, PRICES['claude-like']!)
  near(c.total, 0.3, 1e-9, '1M 缓存读 = 1M × $3 × 0.1')
})

test('1 小时档写入是 5 分钟档的 1.6 倍', () => {
  const p = PRICES['claude-like']!
  const w5 = M.costOf(
    M.normalizeUsage('anthropic', {
      output_tokens: 0,
      cache_creation_input_tokens: 100_000,
      cache_creation: { ephemeral_5m_input_tokens: 100_000 },
    }),
    p,
  )
  const w1 = M.costOf(
    M.normalizeUsage('anthropic', {
      output_tokens: 0,
      cache_creation_input_tokens: 100_000,
      cache_creation: { ephemeral_1h_input_tokens: 100_000 },
    }),
    p,
  )
  near(w1.total / w5.total, 2 / 1.25, 1e-9)
})

test('★ 从 metric 算（所有 input 一个价）会算错，且方向取决于缓存构成', () => {
  const heavyRead = M.normalizeUsage('anthropic', {
    input_tokens: 100,
    output_tokens: 100,
    cache_read_input_tokens: 500_000,
  })
  const c = M.costOf(heavyRead, PRICES['claude-like']!)
  ok(c.naiveTotal > c.total * 3, '缓存读为主时，metric 口径会大幅高估')
})

test('★ 倍率跨度要报出来 —— 那是"一个桶"装不下的原因', () => {
  const c = M.costOf(
    M.normalizeUsage('anthropic', { input_tokens: 1, output_tokens: 1 }),
    PRICES['claude-like']!,
  )
  eq(c.spread, 20, '0.1x 到 2x，跨度 20 倍。全部塌进 token.type=input')
})

test('OpenAI 没有 1 小时档，跨度不同', () => {
  const c = M.costOf(
    M.normalizeUsage('openai', { input_tokens: 1, output_tokens: 1 }),
    PRICES['gpt-like']!,
  )
  eq(c.spread, 12.5, '0.1x 到 1.25x')
})

// ─────────────────────────────────────────────────────────
console.log('\n四、二次方增长')

const msgs: Message[] = Array.from({ length: 50 }, (_, i) => ({
  role: i === 0 ? 'system' : i % 2 === 0 ? 'assistant' : 'tool',
  content: `m${i}`.padEnd(500 + i, '.'),
}))

test('★ 存的条数正好是 k(k+1)/2', () => {
  for (const k of [10, 30, 50]) {
    const t = M.traceSize(msgs, k)
    eq(t.storedMessages, (k * (k + 1)) / 2, `k=${k}`)
  }
})

test('★ 唯一条数是 k —— 冗余就是这两个数的差', () => {
  const t = M.traceSize(msgs, 30)
  eq(t.uniqueMessages, 30)
  eq(t.storedMessages, 465)
})

test('★ 轮数翻倍，字节翻四倍（近似）', () => {
  const a = M.traceSize(msgs, 12)
  const b = M.traceSize(msgs, 24)
  const r = b.storedBytes / a.storedBytes
  ok(r > 3.5 && r < 4.6, `期望 ≈4 倍，实际 ${r.toFixed(2)}`)
})

test('去重能把冗余压掉', () => {
  const turns: Message[][] = []
  for (let k = 1; k <= 40; k++) turns.push(msgs.slice(0, k))
  const d = M.dedupeTrace(turns)
  eq(Object.keys(d.blobs).length, 40, '40 轮只有 40 条唯一消息')
  ok(d.savedBytes > 0)
})

test('★ 哈希前必须规范化 JSON —— 否则键序不同的同一条会算成两条', () => {
  // 两个对象内容相同、构造顺序不同
  const a = { role: 'user', content: 'hi' } as Message
  const b = JSON.parse('{"content":"hi","role":"user"}') as Message
  const d = M.dedupeTrace([[a], [b]])
  eq(
    Object.keys(d.blobs).length,
    1,
    '不规范化的话会得到 2 个 blob——去重率变成 0，而且不报错',
  )
})

// ─────────────────────────────────────────────────────────
console.log('\n五、4 MiB 那道墙')

function span(name: string, payload: number): Span {
  return {
    name,
    spanId: name,
    parentId: 'root',
    kind: 'CLIENT',
    attrs: { [ATTR.operation]: 'chat', 'gen_ai.input.messages': 'M'.repeat(payload) },
  }
}

test('★ 每一批都不超过预算', () => {
  const spans = [span('a', 2_400_000), span('b', 2_400_000), span('c', 100)]
  const r = M.batchByBytes(spans)
  const budget = shared.OTLP_LIMIT * 0.9
  for (const b of r.batches) ok(b.bytes <= budget, `一批 ${b.bytes} 超过预算 ${budget}`)
})

test('★ 两个各自合法的胖 span 必须分到两批', () => {
  // 都在单 span 上限（~3.2MB）之内，单独发都没问题，加起来超 4 MiB
  const r = M.batchByBytes([span('a', 2_400_000), span('b', 2_400_000)])
  eq(r.batches.length, 2, '按条数分批会打成一批，然后整批被当成不可重试错误丢掉')
})

test('单条就超限的要单独报出来（分批救不了它）', () => {
  const r = M.batchByBytes([span('monster', 3_900_000), span('small', 10)])
  eq(r.oversized, ['monster'])
  ok(
    r.problems.some((p) => p.includes('外部化')),
    '唯一的修法是把内容存到对象存储，span 上只留引用',
  )
})

test('超限的 span 不能被静默塞进某一批', () => {
  const r = M.batchByBytes([span('monster', 3_900_000), span('small', 10)])
  const all = r.batches.flatMap((b) => b.spans.map((s) => s.name))
  ok(!all.includes('monster'), '塞进去等于让整批变成不可重试错误')
  ok(all.includes('small'), '而无关的 span 应该照常发出去')
})

test('胖 span 的存在本身要被报告', () => {
  const r = M.batchByBytes([span('a', 2_400_000)])
  ok(r.problems.length > 0, '它现在没超批，但它随时会和别的 span 打进一批')
})

// ─────────────────────────────────────────────────────────
console.log('\n六、采样')

const fleet: Run[] = Array.from({ length: 1000 }, (_, i) => {
  const bad = i % 20 === 0
  return {
    traceId: `t${i}`,
    ok: !bad,
    turns: bad ? 24 + (i % 17) : 3 + (i % 5),
    ms: bad ? 200_000 : 9_000,
    tokens: bad ? 400_000 : 30_000,
  }
})

test('★ head 采样的失败召回 ≈ 采样率 —— 这正是问题所在', () => {
  const h = M.headSample(fleet, 0.1)
  ok(
    Math.abs(h.failureRecall - 0.1) < 0.08,
    `失败召回 ${h.failureRecall.toFixed(2)}，应该接近采样率 0.1——` +
      '"不偏"在这里是坏事：你要的是偏向失败',
  )
})

test('★ head 采样保留的失败占比 ≈ 总体失败率（没有富集）', () => {
  const h = M.headSample(fleet, 0.1)
  ok(
    Math.abs(h.failureShare - 0.05) < 0.05,
    '调试语料里失败的浓度和生产一样低——它没帮你任何忙',
  )
})

test('采样率 1.0 要留下全部', () => {
  const h = M.headSample(fleet, 1)
  eq(h.kept.length, 1000)
  near(h.failureRecall, 1)
})

test('★ decision_wait 比运行短的时候，决策是在局部树上做的', () => {
  const t = M.tailSample(fleet.slice(0, 100), {
    decisionWaitMs: 30_000,
    numTraces: 100_000,
    decisionCacheSize: 1_000_000,
    keep: (r) => !r.ok,
  })
  eq(t.decidedOnPartial.length, 5, '5 次失败运行跑了 200 秒，远超 30 秒的默认值')
})

test('★ 瞄着失败的策略在默认 decision_wait 下可能一条都留不下', () => {
  const t = M.tailSample(fleet.slice(0, 100), {
    decisionWaitMs: 30_000,
    numTraces: 100_000,
    decisionCacheSize: 1_000_000,
    keep: (r) => !r.ok,
  })
  eq(t.failureRecall, 0, '第 30 秒的时候它还没失败——策略写得再对也没用')
})

test('decision_wait 拉长到超过运行时长就能正常工作', () => {
  const t = M.tailSample(fleet.slice(0, 100), {
    decisionWaitMs: 400_000,
    numTraces: 100_000,
    decisionCacheSize: 1_000_000,
    keep: (r) => !r.ok,
  })
  near(t.failureRecall, 1, 1e-9, '这才是 tail 采样该有的样子')
})

test('★ 决策缓存为 0 时，同一次运行会拿到两个矛盾的决策', () => {
  const t = M.tailSample(fleet.slice(0, 100), {
    decisionWaitMs: 30_000,
    numTraces: 100_000,
    decisionCacheSize: 0, // ★ 这就是默认值
    keep: (r) => !r.ok,
  })
  ok(t.contradictory.length > 0, 'sampled_cache_size 默认 0，迟到的 span 会触发全新的决策')
  ok(
    t.problems.some((p) => p.includes('看起来完整')),
    '症状是一条看起来完整、只是有点短的 trace',
  )
})

test('把决策缓存开起来，矛盾决策就消失', () => {
  const t = M.tailSample(fleet.slice(0, 100), {
    decisionWaitMs: 30_000,
    numTraces: 100_000,
    decisionCacheSize: 1_000_000,
    keep: (r) => !r.ok,
  })
  eq(t.contradictory.length, 0)
})

test('★ 缓冲区满的时候淘汰的是最老的 —— 而长 trace 永远最老', () => {
  const t = M.tailSample(fleet.slice(0, 60), {
    decisionWaitMs: 400_000,
    numTraces: 50,
    decisionCacheSize: 1_000_000,
    keep: () => true,
  })
  eq(t.droppedTooEarly.length, 10)
  eq(t.droppedTooEarly[0], 't0', '被淘汰的是最先到的那些')
})

test('★ loop 长度统计不依赖任何一条 trace', () => {
  const l = M.loopStats(fleet, 20)
  eq(l.runaway.length, 50, '全部 50 次失控都被这个直方图看到')
  ok(l.p99 >= 20, '而 p99 就落在失控区间里')
  ok(l.p50 < 10, 'p50 还是正常的——所以只看均值看不出问题')
})

// ─────────────────────────────────────────────────────────
console.log('\n七、span 的形状')

const u = shared.normalizeUsage('anthropic', {
  input_tokens: 100,
  output_tokens: 200,
  cache_read_input_tokens: 50_000,
})
const tree = () =>
  M.agentSpanTree({
    agent: 'a1',
    conversationId: 'c1',
    model: 'm1',
    provider: 'anthropic',
    steps: [
      { kind: 'chat', usage: u },
      { kind: 'execute_tool', name: 'grep' },
      { kind: 'chat', usage: u },
    ],
  })

test('★ 子 span 是兄弟，不是嵌套链', () => {
  const t = tree()
  const kids = t.filter((s) => s.parentId !== null)
  eq(kids.length, 3)
  ok(
    kids.every((s) => s.parentId === 'root'),
    '规范预期的形状是一个总 span 下面一排兄弟',
  )
})

test('★ sampling-relevant 的五个属性必须在 chat span 上齐全', () => {
  const chat = tree().find((s) => s.attrs[ATTR.operation] === 'chat')!
  for (const k of [ATTR.operation, ATTR.provider, ATTR.requestModel, 'server.address', 'server.port']) {
    ok(k in chat.attrs, `缺 ${k}——tail 采样器看不到它，采样策略会静默失效`)
  }
})

test('跨轮次关联靠 conversation.id，不靠父子关系', () => {
  const t = tree()
  const withConv = t.filter((s) => s.attrs[ATTR.conversationId] === 'c1')
  ok(withConv.length >= 3, '每个需要被关联的 span 上都要有它')
})

test('★ internal 的 invoke_agent 不带 token usage', () => {
  const root = tree().find((s) => s.parentId === null)!
  ok(!(ATTR.inputTokens in root.attrs), 'v1.41.0 显式移除了它，正是为了让按 span 求和不重复计算')
  ok(!('server.address' in root.attrs), '进程内 agent 没有 server 概念')
})

test('span 名遵循 {operation} {target} 格式', () => {
  const t = tree()
  eq(t[0]!.name, 'invoke_agent a1')
  eq(t[1]!.name, 'chat m1')
  eq(t.find((s) => s.attrs[ATTR.operation] === 'execute_tool')!.name, 'execute_tool grep')
})

test('按 span 求和不重复计算', () => {
  const s = M.sumUsage(tree())
  eq(s.input, 2 * u.inputTokens)
  eq(s.output, 2 * u.outputTokens)
  eq(s.problems.length, 0)
})

test('★ 根 span 也带 token 的时候要报重复计算', () => {
  const t = tree()
  t[0]!.attrs[ATTR.inputTokens] = 999
  const s = M.sumUsage(t)
  ok(s.problems.some((p) => p.includes('重复计算')))
})

test('★ 未归一的 Anthropic 语义要能被发现（缓存比总输入还多）', () => {
  const bad: Span[] = [
    {
      name: 'chat x',
      spanId: 'x',
      parentId: null,
      kind: 'CLIENT',
      attrs: {
        [ATTR.operation]: 'chat',
        [ATTR.inputTokens]: 100, // 原始的、不含缓存的值
        [ATTR.outputTokens]: 10,
        [ATTR.cacheRead]: 50_000,
      },
    },
  ]
  ok(M.sumUsage(bad).problems.some((p) => p.includes('没归一')))
})

test('reasoning 比 output 多也要报', () => {
  const bad: Span[] = [
    {
      name: 'chat y',
      spanId: 'y',
      parentId: null,
      kind: 'CLIENT',
      attrs: { [ATTR.outputTokens]: 10, [ATTR.reasoningTokens]: 500 },
    },
  ]
  ok(M.sumUsage(bad).problems.length > 0)
})

// ─────────────────────────────────────────────────────────
console.log('\n八、复现')

test('★ 没开内容采集的 trace 不能重放（而它完全「合规」）', () => {
  const r = M.checkReplayability(tree())
  eq(r.replayable, false)
  ok(r.blockers.some((b) => b.includes('opt_in')), 'OTel 的四个内容属性默认不发')
})

test('开了内容采集就不再是硬阻塞', () => {
  const t = tree()
  for (const s of t) if (s.attrs[ATTR.operation] === 'chat') s.attrs['gen_ai.input.messages'] = '[]'
  eq(M.checkReplayability(t).replayable, true)
})

test('★ previous_response_id 是硬阻塞（状态不在你手里）', () => {
  const t = tree()
  for (const s of t) {
    if (s.attrs[ATTR.operation] === 'chat') {
      s.attrs['gen_ai.input.messages'] = '[]'
      s.attrs['gen_ai.request.previous_response.id'] = 'resp_x'
    }
  }
  const r = M.checkReplayability(t)
  eq(r.replayable, false)
  ok(r.blockers.some((b) => b.includes('指针')), '你记的是一个指向别人服务器上会过期的状态的指针')
})

test('缺 seed / system_fingerprint 是警告，不是阻塞', () => {
  const t = tree()
  for (const s of t) if (s.attrs[ATTR.operation] === 'chat') s.attrs['gen_ai.input.messages'] = '[]'
  const r = M.checkReplayability(t)
  eq(r.replayable, true)
  ok(r.warnings.length >= 2)
})

test('★ seed 的警告要说清它在 Responses API 里根本不存在', () => {
  const t = tree()
  for (const s of t) if (s.attrs[ATTR.operation] === 'chat') s.attrs['gen_ai.input.messages'] = '[]'
  const r = M.checkReplayability(t)
  ok(
    r.warnings.some((w) => w.includes('不存在')),
    '"设个 seed"这个建议在现代 agent SDK 的底座上是结构性不可用的',
  )
})

test('★ system_fingerprint 的警告要说清它是漂移信号而不是确定性契约', () => {
  const t = tree()
  for (const s of t) if (s.attrs[ATTR.operation] === 'chat') s.attrs['gen_ai.input.messages'] = '[]'
  ok(M.checkReplayability(t).warnings.some((w) => w.includes('漂移')))
})

await (async () => {
  const calls: string[] = []
  const live = async (tag: string) => {
    calls.push(tag)
    return { text: tag }
  }

  const rec = new shared.Recorder('record')
  await rec.call('openai', '/r', { p: 1 }, () => live('a'))
  await rec.call('openai', '/r', { p: 2 }, () => live('b'))
  await rec.call('openai', '/r', { p: 2 }, () => live('c')) // 重试：同一个请求
  const cass = rec.finish()

  test('录音要记下同一个键的多次调用', () => {
    eq(cass.entries.length, 3)
    eq(cass.entries.filter((e) => e.seq === 1).length, 1, '第二次 {p:2} 的 seq 应该是 1')
  })

  test('★ 同一个键要按 FIFO 游标推进，不能都拿第一次的响应', async () => {
    const p = new shared.Recorder('replay', cass)
    const r1 = (await p.call('openai', '/r', { p: 2 }, () => live('x'))) as { text: string }
    const r2 = (await p.call('openai', '/r', { p: 2 }, () => live('x'))) as { text: string }
    eq([r1.text, r2.text], ['b', 'c'], '否则重试循环里的第二次会拿到第一次的响应')
  })

  test('重放不发起真实调用', async () => {
    const n = calls.length
    const p = new shared.Recorder('replay', cass)
    await p.call('openai', '/r', { p: 1 }, () => live('x'))
    eq(calls.length, n, '重放的定义就是不打真实请求')
    eq(p.report.matched, 1)
  })

  test('请求体键序不同要算成同一个键', async () => {
    const p = new shared.Recorder('replay', cass)
    const a = p.keyFor('openai', '/r', { p: 1, q: 2 })
    const b = p.keyFor('openai', '/r', { q: 2, p: 1 })
    eq(a, b, '不规范化的话同一个请求会哈希成两个键，然后全都判成分叉')
  })

  test('★ 严格重放遇到分叉要抛，不能悄悄回落到真实调用', async () => {
    const p = new shared.Recorder('replay', cass)
    let threw = false
    try {
      await p.call('openai', '/r', { p: 999 }, () => live('x'))
    } catch (e) {
      threw = e instanceof shared.DivergenceError
    }
    ok(threw, '悄悄回落 = 你以为在重放，其实在跑一次新的')
  })

  test('★ hybrid 模式重放到分叉点后转真实调用', async () => {
    const n = calls.length
    const p = new shared.Recorder('hybrid', cass)
    await p.call('openai', '/r', { p: 1 }, () => live('h1'))
    await p.call('openai', '/r', { p: 999 }, () => live('h2'))
    eq(p.report.matched, 1)
    eq(p.report.wentLive, true)
    eq(calls.length - n, 1, '只有分叉之后的那一次是真实的')
    eq(p.report.divergedAt, 2, '分叉发生在第 2 次调用')
  })

  test('时钟要被虚拟化，否则重放会走到不同的超时分支', () => {
    const r = new shared.Recorder('record')
    const t1 = r.now()
    const t2 = r.now()
    const c = r.finish()
    eq(c.clock.length, 2)
    const p = new shared.Recorder('replay', c)
    eq([p.now(), p.now()], [t1, t2])
  })

  test('★ 请求 id 要被录下来，否则第一次调用就分叉', () => {
    const r = new shared.Recorder('record')
    const id = r.requestId()
    const c = r.finish()
    eq(new shared.Recorder('replay', c).requestId(), id, 'SDK 每次都会生成新的')
  })
})()

// ─────────────────────────────────────────────────────────
console.log('\n九、归因')

function toolSpans(names: string[]): Span[] {
  return [
    {
      name: 'invoke_agent a',
      spanId: 'root',
      parentId: null,
      kind: 'INTERNAL',
      attrs: { [ATTR.operation]: 'invoke_agent' },
    },
    ...names.map((t, i) => ({
      name: `execute_tool ${t}`,
      spanId: `s${i}`,
      parentId: 'root',
      kind: 'INTERNAL' as const,
      attrs: { [ATTR.operation]: 'execute_tool', [ATTR.toolName]: t },
    })),
  ]
}

test('步骤重复要被判出来（MAST 里占比最高的一类）', () => {
  const v = M.classifyFailure(toolSpans(['s', 's', 's', 'r']), { ok: false, turns: 8 })
  ok(v.some((x) => x.code === 'FM-1.3'))
})

test('调用两次不算重复（阈值要有意义）', () => {
  const v = M.classifyFailure(toolSpans(['s', 's', 'r']), { ok: false, turns: 8 })
  ok(!v.some((x) => x.code === 'FM-1.3'), '正常 agent 也会重复调工具，规则不能太敏感')
})

test('跑太多轮还没结束 = 不知道终止条件', () => {
  const v = M.classifyFailure(toolSpans(['a']), { ok: false, turns: 31 })
  ok(v.some((x) => x.code === 'FM-1.5'))
})

test('成功的长运行不算失败', () => {
  const v = M.classifyFailure(toolSpans(['a']), { ok: true, turns: 31 })
  ok(!v.some((x) => x.code === 'FM-1.5'), '31 轮成功完成的任务就是 31 轮的任务')
})

test('一轮就结束且没调工具 = 过早终止', () => {
  const v = M.classifyFailure(toolSpans([]), { ok: true, turns: 1 })
  ok(v.some((x) => x.code === 'FM-3.1'))
})

test('★ compacted=true 要被记下来，且要说清反面不成立', () => {
  const s = toolSpans(['a'])
  s[0]!.attrs[ATTR.compacted] = true
  const v = M.classifyFailure(s, { ok: false, turns: 5 })
  const f = v.find((x) => x.code === 'FM-1.4')!
  ok(f.evidence.includes('不知道'), '规范说 SHOULD NOT 设成 false，所以字段缺失 ≠ 没压缩')
})

test('★ 字段缺失不能被当成"没压缩"', () => {
  const v = M.classifyFailure(toolSpans(['a']), { ok: false, turns: 5 })
  ok(!v.some((x) => x.code === 'FM-1.4'), '不知道就不要报，别把"未知"写成"没有"')
})

// ─────────────────────────────────────────────────────────
console.log('\n十、复盘报告')

const pm = (await import('./postmortem.ts')) as typeof import('./postmortem.ts')

test('★ 有采样缺陷的现场要被判成不可信', () => {
  const r = pm.postmortem(pm.scenario())
  eq(r.trustworthy, false, 'decision_wait 30 秒 + 决策缓存 0，这份轨迹可能是截断的')
})

test('★ 可信度判定要在结论之前 —— 报告里排第一位', () => {
  const r = pm.postmortem(pm.scenario())
  ok(r.telemetryDefects.length > 0)
  ok(
    r.telemetryDefects.some((d) => d.includes('decision_wait')),
    '这条是"你看到的东西可能不完整"，它必须在"我判断出什么"之前',
  )
})

test('这个场景不能重放，且理由要具体', () => {
  const r = pm.postmortem(pm.scenario())
  eq(r.replay.ok, false)
  ok(r.replay.reasons.length >= 3)
})

test('失败模式只该在真正打转的工具上命中', () => {
  const r = pm.postmortem(pm.scenario())
  const rep = r.failures.filter((f) => f.code === 'FM-1.3')
  eq(rep.length, 1, '别的工具各调一两次，不该被判成步骤重复')
  ok(rep[0]!.evidence.includes('search'))
})

test('★ 成本要从 span 算，且要报出 metric 口径错多少', () => {
  const r = pm.postmortem(pm.scenario())
  ok(r.cost.fromSpans > 0)
  ok(r.cost.errorPct > 100, `metric 口径高估了 ${r.cost.errorPct.toFixed(0)}%`)
})

test('★ 报告必须留出"交给人"的部分', () => {
  const r = pm.postmortem(pm.scenario())
  ok(r.forHumans.length > 0, '不要假装程序能判完——TRAIL 的最好成绩是 18.3%')
  ok(
    r.forHumans.some((h) => h.includes('直方图')),
    '并且要指出哪个数字是采样缺陷影响不到的',
  )
})

test('规则全不命中但运行失败了，要明确说这是分类学的缺口', () => {
  const inc = pm.scenario()
  // 只剩一个干净的根 span：没有工具调用、没有压缩、轮数也不多
  inc.spans = [
    {
      name: 'invoke_agent refund-handler',
      spanId: 'root',
      parentId: null,
      kind: 'INTERNAL',
      attrs: { [ATTR.operation]: 'invoke_agent' },
    },
  ]
  inc.run = { ok: false, turns: 3, ms: 5_000 }
  const r = pm.postmortem(inc)
  eq(r.failures.length, 0)
  ok(
    r.forHumans.some((h) => h.includes('分类学')),
    '"没有规则命中"不等于"没有失败模式"',
  )
})

test('head 采样的现场要报出有多少同类事故完全没有记录', () => {
  const inc = pm.scenario()
  inc.sampling = { mode: 'head', rate: 0.1, decisionWaitMs: 30_000, cacheSize: 0 }
  const r = pm.postmortem(inc)
  ok(r.telemetryDefects.some((d) => d.includes('没有任何记录')))
  eq(r.trustworthy, false)
})

// ─────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(66)}`)
if (failures.length === 0) {
  console.log(`\x1b[32m全部通过（${passed}）\x1b[0m`)
  console.log('\n★ 接着跑 pnpm postmortem —— 把这些零件接成一份会让 CI 变红的复盘报告。')
} else {
  console.log(`\x1b[32m通过 ${passed}\x1b[0m，\x1b[31m失败 ${failures.length}\x1b[0m：`)
  for (const f of failures) console.log(`\x1b[31m  · ${f}\x1b[0m`)
  process.exitCode = 1
}
