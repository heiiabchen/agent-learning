"""L10 任务三（Python 版）：远程 MCP 的授权。跑法：

    cd labs && uv run python -m l10.auth

任务说明在 l10/auth.ts，两边都做的话先读那份；观察实验的输出和 TS 逐字节一致。
这里的 TODO 注释写契约要点，外加 Python 特有的坑：

  · `resource in aud`：aud 是 str 时是子串匹配，是 list 时是成员匹配（TODO 10 / 14）。
  · `isinstance(True, int)` 是 True；json.loads 接受 Infinity（TODO 10）。
  · urlsplit 会小写 scheme，`.hostname` 会小写 host 并去掉端口（TODO 12）。
"""

from __future__ import annotations

import re
from dataclasses import replace
from typing import Any, Literal, cast

from shared.mcpauth import (
    Challenge,
    CheckOpts,
    CheckResult,
    Downstream,
    MetaResult,
    PrmResult,
    TokenView,
    UrlResult,
    as_metadata_candidates,
    build_challenge,
    check_access_token,
    parse_www_authenticate,
    prm_candidates,
    run_checks,
    step_audience,
    step_issuer,
    step_lifetime,
    step_scope,
    step_typ_alg,
    step_up_scopes,
    validate_as_metadata,
    validate_auth_url,
    validate_prm,
)

# build_challenge / validate_prm / validate_as_metadata / validate_auth_url 直接用参考实现，
# verify 从这里拿，所以本模块对外是完整的一套 API。

DIM, BOLD, OFF = "\x1b[2m", "\x1b[1m", "\x1b[0m"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _w(s: str) -> int:
    s = _ANSI.sub("", s)
    return sum(2 if "\u2e80" <= c <= "\u9fff" or "\uff00" <= c <= "\uffef" else 1 for c in s)


def pad(s: str, n: int) -> str:
    return s + " " * max(0, n - _w(s))


def dim(s: str) -> str:
    return f"{DIM}{s}{OFF}"


def bold(s: str) -> str:
    return f"{BOLD}{s}{OFF}"


# ─────────────────────────────────────────────────────────────
# 夹具
# ─────────────────────────────────────────────────────────────

NOW = 1_800_000_000
ISS = "https://auth.example.com"
RES = "https://mcp.example.com"
PRM = RES + "/.well-known/oauth-protected-resource"

# 操作是「写文件」。
WRITE = CheckOpts(
    issuer=ISS,
    resource=RES,
    now=NOW,
    required_scopes=["files:read", "files:write"],
    implies={"files:admin": ["files:read", "files:write"]},
)


def _tok(claims: dict[str, Any] | None = None, header: dict[str, Any] | None = None) -> TokenView:
    base = {"iss": ISS, "aud": RES, "exp": NOW + 3600, "sub": "alice"}
    return cast(
        TokenView,
        {
            "header": {"typ": "at+jwt", "alg": "RS256", **(header or {})},
            "claims": {**base, "scope": "files:read files:write", **(claims or {})},
        },
    )


def _show(r: CheckResult) -> str:
    return "ok" if r.ok else f"{r.status} {r.reason}"


def _verdict(r: PrmResult | MetaResult | UrlResult) -> str:
    return "ok" if r.ok else str(r.reason)


def _mark(s: str, ref: str) -> str:
    return s if s == ref else bold(s + " ✗")


# 两个「差一点」的检查器，用参考实现的检查关卡拼出来。


def _naive_audience(t: TokenView, o: CheckOpts) -> CheckResult | None:
    """naive-A：Python 版写成 `in`——对 str 是子串，对 list 是成员。TODO 14。"""
    ok = o.resource in t["claims"].get("aud", "")
    return None if ok else CheckResult(ok=False, status=401, reason="WRONG_AUDIENCE")


def _naive_a(t: TokenView, o: CheckOpts) -> CheckResult:
    return run_checks((step_typ_alg, step_issuer, _naive_audience, step_lifetime, step_scope), t, o)


def _naive_b(t: TokenView, o: CheckOpts) -> CheckResult:
    """naive-B：scope 挪到 exp 前面。TODO 15。"""
    return run_checks((step_typ_alg, step_issuer, step_audience, step_scope, step_lifetime), t, o)


