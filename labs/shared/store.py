"""参考实现：会话持久化与断点恢复（Python 版）。

这个文件要打掉一个几乎所有人第一次都会犯的错：**把 transcript 存下来当持久化。**

transcript 是**历史**，不是**状态**。区别在三处：

    一 · 历史单调增长，状态不。存历史等于把 L06 那个上下文爆炸问题搬到磁盘上
    二 · 历史不可查询。「这个 agent 现在卡在哪」要靠人读一遍才知道
    三 · **重放历史不幂等。** 这是最要命的一条，见 plan_resume 那一段

所以这里存的是**事件日志**（append-only JSONL）加**派生状态**：
日志是事实，状态是从日志算出来的。

和 TS 版的三处真实差异：

一 · **原子写。** TS 用 renameSync，Python 用 os.replace——
     后者在 Windows 上也是原子的（os.rename 在 Windows 上目标存在会失败）。
     这是那种"跨平台"细节里真正会咬人的一个。

二 · **追加写要显式 flush。** Python 的文件对象有自己的缓冲，
     with 块结束才落盘。崩溃恢复的场景下这个缓冲就是一段丢失的日志。

三 · **json.dumps 默认 ensure_ascii=True。** 中文会被转成 \\uXXXX，
     文件体积涨三倍，而且 tail 出来的日志人看不懂（L06 那个坑）。
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from time import time
from typing import Any, Literal

# ─────────────────────────────────────────────────────────────
# 事件
# ─────────────────────────────────────────────────────────────

EventType = Literal["task", "intent", "outcome", "text", "done"]

# ★ intent 和 outcome 是分开的两条事件，这是整个设计的核心。
#
# 合成一条的话（「第 3 步调用了 write_file 并成功了」），崩溃恢复就无解了：
# 你看不到「打算做但不知道做没做」这个状态，而那恰恰是崩溃后最常见的状态。
Event = dict[str, Any]


def _stable(v: Any) -> str:
    """稳定序列化：字段按 key 排序。

    ★ 理由和 L05 的 repeat_key 完全一样：
    字段顺序变了 key 就变了，防线静默失效。
    sort_keys=True 递归生效，所以嵌套对象也稳定。
    """
    return json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)


def idem_key(session_id: str, tool: str, payload: Any) -> str:
    """幂等键：同一个「工具 + 参数」在同一个会话里算同一次操作。"""
    raw = f"{session_id}\x00{tool}\x00{_stable(payload)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


# ─────────────────────────────────────────────────────────────
# 派生状态
# ─────────────────────────────────────────────────────────────


@dataclass
class Pending:
    step: int
    tool: str
    input: Any
    idem: str


@dataclass
class SessionState:
    task: str | None = None
    # 已经完成的步数（有 outcome 的）。
    steps: int = 0
    # idem → 结果。恢复时用来跳过已经做过的操作。
    completed: dict[str, dict[str, Any]] = field(default_factory=dict)
    # ★ 有 intent 但没有 outcome 的那些。
    #
    # 这是崩溃恢复的全部难点所在：这些操作**可能做了也可能没做**。
    # 日志停在 intent 说明进程死在「写完意图」和「写完结果」之间——
    # 而副作用（写文件、发请求）就发生在那个窗口里。
    pending: list[Pending] = field(default_factory=list)
    last_text: str = ""
    finished: bool = False
    reason: str | None = None


def reduce(events: list[Event]) -> SessionState:
    st = SessionState()
    open_: dict[str, Pending] = {}

    for e in events:
        t = e.get("t")
        if t == "task":
            st.task = e.get("task")
        elif t == "intent":
            open_[e["idem"]] = Pending(
                step=int(e["step"]), tool=e["tool"], input=e.get("input"), idem=e["idem"]
            )
        elif t == "outcome":
            open_.pop(e["idem"], None)
            st.completed[e["idem"]] = {"ok": bool(e["ok"]), "content": e.get("content", "")}
            st.steps = max(st.steps, int(e["step"]))
        elif t == "text":
            st.last_text = e.get("text", "")
        elif t == "done":
            st.finished = True
            st.reason = e.get("reason")

    st.pending = sorted(open_.values(), key=lambda p: p.step)
    return st


# ─────────────────────────────────────────────────────────────
# 存储
# ─────────────────────────────────────────────────────────────


class Store:
    def append(self, e: dict[str, Any]) -> Event:
        raise NotImplementedError

    def read(self) -> list[Event]:
        raise NotImplementedError

    def state(self) -> SessionState:
        return reduce(self.read())

    @property
    def corrupt(self) -> int:
        raise NotImplementedError


class FileStore(Store):
    """JSONL 会话日志。

    ★ 为什么是 JSONL 而不是一个 JSON 数组：

        一 · **追加是 O(1)。** JSON 数组每次都要读全文、改、写回全文
        二 · **崩溃只损坏最后一行。** 数组格式崩溃后整个文件都不是合法 JSON
        三 · **能 tail -f。** 排查线上问题的时候这一条比前两条都实用
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._corrupt = 0
        self._seq = max((int(e.get("seq", 0)) for e in self.read()), default=0)

    def append(self, e: dict[str, Any]) -> Event:
        self._seq += 1
        ev: Event = {**e, "seq": self._seq, "at": time()}
        # ★ 必须显式 flush + fsync 才算真的落盘。
        #
        # Python 的文件对象有自己的缓冲，with 块结束才写出去；
        # 而操作系统还有一层页缓存。崩溃恢复的场景下这两层缓冲
        # 就是一段丢失的日志——而且丢的正好是崩溃前那几条，最关键的那几条。
        #
        # fsync 很慢（每次都要等磁盘），所以生产环境常常只 flush 不 fsync，
        # 接受"进程崩了能救、机器断电救不了"这个折中。
        # 这是个**显式的取舍**，不是可以忽略的细节。
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(ev, ensure_ascii=False, default=str) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        return ev

    def read(self) -> list[Event]:
        if not self.path.exists():
            return []
        out: list[Event] = []
        self._corrupt = 0
        for line in self.path.read_text(encoding="utf-8").split("\n"):
            if not line.strip():
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                # ★ 容忍坏行而不是整个读取失败。
                #
                # 崩溃时最后一行常常是写了一半的。为这一行放弃整个会话，
                # 等于用一个小故障换一个大故障。
                #
                # 但**要数出来**——静默跳过就没人知道发生过崩溃了。
                self._corrupt += 1
        return out

    @property
    def corrupt(self) -> int:
        return self._corrupt


