"""
工具注册表与执行层。shared/tools.ts 的 Python 对照版。

三条设计决定和 TS 版完全一致：
  1. 工具参数是不可信输入，执行前必须校验
  2. 失败回结果，不抛异常（模型能改变结果的失败要让它看见）
  3. 错误信息里要有下一步

Python 这边形状上的一处差异：TS 用带判别字段的联合类型表达「校验成功或失败」，
这里用 dataclass。真实项目里 Python 会用 Pydantic ——
schema 和校验共用一份定义，不会出现「schema 说 required 但代码没检查」的漂移。
这里手写是为了让你看清模型到底收到了什么。L11x 会讲 Pydantic 那一套。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolResult:
    content: str
    is_error: bool = False
    log_note: str | None = None
    """给日志用，不发给模型。"""


@dataclass
class ParseOk:
    input: Any
    ok: bool = True


@dataclass
class ParseErr:
    message: str
    """给**模型**看的话，不是给开发者看的。"""

    ok: bool = False


ParseResult = ParseOk | ParseErr


@dataclass
class ToolDef:
    name: str
    description: str
    """模型唯一的判断依据。它看不到你的实现。"""

    input_schema: dict[str, Any]
    parse: Callable[[Any], ParseResult]
    run: Callable[[Any], Awaitable[ToolResult]]


def to_api_tool(t: ToolDef) -> dict[str, Any]:
    return {"name": t.name, "description": t.description, "input_schema": t.input_schema}


@dataclass
class ToolBox:
    tools: dict[str, ToolDef] = field(default_factory=dict)

    def __init__(self, tools: list[ToolDef] | None = None) -> None:
        self.tools = {}
        for t in tools or []:
            self.register(t)

    def register(self, tool: ToolDef) -> None:
        # 重名是你的 bug，不是模型的，该响
        if tool.name in self.tools:
            raise ValueError(f"工具名重复：{tool.name}")
        self.tools[tool.name] = tool

    @property
    def names(self) -> list[str]:
        return list(self.tools)

    def api_tools(self) -> list[dict[str, Any]]:
        return [to_api_tool(t) for t in self.tools.values()]

    async def execute(self, name: str, raw_input: Any) -> ToolResult:
        tool = self.tools.get(name)

        # 模型会编造工具名——那是模式补全，不是幻觉。
        # 报错时必须给出真实清单，否则它只能继续猜。
        if tool is None:
            return ToolResult(
                content=f"没有名为 {name} 的工具。可用的工具是：{'、'.join(self.names)}。",
                is_error=True,
                log_note=f"模型编造了工具名 {name}",
            )

        parsed = tool.parse(raw_input)
        if not parsed.ok:
            assert isinstance(parsed, ParseErr)
            return ToolResult(
                content=parsed.message, is_error=True, log_note=f"{name} 参数校验失败"
            )

        assert isinstance(parsed, ParseOk)
        return await tool.run(parsed.input)


def tool_uses_of(content: list[Any]) -> list[Any]:
    """从 assistant 的 content 里挑出工具调用块。"""
    out = []
    for b in content:
        kind = b.get("type") if isinstance(b, dict) else getattr(b, "type", None)
        if kind == "tool_use":
            out.append(b)
    return out


def tool_result_message(tool_uses: list[Any], results: list[ToolResult]) -> dict[str, Any]:
    """
    把结果拼成**一条** user 消息。

    两个必须做对的地方：
      · 所有结果放在同一条消息里（分成多条 = 连续两条 user = 违反交替约束）
      · 顺序跟 tool_uses 一致，不是完成顺序
        （顺序抖动 → 前缀缓存失效 + 问题无法复现）
    """
    if len(tool_uses) != len(results):
        raise ValueError(f"工具调用 {len(tool_uses)} 个但结果 {len(results)} 个，对不上")

    blocks = []
    for tu, r in zip(tool_uses, results, strict=True):
        tu_id = tu["id"] if isinstance(tu, dict) else tu.id
        block: dict[str, Any] = {"type": "tool_result", "tool_use_id": tu_id, "content": r.content}
        if r.is_error:
            block["is_error"] = True
        blocks.append(block)

    return {"role": "user", "content": blocks}


# ─────────────────────────────────────────────────────────────────────────────
# 校验小工具
# ─────────────────────────────────────────────────────────────────────────────


def require_string(raw: Any, field_name: str) -> ParseResult:
    """
    取一个必填的非空字符串。

    模型会传 None、传数字、传对象。直接取 raw["path"] 往下走的话，
    报错的地方离原因很远（通常在某个文件操作里）。

    注意 Python 这边有个 TS 没有的坑：bool 是 int 的子类，
    但反过来 isinstance(True, str) 是 False，所以这里不用特别处理。
    真正要小心的是**不能用 `if not raw` 判断对象**——空 dict 也是 falsy。
    """
    if not isinstance(raw, dict):
        return ParseErr(f"参数必须是一个对象，收到的是 {type(raw).__name__}。")
    v = raw.get(field_name)
    if not isinstance(v, str) or not v.strip():
        return ParseErr(f"缺少必填参数 {field_name}（需要一个非空字符串）。")
    return ParseOk(input=v)


def optional_int(raw: Any, field_name: str, default: int, lo: int, hi: int) -> int:
    """
    取一个可选整数，越界**夹回**范围内。

    为什么夹回而不报错：模型经常越界（schema 写 maximum 50 收到 500 是常事）。
    这不是攻击也不是致命错误，报错只是浪费一个往返。
    """
    if not isinstance(raw, dict):
        return default
    v = raw.get(field_name)
    if v is None or isinstance(v, bool):
        return default
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))
