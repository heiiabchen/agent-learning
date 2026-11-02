/**
 * L11 任务一：多 agent 的四道闸和一台计价器。
 *
 *   pnpm orchestrate     五组观察实验
 *   pnpm verify:l11      测试
 *
 * ★ 这一节的 TODO 分布和前面几节不一样，值得先说一句。
 *
 * 前面几节的 TODO 是"实现一个能力"。这一节的八个 TODO 里，
 * 有五个是**校验和拦截**，只有三个算得上"编排"。
 *
 * 这个比例就是这一节的主要结论：多 agent 的技术实现是简单的
 * （嵌套调用 runAgent 就完了），难的全在"什么时候不该这么做"上。
 *
 * 一个必须先立住的定义：
 *
 *   **多 agent ≠ 多次模型调用。**
 *   L07 那五种编排模式全是多次调用，但它们是单 agent——只有一个上下文。
 *   多 agent 的定义性特征是**上下文隔离**。
 *
 * 而"隔离"意味着 agent 之间只能通过序列化的文本传话。
 * 这一节剩下的全部内容，都是这一句的后果。
 */

import { isMain } from '../shared/entry.ts'
import type { Totals } from '../shared/ledger.ts'
import * as shared from '../shared/multi.ts'
import type {
  Brief,
  BriefProblem,
  CostBreakdown,
  CostShape,
  Effort,
  FanoutOptions,
  FanoutResult,
  Merged,
  Overlap,
  Report,
  SubAgentRunner,
  Topology,
  TopologyChoice,
  WriteConflict,
} from '../shared/multi.ts'

const IMPL = process.env.MULTI_IMPL === 'shared' ? 'shared' : 'mine'

// ─────────────────────────────────────────────────────────────
// TODO 1：任务书体检
//
// sub-agent 唯一能看到的东西就是这份任务书。编排者知道的一切，
// 它一个字都看不到。
//
// 要查六件事，其中第一件最重要：
//
//   dangling_reference —— 任务书里出现"上面提到的""那个文件"这类指代。
//                         ★ 它在编排者的上下文里有明确所指，在 sub-agent
//                         那里是一个**空引用**。而 sub-agent 不会报错，
//                         它会编一个出来，然后基于编出来的东西干完整个任务。
//   no_context         —— context 空
//   no_deliverable     —— 没说要交什么形状的东西，最后没法合并
//   no_boundaries      —— 没说不要做什么。这是重复劳动的唯一成因
//   no_tools           —— 不限工具，等于让它自己发明工作范围
//   goal_too_vague     —— 目标只有一个宽泛动词
//
// 返回 problems 数组而不是抛异常：一份任务书可能有多处问题，
// 一次全报出来比修一个跑一次快得多。
//
// 指代词表和判据见 shared/multi.ts 的 DANGLING / VAGUE_GOALS。
// ─────────────────────────────────────────────────────────────

export function checkBrief(_b: Brief): { ok: boolean; problems: BriefProblem[] } {
  throw new Error('TODO: 实现 checkBrief')
}

// ─────────────────────────────────────────────────────────────
// TODO 2：重复劳动检测
//
// ★ 为什么这件事必须在**派发之前**做：sub-agent 之间不共享上下文，
// 所以它们**没有任何办法发现自己在做重复的活**。
//
// Anthropic 生产里的真实故障：三个 sub-agent 被派去"研究半导体短缺"，
// 一个查了 2021 年的汽车芯片危机，另外两个查了同一件事——2025 年的供应链。
// 症状只有一个：这次特别贵。
//
// 做法：把 goal + deliverable 切成关键词，两两算重叠。
//
// 两个实现细节：
//   · 中文长词要切二元组，"供应链危机"和"供应链短缺"才能对上
//   · 分母用**较短那份**的关键词数，不是并集。一个宽任务和一个窄任务
//     重叠时，并集会把分数摊薄，而实际上窄的那个整个被包含了
// ─────────────────────────────────────────────────────────────

export function detectOverlap(_briefs: Brief[], _threshold = 0.5): Overlap[] {
  throw new Error('TODO: 实现 detectOverlap')
}

