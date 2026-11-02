"""验证 l11/orchestrate.py。跑法：

    cd labs && uv run python -m l11.verify

一次 API 都不调。多 agent 的全部难点都在校验和会计上，
而这两件事都是纯函数——**能用假的测的东西，就不要用真的测。**

带 ★ 的每一条对应一个静默失效：
空引用、重复劳动、写覆盖、矛盾被糊掉、被掐断的报告当成完成、
预算只查一次、递归无上限、交接成环。

它们的共同点是**不抛异常**。全都表现为"成功返回了一个质量不错的答案"，
然后出现在账单上或者错误结论里。

最后一组是 Python 独有的：gather 的返回值语义、以及 CancelledError
不是 Exception 子类这件事。这两个坑在 TS 那边不存在。

先跑 MULTI_IMPL=shared uv run python -m l11.verify 确认测试本身是对的。
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import Awaitable, Callable
from typing import Any

from shared import multi as shared
from shared.ledger import Totals
from shared.multi import Brief, CostShape, FanoutOptions, Report

TARGET = "shared" if os.environ.get("MULTI_IMPL") == "shared" else "mine"

if TARGET == "shared":
    M: Any = shared
    print("\n（测的是 shared/ 里的参考实现）")
else:
    from l11 import orchestrate as M  # type: ignore[no-redef]

    print("\n（测的是 l11/ 里你的实现）")

passed = 0
failures: list[str] = []


async def test(name: str, fn: Callable[[], Any | Awaitable[Any]]) -> None:
    global passed
    try:
        r = fn()
        if asyncio.iscoroutine(r):
            await r
        passed += 1
        print(f"\033[32m  ✓ {name}\033[0m")
    except Exception as err:  # noqa: BLE001
        failures.append(name)
        print(f"\033[31m  ✕ {name}\033[0m")
        print(f"\033[31m      {err}\033[0m")


def assert_(cond: object, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


# ─── 素材 ────────────────────────────────────────────────────


def brief(**over: Any) -> Brief:
    base: dict[str, Any] = dict(
        agent="w1",
        goal="梳理 2020-2022 年汽车芯片危机的成因",
        context="在写一份供应链行业报告，读者是投资人。报告分三部分，你负责第一部分。",
        deliverable="一份时间线，每节点标注日期、事件、影响",
        boundaries=["不要涉及 2023 年之后"],
        tools=["web_search"],
    )
    base.update(over)
    return Brief(**base)


def totals(yuan: float) -> Totals:
    return Totals(
        calls=3, input_tokens=9000, output_tokens=600,
        cache_read=0, cache_write=0, ms=3000, yuan=yuan,
    )


def report(**over: Any) -> Report:
    base: dict[str, Any] = dict(
        agent="w1", ok=True, summary="结论：甲", evidence=["a://1"],
        usage=totals(0.01), steps=3, reason="done",
    )
    base.update(over)
    return Report(**base)


def kinds(b: Brief) -> list[str]:
    return [p.kind for p in M.check_brief(b).problems]


SHAPE = CostShape(tool_def_tokens=911, tool_result_tokens=1200, brief_tokens=180, report_tokens=300)


def opts(**over: Any) -> FanoutOptions:
    base: dict[str, Any] = dict(max_agents=4, max_depth=2, max_yuan=1.0, concurrency=4)
    base.update(over)
    return FanoutOptions(**base)


def runner(yuan: float = 0.01) -> Callable[[Brief], Awaitable[Report]]:
    async def run(b: Brief) -> Report:
        return report(agent=b.agent, summary=f"结论：{b.agent}", usage=totals(yuan))

    return run


# ─────────────────────────────────────────────────────────────


async def main() -> None:  # noqa: C901, PLR0915
    print("\n任务书体检")

    await test("一份写清楚的任务书能过", lambda: assert_(
        M.check_brief(brief()).ok, f"应该通过，实际报了 {kinds(brief())}"
    ))

    await test("★ 「上面提到的」是空引用（sub-agent 看不到编排者的上下文）", lambda: assert_(
        "dangling_reference" in kinds(brief(context="按上面提到的规则来做")),
        "这是这一节最要紧的一条检查。\n"
        "      「上面提到的」在编排者的上下文里有明确所指，在 sub-agent 那里是空引用——\n"
        "      而它不会报错：它会编一个所指出来，基于编出来的东西干完整个任务，\n"
        "      最后交回一份格式正确、语气自信、内容和你要的毫无关系的报告",
    ))

    await test("英文的 as mentioned 同样要查出来", lambda: assert_(
        "dangling_reference" in kinds(brief(goal="Summarize as mentioned above")), "英文指代没查"
    ))

    await test("★ 没有 boundaries 要报（这是重复劳动的唯一成因）", lambda: assert_(
        "no_boundaries" in kinds(brief(boundaries=[])),
        "三个 sub-agent 都被派去「研究供应链」时，只有边界能让它们分头查不同的部分",
    ))

    await test("context 空要报", lambda: assert_(
        "no_context" in kinds(brief(context="")), "context 空没报"
    ))

    await test("deliverable 空要报", lambda: assert_(
        "no_deliverable" in kinds(brief(deliverable="")), "deliverable 空没报"
    ))

    await test("tools 空（不限工具）要报", lambda: assert_(
        "no_tools" in kinds(brief(tools=[])), "不限工具等于让它自己发明工作范围"
    ))

    await test("目标太宽要报（「研究」「分析」这类）", lambda: assert_(
        "goal_too_vague" in kinds(brief(goal="研究供应链")), "宽目标没报"
    ))

    def t_all_problems() -> None:
        got = kinds(Brief(agent="w", goal="分析", context="", deliverable=""))
        assert_(
            len(got) >= 4,
            f"只报了 {len(got)} 个：{got}。\n"
            "      报一个就返回的话，修一个跑一次，五个问题要跑五轮",
        )

    await test("★ 多个问题要一次全报出来，不是报第一个就返回", t_all_problems)

    # ─────────────────────────────────────────────────────────
    print("\n重复劳动")

    def t_chip() -> None:
        bs = [
            brief(agent="a", goal="研究半导体短缺", deliverable="报告"),
            brief(agent="b", goal="研究半导体供应链现状", deliverable="报告"),
            brief(agent="c", goal="调查半导体供应链短缺的现状", deliverable="报告"),
        ]
        o = M.detect_overlap(bs)
        assert_(
            len(o) >= 2,
            f"只查出 {len(o)} 组重叠。\n"
            "      这是 Anthropic 生产里的真实故障：一个 agent 查了 2021 年的汽车芯片危机，\n"
            "      另外两个查了同一件事。而 sub-agent 之间不共享上下文，\n"
            "      **它们没有任何办法发现自己在做重复的活**——症状只有「这次特别贵」",
        )

    await test("★ 三份换词版的任务书要被查出重叠", t_chip)

    def t_bigram() -> None:
        o = M.detect_overlap([
            brief(agent="a", goal="梳理供应链危机的成因", deliverable="时间线"),
            brief(agent="b", goal="梳理供应链短缺的成因", deliverable="时间线"),
        ])
        assert_(
            len(o) == 1,
            "按整词匹配的话这两条一个共同词都没有（「危机」vs「短缺」），重叠查不出来。\n"
            "      而它们实际上在查同一件事",
        )

    await test("★ 中文要切二元组，否则「供应链危机」和「供应链短缺」对不上", t_bigram)

    def t_no_overlap() -> None:
        bs = [
            brief(agent="a", goal="梳理 2021 年汽车芯片危机的时间线",
                  deliverable="按日期排列的事件表"),
            brief(agent="b", goal="统计 2026 年晶圆厂产能", deliverable="厂商与月产能对照表"),
            brief(agent="c", goal="梳理出口管制清单", deliverable="按地区分组的风险条目"),
        ]
        assert_(not M.detect_overlap(bs), f"不该报重叠，实际报了 {M.detect_overlap(bs)}")

    await test("边界写清楚的三份任务书不该报重叠", t_no_overlap)

    def t_denominator() -> None:
        # 窄任务整个被宽任务包含。用并集当分母会把分数摊薄到阈值以下。
        o = M.detect_overlap([
            brief(agent="wide", goal="统计晶圆厂产能与制程节点与在建产线与投产时间",
                  deliverable="大表"),
            brief(agent="narrow", goal="统计晶圆厂产能", deliverable="大表"),
        ])
        assert_(
            len(o) == 1,
            "窄任务整个被宽任务包含，这是重复劳动最典型的形状。\n"
            "      用并集当分母会把分数摊薄——而「一个 agent 的活全被另一个覆盖了」\n"
            "      恰恰是最该报出来的那种",
        )

    await test("★ 分母用较短那份，不是并集", t_denominator)

    # ─────────────────────────────────────────────────────────
    print("\n写冲突")

    def t_conflict() -> None:
        bs = [
            brief(agent="a", goal="把 src/api.py 的回调改成 async",
                  deliverable="改好的 src/api.py", tools=["edit_file"]),
            brief(agent="b", goal="给 src/api.py 补类型标注",
                  deliverable="改好的 src/api.py", tools=["edit_file"]),
        ]
        c = M.check_write_conflicts(bs)
        assert_(
            len(c) >= 1,
            "两份任务书都能通过 check_brief（边界写了、工具限了、目标具体）。\n"
            "      但后写的会覆盖先写的，而且**两边都认为自己成功了**——\n"
            "      两份报告都说「已完成」，编排者合并出「重构完成，类型已补齐」，而类型没了",
        )
        assert_(len(c[0].agents) == 2, f"冲突里应该有两个 agent，实际 {c[0]}")

    await test("★ 两个 agent 写同一个文件要报冲突", t_conflict)

    def t_readonly() -> None:
        bs = [
            brief(agent="a", goal="读 src/api.py 总结它的导出",
                  deliverable="清单", tools=["read_file"]),
            brief(agent="b", goal="读 src/api.py 找出未使用的导入",
                  deliverable="清单", tools=["read_file"]),
        ]
        assert_(
            not M.check_write_conflicts(bs),
            "只读不该报冲突——这正是「并行 sub-agent 必须只读」的意思",
        )

    await test("只读的 agent 不该报写冲突", t_readonly)

    def t_run_command() -> None:
        bs = [
            brief(agent="a", goal="跑 build.sh 构建",
                  deliverable="dist/out.js", tools=["run_command"]),
            brief(agent="b", goal="跑 bundle.sh 打包",
                  deliverable="dist/out.js", tools=["run_command"]),
        ]
        assert_(M.check_write_conflicts(bs), "run_command 能改任何东西，必须算写工具")

    await test("run_command 也算写工具", t_run_command)

    # ─────────────────────────────────────────────────────────
    print("\n投入分级")

    def t_single_thread() -> None:
        e = M.plan_effort(independent_threads=1, needs_write=False, exceeds_context=False)
        assert_(e.tier == "single" and e.agents == 1, f"应该是 single/1，实际 {e.tier}/{e.agents}")

    await test("单线程 → single", t_single_thread)

    def t_write_wins() -> None:
        e = M.plan_effort(independent_threads=8, needs_write=True, exceeds_context=False)
        assert_(
            e.tier == "single" and e.agents == 1,
            f"实际 {e.tier}/{e.agents}。\n"
            "      八个模块听起来很适合并行，但它要写文件。\n"
            "      **「能拆」和「能并行」是两件事**，而 needs_write 的优先级必须最高",
        )

    await test("★ 要写就是 single，哪怕有八个独立方向", t_write_wins)

    def t_small() -> None:
        e = M.plan_effort(independent_threads=3, needs_write=False, exceeds_context=False)
        assert_(e.tier == "small_fanout" and e.agents == 3, f"实际 {e.tier}/{e.agents}")

    await test("3 个方向、只读、塞得下 → small_fanout", t_small)

    def t_cap() -> None:
        e = M.plan_effort(independent_threads=12, needs_write=False, exceeds_context=True)
        assert_(
            e.tier == "large_fanout" and e.agents <= 10,
            f"实际开了 {e.agents} 个。\n"
            "      Anthropic 早期版本的真实故障是一个简单查询开了 50 个 sub-agent。\n"
            "      模型判断不了该投入多少，所以这条规则必须是代码",
        )

    await test("★ 12 个方向也不能开 12 个（上限 10）", t_cap)

    def t_why() -> None:
        for kw in [
            dict(independent_threads=1, needs_write=False, exceeds_context=False),
            dict(independent_threads=3, needs_write=False, exceeds_context=False),
            dict(independent_threads=9, needs_write=False, exceeds_context=True),
            dict(independent_threads=4, needs_write=True, exceeds_context=False),
        ]:
            assert_(len(M.plan_effort(**kw).why) > 10, f"{kw} 的 why 是空的——判据要能被 review")

    await test("每一档都要有 why", t_why)

    # ─────────────────────────────────────────────────────────
    print("\n合并报告")

    def t_conflicts() -> None:
        m = M.merge_reports([
            report(agent="a", summary="减产：1050 万辆"),
            report(agent="b", summary="减产：770 万辆"),
        ])
        assert_(
            len(m.conflicts) == 1,
            f"应该报 1 处矛盾，实际 {len(m.conflicts)}。\n"
            "      编排者只看到摘要，看不到任何一份原始材料——**它没有能力判断哪个对**。\n"
            "      让它「综合一下」的结果是「减产约 800 至 1000 万辆」这种句子：\n"
            "      读起来很顺、有具体数字、而且两个来源都不支持它。\n"
            "      这是多 agent 里最难发现的错误，因为输出**看起来质量很高**",
        )
        assert_(len(m.conflicts[0]["agents"]) == 2, "矛盾里要标出是哪几个 agent 说的")

    await test("★ 矛盾要原样列出，不许挑一个", t_conflicts)

    def t_agree() -> None:
        m = M.merge_reports([
            report(agent="a", summary="减产：1050 万辆"),
            report(agent="b", summary="减产：1050 万辆"),
        ])
        assert_(not m.conflicts, f"一致的结论不该报矛盾，实际 {m.conflicts}")

    await test("结论一致时不报矛盾", t_agree)

    def t_step_limit() -> None:
        m = M.merge_reports([report(agent="a", reason="step_limit")])
        assert_(
            len(m.gaps) == 1,
            "L05 那条判据在这里第二次用上：**被掐断的运行不是做完了的运行。**\n"
            "      它的最后一句话往往像个答案，而编排者会拿去用",
        )
        assert_("结论：甲" not in m.summary, "被掐断的报告不该进 summary")

    await test("★ reason=step_limit 的报告进 gaps，不进结论", t_step_limit)

    def t_failed_gap() -> None:
        m = M.merge_reports([
            report(agent="a"),
            report(agent="b", ok=False, reason="超时", summary=""),
        ])
        assert_(
            any(g["agent"] == "b" for g in m.gaps),
            "静默丢掉的后果是「结论少了一条」，而那看起来像模型没找到——\n"
            "      于是你会去调 prompt，而真正的问题是一个超时",
        )

    await test("★ 失败的 agent 要变成显式 gap，不能消失", t_failed_gap)

    def t_dedupe() -> None:
        m = M.merge_reports([
            report(agent="a", evidence=["a://1", "a://2"]),
            report(agent="b", evidence=["a://2", "a://3"]),
        ])
        assert_(len(m.evidence) == 3, f"应该去重成 3 条，实际 {m.evidence}")

    await test("证据引用要去重", t_dedupe)

    await test("空输入不炸", lambda: assert_(
        not M.merge_reports([]).conflicts and not M.merge_reports([]).gaps,
        "空输入应该返回空结果而不是抛异常",
    ))

    # ─────────────────────────────────────────────────────────
    print("\n拓扑选型")

    def topo(**over: Any) -> Any:
        base: dict[str, Any] = dict(
            independent_threads=3, needs_write=False, exceeds_context=False,
            has_dependencies=False, value_per_task="high", needs_specialist_switch=False,
        )
        base.update(over)
        return M.choose_topology(**base)

    await test("3 个独立方向、只读、高价值 → multi_agent", lambda: assert_(
        topo().topology == "multi_agent", f"实际 {topo().topology}"
    ))

    await test("★ 有依赖 → workflow，不是 multi_agent", lambda: assert_(
        topo(has_dependencies=True).topology == "workflow",
        "步骤之间有依赖的时候，依赖关系应该写在代码里，\n"
        "      不该让模型在运行时协调——那是 L07 那节的结论，在这里再用一次",
    ))

    await test("★ 要写 → single", lambda: assert_(
        topo(needs_write=True).topology == "single",
        "并行 sub-agent 看不到彼此的写入，而且都会报告成功",
    ))

    await test("★ 价值低且塞得下 → single（15 倍成本没东西抵）", lambda: assert_(
        topo(value_per_task="low").topology == "single",
        "有并行空间不等于该并行。多 agent 的 15 倍 token 成本要有东西来抵——\n"
        "      任务单次价值低的时候，先用单 agent",
    ))

    await test("单线程 + 要换专长 → handoff", lambda: assert_(
        topo(independent_threads=1, needs_specialist_switch=True).topology == "handoff",
        "一条线程但中途换专长，交接比派 sub-agent 便宜——不用重新组装上下文",
    ))

    def t_topo_why() -> None:
        for over in [
            {}, dict(has_dependencies=True), dict(needs_write=True),
            dict(value_per_task="low"),
            dict(independent_threads=1, needs_specialist_switch=True),
        ]:
            assert_(len(topo(**over).why) > 10, f"{over} 的 why 是空的")

    await test("每个分支都要有 why", t_topo_why)

    # ─────────────────────────────────────────────────────────
    print("\n派发（四道闸）")

    async def t_normal() -> None:
        r = await M.fanout([brief(agent="a"), brief(agent="b")], runner(), opts())
        assert_(len(r.reports) == 2, f"应该 2 份报告，实际 {len(r.reports)}")

    await test("正常派发：每个 brief 一份报告", t_normal)

    async def t_preflight() -> None:
        bs = [brief(agent="a", boundaries=[]), brief(agent="b")]
        r = await M.fanout(bs, runner(), opts())
        assert_(
            r.preflight.brief_problems.get("a"),
            "重复劳动和写冲突一旦派出去就无法挽回——钱已经花了、文件已经被覆盖了。\n"
            "      而它们在派发前是**完全可以静态查出来的**，所以体检结果必须返回",
        )

    await test("★ 体检结果要返回给调用方，不是打个日志", t_preflight)

    async def t_max_agents() -> None:
        bs = [brief(agent=f"a{i}") for i in range(1, 7)]
        r = await M.fanout(bs, runner(), opts(max_agents=3))
        assert_(len(r.reports) == 3, f"应该只跑 3 个，实际 {len(r.reports)}")
        assert_(
            len(r.rejected) == 3,
            f"被截掉的 3 个应该出现在 rejected 里，实际 {len(r.rejected)} 条。\n"
            "      静默截断的后果是「结论少了一条」，而那看起来像模型没找到",
        )

    await test("★ 超过 max_agents 的要显式列进 rejected，不能静默截断", t_max_agents)

    async def t_budget() -> None:
        bs = [brief(agent=f"a{i}") for i in range(1, 5)]
        r = await M.fanout(bs, runner(0.4), opts(max_yuan=1.0, concurrency=1))
        assert_(
            any("预算" in x["reason"] for x in r.rejected),
            "开头查一次的话，四个 agent 全会跑完——花掉 1.6 元，预算的 1.6 倍。\n"
            "      一个失控的 sub-agent 能把整个预算吃掉，后面的应该被拦住而不是照跑",
        )
        assert_(
            len(r.reports) < 4,
            f"应该有 agent 被拦住，实际全跑完了（{len(r.reports)} 份）",
        )

    await test("★ 预算要在批之间检查，不能只在开头查一次", t_budget)

    async def t_depth() -> None:
        r = await M.fanout([brief(agent="a")], runner(), opts(max_depth=2, depth=2))
        assert_(not r.reports, "到达深度上限就不该再派")
        assert_(
            len(r.rejected) == 1 and "深度" in r.rejected[0]["reason"],
            f"rejected 里要说明是深度闸拦的，实际 {r.rejected}",
        )

    await test("★ 深度上限：sub-agent 开 sub-agent 是指数级账单", t_depth)

    # ─────────────────────────────────────────────────────────
    print("\nPython 独有：gather 的返回值语义与 CancelledError")

    async def t_isolation() -> None:
        async def run(b: Brief) -> Report:
            if b.agent == "boom":
                raise RuntimeError("工具超时")
            return report(agent=b.agent, summary=f"结论：{b.agent}")

        bs = [brief(agent="ok1"), brief(agent="boom"), brief(agent="ok2")]
        r = await M.fanout(bs, run, opts())
        assert_(
            len([x for x in r.reports if x.ok]) == 2,
            "asyncio.gather(return_exceptions=True) 的返回值是「值或异常对象」混在\n"
            "      一起的列表——它**不等于** Promise.allSettled，没有 status 字段。\n"
            "      漏掉 isinstance 判断，后面就在拿异常当报告用，\n"
            "      而 Report 的字段访问会抛一个和真正原因毫无关系的 AttributeError",
        )
        assert_(
            any(g["agent"] == "boom" for g in r.merged.gaps),
            "崩掉的那个必须变成一条 gap 而不是消失",
        )

    await test("★ 一个 sub-agent 崩了，其余照跑，崩的那个变成 gap", t_isolation)

    async def t_cancelled() -> None:
        async def run(b: Brief) -> Report:
            if b.agent == "cancel-me":
                raise asyncio.CancelledError
            return report(agent=b.agent)

        bs = [brief(agent="cancel-me"), brief(agent="b")]
        try:
            await M.fanout(bs, run, opts())
        except asyncio.CancelledError:
            return  # 正确：取消往上抛了
        raise AssertionError(
            "取消被当成「这个 sub-agent 崩了」吞掉了。\n"
            "      asyncio.CancelledError 在 3.8+ **不是 Exception 的子类**，\n"
            "      它继承 BaseException。\n"
            "      所以 isinstance(x, Exception) 判不出它——而这一行看起来完全正常。\n"
            "      后果：用户点了取消，剩下的 sub-agent 照跑，钱照花。\n"
            "      这个坑在 TS 那边不存在（AbortError 就是个普通 Error）"
        )

    await test("★ CancelledError 必须往上抛，不能当成 sub-agent 崩溃", t_cancelled)

    # ─────────────────────────────────────────────────────────
    print("\n交接")

    def t_handoff() -> None:
        r = M.handoff(
            "triage",
            lambda a: {"to": "billing", "reason": "是账单问题"} if a == "triage" else None,
        )
        assert_(
            r.final == "billing" and len(r.path) == 1,
            f"实际 final={r.final} path={len(r.path)}",
        )

    await test("走到终点就停", t_handoff)

    def t_loop() -> None:
        r = M.handoff(
            "a",
            lambda cur: {"to": "b", "reason": "踢给 b"}
            if cur == "a"
            else {"to": "a", "reason": "踢回 a"},
        )
        assert_(
            r.loop is not None,
            "两个 agent 互相交接是真实故障模式，而它的表现是「请求一直不返回」——\n"
            "      没有异常、没有错误日志。只有 max_hops 兜底的话要跑满 8 跳才停，\n"
            "      而且停下来之后你不知道是「走了 8 步」还是「绕圈了」",
        )

    await test("★ 互相交接要被检测成环（否则请求一直不返回）", t_loop)

    def t_hop_reason() -> None:
        r = M.handoff(
            "a", lambda cur: {"to": "b", "reason": "需要账单专长"} if cur == "a" else None
        )
        assert_(len(r.path[0].reason) > 0, "没有 reason 的交接链在事后无法复盘")

    await test("每一跳都要记 reason", t_hop_reason)

    # ─────────────────────────────────────────────────────────
    print("\n成本会计")

    def t_quadratic() -> None:
        a = shared.cost_single(5, SHAPE).input_tokens
        b = shared.cost_single(10, SHAPE).input_tokens
        assert_(
            b / a > 3,
            f"10 步应该远超 5 步的两倍，实际 {b / a:.1f} 倍——上下文每轮重发",
        )

    await test("单 agent 的输入是 O(n²) 而不是 O(n)", t_quadratic)

    def t_fanout_ratio() -> None:
        single = shared.cost_single(5, SHAPE).input_tokens
        multi = shared.cost_multi(3, 5, SHAPE).input_tokens
        ratio = multi / single
        assert_(
            3 < ratio < 4.5,
            f"实际 {ratio:.2f} 倍。\n"
            "      这条测的是一个结论：「多 agent 的协调开销很大」是错误诊断。\n"
            "      倍数几乎就是扇出宽度本身——它贵是因为**做了 3 倍的工作**",
        )

    await test("★ 多 agent 对单 agent 的倍数 ≈ 扇出宽度", t_fanout_ratio)

    def t_coord_share() -> None:
        b = shared.cost_multi(3, 5, SHAPE)
        share = b.parts["coordination"] / b.input_tokens
        assert_(
            share < 0.15,
            f"协调开销占 {share * 100:.0f}%。\n"
            "      以为是协调贵就会去优化任务书格式、压缩报告、改协议——\n"
            "      而那是在动一个占比很小的部分，天花板就是这个占比",
        )

    await test("★ 协调开销只占小头（所以优化它的天花板很低）", t_coord_share)

    await test("单 agent 的协调开销必须是 0", lambda: assert_(
        shared.cost_single(5, SHAPE).parts["coordination"] == 0,
        "单 agent 没有任务书也没有报告，这一项必须是 0",
    ))

    # ─────────────────────────────────────────────────────────

    print("\n" + "─" * 62)
    if not failures:
        print(f"\033[32m全过。{passed} 项。\033[0m")
        print("\n接着跑 uv run python -m l11.compare —— 看 15 倍是怎么来的。")
    else:
        print(f"\033[31m{len(failures)} 项没过（过了 {passed} 项）：\033[0m")
        for f in failures:
            print(f"\033[31m  · {f}\033[0m")
        print("\n先跑 MULTI_IMPL=shared uv run python -m l11.verify 对照参考实现。")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
