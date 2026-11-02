"""
shared/resilience.ts 的 Python 对照版。

同样是三个函数，同样从 L05 的 agent loop 用到 L19 的部署。
但这个文件值得逐行读——因为**两种语言的取消模型根本不同**，
而 L00 那两个坑在 Python 里的表现完全不一样：

┌─ 坑一：没有 status 的错误要不要重试
│  两边一致：超时、连接重置、DNS 失败都属于网络层瞬时故障，要重试。
│  但取字段的名字不一样，抄错了不会报错，只会静默不重试：
│      TS      err.status
│      Python  err.status_code        ← 注意这个下划线
│
└─ 坑二：「是不是我超时了」
   TS 里你必须自己记账：你传给 abort() 的 reason 会被 SDK 原地丢掉，
   所以只能回头问自己的 controller（ctl.signal.aborted）。
   Python 里 asyncio.timeout() 替你记了这笔账——它只在自己的 deadline
   到期时才把 CancelledError 转成 TimeoutError，别人的取消照原样穿过去。
   同一类 bug，一门语言让你手写，另一门语言送给你。

改动这个文件之后跑一次 `uv run python -m l00.verify`。
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from typing import TypeVar

R = TypeVar("R")
T = TypeVar("T")

# 可重试的 HTTP 状态码。没有 status 的错误另行判断，见 with_retry。
RETRIABLE_STATUS = frozenset({408, 409, 429, 500, 502, 503, 504, 529})


def is_retriable(err: BaseException) -> bool:
    # 关键的一行：拿不到 status_code 说明请求根本没走完 HTTP 往返——
    # 连接被重置、超时、DNS 挂了，这些恰恰是最该重试的情况。
    status = getattr(err, "status_code", None)
    if status is None:
        return True
    return status in RETRIABLE_STATUS


async def with_timeout(seconds: float, coro: Awaitable[R]) -> R:
    """
    给任意 awaitable 加超时。超时抛 TimeoutError。

    和 TS 版签名的差别值得留意：TS 收的是 `(signal) => Promise<R>`，
    因为 JS 没有真正的取消——你只能递一个 signal 进去，求被调方自己看着办。
    Python 是真取消：超时会在 coro 当前挂起的那个 await 点抛 CancelledError，
    所以直接收一个 awaitable 就够了，不需要往下传 signal。

    代价是 Python 的取消是「协作式」的：如果被调方 catch 了 CancelledError
    还不往上抛，取消就丢了。写 except Exception 的时候小心别顺手吞掉它——
    CancelledError 继承自 BaseException 正是为了防这一手。
    """
    async with asyncio.timeout(seconds):
        return await coro


async def with_retry(
    make_coro: Callable[[], Awaitable[R]],
    *,
    tries: int = 4,
    base_ms: float = 1000,
) -> R:
    """
    分类过的指数退避 + 抖动。

    收的是「造 coroutine 的工厂」而不是 coroutine 本身：coroutine 是一次性的，
    await 过就不能再 await。TS 那边收 `() => Promise<R>` 是同一个道理——
    Promise 虽然可以重复 await，但重复 await 拿到的是同一个结果，不会真的重发请求。
    """
    last_error: BaseException | None = None

    for attempt in range(tries):
        try:
            return await make_coro()
        except Exception as err:  # noqa: BLE001 — 分类交给 is_retriable
            last_error = err
            if not is_retriable(err):
                raise
            if attempt == tries - 1:
                break
            base = base_ms * 2**attempt
            wait_ms = round(base + random.random() * base * 0.3)
            print(f"\x1b[33m第 {attempt + 1} 次失败，{wait_ms}ms 后重试\x1b[0m")
            await asyncio.sleep(wait_ms / 1000)

    assert last_error is not None
    raise last_error


async def pooled(
    items: list[T],
    limit: int,
    worker: Callable[[T, int], Awaitable[R]],
) -> list[R | BaseException]:
    """
    带上限的并发池。返回值和 items 一一对应、顺序不变，失败的位置放异常对象。

    `return_exceptions=True` 是 Python 这边的地道写法，等价于 TS 的
    Promise.allSettled——一个失败不拖垮整批。区别是 TS 返回
    `{status, value | reason}` 的包装对象，Python 直接把异常塞回原位，
    所以取结果的时候得 isinstance 判一下。用 split_results() 省这一步。

    和 TS 版的实现差异：TS 那边是 N 个 worker 抢一个游标，协程数恒等于 limit；
    这里是一次性建 len(items) 个协程，靠 Semaphore 卡住并发数。
    几百个任务无所谓，几十万个就该换成 asyncio.Queue 的消费者模式了。
    """
    sem = asyncio.Semaphore(limit)

    async def guarded(item: T, index: int) -> R:
        async with sem:
            return await worker(item, index)

    return await asyncio.gather(
        *(guarded(item, i) for i, item in enumerate(items)),
        return_exceptions=True,
    )


def split_results(results: list[R | BaseException]) -> tuple[list[R], list[BaseException]]:
    """把 pooled 的返回值拆成「成功的」和「失败的」两堆。"""
    ok: list[R] = []
    bad: list[BaseException] = []
    for r in results:
        if isinstance(r, BaseException):
            bad.append(r)
        else:
            ok.append(r)
    return ok, bad