# ─────────────────────────────────────────────────────────────


def exp1() -> None:
    print(bold("\n实验一：十张 token，一个参考实现，两个「差一点」的实现"))
    print(
        dim(
            "  操作是「写文件」，要 files:read files:write；files:admin 蕴含这两个。"
            f"now = {NOW}，leeway 60 秒。"
        )
    )
    rows: list[tuple[str, TokenView]] = [
        ("合法", _tok()),
        ("aud 是别的服务", _tok({"aud": "https://other.example.com"})),
        ("aud 后缀攻击 .evil.io", _tok({"aud": "https://mcp.example.com.evil.io"})),
        ("iss 多一个尾斜杠", _tok({"iss": ISS + "/"})),
        ("ID Token（typ: JWT）", _tok({}, {"typ": "JWT"})),
        ("alg: none", _tok({}, {"alg": "none"})),
        ("过期，scope 也不够", _tok({"exp": NOW - 600, "scope": "files:read"})),
        ("只是 scope 不够", _tok({"scope": "files:read"})),
        ("只有 files:admin", _tok({"scope": "files:admin"})),
        ("过期 30 秒（leeway 内）", _tok({"exp": NOW - 30})),
    ]
    print(
        f"  {pad('#', 4)}{pad('token', 26)}{pad('参考实现', 24)}"
        f"{pad('naive-A：aud.includes', 26)}naive-B：先查 scope"
    )
    print("  " + "─" * 98)
    for i, (label, t) in enumerate(rows):
        ref = _show(check_access_token(t, WRITE))
        a = _mark(_show(_naive_a(t, WRITE)), ref)
        b = _mark(_show(_naive_b(t, WRITE)), ref)
        print(f"  {pad(str(i + 1), 4)}{pad(label, 26)}{pad(ref, 24)}{pad(a, 26)}{b}")
    print(
        dim(
            "\n  naive-A 只错在第 3 行。第 2 行那个最明显的用例它是对的——"
            "这个 bug 就是这样活到生产的（TODO 14）。"
        )
    )
    print(
        dim(
            "  naive-B 只错在第 7 行。客户端收到 403 会去 step-up，"
            "为一张已经过期的 token 弹授权页；"
        )
    )
    print(dim("  正确答案是 401，刷新一下就完事（TODO 15）。"))


# ─────────────────────────────────────────────────────────────


def exp2() -> None:
    print(bold("\n实验二：401 之后去哪找——两段发现，五个候选 URL"))
    prm_cases: list[tuple[str, str, list[Challenge]]] = [
        ("MCP 端点带路径，挑战里没有 resource_metadata", "https://example.com/public/mcp", []),
        ("MCP 端点在根上（末尾一个 /）", "https://example.com/", []),
        (
            "挑战里有 resource_metadata",
            "https://mcp.example.com/mcp",
            parse_www_authenticate(f'Bearer resource_metadata="{PRM}"'),
        ),
    ]
    print("  第一段：PRM（RFC 9728），按顺序请求")
    for label, url, ch in prm_cases:
        print(dim(f"  {label}：{url}"))
        for i, c in enumerate(prm_candidates(url, ch)):
            print(f"    {i + 1}. {c}")
    as_cases = [
        ("issuer 没有路径", "https://auth.example.com"),
        ("issuer 带租户路径", "https://auth.example.com/tenant1"),
        ("Keycloak realm", "https://sso.example.cn/realms/agents"),
    ]
    print("\n  第二段：AS 元数据（RFC 8414 / OIDC Discovery），按顺序请求")
    for label, issuer in as_cases:
        print(dim(f"  {label}：{issuer}"))
        for i, c in enumerate(as_metadata_candidates(issuer)):
            print(f"    {i + 1}. {c}")
    print(dim("\n  第 3 个候选（路径追加）是给 Keycloak realm 这类多租户 IdP 留的。"))

    print(bold("\n  拿回来的文档，一样一样查"))
    pub = "https://example.com/public/mcp"
    rows: list[tuple[str, str]] = [
        (
            "PRM：resource 和请求时用的 URL 逐字相等",
            _verdict(validate_prm({"resource": pub, "authorization_servers": [ISS]}, pub)),
        ),
        (
            "PRM：resource 多一个尾斜杠",
            _verdict(validate_prm({"resource": pub + "/", "authorization_servers": [ISS]}, pub)),
        ),
        (
            "attacker.example 上的文档写着 issuer: honest.example",
            _verdict(
                validate_as_metadata(
                    {
                        "issuer": "https://honest.example",
                        "code_challenge_methods_supported": ["S256"],
                    },
                    "https://attacker.example",
                )
            ),
        ),
        (
            "AS 元数据没有 code_challenge_methods_supported",
            _verdict(validate_as_metadata({"issuer": ISS}, ISS)),
        ),
        (
            "authorization_endpoint: file:/c:/windows/system32/calc.exe",
            _verdict(validate_auth_url("file:/c:/windows/system32/calc.exe")),
        ),
    ]
    print(f"  {pad('文档', 60)}结论")
    print("  " + "─" * 80)
    for label, v in rows:
        print(f"  {pad(label, 60)}{v}")
    print(
        dim(
            "\n  两次逐字比较：PRM 的 resource、AS 元数据的 issuer。"
            "GHSA-qx49：主路径做对了，回退路径漏了后一条。"
        )
    )
    print(
        dim(
            "  最后一行是 CVE-2025-6514 的 PoC 原样："
            "授权 URL 来自可能恶意的 server，只许 https 或 loopback 的 http。"
        )
    )


