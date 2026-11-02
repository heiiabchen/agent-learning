/**
 * 验证 l15/cache.ts。跑法：pnpm verify:l15
 * 先跑 BUDGET_IMPL=shared pnpm verify:l15 确认测试本身是对的。
 *
 * ★ 一次模型都不调。这不是省事——是这一节要测的东西**恰好全是结构性的**：
 * 缓存命中是前缀哈希相等（字符串比较），计费是 token 数乘单价倍率（整数算术），
 * 限流是 token bucket（状态机），路由成本是概率乘单价的加权和（整数算术）。
 *
 * 反过来说：**真去调模型会让这些结论变得不可复现。** 时段、负载、并发邻居的
 * 方差大于你想测的效应，于是一个学生在晚上测出「缓存让延迟降了 40%」，
 * 另一个在早上测出「降了 5%」，两个人都以为对方错了。
 *
 * 带 ★ 的每一条对应一种"看起来对了但没有"：
 * 把 input_tokens 当总输入、把不可观测当成未命中、把追加当成安全、
 * 把截断当成追加、用 % 取随机数的低位、让倍率的除法提前发生。
 *
 * 它们的共同点和 L13/L14 一样：**全都不抛异常，而且日志上是绿的。**
 */

import * as shared from '../shared/budget.ts'
import type { Block, CacheEntry, Price, Req, Task, ToolDef } from '../shared/budget.ts'

const TARGET = process.env.BUDGET_IMPL === 'shared' ? 'shared' : 'mine'
const mine = (await import('./cache.ts')) as unknown as {
  canonicalJson: typeof shared.canonicalJson
  firstDivergence: typeof shared.firstDivergence
  cacheVerdict: typeof shared.cacheVerdict
  simulateTurn: typeof shared.simulateTurn
  mixedTtlBill: typeof shared.mixedTtlBill
  Limiter: typeof shared.Limiter
  routeOutcome: typeof shared.routeOutcome
}
const M = TARGET === 'shared' ? shared : mine

console.log(TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l15/ 里你的实现）')

let passed = 0
const failures: string[] = []

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`\x1b[32m  ✓ ${name}\x1b[0m`)
  } catch (err) {
    failures.push(name)
    console.log(`\x1b[31m  ✕ ${name}\x1b[0m`)
    for (const l of String((err as Error).message).split('\n')) console.log(`\x1b[31m      ${l}\x1b[0m`)
  }
}

/**
 * ★ 这个 replacer 不是装饰。`JSON.stringify` 遇到 bigint 会直接**抛异常**
 * （"Do not know how to serialize a BigInt"），而这一节的金额全是 bigint。
 * 少了它，一条断言失败会被报成一个和内容无关的类型错误，
 * 你会去查被测函数，而问题在测试工具里。
 */
const show = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))

function eq(a: unknown, b: unknown, msg = '') {
  const [x, y] = [show(a), show(b)]
  if (x !== y) throw new Error(`${msg}\n  期望 ${y}\n  实际 ${x}`)
}
function ok(c: boolean, msg = '') {
  if (!c) throw new Error(msg)
}
function throws(fn: () => unknown, msg = '') {
  try {
    fn()
  } catch {
    return
  }
  throw new Error(`${msg}\n  期望抛错，但它正常返回了`)
}
function section(s: string) {
  console.log(`\n\x1b[1m${s}\x1b[0m`)
}

// 公用夹具
const PRICE: Price = { inputMiss: 100_000_000n, output: 200_000_000n }
const T = (n: string, d = 'd'): ToolDef => ({ name: n, description: d, inputSchema: { x: 1 } })
const B = (t: string): Block => ({ type: 'text', text: t })
const REQ = (over: Partial<Req> = {}): Req => ({
  model: 'claude-opus-5',
  tools: [T('a')],
  system: [B('sys')],
  messages: [B('hi')],
  ...over,
})

// ═════════════════════════════════════════════════════════════
section('一、canonicalJson：让语义相同的东西产生相同的字节')
// ═════════════════════════════════════════════════════════════

await test('键序无关', () => {
  eq(M.canonicalJson({ b: 1, a: 2 }), M.canonicalJson({ a: 2, b: 1 }))
})

await test('嵌套对象的键也排序', () => {
  eq(M.canonicalJson({ z: { d: 1, c: 2 } }), '{"z":{"c":2,"d":1}}')
})

await test('分隔符不带空格（json.dumps 默认带，所以不能用它）', () => {
  eq(M.canonicalJson({ a: 1, b: [1, 2] }), '{"a":1,"b":[1,2]}')
})

await test('数组顺序**不**排序（顺序是语义的一部分）', () => {
  ok(M.canonicalJson([1, 2]) !== M.canonicalJson([2, 1]), '数组是有序的，排序会抹掉语义')
})

await test('★ 拒绝非整数——它在两种语言里印法可能不同', () => {
  throws(() => M.canonicalJson({ a: 0.1 }), '浮点必须被拒绝，不能悄悄产生一个不一致的字节串')
})

// ★ 这一条在 Python 那边没有对应项——Python 没有 undefined，一个键要么在要么不在。
// 所以 TS 的测试数比 Python 多一条，这是预期的，不是漏写。
await test('★ 跳过值为 undefined 的键（不能印成 "b":undefined，那不是合法 JSON）', () => {
  eq(M.canonicalJson({ a: 1, b: undefined }), '{"a":1}')
})

await test('字符串转义：引号、反斜杠、换行、制表符', () => {
  eq(M.canonicalJson('a"b\\c\nd\te'), '"a\\"b\\\\c\\nd\\te"')
})

await test('控制字符转成 \\u00xx', () => {
  eq(M.canonicalJson('\u0001'), '"\\u0001"')
})

