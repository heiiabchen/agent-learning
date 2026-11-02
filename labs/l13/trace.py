"""L13：agent 的可观测性（Python 镜像）。跑法：

    cd labs && uv run l13/trace.py
    cd labs && OBS_IMPL=shared uv run l13/trace.py   # 看参考实现的输出
    cd labs && uv run l13/verify.py

★ 这一节的核心论点：**你以为在建一份记录，其实在建三份互相冲突的东西。**

  监控（metrics）  要便宜、要全量、要能报警  →  但它算不出成本（TODO 3）
  调试（trace）    要完整、要带内容          →  但它是二次方增长的（TODO 4）
  复现（cassette） 要确定性                  →  但模型本身不可复现（TODO 8）

把这三件事当成一件事做，是这一节里几乎所有故障的来源。

而这八个 TODO 的共同点和前面每一节一样：**它们全都不抛异常。**
这一节更狠——它们会给你一条**看起来完整的 trace**。

  TODO 1  属性名去重    —— 双发期把花费翻一倍，而两个数字各自都对
  TODO 2  token 会计    —— ★ 同一个字段名，两家相反的语义，差 2001 倍
  TODO 3  成本          —— 为什么"用 metrics 建成本看板"办不到
  TODO 4  二次方增长    —— ★ 50 轮写 160 MB，其中 98% 是重复的
  TODO 5  4 MiB 那道墙  —— ★ 专杀最有价值的 trace，且不可重试
  TODO 6  采样          —— head 采样在 agent 上是结构性错误
  TODO 7  span 形状     —— 规范不替你决定，而它自己说了
  TODO 8  复现与归因    —— ★ 你复现的不是计算，是一份录音
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared import observe as _S  # noqa: E402
from shared.observe import (  # noqa: E402
    ATTR,
    PRICES,
    BatchReport,
    CoalesceReport,
    CostBreakdown,
    DedupedTrace,
    FailureVerdict,
    LoopStats,
    Message,
    Price,
    Provider,
    Recorder,
    ReplayabilityReport,
    Run,
    SampleOutcome,
    Span,
    TailOutcome,
    TailPolicy,
    TraceSize,
    Usage,
)

IMPL = "shared" if os.environ.get("OBS_IMPL") == "shared" else "mine"

# ─────────────────────────────────────────────────────────────
# TODO 1：双发期的属性名去重
#
# OTel 的 GenAI 约定一直在改名。而**改名的症状不是报错，是看板查到 0 条**——
# span 正常创建、exporter 返回成功、collector 吞吐健康。
# ★ 这和"系统很安静"长得一模一样。
#
# 于是框架在过渡期会**双发**：把同一个值同时写到新旧两个键上。
# 而一个写成 SUM(prompt_tokens) + SUM(input_tokens) 的看板会把
# 你的报告花费**翻一倍**——注意，两个数字各自都是对的。
#
# 要求：
#   · 把旧键折到新键上，**取一个，绝不相加**
#   · 报出"两个键的值不一样"这种情况 —— 那意味着两条埋点路径在测
#     不同的东西，这时候无论取哪个都是错的
# ─────────────────────────────────────────────────────────────


def coalesce_attrs(raw: dict[str, Any]) -> CoalesceReport:
    if IMPL == "shared":
        return _S.coalesce_attrs(raw)
    # TODO: 实现我
    return CoalesceReport(attrs=raw, dual_emit=[], conflicts=[])


# ─────────────────────────────────────────────────────────────
# TODO 2：token 会计
#
# ★ 这是整节课最容易错一个数量级的地方，而原因只有一句话：
#   **Anthropic 和 OpenAI 的 input_tokens 语义正好相反。**
#
#   Anthropic：input_tokens **不含**缓存
#   OpenAI：   input_tokens **已含**缓存
#
# 字段名一样，含义相反。照着字段名做的映射在 Anthropic 上会把
# 100,050 记成 50 —— **少算 2001 倍**。
#
# 还有两个坑：
#   · 顶层的 cache_creation_input_tokens 是 5 分钟档（1.25x）和
#     1 小时档（2x）**之和**，只读它算不出钱
#   · reasoning **已经包含在** output_tokens 里，不要再加
# ─────────────────────────────────────────────────────────────


def normalize_usage(provider: Provider, raw: dict[str, Any]) -> Usage:
    if IMPL == "shared":
        return _S.normalize_usage(provider, raw)
    # TODO: 实现我
    n = raw.get("input_tokens", 0)
    return Usage(
        input_tokens=n,
        output_tokens=raw.get("output_tokens", 0),
        cache_read=0,
        cache_write_5m=0,
        cache_write_1h=0,
        reasoning=0,
        fresh_input=n,
        problems=[],
    )


# ─────────────────────────────────────────────────────────────
# TODO 3：成本
#
# 这个函数存在的理由是要**推翻一条广为流传的建议**：
# "成本看板建在 gen_ai.client.token.usage 上、按 gen_ai.token.type 拆。"
#
# ★ 它在开了 prompt caching 的系统上**做不到**，理由在一个枚举里：
#   gen_ai.token.type 只有**两个**取值，input 和 output。
#
# 于是 1x / 0.1x / 1.25x / 2x 全塌进 token.type=input 一个桶。
# ─────────────────────────────────────────────────────────────


def cost_of(u: Usage, price: Price) -> CostBreakdown:
    if IMPL == "shared":
        return _S.cost_of(u, price)
    # TODO: 实现我
    return CostBreakdown(0, 0, 0, 0, 0, 0, 1)


# ─────────────────────────────────────────────────────────────
# TODO 4：trace 的二次方增长
#
# ★ 存了 1 + 2 + … + k = k(k+1)/2 条，其中只有 k 条不重复。
#   10 轮 → 55 / 10      30 轮 → 465 / 30      50 轮 → 1275 / 50
#
# **运行长度翻倍，存储量翻四倍。**
#
# ★ dedupe_trace 里哈希前必须**规范化 JSON**（键排序），否则键序
# 不同的同一条消息会算成两条，去重率变成 0 而且不报错。
# ─────────────────────────────────────────────────────────────


def trace_size(messages: list[Message], turns: int) -> TraceSize:
    if IMPL == "shared":
        return _S.trace_size(messages, turns)
    # TODO: 实现我
    return TraceSize(
        turns=turns,
        stored_messages=0,
        unique_messages=0,
        stored_bytes=0,
        deduped_bytes=0,
        ratio=1.0,
    )


def dedupe_trace(turns_of_messages: list[list[Message]]) -> DedupedTrace:
    if IMPL == "shared":
        return _S.dedupe_trace(turns_of_messages)
    # TODO: 实现我
    return DedupedTrace(blobs={}, turns=[], saved_bytes=0)


# ─────────────────────────────────────────────────────────────
# TODO 5：4 MiB 那道墙
#
# ★ 一条很坏的三段组合：
# 1. OTLP 默认接收上限 4 MiB，超限返回 RESOURCE_EXHAUSTED，**不可重试**
# 2. 一个 LLM span 的输入可以合法达到 ~3.2 MB
# 3. ★ 而 batch processor **按条数分批，不按字节**
#
# 于是一个胖 span 把整批拖下水，连带毫不相关的 span 一起消失。
#
# ★ SDK 不会救你：AttributeValueLengthLimit 默认 **Infinity**。
# "默认 128 字符截断"是把**数量**限制看成了**长度**限制。
# ─────────────────────────────────────────────────────────────


def batch_by_bytes(
    spans: list[Span], limit: int = _S.OTLP_LIMIT, headroom: float = 0.9
) -> BatchReport:
    if IMPL == "shared":
        return _S.batch_by_bytes(spans, limit, headroom)
    # TODO: 实现我
    return BatchReport(batches=[_S.Batch(spans=spans, nbytes=0)], oversized=[], problems=[])


# ─────────────────────────────────────────────────────────────
# TODO 6：采样
#
# ★ head 采样在 agent 上失败**不是因为不精确，是因为信息顺序**：
# 做决定的那一刻，这次运行还没跑。
#
# 于是 10% 的采样率保留 10% 的成功，**也保留 10% 的失败**。
#
# 而 tail 采样有三个 agent 专属缺陷，全部来自默认值：
#   decision_wait 30s / num_traces 淘汰最老的 / sampled_cache_size **0**
#
# ★ 最后一条的症状：你打开一条**看起来完整、只是有点短**的 trace。
#
# loop_stats 是出路：invoke_agent.inference_calls 是 **Histogram**，
# 所以 p99 的 loop 长度可以在不存任何 trace 的前提下报警。
# ─────────────────────────────────────────────────────────────


def head_sample(runs: list[Run], rate: float) -> SampleOutcome:
    if IMPL == "shared":
        return _S.head_sample(runs, rate)
    # TODO: 实现我
    return SampleOutcome(kept=[], failure_recall=0.0, failure_share=0.0, note="")


def tail_sample(runs: list[Run], policy: TailPolicy) -> TailOutcome:
    if IMPL == "shared":
        return _S.tail_sample(runs, policy)
    # TODO: 实现我
    return TailOutcome(kept=[], failure_recall=0.0, failure_share=0.0, note="")


def loop_stats(runs: list[Run], runaway_at: int) -> LoopStats:
    if IMPL == "shared":
        return _S.loop_stats(runs, runaway_at)
    # TODO: 实现我
    return LoopStats(p50=0, p90=0, p99=0, max=0, runaway=[], note="")


# ─────────────────────────────────────────────────────────────
# TODO 7：span 的形状，和不重复计算的求和
#
# ★ 关于层级，规范**没有规范性指引，而且它自己说了**：
#   "They are likely to be **siblings** if there is an encompassing span."
#
# 两个必须做对的细节：
#   · sampling-relevant 的五个属性**必须在 span 创建时就存在**。
#     等到结束前再补，tail 采样器看不到它们，
#     ★ 而你的采样策略会静默地不再区分任何东西。
#   · v1.41.0 起 internal 的 invoke_agent **不带 token usage**。
#
# sum_usage 要处理三层包含关系：
#   input ⊇ cache_read + cache_write，output ⊇ reasoning，
#   {modality}.cache_read ⊆ cache_read **且** ⊆ {modality}.input
# ─────────────────────────────────────────────────────────────


def agent_span_tree(
    agent: str, conversation_id: str, model: str, provider: Provider, steps: list[dict[str, Any]]
) -> list[Span]:
    if IMPL == "shared":
        return _S.agent_span_tree(agent, conversation_id, model, provider, steps)
    # TODO: 实现我
    return []


def sum_usage(spans: list[Span]) -> dict[str, Any]:
    if IMPL == "shared":
        return _S.sum_usage(spans)
    # TODO: 实现我
    return {"input": 0, "output": 0, "problems": []}


# ─────────────────────────────────────────────────────────────
# TODO 8：复现与归因
#
# ★ 先说清一件被营销语言盖住的事：**模型的输出没法重放。**
#
# temperature 0 下同一个请求的输出取决于**别人的负载**。
# 所以所有声称 "deterministic replay" 的工具做的都是
# **把模型输出缓存下来当 oracle 再发一遍**，不是重新执行模型。
#
# 你重放的是一份**录音**，不是一次**计算**。
#   ★ 只有 hybrid 能答："如果当时那个工具返回的是别的，会怎样"
#     —— 而这才是事故当下你真正想问的问题
#
# classify_failure 的取舍：**能被程序判定的分类，才值得进你的分类学。**
# 理由是 TRAIL——最好的模型联合准确率 18.3% / 5.0%，
# 而 Context Handling Failures 几乎所有模型 F1 = 0.00。
# ★ agent 独有的那些失败，恰恰是 LLM judge 看不见的。
# ─────────────────────────────────────────────────────────────


def check_replayability(spans: list[Span]) -> ReplayabilityReport:
    if IMPL == "shared":
        return _S.check_replayability(spans)
    # TODO: 实现我
    return ReplayabilityReport(replayable=True, blockers=[], warnings=[])


def classify_failure(spans: list[Span], ok: bool, turns: int) -> list[FailureVerdict]:
    if IMPL == "shared":
        return _S.classify_failure(spans, ok, turns)
    # TODO: 实现我
    return []


# ═════════════════════════════════════════════════════════════
# 观察实验
# ═════════════════════════════════════════════════════════════


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


def demo_coalesce() -> None:
    print(bold("\n一、双发：两个数字各自都对，加起来错一倍"))

    raw = {
        "gen_ai.usage.prompt_tokens": 1200,
        "gen_ai.usage.input_tokens": 1200,
        "gen_ai.usage.completion_tokens": 300,
        "gen_ai.usage.output_tokens": 300,
        "gen_ai.system": "anthropic",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.usage.cache_creation.input_tokens": 800,
        "gen_ai.usage.cache_write.input_tokens": 800,
    }
    # 一个 SUM(prompt_tokens) + SUM(input_tokens) 的看板会这么算
    naive = int(raw["gen_ai.usage.prompt_tokens"]) + int(raw["gen_ai.usage.input_tokens"])
    r = coalesce_attrs(raw)
    clean = int(r.attrs.get(ATTR["input_tokens"], 0))

    print(f"  埋点发出了 {len(raw)} 个属性，其中 {len(r.dual_emit)} 对是双发的")
    for d in r.dual_emit:
        print(dim(f"    {d}"))
    bad_query = red("SUM(prompt_tokens) + SUM(input_tokens)")
    print(f"\n  一个 {bad_query} 的看板会报：{red(str(naive))} 输入 token")
    print(f"  去重后的真实值：                                   {green(str(clean))}")
    print(
        yellow(f"  ★ 差 {naive / max(clean, 1):.1f} 倍。而两个键各自的值都是对的——")
        + yellow("这就是为什么没有任何一层会报错")
    )
    print(dim("    修法：按优先级取一个，绝不相加。"))


def demo_usage() -> None:
    print(bold("\n二、★ 同一个字段名，两家相反的语义"))

    # Anthropic：10 万 token 的系统 prompt 命中缓存，用户消息 50 token
    anthropic_raw = {
        "input_tokens": 50,  # ★ 这个数字**不含**缓存
        "output_tokens": 420,
        "cache_read_input_tokens": 100_000,
        "cache_creation_input_tokens": 0,
    }
    # OpenAI：同样的情形
    openai_raw = {
        "input_tokens": 100_050,  # ★ 这个数字**已含**缓存
        "output_tokens": 420,
        "input_tokens_details": {"cached_tokens": 100_000},
    }
    a = normalize_usage("anthropic", anthropic_raw)
    o = normalize_usage("openai", openai_raw)

    print(dim("  两家都处理了 100,050 个输入 token（10 万缓存命中 + 50 新增）"))
    print()
    print("  提供方        原始 input_tokens    照字段名映射    归一后")
    print("  " + "─" * 62)
    a_raw = str(anthropic_raw["input_tokens"])
    o_raw = str(openai_raw["input_tokens"])
    print(f"  Anthropic     {a_raw:<19}{red(a_raw.ljust(15))} {green(str(a.input_tokens))}")
    print(f"  OpenAI        {o_raw:<19}{green(o_raw.ljust(15))} {green(str(o.input_tokens))}")
    print()
    ratio = round(a.input_tokens / max(int(anthropic_raw["input_tokens"]), 1))
    print(yellow(f"  ★ 一个照字段名做的映射在 Anthropic 上把 100,050 记成 50——少算 {ratio} 倍。"))
    print(dim("    而它在 OpenAI 上完全正确。同一段代码，一家对一家错。"))
    print()
    print(dim("    OTel 规范把这个不对称显式写进了提供方页的脚注："))
    print(dim("      Anthropic 注 [27]：excludes cached tokens，MUST be added"))
    print(dim("      OpenAI   注 [24]：对应 cached_tokens，不加"))

    print(bold("\n  缓存写入：只读顶层字段算不出钱"))
    no_detail = normalize_usage(
        "anthropic",
        {"input_tokens": 10, "output_tokens": 100, "cache_creation_input_tokens": 40_000},
    )
    for p in no_detail.problems:
        print(red(f"    ✗ {p}"))
    with_detail = normalize_usage(
        "anthropic",
        {
            "input_tokens": 10,
            "output_tokens": 100,
            "cache_creation_input_tokens": 40_000,
            "cache_creation": {
                "ephemeral_5m_input_tokens": 10_000,
                "ephemeral_1h_input_tokens": 30_000,
            },
        },
    )
    price = PRICES["claude-like"]
    c_est = cost_of(no_detail, price)
    c_real = cost_of(with_detail, price)
    under = (c_real.total - c_est.total) / c_real.total * 100 if c_real.total else 0.0
    print(
        f"    按 5 分钟档估：${c_est.total:.5f}    读了明细：${c_real.total:.5f}"
        + yellow(f"    低估 {under:.0f}%")
    )


def demo_cost() -> None:
    print(bold('\n三、为什么"用 metrics 建成本看板"办不到'))

    u = normalize_usage(
        "anthropic",
        {
            "input_tokens": 200,
            "output_tokens": 800,
            "cache_read_input_tokens": 180_000,
            "cache_creation_input_tokens": 20_000,
            "cache_creation": {
                "ephemeral_5m_input_tokens": 4_000,
                "ephemeral_1h_input_tokens": 16_000,
            },
        },
    )
    price = PRICES["claude-like"]
    c = cost_of(u, price)

    w5_cost = (u.cache_write_5m / 1e6) * price.input_per_m * 1.25
    w1h_cost = (u.cache_write_1h / 1e6) * price.input_per_m * 2

    print(dim("  一次典型的长上下文 agent 调用："))
    print(f"    普通输入   {u.fresh_input:>8} tok  ×1      ${c.fresh:.6f}")
    print(f"    缓存读     {u.cache_read:>8} tok  ×0.1    ${c.cache_read:.6f}")
    print(f"    5 分钟写   {u.cache_write_5m:>8} tok  ×1.25   ${w5_cost:.6f}")
    print(f"    1 小时写   {u.cache_write_1h:>8} tok  ×2      ${w1h_cost:.6f}")
    print(f"    输出       {u.output_tokens:>8} tok          ${c.output:.6f}")
    print("  " + "─" * 52)
    print(f"    {green('从 span 算')}                            ${c.total:.6f}")
    print(f"    {red('从 metric 算')}（所有 input 一个价）      ${c.naive_total:.6f}")
    over = (c.naive_total / c.total - 1) * 100 if c.total else 0.0
    print(yellow(f"\n  ★ 高估 {over:.0f}%。而这不是精度问题，是**维度缺失**："))
    print(dim("    gen_ai.token.type 只有两个取值：input 和 output。"))
    print(dim("    gen_ai.client.token.usage 的全部属性里没有缓存维度。"))
    print(
        dim(
            f"    于是 1x / 0.1x / 1.25x / 2x 全塌进 token.type=input 一个桶"
            f"——跨度 {c.spread:g} 倍。"
        )
    )
    print(green("\n    正确分工（和常见建议相反）："))
    print(green("      metrics → 量、延迟、loop 长度 SLO"))
    print(green("      spans   → 成本"))


def demo_quadratic() -> None:
    print(bold("\n四、★ trace 是二次方增长的"))

    # 50 条各不相同的消息，模拟一次 50 轮的运行
    msgs = [Message("system", "S" * 2000)] + [
        Message(
            "assistant" if i % 2 == 0 else "tool",
            f"第 {i} 步：" + chr(97 + i % 26) * (600 + i * 7),
        )
        for i in range(49)
    ]
    print("  轮数    存了多少条    唯一    朴素字节     去重字节    倍数")
    print("  " + "─" * 62)
    for k in (10, 30, 50):
        t = trace_size(msgs, k)
        print(
            f"  {k:>3}  {t.stored_messages:>11}  {t.unique_messages:>6}  "
            f"{t.stored_bytes / 1024:>9.0f} KB  {t.deduped_bytes / 1024:>8.1f} KB  "
            f"{t.ratio:>5.1f}x"
        )
    print(yellow("\n  ★ 存的条数是 k(k+1)/2，唯一的是 k。运行长度翻倍，存储量翻四倍。"))
    print(dim("    上限也能推：数组必须塞进上下文窗口，多数框架在 80% 处压缩，"))
    print(dim("    所以 1M token 下单个 LLM span 的输入上限 ≈ 3.2 MB JSON。"))
    print(dim("    一次逼近上限的 50 轮运行写 ~160 MB，其中 ~98% 是同一批字节记了 50 遍。"))

    # 第 k 轮发送前 k 条，正是朴素记录的形状
    turns = [msgs[:k] for k in range(1, 51)]
    d = dedupe_trace(turns)
    print(
        green(
            f"\n  内容寻址去重：{len(d.blobs)} 个 blob 覆盖 {len(turns)} 轮，"
            f"省下 {d.saved_bytes / 1024:.0f} KB"
        )
    )
    print(dim("    ★ 哈希前必须规范化 JSON（键排序）。键序不同的同一条消息会算成两条，"))
    print(dim("      去重率变成 0，而且不报错。"))


def demo_wall() -> None:
    print(bold("\n五、★ 4 MiB 那道墙，以及它为什么专杀最有价值的 trace"))

    def fat(i: int) -> Span:
        return Span(
            name=f"chat 长上下文#{i}",
            span_id=f"fat{i}",
            parent_id="root",
            kind="CLIENT",
            attrs={
                ATTR["operation"]: "chat",
                "gen_ai.input.messages": "M" * 2_400_000,  # ★ 2.4 MB，完全合法
            },
        )

    normal = [
        Span(
            name=f"execute_tool t{i}",
            span_id=f"n{i}",
            parent_id="root",
            kind="INTERNAL",
            attrs={ATTR["operation"]: "execute_tool", ATTR["tool_name"]: f"t{i}"},
        )
        for i in range(40)
    ]
    allspans = [fat(1), *normal[:20], fat(2), *normal[20:]]
    total = sum(_S.span_bytes(s) for s in allspans)
    total_mb = total / 1024 / 1024

    print(
        dim(f"  一批 {len(allspans)} 个 span，共 {total_mb:.2f} MiB，其中两个是 2.4 MB 的 LLM span")
    )
    print(dim("  两个都在合法范围内（单 span 上限 ≈ 3.2 MB），单独发都没问题。"))
    print(
        red(
            f"\n  按条数分批（send_batch_max_size=512，远大于 {len(allspans)}）："
            f"1 批，{total_mb:.2f} MiB"
        )
    )
    print(red(f"    → 超过 4 MiB → RESOURCE_EXHAUSTED → {bold('不可重试')} → 整批丢掉"))
    print(red(f"    → 连带那 {len(normal)} 个毫不相关的工具 span 一起消失"))

    r = batch_by_bytes(allspans)
    print(green(f"\n  按字节分批：{len(r.batches)} 批"))
    for b in r.batches:
        print(dim(f"    {len(b.spans):>2} 个 span，{b.nbytes / 1024 / 1024:.2f} MiB"))
    for p in r.problems:
        print(yellow(f"    ★ {p}"))

    # 再看单条就超限的情况：分批救不了它
    monster = Span(
        name="chat 逼近上下文上限",
        span_id="mon",
        parent_id="root",
        kind="CLIENT",
        attrs={ATTR["operation"]: "chat", "gen_ai.input.messages": "M" * 3_900_000},
    )
    r2 = batch_by_bytes([monster, *normal[:5]])
    if r2.oversized:
        print(red("\n  而如果单个 span 就 3.9 MB："))
        for p in r2.problems:
            print(red(f"    ✗ {p}"))
    print(dim("\n    而 SDK 那一层不会救你：AttributeValueLengthLimit 默认 Infinity。"))
    print(dim('    到处流传的"默认 128 字符截断"是把**数量**限制看成了**长度**限制。'))
    print(yellow("    ★ 最坏的部分：最胖的 span 来自最长、最复杂、最该被看的那次运行。"))


def _make_runs(n: int = 1000) -> list[Run]:
    out = []
    for i in range(n):
        bad = i % 20 == 0
        out.append(
            Run(
                trace_id=f"t{i}",
                ok=not bad,
                turns=24 + (i % 17) if bad else 3 + (i % 5),
                ms=180_000 + (i % 7) * 20_000 if bad else 8_000 + (i % 11) * 900,
                tokens=400_000 + i * 37 if bad else 30_000 + i * 11,
            )
        )
    return out


def demo_sampling() -> None:
    print(bold("\n六、采样：偏的方向正好是错的"))

    runs = _make_runs()
    failures = sum(1 for r in runs if not r.ok)
    h = head_sample(runs, 0.1)

    print(dim(f"  1000 次运行，{failures} 次失败（{failures / 10:.0f}%）。失败的普遍更长更贵。"))
    print(
        f"\n  head 采样 @10%：留下 {len(h.kept)} 条，"
        f"其中失败 {h.failure_share * 100:.1f}%"
    )
    print(red(f"    失败召回 {h.failure_recall * 100:.0f}%") + dim(" —— 和成功的保留率一样"))
    tail_note = h.note.split("★ ")[1] if "★ " in h.note else ""
    print(yellow(f"    ★ {tail_note}"))
    print(dim("\n    推论：你的调试语料不只是生产的一个小样本，它是有偏的——"))
    print(dim("    1% 采样率下，你会在留住一条罕见灾难轨迹之前，先留住中位数请求一百次。"))

    t = tail_sample(
        runs[:60],
        TailPolicy(
            decision_wait_ms=30_000,  # ★ 默认值
            num_traces=50,  # 缩小的默认值，让淘汰在这个规模下可见
            decision_cache_size=0,  # ★ 默认值：不启用
            keep=lambda r: (not r.ok) or r.turns >= 20,
        ),
    )
    print(bold("\n  tail 采样（全用默认值）："))
    print(dim("    策略写的是「失败的留下，跑够 20 轮的留下」——正好瞄着我们要的那些。"))
    print(f"    留下 {len(t.kept)} 条，失败召回 {red(f'{t.failure_recall * 100:.0f}%')}")
    print(yellow("    ★ 一条都没留下。因为失败的运行要跑 3 分钟，而 decision_wait 在第 30 秒"))
    print(yellow("      就替它做了决定——那一刻它还没失败，也还没跑到 20 轮。"))
    for p in t.problems:
        print(red(f"    ✗ {p}"))
    print(dim("\n    要监控采样器自己的四个指标："))
    for m in _S.SAMPLER_METRICS:
        print(dim(f"      {m}"))

    ls = loop_stats(runs, 20)
    print(bold("\n  出路：loop 长度不需要 trace"))
    print(f"    p50 {ls.p50} 轮 / p90 {ls.p90} / p99 {ls.p99} / 最长 {ls.max}")
    print(green(f"    失控（≥20 轮）：{len(ls.runaway)} 次，全部被这个直方图看到"))
    print(
        dim(
            "    ★ gen_ai.invoke_agent.inference_calls 和 .tool_calls "
            "是 Histogram 而不是 Counter，"
        )
    )
    print(dim("      所以 p99 的 loop 长度可以在 1% 采样率下照样报警。"))
    print(
        dim("    顺带：invoke_agent.duration 的桶边界到 409.6 秒——规范预设 agent 能跑 ~7 分钟，")
    )
    print(dim("    而 decision_wait 的默认值是 30 秒。"))


def demo_span_shape() -> None:
    print(bold("\n七、span 的形状：规范不替你决定"))

    u = normalize_usage(
        "anthropic",
        {
            "input_tokens": 120,
            "output_tokens": 340,
            "cache_read_input_tokens": 48_000,
            "cache_creation_input_tokens": 0,
            "output_tokens_details": {"reasoning_tokens": 280},
        },
    )
    spans = agent_span_tree(
        "code-fixer",
        "conv-7",
        "claude-like",
        "anthropic",
        [
            {"kind": "chat", "usage": u},
            {"kind": "execute_tool", "name": "read_file"},
            {"kind": "chat", "usage": u},
            {"kind": "execute_tool", "name": "write_file"},
            {"kind": "chat", "usage": u},
        ],
    )
    for s in spans:
        indent = "  " if s.parent_id is None else "    ├─ "
        print(f"{indent}{s.name}  {dim(f'[{s.kind}]')}")
    print(
        dim('\n    一排兄弟，不是嵌套链。规范的非规范示例原话："They are likely to be')
    )
    print(dim('    **siblings** if there is an encompassing span." 跨轮关联靠 conversation.id。'))

    total = sum_usage(spans)
    print(f"\n  按 span 求和：输入 {total['input']} / 输出 {total['output']}")
    print(
        green("    ✓ 根 span 没带 token —— v1.41.0 起 internal 的 invoke_agent 显式移除了它们")
    )
    print(dim("      正是为了让这个求和不重复计算。"))

    bad = [
        Span(
            name=s.name,
            span_id=s.span_id,
            parent_id=s.parent_id,
            kind=s.kind,
            attrs={
                **s.attrs,
                ATTR["input_tokens"]: total["input"],
                ATTR["output_tokens"]: total["output"],
            },
        )
        if s.parent_id is None
        else s
        for s in spans
    ]
    bad_sum = sum_usage(bad)
    print(red(f"\n  如果根 span 也带 token：求和变成 {bad_sum['input']} —— 整整翻倍"))
    for p in bad_sum["problems"]:
        print(red(f"    ✗ {p}"))

    raw_sem = [
        Span(
            name="chat 未归一",
            span_id="x",
            parent_id=None,
            kind="CLIENT",
            attrs={
                ATTR["operation"]: "chat",
                ATTR["input_tokens"]: 120,  # ★ Anthropic 的原始语义，不含缓存
                ATTR["output_tokens"]: 340,
                ATTR["cache_read"]: 48_000,
            },
        )
    ]
    raw_sum = sum_usage(raw_sem)
    print(red("\n  如果 span 上写的是未归一的 Anthropic 语义："))
    for p in raw_sum["problems"]:
        print(red(f"    ✗ {p}"))


async def demo_replay() -> None:
    print(bold("\n八、★ 你复现的不是计算，是一份录音"))

    no_content = agent_span_tree(
        "code-fixer",
        "conv-9",
        "gpt-like",
        "openai",
        [
            {"kind": "chat"},
            {"kind": "execute_tool", "name": "grep"},
            {"kind": "execute_tool", "name": "grep"},
        ],
    )
    r1 = check_replayability(no_content)
    print(dim('  一份"合规的"OTel trace，能不能重放？'))
    print(green("    可以") if r1.replayable else red("    不能："))
    for b in r1.blockers:
        print(red(f"      ✗ {b}"))
    for w in r1.warnings:
        print(yellow(f"      ! {w}"))

    stateful = [
        Span(
            name=s.name,
            span_id=s.span_id,
            parent_id=s.parent_id,
            kind=s.kind,
            attrs={
                **s.attrs,
                "gen_ai.input.messages": "[...]",
                "gen_ai.request.previous_response.id": "resp_abc123",
            },
        )
        if i == 1
        else s
        for i, s in enumerate(no_content)
    ]
    r2 = check_replayability(stateful)
    print(dim("\n  同一份 trace，但用了 previous_response_id 做会话状态："))
    for b in r2.blockers:
        print(red(f"      ✗ {b}"))

    print(bold("\n  录一遍，然后放一遍："))
    live_calls = 0

    async def fake_model() -> dict[str, str]:
        nonlocal live_calls
        live_calls += 1
        return {"text": f"回答 #{live_calls}"}

    rec = Recorder("record")
    await rec.call("openai", "/responses", {"prompt": "第一步"}, fake_model)
    await rec.call("openai", "/responses", {"prompt": "第二步"}, fake_model)
    await rec.call("openai", "/responses", {"prompt": "第二步"}, fake_model)  # 重试
    cassette = rec.finish()
    print(dim(f"    录到 {len(cassette.entries)} 条，真实调用 {live_calls} 次"))

    before = live_calls
    play = Recorder("replay", cassette)
    await play.call("openai", "/responses", {"prompt": "第一步"}, fake_model)
    await play.call("openai", "/responses", {"prompt": "第二步"}, fake_model)
    await play.call("openai", "/responses", {"prompt": "第二步"}, fake_model)
    print(green(f"    重放命中 {play.report.matched} 条，真实调用 {live_calls - before} 次"))
    print(dim("    ★ 同一个键要按 FIFO 游标推进，否则重试循环里的第二次会拿到第一次的响应。"))

    strict = Recorder("replay", cassette)
    await strict.call("openai", "/responses", {"prompt": "第一步"}, fake_model)
    try:
        await strict.call("openai", "/responses", {"prompt": "改过的第二步"}, fake_model)
        print(red("    应该抛 DivergenceError 但没抛"))
    except _S.DivergenceError as e:
        print(red(f"    ✗ {e}"))

    before2 = live_calls
    hybrid = Recorder("hybrid", cassette)
    await hybrid.call("openai", "/responses", {"prompt": "第一步"}, fake_model)
    await hybrid.call("openai", "/responses", {"prompt": "改过的第二步"}, fake_model)
    print(
        green(
            f"\n    hybrid：重放到分叉处（第 {hybrid.report.diverged_at} 次调用），"
            f"然后转真实调用 {live_calls - before2} 次"
        )
    )
    print(
        yellow('    ★ 这才是事故当下真正想问的问题："如果当时那一步返回的是别的，后面会怎样"')
    )
    print(dim("      纯重放只能告诉你已经发生过的事，而那个 trace 也能告诉你。"))


def demo_classify() -> None:
    print(bold("\n九、归因：能被程序判定的分类，才值得进你的分类学"))

    spans = [
        Span(
            name="invoke_agent fixer",
            span_id="root",
            parent_id=None,
            kind="INTERNAL",
            attrs={ATTR["operation"]: "invoke_agent", ATTR["compacted"]: True},
        ),
        *[
            Span(
                name=f"execute_tool {t}",
                span_id=f"s{i}",
                parent_id="root",
                kind="INTERNAL",
                attrs={ATTR["operation"]: "execute_tool", ATTR["tool_name"]: t},
            )
            for i, t in enumerate(["search", "search", "search", "search", "read"])
        ],
    ]
    verdicts = classify_failure(spans, ok=False, turns=31)
    print(dim("  一次跑了 31 轮没结束的运行，程序能判出："))
    for v in verdicts:
        print(f"    {bold(v.code)} {v.name}")
        print(dim(f"      {v.evidence}"))

    print(bold('\n  为什么不能"把 trace 丢给大模型让它告诉我哪坏了"：'))
    print("    TRAIL 基准（148 条 OTel trace / 1987 span / 841 条标注错误）")
    print("    最好的模型联合准确率：" + red("GAIA 18.3%，SWE-Bench 5.0%"))
    print("    Context Handling Failures：" + red("几乎所有模型 F1 = 0.00"))
    print("    8 个模型里 " + red("3 个直接 Context Length Exceeded"))
    print(dim("      （GAIA 那份在 Claude-3.7 的 tokenizer 下**平均**长度就超了它的窗口）"))
    print(yellow("\n    ★ agent 独有的那些失败，恰恰是 LLM judge 看不见的。"))
    print(dim("    而 Language-Only 幻觉所有模型都测得不错（0.14–0.59）——"))
    print(dim('    所以"用 judge 查幻觉"可行，"用 judge 定位 agent 故障"不可行。'))

    print(bold("\n  MAST 的几个结论，比那张分类表本身更有用："))
    for line in _S.MAST_LESSONS:
        print(f"    · {line}")
    print(yellow("\n    ★ 而引用它的数字之前先看版本号：到处被引的 41.77/36.94/21.30 来自 v2，"))
    print(yellow("      v3 是 ≈44.2/≈32.35/≈23.5，第一大类还改了名字，FM-2.5 差了 11 倍。"))


async def main() -> None:
    print(
        dim("\n（跑的是 shared/observe.py 里的参考实现）")
        if IMPL == "shared"
        else dim("\n（跑的是 l13/trace.py 里你的实现。OBS_IMPL=shared 看参考输出）")
    )
    demo_coalesce()
    demo_usage()
    demo_cost()
    demo_quadratic()
    demo_wall()
    demo_sampling()
    demo_span_shape()
    await demo_replay()
    demo_classify()

    print(bold("\n\n这一节的一句话："))
    print("  " + bold("你以为在建一份记录，其实在建三份互相冲突的东西——"))
    print("  " + bold("监控要便宜、调试要完整、复现要确定，"))
    print("  " + bold("而它们没有一个能靠另外两个的配置得到。"))
    print()


if __name__ == "__main__":
    asyncio.run(main())
