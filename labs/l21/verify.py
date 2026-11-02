"""验证 l21/map.py。MAP_IMPL=shared uv run python -m l21.verify"""

from __future__ import annotations

import json
import math
import os
from datetime import UTC, datetime
from typing import Any

from shared import knowledge as shared
from shared.knowledge import ConceptEdge, ConceptNode, KnowledgeGraph, Source, course_graph

TARGET = "shared" if os.environ.get("MAP_IMPL") == "shared" else "mine"


class _Mine:
    def __init__(self) -> None:
        from l21 import map as m

        self.validate_graph = m.my_validate_graph
        self.blast_radius = m.my_blast_radius
        self.find_stale = m.my_find_stale
        self.source_weight = m.my_source_weight
        self.shortest_requires_path = m.my_shortest_requires_path
        self.prerequisites = shared.prerequisites
        self.dependents = shared.dependents


M: Any = shared if TARGET == "shared" else _Mine()

print("\n（测的是 shared/ 里的参考实现）" if TARGET == "shared" else "\n（测的是 l21/ 里你的实现）")

DIM, BOLD, RED, GREEN, OFF = "\x1b[2m", "\x1b[1m", "\x1b[31m", "\x1b[32m", "\x1b[0m"
passed = 0
failed = 0


def ok(cond: bool, name: str) -> None:
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"{RED}  ✗ {name}{OFF}")


def eq(a: Any, b: Any, name: str) -> None:
    as_, bs = json.dumps(a, ensure_ascii=False, sort_keys=True), json.dumps(
        b, ensure_ascii=False, sort_keys=True
    )
    ok(as_ == bs, name if as_ == bs else f"{name} (got {as_}, want {bs})")


def section(t: str) -> None:
    print(f"{BOLD}\n{t}{OFF}")


g = course_graph()

section("A · 图校验")
eq(M.validate_graph(g), [], "GRAPH-1 骨架合法")
ok(
    any(
        "重复" in x
        for x in M.validate_graph(
            KnowledgeGraph(
                nodes=[
                    ConceptNode("a", "A", "L0", "x", 1),
                    ConceptNode("a", "A2", "L0", "y", 1),
                ],
                edges=[],
            )
        )
    ),
    "GRAPH-2 重复 id",
)
ok(
    any(
        "missing" in x
        for x in M.validate_graph(
            KnowledgeGraph(
                nodes=[ConceptNode("a", "A", "L0", "x", 1)],
                edges=[ConceptEdge("a", "missing", "requires")],
            )
        )
    ),
    "GRAPH-3 边悬空",
)

section("B · 路径与影响面")
eq(sorted(M.prerequisites(g, "eval.gate")), sorted(["eval.kappa", "eval.resolve"]), "PATH-1 gate 前提")
path = M.shortest_requires_path(g, "eval.gate", "edit.not_unique")
ok(path is not None and path[0] == "eval.gate" and path[-1] == "edit.not_unique", "PATH-2 可达")
ok("eval.resolve" in path, "PATH-3 经 resolve")
eq(M.shortest_requires_path(g, "edit.not_unique", "eval.gate"), None, "PATH-4 反向不可达（仅 requires 向下）")
blast = M.blast_radius(g, "edit.not_unique")
ok("eval.resolve" in blast, "BLAST-1 resolve 被波及")
ok("eval.gate" in blast, "BLAST-2 gate 被波及")
ok("edit.not_unique" not in blast, "BLAST-3 不含自身")

section("C · 过期")
now = int(datetime(2026, 10, 9, tzinfo=UTC).timestamp() * 1000)
stale = M.find_stale(g, now, 60)
ok(any(s.id == "eval.kappa" for s in stale), "STALE-1 kappa 账龄>60")
ok(not any(s.id == "edit.not_unique" for s in stale), "STALE-2 新证据未过期")
stale_all = M.find_stale(
    KnowledgeGraph(nodes=[ConceptNode("x", "X", "L", "i", 0)], edges=[]),
    now,
    1,
)
ok(stale_all[0].age_days == math.inf, "STALE-3 未知证据")

section("D · 来源权重")
ok(M.source_weight(Source("o", 0.5, True, "own_verify")) >= 0.9, "SRC-1 own")
ok(M.source_weight(Source("t", 0.9, False, "twitter")) <= 0.2, "SRC-2 twitter 封顶")
ok(M.source_weight(Source("b", 0.8, False, "vendor_blog")) <= 0.6, "SRC-3 blog 封顶")
ok(
    M.source_weight(Source("p", 0.8, True, "paper"))
    > M.source_weight(Source("p2", 0.8, False, "paper")),
    "SRC-4 reproducible 加成",
)
# 先封顶再加成：顺序反过来，这两条会是 0.6 和 0.2
eq(
    [
        M.source_weight(Source("b2", 0.8, True, "vendor_blog")),
        M.source_weight(Source("t2", 0.9, True, "twitter")),
    ],
    [0.7, 0.3],
    "SRC-5 封顶在加成之前",
)
eq(
    M.source_weight(Source("p3", 0.0625, False, "paper")),
    0.063,
    "SRC-6 平局舍入两门语言一致",
)

print()
if failed == 0:
    print(f"{GREEN}  ✓ {passed} 条断言全部通过{OFF}")
    print(
        f"{DIM}\n  最该记住的五条：\n"
        "    GRAPH   边的端点必须存在\n"
        "    PATH    requires 链 = 补课顺序\n"
        "    BLAST   证据作废时的影响面\n"
        "    STALE   过期=该重读，不是自动删节点\n"
        f"    SRC     own_verify 抬升；twitter 封顶\n{OFF}"
    )
    raise SystemExit(0)
print(f"{RED}  ✗ {failed} 失败 / {passed} 通过{OFF}")
raise SystemExit(1)
