/**
 * 验证 l09/retrieve.ts。跑法：pnpm verify:l09
 *
 * 一次 API 都不调，**包括不调 embedding**。
 *
 * 这套测试里有一整组专门盯着**静默失效**：
 * 中文分词返回空、负 IDF 反向扣分、融合被量纲支配、重排负分意外过滤、
 * 装配静默截断、引用校验把"行号凑的"当成合法。
 *
 * ★ 它们的共同点是**不抛异常**。检索坏掉的样子从来不是报错，
 * 是"搜出来的东西看着还行，但少了最关键的那一片"——
 * 而少了什么你不会知道，因为你没有对照。
 *
 * 先跑 VERIFY_TARGET=shared pnpm verify:l09 确认测试本身是对的。
 */

// ─── 模块形状 ────────────────────────────────────────────────

interface Chunk {
  id: string
  text: string
  source: string
  lines: [number, number]
  path?: string
}

interface Scored {
  chunk: Chunk
  score: number
  via: 'vector' | 'bm25' | 'both'
}


interface Index {
  add(chunks: Chunk[]): void
  search(query: string, k: number): Scored[]
  readonly size: number
}

interface Reranked {
  kept: Scored[]
  dropped: { chunk: Chunk; why: string }[]
}

type RetrievalMode = 'none' | 'lookup' | 'search' | 'agentic'

interface RouteInput {
  corpusSize: number
  corpusTokens: number
  budgetTokens: number
  hasExactTerms: boolean
  needsExploration: boolean
}

interface Assembled {
  text: string
  used: Chunk[]
  truncated: Chunk[]
  tokens: number
}

interface CitationCheck {
  cited: string[]
  unknownSource: string[]
  wrongRange: string[]
  unused: string[]
}

interface RetrievalModule {
  chunkFixed(text: string, source: string, opts?: { size?: number; overlap?: number }): Chunk[]
  chunkByStructure(text: string, source: string, maxSize?: number): Chunk[]
  fakeEmbed(text: string, dim?: number): number[]
  cosine(a: number[], b: number[]): number
  vectorIndex(embed?: (t: string) => number[]): Index
  tokenize(s: string): string[]
  bm25Index(k1?: number, b?: number): Index
  rrf(lists: Scored[][], k?: number, limit?: number): Scored[]
  rerankHeuristic(
    query: string,
    cands: Scored[],
    opts?: { keep?: number; minScore?: number },
  ): Reranked
  chooseRetrieval(i: RouteInput): { mode: RetrievalMode; why: string }
  assemble(
    query: string,
    chunks: Chunk[],
    opts: { budget: number; estimate?: (s: string) => number },
  ): Assembled
  checkCitations(answer: string, provided: Chunk[]): CitationCheck
}

const target = process.env.VERIFY_TARGET === 'shared' ? 'shared' : 'mine'
const R: RetrievalModule =
  target === 'shared'
    ? ((await import('../shared/retrieval.ts')) as unknown as RetrievalModule)
    : ((await import('./retrieve.ts')) as unknown as RetrievalModule)

