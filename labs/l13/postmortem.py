"""L13 的交付物：失败复盘报告（Python 镜像）。跑法 uv run l13/postmortem.py

这是这一节的落地件。它做的事情很具体：拿到一次失败运行的 trace，
回答四个问题，**并且明确说出哪些问题这份 trace 回答不了**。

  1. 花了多少钱          —— 从 span 算，因为 metric 算不出来
  2. 失败模式是什么      —— 程序能判的部分，判不了的交给人
  3. 这份 trace 能重放吗  —— 通常不能，而理由值得写清楚
  4. ★ 我的可观测性本身有没有病 —— 采样、分批、属性名

★ 第四条是最容易被跳过、也最重要的一条。前三条都建立在
"这份 trace 是完整的"这个假设上，而这一节讲的每一个失效
都在攻击这个假设，且**全部不抛异常**。

所以报告的结构是**先判这份 trace 可不可信，再看它说了什么**。
和 L12 的五道闸门同一个道理：一旦你先看了结论，你就有了立场。
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.observe import (  # noqa: E402
    ATTR,
    PRICES,
    Message,
    Price,
    Provider,
    Run,
    Span,
    TailPolicy,
    Usage,
    agent_span_tree,
    batch_by_bytes,
    check_replayability,
    classify_failure,
    coalesce_attrs,
    cost_of,
    head_sample,
    loop_stats,
    normalize_usage,
    span_bytes,
    sum_usage,
    tail_sample,
    trace_size,
)


@dataclass
class Sampling:
    mode: Literal["head", "tail"]
    rate: float
    decision_wait_ms: int
    cache_size: int


@dataclass
class Incident:
    trace_id: str
    spans: list[Span]
    ok: bool
    turns: int
    ms: int
    provider: Provider
    price: Price
    messages: list[Message]  # 用来估 trace 体积
    fleet: list[Run]  # 同期全部运行，用来判采样配置
    raw_attrs: dict[str, Any]  # 埋点原始属性（含双发）
    sampling: Sampling


@dataclass
class Postmortem:
    trustworthy: bool  # ★ 这份 trace 本身可不可信。先看这个
    telemetry_defects: list[str] = field(default_factory=list)
    replay_ok: bool = True
    replay_reasons: list[str] = field(default_factory=list)
    failures: list[Any] = field(default_factory=list)
    cost_from_spans: float = 0.0
    cost_from_metrics: float = 0.0
    cost_error_pct: float = 0.0
    for_humans: list[str] = field(default_factory=list)


def postmortem(inc: Incident) -> Postmortem:
    defects: list[str] = []

    # ── 第一步：这份 trace 可不可信 ──────────────────────────
    # ★ 顺序是刻意的。先判可信度，再看内容。

    # 1a 属性名：双发会让花费翻倍，而两个数字各自都对
    c = coalesce_attrs(inc.raw_attrs)
    if c.dual_emit:
        defects.append(
            f"埋点处在双发过渡期（{len(c.dual_emit)} 对新旧键）。"
            "任何 SUM(旧键) + SUM(新键) 的看板会把花费翻一倍——而两个数字各自都是对的"
        )
    for x in c.conflicts:
        defects.append(f"★ {x}")

    # 1b 采样：这次事故的同类运行，有多少根本没被记下来
    if inc.sampling.mode == "head":
        h = head_sample(inc.fleet, inc.sampling.rate)
        missing = round(sum(1 for r in inc.fleet if not r.ok) * (1 - h.failure_recall))
        defects.append(
            f"★ 用的是 head 采样 @{inc.sampling.rate * 100:.0f}%，失败召回只有 "
            f"{h.failure_recall * 100:.0f}%——和成功的保留率一样。"
            f"你正在看的这条是运气好留下来的，同类事故还有 {missing} 次没有任何记录"
        )
    else:
        t = tail_sample(
            inc.fleet,
            TailPolicy(
                decision_wait_ms=inc.sampling.decision_wait_ms,
                num_traces=50_000,
                decision_cache_size=inc.sampling.cache_size,
                keep=lambda r: not r.ok,
            ),
        )
        defects.extend(t.problems)
        if inc.ms > inc.sampling.decision_wait_ms:
            secs = inc.sampling.decision_wait_ms / 1000
            defects.append(
                f"★ 这次运行跑了 {inc.ms / 1000:.0f} 秒，而 decision_wait 是 {secs:g} 秒。"
                f"采样决策是在第 {secs:g} 秒做的——那时候它还没失败。"
                "你现在看到的可能是一条被截断的轨迹，而它长得**像一条完整的短 trace**"
            )

    # 1c 分批：这次运行的 span 会不会被 4 MiB 那道墙吃掉
    b = batch_by_bytes(inc.spans)
    defects.extend(b.problems)
    total_mib = sum(span_bytes(s) for s in inc.spans) / 1024 / 1024
    if total_mib > 4:
        defects.append(
            f"★ 这次运行的 span 共 {total_mib:.1f} MiB，按条数分批会超过 OTLP 的 4 MiB 上限，"
            "而那是**不可重试**的错误。整批会消失，连带无关的 span"
        )

    # 1d 体积：二次方增长意味着最该看的运行最贵
    ts = trace_size(inc.messages, inc.turns)
    if ts.ratio > 5:
        defects.append(
            f"trace 体积 {ts.stored_bytes / 1024:.0f} KB，去重后只有 "
            f"{ts.deduped_bytes / 1024:.0f} KB（{ts.ratio:.1f}x 冗余）。"
            "k(k+1)/2 的增长意味着**最长的运行也是最贵的**——而它们正是你最需要留的"
        )

    # ★ 判定：只要采样或分批有缺陷，这份 trace 就不能当成"完整记录"来读
    trustworthy = not any(d.startswith("★") for d in defects)

    # ── 第二步：能重放吗 ────────────────────────────────────
    rep = check_replayability(inc.spans)

    # ── 第三步：程序能判出什么 ──────────────────────────────
    failures = classify_failure(inc.spans, ok=inc.ok, turns=inc.turns)

    # ── 第四步：花了多少钱 ─────────────────────────────────
    total = sum_usage(inc.spans)
    defects.extend(total["problems"])
    # 从 span 逐条算，因为缓存维度只存在于 span 上
    from_spans = 0.0
    from_metrics = 0.0
    for s in inc.spans:
        i = int(s.attrs.get(ATTR["input_tokens"], 0))
        if i == 0:
            continue
        cr = int(s.attrs.get(ATTR["cache_read"], 0))
        cw = int(s.attrs.get(ATTR["cache_write"], 0))
        u = Usage(
            input_tokens=i,
            output_tokens=int(s.attrs.get(ATTR["output_tokens"], 0)),
            cache_read=cr,
            cache_write_5m=cw,
            cache_write_1h=0,
            reasoning=int(s.attrs.get(ATTR["reasoning_tokens"], 0)),
            fresh_input=max(0, i - cr - cw),
        )
        cb = cost_of(u, inc.price)
        from_spans += cb.total
        from_metrics += cb.naive_total

    # ── 第五步：明确交给人的部分 ────────────────────────────
    # ★ 这一段的存在本身就是主张：不要假装程序能判完。
    for_humans: list[str] = []
    if not failures and not inc.ok:
        for_humans.append(
            '★ 运行失败了，但没有一条程序规则命中。这**不是**"没有失败模式"，'
            "是你的分类学还没覆盖这一种。加规则之前先人工读一遍轨迹"
        )
    if any(f.code == "FM-1.4" for f in failures):
        for_humans.append(
            "上下文被压缩过。压缩本身是否导致了失败，程序判不了——"
            "TRAIL 里 Context Handling Failures 是**所有模型 F1 = 0.00** 的那一类。"
            "需要人对比压缩前后的消息"
        )
    loop = loop_stats(inc.fleet, 20)
    for_humans.append(
        f"同期 loop 长度 p50 {loop.p50} / p99 {loop.p99} / 最长 {loop.max} 轮，"
        f"这次是 {inc.turns} 轮。"
        + (
            "★ 超过了 p99，是个离群点"
            if inc.turns > loop.p99
            else "在正常范围内——所以问题不在循环长度上"
        )
    )
    for_humans.append(
        "★ 而这个 loop 长度分布来自 gen_ai.invoke_agent.inference_calls 直方图，"
        "不依赖任何一条 trace。所以它是上面那些采样缺陷唯一影响不到的数字"
    )

    return Postmortem(
        trustworthy=trustworthy,
        telemetry_defects=defects,
        replay_ok=rep.replayable,
        replay_reasons=[*rep.blockers, *rep.warnings],
        failures=failures,
        cost_from_spans=from_spans,
        cost_from_metrics=from_metrics,
        cost_error_pct=0.0 if from_spans == 0 else (from_metrics / from_spans - 1) * 100,
        for_humans=for_humans,
    )


# ─────────────────────────────────────────────────────────────
# 一个植了六个问题的场景
# ─────────────────────────────────────────────────────────────


def scenario() -> Incident:
    usage = normalize_usage(
        "anthropic",
        {
            "input_tokens": 300,
            "output_tokens": 900,
            "cache_read_input_tokens": 120_000,
            "cache_creation_input_tokens": 8_000,
            "cache_creation": {"ephemeral_5m_input_tokens": 8_000},
            "output_tokens_details": {"reasoning_tokens": 640},
        },
    )

    # 一次跑了 31 轮的失败运行：卡在 search 上打转，上下文被压缩过。
    # 注意别的工具各只调了一两次——所以 FM-1.3 只该在 search 上命中。
    tools = [
        "search", "read_file", "search", "search", "write_file",
        "search", "list_dir", "search", "search", "run_tests",
        "search", "search",
    ]
    steps: list[dict[str, Any]] = []
    for t in tools:
        steps.append({"kind": "chat", "usage": usage})
        steps.append({"kind": "execute_tool", "name": t})

    spans = agent_span_tree("refund-handler", "conv-8821", "claude-like", "anthropic", steps)
    spans[0].attrs[ATTR["compacted"]] = True  # 压缩发生过

    messages = [Message("system", "S" * 4000)] + [
        Message("assistant" if i % 2 == 0 else "tool", f"第 {i} 步".ljust(900 + i * 30, "·"))
        for i in range(30)
    ]

    fleet = []
    for i in range(800):
        bad = i % 25 == 0
        fleet.append(
            Run(
                trace_id=f"t{i}",
                ok=not bad,
                turns=26 + (i % 9) if bad else 4 + (i % 6),
                ms=200_000 + (i % 5) * 15_000 if bad else 9_000 + (i % 13) * 800,
                tokens=500_000 if bad else 40_000,
            )
        )

    return Incident(
        trace_id="conv-8821",
        spans=spans,
        ok=False,
        turns=31,
        ms=244_000,
        provider="anthropic",
        price=PRICES["claude-like"],
        messages=messages,
        fleet=fleet,
        # ★ 埋点处在双发过渡期
        raw_attrs={
            "gen_ai.usage.prompt_tokens": 128_300,
            "gen_ai.usage.input_tokens": 128_300,
            "gen_ai.system": "anthropic",
            "gen_ai.provider.name": "anthropic",
        },
        # ★ tail 采样，但用的是默认的 30 秒和不启用的决策缓存
        sampling=Sampling(mode="tail", rate=1.0, decision_wait_ms=30_000, cache_size=0),
    )


def bold(s: str) -> str:
    return f"\x1b[1m{s}\x1b[0m"


def dim(s: str) -> str:
    return f"\x1b[2m{s}\x1b[0m"


def red(s: str) -> str:
    return f"\x1b[31m{s}\x1b[0m"


def green(s: str) -> str:
    return f"\x1b[32m{s}\x1b[0m"


def yellow(s: str) -> str:
    return f"\x1b[33m{s}\x1b[0m"


def render(inc: Incident, r: Postmortem) -> None:
    print(bold(f"\n失败复盘：{inc.trace_id}"))
    print(dim(f"  {inc.turns} 轮 / {inc.ms / 1000:.0f} 秒 / {len(inc.spans)} 个 span / 结果：失败"))

    print(bold("\n① 这份 trace 可不可信"))
    print(
        green("  ✓ 没发现会让轨迹缺失的缺陷")
        if r.trustworthy
        else red("  ✗ 不可信。下面的结论全部建立在一份可能不完整的记录上")
    )
    for d in r.telemetry_defects:
        print(red(f"    {d}") if d.startswith("★") else yellow(f"    · {d}"))

    print(bold("\n② 能重放吗"))
    print(green("  ✓ 能") if r.replay_ok else red("  ✗ 不能"))
    for x in r.replay_reasons:
        print(dim(f"    · {x}"))

    print(bold("\n③ 程序判出的失败模式"))
    if not r.failures:
        print(dim("  （无）"))
    for f in r.failures:
        print(f"  {bold(f.code)} {f.name}")
        print(dim(f"    {f.evidence}"))

    print(bold("\n④ 成本"))
    print(f"  从 span 算    ${r.cost_from_spans:.4f}")
    print(
        f"  从 metric 算  ${r.cost_from_metrics:.4f}  "
        + red(f"偏差 +{r.cost_error_pct:.0f}%")
    )
    print(dim("  ★ 偏差不是精度问题：gen_ai.token.type 只有 input/output，没有缓存维度"))

    print(bold("\n⑤ 交给人的部分"))
    for h in r.for_humans:
        print(yellow(f"  {h}") if h.startswith("★") else dim(f"  · {h}"))


def main() -> int:
    inc = scenario()
    r = postmortem(inc)
    render(inc, r)

    print(bold("\n\n这份报告的结构本身就是这一节的主张："))
    print("  " + bold("先判这份 trace 可不可信，再看它说了什么。"))
    print(dim("  因为一旦你先看了结论，你就有了立场——和 L12 的五道闸门同一个道理。"))
    print()

    # 不可信就让 CI 红
    return 0 if r.trustworthy else 1


if __name__ == "__main__":
    sys.exit(main())
