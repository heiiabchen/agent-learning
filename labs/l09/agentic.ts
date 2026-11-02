/**
 * L09 任务二：一次性检索 vs 多轮检索（agentic search）。
 *
 *   pnpm agentic
 *
 * 不用你写，直接跑。用的是 shared/retrieval.ts 里的参考实现。
 * 不调 API——模型的"决定下一步搜什么"这件事用一个确定性的规则模拟，
 * 因为**这个对比要能复现**。
 *
 * ★ 这个脚本要回答一个具体的问题：**agentic search 什么时候值得。**
 *
 * 网上的说法通常是"agentic search 更强"。这个说法不完整——它更强，
 * 而且更贵，而且在一半的场景里那个"更强"是零。
 */

import {
  assemble,
  bm25Index,
  chunkByStructure,
  rerankHeuristic,
  rrf,
  vectorIndex,
  type Chunk,
} from '../shared/retrieval.ts'
import { Ledger } from '../shared/ledger.ts'
import type { Usage } from '../shared/ledger.ts'

// ─────────────────────────────────────────────────────────────
// 一个小仓库
//
// 关键设计：**答案分散在有依赖关系的几个文件里。**
//
// 这不是为了刁难一次性检索，这是真实代码库的常态——
// 一个 bug 的成因通常横跨"入口 → 中间层 → 工具函数"三层，
// 而只有第一层的名字出现在用户的问题里。
// ─────────────────────────────────────────────────────────────

const REPO: Record<string, string> = {
  'src/login.ts': `import { verifyToken } from './auth/token'
import { getSession } from './session/store'

// 登录入口。先校验令牌，再取会话。
export async function login(token: string) {
  const payload = verifyToken(token, process.env.SECRET!)
  if (!payload) return { ok: false, reason: 'bad_token' }
  const session = await getSession(payload.userId)
  if (!session) return { ok: false, reason: 'no_session' }
  return { ok: true, session }
}
`,
  'src/auth/token.ts': `import { createHash } from 'node:crypto'

// 令牌的签名校验与过期判断。
export function verifyToken(token: string, secret: string) {
  const [b64, sig] = token.split('.')
  if (!b64 || !sig) return null
  const body = Buffer.from(b64, 'base64url').toString('utf8')
  const expect = createHash('sha256').update(body + secret).digest('hex')
  if (expect !== sig) return null
  const payload = JSON.parse(body)
  // 过期判断用的是本机时钟，没有做时钟漂移的容忍。
  if (payload.expiresAt < Date.now()) return null
  return payload
}
`,
  'src/session/store.ts': `import { redis } from './redis'

const TTL_SECONDS = 900

// 会话读写。getSession 拿不到就返回 null，调用方看到的是 no_session。
export async function getSession(userId: string) {
  const raw = await redis.get('sess:' + userId)
  if (!raw) return null
  return JSON.parse(raw)
}

export async function putSession(userId: string, data: unknown) {
  await redis.setex('sess:' + userId, TTL_SECONDS, JSON.stringify(data))
}
`,
  'src/session/redis.ts': `import { createClient } from 'redis'

// Redis 客户端。连接池上限 2，超时 300ms，不自动重连。
export const redis = createClient({
  url: process.env.REDIS_URL,
  socket: { connectTimeout: 300, reconnectStrategy: false },
  isolationPoolOptions: { max: 2 },
})
`,
  'src/config.ts': `export const CONFIG = {
  tokenTtlMinutes: 30,
  sessionTtlMinutes: 15,
  maxLoginAttempts: 5,
}
`,
  'docs/deploy.md': `# 部署

生产环境跑在三个区域。**各区域的时钟由 chrony 同步，允许 500ms 漂移。**

Redis 是单实例，没有做副本。连接数上限 64。
`,
  'docs/faq.md': `# 常见问题

## 登录报 bad_token

九成是客户端和服务端时钟不同步。令牌校验用的是本机时钟。

## 登录报 no_session

会话过期了，重新登录即可。
`,
  'src/utils/format.ts': `export function fmtDate(d: Date) {
  return d.toISOString().slice(0, 10)
}

export function fmtBytes(n: number) {
  if (n < 1024) return n + 'B'
  return (n / 1024).toFixed(1) + 'KB'
}
`,
  'src/utils/retry.ts': `export async function retry<T>(fn: () => Promise<T>, times = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < times; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 100 * 2 ** i))
    }
  }
  throw last
}
`,
  'src/api/routes.ts': `import { login } from '../login'

export const routes = {
  'POST /login': async (req: { token: string }) => login(req.token),
  'GET /health': async () => ({ ok: true }),
}
`,

  // ── 近似干扰项 ──────────────────────────────────────────────
  //
  // ★ 这几个文件是故意加的，它们在检索上和答案**竞争**。
  //
  // 真实项目里的检索难点从来不是"语料里没有答案"，是"语料里有五个
  // 看起来像答案的东西"。只用一堆完全无关的文件当语料，测出来的
  // 检索质量是虚高的。
  'src/db/pool.ts': `import { Pool } from 'pg'

// 数据库连接池。上限 20，空闲回收 30 秒。
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
})
`,
  'src/auth/password.ts': `import { scrypt } from 'node:crypto'

// 密码校验。登录失败超过 5 次锁定账号。
export async function verifyPassword(input: string, hash: string) {
  return new Promise<boolean>((resolve) => {
    scrypt(input, hash.slice(0, 16), 64, (_e, out) => resolve(out.toString('hex') === hash.slice(16)))
  })
}
`,
  'src/auth/oauth.ts': `// 第三方登录。令牌交换与回调校验。
export async function exchangeCode(code: string) {
  const res = await fetch('https://oauth.example.com/token', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
  if (!res.ok) return { ok: false, reason: 'bad_code' }
  return { ok: true, token: (await res.json()).access_token }
}
`,
  'src/session/cookie.ts': `// 会话 cookie 的读写。SameSite=Lax，7 天过期。
export function readSessionCookie(header: string) {
  const m = /sess=([^;]+)/.exec(header)
  return m ? m[1] : null
}
`,
  'docs/security.md': `# 安全

令牌用 HMAC-SHA256 签名。密钥至少 32 字节，从环境变量读。

会话过期时间 15 分钟，超时后需要重新登录。
`,
  'docs/api.md': `# API

## POST /login

请求体 { token }。失败时返回 reason，可能是 bad_token 或 no_session。
`,
}

