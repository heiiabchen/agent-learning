"""参考实现：远程 MCP 的授权策略（2026-07-28）。

对应 shared/mcpauth.ts。设计理由都写在那边（签名交给库、只测策略、检查顺序是设计），
这里只标 Python 特有的坑：

  1. **`resource in aud`。** aud 是 str 时是子串匹配，是 list 时是成员匹配——同一行代码
     两种语义。`"https://mcp.example.com" in "https://mcp.example.com.evil.io"` 是 True。
     TS 的 includes 至少对数组和字符串都叫同一个名字，读者会警觉；Python 的 `in` 更隐蔽。
     所以先用 isinstance 把 aud 规范成 list，再判断成员。
  2. **`isinstance(True, int)` 是 True。** nbf 是 true 的 token，不排掉 bool 就被当成
     1970 年生效；TS 那边 typeof 是 boolean，结论是 NOT_YET_VALID——两边不一致。
  3. **json.loads 接受 NaN 和 Infinity，而且整数没有上限。** exp 是 inf 的 token 永不过期，
     所以要 math.isfinite；超过 float 范围的整数在 TS 里是 Infinity，这里也按非有限数处理。
  4. **urlsplit 和 WHATWG URL 拆出来的东西不一样。** 两边都改用 RFC 3986 附录 B 的正则原样拆。
"""

from __future__ import annotations

import math
import re
import string
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal, TypedDict

# ─────────────────────────────────────────────────────────────
# 零、小工具
# ─────────────────────────────────────────────────────────────

_ASCII_LOWER = str.maketrans(string.ascii_uppercase, string.ascii_lowercase)


def ascii_lower(s: str) -> str:
    return s.translate(_ASCII_LOWER)


def aud_list(aud: object) -> list[str]:
    """aud 可以是字符串也可以是数组（RFC 7519 §4.1.3）。统一成 list，非字符串元素丢掉。"""
    if isinstance(aud, str):
        return [aud]
    if isinstance(aud, list):
        return [x for x in aud if isinstance(x, str)]
    return []


def split_scope(scope: object) -> list[str]:
    """scope 是空格分隔的字符串（RFC 6749 §3.3）。"""
    return [s for s in scope.split(" ") if s] if isinstance(scope, str) else []


def expand_scopes(granted: list[str], implies: dict[str, list[str]] | None = None) -> list[str]:
    """展开 scope 层级（可传递），按码点排序。"""
    implies = implies or {}
    seen: set[str] = set()
    stack = list(granted)
    while stack:
        s = stack.pop()
        if s in seen:
            continue
        seen.add(s)
        more = implies.get(s)
        if isinstance(more, list):
            stack.extend(m for m in more if isinstance(m, str))
    return sorted(seen)


_URI = re.compile(r"(?:([^:/?#]+):)?(?://([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?", re.S)


@dataclass(frozen=True)
class UriParts:
    scheme: str | None
    authority: str | None
    path: str
    query: str | None
    fragment: str | None


def split_uri(s: str) -> UriParts:
    """RFC 3986 附录 B。只拆，不规范化。"""
    m = _URI.fullmatch(s)
    assert m is not None
    return UriParts(m.group(1), m.group(2), m.group(3) or "", m.group(4), m.group(5))


def _finite(x: object) -> float | None:
    """有限数返回 float，否则 None。bool 不算数（见文件头第 2 条和第 3 条）。"""
    if isinstance(x, bool) or not isinstance(x, int | float):
        return None
    try:
        f = float(x)
    except OverflowError:
        return None
    return f if math.isfinite(f) else None


# ─────────────────────────────────────────────────────────────
# 一、资源服务器：入站 token 的策略检查
# ─────────────────────────────────────────────────────────────

TokenReject = Literal[
    "NO_TOKEN",
    "WRONG_TYP",
    "ALG_NONE",
    "WRONG_ISSUER",
    "WRONG_AUDIENCE",
    "EXPIRED",
    "NOT_YET_VALID",
    "INSUFFICIENT_SCOPE",
]


