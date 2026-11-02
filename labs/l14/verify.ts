/**
 * 验证 l14/inject.ts。跑法：pnpm verify:l14
 * 先跑 GUARD_IMPL=shared pnpm verify:l14 确认测试本身是对的。
 *
 * 一次模型都不调。★ 这不是省事——是这一节的核心论点：
 * **做授权判断的那段代码，绝不能读那段不可信的数据。**
 * 一个需要调模型才能判的门，就是一个能被那段数据说服的门。
 *
 * 带 ★ 的每一条对应一种"看起来防住了但没有"：
 * 检查工具名而不是参数、把 payload 和 destination 当成一回事、
 * 漏掉一次 combine、先判过滤再判可见性、reviewer 出错时放行、
 * 熔断器不展开命令替换、只哈希 description、只报一个轴。
 *
 * 它们的共同点和 L13 一样：**全都不抛异常，而且日志上是绿的。**
 */

import * as shared from '../shared/guard.ts'
import type { Action, Channel, SandboxSpec, SessionCaps, SuiteCase, ToolDescriptor } from '../shared/guard.ts'
import { CONTRACTS } from '../shared/guard.ts'

const TARGET = process.env.GUARD_IMPL === 'shared' ? 'shared' : 'mine'
const mine = (await import('./inject.ts')) as unknown as {
  makeFlow: typeof shared.makeFlow
  checkCall: typeof shared.checkCall
  trifecta: typeof shared.trifecta
  auditChannels: typeof shared.auditChannels
  circuitBreaker: typeof shared.circuitBreaker
  makeGate: typeof shared.makeGate
  pinTools: typeof shared.pinTools
  checkDrift: typeof shared.checkDrift
  twoAxis: typeof shared.twoAxis
  claimIsComparable: typeof shared.claimIsComparable
}
const M = TARGET === 'shared' ? shared : mine

console.log(TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l14/ 里你的实现）')

let passed = 0
const failures: string[] = []

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`\x1b[32m  ✓ ${name}\x1b[0m`)
  } catch (err) {
    failures.push(name)
    console.log(`\x1b[31m  ✕ ${name}\x1b[0m`)
    for (const l of String((err as Error).message).split('\n')) console.log(`\x1b[31m      ${l}\x1b[0m`)
  }
}

function eq(a: unknown, b: unknown, msg = '') {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)]
  if (x !== y) throw new Error(`${msg}\n  期望 ${y}\n  实际 ${x}`)
}
function ok(c: boolean, msg = '') {
  if (!c) throw new Error(msg)
}
function near(a: number, b: number, tol = 1e-9, msg = '') {
  if (Math.abs(a - b) > tol) throw new Error(`${msg}\n  期望 ≈${b}\n  实际 ${a}`)
}

const USER = { origin: 'user' as const, source: 'cli', trusted: true }
const CONFIG = { origin: 'config' as const, source: 'settings.json', trusted: true }
const WEB = { origin: 'tool' as const, source: 'fetch_url', trusted: false }

// ─────────────────────────────────────────────────────────
console.log('\n一、来源标记（provenance）')

await test('user 和 config 是可信的，tool 不是', () => {
  const f = M.makeFlow()
  ok(!f.tainted(f.fresh(1, USER)))
  ok(!f.tainted(f.fresh(1, CONFIG)))
  ok(f.tainted(f.fresh(1, WEB)))
})

await test('派生值继承所有上游来源', () => {
  const f = M.makeFlow()
  const a = f.fresh('a', USER)
  const b = f.fresh('b', WEB)
  eq(f.origins(f.combine('ab', [a, b])).sort(), ['tool', 'user'])
})

await test('★ 一条不可信来源就足以污染整个下游，无论链有多长', () => {
  const f = M.makeFlow()
  let t = f.combine('x', [f.fresh(1, USER), f.fresh(2, WEB)])
  for (let i = 0; i < 6; i++) t = f.combine(`step${i}`, [t])
  ok(f.tainted(t), '中间过一遍摘要、翻译、格式化，不会让它变干净——只是让你看不出来')
})

await test('★ 漏掉一个 combine 的上游，污染就悄悄消失了', () => {
  const f = M.makeFlow()
  const clean = f.fresh('模板', USER)
  const dirty = f.fresh('网页正文', WEB)
  ok(!f.tainted(f.combine('拼好的', [clean])), '这就是漏写的样子：不报错，只是结果变干净了')
  ok(f.tainted(f.combine('拼好的', [clean, dirty])))
})

