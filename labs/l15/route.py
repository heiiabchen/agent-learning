"""L15 的交付物：**成本审计**。跑法：uv run python -m l15.route

这个程序做的事，一句话：**它拒绝报出它证明不了的省钱。**

为什么要这么设计。这一节从头到尾只有一个论点：
    缓存、路由、批处理失败的时候**不报错**。
那么一个「报出省了多少钱」的工具就有一个内建的失效模式——
它在你其实没省到钱的时候，也会给你一个好看的数字。

所以这份报告的每一段都要先回答「这个数我凭什么信」，再报数。

★ 一个注意点：这里的 usage **不是我编的**，是 FakeEndpoint 按官方公布的
规则从请求算出来的。所以你改 BACKGROUND 里的一个字符，下面每个数字都会
跟着动，而且动的方向是可解释的。编出来的 usage 做不到这一点——它会和请求
脱节，于是「白付了多少 token」和「总输入」变成两套互相矛盾的口径。

这个文件是 l15/route.ts 的镜像，输出逐字节一致。
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from shared.budget import (
    CACHE_READ,
    CACHE_WRITE_5M,
    Block,
    CacheReport,
    Divergence,
    FakeEndpoint,
    Lcg,
    ModelSpec,
    Mult,
    Price,
    ProviderShape,
    Req,
    Router,
    Task,
    ToolDef,
    all_strong,
    cache_verdict,
    charge,
    first_divergence,
    prefix_tokens,
    route_outcome,
    yuan,
)

# ─────────────────────────────────────────────────────────────
# 被审计的对象
# ─────────────────────────────────────────────────────────────

# 单价。1 元/M = 100_000_000 微分/M。
FLASH = Price(input_miss=100_000_000, output=200_000_000)
PRO = Price(input_miss=300_000_000, output=600_000_000)

MODEL = "claude-opus-5"  # 最低可缓存 512 token

TOOLS = (
    ToolDef(
        "read_file",
        "读一个文件的全部内容，返回带行号的文本。路径相对于仓库根目录。",
        {"path": "string"},
    ),
    ToolDef(
        "write_file",
        "覆盖写入一个文件。调用前必须先 read_file 确认当前内容。",
        {"content": "string", "path": "string"},
    ),
    ToolDef(
        "run_tests",
        "跑测试套件，返回失败用例的名字和断言信息。filter 是可选的用例名前缀。",
        {"filter": "string"},
    ),
)

# 项目背景。
#
# ★ 这段刻意写得够长。不是为了凑字数，是因为**短前缀根本进不了缓存**，
# 而那会让整个实验得出一个误导性的结论。
#
# Opus 5 的最低可缓存长度是 512 token（官方清单）。一段 300 token 的
# system prompt 无论你怎么标 cache_control 都不会被缓存，而且**不报错**。
# 真实项目里这部分（AGENTS.md、.cursor/rules、工具清单）通常一两千 token，
# 所以这里按真实规模写——否则你会得出「缓存没用」这个错结论，
# 而真正的原因只是「你的前缀太短」。
BACKGROUND = "\n".join(
    [
        "项目是一个 TypeScript 单体仓库，用 pnpm workspace 管理，"
        "包含 web、api、worker、shared 四个包。",
        "web 是 Vite + React 19，路由用 react-router，"
        "状态只用 useState 和 context，不引入额外的状态库。",
        "api 是 Fastify，数据库是 Postgres，"
        "查询层用 Kysely 而不是 ORM，所有 SQL 必须是类型安全的。",
        "worker 跑后台任务，队列用 pg-boss，任务必须幂等，因为它会在部署时被重启。",
        "shared 放两端共用的类型和校验器，校验用 zod，"
        "类型一律从 zod schema 推导出来，不要手写两份。",
        "",
        "测试用 vitest。所有改动必须先跑 pnpm test 再提交，一个失败都不允许留着。",
        "禁止用 it.skip 或 it.only 绕过失败的测试。"
        "如果一个测试确实过时了，删掉它并在提交信息里说明理由。",
        "新增的每个导出函数都要有测试，覆盖正常路径和至少一个失败路径。",
        "",
        "代码风格：不用 default export，所有导出都是命名导出，"
        "这样重命名和查引用才靠得住。",
        "不用 any，也不用 as 断言来绕类型错误——"
        "遇到类型不对先想清楚是不是设计有问题。",
        "错误必须显式处理，不能 catch 之后什么都不做。"
        "如果确实要忽略，写注释说明为什么可以忽略。",
        "不要在 catch 里吞掉错误然后返回一个默认值，"
        "那会让上层拿到一个看起来正常的错结果。",
        "异步函数一律用 async/await，不要混用 .then()，也不要漏掉 await。",
        "",
        "数据库迁移在 api/migrations 下，文件名带时间戳前缀，必须可回滚。",
        "迁移里不允许写业务数据，只改结构。需要初始数据的话另写一个 seed 脚本。",
        "加索引的迁移要用 CREATE INDEX CONCURRENTLY，因为线上表很大，会锁表。",
        "删列分两步：先发一版代码不再读它，确认稳定之后再发迁移删列。"
        "不要一次做完。",
        "",
        "提交信息用中文，第一行以内说清改了什么。"
        "不要写「修复若干问题」「优化代码」这类没有信息量的话。",
        "一个提交只做一件事。重构和功能改动要分开提交，"
        "这样出问题时才能单独回滚。",
        "",
        "遇到不确定的取舍先问，不要自己挑一个然后改一大片——"
        "改错方向的代价比多问一句高得多。",
        "涉及钱、权限、用户数据的改动，一律先说明方案再动手。",
    ]
)


def system_at(minute: int) -> tuple[Block, ...]:
    """★ 这个 system prompt 里埋了这一节最贵的那个 bug，而且它长得非常无辜。

    看第二块。一个「当前时间」——几乎每个人都写过这一行，理由也很正当：
    模型不知道今天几号。

    后果：tools 层稳定、system 第一块稳定，但**第二块每次都变**，
    而断点就在它上面。于是每次都是一次全新的缓存写入，一次读都拿不到。
    按官方定价，5 分钟缓存写入是基础价的 1.25 倍——也就是说
    **它比根本不开缓存还贵 25%**，而日志上完全正常。
    """
    return (
        Block(type="text", text=BACKGROUND),
        Block(
            type="text",
            text=f"当前时间：2026-09-15 10:{minute:02d}",
            cache_control_ttl="5m",
        ),
    )


def system_fixed(minute: int) -> tuple[Block, ...]:
    """把断点挪到稳定内容上——同样的会话，唯一的区别是断点位置。"""
    return (
        Block(type="text", text=BACKGROUND, cache_control_ttl="5m"),
        Block(type="text", text=f"当前时间：2026-09-15 10:{minute:02d}"),
    )


@dataclass
class Step:
    label: str
    req: Req
    shape: ProviderShape
    usage: dict[str, Any]
    output_tokens: int


def session(sys_fn: Callable[[int], tuple[Block, ...]]) -> list[Step]:
    """一次六步的会话。sys_fn 决定断点放哪儿——这是整个实验唯一的自变量。"""
    ep = FakeEndpoint("anthropic", MODEL)
    msgs: list[Block] = []
    steps: list[Step] = []

    def run(label: str, minute: int, out: int, shape: ProviderShape = "anthropic") -> None:
        req = Req(model=MODEL, tools=TOOLS, system=sys_fn(minute), messages=tuple(msgs))
        # ★ usage 是算出来的。兼容端点用一个独立的端点实例，因为它的字段形状不同。
        usage = (
            ep.send(req, out)
            if shape == "anthropic"
            else FakeEndpoint(shape, MODEL).send(req, out)
        )
        steps.append(Step(label, req, shape, usage, out))

    msgs.append(Block(type="text", text="把 auth 模块的重试逻辑抽出来，单独成一个函数。"))
    run("第 1 步 首次请求", 10, 180)

    msgs.append(
        Block(type="tool_use", extra={"name": "read_file", "input": {"path": "src/auth.ts"}})
    )
    msgs.append(
        Block(
            type="tool_result",
            extra={
                "content": (
                    "export async function login(email: string, pw: string)"
                    " { /* 略 300 行 */ }"
                )
            },
        )
    )
    run("第 2 步 读文件后", 11, 210)

    msgs.append(Block(type="text", text="看一下现有的测试覆盖到哪些分支。"))
    run("第 3 步 又一轮", 12, 160)

    msgs.append(
        Block(type="tool_use", extra={"name": "run_tests", "input": {"filter": "auth"}})
    )
    msgs.append(Block(type="tool_result", extra={"content": "3 passed, 0 failed"}))
    run("第 4 步 跑完测试", 13, 140)

    # 第 5 步：一段很短的前缀，低于 512 门槛。
    short = Req(
        model=MODEL,
        tools=(),
        system=(Block(type="text", text="一句话总结上面做了什么。"),),
        messages=(),
    )
    steps.append(
        Step(
            "第 5 步 一次短请求",
            short,
            "anthropic",
            FakeEndpoint("anthropic", MODEL).send(short, 40),
            40,
        )
    )

    # 第 6 步：同样的活，走了兼容端点。
    run("第 6 步 走兼容端点", 13, 150, "anthropic-openai-compat")

    return steps


# ─────────────────────────────────────────────────────────────
# 审计
# ─────────────────────────────────────────────────────────────


@dataclass
class Row:
    label: str
    report: CacheReport
    divergence: Divergence | None
    paid: int


@dataclass
class Audit:
    rows: list[Row]
    paid: int
    # 完全不开缓存要付多少——**这是分母，不是「优化前」**。
    no_cache: int
    # 理论最优：前缀只写一次，之后全读。
    best: int
    # 能不能报出「省了多少」。有任何一步不可观测，答案就是不能。
    provable: bool
    reasons: list[str]


def audit(steps: list[Step], price: Price) -> Audit:
    """★ 注意 provable 这个字段，它是这个交付物和一个普通成本面板的全部区别。

    一步 UNDETERMINABLE 就足以让整段省钱结论作废。
    这不是过度谨慎：Anthropic 自己的 OpenAI 兼容层把 prompt_tokens_details
    恒置为空（官方原话 "Always empty"），也就是说在那条端点上，
    「缓存有没有生效」这个问题**在响应里没有答案**。
    此时报一个省钱比例，就是在编。
    """
    rows: list[Row] = []
    reasons: list[str] = []
    paid = 0
    no_cache = 0
    provable = True
    write_only_run = 0

    for i, s in enumerate(steps):
        prev = steps[i - 1] if i > 0 else None
        report = cache_verdict(s.shape, s.usage, s.req.model, prefix_tokens(s.req))

        # 未命中才需要归因。命中的时候 first_divergence 只会说「没变」，没有信息量。
        divergence = (
            first_divergence(prev.req, s.req)
            if report.verdict in ("MISS", "WRITE_ONLY") and prev is not None
            else None
        )

        miss = max(0, report.total_input - report.read_tokens - report.write_tokens)
        step_paid = (
            charge(miss, price.input_miss)
            + charge(report.read_tokens, price.input_miss, CACHE_READ)
            + charge(report.write_tokens, price.input_miss, CACHE_WRITE_5M)
            + charge(s.output_tokens, price.output)
        )

        paid += step_paid
        no_cache += charge(report.total_input, price.input_miss) + charge(
            s.output_tokens, price.output
        )
        rows.append(Row(s.label, report, divergence, step_paid))

        if report.verdict == "UNDETERMINABLE":
            provable = False
            reasons.append(f"{s.label}：端点不报缓存字段，这一步省了没省无法证明")

        # ★ 连续两次只写不读 = bug。一次是正常的冷启动。
        if report.verdict == "WRITE_ONLY":
            write_only_run += 1
            if write_only_run == 2:
                reasons.append(
                    "连续两次只写不读：断点后面挂着每次都变的内容。"
                    "这不是「缓存还没热」，是每次都在付 1.25 倍写入费而一次读都没拿到"
                )
        else:
            write_only_run = 0

        if divergence is not None and divergence.type != "previous_message_not_found":
            at = "" if divergence.at is None else f" @ {divergence.at}"
            reasons.append(
                f"{s.label}：{divergence.type}{at}，白付 {divergence.cache_missed_tokens} token"
            )

    # 理论最优：最大的那个前缀写一次，其余全命中。
    max_pfx = max(r.report.total_input for r in rows)
    best = charge(max_pfx, price.input_miss, CACHE_WRITE_5M)
    for i, r in enumerate(rows):
        if i > 0:
            best += charge(r.report.total_input, price.input_miss, CACHE_READ)
        best += charge(steps[i].output_tokens, price.output)

    return Audit(rows, paid, no_cache, best, provable, reasons)


# ─────────────────────────────────────────────────────────────
# 报告
# ─────────────────────────────────────────────────────────────


def dim(s: str) -> str:
    return f"\x1b[2m{s}\x1b[0m"


def bold(s: str) -> str:
    return f"\x1b[1m{s}\x1b[0m"


def red(s: str) -> str:
    return f"\x1b[31m{s}\x1b[0m"


def yellow(s: str) -> str:
    return f"\x1b[33m{s}\x1b[0m"


def green(s: str) -> str:
    return f"\x1b[32m{s}\x1b[0m"


def _w(s: str) -> int:
    n = 0
    for c in s:
        o = ord(c)
        wide = (0x2E80 <= o <= 0x9FFF) or (0xFF00 <= o <= 0xFFEF)
        n += 2 if wide else 1
    return n


def pad(s: str, n: int) -> str:
    return s + " " * max(0, n - _w(s))


def rpad(s: str, n: int) -> str:
    return " " * max(0, n - _w(s)) + s


COLOR: dict[str, Callable[[str], str]] = {
    "HIT": green,
    "MISS": yellow,
    "WRITE_ONLY": red,
    "BELOW_MINIMUM": dim,
    "UNDETERMINABLE": red,
}


def pct(part: int, whole: int) -> str:
    """百分比也走整数，理由见 budget.py 里的注释。"""
    if whole == 0:
        return "—"
    t = part * 1000 // whole
    return f"{t // 10}.{t % 10}%"


def main() -> int:
    steps = session(system_at)
    a = audit(steps, FLASH)

    print(bold("\n═══ L15 成本审计 ═══"))

    # ── 一
    print(bold("\n一、逐步判定（唯一的信号在 usage 里）\n"))
    print(
        dim(
            "  "
            + pad("步骤", 22)
            + pad("判定", 16)
            + rpad("命中", 7)
            + rpad("写入", 7)
            + rpad("总输入", 8)
            + rpad("元", 11)
        )
    )
    print(dim("  " + "─" * 70))
    for r in a.rows:
        c = COLOR.get(r.report.verdict, lambda s: s)
        print(
            "  "
            + pad(r.label, 22)
            + c(pad(r.report.verdict, 16))
            + rpad(str(r.report.read_tokens), 7)
            + rpad(str(r.report.write_tokens), 7)
            + rpad(str(r.report.total_input), 8)
            + rpad(yuan(r.paid), 11)
        )

    # ── 二
    print(bold("\n二、未命中归因（「你的 bug」和「过期了」要分开）\n"))
    n = 0
    for r in a.rows:
        if r.divergence is None:
            continue
        n += 1
        print(
            f"  {pad(r.label, 22)}{yellow(pad(r.divergence.type, 18))}"
            + dim(f"白付 {r.divergence.cache_missed_tokens} token")
        )
    if n == 0:
        print(dim("  （没有需要归因的步骤）"))
    print(
        dim(
            "\n  ★ *_changed 是「你的代码变了」——改代码。\n"
            "    unavailable 是「缓存过期了」——改 TTL 或改请求节奏。\n"
            "    把这两类混成一句「缓存命中率低」，是缓存调优最常见的浪费时间方式。"
        )
    )
    # ★★ 这一段是整份报告里最该读两遍的地方。
    # 要的是「既只写不读、又能归因」的那一步。第一步也是只写不读，
    # 但它没有上一次可比，所以归因是空的——拿它举例讲不通。
    worst = next(
        (r for r in a.rows if r.report.verdict == "WRITE_ONLY" and r.divergence is not None), None
    )
    if worst is not None and worst.divergence is not None:
        print(
            "\n  "
            + yellow("注意这两个数对不上：")
            + dim(
                f"分歧只有 {worst.divergence.cache_missed_tokens} token，\n  "
                f"但第一节里那一步的写入是 {worst.report.write_tokens} token，而且读到 0。\n"
                "\n  "
                "这不是 bug，这是 lookback 的真实语义。分歧点之前的内容**逐字节相同**，\n  "
                "但系统不会因此命中——官方原话：「It is looking for prior writes, not for\n  "
                "stable content.」写入只发生在断点上，而断点在那个会变的块上，\n  "
                "所以更早的位置从来没有被写过，往回找也找不到东西。\n"
                "\n  "
                "也就是说：**「分歧很小」不等于「损失很小」。** "
                f"这里每次请求都在全额重写 {worst.report.write_tokens} token，\n  "
                "按 1.25 倍计费，一次读都没拿到。这就是第三节里实付超过 100% 的来源。"
            )
        )

    # ── 三
    print(bold("\n三、账\n"))
    print(f"  {pad('完全不开缓存', 18)}{rpad(yuan(a.no_cache), 12)} 元   {dim('← 这才是分母')}")
    print(
        f"  {pad('实际付了', 18)}{rpad(yuan(a.paid), 12)} 元   "
        f"{dim(f'= 不开缓存的 {pct(a.paid, a.no_cache)}')}"
    )
    print(
        f"  {pad('理论最优', 18)}{rpad(yuan(a.best), 12)} 元   "
        f"{dim(f'= 不开缓存的 {pct(a.best, a.no_cache)}')}"
    )

    if a.provable:
        print(f"\n  省下 {bold(pct(a.no_cache - a.paid, a.no_cache))}")
    else:
        print(
            "\n  "
            + red("拒绝报出省钱比例。")
            + "\n  "
            + dim(
                "有步骤走的端点不返回缓存字段，这段账里有一部分不可观测。\n  "
                "把不可观测当成「没命中」会给你一个偏悲观但看起来精确的数字，\n  "
                "当成「命中」则偏乐观。两种都是编。所以这里什么都不报。"
            )
        )

    # ── 对照实验：唯一的区别是断点位置
    fixed = audit(session(system_fixed), FLASH)
    print(bold("\n  对照实验：把断点从时间戳挪到稳定内容上\n"))
    print(dim("  " + pad("断点位置", 26) + rpad("实付", 12) + rpad("占不开缓存", 12)))
    print(
        f"  {pad('在时间戳上（当前）', 26)}{rpad(yuan(a.paid), 12)}"
        f"{rpad(pct(a.paid, a.no_cache), 12)}"
    )
    print(
        f"  {pad('在稳定内容上', 26)}{rpad(yuan(fixed.paid), 12)}"
        f"{rpad(pct(fixed.paid, fixed.no_cache), 12)}"
    )
    print(
        dim(
            "\n  ★ 两次会话的内容一模一样，请求数一样，token 数一样。\n"
            "    唯一的区别是 cache_control 挂在哪一个块上。"
        )
    )

    # ── 四
    print(bold("\n四、路由：同一批任务，四种路由器 × 两种决策粒度\n"))
    # ★ 难度用 LCG 生成，不用 i % 2。
    # 严格交替的难度序列会制造一个假结论：只要 sticky_every 是 2 的倍数，
    # 每个块的第一个任务就恒定是 easy，于是「按会话粒度」永远选便宜模型——
    # 看起来很省，但那是 fixture 的周期性造成的，不是路由策略的性质。
    # 这类「测试数据的周期和参数共振」的 bug，在性能实验里非常常见且极难发现。
    tg = Lcg(99)
    tasks = [
        Task(
            id=f"t{i}",
            true_difficulty="hard" if tg.int(2) == 1 else "easy",
            input_tokens=1000,
            output_tokens=200,
        )
        for i in range(100)
    ]
    hard_n = sum(1 for t in tasks if t.true_difficulty == "hard")
    weak = ModelSpec("flash", FLASH)
    strong = ModelSpec("pro", PRO)
    routers: list[tuple[str, Router]] = [
        ("完美路由", Router(Mult(1, 1), Mult(0, 1))),
        ("随机（基线）", Router(Mult(1, 2), Mult(1, 2))),
        ("反着判", Router(Mult(0, 1), Mult(1, 1))),
        ("全用便宜的", Router(Mult(0, 1), Mult(0, 1))),
    ]

    print(
        dim(
            f"  {len(tasks)} 个任务，其中 {hard_n} 个真的难；"
            "每个任务 1000 token 输入 / 200 token 输出。\n"
        )
    )
    for pfx in (0, 8000):
        base = all_strong(tasks, strong, pfx)
        tail = (
            "（不算缓存——大多数「路由省 N 倍」的文章算的就是这个账）"
            if pfx == 0
            else "（把缓存算进来。基线全程不换模型，所以它的缓存是最优的）"
        )
        print(dim(f"  共享前缀 {pfx} token{tail}"))
        print(
            dim(
                "  "
                + pad("路由器", 22)
                + rpad("花费", 11)
                + rpad("占全强", 9)
                + rpad("重试", 6)
                + rpad("前缀命中", 10)
                + rpad("打断", 6)
            )
        )

        def row(name: str, o: Any, base: int = base) -> None:
            p = pct(o.picofen, base)
            cell = red(rpad(p, 9)) if o.picofen > base else green(rpad(p, 9))
            print(
                "  "
                + pad(name, 22)
                + rpad(yuan(o.picofen), 11)
                + cell
                + rpad(str(o.retries), 6)
                + rpad(str(o.prefix_reads), 10)
                + rpad(str(o.cache_breaks), 6)
            )

        for name, r in routers:
            row(f"{name}（每请求）", route_outcome(tasks, r, weak, strong, Lcg(1), pfx))
        print(dim("  " + "·" * 32 + " 同一批路由器，只改决策粒度 " + "·" * 4))
        for name, r in routers:
            row(f"{name}（每 10 个）", route_outcome(tasks, r, weak, strong, Lcg(1), pfx, 10))
        print(
            dim(
                f"  {pad('全用强模型（基线）', 22)}{rpad(yuan(base), 11)}{rpad('100.0%', 9)}"
                f"{rpad('0', 6)}{rpad(str(len(tasks) - 1), 10)}{rpad('0', 6)}"
            )
        )
        print("")

    print(
        dim(
            "  ★ 上面两张表该怎么读：\n"
            "\n"
            "    没有共享前缀时（第一张表），路由的账基本符合直觉：路由器越准越省，\n"
            "    「反着判」比全用强模型还贵——一个路由器可以是**负价值**的。\n"
            "    另外注意「全用便宜的」比「随机路由」更省：路由器不比随机强，就不如不路由。\n"
            "\n"
            "    有 8000 token 共享前缀时（第二张表），**四种路由器全部输给基线**，\n"
            "    而且不是输一点。原因不在路由决策的质量上——前缀是任务本身的 8 倍，\n"
            "    而基线全程不换模型，它的前缀写一次读九十九次；任何切模型的策略\n"
            "    每切一次就重写一遍整段前缀。这笔钱盖过了单价差。\n"
            "\n"
            "    决策粒度从「每请求」改到「每 10 个请求」确实明显有效（看打断和前缀命中\n"
            "    这两列），但它**没有**把差距补平。而在第一张表里，同样的改动让账变差了——\n"
            "    粘性路由是拿准确率换缓存命中，没有前缀可缓存的时候，这笔交易是纯亏。\n"
            "\n"
            "    所以结论不是「路由能省 N 倍」，也不是「路由没用」，而是：\n"
            "    **先量一下前缀和任务的比例，再决定要不要路由、在什么粒度上路由。**\n"
            "    这个比例是你自己系统的数，不是文章里的数。"
        )
    )

    # ── 结论
    print(bold("\n═══ 结论 ═══\n"))
    for r in a.reasons:
        print(f"  {red('·')} {r}")
    fail = len(a.reasons) > 0
    print(
        red(f"\n  {len(a.reasons)} 个问题。退出码 1。\n")
        if fail
        else green("\n  没有发现问题。\n")
    )
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