class TokenHeader(TypedDict, total=False):
    typ: str
    alg: str


class TokenClaims(TypedDict, total=False):
    iss: str
    aud: str | list[str]
    exp: float
    nbf: float
    scope: str
    sub: str
    client_id: str


class TokenView(TypedDict):
    """库验完签名、解出来的 JWT。值来自对面，类型一律不可信。"""

    header: TokenHeader
    claims: TokenClaims


DEFAULT_LEEWAY_SEC = 60


@dataclass(frozen=True)
class CheckOpts:
    issuer: str  # 来自已校验的 AS 元数据
    resource: str  # 本 server 的规范化 URI
    now: float  # 秒；由调用方注入
    required_scopes: list[str]  # 本次操作需要的全部 scope
    leeway_sec: float = DEFAULT_LEEWAY_SEC
    implies: dict[str, list[str]] | None = None  # {"files:admin": ["files:read", "files:write"]}


@dataclass(frozen=True)
class CheckResult:
    ok: bool
    status: Literal[401, 403] | None = None
    reason: TokenReject | None = None
    missing: list[str] | None = None
    sub: str = ""
    scopes: list[str] = field(default_factory=list)


def _reject(
    status: Literal[401, 403], reason: TokenReject, missing: list[str] | None = None
) -> CheckResult:
    return CheckResult(ok=False, status=status, reason=reason, missing=missing)


Step = Callable[[TokenView, CheckOpts], CheckResult | None]

_AT_JWT = frozenset({"at+jwt", "application/at+jwt"})


def step_typ_alg(t: TokenView, o: CheckOpts) -> CheckResult | None:
    typ = t["header"].get("typ")
    alg = t["header"].get("alg")
    if not isinstance(typ, str) or ascii_lower(typ) not in _AT_JWT:
        return _reject(401, "WRONG_TYP")
    if not isinstance(alg, str) or ascii_lower(alg) == "none":
        return _reject(401, "ALG_NONE")
    return None


def step_issuer(t: TokenView, o: CheckOpts) -> CheckResult | None:
    return None if t["claims"].get("iss") == o.issuer else _reject(401, "WRONG_ISSUER")


def step_audience(t: TokenView, o: CheckOpts) -> CheckResult | None:
    # ★ 不是 `o.resource in t["claims"]["aud"]`——见文件头第 1 条。
    ok = o.resource in aud_list(t["claims"].get("aud"))
    return None if ok else _reject(401, "WRONG_AUDIENCE")


def step_lifetime(t: TokenView, o: CheckOpts) -> CheckResult | None:
    exp = _finite(t["claims"].get("exp"))
    if exp is None or o.now >= exp + o.leeway_sec:
        return _reject(401, "EXPIRED")
    raw_nbf = t["claims"].get("nbf")
    if raw_nbf is not None:
        nbf = _finite(raw_nbf)
        if nbf is None or o.now < nbf - o.leeway_sec:
            return _reject(401, "NOT_YET_VALID")
    return None


def step_scope(t: TokenView, o: CheckOpts) -> CheckResult | None:
    have = set(expand_scopes(split_scope(t["claims"].get("scope")), o.implies))
    missing = [s for s in o.required_scopes if s not in have]
    return _reject(403, "INSUFFICIENT_SCOPE", missing) if missing else None


# ★ 顺序是设计的一部分：所有 401 类检查必须先于唯一的 403。理由见 shared/mcpauth.ts。
CHECK_ORDER: tuple[Step, ...] = (
    step_typ_alg,
    step_issuer,
    step_audience,
    step_lifetime,
    step_scope,
)


def run_checks(steps: tuple[Step, ...], t: TokenView | None, o: CheckOpts) -> CheckResult:
    if t is None:
        return _reject(401, "NO_TOKEN")
    for step in steps:
        r = step(t, o)
        if r is not None:
            return r
    sub = t["claims"].get("sub")
    return CheckResult(
        ok=True,
        sub=sub if isinstance(sub, str) else "",
        scopes=expand_scopes(split_scope(t["claims"].get("scope")), o.implies),
    )


