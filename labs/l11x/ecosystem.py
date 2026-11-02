"""L11x：Python agent 生态的四件核心机制（主通道）。

    cd labs && uv run python -m l11x.ecosystem
    cd labs && uv run python -m l11x.verify

★ 这一节和别的节反过来：**Python 是主通道，TypeScript 是对照。**

理由很实在。你写 TS，但 agent 生态的重心在 Python——LangGraph、DSPy、
几乎所有 eval 框架、所有论文的参考实现。你不需要用 Python 写生产代码，
但你需要**看懂它们**，而且要看懂到能判断"这个设计我该不该抄"。

所以这七个 TODO 不是在实现一个库，是在把四个库的**核心机制剥出来重写**——
每个都短到能一眼看完，而写完之后你对着真库的源码知道自己在看什么。

  TODO 1-2  schema 解引用   —— pydantic 生成的 $ref，模型解不开（真实 bug）
  TODO 3    reducer          —— LangGraph 的核心
  TODO 4-5  状态图           —— checkpoint 与 interrupt
  TODO 6-7  few-shot 编译    —— DSPy 的核心
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import Callable
from typing import Any

from shared import pyecosystem as shared
from shared.pyecosystem import (
    Checkpoint,
    Compiled,
    Demo,
    Example,
    Interrupt,
    Metric,
    Program,
    Reducer,
    StateGraph,
)

IMPL = "shared" if os.environ.get("ECO_IMPL") == "shared" else "mine"


# ─────────────────────────────────────────────────────────────
# TODO 1：schema 解引用
#
# ★ 这不是理论问题。它在 anything-llm、agno、MCP Python SDK 三个项目里
# 都是有编号的 issue 和已合并的修复。
#
# 起因：pydantic 的 model_json_schema() 遇到嵌套 BaseModel 时，会把嵌套
# 那部分提到 $defs 里，用点上放一个 $ref 指过去。这是**合法的 JSON
# Schema 2020-12**。
#
# 问题：**Anthropic 的 tools API 不解本地 $ref。**
#
# 而失效方式有三种，一种比一种难查：
#   1. $defs 被中间层丢掉  → 悬空指针，请求被拒（这个还算好，它报错）
#   2. $defs 传过去了       → 模型解不开 $ref，把那个参数**当成字符串**填，
#                             于是你收到一个 JSON 字符串而不是对象
#   3. schema 里有 anyOf    → 模型挑错分支，参数结构对不上
#
# ★ 第 2 种最坑：**工具调用成功了**，参数看起来也像回事，只是那个嵌套
# 对象是个字符串。而你工具实现里 args["filter"]["status"] 会抛 TypeError，
# 栈顶在你的工具里，和 schema 一个字的关系都看不出来。
#
# 四个必须处理对的情况：
#   简单引用  A -> D            内联，$defs 删掉
#   菱形      A -> D, B -> D    D 解析一次，两处共享
#   环        Node -> Node      ★ $ref **留在原地**，对应 $defs 保留
#                               （不然无限递归）
#   兄弟键    {"$ref":.., "description":..}
#                               按 2020-12：兄弟键覆盖解析出来的值
#
# 还有一条判断题：解不出来的 $ref 该丢还是该留？
# ★ **留。** 悬空指针至少会让请求报错；丢掉会让模型看到一个"参数不存在"
# 的 schema，然后静默走偏。
# ─────────────────────────────────────────────────────────────


def dereference(schema: dict[str, Any]) -> dict[str, Any]:
    raise NotImplementedError("TODO: 实现 dereference")


# ─────────────────────────────────────────────────────────────
# TODO 2：发出去之前的体检
#
# ★ 存在理由：上面那三种失效**全都不在你的代码里报错**。
# 所以必须有一道主动检查，而且它得在发请求之前跑。
#
# 查三件事，每条都要说清症状（不是说清规则）：
#   悬空 $ref  —— 中间层只复制了 type/properties/required，把 $defs 丢了
#   活的 $ref  —— 模型会把那个参数当成字符串填
#   anyOf      —— 通常来自 Optional[X] / Union，模型会挑错分支
# ─────────────────────────────────────────────────────────────


def schema_health(schema: dict[str, Any]) -> list[str]:
    raise NotImplementedError("TODO: 实现 schema_health")


# ─────────────────────────────────────────────────────────────
# TODO 3：add_messages —— LangGraph 里唯一真正新的东西
#
# ★ 先说一件能省你很多时间的事：
#
# **LangGraph 的核心机制，你在 L08 已经手写过了。**
#
#   LangGraph 的 checkpointer  = L08 的事件日志 + 快照
#   LangGraph 的 thread_id     = L08 的 session id
#   LangGraph 的 interrupt     = L14 那个人工审批闸
#   LangGraph 的 reducer       = 这一条，唯一真正新的
#
# reducer 之所以是核心，是因为它解决了一个具体问题：
# **图里多个节点并发更新同一份状态时，怎么合并。**
#
# 这个问题在链式流程里不存在（一次只有一个节点在写），扇出时立刻出现。
# 而 LangGraph 的答案不是加锁，是**要求你为每个会被并发写的字段
# 声明一个合并函数**。
#
# add_messages 和朴素的 append（operator.add）差别只有一处，但很关键：
# **它按 id 去重并覆盖。**
#
# 为什么必须这样：人工改状态（把某条消息改掉再恢复执行）时，单纯追加
# 会让历史里同时存在改前和改后两条。模型看到两条互相矛盾的消息，
# 而它不会报错——它会挑一条，通常是后一条，有时不是。
# ─────────────────────────────────────────────────────────────


def add_messages(old: Any, new: Any) -> Any:
    raise NotImplementedError("TODO: 实现 add_messages")


# ─────────────────────────────────────────────────────────────
# TODO 4：并发分支的合并
#
# ★ 这个函数是整个 reducer 设计存在的理由。
#
# 三个节点并发跑完，各自返回一份 update。**没有声明 reducer 的字段
# 只能后写盖前写**——而那意味着有节点的工作成果消失了，
# 而且没有任何地方会记录这件事。
#
# 所以这里要把"被覆盖了"作为返回值的一部分交出去：
#   返回 (新状态, 被静默覆盖的字段名列表)
#
# 真 LangGraph 的做法更硬：没声明 reducer 的字段被多个分支同时写，
# 它直接报 InvalidUpdateError。**它宁可让你的图跑不起来，
# 也不让你丢一次结果而不知道。**
#
# 判断"被覆盖"的条件是两个都要满足：
#   · 这个字段没有 reducer
#   · 这个字段在本批里已经被写过一次
# ─────────────────────────────────────────────────────────────


def merge_parallel(
    graph: StateGraph, state: dict[str, Any], updates: list[dict[str, Any]]
) -> tuple[dict[str, Any], list[str]]:
    raise NotImplementedError("TODO: 实现 merge_parallel")


# ─────────────────────────────────────────────────────────────
# TODO 5（没有代码，但要跑一遍）：恢复语义
#
# 参考实现的 StateGraph.invoke 已经写好了。跑 demo 四，然后回答一个问题：
#
#   一个节点里先写数据库、再 interrupt 等审批。恢复之后数据库里有几条记录？
#
# ★ 答案是**两条**，而理由是这一小节最容易被漏掉的一件事：
# **检查点存在"超步"边界上，不在节点函数中间。**
#
# 所以恢复的时候，被中断那个节点会从函数开头**重跑一遍**——
# interrupt 之前的代码和副作用会再执行一次。
#
# 这就是 LangGraph 文档里"interrupt 之前的代码必须幂等"的由来。
# 而它和 L08 那节的幂等键是同一件事：
# **恢复不是"接着往下走"，是"重放到断点"。**
#
# demo 四会把这件事跑出来给你看。
# ─────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────
# TODO 6：BootstrapFewShot —— DSPy 的核心
#
# ★ DSPy 的一句话版本：**把 prompt 当成可以被编译的东西。**
#
# 你写"签名"（输入字段 → 输出字段）和"模块"（怎么组合），不写具体的
# prompt 文字。然后 optimizer 拿着你的训练集和**你的指标**，反复跑你的
# 程序，产出一份"编译好的" prompt。
#
# 编译产物具体是什么，值得说清楚，因为它比听起来朴素得多：
#
#   BootstrapFewShot   —— 一组 few-shot 示例（跑出来、指标判对的那些）
#   MIPROv2            —— 示例 + 重写过的指令，贝叶斯搜索联合优化
#   GEPA               —— 重写过的指令，靠指标返回的**自然语言反馈**做反思式进化
#   BootstrapFinetune  —— 模型权重
#
# 前三个都只动 prompt，模型不碰，所以闭源模型也能用。
#
# BootstrapFewShot 的机制（和真 DSPy 一致）：
#   1. 拿训练集里的样本，**用当前程序（零 few-shot）跑一遍**
#   2. 用你的指标给输出打分
#   3. 分数达标的，把「输入 → 程序自己产出的输出」留作 few-shot 示例
#   4. 攒够 max_demos 就停
#
# ★ 第 3 步值得停一下：留下的示例里，输出是**模型自己生成的**，
# 不是训练集里的标注答案。这是 "bootstrap" 这个词的全部含义——
# 用程序自己的成功轨迹当示范。
#
# 好处：示例的措辞、格式、思路都和模型的习惯一致。
# 代价：**它会把模型自己的偏好固化下来**，包括偏见。
#
# ★ 而这里有一个前置条件，是 DSPy 最常被跳过、也最要紧的一条：
# **你必须有一个指标。** 没有 eval 集和指标，optimizer 无事可做——
# 它整个机制就是"生成候选 → 用你的指标打分 → 留下分高的"。
#
# 所以 DSPy 的入场券，正好是 L12 那节的交付物。这个顺序不是巧合：
# **大多数团队用不上 DSPy 的真实原因不是它难，是他们没有指标。**
# ─────────────────────────────────────────────────────────────


def bootstrap_few_shot(
    program: Program,
    trainset: list[Example],
    metric: Metric,
    *,
    max_demos: int = 4,
    threshold: float = 1.0,
) -> Compiled:
    raise NotImplementedError("TODO: 实现 bootstrap_few_shot")


# ─────────────────────────────────────────────────────────────
# TODO 7：编译报告
#
# ★ 必须有 before。DSPy 的输出很容易让人只看 after 那个数字，
# 而"编译后 0.82"这个数字**单独看没有任何意义**。
#
# 两种情况要显式报出来，因为它们的正确应对和直觉相反：
#
#   kept == 0     —— 一条示例都没攒到。零样本成功率为 0。
#                    ★ 这通常说明**签名错了或者指标错了**，
#                    不说明需要更多训练数据
#   lift <= 0     —— 编译没带来提升。
#                    ★ 真 DSPy 里这通常意味着**指标太粗**
#                    （比如只判精确匹配），而不是需要换 optimizer
# ─────────────────────────────────────────────────────────────


def compile_report(before: dict[str, float], after: dict[str, float], c: Compiled) -> str:
    raise NotImplementedError("TODO: 实现 compile_report")


# ─────────────────────────────────────────────────────────────
# 观察实验
# ─────────────────────────────────────────────────────────────

_M: Any = shared if IMPL == "shared" else sys.modules[__name__]


def _line(n: int = 66) -> str:
    return "─" * n


# 一个真实形状的 schema：pydantic 里 `filter: Filter` 加 `sort: Filter` 会长这样
NESTED_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {"type": "string"},
        "filter": {"$ref": "#/$defs/Criteria"},
        "sort": {"$ref": "#/$defs/Criteria", "description": "排序条件，覆盖默认描述"},
    },
    "required": ["query"],
    "$defs": {
        "Criteria": {
            "type": "object",
            "description": "默认描述",
            "properties": {"field": {"type": "string"}, "op": {"type": "string"}},
        }
    },
}

CYCLIC_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"root": {"$ref": "#/$defs/Node"}},
    "$defs": {
        "Node": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "children": {"type": "array", "items": {"$ref": "#/$defs/Node"}},
            },
        }
    },
}


def demo_schema() -> None:
    print(f"\n【一】pydantic 的 $ref，和模型解不开它这件事\n{_line()}")

    import json

    print("  pydantic 对嵌套 BaseModel 生成的 schema（简化）：")
    print(f"    properties.filter = {json.dumps(NESTED_SCHEMA['properties']['filter'])}")
    print("    $defs.Criteria    = {...}")
    print("\n  这是**合法的 JSON Schema 2020-12**。而 Anthropic 不解本地 $ref。")

    problems = _M.schema_health(NESTED_SCHEMA)
    print(f"\n  \033[31m体检查出 {len(problems)} 个问题：\033[0m")
    for p in problems:
        print(f"    · {p}")

    flat = _M.dereference(NESTED_SCHEMA)
    print("\n  解引用之后：")
    print(f"    properties.filter = {json.dumps(flat['properties']['filter'], ensure_ascii=False)}")
    print(f"    $defs 还在吗       = {'$defs' in flat}")
    print(f"    体检              = {len(_M.schema_health(flat))} 个问题")

    print("\n  注意 sort 那一项的兄弟键覆盖：")
    print(f"    sort.description  = {flat['properties']['sort'].get('description')!r}")
    print("    （不是 Criteria 自带的「默认描述」——JSON Schema 2020-12 的规定是兄弟键优先）")

    cyc = _M.dereference(CYCLIC_SCHEMA)
    print("\n  自引用的类型（树节点这种）不能内联：")
    print(f"    root 还是 $ref 吗  = {'$ref' in cyc['properties']['root']}")
    print(f"    $defs 保留了吗     = {'$defs' in cyc}")
    print("    ★ 内联一个环是无限递归。留着 $ref 至少让请求报错。")

    print("\n  ★ 三种失效方式，一种比一种难查：")
    print("    1. $defs 被中间层丢掉 → 悬空指针，请求被拒。**这个还算好，它报错**")
    print("    2. $defs 传过去了     → 模型把那个参数**当成字符串**填")
    print("    3. schema 里有 anyOf  → 模型挑错分支")
    print("\n  第 2 种最坑：**工具调用成功了**，参数看起来也像回事，")
    print("  只是那个嵌套对象是个 JSON 字符串。而你工具里")
    print("  args[\"filter\"][\"status\"] 抛的 TypeError，栈顶在你的工具里——")
    print("  和 schema 一个字的关系都看不出来。")


async def demo_concurrency() -> None:
    print(f"\n【二】gather 的孤儿任务：一个失败之后还有几个在烧钱\n{_line()}")

    paid: list[str] = []

    def job(name: str, ms: int, boom: bool = False) -> Callable[[], Any]:
        async def run() -> str:
            if boom:
                await asyncio.sleep(0.01)
                raise RuntimeError(f"{name} 挂了")
            await asyncio.sleep(ms / 1000)
            # ★ 这一行代表"这个 sub-agent 真的跑完了、真的花了钱"
            paid.append(name)
            return name

        return run

    def jobs() -> dict[str, Callable[[], Any]]:
        return {
            "boom": job("boom", 10, boom=True),
            "slow-1": job("slow-1", 120),
            "slow-2": job("slow-2", 120),
            "slow-3": job("slow-3", 120),
        }

    for runner, note in [
        (shared.run_with_gather, "★ 第一个异常立刻上抛，其余**不会被取消**"),
        (shared.run_with_task_group, "第一个失败 → 取消其余 → 打包成 ExceptionGroup"),
        (shared.run_with_settled, "各自跑完，异常当成值收回来（L11 的 fanout 用这个）"),
    ]:
        paid.clear()
        r = await runner(jobs())
        color = "\033[31m" if r.orphaned > 0 else "\033[32m"
        print(f"\n  {r.label}")
        print(
            f"    成功 {len(r.ok)}  失败 {len(r.failed)}  取消 {len(r.cancelled)}  "
            f"{color}失败瞬间还在跑 {r.orphaned} 个\033[0m"
        )
        print(f"    真正花了钱的：{len(paid)} 个  [{', '.join(paid)}]")
        print(f"    抛出：{r.raised or '（没有）'}")
        print(f"    {note}")

    print("\n  ★ 看第一组那个「还在跑 3 个」。")
    print("  在 agent 里这一条的后果很具体：一个 sub-agent 崩了，你的 fanout")
    print("  抛异常返回，而另外三个 sub-agent **还在调模型、还在跑工具、还在花钱**——")
    print("  只是没有人会读它们的结果了。")
    print("\n  Python 至少会在进程退出时打一句 \"Task was destroyed but it is still pending\"。")
    print("  而那条日志离真正的原因隔了很远，通常没人看。")
    print("\n  ★ 判据：**要「一个失败就全停」用 TaskGroup，")
    print("  要「各自跑完再看」用 gather(return_exceptions=True)。**")
    print("  朴素 gather 两个都不是——它是一个 bug 的名字。")


def demo_reducer() -> None:
    print(f"\n【三】reducer：LangGraph 唯一真正新的那件事\n{_line()}")

    print("  同一份消息历史，两种 reducer：")
    old = [{"id": "m1", "role": "user", "text": "帮我删掉临时文件"}]
    fix = [{"id": "m1", "role": "user", "text": "帮我删掉 /tmp 下我自己建的临时文件"}]

    naive = shared.append_reducer(old, fix)
    print(f"\n    append（operator.add）  →  {len(naive)} 条消息")
    for m in naive:
        print(f"        {m['id']}: {m['text']}")
    print("      \033[31m★ 历史里同时存在改前和改后两条。\033[0m")
    print("      模型看到两条互相矛盾的指令，而它不会报错——它会挑一条。")

    smart = _M.add_messages(old, fix)
    print(f"\n    add_messages           →  {len(smart)} 条消息")
    for m in smart:
        print(f"        {m['id']}: {m['text']}")
    print("      \033[32m按 id 覆盖。\033[0m这就是 add_messages 和 operator.add 的全部差别，")
    print("      而它决定了「人工改状态再恢复执行」这个功能是否能用。")

    print("\n  并发分支的合并：\n")
    g = StateGraph(reducers={"findings": shared.append_reducer})
    updates = [
        {"findings": ["auth 模块缺测试"], "current": "worker-1"},
        {"findings": ["billing 缺测试"], "current": "worker-2"},
        {"findings": ["api 缺测试"], "current": "worker-3"},
    ]
    state, clobbered = _M.merge_parallel(g, {"findings": [], "current": None}, updates)

    print(f"    findings（有 reducer）  →  {len(state['findings'])} 条，全保住了")
    print(f"    current（没有 reducer） →  {state['current']!r}")
    print(f"\n    \033[31m被静默覆盖的字段：{clobbered}\033[0m")
    print("\n  ★ 这就是整个 reducer 设计存在的理由。")
    print("  没有 reducer 的字段只能后写盖前写——而那意味着有节点的工作成果")
    print("  消失了，**而且没有任何地方会记录这件事**。")
    print("\n  真 LangGraph 的做法比这更硬：没声明 reducer 的字段被多个分支")
    print("  同时写，它直接报 InvalidUpdateError。**它宁可让你的图跑不起来，")
    print("  也不让你丢一次结果而不知道。**")


def demo_interrupt() -> None:
    print(f"\n【四】interrupt 与恢复：为什么「之前的代码必须幂等」\n{_line()}")

    # 一个节点：先写数据库，再 interrupt 等审批
    db: list[str] = []

    def risky(state: dict[str, Any]) -> dict[str, Any]:
        db.append(f"row-{state['task']}")  # 副作用
        if "_resume" not in state:
            raise Interrupt({"question": f"要执行 {state['task']} 吗？", "rows": len(db)})
        return {"done": True, "approved": state["_resume"]}

    g = StateGraph(reducers={})
    g.add_node("risky", risky)
    g.add_edge("risky", None)

    r1 = g.invoke({"task": "delete"}, thread_id="t1")
    print(f"  第一次跑：停在 interrupt，问「{r1['__interrupt__']['question']}」")
    print(f"    数据库里现在有 {len(db)} 条记录")

    r2 = g.invoke({}, thread_id="t1", resume=True)
    print(f"\n  批准之后恢复：done={r2.get('done')} approved={r2.get('approved')}")
    print(f"    \033[31m数据库里现在有 {len(db)} 条记录\033[0m")

    print("\n  ★ 两条。而这是 LangGraph 的正常行为，不是 bug。")
    print("\n  原因是**检查点存在「超步」边界上，不在节点函数中间**。")
    print("  恢复的时候，被中断那个节点会从函数开头重跑一遍——")
    print("  interrupt 之前的代码和副作用会**再执行一次**。")
    print("\n  这就是 LangGraph 文档里那句「interrupt 之前的代码必须幂等」的由来。")
    print("  而它和 L08 那节的幂等键是同一件事：")
    print("  **恢复不是「接着往下走」，是「重放到断点」。**")

    print("\n  检查点日志（对照 L13 的重放调试）：")
    for cp in g.history("t1"):
        mark = "  ⏸ 等人" if cp.interrupt else ""
        print(f"    step {cp.step}  节点 {cp.node}{mark}")


def demo_dspy() -> None:
    print(f"\n【五】DSPy：编译产物到底是什么\n{_line()}")

    # 一个假"程序"：中文数字转阿拉伯数字。
    #
    # 它模拟的是真实模型的典型形状：**简单情况零样本就对，复合情况零样本会错。**
    # 这一点很要紧——bootstrap 全靠"零样本能对的那部分"来攒示例。
    single = {"三": "3", "七": "7", "五": "5", "九": "9"}
    compound = {"十二": "12", "二十": "20", "三十五": "35"}

    def program(inputs: dict[str, Any], demos: list[Demo]) -> dict[str, Any]:
        cn = inputs["cn"]
        if cn in single:
            return {"num": single[cn]}  # 单字：零样本就对
        if not demos:
            return {"num": "?"}  # 复合：零样本答不出来
        return {"num": compound.get(cn, "?")}  # 有示例之后学会了组合规则

    def metric(out: dict[str, Any], expected: dict[str, Any]) -> float:
        return 1.0 if out.get("num") == expected.get("num") else 0.0

    trainset = [
        Example({"cn": "三"}, {"num": "3"}),
        Example({"cn": "十二"}, {"num": "12"}),  # 零样本会错，攒不进去
        Example({"cn": "七"}, {"num": "7"}),
        Example({"cn": "五"}, {"num": "5"}),
    ]
    devset = [
        Example({"cn": "九"}, {"num": "9"}),
        Example({"cn": "二十"}, {"num": "20"}),
        Example({"cn": "三十五"}, {"num": "35"}),
    ]

    before = shared.evaluate(program, devset, metric)
    c = _M.bootstrap_few_shot(program, trainset, metric, max_demos=3)
    after = shared.evaluate(program, devset, metric, c.demos)

    print("  编译产物（这就是 DSPy 的 compile 产出的东西）：")
    print(f"    指令：{c.instruction}")
    print(f"    示例 {len(c.demos)} 条：")
    for d in c.demos:
        print(f"      {d.inputs} → {d.outputs}   (score {d.score})")

    print()
    for line in _M.compile_report(before, after, c).splitlines():
        print(f"  {line}")

    print(f"\n  注意 trainset 里有 4 条，只攒到 {c.kept} 条。")
    print("  「十二」那条零样本答错了，所以进不了示例集——")
    print("  ★ bootstrap **只能用程序已经会做对的那部分**当示范。")

    print("\n  ★ 注意编译产物有多朴素：**一组示例 + 一段指令。**")
    print("  没有权重、没有魔法。它可以序列化成 JSON 存起来，")
    print("  也可以被人读、被 review、被手改。")
    print("\n  ★ 也注意示例里的输出是**程序自己生成的**，不是训练集的标注答案。")
    print("  这是 \"bootstrap\" 这个词的全部含义——用程序自己的成功轨迹当示范。")
    print("  好处是措辞和格式都合模型的习惯；代价是**它会把模型自己的偏好")
    print("  固化下来**，包括偏见。")

    # 一个坏指标：永远返回 0
    print("\n  换一个坏指标（永远判错）再编译一次：")
    bad = _M.bootstrap_few_shot(program, trainset, lambda *_: 0.0, max_demos=3)
    for line in _M.compile_report(before, before, bad).splitlines():
        print(f"    {line}")
    print("\n  ★ 这是 DSPy 最常见的失败形状，而它的正确诊断和直觉相反：")
    print("  一条示例都没攒到，说明**签名错了或者指标错了**——加数据没用。")
    print("\n  而这也是 DSPy 的入场券：**你必须先有一个指标。**")
    print("  没有 eval 集和指标，optimizer 无事可做——它整个机制就是")
    print("  「生成候选 → 用你的指标打分 → 留下分高的」。")
    print("\n  所以 DSPy 的前置条件正好是 L12 那节的交付物。这个顺序不是巧合：")
    print("  **大多数团队用不上 DSPy 的真实原因不是它难，是他们没有指标。**")


async def main() -> None:
    print(f"\n{'═' * 66}")
    print(f"L11x · Python agent 生态的四件机制（实现：{IMPL}）")
    print("═" * 66)

    demos: list[tuple[str, Any]] = [
        ("一", demo_schema),
        ("二", demo_concurrency),
        ("三", demo_reducer),
        ("四", demo_interrupt),
        ("五", demo_dspy),
    ]

    for n, fn in demos:
        try:
            r = fn()
            if asyncio.iscoroutine(r):
                await r
        except NotImplementedError as err:
            print(f"\n【{n}】\033[31m还没实现：{err}\033[0m")

    print(f"\n{_line()}")
    print("接着跑 pnpm eco —— 同样四件事在 TypeScript 里长什么样，以及哪两件根本没有。")


if __name__ == "__main__":
    asyncio.run(main())