await test('★ 非 ASCII **不**转义（json.dumps 默认会转，两边就不一致了）', () => {
  eq(M.canonicalJson('中文'), '"中文"')
})

await test('★ 这就是「让工具定义可缓存」需要的那个函数', () => {
  // 官方："some languages randomize key order during JSON conversion, breaking caches"
  const s1 = { type: 'object', properties: { path: 'string' }, required: ['path'] }
  const s2 = { required: ['path'], properties: { path: 'string' }, type: 'object' }
  eq(M.canonicalJson(s1), M.canonicalJson(s2))
  ok(
    JSON.stringify(s1) !== JSON.stringify(s2),
    '★ 注意 JSON.stringify 对这两个是**不同**的字节串——这正是缓存被打掉的方式',
  )
})

// ═════════════════════════════════════════════════════════════
section('二、firstDivergence：只报最早的那一处')
// ═════════════════════════════════════════════════════════════

await test('完全相同 → null', () => {
  eq(M.firstDivergence(REQ(), REQ()), null)
})

await test('换模型 → model_changed', () => {
  eq(M.firstDivergence(REQ(), REQ({ model: 'claude-sonnet-5' }))?.type, 'model_changed')
})

await test('★ 换模型的同时改了 system → 只报 model_changed，不再看其它层', () => {
  const d = M.firstDivergence(REQ(), REQ({ model: 'claude-sonnet-5', system: [B('SYS')] }))
  eq(d?.type, 'model_changed')
  eq(d?.at, null, 'model_changed 没有层内位置')
})

await test('改工具描述一个字 → tools_changed（这就是 L14 的 rug pull）', () => {
  eq(M.firstDivergence(REQ(), REQ({ tools: [T('a', 'd!')] }))?.type, 'tools_changed')
})

await test('★ 工具重排（内容完全相同，只是顺序不同）→ 也要报 tools_changed', () => {
  // 官方："tools were added, removed, or **reordered** between turns"
  const p = REQ({ tools: [T('a'), T('b')] })
  const c = REQ({ tools: [T('b'), T('a')] })
  eq(M.firstDivergence(p, c)?.type, 'tools_changed')
})

await test('★ 工具清单末尾加一个 → tools_changed，**不是** null', () => {
  // 追加只在最后一层安全。tools 排在 system/messages 前面，
  // 加一个工具会把后面全部位移，于是那两层的断点哈希全变。
  const d = M.firstDivergence(REQ(), REQ({ tools: [T('a'), T('b')] }))
  eq(d?.type, 'tools_changed')
  eq(d?.at, 1, '分歧位置在新加的那个工具上')
})

await test('★ system 末尾加一块 → system_changed，**不是** null', () => {
  const d = M.firstDivergence(REQ(), REQ({ system: [B('sys'), B('more')] }))
  eq(d?.type, 'system_changed')
  eq(d?.at, 1)
})

await test('messages 末尾追加 → null（这才是真正的追加）', () => {
  eq(M.firstDivergence(REQ(), REQ({ messages: [B('hi'), B('next')] })), null)
})

await test('messages 中间插入 → messages_changed，位置在插入点', () => {
  const p = REQ({ messages: [B('a'), B('b')] })
  const c = REQ({ messages: [B('a'), B('X'), B('b')] })
  const d = M.firstDivergence(p, c)
  eq(d?.type, 'messages_changed')
  eq(d?.at, 1)
})

await test('★ messages 被截断（上下文压缩）→ messages_changed，不能当成追加', () => {
  // 追加和截断对缓存的后果完全相反。把两者等同处理的实现，
  // 会把每次上下文压缩都报成「一切正常」。
  const p = REQ({ messages: [B('a'), B('b')] })
  const c = REQ({ messages: [B('a')] })
  const d = M.firstDivergence(p, c)
  eq(d?.type, 'messages_changed')
  eq(d?.at, 1, '截断点就是较短那个的长度')
})

await test('★ 层级顺序：tools 和 messages 同时变 → 报 tools_changed', () => {
  // 官方："Changes at each level invalidate that level and all subsequent levels."
  const d = M.firstDivergence(REQ(), REQ({ tools: [T('a', 'd!')], messages: [B('HI')] }))
  eq(d?.type, 'tools_changed', 'messages 的变化被 tools 的变化盖住了，报它没有信息量')
})

await test('层级顺序：system 和 messages 同时变 → 报 system_changed', () => {
  eq(M.firstDivergence(REQ(), REQ({ system: [B('S')], messages: [B('HI')] }))?.type, 'system_changed')
})

await test('空的 prev → previous_message_not_found，不是 messages_changed', () => {
  const empty: Req = { model: 'claude-opus-5', tools: [], system: [], messages: [] }
  eq(M.firstDivergence(empty, REQ())?.type, 'previous_message_not_found')
})

await test('cacheMissedTokens = 分歧点之后（含）的 token 数', () => {
  const p = REQ({ messages: [B('a'), B('b')] })
  const c = REQ({ messages: [B('a'), B('X')] })
  const d = M.firstDivergence(p, c)
  const after = shared.blockTokens(B('X'))
  eq(d?.cacheMissedTokens, after, '只算分歧点之后的，前面那些是可复用的')
})

await test('★ system 里插一个时间戳 → 每一轮都 system_changed', () => {
  // 这就是那个 +25% 且日志全绿的场景。
  const at = (m: number) => REQ({ system: [B('稳定的项目背景'), B(`当前时间 10:${m}`)] })
  for (let m = 1; m < 5; m++) {
    eq(M.firstDivergence(at(m - 1), at(m))?.type, 'system_changed', `第 ${m} 轮`)
  }
})

