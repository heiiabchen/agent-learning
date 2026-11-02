"""
L00 · 任务二参考实现（Python 通道）。

重点和 TS 版一致：TTFT 和总时长是两个独立的指标，流式只优化前者。
"""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass

from shared.config import create_client, get_provider

provider = get_provider()
client = create_client(provider)


@dataclass
class StreamStats:
    ttft: float
    total: float
    output_tokens: int


def ask_streaming(question: str) -> StreamStats:
    sent_at = time.perf_counter()
    first_token_at: float | None = None
    input_tokens = 0
    output_tokens = 0

    with client.messages.create(
        model=provider.model_main,
        max_tokens=2048,
        messages=[{"role": "user", "content": question}],
        stream=True,
    ) as stream:
        for event in stream:
            if event.type == "message_start":
                input_tokens = event.message.usage.input_tokens

            elif event.type == "content_block_delta":
                if first_token_at is None:
                    first_token_at = time.perf_counter()

                # thinking_delta 也算「首字」——用户看到的等待是一样的结束
                chunk = getattr(event.delta, "text", None) or getattr(event.delta, "thinking", "")
                # flush=True 是关键。少了它，输出会攒在缓冲区里一次性吐出来，
                # 看起来就像流式完全没生效。
                print(chunk, end="", flush=True)

            elif event.type == "message_delta":
                output_tokens = event.usage.output_tokens

    done = time.perf_counter()
    ttft = (first_token_at or done) - sent_at
    total = done - sent_at

    print(
        f"\n\x1b[2m首字 {ttft * 1000:.0f}ms · 总时长 {total * 1000:.0f}ms"
        f" · 输入 {input_tokens} · 输出 {output_tokens}\x1b[0m"
    )
    return StreamStats(ttft=ttft, total=total, output_tokens=output_tokens)


def main() -> None:
    print("── 短回答 ──")
    short = ask_streaming("一句话说明什么是 tool use。")

    print("\n── 长回答 ──")
    long = ask_streaming("详细解释 HTTP/2 相比 HTTP/1.1 的改进，分点讲。")

    print("\n───────────────────────────────")
    print(f"首字延迟：{short.ttft * 1000:.0f}ms → {long.ttft * 1000:.0f}ms（基本没变）")
    print(
        f"总时长：  {short.total * 1000:.0f}ms → {long.total * 1000:.0f}ms"
        f"（涨了 {long.total / short.total:.1f} 倍）"
    )
    print(f"输出 token：{short.output_tokens} → {long.output_tokens}")
    print(
        """
结论：TTFT 由输入长度决定，两次输入都很短所以几乎一样。
总时长由输出长度决定，所以第二次涨了这么多。

流式没有让任何东西变快，它只是把用户感知的等待从「总时长」换成了「首字延迟」。
这就是为什么所有 agent 产品都必须做流式——不是性能优化，是可用性的门槛。"""
    )


if __name__ == "__main__":
    sys.exit(main())
