"""参考实现：MCP 协议层（2026-07-28）。

对应 shared/mcp.ts。工程决策的理由都写在那边，这里只标 Python 特有的坑——
而这一节的 Python 坑格外多，因为它们全部集中在**进程 IO** 上，
而进程 IO 恰好是 Python 和 Node 差别最大的地方。

四个会真的咬人的：

  1. **stdout 是块缓冲的。** 管道不是 tty，`write()` 之后不 `flush()`
     数据就压在缓冲区里。客户端等一个永远不来的响应。
  2. **`print()` 一次就废。** 和 TS 一样，但 Python 里更容易手滑——
     调试时随手 print 是肌肉记忆。
  3. **增量解码。** `bytes.decode()` 在多字节字符被切开的地方会抛
     UnicodeDecodeError。要用 `codecs.getincrementaldecoder`。
  4. **Windows 默认编码不是 UTF-8。** 中文工具描述会在 encode 时炸。
"""

from __future__ import annotations

import asyncio
import codecs
import json
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, BinaryIO, TextIO

from shared.context_budget import estimate_tokens
from shared.tools import ToolDef

# ─────────────────────────────────────────────────────────────
# 协议常量
# ─────────────────────────────────────────────────────────────

PROTOCOL_VERSION = "2026-07-28"
SUPPORTED_VERSIONS = [PROTOCOL_VERSION]

META_VERSION = "io.modelcontextprotocol/protocolVersion"
META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo"
META_CLIENT_CAPS = "io.modelcontextprotocol/clientCapabilities"
META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"

ERR_PARSE = -32700
ERR_INVALID_REQUEST = -32600
ERR_METHOD_NOT_FOUND = -32601
ERR_INVALID_PARAMS = -32602
ERR_INTERNAL = -32603
ERR_MISSING_CAPABILITY = -32021
ERR_UNSUPPORTED_VERSION = -32022


# ─────────────────────────────────────────────────────────────
# 一、拆帧
# ─────────────────────────────────────────────────────────────


def encode_message(msg: Any) -> str:
    """序列化一条消息，末尾加换行。

    ★ `ensure_ascii=False` 在这里是有意的：默认的 True 会把中文转成
    `\\uXXXX`，一个汉字六个字符。工具描述里全是中文的话，
    **光这一个默认值就能让 tools/list 的字节数翻三倍**。

    转义本身不影响正确性（两边都是合法 JSON），影响的是你为
    每一轮上下文付的钱。而这笔钱不会出现在任何地方，除了账单。
    """
    line = json.dumps(msg, ensure_ascii=False, separators=(",", ":"))
    if "\n" in line:
        raise ValueError("消息里有内嵌换行，会破坏 NDJSON 拆帧")
    return line + "\n"


class Framer:
    """NDJSON 拆帧器。管道只承诺字节顺序，不承诺消息边界。"""

    def __init__(self, max_line_chars: int = 8 * 1024 * 1024) -> None:
        self._buf = ""
        self._max = max_line_chars

    def push(self, chunk: str) -> list[str]:
        self._buf += chunk
        if len(self._buf) > self._max:
            self._buf = ""
            raise ValueError(
                f"单条消息超过 {self._max} 字符还没遇到换行，对面大概率不是 MCP server"
            )
        parts = self._buf.split("\n")
        self._buf = parts.pop()
        return [p for p in parts if p.strip()]

    @property
    def buffered(self) -> int:
        return len(self._buf)


# ─────────────────────────────────────────────────────────────
# 二、请求校验
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RpcError:
    code: int
    message: str
    data: Any = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.data is not None:
            out["data"] = self.data
        return out


@dataclass(frozen=True)
class Request:
    method: str
    params: dict[str, Any]
    #  None 表示这是一个通知。**通知不许回响应。**
    id: str | int | None = None


@dataclass(frozen=True)
class Validated:
    ok: bool
    req: Request | None = None
    error: RpcError | None = None
    #  校验失败时用来定位回哪个 id。读不出来就是 None。
    id: str | int | None = None


