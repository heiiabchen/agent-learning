/**
 * 远程 MCP 的授权：资源服务器怎么验 token、客户端怎么找 AS、怎么 step-up、调下游带什么。
 * L10 第十节的参考实现（MCP 2026-07-28 授权规范）。
 *
 * 全部是字符串和集合运算：零网络、零加密、零模型，也不读时钟（now 由调用方注入）。
 *
 * ★ 签名验证假设已经由库做完（jose / PyJWT，RFC 9068 那条 "MUST validate the signature"）。
 *   这个模块只管签名之后的**策略判断**：谁签的、给谁的、还在不在有效期、能做什么。
 *   理由是讲义那张事故表——Cloudflare 漏查 redirect_uri、mcp-remote 打开 file: URL、
 *   Python SDK 不校验 issuer 和受众——没有一条是密码学失败，全是策略漏判。
 *
 * 两条贯穿全文件的纪律：
 *   · 比较一律逐字（===）。iss、aud、resource、issuer 都不做大小写折叠、不去尾斜杠。
 *     只有语法本身规定不区分大小写的东西（auth-scheme、参数名、媒体类型、URI scheme、host）
 *     才折叠，而且只折叠 ASCII——toLowerCase() 和 Python 的 lower() 在个别 Unicode 字符上不一致。
 *   · URL 用 RFC 3986 附录 B 的正则原样拆，不用 new URL()：WHATWG 会悄悄小写 host、
 *     去掉默认端口、把 `\` 当 `/`，Python 的 urlsplit 一样都不做——同一个输入两边拆出不同的东西。
 */

// ─────────────────────────────────────────────────────────────
// 零、小工具
// ─────────────────────────────────────────────────────────────

export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/** 按码点比较。默认 sort() 按 UTF-16 码元，和 Python 的 str 排序在代理对上不一致。 */
export function cmpCp(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i]!.codePointAt(0)!
    const q = y[i]!.codePointAt(0)!
    if (p !== q) return p < q ? -1 : 1
  }
  return x.length - y.length
}

/** key 来自对面（服务器给的参数名、token 里的 scope），`__proto__` 也可能出现，所以用无原型的对象。 */
function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}
function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k)
}

/** aud 可以是字符串也可以是数组（RFC 7519 §4.1.3）。统一成数组，非字符串元素丢掉。 */
export function audList(aud: unknown): string[] {
  if (typeof aud === 'string') return [aud]
  if (Array.isArray(aud)) return aud.filter((x): x is string => typeof x === 'string')
  return []
}

/** scope 是空格分隔的字符串（RFC 6749 §3.3）。 */
export function splitScope(scope: unknown): string[] {
  return typeof scope === 'string' ? scope.split(' ').filter((s) => s !== '') : []
}

/** 展开 scope 层级（可传递），按码点排序。 */
export function expandScopes(granted: string[], implies: Record<string, string[]> = {}): string[] {
  const seen = new Set<string>()
  const stack = [...granted]
  while (stack.length > 0) {
    const s = stack.pop()!
    if (seen.has(s)) continue
    seen.add(s)
    const more = hasOwn(implies, s) ? implies[s] : undefined
    if (Array.isArray(more)) for (const m of more) if (typeof m === 'string') stack.push(m)
  }
  return [...seen].sort(cmpCp)
}

const URI_RE = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s

interface UriParts {
  scheme: string | undefined
  authority: string | undefined
  path: string
  query: string | undefined
  fragment: string | undefined
}

/** RFC 3986 附录 B。只拆，不规范化。 */
export function splitUri(s: string): UriParts {
  const m = URI_RE.exec(s)!
  return { scheme: m[1], authority: m[2], path: m[3] ?? '', query: m[4], fragment: m[5] }
}

// ─────────────────────────────────────────────────────────────
// 一、资源服务器：入站 token 的策略检查
//
// 规范："MCP servers MUST validate that access tokens were issued specifically for them
//   as the intended audience" / "Invalid or expired tokens MUST receive a HTTP 401 response."
// ─────────────────────────────────────────────────────────────

