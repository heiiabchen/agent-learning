"""L14 参考实现：prompt 注入与权限沙箱。

★ 这一节的核心论点，值得写在最前面：

**能读懂攻击的防御，全被绕过了；守住的那些，都是看不见攻击的。**

  读得懂的（in-band）        分隔符、spotlighting、注入分类器、
                             指令层级微调、输出"消毒"
                             → 自适应攻击下 12 个防御里大多数 >90% ASR
                               （arXiv 2510.09023），而它们原本报的都是接近零

  看不见的（out-of-band）    按参数的来源授权、能力契约、
                             凭据降权、把通道整个拿掉
                             → 对它们设计针对的那类攻击，成功率是 0

最能说明问题的是那个例外：Claude Code 的审批分类器是**唯一一个有效的
分类器**，而官方文档写得很清楚——"Tool results are stripped, so hostile
content in a file or web page can't manipulate it directly."
★ 它有效**恰恰因为它看不见那段不可信的数据**。

推论，也是这一节全部代码的依据：
  **做授权判断的那段代码，绝不能读那段不可信的数据。**

还有一件必须先说的事：这一节的交付物（沙箱 + 人工审批），
在 2026 年恰恰是厂商刚刚**拿掉**的东西。Cursor 3.5（2026-05-22）
弃用了 "Ask Every Time"，3.6（2026-05-29）把 Auto-review 设成默认；
Claude Code 在 Pro/Max/Team 上默认 auto 模式，"a second model, the
classifier, reviews actions instead of you"。
所以要教的不是"弹个框问人"，而是**一个可插拔的策略决策点**
（人 | 规则 | 模型），以及它必须满足的那几条性质。

和前面每一节一样：这里每一个失效都不抛异常。

这个文件是 shared/guard.ts 的 Python 镜像，输出逐字节一致。
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Generic, Literal, Protocol, TypeVar

T = TypeVar("T")

# ─────────────────────────────────────────────────────────────
# 一、来源：给「值」打标签，不给「消息」打标签
# ─────────────────────────────────────────────────────────────

Origin = Literal["user", "config", "tool"]
"""值的来源。只有三类，而分界线是**这段字节是谁写的**。

注意 tool 并不等于"不可信"。OWASP 2026 的 LLM01 把间接注入面分成三档
信任度：untrusted（公网、陌生人邮件、搜索结果）、semi-trusted（公开
issue 标题、包的 README 和 changelog、第三方 API 响应）、trusted（你自己
的仓库、数据库、内部文档、邮件）。★ 而它对 trusted 那一档加了一句：
"The developer may not realize an attacker has placed content here."
"""


@dataclass(frozen=True)
class Provenance:
    origin: Origin
    # 具体是谁：'cli' / 'settings.json' / 'read_issue' / 'fetch_url'
    source: str
    # ★ 这一位是**你**声明的，不是推断的。默认应当是 False。
    trusted: bool


@dataclass
class Tainted(Generic[T]):
    """一个带来源的值。id 用来在依赖图里指代它。"""

    id: str
    value: T
    # 直接父节点的 id。递归展开由 Flow 负责。
    deps: list[str] = field(default_factory=list)
    # 只有 fresh() 出来的值有自己的来源；combine 出来的值靠 deps 推。
    own: Provenance | None = None


class Flow:
    """数据流图。这是 CaMeL 的自定义解释器**去掉解释器**之后剩下的部分：
    每个值记住它从哪儿来，合并时并集，查询时递归展开。

    两种模式，和 CaMeL 一致：
      NORMAL —— 只跟踪显式的数据合并
      STRICT —— 分支内赋的值，额外依赖**分支条件**

    ★ STRICT 不是洁癖。CaMeL 论文里明确说它是为了堵 side channel：
    用一个依赖隐私数据的条件去触发/不触发一次可观测的调用，
    每次泄漏一个比特。他们自己承认 CaMeL 仍然 "vulnerable to
    side-channel attacks"，并给了三个具体的（外部资源探测、
    异常处理泄漏一个比特、计时）。
    """

    def __init__(self, strict: bool = False) -> None:
        self.strict = strict
        self._nodes: dict[str, Tainted[Any]] = {}
        self._seq = 0
        # STRICT 模式下当前生效的分支条件 id。
        self._guards: list[str] = []

    def _next_id(self, tag: str) -> str:
        self._seq += 1
        return f"{tag}#{self._seq}"

    def fresh(self, value: T, prov: Provenance, tag: str | None = None) -> Tainted[T]:
        """一个有明确来源的新值。"""
        node: Tainted[T] = Tainted(
            id=self._next_id(tag or prov.origin),
            value=value,
            deps=list(self._guards) if self.strict else [],
            own=prov,
        )
        self._nodes[node.id] = node
        return node

    def combine(self, value: T, parts: list[Tainted[Any]], tag: str = "derived") -> Tainted[T]:
        """由若干个已有值算出的新值。

        ★ 这个函数是整套东西的地基，而它最容易写错的地方是**漏掉并集**：
        只记第一个父节点、或者干脆不记，编译能过、测试能过、演示能过——
        直到某个由不可信数据派生出来的值被当成可信的送进一个有权限的
        参数。那时候什么都不会报错。
        """
        deps: list[str] = []
        seen: set[str] = set()
        for p in parts:
            if p.id not in seen:
                seen.add(p.id)
                deps.append(p.id)
        if self.strict:
            for g in self._guards:
                if g not in seen:
                    seen.add(g)
                    deps.append(g)
        node: Tainted[T] = Tainted(id=self._next_id(tag), value=value, deps=deps)
        self._nodes[node.id] = node
        return node

    def branch(self, guard: Tainted[Any], fn: Callable[[], T]) -> T:
        """STRICT 模式的分支：fn 里创建的所有值都额外依赖 guard。
        NORMAL 模式下这就是普通调用。
        """
        if not self.strict:
            return fn()
        self._guards.append(guard.id)
        try:
            return fn()
        finally:
            self._guards.pop()

    def sources_of(self, t: Tainted[Any]) -> list[Provenance]:
        """递归展开到所有根来源。"""
        seen: set[str] = set()
        out: list[Provenance] = []

        def walk(node_id: str) -> None:
            if node_id in seen:
                return
            seen.add(node_id)
            n = self._nodes.get(node_id)
            if n is None:
                return
            if n.own is not None:
                out.append(n.own)
            for d in n.deps:
                walk(d)

        walk(t.id)
        return out

    def tainted(self, t: Tainted[Any]) -> bool:
        """有没有任何一个根来源是不可信的。"""
        return any(not p.trusted for p in self.sources_of(t))

    def origins(self, t: Tainted[Any]) -> list[Origin]:
        """这个值实际用到的来源类别。"""
        return sorted({p.origin for p in self.sources_of(t)})

    def size(self) -> int:
        return len(self._nodes)


# ─────────────────────────────────────────────────────────────
# 二、能力契约：按**参数**授权，不按工具授权
# ─────────────────────────────────────────────────────────────

ArgRole = Literal["destination", "payload", "selector", "literal"]
"""参数的语义角色。

