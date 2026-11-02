/**
 * 验证 l02/ledger.ts 和 l02/reader.ts。跑法：pnpm verify:l02
 *
 * 和 L00 的 verify 一样：一次 API 都不调。流式事件全是手工造的假数据。
 *
 * 这一点本身就是本节的一个隐含教学点——**流式协议是一串普通的 JSON 事件，
 * 你完全可以离线造出任何一种诡异情况**：中途断掉、乱序、缺字段、
 * 只有 ping。真实网络给不了你的故障，你自己造。
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { StreamAbortedError } from './reader.ts'

/**
 * 默认测你写的版本（l02/）。
 * 想先确认这套测试本身是对的，跑 `VERIFY_TARGET=shared pnpm verify:l02`——
 * 它会去测 shared/ 里我那版，应该全绿。这样后面出红你就知道一定是你的代码，
 * 而不是测试写错了。**先证明尺子是准的，再用它量东西。**
 */
const target = process.env.VERIFY_TARGET === 'shared' ? 'shared' : 'mine'

const { Ledger } =
  target === 'shared' ? await import('../shared/ledger.ts') : await import('./ledger.ts')
const { readStream } =
  target === 'shared' ? await import('../shared/stream.ts') : await import('./reader.ts')

console.log(target === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l02/ 里你的实现）')

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

function assert(ok: boolean, msg: string) {
  if (!ok) throw new Error(msg)
}

const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol

// ── 造假事件的小工具 ──────────────────────────────────────────────────────

type Ev = Anthropic.RawMessageStreamEvent

const evStart = (input = 100, id = 'msg_test', model = 'deepseek-v4-flash') =>
  ({
    type: 'message_start',
    message: { id, model, role: 'assistant', content: [], usage: { input_tokens: input, output_tokens: 0 } },
  }) as unknown as Ev

const evBlockStart = (index: number, type: string, extra: object = {}) =>
  ({ type: 'content_block_start', index, content_block: { type, ...extra } }) as unknown as Ev

const evText = (index: number, text: string) =>
  ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }) as unknown as Ev

const evThink = (index: number, thinking: string) =>
  ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } }) as unknown as Ev

const evJson = (index: number, partial_json: string) =>
  ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } }) as unknown as Ev

const evBlockStop = (index: number) => ({ type: 'content_block_stop', index }) as unknown as Ev
const evPing = () => ({ type: 'ping' }) as unknown as Ev

const evMsgDelta = (stop_reason: string, output = 42) =>
  ({ type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: output } }) as unknown as Ev

const evStop = () => ({ type: 'message_stop' }) as unknown as Ev

const evError = (message: string) =>
  ({ type: 'error', error: { type: 'overloaded_error', message } }) as unknown as Ev

async function* feed(...events: Ev[]) {
  for (const e of events) yield e
}

/** 一条完整正常的流：思考块 + 正文块。 */
const happyPath = () =>
  feed(
    evStart(120),
    evBlockStart(0, 'thinking'),
    evThink(0, '让我想想'),
    evThink(0, '，应该是这样'),
    evBlockStop(0),
    evPing(),
    evBlockStart(1, 'text'),
    evText(1, '答案'),
    evText(1, '是 42'),
    evBlockStop(1),
    evMsgDelta('end_turn', 88),
    evStop(),
  )

// ── Ledger ───────────────────────────────────────────────────────────────

const entry = (label: string, input: number, output: number, hit = 0, write = 0) => ({
  label,
  id: `msg_${label}`,
  model: 'deepseek-v4-flash',
  usage: {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: hit,
    cache_creation_input_tokens: write,
  },
  ms: 1000,
})

console.log('\nLedger')

await test('record 之后能读回来', () => {
  const l = new Ledger()
  l.record(entry('a', 100, 50))
  l.record(entry('b', 200, 60))
  assert(l.entries.length === 2, `期待 2 条，实际 ${l.entries.length}`)
})

await test('costOf：没有缓存时按 miss 单价算', () => {
  const l = new Ledger()
  // 1000 输入 × 1 元/百万 + 500 输出 × 2 元/百万 = 0.001 + 0.001 = 0.002
  const cost = l.costOf(entry('x', 1000, 500))
  assert(near(cost, 0.002), `期待 0.002，实际 ${cost}`)
})

await test('★ costOf：命中的部分要按便宜单价算，不能重复计费', () => {
  const l = new Ledger()
  // 输入 1000，其中 800 命中缓存 → 未命中 200
  // 200×1/1e6 + 800×0.02/1e6 + 0 输出 = 0.0002 + 0.000016 = 0.000216
  const cost = l.costOf(entry('x', 1000, 0, 800))
  assert(
    near(cost, 0.000216),
    `期待 0.000216，实际 ${cost}。\n` +
      `      input_tokens 是**总输入**，命中的那部分已经便宜了。\n` +
      `      未命中量 = input_tokens − cache_read = 200，不是 1000。\n` +
      `      直接拿 1000 乘 miss 单价，等于把省下的钱又算回来了。`,
  )
})

