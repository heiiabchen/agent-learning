"""
L04 · 任务一（Python 通道）：工具注册表与参数校验。

跑法：uv run python -m l04.schema        验证：uv run python -m l04.verify

`shared/tools.py` 里有我的实现。**先别看。**

完整任务说明见 l04/schema.ts。Python 这边有两个坑要提醒：

1. **别用 `if not raw` 判断参数对象。** 空 dict 是 falsy，
   而「模型传了个空对象」和「模型什么都没传」要分开处理。用 isinstance。

2. **bool 是 int 的子类。** optional_int 里 int(True) == 1，
   所以模型传 `depth: true` 时你会安静地得到 1。要不要拦取决于场景，
   但你得知道它会发生——这类隐式转换是 Python 里最难查的一类 bug。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any


@dataclass
class ToolResult:
    content: str
    is_error: bool = False
    log_note: str | None = None


@dataclass
class ParseOk:
    input: Any
    ok: bool = True


@dataclass
class ParseErr:
    message: str
    ok: bool = False


ParseResult = ParseOk | ParseErr


@dataclass
class ToolDef:
    name: str
    description: str
    input_schema: dict[str, Any]
    parse: Callable[[Any], ParseResult]
    run: Callable[[Any], Awaitable[ToolResult]]


# ─────────────────────────────────────────────────────────────────────────────
# TODO 1 · require_string(raw, field_name)
#
#   要处理的输入（模型全都会给你）：
#     raw 不是 dict（None、str、list）／字段缺失／值是数字或 None／空字符串
#
#   返回的 message 是给**模型**看的，不是给开发者看的。
#
# TODO 2 · optional_int(raw, field_name, default, lo, hi)
#
#   越界**夹回**范围，不报错也不退默认值。缺失／非数字才用默认值。
#
# TODO 3 · ToolBox
#
#   ★ execute 里工具名查不到时，要把真实工具清单列给模型，否则它只能继续猜。
#
# TODO 4 · tool_uses_of(content)
#
#   注意 content 里的块可能是 dict 也可能是 SDK 对象，两种都要能取 type。
#
# TODO 5 · tool_result_message(tool_uses, results)
#
#   ★ 所有结果放同一条 user 消息；顺序跟 tool_uses 一致，不是完成顺序。
# ─────────────────────────────────────────────────────────────────────────────


def require_string(raw: Any, field_name: str) -> ParseResult:
    raise NotImplementedError("TODO 1")


def optional_int(raw: Any, field_name: str, default: int, lo: int, hi: int) -> int:
    raise NotImplementedError("TODO 2")


class ToolBox:
    def __init__(self, tools: list[ToolDef] | None = None) -> None:
        raise NotImplementedError("TODO 3")

    def register(self, tool: ToolDef) -> None:
        raise NotImplementedError("TODO 3")

    @property
    def names(self) -> list[str]:
        raise NotImplementedError("TODO 3")

    def api_tools(self) -> list[dict[str, Any]]:
        raise NotImplementedError("TODO 3")

    async def execute(self, name: str, raw_input: Any) -> ToolResult:
        raise NotImplementedError("TODO 3")


def tool_uses_of(content: list[Any]) -> list[Any]:
    raise NotImplementedError("TODO 4")


def tool_result_message(tool_uses: list[Any], results: list[ToolResult]) -> dict[str, Any]:
    raise NotImplementedError("TODO 5")