class MemoryStore(Store):
    """内存版。测试用，也用来演示「存储换掉但语义不变」。"""

    def __init__(self) -> None:
        self._events: list[Event] = []
        self._seq = 0

    def append(self, e: dict[str, Any]) -> Event:
        self._seq += 1
        ev: Event = {**e, "seq": self._seq, "at": time()}
        self._events.append(ev)
        return ev

    def read(self) -> list[Event]:
        return list(self._events)

    @property
    def corrupt(self) -> int:
        return 0


# ─────────────────────────────────────────────────────────────
# 快照
# ─────────────────────────────────────────────────────────────


@dataclass
class Snapshot:
    # 快照覆盖到哪一条事件。**没有这个字段的快照是不能用的。**
    upto: int
    state: dict[str, Any]


def write_snapshot(path: str | Path, events: list[Event]) -> Snapshot:
    """存快照。

    ★ 快照必须记 upto（覆盖到第几条事件），否则你没法把它和日志拼起来——
    要么重复应用事件，要么漏掉事件，而两者都是静默的。

    ★ 写快照必须**先写临时文件再原子替换**。

    Python 这里用 os.replace 而不是 os.rename：
    两者在 POSIX 上都是原子的，但 **os.rename 在 Windows 上目标存在时会失败**，
    而 os.replace 两个平台都能覆盖。这是那种"跨平台"细节里真正会咬人的一个。

    直接写目标文件的话，崩在中间会留下一个半截快照——
    而**快照坏了比没有快照更糟**：你会从一个错误的状态继续跑。
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    st = reduce(events)
    snap = Snapshot(
        upto=max((int(e.get("seq", 0)) for e in events), default=0),
        state={
            "task": st.task,
            "steps": st.steps,
            "completed": st.completed,
            "last_text": st.last_text,
            "finished": st.finished,
            "reason": st.reason,
        },
    )
    tmp = p.with_suffix(p.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump({"upto": snap.upto, "state": snap.state}, fh, ensure_ascii=False, default=str)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, p)
    return snap


def read_snapshot(path: str | Path) -> Snapshot | None:
    """读快照。坏了就返回 None——日志才是事实来源，快照只是加速。"""
    p = Path(path)
    if not p.exists():
        return None
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        return Snapshot(upto=int(raw["upto"]), state=raw["state"])
    except (json.JSONDecodeError, KeyError, ValueError):
        return None


def restore(snap: Snapshot | None, events: list[Event]) -> SessionState:
    """从快照 + 快照之后的事件恢复状态。快照只是加速，日志才是事实来源。"""
    if snap is None:
        return reduce(events)

    tail = [e for e in events if int(e.get("seq", 0)) > snap.upto]
    base = reduce(tail)

    # 快照里的 completed 要先铺上，再让 tail 的事件覆盖。
    completed = dict(snap.state.get("completed") or {})
    completed.update(base.completed)

    return SessionState(
        task=base.task if base.task is not None else snap.state.get("task"),
        steps=max(int(snap.state.get("steps") or 0), base.steps),
        completed=completed,
        pending=base.pending,
        last_text=base.last_text or (snap.state.get("last_text") or ""),
        finished=base.finished or bool(snap.state.get("finished")),
        reason=base.reason if base.reason is not None else snap.state.get("reason"),
    )


# ─────────────────────────────────────────────────────────────
# 恢复决策
# ─────────────────────────────────────────────────────────────

# 工具的可重放性。这个分类是恢复逻辑的全部依据。
#
#   'pure'       —— 没有副作用，随便重放。read_file / search
#   'idempotent' —— 有副作用但重复执行结果相同。write_file（覆盖写）
#   'once'       —— 重复执行会出事。send_email / create_order / git_commit
Replayability = Literal["pure", "idempotent", "once"]


@dataclass
class ResumePlan:
    # 可以直接跳过的（已有 outcome）。
    skip: list[str]
    # 需要重新执行的。
    redo: list[Pending]
    # ★ 必须交给人的。
    #
    # pending 里那些 'once' 类型的工具：可能做了也可能没做，而重做会出事。
    # **代码在这里没有正确答案，唯一诚实的做法是停下来问。**
    ask: list[Pending]
    resume_from: int


def plan_resume(st: SessionState, replayability: Any) -> ResumePlan:
    redo: list[Pending] = []
    ask: list[Pending] = []

    for p in st.pending:
        if replayability(p.tool) == "once":
            ask.append(p)
        else:
            redo.append(p)

    return ResumePlan(
        skip=list(st.completed.keys()),
        redo=redo,
        ask=ask,
        # 从最早的未完成步继续。没有 pending 就从已完成的下一步开始。
        resume_from=min((p.step for p in st.pending), default=st.steps + 1),
    )


def describe_plan(plan: ResumePlan) -> str:
    """给日志和 UI 用的一句人话。"""
    parts = [f"跳过 {len(plan.skip)} 个已完成操作", f"从第 {plan.resume_from} 步继续"]
    if plan.redo:
        parts.append(f"重放 {len(plan.redo)} 个可重放操作")
    if plan.ask:
        names = "、".join(f"{a.tool}(第 {a.step} 步)" for a in plan.ask)
        parts.append(f"\033[33m{len(plan.ask)} 个操作需要人工确认：{names}\033[0m")
    return "，".join(parts)


def session_path(directory: str | Path, sid: str) -> Path:
    return Path(directory) / f"{sid}.jsonl"


def snapshot_path(directory: str | Path, sid: str) -> Path:
    return Path(directory) / f"{sid}.snapshot.json"