// 一批完全无关的模块，把语料量拉到接近真实项目的量级。
//
// 为什么需要它们：**在一个只有 18 个片段的语料上，keep=8 等于把半个
// 仓库塞进去，任何检索策略都"能解决问题"。** 那个结论是假的——
// 它其实是 chooseRetrieval 的第一条（语料塞得下就别检索）。
const FILLER_TOPICS = [
  ['billing/invoice', '账单生成', 'buildInvoice'],
  ['billing/tax', '税率计算', 'calcTax'],
  ['export/csv', 'CSV 导出', 'toCsv'],
  ['export/pdf', 'PDF 渲染', 'renderPdf'],
  ['notify/email', '邮件通知', 'sendMail'],
  ['notify/webhook', 'Webhook 推送', 'postHook'],
  ['upload/image', '图片上传与压缩', 'compressImage'],
  ['upload/chunked', '分片上传', 'uploadPart'],
  ['search/filter', '列表筛选条件', 'buildFilter'],
  ['search/sort', '排序规则', 'compareBy'],
  ['i18n/plural', '复数规则', 'pluralize'],
  ['i18n/currency', '货币格式化', 'fmtMoney'],
  ['report/daily', '日报聚合', 'aggregateDaily'],
  ['report/chart', '图表数据整形', 'toSeries'],
  ['audit/log', '审计日志', 'writeAudit'],
  ['audit/diff', '变更对比', 'diffRecords'],
  ['queue/worker', '队列消费者', 'consume'],
  ['queue/dlq', '死信处理', 'moveToDlq'],
  ['cache/memo', '内存缓存', 'memoize'],
  ['cache/lru', 'LRU 淘汰', 'lruSet'],
  ['geo/distance', '距离计算', 'haversine'],
  ['geo/tz', '时区换算', 'toLocalTime'],
  ['perm/role', '角色权限', 'hasRole'],
  ['perm/scope', '作用域校验', 'checkScope'],
] as const

for (const [path, topic, fn] of FILLER_TOPICS) {
  REPO[`src/${path}.ts`] = `// ${topic}。
export function ${fn}(input: unknown) {
  if (!input) throw new Error('${fn.toUpperCase()}_EMPTY_INPUT')
  return input
}

export function ${fn}Batch(items: unknown[]) {
  return items.map(${fn})
}
`
}

