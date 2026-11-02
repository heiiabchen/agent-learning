"""L09 任务一：分块、检索、融合、重排、装配（Python 版）。

    uv run python -m l09.retrieve

不调 API——**包括不调 embedding**。参考实现在 shared/retrieval.py。

★ 为什么用假 embedding：

检索质量的问题九成不在 embedding 上，在**分块、融合、重排、以及
"该不该检索"**这四件事上。用一个确定性的假向量器，你能把这四件事单独
测出来——而接上真模型之后，这四件事的 bug 会被"模型效果"这个借口盖住。

换成真 embedding 只是把 fake_embed 换成一次 HTTP 调用，剩下的代码
一行都不用改。

Python 通道有三个和 TS 版不一样的坑，都在 TODO 里标出来了：
正则的 Unicode 语义、内置 hash() 的随机盐、math.hypot 对空序列。
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

# ─────────────────────────────────────────────────────────────
# 类型（已给）
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Chunk:
    id: str
    text: str
    #: **没有出处的片段不许进上下文**，理由和 L08 的 source 一样。
    source: str
    #: 1-based 闭区间。
    lines: tuple[int, int]
    path: str | None = None


Via = Literal["vector", "bm25", "both"]


@dataclass(frozen=True)
class Scored:
    chunk: Chunk
    score: float
    #: 哪一路召回的。**混合检索必须带这个**，否则你没法调权重。
    via: Via


# ─────────────────────────────────────────────────────────────
# TODO 1：固定窗口分块
#
# ★ 重叠不是调参，是补丁。
#
# 固定窗口一定会在某个地方把一个完整的语义单元切成两半——
# 一个函数的签名和函数体分家、一个 if 和它的 else 分家。
# 重叠让被切断的那部分在两个块里都出现一次，于是至少有一个块是完整的。
#
# 代价是存储和检索成本按重叠比例上涨，而且同一段内容会以两个不同的块
# 被召回，占掉两个名额（所以后面必须去重）。
#
# 按行切而不是按字符切——切在字符中间会把标识符切断，
# 而被切断的标识符在两路检索里都是纯噪声。
#
# ★ overlap >= size 要抛错。不然循环永远推进不了，表现为进程卡死，
# 而卡死比报错难查得多。
#
# overlap 默认取 size 的 15%（None 表示"没传"，不是"传了 0"——
# 这两件事要分开，因为 overlap=0 是一个合法的显式选择）。
# ─────────────────────────────────────────────────────────────


def chunk_fixed(text: str, source: str, size: int = 800, overlap: int | None = None) -> list[Chunk]:
    raise NotImplementedError("TODO: 实现 chunk_fixed")


# ─────────────────────────────────────────────────────────────
# TODO 2：结构感知分块
#
# ★ 这是这一节最实用的一条：**对代码，结构分块的检索质量提升
# 比调任何 embedding 参数的收益都大。**
#
# 因为代码的语义单元是显式的（函数、类、方法），而固定窗口对它们
# 一无所知。一个被切成两半的函数在向量空间里既不像原函数、
# 也不像任何别的东西——它是一个语义上的噪声。
#
# 用一个粗正则当"语法"就够（真实项目用 tree-sitter）。
# **粗的结构信息也远好过没有结构信息**，这是重点。
#
# 三个细节：
#   · 只认顶层（不缩进）的声明。缩进的是成员，跟着父级走
#   · 第一个声明之前的内容（import、注释头）单独成块
#   · 超大的结构还要再切，但**每一片都要带 path**
#     （"这是 Foo 类的第 2/3 片" vs 一段无主的代码）
#
# ★ 一个结构都没识别出来时退回固定窗口，但**要让降级可见**——
# 给每一片标上 path。静默降级的后果是你以为在用结构分块，
# 其实一半文件是固定窗口，而质量差异会被归因到 embedding 上。
#
# Chunk 是 frozen dataclass，改字段用 dataclasses.replace。
# ─────────────────────────────────────────────────────────────

TOP_LEVEL = re.compile(
    r"^(?:export\s+)?(?:async\s+)?"
    r"(?:function|class|interface|type|const|let|var|def|async def)\s+([A-Za-z_$][\w$]*)"
)


def chunk_by_structure(text: str, source: str, max_size: int = 1600) -> list[Chunk]:
    raise NotImplementedError("TODO: 实现 chunk_by_structure")


# ─────────────────────────────────────────────────────────────
# TODO 3：假 embedding 与向量检索
#
# fake_embed：把字符 3-gram 哈希到固定维度，然后归一化。
#
# 它不懂语义，但它确定、免费、而且对"字面重合"敏感——
# 足够把分块、融合、重排这三件事测出来。
#
# ★ 它有一个和真 embedding 完全一致的性质，而这个性质是这一节的
# 一个关键论点：**它无法匹配同义但用词不同的内容。**
#
# 真 embedding 在这方面更好，但**远没有大多数人以为的那么好**——
# 这就是为什么纯向量检索会在专有名词、错误码、变量名上大面积失手。
#
# ★ Python 坑一：**别用内置的 hash()。** 它对 str 加了随机盐
# （PYTHONHASHSEED），同一段文本在两次进程里的向量不一样。
# 那会让索引一重启就失效，而且失效的方式是"检索结果变差了一点"——
# 没有报错，没有告警，只是慢慢地不对了。自己写个 31 进制的滚动哈希。
#
# ★ Python 坑二：**math.hypot() 对空序列返回 0.0。** 归一化的时候
# 除零保护不能省（空文本、极短文本都会走到）。
#
# 归一化之后余弦相似度就是点积。
#
# ★ 索引的时候别只索引正文，**把 source 和 path 拼在正文前面**
# （下面的 index_text）。文件路径是最强的检索信号之一——
# 「登录相关的代码在哪」这个问题，src/login.py 这个路径比文件内容
# 更有指示性，而只索引正文的话你压根搜不到它。
# ─────────────────────────────────────────────────────────────


def index_text(c: Chunk) -> str:
    """索引用的文本：出处 + 结构路径 + 正文。两个索引都该用它。"""
    raise NotImplementedError("TODO: 实现 index_text")


def fake_embed(text: str, dim: int = 64) -> list[float]:
    raise NotImplementedError("TODO: 实现 fake_embed")


def cosine(a: list[float], b: list[float]) -> float:
    raise NotImplementedError("TODO: 实现 cosine")


class VectorIndex:
    def __init__(self, embed: Callable[[str], list[float]] = fake_embed) -> None:
        raise NotImplementedError("TODO: 实现 VectorIndex")

    def add(self, chunks: list[Chunk]) -> None:
        raise NotImplementedError("TODO: 实现 VectorIndex.add")

    def search(self, query: str, k: int) -> list[Scored]:
        raise NotImplementedError("TODO: 实现 VectorIndex.search")

    @property
    def size(self) -> int:
        raise NotImplementedError("TODO: 实现 VectorIndex.size")


# ─────────────────────────────────────────────────────────────
# TODO 4：分词与 BM25
#
# ★ BM25 在代码检索上常常**打败**向量检索，而这一点很反直觉。
#
# 理由是代码里最关键的词是**专有名词**：函数名、变量名、错误码、
# 配置项。它们的语义完全来自约定而不是语言——`useCallback` 和
# `useMemo` 在向量空间里非常近，而它们是两个不同的东西。
#
# BM25 是精确字面匹配加两个统计修正：
#   IDF     —— 罕见词权重高。ENOENT 比 error 有信息量
#   长度归一 —— 长文档不因为词多而占便宜
#
# ★ tokenize 里有两件不能省的事：
#
# 一 · **驼峰要切开。** getUserById → get user by id。
#      不切的话搜 "user id" 匹配不到 getUserById。下划线、路径同理。
#
# 二 · **中文要切成单字加二元组。** 中文没有空白，按空白分词的结果是
#      「登录偶尔失败用户说点了没反应」变成**一个** token——
#      于是它匹配不到任何东西，而 BM25 会安静地返回空列表。
#
#      ★ 这是中文检索里最经典的静默失效：代码不报错、索引也建起来了，
#      只是搜什么都搜不到。而单字的区分度太低（"的"、"是" 到处都有），
#      所以还要加二元组——"登录" 比 "登" 加 "录" 有信息量得多。
#
# ★ Python 坑三：**`\\w` 和 `\\W` 在 Python 里默认是 Unicode 语义**，
# 中文算 `\\w`。所以 TS 那种"用 `[^a-z0-9]+` 取反去 split"的写法搬过来
# 行为会变。用**正向 finditer** 匹配你想要的字符类，别用 split 取反——
# 正向匹配的行为在两种语言里一致。
#
# 公式（k1=1.5, b=0.75 是惯例）：
#
#     idf = ln(1 + (N - df + 0.5) / (df + 0.5))
#     score += idf * (f * (k1+1)) / (f + k1 * (1 - b + b * len/avg_len))
#
# idf 里那两个 0.5 是平滑项，作用是避免 df 等于文档总数时
# IDF 变成 0 或负数——**负 IDF 会让"每个文档都有的词"反向扣分**，
# 而那是没有依据的。
#
# collections.Counter 很适合当 tf 和 df。
# ─────────────────────────────────────────────────────────────


def tokenize(s: str) -> list[str]:
    raise NotImplementedError("TODO: 实现 tokenize")


class Bm25Index:
    def __init__(self, k1: float = 1.5, b: float = 0.75) -> None:
        raise NotImplementedError("TODO: 实现 Bm25Index")

    def add(self, chunks: list[Chunk]) -> None:
        raise NotImplementedError("TODO: 实现 Bm25Index.add")

    def search(self, query: str, k: int) -> list[Scored]:
        raise NotImplementedError("TODO: 实现 Bm25Index.search")

    @property
    def size(self) -> int:
        raise NotImplementedError("TODO: 实现 Bm25Index.size")


# ─────────────────────────────────────────────────────────────
# TODO 5：倒数排名融合（RRF）
#
# ★ 为什么不能直接把两路的分数加起来（或者加权平均）：
#
# **两路的分数不在同一个量纲上，而且分布形状完全不同。**
# 余弦相似度挤在 0.7 到 0.95 之间（差异极小），BM25 是 0 到几十
# 的长尾。相加的结果是 BM25 完全支配，向量那一路等于没有。
#
# 归一化能缓解但不解决：min-max 归一化对离群值极其敏感，
# 而 BM25 的最高分**天生就是离群值**（那正是精确命中）。
#
# RRF 只用排名，量纲问题从根上消失：
#
#     score(d) = Σ 1 / (k + rank_i(d))
#
# k 惯例取 60。它的作用是**压低头部的权重差**：没有 k 的话
# 第 1 名和第 2 名的分差是 0.5，有 k 的话是 0.0003。
# 这让"两路都排进前十"胜过"一路排第一另一路没召回"——
# 而这正是混合检索想要的行为。
#
# ★ 同一个 chunk 被两路都召回时，via 要标成 "both"。
# 这个字段是重排的一个信号，也是你调权重时唯一能看的东西。
# ─────────────────────────────────────────────────────────────


def rrf(lists: list[list[Scored]], k: int = 60, limit: int = 10) -> list[Scored]:
    raise NotImplementedError("TODO: 实现 rrf")


# ─────────────────────────────────────────────────────────────
# TODO 6：重排
#
# ★ 重排是**性价比最高的一步**，而它常常被跳过。
#
# 检索和重排在做两件不同的事：
#   检索 —— 从一万个里捞出五十个。要快，只能看粗特征
#   重排 —— 从五十个里挑出五个。可以慢，能看细特征
#
# 真实的重排器是 cross-encoder 或者直接让 LLM 打分。这里用一个
# 确定性的启发式，它演示的是**重排的形状**：全部候选进去，
# 少数几个出来，而且**丢掉的那些要能说出为什么丢**。
#
# 三个信号：词覆盖率、两路都召回（via="both"）加分、片段过长扣分。
#
# ★ 三件必须做对的事：
#
# 一 · **要有 min_score 闸。** 没有阈值的"重排"只是重新排序，
#      而排序不解决"召回的全是噪声"这个问题。
#
# 二 · **dropped 要带理由。** 排查"为什么这段代码没被用上"时，
#      这是唯一有用的东西。没有它你只能瞎调参数。
#
# 三 · **分数下限夹到 0。** 长度惩罚不该把一个"无关"的片段压成负分。
#      负分会让 min_score=0（"什么都不过滤"）这个配置意外地过滤掉东西，
#      而那种 bug 表现为"检索突然一片都不返回"，很难查。
# ─────────────────────────────────────────────────────────────


@dataclass
class Reranked:
    kept: list[Scored] = field(default_factory=list)
    dropped: list[tuple[Chunk, str]] = field(default_factory=list)


def rerank_heuristic(
    query: str, cands: list[Scored], keep: int = 5, min_score: float = 0.05
) -> Reranked:
    raise NotImplementedError("TODO: 实现 rerank_heuristic")


# ─────────────────────────────────────────────────────────────
# TODO 7：该不该检索
#
# ★ 这个函数是这一节最重要的部分，理由和 L07 的 choose_pattern 一样：
# **大多数 RAG 系统的问题不是检索质量差，是压根不该上 RAG。**
#
# 判据的顺序要从最便宜的开始，够用就停：
#
# 一 · "none" —— 语料占预算不到一半就全塞进去
#
#      ★ 这条最容易被跳过，而它在 2026 年覆盖的场景比大多数人想的多。
#      一个 20 万 token 的窗口装得下一个中等项目的全部源码。
#      检索的收益是省钱和降延迟，代价是**可能漏掉相关内容**，
#      而漏掉的那部分你不会知道。全塞进去没有这个风险。
#
# 二 · "lookup" —— 有精确标识符、不需要探索、语料不算太大
#
#      grep 在这个场景里**打败任何 embedding**：它精确、免费，
#      而且它的失败是响亮的（找不到就是找不到，不会给你一个
#      "最相似"的错答案）。
#
# 三 · "agentic" —— 要找什么本身取决于先找到什么
#
#      这是 agent 真正比一次性检索强的场景：第一次搜的结果
#      决定第二次搜什么。
#
# 四 · "search" —— 剩下的才是经典 RAG
#
# ★ 每个分支都要返回 why。理由和 L07 的 choose_pattern 一样：
# **判据要能被 review，而不能只被执行。**
# ─────────────────────────────────────────────────────────────

RetrievalMode = Literal["none", "lookup", "search", "agentic"]


@dataclass(frozen=True)
class RouteInput:
    corpus_size: int
    corpus_tokens: int
    budget_tokens: int
    has_exact_terms: bool
    needs_exploration: bool


@dataclass(frozen=True)
class RouteDecision:
    mode: RetrievalMode
    why: str


def choose_retrieval(i: RouteInput) -> RouteDecision:
    raise NotImplementedError("TODO: 实现 choose_retrieval")


# ─────────────────────────────────────────────────────────────
# TODO 8：装配上下文
#
# ★ 三条硬规则，每一条对应一类真实故障：
#
# 一 · **每个片段必须带出处和行号。** 否则模型没法给出可点击的引用，
#      而不可验证的引用等于没有引用（用户没法确认，于是只能信）。
#
# 二 · **被预算砍掉的片段必须报出来（truncated）。** 静默截断的
#      后果是模型基于不完整的证据回答，而它不知道自己看的不完整，
#      **于是语气一样自信**。
#
# 三 · **必须显式写上"没有依据就说不知道"。** 光给材料不给这句话，
#      模型会在材料不够时用它的先验知识补——而那正是 RAG 想避免的事。
#
# 用 XML 标签包（L03）。预算里要扣掉 header/footer 和 query 本身。
#
# ★ text 和 tokens 要从**同一个字符串**算出来。分两次拼（一次给模型、
# 一次给计数）是个很容易写出来的 bug：两边差一个换行你看不出来，
# 而 tokens 从此不再等于真实开销——"预算是硬上限"这个保证就悄悄地
# 不成立了。
#
# 估算沿用 L06 那套：CJK 约 1 token/字，其余约 1 token/4 字符。
# ─────────────────────────────────────────────────────────────


@dataclass
class Assembled:
    text: str
    used: list[Chunk] = field(default_factory=list)
    truncated: list[Chunk] = field(default_factory=list)
    tokens: int = 0


def default_estimate(s: str) -> int:
    raise NotImplementedError("TODO: 实现 default_estimate")


def assemble(
    query: str,
    chunks: list[Chunk],
    budget: int,
    estimate: Callable[[str], int] = default_estimate,
) -> Assembled:
    raise NotImplementedError("TODO: 实现 assemble")


# ─────────────────────────────────────────────────────────────
# TODO 9：引用校验
#
# ★ 这一步是 RAG 里唯一能**自动**判定的质量信号，所以它的价值
# 远超它的代码量。
#
# 模型会编造引用——它会写 src/auth.py:120-140，而那个文件根本
# 不在检索结果里，或者行号是它凑的。而且**编出来的引用比编出来的
# 内容更有害**：它让答案看起来可验证，于是没人去验证。
#
# 两类要分开报，因为处置方式不同：
#   unknown_source —— 模型在用先验知识。prompt 里的"不许编"没生效
#   wrong_range    —— 看的是对的材料但引用格式没抄准。可以自动修
#
# 第二类**更隐蔽也更常见**：文件名看着眼熟，review 的人扫一眼就过了。
#
# 还要报 unused——检索到但一次都没被引用的片段。
# 它是"召回了噪声"的信号，也是调 keep 的依据。
# ─────────────────────────────────────────────────────────────


@dataclass
class CitationCheck:
    cited: list[str] = field(default_factory=list)
    unknown_source: list[str] = field(default_factory=list)
    wrong_range: list[str] = field(default_factory=list)
    unused: list[str] = field(default_factory=list)


def check_citations(answer: str, provided: list[Chunk]) -> CitationCheck:
    raise NotImplementedError("TODO: 实现 check_citations")


# ─────────────────────────────────────────────────────────────
# 观察实验
# ─────────────────────────────────────────────────────────────

SAMPLE = """import hashlib

