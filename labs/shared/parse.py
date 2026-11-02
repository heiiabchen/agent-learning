"""
从模型输出里抠出结构化数据。shared/parse.ts 的 Python 对照版。

逻辑和 TS 版完全一致，包括那条最重要的设计决定：
**被截断的 JSON 必须抛错，不能补括号。** 补出来能 parse，但内容是残缺的。

Python 这边有一处真实差异值得注意：json.loads 比 JSON.parse **严格**。
它不接受 NaN 之外的裸值扩展、对重复 key 的处理也不同。
但有一点反而更宽松：json.loads 默认接受 Infinity / NaN / -Infinity，
而 JSON.parse 会拒绝。模型偶尔真的会输出 NaN（尤其是让它算平均值的时候），
于是同一份输出在 Python 侧「解析成功」拿到 float('nan')，在 TS 侧直接报错。
静默拿到 NaN 是更糟的那种——它会一路流到下游，最后表现为某个统计数字不对。
所以这里显式关掉了它。
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

FENCE = re.compile(r"```(?:[a-zA-Z]*)\n(.*?)```", re.DOTALL)


class ParseError(Exception):
    def __init__(self, message: str, raw: str) -> None:
        super().__init__(message)
        self.raw = raw


def strip_fences(text: str) -> str:
    m = FENCE.search(text)
    return m.group(1) if m else text


def _find_json_span(text: str) -> tuple[int, int] | None:
    """
    找第一个完整 JSON 值的范围。

    关键点和 TS 版一样：必须跳过字符串内部的括号。
    {"note": "}"} 在朴素实现里会提前收工，而这类内容在代码场景里很常见。
    """
    m = re.search(r"[\[{]", text)
    if not m:
        return None

    start = m.start()
    opener = text[start]
    closer = "}" if opener == "{" else "]"

    depth = 0
    in_string = False
    escaped = False

    for i in range(start, len(text)):
        ch = text[i]

        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue

        if ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return start, i + 1

    # 没闭合 = 截断。和「格式错」是两种故障，处置不同。
    return None


def _reject_nonfinite(value: Any) -> None:
    """json.loads 默认吃 NaN / Infinity，这里显式拒绝，理由见模块头。"""
    raise ValueError(f"不接受非有限数值：{value}")


def extract_json(
    text: str,
    *,
    allow_trailing_comma: bool = False,
    on_repair: Callable[[str], None] | None = None,
) -> Any:
    cleaned = strip_fences(text).strip()
    if not cleaned:
        raise ParseError("模型什么都没返回（正文为空，很可能预算被思考块吃光了）", text)

    span = _find_json_span(cleaned)
    if span is None:
        truncated = (
            "JSON 没有闭合，几乎肯定是被 max_tokens 截断了。"
            "不要补括号——补出来能 parse，但内容是残缺的。"
        )
        no_json = (
            "输出里找不到 JSON 的开头。检查 prompt 有没有真的要求 JSON，或者 prefill 有没有生效。"
        )
        has_open = re.search(r"[\[{]", cleaned) is not None
        raise ParseError(truncated if has_open else no_json, text)

    body = cleaned[span[0] : span[1]]

    try:
        return json.loads(body, parse_constant=_reject_nonfinite)
    except Exception as err:
        if allow_trailing_comma:
            repaired = re.sub(r",(\s*[}\]])", r"\1", body)
            if repaired != body:
                try:
                    value = json.loads(repaired, parse_constant=_reject_nonfinite)
                    if on_repair:
                        on_repair("去掉了尾随逗号")
                    return value
                except Exception:
                    pass
        raise ParseError(f"JSON 结构找到了但解析失败：{err}", text) from err


def extract_tag(text: str, tag: str) -> str | None:
    """
    抠出 <tag>...</tag> 之间的内容。

    只有开标签的情况必须能处理：配合 stop_sequences 用时，
    命中停止串意味着闭合标签**不会**出现在输出里（L02 讲过）。
    那是最正常的情况，不是异常。
    """
    open_at = text.find(f"<{tag}>")
    if open_at == -1:
        return None
    start = open_at + len(tag) + 2
    close_at = text.find(f"</{tag}>", start)
    return (text[start:] if close_at == -1 else text[start:close_at]).strip()
