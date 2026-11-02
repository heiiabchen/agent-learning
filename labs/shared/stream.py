"""
流式读取器。shared/stream.ts 的 Python 对照版。

处理掉 L02 第五节列的全部边界条件：
  · 按 index 分桶，思考块 / 正文块 / 工具调用块互不干扰
  · delta 有多种类型，字段名各不相同
  · usage 被劈成两半：input 在 message_start，output 在 message_delta
  · 没收到 message_stop 就是失败，哪怕没有 error 事件
  · 流内 error 事件
  · ping 安静忽略

和 TS 版最大的形状差异：这里是**同步**的生成器消费。
Python 的 SDK 给的流对象既能同步迭代也能异步迭代，简单脚本用同步版更省事。
真需要一边流一边干别的（比如同时喂给 WebSocket）再上 async。
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from time import perf_counter
from typing import Any

from shared.ledger import Usage


@dataclass
class StreamBlock:
    index: int
    type: str
    text: str = ""
    """text / thinking 块的文本；工具调用块这里是拼好的 JSON 字符串。"""

    tool_name: str | None = None
    tool_id: str | None = None


@dataclass
class StreamResult:
    text: str
    thinking: str
    blocks: list[StreamBlock]
    stop_reason: str | None
    usage: Usage
    id: str
    model: str
    ttft_ms: float
    total_ms: float


class StreamAbortedError(Exception):
    """流没能正常走完。partial 里是已经累积的部分，交给调用方决定怎么收拾。"""

    def __init__(self, message: str, partial: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.partial = partial or {}


# delta 类型 → 取哪个字段。写死成 .text 会在思考块上拿到 None，
# 然后字符串里出现字面量 "None"。
_DELTA_FIELD = {
    "text_delta": "text",
    "thinking_delta": "thinking",
    "input_json_delta": "partial_json",
}


@dataclass
class _State:
    buckets: dict[int, StreamBlock] = field(default_factory=dict)
    msg_id: str = ""
    model: str = ""
    stop_reason: str | None = None
    usage: Usage = field(default_factory=lambda: Usage(0, 0))
    saw_stop: bool = False
    first_text_at: float | None = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "blocks": [self.buckets[i] for i in sorted(self.buckets)],
            "id": self.msg_id,
            "model": self.model,
            "usage": self.usage,
        }


def read_stream(
    stream: Iterable[Any],
    on_text: Callable[[str], None] | None = None,
) -> StreamResult:
    """
    消费一个流，返回聚合好的结果。

    on_text 是给 UI 用的：每来一小块**正文**就调一次。
    故意只回调正文——思考内容通常不直接给用户看（要看就读返回值的 thinking）。
    """
    started = perf_counter()
    st = _State()

    try:
        for event in stream:
            _handle(event, st, on_text)
    except StreamAbortedError:
        raise
    except Exception as err:
        raise StreamAbortedError(f"流中断：{err}", st.snapshot()) from err

    # 关键的一条：循环正常退出不等于流正常结束。
    # 连接被中间代理掐掉时，for 会安静地结束，一个 error 事件都没有。
    if not st.saw_stop:
        raise StreamAbortedError("流没有收到 message_stop 就结束了，内容不完整", st.snapshot())

    done = perf_counter()
    blocks = [st.buckets[i] for i in sorted(st.buckets)]

    return StreamResult(
        text="".join(b.text for b in blocks if b.type == "text"),
        thinking="".join(b.text for b in blocks if b.type == "thinking"),
        blocks=blocks,
        stop_reason=st.stop_reason,
        usage=st.usage,
        id=st.msg_id,
        model=st.model,
        ttft_ms=((st.first_text_at or done) - started) * 1000,
        total_ms=(done - started) * 1000,
    )


def _handle(event: Any, st: _State, on_text: Callable[[str], None] | None) -> None:
    kind = event.type

    if kind == "message_start":
        st.msg_id = event.message.id
        st.model = event.message.model
        # input_tokens 在这里就知道了；output 还得等 message_delta
        st.usage.input_tokens = getattr(event.message.usage, "input_tokens", 0) or 0
        st.usage.cache_read_input_tokens = (
            getattr(event.message.usage, "cache_read_input_tokens", 0) or 0
        )
        st.usage.cache_creation_input_tokens = (
            getattr(event.message.usage, "cache_creation_input_tokens", 0) or 0
        )

    elif kind == "content_block_start":
        block = event.content_block
        st.buckets[event.index] = StreamBlock(
            index=event.index,
            type=block.type,
            tool_name=getattr(block, "name", None),
            tool_id=getattr(block, "id", None),
        )

    elif kind == "content_block_delta":
        bucket = st.buckets.get(event.index)
        if bucket is None:
            return
        delta_type = event.delta.type
        field_name = _DELTA_FIELD.get(delta_type)
        if field_name is None:
            return
        chunk = getattr(event.delta, field_name, "") or ""
        bucket.text += chunk
        if delta_type == "text_delta" and chunk:
            if st.first_text_at is None:
                st.first_text_at = perf_counter()
            if on_text:
                on_text(chunk)

    elif kind == "message_delta":
        st.stop_reason = getattr(event.delta, "stop_reason", None)
        # 这里才是 output_tokens 的家
        st.usage.output_tokens = getattr(event.usage, "output_tokens", 0) or 0

    elif kind == "message_stop":
        st.saw_stop = True

    elif kind == "error":
        # HTTP 已经 200 了才来的那种错误
        msg = getattr(getattr(event, "error", None), "message", "未知")
        raise StreamAbortedError(f"流内错误：{msg}（HTTP 已经 200 了才来的那种）", st.snapshot())

    # 其余（ping 和将来新增的事件类型）安静忽略