const ALL_CHUNKS: Chunk[] = Object.entries(REPO).flatMap(([path, text]) =>
  path.endsWith('.md')
    ? [{ id: `${path}#1`, text, source: path, lines: [1, text.split('\n').length] as [number, number] }]
    : chunkByStructure(text, path),
)

// ─────────────────────────────────────────────────────────────
// 检索一轮
// ─────────────────────────────────────────────────────────────

const vec = vectorIndex()
const kw = bm25Index()
vec.add(ALL_CHUNKS)
kw.add(ALL_CHUNKS)

function searchOnce(query: string, keep: number): Chunk[] {
  const fused = rrf([vec.search(query, 8), kw.search(query, 8)])
  return rerankHeuristic(query, fused, { keep, minScore: 0 }).kept.map((s) => s.chunk)
}

// ─────────────────────────────────────────────────────────────
// 任务定义
//
// answer 是"要回答这个问题必须看到的文件集合"。这是人工标注的，
// 而**人工标注是唯一诚实的检索评测基线**——用模型判断"检索得好不好"
// 会让你测的东西从检索质量变成模型的口味（L12 会展开）。
// ─────────────────────────────────────────────────────────────

interface Task {
  question: string
  kind: '定点' | '探索'
  /** 必须召回的文件。全部命中才算解决。 */
  answer: string[]
  /**
   * 看到某个文件之后会追问什么。模拟"下一轮搜什么"里**由发现驱动**的那一半。
   */
  followUp: Record<string, string>
  /**
   * 什么都没追到时的备用探查序列。模拟另一半：**换个说法再搜。**
   *
   * ★ 真实的 agent 两种都会做，而且第二种更常见——因为第一轮
   * 经常什么有用的都没召回（干扰项赢了）。只建模第一种的话，
   * agentic search 会显得比实际更脆。
   */
  probes?: string[]
}

const TASKS: Task[] = [
  {
    question: 'verifyToken 是怎么校验签名的',
    kind: '定点',
    answer: ['src/auth/token.ts'],
    followUp: {},
  },
  {
    question: 'fmtBytes 这个函数在哪',
    kind: '定点',
    answer: ['src/utils/format.ts'],
    followUp: {},
  },
  {
    question: '会话的 TTL 是多少',
    kind: '定点',
    answer: ['src/session/store.ts'],
    followUp: {},
  },
  {
    question: '登录偶尔失败，用户说点了没反应然后要重新登录',
    kind: '探索',
    // ★ 根因在 redis.ts 的连接池上限，但**问题里没有任何词指向它**。
    answer: ['src/login.ts', 'src/session/store.ts', 'src/session/redis.ts'],
    followUp: {
      'src/login.ts': 'getSession 会话 返回 null',
      'src/session/store.ts': 'redis 连接池 上限 超时',
    },
    probes: ['login 登录入口 no_session', 'getSession 会话 返回 null', 'redis 连接池 上限 超时'],
  },
  {
    question: '多区域部署之后 bad_token 变多了，为什么',
    kind: '探索',
    answer: ['src/auth/token.ts', 'docs/deploy.md'],
    followUp: {
      'src/login.ts': 'verifyToken 令牌 校验 过期',
      'src/auth/token.ts': '时钟 漂移 区域 同步',
    },
  },
]

// ─────────────────────────────────────────────────────────────
// 两种策略
// ─────────────────────────────────────────────────────────────

const BUDGET = 4000
const FAKE_MODEL = 'deepseek-v4-flash'

interface Result {
  solved: boolean
  rounds: number
  chunks: number
  tokens: number
  yuan: number
  /** 召回但没用上的片段数。噪声比例的分子。 */
  noise: number
}

function usageOf(inputTokens: number): Usage {
  return { input_tokens: inputTokens, output_tokens: 200 }
}

/** 一次性检索：一个 query，一轮，keep 个片段，交给模型。 */
function oneShot(task: Task, keep: number): Result {
  const ledger = new Ledger('one-shot')
  const got = searchOnce(task.question, keep)
  const packed = assemble(task.question, got, { budget: BUDGET })
  ledger.record({
    label: 'answer',
    id: 'msg_1',
    model: FAKE_MODEL,
    usage: usageOf(packed.tokens),
    ms: 1,
  })

  const sources = new Set(packed.used.map((c) => c.source))
  const solved = task.answer.every((a) => sources.has(a))
  return {
    solved,
    rounds: 1,
    chunks: packed.used.length,
    tokens: packed.tokens,
    yuan: ledger.totals().yuan,
    noise: packed.used.filter((c) => !task.answer.includes(c.source)).length,
  }
}

