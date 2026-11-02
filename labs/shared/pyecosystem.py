"""参考实现：Python agent 生态里的四件核心机制。

这一节和别的节反过来：**Python 是主通道，TypeScript 是对照。**

理由很实在。你写 TS，但 agent 生态的重心在 Python——LangGraph、DSPy、
几乎所有 eval 框架、所有论文的参考实现。你不需要用 Python 写生产代码，
但你需要**看懂它们**，而且需要看懂到能判断"这个设计我该不该抄"。

所以这个文件不是在实现一个库，是在把四个库的**核心机制剥出来重写一遍**——
每个都短到能一眼看完，而看完之后你对着真库的源码知道自己在看什么。

    一、schema 解引用     —— pydantic 生成的 $ref，模型解不开（真实 bug）
    二、结构化并发         —— gather 的孤儿任务 vs TaskGroup
    三、reducer 状态图     —— LangGraph 的核心，也是你 L08 已经写过的东西
    四、few-shot 编译      —— DSPy 的核心，一个能跑的 BootstrapFewShot
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

# ─────────────────────────────────────────────────────────────
# 一、schema 解引用：pydantic 和工具 API 之间那条缝
# ─────────────────────────────────────────────────────────────

# ★ 这不是一个理论问题。它在 anything-llm、agno、MCP Python SDK
# 三个项目里都是有编号的 issue 和已合并的修复。
#
# 起因：pydantic 的 model_json_schema() 遇到嵌套 BaseModel 时，
# 会把嵌套那部分提到 $defs 里，用点上放一个 $ref 指过去。
# 这是**合法的 JSON Schema 2020-12**。
#
# 问题：Anthropic 的 tools API 不解本地 $ref。
#
# 而失效方式有三种，一种比一种难查：
#   1. $defs 被中间层丢掉  → 悬空指针，请求被拒（这个还算好，它报错）
#   2. $defs 传过去了       → 模型解不开 $ref，把那个参数**当成字符串**填，
#                             于是你收到一个 JSON 字符串而不是对象
#   3. schema 里有 anyOf    → 模型挑错分支，参数结构对不上
#
# 第 2 种是最坑的：**工具调用成功了**，参数看起来也像回事，
# 只是那个嵌套对象是个字符串。而你的工具实现里 `args["filter"]["status"]`
# 会抛 TypeError，栈顶在你的工具里，和 schema 一个字的关系都看不出来。


def dereference(schema: dict[str, Any]) -> dict[str, Any]:
    """把本地 $ref 内联进 schema，然后把 $defs 删掉。

    四个必须处理对的情况（真实修复里逐个列过）：

      简单引用   A -> D            内联，$defs 删掉
      菱形       A -> D, B -> D    D 解析一次，两处共享同一份内联值
      环         Node -> Node      **$ref 留在原地**，对应的 $defs 保留
                                   （不然就是无限递归）
      兄弟键     {"$ref":..., "description":...}
                                   按 2020-12：兄弟键覆盖解析出来的值
    """
    defs: dict[str, Any] = {**schema.get("$defs", {}), **schema.get("definitions", {})}
    if not defs:
        return schema

    # 先找出有环的定义。它们不能内联。
    cyclic = _find_cyclic(defs)

    def resolve(node: Any, seen: frozenset[str]) -> Any:
        if isinstance(node, list):
            return [resolve(x, seen) for x in node]
        if not isinstance(node, dict):
            return node

        ref = node.get("$ref")
        if isinstance(ref, str):
            name = _local_ref_name(ref)
            # 外部引用、解不出来的引用、以及有环的引用：原样留下。
            # ★ 留下比丢掉好——悬空指针至少会让请求报错，
            # 而丢掉会让模型看到一个"参数不存在"的 schema，静默走偏。
            if name is None or name not in defs or name in cyclic:
                return {k: resolve(v, seen) for k, v in node.items()}

            resolved = resolve(defs[name], seen | {name})
            # 兄弟键覆盖：{"$ref": X, "description": "..."} 里
            # description 要盖住 X 自带的那个
            siblings = {k: resolve(v, seen) for k, v in node.items() if k != "$ref"}
            return {**resolved, **siblings} if isinstance(resolved, dict) else resolved

        return {k: resolve(v, seen) for k, v in node.items()}

    body = {k: v for k, v in schema.items() if k not in ("$defs", "definitions")}
    out = resolve(body, frozenset())
    assert isinstance(out, dict)

    # 有环的定义必须留着，因为指向它们的 $ref 还在
    if cyclic:
        out["$defs"] = {k: v for k, v in defs.items() if k in cyclic}

    return out


def _local_ref_name(ref: str) -> str | None:
    for prefix in ("#/$defs/", "#/definitions/"):
        if ref.startswith(prefix):
            return ref[len(prefix) :]
    return None


def _find_cyclic(defs: dict[str, Any]) -> set[str]:
    """找出直接或间接自引用的定义名。"""
    edges: dict[str, set[str]] = {}
    for name, body in defs.items():
        found: set[str] = set()
        _collect_refs(body, found)
        edges[name] = found

    cyclic: set[str] = set()
    for start in edges:
        stack = [start]
        seen: set[str] = set()
        while stack:
            cur = stack.pop()
            for nxt in edges.get(cur, ()):
                if nxt == start:
                    cyclic.add(start)
                    stack.clear()
                    break
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
    return cyclic


def _collect_refs(node: Any, out: set[str]) -> None:
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            name = _local_ref_name(ref)
            if name:
                out.add(name)
        for v in node.values():
            _collect_refs(v, out)
    elif isinstance(node, list):
        for x in node:
            _collect_refs(x, out)


def schema_health(schema: dict[str, Any]) -> list[str]:
    """在把 schema 发出去之前查一遍。返回问题列表。

    ★ 这个函数的存在理由：上面那三种失效**全都不在你的代码里报错**。
    所以必须有一道主动检查，而且它得在发请求之前跑。
    """
    problems: list[str] = []
    refs: set[str] = set()
    _collect_refs(schema, refs)
    have = set(schema.get("$defs", {})) | set(schema.get("definitions", {}))

    dangling = refs - have
    if dangling:
        problems.append(
            f"悬空 $ref：{sorted(dangling)}。"
            "中间层大概率只复制了 type/properties/required 三个键，把 $defs 丢了。"
            "这个还算好——它会让请求直接被拒"
        )

    if refs & have:
        problems.append(
            f"schema 里还有本地 $ref：{sorted(refs & have)}。"
            "Anthropic 不解本地引用，模型会把那个参数**当成字符串**填——"
            "工具调用会成功，参数看起来也像回事，只是嵌套对象是个 JSON 字符串"
        )

    if _has_key(schema, "anyOf"):
        problems.append(
            "schema 里有 anyOf（通常来自 Optional[X] 或 Union）。"
            "模型挑错分支时不会报错，它会给你一个结构对不上的参数"
        )

    return problems


def _has_key(node: Any, key: str) -> bool:
    if isinstance(node, dict):
        return key in node or any(_has_key(v, key) for v in node.values())
    if isinstance(node, list):
        return any(_has_key(x, key) for x in node)
    return False


# ─────────────────────────────────────────────────────────────
# 二、结构化并发：gather 的孤儿任务
# ─────────────────────────────────────────────────────────────


@dataclass
class RunOutcome:
    """一次并发运行的结果 + 它留下的烂摊子。"""

    label: str
    ok: list[str]
    failed: list[str]
    #  被取消的。TaskGroup 会有，gather 永远是空——**这正是差别所在**。
    cancelled: list[str]
    #  ★ 这个字段是整组实验的重点：失败之后还在跑的任务有几个。
    #  它们在烧 token，而**没有任何人会读它们的结果**。
    orphaned: int
    #  墙上时间。孤儿任务会让它比"应该"的时间长。
    ms: float
    raised: str | None


Job = Callable[[], Any]


def _done_ok(t: asyncio.Task[Any]) -> bool:
    return t.done() and not t.cancelled() and t.exception() is None


def _done_err(t: asyncio.Task[Any]) -> bool:
    return t.done() and not t.cancelled() and t.exception() is not None


async def run_with_gather(jobs: dict[str, Job]) -> RunOutcome:
    """朴素 gather。**这是 bug，不是示例。**

    asyncio.gather(return_exceptions=False)：第一个异常立刻上抛，
    而**其余 awaitable 不会被取消，会继续跑到底**。

    在 agent 里这一条的后果很具体：一个 sub-agent 崩了，你的 fanout 抛异常
    返回，而另外三个 sub-agent 还在调模型、还在跑工具、还在花钱——
    只是没有人会读它们的结果了。

    症状之一是 "Task was destroyed but it is still pending"，
    而那条日志出现在**进程退出的时候**，离真正的原因隔了很远。
    """
    t0 = time.monotonic()
    tasks = {name: asyncio.create_task(fn(), name=name) for name, fn in jobs.items()}
    raised: str | None = None
    try:
        await asyncio.gather(*tasks.values())
    except asyncio.CancelledError:
        raise
    except BaseException as err:  # noqa: BLE001
        raised = f"{type(err).__name__}: {err}"

    # 立刻看一眼：异常上抛的那一瞬间，还有几个在跑
    orphaned = sum(1 for t in tasks.values() if not t.done())

    # ★ 这里故意**不取消**，而是等它们跑完——因为这才是真实行为。
    # 取消会把这个 demo 要展示的东西藏起来：那 3 个任务不是被中止了，
    # 它们**跑到底了、把钱花完了**，只是结果没人要。
    #
    # 真实代码里连这一句 await 都没有，于是它们跑到进程退出，
    # 然后留下一句 "Task was destroyed but it is still pending"。
    await asyncio.gather(*tasks.values(), return_exceptions=True)

    return RunOutcome(
        label="asyncio.gather（朴素）",
        ok=[n for n, t in tasks.items() if _done_ok(t)],
        failed=[n for n, t in tasks.items() if _done_err(t)],
        # ★ 朴素 gather 不取消任何东西，所以这里永远是空的。
        # 上面那 3 个"孤儿"不是被取消了，是**跑完了**。
        cancelled=[],
        orphaned=orphaned,
        ms=(time.monotonic() - t0) * 1000,
        raised=raised,
    )


async def run_with_task_group(jobs: dict[str, Job]) -> RunOutcome:
    """TaskGroup（3.11+）。结构化并发的标准答案。

    第一个非 CancelledError 的失败会：
      1. **取消组里其余任务**
      2. 等它们真正结束
      3. 把非取消类异常打包成 ExceptionGroup 抛出

    另外它对每个 task 持**强引用**——裸 create_task 只有弱引用，
    任务可能在跑完之前被 GC 掉（L10 那个"某些请求偶尔没有响应"的坑）。

    ★ 判据：**要"一个失败就全停"就用 TaskGroup，要"各自跑完再看"
    就用 gather(return_exceptions=True)。朴素 gather 两个都不是。**
    """
    t0 = time.monotonic()
    tasks: dict[str, asyncio.Task[Any]] = {}
    raised: str | None = None

    try:
        async with asyncio.TaskGroup() as tg:
            for name, fn in jobs.items():
                tasks[name] = tg.create_task(fn(), name=name)
    except* Exception as eg:
        # PEP 654 的 except*。多个任务同时失败时这里能拿到全部，
        # 而 gather 只会给你第一个。
        raised = "ExceptionGroup: " + "; ".join(f"{type(e).__name__}: {e}" for e in eg.exceptions)

    return RunOutcome(
        label="asyncio.TaskGroup",
        ok=[n for n, t in tasks.items() if _done_ok(t)],
        failed=[n for n, t in tasks.items() if _done_err(t)],
        # ★ 取消不算失败——它是我们自己要求的。分开记才看得清 TaskGroup 干了什么。
        cancelled=[n for n, t in tasks.items() if t.cancelled()],
        # TaskGroup 保证退出时没有任务在跑，所以这里必然是 0
        orphaned=sum(1 for t in tasks.values() if not t.done()),
        ms=(time.monotonic() - t0) * 1000,
        raised=raised,
    )


async def run_with_settled(jobs: dict[str, Job]) -> RunOutcome:
    """gather(return_exceptions=True)。L11 的 fanout 用的就是这个。

    语义是"各自跑完，异常当成值收回来"——**没有取消**。
    多 agent 扇出要的正是这个：一个 sub-agent 崩了不该让其余白跑。
    """
    t0 = time.monotonic()
    names = list(jobs)
    results = await asyncio.gather(*(jobs[n]() for n in names), return_exceptions=True)

    ok, failed = [], []
    for n, r in zip(names, results, strict=True):
        (failed if isinstance(r, BaseException) else ok).append(n)

    return RunOutcome(
        label="gather(return_exceptions=True)",
        ok=ok, failed=failed, cancelled=[], orphaned=0,
        ms=(time.monotonic() - t0) * 1000, raised=None,
    )


# ─────────────────────────────────────────────────────────────
# 三、reducer 状态图：LangGraph 的核心
# ─────────────────────────────────────────────────────────────

# ★ 先说结论，因为它能省你很多时间：
#
# **LangGraph 的核心机制，你在 L08 已经手写过了。**
#
#   LangGraph 的 checkpointer   = L08 的事件日志 + 快照
#   LangGraph 的 thread_id      = L08 的 session id
#   LangGraph 的 interrupt      = L14 那个人工审批闸
#   LangGraph 的 reducer        = 这一小节唯一真正新的东西
#
# 而 reducer 之所以是核心，是因为它解决了一个具体问题：
# **图里多个节点并发更新同一份状态时，怎么合并。**
#
# 这个问题在链式流程里不存在（一次只有一个节点在写），
# 在扇出的时候立刻出现。而 LangGraph 的答案不是加锁，是
# **要求你为每个会被并发写的字段声明一个合并函数**。

Reducer = Callable[[Any, Any], Any]


def append_reducer(old: Any, new: Any) -> Any:
    """operator.add 那一类。直接拼。"""
    if old is None:
        return list(new) if isinstance(new, list) else [new]
    add = new if isinstance(new, list) else [new]
    return [*old, *add]


def add_messages(old: Any, new: Any) -> Any:
    """LangGraph 的 add_messages。

    ★ 它和 operator.add 的差别是这一小节最值得记住的一处：
    **它按 id 去重并覆盖。**

    为什么必须这样：人工修改状态（把某条消息改掉再恢复执行）时，
    用 operator.add 会把改后的那条**追加**到列表末尾，
    于是历史里同时存在改前和改后两条。

    模型看到的是两条互相矛盾的消息，而它不会报错——
    它会挑一条，通常是后一条，有时不是。
    """
    old_list: list[dict[str, Any]] = list(old or [])
    new_list = new if isinstance(new, list) else [new]

    by_id = {m["id"]: i for i, m in enumerate(old_list) if isinstance(m, dict) and "id" in m}
    out = list(old_list)

    for m in new_list:
        mid = m.get("id") if isinstance(m, dict) else None
        if mid is not None and mid in by_id:
            out[by_id[mid]] = m  # 覆盖，不追加
        else:
            out.append(m)
    return out


def last_write_wins(_old: Any, new: Any) -> Any:
    """默认行为：后写的盖掉前面的。

    ★ 这是 LangGraph 里没声明 reducer 的字段的行为，
    也是**并发扇出时最容易出事的那个默认值**——
    两个节点同时写，一个的结果无声消失。
    """
    return new


@dataclass
class Checkpoint:
    """一个检查点。对照 L08 的快照。"""

    step: int
    node: str
    state: dict[str, Any]
    #  ★ 停在这里等人。对照 L14 的审批闸。
    interrupt: Any | None = None


class Interrupt(Exception):  # noqa: N818
    """节点里抛这个 = LangGraph 的 interrupt()。

    ★ 它不是错误，是一个**控制流原语**。用异常来实现的理由是
    它要能从节点函数体的任意深度把控制权交出去。
    """

    def __init__(self, value: Any):
        super().__init__("interrupted")
        self.value = value


NodeFn = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass
class StateGraph:
    """一个能跑的最小状态图。

    对照真 LangGraph：省掉了条件边的表达力、并行分支的拓扑排序、
    异步节点、流式输出。保留的是三件核心机制：
    **reducer 合并、checkpoint 持久化、interrupt 暂停恢复。**
    """

    reducers: dict[str, Reducer]
    nodes: dict[str, NodeFn] = field(default_factory=dict)
    #  节点名 -> 下一个节点名（None 表示结束）
    edges: dict[str, str | None] = field(default_factory=dict)
    entry: str = ""
    #  检查点日志。thread_id -> 检查点列表
    log: dict[str, list[Checkpoint]] = field(default_factory=dict)

    def add_node(self, name: str, fn: NodeFn) -> StateGraph:
        self.nodes[name] = fn
        if not self.entry:
            self.entry = name
        return self

    def add_edge(self, src: str, dst: str | None) -> StateGraph:
        self.edges[src] = dst
        return self

    def merge(self, state: dict[str, Any], update: dict[str, Any]) -> dict[str, Any]:
        """把一次节点更新合并进状态。

        ★ 没声明 reducer 的字段走 last_write_wins。
        这个默认值在串行图里无害，在并发扇出时会静默丢结果。
        """
        out = dict(state)
        for k, v in update.items():
            reducer = self.reducers.get(k, last_write_wins)
            out[k] = reducer(out.get(k), v)
        return out

    def merge_parallel(
        self, state: dict[str, Any], updates: Sequence[dict[str, Any]]
    ) -> tuple[dict[str, Any], list[str]]:
        """并发分支的合并。返回 (新状态, 被静默覆盖的字段名)。

        ★ 这个函数是整个 reducer 设计存在的理由。

        三个节点并发跑完，各自返回一份 update。没有 reducer 的字段
        只能后写盖前写——而那意味着**有节点的工作成果消失了，
        而且没有任何地方会记录这件事**。

        所以这里把"被覆盖了"作为返回值的一部分交出去。
        真 LangGraph 的做法更硬：没声明 reducer 的字段被多个分支同时写，
        它直接报 InvalidUpdateError。
        """
        out = dict(state)
        # 去重但保持顺序：这是字段名的集合，不是"覆盖发生了几次"的计数
        clobbered: dict[str, None] = {}
        written: set[str] = set()

        for update in updates:
            for k, v in update.items():
                if k not in self.reducers and k in written:
                    clobbered[k] = None
                written.add(k)
                out[k] = self.reducers.get(k, last_write_wins)(out.get(k), v)

        return out, list(clobbered)

    def invoke(
        self,
        state: dict[str, Any],
        thread_id: str,
        resume: Any | None = None,
        max_steps: int = 32,
    ) -> dict[str, Any]:
        """跑图。撞到 Interrupt 就存检查点并返回。

        ★ 恢复的语义是这一小节最容易被漏掉的一条：
        **检查点存在"超步"边界上，不在节点函数中间。**

        所以恢复的时候，被中断那个节点会**从函数开头重跑一遍**——
        interrupt 之前的代码和副作用会再执行一次。

        这就是 LangGraph 文档里那句"interrupt 之前的代码必须幂等"的由来，
        而它和 L08 那节的幂等键是同一件事：
        **恢复不是"接着往下走"，是"重放到断点"。**
        """
        log = self.log.setdefault(thread_id, [])
        cur = self.entry
        step = len(log)

        if resume is not None and log and log[-1].interrupt is not None:
            # 从上一个检查点恢复：状态是断点前的，节点是断点那个
            snap = log[-1]
            state = dict(snap.state)
            cur = snap.node
            state["_resume"] = resume

        while cur and step < max_steps:
            fn = self.nodes[cur]
            try:
                update = fn(state)
            except Interrupt as it:
                log.append(Checkpoint(step=step, node=cur, state=dict(state), interrupt=it.value))
                return {**state, "__interrupt__": it.value}

            state = self.merge(state, update)
            log.append(Checkpoint(step=step, node=cur, state=dict(state)))
            step += 1
            cur = self.edges.get(cur)

        return state

    def history(self, thread_id: str) -> list[Checkpoint]:
        """时间旅行。对照 L13 的重放调试。"""
        return list(self.log.get(thread_id, []))


def merge_parallel(
    graph: StateGraph, state: dict[str, Any], updates: Sequence[dict[str, Any]]
) -> tuple[dict[str, Any], list[str]]:
    """StateGraph.merge_parallel 的模块级入口，方便 scaffold 里替换实现。"""
    return graph.merge_parallel(state, updates)


def add_messages_reducer() -> Reducer:
    """给 scaffold 用的取值口，避免直接引用未实现的符号。"""
    return add_messages


# ─────────────────────────────────────────────────────────────
# 四、few-shot 编译：DSPy 的核心
# ─────────────────────────────────────────────────────────────

# ★ DSPy 的一句话版本：**把 prompt 当成可以被编译的东西。**
#
# 你写的是"签名"（输入字段 → 输出字段）和"模块"（怎么组合），
# 不写具体的 prompt 文字。然后 optimizer 拿着你的训练集和**你的指标**，
# 反复跑你的程序，产出一份"编译好的" prompt。
#
# 编译产物具体是什么，这一点值得说清楚，因为它比听起来朴素得多：
#
#   BootstrapFewShot   —— 一组 few-shot 示例（从训练集里跑出来、指标判对的那些）
#   MIPROv2            —— few-shot 示例 + 重写过的指令，贝叶斯搜索联合优化
#   GEPA               —— 重写过的指令，靠指标返回的**自然语言反馈**做反思式进化
#   BootstrapFinetune  —— 模型权重
#
# 前三个都只动 prompt，模型不碰，所以闭源模型也能用。
#
# ★ 而这里有一个前置条件，是 DSPy 最常被跳过、也最要紧的一条：
# **你必须有一个指标。**
#
# 没有 eval 集和指标，optimizer 无事可做——它整个机制就是
# "生成候选 → 用你的指标打分 → 留下分高的"。
#
# 所以 DSPy 的入场券，正好是 L12 那节的交付物。
# 这个顺序不是巧合：**大多数团队用不上 DSPy 的真实原因不是它难，
# 是他们没有指标。**


@dataclass
class Example:
    inputs: dict[str, Any]
    #  期望输出。BootstrapFewShot 靠它判断一次运行算不算对。
    expected: dict[str, Any]


@dataclass
class Demo:
    """一条 few-shot 示例。这就是"编译产物"的实体。"""

    inputs: dict[str, Any]
    outputs: dict[str, Any]
    score: float


@dataclass
class Compiled:
    """编译结果。

    注意它有多朴素：**一组示例 + 一段指令。** 没有权重、没有魔法。
    它可以序列化成 JSON 存起来，也可以被人读、被 review、被手改。
    """

    demos: list[Demo]
    instruction: str
    #  编译过程的账：跑了多少次、花了多少钱、命中率多少
    trials: int
    kept: int
    metric_calls: int


Program = Callable[[dict[str, Any], list[Demo]], dict[str, Any]]
Metric = Callable[[dict[str, Any], dict[str, Any]], float]


def bootstrap_few_shot(
    program: Program,
    trainset: list[Example],
    metric: Metric,
    *,
    max_demos: int = 4,
    threshold: float = 1.0,
) -> Compiled:
    """一个能跑的 BootstrapFewShot。

    机制和真 DSPy 一致：

      1. 拿训练集里的样本，**用当前程序（零 few-shot）跑一遍**
      2. 用你的指标给输出打分
      3. 分数达标的，把「输入 → 程序自己产出的输出」留作 few-shot 示例
      4. 攒够 max_demos 就停

    ★ 第 3 步值得停一下：留下的示例里，输出是**模型自己生成的**，
    不是训练集里的标注答案。

    这是 "bootstrap" 这个词的全部含义——用程序自己的成功轨迹
    当示范。好处是示例的措辞、格式、思路都和模型的习惯一致；
    代价是**它会把模型自己的偏好固化下来**，包括偏见。
    """
    demos: list[Demo] = []
    trials = 0
    metric_calls = 0

    for ex in trainset:
        if len(demos) >= max_demos:
            break
        trials += 1
        # 注意这里传空 demos：bootstrap 阶段程序是零样本跑的
        out = program(ex.inputs, [])
        score = metric(out, ex.expected)
        metric_calls += 1
        if score >= threshold:
            demos.append(Demo(inputs=ex.inputs, outputs=out, score=score))

    return Compiled(
        demos=demos,
        instruction=_instruction_for(demos),
        trials=trials,
        kept=len(demos),
        metric_calls=metric_calls,
    )


def _instruction_for(demos: list[Demo]) -> str:
    if not demos:
        # ★ 一条也没攒到，是一个**必须报出来**的信号，不是空结果。
        # 它意味着零样本成功率为 0——而那通常说明签名错了或者指标错了，
        # 不说明需要更多训练数据。
        return '（没有攒到任何示例。零样本成功率为 0，先检查签名和指标，不要加数据）'
    keys = sorted({k for d in demos for k in d.outputs})
    return f"按示例的格式回答。输出字段：{'、'.join(keys)}。"


def evaluate(
    program: Program,
    devset: list[Example],
    metric: Metric,
    demos: list[Demo] | None = None,
) -> dict[str, float]:
    """在验证集上评一遍。

    ★ 编译前后各跑一次是最低要求。
    只看编译后的分数，你不知道优化到底有没有起作用——
    也不知道它是不是**把 devset 记住了**。
    """
    scores = [metric(program(ex.inputs, demos or []), ex.expected) for ex in devset]
    n = len(scores) or 1
    return {
        "mean": sum(scores) / n,
        "n": float(len(scores)),
        "perfect": float(sum(1 for s in scores if s >= 1.0)),
    }


def compile_report(before: dict[str, float], after: dict[str, float], c: Compiled) -> str:
    """一份诚实的编译报告。

    ★ 必须有 before。DSPy 的输出很容易让人只看 after 那个数字，
    而"编译后 0.82"这个数字单独看没有任何意义。
    """
    lift = after["mean"] - before["mean"]
    lines = [
        f"编译前 {before['mean']:.2f}  →  编译后 {after['mean']:.2f}   （{lift:+.2f}）",
        f"攒到示例 {c.kept}/{c.trials} 条，指标被调用 {c.metric_calls} 次",
    ]
    if c.kept == 0:
        lines.append(
            "★ 一条示例都没攒到。零样本成功率为 0——先查签名和指标，加数据没用"
        )
    elif lift <= 0:
        lines.append(
            "★ 编译没带来提升。真 DSPy 里这通常意味着指标太粗"
            "（比如只判精确匹配），而不是需要换 optimizer"
        )
    return "\n".join(lines)