# ─────────────────────────────────────────────────────────────


def exp3() -> None:
    print(bold("\n实验三：step-up 取并集，还是直接用挑战里的 scope"))
    ops = [("列目录", "files:read"), ("写文件", "files:write"), ("生成分享链接", "files:share")]
    list_op = replace(WRITE, required_scopes=["files:read"])

    def can_list(scopes: list[str]) -> str:
        return "✓" if check_access_token(_tok({"scope": " ".join(scopes)}), list_op).ok else "✗ 403"

    print(
        f"  {pad('#', 4)}{pad('操作', 14)}{pad('挑战里的 scope', 16)}{pad('并集（规范）', 38)}"
        f"{pad('替换（naive）', 16)}回头再列目录：并集 / 替换"
    )
    print("  " + "─" * 110)
    union: list[str] = []
    for i, (op, sc) in enumerate(ops):
        union = step_up_scopes(union, [sc])
        replaced = [sc]
        print(
            f"  {pad(str(i + 1), 4)}{pad(op, 14)}{pad(sc, 16)}{pad(' '.join(union), 38)}"
            f"{pad(' '.join(replaced), 16)}{can_list(union)} / {can_list(replaced)}"
        )
    print(
        dim(
            "\n  替换的客户端每做一件新事就丢一件旧事："
            "拿到写权限，下一次列目录又是 403，又一个授权页。"
        )
    )
    print(dim('  规范："Scope accumulation across operations is a client-side responsibility."'))
    print(
        dim(
            "  另外要给 step-up 设上限："
            "一个永远回 403 的 server 加一个不设上限的客户端，就是无限弹窗。"
        )
    )


# ─────────────────────────────────────────────────────────────


def _naive_parse(h: str) -> dict[str, str]:
    """常见的错误写法：去掉 Bearer 前缀，按逗号切，再按第一个等号切，剥掉两头的引号。"""
    out: dict[str, str] = {}
    for part in re.sub(r"^Bearer\s+", "", h, flags=re.I).split(","):
        k, _, v = part.strip().partition("=")
        out[k] = re.sub(r'^"|"$', "", v)
    return out


