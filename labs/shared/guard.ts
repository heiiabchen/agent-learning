/**
 * L14 参考实现：prompt 注入与权限沙箱。
 *
 * ★ 这一节的核心论点，值得写在最前面：
 *
 * **能读懂攻击的防御，全被绕过了；守住的那些，都是看不见攻击的。**
 *
 *   读得懂的（in-band）        分隔符、spotlighting、注入分类器、
 *                              指令层级微调、输出"消毒"
 *                              → 自适应攻击下 12 个防御里大多数 >90% ASR
 *                                （arXiv 2510.09023），而它们原本报的都是接近零
 *
 *   看不见的（out-of-band）    按参数的来源授权、能力契约、
 *                              凭据降权、把通道整个拿掉
 *                              → 对它们设计针对的那类攻击，成功率是 0
 *
 * 最能说明问题的是那个例外：Claude Code 的审批分类器是**唯一一个有效的
 * 分类器**，而官方文档写得很清楚——"Tool results are stripped, so hostile
 * content in a file or web page can't manipulate it directly."
 * ★ 它有效**恰恰因为它看不见那段不可信的数据**。
 *
 * 推论，也是这一节全部代码的依据：
 *   **做授权判断的那段代码，绝不能读那段不可信的数据。**
 *
 * 还有一件必须先说的事：这一节的交付物（沙箱 + 人工审批），
 * 在 2026 年恰恰是厂商刚刚**拿掉**的东西。Cursor 3.5（2026-05-22）
 * 弃用了 "Ask Every Time"，3.6（2026-05-29）把 Auto-review 设成默认；
 * Claude Code 在 Pro/Max/Team 上默认 auto 模式，"a second model, the
 * classifier, reviews actions instead of you"。
 * 所以要教的不是"弹个框问人"，而是**一个可插拔的策略决策点**
 * （人 | 规则 | 模型），以及它必须满足的那几条性质。
 *
 * 和前面每一节一样：这里每一个失效都不抛异常。
 */

import { createHash } from 'node:crypto'

// ─────────────────────────────────────────────────────────────
// 一、来源：给「值」打标签，不给「消息」打标签
// ─────────────────────────────────────────────────────────────

/**
 * 值的来源。只有三类，而分界线是**这段字节是谁写的**。
 *
 * 注意 `tool` 并不等于"不可信"。OWASP 2026 的 LLM01 把间接注入面
 * 分成三档信任度：untrusted（公网、陌生人邮件、搜索结果）、
 * semi-trusted（公开 issue 标题、包的 README 和 changelog、
 * 第三方 API 响应）、trusted（你自己的仓库、数据库、内部文档、邮件）。
 * ★ 而它对 trusted 那一档加了一句：
 * "The developer may not realize an attacker has placed content here."
 */
export type Origin = 'user' | 'config' | 'tool'

export interface Provenance {
  origin: Origin
  /** 具体是谁：'cli' / 'settings.json' / 'read_issue' / 'fetch_url' */
  source: string
  /** ★ 这一位是**你**声明的，不是推断的。默认应当是 false。 */
  trusted: boolean
}

/** 一个带来源的值。`id` 用来在依赖图里指代它。 */
export interface Tainted<T> {
  id: string
  value: T
  /** 直接父节点的 id。递归展开由 Flow 负责。 */
  deps: string[]
  /** 只有 fresh() 出来的值有自己的来源；combine 出来的值靠 deps 推。 */
  own?: Provenance
}

/**
 * 数据流图。这是 CaMeL 的自定义解释器**去掉解释器**之后剩下的部分：
 * 每个值记住它从哪儿来，合并时并集，查询时递归展开。
 *
 * 两种模式，和 CaMeL 一致：
 *   NORMAL —— 只跟踪显式的数据合并
 *   STRICT —— 分支内赋的值，额外依赖**分支条件**
 *
 * ★ STRICT 不是洁癖。CaMeL 论文里明确说它是为了堵side channel：
 * 用一个依赖隐私数据的条件去触发/不触发一次可观测的调用，
 * 每次泄漏一个比特。他们自己承认 CaMeL 仍然"vulnerable to
 * side-channel attacks"，并给了三个具体的（外部资源探测、
 * 异常处理泄漏一个比特、计时）。
 */
export class Flow {
  private nodes = new Map<string, Tainted<unknown>>()
  private seq = 0
  /** STRICT 模式下当前生效的分支条件 id。 */
  private guards: string[] = []

  constructor(public readonly strict = false) {}

  private nextId(tag: string) {
    this.seq += 1
    return `${tag}#${this.seq}`
  }

  /** 一个有明确来源的新值。 */
  fresh<T>(value: T, prov: Provenance, tag: string = prov.origin): Tainted<T> {
    const node: Tainted<T> = {
      id: this.nextId(tag),
      value,
      deps: this.strict ? [...this.guards] : [],
      own: prov,
    }
    this.nodes.set(node.id, node as Tainted<unknown>)
    return node
  }

  /**
   * 由若干个已有值算出的新值。
   *
   * ★ 这个函数是整套东西的地基，而它最容易写错的地方是**漏掉并集**：
   * 只记第一个父节点、或者干脆不记，编译能过、测试能过、
   * 演示能过——直到某个由不可信数据派生出来的值被当成可信的送进
   * 一个有权限的参数。那时候什么都不会报错。
   */
  combine<T>(value: T, parts: Tainted<unknown>[], tag = 'derived'): Tainted<T> {
    const deps = new Set<string>()
    for (const p of parts) deps.add(p.id)
    if (this.strict) for (const g of this.guards) deps.add(g)
    const node: Tainted<T> = { id: this.nextId(tag), value, deps: [...deps] }
    this.nodes.set(node.id, node as Tainted<unknown>)
    return node
  }

  /**
   * STRICT 模式的分支：`fn` 里创建的所有值都额外依赖 `guard`。
   * NORMAL 模式下这就是普通调用。
   */
  branch<T>(guard: Tainted<unknown>, fn: () => T): T {
    if (!this.strict) return fn()
    this.guards.push(guard.id)
    try {
      return fn()
    } finally {
      this.guards.pop()
    }
  }

