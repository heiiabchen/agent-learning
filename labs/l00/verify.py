"""
验证 shared/resilience.py 的三个函数。跑法：uv run python -m l00.verify

和 TS 版一样，这里一次 API 都没调——全部用「可控的假失败」来测。
真实故障等不来（本地网络从来不超时、从来不返回 429），就得自己造。
这套「注入故障 → 断言行为」的思路就是 L12 evals 的雏形。

比 TS 版多了两条 Python 专属的测试，都带 ☆：
  · 取消必须能穿透 with_retry。CancelledError 继承 BaseException 而不是
    Exception，正是为了让 `except Exception` 不会误吞它。写成 `except BaseException`
    的话，一个 Ctrl-C 会被当成「可重试的失败」，程序反而更卖力地重试。
  · 别人的取消不能被报成「我超时了」。asyncio.timeout() 替你处理了这件事，
    但只有真的测过你才知道它做对了。
"""

from __future__ import annotations

import asyncio
import time

from shared.resilience import is_retriable, pooled, with_retry, with_timeout

passed = 0
failures: list[str] = []


async def test(name: str, fn) -> None:
    global passed
    try:
        await fn()
        passed += 1
        print(f"\x1b[32m  ✓\x1b[0m {name}")
    except AssertionError as err:
        failures.append(name)
        print(f"\x1b[31m  ✕ {name}\x1b[0m")
        print(f"\x1b[31m      {err}\x1b[0m")


async def raises(fn) -> BaseException:
    """期待 fn 抛错，把错误交回来给调用方断言。"""
    try:
        await fn()
    except BaseException as e:  # noqa: BLE001 — 测试代码，要抓全
        return e
    raise AssertionError("期待抛错，但它成功返回了")


class FakeStatusError(Exception):
    """模拟 SDK 的 APIStatusError：带 status_code 的那一类。"""

    def __init__(self, status_code: int, message: str = "fake") -> None:
        super().__init__(message)
        self.status_code = status_code


async def never() -> None:
    """一个永不返回的假请求。"""
    await asyncio.Event().wait()


def flaky(fail_times: int, error: BaseException):
    """造一个「前 n 次失败，之后成功」的假请求，并记录被调用了几次。"""
    state = {"calls": 0}

    async def fn() -> str:
        state["calls"] += 1
        if state["calls"] <= fail_times:
            raise error
        return "ok"

    return fn, lambda: state["calls"]


# ── with_timeout ─────────────────────────────────────────────────────────────


async def suite_timeout() -> None:
    print("\nwith_timeout")

    async def ok() -> None:
        async def forty_two() -> int:
            return 42

        out = await with_timeout(1, forty_two())
        assert out == 42, f"期待 42，实际 {out}"

    await test("正常返回时原样透传结果", ok)

    async def times_out() -> None:
        err = await raises(lambda: with_timeout(0.06, never()))
        assert isinstance(err, TimeoutError), (
            f"期待 TimeoutError，实际 {type(err).__name__}: {err}\n"
            "      asyncio.timeout() 到期时会把内部的 CancelledError 转成 TimeoutError。\n"
            "      如果你看到的是 CancelledError，说明你自己写了 wait_for/cancel 而没做这层转换。"
        )

    await test("超时抛 TimeoutError", times_out)

    async def inner_error_passthrough() -> None:
        boom = RuntimeError("业务错误")

        async def explode() -> None:
            raise boom

        err = await raises(lambda: with_timeout(1, explode()))
        assert err is boom, f"期待原样抛出业务错误，实际拿到 {type(err).__name__}: {err}"

    await test("函数自身抛的错要原样抛出，不能被误判成超时", inner_error_passthrough)

    async def foreign_cancel_not_timeout() -> None:
        # 外面的人取消我们，不是我们超时。这两件事必须区分开，
        # 否则重试逻辑会把「用户按了 Ctrl-C」当成「网络抖了一下」。
        task = asyncio.create_task(with_timeout(30, never()))
        await asyncio.sleep(0.02)
        task.cancel()
        err = await raises(lambda: task)
        assert isinstance(err, asyncio.CancelledError), (
            f"期待 CancelledError 原样传出，实际 {type(err).__name__}。\n"
            "      别人的取消不能被伪装成自己的超时。"
        )

    await test("☆ 外部取消原样传出，不会被伪装成超时", foreign_cancel_not_timeout)


# ── with_retry ───────────────────────────────────────────────────────────────

FAST = {"tries": 3, "base_ms": 5}


