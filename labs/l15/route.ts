/**
 * L15 的交付物：**成本审计**。跑法：pnpm audit:l15
 *
 * 这个程序做的事，一句话：**它拒绝报出它证明不了的省钱。**
 *
 * 为什么要这么设计。这一节从头到尾只有一个论点：
 *   缓存、路由、批处理失败的时候**不报错**。
 * 那么一个「报出省了多少钱」的工具就有一个内建的失效模式——
 * 它在你其实没省到钱的时候，也会给你一个好看的数字。
 *
 * 所以这份报告的每一段都要先回答「这个数我凭什么信」，再报数。
 * 顺序是刻意的：
 *   一、逐步判定（唯一的信号在 usage 里）
 *   二、未命中归因（是你的 bug 还是过期了）
 *   三、账：实付 / 完全不缓存 / 理论最优
 *   四、路由：把缓存算进去之后的两条曲线
 * 然后以非零退出码结束。
 *
 * ★ 一个注意点：这里的 usage **不是我编的**，是 FakeEndpoint 按官方公布的
 * 规则从请求算出来的。所以你改 SYSTEM 里的一个字符，下面每个数字都会跟着动，
 * 而且动的方向是可解释的。编出来的 usage 做不到这一点——它会和请求脱节，
 * 于是「白付了多少 token」和「总输入」变成两套互相矛盾的口径。
 */

import {
  type Block,
  type CacheReport,
  type Divergence,
  FakeEndpoint,
  Lcg,
  MULT,
  type Price,
  type ProviderShape,
  type Req,
  type Task,
  type ToolDef,
  allStrong,
  cacheVerdict,
  charge,
  firstDivergence,
  prefixTokens,
  routeOutcome,
  yuan,
} from '../shared/budget.ts'

// ─────────────────────────────────────────────────────────────
// 被审计的对象
// ─────────────────────────────────────────────────────────────

/** 单价。1 元/M = 100_000_000 微分/M。 */
const FLASH: Price = { inputMiss: 100_000_000n, output: 200_000_000n }
const PRO: Price = { inputMiss: 300_000_000n, output: 600_000_000n }

const MODEL = 'claude-opus-5' // 最低可缓存 512 token

const TOOLS: ToolDef[] = [
  { name: 'read_file', description: '读一个文件的全部内容，返回带行号的文本。路径相对于仓库根目录。', inputSchema: { path: 'string' } },
  { name: 'write_file', description: '覆盖写入一个文件。调用前必须先 read_file 确认当前内容。', inputSchema: { content: 'string', path: 'string' } },
  { name: 'run_tests', description: '跑测试套件，返回失败用例的名字和断言信息。filter 是可选的用例名前缀。', inputSchema: { filter: 'string' } },
]

/**
 * 项目背景。
 *
 * ★ 这段刻意写得够长。不是为了凑字数，是因为**短前缀根本进不了缓存**，
 * 而那会让整个实验得出一个误导性的结论。
 *
 * Opus 5 的最低可缓存长度是 512 token（官方清单）。一段 300 token 的
 * system prompt 无论你怎么标 cache_control 都不会被缓存，而且**不报错**。
 * 真实项目里这部分（AGENTS.md、.cursor/rules、工具清单）通常一两千 token，
 * 所以这里按真实规模写——否则你会得出「缓存没用」这个错结论，
 * 而真正的原因只是「你的前缀太短」。
 */
