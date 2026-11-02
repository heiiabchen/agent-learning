"""L21 的脚手架。跑法：uv run python -m l21.map"""

from __future__ import annotations

import re
from datetime import UTC, datetime

from shared.knowledge import (
    KnowledgeGraph,
    Source,
    blast_radius,
    course_graph,
    find_stale,
    prerequisites,
    shortest_requires_path,
    source_weight,
    validate_graph,
)

DIM, BOLD, OFF = "\x1b[2m", "\x1b[1m", "\x1b[0m"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _w(s: str) -> int:
    s = _ANSI.sub("", s)
    return sum(2 if "\u2e80" <= c <= "\u9fff" or "\uff00" <= c <= "\uffef" else 1 for c in s)


def pad(s: str, n: int) -> str:
    return s + " " * max(0, n - _w(s))


def dim(s: str) -> str:
    return f"{DIM}{s}{OFF}"


def bold(s: str) -> str:
    return f"{BOLD}{s}{OFF}"


def exp1() -> None:
    print(bold("\n实验一：从门禁往下，requires 链要补什么"))
    g = course_graph()
    path = shortest_requires_path(g, "eval.gate", "edit.not_unique")
    print(f"  eval.gate → edit.not_unique：{' → '.join(path) if path else '不可达'}")
    print(f"  eval.gate 的直接前提：{', '.join(prerequisites(g, 'eval.gate'))}")
    print(dim("\n  面试前一晚别从随机博客补；沿 requires 链补断裂点。"))


def exp2() -> None:
    print(bold("\n实验二：若 NOT_UNIQUE 的证据作废，谁被波及"))
    g = course_graph()
    blast = blast_radius(g, "edit.not_unique")
    print(f"  影响面（{len(blast)}）：{', '.join(blast)}")
    print(dim("\n  重读一篇编辑论文时，把 blast 里的课的 Key 框一并核对。"))


def exp3() -> None:
    print(bold("\n实验三：把证据时间拨旧，看谁该重读"))
    g = course_graph()
    now = int(datetime(2026, 10, 9, tzinfo=UTC).timestamp() * 1000)
    stale = find_stale(g, now, 60)
    print(f"  {pad('节点', 22)}{pad('账龄(天)', 10)}波及")
    print("  " + "─" * 50)
    for s in stale[:5]:
        age = "未知" if s.age_days == float("inf") else str(int(s.age_days))
        print(f"  {pad(s.id, 22)}{pad(age, 10)}{len(s.blast)}")
    print(dim("\n  过期≠错误；等于「叙事仍在用，证据该重核」。"))


def exp4() -> None:
    print(bold("\n实验四：同一句话，不同来源的权重"))
    sources = [
        Source(id="own", trust=0.5, reproducible=True, kind="own_verify"),
        Source(id="paper", trust=0.8, reproducible=True, kind="paper"),
        Source(id="blog", trust=0.8, reproducible=False, kind="vendor_blog"),
        Source(id="tw", trust=0.9, reproducible=False, kind="twitter"),
    ]
    print(f"  {pad('来源', 14)}加权 trust")
    print("  " + "─" * 28)
    for s in sources:
        print(f"  {pad(s.id, 14)}{source_weight(s):.3f}")
    print(dim("\n  twitter 再自信也封顶；own_verify 即使自谦也被抬到 ≥0.9。"))


def observe() -> None:
    print(bold("L21 · 观察实验（参考实现）"))
    print(dim("地图是方法，不是百科。节点会过期，边的 kind 不会。"))
    gaps = validate_graph(course_graph())
    print(dim(f"  骨架图校验 gaps={len(gaps)}"))
    exp1()
    exp2()
    exp3()
    exp4()


def my_validate_graph(g: KnowledgeGraph) -> list[str]:
    raise NotImplementedError("TODO 1 未实现")


def my_blast_radius(g: KnowledgeGraph, id: str) -> list[str]:
    raise NotImplementedError("TODO 2 未实现")


def my_find_stale(g: KnowledgeGraph, now: int, max_age_days: int) -> object:
    raise NotImplementedError("TODO 3 未实现")


def my_source_weight(s: Source) -> float:
    raise NotImplementedError("TODO 4 未实现")


def my_shortest_requires_path(g: KnowledgeGraph, from_id: str, to_id: str) -> list[str] | None:
    raise NotImplementedError("TODO 5 未实现")


_ = (
    my_validate_graph,
    my_blast_radius,
    my_find_stale,
    my_source_weight,
    my_shortest_requires_path,
)

if __name__ == "__main__":
    observe()
    print(
        dim(
            "\n  下一步：实现五个 TODO，然后跑 pnpm verify:l21（或 uv run python -m l21.verify）。"
        )
        + dim("\n  想先确认测试本身是对的，跑 MAP_IMPL=shared 下的 verify。")
        + dim("\n  观察实验：pnpm map / uv run python -m l21.map\n")
    )
