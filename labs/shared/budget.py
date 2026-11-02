"""参考实现：缓存、路由、限流的**判定与计价**。

这个模块的存在理由，是这一节的中心论点：

    **缓存、路由、批处理这三件事，失败的时候不报错。**

Anthropic 的原话（Prompt caching § Cache limitations）：
    "Any requests to cache fewer than this number of tokens will be
     processed without caching, and **no error is returned**."
DeepSeek 的 Anthropic 兼容表里，`cache_control` 出现四次，四次都是 `Ignored`。
Anthropic 自己的 OpenAI 兼容层：
    "Most unsupported fields are **silently ignored** rather than producing errors."

所以这一节真正要交付的不是「省钱的技巧」，是一套**判定器**：
给定 usage，回答「命中了 / 没命中 / 这个端点根本没法判定」。

★ 注意第三个状态。它不是凑数的——它是兼容层的形状。
一个只有「命中/未命中」两态的判定器，会把「我看不见」报成「没命中」，
然后你去优化一个你根本观测不到的东西。

这个文件是 shared/budget.ts 的镜像，输出逐字节一致。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from .context_budget import estimate_tokens

# ─────────────────────────────────────────────────────────────
# 一、金额：整数定点，不用浮点
# ─────────────────────────────────────────────────────────────

# ★ 为什么不用浮点：这门课要求 TS 和 Python 的输出**逐字节一致**。
#
# 而两种语言在 toFixed / round 上的行为不一样（banker's rounding 的边界、
# -0 的印法、大数的位数策略），一个 0.5 的舍入方向差异就能让对拍失败，
# 而且失败信息会指向一个完全无关的地方。
#
# Python 这边还有一个额外的坑：`round()` 用的是**银行家舍入**
# （round(0.5) == 0、round(1.5) == 2），而 JS 的 Math.round 是四舍五入。
# 同一行代码，同一个输入，两个答案。
#
# 所以：**金额全程整数**。
#
# 单位约定：
#   · 价格用「微分 / 百万 token」表示，微分 = 1e-8 元。即 1 元/M 记作 100_000_000。
#   · 账目累加的是 `tokens × 微分每兆`，单位是「微分 × 1e6」。
#     这个量不除，一路累加到最后再一次性格式化——中间不做任何除法，
#     也就不产生任何舍入。


@dataclass(frozen=True)
class Price:
    """单位：微分 / 百万 token（微分 = 1e-8 元）。"""

    # 未命中的输入单价。所有倍率都以它为基准。
    input_miss: int
    # 输出单价。
    output: int


@dataclass(frozen=True)
class Mult:
    num: int
    den: int


# 倍率，而不是绝对价格。
#
# ★ 这是刻意的取舍。绝对价格三个月变一次（调研里就有三个
# "through December 31, 2026" 的限时价），一张过期的比价表比没有表更糟。
# 而**倍率稳定得多，并且倍率才是做决策用的东西**。
#
# 数字来自 Anthropic 官方定价页（抓取 2026-09-15）：
#   "5-minute cache write tokens are **1.25 times** the base input tokens price"
#   "1-hour cache write tokens are **2 times** the base input tokens price"
#   "Cache read tokens are **0.1 times** the base input tokens price"
CACHE_READ = Mult(1, 10)
"""缓存读。未命中 : 命中 = 10 : 1。"""

CACHE_WRITE_5M = Mult(125, 100)
"""5 分钟缓存写。**比不开缓存还贵 25%**——这是那个「断点放错位置」的坑的代价。"""

CACHE_WRITE_1H = Mult(2, 1)
"""1 小时缓存写。"""

BATCH = Mult(1, 2)
"""Batch API 折扣。"""

FAST = Mult(2, 1)
"""fast mode。买的是延迟，付的是钱。"""

NO_MULT = Mult(1, 1)


def charge(tokens: int, price: int, mult: Mult = NO_MULT) -> int:
    """一笔账：token 数 × 单价 × 倍率。

    返回「微分 × 1e6」，不除。★ 倍率的除法也留到最后——先乘 num 再除 den
    会引入舍入，而这里的 den 是 10 / 100 / 2 这种小数，连续几笔累加之后
    舍入误差刚好能让两种语言分道扬镳。
    """
    if not isinstance(tokens, int) or isinstance(tokens, bool) or tokens < 0:
        raise ValueError(f"token 数必须是非负整数，收到 {tokens!r}")
    # 全为非负，所以 // 的向下取整等于 JS BigInt 除法的向零取整。
    return tokens * price * mult.num // mult.den


def yuan(p: int, dp: int = 6) -> str:
    """把「微分 × 1e6」格式化成元。

    ★ 手写定点输出，不用 f-string 的浮点格式。dp 位小数，向零截断
    （不是四舍五入）——截断的方向在两种语言里没有歧义，而四舍五入有。
    """
    scale = 10 ** (14 - dp)
    neg = p < 0
    scaled = (-p if neg else p) // scale
    s = str(scaled).zfill(dp + 1)
    i = s[: len(s) - dp]
    frac = s[len(s) - dp :]
    return f"{'-' if neg else ''}{i}" + (f".{frac}" if dp > 0 else "")


# ─────────────────────────────────────────────────────────────
# 二、canonical_json：一个函数干两件事
# ─────────────────────────────────────────────────────────────


def _esc(s: str) -> str:
    """字符串转义。

    ★ 为什么不直接用 `json.dumps`：它和 JS 的 `JSON.stringify` 在转义策略上
    不保证一致（`json.dumps` 默认把非 ASCII 转成 `\\uXXXX`，分隔符默认是
    `", "` 和 `": "`）。这个函数的全部意义就是**同样的语义产生同样的字节**，
    所以它自己不能建立在一个各语言可以自由选择的行为上。
    """
    out = ['"']
    for ch in s:
        c = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif c < 0x20:
            out.append(f"\\u{c:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonical_json(v: Any) -> str:
    """规范化序列化：键排序、分隔符固定、数字格式固定。

    ★ 这个函数是这一节最划算的二十行，因为它同时解决两个**看起来毫不相关**
    的问题：

      1. 让 verify 的双语言对拍能过。
      2. 让你的工具定义**可缓存**。这是 Anthropic 官方的原话：
         "Verify that the keys in your `tool_use` content blocks have stable
          ordering as **some languages (for example, Swift, Go) randomize key
          order during JSON conversion, breaking caches**."
         以及 cache diagnostics 里 `tools_changed` 的成因之一：
         "tool `input_schema` JSON was **serialized non-deterministically**."

    也就是说：**你为了让测试两边一致而必须做的事，正好就是让缓存命中必须做的事。**
    这不是巧合——两者要的是同一个性质：同样的语义产生同样的字节。
    """
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        # ★ 只接受整数。非整数的 str() 在两种语言里策略不同，而 schema 里
        # 根本用不上浮点——**拒绝**比悄悄产生一个不一致的字节串好得多。
        raise ValueError(
            f"canonical_json 不接受非整数 {v}——"
            "它在两种语言里印法可能不同。用字符串或整数。"
        )
    if isinstance(v, str):
        return _esc(v)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonical_json(x) for x in v) + "]"
    if isinstance(v, dict):
        body = ",".join(f"{_esc(k)}:{canonical_json(v[k])}" for k in sorted(v.keys()))
        return "{" + body + "}"
    raise ValueError(f"canonical_json 不认识的类型：{type(v).__name__}")


# ─────────────────────────────────────────────────────────────
# 三、请求结构
# ─────────────────────────────────────────────────────────────

# 前缀的三层，顺序是**写死的**，不是我们选的。
#
# Anthropic 原文：
#   "Cache prefixes are created in the following order: `tools`, `system`,
#    then `messages`. This order forms a hierarchy where each level builds
#    upon the previous ones."
#   "**Changes at each level invalidate that level and all subsequent levels.**"
#
# 这一条决定了 first_divergence 为什么只报最早的那一层。
Layer = Literal["model", "tools", "system", "messages"]

LAYER_ORDER: tuple[Layer, ...] = ("model", "tools", "system", "messages")


@dataclass(frozen=True)
class Block:
    type: str
    text: str | None = None
    # 显式断点。Anthropic 的 cache_control: {type: 'ephemeral', ttl?: '1h'}。
    cache_control_ttl: Literal["5m", "1h"] | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ToolDef:
    name: str
    description: str
    input_schema: Any


@dataclass(frozen=True)
class Req:
    model: str
    tools: tuple[ToolDef, ...]
    system: tuple[Block, ...]
    messages: tuple[Block, ...]


def block_tokens(b: Block) -> int:
    """一个块的 token 数。用 L08 那个显式粗估，不用 tiktoken（理由见 context_budget.py）。"""
    # ★ 不能只算 text。tool_use 的 input 和 tool_result 的 content 往往是
    # 上下文里最大的两块，漏掉它们会让预算系统性偏小（L08 那条纪律）。
    n = estimate_tokens(b.type)
    if b.text:
        n += estimate_tokens(b.text)
    if b.extra:
        n += estimate_tokens(canonical_json(b.extra))
    return n


def tool_tokens(t: ToolDef) -> int:
    return (
        estimate_tokens(t.name)
        + estimate_tokens(t.description)
        + estimate_tokens(canonical_json(t.input_schema))
    )


def prefix_tokens(r: Req) -> int:
    """整个前缀的 token 数，按 tools → system → messages 的顺序。"""
    return (
        sum(tool_tokens(t) for t in r.tools)
        + sum(block_tokens(b) for b in r.system)
        + sum(block_tokens(b) for b in r.messages)
    )


# ─────────────────────────────────────────────────────────────
# 四、前缀失效定位器
# ─────────────────────────────────────────────────────────────

DivergenceType = Literal[
    "model_changed",
    "tools_changed",
    "system_changed",
    "messages_changed",
    "previous_message_not_found",
]


@dataclass(frozen=True)
class Divergence:
    """对标 Anthropic 的 cache diagnostics（beta header cache-diagnosis-2026-04-07）。

    type 的取值直接照搬官方的 cache_miss_reason.type。
    """

    type: DivergenceType
    at: int | None
    cache_missed_tokens: int


def _canonical_tool(t: ToolDef) -> str:
    """★ 工具的规范化里**故意包含顺序无关的字段全部排序，但不排序工具本身**。

    因为官方把「重排」明确列为失效原因：
      "tools were added, removed, or **reordered** between turns"
    也就是说：内容完全相同、只是顺序不同的两份工具清单，**缓存判定为不同**。
    这正是 L10 那个坑——tools/list 的顺序不稳定，账单上只表现为「input 变贵了」。
    """
    return canonical_json(
        {"name": t.name, "description": t.description, "inputSchema": t.input_schema}
    )


def _first_diff_index(a: list[str], b: list[str], append_is_benign: bool) -> int | None:
    """第一处不同的下标。

    append_is_benign 只对整条前缀的**最后一层**为真（见 first_divergence 里的注释）。

    ★ 另一个方向也要注意：curr 比 prev **短**（截断）永远是分歧。
    追加和截断在 agent 里都很常见——追加是正常对话，截断是上下文压缩——
    而它们对缓存的后果**完全相反**。把两者等同处理的实现，会把每一次
    上下文压缩都报成「一切正常」，然后你看着成本上去却找不到原因。
    这正是 L08 那节压缩策略要付的隐性代价。
    """
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return i
    if len(b) == len(a):
        return None
    if len(b) < len(a):
        return len(b)  # 截断
    return None if append_is_benign else len(a)  # 追加


def _missed_from(r: Req, layer: str, at: int) -> int:
    """分歧点之后（含）的 token 数。这是你这次要重新付钱的量。"""
    tools_n = sum(tool_tokens(t) for t in r.tools)
    sys_n = sum(block_tokens(b) for b in r.system)
    msg_n = sum(block_tokens(b) for b in r.messages)

    if layer == "tools":
        before = sum(tool_tokens(t) for t in r.tools[:at])
        return tools_n - before + sys_n + msg_n
    if layer == "system":
        before = sum(block_tokens(b) for b in r.system[:at])
        return sys_n - before + msg_n
    before = sum(block_tokens(b) for b in r.messages[:at])
    return msg_n - before


def first_divergence(prev: Req, curr: Req) -> Divergence | None:
    """找出**最早**的分歧点。

    ★ 「最早」这三个字是全部的重点。官方原文：
      "The response reports the **earliest divergence only**."
    因为哈希是累积的：
      "Because the hash is cumulative, covering everything up to and including
       the breakpoint, **changing any block at or before the breakpoint produces
       a different hash** on the next request."
    所以第一处分歧之后的一切都已经失效了，再往后找没有意义——
    一个把所有差异都列出来的实现不是更详细，是**没搞懂层级**。

    返回 None 表示没有分歧（追加不算分歧）。
    """
    total = prefix_tokens(curr)

    # 换模型：整个缓存都不能用，而且**不再检查其它层**。
    # 官方：cache diagnostics 有专门的 model_changed 类型，"The cache is per-model."
    if prev.model != curr.model:
        return Divergence("model_changed", None, total)

    # ★ 空历史是一个独立的状态，不是 messages_changed。
    # 官方的 previous_message_not_found 对应的就是「上一轮压根不在缓存里」。
    if not prev.tools and not prev.system and not prev.messages:
        return Divergence("previous_message_not_found", None, total)

    # ★★ 注意这三次调用的最后一个参数。
    # 「追加不算分歧」**只在最后一层成立**。
    #
    # 往 messages 末尾追加一条，加的是整条前缀的末尾，前面每个位置的
    # 累积哈希都不变——所以不是分歧。
    # 但往**工具清单**末尾加一个工具，在整条前缀里是**中间插入**：
    # tools 排在 system 和 messages 前面，加一个工具会把后面所有东西位移，
    # 于是 system 和 messages 上的每个断点哈希全变。
    #
    # 这一条正好对上官方把「added」和「reordered」并列的措辞：
    #   "tools were **added, removed, or reordered** between turns"
    # 加一个工具和重排工具，后果是一样的——整个缓存作废。
    tools_at = _first_diff_index(
        [_canonical_tool(t) for t in prev.tools],
        [_canonical_tool(t) for t in curr.tools],
        False,
    )
    if tools_at is not None:
        return Divergence("tools_changed", tools_at, _missed_from(curr, "tools", tools_at))

    sys_at = _first_diff_index(
        [canonical_json_block(b) for b in prev.system],
        [canonical_json_block(b) for b in curr.system],
        False,
    )
    if sys_at is not None:
        return Divergence("system_changed", sys_at, _missed_from(curr, "system", sys_at))

    msg_at = _first_diff_index(
        [canonical_json_block(b) for b in prev.messages],
        [canonical_json_block(b) for b in curr.messages],
        True,
    )
    if msg_at is not None:
        return Divergence("messages_changed", msg_at, _missed_from(curr, "messages", msg_at))

    return None


def canonical_json_block(b: Block) -> str:
    """★ 和 TS 侧对齐：把 Block 摊平成一个 dict 再规范化。

    TS 那边 Block 就是一个带 index signature 的对象，所以它的 canonicalJson
    直接看到 {type, text, ...extra}。Python 这边 Block 是 dataclass，必须
    显式摊平，否则两种语言算出的「块是否相同」会不一致——而那会让缓存
    判定在一种语言里过、另一种语言里不过。
    """
    d: dict[str, Any] = {"type": b.type}
    if b.text is not None:
        d["text"] = b.text
    d.update(b.extra)
    return canonical_json(d)


# ─────────────────────────────────────────────────────────────
# 五、最低可缓存长度
# ─────────────────────────────────────────────────────────────

# ★ 这张表的形状是反直觉的：**不是模型越小门槛越低，也不随版本单调。**
#
# 官方清单（Prompt caching，抓取 2026-09-15），节选：
#   512  —— Fable 5.1 / Mythos 5.1 / Opus 5 / Fable 5 / Mythos 5
#   1024 —— Opus 4.8 / Sonnet 5 / Sonnet 4.6 / Sonnet 4.5 / Opus 4.1 / Opus 4 / Sonnet 4
#   2048 —— Mythos Preview / Opus 4.7 / Haiku 3.5
#   4096 —— Opus 4.6 / Opus 4.5 / **Haiku 4.5**
#
# 注意 Haiku 4.5 是 4096，比 Opus 5 的 512 高八倍。
#
# ★ 这就是「模型路由」和「prompt caching」正面打架的地方：
# 你把简单任务路由到便宜的 Haiku 4.5 省钱，结果那个 1500-token 的
# system prompt 在 Haiku 上**根本不够门槛**，于是每次全价——
# 而它在 Opus 5 上是命中的。**路由省下的钱可能小于丢掉的缓存。**
MIN_CACHEABLE: dict[str, int] = {
    "claude-fable-5-1": 512,
    "claude-mythos-5-1": 512,
    "claude-opus-5": 512,
    "claude-opus-4-8": 1024,
    "claude-sonnet-5": 1024,
    "claude-sonnet-4-6": 1024,
    "claude-opus-4-7": 2048,
    "claude-haiku-3-5": 2048,
    "claude-opus-4-6": 4096,
    "claude-opus-4-5": 4096,
    "claude-haiku-4-5": 4096,
    # 本课用的兼容端点：DeepSeek 自动缓存，官方没有公布门槛。
    # ★ 「没公布」不等于「没有」。写 0 会让判定器把「低于门槛」误判成「命中失败」。
    "deepseek-v4-flash": -1,
    "deepseek-v4-pro": -1,
}


def min_cacheable(model: str) -> int:
    """返回 -1 表示该 provider 没公布门槛——**这和「门槛是 0」是两件事**。"""
    return MIN_CACHEABLE.get(model, -1)


# ─────────────────────────────────────────────────────────────
# 六、usage 四态判定器
# ─────────────────────────────────────────────────────────────

ProviderShape = Literal[
    "anthropic",
    "openai-responses",
    "azure-chat",
    "deepseek",
    "anthropic-openai-compat",
]

Verdict = Literal["HIT", "WRITE_ONLY", "MISS", "BELOW_MINIMUM", "UNDETERMINABLE"]


@dataclass(frozen=True)
class CacheReport:
    verdict: Verdict
    read_tokens: int
    write_tokens: int
    # 整个请求的输入 token 总数。★ 注意它在 Anthropic 上不等于 input_tokens。
    total_input: int
    reason: str


def _n0(v: Any) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) else 0


def cache_verdict(
    shape: ProviderShape,
    usage: dict[str, Any],
    model: str,
    prompt_tokens: int | None = None,
) -> CacheReport:
    """判定缓存到底生效了没有。

    判定规则来自三条官方陈述：

      A（Anthropic）："if both `cache_creation_input_tokens` and
         `cache_read_input_tokens` are 0, the prompt was not cached"
      B（OpenAI）："When `cached_tokens` is greater than zero and
         `cache_write_tokens` is zero, your request fully matched an existing
         cache entry — no new writes occurred"
      C（Anthropic fast mode）：usage 里带 speed 字段回报实际用的档位——
         同构的「静默降级检测」。

    ★ 官方的判定法**全部是读字段，没有一家建议看响应时间**。
    用 TTFT 判断缓存是错的：噪声大，而且那正是第八节要讲的那条侧信道——
    你在教自己用攻击手法做监控。
    """
    read = 0
    write = 0
    total = 0
    fields_present = False
    no_write_concept = False

    if shape == "anthropic":
        read = _n0(usage.get("cache_read_input_tokens"))
        write = _n0(usage.get("cache_creation_input_tokens"))
        fields_present = usage.get("cache_read_input_tokens") is not None
        # ★★ 这一行是这个函数里最容易写错的一行。
        # Anthropic 的 input_tokens **只是最后一个断点之后的 token 数**，
        # 不是总输入。总输入 = input_tokens + cache_read + cache_creation。
        # 一个直接把 input_tokens 当总输入的实现，会把命中率算成一个
        # 看起来合理但完全错误的数字（而且是偏小的方向——显得缓存没用）。
        total = _n0(usage.get("input_tokens")) + read + write

    elif shape == "openai-responses":
        d = usage.get("input_tokens_details") or {}
        read = _n0(d.get("cached_tokens"))
        write = _n0(d.get("cache_write_tokens"))
        fields_present = isinstance(d.get("cached_tokens"), int)
        # OpenAI 的 input_tokens **已经包含**缓存部分，不要再加。
        total = _n0(usage.get("input_tokens"))

    elif shape == "azure-chat":
        d = usage.get("prompt_tokens_details") or {}
        read = _n0(d.get("cached_tokens"))
        write = _n0(d.get("cache_write_tokens"))
        fields_present = isinstance(d.get("cached_tokens"), int)
        total = _n0(usage.get("prompt_tokens"))

    elif shape == "deepseek":
        read = _n0(usage.get("prompt_cache_hit_tokens"))
        write = 0
        # ★ DeepSeek **没有「缓存写入」这个概念**——它的缓存是自动的，
        # 不区分写入阶段。所以 write=0 是正确答案，不是「缺数据」。
        # 把它判成 UNDETERMINABLE 是错的：它的 read 字段是有的，能判。
        no_write_concept = True
        fields_present = "prompt_cache_hit_tokens" in usage
        total = _n0(usage.get("prompt_cache_hit_tokens")) + _n0(
            usage.get("prompt_cache_miss_tokens")
        )

    else:  # anthropic-openai-compat
        # ★ Anthropic 自己的 OpenAI 兼容层：
        #   "`usage.prompt_tokens_details`: **Always empty**"
        # 也就是说，唯一能告诉你缓存有没有生效的信号**被这条端点擦掉了**。
        # 这不是「没命中」，是「不可知」。
        return CacheReport(
            verdict="UNDETERMINABLE",
            read_tokens=0,
            write_tokens=0,
            total_input=_n0(usage.get("prompt_tokens")),
            reason=(
                "这条端点的 usage.prompt_tokens_details 恒为空"
                '（Anthropic 官方原话 "Always empty"）——'
                "缓存可能在跑也可能没跑，但你从响应里看不出来。不要把它当成未命中去"
                '"优化"。'
            ),
        )

    if not fields_present:
        return CacheReport(
            verdict="UNDETERMINABLE",
            read_tokens=0,
            write_tokens=0,
            total_input=total,
            reason=(
                "响应里没有缓存字段。可能是兼容层剥掉了，也可能是 SDK 版本旧——"
                "但都不能当作未命中。"
            ),
        )

    if read > 0:
        # ★ 百分比也走整数：*1000 取整再 /10，避免两种语言的浮点印法差异。
        pct_tenths = (read * 1000 + total // 2) // total if total > 0 else 0
        pct = f"{pct_tenths // 10}.{pct_tenths % 10}"
        tail = "，同时写了新断点" if write > 0 else "，无新写入——这是最省的形状"
        return CacheReport(
            verdict="HIT",
            read_tokens=read,
            write_tokens=write,
            total_input=total,
            reason=f"命中 {read}/{total} token（{pct}%）{tail}",
        )

    if write > 0:
        return CacheReport(
            verdict="WRITE_ONLY",
            read_tokens=0,
            write_tokens=write,
            total_input=total,
            reason=(
                f"只写不读 {write} token。★ 第一次是正常的，**连续两次就是 bug**——"
                "你在每次请求都付 1.25 倍的写入费而一次读都没拿到，比不开缓存还贵 25%。"
                "最常见的成因是断点后面挂了个每次都变的东西（时间戳、随机 id）。"
            ),
        )

    floor = min_cacheable(model)
    if floor > 0 and prompt_tokens is not None and prompt_tokens < floor:
        return CacheReport(
            verdict="BELOW_MINIMUM",
            read_tokens=0,
            write_tokens=0,
            total_input=total,
            reason=(
                f"前缀 {prompt_tokens} token < {model} 的最低门槛 {floor}。"
                'Anthropic 官方："processed without caching, and **no error is returned**"。'
                "★ 这不是你的代码写错了，是这段前缀太短，不值得缓存——加断点也没用。"
            ),
        )

    return CacheReport(
        verdict="MISS",
        read_tokens=0,
        write_tokens=0,
        total_input=total,
        reason=(
            "未命中。该 provider 不区分缓存写入，所以 write=0 是正常的，不代表缺数据。"
            if no_write_concept
            else (
                "未命中，且没有写入。前缀变了或者缓存已过期——"
                "用 first_divergence 区分这两种，它们要采取的行动完全不同。"
            )
        ),
    )


# ─────────────────────────────────────────────────────────────
# 七、断点与 lookback：一个状态机
# ─────────────────────────────────────────────────────────────

# ★ 这一节要纠正一个极其常见的误解，Anthropic 专门写了一节叫 "Common mistake"：
#
#   "Cache reads look backward for entries that prior requests wrote. …
#    **It is looking for prior writes, not for stable content.**"
#   "**The lookback does not find stable content behind your breakpoint and
#    cache it.** It finds entries that prior requests already wrote, and
#    writes happen only at breakpoints."
#
# 换句话说：lookback 不会帮你找「看起来稳定的内容」。它只找**之前写过的条目**。
# 断点放在一个每次都变的块上，结果就是官方原文里那句：
#   "**You pay for a fresh cache write on every request and never get a read.**"
#
# 代价是 +25%，而日志上完全正常。
LOOKBACK = 20
MAX_BREAKPOINTS = 4


@dataclass
class CacheEntry:
    # 写在第几个位置（1-based，和官方例子对齐）。
    position: int
    # 前缀哈希。这里用规范化字符串代替真哈希——性质一样，且可读。
    hash: str


@dataclass(frozen=True)
class TurnResult:
    hit_at: int | None
    wrote_at: int | None
    fresh_blocks: int
    note: str


def merge_positions(blocks: list[Block]) -> list[Block]:
    """把连续的 tool_use / tool_result 归并成一个位置。

    ★ 归并规则来自官方：
      "a run of consecutive `tool_use` blocks counts as one position, and so
       does a run of consecutive `tool_result` blocks, so a turn with many
       parallel tool calls doesn't push the previous request's entry out of
       the window on its own."
    不做这个归并，一次 8 个并行工具调用就能把上一轮的条目挤出窗口——
    而真实系统不会。
    """
    out: list[Block] = []
    for b in blocks:
        runnable = b.type in ("tool_use", "tool_result")
        if out and runnable and out[-1].type == b.type:
            continue
        out.append(b)
    return out


def simulate_turn(
    hashes: list[str],
    breakpoints: list[int],
    store: list[CacheEntry],
) -> TurnResult:
    """模拟一轮的缓存读写。

    hashes 是**归并后**的位置序列，每个元素是该位置的累积前缀哈希。
    breakpoints 是 1-based 的断点位置。store 会被这次的写入原地更新。
    """
    if len(breakpoints) > MAX_BREAKPOINTS:
        raise ValueError(
            f"断点 {len(breakpoints)} 个，上限 {MAX_BREAKPOINTS}。"
            "Anthropic 官方：超了会返回 400，而且自动缓存也要占一个名额。"
        )
    if not breakpoints:
        return TurnResult(None, None, len(hashes), "没有断点，不写也不读")
    bp = breakpoints[-1]

    # 读：从断点开始往回走，最多 LOOKBACK 个位置（含断点自己）。
    hit_at: int | None = None
    for i in range(LOOKBACK):
        pos = bp - i
        if pos < 1:
            break
        if pos - 1 < len(hashes):
            h = hashes[pos - 1]
            if any(e.position == pos and e.hash == h for e in store):
                hit_at = pos
                break

    # 写：**只在断点上写一个条目**。不给任何更早的位置写。
    wrote_at: int | None = None
    if bp - 1 < len(hashes):
        bp_hash = hashes[bp - 1]
        if not any(e.position == bp and e.hash == bp_hash for e in store):
            store.append(CacheEntry(bp, bp_hash))
            wrote_at = bp

    fresh = len(hashes) if hit_at is None else len(hashes) - hit_at
    note = (
        f"未命中：窗口内（位置 {max(1, bp - LOOKBACK + 1)}–{bp}）没有之前写过的条目"
        if hit_at is None
        else f"命中于位置 {hit_at}，只需新算 {fresh} 个位置"
    )
    return TurnResult(hit_at, wrote_at, fresh, note)


# ─────────────────────────────────────────────────────────────
# 八、混合 TTL 计费
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class MixedTtlBill:
    read_tokens: int
    write_1h_tokens: int
    write_5m_tokens: int
    picofen: int


def mixed_ttl_bill(a: int, b: int, c: int, price: Price) -> MixedTtlBill:
    """官方给的三点式公式，直接实现。原文：

      "1. Position `A`: The token count at the highest cache hit (or 0 if no hits).
       2. Position `B`: The token count at the highest 1-hour `cache_control`
          block after `A` (or equals `A` if none exist).
       3. Position `C`: The token count at the last `cache_control` block.
       You'll be charged for:
       1. Cache read tokens for `A`.
       2. 1-hour cache write tokens for `(B - A)`.
       3. 5-minute cache write tokens for `(C - B)`."

    以及那条约束：
      "**Cache entries with longer TTL must appear before shorter TTLs**"
    """
    if not (a <= b <= c):
        raise ValueError(
            f"位置必须满足 A ≤ B ≤ C，收到 A={a} B={b} C={c}。"
            "Anthropic 官方约束：1 小时的条目必须排在 5 分钟的前面。顺序反了，这个账就算不出来。"
        )
    read = a
    w1h = b - a
    w5m = c - b
    return MixedTtlBill(
        read_tokens=read,
        write_1h_tokens=w1h,
        write_5m_tokens=w5m,
        picofen=(
            charge(read, price.input_miss, CACHE_READ)
            + charge(w1h, price.input_miss, CACHE_WRITE_1H)
            + charge(w5m, price.input_miss, CACHE_WRITE_5M)
        ),
    )


# ─────────────────────────────────────────────────────────────
# 九、确定性随机：自己写的 LCG
# ─────────────────────────────────────────────────────────────


class Lcg:
    """★ 不能用 random.random()：即使同种子，两种语言的序列也不同。

    退避的 jitter 需要随机，而 verify 需要确定——唯一的出路是自己实现一个
    两边逐位一致的。数值参数取自 Numerical Recipes 的 32 位 LCG。
    """

    def __init__(self, seed: int = 1) -> None:
        self._s = seed & 0xFFFFFFFF

    def next(self) -> int:
        """下一个 32 位无符号整数。"""
        self._s = (self._s * 1664525 + 1013904223) & 0xFFFFFFFF
        return self._s

    def int(self, n: int) -> int:
        """[0, n) 的整数。

        ★★ 这里**不能写 `next() % n`**，而这个坑值得单独记一笔。

        线性同余发生器的**低位周期极短**：模 2^32 的 LCG，第 k 位的周期只有
        2^(k+1)——最低位就是 0、1、0、1 地交替。而 `% 2` 取的正好是最低位。

        后果：拿它给一个「一半 easy 一半 hard」的任务列表做路由决策时，
        任务的奇偶和随机数的奇偶完全同步，于是「随机路由」和「反着判的路由」
        算出来**一模一样的账**。曲线看着挺像那么回事，结论是错的。

        正确做法是用**高位**：把 32 位随机数当成 [0,1) 的定点小数去乘 n，
        再右移 32 位。全程整数，两种语言逐位一致。
        """
        if n <= 0:
            raise ValueError("上界必须为正")
        return (self.next() * n) >> 32


# ─────────────────────────────────────────────────────────────
# 十、限流：token bucket
# ─────────────────────────────────────────────────────────────

# 1 令牌 = 1000 毫令牌。★ 桶也走整数，理由和金额一样：双语言对拍。
_MILLI = 1000


@dataclass(frozen=True)
class LimiterOptions:
    # 桶容量。
    capacity: int
    # 每秒补充多少令牌。60 RPM → 1。
    refill_per_sec: int


@dataclass(frozen=True)
class LimitOutcome:
    allowed: bool
    tokens: str
    retry_after_ms: int = 0


class Limiter:
    """★ 为什么是连续补充的桶，而不是固定窗口。Anthropic 官方原文：

      "a rate of 60 RPM might be enforced as 1 request per second"

    也就是说 **60 RPM 不等于「这一分钟里随便怎么发 60 个」**。
    一个按固定窗口实现的客户端限流器，会在每分钟开头突发 60 个请求，
    然后拿到一串 429——而它自己的计数器显示「没超」。
    """

    def __init__(self, opts: LimiterOptions, start_ms: int = 0) -> None:
        self._opts = opts
        # 单位：毫令牌。整数。
        self._milli = opts.capacity * _MILLI
        # ★ 注入的时钟，毫秒整数。不用 time.time()——那样测试就不确定了。
        self._last_ms = start_ms

    @property
    def level(self) -> str:
        """当前令牌数，保留三位小数的字符串。★ 不返回浮点，免得两种语言印得不一样。"""
        return f"{self._milli // _MILLI}.{self._milli % _MILLI:03d}"

    def take(self, now_ms: int) -> LimitOutcome:
        """尝试取一个令牌。

        ★ 注意这个方法**没有「请求成功了吗」这个参数**，这是故意的：
        失败的请求也消耗令牌。官方明确说明限额是按**请求**计的，不是按成功计的。
        一个「失败不算」的重试循环会在限流面前原地爆炸。
        """
        elapsed = now_ms - self._last_ms
        if elapsed < 0:
            raise ValueError("时钟倒流了。注入的时钟必须单调不减。")
        # elapsed(ms) × refill(令牌/秒) 正好就是毫令牌数——整数乘法，无舍入。
        self._milli = min(
            self._opts.capacity * _MILLI, self._milli + elapsed * self._opts.refill_per_sec
        )
        self._last_ms = now_ms

        if self._milli >= _MILLI:
            self._milli -= _MILLI
            return LimitOutcome(allowed=True, tokens=self.level)
        need_milli = _MILLI - self._milli
        return LimitOutcome(
            allowed=False,
            tokens=self.level,
            # 向上取整：差一点也要等满。整数除法写成 ceil 的等价形式。
            retry_after_ms=-(-need_milli // self._opts.refill_per_sec),
        )


OverLimitKind = Literal["rate", "spend_limit", "self_imposed"]
"""超限有三种，**要采取的行动完全不同**。

