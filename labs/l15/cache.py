"""L15 的脚手架。跑法：uv run python -m l15.cache

分两半：
    上半是**观察实验**，直接跑参考实现，让你先看见现象。不用写代码。
    下半是七个 TODO，你来实现。写完跑 uv run python -m l15.verify。

观察实验为什么放前面：这一节所有的坑都是**静默**的。
你不先亲眼看见「配置看起来完全正确、日志全绿、账单涨了 25%」这个场景，
就不会明白为什么下面那些函数值得写。

★ 全程一次模型都不调。原因不是省钱，是这一节要测的东西**恰好都是结构性的**：
    · 缓存命中 = 前缀哈希相等 → 字符串比较
    · 计费 = token 数 × 单价倍率 → 整数算术
    · 限流 = token bucket → 状态机
    · 路由成本 = 概率 × 单价的加权和 → 整数算术
真调模型反而会让这些结论变得不可复现（见讲义第十节「不要实测延迟」）。

这个文件是 l15/cache.ts 的镜像，观察实验的输出逐字节一致。
"""

from __future__ import annotations

import sys
from typing import Any

from shared import budget as ref
from shared.budget import (
    CACHE_READ,
    CACHE_WRITE_5M,
    Block,
    CacheEntry,
    CacheReport,
    Divergence,
    FakeEndpoint,
    Lcg,
    LimiterOptions,
    LimitOutcome,
    MixedTtlBill,
    ModelSpec,
    Price,
    ProviderShape,
    Req,
    Router,
    Task,
    TurnResult,
    Verdict,
    charge,
    min_cacheable,
    prefix_tokens,
    yuan,
)
from shared.budget import (
    canonical_json as ref_canonical_json,
)


def dim(s: str) -> str:
    return f"\x1b[2m{s}\x1b[0m"


def bold(s: str) -> str:
    return f"\x1b[1m{s}\x1b[0m"


def red(s: str) -> str:
    return f"\x1b[31m{s}\x1b[0m"


def green(s: str) -> str:
    return f"\x1b[32m{s}\x1b[0m"


def yellow(s: str) -> str:
    return f"\x1b[33m{s}\x1b[0m"


def _w(s: str) -> int:
    n = 0
    for c in s:
        o = ord(c)
        n += 2 if (0x2E80 <= o <= 0x9FFF) or (0xFF00 <= o <= 0xFFEF) else 1
    return n


def pad(s: str, n: int) -> str:
    return s + " " * max(0, n - _w(s))


def rpad(s: str, n: int) -> str:
    return " " * max(0, n - _w(s)) + s


# ═════════════════════════════════════════════════════════════
# 上半：观察实验
# ═════════════════════════════════════════════════════════════

P = Price(input_miss=100_000_000, output=200_000_000)


def long_system() -> str:
    return "\n".join(
        f"项目约定第 {i + 1} 条：改动要小、要可回滚、要先跑测试再提交。" for i in range(40)
    )


