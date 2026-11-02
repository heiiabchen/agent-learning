"""验证 l14/inject.py。跑法：uv run python -m l14.verify
先跑 GUARD_IMPL=shared uv run python -m l14.verify 确认测试本身是对的。

一次模型都不调。★ 这不是省事——是这一节的核心论点：
**做授权判断的那段代码，绝不能读那段不可信的数据。**
一个需要调模型才能判的门，就是一个能被那段数据说服的门。

带 ★ 的每一条对应一种"看起来防住了但没有"：
检查工具名而不是参数、把 payload 和 destination 当成一回事、
漏掉一次 combine、先判过滤再判可见性、reviewer 出错时放行、
熔断器不展开命令替换、只哈希 description、只报一个轴。

它们的共同点和 L13 一样：**全都不抛异常，而且日志上是绿的。**
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import Callable
from typing import Any

from shared import guard as shared
from shared.guard import CONTRACTS, Action, Channel, Provenance, SandboxSpec, SessionCaps, SuiteCase

TARGET = "shared" if os.environ.get("GUARD_IMPL") == "shared" else "mine"
if TARGET == "shared":
    M: Any = shared
else:
    from l14 import inject as M  # type: ignore[no-redef]

print("\n（测的是 shared/ 里的参考实现）" if TARGET == "shared" else "\n（测的是 l14/ 里你的实现）")

passed = 0
failures: list[str] = []


def test(name: str, fn: Callable[[], Any]) -> None:
    global passed
    try:
        r = fn()
        if asyncio.iscoroutine(r):
            asyncio.run(r)
        passed += 1
        print(f"\x1b[32m  ✓ {name}\x1b[0m")
    except Exception as err:  # noqa: BLE001
        failures.append(name)
        print(f"\x1b[31m  ✕ {name}\x1b[0m")
        for line in str(err).split("\n"):
            print(f"\x1b[31m      {line}\x1b[0m")


def eq(a: Any, b: Any, msg: str = "") -> None:
    dump = lambda v: json.dumps(v, ensure_ascii=False, default=str)  # noqa: E731
    x, y = dump(a), dump(b)
    if x != y:
        raise AssertionError(f"{msg}\n  期望 {y}\n  实际 {x}")


def ok(c: bool, msg: str = "") -> None:
    if not c:
        raise AssertionError(msg)


def near(a: float, b: float, tol: float = 1e-9, msg: str = "") -> None:
    if abs(a - b) > tol:
        raise AssertionError(f"{msg}\n  期望 ≈{b}\n  实际 {a}")


USER = Provenance("user", "cli", True)
CONFIG = Provenance("config", "settings.json", True)
WEB = Provenance("tool", "fetch_url", False)

# ─────────────────────────────────────────────────────────
print("\n一、来源标记（provenance）")


def _t1() -> None:
    f = M.make_flow()
    ok(not f.tainted(f.fresh(1, USER)))
    ok(not f.tainted(f.fresh(1, CONFIG)))
    ok(f.tainted(f.fresh(1, WEB)))


test("user 和 config 是可信的，tool 不是", _t1)


def _t2() -> None:
    f = M.make_flow()
    a, b = f.fresh("a", USER), f.fresh("b", WEB)
    eq(sorted(f.origins(f.combine("ab", [a, b]))), ["tool", "user"])


test("派生值继承所有上游来源", _t2)


def _t3() -> None:
    f = M.make_flow()
    t = f.combine("x", [f.fresh(1, USER), f.fresh(2, WEB)])
    for i in range(6):
        t = f.combine(f"step{i}", [t])
    ok(f.tainted(t), "中间过一遍摘要、翻译、格式化，不会让它变干净——只是让你看不出来")


test("★ 一条不可信来源就足以污染整个下游，无论链有多长", _t3)


def _t4() -> None:
    f = M.make_flow()
    clean, dirty = f.fresh("模板", USER), f.fresh("网页正文", WEB)
    ok(not f.tainted(f.combine("拼好的", [clean])), "这就是漏写的样子：不报错，只是结果变干净了")
    ok(f.tainted(f.combine("拼好的", [clean, dirty])))


test("★ 漏掉一个 combine 的上游，污染就悄悄消失了", _t4)


def _t5() -> None:
    f = M.make_flow()
    a = f.fresh("1", WEB)
    b = f.fresh("2", Provenance("tool", "read_issue", False))
    got = sorted(p.source for p in f.sources_of(f.combine("both", [a, b])))
    eq(got, ["fetch_url", "read_issue"])


test("多条不可信来源要各自留痕，不能合并成一条", _t5)


def _t6() -> None:
    f = M.make_flow()
    a = f.fresh("1", WEB)
    eq(len(f.sources_of(f.combine("x", [a, a, a]))), 1)


test("sources_of 去重：同一个来源用两次只算一次", _t6)


def _t7() -> None:
    f = M.make_flow(True)
    g = f.fresh(True, WEB)
    out = f.branch(g, lambda: f.fresh("分支里造出来的", USER))
    ok(f.tainted(out), "控制流也是数据流——这是一条一 bit 的侧信道，CaMeL 默认关掉它")


test("★ 严格模式：拿不可信值做条件判断，也算污染了结果", _t7)


def _t8() -> None:
    f = M.make_flow(False)
    g = f.fresh(True, WEB)
    ok(not f.tainted(f.branch(g, lambda: f.fresh("x", USER))))


test("非严格模式下同一个分支不污染（这是个有意的取舍）", _t8)


def _t9() -> None:
    f = M.make_flow()
    t = f.fresh("a", USER)
    for _ in range(5):
        t = f.combine("x", [t, f.fresh("b", CONFIG)])
    ok(not f.tainted(t), "要是这条挂了，你的门会把所有正常调用都拦掉")


test("干净的值经过任意多次 combine 仍然干净", _t9)

# ─────────────────────────────────────────────────────────
print("\n二、能力契约：★ 判的是参数，不是工具名")


def _c1() -> None:
    f = M.make_flow()
    v = M.check_call(
        CONTRACTS["post_comment"],
        {
            "repo": f.fresh("attacker/dropbox", WEB),
            "number": f.fresh("1", USER),
            "body": f.fresh("x", USER),
        },
        f,
    )
    ok(not v.allowed)
    eq([x.arg for x in v.violations], ["repo"])


test("destination 参数不接受不可信来源", _c1)


def _c2() -> None:
    f = M.make_flow()
    v = M.check_call(
        CONTRACTS["post_comment"],
        {
            "repo": f.fresh("acme/app", USER),
            "number": f.fresh("7", USER),
            "body": f.fresh("从 issue 正文摘出来的一段", WEB),
        },
        f,
    )
    ok(v.allowed, "把 body 也拦掉，就等于废掉这个工具——这是分类器付的那 27.8 个百分点")


test("★ payload 参数**接受**不可信来源——这才是它存在的意义", _c2)


def _c3() -> None:
    f = M.make_flow()
    dirty, clean = f.fresh("x", WEB), f.fresh("acme/app", USER)
    bad = {"repo": dirty, "number": clean, "body": clean}
    good = {"repo": clean, "number": clean, "body": dirty}
    ok(not M.check_call(CONTRACTS["post_comment"], bad, f).allowed)
    ok(M.check_call(CONTRACTS["post_comment"], good, f).allowed)


test("★ 同一个工具、同一次调用，repo 脏就拦、body 脏就放", _c3)


def _c4() -> None:
    f = M.make_flow()
    v = M.check_call(
        CONTRACTS["post_comment"],
        {
            "repo": f.fresh("acme/app", USER),
            "number": f.fresh("7", USER),
            "body": f.fresh("x", USER),
            "bcc": f.fresh("attacker@evil.com", USER),
        },
        f,
    )
    ok(not v.allowed, "★ rug pull 加出来的新字段就是从这儿进来的，来源还是干净的")
    eq([x.arg for x in v.violations], ["bcc"])


test("契约里没写的参数一律拒绝（默认拒绝，不是默认放行）", _c4)


def _c5() -> None:
    f = M.make_flow()
    bad = {"recipient": f.fresh("acct-x", CONFIG), "amount": f.fresh("100", USER)}
    ok(
        not M.check_call(CONTRACTS["send_money"], bad, f).allowed,
        '"可信"不是一个档位。这个参数要的是「这一笔是这个人此刻要求的」',
    )


test("★ send_money 的收款人只接受 user——连 config 都不行", _c5)


def _c6() -> None:
    f = M.make_flow()
    good = {"recipient": f.fresh("acct-self", USER), "amount": f.fresh("100", USER)}
    ok(M.check_call(CONTRACTS["send_money"], good, f).allowed)


test("send_money 的收款人和金额都以用户为源时放行", _c6)


def _c7() -> None:
    # GitHub MCP 那次事故：read_issue / read_file / post_comment 都在白名单上。
    f = M.make_flow()
    issue = f.fresh("issue 正文（含注入）", Provenance("tool", "read_issue", False))
    path = f.combine("/home/me/.ssh/id_rsa", [issue])
    bad = M.check_call(CONTRACTS["read_file"], {"path": path}, f)
    ok(not bad.allowed, "按工具名授权时这一步是绿的；按参数来源授权才拦得住")
    eq(bad.violations[0].role, "destination")


test("★ 三个工具全都通过了「工具名授权」，攻击照样成立", _c7)


def _c8() -> None:
    f = M.make_flow()
    v = M.check_call(CONTRACTS["fetch_url"], {"url": f.fresh("http://evil.com", WEB)}, f)
    ok(not v.allowed)
    ok(len(v.violations[0].arg) > 0 and len(v.violations[0].reason) > 0)


test("violations 要说清是哪个参数、什么角色、为什么", _c8)

# ─────────────────────────────────────────────────────────
print("\n三、致命三要素 / Rule of Two")


def caps(p: bool, u: bool, e: bool, s: bool = False) -> SessionCaps:
    return SessionCaps(private_data=p, untrusted_content=u, external_comms=e, state_change=s)


test("三条全占：致命三要素成立", lambda: ok(M.trifecta(caps(True, True, True)).trifecta))


def _r2() -> None:
    ok(not M.trifecta(caps(True, True, False)).trifecta)
    ok(not M.trifecta(caps(True, False, True)).trifecta)
    ok(not M.trifecta(caps(False, True, True)).trifecta)


test("少任意一条：致命三要素不成立", _r2)


def _r3() -> None:
    # Meta 的 [C] 包含"改变状态"，Willison 的第三条只有"对外通信"。
    v = M.trifecta(caps(True, True, False, True))
    ok(not v.trifecta, "Willison 的三条没占满")
    ok(v.rule_of_two_violated, '但 Meta 的 [C] 把"改变状态"也算进去了')


test("★ 有一格里三要素不成立，但 Rule of Two 已经被违反", _r3)

test("legs 要报出到底占了哪几条", lambda: eq(len(M.trifecta(caps(True, True, False)).legs), 2))
test(
    "cheapest_fix 指向最容易拿掉的那一条",
    lambda: ok(len(M.trifecta(caps(True, True, True)).cheapest_fix) > 0),
)


def _r6() -> None:
    v = M.trifecta(caps(False, False, False))
    ok(not v.rule_of_two_violated and not v.trifecta)


test("一条都不占：通过，且不给修改建议", _r6)

# ─────────────────────────────────────────────────────────
print("\n四、外发通道：★ 看不见的通道 ≠ 加了过滤的通道")


def ch(name: str, mitigation: str, enforceable: bool) -> Channel:
    return Channel(name, "network", mitigation, enforceable)  # type: ignore[arg-type]


test(
    "移除掉的通道算守住了",
    lambda: eq(M.audit_channels([ch("图片渲染", "remove", True)]).closed, ["图片渲染"]),
)


def _h2() -> None:
    r = M.audit_channels([ch("出站 HTTP", "filter", True)])
    eq(r.filtered_only, ["出站 HTTP"])
    eq(r.closed, [])


test("只加了过滤的通道单独一类，不算守住", _h2)


def _h3() -> None:
    # 一条你看不见的通道上"加了过滤"，是过滤配置写在那儿、执行点根本没在路径上。
    r = M.audit_channels([ch("MCP 连接", "filter", False)])
    eq(r.blind, ["MCP 连接"], '先判 filter 就会把它错报成"已过滤"——这是最容易写错的一行')
    eq(r.filtered_only, [])


test("★ 顺序：看不见要在过滤之前判", _h3)

test("完全没管的通道进 open", lambda: eq(M.audit_channels([ch("DNS", "none", True)]).open, ["DNS"]))


def _h5() -> None:
    r = M.audit_channels([
        ch("a", "remove", True),
        ch("b", "filter", True),
        ch("c", "filter", False),
        ch("d", "none", True),
    ])
    eq(len(r.closed) + len(r.filtered_only) + len(r.blind) + len(r.open), 4)


test("四类互斥，加起来等于总数", _h5)


def _h6() -> None:
    r = M.audit_channels([ch("a", "remove", True), ch("b", "filter", True), ch("c", "none", True)])
    ok("2" in r.verdict, "剩 2 条：filter 那条历史上全被绕过，none 那条根本没管")


test("verdict 里要出现还剩几条可用通道", _h6)


def _h7() -> None:
    r = M.audit_channels([ch("a", "remove", True), ch("b", "remove", True)])
    ok("还有" not in r.verdict or "0" in r.verdict)


test("全部移除时 verdict 不该说还有可用通道", _h7)


def _h8() -> None:
    bypassed = [r for r in shared.FILTER_RECORD if r["outcome"] == "bypassed"]
    held = [r for r in shared.FILTER_RECORD if r["outcome"] == "held"]
    ok(len(bypassed) >= 5 and len(held) >= 3)
    ok(
        any("HMAC" in r["control"] or "Camo" in r["control"] for r in bypassed),
        "连 HMAC 签名的图片代理都被绕过了",
    )
    ok(any("关掉" in r["control"] for r in held), "GitHub 最后的修法是把图片渲染整个关掉")
    ok(
        all(any(k in r["control"] for k in ("关掉", "白名单", "不带凭据")) for r in held),
        "守住的三条全是「拿掉能力」，不是「看懂内容」",
    )


test("★ 历史记录：过滤类全被绕过，移除类全守住", _h8)

# ─────────────────────────────────────────────────────────
print("\n五、熔断器：★ 要展开命令替换")

test("明面上的 rm -rf / 要拦住", lambda: ok(M.circuit_breaker("rm -rf /") is not None))
test("rm -rf ~ 要拦住", lambda: ok(M.circuit_breaker("rm -rf ~") is not None))
test(
    "★ 藏在 $() 里的要拦住",
    lambda: ok(
        M.circuit_breaker('echo "$(rm -rf ~)"') is not None,
        "不展开的实现看到的是一条 echo",
    ),
)
test("★ 藏在反引号里的要拦住", lambda: ok(M.circuit_breaker("echo `rm -rf /`") is not None))
test("★ 藏在进程替换 <() 里的要拦住", lambda: ok(M.circuit_breaker("cat <(rm -rf /)") is not None))
test(
    "嵌套两层替换也要拦住",
    lambda: ok(M.circuit_breaker('echo "$(echo "$(rm -rf /)")"') is not None),
)
test(
    "git push --force 要拦住",
    lambda: ok(M.circuit_breaker("git push --force origin main") is not None),
)
test(
    "绕过审批的开关要拦住",
    lambda: ok(M.circuit_breaker("claude --dangerously-skip-permissions") is not None),
)


def _b9() -> None:
    for c in ["npm run build", "git status", "ls -la", "rm -rf ./node_modules", 'echo "$(date)"']:
        ok(M.circuit_breaker(c) is None, f"误伤了：{c}")


test("正常命令不要误伤", _b9)


def _b10() -> None:
    r = M.circuit_breaker("rm -rf /")
    ok(r is not None and r.by == "circuit-breaker" and r.risk == "critical" and len(r.reason) > 0)


test("tripped 时要说清命中了哪一条", _b10)

# ─────────────────────────────────────────────────────────
print("\n六、审批门（PDP）")


def act(**kw: Any) -> Action:
    base = {
        "tool": "bash",
        "rendered": "echo hi",
        "irreversible": False,
        "crosses_boundary": False,
        "attacker_controlled": (),
        "alters_oversight": False,
    }
    return Action(**{**base, **kw})  # type: ignore[arg-type]


POL = shared.GatePolicy(
    deny=("git push --force",),
    authorized=("post_comment",),
    env={"HOME": "/home/me"},
)


async def _g1() -> None:
    d = await M.make_gate(shared.AutoApprove(), POL).decide(act())
    ok(d.allow)


test("low 风险动作直接放行", _g1)

test(
    "改变监督机制的动作永远是 critical",
    lambda: eq(shared.classify_risk(act(alters_oversight=True)), "critical"),
)
test(
    "★ 不可逆 + 跨边界，但参数干净 → high（要授权，不是要禁止）",
    lambda: eq(shared.classify_risk(act(irreversible=True, crosses_boundary=True)), "high"),
)


def _g4() -> None:
    a = act(irreversible=True, crosses_boundary=True, attacker_controlled=("to",))
    eq(
        shared.classify_risk(a),
        "critical",
        '一个 bit 的差别。合并成"一律 critical"就废掉了这个工具',
    )


test("★ 同一个动作，参数被污染 → critical", _g4)

test(
    "可逆的跨边界动作是 medium（OWASP 的店铺积分那一格）",
    lambda: eq(shared.classify_risk(act(crosses_boundary=True)), "medium"),
)


async def _g6() -> None:
    gate = M.make_gate(shared.AutoApprove(), POL)
    d = await gate.decide(act(rendered="git push --force origin main"))
    ok(not d.allow, "★ 策略住在文件里，不住在对话里——上下文压缩不该能把它弄丢")


test("deny 规则优先于任何 reviewer 的意见", _g6)


async def _g7() -> None:
    gate = M.make_gate(shared.AutoApprove(), shared.GatePolicy(deny=(), authorized=(), env={}))
    d = await gate.decide(act(rendered="rm -rf /"))
    ok(not d.allow)


test("熔断器在最前面，deny 规则都排在它后面", _g7)


async def _g8() -> None:
    gate = M.make_gate(shared.AutoApprove(), POL)
    d = await gate.decide(act(rendered='rm -rf "$TARGET"', irreversible=True))
    ok(not d.allow, "你给人看的那一行必须和真要执行的那一行是同一行")


test("★ 解析不出的变量 → 拒绝，不能拿着 $TARGET 去问人", _g8)


async def _g9() -> None:
    gate = M.make_gate(shared.AutoApprove(), POL)
    ok((await gate.decide(act(rendered='ls "$HOME"'))).allow)


test("能解析出来的变量就放过（$HOME 在策略的 env 里）", _g9)


async def _g10() -> None:
    gate = M.make_gate(shared.AutoApprove(), POL)
    d = await gate.decide(act(rendered="rm -rf `echo ~`", irreversible=True))
    ok(not d.allow, "替换没有藏删除动作，它藏的是删除**目标**——反方向的同一条规则")


test("★ 高风险动作的目标由命令替换产生 → 拒绝", _g10)


async def _g11() -> None:
    gate = M.make_gate(shared.RuleBased({"post_comment"}), POL)
    d = await gate.decide(act(tool="post_comment", rendered="post_comment(...)", irreversible=True))
    ok(d.allow)


test("RuleBased：授权过的工具在 high 上放行", _g11)


async def _g12() -> None:
    gate = M.make_gate(shared.RuleBased({"post_comment"}), POL)
    d = await gate.decide(act(tool="payout", rendered="payout(...)", irreversible=True))
    ok(not d.allow)


test("RuleBased：没授权的工具在 high 上拒绝", _g12)


async def _g13() -> None:
    gate = M.make_gate(shared.RuleBased({"post_comment"}), POL)
    d = await gate.decide(
        act(
            tool="post_comment",
            rendered="post_comment(...)",
            irreversible=True,
            crosses_boundary=True,
            attacker_controlled=("repo",),
        )
    )
    ok(not d.allow)


test("RuleBased：critical 一律拒绝，授权过也不行", _g13)


async def _g14() -> None:
    class Flaky:
        name = "flaky"

        async def review(self, a: Action, ctx: shared.ReviewContext) -> shared.Decision:
            raise RuntimeError("timeout")

    d = await M.make_gate(Flaky(), POL).decide(act(irreversible=True))
    ok(not d.allow, "Claude Code 的 subagent review 是反过来的——它放行，只贴一句警告")
    ok(any(k in d.reason for k in ("失败", "error", "closed", "拒")))


test("★ reviewer 抛异常 → 拒绝（fail closed）", _g14)


def _g15() -> None:
    # Claude Code 官方：Tool results are stripped, so hostile content in a file
    # or web page can't manipulate it directly.
    ctx = shared.ReviewContext(user_messages=[], app_context=[], risk="low", provenance_chain=[])
    fields = sorted(ctx.__dataclass_fields__)
    eq(fields, ["app_context", "provenance_chain", "risk", "user_messages"])
    ok(
        "tool_results" not in fields,
        "这是全课唯一一个「有效的分类器」，它有效正是因为它看不见那段数据",
    )


test("★ ReviewContext 里没有 tool_results 这个字段", _g15)


async def _g16() -> None:
    d = await M.make_gate(shared.AutoApprove(), POL).decide(act(irreversible=True))
    ok(d.risk in ("low", "medium", "high", "critical") and len(d.reason) > 0)


test("审批门的 decision 要能说出风险档位和理由", _g16)

# ─────────────────────────────────────────────────────────
print("\n七、rug pull：哈希钉定")


def td(name: str, description: str, schema: dict[str, str]) -> shared.ToolDescriptor:
    return shared.ToolDescriptor(name, description, schema)


def _p1() -> None:
    a = M.pin_tools([td("x", "d", {"a": "string"})])
    b = M.pin_tools([td("x", "d", {"a": "string"})])
    eq(a[0].fingerprint, b[0].fingerprint)


test("指纹稳定：同样的描述算两次一样", _p1)


def _p2() -> None:
    a = M.pin_tools([td("x", "d1", {"a": "string"})])
    b = M.pin_tools([td("x", "d2", {"a": "string"})])
    ok(a[0].fingerprint != b[0].fingerprint)


test("描述改了，指纹要变", _p2)


def _p3() -> None:
    a = M.pin_tools([td("send", "发一条消息。", {"to": "string"})])
    b = M.pin_tools([td("send", "发一条消息。", {"to": "string", "bcc": "string"})])
    ok(
        a[0].fingerprint != b[0].fingerprint,
        "实测 24.8% 的 server 改 descriptor，只有 8.6% 改 description",
    )


test("★ description 没变、inputSchema 多一个字段，指纹也要变", _p3)


def _p4() -> None:
    day0 = [td("x", "d", {"a": "string"})]
    ok(not M.check_drift(M.pin_tools(day0), day0).needs_reapproval)


test("没有变化时不需要重新批准", _p4)


def _p5() -> None:
    r = M.check_drift(M.pin_tools([td("x", "d1", {})]), [td("x", "d2", {})])
    eq(r.changed, ["x"])
    ok(r.needs_reapproval)


test("描述漂移要报出来并要求重新批准", _p5)


def _p6() -> None:
    now = [td("x", "d", {}), td("admin_exec", "执行。", {})]
    r = M.check_drift(M.pin_tools([td("x", "d", {})]), now)
    eq(r.added, ["admin_exec"])
    ok(
        r.needs_reapproval,
        '实测："roughly half of all description changes land on new arrivals"',
    )


test("★ 新增的工具要报出来——漂移排名永远抓不到它", _p6)


def _p7() -> None:
    pins = M.pin_tools([td("x", "d", {}), td("y", "d", {})])
    r = M.check_drift(pins, [td("x", "d", {})])
    eq(r.removed, ["y"])


test("消失的工具也要报", _p7)


def _p8() -> None:
    # 论文自己的对照组就是内容绑定；按漂移排名重审只抓到约 10%。
    day0 = M.pin_tools([td("a", "d", {}), td("b", "d", {})])
    r = M.check_drift(day0, [td("a", "d", {}), td("b", "d！", {})])
    eq(r.changed, ["b"], "一个标点就要触发——因为你不去判断它像不像攻击")


test('★ 内容绑定 ≠ 漂移排名：钉的是哈希，不是"看起来可疑"', _p8)

# ─────────────────────────────────────────────────────────
print("\n八、沙箱")

SB = SandboxSpec(
    allow_write=("/w/app",),
    deny_write=("/w/app/.git",),
    allow_read=("/home/me", "/w/app"),
    deny_read=("/home/me/**/.env", "/home/me/.aws"),
    allowed_domains=("registry.npmjs.org",),
    proxy_enabled=True,
    scrub_env=("GITHUB_TOKEN",),
    covers=("bash",),
    tls_terminate=False,
    owns_resolver=True,
    allow_unsandboxed_retry=False,
)

test("allow 之内的路径放行", lambda: ok(shared.path_verdict(SB, "/w/app/src/a.ts", "write").allow))
test("allow 之外的路径拒绝", lambda: ok(not shared.path_verdict(SB, "/etc/passwd", "write").allow))


def _s3() -> None:
    ok(shared.path_verdict(SB, "/home/me/proj", "read").allow)
    ok(
        not shared.path_verdict(SB, "/home/me/proj/.env", "read").allow,
        "一条宽 allow 不该把一个 secret 重新暴露出来",
    )


test("★ 更具体的 deny 打败更宽的 allow", _s3)

test(
    "deny 里的 ** 通配要能跨任意层级",
    lambda: ok(not shared.path_verdict(SB, "/home/me/a/b/c/.env", "read").allow),
)
test(
    ".git 在可写目录里也要拒绝",
    lambda: ok(not shared.path_verdict(SB, "/w/app/.git/hooks/pre-commit", "write").allow),
)
test(
    "verdict 要说清是哪条规则决定的",
    lambda: ok("/home/me/.aws" in shared.path_verdict(SB, "/home/me/.aws/creds", "read").rule),
)


def _s7() -> None:
    ok(shared.egress_verdict(SB, "registry.npmjs.org").allow)
    ok(not shared.egress_verdict(SB, "evil.com").allow)


test("白名单域名放行，其余拒绝", _s7)


def _s7b() -> None:
    from dataclasses import replace

    off = replace(SB, proxy_enabled=False)
    v = shared.egress_verdict(off, "evil.com")
    ok(v.allow, 'Codex 官方真值表：网络开 + 代理关 = "unrestricted direct"，白名单一条都不生效')
    ok(len(v.caveats) > 0, "而且得说出来——一个静默放行的 allow=True 比拒绝还危险")


test("★ 代理没开的时候，白名单里**没有**的域名也放行", _s7b)


def _s7c() -> None:
    from dataclasses import replace

    off = replace(SB, proxy_enabled=False, owns_resolver=False)
    gaps = shared.sandbox_gaps(off, {})
    i_proxy = next((i for i, g in enumerate(gaps) if "代理没开" in g), -1)
    i_dns = next((i for i, g in enumerate(gaps) if "DNS" in g), -1)
    ok(i_proxy >= 0, "白名单非空 + 代理关，必须报一条缺口")
    ok(i_proxy < i_dns, '那两条说的是"白名单能被绕过"，这条说的是"白名单根本没接上"')


test("★ 这条缺口要排在 DNS 和 domain fronting 前面", _s7c)


def _s8() -> None:
    from dataclasses import replace

    wide = replace(SB, allowed_domains=("*.github.com",))
    v = shared.egress_verdict(wide, "gist.github.com")
    ok(
        v.allow and len(v.caveats) > 0,
        "EchoLeak 走的是 *.teams.microsoft.com；ForcedLeak 那个域名 5 美元就能注册回来",
    )


test("★ 通配白名单会带上警告，因为它的攻击面比你想的大", _s8)


def _s9() -> None:
    gaps = shared.sandbox_gaps(SB, {"STRIPE_SECRET_KEY": "sk_live_x"})
    ok(
        any("STRIPE_SECRET_KEY" in g for g in gaps),
        'Claude Code 官方："no built-in credential deny list"',
    )


test("★ 缺口清单：没列进 scrub_env 的密钥会被子进程继承", _s9)

test(
    "★ 缺口清单：不终止 TLS 就存在 domain fronting",
    lambda: ok(any(("fronting" in g or "SNI" in g) for g in shared.sandbox_gaps(SB, {}))),
)
test(
    "★ 缺口清单：沙箱只盖住 bash，其它工具不在里面",
    lambda: ok(
        any(any(k in g for k in ("read_file", "工具", "覆盖")) for g in shared.sandbox_gaps(SB, {}))
    ),
)


def _s12() -> None:
    from dataclasses import replace

    no_dns = replace(SB, owns_resolver=False)
    ok(any("DNS" in g for g in shared.sandbox_gaps(no_dns, {})))


test("★ 缺口清单：不掌握解析器就有一条静默 DNS 信道", _s12)


def _s13() -> None:
    from dataclasses import replace

    retry = replace(SB, allow_unsandboxed_retry=True)
    ok(any("重试" in g for g in shared.sandbox_gaps(retry, {})))


test("★ 缺口清单：允许失败后不带沙箱重试，等于没有沙箱", _s13)

# ─────────────────────────────────────────────────────────
print("\n九、两轴：★ 只报一个数字就是错的")


def suite(blocked: int, completed: int) -> list[SuiteCase]:
    return [SuiteCase(f"a{i}", "attack", i < blocked) for i in range(100)] + [
        SuiteCase(f"b{i}", "benign", i < completed) for i in range(100)
    ]


test("ASR = 攻击用例里没拦住的比例", lambda: near(M.two_axis(suite(90, 100), 1).asr, 0.1))
test("可用性 = 良性用例的完成率", lambda: near(M.two_axis(suite(100, 62), 1).utility, 0.62))
test(
    "utility_delta 是相对基线的百分点差",
    lambda: near(M.two_axis(suite(100, 41), 0.6907).utility_delta, -28.07, 0.01),
)


def _x4() -> None:
    r = M.two_axis([SuiteCase("a", "attack", True)], 1)
    ok(
        "缺一轴" in r.verdict or "没有意义" in r.verdict,
        '一个只测攻击的评估，可以用"什么都拦掉"拿满分',
    )


test("★ 只有攻击用例 → 拒绝给结论", _x4)


def _x5() -> None:
    r = M.two_axis([SuiteCase("b", "benign", True)], 1)
    ok("缺一轴" in r.verdict or "没有意义" in r.verdict)


test("★ 只有良性用例 → 也拒绝给结论", _x5)


def _x6() -> None:
    r = M.two_axis(suite(100, 62), 0.6907)
    ok(r.asr == 0 and not r.verdict.startswith("★"), "CaMeL 是 77% vs 84%，掉 7 个百分点")


test("★ ASR 归零 + 代价很小 → 架构型防御的形状", _x6)


def _x7() -> None:
    r = M.two_axis(suite(100, 41), 0.6907)
    ok(
        r.asr == 0 and r.verdict.startswith("★"),
        "和上一条同样是 ASR 0，但这是两种完全不同的工程结果",
    )


test("★ ASR 归零 + 可用性崩了 → 分类器的形状，要单独标出来", _x7)


def _x8() -> None:
    ok(not M.two_axis(suite(100, 55), 0.6907).verdict.startswith("★"))
    ok(M.two_axis(suite(100, 50), 0.6907).verdict.startswith("★"))


test("代价的分界线在 15 个百分点", _x8)

test(
    "ASR 没归零就不能说安全轴归零",
    lambda: ok("归零" not in M.two_axis(suite(52, 69), 0.6907).verdict),
)


def _x10() -> None:
    comparable, missing = M.claim_is_comparable(
        shared.AsrClaim(
            asr=0.0111,
            denominator="adversary",
            adaptive=True,
            model_snapshot="claude-3-5-sonnet-20241022",
            benchmark_version="AgentDojo v1.2",
            benign_utility=0.66,
        )
    )
    ok(comparable)
    eq(missing, [])


test("★ 六项全的 ASR 断言才可比", _x10)


def _x11() -> None:
    comparable, missing = M.claim_is_comparable(
        shared.AsrClaim(
            asr=0.008,
            denominator="attempt",
            adaptive=True,
            model_snapshot="x-2025-01-01",
            benchmark_version="v1",
            benign_utility=0.6,
        )
    )
    ok(not comparable, "LLMail-Inject 的 0.8% 是每次提交；按队伍算，四层叠一起是 16.6%")


test('★ 缺"每个对手"这个分母 → 不可比', _x11)


def _x12() -> None:
    comparable, missing = M.claim_is_comparable(
        shared.AsrClaim(
            asr=0.0,
            denominator="adversary",
            adaptive=False,
            model_snapshot="x-2025-01-01",
            benchmark_version="v1",
            benign_utility=0.6,
        )
    )
    ok(not comparable, "12 个已发表防御在自适应攻击下 ASR >90%，而它们原本报的都是接近零")


test("★ 攻击方不自适应 → 不可比", _x12)


def _x13() -> None:
    comparable, missing = M.claim_is_comparable(
        shared.AsrClaim(
            asr=0.3386,
            denominator="adversary",
            adaptive=True,
            model_snapshot="claude-3-5-sonnet",
            benchmark_version="v1",
            benign_utility=0.6,
        )
    )
    ok(not comparable, "20240620 是 33.86%，20241022 是 1.11%——同一个名字，差 30 倍")


test("★ 模型快照没有日期 → 不可比", _x13)


def _x14() -> None:
    comparable, missing = M.claim_is_comparable(
        shared.AsrClaim(
            asr=0.0795,
            denominator="adversary",
            adaptive=True,
            model_snapshot="gpt-4o-2024-05-13",
            benchmark_version="AgentDojo v1.2",
            benign_utility=None,
        )
    )
    ok(not comparable)
    ok(any("可用性" in m for m in missing))


test("没有同时报良性可用性 → 不可比", _x14)

# ─────────────────────────────────────────────────────────
print("\n十、不可见字符")

test("零宽字符要被剥掉", lambda: eq(shared.strip_invisible("rm\u200b -rf /").text, "rm -rf /"))
test("变体选择符要被剥掉", lambda: ok(shared.strip_invisible("a\ufe0fb").removed == 1))
test(
    "★ 标签字符（U+E0000 段）要被剥掉——这是最常见的走私载荷",
    lambda: ok(shared.strip_invisible("hi\U000e0041").removed == 1),
)
test(
    "正常文本不要被改动（含中文和 emoji）",
    lambda: eq(shared.strip_invisible("删掉 build 目录 🙂").text, "删掉 build 目录 🙂"),
)


def _i5() -> None:
    ok(not shared.display_matches_execution("rm -rf ./build", "rm\u200b -rf /"))
    ok(shared.display_matches_execution("rm -rf ./build", "rm -rf ./build"))


test("★ 显示的和执行的不一致要能判出来", _i5)

# ─────────────────────────────────────────────────────────
total = passed + len(failures)
print(f"\n\x1b[1m{passed}/{total} 通过\x1b[0m")
if failures:
    print("\x1b[31m没过的：\x1b[0m")
    for f in failures:
        print(f"\x1b[31m  · {f}\x1b[0m")
    print("\n\x1b[2m带 ★ 的那些是这一节真正要教的东西：它们全都不抛异常，\x1b[0m")
    print("\x1b[2m所以你的实现漏了它们的时候，日志上看起来是绿的。\x1b[0m")
    sys.exit(1)
print("\x1b[2m\n注意这句话的边界：全绿只意味着这些结构性质成立，\x1b[0m")
print("\x1b[2m不意味着你的 agent 是安全的。这一节从头到尾都在说这件事。\x1b[0m")