await test('多条不可信来源要各自留痕，不能合并成一条', () => {
  const f = M.makeFlow()
  const a = f.fresh('1', WEB)
  const b = f.fresh('2', { origin: 'tool', source: 'read_issue', trusted: false })
  eq(
    f.sourcesOf(f.combine('both', [a, b])).map((p: shared.Provenance) => p.source).sort(),
    ['fetch_url', 'read_issue'],
  )
})

await test('sourcesOf 去重：同一个来源用两次只算一次', () => {
  const f = M.makeFlow()
  const a = f.fresh('1', WEB)
  eq(f.sourcesOf(f.combine('x', [a, a, a])).length, 1)
})

await test('★ 严格模式：拿不可信值做条件判断，也算污染了结果', () => {
  const f = M.makeFlow(true)
  const g = f.fresh(true, WEB)
  const out = f.branch(g, () => f.fresh('分支里造出来的', USER))
  ok(f.tainted(out), '控制流也是数据流——这是一条一 bit 的侧信道，CaMeL 默认关掉它')
})

await test('非严格模式下同一个分支不污染（这是个有意的取舍）', () => {
  const f = M.makeFlow(false)
  const g = f.fresh(true, WEB)
  ok(!f.tainted(f.branch(g, () => f.fresh('x', USER))))
})

await test('干净的值经过任意多次 combine 仍然干净', () => {
  const f = M.makeFlow()
  let t = f.fresh('a', USER)
  for (let i = 0; i < 5; i++) t = f.combine('x', [t, f.fresh('b', CONFIG)])
  ok(!f.tainted(t), '要是这条挂了，你的门会把所有正常调用都拦掉')
})

// ─────────────────────────────────────────────────────────
console.log('\n二、能力契约：★ 判的是参数，不是工具名')

await test('destination 参数不接受不可信来源', () => {
  const f = M.makeFlow()
  const v = M.checkCall(CONTRACTS.post_comment!, {
    repo: f.fresh('attacker/dropbox', WEB),
    number: f.fresh('1', USER),
    body: f.fresh('x', USER),
  }, f)
  ok(!v.allowed)
  eq(v.violations.map((x) => x.arg), ['repo'])
})

await test('★ payload 参数**接受**不可信来源——这才是它存在的意义', () => {
  const f = M.makeFlow()
  const v = M.checkCall(CONTRACTS.post_comment!, {
    repo: f.fresh('acme/app', USER),
    number: f.fresh('7', USER),
    body: f.fresh('从 issue 正文摘出来的一段', WEB),
  }, f)
  ok(v.allowed, '把 body 也拦掉，就等于废掉这个工具——这是分类器付的那 27.8 个百分点')
})

await test('★ 同一个工具、同一次调用，repo 脏就拦、body 脏就放', () => {
  const f = M.makeFlow()
  const dirty = f.fresh('x', WEB)
  const clean = f.fresh('acme/app', USER)
  ok(!M.checkCall(CONTRACTS.post_comment!, { repo: dirty, number: clean, body: clean }, f).allowed)
  ok(M.checkCall(CONTRACTS.post_comment!, { repo: clean, number: clean, body: dirty }, f).allowed)
})

await test('契约里没写的参数一律拒绝（默认拒绝，不是默认放行）', () => {
  const f = M.makeFlow()
  const v = M.checkCall(CONTRACTS.post_comment!, {
    repo: f.fresh('acme/app', USER),
    number: f.fresh('7', USER),
    body: f.fresh('x', USER),
    bcc: f.fresh('attacker@evil.com', USER),
  }, f)
  ok(!v.allowed, '★ rug pull 加出来的新字段就是从这儿进来的，来源还是干净的')
  eq(v.violations.map((x) => x.arg), ['bcc'])
})

await test('★ send_money 的收款人只接受 user——连 config 都不行', () => {
  // CaMeL 的 banking 策略就是这么写的，也是它拒绝率最高的一个域。
  const f = M.makeFlow()
  const bad = M.checkCall(CONTRACTS.send_money!, {
    recipient: f.fresh('acct-x', CONFIG),
    amount: f.fresh('100', USER),
  }, f)
  ok(!bad.allowed, '"可信"不是一个档位。这个参数要的是「这一笔是这个人此刻要求的」')
})

await test('send_money 的收款人和金额都以用户为源时放行', () => {
  const f = M.makeFlow()
  const v = M.checkCall(CONTRACTS.send_money!, {
    recipient: f.fresh('acct-self', USER),
    amount: f.fresh('100', USER),
  }, f)
  ok(v.allowed)
})

