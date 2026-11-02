"""
L03 · 任务二（Python 通道）：测方差，不是测「好不好」。

跑法：uv run python -m l03.variance

完整任务说明和四个要回答的问题见 l03/variance.ts，这里不重复。

Python 这边只多一处形状差异，但它很实际：
TS 那边我用 pooled 控制并发；这里给的是**同步顺序执行**版本。

理由不是 Python 做不到并发，而是这个练习本身不需要它——
24 个请求顺序跑几十秒，而并发会引入一个你不想在测方差时引入的变量：
**如果服务端在高并发下走了不同的批处理路径，你测到的方差里就混进了负载因素。**
测方差的时候，让请求之间尽量只差随机种子。

真要并发就用 asyncio + Semaphore，写法见 shared/resilience.py 里的 pooled。
"""

from __future__ import annotations

import json
import os
import re
import time
from collections import Counter
from dataclasses import dataclass, field

from shared.config import create_client, get_provider
from shared.ledger import Entry, Ledger, Usage
from shared.message import text_of

RUNS = int(os.environ.get("RUNS", "8"))

MEETING = """
张伟：这周的登录页改版我来做，下周三之前给出可点的版本。
李娜：那我同步把埋点方案写出来，不过我下周一二在出差，可能要往后挪。
王强：数据库迁移脚本我已经写完了，等评审。
张伟：好，那评审我们放在周四。另外线上那个偶发 500 有人跟吗？
李娜：我看过日志，像是连接池打满，还没定位到根因。
""".strip()

V1 = (
    "你是一个信息提取助手。请从用户给的会议记录里找出待办事项，"
    "用 JSON 数组返回，每项包含 task 和 owner 两个字段。只返回 JSON。"
)

V2 = "\n".join(
    [
        "<role>信息提取助手</role>",
        "",
        "<task>从会议记录中提取待办事项</task>",
        "",
        "<output_format>",
        "只输出一个 JSON 数组，不要任何其他文字。",
        '每个元素的形状：{"task": string, "owner": string}',
        "task 用一句话概括要做的事，owner 是负责人姓名。",
        "</output_format>",
        "",
        "<rules>",
        "1. 只提取明确指派了负责人的事项。",
        "2. 没有明确负责人的讨论不要放进结果。",
        "3. 如果没有任何待办，返回空数组 []。",
        "</rules>",
    ]
)

V3 = (
    V2
    + "\n\n"
    + "\n".join(
        [
            "<examples>",
            "<example>",
            "<input>甲：报表我明天发。乙：那个 bug 挺奇怪的。</input>",
            '<output>[{"task":"发送报表","owner":"甲"}]</output>',
            "</example>",
            "<example>",
            "<input>甲：这个方案我觉得可以。乙：我也同意。</input>",
            "<output>[]</output>",
            "</example>",
            "</examples>",
        ]
    )
)

VERSIONS = {"v1 · 自然语言": V1, "v2 · 结构化标签": V2, "v3 · 结构化 + 样例": V3}


@dataclass
class Sample:
    raw: str
    parsed: list[dict] | None = None
    parse_error: str | None = None


@dataclass
class Stats:
    parse_rate: float = 0.0
    count_min: int = 0
    count_max: int = 0
    count_mode: int = 0
    off_mode: int = 0
    stability: float | None = None
    avg_input: float = 0.0
    avg_ms: float = 0.0
    samples: list[Sample] = field(default_factory=list)


provider = get_provider()
client = create_client(provider)
ledger = Ledger("L03 方差测量")


def once(label: str, system: str) -> Sample:
    t0 = time.perf_counter()
    res = client.messages.create(
        model=provider.model_main,
        max_tokens=1500,
        system=system,
        messages=[{"role": "user", "content": MEETING}],
    )
    ledger.record(
        Entry(
            label=label,
            id=res.id,
            model=res.model,
            usage=Usage.from_sdk(res.usage),
            ms=(time.perf_counter() - t0) * 1000,
        )
    )

    raw = text_of(res.content)

    # 故意用最朴素的解析：这里要测的是模型输出有多稳，不是我的解析器有多能兜。
    # 用 shared/parse.py 会把 v1 和 v3 的差异抹平，那就什么都测不出来了。
    try:
        start, end = raw.index("["), raw.rindex("]")
        return Sample(raw=raw, parsed=json.loads(raw[start : end + 1]))
    except Exception as err:
        return Sample(raw=raw, parse_error=str(err))


# ─────────────────────────────────────────────────────────────────────────────
# TODO 1 · parse_rate(samples)      一次解析成功的比例
# TODO 2 · count_stats(samples)     条目数的 min / max / 众数 / 偏离众数的次数
# TODO 3 · set_stability(samples)   两两 Jaccard 相似度的平均值
#
#   TODO 3 要先做归一化再比集合（去空格标点）。
#   归一化本身是一个判断：**你认为什么程度的差异算「同一件事」？** 想清楚再写。
#
# TODO 4 · 跑三个版本，打成一张表，回答 l03/variance.ts 里那四个问题
# ─────────────────────────────────────────────────────────────────────────────

NORM = re.compile(r"[\s，。、,.!?！？]+")


def normalize(task: str) -> str:
    return NORM.sub("", task)


def parse_rate(samples: list[Sample]) -> float:
    raise NotImplementedError("TODO 1")


def count_stats(samples: list[Sample]) -> tuple[int, int, int, int] | None:
    raise NotImplementedError("TODO 2")


def set_stability(samples: list[Sample]) -> float | None:
    raise NotImplementedError("TODO 3")


def main() -> None:
    print(f"模型 {provider.model_main} · 每个版本 {RUNS} 次\n")
    _ = (once, parse_rate, count_stats, set_stability, normalize, Counter, Stats, VERSIONS)
    raise NotImplementedError("把 TODO 4 写完，然后删掉这一行")


if __name__ == "__main__":
    main()
