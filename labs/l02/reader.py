"""
L02 · 任务二（Python 通道）：写你自己的流式读取器。

跑法：uv run python -m l02.reader        验证：uv run python -m l02.verify

`shared/stream.py` 里有我的实现。**先别看。**

完整的六条要求见 l02/reader.ts，一条不少。Python 这边额外两点：

  1. 用 `with client.messages.create(..., stream=True) as stream:`。
     退出 with 时连接必定被关，哪怕你在中间 break 了。
     TS 那边靠 async iterator 的 return() 钩子，很容易漏。

  2. 别用 `event.delta.text` 一把梭。三种 delta 的字段名不同，
     Python 拿不到会给你 None，拼进字符串就是字面量 "None"——
     比 TS 的 "undefined" 更难在日志里一眼认出来。
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

from shared.ledger import Usage


@dataclass
class StreamBlock:
    index: int
    type: str
    text: str = ""
    tool_name: str | None = None
    tool_id: str | None = None


@dataclass
class StreamResult:
    text: str = ""
    thinking: str = ""
    blocks: list[StreamBlock] = field(default_factory=list)
    stop_reason: str | None = None
    usage: Usage = field(default_factory=lambda: Usage(0, 0))
    id: str = ""
    model: str = ""
    ttft_ms: float = 0
    total_ms: float = 0


class StreamAbortedError(Exception):
    def __init__(self, message: str, partial: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.partial = partial or {}


# ─────────────────────────────────────────────────────────────────────────────
# TODO · 实现 read_stream
#
# 六件必须做对的事：
#
# 1 · 按 index 分桶（dict[int, StreamBlock]）。
#     所有 delta 累加到同一个字符串上，思考和正文就糊成一坨。
#
# 2 · delta 字段名按类型区分：
#       text_delta        → .text
#       thinking_delta    → .thinking
#       input_json_delta  → .partial_json
#
# 3 · usage 劈成两半：input 在 message_start，output 在 message_delta
#    （同一个事件还带 stop_reason，漏了它你就不知道有没有被截断）。
#
# 4 · 没收到 message_stop 就是失败。for 循环会安静地正常退出，
#     一个错误都不抛。判据只能是显式的 saw_stop 标记。
#
# 5 · 流内 error 事件要抛错，并把已累积的部分放进 partial。
#
# 6 · ping 安静忽略。
#
# TTFT 只算到第一个**正文** delta。
# ─────────────────────────────────────────────────────────────────────────────


def read_stream(
    stream: Iterable[Any],
    on_text: Callable[[str], None] | None = None,
) -> StreamResult:
    raise NotImplementedError("TODO 还没实现")


# ─────────────────────────────────────────────────────────────────────────────
# TODO 2 · 用它跑一次真请求
#
#   要一个会触发思考模式的问题，确认：
#     · blocks 里有两个块，type 分别是 thinking 和 text
#     · text 里没有混进思考内容
#     · usage.output_tokens 不是 0
#     · stop_reason 是 'end_turn'
#
#   然后回答：thinking 块的 token 算不算进 output_tokens？
#   去看数字，别猜。这个答案会影响你 L15 怎么算成本。
# ─────────────────────────────────────────────────────────────────────────────