export type TokenReject =
  | 'NO_TOKEN' // 没带 Authorization → 401，挑战里不带 error
  | 'WRONG_TYP' // header.typ 不是 at+jwt（典型：把 OIDC ID Token 当 access token 发过来）
  | 'ALG_NONE' // RFC 9068: MUST reject alg=none
  | 'WRONG_ISSUER' // iss 与配置的 issuer 不逐字相等
  | 'WRONG_AUDIENCE' // aud 不含本 server 的规范化 URI
  | 'EXPIRED' // now >= exp + leeway
  | 'NOT_YET_VALID' // now < nbf - leeway
  | 'INSUFFICIENT_SCOPE' // 只有走到这里才是 403

export interface TokenView {
  header: { typ?: string; alg?: string }
  claims: {
    iss?: string
    aud?: string | string[]
    exp?: number
    nbf?: number
    scope?: string
    sub?: string
    client_id?: string
  }
}

export interface CheckOpts {
  /** 来自已校验的 AS 元数据 */
  issuer: string
  /** 本 server 的规范化 URI */
  resource: string
  /** 秒；由调用方注入 */
  now: number
  /** 默认 60 */
  leewaySec?: number
  /** 本次操作需要的全部 scope */
  requiredScopes: string[]
  /** scope 层级：{ 'files:admin': ['files:read', 'files:write'] } */
  implies?: Record<string, string[]>
}

export type CheckResult =
  | { ok: true; sub: string; scopes: string[] }
  | { ok: false; status: 401 | 403; reason: TokenReject; missing?: string[] }

export type Rejected = Extract<CheckResult, { ok: false }>

export const DEFAULT_LEEWAY_SEC = 60

function reject(status: 401 | 403, reason: TokenReject, missing?: string[]): Rejected {
  return missing === undefined ? { ok: false, status, reason } : { ok: false, status, reason, missing }
}

/** 一关检查。过了返回 null，没过返回拒绝结果。 */
export type Step = (t: TokenView, o: CheckOpts) => Rejected | null

const AT_JWT = new Set(['at+jwt', 'application/at+jwt'])

/**
 * RFC 9068 §4：typ 必须是 at+jwt；alg 是 none 必须拒绝。
 * ★ typ 是媒体类型，大小写不敏感（RFC 7515 §4.1.9）；缺失也算错。
 * ★ alg 缺失等于没签名；None / NONE 历史上绕过过只认小写的黑名单，一并拒绝。
 */
export const stepTypAlg: Step = (t) => {
  const { typ, alg } = t.header
  if (typeof typ !== 'string' || !AT_JWT.has(asciiLower(typ))) return reject(401, 'WRONG_TYP')
  if (typeof alg !== 'string' || asciiLower(alg) === 'none') return reject(401, 'ALG_NONE')
  return null
}

/** ★ 逐字相等。RFC 9068："MUST exactly match the value of the iss claim"。尾斜杠也算不同。 */
export const stepIssuer: Step = (t, o) => (t.claims.iss === o.issuer ? null : reject(401, 'WRONG_ISSUER'))

/**
 * ★ aud 先规范成数组，再找一个 === resource 的元素。
 *   `String(aud).includes(resource)` 对字符串是子串匹配：
 *   'https://mcp.example.com.evil.io' 包含 'https://mcp.example.com'。
 */
export const stepAudience: Step = (t, o) =>
  audList(t.claims.aud).includes(o.resource) ? null : reject(401, 'WRONG_AUDIENCE')

/**
 * exp 必填（RFC 9068 §2.2），nbf 可选。两头都给 leeway。
 * ★ 必须是有限数：JSON 里的 1e999 解析出来是 Infinity，`now >= Infinity` 永远是 false。
 * ★ leewaySec 不传时是 undefined，`exp + undefined` 是 NaN，比较永远是 false——token 永不过期。
 */
