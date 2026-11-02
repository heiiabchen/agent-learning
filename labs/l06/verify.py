"""验证 l06/budget.py 和 l06/compress.py。

    uv run python -m l06.verify

一次 API 都不调——压缩用的模型也是假的。

这套测试里有一整组专门盯着**静默偏小**：漏算 tool_use、漏算工具定义、
按总窗口而不是可用额度算比例、json.dumps 的 ensure_ascii 把中文炸成六倍。
它们都不抛异常，只是让你在以为还有余量的时候撞上限。
把静默失败变成响亮失败，是这门课反复出现的同一条纪律。

先跑 VERIFY_TARGET=shared 确认测试本身是对的：
    VERIFY_TARGET=shared uv run python -m l06.verify
"""

from __future__ import annotations

import asyncio
import dataclasses
import os
import re
from collections.abc import Callable
from typing import Any

_target = "shared" if os.environ.get("VERIFY_TARGET") == "shared" else "mine"

if _target == "shared":
    from shared import compress as C
    from shared import context_budget as B
else:
    from l06 import budget as B  # type: ignore[no-redef]
    from l06 import compress as C  # type: ignore[no-redef]

print(
    "\n（测的是 shared/ 里的参考实现）" if _target == "shared" else "\n（测的是 l06/ 里你的实现）"
)

_passed = 0
_failures: list[str] = []


def test(name: str, fn: Callable[[], Any]) -> None:
    global _passed
    try:
        result = fn()
        if asyncio.iscoroutine(result):
            asyncio.run(result)
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
        result = fn()
        if asyncio.iscoroutine(result):
            asyncio.run(result)
    except NotImplementedError:
        raise
    except Exception:
        return
    raise AssertionError(f"应该抛异常但没有：{hint}")


TOOLS: list[dict[str, Any]] = [
    {
        "name": "read_file",
        "description": "读取文件内容。路径必须在项目根目录内。返回前 200 行。",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "offset": {"type": "integer"}},
            "required": ["path"],
        },
    },
    {
        "name": "search_code",
        "description": "搜关键词，返回文件和行号。",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
]

# ─────────────────────────────────────────────────────────────
print("\ntoken 估算")
# ─────────────────────────────────────────────────────────────

test("空字符串是 0", lambda: ok(B.estimate_tokens("") == 0, f"实际 {B.estimate_tokens('')}"))


def _zh_costs_more() -> None:
    zh = B.estimate_tokens("上下文工程是最稀缺的资源")
    en = B.estimate_tokens("contextengineering")
    ok(zh > en, f"中文 {zh} 应该大于同长度英文 {en}（L01 讲过 BPE 的语料依赖）")


test("中文比同字数英文更耗 token", _zh_costs_more)


def _monotonic() -> None:
    prev = 0
    for n in (10, 100, 1000):
        cur = B.estimate_tokens("a" * n)
        ok(cur >= prev, f"长度 {n} 时估算 {cur} 反而小于 {prev}")
        prev = cur


test("长度单调：文本变长估算不减", _monotonic)


def _factor_works() -> None:
    text = "测试一段文本 with mixed content"
    ok(
        B.estimate_tokens(text, 1.2) > B.estimate_tokens(text),
        f"factor=1.2 应该给出更大的值，实际 {B.estimate_tokens(text)} → "
        f"{B.estimate_tokens(text, 1.2)}",
    )


test("factor 系数生效", _factor_works)

# ─────────────────────────────────────────────────────────────
print("\n消息计量")
# ─────────────────────────────────────────────────────────────

test("字符串 content", lambda: ok(B.count_content("hello world") > 0, "不该是 0"))

test(
    "text 块",
    lambda: ok(B.count_content([{"type": "text", "text": "一段文字"}]) > 0, "不该是 0"),
)


