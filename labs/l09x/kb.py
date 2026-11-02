"""L09x 的脚手架。跑法：uv run python -m l09x.kb

观察实验：解析结果里的页眉、页码和脚注；表格的四种切法；全角数字；ACL 放在 ANN 之后召回塌缩、
rerank 在过滤之前外发越权全文；别的租户改了你的排序；三种版本消解策略；四种同步模式；入库门禁矩阵。
零网络、零模型、零向量库。语料是 fixtures/corpus.json（两种语言读同一份文件）。
写完七个 TODO 跑 uv run python -m l09x.verify。
"""

from __future__ import annotations

import copy
import json
import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from functools import cmp_to_key
from pathlib import Path

from shared.coding_eval import cmp_code_point
from shared.kb import (
    GATE_CHECKS,
    AnnHit,
    Block,
    ChunkOpts,
    FilteredSearch,
    FilterMode,
    FilterOpts,
    Gen,
    HeadingInfo,
    KbChunk,
    ParsedDoc,
    ParsedPage,
    RerankOrder,
    RerankResult,
    Session,
    StatScope,
    SyncChunk,
    SyncMode,
    TableData,
    TDoc,
    VersionCand,
    VersionMeta,
    VersionVerdict,
    apply_sync,
    bm25_rank,
    can_see,
    chunk_document,
    cite_locator,
    cp_len,
    doc_from_json,
    heading_level,
    kb_tokenize,
    normalize_text,
    pick_by_effective,
    pick_by_mtime,
    quality_gate,
    render_table_rows,
    rerank_pipeline,
    resolve_versions,
    search_filtered,
    session_from_json,
    strip_running,
    sync_key,
    tenant_search,
    trim_spaces,
)
from shared.retrieval import tokenize

DIM, BOLD, OFF = "\x1b[2m", "\x1b[1m", "\x1b[0m"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_WIDE = re.compile(r"[\u2e80-\u9fff\uff00-\uffef]")


def dim(s: str) -> str:
    return f"{DIM}{s}{OFF}"


def bold(s: str) -> str:
    return f"{BOLD}{s}{OFF}"


def _visible(s: str) -> str:
    return _ANSI.sub("", s)


def w(s: str) -> int:
    n = 0
    for c in _visible(s):
        n += 2 if _WIDE.match(c) else 1
    return n


def pad(s: str | int, n: int) -> str:
    t = str(s)
    return t + " " * max(0, n - w(t))


def lpad(s: str | int, n: int) -> str:
    t = str(s)
    return " " * max(0, n - w(t)) + t


_by_cp = cmp_to_key(cmp_code_point)

# ─────────────────────────────────────────────────────────────
# 夹具（verify 也用）
# ─────────────────────────────────────────────────────────────


@dataclass
class Corpus:
    users: dict[str, Session]
    docs: list[ParsedDoc]


def load_corpus() -> Corpus:
    raw = json.loads(
        (Path(__file__).parent / "fixtures" / "corpus.json").read_text(encoding="utf-8")
    )
    return Corpus(
        users={k: session_from_json(v) for k, v in raw["users"].items()},
        docs=[doc_from_json(d) for d in raw["docs"]],
    )


GEN = Gen(parser="mineru-2.1", chunker="kb-v1", embedder="bge-m3")


def doc_by_id(c: Corpus, id_: str) -> ParsedDoc:
    d = next((x for x in c.docs if x.doc_id == id_), None)
    if d is None:
        raise ValueError(f"没有这份文档：{id_}")
    return d


def all_chunks(c: Corpus, opts: ChunkOpts | None = None) -> list[KbChunk]:
    out: list[KbChunk] = []
    for d in c.docs:
        out.extend(chunk_document(d, GEN, opts))
    return out


def budget_table(c: Corpus) -> TableData:
    """预算表：两页拼起来之后的完整表格（跨页的后半段没有表头，要继承前半段的）。"""
    doc = doc_by_id(c, "budget-2025")
    t: TableData | None = None
    for p in doc.pages:
        for b in p.blocks:
            if b.kind != "table" or b.table is None:
                continue
            if t is None:
                t = TableData(
                    caption=b.table.caption,
                    header_rows=[r[:] for r in b.table.header_rows],
                    rows=[r[:] for r in b.table.rows],
                )
            else:
                for r in b.table.rows:
                    t.rows.append(r[:])
    assert t is not None
    return t