  /** 递归展开到所有根来源。 */
  sourcesOf(t: Tainted<unknown>): Provenance[] {
    const seen = new Set<string>()
    const out: Provenance[] = []
    const walk = (id: string) => {
      if (seen.has(id)) return
      seen.add(id)
      const n = this.nodes.get(id)
      if (!n) return
      if (n.own) out.push(n.own)
      for (const d of n.deps) walk(d)
    }
    walk(t.id)
    return out
  }

  /** 有没有任何一个根来源是不可信的。 */
  tainted(t: Tainted<unknown>): boolean {
    return this.sourcesOf(t).some((p) => !p.trusted)
  }

  /** 这个值实际用到的来源类别。 */
  origins(t: Tainted<unknown>): Origin[] {
    return [...new Set(this.sourcesOf(t).map((p) => p.origin))].sort()
  }

  size() {
    return this.nodes.size
  }
}

// ─────────────────────────────────────────────────────────────
// 二、能力契约：按**参数**授权，不按工具授权
// ─────────────────────────────────────────────────────────────

/**
 * 参数的语义角色。
 *
 * ★ 这是这一节最重要的一个技术点，而它有明确的一手出处。
 *
 * CaMeL 论文 §3.1 讲 Dual LLM 模式的残余风险时说：即使全局计划没被
 * 劫持，"being able to **change the arguments to the tool calls** by
 * prompt injecting the Quarantined LLM can be a security issue：
 * while the control flow is protected by the Dual LLM pattern,
 * **the data flow can still be manipulated**"。
 * 然后给了那个决定性的类比：
 *
 *   "This is analogous to an SQL injection attack in which an adversary
 *    manipulates the **query parameters** rather than the structure of
 *    the query itself."
 *
 * PACT（arXiv 2605.11039）把它变成一句可以直接写进代码的设计原则：
 * 间接注入 "becomes dangerous **not when untrusted content appears in
 * context, but when it determines an authority-bearing argument**"。
 *
 * 所以：验证 `send_email` 这个**工具**被允许调用，几乎没有价值。
 * 要验证的是 `to` 这个**参数**的来源。
 */
export type ArgRole =
  /** 效果落在哪儿：收件人、URL、路径、仓库。攻击者最想控制的就是这个。 */
  | 'destination'
  /** 送出去的内容。可以来自不可信数据——但要看它流向哪个 destination。 */
  | 'payload'
  /** 读哪一条：id、查询词、文件名。可以来自不可信数据。 */
  | 'selector'
  /** 必须是常量或来自可信配置。 */
  | 'literal'

export interface ArgContract {
  role: ArgRole
  /** 允许的来源类别。空数组表示只接受字面量。 */
  allow: Origin[]
  /** 是否允许依赖链里出现任何 trusted=false 的根。 */
  allowUntrusted: boolean
}

export interface ToolContract {
  name: string
  args: Record<string, ArgContract>
  /** 不可逆：删除、支付、发布、合并、外发。这一位决定审批走哪条路。 */
  irreversible: boolean
  /** 结果会被组织外／可见性边界外的人看到。 */
  crossesBoundary: boolean
}

export interface Violation {
  arg: string
  role: ArgRole
  reason: string
  /** 把依赖链摊平，给人看的。 */
  chain: string[]
}

export interface CallVerdict {
  allowed: boolean
  violations: Violation[]
  /** 这次调用里，哪些参数是被不可信数据决定的。 */
  attackerControlled: string[]
}

/**
 * 在调用点检查每一个参数的来源。
 *
 * ★ 写错的方式只有一种，但它是默认的那种：**只检查工具名**。
 * §5 里每一个真实事故——GitHub MCP 的 toxic agent flow、EchoLeak、
 * CamoLeak、ForcedLeak——在"工具是否被允许"这个问题上都是**合法的**。
 * `read_file` 允许，`post_comment` 允许。出事的是参数。
 */
export function checkCall(
  contract: ToolContract,
  args: Record<string, Tainted<unknown>>,
  flow: Flow,
): CallVerdict {
  const violations: Violation[] = []
  const attackerControlled: string[] = []

  for (const [name, t] of Object.entries(args)) {
    const c = contract.args[name]
    const chain = flow.sourcesOf(t).map((p) => `${p.origin}:${p.source}${p.trusted ? '' : '(untrusted)'}`)
    if (flow.tainted(t)) attackerControlled.push(name)

    if (!c) {
      violations.push({
        arg: name,
        role: 'literal',
        reason: '契约里没有声明这个参数——未声明即拒绝，不是未声明即放行',
        chain,
      })
      continue
    }

    const origins = flow.origins(t)
    const bad = origins.filter((o) => !c.allow.includes(o))
    if (bad.length) {
      violations.push({
        arg: name,
        role: c.role,
        reason: `${c.role} 参数不接受来自 ${bad.join('/')} 的值（只接受 ${c.allow.join('/') || '字面量'}）`,
        chain,
      })
      continue
    }
    if (!c.allowUntrusted && flow.tainted(t)) {
      violations.push({
        arg: name,
        role: c.role,
        reason: `${c.role} 参数的依赖链里有不可信的根`,
        chain,
      })
    }
  }

  // 契约声明了、但这次没传的参数不算违规；传了而契约没声明的算（上面已处理）。
  return { allowed: violations.length === 0, violations, attackerControlled }
}

/**
 * 一组够用的默认契约。注意 `post_comment` 的 body 允许不可信来源
 * ——它本来就是要把读到的东西写出去——但 `repo` 不允许。
 * 这正是 GitHub MCP 那个事故里被突破的那一格。
 */
export const CONTRACTS: Record<string, ToolContract> = {
  read_issue: {
    name: 'read_issue',
    irreversible: false,
    crossesBoundary: false,
    args: {
      repo: { role: 'destination', allow: ['user', 'config'], allowUntrusted: false },
      number: { role: 'selector', allow: ['user', 'config', 'tool'], allowUntrusted: true },
    },
  },
  read_file: {
    name: 'read_file',
    irreversible: false,
    crossesBoundary: false,
    args: {
      path: { role: 'destination', allow: ['user', 'config'], allowUntrusted: false },
    },
  },
  post_comment: {
    name: 'post_comment',
    irreversible: true,
    crossesBoundary: true,
    args: {
      repo: { role: 'destination', allow: ['user', 'config'], allowUntrusted: false },
      number: { role: 'selector', allow: ['user', 'config', 'tool'], allowUntrusted: true },
      body: { role: 'payload', allow: ['user', 'config', 'tool'], allowUntrusted: true },
    },
  },
  send_money: {
    name: 'send_money',
    irreversible: true,
    crossesBoundary: true,
    args: {
      // CaMeL 的 banking 策略就是这么写的：收款人和金额都必须以用户为源，
      // 且依赖图里不能有别的不可信父节点。这也是它拒绝率最高的一个域。
      recipient: { role: 'destination', allow: ['user'], allowUntrusted: false },
      amount: { role: 'literal', allow: ['user'], allowUntrusted: false },
    },
  },
  fetch_url: {
    name: 'fetch_url',
    irreversible: false,
    crossesBoundary: true,
    args: {
      url: { role: 'destination', allow: ['user', 'config'], allowUntrusted: false },
    },
  },
}

