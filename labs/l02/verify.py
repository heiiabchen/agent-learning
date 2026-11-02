"""
验证 l02/ledger.py 和 l02/reader.py。跑法：uv run python -m l02.verify

一次 API 都不调。流式事件全是手工造的假数据——这本身就是本节的一个隐含教学点：
**流式协议就是一串普通的 JSON 事件**，你完全可以离线造出任何一种诡异情况。
真实网络给不了你的故障，你自己造。
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from math import isclose, isnan
from types import SimpleNamespace
from typing import Any

from shared.ledger import Usage

# 默认测你写的版本（l02/）。想先确认这套测试本身是对的：
#   VERIFY_TARGET=shared uv run python -m l02.verify
# 它会去测 shared/ 里我那版，应该全绿。后面出红你就知道一定是你的代码。
# **先证明尺子是准的，再用它量东西。**
_TARGET = "shared" if os.environ.get("VERIFY_TARGET") == "shared" else "mine"

if _TARGET == "shared":
    from shared.ledger import Entry, Ledger
    from shared.stream import StreamAbortedError, read_stream
else:
    from l02.ledger import Entry, Ledger
    from l02.reader import StreamAbortedError, read_stream

print(
    "\n（测的是 shared/ 里的参考实现）" if _TARGET == "shared" else "\n（测的是 l02/ 里你的实现）"
)

passed = 0
failures: list[str] = []


def test(name: str, fn) -> None:
    global passed
    try:
        fn()
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


def ns(**kw: Any) -> SimpleNamespace:
    return SimpleNamespace(**kw)


# ── 造假事件 ──────────────────────────────────────────────────────────────


def ev_start(inp: int = 100, msg_id: str = "msg_test", model: str = "deepseek-v4-flash"):
    return ns(
        type="message_start",
        message=ns(id=msg_id, model=model, usage=ns(input_tokens=inp, output_tokens=0)),
    )


def ev_block_start(index: int, block_type: str, name: str | None = None, bid: str | None = None):
    return ns(
        type="content_block_start",
        index=index,
        content_block=ns(type=block_type, name=name, id=bid),
    )


def ev_text(index: int, text: str):
    return ns(type="content_block_delta", index=index, delta=ns(type="text_delta", text=text))


def ev_think(index: int, thinking: str):
    return ns(
        type="content_block_delta", index=index, delta=ns(type="thinking_delta", thinking=thinking)
    )


def ev_json(index: int, partial_json: str):
    return ns(
        type="content_block_delta",
        index=index,
        delta=ns(type="input_json_delta", partial_json=partial_json),
    )


def ev_block_stop(index: int):
    return ns(type="content_block_stop", index=index)


def ev_ping():
    return ns(type="ping")


def ev_msg_delta(stop_reason: str, output: int = 42):
    return ns(
        type="message_delta", delta=ns(stop_reason=stop_reason), usage=ns(output_tokens=output)
    )


def ev_stop():
    return ns(type="message_stop")


def ev_error(message: str):
    return ns(type="error", error=ns(type="overloaded_error", message=message))


def feed(*events: Any) -> Iterator[Any]:
    yield from events


def happy_path() -> Iterator[Any]:
    """一条完整正常的流：思考块 + 正文块。"""
    return feed(
        ev_start(120),
        ev_block_start(0, "thinking"),
        ev_think(0, "让我想想"),
        ev_think(0, "，应该是这样"),
        ev_block_stop(0),
        ev_ping(),
        ev_block_start(1, "text"),
        ev_text(1, "答案"),
        ev_text(1, "是 42"),
        ev_block_stop(1),
        ev_msg_delta("end_turn", 88),
        ev_stop(),
    )


def entry(label: str, inp: int, out: int, hit: int = 0, write: int = 0) -> Entry:
    return Entry(
        label=label,
        id=f"msg_{label}",
        model="deepseek-v4-flash",
        usage=Usage(inp, out, hit, write),
        ms=1000,
    )


# ── Ledger ───────────────────────────────────────────────────────────────

print("\nLedger")


def t_record():
    ledger = Ledger()
    ledger.record(entry("a", 100, 50))
    ledger.record(entry("b", 200, 60))
    assert len(ledger.entries) == 2, f"期待 2 条，实际 {len(ledger.entries)}"


test("record 之后能读回来", t_record)


def t_cost_plain():
    ledger = Ledger()
    # 1000 输入 × 1/百万 + 500 输出 × 2/百万 = 0.002
    cost = ledger.cost_of(entry("x", 1000, 500))
    assert isclose(cost, 0.002, abs_tol=1e-9), f"期待 0.002，实际 {cost}"


test("cost_of：没有缓存时按 miss 单价算", t_cost_plain)


def t_cost_cached():
    ledger = Ledger()
    # 输入 1000，其中 800 命中 → 未命中 200
    # 200×1/1e6 + 800×0.02/1e6 = 0.000216
    cost = ledger.cost_of(entry("x", 1000, 0, 800))
    assert isclose(cost, 0.000216, abs_tol=1e-9), (
        f"期待 0.000216，实际 {cost}。\n"
        "      input_tokens 是**总输入**，命中的那部分已经便宜了。\n"
        "      未命中量 = input_tokens − cache_read = 200，不是 1000。\n"
        "      直接拿 1000 乘 miss 单价，等于把省下的钱又算回来了。"
    )


test("★ cost_of：命中的部分要按便宜单价算，不能重复计费", t_cost_cached)


def t_cost_write():
    ledger = Ledger()
    cost = ledger.cost_of(entry("x", 1000, 0, 0, 1000))
    assert cost > 0.001, f"写入缓存不该是免费的，实际算出 {cost}"


test("cost_of：写入缓存的部分按 miss 单价算", t_cost_write)


def t_totals_missing_cache():
    ledger = Ledger()
    # 兼容端点可能压根不返回缓存字段，Usage 的默认值要能兜住
    ledger.record(
        Entry(
            label="bare",
            id="msg_bare",
            model="deepseek-v4-flash",
            usage=Usage(100, 20),
            ms=500,
        )
    )
    t = ledger.totals()
    assert t.cache_read == 0 and t.cache_write == 0, "缺失字段应该当 0 处理"
    assert not isnan(t.yuan), "yuan 变成 NaN 了——说明有 None 参与了算术"


test("totals：能处理缺失的 cache 字段", t_totals_missing_cache)


def t_totals_sum():
    ledger = Ledger()
    ledger.record(entry("a", 100, 50))
    ledger.record(entry("b", 300, 70))
    t = ledger.totals()
    assert t.calls == 2, f"calls 期待 2，实际 {t.calls}"
    assert t.input_tokens == 400, f"input_tokens 期待 400，实际 {t.input_tokens}"
    assert t.output_tokens == 120, f"output_tokens 期待 120，实际 {t.output_tokens}"


test("totals：多条累加正确", t_totals_sum)


def t_hitrate_none():
    ledger = Ledger()
    ledger.record(
        Entry(label="bare", id="m", model="deepseek-v4-flash", usage=Usage(100, 20), ms=1)
    )
    got = ledger.cache_hit_rate()
    assert got is None, (
        f"期待 None，实际 {got}。\n"
        "      「端点没返回缓存字段」和「命中率是 0%」是两个完全不同的结论。\n"
        "      前者你该去查为什么没数据，后者你该去查为什么没命中。"
    )


test("★ cache_hit_rate：没有缓存数据时返回 None 而不是 0", t_hitrate_none)


def t_hitrate_value():
    ledger = Ledger()
    ledger.record(entry("a", 1000, 0, 750))
    got = ledger.cache_hit_rate()
    assert got is not None and isclose(got, 0.75), f"期待 0.75，实际 {got}"


test("cache_hit_rate：有数据时算得对", t_hitrate_value)


def t_report():
    ledger = Ledger("测试账本")
    ledger.record(entry("a", 100, 50))
    out = ledger.report()
    assert "测试账本" in out, "报告里应该有账本名字"
    assert "合计" in out, "报告里应该有一行合计"


test("report 不炸，且包含合计行", t_report)


# ── read_stream ──────────────────────────────────────────────────────────

print("\nread_stream")


def t_text():
    r = read_stream(happy_path())
    assert r.text == "答案是 42", f"期待「答案是 42」，实际 {r.text!r}"


test("正常流：能拿到正文", t_text)


def t_buckets():
    r = read_stream(happy_path())
    assert "让我想想" not in r.text, (
        f"正文里混进了思考内容：{r.text!r}。\n"
        "      所有 delta 都累加到同一个字符串就会这样。要用 dict[index, block] 分桶。"
    )
    assert r.thinking == "让我想想，应该是这样", f"thinking 没收对：{r.thinking!r}"


test("★ 按 index 分桶：思考内容不能混进正文", t_buckets)


def t_delta_fields():
    r = read_stream(happy_path())
    assert "None" not in r.thinking and "None" not in r.text, (
        '输出里出现了字面量 "None"，说明你对所有 delta 都取了 .text。\n'
        "      text_delta → .text，thinking_delta → .thinking，input_json_delta → .partial_json"
    )


test("★ delta 类型：thinking_delta 取 .thinking 而不是 .text", t_delta_fields)


def t_usage():
    r = read_stream(happy_path())
    assert r.usage.input_tokens == 120, f"input_tokens 期待 120，实际 {r.usage.input_tokens}"
    assert r.usage.output_tokens == 88, (
        f"output_tokens 期待 88，实际 {r.usage.output_tokens}。\n"
        "      message_start 里的 output_tokens 恒为 0（那时还没生成）。\n"
        "      真正的值在 message_delta，同一个事件还带 stop_reason。"
    )


test("★ usage：output_tokens 必须从 message_delta 取", t_usage)


def t_stop_reason():
    r = read_stream(happy_path())
    assert r.stop_reason == "end_turn", f"期待 end_turn，实际 {r.stop_reason}"


test("stop_reason 收到了", t_stop_reason)


def t_id_model():
    r = read_stream(happy_path())
    assert r.id == "msg_test" and r.model == "deepseek-v4-flash", "id / model 没记全"


test("id 和 model 记下来了", t_id_model)


def t_ping():
    r = read_stream(feed(ev_start(), ev_ping(), ev_ping(), ev_msg_delta("end_turn", 0), ev_stop()))
    assert r.text == "", f"ping 不该产生任何文本，实际 {r.text!r}"


test("ping 事件被安静忽略", t_ping)


def t_callback():
    chunks: list[str] = []
    read_stream(happy_path(), chunks.append)
    assert "".join(chunks) == "答案是 42", (
        f"回调收到的内容不对：{''.join(chunks)!r}。思考块不该触发 on_text。"
    )


test("on_text 回调只收正文，不收思考", t_callback)


def t_no_stop():
    # 模拟连接被中间代理掐掉：流正常结束，没有 message_stop，也没有 error 事件
    threw = False
    try:
        read_stream(
            feed(ev_start(), ev_block_start(0, "text"), ev_text(0, "半截话"), ev_block_stop(0))
        )
    except StreamAbortedError:
        threw = True
    assert threw, (
        "流没收到 message_stop 就结束了，这时内容是不完整的，必须抛错。\n"
        "      这一条最难想到：for 循环会安静地正常退出，一个错误都不抛。\n"
        "      判据只能是显式的 saw_stop 标记。"
    )


test("★★ 没收到 message_stop 就结束 → 必须抛错", t_no_stop)


def t_stream_error():
    err: BaseException | None = None
    try:
        read_stream(
            feed(
                ev_start(),
                ev_block_start(0, "text"),
                ev_text(0, "已经渲染出去的"),
                ev_error("overloaded"),
            )
        )
    except BaseException as e:  # noqa: BLE001
        err = e
    assert err is not None, "error 事件必须抛错——HTTP 是 200 不代表这次调用成功了"
    assert getattr(err, "partial", None), (
        "抛错时要把已累积的内容放进 partial。调用方需要它来决定怎么收拾——\n"
        "      通常是丢弃并重发，但那是调用方的决定，不是你的。"
    )


test("★ 流内 error 事件 → 抛错，且带上已累积的部分", t_stream_error)


def t_tool_json():
    r = read_stream(
        feed(
            ev_start(),
            ev_block_start(0, "tool_use", name="read_file", bid="tu_1"),
            ev_json(0, '{"path"'),
            ev_json(0, ':"a.ts"}'),
            ev_block_stop(0),
            ev_msg_delta("tool_use", 30),
            ev_stop(),
        )
    )
    tools = [b for b in r.blocks if b.type == "tool_use"]
    assert tools, "blocks 里应该有 tool_use 块"
    assert tools[0].text == '{"path":"a.ts"}', (
        f"JSON 参数没拼完整：{tools[0].text!r}。\n      L04 之后这里一错就是 json.loads 直接炸。"
    )
    assert tools[0].tool_name == "read_file", f"工具名没记下来：{tools[0].tool_name}"


test("工具调用块：JSON 参数按 index 拼完整", t_tool_json)


def t_parallel_tools():
    r = read_stream(
        feed(
            ev_start(),
            ev_block_start(0, "tool_use", name="read_file", bid="tu_1"),
            ev_block_start(1, "tool_use", name="list_dir", bid="tu_2"),
            # 故意交错，真实的并行工具调用就是这样
            ev_json(0, '{"path":'),
            ev_json(1, '{"dir":'),
            ev_json(0, '"a.ts"}'),
            ev_json(1, '"src"}'),
            ev_block_stop(0),
            ev_block_stop(1),
            ev_msg_delta("tool_use", 40),
            ev_stop(),
        )
    )
    tools = [b for b in r.blocks if b.type == "tool_use"]
    assert len(tools) == 2, f"期待 2 个工具调用，实际 {len(tools)}"
    assert tools[0].text == '{"path":"a.ts"}' and tools[1].text == '{"dir":"src"}', (
        f"两个工具的参数串了：{[t.text for t in tools]}\n"
        "      服务端会交错发送不同 index 的 delta，这就是必须分桶的实战理由。"
    )


test("两个并行工具调用不能串到一起", t_parallel_tools)


# ── 收尾 ─────────────────────────────────────────────────────────────────

total = passed + len(failures)
print(f"\n{'─' * 52}")
if not failures:
    print(f"\x1b[32m全绿 {passed}/{total}。\x1b[0m 现在可以去看 shared/ 里我那两版，对照一下取舍。")
else:
    print(f"\x1b[31m{len(failures)}/{total} 没过：\x1b[0m")
    for f in failures:
        print(f"  · {f}")
    print("\n带 ★ 的几条是真实项目里咬过人的地方，别跳过。")
    raise SystemExit(1)