def check_access_token(t: TokenView | None, o: CheckOpts) -> CheckResult:
    return run_checks(CHECK_ORDER, t, o)


# ─────────────────────────────────────────────────────────────
# 二、挑战头：生成与解析
# ─────────────────────────────────────────────────────────────

# RFC 6750 §3：error_description 只许可见 ASCII，所以这里不写中文。
_DESCRIPTIONS: dict[str, str] = {
    "WRONG_TYP": "token type must be at+jwt",
    "ALG_NONE": "unsigned token",
    "WRONG_ISSUER": "issuer mismatch",
    "WRONG_AUDIENCE": "token was not issued for this resource",
    "EXPIRED": "token expired",
    "NOT_YET_VALID": "token not yet valid",
}


def _quote(v: str) -> str:
    return '"' + re.sub(r'([\\"])', r"\\\1", v) + '"'


def build_challenge(r: CheckResult, *, resource_metadata: str, required_scopes: list[str]) -> str:
    """生成 WWW-Authenticate 的值。规则见 shared/mcpauth.ts 的 buildChallenge。"""
    if r.ok:
        raise ValueError("通过的结果不需要挑战头")
    scope = " ".join(required_scopes)
    parts: list[tuple[str, str]] = []
    if r.reason == "NO_TOKEN":
        if scope:
            parts.append(("scope", scope))
        parts.append(("resource_metadata", resource_metadata))
    elif r.reason == "INSUFFICIENT_SCOPE":
        parts += [
            ("error", "insufficient_scope"),
            ("scope", scope),
            ("resource_metadata", resource_metadata),
        ]
        if r.missing:
            parts.append(("error_description", f"missing scopes: {' '.join(r.missing)}"))
    else:
        parts += [("error", "invalid_token"), ("resource_metadata", resource_metadata)]
        parts.append(("error_description", _DESCRIPTIONS[r.reason or ""]))
    return "Bearer " + ", ".join(f"{k}={_quote(v)}" for k, v in parts)


@dataclass
class Challenge:
    """scheme 和参数名都已小写化；值原样。"""

    scheme: str
    params: dict[str, str] = field(default_factory=dict)


_TCHAR = frozenset("!#$%&'*+-.^_`|~" + string.digits + string.ascii_letters)
_TOKEN68 = re.compile(r"[A-Za-z0-9\-._~+/]+=*")


def parse_www_authenticate(header: str) -> list[Challenge]:
    """解析 WWW-Authenticate（RFC 9110 §11.6.1）。语法和宽松规则见 shared/mcpauth.ts。"""
    s = header
    n = len(s)
    out: list[Challenge] = []
    cur: Challenge | None = None
    i = 0

    def ws() -> None:
        nonlocal i
        while i < n and s[i] in " \t":
            i += 1

    def token() -> str:
        nonlocal i
        start = i
        while i < n and s[i] in _TCHAR:
            i += 1
        return s[start:i]

    def quoted() -> str | None:
        """i 指向开头的引号。没闭合返回 None。"""
        nonlocal i
        i += 1
        v: list[str] = []
        while i < n:
            c = s[i]
            if c == '"':
                i += 1
                return "".join(v)
            if c == "\\" and i + 1 < n:
                v.append(s[i + 1])
                i += 2
                continue
            v.append(c)
            i += 1
        return None

    def skip_to_comma() -> None:
        nonlocal i
        while i < n and s[i] != ",":
            if s[i] == '"':
                quoted()
            else:
                i += 1

    while i < n:
        ws()
        if i >= n:
            break
        if s[i] == ",":
            i += 1
            continue
        name = token()
        if not name:
            skip_to_comma()
            continue
        ws()
        if i < n and s[i] == "=":
            # 参数。还没有 scheme 就出现参数，是坏的。
            if cur is None:
                skip_to_comma()
                continue
            i += 1
            ws()
            value: str | None
            if i < n and s[i] == '"':
                value = quoted()
            else:
                value = token() or None
            if value is None:
                skip_to_comma()
                continue
            key = ascii_lower(name)
            if key not in cur.params:
                cur.params[key] = value
            ws()
            if i < n and s[i] != ",":
                skip_to_comma()
            continue
        cur = Challenge(scheme=ascii_lower(name))
        out.append(cur)
        m = _TOKEN68.match(s, i)
        if m:
            j = m.end()
            while j < n and s[j] in " \t":
                j += 1
            if j >= n or s[j] == ",":
                i = j
    return out