// ─────────────────────────────────────────────────────────────
// 三、致命三要素与 Rule of Two
// ─────────────────────────────────────────────────────────────

/**
 * 会话在这三／四个维度上的能力。
 *
 * 致命三要素（Simon Willison，2025-06-16 13:20）：
 *   - Access to your private data
 *   - Exposure to untrusted content
 *   - The ability to externally communicate in a way that could be
 *     used to steal your data
 *
 * Meta 的 Agents Rule of Two（2025-10-31）把第三条**放宽**了：
 *   [C] An agent can **change state** or communicate externally
 *
 * ★ 差别在这里，而它对编码 agent 恰恰是关键的：
 * `rm -rf`、`terraform destroy`、合并一个 PR——纯粹的完整性/可用性
 * 破坏，零数据外流。这些**触发 Rule of Two，但不触发字面意义上的三要素**。
 */
export interface SessionCaps {
  privateData: boolean
  untrustedContent: boolean
  externalComms: boolean
  /** Rule of Two 的 [C] 多出来的那一半。 */
  stateChange: boolean
}

export interface TrifectaVerdict {
  /** Willison 的三要素是否全中。 */
  trifecta: boolean
  /** Rule of Two 是否被违反（三个属性全中）。 */
  ruleOfTwoViolated: boolean
  legs: string[]
  /** 拿掉哪一条最便宜。 */
  cheapestFix: string
  advice: string
}

export function trifecta(caps: SessionCaps): TrifectaVerdict {
  const legs: string[] = []
  if (caps.privateData) legs.push('私有数据')
  if (caps.untrustedContent) legs.push('不可信内容')
  if (caps.externalComms) legs.push('对外通信')
  if (caps.stateChange) legs.push('改变状态')

  const three = caps.privateData && caps.untrustedContent && caps.externalComms
  // Rule of Two：[A] 不可信输入 [B] 敏感系统/私有数据 [C] 改状态或对外通信
  const a = caps.untrustedContent
  const b = caps.privateData
  const c = caps.externalComms || caps.stateChange
  const violated = a && b && c

  // ★ 为什么"拿掉对外通信"总是最便宜的一条：另外两条通常是产品需求
  // ——agent 要读你的东西，也要读外面的东西。第三条往往是附带的。
  // 这也是十年来厂商实际做的事（Willison："usually by locking down
  // the exfiltration vector"）。
  let cheapestFix = '（没有需要拿掉的）'
  if (violated) {
    if (caps.externalComms) cheapestFix = '拿掉对外通信'
    else if (caps.stateChange) cheapestFix = '把改状态的操作移到审批之后'
    else cheapestFix = '把不可信内容隔到另一个会话'
  }

  return {
    trifecta: three,
    ruleOfTwoViolated: violated,
    legs,
    cheapestFix,
    advice: violated
      ? 'Rule of Two 被违反：三条同时成立就不能自主运行，至少要有监督，或者开一个新的上下文窗口'
      : '三条里最多占两条，可以自主运行',
  }
}

// ─────────────────────────────────────────────────────────────
// 四、通道：只有「移除」有记录，「过滤」全被绕过
// ─────────────────────────────────────────────────────────────

export interface Channel {
  name: string
  kind: 'render' | 'network' | 'dns' | 'tool'
  /** 你对它做了什么。 */
  mitigation: 'none' | 'filter' | 'remove'
  /** ★ 你的执行点**看得见**它吗。 */
  enforceable: boolean
  note?: string
}

export interface ChannelReport {
  /** 真正关掉的。 */
  closed: string[]
  /** 只加了过滤——按历史记录，这一类全部被绕过过。 */
  filteredOnly: string[]
  /** 你的执行点根本看不见的。 */
  blind: string[]
  open: string[]
  verdict: string
}

/**
 * 历史记录：每一个"过滤"都被绕过了，每一个"移除"都守住了。
 * 这张表本身就是这一节的论据。
 */
export const FILTER_RECORD: { control: string; vendor: string; outcome: 'bypassed' | 'held'; how: string }[] = [
  { control: '重写外链（inline markdown）', vendor: 'M365 Copilot', outcome: 'bypassed', how: '参考式 markdown `[t][ref]` 没被覆盖' },
  { control: 'CSP img-src 白名单', vendor: 'M365 Copilot', outcome: 'bypassed', how: '`*.teams.microsoft.com` 上有一个开放代理' },
  { control: 'CSP 白名单（Trusted URL）', vendor: 'Salesforce Agentforce', outcome: 'bypassed', how: '白名单里的域名过期了，5 美元重新注册' },
  { control: '**签名**图片代理（Camo，HMAC）', vendor: 'GitHub Copilot Chat', outcome: 'bypassed', how: '按字母表预先铸好一批合法签名 URL，一次请求泄一个字符' },
  { control: '注入分类器（XPIA）', vendor: 'Microsoft', outcome: 'bypassed', how: '第一人称措辞，从不提"Copilot"或 AI' },
  { control: '**整个关掉图片渲染**', vendor: 'GitHub Copilot Chat', outcome: 'held', how: '通道没了' },
  { control: '**服务端维护的出站白名单**', vendor: 'Salesforce', outcome: 'held', how: '即使 agent 完全被控也拦得住' },
  { control: '**不带凭据浏览**（logged out mode）', vendor: 'OpenAI Atlas', outcome: 'held', how: '拿掉的是 [B] 那条腿，不是防 [A]' },
]

