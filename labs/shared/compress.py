"""参考实现：压缩历史（Python 通道）。

对照 shared/compress.ts。

这个模块里最重要的函数不是 compress，是 **should_compress**——
决定「什么时候不压」比「怎么压」更省钱。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from shared.context_budget import (
    ContextStats,
    count_content,
    estimate_tokens,
    field_of,
    input_budget,
)
from shared.message import text_of
from shared.parse import extract_tag

Message = dict[str, Any]

# ─────────────────────────────────────────────────────────────
# 结构化摘要
# ─────────────────────────────────────────────────────────────


@dataclass
class Summary:
    #: 原始任务，**一字不改**。目标漂移是长任务的头号失败模式
    goal: str
    done: list[str] = field(default_factory=list)
    #: 发现的关键事实。文件路径、函数名、行号必须保留
    found: list[str] = field(default_factory=list)
    #: ★ 试过但失败的方法。这一节最容易漏，而它最重要——
    #: 没有它，agent 会把失败过的方法再试一遍，而且会升级成循环。
    #: 重复检测（L05）拦不住它，因为参数往往略有不同。
    failed: list[str] = field(default_factory=list)
    next: str = ""


def summary_prompt() -> str:
    """★ 「总结一下前面的对话」得到的是散文，模型下一步没法用。必须给固定结构。"""
    return """把上面的历史压缩成结构化摘要。严格按下面的标签输出，不要有别的内容。

<goal>原始任务，一字不改地照抄</goal>
<done>已完成的事，每条一行，带结论</done>
<found>发现的关键事实。文件路径、函数名、行号必须原样保留</found>
<failed>试过但失败的方法，每条写清楚失败原因</failed>
<next>下一步计划</next>

