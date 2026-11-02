"""
L01 · 任务一（Python 通道）：量一量不同文本的 token 效率。

跑法：uv run python -m l01.tokens
参考实现：uv run python -m l01.solutions.tokens

任务说明以 l01/tokens.ts 为准。Python 这边只多两件事要注意：

  1. Anthropic 官方 SDK 有 client.messages.count_tokens()，但 DeepSeek 的兼容端点
     没有这个接口。所以照样得用差分法——这本身就是「兼容层不等于功能等同」的又一例。

  2. len(text) 在 Python 里数的是 Unicode 码位，一个汉字算 1。
     JS 的 String.length 数的是 UTF-16 码元，基本汉字也算 1 但 emoji 会算 2。
     所以两边的「字符数」这一列在遇到 emoji 时会不一样——这正是
     「别用字符数当预算单位」的另一个理由。
"""

from __future__ import annotations

import asyncio

from shared.config import create_async_client, get_provider
from shared.resilience import pooled, with_retry, with_timeout

provider = get_provider()
client = create_async_client(provider)

SAMPLES: list[tuple[str, str]] = [
    ("英文散文", "The quick brown fox jumps over the lazy dog near the river bank."),
    ("中文散文", "敏捷的棕色狐狸跳过了河岸边那只懒惰的狗，动作干净利落。"),
    ("JSON 数据", '{"id":"7f3a-91c2","ts":1738291045,"score":3.14159,"ok":true}'),
    ("Python 代码", "async def with_timeout(seconds: float, coro: Awaitable[R]) -> R:"),
    ("缩进空白", "        \n" * 5),
    ("随机 ID", "a3f9c1e7-4b82-4d16-9f0a-7c2e5b8d3a61"),
]

# ─────────────────────────────────────────────────────────────────────────────
# TODO 1 · 写一个 measure(text)，把 text 作为唯一一条 user 消息发出去，返回 input_tokens
#
#   max_tokens=1 是刻意的：我们只关心输入侧的计数，不想为输出付钱。
#   记得套上 with_retry + with_timeout，这两个函数从这一节开始就是标配了。
# ─────────────────────────────────────────────────────────────────────────────


# TODO 2 · 写一个 net(text)，用差分法拿到 text 的净 token 数
#
#   measure 的结果里含有「每条消息都有的固定开销」，而我们不知道它是多少。
#   测 text 和 text+text 两次相减，固定开销正好被消掉。
#
#   测不到绝对值就去测差值——这个套路在 L12 会反复出现。


# TODO 3 · 用 pooled 并发跑完所有样本，打印一张表
#
#   四列：名称、字符数、token 数、字符/token 比值。
#   提示：CJK 字符在终端里占两格，直接用 str.ljust 会对不齐。


# TODO 4 · 看着你的表回答三个问题（写在下面的注释里，本节设计题会用到）
#
#   a) 哪一类文本最费 token？为什么是它？
#   b) 中文和英文的比值能直接对比「谁更省」吗？要怎么测才公平？
#   c) 如果用「字符数」当上下文预算的单位，最坏情况会偏差多少倍？


async def main() -> None:
    raise NotImplementedError("把 TODO 写完，然后删掉这一行")


if __name__ == "__main__":
    asyncio.run(main())
