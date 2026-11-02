/**
 * L19x · TS agent 生态：框架替你写了哪一段、哪些默认值会咬人、你的不变量接在哪。
 *
 *     cd labs && pnpm eco19                         # 九个观察实验
 *     cd labs && pnpm verify:l19x                   # 测你的六个适配器
 *     cd labs && ECO19_IMPL=shared pnpm verify:l19x # 测参考实现
 *
 * ★ 这个 lab 不装任何框架。框架的行为来自 fixtures/ecosystem.json——调研在锁定版本上实测录下来的结果
 *   （ai@7.0.137、@mastra/core@1.76.0、@anthropic-ai/claude-agent-sdk@0.3.296、@openai/agents-core@0.20.0）。
 *   版本号就是这些结论的有效期：升级之后，第一件事是重新录一遍。
 *
 * 你要写的是六个**适配器**：把 L05–L19 手写过的不变量，接到框架开放的扩展点上
 * （stopWhen、execute 包装 / errorFunction、审批恢复、MCP 结果转换、历史重建），外加把一份 Dify DSL 读成代码计划。
 */

import { readFileSync } from 'node:fs'
import {
  aiSdkIsStepCount,
  aiSdkMcpWire,
  auditBackfill,
  choosePlatform,
  courseMcpWire,
  courseStopReason,
  courseToolError,
  deepseekSees,
  difyPlan,
  fmtUsd,
  frameworkBackfill,
  rebuildHistory,
  resumeOnce,
  runStateResume,
  simulateDefaultLoop,
  uiRoundTrip,
  type BackfillRule,
  type DifyPlan,
  type Json,
  type Kv,
  type LoggedResult,
  type LoopDefault,
  type McpResult,
  type PlatformNeeds,
  type Rebuilt,
  type ResumeOutcome,
  type Step,
  type StopOpts,
  type StopReason,
  type ToolErr,
  type UiToolPart,
} from '../shared/tsecosystem.ts'
import { isMain } from '../shared/entry.ts'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const w = (s: string) =>
  [...visible(s)].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string | number, n: number) => String(s) + ' '.repeat(Math.max(0, n - w(String(s))))
const J = (x: unknown) => JSON.stringify(x)
/** 多行文本压成一行显示。 */
const oneLine = (s: string) => s.split('\n').join(' ⏎ ')

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────

export interface Fixtures {
  versions: [string, string][]
  loops: LoopDefault[]
  toolError: ToolErr & { tool: string }
  backfills: BackfillRule[]
  mcpCases: { label: string; result: McpResult }[]
  ui: { modelSaw: string; toolCallId: string }
  history: { log: LoggedResult[]; ui: UiToolPart[] }
  runState: { bytes: number; measuredEffects: number[]; evidence: string }
  thinking: { path: string; signature: boolean; outcome: string; silent: boolean }[]
  defaults: { inv: string; what: string; default: string; fix: string; evidence: string }[]
  claudeAgentSdk: {
    permissionMode: string
    mainModel: string
    classifierModel: string
    classifierPerMainRequest: number
    classifierMaxTokens: string
    classifierSystemStart: string
    autoDenial: string
    defaultSystemPrompt: string[]
    sessions: { run: string; sessionId: string; messages: number; costMicroUsd: number }[]
    costExcludes: string
  }
  dify: Json
}

const FX_TEXT = readFileSync(new URL('./fixtures/ecosystem.json', import.meta.url), 'utf8')

/** 每次返回一份新的拷贝。 */
export function fx(): Fixtures {
  return JSON.parse(FX_TEXT) as Fixtures
}

/** 同一个工具、同一个参数，连续失败 n 步。 */
export function failingSteps(n: number, varyArgs = false): Step[] {
  const out: Step[] = []
  for (let i = 0; i < n; i++) out.push({ toolCalls: [{ name: 'read_file', args: { path: varyArgs ? `nope${i}` : 'nope' } }], finishReason: 'tool-calls' })
  return out
}