★ 这是这一节最重要的一个技术点，而它有明确的一手出处。

CaMeL 论文 §3.1 讲 Dual LLM 模式的残余风险时说：即使全局计划没被劫持，
"being able to **change the arguments to the tool calls** by prompt
injecting the Quarantined LLM can be a security issue: while the control
flow is protected by the Dual LLM pattern, **the data flow can still be
manipulated**"。然后给了那个决定性的类比：

  "This is analogous to an SQL injection attack in which an adversary
   manipulates the **query parameters** rather than the structure of
   the query itself."

PACT（arXiv 2605.11039）把它变成一句可以直接写进代码的设计原则：
间接注入 "becomes dangerous **not when untrusted content appears in
context, but when it determines an authority-bearing argument**"。

所以：验证 send_email 这个**工具**被允许调用，几乎没有价值。
要验证的是 to 这个**参数**的来源。

  destination —— 效果落在哪儿：收件人、URL、路径、仓库。攻击者最想要的。
  payload     —— 送出去的内容。可以来自不可信数据——但要看流向哪个 destination。
  selector    —— 读哪一条：id、查询词、文件名。可以来自不可信数据。
  literal     —— 必须是常量或来自可信配置。
"""


@dataclass(frozen=True)
class ArgContract:
    role: ArgRole
    # 允许的来源类别。空列表表示只接受字面量。
    allow: tuple[Origin, ...]
    # 是否允许依赖链里出现任何 trusted=False 的根。
    allow_untrusted: bool


@dataclass(frozen=True)
class ToolContract:
    name: str
    args: dict[str, ArgContract]
    # 不可逆：删除、支付、发布、合并、外发。这一位决定审批走哪条路。
    irreversible: bool
    # 结果会被组织外／可见性边界外的人看到。
    crosses_boundary: bool


@dataclass
class Violation:
    arg: str
    role: ArgRole
    reason: str
    # 把依赖链摊平，给人看的。
    chain: list[str]


@dataclass
class CallVerdict:
    allowed: bool
    violations: list[Violation]
    # 这次调用里，哪些参数是被不可信数据决定的。
    attacker_controlled: list[str]


def check_call(contract: ToolContract, args: dict[str, Tainted[Any]], flow: Flow) -> CallVerdict:
    """在调用点检查每一个参数的来源。

    ★ 写错的方式只有一种，但它是默认的那种：**只检查工具名**。
    §5 里每一个真实事故——GitHub MCP 的 toxic agent flow、EchoLeak、
    CamoLeak、ForcedLeak——在"工具是否被允许"这个问题上都是**合法的**。
    read_file 允许，post_comment 允许。出事的是参数。
    """
    violations: list[Violation] = []
    attacker_controlled: list[str] = []

    for name, t in args.items():
        c = contract.args.get(name)
        chain = [
            f"{p.origin}:{p.source}" + ("" if p.trusted else "(untrusted)")
            for p in flow.sources_of(t)
        ]
        if flow.tainted(t):
            attacker_controlled.append(name)

        if c is None:
            violations.append(
                Violation(
                    arg=name,
                    role="literal",
                    reason="契约里没有声明这个参数——未声明即拒绝，不是未声明即放行",
                    chain=chain,
                )
            )
            continue

        origins = flow.origins(t)
        bad = [o for o in origins if o not in c.allow]
        if bad:
            allowed = "/".join(c.allow) or "字面量"
            violations.append(
                Violation(
                    arg=name,
                    role=c.role,
                    reason=f"{c.role} 参数不接受来自 {'/'.join(bad)} 的值（只接受 {allowed}）",
                    chain=chain,
                )
            )
            continue
        if not c.allow_untrusted and flow.tainted(t):
            violations.append(
                Violation(
                    arg=name,
                    role=c.role,
                    reason=f"{c.role} 参数的依赖链里有不可信的根",
                    chain=chain,
                )
            )

    return CallVerdict(
        allowed=not violations, violations=violations, attacker_controlled=attacker_controlled
    )


CONTRACTS: dict[str, ToolContract] = {
    "read_issue": ToolContract(
        name="read_issue",
        irreversible=False,
        crosses_boundary=False,
        args={
            "repo": ArgContract("destination", ("user", "config"), False),
            "number": ArgContract("selector", ("user", "config", "tool"), True),
        },
    ),
    "read_file": ToolContract(
        name="read_file",
        irreversible=False,
        crosses_boundary=False,
        args={"path": ArgContract("destination", ("user", "config"), False)},
    ),
    "post_comment": ToolContract(
        name="post_comment",
        irreversible=True,
        crosses_boundary=True,
        args={
            "repo": ArgContract("destination", ("user", "config"), False),
            "number": ArgContract("selector", ("user", "config", "tool"), True),
            "body": ArgContract("payload", ("user", "config", "tool"), True),
        },
    ),
    "send_money": ToolContract(
        name="send_money",
        irreversible=True,
        crosses_boundary=True,
        # CaMeL 的 banking 策略就是这么写的：收款人和金额都必须以用户为源，
        # 且依赖图里不能有别的不可信父节点。这也是它拒绝率最高的一个域。
        args={
            "recipient": ArgContract("destination", ("user",), False),
            "amount": ArgContract("literal", ("user",), False),
        },
    ),
    "fetch_url": ToolContract(
        name="fetch_url",
        irreversible=False,
        crosses_boundary=True,
        args={"url": ArgContract("destination", ("user", "config"), False)},
    ),
}
"""一组够用的默认契约。注意 post_comment 的 body 允许不可信来源
——它本来就是要把读到的东西写出去——但 repo 不允许。
这正是 GitHub MCP 那个事故里被突破的那一格。
"""


# ─────────────────────────────────────────────────────────────
# 三、致命三要素与 Rule of Two
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SessionCaps:
    """会话在这三／四个维度上的能力。

    致命三要素（Simon Willison，2025-06-16 13:20）：
      - Access to your private data
      - Exposure to untrusted content
      - The ability to externally communicate in a way that could be
        used to steal your data

    Meta 的 Agents Rule of Two（2025-10-31）把第三条**放宽**了：
      [C] An agent can **change state** or communicate externally

    ★ 差别在这里，而它对编码 agent 恰恰是关键的：
    rm -rf、terraform destroy、合并一个 PR——纯粹的完整性/可用性破坏，
    零数据外流。这些**触发 Rule of Two，但不触发字面意义上的三要素**。
    """

    private_data: bool
    untrusted_content: bool
    external_comms: bool
    # Rule of Two 的 [C] 多出来的那一半。
    state_change: bool


@dataclass
class TrifectaVerdict:
    # Willison 的三要素是否全中。
    trifecta: bool
    # Rule of Two 是否被违反（三个属性全中）。
    rule_of_two_violated: bool
    legs: list[str]
    # 拿掉哪一条最便宜。
    cheapest_fix: str
    advice: str


def trifecta(caps: SessionCaps) -> TrifectaVerdict:
    legs: list[str] = []
    if caps.private_data:
        legs.append("私有数据")
    if caps.untrusted_content:
        legs.append("不可信内容")
    if caps.external_comms:
        legs.append("对外通信")
    if caps.state_change:
        legs.append("改变状态")

    three = caps.private_data and caps.untrusted_content and caps.external_comms
    # Rule of Two：[A] 不可信输入 [B] 敏感系统/私有数据 [C] 改状态或对外通信
    _c = caps.external_comms or caps.state_change
    violated = caps.untrusted_content and caps.private_data and _c

    # ★ 为什么"拿掉对外通信"总是最便宜的一条：另外两条通常是产品需求
    # ——agent 要读你的东西，也要读外面的东西。第三条往往是附带的。
    # 这也是十年来厂商实际做的事（Willison："usually by locking down
    # the exfiltration vector"）。
    cheapest_fix = "（没有需要拿掉的）"
    if violated:
        if caps.external_comms:
            cheapest_fix = "拿掉对外通信"
        elif caps.state_change:
            cheapest_fix = "把改状态的操作移到审批之后"
        else:
            cheapest_fix = "把不可信内容隔到另一个会话"

    return TrifectaVerdict(
        trifecta=three,
        rule_of_two_violated=violated,
        legs=legs,
        cheapest_fix=cheapest_fix,
        advice=(
            "Rule of Two 被违反：三条同时成立就不能自主运行，至少要有监督，或者开一个新的上下文窗口"
            if violated
            else "三条里最多占两条，可以自主运行"
        ),
    )


# ─────────────────────────────────────────────────────────────
# 四、通道：只有「移除」有记录，「过滤」全被绕过
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Channel:
    name: str
    kind: Literal["render", "network", "dns", "tool"]
    # 你对它做了什么。
    mitigation: Literal["none", "filter", "remove"]
    # ★ 你的执行点**看得见**它吗。
    enforceable: bool
    note: str = ""


@dataclass
class ChannelReport:
    # 真正关掉的。
    closed: list[str]
    # 只加了过滤——按历史记录，这一类全部被绕过过。
    filtered_only: list[str]
    # 你的执行点根本看不见的。
    blind: list[str]
    open: list[str]
    verdict: str


FILTER_RECORD: list[dict[str, str]] = [
    {
        "control": "重写外链（inline markdown）",
        "vendor": "M365 Copilot",
        "outcome": "bypassed",
        "how": "参考式 markdown `[t][ref]` 没被覆盖",
    },
    {
        "control": "CSP img-src 白名单",
        "vendor": "M365 Copilot",
        "outcome": "bypassed",
        "how": "`*.teams.microsoft.com` 上有一个开放代理",
    },
    {
        "control": "CSP 白名单（Trusted URL）",
        "vendor": "Salesforce Agentforce",
        "outcome": "bypassed",
        "how": "白名单里的域名过期了，5 美元重新注册",
    },
    {
        "control": "**签名**图片代理（Camo，HMAC）",
        "vendor": "GitHub Copilot Chat",
        "outcome": "bypassed",
        "how": "按字母表预先铸好一批合法签名 URL，一次请求泄一个字符",
    },
    {
        "control": "注入分类器（XPIA）",
        "vendor": "Microsoft",
        "outcome": "bypassed",
        "how": '第一人称措辞，从不提"Copilot"或 AI',
    },
    {
        "control": "**整个关掉图片渲染**",
        "vendor": "GitHub Copilot Chat",
        "outcome": "held",
        "how": "通道没了",
    },
    {
        "control": "**服务端维护的出站白名单**",
        "vendor": "Salesforce",
        "outcome": "held",
        "how": "即使 agent 完全被控也拦得住",
    },
    {
        "control": "**不带凭据浏览**（logged out mode）",
        "vendor": "OpenAI Atlas",
        "outcome": "held",
        "how": "拿掉的是 [B] 那条腿，不是防 [A]",
    },
]
"""历史记录：每一个"过滤"都被绕过了，每一个"移除"都守住了。
这张表本身就是这一节的论据。
"""


def audit_channels(channels: list[Channel]) -> ChannelReport:
    closed: list[str] = []
    filtered_only: list[str] = []
    blind: list[str] = []
    open_: list[str] = []

    for c in channels:
        if c.mitigation == "remove":
            closed.append(c.name)
            continue
        # ★ 顺序要紧：看不见的通道，加什么过滤都没意义。
        if not c.enforceable:
            blind.append(c.name)
            continue
        if c.mitigation == "filter":
            filtered_only.append(c.name)
        else:
            open_.append(c.name)

    leaks = len(open_) + len(blind) + len(filtered_only)
    verdict = (
        "所有通道都已移除"
        if leaks == 0
        else (
            f"还有 {leaks} 条通道可用：{len(blind)} 条你看不见、"
            f"{len(filtered_only)} 条只加了过滤（历史上这一类全被绕过）、"
            f"{len(open_)} 条完全敞着"
        )
    )
    return ChannelReport(
        closed=closed, filtered_only=filtered_only, blind=blind, open=open_, verdict=verdict
    )


# ─────────────────────────────────────────────────────────────
# 五、审批：一个可插拔的策略决策点
# ─────────────────────────────────────────────────────────────

Risk = Literal["low", "medium", "high", "critical"]


@dataclass(frozen=True)
class Action:
    tool: str
    # 渲染出来给人／给 reviewer 看的那一行。
    rendered: str
    irreversible: bool
    crosses_boundary: bool
    # 这次调用里被不可信数据决定的参数。
    attacker_controlled: tuple[str, ...] = ()
    # 改变监督机制本身（关沙箱、改权限、改 CI、给自己的 PR 批准）。
    alters_oversight: bool = False


@dataclass
class Decision:
    allow: bool
    reason: str
    by: Literal["circuit-breaker", "unresolved", "rule", "reviewer", "fail-closed"]
    risk: Risk


def make_flow(strict: bool = False) -> Flow:
    """工厂：和 l14/inject.py 的 TODO 表面保持一致，方便一套测试测两边。"""
    return Flow(strict)


def classify_risk(a: Action) -> Risk:
    """风险分级。Codex 的 reviewer policy 就是四档，且处置规则是写死的：
    "Low-risk and medium-risk actions can proceed when policy allows them.
     The policy **denies critical-risk** actions. **High-risk** actions
     require enough user authorization and no matching deny rule."

    ★ 主轴是**可逆性**，不是"危险程度"。OWASP LLM03:2026 给的例子最清楚：
    客服 agent 可以自动退成**店铺积分**（可恢复），而**对外付款**
    （不可逆）必须走人工。
    """
    # 改变监督机制本身：永远是 critical。三家厂商在这一条上完全一致。
    if a.alters_oversight:
        return "critical"
    # ★ 这一行是整个分级里唯一真正重要的一行：
    # 一个不可逆、跨边界的动作，**当它的参数被不可信数据决定时**才是 critical。
    # 参数干净的同一个动作只是 high——它需要授权，不是需要禁止。
    # 把这两件事合并成"post_comment 一律 critical"，就等于把这个工具废掉：
    # 那正是 AgentDojo 那个分类器付出的代价（可用性 69.07% → 41.24%）。
    if a.irreversible and a.crosses_boundary and a.attacker_controlled:
        return "critical"
    if a.irreversible:
        return "high"
    if a.crosses_boundary and a.attacker_controlled:
        return "high"
    if a.crosses_boundary:
        return "medium"
    return "low"


CRITICAL_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\brm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*r[a-zA-Z]*)\s+(-[a-zA-Z]+\s+)*(~|/|\$HOME)\s*(/\s*)?$"),
    re.compile(r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(~|/|\$HOME)(/\s|$|\s)"),
    re.compile(r"\brm(dir)?\s+.*\s(/|~)\s*$"),
    re.compile(r"\bRemove-Item\b[^|;]*\s(\*|.*[\\/]\*)\s*$"),
    re.compile(r"\bgit\s+push\s+.*--force\b.*\b(main|master)\b"),
    re.compile(r"\bterraform\s+destroy\b"),
    re.compile(r"\b(chmod|chown)\s+-R\s+.*\s/\s*$"),
    re.compile(r":\(\)\{.*\|.*&.*\};:"),
    # ★ 关掉监督机制本身的那几个开关，按厂商实际的 flag 名字写。
    # 这一条必须在**熔断器**里，不能只在 classify_risk 里：
    # classify_risk 需要有人先把 alters_oversight 标成 True，
    # 而这条命令是 agent 自己拼出来的一个字符串，没人会去标它。
    # 熔断器是唯一一个"谁都不能覆盖"的位置，所以它必须自己认得出来。
    re.compile(r"--dangerously-skip-permissions\b"),
    re.compile(r"--yolo\b"),
    re.compile(r"\bsandbox[_-]?mode\s*=\s*[\"']?danger", re.I),
    re.compile(r"\bapproval[_-]?policy\s*=\s*[\"']?never", re.I),
    re.compile(r"--allowedTools\s+[\"']?\*"),
]
"""熔断器：任何规则、任何钩子、任何 reviewer 都不能放行的一组操作。

