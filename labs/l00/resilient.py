"""
L00 · 任务三（Python 通道）：并发 + 超时 + 重试 组装起来。

跑法：uv run python -m l00.resilient
参考实现：uv run python -m l00.solutions.resilient

三个基础设施函数在 shared/resilience.py 里，先把那个文件读一遍再动手——
它和 TS 版的差异不是写法差异，是**取消模型的根本差异**，注释里写清楚了。

改完 shared/resilience.py 之后跑 `uv run python -m l00.verify` 验证。
"""

from __future__ import annotations

import asyncio

from shared.config import create_async_client, get_provider
from shared.resilience import pooled, with_retry, with_timeout

provider = get_provider()
client = create_async_client(provider)

QUESTIONS = [
    "一句话说明什么是 prompt injection。",
    "一句话说明什么是 RAG。",
    "一句话说明什么是 MCP。",
    "一句话说明什么是 tool use。",
    "一句话说明什么是 context window。",
]

# ─────────────────────────────────────────────────────────────────────────────
# TODO · 并发问上面五个问题，限制最多 2 路并发，每个请求 20 秒超时、失败重试 3 次。
#
#   在每个请求开始和结束时打印时间戳，确认它真的是「两个两个来」而不是一起冲出去。
#
# 组装的顺序很重要，而且两边一样：pooled(withRetry(withTimeout(请求)))。
#   · 超时在最内层——它要管的是「单次请求」多久算慢。
#   · 重试在中间——它要能重试「超时」这件事本身。
#   · 并发池在最外层——它管的是同时有几个任务在跑，重试不该占用新的并发额度。
#
# 顺序错了会怎样？把 withTimeout 放到 withRetry 外面，20 秒就变成了「三次重试
# 加起来的总预算」，第一次慢一点后面就没机会了。这个错误在本节的改错题里出现过。
#
# Python 特有的一点：with_timeout 收的是 awaitable，不是像 TS 那样收
# 一个「拿 signal 的函数」。原因见 shared/resilience.py 的注释。
# ─────────────────────────────────────────────────────────────────────────────


async def main() -> None:
    raise NotImplementedError("把 TODO 写完，然后删掉这一行")


if __name__ == "__main__":
    asyncio.run(main())