/** 逐步喂给停止条件，返回第一次停下的步数（1 起）和原因；一直没停返回 [0, 'running']。 */
export function firstStop(steps: Step[], reasonOf: (s: Step[]) => StopReason | boolean): [number, string] {
  for (let k = 1; k <= steps.length; k++) {
    const r = reasonOf(steps.slice(0, k))
    if (r !== 'running' && r !== false) return [k, r === true ? 'stop' : r]
  }
  return [0, 'running']
}

export const SCENARIOS: [string, PlatformNeeds][] = [
  [
    '内部运营：查库存、出日报',
    { fixedFlow: true, readOnlyTools: true, internalUsers: true, evalGate: false, perTenantBilling: false, writeApproval: false, ci: false, multiTenantSaas: false, paidEmbedding: false },
  ],
  [
    '对外客服：按客户计费、能退款',
    { fixedFlow: true, readOnlyTools: false, internalUsers: false, evalGate: true, perTenantBilling: true, writeApproval: true, ci: false, multiTenantSaas: true, paidEmbedding: false },
  ],
  [
    'coding agent 进 CI',
    { fixedFlow: false, readOnlyTools: false, internalUsers: true, evalGate: true, perTenantBilling: false, writeApproval: true, ci: true, multiTenantSaas: false, paidEmbedding: false },
  ],
  [
    '把 n8n 流程打包卖给客户',
    { fixedFlow: true, readOnlyTools: true, internalUsers: false, evalGate: false, perTenantBilling: false, writeApproval: false, ci: false, multiTenantSaas: false, paidEmbedding: true },
  ],
]

// ─────────────────────────────────────────────────────────────
// 实验
// ─────────────────────────────────────────────────────────────

function exp1(): void {
  const f = fx()
  console.log(bold('\n实验一 · 同一个「永远失败」的工具，七个入口的默认值'))
  console.log(dim(`  ${pad('入口', 26)}${pad('默认上限', 10)}${pad('模型/工具', 11)}${pad('证据', 12)}结束方式`))
  for (const d of f.loops) {
    const o = simulateDefaultLoop(d, 50)
    console.log(`  ${pad(d.id, 26)}${pad(d.defaultLimit === null ? '无' : d.defaultLimit, 10)}${pad(`${o.modelCalls}/${o.toolRuns}`, 11)}${pad(d.evidence, 12)}${o.ending}`)
  }
  const opts: StopOpts = { maxSteps: 8, maxRepeat: 3 }
  const same = firstStop(failingSteps(20), (s) => courseStopReason(s, opts))
  const vary = firstStop(failingSteps(20, true), (s) => courseStopReason(s, opts))
  console.log(`\n  课程的停止条件（maxSteps 8，maxRepeat 3），喂同一段 20 步的历史：第 ${same[0]} 步停，reason=${same[1]}`)
  console.log(`  每步换一个 path：第 ${vary[0]} 步停，reason=${vary[1]}`)
  const zero = firstStop(failingSteps(20), aiSdkIsStepCount(0))
  const zeroC = firstStop(failingSteps(20), (s) => courseStopReason(s, { maxSteps: 0, maxRepeat: 0 }))
  console.log(`  isStepCount(0)：20 步里${zero[0] === 0 ? '一次都没触发' : `第 ${zero[0]} 步触发`}；课程 maxSteps 0：第 ${zeroC[0]} 步停，reason=${zeroC[1]}`)
  console.log(
    dim(
      '  框架只给最后一步的 finishReason：撞上限、停在审批、调了没有 execute 的工具，三种都是 tool-calls。\n' +
        '  Claude Agent SDK 的 result.subtype 有显式原因，但 maxTurns 没有默认值；E5-A 里分类器拒绝 + 「原样重试」把它变成了死循环。',
    ),
  )
}