def _tool_use_counted() -> None:
    n = B.count_content(
        [
            {
                "type": "tool_use",
                "id": "t1",
                "name": "read_file",
                "input": {"path": "src/very/long/path/to/a/file.py", "offset": 200},
            }
        ]
    )
    ok(
        n > 10,
        f"期待明显大于 0，实际 {n}。\n"
        "      `if isinstance(content, str)` 之后就不管别的，是这一节最常见的 bug——"
        "而 tool_use / tool_result 正是 agent 上下文里最大的两块",
    )


test("tool_use 块要算进去（漏了它统计基本上就废了）", _tool_use_counted)


def _ensure_ascii_trap() -> None:
    """★ Python 专属：json.dumps 默认 ensure_ascii=True 会把中文变成 \\uXXXX。

    一个汉字从 1 个字符变成 6 个，估算直接翻六倍。TS 那边没这个问题。
    """
    zh = B.count_content(
        [{"type": "tool_use", "id": "t1", "name": "f", "input": {"note": "中文注释内容"}}]
    )
    plain = B.count_content([{"type": "text", "text": '{"note": "中文注释内容"}'}])
    ok(
        zh < plain * 3,
        f"tool_use 里六个汉字算出 {zh} tok，纯文本同样内容只有 {plain} tok。\n"
        "      json.dumps 忘了传 ensure_ascii=False，中文被转义成 \\uXXXX 了",
    )


test("tool_use 里的中文不被 ensure_ascii 炸成六倍", _ensure_ascii_trap)


def _tool_result_counted() -> None:
    small = B.count_content([{"type": "tool_result", "tool_use_id": "t1", "content": "x"}])
    big = B.count_content([{"type": "tool_result", "tool_use_id": "t1", "content": "x" * 4000}])
    ok(big > small * 10, f"4000 字符 {big} 应该远大于 1 字符 {small}")


test("tool_result 块要算进去", _tool_result_counted)


def _nested_result_counted() -> None:
    n = B.count_content(
        [
            {
                "type": "tool_result",
                "tool_use_id": "t1",
                "content": [{"type": "text", "text": "y" * 2000}],
            }
        ]
    )
    ok(n > 100, f"期待明显大于 0，实际 {n}。工具结果也可以是块 list")


test("tool_result 的 content 是块 list 时也要算", _nested_result_counted)

test(
    "未知块类型要抛异常，不能静默跳过",
    lambda: raises(
        lambda: B.count_content([{"type": "wat"}]),
        "静默跳过未知块会让预算数字系统性偏小",
    ),
)


@dataclasses.dataclass
class _SdkBlock:
    """模拟 SDK 返回的块对象。它没有 .get()。"""

    type: str
    text: str = ""
    id: str = ""
    name: str = ""
    input: Any = None


def _sdk_objects_counted() -> None:
    """★ Python 专属，而且这是本节最容易踩的一个。

    transcript 里 assistant 那条装的是 **SDK 返回的模型对象**
    （L05 的 run_agent 把 res.content 原样放回去了），user 那条是你手写的 dict。
    同一个 list 里两种形态混着。

    只写 `block.get("type")` 的话，测试全绿、单跑 budget.py 也全绿，
    然后一接到真 agent 上就 AttributeError——因为你的测试数据全是 dict。
    """
    n = B.count_content([_SdkBlock(type="text", text="一段文字" * 20)])
    ok(
        n > 0,
        f"实际 {n}。SDK 对象没有 .get()，只写 block.get('type') 会在这里 AttributeError。\n"
        "      而你的测试数据如果全是手写 dict，这个 bug 要到接上真 agent 才暴露",
    )

    m = B.count_content(
        [_SdkBlock(type="tool_use", id="t1", name="read_file", input={"path": "a.py"})]
    )
    ok(m > 0, f"tool_use 对象没算进去：{m}")


test("SDK 对象形态的块也要算（transcript 里就是这个形态）", _sdk_objects_counted)


