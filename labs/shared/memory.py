"""参考实现：长期记忆，以及防止它被污染（Python 版）。

短期记忆是上下文，L06 已经管过了。这个文件管的是**跨会话**的那部分。

★ 这一节最重要的判断：**长期记忆的主要风险不是记不住，是记错。**

记不住只是效率损失——重新问一遍就行。
记错是**永久性的**：一条错误的事实写进去之后，每一次会话都会读到它、
基于它做决定、并且从它推导出新的（同样错误的）结论。

所以这个模块的大部分代码不是「怎么存」，是「什么不许存」。

Python 特有的两处，都在 verify 里钉住了：

一 · **dataclass 的字段顺序即构造顺序。** Fact 有必填和可选混排，
     所以可选字段必须都带默认值，否则 dataclass 直接在 import 时报错。

二 · **float('-inf') 而不是 0 做初值。** 和 L07 refine 那个坑同源。
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, replace
from time import time
from typing import Literal

# ─────────────────────────────────────────────────────────────
# 事实
# ─────────────────────────────────────────────────────────────

# ★ observed 和 derived 必须分开，而且不能互相转化。
#
#   observed —— 直接看到的。「用户说他用 pnpm」
#   derived  —— 推导出来的。「用户偏好现代工具链」
#
# 为什么这个区分重要：**推导会复合误差。**
# 从 derived 再推导一次，误差乘一次；三层之后你得到的是一个和事实
# 只有远亲关系的判断，而它长得和 observed 一模一样。
FactKind = Literal["observed", "derived"]


@dataclass
class Fact:
    # 命名空间化的键。'user.package_manager' 而不是 'pm'。
    key: str
    value: str
    kind: FactKind = "observed"
    # 从哪来的。**没有出处的事实不许进长期记忆。**
    #
    # 这不是为了好看。出处是唯一能让人（和模型）判断这条对不对的东西，
    # 也是发现污染之后能顺着删掉一整批的唯一线索。
    source: str = ""
    # 原话或者证据片段。让人一眼能看出这条是怎么来的。
    evidence: str | None = None
    # derived 的深度。observed 是 0。**深度有上限。**
    depth: int = 0
    confidence: float = 1.0
    created_at: float = 0.0
    updated_at: float = 0.0
    # 被召回过几次。从没被用过的事实优先淘汰。
    hits: int = 0
    # 多久之后算过期（秒）。None 表示不过期。
    ttl_s: float | None = None


class MemoryError_(ValueError):
    """名字带下划线是为了不遮蔽内置的 MemoryError。"""

    def __init__(self, msg: str, fact: Fact) -> None:
        super().__init__(msg)
        self.fact = fact


@dataclass
class Conflict:
    key: str
    existing: Fact
    incoming: Fact


@dataclass
class RememberResult:
    written: bool
    # ★ 冲突不静默覆盖，也不静默忽略——两者都是污染的入口。
    #
    # 静默覆盖：一次幻觉就能永久改掉一条正确的事实。
    # 静默忽略：用户真的换了包管理器，你永远记着旧的。
    #
    # 所以返回冲突，让调用方决定，而且这个决定应该被记下来。
    conflict: Conflict | None = None
    reason: str | None = None


@dataclass
class Recalled:
    fact: Fact
    stale: bool


# ─────────────────────────────────────────────────────────────

DAY_S = 86_400.0


class Memory:
    def __init__(
        self,
        *,
        min_confidence: float = 0.6,
        max_depth: int = 1,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._facts: dict[str, Fact] = {}
        self.min_confidence = min_confidence
        self.max_depth = max_depth
        self._now = now or time

    def remember(
        self, incoming: Fact, *, resolve: Literal["keep", "replace"] | None = None
    ) -> RememberResult:
        """写入一条事实。四道闸，每一道都对应一类污染。

        ★ 闸的类型分两种，这个区分很重要：
            source / evidence 缺失 —— **调用方写错了代码** → 抛异常
            depth / confidence 不够 —— **数据不够好**       → 静静返回 False

        代码 bug 要吵，数据不足要静静地不写。
        """
        # 闸一：必须有出处。
        if not incoming.source.strip():
            raise MemoryError_(
                "没有 source 的事实不许进长期记忆——发现污染时你没法顺着删", incoming
            )

        # 闸二：observed 必须有证据。
        # derived 不强制，因为它的证据就是被推导的那些 observed。
        if incoming.kind == "observed" and not (incoming.evidence or "").strip():
            raise MemoryError_(
                'observed 的事实必须带 evidence（原话）。没有原话的"观察"其实是推导', incoming
            )

        # 闸三：深度上限。
        # 这一道最容易被忽略，也是"记忆慢慢跑偏"的主要机制。
        if incoming.depth > self.max_depth:
            return RememberResult(
                written=False,
                reason=(
                    f"推导深度 {incoming.depth} 超过上限 {self.max_depth}。"
                    "从推导结果再推导会复合误差，而结果长得和观察一模一样"
                ),
            )

        # 闸四：置信度下限。
        if incoming.confidence < self.min_confidence:
            return RememberResult(
                written=False,
                reason=f"置信度 {incoming.confidence} 低于下限 {self.min_confidence}。宁可再问一次",
            )

        t = self._now()
        existing = self._facts.get(incoming.key)

        if existing is not None and existing.value != incoming.value:
            if resolve is None:
                return RememberResult(
                    written=False,
                    conflict=Conflict(key=incoming.key, existing=existing, incoming=incoming),
                )
            if resolve == "keep":
                return RememberResult(written=False, reason="冲突，按调用方要求保留旧值")
            # ★ 一条真实的规则：observed 可以覆盖 derived，反过来不行。
            # 推导出来的结论不该推翻直接观察到的事实。
            if existing.kind == "observed" and incoming.kind == "derived":
                return RememberResult(
                    written=False,
                    reason="推导结果不许覆盖直接观察到的事实。要改就拿新的观察来改",
                )

        self._facts[incoming.key] = replace(
            incoming,
            created_at=existing.created_at if existing else t,
            updated_at=t,
            # hits 不继承。value 变了就是一条新事实，
            # 旧的使用次数不代表新值可靠。
            hits=existing.hits if existing and existing.value == incoming.value else 0,
        )
        return RememberResult(written=True)

    def recall(self, keys: Sequence[str] | None = None) -> list[Recalled]:
        """召回。

        ★ 过期的事实**返回但标记 stale**，而不是直接藏起来。

        藏起来的后果是模型不知道自己曾经知道过什么，于是重新问一遍——
        而重新问一遍在很多场景里比"知道但不确定"更烦人。
        标记 stale 之后，prompt 里可以写「这条可能过期了，用之前确认一下」。
        """
        t = self._now()
        if keys is None:
            wanted: Iterable[Fact] = list(self._facts.values())
        else:
            picked: list[Fact] = []
            for k in keys:
                if k.endswith("."):
                    # 前缀查询：'user.' 拿到所有 user 命名空间的事实。
                    picked.extend(f for f in self._facts.values() if f.key.startswith(k))
                else:
                    f = self._facts.get(k)
                    if f is not None:
                        picked.append(f)
            wanted = picked

        seen: set[str] = set()
        out: list[Recalled] = []
        for f in wanted:
            if f.key in seen:
                continue
            seen.add(f.key)
            f.hits += 1
            stale = f.ttl_s is not None and (t - f.updated_at) > f.ttl_s
            out.append(Recalled(fact=f, stale=stale))

        # observed 排在 derived 前面，同类按置信度降序。
        # 顺序影响模型的注意力分配（L05x），不是随便排的。
        out.sort(key=lambda r: (0 if r.fact.kind == "observed" else 1, -r.fact.confidence))
        return out

    def forget(self, pred: Callable[[Fact], bool]) -> int:
        """显式删除。发现污染之后按 source 批量删是最常见的操作。"""
        doomed = [k for k, f in self._facts.items() if pred(f)]
        for k in doomed:
            del self._facts[k]
        return len(doomed)

    def evict(self, limit: int) -> list[Fact]:
        """淘汰。

        ★ 遗忘是功能不是 bug。

        不淘汰的记忆会累积过期事实，而过期事实的危害和错误事实一样——
        「用户偏好用 npm」在六个月后可能已经是错的，但它看起来和真的一样。

        淘汰顺序：先过期的，再从没被召回过的，最后最旧的。
        """
        if len(self._facts) <= limit:
            return []
        t = self._now()

        def score(f: Fact) -> float:
            expired = f.ttl_s is not None and (t - f.updated_at) > f.ttl_s
            return (
                (-1000.0 if expired else 0.0)
                + f.hits * 10
                + f.confidence * 5
                + (3 if f.kind == "observed" else 0)
                - (t - f.updated_at) / DAY_S
            )

        ordered = sorted(self._facts.values(), key=score)
        drop = ordered[: len(self._facts) - limit]
        for f in drop:
            del self._facts[f.key]
        return drop

    @property
    def size(self) -> int:
        return len(self._facts)

    def all(self) -> list[Fact]:
        return list(self._facts.values())


# ─────────────────────────────────────────────────────────────
# 渲染进 prompt
# ─────────────────────────────────────────────────────────────


def _trim(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


def _mark(f: Fact, stale: bool) -> str:
    bits = [f"出处：{f.source}"]
    if f.evidence:
        bits.append(f'原话："{_trim(f.evidence, 60)}"')
    if f.confidence < 0.9:
        bits.append(f"置信度 {f.confidence:.2f}")
    if stale:
        bits.append("★ 可能已过期，用之前确认")
    return "  （" + "；".join(bits) + "）"


def render_memory(items: Sequence[Recalled]) -> str:
    """把记忆渲染成给模型看的文本。

    ★ 必须带出处，而且必须区分观察和推导。

    因为模型会把你给它的一切当成事实——你写「用户偏好 pnpm」，
    它就当这是铁律，哪怕这条是三个月前从一句话推导出来的。

    带上出处和类型之后，模型至少有机会说「我记得你之前提过用 pnpm，
    现在还是吗」——而这句话正是防止污染扩散的那道人工闸。
    """
    if not items:
        return ""

    lines = ["<memory>"]
    observed = [i for i in items if i.fact.kind == "observed"]
    derived = [i for i in items if i.fact.kind == "derived"]

    if observed:
        lines.append("  <observed>  <!-- 直接观察到的，可以当事实用 -->")
        for r in observed:
            lines.append(f"    {r.fact.key} = {r.fact.value}{_mark(r.fact, r.stale)}")
        lines.append("  </observed>")

    if derived:
        lines.append("  <derived>  <!-- 推导出来的，用之前先确认 -->")
        for r in derived:
            lines.append(f"    {r.fact.key} = {r.fact.value}{_mark(r.fact, r.stale)}")
        lines.append("  </derived>")

    lines.append("</memory>")
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────
# 从对话里抽事实
# ─────────────────────────────────────────────────────────────


@dataclass
class Extraction:
    key: str
    value: str
    kind: FactKind
    confidence: float
    evidence: str | None = None


# ★ 这个 prompt 里最重要的不是「抽什么」，是「不抽什么」。
#
# 让模型自由决定该记什么，是记忆污染的头号来源：它会把一次性的东西
# （「这个文件在 src/a.ts」）、临时状态（「现在在调试」）、
# 和自己的推测（「用户可能是后端工程师」）一起写进长期记忆。
EXTRACT_PROMPT = """从下面这段对话里抽取值得**长期**记住的事实。