function exp2(): void {
  const f = fx()
  const e = f.toolError
  console.log(bold('\n实验二 · 同一个异常，四家框架回填给模型的文本'))
  console.log(dim(`  工具 ${e.tool} 抛出 { name: ${J(e.name)}, message: ${J(e.message)} }`))
  console.log(dim(`  ${pad('框架', 18)}${pad('is_error', 10)}${pad('证据', 13)}回填文本`))
  for (const r of f.backfills) {
    const text = frameworkBackfill(r, e)
    const a = auditBackfill(text, e.tool)
    console.log(`  ${pad(r.framework, 18)}${pad(r.isError, 10)}${pad(r.evidence, 13)}${J(text)}`)
    console.log(dim(`  ${pad('', 41)}体检：${a.length === 0 ? '合格' : a.join(' ')}`))
  }
  const mine = courseToolError(e, { tool: e.tool })
  const a = auditBackfill(mine, e.tool)
  console.log(`  ${pad('课程适配器', 18)}${pad('true', 10)}${pad('—', 13)}${J(oneLine(mine))}`)
  console.log(dim(`  ${pad('', 41)}体检：${a.length === 0 ? '合格' : a.join(' ')}`))
  console.log(
    dim(
      '  三家把带 key 的原始异常塞进上下文，一家把信息全抹掉还叫模型再试一次。DeepSeek 的 Anthropic 端点忽略 is_error，\n' +
        '  所以「这是失败」「下一步做什么」都只能写在文本里。',
    ),
  )
}

function exp3(): void {
  console.log(bold('\n实验三 · MCP 的 isError：AI SDK 的路径上丢了，DeepSeek 上本来就不算数'))
  for (const c of fx().mcpCases) {
    const wire = aiSdkMcpWire(c.result, 'tu1')
    const mine = courseMcpWire(c.result, 'tu1')
    const isErr = (b: Json) => (typeof b === 'object' && b !== null && !Array.isArray(b) && b.is_error === true ? 'is_error' : '无 is_error')
    console.log(`  ${bold(c.label)}`)
    console.log(`    ${pad('AI SDK 线上块', 16)}${pad(isErr(wire), 12)}模型看到 ${J(deepseekSees(wire))}`)
    console.log(`    ${pad('课程适配器', 16)}${pad(isErr(mine), 12)}模型看到 ${J(deepseekSees(mine))}`)
  }
  console.log(
    dim(
      '  @ai-sdk/mcp 把 isError 的结果原样当成功返回；tracing 里这次调用也记为成功，L13 的错误率被系统性低估。\n' +
        '  线上块有没有 is_error，DeepSeek 都只看文本：失败的信号只能放在 [tool error] 这个前缀里。',
    ),
  )
}

function exp4(): void {
  const f = fx()
  console.log(bold('\n实验四 · UI 遮罩：同一个 tool_result，第 N 轮和第 N+1 轮'))
  const d = uiRoundTrip(f.ui.modelSaw)
  console.log(`  ${pad('第 N 轮模型看到', 22)}${J(d.turnN)}`)
  console.log(`  ${pad('UI 消息的 errorText', 22)}${J(d.ui)}`)
  console.log(`  ${pad('第 N+1 轮模型看到', 22)}${J(d.turnN1)}${d.turnN === d.turnN1 ? '' : '   ← 历史被改写了'}`)
  const kept = uiRoundTrip(f.ui.modelSaw, (s) => s)
  console.log(`  ${pad('传 onError: s => s', 22)}第 N+1 轮 ${J(kept.turnN1)}${kept.turnN === kept.turnN1 ? '（不变）' : ''}`)
  console.log(dim('\n  下一轮以服务端日志为准，客户端发来的 UI 消息只用来对账：'))
  const r: Rebuilt = rebuildHistory(f.history.ui, f.history.log)
  for (const h of r.history) console.log(`    ${pad(h.toolCallId, 4)}${pad(h.type, 12)}${J(oneLine(h.value))}`)
  console.log(`    drifted=${J(r.drifted)}  forged=${J(r.forged)}  dropped=${J(r.dropped)}`)
  console.log(
    dim(
      '  同一个位置的 tool_result 内容变了，前缀缓存从这里往后全部失效；出路也在下一轮丢了。\n' +
        '  forged 那一条是客户端造出来的工具结果——useChat 标准模式下审批记录同样走这条路（INV-24）。',
    ),
  )
}

