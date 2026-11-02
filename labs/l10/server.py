"""L10 任务一（Python 版）：手写一个 MCP server。

    uv run python -m l10.server              观察实验
    uv run python -m l10.server --stdio      真的作为 stdio server 跑

任务说明在 l10/server.ts，两边都做的话先读那份。这里只标 Python 特有的坑。

★ 而这一节的 Python 坑格外多，因为它们全部集中在**进程 IO** 上——
Python 和 Node 差别最大的地方就是这里。四个都会真的让你的 server
"看起来启动了但没反应"：

  1. **stdout 是块缓冲的。** 管道不是 tty，`write()` 之后不 `flush()`
     数据就压在缓冲区里等第 4096 个字节。客户端等一个永远不来的响应，
     而 server 那边一切正常——它甚至觉得自己回过了。

  2. **`print()` 一次就废。** 和 TS 一样，但 Python 里更容易手滑，
     因为调试时随手 print 是肌肉记忆。

  3. **增量解码。** `read1()` 返回 bytes，而一个汉字三字节，
     它可能横跨两次 read。直接 `.decode()` 抛 UnicodeDecodeError，
     而且**只在数据量大到需要分片时才抛**——本地小消息测不出来。

  4. **`read1` 而不是 `read`。** `read(n)` 会阻塞到攒够 n 字节或 EOF；
     对一个还活着的管道，这是死锁。`read1(n)` 有多少给多少。
"""

from __future__ import annotations

import asyncio
import codecs
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, TextIO

from shared.context_budget import estimate_tokens
from shared.mcp import (
    ERR_INTERNAL,
    ERR_INVALID_PARAMS,
    ERR_INVALID_REQUEST,
    ERR_METHOD_NOT_FOUND,
    ERR_PARSE,
    ERR_UNSUPPORTED_VERSION,
    META_CLIENT_CAPS,
    META_CLIENT_INFO,
    META_SERVER_INFO,
    META_VERSION,
    PROTOCOL_VERSION,
    SUPPORTED_VERSIONS,
    McpServer,
    McpTool,
    Request,
    RpcError,
    ToolOutcome,
    Validated,
)
from shared.mcp import serve_stdio as shared_serve_stdio
from shared.mcp import wrap_tool_def as shared_wrap_tool
from shared.toolbox import standard_tools
from shared.tools import ToolDef

ROOT = str(Path(__file__).resolve().parent.parent)


# ─────────────────────────────────────────────────────────────
# TODO 1：NDJSON 拆帧
#
# Python 特有：没有。这一条两边一模一样。
# 而"两边一模一样"本身是个信号——**它说明这个坑属于管道，不属于语言。**
# ─────────────────────────────────────────────────────────────


class Framer:
    def __init__(self, max_line_chars: int = 8 * 1024 * 1024) -> None:
        self._buf = ""
        self._max = max_line_chars

    def push(self, chunk: str) -> list[str]:
        raise NotImplementedError("TODO: 实现 Framer.push")

    @property
    def buffered(self) -> int:
        return len(self._buf)


# ─────────────────────────────────────────────────────────────
# TODO 2：请求校验
#
# ★ Python 特有的一个真陷阱：**`isinstance(True, int)` 是 True。**
#
# `{"id": true}` 会被当成合法的整数 id。更糟的是 `hash(True) == hash(1)`，
# 所以它在 pending 字典里和 id=1 **是同一个键**——一个响应会 resolve
# 另一个请求。TS 那边没有这个陷阱（typeof true === 'boolean'）。
#
# 排掉它：`isinstance(x, str | int) and not isinstance(x, bool)`
# ─────────────────────────────────────────────────────────────


def validate_request(raw: str) -> Validated:
    raise NotImplementedError("TODO: 实现 validate_request")


