/**
 * 验证 l07/patterns.ts。跑法：pnpm verify:l07
 *
 * 一次 API 都不调。
 *
 * 这套测试里有一整组专门盯着**静默失控**：路由兜底指错方向、编排不校验计划、
 * 打磨没有停滞检测、并行一个失败拖垮整批。它们都不抛异常，只是让你的账单
 * 或者质量安静地变坏。
 *
 * 先跑 VERIFY_TARGET=shared 确认测试本身是对的。
 */
import type Anthropic from '@anthropic-ai/sdk'

// 显式声明模块形状：两个 import 各自给出一套类型，
// 而 PlanError 是 class（名义类型），直接用会不兼容。
interface Usage {
  input: number
  output: number
  calls: number
}

type Call = (
  messages: Anthropic.MessageParam[],
  opts?: { system?: string; maxTokens?: number; temperature?: number },
) => Promise<Anthropic.Message>

interface ChainStep {
  name: string
  prompt: (input: string) => string
  system?: string
  gate?: (output: string) => boolean | string
}

interface Shape {
  stepsKnown: boolean
  independent: boolean
  needsBranching: boolean
  hasQualityBar: boolean
  errorCost: 'low' | 'high'
}

interface PatternsModule {
  chain(
    input: string,
    steps: ChainStep[],
    call: Call,
  ): Promise<{ output: string; usage: Usage; path: string[]; stoppedAt?: string; gateMessage?: string }>
  route<T extends string>(
    input: string,
    routes: { id: T; when: string; handle: (input: string, call: Call) => Promise<string> }[],
    call: Call,
    opts: { fallback: T; classifierSystem?: string },
  ): Promise<{ picked: T; output: string; usage: Usage; raw: string; fellBack: boolean }>
  parallel(
    prompts: string[],
    call: Call,
    opts?: { concurrency?: number; system?: string; temperature?: number },
  ): Promise<{ outputs: (string | null)[]; usage: Usage; failed: { index: number; reason: string }[] }>
  vote<T>(
    values: (T | null)[],
    key?: (v: T) => string,
  ): { winner: T | null; tally: { value: T; count: number }[]; confidence: number }
  orchestrate(
    task: string,
    call: Call,
    opts: {
      worker: (subtask: string, call: Call) => Promise<string>
      maxSubtasks?: number
      concurrency?: number
      system?: string
    },
  ): Promise<{ plan: string[]; output: string; usage: Usage; failed: { index: number; reason: string }[] }>
  refine(
    task: string,
    call: Call,
    opts: {
      critique: (draft: string, call: Call) => Promise<{ score: number; feedback: string }>
      maxRounds?: number
      targetScore?: number
      minGain?: number
      system?: string
    },
  ): Promise<{
    output: string
    score: number
    rounds: number
    usage: Usage
    history: number[]
    reason: 'target_reached' | 'no_improvement' | 'round_limit'
  }>
  choosePattern(s: Shape): { pattern: string; why: string }
}

const target = process.env.VERIFY_TARGET === 'shared' ? 'shared' : 'mine'
const P: PatternsModule =
  target === 'shared' ? await import('../shared/patterns.ts') : await import('./patterns.ts')

