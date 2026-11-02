/**
 * 验证 l05/loop.ts。跑法：pnpm verify:l05
 *
 * 一次 API 都不调——全部用 shared/fake.ts 里那个脚本化的假模型。
 *
 * 这件事本身是本节的一个教学点：**测 agent loop 不能用真模型。**
 * 你想验证「连续三次同样的调用会被拦住」，真模型不会配合你演这一出。
 * 假模型会，而且每次都一样。
 *
 * 先跑 VERIFY_TARGET=shared 确认这套测试本身是对的。
 */
import { fakeModel, type FakeTurn } from '../shared/fake.ts'
import { Ledger } from '../shared/ledger.ts'
import { ToolBox, type ToolDef } from '../shared/tools.ts'

const target = process.env.VERIFY_TARGET === 'shared' ? 'shared' : 'mine'
const A = target === 'shared' ? await import('../shared/agent.ts') : await import('./loop.ts')

console.log(target === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l05/ 里你的实现）')

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

function eq(actual: unknown, expected: unknown, hint = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`期待 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}${hint ? `\n      ${hint}` : ''}`)
  }
}

// ── 一个会记账的假工具 ───────────────────────────────────────────────────

let calls: { name: string; input: unknown }[] = []

function makeTools(): ToolBox {
  calls = []
  const echo: ToolDef<{ v: string }> = {
    name: 'echo',
    description: '回显',
    inputSchema: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
    parse: (raw) => ({ ok: true, input: { v: String((raw as { v?: unknown })?.v ?? '') } }),
    run: async (input) => {
      calls.push({ name: 'echo', input })
      return { content: `echo:${input.v}` }
    },
  }
  const boom: ToolDef<unknown> = {
    name: 'boom',
    description: '总是失败',
    inputSchema: { type: 'object', properties: {} },
    parse: (raw) => ({ ok: true, input: raw }),
    run: async () => {
      calls.push({ name: 'boom', input: null })
      return { isError: true, content: '失败了。换个做法。' }
    },
  }
  return new ToolBox([echo as unknown as ToolDef<never>, boom as unknown as ToolDef<never>])
}

function run(script: FakeTurn[], opts: Partial<Parameters<typeof A.runAgent>[1]> = {}, after?: 'repeat_last' | 'final' | 'throw') {
  const fake = fakeModel({ script, afterScript: after ?? 'final', delayMs: opts.maxMs === 1 ? 50 : 0 })
  return {
    fake,
    promise: A.runAgent('做点事', {
      toolbox: makeTools(),
      system: 'test',
      call: fake.call,
      ledger: new Ledger('test'),
      ...opts,
    }),
  }
}

// ── repeatKey ───────────────────────────────────────────────────────────

console.log('\nrepeatKey')

await test('同样的输入得到同样的 key', () => {
  eq(A.repeatKey('read', { path: 'a' }), A.repeatKey('read', { path: 'a' }))
})

await test('不同工具名要区分', () => {
  assert(A.repeatKey('read', { p: 1 }) !== A.repeatKey('list', { p: 1 }), '工具名要进 key')
})

await test('★★ 字段顺序不同必须得到同一个 key', () => {
  eq(
    A.repeatKey('t', { a: 1, b: 2 }),
    A.repeatKey('t', { b: 2, a: 1 }),
    '直接 JSON.stringify 会因为字段顺序不同产生不同的 key，\n' +
      '      于是重复检测静默失效。这是那种「写完觉得搞定了、三个月后发现一直没生效」的 bug。\n' +
      '      要递归地按 key 排序之后再序列化。',
  )
})

await test('嵌套对象的字段顺序也要归一', () => {
  eq(A.repeatKey('t', { o: { x: 1, y: 2 } }), A.repeatKey('t', { o: { y: 2, x: 1 } }))
})

await test('数组顺序**要**区分（它是有意义的顺序）', () => {
  assert(A.repeatKey('t', { a: [1, 2] }) !== A.repeatKey('t', { a: [2, 1] }), '数组顺序有语义，不能排序')
})

await test('undefined 值要忽略', () => {
  eq(A.repeatKey('t', { a: 1, b: undefined }), A.repeatKey('t', { a: 1 }))
})

// ── 正常流程 ────────────────────────────────────────────────────────────

console.log('\n正常流程')

await test('不需要工具时一步完成', async () => {
  const { promise } = run([{ text: '答案是 42' }])
  const r = await promise
  eq(r.reason, 'done')
  eq(r.steps, 1)
  eq(r.text, '答案是 42')
})