// ─────────────────────────────────────────────────────────────
// TODO 3：写冲突检测
//
// ★ 这是全节最有用的一条经验判据：**并行 sub-agent 必须是只读的。**
//
// 理由不是"并发难写对"，是更根本的：sub-agent 之间没有共享状态，
// 所以它们**看不到彼此的写入**。两个 agent 同时改同一个文件，
// 后写的覆盖先写的，而且**两边都认为自己成功了**——
// 它们的报告都会说"已完成"。
//
// 做法：找出带写工具的任务书，按它们提到的路径分组，
// 同一路径下有多于一个 agent 就是冲突。
//
// 粒度会偏粗（比如两个 agent 写同一个目录下的不同文件也会被报出来）。
// **这个方向的不准是安全的**——误报让你多看一眼，漏报让你丢数据。
// ─────────────────────────────────────────────────────────────

export function checkWriteConflicts(_briefs: Brief[], _writeTools?: string[]): WriteConflict[] {
  throw new Error('TODO: 实现 checkWriteConflicts')
}

// ─────────────────────────────────────────────────────────────
// TODO 4：投入分级
//
// ★ 这套规则不是我编的，是 Anthropic 写进 prompt 里的——
// 因为**模型自己判断不了该投入多少**。
// 他们早期版本的真实故障是：一个简单查询开了 50 个 sub-agent。
//
// 所以这件事不能交给模型。它是代码。
//
// 判据顺序很重要，从最能省事的开始：
//   needsWrite            → single（写不能并行，这条优先级最高）
//   independentThreads<=1 → single（没有可拆的方向）
//   <=4 且塞得下          → small_fanout
//   否则                  → large_fanout（上限 10）
// ─────────────────────────────────────────────────────────────

export function planEffort(_input: {
  independentThreads: number
  needsWrite: boolean
  exceedsContext: boolean
}): Effort {
  throw new Error('TODO: 实现 planEffort')
}

// ─────────────────────────────────────────────────────────────
// TODO 5：合并报告
//
// ★ 这个函数最重要的行为是它**不做**的事：**它不在矛盾的结论里挑一个。**
//
// 编排者只看到摘要，看不到任何一个 sub-agent 的原始材料。
// 它没有能力判断哪一份对。让它"综合一下"的结果是一段读起来很顺、
// 把两个矛盾结论糊在一起的文字——而这是多 agent 里最难发现的错误，
// 因为输出**看起来质量很高**。
//
// 三件事：
//   conflicts —— 同一个键、不同的值。原样列出，不合并
//   gaps      —— 失败的、以及 reason 不是 done 的。★ step_limit 的报告
//                不能当成"做完了"（L05 那条判据在这里第二次用上）
//   evidence  —— 引用的并集，去重
// ─────────────────────────────────────────────────────────────

export function mergeReports(_reports: Report[]): Merged {
  throw new Error('TODO: 实现 mergeReports')
}

// ─────────────────────────────────────────────────────────────
// TODO 6：拓扑选型
//
// 和 L07 的 choosePattern、L09 的 chooseRetrieval、L10 的"该不该上 MCP"
// 同一类判据。顺序上它在 L07 之后：先定要不要 agent，再定要不要多个。
//
// 四个结果：single / workflow / multi_agent / handoff
//
// 判据顺序（每一条都要返回 why，理由和前几节一样：判据要能被 review）：
//   有依赖且多线程        → workflow（依赖关系写在代码里，不该让模型运行时协调）
//   要写                  → single
//   单线程但要换专长      → handoff
//   单线程                → single
//   价值低且塞得下        → single（15 倍成本没东西抵）
//   否则                  → multi_agent
// ─────────────────────────────────────────────────────────────

export function chooseTopology(_input: {
  independentThreads: number
  needsWrite: boolean
  exceedsContext: boolean
  hasDependencies: boolean
  valuePerTask: 'low' | 'high'
  needsSpecialistSwitch: boolean
}): TopologyChoice {
  throw new Error('TODO: 实现 chooseTopology')
}

