/**
 * L10 任务三：远程 MCP 的授权。跑法：pnpm mcp:auth
 *
 * server.ts 和 client.ts 练的是「管子」：拆帧、id、两种错误。这个文件练的是「门」：
 * 一张 token 收不收、回 401 还是 403、AS 去哪找、step-up 要哪些 scope、调下游能不能带这张 token。
 *
 * 全部是字符串和集合运算——零网络、零加密、零模型，也不读时钟（now 由调用方注入）。
 * 签名验证假设已由 jose / PyJWT 做完；这里只练签名之后的策略判断。
 * 参考实现在 shared/mcpauth.ts。写完 TODO 10–13 跑 pnpm verify:l10，授权那一组在最后。
 */

import {
  buildChallenge,
  checkAccessToken,
  parseWwwAuthenticate,
  prmCandidates,
  asMetadataCandidates,
  validatePrm,
  validateAsMetadata,
  validateAuthUrl,
  stepUpScopes,
  runChecks,
  stepTypAlg,
  stepIssuer,
  stepAudience,
  stepLifetime,
  stepScope,
  type Challenge,
  type CheckOpts,
  type CheckResult,
  type Downstream,
  type Step,
  type TokenView,
} from '../shared/mcpauth.ts'
import { isMain } from '../shared/entry.ts'

// 这四个直接用参考实现，verify 从这里拿，所以本模块对外是完整的一套 API。
export { buildChallenge, validatePrm, validateAsMetadata, validateAuthUrl } from '../shared/mcpauth.ts'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const w = (s: string) =>
  [...visible(s)].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - w(s)))

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────

const NOW = 1_800_000_000
const ISS = 'https://auth.example.com'
const RES = 'https://mcp.example.com'
const PRM = RES + '/.well-known/oauth-protected-resource'

/** 操作是「写文件」。 */
const WRITE: CheckOpts = {
  issuer: ISS,
  resource: RES,
  now: NOW,
  requiredScopes: ['files:read', 'files:write'],
  implies: { 'files:admin': ['files:read', 'files:write'] },
}

function tok(claims: Partial<TokenView['claims']> = {}, header: TokenView['header'] = {}): TokenView {
  return {
    header: { typ: 'at+jwt', alg: 'RS256', ...header },
    claims: { iss: ISS, aud: RES, exp: NOW + 3600, sub: 'alice', scope: 'files:read files:write', ...claims },
  }
}

const show = (r: CheckResult) => (r.ok ? 'ok' : `${r.status} ${r.reason}`)
const verdict = (r: { ok: true } | { ok: false; reason: string }) => (r.ok ? 'ok' : r.reason)

// 两个「差一点」的检查器，用参考实现的检查关卡拼出来。

/** naive-A：aud 用 includes 比。TODO 14 会让你在自己的实现里做同样的事。 */
const naiveAudience: Step = (t, o) =>
  String(t.claims.aud).includes(o.resource) ? null : { ok: false, status: 401, reason: 'WRONG_AUDIENCE' }
const naiveA = (t: TokenView, o: CheckOpts) =>
  runChecks([stepTypAlg, stepIssuer, naiveAudience, stepLifetime, stepScope], t, o)

/** naive-B：scope 挪到 exp 前面。TODO 15。 */
const naiveB = (t: TokenView, o: CheckOpts) =>
  runChecks([stepTypAlg, stepIssuer, stepAudience, stepScope, stepLifetime], t, o)

// ─────────────────────────────────────────────────────────────

function exp1(): void {
  console.log(bold('\n实验一：十张 token，一个参考实现，两个「差一点」的实现'))
  console.log(dim(`  操作是「写文件」，要 files:read files:write；files:admin 蕴含这两个。now = ${NOW}，leeway 60 秒。`))
  const rows: [string, TokenView][] = [
    ['合法', tok()],
    ['aud 是别的服务', tok({ aud: 'https://other.example.com' })],
    ['aud 后缀攻击 .evil.io', tok({ aud: 'https://mcp.example.com.evil.io' })],
    ['iss 多一个尾斜杠', tok({ iss: ISS + '/' })],
    ['ID Token（typ: JWT）', tok({}, { typ: 'JWT' })],
    ['alg: none', tok({}, { alg: 'none' })],
    ['过期，scope 也不够', tok({ exp: NOW - 600, scope: 'files:read' })],
    ['只是 scope 不够', tok({ scope: 'files:read' })],
    ['只有 files:admin', tok({ scope: 'files:admin' })],
    ['过期 30 秒（leeway 内）', tok({ exp: NOW - 30 })],
  ]
  console.log(`  ${pad('#', 4)}${pad('token', 26)}${pad('参考实现', 24)}${pad('naive-A：aud.includes', 26)}naive-B：先查 scope`)
  console.log('  ' + '─'.repeat(98))
  rows.forEach(([label, t], i) => {
    const ref = show(checkAccessToken(t, WRITE))
    const mark = (s: string) => (s === ref ? s : bold(s + ' ✗'))
    const a = mark(show(naiveA(t, WRITE)))
    const b = mark(show(naiveB(t, WRITE)))
    console.log(`  ${pad(String(i + 1), 4)}${pad(label, 26)}${pad(ref, 24)}${pad(a, 26)}${b}`)
  })
  console.log(dim('\n  naive-A 只错在第 3 行。第 2 行那个最明显的用例它是对的——这个 bug 就是这样活到生产的（TODO 14）。'))
  console.log(dim('  naive-B 只错在第 7 行。客户端收到 403 会去 step-up，为一张已经过期的 token 弹授权页；'))
  console.log(dim('  正确答案是 401，刷新一下就完事（TODO 15）。'))
}