await test('一次工具调用后给答案', async () => {
  const { promise } = run([{ toolUses: [{ name: 'echo', input: { v: 'hi' } }] }, { text: '好了' }])
  const r = await promise
  eq(r.reason, 'done')
  eq(r.steps, 2)
  eq(r.text, '好了')
  eq(calls.length, 1, '工具应该被调用一次')
})

await test('★ assistant 消息要原样放回历史（含 tool_use 块）', async () => {
  const { fake, promise } = run([{ toolUses: [{ name: 'echo', input: { v: 'x' } }] }, { text: 'ok' }])
  await promise
  // 第二次调用时模型看到的 messages
  const second = fake.calls[1]
  assert(second, '应该有第二次调用')
  const assistantMsg = second.find((m) => m.role === 'assistant')
  assert(assistantMsg, '历史里必须有 assistant 消息')
  const blocks = assistantMsg.content as { type: string }[]
  assert(
    Array.isArray(blocks) && blocks.some((b) => b.type === 'tool_use'),
    '历史里的 assistant 消息丢了 tool_use 块。\n' +
      '      后果：模型下一轮看不到自己要求过什么，于是重新要求一次 → 死循环。\n' +
      '      而且每一轮都在花钱。这是最常见的一种 agent 死循环。',
  )
})

await test('★ 工具结果放在同一条 user 消息里', async () => {
  const { fake, promise } = run(
    [
      {
        toolUses: [
          { name: 'echo', input: { v: 'a' } },
          { name: 'echo', input: { v: 'b' } },
        ],
      },
      { text: 'ok' },
    ],
  )
  await promise
  const second = fake.calls[1]!
  const userMsgs = second.filter((m) => m.role === 'user')
  eq(
    userMsgs.length,
    2,
    '应该是「原始任务」+「一条带两个 tool_result 的消息」共 2 条 user。\n' +
      '      拆成多条会造成连续两条 user，违反 L02 那条交替约束。',
  )
  const resultMsg = userMsgs[1]!
  eq((resultMsg.content as unknown[]).length, 2, '两个结果要在同一条消息的 content 数组里')
})

await test('★ 并行结果按 tool_use 原顺序回填', async () => {
  const { fake, promise } = run(
    [
      {
        toolUses: [
          { name: 'echo', input: { v: 'first' } },
          { name: 'echo', input: { v: 'second' } },
        ],
      },
      { text: 'ok' },
    ],
  )
  await promise
  const resultMsg = fake.calls[1]!.filter((m) => m.role === 'user')[1]!
  const contents = (resultMsg.content as { content: string }[]).map((c) => c.content)
  eq(
    contents,
    ['echo:first', 'echo:second'],
    '顺序抖动 → 前缀缓存失效（每轮重新付全价）+ 问题无法复现。\n' +
      '      用 Promise.all（按输入顺序返回），不要「谁完成谁 push」。',
  )
})

await test('工具报错不中断循环', async () => {
  const { promise } = run([{ toolUses: [{ name: 'boom', input: {} }] }, { text: '换了个做法' }])
  const r = await promise
  eq(r.reason, 'done', '工具失败是正常流程的一部分，不该让 agent 崩掉')
  eq(r.steps, 2)
})

await test('trace 记录了每次工具调用', async () => {
  const { promise } = run([{ toolUses: [{ name: 'echo', input: { v: 'x' } }] }, { text: 'ok' }])
  const r = await promise
  eq(r.trace.length, 1)
  eq(r.trace[0]!.toolName, 'echo')
  eq(r.trace[0]!.ok, true)
  assert(r.trace[0]!.preview.length > 0, 'preview 要有内容，它是给人扫日志用的')
})

await test('onStep 回调被调用', async () => {
  const seen: string[] = []
  const { promise } = run([{ toolUses: [{ name: 'echo', input: { v: 'x' } }] }, { text: 'ok' }], {
    onStep: (e) => seen.push(e.toolName),
  })
  await promise
  eq(seen, ['echo'])
})

// ── 终止条件 ────────────────────────────────────────────────────────────

console.log('\n终止条件')

await test('★★ 步数上限：死循环必须被兜住', async () => {
  // 假模型无限重复同一个工具调用——这正是真模型丢了 tool_use 块时的行为
  const { promise } = run([{ toolUses: [{ name: 'echo', input: { v: 'loop' } }] }], { maxSteps: 5, repeatLimit: 999 }, 'repeat_last')
  const r = await promise
  eq(r.reason, 'step_limit', '无限循环时必须撞上步数上限并停下')
  assert(r.steps <= 5, `步数不该超过上限，实际 ${r.steps}`)
})