def _rng(seed: int) -> Callable[[], float]:
    """确定性随机：Park–Miller minstd。x 一直是整数（TS 那边乘积 < 2^53，double 精确），最后才做一次除法。"""
    x = seed % 2147483647 if seed >= 0 else -(-seed % 2147483647)  # JS 的 % 取被除数的符号
    if x <= 0:
        x += 2147483646

    def nxt() -> float:
        nonlocal x
        x = (x * 48271) % 2147483647
        return x / 2147483647

    return nxt


ANN_N = 4000
ANN_DIM = 8
ANN_QUERIES = 20


def _by_score(a: AnnHit, b: AnnHit) -> float:
    return (b.score - a.score) or cmp_code_point(a.id, b.id)


def ann_fixture() -> list[list[AnnHit]]:
    """实验四的合成向量库：4000 个 8 维向量、20 个查询。返回每个查询的完整排序（点积降序，同分按 id）。
    可见性用 ann_visible(m)：下标是 m 的倍数才可见，选择率 1/m。
    ★ 点积按 TS 的顺序逐项累加；不用 sum()（3.12 起对浮点做补偿求和，末位会和 TS 不同）。
    """
    r = _rng(42)
    vecs: list[list[float]] = []
    for _ in range(ANN_N):
        v: list[float] = []
        for _ in range(ANN_DIM):
            v.append(r() - 0.5)
        vecs.append(v)
    out: list[list[AnnHit]] = []
    for _ in range(ANN_QUERIES):
        qv: list[float] = []
        for _ in range(ANN_DIM):
            qv.append(r() - 0.5)
        ranked: list[AnnHit] = []
        for i, v in enumerate(vecs):
            s = 0.0
            for j in range(ANN_DIM):
                s += qv[j] * v[j]
            ranked.append(AnnHit(id=f"v{str(i).rjust(4, '0')}", score=s))
        ranked.sort(key=cmp_to_key(_by_score))
        out.append(ranked)
    return out


def ann_visible(m: int) -> Callable[[str], bool]:
    return lambda id_: int(id_[1:]) % m == 0


def tenant_docs(n_globex: int) -> list[TDoc]:
    """实验五：acme 的 4 篇 + globex 的 n 篇「报销」短文。"""
    out = [
        TDoc(
            id="A1",
            tenant="acme",
            text="报销流程：先在系统提交报销单并附发票，主管审批后财务付款。报销周期一般五个工作日。",
        ),
        TDoc(id="A2", tenant="acme", text="发票要求：增值税专用发票须抬头正确。"),
        TDoc(id="A3", tenant="acme", text="年假规定：入职满一年享受五天年假。"),
        TDoc(id="A4", tenant="acme", text="会议室预订：提前一天在系统中预订。"),
    ]
    for i in range(n_globex):
        out.append(
            TDoc(
                id=f"B{str(i + 1).rjust(2, '0')}",
                tenant="globex",
                text=f"报销 报销单 第{i}号 已审批。",
            )
        )
    return out


def _ver(
    family: str,
    level: int,
    special: bool,
    issued: str,
    effective_from: str | None,
    mtime: str,
    repealed_at: str | None = None,
) -> VersionMeta:
    return VersionMeta(
        family=family,
        level=level,
        special=special,
        issued=issued,
        effective_from=effective_from,
        repealed_at=repealed_at,
        mtime=mtime,
    )


AS_OF = "2026-10-12"


@dataclass
class VersionScenario:
    name: str
    cands: list[VersionCand]