console.log(target === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l09/ 里你的实现）')

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

function raises(fn: () => unknown, hint: string) {
  try {
    fn()
  } catch (err) {
    if ((err as Error).message.startsWith('TODO:')) throw err
    return
  }
  throw new Error(`应该抛异常但没有：${hint}`)
}

const CODE = `import { createHash } from 'node:crypto'

// 会话令牌的签发与校验。
export interface TokenPayload {
  userId: string
  expiresAt: number
}

export function signToken(payload: TokenPayload, secret: string): string {
  const body = JSON.stringify(payload)
  const sig = createHash('sha256').update(body + secret).digest('hex')
  return Buffer.from(body).toString('base64url') + '.' + sig
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  const [b64, sig] = token.split('.')
  if (!b64 || !sig) return null
  const body = Buffer.from(b64, 'base64url').toString('utf8')
  if (JSON.parse(body).expiresAt < Date.now()) return null
  return JSON.parse(body)
}

export function loadSecret(path: string): string {
  const raw = readFileSync(path, 'utf8').trim()
  if (raw.length < 32) throw new Error('SECRET_TOO_SHORT: 密钥至少 32 字节')
  return raw
}
`

const chunk = (o: Partial<Chunk> & { id: string }): Chunk => ({
  text: 'x',
  source: 'a.ts',
  lines: [1, 1],
  ...o,
})

const scored = (id: string, score: number, via: Scored['via'] = 'vector'): Scored => ({
  chunk: chunk({ id, source: id.split('#')[0]! }),
  score,
  via,
})

// ─────────────────────────────────────────────────────────────
console.log('\n固定窗口分块')
// ─────────────────────────────────────────────────────────────

await test('切出多块，行号 1-based', () => {
  const cs = R.chunkFixed(CODE, 'a.ts', { size: 200 })
  assert(cs.length > 1, `size=200 应该切出多块，实际 ${cs.length}`)
  assert(cs[0]!.lines[0] === 1, `第一块起始行应该是 1，实际 ${cs[0]!.lines[0]}`)
  assert(
    cs.at(-1)!.lines[1] >= CODE.split('\n').length - 1,
    `最后一块没到文件尾（${cs.at(-1)!.lines[1]} vs ${CODE.split('\n').length}）`,
  )
})

await test('每块都带 source 和唯一 id', () => {
  const cs = R.chunkFixed(CODE, 'a.ts', { size: 200 })
  assert(
    cs.every((c) => c.source === 'a.ts'),
    '有块的 source 不对',
  )
  assert(new Set(cs.map((c) => c.id)).size === cs.length, 'id 有重复')
})


await test('★ 内容不能丢：每一行至少出现在一块里', () => {
  const cs = R.chunkFixed(CODE, 'a.ts', { size: 150 })
  const covered = new Set<number>()
  for (const c of cs) for (let i = c.lines[0]; i <= c.lines[1]; i++) covered.add(i)
  const total = CODE.split('\n').length
  const missing: number[] = []
  for (let i = 1; i <= total - 1; i++) if (!covered.has(i)) missing.push(i)
  assert(
    missing.length === 0,
    `第 ${missing.join('、')} 行没被任何块覆盖。\n` +
      '      这是分块最常见的静默 bug：内容丢了，而检索"正常工作"——\n' +
      '      它照样返回结果，只是永远返回不了那几行',
  )
})

await test('★ 默认有重叠（重叠不是可选项）', () => {
  const cs = R.chunkFixed(CODE, 'a.ts', { size: 150 })
  const overlapped = cs.slice(1).some((c, i) => c.lines[0] <= cs[i]!.lines[1])
  assert(
    overlapped,
    '相邻块的行范围完全不相交，也就是 overlap 默认为 0。\n' +
      '      固定窗口一定会在某处把一个语义单元切成两半——\n' +
      '      重叠让被切断的那部分在两个块里都完整出现一次',
  )
})

await test('★ overlap >= size 要抛错（否则是死循环）', () => {
  raises(
    () => R.chunkFixed(CODE, 'a.ts', { size: 100, overlap: 100 }),
    'overlap 等于 size：cursor 永远推进不了。\n' +
      '      静默的后果是进程卡死或者内存爆掉，而卡死比报错难查得多',
  )
})

await test('单行超长也能推进（不死循环）', () => {
  const long = 'const x = "' + 'a'.repeat(5000) + '"'
  const cs = R.chunkFixed(long, 'a.ts', { size: 100 })
  assert(cs.length >= 1, '一块都没有')
  assert(cs.length < 50, `一行 5000 字符切出了 ${cs.length} 块，说明推进逻辑有问题`)
})

await test('空文本不崩', () => {
  const cs = R.chunkFixed('', 'a.ts')
  assert(Array.isArray(cs), '应该返回数组')
})

// ─────────────────────────────────────────────────────────────
console.log('\n结构感知分块')
// ─────────────────────────────────────────────────────────────

await test('顶层声明各自成块，带 path', () => {
  const cs = R.chunkByStructure(CODE, 'a.ts')
  const paths = cs.map((c) => c.path)
  for (const name of ['signToken', 'verifyToken', 'loadSecret', 'TokenPayload']) {
    assert(paths.includes(name), `没有 path=${name} 的块，实际 ${JSON.stringify(paths)}`)
  }
})

await test('★ 函数体不能被切开', () => {
  const cs = R.chunkByStructure(CODE, 'a.ts')
  const vt = cs.find((c) => c.path === 'verifyToken')
  assert(vt, '找不到 verifyToken 那一块')
  assert(
    vt.text.includes('export function verifyToken') && vt.text.includes('return JSON.parse(body)'),
    '签名和函数体不在同一块里。\n' +
      '      被切成两半的函数在向量空间里既不像原函数、也不像别的东西——\n' +
      '      它是一个语义上的噪声，而且两半都召不回来',
  )
})

await test('第一个声明之前的内容单独成块', () => {
  const cs = R.chunkByStructure(CODE, 'a.ts')
  assert(cs[0]!.text.includes("from 'node:crypto'"), `第一块没包含 import：${cs[0]!.text.slice(0, 40)}`)
  assert(cs[0]!.lines[0] === 1, '第一块不是从第 1 行开始')
})

await test('缩进的成员跟着父级，不单独成块', () => {
  const cs = R.chunkByStructure(
    'export class Foo {\n  bar() { return 1 }\n  baz() { return 2 }\n}\n',
    'a.ts',
  )
  const named = cs.filter((c) => c.path && !c.path.startsWith('('))
  assert(named.length === 1, `应该只有 Foo 一块，实际 ${JSON.stringify(cs.map((c) => c.path))}`)
})

await test('★ 超大结构再切，但每片都带 path 定位', () => {
  const big = 'export function huge() {\n' + '  doThing()\n'.repeat(400) + '}\n'
  const cs = R.chunkByStructure(big, 'a.ts', 600)
  assert(cs.length > 1, `4000 字符的函数在 maxSize=600 下应该被切开，实际 ${cs.length} 块`)
  assert(
    cs.every((c) => c.path && /huge|第/.test(c.path)),
    `有片段没带定位信息：${JSON.stringify(cs.map((c) => c.path))}。\n` +
      '      模型要知道"这是 huge 的第 2/7 片"，而不是收到一段无主的代码',
  )
})

await test('★ 认不出结构时降级要可见，不能静默', () => {
  const prose = '这是一段纯中文说明。\n没有任何代码声明。\n第三行。\n'
  const cs = R.chunkByStructure(prose, 'doc.md')
  assert(cs.length >= 1, '一块都没有——认不出结构不能返回空')
  assert(
    cs.every((c) => c.path && /降级|fallback|固定窗口/i.test(c.path)),
    `降级了但没标记（path=${JSON.stringify(cs.map((c) => c.path))}）。\n` +
      '      静默降级的后果是你以为在用结构分块，其实一半文件走了固定窗口——\n' +
      '      而质量差异会被归因到 embedding 上，然后你去调 embedding',
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n假 embedding 与向量检索')
// ─────────────────────────────────────────────────────────────

await test('确定：同样输入同样输出', () => {
  const a = R.fakeEmbed('verifyToken 校验签名')
  const b = R.fakeEmbed('verifyToken 校验签名')
  assert(a.length === b.length && a.every((x, i) => x === b[i]), '两次结果不同')
})

await test('维度可配，默认 64', () => {
  assert(R.fakeEmbed('abc').length === 64, `默认维度不是 64`)
  assert(R.fakeEmbed('abc', 16).length === 16, 'dim 参数没生效')
})

await test('★ 归一化：模长为 1（否则余弦不能用点积算）', () => {
  const v = R.fakeEmbed('some text here for embedding')
  const norm = Math.hypot(...v)
  assert(
    Math.abs(norm - 1) < 1e-9,
    `模长 ${norm.toFixed(4)}，不是 1。\n` +
      '      不归一化的话余弦要每次都除模长，而更常见的错是忘了除——\n' +
      '      于是"长文档天然得分高"，检索结果被文档长度支配',
  )
})

await test('★ 空文本不能产出 NaN', () => {
  for (const s of ['', 'a', 'ab']) {
    const v = R.fakeEmbed(s)
    assert(
      v.every((x) => Number.isFinite(x)),
      `fakeEmbed(${JSON.stringify(s)}) 里有 NaN——除零没保护。\n` +
        '      NaN 会顺着余弦传到排序里，而 NaN 的比较永远是 false，\n' +
        '      表现为"排序结果随机"，非常难查',
    )
  }
})

await test('自己和自己的余弦是 1', () => {
  const v = R.fakeEmbed('hello world')
  assert(Math.abs(R.cosine(v, v) - 1) < 1e-9, `实际 ${R.cosine(v, v)}`)
})

await test('字面重合度高的更相似', () => {
  const q = R.fakeEmbed('verifyToken')
  const near = R.cosine(q, R.fakeEmbed('export function verifyToken(token, secret)'))
  const far = R.cosine(q, R.fakeEmbed('账单生成与税率计算'))
  assert(near > far, `near=${near.toFixed(3)} 不大于 far=${far.toFixed(3)}`)
})

await test('向量索引：size 与 k 生效，via=vector', () => {
  const idx = R.vectorIndex()
  const cs = R.chunkByStructure(CODE, 'a.ts')
  idx.add(cs)
  assert(idx.size === cs.length, `size=${idx.size}，应该是 ${cs.length}`)
  const hits = idx.search('令牌校验', 2)
  assert(hits.length === 2, `k=2 返回了 ${hits.length} 个`)
  assert(
    hits.every((h) => h.via === 'vector'),
    'via 没标成 vector——混合检索里没这个字段你没法调权重',
  )
  assert(hits[0]!.score >= hits[1]!.score, '没按分数降序')
})

await test('空索引搜索返回空数组，不崩', () => {
  assert(R.vectorIndex().search('anything', 3).length === 0, '空索引应该返回空')
})

await test('★ 索引内容要含出处：搜文件名要能命中', () => {
  const idx = R.vectorIndex()
  idx.add([
    chunk({ id: 'src/login.ts#1', source: 'src/login.ts', text: 'const a = 1', path: 'a' }),
    chunk({ id: 'src/billing/tax.ts#1', source: 'src/billing/tax.ts', text: 'const a = 1', path: 'a' }),
  ])
  const top = idx.search('login', 1)[0]
  assert(
    top?.chunk.source === 'src/login.ts',
    `搜 "login" 命中的是 ${top?.chunk.source}。\n` +
      '      ★ 文件路径是最强的检索信号之一，而只索引正文的话你压根搜不到它。\n' +
      '      两个片段的正文完全一样，唯一的区别就在路径上',
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n分词')
// ─────────────────────────────────────────────────────────────

await test('★ 驼峰要切开（否则搜 "user id" 匹配不到 getUserById）', () => {
  const t = R.tokenize('getUserById')
  assert(
    t.includes('user') && t.includes('id'),
    `实际 ${JSON.stringify(t)}。不切驼峰的话，代码检索里最常见的一类查询直接失效`,
  )
})

await test('下划线和点号也切', () => {
  const t = R.tokenize('max_login_attempts')
  assert(t.includes('login') && t.includes('attempts'), `实际 ${JSON.stringify(t)}`)
  assert(R.tokenize('src/session/store.ts').includes('store'), '路径没切开')
})


await test('大小写归一', () => {
  assert(R.tokenize('SECRET_TOO_SHORT').includes('secret'), '没转小写')
})

await test('★ 中文必须切出东西（这是最经典的静默失效）', () => {
  const t = R.tokenize('登录偶尔失败')
  assert(
    t.length >= 4,
    `「登录偶尔失败」只切出 ${JSON.stringify(t)}。\n` +
      '      中文没有空白，按空白分词的结果是整句变成一个 token——\n' +
      '      于是它匹配不到任何东西，而 BM25 会**安静地返回空列表**。\n' +
      '      代码不报错、索引也建起来了，只是搜什么都搜不到',
  )
})

await test('★ 中文要有二元组（单字的区分度太低）', () => {
  const t = R.tokenize('登录失败')
  assert(
    t.includes('登录'),
    `实际 ${JSON.stringify(t)}。\n` +
      '      只切单字的话，"的"、"是" 这种字到处都有，IDF 把它们压到接近 0，\n' +
      '      而真正有信息量的"登录"这个词从来没作为一个整体被索引过',
  )
})

await test('中英混排都要切到', () => {
  const t = R.tokenize('调用 getSession 之后返回 null')
  assert(t.includes('get') && t.includes('session'), `英文部分丢了：${JSON.stringify(t)}`)
  assert(
    t.some((x) => /[\u4e00-\u9fa5]/.test(x)),
    `中文部分丢了：${JSON.stringify(t)}`,
  )
})

await test('不产出空串', () => {
  const t = R.tokenize('  a---b  //  c  ')
  assert(
    t.every((x) => x.length > 0),
    `有空 token：${JSON.stringify(t)}。空 token 会污染 df 统计`,
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\nBM25')
// ─────────────────────────────────────────────────────────────

const docs: Chunk[] = [
  chunk({ id: 'a#1', source: 'a.ts', text: "if (raw.length < 32) throw new Error('SECRET_TOO_SHORT')" }),
  chunk({ id: 'b#1', source: 'b.ts', text: 'export function signToken(payload, secret) { return sign(payload) }' }),
  chunk({ id: 'c#1', source: 'c.ts', text: 'export function fmtBytes(n) { return n + "B" }' }),
  chunk({ id: 'd#1', source: 'd.ts', text: 'export function calcTax(amount) { return amount * 0.06 }' }),
]

await test('★ 精确错误码：BM25 完胜（这是它存在的理由）', () => {
  const kw = R.bm25Index()
  kw.add(docs)
  const top = kw.search('SECRET_TOO_SHORT', 3)[0]
  assert(top?.chunk.id === 'a#1', `Top1 是 ${top?.chunk.id}，应该是 a#1`)
})


await test('via=bm25，降序，k 生效', () => {
  const kw = R.bm25Index()
  kw.add(docs)
  const hits = kw.search('function', 2)
  assert(hits.length <= 2, `k=2 返回了 ${hits.length} 个`)
  assert(
    hits.every((h) => h.via === 'bm25'),
    'via 没标成 bm25',
  )
  assert(hits.every((h, i) => i === 0 || hits[i - 1]!.score >= h.score), '没降序')
})

await test('零分的不返回（一个词都不匹配的片段不该占名额）', () => {
  const kw = R.bm25Index()
  kw.add(docs)
  const hits = kw.search('zzzz_nonexistent_term', 10)
  assert(hits.length === 0, `搜不存在的词返回了 ${hits.length} 个结果`)
})

await test('★ IDF 不能为负（否则"人人都有的词"反向扣分）', () => {
  const kw = R.bm25Index()
  // 四个文档里 "function" 出现在三个，"export" 出现在三个。
  // 构造一个词出现在**全部**文档里的情况。
  const all = [1, 2, 3].map((i) => chunk({ id: `x${i}#1`, source: `x${i}.ts`, text: 'common word here' }))
  kw.add(all)
  const hits = kw.search('common', 5)
  assert(hits.length > 0, '出现在全部文档里的词直接搜不到了')
  assert(
    hits.every((h) => h.score >= 0),
    `有负分：${hits.map((h) => h.score.toFixed(3)).join('、')}。\n` +
      '      idf 里那两个 0.5 是平滑项。少了它们，df 等于 N 时 IDF 变成 0 或负数，\n' +
      '      而负分意味着"这个文档因为含有查询词而被扣分"——那是没有依据的',
  )
})

await test('★ 长度归一：短文档不吃亏', () => {
  const kw = R.bm25Index()
  kw.add([
    chunk({ id: 'short#1', source: 'short.ts', text: 'verifyToken' }),
    chunk({ id: 'long#1', source: 'long.ts', text: 'verifyToken ' + 'filler words here '.repeat(60) }),
  ])
  const top = kw.search('verifyToken', 2)[0]
  assert(
    top?.chunk.id === 'short#1',
    `Top1 是 ${top?.chunk.id}。b=0.75 的长度归一应该让只讲这一件事的短片段排前面`,
  )
})

await test('★ 中文查询能召回中文内容', () => {
  const kw = R.bm25Index()
  kw.add([
    chunk({ id: 'z#1', source: 'z.ts', text: '// Redis 客户端。连接池上限 2，超时 300ms，不自动重连。' }),
    chunk({ id: 'y#1', source: 'y.ts', text: '// 账单生成。按月聚合。' }),
  ])
  const hits = kw.search('连接池 超时', 2)
  assert(
    hits.length > 0 && hits[0]!.chunk.id === 'z#1',
    `中文查询返回 ${JSON.stringify(hits.map((h) => h.chunk.id))}。\n` +
      '      这条挂了通常不是 BM25 的问题，是 tokenize 的问题',
  )
})

await test('空索引不崩（avgLen 会除零）', () => {
  assert(R.bm25Index().search('x', 3).length === 0, '空索引应该返回空')
})

// ─────────────────────────────────────────────────────────────
console.log('\nRRF 融合')
// ─────────────────────────────────────────────────────────────


await test('★ 只用排名：一路的分数放大一千倍，结果不变', () => {
  const v = [scored('a#1', 0.91), scored('b#1', 0.90), scored('c#1', 0.89)]
  const b = [scored('c#1', 12, 'bm25'), scored('a#1', 8, 'bm25')]
  const before = R.rrf([v, b]).map((s) => s.chunk.id)
  const after = R.rrf([
    v.map((s) => ({ ...s, score: s.score * 1000 })),
    b.map((s) => ({ ...s, score: s.score / 1000 })),
  ]).map((s) => s.chunk.id)
  assert(
    JSON.stringify(before) === JSON.stringify(after),
    `放大分数改变了结果：${JSON.stringify(before)} → ${JSON.stringify(after)}。\n` +
      '      说明你用了分数而不是排名。而两路的分数不在同一个量纲上：\n' +
      '      余弦挤在 0.7~0.95，BM25 是 0~几十，相加等于只用 BM25',
  )
})

await test('★ 两路都召回的标成 both', () => {
  const fused = R.rrf([
    [scored('a#1', 0.9), scored('b#1', 0.8)],
    [scored('a#1', 5, 'bm25'), scored('c#1', 3, 'bm25')],
  ])
  const a = fused.find((s) => s.chunk.id === 'a#1')
  assert(a?.via === 'both', `a#1 的 via 是 ${a?.via}，应该是 both`)
  assert(fused.find((s) => s.chunk.id === 'b#1')?.via === 'vector', 'b#1 的 via 不对')
  assert(fused.find((s) => s.chunk.id === 'c#1')?.via === 'bm25', 'c#1 的 via 不对')
})

await test('★ 两路都进前十 > 一路第一另一路没召回', () => {
  // a 在两路都排第 3；b 在向量里排第 1，BM25 里没有。
  const v = [scored('b#1', 0.99), scored('x#1', 0.98), scored('a#1', 0.97)]
  const kwList = [scored('y#1', 9, 'bm25'), scored('z#1', 8, 'bm25'), scored('a#1', 7, 'bm25')]
  const fused = R.rrf([v, kwList])
  const ra = fused.findIndex((s) => s.chunk.id === 'a#1')
  const rb = fused.findIndex((s) => s.chunk.id === 'b#1')
  assert(
    ra < rb,
    `a#1 排第 ${ra + 1}，b#1 排第 ${rb + 1}。\n` +
      '      k=60 的作用就是压低头部的权重差：没有 k 时第 1 和第 2 名差 0.5，\n' +
      '      有 k 时差 0.0003。这让"两路共识"胜过"一路的第一名"',
  )
})

await test('去重：同一个 chunk 只出现一次', () => {
  const fused = R.rrf([[scored('a#1', 0.9)], [scored('a#1', 5, 'bm25')], [scored('a#1', 3, 'bm25')]])
  assert(fused.length === 1, `去重失败，返回了 ${fused.length} 个`)
})

await test('limit 生效，空输入不崩', () => {
  const many = Array.from({ length: 30 }, (_, i) => scored(`m${i}#1`, 1 - i / 100))
  assert(R.rrf([many], 60, 5).length === 5, 'limit 没生效')
  assert(R.rrf([]).length === 0, '空输入应该返回空')
  assert(R.rrf([[], []]).length === 0, '两个空列表应该返回空')
})

// ─────────────────────────────────────────────────────────────
console.log('\n重排')
// ─────────────────────────────────────────────────────────────

const cands: Scored[] = [
  { chunk: chunk({ id: 'hit#1', source: 'auth.ts', text: 'export function loadSecret(path) { if (raw.length < 32) throw }', path: 'loadSecret' }), score: 0.5, via: 'both' },
  { chunk: chunk({ id: 'mid#1', source: 'auth.ts', text: 'export function signToken(payload, secret)', path: 'signToken' }), score: 0.4, via: 'vector' },
  { chunk: chunk({ id: 'off#1', source: 'tax.ts', text: 'export function calcTax(amount) { return amount * 0.06 }', path: 'calcTax' }), score: 0.3, via: 'vector' },
]

await test('keep 生效，降序', () => {
  const { kept } = R.rerankHeuristic('load secret 最短长度', cands, { keep: 2, minScore: 0 })
  assert(kept.length <= 2, `keep=2 保留了 ${kept.length} 个`)
  assert(kept.every((s, i) => i === 0 || kept[i - 1]!.score >= s.score), '没降序')
})

await test('词覆盖率高的排前面', () => {
  const { kept } = R.rerankHeuristic('load secret', cands, { keep: 1, minScore: 0 })
  assert(kept[0]?.chunk.id === 'hit#1', `Top1 是 ${kept[0]?.chunk.id}`)
})

await test('★ minScore 是闸：没有它，"重排"只是重新排序', () => {
  const { kept, dropped } = R.rerankHeuristic('完全无关的查询词 zzzz', cands, {
    keep: 3,
    minScore: 0.5,
  })
  assert(
    kept.length < 3,
    `阈值 0.5 下还留了 ${kept.length} 个。\n` +
      '      排序不解决"召回的全是噪声"这个问题——高阈值下就该什么都不留',
  )
  assert(
    dropped.some((d) => /阈值|低于|minScore/.test(d.why)),
    `dropped 的理由里没区分"低于阈值"和"排名靠后"：${JSON.stringify(dropped.map((d) => d.why))}`,
  )
})

await test('★ dropped 必须带理由，且不丢候选', () => {
  const { kept, dropped } = R.rerankHeuristic('load secret', cands, { keep: 1, minScore: 0 })
  assert(
    kept.length + dropped.length === cands.length,
    `进去 ${cands.length} 个，出来 ${kept.length}+${dropped.length} 个。候选凭空消失了`,
  )
  assert(
    dropped.every((d) => typeof d.why === 'string' && d.why.length > 0),
    '有 dropped 没带理由。「为什么这段代码没被用上」是排查检索问题唯一有用的东西',
  )
})

await test('via=both 加分', () => {
  const one: Scored = { chunk: chunk({ id: 'p#1', source: 'p.ts', text: 'alpha beta' }), score: 0, via: 'vector' }
  const two: Scored = { chunk: chunk({ id: 'q#1', source: 'q.ts', text: 'alpha beta' }), score: 0, via: 'both' }
  const { kept } = R.rerankHeuristic('alpha beta', [one, two], { keep: 2, minScore: 0 })
  assert(kept[0]?.chunk.id === 'q#1', `两路召回的没排前面（Top1 是 ${kept[0]?.chunk.id}）`)
})


await test('★ 分数不能为负（负分会让 minScore=0 意外过滤）', () => {
  const huge: Scored = {
    chunk: chunk({ id: 'huge#1', source: 'h.ts', text: 'filler word '.repeat(3000) }),
    score: 0.1,
    via: 'vector',
  }
  const { kept } = R.rerankHeuristic('zzzz 完全不匹配', [huge], { keep: 5, minScore: 0 })
  assert(
    kept.length === 1,
    'minScore=0 本该"什么都不过滤"，结果过滤掉了。\n' +
      '      长度惩罚把一个无关片段压成了负分，而负分 < 0 于是被闸掉了。\n' +
      '      这种 bug 表现为"检索突然一片都不返回"，非常难查',
  )
})

await test('空候选不崩', () => {
  const r = R.rerankHeuristic('q', [], { keep: 3 })
  assert(r.kept.length === 0 && r.dropped.length === 0, '空候选应该两个都空')
})


await test('空查询不崩（不能除零）', () => {
  const r = R.rerankHeuristic('', cands, { keep: 2, minScore: 0 })
  assert(
    r.kept.every((s) => Number.isFinite(s.score)),
    '空查询产出了 NaN 分数——qToks.size 为 0 时的除零',
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n该不该检索')
// ─────────────────────────────────────────────────────────────

const route = (o: Partial<RouteInput>) =>
  R.chooseRetrieval({
    corpusSize: 20_000,
    corpusTokens: 4_000_000,
    budgetTokens: 200_000,
    hasExactTerms: false,
    needsExploration: false,
    ...o,
  })

await test('★ 语料塞得下就别检索', () => {
  const d = route({ corpusSize: 300, corpusTokens: 40_000, budgetTokens: 200_000 })
  assert(
    d.mode === 'none',
    `返回了 ${d.mode}。语料只占预算 20%，全塞进去。\n` +
      '      检索的收益是省钱和降延迟，代价是**可能漏掉相关内容**——\n' +
      '      而漏掉的那部分你不会知道。全塞没有这个风险',
  )
})

await test('★ 有精确标识符 → lookup，而不是向量', () => {
  const d = route({ hasExactTerms: true, corpusSize: 20_000 })
  assert(
    d.mode === 'lookup',
    `返回了 ${d.mode}。grep 在这个场景里打败任何 embedding：\n` +
      '      它精确、免费，而且**失败是响亮的**——找不到就是找不到，\n' +
      '      不会给你一个"最相似"的错答案',
  )
})

await test('★ 要找什么本身不确定 → agentic', () => {
  const d = route({ needsExploration: true })
  assert(d.mode === 'agentic', `返回了 ${d.mode}`)
})

await test('★ 探索优先于 lookup（两个都为真时）', () => {
  const d = route({ hasExactTerms: true, needsExploration: true })
  assert(
    d.mode === 'agentic',
    `返回了 ${d.mode}。有精确词但需要探索时，一次 grep 解决不了——\n` +
      '      第一次搜到什么决定第二次搜什么',
  )
})

await test('剩下的才是经典 RAG', () => {
  assert(route({}).mode === 'search', `返回了 ${route({}).mode}`)
})

await test('★ "塞得下"优先于一切（连 agentic 都让位）', () => {
  const d = route({ corpusTokens: 10_000, budgetTokens: 200_000, needsExploration: true, hasExactTerms: true })
  assert(
    d.mode === 'none',
    `返回了 ${d.mode}。判据的顺序是故意的：从最便宜的开始，够用就停。\n` +
      '      语料全在上下文里的时候，"探索"这件事模型自己就能做完`',
  )
})

await test('每个分支都要有 why', () => {
  for (const o of [
    { corpusTokens: 1000 },
    { hasExactTerms: true },
    { needsExploration: true },
    {},
  ]) {
    const d = route(o)
    assert(d.why && d.why.length > 8, `${d.mode} 的 why 太短或没有：${JSON.stringify(d.why)}`)
  }
})

// ─────────────────────────────────────────────────────────────
console.log('\n装配上下文')
// ─────────────────────────────────────────────────────────────

// chunkByStructure 还没写的时候这里会抛，而在模块顶层抛会带走整套测试——
// 于是你看到的是一条堆栈，不是一张"还差哪些"的清单。兜住它。
let parts: Chunk[] = []
try {
  parts = R.chunkByStructure(CODE, 'a.ts')
} catch {
  parts = []
}

await test('★ 每片都带出处和行号', () => {
  const got = R.assemble('令牌怎么签名', parts, { budget: 4000 })
  for (const c of got.used) {
    assert(
      got.text.includes(`${c.source}:${c.lines[0]}-${c.lines[1]}`),
      `${c.id} 的出处没写进文本。\n` +
        '      不可验证的引用等于没有引用——用户没法确认，于是只能信',
    )
  }
})

await test('★ 必须写明"没有依据就说不知道"', () => {
  const got = R.assemble('q', parts, { budget: 4000 })
  assert(
    /不知道|没有相关信息|不要编|无法回答/.test(got.text),
    '装配出来的文本里没有这句话。\n' +
      '      光给材料不给这句话，模型会在材料不够时用先验知识补——\n' +
      '      **而那正是 RAG 想避免的事**',
  )
})

await test('★ 被预算砍掉的必须报出来', () => {
  const got = R.assemble('q', parts, { budget: 220 })
  assert(got.used.length < parts.length, `预算 220 应该装不下全部 ${parts.length} 块`)
  assert(
    got.used.length + got.truncated.length === parts.length,
    `进去 ${parts.length} 块，出来 used=${got.used.length} + truncated=${got.truncated.length}。\n` +
      '      静默截断的后果是模型基于不完整的证据回答，\n' +
      '      而它不知道自己看的不完整，**于是语气一样自信**',
  )
})

await test('★ 预算是硬上限（header/footer 和 query 都要扣）', () => {
  const got = R.assemble('一个不算短的查询问题放在这里', parts, { budget: 400 })
  assert(
    got.tokens <= 400,
    `实际 ${got.tokens} token，超了预算 400。\n` +
      '      header/footer 和 query 本身也占 token。不扣的话每次都超一点，\n' +
      '      而超出的表现是最后一片被 API 截断——你看不到那件事发生',
  )
})

await test('预算够时全部装进去', () => {
  const got = R.assemble('q', parts, { budget: 100_000 })
  assert(got.truncated.length === 0, `预算充足还砍了 ${got.truncated.length} 块`)
  assert(got.used.length === parts.length, 'used 不全')
})

await test('estimate 可替换', () => {
  const got = R.assemble('q', parts, { budget: 4000, estimate: (s) => s.length })
  assert(got.tokens === got.text.length, `自定义 estimate 没生效（${got.tokens} vs ${got.text.length}）`)
})

await test('CJK 估算不能按 4 字符 1 token 算', () => {
  const cjk = [chunk({ id: 'z#1', source: 'z.md', text: '中'.repeat(200), lines: [1, 1] })]
  const got = R.assemble('q', cjk, { budget: 4000 })
  assert(
    got.tokens >= 200,
    `200 个汉字估成了 ${got.tokens} token。中文约 1 token/字，按 1/4 估会低估四倍`,
  )
})

await test('空片段列表不崩', () => {
  const got = R.assemble('q', [], { budget: 1000 })
  assert(got.used.length === 0 && got.tokens > 0, '空列表也该有 header/footer')
})

// ─────────────────────────────────────────────────────────────
console.log('\n引用校验')
// ─────────────────────────────────────────────────────────────

const provided: Chunk[] = [
  chunk({ id: 'a#1', source: 'auth.ts', lines: [11, 15] }),
  chunk({ id: 'a#2', source: 'auth.ts', lines: [20, 30] }),
  chunk({ id: 'b#1', source: 'store.ts', lines: [1, 9] }),
]

await test('抽出所有引用', () => {
  const c = R.checkCitations('见 auth.ts:11-15 和 store.ts:1-9。', provided)
  assert(c.cited.includes('auth.ts:11-15') && c.cited.includes('store.ts:1-9'), `实际 ${JSON.stringify(c.cited)}`)
})

await test('合法引用不报错', () => {
  const c = R.checkCitations('见 auth.ts:11-15。', provided)
  assert(c.unknownSource.length === 0, `误报 unknownSource：${JSON.stringify(c.unknownSource)}`)
  assert(c.wrongRange.length === 0, `误报 wrongRange：${JSON.stringify(c.wrongRange)}`)
})

await test('★ 文件压根不在检索结果里 → unknownSource', () => {
  const c = R.checkCitations('实现在 src/crypto/hmac.ts:8-20。', provided)
  assert(
    c.unknownSource.includes('src/crypto/hmac.ts:8-20'),
    `没抓到（unknownSource=${JSON.stringify(c.unknownSource)}）。\n` +
      '      这类说明模型在用先验知识——prompt 里那句"不许编"没生效',
  )
})

await test('★ 文件对但行号凑的 → wrongRange（更隐蔽也更常见）', () => {
  const c = R.checkCitations('校验逻辑见 auth.ts:120-140。', provided)
  assert(
    c.wrongRange.includes('auth.ts:120-140'),
    `没抓到（wrongRange=${JSON.stringify(c.wrongRange)}）。\n` +
      '      ★ 这一类比 unknownSource 更隐蔽：文件名看着眼熟，\n' +
      '      review 的人扫一眼就过了——而行号是模型凑的。\n' +
      '      两类要分开报，因为处置不同：一类要改 prompt，一类能自动修',
  )
})

await test('★ 两类不能混为一谈', () => {
  const c = R.checkCitations('auth.ts:120-140 和 nope.ts:1-2。', provided)
  assert(c.wrongRange.length === 1 && c.unknownSource.length === 1, `wrongRange=${JSON.stringify(c.wrongRange)}，unknownSource=${JSON.stringify(c.unknownSource)}`)
})

await test('★ unused：召回了但没被引用的片段', () => {
  const c = R.checkCitations('只看了 auth.ts:11-15。', provided)
  assert(
    c.unused.includes('b#1'),
    `unused=${JSON.stringify(c.unused)}，应该含 b#1。\n` +
      '      它是"检索召回了噪声"的信号，也是调 keep 的唯一依据',
  )
  assert(!c.unused.includes('a#1'), 'a#1 被引用了，不该在 unused 里')
})

await test('重复引用只算一次', () => {
  const c = R.checkCitations('auth.ts:11-15 ... auth.ts:11-15 ... auth.ts:11-15', provided)
  assert(c.cited.length === 1, `实际 ${c.cited.length} 个`)
})

await test('没有引用时全部 unused', () => {
  const c = R.checkCitations('我不知道。', provided)
  assert(c.cited.length === 0, '空答案不该抽出引用')
  assert(c.unused.length === 3, `unused=${c.unused.length}，应该是 3`)
})

// ─────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60))
if (failures.length === 0) {
  console.log(`\x1b[32m全过。${passed} 项。\x1b[0m`)
  console.log('\n接着跑 pnpm retrieve 看六组观察实验，再跑 pnpm agentic 看多轮检索的取舍。')
} else {
  console.log(`\x1b[31m${failures.length} 项没过（过了 ${passed} 项）：\x1b[0m`)
  for (const f of failures) console.log(`\x1b[31m  · ${f}\x1b[0m`)
  console.log('\n先跑 VERIFY_TARGET=shared pnpm verify:l09 对照参考实现。')
  process.exitCode = 1
}