def _unserializable_input_survives() -> None:
    """★ 同一个坑的第二个面：json.dumps 遇到非 JSON 类型会抛。

    工具入参里出现一个 SDK 对象或者 datetime 就会炸，
    而计量函数抛异常等于整个 agent 挂掉——为了数个 token 而中断任务，
    这个交换比很糟。计数用的序列化应该兜住失败。
    """
    n = B.count_content(
        [{"type": "tool_use", "id": "t1", "name": "f", "input": {"blob": _SdkBlock(type="text")}}]
    )
    ok(n > 0, f"实际 {n}。json.dumps 要传 default=str 兜住非 JSON 类型")


test("入参里有非 JSON 类型时不崩（只是估得糙一点）", _unserializable_input_survives)

# ─────────────────────────────────────────────────────────────
print("\n预算与分区")
# ─────────────────────────────────────────────────────────────


def _input_budget() -> None:
    b = B.Budget(window=128_000, reserve_output=16_000, compress_at=0.6, compress_to=0.3)
    ok(
        B.input_budget(b) == 112_000,
        f"期待 112000，实际 {B.input_budget(b)}。128K 是输入加输出的总额，不能全给输入",
    )


test("input_budget 要减掉留白", _input_budget)

HISTORY: list[dict[str, Any]] = [
    {"role": "user", "content": "读懂 src/auth，说明登录流程"},
    {
        "role": "assistant",
        "content": [
            {"type": "text", "text": "我先看看。"},
            {
                "type": "tool_use",
                "id": "t1",
                "name": "read_file",
                "input": {"path": "src/auth/login.py"},
            },
        ],
    },
    {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "code\n" * 1000}],
    },
]

ZONES = ("system", "tool_defs", "task", "summary", "work")


def _zones_present() -> None:
    s = B.measure("sys prompt", TOOLS, HISTORY)
    for z in ZONES:
        ok(z in s.breakdown, f"缺了分区 {z}")


test("breakdown 五个分区都在", _zones_present)


def _tool_defs_counted() -> None:
    with_tools = B.measure("s", TOOLS, HISTORY)
    without = B.measure("s", [], HISTORY)
    ok(
        with_tools.breakdown["tool_defs"] > 0,
        "tool_defs 是 0。十个工具的 schema 轻松到 2K 以上，忘了算它等于把系统区当成免费的",
    )
    ok(with_tools.tokens > without.tokens, "有工具的总量应该更大")


test("工具定义要算进去（它不在 messages 里但每步都发）", _tool_defs_counted)


def _task_zone() -> None:
    s = B.measure("s", [], HISTORY)
    ok(s.breakdown["task"] > 0, "task 区是 0，第一条 user 消息应该单独计")
    ok(
        s.breakdown["task"] < s.breakdown["work"],
        f"task {s.breakdown['task']} 应该远小于 work {s.breakdown['work']}——"
        "前者是一句话，后者含一个大工具结果",
    )


test("第一条消息算作 task 区（它永不压缩）", _task_zone)


def _sum_matches() -> None:
    s = B.measure("sys", TOOLS, HISTORY)
    total = sum(s.breakdown.values())
    ok(s.tokens == total, f"总量 {s.tokens} 不等于分区之和 {total}")


test("tokens 等于各分区之和", _sum_matches)


def _top_is_max() -> None:
    s = B.measure("sys", TOOLS, HISTORY)
    biggest = max(s.breakdown.items(), key=lambda kv: kv[1])[0]
    ok(s.top == biggest, f"top 是 {s.top}，但最大的分区是 {biggest}")
    ok(s.top == "work", f"这个历史里最大的应该是 work，实际 {s.top}")


test("top 指向最大的分区", _top_is_max)


def _ratio_vs_available() -> None:
    b = B.Budget(window=10_000, reserve_output=5_000, compress_at=0.6, compress_to=0.3)
    s = B.measure("", [], [{"role": "user", "content": "x"}], b)
    by_available = s.tokens / 5_000
    ok(
        abs(s.ratio - by_available) < 1e-9,
        f"ratio={s.ratio}，按可用额度应该是 {by_available}"
        f"（按 window 会是 {s.tokens / b.window}）。\n"
        "      按 window 算会允许输入涨到模型没法写长回答为止",
    )


