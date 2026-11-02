"""
L04 · 任务三（Python 通道）：跑通完整的四回合往返。

跑法：uv run python -m l04.roundtrip

完整任务说明和三个要跑的问题见 l04/roundtrip.ts。

Python 这边一处形状差异：这里给的是**同步**版本。
工具执行用 asyncio.run 起一次事件循环，因为 shared/toolbox.py 里
run 是 async 的（真实项目里工具经常要并发 IO）。

并行工具调用要用 asyncio.gather —— 注意它和 TS 的 Promise.all 一样**保序**，
返回顺序跟传入顺序一致，不是完成顺序。这正是我们要的
（顺序抖动 → 前缀缓存失效 + 问题无法复现）。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from shared.config import create_client, get_provider
from shared.ledger import Ledger
from shared.message import text_of
from shared.toolbox import standard_tools
from shared.tools import ToolBox, tool_result_message, tool_uses_of

provider = get_provider()
client = create_client(provider)
ledger = Ledger("L04 往返")

# 把 labs/ 自己当仓库用——读自己的代码，任务比较自然
ROOT = Path(__file__).resolve().parent.parent

SYSTEM = "\n".join(
    [
        "<role>你是一个代码库助手，在一个真实仓库里工作。</role>",
        "",
        "<capabilities>",
        "你可以用工具读文件、列目录、按正则搜索代码。",
        "你没有网络访问，不能安装依赖，不能修改任何文件。",
        "需要仓库外的信息时，直接说你拿不到，不要猜。",
        "</capabilities>",
        "",
        "<rules>",
        "1. 回答之前先用工具查证，不要凭猜测回答关于这个仓库的问题。",
        "2. 一次可以要多个互不依赖的工具调用。",
        "3. 工具报错时，读错误信息里的建议，换个做法，不要重复同样的调用。",
        "</rules>",
    ]
)


# ─────────────────────────────────────────────────────────────────────────────
# TODO 1 · 走完一次完整往返
#
#   ★ 三个必须做对的地方（讲义第一节的 Pitfall）：
#     · assistant 那条要**原样**放回历史，包含 tool_use 块
#       （丢掉的话模型看不到自己要求过什么，会重新要求 → 死循环）
#     · tool_result 用 user 角色（协议里只有 user 和 assistant）
#     · tool_use_id 精确对应
#
#   把 res.content 放回历史时注意：SDK 给的是对象列表，
#   直接 append 进 messages 是可以的（SDK 会正确序列化）。
#   但如果你想手动构造 dict，记得 tool_use 块的 input 字段不能丢。
#
# TODO 2 · 三个问题，跑完回答 l04/roundtrip.ts 里那三个问题（a/b/c）
# ─────────────────────────────────────────────────────────────────────────────


def roundtrip(question: str) -> str:
    toolbox = ToolBox(standard_tools(ROOT))
    messages: list[dict] = [{"role": "user", "content": question}]

    _ = (
        toolbox,
        messages,
        tool_uses_of,
        tool_result_message,
        text_of,
        asyncio,
        ledger,
        client,
        SYSTEM,
    )
    raise NotImplementedError("把 TODO 1 写完，然后删掉这一行")


def main() -> None:
    print(f"模型 {provider.model_main} · 仓库根 {ROOT}\n")
    _ = roundtrip
    raise NotImplementedError("把 TODO 2 写完，然后删掉这一行")


if __name__ == "__main__":
    main()