Claude Code 对这件事的措辞值得一字不改地记住：
"Claude Code **never** lets a `permissions.allow` rule or a `PreToolUse`
 hook that returns `allow` approve an `rm` or `rmdir` command that targets
 a critical path, even in modes that skip other prompts.
 **This circuit breaker guards against model error.**"

★ 而它必须是**替换感知**的。同样是官方文档：
"Hiding the removal inside command substitution with `$(...)` or
 backticks, or process substitution with `<(...)`, doesn't skip the
 check... whether it sits inside the substitution, as in
 `echo "$(rm -rf ~)"`, or elsewhere in the same command."
"""

_SUBST_PATTERNS = [
    re.compile(r"\$\(([^()]*)\)"),
    re.compile(r"`([^`]*)`"),
    re.compile(r"<\(([^()]*)\)"),
    re.compile(r"\$\{([^{}]*)\}"),
]


def expand_substitutions(cmd: str) -> list[str]:
    """把 $(...)、反引号、<(...) 里的内容也摊出来检查。"""
    out = [cmd]
    frontier = [cmd]
    for _ in range(4):
        if not frontier:
            break
        nxt: list[str] = []
        for s in frontier:
            for pat in _SUBST_PATTERNS:
                for m in pat.finditer(s):
                    inner = m.group(1)
                    if inner and inner.strip():
                        out.append(inner)
                        nxt.append(inner)
        frontier = nxt
    return out


def circuit_breaker(rendered: str) -> Decision | None:
    for piece in expand_substitutions(rendered):
        for pat in CRITICAL_PATTERNS:
            if pat.search(piece.strip()):
                return Decision(
                    allow=False,
                    reason=f"熔断：命令里出现了不可放行的操作（{piece.strip()[:60]}）",
                    by="circuit-breaker",
                    risk="critical",
                )
    return None


_VAR_RE = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?")


@dataclass
class Resolution:
    resolved: str
    unresolved: list[str]
    substitutions: list[str]


def resolve_args(rendered: str, env: dict[str, str]) -> Resolution:
    """参数解析：不能解析出实际目标的命令，不批。

    Claude Code v2.1.205+ 的规则，原文：`rm -rf "$VAR"` 在 $VAR
    "isn't assigned anywhere in the conversation the classifier sees.
     The value came only from earlier command output, which the classifier
     never receives, so the classifier can't verify the deletion target."
    把解析后的字面路径写进命令，这个 block 就解除。
    """
    unresolved: list[str] = []

    def sub(m: re.Match[str]) -> str:
        name = m.group(1)
        hit = env.get(name)
        if hit is not None:
            return hit
        if name not in unresolved:
            unresolved.append(name)
        return m.group(0)

    resolved = _VAR_RE.sub(sub, rendered)
    # ★ 命令替换是另一半：`rm -rf $(echo ~)` 里没有任何未定义的变量，
    # 但目标同样是**静态解析不出来**的——它由另一条命令在运行时产生。
    # 熔断器抓的是"删除藏在替换里"（`echo "$(rm -rf ~)"`），
    # 这里抓的是反过来的那一半："目标从替换里出来"。
    substitutions = expand_substitutions(rendered)[1:]
    return Resolution(resolved=resolved, unresolved=unresolved, substitutions=substitutions)


@dataclass
class ReviewContext:
    """reviewer 能看到的上下文。★ 注意这里**没有** tool_results 这个字段。"""

    user_messages: list[str]
    # 应用自己加的注解，可信通道。对应 Claude Code 的 classifierContext。
    app_context: list[str]
    risk: Risk
    provenance_chain: list[str]


class Reviewer(Protocol):
    name: str

    async def review(self, a: Action, ctx: ReviewContext) -> Decision: ...


class AutoApprove:
    """永远放行。用来演示"没有审批"这个基线。"""

    name = "auto"

    async def review(self, a: Action, ctx: ReviewContext) -> Decision:
        return Decision(allow=True, reason="无条件放行", by="rule", risk=classify_risk(a))


class RuleBased:
    """按风险档位的确定性规则。这是 Codex 那张处置表。"""

    name = "rules"

    def __init__(self, authorized: set[str] | None = None) -> None:
        self.authorized = authorized or set()

    async def review(self, a: Action, ctx: ReviewContext) -> Decision:
        risk = classify_risk(a)
        if risk == "critical":
            return Decision(allow=False, reason="critical 一律拒绝", by="rule", risk=risk)
        if risk == "high":
            ok = a.tool in self.authorized
            return Decision(
                allow=ok,
                reason="high，但用户已授权这个工具" if ok else "high 且没有足够的用户授权",
                by="rule",
                risk=risk,
            )
        return Decision(allow=True, reason=f"{risk}，策略允许", by="rule", risk=risk)


class ModelReviewer:
    """模型 reviewer。构造函数刻意**不接收**工具结果——
    这就是 Claude Code 那句 "Tool results are stripped" 的代码形态。
    """

    name = "model"

    def __init__(self, judge: Callable[[Action, ReviewContext], Awaitable[bool]]) -> None:
        self.judge = judge

    async def review(self, a: Action, ctx: ReviewContext) -> Decision:
        risk = classify_risk(a)
        ok = await self.judge(a, ctx)
        return Decision(
            allow=ok,
            reason="模型 reviewer 放行" if ok else "模型 reviewer 拒绝",
            by="reviewer",
            risk=risk,
        )


@dataclass
class GatePolicy:
    # 写在**文件**里的 deny 规则。★ 不写在对话里。
    deny: list[str]
    # 已被用户显式授权的工具。
    authorized: list[str]
    # 环境里能解析出来的变量。
    env: dict[str, str]


class Gate:
    """策略决策点。顺序是故意的，每一步都能引到一条一手依据：

      1. 熔断器      —— 任何东西都不能覆盖（Claude Code）
      2. deny 规则   —— 来自**文件**，不来自对话（上下文压缩会把对话里
                        说过的边界弄丢，"a boundary can be lost if context
                        compaction removes the message that stated it"）
      3. 参数解析    —— 解析不出实际目标就不批（Claude Code v2.1.205+）
      4. reviewer    —— 人 / 规则 / 模型
      5. 出错        —— ★ fail closed（Codex："Prompt-build, review-session,
                        and parse failures fail closed."）

    ★ 第 5 条是 Claude Code 和 Codex 明确不一致的地方：Claude Code 的
    subagent review 在安全检查本身失败时**放行**，只在结果前面贴一句
    "unreviewed and should be treated as untrusted"。而人经常不读那句话。
    所以这里选 fail closed。
    """

    def __init__(self, reviewer: Reviewer, policy: GatePolicy) -> None:
        self.reviewer = reviewer
        self.policy = policy

    async def decide(self, a: Action) -> Decision:
        breaker = circuit_breaker(a.rendered)
        if breaker is not None:
            return breaker

        for d in self.policy.deny:
            if d in a.rendered or a.tool == d:
                return Decision(
                    allow=False,
                    reason=f"命中 deny 规则「{d}」（来自策略文件）",
                    by="rule",
                    risk=classify_risk(a),
                )

        risk = classify_risk(a)
        res = resolve_args(a.rendered, self.policy.env)
        if res.unresolved:
            names = "、".join("$" + v for v in res.unresolved)
            return Decision(
                allow=False,
                reason=f"解析不出 {names} 的实际值，无法确认这条命令作用在哪儿",
                by="unresolved",
                risk=risk,
            )
        if res.substitutions and risk in ("high", "critical"):
            return Decision(
                allow=False,
                reason=(
                    f"目标由命令替换产生（{res.substitutions[0][:40]}），"
                    f"{risk} 风险的动作不能在目标未知时放行"
                ),
                by="unresolved",
                risk=risk,
            )

        ctx = ReviewContext(
            user_messages=[],
            app_context=[],
            risk=risk,
            provenance_chain=list(a.attacker_controlled),
        )
        try:
            return await self.reviewer.review(a, ctx)
        except Exception as err:  # noqa: BLE001
            return Decision(
                allow=False,
                reason=f"reviewer 失败，fail closed：{err}",
                by="fail-closed",
                risk=risk,
            )


# ─────────────────────────────────────────────────────────────
# 六、rug pull：用内容绑定，不用定期扫描
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ToolDescriptor:
    name: str
    description: str
    input_schema: Any


def make_gate(reviewer: Reviewer, policy: GatePolicy) -> Gate:
    return Gate(reviewer, policy)


def tool_fingerprint(t: ToolDescriptor) -> str:
    """★ 三个字段都要进哈希。只哈希 description 会漏掉**改 schema** 的那一半
    ——而实测里 24.8% 的 server 改过 descriptor，只有 8.6% 改过 description。
    """
    canon = json.dumps(
        [t.name, t.description, t.input_schema],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class Pin:
    name: str
    fingerprint: str
    pinned_at: int


def pin_tools(tools: list[ToolDescriptor], at: int = 0) -> list[Pin]:
    return [Pin(name=t.name, fingerprint=tool_fingerprint(t), pinned_at=at) for t in tools]


@dataclass
class DriftReport:
    changed: list[str]
    added: list[str]
    removed: list[str]
    # 需要重新征求同意的。
    needs_reapproval: bool


def check_drift(pins: list[Pin], now: list[ToolDescriptor]) -> DriftReport:
    """每次 tools/list 都比一遍。

    ★ 为什么不用"定期重扫高漂移的 server"：实测数据说那个策略在
    top-5% 预算下只覆盖到**全部描述变更的约 10%**，因为
    "roughly half of all description changes land on **new arrivals**
     a history ranking cannot reach."
    论文自己给的控制就是 content-binding —— 哈希一动就重新校验。

    而 MCP 2026-07-28 把 ttlMs 和 cacheScope 变成了 tools/list 的**必填**
    字段，也就是说协议现在正式承认客户端会拿着一份可能过期的工具描述
    做事。rug pull 的窗口被写进了协议里。
    """
    by_name = {p.name: p for p in pins}
    seen: set[str] = set()
    changed: list[str] = []
    added: list[str] = []

    for t in now:
        seen.add(t.name)
        pin = by_name.get(t.name)
        if pin is None:
            added.append(t.name)
            continue
        if pin.fingerprint != tool_fingerprint(t):
            changed.append(t.name)

    removed = [p.name for p in pins if p.name not in seen]
    return DriftReport(
        changed=changed, added=added, removed=removed, needs_reapproval=bool(changed) or bool(added)
    )


# ─────────────────────────────────────────────────────────────
# 七、不可见字符：诚实地说，这不是注入防御
# ─────────────────────────────────────────────────────────────

INVISIBLE_RE = re.compile("[\u200b-\u200d\u2060\ufeff\ufe00-\ufe0f\U000e0000-\U000e007f]")
"""标签块 U+E0000–U+E007F、变体选择符 U+FE00–U+FE0F、零宽 U+200B/200C/200D/2060。

