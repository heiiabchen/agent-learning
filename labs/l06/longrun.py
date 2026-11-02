"""L06 任务三：把上下文管理接到 L05 的 agent 上，量出它值多少钱（Python 版）。

    uv run python -m l06.longrun

默认用假模型跑，所以不花钱、结果确定、能反复对比。
最后有一个 TODO 让你换成真模型跑一次——那一次是为了看**质量**差异，
而假模型这一轮是为了看**数量**差异。

这是这一节唯一能"量出来"的任务。前两个任务都是为它做准备。
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any

from shared.agent import REASON_TEXT, AgentRun, run_agent
from shared.compress import compress, should_compress
from shared.context_budget import DEFAULT_BUDGET, format_stats, measure, paginate
from shared.fake import FakeBlock, FakeMessage, FakeModel, FakeTurn, FakeUsage
from shared.tools import (
    ParseOk,
    ParseResult,
    ToolBox,
    ToolDef,
    ToolResult,
    optional_int,
    require_string,
)

# ─────────────────────────────────────────────────────────────
# 一个假的代码库。每个"文件"都不小，这是重点。
# ─────────────────────────────────────────────────────────────

FILES: dict[str, str] = {}
for i in range(12):
    lines = [f"# src/mod{i}/__init__.py", "from shared.util import helper", ""]
    for j in range(400):
        lines.append(f"def fn{i}_{j}(value: str) -> str:")
        lines.append(f"    # 这是第 {j} 个函数的实现细节，对理解架构没有帮助")
        lines.append(f"    return helper(value) + '{i}_{j}'")
        lines.append("")
    FILES[f"src/mod{i}/__init__.py"] = "\n".join(lines)


def make_read_file(trim: bool) -> ToolDef:
    """裁剪版的 read_file：只给骨架，要细节自己分页。"""

    def parse(raw: Any) -> ParseResult:
        p = require_string(raw, "path")
        if not p.ok:
            return p
        return ParseOk(
            input={"path": p.input, "offset": optional_int(raw, "offset", 0, 0, 10**9)}
        )

    async def run(inp: dict[str, Any]) -> ToolResult:
        text = FILES.get(inp["path"])
        if text is None:
            return ToolResult(
                content=f"没有这个文件：{inp['path']}。用 list_dir 看看有哪些。", is_error=True
            )
        if not trim:
            return ToolResult(content=text)
        return ToolResult(content=paginate(text, offset=inp["offset"], limit=60))

    return ToolDef(
        name="read_file",
        description=(
            "读文件。默认返回前 60 行，要看后面用 offset。" if trim else "读文件，返回全部内容。"
        ),
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}, "offset": {"type": "integer"}},
            "required": ["path"],
        },
        parse=parse,
        run=run,
    )


async def _list_dir(_: Any) -> ToolResult:
    return ToolResult(content="\n".join(FILES))


LIST_DIR = ToolDef(
    name="list_dir",
    description="列出仓库里所有文件的路径。",
    input_schema={"type": "object", "properties": {}, "required": []},
    parse=lambda _: ParseOk(input={}),
    run=_list_dir,
)


def box(trim: bool) -> ToolBox:
    return ToolBox([make_read_file(trim), LIST_DIR])


SYSTEM = """你在读一个陌生代码库，目标是写出架构说明。

<workflow>
1. list_dir 摸清结构
2. 逐个 read_file，只看骨架就够
3. 每读完一个模块记下结论
</workflow>

<giving_up>
如果同一个方法试了两次都不行，说明思路不对。停下来说明你卡在哪、需要什么。
</giving_up>"""


def script() -> list[FakeTurn]:
    """让假模型按顺序把 12 个文件读一遍，然后给结论。"""
    turns = [FakeTurn(text="先看看有哪些文件。", tool_uses=[{"name": "list_dir", "input": {}}])]
    for path in FILES:
        turns.append(
            FakeTurn(
                text=f"读 {path}。",
                tool_uses=[{"name": "read_file", "input": {"path": path}}],
            )
        )
    turns.append(FakeTurn(text="读完了。这个代码库有 12 个模块，都依赖 shared/util 的 helper。"))
    return turns


# ─────────────────────────────────────────────────────────────
# 压缩用的假模型：返回一份结构良好的摘要
# ─────────────────────────────────────────────────────────────


async def summarizer(messages: list[dict]) -> FakeMessage:
    # ★ default=str 不是可选的：transcript 里 assistant 那条装的是模型对象
    #   （run_agent 把 res.content 原样放回去了），不是 dict。
    #   少了它这里会抛 "Object of type X is not JSON serializable"——
    #   而且只在压缩真的触发时才炸，本地小样本很容易测不到。
    dumped = json.dumps(messages, ensure_ascii=False, default=str)
    seen = re.findall(r"src/mod\d+/__init__\.py", dumped)
    uniq = list(dict.fromkeys(seen))
    done = "\n".join(f"- 读完 {f}，是一组导出函数，依赖 shared/util" for f in uniq) or "- 无"
    text = f"""<goal>读懂这个代码库，写一份架构说明</goal>
