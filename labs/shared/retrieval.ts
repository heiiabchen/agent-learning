/**
 * 参考实现：检索。分块、向量、BM25、混合、重排、以及一条上下文装配。
 *
 * ★ 这个文件里没有真的 embedding 模型调用。
 *
 * 不是偷懒。而是**检索质量的问题九成不在 embedding 上**，在分块、
 * 融合、重排和"该不该检索"这四件事上。用一个确定性的假向量器，
 * 你能把那四件事单独测出来——而接上真模型之后，这四件事的 bug
 * 会被"模型效果"这个借口盖住。
 *
 * 真接 embedding 只是把 fakeEmbed 换成一次 HTTP 调用，
 * 剩下的代码一行都不用改。这本身就是这个设计想说明的事。
 */

// ─────────────────────────────────────────────────────────────
// 分块
// ─────────────────────────────────────────────────────────────

export interface Chunk {
  id: string
  text: string
  /** 来源标识。**没有出处的片段不许进上下文**，理由和 L08 的 source 一样。 */
  source: string
  /** 在源文件里的行范围。引用要能点回去。 */
  lines: [number, number]
  /** 结构路径，比如 'class Foo > method bar'。给模型定位用。 */
  path?: string
}

export interface ChunkOptions {
  /** 目标大小（字符数）。 */
  size?: number
  /** 重叠。**不是可选项**，见下面的注释。 */
  overlap?: number
}

/**
 * 固定窗口分块。最简单的那种，也是**大多数人唯一实现的那种**。
 *
 * ★ 重叠不是调参，是补丁。
 *
 * 固定窗口一定会在某个地方把一个完整的语义单元切成两半——
 * 一个函数的签名和函数体分家、一个 if 和它的 else 分家。
 * 重叠让被切断的那部分在两个块里都出现一次，于是至少有一个块是完整的。
 *
 * 代价是**存储和检索成本按重叠比例上涨**，而且同一段内容会以两个
 * 不同的块被召回，占掉两个名额（所以后面必须去重）。
 */
export function chunkFixed(text: string, source: string, opts: ChunkOptions = {}): Chunk[] {
  const size = opts.size ?? 800
  const overlap = opts.overlap ?? Math.floor(size * 0.15)
  if (overlap >= size) throw new Error(`overlap(${overlap}) 必须小于 size(${size})，否则永远推进不了`)

  const lines = text.split('\n')
  const out: Chunk[] = []
  let cursor = 0 // 行号（0-based）
  let n = 0

  while (cursor < lines.length) {
    let chars = 0
    let end = cursor
    while (end < lines.length && chars < size) {
      chars += lines[end]!.length + 1
      end++
    }
    out.push({
      id: `${source}#${++n}`,
      text: lines.slice(cursor, end).join('\n'),
      source,
      lines: [cursor + 1, end],
    })
    if (end >= lines.length) break

    // 按字符数往回退，换算成行。
    let back = end - 1
    let backChars = 0
    while (back > cursor && backChars < overlap) {
      backChars += lines[back]!.length + 1
      back--
    }
    cursor = Math.max(cursor + 1, back)
  }
  return out
}

/**
 * 结构感知分块。按代码的语法边界切，而不是按字符数。
 *
 * ★ 这是这一节最实用的一条：**对代码，结构分块的检索质量比调
 * 任何 embedding 参数的收益都大。**
 *
 * 因为代码的语义单元是显式的（函数、类、方法），而固定窗口对它们
 * 一无所知。一个被切成两半的函数在向量空间里既不像原函数、
 * 也不像任何别的东西——它是一个语义上的噪声。
 *
 * 这里用一个很粗的正则当"语法"，真实项目应该用 tree-sitter。
 * 但**粗的结构信息也远好过没有结构信息**，这是重点。
 */
const TOP_LEVEL =
  /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|def|async def)\s+([A-Za-z_$][\w$]*)/

