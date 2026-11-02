"""
Agent loop。shared/agent.ts 的 Python 对照版。

核心逻辑十行，其余全是防止失控的代码。这个比例就是 L05 的主要结论。

─── Python 和 TS 在「取消」上的关键差异 ──────────────────────────────────

TS 那边取消是**信号 + 你自己检查**：AbortSignal 传下去，各处 if (aborted)。
Python 这边取消是**在 await 点抛 CancelledError**。

后者看起来更自动，但对 agent loop 来说反而更麻烦，原因是：
**我们需要在取消时返回部分结果**——已经做了几步、花了多少钱。
异常路径上带出部分结果是能做的（把它挂在异常对象上），但很别扭。

所以这里用的是显式的 `is_cancelled` 回调，而不是依赖 CancelledError。
调用方给一个「现在该停了吗」的函数，循环在顶部问它。
这和 TS 版形状一致，也让部分结果能正常 return 出去。

同时 call() 抛出的 CancelledError 仍然要处理——那是真的在等待中被取消了。
★ 注意 `except Exception` **抓不到** CancelledError（它继承 BaseException），
这是故意的语言设计，防止你用宽泛的 except 意外吞掉取消。
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from shared.ledger import Entry, Ledger, Totals, Usage
from shared.message import text_of
from shared.tools import ToolBox, ToolResult, tool_result_message, tool_uses_of

StopReason = Literal["done", "step_limit", "budget", "timeout", "cancelled", "repeat", "error"]

PREVIEW = 120


@dataclass
class TraceEntry:
    step: int
    tool_name: str
    input: Any
    ok: bool
    preview: str
    ms: float


@dataclass
class AgentRun:
    text: str
    reason: StopReason
    """
    ★ 整个返回值里最重要的字段。

    只返回 text 的话，撞上步数上限时模型最后那句话**看起来像个答案**，
    调用方会拿去用。L12 做 evals 时 reason 的分布是最先看的指标。
    """

    steps: int
    usage: Totals
    transcript: list[dict]
    trace: list[TraceEntry] = field(default_factory=list)
    error: BaseException | None = None


def _stable(v: Any) -> str:
    """
    递归排序之后再序列化。

    ★ 不能直接 json.dumps(input)：字段顺序变了 key 就变了，防线静默失效。
    Python 的 json.dumps 有 sort_keys=True，但它**不排序嵌套在 list 里的 dict**
    ——实际上它会，但数组本身的顺序要保留（数组顺序有语义）。
    这里显式写一遍，免得依赖某个参数的具体行为。
    """
    if isinstance(v, dict):
        items = sorted((k, _stable(x)) for k, x in v.items() if x is not None)
        return "{" + ",".join(f"{json.dumps(k)}:{x}" for k, x in items) + "}"
    if isinstance(v, list):
        return "[" + ",".join(_stable(x) for x in v) + "]"
    return json.dumps(v, ensure_ascii=False)


def repeat_key(name: str, raw_input: Any) -> str:
    return f"{name}:{_stable(raw_input)}"


async def run_agent(
    task: str,
    *,
    toolbox: ToolBox,
    system: str,
    call: Callable[[list[dict]], Awaitable[Any]],
    max_steps: int = 20,
    max_yuan: float = 1.0,
    max_ms: float = 120_000,
    is_cancelled: Callable[[], bool] | None = None,
    ledger: Ledger | None = None,
    repeat_limit: int = 2,
    on_step: Callable[[TraceEntry], None] | None = None,
) -> AgentRun:
    _ = system  # system 由 call 闭包持有，这里只是把它列进签名让调用点更清楚
    ledger = ledger or Ledger("agent")
    messages: list[dict] = [{"role": "user", "content": task}]
    trace: list[TraceEntry] = []
    seen: dict[str, int] = {}
    t0 = time.perf_counter()
    steps = 0
    last_text = ""

    def finish(reason: StopReason, error: BaseException | None = None) -> AgentRun:
        return AgentRun(
            text=last_text,
            reason=reason,
            steps=steps,
            usage=ledger.totals(),
            transcript=messages,
            trace=trace,
            error=error,
        )

    while True:
        # ── 五个终止条件，全部在循环顶部 ────────────────────────────────
        if steps >= max_steps:
            return finish("step_limit")
        if ledger.totals().yuan > max_yuan:
            return finish("budget")
        if (time.perf_counter() - t0) * 1000 > max_ms:
            return finish("timeout")
        if is_cancelled and is_cancelled():
            return finish("cancelled")

        steps += 1
        started = time.perf_counter()

        try:
            res = await call(messages)
        except asyncio.CancelledError:
            # ★ 这里**不重新抛出**是刻意的：agent loop 的契约是返回部分结果。
            #   如果你的调用方需要 CancelledError 继续向上传播（比如它自己也在
            #   一个 task 里被取消），那应该由调用方看到 reason == 'cancelled'
            #   之后自己决定要不要 raise。
            return finish("cancelled")
        except Exception as err:
            return finish("error", err)

        ledger.record(
            Entry(
                label=f"step {steps}",
                id=res.id,
                model=res.model,
                usage=Usage.from_sdk(res.usage),
                ms=(time.perf_counter() - started) * 1000,
            )
        )

        # assistant 那条必须**原样**放回去，包含 tool_use 块。
        # 丢掉的话模型下一轮看不到自己要求过什么，会重新要求 → 死循环。
        messages.append({"role": "assistant", "content": res.content})

        text = text_of(res.content)
        if text:
            last_text = text

        if res.stop_reason != "tool_use":
            if res.stop_reason == "max_tokens":
                # 半截答案不能当成完整答案交出去（L02 那条纪律）
                return finish("error", RuntimeError("输出被 max_tokens 截断，答案不完整"))
            return finish("done")

        uses = tool_uses_of(res.content)
        if not uses:
            # 协议上不该发生，但真发生了要能停——否则下一轮完全一样 → 死循环
            return finish(
                "error", RuntimeError("stop_reason 是 tool_use 但 content 里没有 tool_use 块")
            )

        # step 显式作为参数传进去，不靠闭包捕获。
        # 闭包捕获的是**变量**而不是值，而 steps 在下一轮会变——
        # 这里恰好安全（gather 在本轮就 await 完了），但只要有人把它改成
        # 「先创建任务、稍后再 await」就会静默错乱：trace 里的 step 全指向最后一轮。
        # 这类 bug 不报错、不崩溃，只是让你的调试记录说谎。
        async def exec_one(u: Any, step: int) -> ToolResult:
            name = u["name"] if isinstance(u, dict) else u.name
            raw = u["input"] if isinstance(u, dict) else u.input
            key = repeat_key(name, raw)
            n = seen.get(key, 0) + 1
            seen[key] = n

            if n > repeat_limit:
                # 不静默跳过——那样模型不知道发生了什么，只会更困惑。
                # 要让它知道自己在打转，并给一条出路。
                return ToolResult(
                    content=(
                        f"你已经用完全相同的参数调用了 {name} {n} 次，结果不会变。"
                        "换个思路，或者说明你卡在哪、需要什么才能继续。"
                    ),
                    is_error=True,
                    log_note=f"重复调用 {name} 第 {n} 次",
                )

            at = time.perf_counter()
            r = await toolbox.execute(name, raw)
            entry = TraceEntry(
                step=step,
                tool_name=name,
                input=raw,
                ok=not r.is_error,
                preview=r.content[:PREVIEW].replace("\n", "␤"),
                ms=(time.perf_counter() - at) * 1000,
            )
            trace.append(entry)
            if on_step:
                on_step(entry)
            return r

        # gather 和 Promise.all 一样**保序**：返回顺序跟传入顺序一致，
        # 不是完成顺序。顺序抖动 → 前缀缓存失效 + 问题无法复现。
        results = await asyncio.gather(*(exec_one(u, steps) for u in uses))

        messages.append(tool_result_message(uses, list(results)))

        if all((r.log_note or "").startswith("重复调用") for r in results):
            return finish("repeat")


REASON_TEXT: dict[str, str] = {
    "done": "正常完成",
    "step_limit": "撞上步数上限（可能是死循环，去看 trace 里有没有重复的调用）",
    "budget": "超出成本预算",
    "timeout": "超时",
    "cancelled": "被取消",
    "repeat": "检测到重复调用，agent 卡住了",
    "error": "出错",
}
