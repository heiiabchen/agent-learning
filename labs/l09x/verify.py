"""验证 l09x/kb.py。
  KB_IMPL=shared uv run python -m l09x.verify
  uv run python -m l09x.verify

零网络、零模型、零向量库。所有输入来自 fixtures/corpus.json 和 kb.py 里的确定性夹具。
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from dataclasses import dataclass, fields, replace
from types import SimpleNamespace
from typing import Any

from l09x.kb import (
    AS_OF,
    GEN,
    all_chunks,
    ann_fixture,
    ann_visible,
    bad_docs,
    budget_table,
    doc_by_id,
    load_corpus,
    run_sync,
    tenant_docs,
    version_scenarios,
)
from shared import kb as shared
from shared.coding_eval import fmt_fixed
from shared.kb import (
    AnnHit,
    Block,
    ChunkOpts,
    FilteredSearch,
    FilterMode,
    FilterOpts,
    HeadingInfo,
    KbChunk,
    ParsedPage,
    RerankResult,
    Session,
    SyncChunk,
    TableData,
    VersionCand,
    VersionVerdict,
)

TARGET = "shared" if os.environ.get("KB_IMPL") == "shared" else "mine"


@dataclass(frozen=True)
class Api:
    heading_level: Callable[[str], HeadingInfo | None]
    render_table_rows: Callable[..., list[str]]
    search_filtered: Callable[[list[AnnHit], Callable[[str], bool], FilterOpts], FilteredSearch]
    rerank_pipeline: Callable[..., RerankResult]
    resolve_versions: Callable[[list[VersionCand], str], VersionVerdict]
    apply_sync: Callable[..., list[SyncChunk]]
    cache_key: Callable[[str, list[str], str], str]


def _load_mine() -> Api:
    from l09x import kb as m

    return Api(
        heading_level=m.my_heading_level,
        render_table_rows=m.my_render_table_rows,
        search_filtered=m.my_search_filtered,
        rerank_pipeline=m.my_rerank_pipeline,
        resolve_versions=m.my_resolve_versions,
        apply_sync=m.my_apply_sync,
        cache_key=m.my_cache_key,
    )


M = (
    Api(
        heading_level=shared.heading_level,
        render_table_rows=shared.render_table_rows,
        search_filtered=shared.search_filtered,
        rerank_pipeline=shared.rerank_pipeline,
        resolve_versions=shared.resolve_versions,
        apply_sync=shared.apply_sync,
        cache_key=shared.cache_key,
    )
    if TARGET == "shared"
    else _load_mine()
)

print(
    "\n（测的是 shared/ 里的参考实现）" if TARGET == "shared" else "\n（测的是 l09x/ 里你的实现）"
)

DIM, BOLD, RED, GREEN, OFF = "\x1b[2m", "\x1b[1m", "\x1b[31m", "\x1b[32m", "\x1b[0m"


def bold(s: str) -> str:
    return f"{BOLD}{s}{OFF}"


def red(s: str) -> str:
    return f"{RED}{s}{OFF}"


def green(s: str) -> str:
    return f"{GREEN}{s}{OFF}"


def dim(s: str) -> str:
    return f"{DIM}{s}{OFF}"


class Fail(Exception):
    pass


def need(cond: bool, why: str) -> None:
    if not cond:
        raise Fail(why)


def throws(fn: Callable[[], object]) -> bool:
    try:
        fn()
        return False
    except Exception as e:
        return re.search(r"TODO [0-9]+ 未实现", str(e)) is None


passed = 0
failed = 0


def t(id_: str, name: str) -> Callable[[Callable[[], None]], Callable[[], None]]:
    """装饰器：定义即运行。和 TS 的 t(id, name, () => {...}) 一样按出现顺序执行。"""

    def run(fn: Callable[[], None]) -> Callable[[], None]:
        global passed, failed
        try:
            fn()
            passed += 1
        except Exception as e:
            failed += 1
            why = str(e) if isinstance(e, Fail) else f"抛出了异常：{e}"
            print(red(f"  ✗ {id_} {name}") + dim(f"\n      {why}"))
        return fn

    return run


def section(s: str) -> None:
    print(bold(f"\n{s}"))


def js(x: Any) -> str:
    """J(x) = JSON.stringify(x)。dataclass 按 TS 的字段名和顺序展开，可选字段为 None 时省略。"""
    return shared.json_stringify(x)


def js_opt(x: Any) -> str:
    """J(x?.y)：x 不存在时 TS 打印的是 undefined。"""
    return "undefined" if x is None else js(x)


def tpl(x: Any) -> str:
    """模板字符串里的 ${x}：null 印成 null，不是 None。"""
    return "null" if x is None else str(x)


C = load_corpus()
U: dict[str, Session] = C.users


def mine_opts() -> ChunkOpts:
    return ChunkOpts(heading_level=M.heading_level, render_table_rows=M.render_table_rows)


def chunks_of(id_: str) -> list[KbChunk]:
    return shared.chunk_document(doc_by_id(C, id_), GEN, mine_opts())


def everything() -> list[KbChunk]:
    return all_chunks(C, mine_opts())


PRE = FilterOpts(k=10, ef=40, mode="pre", max_scan=400)

# ─────────────────────────────────────────────────────────────
section("PARSE · 解析后清洗")


def page(index0: int, top: str) -> ParsedPage:
    return ParsedPage(
        index0=index0,
        blocks=[
            Block(id=f"p{index0}b0", kind="text", text=top, y=40),
            Block(id=f"p{index0}b1", kind="text", text=f"正文第 {index0} 页。", y=400),
        ],
    )


@t("PARSE-1", "跨页统计出页眉「青禾科技 内部资料」")
def _parse1() -> None:
    r = shared.detect_running_lines(doc_by_id(C, "travel-2023").pages)
    need(js(r) == js(["青禾科技 内部资料"]), f"实际 {js(r)}")


@t("PARSE-2", "只在两页顶部出现的行不算页眉（minPages = 3）")
def _parse2() -> None:
    two = shared.detect_running_lines(
        [page(0, "第二章 住宿标准"), page(1, "第二章 住宿标准"), page(2, "第三章 报销流程")]
    )
    need(len(two) == 0, f"两页就删了：{js(two)}")
    three = shared.detect_running_lines([page(0, "机密"), page(1, "机密"), page(2, "机密")])
    need(js(three) == js(["机密"]), f"三页应检出，实际 {js(three)}")


@t("PARSE-3", "chunk 里没有页眉和页码行")
def _parse3() -> None:
    for c in chunks_of("travel-2023"):
        need("青禾科技 内部资料" not in c.text, f"{c.id} 里还有页眉")
        need("— 1 —" not in c.text and "— ii —" not in c.text, f"{c.id} 里还有页码行")


@t("PARSE-4", "脚注「① 不含外包人员费用。」附在预算表的每一行上")
def _parse4() -> None:
    rows = [c for c in chunks_of("budget-2025") if c.kind == "table_row"]
    need(len(rows) > 0, "没有表格行 chunk")
    for r in rows:
        need("① 不含外包人员费用。" in r.text, f"{r.id} 没带脚注：{js(r.text)}")


@t("PARSE-5", "跨页表格的后半段继承表头；跨页段落的页码是一个范围")
def _parse5() -> None:
    cs = chunks_of("budget-2025")
    admin = next((c for c in cs if "行政部" in c.text), None)
    need(
        admin is not None and "2025年/金额: 400" in admin.text and js(admin.pages) == "[2,2]",
        f"行政部那行：{js_opt(admin)}",
    )
    tail = next((c for c in cs if "经财务部审批后方可列支" in c.text), None)
    need(
        tail is not None and js(tail.pages) == "[2,3]" and "超支部分须经财务部审批" in tail.text,
        f"跨页段落：{js_opt(tail)}",
    )


@t("PARSE-6", "normalizeText 先去 BOM 再 NFKC")
def _parse6() -> None:
    need(shared.normalize_text("\ufeff第一章").startswith("第"), "BOM 没去掉")
    need(shared.normalize_text("（１）") == "(1)", f"实际 {js(shared.normalize_text('（１）'))}")
    need(
        "3" in shared.kb_tokenize("第３条"), f"切词前没做 NFKC：{js(shared.kb_tokenize('第３条'))}"
    )


# ─────────────────────────────────────────────────────────────
section("NUM · 中文编号")


def lv(s: str) -> int | None:
    h = M.heading_level(s)
    return h.level if h is not None else None


@t("NUM-1", "「第十二条」是条级，「第三章」是章级")
def _num1() -> None:
    h = M.heading_level("第十二条 适用范围")
    need(h is not None and h.level == 3 and h.label == "第十二条", f"实际 {js(h)}")
    need(
        lv("第三章 报销流程") == 1 and lv("第二节 标准") == 2,
        f"章 {tpl(lv('第三章 报销流程'))}，节 {tpl(lv('第二节 标准'))}",
    )


@t("NUM-2", "全角括号与半角括号同级")
def _num2() -> None:
    need(
        lv("（一）总则") == 2 and lv("(一)总则") == 2,
        f"（一）{tpl(lv('（一）总则'))}，(一) {tpl(lv('(一)总则'))}",
    )


@t("NUM-3", "全角数字与半角数字同级")
def _num3() -> None:
    need(
        lv("１、总则") is not None and lv("１、总则") == lv("1、总则"),
        f"１、{tpl(lv('１、总则'))}，1、{tpl(lv('1、总则'))}",
    )
    need(lv("（２）住宿") == 4, f"（２）应为 4 级，实际 {tpl(lv('（２）住宿'))}")


def _ascending(xs: list[int | None]) -> bool:
    ys = [x for x in xs if x is not None]
    return len(ys) == len(xs) and all(ys[i] < ys[i + 1] for i in range(len(ys) - 1))


@t("NUM-4", "GB/T 9704 四级序：一、<（一）< 1. <（1）")
def _num4() -> None:
    xs = [lv("一、总则"), lv("（一）编制依据"), lv("1. 适用范围"), lv("（1）人员费用")]
    need(_ascending(xs), f"实际 {js(xs)}")


@t("NUM-5", "多级小节越长越深")
def _num5() -> None:
    xs = [lv("1. 总则"), lv("1.1 节"), lv("1.1.2 小节")]
    need(_ascending(xs), f"实际 {js(xs)}")


@t("NUM-6", "数字开头的正文不是标题")
def _num6() -> None:
    for s in [
        "2025年预算增长10%。",
        "1.5元以内的发票可以不贴",
        "本办法自 2023 年起施行。",
        "300 元为上限",
    ]:
        need(M.heading_level(s) is None, f"{js(s)} 被当成了标题：{js(M.heading_level(s))}")


# ─────────────────────────────────────────────────────────────
section("TABLE · 表格")

NAMES = ["部门", "2025年/金额", "2025年/占比", "2024年/金额", "2024年/占比"]


@t("TABLE-1", "每一行都带着全部列名")
def _table1() -> None:
    rows = M.render_table_rows(budget_table(C))
    need(len(rows) == 7, f"应有 7 行，实际 {len(rows)}")
    for r in rows:
        for n in NAMES:
            need(f"{n}: " in r, f"{js(r)} 缺列名 {n}")


@t("TABLE-2", "两级表头按列拼：「2025年/金额」和「2025年/占比」是两列")
def _table2() -> None:
    r = M.render_table_rows(budget_table(C))[1]
    need("2025年/金额: 1200" in r and "2025年/占比: 25.9%" in r, f"实际 {js(r)}")


@t("TABLE-3", "「合计」行也带列名")
def _table3() -> None:
    r = M.render_table_rows(budget_table(C))[6]
    need(
        "部门: 合计" in r and "2025年/金额: 4630" in r and "2024年/占比: 100%" in r, f"实际 {js(r)}"
    )


@t("TABLE-4", "每一行都带 caption；caption 为空时不留前导空格")
def _table4() -> None:
    for r in M.render_table_rows(budget_table(C)):
        need(r.startswith("表3 各部门预算（万元）① "), f"{js(r)} 没带 caption")
    bare = TableData(
        caption="", header_rows=[["城市", "上限"]], rows=[["一线", "500"], ["其他", ""]]
    )
    out = M.render_table_rows(bare)
    need(js(out) == js(["城市: 一线; 上限: 500", "城市: 其他"]), f"实际 {js(out)}")


@t("TABLE-5", "「研发部 2025年 金额」的 BM25 第一名是研发部那一行")
def _table5() -> None:
    cs = chunks_of("budget-2025")
    docs = shared.chunk_docs(cs)
    ranked = shared.bm25_rank(docs, docs, "研发部 2025年 金额")
    top = ranked[0] if ranked else None
    c = next((x for x in cs if top is not None and x.id == top.id), None)
    need(
        c is not None and "部门: 研发部" in c.text and "2025年/金额: 1200" in c.text,
        f"第一名 {js_opt(c.text if c is not None else None)}",
    )


@t("TABLE-6", "表格行 chunk 数 = 数据行数；hiddenColumns 的列不出现")
def _table6() -> None:
    rows = [c for c in chunks_of("budget-2025") if c.kind == "table_row"]
    need(len(rows) == 7, f"应有 7 个表格行 chunk，实际 {len(rows)}")
    hr = TableData(
        caption="附表", header_rows=[["姓名", "职级", "月薪"]], rows=[["张三", "P6", "23000"]]
    )
    out = M.render_table_rows(hr, ["月薪"])
    need(js(out) == js(["附表 姓名: 张三; 职级: P6"]), f"实际 {js(out)}")


# ─────────────────────────────────────────────────────────────
section("ACL · 权限")

ANN = ann_fixture()


def run_ann(m: int, mode: FilterMode) -> list[FilteredSearch]:
    return [
        M.search_filtered(r, ann_visible(m), FilterOpts(k=10, ef=40, mode=mode, max_scan=400))
        for r in ANN
    ]


def total(xs: list[FilteredSearch]) -> int:
    n = 0
    for x in xs:
        n += len(x.ids)
    return n


def find_score(cands: list[AnnHit], id_: str) -> float:
    return next(h for h in cands if h.id == id_).score


@t("ACL-1", "缺 acl 的 chunk 谁都看不见（fail-closed）")
def _acl1() -> None:
    need(not shared.acl_visible(SimpleNamespace(acl=None), ["group:all"]), "缺 acl 被当成公开了")
    legacy = shared.chunk_document(doc_by_id(C, "legacy-notice"), GEN)
    for name in U:
        need(not any(shared.can_see(c, U[name]) for c in legacy), f"{name} 看到了 legacy-notice")


@t("ACL-2", "同名的组和用户是两个 principal")
def _acl2() -> None:
    need(
        shared.principal_key("group", "alice@qinghe.com")
        != shared.principal_key("user", "alice@qinghe.com"),
        "前缀没区分类型",
    )


@t("ACL-3", "principal 名字大小写不敏感；外部组必须带来源")
def _acl3() -> None:
    need(
        shared.principal_key("user", "Alice@Qinghe.com")
        == shared.principal_key("user", "alice@qinghe.com"),
        "大小写变体成了两个 key",
    )
    need(
        shared.principal_key("ext_group", "Eng", "Confluence") == "ext_group:confluence/eng",
        f"实际 {shared.principal_key('ext_group', 'Eng', 'Confluence')}",
    )
    need(throws(lambda: shared.principal_key("ext_group", "eng")), "外部组没带来源也通过了")


@t("ACL-4", "新人 dave 的预过滤检索里没有 HR、预算、研发部的文档")
def _acl4() -> None:
    hits = shared.search_kb(
        everything(), "研发部 2025 年 预算 薪酬 住宿", U["dave"], PRE, M.search_filtered
    )
    need(len(hits) > 0, "一条都没搜到")
    for h in hits:
        need(h.doc_id in ["travel-2023", "travel-2025", "travel-2026"], f"dave 看到了 {h.doc_id}")


@t("ACL-5", "2% 选择率下 post 返回远少于 k（证明后过滤会少）")
def _acl5() -> None:
    r = run_ann(50, "post")
    least = min(len(x.ids) for x in r)
    need(total(r) == 12 and least == 0, f"20 个查询共返回 {total(r)} 条（应 12），最少 {least}")
    need(all(x.scanned == 40 for x in r), "post 只该看 ef 个候选")


@t("ACL-6", "同条件 pre 每次都返回 k 条")
def _acl6() -> None:
    r = run_ann(50, "pre")
    need(all(len(x.ids) == 10 for x in r), f"实际 {js([len(x.ids) for x in r])}")


@t("ACL-7", "iterative 返回不少于 post，且扫描量不超过 maxScan")
def _acl7() -> None:
    it = run_ann(50, "iterative")
    need(
        total(it) == 144 and total(it) >= total(run_ann(50, "post")),
        f"iterative 共返回 {total(it)} 条（应 144）",
    )
    need(all(x.scanned <= 400 for x in it), f"扫描量超过上限：{max(x.scanned for x in it)}")
    need(all(x.scanned == 40 for x in run_ann(2, "iterative")), "50% 选择率一轮就够，不该继续扩张")


@t("ACL-8", "iterative 不够 k 条时宁可少给，结果全部可见")
def _acl8() -> None:
    for m in [2, 10, 50, 200]:
        vis = ann_visible(m)
        for x in run_ann(m, "iterative"):
            need(len(x.ids) <= 10 and all(vis(i) for i in x.ids), f"选择率 1/{m} 混入了越权结果")


@t("ACL-9", "filter-first 发给 reranker 的全部可见；结果按 reranker 的分数排")
def _acl9() -> None:
    vis = ann_visible(10)
    cands = ANN[0][:40]

    def reverse(ids: list[str]) -> list[float]:
        return [-find_score(cands, i) for i in ids]

    r = M.rerank_pipeline(cands, vis, "filter-first", reverse, 3)
    need(
        len(r.exposed) > 0 and all(vis(i) for i in r.exposed),
        f"发出了越权候选：{js([i for i in r.exposed if not vis(i)])}",
    )
    want = [h.id for h in cands if vis(h.id)][::-1][:3]
    need(js(r.ids) == js(want), f"应按 reranker 分数取前 3：{js(want)}，实际 {js(r.ids)}")


def by_score(cands: list[AnnHit]) -> Callable[[list[str]], list[float]]:
    return lambda ids: [find_score(cands, i) for i in ids]


@t("ACL-10", "rerank-first 与 filter-first 结果相同，外发的不同")
def _acl10() -> None:
    vis = ann_visible(50)
    for r in ANN[:5]:
        cands = r[:40]
        score = by_score(cands)
        a = M.rerank_pipeline(cands, vis, "filter-first", score, 10)
        b = M.rerank_pipeline(cands, vis, "rerank-first", score, 10)
        need(js(a.ids) == js(b.ids), f"结果不同：{js(a.ids)} vs {js(b.ids)}")
        need(
            len(b.exposed) == 40
            and len([i for i in b.exposed if not vis(i)]) > 0
            and all(vis(i) for i in a.exposed),
            "外发集合没有区别",
        )


@t("ACL-11", "工具参数里出现权限相关字段一律拒绝")
def _acl11() -> None:
    bad: list[dict[str, Any]] = [
        {"query": "报销", "filter": {}},
        {"query": "报销", "user_groups": ["group:hr"]},
        {"query": "报销", "doc_ids": ["hr-salary"]},
        {"query": "报销", "tenant": "globex"},
    ]
    for args in bad:
        need(
            throws(lambda a=args: shared.build_search_request(a, U["dave"])), f"{js(args)} 没被拒绝"
        )
    need(
        not throws(lambda: shared.build_search_request({"query": "报销", "k": 3}, U["dave"])),
        "正常参数被拒绝了",
    )


@t("ACL-12", "ACL 在 knn.filter 里，来自会话")
def _acl12() -> None:
    req = shared.build_search_request({"query": "报销"}, U["bob"])
    keys = [f.name for f in fields(req)]
    need(js(keys) == js(["query", "k", "knn"]), f"外层多了字段：{js(keys)}")
    need(
        req.knn.filter.tenant == "acme" and js(req.knn.filter.acl_any) == js(U["bob"].principals),
        f"实际 {js(req.knn.filter)}",
    )


@t("ACL-13", "多人会话按交集：alice 单独看得见、和 dave 一起就看不见")
def _acl13() -> None:
    c = chunks_of("hr-salary")[0]
    need(shared.visible_to_all(c, [U["alice"]]), "alice 单独应可见")
    need(not shared.visible_to_all(c, [U["alice"], U["dave"]]), "有 dave 在场仍然可见")
    need(not shared.visible_to_all(c, []), "没有人在场不该可见")


@t("ACL-14", "字段级权限在索引时做：bob 看不到月薪，也搜不到它")
def _acl14() -> None:
    cs = everything()
    bob_rows = [
        c
        for c in cs
        if c.doc_id == "hr-salary" and c.kind == "table_row" and shared.can_see(c, U["bob"])
    ]
    need(
        len(bob_rows) == 2
        and all("23000" not in c.text and "月薪" not in c.text for c in bob_rows),
        f"bob 看到的行：{js([c.text for c in bob_rows])}",
    )
    need(
        len(shared.search_kb(cs, "23000", U["bob"], PRE, M.search_filtered)) == 0,
        "用月薪的值当查询，bob 命中了",
    )
    a = shared.search_kb(cs, "23000", U["alice"], PRE, M.search_filtered)
    need(
        len(a) == 1 and "月薪: 23000" in a[0].text,
        f"alice 应命中完整行，实际 {js([c.text for c in a])}",
    )


# ─────────────────────────────────────────────────────────────
section("TENANT · 多租户（参考实现，只读）")


@t("TENANT-1", "每租户统计下，globex 的结果里没有 acme 的文档")
def _tenant1() -> None:
    r = shared.tenant_search(tenant_docs(10), "per-tenant", "报销 发票", "globex", 20)
    need(len(r) > 0 and all(h.id.startswith("B") for h in r), f"实际 {js([h.id for h in r])}")


@t("TENANT-2", "共享统计下 globex 多 10 篇，acme 的第一名就变了")
def _tenant2() -> None:
    def top(n: int, scope: shared.StatScope) -> str:
        return shared.tenant_search(tenant_docs(n), scope, "报销 发票", "acme", 10)[0].id

    need(
        top(0, "shared") == "A1" and top(10, "shared") == "A2",
        f"共享：{top(0, 'shared')} → {top(10, 'shared')}",
    )
    need(top(10, "per-tenant") == "A1" and top(50, "per-tenant") == "A1", "每租户统计不该变")


@t("TENANT-3", "每租户统计与单独建索引逐位相等")
def _tenant3() -> None:
    own = tenant_docs(0)
    alone = [f"{h.id}:{fmt_fixed(h.score, 6)}" for h in shared.bm25_rank(own, own, "报销 发票")]
    per = [
        f"{h.id}:{fmt_fixed(h.score, 6)}"
        for h in shared.tenant_search(tenant_docs(50), "per-tenant", "报销 发票", "acme", 10)
    ]
    need(js(alone) == js(per), f"{js(alone)} vs {js(per)}")


# ─────────────────────────────────────────────────────────────
section("VER · 版本消解")

SC = version_scenarios()


def sc(i: int) -> list[VersionCand]:
    return SC[i].cands


@t("VER-1", "S1 新版已生效 → 办法2025")
def _ver1() -> None:
    v = M.resolve_versions(sc(0), AS_OF)
    need(v.chosen == "办法2025" and not v.conflict, f"实际 {js(v)}")


@t("VER-2", "S2 新版未生效：今天用 2025，2027-01-01 起用 2026")
def _ver2() -> None:
    a = M.resolve_versions(sc(1), AS_OF)
    b = M.resolve_versions(sc(1), "2027-01-01")
    need(
        a.chosen == "办法2025" and b.chosen == "办法2026",
        f"今天 {tpl(a.chosen)}，2027-01-01 {tpl(b.chosen)}",
    )


@t("VER-3", "S3 旧版被重新编辑（mtime 最新）→ 仍是办法2025")
def _ver3() -> None:
    v = M.resolve_versions(sc(2), AS_OF)
    need(v.chosen == "办法2025", f"实际 {js(v)}")


@t("VER-4", "S4 上位优先，并标注下位冲突")
def _ver4() -> None:
    v = M.resolve_versions(sc(3), AS_OF)
    need(v.chosen == "集团制度" and v.conflict, f"实际 {js(v)}")


@t("VER-5", "S5 新的一般 vs 旧的特别 → 交人裁决；真实语料里 bob 和 alice 结论不同")
def _ver5() -> None:
    v = M.resolve_versions(sc(4), AS_OF)
    need(v.chosen is None and v.conflict, f"实际 {js(v)}")

    def travel(s: Session) -> VersionVerdict:
        m: dict[str, VersionCand] = {}
        for c in everything():
            if c.version.family == "travel" and shared.can_see(c, s):
                m[c.doc_id] = VersionCand(doc_id=c.doc_id, version=c.version)
        return M.resolve_versions(list(m.values()), AS_OF)

    bob = travel(U["bob"])
    alice = travel(U["alice"])
    need(
        bob.chosen is None and bob.conflict and alice.chosen == "travel-2025",
        f"bob {js(bob)}，alice {js(alice)}",
    )


@t("VER-6", "S6 已废止的不选")
def _ver6() -> None:
    v = M.resolve_versions(sc(5), AS_OF)
    need(v.chosen == "暂行规定", f"实际 {js(v)}")


@t("VER-7", "缺 effectiveFrom 的不参与自动消解")
def _ver7() -> None:
    legacy = VersionCand(doc_id="legacy-notice", version=doc_by_id(C, "legacy-notice").version)
    v = M.resolve_versions([legacy, sc(0)[1]], AS_OF)
    need(v.chosen == "办法2025" and "effectiveFrom" in v.reason, f"实际 {js(v)}")
    only = M.resolve_versions([legacy], AS_OF)
    need(
        only.chosen is None and not only.conflict, f"只有缺生效日的版本时应为 null，实际 {js(only)}"
    )


@t("VER-8", "检索结果混了两代 embedding 就报错")
def _ver8() -> None:
    g1 = SimpleNamespace(gen=GEN)
    g2 = SimpleNamespace(gen=replace(GEN, embedder="bge-m3-v2"))
    need(throws(lambda: shared.assert_single_embedder([g1, g2, g1])), "混代没报错")
    need(not throws(lambda: shared.assert_single_embedder([g1, g1])), "同一代也报错了")


# ─────────────────────────────────────────────────────────────
section("SYNC · 同步与重建")


def snaps(mode: shared.SyncMode) -> list[str]:
    return run_sync(mode, M.apply_sync)


@t("SYNC-1", "none：三轮之后已删的 C 还在")
def _sync1() -> None:
    s = snaps("none")
    need("C:c1" in s[2].split(","), f"实际 {s[2]}")


@t("SYNC-2", "incremental：A 的旧版清掉了，整篇删除的 C 仍残留")
def _sync2() -> None:
    s = snaps("incremental")
    need(s[1] == "A:a2,B:b1,C:c1" and s[2] == "A:a2,B:b1,C:c1", f"实际 {js(s)}")


@t("SYNC-3", "full：loader 第 3 轮漏了 B，B 被误删")
def _sync3() -> None:
    s = snaps("full")
    need(s[1] == "A:a2,B:b1" and s[2] == "A:a2", f"实际 {js(s)}")


@t("SYNC-4", "tombstone：没有 C、保住 B、A 只有新版")
def _sync4() -> None:
    s = snaps("tombstone")
    need(s[1] == "A:a2,B:b1" and s[2] == "A:a2,B:b1", f"实际 {js(s)}")


@t("SYNC-5", "只改了 ACL → 只更新 payload，不重新 embedding")
def _sync5() -> None:
    old = doc_by_id(C, "travel-2025")
    nu = replace(old, acl=["group:all", "group:contractors"])
    p = shared.plan_reindex(old, nu, GEN, GEN)
    need(p.payload_only and not p.reembed and not p.reparse and not p.rechunk, f"实际 {js(p)}")


@t("SYNC-6", "换 parser 要重解析；换 embedder 只重新 embedding；文档删了就整篇删")
def _sync6() -> None:
    d = doc_by_id(C, "travel-2025")
    parser = shared.plan_reindex(d, d, GEN, replace(GEN, parser="mineru-2.5"))
    need(parser.reparse and parser.rechunk and parser.reembed, f"换 parser：{js(parser)}")
    emb = shared.plan_reindex(d, d, GEN, replace(GEN, embedder="bge-m3-v2"))
    need(
        emb.reembed and not emb.reparse and not emb.rechunk and not emb.payload_only,
        f"换 embedder：{js(emb)}",
    )
    chunker = shared.plan_reindex(d, d, GEN, replace(GEN, chunker="kb-v2"))
    need(chunker.rechunk and chunker.reembed and not chunker.reparse, f"换 chunker：{js(chunker)}")
    need(shared.plan_reindex(d, None, GEN, GEN).delete_all, "文档删了没有 deleteAll")
    same = shared.plan_reindex(d, d, GEN, GEN)
    need(
        not same.reparse
        and not same.rechunk
        and not same.reembed
        and not same.payload_only
        and not same.delete_all,
        f"什么都没变：{js(same)}",
    )


# ─────────────────────────────────────────────────────────────
section("CACHE · 缓存键")


@t("CACHE-1", "同一个问题，alice 和 bob 的键不同")
def _cache1() -> None:
    need(
        M.cache_key("差旅住宿上限", U["alice"].principals, "v7")
        != M.cache_key("差旅住宿上限", U["bob"].principals, "v7"),
        "跨用户同键",
    )


@t("CACHE-2", "同样的权限、同样的问题（写法不同）→ 同一个键")
def _cache2() -> None:
    a = M.cache_key("（2025）住宿 上限", ["group:hr", "user:a"], "v7")
    b = M.cache_key(" (2025)住宿 上限 ", ["user:a", "group:hr", "group:hr"], "v7")
    need(a == b, f"{js(a)} vs {js(b)}")


@t("CACHE-3", "撤权或语料版本变了，键就变")
def _cache3() -> None:
    before = M.cache_key("薪酬", ["user:alice@qinghe.com", "group:hr"], "v7")
    need(before != M.cache_key("薪酬", ["user:alice@qinghe.com"], "v7"), "撤掉 group:hr 后键没变")
    need(
        before != M.cache_key("薪酬", ["user:alice@qinghe.com", "group:hr"], "v8"),
        "语料版本变了键没变",
    )


# ─────────────────────────────────────────────────────────────
section("GATE · CITE · 入库门禁与引用定位")


@t("GATE-1", "legacy-notice：缺 acl、缺 effectiveFrom")
def _gate1() -> None:
    g = shared.quality_gate(doc_by_id(C, "legacy-notice"))
    need(not g.pass_ and js(g.issues) == js(["NO_ACL", "NO_EFFECTIVE_FROM"]), f"实际 {js(g)}")


@t("GATE-2", "每份坏文档恰好被一项抓住，好文档一项不中")
def _gate2() -> None:
    want: dict[str, list[str]] = {
        "travel-2025": [],
        "bad-empty-page": ["EMPTY_PAGE"],
        "bad-footnote": ["FOOTNOTE_MISSING"],
        "bad-table": ["TABLE_NO_HEADER"],
        "bad-encoding": ["REPLACEMENT_CHAR"],
    }
    for nd in bad_docs(C):
        if nd.name not in want:
            continue
        got = shared.quality_gate(nd.doc).issues
        need(js(got) == js(want[nd.name]), f"{nd.name}：应为 {js(want[nd.name])}，实际 {js(got)}")
    need(
        shared.quality_gate(doc_by_id(C, "budget-2025")).pass_, "跨页表格的后半段没有表头，不该算错"
    )


@t("CITE-1", "单页：有印刷页码显示「p. ii」，没有显示「第 1 页」")
def _cite1() -> None:
    tr = next(c for c in chunks_of("travel-2023") if "第一条" in c.text)
    bu = chunks_of("budget-2025")[0]
    need(
        shared.cite_locator(tr) == "p. ii" and shared.cite_locator(bu) == "第 1 页",
        f"{shared.cite_locator(tr)} / {shared.cite_locator(bu)}",
    )


@t("CITE-2", "跨页：「pp. 2–3」与「第 3–4 页」")
def _cite2() -> None:
    tr = next(c for c in chunks_of("travel-2023") if "不予受理" in c.text)
    bu = next(c for c in chunks_of("budget-2025") if "方可列支" in c.text)
    need(
        shared.cite_locator(tr) == "pp. 2–3" and shared.cite_locator(bu) == "第 3–4 页",
        f"{shared.cite_locator(tr)} / {shared.cite_locator(bu)}",
    )


print()
if failed == 0:
    print(green(f"  ✓ {passed} 条断言全部通过"))
    print(
        dim(
            "\n  最该记住的六条：\n"
            "    PARSE  页眉靠跨页统计；页码存两套；脚注和跨页内容不能丢\n"
            "    NUM    先 NFKC 再用显式字符类；\\d 在两种语言里不是一回事\n"
            "    TABLE  每一行都带完整列名；多级表头按列拼\n"
            "    ACL    缺 acl 不可见；过滤在 ANN 里、在 rerank 前；权限只来自会话\n"
            "    VER    上位、特别、新，三个维度；有一种冲突要交给人\n"
            "    SYNC   删除靠墓碑；什么变了就只重做哪一段\n"
        )
    )
    raise SystemExit(0)
print(red(f"  ✗ {failed} 失败 / {passed} 通过"))
raise SystemExit(1)