// ─────────────────────────────────────────────────────────────
// TODO 7：派发（四道闸）
//
// ★ 派发**之前**先体检，而且体检结果要返回给调用方，不是打个日志。
//
// 理由：重复劳动和写冲突这两件事，一旦派出去就无法挽回——
// 钱已经花了，文件已经被覆盖了。而它们在派发前是**完全可以静态查出来的**。
//
// 四道闸：
//   1. 深度   —— depth >= maxDepth 就全部拒掉。没这道闸，sub-agent 开
//                sub-agent 是指数级的账单
//   2. 数量   —— 超过 maxAgents 的截断，但**被截掉的要显式列进 rejected**。
//                静默截断的后果是"结论少了一条"，而那看起来像模型没找到
//   3. 预算   —— ★ 要在**批之间**检查，不能只在开头查一次。一个失控的
//                sub-agent 能把整个预算吃掉，后面的 agent 应该被拦住
//   4. 隔离   —— 一个 sub-agent 崩了不该让整批白跑（allSettled 语义），
//                但它必须变成一条 gap 而不是消失
// ─────────────────────────────────────────────────────────────

export async function fanout(
  _briefs: Brief[],
  _run: SubAgentRunner,
  _opts: FanoutOptions,
): Promise<FanoutResult> {
  throw new Error('TODO: 实现 fanout')
}

// ─────────────────────────────────────────────────────────────
// TODO 8：交接
//
// ★ 交接和 sub-agent 的区别不是"实现方式"，是**信息模型**：
//
//   sub-agent  上下文隔离。背景要序列化进任务书，结果要序列化成报告。
//              贵、有损、**可并行**。
//   交接        上下文共享。接手的 agent 看得到全部历史。
//              便宜、无损、**只能串行**。
//
// 判据很干脆：**要并行就 sub-agent，不要并行就交接。**
// 用 sub-agent 做串行的事，等于白付两次序列化的钱和一次信息损失。
//
// 实现上只有一个坑，但它很实在：**环检测**。
// 两个 agent 互相交接是真实故障模式，而它的表现是"请求一直不返回"——
// 没有异常、没有错误日志。
// ─────────────────────────────────────────────────────────────

export function handoff(
  _start: string,
  _route: (agent: string) => { to: string; reason: string } | null,
  _maxHops = 8,
): shared.HandoffResult {
  throw new Error('TODO: 实现 handoff')
}

// ─────────────────────────────────────────────────────────────
// TODO 9（没有代码）：把 fanout 里的预算检查从"批之间"挪到"开头一次"
//
// 然后跑 pnpm verify:l11。只有一条测试会红。
// 看一眼那条测试测的是什么——它测的是**第三个 sub-agent 有没有被拦住**，
// 而在真实系统里那一条是"这次跑掉了预算的三倍"。
//
// TODO 10（没有代码）：把 mergeReports 改成"矛盾时取第一份报告的值"
//
// 所有测试仍然会过，除了专门测 conflicts 的那一条。
// 而这就是这一节最想让你记住的东西：**取第一份**在功能上完全说得通，
// 输出也依然通顺——它只是有时候是错的，而你没有任何办法知道是哪一次。
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 观察实验
// ─────────────────────────────────────────────────────────────

const M = IMPL === 'shared' ? shared : {
  checkBrief,
  detectOverlap,
  checkWriteConflicts,
  planEffort,
  mergeReports,
  chooseTopology,
  fanout,
  handoff,
}

const line = (n = 62) => '─'.repeat(n)

/** 那个真实故障：三个 agent 被派去"研究半导体短缺"。 */
const CHIP_BRIEFS: Brief[] = [
  {
    agent: 'researcher-1',
    goal: '研究半导体短缺',
    context: '',
    deliverable: '',
    boundaries: [],
    tools: [],
  },
  {
    agent: 'researcher-2',
    goal: '研究半导体供应链现状',
    context: '',
    deliverable: '',
    boundaries: [],
    tools: [],
  },
  {
    agent: 'researcher-3',
    goal: '调查半导体供应链短缺的现状',
    context: '',
    deliverable: '',
    boundaries: [],
    tools: [],
  },
]

