"""
L01 · 任务三参考实现（Python 通道）。
"""

from __future__ import annotations

from dataclasses import dataclass

from shared.config import create_client, get_provider, price_of

provider = get_provider()
client = create_client(provider)
price = price_of(provider.model_main)

SYSTEM = "你是一个前端技术顾问。回答控制在 100 字以内，直接给结论。"

TURNS = [
    "我要做一个实时协作的白板应用，前端框架选 React 还是 Svelte？",
    "按你选的这个，状态管理用什么？",
    "多人同时编辑的冲突怎么解决？",
    "你刚才提到的那个方案，离线场景下怎么办？",
    "如果要支持一万人同时在线，第一个瓶颈会出现在哪？",
    "总结一下你前面给我的所有建议。",
]


@dataclass
class TurnLog:
    turn: int
    input_tokens: int
    output_tokens: int


def yuan(tokens: int, per_million: float) -> float:
    return tokens / 1_000_000 * per_million


def main() -> None:
    messages: list[dict] = []
    log: list[TurnLog] = []

    for i, question in enumerate(TURNS):
        # 注意：这里**没有**先把 user 消息加进 messages。
        # 先改状态再做可能失败的事，失败后会留下孤儿消息污染历史。
        nxt = [*messages, {"role": "user", "content": question}]

        res = client.messages.create(
            model=provider.model_main,
            max_tokens=512,
            system=SYSTEM,  # 顶层参数，不是 messages 里的一项
            messages=nxt,
        )

        if res.stop_reason == "max_tokens":
            raise RuntimeError(
                f"第 {i + 1} 轮被 max_tokens 截断了。半截回答如果存进历史，"
                "会污染后面每一轮——所以这里宁可直接失败，也不要静默入库。"
            )

        text = "".join(b.text for b in res.content if b.type == "text")

        # 成功之后才一起提交状态
        messages = [*nxt, {"role": "assistant", "content": text}]
        log.append(TurnLog(i + 1, res.usage.input_tokens, res.usage.output_tokens))

        print(f"\x1b[2m第 {i + 1} 轮\x1b[0m {question}")
        print(f"{text.strip()}\n")

    # ── 账单 ─────────────────────────────────────────────────────────────────

    print("轮次   本轮输入   本轮输出   累计输入   累计花费(元)")
    print("─" * 52)

    cum_in = 0
    cum_out = 0
    for r in log:
        cum_in += r.input_tokens
        cum_out += r.output_tokens
        cost = yuan(cum_in, price.input_miss) + yuan(cum_out, price.output)
        print(
            str(r.turn).rjust(3)
            + str(r.input_tokens).rjust(10)
            + str(r.output_tokens).rjust(11)
            + str(cum_in).rjust(11)
            + f"{cost:.4f}".rjust(14)
        )

    # ── 无状态的代价 ─────────────────────────────────────────────────────────

    # 假想的「有状态 API」要发多少输入？system 发一次，每条 user 消息发一次，
    # 助手的回复完全不用回传。
    #
    # 我们没有单独测过每条 user 消息有多少 token，但可以从相邻两轮的差值反推：
    #
    #   第 n 轮的上下文 = 第 n−1 轮的上下文 + 助手第 n−1 轮的回复 + 用户第 n 条消息
    #   ⇒ userₙ = inputₙ − inputₙ₋₁ − outputₙ₋₁
    #
    # 又是差分——和 tokens.py 里那个套路完全一样：测不到绝对值，就去测差值。
    stateful_in = log[0].input_tokens
    for prev, cur in zip(log, log[1:], strict=False):
        stateful_in += cur.input_tokens - prev.input_tokens - prev.output_tokens

    blowup = cum_in / stateful_in
    cost_miss = yuan(cum_in, price.input_miss) + yuan(cum_out, price.output)
    cost_hit = yuan(cum_in, price.input_hit) + yuan(cum_out, price.output)

    print(
        f"""
─────────── 结论 ───────────

累计输入 {cum_in} token，累计输出 {cum_out} token
输入花了 {yuan(cum_in, price.input_miss):.4f} 元，输出花了 {yuan(cum_out, price.output):.4f} 元

无状态的代价：实际输入约为「只发增量」的 {blowup:.1f} 倍
（只有 {len(TURNS)} 轮就这样了。这个倍数随轮数继续涨，因为累计输入是 O(n²) 的。）

缓存未命中：{cost_miss:.4f} 元
缓存全命中：{cost_hit:.4f} 元    ← 差 {cost_miss / cost_hit:.0f} 倍

最后这个倍数就是 L15 存在的理由。而拿到它的代价只是一条纪律：
**保持前缀稳定，新内容只往后追加。**
任何往历史中间插入或修改的操作，都会让那个位置之后的缓存全部失效。"""
    )


if __name__ == "__main__":
    main()