def version_scenarios() -> list[VersionScenario]:
    """实验六的六个场景。"""
    t = "travel"
    return [
        VersionScenario("S1 新版已生效", [
            VersionCand("办法2023", _ver(t, 2, False, "2023-01-01", "2023-01-01", "2023-01-01")),
            VersionCand("办法2025", _ver(t, 2, False, "2025-06-01", "2025-07-01", "2025-06-01")),
        ]),
        VersionScenario("S2 新版未生效", [
            VersionCand("办法2025", _ver(t, 2, False, "2025-06-01", "2025-07-01", "2025-06-01")),
            VersionCand("办法2026", _ver(t, 2, False, "2026-09-20", "2027-01-01", "2026-09-20")),
        ]),
        VersionScenario("S3 旧版被重新编辑", [
            VersionCand("办法2023", _ver(t, 2, False, "2023-01-01", "2023-01-01", "2026-10-01")),
            VersionCand("办法2025", _ver(t, 2, False, "2025-06-01", "2025-07-01", "2025-06-01")),
        ]),
        VersionScenario("S4 上位 vs 下位", [
            VersionCand("集团制度", _ver(t, 1, False, "2024-01-01", "2024-01-01", "2024-01-01")),
            VersionCand("子公司细则", _ver(t, 3, False, "2025-03-01", "2025-03-01", "2025-03-01")),
        ]),
        VersionScenario("S5 同级特别 vs 一般", [
            VersionCand("研发差旅补充", _ver(t, 2, True, "2024-05-01", "2024-05-01", "2024-05-01")),
            VersionCand("公司差旅办法", _ver(t, 2, False, "2025-07-01", "2025-07-01", "2025-07-01")),
        ]),
        VersionScenario("S6 已废止", [
            VersionCand("办法2025", _ver(t, 2, False, "2025-06-01", "2025-07-01", "2025-06-01", "2026-08-01")),
            VersionCand("暂行规定", _ver(t, 2, False, "2024-01-01", "2024-01-01", "2024-01-01")),
        ]),
    ]  # fmt: skip


@dataclass
class SyncRound:
    batch: list[SyncChunk]
    tombstones: list[str]


def sync_rounds() -> list[SyncRound]:
    """实验七：第 1 轮 A、B、C 全量；第 2 轮 A 被编辑、C 在源系统删除；第 3 轮 loader 只拿回 A（B 的读取权限过期了）。"""
    return [
        SyncRound(
            [SyncChunk("A#1", "A", "a1"), SyncChunk("B#1", "B", "b1"), SyncChunk("C#1", "C", "c1")],
            [],
        ),
        SyncRound([SyncChunk("A#1", "A", "a2"), SyncChunk("B#1", "B", "b1")], ["C"]),
        SyncRound([SyncChunk("A#1", "A", "a2")], []),
    ]


ApplyFn = Callable[[list[SyncChunk], list[SyncChunk], list[str], SyncMode], list[SyncChunk]]


def run_sync(mode: SyncMode, apply: ApplyFn = apply_sync) -> list[str]:
    idx: list[SyncChunk] = []
    snaps: list[str] = []
    for r in sync_rounds():
        idx = apply(idx, r.batch, r.tombstones, mode)
        snaps.append(",".join(sync_key(c) for c in idx))
    return snaps


def _clone_doc(d: ParsedDoc) -> ParsedDoc:
    return copy.deepcopy(d)


@dataclass
class NamedDoc:
    name: str
    doc: ParsedDoc


def bad_docs(c: Corpus) -> list[NamedDoc]:
    """实验八：在 travel-2025 上各弄坏一处。"""
    good = doc_by_id(c, "travel-2025")
    empty = _clone_doc(good)
    empty.doc_id = "bad-empty-page"
    empty.pages.append(ParsedPage(index0=2, blocks=[]))
    foot = _clone_doc(good)
    foot.doc_id = "bad-footnote"
    foot.pages[0].blocks.append(
        Block(id="p0b4", kind="text", text="第十四条 住宿费标准已含早餐①。", y=560)
    )
    table = _clone_doc(good)
    table.doc_id = "bad-table"
    table.pages[1].blocks.append(
        Block(
            id="p1b1",
            kind="table",
            text="",
            y=400,
            table=TableData(
                caption="", header_rows=[], rows=[["一线城市", "500"], ["其他城市", "380"]]
            ),
        )
    )
    fffd = _clone_doc(good)
    fffd.doc_id = "bad-encoding"
    fffd.pages[1].blocks.append(
        Block(id="p1b1", kind="text", text="第二十二条 住宿发票须与行程一\ufffd。", y=400)
    )
    return [
        NamedDoc("travel-2025", good),
        NamedDoc("legacy-notice", doc_by_id(c, "legacy-notice")),
        NamedDoc("bad-empty-page", empty),
        NamedDoc("bad-footnote", foot),
        NamedDoc("bad-table", table),
        NamedDoc("bad-encoding", fffd),
    ]


