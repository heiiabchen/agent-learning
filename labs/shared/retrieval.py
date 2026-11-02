"""参考实现：检索（Python 版）。分块、向量、BM25、混合、重排、装配。

★ 这个文件里没有真的 embedding 模型调用。

不是偷懒。而是**检索质量的问题九成不在 embedding 上**，在分块、融合、
重排和"该不该检索"这四件事上。用一个确定性的假向量器，你能把那四件事
单独测出来——而接上真模型之后，这四件事的 bug 会被"模型效果"这个借口盖住。

真接 embedding 只是把 fake_embed 换成一次 HTTP 调用，剩下的代码一行都不用改。

和 TS 版的三处真实差异：

一 · **正则的 Unicode 语义不同。** Python 的 `\\w` 默认匹配中文，
     所以 TS 里 `[^a-z0-9\\u4e00-\\u9fa5]+` 那种"取反字符类"的写法搬过来
     行为会变。这里统一用**正向匹配**（findall 想要的东西），
     而不是 split 掉不想要的东西——正向匹配的行为在两种语言里一致。

二 · **math.hypot 在 3.8+ 才接受任意多个参数。** 而且对空序列返回 0.0，
     所以除零保护不能省。

三 · **dict 的插入序是语言保证的**（3.7+），所以 RRF 的累积器不需要
     额外排序就能稳定。TS 的 Map 也一样，但这一点在 Python 里是**规范**，
     在 TS 里只是 Map 的性质——换成普通对象就没了。
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Literal

# ─────────────────────────────────────────────────────────────
# 分块
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Chunk:
    id: str
    text: str
    #: 来源标识。**没有出处的片段不许进上下文**，理由和 L08 的 source 一样。
    source: str
    #: 在源文件里的行范围（1-based，闭区间）。引用要能点回去。
    lines: tuple[int, int]
    #: 结构路径，比如 "class Foo > method bar"。给模型定位用。
    path: str | None = None


def chunk_fixed(text: str, source: str, size: int = 800, overlap: int | None = None) -> list[Chunk]:
    """固定窗口分块。最简单的那种，也是**大多数人唯一实现的那种**。

    ★ 重叠不是调参，是补丁。

    固定窗口一定会在某个地方把一个完整的语义单元切成两半——一个函数的
    签名和函数体分家、一个 if 和它的 else 分家。重叠让被切断的那部分在
    两个块里都出现一次，于是至少有一个块是完整的。

    代价是**存储和检索成本按重叠比例上涨**，而且同一段内容会以两个不同的
    块被召回，占掉两个名额（所以后面必须去重）。
    """
    if overlap is None:
        overlap = int(size * 0.15)
    if overlap >= size:
        raise ValueError(f"overlap({overlap}) 必须小于 size({size})，否则永远推进不了")

    lines = text.split("\n")
    out: list[Chunk] = []
    cursor = 0  # 行号（0-based）
    n = 0

    while cursor < len(lines):
        chars = 0
        end = cursor
        while end < len(lines) and chars < size:
            chars += len(lines[end]) + 1
            end += 1
        n += 1
        out.append(
            Chunk(
                id=f"{source}#{n}",
                text="\n".join(lines[cursor:end]),
                source=source,
                lines=(cursor + 1, end),
            )
        )
        if end >= len(lines):
            break

        # 按字符数往回退，换算成行。
        back = end - 1
        back_chars = 0
        while back > cursor and back_chars < overlap:
            back_chars += len(lines[back]) + 1
            back -= 1
        cursor = max(cursor + 1, back)

    return out


# 只认顶层（不缩进）的声明。缩进的是成员，跟着父级走。
_TOP_LEVEL = re.compile(
    r"^(?:export\s+)?(?:async\s+)?"
    r"(?:function|class|interface|type|const|let|var|def|async def)\s+([A-Za-z_$][\w$]*)"
)


def chunk_by_structure(text: str, source: str, max_size: int = 1600) -> list[Chunk]:
    """结构感知分块。按代码的语法边界切，而不是按字符数。

    ★ 这是这一节最实用的一条：**对代码，结构分块的检索质量比调任何
    embedding 参数的收益都大。**

    因为代码的语义单元是显式的（函数、类、方法），而固定窗口对它们一无所知。
    一个被切成两半的函数在向量空间里既不像原函数、也不像任何别的东西——
    它是一个语义上的噪声。

    这里用一个很粗的正则当"语法"，真实项目应该用 tree-sitter。
    但**粗的结构信息也远好过没有结构信息**，这是重点。
    """
    lines = text.split("\n")
    starts = [
        i for i, line in enumerate(lines) if not re.match(r"^\s", line) and _TOP_LEVEL.match(line)
    ]

    # 一个结构都没识别出来：退回固定窗口，而不是返回空。
    #
    # ★ 这个降级必须是**可见的**——每一片都标上 path，
    # 这样你 dump 一遍分块结果就能看出哪些文件走了降级。
    #
    # 静默降级的后果是你以为在用结构分块，其实一半文件是固定窗口，
    # 而检索质量的差异会被归因到 embedding 上，然后你去调 embedding。
    if not starts:
        return [
            replace(c, path="(未识别结构，固定窗口降级)")
            for c in chunk_fixed(text, source, size=max_size)
        ]

    out: list[Chunk] = []
    n = 0

    # 第一个声明之前的内容（import、注释头）单独成块。
    if starts[0] > 0:
        n += 1
        out.append(
            Chunk(
                id=f"{source}#{n}",
                text="\n".join(lines[: starts[0]]),
                source=source,
                lines=(1, starts[0]),
                path="(文件头)",
            )
        )

    for i, start in enumerate(starts):
        to = starts[i + 1] if i + 1 < len(starts) else len(lines)
        body = "\n".join(lines[start:to])
        m = _TOP_LEVEL.match(lines[start])
        name = m.group(1) if m else "(匿名)"

        # 超大的结构（一个 800 行的类）还是要再切，但**每一片都带上 path**。
        # 这样模型知道"这是 Foo 类的第 2 片"，而不是一段无主的代码。
        if len(body) > max_size:
            pieces = chunk_fixed(body, source, size=max_size)
            for k, p in enumerate(pieces):
                n += 1
                out.append(
                    Chunk(
                        id=f"{source}#{n}",
                        text=p.text,
                        source=source,
                        lines=(start + p.lines[0], start + p.lines[1]),
                        path=f"{name} (第 {k + 1}/{len(pieces)} 片)",
                    )
                )
        else:
            n += 1
            out.append(
                Chunk(
                    id=f"{source}#{n}",
                    text=body,
                    source=source,
                    lines=(start + 1, to),
                    path=name,
                )
            )

    return out


# ─────────────────────────────────────────────────────────────
# 向量检索
# ─────────────────────────────────────────────────────────────


def fake_embed(text: str, dim: int = 64) -> list[float]:
    """确定性的假 embedding。

    把字符 3-gram 哈希到固定维度，然后归一化。它不懂语义，但它
    **确定、免费、而且对"字面重合"敏感**——足够把分块、融合、重排
    这三件事测出来。

    ★ 它有一个和真 embedding 完全一致的性质，而这个性质是这一节的一个
    关键论点：**它无法匹配同义但用词不同的内容。** 真 embedding 在这方面
    更好，但**远没有大多数人以为的那么好**——这就是为什么纯向量检索会在
    专有名词、错误码、变量名上大面积失手。

    ★ 用自己写的哈希而不是 hash()：Python 的内置 hash 对 str 加了随机盐
    （PYTHONHASHSEED），**同一段文本在两次进程里的向量是不一样的**。
    那会让索引一重启就失效，而且失效的方式是"检索结果变差了一点"。
    """
    v = [0.0] * dim
    s = text.lower()
    for i in range(len(s) - 2):
        gram = s[i : i + 3]
        h = 0
        for ch in gram:
            # 掩到 32 位有符号，和 TS 的 `| 0` 对齐。
            h = (h * 31 + ord(ch)) & 0xFFFFFFFF
        v[h % dim] += 1.0

    norm = math.hypot(*v) or 1.0
    return [x / norm for x in v]


def cosine(a: list[float], b: list[float]) -> float:
    """两边都已归一化，所以余弦就是点积。

    strict=True 不是形式主义：维度不一致的两个向量点积出来是个**看起来
    合理的数**，而它没有意义。换 embedding 模型的时候（768 维换 1536 维）
    你会撞上这个——静默的话表现为"检索质量突然变差"。
    """
    return sum(x * y for x, y in zip(a, b, strict=True))


Via = Literal["vector", "bm25", "both"]


@dataclass(frozen=True)
class Scored:
    chunk: Chunk
    score: float
    #: 哪一路召回的。**混合检索必须带这个**，否则你没法调权重。
    via: Via


def index_text(c: Chunk) -> str:
    """索引用的文本：把出处和结构路径拼在正文前面。

    ★ 这一行是很多人漏掉的，而它的影响很大：**文件路径本身是最强的检索
    信号之一。**「登录相关的代码在哪」这个问题，`src/login.ts` 这个路径比
    文件内容更有指示性——而如果只索引正文，你压根搜不到它。
    """
    return f"{c.source} {c.path or ''}\n{c.text}"


class VectorIndex:
    def __init__(self, embed: Callable[[str], list[float]] = fake_embed) -> None:
        self._embed = embed
        self._items: list[tuple[Chunk, list[float]]] = []

    def add(self, chunks: list[Chunk]) -> None:
        for c in chunks:
            self._items.append((c, self._embed(index_text(c))))

    def search(self, query: str, k: int) -> list[Scored]:
        q = self._embed(query)
        hits = [Scored(chunk=c, score=cosine(q, v), via="vector") for c, v in self._items]
        hits.sort(key=lambda s: -s.score)
        return hits[:k]

    @property
    def size(self) -> int:
        return len(self._items)


# ─────────────────────────────────────────────────────────────
# 关键词检索（BM25）
# ─────────────────────────────────────────────────────────────

# ★ 两个都不能省的处理，见下面 tokenize 的注释。
#
# Python 的正则里 `\w` 默认是 Unicode 语义（中文算 \w），所以这里必须
# **显式写出想要的字符类**，而不能靠 `\W+` 取反去 split——
# 那种写法在 TS 里能用，搬到 Python 会静默地把中文当成一个词。
_TOKEN = re.compile(r"[a-z0-9]+|[\u4e00-\u9fa5\u3040-\u30ff]+")
_CAMEL = re.compile(r"([a-z\d])([A-Z])")


def tokenize(s: str) -> list[str]:
    """分词。

    ★ BM25 在代码检索上常常**打败**向量检索，而这一点很反直觉。

    理由是代码里最关键的词是**专有名词**：函数名、变量名、错误码、配置项。
    它们的语义完全来自约定而不是语言——`useCallback` 和 `useMemo`
    在向量空间里非常近，而它们是两个不同的东西。

    而 BM25 是精确的字面匹配加上两个统计修正：
        IDF     —— 罕见词权重高。ENOENT 比 error 有信息量
        长度归一 —— 长文档不因为词多而占便宜

    所以正确的问题从来不是"用向量还是用关键词"，是**怎么把两路合起来**。

    两个不能省的处理：

    一 · **驼峰要切开。** get_user_by_id / getUserById → get user by id。
         不切的话搜 "user id" 匹配不到 getUserById，
         而这是代码检索里最常见的一类查询。

    二 · **中文要切成字加二元组。** 中文没有空白，按空白分词的结果是
         「登录偶尔失败用户说点了没反应」变成**一个** token——
         于是它匹配不到任何东西，而 BM25 会安静地返回空列表。

         这是中文检索里最经典的静默失效：代码没报错、索引也建起来了，
         只是搜什么都搜不到。而单字的区分度太低（"的"、"是" 到处都有），
         所以还要加二元组："登录" 这个二元组比 "登" 加 "录" 有信息量得多。
    """
    out: list[str] = []
    norm = _CAMEL.sub(r"\1 \2", s).lower()
    for m in _TOKEN.finditer(norm):
        t = m.group(0)
        if t.isascii():
            out.append(t)
            continue
        for i, ch in enumerate(t):
            out.append(ch)
            if i + 1 < len(t):
                out.append(t[i : i + 2])
    return out


class Bm25Index:
    def __init__(self, k1: float = 1.5, b: float = 0.75) -> None:
        self._k1 = k1
        self._b = b
        self._docs: list[tuple[Chunk, Counter[str], int]] = []
        self._df: Counter[str] = Counter()

    def add(self, chunks: list[Chunk]) -> None:
        for c in chunks:
            toks = tokenize(index_text(c))
            tf = Counter(toks)
            self._df.update(tf.keys())
            self._docs.append((c, tf, len(toks)))

    def search(self, query: str, k: int) -> list[Scored]:
        if not self._docs:
            return []
        n_docs = len(self._docs)
        avg_len = sum(d[2] for d in self._docs) / n_docs
        q_toks = list(dict.fromkeys(tokenize(query)))

        hits: list[Scored] = []
        for chunk, tf, length in self._docs:
            score = 0.0
            for t in q_toks:
                f = tf.get(t, 0)
                if not f:
                    continue
                n = self._df.get(t, 0)
                # 加 0.5 平滑，避免 df 等于文档总数时 IDF 变成 0 或负数。
                idf = math.log(1 + (n_docs - n + 0.5) / (n + 0.5))
                denom = f + self._k1 * (1 - self._b + self._b * length / avg_len)
                score += idf * (f * (self._k1 + 1)) / denom
            if score > 0:
                hits.append(Scored(chunk=chunk, score=score, via="bm25"))

        hits.sort(key=lambda s: -s.score)
        return hits[:k]

    @property
    def size(self) -> int:
        return len(self._docs)


# ─────────────────────────────────────────────────────────────
# 融合
# ─────────────────────────────────────────────────────────────


def rrf(lists: list[list[Scored]], k: int = 60, limit: int = 10) -> list[Scored]:
    """倒数排名融合（RRF）。

    ★ 为什么不能直接把两路的分数加起来（或者加权平均）：

    **两路的分数不在同一个量纲上，而且它们的分布形状完全不同。**
    余弦相似度挤在 0.7 到 0.95 之间（差异极小），BM25 是 0 到几十的长尾。
    相加的结果是 BM25 完全支配，向量那一路等于没有。

    归一化能缓解但不解决：min-max 归一化对离群值极其敏感，
    而 BM25 的最高分**天生就是离群值**（那正是精确命中）。

    RRF 只用排名，于是量纲问题从根上消失了：

        score(d) = Σ 1 / (k + rank_i(d))

    k 是个平滑常数（惯例 60）。它的作用是**压低头部的权重差**：
    没有 k 的话第 1 名和第 2 名的分差是 0.5，有 k 的话是 0.0003。
    这让"两路都排进前十"胜过"一路排第一另一路没召回"——
    而这正是混合检索想要的行为。
    """
    acc: dict[str, tuple[Chunk, float, set[str]]] = {}
    for lst in lists:
        for i, s in enumerate(lst):
            chunk, score, vias = acc.get(s.chunk.id, (s.chunk, 0.0, set()))
            vias.add(s.via)
            acc[s.chunk.id] = (chunk, score + 1 / (k + i + 1), vias)

    out = [
        Scored(
            chunk=chunk,
            score=score,
            via="both" if len(vias) > 1 else next(iter(vias)),  # type: ignore[arg-type]
        )
        for chunk, score, vias in acc.values()
    ]
    out.sort(key=lambda s: -s.score)
    return out[:limit]


@dataclass
class Reranked:
    kept: list[Scored] = field(default_factory=list)
    #: 丢掉的和理由。排查"为什么没召回"时唯一有用的东西。
    dropped: list[tuple[Chunk, str]] = field(default_factory=list)


def rerank_heuristic(
    query: str,
    cands: list[Scored],
    keep: int = 5,
    min_score: float = 0.05,
) -> Reranked:
    """重排。

    ★ 重排是**性价比最高的一步**，而它常常被跳过。

    理由是检索和重排在做两件不同的事：
        检索  —— 从一万个里捞出五十个。要快，所以只能看粗特征
        重排  —— 从五十个里挑出五个。可以慢，所以能看细特征

    真实的重排器是一个 cross-encoder（把 query 和文档拼在一起过一遍模型），
    或者直接让 LLM 打分。这里用一个确定性的启发式打分器，它演示的是
    **重排的形状**：全部候选进去，少数几个出来，而且**丢掉的那些要能
    说出为什么丢**。
    """
    q_toks = set(tokenize(query))

    scored: list[Scored] = []
    for c in cands:
        toks = tokenize(index_text(c.chunk))
        hit = {t for t in toks if t in q_toks}
        # 三个信号：词覆盖率、两路都召回、片段不过长。
        coverage = 0.0 if not q_toks else len(hit) / len(q_toks)
        bonus = 0.15 if c.via == "both" else 0.0
        length_penalty = min(0.2, len(toks) / 5000)
        # ★ 下限夹到 0：长度惩罚不该把一个"无关"的片段压成负分。
        # 负分会让 min_score=0 这个"什么都不过滤"的配置意外地过滤掉东西，
        # 而那种 bug 表现为"检索突然一片都不返回"，很难查。
        scored.append(replace(c, score=max(0.0, coverage + bonus - length_penalty)))

    scored.sort(key=lambda s: -s.score)
    kept = [s for s in scored if s.score >= min_score][:keep]
    kept_ids = {s.chunk.id for s in kept}
    dropped = [
        (
            s.chunk,
            f"分数 {s.score:.3f} 低于阈值 {min_score}"
            if s.score < min_score
            else f"排在第 {keep} 名之后",
        )
        for s in scored
        if s.chunk.id not in kept_ids
    ]
    return Reranked(kept=kept, dropped=dropped)


# ─────────────────────────────────────────────────────────────
# 该不该检索
# ─────────────────────────────────────────────────────────────

RetrievalMode = Literal["none", "lookup", "search", "agentic"]


@dataclass(frozen=True)
class RouteInput:
    #: 语料总量（chunk 数）。
    corpus_size: int
    #: 全部塞进上下文要多少 token（估算）。
    corpus_tokens: int
    #: 上下文预算。
    budget_tokens: int
    #: 查询里有没有精确的标识符（错误码、函数名、文件名）。
    has_exact_terms: bool
    #: 答案是不是"要找的东西本身不确定"（需要多轮探索）。
    needs_exploration: bool


@dataclass(frozen=True)
class RouteDecision:
    mode: RetrievalMode
    why: str


def choose_retrieval(i: RouteInput) -> RouteDecision:
    """★ 这个函数是这一节最重要的部分，理由和 L07 的 choose_pattern 一样：
    **大多数 RAG 系统的问题不是检索质量差，是压根不该上 RAG。**

    判据的顺序是故意的——从最便宜的开始，够用就停。
    """
    # 一 · 全塞得下就全塞。
    #
    # ★ 这条最容易被跳过，而它在 2026 年覆盖的场景比大多数人想的多。
    # 一个 20 万 token 的上下文窗口装得下一个中等项目的全部源码。
    #
    # 检索的收益是省钱和降延迟，代价是**可能漏掉相关内容**——
    # 而漏掉的那部分你不会知道。全塞进去没有这个风险。
    if i.corpus_tokens <= i.budget_tokens * 0.5:
        pct = i.corpus_tokens / i.budget_tokens * 100
        return RouteDecision(
            mode="none",
            why=(
                f"语料只占预算的 {pct:.0f}%，全塞进去。"
                "检索的唯一收益是省钱，代价是可能漏内容——而漏了你不知道"
            ),
        )

    # 二 · 有精确标识符且语料不大 → 直接查，不用向量。
    #
    # grep 在这个场景里**打败任何 embedding**：它精确、免费，
    # 而且它的失败是响亮的（找不到就是找不到，不会给你一个"最相似"的错答案）。
    if i.has_exact_terms and not i.needs_exploration and i.corpus_size < 50_000:
        return RouteDecision(
            mode="lookup",
            why=(
                "查询里有精确标识符。grep / 索引查表比向量检索更准更便宜，而且找不到时是响亮的失败"
            ),
        )

    # 三 · 要找什么本身不确定 → agentic search。
    #
    # 这是 agent 真正比一次性检索强的场景：第一次搜的结果决定第二次搜什么。
    if i.needs_exploration:
        return RouteDecision(
            mode="agentic",
            why=(
                "要找什么取决于先找到什么。一次性检索的 query 是固定的，"
                "这里需要多轮，每轮的 query 由上一轮的结果决定"
            ),
        )

    # 四 · 剩下的才是经典 RAG。
    return RouteDecision(
        mode="search",
        why="语料超出预算、查询是自然语言、目标明确。混合检索加重排",
    )


# ─────────────────────────────────────────────────────────────
# 装配上下文
# ─────────────────────────────────────────────────────────────


@dataclass
class Assembled:
    text: str
    used: list[Chunk] = field(default_factory=list)
    #: 因为预算放不下而被砍掉的。**必须报出来**，见下。
    truncated: list[Chunk] = field(default_factory=list)
    tokens: int = 0


_CJK = re.compile(r"[\u4e00-\u9fa5\u3040-\u30ff]")


def default_estimate(s: str) -> int:
    """和 L06 一致：CJK 约 1 token/字，其余约 1 token/4 字符。"""
    cjk = len(_CJK.findall(s))
    return math.ceil(cjk + (len(s) - cjk) / 4)


_HEADER = """<retrieved_context>
  <!-- 以下是检索到的片段。回答只能基于它们。
       ★ 如果这些片段不足以回答问题，直接说"检索到的内容里没有相关信息"，
       不要用你的先验知识补。宁可说不知道，不要编。 -->
