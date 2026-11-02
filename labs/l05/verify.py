"""
验证 l05/loop.py。跑法：uv run python -m l05.verify

一次 API 都不调——全部用 shared/fake.py 里那个脚本化的假模型。

先跑 VERIFY_TARGET=shared 确认这套测试本身是对的。
"""

from __future__ import annotations

import asyncio
import json
import os

from shared.fake import FakeModel, FakeTurn
from shared.ledger import Ledger
from shared.tools import ParseOk, ToolBox, ToolDef, ToolResult

_TARGET = "shared" if os.environ.get("VERIFY_TARGET") == "shared" else "mine"

if _TARGET == "shared":
    from shared.agent import repeat_key, run_agent
else:
    from l05.loop import repeat_key, run_agent

print(
    "\n（测的是 shared/ 里的参考实现）" if _TARGET == "shared" else "\n（测的是 l05/ 里你的实现）"
)

passed = 0
failures: list[str] = []
calls: list[dict] = []


def test(name: str, fn) -> None:
    global passed
    try:
        r = fn()
        if asyncio.iscoroutine(r):
            asyncio.run(r)
        passed += 1
        print(f"\x1b[32m  ✓\x1b[0m {name}")
    except AssertionError as err:
        failures.append(name)
        print(f"\x1b[31m  ✕ {name}\x1b[0m")
        print(f"\x1b[31m      {err}\x1b[0m")
    except NotImplementedError as err:
        failures.append(name)
        print(f"\x1b[31m  ✕ {name}\x1b[0m")
        print(f"\x1b[31m      还没实现：{err}\x1b[0m")


def eq(a, b, hint: str = "") -> None:
    assert a == b, f"期待 {b}，实际 {a}" + (f"\n      {hint}" if hint else "")


def make_tools() -> ToolBox:
    calls.clear()

    async def echo_run(inp):
        calls.append({"name": "echo", "input": inp})
        return ToolResult(content=f"echo:{inp.get('v', '')}")

    async def boom_run(inp):
        calls.append({"name": "boom", "input": inp})
        return ToolResult(content="失败了。换个做法。", is_error=True)

    echo = ToolDef(
        name="echo",
        description="回显",
        input_schema={"type": "object", "properties": {"v": {"type": "string"}}},
        parse=lambda raw: ParseOk(input=raw if isinstance(raw, dict) else {}),
        run=echo_run,
    )
    boom = ToolDef(
        name="boom",
        description="总是失败",
        input_schema={"type": "object", "properties": {}},
        parse=lambda raw: ParseOk(input=raw),
        run=boom_run,
    )
    return ToolBox([echo, boom])


async def go(script, after="final", delay_ms=0, **opts):
    fake = FakeModel(script, after=after, delay_ms=delay_ms)
    run = await run_agent(
        "做点事",
        toolbox=make_tools(),
        system="test",
        call=fake.call,
        ledger=Ledger("test"),
        **opts,
    )
    return fake, run


# ── repeat_key ───────────────────────────────────────────────────────────

print("\nrepeat_key")

test(
    "同样的输入得到同样的 key", lambda: eq(repeat_key("r", {"p": "a"}), repeat_key("r", {"p": "a"}))
)

test(
    "不同工具名要区分",
    lambda: (
        (_ := None)
        or (repeat_key("r", {"p": 1}) != repeat_key("l", {"p": 1}))
        or _fail("工具名要进 key")
    ),
)


def _fail(msg):
    raise AssertionError(msg)


test(
    "★★ 字段顺序不同必须得到同一个 key",
    lambda: eq(
        repeat_key("t", {"a": 1, "b": 2}),
        repeat_key("t", {"b": 2, "a": 1}),
        "直接 json.dumps 会因为字段顺序不同产生不同的 key，于是重复检测静默失效。\n"
        "      这是那种「写完觉得搞定了、三个月后发现一直没生效」的 bug。",
    ),
)

test(
    "嵌套 dict 的字段顺序也要归一",
    lambda: eq(repeat_key("t", {"o": {"x": 1, "y": 2}}), repeat_key("t", {"o": {"y": 2, "x": 1}})),
)

