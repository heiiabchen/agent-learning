"""验证 l16x/genui.py。
  GENUI_IMPL=shared uv run python -m l16x.verify
  uv run python -m l16x.verify

零浏览器、零模型、零网络。所有输入来自 fixtures/genui.json 和 genui.py 里的确定性夹具。
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any

from l16x.genui import HOST_ORIGIN, MESSAGES, PROXY_ORIGIN, RPC, SCENARIOS, deep_chain, fx
from shared import genui as shared
from shared.genui import (
    A2uiCatalog,
    A2uiComponent,
    Approval,
    BridgeCtx,
    ContextUpdate,
    CspDecl,
    CspResult,
    Decision,
    FrameSpec,
    HostEvent,
    Initialized,
    Json,
    MsgEvent,
    Out,
    Outbound,
    OutKind,
    PatchResult,
    PeerCfg,
    Pointer,
    SourceCheck,
    TreeReport,
    ViewRequest,
)

TARGET = "shared" if os.environ.get("GENUI_IMPL") == "shared" else "mine"


@dataclass(frozen=True)
class Api:
    route_app_request: Callable[[ViewRequest, BridgeCtx], Decision]
    accepts_message: Callable[[MsgEvent, PeerCfg], Decision]
    safe_target_origin: Callable[[str], str]
    check_source: Callable[[Any], SourceCheck]
    build_csp: Callable[[CspDecl | None], CspResult]
    decode_pointer: Callable[[str], Pointer]
    json_type_equal: Callable[[Json, Json], bool]
    apply_patch_atomic: Callable[[Json, Any], PatchResult]
    validate_tree: Callable[[list[A2uiComponent], A2uiCatalog], TreeReport]
    schedule_outbound: Callable[[list[HostEvent]], Outbound]


def _load_mine() -> Api:
    from l16x import genui as m

    return Api(
        route_app_request=m.my_route_app_request,
        accepts_message=m.my_accepts_message,
        safe_target_origin=m.my_safe_target_origin,
        check_source=m.my_check_source,
        build_csp=m.my_build_csp,
        decode_pointer=m.my_decode_pointer,
        json_type_equal=m.my_json_type_equal,
        apply_patch_atomic=m.my_apply_patch_atomic,
        validate_tree=m.my_validate_tree,
        schedule_outbound=m.my_schedule_outbound,
    )


M = (
    Api(
        route_app_request=shared.route_app_request,
        accepts_message=shared.accepts_message,
        safe_target_origin=shared.safe_target_origin,
        check_source=shared.check_source,
        build_csp=shared.build_csp,
        decode_pointer=shared.decode_pointer,
        json_type_equal=shared.json_type_equal,
        apply_patch_atomic=shared.apply_patch_atomic,
        validate_tree=shared.validate_tree,
        schedule_outbound=shared.schedule_outbound,
    )
    if TARGET == "shared"
    else _load_mine()
)

print(
    "\n（测的是 shared/ 里的参考实现）" if TARGET == "shared" else "\n（测的是 l16x/ 里你的实现）"
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


J = shared.json_stringify


# ─────────────────────────────────────────────────────────────
section("V · 宿主桥：方法、server、可见性")

F = fx()
CTX = BridgeCtx(app_server="notes", tools=F.tools)


def call(name: Any) -> ViewRequest:
    return {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name}}


def R(msg: ViewRequest) -> Decision:
    return M.route_app_request(msg, CTX)


def reasons(xs: list[ViewRequest]) -> list[str]:
    return [R(x).reason for x in xs]


@t("V1", "白名单外的方法拒；白名单以 ctx.methods 为准")
def _v1() -> None:
    got = reasons(
        [
            {"method": "resources/list"},
            {"method": "prompts/list"},
            {"method": "sampling/createMessage"},
            {"method": "ping"},
        ]
    )
    need(
        J(got)
        == J(
            [
                "method-not-allowed:resources/list",
                "method-not-allowed:prompts/list",
                "method-not-allowed:sampling/createMessage",
                "ok",
            ]
        ),
        J(got),
    )
    r = M.route_app_request({"method": "ping"}, replace(CTX, methods=["tools/call"]))
    need(not r.allow and r.reason == "method-not-allowed:ping", f"ctx.methods 没生效：{J(r)}")


@t("V2", '["model"] 的工具：View 调不了（SDK 的自动转发照转）')
def _v2() -> None:
    r = R(call("delete_project"))
    need(not r.allow and r.reason == "not-app-visible:delete_project", J(r))
    need(shared.sdk_auto_forward(call("delete_project")).allow, "对照组本该转发")


@t("V3", '["app"] 放行；["app","app"] 也是 app-only，照样放行')
def _v3() -> None:
    need(
        R(call("render_board")).allow and R(call("refresh_board")).allow,
        f"{J(R(call('render_board')))} / {J(R(call('refresh_board')))}",
    )
    need(not shared.ext_apps_app_only(["app", "app"]), "对照组：length===1 的判法应该判 false")


@t("V4", "省略 visibility：规范说 app 可调，宿主拒（这个方向 fail-closed）")
def _v4() -> None:
    r = R(call("export_notes"))
    need(not r.allow and r.reason == "not-app-visible:export_notes", f"省略不算显式声明：{J(r)}")
    need(shared.spec_app_visible(None), "规范默认是双方可见")


@t("V5", '字符串 "app"、空数组、["APP"]：都不是显式的 app')
def _v5() -> None:
    got = reasons([call("sync_now"), call("archive"), call("bulk_edit")])
    need(
        J(got)
        == J(["not-app-visible:sync_now", "not-app-visible:archive", "not-app-visible:bulk_edit"]),
        f"{J(got)}——先判是不是数组",
    )
    need(shared.ai_sdk_app_visible("app"), "对照组：字符串的 includes 是子串匹配")


@t("V6", "跨 server：bank 的 app 工具，notes 的 View 调不到；同名工具按自己的 server 找")
def _v6() -> None:
    r = R(call("transfer_funds"))
    need(not r.allow and r.reason == "cross-server:bank", J(r))
    need(R(call("list_notes")).allow, 'notes 自己的 list_notes 是 ["model","app"]')
    bank = BridgeCtx(app_server="bank", tools=F.tools)
    need(M.route_app_request(call("list_notes"), bank).allow, "bank 的 View 调 bank 的 list_notes")
    x = M.route_app_request(call("render_board"), bank)
    need(not x.allow and x.reason == "cross-server:notes", J(x))


@t("V7", "未知工具、name 不是字符串、method 不是字符串、tools/call 没有 params")
def _v7() -> None:
    got = reasons(
        [
            call("nope"),
            call(42),
            {"jsonrpc": "2.0", "id": 1, "method": 7},
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call"},
        ]
    )
    need(J(got) == J(["unknown-tool:nope", "bad-shape", "bad-shape", "bad-shape"]), J(got))


@t("V8", "resources/read 只读 ui://")
def _v8() -> None:
    def rr(uri: Any) -> str:
        return R(
            {"jsonrpc": "2.0", "id": 1, "method": "resources/read", "params": {"uri": uri}}
        ).reason

    got = [
        rr("ui://notes/board"),
        rr("file:///etc/passwd"),
        rr("https://notes.example/x"),
        rr(None),
    ]
    need(
        J(got)
        == J(
            [
                "ok",
                "not-ui-resource:file:///etc/passwd",
                "not-ui-resource:https://notes.example/x",
                "bad-shape",
            ]
        ),
        J(got),
    )


@t("V9", "ui/open-link 只放 https / http / mailto，scheme 不分大小写")
def _v9() -> None:
    def ol(url: str) -> str:
        return R(
            {"jsonrpc": "2.0", "id": 1, "method": "ui/open-link", "params": {"url": url}}
        ).reason

    got = [
        ol(u)
        for u in [
            "https://a.example",
            "HTTPS://a.example",
            "mailto:a@b.example",
            "JavaScript:alert(1)",
            "data:text/html,x",
            "//evil.example",
        ]
    ]
    need(
        J(got)
        == J(["ok", "ok", "ok", "link-scheme:javascript", "link-scheme:data", "link-scheme:"]),
        J(got),
    )


# ─────────────────────────────────────────────────────────────
section("O · 宿主 → View 的时序")


def ev(kind: OutKind, data: str | None = None) -> HostEvent:
    return Out(kind=kind, data=data)


def S(label: str) -> list[HostEvent]:
    return next(evs for lab, evs in SCENARIOS if lab == label)


@t("O1", "initialized 之前一条都不发；之后按顺序放出")
def _o1() -> None:
    evs: list[HostEvent] = [
        ev("tool-input-partial", "p1"),
        ev("tool-input", "x"),
        Initialized(),
        ev("tool-result", "r"),
    ]
    before = M.schedule_outbound(evs[:2])
    need(
        len(before.sent) == 0 and J(before.held) == J(["tool-input-partial(p1)", "tool-input(x)"]),
        f"initialized 之前：{J(before)}",
    )
    all_ = M.schedule_outbound(evs)
    need(
        J(all_.sent) == J(["tool-input-partial(p1)", "tool-input(x)", "tool-result(r)"]),
        J(all_.sent),
    )


@t("O2", "工具结果比 View 先到：压着；tool-input 永远在 tool-result 之前")
def _o2() -> None:
    a = M.schedule_outbound(S("工具结果比 View 先到"))
    need(J(a.sent) == J(["tool-input(q=Q3)", "tool-result(r1)"]), J(a.sent))
    b = M.schedule_outbound([ev("tool-result", "r"), ev("tool-input", "x"), Initialized()])
    need(
        J(b.sent) == J(["tool-input(x)", "tool-result(r)"]), f"结果排在入参前面入队时：{J(b.sent)}"
    )


@t("O3", "tool-input 最多一次")
def _o3() -> None:
    r = M.schedule_outbound(S("同一次调用发了两次 tool-input"))
    need(
        J(r.sent) == J(["tool-input(a)", "tool-result(r)"])
        and J(r.dropped) == J(["tool-input(b):duplicate-tool-input"]),
        J(r),
    )


@t("O4", "审批挂起：入参和 partial 不进 View，host-context-changed 照发；批准后放出")
def _o4() -> None:
    evs = S("需要审批，批准")
    cut = next((i for i, e in enumerate(evs) if isinstance(e, Approval)), -1)
    mid = M.schedule_outbound(evs[:cut])
    need(
        J(mid.sent) == J(["host-context-changed(theme)"])
        and J(mid.held) == J(["tool-input-partial(p1)", "tool-input(x)"]),
        f"批准前：{J(mid)}",
    )
    all_ = M.schedule_outbound(evs)
    need(
        J(all_.sent)
        == J(
            [
                "host-context-changed(theme)",
                "tool-input-partial(p1)",
                "tool-input(x)",
                "tool-result(r)",
            ]
        ),
        J(all_.sent),
    )


@t("O5", "审批被拒：入参丢弃，tool-cancelled 照发")
def _o5() -> None:
    r = M.schedule_outbound(S("需要审批，拒绝"))
    need(
        J(r.sent) == J(["tool-cancelled(denied)"])
        and J(r.dropped) == J(["tool-input(x):approval-denied"]),
        J(r),
    )


@t("O6", "tool-input 之后的 partial 丢弃；从没有 tool-input 的结果一直压着")
def _o6() -> None:
    r = M.schedule_outbound(S("partial 流式到一半 View 才就绪"))
    need(
        J(r.dropped) == J(["tool-input-partial(p3):partial-after-input"]) and len(r.sent) == 4,
        J(r),
    )
    h = M.schedule_outbound([Initialized(), ev("tool-result", "r"), ev("host-context-changed")])
    need(J(h.sent) == J(["host-context-changed"]) and J(h.held) == J(["tool-result(r)"]), J(h))


# ─────────────────────────────────────────────────────────────
section("M · postMessage 的收与发")


def msg(i: int) -> Decision:
    return M.accepts_message(MESSAGES[i][1], MESSAGES[i][2])


@t("M1", "窗口不对就拒，哪怕 origin 对")
def _m1() -> None:
    need(msg(0).allow, f"正常消息被拒了：{J(msg(0))}")
    need(not msg(1).allow and msg(1).reason == "wrong-source", J(msg(1)))


@t("M2", '白名单里有 "null"：配置错误，一律拒')
def _m2() -> None:
    need(msg(4).reason == "config:null-origin-allowlisted", J(msg(4)))
    e = MsgEvent(source="view-1", origin="null", data=RPC)
    got = [
        M.accepts_message(e, PeerCfg(expected_source="view-1", allowed_origins=[])).reason,
        M.accepts_message(
            e, PeerCfg(expected_source="view-1", allowed_origins=["*", PROXY_ORIGIN])
        ).reason,
        M.accepts_message(
            e, PeerCfg(expected_source="view-1", allowed_origins=["null", "*"])
        ).reason,
    ]
    need(
        J(got)
        == J(["config:empty-allowlist", "config:wildcard-mixed", "config:null-origin-allowlisted"]),
        J(got),
    )


@t("M3", 'origin 不在白名单拒；["*"] 跳过 origin，但 source 照查')
def _m3() -> None:
    need(msg(2).reason == "wrong-origin:https://evil.example", J(msg(2)))
    need(msg(5).allow and msg(6).reason == "wrong-source", f"{J(msg(5))} / {J(msg(6))}")


@t("M4", '形状：jsonrpc 必须是字符串 "2.0"，要有 method 或 id')
def _m4() -> None:
    cfg = PeerCfg(expected_source="v", allowed_origins=["*"])

    def r(data: Any) -> str:
        return M.accepts_message(MsgEvent(source="v", origin="null", data=data), cfg).reason

    got = [
        r({"method": "x"}),
        r({"jsonrpc": 2, "method": "x"}),
        r([RPC]),
        r(None),
        r({"jsonrpc": "2.0"}),
        r({"jsonrpc": "2.0", "id": 3, "result": {}}),
    ]
    need(
        J(got) == J(["bad-shape", "bad-shape", "bad-shape", "bad-shape", "bad-shape", "ok"]), J(got)
    )


@t("M5", 'targetOrigin：不透明源只能 "*"，真实源原样')
def _m5() -> None:
    need(
        M.safe_target_origin("null") == "*" and M.safe_target_origin(PROXY_ORIGIN) == PROXY_ORIGIN,
        f"{M.safe_target_origin('null')} / {M.safe_target_origin(PROXY_ORIGIN)}",
    )
    need(shared.target_origin_error("null") != "", '写 "null" 浏览器会抛 SyntaxError')


# ─────────────────────────────────────────────────────────────
section("C · CSP、allow、sandbox")


def conn(csp: str) -> str | None:
    return shared.csp_directive(csp, "connect-src")


@t("C1", "合法声明：规范化（小写、去路径）、去重、保序")
def _c1() -> None:
    r = M.build_csp(
        {
            "connectDomains": [
                "https://API.Example.com/v1/",
                "https://api.example.com",
                "wss://live.example.com",
            ]
        }
    )
    c = conn(r.csp)
    need(
        c == "https://api.example.com wss://live.example.com" and len(r.rejected) == 0,
        f"{'null' if c is None else c} / {J(r.rejected)}",
    )


@t("C2", "分隔符注入：; 引号 空白 tab 逗号 反引号，全拒，也不进策略")
def _c2() -> None:
    bad = [
        "https://a.example.com; script-src *",
        "https://a.example.com\thttps://evil.example",
        "'unsafe-eval'",
        "https://a.example.com,https://evil.example",
        "https://a.example.com`",
        "https://a.example.com https://evil.example",
    ]
    got = [M.check_source(b).reason for b in bad]
    need(all(g == "separator" for g in got), J(got))
    r = M.build_csp({"connectDomains": bad})
    need(
        conn(r.csp) == "'none'"
        and "evil.example" not in r.csp
        and "unsafe-eval" not in r.csp
        and len(r.rejected) == len(bad),
        f"{r.csp} / {len(r.rejected)}",
    )


@t("C3", "先解码再查：%3B、%27、%20、%2A 都现原形")
def _c3() -> None:
    got = [
        M.check_source(x).reason
        for x in [
            "https://a.example.com%3Bscript-src",
            "%27unsafe-eval%27",
            "https://a.example.com%20https://evil.example",
            "https://%2A",
        ]
    ]
    need(
        J(got) == J(["separator", "separator", "separator", "wildcard-host"]),
        f"{J(got)}——查分隔符之前要先 percentDecode",
    )


@t("C4", "scheme、主机通配、userinfo、空主机、非字符串")
def _c4() -> None:
    got = [
        M.check_source(x).reason
        for x in [
            "https://*",
            "https://a.*.example.com",
            "http://insecure.example.com",
            "data:",
            "https://",
            "https://u:p@x.example",
            42,
        ]
    ]
    need(
        J(got)
        == J(
            [
                "wildcard-host",
                "wildcard-host",
                "scheme:http",
                "no-scheme",
                "empty-host",
                "userinfo",
                "not-a-string",
            ]
        ),
        J(got),
    )
    ok = M.check_source("https://*.example.com")
    need(ok.ok and ok.value == "https://*.example.com", f"子域通配应该放行：{J(ok)}")


@t("C5", "不声明 csp：和声明 {} 一样是限制性策略，不是空的")
def _c5() -> None:
    expected = (
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; "
        "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    )
    a = M.build_csp(None)
    b = M.build_csp({})
    c = M.build_csp(None)
    need(a.csp == expected and b.csp == expected and c.csp == expected, f"不声明：{J(a.csp)}")


@t("C6", "form-action / base-uri 显式写；声明的域进对应指令；字段不是数组整个拒")
def _c6() -> None:
    r = M.build_csp(
        {
            "resourceDomains": ["https://cdn.example.com"],
            "baseUriDomains": ["https://cdn.example.com"],
            "connectDomains": "https://api.example.com",
            "frameDomains": ["http://x.example"],
        }
    )

    def d(n: str) -> str | None:
        return shared.csp_directive(r.csp, n)

    need(
        d("form-action") == "'none'" and d("object-src") == "'none'",
        "没有显式的 form-action / object-src",
    )
    need(
        d("base-uri") == "https://cdn.example.com"
        and d("img-src") == "'self' data: https://cdn.example.com"
        and d("script-src") == "'self' 'unsafe-inline' https://cdn.example.com",
        r.csp,
    )
    need(d("connect-src") == "'none'" and d("frame-src") == "'none'", r.csp)
    need(
        J(r.rejected)
        == J(["connectDomains:not-an-array", 'frameDomains:"http://x.example":scheme:http']),
        J(r.rejected),
    )


@t("C7", "allow：分号连接，宿主白名单 deny-by-default（参考实现）")
def _c7() -> None:
    req: dict[str, Any] = {"camera": {}, "microphone": {}}
    view = "https://view.example"
    need(
        len(shared.delegated_features(shared.spec_example_allow(req), view)) == 0,
        "空格连接应该一个都没委派",
    )
    b = shared.build_allow_attr(req, ["camera", "microphone"])
    need(
        b == "camera; microphone"
        and J(shared.delegated_features(b, view)) == J(["camera", "microphone"]),
        b,
    )
    need(
        shared.build_allow_attr(req) == ""
        and shared.build_allow_attr(req, ["microphone"]) == "microphone",
        "宿主白名单没生效",
    )


@t("C8", "allow-scripts + allow-same-origin：同源时等于没沙箱，独立源时没事（参考实现）")
def _c8() -> None:
    same = shared.audit_sandbox(
        FrameSpec(kind="srcdoc", sandbox="allow-scripts allow-same-origin"), HOST_ORIGIN
    )
    cross = shared.audit_sandbox(
        FrameSpec(kind="src", src=f"{PROXY_ORIGIN}/p", sandbox="allow-scripts allow-same-origin"),
        HOST_ORIGIN,
    )
    need("escape:same-origin+scripts" in same and len(cross) == 0, f"{J(same)} / {J(cross)}")
    need(
        shared.frame_origin(FrameSpec(kind="srcdoc"), HOST_ORIGIN) == HOST_ORIGIN
        and shared.frame_origin(FrameSpec(kind="srcdoc", sandbox="allow-scripts"), HOST_ORIGIN)
        == "null",
        'srcdoc 继承创建者的 origin；不含 allow-same-origin 的 sandbox 才是 "null"',
    )


@t("C9", "加载后改 sandbox 只在下一次导航生效；token 大小写不敏感，拼错的报出来（参考实现）")
def _c9() -> None:
    need(
        shared.effective_sandbox("a", "b", "document.write") == "a"
        and shared.effective_sandbox("a", "b", "navigate") == "b",
        "document.write 不是导航",
    )
    r = shared.audit_sandbox(
        FrameSpec(
            kind="src", src=f"{PROXY_ORIGIN}/v", sandbox="allow-scripts ALLOW-FORMS allow-popup"
        ),
        HOST_ORIGIN,
    )
    need(J(r) == J(["unknown-token:allow-popup"]), J(r))


# ─────────────────────────────────────────────────────────────
section("P · 原子 JSON Patch")


def DOC() -> Json:
    return fx().patch_doc


def AP(ops: Any) -> PatchResult:
    return M.apply_patch_atomic(DOC(), ops)


def reason_of(ops: Any) -> str:
    return AP(ops).reason


@t("P1", "第二个 op 失败：整份失败，原文档一个字节没动")
def _p1() -> None:
    doc = DOC()
    before = J(doc)
    r = M.apply_patch_atomic(doc, F.patch_cases[0].ops)
    need(not r.ok and r.reason == "#1 path-not-found", J(r.reason))
    need(J(r.doc) == before and J(doc) == before, f"title 被改了：{J(r.doc)} / {J(doc)}")


@t("P2", "test：true 不等于 1，0 不等于 false")
def _p2() -> None:
    e = M.json_type_equal
    need(not e(True, 1) and not e(1, True) and not e(0, False), "用了语言自带的 ==？")
    need(reason_of(F.patch_cases[1].ops) == "#0 test-failed", reason_of(F.patch_cases[1].ops))


@t("P3", "test：1 等于 1.0；对象与键顺序无关；数组与顺序有关")
def _p3() -> None:
    e = M.json_type_equal
    need(
        e(1, 1.0) and e({"x": 1, "y": 2}, {"y": 2, "x": 1}) and not e([1, 2], [2, 1]),
        "对象 / 数组的比较不对",
    )
    need(
        not e(None, False)
        and not e("1", 1)
        and not e({"0": 1}, [1])
        and not e({"a": 1}, {"a": 1, "b": 2})
        and not e({"a": 1, "b": 2}, {"a": 1}),
        "类型或键集合没比",
    )
    need(AP(F.patch_cases[3].ops).ok, "换了键顺序的对象应该通过 test")


@t("P4", '数组下标按 RFC 6901：01、1e0、" 1"、-1 都不是；- 是追加；add 到 len 可以、replace 不行')
def _p4() -> None:
    def rp(p: str) -> str:
        return reason_of([{"op": "replace", "path": p, "value": 9}])

    got = [rp("/arr/01"), rp("/arr/1e0"), rp("/arr/ 1"), rp("/arr/-1"), rp("/arr/3")]
    need(
        J(got)
        == J(
            [
                "#0 bad-index:01",
                "#0 bad-index:1e0",
                "#0 bad-index: 1",
                "#0 bad-index:-1",
                "#0 path-not-found",
            ]
        ),
        J(got),
    )
    a = AP(
        [{"op": "add", "path": "/arr/-", "value": 4}, {"op": "add", "path": "/arr/0", "value": 0}]
    )
    need(a.ok and J(a.doc["arr"]) == "[0,1,2,3,4]", J(a.doc))
    need(
        reason_of([{"op": "add", "path": "/arr/7", "value": 9}]) == "#0 index-out-of-range",
        "越界的 add 静默追加了？",
    )


@t("P5", "指针解码：先 ~1 再 ~0；~ 后面只能是 0 或 1")
def _p5() -> None:
    d = M.decode_pointer
    need(
        J(d("/meta/~01").tokens) == J(["meta", "~1"]) and J(d("/a~1b").tokens) == J(["a/b"]),
        f"{J(d('/meta/~01'))} / {J(d('/a~1b'))}",
    )
    got = [d("/x~2").reason, d("/x~").reason, d("meta").reason]
    need(J(got) == J(["bad-escape", "bad-escape", "bad-pointer"]), J(got))
    need(d("").ok and len(d("").tokens) == 0 and J(d("/").tokens) == J([""]), '"" 是根，"/" 是空键')
    r = AP([{"op": "add", "path": "/meta/~01", "value": 9}])
    need(r.ok and J(r.doc["meta"]) == '{"a/b":1,"~1":9}', J(r.doc))


@t("P6", "__proto__ / constructor / prototype 段一律拒")
def _p6() -> None:
    got = [
        M.decode_pointer(p).reason
        for p in ["/__proto__/isAdmin", "/tags/constructor/prototype", "/a/prototype"]
    ]
    need(
        J(got)
        == J(
            [
                "forbidden-segment:__proto__",
                "forbidden-segment:constructor",
                "forbidden-segment:prototype",
            ]
        ),
        J(got),
    )
    need(
        reason_of(F.patch_cases[9].ops) == "#0 forbidden-segment:__proto__",
        reason_of(F.patch_cases[9].ops),
    )
    # TS 这里查 Object.prototype.isAdmin。Python 没有原型链，对应的检查是：类上没被写属性，结果文档里也没多出这个键。
    need(
        not hasattr(object, "isAdmin") and "isAdmin" not in J(AP(F.patch_cases[9].ops).doc),
        "Object.prototype 被写了",
    )


@t("P7", "move / copy：不能 move 进自己的子节点；同路径是空操作；copy 是深拷贝")
def _p7() -> None:
    need(reason_of(F.patch_cases[10].ops) == "#0 move-into-child", reason_of(F.patch_cases[10].ops))
    same = AP([{"op": "move", "from": "/meta", "path": "/meta"}])
    need(same.ok and J(same.doc) == J(DOC()), J(same))
    mv = AP([{"op": "move", "from": "/title", "path": "/name"}])
    need(
        mv.ok
        and J(mv.doc)
        == '{"arr":[1,2,3],"meta":{"a/b":1,"~1":2},"flag":true,"n":1,"tags":{"x":1,"y":2},"name":"Board"}',
        J(mv.doc),
    )
    cp = AP(
        [
            {"op": "copy", "from": "/tags", "path": "/tags2"},
            {"op": "replace", "path": "/tags2/x", "value": 9},
        ]
    )
    need(cp.ok and J(cp.doc["tags"]) == '{"x":1,"y":2}', f"copy 共享了引用：{J(cp.doc)}")


@t("P8", "结构错误：路径不存在、根不能 remove、未知 op、缺 value / from、op 不是对象")
def _p8() -> None:
    got = [
        reason_of([{"op": "remove", "path": "/missing"}]),
        reason_of([{"op": "add", "path": "/nope/x", "value": 1}]),
        reason_of([{"op": "remove", "path": ""}]),
        reason_of([{"op": "merge", "path": "/title", "value": 1}]),
        reason_of([{"op": "add", "path": "/x"}]),
        reason_of([{"op": "move", "path": "/x"}]),
        reason_of(["add"]),
        reason_of({"op": "add"}),
        reason_of([{"op": "copy", "from": "/missing", "path": "/x"}]),
    ]
    need(
        J(got)
        == J(
            [
                "#0 path-not-found",
                "#0 path-not-found",
                "#0 cannot-remove-root",
                "#0 unknown-op:merge",
                "#0 missing-value",
                "#0 missing-from",
                "#0 bad-op",
                "not-an-array",
                "#0 from:path-not-found",
            ]
        ),
        J(got),
    )


@t("P9", '空 patch 是 no-op；"" 替换整个文档；null 是值，不是删除')
def _p9() -> None:
    e = AP([])
    need(e.ok and J(e.doc) == J(DOC()), J(e))
    root = AP(
        [
            {"op": "replace", "path": "", "value": {"a": 1}},
            {"op": "test", "path": "", "value": {"a": 1}},
        ]
    )
    need(root.ok and J(root.doc) == '{"a":1}', J(root))
    n = AP([{"op": "replace", "path": "/title", "value": None}])
    need(n.ok and J(n.doc).startswith('{"title":null,'), J(n.doc))


# ─────────────────────────────────────────────────────────────
section("T · A2UI 组件树")


def V(name: str) -> TreeReport:
    return M.validate_tree(F.trees[name], F.catalog)


def errs(r: TreeReport) -> list[str]:
    return [f"{e.code} {e.id} {e.detail}" for e in r.errors]


@t("T1", "正常的树：按目录走完，渲染顺序是深度优先")
def _t1() -> None:
    r = V("ok")
    need(
        r.ok
        and r.has_root
        and J(r.rendered) == J(["root", "title", "card", "img", "go", "go-label"])
        and len(r.errors) == 0
        and len(r.placeholders) == 0,
        J(r),
    )


@t("T2", "还没有 root：只缓冲，不渲染，也不算错误")
def _t2() -> None:
    r = V("streaming")
    need(not r.has_root and not r.ok and len(r.rendered) == 0 and len(r.errors) == 0, J(r))


@t("T3", "引用了还没到的组件：占位，不是错误")
def _t3() -> None:
    r = V("missing")
    need(r.ok and J(r.placeholders) == J(["later"]) and J(r.rendered) == J(["root", "title"]), J(r))


@t("T4", "环：检出来，不栈溢出")
def _t4() -> None:
    r = V("cycle")
    need(
        J(errs(r)) == J(["CYCLE a root>a>b>a"]) and J(r.rendered) == J(["root", "a", "b"]),
        J(errs(r)),
    )
    self_ = M.validate_tree([{"id": "root", "component": "Card", "child": "root"}], F.catalog)
    need(J(errs(self_)) == J(["CYCLE root root>root"]), J(errs(self_)))


@t("T5", "一个子节点两个父：第二个父那里报错，子节点只渲染一次")
def _t5() -> None:
    r = V("multiParent")
    need(
        J(errs(r)) == J(["MULTI_PARENT shared shared: a + b"])
        and J(r.rendered) == J(["root", "a", "shared", "b"]),
        f"{J(errs(r))} / {J(r.rendered)}",
    )


@t("T6", "目录：未知组件、未知属性、重复 id、未注册的函数、allowedParents；深度上限")
def _t6() -> None:
    r = V("catalogViolations")
    want = [
        "UNKNOWN_PROP root style",
        "UNKNOWN_COMPONENT x Marquee",
        "DUPLICATE_ID dup Text",
        "UNKNOWN_FUNCTION btn action:evalJs",
        "UNALLOWED_PARENT tab Tab under Column",
    ]
    need(J(errs(r)) == J(want), J(errs(r)))
    need(
        J(r.rendered) == J(["root", "dup", "btn", "btn-label"]),
        f"目录外的组件不该渲染：{J(r.rendered)}",
    )
    need(V("tabsOk").ok, "Tab 在 Tabs 下应该通过")
    kid = M.validate_tree(
        [
            {"id": "root", "component": "Tabs", "children": ["t"]},
            {"id": "t", "component": "Text", "text": "x"},
        ],
        F.catalog,
    )
    need(
        J(errs(kid)) == J(["UNALLOWED_PARENT t Text under Tabs"]),
        f"allowedChildren 没查：{J(errs(kid))}",
    )
    proto = M.validate_tree(
        [
            {
                "id": "root",
                "component": "Text",
                "text": {"call": "hasOwnProperty"},
                "constructor": 1,
            },
            {"id": "x", "component": "toString"},
        ],
        F.catalog,
    )
    need(
        J(errs(proto))
        == J(
            [
                "UNKNOWN_FUNCTION root text:hasOwnProperty",
                "UNKNOWN_PROP root constructor",
                "UNKNOWN_COMPONENT x toString",
            ]
        ),
        f"原型链上的名字被当成了已注册：{J(errs(proto))}",
    )
    deep = M.validate_tree(deep_chain(20), F.catalog)
    need(
        M.validate_tree(deep_chain(15), F.catalog).ok and J(errs(deep)) == J(["TOO_DEEP c17 17"]),
        J(errs(deep)),
    )


@t("T7", "URL 型属性：formatString、绑定都不行；字面量要 https 且主机在白名单")
def _t7() -> None:
    need(
        J(errs(V("exfil")))
        == J(
            [
                'URL_NOT_LITERAL px url={"call":"formatString","returnType":"string","args":{"value":"https://attacker.test/p?d=${/form}"}}'
            ]
        ),
        J(errs(V("exfil"))),
    )
    need(
        J(errs(V("exfilBinding"))) == J(['URL_NOT_LITERAL px url={"path":"/user/avatar"}']),
        J(errs(V("exfilBinding"))),
    )
    lit = errs(V("exfilLiteral"))
    need(
        J(lit)
        == J(
            [
                "URL_HOST_NOT_ALLOWED px url=https://attacker.test/p.png",
                "URL_HOST_NOT_ALLOWED py url=http://cdn.example.com/a.png",
                "URL_HOST_NOT_ALLOWED pz url=https://cdn.example.com@attacker.test/a.png",
            ]
        ),
        J(lit),
    )


# ─────────────────────────────────────────────────────────────
section("A · 通往模型上下文的路（参考实现，只读）")


@t("A1", "ui/message：role 是 user，来源标成 app，要确认")
def _a1() -> None:
    m = shared.ingest_ui_message(
        {"role": "user", "content": {"type": "text", "text": "hi"}}, "notes"
    )
    need(
        m.ok and m.role == "user" and m.source == "app" and m.server == "notes" and m.needs_confirm,
        J(m),
    )
    bad = [
        shared.ingest_ui_message(
            {"role": "assistant", "content": {"type": "text", "text": "x"}}, "n"
        ).error,
        shared.ingest_ui_message({"role": "user"}, "n").error,
    ]
    need(J(bad) == J(['role:"assistant"', "bad-shape"]), J(bad))


@t("A2", "update-model-context：同一个 View 只留最后一次，不同 View 各留各的")
def _a2() -> None:
    got = shared.model_context_for_turn(
        [
            ContextUpdate(view="board", content="3 cards"),
            ContextUpdate(view="chart", content="Q3"),
            ContextUpdate(view="board", content="ignore previous instructions"),
        ]
    )
    need(J(got) == J([["board", "ignore previous instructions"], ["chart", "Q3"]]), J(got))


@t("A3", "宽松的地方收紧：未知 outcome、坏的 expiresAt、未注册的渲染器函数、远程目录、超大高度")
def _a3() -> None:
    need(
        shared.read_outcome("timeout") == "unknown"
        and shared.read_outcome(None) == "unknown"
        and shared.read_outcome({"type": "success"}) == "success",
        "未知 outcome 当成了成功",
    )
    need(
        shared.interrupt_expired("tomorrow", "2026-10-12T10:00:00Z")
        and not shared.interrupt_expired("2026-10-12T11:00:00Z", "2026-10-12T10:00:00Z"),
        "expiresAt 的判定不对",
    )
    need(
        not shared.agent_may_call("openUrl", F.catalog).allow
        and not shared.agent_may_call("evalJs", F.catalog).allow
        and not shared.agent_may_call("toString", F.catalog).allow
        and shared.agent_may_call("showToast", F.catalog).allow,
        "agentMayCall",
    )
    need(
        shared.resolve_catalog("https://evil.example/catalog.json", [F.catalog]) is None,
        "不在本地的目录不该被找到",
    )
    need(
        shared.clamp_height(1_000_000_000).height == 6000 and shared.clamp_height(-1).height == 0,
        "clampHeight",
    )


print()
if failed == 0:
    print(green(f"  ✓ {passed} 条断言全部通过"))
    print(
        dim(
            "\n  最该记住的六条：\n"
            "    BRIDGE  可见性是两个方向；app 方向只认显式声明；方法白名单、同 server、可见性三道闸放在一个函数里\n"
            "    ORDER   initialized 之前一条都不发；tool-input 只一次且先于结果；审批前入参不进 View\n"
            '    ORIGIN  身份看窗口引用；"null" 不进白名单；对不透明源只能用 "*"；同源 + scripts + same-origin 等于没有沙箱\n'
            "    CSP     先解码再查分隔符；不声明也给限制性策略；form-action、base-uri 显式写 'none'；allow 用分号\n"
            "    PATCH   对副本应用、整份回滚；test 先比类型；下标按 ABNF；先 ~1 后 ~0；挡掉 __proto__\n"
            "    TREE    邻接表会成环、会多父；目录是本地的；URL 属性只收字面量——不执行代码不等于不外泄\n"
        )
    )
    raise SystemExit(0)
print(red(f"  ✗ {failed} 失败 / {passed} 通过"))
raise SystemExit(1)