def exp1() -> None:
    """实验一：写一次、读一次，到底划不划算。

    OpenAI 官方给了这笔算术的原文，值得逐字记住：
      "Writing a prefix once and fully reusing it once costs 1.35× its ordinary
       input cost, compared with 2× for processing it twice without caching.
       The savings grow with each additional cache read: across ten requests,
       one write and nine full reads cost 2.15×, compared with 10× without caching."

    ★ 注意 1.35 这个数怎么来的：1.25（写）+ 0.1（读）。
    也就是说**写一次读一次就已经回本**。但反过来：
    **写了从来没读到，是净亏 25%。** 这就是实验二那个场景。
    """
    print(bold("\n实验一：缓存的盈亏平衡点在第几次"))
    print(dim("  一段 4000 token 的前缀，重复 N 次请求。\n"))
    t = 4000
    print(
        dim(
            "  "
            + pad("N", 5)
            + rpad("不开缓存", 12)
            + rpad("开缓存", 12)
            + rpad("倍率", 8)
            + rpad("省", 8)
        )
    )
    for n in (1, 2, 3, 5, 10, 20):
        off = charge(t * n, P.input_miss)
        # 一次写入 + (n-1) 次读取
        on = charge(t, P.input_miss, CACHE_WRITE_5M) + charge(
            t * (n - 1), P.input_miss, CACHE_READ
        )
        # 倍率相对「这段前缀不开缓存处理一次」的价格。取百分位，手写小数点。
        ratio = on * 100 // charge(t, P.input_miss)
        saved = (off - on) * 1000 // off
        s = f"{saved // 10 if saved >= 0 else -((-saved) // 10)}.{abs(saved) % 10}%"
        cell = green(rpad(s, 8)) if off > on else red(rpad(s, 8))
        print(
            "  "
            + pad(str(n), 5)
            + rpad(yuan(off), 12)
            + rpad(yuan(on), 12)
            + rpad(f"{ratio // 100}.{ratio % 100:02d}x", 8)
            + cell
        )
    print(
        dim(
            "\n  ★ 倍率那一列请和官方原文对一下：N=1 是 1.25x，N=2 是 1.35x，N=10 是 2.15x。\n"
            '    OpenAI 文档的原话是 "Writing a prefix once and fully reusing it once costs\n'
            '    1.35× … across ten requests, one write and nine full reads cost 2.15×"。\n'
            "    对上了，说明这个计价模型和厂商的口径一致——这是你后面所有结论的地基。\n"
            "\n"
            "    N=1 那一行是**亏的**（1.25x vs 1x）：一次性的 prompt 不要开缓存。\n"
            "    N=2 就回本了。所以「要不要开缓存」等价于「这段前缀会不会被复用第二次」。"
        )
    )


def exp2() -> None:
    """实验二：断点放错一个位置，代价是多少。

    ★ 这是本节最贵的那个 bug，而它的全部症状就是「账单涨了，日志全绿」。
    """
    print(bold("\n实验二：同样的内容，断点差一个位置"))
    bg = long_system()

    def mk(minute: int, bp_on_timestamp: bool) -> Req:
        system = (
            (
                Block(type="text", text=bg),
                Block(type="text", text=f"t=10:{minute}", cache_control_ttl="5m"),
            )
            if bp_on_timestamp
            else (
                Block(type="text", text=bg, cache_control_ttl="5m"),
                Block(type="text", text=f"t=10:{minute}"),
            )
        )
        return Req(model="claude-opus-5", tools=(), system=system, messages=())

    for on_ts in (True, False):
        ep = FakeEndpoint("anthropic", "claude-opus-5")
        paid = 0
        verdicts: list[Verdict] = []
        for i in range(5):
            u = ep.send(mk(30 + i, on_ts), 100)
            r = ref.cache_verdict(
                "anthropic", u, "claude-opus-5", prefix_tokens(mk(30 + i, on_ts))
            )
            verdicts.append(r.verdict)
            miss = r.total_input - r.read_tokens - r.write_tokens
            paid += (
                charge(miss, P.input_miss)
                + charge(r.read_tokens, P.input_miss, CACHE_READ)
                + charge(r.write_tokens, P.input_miss, CACHE_WRITE_5M)
                + charge(100, P.output)
            )
        label = "断点在时间戳上" if on_ts else "断点在稳定内容上"
        print(f"\n  {pad(label, 20)}{rpad(yuan(paid), 12)} 元")
        print(dim(f"    五次的判定：{' · '.join(verdicts)}"))
    print(
        dim(
            "\n  ★ 两组的内容、请求数、token 数完全一样，"
            "唯一的区别是 cache_control 挂在哪一块上。\n"
            "    第一组连续五次 WRITE_ONLY——每次付 1.25 倍写入费，一次读都没拿到。\n"
            "    这不是「缓存还没热」。它永远不会热，因为断点后面那块每次都变。"
        )
    )