test("ratio 相对可用额度算，不是相对 window", _ratio_vs_available)


def _summary_not_double_counted() -> None:
    a = B.measure("", [], HISTORY)
    b = B.measure("", [], HISTORY, summary_tokens=500)
    ok(b.breakdown["summary"] == 500, f"summary 区应该是 500，实际 {b.breakdown['summary']}")
    ok(
        b.tokens == a.tokens,
        f"总量不该因为标注了摘要而变化：{a.tokens} → {b.tokens}。摘要本来就在 messages 里",
    )


test("summary_tokens 不重复计入 work", _summary_not_double_counted)

# ─────────────────────────────────────────────────────────────
print("\n分页与出路")
# ─────────────────────────────────────────────────────────────

FILE = "\n".join(f"line {i + 1}" for i in range(1240))

def _short_text_untouched() -> None:
    # 反斜杠不能出现在 f-string 的表达式里（3.12 才放开），而这个项目声明的是
    # >=3.11。本地跑 3.13 的话它不会报，只有 ruff 按 target-version 拦得住。
    src = "a\nb\nc"
    out = B.paginate(src, limit=200)
    ok(out == src, f"短文本不该被加东西，实际：{out!r}")


test("短文本不加任何提示", _short_text_untouched)

test(
    "截断时说清共有多少行",
    lambda: ok("1240" in B.paginate(FILE, limit=10), B.paginate(FILE, limit=10)[-200:]),
)


def _gives_next_offset() -> None:
    out = B.paginate(FILE, limit=10)
    ok(
        re.search(r"offset\s*=?\s*10", out),
        f"没给出 offset=10：\n{out[-200:]}\n"
        "      模型需要后面的内容却不知道怎么拿，只能重试同样的调用 → 死循环",
    )


test("截断时给出下一段的 offset（不给就是死循环）", _gives_next_offset)


def _custom_hint() -> None:
    out = B.paginate(FILE, limit=5, hint=lambda n: f"read_file(path, offset={n})")
    ok("read_file(path, offset=5)" in out, f"hint 没被用上：\n{out[-150:]}")


test("自定义 hint 生效", _custom_hint)


def _says_end() -> None:
    out = B.paginate(FILE, offset=1235, limit=20)
    ok("末尾" in out or "1240" in out, f"没说明已到末尾：\n{out[-150:]}")


test("读到末尾时说明已到末尾", _says_end)


def _offset_overflow() -> None:
    out = B.paginate(FILE, offset=9999, limit=10)
    ok(out.strip(), "返回了空字符串。模型会以为文件是空的")
    ok("9999" in out or "超出" in out, f"没说明越界：{out}")


test("offset 超出范围要说清楚，不是静默返回空", _offset_overflow)


def _negative_offset() -> None:
    """★ Python 专属：负数 offset 在切片里有别的含义。

    `lines[-5:]` 不报错，它静默返回最后五行——一个错误的输入变成了
    一个看起来正常的结果。这是 TS 没有的坑（那边 slice(-5) 也有类似行为，
    但 Python 这边更容易顺手写出来）。
    """
    out = B.paginate(FILE, offset=-5, limit=3)
    ok(
        "line 1" in out and "line 1236" not in out,
        f"负数 offset 返回了文件末尾而不是开头：\n{out[:150]}\n"
        "      负数下标在切片里是从末尾数，必须显式夹紧到 >= 0",
    )


test("负数 offset 被夹到 0，不是静默返回末尾", _negative_offset)


def _page_content() -> None:
    out = B.paginate(FILE, offset=5, limit=3)
    ok("line 6" in out, f"应该从第 6 行开始：\n{out}")
    ok("line 8" in out, f"应该到第 8 行：\n{out}")
    ok("line 9\n" not in out, f"不该包含第 9 行：\n{out}")


test("分页内容本身正确", _page_content)