/** 同一件事，任务书写清楚之后。 */
const CHIP_FIXED: Brief[] = [
  {
    agent: 'researcher-1',
    goal: '梳理 2020-2022 年汽车芯片危机的成因与时间线',
    context:
      '我们在写一份半导体供应链的行业报告，读者是不熟悉半导体行业的投资人。' +
      '报告分三部分：历史危机、当前产能、地缘风险。你负责第一部分。',
    deliverable: '一份时间线，每个节点标注日期、事件、对整车厂产能的影响',
    boundaries: ['不要涉及 2023 年之后的情况', '不要分析地缘政治，那是 researcher-3 的部分'],
    tools: ['web_search', 'read_url'],
  },
  {
    agent: 'researcher-2',
    goal: '统计 2026 年主要晶圆厂的产能与在建产线',
    context:
      '我们在写一份半导体供应链的行业报告，读者是不熟悉半导体行业的投资人。' +
      '报告分三部分：历史危机、当前产能、地缘风险。你负责第二部分。',
    deliverable: '一张表：厂商、地区、制程节点、月产能、在建产线的投产时间',
    boundaries: ['不要回顾历史危机，那是 researcher-1 的部分', '只要产能数字，不要分析原因'],
    tools: ['web_search', 'read_url'],
  },
  {
    agent: 'researcher-3',
    goal: '梳理影响半导体供应的出口管制与地缘风险',
    context:
      '我们在写一份半导体供应链的行业报告，读者是不熟悉半导体行业的投资人。' +
      '报告分三部分：历史危机、当前产能、地缘风险。你负责第三部分。',
    deliverable: '按国家/地区分组的风险清单，每条标注生效时间和受影响的环节',
    boundaries: ['不要复述产能数字，那是 researcher-2 的部分'],
    tools: ['web_search', 'read_url'],
  },
]

function demoBrief() {
  console.log(`\n【一】任务书：sub-agent 唯一能看到的东西\n${line()}`)

  const bad: Brief = {
    agent: 'worker',
    goal: '分析',
    context: '按上面提到的那个文件里的规则来做',
    deliverable: '',
    boundaries: [],
    tools: [],
  }

  const r = M.checkBrief(bad)
  console.log(`  一份典型的坏任务书，查出 ${r.problems.length} 个问题：`)
  for (const p of r.problems) {
    console.log(`\n    \x1b[31m[${p.kind}]\x1b[0m ${p.message}`)
  }

  const good = M.checkBrief(CHIP_FIXED[0]!)
  console.log(`\n  写清楚之后：${good.ok ? '\x1b[32m通过\x1b[0m' : `${good.problems.length} 个问题`}`)

  console.log(`\n  ★ 六条里 dangling_reference 是最要紧的那条。`)
  console.log(`  「上面提到的那个文件」在编排者的上下文里有明确所指，`)
  console.log(`  在 sub-agent 那里是**一个空引用**——而它不会报错。`)
  console.log(`  它会编一个所指出来，然后基于编出来的东西干完整个任务，`)
  console.log(`  最后交回一份格式正确、语气自信、内容和你要的毫无关系的报告。`)
}

function demoOverlap() {
  console.log(`\n【二】重复劳动：多 agent 最贵的失效\n${line()}`)

  console.log(`  三个 agent，任务书都是「研究半导体短缺」的换词版本：`)
  for (const b of CHIP_BRIEFS) console.log(`    ${b.agent}：${b.goal}`)

  const overlaps = M.detectOverlap(CHIP_BRIEFS)
  console.log(`\n  查出 ${overlaps.length} 组重叠：`)
  for (const o of overlaps) {
    console.log(`    \x1b[31m${o.a} × ${o.b}\x1b[0m  重叠 ${(o.score * 100).toFixed(0)}%  共同关键词 ${o.shared.join('、')}`)
  }

  const fixed = M.detectOverlap(CHIP_FIXED)
  console.log(`\n  加上边界和具体目标之后：${fixed.length} 组重叠`)

  console.log(`\n  ★ 这是 Anthropic 生产里的真实故障：一个 agent 查了 2021 年的`)
  console.log(`  汽车芯片危机，另外两个查了同一件事——2025 年的供应链。`)
  console.log(`  \n  而这件事**必须在派发之前查**。sub-agent 之间不共享上下文，`)
  console.log(`  所以它们没有任何办法发现自己在做重复的活。`)
  console.log(`  你会付三份钱、拿到三份内容雷同的报告，唯一的症状是「这次特别贵」。`)
}

