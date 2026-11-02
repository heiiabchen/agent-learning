r"""参考实现：浏览器 agent 的感知层——快照、ref、坐标、可见性、图片 token、浏览器特有的 sink。
shared/browse.ts 的 Python 镜像。

这一课的主线只有一句：
  **模型看到的页面 ≠ 用户看到的页面 ≠ 实际被执行的那个元素。**
下面每一个函数都在量其中一个差。

不起浏览器、不调模型、不引新依赖。输入是手写的「假页面」（l14x/fixtures/pages.json），
规则是对 Playwright 1.64 注入脚本、Playwright MCP 0.0.83、browser-use 0.13.11 和三家厂商文档的
可读重写，出处标在注释里（§ 是 research/L14x-browser-multimodal.md 的章节号）。

★ 两门语言逐字节一致：打印出来的数全是整数；四舍五入只用 round_half_up（整数运算）——
  Python 的 round(2.5) 是 2，JS 的 Math.round(2.5) 是 3。

─── Python 侧的差异 ───────────────────────────────────────────

天然就对的：
  · Math.floor(a / b) 就是 a // b，负数也一样（// 向下取整；int() 是截断，不能用）。
  · dict 保插入序：快照的 refs 和 TS 的 Map 一样，按「子节点先于父节点」的顺序写入。
  · find / 切片只在 ASCII 字符（/ ? # @ : .）处切：UTF-16 下标和码点下标不同，切出来的子串相同。

反而要小心的：
  · 页面来自 JSON，没写的字段读成 None。判断一律写 is None / is not None：
    font_size 为 0、opacity 为 0 都是「写了」，真值判断会把它们当成没写。
  · 正则的 $ 还匹配「末尾换行之前」，REF_RE 用 \Z；不用 \d（Python 的 \d 认全角数字）。
  · 小写只动 ASCII（_ascii_lower），不用 str.lower()。
  · 图片 token 里有真浮点（缩放比例、sqrt）：两边都是 IEEE 754 双精度、同样的运算顺序，结果一致。
    两边都是整数的 Math.ceil(a / b) 写成 -(-a // b)。
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal, TypeVar

from shared.context_budget import estimate_tokens as estimate_tokens
from shared.guard import Channel as Channel
from shared.guard import ChannelReport as ChannelReport
from shared.guard import audit_channels as audit_channels
from shared.guard import display_matches_execution as display_matches_execution

_T = TypeVar("_T")

# ─────────────────────────────────────────────────────────────
# 一、假页面
# ─────────────────────────────────────────────────────────────

# [x, y, w, h]：CSS 像素、整数。顶层节点是文档坐标；iframe 里的节点相对 iframe 自己的左上角。
Rect = tuple[int, int, int, int]


@dataclass(frozen=True, kw_only=True)
class NodeStyle:
    display: Literal["none"] | None = None
    visibility: Literal["hidden"] | None = None
    # 0..100 的整数，避免浮点。
    opacity: int | None = None
    # '#rrggbb'
    color: str | None = None
    # '#rrggbb' | 'transparent'
    background: str | None = None
    font_size: int | None = None
    pointer_events: Literal["none"] | None = None
    # transform: scale(0) 之类：DOM 里有尺寸，渲染出来是 0×0。
    zero_box: bool | None = None
    # clip / clip-path 把它裁没了（sr-only 就是这一类）。
    clip: bool | None = None
    # position: fixed：坐标是视口坐标，不随滚动。
    fixed: bool | None = None


_NO_STYLE = NodeStyle()


@dataclass
class Shadow:
    mode: Literal["open", "closed"]
    children: list[FakeNode]


@dataclass(kw_only=True)
class Frame:
    origin: str
    children: list[FakeNode]
    error: bool | None = None


@dataclass(kw_only=True)
class FakeNode:
    # 节点身份。Playwright 把 ref 挂在 DOM 节点的 expando 上，这里用 id 模拟「同一个 DOM 节点」。
    id: str
    role: str
    # 节点自带的文字。canvas 的 text 表示「画在像素里的字」，不在 DOM 里。
    text: str | None = None
    aria_label: str | None = None
    title: str | None = None
    alt: str | None = None
    aria_hidden: bool | None = None
    hidden_attr: bool | None = None
    # 关闭的 <details>：除了 summary，子节点都藏住。
    details_closed: bool | None = None
    style: NodeStyle | None = None
    bbox: Rect | None = None
    # 绘制顺序，hit-test 用；不写继承祖先，默认 0。
    z: int | None = None
    children: list[FakeNode] | None = None
    shadow: Shadow | None = None
    # iframe 的内容。iframe 自己的 bbox 就是它在父文档里的位置。
    frame: Frame | None = None


@dataclass(frozen=True)
class Size:
    w: int
    h: int


@dataclass(frozen=True)
class WebMcpTool:
    name: str
    description: str


@dataclass(kw_only=True)
class FakePage:
    url: str
    viewport: Size
    dpr: int
    scroll_y: int
    # 导航计数：模拟 Playwright 注入脚本的 _frameSeq，决定 ref 前缀 f<n>。首次加载是 0。
    doc_seq: int
    root: FakeNode
    webmcp_tools: list[WebMcpTool] | None = None


# ── JSON：TS 那边 JSON.parse 之后直接当类型用，这里要显式转成 dataclass ──


def _style_from_json(s: dict[str, Any]) -> NodeStyle:
    return NodeStyle(
        display=s.get("display"),
        visibility=s.get("visibility"),
        opacity=s.get("opacity"),
        color=s.get("color"),
        background=s.get("background"),
        font_size=s.get("fontSize"),
        pointer_events=s.get("pointerEvents"),
        zero_box=s.get("zeroBox"),
        clip=s.get("clip"),
        fixed=s.get("fixed"),
    )


def node_from_json(d: dict[str, Any]) -> FakeNode:
    style = d.get("style")
    b = d.get("bbox")
    kids = d.get("children")
    sh = d.get("shadow")
    fr = d.get("frame")
    return FakeNode(
        id=d["id"],
        role=d["role"],
        text=d.get("text"),
        aria_label=d.get("ariaLabel"),
        title=d.get("title"),
        alt=d.get("alt"),
        aria_hidden=d.get("ariaHidden"),
        hidden_attr=d.get("hiddenAttr"),
        details_closed=d.get("detailsClosed"),
        style=None if style is None else _style_from_json(style),
        bbox=None if b is None else (b[0], b[1], b[2], b[3]),
        z=d.get("z"),
        children=None if kids is None else [node_from_json(c) for c in kids],
        shadow=None
        if sh is None
        else Shadow(mode=sh["mode"], children=[node_from_json(c) for c in sh["children"]]),
        frame=None
        if fr is None
        else Frame(
            origin=fr["origin"],
            children=[node_from_json(c) for c in fr["children"]],
            error=fr.get("error"),
        ),
    )


def page_from_json(d: dict[str, Any]) -> FakePage:
    vp = d["viewport"]
    tools = d.get("webmcpTools")
    return FakePage(
        url=d["url"],
        viewport=Size(w=vp["w"], h=vp["h"]),
        dpr=d["dpr"],
        scroll_y=d["scrollY"],
        doc_seq=d["docSeq"],
        root=node_from_json(d["root"]),
        webmcp_tools=None
        if tools is None
        else [WebMcpTool(name=t["name"], description=t["description"]) for t in tools],
    )


@dataclass(frozen=True)
class Located:
    """walk() 的一项：节点和它在页面里的位置。"""

    node: FakeNode
    # 祖先，从 root 开始，不含自己。iframe 节点也算祖先。
    path: list[FakeNode]
    # 所在 frame 的 origin。
    origin: str
    # 所在 frame 左上角在顶层文档里的位置。
    offset: tuple[int, int]
    # 在 closed shadow root 里：浏览器照样画出来，但页面脚本（以及 Playwright 的快照）拿不到。
    closed_shadow: bool


def origin_of(url: str) -> str:
    i = url.find("://")
    if i < 0:
        return url
    j = len(url)
    for c in ["/", "?", "#"]:
        k = url.find(c, i + 3)
        if 0 <= k < j:
            j = k
    return url[:j]


def walk(page: FakePage) -> list[Located]:
    """文档顺序：自己 → shadow 里的 → 子节点 → iframe 里的。"""
    out: list[Located] = []

    def visit(
        n: FakeNode, path: list[FakeNode], origin: str, offset: tuple[int, int], closed: bool
    ) -> None:
        out.append(Located(node=n, path=path, origin=origin, offset=offset, closed_shadow=closed))
        sub = [*path, n]
        if n.shadow is not None:
            for c in n.shadow.children:
                visit(c, sub, origin, offset, closed or n.shadow.mode == "closed")
        for c in n.children or []:
            visit(c, sub, origin, offset, closed)
        if n.frame is not None:
            b = n.bbox if n.bbox is not None else (0, 0, 0, 0)
            off = (offset[0] + b[0], offset[1] + b[1])
            for c in n.frame.children:
                visit(c, sub, n.frame.origin, off, False)

    visit(page.root, [], origin_of(page.url), (0, 0), False)
    return out


def find_node(page: FakePage, id_: str) -> Located | None:
    for loc in walk(page):
        if loc.node.id == id_:
            return loc
    return None


def collapse_spaces(s: str) -> str:
    return " ".join(p for p in s.split(" ") if p != "")


def _style(n: FakeNode) -> NodeStyle:
    return n.style if n.style is not None else _NO_STYLE


# ─────────────────────────────────────────────────────────────
# 二、快照：模型看到的页面（§2.1–2.7）
# ─────────────────────────────────────────────────────────────

SnapshotMode = Literal["ai", "default"]


@dataclass(frozen=True)
class Inherited:
    """从祖先继承下来的两件事。"""

    # 祖先里有 display:none / visibility:hidden / hidden 属性，或者在关闭的 <details> 里。
    hidden_for_all: bool
    # 祖先里有 aria-hidden。
    aria_hidden: bool


ROOT_INHERITED = Inherited(hidden_for_all=False, aria_hidden=False)


def self_hidden(n: FakeNode) -> bool:
    """自己是不是「两种快照都排除」的那一类。只有这四种是真藏住了（§2.2 表的最后一行）。"""
    s = _style(n)
    return s.display == "none" or s.visibility == "hidden" or n.hidden_attr is True


def child_inherited(parent: FakeNode, anc: Inherited, child: FakeNode) -> Inherited:
    return Inherited(
        hidden_for_all=anc.hidden_for_all
        or self_hidden(parent)
        or (parent.details_closed is True and child.role != "summary"),
        aria_hidden=anc.aria_hidden or parent.aria_hidden is True,
    )


def inherited_of(loc: Located) -> Inherited:
    anc = ROOT_INHERITED
    chain = [*loc.path, loc.node]
    for i in range(len(chain) - 1):
        p = chain[i]
        # iframe 里是另一个文档：继承从头算。
        anc = ROOT_INHERITED if p.frame is not None else child_inherited(p, anc, chain[i + 1])
    return anc


def has_box(n: FakeNode) -> bool:
    """有没有一个非空的盒子。不要求在视口里——这就是长页面快照爆 token 的根因（§2.7）。"""
    b = n.bbox
    return b is not None and b[2] > 0 and b[3] > 0 and _style(n).zero_box is not True


def is_aria_visible(n: FakeNode, anc: Inherited, mode: SnapshotMode) -> bool:
    """TODO 1 的参考实现。

    Playwright 源码：ai 模式是 `visibility: 'ariaOrVisible'`——「对辅助技术可见」或「视觉上可见」**任一**成立就收；
    default 模式是 `'aria'`——只看对辅助技术可不可见。

    ★ 「对辅助技术可见」只看 display / visibility / hidden / aria-hidden，**不看透明度、裁剪、颜色、字号、
      在不在视口里**。所以 sr-only、opacity:0、白字白底、font-size:0、离屏文字两种模式都收（INV-1）。
    ★ aria-hidden 但画在屏幕上的：default 不收，ai 收（INV-3）。两种模式不是「格式不同」，是规则不同。
    """
    if anc.hidden_for_all or self_hidden(n):
        return False
    aria_hidden = anc.aria_hidden or n.aria_hidden is True
    if not aria_hidden:
        return True
    return mode == "ai" and has_box(n)


# 名字取自内容的角色（accname 规范的 name from content）。paragraph、generic、listitem 不在里面。
NAME_FROM_CONTENT = ["button", "link", "heading", "tab", "menuitem", "option", "cell"]


def text_content(n: FakeNode) -> str:
    """子树里的 DOM 文字。canvas 里画的字不是 DOM，藏住的子树不算。"""
    parts: list[str] = []

    def visit(x: FakeNode) -> None:
        if x.role == "canvas" or self_hidden(x):
            return
        if x.text is not None:
            parts.append(x.text)
        for c in x.children or []:
            visit(c)

    visit(n)
    return collapse_spaces(" ".join(parts))


def accessible_name(n: FakeNode) -> str:
    """TODO 2 的参考实现。aria-label > img 的 alt > 内容（只对 NAME_FROM_CONTENT 的角色）> title。

    ★ aria-label 整段**替换**可见文字成为名字：人眼看到 "Buy"，模型看到一整句指令（INV-2）。
    ★ title 是最后的回退：按钮已经有文字时，Playwright 快照里没有 title（INV-33）。
    ★ canvas 的名字只能来自 aria-label——画在上面的字不在 DOM 里。
    """
    label = collapse_spaces(n.aria_label or "")
    if label != "":
        return label
    if n.role == "img":
        alt = collapse_spaces(n.alt or "")
        if alt != "":
            return alt
    if n.role in NAME_FROM_CONTENT:
        t = text_content(n)
        if t != "":
            return t
    return collapse_spaces(n.title or "")


# ── ref ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class RefEntry:
    role: str
    name: str
    ref: str


@dataclass(frozen=True)
class SeenLine:
    """模型「看到的」那一行：ref、role、name，以及它所在那一行（listitem / row）的文字。"""

    ref: str
    node_id: str
    role: str
    name: str
    context: str
    line: str


@dataclass
class RefState:
    """页面这一侧的 ref 状态。对应 Playwright 注入脚本里的三样东西：
      lastRef（全局计数器）、element._ariaRef（挂在节点上的 expando）、_lastAriaSnapshotForQuery（最后一次快照）。
    注入脚本每个文档一份：导航之后全部从头来过。
    """

    doc_seq: int
    last_ref: int
    expando: dict[str, RefEntry]
    # 最后一次快照：ref → nodeId。
    last: dict[str, str]


def new_ref_state() -> RefState:
    return RefState(doc_seq=0, last_ref=0, expando={}, last={})


# MCP 判断「这是不是一个 ref」用的正则（源码是 `^(f\d+)?e\d+$`；这里写 [0-9]，两种语言的 \d 不一样）。
REF_RE = re.compile(r"^(f[0-9]+)?e[0-9]+\Z")


def ref_prefix(doc_seq: int) -> str:
    return f"f{doc_seq}" if doc_seq > 0 else ""


def assign_ref(state: RefState, page: FakePage, node_id: str, role: str, name: str) -> str:
    """TODO 3 的参考实现。Playwright `computeAriaRef` 的逐行重写：
      节点上已经有 ref，且 role、name 都没变 → 沿用；否则从**全局计数器**取一个新号（从不复用）。
      前缀 f<doc_seq>：导航以后旧文档的 e3 不可能撞上新文档的元素（INV-7）。

    ★ 计数器是文档级的，不是快照级的：第二次快照不会从 e1 重新开始。
    ★ 换文档（page.doc_seq 变了）时，计数器和 expando 都清空——它们属于旧文档的注入脚本。
    """
    if state.doc_seq != page.doc_seq:
        state.doc_seq = page.doc_seq
        state.last_ref = 0
        state.expando.clear()
        state.last.clear()
    old = state.expando.get(node_id)
    if old is not None and old.role == role and old.name == name:
        return old.ref
    state.last_ref += 1
    ref = f"{ref_prefix(page.doc_seq)}e{state.last_ref}"
    state.expando[node_id] = RefEntry(role=role, name=name, ref=ref)
    return ref


def _text_nodes(a: FakeNode) -> list[str]:
    parts: list[str] = []

    def visit(x: FakeNode) -> None:
        if x.role == "text" and x.text is not None:
            parts.append(x.text)
        for c in x.children or []:
            visit(c)

    visit(a)
    return parts


def row_context(path: list[FakeNode]) -> str:
    """最近的 listitem / row 祖先里的文字。同名按钮靠它区分是哪一行。"""
    for a in reversed(path):
        if a.role in ("listitem", "row"):
            return collapse_spaces(" ".join(_text_nodes(a)))
    return ""


@dataclass(frozen=True)
class SnapshotOpts:
    mode: SnapshotMode = "ai"
    # 'browserUse'：把 title 属性也带上。browser-use 的属性白名单里有 title（§2.13）；Playwright 没有。
    # 同一个注入载体，对一种感知器有效、对另一种无效。
    attrs: Literal["playwright", "browserUse"] = "playwright"


@dataclass(frozen=True)
class SnapshotImpl:
    """快照用到的三个可替换的部件（verify 用它们换成你的实现）。"""

    is_aria_visible: Callable[[FakeNode, Inherited, SnapshotMode], bool]
    accessible_name: Callable[[FakeNode], str]
    assign_ref: Callable[[RefState, FakePage, str, str, str], str]


SHARED_IMPL = SnapshotImpl(
    is_aria_visible=is_aria_visible, accessible_name=accessible_name, assign_ref=assign_ref
)


@dataclass(frozen=True)
class Snapshot:
    text: str
    # ref → nodeId
    refs: dict[str, str]
    lines: dict[str, SeenLine]
    # 进了快照的元素（不含 text 节点），文档顺序。
    included: list[str]


def snapshot(
    page: FakePage,
    state: RefState,
    opts: SnapshotOpts | None = None,
    impl: SnapshotImpl = SHARED_IMPL,
) -> Snapshot:
    """生成一份快照，同时更新页面侧的 ref 状态（Playwright 每次快照都会这么做）。

    格式模仿 Playwright 的 YAML：`- button "Name" [ref=e3]: 行内文字`；root 自己不出现。

    ★ ref 只给「有盒子、收得到指针事件」的元素（refs: 'interactable'）。`pointer-events:none` 的按钮照样出现，
      但没有 ref（INV-8）；被透明遮罩盖住的按钮**有** ref——这里不做命中测试。
    ★ iframe 只有拿到 ref 才会被展开；子文档取快照出错时变成空列表，**不报错**（§2.6，INV-9）。
      default 模式根本没有 ref，所以也不展开 iframe（由源码推出，`[P2]`）。
    ★ 简化：真实 Playwright 里 iframe 的内容有自己的 f<n> 前缀；这里和父文档共用一个计数器。
    """
    o = opts if opts is not None else SnapshotOpts()
    mode = o.mode
    attrs = o.attrs
    refs: dict[str, str] = {}
    lines: dict[str, SeenLine] = {}
    included: list[str] = []

    def render(
        n: FakeNode, anc: Inherited, path: list[FakeNode], pe: bool, depth: int
    ) -> list[str]:
        ind = "  " * depth
        if n.role == "text":
            return [f"{ind}- text: {n.text}"] if n.text is not None and n.text != "" else []
        if not impl.is_aria_visible(n, anc, mode):
            return []
        included.append(n.id)
        pe2 = pe and _style(n).pointer_events != "none"
        role = "generic" if n.role == "canvas" else n.role
        name = impl.accessible_name(n)
        ref = ""
        if mode == "ai" and has_box(n) and pe2:
            ref = impl.assign_ref(state, page, n.id, role, name)

        head = f"- {role}"
        if name != "":
            head += f' "{name}"'
        if mode == "ai" and n.aria_hidden is True:
            head += " [aria-hidden]"
        if attrs == "browserUse" and n.title is not None and n.title != name:
            head += f' title="{n.title}"'
        if ref != "":
            head += f" [ref={ref}]"

        sub = [*path, n]
        kids: list[str] = []
        if n.shadow is not None and n.shadow.mode == "open":
            for c in n.shadow.children:
                kids.extend(render(c, child_inherited(n, anc, c), sub, pe2, depth + 1))
        for c in n.children or []:
            kids.extend(render(c, child_inherited(n, anc, c), sub, pe2, depth + 1))
        if n.frame is not None and ref != "" and n.frame.error is not True:
            for c in n.frame.children:
                kids.extend(render(c, ROOT_INHERITED, sub, True, depth + 1))

        inline = ""
        if n.text is not None and n.role != "canvas":
            own = collapse_spaces(n.text)
            if n.role not in NAME_FROM_CONTENT or own != name:
                inline = own
        line = f"{head}:" if kids else (f"{head}: {inline}" if inline != "" else head)
        if ref != "":
            refs[ref] = n.id
            lines[ref] = SeenLine(
                ref=ref, node_id=n.id, role=role, name=name, context=row_context(path), line=line
            )
        return [f"{ind}{line}", *kids]

    out: list[str] = []
    root = page.root
    for c in root.children or []:
        out.extend(render(c, child_inherited(root, ROOT_INHERITED, c), [root], True, 0))
    state.doc_seq = page.doc_seq
    state.last = dict(refs)
    return Snapshot(text="\n".join(out), refs=refs, lines=lines, included=included)


# ── ref 何时过期（§2.4）──────────────────────────────────────


@dataclass(frozen=True, kw_only=True)
class ResolvedOk:
    kind: Literal["ok"] = "ok"
    node_id: str


@dataclass(frozen=True, kw_only=True)
class ResolvedErr:
    kind: Literal["error"] = "error"
    reason: Literal["bad-format", "not-in-last-snapshot", "detached"]


Resolved = ResolvedOk | ResolvedErr


def resolve_ref(state: RefState, page: FakePage, ref: str) -> Resolved:
    """Playwright 的解析语义：只认「最后一次快照」，并要求节点还连在文档上。

    ★ 节点还在、内容变了 → **ok**。解析器不做名字校验，这正是静默点错的来源（INV-6）。
    ★ 四种过期里只有「节点删了」「换了文档」会报错。
    """
    if REF_RE.match(ref) is None:
        return ResolvedErr(reason="bad-format")
    if state.doc_seq != page.doc_seq:
        return ResolvedErr(reason="not-in-last-snapshot")
    id_ = state.last.get(ref)
    if id_ is None:
        return ResolvedErr(reason="not-in-last-snapshot")
    if find_node(page, id_) is None:
        return ResolvedErr(reason="detached")
    return ResolvedOk(node_id=id_)


Drift = Literal["same", "renamed", "context-changed", "gone"]


@dataclass(frozen=True)
class NodeNow:
    role: str
    name: str
    context: str


def describe_node(page: FakePage, node_id: str) -> NodeNow | None:
    """节点**现在**的 role、name、所在行。"""
    loc = find_node(page, node_id)
    if loc is None:
        return None
    return NodeNow(
        role="generic" if loc.node.role == "canvas" else loc.node.role,
        name=accessible_name(loc.node),
        context=row_context(loc.path),
    )


def drift_check(seen: SeenLine, page: FakePage, node_id: str) -> Drift:
    """TODO 4 的参考实现：模型看到的那一行，和节点现在的样子，还是不是一回事。

    ★ 只比 role + name 不够：每行一个 "Delete" 的列表重排以后，同一个 ref 指向另一行，
      role 和 name 一个字都没变（实测 2c）。要把所在那一行的文字也比上。
    """
    now = describe_node(page, node_id)
    if now is None:
        return "gone"
    if now.role != seen.role or now.name != seen.name:
        return "renamed"
    if now.context != seen.context:
        return "context-changed"
    return "same"


def drift_check_role_name(seen: SeenLine, page: FakePage, node_id: str) -> Drift:
    """对照组：只比 role + name。B7 用它证明「新快照救不了同名重排」。"""
    now = describe_node(page, node_id)
    if now is None:
        return "gone"
    return "renamed" if now.role != seen.role or now.name != seen.name else "same"


# ─────────────────────────────────────────────────────────────
# 三、坐标（§3.3、§3.7）
# ─────────────────────────────────────────────────────────────


def round_half_up(num: int, den: int) -> int:
    """整数的 floor(num / den + 0.5)，den > 0。
    ★ 不要用 Math.round / round()：Python 的 round 是银行家舍入，round(2.5) == 2。
    """
    return (2 * num + den) // (2 * den)


# 模型给的坐标在哪个空间：
#   css         CSS 视口像素（Playwright MCP 截图默认 scale:"css"）
#   device      设备像素（page.screenshot() 默认 "device"；Retina 上是 CSS 的 2 倍）
#   scaledShot  你把截图缩放成 shot.w × shot.h 再发给模型（Anthropic / OpenAI：坐标在你发的那张图里）
#   gemini1000  0–1000 归一化网格，换算要乘 **CSS 视口**尺寸，不是截图尺寸
#   fullPage    整页截图：文档坐标，要减 scroll_y
CoordConv = Literal["css", "device", "scaledShot", "gemini1000", "fullPage"]


@dataclass(frozen=True)
class Pt:
    x: int
    y: int


@dataclass(frozen=True, kw_only=True)
class CoordCtx:
    dpr: int
    # CSS 视口尺寸。
    viewport: Size
    # 发给模型的那张图的尺寸（scaledShot 用）。
    shot: Size | None = None
    scroll_y: int | None = None
    # 坐标属于某个 iframe 时，iframe 左上角在视口里的位置。
    frame_offset: Pt | None = None


@dataclass(frozen=True)
class VPoint:
    ok: bool
    x: int
    y: int
    error: str


def to_viewport(pt: Pt, conv: CoordConv, ctx: CoordCtx) -> VPoint:
    """TODO 5 的参考实现：任何约定 → 整数 CSS 视口坐标。
    ★ 视口外的点返回错误，**不钳位**：钳到边上等于点到另一个东西。
    """
    if conv == "css":
        x = pt.x
        y = pt.y
    elif conv == "device":
        x = round_half_up(pt.x, ctx.dpr)
        y = round_half_up(pt.y, ctx.dpr)
    elif conv == "scaledShot":
        if ctx.shot is None:
            raise ValueError("scaledShot 需要 ctx.shot")
        x = round_half_up(pt.x * ctx.viewport.w, ctx.shot.w)
        y = round_half_up(pt.y * ctx.viewport.h, ctx.shot.h)
    elif conv == "gemini1000":
        x = round_half_up(pt.x * ctx.viewport.w, 1000)
        y = round_half_up(pt.y * ctx.viewport.h, 1000)
    else:
        x = pt.x
        y = pt.y - (ctx.scroll_y if ctx.scroll_y is not None else 0)
    if ctx.frame_offset is not None:
        x += ctx.frame_offset.x
        y += ctx.frame_offset.y
    if x < 0 or y < 0 or x >= ctx.viewport.w or y >= ctx.viewport.h:
        return VPoint(ok=False, x=0, y=0, error=f"outside-viewport ({x},{y})")
    return VPoint(ok=True, x=x, y=y, error="")


# ─────────────────────────────────────────────────────────────
# 四、命中与三种「可见」（§2.13、§8.1）
# ─────────────────────────────────────────────────────────────


def doc_rect(loc: Located) -> Rect:
    b = loc.node.bbox if loc.node.bbox is not None else (0, 0, 0, 0)
    return (b[0] + loc.offset[0], b[1] + loc.offset[1], b[2], b[3])


def _chain(loc: Located) -> list[FakeNode]:
    return [*loc.path, loc.node]


def receives_pointer_events(loc: Located) -> bool:
    return not any(_style(a).pointer_events == "none" for a in _chain(loc))


def is_fixed(loc: Located) -> bool:
    return any(_style(a).fixed is True for a in _chain(loc))


def is_clipped(loc: Located) -> bool:
    return any(_style(a).clip is True for a in _chain(loc))


def eff_opacity(loc: Located) -> int:
    """祖先的 opacity 相乘，整数。"""
    o = 100
    for a in _chain(loc):
        op = _style(a).opacity
        o = (o * (op if op is not None else 100)) // 100
    return o


def _nearest(loc: Located, pick: Callable[[NodeStyle], _T | None]) -> _T | None:
    for a in reversed(_chain(loc)):
        v = pick(_style(a))
        if v is not None:
            return v
    return None


def eff_color(loc: Located) -> str:
    v = _nearest(loc, lambda s: s.color)
    return v if v is not None else "#000000"


def eff_background(loc: Located) -> str:
    v = _nearest(
        loc,
        lambda s: (
            s.background if s.background is not None and s.background != "transparent" else None
        ),
    )
    return v if v is not None else "#ffffff"


def eff_font_size(loc: Located) -> int:
    v = _nearest(loc, lambda s: s.font_size)
    return v if v is not None else 16


def _eff_z(loc: Located) -> int:
    """绘制层级：最近的写了 z 的祖先（含自己），默认 0。同层时后画的在上面。"""
    for a in reversed(_chain(loc)):
        if a.z is not None:
            return a.z
    return 0


def brightness(hex_: str) -> int:
    """颜色亮度：(299R + 587G + 114B) / 1000，W3C AERT 的「color brightness」公式，整数。
    不用 WCAG 相对亮度是因为它要 pow(·, 2.4)——两种语言的 pow 末位可能不同。
    """

    def v(i: int) -> int:
        return int(hex_[i : i + 2], 16)

    return (299 * v(1) + 587 * v(3) + 114 * v(5)) // 1000


# AERT 建议的最低亮度差。低于它算「人看不清」。
CONTRAST_MIN = 125

HitPolicy = Literal["browser", "browserUse"]


def hit_test(page: FakePage, pt: Pt | VPoint, policy: HitPolicy = "browser") -> str | None:
    """视口坐标 pt 处最上层的元素 id。
      'browser'     浏览器的规则：任何有盒子、收得到指针事件、没被裁掉的元素都挡。透明的也挡。
      'browserUse'  browser-use 的遮挡规则：只有背景不透明且 opacity ≥ 80 的层才算（源码注释 "highly vibes based number"）。
    ★ 一个 `background: transparent` 的全屏 div 在浏览器里吃掉所有点击，在 browser-use 眼里不存在（INV-33）。
    """
    best: str | None = None
    best_z = 0
    for loc in walk(page):
        n = loc.node
        if n.role == "text" or not has_box(n):
            continue
        if inherited_of(loc).hidden_for_all or self_hidden(n):
            continue
        if not receives_pointer_events(loc) or is_clipped(loc):
            continue
        if policy == "browserUse":
            bg = _style(n).background
            if bg is None or bg == "transparent" or eff_opacity(loc) < 80:
                continue
        rx, ry, rw, rh = doc_rect(loc)
        py = pt.y if is_fixed(loc) else pt.y + page.scroll_y
        if pt.x < rx or pt.x >= rx + rw or py < ry or py >= ry + rh:
            continue
        z = _eff_z(loc)
        if best is None or z >= best_z:
            best = n.id
            best_z = z
    return best


def is_descendant(page: FakePage, id_: str, ancestor_id: str) -> bool:
    loc = find_node(page, id_)
    return loc is not None and any(a.id == ancestor_id for a in loc.path)


def center_of(page: FakePage, loc: Located) -> Pt:
    """元素中心点的视口坐标。"""
    x, y, w, h = doc_rect(loc)
    cx = x + w // 2
    cy = y + h // 2
    return Pt(x=cx, y=cy if is_fixed(loc) else cy - page.scroll_y)


@dataclass(frozen=True)
class Visibility:
    # 语义层：a11y 树里有这个元素（MCP browser_verify_element_visible 只查这个：count() > 0）。
    exists: bool
    # 有非空盒子且没被 display/visibility 藏住（Playwright isVisible() 的定义）。
    box: bool
    # 中心点在视口里。
    in_viewport: bool
    # 中心点处最上层的就是它（或它的子孙）。
    hit: bool
    # 像素层：不透明、没被裁掉、字号不为 0、和背景有足够亮度差。
    pixels: bool
    reasons: list[str]


# 「可见」的五层。像素层的两个阈值是这个 lab 定的，不是标准。
OPACITY_MIN = 10


def visual_visibility(page: FakePage, node_id: str) -> Visibility:
    """TODO 6 的参考实现。

    ★ 三种口径，三个不同的「可见」：MCP verify 是「存在」，isVisible() 是「有盒子」，hit-test 是「点得到」；
      只有像素层能抓住 opacity:0 和白字白底——而这两类恰好也是隐藏注入的载体（INV-10）。
    """
    loc = find_node(page, node_id)
    if loc is None:
        return Visibility(
            exists=False, box=False, in_viewport=False, hit=False, pixels=False, reasons=["missing"]
        )
    n = loc.node
    anc = inherited_of(loc)
    reasons: list[str] = []

    exists = not loc.closed_shadow and is_aria_visible(n, anc, "default")
    if not exists:
        reasons.append("not-in-a11y-tree")
    box = has_box(n) and not anc.hidden_for_all and not self_hidden(n)
    if not box:
        reasons.append("zero-box")

    in_viewport = False
    hit = False
    if box:
        c = center_of(page, loc)
        in_viewport = c.x >= 0 and c.y >= 0 and c.x < page.viewport.w and c.y < page.viewport.h
        if not in_viewport:
            reasons.append("outside-viewport")
        else:
            top = hit_test(page, c, "browser")
            hit = top is not None and (top == n.id or is_descendant(page, top, n.id))
            if not hit:
                reasons.append(f"blocked-by:{top if top is not None else 'nothing'}")

    op = eff_opacity(loc)
    clipped = is_clipped(loc)
    fs = eff_font_size(loc)
    contrast = abs(brightness(eff_color(loc)) - brightness(eff_background(loc)))
    if op < OPACITY_MIN:
        reasons.append(f"opacity:{op}")
    if clipped:
        reasons.append("clipped")
    if fs == 0:
        reasons.append("font-size:0")
    if contrast < CONTRAST_MIN:
        reasons.append(f"low-contrast:{contrast}")
    pixels = box and op >= OPACITY_MIN and not clipped and fs != 0 and contrast >= CONTRAST_MIN

    return Visibility(
        exists=exists, box=box, in_viewport=in_viewport, hit=hit, pixels=pixels, reasons=reasons
    )


HiddenKind = Literal[
    "sr-only",
    "clipped",
    "opacity0",
    "fontSize0",
    "lowContrast",
    "offscreen",
    "ariaLabelMismatch",
    "alt",
    "title",
]


@dataclass(frozen=True)
class HiddenFinding:
    node_id: str
    kind: HiddenKind
    text: str


def hidden_text_findings(page: FakePage) -> list[HiddenFinding]:
    """进了 ai 快照、但人看不见的文字。它和 L14 的 strip_invisible 是两回事，要叠加：
    那边是 Unicode 不可见字符，这边是 CSS 视觉隐藏。
    ★ title 只对把 title 序列化进去的感知器（browser-use）成立；Playwright 快照里没有它。
    """
    snap = snapshot(page, new_ref_state(), SnapshotOpts(mode="ai"))
    out: list[HiddenFinding] = []
    for id_ in snap.included:
        loc = find_node(page, id_)
        assert loc is not None
        n = loc.node
        own = n.text if n.text is not None else ""
        if own != "" and n.role != "canvas":
            x, y, w, h = doc_rect(loc)
            if is_clipped(loc):
                kind: HiddenKind = "sr-only" if w <= 1 and h <= 1 else "clipped"
                out.append(HiddenFinding(node_id=id_, kind=kind, text=own))
            if eff_opacity(loc) == 0:
                out.append(HiddenFinding(node_id=id_, kind="opacity0", text=own))
            if eff_font_size(loc) == 0:
                out.append(HiddenFinding(node_id=id_, kind="fontSize0", text=own))
            if abs(brightness(eff_color(loc)) - brightness(eff_background(loc))) < CONTRAST_MIN:
                out.append(HiddenFinding(node_id=id_, kind="lowContrast", text=own))
            if n.bbox is not None and (x + w <= 0 or y + h <= 0):
                out.append(HiddenFinding(node_id=id_, kind="offscreen", text=own))
        label = collapse_spaces(n.aria_label or "")
        visible_text = text_content(n)
        if label != "" and visible_text != "" and label != visible_text:
            out.append(HiddenFinding(node_id=id_, kind="ariaLabelMismatch", text=label))
        if n.role == "img" and n.alt is not None and n.alt != "":
            out.append(HiddenFinding(node_id=id_, kind="alt", text=n.alt))
        if n.title is not None and n.title != "":
            out.append(HiddenFinding(node_id=id_, kind="title", text=n.title))
    return out


def mcp_verify_visible(page: FakePage, node_id: str) -> bool:
    """X8 的两列对照：MCP browser_verify_element_visible（count() > 0）和 Playwright isVisible()。"""
    return visual_visibility(page, node_id).exists


def playwright_is_visible(page: FakePage, node_id: str) -> bool:
    return visual_visibility(page, node_id).box


# ─────────────────────────────────────────────────────────────
# 五、图片 token（§4）。公式抄写没有教学价值，所以没有 TODO；你在实验里用它。
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ImageTokens:
    tokens: int
    # 模型实际看到的尺寸。
    w: int
    h: int
    rejected: bool
    reason: str


def _ok(tokens: int, w: int, h: int) -> ImageTokens:
    return ImageTokens(tokens=tokens, w=w, h=h, rejected=False, reason="")


def _rejected(w: int, h: int, reason: str) -> ImageTokens:
    return ImageTokens(tokens=0, w=w, h=h, rejected=True, reason=reason)


def _ceil(a: int, b: int) -> int:
    """整数的 Math.ceil(a / b)，b > 0。"""
    return -(-a // b)


@dataclass(frozen=True)
class AnthropicTier:
    max_edge: int
    max_tok: int


# Anthropic 两档（vision 页 2026-10-12）：⌈w/28⌉ × ⌈h/28⌉。
ANTHROPIC_TIERS: dict[str, AnthropicTier] = {
    "standard": AnthropicTier(max_edge=1568, max_tok=1568),
    "high-res": AnthropicTier(max_edge=2576, max_tok=4784),
}


def _anth_tok(w: int, h: int) -> int:
    return _ceil(w, 28) * _ceil(h, 28)


def _anthropic_tokens(w: int, h: int, tier: str, toolset: bool) -> ImageTokens:
    """★ 普通 image block 超限会被等比缩小；computer use / browser use 的 toolset **不缩，直接拒收**（INV-22）。
    缩放尺寸用二分搜索找「放得下的最大等比尺寸」；和官方参考实现在两个样例上差 1px，token 数 9/9 一致。
    """
    t = ANTHROPIC_TIERS[tier]
    max_edge, max_tok = t.max_edge, t.max_tok
    if max(w, h) <= max_edge and _anth_tok(w, h) <= max_tok:
        return _ok(_anth_tok(w, h), w, h)
    if toolset:
        return _rejected(w, h, "toolset 不缩放，超限直接拒收")
    lo = 0.0
    hi = min(1.0, max_edge / max(w, h))
    for _ in range(60):
        m = (lo + hi) / 2
        mw = math.floor(w * m)
        mh = math.floor(h * m)
        if max(mw, mh) <= max_edge and _anth_tok(mw, mh) <= max_tok:
            lo = m
        else:
            hi = m
    rw = math.floor(w * lo)
    rh = math.floor(h * lo)
    return _ok(_anth_tok(rw, rh), rw, rh)


def _openai_patch(w0: int, h0: int, max_dim: int, budget: int, mult: float) -> ImageTokens:
    """OpenAI 新模型：32px patch × 倍率，向上取整；超过 30,000 patch 拒收，**不会**自动缩（INV-25）。"""
    w = w0
    h = h0
    if max(w, h) > max_dim:
        s = max_dim / max(w, h)
        w = math.floor(w * s)
        h = math.floor(h * s)
    patches = _ceil(w, 32) * _ceil(h, 32)
    if budget > 0 and patches > budget:
        shrink = math.sqrt((32 * 32 * budget) / (w * h))
        adj = shrink * min(
            math.floor((w * shrink) / 32) / ((w * shrink) / 32),
            math.floor((h * shrink) / 32) / ((h * shrink) / 32),
        )
        w = math.floor(w * adj)
        h = math.floor(h * adj)
        patches = _ceil(w, 32) * _ceil(h, 32)
    if patches > 30000:
        return _rejected(w, h, f"{patches} patch，超过 30,000 上限")
    return _ok(math.ceil(patches * mult), w, h)


def _openai_tile(w0: int, h0: int, detail: str) -> ImageTokens:
    """gpt-4o / gpt-4.1：85 基础 + 每个 512 tile 170。"""
    if detail == "low":
        return _ok(85, 512, 512)
    w = w0
    h = h0
    if max(w, h) > 2048:
        s = 2048 / max(w, h)
        w = math.floor(w * s)
        h = math.floor(h * s)
    if min(w, h) > 768:
        s = 768 / min(w, h)
        w = math.floor(w * s)
        h = math.floor(h * s)
    return _ok(85 + 170 * _ceil(w, 512) * _ceil(h, 512), w, h)


# DeepSeek V4.1 Flash：官方 Token 页计算器（JS 分包 1e0da2c4.24c3fb4b.js）的移植，只保留 V4.1 用到的分支。
# 14px patch × 3 倍下采样 = 每个 token 42×42 像素；token = 行 × (列 + 1) + 2；最小 544²，上限 1024。
# ★ 图越大不一定越贵：总像素被钳到约 1300²，长截图的宽度跟着被压窄（INV-31）。
DS_PATCH = 14
DS_DOWN = 3
DS_MAX_TOK = 1024
DS_MIN_PIXELS = 295936


def _ds_tokens(n_h: int, n_w: int) -> int:
    return n_h * (n_w + 1) + 2


def _ceil_div(a: int, b: int) -> int:
    return (a + b - 1) // b


@dataclass(frozen=True)
class _DsPlan:
    n_h: int
    n_w: int
    H: int
    W: int
    tokens: int


def _ds_solve(height: int, width: int, max_tok: int) -> _DsPlan:
    p = DS_PATCH * DS_DOWN
    n = height / width
    a = math.sqrt((max_tok - 2) / n + 0.25) - 0.5
    i = a * n
    if a < 1:
        W = p
        H = ((max_tok - 2) // 2) * p
    elif i < 1:
        W = (max_tok - 2 - 1) * p
        H = p
    else:
        u = min((math.trunc(a) * p) / width, (math.trunc(i) * p) / height)
        W = math.trunc((width * u) / DS_PATCH) * DS_PATCH
        H = math.trunc((height * u) / DS_PATCH) * DS_PATCH
    n_h = _ceil_div(H // DS_PATCH, DS_DOWN)
    n_w = _ceil_div(W // DS_PATCH, DS_DOWN)
    return _DsPlan(n_h=n_h, n_w=n_w, H=H, W=W, tokens=_ds_tokens(n_h, n_w))


def _ds_inner(w0: int, h0: int) -> _DsPlan:
    w = w0
    h = h0
    px = w * h
    if px < DS_MIN_PIXELS and px > 0:
        k = math.sqrt(DS_MIN_PIXELS / px)
        w = math.trunc(w * k)
        h = math.trunc(h * k)
    W = _ceil_div(w, DS_PATCH) * DS_PATCH
    H = _ceil_div(h, DS_PATCH) * DS_PATCH
    n_h = _ceil_div(H // DS_PATCH, DS_DOWN)
    n_w = _ceil_div(W // DS_PATCH, DS_DOWN)
    plan = _DsPlan(n_h=n_h, n_w=n_w, H=H, W=W, tokens=_ds_tokens(n_h, n_w))
    return _ds_solve(h, w, DS_MAX_TOK) if plan.tokens > DS_MAX_TOK else plan


def _deepseek_tokens(w: int, h: int) -> ImageTokens:
    p = _ds_inner(w, h)
    for _ in range(1, 10):
        q = _ds_inner(p.W, p.H)
        if q == p:
            return _ok(p.tokens, p.W, p.H)
        p = q
    raise RuntimeError("DeepSeek 计算器没有收敛")


ImageProvider = Literal["anthropic", "openai", "deepseek"]
Detail = Literal["auto", "low", "high", "original"]


def image_tokens(
    provider: ImageProvider,
    model: str,
    w: int,
    h: int,
    *,
    detail: Detail = "auto",
    toolset: bool = False,
) -> ImageTokens:
    """「同一张截图要多少 token」没有跨厂商的答案，只有 厂商 × 模型 × detail 三元组的答案。

    模型：
      anthropic  'standard'（4.6 及以前）| 'high-res'（4.7 及以后）；toolset = 走 computer/browser use toolset
      openai     'gpt-6-astra'（auto = original，不缩）| 'gpt-5.4'（auto = high；low 可能比 high 贵）| 'gpt-4o'（tile）
      deepseek   'deepseek-flash'（V4.1，有视觉）| 'deepseek-v4-pro'（没有视觉；claude-opus* 会被兼容端点映射到它）
    """
    if provider == "anthropic":
        if model != "standard" and model != "high-res":
            raise ValueError(f"未知模型：{provider}/{model}")
        return _anthropic_tokens(w, h, model, toolset)
    if provider == "openai":
        if model == "gpt-6-astra":
            if detail == "high":
                return _openai_patch(w, h, 65535, 2500, 1.2)
            if detail == "auto" or detail == "original":
                return _openai_patch(w, h, 65535, 0, 1.2)
            raise ValueError(f"gpt-6-astra 不支持 detail={detail}")
        if model == "gpt-5.4":
            return _openai_patch(w, h, 2048, 6144 if detail == "low" else 2500, 1.2)
        if model == "gpt-4o":
            return _openai_tile(w, h, detail)
        raise ValueError(f"未知模型：{provider}/{model}")
    if model == "deepseek-flash":
        return _deepseek_tokens(w, h)
    if model == "deepseek-v4-pro":
        return _rejected(w, h, "deepseek-v4-pro 不支持视觉")
    raise ValueError(f"未知模型：{provider}/{model}")


@dataclass(frozen=True)
class ImageBatch:
    flagged: list[int]
    rule: str


def check_image_batch(imgs: Sequence[Size]) -> ImageBatch:
    """Anthropic：一个请求超过 20 张图时，**每一张**（含前面轮次重发的、tool_result 里嵌的）都不能超过 2000px（INV-23）。
    前 20 轮好好的 loop，第 21 张截图让前面 20 张一起违规。
    """
    if len(imgs) <= 20:
        return ImageBatch(flagged=[], rule="不超过 20 张：只看单张上限")
    flagged = [i for i, im in enumerate(imgs) if max(im.w, im.h) > 2000]
    return ImageBatch(flagged=flagged, rule="超过 20 张：每一张都不能超过 2000px")


# ─────────────────────────────────────────────────────────────
# 六、浏览器是一组新的 sink（§2.11、§2.12、§7.5）
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True, kw_only=True)
class BrowserAction:
    tool: Literal["click", "type"]
    # 模型写的「人类可读描述」，MCP 说它 "used to obtain permission"。
    element: str
    # 真正决定点哪儿的东西。
    target: str
    text: str | None = None


@dataclass(frozen=True)
class ApprovalView:
    # 一个照抄 element 的审批框会显示什么。
    displayed: str
    # 实际会被执行的：target 解析出的 role、name 和所在 frame 的 origin。
    executed: str


def approval_view(action: BrowserAction, state: RefState, page: FakePage) -> ApprovalView:
    """★ 审批框显示的 element 是**模型写的一段自由文本**；被注入的模型可以写 element:"Cancel"、target:"e5"（"Delete account"）。
    审批 UI 必须由执行端用 target 反查出 role / name / origin 再显示（INV-17）。
    """
    displayed = f'{action.tool} "{action.element}"'
    r = resolve_ref(state, page, action.target)
    if r.kind != "ok":
        return ApprovalView(
            displayed=displayed, executed=f"{action.tool} <{action.target}: {r.reason}>"
        )
    loc = find_node(page, r.node_id)
    assert loc is not None
    role = "generic" if loc.node.role == "canvas" else loc.node.role
    executed = f'{action.tool} {role} "{accessible_name(loc.node)}" @{loc.origin}'
    if action.text is not None:
        executed += f' text="{action.text}"'
    return ApprovalView(displayed=displayed, executed=executed)


@dataclass(frozen=True)
class BrowserChannel:
    name: str
    kind: Literal["navigate", "form", "pageTool"]
    origin: str


TEXT_ROLES = ["textbox", "searchbox", "combobox"]


def browser_channels(page: FakePage) -> list[BrowserChannel]:
    """浏览器里的出站通道。
    ★ "Typing sensitive information into a form counts as transmission."（OpenAI）——每个输入框都是出站，
      目的地是**输入框所在 frame 的 origin**，不是标签页的 URL（INV-19）。
    ★ WebMCP 默认开：你访问的页面可以往模型上下文里注册工具（INV-16）。
    """
    out = [BrowserChannel(name="navigate", kind="navigate", origin="*")]
    for loc in walk(page):
        if loc.node.role in TEXT_ROLES:
            name = accessible_name(loc.node)
            out.append(
                BrowserChannel(
                    name=f"form:{name if name != '' else loc.node.id}",
                    kind="form",
                    origin=loc.origin,
                )
            )
    for t in page.webmcp_tools or []:
        out.append(
            BrowserChannel(name=f"pageTool:{t.name}", kind="pageTool", origin=origin_of(page.url))
        )
    return out


def to_guard_channels(chs: list[BrowserChannel], removed: Sequence[str] = ()) -> list[Channel]:
    """交给 L14 的 audit_channels：表单和导航是 network，页面工具是 tool。"""
    return [
        Channel(
            name=c.name,
            kind="tool" if c.kind == "pageTool" else "network",
            mitigation="remove" if c.name in removed else "none",
            enforceable=True,
            note=c.origin,
        )
        for c in chs
    ]


# ── 白名单 ────────────────────────────────────────────────────


def _ascii_lower(s: str) -> str:
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def normalize_host(u: str) -> str:
    """TODO 7 的参考实现（前半）：URL → 规范化的 host。
    小写（只管 ASCII）、去掉 userinfo、去掉默认端口、去掉末尾的点。
    ★ Comet 案例里攻击者用的是 `perplexity.ai.`（末尾带点）——字符串直比的白名单和它不是一回事。
    ★ 不用 URL / urllib：两种语言的解析器对畸形输入的处理不一样。
    """
    i = u.find("://")
    scheme = _ascii_lower(u[:i]) if i >= 0 else ""
    rest = u[i + 3 :] if i >= 0 else u
    cut = len(rest)
    for c in ["/", "?", "#"]:
        k = rest.find(c)
        if 0 <= k < cut:
            cut = k
    rest = rest[:cut]
    at = rest.rfind("@")
    if at >= 0:
        rest = rest[at + 1 :]
    host = rest
    colon = rest.rfind(":")
    if colon >= 0:
        port = rest[colon + 1 :]
        host = rest[:colon]
        if not (
            (scheme == "https" and port == "443")
            or (scheme == "http" and port == "80")
            or port == ""
        ):
            host += f":{port}"
    host = _ascii_lower(host)
    while host.endswith("."):
        host = host[:-1]
    return host


def host_allowed(host: str, allow: list[str]) -> bool:
    """精确匹配，或者显式写了 `*.` 的子域（不含裸域本身）。"""
    for a in allow:
        e = normalize_host(a)
        if e.startswith("*."):
            suffix = e[1:]
            if host.endswith(suffix) and len(host) > len(suffix):
                return True
        elif host == e:
            return True
    return False


@dataclass(frozen=True)
class NavVerdict:
    ok: bool
    # 第几跳被拦，-1 表示放行。
    blocked_at: int
    host: str


def navigation_allowed(chain: list[str], allow: list[str]) -> NavVerdict:
    """TODO 7 的参考实现（后半）：重定向链的**每一跳**都查。
    ★ Playwright MCP 的 --allowed-origins "does not affect redirects"；Anthropic 要求 "re-checked in your navigate
      handler after redirects"。只查第一跳等于没查。
    """
    for i, u in enumerate(chain):
        host = normalize_host(u)
        if not host_allowed(host, allow):
            return NavVerdict(ok=False, blocked_at=i, host=host)
    return NavVerdict(
        ok=True, blocked_at=-1, host=normalize_host(chain[-1]) if len(chain) > 0 else ""
    )


# ─────────────────────────────────────────────────────────────
# 七、快照的体积
# ─────────────────────────────────────────────────────────────


def snapshot_tokens(text: str) -> int:
    """快照文字的 token 粗估（L06 的 estimate_tokens；DeepSeek 实测英文快照 3.7–4.3 字符/token，这里按 4 算）。"""
    return estimate_tokens(text)