# ─────────────────────────────────────────────────────────────
# 观察实验
# ─────────────────────────────────────────────────────────────


def _short(s: str, n: int) -> str:
    one = " | ".join(s.split("\n"))
    return one[:n] + "…" if len(one) > n else one


def _permille(num: int, den: int) -> str:
    """千分比，整数运算：两种语言的 toFixed / round 规则不同。"""
    p = (num * 1000) // den
    return f"{p // 10}.{p % 10}%"


def _tenths(num: int, den: int) -> str:
    """一位小数（截断），整数时不带 .0。"""
    t = (num * 10) // den
    return str(t // 10) if t % 10 == 0 else f"{t // 10}.{t % 10}"


def _show(xs: list[AnnHit]) -> str:
    return "  ".join(f"{r.id}:{math.floor(r.score * 1000)}" for r in xs)


def _or_dash(s: str | None) -> str:
    return "—" if s is None else s


def exp1(c: Corpus) -> None:
    print(bold("\n实验一：解析结果里的坑"))
    for id_ in ["travel-2023", "budget-2025"]:
        doc = doc_by_id(c, id_)
        removed = strip_running(doc).removed
        running = [r for r in removed if r.why == "running"]
        nums = [r for r in removed if r.why == "page_number"]
        labels = " ".join(_or_dash(p.label) for p in doc.pages)
        print(f"  {bold(id_)}  {len(doc.pages)} 页，印刷页码 {labels}")
        if running:
            print(dim(f"    删掉页眉页脚 ×{len(running)}：{running[0].text}"))
        if nums:
            print(dim(f"    删掉页码行 ×{len(nums)}：{' · '.join(r.text for r in nums)}"))
        print(dim(f"    {pad('chunk', 16)}{pad('定位', 12)}{pad('正文', 52)}标题路径"))
        for ch in chunk_document(doc, GEN):
            print(
                f"    {pad(ch.id, 16)}{pad(cite_locator(ch), 12)}{pad(_short(ch.text, 24), 52)}{' › '.join(ch.heading_path) or '—'}"
            )
    print(dim("  页眉是跨页统计出来的；跨页段落的定位是一个范围；脚注附在引用它的每一行上。"))
    print(
        dim(
            "  travel-2023 的物理第 3 页印着「1」：「第 3 页」和「p. 1」是同一页，存的时候要分开存。"
        )
    )


def _col_of_1200(text: str) -> str:
    for part in text.split("; "):
        if not part.endswith(": 1200"):
            continue
        name = part[: len(part) - len(": 1200")]
        sp = name.rfind(" ")
        return name[sp + 1 :] if sp >= 0 else name
    return "—"


def exp2(c: Corpus) -> None:
    print(bold("\n实验二：表格怎么切（查询「研发部 2025年 金额」）"))
    t = budget_table(c)
    header_flat = " ".join(" ".join(x for x in r if x != "") for r in t.header_rows)
    flat = f"{t.caption} {header_flat} {' '.join(' '.join(r) for r in t.rows)}"
    cps = list(flat)
    fixed: list[TDoc] = []
    for n, i in enumerate(range(0, len(cps), 40)):
        fixed.append(TDoc(id=f"fixed#{n}", tenant="acme", text="".join(cps[i : i + 40])))
    r0 = t.header_rows[0]
    first: list[str] = []
    for j, x in enumerate(r0):
        if x != "":
            first.append(x)
        elif j > 0:
            prev = [y for y in r0[:j] if y != ""]
            first.append(prev[-1] if prev else "")
        else:
            first.append("")
    rows0 = [
        TDoc(
            id=f"rows0#{i}",
            tenant="acme",
            text=f"{t.caption} {'; '.join(f'{first[j]}: {v}' for j, v in enumerate(r))}",
        )
        for i, r in enumerate(t.rows)
    ]
    bare = [TDoc(id=f"bare#{i}", tenant="acme", text=" ".join(r)) for i, r in enumerate(t.rows)]
    ours = [
        TDoc(id=f"row#{i}", tenant="acme", text=text) for i, text in enumerate(render_table_rows(t))
    ]
    q = "研发部 2025年 金额"
    print(
        dim(
            f"  {pad('切法', 26)}{lpad('chunk数', 7)}  {pad('top1', 10)}{pad('含研发部', 10)}1200 的列名"
        )
    )
    rows: list[tuple[str, list[TDoc]]] = [
        ("定长 40 字、表头只出现一次", fixed),
        ("按行、只取第一级表头", rows0),
        ("按行、不带列名", bare),
        ("按行、多级表头按列拼", ours),
    ]
    for name, docs in rows:
        res = bm25_rank(docs, docs, q)
        top = next(d for d in docs if d.id == res[0].id) if res else None
        text = top.text if top is not None else ""
        print(
            f"  {pad(name, 26)}{lpad(len(docs), 7)}  {pad(top.id if top is not None else '—', 10)}{pad('是' if '研发部' in text else '否', 10)}{_col_of_1200(text)}"
        )
    print(
        dim(
            "  只取第一级表头时，「金额」和「占比」两列都叫「2025年」：模型拿到 1200 和 25.9%，分不清哪个是钱。"
        )
    )


def exp3() -> None:
    print(bold("\n实验三：公文里的全角数字（L09 的 tokenize vs 先 NFKC 再切）"))
    for s in ["第３条", "（２）", "２０２５年"]:
        print(f"  {pad(s, 14)}L09 [{','.join(tokenize(s))}]  NFKC 后 [{','.join(kb_tokenize(s))}]")
    docs = [
        TDoc(id="第３条", tenant="acme", text="第３条 差旅住宿标准按城市等级执行。"),
        TDoc(id="第５条", tenant="acme", text="第５条 差旅交通标准按职级执行。"),
        TDoc(id="第十三条", tenant="acme", text="第十三条 差旅报销应在返回后三十日内提交。"),
        TDoc(id="（２）", tenant="acme", text="（２）住宿发票须与行程一致。"),
    ]
    print(dim(f"  {pad('查询', 14)}{pad('切词', 8)}排序（id:score×1000 取整）"))
    toks: list[tuple[str, Callable[[str], list[str]]]] = [("L09", tokenize), ("NFKC", kb_tokenize)]
    for q in ["第3条 差旅", "（2） 发票"]:
        for name, tok in toks:
            res = bm25_rank(docs, docs, q, tok)
            print(f"  {pad(q, 14)}{pad(name, 8)}{_show(res)}")
    print(dim(f"  {pad('标题识别', 22)}级别  编号"))
    for s in [
        "第十二条 适用范围",
        "（一）总则",
        "(一)总则",
        "１、总则",
        "1.1.2 小节",
        "\ufeff第一章 总则",
        "2025年预算增长10%。",
        "1.5元以内",
    ]:
        h = heading_level(s)
        shown = "\\uFEFF".join(s.split("\ufeff"))
        print(
            f"  {pad(shown, 22)}{pad(h.level if h is not None else '—', 6)}{h.label if h is not None else '不是标题'}"
        )
    print(
        dim(
            "  L09 的字符类不含全角数字：「第３条」只剩「第、条」，查「第3条」时更短的第５条排到了前面。"
        )
    )
    print(
        dim(
            "  标题识别先去 BOM 再 NFKC：JS 的 trim() 会吃掉 BOM、Python 的 strip() 不会，只靠 trim 两边结论不同。"
        )
    )


@dataclass
class _Tally:
    ret: int = 0
    least: int = 10**9
    hit: int = 0
    leak: int = 0


def _tally(s: _Tally, ids: list[str], truth: set[str], leak: int) -> None:
    s.ret += len(ids)
    s.least = min(s.least, len(ids))
    s.hit += len([i for i in ids if i in truth])
    s.leak += leak


def _score_by(cands: list[AnnHit]) -> Callable[[list[str]], list[float]]:
    return lambda ids: [next(h for h in cands if h.id == i).score for i in ids]


def exp4() -> None:
    print(
        bold(
            f"\n实验四：ACL 放在 ANN 之后（N={ANN_N}、dim={ANN_DIM}、ef=40、k=10、maxScan=400、{ANN_QUERIES} 个查询）"
        )
    )
    ranked = ann_fixture()
    k = 10

    def opts(mode: FilterMode) -> FilterOpts:
        return FilterOpts(k=k, ef=40, mode=mode, max_scan=400)

    modes: list[FilterMode] = ["post", "pre", "iterative"]
    print(
        dim(
            f"  {pad('选择率', 8)}{pad('策略', 16)}{lpad('平均返回', 10)}{lpad('最少', 6)}{lpad('recall@10', 11)}{lpad('越权外发', 10)}"
        )
    )
    for label, m in [("50%", 2), ("10%", 10), ("2%", 50), ("0.5%", 200)]:
        vis = ann_visible(m)
        names = ["post", "pre", "iterative", "rerank-first"]
        stats = {n: _Tally() for n in names}
        for r in ranked:
            truth = set(search_filtered(r, vis, opts("pre")).ids)
            for mode in modes:
                _tally(stats[mode], search_filtered(r, vis, opts(mode)).ids, truth, 0)
            cands = r[:40]
            rr = rerank_pipeline(cands, vis, "rerank-first", _score_by(cands), k)
            _tally(stats["rerank-first"], rr.ids, truth, len([i for i in rr.exposed if not vis(i)]))
        for n in names:
            s = stats[n]
            print(
                f"  {pad(label, 8)}{pad(n, 16)}{lpad(_tenths(s.ret, len(ranked)), 10)}{lpad(s.least, 6)}{lpad(_permille(s.hit, k * len(ranked)), 11)}{lpad(s.leak, 10)}"
            )
    print(
        dim(
            "  post 不越权、不报错，2% 时平均只返回 0.6 条；rerank-first 的结果和 post 一模一样，却把几百段越权全文发了出去。"
        )
    )
    print(
        dim(
            "  iterative 受 maxScan 限制，0.5% 时也只拿回 1.5 条：上限是必须的，但它决定了低选择率用户的召回。"
        )
    )


def exp5() -> None:
    print(bold("\n实验五：tenant 过滤之后，统计量仍是共享的（acme 搜「报销 发票」）"))
    print(
        dim(f"  {pad('globex 文档数', 15)}{pad('统计口径', 12)}acme 的排序（id:score×1000 取整）")
    )
    scopes: list[StatScope] = ["shared", "per-tenant"]
    for n in [0, 10, 50]:
        all_ = tenant_docs(n)
        for scope in scopes:
            res = tenant_search(all_, scope, "报销 发票", "acme", 10)
            print(f"  {pad(n, 15)}{pad(scope, 12)}{_show(res)}")
    print(
        dim(
            "  globex 多写 10 篇报销单，acme 的第一名就从 A1 换成了 A2——结果里一篇 globex 的文档都没有。"
        )
    )


def exp6(c: Corpus) -> None:
    print(bold(f"\n实验六：版本消解（asOf={AS_OF}）"))
    print(dim(f"  {pad('场景', 22)}{pad('按 mtime', 14)}{pad('按生效日', 14)}三维规则"))
    for sc in version_scenarios():
        v = resolve_versions(sc.cands, AS_OF)
        three = v.chosen if v.chosen is not None else "CONFLICT"
        note = dim(f"（{v.reason}）") if v.conflict else ""
        print(
            f"  {pad(sc.name, 22)}{pad(_or_dash(pick_by_mtime(sc.cands)), 14)}{pad(_or_dash(pick_by_effective(sc.cands, AS_OF)), 14)}{three}{note}"
        )
    chunks = all_chunks(c)
    for name in ["alice", "bob"]:
        s = c.users[name]
        docs: dict[str, VersionCand] = {}
        for ch in chunks:
            if ch.version.family == "travel" and can_see(ch, s):
                docs[ch.doc_id] = VersionCand(doc_id=ch.doc_id, version=ch.version)
        v = resolve_versions(list(docs.values()), AS_OF)
        print(
            f"  {pad(f'真实语料 · {name}', 22)}{' '.join(sorted(docs, key=_by_cp))}  → {v.chosen if v.chosen is not None else 'CONFLICT'}"
        )
    print(
        dim(
            "  按 mtime 在 S2、S3 选错，按生效日在 S4、S5 选错；同一个问题，研发部的 bob 和 HR 的 alice 该拿到不同的答复。"
        )
    )


def exp7() -> None:
    print(bold("\n实验七：删除不会自己传播"))
    print(dim(f"  {pad('模式', 13)}{pad('第 2 轮后', 22)}{pad('第 3 轮后', 22)}问题"))
    modes: list[SyncMode] = ["none", "incremental", "full", "tombstone"]
    for mode in modes:
        snaps = run_sync(mode)
        last = snaps[2].split(",")
        issues: list[str] = []
        if "A:a1" in snaps[1].split(","):
            issues.append("A 旧版残留")
        if "C:c1" in last:
            issues.append("已删的 C 残留")
        if "B:b1" not in last:
            issues.append("B 被误删")
        print(f"  {pad(mode, 13)}{pad(snaps[1], 22)}{pad(snaps[2], 22)}{'、'.join(issues) or '无'}")
    kept = tenant_docs(0)
    ghosts = [
        TDoc(id=f"G{str(i + 1).rjust(2, '0')}", tenant="acme", text=f"报销 报销单 第{i}号 已作废。")
        for i in range(30)
    ]
    soft = bm25_rank(kept, [*kept, *ghosts], "报销 发票")
    rebuilt = bm25_rank(kept, kept, "报销 发票")
    print(f"  删了 30 篇、统计量没重算：{_show(soft)}")
    print(f"  重建之后                ：{_show(rebuilt)}")
    print(
        dim(
            "  incremental 永远见不到整篇被删的 C；full 在 loader 部分失败时删掉了 B；软删除的文档还在改 IDF。"
        )
    )


def exp8(c: Corpus) -> None:
    print(bold("\n实验八：入库门禁（解析器不抛异常，所以要自己查）"))
    print(dim(f"  {pad('文档', 16)}" + "  ".join(g.label for g in GATE_CHECKS)))
    for nd in bad_docs(c):
        issues = quality_gate(nd.doc).issues
        cells = "  ".join(pad("✗" if g.code in issues else "·", w(g.label)) for g in GATE_CHECKS)
        print(re.sub(r" +\Z", "", f"  {pad(nd.name, 16)}{cells}", count=1))
    print(dim("  每份坏文档恰好被一项抓住、好文档一项都不中：检查之间不冗余，也不误报。"))


# ─────────────────────────────────────────────────────────────
# TODO
# ─────────────────────────────────────────────────────────────


def my_heading_level(line: str) -> HeadingInfo | None:
    r"""TODO 1 ★ 一行是不是标题、第几级（不是标题返回 None）。先 normalize_text（去 BOM + NFKC）：
      第X章 1 · 第X节 2 · 第X条 3（X 是中文数字）
      一、1 · (一) 2 · 1. 或 1、3 · (1) 4（NFKC 之后全角括号已经是半角）
      1.1 4 · 1.1.2 5（多级小节：点的个数 + 3，后面必须跟空格或结束）
      「2025年预算增长10%。」「1.5元以内」不是标题
    label 是编号本身（规范化之后的，如「第十二条」「(一)」「1.1.2」）。
    陷阱：用 \d（TS 不认全角「１」，Python 认）；不做 NFKC，「（一）」和「(一)」成了两级；只看第一个数字。
    """
    raise NotImplementedError("TODO 1 未实现")


def my_render_table_rows(t: TableData, hidden_columns: Sequence[str] = ()) -> list[str]:
    """TODO 2 ★★ 表格每一行渲染成一段带完整列名的文本。
      列名：多级表头按列拼，上一级的空格沿用左边（跨列）、最后一级的空格就是没有，非空部分用「/」连
        [['部门','2025年','','2024年',''], ['','金额','占比','金额','占比']]
        → 部门、2025年/金额、2025年/占比、2024年/金额、2024年/占比
      每行：「caption 列名: 值; 列名: 值」——caption 为空就不带；空单元格跳过；hidden_columns 里的列不出现
    陷阱：只用 header_rows[0]；「合计」行不带列名；caption 只放在第一行。
    """
    raise NotImplementedError("TODO 2 未实现")


def my_search_filtered(
    ranked: list[AnnHit], visible: Callable[[str], bool], o: FilterOpts
) -> FilteredSearch:
    """TODO 3 ★★ 带权限的 ANN 检索。ranked 已经按 ANN 顺序排好，visible(id) 是权限判定。
      post       取前 min(ef, n) 个，过滤，取前 k；scanned = min(ef, n)
      pre        按顺序过滤到够 k 个为止；scanned = n
      iterative  从 ef 开始，不够 k 个就再加一份 ef，直到够了或碰到 min(max_scan, n)；scanned = 最后用的 ef
    陷阱：迭代没有上限；不够 k 个时拿越权的凑数；把 post 偷偷写成 pre（verify 会抓）。
    """
    raise NotImplementedError("TODO 3 未实现")


def my_rerank_pipeline(
    cands: list[AnnHit],
    visible: Callable[[str], bool],
    order: RerankOrder,
    reranker: Callable[[list[str]], list[float]],
    k: int,
) -> RerankResult:
    """TODO 4 ★ 外部 rerank 的两种顺序。
      filter-first：先按 visible 过滤，再把剩下的 id 发给 reranker；rerank-first：全部发出去，回来再过滤
      reranker(ids) 返回同样长度的分数；按分数降序、同分按 id（cmp_code_point）排，取前 k
      exposed = 发给 reranker 的 id（按发送顺序）
    陷阱：先 rerank 再过滤——ids 和 filter-first 一模一样，测结果的测试全过，越权全文已经发出去了。
    """
    raise NotImplementedError("TODO 4 未实现")


def my_resolve_versions(cands: list[VersionCand], as_of: str) -> VersionVerdict:
    """TODO 5 ★★ 同一 family 的版本，在 as_of 这一天该用哪个。日期是 YYYY-MM-DD，直接按字符串比。
      1. 缺 effective_from 的不参与（reason 里要提到 effectiveFrom）
      2. 只留 effective_from ≤ as_of 且没有 repealed_at ≤ as_of 的；一个都没有 → chosen None、conflict False
      3. 只看 level 最小的（上位优先）；还有更下位的在场 → conflict = True
      4. 同级里既有 special 又有一般：一般的生效日更晚 → chosen None、conflict True；否则取最新的 special
      5. 否则取生效日最新的（同日比 issued，再比 doc_id）
    陷阱：按 mtime 或 issued 取最新；忽略 effective_from > as_of；「新的一般 vs 旧的特别」硬选一个。
    """
    raise NotImplementedError("TODO 5 未实现")


def my_apply_sync(
    index: list[SyncChunk], batch: list[SyncChunk], tombstones: list[str], mode: SyncMode
) -> list[SyncChunk]:
    """TODO 6 ★ 一轮同步。索引按 sync_key（src:hash）去重；先把 batch 全部写入，再按模式删：
      none         不删
      incremental  src 在本批出现过、但这个 key 不在本批 → 删
      full         key 不在本批 → 删
      tombstone    incremental 的规则，再加：src 在 tombstones 里 → 删
    返回按 sync_key 排序（cmp_code_point）的列表。
    陷阱：用 incremental 的语义（整篇删除残留）；用 full 的语义（loader 少拿一篇就误删）。
    """
    raise NotImplementedError("TODO 6 未实现")


def my_cache_key(query: str, principals: list[str], corpus_version: str) -> str:
    r"""TODO 7 ★ 答案缓存的键：三段用 \u001f 连起来
      trim_spaces(normalize_text(query)) · principals 去重后按 cmp_code_point 排序、用「,」连 · corpus_version
    陷阱：键里没有 principals（跨用户串答案）；不排序去重（同样的权限不同的键）；没有语料版本（撤权后还命中旧答案）。
    """
    raise NotImplementedError("TODO 7 未实现")


# ─────────────────────────────────────────────────────────────


def main() -> None:
    c = load_corpus()
    exp1(c)
    exp2(c)
    exp3()
    exp4()
    exp5()
    exp6(c)
    exp7()
    exp8(c)
    print(bold("\n最该记住的"))
    print("  · 企业 RAG 多出来的失败几乎都不报错：每一种都要变成一个可以断言的输出。")
    print("  · ACL 写成 WHERE 是安全的，但召回会静默塌缩；过滤要放进 ANN 里面。")
    print("  · 「结果一样」不等于「安全一样」：rerank、缓存、trace 都是权限的副本。")
    print("  · 删除要靠显式墓碑，「这次没看到」不等于「被删了」。")
    print("  · 「最新版」至少有三个维度，而且有一种冲突必须交给人。")


if __name__ == "__main__":
    main()