def validate_request(raw: str) -> Validated:
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError as err:
        return Validated(False, error=RpcError(ERR_PARSE, f"JSON 解析失败：{err}"))

    if not isinstance(msg, dict):
        return Validated(False, error=RpcError(ERR_INVALID_REQUEST, "消息必须是一个 JSON 对象"))

    raw_id = msg.get("id")
    # ★ `isinstance(True, int)` 在 Python 里是 True。不排掉 bool 的话
    # `{"id": true}` 会被当成合法 id，然后在 dict 里和 id=1 撞成同一个键
    # ——因为 `hash(True) == hash(1)`。TS 那边没有这个陷阱。
    msg_id = raw_id if isinstance(raw_id, str | int) and not isinstance(raw_id, bool) else None

    def bad(code: int, message: str, data: Any = None, *, with_id: bool = True) -> Validated:
        return Validated(False, id=msg_id if with_id else None, error=RpcError(code, message, data))

    if msg.get("jsonrpc") != "2.0":
        return bad(ERR_INVALID_REQUEST, f'jsonrpc 必须是 "2.0"，收到 {msg.get("jsonrpc")!r}')

    method = msg.get("method")
    if not isinstance(method, str) or method == "":
        return bad(ERR_INVALID_REQUEST, "method 必须是非空字符串")

    if "id" in msg and msg["id"] is None:
        return bad(ERR_INVALID_REQUEST, "id 不能是 null（通知请直接省略 id）", with_id=False)

    params = msg.get("params")
    params = params if isinstance(params, dict) else {}
    meta = params.get("_meta")
    meta = meta if isinstance(meta, dict) else {}

    is_notification = "id" not in msg
    if not is_notification:
        version = meta.get(META_VERSION)
        if not isinstance(version, str):
            return bad(ERR_INVALID_PARAMS, f'缺少必填的 _meta["{META_VERSION}"]')
        if version not in SUPPORTED_VERSIONS:
            return bad(
                ERR_UNSUPPORTED_VERSION,
                f"不支持的协议版本 {version}",
                {"supported": SUPPORTED_VERSIONS, "requested": version},
            )
        if not isinstance(meta.get(META_CLIENT_CAPS), dict):
            return bad(ERR_INVALID_PARAMS, f'缺少必填的 _meta["{META_CLIENT_CAPS}"]')

    req = Request(method=method, params=params, id=None if is_notification else msg_id)
    return Validated(True, req=req)


# ─────────────────────────────────────────────────────────────
# 三、服务端
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ToolOutcome:
    text: str
    is_error: bool = False
    structured: Any = None


@dataclass
class McpTool:
    name: str
    description: str
    input_schema: dict[str, Any]
    run: Callable[[dict[str, Any]], Awaitable[ToolOutcome]]
    output_schema: dict[str, Any] | None = None


@dataclass
class McpServer:
    name: str
    version: str
    tools: list[McpTool] = field(default_factory=list)


def wrap_tool_def(defn: ToolDef) -> McpTool:
    """把 L04 的 ToolDef 适配成 MCP 工具。理由见 shared/mcp.ts。

    ★ `log_note` 不进 content。它的内容是「拒绝了一次越界访问 ../../etc/passwd」
    这种东西——回给模型等于把沙箱的边界告诉了可能正在探边界的那一方。
    """

    async def run(args: dict[str, Any]) -> ToolOutcome:
        parsed = defn.parse(args)
        if not parsed.ok:
            return ToolOutcome(text=parsed.message, is_error=True)
        r = await defn.run(parsed.input)
        return ToolOutcome(text=r.content, is_error=r.is_error)

    return McpTool(
        name=defn.name,
        description=defn.description,
        input_schema=defn.input_schema,
        run=run,
    )


def tool_descriptor(t: McpTool) -> dict[str, Any]:
    out: dict[str, Any] = {
        "name": t.name,
        "description": t.description,
        "inputSchema": t.input_schema,
    }
    if t.output_schema is not None:
        out["outputSchema"] = t.output_schema
    return out


def _ok(req_id: str | int, server: McpServer, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "result": {
            "resultType": "complete",
            **result,
            "_meta": {META_SERVER_INFO: {"name": server.name, "version": server.version}},
        },
    }


def _fail(req_id: str | int | None, code: int, message: str, data: Any = None) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": req_id, "error": err}