const BACKGROUND = [
  '项目是一个 TypeScript 单体仓库，用 pnpm workspace 管理，包含 web、api、worker、shared 四个包。',
  'web 是 Vite + React 19，路由用 react-router，状态只用 useState 和 context，不引入额外的状态库。',
  'api 是 Fastify，数据库是 Postgres，查询层用 Kysely 而不是 ORM，所有 SQL 必须是类型安全的。',
  'worker 跑后台任务，队列用 pg-boss，任务必须幂等，因为它会在部署时被重启。',
  'shared 放两端共用的类型和校验器，校验用 zod，类型一律从 zod schema 推导出来，不要手写两份。',
  '',
  '测试用 vitest。所有改动必须先跑 pnpm test 再提交，一个失败都不允许留着。',
  '禁止用 it.skip 或 it.only 绕过失败的测试。如果一个测试确实过时了，删掉它并在提交信息里说明理由。',
  '新增的每个导出函数都要有测试，覆盖正常路径和至少一个失败路径。',
  '',
  '代码风格：不用 default export，所有导出都是命名导出，这样重命名和查引用才靠得住。',
  '不用 any，也不用 as 断言来绕类型错误——遇到类型不对先想清楚是不是设计有问题。',
  '错误必须显式处理，不能 catch 之后什么都不做。如果确实要忽略，写注释说明为什么可以忽略。',
  '不要在 catch 里吞掉错误然后返回一个默认值，那会让上层拿到一个看起来正常的错结果。',
  '异步函数一律用 async/await，不要混用 .then()，也不要漏掉 await。',
  '',
  '数据库迁移在 api/migrations 下，文件名带时间戳前缀，必须可回滚。',
  '迁移里不允许写业务数据，只改结构。需要初始数据的话另写一个 seed 脚本。',
  '加索引的迁移要用 CREATE INDEX CONCURRENTLY，因为线上表很大，会锁表。',
  '删列分两步：先发一版代码不再读它，确认稳定之后再发迁移删列。不要一次做完。',
  '',
  '提交信息用中文，第一行以内说清改了什么。不要写「修复若干问题」「优化代码」这类没有信息量的话。',
  '一个提交只做一件事。重构和功能改动要分开提交，这样出问题时才能单独回滚。',
  '',
  '遇到不确定的取舍先问，不要自己挑一个然后改一大片——改错方向的代价比多问一句高得多。',
  '涉及钱、权限、用户数据的改动，一律先说明方案再动手。',
].join('\n')

/**
 * ★ 这个 system prompt 里埋了这一节最贵的那个 bug，而且它长得非常无辜。
 *
 * 看第二块。一个「当前时间」——几乎每个人都写过这一行，理由也很正当：
 * 模型不知道今天几号。
 *
 * 后果：tools 层稳定、system 第一块稳定，但**第二块每次都变**，
 * 而断点就在它上面。于是每次都是一次全新的缓存写入，一次读都拿不到。
 * 按官方定价，5 分钟缓存写入是基础价的 1.25 倍——也就是说
 * **它比根本不开缓存还贵 25%**，而日志上完全正常。
 */
function systemAt(minute: number): Block[] {
  return [
    { type: 'text', text: BACKGROUND },
    { type: 'text', text: `当前时间：2026-09-15 10:${String(minute).padStart(2, '0')}`, cacheControl: {} },
  ]
}

/** 把断点挪到稳定内容上——同样的会话，唯一的区别是断点位置。 */
function systemFixed(minute: number): Block[] {
  return [
    { type: 'text', text: BACKGROUND, cacheControl: {} },
    { type: 'text', text: `当前时间：2026-09-15 10:${String(minute).padStart(2, '0')}` },
  ]
}

interface Step {
  label: string
  req: Req
  shape: ProviderShape
  usage: Record<string, unknown>
  outputTokens: number
}

/**
 * 一次六步的会话。
 * `sys` 决定断点放哪儿——这是整个实验唯一的自变量。
 */