def exp4() -> None:
    print(bold("\n实验四：WWW-Authenticate 不是「逗号分隔的 key=value」"))
    r = check_access_token(_tok({"scope": "files:read"}), WRITE)
    if r.ok:
        raise RuntimeError("夹具写错了")
    headers = {
        "A": 'Basic realm="x", Bearer resource_metadata="https://m/.well-known/oauth-protected-resource"'
        ', error_description="a, b", scope="files:read"',
        "B": 'Bearer error="invalid_token", error_description="say \\"hi\\", then retry"',
        "C": 'BEARER Scope="files:read files:write"',
        "D": build_challenge(r, resource_metadata=PRM, required_scopes=WRITE.required_scopes),
    }
    for k, h in headers.items():
        print(dim(f"  {k}  {h}"))
    print(dim("     （D 是实验一第 8 行的 403，buildChallenge 生成）"))
    rows = [
        ("A", "error_description"),
        ("A", "resource_metadata"),
        ("B", "error_description"),
        ("C", "scope"),
        ("D", "scope"),
    ]

    def cell(v: str | None) -> str:
        return "（没有）" if v is None else f"「{v}」"

    naive_col = "naive split(',')"
    print(f"\n  {pad('头', 4)}{pad('Bearer 的参数', 20)}{pad(naive_col, 30)}RFC 9110 解析")
    print("  " + "─" * 100)
    for k, param in rows:
        h = headers[k]
        naive = cell(_naive_parse(h).get(param))
        bearer = next((c for c in parse_www_authenticate(h) if c.scheme == "bearer"), None)
        proper = cell(bearer.params.get(param) if bearer else None)
        shown = naive if naive == proper else bold(naive)
        print(f"  {pad(k, 4)}{pad(param, 20)}{pad(shown, 30)}{proper}")
    print(dim("\n  naive 在 D 上全对——拿自己生成的头当测试夹具，永远测不出它。"))
    print(
        dim(
            "  A 的第二行最贵：resource_metadata 丢了，客户端只好去猜 well-known；"
            "PRM 不在默认位置时发现直接失败。"
        )
    )


def observe() -> None:
    print(bold("L10 · 远程 MCP 的授权（观察实验，参考实现）"))
    print(dim("零网络、零加密、零模型。每张表对应一条「直觉是反的」。"))
    exp1()
    exp2()
    exp3()
    exp4()
    print(bold("\n最该记住的"))
    print(
        "  1. 所有 401 先于 403。检查顺序是设计：过期就回 401，别让客户端为一张死 token 弹授权页。"
    )
    print(
        "  2. aud、iss、resource、issuer 全部逐字比较。"
        "includes 和「规范化一下」都能过最明显的那个用例。"
    )
    print("  3. step-up 取并集，累积 scope 是客户端的责任；重试要有上限。")
    print("  4. 签名交给库。出事的从来不是签名，是签名之后的这几行判断。")


# ── TODO ─────────────────────────────────────────────────────
#
# 编号接着 server.py 的 TODO 1–9。完整契约在 l10/auth.ts 和 shared/mcpauth.ts 的注释里。


def my_check_access_token(t: TokenView | None, o: CheckOpts) -> CheckResult:
    """TODO 10 ★★ 资源服务器收到一张 token（签名已验过），决定收不收。

    顺序就是设计：typ/alg → iss → aud → exp/nbf → scope。只有 scope 不够是 403，其余全是 401。
      · t 是 None → NO_TOKEN
      · typ 不是 at+jwt / application/at+jwt（ASCII 大小写不敏感，缺失也算）→ WRONG_TYP
      · alg 缺失或是 none（ASCII 大小写不敏感）→ ALG_NONE
      · iss 逐字等于 o.issuer，否则 WRONG_ISSUER
      · aud 是 str 或 list；o.resource 必须等于其中一个元素，否则 WRONG_AUDIENCE
      · exp 缺失、不是有限数、或 now >= exp + leeway → EXPIRED；
        nbf 有值且（不是有限数或 now < nbf - leeway）→ NOT_YET_VALID
      · scope 空格分隔；implies 可传递。缺 → 403 INSUFFICIENT_SCOPE，
        missing 按 required_scopes 的顺序列出缺的那些
      · 通过 → CheckResult(ok=True, sub=…, scopes=…)：sub 缺失时是 ""；scopes 展开 implies 后排序

    Python 特有：
      · `o.resource in t["claims"]["aud"]`——aud 是 str 时这是子串匹配。
        先用 isinstance 规范成 list。
      · 判断 exp / nbf 是不是数字时排掉 bool，并用 math.isfinite：json.loads 接受 Infinity。
    """
    raise NotImplementedError("TODO 10 未实现")


