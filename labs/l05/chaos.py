"""
L05 · 任务三（Python 通道）：故意制造失控，看防线响不响。

跑法：uv run python -m l05.chaos        （不调 API）

四个场景我写好了，第五个（取消）你补。
每个场景的说明和那道设计题见 l05/chaos.ts。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from shared.agent import REASON_TEXT, run_agent
from shared.fake import FakeModel, FakeTurn
from shared.ledger import Ledger
from shared.tools import ParseOk, ToolBox, ToolDef, ToolResult


def tools() -> ToolBox:
    async def noop(_inp: Any) -> ToolResult:
        return ToolResult(content="（看到了一些东西）")

    return ToolBox(
        [
            ToolDef(
                name="peek",
                description="看一眼",
                input_schema={"type": "object", "properties": {"at": {"type": "string"}}},
                parse=lambda raw: ParseOk(input=raw),
                run=noop,
            )
        ]
    )


@dataclass
class Scenario:
    name: str
    why: str
    script: list[FakeTurn]
    expect: list[str]
    after: str = "final"
    opts: dict = field(default_factory=dict)


SCENARIOS = [
    Scenario(
        name="场景一 · 丢了 tool_use 块导致的死循环",
        why=(
            "真模型不会这样，但**你的代码 bug 会导致这个效果**：\n"
            "    assistant 消息放回历史时丢了 tool_use 块，模型每轮都重新要求同一件事。\n"
            "    这是最常见的一种 agent 死循环，特征是调用完全一样、参数都不变。"
        ),
        script=[FakeTurn(tool_uses=[{"name": "peek", "input": {"at": "same-place"}}])],
        after="repeat_last",
        opts={"max_steps": 20, "repeat_limit": 2},
        expect=["repeat"],
    ),
    Scenario(
        name="场景二 · 有变化但没进展（重复检测挡不住）",
        why=(
            "每次参数都不同，所以重复检测**完全无效**——这是它的能力边界。\n"
            "    只有步数上限能兜住。这就是为什么两道防线都要有：\n"
            "    重复检测更精准但覆盖窄，步数上限更钝但兜得住底。"
        ),
        script=[
            FakeTurn(tool_uses=[{"name": "peek", "input": {"at": f"place-{i}"}}]) for i in range(50)
        ],
        opts={"max_steps": 8, "repeat_limit": 2},
        expect=["step_limit"],
    ),
    Scenario(
        name="场景三 · 单步就烧爆预算",
        why=(
            "步数上限在这里完全没用——它只跑了一两步。\n"
            "    成本上限防的是另一个维度：**每一步的成本差异可以有两个数量级**。\n"
            "    一次 list_dir 和一次读进 50KB 文件，不该用同一个计数器衡量。"
        ),
        script=[
            FakeTurn(tool_uses=[{"name": "peek", "input": {"at": "x"}}], usage=(3_000_000, 800_000))
        ],
        after="repeat_last",
        opts={"max_steps": 100, "max_yuan": 0.3, "repeat_limit": 999},
        expect=["budget"],
    ),
    Scenario(
        name="场景四 · 输出被 max_tokens 截断",
        why=(
            "这一步最容易被写成 done——stop_reason 不是 tool_use，看着就是「说完了」。\n"
            "    但那句话是残缺的。报 done 等于把半截答案当成完整答案交出去，\n"
            "    而它**看起来完全像个答案**。"
        ),
        script=[FakeTurn(text="这个文件的作用是……", stop_reason="max_tokens")],
        expect=["error"],
    ),
]


# ─────────────────────────────────────────────────────────────────────────────
# TODO · 补上场景五：取消
#
#   Python 这边有两条路，都试一下，它们的差异就是本节 PyMirror 讲的那件事：
#
#     a) is_cancelled 回调（轮询式）
#     b) asyncio.create_task + task.cancel()（异常式）
#
#   两条路都要确认三件事：
#     · reason 是 'cancelled' 而不是 'error'
#     · 已花掉的钱出现在 usage 里
#     · transcript 里有部分结果
#
#   ★ 走 b) 的时候注意：如果 run_agent 里写的是 `except Exception`，
#     它**抓不到** CancelledError（继承 BaseException），异常会穿出来。
#     这是 Python 特有的坑，TS 那边不存在。
#
# 然后回答 l05/chaos.ts 里那道设计题（场景二的 maxSteps 改成 100 会怎样）。
# ─────────────────────────────────────────────────────────────────────────────


async def run_scenario(s: Scenario) -> bool:
    fake = FakeModel(s.script, after=s.after)  # type: ignore[arg-type]
    ledger = Ledger(s.name)
    run = await run_agent(
        "做点事", toolbox=tools(), system="test", call=fake.call, ledger=ledger, **s.opts
    )

    hit = run.reason in s.expect
    mark = "\x1b[32m✓\x1b[0m" if hit else "\x1b[31m✕\x1b[0m"

    print(f"\n\x1b[1m{s.name}\x1b[0m")
    print(f"  \x1b[2m{s.why}\x1b[0m")
    print(
        f"  {mark} reason={run.reason}（期待 {' 或 '.join(s.expect)}）· {REASON_TEXT[run.reason]}"
    )
    print(f"     步数 {run.steps} · 工具 {len(run.trace)} 次 · 花了 ¥{run.usage.yuan:.4f}")
    if run.error:
        print(f"     异常：{run.error}")
    return hit


async def amain() -> None:
    print("故意制造失控，看每条防线响不响。（不调 API）")
    ok = sum([await run_scenario(s) for s in SCENARIOS])
    print(f"\n{'─' * 60}")
    print(f"{ok}/{len(SCENARIOS)} 条防线按预期响了。")
    print("把 TODO 里的场景五补上，五条就齐了。")


if __name__ == "__main__":
    asyncio.run(amain())