function exp5(): void {
  const f = fx()
  console.log(bold('\n实验五 · 同一份 RunState 恢复两次'))
  let effects = 0
  const counts = runStateResume(2, () => {
    effects++
  })
  console.log(`  RunState.fromString → approve → run，重放两次：工具累计执行 ${J(counts)}（${f.runState.evidence}：${J(f.runState.measuredEffects)}，状态 ${f.runState.bytes} 字节）`)
  const store: Kv = new Map()
  effects = 0
  const charge = () => {
    effects++
    return `charged#${effects}`
  }
  const steps: [string, string, 'approve' | 'reject', () => string][] = [
    ['审批通过，worker 恢复', 'a1', 'approve', charge],
    ['worker 崩溃后重放同一条审批', 'a1', 'approve', charge],
    ['另一个人随后点了「拒绝」', 'a1', 'reject', charge],
    ['a2 恢复时进程被杀', 'a2', 'approve', () => {
      effects++
      throw new Error('worker killed after POST /refund')
    }],
    ['a2 被重新投递', 'a2', 'approve', charge],
  ]
  console.log(dim(`  ${pad('事件', 30)}${pad('审批', 6)}${pad('结果', 28)}${pad('副作用累计', 12)}store`))
  for (const [label, id, dec, fn] of steps) {
    const o: ResumeOutcome = resumeOnce(store, id, dec, fn)
    const shown = o.result.length > 10 ? o.result.slice(0, 10) + '…' : o.result
    console.log(`  ${pad(label, 30)}${pad(id, 6)}${pad(o.result === '' ? o.status : `${o.status}:${shown}`, 28)}${pad(effects, 12)}${J(store.get(`approval:${id}`) ?? null)}`)
  }
  console.log(
    dim(
      '  框架把「恢复」当成纯函数。in-flight 的那一条不重跑：进程是在副作用之后死的还是之前死的，只有对账才知道（L19）。\n' +
        '  四家框架在「L08 幂等键」这一行全部为空——这是手写不可替代的最强证据。',
    ),
  )
}

function exp6(): void {
  const f = fx()
  console.log(bold('\n实验六 · 还有八处会咬人的默认值'))
  for (const d of f.defaults) {
    console.log(`  ${pad(d.inv, 8)}${pad(d.what, 38)}${d.default}`)
    console.log(dim(`  ${pad('', 8)}${pad('', 38)}→ ${d.fix}  [${d.evidence}]`))
  }
  console.log(dim(`\n  thinking 签名（@ai-sdk/anthropic，E4 实测）：`))
  for (const t of f.thinking) {
    console.log(`    ${pad(t.path, 8)}${pad(t.signature ? '有签名' : '无签名', 8)}${t.outcome}${t.silent ? '   ← 静默' : ''}`)
  }
  console.log(dim('  同一个问题，两条路径行为相反：非流式直接报错，流式悄悄丢掉。DeepSeek 带工具时漏传 reasoning 会 400（OpenAI 格式的原文）。'))
}

