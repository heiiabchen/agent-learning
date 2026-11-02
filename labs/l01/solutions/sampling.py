"""
L01 · 任务二参考实现（Python 通道）。
"""

from __future__ import annotations

import asyncio

from shared.config import create_async_client, get_provider
from shared.resilience import pooled, with_retry, with_timeout

provider = get_provider()
client = create_async_client(provider)

PROMPT = "给一个把 API 密钥安全存放在服务端的做法起一个变量名，只回答变量名本身，不要解释。"
RUNS = 5


async def ask(temperature: float) -> str:
    async def once() -> str:
        msg = await client.messages.create(
            model=provider.model_main,
            max_tokens=32,
            temperature=temperature,
            messages=[{"role": "user", "content": PROMPT}],
        )
        # 思考模式下 content[0] 可能是 thinking 块，所以要 filter 不要 [0]
        return "".join(b.text for b in msg.content if b.type == "text").strip()

    return await with_retry(lambda: with_timeout(30, once()))


async def trial(temperature: float) -> None:
    print(f"\n\x1b[1mtemperature = {temperature}\x1b[0m")

    async def work(_item: int, _i: int) -> str:
        return await ask(temperature)

    results = await pooled(list(range(RUNS)), 2, work)
    outputs: list[str] = []

    for i, r in enumerate(results):
        if isinstance(r, BaseException):
            print(f"  {i + 1}. \x1b[31m失败：{r}\x1b[0m")
        else:
            outputs.append(r)
            print(f"  {i + 1}. {r}")

    distinct = len(set(outputs))
    color = "\x1b[32m" if distinct == 1 else "\x1b[33m"
    print(f"  {color}{len(outputs)} 次里出现了 {distinct} 种不同输出\x1b[0m")


async def main() -> None:
    await trial(0)
    await trial(1)

    print(
        """
怎么读这个结果：

· temperature 0 大概率是 1 种（或 5 次里有 1 次跑偏），temperature 1 通常好几种。
  这符合预期：温度关掉的是**采样**那一层的随机性。

· 但请注意——**「五次都一样」不能证明它是确定性的。**
  这是这个实验最容易被误读的地方。你只是没观察到分歧，不等于分歧不存在。
  浮点归约顺序、批次组成、MoE 路由这些因素只在「第一名和第二名的 logits
  极度接近」时才会翻转排名，那是个低概率事件——低概率不是零概率，
  而线上跑一百万次的时候，低概率事件每天都在发生。

  「测了几次没复现」和「不会发生」是两回事。这个区分是做 evals 的基本素养。

· 所以自动化断言不能写成「输出 == 某个字符串」。可用的断言长这样：
    - 结构：能不能 json.loads、必需字段在不在
    - 约束：是不是合法标识符（str.isidentifier()）、长度在不在范围内、有没有禁用词
    - 统计：跑 N 次，通过率是否 ≥ 阈值（承认它是概率系统，然后度量这个概率）
  你在 l00/verify.py 里写的每一条断言都是这种形状，没有一条在比对字符串。

· 什么时候用什么温度：
    - 低温：工具调用参数、结构化输出、代码生成、分类判断——要的是稳定和可复现。
    - 高温：头脑风暴、多样化候选、创意文案，以及 L12 里「故意采样多个答案
      再投票」的场景（self-consistency）。"""
    )

    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
