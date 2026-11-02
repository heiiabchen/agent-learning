"""
L02 · 任务一（Python 通道）：写你自己的成本账本。

跑法：uv run python -m l02.ledger        验证：uv run python -m l02.verify

`shared/ledger.py` 里有我的实现。**先别看。**
自己写完、verify 跑绿了，再拿两版对照——差异比答案有价值。

完整任务说明见 l02/ledger.ts。Python 这边只多一件事要注意：
dataclass 的可变默认值必须用 field(default_factory=...)，
写成 `entries: list = []` 会让所有实例共享同一个列表——
这是 Python 最经典的一个坑，而且它的表现形式恰好和
L02 改错题里那个「模块级 history 被多用户共享」一模一样。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from shared.config import create_client, get_provider, price_of
from shared.ledger import Usage
from shared.message import text_of


@dataclass
class Entry:
    label: str
    id: str
    model: str
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


# ─────────────────────────────────────────────────────────────────────────────
# TODO 1 · record / entries
#
#   记录一条调用。只存**原始 usage**，不存算好的钱。
#   单价会变，而历史事实不该跟着变。存事实，算的时候再算。
#
# TODO 2 · cost_of(entry)
#
#   price_of(model) 给你 input_miss / input_hit / output，单位是元/百万。
#   注意 input_tokens 是**总输入**：未命中量 = input_tokens − cache_read。
#
# TODO 3 · totals()
#
# TODO 4 · cache_hit_rate()
#
#   没有缓存数据时返回 None 而不是 0。
#   「没测到数据」和「命中率是 0」是两个不同的结论。
#
# TODO 5 · report()
#
#   提示：CJK 在终端占两格，用 unicodedata.east_asian_width 判断。
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class Ledger:
    name: str = "账本"
    entries: list[Entry] = field(default_factory=list)

    def record(self, entry: Entry) -> Entry:
        raise NotImplementedError("TODO 1")

    def cost_of(self, e: Entry) -> float:
        raise NotImplementedError("TODO 2")

    def totals(self) -> Totals:
        raise NotImplementedError("TODO 3")

    def cache_hit_rate(self) -> float | None:
        raise NotImplementedError("TODO 4")

    def report(self) -> str:
        raise NotImplementedError("TODO 5")


# ─────────────────────────────────────────────────────────────────────────────
# TODO 6 · 拿它去记一笔真账
#
#   用账本包住三次真实调用，跑完打出报告：
#     · 一次短问题
#     · 一次同样的问题**再问一遍**（观察缓存字段有没有动）
#     · 一次长输出的问题
#
#   然后回答：
#     a) 第二次调用的 cache_read 是多少？如果是 0，可能的原因有哪些？
#     b) 三次里哪一次最贵？贵在输入还是输出？
#     c) 如果这三次是一个 agent 的三个步骤，你会先优化哪一个？
# ─────────────────────────────────────────────────────────────────────────────


def main() -> None:
    provider = get_provider()
    client = create_client(provider)
    ledger = Ledger("L02 记账练习")

    def call(label: str, prompt: str, max_tokens: int = 256) -> str:
        from time import perf_counter

        t0 = perf_counter()
        res = client.messages.create(
            model=provider.model_main,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        ledger.record(
            Entry(
                label=label,
                id=res.id,
                model=res.model,
                usage=Usage.from_sdk(res.usage),
                ms=(perf_counter() - t0) * 1000,
            )
        )
        return text_of(res.content)

    _ = (call, price_of)
    raise NotImplementedError("把 TODO 6 写完，然后删掉这一行")


if __name__ == "__main__":
    main()
