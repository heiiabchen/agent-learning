"""
L00 · 任务一（Python 通道）：发出你人生第一个 LLM 请求。

跑法：uv run python -m l00.hello
参考实现：uv run python -m l00.solutions.hello

任务说明以 l00/hello.ts 为准，这里只标 Python 特有的地方。
两边都写一遍不是浪费时间——同一个 API 在两套语言里的形状差异，
恰好就是你以后读别人 agent 代码时最容易卡住的地方。
"""

from shared.config import create_client, get_provider, log_usage

provider = get_provider()
client = create_client(provider)

print(f"provider={provider.name} model={provider.model_main}\n")

# ─────────────────────────────────────────────────────────────────────────────
# TODO 1 · 发一个请求，把模型的回答打印出来
#
#   msg = client.messages.create(model=..., max_tokens=..., messages=[...])
#
# Python 特有的三点：
#
# · 参数是关键字参数而不是一个 dict。`create({...})` 会直接报错。
#
# · messages 里每项是 {"role": "user", "content": "..."}，字符串键。
#   同样没有 role: "system"——system 是 create() 的顶层参数，见 TODO 3。
#
# · msg.content 是内容块的**列表**，不是字符串。挑出 block.type == "text" 的那些。
#   TS 那边编译器会逼你处理这件事；Python 不会，它会让你一路跑到
#   AttributeError 才告诉你。这是动态类型的代价，也是这个练习值得在两边都做一遍的原因。
# ─────────────────────────────────────────────────────────────────────────────


# TODO 2 · 打印这次调用消耗的 token
#
#   log_usage("hello", msg.usage)
#
# 从第一天就看账是这门课的规矩。


# TODO 3 · 加一个 system prompt，要求它「只用一句话回答」，然后重新跑一次
#
#   client.messages.create(..., system="只用一句话回答")
#
# 跑完对比两件事：输出 token 数，以及整个请求的墙上时间（time.perf_counter() 前后夹一下）。
# 你应该会看到输出 token 少了很多，耗时也跟着明显下降——这就是「输出长度主导总时长」。