await test('★ 三个工具全都通过了「工具名授权」，攻击照样成立', () => {
  // GitHub MCP 那次事故：read_issue / read_file / post_comment 都在白名单上。
  const f = M.makeFlow()
  const issue = f.fresh('issue 正文（含注入）', { origin: 'tool', source: 'read_issue', trusted: false })
  const path = f.combine('/home/me/.ssh/id_rsa', [issue])
  const bad = M.checkCall(CONTRACTS.read_file!, { path }, f)
  ok(!bad.allowed, '按工具名授权时这一步是绿的；按参数来源授权才拦得住')
  eq(bad.violations[0]!.role, 'destination')
})

await test('violations 要说清是哪个参数、什么角色、为什么', () => {
  const f = M.makeFlow()
  const v = M.checkCall(CONTRACTS.fetch_url!, { url: f.fresh('http://evil.com', WEB) }, f)
  ok(!v.allowed)
  ok(v.violations[0]!.arg.length > 0 && v.violations[0]!.reason.length > 0)
})

// ─────────────────────────────────────────────────────────
console.log('\n三、致命三要素 / Rule of Two')

const caps = (p: boolean, u: boolean, e: boolean, s = false): SessionCaps => ({
  privateData: p, untrustedContent: u, externalComms: e, stateChange: s,
})

await test('三条全占：致命三要素成立', () => {
  ok(M.trifecta(caps(true, true, true)).trifecta)
})

await test('少任意一条：致命三要素不成立', () => {
  ok(!M.trifecta(caps(true, true, false)).trifecta)
  ok(!M.trifecta(caps(true, false, true)).trifecta)
  ok(!M.trifecta(caps(false, true, true)).trifecta)
})

await test('★ 有一格里三要素不成立，但 Rule of Two 已经被违反', () => {
  // Meta 的 [C] 包含"改变状态"，Willison 的第三条只有"对外通信"。
  const v = M.trifecta(caps(true, true, false, true))
  ok(!v.trifecta, 'Willison 的三条没占满')
  ok(v.ruleOfTwoViolated, '但 Meta 的 [C] 把"改变状态"也算进去了')
})

await test('legs 要报出到底占了哪几条', () => {
  eq(M.trifecta(caps(true, true, false)).legs.length, 2)
})

await test('cheapestFix 指向最容易拿掉的那一条', () => {
  const v = M.trifecta(caps(true, true, true))
  ok(v.cheapestFix.length > 0)
})

await test('一条都不占：通过，且不给修改建议', () => {
  const v = M.trifecta(caps(false, false, false))
  ok(!v.ruleOfTwoViolated && !v.trifecta)
})

// ─────────────────────────────────────────────────────────
console.log('\n四、外发通道：★ 看不见的通道 ≠ 加了过滤的通道')

const ch = (name: string, mitigation: Channel['mitigation'], enforceable: boolean): Channel => ({
  name, kind: 'network', mitigation, enforceable,
})

await test('移除掉的通道算守住了', () => {
  eq(M.auditChannels([ch('图片渲染', 'remove', true)]).closed, ['图片渲染'])
})

await test('只加了过滤的通道单独一类，不算守住', () => {
  const r = M.auditChannels([ch('出站 HTTP', 'filter', true)])
  eq(r.filteredOnly, ['出站 HTTP'])
  eq(r.closed, [])
})

await test('★ 顺序：看不见要在过滤之前判', () => {
  // 一条你看不见的通道上"加了过滤"，是过滤配置写在那儿、执行点根本没在路径上。
  const r = M.auditChannels([ch('MCP 连接', 'filter', false)])
  eq(r.blind, ['MCP 连接'], '先判 filter 就会把它错报成"已过滤"——这是最容易写错的一行')
  eq(r.filteredOnly, [])
})

await test('完全没管的通道进 open', () => {
  eq(M.auditChannels([ch('DNS', 'none', true)]).open, ['DNS'])
})

await test('四类互斥，加起来等于总数', () => {
  const r = M.auditChannels([
    ch('a', 'remove', true), ch('b', 'filter', true), ch('c', 'filter', false), ch('d', 'none', true),
  ])
  eq(r.closed.length + r.filteredOnly.length + r.blind.length + r.open.length, 4)
})

await test('verdict 里要出现还剩几条可用通道', () => {
  const r = M.auditChannels([ch('a', 'remove', true), ch('b', 'filter', true), ch('c', 'none', true)])
  ok(/2/.test(r.verdict), '剩 2 条：filter 那条历史上全被绕过，none 那条根本没管')
})

