"""
L00 · 任务三参考实现（Python 通道）。

三个函数本身在 shared/resilience.py（唯一事实来源），这里只有组装。
组装顺序是这个练习真正的考点：pooled(with_retry(with_timeout(请求)))。
"""

from __future__ import annotations

import asyncio
import time

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

T0 = time.perf_counter()


def stamp() -> str:
    return f"\x1b[2m+{(time.perf_counter() - T0) * 1000:>7.0f}ms\x1b[0m"


async def ask_once(question: str) -> str:
    """单次请求。注意这里每次都要新建一个 coroutine，所以包在函数里。"""
    msg = await client.messages.create(
        model=provider.model_main,
        max_tokens=256,
        system="只用一句话回答，不要铺垫。",
        messages=[{"role": "user", "content": question}],
    )
    return "".join(b.text for b in msg.content if b.type == "text")


async def worker(question: str, index: int) -> str:
    print(f"{stamp()} 开始 #{index}")

    # 由内到外：超时管单次请求，重试能重试超时本身，并发池管同时几个在跑。
    # lambda 每次被调用都造一个新的 coroutine——直接传 coroutine 对象会在
    # 第二次 await 时报 "cannot reuse already awaited coroutine"。
    text = await with_retry(
        lambda: with_timeout(20, ask_once(question)),
        tries=3,
    )

    print(f"{stamp()} 完成 #{index}")
    return text


async def main() -> None:
    results = await pooled(QUESTIONS, 2, worker)

    print("\n─────────── 结果 ───────────\n")
    ok = 0
    for i, r in enumerate(results):
        if isinstance(r, BaseException):
            print(f"#{i} \x1b[31m失败：{r}\x1b[0m\n")
        else:
            ok += 1
            print(f"#{i} {r.strip()}\n")

    print(f"成功 {ok}/{len(results)}，总耗时 {(time.perf_counter() - T0) * 1000:.0f}ms")
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
