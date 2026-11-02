/**
 * 验证 l06/budget.ts 和 l06/compress.ts。跑法：pnpm verify:l06
 *
 * 一次 API 都不调——压缩用的模型也是假的。
 *
 * 这套测试里有一整组专门盯着**静默偏小**：漏算 tool_use、漏算工具定义、
 * 按总窗口而不是可用额度算比例。它们都不抛异常，只是让你在以为还有余量的
 * 时候撞上限。把静默失败变成响亮失败，是这门课反复出现的同一条纪律。
 *
 * 先跑 VERIFY_TARGET=shared 确认测试本身是对的。
 */
import type Anthropic from '@anthropic-ai/sdk'

// 显式声明模块形状：两个 import 各自给出一套类型，
// 而 Calibrator 是 class（有私有字段 → 名义类型），直接用会不兼容。
// 只含方法的接口能绕开它，因为接口里的方法签名是双变的。
interface CalibratorLike {
  readonly factor: number
  readonly count: number
  readonly drift: number
  record(estimated: number, actualInputTokens: number): void
}

interface Budget {
  window: number
  reserveOutput: number
  compressAt: number
  compressTo: number
}

type Zone = 'system' | 'toolDefs' | 'task' | 'summary' | 'work'

interface ContextStats {
  tokens: number
  ratio: number
  breakdown: Record<Zone, number>
  top: Zone
  budget: Budget
}

interface BudgetModule {
  estimateTokens(text: string, factor?: number): number
  countContent(content: Anthropic.MessageParam['content'], factor?: number): number
  inputBudget(b: Budget): number
  defaultBudget: Budget
  measure(
    input: {
      system: string
      tools: Anthropic.Tool[]
      messages: Anthropic.MessageParam[]
      summaryTokens?: number
    },
    budget?: Budget,
    factor?: number,
  ): ContextStats
  paginate(
    text: string,
    opts?: { offset?: number; limit?: number; hint?: (n: number) => string },
  ): string
  Calibrator: new () => CalibratorLike
}

interface Summary {
  goal: string
  done: string[]
  found: string[]
  failed: string[]
  next: string
}

interface CompressModule {
  summaryPrompt(): string
  renderSummary(s: Summary): string
  parseSummary(text: string): Summary
  slidingWindow(
    messages: Anthropic.MessageParam[],
    keepTurns?: number,
  ): Anthropic.MessageParam[]
  compress(
    messages: Anthropic.MessageParam[],
    opts: {
      call: (m: Anthropic.MessageParam[]) => Promise<Anthropic.Message>
      keepRecent?: number
    },
  ): Promise<{
    messages: Anthropic.MessageParam[]
    summary: Summary
    saved: number
    cost: { input: number; output: number }
  }>
  shouldCompress(input: {
    stats: ContextStats
    stepsLeft: number
    cacheDiscount?: number
  }): { compress: boolean; why: string; net?: number }
}

const target = process.env.VERIFY_TARGET === 'shared' ? 'shared' : 'mine'
const B: BudgetModule =
  target === 'shared' ? await import('../shared/context.ts') : await import('./budget.ts')
const C: CompressModule =
  target === 'shared' ? await import('../shared/compress.ts') : await import('./compress.ts')

console.log(target === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l06/ 里你的实现）')

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
  } catch {
    return
  }
  throw new Error(`应该抛异常但没有：${hint}`)
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: '读取文件内容。路径必须在项目根目录内。返回前 200 行。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' } },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description: '搜关键词，返回文件和行号。',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
]

// ─────────────────────────────────────────────────────────────
console.log('\ntoken 估算')
// ─────────────────────────────────────────────────────────────

await test('空字符串是 0', () => {
  assert(B.estimateTokens('') === 0, `期待 0，实际 ${B.estimateTokens('')}`)
})

await test('中文比同字数英文更耗 token', () => {
  const zh = B.estimateTokens('上下文工程是最稀缺的资源')
  const en = B.estimateTokens('contextengineering')
  assert(zh > en, `中文 ${zh} 应该大于同长度英文 ${en}（L01 讲过 BPE 的语料依赖）`)
})

await test('长度单调：文本变长估算不减', () => {
  let prev = 0
  for (const n of [10, 100, 1000]) {
    const cur = B.estimateTokens('a'.repeat(n))
    assert(cur >= prev, `长度 ${n} 时估算 ${cur} 反而小于 ${prev}`)
    prev = cur
  }
})