async def suite_retry() -> None:
    print("\nwith_retry")

    async def once_on_success() -> None:
        fn, calls = flaky(0, RuntimeError("never raised"))
        await with_retry(fn, **FAST)
        assert calls() == 1, f"期待 1 次，实际 {calls()} 次"

    await test("成功时只调用一次", once_on_success)

    async def retries_429() -> None:
        fn, calls = flaky(1, FakeStatusError(429))
        out = await with_retry(fn, **FAST)
        assert out == "ok" and calls() == 2, f"期待重试后成功，实际调用 {calls()} 次"

    await test("429 会重试", retries_429)

    async def gives_up_on_400() -> None:
        fn, calls = flaky(99, FakeStatusError(400))
        await raises(lambda: with_retry(fn, **FAST))
        assert calls() == 1, f"期待 1 次就放弃，实际 {calls()} 次"

    await test("400 立刻放弃，不浪费钱", gives_up_on_400)

    async def retries_network_error() -> None:
        fn, calls = flaky(1, ConnectionResetError("socket hang up"))
        out = await with_retry(fn, **FAST)
        assert out == "ok" and calls() == 2, (
            f"期待重试后成功，实际只调用了 {calls()} 次。"
            "超时、连接重置、DNS 失败都没有 status_code，它们恰恰是最该重试的一类。\n"
            "      注意 Python 这边字段叫 status_code，不是 TS 的 status。"
        )

    await test("★ 没有 status_code 的网络层错误必须重试", retries_network_error)

    async def raises_original() -> None:
        original = FakeStatusError(503, "我是原始错误")
        fn, _ = flaky(99, original)
        err = await raises(lambda: with_retry(fn, **FAST))
        assert err is original, "期待原样抛出最后一次的错误，丢掉它线上就无法定位了"

    await test("重试用尽后抛的是原始错误，不是包装过的", raises_original)

    async def really_backs_off() -> None:
        fn, calls = flaky(99, FakeStatusError(503))
        t = time.perf_counter()
        await raises(lambda: with_retry(fn, tries=3, base_ms=40))
        spent = (time.perf_counter() - t) * 1000
        assert calls() == 3, f"期待尝试 3 次，实际 {calls()} 次"
        # 两次等待：40 + 80 = 120ms 起步，抖动只会更多
        assert spent >= 110, f"总耗时 {spent:.0f}ms，看起来没有真的退避"

    await test("退避真的在等，而且次数对得上", really_backs_off)

    async def timeout_is_retriable() -> None:
        state = {"calls": 0}

        async def attempt() -> str:
            state["calls"] += 1
            if state["calls"] == 1:
                return await with_timeout(0.06, never())

            async def fine() -> str:
                return "ok"

            return await with_timeout(1, fine())

        out = await with_retry(attempt, **FAST)
        assert out == "ok" and state["calls"] == 2, (
            f"期待超时后重试并成功，实际调用 {state['calls']} 次。"
            "这是最值钱的一条：两个函数单独看都对，组合起来才暴露问题。"
        )

    await test("★★ 组合场景：with_retry 包住 with_timeout 时，超时能被重试", timeout_is_retriable)

    async def cancel_pierces_retry() -> None:
        calls = {"n": 0}

        async def cancellable() -> None:
            calls["n"] += 1
            await asyncio.Event().wait()

        task = asyncio.create_task(with_retry(cancellable, **FAST))
        await asyncio.sleep(0.02)
        task.cancel()
        err = await raises(lambda: task)
        assert isinstance(err, asyncio.CancelledError), (
            f"期待 CancelledError 穿透 with_retry，实际 {type(err).__name__}。\n"
            "      把 except Exception 写成 except BaseException 就会踩这个坑：\n"
            "      Ctrl-C 会被当成可重试的失败，程序反而更卖力地重试。"
        )
        assert calls["n"] == 1, f"取消之后不该再重试，实际调用了 {calls['n']} 次"

    await test("☆ 取消能穿透 with_retry，不会被当成可重试的失败", cancel_pierces_retry)


# ── pooled ───────────────────────────────────────────────────────────────────


async def suite_pooled() -> None:
    print("\npooled")

    async def limits_concurrency() -> None:
        state = {"running": 0, "peak": 0}

        async def work(_item: int, _i: int) -> None:
            state["running"] += 1
            state["peak"] = max(state["peak"], state["running"])
            await asyncio.sleep(0.02)
            state["running"] -= 1

        await pooled([1, 2, 3, 4, 5, 6], 2, work)
        assert state["peak"] == 2, f"并发峰值应该是 2，实际是 {state['peak']}"

    await test("并发确实被限制住了", limits_concurrency)

    async def preserves_order() -> None:
        # 故意让后面的任务先完成
        async def work(ms: int, i: int) -> int:
            await asyncio.sleep(ms / 1000)
            return i

        out = await pooled([50, 10, 30], 3, work)
        assert out == [0, 1, 2], (
            f"期待 [0, 1, 2]，实际 {out}。结果必须按输入下标放，不能按完成顺序 append。"
        )

    await test("结果顺序和输入一致，不受完成先后影响", preserves_order)

    async def one_failure_isolated() -> None:
        async def work(n: int, _i: int) -> int:
            if n == 2:
                raise RuntimeError("第二个坏了")
            return n

        out = await pooled([1, 2, 3], 2, work)
        ok = [r for r in out if not isinstance(r, BaseException)]
        assert len(ok) == 2, f"应该有 2 个成功，实际 {len(ok)}"
        assert isinstance(out[1], BaseException), "第二个应该是异常对象而不是被吞掉"

    await test("一个失败不影响其余，失败信息被保留", one_failure_isolated)


# ── is_retriable ─────────────────────────────────────────────────────────────


async def suite_classify() -> None:
    print("\nis_retriable")

    async def classify() -> None:
        cases = [
            (FakeStatusError(429), True, "429 限流"),
            (FakeStatusError(503), True, "503 暂时不可用"),
            (FakeStatusError(400), False, "400 参数错，重试只是烧钱"),
            (FakeStatusError(401), False, "401 密钥错，重试一万次也一样"),
            (ConnectionResetError(), True, "连接重置，没有 status_code"),
            (TimeoutError(), True, "超时，没有 status_code"),
        ]
        for err, want, why in cases:
            got = is_retriable(err)
            assert got == want, f"{why}：期待 {want}，实际 {got}"

    await test("状态码分类和「无 status 即网络层故障」都对", classify)


async def main() -> None:
    await suite_timeout()
    await suite_retry()
    await suite_pooled()
    await suite_classify()

    total = passed + len(failures)
    print(f"\n{'─' * 46}")
    if not failures:
        print(f"\x1b[32m全绿 {passed}/{total}。\x1b[0m")
        return
    print(f"\x1b[31m{len(failures)}/{total} 没过：\x1b[0m")
    for f in failures:
        print(f"  · {f}")
    raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
