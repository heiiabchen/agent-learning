"""L10 任务二（Python 版）：手写一个 MCP client，真的 spawn 一个子进程。

    uv run python -m l10.client

不用写，直接跑。默认 spawn 参考实现，写完 server.py 之后：

    MCP_IMPL=mine uv run python -m l10.client

★ Python 特有的一处**关键差异**，它决定了整个客户端的写法：

Node 那边 `child.stdout.on('data')` 是回调，读和写天然并发。
Python 这边 `asyncio.create_subprocess_exec` 给的是 StreamReader，
你必须**自己起一个后台任务去读**——而且必须在发第一个请求之前起。

漏了这一步的表现是死锁：你 `await` 一个 future，而没人在读管道，
所以那个 future 永远不会被 set_result。**没有异常，没有超时，只是不返回。**
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from shared.mcp import Framer, McpClient, McpTool, tools_list_cost

ROOT = Path(__file__).resolve().parent.parent
IMPL = "mine" if os.environ.get("MCP_IMPL") == "mine" else "shared"


@dataclass
class Conn:
    client: McpClient
    proc: asyncio.subprocess.Process
    logs: list[str] = field(default_factory=list)
    raw_lines: list[str] = field(default_factory=list)
    wire_errors: list[str] = field(default_factory=list)
    tasks: list[asyncio.Task[None]] = field(default_factory=list)

    async def close(self) -> None:
        if self.proc.returncode is None:
            if self.proc.stdin is not None:
                with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                    self.proc.stdin.close()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.proc.wait(), timeout=3)
        if self.proc.returncode is None:
            self.proc.kill()
            await self.proc.wait()
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)


async def connect(env: dict[str, str] | None = None) -> Conn:
    """起一个 MCP server 子进程，把它的 stdin/stdout 接成一个 client。

    ★ 这三十行就是 Cursor 在你保存 mcp.json 之后做的事。没有别的。
    """
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "l10.server",
        "--stdio",
        cwd=ROOT,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "MCP_IMPL": IMPL, **(env or {})},
    )
    assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None

    conn = Conn(client=McpClient(lambda line: _write(proc, line)), proc=proc)
    framer = Framer()

    async def pump_stdout() -> None:
        assert proc.stdout is not None
        while True:
            # read(n) 在 StreamReader 上是"有多少给多少"，不会等满 n——
            # 和同步 IO 的 read(n) 语义不同，这里正好是我们要的。
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            try:
                lines = framer.push(chunk.decode("utf-8", errors="replace"))
            except ValueError as err:
                conn.wire_errors.append(str(err))
                continue
            for line in lines:
                conn.raw_lines.append(line)
                try:
                    conn.client.receive(line)
                except ValueError as err:
                    # 收到不是 JSON 的一行。**这就是 stdout 被污染的样子。**
                    conn.wire_errors.append(str(err))
        # ★ 管道读到 EOF = 对面没了。把所有等待中的请求拒掉，
        # 否则调用方的 await 永远不返回——没有栈、没有日志、只有一个不返回的协程。
        conn.client.fail_all("server 子进程已退出（stdout EOF）")

    async def pump_stderr() -> None:
        assert proc.stderr is not None
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                conn.logs.append(text)

    conn.tasks = [asyncio.create_task(pump_stdout()), asyncio.create_task(pump_stderr())]
    return conn


def _write(proc: asyncio.subprocess.Process, line: str) -> None:
    assert proc.stdin is not None
    proc.stdin.write(line.encode("utf-8"))
    # StreamWriter.write 是不阻塞的，drain 才是背压。这里不 await drain
    # 是因为 send 的签名是同步的；消息都很小，缓冲区放得下。
    # 真实客户端要处理背压，见 L15。


async def connect_ready(env: dict[str, str] | None = None) -> Conn:
    conn = await connect(env)
    with contextlib.suppress(Exception):
        await asyncio.wait_for(conn.client.request("server/discover"), timeout=20)
    return conn


# ─────────────────────────────────────────────────────────────


async def demo_handshakeless() -> None:
    print("\n【一】一次完整的连接（2026-07-28：没有握手）")

    conn = await connect()
    disc = await conn.client.request("server/discover")
    print(f"    supportedVersions: {disc['supportedVersions']}")
    print(f"    capabilities:      {disc['capabilities']}")

    listed = await conn.client.request("tools/list")
    names = "、".join(t["name"] for t in listed["tools"])
    print(f"  tools/list       {len(listed['tools'])} 个：{names}")

    call_args = {"name": "list_dir", "arguments": {"path": "l10"}}
    called = await conn.client.request("tools/call", call_args)
    for line in called["content"][0]["text"].split("\n")[:4]:
        print(f"      {line}")

    print("\n  子进程的 stderr（日志走这里，不走 stdout）：")
    for line in conn.logs:
        print(f"      {line}")

    print("\n  ★ 注意没有 initialize。2026-07-28 之前这里要先握一次手，")
    print("  服务端把版本和能力记在**这条连接的内存里**。")
    print("  代价是同一个客户端的请求必须落到同一个进程——粘性会话、共享存储、")
    print("  或者干脆单实例。删掉握手之后，任何请求可以落到任何一台机器。")

    await conn.close()


async def demo_out_of_order() -> None:
    print("\n【二】乱序：为什么响应必须靠 id 匹配")

    conn = await connect_ready()

    jobs: list[tuple[str, asyncio.Future[dict[str, Any]]]] = [
        (
            "search_code（慢）",
            conn.client.request(
                "tools/call",
                {"name": "search_code", "arguments": {"pattern": "def ", "max_results": 50}},
            ),
        ),
        (
            "list_dir（快）",
            conn.client.request("tools/call", {"name": "list_dir", "arguments": {"path": "."}}),
        ),
        ("tools/list（快）", conn.client.request("tools/list")),
    ]
    print(f"  同时发出 3 个请求，pending={conn.client.pending}")

    order: list[tuple[str, float]] = []
    t0 = time.perf_counter()

    async def watch(label: str, fut: asyncio.Future[dict[str, Any]]) -> None:
        await fut
        order.append((label, (time.perf_counter() - t0) * 1000))

    await asyncio.gather(*(watch(label, fut) for label, fut in jobs))

    sent = [label for label, _ in jobs]
    print(f"  发出顺序：{' → '.join(sent)}")
    print(f"  完成顺序：{' → '.join(label for label, _ in order)}")
    for label, ms in order:
        print(f"      {label:<18} {ms:6.1f}ms")

    print("\n  ★ 响应顺序和发出顺序**没有关系**，所以配对只能靠 id。")
    print("  按顺序配对的客户端会把 list_dir 的结果当成 search_code 的——")
    print("  而且它不报错，只是答案不对。")

    # 同一份 server 逻辑，TS 和 Python 给出的顺序不一样。这不是 bug，
    # 是两个运行时对「async」的兑现程度不同——而这恰好是最值得看的那一格。
    if [label for label, _ in order] == sent:
        slowest = max(ms for _, ms in order)
        fastest = min(ms for _, ms in order)
        print("\n  ★ 但你这次看到的完成顺序**和发出顺序一模一样**，"
              "而 TS 版跑同一个实验会看到快的先回。")
        print(f"  再看耗时：最快的那个也要 {fastest:.1f}ms，和最慢的 {slowest:.1f}ms 挤在一起。")
        print("  三个请求不是并发跑的，是**排着队**跑的。")
        print("\n  原因在 shared/toolbox.py：那些工具签名是 `async def`，")
        print("  函数体里却是 `path.read_text()`、`os.scandir()` 这种同步阻塞调用，")
        print("  一个 await 都没有。**不 await 的 async 函数只是穿了戏服的同步函数**：")
        print("  事件循环一旦开始执行它，就必须等它整个跑完才能切走。")
        print("  于是 create_task 派发了 3 个任务，它们仍然一个接一个地跑。")
        print("\n  修法是把阻塞活儿挪出事件循环：")
        print("      return await asyncio.to_thread(lambda: path.read_text(encoding='utf-8'))")
        print("  改完之后 Python 这边的完成顺序才会和 TS 一样乱。")
        print("\n  ★ 这里有两条独立的教训，别混在一起：")
        print("  1. 顺序不是协议保证的 —— 所以客户端**永远**按 id 配对（跨语言都成立）；")
        print("  2. 你的 async server 可能根本没在并发 —— 这是 Python 特有的，"
              "而且它不报错，只是慢。")
    else:
        print("\n  ★ Python 版这里通常会看到另一种结果：完成顺序 = 发出顺序。")
        print("  因为 shared/toolbox.py 里的工具是「不 await 的 async 函数」，")
        print("  会把事件循环占满、逼着 3 个请求排队跑。这次没复现，")
        print("  说明工具耗时差得足够大或已经改用 asyncio.to_thread —— 两条教训仍然成立：")
        print("  顺序不能当契约，async 签名也不等于真并发。")

    await conn.close()


async def demo_stdout_pollution() -> None:
    print("\n【三】stdout 污染：同一个 bug，三种症状，没有一种提到 print")

    conn = await connect({"MCP_POLLUTE_STDOUT": "1"})
    try:
        disc = await asyncio.wait_for(conn.client.request("server/discover"), timeout=20)
        outcome = f"请求成功了，supportedVersions={disc['supportedVersions']}"
    except Exception as err:  # noqa: BLE001
        outcome = f"请求失败：{err}"

    bad = [line for line in conn.raw_lines if not line.strip().startswith("{")]
    print(f"  stdout 上收到 {len(conn.raw_lines)} 行，其中 {len(bad)} 行不是 JSON")
    for line in conn.raw_lines:
        mark = "\x1b[31m✗" if not line.strip().startswith("{") else "  "
        tail = "\x1b[0m" if not line.strip().startswith("{") else ""
        shown = line[:68] + "…" if len(line) > 68 else line
        print(f"    {mark} {shown}{tail}")
    print(f"  这次的结果：{outcome}")

    print("\n  同一批字节，三种客户端策略：")
    print(f"    宽容（静默跳过）  → 连接活着，{len(bad)} 行被丢掉，而你不会知道")
    print("    记录（记下跳过）  → 连接活着，日志里多一条「收到非 JSON 的一行」")
    print("    严格（断开连接）  → 断连，宿主报「server failed to start」")

    print("\n  ★ server 那边只多了一行 `print(...)`。")
    print("  规范说 server MUST NOT 往 stdout 写非 MCP 内容，但**没规定客户端该怎么反应**——")
    print("  所以同一个 bug 在不同宿主里是三种完全不同的症状，")
    print("  而三种里没有一种会提到那句 print。")
    print("\n  规矩只有一条：**日志一律走 stderr。**")

    await conn.close()


async def demo_crash() -> None:
    print("\n【四】子进程猝死：不处理的话 await 永远不返回")

    conn = await connect_ready()
    slow = conn.client.request(
        "tools/call", {"name": "search_code", "arguments": {"pattern": "def ", "max_results": 50}}
    )
    print(f"  发出一个请求，pending={conn.client.pending}")

    conn.proc.kill()
    print("  SIGKILL 掉子进程")

    loop = asyncio.get_running_loop()
    t0 = loop.time()
    try:
        await asyncio.wait_for(slow, timeout=6)
        print("  请求居然成功了")
    except Exception as err:  # noqa: BLE001
        print(f"  {(loop.time() - t0) * 1000:.0f}ms 后：{type(err).__name__}: {err}")
    print(f"  pending={conn.client.pending}")

    print("\n  ★ 这个异常来自 client.fail_all()，挂在 stdout 读到 EOF 的地方。")
    print("  少了那一行，这个 await **永远不返回**——")
    print("  没有异常、没有栈、没有超时，只有一个不返回的协程。")
    print("\n  ★ Python 这边还多一个坑：`asyncio.wait_for` 超时会抛 TimeoutError，")
    print("  但它**不会**把底层的 future 清出 pending。fail_all 才会。")

    await conn.close()


def demo_tax(tools: list[dict[str, Any]]) -> None:
    print("\n【五】上下文税：接进来之后每一轮付多少")

    as_tools = [
        McpTool(
            name=t["name"],
            description=t["description"],
            input_schema=t["inputSchema"],
            run=_noop,
        )
        for t in tools
    ]
    cost = tools_list_cost(as_tools)
    share = f"{cost.share * 100:.2f}"
    print(f"  这个 server：{cost.tools} 个工具 → {cost.tokens} token（占 200k 的 {share}%）")
    print("\n  社区实测（2026）：")
    print("    GitHub 官方 server        27 个工具   ~18,000 token")
    print("    五个常见 server 加一起   ~100 个工具  ~55,000 token")
    print("    七个                     ~140 个工具  ~67,300 token  ← 200k 窗口的 34%")
    print("\n  ★ 这笔钱**每一轮都付一次**，而且在用户打第一个字之前就付了。")
    print("  另一半是准确率：可选工具超过 30~50 个之后，模型选错工具的概率明显上升。")
    print("  **加 server 让能力变强，但让每一次选择变差。**")


async def _noop(_args: dict[str, Any]) -> Any:
    raise NotImplementedError


async def main() -> None:
    print("═" * 64)
    print(f"L10 · MCP client（Python）：真 spawn、真管道（server 实现：{IMPL}）")
    print("═" * 64)

    await demo_handshakeless()
    await demo_out_of_order()
    await demo_stdout_pollution()
    await demo_crash()

    conn = await connect_ready()
    listed = await conn.client.request("tools/list")
    demo_tax(listed["tools"])
    await conn.close()

    print("\n" + "─" * 64)
    print("写完 server.py 之后用 MCP_IMPL=mine uv run python -m l10.client。")
    print("─" * 64 + "\n")


if __name__ == "__main__":
    asyncio.run(main())