三条硬要求：
- <goal> 必须是原文，不要改写、不要概括
- <failed> 不能省。没有失败过就写「无」，但不要跳过这一节
- <found> 里的路径和行号是后续工作要用的，丢了就得重新查"""


def render_summary(s: Summary) -> str:
    def lst(xs: list[str]) -> str:
        return "\n".join(f"- {x}" for x in xs) if xs else "无"

    return "\n".join(
        [
            "<summary>",
            f"<goal>{s.goal}</goal>",
            f"<done>\n{lst(s.done)}\n</done>",
            f"<found>\n{lst(s.found)}\n</found>",
            f"<failed>\n{lst(s.failed)}\n</failed>",
            f"<next>{s.next}</next>",
            "</summary>",
        ]
    )


class SummaryError(Exception):
    """摘要没写全时要响一声——静默接受一个缺了 failed 的摘要，等于把防线关掉。"""

    def __init__(self, missing: str) -> None:
        super().__init__(
            f"摘要里缺了 <{missing}>。缺 failed 会让 agent 重试失败过的方法，缺 goal 会让目标漂移。"
        )


def parse_summary(text: str) -> Summary:
    goal = extract_tag(text, "goal")
    if not goal or not goal.strip():
        raise SummaryError("goal")
    failed = extract_tag(text, "failed")
    # ★ 注意这里必须是 `is None` 而不是 `not failed`：
    # 标签存在但内容是空字符串是合法的，标签不存在才是错误。
    # 用 `not failed` 会把两种情况混起来——这是 Python 里最常见的一类 bug。
    if failed is None:
        raise SummaryError("failed")

    def bullets(raw: str | None) -> list[str]:
        if not raw:
            return []
        out = []
        for line in raw.split("\n"):
            item = line.lstrip("-*· ").strip()
            if item and item != "无":
                out.append(item)
        return out

    return Summary(
        goal=goal.strip(),
        done=bullets(extract_tag(text, "done")),
        found=bullets(extract_tag(text, "found")),
        failed=bullets(failed),
        next=(extract_tag(text, "next") or "").strip(),
    )


# ─────────────────────────────────────────────────────────────
# 三种策略
# ─────────────────────────────────────────────────────────────


def _has_block(m: Message, kind: str) -> bool:
    content = m.get("content")
    if isinstance(content, str):
        return False
    # field_of 而不是 b.get：transcript 里 assistant 那条装的是 SDK 对象。
    return any(field_of(b, "type") == kind for b in content)




def sliding_window(messages: Sequence[Message], keep_turns: int = 6) -> list[Message]:
    """滑动窗口：只留最近 keep_turns 条。

    最便宜（不调模型），但最粗暴——早期的关键决定直接丢了。

    ★ 两个不变量必须守住，否则会构造出 API 直接拒绝的消息序列：
      1. 第一条（原始任务）永远保留
      2. 不能让一个 tool_result 失去它对应的 tool_use
    """
    if len(messages) <= keep_turns + 1:
        return list(messages)

    cut = len(messages) - keep_turns
    # 往后挪到安全的切点：切点处不能是携带 tool_result 的消息。
    while cut < len(messages) and _has_block(messages[cut], "tool_result"):
        cut += 1

    return [messages[0], *messages[cut:]]


@dataclass
class CompressResult:
    messages: list[Message]
    summary: Summary
    saved: int
    cost: dict[str, int]


async def compress(
    messages: Sequence[Message],
    call: Callable[[list[Message]], Awaitable[Any]],
    keep_recent: int = 4,
) -> CompressResult:
    """摘要压缩：让模型总结前面的历史，用结构化摘要替换。

    call 抽象成参数，让 verify 能塞假模型——和 run_agent 同一个模式。
    """
    if len(messages) < 3:
        raise ValueError("历史太短，没什么可压的。先检查 should_compress 的判断是不是有问题")

    cut = max(1, len(messages) - keep_recent)
    while cut < len(messages) and _has_block(messages[cut], "tool_result"):
        cut += 1

    to_compress = list(messages[:cut])
    recent = list(messages[cut:])
    before = sum(count_content(m["content"]) for m in to_compress)

    res = await call([*to_compress, {"role": "user", "content": summary_prompt()}])
    # text_of 同时吃 dict 块和对象块——真 SDK 给对象，假模型给 dataclass。
    # 只认一种会在换模型时才炸，而那时候你已经不记得这行代码了。
    summary = parse_summary(text_of(res.content))
    rendered = render_summary(summary)

    return CompressResult(
        messages=[messages[0], {"role": "user", "content": rendered}, *recent],
        summary=summary,
        saved=max(0, before - estimate_tokens(rendered) - count_content(messages[0]["content"])),
        cost={"input": res.usage.input_tokens, "output": res.usage.output_tokens},
    )


# ─────────────────────────────────────────────────────────────
# 什么时候不压：这个模块最值钱的部分
# ─────────────────────────────────────────────────────────────


@dataclass
class CompressDecision:
    compress: bool
    why: str
    net: float | None = None


def should_compress(
    stats: ContextStats,
    steps_left: int,
    cache_discount: float = 0.1,
) -> CompressDecision:
    """该不该压。

    ★ 只看当前长度是不够的，必须把「预计还要走多少步」算进来。

    压缩改写历史 → 前缀变了 → 从改动点往后的 KV cache 全部作废（L05x）。
    压缩之后的那一次调用要重新 prefill 全部内容，付全价。

      省下的 = (当前长度 - 目标长度) × 剩余步数 × 缓存折扣
      花掉的 = 压缩调用本身 + 一次全额 prefill

    **剩余步数少的时候，不压更便宜。**
    """
    b = stats.budget
    available = input_budget(b)

    if stats.ratio <= b.compress_at:
        return CompressDecision(
            False, f"还没到触发线（{stats.ratio * 100:.0f}% < {b.compress_at * 100:.0f}%）"
        )

    if stats.tokens > available * 0.9:
        return CompressDecision(
            True, f"已到 {stats.ratio * 100:.0f}%，撑爆的风险高于压缩的代价"
        )

    if steps_left <= 0:
        return CompressDecision(False, "没有剩余步数了，压了没人受益")

    target = available * b.compress_to
    shrink = max(0.0, stats.tokens - target)
    saved = shrink * cache_discount * steps_left
    cost = stats.tokens + target * (1 - cache_discount)
    net = saved - cost

    if net <= 0:
        return CompressDecision(
            False,
            f"不划算：只剩 {steps_left} 步，省约 {saved:.0f} tok，"
            f"但压缩加重建缓存要花约 {cost:.0f} tok",
            net,
        )

    return CompressDecision(
        True, f"划算：剩 {steps_left} 步，净省约 {net:.0f} tok（该压 {stats.top}）", net
    )