把它们混为一谈是这一节最贵的 bug：对一个「花费上限已到」的错误做指数退避
重试，你会在那里转到超时，而它永远不会成功。
"""


def should_retry(kind: OverLimitKind) -> bool:
    # ★ 只有真正的速率限制值得重试。
    return kind == "rate"


def backoff_ms(attempt: int, rng: Lcg, base_ms: int = 500, cap_ms: int = 30_000) -> int:
    """带 jitter 的指数退避。jitter 用 LCG，所以 verify 里是确定的。"""
    exp = min(cap_ms, base_ms * 2**attempt)
    # full jitter：[0, exp)。官方推荐加抖动以免重试自己形成尖峰。
    return rng.int(exp)


# ─────────────────────────────────────────────────────────────
# 十一、路由：成本与质量两条曲线
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Router:
    """★ 路由器是一个**分类器**，所以它会错分。

    而这一节的教学目标不是「训一个路由器」——RouteLLM 用了 8 万条 Chatbot
    Arena 对战数据，训出来的 BERT router 在 GSM8K 上**还是不如随机**。

    所以这里把**错分率当输入**，让你算「这个错分率下账变成什么样」。
    这才是工程师要会的那件事。
    """

    # P(判为 hard | 真的 hard)。用整数分数，不用浮点。
    hard_given_hard: Mult
    # P(判为 hard | 其实 easy)。
    hard_given_easy: Mult


@dataclass(frozen=True)
class Task:
    id: str
    true_difficulty: Literal["easy", "hard"]
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class ModelSpec:
    model: str
    price: Price


@dataclass(frozen=True)
class RouteOutcome:
    # 总花费。
    picofen: int
    # 答对的任务数 / 总数。
    solved: int
    total: int
    # 因为错判到弱模型、失败后重试到强模型的次数。
    retries: int
    # 因为换模型而打掉的缓存次数。
    cache_breaks: int
    # 前缀命中的次数。cache_breaks + prefix_reads 才是前缀被计费的总次数。
    prefix_reads: int


def route_outcome(
    tasks: list[Task],
    router: Router,
    weak: ModelSpec,
    strong: ModelSpec,
    rng: Lcg,
    cached_prefix_tokens: int = 0,
    sticky_every: int = 1,
) -> RouteOutcome:
    """算一遍这个路由器下的总账。

    ★ 三条容易漏的，每一条都改变结论：

      1. **重试要算钱。** 一个 hard 任务被错判到弱模型 → 失败 → 重试到强模型，
         总成本 = 弱模型一次 + 强模型一次，**比直接用强模型更贵**。
         路由省钱的前提是错分率足够低，不是「便宜模型单价低」。

      2. **换模型会打掉缓存。** cache diagnostics 有专门的 model_changed。
         一个在两个模型之间来回跳的路由器，缓存命中率是 0。

      3. **基线是随机路由，不是「全用便宜模型」。** 一个
         hard_given_hard == hard_given_easy 的路由器没有任何信息量，
         它的曲线必须和随机重合——如果你的实现让它看起来更好，是实现错了。

    cached_prefix_tokens 给了非 0 值，这个函数才会把**缓存**算进账里，
    而这一项常常反转结论。不给就只算任务本身的 token——那是大多数
    「路由能省 N 倍」的文章算的账，也是它们把收益算高的地方。

    sticky_every 是每隔多少个任务才重新做一次路由决策（决策在块内保持）。

    ★ 这个参数是这一节路由部分真正的结论所在。

    1 = 每个请求都重新选模型。在有大共享前缀的场景下这是灾难：
    每次换模型都是一次 model_changed，整段前缀重新全价写入，
    而前缀往往比任务本身大一个数量级。

    10 = 按会话粒度路由。同一个会话里不换模型，于是前缀写一次读九次。

    所以「路由能不能省钱」这个问题问得不对。该问的是
    **「在哪个粒度上路由」**——同一个路由器，粒度不同，结论能反过来。
    """
    if sticky_every < 1:
        raise ValueError("sticky_every 至少是 1")
    picofen = 0
    solved = 0
    retries = 0
    cache_breaks = 0
    prefix_reads = 0
    last_model: str | None = None
    # 块内保持的决策。
    held: bool | None = None

    def prefix_charge(model: str, price: Price) -> int:
        """算一次前缀的钱：和上一次同模型就是命中，否则是写入。"""
        nonlocal cache_breaks, prefix_reads
        if cached_prefix_tokens == 0:
            return 0
        if last_model == model:
            prefix_reads += 1
            return charge(cached_prefix_tokens, price.input_miss, CACHE_READ)
        if last_model is not None:
            cache_breaks += 1
        return charge(cached_prefix_tokens, price.input_miss, CACHE_WRITE_5M)

    for i, t in enumerate(tasks):
        # ★ 只在块的第一个任务上做决策，块内沿用。
        # 注意副作用：块内那些「真实难度和块首不同」的任务会被放到错的模型上——
        # 粘性路由用**准确率**换**缓存命中**，不是免费的。
        if i % sticky_every == 0 or held is None:
            p = router.hard_given_hard if t.true_difficulty == "hard" else router.hard_given_easy
            # 判为 hard 的概率 = p.num / p.den。用 LCG 取整数比较，不引入浮点。
            roll = rng.int(p.den)
            held = roll < p.num
        to_strong = held
        chosen = strong if to_strong else weak

        picofen += prefix_charge(chosen.model, chosen.price)
        last_model = chosen.model
        picofen += charge(t.input_tokens, chosen.price.input_miss) + charge(
            t.output_tokens, chosen.price.output
        )

        if t.true_difficulty == "easy" or to_strong:
            # easy 任务弱模型也能做对；hard 任务上了强模型也做对。
            solved += 1
            continue

        # hard 任务被错判给了弱模型：失败，重试到强模型。
        # ★ 这一次重试**连前缀一起重付**——而且必然是一次 model_changed。
        retries += 1
        picofen += prefix_charge(strong.model, strong.price)
        last_model = strong.model
        picofen += charge(t.input_tokens, strong.price.input_miss) + charge(
            t.output_tokens, strong.price.output
        )
        solved += 1

    return RouteOutcome(
        picofen=picofen,
        solved=solved,
        total=len(tasks),
        retries=retries,
        cache_breaks=cache_breaks,
        prefix_reads=prefix_reads,
    )


def all_strong(tasks: list[Task], strong: ModelSpec, cached_prefix_tokens: int = 0) -> int:
    """全用强模型的对照。路由的价值只能相对它来衡量。

    ★ cached_prefix_tokens 必须和 route_outcome 用同一个值，否则这个对比就是
    拿苹果比橘子——而这是「路由能省 N 倍」那类文章最常犯的错。

    而且注意这个基线在缓存上是**最优**的：全程不换模型，所以前缀写一次、
    之后每次 0.1 倍读出来。任何会切模型的路由器都拿不到这个待遇。
    这就是「路由和缓存打架」的准确含义。
    """
    total = 0
    for i, t in enumerate(tasks):
        if cached_prefix_tokens > 0:
            total += charge(
                cached_prefix_tokens,
                strong.price.input_miss,
                CACHE_WRITE_5M if i == 0 else CACHE_READ,
            )
        total += charge(t.input_tokens, strong.price.input_miss) + charge(
            t.output_tokens, strong.price.output
        )
    return total


# ─────────────────────────────────────────────────────────────
# 十二、一个按真规则算账的假端点
# ─────────────────────────────────────────────────────────────


class FakeEndpoint:
    """★ 这个类是这一节的实验台，而它的存在理由和 shared/fake.py 一样：

        **能用假的测的东西，就不要用真的测。**（L12 那条纪律）

    但这里还有一个更强的理由。你想验证「system prompt 里插一个时间戳会让
    缓存永远命不中」，真端点**不会配合你演这一出**——它会受时段、负载、
    并发邻居影响，你跑十次能得到十个不同的命中率，然后分不清是你的假设错了
    还是今天网络差。

    这个假端点按官方公布的规则算账：前缀逐字节比较、断点只在标记处写、
    低于门槛静默不缓存、并且**按各家的字段名输出**。于是：
      · 数字是自洽的（usage 是从请求算出来的，不是编的）
      · 改一个字符，账立刻变，因果关系看得见
      · verify 里一次模型都不用调
    """

    def __init__(self, shape: ProviderShape, model: str) -> None:
        self._shape = shape
        self._model = model
        # 写过的条目：断点处的前缀规范化字符串 → 该处的 token 数。
        self._store: dict[str, int] = {}

    def send(self, req: Req, output_tokens: int) -> dict[str, Any]:
        """发一次请求，返回**该 provider 形状的** usage。

        命中判定就是官方那句话的直译：
          "Cache hits require 100% identical prompt segments, including all text
           and images up to and including the block marked with cache control."
        """
        total = prefix_tokens(req)
        key, upto = self._breakpoint_prefix(req)

        read = 0
        write = 0

        floor = min_cacheable(self._model)
        eligible = floor < 0 or upto >= floor

        if eligible:
            if key in self._store:
                read = self._store[key]
            else:
                write = upto
                self._store[key] = upto
        # ★ 不合格的时候什么都不做，**也不报错**。这正是官方那句
        # "processed without caching, and no error is returned" 的行为。

        return self._shape_usage(total, read, write, output_tokens)

    def _breakpoint_prefix(self, req: Req) -> tuple[str, int]:
        """断点处的累积前缀，以及它覆盖多少 token。

        没有显式断点时按**自动缓存**处理：断点落在最后一个可缓存块上。
        ★ 官方特别提醒自动缓存会掉进同一个坑：
          "it places the breakpoint on the last cacheable block, which in this
           structure is the one that changes every request"
        """
        parts: list[str] = [f"model={req.model}"]
        tokens = 0

        for t in req.tools:
            parts.append(_canonical_tool(t))
            tokens += tool_tokens(t)

        # 找显式断点：system 然后 messages，取最后一个。
        flat: list[Block] = [*req.system, *req.messages]
        last_bp = -1
        for i, b in enumerate(flat):
            if b.cache_control_ttl is not None:
                last_bp = i
        end = last_bp if last_bp >= 0 else len(flat) - 1

        for i in range(end + 1):
            b = flat[i]
            # ★ 用 canonical_json_block，它会把 cache_control 排除掉——断点是请求
            # 参数，不是内容。算进哈希就会得出「挪一下断点等于改了 prompt」这个错结论。
            parts.append(canonical_json_block(b))
            tokens += block_tokens(b)

        return "|".join(parts), tokens

    def _shape_usage(self, total: int, read: int, write: int, out: int) -> dict[str, Any]:
        """按各家的字段名输出。★ 字段名不同不是细节——它决定了你能不能判定。"""
        if self._shape == "anthropic":
            return {
                # ★ Anthropic 的 input_tokens 只是断点之后的那部分。
                "input_tokens": total - read - write,
                "cache_read_input_tokens": read,
                "cache_creation_input_tokens": write,
                "output_tokens": out,
            }
        if self._shape == "openai-responses":
            return {
                "input_tokens": total,
                "input_tokens_details": {"cached_tokens": read, "cache_write_tokens": write},
                "output_tokens": out,
            }
        if self._shape == "azure-chat":
            return {
                "prompt_tokens": total,
                "prompt_tokens_details": {"cached_tokens": read, "cache_write_tokens": write},
                "completion_tokens": out,
            }
        if self._shape == "deepseek":
            # 没有「写入」这个概念。
            return {
                "prompt_cache_hit_tokens": read,
                "prompt_cache_miss_tokens": total - read,
                "output_tokens": out,
            }
        # anthropic-openai-compat
        # ★ 缓存字段被擦掉了。缓存**可能照样在跑**，但你看不见。
        return {"prompt_tokens": total, "completion_tokens": out}
