r"""L19x 的参考实现：TS 框架的默认值（录制版）+ 把课程不变量接到框架扩展点上的六个适配器。shared/tsecosystem.ts 的 Python 镜像。

两层：
  一到五节的「框架模型」：每个函数复现一处在锁定版本上**实测过**的默认行为，数字和原文来自
  l19x/fixtures/ecosystem.json（调研 §9 的录制结果）。这一层不装任何框架，所以两种语言能逐字节一致；
  代价是它证明不了「框架现在还是这样」——版本号就是它的有效期，升级之后要重新录。
  六个适配器（TODO 1–6 的参考实现）：停止原因、错误回填、审批恢复只消费一次、MCP isError、
  以服务端为准重建历史、把 Dify DSL 读成代码计划。纯函数，零 I/O、零模型。

口径：ai@7.0.137、@ai-sdk/anthropic@4.0.78、@ai-sdk/mcp@2.0.73、@mastra/core@1.76.0、
@anthropic-ai/claude-agent-sdk@0.3.296、@openai/agents-core@0.20.0；Dify DSL 0.7.0。

─── Python 侧的差异 ───────────────────────────────────────────

天然就对的：
  · str 按码点存：TS 的 `[...msg]` 就是 msg 本身，按 200 个码点截断不会切开 emoji；sorted() 也按码点排。
  · dict 保插入序；TS 的 `'k' in obj` 就是 `"k" in d`，缺键和 null 照样分得开。

反而要小心的：
  · bool 是 int 的子类：isError 的判定写 is None / is False，不写 == 或 in (None, False)——否则 0 被当成 false。
    `=== true` 一律写 is True。
  · {}、[]、""、0 都是假值：TS 的 `=== undefined`、`!== ''` 不改写成真值判断。
  · 正则用 re.fullmatch 代替 ^…$，不用 \d \s \w；替换串里的 $1 写成 \1。小写只动 ASCII（ascii_lower）。
  · 抛出来的异常取 str(e)，对应 TS 的 Error.message。
  · JSON 用 json.dumps(ensure_ascii=False, separators=(",", ":"))：和 JSON.stringify 只在浮点数（1.0）
    和数组下标样的键（"0" 排最前）上不同，夹具和 verify 都不碰。
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, NotRequired, TypedDict, cast

Json = None | bool | int | float | str | list["Json"] | dict[str, "Json"]


def _J(x: Any) -> str:
    return json.dumps(x, ensure_ascii=False, separators=(",", ":"))


def _is_obj(x: Any) -> bool:
    return isinstance(x, dict)


def ascii_lower(s: str) -> str:
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def cmp_code_point(a: str, b: str) -> int:
    """按 Unicode 码点比较（JS 默认的 sort 按 UTF-16 码元，两种语言在代理对上会排得不一样）。
    Python 的 str 比较本来就按码点，sorted() 直接就对；这个函数留给需要显式比较器的地方。
    """
    n = min(len(a), len(b))
    for i in range(n):
        p = ord(a[i])
        q = ord(b[i])
        if p != q:
            return -1 if p < q else 1
    if len(a) == len(b):
        return 0
    return -1 if len(a) < len(b) else 1


def canonical_json(x: Json) -> str:
    """键按码点排序的 JSON：判断「两次调用的参数是不是同一个」时，`{a,b}` 和 `{b,a}` 必须相等。"""
    if isinstance(x, list):
        return "[" + ",".join(canonical_json(v) for v in x) + "]"
    if isinstance(x, dict):
        return "{" + ",".join(f"{_J(k)}:{canonical_json(x[k])}" for k in sorted(x)) + "}"
    return _J(x)


def fmt_usd(micro: int) -> str:
    """整数微美元 → `0.0012`（四位小数，截断）。成本一律用整数存，避免两种语言打印浮点数不一致。"""
    whole = micro // 1_000_000
    frac = str((micro % 1_000_000) // 100)
    return f"{whole}.{'0' * max(0, 4 - len(frac))}{frac}"


# ─────────────────────────────────────────────────────────────
# 一、循环与终止（I-STOP）：默认步数从 1 到无穷大（调研 §4.1–4.3、§5.2、§6.2、§7.2、§8）
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class LoopDefault:
    # `框架/入口`
    id: str
    # None = 没有默认上限
    default_limit: int | None
    on_limit: Literal["return", "throw", "none"]
    # 撞上限时，调用方从返回值 / 异常里能读到的全部信号
    signal: str
    evidence: str


@dataclass(frozen=True)
class LoopOutcome:
    model_calls: int
    tool_runs: int
    ending: str


def simulate_default_loop(d: LoopDefault, cut: int) -> LoopOutcome:
    """「永远失败的工具 + 每次都重试的模型」在一个入口的默认值下跑多少次、怎么结束。没有上限的入口在 cut 处被外部掐断。
    ★ AI SDK 撞上限是**正常返回**，最后一步 finishReason 是 tool-calls、text 是空串——和「停在审批上」同值。
    """
    if d.default_limit is None:
        return LoopOutcome(
            model_calls=cut, tool_runs=cut, ending=f"没有上限，第 {cut} 次被外部掐断"
        )
    n = d.default_limit
    ending = f"抛：{d.signal}" if d.on_limit == "throw" else f"返回：{d.signal}"
    return LoopOutcome(model_calls=n, tool_runs=n, ending=ending)


def ai_sdk_is_step_count(n: int) -> Callable[[list[Step]], bool]:
    """对照组：AI SDK 的 `isStepCount(n)` 是 `steps.length === n`（严格相等）。★ `isStepCount(0)` 永远不触发。"""

    def stop(steps: list[Step]) -> bool:
        return len(steps) == n

    return stop


@dataclass(frozen=True)
class ToolCall:
    name: str
    args: Json


@dataclass(frozen=True)
class Step:
    """一步的形状，取 AI SDK StepResult 里和终止有关的三个字段。"""

    tool_calls: list[ToolCall]
    # stop | tool-calls | length | error | other
    finish_reason: str
    # 这一步停在 tool-approval-request 上（None = TS 里没有这个键）
    approval_requested: bool | None = None


StopReason = Literal["running", "approval", "truncated", "error", "done", "repeat", "max_steps"]


@dataclass(frozen=True)
class StopOpts:
    max_steps: int
    # 连续多少步调用完全相同就停；小于 2 表示不查
    max_repeat: int


def call_signature(s: Step) -> str:
    """一步里全部工具调用的签名：`name(规范化参数)`，按调用顺序用 | 连接。"""
    return "|".join(f"{c.name}({canonical_json(c.args)})" for c in s.tool_calls)


def course_stop_reason(steps: list[Step], o: StopOpts) -> StopReason:
    """TODO 1 的参考实现：L05 的 `AgentRun.reason`，用最后一步和整段历史算出来。优先级从上到下：
      没有步               → running
      最后一步要审批        → approval
      finishReason=length  → truncated（工具参数可能被截断，L16）
      finishReason=error   → error
      最后一步没有工具调用   → done
      最近 max_repeat 步的签名全部相同（max_repeat ≥ 2）→ repeat
      步数 ≥ max_steps     → max_steps（≥，不是 ==：max_steps 写成 0 也会停）
      否则                  → running
    ★ 框架只给最后一步的 finishReason：撞上限、停在审批、调了没有 execute 的工具，三种都是 tool-calls。
    """
    if len(steps) == 0:
        return "running"
    last = steps[len(steps) - 1]
    if last.approval_requested is True:
        return "approval"
    if last.finish_reason == "length":
        return "truncated"
    if last.finish_reason == "error":
        return "error"
    if len(last.tool_calls) == 0:
        return "done"
    if o.max_repeat >= 2 and len(steps) >= o.max_repeat:
        sig = call_signature(last)
        same = True
        for i in range(len(steps) - o.max_repeat, len(steps)):
            if call_signature(steps[i]) != sig:
                same = False
                break
        if same:
            return "repeat"
    if len(steps) >= o.max_steps:
        return "max_steps"
    return "running"


def course_stop_when(o: StopOpts) -> Callable[[list[Step]], bool]:
    """接到 AI SDK 的 `stopWhen` 上：停不停由 reason 决定，reason 本身由你记下来。"""

    def stop(steps: list[Step]) -> bool:
        return course_stop_reason(steps, o) != "running"

    return stop


# ─────────────────────────────────────────────────────────────
# 二、工具错误回填（I-ERR）：三家泄密、一家抹掉（调研 §4.4、§5.2、§6.6、§7.3）
# ─────────────────────────────────────────────────────────────


class ToolErr(TypedDict):
    """原样的 JSON 对象（TS 里是 interface），所以是 dict：course_tool_error 收的 e 本来就是 unknown。"""

    name: str
    message: str
    code: NotRequired[str]


class ToolCtx(TypedDict):
    tool: str


@dataclass(frozen=True)
class BackfillRule:
    framework: str
    # toString = `${name}: ${message}`；message = 原样 message；fixed = 固定文案
    rule: Literal["toString", "message", "fixed"]
    # 线上有没有 is_error：true / — / 未核实
    is_error: str
    evidence: str


OPENAI_DEFAULT_TOOL_ERROR = "An error occurred while running the tool. Please try again."


def framework_backfill(r: BackfillRule, e: ToolErr) -> str:
    """一家框架默认会把这个异常变成什么文本交给模型。"""
    if r.rule == "toString":
        return f"{e['name']}: {e['message']}"
    if r.rule == "message":
        return e["message"]
    return OPENAI_DEFAULT_TOOL_ERROR


ERROR_PREFIX = "[tool error] "
NEXT_STEP = "下一步："
MAX_ERROR_MESSAGE = 200
MAX_ERROR_TEXT = 400
# 让模型「原样再来一次」的文案。叠加没有上限的循环就是死循环（E5-A、E6-A）。
RETRY_AS_IS = ["Please try again", "try this action again as-is"]

ERROR_HINTS: list[tuple[str, str]] = [
    ("ENOENT", "路径不存在：先列出目录确认文件名，再换路径调用"),
    ("EACCES", "没有权限：不要重试同一个调用，换一个允许的路径或请用户授权"),
    ("EPERM", "没有权限：不要重试同一个调用，换一个允许的路径或请用户授权"),
    ("ETIMEDOUT", "可能是临时故障：最多再试一次，仍失败就停下来报告"),
    ("ECONNRESET", "可能是临时故障：最多再试一次，仍失败就停下来报告"),
    ("INVALID_ARGS", "参数不合法：对照工具的 schema 改参数后再调用"),
]
DEFAULT_HINT = "换参数或换工具；做不到就停下来向用户说明，不要原样重试"

_SECRET_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]+"), "sk-***"),
    (re.compile(r"(secret|token|password|api_key)=[^ \t\n\r,;)\]}'\"]+"), r"\1=***"),
    (re.compile(r"Bearer [A-Za-z0-9._~+/=-]+"), "Bearer ***"),
]


def redact_secrets(s: str) -> str:
    """TODO 2 的参考实现（前半）：三条规则依次全局替换。
      `sk-` 开头的 key，前面不能紧挨字母或数字（`task-queue` 里的 `sk-queue` 不是 key）
      `secret= / token= / password= / api_key=` 后面到空白或 `,;)]}'"` 之前的值（只认小写键名）
      `Bearer ` 后面的 token
    替换结果再跑一遍不变（幂等）。
    """
    out = s
    for pattern, rep in _SECRET_RULES:
        out = pattern.sub(rep, out)
    return out


def _message_of(e: Any) -> str:
    if isinstance(e, dict) and isinstance(e.get("message"), str):
        return e["message"]
    if isinstance(e, str):
        return e
    if isinstance(e, BaseException):
        return str(e)
    return "（没有错误信息）"


def error_code(e: Any, message: str) -> str:
    """错误码：`e.code`（非空字符串），否则 message 开头的 `E` + 至少一个大写字母（`ENOENT: ...`）。"""
    if isinstance(e, dict):
        code = e.get("code")
        if isinstance(code, str) and code != "":
            return code
    if len(message) == 0 or message[0] != "E":
        return ""
    i = 1
    while i < len(message) and "A" <= message[i] <= "Z":
        i += 1
    return message[:i] if i >= 2 else ""


def hint_for(code: str) -> str:
    for c, h in ERROR_HINTS:
        if c == code:
            return h
    return DEFAULT_HINT


def course_tool_error(e: Any, ctx: ToolCtx) -> str:
    r"""TODO 2 的参考实现（后半）：两家框架共用的错误出口（AI SDK 的 execute 包装、Agents SDK 的 errorFunction）。
      `[tool error] 工具名: 消息\n下一步：提示`
      消息：换行和回车换成空格 → redact_secrets → 超过 200 个码点截断并加 `…`
      工具名为空 → unknown-tool；提示按 error_code 查 ERROR_HINTS，查不到用 DEFAULT_HINT
    ★ DeepSeek 的 Anthropic 端点忽略 is_error（INV-11）：「这是失败」和「下一步做什么」都必须写在文本里。
    """
    raw = _message_of(e)
    code = error_code(e, raw)
    msg = redact_secrets(raw.replace("\r", " ").replace("\n", " "))
    if len(msg) > MAX_ERROR_MESSAGE:
        msg = msg[:MAX_ERROR_MESSAGE] + "…"
    tool = "unknown-tool" if ctx["tool"] == "" else ctx["tool"]
    return f"{ERROR_PREFIX}{tool}: {msg}\n{NEXT_STEP}{hint_for(code)}"


def audit_backfill(text: str, tool: str) -> list[str]:
    """拿课程的五条要求去量一段回填文本。空列表 = 合格。"""
    out: list[str] = []
    if redact_secrets(text) != text:
        out.append("leaks-secret")
    low = ascii_lower(text)
    if "error" not in low and "失败" not in text and "错误" not in text:
        out.append("no-error-signal")
    if tool not in text:
        out.append("no-tool-name")
    if NEXT_STEP not in text:
        out.append("no-next-step")
    for p in RETRY_AS_IS:
        if p in text:
            out.append("retry-as-is")
            break
    if len(text) > MAX_ERROR_TEXT:
        out.append("too-long")
    return out


# ─────────────────────────────────────────────────────────────
# 三、审批恢复（I-IDEM）：同一份 RunState 恢复两次，副作用两次（调研 §7.4、§9.3）
# ─────────────────────────────────────────────────────────────


def run_state_resume(times: int, effect: Callable[[], None]) -> list[int]:
    """对照组：`RunState.fromString(saved)` → approve → `run()`，每次都从头执行被批准的那个工具。"""
    counts: list[int] = []
    n = 0
    for _ in range(times):
        effect()
        n += 1
        counts.append(n)
    return counts


Kv = dict[str, str]

ResumeStatus = Literal["ran", "already-consumed", "conflict", "in-flight", "crashed"]


@dataclass(frozen=True)
class ResumeOutcome:
    status: ResumeStatus
    # ran / already-consumed：结果；conflict：先前的决定；crashed：异常信息；in-flight：空串
    result: str


def resume_once(
    store: Kv,
    approval_id: str,
    decision: Literal["approve", "reject"],
    resume: Callable[[], str],
) -> ResumeOutcome:
    """TODO 3 的参考实现：一条审批只被消费一次。键 `approval:{approval_id}`，值有两种：
      `in-flight`                      已认领、还没有结果
      `done:{decision}:{result}`       已完成（result 里可以有冒号，只按前两个冒号切）
    规则：
      没有记录 → 先写 in-flight，再调 resume()；成功写 done 返回 ran；抛异常返回 crashed（记录**留在 in-flight**）
      in-flight → 返回 in-flight，**不**再调 resume()（上次可能已经产生了副作用，要对账，不能重跑）
      done 且决定相同 → already-consumed + 缓存的结果；决定不同 → conflict + 先前的决定
    ★ 框架把「恢复」当成纯函数：worker 崩溃后重放同一条审批，有副作用的工具再执行一次（E6-B 实测 1 → 2）。
    """
    key = f"approval:{approval_id}"
    cur = store.get(key)
    if cur == "in-flight":
        return ResumeOutcome(status="in-flight", result="")
    if cur is not None:
        rest = cur[len("done:") :]
        k = rest.find(":")
        prev = rest[:k]
        if prev == decision:
            return ResumeOutcome(status="already-consumed", result=rest[k + 1 :])
        return ResumeOutcome(status="conflict", result=prev)
    store[key] = "in-flight"
    try:
        r = resume()
    except Exception as e:
        return ResumeOutcome(status="crashed", result=_message_of(e))
    store[key] = f"done:{decision}:{r}"
    return ResumeOutcome(status="ran", result=r)


# ─────────────────────────────────────────────────────────────
# 四、MCP 的 isError（I-ERR × L10）：在 AI SDK 的 MCP 路径上丢了，在 DeepSeek 上本来就不算数（调研 §4.9、§4.15）
# ─────────────────────────────────────────────────────────────


class McpResult(TypedDict, total=False):
    """MCP CallToolResult，原样的 JSON 对象（键是线上的驼峰名）。值都是不可信的。"""

    content: Any
    isError: Any
    structuredContent: Any


def ai_sdk_mcp_wire(r: McpResult, tool_use_id: str) -> Json:
    """对照组：`@ai-sdk/mcp` 把 isError 的结果原样当成功返回，`mcpToModelOutput` 不看 isError，
    Anthropic provider 只对 error-text / error-json 设 is_error——线上块里没有 is_error（E2 实测）。
    """
    content: list[Json] = []
    raw = r.get("content")
    for c in raw if isinstance(raw, list) else []:
        if _is_obj(c) and c.get("type") == "text" and isinstance(c.get("text"), str):
            content.append({"type": "text", "text": c["text"]})
    return {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}


@dataclass(frozen=True)
class McpText:
    text: str
    is_error: bool


def mcp_result_to_text(r: McpResult) -> McpText:
    """TODO 4 的参考实现：MCP CallToolResult → 一段模型能读懂的文本。
      isError：只有缺省、null、false 算成功，其余（"true"、1、0……）一律当失败（fail-closed）
      content 逐项（不是数组就当空）：
        text            → text
        image           → `[image {mimeType}，未展开]`（mimeType 不是字符串写 ?）
        resource        → `[resource {uri}]`，有 text 再换行接 text（uri 不是字符串写 ?）
        resource_link   → `[link {uri}]`
        不是对象         → `[unsupported content]`
        其他             → `[unsupported content: {type}]`（type 不是字符串就写它的 JSON，缺省写 null）
      用换行连接。一项都没有：有 structuredContent 键 → 它的 JSON；否则 `(empty result)`
      失败：`[tool error] ` + redact_secrets(正文)
    ★ Python 里 0 == False：isError 只能用 is 判，不能用 == 或 in (None, False)。
    """
    flag = r.get("isError")
    is_error = flag is not None and flag is not False
    parts: list[str] = []
    raw = r.get("content")
    for c in raw if isinstance(raw, list) else []:
        if not _is_obj(c):
            parts.append("[unsupported content]")
            continue
        t = c.get("type")
        if t == "text" and isinstance(c.get("text"), str):
            parts.append(c["text"])
        elif t == "image":
            mime = c.get("mimeType")
            parts.append(f"[image {mime if isinstance(mime, str) else '?'}，未展开]")
        elif t == "resource" and _is_obj(c.get("resource")):
            res = c["resource"]
            uri = res["uri"] if isinstance(res.get("uri"), str) else "?"
            text = res.get("text")
            parts.append(
                f"[resource {uri}]\n{text}" if isinstance(text, str) else f"[resource {uri}]"
            )
        elif t == "resource_link" and isinstance(c.get("uri"), str):
            parts.append(f"[link {c['uri']}]")
        else:
            parts.append(f"[unsupported content: {t if isinstance(t, str) else _J(t)}]")
    body = "\n".join(parts)
    if len(parts) == 0:
        body = _J(r.get("structuredContent")) if "structuredContent" in r else "(empty result)"
    if not is_error:
        return McpText(text=body, is_error=False)
    return McpText(text=ERROR_PREFIX + redact_secrets(body), is_error=True)


def course_mcp_wire(r: McpResult, tool_use_id: str) -> Json:
    """课程的线上块：失败时 is_error 照设（对别的端点有用），但承重的是文本。"""
    m = mcp_result_to_text(r)
    if m.is_error:
        return {
            "type": "tool_result",
            "tool_use_id": tool_use_id,
            "content": m.text,
            "is_error": True,
        }
    return {"type": "tool_result", "tool_use_id": tool_use_id, "content": m.text}


def deepseek_sees(block: Json) -> str:
    """DeepSeek 的 Anthropic 端点：`tool_result.is_error`、各处 `cache_control` 都标注为 Ignored。模型能看到的只剩内容文本。"""
    if not isinstance(block, dict):
        return ""
    c = block.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(
            x["text"] if isinstance(x, dict) and isinstance(x.get("text"), str) else "" for x in c
        )
    return ""


# ─────────────────────────────────────────────────────────────
# 五、历史是谁的（I-HIST）：UI 遮罩改写下一轮历史（调研 §4.10、§4.7）
# ─────────────────────────────────────────────────────────────

AI_SDK_UI_ERROR_MASK = "An error occurred."


@dataclass(frozen=True)
class UiRound:
    turn_n: str
    ui: str
    turn_n1: str


def ui_round_trip(model_saw: str, on_error: Callable[[str], str] | None = None) -> UiRound:
    """对照组：`toUIMessageStream` 的默认 onError 把客户端工具的错误遮成固定文案；`useChat` 标准模式下，
    服务端下一轮从客户端发来的 UI 消息重建历史——模型第 N+1 轮看到的是遮罩后的文本（E2-UI 实测）。
    """
    ui = AI_SDK_UI_ERROR_MASK if on_error is None else on_error(model_saw)
    return UiRound(turn_n=model_saw, ui=ui, turn_n1=ui)


@dataclass(frozen=True)
class UiToolPart:
    tool_call_id: str
    state: Literal["output-error", "output-available"]
    # errorText 或 output
    text: str


@dataclass(frozen=True)
class LoggedResult:
    tool_call_id: str
    kind: Literal["error", "result"]
    # 第 N 轮模型实际看到的文本
    text: str


@dataclass(frozen=True)
class ModelToolResult:
    tool_call_id: str
    type: Literal["error-text", "text"]
    value: str


@dataclass(frozen=True)
class Rebuilt:
    history: list[ModelToolResult]
    # 服务端有、UI 也有，但种类或文本不一样（被遮罩、被改写）
    drifted: list[str]
    # UI 里有、服务端没有：客户端造出来的（包括伪造的审批结果）
    forged: list[str]
    # 服务端有、UI 里没有：客户端丢掉的
    dropped: list[str]


def rebuild_history(ui: list[UiToolPart], log: list[LoggedResult]) -> Rebuilt:
    """TODO 5 的参考实现：下一轮的历史以服务端日志为准，客户端发来的 UI 消息只用来对账。
      history：按日志顺序，每条日志一项；kind=error → type error-text，否则 text；value 是日志里的文本
      UI 里同一个 tool_call_id 出现多次，只看第一次
      forged：UI 里有、日志里没有的 id（按 UI 顺序、去重）
      dropped：日志里有、UI 里没有的 id（按日志顺序）
      drifted：两边都有，但 UI 的 state（output-error ↔ error）或文本和日志不一致（按日志顺序）
    ★ 历史不是 append-only 的：同一个 tool_result 第 N 轮带出路、第 N+1 轮只剩 An error occurred.，前缀缓存同时失效。
    """
    log_ids = [rec.tool_call_id for rec in log]
    first: dict[str, UiToolPart] = {}
    forged: list[str] = []
    for p in ui:
        if p.tool_call_id not in log_ids:
            if p.tool_call_id not in forged:
                forged.append(p.tool_call_id)
            continue
        if p.tool_call_id not in first:
            first[p.tool_call_id] = p
    history: list[ModelToolResult] = []
    drifted: list[str] = []
    dropped: list[str] = []
    for rec in log:
        history.append(
            ModelToolResult(
                tool_call_id=rec.tool_call_id,
                type="error-text" if rec.kind == "error" else "text",
                value=rec.text,
            )
        )
        part = first.get(rec.tool_call_id)
        if part is None:
            dropped.append(rec.tool_call_id)
            continue
        same_kind = (part.state == "output-error") == (rec.kind == "error")
        if not same_kind or part.text != rec.text:
            drifted.append(rec.tool_call_id)
    return Rebuilt(history=history, drifted=drifted, forged=forged, dropped=dropped)


# ─────────────────────────────────────────────────────────────
# 六、把 Dify DSL 读成代码计划（调研 §11.2 的八步）
# ─────────────────────────────────────────────────────────────

# 画布字段：拖一下节点，git diff 里就是这些。
DIFY_UI_FIELDS = [
    "position",
    "positionAbsolute",
    "width",
    "height",
    "selected",
    "zIndex",
    "sourcePosition",
    "targetPosition",
    "dragging",
]
# `{{#sys.query#}}` 这类引用指向会话状态，不是节点。
DIFY_NAMESPACES = ["sys", "env", "conversation"]
DIFY_READER_VERSION = "0.7.0"


@dataclass(frozen=True)
class DifyStep:
    id: str
    type: str
    title: str
    # 改写成代码时要补的东西
    needs: list[str]


@dataclass
class DifyPlan:
    version: str
    kind: str
    ui_fields_dropped: int
    order: list[str]
    steps: list[DifyStep]
    branches: list[str]
    refs: list[str]
    errors: list[str]


_VERSION_RE = re.compile(r"([0-9]+)\.([0-9]+)\.([0-9]+)")
_REF_RE = re.compile(r"\{\{#([A-Za-z0-9_]+)\.([A-Za-z0-9_.]+)#\}\}")


def _version_parts(v: str) -> list[int] | None:
    m = _VERSION_RE.fullmatch(v)
    return None if m is None else [int(m[1]), int(m[2]), int(m[3])]


def _strings_in(x: Any, out: list[str]) -> None:
    if isinstance(x, str):
        out.append(x)
    elif isinstance(x, list):
        for v in x:
            _strings_in(v, out)
    elif isinstance(x, dict):
        for k in x:
            _strings_in(x[k], out)


def dify_needs(type_: str, data: dict[str, Any]) -> list[str]:
    """每种节点改写成代码时要补的东西。对应 §11.2 第 4–7 步。"""
    if type_ in [
        "start",
        "end",
        "answer",
        "if-else",
        "question-classifier",
        "template-transform",
        "variable-aggregator",
    ]:
        return []
    if type_ == "llm":
        mem = data.get("memory")
        win = mem.get("window") if isinstance(mem, dict) else None
        return (
            ["sliding-window-breaks-cache"]
            if isinstance(win, dict) and win.get("enabled") is True
            else []
        )
    if type_ == "agent" or type_ == "agent_v2":
        return ["max-steps", "stop-reason"]
    if type_ == "knowledge-retrieval":
        return ["rebind-index"]
    if type_ == "tool":
        cred = data.get("credential_id")
        return [] if isinstance(cred, str) and cred != "" else ["reconnect-secret"]
    if type_ == "http-request":
        out: list[str] = []
        rc = data.get("retry_config")
        if not (isinstance(rc, dict) and rc.get("enabled") is True):
            out.append("no-retry")
        method = data.get("method")
        m = ascii_lower(method) if isinstance(method, str) else "get"
        if m != "get" and m != "head":
            out.append("idempotency-key")
        return out
    if type_ == "code":
        return ["sandbox"]
    if type_ == "human_input":
        return ["server-side-approval"]
    return ["unknown-node-type"]


@dataclass(frozen=True)
class _DifyNode:
    type: str
    title: str
    data: dict[str, Any]


def dify_plan(dsl: Any) -> DifyPlan:
    """TODO 6 的参考实现。按顺序：
      1. 不是对象 → errors ['not-an-object']，其余字段空
      2. version 缺省当 '0.1.0'、kind 缺省当 'app'（Dify 导入时就这么补）；kind 不是 app → `kind:{kind}`；
         version 不是 x.y.z → `bad-version:{v}`；比 DIFY_READER_VERSION 新 → `newer-dsl:{v}`
      3. 节点（workflow.graph.nodes，列表顺序）：不是对象或 id 不是非空字符串 → 'bad-node'；id 重复 → `duplicate-node:{id}`（后一个丢掉）；
         每个节点、每条边上出现的 DIFY_UI_FIELDS 键计入 ui_fields_dropped（重复的节点也算）
      4. 边（列表顺序）：不是对象 → 'bad-edge'；source / target 不是已知节点 → `dangling-edge:{id 或 ?}`；
         sourceHandle（缺省 'source'）不是 'source' → branches 加 `{source}:{handle}->{target}`
      5. 拓扑序（Kahn）：每轮取节点列表里第一个入度为 0 且未取过的；取不完的 → `cycle:{剩下的 id 用逗号连}`
      6. steps：先拓扑序、再剩下的（列表顺序）；needs 用 dify_needs
      7. 引用：按 steps 的顺序，扫节点 data 里所有字符串（键的顺序、数组顺序）中的 `{{#src.field#}}`：
         src 是 sys / env / conversation → refs 加 `{id}<-{src}.{field}`
         src 不是节点 → `unknown-ref:{id}:{src}.{field}`
         src 不是这个节点的祖先（沿边反向可达）→ `ref-not-upstream:{id}:{src}.{field}`
         否则 refs 加 `{id}<-{src}.{field}`；refs 去重
    ★ 拓扑序在前 ≠ 是上游：if-else 的两个分支在拓扑序里一前一后，互相引用就是运行时的空值。
    """
    plan = DifyPlan(
        version="",
        kind="",
        ui_fields_dropped=0,
        order=[],
        steps=[],
        branches=[],
        refs=[],
        errors=[],
    )
    if not isinstance(dsl, dict):
        plan.errors.append("not-an-object")
        return plan
    version = dsl.get("version")
    kind = dsl.get("kind")
    plan.version = version if isinstance(version, str) else "0.1.0"
    plan.kind = kind if isinstance(kind, str) else "app"
    if plan.kind != "app":
        plan.errors.append(f"kind:{plan.kind}")
    vp = _version_parts(plan.version)
    rp = cast(list[int], _version_parts(DIFY_READER_VERSION))
    if vp is None:
        plan.errors.append(f"bad-version:{plan.version}")
    else:
        cmp = 0
        i = 0
        while i < 3 and cmp == 0:
            cmp = 0 if vp[i] == rp[i] else (-1 if vp[i] < rp[i] else 1)
            i += 1
        if cmp > 0:
            plan.errors.append(f"newer-dsl:{plan.version}")

    wf = dsl.get("workflow")
    graph = wf.get("graph") if isinstance(wf, dict) else None
    nodes_raw = (
        graph["nodes"] if isinstance(graph, dict) and isinstance(graph.get("nodes"), list) else []
    )
    edges_raw = (
        graph["edges"] if isinstance(graph, dict) and isinstance(graph.get("edges"), list) else []
    )

    ids: list[str] = []
    by_id: dict[str, _DifyNode] = {}
    for n in nodes_raw:
        if not isinstance(n, dict) or not isinstance(n.get("id"), str) or n["id"] == "":
            plan.errors.append("bad-node")
            continue
        for f in DIFY_UI_FIELDS:
            if f in n:
                plan.ui_fields_dropped += 1
        nid: str = n["id"]
        if nid in by_id:
            plan.errors.append(f"duplicate-node:{nid}")
            continue
        data = n["data"] if isinstance(n.get("data"), dict) else {}
        ids.append(nid)
        node_type = data.get("type")
        title = data.get("title")
        by_id[nid] = _DifyNode(
            type=node_type if isinstance(node_type, str) else "",
            title=title if isinstance(title, str) else "",
            data=data,
        )

    succ: dict[str, list[str]] = {}
    pred: dict[str, list[str]] = {}
    indeg: dict[str, int] = {}
    for nid in ids:
        succ[nid] = []
        pred[nid] = []
        indeg[nid] = 0
    for e in edges_raw:
        if not isinstance(e, dict):
            plan.errors.append("bad-edge")
            continue
        for f in DIFY_UI_FIELDS:
            if f in e:
                plan.ui_fields_dropped += 1
        s = e.get("source")
        t = e.get("target")
        if not isinstance(s, str) or not isinstance(t, str) or s not in by_id or t not in by_id:
            eid = e.get("id")
            plan.errors.append(f"dangling-edge:{eid if isinstance(eid, str) else '?'}")
            continue
        succ[s].append(t)
        pred[t].append(s)
        indeg[t] = indeg[t] + 1
        handle = e.get("sourceHandle")
        h = handle if isinstance(handle, str) else "source"
        if h != "source":
            plan.branches.append(f"{s}:{h}->{t}")

    taken: list[str] = []
    while True:
        pick = ""
        for nid in ids:
            if nid not in taken and indeg[nid] == 0:
                pick = nid
                break
        if pick == "":
            break
        taken.append(pick)
        for t in succ[pick]:
            indeg[t] = indeg[t] - 1
    plan.order = taken
    stuck = [nid for nid in ids if nid not in taken]
    if len(stuck) > 0:
        plan.errors.append(f"cycle:{','.join(stuck)}")

    def ancestors(nid: str) -> list[str]:
        seen: list[str] = []
        stack = [*pred[nid]]
        while len(stack) > 0:
            x = stack.pop()
            if x in seen:
                continue
            seen.append(x)
            for p in pred[x]:
                stack.append(p)
        return seen

    for nid in [*taken, *stuck]:
        node = by_id[nid]
        plan.steps.append(
            DifyStep(
                id=nid, type=node.type, title=node.title, needs=dify_needs(node.type, node.data)
            )
        )
        strs: list[str] = []
        _strings_in(node.data, strs)
        up = ancestors(nid)
        for s in strs:
            for m in _REF_RE.finditer(s):
                src = m[1]
                field = m[2]
                ref = f"{nid}<-{src}.{field}"
                if src in DIFY_NAMESPACES:
                    if ref not in plan.refs:
                        plan.refs.append(ref)
                elif src not in by_id:
                    plan.errors.append(f"unknown-ref:{nid}:{src}.{field}")
                elif src not in up:
                    plan.errors.append(f"ref-not-upstream:{nid}:{src}.{field}")
                elif ref not in plan.refs:
                    plan.refs.append(ref)
    return plan


# ─────────────────────────────────────────────────────────────
# 七、平台、框架、手写（调研 §11.5、§12）
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PlatformNeeds:
    fixed_flow: bool
    read_only_tools: bool
    internal_users: bool
    eval_gate: bool
    per_tenant_billing: bool
    write_approval: bool
    ci: bool
    multi_tenant_saas: bool
    paid_embedding: bool


@dataclass(frozen=True)
class PlatformPick:
    pick: str
    why: list[str]
    license: list[str]


def choose_platform(n: PlatformNeeds) -> PlatformPick:
    """§11.5 的经验法则（调研的推论，不是一手结论）：流程固定、工具只读、使用者是内部运营 → 平台；
    要 eval 门禁、按租户计费、写操作要审批、要进 CI → 手写（流程固定时可以拿平台做原型）。许可单独列。
    """
    why: list[str] = []
    if n.eval_gate:
        why.append("要 eval 门禁")
    if n.per_tenant_billing:
        why.append("按租户计费")
    if n.write_approval:
        why.append("写操作要审批")
    if n.ci:
        why.append("要进 CI")
    lic: list[str] = []
    if n.multi_tenant_saas:
        lic.append("Dify：多租户（一个 workspace 即一个租户）要书面授权")
    if n.paid_embedding:
        lic.append("n8n：不能嵌进对外收费的产品")
    if len(why) > 0:
        pick = "平台做原型，DSL 当需求文档，手写上线" if n.fixed_flow else "手写"
        return PlatformPick(pick=pick, why=why, license=lic)
    if n.fixed_flow and n.read_only_tools and n.internal_users:
        return PlatformPick(pick="平台", why=["流程固定、工具只读、使用者是内部运营"], license=lic)
    return PlatformPick(pick="手写", why=["平台的三个前提不全满足"], license=lic)