// ─────────────────────────────────────────────────────────────

function exp2(): void {
  console.log(bold('\n实验二：401 之后去哪找——两段发现，五个候选 URL'))
  const prmCases: [string, string, Challenge[]][] = [
    ['MCP 端点带路径，挑战里没有 resource_metadata', 'https://example.com/public/mcp', []],
    ['MCP 端点在根上（末尾一个 /）', 'https://example.com/', []],
    ['挑战里有 resource_metadata', 'https://mcp.example.com/mcp', parseWwwAuthenticate(`Bearer resource_metadata="${PRM}"`)],
  ]
  console.log('  第一段：PRM（RFC 9728），按顺序请求')
  for (const [label, url, ch] of prmCases) {
    console.log(dim(`  ${label}：${url}`))
    prmCandidates(url, ch).forEach((c, i) => console.log(`    ${i + 1}. ${c}`))
  }
  const asCases: [string, string][] = [
    ['issuer 没有路径', 'https://auth.example.com'],
    ['issuer 带租户路径', 'https://auth.example.com/tenant1'],
    ['Keycloak realm', 'https://sso.example.cn/realms/agents'],
  ]
  console.log('\n  第二段：AS 元数据（RFC 8414 / OIDC Discovery），按顺序请求')
  for (const [label, issuer] of asCases) {
    console.log(dim(`  ${label}：${issuer}`))
    asMetadataCandidates(issuer).forEach((c, i) => console.log(`    ${i + 1}. ${c}`))
  }
  console.log(dim('\n  第 3 个候选（路径追加）是给 Keycloak realm 这类多租户 IdP 留的。'))

  console.log(bold('\n  拿回来的文档，一样一样查'))
  const rows: [string, string][] = [
    [
      'PRM：resource 和请求时用的 URL 逐字相等',
      verdict(validatePrm({ resource: 'https://example.com/public/mcp', authorization_servers: [ISS] }, 'https://example.com/public/mcp')),
    ],
    [
      'PRM：resource 多一个尾斜杠',
      verdict(validatePrm({ resource: 'https://example.com/public/mcp/', authorization_servers: [ISS] }, 'https://example.com/public/mcp')),
    ],
    [
      'attacker.example 上的文档写着 issuer: honest.example',
      verdict(validateAsMetadata({ issuer: 'https://honest.example', code_challenge_methods_supported: ['S256'] }, 'https://attacker.example')),
    ],
    ['AS 元数据没有 code_challenge_methods_supported', verdict(validateAsMetadata({ issuer: ISS }, ISS))],
    ['authorization_endpoint: file:/c:/windows/system32/calc.exe', verdict(validateAuthUrl('file:/c:/windows/system32/calc.exe'))],
  ]
  console.log(`  ${pad('文档', 60)}结论`)
  console.log('  ' + '─'.repeat(80))
  for (const [label, v] of rows) console.log(`  ${pad(label, 60)}${v}`)
  console.log(dim('\n  两次逐字比较：PRM 的 resource、AS 元数据的 issuer。GHSA-qx49：主路径做对了，回退路径漏了后一条。'))
  console.log(dim('  最后一行是 CVE-2025-6514 的 PoC 原样：授权 URL 来自可能恶意的 server，只许 https 或 loopback 的 http。'))
}

// ─────────────────────────────────────────────────────────────