# ─────────────────────────────────────────────────────────────
# 三、发现：候选 URL 的顺序 + 元数据校验
# ─────────────────────────────────────────────────────────────

PRM_SUFFIX = "/.well-known/oauth-protected-resource"
OAUTH_AS_SUFFIX = "/.well-known/oauth-authorization-server"
OIDC_SUFFIX = "/.well-known/openid-configuration"


def prm_candidates(mcp_url: str, challenges: list[Challenge]) -> list[str]:
    """PRM 的候选 URL，按请求顺序。规则见 shared/mcpauth.ts。

    ★ urlsplit("https://example.com").path 是 ""，urlsplit("https://example.com/").path 是 "/"。
    后者不去掉的话会生成 `…/oauth-protected-resource/` 这个错误候选。
    """
    for c in challenges:
        if "resource_metadata" in c.params:
            return [c.params["resource_metadata"]]
    u = split_uri(mcp_url)
    if not u.scheme or not u.authority or u.fragment is not None:
        return []
    origin = f"{u.scheme}://{u.authority}"
    path = "" if u.path == "/" else u.path
    query = "" if u.query is None else f"?{u.query}"
    root = origin + PRM_SUFFIX
    inserted = root + path + query
    return [root] if inserted == root else [inserted, root]


def as_metadata_candidates(issuer: str) -> list[str]:
    """AS 元数据的候选 URL，按规范的优先级。规则见 shared/mcpauth.ts。"""
    u = split_uri(issuer)
    if not u.scheme or not u.authority or u.query is not None or u.fragment is not None:
        return []
    origin = f"{u.scheme}://{u.authority}"
    path = "" if u.path == "/" else u.path
    if path == "":
        return [origin + OAUTH_AS_SUFFIX, origin + OIDC_SUFFIX]
    return [
        origin + OAUTH_AS_SUFFIX + path,
        origin + OIDC_SUFFIX + path,
        origin + path.removesuffix("/") + OIDC_SUFFIX,
    ]


MetaReject = Literal[
    "RESOURCE_MISMATCH", "NO_AUTH_SERVERS", "ISSUER_MISMATCH", "NO_PKCE", "NO_S256"
]


@dataclass(frozen=True)
class PrmResult:
    ok: bool
    auth_servers: list[str] = field(default_factory=list)
    reason: MetaReject | None = None


@dataclass(frozen=True)
class MetaResult:
    ok: bool
    reason: MetaReject | None = None


def validate_prm(doc: object, expected_resource: str) -> PrmResult:
    """校验拿回来的 PRM：resource 逐字相等，authorization_servers 至少一个。"""
    if not isinstance(doc, dict) or doc.get("resource") != expected_resource:
        return PrmResult(ok=False, reason="RESOURCE_MISMATCH")
    raw = doc.get("authorization_servers")
    servers = [x for x in raw if isinstance(x, str)] if isinstance(raw, list) else []
    if not servers:
        return PrmResult(ok=False, reason="NO_AUTH_SERVERS")
    return PrmResult(ok=True, auth_servers=servers)