export const stepLifetime: Step = (t, o) => {
  const leeway = o.leewaySec ?? DEFAULT_LEEWAY_SEC
  const { exp, nbf } = t.claims as { exp?: unknown; nbf?: unknown }
  if (typeof exp !== 'number' || !Number.isFinite(exp) || o.now >= exp + leeway) return reject(401, 'EXPIRED')
  if (nbf !== undefined && nbf !== null) {
    if (typeof nbf !== 'number' || !Number.isFinite(nbf) || o.now < nbf - leeway) return reject(401, 'NOT_YET_VALID')
  }
  return null
}

/**
 * "Servers MUST account for scope hierarchies, where a broader scope implies narrower ones"。
 * missing 按 requiredScopes 的顺序列出缺的。
 */
export const stepScope: Step = (t, o) => {
  const have = new Set(expandScopes(splitScope(t.claims.scope), o.implies))
  const missing = o.requiredScopes.filter((s) => !have.has(s))
  return missing.length === 0 ? null : reject(403, 'INSUFFICIENT_SCOPE', missing)
}

/**
 * ★ 顺序是设计的一部分，不是实现细节：所有 401 类检查必须先于唯一的 403。
 *   一张过期且 scope 不足的 token 先撞上 scope 检查，会得到 403 + insufficient_scope，
 *   客户端于是去 step-up——拿一张过期 token 申请更多权限。正确答案是 401，刷新就完事。
 *   一张别的服务的 token 走到 scope 检查，403 等于告诉对方「token 我收了，只是权限不够」。
 */
export const CHECK_ORDER: readonly Step[] = [stepTypAlg, stepIssuer, stepAudience, stepLifetime, stepScope]

export function runChecks(steps: readonly Step[], t: TokenView | null, o: CheckOpts): CheckResult {
  if (t === null) return reject(401, 'NO_TOKEN')
  for (const step of steps) {
    const r = step(t, o)
    if (r !== null) return r
  }
  const sub = typeof t.claims.sub === 'string' ? t.claims.sub : ''
  return { ok: true, sub, scopes: expandScopes(splitScope(t.claims.scope), o.implies) }
}

export function checkAccessToken(t: TokenView | null, o: CheckOpts): CheckResult {
  return runChecks(CHECK_ORDER, t, o)
}

// ─────────────────────────────────────────────────────────────
// 二、挑战头：生成与解析
//
// 授权失败走的是 JSON-RPC 之下的第三种错误通道：HTTP 状态码 + WWW-Authenticate。
// 模型看不到它，宿主处理。
// ─────────────────────────────────────────────────────────────

/** RFC 6750 §3：error_description 只许可见 ASCII，所以这里不写中文。 */
const DESCRIPTIONS: Record<Exclude<TokenReject, 'NO_TOKEN' | 'INSUFFICIENT_SCOPE'>, string> = {
  WRONG_TYP: 'token type must be at+jwt',
  ALG_NONE: 'unsigned token',
  WRONG_ISSUER: 'issuer mismatch',
  WRONG_AUDIENCE: 'token was not issued for this resource',
  EXPIRED: 'token expired',
  NOT_YET_VALID: 'token not yet valid',
}

