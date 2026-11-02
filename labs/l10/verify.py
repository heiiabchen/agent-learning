"""验证 l10/server.py。跑法：

    cd labs && uv run python -m l10.verify

一次 API 都不调，也不 spawn 子进程——**除了最后一组**。
最后那三条会真的起一个进程走一遍管道，因为拆帧、stdout 纪律、
以及 Python 的 flush，这三件事只有在真管道上才测得出来。

这套测试里有一整组盯着**静默失效**（标 ★）：
拆帧丢半条、通知被回了响应、错误走错通道、工具顺序不确定、
log_note 漏进响应、bool 被当成 id。

它们的共同点是**不抛异常**。协议层坏掉的样子从来不是报错，
是"大部分时候能用"。

先跑 VERIFY_TARGET=shared uv run python -m l10.verify 确认测试本身是对的。
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from shared.mcp import (
    META_CLIENT_CAPS,
    META_CLIENT_INFO,
    META_VERSION,
    PROTOCOL_VERSION,
    McpServer,
    McpTool,
    Request,
    ToolOutcome,
    Validated,
)
from shared.mcp import Framer as SharedFramer
from shared.mcp import (
    handle_request as shared_handle_request,
)
from shared.mcp import (
    tools_list_cost as shared_tools_list_cost,
)
from shared.mcp import (
    validate_request as shared_validate_request,
)
from shared.mcp import (
    wrap_tool_def as shared_wrap_tool,
)
from shared.tools import ParseErr, ParseOk, ParseResult, ToolDef, ToolResult

ROOT = Path(__file__).resolve().parent.parent
TARGET = "shared" if os.environ.get("VERIFY_TARGET") == "shared" else "mine"

if TARGET == "shared":
    make_framer: Callable[..., Any] = SharedFramer
    validate_request = shared_validate_request
    tools_list_cost = shared_tools_list_cost
    route_request = shared_handle_request
    wrap_tool = shared_wrap_tool

    async def call_tool(
        server: McpServer, req_id: str | int, params: dict[str, Any]
    ) -> dict[str, Any]:
        # shared 那边把 tools/call 收在 handle_request 里，这里包一层对齐形状。
        resp = await shared_handle_request(
            server, Request(method="tools/call", params=params, id=req_id)
        )
        assert resp is not None
        return resp

else:
    from l10 import server as mine

    make_framer = mine.Framer
    validate_request = mine.validate_request
    tools_list_cost = mine.tools_list_cost
    route_request = mine.route_request
    call_tool = mine.call_tool
    wrap_tool = mine.wrap_tool

print(
    "\n（测的是 shared/ 里的参考实现）"
    if TARGET == "shared"
    else "\n（测的是 l10/ 里你的实现）"
)

passed = 0
failures: list[str] = []


async def test(name: str, fn: Callable[[], Any]) -> None:
    global passed
    try:
        r = fn()
        if isinstance(r, Awaitable):
            await r
        passed += 1
        print(f"\033[32m  ✓ {name}\033[0m")
    except Exception as err:  # noqa: BLE001 —— 这就是测试运行器
        failures.append(name)
        print(f"\033[31m  ✕ {name}\033[0m")
        print(f"\033[31m      {err}\033[0m")


def check(cond: object, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


# ─── 素材 ────────────────────────────────────────────────────


def meta(version: str = PROTOCOL_VERSION) -> dict[str, Any]:
    return {
        META_VERSION: version,
        META_CLIENT_INFO: {"name": "t", "version": "0"},
        META_CLIENT_CAPS: {},
    }


def line(
    method: str, params: dict[str, Any] | None = None, req_id: int | None = 1
) -> str:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if req_id is not None:
        msg["id"] = req_id
    msg["params"] = {**(params or {}), "_meta": meta()}
    return json.dumps(msg, ensure_ascii=False)


def fake_tool(
    name: str, run: Callable[[dict[str, Any]], Awaitable[ToolOutcome]]
) -> McpTool:
    return McpTool(
        name=name, description=f"工具 {name}", input_schema={"type": "object"}, run=run
    )


def fake_server(tools: list[McpTool]) -> McpServer:
    return McpServer(name="test", version="1", tools=tools)


async def _echo(args: dict[str, Any]) -> ToolOutcome:
    return ToolOutcome(text=f"echo:{json.dumps(args, ensure_ascii=False, sort_keys=True)}")


async def _soft(_args: dict[str, Any]) -> ToolOutcome:
    return ToolOutcome(text="文件不存在：a.py。用 list_dir 看看。", is_error=True)


async def _hard(_args: dict[str, Any]) -> ToolOutcome:
    raise RuntimeError("数据库连不上")


ok_tool = fake_tool("echo", _echo)
soft_fail = fake_tool("soft", _soft)
hard_fail = fake_tool("hard", _hard)


async def ask(
    server: McpServer,
    method: str,
    params: dict[str, Any] | None = None,
    req_id: int | None = 1,
) -> dict[str, Any] | None:
    v = validate_request(line(method, params, req_id))
    check(v.ok, f"校验没过：{v.error.message if v.error else ''}")
    assert v.req is not None
    return await route_request(server, v.req)


def result_of(r: dict[str, Any] | None) -> dict[str, Any]:
    check(r is not None, "不该是 None（这不是通知）")
    assert r is not None
    check("error" not in r, f"不该是错误：{r.get('error')}")
    return r["result"]


def error_of(r: dict[str, Any] | None) -> dict[str, Any]:
    check(r is not None, "不该是 None")
    assert r is not None
    check("error" in r, f"应该是协议错误，实际是 result：{r}")
    return r["error"]


async def main() -> None:  # noqa: PLR0915 —— 测试列表，线性读就行
    # ─────────────────────────────────────────────────────────
    print("\nNDJSON 拆帧")
    # ─────────────────────────────────────────────────────────

    async def t_one_line() -> None:
        f = make_framer()
        check(len(f.push('{"a":1}\n')) == 1, "一整行应该吐出一条")

    await test("一次喂进整行", t_one_line)

    async def t_multi_line() -> None:
        f = make_framer()
        check(len(f.push('{"a":1}\n{"b":2}\n')) == 2, "两行应该吐出两条")

    await test("一次喂进多行", t_multi_line)

    async def t_partial() -> None:
        f = make_framer()
        got = f.push('{"a":1')
        check(len(got) == 0, f"半条不该吐出来，吐了 {got}")
        check(f.buffered > 0, "buffered 应该 > 0——它是诊断「对面卡住了」的唯一信号")
        check(len(f.push("}\n")) == 1, "补齐之后才吐")

    await test("★ 半条消息要留在缓冲里，不能吐出去", t_partial)

    async def t_boundaries() -> None:
        wire = '{"a":1}\n{"b":22}\n{"c":333}\n'
        for size in (1, 2, 3, 5, 7, 11, 17):
            f = make_framer()
            got: list[str] = []
            for i in range(0, len(wire), size):
                got.extend(f.push(wire[i : i + size]))
            check(
                len(got) == 3,
                f"按 {size} 字符切之后只拿到 {len(got)} 条。\n"
                "      不拆帧的代码在本地「能跑」，是因为消息小、来得慢；\n"
                "      等到某个工具返回 80KB 才炸，而且是在生产环境",
            )
            check(
                got[0] == '{"a":1}' and got[2] == '{"c":333}',
                f"内容被切坏了：{got}",
            )

    await test("★ 任意边界都不能丢内容（管道只承诺顺序）", t_boundaries)

    async def t_blank() -> None:
        f = make_framer()
        check(len(f.push('\n\n{"a":1}\n\n')) == 1, "空行不该算消息")

    await test("空行被跳过（不能当成一条空消息）", t_blank)

    async def t_cap() -> None:
        f = make_framer(64)
        threw = False
        try:
            f.push("x" * 200)
        except ValueError:
            threw = True
        check(
            threw,
            "没有上限的话，对面永远不发换行时缓冲区会涨到 OOM。\n"
            "      而 OOM 的现场没有任何信息指向「对面没换行」这个原因",
        )

    await test("★ 超过上限要抛错，不能无限缓冲", t_cap)

    # ─────────────────────────────────────────────────────────
    print("\n请求校验（2026-07-28 的每请求元数据）")
    # ─────────────────────────────────────────────────────────

    async def t_valid() -> None:
        v = validate_request(line("tools/list"))
        check(v.ok, f"应该通过：{v.error.message if v.error else ''}")
        assert v.req is not None
        check(v.req.method == "tools/list", "method 没读对")

    await test("合法请求能过", t_valid)

    async def t_not_json() -> None:
        v = validate_request("server started on port 3000")
        check(
            not v.ok and v.error is not None and v.error.code == -32700,
            f"应该是 -32700，实际 {v}",
        )

    await test("不是 JSON → -32700", t_not_json)

    async def t_bad_jsonrpc() -> None:
        v = validate_request('{"jsonrpc":"1.0","id":1,"method":"x","params":{}}')
        check(
            not v.ok and v.error is not None and v.error.code == -32600,
            f"应该是 -32600，实际 {v}",
        )

    await test('jsonrpc 不是 "2.0" → -32600', t_bad_jsonrpc)

    async def t_no_version() -> None:
        raw = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/list",
                "params": {"_meta": {META_CLIENT_CAPS: {}}},
            }
        )
        v = validate_request(raw)
        check(
            not v.ok and v.error is not None and v.error.code == -32602,
            "2026-07-28 把老的 -32002 换成了 -32602。\n"
            "      照旧教程写 -32002 判断的代码在新 server 上不会报错，\n"
            "      会**静默走进 else 分支**——这类 bug 只在版本升级后出现",
        )

    await test("★ 缺 protocolVersion → -32602（不是 -32002）", t_no_version)

    async def t_no_caps() -> None:
        raw = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/list",
                "params": {"_meta": {META_VERSION: PROTOCOL_VERSION}},
            }
        )
        v = validate_request(raw)
        check(
            not v.ok and v.error is not None and v.error.code == -32602,
            f"应该是 -32602，实际 {v}",
        )

    await test("缺 clientCapabilities → -32602", t_no_caps)

    async def t_bad_version() -> None:
        raw = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/list",
                "params": {"_meta": meta("2025-06-18")},
            }
        )
        v = validate_request(raw)
        check(
            not v.ok and v.error is not None and v.error.code == -32022,
            f"应该是 -32022，实际 {v}",
        )
        data = v.error.data if v.error else None
        supported = data.get("supported") if isinstance(data, dict) else None
        check(
            isinstance(supported, list) and PROTOCOL_VERSION in supported,
            "少了 supported 列表，客户端只能猜或者放弃。\n"
            "      带上它，「版本不匹配」就从一个死胡同变成一次自动重试",
        )

    await test("★ 版本不支持 → -32022，且 data 里带 supported 列表", t_bad_version)

    async def t_id_recovery() -> None:
        raw = json.dumps(
            {"jsonrpc": "2.0", "id": 77, "method": "tools/list", "params": {}}
        )
        v = validate_request(raw)
        check(not v.ok, "这条应该不过")
        check(
            v.id == 77,
            f"id 没读出来（拿到 {v.id!r}）。\n"
            "      读不出 id 就回不了响应，而客户端那边挂着一个永远不返回的 await",
        )

    await test("★ 校验失败也要能定位 id（否则客户端永远挂着）", t_id_recovery)

    async def t_null_id() -> None:
        raw = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": None,
                "method": "tools/list",
                "params": {"_meta": meta()},
            }
        )
        v = validate_request(raw)
        check(not v.ok, "id=null 应该被拒——null 没法和「通知」区分开")

    await test("id 是 null → 不合法（MCP 比 JSON-RPC 严）", t_null_id)

    async def t_bool_id() -> None:
        raw = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": True,
                "method": "tools/list",
                "params": {"_meta": meta()},
            }
        )
        v = validate_request(raw)
        got = v.req.id if v.ok and v.req else v.id
        check(
            got is not True,
            "`isinstance(True, int)` 在 Python 里是 True，所以 `{\"id\": true}` \n"
            "      会被当成合法 id 收下。而 `hash(True) == hash(1)`——\n"
            "      它在 pending 字典里和 id=1 **是同一个键**，\n"
            "      于是一个响应 resolve 掉另一个请求，两边都拿到不属于自己的答案。\n"
            "      TS 那边没有这个陷阱（typeof true === 'boolean'），这是 Python 独有的。\n"
            "      排掉它：isinstance(x, str | int) and not isinstance(x, bool)",
        )

    await test("★ id 是 true → 不能当成整数 1（Python 特有）", t_bool_id)

    async def t_notification() -> None:
        raw = json.dumps(
            {
                "jsonrpc": "2.0",
                "method": "notifications/cancelled",
                "params": {"requestId": 3},
            }
        )
        v = validate_request(raw)
        check(v.ok, f"通知应该通过：{v.error.message if v.error else ''}")
        assert v.req is not None
        check(v.req.id is None, "通知不该有 id")

    await test("通知（没有 id）不需要 _meta", t_notification)

    # ─────────────────────────────────────────────────────────
    print("\n路由")
    # ─────────────────────────────────────────────────────────

    async def t_discover() -> None:
        r = result_of(await ask(fake_server([ok_tool]), "server/discover"))
        check(isinstance(r.get("supportedVersions"), list), "要有 supportedVersions")
        check(PROTOCOL_VERSION in r["supportedVersions"], "要包含当前版本")
        check(isinstance(r.get("capabilities"), dict), "要有 capabilities")

    await test("server/discover 报出支持的版本和能力", t_discover)

    async def t_list() -> None:
        r = result_of(await ask(fake_server([ok_tool, soft_fail]), "tools/list"))
        tools = r["tools"]
        check(len(tools) == 2, f"应该 2 个，实际 {len(tools)}")
        for t in tools:
            check(
                isinstance(t.get("name"), str) and isinstance(t.get("description"), str),
                "缺 name/description",
            )
            check(isinstance(t.get("inputSchema"), dict), "缺 inputSchema")
            check("run" not in t, "run 不该出现在协议里")
            check("input_schema" not in t, "线上字段是 inputSchema（驼峰），不是 input_schema")

    await test("tools/list 返回全部工具的对外形状", t_list)

    async def t_order() -> None:
        names = ["zeta", "alpha", "mid"]
        a = result_of(
            await ask(fake_server([fake_tool(n, _echo) for n in names]), "tools/list")
        )
        b = result_of(
            await ask(
                fake_server([fake_tool(n, _echo) for n in reversed(names)]), "tools/list"
            )
        )
        na = ",".join(t["name"] for t in a["tools"])
        nb = ",".join(t["name"] for t in b["tools"])
        check(
            na == nb,
            f"注册顺序不同就得到不同的清单：\n      {na}\n      {nb}\n"
            "      工具清单进的是 system prompt 的**前缀**，顺序一抖前缀缓存整体失效。\n"
            "      而账单上只会显示「input token 变贵了」",
        )

    await test("★ tools/list 的顺序必须确定（前缀缓存靠它）", t_order)

    async def t_notify_silent() -> None:
        v = validate_request(
            json.dumps(
                {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {}}
            )
        )
        check(v.ok, "通知应该过校验")
        assert v.req is not None
        r = await route_request(fake_server([ok_tool]), v.req)
        check(
            r is None,
            "回了的话客户端会收到一个它没发过的 id 的响应。\n"
            "      严格的实现会直接断连，宽容的会静默丢弃——两种都不好查",
        )

    await test("★ 通知处理完不回响应", t_notify_silent)

    async def t_unknown_method() -> None:
        e = error_of(await ask(fake_server([ok_tool]), "tools/nope"))
        check(e["code"] == -32601, f"应该是 -32601，实际 {e['code']}")

    await test("未知方法 → -32601", t_unknown_method)

    async def t_server_info() -> None:
        r = result_of(await ask(fake_server([ok_tool]), "tools/list"))
        m = r.get("_meta")
        check(
            isinstance(m, dict)
            and isinstance(m.get("io.modelcontextprotocol/serverInfo"), dict),
            "缺 _meta.serverInfo",
        )

    await test("响应里带 serverInfo", t_server_info)

    async def t_result_type() -> None:
        r = result_of(await ask(fake_server([ok_tool]), "tools/list"))
        check(
            r.get("resultType") == "complete",
            f"resultType 应该是 complete，实际 {r.get('resultType')!r}",
        )

    await test("resultType 是 complete", t_result_type)

    # ─────────────────────────────────────────────────────────
    print("\n两种错误")
    # ─────────────────────────────────────────────────────────

    async def t_ok_call() -> None:
        r = result_of(
            await call_tool(
                fake_server([ok_tool]), 1, {"name": "echo", "arguments": {"x": 1}}
            )
        )
        check(r.get("isError") is False, f"isError 应该是 False，实际 {r.get('isError')!r}")
        content = r["content"]
        check(
            content[0]["type"] == "text" and content[0]["text"].startswith("echo:"),
            f"content 不对：{content}",
        )

    await test("正常调用：isError=False，content 是文本块数组", t_ok_call)

    async def t_soft_fail() -> None:
        resp = await call_tool(fake_server([soft_fail]), 1, {"name": "soft", "arguments": {}})
        check(
            "error" not in resp,
            "「文件不存在」是模型能自己改对的，必须进 result。\n"
            "      写成协议错误的话模型看不到失败原因，只会重试同一个错参数",
        )
        check(resp["result"]["isError"] is True, "isError 应该是 True")

    await test("★ 工具返回失败 → result + isError:true（不是协议错误）", t_soft_fail)

    async def t_unknown_tool() -> None:
        e = error_of(
            await call_tool(fake_server([ok_tool]), 1, {"name": "nope", "arguments": {}})
        )
        check(
            e["code"] == -32602,
            f"应该是 -32602，实际 {e['code']}。\n"
            "      写成 isError 的话，模型看到「没有这个工具」，然后接着编下一个工具名",
        )

    await test("★ 工具名不存在 → 协议错误（模型改参数也没用）", t_unknown_tool)

    async def t_tool_raises() -> None:
        e = error_of(
            await call_tool(fake_server([hard_fail]), 1, {"name": "hard", "arguments": {}})
        )
        check(
            e["code"] == -32603,
            f"应该是 -32603，实际 {e['code']}。\n"
            "      把它也变成 isError 的话，模型会拿着一个永远不会成功的调用\n"
            "      重试到步数上限，而你的日志里只有一堆看起来像「模型没试对」的 isError",
        )
        check("数据库连不上" in e["message"], "错误信息里要有原始原因")

    await test("★ 工具 run 抛异常 → 协议错误 -32603（那是你的 bug）", t_tool_raises)

    async def t_cancel_passthrough() -> None:
        async def cancels(_args: dict[str, Any]) -> ToolOutcome:
            raise asyncio.CancelledError

        raised = False
        try:
            await call_tool(
                fake_server([fake_tool("c", cancels)]), 1, {"name": "c", "arguments": {}}
            )
        except asyncio.CancelledError:
            raised = True
        check(
            raised,
            "CancelledError 必须往上抛，不能被包成 -32603。\n"
            "      裸 `except Exception` 抓不到它（它继承 BaseException），所以默认是对的；\n"
            "      但写成 `except BaseException` 就把取消吞成了工具失败——\n"
            "      而客户端那边早就不在等这个响应了，这条 -32603 只会变成一条孤儿日志",
        )

    await test("★ 取消要穿透，不能被吞成 -32603（Python 特有）", t_cancel_passthrough)

    async def t_bad_args() -> None:
        e = error_of(
            await call_tool(
                fake_server([ok_tool]), 1, {"name": "echo", "arguments": ["x"]}
            )
        )
        check(e["code"] == -32602, f"应该是 -32602，实际 {e['code']}")

    await test("arguments 不是对象 → 协议错误", t_bad_args)

    async def t_bad_name() -> None:
        e = error_of(await call_tool(fake_server([ok_tool]), 1, {"name": 42}))
        check(e["code"] == -32602, f"应该是 -32602，实际 {e['code']}")

    await test("name 不是字符串 → 协议错误", t_bad_name)

    async def t_omit_args() -> None:
        r = result_of(await call_tool(fake_server([ok_tool]), 1, {"name": "echo"}))
        check(
            r["content"][0]["text"] == "echo:{}",
            f"应该当成 {{}}，实际 {r['content']}",
        )

    await test("省略 arguments 等于空对象", t_omit_args)

    # ─────────────────────────────────────────────────────────
    print("\n把 L04 的工具包成 MCP 工具")
    # ─────────────────────────────────────────────────────────

    def _parse(raw: Any) -> ParseResult:
        p = raw.get("path") if isinstance(raw, dict) else None
        if not isinstance(p, str):
            return ParseErr(message="缺少必填参数 path（需要一个非空字符串）。")
        return ParseOk(input={"path": p})

    async def _run(inp: dict[str, Any]) -> ToolResult:
        if inp["path"] == "secret":
            return ToolResult(
                content="不能读仓库外的路径。",
                is_error=True,
                log_note="拒绝了一次越界访问 ../../etc/passwd",
            )
        return ToolResult(content=f"内容：{inp['path']}")

    strict_def = ToolDef(
        name="peek",
        description="读一个文件",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
        parse=_parse,
        run=_run,
    )

    async def t_wrap_shape() -> None:
        t = wrap_tool(strict_def)
        check(t.name == "peek" and t.description == "读一个文件", "name/description 没带过去")
        check(t.input_schema["required"][0] == "path", "input_schema 没带过去")

    await test("name / description / input_schema 原样带过去", t_wrap_shape)

    async def t_wrap_ok() -> None:
        t = wrap_tool(strict_def)
        out = await t.run({"path": "a.py"})
        check(
            out.text == "内容：a.py" and out.is_error is not True,
            f"不对：{out}",
        )

    await test("正常路径：结果变成 text", t_wrap_ok)

    async def t_wrap_parse_fail() -> None:
        t = wrap_tool(strict_def)
        out = await t.run({})
        check(
            out.is_error is True and "path" in out.text,
            "参数格式不对是模型能自己改的。\n"
            "      L04 那条「失败回结果，不抛异常」在这里从团队约定升级成了协议要求",
        )

    await test("★ parse 失败 → is_error=True，不是抛异常", t_wrap_parse_fail)

    async def t_wrap_is_error() -> None:
        t = wrap_tool(strict_def)
        out = await t.run({"path": "secret"})
        check(out.is_error is True, "is_error 没透传")

    await test("run 返回的 is_error 要透传", t_wrap_is_error)

    async def t_wrap_lognote() -> None:
        t = wrap_tool(strict_def)
        out = await t.run({"path": "secret"})
        check(
            "etc/passwd" not in out.text and "越界" not in out.text,
            f"log_note 漏进响应了：{out.text}\n"
            "      它的内容是「拒绝了一次越界访问 ../../etc/passwd」——\n"
            "      回给模型等于把沙箱的边界告诉了可能正在探边界的那一方",
        )

    await test("★ log_note 不许进 content（它是给日志的，不是给模型的）", t_wrap_lognote)

    # ─────────────────────────────────────────────────────────
    print("\n上下文税")
    # ─────────────────────────────────────────────────────────

    async def t_cost_grows() -> None:
        small = tools_list_cost([fake_tool("a", _echo)])
        big_a = fake_tool("a", _echo)
        big_a.description = "描述" * 200
        big_b = fake_tool("b", _echo)
        big_b.description = "描述" * 200
        big = tools_list_cost([big_a, big_b])
        check(
            big.tokens > small.tokens * 5,
            f"没随描述长度涨：{small.tokens} → {big.tokens}",
        )

    await test("工具越多、描述越长，token 越多", t_cost_grows)

    async def t_cost_includes_desc() -> None:
        bare = fake_tool("a", _echo)
        bare.description = ""
        rich = fake_tool("a", _echo)
        rich.description = "这是一段很长的工具说明" * 20
        check(
            tools_list_cost([rich]).tokens > tools_list_cost([bare]).tokens,
            "description 没算进去。\n"
            "      它是模型唯一的判断依据，也是你每一轮都在付的钱——\n"
            "      只算 name 的话这个数字对决策毫无帮助",
        )

    await test("★ 算的必须是进上下文的那份（含 description 和 schema）", t_cost_includes_desc)

    async def t_cost_ascii() -> None:
        cn = fake_tool("a", _echo)
        cn.description = "读取一个文件并返回它的内容" * 10
        cost = tools_list_cost([cn])
        # ensure_ascii=True 会把每个汉字变成 \uXXXX 六个字符，
        # 于是这个数字会膨胀到三倍左右。
        naive = len(json.dumps({"description": cn.description})) // 4
        check(
            cost.tokens < naive,
            f"算出来 {cost.tokens} tokens，比 ensure_ascii=True 的估算 {naive} 还大。\n"
            "      `json.dumps` 默认 ensure_ascii=True，把「读」变成 `\\u8bfb` 六个字符。\n"
            "      工具描述全是中文的话，**光这一个默认值就能让数字差三倍**。\n"
            "      而且如果你的 server 真的用默认值序列化，那三倍是**真的在付**",
        )

    await test("★ 中文描述要按 ensure_ascii=False 算（Python 特有）", t_cost_ascii)

    async def t_cost_share() -> None:
        c = tools_list_cost([fake_tool("a", _echo)], 1000)
        check(abs(c.share - c.tokens / 1000) < 1e-9, f"share 算错了：{c.share}")

    await test("share 是相对预算的比例", t_cost_share)

    # ─────────────────────────────────────────────────────────
    print("\n真管道（会 spawn 子进程）")
    # ─────────────────────────────────────────────────────────

    def pipe(lines: list[str]) -> tuple[str, str, int | None]:
        proc = subprocess.run(  # noqa: S603
            [sys.executable, "-m", "l10.server", "--stdio"],
            input="".join(ln + "\n" for ln in lines),
            capture_output=True,
            text=True,
            cwd=ROOT,
            env={**os.environ, "MCP_IMPL": TARGET, "PYTHONIOENCODING": "utf-8"},
            timeout=60,
            check=False,
        )
        return proc.stdout, proc.stderr, proc.returncode

    async def t_stdout_clean() -> None:
        out, err, _ = pipe([line("server/discover"), line("tools/list", {}, 2)])
        rows = [ln for ln in out.split("\n") if ln.strip()]
        check(len(rows) >= 2, f"stdout 应该有两条响应，实际 {len(rows)} 条：{out[:200]}")
        for ln in rows:
            try:
                parsed = json.loads(ln)
            except json.JSONDecodeError:
                raise AssertionError(
                    f"stdout 上有一行不是 JSON：{ln[:80]}\n"
                    "      一句 print() 就能让客户端的拆帧器拿到一行人话。\n"
                    "      症状是「客户端说我的 server 不是 MCP server」——\n"
                    "      和那句 print 隔了十万八千里"
                ) from None
            check(parsed.get("jsonrpc") == "2.0", f"不是 JSON-RPC 消息：{ln[:80]}")
        check(len(err) > 0, "stderr 上应该有启动日志——日志不是不打，是打到 stderr")

    await test("★ stdout 上只有 MCP 消息，日志一律走 stderr", t_stdout_clean)

    async def t_ids_unique() -> None:
        out, _, _ = pipe(
            [
                line(
                    "tools/call",
                    {"name": "search_code", "arguments": {"pattern": "def ", "max_results": 50}},
                    1,
                ),
                line("tools/list", {}, 2),
                line("server/discover", {}, 3),
            ]
        )
        ids = [json.loads(ln)["id"] for ln in out.split("\n") if ln.strip()]
        check(len(ids) == 3, f"应该有 3 条响应，实际 {len(ids)}")
        check(len(set(ids)) == 3, f"id 有重复：{ids}")
        # 顺序不做断言——顺序本来就不保证，断言它才是错的。
        # 这条测的是"每个请求都有且只有一条响应"，而这正是 id 匹配的前提。

    await test("★ 响应靠 id 匹配，不能靠顺序", t_ids_unique)

    async def t_cjk_survives_pipe() -> None:
        # server 会把工具描述（中文）原样回来。走一遍真管道，
        # 增量解码写错的话这里就是 UnicodeDecodeError 或者乱码。
        out, _, _ = pipe([line("tools/list")])
        rows = [ln for ln in out.split("\n") if ln.strip()]
        text = "".join(rows)
        check(
            "\ufffd" not in text,
            "响应里出现了替换字符 U+FFFD——UTF-8 被按字节切坏了。\n"
            "      一个汉字三字节，它可能横跨两次 read()。\n"
            "      要用 codecs.getincrementaldecoder('utf-8')() 跨 chunk 解码，\n"
            "      而这只在数据量大到需要分片时才暴露——本地小消息测不出来",
        )
        check(any("\u4e00" <= c <= "\u9fff" for c in text), "工具描述里的中文没了")

    await test("★ 中文穿过真管道不能变成乱码（Python 特有）", t_cjk_survives_pipe)

    async def t_exit_on_eof() -> None:
        _, _, code = pipe([line("server/discover")])
        check(
            code == 0,
            f"退出码应该是 0，实际 {code}。不退出的话每次重连都留一个僵尸进程",
        )

    await test("stdin 关闭之后 server 要退出（唯一可移植的优雅退出信号）", t_exit_on_eof)

    # ─────────────────────────────────────────────────────────
    print("\n授权（MA-1…15）")
    # ─────────────────────────────────────────────────────────

    from types import SimpleNamespace

    from shared import mcpauth as sa

    if TARGET == "shared":
        ma: Any = sa
    else:
        from l10 import auth as mine_auth

        ma = SimpleNamespace(
            check_access_token=mine_auth.my_check_access_token,
            parse_www_authenticate=mine_auth.my_parse_www_authenticate,
            prm_candidates=mine_auth.my_prm_candidates,
            as_metadata_candidates=mine_auth.my_as_metadata_candidates,
            check_iss_response=mine_auth.my_check_iss_response,
            step_up_scopes=mine_auth.my_step_up_scopes,
            decide_downstream_auth=mine_auth.my_decide_downstream_auth,
            # 这四个是 auth.py 原样转出的参考实现，不是 TODO。
            build_challenge=mine_auth.build_challenge,
            validate_prm=mine_auth.validate_prm,
            validate_as_metadata=mine_auth.validate_as_metadata,
            validate_auth_url=mine_auth.validate_auth_url,
        )

    auth_now = 1_800_000_000
    auth_iss = "https://auth.example.com"
    auth_res = "https://mcp.example.com"
    auth_prm = auth_res + "/.well-known/oauth-protected-resource"

    def auth_opts(required: list[str], **extra: Any) -> sa.CheckOpts:
        # leeway_sec 故意不传：默认值本身也在被测范围里。
        return sa.CheckOpts(
            issuer=auth_iss, resource=auth_res, now=auth_now, required_scopes=required, **extra
        )

    def tok(claims: dict[str, Any] | None = None, header: dict[str, Any] | None = None) -> Any:
        """一张各项都合法的 token；测哪一项就只覆盖哪一项。"""
        return {
            "header": {"typ": "at+jwt", "alg": "RS256", **(header or {})},
            "claims": {
                "iss": auth_iss,
                "aud": auth_res,
                "exp": auth_now + 3600,
                "scope": "files:read",
                "sub": "u1",
                **(claims or {}),
            },
        }

    def auth_verdict(r: Any) -> str:
        return "ok" if r.ok else f"{r.status} {r.reason}"

    read_op = auth_opts(["files:read"])

    async def t_ma1() -> None:
        r = ma.check_access_token(tok({"aud": "https://other.example.com"}), read_op)
        check(
            auth_verdict(r) == "401 WRONG_AUDIENCE",
            f"应该是 401 WRONG_AUDIENCE，实际 {auth_verdict(r)}。\n"
            "      签名对、没过期、scope 也够——但它是发给别的服务的。\n"
            "      收下它，任何一个拿到用户 token 的下游都能拿它回头调你（GHSA-w4fh）",
        )

    await test("★ MA-1 aud 是别的服务 → 401 WRONG_AUDIENCE", t_ma1)

    async def t_ma2() -> None:
        r = ma.check_access_token(tok({"aud": "https://mcp.example.com.evil.io"}), read_op)
        check(
            auth_verdict(r) == "401 WRONG_AUDIENCE",
            f"应该是 401 WRONG_AUDIENCE，实际 {auth_verdict(r)}。\n"
            "      aud 是 str 时 `o.resource in aud` 是子串匹配：\n"
            "      'https://mcp.example.com.evil.io' 包含 'https://mcp.example.com'。\n"
            "      MA-1 过了而这条没过，正是这个 bug 活到生产的方式。\n"
            "      先用 isinstance 规范成 list，再逐个 ==",
        )

    await test("★ MA-2 aud 是 resource 加了后缀的域名 → 仍然 WRONG_AUDIENCE", t_ma2)

    async def t_ma3() -> None:
        ok = ma.check_access_token(tok({"aud": ["https://a", auth_res]}), read_op)
        check(
            ok.ok,
            f"aud 可以是数组（RFC 7519 §4.1.3），含 resource 就该收，实际 {auth_verdict(ok)}",
        )
        empty = ma.check_access_token(tok({"aud": []}), read_op)
        check(
            auth_verdict(empty) == "401 WRONG_AUDIENCE",
            f"aud: [] 应该是 401 WRONG_AUDIENCE，实际 {auth_verdict(empty)}。"
            "空数组不是「不限受众」",
        )

    await test("MA-3 aud 是数组：含 resource → 收；空数组 → WRONG_AUDIENCE", t_ma3)

    async def t_ma4() -> None:
        r = ma.check_access_token(tok({"iss": auth_iss + "/"}), read_op)
        check(
            auth_verdict(r) == "401 WRONG_ISSUER",
            f"应该是 401 WRONG_ISSUER，实际 {auth_verdict(r)}。\n"
            '      RFC 9068："MUST exactly match"。去尾斜杠、小写化这类「宽容」\n'
            "      都是在替攻击者扩大一个等价类",
        )

    await test("★ MA-4 iss 多一个尾斜杠 → WRONG_ISSUER", t_ma4)

    async def t_ma5() -> None:
        id_token = ma.check_access_token(tok({}, {"typ": "JWT"}), read_op)
        check(
            auth_verdict(id_token) == "401 WRONG_TYP",
            f"typ: JWT 应该是 401 WRONG_TYP，实际 {auth_verdict(id_token)}。\n"
            "      ID Token 的 typ 就是 JWT。把它当 access token 收下，\n"
            "      等于任何一个让用户登录过的客户端都能拿登录凭证来调 API",
        )
        none = ma.check_access_token(tok({}, {"alg": "none"}), read_op)
        check(
            auth_verdict(none) == "401 ALG_NONE",
            f"alg: none 应该是 401 ALG_NONE，实际 {auth_verdict(none)}。"
            "签名库配置宽松时会放它过去，这里是第二道闸",
        )
        media = ma.check_access_token(tok({}, {"typ": "application/at+jwt"}), read_op)
        check(
            media.ok,
            f"RFC 9068 允许 typ 写成 application/at+jwt，也要收，实际 {auth_verdict(media)}",
        )

    await test("MA-5 typ 是 JWT（ID Token 冒充）→ WRONG_TYP；alg 是 none → ALG_NONE", t_ma5)

    async def t_ma6() -> None:
        r = ma.check_access_token(
            tok({"exp": auth_now - 3600}), auth_opts(["files:read", "files:write"])
        )
        check(
            auth_verdict(r) == "401 EXPIRED",
            f"应该是 401 EXPIRED，实际 {auth_verdict(r)}。\n"
            "      403 会让客户端去 step-up——弹一个授权页，让用户给一张已经过期的 token 加权限。\n"
            "      401 只需要拿 refresh token 换一张，用户什么都看不到。\n"
            "      所有 401 类检查必须先于 scope",
        )
        foreign = ma.check_access_token(
            tok({"aud": "https://other.example.com", "scope": ""}), auth_opts(["files:write"])
        )
        check(
            auth_verdict(foreign) == "401 WRONG_AUDIENCE",
            "别的服务的 token 且 scope 不足，应该是 401 WRONG_AUDIENCE，"
            f"实际 {auth_verdict(foreign)}。\n"
            "      回 403 等于告诉对方「token 我收了，只是权限不够」",
        )

    await test("★ MA-6 过期且 scope 不足 → 401 EXPIRED，不是 403", t_ma6)

    async def t_ma7() -> None:
        lenient = auth_opts(["files:read"], leeway_sec=60)
        r30 = ma.check_access_token(tok({"exp": auth_now - 30}), lenient)
        check(
            r30.ok,
            f"exp = now - 30、leeway_sec = 60 应该收，实际 {auth_verdict(r30)}。"
            "几十秒的时钟偏差是常态",
        )
        r61 = ma.check_access_token(tok({"exp": auth_now - 61}), lenient)
        check(
            auth_verdict(r61) == "401 EXPIRED",
            f"exp = now - 61 应该是 401 EXPIRED，实际 {auth_verdict(r61)}",
        )
        d30 = ma.check_access_token(tok({"exp": auth_now - 30}), read_op)
        check(
            d30.ok,
            f"不传 leeway_sec 时默认 60：exp = now - 30 应该收，实际 {auth_verdict(d30)}",
        )
        stale = ma.check_access_token(tok({"exp": auth_now - 86_400}), read_op)
        check(
            auth_verdict(stale) == "401 EXPIRED",
            f"不传 leeway_sec 时，过期一天的 token 应该是 401 EXPIRED，实际 {auth_verdict(stale)}",
        )
        early = ma.check_access_token(tok({"nbf": auth_now + 30}), read_op)
        too_early = ma.check_access_token(tok({"nbf": auth_now + 61}), read_op)
        check(
            early.ok and auth_verdict(too_early) == "401 NOT_YET_VALID",
            "nbf 也给 leeway：now + 30 收、now + 61 → 401 NOT_YET_VALID；"
            f"实际 {auth_verdict(early)} / {auth_verdict(too_early)}",
        )

    await test("MA-7 leeway：exp 过了 30 秒还收、61 秒拒；不传 leeway_sec 按 60 算", t_ma7)

    async def t_ma8() -> None:
        need = ["files:read", "files:write"]
        r = ma.check_access_token(tok({"scope": "files:read"}), auth_opts(need))
        check(
            auth_verdict(r) == "403 INSUFFICIENT_SCOPE",
            f"应该是 403 INSUFFICIENT_SCOPE，实际 {auth_verdict(r)}",
        )
        check(r.missing == ["files:write"], f"missing 应该是 ['files:write']，实际 {r.missing}")
        h = ma.build_challenge(r, resource_metadata=auth_prm, required_scopes=need)
        # 用参考实现的解析器读：这条只测 TODO 10，不受 TODO 11 牵连。
        bearer = next((c for c in sa.parse_www_authenticate(h) if c.scheme == "bearer"), None)
        check(bearer is not None, f"挑战头里没有 Bearer：{h}")
        params = bearer.params if bearer else {}
        check(params.get("error") == "insufficient_scope", f"error 应该是 insufficient_scope：{h}")
        check(
            params.get("scope") == "files:read files:write",
            f"scope 应该是 'files:read files:write'（全部所需），实际 {params.get('scope')!r}。\n"
            "      只报缺的那个，照着它重新授权的客户端会丢掉 files:read",
        )
        check(params.get("resource_metadata") == auth_prm, f"resource_metadata 不对：{h}")

    await test("★ MA-8 scope 不够 → 403，挑战里的 scope 是本次操作需要的全部", t_ma8)

    async def t_ma9() -> None:
        implies = {"files:admin": ["files:read", "files:write"]}
        r = ma.check_access_token(
            tok({"scope": "files:admin"}),
            auth_opts(["files:read", "files:write"], implies=implies),
        )
        check(
            r.ok,
            '"Servers MUST account for scope hierarchies"。'
            f"拿着 files:admin 还要再授权一次 files:write，实际 {auth_verdict(r)}",
        )
        up = ma.check_access_token(
            tok({"scope": "files:read files:write"}), auth_opts(["files:admin"], implies=implies)
        )
        check(
            auth_verdict(up) == "403 INSUFFICIENT_SCOPE",
            f"方向反了：窄的不蕴含宽的，read + write 不等于 admin。实际 {auth_verdict(up)}",
        )

    await test("MA-9 scope 层级：files:admin 蕴含 files:read / files:write，反过来不行", t_ma9)

    async def t_ma10() -> None:
        cs = ma.parse_www_authenticate(
            'Basic realm="x", Bearer '
            'resource_metadata="https://m/.well-known/oauth-protected-resource", '
            'error_description="a, b", scope="files:read"'
        )
        schemes = [c.scheme for c in cs]
        check(
            schemes == ["basic", "bearer"],
            f"应该解析出 basic、bearer 两个 challenge，实际 {schemes}。\n"
            "      逗号既分隔 challenge 也分隔参数：\n"
            "      token 后面紧跟 = 的是参数名，否则是下一个 scheme",
        )
        b = cs[1].params
        check(
            b.get("error_description") == "a, b",
            f"error_description 应该是 'a, b'，实际 {b.get('error_description')!r}。"
            "split(',') 把引号里的逗号也切了",
        )
        check(
            b.get("resource_metadata") == "https://m/.well-known/oauth-protected-resource",
            f"resource_metadata 没拿对（{b.get('resource_metadata')!r}）。\n"
            "      拿不到它，客户端只好去猜 well-known；PRM 不在默认位置时发现直接失败",
        )
        check(
            b.get("scope") == "files:read",
            f"scope 应该是 files:read，实际 {b.get('scope')!r}",
        )
        loud = ma.parse_www_authenticate('BEARER Scope="files:write"')
        first = loud[0] if loud else None
        check(
            first is not None
            and first.scheme == "bearer"
            and first.params.get("scope") == "files:write",
            f"auth-scheme 和参数名都不区分大小写，一律小写化。实际 {loud}",
        )
        esc = ma.parse_www_authenticate('Bearer error_description="say \\"hi\\""')
        got = esc[0].params.get("error_description") if esc else None
        check(got == 'say "hi"', f'quoted-string 里的 \\" 是字面的引号，实际 {got!r}')

    await test("★ MA-10 WWW-Authenticate：多个 challenge、引号里的逗号、大小写", t_ma10)

    async def t_ma11() -> None:
        got = ma.prm_candidates("https://example.com/public/mcp", [])
        want = [
            "https://example.com/.well-known/oauth-protected-resource/public/mcp",
            "https://example.com/.well-known/oauth-protected-resource",
        ]
        check(got == want, f'顺序是规范的一部分（"in the order listed above"），实际 {got}')
        hint = [sa.Challenge(scheme="bearer", params={"resource_metadata": auth_prm})]
        hinted = ma.prm_candidates("https://mcp.example.com/mcp", hint)
        check(hinted == [auth_prm], f"挑战里给了 resource_metadata 就只用它，实际 {hinted}")
        for root in ("https://example.com", "https://example.com/"):
            r = ma.prm_candidates(root, [])
            check(
                r == ["https://example.com/.well-known/oauth-protected-resource"],
                f"{root} 只有根这一个候选，实际 {r}。\n"
                "      urlsplit('https://example.com/').path 是 '/'，"
                "直接拼会多出 …/oauth-protected-resource/，去重也跟着失效",
            )

    await test(
        "MA-11 PRM 候选：resource_metadata 优先；否则路径插入 → 根；端点在根上只有一个", t_ma11
    )

    async def t_ma12() -> None:
        got = ma.as_metadata_candidates("https://auth.example.com/tenant1")
        want = [
            "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
            "https://auth.example.com/.well-known/openid-configuration/tenant1",
            "https://auth.example.com/tenant1/.well-known/openid-configuration",
        ]
        check(
            got == want,
            f"实际 {got}。\n"
            "      第 3 个（路径追加）是 Keycloak realm 这类多租户 IdP 唯一发布配置的位置",
        )
        bare = ma.as_metadata_candidates(auth_iss)
        check(
            bare
            == [
                auth_iss + "/.well-known/oauth-authorization-server",
                auth_iss + "/.well-known/openid-configuration",
            ],
            f"issuer 没有路径时只有 OAuth、OIDC 两个，实际 {bare}",
        )

    await test("MA-12 AS 元数据候选：OAuth 插入 → OIDC 插入 → OIDC 追加；无路径只有两个", t_ma12)

    async def t_ma13() -> None:
        s256 = {"code_challenge_methods_supported": ["S256"]}
        spoof = ma.validate_as_metadata(
            {"issuer": "https://honest.example", **s256}, "https://attacker.example"
        )
        check(
            not spoof.ok and spoof.reason == "ISSUER_MISMATCH",
            "从 attacker.example 拿到的文档自称 honest.example，必须 ISSUER_MISMATCH，"
            f"实际 {spoof}。\n"
            "      规范原例；GHSA-qx49 就是主路径查了、回退路径漏了这一条",
        )
        no_pkce = ma.validate_as_metadata({"issuer": auth_iss}, auth_iss)
        check(
            not no_pkce.ok and no_pkce.reason == "NO_PKCE",
            f'没有 code_challenge_methods_supported 时 "MUST refuse to proceed"，实际 {no_pkce}',
        )
        plain = ma.validate_as_metadata(
            {"issuer": auth_iss, "code_challenge_methods_supported": ["plain"]}, auth_iss
        )
        check(
            not plain.ok and plain.reason == "NO_S256",
            f"只有 plain 不算 PKCE 保护，应该 NO_S256，实际 {plain}",
        )
        check(
            ma.validate_as_metadata({"issuer": auth_iss, **s256}, auth_iss).ok,
            "合法的 AS 元数据要放行",
        )
        pub = "https://example.com/public/mcp"
        slash = ma.validate_prm({"resource": pub + "/", "authorization_servers": [auth_iss]}, pub)
        check(
            not slash.ok and slash.reason == "RESOURCE_MISMATCH",
            f'RFC 9728 §3.3：resource 不逐字相等就 "MUST NOT be used"，实际 {slash}',
        )
        empty = ma.validate_prm({"resource": pub, "authorization_servers": []}, pub)
        check(
            not empty.ok and empty.reason == "NO_AUTH_SERVERS",
            f"PRM 必须至少列一个 authorization server，实际 {empty}",
        )
        good = ma.validate_prm({"resource": pub, "authorization_servers": [auth_iss]}, pub)
        check(
            good.ok and good.auth_servers == [auth_iss],
            f"合法的 PRM 要放行，实际 {good}",
        )

    await test("★ MA-13 AS 元数据：issuer 逐字相等、必须声明 S256；PRM：resource 逐字相等", t_ma13)

    async def t_ma14() -> None:
        rec = "https://as.example.com"
        rows: list[tuple[bool | None, str | None, str]] = [
            (True, rec, "proceed"),
            (True, rec + "/", "reject"),
            (True, None, "reject"),
            (False, rec, "proceed"),
            (False, "https://evil.example", "reject"),
            (False, None, "proceed"),
            (None, rec, "proceed"),
            (None, None, "proceed"),
        ]
        for supports, iss, want in rows:
            got = ma.check_iss_response(supports_iss=supports, iss=iss, recorded=rec)
            check(
                got == want,
                f"supports_iss={supports}、iss={iss or '（没有）'} 应该 {want}，实际 {got}",
            )
        folded = ma.check_iss_response(
            supports_iss=True, iss="https://AS.example.com", recorded=rec
        )
        check(
            folded == "reject",
            f"iss 'https://AS.example.com' 对记录的 '{rec}' 应该 reject，实际 {folded}。\n"
            '      "MUST NOT apply scheme or host case folding"——\n'
            "      「先小写化再比更健壮」恰好造出了一个可被利用的等价类",
        )

    await test("MA-14 授权响应的 iss：四行真值表，一律逐字比较", t_ma14)

    async def t_ma15() -> None:
        up = ma.step_up_scopes(["files:read"], ["files:write"])
        check(
            up == ["files:read", "files:write"],
            f"应该是 ['files:read', 'files:write']（并集），实际 {up}。\n"
            "      直接换成挑战里的 scope：拿到写权限、丢了读权限，\n"
            "      下一次列目录又是 403、又一个授权页",
        )
        dedup = ma.step_up_scopes(["files:write", "files:read"], ["files:read"])
        check(dedup == ["files:read", "files:write"], f"要去重、按码点排序，实际 {dedup}")

        api = "https://api.example.com"
        base: dict[str, Any] = {
            "inbound_raw": "tok-in",
            "outbound_raw": "tok-out",
            "self_uri": auth_res,
            "downstream": api,
        }
        echoed = ma.decide_downstream_auth(
            **{**base, "outbound_raw": "tok-in"}, outbound_aud=auth_res
        )
        check(
            echoed == "PASSTHROUGH",
            f"把收到的 token 原样发给下游应该是 PASSTHROUGH，实际 {echoed}。"
            '"MUST NOT pass through"',
        )
        resigned = ma.decide_downstream_auth(**base, outbound_aud=[auth_res, api])
        check(
            resigned == "PASSTHROUGH",
            f"出站 token 的 aud 里还有自己，也是透传——下游拿着它能回头调你。实际 {resigned}",
        )
        stray = ma.decide_downstream_auth(**base, outbound_aud="https://other.example.com")
        check(
            stray == "WRONG_AUDIENCE",
            f"出站 token 的 aud 里没有这个下游，应该是 WRONG_AUDIENCE，实际 {stray}",
        )
        fine = ma.decide_downstream_auth(**base, outbound_aud=api)
        check(fine == "OK", f"换来的、aud 恰好是下游的 token 应该放行，实际 {fine}")

        urls = [
            ("file:/c:/windows/system32/calc.exe", "BAD_SCHEME"),
            ("http://auth.example.com/authorize", "HTTP_NOT_LOOPBACK"),
            ("http://127.0.0.1@evil.example/authorize", "HTTP_NOT_LOOPBACK"),
            ("http://127.0.0.1:8123/authorize", "ok"),
            ("https://auth.example.com/authorize", "ok"),
        ]
        for url, want in urls:
            v = ma.validate_auth_url(url)
            got = "ok" if v.ok else v.reason
            check(
                got == want,
                f"{url} 应该是 {want}，实际 {got}。\n"
                "      授权 URL 来自可能恶意的 server：\n"
                "      只许 https 或 loopback 的 http（CVE-2025-6514）",
            )

    await test("★ MA-15 step-up 取并集；下游不许透传；授权 URL 走白名单", t_ma15)

    # ─────────────────────────────────────────────────────────

    print("\n" + "─" * 60)
    if not failures:
        print(f"\033[32m全过。{passed} 项。\033[0m")
        print("\n接着跑 MCP_IMPL=mine uv run python -m l10.client"
              " —— 用你自己的 server 走一遍真管道。")
    else:
        print(f"\033[31m{len(failures)} 项没过（过了 {passed} 项）：\033[0m")
        for f in failures:
            print(f"\033[31m  · {f}\033[0m")
        print("\n先跑 VERIFY_TARGET=shared uv run python -m l10.verify 对照参考实现。")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
