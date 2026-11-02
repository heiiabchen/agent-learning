"""
L05 · 任务二（Python 通道）：拿真模型跑你的 agent。

跑法：uv run python -m l05.agent "labs 里哪个文件最长？"

四个观察题见 l05/agent.ts，这里不重复。

Python 这边的 Ctrl-C 处理和 TS 不同，值得看一眼：
TS 那边 SIGINT 里调 ac.abort()，走 AbortSignal。
这里用一个可变标志 + is_cancelled 回调——因为我们要的是
「优雅地停下并返回部分结果」，而不是「抛异常终止」。

如果你想改成真正的 asyncio 取消（task.cancel()），也能工作，
shared/agent.py 里那个 `except asyncio.CancelledError` 分支就是为它准备的。
但标志位这条路能保证部分结果一定被返回，更适合命令行工具。
"""

from __future__ import annotations

import asyncio
import signal
import sys
from pathlib import Path

from shared.agent import REASON_TEXT, run_agent
from shared.config import create_async_client, get_provider
from shared.ledger import Ledger
from shared.toolbox import standard_tools
from shared.tools import ToolBox

provider = get_provider()
client = create_async_client(provider)
ROOT = Path(__file__).resolve().parent.parent

SYSTEM = "\n".join(
    [
        "<role>你是一个代码库助手，在一个真实仓库里工作。</role>",
        "",
        "<capabilities>",
        "你可以用工具读文件、列目录、按正则搜索代码。",
        "你没有网络访问，不能安装依赖，不能修改任何文件。",
        "</capabilities>",
        "",
        "<rules>",
        "1. 回答之前先用工具查证，不要凭猜测回答关于这个仓库的问题。",
        "2. 一次可以要多个互不依赖的工具调用。",
        "3. 工具报错时读错误信息里的建议，换个做法，不要重复同样的调用。",
        "4. 拿到足够信息就直接给答案，不要为了保险再多查几遍。",
        "</rules>",
        "",
        "<giving_up>",
        # ★ 讲义第二节：模型的训练分布里「继续尝试」远高于「宣告失败」，
        #   所以「放弃」必须被明确授权，而且要给格式——没格式等于没授权。
        "如果连续两次尝试同一个方向都失败，停止尝试，输出：",
        "<blocked>你尝试了什么、观察到什么、需要什么才能继续</blocked>",
        "</giving_up>",
    ]
)

toolbox = ToolBox(standard_tools(ROOT))
stopping = {"now": False}


async def call(messages: list[dict]):
    return await client.messages.create(
        model=provider.model_main,
        max_tokens=4096,
        system=SYSTEM,
        tools=toolbox.api_tools(),
        messages=messages,
    )


def on_step(e) -> None:
    mark = "\x1b[32m✓\x1b[0m" if e.ok else "\x1b[31m✕\x1b[0m"
    print(f"  {mark} [{e.step}] {e.tool_name} {str(e.input)[:60]}  \x1b[2m{e.ms:.0f}ms\x1b[0m")
    print(f"      \x1b[2m{e.preview}\x1b[0m")


async def amain() -> None:
    task = " ".join(sys.argv[1:]) or "labs/shared 下有哪些模块？各自大概是干什么的？"
    ledger = Ledger("agent")

    loop = asyncio.get_running_loop()

    def stop() -> None:
        print("\n收到中断，正在停…")
        stopping["now"] = True

    loop.add_signal_handler(signal.SIGINT, stop)

    print(f"\x1b[2m模型 {provider.model_main} · 工具 {'、'.join(toolbox.names)}\x1b[0m")
    print(f"\x1b[1m任务：\x1b[0m{task}\n")

    run = await run_agent(
        task,
        toolbox=toolbox,
        system=SYSTEM,
        call=call,
        ledger=ledger,
        max_steps=15,
        max_yuan=0.5,
        max_ms=180_000,
        is_cancelled=lambda: stopping["now"],
        on_step=on_step,
    )

    print(f"\n{'─' * 60}")
    print(run.text or "（没有正文）")
    print("─" * 60)
    print(f"\n结束原因：{REASON_TEXT[run.reason]}")
    if run.error:
        print(f"异常：{run.error}")
    print(f"步数 {run.steps} · 工具调用 {len(run.trace)} 次")
    print(f"\n{ledger.report()}")


if __name__ == "__main__":
    asyncio.run(amain())
