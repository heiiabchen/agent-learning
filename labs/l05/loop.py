"""
L05 · 任务一（Python 通道）：写你自己的 agent loop。

跑法：uv run python -m l05.loop        验证：uv run python -m l05.verify

`shared/agent.py` 里有我的实现。**先别看。**

完整任务说明（五个终止条件、六个必须做对的点、重复检测）见 l05/loop.ts。

Python 这边有一个 TS 那边不存在的坑，而且它很重要：

★ **`except Exception` 抓不到 CancelledError。**

从 3.8 起 asyncio.CancelledError 继承 BaseException 而不是 Exception。
这个设计是故意的——防止你用宽泛的 except 意外吞掉取消。

所以你的 try 要分开写：

    try:
        res = await call(messages)
    except asyncio.CancelledError:
        return finish("cancelled")       # 取消
    except Exception as err:
        return finish("error", err)      # 真故障

顺序不能反（CancelledError 要写在前面），而且**别用裸 `except:`**
——那个会两种都抓到，然后你就分不出「用户点了停止」和「线上有 bug」了。

★ 第二个 Python 专属的坑：**闭包捕获的是变量，不是值。**

如果你在循环里定义一个 async 函数、里面引用外层的 `steps`，
它拿到的是「await 那一刻的 steps」，不是「定义那一刻的 steps」。
在这个 loop 里恰好安全（gather 当轮就 await 完了），但只要有人改成
「先创建任务、稍后再 await」，trace 里的 step 就会全指向最后一轮。

这类 bug 不报错、不崩溃，只是让你的调试记录说谎。
把 step 当参数显式传进去，别靠闭包。ruff 的 B023 规则查的就是这个。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from shared.ledger import Ledger, Totals
from shared.tools import ToolBox

StopReason = Literal["done", "step_limit", "budget", "timeout", "cancelled", "repeat", "error"]


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
    steps: int
    usage: Totals
    transcript: list[dict]
    trace: list[TraceEntry] = field(default_factory=list)
    error: BaseException | None = None


# ─────────────────────────────────────────────────────────────────────────────
# TODO 1 · repeat_key(name, raw_input)
#
#   ★ 不能直接 json.dumps(raw_input)：字段顺序变了 key 就变了，防线静默失效。
#     递归排序 dict 的 key，但**保留 list 的顺序**（数组顺序有语义）。
#     顺便忽略 None 值。
#
# TODO 2 · run_agent(...)
#
#   五个终止条件全在循环顶部；六个必须做对的点见 l05/loop.ts。
#   并发执行工具用 asyncio.gather——它和 Promise.all 一样保序。
#
# TODO 3 · 用假模型跑三个场景（正常 / 死循环 / 取消），见 l05/loop.ts。
# ─────────────────────────────────────────────────────────────────────────────


def repeat_key(name: str, raw_input: Any) -> str:
    raise NotImplementedError("TODO 1")


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
    raise NotImplementedError("TODO 2")


def main() -> None:
    raise NotImplementedError("把 TODO 3 写完，然后删掉这一行")


if __name__ == "__main__":
    main()