// ═════════════════════════════════════════════════════════════
section('三、cacheVerdict：五种端点，五个状态')
// ═════════════════════════════════════════════════════════════

await test('anthropic 命中', () => {
  const r = M.cacheVerdict(
    'anthropic',
    { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    'claude-opus-5',
  )
  eq(r.verdict, 'HIT')
  eq(r.readTokens, 900)
})

await test('★★ anthropic 的 totalInput = input_tokens + read + write，不是 input_tokens', () => {
  // 官方：input_tokens 只表示**最后一个断点之后**的 token 数。
  // 一个直接把它当总输入的实现，会算出一个看起来合理但偏小的命中率——
  // 偏小的方向正好让你以为「缓存没什么用」。
  const r = M.cacheVerdict(
    'anthropic',
    { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 },
    'claude-opus-5',
  )
  eq(r.totalInput, 1000, '10 + 900 + 90')
})

await test('anthropic 只写不读 → WRITE_ONLY', () => {
  const r = M.cacheVerdict(
    'anthropic',
    { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 },
    'claude-opus-5',
  )
  eq(r.verdict, 'WRITE_ONLY')
})

await test('★ WRITE_ONLY 的 reason 要说出"连续两次就是 bug"', () => {
  const r = M.cacheVerdict(
    'anthropic',
    { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 },
    'claude-opus-5',
  )
  ok(r.reason.includes('两次'), '第一次只写不读是正常的冷启动，判定器必须把这件事讲清楚')
})

await test('★ 双 0 + 前缀低于门槛 → BELOW_MINIMUM，不是 MISS', () => {
  // 官方："processed without caching, and **no error is returned**"
  const r = M.cacheVerdict(
    'anthropic',
    { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    'claude-opus-5',
    100,
  )
  eq(r.verdict, 'BELOW_MINIMUM', 'Opus 5 的门槛是 512，100 token 根本进不去')
})

await test('双 0 + 前缀够长 → MISS', () => {
  const r = M.cacheVerdict(
    'anthropic',
    { input_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    'claude-opus-5',
    5000,
  )
  eq(r.verdict, 'MISS')
})

await test('★ 门槛未公布（-1）时不能判 BELOW_MINIMUM', () => {
  // 「厂商没公布门槛」和「门槛是 0」是两件事。
  const r = M.cacheVerdict(
    'deepseek',
    { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 5 },
    'deepseek-v4-flash',
    5,
  )
  eq(r.verdict, 'MISS', '没有已知门槛就不该推断"因为太短"')
})

await test('openai-responses 命中', () => {
  const r = M.cacheVerdict(
    'openai-responses',
    { input_tokens: 1000, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 } },
    'gpt-5-6',
  )
  eq(r.verdict, 'HIT')
  eq(r.totalInput, 1000, '★ OpenAI 的 input_tokens 已含缓存部分，不要再加')
})

await test('azure-chat 的字段在 prompt_tokens_details 下', () => {
  const r = M.cacheVerdict(
    'azure-chat',
    { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 500, cache_write_tokens: 0 } },
    'gpt-5-6',
  )
  eq(r.verdict, 'HIT')
  eq(r.readTokens, 500)
})

await test('deepseek 命中，总输入 = hit + miss', () => {
  const r = M.cacheVerdict(
    'deepseek',
    { prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 },
    'deepseek-v4-flash',
  )
  eq(r.verdict, 'HIT')
  eq(r.totalInput, 1000)
})

await test('★ deepseek 没有写入字段，但**不能**因此判 UNDETERMINABLE', () => {
  // 它的读字段是有的，能判。写入是 0 不是"缺数据"——DeepSeek 的缓存自动开启，
  // 压根不区分写入阶段。
  const r = M.cacheVerdict(
    'deepseek',
    { prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 },
    'deepseek-v4-flash',
  )
  eq(r.writeTokens, 0)
  ok(r.verdict !== 'UNDETERMINABLE', '有读字段就能判，别把"没有这个概念"当成"看不见"')
})

await test('★ deepseek 未命中时 reason 要说明该 provider 不区分写入', () => {
  const r = M.cacheVerdict(
    'deepseek',
    { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000 },
    'deepseek-v4-flash',
  )
  eq(r.verdict, 'MISS')
  ok(r.reason.includes('不区分'), '否则读的人会以为 write=0 是数据缺失')
})

await test('★★ anthropic 的 OpenAI 兼容层 → UNDETERMINABLE，**绝不能**是 MISS', () => {
  // 官方对自己这条端点的原话：usage.prompt_tokens_details "Always empty"。
  // 这两个状态混淆是本节最重要的那个 bug：
  // 判成 MISS，你会去优化一个你根本观测不到的东西。
  const r = M.cacheVerdict('anthropic-openai-compat', { prompt_tokens: 5000 }, 'claude-opus-5', 5000)
  eq(r.verdict, 'UNDETERMINABLE')
  eq(r.totalInput, 5000, '总输入还是能读到的，只有缓存的拆分读不到')
})

await test('★ 缓存字段整个缺失 → UNDETERMINABLE', () => {
  const r = M.cacheVerdict('anthropic', { input_tokens: 5000 }, 'claude-opus-5', 5000)
  eq(r.verdict, 'UNDETERMINABLE', '可能是兼容层剥掉了，也可能是 SDK 旧——但都不是"没命中"')
})

await test('★ UNDETERMINABLE 的 read/write 必须是 0，不能瞎猜一个数', () => {
  const r = M.cacheVerdict('anthropic-openai-compat', { prompt_tokens: 5000 }, 'claude-opus-5')
  eq([r.readTokens, r.writeTokens], [0, 0])
})

await test('HIT 的百分比走整数路径（90.0 而不是 90）', () => {
  // ★ 这一条是双语言对拍的地雷：Math.round(read/total*1000)/10 印出 "90"，
  // 而整数版印出 "90.0"。这一节自己讲的纪律，在自己的代码里也得守。
  const r = M.cacheVerdict(
    'anthropic',
    { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    'claude-opus-5',
  )
  ok(r.reason.includes('90.0%'), `期望 reason 里出现 90.0%，实际：${r.reason}`)
})

// ═════════════════════════════════════════════════════════════
section('四、simulateTurn：20 格窗口与"只找之前写过的"')
// ═════════════════════════════════════════════════════════════

const hs = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`)

await test('官方例子 Turn 1：10 个位置，断点 10 → 写入位置 10', () => {
  const store: CacheEntry[] = []
  const r = M.simulateTurn(hs(10), [10], store)
  eq([r.hitAt, r.wroteAt], [null, 10])
})

await test('官方例子 Turn 2：断点 15 往回走，命中位置 10', () => {
  const store: CacheEntry[] = []
  M.simulateTurn(hs(10), [10], store)
  const r = M.simulateTurn(hs(15), [15], store)
  eq([r.hitAt, r.wroteAt], [10, 15])
  eq(r.freshBlocks, 5, '只需新算 11..15')
})

await test('★★ 官方例子 Turn 3：断点 35，窗口是 16..35 → 未命中（差一格）', () => {
  // 官方原文："The turn-2 entry at block 15 is one position outside the window,
  // so there is no cache hit."
  // 这个用例的价值是它来自官方，可以当规格用。
  const store: CacheEntry[] = []
  M.simulateTurn(hs(10), [10], store)
  M.simulateTurn(hs(15), [15], store)
  const r = M.simulateTurn(hs(35), [35], store)
  eq(r.hitAt, null, '位置 15 在 20 格窗口外一格')
})

await test('★ 写只发生在断点，不给任何更早的位置写', () => {
  // 官方："Marking a block with cache_control writes **exactly one** cache entry…
  // The system does not write entries for any earlier position."
  const store: CacheEntry[] = []
  M.simulateTurn(hs(10), [10], store)
  eq(store.length, 1, '一个断点只写一条')
  eq(store[0]?.position, 10)
})

await test('★ lookback 把断点自己算作第一个位置（所以往回只有 19 格）', () => {
  const store: CacheEntry[] = []
  M.simulateTurn(hs(1), [1], store) // 在位置 1 写入
  // 断点 20：窗口 1..20，位置 1 刚好在内
  eq(M.simulateTurn(hs(20), [20], store).hitAt, 1, '20 - 20 + 1 = 1，在窗口内')
  const store2: CacheEntry[] = []
  M.simulateTurn(hs(1), [1], store2)
  // 断点 21：窗口 2..21，位置 1 出界
  eq(M.simulateTurn(hs(21), [21], store2).hitAt, null, '差一格')
})

await test('★ 断点超过 4 个 → 抛错（官方返回 400）', () => {
  throws(() => M.simulateTurn(hs(10), [1, 2, 3, 4, 5], []), '上限是 4，自动缓存还要占一个名额')
})

await test('前缀变了就命不中（哈希不等，即使位置对）', () => {
  const store: CacheEntry[] = []
  M.simulateTurn(hs(10), [10], store)
  const changed = hs(10)
  changed[9] = 'CHANGED'
  eq(M.simulateTurn(changed, [10], store).hitAt, null)
})

await test('★ 连续的 tool_use 归并成一个位置（否则并行调用会挤爆窗口）', () => {
  // 官方："a run of consecutive tool_use blocks counts as one position, and so
  // does a run of consecutive tool_result blocks, so a turn with many parallel
  // tool calls doesn't push the previous request's entry out of the window."
  const blocks: Block[] = [
    B('sys'),
    ...Array.from({ length: 8 }, () => ({ type: 'tool_use' }) as Block),
    ...Array.from({ length: 8 }, () => ({ type: 'tool_result' }) as Block),
    B('done'),
  ]
  eq(shared.mergePositions(blocks).length, 4, 'sys + 一串 tool_use + 一串 tool_result + done')
})

// ═════════════════════════════════════════════════════════════
section('五、mixedTtlBill：官方的三点式公式')
// ═════════════════════════════════════════════════════════════

await test('A / B / C 三段分别按读、1h 写、5m 写计费', () => {
  const b = M.mixedTtlBill(1000, 1500, 1800, PRICE)
  eq([b.readTokens, b.write1hTokens, b.write5mTokens], [1000, 500, 300])
})

await test('计费 = 0.1×A + 2×(B−A) + 1.25×(C−B)', () => {
  const b = M.mixedTtlBill(1000, 1500, 1800, PRICE)
  const want =
    shared.charge(1000, PRICE.inputMiss, shared.MULT.cacheRead) +
    shared.charge(500, PRICE.inputMiss, shared.MULT.cacheWrite1h) +
    shared.charge(300, PRICE.inputMiss, shared.MULT.cacheWrite5m)
  eq(b.picofen.toString(), want.toString())
})

await test('没有 1h 断点时 B 等于 A', () => {
  const b = M.mixedTtlBill(1000, 1000, 1800, PRICE)
  eq([b.readTokens, b.write1hTokens, b.write5mTokens], [1000, 0, 800])
})

await test('一次都没命中时 A = 0', () => {
  const b = M.mixedTtlBill(0, 0, 1800, PRICE)
  eq([b.readTokens, b.write5mTokens], [0, 1800])
})

await test('★ 违反"1 小时必须排在 5 分钟前面"要抛错', () => {
  // 官方："Cache entries with longer TTL must appear before shorter TTLs"
  // 顺序反了这个账根本算不出来，静默返回一个数比抛错危险得多。
  throws(() => M.mixedTtlBill(1000, 800, 1800, PRICE), 'A ≤ B ≤ C 被违反')
  throws(() => M.mixedTtlBill(0, 1800, 1000, PRICE), 'B > C')
})

// ═════════════════════════════════════════════════════════════
section('六、Limiter：连续补充的桶，不是固定窗口')
// ═════════════════════════════════════════════════════════════

await test('★★ 60 RPM 不等于"这一分钟随便发 60 个"', () => {
  // 官方："a rate of 60 RPM might be enforced as **1 request per second**"
  // 一个按固定窗口实现的客户端限流器，会在每分钟开头突发 60 个然后吃一串 429，
  // 而它自己的计数器显示"没超"。
  const lim = new M.Limiter({ capacity: 1, refillPerSec: 1 }, 0)
  let allowed = 0
  for (let i = 0; i < 60; i++) if (lim.take(0).allowed) allowed++
  eq(allowed, 1, '同一时刻只放行一个')
})

await test('按 1 秒 1 个的节奏发，60 个全放行', () => {
  const lim = new M.Limiter({ capacity: 1, refillPerSec: 1 }, 0)
  let allowed = 0
  for (let i = 0; i < 60; i++) if (lim.take(i * 1000).allowed) allowed++
  eq(allowed, 60)
})

await test('拒绝时给出 retryAfterMs', () => {
  const lim = new M.Limiter({ capacity: 1, refillPerSec: 1 }, 0)
  lim.take(0)
  const r = lim.take(0)
  ok(!r.allowed, '第二个应该被拒')
  if (!r.allowed) eq(r.retryAfterMs, 1000, '空桶补满一个令牌要 1 秒')
})

await test('补了一半的桶，retryAfterMs 也是一半', () => {
  const lim = new M.Limiter({ capacity: 1, refillPerSec: 1 }, 0)
  lim.take(0)
  const r = lim.take(500)
  ok(!r.allowed)
  if (!r.allowed) eq(r.retryAfterMs, 500)
})

await test('桶不会超过容量（攒不了无限的额度）', () => {
  const lim = new M.Limiter({ capacity: 3, refillPerSec: 1 }, 0)
  let allowed = 0
  for (let i = 0; i < 10; i++) if (lim.take(1_000_000).allowed) allowed++
  eq(allowed, 3, '放了一百万毫秒也只攒到容量上限')
})

await test('★ 时钟倒流要抛错（注入的时钟必须单调不减）', () => {
  const lim = new M.Limiter({ capacity: 1, refillPerSec: 1 }, 1000)
  throws(() => lim.take(500), '时钟倒流会让桶算出负的经过时间')
})

await test('★ 令牌数是定点字符串，不是浮点（双语言对拍）', () => {
  const lim = new M.Limiter({ capacity: 1, refillPerSec: 1 }, 0)
  const r = lim.take(0)
  eq(typeof r.tokens, 'string', '返回浮点，两种语言会印出不同的位数')
  eq(r.tokens, '0.000')
})

await test('超限的三种，只有 rate 值得重试', () => {
  // 对一个"花费上限已到"的错误做指数退避，你会在那里转到超时——它永远不会成功。
  eq(shared.shouldRetry({ kind: 'rate', retryAfterMs: 100 }), true)
  eq(shared.shouldRetry({ kind: 'spend_limit' }), false)
  eq(shared.shouldRetry({ kind: 'self_imposed' }), false)
})

// ═════════════════════════════════════════════════════════════
section('七、Lcg：确定性随机，以及低位陷阱')
// ═════════════════════════════════════════════════════════════

await test('同种子可复现', () => {
  eq(
    [0, 0, 0].map(() => new shared.Lcg(7).next()),
    [0, 0, 0].map(() => new shared.Lcg(7).next()),
  )
})

await test('★★ int(2) 不能是 0101 交替——那是 LCG 的最低位', () => {
  // 模 2^32 的线性同余发生器，第 k 位的周期只有 2^(k+1)：最低位就是 0、1、0、1。
  // 而 `next() % 2` 取的正好是最低位。
  //
  // 后果：拿它给一个"一半 easy 一半 hard"的任务列表做路由决策，
  // 任务的奇偶和随机数的奇偶完全同步，于是"随机路由"和"反着判的路由"
  // 算出**一模一样的账**。曲线看着挺像那么回事，结论是错的。
  const r = new shared.Lcg(1)
  const bits = Array.from({ length: 24 }, () => r.int(2))
  const alternating = bits.every((b, i) => i === 0 || b !== bits[i - 1])
  ok(!alternating, `序列在交替，说明用了低位：${bits.join('')}`)
})

await test('int(n) 落在 [0, n)', () => {
  const r = new shared.Lcg(3)
  for (let i = 0; i < 200; i++) {
    const v = r.int(7)
    ok(v >= 0 && v < 7, `越界：${v}`)
  }
})

await test('int 的上界必须为正', () => {
  throws(() => new shared.Lcg(1).int(0))
})

await test('退避有上限，且落在 [0, exp)', () => {
  const r = new shared.Lcg(5)
  for (let a = 0; a < 12; a++) {
    const v = shared.backoffMs(a, r, 500, 30_000)
    ok(v >= 0 && v < 30_000, `第 ${a} 次退避越界：${v}`)
  }
})

// ═════════════════════════════════════════════════════════════
section('八、整数纪律：金额不碰浮点')
// ═════════════════════════════════════════════════════════════

await test('★ charge 拒绝非整数 token 数', () => {
  throws(() => shared.charge(1.5, PRICE.inputMiss), 'token 数是整数，1.5 个 token 不存在')
  throws(() => shared.charge(-1, PRICE.inputMiss), '负数也拒绝')
})

await test('★ yuan 是截断而不是四舍五入（两种语言的舍入方向不一样）', () => {
  // Python 的 round() 是**银行家舍入**（round(0.5)==0、round(1.5)==2），
  // 而 JS 的 Math.round 是四舍五入。同一行代码，同一个输入，两个答案。
  // 截断在两边没有歧义，所以这里只能截断。
  //
  // 下面这笔钱是 0.0000005 元，恰好落在第 7 位小数上：
  // 截断到 6 位是 0.000000，四舍五入会变成 0.000001。
  eq(shared.yuan(shared.charge(5, 10_000_000n), 6), '0.000000', '四舍五入会给出 0.000001')
  // 正常的一笔，确认不是把所有东西都截成 0
  eq(shared.yuan(shared.charge(1999, 10_000_000_000n), 6), '0.199900')
})

await test('1 元/M × 1000 token = 0.001 元', () => {
  eq(shared.yuan(shared.charge(1000, 100_000_000n)), '0.001000')
})

await test('缓存读是 0.1 倍，5m 写是 1.25 倍', () => {
  eq(shared.yuan(shared.charge(1000, 100_000_000n, shared.MULT.cacheRead)), '0.000100')
  eq(shared.yuan(shared.charge(1000, 100_000_000n, shared.MULT.cacheWrite5m)), '0.001250')
  eq(shared.yuan(shared.charge(1000, 100_000_000n, shared.MULT.cacheWrite1h)), '0.002000')
})

await test('★ 倍率的除法留到最后：累加一万笔不产生漂移', () => {
  // 先乘 num 再除 den 会引入舍入，而 den 是 10 / 100 / 2 这种小数，
  // 连续累加之后舍入误差刚好能让两种语言分道扬镳。
  let acc = 0n
  for (let i = 0; i < 10_000; i++) acc += shared.charge(3, 100_000_000n, shared.MULT.cacheRead)
  eq(acc.toString(), shared.charge(30_000, 100_000_000n, shared.MULT.cacheRead).toString())
})

await test('★ 写一次读一次 = 1.35 倍（OpenAI 官方给的那笔算术）', () => {
  // 官方："Writing a prefix once and fully reusing it once costs 1.35× its
  // ordinary input cost, compared with 2× for processing it twice without caching."
  const one = shared.charge(1000, PRICE.inputMiss)
  const cached =
    shared.charge(1000, PRICE.inputMiss, shared.MULT.cacheWrite5m) +
    shared.charge(1000, PRICE.inputMiss, shared.MULT.cacheRead)
  eq((cached * 100n) / one, 135n, '1.25 + 0.1 = 1.35')
})

await test('★ 十次请求：一写九读 = 2.15 倍', () => {
  const one = shared.charge(1000, PRICE.inputMiss)
  const cached =
    shared.charge(1000, PRICE.inputMiss, shared.MULT.cacheWrite5m) +
    shared.charge(9000, PRICE.inputMiss, shared.MULT.cacheRead)
  eq((cached * 100n) / one, 215n, '官方："across ten requests … cost 2.15×"')
})

await test('★ 写了从来没读到 = 净亏 25%', () => {
  // 这就是断点放错位置的代价，而它比不开缓存还贵。
  const off = shared.charge(1000, PRICE.inputMiss)
  const writeOnly = shared.charge(1000, PRICE.inputMiss, shared.MULT.cacheWrite5m)
  eq((writeOnly * 100n) / off, 125n)
})

// ═════════════════════════════════════════════════════════════
section('九、最低可缓存长度：不随模型大小单调')
// ═════════════════════════════════════════════════════════════

await test('★ 便宜的 Haiku 4.5 门槛(4096)比贵的 Opus 5(512)高八倍', () => {
  // 这就是路由和缓存打架的一个具体形式。
  ok(
    shared.minCacheable('claude-haiku-4-5') > shared.minCacheable('claude-opus-5'),
    '「模型越小门槛越低」是错的',
  )
  eq(shared.minCacheable('claude-haiku-4-5'), 4096)
  eq(shared.minCacheable('claude-opus-5'), 512)
})

await test('★ 门槛不随版本单调（4.5→4.6 是 4096，4.7 降到 2048，4.8 降到 1024）', () => {
  eq(
    ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8'].map(shared.minCacheable),
    [4096, 2048, 1024],
  )
})

await test('未知模型返回 -1（"没公布"不是"没有"）', () => {
  eq(shared.minCacheable('some-model-i-made-up'), -1)
})

// ═════════════════════════════════════════════════════════════
section('十、routeOutcome：随机是基线，路由器可以是负价值的')
// ═════════════════════════════════════════════════════════════

const WEAK = { model: 'w', price: PRICE }
const STRONG = { model: 's', price: { inputMiss: 300_000_000n, output: 600_000_000n } as Price }
const mkTasks = (n: number, seed = 99): Task[] => {
  const g = new shared.Lcg(seed)
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    trueDifficulty: g.int(2) === 1 ? ('hard' as const) : ('easy' as const),
    inputTokens: 1000,
    outputTokens: 200,
  }))
}
const R = (hh: [bigint, bigint], he: [bigint, bigint]) => ({
  hardGivenHard: { num: hh[0], den: hh[1] },
  hardGivenEasy: { num: he[0], den: he[1] },
})

await test('所有任务都被解决（错判的会重试到强模型）', () => {
  const tasks = mkTasks(50)
  const o = M.routeOutcome(tasks, R([1n, 2n], [1n, 2n]), WEAK, STRONG, new shared.Lcg(1))
  eq([o.solved, o.total], [50, 50])
})

await test('完美路由比全用强模型省（没有共享前缀时）', () => {
  const tasks = mkTasks(100)
  const o = M.routeOutcome(tasks, R([1n, 1n], [0n, 1n]), WEAK, STRONG, new shared.Lcg(1))
  ok(o.picofen < shared.allStrong(tasks, STRONG), '完美路由零重试，应该更省')
  eq(o.retries, 0, '完美路由不会错判')
})

await test('★★ 一个"反着判"的路由器比全用强模型更贵', () => {
  // 对应 RouteLLM 在 GSM8K 上相对随机基线的 −11.8%。
  // 这条测试的存在本身就是在教：**路由器可以是负价值的。**
  const tasks = mkTasks(100)
  const inverted = M.routeOutcome(tasks, R([0n, 1n], [1n, 1n]), WEAK, STRONG, new shared.Lcg(1))
  ok(
    inverted.picofen > shared.allStrong(tasks, STRONG),
    '把难的送给弱模型、简单的送给强模型，比不路由更贵',
  )
})

await test('★ 反着判比随机差', () => {
  const tasks = mkTasks(100)
  const rand = M.routeOutcome(tasks, R([1n, 2n], [1n, 2n]), WEAK, STRONG, new shared.Lcg(1))
  const inv = M.routeOutcome(tasks, R([0n, 1n], [1n, 1n]), WEAK, STRONG, new shared.Lcg(1))
  ok(inv.picofen > rand.picofen, '负信息量的路由器必须比零信息量的更差')
})

await test('★★ 重试要算钱：一个必然错判的 hard 任务，总成本 > 直接用强模型', () => {
  // 弱模型一次 + 强模型一次 > 强模型一次。
  // 路由省钱的前提是错分率足够低，不是"便宜模型单价低"。
  const one: Task[] = [{ id: 'x', trueDifficulty: 'hard', inputTokens: 1000, outputTokens: 200 }]
  const o = M.routeOutcome(one, R([0n, 1n], [0n, 1n]), WEAK, STRONG, new shared.Lcg(1))
  eq(o.retries, 1)
  ok(o.picofen > shared.allStrong(one, STRONG), '白跑了一次弱模型')
})

await test('★ 换模型会打掉缓存（cache diagnostics 的 model_changed）', () => {
  const tasks = mkTasks(100)
  const o = M.routeOutcome(tasks, R([1n, 1n], [0n, 1n]), WEAK, STRONG, new shared.Lcg(1), 8000)
  ok(o.cacheBreaks > 0, '完美路由每个请求都在换模型，每次都是一次 model_changed')
})

await test('★ 不切模型的策略拿到全部前缀命中', () => {
  const tasks = mkTasks(100)
  // 全用便宜的：一路不换模型（除了错判后的重试）
  const allWeak = M.routeOutcome(tasks, R([0n, 1n], [0n, 1n]), WEAK, STRONG, new shared.Lcg(1), 8000)
  const perfect = M.routeOutcome(tasks, R([1n, 1n], [0n, 1n]), WEAK, STRONG, new shared.Lcg(1), 8000)
  ok(
    allWeak.cacheBreaks !== perfect.cacheBreaks,
    '两种策略的换模型次数必须不同，否则缓存没被算进去',
  )
})

await test('★★ 粘性路由减少缓存打断（决策粒度才是真正的旋钮）', () => {
  const tasks = mkTasks(100)
  const per = M.routeOutcome(tasks, R([1n, 1n], [0n, 1n]), WEAK, STRONG, new shared.Lcg(1), 8000, 1)
  const sticky = M.routeOutcome(tasks, R([1n, 1n], [0n, 1n]), WEAK, STRONG, new shared.Lcg(1), 8000, 10)
  ok(sticky.cacheBreaks < per.cacheBreaks, '按会话粒度路由应该少换很多次模型')
  ok(sticky.prefixReads > per.prefixReads, '换得少，读得多')
})

await test('★ 粘性路由不是免费的：它拿准确率换缓存命中', () => {
  const tasks = mkTasks(100)
  const per = M.routeOutcome(tasks, R([1n, 1n], [0n, 1n]), WEAK, STRONG, new shared.Lcg(1), 0, 1)
  const sticky = M.routeOutcome(tasks, R([1n, 1n], [0n, 1n]), WEAK, STRONG, new shared.Lcg(1), 0, 10)
  ok(sticky.retries > per.retries, '块内那些和块首难度不同的任务会被放到错的模型上')
  ok(sticky.picofen > per.picofen, '★ 没有前缀可缓存的时候，这笔交易是纯亏')
})

await test('★★ 有大共享前缀时，路由全面输给"全用强模型"', () => {
  // 前缀是任务的 8 倍，而基线全程不换模型：前缀写一次读九十九次。
  // 任何切模型的策略每切一次就重写一遍整段前缀。
  const tasks = mkTasks(100)
  const base = shared.allStrong(tasks, STRONG, 8000)
  for (const [name, r] of [
    ['完美', R([1n, 1n], [0n, 1n])],
    ['随机', R([1n, 2n], [1n, 2n])],
    ['反着判', R([0n, 1n], [1n, 1n])],
  ] as const) {
    const o = M.routeOutcome(tasks, r, WEAK, STRONG, new shared.Lcg(1), 8000)
    ok(o.picofen > base, `${name}路由居然赢了基线——前缀成本没算进去`)
  }
})

await test('stickyEvery 至少是 1', () => {
  throws(() => M.routeOutcome(mkTasks(10), R([1n, 2n], [1n, 2n]), WEAK, STRONG, new shared.Lcg(1), 0, 0))
})

await test('allStrong 带前缀时：写一次，读 n−1 次', () => {
  const tasks = mkTasks(10)
  const withPfx = shared.allStrong(tasks, STRONG, 1000)
  const want =
    shared.allStrong(tasks, STRONG) +
    shared.charge(1000, STRONG.price.inputMiss, shared.MULT.cacheWrite5m) +
    shared.charge(9000, STRONG.price.inputMiss, shared.MULT.cacheRead)
  eq(withPfx.toString(), want.toString())
})

// ═════════════════════════════════════════════════════════════
section('十一、FakeEndpoint：按官方规则算账，不编数')
// ═════════════════════════════════════════════════════════════

/**
 * ★ 这段夹具必须**够长**，否则整组测试会全部退化成 BELOW_MINIMUM，
 * 而那不是「缓存坏了」，是「你的前缀根本没资格进缓存」。
 *
 * 我第一版写了 40 行短句，算出来约 480 token，正好卡在 Opus 5 的 512 门槛下面，
 * 于是五个断点测试全挂在一个和断点毫无关系的原因上。
 * 这条踩坑本身就是 INV-5 和 INV-10 的合体：**门槛不达标不报错，只是静默不缓存。**
 */
const bigSystem = Array.from(
  { length: 40 },
  (_, i) => `项目约定第 ${i + 1} 条：改动要小、要可回滚、要先跑测试再提交。`,
).join('\n')

await test('第一次写入，第二次命中', () => {
  const ep = new shared.FakeEndpoint('anthropic', 'claude-opus-5')
  const req = REQ({ system: [{ type: 'text', text: bigSystem, cacheControl: {} }], tools: [] })
  const u1 = M.cacheVerdict('anthropic', ep.send(req, 50), 'claude-opus-5', shared.prefixTokens(req))
  const u2 = M.cacheVerdict('anthropic', ep.send(req, 50), 'claude-opus-5', shared.prefixTokens(req))
  eq([u1.verdict, u2.verdict], ['WRITE_ONLY', 'HIT'])
})

await test('★★ 断点在会变的块上 → 连续五次 WRITE_ONLY，永远不会热', () => {
  const ep = new shared.FakeEndpoint('anthropic', 'claude-opus-5')
  const at = (m: number) =>
    REQ({
      tools: [],
      system: [{ type: 'text', text: bigSystem }, { type: 'text', text: `t=${m}`, cacheControl: {} }],
      messages: [],
    })
  const vs = Array.from({ length: 5 }, (_, i) =>
    M.cacheVerdict('anthropic', ep.send(at(i), 50), 'claude-opus-5', shared.prefixTokens(at(i))).verdict,
  )
  eq(vs, ['WRITE_ONLY', 'WRITE_ONLY', 'WRITE_ONLY', 'WRITE_ONLY', 'WRITE_ONLY'])
})

await test('★ 断点挪到稳定块上 → 第二次起全部命中（内容一个字没改）', () => {
  const ep = new shared.FakeEndpoint('anthropic', 'claude-opus-5')
  const at = (m: number) =>
    REQ({
      tools: [],
      system: [{ type: 'text', text: bigSystem, cacheControl: {} }, { type: 'text', text: `t=${m}` }],
      messages: [],
    })
  const vs = Array.from({ length: 5 }, (_, i) =>
    M.cacheVerdict('anthropic', ep.send(at(i), 50), 'claude-opus-5', shared.prefixTokens(at(i))).verdict,
  )
  eq(vs, ['WRITE_ONLY', 'HIT', 'HIT', 'HIT', 'HIT'])
})

await test('★ 前缀太短 → 静默不缓存，不抛错', () => {
  const ep = new shared.FakeEndpoint('anthropic', 'claude-opus-5')
  const req = REQ({ tools: [], system: [{ type: 'text', text: '短', cacheControl: {} }], messages: [] })
  const r = M.cacheVerdict('anthropic', ep.send(req, 10), 'claude-opus-5', shared.prefixTokens(req))
  eq(r.verdict, 'BELOW_MINIMUM')
})

await test('★ 兼容端点：缓存可能照样在跑，但 usage 里没有字段', () => {
  const ep = new shared.FakeEndpoint('anthropic-openai-compat', 'claude-opus-5')
  const req = REQ({ system: [{ type: 'text', text: bigSystem, cacheControl: {} }], tools: [] })
  ep.send(req, 50)
  const u = ep.send(req, 50)
  ok(!('cache_read_input_tokens' in u), '这条端点不返回缓存字段')
  eq(M.cacheVerdict('anthropic-openai-compat', u, 'claude-opus-5').verdict, 'UNDETERMINABLE')
})

await test('★ 同一个缓存状态，四种端点都判 HIT，第五种判不出来', () => {
  const req = REQ({ system: [{ type: 'text', text: bigSystem, cacheControl: {} }], tools: [] })
  const got = (['anthropic', 'openai-responses', 'azure-chat', 'deepseek', 'anthropic-openai-compat'] as const).map(
    (shape) => {
      const ep = new shared.FakeEndpoint(shape, 'claude-opus-5')
      ep.send(req, 50)
      return M.cacheVerdict(shape, ep.send(req, 50), 'claude-opus-5', shared.prefixTokens(req)).verdict
    },
  )
  eq(got, ['HIT', 'HIT', 'HIT', 'HIT', 'UNDETERMINABLE'])
})

// ═════════════════════════════════════════════════════════════

console.log('')
if (failures.length === 0) {
  console.log(`\x1b[32m  ${passed} 项全过。\x1b[0m\n`)
  process.exit(0)
} else {
  console.log(`\x1b[31m  ${passed} 过 / ${failures.length} 挂：\x1b[0m`)
  for (const f of failures) console.log(`\x1b[31m    · ${f}\x1b[0m`)
  console.log('')
  process.exit(1)
}