function exp7(): void {
  const c = fx().claudeAgentSdk
  console.log(bold('\n实验七 · 跑一个 Claude Code 二进制意味着什么（读 E5 夹具，不装）'))
  console.log(`  不传 permissionMode → ${c.permissionMode}：每次主循环请求后跟着 ${c.classifierPerMainRequest} 次分类器请求（max_tokens ${c.classifierMaxTokens}）`)
  console.log(`  分类器的 model=${c.classifierModel}，不是你设的 ${c.mainModel}；它的花费不进 total_cost_usd`)
  console.log(`  分类器的 system 开头：${J(c.classifierSystemStart)}`)
  console.log(`  分类器答不上来时回填给主模型：`)
  console.log(`    ${J(c.autoDenial)}`)
  console.log(dim(`    体检：${auditBackfill(c.autoDenial, 'mcp__lab__boom').join(' ')}`))
  console.log(dim(`\n  ${pad('运行', 28)}${pad('session_id', 14)}${pad('messages', 10)}total_cost_usd`))
  for (const s of c.sessions) console.log(`  ${pad(s.run, 28)}${pad(s.sessionId, 14)}${pad(s.messages, 10)}${fmtUsd(s.costMicroUsd)}`)
  const [, b, fork] = c.sessions
  console.log(`  fork 的成本从父会话的累计值接着算：${fmtUsd(fork!.costMicroUsd)} 包含了 ${fmtUsd(b!.costMicroUsd)}——按会话汇总会重复计算`)
  console.log(`  成本里不含什么：${J(c.costExcludes)}`)
  console.log(`  默认 system prompt（不是 Claude Code 的完整 prompt）：`)
  for (const p of c.defaultSystemPrompt) console.log(`    ${J(p)}`)
  console.log(
    dim(
      '  默认无轮数上限 + 默认 auto 分类器（写死 Claude 模型名，接 DeepSeek 时按前缀映射到 deepseek-flash）+ 失败即拒且叫你原样重试\n' +
        '  = 一个默认配置下的死循环。「能连上 DeepSeek」不等于「行为一致」。',
    ),
  )
}

function exp8(): void {
  console.log(bold('\n实验八 · 把一份 Dify DSL 读成代码计划'))
  const p: DifyPlan = difyPlan(fx().dify)
  console.log(`  version=${p.version}  kind=${p.kind}  丢掉的画布字段：${p.uiFieldsDropped} 个`)
  console.log(`  执行顺序：${p.order.join(' → ')}`)
  console.log(`  分支：${p.branches.join('  ')}`)
  console.log(dim(`  ${pad('节点', 10)}${pad('类型', 22)}${pad('标题', 12)}改写成代码时要补的`))
  for (const s of p.steps) console.log(`  ${pad(s.id, 10)}${pad(s.type, 22)}${pad(s.title, 12)}${s.needs.length === 0 ? '—' : s.needs.join(' ')}`)
  console.log(`  数据流：${p.refs.join('  ')}`)
  console.log(`  问题：${p.errors.length === 0 ? '（无）' : p.errors.join('  ')}`)
  console.log(
    dim(
      '  ticket 在 false 分支上，却引用了 true 分支里 llm 的输出：拓扑序在前不等于是上游，运行时这里是空值。\n' +
        '  DSL 不带知识库内容，dataset_ids 用原租户加密，工具凭据导出时被删——导到另一套环境，这三处都是断的。',
    ),
  )
}

function exp9(): void {
  console.log(bold('\n实验九 · 平台、框架、手写'))
  for (const [label, n] of SCENARIOS) {
    const r = choosePlatform(n)
    console.log(`  ${pad(label, 32)}${r.pick}`)
    console.log(dim(`  ${pad('', 32)}因为：${r.why.join('、')}${r.license.length > 0 ? `；许可：${r.license.join('；')}` : ''}`))
  }
  console.log(
    dim(
      '  arXiv 2609.00006 检查的框架清单里没有 AI SDK、Mastra 和两家 harness SDK，并把 AI SDK 归为 provider-abstraction layer。\n' +
        '  它能证明的是「生产 coding harness 的循环都是手写的」，不是「别用 AI SDK」：拿 provider 层，拒绝编排层的默认值。',
    ),
  )
}

// ─────────────────────────────────────────────────────────────
// TODO
// ─────────────────────────────────────────────────────────────

/**
 * TODO 1 ★ 停止原因（I-STOP，接在 AI SDK 的 stopWhen 上）。规则和优先级见 shared 的 courseStopReason 注释：
 *   running / approval / truncated / error / done / repeat / max_steps。
 * 零件：callSignature（参数先规范化，{a,b} 和 {b,a} 是同一个调用）在 shared 里。
 * 注意 max_steps 用 ≥：maxSteps 写成 0 也必须停，不能像 isStepCount(0) 那样永远不触发。
 */