await test('costOf：写入缓存的部分按 miss 单价算', () => {
  const l = new Ledger()
  // 输入 1000 全是首次写入缓存：1000×1/1e6 + 1000×1/1e6（write）= 0.002
  const cost = l.costOf(entry('x', 1000, 0, 0, 1000))
  assert(cost > 0.001, `写入缓存不该是免费的，实际算出 ${cost}`)
})

await test('totals：能处理缺失的 cache_* 字段', () => {
  const l = new Ledger()
  // 兼容端点可能压根不返回缓存字段
  l.record({
    label: 'bare',
    id: 'msg_bare',
    model: 'deepseek-v4-flash',
    usage: { input_tokens: 100, output_tokens: 20 },
    ms: 500,
  })
  const t = l.totals()
  assert(t.cacheRead === 0 && t.cacheWrite === 0, 'undefined 应该当 0 处理，不能变成 NaN')
  assert(!Number.isNaN(t.yuan), `yuan 变成 NaN 了——说明 undefined 参与了算术`)
})

await test('totals：多条累加正确', () => {
  const l = new Ledger()
  l.record(entry('a', 100, 50))
  l.record(entry('b', 300, 70))
  const t = l.totals()
  assert(t.calls === 2, `calls 期待 2，实际 ${t.calls}`)
  assert(t.inputTokens === 400, `inputTokens 期待 400，实际 ${t.inputTokens}`)
  assert(t.outputTokens === 120, `outputTokens 期待 120，实际 ${t.outputTokens}`)
})

await test('★ cacheHitRate：没有缓存数据时返回 null 而不是 0', () => {
  const l = new Ledger()
  l.record({
    label: 'bare',
    id: 'msg_bare',
    model: 'deepseek-v4-flash',
    usage: { input_tokens: 100, output_tokens: 20 },
    ms: 500,
  })
  assert(
    l.cacheHitRate() === null,
    `期待 null，实际 ${l.cacheHitRate()}。\n` +
      `      「端点没返回缓存字段」和「命中率是 0%」是两个完全不同的结论。\n` +
      `      前者你该去查为什么没数据，后者你该去查为什么没命中。混成一个数你会误判。`,
  )
})

await test('cacheHitRate：有数据时算得对', () => {
  const l = new Ledger()
  l.record(entry('a', 1000, 0, 750))
  assert(near(l.cacheHitRate()!, 0.75), `期待 0.75，实际 ${l.cacheHitRate()}`)
})

await test('report 不炸，且包含合计行', () => {
  const l = new Ledger('测试账本')
  l.record(entry('a', 100, 50))
  const out = l.report()
  assert(out.includes('测试账本'), '报告里应该有账本名字')
  assert(/合计/.test(out), '报告里应该有一行合计')
})

// ── readStream ───────────────────────────────────────────────────────────

console.log('\nreadStream')

await test('正常流：能拿到正文', async () => {
  const r = await readStream(happyPath())
  assert(r.text === '答案是 42', `期待「答案是 42」，实际 ${JSON.stringify(r.text)}`)
})

await test('★ 按 index 分桶：思考内容不能混进正文', async () => {
  const r = await readStream(happyPath())
  assert(
    !r.text.includes('让我想想'),
    `正文里混进了思考内容：${JSON.stringify(r.text)}。\n` +
      `      所有 delta 都 += 到同一个字符串上就会这样。要用 Map<index, block> 分桶。`,
  )
  assert(r.thinking === '让我想想，应该是这样', `thinking 没收对：${JSON.stringify(r.thinking)}`)
})

await test('★ delta 类型：thinking_delta 取 .thinking 而不是 .text', async () => {
  const r = await readStream(happyPath())
  assert(
    !r.thinking.includes('undefined') && !r.text.includes('undefined'),
    `输出里出现了字面量 "undefined"，说明你对所有 delta 都取了 .text。\n` +
      `      text_delta → .text，thinking_delta → .thinking，input_json_delta → .partial_json`,
  )
})

await test('★ usage：output_tokens 必须从 message_delta 取', async () => {
  const r = await readStream(happyPath())
  assert(r.usage.input_tokens === 120, `input_tokens 期待 120，实际 ${r.usage.input_tokens}`)
  assert(
    r.usage.output_tokens === 88,
    `output_tokens 期待 88，实际 ${r.usage.output_tokens}。\n` +
      `      message_start 里的 output_tokens 恒为 0（那时候还没生成）。\n` +
      `      真正的值在 message_delta，同一个事件还带 stop_reason。`,
  )
})

await test('stop_reason 收到了', async () => {
  const r = await readStream(happyPath())
  assert(r.stopReason === 'end_turn', `期待 end_turn，实际 ${r.stopReason}`)
})