# ─────────────────────────────────────────────────────────────
print("\n校准")
# ─────────────────────────────────────────────────────────────

test("没样本时 factor 是 1", lambda: ok(B.Calibrator().factor == 1, "期待 1"))


def _factor_above_one() -> None:
    c = B.Calibrator()
    c.record(1000, 1200)
    c.record(2000, 2400)
    ok(1.15 < c.factor < 1.25, f"期待约 1.2，实际 {c.factor}")


test("估算偏低时 factor 大于 1", _factor_above_one)


def _drift() -> None:
    c = B.Calibrator()
    c.record(1000, 1180)
    ok(0.15 < c.drift < 0.2, f"期待约 0.18，实际 {c.drift}")


test("drift 反映偏差幅度", _drift)


def _zero_ignored() -> None:
    c = B.Calibrator()
    c.record(0, 500)
    ok(c.count == 0, f"不该记录估算为 0 的样本，实际 count={c.count}")
    ok(c.factor == 1, f"factor 变成了 {c.factor}")


test("估算为 0 的样本被忽略（除零保护）", _zero_ignored)


def _bounded_samples() -> None:
    c = B.Calibrator()
    for _ in range(50):
        c.record(100, 100)
    ok(c.count <= 20, f"样本数 {c.count} 应该有上限，否则模型换了系数也跟不上")


test("只保留最近的样本（老样本会拖累系数）", _bounded_samples)

# ─────────────────────────────────────────────────────────────
print("\n结构化摘要")
# ─────────────────────────────────────────────────────────────

FULL = """<goal>读懂 src/auth 模块，找出安全问题</goal>
<done>
- 定位入口 src/auth/login.py:34
- 读完 session.py
</done>
<found>
- login.py:88 用了 == 比较密码
</found>
<failed>
- 搜 bcrypt 零结果，这个项目没用它
</failed>
<next>看 middleware.py</next>"""


def _prompt_has_tags() -> None:
    p = C.summary_prompt()
    for tag in ("goal", "done", "found", "failed", "next"):
        ok(tag in p, f"prompt 里没提到 {tag}")


test("summary_prompt 里要求了全部五个标签", _prompt_has_tags)

test(
    "summary_prompt 强调 goal 要原文",
    lambda: ok(
        re.search(r"原文|一字|不要改写|照抄", C.summary_prompt()),
        "prompt 没要求 goal 保留原文。目标漂移是长任务的头号失败模式",
    ),
)

test(
    "summary_prompt 强调 failed 不能省",
    lambda: ok(
        re.search(r"不能省|不要跳过|无", C.summary_prompt()),
        "prompt 没强调 failed 必须写。模型倾向于只总结成果，失败会被当成噪音丢掉",
    ),
)


def _parse_full() -> None:
    s = C.parse_summary(FULL)
    ok("安全问题" in s.goal, f"goal 不对：{s.goal}")
    ok(len(s.done) == 2, f"done 应该 2 条，实际 {len(s.done)}：{s.done}")
    ok(len(s.found) == 1, f"found 应该 1 条，实际 {len(s.found)}")
    ok(len(s.failed) == 1, f"failed 应该 1 条，实际 {len(s.failed)}")
    ok("middleware" in s.next, f"next 不对：{s.next}")


test("解析完整摘要", _parse_full)

test(
    "列表项的 - 前缀被剥掉",
    lambda: ok(
        not C.parse_summary(FULL).done[0].startswith("-"),
        f"没剥掉前缀：{C.parse_summary(FULL).done[0]}",
    ),
)

test(
    "缺 goal 要抛异常",
    lambda: raises(
        lambda: C.parse_summary(re.sub(r"<goal>.*</goal>\n", "", FULL)),
        "缺 goal 会让目标漂移",
    ),
)

test(
    "缺 failed 要抛异常（最容易被漏掉的一节）",
    lambda: raises(
        lambda: C.parse_summary(re.sub(r"<failed>[\s\S]*?</failed>\n", "", FULL)),
        "缺 failed 会让 agent 重试失败过的方法，而重复检测拦不住它",
    ),
)