test(
    "list 顺序**要**区分（它是有意义的顺序）",
    lambda: (
        (repeat_key("t", {"a": [1, 2]}) != repeat_key("t", {"a": [2, 1]}))
        or _fail("list 顺序有语义，不能排序")
    ),
)

test("None 值要忽略", lambda: eq(repeat_key("t", {"a": 1, "b": None}), repeat_key("t", {"a": 1})))

# ── 正常流程 ─────────────────────────────────────────────────────────────

print("\n正常流程")


async def t_one_step():
    _, r = await go([FakeTurn(text="答案是 42")])
    eq(r.reason, "done")
    eq(r.steps, 1)
    eq(r.text, "答案是 42")


test("不需要工具时一步完成", t_one_step)


async def t_tool_then_answer():
    _, r = await go(
        [FakeTurn(tool_uses=[{"name": "echo", "input": {"v": "hi"}}]), FakeTurn(text="好了")]
    )
    eq(r.reason, "done")
    eq(r.steps, 2)
    eq(len(calls), 1, "工具应该被调用一次")


test("一次工具调用后给答案", t_tool_then_answer)


async def t_assistant_kept():
    fake, _ = await go(
        [FakeTurn(tool_uses=[{"name": "echo", "input": {"v": "x"}}]), FakeTurn(text="ok")]
    )
    second = fake.calls[1]
    am = next((m for m in second if m["role"] == "assistant"), None)
    assert am is not None, "历史里必须有 assistant 消息"
    blocks = am["content"]
    types = [b.type if hasattr(b, "type") else b.get("type") for b in blocks]
    assert "tool_use" in types, (
        "历史里的 assistant 消息丢了 tool_use 块。\n"
        "      后果：模型下一轮看不到自己要求过什么，于是重新要求一次 → 死循环。\n"
        "      而且每一轮都在花钱。这是最常见的一种 agent 死循环。"
    )


test("★ assistant 消息要原样放回历史（含 tool_use 块）", t_assistant_kept)


async def t_one_user_msg():
    fake, _ = await go(
        [
            FakeTurn(
                tool_uses=[
                    {"name": "echo", "input": {"v": "a"}},
                    {"name": "echo", "input": {"v": "b"}},
                ]
            ),
            FakeTurn(text="ok"),
        ]
    )
    users = [m for m in fake.calls[1] if m["role"] == "user"]
    eq(
        len(users),
        2,
        "应该是「原始任务」+「一条带两个 tool_result 的消息」共 2 条 user。\n"
        "      拆成多条会造成连续两条 user，违反 L02 那条交替约束。",
    )
    eq(len(users[1]["content"]), 2, "两个结果要在同一条消息的 content 里")


test("★ 工具结果放在同一条 user 消息里", t_one_user_msg)


async def t_order():
    fake, _ = await go(
        [
            FakeTurn(
                tool_uses=[
                    {"name": "echo", "input": {"v": "first"}},
                    {"name": "echo", "input": {"v": "second"}},
                ]
            ),
            FakeTurn(text="ok"),
        ]
    )
    users = [m for m in fake.calls[1] if m["role"] == "user"]
    got = [c["content"] for c in users[1]["content"]]
    eq(
        got,
        ["echo:first", "echo:second"],
        "顺序抖动 → 前缀缓存失效 + 问题无法复现。\n"
        "      用 asyncio.gather（按传入顺序返回），不要「谁完成谁 append」。",
    )


test("★ 并行结果按 tool_use 原顺序回填", t_order)


async def t_tool_error_continues():
    _, r = await go(
        [FakeTurn(tool_uses=[{"name": "boom", "input": {}}]), FakeTurn(text="换了个做法")]
    )
    eq(r.reason, "done", "工具失败是正常流程的一部分，不该让 agent 崩掉")


test("工具报错不中断循环", t_tool_error_continues)


async def t_trace():
    _, r = await go(
        [FakeTurn(tool_uses=[{"name": "echo", "input": {"v": "x"}}]), FakeTurn(text="ok")]
    )
    eq(len(r.trace), 1)
    eq(r.trace[0].tool_name, "echo")
    eq(r.trace[0].ok, True)
    assert r.trace[0].preview, "preview 要有内容，它是给人扫日志用的"


test("trace 记录了每次工具调用", t_trace)

# ── 终止条件 ─────────────────────────────────────────────────────────────

