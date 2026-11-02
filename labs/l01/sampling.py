"""
L01 · 任务二（Python 通道）：temperature 到底决定了什么。

跑法：uv run python -m l01.sampling
参考实现：uv run python -m l01.solutions.sampling

任务说明以 l01/sampling.ts 为准。

一句提醒：这个实验最容易被误读的地方是——**「五次都一样」不能证明它是确定性的。**
你只是没观察到分歧。跑完之后回讲义里对一下那段解释。
"""

from __future__ import annotations

import asyncio

from shared.config import create_async_client, get_provider
from shared.resilience import pooled, with_retry, with_timeout

provider = get_provider()
client = create_async_client(provider)

PROMPT = "给一个把 API 密钥安全存放在服务端的做法起一个变量名，只回答变量名本身，不要解释。"
RUNS = 5

# ─────────────────────────────────────────────────────────────────────────────
# TODO 1 · 写一个 ask(temperature)，返回模型输出的纯文本
#
#   一个容易踩的坑：DeepSeek V4 默认开思考模式，content[0] 可能是 thinking 块。
#   所以要 filter 出 type == "text" 的块，不能直接取 content[0].text。
# ─────────────────────────────────────────────────────────────────────────────


# TODO 2 · 同一个 prompt 在 temperature=0 下跑 5 次，统计出现了几种不同输出
#
#   然后把 temperature 换成 1 再跑 5 次，对比两组的「去重后种类数」。


# TODO 3 · 想清楚一件事，本节的设计题会考
#
#   既然 temperature=0 也不能保证输出完全一致，那自动化测试里
#   该怎么写断言？「输出 == 某个字符串」显然不行，替代方案有哪几类？
#
#   提示：回头看 l00/verify.py 里你写的每一条断言，它们都不在比对字符串。


async def main() -> None:
    raise NotImplementedError("把 TODO 写完，然后删掉这一行")


if __name__ == "__main__":
    asyncio.run(main())
