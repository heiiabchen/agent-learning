"""L08 任务三：把持久化接到 agent 上，然后中途杀掉它（Python 版）。

    uv run python -m l08.resume

不调 API——用假模型，因为**崩溃恢复必须能确定性地复现**。
让真模型在你想要的那一步崩溃是做不到的。

这个脚本跑四个场景，每一个都是一种真实的恢复姿势：

    一 · 不做持久化，崩了从头再来        —— 看代价
    二 · 只存 transcript                —— 看它为什么不够
    三 · 事件日志 + 幂等键               —— 正确的做法
    四 · pending 里有一个 'once' 工具     —— 代码没有正确答案的那种情况
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from shared.fake import FakeModel, FakeTurn
from shared.ledger import Entry, Ledger, Usage
from shared.store import (
    FileStore,
    Replayability,
    Store,
    describe_plan,
    idem_key,
    plan_resume,
    session_path,
)

DIR = Path(__file__).parent / ".sessions"

# ─────────────────────────────────────────────────────────────
# 一个带副作用的假世界
#
# 副作用要**可观察**，否则你没法验证恢复到底做对了没有。
# 这里用一个列表数「邮件发了几封」。
# ─────────────────────────────────────────────────────────────


@dataclass
class World:
    files: dict[str, str] = field(
        default_factory=lambda: {
            "a.md": "客户 A 的对账数据",
            "b.md": "客户 B 的对账数据",
            "c.md": "客户 C 的对账数据",
        }
    )
    # 发出去的邮件。重复发会在这里留下两条——这就是我们要防的东西。
    emails_sent: list[str] = field(default_factory=list)
    commits: list[str] = field(default_factory=list)
    tool_calls: int = 0


REPLAYABILITY: dict[str, Replayability] = {
    "read_file": "pure",
    "write_file": "idempotent",
    "send_email": "once",
    "git_commit": "once",
}


def execute(w: World, tool: str, payload: dict[str, Any]) -> str:
    w.tool_calls += 1
    if tool == "read_file":
        return w.files.get(str(payload.get("path")), f"找不到 {payload.get('path')}")
    if tool == "write_file":
        w.files[str(payload.get("path"))] = str(payload.get("content"))
        return f"已写入 {payload.get('path')}"
    if tool == "send_email":
        w.emails_sent.append(str(payload.get("to")))
        return f"已发送给 {payload.get('to')}"
    if tool == "git_commit":
        w.commits.append(str(payload.get("message")))
        return f"已提交：{payload.get('message')}"
    return f"未知工具 {tool}"


# ─────────────────────────────────────────────────────────────
# 脚本：读三个文件，给三个客户各发一封邮件，最后提交
# ─────────────────────────────────────────────────────────────

SCRIPT: list[FakeTurn] = [
    FakeTurn(tool_uses=[{"name": "read_file", "input": {"path": "a.md"}}]),
    FakeTurn(tool_uses=[{"name": "send_email", "input": {"to": "a@x.com"}}]),
    FakeTurn(tool_uses=[{"name": "read_file", "input": {"path": "b.md"}}]),
    FakeTurn(tool_uses=[{"name": "send_email", "input": {"to": "b@x.com"}}]),
    FakeTurn(tool_uses=[{"name": "read_file", "input": {"path": "c.md"}}]),
    FakeTurn(tool_uses=[{"name": "send_email", "input": {"to": "c@x.com"}}]),
    FakeTurn(tool_uses=[{"name": "git_commit", "input": {"message": "对账完成"}}]),
    FakeTurn(text="三个客户的对账单都发出去了。"),
]

CrashWhen = Literal["after_intent", "after_outcome"]


@dataclass
class RunResult:
    world: World
    model_calls: int
    crashed: bool
    yuan: float


async def run(
    store: Store | None,
    world: World,
    crash_at: tuple[int, CrashWhen] | None,
    *,
    skip_completed: bool = False,
    start_step: int = 1,
) -> RunResult:
    """一个极简的、带持久化的 agent loop。

    只保留 L05 那个 loop 里和持久化相关的骨架，其余（预算、超时、重复检测）
    都省了——不是因为不重要，是因为这个脚本要盯的是另一件事。
    """
    sid = "resume-demo"
    ledger = Ledger("run")
    model = FakeModel(script=SCRIPT, after="final")
    messages: list[dict[str, Any]] = [{"role": "user", "content": "给三个客户发对账单"}]
    completed = store.state().completed if (skip_completed and store) else {}

    step = 0
    model_calls = 0

    # 恢复时要把假模型的脚本指针推到正确的位置。
    #
    # 这几次空转**不计入 model_calls，也不进账本**——它是假模型的实现细节，
    # 不是真实行为。真实的 loop 在这一步是从日志重建 transcript，
    # 一次模型调用都不用发。
    while step + 1 < start_step:
        step += 1
        await model.call(messages)

    while step < 12:
        step += 1
        res = await model.call(messages)
        model_calls += 1
        ledger.record(
            Entry(
                label=f"step {step}",
                id=res.id,
                model=res.model,
                usage=Usage.from_sdk(res.usage),
                ms=1,
            )
        )
        messages.append({"role": "assistant", "content": res.content})

        if res.stop_reason != "tool_use":
            if store:
                store.append({"t": "done", "reason": "done"})
            break

        uses = [b for b in res.content if b.type == "tool_use"]
        results: list[dict[str, Any]] = []

        for u in uses:
            payload = u.input or {}
            idem = idem_key(sid, u.name, payload)

            # ★ 幂等键的全部意义在这一行：已经做过的操作直接拿旧结果。
            done = completed.get(idem)
            if done:
                results.append(
                    {"type": "tool_result", "tool_use_id": u.id, "content": done["content"]}
                )
                continue

            # ★ 先写 intent，再执行。顺序反了的话崩溃恢复就无解了。
            if store:
                store.append(
                    {
                        "t": "intent",
                        "step": step,
                        "tool": u.name,
                        "input": payload,
                        "idem": idem,
                    }
                )

            if crash_at == (step, "after_intent"):
                return RunResult(world, model_calls, True, ledger.totals().yuan)

            content = execute(world, u.name, payload)
            if store:
                store.append(
                    {
                        "t": "outcome",
                        "step": step,
                        "idem": idem,
                        "ok": True,
                        "content": content,
                    }
                )

            if crash_at == (step, "after_outcome"):
                return RunResult(world, model_calls, True, ledger.totals().yuan)

            results.append({"type": "tool_result", "tool_use_id": u.id, "content": content})

        messages.append({"role": "user", "content": results})

    return RunResult(world, model_calls, False, ledger.totals().yuan)


# ─────────────────────────────────────────────────────────────


def fresh_store() -> Store:
    DIR.mkdir(parents=True, exist_ok=True)
    session_path(DIR, "resume-demo").unlink(missing_ok=True)
    return FileStore(session_path(DIR, "resume-demo"))


def _dupes(xs: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in xs:
        if x in seen:
            out.append(x)
        seen.add(x)
    return out


def report(label: str, r: RunResult, extra: str = "") -> None:
    emails = r.world.emails_sent
    dupes = _dupes(emails)
    dup_note = (
        f" \033[31m（重复 {len(dupes)} 封：{'、'.join(dupes)}）\033[0m" if dupes else ""
    )
    print(
        f"  {label:<20} 付费调用 {r.model_calls:>2} · "
        f"工具执行累计 {r.world.tool_calls:>2} · "
        f"邮件 {len(emails)} 封{dup_note} · ¥{r.yuan:.4f}"
    )
    if extra:
        print(f"    {extra}")


async def scenario_no_persistence() -> None:
    print("\n【一】不做持久化：崩了从头再来")

    w = World()
    crashed = await run(None, w, (4, "after_outcome"))
    report("崩溃前", crashed)

    # 从头再跑一遍，用的是同一个 world（副作用累积了）
    again = await run(None, w, None)
    report("从头重跑", again)

    dupes = _dupes(w.emails_sent)
    print(
        f"\n  ★ 本该 3 封邮件，实际发出 {len(w.emails_sent)} 封，"
        f"其中 {len(dupes)} 封是重复的。"
    )
    print(
        f"  而且崩溃前那 {crashed.model_calls} 次模型调用和 "
        f"{crashed.world.tool_calls} 次工具执行全部白付。"
    )
    print("  一个跑了 40 步的任务在第 38 步崩掉，这两笔代价都不可接受。")


async def scenario_transcript_only() -> None:
    print("\n【二】只存 transcript：为什么它不够")

    print("  假设你把 messages 数组存下来了，崩溃后读回来。你有：")
    print("    · 一串消息，包含 tool_use 块和 tool_result 块")
    print("  你没有：")
    print("    · 「哪些操作真的执行完了」——tool_result 存在说明执行完了，")
    print("      但**崩在 tool_use 和 tool_result 之间的那一次没有记录**")
    print("    · 「同一个操作会不会被重复执行」——没有幂等键，没法判断")
    print("    · 「现在该从哪一步继续」——得靠数消息条数，而这个数会随")
    print("      压缩（L06）而改变")
    print('\n  ★ 最要命的是第一条：transcript 里「没做」和「做了但没记上」')
    print("  长得**完全一样**。而恰恰是这两者的区别决定了要不要重做。")
    print("\n  这就是为什么要把 intent 和 outcome 拆成两条事件。")


async def scenario_event_log() -> None:
    print("\n【三】事件日志 + 幂等键：崩在 outcome 之后")

    store = fresh_store()
    w = World()
    store.append({"t": "task", "task": "给三个客户发对账单"})

    crashed = await run(store, w, (4, "after_outcome"))
    report("崩溃前", crashed)

    st = store.state()
    plan = plan_resume(st, lambda t: REPLAYABILITY.get(t, "once"))
    print(f"    恢复计划：{describe_plan(plan)}")

    resumed = await run(store, w, None, skip_completed=True, start_step=plan.resume_from)
    report("恢复后继续", resumed)

    print(f"\n  最终邮件：{'、'.join(w.emails_sent)}")
    print("  ★ 三封，不重不漏。")
    print("\n  两个机制各起了一半作用：")
    print("    resume_from 让 loop 不从第一步开始")
    print('    幂等键让"万一还是重放了"的那些操作直接拿旧结果')
    print("  **两者都要有。** 只有第一个的话，压缩改了消息数就会算错起点；")
    print("  只有第二个的话，你要重放全部历史，钱照付。")


async def scenario_pending_once() -> None:
    print("\n【四】崩在 intent 之后：代码没有正确答案的那种情况")

    store = fresh_store()
    w = World()
    store.append({"t": "task", "task": "给三个客户发对账单"})

    # 第 4 步是 send_email(b@x.com)，崩在 intent 之后、执行之前/之后不确定
    crashed = await run(store, w, (4, "after_intent"))
    report("崩溃前", crashed)

    st = store.state()
    print(f"\n    完成 {len(st.completed)} 个操作，pending {len(st.pending)} 个")
    for p in st.pending:
        print(f"    pending：{p.tool}({p.input}) 第 {p.step} 步")

    plan = plan_resume(st, lambda t: REPLAYABILITY.get(t, "once"))
    print(f"\n    恢复计划：{describe_plan(plan)}")

    print("\n  ★ 这封邮件发出去了吗？**日志无法回答。**")
    print(f"  实际上（因为这是模拟，我们能作弊看一眼）：已发 {len(w.emails_sent)} 封")
    print("  但线上你看不到这个数字——邮件服务商那边的状态你查不到，")
    print("  或者查得到但要等几分钟，或者要花钱查。")
    print('\n  两个"聪明"的默认都会出事：')
    print("    都重做 → 客户可能收到两封对账单")
    print('    都跳过 → 该发的可能没发，而日志显示这一步"处理过了"')
    print("\n  所以正确答案是 ask：**停下来，把这一条交给人。**")
    print("  这不是偷懒，是这个位置上唯一诚实的做法。")

    print("\n  而真正的工程解法是往上一层走，让这个问题不再出现：")
    print("    · 让副作用本身幂等——发邮件时带一个去重键，服务端保证同键只发一次")
    print('    · 或者把"发送"拆成"入队 + 消费"，入队幂等，消费由队列保证恰好一次')
    print("  ★ **恢复逻辑处理不了的问题，要在副作用的设计层面解决。**")


async def main() -> None:
    print("崩溃与恢复。不调 API——因为崩溃恢复必须能确定性地复现。")
    await scenario_no_persistence()
    await scenario_transcript_only()
    await scenario_event_log()
    await scenario_pending_once()

    print("\n" + "─" * 70)
    print("""
【这一节的账】

  没有持久化：崩在第 38 步 = 38 步全部重付，加上重复的副作用
  只存 transcript：能省钱，但**分不清"没做"和"做了没记上"**
  事件日志 + 幂等键：省钱，而且不重不漏
  pending 里的 once 工具：代码解决不了，要么问人，要么改副作用的设计

【TODO】

  1. 把【三】的崩溃点从 after_outcome 改成 after_intent，
     再跑一遍。read_file 是 pure，所以恢复计划会怎么变？
     为什么这次不需要问人？

  2. 把 REPLAYABILITY 里的 send_email 从 'once' 改成 'idempotent'，
     跑【四】。发生了什么？这对应线上什么样的事故？

  3. 想清楚：git_commit 为什么是 'once'？
     重复执行它最坏的后果是什么（提示：不是"多一个提交"）？
""")


if __name__ == "__main__":
    asyncio.run(main())