print("\n终止条件")


async def t_step_limit():
    _, r = await go(
        [FakeTurn(tool_uses=[{"name": "echo", "input": {"v": "loop"}}])],
        after="repeat_last",
        max_steps=5,
        repeat_limit=999,
    )
    eq(r.reason, "step_limit", "无限循环时必须撞上步数上限并停下")
    assert r.steps <= 5, f"步数不该超过上限，实际 {r.steps}"


test("★★ 步数上限：死循环必须被兜住", t_step_limit)


async def t_not_done():
    _, r = await go(
        [FakeTurn(tool_uses=[{"name": "echo", "input": {"v": "x"}}], text="这句话看起来像答案")],
        after="repeat_last",
        max_steps=2,
        repeat_limit=999,
    )
    assert r.reason != "done", (
        "这是本节最重要的一条。撞上限时模型最后那句话**看起来像个答案**，\n"
        "      reason 报 done 的话调用方会拿去用，用户会拿去信。\n"
        "      而这个 bug 的表现是「agent 偶尔给出不完整的答案」，你会去查 prompt。"
    )


test("★★ 撞上限时 reason 不能是 done", t_not_done)


async def t_budget():
    _, r = await go(
        [FakeTurn(tool_uses=[{"name": "echo", "input": {"v": "x"}}], usage=(3_000_000, 800_000))],
        after="repeat_last",
        max_steps=100,
        max_yuan=0.3,
        repeat_limit=999,
    )
    eq(r.reason, "budget", "累计成本超预算要停下")


test("★ 预算上限", t_budget)


async def t_timeout():
    _, r = await go(
        [FakeTurn(tool_uses=[{"name": "echo", "input": {"v": "x"}}])],
        after="repeat_last",
        delay_ms=20,
        max_ms=1,
        max_steps=100,
        repeat_limit=999,
    )
    eq(r.reason, "timeout")


test("★ 挂钟超时", t_timeout)


async def t_cancelled():
    """
    ★ 这条测的是 Python 特有的那个坑。

    call() 在 asyncio.sleep 处被取消，抛 CancelledError。
    如果你写的是 `except Exception`，**抓不到它**（它继承 BaseException），
    异常会一路穿出去，run_agent 直接炸而不是返回 cancelled。
    """
    fake = FakeModel(
        [FakeTurn(tool_uses=[{"name": "echo", "input": {"v": "x"}}])],
        after="repeat_last",
        delay_ms=50,
    )
    ledger = Ledger("test")
    hits = {"n": 0}

    def cancelled() -> bool:
        hits["n"] += 1
        return hits["n"] > 2

    r = await run_agent(
        "做点事",
        toolbox=make_tools(),
        system="test",
        call=fake.call,
        ledger=ledger,
        max_steps=100,
        repeat_limit=999,
        is_cancelled=cancelled,
    )
    eq(r.reason, "cancelled")
    assert r.usage.calls > 0, "取消不该让账目消失。已经发出去的请求真的花了钱，usage 里必须体现。"


test("★★ 取消：报 cancelled，且账目不丢", t_cancelled)


async def t_cancel_in_await():
    """call 里被真正 cancel 掉（不是 is_cancelled 轮询）也要报 cancelled。"""
    fake = FakeModel(
        [FakeTurn(tool_uses=[{"name": "echo", "input": {"v": "x"}}])],
        after="repeat_last",
        delay_ms=500,
    )

    task = asyncio.create_task(
        run_agent(
            "做点事",
            toolbox=make_tools(),
            system="test",
            call=fake.call,
            ledger=Ledger("test"),
            max_steps=100,
            repeat_limit=999,
        )
    )
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        r = await task
    except asyncio.CancelledError:
        raise AssertionError(
            "CancelledError 穿了出来，run_agent 没有把它转成 reason='cancelled'。\n"
            "      ★ 注意 `except Exception` 抓不到它——CancelledError 继承 BaseException。\n"
            "      要单独写一个 `except asyncio.CancelledError`。\n"
            "      不这么做的后果：拿不到部分结果，也拿不到已花的钱。"
        ) from None
    eq(r.reason, "cancelled")


test("★★ await 中被 cancel 也要报 cancelled（不是让异常穿出去）", t_cancel_in_await)