export function chunkByStructure(text: string, source: string, maxSize = 1600): Chunk[] {
  const lines = text.split('\n')
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // 只认顶层（不缩进）的声明。缩进的是成员，跟着父级走。
    if (!/^\s/.test(line) && TOP_LEVEL.test(line)) starts.push(i)
  }

  // 一个结构都没识别出来：退回固定窗口，而不是返回空。
  //
  // ★ 这个降级必须是**可见的**——每一片都标上 path，
  // 这样你 dump 一遍分块结果就能看出哪些文件走了降级。
  //
  // 静默降级的后果是你以为在用结构分块，其实一半文件是固定窗口，
  // 而检索质量的差异会被归因到 embedding 上，然后你去调 embedding。
  if (starts.length === 0) {
    return chunkFixed(text, source, { size: maxSize }).map((c) => ({
      ...c,
      path: '(未识别结构，固定窗口降级)',
    }))
  }

  const out: Chunk[] = []
  let n = 0
  // 第一个声明之前的内容（import、注释头）单独成块。
  if (starts[0]! > 0) {
    out.push({
      id: `${source}#${++n}`,
      text: lines.slice(0, starts[0]!).join('\n'),
      source,
      lines: [1, starts[0]!],
      path: '(文件头)',
    })
  }

  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!
    const to = i + 1 < starts.length ? starts[i + 1]! : lines.length
    const body = lines.slice(from, to)
    const name = TOP_LEVEL.exec(lines[from]!)?.[1] ?? '(匿名)'

    // 超大的结构（一个 800 行的类）还是要再切，但**每一片都带上 path**。
    // 这样模型知道"这是 Foo 类的第 2 片"，而不是一段无主的代码。
    if (body.join('\n').length > maxSize) {
      const pieces = chunkFixed(body.join('\n'), source, { size: maxSize })
      pieces.forEach((p, k) => {
        out.push({
          id: `${source}#${++n}`,
          text: p.text,
          source,
          lines: [from + p.lines[0], from + p.lines[1]],
          path: `${name} (第 ${k + 1}/${pieces.length} 片)`,
        })
      })
    } else {
      out.push({
        id: `${source}#${++n}`,
        text: body.join('\n'),
        source,
        lines: [from + 1, to],
        path: name,
      })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// 向量检索
// ─────────────────────────────────────────────────────────────

/**
 * 确定性的假 embedding。
 *
 * 把字符 n-gram 哈希到固定维度，然后归一化。它不懂语义，但它
 * **确定、免费、而且对"字面重合"敏感**——足够把分块、融合、重排
 * 这三件事测出来。
 *
 * ★ 它有一个和真 embedding 完全一致的性质，而这个性质是这一节的
 * 一个关键论点：**它无法匹配同义但用词不同的内容。** 真 embedding
 * 在这方面更好，但**远没有大多数人以为的那么好**——这就是为什么
 * 纯向量检索会在专有名词、错误码、变量名上大面积失手。
 */
export function fakeEmbed(text: string, dim = 64): number[] {
  const v = new Array(dim).fill(0)
  const s = text.toLowerCase()
  for (let i = 0; i + 2 < s.length; i++) {
    const gram = s.slice(i, i + 3)
    let h = 0
    for (let k = 0; k < gram.length; k++) h = (h * 31 + gram.charCodeAt(k)) | 0
    v[Math.abs(h) % dim] += 1
  }
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot // 两边都已归一化
}

export interface Scored {
  chunk: Chunk
  score: number
  /** 哪一路召回的。**混合检索必须带这个**，否则你没法调权重。 */
  via: 'vector' | 'bm25' | 'both'
}

export interface VectorIndex {
  add(chunks: Chunk[]): void
  search(query: string, k: number): Scored[]
  readonly size: number
}

export function vectorIndex(embed: (t: string) => number[] = fakeEmbed): VectorIndex {
  const items: { chunk: Chunk; vec: number[] }[] = []
  return {
    add(chunks) {
      for (const c of chunks) items.push({ chunk: c, vec: embed(indexText(c)) })
    },
    search(query, k) {
      const q = embed(query)
      return items
        .map((it) => ({ chunk: it.chunk, score: cosine(q, it.vec), via: 'vector' as const }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
    },
    get size() {
      return items.length
    },
  }
}

// ─────────────────────────────────────────────────────────────
// 关键词检索（BM25）
// ─────────────────────────────────────────────────────────────

/**
 * ★ BM25 在代码检索上常常**打败**向量检索，而这一点很反直觉。
 *
 * 理由是代码里最关键的词是**专有名词**：函数名、变量名、错误码、
 * 配置项。它们的语义完全来自约定而不是语言——`useCallback` 和
 * `useMemo` 在向量空间里非常近，而它们是两个不同的东西。
 *
 * 而 BM25 是精确的字面匹配加上两个统计修正：
 *   IDF     —— 罕见词权重高。`ENOENT` 比 `error` 有信息量
 *   长度归一 —— 长文档不因为词多而占便宜
 *
 * 所以正确的问题从来不是"用向量还是用关键词"，是**怎么把两路合起来**。
 */
export function tokenize(s: string): string[] {
  // ★ 两个都不能省的处理：
  //
  // 一 · **驼峰要切开。** getUserById → get user by id。
  //      不切的话搜 "user id" 匹配不到 getUserById，
  //      而这是代码检索里最常见的一类查询。
  //
  // 二 · **中文要切成字加二元组。** 中文没有空白，按空白分词的结果是
  //      「登录偶尔失败用户说点了没反应」变成**一个** token——
  //      于是它匹配不到任何东西，而 BM25 会安静地返回空列表。
  //
  //      这是中文检索里最经典的静默失效：代码没报错、索引也建起来了，
  //      只是搜什么都搜不到。而单字的区分度太低（"的"、"是" 到处都有），
  //      所以还要加二元组："登录" 这个二元组比 "登" 加 "录" 有信息量得多。
  const out: string[] = []
  const norm = s.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase()
  for (const m of norm.matchAll(/[a-z0-9]+|[\u4e00-\u9fa5\u3040-\u30ff]+/g)) {
    const t = m[0]
    if (/^[a-z0-9]+$/.test(t)) {
      out.push(t)
      continue
    }
    for (let i = 0; i < t.length; i++) {
      out.push(t[i]!)
      if (i + 1 < t.length) out.push(t.slice(i, i + 2))
    }
  }
  return out
}

/**
 * 索引用的文本：把出处和结构路径拼在正文前面。
 *
 * ★ 这一行是很多人漏掉的，而它的影响很大：**文件路径本身是最强的
 * 检索信号之一。** 「登录相关的代码在哪」这个问题，`src/login.ts`
 * 这个路径比文件内容更有指示性——而如果只索引正文，你压根搜不到它。
 */
export function indexText(c: Chunk): string {
  return `${c.source} ${c.path ?? ''}\n${c.text}`
}

export interface Bm25Index {
  add(chunks: Chunk[]): void
  search(query: string, k: number): Scored[]
  readonly size: number
}

export function bm25Index(k1 = 1.5, b = 0.75): Bm25Index {
  const docs: { chunk: Chunk; tf: Map<string, number>; len: number }[] = []
  const df = new Map<string, number>()

  return {
    add(chunks) {
      for (const c of chunks) {
        const toks = tokenize(indexText(c))
        const tf = new Map<string, number>()
        for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
        for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
        docs.push({ chunk: c, tf, len: toks.length })
      }
    },
    search(query, k) {
      if (docs.length === 0) return []
      const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length
      const qToks = [...new Set(tokenize(query))]

      return docs
        .map((d) => {
          let score = 0
          for (const t of qToks) {
            const f = d.tf.get(t)
            if (!f) continue
            const n = df.get(t) ?? 0
            // 加 0.5 平滑，避免 df 等于文档总数时 IDF 变成 0 或负数。
            const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
            score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)))
          }
          return { chunk: d.chunk, score, via: 'bm25' as const }
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
    },
    get size() {
      return docs.length
    },
  }
}

// ─────────────────────────────────────────────────────────────
// 融合
// ─────────────────────────────────────────────────────────────

/**
 * 倒数排名融合（RRF）。
 *
 * ★ 为什么不能直接把两路的分数加起来（或者加权平均）：
 *
 * **两路的分数不在同一个量纲上，而且它们的分布形状完全不同。**
 * 余弦相似度挤在 0.7 到 0.95 之间（差异极小），BM25 是 0 到几十
 * 的长尾。相加的结果是 BM25 完全支配，向量那一路等于没有。
 *
 * 归一化能缓解但不解决：min-max 归一化对离群值极其敏感，
 * 而 BM25 的最高分**天生就是离群值**（那正是精确命中）。
 *
 * RRF 只用排名，于是量纲问题从根上消失了：
 *
 *     score(d) = Σ 1 / (k + rank_i(d))
 *
 * k 是个平滑常数（惯例 60）。它的作用是**压低头部的权重差**：
 * 没有 k 的话第 1 名和第 2 名的分差是 0.5，有 k 的话是 0.0003。
 * 这让"两路都排进前十"胜过"一路排第一另一路没召回"——
 * 而这正是混合检索想要的行为。
 */
export function rrf(lists: Scored[][], k = 60, limit = 10): Scored[] {
  const acc = new Map<string, { chunk: Chunk; score: number; vias: Set<string> }>()
  for (const list of lists) {
    list.forEach((s, i) => {
      const cur = acc.get(s.chunk.id) ?? { chunk: s.chunk, score: 0, vias: new Set<string>() }
      cur.score += 1 / (k + i + 1)
      cur.vias.add(s.via)
      acc.set(s.chunk.id, cur)
    })
  }
  return [...acc.values()]
    .map((v) => ({
      chunk: v.chunk,
      score: v.score,
      via: (v.vias.size > 1 ? 'both' : [...v.vias][0]) as Scored['via'],
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * 重排。
 *
 * ★ 重排是**性价比最高的一步**，而它常常被跳过。
 *
 * 理由是检索和重排在做两件不同的事：
 *   检索  —— 从一万个里捞出五十个。要快，所以只能看粗特征
 *   重排  —— 从五十个里挑出五个。可以慢，所以能看细特征
 *
 * 真实的重排器是一个 cross-encoder（把 query 和文档拼在一起过一遍
 * 模型），或者直接让 LLM 打分。这里用一个确定性的启发式打分器，
 * 它演示的是**重排的形状**：全部候选进去，少数几个出来，
 * 而且**丢掉的那些要能说出为什么丢**。
 */
export interface RerankOptions {
  /** 保留几个。 */
  keep?: number
  /** 低于这个分直接扔。**没有这个闸的重排只是重新排序。** */
  minScore?: number
}

export interface Reranked {
  kept: Scored[]
  /** 丢掉的和理由。排查"为什么没召回"时唯一有用的东西。 */
  dropped: { chunk: Chunk; why: string }[]
}

export function rerankHeuristic(query: string, cands: Scored[], opts: RerankOptions = {}): Reranked {
  const keep = opts.keep ?? 5
  const minScore = opts.minScore ?? 0.05
  const qToks = new Set(tokenize(query))

  const scored = cands.map((c) => {
    const toks = tokenize(indexText(c.chunk))
    const hit = new Set(toks.filter((t) => qToks.has(t)))
    // 三个信号：词覆盖率、两路都召回、片段不过长。
    const coverage = qToks.size === 0 ? 0 : hit.size / qToks.size
    const bonus = c.via === 'both' ? 0.15 : 0
    const lengthPenalty = Math.min(0.2, toks.length / 5000)
    // ★ 下限夹到 0：长度惩罚不该把一个"无关"的片段压成负分。
    // 负分会让 minScore=0 这个"什么都不过滤"的配置意外地过滤掉东西，
    // 而那种 bug 表现为"检索突然一片都不返回"，很难查。
    return { ...c, score: Math.max(0, coverage + bonus - lengthPenalty) }
  })

  scored.sort((a, b) => b.score - a.score)
  const kept = scored.filter((s) => s.score >= minScore).slice(0, keep)
  const keptIds = new Set(kept.map((k) => k.chunk.id))
  const dropped = scored
    .filter((s) => !keptIds.has(s.chunk.id))
    .map((s) => ({
      chunk: s.chunk,
      why: s.score < minScore ? `分数 ${s.score.toFixed(3)} 低于阈值 ${minScore}` : `排在第 ${keep} 名之后`,
    }))

  return { kept, dropped }
}

// ─────────────────────────────────────────────────────────────
// 该不该检索
// ─────────────────────────────────────────────────────────────

export type RetrievalMode = 'none' | 'lookup' | 'search' | 'agentic'

export interface RouteInput {
  /** 语料总量（chunk 数）。 */
  corpusSize: number
  /** 全部塞进上下文要多少 token（估算）。 */
  corpusTokens: number
  /** 上下文预算。 */
  budgetTokens: number
  /** 查询里有没有精确的标识符（错误码、函数名、文件名）。 */
  hasExactTerms: boolean
  /** 答案是不是"要找的东西本身不确定"（需要多轮探索）。 */
  needsExploration: boolean
}

export interface RouteDecision {
  mode: RetrievalMode
  why: string
}

/**
 * ★ 这个函数是这一节最重要的部分，理由和 L07 的 choosePattern 一样：
 * **大多数 RAG 系统的问题不是检索质量差，是压根不该上 RAG。**
 *
 * 判据的顺序是故意的——从最便宜的开始，够用就停。
 */
export function chooseRetrieval(i: RouteInput): RouteDecision {
  // 一 · 全塞得下就全塞。
  //
  // ★ 这条最容易被跳过，而它在 2026 年覆盖的场景比大多数人想的多。
  // 一个 20 万 token 的上下文窗口装得下一个中等项目的全部源码。
  //
  // 检索的收益是省钱和降延迟，代价是**可能漏掉相关内容**——
  // 而漏掉的那部分你不会知道。全塞进去没有这个风险。
  if (i.corpusTokens <= i.budgetTokens * 0.5) {
    return {
      mode: 'none',
      why: `语料只占预算的 ${((i.corpusTokens / i.budgetTokens) * 100).toFixed(0)}%，全塞进去。检索的唯一收益是省钱，代价是可能漏内容——而漏了你不知道`,
    }
  }

  // 二 · 有精确标识符且语料不大 → 直接查，不用向量。
  //
  // grep 在这个场景里**打败任何 embedding**：它精确、免费、
  // 而且它的失败是响亮的（找不到就是找不到，不会给你一个"最相似"的错答案）。
  if (i.hasExactTerms && !i.needsExploration && i.corpusSize < 50_000) {
    return {
      mode: 'lookup',
      why: '查询里有精确标识符。grep / 索引查表比向量检索更准更便宜，而且找不到时是响亮的失败',
    }
  }

  // 三 · 要找什么本身不确定 → agentic search。
  //
  // 这是 agent 真正比一次性检索强的场景：第一次搜的结果决定第二次搜什么。
  if (i.needsExploration) {
    return {
      mode: 'agentic',
      why: '要找什么取决于先找到什么。一次性检索的 query 是固定的，这里需要多轮，每轮的 query 由上一轮的结果决定',
    }
  }

  // 四 · 剩下的才是经典 RAG。
  return {
    mode: 'search',
    why: '语料超出预算、查询是自然语言、目标明确。混合检索加重排',
  }
}

// ─────────────────────────────────────────────────────────────
// 装配上下文
// ─────────────────────────────────────────────────────────────

export interface AssembleOptions {
  /** token 预算。 */
  budget: number
  /** 估算函数。默认沿用 L06 那套。 */
  estimate?: (s: string) => number
}

export interface Assembled {
  text: string
  used: Chunk[]
  /** 因为预算放不下而被砍掉的。**必须报出来**，见下。 */
  truncated: Chunk[]
  tokens: number
}

const defaultEstimate = (s: string) => {
  // 和 L06 一致：CJK 约 1 token/字，其余约 1 token/4 字符。
  const cjk = (s.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) ?? []).length
  return Math.ceil(cjk + (s.length - cjk) / 4)
}

/**
 * 把检索结果拼成给模型看的文本。
 *
 * ★ 三条硬规则，每一条都对应一类真实故障：
 *
 * 一 · **每个片段必须带出处和行号。** 否则模型没法给出可点击的引用，
 *      而不可验证的引用等于没有引用（用户没法确认，于是只能信）。
 *
 * 二 · **被预算砍掉的片段必须报出来。** 静默截断的后果是模型基于
 *      不完整的证据回答，而它不知道自己看的不完整，于是语气一样自信。
 *
 * 三 · **必须显式告诉模型"没有依据就说不知道"。** 光给材料不给这句话，
 *      模型会在材料不够时用它的先验知识补——而那正是 RAG 想避免的事。
 */
export function assemble(query: string, chunks: Chunk[], opts: AssembleOptions): Assembled {
  const estimate = opts.estimate ?? defaultEstimate
  const header = `<retrieved_context>
  <!-- 以下是检索到的片段。回答只能基于它们。
       ★ 如果这些片段不足以回答问题，直接说"检索到的内容里没有相关信息"，
       不要用你的先验知识补。宁可说不知道，不要编。 -->
`
  const footer = '</retrieved_context>'
  const budget = opts.budget - estimate(header + footer) - estimate(query)

  const used: Chunk[] = []
  const truncated: Chunk[] = []
  let spent = 0

  for (const c of chunks) {
    const block = renderChunk(c)
    const cost = estimate(block)
    if (spent + cost > budget) {
      truncated.push(c)
      continue
    }
    used.push(c)
    spent += cost
  }

  // ★ text 和 tokens 必须从同一个字符串算出来。
  // 分两次拼（一次给模型、一次给计数）是个很容易写出来的 bug：
  // 两边差一个换行你看不出来，而 tokens 从此不再等于真实开销——
  // 于是"预算是硬上限"这个保证悄悄地不成立了。
  const text = header + used.map(renderChunk).join('\n') + '\n' + footer
  return { text, used, truncated, tokens: estimate(text) }
}

function renderChunk(c: Chunk): string {
  const loc = `${c.source}:${c.lines[0]}-${c.lines[1]}`
  const path = c.path ? ` path="${c.path}"` : ''
  return `  <chunk src="${loc}"${path}>
${c.text
  .split('\n')
  .map((l) => '    ' + l)
  .join('\n')}
  </chunk>`
}

// ─────────────────────────────────────────────────────────────
// 引用校验
// ─────────────────────────────────────────────────────────────

export interface CitationCheck {
  cited: string[]
  /** 引用的文件压根不在检索结果里。最明显的一类幻觉引用。 */
  unknownSource: string[]
  /**
   * 文件对了但行号范围对不上。
   *
   * ★ **这一类比上一类更隐蔽，也更常见。** 文件名看着眼熟，
   * 于是 review 的人扫一眼就过了——而行号是模型凑的。
   */
  wrongRange: string[]
  /** 检索到但一次都没被引用的。它是"检索召回了噪声"的信号。 */
  unused: string[]
}

/**
 * 校验模型输出里的引用。
 *
 * ★ 这一步是 RAG 里唯一能**自动**判定的质量信号，所以它的价值
 * 远超它的代码量。
 *
 * 模型会编造引用——它会写 `src/auth.ts:120-140`，而那个文件根本
 * 不在检索结果里，或者行号是它凑的。而且**编出来的引用比编出来的
 * 内容更有害**：它让答案看起来可验证，于是没人去验证。
 *
 * 两类要分开报，因为它们对应两种不同的处置：
 *   unknownSource —— 模型在用先验知识。prompt 里的"不许编"没生效
 *   wrongRange    —— 模型看的是对的材料但引用格式没抄准。可以自动修
 */
export function checkCitations(answer: string, provided: Chunk[]): CitationCheck {
  const exact = new Set(provided.map((c) => `${c.source}:${c.lines[0]}-${c.lines[1]}`))
  const bySource = new Set(provided.map((c) => c.source))
  const cited = [...new Set(answer.match(/[\w./-]+\.\w+:\d+-\d+/g) ?? [])]

  const unknownSource: string[] = []
  const wrongRange: string[] = []
  for (const c of cited) {
    if (exact.has(c)) continue
    const src = c.slice(0, c.lastIndexOf(':'))
    if (bySource.has(src)) wrongRange.push(c)
    else unknownSource.push(c)
  }

  const usedSources = new Set(cited.map((c) => c.slice(0, c.lastIndexOf(':'))))
  const unused = provided.filter((c) => !usedSources.has(c.source)).map((c) => c.id)

  return { cited, unknownSource, wrongRange, unused }
}