async def handle_request(server: McpServer, req: Request) -> dict[str, Any] | None:
    if req.id is None:
        return None

    params = req.params

    if req.method == "server/discover":
        return _ok(
            req.id,
            server,
            {
                "supportedVersions": SUPPORTED_VERSIONS,
                "capabilities": {"tools": {"listChanged": False}},
            },
        )

    if req.method == "tools/list":
        ordered = sorted(server.tools, key=lambda t: t.name)
        return _ok(req.id, server, {"tools": [tool_descriptor(t) for t in ordered]})

    if req.method == "tools/call":
        return await _call_tool(server, req.id, params)

    return _fail(req.id, ERR_METHOD_NOT_FOUND, f"未知方法：{req.method}")


async def _call_tool(
    server: McpServer, req_id: str | int, params: dict[str, Any]
) -> dict[str, Any]:
    name = params.get("name")
    if not isinstance(name, str):
        return _fail(req_id, ERR_INVALID_PARAMS, "params.name 必须是字符串")

    tool = next((t for t in server.tools if t.name == name), None)
    if tool is None:
        available = {"available": [t.name for t in server.tools]}
        return _fail(req_id, ERR_INVALID_PARAMS, f"未知工具：{name}", available)

    raw_args = params.get("arguments")
    if raw_args is not None and not isinstance(raw_args, dict):
        return _fail(req_id, ERR_INVALID_PARAMS, "params.arguments 必须是一个对象")

    try:
        outcome = await tool.run(raw_args or {})
    except asyncio.CancelledError:
        # ★ Python 用异常实现取消。裸 `except Exception` 抓不到它
        # （CancelledError 从 3.8 起继承 BaseException），但**顺序仍然重要**：
        # 有人会写成 `except BaseException`，那就把取消吞成了 -32603，
        # 而客户端已经不在等这个响应了。
        raise
    except Exception as err:  # noqa: BLE001 —— 工具的 bug 不该拖垮整个 server
        return _fail(req_id, ERR_INTERNAL, f"工具 {name} 抛异常：{err}")

    result: dict[str, Any] = {
        "content": [{"type": "text", "text": outcome.text}],
        "isError": outcome.is_error,
    }
    if outcome.structured is not None:
        result["structuredContent"] = outcome.structured
    return _ok(req_id, server, result)


# ─────────────────────────────────────────────────────────────
# 四、stdio 传输
# ─────────────────────────────────────────────────────────────