def _empty_failed_is_legal() -> None:
    """★ Python 专属：`if not failed` 会把「标签不存在」和「内容是空/无」混起来。

    None 和 "" 都是假值，所以必须写 `if failed is None`。
    TS 那边 `failed === null` 是显式的，这里很容易顺手写成 falsy 判断。
    """
    s = C.parse_summary(re.sub(r"<failed>[\s\S]*?</failed>", "<failed>无</failed>", FULL))
    ok(len(s.failed) == 0, f"期待空 list，实际 {s.failed}")

    s2 = C.parse_summary(re.sub(r"<failed>[\s\S]*?</failed>", "<failed></failed>", FULL))
    ok(len(s2.failed) == 0, f"空标签也该是空 list，实际 {s2.failed}")


test("failed 写「无」或留空是合法的，解析成空 list", _empty_failed_is_legal)


def _roundtrip() -> None:
    a = C.parse_summary(FULL)
    b = C.parse_summary(C.render_summary(a))
    ok(b.goal == a.goal, f"goal 变了：{a.goal} → {b.goal}")
    ok(b.failed == a.failed, f"failed 变了：{a.failed} → {b.failed}")


test("render_summary 之后能再解析回来", _roundtrip)

test(
    "render_summary 保留路径和行号",
    lambda: ok(
        "login.py:88" in C.render_summary(C.parse_summary(FULL)),
        "路径行号丢了",
    ),
)

# ─────────────────────────────────────────────────────────────
print("\n滑动窗口")
# ─────────────────────────────────────────────────────────────


def tool_turns(n: int) -> list[dict[str, Any]]:
    msgs: list[dict[str, Any]] = [{"role": "user", "content": "原始任务"}]
    for i in range(n):
        msgs.append(
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": f"t{i}",
                        "name": "read_file",
                        "input": {"path": f"f{i}.py"},
                    }
                ],
            }
        )
        msgs.append(
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": f"t{i}", "content": f"内容 {i}"}
                ],
            }
        )
    return msgs


def has(m: dict[str, Any] | None, kind: str) -> bool:
    if m is None or isinstance(m.get("content"), str):
        return False
    return any(isinstance(b, dict) and b.get("type") == kind for b in m["content"])


test(
    "短历史原样返回",
    lambda: ok(len(C.sliding_window(tool_turns(1), 10)) == len(tool_turns(1)), "不该动"),
)

test(
    "第一条（原始任务）永远保留",
    lambda: ok(
        C.sliding_window(tool_turns(10), 4)[0].get("content") == "原始任务",
        f"第一条不是原始任务：{C.sliding_window(tool_turns(10), 4)[0]}",
    ),
)


def _pairs_intact() -> None:
    for keep in range(1, 9):
        out = C.sliding_window(tool_turns(10), keep)
        for i in range(1, len(out)):
            if has(out[i], "tool_result"):
                ok(
                    has(out[i - 1], "tool_use"),
                    f"keep={keep} 时第 {i} 条 tool_result 的前一条不是 tool_use。\n"
                    "      切点落在工具轮次中间会让 tool_result 失去配对，API 直接报 400。\n"
                    "      这个 bug 只在特定 keep 值下出现，很容易漏测",
                )


test("每个 tool_result 都能找到它的 tool_use（各种 keep 值）", _pairs_intact)


def _actually_shorter() -> None:
    msgs = tool_turns(10)
    out = C.sliding_window(msgs, 4)
    ok(len(out) < len(msgs), f"{len(msgs)} → {len(out)}，没变短")


test("确实变短了", _actually_shorter)


def _no_mutation() -> None:
    """★ Python 专属：切片返回新 list，但 `del messages[:cut]` 会改到调用方的。

    调用方通常是 run_agent，它持有同一个引用。原地改写在这里是 bug——
    sliding_window 的契约是返回一个新序列，不是就地修改。
    """
    msgs = tool_turns(10)
    before = len(msgs)
    C.sliding_window(msgs, 4)
    ok(len(msgs) == before, f"入参被改了：{before} → {len(msgs)}。这个函数应该返回新 list")