"""
_FOOTER = "</retrieved_context>"


def _render_chunk(c: Chunk) -> str:
    loc = f"{c.source}:{c.lines[0]}-{c.lines[1]}"
    path = f' path="{c.path}"' if c.path else ""
    body = "\n".join("    " + line for line in c.text.split("\n"))
    return f'  <chunk src="{loc}"{path}>\n{body}\n  </chunk>'


def assemble(
    query: str,
    chunks: list[Chunk],
    budget: int,
    estimate: Callable[[str], int] = default_estimate,
) -> Assembled:
    """把检索结果拼成给模型看的文本。

    ★ 三条硬规则，每一条都对应一类真实故障：

    一 · **每个片段必须带出处和行号。** 否则模型没法给出可点击的引用，
         而不可验证的引用等于没有引用（用户没法确认，于是只能信）。

    二 · **被预算砍掉的片段必须报出来。** 静默截断的后果是模型基于
         不完整的证据回答，而它不知道自己看的不完整，于是语气一样自信。

    三 · **必须显式告诉模型"没有依据就说不知道"。** 光给材料不给这句话，
         模型会在材料不够时用它的先验知识补——而那正是 RAG 想避免的事。
    """
    room = budget - estimate(_HEADER + _FOOTER) - estimate(query)

    used: list[Chunk] = []
    truncated: list[Chunk] = []
    spent = 0

    for c in chunks:
        cost = estimate(_render_chunk(c))
        if spent + cost > room:
            truncated.append(c)
            continue
        used.append(c)
        spent += cost

    # ★ text 和 tokens 必须从同一个字符串算出来。
    # 分两次拼（一次给模型、一次给计数）是个很容易写出来的 bug：
    # 两边差一个换行你看不出来，而 tokens 从此不再等于真实开销——
    # 于是"预算是硬上限"这个保证悄悄地不成立了。
    text = _HEADER + "\n".join(_render_chunk(c) for c in used) + "\n" + _FOOTER
    return Assembled(text=text, used=used, truncated=truncated, tokens=estimate(text))


# ─────────────────────────────────────────────────────────────
# 引用校验
# ─────────────────────────────────────────────────────────────


@dataclass
class CitationCheck:
    cited: list[str] = field(default_factory=list)
    #: 引用的文件压根不在检索结果里。最明显的一类幻觉引用。
    unknown_source: list[str] = field(default_factory=list)
    #: 文件对了但行号范围对不上。
    #:
    #: ★ **这一类比上一类更隐蔽，也更常见。** 文件名看着眼熟，
    #: 于是 review 的人扫一眼就过了——而行号是模型凑的。
    wrong_range: list[str] = field(default_factory=list)
    #: 检索到但一次都没被引用的。它是"检索召回了噪声"的信号。
    unused: list[str] = field(default_factory=list)


_CITATION = re.compile(r"[\w./-]+\.\w+:\d+-\d+")


def check_citations(answer: str, provided: list[Chunk]) -> CitationCheck:
    """校验模型输出里的引用。

    ★ 这一步是 RAG 里唯一能**自动**判定的质量信号，所以它的价值
    远超它的代码量。

    模型会编造引用——它会写 `src/auth.ts:120-140`，而那个文件根本不在
    检索结果里，或者行号是它凑的。而且**编出来的引用比编出来的内容更有害**：
    它让答案看起来可验证，于是没人去验证。

    两类要分开报，因为它们对应两种不同的处置：
        unknown_source —— 模型在用先验知识。prompt 里的"不许编"没生效
        wrong_range    —— 模型看的是对的材料但引用格式没抄准。可以自动修
    """
    exact = {f"{c.source}:{c.lines[0]}-{c.lines[1]}" for c in provided}
    by_source = {c.source for c in provided}
    cited = list(dict.fromkeys(_CITATION.findall(answer)))

    unknown_source: list[str] = []
    wrong_range: list[str] = []
    for c in cited:
        if c in exact:
            continue
        src = c.rsplit(":", 1)[0]
        (wrong_range if src in by_source else unknown_source).append(c)

    used_sources = {c.rsplit(":", 1)[0] for c in cited}
    unused = [c.id for c in provided if c.source not in used_sources]

    return CitationCheck(
        cited=cited,
        unknown_source=unknown_source,
        wrong_range=wrong_range,
        unused=unused,
    )