await test('全部移除时 verdict 不该说还有可用通道', () => {
  const r = M.auditChannels([ch('a', 'remove', true), ch('b', 'remove', true)])
  ok(!/还有/.test(r.verdict) || /0/.test(r.verdict))
})

await test('★ 历史记录：过滤类全被绕过，移除类全守住', () => {
  const bypassed = shared.FILTER_RECORD.filter((r) => r.outcome === 'bypassed')
  const held = shared.FILTER_RECORD.filter((r) => r.outcome === 'held')
  ok(bypassed.length >= 5 && held.length >= 3)
  ok(bypassed.some((r) => /HMAC|Camo/.test(r.control)), '连 HMAC 签名的图片代理都被绕过了')
  ok(held.some((r) => /关掉/.test(r.control)), 'GitHub 最后的修法是把图片渲染整个关掉')
  ok(held.every((r) => /关掉|白名单|不带凭据/.test(r.control)), '守住的三条全是「拿掉能力」，不是「看懂内容」')
})

// ─────────────────────────────────────────────────────────
console.log('\n五、熔断器：★ 要展开命令替换')

await test('明面上的 rm -rf / 要拦住', () => {
  ok(M.circuitBreaker('rm -rf /') !== null)
})

await test('rm -rf ~ 要拦住', () => {
  ok(M.circuitBreaker('rm -rf ~') !== null)
})

await test('★ 藏在 $() 里的要拦住', () => {
  ok(M.circuitBreaker('echo "$(rm -rf ~)"') !== null, '不展开的实现看到的是一条 echo')
})

await test('★ 藏在反引号里的要拦住', () => {
  ok(M.circuitBreaker('echo `rm -rf /`') !== null)
})

await test('★ 藏在进程替换 <() 里的要拦住', () => {
  ok(M.circuitBreaker('cat <(rm -rf /)') !== null)
})

await test('嵌套两层替换也要拦住', () => {
  ok(M.circuitBreaker('echo "$(echo "$(rm -rf /)")"') !== null)
})

await test('git push --force 要拦住', () => {
  ok(M.circuitBreaker('git push --force origin main') !== null)
})

await test('绕过审批的开关要拦住', () => {
  ok(M.circuitBreaker('claude --dangerously-skip-permissions') !== null)
})

await test('正常命令不要误伤', () => {
  for (const c of ['npm run build', 'git status', 'ls -la', 'rm -rf ./node_modules', 'echo "$(date)"']) {
    ok(M.circuitBreaker(c) === null, `误伤了：${c}`)
  }
})

await test('tripped 时要说清命中了哪一条', () => {
  const r = M.circuitBreaker('rm -rf /')
  ok(r !== null && r.by === 'circuit-breaker' && r.risk === 'critical' && r.reason.length > 0)
})

// ─────────────────────────────────────────────────────────
console.log('\n六、审批门（PDP）')

const act = (o: Partial<Action> = {}): Action => ({
  tool: 'bash', rendered: 'echo hi', irreversible: false, crossesBoundary: false,
  attackerControlled: [], altersOversight: false, ...o,
})
const POL: shared.GatePolicy = { deny: ['git push --force'], authorized: ['post_comment'], env: { HOME: '/home/me' } }

await test('low 风险动作直接放行', async () => {
  const d = await M.makeGate(new shared.AutoApprove(), POL).decide(act())
  ok(d.allow)
})

await test('改变监督机制的动作永远是 critical', () => {
  eq(shared.classifyRisk(act({ altersOversight: true })), 'critical')
})

await test('★ 不可逆 + 跨边界，但参数干净 → high（要授权，不是要禁止）', () => {
  eq(shared.classifyRisk(act({ irreversible: true, crossesBoundary: true })), 'high')
})

await test('★ 同一个动作，参数被污染 → critical', () => {
  eq(
    shared.classifyRisk(act({ irreversible: true, crossesBoundary: true, attackerControlled: ['to'] })),
    'critical',
    '一个 bit 的差别。合并成"一律 critical"就废掉了这个工具',
  )
})

await test('可逆的跨边界动作是 medium（OWASP 的店铺积分那一格）', () => {
  eq(shared.classifyRisk(act({ crossesBoundary: true })), 'medium')
})

