"""
L01 · 任务三（Python 通道）：把无状态的代价跑出来。

跑法：uv run python -m l01.conversation
参考实现：uv run python -m l01.solutions.conversation

这是本节最重要的一个实验。讲义里那张成本表是我算的，
现在你要用真实请求把它测出来，并且亲眼看到那条平方曲线。

完整任务说明以 l01/conversation.ts 为准，四个 TODO 一模一样。
Python 这边只有一处不同：这个脚本是**同步**的（用 create_client 而不是
create_async_client），因为多轮对话天然是串行的，没有并发可言。
在 JS 里你没得选，async 是唯一的写法；Python 里你可以选，而这里
选同步能让「一轮接一轮」的因果关系在代码形状上就看得出来。
"""

from __future__ import annotations

from shared.config import create_client, get_provider, price_of

provider = get_provider()
client = create_client(provider)
price = price_of(provider.model_main)

SYSTEM = "你是一个前端技术顾问。回答控制在 100 字以内，直接给结论。"

# 一段有连续性的多轮对话——后面的问题依赖前面的回答，这样历史才不能省。
TURNS = [
    "我要做一个实时协作的白板应用，前端框架选 React 还是 Svelte？",
    "按你选的这个，状态管理用什么？",
    "多人同时编辑的冲突怎么解决？",
    "你刚才提到的那个方案，离线场景下怎么办？",
    "如果要支持一万人同时在线，第一个瓶颈会出现在哪？",
    "总结一下你前面给我的所有建议。",
]

# ─────────────────────────────────────────────────────────────────────────────
# TODO 1 · 跑完这 6 轮对话，每轮把历史全量带上
#
# 维护一个 messages 列表：
#   · 每轮追加 {"role": "user", "content": TURNS[i]}
#   · 拿到回复后追加 {"role": "assistant", "content": 文本}
#   · system 用顶层参数传，**不要**塞进 messages
#
# 三个必须做对的地方（改错题里会考）：
#   · 取文本要 filter b.type == "text"，思考模式下第一块不是 text
#   · 检查 stop_reason，是 "max_tokens" 就说明被截断了，别把半截话存进历史
#   · 请求失败时不要留下孤儿 user 消息——成功之后再一起提交
# ─────────────────────────────────────────────────────────────────────────────


# TODO 2 · 每轮记录 usage，跑完打印一张表
#
# 每行：轮次、本轮输入 token、本轮输出 token、累计输入、累计花费（元）
#
# 单价从 price_of(provider.model_main) 拿，它给你 input_miss / input_hit / output，
# 单位是「元 / 百万 token」。先按 input_miss（缓存未命中）算，也就是最坏情况。
#
# 你要盯着看的是**「本轮输入」这一列的增长方式**——它不是平的，是一级一级往上跳的。


# TODO 3 · 算出「无状态的代价」这个倍数
#
# 拿两个数对比：
#   A. 实际累计输入 token（你上面加出来的那个）
#   B. 假想的「有状态 API」只需要发的量：system + 所有 user 消息，各发一次
#
# 打印 A / B。讲义里我按 20 轮估的是约 54 倍，你这次只有 6 轮，倍数会小一些，
# 但趋势应该很清楚。
#
# 然后再算一个数：如果前缀全部命中缓存（input_hit 价），这段对话要多少钱？


# TODO 4 · 回答
#
#   a) 把轮数从 6 加到 12（自己补几个问题），累计输入 token 大概会变成几倍？
#      **先预测，再跑**。预测错了比预测对了更有价值。
#
#   b) 你的表里，输入花的钱和输出花的钱哪个多？和你跑之前的直觉一致吗？
#
#   c) 现在你要把这段对话压到一半的成本，且不能换模型。列出你能想到的所有办法，
#      并按「实现成本 / 收益 / 副作用」排个序。（这一问是 L06 的预习。）
#
# 你的回答：
#   a)
#   b)
#   c)


def main() -> None:
    raise NotImplementedError("把 TODO 写完，然后删掉这一行")


if __name__ == "__main__":
    main()