function exp3(): void {
  console.log(bold('\n实验三：step-up 取并集，还是直接用挑战里的 scope'))
  const ops: [string, string][] = [
    ['列目录', 'files:read'],
    ['写文件', 'files:write'],
    ['生成分享链接', 'files:share'],
  ]
  const canList = (scopes: string[]) =>
    checkAccessToken(tok({ scope: scopes.join(' ') }), { ...WRITE, requiredScopes: ['files:read'] }).ok ? '✓' : '✗ 403'
  console.log(`  ${pad('#', 4)}${pad('操作', 14)}${pad('挑战里的 scope', 16)}${pad('并集（规范）', 38)}${pad('替换（naive）', 16)}回头再列目录：并集 / 替换`)
  console.log('  ' + '─'.repeat(110))
  let union: string[] = []
  ops.forEach(([op, sc], i) => {
    union = stepUpScopes(union, [sc])
    const replaced = [sc]
    console.log(
      `  ${pad(String(i + 1), 4)}${pad(op, 14)}${pad(sc, 16)}${pad(union.join(' '), 38)}${pad(replaced.join(' '), 16)}${canList(union)} / ${canList(replaced)}`,
    )
  })
  console.log(dim('\n  替换的客户端每做一件新事就丢一件旧事：拿到写权限，下一次列目录又是 403，又一个授权页。'))
  console.log(dim('  规范："Scope accumulation across operations is a client-side responsibility."'))
  console.log(dim('  另外要给 step-up 设上限：一个永远回 403 的 server 加一个不设上限的客户端，就是无限弹窗。'))
}

// ─────────────────────────────────────────────────────────────

/** 常见的错误写法：去掉 Bearer 前缀，按逗号切，再按第一个等号切，剥掉两头的引号。 */
function naiveParse(h: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  for (const part of h.replace(/^Bearer\s+/i, '').split(',')) {
    const [k = '', ...v] = part.trim().split('=')
    out[k] = v.join('=').replace(/^"|"$/g, '')
  }
  return out
}

function exp4(): void {
  console.log(bold('\n实验四：WWW-Authenticate 不是「逗号分隔的 key=value」'))
  const r = checkAccessToken(tok({ scope: 'files:read' }), WRITE)
  if (r.ok) throw new Error('夹具写错了')
  const headers: Record<string, string> = {
    A: 'Basic realm="x", Bearer resource_metadata="https://m/.well-known/oauth-protected-resource", error_description="a, b", scope="files:read"',
    B: 'Bearer error="invalid_token", error_description="say \\"hi\\", then retry"',
    C: 'BEARER Scope="files:read files:write"',
    D: buildChallenge(r, { resourceMetadata: PRM, requiredScopes: WRITE.requiredScopes }),
  }
  for (const [k, h] of Object.entries(headers)) console.log(dim(`  ${k}  ${h}`))
  console.log(dim('     （D 是实验一第 8 行的 403，buildChallenge 生成）'))
  const rows: [string, string][] = [
    ['A', 'error_description'],
    ['A', 'resource_metadata'],
    ['B', 'error_description'],
    ['C', 'scope'],
    ['D', 'scope'],
  ]
  const cell = (v: string | undefined) => (v === undefined ? '（没有）' : `「${v}」`)
  console.log(`\n  ${pad('头', 4)}${pad('Bearer 的参数', 20)}${pad("naive split(',')", 30)}RFC 9110 解析`)
  console.log('  ' + '─'.repeat(100))
  for (const [k, param] of rows) {
    const h = headers[k]!
    const naive = cell(naiveParse(h)[param])
    const proper = cell(parseWwwAuthenticate(h).find((c) => c.scheme === 'bearer')?.params[param])
    console.log(`  ${pad(k, 4)}${pad(param, 20)}${pad(naive === proper ? naive : bold(naive), 30)}${proper}`)
  }
  console.log(dim('\n  naive 在 D 上全对——拿自己生成的头当测试夹具，永远测不出它。'))
  console.log(dim('  A 的第二行最贵：resource_metadata 丢了，客户端只好去猜 well-known；PRM 不在默认位置时发现直接失败。'))
}

function observe(): void {
  console.log(bold('L10 · 远程 MCP 的授权（观察实验，参考实现）'))
  console.log(dim('零网络、零加密、零模型。每张表对应一条「直觉是反的」。'))
  exp1()
  exp2()
  exp3()
  exp4()
  console.log(bold('\n最该记住的'))
  console.log('  1. 所有 401 先于 403。检查顺序是设计：过期就回 401，别让客户端为一张死 token 弹授权页。')
  console.log('  2. aud、iss、resource、issuer 全部逐字比较。includes 和「规范化一下」都能过最明显的那个用例。')
  console.log('  3. step-up 取并集，累积 scope 是客户端的责任；重试要有上限。')
  console.log('  4. 签名交给库。出事的从来不是签名，是签名之后的这几行判断。')
}