def validate_as_metadata(doc: object, issuer_used: str) -> MetaResult:
    """校验拿回来的 AS 元数据：issuer 逐字相等，必须支持 PKCE S256。"""
    if not isinstance(doc, dict) or doc.get("issuer") != issuer_used:
        return MetaResult(ok=False, reason="ISSUER_MISMATCH")
    methods = doc.get("code_challenge_methods_supported")
    if not isinstance(methods, list) or not methods:
        return MetaResult(ok=False, reason="NO_PKCE")
    if "S256" not in methods:
        return MetaResult(ok=False, reason="NO_S256")
    return MetaResult(ok=True)


# ─────────────────────────────────────────────────────────────
# 四、客户端：授权响应与 step-up
# ─────────────────────────────────────────────────────────────


def check_iss_response(
    *, supports_iss: bool | None, iss: str | None, recorded: str
) -> Literal["proceed", "reject"]:
    """RFC 9207 四行表。有 iss 就逐字比较；声明支持却没带 → reject；都没有 → proceed。"""
    if iss is not None:
        return "proceed" if iss == recorded else "reject"
    return "reject" if supports_iss is True else "proceed"


def step_up_scopes(previous: list[str], challenged: list[str]) -> list[str]:
    """之前申请过的 ∪ 这次挑战里的，去重，按码点排序（Python 的 str 排序天然如此）。"""
    return sorted({s for s in [*previous, *challenged] if s})


_LOOPBACK = frozenset({"127.0.0.1", "localhost", "[::1]"})
_VISIBLE_ASCII = re.compile(r"[\x21-\x7e]+")
_HOST_PORT = re.compile(r"(\[[^\]]*\]|[^:]*)(?::[0-9]*)?")

UrlReject = Literal["BAD_SCHEME", "HTTP_NOT_LOOPBACK", "UNPARSEABLE"]


@dataclass(frozen=True)
class UrlResult:
    ok: bool
    reason: UrlReject | None = None


def _host_of(authority: str | None) -> str | None:
    if authority is None:
        return None
    hp = authority[authority.rfind("@") + 1 :]
    m = _HOST_PORT.fullmatch(hp)
    if m is None or m.group(1) == "":
        return None
    return m.group(1)


def validate_auth_url(url: str) -> UrlResult:
    """要交给浏览器打开的授权 URL：白名单。规则见 shared/mcpauth.ts。

    ★ 不能靠 urlsplit 的结果做黑名单：`javascript:alert(1)` 一样拆得出 scheme。
    """
    if not _VISIBLE_ASCII.fullmatch(url):
        return UrlResult(ok=False, reason="UNPARSEABLE")
    u = split_uri(url)
    if u.scheme is None:
        return UrlResult(ok=False, reason="UNPARSEABLE")
    scheme = ascii_lower(u.scheme)
    if scheme not in ("https", "http"):
        return UrlResult(ok=False, reason="BAD_SCHEME")
    host = _host_of(u.authority)
    if host is None:
        return UrlResult(ok=False, reason="UNPARSEABLE")
    if scheme == "https" or ascii_lower(host) in _LOOPBACK:
        return UrlResult(ok=True)
    return UrlResult(ok=False, reason="HTTP_NOT_LOOPBACK")


# ─────────────────────────────────────────────────────────────
# 五、下游调用：禁止透传
# ─────────────────────────────────────────────────────────────

Downstream = Literal["OK", "PASSTHROUGH", "WRONG_AUDIENCE"]


def decide_downstream_auth(
    *,
    inbound_raw: str,
    outbound_raw: str,
    outbound_aud: str | list[str] | None,
    self_uri: str,
    downstream: str,
) -> Downstream:
    """调下游时带的 token 能不能发。规则见 shared/mcpauth.ts。self 在 Python 里改叫 self_uri。"""
    if outbound_raw == inbound_raw:
        return "PASSTHROUGH"
    aud = aud_list(outbound_aud)
    if self_uri in aud:
        return "PASSTHROUGH"
    if downstream not in aud:
        return "WRONG_AUDIENCE"
    return "OK"
