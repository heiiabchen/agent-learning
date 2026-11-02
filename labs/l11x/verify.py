"""验证 l11x/ecosystem.py。跑法：

    cd labs && uv run python -m l11x.verify
    cd labs && ECO_IMPL=shared uv run python -m l11x.verify   # 先确认测试本身对

一次 API 都不调。这一节的四件机制全是纯逻辑，
而**能用假的测的东西就不要用真的测**。

带 ★ 的每一条对应一个静默失效：
$ref 被当成字符串、环被内联成无限递归、兄弟键被丢掉、
消息按 id 覆盖失效、并发分支的结果被无声盖掉、
恢复时副作用重放、bootstrap 攒不到示例却报"编译成功"。

它们的共同点和前面几节一样：**不抛异常。**
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import Awaitable, Callable
from typing import Any

from shared import pyecosystem as shared
from shared.pyecosystem import Demo, Example, Interrupt, StateGraph

TARGET = "shared" if os.environ.get("ECO_IMPL") == "shared" else "mine"

if TARGET == "shared":
    M: Any = shared
    print("\n（测的是 shared/ 里的参考实现）")
else:
    from l11x import ecosystem as M  # type: ignore[no-redef]

    print("\n（测的是 l11x/ 里你的实现）")

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
        for line in str(err).splitlines():
            print(f"\033[31m      {line}\033[0m")


def ok(cond: object, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


# ─── 素材 ────────────────────────────────────────────────────

SIMPLE: dict[str, Any] = {
    "type": "object",
    "properties": {"f": {"$ref": "#/$defs/D"}},
    "$defs": {"D": {"type": "object", "properties": {"x": {"type": "string"}}}},
}

DIAMOND: dict[str, Any] = {
    "type": "object",
    "properties": {"a": {"$ref": "#/$defs/D"}, "b": {"$ref": "#/$defs/D"}},
    "$defs": {"D": {"type": "integer"}},
}

CHAINED: dict[str, Any] = {
    "type": "object",
    "properties": {"a": {"$ref": "#/$defs/A"}},
    "$defs": {
        "A": {"type": "object", "properties": {"b": {"$ref": "#/$defs/B"}}},
        "B": {"type": "boolean"},
    },
}

CYCLE: dict[str, Any] = {
    "type": "object",
    "properties": {"n": {"$ref": "#/$defs/Node"}},
    "$defs": {
        "Node": {
            "type": "object",
            "properties": {"kid": {"$ref": "#/$defs/Node"}},
        }
    },
}

SIBLING: dict[str, Any] = {
    "type": "object",
    "properties": {"f": {"$ref": "#/$defs/D", "description": "覆盖后的"}},
    "$defs": {"D": {"type": "string", "description": "原来的"}},
}

LEGACY: dict[str, Any] = {
    "type": "object",
    "properties": {"f": {"$ref": "#/definitions/D"}},
    "definitions": {"D": {"type": "number"}},
}

DANGLING: dict[str, Any] = {
    "type": "object",
    "properties": {"f": {"$ref": "#/$defs/Gone"}},
}

FLAT: dict[str, Any] = {"type": "object", "properties": {"a": {"type": "string"}}}

ANY_OF: dict[str, Any] = {
    "type": "object",
    "properties": {"a": {"anyOf": [{"type": "string"}, {"type": "null"}]}},
}


async def main() -> None:  # noqa: C901, PLR0915
    # ─── 一、schema 解引用 ──────────────────────────────────
    print("\n一、schema 解引用（TODO 1）")

    await test("简单引用被内联，$defs 删掉", lambda: (
        ok(
            M.dereference(SIMPLE)["properties"]["f"]["properties"]["x"]["type"] == "string",
            "嵌套定义应该被内联到用点上",
        ),
        ok("$defs" not in M.dereference(SIMPLE), "内联完 $defs 就该删掉，留着是死重量"),
    ))

    await test("★ 菱形引用：两处都拿到值，不是一处拿到一处空", lambda: (
        ok(
            M.dereference(DIAMOND)["properties"]["a"]["type"] == "integer"
            and M.dereference(DIAMOND)["properties"]["b"]["type"] == "integer",
            "同一个定义被引用两次，两处都要解开。\n"
            "      只解第一处是最常见的实现 bug——而它不报错，\n"
            "      第二个参数会静默变成一个空对象",
        ),
    ))

    await test("链式引用（A→B→C）要一路解到底", lambda: (
        ok(
            M.dereference(CHAINED)["properties"]["a"]["properties"]["b"]["type"] == "boolean",
            "只解一层的话，里面那层 $ref 还在，问题原样保留",
        ),
    ))

    await test("★ 自引用的类型：$ref 必须留在原地", lambda: (
        ok(
            "$ref" in M.dereference(CYCLE)["properties"]["n"],
            "树节点这种自引用类型**不能内联**——内联一个环是无限递归。\n"
            "      递归树是很常见的工具参数（文件树、AST、评论楼层）",
        ),
        ok(
            "$defs" in M.dereference(CYCLE) and "Node" in M.dereference(CYCLE)["$defs"],
            "留了 $ref 就必须留对应的 $defs，否则变成悬空指针",
        ),
    ))

    await test("★ 兄弟键覆盖解析出来的值（JSON Schema 2020-12）", lambda: (
        ok(
            M.dereference(SIBLING)["properties"]["f"]["description"] == "覆盖后的",
            "{$ref: D, description: X} 里 X 要盖住 D 自带的 description。\n"
            "      弄反了不会报错——你只会得到一个描述不对的参数，\n"
            "      然后模型按那个错描述填值",
        ),
    ))

    await test("旧式 definitions 也要认", lambda: (
        ok(
            M.dereference(LEGACY)["properties"]["f"]["type"] == "number",
            "JSON Schema draft-07 用 definitions，2020-12 用 $defs。\n"
            "      生态里两种都有，只认一种会漏",
        ),
    ))

    await test("解不出来的 $ref 留下，不丢掉", lambda: (
        ok(
            "$ref" in M.dereference(DANGLING)["properties"]["f"],
            "★ 留下比丢掉好：悬空指针至少会让请求报错，\n"
            "      而丢掉会让模型看到一个「参数不存在」的 schema，静默走偏",
        ),
    ))

    await test("没有 $defs 的 schema 原样返回", lambda: (
        ok(
            M.dereference(FLAT)["properties"]["a"]["type"] == "string",
            "平坦 schema 不该被动。改了它就等于给所有现有工具引入回归",
        ),
    ))

    await test("不改原对象", lambda: (
        (lambda snap: (
            M.dereference(SIMPLE),
            ok(
                "$defs" in SIMPLE and SIMPLE["properties"]["f"] == {"$ref": "#/$defs/D"},
                "原地改会让同一份 schema 第二次解引用时行为不同",
            ),
            ok(snap == SIMPLE, "原对象必须一个字节都没变"),
        ))(dict(SIMPLE)),
    ))

    # ─── 二、schema 体检 ────────────────────────────────────
    print("\n二、schema 体检（TODO 2）")

    await test("★ 活着的本地 $ref 要报出来", lambda: (
        ok(len(M.schema_health(SIMPLE)) > 0, "有 $ref 就必须报——这是那个「参数变成字符串」的坑"),
        ok(
            any("$ref" in p for p in M.schema_health(SIMPLE)),
            "报出来的话得说清是 $ref 的问题",
        ),
    ))

    await test("悬空 $ref 要报出来", lambda: (
        ok(len(M.schema_health(DANGLING)) > 0, "$defs 被中间层丢掉是真实发生过的 bug"),
    ))

    await test("干净的 schema 不该报任何问题", lambda: (
        ok(
            M.schema_health(M.dereference(SIMPLE)) == [],
            "★ 解引用之后必须是干净的。这一条把 TODO 1 和 TODO 2 锁在一起：\n"
            "      如果解引用漏了什么，体检会当场发现",
        ),
    ))

    await test("anyOf 要报出来", lambda: (
        ok(
            len(M.schema_health(ANY_OF)) > 0,
            "anyOf 通常来自 Optional[X]。模型挑错分支不会报错，\n"
            "      它会给你一个结构对不上的参数",
        ),
    ))

    # ─── 三、reducer ────────────────────────────────────────
    print("\n三、reducer（TODO 3、4）")

    await test("★ add_messages 按 id 覆盖，不追加", lambda: (
        ok(
            len(M.add_messages([{"id": "a", "t": "1"}], [{"id": "a", "t": "2"}])) == 1,
            "同 id 必须覆盖。追加会让历史里同时存在改前和改后两条，\n"
            "      模型看到两条矛盾的消息——而它不报错，它会挑一条",
        ),
        ok(
            M.add_messages([{"id": "a", "t": "1"}], [{"id": "a", "t": "2"}])[0]["t"] == "2",
            "覆盖后留下的应该是新的那条",
        ),
    ))

    await test("add_messages 对新 id 追加", lambda: (
        ok(
            len(M.add_messages([{"id": "a"}], [{"id": "b"}])) == 2,
            "不同 id 是两条不同的消息，要都留着",
        ),
    ))

    await test("add_messages 保持原有顺序", lambda: (
        ok(
            [m["id"] for m in M.add_messages([{"id": "a"}, {"id": "b"}], [{"id": "a", "t": "x"}])]
            == ["a", "b"],
            "★ 覆盖不能改位置。把 a 挪到末尾会让对话顺序错乱，\n"
            "      而模型对消息顺序是敏感的",
        ),
    ))

    await test("add_messages 容忍没有 id 的消息", lambda: (
        ok(
            len(M.add_messages([{"t": "1"}], [{"t": "2"}])) == 2,
            "没有 id 就没法去重，只能追加。这里崩掉会让整个图挂掉",
        ),
    ))

    await test("add_messages 处理 None / 空历史", lambda: (
        ok(len(M.add_messages(None, [{"id": "a"}])) == 1, "第一次写入时旧值是 None"),
        ok(len(M.add_messages([], [{"id": "a"}])) == 1, "空列表也要能写"),
    ))

    await test("add_messages 接受单条（不只是列表）", lambda: (
        ok(
            len(M.add_messages([], {"id": "a"})) == 1,
            "节点返回单条消息是常见写法，reducer 要两种都吃",
        ),
    ))

    await test("有 reducer 的字段：并发分支全保住", lambda: (
        (lambda g: (
            lambda res: (
                ok(len(res[0]["xs"]) == 3, "三个分支各写一条，有 reducer 就该攒到 3 条"),
                ok(res[1] == [], "有 reducer 的字段不算被覆盖"),
            )
        )(M.merge_parallel(g, {"xs": []}, [{"xs": ["a"]}, {"xs": ["b"]}, {"xs": ["c"]}]))
        )(StateGraph(reducers={"xs": shared.append_reducer})),
    ))

    await test("★ 没 reducer 的字段被并发写：必须报出来", lambda: (
        (lambda g: (
            lambda res: (
                ok(
                    res[1] == ["cur"],
                    "★ 这是整个 reducer 设计存在的理由。\n"
                    "      没 reducer 的字段只能后写盖前写——有节点的成果消失了，\n"
                    "      而且没有任何地方记录这件事。\n"
                    "      真 LangGraph 遇到这个直接报 InvalidUpdateError：\n"
                    "      它宁可让图跑不起来，也不让你丢结果而不知道",
                ),
            )
        )(M.merge_parallel(g, {}, [{"cur": "w1"}, {"cur": "w2"}]))
        )(StateGraph(reducers={})),
    ))

    await test("单次写入不算覆盖", lambda: (
        (lambda g: ok(
            M.merge_parallel(g, {}, [{"cur": "w1"}])[1] == [],
            "只有一个分支写的字段没有冲突，报出来就是噪音——\n"
            "      而会报假警的检查最后都会被人关掉",
        ))(StateGraph(reducers={})),
    ))

    await test("被覆盖的字段名不重复", lambda: (
        (lambda g: ok(
            M.merge_parallel(g, {}, [{"c": 1}, {"c": 2}, {"c": 3}])[1] == ["c"],
            "三个分支写同一个字段，报一次就够。这是字段名的集合，\n"
            "      不是「覆盖发生了几次」的计数",
        ))(StateGraph(reducers={})),
    ))

    # ─── 四、恢复语义（跑参考实现，验证你理解对了）────────
    print("\n四、checkpoint 与 interrupt（TODO 5，跑的是参考实现）")

    await test("★ 恢复会重跑节点，副作用执行两次", lambda: (
        (lambda db, g: (
            g.add_node(
                "n",
                lambda s: (
                    db.append("row"),
                    {"done": True, "v": s["_resume"]}
                    if "_resume" in s
                    else (_ for _ in ()).throw(Interrupt("等审批")),
                )[-1],
            ),
            g.add_edge("n", None),
            g.invoke({"t": "x"}, thread_id="t1"),
            ok(len(db) == 1, "第一次跑到 interrupt，副作用执行一次"),
            g.invoke({}, thread_id="t1", resume=True),
            ok(
                len(db) == 2,
                "★ 恢复之后是 2，而这是 LangGraph 的正常行为，不是 bug。\n"
                "      检查点存在「超步」边界上，不在节点函数中间，\n"
                "      所以被中断的节点会从函数开头重跑一遍。\n"
                "      这就是「interrupt 之前的代码必须幂等」的由来——\n"
                "      和 L08 的幂等键是同一件事：\n"
                "      恢复不是「接着往下走」，是「重放到断点」",
            ),
        ))([], StateGraph(reducers={})),
    ))

    await test("interrupt 的值会交给调用方", lambda: (
        (lambda g: (
            g.add_node("n", lambda s: (_ for _ in ()).throw(Interrupt({"q": "确认？"}))),
            g.add_edge("n", None),
            ok(
                g.invoke({}, thread_id="t2")["__interrupt__"]["q"] == "确认？",
                "调用方要能拿到「要问人什么」，否则这个机制没用",
            ),
        ))(StateGraph(reducers={})),
    ))

    await test("检查点日志能重放（对照 L13）", lambda: (
        (lambda g: (
            g.add_node("a", lambda s: {"n": 1}),
            g.add_edge("a", "b"),
            g.add_node("b", lambda s: {"n": 2}),
            g.add_edge("b", None),
            g.invoke({}, thread_id="t3"),
            ok(len(g.history("t3")) == 2, "两个节点跑完应该有两个检查点"),
            ok(
                [c.node for c in g.history("t3")] == ["a", "b"],
                "检查点要按执行顺序，不然重放的时候顺序是错的",
            ),
        ))(StateGraph(reducers={})),
    ))

    await test("不同 thread_id 的状态互不干扰", lambda: (
        (lambda g: (
            g.add_node("a", lambda s: {"n": s.get("n", 0) + 1}),
            g.add_edge("a", None),
            g.invoke({"n": 0}, thread_id="A"),
            g.invoke({"n": 100}, thread_id="B"),
            ok(
                len(g.history("A")) == 1 and len(g.history("B")) == 1,
                "★ thread_id 就是 L08 的 session id。串了就是把别人的对话\n"
                "      混进当前会话——而这不报错，只是答案开始不对劲",
            ),
        ))(StateGraph(reducers={})),
    ))

    # ─── 五、DSPy ───────────────────────────────────────────
    print("\n五、few-shot 编译（TODO 6、7）")

    def prog_ok(inputs: dict[str, Any], demos: list[Demo]) -> dict[str, Any]:
        return {"y": inputs["x"] * 2}

    def metric(out: dict[str, Any], exp: dict[str, Any]) -> float:
        return 1.0 if out.get("y") == exp.get("y") else 0.0

    train = [Example({"x": i}, {"y": i * 2}) for i in range(1, 7)]

    await test("攒到的示例数不超过 max_demos", lambda: (
        ok(
            len(M.bootstrap_few_shot(prog_ok, train, metric, max_demos=3).demos) == 3,
            "★ max_demos 是成本闸。不封顶的话 few-shot 会把上下文吃光，\n"
            "      而那正是 L06 那节讲的长上下文退化",
        ),
    ))

    await test("★ 示例里的输出是程序自己产的，不是标注答案", lambda: (
        (lambda c: ok(
            c.demos[0].outputs == {"y": c.demos[0].inputs["x"] * 2},
            "这是 bootstrap 这个词的全部含义——用程序自己的成功轨迹当示范。\n"
            "      好处是措辞格式都合模型习惯，代价是**它会把模型自己的偏好固化**",
        ))(M.bootstrap_few_shot(prog_ok, train, metric, max_demos=2)),
    ))

    await test("★ 指标判不过的样本不能进示例集", lambda: (
        (lambda c: (
            ok(
                c.kept == 0,
                "指标永远返回 0 时，一条示例都不该攒到。\n"
                "      **攒到了才是 bug**——那意味着阈值判断被跳过了",
            ),
            ok(c.trials > 0, "试过的次数要记下来，不然看不出是「没试」还是「试了都不过」"),
        ))(M.bootstrap_few_shot(prog_ok, train, lambda *_: 0.0, max_demos=3)),
    ))

    await test("指标调用次数要记账", lambda: (
        ok(
            M.bootstrap_few_shot(prog_ok, train, metric, max_demos=2).metric_calls > 0,
            "★ MIPROv2 的 auto='heavy' 能跑到几千次调用，一次编译 5-20 美元。\n"
            "      不记账的优化循环是 L11 那节「多 agent 是花钱策略」的同一个坑",
        ),
    ))

    await test("bootstrap 阶段传给程序的 demos 是空的", lambda: (
        (lambda seen: (
            M.bootstrap_few_shot(
                lambda i, d: (seen.append(len(d)), {"y": i["x"] * 2})[-1],
                train[:2],
                metric,
                max_demos=2,
            ),
            ok(
                all(n == 0 for n in seen),
                "★ bootstrap 是零样本跑的。如果把已攒的示例喂回去，\n"
                "      后面的示例会被前面的带偏，而分数会虚高——\n"
                "      这是一种自我确认，不是优化",
            ),
        ))([]),
    ))

    await test("★ 一条示例都没攒到，报告里必须说出来", lambda: (
        (lambda c: ok(
            "0" in M.compile_report({"mean": 0.0}, {"mean": 0.0}, c)
            and len(M.compile_report({"mean": 0.0}, {"mean": 0.0}, c).splitlines()) >= 3,
            "★ kept==0 意味着零样本成功率为 0，而正确应对和直觉相反：\n"
            "      **先查签名和指标，不要加数据。**\n"
            "      报告里不提这件事，就会有人拿着一个空的编译产物上线",
        ))(M.bootstrap_few_shot(prog_ok, train, lambda *_: 0.0, max_demos=3)),
    ))

    await test("★ 报告必须同时给编译前后两个数", lambda: (
        (lambda r: (
            ok("0.40" in r or "0.4" in r, "编译前的分数要出现在报告里"),
            ok("0.90" in r or "0.9" in r, "编译后的分数要出现在报告里"),
            ok(
                "+0.5" in r,
                "★ 提升幅度要算出来。只看编译后那个数字，\n"
                "      你不知道优化到底有没有起作用——\n"
                "      也不知道它是不是把 devset 记住了",
            ),
        ))(
            M.compile_report(
                {"mean": 0.4},
                {"mean": 0.9},
                M.bootstrap_few_shot(prog_ok, train, metric, max_demos=2),
            )
        ),
    ))

    await test("提升为负或为零时要点出来", lambda: (
        ok(
            len(
                M.compile_report(
                    {"mean": 0.8},
                    {"mean": 0.8},
                    M.bootstrap_few_shot(prog_ok, train, metric, max_demos=2),
                ).splitlines()
            )
            >= 3,
            "★ 编译没提升，通常意味着**指标太粗**（比如只判精确匹配），\n"
            "      而不是需要换 optimizer。不说这句就会有人去换 optimizer",
        ),
    ))

    # ─── 六、Python 独有：并发语义 ─────────────────────────
    print("\n六、Python 独有的并发语义（跑的是参考实现）")

    def jobs() -> dict[str, Any]:
        async def boom() -> None:
            await asyncio.sleep(0.005)
            raise RuntimeError("挂了")

        async def slow(n: int) -> str:
            await asyncio.sleep(0.06)
            return f"s{n}"

        return {"boom": boom, "s1": lambda: slow(1), "s2": lambda: slow(2)}

    async def t_gather() -> None:
        r = await shared.run_with_gather(jobs())
        ok(
            r.orphaned == 2,
            "★ 朴素 gather：第一个异常立刻上抛，**其余不会被取消**。\n"
            "      在 agent 里就是：一个 sub-agent 崩了，另外两个还在调模型、\n"
            "      还在花钱——只是没有人会读它们的结果了",
        )
        ok(r.cancelled == [], "朴素 gather 不取消任何东西，所以这一项必须是空")
        ok(len(r.ok) == 2, "那两个「孤儿」最后是真的跑完了、钱真的花了")

    await test("★ 朴素 gather 会留下还在烧钱的孤儿任务", t_gather)

    async def t_tg() -> None:
        r = await shared.run_with_task_group(jobs())
        ok(r.orphaned == 0, "TaskGroup 退出时保证没有任务在跑")
        ok(len(r.cancelled) == 2, "第一个失败要取消其余——这正是它和 gather 的差别"),
        ok(len(r.ok) == 0, "被取消了就没跑完，钱也没花")
        ok(
            r.raised is not None and "ExceptionGroup" in r.raised,
            "TaskGroup 抛的是 ExceptionGroup（PEP 654），要用 except* 接。\n"
            "      多个任务同时失败时它能给你全部，而 gather 只给第一个",
        )

    await test("TaskGroup 取消其余任务并打包成 ExceptionGroup", t_tg)

    async def t_settled() -> None:
        r = await shared.run_with_settled(jobs())
        ok(len(r.ok) == 2 and len(r.failed) == 1, "各自跑完，异常当成值收回来")
        ok(
            r.raised is None,
            "★ 这个语义是 L11 的 fanout 要的：一个 sub-agent 崩了\n"
            "      不该让其余白跑。所以这里不该抛",
        )

    await test("gather(return_exceptions=True) 各自跑完（L11 用的就是这个）", t_settled)

    await test("★ CancelledError 不是 Exception 的子类", lambda: (
        ok(
            not issubclass(asyncio.CancelledError, Exception),
            "3.8+ 起它直接继承 BaseException。\n"
            "      所以 `except Exception` 接不到它——这是好事，\n"
            "      意味着你的兜底 except 不会把取消信号吞掉。\n"
            "      ★ 但反过来：想接住取消就必须显式写 except asyncio.CancelledError，\n"
            "      而且接了之后要 raise，不然 TaskGroup 和 asyncio.timeout 会失灵",
        ),
        ok(issubclass(asyncio.CancelledError, BaseException), "它是 BaseException 的子类"),
    ))

    # ─────────────────────────────────────────────────────────
    print("\n" + "─" * 62)
    if not failures:
        print(f"\033[32m全过。{passed} 项。\033[0m")
        print("\n接着跑 pnpm eco —— 同样四件事在 TS 里长什么样，以及哪两件根本没有。")
    else:
        print(f"\033[31m{len(failures)} 项没过（过了 {passed} 项）：\033[0m")
        for f in failures:
            print(f"\033[31m  · {f}\033[0m")
        print("\n先跑 ECO_IMPL=shared uv run python -m l11x.verify 对照参考实现。")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
