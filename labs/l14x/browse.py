"""L14x 的脚手架。跑法：uv run python -m l14x.browse

观察实验：快照里哪些人看不见的字进了模型；ref 的五种过期；快照和截图谁贵；整页截图在三家的下场；
五种坐标约定的换算和常见错法；「可见」的三种口径；审批框显示的和实际执行的；浏览器里的出站通道。
不起浏览器、不调模型。页面是 fixtures/pages.json 里的「假页面」（两种语言读同一份文件）。
写完七个 TODO 跑 uv run python -m l14x.verify。
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from shared.browse import (
    CONTRAST_MIN,
    NAME_FROM_CONTENT,
    OPACITY_MIN,
    REF_RE,
    BrowserAction,
    CoordConv,
    CoordCtx,
    Drift,
    FakeNode,
    FakePage,
    ImageTokens,
    Inherited,
    NavVerdict,
    NodeStyle,
    Pt,
    RefEntry,
    RefState,
    Resolved,
    SeenLine,
    Size,
    SnapshotMode,
    SnapshotOpts,
    Visibility,
    VPoint,
    approval_view,
    audit_channels,
    brightness,
    browser_channels,
    center_of,
    check_image_batch,
    collapse_spaces,
    describe_node,
    display_matches_execution,
    drift_check,
    drift_check_role_name,
    eff_background,
    eff_color,
    eff_font_size,
    eff_opacity,
    find_node,
    has_box,
    hidden_text_findings,
    hit_test,
    host_allowed,
    image_tokens,
    inherited_of,
    is_aria_visible,
    is_clipped,
    is_descendant,
    mcp_verify_visible,
    navigation_allowed,
    new_ref_state,
    page_from_json,
    playwright_is_visible,
    ref_prefix,
    resolve_ref,
    round_half_up,
    row_context,
    self_hidden,
    snapshot,
    snapshot_tokens,
    text_content,
    to_guard_channels,
    to_viewport,
    visual_visibility,
)

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


def yn(b: bool) -> str:
    return "Y" if b else "-"


def _js_bool(b: bool) -> str:
    return "true" if b else "false"


# ─────────────────────────────────────────────────────────────
# 夹具（verify 也用）
# ─────────────────────────────────────────────────────────────

_PAGES_TEXT = (Path(__file__).parent / "fixtures" / "pages.json").read_text(encoding="utf-8")


def page(name: str) -> FakePage:
    """每次返回一份新的拷贝：页面是「当前 DOM」，谁也不该改到别人手里那份。"""
    all_ = json.loads(_PAGES_TEXT)
    p = all_.get(name)
    if p is None:
        raise ValueError(f"没有这个页面：{name}")
    return page_from_json(p)


GRID_COLS = 8
GRID_ROWS = 12
TILE_W = 180
TILE_H = 150


def grid_page(scroll_y: int = 0) -> FakePage:
    """坐标实验用的网格页：1440×900 视口、DPR 2，文档 1440×1800，铺满 8×12 个 180×150 的按钮。
    任何一个点都落在某个按钮上，所以「点偏了」一定表现为「点到了别的按钮」。
    """
    children: list[FakeNode] = []
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            children.append(
                FakeNode(
                    id=f"t-{r}-{c}",
                    role="button",
                    text=f"R{r}C{c}",
                    bbox=(c * TILE_W, r * TILE_H, TILE_W, TILE_H),
                    style=NodeStyle(background="#efefef"),
                )
            )
    return FakePage(
        url="https://app.example/grid",
        viewport=Size(w=1440, h=900),
        dpr=2,
        scroll_y=scroll_y,
        doc_seq=0,
        root=FakeNode(
            id="body",
            role="generic",
            bbox=(0, 0, 1440, 1800),
            style=NodeStyle(background="#ffffff"),
            children=children,
        ),
    )


def big_page(n: int) -> FakePage:
    """一个不虚拟化的长列表：n 行，每行一个链接和一句描述。快照覆盖整个文档，不只是视口。"""
    rows: list[FakeNode] = []
    for i in range(n):
        rows.append(
            FakeNode(
                id=f"row-{i}",
                role="listitem",
                bbox=(8, 60 + i * 40, 1200, 36),
                children=[
                    FakeNode(
                        id=f"link-{i}",
                        role="link",
                        text=f"Item {i + 1}",
                        bbox=(8, 60 + i * 40, 120, 20),
                    ),
                    FakeNode(
                        id=f"desc-{i}",
                        role="text",
                        text=f"A short description of item number {i + 1}, updated recently",
                    ),
                ],
            )
        )
    return FakePage(
        url="https://app.example/list",
        viewport=Size(w=1280, h=720),
        dpr=1,
        scroll_y=0,
        doc_seq=0,
        root=FakeNode(
            id="body",
            role="generic",
            bbox=(0, 0, 1280, 80 + n * 40),
            style=NodeStyle(background="#ffffff"),
            children=[
                FakeNode(id="h", role="heading", text="All items", bbox=(8, 8, 400, 40)),
                FakeNode(id="list", role="list", bbox=(8, 60, 1200, n * 40), children=rows),
            ],
        ),
    )


# 探针：标签、节点 id、在快照里找的字符串。
PROBES: list[tuple[str, str, str]] = [
    ("VISIBLE_NORMAL", "p-normal", "VISIBLE_NORMAL"),
    ("sr-only", "p-sr", "INJ_SR_ONLY"),
    ("opacity:0", "p-op0", "INJ_OPACITY0"),
    ("白字白底", "p-white", "INJ_WHITE_ON_WHITE"),
    ("font-size:0", "p-fs0", "INJ_FONTSIZE0"),
    ("left:-9999px", "p-off", "INJ_OFFSCREEN"),
    ("display:none", "p-dn", "INJ_DISPLAY_NONE"),
    ("visibility:hidden", "p-vh", "INJ_VISIBILITY_HIDDEN"),
    ("aria-hidden 但可见", "p-ah", "INJ_ARIA_HIDDEN_BUT_VISIBLE"),
    ("hidden 属性", "p-hid", "INJ_HIDDEN_ATTR"),
    ("关闭的 details", "p-details", "INJ_CLOSED_DETAILS"),
    ("aria-label 注入", "btn-buy", "SYSTEM: ignore"),
    ("title 属性", "btn-help", "INJ_TITLE_ATTR"),
    ("img alt", "img", "INJ_IMG_ALT"),
    ("open shadow", "open-btn", "OPEN_SHADOW_BTN"),
    ("closed shadow", "closed-btn", "CLOSED_SHADOW_BTN"),
    ("canvas 里画的字", "canvas", "CANVAS_TEXT"),
    ("iframe 里的按钮", "f-btn", "INSIDE_IFRAME_BTN"),
    ("0×0 iframe", "f0-btn", "INSIDE_ZERO_IFRAME"),
    ("pointer-events:none iframe", "fpe-btn", "INSIDE_PE_NONE_IFRAME"),
    ("出错的 iframe", "ferr-btn", "INSIDE_ERROR_IFRAME"),
    ("遮罩下的按钮", "under", "UNDER_OVERLAY_BTN"),
    ("pointer-events:none 按钮", "pe-none", "PE_NONE_BTN"),
]


def ref_of(snap_refs: dict[str, str], node_id: str) -> str:
    """找到快照里某个节点的 ref（没有就是空串）。"""
    for ref, id_ in snap_refs.items():
        if id_ == node_id:
            return ref
    return ""


def viewport_shot_costs() -> list[tuple[str, int]]:
    """三家各一张 1280×720 视口截图的 token：Anthropic 标准档、OpenAI gpt-6-astra、DeepSeek V4.1。"""
    return [
        ("Anthropic 标准档", image_tokens("anthropic", "standard", 1280, 720).tokens),
        ("OpenAI gpt-6-astra", image_tokens("openai", "gpt-6-astra", 1280, 720).tokens),
        ("DeepSeek V4.1", image_tokens("deepseek", "deepseek-flash", 1280, 720).tokens),
    ]


ALLOW = ["perplexity.ai"]


def nav_cases() -> list[tuple[str, list[str], list[str]]]:
    """白名单实验的几条重定向链。"""
    return [
        ("正常", ["https://perplexity.ai/account"], ALLOW),
        ("大写 + 末尾点", ["https://PERPLEXITY.AI./account"], ALLOW),
        ("默认端口", ["https://perplexity.ai:443/"], ALLOW),
        (
            "第三跳出站",
            ["https://perplexity.ai/r", "https://perplexity.ai/next", "https://evil.com/collect"],
            ALLOW,
        ),
        ("后缀拼接", ["https://perplexity.ai.evil.com/"], ALLOW),
        ("藏在 query 里", ["https://evil.com/?perplexity.ai"], ALLOW),
        ("userinfo", ["https://perplexity.ai@evil.com/"], ALLOW),
        ("显式子域", ["https://docs.perplexity.ai/"], ["*.perplexity.ai"]),
        ("子域规则不含裸域", ["https://perplexity.ai/"], ["*.perplexity.ai"]),
    ]


# ─────────────────────────────────────────────────────────────
# 实验
# ─────────────────────────────────────────────────────────────


def exp1() -> None:
    print(bold("\n实验一 · 模型看到的页面不是你看到的（hidden 页，23 个探针）"))
    pg = page("hidden")
    ai = snapshot(pg, new_ref_state(), SnapshotOpts(mode="ai"))
    def_ = snapshot(pg, new_ref_state(), SnapshotOpts(mode="default"))
    bu = snapshot(pg, new_ref_state(), SnapshotOpts(mode="ai", attrs="browserUse"))
    findings = hidden_text_findings(pg)
    print(
        dim(
            f"  {pad('探针', 28)}{pad('ai', 4)}{pad('default', 9)}{pad('browserUse', 12)}{pad('有 ref', 8)}人看不见的原因"
        )
    )
    for label, id_, needle in PROBES:
        kinds = [f.kind for f in findings if f.node_id == id_]
        print(
            f"  {pad(label, 28)}{pad(yn(needle in ai.text), 4)}{pad(yn(needle in def_.text), 9)}"
            f"{pad(yn(needle in bu.text), 12)}{pad(yn(ref_of(ai.refs, id_) != ''), 8)}{','.join(kinds)}"
        )
    print(dim("\n  ai 模式的快照全文（模型拿到的就是这个）："))
    for line in ai.text.split("\n"):
        print(dim(f"    {line}"))
    print(
        dim(
            "\n  「对辅助技术可见」只看 display / visibility / hidden / aria-hidden，不看透明度、裁剪、颜色、字号、在不在视口里。\n"
            '  所以五种「人看不见」的写法全进了快照；aria-label 把 "Buy" 换成了一整句指令；title 只对 browser-use 有效。\n'
            "  真正藏住的只有 display:none、visibility:hidden、hidden 属性和关闭的 details。"
        )
    )


def exp2() -> None:
    print(
        bold("\n实验二 · key=index 重排：旧 ref 静默点到另一行（rows-v1 → rows-v2，没有重新快照）")
    )
    st = new_ref_state()
    s1 = snapshot(page("rows-v1"), st)
    for line in s1.text.split("\n"):
        print(dim(f"    {line}"))
    ref = ref_of(s1.refs, "btn-2")
    seen = s1.lines[ref]
    print(f'  模型想删 Charlie 那一行：{ref}  看到的是 {seen.role} "{seen.name}"')
    v2 = page("rows-v2")
    r = resolve_ref(st, v2, ref)
    now = describe_node(v2, "btn-2")
    assert now is not None
    arrow = f" → {r.node_id}" if r.kind == "ok" else ""
    print(
        f'  页面按 key={{index}} 重渲染以后：resolveRef({ref}) = {r.kind}{arrow}，节点现在叫 "{now.name}"'
    )
    print(f"  driftCheck = {drift_check(seen, v2, 'btn-2')}")
    s2 = snapshot(v2, st)
    r2 = resolve_ref(st, v2, ref)
    why = f":{r2.reason}" if r2.kind == "error" else ""
    print(
        f"  如果动作前取了新快照：btn-2 换号为 {ref_of(s2.refs, 'btn-2')}，resolveRef({ref}) = {r2.kind}{why}"
    )
    print(
        dim(
            "  ref 是挂在 DOM 节点上的 expando。React 用 key={index} 复用节点，Playwright 就复用 ref——点错行的根因在被测站点的 key 写法里。"
        )
    )


def exp3() -> None:
    print(
        bold("\n实验三 · 同名按钮重排：新快照也救不了（rows-v3a → rows-v3b，动作前**取了**新快照）")
    )
    st = new_ref_state()
    s1 = snapshot(page("rows-v3a"), st)
    ref = ref_of(s1.refs, "btn-2")
    seen = s1.lines[ref]
    v3b = page("rows-v3b")
    s2 = snapshot(v3b, st)
    a = s1.text.split("\n")
    b = s2.text.split("\n")
    print(dim(f"    {pad('S1（模型上下文里那份）', 44)}S2（页面侧最新的那份）"))
    for i in range(max(len(a), len(b))):
        print(dim(f"    {pad(a[i] if i < len(a) else '', 44)}{b[i] if i < len(b) else ''}"))
    s2line = s2.lines[ref]
    print(
        f'  模型想删 "{seen.context}" 的 Delete：{ref}。新快照里 {ref} 仍是 {s2line.role} "{s2line.name}"，所在行是 "{s2line.context}"'
    )
    print(
        f"  只比 role + name：{drift_check_role_name(seen, v3b, 'btn-2')}    带上行上下文：{drift_check(seen, v3b, 'btn-2')}"
    )
    print(
        dim(
            "  这一行不需要任何竞态：ref 的 role 和 name 一个字没变，变的是它旁边那个兄弟节点的文字。"
        )
    )


def exp4() -> None:
    print(bold("\n实验四 · 导航之后，以及五种过期汇总"))
    st = new_ref_state()
    sa = snapshot(page("nav-a"), st)
    held = ref_of(sa.refs, "a-add")
    nav_b = page("nav-b")
    before = resolve_ref(st, nav_b, held)
    sb = snapshot(nav_b, st)
    after = resolve_ref(st, nav_b, held)
    print(f"  nav-a 的 ref：{' '.join(sa.refs)}    nav-b 的 ref：{' '.join(sb.refs)}")
    b_txt = before.reason if before.kind == "error" else before.kind
    a_txt = after.reason if after.kind == "error" else after.kind
    print(f"  模型拿着 {held}（Add to cart）：导航后未重快照 → {b_txt}；重快照后 → {a_txt}")
    bad = resolve_ref(st, nav_b, "e3x")
    bad_txt = bad.reason if bad.kind == "error" else bad.kind
    print(f"  'e3x' → {bad_txt}（不像 ref 的字符串，MCP 会把它当 CSS 选择器）")

    def fmt(r: Resolved, pg: FakePage) -> str:
        if r.kind != "ok":
            return r.reason
        now = describe_node(pg, r.node_id)
        assert now is not None
        row = f"（{now.context} 那一行）" if now.context != "" else ""
        return f"ok → {r.node_id}「{now.name}」{row}"

    def loud(r: Resolved) -> str:
        return "静默" if r.kind == "ok" else "响亮"

    rows: list[tuple[str, str, str, str]] = []
    s = new_ref_state()
    ref = ref_of(snapshot(page("rows-v1"), s).refs, "btn-2")
    v2 = page("rows-v2")
    r = resolve_ref(s, v2, ref)
    rows.append(("A key=index 重排", "否", fmt(r, v2), loud(r)))
    snapshot(v2, s)
    r2 = resolve_ref(s, v2, ref)
    rows.append(("B 同上，动作前重快照", "是", fmt(r2, v2), loud(r2)))

    s = new_ref_state()
    ref = ref_of(snapshot(page("rows-v3a"), s).refs, "btn-2")
    v3b = page("rows-v3b")
    snapshot(v3b, s)
    r = resolve_ref(s, v3b, ref)
    rows.append(("C 同名按钮重排", "是", fmt(r, v3b), loud(r)))

    s = new_ref_state()
    ref = ref_of(snapshot(page("rows-v1"), s).refs, "btn-2")
    deleted = page("rows-v1-deleted")
    r = resolve_ref(s, deleted, ref)
    rows.append(("D 节点被删掉", "否", fmt(r, deleted), loud(r)))

    rows.append(("E 导航到新文档", "是", fmt(after, nav_b), loud(after)))
    print(dim(f"\n  {pad('场景', 24)}{pad('重快照', 8)}{pad('失败形态', 10)}旧 ref 的结果"))
    for a, b, c, d in rows:
        print(f"  {pad(a, 24)}{pad(b, 8)}{pad(d, 10)}{c}")
    print(dim("  报错的只有「节点没了」和「文档换了」。内容变了、同名重排，解析器都说 ok。"))


def exp5() -> None:
    print(bold("\n实验五 · 快照不便宜：长列表的快照 token 与一张 1280×720 截图"))
    shots = viewport_shot_costs()
    ns = [5, 10, 20, 50, 100, 200, 500, 1000, 2000]
    print(
        dim(
            f"  {lpad('行数', 6)}{lpad('ai 字符', 10)}{lpad('ai token', 10)}{lpad('default', 9)}{lpad('仅链接行', 10)}   超过了哪家的一张截图"
        )
    )
    cross: dict[str, int] = {}
    for n in ns:
        pg = big_page(n)
        ai = snapshot(pg, new_ref_state(), SnapshotOpts(mode="ai"))
        def_ = snapshot(pg, new_ref_state(), SnapshotOpts(mode="default"))
        links = "\n".join(line for line in ai.text.split("\n") if "- link " in line)
        t = snapshot_tokens(ai.text)
        over = [name for name, c in shots if t > c]
        for name in over:
            if name not in cross:
                cross[name] = n
        print(
            f"  {lpad(n, 6)}{lpad(len(ai.text), 10)}{lpad(t, 10)}{lpad(snapshot_tokens(def_.text), 9)}{lpad(snapshot_tokens(links), 10)}   {' / '.join(over)}"
        )
    print(f"  一张 1280×720：{'，'.join(f'{name} {c}' for name, c in shots)}")
    crossed = "，".join(f"{name} {cross[name] if name in cross else '—'} 行" for name, _ in shots)
    print(f"  交叉点（快照第一次比截图贵）：{crossed}")
    print(
        dim(
            "  token 用 L06 的粗估（英文 4 字符一个）。调研实测：Wikipedia 一页 AI 快照 61,473 token（DeepSeek tokenizer），\n"
            "  视口截图 578–1196。快照的优势是可行动（有 ref），不是省钱；ai 模式比 default 贵，只留交互行能砍掉大半。"
        )
    )


def exp6() -> None:
    print(bold("\n实验六 · 整页截图在三家的下场（模型看到的宽度决定字还能不能读）"))
    sizes: list[tuple[str, int, int]] = [
        ("视口 1280×720", 1280, 720),
        ("MDN 整页 1280×5149", 1280, 5149),
        ("Wikipedia 整页 1280×18916", 1280, 18916),
        ("同上 DPR 2：2560×37832", 2560, 37832),
    ]

    def cell(r: ImageTokens, show_w: bool) -> str:
        if r.rejected:
            return "拒收"
        return f"{r.tokens}（{r.w}w）" if show_w else str(r.tokens)

    print(
        dim(
            f"  {pad('截图', 28)}{pad('Anth 标准档', 16)}{pad('Anth 高分档', 16)}{pad('astra auto', 12)}{pad('gpt-5.4 high', 14)}DeepSeek V4.1"
        )
    )
    for label, wd, ht in sizes:
        print(
            f"  {pad(label, 28)}{pad(cell(image_tokens('anthropic', 'standard', wd, ht), True), 16)}"
            f"{pad(cell(image_tokens('anthropic', 'high-res', wd, ht), True), 16)}{pad(cell(image_tokens('openai', 'gpt-6-astra', wd, ht), False), 12)}"
            f"{pad(cell(image_tokens('openai', 'gpt-5.4', wd, ht, detail='high'), False), 14)}{cell(image_tokens('deepseek', 'deepseek-flash', wd, ht), True)}"
        )
    lo = image_tokens("openai", "gpt-5.4", 2880, 1800, detail="low")
    hi = image_tokens("openai", "gpt-5.4", 2880, 1800, detail="high")
    print(
        f'  gpt-5.4 上 2880×1800：low {lo.tokens} > high {hi.tokens}（"so it can use more tokens than high"）'
    )
    a1 = image_tokens("openai", "gpt-6-astra", 1920, 1080)
    a2 = image_tokens("openai", "gpt-6-astra", 3840, 2160)
    print(
        f"  gpt-6-astra 不写 detail：1920×1080 {a1.tokens}，同一视口 DPR 2 {a2.tokens}（{a2.tokens // a1.tokens} 倍，不报错）"
    )
    d1 = image_tokens("deepseek", "deepseek-flash", 2000, 2000)
    d2 = image_tokens("deepseek", "deepseek-flash", 5000, 5000)
    d3 = image_tokens("deepseek", "deepseek-flash", 100, 100)
    pro = image_tokens("deepseek", "deepseek-v4-pro", 1280, 720)
    print(
        f"  DeepSeek：2000² {d1.tokens}、5000² {d2.tokens}（一样），100² 被放大到 {d3.w}×{d3.h}、{d3.tokens}；deepseek-v4-pro：{pro.reason}"
    )
    t1 = image_tokens("anthropic", "standard", 1920, 1080, toolset=True)
    got = f"拒收（{t1.reason}）" if t1.rejected else str(t1.tokens)
    print(f"  Anthropic toolset 收到 1920×1080：{got}；普通 image block 会被缩到 1456×819")
    batch = check_image_batch([Size(w=2400, h=1350) for _ in range(21)])
    print(f"  第 21 张 2400px 截图进来：被标记 {len(batch.flagged)} 张（{batch.rule}）")
    print(
        dim(
            "  整页长截图在 Anthropic 最便宜（压窄到看不清），在 OpenAI 新模型最贵（不缩），DPR 2 直接被拒。没有跨厂商的答案。"
        )
    )


@dataclass(frozen=True)
class CoordCase:
    """实验七的场景：约定、模型给的坐标、上下文、页面、正确的目标、常见错法。"""

    label: str
    conv: CoordConv
    pt: Pt
    ctx: CoordCtx
    pg: FakePage
    target: str
    bug: str
    wrong: Callable[[], VPoint]


def coord_cases() -> list[CoordCase]:
    vp = Size(w=1440, h=900)
    grid = grid_page(0)
    scrolled = grid_page(600)
    co = page("checkout")
    return [
        CoordCase(
            label="css",
            conv="css",
            pt=Pt(x=90, y=75),
            ctx=CoordCtx(dpr=2, viewport=vp),
            pg=grid,
            target="t-0-0",
            bug="—",
            wrong=lambda: to_viewport(Pt(x=90, y=75), "css", CoordCtx(dpr=2, viewport=vp)),
        ),
        CoordCase(
            label="device（DPR 2）",
            conv="device",
            pt=Pt(x=180, y=150),
            ctx=CoordCtx(dpr=2, viewport=vp),
            pg=grid,
            target="t-0-0",
            bug="忘了除 DPR",
            wrong=lambda: to_viewport(Pt(x=180, y=150), "css", CoordCtx(dpr=2, viewport=vp)),
        ),
        CoordCase(
            label="scaledShot（2880→1280）",
            conv="scaledShot",
            pt=Pt(x=1200, y=733),
            ctx=CoordCtx(dpr=2, viewport=vp, shot=Size(w=1280, h=800)),
            pg=grid,
            target="t-5-7",
            bug="忘了放大回去",
            wrong=lambda: to_viewport(Pt(x=1200, y=733), "css", CoordCtx(dpr=2, viewport=vp)),
        ),
        CoordCase(
            label="gemini1000",
            conv="gemini1000",
            pt=Pt(x=63, y=83),
            ctx=CoordCtx(dpr=2, viewport=vp),
            pg=grid,
            target="t-0-0",
            bug="乘了截图尺寸",
            wrong=lambda: to_viewport(
                Pt(x=63, y=83), "gemini1000", CoordCtx(dpr=2, viewport=Size(w=2880, h=1800))
            ),
        ),
        CoordCase(
            label="fullPage（scrollY 600）",
            conv="fullPage",
            pt=Pt(x=450, y=825),
            ctx=CoordCtx(dpr=2, viewport=vp, scroll_y=600),
            pg=scrolled,
            target="t-5-2",
            bug="没减 scrollY",
            wrong=lambda: to_viewport(Pt(x=450, y=825), "css", CoordCtx(dpr=2, viewport=vp)),
        ),
        CoordCase(
            label="iframe 内坐标",
            conv="css",
            pt=Pt(x=170, y=55),
            ctx=CoordCtx(dpr=1, viewport=Size(w=1280, h=800), frame_offset=Pt(x=40, y=200)),
            pg=co,
            target="card",
            bug="忘了加 iframe 偏移",
            wrong=lambda: to_viewport(
                Pt(x=170, y=55), "css", CoordCtx(dpr=1, viewport=Size(w=1280, h=800))
            ),
        ),
    ]


def exp7() -> None:
    print(bold("\n实验七 · 同一个目标，五种坐标约定（网格页 1440×900、DPR 2，每格一个按钮）"))

    def show(r: VPoint, pg: FakePage) -> str:
        if not r.ok:
            return r.error
        top = hit_test(pg, r)
        return f"({r.x},{r.y}) → {top if top is not None else '无'}"

    print(
        dim(
            f"  {pad('约定', 26)}{pad('模型给的', 12)}{pad('正确换算 → 命中', 26)}{pad('常见错法', 20)}错法 → 命中"
        )
    )
    for c in coord_cases():
        right = to_viewport(c.pt, c.conv, c.ctx)
        wrong = "—" if c.bug == "—" else show(c.wrong(), c.pg)
        print(
            f"  {pad(c.label, 26)}{pad(f'({c.pt.x},{c.pt.y})', 12)}{pad(show(right, c.pg), 26)}{pad(c.bug, 20)}{wrong}"
        )
    grid = grid_page(0)
    out = to_viewport(
        Pt(x=1000, y=500), "gemini1000", CoordCtx(dpr=2, viewport=Size(w=1440, h=900))
    )
    print(
        f"  gemini (1000,500)：{out.error}；如果钳到边上 → (1439,450) → {hit_test(grid, Pt(x=1439, y=450))}，点到一个模型没说的按钮"
    )
    print(
        dim(
            "  坐标没有任何失效检测：它只在某一个像素空间、某一个滚动位置下成立，三个条件任何一个变了都不报错，只是点到别处。"
        )
    )


def exp8() -> None:
    print(bold("\n实验八 · 三种「可见」（buttons10 页，800×600 视口）"))
    pg = page("buttons10")
    ai = snapshot(pg, new_ref_state())
    ids = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10"]
    print(
        dim(
            f"  {pad('按钮', 14)}{pad('MCP verify', 12)}{pad('isVisible', 11)}{pad('ai 快照', 9)}{pad('box', 5)}{pad('视口', 6)}{pad('hit', 5)}{pad('像素', 6)}原因"
        )
    )
    exists = 0
    all_ = 0
    for id_ in ids:
        v = visual_visibility(pg, id_)
        loc = find_node(pg, id_)
        assert loc is not None and loc.node.text is not None
        name = loc.node.text
        quoted = f'"{name}"'
        if v.exists:
            exists += 1
        if v.exists and v.box and v.in_viewport and v.hit and v.pixels:
            all_ += 1
        print(
            f"  {pad(name, 14)}{pad(yn(mcp_verify_visible(pg, id_)), 12)}{pad(yn(playwright_is_visible(pg, id_)), 11)}{pad(yn(quoted in ai.text), 9)}"
            f"{pad(yn(v.box), 5)}{pad(yn(v.in_viewport), 6)}{pad(yn(v.hit), 5)}{pad(yn(v.pixels), 6)}{' '.join(v.reasons)}"
        )
    print(f"  MCP verify 通过 {exists}/10；五层全过 {all_}/10")
    ov = page("overlays")
    print(dim("\n  遮罩：浏览器的命中规则 vs browser-use 的遮挡规则"))
    for id_, what in [
        ("o1-btn", "透明 div 盖住"),
        ("o2-btn", "pointer-events:none 的 div 盖住"),
        ("o3-btn", "不透明的黑色遮罩盖住"),
    ]:
        loc = find_node(ov, id_)
        assert loc is not None
        c = center_of(ov, loc)
        by_browser = hit_test(ov, c, "browser")
        by_bu = hit_test(ov, c, "browserUse")
        print(
            f"  {pad(what, 34)}browser → {pad(by_browser if by_browser is not None else '无', 10)}browserUse → {by_bu if by_bu is not None else '无'}"
        )
    print(
        dim(
            "  透明点击拦截层（clickjacking 的经典形态）在浏览器里吃掉点击，在 browser-use 眼里不存在。"
        )
    )


def exp9() -> None:
    print(bold("\n实验九 · 审批框显示的，和实际执行的（checkout 页）"))
    pg = page("checkout")
    st = new_ref_state()
    s = snapshot(pg, st)
    for line in s.text.split("\n"):
        print(dim(f"    {line}"))
    click = BrowserAction(tool="click", element="Cancel", target=ref_of(s.refs, "btn-delete"))
    type_ = BrowserAction(
        tool="type",
        element="Email field",
        target=ref_of(s.refs, "card"),
        text="4242 4242 4242 4242",
    )
    for a in [click, type_]:
        v = approval_view(a, st, pg)
        print(f'  模型：{a.tool}(element="{a.element}", target={a.target})')
        print(f"    照抄 element 的审批框：{v.displayed}")
        print(
            f"    实际执行：              {v.executed}    displayMatchesExecution = {_js_bool(display_matches_execution(v.displayed, v.executed))}"
        )
    chs = browser_channels(pg)
    print(dim("\n  这一页的出站通道（交给 L14 的 auditChannels）："))
    for c in chs:
        print(f"    {pad(c.kind, 10)}{pad(c.name, 24)}{c.origin}")
    print(f"  {audit_channels(to_guard_channels(chs)).verdict}")
    print(
        f"  关掉页面工具后：{audit_channels(to_guard_channels(chs, ['pageTool:apply_coupon'])).verdict}"
    )

    print(dim("\n  白名单（每一跳都查；substring 是常见错法）："))
    print(
        dim(
            f"    {pad('情形', 18)}{pad('白名单', 18)}{pad('逐跳规范化后', 36)}{pad('substring', 11)}链"
        )
    )
    for label, ch, allow in nav_cases():
        v = navigation_allowed(ch, allow)
        naive = allow[0].replace("*.", "", 1) in ch[0]
        verdict = "放行" if v.ok else f"拦：第 {v.blocked_at + 1} 跳 {v.host}"
        print(
            f"    {pad(label, 18)}{pad(','.join(allow), 18)}{pad(verdict, 36)}{pad('放行' if naive else '拦', 11)}{' → '.join(ch)}"
        )
    print(
        dim(
            '  "Typing sensitive information into a form counts as transmission." 卡号输入框的目的地是支付 iframe 的 origin。'
        )
    )


# ─────────────────────────────────────────────────────────────
# TODO（verify 测这几个）
# ─────────────────────────────────────────────────────────────


def my_is_aria_visible(n: FakeNode, anc: Inherited, mode: SnapshotMode) -> bool:
    """TODO 1 ★ 这个节点进不进快照。anc 是从祖先继承下来的两件事（hidden_for_all、aria_hidden）。
    规则：
      - display:none、visibility:hidden、hidden 属性（自己或祖先），两种模式都不收（用 self_hidden）
      - 'default'：aria-hidden（自己或祖先）的不收，其余都收
      - 'ai'：aria-hidden 的，只要视觉上有盒子（has_box）就收
    注意你**不该**看的东西：opacity、clip、颜色、字号、在不在视口里。
    """
    raise NotImplementedError("TODO 1 未实现")


def my_accessible_name(n: FakeNode) -> str:
    """TODO 2 ★ 可访问名称。依次：aria-label → img 的 alt → 内容（只对 NAME_FROM_CONTENT 里的角色，用 text_content）→ title。
    每一步都先 collapse_spaces，空串算没有。canvas 的 text 是画在像素里的，不能当名字（text_content 已经跳过它）。
    """
    raise NotImplementedError("TODO 2 未实现")


def my_assign_ref(state: RefState, page: FakePage, node_id: str, role: str, name: str) -> str:
    """TODO 3 ★★ 给节点一个 ref（Playwright computeAriaRef）。
      - page.doc_seq 和 state.doc_seq 不一样：换文档了，计数器、expando、last 全清，state.doc_seq 跟上
      - expando 里有这个节点，且 role、name 都没变 → 沿用旧 ref
      - 否则 last_ref 加一，ref = ref_prefix(doc_seq) + 'e' + last_ref，写回 expando（RefEntry）
    计数器从不回退，旧号从不复用。
    """
    raise NotImplementedError("TODO 3 未实现")


def my_drift_check(seen: SeenLine, page: FakePage, node_id: str) -> Drift:
    """TODO 4 ★★ 模型看到的那一行（seen）和节点现在的样子比。
      节点不在了 → 'gone'；role 或 name 变了 → 'renamed'；所在行的文字（row_context）变了 → 'context-changed'；否则 'same'。
    节点现在的样子可以用 describe_node。只比 role + name 的版本会在同名重排上报 'same'。
    """
    raise NotImplementedError("TODO 4 未实现")


def my_to_viewport(pt: Pt, conv: CoordConv, ctx: CoordCtx) -> VPoint:
    """TODO 5 ★ 任意约定的坐标 → 整数 CSS 视口坐标（约定见 shared 里 CoordConv 的注释）。
    device ÷ dpr；scaledShot × viewport / shot；gemini1000 × viewport / 1000；fullPage 减 scroll_y；最后加 frame_offset。
    所有除法都用 round_half_up(分子, 分母)，不要用 round()（银行家舍入）。
    结果在视口外（x<0、y<0、x≥w、y≥h）：返回 VPoint(ok=False, x=0, y=0, error=f"outside-viewport ({x},{y})")，不钳位。
    """
    raise NotImplementedError("TODO 5 未实现")


def my_visual_visibility(page: FakePage, node_id: str) -> Visibility:
    """TODO 6 ★★ 五层可见性（类型见 Visibility）。shared 里有你需要的零件：
      find_node、inherited_of、is_aria_visible、has_box、self_hidden、center_of、hit_test、is_descendant、
      eff_opacity、is_clipped、eff_font_size、eff_color、eff_background、brightness、CONTRAST_MIN、OPACITY_MIN。
      exists      不在 closed shadow 里，且 is_aria_visible(…, 'default')
      box         has_box，且自己和祖先都没被 display/visibility/hidden 藏住
      in_viewport 有盒子，且中心点在视口里
      hit         在视口里，且 hit_test(中心点, 'browser') 是它自己或它的子孙
      pixels      有盒子，eff_opacity ≥ OPACITY_MIN，没被裁，字号不为 0，亮度差 ≥ CONTRAST_MIN
    reasons 的写法照 shared：'not-in-a11y-tree'、'zero-box'、'outside-viewport'、'blocked-by:<id>'、
      'opacity:<n>'、'clipped'、'font-size:0'、'low-contrast:<n>'。节点不存在：全 False，reasons ['missing']。
    """
    raise NotImplementedError("TODO 6 未实现")


def my_normalize_host(u: str) -> str:
    """TODO 7 ★ 白名单的两半。
    my_normalize_host：取 '://' 之后、第一个 / ? # 之前；去掉最后一个 @ 及之前的 userinfo；https:443、http:80 和空端口去掉；
      ASCII 小写（不用 str.lower()）；去掉末尾所有的点。不要用 urllib。
    my_navigation_allowed：链上**每一跳**都规范化后查白名单（host_allowed 的规则：精确相等，或 '*.x' 匹配 x 的子域、不含 x 本身）。
      第 i 跳不过 → NavVerdict(ok=False, blocked_at=i, host=…)；全过 → NavVerdict(ok=True, blocked_at=-1, host=最后一跳)。
    """
    raise NotImplementedError("TODO 7 未实现")


def my_navigation_allowed(chain: list[str], allow: list[str]) -> NavVerdict:
    raise NotImplementedError("TODO 7 未实现")


# ─────────────────────────────────────────────────────────────


def main() -> None:
    exp1()
    exp2()
    exp3()
    exp4()
    exp5()
    exp6()
    exp7()
    exp8()
    exp9()
    print(
        dim(
            "\n  模型看到的页面 ≠ 用户看到的页面 ≠ 实际被执行的那个元素。\n"
            "  这一课的每个函数都在量其中一个差；写完七个 TODO 跑 pnpm verify:l14x。\n"
        )
    )


if __name__ == "__main__":
    main()