export function auditChannels(channels: Channel[]): ChannelReport {
  const closed: string[] = []
  const filteredOnly: string[] = []
  const blind: string[] = []
  const open: string[] = []

  for (const c of channels) {
    if (c.mitigation === 'remove') {
      closed.push(c.name)
      continue
    }
    // ★ 顺序要紧：看不见的通道，加什么过滤都没意义。
    if (!c.enforceable) {
      blind.push(c.name)
      continue
    }
    if (c.mitigation === 'filter') filteredOnly.push(c.name)
    else open.push(c.name)
  }

  const leaks = open.length + blind.length + filteredOnly.length
  return {
    closed,
    filteredOnly,
    blind,
    open,
    verdict:
      leaks === 0
        ? '所有通道都已移除'
        : `还有 ${leaks} 条通道可用：${blind.length} 条你看不见、${filteredOnly.length} 条只加了过滤（历史上这一类全被绕过）、${open.length} 条完全敞着`,
  }
}

// ─────────────────────────────────────────────────────────────
// 五、审批：一个可插拔的策略决策点
// ─────────────────────────────────────────────────────────────

export type Risk = 'low' | 'medium' | 'high' | 'critical'

export interface Action {
  tool: string
  /** 渲染出来给人／给 reviewer 看的那一行。 */
  rendered: string
  irreversible: boolean
  crossesBoundary: boolean
  /** 这次调用里被不可信数据决定的参数。 */
  attackerControlled: string[]
  /** 改变监督机制本身（关沙箱、改权限、改 CI、给自己的 PR 批准）。 */
  altersOversight: boolean
}

export interface Decision {
  allow: boolean
  reason: string
  by: 'circuit-breaker' | 'unresolved' | 'rule' | 'reviewer' | 'fail-closed'
  risk: Risk
}

/**
 * 风险分级。Codex 的 reviewer policy 就是四档，且处置规则是写死的：
 * "Low-risk and medium-risk actions can proceed when policy allows them.
 *  The policy **denies critical-risk** actions. **High-risk** actions
 *  require enough user authorization and no matching deny rule."
 *
 * ★ 主轴是**可逆性**，不是"危险程度"。OWASP LLM03:2026 给的例子最清楚：
 * 客服 agent 可以自动退成**店铺积分**（可恢复），而**对外付款**
 * （不可逆）必须走人工。
 */
/** 工厂：和 l14/inject.ts 的 TODO 表面保持一致，方便一套测试测两边。 */
export function makeFlow(strict = false): Flow {
  return new Flow(strict)
}

export function classifyRisk(a: Action): Risk {
  // 改变监督机制本身：永远是 critical。三家厂商在这一条上完全一致。
  if (a.altersOversight) return 'critical'
  // ★ 这一行是整个分级里唯一真正重要的一行：
  // 一个不可逆、跨边界的动作，**当它的参数被不可信数据决定时**才是 critical。
  // 参数干净的同一个动作只是 high——它需要授权，不是需要禁止。
  // 把这两件事合并成"post_comment 一律 critical"，就等于把这个工具废掉：
  // 那正是 AgentDojo 那个分类器付出的代价（可用性 69.07% → 41.24%）。
  if (a.irreversible && a.crossesBoundary && a.attackerControlled.length > 0) return 'critical'
  if (a.irreversible) return 'high'
  if (a.crossesBoundary && a.attackerControlled.length > 0) return 'high'
  if (a.crossesBoundary) return 'medium'
  return 'low'
}

/**
 * 熔断器：任何规则、任何钩子、任何 reviewer 都不能放行的一组操作。
 *
 * Claude Code 对这件事的措辞值得一字不改地记住：
 * "Claude Code **never** lets a `permissions.allow` rule or a
 *  `PreToolUse` hook that returns `allow` approve an `rm` or `rmdir`
 *  command that targets a critical path, even in modes that skip other
 *  prompts. **This circuit breaker guards against model error.**"
 *
 * ★ 而它必须是**替换感知**的。同样是官方文档：
 * "Hiding the removal inside command substitution with `$(...)` or
 *  backticks, or process substitution with `<(...)`, doesn't skip the
 *  check... whether it sits inside the substitution, as in
 *  `echo "$(rm -rf ~)"`, or elsewhere in the same command."
 */