await test('★★ 撞上限时 reason 必须是 step_limit，不能是 done', async () => {
  const { promise } = run([{ toolUses: [{ name: 'echo', input: { v: 'x' } }], text: '这句话看起来像答案' }], { maxSteps: 2, repeatLimit: 999 }, 'repeat_last')
  const r = await promise
  assert(
    r.reason !== 'done',
    '这是本节最重要的一条。\n' +
      '      撞上限时模型最后那句话往往**看起来像个答案**，\n' +
      '      reason 报 done 的话调用方会拿去用，用户会拿去信。\n' +
      '      而这个 bug 的表现是「agent 偶尔给出不完整的答案」，你会去查 prompt。',
  )
})

await test('★ 预算上限', async () => {
  const { promise } = run(
    [{ toolUses: [{ name: 'echo', input: { v: 'x' } }], usage: { input: 2_000_000, output: 500_000 } }],
    { maxYuan: 0.5, maxSteps: 50, repeatLimit: 999 },
    'repeat_last',
  )
  const r = await promise
  eq(r.reason, 'budget', '累计成本超预算要停下')
})

await test('★ 挂钟超时', async () => {
  const { promise } = run([{ toolUses: [{ name: 'echo', input: { v: 'x' } }] }], { maxMs: 1, maxSteps: 50, repeatLimit: 999 }, 'repeat_last')
  const r = await promise
  eq(r.reason, 'timeout')
})

await test('★★ 取消：要报 cancelled 而不是 error', async () => {
  const ac = new AbortController()
  const fake = fakeModel({ script: [{ toolUses: [{ name: 'echo', input: { v: 'x' } }] }], afterScript: 'repeat_last', delayMs: 40 })
  const p = A.runAgent('做点事', {
    toolbox: makeTools(),
    system: 'test',
    call: fake.call,
    signal: ac.signal,
    maxSteps: 50,
    repeatLimit: 999,
    ledger: new Ledger('test'),
  })
  setTimeout(() => ac.abort(), 60)
  const r = await p
  eq(
    r.reason,
    'cancelled',
    '取消在 call 那里以 AbortError 的形式抛出，要和真故障分开。\n' +
      '      混在一起的后果：用户点了停止，日志里记一条 error，你以为线上有 bug。',
  )
})

await test('★ 取消时已花掉的钱不能丢', async () => {
  const ac = new AbortController()
  const fake = fakeModel({ script: [{ toolUses: [{ name: 'echo', input: { v: 'x' } }] }], afterScript: 'repeat_last', delayMs: 30 })
  const p = A.runAgent('做点事', {
    toolbox: makeTools(),
    system: 'test',
    call: fake.call,
    signal: ac.signal,
    maxSteps: 50,
    repeatLimit: 999,
    ledger: new Ledger('test'),
  })
  setTimeout(() => ac.abort(), 100)
  const r = await p
  assert(
    r.usage.calls > 0,
    '取消不该让账目消失。已经发出去的请求已经花钱了，\n' +
      `      usage 里必须体现出来。实际 calls=${r.usage.calls}`,
  )
})

await test('★ max_tokens 截断不能当成 done', async () => {
  const { promise } = run([{ text: '答案是一半…', stopReason: 'max_tokens' }])
  const r = await promise
  assert(
    r.reason !== 'done',
    '被 max_tokens 截断的输出是残缺的。报 done 等于把半截答案当成完整答案交出去。\n' +
      '      这和 L02 那条「半截内容绝不能静默返回」是同一条纪律。',
  )
})

await test('★ stop_reason 说 tool_use 但没有 tool_use 块，要能停下', async () => {
  const { promise } = run([{ text: '奇怪', stopReason: 'tool_use' }], { maxSteps: 10 }, 'repeat_last')
  const r = await promise
  assert(
    r.reason === 'error' || r.reason === 'step_limit',
    `协议上不该发生，但真发生了必须能停。不停的话下一轮完全一样 → 死循环。实际 reason=${r.reason}`,
  )
})