只抽这四类：
1. 用户明确表达的偏好（工具、风格、流程）
2. 项目的稳定事实（技术栈、目录约定、部署方式）
3. 用户明确要求你记住的东西
4. 反复出现的约束（"我们不用 X"）

**不要抽这些：**
- 一次性的信息（某个文件的当前内容、某次报错的细节）
- 临时状态（"现在在调试这个函数"）
- 你的推测（"用户可能是后端工程师"）
- 从上面几条推导出来的概括（"用户偏好现代工具链"）

输出格式，每行一条，没有就输出 NONE：

    key | value | observed|derived | 置信度 | 原话

key 用点号命名空间，比如 user.package_manager、project.test_runner。
置信度是 0 到 1 的小数。**原话必须是对话里真实出现过的片段**，不要改写。

对话：
{conversation}"""

_BULLET = re.compile(r"^[\s\-*·\d.、)]+")


def parse_extraction(raw: str) -> tuple[list[Extraction], list[str]]:
    """解析抽取结果。

    ★ 严格解析，坏行**跳过并记数**而不是猜。

    记忆的入口是最不能宽容的地方：一条格式错误的行猜错了字段位置，
    就是一条错误的事实永久写进去。**宁可少记一条，不要记错一条。**

    这和 L03 那个宽容的 parse 是相反的取向，值得想清楚为什么：
    L03 解析的是**一次性的输出**，错了下次重来；
    这里解析的是**要长期保存的事实**，错了永久有效。
    """
    facts: list[Extraction] = []
    skipped: list[str] = []

    for line in raw.split("\n"):
        t = line.strip()
        if not t or t == "NONE":
            continue
        body = _BULLET.sub("", t)
        parts = [p.strip() for p in body.split("|")]
        if len(parts) < 4:
            skipped.append(t)
            continue

        key, value, kind_raw, conf_raw = parts[0], parts[1], parts[2], parts[3]
        evidence = parts[4] if len(parts) > 4 else ""

        if kind_raw not in ("observed", "derived"):
            skipped.append(t)
            continue
        try:
            confidence = float(conf_raw)
        except ValueError:
            skipped.append(t)
            continue

        if not key or not value or not 0.0 <= confidence <= 1.0:
            skipped.append(t)
            continue
        # key 必须命名空间化。不强制的话你三个月后会有 pm、packageManager、
        # package_manager 三条互相矛盾的事实。
        if "." not in key:
            skipped.append(t)
            continue

        facts.append(
            Extraction(
                key=key,
                value=value,
                kind=kind_raw,
                confidence=confidence,
                evidence=evidence or None,
            )
        )

    return facts, skipped


def find_contradictions(facts: Sequence[Extraction]) -> list[tuple[str, list[str]]]:
    """检测抽取结果里的自相矛盾。

    模型在同一次抽取里就可能给出两条冲突的事实（对话里用户改了主意）。
    **在写入之前检测，比写入之后靠冲突解决更便宜。**
    """
    by_key: dict[str, list[str]] = {}
    for f in facts:
        vals = by_key.setdefault(f.key, [])
        if f.value not in vals:
            vals.append(f.value)
    return [(k, v) for k, v in by_key.items() if len(v) > 1]