function demoWriteConflict() {
  console.log(`\n【三】并行 sub-agent 必须是只读的\n${line()}`)

  const writers: Brief[] = [
    {
      agent: 'refactor-a',
      goal: '把 src/api.ts 里的回调改成 async/await',
      context: '在做一次代码现代化改造',
      deliverable: '改好的 src/api.ts',
      boundaries: ['只改这一个文件'],
      tools: ['read_file', 'edit_file'],
    },
    {
      agent: 'refactor-b',
      goal: '给 src/api.ts 里的公开函数补类型标注',
      context: '在做一次代码现代化改造',
      deliverable: '改好的 src/api.ts',
      boundaries: ['只改这一个文件'],
      tools: ['read_file', 'edit_file'],
    },
  ]

  console.log(`  两个 agent，各自的任务书写得都很规范：`)
  for (const b of writers) console.log(`    ${b.agent}：${b.goal}`)
  console.log(`  两份任务书都通过了 checkBrief（边界写了、工具限了、目标具体）。`)

  const conflicts = M.checkWriteConflicts(writers)
  console.log(`\n  但写冲突检查查出 ${conflicts.length} 处：`)
  for (const c of conflicts) {
    console.log(`    \x1b[31m${c.resource}\x1b[0m ← ${c.agents.join('、')} 都要写`)
  }

  console.log(`\n  ★ 后写的覆盖先写的，而且**两边都认为自己成功了**——`)
  console.log(`  两份报告都会说「已完成」。编排者拿到两个成功，`)
  console.log(`  合并出一句「重构完成，类型已补齐」，而实际上类型没了。`)
  console.log(`  \n  原因不是并发难写对，是更根本的：**sub-agent 看不到彼此的写入。**`)
  console.log(`  \n  Anthropic 的原话值得抄下来：「大多数编程任务里真正可并行的`)
  console.log(`  部分比研究少得多。」——而这门课的 capstone 就是一个编程 agent。`)
}

function demoEffort() {
  console.log(`\n【四】投入分级：别为一个简单问题开十个 agent\n${line()}`)

  const cases: { name: string; input: Parameters<typeof shared.planEffort>[0] }[] = [
    { name: '查一个函数在哪定义', input: { independentThreads: 1, needsWrite: false, exceedsContext: false } },
    { name: '对比三个库的 API 设计', input: { independentThreads: 3, needsWrite: false, exceedsContext: false } },
    { name: '把这个函数改成异步', input: { independentThreads: 1, needsWrite: true, exceedsContext: false } },
    { name: '重构八个模块（都要改文件）', input: { independentThreads: 8, needsWrite: true, exceedsContext: false } },
    { name: '整理 S&P500 里 IT 公司的董事会成员', input: { independentThreads: 12, needsWrite: false, exceedsContext: true } },
  ]

  console.log(`  ${'任务'.padEnd(22)} ${'档'.padEnd(14)} agents  理由`)
  for (const c of cases) {
    const e = M.planEffort(c.input)
    const color = e.tier === 'single' ? '\x1b[33m' : '\x1b[32m'
    console.log(`  ${c.name.padEnd(20)} ${color}${e.tier.padEnd(14)}\x1b[0m ${String(e.agents).padStart(5)}   ${e.why}`)
  }

  console.log(`\n  ★ 注意第四行：八个模块听起来很适合并行，但它要写文件，`)
  console.log(`  所以档位是 single。**"能拆" 和 "能并行" 是两件事。**`)
  console.log(`  \n  这套规则要写成代码而不是写进 prompt，因为模型判断不了该投入多少。`)
  console.log(`  Anthropic 早期版本的真实故障：一个简单查询开了 50 个 sub-agent。`)
}