await test('id 和 model 记下来了', async () => {
  const r = await readStream(happyPath())
  assert(r.id === 'msg_test' && r.model === 'deepseek-v4-flash', 'id / model 没记全')
})

await test('ping 事件被安静忽略', async () => {
  const r = await readStream(feed(evStart(), evPing(), evPing(), evMsgDelta('end_turn', 0), evStop()))
  assert(r.text === '', `ping 不该产生任何文本，实际 ${JSON.stringify(r.text)}`)
})

await test('onText 回调只收正文，不收思考', async () => {
  const chunks: string[] = []
  await readStream(happyPath(), (c) => chunks.push(c))
  assert(
    chunks.join('') === '答案是 42',
    `回调收到的内容不对：${JSON.stringify(chunks.join(''))}。思考块不该触发 onText。`,
  )
})

await test('★★ 没收到 message_stop 就结束 → 必须抛错', async () => {
  // 模拟连接被中间代理掐掉：流正常结束，但没有 message_stop，也没有 error 事件
  let threw = false
  try {
    await readStream(
      feed(evStart(), evBlockStart(0, 'text'), evText(0, '半截话'), evBlockStop(0)),
    )
  } catch {
    threw = true
  }
  assert(
    threw,
    '流没收到 message_stop 就结束了，这时返回的内容是不完整的，必须抛错。\n' +
      '      这一条最难想到：for await 会安静地正常退出，一个错误都不抛。\n' +
      '      判据只能是显式的 sawStop 标记。',
  )
})

await test('★ 流内 error 事件 → 抛错，且带上已累积的部分', async () => {
  let err: unknown
  try {
    await readStream(
      feed(evStart(), evBlockStart(0, 'text'), evText(0, '已经渲染出去的'), evError('overloaded')),
    )
  } catch (e) {
    err = e
  }
  assert(err instanceof Error, 'error 事件必须抛错——HTTP 是 200 不代表这次调用成功了')
  const partial = (err as StreamAbortedError).partial
  assert(
    partial != null,
    '抛错时要把已累积的内容放进 partial。调用方需要它来决定怎么收拾——\n' +
      '      通常是丢弃并重发，但那是调用方的决定，不是你的。',
  )
})

await test('工具调用块：JSON 参数按 index 拼完整', async () => {
  const r = await readStream(
    feed(
      evStart(),
      evBlockStart(0, 'tool_use', { id: 'tu_1', name: 'read_file' }),
      evJson(0, '{"path"'),
      evJson(0, ':"a.ts"}'),
      evBlockStop(0),
      evMsgDelta('tool_use', 30),
      evStop(),
    ),
  )
  const tool = r.blocks.find((b) => b.type === 'tool_use')
  assert(tool != null, 'blocks 里应该有 tool_use 块')
  assert(
    tool!.text === '{"path":"a.ts"}',
    `JSON 参数没拼完整：${JSON.stringify(tool!.text)}。\n` +
      `      L04 之后这里一错就是 JSON.parse 直接炸。`,
  )
  assert(tool!.toolName === 'read_file', `工具名没记下来：${tool!.toolName}`)
})

await test('两个并行工具调用不能串到一起', async () => {
  const r = await readStream(
    feed(
      evStart(),
      evBlockStart(0, 'tool_use', { id: 'tu_1', name: 'read_file' }),
      evBlockStart(1, 'tool_use', { id: 'tu_2', name: 'list_dir' }),
      // 故意交错发送，真实的并行工具调用就是这样
      evJson(0, '{"path":'),
      evJson(1, '{"dir":'),
      evJson(0, '"a.ts"}'),
      evJson(1, '"src"}'),
      evBlockStop(0),
      evBlockStop(1),
      evMsgDelta('tool_use', 40),
      evStop(),
    ),
  )
  const tools = r.blocks.filter((b) => b.type === 'tool_use')
  assert(tools.length === 2, `期待 2 个工具调用，实际 ${tools.length}`)
  assert(
    tools[0]!.text === '{"path":"a.ts"}' && tools[1]!.text === '{"dir":"src"}',
    `两个工具的参数串了：\n      ${JSON.stringify(tools.map((t) => t.text))}\n` +
      `      服务端会交错发送不同 index 的 delta，这就是必须分桶的实战理由。`,
  )
})

// ── 收尾 ─────────────────────────────────────────────────────────────────

const total = passed + failures.length
console.log(`\n${'─'.repeat(52)}`)
if (failures.length === 0) {
  console.log(`\x1b[32m全绿 ${passed}/${total}。\x1b[0m 现在可以去看 shared/ 里我那两版，对照一下取舍。`)
} else {
  console.log(`\x1b[31m${failures.length}/${total} 没过：\x1b[0m`)
  failures.forEach((f) => console.log(`  · ${f}`))
  console.log('\n带 ★ 的几条是真实项目里咬过人的地方，别跳过。')
  process.exitCode = 1
}
