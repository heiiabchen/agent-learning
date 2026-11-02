r"""L09x 参考实现：企业知识库 RAG 里那些「不报错的失败」。shared/kb.ts 的 Python 镜像。

L09 的语料是代码库：结构是显式语法，人人可见，删了就是删了。
企业语料多出来的东西几乎全是静默失效，所以这里每一个函数都把一种静默失效变成可断言的输出：

  A. 解析后清洗：页眉是跨页统计出来的，不是「顶部 10%」；页码有两套坐标
  B. 结构：中文编号识别（不能用 \d）；表格的每一行都要带上完整的列名
  C. 分块：标题路径、跨页段落、跨页表格、脚注、字段级权限
  D. 权限：缺 acl 就不可见；过滤放在 ANN 里面；rerank 之前就要过滤
  E. 多租户：tenant 过滤之后，BM25 统计量仍然是共享的
  F. 版本：上位 > 下位、特别 > 一般、新 > 旧，还有一种情况不能自动裁决
  G. 同步：删除要靠显式墓碑；重建范围看「什么变了」
  H. 缓存键与入库门禁

★ 零网络、零模型、零向量库。ANN 用「精确排序的前 ef 个」近似——这只会让后过滤显得更好，
所以观察实验里的坏结果是保守的。
★ 跨语言字节一致：不用 \w \d \s；长度按码点；去空白只去 ASCII 空格；
排序用 cmp_code_point 且永远带 tie-break。
正文保留原样（只去 BOM）：NFKC 会把「①」变成「1」、「（」变成「(」，引用时就对不上原文了。
规范化只用在切词、标题识别、缓存键这些「比较」的地方。

─── Python 侧的差异 ───────────────────────────────────────────

天然就对的：
  · len(s)、s[:k]、for c in s 都按码点走：cp_len 就是 len。TS 那边要专门写 Array.from。
  · sorted() 是稳定排序；dict 保插入序，Map / Set 的迭代顺序用 dict / dict.fromkeys 复现
    （set 只拿来判断成员，不拿来迭代：它的顺序随 PYTHONHASHSEED 变）。

反而要小心的：
  · str.strip() 不只去 ASCII 空格（U+00A0、U+3000 也去），str.lower() 会动非 ASCII 字母：
    trim_spaces、ascii_lower 都是手写循环。
  · \d 认全角「１」（TS 不认）；正则的 $ 还匹配「末尾换行之前」，一律改用 \Z。
  · cmp_code_point 用 Python 的 <（码点序），TS 的 cmpCodePoint 用 JS 的 <（UTF-16 码元序）：
    两者只在 BMP 内一致。语料全在 BMP 内。
  · JSON.stringify 会省略值为 undefined 的字段。这里的约定：dataclass 里默认值是 None 的字段
    就是 TS 的可选字段（?:），json_stringify 遇到 None 时省略它；没有默认值、类型里带 None 的字段
    （比如 VersionVerdict.chosen）对应 TS 的 null，照常写出 null。
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from collections.abc import Callable, Sequence
from dataclasses import dataclass, fields, is_dataclass, replace
from functools import cmp_to_key
from typing import Any, Literal, Protocol

from shared.coding_eval import cmp_code_point
from shared.retrieval import tokenize

_by_cp = cmp_to_key(cmp_code_point)


def cp_len(s: str) -> int:
    return len(s)


def trim_spaces(s: str) -> str:
    a = 0
    b = len(s)
    while a < b and s[a] == " ":
        a += 1
    while b > a and s[b - 1] == " ":
        b -= 1
    return s[a:b]


def ascii_lower(s: str) -> str:
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def strip_bom(s: str) -> str:
    """去掉每一个 U+FEFF，不只是开头那一个（TS 是 split / join）。"""
    return s.replace("\ufeff", "")


# ─────────────────────────────────────────────────────────────
# 数据形状
# ─────────────────────────────────────────────────────────────

BlockKind = Literal["text", "table", "footnote"]


@dataclass
class TableData:
    caption: str
    #: 多级表头：上一级的空格表示「跨列，沿用左边」。
    header_rows: list[list[str]]
    rows: list[list[str]]


@dataclass
class Block:
    id: str
    kind: BlockKind
    text: str
    #: 块顶边在页面上的位置，0–1000（千分比，避免浮点）。
    y: int
    #: 解析器标记的「接着上一页的同类块」：跨页段落、跨页表格的后半段。
    continues_prev: bool | None = None
    table: TableData | None = None


@dataclass(kw_only=True)
class ParsedPage:
    #: 物理页序，从 0 起（MinerU page_idx 的口径）。
    index0: int
    #: 印刷页码（「ii」「3」），可能没有。
    label: str | None = None
    blocks: list[Block]


@dataclass(kw_only=True)
class VersionMeta:
    family: str
    #: 1 = 集团，数字越大越下位。
    level: int
    #: 特别规定（只适用于某部门、某情形）。
    special: bool
    issued: str
    effective_from: str | None = None
    repealed_at: str | None = None
    #: 文件修改时间：重新编辑一下旧版，它就变成「最新」了。
    mtime: str


@dataclass
class FieldAcl:
    column: str
    principals: list[str]


@dataclass(kw_only=True)
class ParsedDoc:
    doc_id: str
    tenant: str
    title: str
    acl: list[str] | None = None
    field_acl: list[FieldAcl] | None = None
    version: VersionMeta
    parser: str
    pages: list[ParsedPage]


@dataclass(frozen=True)
class Gen:
    """索引的「代」：换了其中任何一样，旧向量和新向量就不可比。"""

    parser: str
    chunker: str
    embedder: str


@dataclass(kw_only=True)
class KbChunk:
    id: str
    doc_id: str
    tenant: str
    text: str
    heading_path: list[str]
    #: 物理页序 (起, 止)。
    pages: tuple[int, int]
    page_labels: tuple[str | None, str | None]
    acl: list[str] | None = None
    version: VersionMeta
    gen: Gen
    kind: Literal["text", "table_row"]


@dataclass(frozen=True)
class Session:
    user_id: str
    tenant: str
    principals: list[str]


# ─────────────────────────────────────────────────────────────
# JSON：TS 那边 JSON.parse 之后直接当类型用，这里要显式转成 dataclass
# ─────────────────────────────────────────────────────────────


def _camel(k: str) -> str:
    head, *rest = k.rstrip("_").split("_")
    return head + "".join(w[:1].upper() + w[1:] for w in rest)


def _js_shape(x: Any) -> Any:
    if is_dataclass(x) and not isinstance(x, type):
        out: dict[str, Any] = {}
        for f in fields(x):
            v = getattr(x, f.name)
            if v is None and f.default is None:
                continue
            out[_camel(f.name)] = _js_shape(v)
        return out
    if isinstance(x, list | tuple):
        return [_js_shape(v) for v in x]
    if isinstance(x, dict):
        return {k: _js_shape(v) for k, v in x.items()}
    return x


def json_stringify(x: Any) -> str:
    """JSON.stringify 的同义写法：dataclass 按字段顺序展开、字段名换回驼峰，
    默认值是 None 的字段（TS 的 ?:）为 None 时省略，和 undefined 不进 JSON 一样。"""
    return json.dumps(_js_shape(x), ensure_ascii=False, separators=(",", ":"))


def _version_from_json(v: dict[str, Any]) -> VersionMeta:
    return VersionMeta(
        family=v["family"],
        level=v["level"],
        special=v["special"],
        issued=v["issued"],
        effective_from=v.get("effectiveFrom"),
        repealed_at=v.get("repealedAt"),
        mtime=v["mtime"],
    )


def _block_from_json(b: dict[str, Any]) -> Block:
    t = b.get("table")
    return Block(
        id=b["id"],
        kind=b["kind"],
        text=b["text"],
        y=b["y"],
        continues_prev=b.get("continuesPrev"),
        table=None
        if t is None
        else TableData(caption=t["caption"], header_rows=t["headerRows"], rows=t["rows"]),
    )


def doc_from_json(d: dict[str, Any]) -> ParsedDoc:
    fa = d.get("fieldAcl")
    return ParsedDoc(
        doc_id=d["docId"],
        tenant=d["tenant"],
        title=d["title"],
        acl=d.get("acl"),
        field_acl=None
        if fa is None
        else [FieldAcl(column=f["column"], principals=f["principals"]) for f in fa],
        version=_version_from_json(d["version"]),
        parser=d["parser"],
        pages=[
            ParsedPage(
                index0=p["index0"],
                label=p.get("label"),
                blocks=[_block_from_json(b) for b in p["blocks"]],
            )
            for p in d["pages"]
        ],
    )


def session_from_json(s: dict[str, Any]) -> Session:
    return Session(user_id=s["userId"], tenant=s["tenant"], principals=s["principals"])


# ─────────────────────────────────────────────────────────────
# A. 解析后清洗
# ─────────────────────────────────────────────────────────────


def normalize_text(s: str) -> str:
    r"""去 BOM，再 NFKC。
    ★ 顺序不能反、BOM 不能省：Python 的 str.strip() 不认 BOM，JS 的 trim() 和 \s 认——
    「\uFEFF第一章」在 TS 里 trim 一下侥幸能匹配「^第」，在 Python 里 strip 了也不能。
    ★ NFKC 会把全角括号变成半角：之后匹配编号要用「(」，不是「（」。
    """
    return unicodedata.normalize("NFKC", strip_bom(s))


HEADER_ZONE = 100


def _in_zone(y: int, zone: int) -> bool:
    return y < zone or y >= 1000 - zone


def detect_running_lines(
    pages: list[ParsedPage], zone: int = HEADER_ZONE, min_pages: int = 3
) -> list[str]:
    """页眉页脚：在 ≥ min_pages 页的顶部或底部区域重复出现的同一行。
    ★ 是跨页统计，不能逐页判：「顶部 10% 的文字」会把第一页的标题删掉；
    「出现两次就删」会把恰好在两页顶部出现的小标题删掉。少于 min_pages 页的文档基本不去页眉。
    """
    count: dict[str, int] = {}
    for p in pages:
        seen: dict[str, None] = {}
        for b in p.blocks:
            if b.kind != "text" or not _in_zone(b.y, zone):
                continue
            t = trim_spaces(normalize_text(b.text))
            if t:
                seen[t] = None
        for t in seen:
            count[t] = count.get(t, 0) + 1
    return sorted((t for t, n in count.items() if n >= min_pages), key=_by_cp)


_RE_PAGE_NUM = re.compile(r"[-—–· ]*([0-9]+|[ivxlcdmIVXLCDM]+)[-—–· ]*\Z")
_RE_PAGE_DI = re.compile(r"第 ?[0-9]+ ?页\Z")


def is_page_number_line(s: str) -> bool:
    """页码行：每页都不同，所以统计抓不到，要靠模式。「— ii —」「- 3 -」「第 3 页」。"""
    t = trim_spaces(normalize_text(s))
    return _RE_PAGE_NUM.match(t) is not None or _RE_PAGE_DI.match(t) is not None


@dataclass(frozen=True)
class Removed:
    page: int
    text: str
    why: Literal["running", "page_number"]


@dataclass
class Stripped:
    pages: list[ParsedPage]
    removed: list[Removed]


def strip_running(doc: ParsedDoc) -> Stripped:
    """去掉页眉页脚和页码行，返回保留的页面和删掉了什么（观察实验要看）。"""
    running = set(detect_running_lines(doc.pages))
    removed: list[Removed] = []
    pages: list[ParsedPage] = []
    for p in doc.pages:
        kept: list[Block] = []
        for b in p.blocks:
            if b.kind != "text" or not _in_zone(b.y, HEADER_ZONE):
                kept.append(b)
                continue
            t = trim_spaces(normalize_text(b.text))
            if t in running:
                removed.append(Removed(page=p.index0, text=b.text, why="running"))
                continue
            if is_page_number_line(t):
                removed.append(Removed(page=p.index0, text=b.text, why="page_number"))
                continue
            kept.append(b)
        pages.append(replace(p, blocks=kept))
    return Stripped(pages=pages, removed=removed)


# ─────────────────────────────────────────────────────────────
# B. 结构：中文编号与表格
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class HeadingInfo:
    level: int
    label: str


CN = "[一二三四五六七八九十百千零〇两]+"
_RE_ARTICLE = re.compile(f"第{CN}(章|节|条)")
_RE_CN_LIST = re.compile(f"{CN}、")
_RE_CN_PAREN = re.compile(rf"\({CN}\)")
_RE_MULTI = re.compile(r"[0-9]+(\.[0-9]+)+(?= |\Z)")
_RE_NUM = re.compile(r"[0-9]+[.、](?![0-9])")
_RE_NUM_PAREN = re.compile(r"\([0-9]+\)")
ARTICLE_LEVEL: dict[str, int] = {"章": 1, "节": 2, "条": 3}


def heading_level(line: str) -> HeadingInfo | None:
    r"""一行是不是标题、第几级。先 normalize_text，再用显式字符类匹配：
      第X章 1 · 第X节 2 · 第X条 3
      一、1 · (一) 2 · 1. 或 1、3 · (1) 4（GB/T 9704 的四级序）
      1.1 4 · 1.1.2 5（多级小节，后面必须跟空格）
    「2025年预算增长10%。」「1.5元以内」都不是标题。

    ★ 不能用 \d：Python 的 \d 认全角「１」，TS 的不认。NFKC 之后统一成 ASCII 再用 [0-9]。
    ★ 同一符号在不同体系里层级不同：公文的「（一）」是第 2 层，法规的「（一）」是「项」。
    这里按公文排；法规文档要换一张表（层级判定应以文档类型为参数）。
    """
    s = trim_spaces(normalize_text(line))
    m = _RE_ARTICLE.match(s)
    if m:
        return HeadingInfo(level=ARTICLE_LEVEL[m.group(1)], label=m.group(0))
    m = _RE_CN_LIST.match(s)
    if m:
        return HeadingInfo(level=1, label=m.group(0))
    m = _RE_CN_PAREN.match(s)
    if m:
        return HeadingInfo(level=2, label=m.group(0))
    m = _RE_MULTI.match(s)
    if m:
        return HeadingInfo(level=3 + len(m.group(0).split(".")) - 1, label=m.group(0))
    m = _RE_NUM.match(s)
    if m:
        return HeadingInfo(level=3, label=m.group(0))
    m = _RE_NUM_PAREN.match(s)
    if m:
        return HeadingInfo(level=4, label=m.group(0))
    return None


def column_names(header_rows: list[list[str]]) -> list[str]:
    """多级表头按列拼成列名：上一级的空格沿用左边（跨列），各级非空的部分用「/」连起来。
      [['部门','2025年','','2024年',''], ['','金额','占比','金额','占比']]
      → ['部门', '2025年/金额', '2025年/占比', '2024年/金额', '2024年/占比']
    ★ 只取第一行表头（RAGFlow 的 rows[0]）会让「金额」和「占比」两列都叫「2025年」。
    """
    n = 0
    for r in header_rows:
        if len(r) > n:
            n = len(r)
    filled: list[list[str]] = []
    for i, r in enumerate(header_rows):
        out: list[str] = []
        for j in range(n):
            c = trim_spaces(r[j] if j < len(r) else "")
            out.append(out[j - 1] if c == "" and i < len(header_rows) - 1 and j > 0 else c)
        filled.append(out)
    names: list[str] = []
    for j in range(n):
        parts: list[str] = []
        for r in filled:
            if r[j] != "" and (not parts or parts[-1] != r[j]):
                parts.append(r[j])
        names.append("/".join(parts))
    return names


def render_table_rows(t: TableData, hidden_columns: Sequence[str] = ()) -> list[str]:
    """表格的每一行渲染成一段能独立回答「这一格是哪一列」的文本：
      「表3 各部门预算（万元）① 部门: 研发部; 2025年/金额: 1200; …」
    caption 每行都带；空单元格跳过；「合计」行照常带列名；hidden_columns 里的列不出现。
    ★ 「表格不能被切断」的真正意思不是整表放一个 chunk，而是任何一个含数据的 chunk 都带着列名。
    """
    names = column_names(t.header_rows)
    caption = trim_spaces(t.caption)
    out: list[str] = []
    for row in t.rows:
        pairs: list[str] = []
        for j in range(len(row)):
            v = trim_spaces(row[j])
            name = names[j] if j < len(names) else ""
            if v == "" or name in hidden_columns:
                continue
            pairs.append(f"{name}: {v}" if name else v)
        out.append(f"{caption} {'; '.join(pairs)}" if caption else "; ".join(pairs))
    return out


# ─────────────────────────────────────────────────────────────
# C. 分块
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ChunkOpts:
    #: 一个 text chunk 最多多少码点（只在块边界切，不切开一个块）。
    max_chars: int | None = None
    heading_level: Callable[[str], HeadingInfo | None] | None = None
    render_table_rows: Callable[..., list[str]] | None = None


HEADING_ENTRY_MAX = 12
_CIRCLED = re.compile("[\u2460-\u2473]")


@dataclass
class _TextBuf:
    texts: list[str]
    body: int
    chars: int
    p0: int
    p1: int
    path: list[str]


@dataclass
class _TableBuf:
    t: TableData
    row_pages: list[int]
    path: list[str]


@dataclass(frozen=True)
class _StackEntry:
    level: int
    entry: str


@dataclass(frozen=True)
class _Footnote:
    text: str
    page: int


def chunk_document(doc: ParsedDoc, gen: Gen, opts: ChunkOpts | None = None) -> list[KbChunk]:
    """解析结果 → chunk。
      - 先去页眉页脚和页码（strip_running）
      - 标题行开新 chunk；只有标题没有正文时，下一个标题并进同一个 chunk
        （「第二章 住宿标准」+「第十二条 …」）；
        标题后面紧跟表格时，标题只进表格行的 heading_path，不单独成块
      - continues_prev 的段落直接接在上一段后面，页码范围跨页
      - 表格：continues_prev 的后半段并进前一张表、继承表头和 caption；
        每个数据行一个 table_row chunk
      - 字段级权限：受限列不进普通行；另出一份完整行，acl 只给受限列的可见者
      - 脚注：带圈序号的脚注附到正文里含同一序号的 chunk；没有序号的附到同页最后一个 chunk

    ★ 字段级权限要在索引时做，不能在返回时遮：遮掉的值仍在 BM25 和向量里，
    用它当查询就能命中（存在性泄露）。
    """
    o = opts if opts is not None else ChunkOpts()
    max_chars = o.max_chars if o.max_chars is not None else 400
    heading = o.heading_level if o.heading_level is not None else heading_level
    render = o.render_table_rows if o.render_table_rows is not None else render_table_rows
    pages = strip_running(doc).pages
    label_of: dict[int, str] = {}
    for p in doc.pages:
        if p.label is not None:
            label_of[p.index0] = p.label
    hidden = [f.column for f in (doc.field_acl or [])]
    full_row_acl: list[str] = []
    if doc.field_acl:
        full_row_acl = doc.field_acl[0].principals[:]
        for f in doc.field_acl[1:]:
            full_row_acl = [p for p in full_row_acl if p in f.principals]
        full_row_acl.sort(key=_by_cp)

    chunks: list[KbChunk] = []
    stack: list[_StackEntry] = []
    buf: _TextBuf | None = None
    table: _TableBuf | None = None
    footnotes: list[_Footnote] = []

    def push(
        text: str,
        kind: Literal["text", "table_row"],
        p0: int,
        p1: int,
        path: list[str],
        acl: list[str] | None,
    ) -> None:
        chunks.append(
            KbChunk(
                id=f"{doc.doc_id}#{str(len(chunks)).rjust(2, '0')}",
                doc_id=doc.doc_id,
                tenant=doc.tenant,
                text=text,
                heading_path=path,
                pages=(p0, p1),
                page_labels=(label_of.get(p0), label_of.get(p1)),
                acl=None if acl is None else acl[:],
                version=doc.version,
                gen=gen,
                kind=kind,
            )
        )

    def flush_text() -> None:
        nonlocal buf
        if buf is not None and buf.texts:
            push("\n".join(buf.texts), "text", buf.p0, buf.p1, buf.path, doc.acl)
        buf = None

    def flush_table() -> None:
        nonlocal table
        if table is None:
            return
        rows = render(table.t, hidden)
        for i, r in enumerate(rows):
            push(r, "table_row", table.row_pages[i], table.row_pages[i], table.path, doc.acl)
        if hidden:
            full = render(table.t, [])
            for i, r in enumerate(full):
                push(
                    r, "table_row", table.row_pages[i], table.row_pages[i], table.path, full_row_acl
                )
        table = None

    def path() -> list[str]:
        return [s.entry for s in stack]

    for p in pages:
        for b in p.blocks:
            if b.kind == "footnote":
                footnotes.append(_Footnote(text=strip_bom(b.text), page=p.index0))
                continue
            if b.kind == "table" and b.table is not None:
                if b.continues_prev and table is not None:
                    for r in b.table.rows:
                        table.t.rows.append(r[:])
                        table.row_pages.append(p.index0)
                    continue
                if buf is not None and buf.body == 0:
                    buf = None
                flush_text()
                flush_table()
                table = _TableBuf(
                    t=TableData(
                        caption=b.table.caption,
                        header_rows=[r[:] for r in b.table.header_rows],
                        rows=[r[:] for r in b.table.rows],
                    ),
                    row_pages=[p.index0 for _ in b.table.rows],
                    path=path(),
                )
                continue
            text = strip_bom(b.text)
            if b.continues_prev and buf is not None:
                buf.texts[-1] += text
                buf.chars += cp_len(text)
                buf.p1 = p.index0
                continue
            flush_table()
            h = heading(text)
            if h is not None:
                if buf is not None and buf.body > 0:
                    flush_text()
                while stack and stack[-1].level >= h.level:
                    stack.pop()
                entry = (
                    trim_spaces(text) if cp_len(trim_spaces(text)) <= HEADING_ENTRY_MAX else h.label
                )
                stack.append(_StackEntry(level=h.level, entry=entry))
                if buf is None:
                    buf = _TextBuf(texts=[], body=0, chars=0, p0=p.index0, p1=p.index0, path=[])
                buf.texts.append(text)
                buf.chars += cp_len(text)
                buf.p1 = p.index0
                buf.path = path()
                if cp_len(trim_spaces(text)) > HEADING_ENTRY_MAX:
                    buf.body += 1
                continue
            if buf is not None and buf.body > 0 and buf.chars + cp_len(text) > max_chars:
                flush_text()
            if buf is None:
                buf = _TextBuf(texts=[], body=0, chars=0, p0=p.index0, p1=p.index0, path=path())
            buf.texts.append(text)
            buf.chars += cp_len(text)
            buf.p1 = p.index0
            buf.body += 1
    flush_text()
    flush_table()

    for fn in footnotes:
        marker = fn.text[0] if fn.text else ""
        targets = [c for c in chunks if marker in c.text] if _CIRCLED.search(marker) else []
        if not targets:
            on_page = [c for c in chunks if c.pages[0] <= fn.page <= c.pages[1]]
            targets = [on_page[-1]] if on_page else [chunks[-1]] if chunks else []
        for c in targets:
            c.text += f"\n{fn.text}"
    return chunks


def cite_locator(c: KbChunk) -> str:
    """引用定位：只有这一个函数负责把内部坐标换成给人看的页码。
      有印刷页码：「p. ii」「pp. 2–3」；没有：「第 1 页」「第 3–4 页」（物理页序 + 1）
    ★ 内部 0 起、CLI 1 起、阅读器 1 起、印刷页码另有一套——存的时候分开存，显示的时候只在这里换算。
    """
    a, b = c.pages
    la, lb = c.page_labels
    if la is not None and lb is not None:
        return f"p. {la}" if a == b else f"pp. {la}–{lb}"
    return f"第 {a + 1} 页" if a == b else f"第 {a + 1}–{b + 1} 页"


# ─────────────────────────────────────────────────────────────
# D. 权限
# ─────────────────────────────────────────────────────────────

PrincipalKind = Literal["user", "group", "ext_group"]


def principal_key(kind: PrincipalKind, name: str, source: str | None = None) -> str:
    """「类型:名字」，ASCII 小写。外部组再带来源：「ext_group:confluence/eng」。
    ★ 没有前缀，名叫 alice@qinghe.com 的组和用户 alice@qinghe.com 就是同一个 principal。
    """
    n = ascii_lower(trim_spaces(name))
    if kind == "ext_group":
        if not source:
            raise ValueError("ext_group 必须带来源系统")
        return f"ext_group:{ascii_lower(trim_spaces(source))}/{n}"
    return f"{kind}:{n}"


class HasAcl(Protocol):
    @property
    def acl(self) -> list[str] | None: ...


def acl_visible(c: HasAcl, principals: list[str]) -> bool:
    """★ fail-closed：缺 acl 的 chunk 谁都看不见。「没写权限 = 公开」是最常见的越权来源。"""
    if c.acl is None:
        return False
    return any(p in principals for p in c.acl)


def can_see(c: KbChunk, s: Session) -> bool:
    return c.tenant == s.tenant and acl_visible(c, s.principals)


def visible_to_all(c: KbChunk, sessions: list[Session]) -> bool:
    """★ 多人会话（群聊、共享屏幕）：按在场所有人的交集检索，不是按提问者。"""
    return len(sessions) > 0 and all(can_see(c, s) for s in sessions)


@dataclass(frozen=True)
class AnnHit:
    id: str
    score: float


FilterMode = Literal["post", "pre", "iterative"]


@dataclass(frozen=True)
class FilterOpts:
    k: int
    #: ANN 候选数（hnsw.ef_search）。
    ef: int
    mode: FilterMode
    #: 迭代扫描的上限（hnsw.max_scan_tuples）。
    max_scan: int


@dataclass
class FilteredSearch:
    ids: list[str]
    #: 碰过多少个候选：代价。
    scanned: int


def search_filtered(
    ranked: list[AnnHit], visible: Callable[[str], bool], o: FilterOpts
) -> FilteredSearch:
    """ranked 是 ANN 给出的顺序（这里用精确排序代替），visible 是权限判定。
      post      取前 ef 个候选再按权限过滤：安全，但可能远少于 k 条（ACL 写成 WHERE 的默认行为）
      pre       先过滤再取前 k（knn.filter 的语义）
      iterative 不够 k 条就把 ef 再加一份，直到够了或碰到 max_scan

    ★ 后过滤不报错、不越权，安全审计全绿——召回塌到 0 条只能靠「按身份分层」的评测发现。
    ★ 迭代扫描必须有上限；不够 k 条时宁可少给，也不能拿越权的凑数。
    """
    total = len(ranked)
    if o.mode == "pre":
        ids: list[str] = []
        for h in ranked:
            if len(ids) >= o.k:
                break
            if visible(h.id):
                ids.append(h.id)
        return FilteredSearch(ids=ids, scanned=total)

    def take(n: int) -> list[str]:
        return [h.id for h in ranked[:n] if visible(h.id)]

    if o.mode == "post":
        n = min(o.ef, total)
        return FilteredSearch(ids=take(n)[: o.k], scanned=n)
    cap = min(o.max_scan, total)
    ef = min(o.ef, cap)
    got = take(ef)
    while len(got) < o.k and ef < cap:
        ef = min(ef + o.ef, cap)
        got = take(ef)
    return FilteredSearch(ids=got[: o.k], scanned=ef)


RerankOrder = Literal["filter-first", "rerank-first"]


@dataclass
class RerankResult:
    ids: list[str]
    #: 发给外部 reranker 的候选——它们的全文离开了你的边界。
    exposed: list[str]


def rerank_pipeline(
    cands: list[AnnHit],
    visible: Callable[[str], bool],
    order: RerankOrder,
    reranker: Callable[[list[str]], list[float]],
    k: int,
) -> RerankResult:
    """候选 → 外部 reranker → 取前 k。reranker 收到一组 id（代表全文），返回同样长度的分数。
      filter-first  先按权限过滤再发给 reranker
      rerank-first  全部发出去，回来再过滤
    两种顺序的 ids 完全一样。
    ★ 「结果一样」不等于「安全一样」：安全边界是数据流向，不是最终答案。
    """
    if order == "filter-first":
        send = [h.id for h in cands if visible(h.id)]
    else:
        send = [h.id for h in cands]
    scores = reranker(send)
    if len(scores) != len(send):
        raise ValueError("reranker 返回的分数个数不对")
    idx = sorted(
        range(len(send)),
        key=cmp_to_key(lambda a, b: (scores[b] - scores[a]) or cmp_code_point(send[a], send[b])),
    )
    ids = [send[i] for i in idx]
    if order == "rerank-first":
        ids = [i for i in ids if visible(i)]
    return RerankResult(ids=ids[:k], exposed=send)


@dataclass(frozen=True)
class KnnFilter:
    tenant: str
    acl_any: list[str]


@dataclass(frozen=True)
class Knn:
    k: int
    filter: KnnFilter


@dataclass(frozen=True)
class SearchRequest:
    query: str
    k: int
    knn: Knn


TOOL_ARGS = ["query", "k"]


def build_search_request(tool_args: dict[str, Any], s: Session) -> SearchRequest:
    """模型的工具参数 → 检索请求。权限只能从会话来。
    ★ 工具参数里出现 filter、user_groups、doc_ids、tenant 之类的字段一律拒绝：它们是模型写的，
    也就是 prompt injection 写的（接 L14「参数才是攻击面」）。按 doc id 直接取文档同样绕过 ACL。
    ★ ACL 放在 knn.filter 里面（预过滤），不能放在外层 filter / post_filter
    （后过滤，可能少于 k 条）。
    """
    for key in tool_args:
        if key not in TOOL_ARGS:
            raise ValueError(f"工具参数里不允许出现 {key}：权限只能来自会话")
    query = tool_args.get("query")
    if not isinstance(query, str) or trim_spaces(query) == "":
        raise ValueError("query 必须是非空字符串")
    k = tool_args["k"] if "k" in tool_args else 5
    # JS 的 typeof k === 'number' 不含布尔；Number.isInteger(3.0) 为真。
    if (
        isinstance(k, bool)
        or not isinstance(k, int | float)
        or not float(k).is_integer()
        or k < 1
        or k > 20
    ):
        raise ValueError("k 必须是 1–20 的整数")
    k = int(k)
    return SearchRequest(
        query=query,
        k=k,
        knn=Knn(k=k, filter=KnnFilter(tenant=s.tenant, acl_any=s.principals[:])),
    )


# ─────────────────────────────────────────────────────────────
# E. 词法检索与多租户统计
# ─────────────────────────────────────────────────────────────


def kb_tokenize(s: str) -> list[str]:
    """先 normalize_text 再用 L09 的 tokenize：
    L09 的字符类不含全角数字，「第３条」会只剩「第、条」。"""
    return tokenize(normalize_text(s))


@dataclass(frozen=True)
class TDoc:
    id: str
    tenant: str
    text: str


def _by_score(x: AnnHit, y: AnnHit) -> float:
    return (y.score - x.score) or cmp_code_point(x.id, y.id)


def bm25_rank(
    docs: list[TDoc],
    stat_docs: list[TDoc],
    query: str,
    tok: Callable[[str], list[str]] = kb_tokenize,
    k1: float = 1.5,
    b: float = 0.75,
) -> list[AnnHit]:
    """和 L09 同式的 BM25，但统计量（df、N、平均长度）来自 stat_docs——可以和被打分的 docs 不同。
    这正是要观察的东西：共享索引的统计量、软删除留下的统计量。
    """
    if len(stat_docs) == 0:
        return []
    df: dict[str, int] = {}
    total_len = 0
    for d in stat_docs:
        ts = tok(d.text)
        total_len += len(ts)
        for t in dict.fromkeys(ts):
            df[t] = df.get(t, 0) + 1
    n_docs = len(stat_docs)
    avg = total_len / n_docs
    q = list(dict.fromkeys(tok(query)))
    rows: list[AnnHit] = []
    for d in docs:
        ts = tok(d.text)
        tf: dict[str, int] = {}
        for t in ts:
            tf[t] = tf.get(t, 0) + 1
        score = 0.0
        for t in q:
            f = tf.get(t)
            if not f:
                continue
            n = df.get(t, 0)
            idf = math.log(1 + (n_docs - n + 0.5) / (n + 0.5))
            score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len(ts)) / avg)))
        if score > 0:
            rows.append(AnnHit(id=d.id, score=score))
    return sorted(rows, key=cmp_to_key(_by_score))


StatScope = Literal["shared", "per-tenant"]


def tenant_search(
    all_: list[TDoc], scope: StatScope, query: str, tenant: str, k: int
) -> list[AnnHit]:
    """shared     一个索引、按 tenant 过滤结果：别的租户的文档在改你的 IDF
    per-tenant 每个租户自己的统计量：和「只用这个租户的文档单独建索引」逐位相等
    ★ 加了 tenant_id 过滤不等于隔离：结果里没有别人的文档，排序却是别人决定的。
    """
    own = [d for d in all_ if d.tenant == tenant]
    if scope == "per-tenant":
        return bm25_rank(own, own, query)[:k]
    own_ids = {d.id for d in own}
    return [h for h in bm25_rank(all_, all_, query) if h.id in own_ids][:k]


def chunk_docs(chunks: list[KbChunk]) -> list[TDoc]:
    return [TDoc(id=c.id, tenant=c.tenant, text=c.text) for c in chunks]


SearchFn = Callable[[list[AnnHit], Callable[[str], bool], FilterOpts], FilteredSearch]


def search_kb(
    chunks: list[KbChunk],
    query: str,
    s: Session,
    o: FilterOpts,
    search: SearchFn = search_filtered,
) -> list[KbChunk]:
    """在 chunk 上做一次带权限的词法检索：BM25 给顺序，search_filtered 管权限。"""
    docs = chunk_docs(chunks)
    by_id = {c.id: c for c in chunks}
    ranked = bm25_rank(docs, docs, query)
    return [by_id[i] for i in search(ranked, lambda i: can_see(by_id[i], s), o).ids]


# ─────────────────────────────────────────────────────────────
# F. 版本
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class VersionCand:
    doc_id: str
    version: VersionMeta


@dataclass(frozen=True)
class VersionVerdict:
    chosen: str | None
    conflict: bool
    reason: str


def _is_live(v: VersionMeta, as_of: str) -> bool:
    return (
        v.effective_from is not None
        and v.effective_from <= as_of
        and not (v.repealed_at is not None and v.repealed_at <= as_of)
    )


def _effective(c: VersionCand) -> str:
    return c.version.effective_from if c.version.effective_from is not None else ""


def _newest_first(a: VersionCand, b: VersionCand) -> int:
    ea = _effective(a)
    eb = _effective(b)
    if ea != eb:
        return 1 if ea < eb else -1
    if a.version.issued != b.version.issued:
        return 1 if a.version.issued < b.version.issued else -1
    return cmp_code_point(a.doc_id, b.doc_id)


_by_newest = cmp_to_key(_newest_first)


def resolve_versions(cands: list[VersionCand], as_of: str) -> VersionVerdict:
    """同一 family 的几个版本，在 as_of 这一天该用哪一个。日期都是 YYYY-MM-DD，按字典序比。
      1. 缺 effective_from 的不参与自动消解（写进 reason）
      2. 只留 as_of 当天已生效、未废止的
      3. 上位优先：只看 level 最小的；还有下位版本在场 → conflict（下位冲突需标注）
      4. 同级里既有特别规定又有一般规定：一般的更新 → chosen = None、conflict
         （立法法第一百零五条：交人裁决）；否则特别的优先
      5. 否则取生效日最新的
    ★ 按 mtime 取最新：旧版重新编辑一下就「最新」了。按 issued 取最新：未生效的新办法提前上岗。
    ★ 必须在权限过滤之后、对每个用户分别做：研发部的人看得见特别规定，别人看不见，答案就不同。
    """
    notes: list[str] = []
    missing = sorted((c.doc_id for c in cands if c.version.effective_from is None), key=_by_cp)
    if missing:
        notes.append(f"{'、'.join(missing)} 缺 effectiveFrom，不参与自动消解")
    live = [c for c in cands if _is_live(c.version, as_of)]
    if not live:
        return VersionVerdict(
            chosen=None, conflict=False, reason="；".join(["没有在 asOf 生效的版本", *notes])
        )
    top = live[0].version.level
    for c in live:
        if c.version.level < top:
            top = c.version.level
    lv = [c for c in live if c.version.level == top]
    lower = len(live) - len(lv)
    if lower > 0:
        notes.append(f"上位优先，{lower} 份下位规定冲突需标注")
    sp = sorted((c for c in lv if c.version.special), key=_by_newest)
    gen = sorted((c for c in lv if not c.version.special), key=_by_newest)
    if sp and gen:
        if _effective(gen[0]) > _effective(sp[0]):
            head = f"新的一般规定 {gen[0].doc_id} 晚于旧的特别规定 {sp[0].doc_id}，不能自动裁决"
            return VersionVerdict(chosen=None, conflict=True, reason="；".join([head, *notes]))
        return VersionVerdict(
            chosen=sp[0].doc_id, conflict=lower > 0, reason="；".join(["特别规定优先", *notes])
        )
    pick = sorted(lv, key=_by_newest)[0]
    return VersionVerdict(
        chosen=pick.doc_id, conflict=lower > 0, reason="；".join(["取生效日最新的", *notes])
    )


def _mtime_newest_first(a: VersionCand, b: VersionCand) -> int:
    if a.version.mtime != b.version.mtime:
        return 1 if a.version.mtime < b.version.mtime else -1
    return cmp_code_point(a.doc_id, b.doc_id)


def pick_by_mtime(cands: list[VersionCand]) -> str | None:
    """对照组：按 mtime 取最新。"""
    if not cands:
        return None
    return sorted(cands, key=cmp_to_key(_mtime_newest_first))[0].doc_id


def pick_by_effective(cands: list[VersionCand], as_of: str) -> str | None:
    """对照组：只看生效日（懂 as_of，不懂上位 / 特别）。"""
    live = sorted((c for c in cands if _is_live(c.version, as_of)), key=_by_newest)
    return live[0].doc_id if live else None


class HasGen(Protocol):
    @property
    def gen(self) -> Gen: ...


def assert_single_embedder(hits: Sequence[HasGen]) -> None:
    """★ 不同代的向量不可比：一次检索的结果里混了两个 embedder，分数排序就没有意义。"""
    seen = sorted(dict.fromkeys(h.gen.embedder for h in hits), key=_by_cp)
    if len(seen) > 1:
        raise ValueError(f"检索结果混入了 {len(seen)} 代 embedding：{'、'.join(seen)}")


# ─────────────────────────────────────────────────────────────
# G. 同步
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SyncChunk:
    id: str
    #: 源文档 id。
    src: str
    #: 内容 hash。
    hash: str


SyncMode = Literal["none", "incremental", "full", "tombstone"]


def sync_key(c: SyncChunk) -> str:
    return f"{c.src}:{c.hash}"


def apply_sync(
    index: list[SyncChunk], batch: list[SyncChunk], tombstones: list[str], mode: SyncMode
) -> list[SyncChunk]:
    """一轮同步：batch 是这次 loader 拿回来的 chunk，tombstones 是源系统明确告知「已删除」的文档。
      none         只写不删（LangChain cleanup=None、LlamaIndex UPSERTS 的默认）
      incremental  对这次见过的源文档，删掉它不在本批里的旧 chunk——
                   整篇被删的文档永远不会被见到，于是永远残留
      full         删掉本批里没有的一切——loader 部分失败（权限过期、超时）时误删
      tombstone    incremental + 按墓碑删整篇
    结果按 sync_key 排序。
    ★ 「这次没看到」不等于「被删了」。删除要靠显式事件。
    """
    idx: dict[str, SyncChunk] = {}
    for c in index:
        idx[sync_key(c)] = c
    seen_src = {c.src for c in batch}
    seen_key = {sync_key(c) for c in batch}
    for c in batch:
        idx[sync_key(c)] = c
    for k, c in list(idx.items()):
        if mode == "incremental" and c.src in seen_src and k not in seen_key:
            del idx[k]
        elif mode == "full" and k not in seen_key:
            del idx[k]
        elif mode == "tombstone" and (
            c.src in tombstones or (c.src in seen_src and k not in seen_key)
        ):
            del idx[k]
    return sorted(
        idx.values(), key=cmp_to_key(lambda a, b: cmp_code_point(sync_key(a), sync_key(b)))
    )


@dataclass(frozen=True)
class ReindexPlan:
    reparse: bool
    rechunk: bool
    reembed: bool
    #: 只改 payload（acl、版本元数据），不碰向量。
    payload_only: bool
    delete_all: bool


def _payload_of(d: ParsedDoc) -> str:
    return json_stringify([d.title, d.acl, d.field_acl, d.version])


def plan_reindex(
    old_doc: ParsedDoc | None, new_doc: ParsedDoc | None, old_gen: Gen, new_gen: Gen
) -> ReindexPlan:
    """什么变了，就重做哪一段：
      文档没了 → delete_all · 新文档或内容变了或 parser 换了 → 全部重做
      chunker 换了 → rechunk + reembed · embedder 换了 → 只 reembed
      只有 acl / 版本元数据变了 → payload_only
    ★ 把 acl 算进内容 hash（LangChain 的 doc hash 含 metadata）：
    改一次权限就重新 embedding 全部 chunk。
    ★ 换 parser 要 reparse，不是 rechunk：旧的解析结果不会自己更新。
    """
    none = ReindexPlan(
        reparse=False, rechunk=False, reembed=False, payload_only=False, delete_all=False
    )
    if new_doc is None:
        return replace(none, delete_all=True) if old_doc is not None else none
    if old_doc is None:
        return replace(none, reparse=True, rechunk=True, reembed=True)
    content_changed = json_stringify(old_doc.pages) != json_stringify(new_doc.pages)
    if content_changed or old_gen.parser != new_gen.parser:
        return replace(none, reparse=True, rechunk=True, reembed=True)
    if old_gen.chunker != new_gen.chunker:
        return replace(none, rechunk=True, reembed=True)
    if old_gen.embedder != new_gen.embedder:
        return replace(none, reembed=True)
    if _payload_of(old_doc) != _payload_of(new_doc):
        return replace(none, payload_only=True)
    return none


# ─────────────────────────────────────────────────────────────
# H. 缓存键与入库门禁
# ─────────────────────────────────────────────────────────────


def cache_key(query: str, principals: list[str], corpus_version: str) -> str:
    """语义缓存 / 答案缓存的键：规范化后的 query + 排序去重后的 principals + 语料版本。
    ★ 不含 principals：HR 问过的答案被实习生命中。principals 不排序去重：同样的权限拿到不同的键。
    不含语料版本：撤了权、删了文档，缓存还在给旧答案。
    """
    ps = sorted(dict.fromkeys(principals), key=_by_cp)
    return "\u001f".join([trim_spaces(normalize_text(query)), ",".join(ps), corpus_version])


@dataclass(frozen=True)
class GateCheck:
    code: str
    label: str


GATE_CHECKS: list[GateCheck] = [
    GateCheck(code="NO_ACL", label="缺 acl"),
    GateCheck(code="NO_EFFECTIVE_FROM", label="缺 effectiveFrom"),
    GateCheck(code="EMPTY_PAGE", label="空白页"),
    GateCheck(code="FOOTNOTE_MISSING", label="脚注丢失"),
    GateCheck(code="TABLE_NO_HEADER", label="表格无表头"),
    GateCheck(code="REPLACEMENT_CHAR", label="替换字符"),
]


@dataclass(frozen=True)
class GateResult:
    pass_: bool
    issues: list[str]


def quality_gate(doc: ParsedDoc) -> GateResult:
    """解析器不抛异常，所以入库前要自己查。返回命中的检查（按 GATE_CHECKS 的顺序）。
    EMPTY_PAGE        某页没有任何文本或表格（扫描件没过 OCR？）
    FOOTNOTE_MISSING  正文里有带圈序号，文档里却一个脚注块都没有（解析器默认丢脚注）
    TABLE_NO_HEADER   表格没有表头，且不是跨页表格的后半段
    REPLACEMENT_CHAR  出现 U+FFFD（编码错了）
    """
    hit: set[str] = set()
    if not doc.acl:
        hit.add("NO_ACL")
    if doc.version.effective_from is None:
        hit.add("NO_EFFECTIVE_FROM")
    footnotes = 0
    marked = False
    for p in doc.pages:
        has_content = any(
            (b.kind == "table" and b.table is not None) or trim_spaces(b.text) != ""
            for b in p.blocks
        )
        if not has_content:
            hit.add("EMPTY_PAGE")
        for b in p.blocks:
            texts = [b.text]
            if b.table is not None:
                texts.append(b.table.caption)
                texts.extend(x for r in b.table.header_rows for x in r)
                texts.extend(x for r in b.table.rows for x in r)
            if b.kind == "footnote":
                footnotes += 1
            elif any(_CIRCLED.search(t) for t in texts):
                marked = True
            if any("\ufffd" in t for t in texts):
                hit.add("REPLACEMENT_CHAR")
            if (
                b.kind == "table"
                and b.table is not None
                and not b.continues_prev
                and len(b.table.header_rows) == 0
            ):
                hit.add("TABLE_NO_HEADER")
    if marked and footnotes == 0:
        hit.add("FOOTNOTE_MISSING")
    issues = [c for c in (g.code for g in GATE_CHECKS) if c in hit]
    return GateResult(pass_=len(issues) == 0, issues=issues)
