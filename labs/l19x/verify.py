"""验证 l19x/ecosystem.py。
  ECO19_IMPL=shared uv run python -m l19x.verify
  uv run python -m l19x.verify

零框架、零模型、零网络。框架行为来自 fixtures/ecosystem.json（锁定版本上的实测录制）。
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass, fields, is_dataclass
from typing import Any, Literal

from l19x.ecosystem import SCENARIOS, failing_steps, first_stop, fx
from shared import tsecosystem as shared
from shared.tsecosystem import (
    DifyPlan,
    Kv,
    LoggedResult,
    McpResult,
    McpText,
    Rebuilt,
    ResumeOutcome,
    Step,
    StopOpts,
    StopReason,
    ToolCall,
    ToolCtx,
    UiToolPart,
)

TARGET = "shared" if os.environ.get("ECO19_IMPL") == "shared" else "mine"


@dataclass(frozen=True)
class Api:
    course_stop_reason: Callable[[list[Step], StopOpts], StopReason]
    redact_secrets: Callable[[str], str]
    course_tool_error: Callable[[Any, ToolCtx], str]
    resume_once: Callable[[Kv, str, Literal["approve", "reject"], Callable[[], str]], ResumeOutcome]
    mcp_result_to_text: Callable[[McpResult], McpText]
    rebuild_history: Callable[[list[UiToolPart], list[LoggedResult]], Rebuilt]
    dify_plan: Callable[[Any], DifyPlan]


def _load_mine() -> Api:
    from l19x import ecosystem as m

    return Api(
        course_stop_reason=m.my_course_stop_reason,
        redact_secrets=m.my_redact_secrets,
        course_tool_error=m.my_course_tool_error,
        resume_once=m.my_resume_once,
        mcp_result_to_text=m.my_mcp_result_to_text,
        rebuild_history=m.my_rebuild_history,
        dify_plan=m.my_dify_plan,
    )


M = (
    Api(
        course_stop_reason=shared.course_stop_reason,
        redact_secrets=shared.redact_secrets,
        course_tool_error=shared.course_tool_error,
        resume_once=shared.resume_once,
        mcp_result_to_text=shared.mcp_result_to_text,
        rebuild_history=shared.rebuild_history,
        dify_plan=shared.dify_plan,
    )
    if TARGET == "shared"
    else _load_mine()
)

print(
    "\n（测的是 shared/ 里的参考实现）" if TARGET == "shared" else "\n（测的是 l19x/ 里你的实现）"
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


def _camel(k: str) -> str:
    head, *rest = k.split("_")
    return head + "".join(w[:1].upper() + w[1:] for w in rest)


def _default(o: Any) -> Any:
    if is_dataclass(o) and not isinstance(o, type):
        return {_camel(f.name): getattr(o, f.name) for f in fields(o)}
    raise TypeError(f"不是 JSON 值：{type(o).__name__}")


def J(x: Any) -> str:
    """JSON.stringify 的同义写法。dataclass 按字段展开，字段名换回 TS 的驼峰，失败信息和 TS 一字不差。"""
    return json.dumps(x, ensure_ascii=False, separators=(",", ":"), default=_default)


def nth(xs: list[str], i: int) -> str | None:
    """TS 的 xs[i]：越界读到 undefined（JSON 里是 null），不抛。"""
    return xs[i] if 0 <= i < len(xs) else None


F = fx()


def call(name: str, args: Any) -> ToolCall:
    return ToolCall(name=name, args=args)


def step(
    calls: list[ToolCall], finish_reason: str = "tool-calls", approval_requested: bool | None = None
) -> Step:
    return Step(
        tool_calls=calls, finish_reason=finish_reason, approval_requested=approval_requested
    )


def R(s: list[Step], max_steps: int = 10, max_repeat: int = 3) -> StopReason:
    return M.course_stop_reason(s, StopOpts(max_steps=max_steps, max_repeat=max_repeat))


# ─────────────────────────────────────────────────────────────
section("S · 停止原因（TODO 1）")


@t("S1", "没有步 → running；最后一步没有工具调用 → done")
def _s1() -> None:
    need(R([]) == "running", f"空历史：{R([])}")
    done = [step([], "stop")]
    need(R(done) == "done", f"没有工具调用：{R(done)}")
    one = [step([call("ls", {})])]
    need(R(one) == "running", f"一步、有工具调用、没到上限：{R(one)}")


@t("S2", "优先级：approval > truncated > error > done")
def _s2() -> None:
    got = [
        R([step([], "length", True)]),
        R([step([], "length")]),
        R([step([], "error")]),
        R([step([call("ls", {})], "error")]),
        R([step([call("ls", {})], "tool-calls", False)]),
    ]
    need(J(got) == J(["approval", "truncated", "error", "error", "running"]), J(got))


@t("S3", "repeat：最近 maxRepeat 步签名全相同；参数键序不同也是同一个调用")
def _s3() -> None:
    ab = call("read_file", {"a": 1, "b": 2})
    ba = call("read_file", {"b": 2, "a": 1})
    ac = call("read_file", {"a": 1, "c": 2})
    got = [
        R([step([ab]), step([ba]), step([ab])]),
        R([step([ab]), step([ba])]),
        R([step([ab]), step([ac]), step([ab])]),
    ]
    need(J(got) == J(["repeat", "running", "running"]), J(got))


@t("S4", "只看最近 N 步；一步里调用的顺序算数；maxRepeat < 2 不查")
def _s4() -> None:
    x = call("ls", {"p": "."})
    y = call("ls", {"p": "src"})
    got = [
        R([step([x]), step([x]), step([x]), step([y])]),
        R([step([y]), step([x]), step([x]), step([x])]),
        R([step([x, y]), step([x, y])], 10, 2),
        R([step([x, y]), step([y, x])], 10, 2),
        R([step([x])], 10, 1),
        R([step([x]), step([x])], 10, 0),
    ]
    need(J(got) == J(["running", "repeat", "repeat", "running", "running", "running"]), J(got))


@t("S5", "max_steps 用 ≥：maxSteps 0 也停；repeat 先于 max_steps")
def _s5() -> None:
    got = [
        R(failing_steps(1), 0, 0),
        R(failing_steps(1, True), 1),
        R(failing_steps(3, True), 5),
        R(failing_steps(6, True), 5),
        R(failing_steps(3), 3, 3),
    ]
    need(J(got) == J(["max_steps", "max_steps", "running", "max_steps", "repeat"]), J(got))


@t("S6", "同一段 20 步历史：第 3 步 repeat；每步换参数：第 8 步 max_steps")
def _s6() -> None:
    same = first_stop(failing_steps(20), lambda s: R(s, 8, 3))
    vary = first_stop(failing_steps(20, True), lambda s: R(s, 8, 3))
    need(J(same) == J([3, "repeat"]) and J(vary) == J([8, "max_steps"]), f"{J(same)} {J(vary)}")


# ─────────────────────────────────────────────────────────────
section("E · 错误出口（TODO 2）")

HINT = shared.hint_for


@t("E1", "redactSecrets：三种 key 各自替换")
def _e1() -> None:
    got = [
        M.redact_secrets(s)
        for s in [
            "key sk-abc_DEF-123 end",
            "token=abc123 rejected",
            "Authorization: Bearer eyJ.a-b_c~d+e/f=",
            "password=hunter2,next",
            "api_key=XYZ",
            "a sk-1 b sk-2 secret=x token=y Bearer p Bearer q",
        ]
    ]
    need(
        J(got)
        == J(
            [
                "key sk-*** end",
                "token=*** rejected",
                "Authorization: Bearer ***",
                "password=***,next",
                "api_key=***",
                "a sk-*** b sk-*** secret=*** token=*** Bearer *** Bearer ***",
            ]
        ),
        J(got),
    )


@t("E2", "sk- 前面紧挨字母数字的不算；键名只认小写；值在分隔符前截止")
def _e2() -> None:
    got = [
        M.redact_secrets(s)
        for s in [
            "task-queue sk-1",
            "Token=abc",
            "(secret=sk-123)",
            "token=abc;next",
            "secret=a}b",
            "xsk-abc sk-",
        ]
    ]
    need(
        J(got)
        == J(
            [
                "task-queue sk-***",
                "Token=abc",
                "(secret=***)",
                "token=***;next",
                "secret=***}b",
                "xsk-abc sk-",
            ]
        ),
        J(got),
    )


@t("E3", "幂等：脱敏结果再跑一遍不变")
def _e3() -> None:
    xs = ["sk-a", "Bearer abc.def", "secret=x token=y", "(secret=sk-123)", "api_key=sk-zz,Bearer q"]
    once = [M.redact_secrets(x) for x in xs]
    twice = [M.redact_secrets(x) for x in once]
    need(J(once) != J(xs), "一个都没有替换")
    need(J(twice) == J(once), f"{J(once)} → {J(twice)}")


@t("E4", "格式：[tool error] 工具名: 消息，换行，下一步：提示")
def _e4() -> None:
    e = F.tool_error
    got = M.course_tool_error(
        {"name": e["name"], "message": e["message"], "code": e.get("code")}, {"tool": e["tool"]}
    )
    want = f"[tool error] read_file: ENOENT nope (secret=***)\n下一步：{HINT('ENOENT')}"
    need(got == want, J(got))
    a = shared.audit_backfill(got, e["tool"])
    need(len(a) == 0, f"体检没过：{J(a)}")


@t("E5", "错误码：e.code 优先，否则看 message 开头的 E+大写；查不到用默认提示")
def _e5() -> None:
    got = [
        nth(s.split("\n"), 1)
        for s in [
            M.course_tool_error({"message": "EACCES: permission denied"}, {"tool": "fs"}),
            M.course_tool_error({"message": "ENOENT x", "code": "ETIMEDOUT"}, {"tool": "fs"}),
            M.course_tool_error({"message": "Error: boom"}, {"tool": "fs"}),
            M.course_tool_error({"message": "E"}, {"tool": "fs"}),
            M.course_tool_error({"message": "bad", "code": "INVALID_ARGS"}, {"tool": "fs"}),
            M.course_tool_error({"message": "EPERM no", "code": ""}, {"tool": "fs"}),
        ]
    ]
    want = [f"下一步：{HINT(c)}" for c in ["EACCES", "ETIMEDOUT", "", "", "INVALID_ARGS", "EPERM"]]
    need(J(got) == J(want), J(got))


@t("E6", "不是带 message 的对象也要能回填；空工具名 → unknown-tool")
def _e6() -> None:
    D = f"下一步：{shared.DEFAULT_HINT}"
    got = [
        M.course_tool_error("disk full", {"tool": "w"}),
        M.course_tool_error(None, {"tool": ""}),
        M.course_tool_error({"message": 42}, {"tool": "x"}),
        M.course_tool_error(None, {"tool": "y"}),
    ]
    want = [
        f"[tool error] w: disk full\n{D}",
        f"[tool error] unknown-tool: （没有错误信息）\n{D}",
        f"[tool error] x: （没有错误信息）\n{D}",
        f"[tool error] y: （没有错误信息）\n{D}",
    ]
    need(J(got) == J(want), J(got))


@t("E7", "换行压平；先脱敏后截断；按码点截到 200 加 …")
def _e7() -> None:
    def head(m: str) -> str:
        return M.course_tool_error({"message": m}, {"tool": "t"}).split("\n")[0]

    need(head("a\nb\r\nc") == "[tool error] t: a b  c", J(head("a\nb\r\nc")))
    need(
        len(M.course_tool_error({"message": "a\nb"}, {"tool": "t"}).split("\n")) == 2,
        "消息里的换行没压平",
    )
    h200 = "汉" * 200
    need(head(h200) == f"[tool error] t: {h200}", "正好 200 个码点不该截")
    need(head("汉" * 201) == f"[tool error] t: {h200}…", "201 个码点应截到 200 加 …")
    need(
        head("😀" * 201) == f"[tool error] t: {'😀' * 200}…",
        "按 UTF-16 码元截断了：emoji 是一个码点、两个码元",
    )
    m = "x" * 190 + " sk-" + "A" * 20
    need(head(m) == f"[tool error] t: {'x' * 190} sk-***", f"先截断再脱敏了：{J(head(m)[-12:])}")


# ─────────────────────────────────────────────────────────────
section("R · 审批恢复只消费一次（TODO 3）")


@t("R1", "第一次：先写 in-flight 再调 resume；成功写 done，返回 ran")
def _r1() -> None:
    store: Kv = {}
    seen = ""

    def fn() -> str:
        nonlocal seen
        cur = store.get("approval:a1")
        seen = "missing" if cur is None else cur
        return "ok"

    o = M.resume_once(store, "a1", "approve", fn)
    need(J(o) == J({"status": "ran", "result": "ok"}), J(o))
    need(seen == "in-flight", f"resume 执行时记录是 {J(seen)}，应先写 in-flight")
    need(store.get("approval:a1") == "done:approve:ok" and len(store) == 1, J(list(store.items())))


@t("R2", "重放同一条审批：不再调 resume，返回缓存的结果（结果里可以有冒号）")
def _r2() -> None:
    store: Kv = {}
    calls = 0

    def fn() -> str:
        nonlocal calls
        calls += 1
        return "a:b:c"

    got = [
        M.resume_once(store, "a1", "approve", fn),
        M.resume_once(store, "a1", "approve", fn),
        M.resume_once(store, "a1", "approve", fn),
    ]
    need(calls == 1, f"resume 被调了 {calls} 次")
    need(
        J([[o.status, o.result] for o in got])
        == J([["ran", "a:b:c"], ["already-consumed", "a:b:c"], ["already-consumed", "a:b:c"]]),
        J(got),
    )
    s2: Kv = {}
    M.resume_once(s2, "r", "reject", lambda: "")
    again = M.resume_once(s2, "r", "reject", lambda: "x")
    need(
        s2.get("approval:r") == "done:reject:"
        and J(again) == J({"status": "already-consumed", "result": ""}),
        f"{J(list(s2.items()))} {J(again)}",
    )


@t("R3", "决定不同 → conflict，带回先前的决定；记录不变")
def _r3() -> None:
    store: Kv = {}
    M.resume_once(store, "a1", "approve", lambda: "x")
    o = M.resume_once(store, "a1", "reject", lambda: "y")
    need(
        J(o) == J({"status": "conflict", "result": "approve"})
        and store.get("approval:a1") == "done:approve:x",
        f"{J(o)} {J(list(store.items()))}",
    )
    s2: Kv = {}
    M.resume_once(s2, "b", "reject", lambda: "no")
    o2 = M.resume_once(s2, "b", "approve", lambda: "yes")
    need(J(o2) == J({"status": "conflict", "result": "reject"}), J(o2))


@t("R4", "resume 抛异常 → crashed，记录留在 in-flight；之后的重投递不重跑")
def _r4() -> None:
    store: Kv = {}

    def boom() -> str:
        raise RuntimeError("killed")

    o = M.resume_once(store, "a2", "approve", boom)
    need(J(o) == J({"status": "crashed", "result": "killed"}), J(o))
    need(store.get("approval:a2") == "in-flight", f"崩溃后记录是 {J(store.get('approval:a2'))}")
    calls = 0

    def fn() -> str:
        nonlocal calls
        calls += 1
        return "z"

    got = [M.resume_once(store, "a2", "approve", fn), M.resume_once(store, "a2", "reject", fn)]
    need(
        calls == 0
        and J(got)
        == J([{"status": "in-flight", "result": ""}, {"status": "in-flight", "result": ""}]),
        f"调了 {calls} 次，{J(got)}",
    )


@t("R5", "键按审批 id 隔离；预置的 in-flight 也不重跑；不碰别的键")
def _r5() -> None:
    store: Kv = {
        "approval:a": "in-flight",
        "other": "keep",
    }
    calls = 0

    def fn() -> str:
        nonlocal calls
        calls += 1
        return f"r{calls}"

    got = [
        M.resume_once(store, "a", "approve", fn),
        M.resume_once(store, "a1", "approve", fn),
        M.resume_once(store, "b", "reject", fn),
    ]
    need(
        J([o.status for o in got]) == J(["in-flight", "ran", "ran"]) and calls == 2,
        f"{J(got)} calls={calls}",
    )
    # TS 的 [...store].sort()：每个 [key, value] 先转成字符串 `key,value` 再比。
    pairs = sorted(store.items(), key=lambda kv: kv[0] + "," + kv[1])
    need(
        J(pairs)
        == J(
            [
                ["approval:a", "in-flight"],
                ["approval:a1", "done:approve:r1"],
                ["approval:b", "done:reject:r2"],
                ["other", "keep"],
            ]
        ),
        J(list(store.items())),
    )


# ─────────────────────────────────────────────────────────────
section("M · MCP 结果 → 文本（TODO 4）")


def txt(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


@t("M1", "isError 只有缺省 / null / false 算成功，其余一律当失败")
def _m1() -> None:
    vals: list[Any] = [None, False, True, "true", 1, 0, "false", {}]
    got = [M.mcp_result_to_text({"content": [txt("x")], "isError": v}).is_error for v in vals]
    missing = M.mcp_result_to_text({"content": [txt("x")]}).is_error
    need(not missing, "缺省 isError 当成了失败")
    need(J(got) == J([False, False, True, True, True, True, True, True]), J(got))


@t("M2", "text 原样；image / resource / resource_link 各有写法；用换行连接")
def _m2() -> None:
    got = [
        M.mcp_result_to_text(F.mcp_cases[4].result).text,
        M.mcp_result_to_text(
            {
                "content": [
                    {"type": "image", "data": "x"},
                    {"type": "resource", "resource": {"uri": "file:///x"}},
                    {"type": "resource", "resource": {}},
                ]
            }
        ).text,
    ]
    need(
        J(got)
        == J(
            [
                "[image image/png，未展开]\n[resource file:///r.txt]\nhello\n[link file:///big.log]",
                "[image ?，未展开]\n[resource file:///x]\n[resource ?]",
            ]
        ),
        J(got),
    )


@t("M3", "不认识的 content 不丢：不是对象、未知 type、type 缺省、字段不对")
def _m3() -> None:
    r: McpResult = {
        "content": [
            "raw",
            {"type": "audio", "data": ".."},
            {"foo": 1},
            {"type": 3},
            {"type": "text"},
            {"type": "resource_link"},
            {"type": "resource", "resource": "x"},
            None,
        ],
    }
    got = M.mcp_result_to_text(r).text.split("\n")
    want = [
        "[unsupported content]",
        "[unsupported content: audio]",
        "[unsupported content: null]",
        "[unsupported content: 3]",
        "[unsupported content: text]",
        "[unsupported content: resource_link]",
        "[unsupported content: resource]",
        "[unsupported content]",
    ]
    need(J(got) == J(want), J(got))


@t("M4", "一项都没有：structuredContent 键在就给它的 JSON（null 也算），否则 (empty result)")
def _m4() -> None:
    got = [
        M.mcp_result_to_text({"content": [], "structuredContent": {"rows": 2}}).text,
        M.mcp_result_to_text({}).text,
        M.mcp_result_to_text({"structuredContent": None}).text,
        M.mcp_result_to_text({"content": "not-array"}).text,
        M.mcp_result_to_text({"content": [txt("a")], "structuredContent": {"x": 1}}).text,
    ]
    need(J(got) == J(['{"rows":2}', "(empty result)", "null", "(empty result)", "a"]), J(got))


@t("M5", "失败：[tool error] 前缀 + 脱敏；成功既不加前缀也不脱敏")
def _m5() -> None:
    got = [
        M.mcp_result_to_text(F.mcp_cases[3].result),
        M.mcp_result_to_text({"isError": True}),
        M.mcp_result_to_text({"content": [txt("token=abc")]}),
    ]
    need(
        J(got)
        == J(
            [
                {"text": "[tool error] 401 token=*** rejected", "isError": True},
                {"text": "[tool error] (empty result)", "isError": True},
                {"text": "token=abc", "isError": False},
            ]
        ),
        J(got),
    )


@t("M6", "夹具里的七种情况全量对表")
def _m6() -> None:
    got = [M.mcp_result_to_text(c.result) for c in F.mcp_cases]
    want = [
        {"text": "[tool error] EACCES: permission denied", "isError": True},
        {"text": "3 files", "isError": False},
        {"text": "[tool error] quota exceeded", "isError": True},
        {"text": "[tool error] 401 token=*** rejected", "isError": True},
        {
            "text": "[image image/png，未展开]\n[resource file:///r.txt]\nhello\n[link file:///big.log]",
            "isError": False,
        },
        {"text": '{"rows":2}', "isError": False},
        {"text": "(empty result)", "isError": False},
    ]
    need(
        J([[g.text, g.is_error] for g in got]) == J([[g["text"], g["isError"]] for g in want]),
        J(got),
    )


# ─────────────────────────────────────────────────────────────
section("H · 以服务端为准重建历史（TODO 5）")


def hist(r: Rebuilt) -> list[str]:
    return [f"{h.tool_call_id}|{h.type}|{h.value}" for h in r.history]


def lg(tool_call_id: str, kind: Literal["error", "result"], text: str) -> LoggedResult:
    return LoggedResult(tool_call_id=tool_call_id, kind=kind, text=text)


def ui(
    tool_call_id: str, state: Literal["output-error", "output-available"], text: str
) -> UiToolPart:
    return UiToolPart(tool_call_id=tool_call_id, state=state, text=text)


@t("H1", "history 按日志顺序，内容以日志为准")
def _h1() -> None:
    r = M.rebuild_history(F.history.ui, F.history.log)
    want = ["c1|text|3 files", f"c2|error-text|{F.history.log[1].text}", "c3|text|ok"]
    need(J(hist(r)) == J(want), J(hist(r)))


@t("H2", "对账：被遮罩的 drifted，客户端造的 forged，客户端丢的 dropped")
def _h2() -> None:
    r = M.rebuild_history(F.history.ui, F.history.log)
    need(
        J([r.drifted, r.forged, r.dropped]) == J([["c2"], ["c9"], ["c3"]]),
        J([r.drifted, r.forged, r.dropped]),
    )


@t("H3", "种类不一致也算 drifted（文本一样也算）；完全一致不算")
def _h3() -> None:
    a = M.rebuild_history([ui("a", "output-available", "x")], [lg("a", "error", "x")]).drifted
    b = M.rebuild_history([ui("b", "output-error", "y")], [lg("b", "result", "y")]).drifted
    c = M.rebuild_history([ui("c", "output-error", "z")], [lg("c", "error", "z")]).drifted
    need(J([a, b, c]) == J([["a"], ["b"], []]), J([a, b, c]))


@t("H4", "UI 里重复的 id 只看第一次；forged 去重、按 UI 顺序")
def _h4() -> None:
    r1 = M.rebuild_history(
        [
            ui("a", "output-available", "1"),
            ui("a", "output-available", "tampered"),
            ui("z", "output-available", ""),
            ui("y", "output-error", ""),
            ui("z", "output-available", ""),
        ],
        [lg("a", "result", "1")],
    )
    r2 = M.rebuild_history(
        [ui("a", "output-available", "tampered"), ui("a", "output-available", "1")],
        [lg("a", "result", "1")],
    )
    need(
        J([r1.drifted, r1.forged, r1.dropped]) == J([[], ["z", "y"], []]),
        J([r1.drifted, r1.forged, r1.dropped]),
    )
    need(J(r2.drifted) == J(["a"]), f"第二次出现覆盖了第一次：{J(r2.drifted)}")


@t("H5", "drifted / dropped 按日志顺序；UI 为空全部 dropped；日志为空 history 为空")
def _h5() -> None:
    log = [lg("c", "result", "3"), lg("b", "result", "2"), lg("a", "result", "1")]
    r = M.rebuild_history([ui("a", "output-available", "x"), ui("b", "output-available", "y")], log)
    need(J([r.drifted, r.dropped]) == J([["b", "a"], ["c"]]), J([r.drifted, r.dropped]))
    e = M.rebuild_history([], log)
    need(J(e.dropped) == J(["c", "b", "a"]) and len(hist(e)) == 3, J(e))
    n = M.rebuild_history([ui("q", "output-available", "")], [])
    need(J([hist(n), n.forged, n.drifted, n.dropped]) == J([[], ["q"], [], []]), J(n))


# ─────────────────────────────────────────────────────────────
section("D · Dify DSL → 代码计划（TODO 6）")


def sig(p: DifyPlan) -> list[str]:
    return [f"{s.id}:{s.type}:{'+'.join(s.needs)}" for s in p.steps]


def graph(
    nodes: list[Any], edges: list[Any], extra: dict[str, Any] | None = None
) -> dict[str, Any]:
    return {
        "version": "0.7.0",
        "kind": "app",
        **({} if extra is None else extra),
        "workflow": {"graph": {"nodes": nodes, "edges": edges}},
    }


def node(id_: str, data: dict[str, Any], canvas: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"id": id_, "type": "custom", **({} if canvas is None else canvas), "data": data}


def edge(source: str, target: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": f"{source}-{target}",
        "source": source,
        "target": target,
        **({} if extra is None else extra),
    }


@t("D1", "夹具：version / kind / 画布字段数 / 执行顺序 / 分支")
def _d1() -> None:
    p = M.dify_plan(fx().dify)
    need(p.version == "0.7.0" and p.kind == "app", f"{p.version} {p.kind}")
    need(p.ui_fields_dropped == 20, f"画布字段 {p.ui_fields_dropped}，应为 20")
    need(
        J(p.order) == J(["start", "kr", "route", "llm", "ticket", "notify", "answer", "fallback"]),
        J(p.order),
    )
    need(J(p.branches) == J(["route:true->llm", "route:false->ticket"]), J(p.branches))


@t("D2", "夹具：每个节点改写成代码时要补的东西")
def _d2() -> None:
    p = M.dify_plan(fx().dify)
    want = [
        "start:start:",
        "kr:knowledge-retrieval:rebind-index",
        "route:if-else:",
        "llm:llm:sliding-window-breaks-cache",
        "ticket:http-request:no-retry+idempotency-key",
        "notify:tool:reconnect-secret",
        "answer:answer:",
        "fallback:answer:",
    ]
    need(J(sig(p)) == J(want), J(sig(p)))
    need(p.steps[0].title == "开始" and p.steps[4].title == "建工单", J([s.title for s in p.steps]))


@t("D3", "夹具：false 分支引用了 true 分支的输出")
def _d3() -> None:
    p = M.dify_plan(fx().dify)
    need(
        J(p.refs)
        == J(
            [
                "llm<-kr.result",
                "llm<-sys.query",
                "ticket<-sys.query",
                "notify<-ticket.body",
                "answer<-llm.text",
                "fallback<-ticket.body",
                "fallback<-sys.query",
            ]
        ),
        J(p.refs),
    )
    need(J(p.errors) == J(["ref-not-upstream:ticket:llm.text"]), J(p.errors))


@t("D4", "版本与 kind：缺省补 0.1.0 / app；新于读取器、格式不对、kind 不对都报；不是对象")
def _d4() -> None:
    def e(x: Any) -> list[str]:
        return M.dify_plan(x).errors

    empty = M.dify_plan({})
    need(
        empty.version == "0.1.0"
        and empty.kind == "app"
        and len(empty.errors) == 0
        and len(empty.order) == 0,
        J(empty),
    )
    got = [
        e({"version": "0.8.0"}),
        e({"version": "0.7.1"}),
        e({"version": "0.10.0"}),
        e({"version": "1.0"}),
        e({"version": "0.6.9"}),
        e({"version": "0.7.0", "kind": "dataset"}),
        e({"version": 7}),
    ]
    need(
        J(got)
        == J(
            [
                ["newer-dsl:0.8.0"],
                ["newer-dsl:0.7.1"],
                ["newer-dsl:0.10.0"],
                ["bad-version:1.0"],
                [],
                ["kind:dataset"],
                [],
            ]
        ),
        J(got),
    )
    bad = [[p.version, p.errors] for p in [M.dify_plan(None), M.dify_plan([]), M.dify_plan("x")]]
    need(
        J(bad) == J([["", ["not-an-object"]], ["", ["not-an-object"]], ["", ["not-an-object"]]]),
        J(bad),
    )


@t("D5", "坏节点（含空 id）、重复节点、悬空边：报出来，图照样排")
def _d5() -> None:
    p = M.dify_plan(
        graph(
            [
                node("a", {"type": "start", "title": "A"}),
                "junk",
                node("b", {"type": "code", "title": "B"}, {"position": {}}),
                node("a", {"type": "end"}, {"width": 1}),
                {"data": {}},
                {"id": "", "data": {"type": "code"}},
            ],
            [
                edge("a", "b"),
                edge("b", "zz", {"id": "e2"}),
                5,
                {"source": "a", "target": "q", "zIndex": 0},
            ],
        ),
    )
    need(
        J(p.errors)
        == J(
            [
                "bad-node",
                "duplicate-node:a",
                "bad-node",
                "bad-node",
                "dangling-edge:e2",
                "bad-edge",
                "dangling-edge:?",
            ]
        ),
        J(p.errors),
    )
    need(
        p.ui_fields_dropped == 3,
        f"画布字段 {p.ui_fields_dropped}，应为 3（重复节点和悬空边上的也算）",
    )
    need(J(sig(p)) == J(["a:start:", "b:code:sandbox"]), J(sig(p)))


@t("D6", "每轮取列表里第一个入度为 0 的；取不完的报 cycle，steps 里照样列出")
def _d6() -> None:
    ids = ["a", "b", "c", "d", "e", "f", "g"]
    p = M.dify_plan(
        graph(
            [node(id_, {"type": "answer"}) for id_ in ids],
            [edge("a", "d"), edge("b", "c"), edge("e", "f"), edge("f", "e"), edge("f", "g")],
        ),
    )
    need(J(p.order) == J(["a", "b", "c", "d"]), f"执行顺序 {J(p.order)}（不是队列序 a,b,d,c）")
    need(J(p.errors) == J(["cycle:e,f,g"]), J(p.errors))
    need(J([s.id for s in p.steps]) == J(ids) and len(p.branches) == 0, J([s.id for s in p.steps]))


@t("D7", "引用：命名空间、未知节点、不是上游、同节点去重；嵌套的字符串也要扫到")
def _d7() -> None:
    p = M.dify_plan(
        graph(
            [
                node("start", {"type": "start"}),
                node(
                    "n1",
                    {
                        "type": "llm",
                        "prompt": [
                            "{{#sys.query#}} {{#sys.query#}}",
                            {"deep": {"x": "{{#ghost.out#}}"}},
                        ],
                        "memory": {"window": {"enabled": False}},
                    },
                ),
                node(
                    "n2",
                    {
                        "type": "template-transform",
                        "template": "{{#n1.text#}}{{#n2.self#}}{{#env.KEY#}}{{#start.a.b#}}",
                    },
                ),
                node(
                    "n3",
                    {"type": "answer", "answer": "{{#n2.output#}} {{#sys#}} {{#conversation.x#}}"},
                ),
            ],
            [edge("start", "n1"), edge("n1", "n2"), edge("n2", "n3")],
        ),
    )
    need(
        J(p.refs)
        == J(
            [
                "n1<-sys.query",
                "n2<-n1.text",
                "n2<-env.KEY",
                "n2<-start.a.b",
                "n3<-n2.output",
                "n3<-conversation.x",
            ]
        ),
        J(p.refs),
    )
    need(J(p.errors) == J(["unknown-ref:n1:ghost.out", "ref-not-upstream:n2:n2.self"]), J(p.errors))
    need(
        J(sig(p)) == J(["start:start:", "n1:llm:", "n2:template-transform:", "n3:answer:"]),
        J(sig(p)),
    )


# ─────────────────────────────────────────────────────────────
section("F · 框架模型（参考实现，只读）")


@t("F1", "七个入口的默认上限：1 到无穷大，撞上限有三种结束方式")
def _f1() -> None:
    o = [shared.simulate_default_loop(d, 50) for d in F.loops]
    need(
        J([d.default_limit for d in F.loops]) == J([1, 20, None, 5, 10, None, 25]),
        J([d.default_limit for d in F.loops]),
    )
    need(
        J([x.model_calls for x in o]) == J([1, 20, 50, 5, 10, 50, 25]),
        J([x.model_calls for x in o]),
    )
    need(
        J([d.id for d in F.loops if d.on_limit == "throw"])
        == J(["openai-agents/run", "langgraph.js"]),
        "只有 Agents SDK 和 LangGraph 撞上限会抛",
    )


@t("F2", "isStepCount 是严格相等：0 永远不触发；课程用 ≥")
def _f2() -> None:
    need(
        J(first_stop(failing_steps(20), shared.ai_sdk_is_step_count(0))) == J([0, "running"]),
        "isStepCount(0) 触发了",
    )
    need(
        J(first_stop(failing_steps(20), shared.ai_sdk_is_step_count(20))) == J([20, "stop"]),
        "isStepCount(20) 应在第 20 步触发",
    )
    need(
        shared.course_stop_when(StopOpts(max_steps=0, max_repeat=0))(failing_steps(1)),
        "课程的 maxSteps 0 应当停",
    )


@t("F3", "四家框架的默认回填：三家泄密，一家叫你原样重试")
def _f3() -> None:
    e = F.tool_error
    got = [shared.audit_backfill(shared.framework_backfill(r, e), e["tool"]) for r in F.backfills]
    need(
        J(got)
        == J(
            [
                ["leaks-secret", "no-tool-name", "no-next-step"],
                ["leaks-secret", "no-error-signal", "no-tool-name", "no-next-step"],
                ["leaks-secret", "no-error-signal", "no-tool-name", "no-next-step"],
                ["no-tool-name", "no-next-step", "retry-as-is"],
            ]
        ),
        J(got),
    )
    need(
        len(shared.audit_backfill(shared.course_tool_error(e, {"tool": e["tool"]}), e["tool"]))
        == 0,
        "课程的回填没过体检",
    )


@t("F4", "MCP isError：AI SDK 的线上块没有 is_error；DeepSeek 只看文本")
def _f4() -> None:
    r = F.mcp_cases[0].result
    wire = shared.ai_sdk_mcp_wire(r, "tu1")
    need(
        J(wire)
        == '{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"EACCES: permission denied"}]}',
        J(wire),
    )
    need(shared.deepseek_sees(wire) == "EACCES: permission denied", "对照组的文本不对")
    need(
        shared.deepseek_sees(shared.course_mcp_wire(r, "tu1"))
        == "[tool error] EACCES: permission denied",
        "课程的块里看不出失败",
    )


@t("F5", "UI 遮罩改写下一轮；同一份 RunState 恢复两次执行两次")
def _f5() -> None:
    d = shared.ui_round_trip(F.ui.model_saw)
    need(d.turn_n == F.ui.model_saw and d.turn_n1 == shared.AI_SDK_UI_ERROR_MASK, J(d))
    need(
        shared.ui_round_trip(F.ui.model_saw, lambda s: s).turn_n1 == F.ui.model_saw,
        "onError: s => s 之后应当不变",
    )
    n = 0

    def bump() -> None:
        nonlocal n
        n += 1

    need(
        J(shared.run_state_resume(2, bump)) == J(F.run_state.measured_effects) and n == 2,
        J(F.run_state),
    )


@t("F6", "Claude Agent SDK 的默认、fork 成本累计、平台的选法")
def _f6() -> None:
    c = F.claude_agent_sdk
    query = next((d for d in F.loops if d.id == "claude-agent-sdk/query"), None)
    need(
        c.permission_mode == "auto" and query is not None and query.default_limit is None,
        "默认 auto、默认无上限",
    )
    need(
        "retry-as-is" in shared.audit_backfill(c.auto_denial, "x"),
        "分类器失败的回填应当是「原样重试」",
    )
    need(
        c.sessions[2].cost_micro_usd >= c.sessions[1].cost_micro_usd
        and shared.fmt_usd(c.sessions[2].cost_micro_usd) == "0.0024",
        "fork 的成本应包含父会话",
    )
    picks = [shared.choose_platform(n) for _, n in SCENARIOS]
    need(
        J([p.pick for p in picks])
        == J(["平台", "平台做原型，DSL 当需求文档，手写上线", "手写", "手写"]),
        J([p.pick for p in picks]),
    )
    need(
        len(picks[1].license) == 1 and picks[3].license[0].startswith("n8n"),
        J([p.license for p in picks]),
    )


print()
if failed == 0:
    print(green(f"  ✓ {passed} 条断言全部通过"))
    print(
        dim(
            "\n  最该记住的六条：\n"
            "    STOP   原因要显式：approval / truncated / error / done / repeat / max_steps 各是各的；上限用 ≥，0 也要停\n"
            "    ERROR  失败写在文本里：前缀 + 工具名 + 下一步；先脱敏再截断；不叫模型原样重试\n"
            "    ONCE   恢复只消费一次：先认领再执行；in-flight 不重跑、要对账；决定冲突要报\n"
            "    MCP    isError 只有缺省 / null / false 算成功；不认识的 content 写出来，不要吞\n"
            "    HIST   下一轮的历史以服务端日志为准；UI 消息只用来对账：drifted / forged / dropped\n"
            "    DSL    拓扑序在前不等于是上游；凭据、知识库、画布字段都不跟着 DSL 走\n"
        )
    )
    raise SystemExit(0)
print(red(f"  ✗ {failed} 失败 / {passed} 通过"))
raise SystemExit(1)