export function myCourseStopReason(steps: Step[], o: StopOpts): StopReason {
  throw new Error('TODO 1 未实现')
}

/**
 * TODO 2 ★★ 错误出口（I-ERR，AI SDK 的 execute 包装和 Agents SDK 的 errorFunction 共用）。两个函数：
 *   myRedactSecrets：sk- key（前面不能紧挨字母或数字）、secret= / token= / password= / api_key= 的值、Bearer token，
 *     各自替换成 sk-*** / 键=*** / Bearer ***。再跑一遍结果不变。
 *   myCourseToolError：`[tool error] 工具名: 消息\n下一步：提示`。消息先把 \r \n 换成空格，再脱敏，再按码点截到 200 加 …；
 *     e 不是带字符串 message 的对象时：字符串就用它本身，其余用 '（没有错误信息）'；提示按 errorCode 查 ERROR_HINTS。
 * 零件：errorCode、hintFor、ERROR_PREFIX、NEXT_STEP、MAX_ERROR_MESSAGE 在 shared 里。
 */
export function myRedactSecrets(s: string): string {
  throw new Error('TODO 2 未实现')
}

export function myCourseToolError(e: unknown, ctx: { tool: string }): string {
  throw new Error('TODO 2 未实现')
}

/**
 * TODO 3 ★ 审批恢复只消费一次（I-IDEM）。键 `approval:${approvalId}`，值 `in-flight` 或 `done:${decision}:${result}`。
 * 状态：ran / already-consumed / conflict / in-flight / crashed，规则见 shared 的 resumeOnce 注释。
 * resume() 抛异常时记录**留在 in-flight**，返回 crashed 和异常的 message。
 */
export function myResumeOnce(store: Kv, approvalId: string, decision: 'approve' | 'reject', resume: () => string): ResumeOutcome {
  throw new Error('TODO 3 未实现')
}

/**
 * TODO 4 ★ MCP CallToolResult → 模型能读懂的文本（I-ERR × L10）。
 * isError 只有缺省、null、false 算成功；每种 content 的写法、空结果、structuredContent 见 shared 的 mcpResultToText 注释。
 * 失败时 `[tool error] ` + 脱敏后的正文（用你的 myRedactSecrets）。
 */
export function myMcpResultToText(r: McpResult): { text: string; isError: boolean } {
  throw new Error('TODO 4 未实现')
}

/**
 * TODO 5 ★ 以服务端日志为准重建下一轮的工具结果历史（I-HIST）。
 * history 按日志顺序；drifted / forged / dropped 的定义和顺序见 shared 的 rebuildHistory 注释。
 */
export function myRebuildHistory(ui: UiToolPart[], log: LoggedResult[]): Rebuilt {
  throw new Error('TODO 5 未实现')
}

/**
 * TODO 6 ★★ 把 Dify DSL 读成代码计划。七步、每种错误的写法见 shared 的 difyPlan 注释——
 * verify 逐项比对 version、kind、uiFieldsDropped、order、steps（含 needs）、branches、refs、errors。
 * 零件：DIFY_UI_FIELDS、DIFY_NAMESPACES、DIFY_READER_VERSION、difyNeeds 在 shared 里。
 */
export function myDifyPlan(dsl: unknown): DifyPlan {
  throw new Error('TODO 6 未实现')
}

// ─────────────────────────────────────────────────────────────

function main(): void {
  console.log(dim(`\n  录制口径：${fx().versions.map(([p, v]) => `${p}@${v}`).join('  ')}`))
  exp1()
  exp2()
  exp3()
  exp4()
  exp5()
  exp6()
  exp7()
  exp8()
  exp9()
  console.log(
    dim(
      '\n  框架真正省下的是 provider 适配、流协议编解码、schema 校验、会话序列化；终止、错误回填、幂等、tracing、审批这五处，\n' +
        '  没有一家的默认值满足课程的不变量。写完六个适配器跑 pnpm verify:l19x。\n',
    ),
  )
}

if (isMain(import.meta.url)) main()
