"""L06 任务二：压缩策略与「什么时候不压」（Python 版）。

    uv run python -m l06.compress

不调 API——压缩用的模型也是假的（shared/fake.py），所以这个任务完全离线。
参考实现在 shared/compress.py。

这个任务里最值钱的不是 compress，是 should_compress。
决定「什么时候不压」比「怎么压」更省钱。
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from shared.context_budget import DEFAULT_BUDGET, ContextStats, input_budget
from shared.parse import extract_tag

Message = dict[str, Any]

# ─────────────────────────────────────────────────────────────
# TODO 1：结构化摘要的 prompt
#
# ★ 「总结一下前面的对话」得到的是一段散文，模型下一步没法用。
# 必须给固定结构——这是 L03 那条「结构化输出要用标签约束」的直接应用。
#
# 五个标签：goal / done / found / failed / next
#
# 三条硬要求要写进 prompt 里：
#   1. goal 必须是原文，不改写不概括（目标漂移是长任务的头号失败模式）
#   2. failed 不能省。没失败过就写「无」，但不要跳过这一节
#   3. found 里的路径和行号要原样保留
# ─────────────────────────────────────────────────────────────


def summary_prompt() -> str:
    raise NotImplementedError("TODO: 实现 summary_prompt")


# ─────────────────────────────────────────────────────────────
# TODO 2：摘要的解析与渲染
#
# ★ 缺了标签要**抛异常**，不能静默接受。
#
# 静默接受一个缺了 <failed> 的摘要，等于把防线关掉了：
# agent 会把失败过的方法再试一遍，而且会升级成循环
# （试 A 失败 → 试 B 失败 → 压缩丢了 failed → 再试 A）。
# 重复检测（L05）拦不住它，因为参数往往略有不同。
#
# 用 shared/parse.py 里的 extract_tag。注意区分两种情况：
#   标签不存在（extract_tag 返回 None）→ 抛异常
#   标签存在但内容是「无」→ 合法，解析成空 list
#
# ★ Python 专属的坑：`if not failed` 会把这两种情况混起来，
# 因为 None 和 "" 都是假值。必须写 `if failed is None`。
# TS 那边 `failed === null` 是显式的，这里很容易顺手写成 falsy 判断。
# ─────────────────────────────────────────────────────────────


@dataclass
class Summary:
    goal: str
    done: list[str] = field(default_factory=list)
    found: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    next: str = ""


class SummaryError(Exception):
    def __init__(self, missing: str) -> None:
        super().__init__(f"摘要里缺了 <{missing}>")


def render_summary(s: Summary) -> str:
    raise NotImplementedError("TODO: 实现 render_summary")


def parse_summary(text: str) -> Summary:
    raise NotImplementedError("TODO: 实现 parse_summary")


# ─────────────────────────────────────────────────────────────
# TODO 3：滑动窗口
#
# 只留最近 keep_turns 条。最便宜（不调模型），但最粗暴。
#
# ★ 两个不变量必须守住，否则会构造出 API 直接拒绝的消息序列：
#   1. 第一条（原始任务）永远保留
#   2. 不能让一个 tool_result 失去它对应的 tool_use
#
# 第二条的实现要点：切点落在携带 tool_result 的 user 消息上时，
# 往后挪一位再切。这个 bug 在测试里很容易漏掉，因为它只在
# 切点恰好落在工具轮次中间时才出现。
# ─────────────────────────────────────────────────────────────


def sliding_window(messages: Sequence[Message], keep_turns: int = 6) -> list[Message]:
    raise NotImplementedError("TODO: 实现 sliding_window")


# ─────────────────────────────────────────────────────────────
# TODO 4：摘要压缩
#
# 返回的新消息序列是：[原始任务, 摘要, ...最近 keep_recent 条]
#
# 同样要守住 tool_use / tool_result 的配对。
# call 抽象成参数，让 verify 能塞假模型——和 run_agent 同一个模式。
# ─────────────────────────────────────────────────────────────


@dataclass
class CompressResult:
    messages: list[Message]
    summary: Summary
    saved: int
    cost: dict[str, int]


async def compress(
    messages: Sequence[Message],
    call: Callable[[list[Message]], Awaitable[Any]],
    keep_recent: int = 4,
) -> CompressResult:
    raise NotImplementedError("TODO: 实现 compress")


# ─────────────────────────────────────────────────────────────
# TODO 5：该不该压 —— 这个文件最值钱的函数
#
# ★ 只看当前长度是不够的，必须把「预计还要走多少步」算进来。
#
# 原因：压缩改写了历史 → 前缀变了 → 从改动点往后的 KV cache 全部作废
# （L05x 那条纪律）。压缩之后的那一次调用要重新 prefill 全部内容，付全价。
#
# 这笔账：
#   省下的 = (当前长度 - 目标长度) × 剩余步数 × 缓存折扣
#   花掉的 = 压缩调用本身 + 一次全额 prefill（失去缓存折扣）
#
# **剩余步数少的时候，不压更便宜。**
#
# 还要处理两个边界：
#   没到触发线            → 不压
#   已经到可用额度的 90%  → 无条件压（这时候不是省钱问题，是能不能跑的问题）
#
# why 字段要能读——它会进日志，而日志是给三个月后的你看的。
# ─────────────────────────────────────────────────────────────


@dataclass
class CompressDecision:
    compress: bool
    why: str
    net: float | None = None


def should_compress(
    stats: ContextStats,
    steps_left: int,
    cache_discount: float = 0.1,
) -> CompressDecision:
    raise NotImplementedError("TODO: 实现 should_compress")


# ─────────────────────────────────────────────────────────────
# 观察实验
# ─────────────────────────────────────────────────────────────

GOOD_SUMMARY = """<goal>读懂 src/auth 模块，说明登录流程，找出安全问题</goal>
<done>
- 定位入口：src/auth/login.py:34 的 handle_login
- 读完 session 管理：src/auth/session.py，用的是 JWT，7 天过期
</done>
<found>
- src/auth/login.py:88 密码比较用的是 == 而不是 hmac.compare_digest
- src/auth/session.py:12 JWT 密钥从环境变量读，但有一个硬编码的默认值
</found>
<failed>
- 试过用 search_code 搜 "bcrypt"，零结果——这个项目没用 bcrypt
- 试过读 src/auth/crypto.py，文件不存在
</failed>
<next>看 src/auth/middleware.py 确认 token 校验的时机</next>"""

LAZY_SUMMARY = """<goal>看看那个 auth 模块</goal>
<done>
- 看了几个文件，大致了解了登录流程
</done>
<found>
- 用的是 JWT
</found>
<next>继续看</next>"""


def demo_summary_quality() -> None:
    print("\n【一】两份摘要，差别在哪")

    print("\n  好的那份：")
    good = parse_summary(GOOD_SUMMARY)
    print(f"    goal   {good.goal}")
    print(f"    done   {len(good.done)} 条")
    print(f"    found  {len(good.found)} 条（带路径和行号）")
    print(f"    failed {len(good.failed)} 条 ← 关键")

    print("\n  偷懒的那份（缺 failed）：")
    try:
        parse_summary(LAZY_SUMMARY)
        print("    解析通过了 —— 这是个 bug，缺 failed 应该被拦住")
    except SummaryError as err:
        print(f"    被拦下：{err}")

    print("\n  另外注意 goal 那一行：好的那份是原文，偷懒的那份被概括成了")
    print("  「看看那个 auth 模块」——**安全问题这个要求消失了**。")
    print("  再压缩两次，agent 就在做一件和原始请求只有远亲关系的事。")


def _fake_stats(ratio: float, work: int = 75_300) -> ContextStats:
    available = input_budget(DEFAULT_BUDGET)
    return ContextStats(
        tokens=round(available * ratio),
        ratio=ratio,
        breakdown={"system": 900, "tool_defs": 1800, "task": 400, "summary": 0, "work": work},
        top="work",
        budget=DEFAULT_BUDGET,
    )


def demo_decision() -> None:
    print("\n【二】同样的长度，该压还是不该压")
    print("唯一的变量是「预计还要走多少步」。\n")

    stats = _fake_stats(0.7)
    for steps_left in (1, 2, 5, 10, 30):
        d = should_compress(stats, steps_left)
        print(f"  还剩 {steps_left:>2} 步 → {'压' if d.compress else '不压'}　{d.why}")

    print("\n  长度一模一样，结论相反。因为压缩的收益乘的是剩余步数，")
    print("  而代价（重建缓存）是一次性的。**剩余步数少的时候，不压更便宜。**")


def demo_ceiling() -> None:
    print("\n【三】快撑爆时的例外")

    for ratio in (0.5, 0.65, 0.88, 0.95):
        d = should_compress(_fake_stats(ratio, work=1), steps_left=1)
        print(
            f"  占 {round(ratio * 100):>2}% · 剩 1 步 → "
            f"{'压' if d.compress else '不压'}　{d.why}"
        )

    print("\n  到 90% 之后即使只剩一步也要压——这时候不是省钱问题，")
    print("  是「下一步的工具结果会不会直接把窗口撑爆」的问题。")


def _has(m: Message | None, kind: str) -> bool:
    if m is None or isinstance(m.get("content"), str):
        return False
    return any(isinstance(b, dict) and b.get("type") == kind for b in m["content"])


def demo_sliding() -> None:
    print("\n【四】滑动窗口的 tool_use 配对陷阱")

    msgs: list[Message] = [{"role": "user", "content": "原始任务"}]
    for i in range(6):
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

    print(f"\n  原始 {len(msgs)} 条")
    for keep in (3, 4, 5, 6):
        out = sliding_window(msgs, keep)
        orphan = any(
            i > 0 and _has(m, "tool_result") and not _has(out[i - 1], "tool_use")
            for i, m in enumerate(out)
        )
        mark = "✗ 有 tool_result 找不到它的 tool_use" if orphan else "✓ 配对完整"
        print(f"  keep={keep} → {len(out)} 条 · {mark}")

    print("\n  上面某个 keep 值出现 ✗ 的话，那就是这个坑：切点落在工具轮次中间，")
    print("  tool_result 失去了它的 tool_use，然后 API 直接报 400。")
    print("  注意它只在特定的 keep 值下出现——只测一个值很容易漏掉。")


async def demo_compress_roundtrip() -> None:
    """用假模型走一遍完整的压缩，看新消息序列长什么样。"""
    print("\n【五】压缩前后的消息序列")

    from shared.fake import FakeModel, FakeTurn

    msgs: list[Message] = [{"role": "user", "content": "读懂 src/auth，找出安全问题"}]
    for i in range(8):
        msgs.append(
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": f"t{i}",
                        "name": "read_file",
                        "input": {"path": f"src/auth/m{i}.py"},
                    }
                ],
            }
        )
        msgs.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": f"t{i}",
                        "content": "def handler():\n    pass\n" * 60,
                    }
                ],
            }
        )

    model = FakeModel([FakeTurn(text=GOOD_SUMMARY, usage=(9000, 300))])
    res = await compress(msgs, model.call, keep_recent=4)

    print(f"\n  压缩前 {len(msgs)} 条 → 压缩后 {len(res.messages)} 条")
    print(f"  估算省下 {res.saved} tok，这次压缩本身花了 "
          f"{res.cost['input']} 输入 + {res.cost['output']} 输出")
    print(f"  摘要里保住了 {len(res.summary.failed)} 条失败记录")
    print("\n  第一条还是原始任务，第二条是摘要，后面是最近的几轮。")
    print("  ★ 注意 saved 减掉了摘要自己的长度——压缩不是免费的，")
    print("    它把一段长历史换成了一段短文本，而不是换成空。")


# ─────────────────────────────────────────────────────────────
# TODO 6：亲手算一次那笔账
#
# 把 demo_decision 里的 cache_discount 从默认的 0.1 改成 1
# （相当于"没有 prompt 缓存"）。
#
# 结论会怎么变？为什么？
# 然后回答：如果你的 agent 完全没用 prompt 缓存，压缩策略该更激进还是更保守？
# ─────────────────────────────────────────────────────────────


async def main() -> None:
    print("压缩不是越多越好。这个任务重点在「什么时候不压」。")
    demo_summary_quality()
    demo_decision()
    demo_ceiling()
    demo_sliding()
    await demo_compress_roundtrip()
    print("\n" + "─" * 60)
    print("下一个任务把这套东西接到 L05 的 agent 上，跑一个真的长任务。")
    print("别忘了 TODO 6。")


if __name__ == "__main__":
    asyncio.run(main())
