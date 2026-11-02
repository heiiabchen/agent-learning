"""
L01 · 任务一参考实现（Python 通道）。
"""

from __future__ import annotations

import asyncio
import unicodedata

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


async def measure(text: str) -> int:
    """把 text 作为唯一一条 user 消息发出去，返回 input_tokens。max_tokens=1 是为了少付钱。"""

    async def once() -> int:
        msg = await client.messages.create(
            model=provider.model_main,
            max_tokens=1,
            messages=[{"role": "user", "content": text}],
        )
        return msg.usage.input_tokens

    return await with_retry(lambda: with_timeout(30, once()))


async def net(text: str) -> int:
    """
    差分测量：measure 里含有每条消息都有的固定开销，而我们不知道它是多少。
    测 text 和 text+text 两次相减，固定开销正好被消掉，剩下的就是 text 的净 token 数。

    测不到绝对值就去测差值——这个套路在 L12 会反复出现。
    """
    once, twice = await asyncio.gather(measure(text), measure(text + text))
    return twice - once


def display_width(s: str) -> int:
    """
    CJK 字符在终端里占两格，直接 ljust 会歪。

    Python 有 unicodedata.east_asian_width 可以直接问，不用像 TS 那边手写正则范围——
    标准库比自己划 Unicode 区间可靠得多，尤其是遇到全角标点的时候。
    """
    return sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in s)


def pad_right(s: str, n: int) -> str:
    return s + " " * max(0, n - display_width(s))


async def main() -> None:
    async def work(sample: tuple[str, str], _i: int) -> tuple[str, str, int]:
        name, text = sample
        return name, text, await net(text)

    rows = await pooled(SAMPLES, 2, work)

    header = pad_right("名称", 14) + "字符数".rjust(6) + "token".rjust(9) + "字符/token".rjust(12)
    print("\n" + header)
    print("─" * 48)

    for row in rows:
        if isinstance(row, BaseException):
            print(f"\x1b[31m测量失败：{row}\x1b[0m")
            continue
        name, text, tokens = row
        ratio = f"{len(text) / tokens:.2f}" if tokens > 0 else "—"
        print(
            pad_right(name, 14) + str(len(text)).rjust(6) + str(tokens).rjust(9) + ratio.rjust(12)
        )

    print(
        """
读表要点：

· 「字符/token」越高越省。你会看到随机 ID 和 JSON 明显垫底——
  标点、数字、无规律字符串在 BPE 词表里没有任何统计规律可以利用，
  几乎是逐字符切。往上下文里塞 UUID、时间戳、哈希是很贵的。

· 中英文的比值不能直接对比「谁更省」，因为一个中文字符承载的信息量
  远大于一个英文字符。要回答「同样意思花多少 token」，得拿两段
  意思相同的译文对比着测——通常中文会比英文多花三到五成。

· 最高和最低的比值差好几倍。所以任何用**字符数**当上下文预算的代码
  都是不可控的，预算的单位只能是 token。"""
    )

    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