await test('deny 规则优先于任何 reviewer 的意见', async () => {
  const gate = M.makeGate(new shared.AutoApprove(), POL)
  const d = await gate.decide(act({ rendered: 'git push --force origin main' }))
  ok(!d.allow, '★ 策略住在文件里，不住在对话里——上下文压缩不该能把它弄丢')
})

await test('熔断器在最前面，deny 规则都排在它后面', async () => {
  const gate = M.makeGate(new shared.AutoApprove(), { deny: [], authorized: [], env: {} })
  ok(!(await gate.decide(act({ rendered: 'rm -rf /' }))).allow)
})

await test('★ 解析不出的变量 → 拒绝，不能拿着 $TARGET 去问人', async () => {
  const gate = M.makeGate(new shared.AutoApprove(), POL)
  const d = await gate.decide(act({ rendered: 'rm -rf "$TARGET"', irreversible: true }))
  ok(!d.allow, '你给人看的那一行必须和真要执行的那一行是同一行')
})

await test('能解析出来的变量就放过（$HOME 在策略的 env 里）', async () => {
  const gate = M.makeGate(new shared.AutoApprove(), POL)
  ok((await gate.decide(act({ rendered: 'ls "$HOME"' }))).allow)
})

await test('★ 高风险动作的目标由命令替换产生 → 拒绝', async () => {
  const gate = M.makeGate(new shared.AutoApprove(), POL)
  const d = await gate.decide(act({ rendered: 'rm -rf `echo ~`', irreversible: true }))
  ok(!d.allow, '替换没有藏删除动作，它藏的是删除**目标**——反方向的同一条规则')
})

await test('RuleBased：授权过的工具在 high 上放行', async () => {
  const gate = M.makeGate(new shared.RuleBased(new Set(['post_comment'])), POL)
  const d = await gate.decide(act({ tool: 'post_comment', rendered: 'post_comment(...)', irreversible: true }))
  ok(d.allow)
})

await test('RuleBased：没授权的工具在 high 上拒绝', async () => {
  const gate = M.makeGate(new shared.RuleBased(new Set(['post_comment'])), POL)
  ok(!(await gate.decide(act({ tool: 'payout', rendered: 'payout(...)', irreversible: true }))).allow)
})

await test('RuleBased：critical 一律拒绝，授权过也不行', async () => {
  const gate = M.makeGate(new shared.RuleBased(new Set(['post_comment'])), POL)
  const d = await gate.decide(act({
    tool: 'post_comment', rendered: 'post_comment(...)',
    irreversible: true, crossesBoundary: true, attackerControlled: ['repo'],
  }))
  ok(!d.allow)
})

await test('★ reviewer 抛异常 → 拒绝（fail closed）', async () => {
  const flaky: shared.Reviewer = {
    name: 'flaky',
    review: async () => { throw new Error('timeout') },
  }
  const d = await M.makeGate(flaky, POL).decide(act({ irreversible: true }))
  ok(!d.allow, 'Claude Code 的 subagent review 是反过来的——它放行，只贴一句警告')
  ok(/失败|error|closed|拒/.test(d.reason))
})

await test('★ ReviewContext 里没有 toolResults 这个字段', () => {
  // Claude Code 官方：Tool results are stripped, so hostile content in a file
  // or web page can't manipulate it directly.
  const ctx: shared.ReviewContext = { userMessages: [], appContext: [], risk: 'low', provenanceChain: [] }
  // 这四个字段就是全部。加一个 toolResults 进去，下一行就不通过编译。
  eq(Object.keys(ctx).sort(), ['appContext', 'provenanceChain', 'risk', 'userMessages'])
  ok(!('toolResults' in ctx), '这是全课唯一一个「有效的分类器」，它有效正是因为它看不见那段数据')
})

await test('审批门的 decision 要能说出风险档位和理由', async () => {
  const d = await M.makeGate(new shared.AutoApprove(), POL).decide(act({ irreversible: true }))
  ok(['low', 'medium', 'high', 'critical'].includes(d.risk) && d.reason.length > 0)
})

// ─────────────────────────────────────────────────────────
console.log('\n七、rug pull：哈希钉定')

const td = (name: string, description: string, inputSchema: Record<string, string>): ToolDescriptor =>
  ({ name, description, inputSchema })

await test('指纹稳定：同样的描述算两次一样', () => {
  const a = M.pinTools([td('x', 'd', { a: 'string' })])
  const b = M.pinTools([td('x', 'd', { a: 'string' })])
  eq(a[0]!.fingerprint, b[0]!.fingerprint)
})