function session(sys: (m: number) => Block[]): Step[] {
  const ep = new FakeEndpoint('anthropic', MODEL)
  const msgs: Block[] = []
  const steps: Step[] = []

  const run = (label: string, minute: number, out: number, shape: ProviderShape = 'anthropic') => {
    const req: Req = { model: MODEL, tools: TOOLS, system: sys(minute), messages: [...msgs] }
    // ★ usage 是算出来的。兼容端点用一个独立的端点实例，因为它的字段形状不同。
    const usage =
      shape === 'anthropic' ? ep.send(req, out) : new FakeEndpoint(shape, MODEL).send(req, out)
    steps.push({ label, req, shape, usage, outputTokens: out })
  }

  msgs.push({ type: 'text', text: '把 auth 模块的重试逻辑抽出来，单独成一个函数。' })
  run('第 1 步 首次请求', 10, 180)

  msgs.push({ type: 'tool_use', name: 'read_file', input: { path: 'src/auth.ts' } })
  msgs.push({ type: 'tool_result', content: 'export async function login(email: string, pw: string) { /* 略 300 行 */ }' })
  run('第 2 步 读文件后', 11, 210)

  msgs.push({ type: 'text', text: '看一下现有的测试覆盖到哪些分支。' })
  run('第 3 步 又一轮', 12, 160)

  msgs.push({ type: 'tool_use', name: 'run_tests', input: { filter: 'auth' } })
  msgs.push({ type: 'tool_result', content: '3 passed, 0 failed' })
  run('第 4 步 跑完测试', 13, 140)

  // 第 5 步：一段很短的前缀，低于 512 门槛。
  steps.push({
    label: '第 5 步 一次短请求',
    req: { model: MODEL, tools: [], system: [{ type: 'text', text: '一句话总结上面做了什么。' }], messages: [] },
    shape: 'anthropic',
    usage: new FakeEndpoint('anthropic', MODEL).send(
      { model: MODEL, tools: [], system: [{ type: 'text', text: '一句话总结上面做了什么。' }], messages: [] },
      40,
    ),
    outputTokens: 40,
  })

  // 第 6 步：同样的活，走了兼容端点。
  run('第 6 步 走兼容端点', 13, 150, 'anthropic-openai-compat')

  return steps
}

// ─────────────────────────────────────────────────────────────
// 审计
// ─────────────────────────────────────────────────────────────

interface Row {
  label: string
  report: CacheReport
  divergence: Divergence | null
  paid: bigint
}

export interface Audit {
  rows: Row[]
  paid: bigint
  /** 完全不开缓存要付多少——**这是分母，不是「优化前」**。 */
  noCache: bigint
  /** 理论最优：前缀只写一次，之后全读。 */
  best: bigint
  /** 能不能报出「省了多少」。有任何一步不可观测，答案就是不能。 */
  provable: boolean
  reasons: string[]
}

/**
 * ★ 注意 `provable` 这个字段，它是这个交付物和一个普通成本面板的全部区别。
 *
 * 一步 UNDETERMINABLE 就足以让整段省钱结论作废。
 * 这不是过度谨慎：Anthropic 自己的 OpenAI 兼容层把 `prompt_tokens_details`
 * 恒置为空（官方原话 "Always empty"），也就是说在那条端点上，
 * 「缓存有没有生效」这个问题**在响应里没有答案**。
 * 此时报一个省钱比例，就是在编。
 */
export function audit(steps: Step[], price: Price): Audit {
  const rows: Row[] = []
  const reasons: string[] = []
  let paid = 0n
  let noCache = 0n
  let provable = true
  let writeOnlyRun = 0

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!
    const prev = steps[i - 1]
    const report = cacheVerdict(s.shape, s.usage, s.req.model, prefixTokens(s.req))

    // 未命中才需要归因。命中的时候 firstDivergence 只会说「没变」，没有信息量。
    const divergence =
      (report.verdict === 'MISS' || report.verdict === 'WRITE_ONLY') && prev
        ? firstDivergence(prev.req, s.req)
        : null

    const miss = Math.max(0, report.totalInput - report.readTokens - report.writeTokens)
    const stepPaid =
      charge(miss, price.inputMiss) +
      charge(report.readTokens, price.inputMiss, MULT.cacheRead) +
      charge(report.writeTokens, price.inputMiss, MULT.cacheWrite5m) +
      charge(s.outputTokens, price.output)

    paid += stepPaid
    noCache += charge(report.totalInput, price.inputMiss) + charge(s.outputTokens, price.output)
    rows.push({ label: s.label, report, divergence, paid: stepPaid })

    if (report.verdict === 'UNDETERMINABLE') {
      provable = false
      reasons.push(`${s.label}：端点不报缓存字段，这一步省了没省无法证明`)
    }

    // ★ 连续两次只写不读 = bug。一次是正常的冷启动。
    if (report.verdict === 'WRITE_ONLY') {
      writeOnlyRun++
      if (writeOnlyRun === 2) {
        reasons.push(
          '连续两次只写不读：断点后面挂着每次都变的内容。' +
            '这不是「缓存还没热」，是每次都在付 1.25 倍写入费而一次读都没拿到',
        )
      }
    } else {
      writeOnlyRun = 0
    }

    if (divergence && divergence.type !== 'previous_message_not_found') {
      reasons.push(
        `${s.label}：${divergence.type}${divergence.at === null ? '' : ` @ ${divergence.at}`}，` +
          `白付 ${divergence.cacheMissedTokens} token`,
      )
    }
  }

  // 理论最优：最大的那个前缀写一次，其余全命中。
  const maxPfx = Math.max(...rows.map((r) => r.report.totalInput))
  let best = charge(maxPfx, price.inputMiss, MULT.cacheWrite5m)
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) best += charge(rows[i]!.report.totalInput, price.inputMiss, MULT.cacheRead)
    best += charge(steps[i]!.outputTokens, price.output)
  }

  return { rows, paid, noCache, best, provable, reasons }
}