# 会话令牌的签发与校验。
class TokenPayload:
    user_id: str
    expires_at: float


def sign_token(payload: dict, secret: str) -> str:
    body = json.dumps(payload, sort_keys=True)
    sig = hashlib.sha256((body + secret).encode()).hexdigest()
    return b64encode(body.encode()).decode() + "." + sig


def verify_token(token: str, secret: str) -> dict | None:
    b64, _, sig = token.partition(".")
    if not b64 or not sig:
        return None
    body = b64decode(b64).decode()
    expect = hashlib.sha256((body + secret).encode()).hexdigest()
    if expect != sig:
        return None
    payload = json.loads(body)
    if payload["expires_at"] < time():
        return None
    return payload


def load_secret(path: str) -> str:
    raw = Path(path).read_text().strip()
    if len(raw) < 32:
        raise ValueError("SECRET_TOO_SHORT: 密钥至少 32 字节")
    return raw
"""


def demo_chunking() -> None:
    print("\n【一】分块：固定窗口 vs 结构感知")

    fixed = chunk_fixed(SAMPLE, "auth.py", size=400)
    struct = chunk_by_structure(SAMPLE, "auth.py")

    print(f"  固定窗口（400 字符）：{len(fixed)} 块")
    for c in fixed:
        first = next((line for line in c.text.split("\n") if line.strip()), "")
        print(f"    行 {c.lines[0]:>2}-{c.lines[1]:>2}  {first[:46]}")

    print(f"\n  结构感知：{len(struct)} 块")
    for c in struct:
        print(f"    行 {c.lines[0]:>2}-{c.lines[1]:>2}  path={c.path}")

    print("\n  ★ 差别不在块数，在**每一块是不是一个完整的语义单元**。")
    print("  固定窗口那几块里，至少有一块把 verify_token 的签名和函数体切开了。")
    print("  而被切断的函数在向量空间里既不像原函数、也不像别的东西——它是噪声。")


def demo_vector_vs_bm25() -> None:
    print("\n【二】向量 vs 关键词：各自失手在哪")

    chunks = chunk_by_structure(SAMPLE, "auth.py")
    vec = VectorIndex()
    kw = Bm25Index()
    vec.add(chunks)
    kw.add(chunks)

    for q, kind in [
        ("SECRET_TOO_SHORT", "精确错误码"),
        ("怎么检查令牌有没有过期", "自然语言描述"),
        ("load secret", "下划线切分后的词"),
    ]:
        v = vec.search(q, 2)
        b = kw.search(q, 2)
        print(f"\n  查询「{q}」（{kind}）")
        print(
            f"    向量  Top2：{'、'.join(f'{s.chunk.path}({s.score:.3f})' for s in v) or '（无）'}"
        )
        print(
            f"    BM25  Top2：{'、'.join(f'{s.chunk.path}({s.score:.2f})' for s in b) or '（无）'}"
        )

    print("\n  ★ 注意第一条：精确的错误码上 BM25 完胜。")
    print("  代码里最关键的词是**专有名词**——函数名、错误码、配置项。")
    print("  它们的语义来自约定而不是语言，而向量空间对约定一无所知。")
    print("\n  正确的问题从来不是「用向量还是用关键词」，是**怎么把两路合起来**。")


def demo_fusion() -> None:
    print("\n【三】融合：为什么不能把分数加起来")

    chunks = chunk_by_structure(SAMPLE, "auth.py")
    vec = VectorIndex()
    kw = Bm25Index()
    vec.add(chunks)
    kw.add(chunks)

    q = "令牌校验失败的时候返回什么"
    v = vec.search(q, 5)
    b = kw.search(q, 5)

    print(f"  查询「{q}」")
    print(f"\n  向量的分数范围：{v[-1].score:.3f} ~ {v[0].score:.3f}")
    lo = b[-1].score if b else 0.0
    hi = b[0].score if b else 0.0
    print(f"  BM25 的分数范围：{lo:.3f} ~ {hi:.3f}")
    print("\n  ★ 两个量纲差一个数量级以上。直接相加等于只用 BM25。")
    print("  而归一化不解决问题：min-max 对离群值极其敏感，")
    print("  而 BM25 的最高分**天生就是离群值**——那正是精确命中。")

    print("\n  RRF（只用排名）的结果：")
    for s in rrf([v, b])[:4]:
        print(f"    {s.via:<6} {str(s.chunk.path):<14} {s.score:.5f}")
    print("\n  两路都召回的（both）排在前面——这正是混合检索想要的行为。")


def demo_rerank() -> None:
    print("\n【四】重排：丢掉的那些要能说出为什么")

    chunks = chunk_by_structure(SAMPLE, "auth.py")
    vec = VectorIndex()
    kw = Bm25Index()
    vec.add(chunks)
    kw.add(chunks)

    q = "load secret 最短长度"
    fused = rrf([vec.search(q, 6), kw.search(q, 6)])
    r = rerank_heuristic(q, fused, keep=2)

    print(f"  融合后 {len(fused)} 个候选，重排保留 {len(r.kept)} 个：")
    for s in r.kept:
        print(f"    \033[32m✓\033[0m {s.chunk.path} ({s.score:.3f})")
    for c, why in r.dropped:
        print(f"    \033[33m✕\033[0m {c.path} —— {why}")

    print("\n  ★ 那些理由不是给用户看的，是给**你**看的。")
    print("  「为什么这段代码没被用上」这个问题，没有 dropped 就只能瞎调参数。")


def demo_route() -> None:
    print("\n【五】该不该检索：四种情况")

    cases = [
        (
            "一个 50 文件的小项目，问架构",
            RouteInput(300, 40_000, 200_000, False, False),
        ),
        (
            "在大仓库里找 SECRET_TOO_SHORT 这个错误码",
            RouteInput(20_000, 4_000_000, 200_000, True, False),
        ),
        (
            "「登录偶尔失败」——不知道该看哪",
            RouteInput(20_000, 4_000_000, 200_000, False, True),
        ),
        (
            "在十万篇文档里问一个明确的问题",
            RouteInput(100_000, 50_000_000, 200_000, False, False),
        ),
    ]

    for label, inp in cases:
        d = choose_retrieval(inp)
        print(f"\n  {label}")
        print(f"    → \033[36m{d.mode}\033[0m")
        print(f"      {d.why}")

    print("\n  ★ 第一条最容易被跳过：**语料塞得下就别检索。**")
    print("  在 2026 年这覆盖的场景比大多数人想的多——20 万 token 装得下一个中等项目。")
    print("  检索的收益是省钱，代价是可能漏内容，**而漏了的那部分你不会知道**。")


def demo_assemble() -> None:
    print("\n【六】装配与引用校验")

    chunks = chunk_by_structure(SAMPLE, "auth.py")
    q = "令牌是怎么签名的"
    got = assemble(q, chunks, budget=300)

    print(
        f"  预算 300 token，装进 {len(got.used)} 块，"
        f"砍掉 {len(got.truncated)} 块（实际 {got.tokens} token）"
    )
    if got.truncated:
        names = "、".join(str(c.path) for c in got.truncated)
        print(f"    \033[33m被砍掉的：{names}\033[0m")

    print("\n  装配出来的开头几行：\n")
    for line in got.text.split("\n")[:8]:
        print("    " + line)

    print("\n  ★ 那句「没有依据就说不知道」不是客套。")
    print("  不写的话，模型会在材料不够时用先验知识补——**而那正是 RAG 想避免的事**。")

    answer = (
        "令牌签名在 auth.py:9-13 里用 sha256 完成。\n"
        "校验逻辑见 auth.py:120-140，另外 src/crypto/hmac.py:8-20 有相关实现。"
    )
    check = check_citations(answer, got.used)
    print("\n  引用校验：")
    print(f"    引用了 {len(check.cited)} 处")
    print(f"    \033[31m文件不存在：{'、'.join(check.unknown_source) or '（无）'}\033[0m")
    print(f"    \033[33m行号对不上：{'、'.join(check.wrong_range) or '（无）'}\033[0m")
    print("\n  ★ 第二类比第一类更隐蔽：文件名看着眼熟，review 的人扫一眼就过了。")
    print("  而这是 RAG 里**唯一能自动判定的质量信号**，所以它的价值远超代码量。")


# ─────────────────────────────────────────────────────────────
# TODO 10：动手改一个地方，看它怎么坏
#
# 把 rrf 换成"两路分数直接相加"，重新跑【三】。
# 结果里还有向量那一路的贡献吗？
#
# 然后试第二种：先对两路做 min-max 归一化再相加。
# 好一点了吗？把 BM25 那一路的最高分手动改成 100（模拟一次精确命中），
# 再看归一化之后其余候选的分数变成了什么。
#
# ★ 这个实验是这一节最该亲手做的一个。它演示的是：
# **一个看起来合理的融合方式，在一种常见输入下会完全失效。**
# ─────────────────────────────────────────────────────────────


def main() -> None:
    print("检索：分块、双路、融合、重排、装配。不调 API（也不调 embedding）。")
    demo_chunking()
    demo_vector_vs_bm25()
    demo_fusion()
    demo_rerank()
    demo_route()
    demo_assemble()
    print("\n" + "─" * 60)
    print("接着跑 uv run python -m l09.agentic，看多轮检索什么时候真的比一次性强。")
    print("别忘了 TODO 10。")


if __name__ == "__main__":
    main()
