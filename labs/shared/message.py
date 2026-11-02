"""
消息与内容块的处理工具。shared/message.ts 的 Python 对照版。

解决 L02 第二节讲的两件事：
  · content 有 str 和 list[ContentBlock] 两种形态。
  · messages 必须严格交替，而违反它的通常是 bug 而不是手写。
"""

from __future__ import annotations

from typing import Any


def text_of(content: Any) -> str:
    """
    从内容块里把纯文本拼出来。只取 text 块——thinking 和 tool_use 都不算正文。

    对照 TS 版会发现一个差异：TS 那边 `b.type === 'text'` 之后编译器就知道
    `b.text` 存在了（可辨识联合的窄化）。Python 没有这个，所以这里用
    getattr 兜一层——SDK 对象和手写 dict 都能进来。

    这不是 Python 的缺点，是**你读别人代码时必须多花的注意力**：
    动态语言里「这个字段一定存在」是靠人记的，不是靠编译器保证的。
    """
    if isinstance(content, str):
        return content

    parts: list[str] = []
    for b in content:
        block_type = b.get("type") if isinstance(b, dict) else getattr(b, "type", None)
        if block_type != "text":
            continue
        parts.append(b["text"] if isinstance(b, dict) else b.text)
    return "".join(parts)


def tool_calls_of(content: Any) -> list[Any]:
    """一次响应里模型要调的工具。没有工具调用时是空列表。"""
    if isinstance(content, str):
        return []
    return [b for b in content if getattr(b, "type", None) == "tool_use"]


def normalize_messages(msgs: list[dict]) -> list[dict]:
    """
    把相邻同角色的消息合并，保证严格交替。

    为什么需要它：用户连点两次、前端没防抖、上一轮请求失败留下孤儿消息——
    这些都会产生连续同角色，而 API 对此的回应是 400，且不可重试。

    返回新列表、不改原对象。原地修改会在调用方持有同一份引用时
    产生极难查的串话（历史被悄悄改写）。
    """
    out: list[dict] = []

    for m in msgs:
        if out and out[-1]["role"] == m["role"]:
            # 合并时用空行分隔，保留边界感，否则模型会把两段读成一句话
            merged = f"{text_of(out[-1]['content'])}\n\n{text_of(m['content'])}"
            out[-1] = {"role": out[-1]["role"], "content": merged}
            continue
        out.append(dict(m))

    return out


def ends_with_user(msgs: list[dict]) -> bool:
    """会话历史不该以 assistant 结尾（除非你在故意做 prefill，见 L03）。"""
    return bool(msgs) and msgs[-1]["role"] == "user"
