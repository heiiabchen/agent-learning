r"""L19x · TS agent 生态：框架替你写了哪一段、哪些默认值会咬人、你的不变量接在哪。l19x/ecosystem.ts 的 Python 镜像。

    cd labs && uv run python -m l19x.ecosystem                  # 九个观察实验
    cd labs && uv run python -m l19x.verify                     # 测你的六个适配器
    cd labs && ECO19_IMPL=shared uv run python -m l19x.verify   # 测参考实现

★ 这个 lab 不装任何框架。框架的行为来自 fixtures/ecosystem.json——调研在锁定版本上实测录下来的结果
  （ai@7.0.137、@mastra/core@1.76.0、@anthropic-ai/claude-agent-sdk@0.3.296、@openai/agents-core@0.20.0）。
  版本号就是这些结论的有效期：升级之后，第一件事是重新录一遍。两种语言读同一份文件。

你要写的是六个**适配器**：把 L05–L19 手写过的不变量，接到框架开放的扩展点上
（stopWhen、execute 包装 / errorFunction、审批恢复、MCP 结果转换、历史重建），外加把一份 Dify DSL 读成代码计划。
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

from shared.tsecosystem import (
    DEFAULT_HINT,
    DIFY_NAMESPACES,
    DIFY_READER_VERSION,
    DIFY_UI_FIELDS,
    ERROR_HINTS,
    ERROR_PREFIX,
    MAX_ERROR_MESSAGE,
    NEXT_STEP,
    BackfillRule,
    DifyPlan,
    DifyStep,
    Json,
    Kv,
    LoggedResult,
    LoopDefault,
    McpResult,
    McpText,
    ModelToolResult,
    PlatformNeeds,
    Rebuilt,
    ResumeOutcome,
    Step,
    StopOpts,
    StopReason,
    ToolCall,
    ToolCtx,
    ToolErr,
    UiToolPart,
    ai_sdk_is_step_count,
    ai_sdk_mcp_wire,
    ascii_lower,
    audit_backfill,
    call_signature,
    canonical_json,
    choose_platform,
    course_mcp_wire,
    course_stop_reason,
    course_tool_error,
    deepseek_sees,
    dify_needs,
    dify_plan,
    error_code,
    fmt_usd,
    framework_backfill,
    hint_for,
    rebuild_history,
    resume_once,
    run_state_resume,
    simulate_default_loop,
    ui_round_trip,
)

DIM, BOLD, OFF = "\x1b[2m", "\x1b[1m", "\x1b[0m"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_WIDE = re.compile(r"[\u2e80-\u9fff\uff00-\uffef]")


def dim(s: str) -> str:
    return f"{DIM}{s}{OFF}"


def bold(s: str) -> str:
    return f"{BOLD}{s}{OFF}"


def _visible(s: str) -> str:
    return _ANSI.sub("", s)


def w(s: str) -> int:
    n = 0
    for c in _visible(s):
        n += 2 if _WIDE.match(c) else 1
    return n


def pad(s: str | int, n: int) -> str:
    t = str(s)
    return t + " " * max(0, n - w(t))


def J(x: Any) -> str:
    return json.dumps(x, ensure_ascii=False, separators=(",", ":"))


def one_line(s: str) -> str:
    """多行文本压成一行显示。"""
    return " ⏎ ".join(s.split("\n"))


# ─────────────────────────────────────────────────────────────
# 夹具
# ─────────────────────────────────────────────────────────────


class ToolErrFx(ToolErr):
    tool: str


@dataclass(frozen=True)
class McpCase:
    label: str
    result: McpResult


@dataclass(frozen=True)
class UiFx:
    model_saw: str
    tool_call_id: str


@dataclass(frozen=True)
class HistoryFx:
    log: list[LoggedResult]
    ui: list[UiToolPart]


@dataclass(frozen=True)
class RunStateFx:
    bytes: int
    measured_effects: list[int]
    evidence: str


@dataclass(frozen=True)
class ThinkingFx:
    path: str
    signature: bool
    outcome: str
    silent: bool


@dataclass(frozen=True)
class DefaultFx:
    inv: str
    what: str
    default: str
    fix: str
    evidence: str


@dataclass(frozen=True)
class SessionFx:
    run: str
    session_id: str
    messages: int
    cost_micro_usd: int


@dataclass(frozen=True)
class ClaudeAgentSdkFx:
    permission_mode: str
    main_model: str
    classifier_model: str
    classifier_per_main_request: int
    classifier_max_tokens: str
    classifier_system_start: str
    auto_denial: str
    default_system_prompt: list[str]
    sessions: list[SessionFx]
    cost_excludes: str


@dataclass(frozen=True)
class Fixtures:
    versions: list[tuple[str, str]]
    loops: list[LoopDefault]
    tool_error: ToolErrFx
    backfills: list[BackfillRule]
    mcp_cases: list[McpCase]
    ui: UiFx
    history: HistoryFx
    run_state: RunStateFx
    thinking: list[ThinkingFx]
    defaults: list[DefaultFx]
    claude_agent_sdk: ClaudeAgentSdkFx
    dify: Json


_FX_TEXT = (Path(__file__).parent / "fixtures" / "ecosystem.json").read_text(encoding="utf-8")


def fx() -> Fixtures:
    """每次返回一份新的拷贝。TS 那边 JSON.parse 之后直接当类型用，这里显式转成 dataclass。"""
    d = json.loads(_FX_TEXT)
    c = d["claudeAgentSdk"]
    return Fixtures(
        versions=[(p, v) for p, v in d["versions"]],
        loops=[
            LoopDefault(
                id=x["id"],
                default_limit=x["defaultLimit"],
                on_limit=x["onLimit"],
                signal=x["signal"],
                evidence=x["evidence"],
            )
            for x in d["loops"]
        ],
        tool_error=d["toolError"],
        backfills=[
            BackfillRule(
                framework=x["framework"],
                rule=x["rule"],
                is_error=x["isError"],
                evidence=x["evidence"],
            )
            for x in d["backfills"]
        ],
        mcp_cases=[McpCase(label=x["label"], result=x["result"]) for x in d["mcpCases"]],
        ui=UiFx(model_saw=d["ui"]["modelSaw"], tool_call_id=d["ui"]["toolCallId"]),
        history=HistoryFx(
            log=[
                LoggedResult(tool_call_id=x["toolCallId"], kind=x["kind"], text=x["text"])
                for x in d["history"]["log"]
            ],
            ui=[
                UiToolPart(tool_call_id=x["toolCallId"], state=x["state"], text=x["text"])
                for x in d["history"]["ui"]
            ],
        ),
        run_state=RunStateFx(
            bytes=d["runState"]["bytes"],
            measured_effects=d["runState"]["measuredEffects"],
            evidence=d["runState"]["evidence"],
        ),
        thinking=[
            ThinkingFx(
                path=x["path"], signature=x["signature"], outcome=x["outcome"], silent=x["silent"]
            )
            for x in d["thinking"]
        ],
        defaults=[
            DefaultFx(
                inv=x["inv"],
                what=x["what"],
                default=x["default"],
                fix=x["fix"],
                evidence=x["evidence"],
            )
            for x in d["defaults"]
        ],
        claude_agent_sdk=ClaudeAgentSdkFx(
            permission_mode=c["permissionMode"],
            main_model=c["mainModel"],
            classifier_model=c["classifierModel"],
            classifier_per_main_request=c["classifierPerMainRequest"],
            classifier_max_tokens=c["classifierMaxTokens"],
            classifier_system_start=c["classifierSystemStart"],
            auto_denial=c["autoDenial"],
            default_system_prompt=c["defaultSystemPrompt"],
            sessions=[
                SessionFx(
                    run=s["run"],
                    session_id=s["sessionId"],
                    messages=s["messages"],
                    cost_micro_usd=s["costMicroUsd"],
                )
                for s in c["sessions"]
            ],
            cost_excludes=c["costExcludes"],
        ),
        dify=d["dify"],
    )


def failing_steps(n: int, vary_args: bool = False) -> list[Step]:
    """同一个工具、同一个参数，连续失败 n 步。"""
    return [
        Step(
            tool_calls=[
                ToolCall(name="read_file", args={"path": f"nope{i}" if vary_args else "nope"})
            ],
            finish_reason="tool-calls",
        )
        for i in range(n)
    ]


def first_stop(
    steps: list[Step], reason_of: Callable[[list[Step]], StopReason | bool]
) -> tuple[int, str]:
    """逐步喂给停止条件，返回第一次停下的步数（1 起）和原因；一直没停返回 (0, 'running')。"""
    for k in range(1, len(steps) + 1):
        r = reason_of(steps[:k])
        if r != "running" and r is not False:
            return (k, "stop" if r is True else cast(str, r))
    return (0, "running")


SCENARIOS: list[tuple[str, PlatformNeeds]] = [
    (
        "内部运营：查库存、出日报",
        PlatformNeeds(
            fixed_flow=True,
            read_only_tools=True,
            internal_users=True,
            eval_gate=False,
            per_tenant_billing=False,
            write_approval=False,
            ci=False,
            multi_tenant_saas=False,
            paid_embedding=False,
        ),
    ),
    (
        "对外客服：按客户计费、能退款",
        PlatformNeeds(
            fixed_flow=True,
            read_only_tools=False,
            internal_users=False,
            eval_gate=True,
            per_tenant_billing=True,
            write_approval=True,
            ci=False,
            multi_tenant_saas=True,
            paid_embedding=False,
        ),
    ),
    (
        "coding agent 进 CI",
        PlatformNeeds(
            fixed_flow=False,
            read_only_tools=False,
            internal_users=True,
            eval_gate=True,
            per_tenant_billing=False,
            write_approval=True,
            ci=True,
            multi_tenant_saas=False,
            paid_embedding=False,
        ),
    ),
    (
        "把 n8n 流程打包卖给客户",
        PlatformNeeds(
            fixed_flow=True,
            read_only_tools=True,
            internal_users=False,
            eval_gate=False,
            per_tenant_billing=False,
            write_approval=False,
            ci=False,
            multi_tenant_saas=False,
            paid_embedding=True,
        ),
    ),
]

# ─────────────────────────────────────────────────────────────
# 实验
# ─────────────────────────────────────────────────────────────


def exp1() -> None:
    f = fx()
    print(bold("\n实验一 · 同一个「永远失败」的工具，七个入口的默认值"))
    print(
        dim(
            f"  {pad('入口', 26)}{pad('默认上限', 10)}{pad('模型/工具', 11)}{pad('证据', 12)}结束方式"
        )
    )
    for d in f.loops:
        o = simulate_default_loop(d, 50)
        limit = "无" if d.default_limit is None else d.default_limit
        print(
            f"  {pad(d.id, 26)}{pad(limit, 10)}{pad(f'{o.model_calls}/{o.tool_runs}', 11)}{pad(d.evidence, 12)}{o.ending}"
        )
    opts = StopOpts(max_steps=8, max_repeat=3)
    same = first_stop(failing_steps(20), lambda s: course_stop_reason(s, opts))
    vary = first_stop(failing_steps(20, True), lambda s: course_stop_reason(s, opts))
    print(
        f"\n  课程的停止条件（maxSteps 8，maxRepeat 3），喂同一段 20 步的历史：第 {same[0]} 步停，reason={same[1]}"
    )
    print(f"  每步换一个 path：第 {vary[0]} 步停，reason={vary[1]}")
    zero = first_stop(failing_steps(20), ai_sdk_is_step_count(0))
    zero_c = first_stop(
        failing_steps(20), lambda s: course_stop_reason(s, StopOpts(max_steps=0, max_repeat=0))
    )
    fired = "一次都没触发" if zero[0] == 0 else f"第 {zero[0]} 步触发"
    print(
        f"  isStepCount(0)：20 步里{fired}；课程 maxSteps 0：第 {zero_c[0]} 步停，reason={zero_c[1]}"
    )
    print(
        dim(
            "  框架只给最后一步的 finishReason：撞上限、停在审批、调了没有 execute 的工具，三种都是 tool-calls。\n"
            "  Claude Agent SDK 的 result.subtype 有显式原因，但 maxTurns 没有默认值；E5-A 里分类器拒绝 + 「原样重试」把它变成了死循环。"
        )
    )


def exp2() -> None:
    f = fx()
    e = f.tool_error
    print(bold("\n实验二 · 同一个异常，四家框架回填给模型的文本"))
    print(dim(f"  工具 {e['tool']} 抛出 {{ name: {J(e['name'])}, message: {J(e['message'])} }}"))
    print(dim(f"  {pad('框架', 18)}{pad('is_error', 10)}{pad('证据', 13)}回填文本"))
    for r in f.backfills:
        text = framework_backfill(r, e)
        a = audit_backfill(text, e["tool"])
        print(f"  {pad(r.framework, 18)}{pad(r.is_error, 10)}{pad(r.evidence, 13)}{J(text)}")
        print(dim(f"  {pad('', 41)}体检：{'合格' if len(a) == 0 else ' '.join(a)}"))
    mine = course_tool_error(e, {"tool": e["tool"]})
    a = audit_backfill(mine, e["tool"])
    print(f"  {pad('课程适配器', 18)}{pad('true', 10)}{pad('—', 13)}{J(one_line(mine))}")
    print(dim(f"  {pad('', 41)}体检：{'合格' if len(a) == 0 else ' '.join(a)}"))
    print(
        dim(
            "  三家把带 key 的原始异常塞进上下文，一家把信息全抹掉还叫模型再试一次。DeepSeek 的 Anthropic 端点忽略 is_error，\n"
            "  所以「这是失败」「下一步做什么」都只能写在文本里。"
        )
    )


def _is_err(b: Json) -> str:
    return "is_error" if isinstance(b, dict) and b.get("is_error") is True else "无 is_error"


def exp3() -> None:
    print(bold("\n实验三 · MCP 的 isError：AI SDK 的路径上丢了，DeepSeek 上本来就不算数"))
    for c in fx().mcp_cases:
        wire = ai_sdk_mcp_wire(c.result, "tu1")
        mine = course_mcp_wire(c.result, "tu1")
        print(f"  {bold(c.label)}")
        print(
            f"    {pad('AI SDK 线上块', 16)}{pad(_is_err(wire), 12)}模型看到 {J(deepseek_sees(wire))}"
        )
        print(
            f"    {pad('课程适配器', 16)}{pad(_is_err(mine), 12)}模型看到 {J(deepseek_sees(mine))}"
        )
    print(
        dim(
            "  @ai-sdk/mcp 把 isError 的结果原样当成功返回；tracing 里这次调用也记为成功，L13 的错误率被系统性低估。\n"
            "  线上块有没有 is_error，DeepSeek 都只看文本：失败的信号只能放在 [tool error] 这个前缀里。"
        )
    )


def exp4() -> None:
    f = fx()
    print(bold("\n实验四 · UI 遮罩：同一个 tool_result，第 N 轮和第 N+1 轮"))
    d = ui_round_trip(f.ui.model_saw)
    print(f"  {pad('第 N 轮模型看到', 22)}{J(d.turn_n)}")
    print(f"  {pad('UI 消息的 errorText', 22)}{J(d.ui)}")
    print(
        f"  {pad('第 N+1 轮模型看到', 22)}{J(d.turn_n1)}{'' if d.turn_n == d.turn_n1 else '   ← 历史被改写了'}"
    )
    kept = ui_round_trip(f.ui.model_saw, lambda s: s)
    print(
        f"  {pad('传 onError: s => s', 22)}第 N+1 轮 {J(kept.turn_n1)}{'（不变）' if kept.turn_n == kept.turn_n1 else ''}"
    )
    print(dim("\n  下一轮以服务端日志为准，客户端发来的 UI 消息只用来对账："))
    r: Rebuilt = rebuild_history(f.history.ui, f.history.log)
    for h in r.history:
        print(f"    {pad(h.tool_call_id, 4)}{pad(h.type, 12)}{J(one_line(h.value))}")
    print(f"    drifted={J(r.drifted)}  forged={J(r.forged)}  dropped={J(r.dropped)}")
    print(
        dim(
            "  同一个位置的 tool_result 内容变了，前缀缓存从这里往后全部失效；出路也在下一轮丢了。\n"
            "  forged 那一条是客户端造出来的工具结果——useChat 标准模式下审批记录同样走这条路（INV-24）。"
        )
    )


def exp5() -> None:
    f = fx()
    print(bold("\n实验五 · 同一份 RunState 恢复两次"))
    effects = 0

    def bump() -> None:
        nonlocal effects
        effects += 1

    counts = run_state_resume(2, bump)
    print(
        f"  RunState.fromString → approve → run，重放两次：工具累计执行 {J(counts)}（{f.run_state.evidence}：{J(f.run_state.measured_effects)}，状态 {f.run_state.bytes} 字节）"
    )
    store: Kv = {}
    effects = 0

    def charge() -> str:
        nonlocal effects
        effects += 1
        return f"charged#{effects}"

    def killed() -> str:
        nonlocal effects
        effects += 1
        raise RuntimeError("worker killed after POST /refund")

    steps: list[tuple[str, str, Literal["approve", "reject"], Callable[[], str]]] = [
        ("审批通过，worker 恢复", "a1", "approve", charge),
        ("worker 崩溃后重放同一条审批", "a1", "approve", charge),
        ("另一个人随后点了「拒绝」", "a1", "reject", charge),
        ("a2 恢复时进程被杀", "a2", "approve", killed),
        ("a2 被重新投递", "a2", "approve", charge),
    ]
    print(dim(f"  {pad('事件', 30)}{pad('审批', 6)}{pad('结果', 28)}{pad('副作用累计', 12)}store"))
    for label, id_, dec, fn in steps:
        o: ResumeOutcome = resume_once(store, id_, dec, fn)
        shown = o.result[:10] + "…" if len(o.result) > 10 else o.result
        res = o.status if o.result == "" else f"{o.status}:{shown}"
        print(
            f"  {pad(label, 30)}{pad(id_, 6)}{pad(res, 28)}{pad(effects, 12)}{J(store.get(f'approval:{id_}'))}"
        )
    print(
        dim(
            "  框架把「恢复」当成纯函数。in-flight 的那一条不重跑：进程是在副作用之后死的还是之前死的，只有对账才知道（L19）。\n"
            "  四家框架在「L08 幂等键」这一行全部为空——这是手写不可替代的最强证据。"
        )
    )


def exp6() -> None:
    f = fx()
    print(bold("\n实验六 · 还有八处会咬人的默认值"))
    for d in f.defaults:
        print(f"  {pad(d.inv, 8)}{pad(d.what, 38)}{d.default}")
        print(dim(f"  {pad('', 8)}{pad('', 38)}→ {d.fix}  [{d.evidence}]"))
    print(dim("\n  thinking 签名（@ai-sdk/anthropic，E4 实测）："))
    for t in f.thinking:
        print(
            f"    {pad(t.path, 8)}{pad('有签名' if t.signature else '无签名', 8)}{t.outcome}{'   ← 静默' if t.silent else ''}"
        )
    print(
        dim(
            "  同一个问题，两条路径行为相反：非流式直接报错，流式悄悄丢掉。DeepSeek 带工具时漏传 reasoning 会 400（OpenAI 格式的原文）。"
        )
    )


def exp7() -> None:
    c = fx().claude_agent_sdk
    print(bold("\n实验七 · 跑一个 Claude Code 二进制意味着什么（读 E5 夹具，不装）"))
    print(
        f"  不传 permissionMode → {c.permission_mode}：每次主循环请求后跟着 {c.classifier_per_main_request} 次分类器请求（max_tokens {c.classifier_max_tokens}）"
    )
    print(
        f"  分类器的 model={c.classifier_model}，不是你设的 {c.main_model}；它的花费不进 total_cost_usd"
    )
    print(f"  分类器的 system 开头：{J(c.classifier_system_start)}")
    print("  分类器答不上来时回填给主模型：")
    print(f"    {J(c.auto_denial)}")
    print(dim(f"    体检：{' '.join(audit_backfill(c.auto_denial, 'mcp__lab__boom'))}"))
    print(dim(f"\n  {pad('运行', 28)}{pad('session_id', 14)}{pad('messages', 10)}total_cost_usd"))
    for s in c.sessions:
        print(
            f"  {pad(s.run, 28)}{pad(s.session_id, 14)}{pad(s.messages, 10)}{fmt_usd(s.cost_micro_usd)}"
        )
    b = c.sessions[1]
    fork = c.sessions[2]
    print(
        f"  fork 的成本从父会话的累计值接着算：{fmt_usd(fork.cost_micro_usd)} 包含了 {fmt_usd(b.cost_micro_usd)}——按会话汇总会重复计算"
    )
    print(f"  成本里不含什么：{J(c.cost_excludes)}")
    print("  默认 system prompt（不是 Claude Code 的完整 prompt）：")
    for p in c.default_system_prompt:
        print(f"    {J(p)}")
    print(
        dim(
            "  默认无轮数上限 + 默认 auto 分类器（写死 Claude 模型名，接 DeepSeek 时按前缀映射到 deepseek-flash）+ 失败即拒且叫你原样重试\n"
            "  = 一个默认配置下的死循环。「能连上 DeepSeek」不等于「行为一致」。"
        )
    )


def exp8() -> None:
    print(bold("\n实验八 · 把一份 Dify DSL 读成代码计划"))
    p: DifyPlan = dify_plan(fx().dify)
    print(f"  version={p.version}  kind={p.kind}  丢掉的画布字段：{p.ui_fields_dropped} 个")
    print(f"  执行顺序：{' → '.join(p.order)}")
    print(f"  分支：{'  '.join(p.branches)}")
    print(dim(f"  {pad('节点', 10)}{pad('类型', 22)}{pad('标题', 12)}改写成代码时要补的"))
    for s in p.steps:
        print(
            f"  {pad(s.id, 10)}{pad(s.type, 22)}{pad(s.title, 12)}{'—' if len(s.needs) == 0 else ' '.join(s.needs)}"
        )
    print(f"  数据流：{'  '.join(p.refs)}")
    print(f"  问题：{'（无）' if len(p.errors) == 0 else '  '.join(p.errors)}")
    print(
        dim(
            "  ticket 在 false 分支上，却引用了 true 分支里 llm 的输出：拓扑序在前不等于是上游，运行时这里是空值。\n"
            "  DSL 不带知识库内容，dataset_ids 用原租户加密，工具凭据导出时被删——导到另一套环境，这三处都是断的。"
        )
    )


def exp9() -> None:
    print(bold("\n实验九 · 平台、框架、手写"))
    for label, n in SCENARIOS:
        r = choose_platform(n)
        print(f"  {pad(label, 32)}{r.pick}")
        lic = f"；许可：{'；'.join(r.license)}" if len(r.license) > 0 else ""
        print(dim(f"  {pad('', 32)}因为：{'、'.join(r.why)}{lic}"))
    print(
        dim(
            "  arXiv 2609.00006 检查的框架清单里没有 AI SDK、Mastra 和两家 harness SDK，并把 AI SDK 归为 provider-abstraction layer。\n"
            "  它能证明的是「生产 coding harness 的循环都是手写的」，不是「别用 AI SDK」：拿 provider 层，拒绝编排层的默认值。"
        )
    )


# ─────────────────────────────────────────────────────────────
# TODO
# ─────────────────────────────────────────────────────────────


def my_course_stop_reason(steps: list[Step], o: StopOpts) -> StopReason:
    """TODO 1 ★ 停止原因（I-STOP，接在 AI SDK 的 stopWhen 上）。规则和优先级见 shared 的 course_stop_reason 注释：
      running / approval / truncated / error / done / repeat / max_steps。
    零件：call_signature（参数先规范化，{a,b} 和 {b,a} 是同一个调用）在 shared 里。
    注意 max_steps 用 ≥：max_steps 写成 0 也必须停，不能像 ai_sdk_is_step_count(0) 那样永远不触发。
    approval_requested 是 None / False / True 三态：只有 is True 才算要审批。
    """
    raise NotImplementedError("TODO 1 未实现")


def my_redact_secrets(s: str) -> str:
    r"""TODO 2 ★★ 错误出口（I-ERR，AI SDK 的 execute 包装和 Agents SDK 的 errorFunction 共用）。两个函数：
      my_redact_secrets：sk- key（前面不能紧挨字母或数字）、secret= / token= / password= / api_key= 的值、Bearer token，
        各自替换成 sk-*** / 键=*** / Bearer ***。再跑一遍结果不变。
      my_course_tool_error：`[tool error] 工具名: 消息\n下一步：提示`。消息先把 \r \n 换成空格，再脱敏，再按码点截到 200 加 …；
        e 不是带字符串 message 的 dict 时：字符串就用它本身，异常用 str(e)，其余用 '（没有错误信息）'；提示按 error_code 查 ERROR_HINTS。
    零件：error_code、hint_for、ERROR_PREFIX、NEXT_STEP、MAX_ERROR_MESSAGE 在 shared 里。
    """
    raise NotImplementedError("TODO 2 未实现")


def my_course_tool_error(e: Any, ctx: ToolCtx) -> str:
    raise NotImplementedError("TODO 2 未实现")


def my_resume_once(
    store: Kv,
    approval_id: str,
    decision: Literal["approve", "reject"],
    resume: Callable[[], str],
) -> ResumeOutcome:
    """TODO 3 ★ 审批恢复只消费一次（I-IDEM）。键 f'approval:{approval_id}'，值 'in-flight' 或 f'done:{decision}:{result}'。
    状态：ran / already-consumed / conflict / in-flight / crashed，规则见 shared 的 resume_once 注释。
    resume() 抛异常时记录**留在 in-flight**，返回 crashed 和 str(异常)。
    """
    raise NotImplementedError("TODO 3 未实现")


def my_mcp_result_to_text(r: McpResult) -> McpText:
    """TODO 4 ★ MCP CallToolResult → 模型能读懂的文本（I-ERR × L10）。
    isError 只有缺省、None、False 算成功；每种 content 的写法、空结果、structuredContent 见 shared 的 mcp_result_to_text 注释。
    ★ Python 里 0 == False、{} 是假值：isError 用 is 判，不用 == 或真值。
    失败时 '[tool error] ' + 脱敏后的正文（用你的 my_redact_secrets）。
    """
    raise NotImplementedError("TODO 4 未实现")


def my_rebuild_history(ui: list[UiToolPart], log: list[LoggedResult]) -> Rebuilt:
    """TODO 5 ★ 以服务端日志为准重建下一轮的工具结果历史（I-HIST）。
    history 按日志顺序；drifted / forged / dropped 的定义和顺序见 shared 的 rebuild_history 注释。
    """
    raise NotImplementedError("TODO 5 未实现")


def my_dify_plan(dsl: Any) -> DifyPlan:
    """TODO 6 ★★ 把 Dify DSL 读成代码计划。七步、每种错误的写法见 shared 的 dify_plan 注释——
    verify 逐项比对 version、kind、ui_fields_dropped、order、steps（含 needs）、branches、refs、errors。
    零件：DIFY_UI_FIELDS、DIFY_NAMESPACES、DIFY_READER_VERSION、dify_needs 在 shared 里。
    """
    raise NotImplementedError("TODO 6 未实现")


# ─────────────────────────────────────────────────────────────


def main() -> None:
    print(dim(f"\n  录制口径：{'  '.join(f'{p}@{v}' for p, v in fx().versions)}"))
    exp1()
    exp2()
    exp3()
    exp4()
    exp5()
    exp6()
    exp7()
    exp8()
    exp9()
    print(
        dim(
            "\n  框架真正省下的是 provider 适配、流协议编解码、schema 校验、会话序列化；终止、错误回填、幂等、tracing、审批这五处，\n"
            "  没有一家的默认值满足课程的不变量。写完六个适配器跑 pnpm verify:l19x。\n"
        )
    )


if __name__ == "__main__":
    main()