function demoMerge() {
  console.log(`\n【五】合并：编排者没有能力判断哪一份对\n${line()}`)

  const t = (yuan: number): Totals => ({
    calls: 3, inputTokens: 12000, outputTokens: 800, cacheRead: 0, cacheWrite: 0, ms: 4200, yuan,
  })

  const reports: Report[] = [
    {
      agent: 'researcher-1',
      ok: true,
      summary: '2021 年危机峰值：整车厂减产约 1050 万辆\n主要成因：疫情期间的订单取消',
      evidence: ['artifact://researcher-1/timeline.md'],
      usage: t(0.0182), steps: 6, reason: 'done',
    },
    {
      agent: 'researcher-2',
      ok: true,
      summary: '2021 年危机峰值：整车厂减产约 770 万辆\n台积电月产能：约 130 万片等效 12 吋',
      evidence: ['artifact://researcher-2/capacity.csv'],
      usage: t(0.0214), steps: 7, reason: 'done',
    },
    {
      agent: 'researcher-3',
      ok: true,
      summary: '出口管制清单：2022-10 起扩大到先进制程设备',
      evidence: ['artifact://researcher-3/risks.md'],
      usage: t(0.0091), steps: 4, reason: 'step_limit',
    },
    {
      agent: 'researcher-4',
      ok: false,
      summary: '',
      evidence: [],
      usage: t(0), steps: 0, reason: '子进程超时',
    },
  ]

  const m = M.mergeReports(reports)

  console.log(`  四份报告进来，合并结果：`)
  console.log(`\n  \x1b[31m矛盾 ${m.conflicts.length} 处：\x1b[0m`)
  for (const c of m.conflicts) console.log(`    ${c.claim}   ← ${c.agents.join(' vs ')}`)

  console.log(`\n  \x1b[33m缺口 ${m.gaps.length} 处：\x1b[0m`)
  for (const g of m.gaps) console.log(`    ${g.agent}：${g.reason}`)

  console.log(`\n  证据 ${m.evidence.length} 条：${m.evidence.join('、')}`)

  console.log(`\n  ★ 这个函数最重要的行为是它**不做**的事：它不在 1050 万和 770 万`)
  console.log(`  之间挑一个。编排者只看到摘要，看不到任何一份原始材料——`)
  console.log(`  **它没有能力判断哪个对。**`)
  console.log(`  \n  让它"综合一下"的结果是「减产约 800 至 1000 万辆」这种句子：`)
  console.log(`  读起来很顺、有具体数字、而且两个来源都不支持它。`)
  console.log(`  \n  这是多 agent 里最难发现的错误，因为输出**看起来质量很高**。`)
  console.log(`  \n  另外注意 researcher-3：它 ok=true，但 reason 是 step_limit。`)
  console.log(`  L05 那条判据在这里第二次用上：**被掐断的运行不是做完了的运行。**`)
  console.log(`  它进 gaps，不进结论。`)
}

async function main() {
  console.log(`\n${'═'.repeat(62)}`)
  console.log(`L11 · 多 agent 的四道闸（实现：${IMPL}）`)
  console.log('═'.repeat(62))

  const demos: [string, () => void | Promise<void>][] = [
    ['一', demoBrief],
    ['二', demoOverlap],
    ['三', demoWriteConflict],
    ['四', demoEffort],
    ['五', demoMerge],
  ]

  for (const [n, fn] of demos) {
    try {
      await fn()
    } catch (err) {
      console.log(`\n【${n}】\x1b[31m还没实现：${(err as Error).message}\x1b[0m`)
    }
  }

  console.log(`\n${line()}`)
  console.log('接着跑 pnpm compare:multi —— 看 15 倍是怎么来的，以及它里面有多少是协调开销。')
}

if (isMain(import.meta.url)) await main()