# ─────────────────────────────────────────────────────────────
# TODO 3：把 L04 的工具包成 MCP 工具
#
# Python 特有：`McpTool.run` 是一个 async 可调用对象，不是方法。
# 用闭包包一层。注意闭包捕获的是**变量**不是值——在循环里建工具时，
# `for d in defs: tools.append(McpTool(run=lambda a: d.run(a)))`
# 会让所有工具都指向最后一个 d。这是 Python 里最经典的闭包坑之一，
# 而它的表现是"所有工具都执行同一个操作"。
#
# 写成独立函数（像下面这样接收 defn 参数）就不会踩。
# ─────────────────────────────────────────────────────────────


def wrap_tool(defn: ToolDef) -> McpTool:
    raise NotImplementedError("TODO: 实现 wrap_tool")


def build_server(root: str, wrap: Any = None) -> McpServer:
    wrap = wrap or wrap_tool
    tools = [wrap(d) for d in standard_tools(root)]
    return McpServer(name="labs-toolbox", version="0.1.0", tools=tools)


# ─────────────────────────────────────────────────────────────
# TODO 4 / 5：路由与两种错误
#
# ★ Python 特有：`except Exception` **抓不到 CancelledError**
# （它从 3.8 起继承 BaseException）。这是好事——取消不该被当成
# 工具失败回给模型。但有人会写 `except BaseException`，那就把取消
# 吞成了 -32603，而客户端那边已经不在等这个响应了。
#
# 所以顺序是：先 `except asyncio.CancelledError: raise`，再 `except Exception`。
# ─────────────────────────────────────────────────────────────


async def route_request(server: McpServer, req: Request) -> dict[str, Any] | None:
    raise NotImplementedError("TODO: 实现 route_request")


async def call_tool(server: McpServer, req_id: str | int, params: dict[str, Any]) -> dict[str, Any]:
    raise NotImplementedError("TODO: 实现 call_tool")


# ─────────────────────────────────────────────────────────────
# TODO 6：上下文税
#
# ★ Python 特有：`json.dumps` 默认 `ensure_ascii=True`，会把每个汉字
# 转成 `\uXXXX` 六个字符。工具描述全是中文的话，**光这一个默认值
# 就能让你算出来的 token 数差三倍**。
#
# 而且这不只是"算得不准"——如果你的 server 真的用默认值序列化，
# 那三倍是**真的在付**。
#
# 另一个默认值是分隔符：`json.dumps` 默认输出 `", "` 和 `": "`，
# 而线上那份（上面的 Framer）和 TS 的 JSON.stringify 都是紧凑的。
# 要算的是真正发出去的那份，所以用 `separators=(",", ":")`。
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ToolsCost:
    tools: int
    tokens: int
    share: float


def tools_list_cost(tools: list[McpTool], budget_tokens: int = 200_000) -> ToolsCost:
    raise NotImplementedError("TODO: 实现 tools_list_cost")


# ─────────────────────────────────────────────────────────────
# TODO 7：stdio 主循环
#
# 见文件头那四条。最容易漏的是 flush——**它不报错，只是不工作**。
#
# 骨架：
#   decoder = codecs.getincrementaldecoder("utf-8")()
#   while True:
#       chunk = await asyncio.to_thread(stdin.read1, 65536)
#       if not chunk: break
#       for line in framer.push(decoder.decode(chunk)):
#           ...派发...
#
# ★ 还有一个 asyncio 特有的：**`create_task` 的返回值必须存下来。**
# 事件循环只对 task 持弱引用，不存的话它可能在跑完之前被 GC 掉。
# 表现是"某些请求偶尔没有响应"，而且和负载相关——最难复现的那一类。
# ─────────────────────────────────────────────────────────────


async def run_stdio(
    server: McpServer,
    *,
    stdin: BinaryIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> None:
    raise NotImplementedError("TODO: 实现 run_stdio")


# ─────────────────────────────────────────────────────────────
# 观察实验
# ─────────────────────────────────────────────────────────────


def _meta(version: str = PROTOCOL_VERSION) -> dict[str, Any]:
    return {
        META_VERSION: version,
        META_CLIENT_INFO: {"name": "demo", "version": "0"},
        META_CLIENT_CAPS: {},
    }


def _line(method: str, params: dict[str, Any] | None = None, req_id: int | None = 1) -> str:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method, "params": params or {}}
    if req_id is not None:
        msg["id"] = req_id
    return json.dumps(msg, ensure_ascii=False)