def exp3() -> None:
    """实验三：lookback 找的不是「稳定内容」。

    Anthropic 专门写了一节叫 "Common mistake" 讲这件事，原文：
      "**The lookback does not find stable content behind your breakpoint and
       cache it.** It finds entries that prior requests already wrote, and
       writes happen only at breakpoints."

    下面复现的是官方给的那个三轮例子。★ 它的价值在于**这是官方原文给的用例**，
    不是我们编的——所以它能当作规格来用。
    """
    print(bold("\n实验三：20 格 lookback 窗口（官方三轮例子）"))

    def hashes(n: int) -> list[str]:
        return [f"p{i + 1}" for i in range(n)]

    store: list[CacheEntry] = []
    print("")
    for n, bp in ((10, 10), (15, 15), (35, 35)):
        r = ref.simulate_turn(hashes(n), [bp], store)
        tag = red("未命中") if r.hit_at is None else green(f"命中于 {r.hit_at}")
        print(f"  {pad(f'{n} 个位置，断点在 {bp}', 24)}{pad(tag, 22)}{dim(r.note)}")
    print(
        dim(
            "\n  ★ 第三轮没命中，而原因非常刺眼：第二轮的条目写在位置 15，\n"
            "    而窗口覆盖的是 35 往回 20 格 = 16..35。**差一格。**\n"
            "    这就是为什么「一轮里塞很多 block」会静默地把上一轮的缓存挤出窗口。\n"
            "    官方对此有一条缓解：连续的 tool_use 算一个位置，连续的 tool_result 也算一个。"
        )
    )


def exp4() -> None:
    """实验四：同一次请求，五种 provider 的 usage 长什么样。

    ★ 这个实验的结论不是「字段名不一样，写个适配器就好」。
    是：**有一条端点让这个问题无法回答。**
    """
    print(bold("\n实验四：同一次请求，五种端点的 usage"))
    bg = long_system()
    req = Req(
        model="claude-opus-5",
        tools=(),
        system=(Block(type="text", text=bg, cache_control_ttl="5m"),),
        messages=(Block(type="text", text="继续"),),
    )
    shapes: list[ProviderShape] = [
        "anthropic",
        "openai-responses",
        "azure-chat",
        "deepseek",
        "anthropic-openai-compat",
    ]
    print("")
    for shape in shapes:
        ep = FakeEndpoint(shape, "claude-opus-5")
        ep.send(req, 50)  # 第一次：写入
        u = ep.send(req, 50)  # 第二次：应该命中
        r = ref.cache_verdict(shape, u, "claude-opus-5", prefix_tokens(req))
        c = green if r.verdict == "HIT" else (red if r.verdict == "UNDETERMINABLE" else yellow)
        print(f"  {pad(shape, 26)}{c(pad(r.verdict, 16))}{dim(ref_canonical_json(u))}")
    print(
        dim(
            "\n  ★ 前四行都判出了 HIT——同一次请求，同一个缓存状态。\n"
            "    最后一行是 UNDETERMINABLE，而且注意它的 usage 里**根本没有缓存字段**。\n"
            '    Anthropic 官方对自己这条兼容端点的原话是 "Always empty"。\n'
            "\n"
            "    所以在那条端点上，「缓存生效了吗」这个问题在响应里没有答案。\n"
            "    把它当成「没命中」，你会去优化一个你观测不到的东西；\n"
            "    把它当成「命中」，你会报出一个编出来的省钱比例。"
        )
    )


