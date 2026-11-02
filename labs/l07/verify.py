"""验证 l07/patterns.py。

    uv run python -m l07.verify

一次 API 都不调。

这套测试里有一整组专门盯着**静默失控**：路由兜底指错方向、编排不校验计划、
打磨没有停滞检测、gather 忘了 return_exceptions。
它们都不抛异常，只是让你的账单或者质量安静地变坏。

先跑 VERIFY_TARGET=shared 确认测试本身是对的：
    VERIFY_TARGET=shared uv run python -m l07.verify
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

_target = "shared" if os.environ.get("VERIFY_TARGET") == "shared" else "mine"

if _target == "shared":
    from shared import patterns as P
else:
    from l07 import patterns as P  # type: ignore[no-redef]

print(
    "\n（测的是 shared/ 里的参考实现）" if _target == "shared" else "\n（测的是 l07/ 里你的实现）"
)

_passed = 0
_failures: list[str] = []


def test(name: str, fn: Callable[[], Any]) -> None:
    global _passed
    try:
        result = fn()
        if asyncio.iscoroutine(result):
            asyncio.run(result)
        _passed += 1
        print(f"\033[32m  ✓\033[0m {name}")
    except Exception as err:  # noqa: BLE001 - 测试跑器要吞掉一切
        _failures.append(name)
        print(f"\033[31m  ✕ {name}\033[0m")
        print(f"\033[31m      {err}\033[0m")


def ok(cond: Any, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def raises(fn: Callable[[], Any], hint: str) -> None:
    try:
        result = fn()
        if asyncio.iscoroutine(result):
            asyncio.run(result)
    except NotImplementedError:
        # 脚手架的 TODO 桩也会抛异常。不排除掉的话这些测试会假绿。
        raise
    except Exception:
        return
    raise AssertionError(f"应该抛异常但没有：{hint}")


# ─────────────────────────────────────────────────────────────
# 假模型：记录收到的每一次调用和它的 kwargs
# ─────────────────────────────────────────────────────────────


@dataclass
class _Block:
    type: str
    text: str


@dataclass
class _Usage:
    input_tokens: int
    output_tokens: int


@dataclass
class _Res:
    content: list[_Block]
    usage: _Usage


class Spy:
    def __init__(self, reply: Callable[[str], str], inp: int = 200, out: int = 60) -> None:
        self.reply = reply
        self.inp = inp
        self.out = out
        self.seen: list[dict[str, Any]] = []

    async def __call__(
        self,
        messages: list[dict[str, Any]],
        *,
        system: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> Any:
        content = messages[-1]["content"]
        text = content if isinstance(content, str) else str(content)
        self.seen.append(
            {
                "text": text,
                "system": system,
                "max_tokens": max_tokens,
                "temperature": temperature,
            }
        )
        return _Res(
            content=[_Block("text", self.reply(text))],
            usage=_Usage(input_tokens=self.inp, output_tokens=self.out),
        )


def echo(s: str) -> str:
    return f"处理[{s[:20]}]"


# ─────────────────────────────────────────────────────────────
print("\n链式")
# ─────────────────────────────────────────────────────────────


def three_steps() -> list[Any]:
    return [
        P.ChainStep(name="a", prompt=lambda s: f"A:{s}"),
        P.ChainStep(name="b", prompt=lambda s: f"B:{s}"),
        P.ChainStep(name="c", prompt=lambda s: f"C:{s}"),
    ]


async def _chain_order() -> None:
    s = Spy(echo)
    await P.chain("start", three_steps(), s)
    ok(len(s.seen) == 3, f"应该调用 3 次，实际 {len(s.seen)}")
    ok(s.seen[0]["text"].startswith("A:start"), f"第一步输入不对：{s.seen[0]['text']}")
    ok(s.seen[1]["text"].startswith("B:处理"), f"第二步没拿到第一步的输出：{s.seen[1]['text']}")


test("顺序执行，上一步输出进下一步", _chain_order)


async def _chain_path() -> None:
    r = await P.chain("x", three_steps(), Spy(echo))
    ok(",".join(r.path) == "a,b,c", f"path 不对：{r.path}")


test("path 记录走过的步骤", _chain_path)


async def _chain_usage() -> None:
    r = await P.chain("x", three_steps(), Spy(echo))
    ok(r.usage.calls == 3, f"calls 应该是 3，实际 {r.usage.calls}")
    ok(r.usage.input == 600, f"input 应该是 600，实际 {r.usage.input}")


test("usage 累加所有步骤", _chain_usage)


async def _chain_gate_false() -> None:
    steps = [
        P.ChainStep(name="a", prompt=lambda s: s, gate=lambda _o: False),
        P.ChainStep(name="b", prompt=lambda s: s),
    ]
    s = Spy(echo)
    r = await P.chain("x", steps, s)
    ok(len(s.seen) == 1, f"中止后不该继续调用，实际调了 {len(s.seen)} 次")
    ok(r.stopped_at == "a", f"stopped_at 应该是 'a'，实际 {r.stopped_at}")


test("关口返回 False 时中止", _chain_gate_false)


async def _chain_gate_str() -> None:
    steps = [P.ChainStep(name="check", prompt=lambda s: s, gate=lambda _o: "要点不完整")]
    r = await P.chain("x", steps, Spy(echo))
    got = r.gate_message
    ok(got == "要点不完整", f"gate_message 应该是关口给的字符串，实际 {got!r}")


test("关口返回字符串时把它当作原因", _chain_gate_str)


async def _chain_gate_empty_str() -> None:
    """★ Python 特有：空字符串是 falsy，但它不是 True，所以也该中止。

    写成 `if not verdict` 的话，返回 "" 会被当成"通过"——
    而返回空字符串正是"关口没通过但忘了写原因"这种情况。
    """
    steps = [
        P.ChainStep(name="a", prompt=lambda s: s, gate=lambda _o: ""),
        P.ChainStep(name="b", prompt=lambda s: s),
    ]
    s = Spy(echo)
    r = await P.chain("x", steps, s)
    ok(
        r.stopped_at == "a",
        f"空字符串不是 True，应该中止。实际 stopped_at={r.stopped_at}、调了 {len(s.seen)} 次。\n"
        "      用 `verdict is not True` 而不是 `not verdict`",
    )


test("★ 关口返回空字符串也要中止（is not True，不是 not）", _chain_gate_empty_str)


async def _chain_return_not_raise() -> None:
    steps = [
        P.ChainStep(name="a", prompt=lambda s: s),
        P.ChainStep(name="b", prompt=lambda s: s, gate=lambda _o: False),
        P.ChainStep(name="c", prompt=lambda s: s),
    ]
    r = await P.chain("x", steps, Spy(echo))
    ok(len(r.output) > 0, "output 应该有内容（已经跑完两步了）")
    ok(len(r.path) == 2, f"path 应该有两步，实际 {len(r.path)}")
    ok(r.usage.calls == 2, f"usage 应该记 2 次，实际 {r.usage.calls}")


test("中止是 return 而不是 raise（上游要拿到已产出的部分）", _chain_return_not_raise)


async def _chain_gate_true() -> None:
    steps = [
        P.ChainStep(name="a", prompt=lambda s: s, gate=lambda _o: True),
        P.ChainStep(name="b", prompt=lambda s: s),
    ]
    r = await P.chain("x", steps, Spy(echo))
    ok(r.stopped_at is None, f"不该中止，实际停在 {r.stopped_at}")
    ok(len(r.path) == 2, f"应该走完两步，实际 {len(r.path)}")


test("关口返回 True 时继续", _chain_gate_true)

test(
    "空链要抛异常，不能静默返回输入",
    lambda: raises(
        lambda: P.chain("x", [], Spy(echo)),
        "空链通常是配置读错了，静默返回会让 bug 潜伏很久",
    ),
)

# ─────────────────────────────────────────────────────────────
print("\n路由")
# ─────────────────────────────────────────────────────────────


def make_routes() -> list[Any]:
    async def h(name: str) -> str:
        return f"{name}-handled"

    async def hb(_i: str, _c: Any) -> str:
        return await h("billing")

    async def ht(_i: str, _c: Any) -> str:
        return await h("tech")

    async def hg(_i: str, _c: Any) -> str:
        return await h("general")

    return [
        P.Route("billing", "账单相关", hb),
        P.Route("tech", "技术问题", ht),
        P.Route("general", "其他和分不清的", hg),
    ]


def const(v: str) -> Callable[[str], str]:
    return lambda _p: v


async def _route_clean() -> None:
    r = await P.route("问题", make_routes(), Spy(const("tech")), fallback="general")
    ok(r.picked == "tech", f"应该选 tech，实际 {r.picked}")
    ok(not r.fell_back, "不该走兜底")
    ok(r.output == "tech-handled", f"没调用对应的 handler：{r.output}")


test("干净标签直接命中", _route_clean)


async def _route_dirty() -> None:
    for raw in ["  Billing ", "BILLING", "billing\n", "Billing."]:
        r = await P.route("问题", make_routes(), Spy(const(raw)), fallback="general")
        ok(
            r.picked == "billing" and not r.fell_back,
            f"{raw!r} 应该命中 billing，实际 {r.picked}（兜底={r.fell_back}）。\n"
            "      模型给的标签总带脏东西，硬相等比较会让路由大面积走兜底",
        )


test("带空格和大小写的标签也要命中", _route_dirty)


async def _route_in_sentence() -> None:
    r = await P.route(
        "问题", make_routes(), Spy(const("这个应该归到 tech 类")), fallback="general"
    )
    ok(r.picked == "tech", f"应该捞出 tech，实际 {r.picked}")


test("标签包在句子里也要能捞出来", _route_in_sentence)


async def _route_unknown() -> None:
    r = await P.route("问题", make_routes(), Spy(const("refund")), fallback="general")
    ok(r.picked == "general", f"应该兜底到 general，实际 {r.picked}")
    ok(r.fell_back, "fell_back 应该是 True——它是「分类器该不该重训」的唯一信号")


test("★ 不认识的标签走兜底，而不是抛错或乱选", _route_unknown)


async def _route_rambling() -> None:
    r = await P.route(
        "问题",
        make_routes(),
        Spy(const("我认为这是一个关于产品定价策略的复杂问题，需要综合判断")),
        fallback="general",
    )
    ok(r.fell_back, "这种输出捞不到标签，应该走兜底")
    ok(r.picked == "general", f"实际 {r.picked}")


test("★ 自作聪明的长解释也要能兜住", _route_rambling)


async def _route_raw() -> None:
    r = await P.route("问题", make_routes(), Spy(const("  Billing ")), fallback="general")
    ok("Billing" in r.raw, f"raw 应该保留原始输出，实际 {r.raw!r}")


test("raw 保留模型的原始输出（排查用）", _route_raw)


async def _route_temp() -> None:
    s = Spy(const("tech"))
    await P.route("问题", make_routes(), s, fallback="general")
    ok(
        s.seen[0]["temperature"] == 0,
        f"分类那次调用的 temperature 应该是 0，实际 {s.seen[0]['temperature']}。\n"
        "      分类要的是确定性不是创造力",
    )


test("分类调用用 temperature=0（要确定性，而且可缓存）", _route_temp)


async def _route_maxtok() -> None:
    s = Spy(const("tech"))
    await P.route("问题", make_routes(), s, fallback="general")
    mt = s.seen[0]["max_tokens"]
    ok(
        isinstance(mt, int) and mt <= 64,
        f"max_tokens 应该很小（<=64），实际 {mt}。给大额度模型就开始解释了",
    )


test("分类调用给一个很小的 max_tokens", _route_maxtok)


async def _route_menu() -> None:
    s = Spy(const("tech"))
    await P.route("问题", make_routes(), s, fallback="general")
    p = s.seen[0]["text"]
    for rid in ["billing", "tech", "general"]:
        ok(rid in p, f"分类 prompt 里没有 {rid}")
    ok("账单相关" in p, "when 描述没进 prompt——它是分类准确率的唯一决定因素")


test("分类 prompt 里要列出全部候选和它们的描述", _route_menu)

test(
    "空路由表要抛异常",
    lambda: raises(
        lambda: P.route("问题", [], Spy(const("x")), fallback="general"),
        "没有候选还继续跑，后面必然崩在更远的地方",
    ),
)

# ─────────────────────────────────────────────────────────────
print("\n并行与投票")
# ─────────────────────────────────────────────────────────────


async def _par_order() -> None:
    r = await P.parallel(["a", "b", "c"], Spy(echo))
    ok(len(r.outputs) == 3, f"应该 3 个输出，实际 {len(r.outputs)}")
    ok("a" in (r.outputs[0] or ""), f"第一个输出对不上：{r.outputs[0]}")
    ok("c" in (r.outputs[2] or ""), f"顺序错了：{r.outputs[2]}")


test("全部成功时按输入顺序返回", _par_order)


class Flaky:
    """第 nth 次调用抛异常。"""

    def __init__(self, nth: int) -> None:
        self.nth = nth
        self.n = 0
        self.inner = Spy(echo)

    async def __call__(self, messages: list[dict[str, Any]], **kw: Any) -> Any:
        self.n += 1
        if self.n == self.nth:
            raise RuntimeError(f"第 {self.nth} 个炸了")
        return await self.inner(messages, **kw)


async def _par_settled() -> None:
    r = await P.parallel(["a", "b", "c"], Flaky(2))
    ok(len(r.outputs) == 3, f"长度应该保持 3，实际 {len(r.outputs)}")
    ok(len(r.failed) == 1, f"应该记录 1 个失败，实际 {len(r.failed)}")
    ok(
        len([o for o in r.outputs if o is not None]) == 2,
        "两个成功的应该还在——asyncio.gather 忘了 return_exceptions=True 的话整批都没了",
    )


test("★ 一个失败不拖垮整批（return_exceptions=True）", _par_settled)


async def _par_null_slot() -> None:
    r = await P.parallel(["a", "b"], Flaky(1))
    ok(
        r.outputs[0] is None,
        f"失败位置应该是 None，实际 {r.outputs[0]!r}。压缩列表会让下标和输入对不上",
    )


test("失败的位置用 None 占位，不能压缩列表", _par_null_slot)


async def _par_failed_index() -> None:
    r = await P.parallel(["a", "b", "c"], Flaky(2))
    ok(r.failed[0][0] == 1, f"下标应该是 1，实际 {r.failed[0][0]}")


test("failed 里带得上下标（否则不知道是哪个分片没了）", _par_failed_index)


async def _par_usage() -> None:
    r = await P.parallel(["a", "b", "c"], Flaky(2))
    ok(r.usage.calls == 2, f"calls 应该是 2，实际 {r.usage.calls}")


test("usage 只累加成功的那些", _par_usage)


async def _par_concurrency() -> None:
    state = {"now": 0, "peak": 0}

    async def slow(messages: list[dict[str, Any]], **kw: Any) -> Any:
        state["now"] += 1
        state["peak"] = max(state["peak"], state["now"])
        await asyncio.sleep(0.01)
        state["now"] -= 1
        return await Spy(echo)(messages, **kw)

    await P.parallel(["a", "b", "c", "d", "e", "f"], slow, concurrency=2)
    ok(state["peak"] <= 2, f"并发峰值应该 <=2，实际 {state['peak']}")


test("concurrency 被遵守（Semaphore）", _par_concurrency)

test(
    "投票取多数",
    lambda: ok(
        P.vote(["A", "B", "A", "A", "C"]).winner == "A",
        f"胜者应该是 A，实际 {P.vote(['A', 'B', 'A', 'A', 'C']).winner}",
    ),
)


def _vote_confidence() -> None:
    split = P.vote(["A", "A", "A", "B", "B"])
    clean = P.vote(["A", "A", "A", "A", "A"])
    ok(abs(split.confidence - 0.6) < 1e-9, f"3/5 应该是 0.6，实际 {split.confidence}")
    ok(clean.confidence == 1.0, f"5/5 应该是 1，实际 {clean.confidence}")
    ok(
        split.confidence < clean.confidence,
        "只返回 winner 会把这个差别抹掉，调用方没法区分「勉强多数」和「一致」",
    )


test("★ 投票返回置信度（3:2 和 5:0 是不同的结论）", _vote_confidence)


def _vote_skip_none() -> None:
    v = P.vote(["A", None, "A", None])
    ok(v.confidence == 1.0, f"分母应该只算非 None，实际置信度 {v.confidence}")


test("投票跳过 None（失败的分片不该算进分母）", _vote_skip_none)


def _vote_all_none() -> None:
    v = P.vote([None, None])
    ok(v.winner is None, f"winner 应该是 None，实际 {v.winner}")
    ok(v.confidence == 0.0, f"置信度应该是 0，实际 {v.confidence}")


test("全是 None 时不崩，winner 为 None", _vote_all_none)


def _vote_sorted() -> None:
    v = P.vote(["B", "A", "A", "A", "B", "C"])
    counts = [n for _v, n in v.tally]
    for i in range(1, len(counts)):
        ok(counts[i] <= counts[i - 1], f"tally 没排序：{counts}")


test("tally 按票数降序", _vote_sorted)


def _vote_custom_key() -> None:
    v = P.vote(
        [
            {"label": "yes", "note": "a"},
            {"label": "yes", "note": "b"},
            {"label": "no", "note": "c"},
        ],
        key=lambda o: o["label"],
    )
    ok(v.winner is not None and v.winner["label"] == "yes", f"应该按 label 归并，实际 {v.winner}")
    ok(abs(v.confidence - 2 / 3) < 1e-9, f"置信度应该是 2/3，实际 {v.confidence}")


test("自定义 key 能把等价对象归成一票", _vote_custom_key)


def _vote_unhashable_default() -> None:
    """★ Python 特有：默认 key 不能用对象本身当 dict 键。

    dict 和 list 都不可 hash。TS 那边 JSON.stringify 天然绕过了这件事，
    Python 这边如果直接 buckets[v] 会 TypeError。
    """
    v = P.vote([{"a": 1}, {"a": 1}, {"a": 2}])
    ok(v.confidence > 0.5, f"应该能给 dict 投票（默认 key 要序列化），实际 {v.confidence}")


test("★ 默认 key 要能处理 dict / list（不可 hash）", _vote_unhashable_default)

# ─────────────────────────────────────────────────────────────
print("\n编排-工作者")
# ─────────────────────────────────────────────────────────────


def plan_of(lines: list[str]) -> Callable[[str], str]:
    def reply(prompt: str) -> str:
        return "\n".join(lines) if "拆成" in prompt else "整合后的结果"

    return reply


async def _orch_basic() -> None:
    done: list[str] = []

    async def worker(s: str, _c: Any) -> str:
        done.append(s)
        return f"{s} 的结果"

    r = await P.orchestrate(
        "大任务", Spy(plan_of(["查市场规模", "查竞品", "查定价"])), worker=worker
    )
    ok(len(r.plan) == 3, f"计划应该 3 项，实际 {len(r.plan)}：{r.plan}")
    ok(len(done) == 3, f"worker 应该被调 3 次，实际 {len(done)}")


test("拆出子任务并逐个执行", _orch_basic)


async def _orch_strip() -> None:
    async def worker(s: str, _c: Any) -> str:
        return s

    r = await P.orchestrate(
        "大任务",
        Spy(plan_of(["1. 查市场规模", "- 查竞品", "· 查定价", "2、查渠道"])),
        worker=worker,
    )
    for p in r.plan:
        ok(
            p[0] not in " -*·、)0123456789.",
            f"子任务前缀没剥干净：{p!r}。模型的编号会一路传到 worker 里",
        )


test("剥掉模型爱加的编号和符号", _orch_strip)


async def _orch_dedupe() -> None:
    async def worker(s: str, _c: Any) -> str:
        return s

    r = await P.orchestrate("大任务", Spy(plan_of(["查竞品", "查竞品", "查定价"])), worker=worker)
    ok(len(r.plan) == 2, f"去重后应该 2 项，实际 {len(r.plan)}：{r.plan}")


test("★ 去重（模型爱把同一件事换个说法列两遍）", _orch_dedupe)


async def _worker_id(s: str, _c: Any) -> str:
    return s


test(
    "★ 空计划要抛错，不能静默降级成「直接做整个任务」",
    lambda: raises(
        lambda: P.orchestrate("大任务", Spy(plan_of([])), worker=_worker_id),
        "静默降级会把编排失败伪装成正常运行，你在监控里看不到，只看到质量莫名变差",
    ),
)

test(
    "★ 超过 max_subtasks 要抛错（不设上限是账单事故）",
    lambda: raises(
        lambda: P.orchestrate(
            "大任务",
            Spy(plan_of([f"子任务 {i}" for i in range(40)])),
            worker=_worker_id,
            max_subtasks=8,
        ),
        "40 个子任务就是 40 次调用，模型定的拆法必须有上限",
    ),
)


async def _orch_limit_in_prompt() -> None:
    s = Spy(plan_of(["a", "b"]))
    await P.orchestrate("大任务", s, worker=_worker_id, max_subtasks=5)
    ok("5" in s.seen[0]["text"], f"prompt 里应该告诉模型上限，实际：\n{s.seen[0]['text']}")


test("max_subtasks 要写进 prompt（先让模型别拆那么多）", _orch_limit_in_prompt)


async def _orch_partial_fail() -> None:
    async def worker(s: str, _c: Any) -> str:
        if s == "b":
            raise RuntimeError("b 失败")
        return f"{s} ok"

    r = await P.orchestrate("大任务", Spy(plan_of(["a", "b", "c"])), worker=worker)
    ok(len(r.failed) == 1, f"应该记 1 个失败，实际 {len(r.failed)}")
    ok(len(r.output) > 0, "还有两个成功的，应该照样整合出结果")


test("部分 worker 失败时继续，并记录下来", _orch_partial_fail)


async def _all_fail_worker(_s: str, _c: Any) -> str:
    raise RuntimeError("都挂了")


test(
    "全部 worker 失败时要抛错（没有任何东西可整合）",
    lambda: raises(
        lambda: P.orchestrate("大任务", Spy(plan_of(["a", "b"])), worker=_all_fail_worker),
        "把一份「全部失败」的结果整合成正常输出，是最坏的静默失败",
    ),
)


async def _orch_warn_synth() -> None:
    async def worker(s: str, _c: Any) -> str:
        if s == "b":
            raise RuntimeError("挂了")
        return f"{s} ok"

    s = Spy(plan_of(["a", "b"]))
    await P.orchestrate("大任务", s, worker=worker)
    synth = s.seen[-1]["text"]
    ok(
        any(w in synth for w in ("失败", "缺失", "缺")),
        f"整合 prompt 应该告诉模型有部分缺失，否则它会写得像很完整：\n{synth}",
    )


test("有失败时要在整合 prompt 里说明缺了东西", _orch_warn_synth)


async def _orch_usage() -> None:
    r = await P.orchestrate("大任务", Spy(plan_of(["a", "b"])), worker=_worker_id)
    ok(r.usage.calls == 2, f"应该是 2（计划 + 整合），实际 {r.usage.calls}")


test("usage 含计划调用和整合调用", _orch_usage)

# ─────────────────────────────────────────────────────────────
print("\n评估-优化")
# ─────────────────────────────────────────────────────────────


def scorer(scores: list[float]) -> Callable[[str, Any], Any]:
    i = {"n": 0}

    async def critique(_draft: str, _c: Any) -> Any:
        s = scores[min(i["n"], len(scores) - 1)]
        i["n"] += 1
        return P.Critique(score=s, feedback="再改改")

    return critique


async def _refine_target() -> None:
    r = await P.refine(
        "任务", Spy(echo), critique=scorer([0.9]), max_rounds=5, target_score=0.8
    )
    ok(r.reason == "target_reached", f"reason 应该是 target_reached，实际 {r.reason}")
    ok(r.rounds == 1, f"应该 1 轮就停，实际 {r.rounds}")


test("达到目标分就停", _refine_target)


async def _refine_stall() -> None:
    r = await P.refine(
        "任务",
        Spy(echo),
        critique=scorer([0.5, 0.62, 0.63, 0.63, 0.63]),
        max_rounds=5,
        target_score=0.95,
        min_gain=0.05,
    )
    ok(
        r.reason == "no_improvement",
        f"reason 应该是 no_improvement，实际 {r.reason}。\n"
        "      评估者永远能挑出毛病，所以必须有改进检测这道软闸",
    )
    ok(r.rounds < 5, f"应该提前停，实际跑满了 {r.rounds} 轮")


test("★ 分数停滞时停（只有轮数上限的话每次都跑满）", _refine_stall)


async def _refine_round_limit() -> None:
    r = await P.refine(
        "任务",
        Spy(echo),
        critique=scorer([0.1, 0.3, 0.5, 0.7]),
        max_rounds=3,
        target_score=0.95,
        min_gain=0.01,
    )
    ok(r.reason == "round_limit", f"reason 应该是 round_limit，实际 {r.reason}")
    ok(r.rounds == 3, f"应该跑满 3 轮，实际 {r.rounds}")


test("撞轮数上限时 reason 是 round_limit", _refine_round_limit)


async def _refine_history() -> None:
    r = await P.refine(
        "任务",
        Spy(echo),
        critique=scorer([0.2, 0.4, 0.6]),
        max_rounds=3,
        target_score=0.95,
        min_gain=0.01,
    )
    ok(len(r.history) == 3, f"history 应该 3 项，实际 {r.history}")
    ok(r.history[0] == 0.2, f"第一轮分数不对：{r.history[0]}")


test("history 记录每轮分数（唯一能看出原地打转的东西）", _refine_history)


async def _refine_keep_best() -> None:
    r = await P.refine(
        "任务",
        Spy(echo),
        critique=scorer([0.7, 0.3, 0.2]),
        max_rounds=3,
        target_score=0.95,
        min_gain=-1,  # 关掉停滞检测，强迫它跑满
    )
    ok(
        r.score == 0.7,
        f"score 应该是历史最优 0.7，实际 {r.score}。\n"
        "      打磨会让结果变差，只留最后一版会把这件事藏起来",
    )


test("★ 分数下降时保留历史最优，不无脑接受最后一版", _refine_keep_best)


async def _refine_zero_score_first() -> None:
    """★ Python 里 best_score 初值写成 0 而不是 -inf 时，这条会挂。

    第一轮拿到 0 分，gain = 0 - 0 = 0 < min_gain，
    于是被误判成"没有提升"——而它其实是第一轮，还没有基线可比。
    """
    r = await P.refine(
        "任务",
        Spy(echo),
        critique=scorer([0.0, 0.9]),
        max_rounds=3,
        target_score=0.8,
        min_gain=0.05,
    )
    ok(
        r.reason == "target_reached",
        f"第一轮 0 分不该被判成停滞，实际 reason={r.reason}、rounds={r.rounds}。\n"
        "      best_score 初值要用 float('-inf')，而且第一轮不做停滞判断",
    )


test("★ 第一轮不做停滞判断（初值要 -inf，不是 0）", _refine_zero_score_first)


async def _refine_no_gate() -> None:
    r = await P.refine(
        "任务",
        Spy(echo),
        critique=scorer([0.5, 0.5, 0.5, 0.5, 0.5]),
        max_rounds=4,
        target_score=0.95,
        min_gain=0,
    )
    ok(r.rounds == 4, f"min_gain=0 时应该跑满，实际 {r.rounds}")


test("min_gain 是 0 时不提前停（用来对照省了多少）", _refine_no_gate)


async def _refine_feedback() -> None:
    s = Spy(echo)

    async def critique(_d: str, _c: Any) -> Any:
        return P.Critique(score=0.1, feedback="开头太啰嗦")

    await P.refine(
        "任务", s, critique=critique, max_rounds=2, target_score=0.9, min_gain=-1
    )
    revise = s.seen[1]["text"]
    ok("开头太啰嗦" in revise, f"改稿 prompt 里没有评审意见：\n{revise}")


test("改稿时把评审意见带上（否则模型不知道要改什么）", _refine_feedback)

# ─────────────────────────────────────────────────────────────
print("\n选型判据")
# ─────────────────────────────────────────────────────────────


def shape(**kw: Any) -> Any:
    base = {
        "steps_known": True,
        "independent": False,
        "needs_branching": False,
        "has_quality_bar": False,
        "error_cost": "low",
    }
    base.update(kw)
    return P.Shape(**base)  # type: ignore[arg-type]


for _name, _kw, _want in [
    ("步骤已知且独立 → 并行", {"steps_known": True, "independent": True}, "parallel"),
    ("步骤已知且有依赖 → 链式", {"steps_known": True, "independent": False}, "chain"),
    ("路径有限但要选一条 → 路由", {"steps_known": True, "needs_branching": True}, "route"),
    (
        "拆法要模型定但子任务独立 → 编排",
        {"steps_known": False, "independent": True},
        "orchestrate",
    ),
    (
        "★ 步骤未知 + 需要分支 + 错误代价低 → 这才是 agent",
        {
            "steps_known": False,
            "independent": False,
            "needs_branching": True,
            "error_cost": "low",
        },
        "agent",
    ),
]:

    def _check(kw: dict[str, Any] = _kw, want: str = _want) -> None:
        c = P.choose_pattern(shape(**kw))
        ok(c.pattern == want, f"应该是 {want}，实际 {c.pattern}：{c.why}")

    test(_name, _check)


def _no_agent_when_costly() -> None:
    c = P.choose_pattern(
        shape(
            steps_known=False, independent=False, needs_branching=True, error_cost="high"
        )
    )
    ok(
        c.pattern != "agent",
        f"错误代价高还选 agent 就错了：{c.why}\n"
        "      这一条判断必须放在 agent 之前，否则永远轮不到它",
    )


test("★ 错误代价高时不选 agent（自主性此时是缺点）", _no_agent_when_costly)


def _why_readable() -> None:
    for s in [shape(), shape(steps_known=False, needs_branching=True)]:
        c = P.choose_pattern(s)
        ok(len(c.why) > 8, f"why 太短：{c.why!r}")


test("why 能读懂（它要进设计文档和 code review）", _why_readable)

# ─────────────────────────────────────────────────────────────
print("\n" + "─" * 60)
if not _failures:
    print(f"\033[32m{_passed} 项全过。\033[0m")
    print("\n接着跑 uv run python -m l07.compare，量一次 workflow 和 agent 的成本差别。")
else:
    print(f"\033[31m{_passed} 过，{len(_failures)} 败：\033[0m")
    for f in _failures:
        print(f"\033[31m  · {f}\033[0m")
    raise SystemExit(1)
