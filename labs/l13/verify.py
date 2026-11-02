"""验证 l13/trace.py。跑法：

    cd labs && uv run python -m l13.verify
    cd labs && OBS_IMPL=shared uv run python -m l13.verify   # 先确认测试本身对

一次 API 都不调。这一节的东西全是**结构和算术**——
而它的每一个失效都发生在你调用模型之前或之后，不在调用里面。

★ 带 ★ 的每一条对应一种"trace 看起来完整但不是"：
双发把花费翻倍、input_tokens 差 2001 倍、成本维度不存在、
二次方增长、4 MiB 静默丢批、head 采样偏向丢失败、
一次运行两个矛盾决策、按 span 求和重复计算、
重放不了却以为能、judge 定位不了 agent 故障。

它们的共同点：**全都不抛异常。** 而这一节比 L12 更狠一点——
L12 给你一个错的数字，这一节给你一份**错的现场**。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import Callable
from typing import Any

from shared import observe as shared
from shared.observe import ATTR, PRICES, Message, Run, Span, TailPolicy

TARGET = "shared" if os.environ.get("OBS_IMPL") == "shared" else "mine"

if TARGET == "shared":
    M: Any = shared
    print("\n（测的是 shared/ 里的参考实现）")
else:
    from l13 import trace as M  # type: ignore[no-redef]

    print("\n（测的是 l13/ 里你的实现）")

passed = 0
failures: list[str] = []


def test(name: str, fn: Callable[[], Any]) -> None:
    global passed
    try:
        r = fn()
        if asyncio.iscoroutine(r):
            asyncio.run(r)
        passed += 1
        print(f"\033[32m  ✓ {name}\033[0m")
    except Exception as err:  # noqa: BLE001
        failures.append(name)
        print(f"\033[31m  ✕ {name}\033[0m")
        for line in str(err).split("\n"):
            print(f"\033[31m      {line}\033[0m")


def eq(a: Any, b: Any, msg: str = "") -> None:
    if a != b:
        raise AssertionError(f"{msg}\n  期望 {b!r}\n  实际 {a!r}")


def ok(cond: bool, msg: str = "") -> None:
    if not cond:
        raise AssertionError(msg)


def near(a: float, b: float, tol: float = 1e-9, msg: str = "") -> None:
    if abs(a - b) > tol:
        raise AssertionError(f"{msg}\n  期望 ≈{b}\n  实际 {a}")


# ─────────────────────────────────────────────────────────
print("\n一、属性名双发")


def t_dual() -> None:
    r = M.coalesce_attrs(
        {
            "gen_ai.usage.prompt_tokens": 100,
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.system": "openai",
            "gen_ai.provider.name": "openai",
        }
    )
    eq(len(r.dual_emit), 2)
    eq(sorted(r.attrs), ["gen_ai.provider.name", "gen_ai.usage.input_tokens"])


def t_never_sum() -> None:
    r = M.coalesce_attrs(
        {"gen_ai.usage.prompt_tokens": 100, "gen_ai.usage.input_tokens": 100}
    )
    eq(r.attrs[ATTR["input_tokens"]], 100, '相加会变成 200——那正是"报告花费翻一倍"的来源')


def t_migrate() -> None:
    r = M.coalesce_attrs({"gen_ai.usage.prompt_tokens": 77})
    eq(r.attrs[ATTR["input_tokens"]], 77)
    eq(len(r.dual_emit), 0)


def t_conflict() -> None:
    r = M.coalesce_attrs(
        {"gen_ai.usage.prompt_tokens": 100, "gen_ai.usage.input_tokens": 250}
    )
    ok(len(r.conflicts) == 1, "值不一致意味着两条埋点路径在测不同的东西，必须报")


def t_cache_rename() -> None:
    r = M.coalesce_attrs({"gen_ai.usage.cache_creation.input_tokens": 900})
    eq(r.attrs[ATTR["cache_write"]], 900, "2026-08 之前的所有文章写的都是 cache_creation")


test("双发的新旧键对要被识别出来", t_dual)
test("★ 去重后的值等于其中一个，绝不是两个之和", t_never_sum)
test("只有旧键的时候要迁移到新键，不能丢", t_migrate)
test("★ 双发的两个值不一致要单独报出来（取哪个都是错的）", t_conflict)
test("cache_creation → cache_write 这个未发布的改名也要认", t_cache_rename)

# ─────────────────────────────────────────────────────────
print("\n二、token 会计")


def t_anthropic_add() -> None:
    u = M.normalize_usage(
        "anthropic",
        {"input_tokens": 50, "output_tokens": 100, "cache_read_input_tokens": 100_000},
    )
    eq(u.input_tokens, 100_050, "照字段名映射会记成 50，少算 2001 倍")
    eq(u.fresh_input, 50)


def t_openai_noadd() -> None:
    u = M.normalize_usage(
        "openai",
        {
            "input_tokens": 100_050,
            "output_tokens": 100,
            "input_tokens_details": {"cached_tokens": 100_000},
        },
    )
    eq(u.input_tokens, 100_050, "再加一次会变成 200,050——同一段代码在两家上一对一错")
    eq(u.fresh_input, 50)


def t_same_after_norm() -> None:
    a = M.normalize_usage(
        "anthropic",
        {"input_tokens": 50, "output_tokens": 100, "cache_read_input_tokens": 100_000},
    )
    o = M.normalize_usage(
        "openai",
        {
            "input_tokens": 100_050,
            "output_tokens": 100,
            "input_tokens_details": {"cached_tokens": 100_000},
        },
    )
    eq(a.input_tokens, o.input_tokens, '这才是"归一"的定义')


def t_write_no_detail() -> None:
    u = M.normalize_usage(
        "anthropic",
        {"input_tokens": 10, "output_tokens": 10, "cache_creation_input_tokens": 40_000},
    )
    ok(len(u.problems) > 0, "顶层字段是 1.25x 和 2x 两档之和，只读它算不出钱")
    eq(u.cache_write_5m + u.cache_write_1h, 40_000, "总量不能丢，只是档位未知")


def t_write_detail() -> None:
    u = M.normalize_usage(
        "anthropic",
        {
            "input_tokens": 10,
            "output_tokens": 10,
            "cache_creation_input_tokens": 40_000,
            "cache_creation": {
                "ephemeral_5m_input_tokens": 10_000,
                "ephemeral_1h_input_tokens": 30_000,
            },
        },
    )
    eq(u.cache_write_5m, 10_000)
    eq(u.cache_write_1h, 30_000)
    eq(len(u.problems), 0)


def t_reasoning_inside() -> None:
    u = M.normalize_usage(
        "openai",
        {
            "input_tokens": 100,
            "output_tokens": 1186,
            "output_tokens_details": {"reasoning_tokens": 1024},
        },
    )
    eq(u.output_tokens, 1186, "reasoning 已经在 output_tokens 里")
    eq(u.reasoning, 1024)
    ok(u.reasoning < u.output_tokens, "86% 的计费输出是不可见的，但它不是额外的一笔")


def t_reasoning_bad() -> None:
    u = M.normalize_usage(
        "openai",
        {
            "input_tokens": 10,
            "output_tokens": 100,
            "output_tokens_details": {"reasoning_tokens": 500},
        },
    )
    ok(len(u.problems) > 0)


def t_cross_provider_bug() -> None:
    # 症状：缓存 token 比 input_tokens 还多
    u = M.normalize_usage(
        "openai",
        {
            "input_tokens": 50,
            "output_tokens": 10,
            "input_tokens_details": {"cached_tokens": 100_000},
        },
    )
    ok(any("Anthropic" in p for p in u.problems), "这是最常见的跨家复制粘贴错误")


test("★ Anthropic 的 input_tokens 不含缓存，必须加回来", t_anthropic_add)
test("★ OpenAI 的 input_tokens 已含缓存，绝不能再加", t_openai_noadd)
test("★ 两家在同一次调用上归一后必须得到同一个数", t_same_after_norm)
test("缓存写入只给了顶层字段时要报出算不出钱", t_write_no_detail)
test("给了明细就要按档分开", t_write_detail)
test("reasoning 是 output 的一部分，不是另一笔", t_reasoning_inside)
test("reasoning 比 output 还多要报错（口径反了）", t_reasoning_bad)
test("★ 把 Anthropic 的相加逻辑用到 OpenAI 上要能被发现", t_cross_provider_bug)

# ─────────────────────────────────────────────────────────
print("\n三、成本")


def t_cache_read_mult() -> None:
    u = M.normalize_usage(
        "anthropic",
        {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 1_000_000},
    )
    c = M.cost_of(u, PRICES["claude-like"])
    near(c.total, 0.3, 1e-9, "1M 缓存读 = 1M × $3 × 0.1")


def t_1h_vs_5m() -> None:
    p = PRICES["claude-like"]
    w5 = M.cost_of(
        M.normalize_usage(
            "anthropic",
            {
                "output_tokens": 0,
                "cache_creation_input_tokens": 100_000,
                "cache_creation": {"ephemeral_5m_input_tokens": 100_000},
            },
        ),
        p,
    )
    w1 = M.cost_of(
        M.normalize_usage(
            "anthropic",
            {
                "output_tokens": 0,
                "cache_creation_input_tokens": 100_000,
                "cache_creation": {"ephemeral_1h_input_tokens": 100_000},
            },
        ),
        p,
    )
    near(w1.total / w5.total, 2 / 1.25, 1e-9)


def t_metric_wrong() -> None:
    heavy = M.normalize_usage(
        "anthropic",
        {"input_tokens": 100, "output_tokens": 100, "cache_read_input_tokens": 500_000},
    )
    c = M.cost_of(heavy, PRICES["claude-like"])
    ok(c.naive_total > c.total * 3, "缓存读为主时，metric 口径会大幅高估")


def t_spread() -> None:
    c = M.cost_of(
        M.normalize_usage("anthropic", {"input_tokens": 1, "output_tokens": 1}),
        PRICES["claude-like"],
    )
    eq(c.spread, 20, "0.1x 到 2x，跨度 20 倍。全部塌进 token.type=input")


def t_spread_openai() -> None:
    c = M.cost_of(
        M.normalize_usage("openai", {"input_tokens": 1, "output_tokens": 1}),
        PRICES["gpt-like"],
    )
    eq(c.spread, 12.5, "0.1x 到 1.25x")


test("缓存读按 0.1 倍计价", t_cache_read_mult)
test("1 小时档写入是 5 分钟档的 1.6 倍", t_1h_vs_5m)
test("★ 从 metric 算（所有 input 一个价）会算错，且方向取决于缓存构成", t_metric_wrong)
test('★ 倍率跨度要报出来 —— 那是"一个桶"装不下的原因', t_spread)
test("OpenAI 没有 1 小时档，跨度不同", t_spread_openai)

# ─────────────────────────────────────────────────────────
print("\n四、二次方增长")

msgs = [
    Message(
        "system" if i == 0 else ("assistant" if i % 2 == 0 else "tool"),
        f"m{i}".ljust(500 + i, "."),
    )
    for i in range(50)
]


def t_triangular() -> None:
    for k in (10, 30, 50):
        t = M.trace_size(msgs, k)
        eq(t.stored_messages, k * (k + 1) // 2, f"k={k}")


def t_unique_is_k() -> None:
    t = M.trace_size(msgs, 30)
    eq(t.unique_messages, 30)
    eq(t.stored_messages, 465)


def t_quadruples() -> None:
    a = M.trace_size(msgs, 12)
    b = M.trace_size(msgs, 24)
    r = b.stored_bytes / a.stored_bytes
    ok(3.5 < r < 4.6, f"期望 ≈4 倍，实际 {r:.2f}")


def t_dedupe() -> None:
    turns = [msgs[:k] for k in range(1, 41)]
    d = M.dedupe_trace(turns)
    eq(len(d.blobs), 40, "40 轮只有 40 条唯一消息")
    ok(d.saved_bytes > 0)


def t_canonical() -> None:
    # 两个内容相同、构造顺序不同的消息
    a = Message(role="user", content="hi")
    raw = json.loads('{"content":"hi","role":"user"}')
    b = Message(**raw)
    d = M.dedupe_trace([[a], [b]])
    eq(len(d.blobs), 1, "不规范化的话会得到 2 个 blob——去重率变成 0，而且不报错")


test("★ 存的条数正好是 k(k+1)/2", t_triangular)
test("★ 唯一条数是 k —— 冗余就是这两个数的差", t_unique_is_k)
test("★ 轮数翻倍，字节翻四倍（近似）", t_quadruples)
test("去重能把冗余压掉", t_dedupe)
test("★ 哈希前必须规范化 JSON —— 否则键序不同的同一条会算成两条", t_canonical)

# ─────────────────────────────────────────────────────────
print("\n五、4 MiB 那道墙")


def span(name: str, payload: int) -> Span:
    return Span(
        name=name,
        span_id=name,
        parent_id="root",
        kind="CLIENT",
        attrs={ATTR["operation"]: "chat", "gen_ai.input.messages": "M" * payload},
    )


def t_within_budget() -> None:
    r = M.batch_by_bytes([span("a", 2_400_000), span("b", 2_400_000), span("c", 100)])
    budget = shared.OTLP_LIMIT * 0.9
    for b in r.batches:
        ok(b.nbytes <= budget, f"一批 {b.nbytes} 超过预算 {budget}")


def t_two_fat_split() -> None:
    # 都在单 span 上限（~3.2MB）之内，单独发都没问题，加起来超 4 MiB
    r = M.batch_by_bytes([span("a", 2_400_000), span("b", 2_400_000)])
    eq(len(r.batches), 2, "按条数分批会打成一批，然后整批被当成不可重试错误丢掉")


def t_oversized() -> None:
    r = M.batch_by_bytes([span("monster", 3_900_000), span("small", 10)])
    eq(r.oversized, ["monster"])
    ok(
        any("外部化" in p for p in r.problems),
        "唯一的修法是把内容存到对象存储，span 上只留引用",
    )


def t_oversized_not_smuggled() -> None:
    r = M.batch_by_bytes([span("monster", 3_900_000), span("small", 10)])
    names = [s.name for b in r.batches for s in b.spans]
    ok("monster" not in names, "塞进去等于让整批变成不可重试错误")
    ok("small" in names, "而无关的 span 应该照常发出去")


def t_fat_reported() -> None:
    r = M.batch_by_bytes([span("a", 2_400_000)])
    ok(len(r.problems) > 0, "它现在没超批，但它随时会和别的 span 打进一批")


test("★ 每一批都不超过预算", t_within_budget)
test("★ 两个各自合法的胖 span 必须分到两批", t_two_fat_split)
test("单条就超限的要单独报出来（分批救不了它）", t_oversized)
test("超限的 span 不能被静默塞进某一批", t_oversized_not_smuggled)
test("胖 span 的存在本身要被报告", t_fat_reported)

# ─────────────────────────────────────────────────────────
print("\n六、采样")

fleet = [
    Run(
        trace_id=f"t{i}",
        ok=i % 20 != 0,
        turns=24 + (i % 17) if i % 20 == 0 else 3 + (i % 5),
        ms=200_000 if i % 20 == 0 else 9_000,
        tokens=400_000 if i % 20 == 0 else 30_000,
    )
    for i in range(1000)
]


def t_head_recall() -> None:
    h = M.head_sample(fleet, 0.1)
    ok(
        abs(h.failure_recall - 0.1) < 0.08,
        f"失败召回 {h.failure_recall:.2f}，应该接近采样率 0.1——"
        '"不偏"在这里是坏事：你要的是偏向失败',
    )


def t_head_share() -> None:
    h = M.head_sample(fleet, 0.1)
    ok(
        abs(h.failure_share - 0.05) < 0.05,
        "调试语料里失败的浓度和生产一样低——它没帮你任何忙",
    )


def t_head_full() -> None:
    h = M.head_sample(fleet, 1.0)
    eq(len(h.kept), 1000)
    near(h.failure_recall, 1.0)


def _policy(wait: int, cache: int, num: int = 100_000) -> TailPolicy:
    return TailPolicy(
        decision_wait_ms=wait,
        num_traces=num,
        decision_cache_size=cache,
        keep=lambda r: not r.ok,
    )


def t_partial() -> None:
    t = M.tail_sample(fleet[:100], _policy(30_000, 1_000_000))
    eq(len(t.decided_on_partial), 5, "5 次失败运行跑了 200 秒，远超 30 秒的默认值")


def t_zero_recall() -> None:
    t = M.tail_sample(fleet[:100], _policy(30_000, 1_000_000))
    eq(t.failure_recall, 0, "第 30 秒的时候它还没失败——策略写得再对也没用")


def t_long_wait_works() -> None:
    t = M.tail_sample(fleet[:100], _policy(400_000, 1_000_000))
    near(t.failure_recall, 1.0, 1e-9, "这才是 tail 采样该有的样子")


def t_contradictory() -> None:
    t = M.tail_sample(fleet[:100], _policy(30_000, 0))  # ★ 0 就是默认值
    ok(t.contradictory, "sampled_cache_size 默认 0，迟到的 span 会触发全新的决策")
    ok(
        any("看起来完整" in p for p in t.problems),
        "症状是一条看起来完整、只是有点短的 trace",
    )


def t_cache_fixes() -> None:
    t = M.tail_sample(fleet[:100], _policy(30_000, 1_000_000))
    eq(len(t.contradictory), 0)


def t_evict_oldest() -> None:
    t = M.tail_sample(
        fleet[:60],
        TailPolicy(
            decision_wait_ms=400_000,
            num_traces=50,
            decision_cache_size=1_000_000,
            keep=lambda r: True,
        ),
    )
    eq(len(t.dropped_too_early), 10)
    eq(t.dropped_too_early[0], "t0", "被淘汰的是最先到的那些")


def t_loop_no_trace() -> None:
    ls = M.loop_stats(fleet, 20)
    eq(len(ls.runaway), 50, "全部 50 次失控都被这个直方图看到")
    ok(ls.p99 >= 20, "而 p99 就落在失控区间里")
    ok(ls.p50 < 10, "p50 还是正常的——所以只看均值看不出问题")


test("★ head 采样的失败召回 ≈ 采样率 —— 这正是问题所在", t_head_recall)
test("★ head 采样保留的失败占比 ≈ 总体失败率（没有富集）", t_head_share)
test("采样率 1.0 要留下全部", t_head_full)
test("★ decision_wait 比运行短的时候，决策是在局部树上做的", t_partial)
test("★ 瞄着失败的策略在默认 decision_wait 下可能一条都留不下", t_zero_recall)
test("decision_wait 拉长到超过运行时长就能正常工作", t_long_wait_works)
test("★ 决策缓存为 0 时，同一次运行会拿到两个矛盾的决策", t_contradictory)
test("把决策缓存开起来，矛盾决策就消失", t_cache_fixes)
test("★ 缓冲区满的时候淘汰的是最老的 —— 而长 trace 永远最老", t_evict_oldest)
test("★ loop 长度统计不依赖任何一条 trace", t_loop_no_trace)

# ─────────────────────────────────────────────────────────
print("\n七、span 的形状")

_u = shared.normalize_usage(
    "anthropic",
    {"input_tokens": 100, "output_tokens": 200, "cache_read_input_tokens": 50_000},
)


def tree() -> list[Span]:
    return M.agent_span_tree(
        "a1",
        "c1",
        "m1",
        "anthropic",
        [
            {"kind": "chat", "usage": _u},
            {"kind": "execute_tool", "name": "grep"},
            {"kind": "chat", "usage": _u},
        ],
    )


def t_siblings() -> None:
    kids = [s for s in tree() if s.parent_id is not None]
    eq(len(kids), 3)
    ok(all(s.parent_id == "root" for s in kids), "规范预期的形状是一个总 span 下面一排兄弟")


def t_sampling_relevant() -> None:
    chat = next(s for s in tree() if s.attrs.get(ATTR["operation"]) == "chat")
    for k in (
        ATTR["operation"],
        ATTR["provider"],
        ATTR["request_model"],
        "server.address",
        "server.port",
    ):
        ok(k in chat.attrs, f"缺 {k}——tail 采样器看不到它，采样策略会静默失效")


def t_conversation_id() -> None:
    withc = [s for s in tree() if s.attrs.get(ATTR["conversation_id"]) == "c1"]
    ok(len(withc) >= 3, "每个需要被关联的 span 上都要有它")


def t_internal_no_tokens() -> None:
    root = next(s for s in tree() if s.parent_id is None)
    ok(
        ATTR["input_tokens"] not in root.attrs,
        "v1.41.0 显式移除了它，正是为了让按 span 求和不重复计算",
    )
    ok("server.address" not in root.attrs, "进程内 agent 没有 server 概念")


def t_span_names() -> None:
    t = tree()
    eq(t[0].name, "invoke_agent a1")
    eq(t[1].name, "chat m1")
    tool = next(s for s in t if s.attrs.get(ATTR["operation"]) == "execute_tool")
    eq(tool.name, "execute_tool grep")


def t_sum_clean() -> None:
    s = M.sum_usage(tree())
    eq(s["input"], 2 * _u.input_tokens)
    eq(s["output"], 2 * _u.output_tokens)
    eq(len(s["problems"]), 0)


def t_sum_root_tokens() -> None:
    t = tree()
    t[0].attrs[ATTR["input_tokens"]] = 999
    ok(any("重复计算" in p for p in M.sum_usage(t)["problems"]))


def t_sum_unnormalized() -> None:
    bad = [
        Span(
            name="chat x",
            span_id="x",
            parent_id=None,
            kind="CLIENT",
            attrs={
                ATTR["operation"]: "chat",
                ATTR["input_tokens"]: 100,  # 原始的、不含缓存的值
                ATTR["output_tokens"]: 10,
                ATTR["cache_read"]: 50_000,
            },
        )
    ]
    ok(any("没归一" in p for p in M.sum_usage(bad)["problems"]))


def t_sum_reasoning() -> None:
    bad = [
        Span(
            name="chat y",
            span_id="y",
            parent_id=None,
            kind="CLIENT",
            attrs={ATTR["output_tokens"]: 10, ATTR["reasoning_tokens"]: 500},
        )
    ]
    ok(len(M.sum_usage(bad)["problems"]) > 0)


test("★ 子 span 是兄弟，不是嵌套链", t_siblings)
test("★ sampling-relevant 的五个属性必须在 chat span 上齐全", t_sampling_relevant)
test("跨轮次关联靠 conversation.id，不靠父子关系", t_conversation_id)
test("★ internal 的 invoke_agent 不带 token usage", t_internal_no_tokens)
test("span 名遵循 {operation} {target} 格式", t_span_names)
test("按 span 求和不重复计算", t_sum_clean)
test("★ 根 span 也带 token 的时候要报重复计算", t_sum_root_tokens)
test("★ 未归一的 Anthropic 语义要能被发现（缓存比总输入还多）", t_sum_unnormalized)
test("reasoning 比 output 多也要报", t_sum_reasoning)

# ─────────────────────────────────────────────────────────
print("\n八、复现")


def _with_content() -> list[Span]:
    t = tree()
    for s in t:
        if s.attrs.get(ATTR["operation"]) == "chat":
            s.attrs["gen_ai.input.messages"] = "[]"
    return t


def t_no_content() -> None:
    r = M.check_replayability(tree())
    eq(r.replayable, False)
    ok(any("opt_in" in b for b in r.blockers), "OTel 的四个内容属性默认不发")


def t_with_content() -> None:
    eq(M.check_replayability(_with_content()).replayable, True)


def t_prev_response_id() -> None:
    t = _with_content()
    for s in t:
        if s.attrs.get(ATTR["operation"]) == "chat":
            s.attrs["gen_ai.request.previous_response.id"] = "resp_x"
    r = M.check_replayability(t)
    eq(r.replayable, False)
    ok(any("指针" in b for b in r.blockers), "你记的是一个指向别人服务器上会过期的状态的指针")


def t_warnings_not_blockers() -> None:
    r = M.check_replayability(_with_content())
    eq(r.replayable, True)
    ok(len(r.warnings) >= 2)


def t_seed_warning() -> None:
    r = M.check_replayability(_with_content())
    ok(
        any("不存在" in w for w in r.warnings),
        '"设个 seed"这个建议在现代 agent SDK 的底座上是结构性不可用的',
    )


def t_fingerprint_warning() -> None:
    ok(any("漂移" in w for w in M.check_replayability(_with_content()).warnings))


test("★ 没开内容采集的 trace 不能重放（而它完全「合规」）", t_no_content)
test("开了内容采集就不再是硬阻塞", t_with_content)
test("★ previous_response_id 是硬阻塞（状态不在你手里）", t_prev_response_id)
test("缺 seed / system_fingerprint 是警告，不是阻塞", t_warnings_not_blockers)
test("★ seed 的警告要说清它在 Responses API 里根本不存在", t_seed_warning)
test("★ system_fingerprint 的警告要说清它是漂移信号而不是确定性契约", t_fingerprint_warning)

# 录放机：需要 async
_calls: list[str] = []


async def _live(tag: str) -> dict[str, str]:
    _calls.append(tag)
    return {"text": tag}


async def _record() -> shared.Cassette:
    rec = shared.Recorder("record")
    await rec.call("openai", "/r", {"p": 1}, lambda: _live("a"))
    await rec.call("openai", "/r", {"p": 2}, lambda: _live("b"))
    await rec.call("openai", "/r", {"p": 2}, lambda: _live("c"))  # 重试：同一个请求
    return rec.finish()


_cass = asyncio.run(_record())


def t_cassette_seq() -> None:
    eq(len(_cass.entries), 3)
    eq(len([e for e in _cass.entries if e.seq == 1]), 1, "第二次 {p:2} 的 seq 应该是 1")


async def t_fifo() -> None:
    p = shared.Recorder("replay", _cass)
    r1 = await p.call("openai", "/r", {"p": 2}, lambda: _live("x"))
    r2 = await p.call("openai", "/r", {"p": 2}, lambda: _live("x"))
    eq([r1["text"], r2["text"]], ["b", "c"], "否则重试循环里的第二次会拿到第一次的响应")


async def t_no_live() -> None:
    n = len(_calls)
    p = shared.Recorder("replay", _cass)
    await p.call("openai", "/r", {"p": 1}, lambda: _live("x"))
    eq(len(_calls), n, "重放的定义就是不打真实请求")
    eq(p.report.matched, 1)


def t_key_order() -> None:
    p = shared.Recorder("replay", _cass)
    eq(
        p.key_for("openai", "/r", {"p": 1, "q": 2}),
        p.key_for("openai", "/r", {"q": 2, "p": 1}),
        "不规范化的话同一个请求会哈希成两个键，然后全都判成分叉",
    )


async def t_strict_raises() -> None:
    p = shared.Recorder("replay", _cass)
    threw = False
    try:
        await p.call("openai", "/r", {"p": 999}, lambda: _live("x"))
    except shared.DivergenceError:
        threw = True
    ok(threw, "悄悄回落 = 你以为在重放，其实在跑一次新的")


async def t_hybrid() -> None:
    n = len(_calls)
    p = shared.Recorder("hybrid", _cass)
    await p.call("openai", "/r", {"p": 1}, lambda: _live("h1"))
    await p.call("openai", "/r", {"p": 999}, lambda: _live("h2"))
    eq(p.report.matched, 1)
    eq(p.report.went_live, True)
    eq(len(_calls) - n, 1, "只有分叉之后的那一次是真实的")
    eq(p.report.diverged_at, 2, "分叉发生在第 2 次调用")


def t_clock() -> None:
    r = shared.Recorder("record")
    t1, t2 = r.now(), r.now()
    c = r.finish()
    eq(len(c.clock), 2)
    p = shared.Recorder("replay", c)
    eq([p.now(), p.now()], [t1, t2])


def t_request_id() -> None:
    r = shared.Recorder("record")
    rid = r.request_id()
    c = r.finish()
    eq(shared.Recorder("replay", c).request_id(), rid, "SDK 每次都会生成新的")


test("录音要记下同一个键的多次调用", t_cassette_seq)
test("★ 同一个键要按 FIFO 游标推进，不能都拿第一次的响应", t_fifo)
test("重放不发起真实调用", t_no_live)
test("请求体键序不同要算成同一个键", t_key_order)
test("★ 严格重放遇到分叉要抛，不能悄悄回落到真实调用", t_strict_raises)
test("★ hybrid 模式重放到分叉点后转真实调用", t_hybrid)
test("时钟要被虚拟化，否则重放会走到不同的超时分支", t_clock)
test("★ 请求 id 要被录下来，否则第一次调用就分叉", t_request_id)

# ─────────────────────────────────────────────────────────
print("\n九、归因")


def tool_spans(names: list[str]) -> list[Span]:
    return [
        Span(
            name="invoke_agent a",
            span_id="root",
            parent_id=None,
            kind="INTERNAL",
            attrs={ATTR["operation"]: "invoke_agent"},
        ),
        *[
            Span(
                name=f"execute_tool {t}",
                span_id=f"s{i}",
                parent_id="root",
                kind="INTERNAL",
                attrs={ATTR["operation"]: "execute_tool", ATTR["tool_name"]: t},
            )
            for i, t in enumerate(names)
        ],
    ]


def t_repetition() -> None:
    v = M.classify_failure(tool_spans(["s", "s", "s", "r"]), ok=False, turns=8)
    ok(any(x.code == "FM-1.3" for x in v))


def t_two_is_fine() -> None:
    v = M.classify_failure(tool_spans(["s", "s", "r"]), ok=False, turns=8)
    ok(not any(x.code == "FM-1.3" for x in v), "正常 agent 也会重复调工具，规则不能太敏感")


def t_no_termination() -> None:
    v = M.classify_failure(tool_spans(["a"]), ok=False, turns=31)
    ok(any(x.code == "FM-1.5" for x in v))


def t_long_success_ok() -> None:
    v = M.classify_failure(tool_spans(["a"]), ok=True, turns=31)
    ok(not any(x.code == "FM-1.5" for x in v), "31 轮成功完成的任务就是 31 轮的任务")


def t_premature() -> None:
    v = M.classify_failure(tool_spans([]), ok=True, turns=1)
    ok(any(x.code == "FM-3.1" for x in v))


def t_compacted() -> None:
    s = tool_spans(["a"])
    s[0].attrs[ATTR["compacted"]] = True
    f = next(x for x in M.classify_failure(s, ok=False, turns=5) if x.code == "FM-1.4")
    ok("不知道" in f.evidence, "规范说 SHOULD NOT 设成 false，所以字段缺失 ≠ 没压缩")


def t_absent_is_unknown() -> None:
    v = M.classify_failure(tool_spans(["a"]), ok=False, turns=5)
    ok(
        not any(x.code == "FM-1.4" for x in v),
        '不知道就不要报，别把"未知"写成"没有"',
    )


test("步骤重复要被判出来（MAST 里占比最高的一类）", t_repetition)
test("调用两次不算重复（阈值要有意义）", t_two_is_fine)
test("跑太多轮还没结束 = 不知道终止条件", t_no_termination)
test("成功的长运行不算失败", t_long_success_ok)
test("一轮就结束且没调工具 = 过早终止", t_premature)
test("★ compacted=true 要被记下来，且要说清反面不成立", t_compacted)
test('★ 字段缺失不能被当成"没压缩"', t_absent_is_unknown)

# ─────────────────────────────────────────────────────────
print("\n十、复盘报告")

from l13 import postmortem as pm  # noqa: E402


def t_untrustworthy() -> None:
    r = pm.postmortem(pm.scenario())
    eq(r.trustworthy, False, "decision_wait 30 秒 + 决策缓存 0，这份轨迹可能是截断的")


def t_trust_first() -> None:
    r = pm.postmortem(pm.scenario())
    ok(len(r.telemetry_defects) > 0)
    ok(
        any("decision_wait" in d for d in r.telemetry_defects),
        '这条是"你看到的东西可能不完整"，它必须在"我判断出什么"之前',
    )


def t_not_replayable() -> None:
    r = pm.postmortem(pm.scenario())
    eq(r.replay_ok, False)
    ok(len(r.replay_reasons) >= 3)


def t_only_search() -> None:
    r = pm.postmortem(pm.scenario())
    rep = [f for f in r.failures if f.code == "FM-1.3"]
    eq(len(rep), 1, "别的工具各调一两次，不该被判成步骤重复")
    ok("search" in rep[0].evidence)


def t_cost_from_spans() -> None:
    r = pm.postmortem(pm.scenario())
    ok(r.cost_from_spans > 0)
    ok(r.cost_error_pct > 100, f"metric 口径高估了 {r.cost_error_pct:.0f}%")


def t_for_humans() -> None:
    r = pm.postmortem(pm.scenario())
    ok(len(r.for_humans) > 0, "不要假装程序能判完——TRAIL 的最好成绩是 18.3%")
    ok(
        any("直方图" in h for h in r.for_humans),
        "并且要指出哪个数字是采样缺陷影响不到的",
    )


def t_taxonomy_gap() -> None:
    inc = pm.scenario()
    # 只剩一个干净的根 span：没有工具调用、没有压缩、轮数也不多
    inc.spans = [
        Span(
            name="invoke_agent refund-handler",
            span_id="root",
            parent_id=None,
            kind="INTERNAL",
            attrs={ATTR["operation"]: "invoke_agent"},
        )
    ]
    inc.ok = False
    inc.turns = 3
    inc.ms = 5_000
    r = pm.postmortem(inc)
    eq(len(r.failures), 0)
    ok(
        any("分类学" in h for h in r.for_humans),
        '"没有规则命中"不等于"没有失败模式"',
    )


def t_head_scenario() -> None:
    inc = pm.scenario()
    inc.sampling = pm.Sampling(mode="head", rate=0.1, decision_wait_ms=30_000, cache_size=0)
    r = pm.postmortem(inc)
    ok(any("没有任何记录" in d for d in r.telemetry_defects))
    eq(r.trustworthy, False)


test("★ 有采样缺陷的现场要被判成不可信", t_untrustworthy)
test("★ 可信度判定要在结论之前 —— 报告里排第一位", t_trust_first)
test("这个场景不能重放，且理由要具体", t_not_replayable)
test("失败模式只该在真正打转的工具上命中", t_only_search)
test("★ 成本要从 span 算，且要报出 metric 口径错多少", t_cost_from_spans)
test('★ 报告必须留出"交给人"的部分', t_for_humans)
test("规则全不命中但运行失败了，要明确说这是分类学的缺口", t_taxonomy_gap)
test("head 采样的现场要报出有多少同类事故完全没有记录", t_head_scenario)

# ─────────────────────────────────────────────────────────

print(f"\n{'─' * 66}")
if not failures:
    print(f"\033[32m全部通过（{passed}）\033[0m")
    print("\n★ 接着跑 uv run l13/postmortem.py —— 把这些零件接成一份会让 CI 变红的复盘报告。")
else:
    print(f"\033[32m通过 {passed}\033[0m，\033[31m失败 {len(failures)}\033[0m：")
    for f in failures:
        print(f"\033[31m  · {f}\033[0m")
    sys.exit(1)