def my_parse_www_authenticate(header: str) -> list[Challenge]:
    """TODO 11 ★★ 解析 WWW-Authenticate（RFC 9110 §11.6.1），返回其中所有的 challenge。

    多个 challenge 用逗号分隔，challenge 内部的参数也用逗号分隔。
    参数是 `token =`，新的 challenge 是一个后面不跟 `=` 的 token。
    quoted-string 里的逗号不切，`\\x` 表示字面的 x；scheme 和参数名小写化（只折叠 ASCII）；
    token68 认出来跳过；同名参数取第一个；坏片段跳到下一个不在引号里的逗号；引号没闭合的参数丢掉。

    Python 特有：TS 里 `s[n]` 是 undefined，Python 里是 IndexError——扫描时先判断 `i < n`。
    """
    raise NotImplementedError("TODO 11 未实现")


def my_prm_candidates(mcp_url: str, challenges: list[Challenge]) -> list[str]:
    """TODO 12 ★ PRM 的候选 URL：resource_metadata 优先；否则路径插入、根（根上只有一个）。

    规则见 l10/auth.ts 的 myPrmCandidates。URL 原样拆，不规范化。

    Python 特有：urlsplit("https://example.com").path 是 ""，加个 "/" 就变成 "/"——
    「host 后面那个结尾的 /」要先去掉。urlsplit 还会把 scheme 小写化，`.hostname` 会把 host
    小写化并去掉端口；要原样拼回去就用 netloc，或者用 shared.mcpauth.split_uri。
    """
    raise NotImplementedError("TODO 12 未实现")


def my_as_metadata_candidates(issuer: str) -> list[str]:
    """TODO 12 ★ AS 元数据候选：有路径三个（OAuth 插入、OIDC 插入、OIDC 追加），没有路径两个。"""
    raise NotImplementedError("TODO 12 未实现")


def my_check_iss_response(
    *, supports_iss: bool | None, iss: str | None, recorded: str
) -> Literal["proceed", "reject"]:
    """TODO 13 ★ RFC 9207 四行表：有 iss 就逐字比较；声明支持却没带 → reject；都没有 → proceed。

    Python 特有：声明支持要写 `supports_iss is True`，别写 `if supports_iss:`。
    """
    raise NotImplementedError("TODO 13 未实现")


def my_step_up_scopes(previous: list[str], challenged: list[str]) -> list[str]:
    """TODO 13 ★ 之前申请过的 ∪ 这次挑战里的，去重，按码点排序。"""
    raise NotImplementedError("TODO 13 未实现")


def my_decide_downstream_auth(
    *,
    inbound_raw: str,
    outbound_raw: str,
    outbound_aud: str | list[str] | None,
    self_uri: str,
    downstream: str,
) -> Downstream:
    """TODO 13 ★ 原始字符串和入站相同 → PASSTHROUGH；aud 含 self_uri → PASSTHROUGH；
    aud 不含 downstream → WRONG_AUDIENCE；否则 OK。aud 的成员判断同样别用 str 上的 `in`。
    """
    raise NotImplementedError("TODO 13 未实现")


# ─────────────────────────────────────────────────────────────
# TODO 14（没有代码）：把你的 aud 比较换成 `o.resource in t["claims"]["aud"]`
#
# 重跑 uv run python -m l10.verify。授权那一组里只有 MA-2 会红——MA-1 仍然是绿的。
# Python 的这一行比 TS 的 includes 更隐蔽：aud 是 list 时它恰好是对的。
#
# TODO 15（没有代码）：把 scope 检查挪到 exp 检查前面
#
# 重跑，只有 MA-6 会红。然后想一下真实客户端收到这个 403 会做什么（见 auth.ts 的 TODO 15）。
# ─────────────────────────────────────────────────────────────

_ = (
    my_check_access_token,
    my_parse_www_authenticate,
    my_prm_candidates,
    my_as_metadata_candidates,
    my_check_iss_response,
    my_step_up_scopes,
    my_decide_downstream_auth,
)

if __name__ == "__main__":
    observe()
    print(
        dim(
            "\n  下一步：实现 TODO 10–13，然后跑 pnpm verify:l10"
            "（或 uv run python -m l10.verify），授权那一组在最后。"
        )
        + dim("\n  想先确认测试本身是对的，跑 VERIFY_TARGET=shared 下的 verify。")
        + dim("\n  观察实验：pnpm mcp:auth / uv run python -m l10.auth\n")
    )