def exp5() -> None:
    """实验五：最低门槛不随模型大小单调。"""
    print(bold("\n实验五：最低可缓存长度"))
    print(dim("  一段 1500 token 的 system prompt，在不同模型上能不能进缓存。\n"))
    for m in (
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-opus-4-7",
        "claude-haiku-4-5",
        "claude-opus-4-6",
    ):
        floor = min_cacheable(m)
        ok = floor > 0 and 1500 >= floor
        tag = green("进得去") if ok else red("进不去，且不报错")
        print(f"  {pad(m, 22)}{rpad(str(floor), 6)}  {tag}")
    print(
        dim(
            "\n  ★ Haiku 4.5 的门槛是 4096，比 Opus 5 的 512 高八倍。**便宜的模型门槛更高。**\n"
            "    这就是路由和缓存打架的一个具体形式：你把简单任务路由到 Haiku 省单价，\n"
            "    结果那段 1500 token 的 system prompt 在它上面根本进不了缓存，每次全价。\n"
            "    省下的单价差，可能小于丢掉的缓存。"
        )
    )


def observe() -> None:
    print(bold("\n╔═══ 观察实验：先看现象 ═══╗"))
    exp1()
    exp2()
    exp3()
    exp4()
    exp5()
    print(
        bold("\n╚═══ 五个实验的共同点 ═══╝\n")
        + dim(
            "  没有一个抛异常。没有一个在日志里留下红字。\n"
            "  实验二那组连续五次 WRITE_ONLY，如果你只看「请求成功了吗」，它是 100% 成功。\n"
            "\n"
            "  这就是下面七个 TODO 存在的理由：**唯一的信号在 usage 字段里，\n"
            "  而你需要一套判定器把它读出来。**\n"
        )
    )


# ═════════════════════════════════════════════════════════════
# 下半：你的实现
# ═════════════════════════════════════════════════════════════


def canonical_json(v: Any) -> str:
    """TODO 1：规范化序列化。

    要求：键排序、分隔符固定（`,` 和 `:`，不带空格）、只接受整数、
    字符串自己转义（不要用 json.dumps）。

    ★ 为什么这个函数值得你自己写一遍：它同时解决两个看起来无关的问题。
      1. 让 TS 和 Python 的输出逐字节一致（对拍能过）。
      2. 让你的工具定义**可缓存**——Anthropic 原话：
         "some languages (for example, Swift, Go) randomize key order during
          JSON conversion, **breaking caches**"
    这两件事要的是同一个性质：同样的语义产生同样的字节。

    提示：`json.dumps` 的默认分隔符是 `", "` 和 `": "`（带空格），
    而且默认把非 ASCII 转成 `\\uXXXX`。两条都和 JS 不一样。
    """
    raise NotImplementedError("TODO 1 未实现")


def first_divergence(prev: Req, curr: Req) -> Divergence | None:
    """TODO 2：找出**最早**的分歧点。

    返回 None 表示没有分歧。type 的取值照搬 Anthropic cache diagnostics 的
    cache_miss_reason.type：model_changed / tools_changed / system_changed /
    messages_changed / previous_message_not_found。

    必须满足的性质（每一条都对应一个官方事实）：

      a. 层级顺序是 model → tools → system → messages，**只报最早的那一个**。
         官方："The response reports the earliest divergence only."
         换模型之后**不要再检查其它层**。

      b. 工具**重排**（内容完全相同、只是顺序不同）也要报 tools_changed。
         官方："tools were added, removed, or **reordered** between turns"

      c. ★ 往 messages 末尾**追加**返回 None，但往 tools 或 system 末尾追加
         **要报分歧**。
         想清楚为什么再写：追加只在整条前缀的**最后一层**是安全的。
         tools 排在 system 和 messages 前面，加一个工具会把后面全部位移。

      d. curr 比 prev **短**（截断，也就是上下文压缩）永远是分歧。
         ★ 追加和截断的后果完全相反，一个把两者等同处理的实现，
         会把每次上下文压缩都报成「一切正常」。

      e. cache_missed_tokens = 分歧点之后（含）的 token 数。

    ★ 最该自己体会的那条：在 system prompt 里插一个时间戳，
    每次都会报 system_changed。而这时 cache_missed_tokens 可能很小
    （时间戳那一块才几个 token），**但真实损失是整段前缀的写入费**——
    因为 lookback 只找之前写过的条目，分歧点之前逐字节相同也不会命中。
    「分歧很小」不等于「损失很小」。
    """
    raise NotImplementedError("TODO 2 未实现")


