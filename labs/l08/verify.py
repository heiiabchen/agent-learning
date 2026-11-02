"""验证 l08/session.py 和 l08/memory.py。

    uv run python -m l08.verify

一次 API 都不调。

这套测试里有一整组专门盯着**记忆污染**和**恢复不幂等**：
冲突静默覆盖、推导深度不限、坏行静默跳过、pending 里的 once 工具被默认处置。
它们都不抛异常，只是让你的记忆慢慢跑偏、或者让客户收到两封邮件。

另有四项是 Python 通道独有的（都标了「Python」）：
ensure_ascii、os.replace、float("nan")、dataclasses.replace 不改入参。

先跑 VERIFY_TARGET=shared 确认测试本身是对的：
    VERIFY_TARGET=shared uv run python -m l08.verify
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

_target = "shared" if os.environ.get("VERIFY_TARGET") == "shared" else "mine"

if _target == "shared":
    from shared import memory as M
    from shared import store as S
else:
    from l08 import memory as M  # type: ignore[no-redef]
    from l08 import session as S  # type: ignore[no-redef]

print(
    "\n（测的是 shared/ 里的参考实现）" if _target == "shared" else "\n（测的是 l08/ 里你的实现）"
)

_passed = 0
_failures: list[str] = []


def test(name: str, fn: Callable[[], Any]) -> None:
    global _passed
    try:
        fn()
        _passed += 1
        print(f"\033[32m  ✓\033[0m {name}")
    except Exception as err:  # noqa: BLE001 - 测试跑器要吞掉一切
        _failures.append(name)
        print(f"\033[31m  ✕ {name}\033[0m")
        print(f"\033[31m      {err}\033[0m")


def ok(cond: Any, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def raises(fn: Callable[[], Any], hint: str) -> None:
    try:
        fn()
    except NotImplementedError:
        # 脚手架的 TODO 桩也会抛异常。不排除掉的话这些测试会假绿。
        raise
    except Exception:
        return
    raise AssertionError(f"应该抛异常但没有：{hint}")


TMP = Path(tempfile.mkdtemp(prefix="l08-"))
_n = 0


def tmp_file() -> Path:
    global _n
    _n += 1
    return TMP / f"s{_n}.jsonl"


def ev(t: str, seq: int = 0, **kw: Any) -> dict[str, Any]:
    return {"seq": seq, "at": seq, "t": t, **kw}


# ─────────────────────────────────────────────────────────────
print("\n幂等键")
# ─────────────────────────────────────────────────────────────

test(
    "同样的输入给同样的键",
    lambda: ok(
        S.idem_key("s1", "read_file", {"path": "a.py"})
        == S.idem_key("s1", "read_file", {"path": "a.py"}),
        "同样的输入给了不同的键",
    ),
)


def _order_stable() -> None:
    a = S.idem_key("s1", "write", {"path": "a", "content": "x"})
    b = S.idem_key("s1", "write", {"content": "x", "path": "a"})
    ok(
        a == b,
        f"顺序不同键就不同（{a} vs {b}）。\n"
        "      这是 L05 repeat_key 那个坑的同一个版本：\n"
        "      直接 json.dumps 的话，SDK 换一版字段顺序，你的幂等防线就静默失效了",
    )


test("★ 字段顺序变了键不能变", _order_stable)

test(
    "不同工具给不同键",
    lambda: ok(
        S.idem_key("s1", "read_file", {"p": 1}) != S.idem_key("s1", "write_file", {"p": 1}),
        "不同工具的键撞了",
    ),
)

test(
    "★ 不同会话给不同键（否则会跨会话误跳过）",
    lambda: ok(
        S.idem_key("s1", "read_file", {"p": 1}) != S.idem_key("s2", "read_file", {"p": 1}),
        '两个会话的相同调用键相同，恢复时会互相"跳过"对方的操作',
    ),
)

test(
    "嵌套对象也稳定",
    lambda: ok(
        S.idem_key("s", "t", {"a": {"x": 1, "y": 2}, "b": [1, 2]})
        == S.idem_key("s", "t", {"b": [1, 2], "a": {"y": 2, "x": 1}}),
        "嵌套对象的字段顺序影响了键",
    ),
)


def _weird_payload() -> None:
    # 工具参数是模型给的，什么都可能有。json.dumps 遇到不认识的对象会抛
    # TypeError，而这里抛异常等于让一个奇怪的参数搞崩整个 agent。
    key = S.idem_key("s", "t", {"when": object()})
    ok(isinstance(key, str) and len(key) > 0, "不可序列化的参数应该退化处理而不是抛异常")


test("Python：不可序列化的参数不该让 idem_key 抛异常（default=str）", _weird_payload)

# ─────────────────────────────────────────────────────────────
print("\n派生状态")
# ─────────────────────────────────────────────────────────────

test(
    "task 事件填 task 字段",
    lambda: ok(S.reduce([ev("task", 1, task="干活")]).task == "干活", "task 没填上"),
)


def _pair() -> None:
    st = S.reduce(
        [
            ev("intent", 1, step=1, tool="read", input={}, idem="k1"),
            ev("outcome", 2, step=1, idem="k1", ok=True, content="内容"),
        ]
    )
    ok(len(st.completed) == 1, f"completed 应该 1 个，实际 {len(st.completed)}")
    ok(st.completed["k1"]["content"] == "内容", "content 没存进去")
    ok(not st.pending, f"配对了就不该 pending，实际 {len(st.pending)}")


test("intent + outcome 配对后进 completed", _pair)


def _orphan_intent() -> None:
    st = S.reduce([ev("intent", 1, step=3, tool="send_email", input={"to": "a"}, idem="k")])
    ok(
        len(st.pending) == 1,
        f"pending 应该 1 个，实际 {len(st.pending)}。\n"
        "      这是崩溃恢复的全部难点：这些操作可能做了也可能没做",
    )
    ok(st.pending[0].tool == "send_email", f"实际 {st.pending[0].tool}")


test("★ 只有 intent 没有 outcome 的进 pending", _orphan_intent)


def _pending_sorted() -> None:
    st = S.reduce(
        [
            ev("intent", 1, step=5, tool="a", input={}, idem="k5"),
            ev("intent", 2, step=2, tool="b", input={}, idem="k2"),
            ev("intent", 3, step=9, tool="c", input={}, idem="k9"),
        ]
    )
    got = ",".join(str(p.step) for p in st.pending)
    ok(got == "2,5,9", f"没排序：{got}")


test("pending 按 step 排序（恢复要从最早的未完成步开始）", _pending_sorted)


def _steps_max() -> None:
    st = S.reduce(
        [
            ev("intent", 1, step=1, tool="a", input={}, idem="k1"),
            ev("outcome", 2, step=1, idem="k1", ok=True, content=""),
            ev("intent", 3, step=7, tool="b", input={}, idem="k7"),
            ev("outcome", 4, step=7, idem="k7", ok=True, content=""),
        ]
    )
    ok(st.steps == 7, f"steps 应该是 7，实际 {st.steps}")


test("steps 取已完成步的最大值", _steps_max)


def _done() -> None:
    st = S.reduce([ev("done", 1, reason="step_limit")])
    ok(st.finished, "finished 应该是 True")
    ok(st.reason == "step_limit", f"reason 实际 {st.reason}")


test("done 事件设 finished 和 reason", _done)


def _failed_outcome() -> None:
    st = S.reduce(
        [
            ev("intent", 1, step=1, tool="a", input={}, idem="k"),
            ev("outcome", 2, step=1, idem="k", ok=False, content="文件不存在"),
        ]
    )
    ok(
        len(st.completed) == 1 and not st.pending,
        "失败的调用已经执行过了，重做会得到同样的失败还多付一次钱",
    )
    ok(st.completed["k"]["ok"] is False, "ok 标记要保留")


test("失败的 outcome 也算完成（不该重做）", _failed_outcome)

# ─────────────────────────────────────────────────────────────
print("\n存储")
# ─────────────────────────────────────────────────────────────


def _mem_store() -> None:
    s = S.MemoryStore()
    s.append({"t": "task", "task": "x"})
    ok(len(s.read()) == 1, f"实际 {len(s.read())}")
    ok(s.state().task == "x", "状态没派生出来")


test("内存 store 的 append / read / state 联通", _mem_store)


def _seq_at() -> None:
    s = S.MemoryStore()
    a = s.append({"t": "text", "text": "1"})
    b = s.append({"t": "text", "text": "2"})
    ok(a["seq"] == 1 and b["seq"] == 2, f"seq 不对：{a['seq']}, {b['seq']}")
    ok(isinstance(a["at"], (int, float)) and a["at"] > 0, "at 没填")


test("append 自动填 seq 和 at", _seq_at)


def _file_roundtrip() -> None:
    p = tmp_file()
    s = S.FileStore(p)
    s.append({"t": "task", "task": "落盘测试"})
    s.append({"t": "text", "text": "hello"})
    reopened = S.FileStore(p)
    ok(len(reopened.read()) == 2, f"读回 {len(reopened.read())} 条")
    ok(reopened.state().task == "落盘测试", "状态不对")


test("文件 store 落盘并读回", _file_roundtrip)


def _jsonl() -> None:
    p = tmp_file()
    s = S.FileStore(p)
    s.append({"t": "text", "text": "a"})
    s.append({"t": "text", "text": "b"})
    lines = p.read_text(encoding="utf-8").strip().split("\n")
    ok(
        len(lines) == 2,
        f"应该是 2 行，实际 {len(lines)}。\n"
        "      写成 JSON 数组的话：追加是 O(n)，而且崩溃后整个文件都不是合法 JSON",
    )
    for line in lines:
        json.loads(line)  # 每行独立合法


test("★ 是 JSONL：一行一个事件（能 tail、崩溃只坏一行）", _jsonl)


def _cjk_raw() -> None:
    p = tmp_file()
    S.FileStore(p).append({"t": "task", "task": "把端口改成 8080"})
    raw = p.read_text(encoding="utf-8")
    ok(
        "把端口改成" in raw,
        "日志里的中文被转义成了 \\uXXXX。\n"
        "      json.dumps 默认 ensure_ascii=True：文件体积涨三倍，\n"
        "      而且 tail 出来的日志人看不懂——排查线上问题时这一条最疼",
    )


test("Python：★ 日志里的中文不该被转义（ensure_ascii=False）", _cjk_raw)


def _seq_continues() -> None:
    p = tmp_file()
    S.FileStore(p).append({"t": "text", "text": "a"})
    e = S.FileStore(p).append({"t": "text", "text": "b"})
    ok(e["seq"] == 2, f"seq 应该是 2，实际 {e['seq']}。重复的 seq 会让快照对不齐")


test("重新打开时 seq 接着排（不能从 0 重来）", _seq_continues)


def _tolerate_half_line() -> None:
    p = tmp_file()
    S.FileStore(p).append({"t": "task", "task": "x"})
    with p.open("a", encoding="utf-8") as fh:
        fh.write('{"seq":2,"at":1,"t":"outco')
    events = S.FileStore(p).read()
    ok(
        len(events) == 1,
        f"应该读出 1 条有效事件，实际 {len(events)}。\n"
        "      为最后一行坏了就放弃整个会话，等于用一个小故障换一个大故障",
    )


test("★ 容忍写了一半的最后一行（崩溃现场）", _tolerate_half_line)


def _count_corrupt() -> None:
    p = tmp_file()
    S.FileStore(p).append({"t": "task", "task": "x"})
    with p.open("a", encoding="utf-8") as fh:
        fh.write('{"broken\n')
    reopened = S.FileStore(p)
    reopened.read()
    ok(
        reopened.corrupt > 0,
        "corrupt 应该 > 0。静默跳过坏行的话，你永远不知道线上崩过多少次",
    )


test("★ 坏行要被数出来（corrupt > 0）", _count_corrupt)


def _blank_lines_ok() -> None:
    p = tmp_file()
    S.FileStore(p).append({"t": "task", "task": "x"})
    with p.open("a", encoding="utf-8") as fh:
        fh.write("\n\n")
    reopened = S.FileStore(p)
    reopened.read()
    ok(reopened.corrupt == 0, f"空行不该算坏行，实际 corrupt={reopened.corrupt}")


test("空行不算坏行", _blank_lines_ok)

test(
    "文件不存在时返回空列表而不是抛错",
    lambda: ok(len(S.FileStore(TMP / "never-written.jsonl").read()) == 0, "新会话应该是空的"),
)

# ─────────────────────────────────────────────────────────────
print("\n快照")
# ─────────────────────────────────────────────────────────────


def long_log() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seq = 0
    for i in range(1, 11):
        seq += 1
        out.append(ev("intent", seq, step=i, tool="read", input={"i": i}, idem=f"k{i}"))
        seq += 1
        out.append(ev("outcome", seq, step=i, idem=f"k{i}", ok=True, content=f"c{i}"))
    return out


def _upto() -> None:
    snap = S.write_snapshot(TMP / "a.snapshot.json", long_log())
    ok(
        snap.upto == 20,
        f"upto 应该是 20，实际 {snap.upto}。\n"
        "      没有 upto 你要么重复应用事件，要么漏掉事件，而两者都是静默的",
    )


test("★ 快照记 upto（否则没法和日志拼起来）", _upto)


def _atomic() -> None:
    p = TMP / "atomic.snapshot.json"
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.unlink(missing_ok=True)
    S.write_snapshot(p, long_log())
    ok(
        not tmp.exists(),
        "写完之后 .tmp 还在，说明没做原子替换。\n"
        "      直接写目标文件的话，崩在中间会留下半截快照——\n"
        "      而快照坏了比没有快照更糟：你会从一个错误的状态继续跑",
    )
    ok(json.loads(p.read_text(encoding="utf-8"))["upto"] == 20, "快照内容不对")


test("★ 快照用先写 tmp 再原子替换", _atomic)


def _overwrite_twice() -> None:
    # os.rename 在 Windows 上目标存在会抛 FileExistsError，os.replace 不会。
    # 这条在 macOS/Linux 上永远绿，但它钉住的是一个真实的跨平台差异。
    p = TMP / "twice.snapshot.json"
    S.write_snapshot(p, long_log())
    snap = S.write_snapshot(p, long_log()[:10])
    ok(snap.upto == 10, f"第二次写快照应该覆盖成功，实际 upto={snap.upto}")


test("Python：★ 快照能被反复覆盖（os.replace 而不是 os.rename）", _overwrite_twice)


def _snap_matches_scratch() -> None:
    events = long_log()
    snap = S.write_snapshot(TMP / "b.snapshot.json", events[:10])
    from_snap = S.restore(snap, events)
    from_scratch = S.reduce(events)
    ok(
        len(from_snap.completed) == len(from_scratch.completed),
        f"completed 不一致：{len(from_snap.completed)} vs {len(from_scratch.completed)}",
    )
    ok(
        from_snap.steps == from_scratch.steps,
        f"steps 不一致：{from_snap.steps} vs {from_scratch.steps}",
    )


test("从快照恢复和从头回放结果一致", _snap_matches_scratch)


def _restore_none() -> None:
    events = long_log()
    a = S.restore(None, events)
    b = S.reduce(events)
    ok(len(a.completed) == len(b.completed) and a.steps == b.steps, "空快照的退化路径不对")


test("restore(None, events) 等价于 reduce(events)", _restore_none)


def _tail_pending() -> None:
    events = long_log()
    snap = S.write_snapshot(TMP / "c.snapshot.json", events)
    events.append(ev("intent", 21, step=11, tool="send_email", input={}, idem="k11"))
    st = S.restore(snap, events)
    ok(
        len(st.pending) == 1,
        f"pending 应该 1 个，实际 {len(st.pending)}。\n"
        "      漏掉快照之后的 pending，等于漏掉最需要处理的那一条",
    )


test("★ 快照之后新增的 pending 要能看到", _tail_pending)


def _bad_snapshot() -> None:
    p = tmp_file()
    s = S.FileStore(p)
    s.append({"t": "task", "task": "x"})
    snap_path = p.with_suffix(".snapshot.json")
    S.write_snapshot(snap_path, s.read())
    snap_path.write_text("{坏掉的快照", encoding="utf-8")
    ok(S.read_snapshot(snap_path) is None, "坏快照应该返回 None 而不是抛异常")
    ok(S.FileStore(p).state().task == "x", "快照坏掉不该影响日志——日志才是事实来源")


test("快照坏了不影响日志（两个文件必须分开）", _bad_snapshot)

# ─────────────────────────────────────────────────────────────
print("\n恢复计划")
# ─────────────────────────────────────────────────────────────

KINDS: dict[str, str] = {
    "read_file": "pure",
    "write_file": "idempotent",
    "send_email": "once",
    "git_commit": "once",
}


def kind_of(t: str) -> Any:
    return KINDS.get(t, "once")


def _skip() -> None:
    st = S.reduce(
        [
            ev("intent", 1, step=1, tool="read_file", input={}, idem="k1"),
            ev("outcome", 2, step=1, idem="k1", ok=True, content=""),
        ]
    )
    plan = S.plan_resume(st, kind_of)
    ok(plan.skip == ["k1"], f"skip 不对：{plan.skip}")


test("已完成的进 skip", _skip)


def _pure_redo() -> None:
    st = S.reduce([ev("intent", 1, step=2, tool="read_file", input={}, idem="k")])
    plan = S.plan_resume(st, kind_of)
    ok(len(plan.redo) == 1, f"redo 应该 1 个，实际 {len(plan.redo)}")
    ok(not plan.ask, "read_file 不需要问人")


test("pending 里的 pure 工具进 redo", _pure_redo)


def _idem_redo() -> None:
    st = S.reduce([ev("intent", 1, step=2, tool="write_file", input={}, idem="k")])
    plan = S.plan_resume(st, kind_of)
    ok(len(plan.redo) == 1 and not plan.ask, "覆盖写重放没有风险")


test("pending 里的 idempotent 工具也进 redo", _idem_redo)


def _once_ask() -> None:
    st = S.reduce([ev("intent", 1, step=2, tool="send_email", input={"to": "a"}, idem="k")])
    plan = S.plan_resume(st, kind_of)
    ok(
        len(plan.ask) == 1,
        f"ask 应该 1 个，实际 {len(plan.ask)}（redo={len(plan.redo)}）。\n"
        "      两个默认都会出事：都重做 → 客户收两封邮件；\n"
        "      都跳过 → 该发的没发而日志显示这一步处理过了",
    )
    ok(not plan.redo, "once 工具不该进 redo")


test("★ pending 里的 once 工具必须进 ask，不能默认处置", _once_ask)


def _mixed() -> None:
    st = S.reduce(
        [
            ev("intent", 1, step=1, tool="read_file", input={}, idem="k1"),
            ev("intent", 2, step=2, tool="git_commit", input={}, idem="k2"),
            ev("intent", 3, step=3, tool="write_file", input={}, idem="k3"),
        ]
    )
    plan = S.plan_resume(st, kind_of)
    ok(len(plan.redo) == 2, f"redo 应该 2 个，实际 {len(plan.redo)}")
    ok(len(plan.ask) == 1 and plan.ask[0].tool == "git_commit", "ask 不对")


test("pure 和 once 混在一起时各归各位", _mixed)


def _resume_from_pending() -> None:
    st = S.reduce(
        [
            ev("intent", 1, step=1, tool="read_file", input={}, idem="k1"),
            ev("outcome", 2, step=1, idem="k1", ok=True, content=""),
            ev("intent", 3, step=4, tool="read_file", input={}, idem="k4"),
        ]
    )
    plan = S.plan_resume(st, kind_of)
    ok(plan.resume_from == 4, f"resume_from 应该是 4，实际 {plan.resume_from}")


test("resume_from 是最早的 pending 步", _resume_from_pending)


def _resume_from_next() -> None:
    st = S.reduce(
        [
            ev("intent", 1, step=3, tool="read_file", input={}, idem="k"),
            ev("outcome", 2, step=3, idem="k", ok=True, content=""),
        ]
    )
    plan = S.plan_resume(st, kind_of)
    ok(plan.resume_from == 4, f"resume_from 应该是 4，实际 {plan.resume_from}")


test("没有 pending 时 resume_from 是下一步", _resume_from_next)


def _describe() -> None:
    st = S.reduce([ev("intent", 1, step=1, tool="send_email", input={}, idem="k")])
    text = S.describe_plan(S.plan_resume(st, kind_of))
    ok(
        ("确认" in text or "人工" in text) and "send_email" in text,
        f"描述里要点出需要确认的工具名，实际：{text}",
    )


test("describe_plan 在需要人工确认时说出来", _describe)

# ─────────────────────────────────────────────────────────────
print("\n记忆：四道闸")
# ─────────────────────────────────────────────────────────────

DAY = M.DAY_S if hasattr(M, "DAY_S") else 86_400.0
_clock = [1_767_225_600.0]  # 2026-01-01 UTC


def now() -> float:
    return _clock[0]


def advance(days: float) -> None:
    _clock[0] += days * DAY


def mem(**kw: Any) -> Any:
    return M.Memory(now=now, **kw)


def f(**kw: Any) -> Any:
    base: dict[str, Any] = {
        "kind": "observed",
        "source": "session-1",
        "evidence": "（原话）",
        "depth": 0,
        "confidence": 0.9,
    }
    base.update(kw)
    return M.Fact(**base)


def _normal_write() -> None:
    m = mem()
    r = m.remember(f(key="user.pm", value="pnpm"))
    ok(r.written, f"没写进去：{r.reason}")
    ok(m.size == 1, f"size 应该是 1，实际 {m.size}")


test("正常的观察能写进去", _normal_write)

test(
    "★ 没有 source 要抛异常",
    lambda: raises(
        lambda: mem().remember(f(key="a.b", value="x", source="")),
        "没有出处的事实，发现污染时你没法顺着删掉一整批",
    ),
)

test(
    "★ observed 没有 evidence 要抛异常",
    lambda: raises(
        lambda: mem().remember(f(key="a.b", value="x", evidence="")),
        '没有原话的"观察"其实是推导。这道闸把两者强行分开',
    ),
)


def _derived_no_evidence() -> None:
    r = mem().remember(
        f(key="a.b", value="x", kind="derived", depth=1, evidence=None)
    )
    ok(r.written, f"derived 应该允许没有 evidence：{r.reason}")


test("derived 不强制 evidence（它的证据是被推导的那些 observed）", _derived_no_evidence)


def _depth_gate() -> None:
    r = mem(max_depth=1).remember(f(key="a.b", value="x", kind="derived", depth=2))
    ok(
        not r.written,
        "depth=2 应该被拒。从推导结果再推导会复合误差，而结果长得和观察一模一样",
    )
    ok(bool(r.reason), "拒绝要给理由")


test("★ 推导深度超上限就不写（记忆跑偏的主要机制）", _depth_gate)

test(
    "置信度低于下限就不写",
    lambda: ok(
        not mem(min_confidence=0.6).remember(f(key="a.b", value="x", confidence=0.4)).written,
        "低置信度应该被拒——宁可再问一次",
    ),
)


def _gate_kinds() -> None:
    # source/evidence 缺失 = 调用方写错了代码 → 抛
    raises(lambda: mem().remember(f(key="a.b", value="x", source="")), "source 缺失")
    # depth/confidence 不够 = 数据不够好 → 不抛
    r = mem().remember(f(key="a.b", value="x", confidence=0.1))
    ok(r.written is False, "置信度不足应该返回 False 而不是抛异常")


test("闸的类型分对：代码 bug 抛异常，数据不足静静返回 False", _gate_kinds)

# ─────────────────────────────────────────────────────────────
print("\n记忆：冲突")
# ─────────────────────────────────────────────────────────────


def _no_silent_overwrite() -> None:
    m = mem()
    m.remember(f(key="user.pm", value="pnpm"))
    r = m.remember(f(key="user.pm", value="npm"))
    ok(
        not r.written and r.conflict is not None,
        f"应该返回 conflict 而不是覆盖。written={r.written}\n"
        "      静默覆盖 → 一次幻觉就能永久改掉一条正确的事实",
    )
    ok(r.conflict.existing.value == "pnpm", "冲突里要带旧值")
    ok(r.conflict.incoming.value == "npm", "冲突里要带新值")


test("★ 同 key 不同值不能静默覆盖", _no_silent_overwrite)


def _same_value_ok() -> None:
    m = mem()
    m.remember(f(key="user.pm", value="pnpm"))
    r = m.remember(f(key="user.pm", value="pnpm"))
    ok(r.written and r.conflict is None, "同值重复写应该直接更新时间戳")


test("同 key 同值不算冲突", _same_value_ok)


def _resolve_replace() -> None:
    m = mem()
    m.remember(f(key="user.pm", value="pnpm"))
    r = m.remember(f(key="user.pm", value="npm"), resolve="replace")
    ok(r.written, f"显式 replace 应该写进去：{r.reason}")
    ok(m.recall(["user.pm"])[0].fact.value == "npm", "值没换")


test("resolve='replace' 才真的覆盖", _resolve_replace)


def _resolve_keep() -> None:
    m = mem()
    m.remember(f(key="user.pm", value="pnpm"))
    r = m.remember(f(key="user.pm", value="npm"), resolve="keep")
    ok(not r.written, "keep 时不该写")
    ok(m.recall(["user.pm"])[0].fact.value == "pnpm", "旧值被改掉了")


test("resolve='keep' 保留旧值", _resolve_keep)


def _derived_cant_beat_observed() -> None:
    m = mem()
    m.remember(f(key="user.pm", value="pnpm"))
    r = m.remember(
        f(key="user.pm", value="yarn", kind="derived", depth=1, evidence=None),
        resolve="replace",
    )
    ok(not r.written, "就算显式 replace，derived 也不该推翻 observed。要改就拿新的观察来改")


test("★ 推导结果不许覆盖直接观察到的事实", _derived_cant_beat_observed)


def _observed_beats_derived() -> None:
    m = mem()
    m.remember(f(key="user.pm", value="yarn", kind="derived", depth=1, evidence=None))
    r = m.remember(f(key="user.pm", value="pnpm"), resolve="replace")
    ok(r.written, f"observed 应该能覆盖 derived：{r.reason}")


test("observed 可以覆盖 derived（反过来才不行）", _observed_beats_derived)


def _hits_reset() -> None:
    m = mem()
    m.remember(f(key="user.pm", value="pnpm"))
    for _ in range(3):
        m.recall(["user.pm"])
    m.remember(f(key="user.pm", value="npm"), resolve="replace")
    hits = next(x for x in m.all() if x.key == "user.pm").hits
    ok(hits == 0, f"hits 应该归零，实际 {hits}。旧值被用过 3 次不代表新值可靠")


test("★ 值变了 hits 不能继承（旧值被用过不代表新值可靠）", _hits_reset)


def _hits_kept() -> None:
    m = mem()
    m.remember(f(key="user.pm", value="pnpm"))
    m.recall(["user.pm"])
    m.recall(["user.pm"])
    m.remember(f(key="user.pm", value="pnpm"))
    hits = next(x for x in m.all() if x.key == "user.pm").hits
    ok(hits == 2, f"hits 应该保留为 2，实际 {hits}")


test("值没变时 hits 保留（同一条事实的使用历史有效）", _hits_kept)


def _timestamps() -> None:
    m = mem()
    m.remember(f(key="user.pm", value="pnpm"))
    created = m.all()[0].created_at
    advance(1)
    m.remember(f(key="user.pm", value="pnpm"))
    after = m.all()[0]
    ok(after.created_at == created, "created_at 被改了")
    ok(after.updated_at > created, "updated_at 没更新")


test("created_at 不被更新覆盖，updated_at 要更新", _timestamps)


def _no_mutation() -> None:
    m = mem()
    incoming = f(key="user.pm", value="pnpm")
    m.remember(incoming)
    ok(
        incoming.created_at == 0.0 and incoming.updated_at == 0.0,
        "remember 原地改了调用方传进来的 Fact。\n"
        "      调用方可能还拿着那个对象（比如打日志、重试）——\n"
        "      用 dataclasses.replace 造一个新的，不要 mutate 入参",
    )


test("Python：★ remember 不该原地修改传进来的 Fact", _no_mutation)

# ─────────────────────────────────────────────────────────────
print("\n记忆：召回与淘汰")
# ─────────────────────────────────────────────────────────────


def _recall_exact() -> None:
    m = mem()
    m.remember(f(key="user.pm", value="pnpm"))
    m.remember(f(key="user.editor", value="vim"))
    got = m.recall(["user.pm"])
    ok(len(got) == 1 and got[0].fact.value == "pnpm", f"实际 {got}")


test("按 key 精确召回", _recall_exact)


def _recall_prefix() -> None:
    m = mem()
    m.remember(f(key="user.pm", value="pnpm"))
    m.remember(f(key="user.editor", value="vim"))
    m.remember(f(key="project.ci", value="gha"))
    n = len(m.recall(["user."]))
    ok(n == 2, f"前缀召回应该 2 条，实际 {n}")


test("前缀召回（user. 拿整个命名空间）", _recall_prefix)

test(
    "不存在的 key 不崩、不返回空条目",
    lambda: ok(len(mem().recall(["nope.nope"])) == 0, "不该返回东西"),
)


def _stale_returned() -> None:
    m = mem()
    m.remember(f(key="p.python", value="3.12", ttl_s=30 * DAY))
    advance(60)
    got = m.recall(["p.python"])
    ok(
        len(got) == 1,
        "过期的也要返回。藏起来的话模型不知道自己曾经知道过什么，只会重新问一遍",
    )
    ok(got[0].stale, "stale 应该是 True")


test("★ 过期的事实要返回并标 stale（不是藏起来）", _stale_returned)


def _no_ttl_never_stale() -> None:
    m = mem()
    m.remember(f(key="u.name", value="张三"))
    advance(3650)
    ok(not m.recall(["u.name"])[0].stale, "没有 ttl 就不该判过期")


test("没有 ttl 的事实永不 stale", _no_ttl_never_stale)


def _recall_order() -> None:
    m = mem()
    m.remember(
        f(key="a.d", value="x", kind="derived", depth=1, confidence=0.99, evidence=None)
    )
    m.remember(f(key="b.o1", value="y", confidence=0.7))
    m.remember(f(key="c.o2", value="z", confidence=0.95))
    keys = [i.fact.key for i in m.recall()]
    ok(
        keys[:3] == ["c.o2", "b.o1", "a.d"],
        f"顺序不对：{','.join(keys)}。顺序影响模型的注意力分配（L05x），不是随便排的",
    )


test("★ 召回顺序：observed 在前，同类按置信度降序", _recall_order)


def _hits_increment() -> None:
    m = mem()
    m.remember(f(key="a.b", value="x"))
    m.recall(["a.b"])
    m.recall(["a.b"])
    ok(m.all()[0].hits == 2, f"hits 应该是 2，实际 {m.all()[0].hits}")


test("recall 会累加 hits", _hits_increment)


def _no_dupes() -> None:
    m = mem()
    m.remember(f(key="user.pm", value="pnpm"))
    ok(len(m.recall(["user.", "user.pm"])) == 1, "同一条被返回了两次")


test("前缀和精确 key 都命中同一条时不重复返回", _no_dupes)


def _forget() -> None:
    m = mem()
    m.remember(f(key="a.1", value="x", source="bad-session"))
    m.remember(f(key="a.2", value="y", source="bad-session"))
    m.remember(f(key="a.3", value="z", source="good"))
    n = m.forget(lambda x: x.source == "bad-session")
    ok(n == 2, f"应该删 2 条，实际 {n}")
    ok(m.size == 1, f"剩 1 条，实际 {m.size}")


test("forget 按谓词批量删（发现污染后按 source 删）", _forget)


def _evict_expired_first() -> None:
    m = mem()
    m.remember(f(key="a.fresh", value="x"))
    m.remember(f(key="b.expired", value="y", ttl_s=DAY))
    advance(10)
    dropped = m.evict(1)
    ok(
        len(dropped) == 1 and dropped[0].key == "b.expired",
        f"应该先淘汰过期的，实际淘汰了 {','.join(x.key for x in dropped)}",
    )


test("★ 淘汰时过期的先走", _evict_expired_first)


def _evict_unused_first() -> None:
    m = mem()
    m.remember(f(key="a.used", value="x"))
    m.remember(f(key="b.unused", value="y"))
    for _ in range(5):
        m.recall(["a.used"])
    dropped = m.evict(1)
    ok(
        dropped[0].key == "b.unused",
        f"应该淘汰没用过的，实际 {dropped[0].key}。\n"
        '      使用频率是"这条还有用"的最好代理指标——它是观察到的，\n'
        "      而置信度是模型自己报的",
    )


test("★ 淘汰时从没被召回过的比常用的先走", _evict_unused_first)


def _no_evict_under_limit() -> None:
    m = mem()
    m.remember(f(key="a.b", value="x"))
    ok(len(m.evict(5)) == 0, "没超限就不该动")


test("没超限时不淘汰", _no_evict_under_limit)

# ─────────────────────────────────────────────────────────────
print("\n记忆：渲染与解析")
# ─────────────────────────────────────────────────────────────

test(
    "空记忆渲染成空字符串（不占 token）",
    lambda: ok(
        M.render_memory([]) == "",
        "空记忆应该渲染成空串，不要输出一个空的 <memory></memory>——那会白占 token",
    ),
)


def _render_source() -> None:
    m = mem()
    m.remember(f(key="user.pm", value="pnpm", source="session-42", evidence="我用 pnpm"))
    text = M.render_memory(m.recall())
    ok(
        "session-42" in text,
        f"渲染里没有出处：\n{text}\n      模型会把你给它的一切当成事实，带上出处它才有机会质疑",
    )


test("★ 渲染必须带出处", _render_source)


def _render_split() -> None:
    m = mem()
    m.remember(f(key="a.o", value="x"))
    m.remember(f(key="b.d", value="y", kind="derived", depth=1, evidence=None))
    text = M.render_memory(m.recall())
    ok(
        "observed" in text and "derived" in text,
        f"渲染里要分区块：\n{text}\n      不分的话，一条三个月前推导出来的判断会被当成铁律",
    )


test("★ 渲染必须区分 observed 和 derived", _render_split)


def _render_stale() -> None:
    m = mem()
    m.remember(f(key="p.python", value="3.12", ttl_s=DAY))
    advance(10)
    text = M.render_memory(m.recall())
    ok("过期" in text or "stale" in text.lower(), f"stale 没标出来：\n{text}")


test("stale 要在渲染里标出来", _render_stale)


def _parse_good() -> None:
    facts, _ = M.parse_extraction("user.pm | pnpm | observed | 0.95 | 我们用 pnpm")
    ok(len(facts) == 1, f"应该收 1 条，实际 {len(facts)}")
    ok(
        facts[0].key == "user.pm" and facts[0].confidence == 0.95,
        f"解析错了：{facts[0]}",
    )


test("解析：合格的行收下", _parse_good)


def _parse_bad_kind() -> None:
    facts, skipped = M.parse_extraction("user.pm | pnpm | maybe | 0.9 | 原话")
    ok(
        not facts and len(skipped) == 1,
        f"应该跳过，实际收了 {len(facts)} 条。\n"
        "      默认成 observed 的后果：一条推测被当成事实永久存下来",
    )


test("★ kind 写错的行跳过，不能默认成 observed", _parse_bad_kind)


def _parse_no_namespace() -> None:
    facts, skipped = M.parse_extraction("pm | pnpm | observed | 0.9 | 原话")
    ok(
        not facts and len(skipped) == 1,
        "不强制命名空间的话，三个月后你会有 pm、packageManager、package_manager 三条互相矛盾的事实",
    )


test("★ key 里没有点号的跳过（强制命名空间）", _parse_no_namespace)

test(
    "置信度不是数字的跳过",
    lambda: ok(
        not M.parse_extraction("user.pm | pnpm | observed | 高 | 原话")[0],
        "非数字置信度应该跳过",
    ),
)

test(
    "置信度超出 0-1 的跳过",
    lambda: ok(
        not M.parse_extraction("user.pm | pnpm | observed | 95 | 原话")[0],
        "95 不是 0-1 的置信度，应该跳过（不要当成 0.95 猜）",
    ),
)


def _parse_nan() -> None:
    facts, skipped = M.parse_extraction("user.pm | pnpm | observed | nan | 原话")
    ok(
        not facts and len(skipped) == 1,
        'float("nan") 和 float("inf") 都**不抛** ValueError——它们是合法的 float。\n'
        "      所以除了 try/except 之外还得显式检查 0 <= c <= 1。\n"
        "      漏了这一条，一个 nan 置信度会绕过闸四直接写进长期记忆",
    )


test("Python：★ nan / inf 置信度要被挡住（float() 不抛）", _parse_nan)

test(
    "字段不足的跳过",
    lambda: ok(
        M.parse_extraction("user.pm | pnpm") == ([], ["user.pm | pnpm"]),
        "字段不足应该跳过而不是猜",
    ),
)


def _parse_none() -> None:
    facts, skipped = M.parse_extraction("NONE\n\n   \n")
    ok(not facts and not skipped, f"NONE 不该算坏行，实际 skipped={len(skipped)}")


test("NONE 和空行不算坏行", _parse_none)


def _parse_bullet() -> None:
    facts, _ = M.parse_extraction("- user.pm | pnpm | observed | 0.9 | 原话")
    ok(len(facts) == 1 and facts[0].key == "user.pm", f"实际 {facts}")


test("剥掉模型爱加的列表符号", _parse_bullet)


def _parse_empty_evidence() -> None:
    facts, _ = M.parse_extraction("user.s | x | derived | 0.7 |")
    ok(len(facts) == 1, f"应该收下（derived 不强制原话），实际 {len(facts)}")
    ok(facts[0].evidence is None, f"evidence 应该是 None，实际 {facts[0].evidence!r}")


test("原话为空时 evidence 是 None 而不是空串", _parse_empty_evidence)


def _contradictions() -> None:
    facts, _ = M.parse_extraction(
        "user.pm | pnpm | observed | 0.9 | 用 pnpm\nuser.pm | npm | observed | 0.8 | 算了改用 npm"
    )
    c = M.find_contradictions(facts)
    ok(
        len(c) == 1 and c[0][0] == "user.pm",
        f"应该检测出 user.pm 矛盾，实际 {c}。\n"
        "      写入前检测比写入后靠冲突解决便宜得多",
    )
    ok(len(c[0][1]) == 2, f"应该列出两个值，实际 {c[0][1]}")


test("★ 检测同一次抽取里的自相矛盾", _contradictions)


def _no_false_contradiction() -> None:
    facts, _ = M.parse_extraction(
        "user.pm | pnpm | observed | 0.9 | 用 pnpm\nuser.pm | pnpm | observed | 0.8 | 又提了一次"
    )
    ok(not M.find_contradictions(facts), "同值不算矛盾")


test("同 key 同值不算矛盾", _no_false_contradiction)

# ─────────────────────────────────────────────────────────────
shutil.rmtree(TMP, ignore_errors=True)

print("\n" + "─" * 60)
if not _failures:
    print(f"\033[32m{_passed} 项全过。\033[0m")
    print("\n接着跑 uv run python -m l08.resume，把这两块接到 agent 上然后中途杀掉它。")
else:
    print(f"\033[31m{_passed} 过，{len(_failures)} 败：\033[0m")
    for name in _failures:
        print(f"\033[31m  · {name}\033[0m")
    sys.exit(1)