function quote(v: string): string {
  return '"' + v.replace(/[\\"]/g, (c) => '\\' + c) + '"'
}

/**
 * 生成 WWW-Authenticate 的值（不含头名）。状态码在 r.status 里。
 *
 *   NO_TOKEN            → Bearer scope=…, resource_metadata=…（RFC 6750 §3.1：没带凭据时不给 error）
 *   INSUFFICIENT_SCOPE  → Bearer error="insufficient_scope", scope=…, resource_metadata=…, error_description=…
 *   其余（401）          → Bearer error="invalid_token", resource_metadata=…, error_description=…
 *
 * ★ scope 写本次操作需要的**全部** scope，不是只报缺的那个：
 *   "servers SHOULD include all scopes required for the current operation in a single challenge"。
 * scope 只出现在 NO_TOKEN（客户端选初始 scope）和 403（step-up）里；token 无效时客户端该做的是
 * 刷新或重新授权，用它之前申请过的那一组。
 */
export function buildChallenge(
  r: CheckResult & { ok: false },
  o: { resourceMetadata: string; requiredScopes: string[] },
): string {
  const scope = o.requiredScopes.join(' ')
  const parts: [string, string][] = []
  if (r.reason === 'NO_TOKEN') {
    if (scope !== '') parts.push(['scope', scope])
    parts.push(['resource_metadata', o.resourceMetadata])
  } else if (r.reason === 'INSUFFICIENT_SCOPE') {
    parts.push(['error', 'insufficient_scope'], ['scope', scope], ['resource_metadata', o.resourceMetadata])
    if (r.missing && r.missing.length > 0) parts.push(['error_description', `missing scopes: ${r.missing.join(' ')}`])
  } else {
    parts.push(['error', 'invalid_token'], ['resource_metadata', o.resourceMetadata])
    parts.push(['error_description', DESCRIPTIONS[r.reason]])
  }
  return 'Bearer ' + parts.map(([k, v]) => `${k}=${quote(v)}`).join(', ')
}

/** scheme 和参数名都已小写化；值原样。 */
export interface Challenge {
  scheme: string
  params: Record<string, string>
}

const TCHAR = "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*/

/**
 * 解析 WWW-Authenticate（RFC 9110 §11.6.1）：
 *
 *   WWW-Authenticate = #challenge
 *   challenge        = auth-scheme [ 1*SP ( token68 / #auth-param ) ]
 *   auth-param       = token BWS "=" BWS ( token / quoted-string )
 *
 * ★ 一个头里可以有多个 challenge，它们之间用逗号分隔——而 challenge 内部的参数**也**用逗号分隔。
 *   区分靠语法：token 后面（跳过空白）紧跟 `=` 的是参数名，否则是下一个 scheme。
 * ★ quoted-string 里的逗号不切，`\x` 表示字面的 x。
 * ★ scheme 和参数名不区分大小写，一律小写化（只折叠 ASCII）。
 *
 * 宽松处理：token68（`Basic dXNlcg==`）认出来跳过；同名参数取第一个；坏掉的片段跳到下一个
 * 不在引号里的逗号；引号没闭合的参数丢掉。
 */
export function parseWwwAuthenticate(header: string): Challenge[] {
  const s = header
  const n = s.length
  const out: Challenge[] = []
  let cur: Challenge | null = null
  let i = 0

  const ws = () => {
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++
  }
  const token = (): string => {
    const start = i
    while (i < n && TCHAR.includes(s[i]!)) i++
    return s.slice(start, i)
  }
  /** i 指向开头的引号。没闭合返回 null。 */
  const quoted = (): string | null => {
    i++
    let v = ''
    while (i < n) {
      const c = s[i]!
      if (c === '"') {
        i++
        return v
      }
      if (c === '\\' && i + 1 < n) {
        v += s[i + 1]
        i += 2
        continue
      }
      v += c
      i++
    }
    return null
  }
  const skipToComma = () => {
    while (i < n && s[i] !== ',') {
      if (s[i] === '"') quoted()
      else i++
    }
  }

  while (i < n) {
    ws()
    if (i >= n) break
    if (s[i] === ',') {
      i++
      continue
    }
    const name = token()
    if (name === '') {
      skipToComma()
      continue
    }
    ws()
    if (s[i] === '=') {
      // 参数。还没有 scheme 就出现参数，是坏的。
      if (cur === null) {
        skipToComma()
        continue
      }
      i++
      ws()
      let value: string | null
      if (s[i] === '"') value = quoted()
      else {
        value = token()
        if (value === '') value = null
      }
      if (value === null) {
        skipToComma()
        continue
      }
      const key = asciiLower(name)
      if (!hasOwn(cur.params, key)) cur.params[key] = value
      ws()
      if (i < n && s[i] !== ',') skipToComma()
      continue
    }
    cur = { scheme: asciiLower(name), params: dict<string>() }
    out.push(cur)
    const m = TOKEN68.exec(s.slice(i))
    if (m) {
      let j = i + m[0].length
      while (j < n && (s[j] === ' ' || s[j] === '\t')) j++
      if (j >= n || s[j] === ',') i = j
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// 三、发现：候选 URL 的顺序 + 元数据校验
//
// 两段发现、五个候选 URL、两次逐字比较：
//   401 → PRM（资源元数据，RFC 9728）→ authorization_servers → AS 元数据（RFC 8414 / OIDC）
// ─────────────────────────────────────────────────────────────

export const PRM_SUFFIX = '/.well-known/oauth-protected-resource'
export const OAUTH_AS_SUFFIX = '/.well-known/oauth-authorization-server'
export const OIDC_SUFFIX = '/.well-known/openid-configuration'

/**
 * PRM 的候选 URL，按请求顺序。
 *
 * "use the resource metadata URL from the parsed WWW-Authenticate headers when present;
 *  otherwise, they MUST fall back to constructing and requesting the well-known URIs in the order listed above."
 *
 *   挑战里（任一 challenge）有 resource_metadata → 只有它
 *   否则 ① 路径插入：scheme://authority + PRM_SUFFIX + path + ?query
 *        ② 根：      scheme://authority + PRM_SUFFIX
 *   MCP 端点在根上时 ① 和 ② 相同，只返回一个。
 *
 * ★ RFC 9728 §3.1：插入前要去掉「host 后面那个结尾的 /」。`https://example.com/` 的 path 是 '/'，
 *   不去掉的话会生成 `…/oauth-protected-resource/` 这个错误候选，去重也失效。
 *   new URL('https://example.com').pathname 本来就是 '/'。
 * resource_metadata 在真正请求前还要过 SSRF 检查（拦私网段、169.254.169.254），那是 fetch 层的事。
 */
export function prmCandidates(mcpUrl: string, challenges: Challenge[]): string[] {
  for (const c of challenges) {
    if (hasOwn(c.params, 'resource_metadata')) return [c.params['resource_metadata']!]
  }
  const u = splitUri(mcpUrl)
  if (!u.scheme || !u.authority || u.fragment !== undefined) return []
  const origin = `${u.scheme}://${u.authority}`
  const path = u.path === '/' ? '' : u.path
  const query = u.query === undefined ? '' : `?${u.query}`
  const root = origin + PRM_SUFFIX
  const inserted = root + path + query
  return inserted === root ? [root] : [inserted, root]
}

/**
 * AS 元数据的候选 URL，按规范的优先级。
 *
 *   issuer 有路径：① OAuth 路径插入  ② OIDC 路径插入  ③ OIDC 路径追加
 *   issuer 无路径：① OAuth           ② OIDC
 *
 * ③ 是给 Keycloak realm（/realms/xxx）这类多租户 IdP 留的：它们只在路径追加的位置发布 OIDC 配置。
 * OIDC Discovery §4：追加前去掉 issuer 末尾的 /。
 * RFC 8414：issuer 没有 query 和 fragment；带了就不是合法 issuer，返回 []。
 */
export function asMetadataCandidates(issuer: string): string[] {
  const u = splitUri(issuer)
  if (!u.scheme || !u.authority || u.query !== undefined || u.fragment !== undefined) return []
  const origin = `${u.scheme}://${u.authority}`
  const path = u.path === '/' ? '' : u.path
  if (path === '') return [origin + OAUTH_AS_SUFFIX, origin + OIDC_SUFFIX]
  return [
    origin + OAUTH_AS_SUFFIX + path,
    origin + OIDC_SUFFIX + path,
    origin + path.replace(/\/$/, '') + OIDC_SUFFIX,
  ]
}

export type MetaReject = 'RESOURCE_MISMATCH' | 'NO_AUTH_SERVERS' | 'ISSUER_MISMATCH' | 'NO_PKCE' | 'NO_S256'

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/**
 * 校验拿回来的 PRM。
 *
 * ★ RFC 9728 §3.3："The resource value returned MUST be identical to the protected resource's
 *   resource identifier ... If these values are not identical, the data contained in the response
 *   MUST NOT be used." 从挑战里的 resource_metadata 拿到的，要和「请求资源时用的那个 URL」相等——
 *   expectedResource 由调用方按来源决定。
 * "MUST include the authorization_servers field containing at least one authorization server."
 */
export function validatePrm(
  doc: unknown,
  expectedResource: string,
): { ok: true; authServers: string[] } | { ok: false; reason: MetaReject } {
  if (!isObject(doc) || doc['resource'] !== expectedResource) return { ok: false, reason: 'RESOURCE_MISMATCH' }
  const raw = doc['authorization_servers']
  const servers = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  if (servers.length === 0) return { ok: false, reason: 'NO_AUTH_SERVERS' }
  return { ok: true, authServers: servers }
}

/**
 * 校验拿回来的 AS 元数据。
 *
 * ★ "the issuer value in the document MUST be identical to the issuer identifier used to construct
 *   the well-known URL"。规范原例：从 https://attacker.example 拿到的文档里写着
 *   "issuer": "https://honest.example"，必须拒绝（GHSA-qx49 漏的就是回退路径上的这一条）。
 * ★ "If code_challenge_methods_supported is absent ... MCP clients MUST refuse to proceed."
 *   缺失或空数组 → NO_PKCE；有但没有 S256 → NO_S256（plain 不算）。
 */
export function validateAsMetadata(doc: unknown, issuerUsed: string): { ok: true } | { ok: false; reason: MetaReject } {
  if (!isObject(doc) || doc['issuer'] !== issuerUsed) return { ok: false, reason: 'ISSUER_MISMATCH' }
  const methods = doc['code_challenge_methods_supported']
  if (!Array.isArray(methods) || methods.length === 0) return { ok: false, reason: 'NO_PKCE' }
  if (!methods.includes('S256')) return { ok: false, reason: 'NO_S256' }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────
// 四、客户端：授权响应与 step-up
// ─────────────────────────────────────────────────────────────

/**
 * RFC 9207 的 iss 校验，规范里的四行表：
 *
 *   支持声明（authorization_response_iss_parameter_supported）   响应里有 iss   动作
 *   true                                                          有             逐字比较
 *   true                                                          没有           reject
 *   false 或缺失                                                   有             逐字比较
 *   false 或缺失                                                   没有           proceed
 *
 * 第三行比 RFC 9207 严：MCP 选的 local policy 是「带了就比」。
 * ★ "clients MUST NOT apply scheme or host case folding, default-port elision, trailing-slash,
 *   or percent-encoding normalization ... before comparison." 任何宽容都是一个可被利用的等价类。
 * 只有 supportsIss === true 才算声明了支持。
 */
export function checkIssResponse(a: {
  supportsIss: boolean | undefined
  iss: string | undefined
  recorded: string
}): 'proceed' | 'reject' {
  if (a.iss !== undefined) return a.iss === a.recorded ? 'proceed' : 'reject'
  return a.supportsIss === true ? 'reject' : 'proceed'
}

/**
 * step-up 时申请的 scope：之前申请过的 ∪ 这次挑战里的，去重，按码点排序。
 *
 * "Determine required scopes by computing the union of the client's previously requested scope set
 *  and the scopes from the current challenge." / "Scope accumulation across operations is a
 *  client-side responsibility."
 * ★ 直接用挑战里的 scope 重新授权：拿到写权限，丢了读权限，下一次读又是 403。
 */
export function stepUpScopes(previous: string[], challenged: string[]): string[] {
  return [...new Set([...previous, ...challenged].filter((s) => s !== ''))].sort(cmpCp)
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** authority → host（去掉 userinfo 和端口）。拆不出来返回 null。 */
function hostOf(authority: string | undefined): string | null {
  if (authority === undefined) return null
  const hp = authority.slice(authority.lastIndexOf('@') + 1)
  const m = /^(\[[^\]]*\]|[^:]*)(?::[0-9]*)?$/.exec(hp)
  if (!m || m[1] === '') return null
  return m[1]!
}

/**
 * 要交给浏览器打开的授权 URL（authorization_endpoint 等，来自可能恶意的 server）。
 *
 * ★ 白名单，不是黑名单："SHOULD use allowlist-based validation rather than blocklist-based approaches"。
 *   https 放行；http 只放行 loopback（127.0.0.1 / localhost / [::1]）；其余 scheme 一律 BAD_SCHEME。
 *   CVE-2025-6514 的 PoC 就是一个 URL：file:/c:/windows/system32/calc.exe。
 * ★ host 要先去掉 userinfo：http://127.0.0.1@evil.com/ 的 host 是 evil.com。
 * 出现空白、控制字符、非 ASCII 的不是合法 URI → UNPARSEABLE。
 * 打开时也不许经过 shell（"MUST NOT use shell commands ... to open URLs"），那是调用方的事。
 */
export function validateAuthUrl(
  url: string,
): { ok: true } | { ok: false; reason: 'BAD_SCHEME' | 'HTTP_NOT_LOOPBACK' | 'UNPARSEABLE' } {
  if (!/^[\x21-\x7e]+$/.test(url)) return { ok: false, reason: 'UNPARSEABLE' }
  const u = splitUri(url)
  if (u.scheme === undefined) return { ok: false, reason: 'UNPARSEABLE' }
  const scheme = asciiLower(u.scheme)
  if (scheme !== 'https' && scheme !== 'http') return { ok: false, reason: 'BAD_SCHEME' }
  const host = hostOf(u.authority)
  if (host === null) return { ok: false, reason: 'UNPARSEABLE' }
  if (scheme === 'https' || LOOPBACK.has(asciiLower(host))) return { ok: true }
  return { ok: false, reason: 'HTTP_NOT_LOOPBACK' }
}

// ─────────────────────────────────────────────────────────────
// 五、下游调用：禁止透传
// ─────────────────────────────────────────────────────────────

export type Downstream = 'OK' | 'PASSTHROUGH' | 'WRONG_AUDIENCE'

/**
 * MCP server 调下游 API 时，准备带上的那张 token 能不能发。
 *
 * "The access token used at the upstream API is a separate token, issued by the upstream
 *  authorization server. The MCP server MUST NOT pass through the token it received from the MCP client."
 *
 *   和入站 token 是同一张（原始字符串相等） → PASSTHROUGH
 *   aud 里有自己                              → PASSTHROUGH（换了张皮的透传：下游拿着它能回头调你）
 *   aud 里没有下游                            → WRONG_AUDIENCE
 *   否则                                      → OK
 *
 * 出站 token 的三条合法来路（再走一次授权码、RFC 8693 换票、client credentials）有一个共同点：
 * 出站 ≠ 入站，且出站的 aud = 那个下游。
 */
export function decideDownstreamAuth(a: {
  inboundRaw: string
  outboundRaw: string
  outboundAud: string | string[] | undefined
  self: string
  downstream: string
}): Downstream {
  if (a.outboundRaw === a.inboundRaw) return 'PASSTHROUGH'
  const aud = audList(a.outboundAud)
  if (aud.includes(a.self)) return 'PASSTHROUGH'
  if (!aud.includes(a.downstream)) return 'WRONG_AUDIENCE'
  return 'OK'
}