async def t_max_tokens():
    _, r = await go([FakeTurn(text="答案是一半…", stop_reason="max_tokens")])
    assert r.reason != "done", (
        "被 max_tokens 截断的输出是残缺的。报 done 等于把半截答案当成完整答案交出去。\n"
        "      这和 L02「半截内容绝不能静默返回」是同一条纪律。"
    )


test("★ max_tokens 截断不能当成 done", t_max_tokens)


async def t_no_blocks():
    _, r = await go(
        [FakeTurn(text="奇怪", stop_reason="tool_use")], after="repeat_last", max_steps=10
    )
    assert r.reason in ("error", "step_limit"), (
        f"协议上不该发生，但真发生了必须能停。实际 reason={r.reason}"
    )


test("★ stop_reason 说 tool_use 但没有块，要能停下", t_no_blocks)


async def t_call_throws():
    _, r = await go([], after="throw")
    eq(r.reason, "error")
    assert r.error is not None, "error 字段要带上原始异常，否则没法排查"


test("模型调用抛错要报 error 并带上异常", t_call_throws)

# ── 重复检测 ─────────────────────────────────────────────────────────────

print("\n重复检测")


async def t_repeat_blocked():
    _, r = await go(
        [FakeTurn(tool_uses=[{"name": "echo", "input": {"v": "same"}}])],
        after="repeat_last",
        max_steps=20,
        repeat_limit=2,
    )
    assert len(calls) <= 3, f"拦下之后不该再真的执行工具，实际执行了 {len(calls)} 次"
    assert r.reason in ("repeat", "step_limit"), (
        f"应该以 repeat（更好）或 step_limit 结束，实际 {r.reason}"
    )
    assert r.steps < 10, (
        f"重复检测应该在几步内发现，而不是烧满 20 步。实际 {r.steps} 步。\n"
        "      这就是它的价值：省钱省时间，而且 reason 更精确。"
    )


test("★★ 同参数超限要拦下，且比步数上限更早", t_repeat_blocked)


async def t_different_params():
    _, r = await go(
        [FakeTurn(tool_uses=[{"name": "echo", "input": {"v": c}}]) for c in ("a", "b", "c")]
        + [FakeTurn(text="ok")],
        repeat_limit=2,
    )
    eq(r.reason, "done", "参数不同就不是打转，不该被拦")
    eq(len(calls), 3)


test("参数不同的调用不算重复", t_different_params)


async def t_one_retry_ok():
    _, r = await go(
        [
            FakeTurn(tool_uses=[{"name": "echo", "input": {"v": "x"}}]),
            FakeTurn(tool_uses=[{"name": "echo", "input": {"v": "x"}}]),
            FakeTurn(text="ok"),
        ],
        repeat_limit=2,
    )
    eq(r.reason, "done", "第二次同样的调用可能是重试瞬时错误，不该拦。第三次才拦。")
    eq(len(calls), 2)


test("重复一次是允许的（重试是合理行为）", t_one_retry_ok)


async def t_way_out():
    _, r = await go(
        [FakeTurn(tool_uses=[{"name": "echo", "input": {"v": "x"}}])],
        after="repeat_last",
        max_steps=20,
        repeat_limit=2,
    )
    dumped = json.dumps(r.transcript, ensure_ascii=False, default=str)
    assert any(k in dumped for k in ("换个思路", "卡在", "需要什么")), (
        "拦下之后回给模型的那条消息里没有下一步建议。\n"
        "      只说「你重复了」它还是不知道该干什么。L04 那条：约束要配一条出路。"
    )


test("★ 拦下时给模型的消息里要有出路", t_way_out)

# ── 收尾 ─────────────────────────────────────────────────────────────────

total = passed + len(failures)
print(f"\n{'─' * 52}")
if not failures:
    print(
        f"\x1b[32m全绿 {passed}/{total}。\x1b[0m 你有一个 agent 了。去看 shared/agent.py 对照取舍。"
    )
else:
    print(f"\x1b[31m{len(failures)}/{total} 没过：\x1b[0m")
    for f in failures:
        print(f"  · {f}")
    print("\n带 ★★ 的几条对应真实的失控方式，别跳过。")
    raise SystemExit(1)