// ── TODO ─────────────────────────────────────────────────────
//
// 编号接着 server.ts 的 TODO 1–9。契约的完整版在 shared/mcpauth.ts 对应函数的注释里。
// buildChallenge / validatePrm / validateAsMetadata / validateAuthUrl 已经提供（上面的 export）。

/**
 * TODO 10 ★★ 资源服务器收到一张 token（签名已验过），决定收不收。
 *
 * 规范："MCP servers MUST validate that access tokens were issued specifically for them as the
 * intended audience" / "Invalid or expired tokens MUST receive a HTTP 401 response."
 *
 * 顺序就是设计：typ/alg → iss → aud → exp/nbf → scope。只有 scope 不够是 403，其余全是 401。
 *   · t 为 null → NO_TOKEN
 *   · typ 必须是 at+jwt 或 application/at+jwt（媒体类型，ASCII 大小写不敏感；缺失也算错）→ WRONG_TYP
 *   · alg 缺失或是 none（ASCII 大小写不敏感）→ ALG_NONE
 *   · iss 和 o.issuer 逐字相等 → 否则 WRONG_ISSUER
 *   · aud 可能是字符串也可能是数组；o.resource 必须等于其中一个元素 → 否则 WRONG_AUDIENCE
 *   · exp 缺失、不是有限数、或 now >= exp + leeway → EXPIRED；nbf 有值且（不是有限数或 now < nbf - leeway）→ NOT_YET_VALID
 *     leewaySec 默认 60
 *   · scope 是空格分隔的字符串；implies 里宽的 scope 蕴含窄的（可传递）。
 *     缺 → 403 INSUFFICIENT_SCOPE，missing 按 requiredScopes 的顺序列出缺的那些
 *   · 通过 → { ok: true, sub, scopes }：sub 缺失时是 ''；scopes 是展开 implies 之后的集合，按码点排序
 *
 * 坑：aud 是字符串时 includes 是子串匹配（TODO 14）；先查 scope 再查 exp，过期 token 会拿到 403（TODO 15）；
 *     leewaySec 没传时 `exp + undefined` 是 NaN，比较永远是 false——token 永不过期。
 */
export function myCheckAccessToken(t: TokenView | null, o: CheckOpts): CheckResult {
  throw new Error('TODO 10 未实现')
}

/**
 * TODO 11 ★★ 解析 WWW-Authenticate（RFC 9110 §11.6.1），返回其中所有的 challenge。
 *
 *   challenge  = auth-scheme [ 1*SP ( token68 / #auth-param ) ]
 *   auth-param = token BWS "=" BWS ( token / quoted-string )
 *
 * 一个头里可以有多个 challenge，用逗号分隔——而 challenge 内部的参数**也**用逗号分隔。
 * 语法上的判别：参数是 `token =`，新的 challenge 是一个后面不跟 `=` 的 token。
 *   · quoted-string 里的逗号不切；`\x` 表示字面的 x
 *   · scheme 和参数名不区分大小写，一律小写化（只折叠 ASCII）；值原样保留
 *   · token68（如 `Basic dXNlcg==`）认出来跳过；同名参数取第一个；
 *     坏掉的片段跳到下一个不在引号里的逗号；引号没闭合的参数丢掉
 *   · params 用 Object.create(null)：参数名是对面服务器给的，`__proto__` 也可能出现
 *
 * 坑：split(',') 会把 error_description="a, b" 切成两半，而且分不清「下一个参数」和「下一个 challenge」——
 *     resource_metadata 拿不到，客户端只好去猜 well-known（实验四）。
 */
export function myParseWwwAuthenticate(header: string): Challenge[] {
  throw new Error('TODO 11 未实现')
}

/**
 * TODO 12 ★ 发现阶段的候选 URL，按规范顺序。
 *
 * 规范："use the resource metadata URL from the parsed WWW-Authenticate headers when present;
 * otherwise, they MUST fall back to constructing and requesting the well-known URIs in the order listed above."
 *
 * myPrmCandidates：任一 challenge 的 params 里有 resource_metadata → 只返回它；否则
 *   ① scheme://authority/.well-known/oauth-protected-resource<path><?query>（路径插入）
 *   ② scheme://authority/.well-known/oauth-protected-resource（根）
 *   两者相同时（端点在根上）只返回一个。拆不出 scheme 和 authority，或带 fragment → []。
 * myAsMetadataCandidates：issuer 有路径 → OAuth 插入、OIDC 插入、OIDC 追加（三个）；
 *   没有路径 → OAuth、OIDC（两个）。拆不出 scheme 和 authority，或带 query / fragment → []。
 *
 * RFC 9728 §3.1 / RFC 8414 §3.1：插入之前去掉「host 后面那个结尾的 /」；OIDC 追加之前去掉 issuer 末尾的 /。
 * URL 原样拆，不规范化（不改大小写、不动端口）——后面的校验是逐字比较。
 *
 * 坑：new URL('https://example.com').pathname 是 '/'，不是 ''。直接拼会得到
 *     `…/oauth-protected-resource/` 这个错误候选，去重也跟着失效。
 */
