"""L08 任务一：会话持久化与断点恢复（Python 版）。

    uv run python -m l08.session

不调 API。参考实现在 shared/store.py。

★ 这个任务要打掉一个几乎所有人第一次都会犯的错：
**把 transcript 存下来当持久化。**

transcript 是历史，不是状态。写代码之前先想清楚这两者的区别在哪。

Python 通道有三个和 TS 版不一样的坑，都在 TODO 里标出来了：
os.replace vs os.rename、显式 flush + fsync、json.dumps 的 ensure_ascii。
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
# 事件定义（已给）
#
# ★ 注意 intent 和 outcome 是分开的两条事件，这是整个设计的核心。
#
# 合成一条的话（「第 3 步调用了 write_file 并成功了」），崩溃恢复就无解了：
# 你看不到「打算做但不知道做没做」这个状态，而那恰恰是崩溃后最常见的状态。
#
# TS 版用可辨识联合把每种事件的字段钉死；Python 这里用 dict 加一个 't' 字段。
# 类型上松一些，换来的是 json.loads 出来的东西可以直接当事件用——
# 这个取舍在「日志格式就是存储格式」的场景里是划算的。
# ─────────────────────────────────────────────────────────────

EventType = Literal["task", "intent", "outcome", "text", "done"]

Event = dict[str, Any]


# ─────────────────────────────────────────────────────────────
# TODO 1：幂等键
#
# 同一个「工具 + 参数」在同一个会话里算同一次操作。
#
# ★ 必须按 key 排序后序列化，理由和 L05 的 repeat_key 完全一样：
# 字段顺序变了 key 就变了，防线静默失效。json.dumps 的 sort_keys=True
# 是递归生效的，所以嵌套对象也稳定。
#
# 用 sha256 取前 16 位十六进制就够——它只需要在一个会话内唯一。
# 记得把 session_id 也拌进去，否则两个会话的相同调用会互相"跳过"。
#
# ★ Python 特有：json.dumps 遇到不可序列化的对象会抛 TypeError。
# 工具参数是模型给的，什么都可能有。加 default=str 让它退化成字符串，
# 而不是让整个 agent 因为一个奇怪的参数崩掉。
# ─────────────────────────────────────────────────────────────


def _stable(v: Any) -> str:
    raise NotImplementedError("TODO: 实现 _stable（稳定序列化）")


def idem_key(session_id: str, tool: str, payload: Any) -> str:
    raise NotImplementedError("TODO: 实现 idem_key")


# ─────────────────────────────────────────────────────────────
# TODO 2：从事件日志派生状态
#
# 这是「日志是事实，状态是算出来的」这个设计的核心函数。
#
# ★ pending 的定义是重点：**有 intent 但没有对应 outcome 的那些。**
#
# 日志停在 intent 说明进程死在「写完意图」和「写完结果」之间——
# 而副作用（写文件、发请求）就发生在那个窗口里。
# 所以这些操作**可能做了也可能没做**，这是崩溃恢复的全部难点。
#
# completed 用 idem 做键，因为恢复时要靠它跳过已完成的操作。
# pending 按 step 排序（恢复要从最早的未完成步开始）。
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
    steps: int = 0
    completed: dict[str, dict[str, Any]] = field(default_factory=dict)
    pending: list[Pending] = field(default_factory=list)
    last_text: str = ""
    finished: bool = False
    reason: str | None = None


def reduce(events: list[Event]) -> SessionState:
    raise NotImplementedError("TODO: 实现 reduce")


# ─────────────────────────────────────────────────────────────
# TODO 3：JSONL 文件存储
#
# ★ 为什么是 JSONL 而不是一个 JSON 数组，三条理由：
#
#   一 · **追加是 O(1)。** JSON 数组每次都要读全文、改、写回全文
#   二 · **崩溃只损坏最后一行。** 数组格式崩溃后整个文件都不是合法 JSON
#   三 · **能 tail -f。** 排查线上问题时这一条比前两条都实用
#
# ★ 读取时必须容忍坏行：崩溃时最后一行常常是写了一半的。
# 为这一行放弃整个会话，等于用一个小故障换一个大故障。
#
# 但**要数出来**（corrupt 属性）——静默跳过就没人知道发生过崩溃了。
# 这是这门课那条纪律的又一次出现：把静默失败变成响亮失败。
#
# seq 要从已有日志里接着排，不能每次从 0 开始。
#
# ★ Python 特有的两个坑，两个都会让你的日志在崩溃时丢掉最关键的几行：
#
# 一 · **追加写要显式 flush。** Python 的文件对象有自己的缓冲，
#      with 块结束才落盘。想真的落到磁盘还要 os.fsync(fh.fileno())。
#      fsync 很慢（每次都等磁盘），生产环境常常只 flush 不 fsync，
#      接受「进程崩了能救、机器断电救不了」这个折中。
#      这是个**显式的取舍**，不是可以忽略的细节。
#
# 二 · **json.dumps 默认 ensure_ascii=True。** 中文会被转成 \\uXXXX，
#      文件体积涨三倍，而且 tail 出来的日志人看不懂（L06 那个坑）。
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
    def __init__(self, path: str | Path) -> None:
        raise NotImplementedError("TODO: 实现 FileStore.__init__")

    def append(self, e: dict[str, Any]) -> Event:
        raise NotImplementedError("TODO: 实现 FileStore.append")

    def read(self) -> list[Event]:
        raise NotImplementedError("TODO: 实现 FileStore.read")

    @property
    def corrupt(self) -> int:
        raise NotImplementedError("TODO: 实现 FileStore.corrupt")


class MemoryStore(Store):
    def __init__(self) -> None:
        raise NotImplementedError("TODO: 实现 MemoryStore")

    def append(self, e: dict[str, Any]) -> Event:
        raise NotImplementedError

    def read(self) -> list[Event]:
        raise NotImplementedError

    @property
    def corrupt(self) -> int:
        return 0


# ─────────────────────────────────────────────────────────────
# TODO 4：快照
#
# 快照是为了避免每次恢复都 O(n) 回放全部日志。
#
# ★ 两个必须做对的地方：
#
# 一 · **快照必须记 upto**（覆盖到第几条事件）。
#      没有它你没法把快照和日志拼起来——要么重复应用事件，
#      要么漏掉事件，而两者都是静默的。
#
# 二 · **写快照必须先写临时文件再原子替换。**
#      读者因此永远看到完整的旧版或完整的新版。直接写目标文件的话，
#      崩在中间会留下一个半截快照——而**快照坏了比没有快照更糟**，
#      因为你会从一个错误的状态继续跑。
#
#      ★ Python 用 os.replace，不要用 os.rename：
#      两者在 POSIX 上都是原子的，但 **os.rename 在 Windows 上
#      目标文件已存在时会抛 FileExistsError**，而 os.replace 两个平台
#      都能覆盖。这是那种"跨平台"细节里真正会咬人的一个。
#
# restore 里注意顺序：快照的 completed 先铺上，再让 tail 的事件覆盖。
# ─────────────────────────────────────────────────────────────


@dataclass
class Snapshot:
    upto: int
    state: dict[str, Any]


def write_snapshot(path: str | Path, events: list[Event]) -> Snapshot:
    raise NotImplementedError("TODO: 实现 write_snapshot")


def read_snapshot(path: str | Path) -> Snapshot | None:
    raise NotImplementedError("TODO: 实现 read_snapshot")


def restore(snap: Snapshot | None, events: list[Event]) -> SessionState:
    raise NotImplementedError("TODO: 实现 restore")


# ─────────────────────────────────────────────────────────────
# TODO 5：恢复计划
#
# ★ 这是整个任务的重点。
#
# 工具按可重放性分三类：
#
#   'pure'       —— 没有副作用，随便重放。read_file / search
#   'idempotent' —— 有副作用但重复执行结果相同。write_file（覆盖写）
#   'once'       —— 重复执行会出事。send_email / create_order / git_commit
#
# pending 里的 'pure' 和 'idempotent' 直接重放。
#
# pending 里的 'once' 呢？它可能做了也可能没做，而重做会出事。
# **代码在这里没有正确答案，唯一诚实的做法是停下来问人。**
#
# 这就是为什么要有 ask 这个字段。很多人会在这里选一个默认行为
# （要么都重做，要么都跳过），而两个默认都会在某些情况下造成事故：
#   都重做 → 用户收到两封邮件 / 下了两个单
#   都跳过 → 该发的邮件没发，而日志显示这一步"完成"了
# ─────────────────────────────────────────────────────────────

Replayability = Literal["pure", "idempotent", "once"]


@dataclass
class ResumePlan:
    skip: list[str]
    redo: list[Pending]
    ask: list[Pending]
    resume_from: int


def plan_resume(st: SessionState, replayability: Any) -> ResumePlan:
    raise NotImplementedError("TODO: 实现 plan_resume")


def describe_plan(plan: ResumePlan) -> str:
    raise NotImplementedError("TODO: 实现 describe_plan")


def session_path(directory: str | Path, sid: str) -> Path:
    return Path(directory) / f"{sid}.jsonl"


def snapshot_path(directory: str | Path, sid: str) -> Path:
    return Path(directory) / f"{sid}.snapshot.json"


# ─────────────────────────────────────────────────────────────
# 观察实验
# ─────────────────────────────────────────────────────────────

DIR = Path(__file__).parent / ".sessions"


def fresh(sid: str) -> Store:
    session_path(DIR, sid).unlink(missing_ok=True)
    snapshot_path(DIR, sid).unlink(missing_ok=True)
    return FileStore(session_path(DIR, sid))


def demo_history_vs_state() -> None:
    print("\n【一】历史 vs 状态：为什么不能存 transcript")

    sid = "demo1-py"
    s = fresh(sid)
    s.append({"t": "task", "task": "把 config.json 里的端口改成 8080"})

    calls = [
        (1, "read_file", {"path": "config.json"}),
        (2, "read_file", {"path": "config.json"}),  # 模型又读了一遍
        (3, "write_file", {"path": "config.json", "content": '{"port":8080}'}),
    ]
    for step, tool, payload in calls:
        idem = idem_key(sid, tool, payload)
        s.append({"t": "intent", "step": step, "tool": tool, "input": payload, "idem": idem})
        s.append({"t": "outcome", "step": step, "idem": idem, "ok": True, "content": "(结果)"})

    st = s.state()
    print(f"  日志里有 {len(s.read())} 条事件")
    print(
        f"  派生出的状态：task=「{st.task}」，"
        f"完成 {len(st.completed)} 个操作，{st.steps} 步"
    )
    print(f"  注意 completed 是 {len(st.completed)} 个而不是 3 个——第 1、2 步参数一样，")
    print("  幂等键相同，所以它们是同一次操作。")
    print("\n  如果存的是 transcript，你只有一串消息；")
    print("  「现在完成了哪些操作」得靠人读一遍才知道，而且没法用代码判断。")


def demo_crash() -> None:
    print("\n【二】崩溃：intent 和 outcome 之间那个窗口")

    sid = "demo2-py"
    s = fresh(sid)
    s.append({"t": "task", "task": "给三个客户发对账单"})

    for step, to in [(1, "a@x.com"), (2, "b@x.com")]:
        idem = idem_key(sid, "send_email", {"to": to})
        s.append(
            {"t": "intent", "step": step, "tool": "send_email", "input": {"to": to}, "idem": idem}
        )
        s.append({"t": "outcome", "step": step, "idem": idem, "ok": True, "content": "sent"})

    idem3 = idem_key(sid, "send_email", {"to": "c@x.com"})
    s.append(
        {
            "t": "intent",
            "step": 3,
            "tool": "send_email",
            "input": {"to": "c@x.com"},
            "idem": idem3,
        }
    )
    print("  （进程在这里被 kill）")

    reopened = FileStore(session_path(DIR, sid))
    st = reopened.state()
    print(f"\n  恢复时读到：完成 {len(st.completed)} 个，pending {len(st.pending)} 个")
    print(f"  pending 那个是：{st.pending[0].tool}({st.pending[0].input})")
    print("\n  ★ 这封邮件发出去了吗？**日志无法回答。**")
    print("  进程死在「写完意图」和「写完结果」之间，而发邮件就在那个窗口里执行。")

    plan = plan_resume(st, lambda tool: "once" if tool == "send_email" else "pure")
    print(f"\n  恢复计划：{describe_plan(plan)}")
    print('\n  两个"聪明"的默认都会出事：')
    print("    都重做 → 客户 c 收到两封对账单")
    print('    都跳过 → 客户 c 一封都没收到，而日志显示这一步"处理过了"')
    print("  所以正确答案是 ask。**代码在这里没有正确答案。**")


def demo_replayability() -> None:
    print("\n【三】同样的崩溃，不同的工具，不同的处置")

    sid = "demo3-py"
    s = fresh(sid)
    s.append({"t": "task", "task": "整理代码"})

    tools: list[tuple[str, dict[str, Any], Replayability]] = [
        ("read_file", {"path": "a.py"}, "pure"),
        ("write_file", {"path": "b.py", "content": "x"}, "idempotent"),
        ("git_commit", {"message": "refactor"}, "once"),
    ]
    for i, (tool, payload, _) in enumerate(tools, start=1):
        s.append(
            {
                "t": "intent",
                "step": i,
                "tool": tool,
                "input": payload,
                "idem": idem_key(sid, tool, payload),
            }
        )

    kinds = {t: k for t, _, k in tools}
    plan = plan_resume(s.state(), lambda t: kinds.get(t, "once"))

    print("  三个操作全部 pending（全都崩在窗口里）。恢复计划：")
    print(f"    重放：{'、'.join(r.tool for r in plan.redo) or '（无）'}")
    print(f"    问人：{'、'.join(r.tool for r in plan.ask) or '（无）'}")
    print("\n  read_file 重放零风险，write_file 覆盖写重放也没事，")
    print("  git_commit 重放会多一个空提交或者报错——所以只有它需要问。")
    print("\n  ★ 这个分类必须由**工具的作者**声明，不能让恢复逻辑猜。")
    print("  猜的话，新加一个工具就是一次潜在事故。")


def demo_corrupt() -> None:
    print("\n【四】坏行：崩溃时写了一半的那一行")

    sid = "demo4-py"
    s = fresh(sid)
    s.append({"t": "task", "task": "任务"})
    idem = idem_key(sid, "read_file", {"path": "a"})
    s.append({"t": "intent", "step": 1, "tool": "read_file", "input": {"path": "a"}, "idem": idem})

    # 手动追加一个写了一半的行，模拟崩溃
    with session_path(DIR, sid).open("a", encoding="utf-8") as fh:
        fh.write('{"seq":3,"at":1,"t":"outco')

    reopened = FileStore(session_path(DIR, sid))
    events = reopened.read()
    print(f"  文件里有 3 行，读出来 {len(events)} 条有效事件，坏行 {reopened.corrupt} 条")
    print("\n  ★ 两件事都要做到：")
    print("    容忍 —— 不能因为最后一行坏了就放弃整个会话")
    print("    记数 —— corrupt > 0 说明发生过崩溃，这条要进日志和监控")
    print("  只做第一件的话，你永远不知道线上崩过多少次。")


def demo_snapshot() -> None:
    print("\n【五】快照：加速，但不是事实来源")

    sid = "demo5-py"
    s = fresh(sid)
    s.append({"t": "task", "task": "长任务"})
    for i in range(1, 21):
        payload = {"path": f"f{i}.py"}
        idem = idem_key(sid, "read_file", payload)
        s.append(
            {"t": "intent", "step": i, "tool": "read_file", "input": payload, "idem": idem}
        )
        s.append({"t": "outcome", "step": i, "idem": idem, "ok": True, "content": "(内容)"})

    snap = write_snapshot(snapshot_path(DIR, sid), s.read())
    print(f"  日志 {len(s.read())} 条，快照覆盖到 seq={snap.upto}")

    for i in range(21, 23):
        payload = {"path": f"f{i}.py"}
        idem = idem_key(sid, "read_file", payload)
        s.append(
            {"t": "intent", "step": i, "tool": "read_file", "input": payload, "idem": idem}
        )
        s.append({"t": "outcome", "step": i, "idem": idem, "ok": True, "content": "(内容)"})

    from_snap = restore(snap, s.read())
    from_scratch = reduce(s.read())
    print(f"  从快照恢复：{len(from_snap.completed)} 个完成操作，{from_snap.steps} 步")
    print(f"  从头回放：  {len(from_scratch.completed)} 个完成操作，{from_scratch.steps} 步")
    same = len(from_snap.completed) == len(from_scratch.completed)
    print(f"  一致：{'是' if same else '★ 不一致，有 bug'}")
    print("\n  快照只是加速。**日志才是事实来源**——所以快照坏了要能丢掉重放，")
    print("  而这要求快照文件和日志文件是分开的两个文件。")


# ─────────────────────────────────────────────────────────────
# TODO 6：动手改一个地方，看它怎么坏
#
# 把 write_snapshot 里的「先写 tmp 再 os.replace」改成直接写目标文件。
# 然后想清楚：在什么时刻被 kill 会留下一个半截快照？
# 下一次 restore 会发生什么？为什么这比"没有快照"更糟？
#
# 顺手试第二个：把 append 里的 flush + fsync 去掉，然后用
# os.kill(os.getpid(), signal.SIGKILL) 在写了几条之后杀掉自己，
# 看日志里少了几条。这一条是 Python 通道独有的。
#
# 改完记得改回来。
# ─────────────────────────────────────────────────────────────


def main() -> None:
    print("会话持久化与断点恢复。不调 API。")
    demo_history_vs_state()
    demo_crash()
    demo_replayability()
    demo_corrupt()
    demo_snapshot()
    print("\n" + "─" * 60)
    print("接着做 l08/memory.py。别忘了 TODO 6。")


if __name__ == "__main__":
    main()