async def serve_stdio(
    server: McpServer,
    *,
    stdin: BinaryIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> None:
    """在 stdio 上跑一个 server，直到 stdin 关闭。

    ★ 四个 Python 特有的地方，每一个都足以让 server "看起来启动了但没反应"：

    **一 · flush。** 管道上的 stdout 是块缓冲（4KB 或 8KB）。
    写完一行响应不 flush，它就压在缓冲区里等第 4096 个字节。
    症状是客户端超时，而 server 那边一切正常——它甚至觉得自己回过了。

    **二 · 增量解码。** `read1()` 返回的是 bytes，而一个汉字三字节，
    它可能横跨两次 read。直接 `.decode()` 会抛 UnicodeDecodeError，
    而且**只在数据量大到需要分片时才抛**——本地小消息测不出来。

    **三 · `read1` 而不是 `read`。** `read(n)` 会阻塞到攒够 n 个字节
    或者 EOF；对一个还活着的管道，这是死锁。`read1(n)` 有多少给多少。

    **四 · 编码。** Windows 上 `sys.stdout` 默认可能是 cp936，
    中文工具描述 encode 时抛 UnicodeEncodeError。显式 reconfigure。
    """
    stdin_b = stdin if stdin is not None else sys.stdin.buffer
    out = stdout if stdout is not None else sys.stdout
    log_to = stderr if stderr is not None else sys.stderr

    reconfigure = getattr(out, "reconfigure", None)
    if reconfigure is not None:
        reconfigure(encoding="utf-8", newline="\n")

    def log(s: str) -> None:
        print(f"[{server.name}] {s}", file=log_to, flush=True)

    framer = Framer()
    decoder = codecs.getincrementaldecoder("utf-8")()
    tasks: set[asyncio.Task[None]] = set()

    log(f"listening on stdio, protocol {PROTOCOL_VERSION}, {len(server.tools)} tools")

    def write(msg: Any) -> None:
        out.write(encode_message(msg))
        out.flush()  # ← 少这一行，整个 server 静默失效

    async def dispatch(v: Validated) -> None:
        assert v.req is not None
        try:
            resp = await handle_request(server, v.req)
        except Exception as err:  # noqa: BLE001
            log(f"handler crashed: {err}")
            if v.req.id is not None:
                write(_fail(v.req.id, ERR_INTERNAL, str(err)))
            return
        if resp is not None:
            write(resp)

    while True:
        # 阻塞读丢进线程，主循环还能跑已经派发出去的任务。
        chunk = await asyncio.to_thread(stdin_b.read1, 65536)
        if not chunk:
            break
        try:
            lines = framer.push(decoder.decode(chunk))
        except ValueError as err:
            log(f"framer: {err}")
            continue

        for line in lines:
            v = validate_request(line)
            if not v.ok:
                assert v.error is not None
                if v.id is not None:
                    write(_fail(v.id, v.error.code, v.error.message, v.error.data))
                else:
                    log(f"丢弃无法定位 id 的坏消息：{v.error.message}")
                continue
            task = asyncio.create_task(dispatch(v))
            # ★ 不存引用的话 task 可能被 GC 掉——asyncio 只持弱引用。
            # 表现是"某些请求偶尔没有响应"，且和负载相关。
            tasks.add(task)
            task.add_done_callback(tasks.discard)

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    log("stdin closed, exiting")


# ─────────────────────────────────────────────────────────────
# 五、客户端
# ─────────────────────────────────────────────────────────────


class RpcCallError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.data = data


class McpClient:
    """传输无关的客户端核心。只要一个 `send`。"""

    def __init__(
        self,
        send: Callable[[str], None],
        *,
        client_info: dict[str, Any] | None = None,
        capabilities: dict[str, Any] | None = None,
        protocol_version: str = PROTOCOL_VERSION,
    ) -> None:
        self._send = send
        self._client_info = client_info or {"name": "labs-client", "version": "0.1.0"}
        self._capabilities = capabilities if capabilities is not None else {}
        self._version = protocol_version
        self._next_id = 1
        self._pending: dict[str | int, asyncio.Future[dict[str, Any]]] = {}

    def _with_meta(self, params: dict[str, Any]) -> dict[str, Any]:
        meta = dict(params.get("_meta") or {})
        meta[META_VERSION] = self._version
        meta[META_CLIENT_INFO] = self._client_info
        meta[META_CLIENT_CAPS] = self._capabilities
        return {**params, "_meta": meta}

    def request(
        self, method: str, params: dict[str, Any] | None = None
    ) -> asyncio.Future[dict[str, Any]]:
        req_id = self._next_id
        self._next_id += 1
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        self._send(
            encode_message(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "method": method,
                    "params": self._with_meta(params or {}),
                }
            )
        )
        return fut

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self._send(encode_message({"jsonrpc": "2.0", "method": method, "params": params or {}}))

    def receive(self, line: str) -> None:
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as err:
            msg = f"收到非 JSON 的一行（对面往 stdout 写了东西？）：{line[:120]}"
            raise ValueError(msg) from err
        if not isinstance(msg, dict):
            return
        msg_id = msg.get("id")
        if msg_id is None:
            return
        fut = self._pending.pop(msg_id, None)
        if fut is None or fut.done():
            return
        if "error" in msg:
            e = msg["error"]
            fut.set_exception(
                RpcCallError(e.get("code", ERR_INTERNAL), e.get("message", ""), e.get("data"))
            )
        else:
            fut.set_result(msg.get("result") or {})

    def fail_all(self, reason: str) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError(reason))
        self._pending.clear()

    @property
    def pending(self) -> int:
        return len(self._pending)


# ─────────────────────────────────────────────────────────────
# 六、上下文税
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ToolsCost:
    tools: int
    tokens: int
    share: float


def tools_list_cost(tools: list[McpTool], budget_tokens: int = 200_000) -> ToolsCost:
    payload = json.dumps(
        [tool_descriptor(t) for t in tools], ensure_ascii=False, separators=(",", ":")
    )
    tokens = estimate_tokens(payload)
    return ToolsCost(tools=len(tools), tokens=tokens, share=tokens / budget_tokens)