def cache_verdict(
    shape: ProviderShape,
    usage: dict[str, Any],
    model: str,
    prompt_tokens: int | None = None,
) -> CacheReport:
    """TODO 3：usage 判定器。**这是本节的交付物核心。**

    五态：HIT / WRITE_ONLY / MISS / BELOW_MINIMUM / UNDETERMINABLE。

    五种 provider 的字段形状（全部来自各家官方文档）：

      anthropic                 读 cache_read_input_tokens
                                写 cache_creation_input_tokens
                                ★ input_tokens **只是断点之后的部分**，
                                  总输入 = 三者之和
      openai-responses          读/写在 input_tokens_details 下
                                input_tokens **已含全部**，不要再加
      azure-chat                同上，但在 prompt_tokens_details 下
      deepseek                  读 prompt_cache_hit_tokens
                                ★ **没有写入这个概念**
      anthropic-openai-compat   ★ 缓存字段**恒为空**

    必须满足的性质：

      a. ★ 把 Anthropic 的 input_tokens 当成总输入的实现，会在这里挂。
         而这是最常见的那个错——算出来的命中率偏小，让你以为缓存没用。

      b. ★ anthropic-openai-compat 必须返回 UNDETERMINABLE，**不能返回 MISS**。
         这两个状态混淆是本节最重要的那个 bug。

      c. ★ deepseek 的 write_tokens 应为 0 且 reason 要说明「该 provider 不区分
         写入」，**不能**因此判成 UNDETERMINABLE——它的读字段是有的，能判。

      d. read == 0 且 write == 0 且前缀 < 该模型门槛 → BELOW_MINIMUM。
         注意门槛表里 -1 表示「厂商没公布」，那和「门槛是 0」是两件事。

      e. read == 0 且 write > 0 → WRITE_ONLY。
         ★ 一次是正常的冷启动，**连续两次就是 bug**——这个判断留给上层做，
         但你的 reason 要把这句话说出来。

    ★ 一条纪律：**不要用响应时间判断缓存是否命中。**
    三家官方给的判定法全部是读字段，没有一家建议看时间。
    用时间判断不仅噪声大，它本身就是讲义第八节那条侧信道——
    你在拿攻击手法做监控。
    """
    raise NotImplementedError("TODO 3 未实现")


def simulate_turn(
    hashes: list[str],
    breakpoints: list[int],
    store: list[CacheEntry],
) -> TurnResult:
    """TODO 4：断点写入与 20 格 lookback。

    规则（全部是官方原文）：
      · "Marking a block with `cache_control` writes **exactly one** cache entry"
        —— 写只发生在断点，**不给任何更早的位置写**
      · "The lookback window is 20 blocks. The system checks at most 20 positions
        per breakpoint, **counting the breakpoint itself as the first**."
      · "It is looking for **prior writes**, not for stable content."
      · 断点上限 4，超了官方返回 400

    ★ 必须能复现官方那个三轮例子：
        Turn 1：10 个位置，断点 10 → 写入位置 10
        Turn 2：15 个位置，断点 15 → 往回走命中位置 10，再写位置 15
        Turn 3：35 个位置，断点 35 → 窗口是 16..35，**未命中**
                 （第二轮的条目在 15，正好在窗口外一格）
    这个用例的价值是它来自官方原文，可以当规格用。
    """
    raise NotImplementedError("TODO 4 未实现")


def mixed_ttl_bill(a: int, b: int, c: int, price: Price) -> MixedTtlBill:
    """TODO 5：混合 TTL 的计费。

    官方给的三点式公式，直接实现：
      A = 最高命中处的 token 数（没有命中则为 0）
      B = A 之后最高的 1 小时断点处的 token 数（没有则等于 A）
      C = 最后一个断点处的 token 数
    计费 = A 的读取 + (B−A) 的 1 小时写入 + (C−B) 的 5 分钟写入。

    ★ 还有一条约束要检查：
      "**Cache entries with longer TTL must appear before shorter TTLs**"
    也就是必须 A ≤ B ≤ C，违反了要抛错——因为顺序反了这个账根本算不出来。
    """
    raise NotImplementedError("TODO 5 未实现")