await test('factor 系数生效', () => {
  const base = B.estimateTokens('测试一段文本 with mixed content')
  const scaled = B.estimateTokens('测试一段文本 with mixed content', 1.2)
  assert(scaled > base, `factor=1.2 应该给出更大的值，实际 ${base} → ${scaled}`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n消息计量')
// ─────────────────────────────────────────────────────────────

await test('字符串 content', () => {
  const n = B.countContent('hello world')
  assert(n > 0, '不该是 0')
})

await test('text 块', () => {
  const n = B.countContent([{ type: 'text', text: '一段文字' }])
  assert(n > 0, '不该是 0')
})

await test('tool_use 块要算进去（漏了它统计基本上就废了）', () => {
  const n = B.countContent([
    {
      type: 'tool_use',
      id: 't1',
      name: 'read_file',
      input: { path: 'src/very/long/path/to/a/file.ts', offset: 200 },
    },
  ])
  assert(
    n > 10,
    `期待明显大于 0，实际 ${n}。\n` +
      '      `if (typeof content === "string")` 之后就不管别的，是这一节最常见的 bug——' +
      '而 tool_use / tool_result 正是 agent 上下文里最大的两块',
  )
})

await test('tool_result 块要算进去', () => {
  const small = B.countContent([{ type: 'tool_result', tool_use_id: 't1', content: 'x' }])
  const big = B.countContent([
    { type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(4000) },
  ])
  assert(big > small * 10, `4000 字符 ${big} 应该远大于 1 字符 ${small}`)
})

await test('tool_result 的 content 是块数组时也要算', () => {
  const n = B.countContent([
    {
      type: 'tool_result',
      tool_use_id: 't1',
      content: [{ type: 'text', text: 'y'.repeat(2000) }],
    },
  ])
  assert(n > 100, `期待明显大于 0，实际 ${n}。工具结果也可以是块数组`)
})

await test('未知块类型要抛异常，不能静默跳过', async () => {
  await raises(
    () => B.countContent([{ type: 'wat' } as unknown as Anthropic.ContentBlockParam]),
    '静默跳过未知块会让预算数字系统性偏小',
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n预算与分区')
// ─────────────────────────────────────────────────────────────

await test('inputBudget 要减掉留白', () => {
  const b: Budget = { window: 128_000, reserveOutput: 16_000, compressAt: 0.6, compressTo: 0.3 }
  assert(
    B.inputBudget(b) === 112_000,
    `期待 112000，实际 ${B.inputBudget(b)}。128K 是输入加输出的总额，不能全给输入`,
  )
})

const HISTORY: Anthropic.MessageParam[] = [
  { role: 'user', content: '读懂 src/auth，说明登录流程' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '我先看看。' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/auth/login.ts' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'code\n'.repeat(1000) }],
  },
]

await test('breakdown 五个分区都在', () => {
  const s = B.measure({ system: 'sys prompt', tools: TOOLS, messages: HISTORY })
  for (const z of ['system', 'toolDefs', 'task', 'summary', 'work'] as Zone[]) {
    assert(z in s.breakdown, `缺了分区 ${z}`)
  }
})

await test('工具定义要算进去（它不在 messages 里但每步都发）', () => {
  const withTools = B.measure({ system: 's', tools: TOOLS, messages: HISTORY })
  const without = B.measure({ system: 's', tools: [], messages: HISTORY })
  assert(
    withTools.breakdown.toolDefs > 0,
    'toolDefs 是 0。十个工具的 schema 轻松到 2K 以上，忘了算它等于把系统区当成免费的',
  )
  assert(withTools.tokens > without.tokens, '有工具的总量应该更大')
})

await test('第一条消息算作 task 区（它永不压缩）', () => {
  const s = B.measure({ system: 's', tools: [], messages: HISTORY })
  assert(s.breakdown.task > 0, 'task 区是 0，第一条 user 消息应该单独计')
  assert(
    s.breakdown.task < s.breakdown.work,
    `task ${s.breakdown.task} 应该远小于 work ${s.breakdown.work}——` +
      '前者是一句话，后者含一个大工具结果',
  )
})

await test('tokens 等于各分区之和', () => {
  const s = B.measure({ system: 'sys', tools: TOOLS, messages: HISTORY })
  const sum = Object.values(s.breakdown).reduce((a, b) => a + b, 0)
  assert(s.tokens === sum, `总量 ${s.tokens} 不等于分区之和 ${sum}`)
})

await test('top 指向最大的分区', () => {
  const s = B.measure({ system: 'sys', tools: TOOLS, messages: HISTORY })
  const max = (Object.entries(s.breakdown) as [Zone, number][]).reduce((best, cur) =>
    cur[1] > best[1] ? cur : best,
  )
  assert(s.top === max[0], `top 是 ${s.top}，但最大的分区是 ${max[0]}`)
  assert(s.top === 'work', `这个历史里最大的应该是 work，实际 ${s.top}`)
})

await test('ratio 相对可用额度算，不是相对 window', () => {
  const b: Budget = { window: 10_000, reserveOutput: 5_000, compressAt: 0.6, compressTo: 0.3 }
  const s = B.measure({ system: '', tools: [], messages: [{ role: 'user', content: 'x' }] }, b)
  const byWindow = s.tokens / b.window
  const byAvailable = s.tokens / 5_000
  assert(
    Math.abs(s.ratio - byAvailable) < 1e-9,
    `ratio=${s.ratio}，按可用额度应该是 ${byAvailable}（按 window 会是 ${byWindow}）。\n` +
      '      按 window 算会允许输入涨到模型没法写长回答为止',
  )
})

await test('summaryTokens 不重复计入 work', () => {
  const a = B.measure({ system: '', tools: [], messages: HISTORY })
  const b = B.measure({ system: '', tools: [], messages: HISTORY, summaryTokens: 500 })
  assert(b.breakdown.summary === 500, `summary 区应该是 500，实际 ${b.breakdown.summary}`)
  assert(
    b.tokens === a.tokens,
    `总量不该因为标注了摘要而变化：${a.tokens} → ${b.tokens}。摘要本来就在 messages 里`,
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n分页与出路')
// ─────────────────────────────────────────────────────────────

const FILE = Array.from({ length: 1240 }, (_, i) => `line ${i + 1}`).join('\n')

await test('短文本不加任何提示', () => {
  const out = B.paginate('a\nb\nc', { limit: 200 })
  assert(out === 'a\nb\nc', `短文本不该被加东西，实际：${JSON.stringify(out)}`)
})

await test('截断时说清共有多少行', () => {
  const out = B.paginate(FILE, { limit: 10 })
  assert(out.includes('1240'), `没提到总行数 1240：\n${out.slice(-200)}`)
})

await test('截断时给出下一段的 offset（不给就是死循环）', () => {
  const out = B.paginate(FILE, { limit: 10 })
  assert(
    /offset\s*=?\s*10/.test(out),
    `没给出 offset=10：\n${out.slice(-200)}\n` +
      '      模型需要后面的内容却不知道怎么拿，只能重试同样的调用 → 死循环',
  )
})

await test('自定义 hint 生效', () => {
  const out = B.paginate(FILE, { limit: 5, hint: (n) => `read_file(path, offset=${n})` })
  assert(out.includes('read_file(path, offset=5)'), `hint 没被用上：\n${out.slice(-150)}`)
})

await test('读到末尾时说明已到末尾', () => {
  const out = B.paginate(FILE, { offset: 1235, limit: 20 })
  assert(out.includes('末尾') || out.includes('1240'), `没说明已到末尾：\n${out.slice(-150)}`)
})

await test('offset 超出范围要说清楚，不是静默返回空', () => {
  const out = B.paginate(FILE, { offset: 9999, limit: 10 })
  assert(out.trim().length > 0, '返回了空字符串。模型会以为文件是空的')
  assert(out.includes('9999') || out.includes('超出'), `没说明越界：${out}`)
})

await test('分页内容本身正确', () => {
  const out = B.paginate(FILE, { offset: 5, limit: 3 })
  assert(out.includes('line 6'), `应该从第 6 行开始：\n${out}`)
  assert(out.includes('line 8'), `应该到第 8 行：\n${out}`)
  assert(!out.includes('line 9\n'), `不该包含第 9 行：\n${out}`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n校准')
// ─────────────────────────────────────────────────────────────

await test('没样本时 factor 是 1', () => {
  const c = new B.Calibrator()
  assert(c.factor === 1, `期待 1，实际 ${c.factor}`)
})

await test('估算偏低时 factor 大于 1', () => {
  const c = new B.Calibrator()
  c.record(1000, 1200)
  c.record(2000, 2400)
  assert(c.factor > 1.15 && c.factor < 1.25, `期待约 1.2，实际 ${c.factor}`)
})

await test('drift 反映偏差幅度', () => {
  const c = new B.Calibrator()
  c.record(1000, 1180)
  assert(c.drift > 0.15 && c.drift < 0.2, `期待约 0.18，实际 ${c.drift}`)
})

await test('估算为 0 的样本被忽略（除零保护）', () => {
  const c = new B.Calibrator()
  c.record(0, 500)
  assert(Number.isFinite(c.factor), `factor 变成了 ${c.factor}`)
  assert(c.count === 0, `不该记录估算为 0 的样本，实际 count=${c.count}`)
})

await test('只保留最近的样本（老样本会拖累系数）', () => {
  const c = new B.Calibrator()
  for (let i = 0; i < 50; i++) c.record(100, 100)
  assert(c.count <= 20, `样本数 ${c.count} 应该有上限，否则模型换了系数也跟不上`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n结构化摘要')
// ─────────────────────────────────────────────────────────────

const FULL = `<goal>读懂 src/auth 模块，找出安全问题</goal>
<done>
- 定位入口 src/auth/login.ts:34
- 读完 session.ts
</done>
<found>
- login.ts:88 用了 === 比较密码
</found>
<failed>
- 搜 bcrypt 零结果，这个项目没用它
</failed>
<next>看 middleware.ts</next>`

await test('summaryPrompt 里要求了全部五个标签', () => {
  const p = C.summaryPrompt()
  for (const tag of ['goal', 'done', 'found', 'failed', 'next']) {
    assert(p.includes(tag), `prompt 里没提到 ${tag}`)
  }
})

await test('summaryPrompt 强调 goal 要原文', () => {
  const p = C.summaryPrompt()
  assert(
    /原文|一字|不要改写|照抄/.test(p),
    'prompt 没要求 goal 保留原文。目标漂移是长任务的头号失败模式',
  )
})

await test('summaryPrompt 强调 failed 不能省', () => {
  const p = C.summaryPrompt()
  assert(
    /不能省|不要跳过|无/.test(p),
    'prompt 没强调 failed 必须写。模型倾向于只总结成果，失败会被当成噪音丢掉',
  )
})

await test('解析完整摘要', () => {
  const s = C.parseSummary(FULL)
  assert(s.goal.includes('安全问题'), `goal 不对：${s.goal}`)
  assert(s.done.length === 2, `done 应该 2 条，实际 ${s.done.length}：${JSON.stringify(s.done)}`)
  assert(s.found.length === 1, `found 应该 1 条，实际 ${s.found.length}`)
  assert(s.failed.length === 1, `failed 应该 1 条，实际 ${s.failed.length}`)
  assert(s.next.includes('middleware'), `next 不对：${s.next}`)
})

await test('列表项的 - 前缀被剥掉', () => {
  const s = C.parseSummary(FULL)
  assert(!s.done[0]!.startsWith('-'), `没剥掉前缀：${s.done[0]}`)
})

await test('缺 goal 要抛异常', async () => {
  await raises(
    () => C.parseSummary(FULL.replace(/<goal>.*<\/goal>\n/, '')),
    '缺 goal 会让目标漂移',
  )
})

await test('缺 failed 要抛异常（最容易被漏掉的一节）', async () => {
  await raises(
    () => C.parseSummary(FULL.replace(/<failed>[\s\S]*?<\/failed>\n/, '')),
    '缺 failed 会让 agent 重试失败过的方法，而重复检测拦不住它',
  )
})

await test('failed 写「无」是合法的，解析成空数组', () => {
  const s = C.parseSummary(FULL.replace(/<failed>[\s\S]*?<\/failed>/, '<failed>无</failed>'))
  assert(s.failed.length === 0, `期待空数组，实际 ${JSON.stringify(s.failed)}`)
})

await test('renderSummary 之后能再解析回来', () => {
  const a = C.parseSummary(FULL)
  const b = C.parseSummary(C.renderSummary(a))
  assert(b.goal === a.goal, `goal 变了：${a.goal} → ${b.goal}`)
  assert(
    JSON.stringify(b.failed) === JSON.stringify(a.failed),
    `failed 变了：${JSON.stringify(a.failed)} → ${JSON.stringify(b.failed)}`,
  )
})

await test('renderSummary 保留路径和行号', () => {
  const s = C.parseSummary(FULL)
  const out = C.renderSummary(s)
  assert(out.includes('login.ts:88'), `路径行号丢了：\n${out}`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n滑动窗口')
// ─────────────────────────────────────────────────────────────

function toolTurns(n: number): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = [{ role: 'user', content: '原始任务' }]
  for (let i = 0; i < n; i++) {
    msgs.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name: 'read_file', input: { path: `f${i}.ts` } }],
    })
    msgs.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `内容 ${i}` }],
    })
  }
  return msgs
}

function isToolResult(m: Anthropic.MessageParam | undefined): boolean {
  if (!m || typeof m.content === 'string') return false
  return m.content.some((b) => (b as { type: string }).type === 'tool_result')
}

function isToolUse(m: Anthropic.MessageParam | undefined): boolean {
  if (!m || typeof m.content === 'string') return false
  return m.content.some((b) => (b as { type: string }).type === 'tool_use')
}

await test('短历史原样返回', () => {
  const msgs = toolTurns(1)
  assert(C.slidingWindow(msgs, 10).length === msgs.length, '不该动')
})

await test('第一条（原始任务）永远保留', () => {
  const out = C.slidingWindow(toolTurns(10), 4)
  assert(
    typeof out[0]!.content === 'string' && out[0]!.content === '原始任务',
    `第一条不是原始任务：${JSON.stringify(out[0])}`,
  )
})

await test('每个 tool_result 都能找到它的 tool_use（各种 keep 值）', () => {
  for (const keep of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const out = C.slidingWindow(toolTurns(10), keep)
    for (let i = 1; i < out.length; i++) {
      if (isToolResult(out[i])) {
        assert(
          isToolUse(out[i - 1]),
          `keep=${keep} 时第 ${i} 条 tool_result 的前一条不是 tool_use。\n` +
            '      切点落在工具轮次中间会让 tool_result 失去配对，API 直接报 400。\n' +
            '      这个 bug 只在特定 keep 值下出现，很容易漏测',
        )
      }
    }
  }
})

await test('确实变短了', () => {
  const msgs = toolTurns(10)
  const out = C.slidingWindow(msgs, 4)
  assert(out.length < msgs.length, `${msgs.length} → ${out.length}，没变短`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n压缩')
// ─────────────────────────────────────────────────────────────

/** 假模型：不管输入什么都返回一份固定的结构化摘要 */
function fakeSummarizer(text = FULL) {
  const calls: Anthropic.MessageParam[][] = []
  const call = async (messages: Anthropic.MessageParam[]): Promise<Anthropic.Message> => {
    calls.push(messages)
    return {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-v4-flash',
      content: [{ type: 'text', text, citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 4000,
        output_tokens: 300,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: null,
      },
    } as unknown as Anthropic.Message
  }
  return { call, calls }
}

await test('压缩后消息变少，且第一条还是原始任务', async () => {
  const msgs = toolTurns(10)
  const fake = fakeSummarizer()
  const r = await C.compress(msgs, { call: fake.call, keepRecent: 4 })
  assert(r.messages.length < msgs.length, `${msgs.length} → ${r.messages.length}，没变少`)
  assert(r.messages[0]!.content === '原始任务', '第一条被改了')
})

await test('摘要被插在第二条', async () => {
  const r = await C.compress(toolTurns(10), { call: fakeSummarizer().call, keepRecent: 4 })
  const second = r.messages[1]!
  assert(
    typeof second.content === 'string' && second.content.includes('<goal>'),
    `第二条不是摘要：${JSON.stringify(second).slice(0, 120)}`,
  )
})

await test('压缩后的序列里 tool_result 仍然配对', async () => {
  for (const keepRecent of [2, 3, 4, 5]) {
    const r = await C.compress(toolTurns(10), { call: fakeSummarizer().call, keepRecent })
    for (let i = 1; i < r.messages.length; i++) {
      if (isToolResult(r.messages[i])) {
        assert(
          isToolUse(r.messages[i - 1]),
          `keepRecent=${keepRecent} 时第 ${i} 条 tool_result 失去了配对`,
        )
      }
    }
  }
})

await test('返回压缩这一次的花费（它不是免费的）', async () => {
  const r = await C.compress(toolTurns(10), { call: fakeSummarizer().call })
  assert(r.cost.input === 4000, `input 花费不对：${r.cost.input}`)
  assert(r.cost.output === 300, `output 花费不对：${r.cost.output}`)
})

await test('saved 是正数', async () => {
  const r = await C.compress(toolTurns(20), { call: fakeSummarizer().call })
  assert(r.saved > 0, `saved=${r.saved}，压了 20 轮应该省下不少`)
})

await test('摘要缺 failed 时压缩要失败，不能静默接受', async () => {
  const bad = FULL.replace(/<failed>[\s\S]*?<\/failed>\n/, '')
  await raises(
    () => C.compress(toolTurns(10), { call: fakeSummarizer(bad).call }),
    '静默接受一个缺 failed 的摘要等于把防线关掉',
  )
})

await test('传给模型的是待压部分加上摘要指令', async () => {
  const fake = fakeSummarizer()
  await C.compress(toolTurns(10), { call: fake.call, keepRecent: 4 })
  const sent = fake.calls[0]!
  const last = sent[sent.length - 1]!
  assert(
    typeof last.content === 'string' && last.content.includes('failed'),
    '最后一条应该是摘要指令',
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n该不该压')
// ─────────────────────────────────────────────────────────────

function statsAt(ratio: number): ContextStats {
  const available = B.inputBudget(B.defaultBudget)
  const tokens = Math.round(available * ratio)
  return {
    tokens,
    ratio,
    breakdown: { system: 900, toolDefs: 1800, task: 400, summary: 0, work: tokens - 3100 },
    top: 'work',
    budget: B.defaultBudget,
  }
}

await test('没到触发线不压', () => {
  const d = C.shouldCompress({ stats: statsAt(0.4), stepsLeft: 30 })
  assert(!d.compress, `不该压：${d.why}`)
})

await test('刚过触发线且剩余步数多 → 压', () => {
  const d = C.shouldCompress({ stats: statsAt(0.7), stepsLeft: 30 })
  assert(d.compress, `应该压：${d.why}`)
})

await test('同样长度但只剩 1 步 → 不压（这是本节最值钱的一条）', () => {
  const d = C.shouldCompress({ stats: statsAt(0.7), stepsLeft: 1 })
  assert(
    !d.compress,
    `不该压：${d.why}\n` +
      '      压缩的收益乘的是剩余步数，而代价（重建缓存）是一次性的。\n' +
      '      剩余步数少的时候不压更便宜',
  )
})

await test('剩余步数为 0 时不压', () => {
  const d = C.shouldCompress({ stats: statsAt(0.8), stepsLeft: 0 })
  assert(!d.compress, `不该压：${d.why}`)
})

await test('快撑爆时即使只剩 1 步也压', () => {
  const d = C.shouldCompress({ stats: statsAt(0.95), stepsLeft: 1 })
  assert(
    d.compress,
    `应该压：${d.why}。到这个占比不是省钱问题，是下一个工具结果会不会撑爆窗口的问题`,
  )
})

await test('剩余步数越多越倾向于压', () => {
  const decisions = [1, 3, 10, 50].map((n) => C.shouldCompress({ stats: statsAt(0.7), stepsLeft: n }))
  const nets = decisions.map((d) => d.net ?? 0)
  for (let i = 1; i < nets.length; i++) {
    assert(nets[i]! >= nets[i - 1]!, `净收益应该随剩余步数单调不减，实际 ${JSON.stringify(nets)}`)
  }
})

await test('why 能读懂（它要进日志）', () => {
  for (const stepsLeft of [1, 30]) {
    const d = C.shouldCompress({ stats: statsAt(0.7), stepsLeft })
    assert(d.why.length > 8, `why 太短了：${JSON.stringify(d.why)}`)
    assert(!/^(true|false|ok)$/i.test(d.why), `why 不是给人看的：${d.why}`)
  }
})

await test('没有缓存折扣时更倾向于压', () => {
  const withCache = C.shouldCompress({ stats: statsAt(0.7), stepsLeft: 4, cacheDiscount: 0.1 })
  const noCache = C.shouldCompress({ stats: statsAt(0.7), stepsLeft: 4, cacheDiscount: 1 })
  assert(
    (noCache.net ?? 0) > (withCache.net ?? 0),
    `没缓存时净收益应该更高：${withCache.net} vs ${noCache.net}。\n` +
      '      有缓存时省下的那些 token 本来只值全价的一折，压缩的收益就小了',
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60))
if (failures.length === 0) {
  console.log(`\x1b[32m${passed} 项全过。\x1b[0m`)
  console.log('\n接着跑 pnpm longrun，把这套东西接到 L05 的 agent 上量一次收益。')
} else {
  console.log(`\x1b[31m${passed} 过，${failures.length} 败：\x1b[0m`)
  for (const f of failures) console.log(`\x1b[31m  · ${f}\x1b[0m`)
  process.exitCode = 1
}