async def demo_round_trip() -> None:
    print("\n【一】一次完整的往返：请求进去，响应出来")

    server = build_server(ROOT)
    raw = _line("tools/list", {"_meta": _meta()})
    print(f"  → {raw[:96]}…")

    v = validate_request(raw)
    assert v.ok and v.req is not None
    resp = await route_request(server, v.req)
    assert resp is not None and "result" in resp
    tools = resp["result"]["tools"]

    print(f"  ← 200 OK，{len(tools)} 个工具：{'、'.join(t['name'] for t in tools)}")
    print(f"     serverInfo：{json.dumps(resp['result']['_meta'], ensure_ascii=False)}")
    print("\n  ★ 就这些。没有模型，没有 embedding，没有魔法——")
    print("  JSON-RPC 2.0 加一层命名约定。MCP 的技术含量约等于零，")
    print("  而它值钱是因为**说这话的人足够多**。")


def demo_framing() -> None:
    print("\n【二】拆帧：管道不承诺消息边界")

    a = _line("tools/list", {"_meta": _meta()}, 1)
    b = _line("server/discover", {"_meta": _meta()}, 2)
    wire = a + "\n" + b + "\n"

    framer = Framer()
    got: list[str] = []
    counts: list[int] = []
    for i in range(0, len(wire), 17):
        lines = framer.push(wire[i : i + 17])
        counts.append(len(lines))
        got.extend(lines)

    print(f"  两条消息共 {len(wire)} 字符，按 17 个一片喂进去（{len(counts)} 片）")
    print(f"  每片吐出的完整消息数：{''.join(str(c) for c in counts)}")
    print(f"  最终拿到 {len(got)} 条完整消息，缓冲区剩 {framer.buffered} 字符")
    print("\n  ★ 注意那串 0：绝大多数片什么都吐不出来。")
    print("  不拆帧的代码在本地「能跑」，是因为本地消息小、来得慢，")
    print("  每次 read 恰好是一整行。等到某个工具返回 80KB 才炸。")


def demo_meta_validation() -> None:
    print("\n【三】_meta 校验：2026-07-28 把握手换成了每请求自带")

    def envelope(req_id: Any, meta: dict[str, Any]) -> str:
        msg = {"jsonrpc": "2.0", "id": req_id, "method": "tools/list", "params": {"_meta": meta}}
        return json.dumps(msg)

    no_version = envelope(1, {META_CLIENT_CAPS: {}})
    null_id = envelope(None, _meta())
    bool_id = envelope(True, _meta())

    cases: list[tuple[str, str]] = [
        ("缺 protocolVersion", no_version),
        ("缺 clientCapabilities", _line("tools/list", {"_meta": {META_VERSION: PROTOCOL_VERSION}})),
        ("版本是 2025 年的", _line("tools/list", {"_meta": _meta("2025-06-18")})),
        ("id 是 null", null_id),
        ("id 是 True（Python 特有）", bool_id),
        ("根本不是 JSON", "server started on port 3000"),
        ("合法请求", _line("tools/list", {"_meta": _meta()})),
    ]

    for label, raw in cases:
        v = validate_request(raw)
        if v.ok:
            print(f"  {label:<26} → 通过（id={v.req.id if v.req else None!r}）")
        else:
            assert v.error is not None
            extra = f"  data={json.dumps(v.error.data, ensure_ascii=False)}" if v.error.data else ""
            print(f"  {label:<26} → {v.error.code}  {v.error.message}{extra}")

    print("\n  ★ 看「版本是 2025 年的」那条的 data。带上 supported 列表，")
    print("  客户端能自动降版本重试；不带的话它只能报错给用户，而用户不知道该怎么办。")
    print("\n  ★ 看「id 是 True」那条——这是 Python 独有的。`isinstance(True, int)` 为真，")
    print("  而且 `hash(True) == hash(1)`，所以它在 pending 字典里和 id=1 是同一个键。")


