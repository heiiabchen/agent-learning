"""
L00 · 任务一参考实现（Python 通道）。

关键点和 TS 版完全一样：content 是块列表（不是字符串），system 是顶层参数（不是一条 message）。
差异只在写法上，值得对照 solutions/hello.ts 逐行看一眼。
"""

from __future__ import annotations

import time

from shared.config import create_client, get_provider, log_usage

provider = get_provider()
client = create_client(provider)


def text_of(blocks: list) -> str:
    """
    从内容块列表里把文字拼出来。这个小函数后面每节课都会用到。

    对照 TS 版：
        blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    两边都是「过滤 + 拼接」，Python 这边用生成器表达式喂给 join，
    比先建一个中间列表省一次分配——在流式场景里这个习惯值钱。
    """
    return "".join(b.text for b in blocks if b.type == "text")


def ask(question: str, system: str | None = None) -> tuple[int, float]:
    started = time.perf_counter()

    # system 不传和传 None 是两件事，某些兼容端点对显式 None 会报 400。
    # 所以这里用「有才加」的写法，而不是 system=system。
    kwargs = {"system": system} if system else {}

    msg = client.messages.create(
        model=provider.model_main,
        max_tokens=1024,
        messages=[{"role": "user", "content": question}],
        **kwargs,
    )

    elapsed = time.perf_counter() - started
    print(text_of(msg.content))
    log_usage("带 system" if system else "无 system", msg.usage)
    print(f"\x1b[2m耗时 {elapsed * 1000:.0f}ms\x1b[0m\n")

    return msg.usage.output_tokens, elapsed


def main() -> None:
    question = "什么是 AI agent？"

    print("── 不加约束 ──")
    free_tokens, free_elapsed = ask(question)

    print("── 要求一句话 ──")
    terse_tokens, terse_elapsed = ask(question, "你只能用一句话回答，不要分点，不要铺垫。")

    # 这个对比是这个练习真正的目的
    token_drop = round((1 - terse_tokens / free_tokens) * 100)
    time_drop = round((1 - terse_elapsed / free_elapsed) * 100)
    print(f"输出 token 减少 {token_drop}%，耗时减少 {time_drop}%。")
    print("两个百分比通常很接近——因为耗时几乎完全由输出 token 数决定。")


if __name__ == "__main__":
    main()