<done>
{done}
</done>
<found>
- 所有模块都依赖 shared/util 的 helper
- 每个模块导出 400 个同构的函数，实现细节对架构无意义
</found>
<failed>无</failed>
<next>继续读剩下的模块</next>"""

    return FakeMessage(
        id="msg_sum",
        model="deepseek-v4-flash",
        content=[FakeBlock(type="text", text=text)],
        stop_reason="end_turn",
        usage=FakeUsage(input_tokens=8000, output_tokens=400),
    )


# ─────────────────────────────────────────────────────────────
# 跑一次，把上下文变化记下来
# ─────────────────────────────────────────────────────────────


@dataclass
class RunReport:
    label: str
    run: AgentRun
    peak: int
    peak_ratio: float
    cumulative_input: int
    compressions: int


async def once(label: str, trim: bool, with_compress: bool) -> RunReport:
    # 标题先打，因为压缩的日志是在跑的过程中产生的——
    # 先跑后打标题会让日志出现在上一轮的标题下面。
    print(f"\n  {label}")

    toolbox = box(trim)
    fake = FakeModel(script(), after="final")
    tools = toolbox.api_tools()

    state = {"peak": 0, "cumulative": 0, "compressions": 0}
    total_steps = len(script())

    async def call(messages: list[dict]) -> Any:
        """在 call 这一层介入，是为了不改 run_agent 本身。

        这个位置能看到每一步真实发出去的 messages——也是唯一能看到的地方。
        """
        stats = measure(SYSTEM, tools, messages)
        state["peak"] = max(state["peak"], stats.tokens)
        state["cumulative"] += stats.tokens

        if with_compress:
            steps_left = max(0, total_steps - len(fake.calls))
            d = should_compress(stats, steps_left)
            if d.compress:
                state["compressions"] += 1
                print(f"      ↳ 第 {len(fake.calls) + 1} 步压缩：{d.why}")
                r = await compress(messages, summarizer, keep_recent=4)
                # ★ 原地改写调用方的 list：run_agent 持有的是同一个引用。
                #   Python 这边尤其要注意——`messages = r.messages` 只会重新绑定
                #   本地名字，run_agent 那边一点变化都看不到，而且不会报错。
                #   这类"改了但没生效"的 bug 在 Python 里比 TS 更常见，
                #   因为 TS 至少会因为参数是 const 而让你多想一秒。
                messages[:] = r.messages

        return await fake.call(messages)

    run = await run_agent(
        "读懂这个代码库，写一份架构说明。",
        toolbox=toolbox,
        system=SYSTEM,
        call=call,
        max_steps=40,
        max_yuan=5,
    )

    available = DEFAULT_BUDGET.window - DEFAULT_BUDGET.reserve_output
    return RunReport(
        label=label,
        run=run,
        peak=state["peak"],
        peak_ratio=state["peak"] / available,
        cumulative_input=state["cumulative"],
        compressions=state["compressions"],
    )


def report(r: RunReport) -> None:
    print(f"    终止原因   {r.run.reason}（{REASON_TEXT[r.run.reason]}）")
    print(f"    步数       {r.run.steps}")
    print(f"    峰值上下文 {r.peak} tok（占可用额度 {round(r.peak_ratio * 100)}%）")
    print(f"    累积输入   {r.cumulative_input} tok")
    print(f"    压缩次数   {r.compressions}")
    if r.run.error:
        print(f"    异常       {r.run.error}")


async def main() -> None:
    print("同一个长任务，四种上下文策略。不调 API。")

    bare = await once("一 · 什么都不做", trim=False, with_compress=False)
    report(bare)
    print("    ↳ 峰值超过了可用额度，真实 API 会在中途直接报错。")

    only_compress = await once("二 · 只做摘要压缩（手段三）", trim=False, with_compress=True)
    report(only_compress)

    only_trim = await once("三 · 只做源头裁剪（手段一）", trim=True, with_compress=False)
    report(only_trim)

    both = await once("四 · 两个都做", trim=True, with_compress=True)
    report(both)

    print("\n" + "─" * 60)

    def cut(a: int, b: int) -> str:
        return f"{round((1 - b / a) * 100)}%"

    print('峰值上下文（决定"会不会撞上限、会不会变笨"）：')
    print(f"  一 {bare.peak}　二 {only_compress.peak}　三 {only_trim.peak}　四 {both.peak}")
    print(
        f"    只压缩：砍掉 {cut(bare.peak, only_compress.peak)}，"
        f"代价是 {only_compress.compressions} 次压缩调用 + 丢信息 + 毁缓存"
    )
    print(f"    只裁剪：砍掉 {cut(bare.peak, only_trim.peak)}，代价是零")

    print("\n累积输入（决定账单）：")
    print(
        f"  一 {bare.cumulative_input}　二 {only_compress.cumulative_input}　"
        f"三 {only_trim.cumulative_input}　四 {both.cumulative_input}"
    )

    print(f"\n★ 看第四轮的压缩次数：{both.compressions}。")
    print("  源头裁剪做够了之后，压缩一次都没触发——因为它根本没到触发线。")
    print("  这就是「手段按代价排序」的意思：把第一档做完，第三档常常就不需要了。")
    print("  而大多数人跳过第一档直接做第三档，于是一边漏水一边擦地。")

    stats = measure(SYSTEM, box(True).api_tools(), both.run.transcript)
    print(f"\n最终上下文构成：{format_stats(stats)}")
    print("  work 仍然占九成以上——它永远是大头，所以永远先看它。")


# ─────────────────────────────────────────────────────────────
# TODO：换成真模型跑一次
#
# 上面四轮用的都是假模型，所以量出来的是**数量**差异（峰值、累积、花费）。
# 但有一个东西假模型量不出来：**质量**。
#
# 把 call 换成 shared/models.py 里真实的 client 调用，跑同一个任务，然后看：
#
# 1. 不做任何处理那一轮，agent 在第几步开始重复读同一个文件？
# 2. 它最后给的架构说明，有没有漏掉「所有模块都依赖 shared/util」这个事实？
# 3. 加上压缩之后，那个事实还在不在？
#
# 第 3 问是这一节最重要的检验：**压缩有没有把关键事实丢掉。**
# 而检验它的唯一办法是事先准备一份「必须提到的事实」清单——
# 这也是 L12 做 evals 的入门形态。
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    asyncio.run(main())
