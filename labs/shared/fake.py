"""
脚本化的假模型。shared/fake.ts 的 Python 对照版。

存在的理由和 TS 版一样：**测 agent loop 不能用真模型。**
真模型不确定、慢、花钱，而且你没法让它按你想要的方式失败。

Python 这边模拟取消的方式和 TS 不同，值得注意：
TS 那边监听 AbortSignal 的 'abort' 事件然后 reject；
这里靠 asyncio.sleep 天然可被取消——await 点就是取消点。

这是两种取消模型的根本差异：TS 的取消是**信号 + 你自己检查**，
Python 的取消是**在 await 点抛异常**。后者更自动，但也更容易被
一个宽泛的 except 意外吞掉。
"""

from __future__ import annotations

import asyncio
import copy
from dataclasses import dataclass, field
from typing import Any, Literal

_counter = 0


@dataclass
class FakeTurn:
    tool_uses: list[dict[str, Any]] = field(default_factory=list)
    """每项形如 {"name": "read_file", "input": {...}}。空表示直接给最终答案。"""

    text: str = ""
    stop_reason: str | None = None
    """覆盖 stop_reason，用来测异常分支（比如 max_tokens 截断）。"""

    usage: tuple[int, int] = (100, 50)
    """(input_tokens, output_tokens)"""


@dataclass
class FakeUsage:
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0


@dataclass
class FakeBlock:
    type: str
    text: str = ""
    id: str = ""
    name: str = ""
    input: Any = None


@dataclass
class FakeMessage:
    id: str
    model: str
    content: list[FakeBlock]
    stop_reason: str | None
    usage: FakeUsage
    role: str = "assistant"


def _make(turn: FakeTurn, model: str) -> FakeMessage:
    global _counter
    content: list[FakeBlock] = []
    if turn.text:
        content.append(FakeBlock(type="text", text=turn.text))
    for tu in turn.tool_uses:
        _counter += 1
        content.append(
            FakeBlock(
                type="tool_use",
                id=f"toolu_fake_{_counter}",
                name=tu["name"],
                input=tu.get("input"),
            )
        )
    has_tools = bool(turn.tool_uses)
    return FakeMessage(
        id=f"msg_fake_{_counter}",
        model=model,
        content=content,
        stop_reason=turn.stop_reason or ("tool_use" if has_tools else "end_turn"),
        usage=FakeUsage(*turn.usage),
    )


class FakeModel:
    """
    model 默认用一个**真实存在于 PRICING 里**的名字。

    这不是随便选的：Ledger 遇到不认识的模型会抛错而不是按 0 计价
    （L02 那条纪律——「没测到」和「是 0」是两个不同的结论）。
    所以假模型不能自称 'fake-model'，否则一算账就炸。
    """

    def __init__(
        self,
        script: list[FakeTurn],
        after: Literal["repeat_last", "final", "throw"] = "final",
        delay_ms: int = 0,
        model: str = "deepseek-v4-flash",
    ) -> None:
        self.script = script
        self.after = after
        self.delay_ms = delay_ms
        self.model = model
        self.calls: list[list[dict]] = []
        self._i = 0

    async def call(self, messages: list[dict]) -> FakeMessage:
        # 深拷贝一份快照。不拷的话调用方后续 append 会改到这里，
        # 断言就变成了在看最终状态而不是当时状态——这类假绿很难发现。
        self.calls.append(copy.deepcopy(messages))

        if self.delay_ms:
            # await 点就是取消点。外面 cancel() 时这里会抛 CancelledError。
            await asyncio.sleep(self.delay_ms / 1000)

        if self._i < len(self.script):
            turn = self.script[self._i]
            self._i += 1
            return _make(turn, self.model)

        if self.after == "repeat_last":
            return _make(self.script[-1] if self.script else FakeTurn(), self.model)
        if self.after == "throw":
            raise RuntimeError("假模型：脚本用完了")
        return _make(FakeTurn(text="（假模型：脚本用完，给个最终答案）"), self.model)
