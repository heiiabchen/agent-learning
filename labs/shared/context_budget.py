"""参考实现：上下文的计量、分区与预算（Python 通道）。

对照 shared/context.ts。

文件名是 context_budget 而不是 context，因为 Python 标准库里有个
contextlib，而 `import context` 这种裸名字在 sys.path 上很容易撞——
这是 Python 特有的一类麻烦，起名时值得多想一秒。
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

# ─────────────────────────────────────────────────────────────
# 计量
# ─────────────────────────────────────────────────────────────

_CJK = re.compile(r"[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]")


def estimate_tokens(text: str, factor: float = 1.0) -> int:
    """token 粗估。

    ★ 为什么不用 tiktoken：**它算的是 OpenAI 的分词器，而我们用 DeepSeek。**
    中文上的差异能到 20% 以上（L01 讲过 BPE 依赖训练语料）。

    那个误差的坏处不是「不准」，是**它假装准**——你会看到一个精确的数字，
    基于它做压缩决策，然后在以为还有余量的时候撞上限。

    Python 这边这个坑格外容易踩，因为 `pip install tiktoken` 太顺手了。

    一个带着已知误差的估计，比一个假装精确的错误值有用得多。
    """
    units = 0.0
    for ch in text:
        units += 0.6 if _CJK.match(ch) else 0.25
    # 向上取整。这里的精度需求是"别低估"，不是"精确"。
    return math.ceil(units * factor)


class UncountedBlockError(Exception):
    """未知的块类型要响一声，不能静默跳过——跳过的往往正是最大的那一块。"""

    def __init__(self, block_type: str) -> None:
        super().__init__(
            f"没算过的块类型：{block_type}。"
            "静默跳过它会让预算数字系统性偏小，然后你在以为还有余量的时候撞上限。"
        )
        self.block_type = block_type


def field_of(block: Any, name: str, default: Any = None) -> Any:
    """取一个块的字段，dict 和对象都能取。

    ★ 这个helper在 TS 那边不需要，Python 这边必须有。

    原因是 transcript 里的 assistant 消息装的是 **SDK 返回的模型对象**
    （L05 的 run_agent 把 res.content 原样放回去了），而 user 消息里
    是你手写的 dict。同一个 list 里两种形态混着——
    `block.get("type")` 会在遇到 SDK 对象时抛 AttributeError。

    这不是能靠"统一成 dict"绕开的：把 SDK 对象转成 dict 会丢掉
    SDK 自己的校验，而且下一轮还要转回去。老实兼容两种形态更便宜。
    """
    if isinstance(block, dict):
        return block.get(name, default)
    return getattr(block, name, default)


def _json(value: Any) -> str:
    """序列化成字符串用于计数。

    ensure_ascii=False 是关键：默认的 True 会把中文变成 \\uXXXX，
    一个汉字从 1 个字符变成 6 个，估算直接废掉。TS 的 JSON.stringify 没这个问题。

    default=str 兜住 SDK 对象——它们不是 JSON 可序列化的，
    而这里只需要一个长度大致正确的字符串。
    """
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


def _stringify_result(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for b in content:
            if field_of(b, "type") == "text":
                out.append(str(field_of(b, "text", "")))
            else:
                out.append(_json(b))
        return "\n".join(out)
    return _json(content) if content is not None else ""


def count_content(content: Any, factor: float = 1.0) -> int:
    """数一条消息的 content。

    ★ 最常见的 bug 是 `if isinstance(content, str)` 之后就不管别的了——
    而 tool_use / tool_result 正是 agent 上下文里最大的那两块。
    """
    if isinstance(content, str):
        return estimate_tokens(content, factor)

    total = 0
    for block in content:
        kind = field_of(block, "type")
        if kind == "text":
            total += estimate_tokens(str(field_of(block, "text", "")), factor)
        elif kind == "tool_use":
            total += estimate_tokens(str(field_of(block, "name", "")), factor)
            total += estimate_tokens(_json(field_of(block, "input", {})), factor)
        elif kind == "tool_result":
            total += estimate_tokens(_stringify_result(field_of(block, "content")), factor)
        elif kind in ("image", "document"):
            # 图片的 token 数由分辨率决定，估不准。给个保守的常数，
            # 而且**宁可估高**——估高的后果是早压一点，估低的后果是撞上限。
            total += 1500
        else:
            raise UncountedBlockError(str(kind))
    return total


# ─────────────────────────────────────────────────────────────
# 分区与预算
# ─────────────────────────────────────────────────────────────

Zone = Literal["system", "tool_defs", "task", "summary", "work"]

ZONES: tuple[Zone, ...] = ("system", "tool_defs", "task", "summary", "work")


@dataclass(frozen=True)
class Budget:
    window: int = 128_000
    #: 给输出留的量。留白不是浪费——见 L06 那三条理由。
    reserve_output: int = 16_000
    compress_at: float = 0.6
    #: 压到多少为止。**必须比 compress_at 小一截**，否则会在触发线附近反复压缩。
    compress_to: float = 0.3


DEFAULT_BUDGET = Budget()


def input_budget(b: Budget) -> int:
    """可用于输入的额度。所有比例都相对它算，不相对 window。"""
    return b.window - b.reserve_output


@dataclass
class ContextStats:
    tokens: int
    ratio: float
    breakdown: dict[Zone, int]
    top: Zone
    budget: Budget = field(default=DEFAULT_BUDGET)


def measure(
    system: str,
    tools: Sequence[dict[str, Any]],
    messages: Sequence[dict[str, Any]],
    budget: Budget = DEFAULT_BUDGET,
    factor: float = 1.0,
    summary_tokens: int = 0,
) -> ContextStats:
    breakdown: dict[Zone, int] = {
        "system": estimate_tokens(system, factor),
        # ★ 工具定义不在 messages 里，但每一步都要发。忘了算它是这一节的常见 bug。
        "tool_defs": sum(
            estimate_tokens(
                str(t.get("name", ""))
                + str(t.get("description", ""))
                + json.dumps(t.get("input_schema", {}), ensure_ascii=False),
                factor,
            )
            for t in tools
        ),
        "task": 0,
        "summary": summary_tokens,
        "work": 0,
    }

    for i, m in enumerate(messages):
        n = count_content(m["content"], factor)
        if i == 0:
            breakdown["task"] += n
        else:
            breakdown["work"] += n
    breakdown["work"] = max(0, breakdown["work"] - summary_tokens)

    tokens = sum(breakdown.values())
    top = max(breakdown.items(), key=lambda kv: kv[1])[0]
    return ContextStats(
        tokens=tokens,
        ratio=tokens / input_budget(budget),
        breakdown=breakdown,
        top=top,
        budget=budget,
    )


def format_stats(s: ContextStats) -> str:
    """给人看的一行摘要。日志里每步打一条，比事后翻 transcript 有用得多。"""
    parts = [
        f"{z} {n}({round(n / s.tokens * 100)}%)"
        for z, n in sorted(s.breakdown.items(), key=lambda kv: -kv[1])
        if n > 0
    ]
    return f"{s.tokens} tok · {round(s.ratio * 100)}% of budget · " + " · ".join(parts)


# ─────────────────────────────────────────────────────────────
# 校准
# ─────────────────────────────────────────────────────────────


class Calibrator:
    """用服务端返回的真实 usage 校准估算系数。

    估算值用来做决策（决策必须在调用**之前**做），真实值用来修正系数。
    服务端的 usage 是唯一权威的数字，但它只在调用之后才有。
    """

    MAX_SAMPLES = 20

    def __init__(self) -> None:
        self._samples: list[tuple[int, int]] = []

    @property
    def count(self) -> int:
        return len(self._samples)

    @property
    def factor(self) -> float:
        """真实 token ≈ 估算 token × factor。"""
        if not self._samples:
            return 1.0
        est = sum(e for e, _ in self._samples)
        real = sum(r for _, r in self._samples)
        return real / est if est else 1.0

    @property
    def drift(self) -> float:
        return abs(self.factor - 1.0)

    def record(self, estimated: int, actual_input_tokens: int) -> None:
        if estimated <= 0:
            return
        self._samples.append((estimated, actual_input_tokens))
        # 只保留最近的样本：模型和内容分布都会变，老样本会拖累系数。
        if len(self._samples) > self.MAX_SAMPLES:
            self._samples.pop(0)


# ─────────────────────────────────────────────────────────────
# 源头裁剪：手段一
# ─────────────────────────────────────────────────────────────


def paginate(
    text: str,
    offset: int = 0,
    limit: int = 200,
    hint: Callable[[int], str] | None = None,
) -> str:
    """按行分页，并且**在截断处告诉模型怎么拿下一段**。

    ★ 这是这一节最重要的一个函数，因为不给出路的截断会造出死循环：
    模型需要后面的内容，看到「已截断」但不知道怎么拿，于是重试同样的调用。

    三个要素缺一不可：给了什么、缺了多少、怎么拿。

    Python 的坑：负数 offset 在切片里有别的含义（从末尾数），
    所以要显式夹紧，否则 `lines[-5:]` 会静默返回最后五行。
    """
    lines = text.split("\n")
    total = len(lines)
    offset = max(0, offset)

    if offset >= total and total > 0:
        return f"[offset={offset} 超出范围，文件共 {total} 行]"

    chunk = lines[offset : offset + limit]
    end = offset + len(chunk)
    body = "\n".join(chunk)

    if end >= total and offset == 0:
        return body

    if end >= total:
        tail = f"[第 {offset + 1}-{end} 行，共 {total} 行，已到末尾]"
    else:
        how = hint(end) if hint else f"要看后面用 offset={end}"
        tail = f"[第 {offset + 1}-{end} 行，共 {total} 行。{how}]"

    return f"{body}\n{tail}"


@dataclass
class Hit:
    path: str
    line: int
    text: str


def summarize_hits(hits: Sequence[Hit], max_hits: int = 30) -> str:
    """搜索结果只给定位信息，不给正文。

    架构理解需要的是骨架而不是实现细节。
    """
    lines = [f"{h.path}:{h.line}  {h.text.strip()[:100]}" for h in hits[:max_hits]]
    if len(hits) > max_hits:
        lines.append(f"[还有 {len(hits) - max_hits} 条未显示。收窄关键词，或者直接读上面某个文件]")
    return "\n".join(lines)