/**
 * 多轮检索：每轮的 query 由上一轮召回的内容决定。
 *
 * ★ 真实实现里"下一轮搜什么"是模型决定的（它调 search 工具）。
 * 这里用 task.followUp 模拟那个决定，为的是**让对比可复现**。
 *
 * 代价也照实算：每一轮都是一次模型调用，而**每一次调用都要重发
 * 前面所有的检索结果**（L02 的无状态）。所以 token 是累积的。
 */
function agentic(task: Task, keepPerRound: number, maxRounds: number): Result {
  const ledger = new Ledger('agentic')
  const seen = new Map<string, Chunk>()
  const asked = new Set<string>()
  let query = task.question
  let rounds = 0
  let probeAt = 0

  for (let r = 0; r < maxRounds; r++) {
    rounds++
    asked.add(query)
    for (const c of searchOnce(query, keepPerRound)) seen.set(c.id, c)

    const packed = assemble(task.question, [...seen.values()], { budget: BUDGET })
    ledger.record({
      label: `round ${rounds}`,
      id: `msg_${rounds}`,
      model: FAKE_MODEL,
      usage: usageOf(packed.tokens),
      ms: 1,
    })

    const sources = new Set(packed.used.map((c) => c.source))
    if (task.answer.every((a) => sources.has(a))) {
      return {
        solved: true,
        rounds,
        chunks: packed.used.length,
        tokens: packed.tokens,
        yuan: ledger.totals().yuan,
        noise: packed.used.filter((c) => !task.answer.includes(c.source)).length,
      }
    }

    // 先按"已召回的文件"派生下一轮 query（由发现驱动）；
    // 派生不出来就换个说法再搜（probes）。
    let next = [...sources].map((s) => task.followUp[s]).find((q) => q && !asked.has(q))
    while (!next && task.probes && probeAt < task.probes.length) {
      const p = task.probes[probeAt++]!
      if (!asked.has(p)) next = p
    }
    if (!next) break
    query = next
  }

  const packed = assemble(task.question, [...seen.values()], { budget: BUDGET })
  const sources = new Set(packed.used.map((c) => c.source))
  return {
    solved: task.answer.every((a) => sources.has(a)),
    rounds,
    chunks: packed.used.length,
    tokens: packed.tokens,
    yuan: ledger.totals().yuan,
    noise: packed.used.filter((c) => !task.answer.includes(c.source)).length,
  }
}

// ─────────────────────────────────────────────────────────────

function row(label: string, r: Result): string {
  const mark = r.solved ? '\x1b[32m解决\x1b[0m' : '\x1b[31m未解决\x1b[0m'
  return (
    `    ${label.padEnd(16)} ${mark}  ` +
    `${r.rounds} 轮 · ${String(r.chunks).padStart(2)} 片 · ` +
    `${String(r.tokens).padStart(4)} token · ¥${r.yuan.toFixed(5)} · ` +
    `噪声 ${r.noise}/${r.chunks}`
  )
}