console.log(target === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l07/ 里你的实现）')

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

async function raises(fn: () => unknown, hint: string) {
  try {
    await fn()
  } catch (err) {
    // TODO 桩抛的 Error 也会被当成"通过"，所以要把它排除掉，
    // 否则脚手架状态下这些测试会假绿。
    if ((err as Error).message.startsWith('TODO:')) throw err
    return
  }
  throw new Error(`应该抛异常但没有：${hint}`)
}

/** 记录收到的 opts，用来断言 temperature / maxTokens 有没有传对。 */
interface Spy {
  call: Call
  readonly seen: { text: string; opts?: { system?: string; maxTokens?: number; temperature?: number } }[]
}

function spy(reply: (prompt: string) => string, usage = { input: 200, output: 60 }): Spy {
  const seen: Spy['seen'] = []
  const call: Call = async (messages, opts) => {
    const last = messages[messages.length - 1]!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content
            .map((b) => ((b as { type: string }).type === 'text' ? (b as { text: string }).text : ''))
            .join('')
    seen.push({ text, opts })
    return {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-v4-flash',
      content: [{ type: 'text', text: reply(text), citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: null,
      },
    } as unknown as Anthropic.Message
  }
  return { call, seen }
}

const echo = (s: string) => `处理[${s.slice(0, 20)}]`

// ─────────────────────────────────────────────────────────────
console.log('\n链式')
// ─────────────────────────────────────────────────────────────

const threeSteps: ChainStep[] = [
  { name: 'a', prompt: (s) => `A:${s}` },
  { name: 'b', prompt: (s) => `B:${s}` },
  { name: 'c', prompt: (s) => `C:${s}` },
]

await test('顺序执行，上一步输出进下一步', async () => {
  const s = spy(echo)
  await P.chain('start', threeSteps, s.call)
  assert(s.seen.length === 3, `应该调用 3 次，实际 ${s.seen.length}`)
  assert(s.seen[0]!.text.startsWith('A:start'), `第一步输入不对：${s.seen[0]!.text}`)
  assert(s.seen[1]!.text.startsWith('B:处理'), `第二步没拿到第一步的输出：${s.seen[1]!.text}`)
})

await test('path 记录走过的步骤', async () => {
  const r = await P.chain('x', threeSteps, spy(echo).call)
  assert(r.path.join(',') === 'a,b,c', `path 不对：${r.path.join(',')}`)
})

await test('usage 累加所有步骤', async () => {
  const r = await P.chain('x', threeSteps, spy(echo).call)
  assert(r.usage.calls === 3, `calls 应该是 3，实际 ${r.usage.calls}`)
  assert(r.usage.input === 600, `input 应该是 600，实际 ${r.usage.input}`)
})

await test('关口返回 false 时中止', async () => {
  const steps: ChainStep[] = [
    { name: 'a', prompt: (s) => s, gate: () => false },
    { name: 'b', prompt: (s) => s },
  ]
  const s = spy(echo)
  const r = await P.chain('x', steps, s.call)
  assert(s.seen.length === 1, `中止后不该继续调用，实际调了 ${s.seen.length} 次`)
  assert(r.stoppedAt === 'a', `stoppedAt 应该是 'a'，实际 ${r.stoppedAt}`)
})

await test('关口返回字符串时把它当作原因', async () => {
  const steps: ChainStep[] = [{ name: 'check', prompt: (s) => s, gate: () => '要点不完整' }]
  const r = await P.chain('x', steps, spy(echo).call)
  assert(
    r.gateMessage === '要点不完整',
    `gateMessage 应该是关口给的字符串，实际 ${JSON.stringify(r.gateMessage)}`,
  )
})

await test('中止是 return 而不是 throw（上游要拿到已产出的部分）', async () => {
  const steps: ChainStep[] = [
    { name: 'a', prompt: (s) => s },
    { name: 'b', prompt: (s) => s, gate: () => false },
    { name: 'c', prompt: (s) => s },
  ]
  const r = await P.chain('x', steps, spy(echo).call)
  assert(r.output.length > 0, 'output 应该有内容（已经跑完两步了）')
  assert(r.path.length === 2, `path 应该有两步，实际 ${r.path.length}`)
  assert(r.usage.calls === 2, `usage 应该记 2 次，实际 ${r.usage.calls}`)
})

await test('关口返回 true 时继续', async () => {
  const steps: ChainStep[] = [
    { name: 'a', prompt: (s) => s, gate: () => true },
    { name: 'b', prompt: (s) => s },
  ]
  const r = await P.chain('x', steps, spy(echo).call)
  assert(r.stoppedAt === undefined, `不该中止，实际停在 ${r.stoppedAt}`)
  assert(r.path.length === 2, `应该走完两步，实际 ${r.path.length}`)
})

await test('空链要抛异常，不能静默返回输入', async () => {
  await raises(() => P.chain('x', [], spy(echo).call), '空链通常是配置读错了，静默返回会让 bug 潜伏很久')
})

// ─────────────────────────────────────────────────────────────
console.log('\n路由')
// ─────────────────────────────────────────────────────────────

type Cls = 'billing' | 'tech' | 'general'
const makeRoutes = (): { id: Cls; when: string; handle: (i: string, c: Call) => Promise<string> }[] => [
  { id: 'billing', when: '账单相关', handle: async () => 'billing-handled' },
  { id: 'tech', when: '技术问题', handle: async () => 'tech-handled' },
  { id: 'general', when: '其他和分不清的', handle: async () => 'general-handled' },
]

await test('干净标签直接命中', async () => {
  const r = await P.route('问题', makeRoutes(), spy(() => 'tech').call, { fallback: 'general' })
  assert(r.picked === 'tech', `应该选 tech，实际 ${r.picked}`)
  assert(!r.fellBack, '不该走兜底')
  assert(r.output === 'tech-handled', `没调用对应的 handler：${r.output}`)
})

await test('带空格和大小写的标签也要命中', async () => {
  for (const raw of ['  Billing ', 'BILLING', 'billing\n', 'Billing.']) {
    const r = await P.route('问题', makeRoutes(), spy(() => raw).call, { fallback: 'general' })
    assert(
      r.picked === 'billing' && !r.fellBack,
      `「${JSON.stringify(raw)}」应该命中 billing，实际 ${r.picked}（兜底=${r.fellBack}）。\n` +
        '      模型给的标签总带脏东西，硬相等比较会让路由大面积走兜底',
    )
  }
})

await test('标签包在句子里也要能捞出来', async () => {
  const r = await P.route('问题', makeRoutes(), spy(() => '这个应该归到 tech 类').call, {
    fallback: 'general',
  })
  assert(r.picked === 'tech', `应该捞出 tech，实际 ${r.picked}`)
})

await test('★ 不认识的标签走兜底，而不是抛错或乱选', async () => {
  const r = await P.route('问题', makeRoutes(), spy(() => 'refund').call, { fallback: 'general' })
  assert(r.picked === 'general', `应该兜底到 general，实际 ${r.picked}`)
  assert(r.fellBack, 'fellBack 应该是 true——它是"分类器该不该重训"的唯一信号')
})

await test('★ 自作聪明的长解释也要能兜住', async () => {
  const r = await P.route(
    '问题',
    makeRoutes(),
    spy(() => '我认为这是一个关于产品定价策略的复杂问题，需要综合判断').call,
    { fallback: 'general' },
  )
  assert(r.fellBack, '这种输出捞不到标签，应该走兜底')
  assert(r.picked === 'general', `实际 ${r.picked}`)
})

await test('raw 保留模型的原始输出（排查用）', async () => {
  const r = await P.route('问题', makeRoutes(), spy(() => '  Billing ').call, { fallback: 'general' })
  assert(r.raw.includes('Billing'), `raw 应该保留原始输出，实际 ${JSON.stringify(r.raw)}`)
})

await test('分类调用用 temperature=0（要确定性，而且可缓存）', async () => {
  const s = spy(() => 'tech')
  await P.route('问题', makeRoutes(), s.call, { fallback: 'general' })
  assert(
    s.seen[0]!.opts?.temperature === 0,
    `分类那次调用的 temperature 应该是 0，实际 ${s.seen[0]!.opts?.temperature}。\n` +
      '      分类要的是确定性不是创造力',
  )
})

await test('分类调用给一个很小的 maxTokens', async () => {
  const s = spy(() => 'tech')
  await P.route('问题', makeRoutes(), s.call, { fallback: 'general' })
  const mt = s.seen[0]!.opts?.maxTokens
  assert(
    typeof mt === 'number' && mt <= 64,
    `maxTokens 应该很小（<=64），实际 ${mt}。给大额度模型就开始解释了`,
  )
})

await test('分类 prompt 里要列出全部候选和它们的描述', async () => {
  const s = spy(() => 'tech')
  await P.route('问题', makeRoutes(), s.call, { fallback: 'general' })
  const p = s.seen[0]!.text
  for (const id of ['billing', 'tech', 'general']) {
    assert(p.includes(id), `分类 prompt 里没有 ${id}`)
  }
  assert(p.includes('账单相关'), 'when 描述没进 prompt——它是分类准确率的唯一决定因素')
})

await test('空路由表要抛异常', async () => {
  await raises(
    () => P.route('问题', [], spy(() => 'x').call, { fallback: 'general' as Cls }),
    '没有候选还继续跑，后面必然崩在更远的地方',
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n并行与投票')
// ─────────────────────────────────────────────────────────────

await test('全部成功时按输入顺序返回', async () => {
  const r = await P.parallel(['a', 'b', 'c'], spy(echo).call)
  assert(r.outputs.length === 3, `应该 3 个输出，实际 ${r.outputs.length}`)
  assert(r.outputs[0]!.includes('a'), `第一个输出对不上：${r.outputs[0]}`)
  assert(r.outputs[2]!.includes('c'), `顺序错了：${r.outputs[2]}`)
})

await test('★ 一个失败不拖垮整批（allSettled 语义）', async () => {
  let n = 0
  const flaky: Call = async (messages) => {
    if (++n === 2) throw new Error('第二个炸了')
    return spy(echo).call(messages)
  }
  const r = await P.parallel(['a', 'b', 'c'], flaky)
  assert(r.outputs.length === 3, `长度应该保持 3，实际 ${r.outputs.length}`)
  assert(r.failed.length === 1, `应该记录 1 个失败，实际 ${r.failed.length}`)
  assert(
    r.outputs.filter((o) => o !== null).length === 2,
    '两个成功的应该还在——用 Promise.all 的话整批都没了',
  )
})

await test('失败的位置用 null 占位，不能压缩数组', async () => {
  let n = 0
  const flaky: Call = async (messages) => {
    if (++n === 1) throw new Error('第一个炸了')
    return spy(echo).call(messages)
  }
  const r = await P.parallel(['a', 'b'], flaky)
  assert(
    r.outputs[0] === null,
    `失败位置应该是 null，实际 ${JSON.stringify(r.outputs[0])}。压缩数组会让下标和输入对不上`,
  )
})

await test('failed 里带得上下标（否则不知道是哪个分片没了）', async () => {
  let n = 0
  const flaky: Call = async (messages) => {
    if (++n === 2) throw new Error('boom')
    return spy(echo).call(messages)
  }
  const r = await P.parallel(['a', 'b', 'c'], flaky)
  assert(r.failed[0]!.index === 1, `下标应该是 1，实际 ${r.failed[0]!.index}`)
})

await test('usage 只累加成功的那些', async () => {
  let n = 0
  const flaky: Call = async (messages) => {
    if (++n === 2) throw new Error('boom')
    return spy(echo).call(messages)
  }
  const r = await P.parallel(['a', 'b', 'c'], flaky)
  assert(r.usage.calls === 2, `calls 应该是 2，实际 ${r.usage.calls}`)
})

await test('concurrency 被遵守', async () => {
  let inFlight = 0
  let peak = 0
  const slow: Call = async (messages) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 10))
    inFlight--
    return spy(echo).call(messages)
  }
  await P.parallel(['a', 'b', 'c', 'd', 'e', 'f'], slow, { concurrency: 2 })
  assert(peak <= 2, `并发峰值应该 <=2，实际 ${peak}`)
})

await test('投票取多数', () => {
  const v = P.vote(['A', 'B', 'A', 'A', 'C'])
  assert(v.winner === 'A', `胜者应该是 A，实际 ${v.winner}`)
})

await test('★ 投票返回置信度（3:2 和 5:0 是不同的结论）', () => {
  const split = P.vote(['A', 'A', 'A', 'B', 'B'])
  const clean = P.vote(['A', 'A', 'A', 'A', 'A'])
  assert(Math.abs(split.confidence - 0.6) < 1e-9, `3/5 应该是 0.6，实际 ${split.confidence}`)
  assert(clean.confidence === 1, `5/5 应该是 1，实际 ${clean.confidence}`)
  assert(
    split.confidence < clean.confidence,
    '只返回 winner 会把这个差别抹掉，调用方没法区分"勉强多数"和"一致"',
  )
})

await test('投票跳过 null（失败的分片不该算进分母）', () => {
  const v = P.vote(['A', null, 'A', null])
  assert(v.confidence === 1, `分母应该只算非 null，实际置信度 ${v.confidence}`)
})

await test('全是 null 时不崩，winner 为 null', () => {
  const v = P.vote([null, null])
  assert(v.winner === null, `winner 应该是 null，实际 ${v.winner}`)
  assert(v.confidence === 0, `置信度应该是 0，实际 ${v.confidence}`)
})

await test('tally 按票数降序', () => {
  const v = P.vote(['B', 'A', 'A', 'A', 'B', 'C'])
  const counts = v.tally.map((t) => t.count)
  for (let i = 1; i < counts.length; i++) {
    assert(counts[i]! <= counts[i - 1]!, `tally 没排序：${JSON.stringify(counts)}`)
  }
})

await test('自定义 key 能把等价对象归成一票', () => {
  const v = P.vote(
    [
      { label: 'yes', note: 'a' },
      { label: 'yes', note: 'b' },
      { label: 'no', note: 'c' },
    ],
    (o) => o.label,
  )
  assert(v.winner?.label === 'yes', `应该按 label 归并，实际 ${JSON.stringify(v.winner)}`)
  assert(Math.abs(v.confidence - 2 / 3) < 1e-9, `置信度应该是 2/3，实际 ${v.confidence}`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n编排-工作者')
// ─────────────────────────────────────────────────────────────

const planOf = (lines: string[]) => (prompt: string) =>
  prompt.includes('拆成') ? lines.join('\n') : '整合后的结果'

await test('拆出子任务并逐个执行', async () => {
  const done: string[] = []
  const r = await P.orchestrate('大任务', spy(planOf(['查市场规模', '查竞品', '查定价'])).call, {
    worker: async (s) => {
      done.push(s)
      return `${s} 的结果`
    },
  })
  assert(r.plan.length === 3, `计划应该 3 项，实际 ${r.plan.length}：${JSON.stringify(r.plan)}`)
  assert(done.length === 3, `worker 应该被调 3 次，实际 ${done.length}`)
})

await test('剥掉模型爱加的编号和符号', async () => {
  const r = await P.orchestrate(
    '大任务',
    spy(planOf(['1. 查市场规模', '- 查竞品', '· 查定价', '2、查渠道'])).call,
    { worker: async (s) => s },
  )
  for (const p of r.plan) {
    assert(
      !/^[\s\-*·\d.、)]/.test(p),
      `子任务前缀没剥干净：${JSON.stringify(p)}。模型的编号会一路传到 worker 里`,
    )
  }
})

await test('★ 去重（模型爱把同一件事换个说法列两遍）', async () => {
  const r = await P.orchestrate('大任务', spy(planOf(['查竞品', '查竞品', '查定价'])).call, {
    worker: async (s) => s,
  })
  assert(r.plan.length === 2, `去重后应该 2 项，实际 ${r.plan.length}：${JSON.stringify(r.plan)}`)
})

await test('★ 空计划要抛错，不能静默降级成"直接做整个任务"', async () => {
  await raises(
    () => P.orchestrate('大任务', spy(planOf([])).call, { worker: async (s) => s }),
    '静默降级会把编排失败伪装成正常运行，你在监控里看不到，只看到质量莫名变差',
  )
})

await test('★ 超过 maxSubtasks 要抛错（不设上限是账单事故）', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `子任务 ${i}`)
  await raises(
    () => P.orchestrate('大任务', spy(planOf(many)).call, { worker: async (s) => s, maxSubtasks: 8 }),
    '40 个子任务就是 40 次调用，模型定的拆法必须有上限',
  )
})

await test('maxSubtasks 要写进 prompt（先让模型别拆那么多）', async () => {
  const s = spy(planOf(['a', 'b']))
  await P.orchestrate('大任务', s.call, { worker: async (x) => x, maxSubtasks: 5 })
  assert(s.seen[0]!.text.includes('5'), `prompt 里应该告诉模型上限，实际：\n${s.seen[0]!.text}`)
})

await test('部分 worker 失败时继续，并记录下来', async () => {
  const r = await P.orchestrate('大任务', spy(planOf(['a', 'b', 'c'])).call, {
    worker: async (s) => {
      if (s === 'b') throw new Error('b 失败')
      return `${s} ok`
    },
  })
  assert(r.failed.length === 1, `应该记 1 个失败，实际 ${r.failed.length}`)
  assert(r.output.length > 0, '还有两个成功的，应该照样整合出结果')
})

await test('全部 worker 失败时要抛错（没有任何东西可整合）', async () => {
  await raises(
    () =>
      P.orchestrate('大任务', spy(planOf(['a', 'b'])).call, {
        worker: async () => {
          throw new Error('都挂了')
        },
      }),
    '把一份"全部失败"的结果整合成正常输出，是最坏的静默失败',
  )
})

await test('有失败时要在整合 prompt 里说明缺了东西', async () => {
  const s = spy(planOf(['a', 'b']))
  await P.orchestrate('大任务', s.call, {
    worker: async (x) => {
      if (x === 'b') throw new Error('挂了')
      return `${x} ok`
    },
  })
  const synth = s.seen[s.seen.length - 1]!.text
  assert(
    /失败|缺失|缺/.test(synth),
    `整合 prompt 应该告诉模型有部分缺失，否则它会写得像很完整：\n${synth}`,
  )
})

await test('usage 含计划调用和整合调用', async () => {
  const r = await P.orchestrate('大任务', spy(planOf(['a', 'b'])).call, { worker: async (x) => x })
  assert(r.usage.calls === 2, `应该是 2（计划 + 整合），实际 ${r.usage.calls}`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n评估-优化')
// ─────────────────────────────────────────────────────────────

/** 按给定的分数序列打分。 */
function scorer(scores: number[]) {
  let i = 0
  return async () => ({ score: scores[Math.min(i++, scores.length - 1)]!, feedback: '再改改' })
}

await test('达到目标分就停', async () => {
  const r = await P.refine('任务', spy(echo).call, {
    critique: scorer([0.9]),
    maxRounds: 5,
    targetScore: 0.8,
  })
  assert(r.reason === 'target_reached', `reason 应该是 target_reached，实际 ${r.reason}`)
  assert(r.rounds === 1, `应该 1 轮就停，实际 ${r.rounds}`)
})

await test('★ 分数停滞时停（只有轮数上限的话每次都跑满）', async () => {
  const r = await P.refine('任务', spy(echo).call, {
    critique: scorer([0.5, 0.62, 0.63, 0.63, 0.63]),
    maxRounds: 5,
    targetScore: 0.95,
    minGain: 0.05,
  })
  assert(
    r.reason === 'no_improvement',
    `reason 应该是 no_improvement，实际 ${r.reason}。\n` +
      '      评估者永远能挑出毛病，所以必须有改进检测这道软闸',
  )
  assert(r.rounds < 5, `应该提前停，实际跑满了 ${r.rounds} 轮`)
})

await test('撞轮数上限时 reason 是 round_limit', async () => {
  const r = await P.refine('任务', spy(echo).call, {
    critique: scorer([0.1, 0.3, 0.5, 0.7]),
    maxRounds: 3,
    targetScore: 0.95,
    minGain: 0.01,
  })
  assert(r.reason === 'round_limit', `reason 应该是 round_limit，实际 ${r.reason}`)
  assert(r.rounds === 3, `应该跑满 3 轮，实际 ${r.rounds}`)
})

await test('history 记录每轮分数（唯一能看出原地打转的东西）', async () => {
  const r = await P.refine('任务', spy(echo).call, {
    critique: scorer([0.2, 0.4, 0.6]),
    maxRounds: 3,
    targetScore: 0.95,
    minGain: 0.01,
  })
  assert(r.history.length === 3, `history 应该 3 项，实际 ${JSON.stringify(r.history)}`)
  assert(r.history[0] === 0.2, `第一轮分数不对：${r.history[0]}`)
})

await test('★ 分数下降时保留历史最优，不无脑接受最后一版', async () => {
  const r = await P.refine('任务', spy(echo).call, {
    critique: scorer([0.7, 0.3, 0.2]),
    maxRounds: 3,
    targetScore: 0.95,
    minGain: -1, // 关掉停滞检测，强迫它跑满
  })
  assert(
    r.score === 0.7,
    `score 应该是历史最优 0.7，实际 ${r.score}。\n` +
      '      打磨会让结果变差，只留最后一版会把这件事藏起来',
  )
})

await test('minGain 是 0 时不提前停（用来对照省了多少）', async () => {
  const r = await P.refine('任务', spy(echo).call, {
    critique: scorer([0.5, 0.5, 0.5, 0.5, 0.5]),
    maxRounds: 4,
    targetScore: 0.95,
    minGain: 0,
  })
  assert(r.rounds === 4, `minGain=0 时应该跑满，实际 ${r.rounds}`)
})

await test('第一轮不做停滞判断（还没有可比的基线）', async () => {
  const r = await P.refine('任务', spy(echo).call, {
    critique: scorer([0.1, 0.9]),
    maxRounds: 3,
    targetScore: 0.8,
    minGain: 0.5,
  })
  assert(
    r.reason === 'target_reached',
    `第一轮 0.1 不该被判成停滞，实际 reason=${r.reason}、rounds=${r.rounds}`,
  )
})

await test('改稿时把评审意见带上（否则模型不知道要改什么）', async () => {
  const s = spy(echo)
  await P.refine('任务', s.call, {
    critique: async () => ({ score: 0.1, feedback: '开头太啰嗦' }),
    maxRounds: 2,
    targetScore: 0.9,
    minGain: -1,
  })
  const revise = s.seen[1]!.text
  assert(revise.includes('开头太啰嗦'), `改稿 prompt 里没有评审意见：\n${revise}`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n选型判据')
// ─────────────────────────────────────────────────────────────

const shape = (o: Partial<Shape>): Shape => ({
  stepsKnown: true,
  independent: false,
  needsBranching: false,
  hasQualityBar: false,
  errorCost: 'low',
  ...o,
})

await test('步骤已知且独立 → 并行', () => {
  const c = P.choosePattern(shape({ stepsKnown: true, independent: true }))
  assert(c.pattern === 'parallel', `实际 ${c.pattern}：${c.why}`)
})

await test('步骤已知且有依赖 → 链式', () => {
  const c = P.choosePattern(shape({ stepsKnown: true, independent: false }))
  assert(c.pattern === 'chain', `实际 ${c.pattern}：${c.why}`)
})

await test('路径有限但要选一条 → 路由', () => {
  const c = P.choosePattern(shape({ stepsKnown: true, needsBranching: true }))
  assert(c.pattern === 'route', `实际 ${c.pattern}：${c.why}`)
})

await test('拆法要模型定但子任务独立 → 编排', () => {
  const c = P.choosePattern(shape({ stepsKnown: false, independent: true }))
  assert(c.pattern === 'orchestrate', `实际 ${c.pattern}：${c.why}`)
})

await test('★ 步骤未知 + 需要分支 + 错误代价低 → 这才是 agent', () => {
  const c = P.choosePattern(
    shape({ stepsKnown: false, independent: false, needsBranching: true, errorCost: 'low' }),
  )
  assert(c.pattern === 'agent', `实际 ${c.pattern}：${c.why}`)
})

await test('★ 错误代价高时不选 agent（自主性此时是缺点）', () => {
  const c = P.choosePattern(
    shape({ stepsKnown: false, independent: false, needsBranching: true, errorCost: 'high' }),
  )
  assert(
    c.pattern !== 'agent',
    `错误代价高还选 agent 就错了：${c.why}\n` +
      '      这一条判断必须放在 agent 之前，否则永远轮不到它',
  )
})

await test('why 能读懂（它要进设计文档和 code review）', () => {
  for (const s of [shape({}), shape({ stepsKnown: false, needsBranching: true })]) {
    const c = P.choosePattern(s)
    assert(c.why.length > 8, `why 太短：${JSON.stringify(c.why)}`)
  }
})

// ─────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60))
if (failures.length === 0) {
  console.log(`\x1b[32m${passed} 项全过。\x1b[0m`)
  console.log('\n接着跑 pnpm compare，量一次 workflow 和 agent 的成本差别。')
} else {
  console.log(`\x1b[31m${passed} 过，${failures.length} 败：\x1b[0m`)
  for (const f of failures) console.log(`\x1b[31m  · ${f}\x1b[0m`)
  process.exitCode = 1
}