test("不改动传进来的 list", _no_mutation)

# ─────────────────────────────────────────────────────────────
print("\n压缩")
# ─────────────────────────────────────────────────────────────


@dataclasses.dataclass
class _Usage:
    input_tokens: int
    output_tokens: int


@dataclasses.dataclass
class _Block:
    type: str
    text: str


@dataclasses.dataclass
class _Msg:
    id: str
    model: str
    content: list[_Block]
    stop_reason: str
    usage: _Usage


class FakeSummarizer:
    """不管输入什么都返回一份固定的结构化摘要。"""

    def __init__(self, text: str = FULL) -> None:
        self.text = text
        self.calls: list[list[dict[str, Any]]] = []

    async def call(self, messages: list[dict[str, Any]]) -> _Msg:
        # 浅拷一份：调用方接着会原地改写这个 list，不拷的话断言看到的是最终状态
        self.calls.append(list(messages))
        return _Msg(
            id="msg_fake",
            model="deepseek-v4-flash",
            content=[_Block(type="text", text=self.text)],
            stop_reason="end_turn",
            usage=_Usage(input_tokens=4000, output_tokens=300),
        )


async def _compress_shrinks() -> None:
    msgs = tool_turns(10)
    r = await C.compress(msgs, FakeSummarizer().call, keep_recent=4)
    ok(len(r.messages) < len(msgs), f"{len(msgs)} → {len(r.messages)}，没变少")
    ok(r.messages[0].get("content") == "原始任务", "第一条被改了")


test("压缩后消息变少，且第一条还是原始任务", _compress_shrinks)


async def _summary_is_second() -> None:
    r = await C.compress(tool_turns(10), FakeSummarizer().call, keep_recent=4)
    second = r.messages[1]
    ok(
        isinstance(second.get("content"), str) and "<goal>" in second["content"],
        f"第二条不是摘要：{str(second)[:120]}",
    )


test("摘要被插在第二条", _summary_is_second)


async def _pairs_after_compress() -> None:
    for keep_recent in (2, 3, 4, 5):
        r = await C.compress(tool_turns(10), FakeSummarizer().call, keep_recent=keep_recent)
        for i in range(1, len(r.messages)):
            if has(r.messages[i], "tool_result"):
                ok(
                    has(r.messages[i - 1], "tool_use"),
                    f"keep_recent={keep_recent} 时第 {i} 条 tool_result 失去了配对",
                )


test("压缩后的序列里 tool_result 仍然配对", _pairs_after_compress)


async def _cost_reported() -> None:
    r = await C.compress(tool_turns(10), FakeSummarizer().call)
    ok(r.cost["input"] == 4000, f"input 花费不对：{r.cost['input']}")
    ok(r.cost["output"] == 300, f"output 花费不对：{r.cost['output']}")


test("返回压缩这一次的花费（它不是免费的）", _cost_reported)


async def _saved_positive() -> None:
    r = await C.compress(tool_turns(20), FakeSummarizer().call)
    ok(r.saved > 0, f"saved={r.saved}，压了 20 轮应该省下不少")


test("saved 是正数", _saved_positive)

test(
    "摘要缺 failed 时压缩要失败，不能静默接受",
    lambda: raises(
        lambda: C.compress(
            tool_turns(10),
            FakeSummarizer(re.sub(r"<failed>[\s\S]*?</failed>\n", "", FULL)).call,
        ),
        "静默接受一个缺 failed 的摘要等于把防线关掉",
    ),
)


async def _sends_instruction() -> None:
    fake = FakeSummarizer()
    await C.compress(tool_turns(10), fake.call, keep_recent=4)
    last = fake.calls[0][-1]
    ok(
        isinstance(last.get("content"), str) and "failed" in last["content"],
        "最后一条应该是摘要指令",
    )