function main() {
  console.log('一次性检索 vs 多轮检索。不调 API，结果可复现。')
  console.log(`\n仓库：${Object.keys(REPO).length} 个文件，切成 ${ALL_CHUNKS.length} 个片段。`)

  const totals = {
    oneShot: { solved: 0, yuan: 0, noise: 0, chunks: 0 },
    oneShotWide: { solved: 0, yuan: 0, noise: 0, chunks: 0 },
    agentic: { solved: 0, yuan: 0, noise: 0, chunks: 0 },
  }

  for (const task of TASKS) {
    console.log(`\n  【${task.kind}】${task.question}`)
    console.log(`    需要看到：${task.answer.join('、')}`)

    const a = oneShot(task, 3)
    const b = oneShot(task, 8)
    const c = agentic(task, 3, 4)

    console.log(row('一次性 keep=3', a))
    console.log(row('一次性 keep=8', b))
    console.log(row('多轮 agentic', c))

    for (const [t, r] of [
      [totals.oneShot, a],
      [totals.oneShotWide, b],
      [totals.agentic, c],
    ] as const) {
      t.solved += r.solved ? 1 : 0
      t.yuan += r.yuan
      t.noise += r.noise
      t.chunks += r.chunks
    }
  }

  const n = TASKS.length
  console.log('\n' + '─'.repeat(70))
  console.log('\n【合计】')
  console.log(`  一次性 keep=3   解决 ${totals.oneShot.solved}/${n}   ¥${totals.oneShot.yuan.toFixed(5)}`)
  console.log(`  一次性 keep=8   解决 ${totals.oneShotWide.solved}/${n}   ¥${totals.oneShotWide.yuan.toFixed(5)}`)
  console.log(`  多轮 agentic    解决 ${totals.agentic.solved}/${n}   ¥${totals.agentic.yuan.toFixed(5)}`)

  // ★ 结论三的数字是**算出来的**，不是写死的。
  //
  // 因为这一条的重点恰恰是"结果取决于答案碰巧排第几"——
  // 把结论写死就等于在演示里假装那个结果是必然的。
  const gained = totals.oneShotWide.solved - totals.oneShot.solved
  const costUp = ((totals.oneShotWide.yuan / totals.oneShot.yuan - 1) * 100).toFixed(0)
  const noiseNarrow = ((totals.oneShot.noise / totals.oneShot.chunks) * 100).toFixed(0)
  const noiseWide = ((totals.oneShotWide.noise / totals.oneShotWide.chunks) * 100).toFixed(0)

  console.log(`
【四条结论】

一 · **定点问题上，多轮检索一分收益都没有。**

    看前三行：agentic 那一行的数字和 keep=3 **完全一样**——
    一轮就命中，没有第二轮。它的额外价值是零。

    好消息是它也没多花钱（因为它会自己停）。坏消息是真实系统里
    它会多花：真 agent 得先调一次工具才知道该不该继续，而那一次
    调用是要付钱的。

    这是 L07 那条判据的检索版：**知道要找什么，就别让模型自己探索。**

二 · **探索问题上，keep 开大解决不了第一个问题。**

    "登录偶尔失败" 的根因在 redis.ts 的连接池上限，而**问题里
    没有任何词指向它**。keep=8 召回的片段几乎全是噪声——
    它不是排名靠后，是**语义上和问题不相关**。

    只有"先看 login.ts，发现它调 getSession，于是去看 store.ts，
    发现它调 redis"这条链能到达。而这条链只能一轮一轮走。

    ★ **一次性检索的上限不是 keep，是 query。** query 是用户写的，
    而用户不知道答案在哪——这才是 agentic search 真正的立足点。

三 · **调 keep 是在赌答案的排名，而你事先不知道答案排第几。**

    keep 从 3 开到 8 的账：多解决了 ${gained} 个问题，
    成本涨 ${costUp}%，噪声比例从 ${noiseNarrow}% 涨到 ${noiseWide}%。

    keep 开大**只能救"答案恰好排在第 4 到第 8 名"的那些问题**。
    排在第 20 名的照样漏，而语义上压根不相关的（上面那个连接池）
    keep 开到 100 也漏。

    ★ 所以这不是一个可以调优的参数，是一个**赌注**。
    而它的赔率取决于你事先不知道的东西。

四 · **噪声的危害不只是浪费 token。**

    看"噪声"列。那些无关片段会**稀释注意力**（L05x）并且提高幻觉概率：
    模型看到 src/auth/password.ts 里的"登录失败超过 5 次锁定账号"，
    就可能编出"登录偶尔失败是因为触发了防爆破锁定"——
    **一个完全讲得通、有材料支撑、而且错的答案。**

    这是 RAG 最常见的一种自伤：**为了提高召回率而降低了答案质量。**
    而召回率涨了这件事在指标上看得见，答案变差看不见。

【TODO】

  1. 把 agentic 的 maxRounds 从 4 改成 1。它退化成什么？
     和 oneShot(task, 3) 的结果完全一样吗？为什么？

  2. 把 TASKS 里的 followUp 和 probes 全部清空，再跑探索型那两个。
     ★ 这模拟的是**大多数人实际实现出来的 agentic search**：
     它确实调了 search 工具好几次，但每轮的 query 都差不多。
     它比一次性检索强吗？强在哪、贵多少？

  3. 给 FILLER_TOPICS 再加 50 个无关模块（语料翻一倍）。
     哪一种策略退化得最快？为什么 keep 越大退化越明显？

  4. 把 searchOnce 里的 rrf 换成"只用 vec"，再换成"只用 kw"。
     三种配置在"定点"和"探索"两类问题上的表现分别怎么变？
`)
}

main()