await test('模型调用抛错要报 error 并带上原始异常', async () => {
  const fake = fakeModel({ script: [], afterScript: 'throw' })
  const r = await A.runAgent('x', {
    toolbox: makeTools(),
    system: 'test',
    call: fake.call,
    ledger: new Ledger('test'),
  })
  eq(r.reason, 'error')
  assert(r.error instanceof Error, 'error 字段要带上原始异常，否则没法排查')
})

// ── 重复检测 ────────────────────────────────────────────────────────────

console.log('\n重复检测')

await test('★★ 同参数调用超限后要拦下，并且返回给模型', async () => {
  const { promise } = run([{ toolUses: [{ name: 'echo', input: { v: 'same' } }] }], { maxSteps: 20, repeatLimit: 2 }, 'repeat_last')
  const r = await promise
  assert(
    calls.length <= 3,
    `拦下之后不该再真的执行工具，实际执行了 ${calls.length} 次。\n` +
      '      注意是「不执行工具」而不是「不回结果」——要回一条 isError 告诉模型它在打转。',
  )
  assert(
    r.reason === 'repeat' || r.reason === 'step_limit',
    `应该以 repeat（更好）或 step_limit 结束，实际 ${r.reason}`,
  )
})

await test('★ 重复检测比步数上限更早发现问题', async () => {
  const { promise } = run([{ toolUses: [{ name: 'echo', input: { v: 'same' } }] }], { maxSteps: 30, repeatLimit: 2 }, 'repeat_last')
  const r = await promise
  assert(
    r.steps < 10,
    `重复检测应该在几步之内就发现，而不是烧满 30 步。实际 ${r.steps} 步。\n` +
      '      这就是它的价值：省下的是钱和时间，而且 reason 更精确——\n' +
      '      「卡在重复调用」比「撞上步数上限」的信息量大得多。',
  )
})

await test('参数不同的调用不算重复', async () => {
  const { promise } = run(
    [
      { toolUses: [{ name: 'echo', input: { v: 'a' } }] },
      { toolUses: [{ name: 'echo', input: { v: 'b' } }] },
      { toolUses: [{ name: 'echo', input: { v: 'c' } }] },
      { text: 'ok' },
    ],
    { repeatLimit: 2 },
  )
  const r = await promise
  eq(r.reason, 'done', '参数不同就不是打转，不该被拦')
  eq(calls.length, 3)
})

await test('重复一次是允许的（重试是合理行为）', async () => {
  const { promise } = run(
    [
      { toolUses: [{ name: 'echo', input: { v: 'x' } }] },
      { toolUses: [{ name: 'echo', input: { v: 'x' } }] },
      { text: 'ok' },
    ],
    { repeatLimit: 2 },
  )
  const r = await promise
  eq(r.reason, 'done', '第二次同样的调用可能是重试瞬时错误，不该拦。第三次才拦。')
  eq(calls.length, 2)
})

await test('★ 拦下时给模型的消息里要有出路', async () => {
  const { promise } = run(
    [
      { toolUses: [{ name: 'echo', input: { v: 'x' } }] },
      { toolUses: [{ name: 'echo', input: { v: 'x' } }] },
      { toolUses: [{ name: 'echo', input: { v: 'x' } }] },
      { text: 'ok' },
    ],
    { repeatLimit: 2 },
  )
  const r = await promise
  // 断言看 transcript 而不是 fake.calls：全部调用都被判重复时循环会立刻结束
  // （这是对的——没必要再烧一轮），所以那条消息进了历史但没被发出去。
  const all = JSON.stringify(r.transcript)
  assert(
    /换个思路|卡在|需要什么/.test(all),
    '拦下之后回给模型的那条消息里没有下一步建议。\n' +
      '      只说「你重复了」它还是不知道该干什么。L04 那条：约束要配一条出路。',
  )
  assert(
    !/echo:x/.test(all.slice(all.lastIndexOf('tool_result'))),
    '拦下之后不该真的执行工具——这一步的意义就是省下这次调用',
  )
})

// ── 收尾 ────────────────────────────────────────────────────────────────

const total = passed + failures.length
console.log(`\n${'─'.repeat(52)}`)
if (failures.length === 0) {
  console.log(`\x1b[32m全绿 ${passed}/${total}。\x1b[0m 你有一个 agent 了。去看 shared/agent.ts 对照取舍。`)
} else {
  console.log(`\x1b[31m${failures.length}/${total} 没过：\x1b[0m`)
  for (const f of failures) console.log(`  · ${f}`)
  console.log('\n带 ★★ 的几条对应真实的失控方式，别跳过。')
  process.exit(1)
}