test("传给模型的是待压部分加上摘要指令", _sends_instruction)

# ─────────────────────────────────────────────────────────────
print("\n该不该压")
# ─────────────────────────────────────────────────────────────


def stats_at(ratio: float) -> Any:
    available = B.input_budget(B.DEFAULT_BUDGET)
    tokens = round(available * ratio)
    return B.ContextStats(
        tokens=tokens,
        ratio=ratio,
        breakdown={
            "system": 900,
            "tool_defs": 1800,
            "task": 400,
            "summary": 0,
            "work": tokens - 3100,
        },
        top="work",
        budget=B.DEFAULT_BUDGET,
    )


test(
    "没到触发线不压",
    lambda: ok(
        not C.should_compress(stats_at(0.4), 30).compress,
        f"不该压：{C.should_compress(stats_at(0.4), 30).why}",
    ),
)

test(
    "刚过触发线且剩余步数多 → 压",
    lambda: ok(
        C.should_compress(stats_at(0.7), 30).compress,
        f"应该压：{C.should_compress(stats_at(0.7), 30).why}",
    ),
)

test(
    "同样长度但只剩 1 步 → 不压（这是本节最值钱的一条）",
    lambda: ok(
        not C.should_compress(stats_at(0.7), 1).compress,
        f"不该压：{C.should_compress(stats_at(0.7), 1).why}\n"
        "      压缩的收益乘的是剩余步数，而代价（重建缓存）是一次性的。\n"
        "      剩余步数少的时候不压更便宜",
    ),
)

test(
    "剩余步数为 0 时不压",
    lambda: ok(
        not C.should_compress(stats_at(0.8), 0).compress,
        f"不该压：{C.should_compress(stats_at(0.8), 0).why}",
    ),
)

test(
    "快撑爆时即使只剩 1 步也压",
    lambda: ok(
        C.should_compress(stats_at(0.95), 1).compress,
        f"应该压：{C.should_compress(stats_at(0.95), 1).why}。"
        "到这个占比不是省钱问题，是下一个工具结果会不会撑爆窗口的问题",
    ),
)


def _net_monotonic() -> None:
    nets = [C.should_compress(stats_at(0.7), n).net or 0 for n in (1, 3, 10, 50)]
    for i in range(1, len(nets)):
        ok(nets[i] >= nets[i - 1], f"净收益应该随剩余步数单调不减，实际 {nets}")


test("剩余步数越多越倾向于压", _net_monotonic)


def _why_readable() -> None:
    for steps_left in (1, 30):
        d = C.should_compress(stats_at(0.7), steps_left)
        ok(len(d.why) > 8, f"why 太短了：{d.why!r}")
        ok(not re.fullmatch(r"(?i)true|false|ok", d.why), f"why 不是给人看的：{d.why}")


test("why 能读懂（它要进日志）", _why_readable)


def _no_cache_more_eager() -> None:
    with_cache = C.should_compress(stats_at(0.7), 4, cache_discount=0.1)
    no_cache = C.should_compress(stats_at(0.7), 4, cache_discount=1)
    ok(
        (no_cache.net or 0) > (with_cache.net or 0),
        f"没缓存时净收益应该更高：{with_cache.net} vs {no_cache.net}。\n"
        "      有缓存时省下的那些 token 本来只值全价的一折，压缩的收益就小了",
    )


test("没有缓存折扣时更倾向于压", _no_cache_more_eager)

# ─────────────────────────────────────────────────────────────
print("\n" + "─" * 60)
if not _failures:
    print(f"\033[32m{_passed} 项全过。\033[0m")
    print("\n接着跑 uv run python -m l06.longrun，把这套东西接到 L05 的 agent 上量一次收益。")
else:
    print(f"\033[31m{_passed} 过，{len(_failures)} 败：\033[0m")
    for f in _failures:
        print(f"\033[31m  · {f}\033[0m")
    raise SystemExit(1)