await test('描述改了，指纹要变', () => {
  const a = M.pinTools([td('x', 'd1', { a: 'string' })])
  const b = M.pinTools([td('x', 'd2', { a: 'string' })])
  ok(a[0]!.fingerprint !== b[0]!.fingerprint)
})

await test('★ description 没变、inputSchema 多一个字段，指纹也要变', () => {
  const a = M.pinTools([td('send', '发一条消息。', { to: 'string' })])
  const b = M.pinTools([td('send', '发一条消息。', { to: 'string', bcc: 'string' })])
  ok(a[0]!.fingerprint !== b[0]!.fingerprint, '实测 24.8% 的 server 改 descriptor，只有 8.6% 改 description')
})

await test('没有变化时不需要重新批准', () => {
  const day0 = [td('x', 'd', { a: 'string' })]
  ok(!M.checkDrift(M.pinTools(day0), day0).needsReapproval)
})

await test('描述漂移要报出来并要求重新批准', () => {
  const r = M.checkDrift(M.pinTools([td('x', 'd1', {})]), [td('x', 'd2', {})])
  eq(r.changed, ['x'])
  ok(r.needsReapproval)
})

await test('★ 新增的工具要报出来——漂移排名永远抓不到它', () => {
  const r = M.checkDrift(M.pinTools([td('x', 'd', {})]), [td('x', 'd', {}), td('admin_exec', '执行。', {})])
  eq(r.added, ['admin_exec'])
  ok(r.needsReapproval, '实测："roughly half of all description changes land on new arrivals"')
})

await test('消失的工具也要报', () => {
  const r = M.checkDrift(M.pinTools([td('x', 'd', {}), td('y', 'd', {})]), [td('x', 'd', {})])
  eq(r.removed, ['y'])
})

await test('★ 内容绑定 ≠ 漂移排名：钉的是哈希，不是"看起来可疑"', () => {
  // 论文自己的对照组就是内容绑定；按漂移排名重审只抓到约 10%。
  const day0 = M.pinTools([td('a', 'd', {}), td('b', 'd', {})])
  const r = M.checkDrift(day0, [td('a', 'd', {}), td('b', 'd！', {})])
  eq(r.changed, ['b'], '一个标点就要触发——因为你不去判断它像不像攻击')
})

// ─────────────────────────────────────────────────────────
console.log('\n八、沙箱')

const SB: SandboxSpec = {
  allowWrite: ['/w/app'], denyWrite: ['/w/app/.git'],
  allowRead: ['/home/me', '/w/app'], denyRead: ['/home/me/**/.env', '/home/me/.aws'],
  allowedDomains: ['registry.npmjs.org'], proxyEnabled: true, scrubEnv: ['GITHUB_TOKEN'],
  covers: ['bash'], tlsTerminate: false, ownsResolver: true, allowUnsandboxedRetry: false,
}

await test('allow 之内的路径放行', () => {
  ok(shared.pathVerdict(SB, '/w/app/src/a.ts', 'write').allow)
})

await test('allow 之外的路径拒绝', () => {
  ok(!shared.pathVerdict(SB, '/etc/passwd', 'write').allow)
})

await test('★ 更具体的 deny 打败更宽的 allow', () => {
  ok(shared.pathVerdict(SB, '/home/me/proj', 'read').allow)
  ok(!shared.pathVerdict(SB, '/home/me/proj/.env', 'read').allow, '一条宽 allow 不该把一个 secret 重新暴露出来')
})

await test('deny 里的 ** 通配要能跨任意层级', () => {
  ok(!shared.pathVerdict(SB, '/home/me/a/b/c/.env', 'read').allow)
})

await test('.git 在可写目录里也要拒绝', () => {
  ok(!shared.pathVerdict(SB, '/w/app/.git/hooks/pre-commit', 'write').allow)
})

await test('verdict 要说清是哪条规则决定的', () => {
  ok(shared.pathVerdict(SB, '/home/me/.aws/credentials', 'read').rule.includes('/home/me/.aws'))
})

await test('白名单域名放行，其余拒绝', () => {
  ok(shared.egressVerdict(SB, 'registry.npmjs.org').allow)
  ok(!shared.egressVerdict(SB, 'evil.com').allow)
})

await test('★ 代理没开的时候，白名单里**没有**的域名也放行', () => {
  const off: SandboxSpec = { ...SB, proxyEnabled: false }
  const v = shared.egressVerdict(off, 'evil.com')
  ok(v.allow, 'Codex 官方真值表：网络开 + 代理关 = "unrestricted direct"，白名单一条都不生效')
  ok(v.caveats.length > 0, '而且得说出来——一个静默放行的 allow=true 比拒绝还危险')
})

