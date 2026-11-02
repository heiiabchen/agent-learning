"""
成本账本。shared/ledger.ts 的 Python 对照版。

设计规则和 TS 版完全一样，只有一条：**记录和计算分离。**
record() 只存原始 usage，要钱的时候现算。因为单价会变，而历史事实不该跟着变。
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field

from shared.config import price_of


@dataclass
class Usage:
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0

    @classmethod
    def from_sdk(cls, usage: object) -> Usage:
        """
        从 SDK 返回的 usage 对象转过来。

        这个方法存在的理由值得说一下：兼容端点**可能压根不返回 cache_* 字段**。
        TS 那边靠可选字段 + `?? 0` 兜；Python 这边用 getattr 带默认值。
        两边解决的是同一个问题——**别让缺失字段变成 NaN 或 None 参与算术**。
        """
        return cls(
            input_tokens=getattr(usage, "input_tokens", 0) or 0,
            output_tokens=getattr(usage, "output_tokens", 0) or 0,
            cache_read_input_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
            cache_creation_input_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
        )


@dataclass
class Entry:
    label: str
    """这次调用干什么用的。报告里按它分组。"""

    id: str
    """服务端返回的 message id。对账唯一凭据，日志里必须有。"""

    model: str
    """**实际**服务你的模型，不是你请求的那个。记错了会把模型换版当成 prompt 退化。"""

    usage: Usage
    ms: float
    ttft_ms: float | None = None


@dataclass
class Totals:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read: int = 0
    cache_write: int = 0
    ms: float = 0
    yuan: float = 0


@dataclass
class Ledger:
    name: str = "账本"
    entries: list[Entry] = field(default_factory=list)

    def record(self, entry: Entry) -> Entry:
        self.entries.append(entry)
        return entry

    def cost_of(self, e: Entry) -> float:
        """
        单条的钱。

        注意 input_tokens 的语义：它是**总输入**，其中命中缓存的那部分要按
        便宜的单价算。未命中量 = input_tokens − cache_read，
        直接拿 input_tokens 乘 miss 单价会把已经省下的钱又算回来。
        """
        p = price_of(e.model)
        hit = e.usage.cache_read_input_tokens
        write = e.usage.cache_creation_input_tokens
        miss = max(0, e.usage.input_tokens - hit)

        return (
            miss / 1e6 * p.input_miss
            + hit / 1e6 * p.input_hit
            + write / 1e6 * p.input_miss
            + e.usage.output_tokens / 1e6 * p.output
        )

    def totals(self) -> Totals:
        t = Totals()
        for e in self.entries:
            t.calls += 1
            t.input_tokens += e.usage.input_tokens
            t.output_tokens += e.usage.output_tokens
            t.cache_read += e.usage.cache_read_input_tokens
            t.cache_write += e.usage.cache_creation_input_tokens
            t.ms += e.ms
            t.yuan += self.cost_of(e)
        return t

    def cache_hit_rate(self) -> float | None:
        """
        命中率。没有缓存数据时返回 None 而不是 0。

        「端点没返回缓存字段」和「命中率是 0%」是两个完全不同的结论：
        前者你该去查为什么没数据，后者你该去查为什么没命中。
        """
        t = self.totals()
        if t.input_tokens == 0:
            return None
        if t.cache_read == 0 and t.cache_write == 0:
            return None
        return t.cache_read / t.input_tokens

    def report(self) -> str:
        if not self.entries:
            return f"{self.name}：没有记录"

        lines = [
            "",
            f"── {self.name} ──",
            "",
            _pad("用途", 18)
            + _r("输入", 9)
            + _r("命中", 8)
            + _r("输出", 8)
            + _r("耗时", 9)
            + _r("元", 10),
            "─" * 62,
        ]

        for e in self.entries:
            lines.append(
                _pad(e.label, 18)
                + _r(str(e.usage.input_tokens), 9)
                + _r(str(e.usage.cache_read_input_tokens), 8)
                + _r(str(e.usage.output_tokens), 8)
                + _r(f"{e.ms:.0f}ms", 9)
                + _r(f"{self.cost_of(e):.5f}", 10)
            )

        t = self.totals()
        rate = self.cache_hit_rate()

        lines += [
            "─" * 62,
            _pad(f"合计 {t.calls} 次", 18)
            + _r(str(t.input_tokens), 9)
            + _r(str(t.cache_read), 8)
            + _r(str(t.output_tokens), 8)
            + _r(f"{t.ms:.0f}ms", 9)
            + _r(f"{t.yuan:.5f}", 10),
            "",
            "缓存：无数据（兼容端点没返回缓存字段，或这批请求前缀都没重复）"
            if rate is None
            else f"缓存命中率 {rate * 100:.1f}%",
        ]

        return "\n".join(lines)


def _width(s: str) -> int:
    return sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in s)


def _pad(s: str, n: int) -> str:
    return s + " " * max(0, n - _width(s))


def _r(s: str, n: int) -> str:
    return " " * max(0, n - _width(s)) + s
