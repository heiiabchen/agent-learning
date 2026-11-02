"""
L00 · 任务二（Python 通道）：改成流式，让文字一个字一个字出现。

跑法：uv run python -m l00.stream
参考实现：uv run python -m l00.solutions.stream

任务说明以 l00/stream.ts 为准。Python 这边有两个额外要知道的点：

  1. 打印不换行要用 print(x, end="", flush=True)。
     少了 flush=True，输出会攒在缓冲区里一次性吐出来，
     你会以为流式没生效——这是 Python 流式最常见的假故障。

  2. SDK 给了两条路：
       client.messages.create(..., stream=True)   → 迭代原始事件，和 TS 版一一对应
       with client.messages.stream(...) as s:     → Python 更地道的封装，自带累积
     先用第一种，因为 agent loop 里你需要看到原始事件。
"""

from shared.config import create_client, get_provider

provider = get_provider()
client = create_client(provider)

# ─────────────────────────────────────────────────────────────────────────────
# TODO 1 · 用 stream=True 发请求，边收边打印
#
#   with client.messages.create(..., stream=True) as stream:
#       for event in stream:
#           ...
#
# 关心的事件类型和 TS 版一样：
#   · message_start          —— 开始了，input_tokens 在 event.message.usage 里
#   · content_block_delta    —— 一小块内容，在 event.delta 里
#   · message_delta          —— 结束信息，output_tokens 在 event.usage 里
#   · message_stop           —— 结束
#
# delta 有两种：text_delta（正文，取 .text）和 thinking_delta（思考，取 .thinking）。
# DeepSeek V4 默认开思考模式，所以你一定会收到后者。
# ─────────────────────────────────────────────────────────────────────────────


# TODO 2 · 量一下 TTFT 和总时长
#
#   记三个时间点：请求发出、收到第一个内容块、流结束。用 time.perf_counter()。
#
#   然后做这个对比实验，它是本节最有价值的一步：
#   把问题换成一个需要长回答的，再跑一次。
#   你会看到 TTFT 几乎没变，总时长翻了好几倍。
#
#   流式没让总时间快一点，但把用户的等待感从「总时长」缩短成了「首字延迟」。


# TODO 3 · 想一想（不用写代码，但本节的设计题会考这个判断）
#
#   如果这是一个 Web 应用，服务端拿到这个流之后要转发给浏览器。
#   L00 讲过的那个「缓冲区拼接」的坑会在哪一层出现？为什么用 SDK 时你没遇到？