class Limiter:
    """TODO 6：token bucket 限流器。

    ★ 为什么必须是**连续补充**的桶，而不是固定窗口计数。Anthropic 官方原话：
      "a rate of 60 RPM might be enforced as **1 request per second**"
    一个按固定窗口实现的限流器，会在每分钟开头突发 60 个请求然后吃一串 429，
    而它自己的计数器显示「没超」。

    必须满足：
      a. ★ 容量 1、每秒补 1 的桶，在「同一时刻发 60 个」时只放行 1 个。
      b. 按 1 秒 1 个发，60 个全放行。
      c. 拒绝时要给出 retry_after_ms。
      d. ★ 时钟是**注入**的（毫秒整数），不能用 time.time()——否则测试不确定。
      e. ★ 桶内用整数（毫令牌）而不是浮点，理由和金额一样：双语言对拍。

    ★ 还有一条不在这个类里但一定要记住的：**失败的请求也消耗令牌。**
    限额是按请求计的，不是按成功计的。一个「失败不算」的重试循环，
    在限流面前会原地爆炸。
    """

    def __init__(self, opts: LimiterOptions, start_ms: int = 0) -> None:
        raise NotImplementedError("TODO 6 未实现")

    def take(self, now_ms: int) -> LimitOutcome:
        raise NotImplementedError("TODO 6 未实现")


def route_outcome(
    tasks: list[Task],
    router: Router,
    weak: ModelSpec,
    strong: ModelSpec,
    rng: Lcg,
    cached_prefix_tokens: int = 0,
    sticky_every: int = 1,
) -> ref.RouteOutcome:
    """TODO 7：路由的总账。

    把**错分率当输入**（混淆矩阵），算出这个错分率下的成本和质量。

    ★ 为什么不是「训一个路由器」：RouteLLM 用了 8 万条 Chatbot Arena 对战
    数据，训出来的 BERT router 在 GSM8K 上**还是不如随机**。
    90 分钟里训不出比随机强的分类器，而训出一个比随机差的会教出错觉。
    工程师真正要会的那件事是「错分率怎么影响账」。

    必须满足的性质：

      a. ★ **随机路由是基线。** hard_given_hard == hard_given_easy 的路由器
         没有任何信息量，它的曲线必须和随机重合。
         如果你的实现让它看起来更好，是实现错了。

      b. ★ 一个「反着判」的路由器（hard_given_easy > hard_given_hard）必须产出
         **比随机差**的账——对应 RouteLLM 在 GSM8K 上相对随机的 −11.8%。
         **这条性质的存在本身就是在教「路由器可以是负价值的」。**

      c. ★ 重试要算钱。hard 任务被错判到弱模型 → 失败 → 重试到强模型，
         总成本 = 弱模型一次 + 强模型一次，**比直接用强模型更贵**。

      d. ★ 换模型会打掉缓存（cache diagnostics 的 model_changed）。
         给了 cached_prefix_tokens 就要把这一项算进去：同模型 0.1 倍读，
         换模型 1.25 倍写。

      e. ★ sticky_every 控制决策粒度。这是整个路由部分真正的结论所在——
         同一个路由器，粒度不同，结论能反过来。
         注意它不是免费的：粘性路由拿**准确率**换**缓存命中**。

      f. 全部用整数运算。
    """
    raise NotImplementedError("TODO 7 未实现")


if __name__ == "__main__":
    observe()
    print(
        dim("  下一步：实现文件下半部分的七个 TODO，然后跑 uv run python -m l15.verify。\n")
        + dim("  想先确认测试本身是对的，跑 BUDGET_IMPL=shared uv run python -m l15.verify。\n")
    )
    sys.exit(0)