export function myPrmCandidates(mcpUrl: string, challenges: Challenge[]): string[] {
  throw new Error('TODO 12 未实现')
}

export function myAsMetadataCandidates(issuer: string): string[] {
  throw new Error('TODO 12 未实现')
}

/**
 * TODO 13 ★ 客户端和网关侧的三个小判断。
 *
 * myCheckIssResponse：RFC 9207 的四行表。响应里有 iss 就和 recorded 逐字比较，不管元数据声明没声明；
 *   声明了支持（supportsIss === true）却没带 → reject；都没有 → proceed。
 *   规范："clients MUST NOT apply scheme or host case folding, default-port elision, trailing-slash,
 *   or percent-encoding normalization ... before comparison."
 *   坑：「先小写化再比更健壮」——它恰好造出了一个攻击者可以利用的等价类。
 *
 * myStepUpScopes：之前申请过的 ∪ 这次挑战里的，去重，按码点排序。
 *   规范："computing the union of the client's previously requested scope set and the scopes from the current challenge"
 *   坑：直接用挑战里的 scope 重新授权——拿到写权限，丢了读权限（实验三）。
 *
 * myDecideDownstreamAuth：MCP server 调下游时准备带的那张 token 能不能发。
 *   和入站 token 原始字符串相等 → PASSTHROUGH；aud 里有 self → PASSTHROUGH；aud 里没有 downstream → WRONG_AUDIENCE；否则 OK。
 *   规范："The MCP server MUST NOT pass through the token it received from the MCP client."
 *   坑：只比原始字符串。重新签一张 aud 还是自己的 token，下游拿着它照样能回头调你。
 */
export function myCheckIssResponse(a: {
  supportsIss: boolean | undefined
  iss: string | undefined
  recorded: string
}): 'proceed' | 'reject' {
  throw new Error('TODO 13 未实现')
}

export function myStepUpScopes(previous: string[], challenged: string[]): string[] {
  throw new Error('TODO 13 未实现')
}

export function myDecideDownstreamAuth(a: {
  inboundRaw: string
  outboundRaw: string
  outboundAud: string | string[] | undefined
  self: string
  downstream: string
}): Downstream {
  throw new Error('TODO 13 未实现')
}

// ─────────────────────────────────────────────────────────────
// TODO 14（没有代码）：把你的 aud 比较换成 String(aud).includes(resource)
//
// 然后重跑 pnpm verify:l10。授权那一组里只有 MA-2 会红——**MA-1 仍然是绿的**，
// 因为 'https://other.example.com'.includes('https://mcp.example.com') 是 false。
//
// 这正是这个 bug 在生产里活下来的方式：最明显的那个用例测不出它。
// 想一想：你的项目里，有哪些「比较」其实是 includes / startsWith / 正则的部分匹配？
//
// ─────────────────────────────────────────────────────────────
// TODO 15（没有代码）：把 scope 检查挪到 exp 检查前面
//
// 重跑，只有 MA-6 会红：一张过期且 scope 不够的 token，现在拿到的是 403。
//
// 然后想一下真实客户端收到这个 403 会做什么：它照规范去 step-up，
// 弹一个授权页，让用户给一张**已经过期**的 token 加权限。用户点了同意，
// 拿回来的新 token 是好的，于是这件事看起来「能用」——只是每次 token 过期都多弹一次窗。
// 正确答案是 401：客户端拿 refresh token 换一张，用户什么都看不到。
// ─────────────────────────────────────────────────────────────

void myCheckAccessToken
void myParseWwwAuthenticate
void myPrmCandidates
void myAsMetadataCandidates
void myCheckIssResponse
void myStepUpScopes
void myDecideDownstreamAuth

if (isMain(import.meta.url)) {
  observe()
  console.log(
    dim('\n  下一步：实现 TODO 10–13，然后跑 pnpm verify:l10（或 uv run python -m l10.verify），授权那一组在最后。') +
      dim('\n  想先确认测试本身是对的，跑 VERIFY_TARGET=shared 下的 verify。') +
      dim('\n  观察实验：pnpm mcp:auth / uv run python -m l10.auth\n'),
  )
}
