"""L21 知识地图。TS 镜像见 knowledge.ts。"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import cmp_to_key
from typing import Literal

from shared.coding_eval import cmp_code_point

_sort_id = cmp_to_key(cmp_code_point)

EdgeKind = Literal["requires", "contrasts", "measured_by", "iou"]


def _utc_ms(year: int, month: int, day: int) -> int:
    """与 JS Date.UTC(year, monthIndex, day) 对齐；month 为 1–12。"""
    return int(datetime(year, month, day, tzinfo=UTC).timestamp() * 1000)


@dataclass
class ConceptNode:
    id: str
    title: str
    lesson: str
    invariant: str
    evidence_at: int


@dataclass
class ConceptEdge:
    from_: str
    to: str
    kind: EdgeKind
    note: str | None = None


@dataclass
class KnowledgeGraph:
    nodes: list[ConceptNode]
    edges: list[ConceptEdge]


@dataclass
class Source:
    id: str
    trust: float
    reproducible: bool
    kind: Literal["paper", "official_doc", "vendor_blog", "own_verify", "twitter"]


def course_graph() -> KnowledgeGraph:
    nodes = [
        ConceptNode("edit.not_unique", "NOT_UNIQUE 编辑", "L17", "多匹配零写入，逼模型扩大上下文", _utc_ms(2026, 10, 1)),
        ConceptNode("edit.can_stop", "canStop 时序", "L17", "verify 必须在最后一次 edit 之后", _utc_ms(2026, 10, 1)),
        ConceptNode("eval.resolve", "resolve 口径", "L18", "主指标不是 apply；改测试=hacked", _utc_ms(2026, 10, 1)),
        ConceptNode("eval.gate", "regress/claim 门", "L18", "非劣与优效分两门", _utc_ms(2026, 10, 1)),
        ConceptNode("ops.checkpoint", "checkpoint 续跑", "L19", "续断点不是新 job", _utc_ms(2026, 10, 1)),
        ConceptNode("ops.idempotency", "写操作幂等键", "L19", "unsafe 无 key 禁止自动重试", _utc_ms(2026, 10, 1)),
        ConceptNode("ui.can_execute", "canExecute≠展示", "L16", "审批卡在能否执行", _utc_ms(2026, 9, 1)),
        ConceptNode("eval.kappa", "kappa 主指标", "L12", "原始一致率可为零信息", _utc_ms(2026, 7, 1)),
        ConceptNode("budget.usage", "usage 证缓存", "L15", "不用 TTFT 侧信道", _utc_ms(2026, 8, 1)),
        ConceptNode("sandbox.prefix", "路径不是 startsWith", "L17", "ws-evil 必须挡住", _utc_ms(2026, 10, 1)),
    ]
    edges = [
        ConceptEdge("edit.can_stop", "edit.not_unique", "requires", "先能改对再谈终止"),
        ConceptEdge("eval.resolve", "edit.can_stop", "requires"),
        ConceptEdge("eval.gate", "eval.resolve", "requires"),
        ConceptEdge("eval.gate", "eval.kappa", "requires", "门禁卫生来自 L12"),
        ConceptEdge("eval.resolve", "edit.not_unique", "measured_by"),
        ConceptEdge("ops.checkpoint", "ops.idempotency", "requires"),
        ConceptEdge("ops.idempotency", "edit.not_unique", "contrasts", "都在防双份"),
        ConceptEdge("ui.can_execute", "ops.checkpoint", "iou", "审批记忆在 L19 兑付"),
        ConceptEdge("sandbox.prefix", "edit.not_unique", "requires"),
        ConceptEdge("budget.usage", "eval.gate", "contrasts", "都谈「证明」而非感觉"),
    ]
    return KnowledgeGraph(nodes=nodes, edges=edges)


def node_by_id(g: KnowledgeGraph, id: str) -> ConceptNode | None:
    for n in g.nodes:
        if n.id == id:
            return n
    return None


def validate_graph(g: KnowledgeGraph) -> list[str]:
    gaps: list[str] = []
    ids = {n.id for n in g.nodes}
    if len(ids) != len(g.nodes):
        gaps.append("存在重复 node id")
    for e in g.edges:
        if e.from_ not in ids:
            gaps.append(f"边 from 不存在：{e.from_}")
        if e.to not in ids:
            gaps.append(f"边 to 不存在：{e.to}")
    return gaps


def dependents(g: KnowledgeGraph, id: str) -> list[str]:
    out = [e.from_ for e in g.edges if e.kind == "requires" and e.to == id]
    out.sort(key=_sort_id)
    return out


def prerequisites(g: KnowledgeGraph, id: str) -> list[str]:
    out = [e.to for e in g.edges if e.kind == "requires" and e.from_ == id]
    out.sort(key=_sort_id)
    return out


def blast_radius(g: KnowledgeGraph, id: str) -> list[str]:
    seen: set[str] = set()
    q = [id]
    while q:
        cur = q.pop(0)
        for d in dependents(g, cur):
            if d not in seen:
                seen.add(d)
                q.append(d)
    return sorted(seen, key=_sort_id)


@dataclass
class StaleReport:
    id: str
    age_days: float
    blast: list[str]


def find_stale(g: KnowledgeGraph, now: int, max_age_days: int) -> list[StaleReport]:
    ms = max_age_days * 86_400_000
    out: list[StaleReport] = []
    for n in g.nodes:
        if n.evidence_at == 0:
            out.append(StaleReport(id=n.id, age_days=math.inf, blast=blast_radius(g, n.id)))
            continue
        age = now - n.evidence_at
        if age > ms:
            out.append(
                StaleReport(
                    id=n.id,
                    age_days=math.floor(age / 86_400_000),
                    blast=blast_radius(g, n.id),
                )
            )
    out.sort(key=cmp_to_key(lambda a, b: cmp_code_point(a.id, b.id)))
    return out


def source_weight(s: Source) -> float:
    """信息源加权：own_verify 与 reproducible paper 抬升；twitter 封顶。

    ★ 先按来源封顶，再给可复核加成：可复核的 vendor_blog 最高 0.7、twitter 最高 0.3（SRC-5）。
    ★ 舍入用 floor(x + 0.5)：round() 平局取偶，0.0625 会给 0.062，TS 的 Math.round 给 0.063（SRC-6）。
    """
    t = s.trust
    if s.kind == "own_verify":
        t = max(t, 0.9)
    if s.kind == "twitter":
        t = min(t, 0.2)
    if s.kind == "vendor_blog":
        t = min(t, 0.6)
    if s.reproducible:
        t = min(1.0, t + 0.1)
    if (not s.reproducible) and s.kind == "paper":
        t = min(t, 0.7)
    return math.floor(t * 1000 + 0.5) / 1000


def shortest_requires_path(g: KnowledgeGraph, from_id: str, to_id: str) -> list[str] | None:
    if from_id == to_id:
        return [from_id]
    q: list[list[str]] = [[from_id]]
    seen = {from_id}
    while q:
        path = q.pop(0)
        cur = path[-1]
        for nxt in prerequisites(g, cur):
            if nxt in seen:
                continue
            next_path = [*path, nxt]
            if nxt == to_id:
                return next_path
            seen.add(nxt)
            q.append(next_path)
    return None
