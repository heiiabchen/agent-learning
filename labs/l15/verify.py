"""验证 l15/cache.py。跑法：uv run python -m l15.verify
先跑 BUDGET_IMPL=shared uv run python -m l15.verify 确认测试本身是对的。

★ 一次模型都不调。这不是省事——是这一节要测的东西**恰好全是结构性的**：
缓存命中是前缀哈希相等（字符串比较），计费是 token 数乘单价倍率（整数算术），
限流是 token bucket（状态机），路由成本是概率乘单价的加权和（整数算术）。

反过来说：**真去调模型会让这些结论变得不可复现。** 时段、负载、并发邻居的
方差大于你想测的效应，于是一个学生在晚上测出「缓存让延迟降了 40%」，
另一个在早上测出「降了 5%」，两个人都以为对方错了。

带 ★ 的每一条对应一种"看起来对了但没有"：
把 input_tokens 当总输入、把不可观测当成未命中、把追加当成安全、
把截断当成追加、用 % 取随机数的低位、让倍率的除法提前发生。

它们的共同点和 L13/L14 一样：**全都不抛异常，而且日志上是绿的。**
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, is_dataclass
from typing import Any

from shared import budget as shared
from shared.budget import (
    CACHE_READ,
    CACHE_WRITE_1H,
    CACHE_WRITE_5M,
    Block,
    CacheEntry,
    ModelSpec,
    Mult,
    Price,
    Req,
    Router,
    Task,
    ToolDef,
)

TARGET = "shared" if os.environ.get("BUDGET_IMPL") == "shared" else "mine"
if TARGET == "shared":
    M: Any = shared
else:
    from l15 import cache as M  # type: ignore[no-redef]

print(
    "\n（测的是 shared/ 里的参考实现）"
    if TARGET == "shared"
    else "\n（测的是 l15/ 里你的实现）"
)

passed = 0
failures: list[str] = []


def _plain(v: Any) -> Any:
    """把 dataclass / 元组摊平成可比较的结构。"""
    if is_dataclass(v) and not isinstance(v, type):
        return {k: _plain(x) for k, x in asdict(v).items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    return v


def show(v: Any) -> str:
    return json.dumps(_plain(v), ensure_ascii=False, sort_keys=True)


def test(name: str, fn: Any) -> None:
    global passed
    try:
        fn()
        passed += 1
        print(f"\x1b[32m  ✓ {name}\x1b[0m")
    except Exception as err:  # noqa: BLE001
        failures.append(name)
        print(f"\x1b[31m  ✕ {name}\x1b[0m")
        for line in str(err).split("\n"):
            print(f"\x1b[31m      {line}\x1b[0m")


def eq(a: Any, b: Any, msg: str = "") -> None:
    x, y = show(a), show(b)
    if x != y:
        raise AssertionError(f"{msg}\n  期望 {y}\n  实际 {x}")


def ok(c: bool, msg: str = "") -> None:
    if not c:
        raise AssertionError(msg)


def throws(fn: Any, msg: str = "") -> None:
    try:
        fn()
    except Exception:  # noqa: BLE001
        return
    raise AssertionError(f"{msg}\n  期望抛错，但它正常返回了")


def section(s: str) -> None:
    print(f"\n\x1b[1m{s}\x1b[0m")


# 公用夹具
PRICE = Price(input_miss=100_000_000, output=200_000_000)


def T(n: str, d: str = "d") -> ToolDef:
    return ToolDef(n, d, {"x": 1})


def B(t: str) -> Block:
    return Block(type="text", text=t)


def REQ(**over: Any) -> Req:
    base: dict[str, Any] = {
        "model": "claude-opus-5",
        "tools": (T("a"),),
        "system": (B("sys"),),
        "messages": (B("hi"),),
    }
    base.update(over)
    return Req(**base)


# ═════════════════════════════════════════════════════════════
section("一、canonical_json：让语义相同的东西产生相同的字节")
# ═════════════════════════════════════════════════════════════

test("键序无关", lambda: eq(M.canonical_json({"b": 1, "a": 2}), M.canonical_json({"a": 2, "b": 1})))

test(
    "嵌套对象的键也排序",
    lambda: eq(M.canonical_json({"z": {"d": 1, "c": 2}}), '{"z":{"c":2,"d":1}}'),
)

test(
    "分隔符不带空格（json.dumps 默认带，所以不能用它）",
    lambda: eq(M.canonical_json({"a": 1, "b": [1, 2]}), '{"a":1,"b":[1,2]}'),
)


def t_array_order() -> None:
    ok(
        M.canonical_json([1, 2]) != M.canonical_json([2, 1]),
        "数组是有序的，排序会抹掉语义",
    )


test("数组顺序**不**排序（顺序是语义的一部分）", t_array_order)

test(
    "★ 拒绝非整数——它在两种语言里印法可能不同",
    lambda: throws(
        lambda: M.canonical_json({"a": 0.1}), "浮点必须被拒绝，不能悄悄产生一个不一致的字节串"
    ),
)

test(
    "字符串转义：引号、反斜杠、换行、制表符",
    lambda: eq(M.canonical_json('a"b\\c\nd\te'), '"a\\"b\\\\c\\nd\\te"'),
)

test("控制字符转成 \\u00xx", lambda: eq(M.canonical_json("\u0001"), '"\\u0001"'))

test(
    "★ 非 ASCII **不**转义（json.dumps 默认会转，两边就不一致了）",
    lambda: eq(M.canonical_json("中文"), '"中文"'),
)


def t_cacheable_tools() -> None:
    # 官方："some languages randomize key order during JSON conversion, breaking caches"
    s1 = {"type": "object", "properties": {"path": "string"}, "required": ["path"]}
    s2 = {"required": ["path"], "properties": {"path": "string"}, "type": "object"}
    eq(M.canonical_json(s1), M.canonical_json(s2))
    ok(
        json.dumps(s1) != json.dumps(s2),
        "★ 注意 json.dumps 对这两个是**不同**的字节串——这正是缓存被打掉的方式",
    )


test("★ 这就是「让工具定义可缓存」需要的那个函数", t_cacheable_tools)

# ═════════════════════════════════════════════════════════════
section("二、first_divergence：只报最早的那一处")
# ═════════════════════════════════════════════════════════════

test("完全相同 → None", lambda: eq(M.first_divergence(REQ(), REQ()), None))


def t_model_changed() -> None:
    d = M.first_divergence(REQ(), REQ(model="claude-sonnet-5"))
    eq(d.type, "model_changed")


test("换模型 → model_changed", t_model_changed)


def t_model_wins() -> None:
    d = M.first_divergence(REQ(), REQ(model="claude-sonnet-5", system=(B("SYS"),)))
    eq(d.type, "model_changed")
    eq(d.at, None, "model_changed 没有层内位置")


test("★ 换模型的同时改了 system → 只报 model_changed，不再看其它层", t_model_wins)

test(
    "改工具描述一个字 → tools_changed（这就是 L14 的 rug pull）",
    lambda: eq(M.first_divergence(REQ(), REQ(tools=(T("a", "d!"),))).type, "tools_changed"),
)


def t_reorder() -> None:
    # 官方："tools were added, removed, or **reordered** between turns"
    p = REQ(tools=(T("a"), T("b")))
    c = REQ(tools=(T("b"), T("a")))
    eq(M.first_divergence(p, c).type, "tools_changed")


test("★ 工具重排（内容完全相同，只是顺序不同）→ 也要报 tools_changed", t_reorder)


def t_tool_append() -> None:
    # 追加只在最后一层安全。tools 排在 system/messages 前面，
    # 加一个工具会把后面全部位移，于是那两层的断点哈希全变。
    d = M.first_divergence(REQ(), REQ(tools=(T("a"), T("b"))))
    eq(d.type, "tools_changed")
    eq(d.at, 1, "分歧位置在新加的那个工具上")


test("★ 工具清单末尾加一个 → tools_changed，**不是** None", t_tool_append)


def t_system_append() -> None:
    d = M.first_divergence(REQ(), REQ(system=(B("sys"), B("more"))))
    eq(d.type, "system_changed")
    eq(d.at, 1)


test("★ system 末尾加一块 → system_changed，**不是** None", t_system_append)

test(
    "messages 末尾追加 → None（这才是真正的追加）",
    lambda: eq(M.first_divergence(REQ(), REQ(messages=(B("hi"), B("next")))), None),
)


def t_middle_insert() -> None:
    p = REQ(messages=(B("a"), B("b")))
    c = REQ(messages=(B("a"), B("X"), B("b")))
    d = M.first_divergence(p, c)
    eq(d.type, "messages_changed")
    eq(d.at, 1)


test("messages 中间插入 → messages_changed，位置在插入点", t_middle_insert)


def t_truncate() -> None:
    # 追加和截断对缓存的后果完全相反。把两者等同处理的实现，
    # 会把每次上下文压缩都报成「一切正常」。
    p = REQ(messages=(B("a"), B("b")))
    c = REQ(messages=(B("a"),))
    d = M.first_divergence(p, c)
    eq(d.type, "messages_changed")
    eq(d.at, 1, "截断点就是较短那个的长度")


test("★ messages 被截断（上下文压缩）→ messages_changed，不能当成追加", t_truncate)


def t_hierarchy() -> None:
    # 官方："Changes at each level invalidate that level and all subsequent levels."
    d = M.first_divergence(REQ(), REQ(tools=(T("a", "d!"),), messages=(B("HI"),)))
    eq(d.type, "tools_changed", "messages 的变化被 tools 的变化盖住了，报它没有信息量")


test("★ 层级顺序：tools 和 messages 同时变 → 报 tools_changed", t_hierarchy)

test(
    "层级顺序：system 和 messages 同时变 → 报 system_changed",
    lambda: eq(
        M.first_divergence(REQ(), REQ(system=(B("S"),), messages=(B("HI"),))).type,
        "system_changed",
    ),
)


def t_empty_prev() -> None:
    empty = Req(model="claude-opus-5", tools=(), system=(), messages=())
    eq(M.first_divergence(empty, REQ()).type, "previous_message_not_found")


test("空的 prev → previous_message_not_found，不是 messages_changed", t_empty_prev)


def t_missed_tokens() -> None:
    p = REQ(messages=(B("a"), B("b")))
    c = REQ(messages=(B("a"), B("X")))
    d = M.first_divergence(p, c)
    eq(d.cache_missed_tokens, shared.block_tokens(B("X")), "只算分歧点之后的，前面那些是可复用的")


test("cache_missed_tokens = 分歧点之后（含）的 token 数", t_missed_tokens)


def t_timestamp() -> None:
    # 这就是那个 +25% 且日志全绿的场景。
    def at(m: int) -> Req:
        return REQ(system=(B("稳定的项目背景"), B(f"当前时间 10:{m}")))

    for m in range(1, 5):
        eq(M.first_divergence(at(m - 1), at(m)).type, "system_changed", f"第 {m} 轮")


test("★ system 里插一个时间戳 → 每一轮都 system_changed", t_timestamp)

# ═════════════════════════════════════════════════════════════
section("三、cache_verdict：五种端点，五个状态")
# ═════════════════════════════════════════════════════════════


def t_anthropic_hit() -> None:
    r = M.cache_verdict(
        "anthropic",
        {"input_tokens": 10, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 0},
        "claude-opus-5",
    )
    eq(r.verdict, "HIT")
    eq(r.read_tokens, 900)


test("anthropic 命中", t_anthropic_hit)


def t_total_input() -> None:
    # 官方：input_tokens 只表示**最后一个断点之后**的 token 数。
    # 一个直接把它当总输入的实现，会算出一个看起来合理但偏小的命中率——
    # 偏小的方向正好让你以为「缓存没什么用」。
    r = M.cache_verdict(
        "anthropic",
        {"input_tokens": 10, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 90},
        "claude-opus-5",
    )
    eq(r.total_input, 1000, "10 + 900 + 90")


test("★★ anthropic 的 total_input = input_tokens + read + write，不是 input_tokens", t_total_input)

test(
    "anthropic 只写不读 → WRITE_ONLY",
    lambda: eq(
        M.cache_verdict(
            "anthropic",
            {"input_tokens": 10, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 900},
            "claude-opus-5",
        ).verdict,
        "WRITE_ONLY",
    ),
)


def t_write_only_reason() -> None:
    r = M.cache_verdict(
        "anthropic",
        {"input_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 900},
        "claude-opus-5",
    )
    ok("两次" in r.reason, "第一次只写不读是正常的冷启动，判定器必须把这件事讲清楚")


test('★ WRITE_ONLY 的 reason 要说出"连续两次就是 bug"', t_write_only_reason)

test(
    "★ 双 0 + 前缀低于门槛 → BELOW_MINIMUM，不是 MISS",
    lambda: eq(
        M.cache_verdict(
            "anthropic",
            {"input_tokens": 100, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
            "claude-opus-5",
            100,
        ).verdict,
        "BELOW_MINIMUM",
        "Opus 5 的门槛是 512，100 token 根本进不去",
    ),
)

test(
    "双 0 + 前缀够长 → MISS",
    lambda: eq(
        M.cache_verdict(
            "anthropic",
            {"input_tokens": 5000, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
            "claude-opus-5",
            5000,
        ).verdict,
        "MISS",
    ),
)

test(
    "★ 门槛未公布（-1）时不能判 BELOW_MINIMUM",
    lambda: eq(
        M.cache_verdict(
            "deepseek",
            {"prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 5},
            "deepseek-v4-flash",
            5,
        ).verdict,
        "MISS",
        '没有已知门槛就不该推断"因为太短"',
    ),
)


def t_openai() -> None:
    r = M.cache_verdict(
        "openai-responses",
        {
            "input_tokens": 1000,
            "input_tokens_details": {"cached_tokens": 900, "cache_write_tokens": 0},
        },
        "gpt-5-6",
    )
    eq(r.verdict, "HIT")
    eq(r.total_input, 1000, "★ OpenAI 的 input_tokens 已含缓存部分，不要再加")


test("openai-responses 命中", t_openai)


def t_azure() -> None:
    r = M.cache_verdict(
        "azure-chat",
        {
            "prompt_tokens": 1000,
            "prompt_tokens_details": {"cached_tokens": 500, "cache_write_tokens": 0},
        },
        "gpt-5-6",
    )
    eq(r.verdict, "HIT")
    eq(r.read_tokens, 500)


test("azure-chat 的字段在 prompt_tokens_details 下", t_azure)


def t_deepseek_hit() -> None:
    r = M.cache_verdict(
        "deepseek",
        {"prompt_cache_hit_tokens": 900, "prompt_cache_miss_tokens": 100},
        "deepseek-v4-flash",
    )
    eq(r.verdict, "HIT")
    eq(r.total_input, 1000)


test("deepseek 命中，总输入 = hit + miss", t_deepseek_hit)


def t_deepseek_no_write() -> None:
    # 它的读字段是有的，能判。写入是 0 不是"缺数据"——DeepSeek 的缓存自动开启，
    # 压根不区分写入阶段。
    r = M.cache_verdict(
        "deepseek",
        {"prompt_cache_hit_tokens": 900, "prompt_cache_miss_tokens": 100},
        "deepseek-v4-flash",
    )
    eq(r.write_tokens, 0)
    ok(r.verdict != "UNDETERMINABLE", '有读字段就能判，别把"没有这个概念"当成"看不见"')


test("★ deepseek 没有写入字段，但**不能**因此判 UNDETERMINABLE", t_deepseek_no_write)


def t_deepseek_reason() -> None:
    r = M.cache_verdict(
        "deepseek",
        {"prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 1000},
        "deepseek-v4-flash",
    )
    eq(r.verdict, "MISS")
    ok("不区分" in r.reason, "否则读的人会以为 write=0 是数据缺失")


test("★ deepseek 未命中时 reason 要说明该 provider 不区分写入", t_deepseek_reason)


def t_compat() -> None:
    # 官方对自己这条端点的原话：usage.prompt_tokens_details "Always empty"。
    # 这两个状态混淆是本节最重要的那个 bug：
    # 判成 MISS，你会去优化一个你根本观测不到的东西。
    r = M.cache_verdict("anthropic-openai-compat", {"prompt_tokens": 5000}, "claude-opus-5", 5000)
    eq(r.verdict, "UNDETERMINABLE")
    eq(r.total_input, 5000, "总输入还是能读到的，只有缓存的拆分读不到")


test("★★ anthropic 的 OpenAI 兼容层 → UNDETERMINABLE，**绝不能**是 MISS", t_compat)

test(
    "★ 缓存字段整个缺失 → UNDETERMINABLE",
    lambda: eq(
        M.cache_verdict("anthropic", {"input_tokens": 5000}, "claude-opus-5", 5000).verdict,
        "UNDETERMINABLE",
        '可能是兼容层剥掉了，也可能是 SDK 旧——但都不是"没命中"',
    ),
)


def t_undeterminable_zeros() -> None:
    r = M.cache_verdict("anthropic-openai-compat", {"prompt_tokens": 5000}, "claude-opus-5")
    eq([r.read_tokens, r.write_tokens], [0, 0])


test("★ UNDETERMINABLE 的 read/write 必须是 0，不能瞎猜一个数", t_undeterminable_zeros)


def t_pct_format() -> None:
    # ★ 这一条是双语言对拍的地雷：JS 那边 Math.round(read/total*1000)/10 印出 "90"，
    # 而整数版印出 "90.0"。这一节自己讲的纪律，在自己的代码里也得守。
    r = M.cache_verdict(
        "anthropic",
        {"input_tokens": 100, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 0},
        "claude-opus-5",
    )
    ok("90.0%" in r.reason, f"期望 reason 里出现 90.0%，实际：{r.reason}")


test("HIT 的百分比走整数路径（90.0 而不是 90）", t_pct_format)

# ═════════════════════════════════════════════════════════════
section('四、simulate_turn：20 格窗口与"只找之前写过的"')
# ═════════════════════════════════════════════════════════════


def hs(n: int) -> list[str]:
    return [f"p{i + 1}" for i in range(n)]


def t_turn1() -> None:
    store: list[CacheEntry] = []
    r = M.simulate_turn(hs(10), [10], store)
    eq([r.hit_at, r.wrote_at], [None, 10])


test("官方例子 Turn 1：10 个位置，断点 10 → 写入位置 10", t_turn1)


def t_turn2() -> None:
    store: list[CacheEntry] = []
    M.simulate_turn(hs(10), [10], store)
    r = M.simulate_turn(hs(15), [15], store)
    eq([r.hit_at, r.wrote_at], [10, 15])
    eq(r.fresh_blocks, 5, "只需新算 11..15")


test("官方例子 Turn 2：断点 15 往回走，命中位置 10", t_turn2)


def t_turn3() -> None:
    # 官方原文："The turn-2 entry at block 15 is one position outside the window,
    # so there is no cache hit."
    # 这个用例的价值是它来自官方，可以当规格用。
    store: list[CacheEntry] = []
    M.simulate_turn(hs(10), [10], store)
    M.simulate_turn(hs(15), [15], store)
    r = M.simulate_turn(hs(35), [35], store)
    eq(r.hit_at, None, "位置 15 在 20 格窗口外一格")


test("★★ 官方例子 Turn 3：断点 35，窗口是 16..35 → 未命中（差一格）", t_turn3)


def t_write_once() -> None:
    # 官方："Marking a block with cache_control writes **exactly one** cache entry…
    # The system does not write entries for any earlier position."
    store: list[CacheEntry] = []
    M.simulate_turn(hs(10), [10], store)
    eq(len(store), 1, "一个断点只写一条")
    eq(store[0].position, 10)


test("★ 写只发生在断点，不给任何更早的位置写", t_write_once)


def t_window_edge() -> None:
    store: list[CacheEntry] = []
    M.simulate_turn(hs(1), [1], store)
    # 断点 20：窗口 1..20，位置 1 刚好在内
    eq(M.simulate_turn(hs(20), [20], store).hit_at, 1, "20 - 20 + 1 = 1，在窗口内")
    store2: list[CacheEntry] = []
    M.simulate_turn(hs(1), [1], store2)
    # 断点 21：窗口 2..21，位置 1 出界
    eq(M.simulate_turn(hs(21), [21], store2).hit_at, None, "差一格")


test("★ lookback 把断点自己算作第一个位置（所以往回只有 19 格）", t_window_edge)

test(
    "★ 断点超过 4 个 → 抛错（官方返回 400）",
    lambda: throws(
        lambda: M.simulate_turn(hs(10), [1, 2, 3, 4, 5], []), "上限是 4，自动缓存还要占一个名额"
    ),
)


def t_hash_change() -> None:
    store: list[CacheEntry] = []
    M.simulate_turn(hs(10), [10], store)
    changed = hs(10)
    changed[9] = "CHANGED"
    eq(M.simulate_turn(changed, [10], store).hit_at, None)


test("前缀变了就命不中（哈希不等，即使位置对）", t_hash_change)


def t_merge() -> None:
    # 官方："a run of consecutive tool_use blocks counts as one position, and so
    # does a run of consecutive tool_result blocks, so a turn with many parallel
    # tool calls doesn't push the previous request's entry out of the window."
    blocks = (
        [B("sys")]
        + [Block(type="tool_use") for _ in range(8)]
        + [Block(type="tool_result") for _ in range(8)]
        + [B("done")]
    )
    eq(len(shared.merge_positions(blocks)), 4, "sys + 一串 tool_use + 一串 tool_result + done")


test("★ 连续的 tool_use 归并成一个位置（否则并行调用会挤爆窗口）", t_merge)

# ═════════════════════════════════════════════════════════════
section("五、mixed_ttl_bill：官方的三点式公式")
# ═════════════════════════════════════════════════════════════


def t_abc() -> None:
    b = M.mixed_ttl_bill(1000, 1500, 1800, PRICE)
    eq([b.read_tokens, b.write_1h_tokens, b.write_5m_tokens], [1000, 500, 300])


test("A / B / C 三段分别按读、1h 写、5m 写计费", t_abc)


def t_abc_money() -> None:
    b = M.mixed_ttl_bill(1000, 1500, 1800, PRICE)
    want = (
        shared.charge(1000, PRICE.input_miss, CACHE_READ)
        + shared.charge(500, PRICE.input_miss, CACHE_WRITE_1H)
        + shared.charge(300, PRICE.input_miss, CACHE_WRITE_5M)
    )
    eq(b.picofen, want)


test("计费 = 0.1×A + 2×(B−A) + 1.25×(C−B)", t_abc_money)


def t_no_1h() -> None:
    b = M.mixed_ttl_bill(1000, 1000, 1800, PRICE)
    eq([b.read_tokens, b.write_1h_tokens, b.write_5m_tokens], [1000, 0, 800])


test("没有 1h 断点时 B 等于 A", t_no_1h)


def t_no_hit() -> None:
    b = M.mixed_ttl_bill(0, 0, 1800, PRICE)
    eq([b.read_tokens, b.write_5m_tokens], [0, 1800])


test("一次都没命中时 A = 0", t_no_hit)


def t_ttl_order() -> None:
    # 官方："Cache entries with longer TTL must appear before shorter TTLs"
    # 顺序反了这个账根本算不出来，静默返回一个数比抛错危险得多。
    throws(lambda: M.mixed_ttl_bill(1000, 800, 1800, PRICE), "A ≤ B ≤ C 被违反")
    throws(lambda: M.mixed_ttl_bill(0, 1800, 1000, PRICE), "B > C")


test('★ 违反"1 小时必须排在 5 分钟前面"要抛错', t_ttl_order)

# ═════════════════════════════════════════════════════════════
section("六、Limiter：连续补充的桶，不是固定窗口")
# ═════════════════════════════════════════════════════════════


def t_burst() -> None:
    # 官方："a rate of 60 RPM might be enforced as **1 request per second**"
    # 一个按固定窗口实现的客户端限流器，会在每分钟开头突发 60 个然后吃一串 429，
    # 而它自己的计数器显示"没超"。
    lim = M.Limiter(shared.LimiterOptions(capacity=1, refill_per_sec=1), 0)
    allowed = sum(1 for _ in range(60) if lim.take(0).allowed)
    eq(allowed, 1, "同一时刻只放行一个")


test('★★ 60 RPM 不等于"这一分钟随便发 60 个"', t_burst)


def t_paced() -> None:
    lim = M.Limiter(shared.LimiterOptions(capacity=1, refill_per_sec=1), 0)
    allowed = sum(1 for i in range(60) if lim.take(i * 1000).allowed)
    eq(allowed, 60)


test("按 1 秒 1 个的节奏发，60 个全放行", t_paced)


def t_retry_after() -> None:
    lim = M.Limiter(shared.LimiterOptions(capacity=1, refill_per_sec=1), 0)
    lim.take(0)
    r = lim.take(0)
    ok(not r.allowed, "第二个应该被拒")
    eq(r.retry_after_ms, 1000, "空桶补满一个令牌要 1 秒")


test("拒绝时给出 retry_after_ms", t_retry_after)


def t_half_refill() -> None:
    lim = M.Limiter(shared.LimiterOptions(capacity=1, refill_per_sec=1), 0)
    lim.take(0)
    r = lim.take(500)
    ok(not r.allowed)
    eq(r.retry_after_ms, 500)


test("补了一半的桶，retry_after_ms 也是一半", t_half_refill)


def t_capacity() -> None:
    lim = M.Limiter(shared.LimiterOptions(capacity=3, refill_per_sec=1), 0)
    allowed = sum(1 for _ in range(10) if lim.take(1_000_000).allowed)
    eq(allowed, 3, "放了一百万毫秒也只攒到容量上限")


test("桶不会超过容量（攒不了无限的额度）", t_capacity)


def t_clock_back() -> None:
    lim = M.Limiter(shared.LimiterOptions(capacity=1, refill_per_sec=1), 1000)
    throws(lambda: lim.take(500), "时钟倒流会让桶算出负的经过时间")


test("★ 时钟倒流要抛错（注入的时钟必须单调不减）", t_clock_back)


def t_level_str() -> None:
    lim = M.Limiter(shared.LimiterOptions(capacity=1, refill_per_sec=1), 0)
    r = lim.take(0)
    ok(isinstance(r.tokens, str), "返回浮点，两种语言会印出不同的位数")
    eq(r.tokens, "0.000")


test("★ 令牌数是定点字符串，不是浮点（双语言对拍）", t_level_str)


def t_overlimit_kinds() -> None:
    # 对一个"花费上限已到"的错误做指数退避，你会在那里转到超时——它永远不会成功。
    eq(shared.should_retry("rate"), True)
    eq(shared.should_retry("spend_limit"), False)
    eq(shared.should_retry("self_imposed"), False)


test("超限的三种，只有 rate 值得重试", t_overlimit_kinds)

# ═════════════════════════════════════════════════════════════
section("七、Lcg：确定性随机，以及低位陷阱")
# ═════════════════════════════════════════════════════════════

test(
    "同种子可复现",
    lambda: eq([shared.Lcg(7).next() for _ in range(3)], [shared.Lcg(7).next() for _ in range(3)]),
)


def t_lcg_low_bits() -> None:
    # 模 2^32 的线性同余发生器，第 k 位的周期只有 2^(k+1)：最低位就是 0、1、0、1。
    # 而 next() % 2 取的正好是最低位。
    #
    # 后果：拿它给一个"一半 easy 一半 hard"的任务列表做路由决策，
    # 任务的奇偶和随机数的奇偶完全同步，于是"随机路由"和"反着判的路由"
    # 算出**一模一样的账**。曲线看着挺像那么回事，结论是错的。
    r = shared.Lcg(1)
    bits = [r.int(2) for _ in range(24)]
    alternating = all(i == 0 or b != bits[i - 1] for i, b in enumerate(bits))
    ok(not alternating, f"序列在交替，说明用了低位：{''.join(map(str, bits))}")


test("★★ int(2) 不能是 0101 交替——那是 LCG 的最低位", t_lcg_low_bits)


def t_int_range() -> None:
    r = shared.Lcg(3)
    for _ in range(200):
        v = r.int(7)
        ok(0 <= v < 7, f"越界：{v}")


test("int(n) 落在 [0, n)", t_int_range)

test("int 的上界必须为正", lambda: throws(lambda: shared.Lcg(1).int(0)))


def t_backoff() -> None:
    r = shared.Lcg(5)
    for a in range(12):
        v = shared.backoff_ms(a, r, 500, 30_000)
        ok(0 <= v < 30_000, f"第 {a} 次退避越界：{v}")


test("退避有上限，且落在 [0, exp)", t_backoff)

# ═════════════════════════════════════════════════════════════
section("八、整数纪律：金额不碰浮点")
# ═════════════════════════════════════════════════════════════


def t_charge_int() -> None:
    throws(lambda: shared.charge(1.5, PRICE.input_miss), "token 数是整数，1.5 个 token 不存在")
    throws(lambda: shared.charge(-1, PRICE.input_miss), "负数也拒绝")


test("★ charge 拒绝非整数 token 数", t_charge_int)


def t_truncate_money() -> None:
    # Python 的 round() 是**银行家舍入**（round(0.5)==0、round(1.5)==2），
    # 而 JS 的 Math.round 是四舍五入。同一行代码，同一个输入，两个答案。
    # 截断在两边没有歧义，所以这里只能截断。
    #
    # 下面这笔钱是 0.0000005 元，恰好落在第 7 位小数上：
    # 截断到 6 位是 0.000000，四舍五入会变成 0.000001。
    eq(shared.yuan(shared.charge(5, 10_000_000), 6), "0.000000", "四舍五入会给出 0.000001")
    eq(shared.yuan(shared.charge(1999, 10_000_000_000), 6), "0.199900")


test("★ yuan 是截断而不是四舍五入（两种语言的舍入方向不一样）", t_truncate_money)

test(
    "1 元/M × 1000 token = 0.001 元",
    lambda: eq(shared.yuan(shared.charge(1000, 100_000_000)), "0.001000"),
)


def t_multipliers() -> None:
    eq(shared.yuan(shared.charge(1000, 100_000_000, CACHE_READ)), "0.000100")
    eq(shared.yuan(shared.charge(1000, 100_000_000, CACHE_WRITE_5M)), "0.001250")
    eq(shared.yuan(shared.charge(1000, 100_000_000, CACHE_WRITE_1H)), "0.002000")


test("缓存读是 0.1 倍，5m 写是 1.25 倍", t_multipliers)


def t_no_drift() -> None:
    # 先乘 num 再除 den 会引入舍入，而 den 是 10 / 100 / 2 这种小数，
    # 连续累加之后舍入误差刚好能让两种语言分道扬镳。
    acc = sum(shared.charge(3, 100_000_000, CACHE_READ) for _ in range(10_000))
    eq(acc, shared.charge(30_000, 100_000_000, CACHE_READ))


test("★ 倍率的除法留到最后：累加一万笔不产生漂移", t_no_drift)


def t_135() -> None:
    # 官方："Writing a prefix once and fully reusing it once costs 1.35× its
    # ordinary input cost, compared with 2× for processing it twice without caching."
    one = shared.charge(1000, PRICE.input_miss)
    cached = shared.charge(1000, PRICE.input_miss, CACHE_WRITE_5M) + shared.charge(
        1000, PRICE.input_miss, CACHE_READ
    )
    eq(cached * 100 // one, 135, "1.25 + 0.1 = 1.35")


test("★ 写一次读一次 = 1.35 倍（OpenAI 官方给的那笔算术）", t_135)


def t_215() -> None:
    one = shared.charge(1000, PRICE.input_miss)
    cached = shared.charge(1000, PRICE.input_miss, CACHE_WRITE_5M) + shared.charge(
        9000, PRICE.input_miss, CACHE_READ
    )
    eq(cached * 100 // one, 215, '官方："across ten requests … cost 2.15×"')


test("★ 十次请求：一写九读 = 2.15 倍", t_215)


def t_net_loss() -> None:
    # 这就是断点放错位置的代价，而它比不开缓存还贵。
    off = shared.charge(1000, PRICE.input_miss)
    write_only = shared.charge(1000, PRICE.input_miss, CACHE_WRITE_5M)
    eq(write_only * 100 // off, 125)


test("★ 写了从来没读到 = 净亏 25%", t_net_loss)

# ═════════════════════════════════════════════════════════════
section("九、最低可缓存长度：不随模型大小单调")
# ═════════════════════════════════════════════════════════════


def t_haiku() -> None:
    # 这就是路由和缓存打架的一个具体形式。
    ok(
        shared.min_cacheable("claude-haiku-4-5") > shared.min_cacheable("claude-opus-5"),
        "「模型越小门槛越低」是错的",
    )
    eq(shared.min_cacheable("claude-haiku-4-5"), 4096)
    eq(shared.min_cacheable("claude-opus-5"), 512)


test("★ 便宜的 Haiku 4.5 门槛(4096)比贵的 Opus 5(512)高八倍", t_haiku)

test(
    "★ 门槛不随版本单调（4.5→4.6 是 4096，4.7 降到 2048，4.8 降到 1024）",
    lambda: eq(
        [
            shared.min_cacheable(m)
            for m in ("claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8")
        ],
        [4096, 2048, 1024],
    ),
)

test(
    '未知模型返回 -1（"没公布"不是"没有"）',
    lambda: eq(shared.min_cacheable("some-model-i-made-up"), -1),
)

# ═════════════════════════════════════════════════════════════
section("十、route_outcome：随机是基线，路由器可以是负价值的")
# ═════════════════════════════════════════════════════════════

WEAK = ModelSpec("w", PRICE)
STRONG = ModelSpec("s", Price(input_miss=300_000_000, output=600_000_000))


def mk_tasks(n: int, seed: int = 99) -> list[Task]:
    g = shared.Lcg(seed)
    return [
        Task(
            id=f"t{i}",
            true_difficulty="hard" if g.int(2) == 1 else "easy",
            input_tokens=1000,
            output_tokens=200,
        )
        for i in range(n)
    ]


def R(hh: tuple[int, int], he: tuple[int, int]) -> Router:
    return Router(Mult(hh[0], hh[1]), Mult(he[0], he[1]))


def t_all_solved() -> None:
    tasks = mk_tasks(50)
    o = M.route_outcome(tasks, R((1, 2), (1, 2)), WEAK, STRONG, shared.Lcg(1))
    eq([o.solved, o.total], [50, 50])


test("所有任务都被解决（错判的会重试到强模型）", t_all_solved)


def t_perfect_saves() -> None:
    tasks = mk_tasks(100)
    o = M.route_outcome(tasks, R((1, 1), (0, 1)), WEAK, STRONG, shared.Lcg(1))
    ok(o.picofen < shared.all_strong(tasks, STRONG), "完美路由零重试，应该更省")
    eq(o.retries, 0, "完美路由不会错判")


test("完美路由比全用强模型省（没有共享前缀时）", t_perfect_saves)


def t_inverted_worse_than_base() -> None:
    # 对应 RouteLLM 在 GSM8K 上相对随机基线的 −11.8%。
    # 这条测试的存在本身就是在教：**路由器可以是负价值的。**
    tasks = mk_tasks(100)
    inverted = M.route_outcome(tasks, R((0, 1), (1, 1)), WEAK, STRONG, shared.Lcg(1))
    ok(
        inverted.picofen > shared.all_strong(tasks, STRONG),
        "把难的送给弱模型、简单的送给强模型，比不路由更贵",
    )


test('★★ 一个"反着判"的路由器比全用强模型更贵', t_inverted_worse_than_base)


def t_inverted_worse_than_random() -> None:
    tasks = mk_tasks(100)
    rand = M.route_outcome(tasks, R((1, 2), (1, 2)), WEAK, STRONG, shared.Lcg(1))
    inv = M.route_outcome(tasks, R((0, 1), (1, 1)), WEAK, STRONG, shared.Lcg(1))
    ok(inv.picofen > rand.picofen, "负信息量的路由器必须比零信息量的更差")


test("★ 反着判比随机差", t_inverted_worse_than_random)


def t_retry_costs() -> None:
    # 弱模型一次 + 强模型一次 > 强模型一次。
    # 路由省钱的前提是错分率足够低，不是"便宜模型单价低"。
    one = [Task(id="x", true_difficulty="hard", input_tokens=1000, output_tokens=200)]
    o = M.route_outcome(one, R((0, 1), (0, 1)), WEAK, STRONG, shared.Lcg(1))
    eq(o.retries, 1)
    ok(o.picofen > shared.all_strong(one, STRONG), "白跑了一次弱模型")


test("★★ 重试要算钱：一个必然错判的 hard 任务，总成本 > 直接用强模型", t_retry_costs)


def t_model_changed_breaks_cache() -> None:
    tasks = mk_tasks(100)
    o = M.route_outcome(tasks, R((1, 1), (0, 1)), WEAK, STRONG, shared.Lcg(1), 8000)
    ok(o.cache_breaks > 0, "完美路由每个请求都在换模型，每次都是一次 model_changed")


test("★ 换模型会打掉缓存（cache diagnostics 的 model_changed）", t_model_changed_breaks_cache)


def t_no_switch_gets_reads() -> None:
    tasks = mk_tasks(100)
    all_weak = M.route_outcome(tasks, R((0, 1), (0, 1)), WEAK, STRONG, shared.Lcg(1), 8000)
    perfect = M.route_outcome(tasks, R((1, 1), (0, 1)), WEAK, STRONG, shared.Lcg(1), 8000)
    ok(
        all_weak.cache_breaks != perfect.cache_breaks,
        "两种策略的换模型次数必须不同，否则缓存没被算进去",
    )


test("★ 不切模型的策略拿到全部前缀命中", t_no_switch_gets_reads)


def t_sticky_helps() -> None:
    tasks = mk_tasks(100)
    per = M.route_outcome(tasks, R((1, 1), (0, 1)), WEAK, STRONG, shared.Lcg(1), 8000, 1)
    sticky = M.route_outcome(tasks, R((1, 1), (0, 1)), WEAK, STRONG, shared.Lcg(1), 8000, 10)
    ok(sticky.cache_breaks < per.cache_breaks, "按会话粒度路由应该少换很多次模型")
    ok(sticky.prefix_reads > per.prefix_reads, "换得少，读得多")


test("★★ 粘性路由减少缓存打断（决策粒度才是真正的旋钮）", t_sticky_helps)


def t_sticky_costs() -> None:
    tasks = mk_tasks(100)
    per = M.route_outcome(tasks, R((1, 1), (0, 1)), WEAK, STRONG, shared.Lcg(1), 0, 1)
    sticky = M.route_outcome(tasks, R((1, 1), (0, 1)), WEAK, STRONG, shared.Lcg(1), 0, 10)
    ok(sticky.retries > per.retries, "块内那些和块首难度不同的任务会被放到错的模型上")
    ok(sticky.picofen > per.picofen, "★ 没有前缀可缓存的时候，这笔交易是纯亏")


test("★ 粘性路由不是免费的：它拿准确率换缓存命中", t_sticky_costs)


def t_big_prefix_beats_routing() -> None:
    # 前缀是任务的 8 倍，而基线全程不换模型：前缀写一次读九十九次。
    # 任何切模型的策略每切一次就重写一遍整段前缀。
    tasks = mk_tasks(100)
    base = shared.all_strong(tasks, STRONG, 8000)
    for name, r in (
        ("完美", R((1, 1), (0, 1))),
        ("随机", R((1, 2), (1, 2))),
        ("反着判", R((0, 1), (1, 1))),
    ):
        o = M.route_outcome(tasks, r, WEAK, STRONG, shared.Lcg(1), 8000)
        ok(o.picofen > base, f"{name}路由居然赢了基线——前缀成本没算进去")


test('★★ 有大共享前缀时，路由全面输给"全用强模型"', t_big_prefix_beats_routing)

test(
    "sticky_every 至少是 1",
    lambda: throws(
        lambda: M.route_outcome(
            mk_tasks(10), R((1, 2), (1, 2)), WEAK, STRONG, shared.Lcg(1), 0, 0
        )
    ),
)


def t_all_strong_prefix() -> None:
    tasks = mk_tasks(10)
    with_pfx = shared.all_strong(tasks, STRONG, 1000)
    want = (
        shared.all_strong(tasks, STRONG)
        + shared.charge(1000, STRONG.price.input_miss, CACHE_WRITE_5M)
        + shared.charge(9000, STRONG.price.input_miss, CACHE_READ)
    )
    eq(with_pfx, want)


test("all_strong 带前缀时：写一次，读 n−1 次", t_all_strong_prefix)

# ═════════════════════════════════════════════════════════════
section("十一、FakeEndpoint：按官方规则算账，不编数")
# ═════════════════════════════════════════════════════════════

# ★ 这段夹具必须**够长**，否则整组测试会全部退化成 BELOW_MINIMUM，
# 而那不是「缓存坏了」，是「你的前缀根本没资格进缓存」。
#
# 第一版写了 40 行短句，算出来约 480 token，正好卡在 Opus 5 的 512 门槛下面，
# 于是五个断点测试全挂在一个和断点毫无关系的原因上。
# 这条踩坑本身就是 INV-5 和 INV-10 的合体：**门槛不达标不报错，只是静默不缓存。**
BIG_SYSTEM = "\n".join(
    f"项目约定第 {i + 1} 条：改动要小、要可回滚、要先跑测试再提交。" for i in range(40)
)


def t_write_then_hit() -> None:
    ep = shared.FakeEndpoint("anthropic", "claude-opus-5")
    req = REQ(system=(Block(type="text", text=BIG_SYSTEM, cache_control_ttl="5m"),), tools=())
    v1 = M.cache_verdict("anthropic", ep.send(req, 50), "claude-opus-5", shared.prefix_tokens(req))
    v2 = M.cache_verdict("anthropic", ep.send(req, 50), "claude-opus-5", shared.prefix_tokens(req))
    eq([v1.verdict, v2.verdict], ["WRITE_ONLY", "HIT"])


test("第一次写入，第二次命中", t_write_then_hit)


def t_bp_on_volatile() -> None:
    ep = shared.FakeEndpoint("anthropic", "claude-opus-5")

    def at(m: int) -> Req:
        return REQ(
            tools=(),
            system=(
                Block(type="text", text=BIG_SYSTEM),
                Block(type="text", text=f"t={m}", cache_control_ttl="5m"),
            ),
            messages=(),
        )

    vs = [
        M.cache_verdict(
            "anthropic", ep.send(at(i), 50), "claude-opus-5", shared.prefix_tokens(at(i))
        ).verdict
        for i in range(5)
    ]
    eq(vs, ["WRITE_ONLY"] * 5)


test("★★ 断点在会变的块上 → 连续五次 WRITE_ONLY，永远不会热", t_bp_on_volatile)


def t_bp_on_stable() -> None:
    ep = shared.FakeEndpoint("anthropic", "claude-opus-5")

    def at(m: int) -> Req:
        return REQ(
            tools=(),
            system=(
                Block(type="text", text=BIG_SYSTEM, cache_control_ttl="5m"),
                Block(type="text", text=f"t={m}"),
            ),
            messages=(),
        )

    vs = [
        M.cache_verdict(
            "anthropic", ep.send(at(i), 50), "claude-opus-5", shared.prefix_tokens(at(i))
        ).verdict
        for i in range(5)
    ]
    eq(vs, ["WRITE_ONLY", "HIT", "HIT", "HIT", "HIT"])


test("★ 断点挪到稳定块上 → 第二次起全部命中（内容一个字没改）", t_bp_on_stable)


def t_below_min_silent() -> None:
    ep = shared.FakeEndpoint("anthropic", "claude-opus-5")
    req = REQ(
        tools=(), system=(Block(type="text", text="短", cache_control_ttl="5m"),), messages=()
    )
    r = M.cache_verdict("anthropic", ep.send(req, 10), "claude-opus-5", shared.prefix_tokens(req))
    eq(r.verdict, "BELOW_MINIMUM")


test("★ 前缀太短 → 静默不缓存，不抛错", t_below_min_silent)


def t_compat_no_fields() -> None:
    ep = shared.FakeEndpoint("anthropic-openai-compat", "claude-opus-5")
    req = REQ(system=(Block(type="text", text=BIG_SYSTEM, cache_control_ttl="5m"),), tools=())
    ep.send(req, 50)
    u = ep.send(req, 50)
    ok("cache_read_input_tokens" not in u, "这条端点不返回缓存字段")
    eq(M.cache_verdict("anthropic-openai-compat", u, "claude-opus-5").verdict, "UNDETERMINABLE")


test("★ 兼容端点：缓存可能照样在跑，但 usage 里没有字段", t_compat_no_fields)


def t_five_shapes() -> None:
    req = REQ(system=(Block(type="text", text=BIG_SYSTEM, cache_control_ttl="5m"),), tools=())
    got = []
    for shape in (
        "anthropic",
        "openai-responses",
        "azure-chat",
        "deepseek",
        "anthropic-openai-compat",
    ):
        ep = shared.FakeEndpoint(shape, "claude-opus-5")
        ep.send(req, 50)
        got.append(
            M.cache_verdict(
                shape, ep.send(req, 50), "claude-opus-5", shared.prefix_tokens(req)
            ).verdict
        )
    eq(got, ["HIT", "HIT", "HIT", "HIT", "UNDETERMINABLE"])


test("★ 同一个缓存状态，四种端点都判 HIT，第五种判不出来", t_five_shapes)

# ═════════════════════════════════════════════════════════════

print("")
if not failures:
    print(f"\x1b[32m  {passed} 项全过。\x1b[0m\n")
    sys.exit(0)
else:
    print(f"\x1b[31m  {passed} 过 / {len(failures)} 挂：\x1b[0m")
    for f in failures:
        print(f"\x1b[31m    · {f}\x1b[0m")
    print("")
    sys.exit(1)