★ 这 15 行值得写，但**理由不是"能防注入"**。OWASP LLM01:2026 推荐在每一个
ingest 和 render 边界都做剥离，同时自己加了限定：
"Stripping does not stop visible-text payloads or future steganographic classes."

它真正的价值是关掉一条**双向**的隐蔽信道：既防止不可见指令进来，也防止
不可见数据出去。同时它让 OWASP 那条审批要求变得可能——
"Invisible character smuggling can make the displayed action differ from
 the executed one."
你显示给人看的那一行，必须和真正要执行的那一行是同一行。
"""


@dataclass
class StripResult:
    text: str
    removed: int
    codepoints: list[str]


def strip_invisible(s: str) -> StripResult:
    codepoints: list[str] = []

    def sub(m: re.Match[str]) -> str:
        codepoints.append("U+" + format(ord(m.group(0)), "04X"))
        return ""

    text = INVISIBLE_RE.sub(sub, s)
    return StripResult(text=text, removed=len(codepoints), codepoints=codepoints)


def display_matches_execution(displayed: str, executed: str) -> bool:
    """显示的和执行的是不是同一个字符串。"""
    same_visible = strip_invisible(displayed).text == strip_invisible(executed).text
    return same_visible and displayed == executed


# ─────────────────────────────────────────────────────────────
# 八、沙箱：厂商自己说它不是边界
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SandboxSpec:
    """一份沙箱配置。字段是照三家厂商实际的配置面抄的。

    ★ 先记住这句，它是 Claude Code 官方文档原文：
      "**Sandboxing reduces risk but is not a complete isolation boundary.**
       Review the limitations below before relying on it as a hard security
       control."

    以及 AWS 对容器的表态，同样是原文：
      "**AWS does not consider containers a security boundary**, and does
       not utilize containers to isolate customers from each other."
    2025-11-05 那三个 runc 逃逸里，有**两个影响所有已知版本**。

    所以沙箱是**爆炸半径缩减器**，不是信任边界。这不妨碍它是你能做的
    性价比最高的事之一——只是别把它当成那个能让你睡着觉的东西。

    scrubEnv —— ★ Claude Code 原文："There is no built-in credential deny
      list, so only the files and variables you list are restricted."
      而且 "sandboxed Bash commands inherit the parent process environment
      by default, including any credentials set there."
    covers   —— ★ Claude Code 的沙箱只隔离 Bash 子进程；Read/Edit/Write 走
      权限系统，Computer Use "runs on your actual desktop"。
    """

    allow_write: tuple[str, ...]
    deny_write: tuple[str, ...]
    allow_read: tuple[str, ...]
    deny_read: tuple[str, ...]
    # 出站域名白名单。
    allowed_domains: tuple[str, ...]
    # 白名单的**执行点开了没有**。
    #
    # ★ 这个字段看着多余，它恰恰是这一节最便宜的一次"配置对了但没生效"。
    # Codex 官方文档，原文："Adding domain rules **does not enable** the
    # [proxy]." 完整真值表是：
    #
    #   网络关 + 代理开   → 网络还是关的，这个开关什么也没做
    #   网络开 + 代理关   → "network stays on with **unrestricted direct**"
    #   网络开 + 代理开   → 才真的受限
    #
    # 也就是说：你可以写一份语法完全正确、审计也能通过的白名单，
    # 而它一条都不拦。而这件事**不会有任何报错**——请求正常发出、
    # 正常返回，只是没走那个代理。
    proxy_enabled: bool
    scrub_env: tuple[str, ...]
    covers: tuple[str, ...]
    # 代理是否终止 TLS。不终止就挡不住 domain fronting。
    tls_terminate: bool
    # 沙箱是不是同时也是唯一的 DNS 解析器。
    owns_resolver: bool
    # 允许 agent 请求退出沙箱重跑（Claude Code 的 dangerouslyDisableSandbox）。
    allow_unsandboxed_retry: bool


@dataclass
class PathVerdict:
    allow: bool
    # 命中的那条规则。最长匹配优先。
    rule: str


def _match(pattern: str, path: str) -> int:
    """返回具体度（越大越具体），-1 表示不匹配。"""
    if "**" in pattern:
        rx = "^" + ".*".join(re.escape(part) for part in pattern.split("**")) + "$"
        return len(pattern.replace("*", "")) if re.match(rx, path) else -1
    prefix = pattern if pattern.endswith("/") else pattern + "/"
    if path == pattern or path.startswith(prefix):
        return len(pattern)
    return -1


def path_verdict(spec: SandboxSpec, path: str, mode: Literal["read", "write"]) -> PathVerdict:
    """路径判定：**最具体的规则赢**。

    这条语义是有意设计的，Claude Code 的文档给了三行表来说明它：
      deny_read=["~/"] + allow_read=["~/projects"]  → 只有 ~/projects 可读
      allow_read=["~/"] + deny_read=["~/.env"]      → ~/.env 挡住，其余可读
                                                      "a broad allow can't
                                                       silently re-expose a secret"
      allow_read=["~/"] + deny_read=["~/**/.env"]   → 通配的 deny 在更宽的
                                                      allow 里依然成立

    ★ 如果你写成"先看 allow 再看 deny"或者反过来，上面第二行就会错，
    而它不会报错——它只会让 ~/.env 可读。
    """
    allows = spec.allow_read if mode == "read" else spec.allow_write
    denies = spec.deny_read if mode == "read" else spec.deny_write

    best_allow, best_rule, best_score = False, "（无匹配规则，默认拒绝）", -1
    for p in allows:
        s = _match(p, path)
        if s > best_score:
            best_allow, best_rule, best_score = True, f"allow {p}", s
    for p in denies:
        s = _match(p, path)
        # ★ 同样具体时 deny 赢。Cursor 说得最直白："deny always beats allow"。
        if s >= best_score and s >= 0:
            best_allow, best_rule, best_score = False, f"deny {p}", s
    return PathVerdict(allow=best_allow, rule=best_rule)


@dataclass
class EgressVerdict:
    allow: bool
    reason: str
    # 就算 allow=False，这些理由说明它仍然可能出得去。
    caveats: list[str]


OVERBROAD_DOMAINS = ("github.com", "githubusercontent.com", "gist.github.com", "s3.amazonaws.com")
"""已知会把整条白名单变成摆设的域名。"""


def egress_verdict(spec: SandboxSpec, host: str) -> EgressVerdict:
    # ★ 这一步必须在最前面。执行点没开的时候，白名单的内容**完全不影响结果**——
    # 每个 host 都出得去。把它写在"命中白名单吗"之后，你会得到一个
    # 语义上完全错误但看起来很合理的 allow=False。
    if not spec.proxy_enabled:
        return EgressVerdict(
            allow=True,
            reason="★ 代理没开：白名单一条都没生效，这个 host 直连出去了",
            caveats=[
                f"白名单里写了 {len(spec.allowed_domains)} 条，但 Codex 官方原文是 "
                '"Adding domain rules does not enable the [proxy]"'
                '——网络开 + 代理关 = "unrestricted direct"',
            ],
        )
    hit = next(
        (
            d
            for d in spec.allowed_domains
            if (host.endswith(d[1:]) if d.startswith("*.") else host == d)
        ),
        None,
    )
    caveats: list[str] = []
    if not spec.tls_terminate:
        caveats.append(
            "代理不终止 TLS，按客户端给的 hostname 判定"
            "——domain fronting 可绕过（Claude Code 官方限制）"
        )
    if not spec.owns_resolver:
        caveats.append(
            "沙箱不是唯一解析器：数据可以编码进子域名标签，"
            "DNS 帮你把它送出去，白名单看不到任何 HTTP 请求"
        )
    for d in spec.allowed_domains:
        bare = d[2:] if d.startswith("*.") else d
        if bare in OVERBROAD_DOMAINS:
            caveats.append(
                f"白名单里的 {d} 托管任意攻击者可写内容（gist / issue / PR），等价于放开"
            )
    return EgressVerdict(
        allow=hit is not None,
        reason=f"命中白名单 {hit}" if hit else "不在白名单里",
        caveats=caveats,
    )


_SECRETISH = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|_PAT$", re.IGNORECASE)
_STARTUP = re.compile(r"\.(bashrc|zshrc|profile)|/bin|PATH")
_AGENT_DIR = re.compile(r"\.claude|\.codex|\.cursor|\.agents")


def sandbox_gaps(spec: SandboxSpec, env: dict[str, str]) -> list[str]:
    """沙箱漏掉的那些东西。

    ★ 这张清单上**每一条都是某个在售产品里被记录在案的缺口**，
    不是我想出来的。它比沙箱本身更值得读一遍。
    """
    gaps: list[str] = []

    leaked = [k for k in env if _SECRETISH.search(k) and k not in spec.scrub_env]
    if leaked:
        gaps.append(
            f"环境变量：{'、'.join(leaked)} 会被子进程继承"
            "（没有内置的默认拒绝清单，你不列就在里面）"
        )
    if "read_file" not in spec.covers or "write_file" not in spec.covers:
        gaps.append(
            "非 Bash 工具：Read/Edit/Write 走权限系统而不是沙箱，路径规则对它们不生效"
        )
    # ★ 排在 DNS 和 domain fronting 前面：那两条是"白名单能被绕过"，
    # 这一条是"白名单根本没接上"。后者让前两条都变成无关紧要的细节。
    if not spec.proxy_enabled and spec.allowed_domains:
        gaps.append(
            f"出站白名单写了 {len(spec.allowed_domains)} 条但代理没开——一条都不生效"
            '（Codex 官方："Adding domain rules does not enable the [proxy]"）'
        )
    if not spec.owns_resolver:
        gaps.append("DNS：一条零 HTTP 也能用的外发通道")
    if not spec.tls_terminate:
        gaps.append("domain fronting：SNI 白名单可绕过")
    if spec.allow_unsandboxed_retry:
        gaps.append(
            "沙箱可被请求关闭：违规会连同被拒的路径/主机一起回给模型，"
            "模型可以带着 dangerouslyDisableSandbox 重试"
        )
    if any(".git" in p for p in spec.allow_write) and not any(".git" in d for d in spec.deny_write):
        gaps.append(".git/hooks：pre-commit 是一次由后续无害命令触发的任意代码执行")
    if not any(_STARTUP.search(p) for p in spec.deny_write):
        gaps.append("shell 启动文件与 $PATH 目录：写进去就是下一次运行时的提权")
    if not any("docker.sock" in p or "/var/run" in p for p in spec.deny_read):
        gaps.append(
            "Unix socket：/var/run/docker.sock 等于宿主机 root；SSH agent、kubelet 同理"
        )
    if not any(_AGENT_DIR.search(p) for p in spec.deny_write):
        gaps.append("agent 自己的配置目录：写进去就是给自己改下一次的权限")
    gaps.append(
        "MCP 连接、连接器工具、内置 web search、云端任务：代理一律看不见（OpenAI 自己的文档）"
    )
    return gaps


# ─────────────────────────────────────────────────────────────
# 九、两轴指标：安全和可用性必须一起报
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SuiteCase:
    name: str
    kind: Literal["attack", "benign"]
    # attack：是否被挡住。benign：是否仍然完成。
    passed: bool


@dataclass
class TwoAxis:
    # 攻击成功率。分母是攻击用例数。
    asr: float
    # 良性任务完成率。
    utility: float
    attacks: int
    benign: int
    # 相对无防御基线的可用性损失（百分点）。
    utility_delta: float
    verdict: str


def two_axis(cases: list[SuiteCase], baseline_utility: float = 1.0) -> TwoAxis:
    """★ 只报一个数字是这个领域最常见的错误报告方式。

    AgentDojo 官方结果页上那一行是最好的反面教材：
    transformers_pi_detector 把定向 ASR 从 47.69% 压到 **7.95%**——
    听起来很成功。同一行里，良性可用性从 **69.07% 掉到 41.24%**。
    论文作者自己的话："The prompt injection detector has too many false
    positives, however, and significantly degrades utility."

    掉了 27.8 个百分点，相对损失 40%。那不是一个防御，
    那是决定发布一个更差的产品。
    """
    attacks = [c for c in cases if c.kind == "attack"]
    benign = [c for c in cases if c.kind == "benign"]
    blocked = sum(1 for c in attacks if c.passed)
    completed = sum(1 for c in benign if c.passed)

    asr = (len(attacks) - blocked) / len(attacks) if attacks else 0.0
    utility = completed / len(benign) if benign else 0.0
    utility_delta = (utility - baseline_utility) * 100

    # ★ 三档，而分界线 −15 个百分点不是拍脑袋的：
    #   CaMeL 的代价是 77% vs 84% 无防御 = −7 pp，产品还在
    #   AgentDojo 那个注入分类器是 69.07% → 41.24% = −27.8 pp，产品没了
    # 把这两件事叫同一个名字，是这个领域最常见的混淆。
    # `or 0.0` 是为了把 -0.0 归一成 0.0——Python 会把它印成 "-0.0"，JS 不会。
    cost = -utility_delta or 0.0
    if not attacks or not benign:
        verdict = "★ 两轴缺一轴：只测攻击或只测良性，得到的数字没有意义"
    elif asr == 0 and cost <= 15:
        verdict = f"安全轴归零，代价 {cost:.1f} 个百分点——架构型防御的形状（CaMeL 是 −7）"
    elif asr == 0:
        verdict = (
            f"★ 安全轴归零，但可用性掉了 {cost:.1f} 个百分点"
            "——分类器的形状（AgentDojo 那行是 −27.8）"
        )
    elif cost <= 5:
        verdict = f"可用性没掉，但还有 {asr * 100:.1f}% 的攻击打穿"
    else:
        verdict = f"★ 两轴都差：ASR {asr * 100:.1f}%，可用性还掉了 {cost:.1f} 个百分点"

    return TwoAxis(
        asr=asr,
        utility=utility,
        attacks=len(attacks),
        benign=len(benign),
        utility_delta=utility_delta,
        verdict=verdict,
    )


@dataclass(frozen=True)
class AsrClaim:
    """报一个 ASR 数字时必须同时给出的六项。少一项，这个数字就不可比。

    最刺眼的两个例子：
      - LLMail-Inject 被到处引用的是 0.8% / 0.3%——那是**每次提交**的成功率。
        同一篇论文里，**每支队伍**在四种防御全开时的成功率是 **16.6%**，
        且 60% 的队伍平均 89 次尝试就打穿了 Prompt Shield。
      - claude-3-5-sonnet-20240620 的 ASR 是 33.86%，
        claude-3-5-sonnet-20241022 是 1.11%。同一个模型名，差 30 倍。
    """

    asr: float
    denominator: Literal["attempt", "adversary"]
    adaptive: bool
    model_snapshot: str
    benchmark_version: str
    benign_utility: float | None


_DATED_RE = re.compile(r"\d{8}|\d{4}-\d{2}-\d{2}")


def claim_is_comparable(c: AsrClaim) -> tuple[bool, list[str]]:
    missing: list[str] = []
    if c.denominator != "adversary":
        missing.append("分母应当是「每个对手」而不是「每次尝试」")
    if not c.adaptive:
        missing.append("攻击方没有自适应——静态基准上的低 ASR 不构成安全性质")
    if not _DATED_RE.search(c.model_snapshot):
        missing.append("模型快照没有日期")
    if not c.benchmark_version:
        missing.append("没有基准版本号")
    if c.benign_utility is None:
        missing.append("没有同时报良性可用性")
    return (not missing), missing