async def demo_two_errors() -> None:
    print("\n【四】两种错误：判据是「模型改一改还有救吗」")

    server = build_server(ROOT)
    cases: list[tuple[str, dict[str, Any]]] = [
        ("读一个不存在的文件", {"name": "read_file", "arguments": {"path": "nope/missing.py"}}),
        ("参数类型不对", {"name": "read_file", "arguments": {"path": 123}}),
        ("正则语法错误", {"name": "search_code", "arguments": {"pattern": "([unclosed"}}),
        ("工具名不存在", {"name": "read_fille", "arguments": {"path": "x"}}),
        ("arguments 不是对象", {"name": "read_file", "arguments": ["x"]}),
    ]

    for label, params in cases:
        resp = await call_tool(server, 1, params)
        if "error" in resp:
            e = resp["error"]
            print(f"  {label:<22} 协议错误  {e['code']}  {e['message'][:40]}")
        else:
            r = resp["result"]
            text = r["content"][0]["text"].replace("\n", " ")[:40]
            print(f"  {label:<22} 执行错误  isError={r['isError']}  {text}")

    print("\n  ★ 前三条是模型能自己改对的，所以它们进 result，会被喂回模型。")
    print("  后两条是客户端和服务端对不齐，模型改参数也没用，所以进 error。")


def demo_context_tax() -> None:
    print("\n【五】上下文税：加一行配置，每轮多付多少")

    server = build_server(ROOT)
    one = tools_list_cost(server.tools)

    share = f"{one.share * 100:.2f}"
    print(f"  我们这个 server：{one.tools} 个工具，{one.tokens} token，占 200k 的 {share}%")

    # ★ 同一份工具清单，两种 ensure_ascii 的字节数差多少。
    payload = [
        {"name": t.name, "description": t.description, "inputSchema": t.input_schema}
        for t in server.tools
    ]
    loose = estimate_tokens(json.dumps(payload, ensure_ascii=False))
    strict = estimate_tokens(json.dumps(payload, ensure_ascii=True))
    print(f"\n  ensure_ascii=False：{loose} token")
    print(f"  ensure_ascii=True ：{strict} token   ← 默认值")
    print(f"  差 {strict / max(loose, 1):.1f} 倍。**而这个默认值是 Python 的，不是 MCP 的。**")

    print("\n  按真实数据外推（2026 年社区实测）：")
    print("    server 数   工具数   token     占 200k")
    print("    ─────────  ──────  ────────  ────────")
    rows = [(1, 3, one.tokens), (1, 27, 18_000), (5, 100, 55_000), (7, 140, 67_300)]
    for servers, tools, tokens in rows:
        print(f"    {servers:>6}   {tools:>6}   {tokens:>7}   {tokens / 200_000 * 100:>5.1f}%")

    print("\n  最后一行：**在用户打第一个字之前，三分之一的窗口已经没了。**")


async def main() -> None:
    if "--stdio" in sys.argv:
        mine = os.environ.get("MCP_IMPL") == "mine"
        server = build_server(ROOT, wrap_tool if mine else shared_wrap_tool)

        # TODO 9 用：打开它，看一行 print 怎么废掉整条连接。
        if os.environ.get("MCP_POLLUTE_STDOUT") == "1":
            print(f"[{server.name}] started, {len(server.tools)} tools ready", flush=True)

        if mine:
            await run_stdio(server)
        else:
            await shared_serve_stdio(server)
        return

    print("═" * 64)
    print("L10 · MCP server（Python）：JSON-RPC 2.0 加一层约定")
    print("═" * 64)

    await demo_round_trip()
    demo_framing()
    demo_meta_validation()
    await demo_two_errors()
    demo_context_tax()

    print("\n" + "─" * 64)
    print("接着跑 uv run python -m l10.client —— 那边会真的 spawn 一个子进程。")
    print("─" * 64 + "\n")


if __name__ == "__main__":
    asyncio.run(main())