export const CRITICAL_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*r[a-zA-Z]*)\s+(-[a-zA-Z]+\s+)*(~|\/|\$HOME)\s*(\/\s*)?$/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(~|\/|\$HOME)(\/\s|$|\s)/,
  /\brm(dir)?\s+.*\s(\/|~)\s*$/,
  /\bRemove-Item\b[^|;]*\s(\*|.*[\\/]\*)\s*$/,
  /\bgit\s+push\s+.*--force\b.*\b(main|master)\b/,
  /\bterraform\s+destroy\b/,
  /\b(chmod|chown)\s+-R\s+.*\s\/\s*$/,
  /:\(\)\{.*\|.*&.*\};:/,
  // ★ 关掉监督机制本身的那几个开关，按厂商实际的 flag 名字写。
  // 这一条必须在**熔断器**里，不能只在 classifyRisk 里：
  // classifyRisk 需要有人先把 altersOversight 标成 true，
  // 而这条命令是 agent 自己拼出来的一个字符串，没人会去标它。
  // 熔断器是唯一一个"谁都不能覆盖"的位置，所以它必须自己认得出来。
  /--dangerously-skip-permissions\b/,
  /--yolo\b/,
  /\bsandbox[_-]?mode\s*=\s*["']?danger/i,
  /\bapproval[_-]?policy\s*=\s*["']?never/i,
  /--allowedTools\s+["']?\*/,
]

/** 把 `$(...)`、反引号、`<(...)` 里的内容也摊出来检查。 */
export function expandSubstitutions(cmd: string): string[] {
  const out = [cmd]
  const patterns = [/\$\(([^()]*)\)/g, /`([^`]*)`/g, /<\(([^()]*)\)/g, /\$\{([^{}]*)\}/g]
  let frontier = [cmd]
  for (let depth = 0; depth < 4 && frontier.length; depth += 1) {
    const next: string[] = []
    for (const s of frontier) {
      for (const re of patterns) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(s)) !== null) {
          if (m[1] && m[1].trim()) {
            out.push(m[1])
            next.push(m[1])
          }
        }
      }
    }
    frontier = next
  }
  return out
}

export function circuitBreaker(rendered: string): Decision | null {
  for (const piece of expandSubstitutions(rendered)) {
    for (const re of CRITICAL_PATTERNS) {
      if (re.test(piece.trim())) {
        return {
          allow: false,
          reason: `熔断：命令里出现了不可放行的操作（${piece.trim().slice(0, 60)}）`,
          by: 'circuit-breaker',
          risk: 'critical',
        }
      }
    }
  }
  return null
}

/**
 * 参数解析：不能解析出实际目标的命令，不批。
 *
 * Claude Code v2.1.205+ 的规则，原文：`rm -rf "$VAR"` 在 `$VAR`
 * "isn't assigned anywhere in the conversation the classifier sees.
 *  The value came only from earlier command output, which the classifier
 *  never receives, so the classifier can't verify the deletion target."
 * 把解析后的字面路径写进命令，这个 block 就解除。
 */
export function resolveArgs(
  rendered: string,
  env: Record<string, string>,
): { resolved: string; unresolved: string[]; substitutions: string[] } {
  const unresolved: string[] = []
  const resolved = rendered.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole: string, name: string) => {
    const hit = env[name]
    if (hit !== undefined) return hit
    unresolved.push(name)
    return whole
  })
  // ★ 命令替换是另一半：`rm -rf $(echo ~)` 里没有任何未定义的变量，
  // 但目标同样是**静态解析不出来**的——它由另一条命令在运行时产生。
  // 熔断器抓的是"删除藏在替换里"（`echo "$(rm -rf ~)"`），
  // 这里抓的是反过来的那一半："目标从替换里出来"。
  const substitutions = expandSubstitutions(rendered).slice(1)
  return { resolved, unresolved: [...new Set(unresolved)], substitutions }
}

/** reviewer 能看到的上下文。★ 注意这里**没有** toolResults 这个字段。 */
export interface ReviewContext {
  userMessages: string[]
  /** 应用自己加的注解，可信通道。对应 Claude Code 的 classifierContext。 */
  appContext: string[]
  risk: Risk
  provenanceChain: string[]
}

export interface Reviewer {
  name: string
  review(a: Action, ctx: ReviewContext): Promise<Decision>
}

/** 永远放行。用来演示"没有审批"这个基线。 */
export class AutoApprove implements Reviewer {
  name = 'auto'
  async review(a: Action): Promise<Decision> {
    return { allow: true, reason: '无条件放行', by: 'rule', risk: classifyRisk(a) }
  }
}

/** 按风险档位的确定性规则。这是 Codex 那张处置表。 */
export class RuleBased implements Reviewer {
  name = 'rules'
  constructor(private readonly authorized: Set<string> = new Set()) {}
  async review(a: Action): Promise<Decision> {
    const risk = classifyRisk(a)
    if (risk === 'critical') return { allow: false, reason: 'critical 一律拒绝', by: 'rule', risk }
    if (risk === 'high') {
      const ok = this.authorized.has(a.tool)
      return {
        allow: ok,
        reason: ok ? 'high，但用户已授权这个工具' : 'high 且没有足够的用户授权',
        by: 'rule',
        risk,
      }
    }
    return { allow: true, reason: `${risk}，策略允许`, by: 'rule', risk }
  }
}

/**
 * 模型 reviewer。构造函数刻意**不接收**工具结果——
 * 这就是 Claude Code 那句 "Tool results are stripped" 的代码形态。
 */
export class ModelReviewer implements Reviewer {
  name = 'model'
  constructor(private readonly judge: (a: Action, ctx: ReviewContext) => Promise<boolean>) {}
  async review(a: Action, ctx: ReviewContext): Promise<Decision> {
    const risk = classifyRisk(a)
    const ok = await this.judge(a, ctx)
    return { allow: ok, reason: ok ? '模型 reviewer 放行' : '模型 reviewer 拒绝', by: 'reviewer', risk }
  }
}

export interface GatePolicy {
  /** 写在**文件**里的 deny 规则。★ 不写在对话里。 */
  deny: string[]
  /** 已被用户显式授权的工具。 */
  authorized: string[]
  /** 环境里能解析出来的变量。 */
  env: Record<string, string>
}

/**
 * 策略决策点。顺序是故意的，每一步都能引到一条一手依据：
 *
 *   1. 熔断器      —— 任何东西都不能覆盖（Claude Code）
 *   2. deny 规则   —— 来自**文件**，不来自对话（INV-19：上下文压缩会把
 *                     对话里说过的边界弄丢，"a boundary can be lost if
 *                     context compaction removes the message that stated it"）
 *   3. 参数解析    —— 解析不出实际目标就不批（Claude Code v2.1.205+）
 *   4. reviewer    —— 人 / 规则 / 模型
 *   5. 出错        —— ★ fail closed（Codex："Prompt-build, review-session,
 *                     and parse failures fail closed."）
 *
 * ★ 第 5 条是 Claude Code 和 Codex 明确不一致的地方：Claude Code 的
 * subagent review 在安全检查本身失败时**放行**，只在结果前面贴一句
 * "unreviewed and should be treated as untrusted"。而 INV-13 的数据说
 * 人经常不读那句话。所以这里选 fail closed。
 */
export class Gate {
  constructor(
    private readonly reviewer: Reviewer,
    private readonly policy: GatePolicy,
  ) {}

  async decide(a: Action): Promise<Decision> {
    const breaker = circuitBreaker(a.rendered)
    if (breaker) return breaker

    for (const d of this.policy.deny) {
      if (a.rendered.includes(d) || a.tool === d) {
        return { allow: false, reason: `命中 deny 规则「${d}」（来自策略文件）`, by: 'rule', risk: classifyRisk(a) }
      }
    }

    const risk = classifyRisk(a)
    const { unresolved, substitutions } = resolveArgs(a.rendered, this.policy.env)
    if (unresolved.length) {
      return {
        allow: false,
        reason: `解析不出 ${unresolved.map((v) => '$' + v).join('、')} 的实际值，无法确认这条命令作用在哪儿`,
        by: 'unresolved',
        risk,
      }
    }
    if (substitutions.length && (risk === 'high' || risk === 'critical')) {
      return {
        allow: false,
        reason: `目标由命令替换产生（${substitutions[0]!.slice(0, 40)}），${risk} 风险的动作不能在目标未知时放行`,
        by: 'unresolved',
        risk,
      }
    }

    const ctx: ReviewContext = { userMessages: [], appContext: [], risk, provenanceChain: a.attackerControlled }
    try {
      return await this.reviewer.review(a, ctx)
    } catch (err) {
      return { allow: false, reason: `reviewer 失败，fail closed：${(err as Error).message}`, by: 'fail-closed', risk }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 六、rug pull：用内容绑定，不用定期扫描
// ─────────────────────────────────────────────────────────────

export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: unknown
}

/**
 * ★ 三个字段都要进哈希。只哈希 description 会漏掉**改 schema** 的那一半
 * ——而实测里 24.8% 的 server 改过 descriptor，只有 8.6% 改过 description。
 */
export function makeGate(reviewer: Reviewer, policy: GatePolicy): Gate {
  return new Gate(reviewer, policy)
}

export function toolFingerprint(t: ToolDescriptor): string {
  const canon = JSON.stringify([t.name, t.description, t.inputSchema])
  return createHash('sha256').update(canon).digest('hex').slice(0, 16)
}

export interface Pin {
  name: string
  fingerprint: string
  pinnedAt: number
}

export function pinTools(tools: ToolDescriptor[], at = 0): Pin[] {
  return tools.map((t) => ({ name: t.name, fingerprint: toolFingerprint(t), pinnedAt: at }))
}

export interface DriftReport {
  changed: string[]
  added: string[]
  removed: string[]
  /** 需要重新征求同意的。 */
  needsReapproval: boolean
}

/**
 * 每次 tools/list 都比一遍。
 *
 * ★ 为什么不用"定期重扫高漂移的 server"：实测数据说那个策略在
 * top-5% 预算下只覆盖到**全部描述变更的约 10%**，因为
 * "roughly half of all description changes land on **new arrivals**
 *  a history ranking cannot reach."
 * 论文自己给的控制就是 content-binding —— 哈希一动就重新校验。
 *
 * 而 MCP 2026-07-28 把 `ttlMs` 和 `cacheScope` 变成了 tools/list 的
 * **必填**字段，也就是说协议现在正式承认客户端会拿着一份可能过期的
 * 工具描述做事。rug pull 的窗口被写进了协议里。
 */
export function checkDrift(pins: Pin[], now: ToolDescriptor[]): DriftReport {
  const byName = new Map(pins.map((p) => [p.name, p]))
  const seen = new Set<string>()
  const changed: string[] = []
  const added: string[] = []

  for (const t of now) {
    seen.add(t.name)
    const pin = byName.get(t.name)
    if (!pin) {
      added.push(t.name)
      continue
    }
    if (pin.fingerprint !== toolFingerprint(t)) changed.push(t.name)
  }
  const removed = pins.filter((p) => !seen.has(p.name)).map((p) => p.name)

  return {
    changed,
    added,
    removed,
    needsReapproval: changed.length > 0 || added.length > 0,
  }
}

// ─────────────────────────────────────────────────────────────
// 七、不可见字符：诚实地说，这不是注入防御
// ─────────────────────────────────────────────────────────────

/**
 * 标签块 U+E0000–U+E007F、变体选择符 U+FE00–U+FE0F、
 * 零宽 U+200B/200C/200D/2060。
 *
 * ★ 这 15 行值得写，但**理由不是"能防注入"**。OWASP LLM01:2026 推荐
 * 在每一个 ingest 和 render 边界都做剥离，同时自己加了限定：
 * "Stripping does not stop visible-text payloads or future
 *  steganographic classes."
 *
 * 它真正的价值是关掉一条**双向**的隐蔽信道：既防止不可见指令进来，
 * 也防止不可见数据出去。同时它让 OWASP 那条审批要求变得可能——
 * "Invisible character smuggling can make the displayed action differ
 *  from the executed one."
 * 你显示给人看的那一行，必须和真正要执行的那一行是同一行。
 */
export const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF\uFE00-\uFE0F\u{E0000}-\u{E007F}]/gu

export function stripInvisible(s: string): { text: string; removed: number; codepoints: string[] } {
  const codepoints: string[] = []
  const text = s.replace(INVISIBLE_RE, (m) => {
    for (const ch of m) codepoints.push('U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'))
    return ''
  })
  return { text, removed: codepoints.length, codepoints }
}

/** 显示的和执行的是不是同一个字符串。 */
export function displayMatchesExecution(displayed: string, executed: string): boolean {
  return stripInvisible(displayed).text === stripInvisible(executed).text && displayed === executed
}

// ─────────────────────────────────────────────────────────────
// 八、沙箱：厂商自己说它不是边界
// ─────────────────────────────────────────────────────────────

/**
 * 一份沙箱配置。字段是照三家厂商实际的配置面抄的。
 *
 * ★ 先记住这句，它是 Claude Code 官方文档原文：
 *   "**Sandboxing reduces risk but is not a complete isolation boundary.**
 *    Review the limitations below before relying on it as a hard security
 *    control."
 *
 * 以及 AWS 对容器的表态，同样是原文：
 *   "**AWS does not consider containers a security boundary**, and does
 *    not utilize containers to isolate customers from each other."
 * 2025-11-05 那三个 runc 逃逸里，有**两个影响所有已知版本**。
 *
 * 所以沙箱是**爆炸半径缩减器**，不是信任边界。这不妨碍它是你能做的
 * 性价比最高的事之一——只是别把它当成那个能让你睡着觉的东西。
 */
export interface SandboxSpec {
  allowWrite: string[]
  denyWrite: string[]
  allowRead: string[]
  denyRead: string[]
  /** 出站域名白名单。 */
  allowedDomains: string[]
  /**
   * 白名单的**执行点开了没有**。
   *
   * ★ 这个字段看着多余，它恰恰是这一节最便宜的一次"配置对了但没生效"。
   * Codex 官方文档，原文："Adding domain rules **does not enable** the
   * [proxy]." 完整真值表是：
   *
   *   网络关 + 代理开   → 网络还是关的，这个开关什么也没做
   *   网络开 + 代理关   → "network stays on with **unrestricted direct**"
   *   网络开 + 代理开   → 才真的受限
   *
   * 也就是说：你可以写一份语法完全正确、审计也能通过的白名单，
   * 而它一条都不拦。而这件事**不会有任何报错**——请求正常发出、
   * 正常返回，只是没走那个代理。
   */
  proxyEnabled: boolean
  /**
   * 要清掉的环境变量。
   * ★ Claude Code 原文："There is **no built-in credential deny list**,
   * so only the files and variables you list are restricted." 而且
   * "sandboxed Bash commands **inherit the parent process environment
   * by default, including any credentials set there**."
   * 也就是说：你不列，它就在里面。
   */
  scrubEnv: string[]
  /**
   * 沙箱**管得着**的工具。
   * ★ Claude Code 的沙箱只隔离 Bash 子进程——Read/Edit/Write 走的是
   * 权限系统，不走沙箱；Computer Use "runs on your actual desktop"。
   */
  covers: string[]
  /** 代理是否终止 TLS。不终止就挡不住 domain fronting。 */
  tlsTerminate: boolean
  /** 沙箱是不是同时也是唯一的 DNS 解析器。 */
  ownsResolver: boolean
  /** 允许 agent 请求退出沙箱重跑（Claude Code 的 dangerouslyDisableSandbox）。 */
  allowUnsandboxedRetry: boolean
}

export interface PathVerdict {
  allow: boolean
  /** 命中的那条规则。最长匹配优先。 */
  rule: string
}

/**
 * 路径判定：**最具体的规则赢**。
 *
 * 这条语义是有意设计的，Claude Code 的文档给了三行表来说明它：
 *   denyRead:["~/"] + allowRead:["~/projects"]  → 只有 ~/projects 可读
 *   allowRead:["~/"] + denyRead:["~/.env"]      → ~/.env 挡住，其余可读
 *                                                 "a broad allow can't
 *                                                  silently re-expose a secret"
 *   allowRead:["~/"] + denyRead:["~/ **‌/.env"]  → 通配的 deny 在更宽的
 *                                                 allow 里依然成立
 *
 * ★ 如果你写成"先看 allow 再看 deny"或者反过来，上面第二行就会错，
 * 而它不会报错——它只会让 ~/.env 可读。
 */
export function pathVerdict(spec: SandboxSpec, path: string, mode: 'read' | 'write'): PathVerdict {
  const allows = mode === 'read' ? spec.allowRead : spec.allowWrite
  const denies = mode === 'read' ? spec.denyRead : spec.denyWrite

  const match = (pattern: string): number => {
    // `**` 匹配任意层级；否则按前缀匹配。返回具体度（越大越具体），-1 表示不匹配。
    if (pattern.includes('**')) {
      const re = new RegExp('^' + pattern.split('**').map(escapeRe).join('.*') + '$')
      return re.test(path) ? pattern.replace(/\*/g, '').length : -1
    }
    if (path === pattern || path.startsWith(pattern.endsWith('/') ? pattern : pattern + '/')) {
      return pattern.length
    }
    return -1
  }

  let best = { allow: false, rule: '（无匹配规则，默认拒绝）', score: -1 }
  for (const p of allows) {
    const s = match(p)
    if (s > best.score) best = { allow: true, rule: `allow ${p}`, score: s }
  }
  for (const p of denies) {
    const s = match(p)
    // ★ 同样具体时 deny 赢。Cursor 说得最直白："deny always beats allow"。
    if (s >= best.score && s >= 0) best = { allow: false, rule: `deny ${p}`, score: s }
  }
  return { allow: best.allow, rule: best.rule }
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface EgressVerdict {
  allow: boolean
  reason: string
  /** 就算 allow=false，这些理由说明它仍然可能出得去。 */
  caveats: string[]
}

/** 已知会把整条白名单变成摆设的域名。 */
export const OVERBROAD_DOMAINS = ['github.com', 'githubusercontent.com', 'gist.github.com', 's3.amazonaws.com']

export function egressVerdict(spec: SandboxSpec, host: string): EgressVerdict {
  // ★ 这一步必须在最前面。执行点没开的时候，白名单的内容**完全不影响结果**——
  // 每个 host 都出得去。把它写在"命中白名单吗"之后，你会得到一个
  // 语义上完全错误但看起来很合理的 allow=false。
  if (!spec.proxyEnabled) {
    return {
      allow: true,
      reason: '★ 代理没开：白名单一条都没生效，这个 host 直连出去了',
      caveats: [
        `白名单里写了 ${spec.allowedDomains.length} 条，但 Codex 官方原文是 "Adding domain rules does not enable the [proxy]"——网络开 + 代理关 = "unrestricted direct"`,
      ],
    }
  }
  const hit = spec.allowedDomains.find((d) =>
    d.startsWith('*.') ? host.endsWith(d.slice(1)) : host === d,
  )
  const caveats: string[] = []
  if (!spec.tlsTerminate) {
    caveats.push('代理不终止 TLS，按客户端给的 hostname 判定——domain fronting 可绕过（Claude Code 官方限制）')
  }
  if (!spec.ownsResolver) {
    caveats.push('沙箱不是唯一解析器：数据可以编码进子域名标签，DNS 帮你把它送出去，白名单看不到任何 HTTP 请求')
  }
  for (const d of spec.allowedDomains) {
    const bare = d.replace(/^\*\./, '')
    if (OVERBROAD_DOMAINS.includes(bare)) {
      caveats.push(`白名单里的 ${d} 托管任意攻击者可写内容（gist / issue / PR），等价于放开`)
    }
  }
  return {
    allow: Boolean(hit),
    reason: hit ? `命中白名单 ${hit}` : '不在白名单里',
    caveats,
  }
}

/**
 * 沙箱漏掉的那些东西。
 *
 * ★ 这张清单上**每一条都是某个在售产品里被记录在案的缺口**，
 * 不是我想出来的。它比沙箱本身更值得读一遍。
 */
export function sandboxGaps(spec: SandboxSpec, env: Record<string, string>): string[] {
  const gaps: string[] = []

  const secretish = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|_PAT$/i
  const leaked = Object.keys(env).filter((k) => secretish.test(k) && !spec.scrubEnv.includes(k))
  if (leaked.length) {
    gaps.push(`环境变量：${leaked.join('、')} 会被子进程继承（没有内置的默认拒绝清单，你不列就在里面）`)
  }
  if (!spec.covers.includes('read_file') || !spec.covers.includes('write_file')) {
    gaps.push('非 Bash 工具：Read/Edit/Write 走权限系统而不是沙箱，路径规则对它们不生效')
  }
  // ★ 排在 DNS 和 domain fronting 前面：那两条是"白名单能被绕过"，
  // 这一条是"白名单根本没接上"。后者让前两条都变成无关紧要的细节。
  if (!spec.proxyEnabled && spec.allowedDomains.length > 0) {
    gaps.push(
      `出站白名单写了 ${spec.allowedDomains.length} 条但代理没开——一条都不生效（Codex 官方："Adding domain rules does not enable the [proxy]"）`,
    )
  }
  if (!spec.ownsResolver) gaps.push('DNS：一条零 HTTP 也能用的外发通道')
  if (!spec.tlsTerminate) gaps.push('domain fronting：SNI 白名单可绕过')
  if (spec.allowUnsandboxedRetry) {
    gaps.push('沙箱可被请求关闭：违规会连同被拒的路径/主机一起回给模型，模型可以带着 dangerouslyDisableSandbox 重试')
  }
  const writable = spec.allowWrite
  if (writable.some((p) => p.includes('.git') && !spec.denyWrite.some((d) => d.includes('.git')))) {
    gaps.push('.git/hooks：pre-commit 是一次由后续无害命令触发的任意代码执行')
  }
  if (!spec.denyWrite.some((p) => /\.(bashrc|zshrc|profile)|\/bin|PATH/.test(p))) {
    gaps.push('shell 启动文件与 $PATH 目录：写进去就是下一次运行时的提权')
  }
  if (!spec.denyRead.some((p) => p.includes('docker.sock') || p.includes('/var/run'))) {
    gaps.push('Unix socket：/var/run/docker.sock 等于宿主机 root；SSH agent、kubelet 同理')
  }
  if (!spec.denyWrite.some((p) => /\.claude|\.codex|\.cursor|\.agents/.test(p))) {
    gaps.push('agent 自己的配置目录：写进去就是给自己改下一次的权限')
  }
  gaps.push('MCP 连接、连接器工具、内置 web search、云端任务：代理一律看不见（OpenAI 自己的文档）')
  return gaps
}

// ─────────────────────────────────────────────────────────────
// 九、两轴指标：安全和可用性必须一起报
// ─────────────────────────────────────────────────────────────

export interface SuiteCase {
  name: string
  kind: 'attack' | 'benign'
  /** attack：是否被挡住。benign：是否仍然完成。 */
  passed: boolean
}

export interface TwoAxis {
  /** 攻击成功率。分母是攻击用例数。 */
  asr: number
  /** 良性任务完成率。 */
  utility: number
  attacks: number
  benign: number
  /** 相对无防御基线的可用性损失（百分点）。 */
  utilityDelta: number
  verdict: string
}

/**
 * ★ 只报一个数字是这个领域最常见的错误报告方式。
 *
 * AgentDojo 官方结果页上那一行是最好的反面教材：
 * `transformers_pi_detector` 把定向 ASR 从 47.69% 压到 **7.95%**——
 * 听起来很成功。同一行里，良性可用性从 **69.07% 掉到 41.24%**。
 * 论文作者自己的话："The prompt injection detector has too many false
 * positives, however, and significantly degrades utility."
 *
 * 掉了 27.8 个百分点，相对损失 40%。那不是一个防御，
 * 那是决定发布一个更差的产品。
 */
export function twoAxis(cases: SuiteCase[], baselineUtility = 1): TwoAxis {
  const attacks = cases.filter((c) => c.kind === 'attack')
  const benign = cases.filter((c) => c.kind === 'benign')
  const blocked = attacks.filter((c) => c.passed).length
  const completed = benign.filter((c) => c.passed).length

  const asr = attacks.length ? (attacks.length - blocked) / attacks.length : 0
  const utility = benign.length ? completed / benign.length : 0
  const utilityDelta = (utility - baselineUtility) * 100

  // ★ 三档，而分界线 −15 个百分点不是拍脑袋的：
  //   CaMeL 的代价是 77% vs 84% 无防御 = −7 pp，产品还在
  //   AgentDojo 那个注入分类器是 69.07% → 41.24% = −27.8 pp，产品没了
  // 把这两件事叫同一个名字，是这个领域最常见的混淆。
  const cost = -utilityDelta
  let verdict: string
  if (attacks.length === 0 || benign.length === 0) {
    verdict = '★ 两轴缺一轴：只测攻击或只测良性，得到的数字没有意义'
  } else if (asr === 0 && cost <= 15) {
    verdict = `安全轴归零，代价 ${cost.toFixed(1)} 个百分点——架构型防御的形状（CaMeL 是 −7）`
  } else if (asr === 0) {
    verdict = `★ 安全轴归零，但可用性掉了 ${cost.toFixed(1)} 个百分点——分类器的形状（AgentDojo 那行是 −27.8）`
  } else if (cost <= 5) {
    verdict = `可用性没掉，但还有 ${(asr * 100).toFixed(1)}% 的攻击打穿`
  } else {
    verdict = `★ 两轴都差：ASR ${(asr * 100).toFixed(1)}%，可用性还掉了 ${cost.toFixed(1)} 个百分点`
  }

  return { asr, utility, attacks: attacks.length, benign: benign.length, utilityDelta, verdict }
}

/**
 * 报一个 ASR 数字时必须同时给出的六项。少一项，这个数字就不可比。
 *
 * 最刺眼的两个例子：
 *   - LLMail-Inject 被到处引用的是 0.8% / 0.3%——那是**每次提交**的成功率。
 *     同一篇论文里，**每支队伍**在四种防御全开时的成功率是 **16.6%**，
 *     且 60% 的队伍平均 89 次尝试就打穿了 Prompt Shield。
 *   - `claude-3-5-sonnet-20240620` 的 ASR 是 33.86%，
 *     `claude-3-5-sonnet-20241022` 是 1.11%。同一个模型名，差 30 倍。
 */
export interface AsrClaim {
  asr: number
  denominator: 'attempt' | 'adversary'
  adaptive: boolean
  modelSnapshot: string
  benchmarkVersion: string
  benignUtility: number | null
}

export function claimIsComparable(c: AsrClaim): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  if (c.denominator !== 'adversary') missing.push('分母应当是「每个对手」而不是「每次尝试」')
  if (!c.adaptive) missing.push('攻击方没有自适应——静态基准上的低 ASR 不构成安全性质')
  if (!/\d{8}|\d{4}-\d{2}-\d{2}/.test(c.modelSnapshot)) missing.push('模型快照没有日期')
  if (!c.benchmarkVersion) missing.push('没有基准版本号')
  if (c.benignUtility === null) missing.push('没有同时报良性可用性')
  return { ok: missing.length === 0, missing }
}