await test('★ 这条缺口要排在 DNS 和 domain fronting 前面', () => {
  const off: SandboxSpec = { ...SB, proxyEnabled: false, ownsResolver: false }
  const gaps = shared.sandboxGaps(off, {})
  const iProxy = gaps.findIndex((g) => g.includes('代理没开'))
  const iDns = gaps.findIndex((g) => g.includes('DNS'))
  ok(iProxy >= 0, '白名单非空 + 代理关，必须报一条缺口')
  ok(iProxy < iDns, '那两条说的是"白名单能被绕过"，这条说的是"白名单根本没接上"')
})

await test('★ 通配白名单会带上警告，因为它的攻击面比你想的大', () => {
  const wide: SandboxSpec = { ...SB, allowedDomains: ['*.github.com'] }
  const v = shared.egressVerdict(wide, 'gist.github.com')
  ok(v.allow && v.caveats.length > 0, 'EchoLeak 走的是 *.teams.microsoft.com；ForcedLeak 那个域名 5 美元就能注册回来')
})

await test('★ 缺口清单：没列进 scrubEnv 的密钥会被子进程继承', () => {
  const gaps = shared.sandboxGaps(SB, { STRIPE_SECRET_KEY: 'sk_live_x' })
  ok(gaps.some((g) => g.includes('STRIPE_SECRET_KEY')), 'Claude Code 官方："no built-in credential deny list"')
})

await test('★ 缺口清单：不终止 TLS 就存在 domain fronting', () => {
  ok(shared.sandboxGaps(SB, {}).some((g) => /fronting|SNI/.test(g)))
})

await test('★ 缺口清单：沙箱只盖住 bash，其它工具不在里面', () => {
  ok(shared.sandboxGaps(SB, {}).some((g) => /read_file|工具|覆盖/.test(g)))
})

await test('★ 缺口清单：不掌握解析器就有一条静默 DNS 信道', () => {
  const noDns: SandboxSpec = { ...SB, ownsResolver: false }
  ok(shared.sandboxGaps(noDns, {}).some((g) => /DNS/.test(g)))
})

await test('★ 缺口清单：允许失败后不带沙箱重试，等于没有沙箱', () => {
  const retry: SandboxSpec = { ...SB, allowUnsandboxedRetry: true }
  ok(shared.sandboxGaps(retry, {}).some((g) => /重试/.test(g)))
})

// ─────────────────────────────────────────────────────────
console.log('\n九、两轴：★ 只报一个数字就是错的')

const suite = (blocked: number, completed: number): SuiteCase[] => [
  ...[...Array(100)].map((_, i) => ({ name: `a${i}`, kind: 'attack' as const, passed: i < blocked })),
  ...[...Array(100)].map((_, i) => ({ name: `b${i}`, kind: 'benign' as const, passed: i < completed })),
]

await test('ASR = 攻击用例里没拦住的比例', () => {
  near(M.twoAxis(suite(90, 100), 1).asr, 0.1)
})

await test('可用性 = 良性用例的完成率', () => {
  near(M.twoAxis(suite(100, 62), 1).utility, 0.62)
})

await test('utilityDelta 是相对基线的百分点差', () => {
  near(M.twoAxis(suite(100, 41), 0.6907).utilityDelta, -28.07, 0.01)
})

await test('★ 只有攻击用例 → 拒绝给结论', () => {
  const r = M.twoAxis([{ name: 'a', kind: 'attack', passed: true }], 1)
  ok(/缺一轴|没有意义/.test(r.verdict), '一个只测攻击的评估，可以用"什么都拦掉"拿满分')
})

await test('★ 只有良性用例 → 也拒绝给结论', () => {
  const r = M.twoAxis([{ name: 'b', kind: 'benign', passed: true }], 1)
  ok(/缺一轴|没有意义/.test(r.verdict))
})

await test('★ ASR 归零 + 代价很小 → 架构型防御的形状', () => {
  const r = M.twoAxis(suite(100, 62), 0.6907)
  ok(r.asr === 0 && !r.verdict.startsWith('★'), 'CaMeL 是 77% vs 84%，掉 7 个百分点')
})

await test('★ ASR 归零 + 可用性崩了 → 分类器的形状，要单独标出来', () => {
  const r = M.twoAxis(suite(100, 41), 0.6907)
  ok(r.asr === 0 && r.verdict.startsWith('★'), '和上一条同样是 ASR 0，但这是两种完全不同的工程结果')
})