// ─────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`

const w = (s: string) => [...s].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - w(s)))
const rpad = (s: string, n: number) => ' '.repeat(Math.max(0, n - w(s))) + s

const COLOR: Record<string, (s: string) => string> = {
  HIT: green,
  MISS: yellow,
  WRITE_ONLY: red,
  BELOW_MINIMUM: dim,
  UNDETERMINABLE: red,
}

/** 百分比也走整数，理由见 budget.ts 里的注释。 */
function pct(part: bigint, whole: bigint): string {
  if (whole === 0n) return '—'
  const t = Number((part * 1000n) / whole)
  return `${Math.floor(t / 10)}.${t % 10}%`
}

function main(): number {
  const steps = session(systemAt)
  const a = audit(steps, FLASH)

  console.log(bold('\n═══ L15 成本审计 ═══'))

  // ── 一
  console.log(bold('\n一、逐步判定（唯一的信号在 usage 里）\n'))
  console.log(dim('  ' + pad('步骤', 22) + pad('判定', 16) + rpad('命中', 7) + rpad('写入', 7) + rpad('总输入', 8) + rpad('元', 11)))
  console.log(dim('  ' + '─'.repeat(70)))
  for (const r of a.rows) {
    const c = COLOR[r.report.verdict] ?? ((s: string) => s)
    console.log(
      '  ' +
        pad(r.label, 22) +
        c(pad(r.report.verdict, 16)) +
        rpad(String(r.report.readTokens), 7) +
        rpad(String(r.report.writeTokens), 7) +
        rpad(String(r.report.totalInput), 8) +
        rpad(yuan(r.paid), 11),
    )
  }

  // ── 二
  console.log(bold('\n二、未命中归因（「你的 bug」和「过期了」要分开）\n'))
  let n = 0
  for (const r of a.rows) {
    if (!r.divergence) continue
    n++
    console.log(
      `  ${pad(r.label, 22)}${yellow(pad(r.divergence.type, 18))}` +
        dim(`白付 ${r.divergence.cacheMissedTokens} token`),
    )
  }
  if (n === 0) console.log(dim('  （没有需要归因的步骤）'))
  console.log(
    dim(
      '\n  ★ *_changed 是「你的代码变了」——改代码。\n' +
        '    unavailable 是「缓存过期了」——改 TTL 或改请求节奏。\n' +
        '    把这两类混成一句「缓存命中率低」，是缓存调优最常见的浪费时间方式。',
    ),
  )
  // ★★ 这一段是整份报告里最该读两遍的地方。
  // 要的是「既只写不读、又能归因」的那一步。第一步也是只写不读，
  // 但它没有上一次可比，所以归因是空的——拿它举例讲不通。
  const worst = a.rows.find((r) => r.report.verdict === 'WRITE_ONLY' && r.divergence !== null)
  if (worst?.divergence) {
    console.log(
      '\n  ' +
        yellow('注意这两个数对不上：') +
        dim(
          `分歧只有 ${worst.divergence.cacheMissedTokens} token，\n  ` +
            `但第一节里那一步的写入是 ${worst.report.writeTokens} token，而且读到 0。\n` +
            '\n  ' +
            '这不是 bug，这是 lookback 的真实语义。分歧点之前的内容**逐字节相同**，\n  ' +
            '但系统不会因此命中——官方原话：「It is looking for prior writes, not for\n  ' +
            'stable content.」写入只发生在断点上，而断点在那个会变的块上，\n  ' +
            '所以更早的位置从来没有被写过，往回找也找不到东西。\n' +
            '\n  ' +
            `也就是说：**「分歧很小」不等于「损失很小」。** 这里每次请求都在全额重写 ${worst.report.writeTokens} token，\n  ` +
            '按 1.25 倍计费，一次读都没拿到。这就是第三节里实付超过 100% 的来源。',
        ),
    )
  }

  // ── 三
  console.log(bold('\n三、账\n'))
  console.log(`  ${pad('完全不开缓存', 18)}${rpad(yuan(a.noCache), 12)} 元   ${dim('← 这才是分母')}`)
  console.log(`  ${pad('实际付了', 18)}${rpad(yuan(a.paid), 12)} 元   ${dim(`= 不开缓存的 ${pct(a.paid, a.noCache)}`)}`)
  console.log(`  ${pad('理论最优', 18)}${rpad(yuan(a.best), 12)} 元   ${dim(`= 不开缓存的 ${pct(a.best, a.noCache)}`)}`)

  if (a.provable) {
    console.log(`\n  省下 ${bold(pct(a.noCache - a.paid, a.noCache))}`)
  } else {
    console.log(
      '\n  ' +
        red('拒绝报出省钱比例。') +
        '\n  ' +
        dim(
          '有步骤走的端点不返回缓存字段，这段账里有一部分不可观测。\n  ' +
            '把不可观测当成「没命中」会给你一个偏悲观但看起来精确的数字，\n  ' +
            '当成「命中」则偏乐观。两种都是编。所以这里什么都不报。',
        ),
    )
  }

  // ── 对照实验：唯一的区别是断点位置
  const fixed = audit(session(systemFixed), FLASH)
  console.log(bold('\n  对照实验：把断点从时间戳挪到稳定内容上\n'))
  console.log(dim('  ' + pad('断点位置', 26) + rpad('实付', 12) + rpad('占不开缓存', 12)))
  console.log(`  ${pad('在时间戳上（当前）', 26)}${rpad(yuan(a.paid), 12)}${rpad(pct(a.paid, a.noCache), 12)}`)
  console.log(`  ${pad('在稳定内容上', 26)}${rpad(yuan(fixed.paid), 12)}${rpad(pct(fixed.paid, fixed.noCache), 12)}`)
  console.log(
    dim(
      '\n  ★ 两次会话的内容一模一样，请求数一样，token 数一样。\n' +
        '    唯一的区别是 cache_control 挂在哪一个块上。',
    ),
  )

  // ── 四
  console.log(bold('\n四、路由：同一批任务，四种路由器 × 两种决策粒度\n'))
  // ★ 难度用 LCG 生成，不用 i % 2。
  // 严格交替的难度序列会制造一个假结论：只要 stickyEvery 是 2 的倍数，
  // 每个块的第一个任务就恒定是 easy，于是「按会话粒度」永远选便宜模型——
  // 看起来很省，但那是 fixture 的周期性造成的，不是路由策略的性质。
  // 这类「测试数据的周期和参数共振」的 bug，在性能实验里非常常见且极难发现。
  const tg = new Lcg(99)
  const tasks: Task[] = Array.from({ length: 100 }, (_, i) => ({
    id: `t${i}`,
    trueDifficulty: tg.int(2) === 1 ? 'hard' : 'easy',
    inputTokens: 1000,
    outputTokens: 200,
  }))
  const hardN = tasks.filter((t) => t.trueDifficulty === 'hard').length
  const weak = { model: 'flash', price: FLASH }
  const strong = { model: 'pro', price: PRO }
  const routers = [
    ['完美路由', { hardGivenHard: { num: 1n, den: 1n }, hardGivenEasy: { num: 0n, den: 1n } }],
    ['随机（基线）', { hardGivenHard: { num: 1n, den: 2n }, hardGivenEasy: { num: 1n, den: 2n } }],
    ['反着判', { hardGivenHard: { num: 0n, den: 1n }, hardGivenEasy: { num: 1n, den: 1n } }],
    ['全用便宜的', { hardGivenHard: { num: 0n, den: 1n }, hardGivenEasy: { num: 0n, den: 1n } }],
  ] as const

  console.log(
    dim(`  ${tasks.length} 个任务，其中 ${hardN} 个真的难；每个任务 1000 token 输入 / 200 token 输出。\n`),
  )
  for (const pfx of [0, 8000]) {
    const base = allStrong(tasks, strong, pfx)
    console.log(
      dim(
        `  共享前缀 ${pfx} token` +
          (pfx === 0
            ? '（不算缓存——大多数「路由省 N 倍」的文章算的就是这个账）'
            : '（把缓存算进来。基线全程不换模型，所以它的缓存是最优的）'),
      ),
    )
    const head = dim('  ' + pad('路由器', 22) + rpad('花费', 11) + rpad('占全强', 9) + rpad('重试', 6) + rpad('前缀命中', 10) + rpad('打断', 6))
    const row = (name: string, o: ReturnType<typeof routeOutcome>) => {
      const p = pct(o.picofen, base)
      const cell = o.picofen > base ? red(rpad(p, 9)) : green(rpad(p, 9))
      console.log(
        '  ' +
          pad(name, 22) +
          rpad(yuan(o.picofen), 11) +
          cell +
          rpad(String(o.retries), 6) +
          rpad(String(o.prefixReads), 10) +
          rpad(String(o.cacheBreaks), 6),
      )
    }

    console.log(head)
    for (const [name, router] of routers) {
      row(`${name}（每请求）`, routeOutcome(tasks, router, weak, strong, new Lcg(1), pfx))
    }
    console.log(dim('  ' + '·'.repeat(32) + ' 同一批路由器，只改决策粒度 ' + '·'.repeat(4)))
    for (const [name, router] of routers) {
      row(`${name}（每 10 个）`, routeOutcome(tasks, router, weak, strong, new Lcg(1), pfx, 10))
    }
    console.log(
      dim(
        `  ${pad('全用强模型（基线）', 22)}${rpad(yuan(base), 11)}${rpad('100.0%', 9)}${rpad('0', 6)}${rpad(String(tasks.length - 1), 10)}${rpad('0', 6)}`,
      ),
    )
    console.log('')
  }
  console.log(
    dim(
      '  ★ 上面两张表该怎么读：\n' +
        '\n' +
        '    没有共享前缀时（第一张表），路由的账基本符合直觉：路由器越准越省，\n' +
        '    「反着判」比全用强模型还贵——一个路由器可以是**负价值**的。\n' +
        '    另外注意「全用便宜的」比「随机路由」更省：路由器不比随机强，就不如不路由。\n' +
        '\n' +
        '    有 8000 token 共享前缀时（第二张表），**四种路由器全部输给基线**，\n' +
        '    而且不是输一点。原因不在路由决策的质量上——前缀是任务本身的 8 倍，\n' +
        '    而基线全程不换模型，它的前缀写一次读九十九次；任何切模型的策略\n' +
        '    每切一次就重写一遍整段前缀。这笔钱盖过了单价差。\n' +
        '\n' +
        '    决策粒度从「每请求」改到「每 10 个请求」确实明显有效（看打断和前缀命中\n' +
        '    这两列），但它**没有**把差距补平。而在第一张表里，同样的改动让账变差了——\n' +
        '    粘性路由是拿准确率换缓存命中，没有前缀可缓存的时候，这笔交易是纯亏。\n' +
        '\n' +
        '    所以结论不是「路由能省 N 倍」，也不是「路由没用」，而是：\n' +
        '    **先量一下前缀和任务的比例，再决定要不要路由、在什么粒度上路由。**\n' +
        '    这个比例是你自己系统的数，不是文章里的数。',
    ),
  )

  // ── 结论
  console.log(bold('\n═══ 结论 ═══\n'))
  for (const r of a.reasons) console.log(`  ${red('·')} ${r}`)
  const fail = a.reasons.length > 0
  console.log(fail ? red(`\n  ${a.reasons.length} 个问题。退出码 1。\n`) : green('\n  没有发现问题。\n'))
  return fail ? 1 : 0
}

process.exit(main())