await test('代价的分界线在 15 个百分点', () => {
  ok(!M.twoAxis(suite(100, 55), 0.6907).verdict.startsWith('★'))
  ok(M.twoAxis(suite(100, 50), 0.6907).verdict.startsWith('★'))
})

await test('ASR 没归零就不能说安全轴归零', () => {
  ok(!/归零/.test(M.twoAxis(suite(52, 69), 0.6907).verdict))
})

await test('★ 六项全的 ASR 断言才可比', () => {
  const r = M.claimIsComparable({
    asr: 0.0111, denominator: 'adversary', adaptive: true,
    modelSnapshot: 'claude-3-5-sonnet-20241022', benchmarkVersion: 'AgentDojo v1.2', benignUtility: 0.66,
  })
  ok(r.ok)
  eq(r.missing, [])
})

await test('★ 缺"每个对手"这个分母 → 不可比', () => {
  const r = M.claimIsComparable({
    asr: 0.008, denominator: 'attempt', adaptive: true,
    modelSnapshot: 'x-2025-01-01', benchmarkVersion: 'v1', benignUtility: 0.6,
  })
  ok(!r.ok, 'LLMail-Inject 的 0.8% 是每次提交；按队伍算，四层叠一起是 16.6%')
})

await test('★ 攻击方不自适应 → 不可比', () => {
  const r = M.claimIsComparable({
    asr: 0.0, denominator: 'adversary', adaptive: false,
    modelSnapshot: 'x-2025-01-01', benchmarkVersion: 'v1', benignUtility: 0.6,
  })
  ok(!r.ok, '12 个已发表防御在自适应攻击下 ASR >90%，而它们原本报的都是接近零')
})

await test('★ 模型快照没有日期 → 不可比', () => {
  const r = M.claimIsComparable({
    asr: 0.3386, denominator: 'adversary', adaptive: true,
    modelSnapshot: 'claude-3-5-sonnet', benchmarkVersion: 'v1', benignUtility: 0.6,
  })
  ok(!r.ok, '20240620 是 33.86%，20241022 是 1.11%——同一个名字，差 30 倍')
})

await test('没有同时报良性可用性 → 不可比', () => {
  const r = M.claimIsComparable({
    asr: 0.0795, denominator: 'adversary', adaptive: true,
    modelSnapshot: 'gpt-4o-2024-05-13', benchmarkVersion: 'AgentDojo v1.2', benignUtility: null,
  })
  ok(!r.ok)
  ok(r.missing.some((m) => /可用性/.test(m)))
})

// ─────────────────────────────────────────────────────────
console.log('\n十、不可见字符')

await test('零宽字符要被剥掉', () => {
  eq(shared.stripInvisible('rm\u200b -rf /').text, 'rm -rf /')
})

await test('变体选择符要被剥掉', () => {
  ok(shared.stripInvisible('a\ufe0fb').removed === 1)
})

await test('★ 标签字符（U+E0000 段）要被剥掉——这是最常见的走私载荷', () => {
  ok(shared.stripInvisible('hi\u{e0041}').removed === 1)
})

await test('正常文本不要被改动（含中文和 emoji）', () => {
  const s = '删掉 build 目录 🙂'
  eq(shared.stripInvisible(s).text, s)
})

await test('★ 显示的和执行的不一致要能判出来', () => {
  ok(!shared.displayMatchesExecution('rm -rf ./build', 'rm\u200b -rf /'))
  ok(shared.displayMatchesExecution('rm -rf ./build', 'rm -rf ./build'))
})

// ─────────────────────────────────────────────────────────
const total = passed + failures.length
console.log(`\n\x1b[1m${passed}/${total} 通过\x1b[0m`)
if (failures.length > 0) {
  console.log('\x1b[31m没过的：\x1b[0m')
  for (const f of failures) console.log(`\x1b[31m  · ${f}\x1b[0m`)
  console.log(
    '\n\x1b[2m带 ★ 的那些是这一节真正要教的东西：它们全都不抛异常，\x1b[0m' +
      '\n\x1b[2m所以你的实现漏了它们的时候，日志上看起来是绿的。\x1b[0m',
  )
  process.exit(1)
}
console.log('\x1b[2m\n注意这句话的边界：全绿只意味着这些结构性质成立，\x1b[0m')
console.log('\x1b[2m不意味着你的 agent 是安全的。这一节从头到尾都在说这件事。\x1b[0m')
