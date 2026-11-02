/**
 * 验证 l11/orchestrate.ts。跑法：pnpm verify:l11
 *
 * 一次 API 都不调。多 agent 的全部难点都在校验和会计上，
 * 而这两件事都是纯函数——**能用假的测的东西，就不要用真的测。**
 *
 * 带 ★ 的测试每一条对应一个静默失效：
 * 空引用、重复劳动、写覆盖、矛盾被糊掉、被掐断的报告当成完成、
 * 预算只查一次、递归无上限、交接成环。
 *
 * 它们的共同点还是那一条：**不抛异常。** 全都表现为
 * "成功返回了一个质量不错的答案"，然后出现在账单上或者错误结论里。
 *
 * 先跑 MULTI_IMPL=shared pnpm verify:l11 确认测试本身是对的。
 */

import type { Totals } from '../shared/ledger.ts'
import * as shared from '../shared/multi.ts'
import type { Brief, Report } from '../shared/multi.ts'

const TARGET = process.env.MULTI_IMPL === 'shared' ? 'shared' : 'mine'
const M = TARGET === 'shared' ? shared : ((await import('./orchestrate.ts')) as unknown as typeof shared)

console.log(TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l11/ 里你的实现）')

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
    console.log(`\x1b[31m      ${(err as Error).message}\x1b[0m`)
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

// ─── 素材 ────────────────────────────────────────────────────

const brief = (over: Partial<Brief> = {}): Brief => ({
  agent: 'w1',
  goal: '梳理 2020-2022 年汽车芯片危机的成因',
  context: '在写一份供应链行业报告，读者是投资人。报告分三部分，你负责第一部分。',
  deliverable: '一份时间线，每节点标注日期、事件、影响',
  boundaries: ['不要涉及 2023 年之后'],
  tools: ['web_search'],
  ...over,
})

const totals = (yuan: number): Totals => ({
  calls: 3, inputTokens: 9000, outputTokens: 600, cacheRead: 0, cacheWrite: 0, ms: 3000, yuan,
})

const report = (over: Partial<Report> = {}): Report => ({
  agent: 'w1', ok: true, summary: '结论：甲', evidence: ['a://1'],
  usage: totals(0.01), steps: 3, reason: 'done',
  ...over,
})

const kinds = (b: Brief) => M.checkBrief(b).problems.map((p) => p.kind)

// ─────────────────────────────────────────────────────────────
console.log('\n任务书体检')
// ─────────────────────────────────────────────────────────────

await test('一份写清楚的任务书能过', () => {
  const r = M.checkBrief(brief())
  assert(r.ok, `应该通过，实际报了 ${JSON.stringify(kinds(brief()))}`)
})

await test('★ 「上面提到的」是空引用（sub-agent 看不到编排者的上下文）', () => {
  const got = kinds(brief({ context: '按上面提到的规则来做' }))
  assert(
    got.includes('dangling_reference'),
    '这是这一节最要紧的一条检查。\n' +
      '      「上面提到的」在编排者的上下文里有明确所指，在 sub-agent 那里是空引用——\n' +
      '      而它不会报错：它会编一个所指出来，基于编出来的东西干完整个任务，\n' +
      '      最后交回一份格式正确、语气自信、内容和你要的毫无关系的报告',
  )
})

await test('英文的 as mentioned 同样要查出来', () => {
  assert(kinds(brief({ goal: 'Summarize as mentioned above' })).includes('dangling_reference'), '英文指代没查')
})

await test('★ 没有 boundaries 要报（这是重复劳动的唯一成因）', () => {
  assert(
    kinds(brief({ boundaries: [] })).includes('no_boundaries'),
    '三个 sub-agent 都被派去「研究供应链」时，只有边界能让它们分头查不同的部分',
  )
})

await test('context 空要报', () => {
  assert(kinds(brief({ context: '' })).includes('no_context'), 'context 空没报')
})

await test('deliverable 空要报', () => {
  assert(kinds(brief({ deliverable: '' })).includes('no_deliverable'), 'deliverable 空没报')
})

await test('tools 空（不限工具）要报', () => {
  assert(kinds(brief({ tools: [] })).includes('no_tools'), '不限工具等于让它自己发明工作范围')
})

await test('目标太宽要报（「研究」「分析」这类）', () => {
  assert(kinds(brief({ goal: '研究供应链' })).includes('goal_too_vague'), '宽目标没报')
})

await test('★ 多个问题要一次全报出来，不是报第一个就返回', () => {
  const got = kinds({ agent: 'w', goal: '分析', context: '', deliverable: '', boundaries: [], tools: [] })
  assert(
    got.length >= 4,
    `只报了 ${got.length} 个：${JSON.stringify(got)}。\n` +
      '      报一个就返回的话，修一个跑一次，五个问题要跑五轮',
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n重复劳动')
// ─────────────────────────────────────────────────────────────

await test('★ 三份换词版的任务书要被查出重叠', () => {
  const bs = [
    brief({ agent: 'a', goal: '研究半导体短缺', deliverable: '报告' }),
    brief({ agent: 'b', goal: '研究半导体供应链现状', deliverable: '报告' }),
    brief({ agent: 'c', goal: '调查半导体供应链短缺的现状', deliverable: '报告' }),
  ]
  const o = M.detectOverlap(bs)
  assert(
    o.length >= 2,
    `只查出 ${o.length} 组重叠。\n` +
      '      这是 Anthropic 生产里的真实故障：一个 agent 查了 2021 年的汽车芯片危机，\n' +
      '      另外两个查了同一件事。而 sub-agent 之间不共享上下文，\n' +
      '      **它们没有任何办法发现自己在做重复的活**——症状只有"这次特别贵"',
  )
})

await test('★ 中文要切二元组，否则「供应链危机」和「供应链短缺」对不上', () => {
  const o = M.detectOverlap([
    brief({ agent: 'a', goal: '梳理供应链危机的成因', deliverable: '时间线' }),
    brief({ agent: 'b', goal: '梳理供应链短缺的成因', deliverable: '时间线' }),
  ])
  assert(
    o.length === 1,
    '按整词匹配的话这两条一个共同词都没有（"危机" vs "短缺"），重叠查不出来。\n' +
      '      而它们实际上在查同一件事',
  )
})

await test('边界写清楚的三份任务书不该报重叠', () => {
  const bs = [
    brief({ agent: 'a', goal: '梳理 2021 年汽车芯片危机的时间线', deliverable: '按日期排列的事件表' }),
    brief({ agent: 'b', goal: '统计 2026 年晶圆厂产能', deliverable: '厂商与月产能对照表' }),
    brief({ agent: 'c', goal: '梳理出口管制清单', deliverable: '按地区分组的风险条目' }),
  ]
  assert(M.detectOverlap(bs).length === 0, `不该报重叠，实际报了 ${JSON.stringify(M.detectOverlap(bs))}`)
})

await test('★ 分母用较短那份，不是并集', () => {
  // 窄任务整个被宽任务包含。用并集当分母会把分数摊薄到阈值以下。
  const o = M.detectOverlap([
    brief({ agent: 'wide', goal: '统计晶圆厂产能与制程节点与在建产线与投产时间', deliverable: '大表' }),
    brief({ agent: 'narrow', goal: '统计晶圆厂产能', deliverable: '大表' }),
  ])
  assert(
    o.length === 1,
    '窄任务整个被宽任务包含，这是重复劳动最典型的形状。\n' +
      '      用并集当分母会把分数摊薄——而"一个 agent 的活全被另一个覆盖了"\n' +
      '      恰恰是最该报出来的那种',
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n写冲突')
// ─────────────────────────────────────────────────────────────

await test('★ 两个 agent 写同一个文件要报冲突', () => {
  const bs = [
    brief({ agent: 'a', goal: '把 src/api.ts 的回调改成 async', deliverable: '改好的 src/api.ts', tools: ['edit_file'] }),
    brief({ agent: 'b', goal: '给 src/api.ts 补类型标注', deliverable: '改好的 src/api.ts', tools: ['edit_file'] }),
  ]
  const c = M.checkWriteConflicts(bs)
  assert(
    c.length >= 1,
    '两份任务书都能通过 checkBrief（边界写了、工具限了、目标具体）。\n' +
      '      但后写的会覆盖先写的，而且**两边都认为自己成功了**——\n' +
      '      两份报告都说"已完成"，编排者合并出"重构完成，类型已补齐"，而类型没了',
  )
  assert(c[0]!.agents.length === 2, `冲突里应该有两个 agent，实际 ${JSON.stringify(c[0])}`)
})

await test('只读的 agent 不该报写冲突', () => {
  const bs = [
    brief({ agent: 'a', goal: '读 src/api.ts 总结它的导出', deliverable: '清单', tools: ['read_file'] }),
    brief({ agent: 'b', goal: '读 src/api.ts 找出未使用的导入', deliverable: '清单', tools: ['read_file'] }),
  ]
  assert(M.checkWriteConflicts(bs).length === 0, '只读不该报冲突——这正是"并行 sub-agent 必须只读"的意思')
})

await test('run_command 也算写工具', () => {
  const bs = [
    brief({ agent: 'a', goal: '跑 build.sh 构建', deliverable: 'dist/out.js', tools: ['run_command'] }),
    brief({ agent: 'b', goal: '跑 bundle.sh 打包', deliverable: 'dist/out.js', tools: ['run_command'] }),
  ]
  assert(M.checkWriteConflicts(bs).length >= 1, 'run_command 能改任何东西，必须算写工具')
})

// ─────────────────────────────────────────────────────────────
console.log('\n投入分级')
// ─────────────────────────────────────────────────────────────

await test('单线程 → single', () => {
  const e = M.planEffort({ independentThreads: 1, needsWrite: false, exceedsContext: false })
  assert(e.tier === 'single' && e.agents === 1, `应该是 single/1，实际 ${e.tier}/${e.agents}`)
})

await test('★ 要写就是 single，哪怕有八个独立方向', () => {
  const e = M.planEffort({ independentThreads: 8, needsWrite: true, exceedsContext: false })
  assert(
    e.tier === 'single' && e.agents === 1,
    `实际 ${e.tier}/${e.agents}。\n` +
      '      八个模块听起来很适合并行，但它要写文件。\n' +
      '      **"能拆"和"能并行"是两件事**，而 needsWrite 的优先级必须最高',
  )
})

await test('3 个方向、只读、塞得下 → small_fanout', () => {
  const e = M.planEffort({ independentThreads: 3, needsWrite: false, exceedsContext: false })
  assert(e.tier === 'small_fanout' && e.agents === 3, `实际 ${e.tier}/${e.agents}`)
})

await test('★ 12 个方向也不能开 12 个（上限 10）', () => {
  const e = M.planEffort({ independentThreads: 12, needsWrite: false, exceedsContext: true })
  assert(
    e.tier === 'large_fanout' && e.agents <= 10,
    `实际开了 ${e.agents} 个。\n` +
      '      Anthropic 早期版本的真实故障是一个简单查询开了 50 个 sub-agent。\n' +
      '      模型判断不了该投入多少，所以这条规则必须是代码',
  )
})

await test('每一档都要有 why', () => {
  for (const input of [
    { independentThreads: 1, needsWrite: false, exceedsContext: false },
    { independentThreads: 3, needsWrite: false, exceedsContext: false },
    { independentThreads: 9, needsWrite: false, exceedsContext: true },
    { independentThreads: 4, needsWrite: true, exceedsContext: false },
  ]) {
    assert(M.planEffort(input).why.length > 10, `${JSON.stringify(input)} 的 why 是空的——判据要能被 review`)
  }
})

// ─────────────────────────────────────────────────────────────
console.log('\n合并报告')
// ─────────────────────────────────────────────────────────────

await test('★ 矛盾要原样列出，不许挑一个', () => {
  const m = M.mergeReports([
    report({ agent: 'a', summary: '减产：1050 万辆' }),
    report({ agent: 'b', summary: '减产：770 万辆' }),
  ])
  assert(
    m.conflicts.length === 1,
    `应该报 1 处矛盾，实际 ${m.conflicts.length}。\n` +
      '      编排者只看到摘要，看不到任何一份原始材料——**它没有能力判断哪个对**。\n' +
      '      让它"综合一下"的结果是「减产约 800 至 1000 万辆」这种句子：\n' +
      '      读起来很顺、有具体数字、而且两个来源都不支持它。\n' +
      '      这是多 agent 里最难发现的错误，因为输出**看起来质量很高**',
  )
  assert(m.conflicts[0]!.agents.length === 2, '矛盾里要标出是哪几个 agent 说的')
})

await test('结论一致时不报矛盾', () => {
  const m = M.mergeReports([report({ agent: 'a', summary: '减产：1050 万辆' }), report({ agent: 'b', summary: '减产：1050 万辆' })])
  assert(m.conflicts.length === 0, `一致的结论不该报矛盾，实际 ${JSON.stringify(m.conflicts)}`)
})

await test('★ reason=step_limit 的报告进 gaps，不进结论', () => {
  const m = M.mergeReports([report({ agent: 'a', reason: 'step_limit' })])
  assert(
    m.gaps.length === 1,
    'L05 那条判据在这里第二次用上：**被掐断的运行不是做完了的运行。**\n' +
      '      它的最后一句话往往像个答案，而编排者会拿去用',
  )
  assert(!m.summary.includes('结论：甲'), '被掐断的报告不该进 summary')
})

await test('★ 失败的 agent 要变成显式 gap，不能消失', () => {
  const m = M.mergeReports([report({ agent: 'a' }), report({ agent: 'b', ok: false, reason: '超时', summary: '' })])
  assert(
    m.gaps.some((g) => g.agent === 'b'),
    '静默丢掉的后果是"结论少了一条"，而那看起来像模型没找到——\n' +
      '      于是你会去调 prompt，而真正的问题是一个超时',
  )
})

await test('证据引用要去重', () => {
  const m = M.mergeReports([
    report({ agent: 'a', evidence: ['a://1', 'a://2'] }),
    report({ agent: 'b', evidence: ['a://2', 'a://3'] }),
  ])
  assert(m.evidence.length === 3, `应该去重成 3 条，实际 ${JSON.stringify(m.evidence)}`)
})

await test('空输入不炸', () => {
  const m = M.mergeReports([])
  assert(m.conflicts.length === 0 && m.gaps.length === 0, '空输入应该返回空结果而不是抛异常')
})

// ─────────────────────────────────────────────────────────────
console.log('\n拓扑选型')
// ─────────────────────────────────────────────────────────────

const topo = (over: Partial<Parameters<typeof shared.chooseTopology>[0]> = {}) =>
  M.chooseTopology({
    independentThreads: 3, needsWrite: false, exceedsContext: false,
    hasDependencies: false, valuePerTask: 'high', needsSpecialistSwitch: false,
    ...over,
  })

await test('3 个独立方向、只读、高价值 → multi_agent', () => {
  assert(topo().topology === 'multi_agent', `实际 ${topo().topology}`)
})

await test('★ 有依赖 → workflow，不是 multi_agent', () => {
  assert(
    topo({ hasDependencies: true }).topology === 'workflow',
    '步骤之间有依赖的时候，依赖关系应该写在代码里，\n' +
      '      不该让模型在运行时协调——那是 L07 那节的结论，在这里再用一次',
  )
})

await test('★ 要写 → single', () => {
  assert(topo({ needsWrite: true }).topology === 'single', '并行 sub-agent 看不到彼此的写入，而且都会报告成功')
})

await test('★ 价值低且塞得下 → single（15 倍成本没东西抵）', () => {
  assert(
    topo({ valuePerTask: 'low' }).topology === 'single',
    '有并行空间不等于该并行。多 agent 的 15 倍 token 成本要有东西来抵——\n' +
      '      任务单次价值低的时候，先用单 agent',
  )
})

await test('单线程 + 要换专长 → handoff', () => {
  assert(
    topo({ independentThreads: 1, needsSpecialistSwitch: true }).topology === 'handoff',
    '一条线程但中途换专长，交接比派 sub-agent 便宜——不用重新组装上下文',
  )
})

await test('每个分支都要有 why', () => {
  for (const over of [
    {}, { hasDependencies: true }, { needsWrite: true },
    { valuePerTask: 'low' as const }, { independentThreads: 1, needsSpecialistSwitch: true },
  ]) {
    assert(topo(over).why.length > 10, `${JSON.stringify(over)} 的 why 是空的`)
  }
})

// ─────────────────────────────────────────────────────────────
console.log('\n派发（四道闸）')
// ─────────────────────────────────────────────────────────────

const opts = (over: Partial<shared.FanoutOptions> = {}): shared.FanoutOptions => ({
  maxAgents: 4, maxDepth: 2, maxYuan: 1, concurrency: 4, ...over,
})

const runner = (yuan = 0.01): shared.SubAgentRunner => async (b) =>
  report({ agent: b.agent, summary: `结论：${b.agent}`, usage: totals(yuan) })

await test('正常派发：每个 brief 一份报告', async () => {
  const bs = [brief({ agent: 'a' }), brief({ agent: 'b' })]
  const r = await M.fanout(bs, runner(), opts())
  assert(r.reports.length === 2, `应该 2 份报告，实际 ${r.reports.length}`)
})

await test('★ 体检结果要返回给调用方，不是打个日志', async () => {
  const bs = [brief({ agent: 'a', boundaries: [] }), brief({ agent: 'b' })]
  const r = await M.fanout(bs, runner(), opts())
  assert(
    r.preflight.briefProblems['a']?.length,
    '重复劳动和写冲突一旦派出去就无法挽回——钱已经花了、文件已经被覆盖了。\n' +
      '      而它们在派发前是**完全可以静态查出来的**，所以体检结果必须返回',
  )
})

await test('★ 超过 maxAgents 的要显式列进 rejected，不能静默截断', async () => {
  const bs = [1, 2, 3, 4, 5, 6].map((i) => brief({ agent: `a${i}` }))
  const r = await M.fanout(bs, runner(), opts({ maxAgents: 3 }))
  assert(r.reports.length === 3, `应该只跑 3 个，实际 ${r.reports.length}`)
  assert(
    r.rejected.length === 3,
    `被截掉的 3 个应该出现在 rejected 里，实际 ${r.rejected.length} 条。\n` +
      '      静默截断的后果是"结论少了一条"，而那看起来像模型没找到',
  )
})

await test('★ 预算要在批之间检查，不能只在开头查一次', async () => {
  // 每个 agent 花 0.4，预算 1.0。第三个应该被拦住。
  const bs = [1, 2, 3, 4].map((i) => brief({ agent: `a${i}` }))
  const r = await M.fanout(bs, runner(0.4), opts({ maxYuan: 1, concurrency: 1 }))
  assert(
    r.rejected.some((x) => x.reason.includes('预算')),
    '开头查一次的话，四个 agent 全会跑完——花掉 1.6 元，预算的 1.6 倍。\n' +
      '      一个失控的 sub-agent 能把整个预算吃掉，后面的应该被拦住而不是照跑',
  )
  assert(r.reports.length < 4, `应该有 agent 被拦住，实际全跑完了（${r.reports.length} 份报告）`)
})

await test('★ 深度上限：sub-agent 开 sub-agent 是指数级账单', async () => {
  const r = await M.fanout([brief({ agent: 'a' })], runner(), opts({ maxDepth: 2, depth: 2 }))
  assert(r.reports.length === 0, '到达深度上限就不该再派')
  assert(r.rejected.length === 1 && r.rejected[0]!.reason.includes('深度'), `rejected 里要说明是深度闸拦的，实际 ${JSON.stringify(r.rejected)}`)
})

await test('★ 一个 sub-agent 崩了，其余照跑，崩的那个变成 gap', async () => {
  const bs = [brief({ agent: 'ok1' }), brief({ agent: 'boom' }), brief({ agent: 'ok2' })]
  const run: shared.SubAgentRunner = async (b) => {
    if (b.agent === 'boom') throw new Error('工具超时')
    return report({ agent: b.agent, summary: `结论：${b.agent}` })
  }
  const r = await M.fanout(bs, run, opts())
  assert(r.reports.filter((x) => x.ok).length === 2, 'allSettled 语义：一个崩了不该让整批白跑')
  assert(
    r.merged.gaps.some((g) => g.agent === 'boom'),
    '崩掉的那个必须变成一条 gap 而不是消失',
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n交接')
// ─────────────────────────────────────────────────────────────

await test('走到终点就停', () => {
  const r = M.handoff('triage', (a) => (a === 'triage' ? { to: 'billing', reason: '是账单问题' } : null))
  assert(r.final === 'billing' && r.path.length === 1, `实际 final=${r.final} path=${r.path.length}`)
})

await test('★ 互相交接要被检测成环（否则请求一直不返回）', () => {
  const r = M.handoff('a', (cur) => (cur === 'a' ? { to: 'b', reason: '踢给 b' } : { to: 'a', reason: '踢回 a' }))
  assert(
    r.loop !== undefined,
    '两个 agent 互相交接是真实故障模式，而它的表现是"请求一直不返回"——\n' +
      '      没有异常、没有错误日志。只有 maxHops 兜底的话要跑满 8 跳才停，\n' +
      '      而且停下来之后你不知道是"走了 8 步"还是"绕圈了"',
  )
})

await test('每一跳都要记 reason', () => {
  const r = M.handoff('a', (cur) => (cur === 'a' ? { to: 'b', reason: '需要账单专长' } : null))
  assert(r.path[0]!.reason.length > 0, '没有 reason 的交接链在事后无法复盘')
})

// ─────────────────────────────────────────────────────────────
console.log('\n成本会计')
// ─────────────────────────────────────────────────────────────

const SHAPE: shared.CostShape = { toolDefTokens: 911, toolResultTokens: 1200, briefTokens: 180, reportTokens: 300 }

await test('单 agent 的输入是 O(n²) 而不是 O(n)', () => {
  const a = shared.costSingle(5, SHAPE).inputTokens
  const b = shared.costSingle(10, SHAPE).inputTokens
  assert(b / a > 3, `10 步应该远超 5 步的两倍，实际 ${(b / a).toFixed(1)} 倍——上下文每轮重发，这是平方项`)
})

await test('★ 多 agent 对单 agent 的倍数 ≈ 扇出宽度', () => {
  const single = shared.costSingle(5, SHAPE).inputTokens
  const multi = shared.costMulti(3, 5, SHAPE).inputTokens
  const ratio = multi / single
  assert(
    ratio > 3 && ratio < 4.5,
    `实际 ${ratio.toFixed(2)} 倍。\n` +
      '      这条测的是一个结论："多 agent 的协调开销很大"是错误诊断。\n' +
      '      倍数几乎就是扇出宽度本身——它贵是因为**做了 3 倍的工作**',
  )
})

await test('★ 协调开销只占小头（所以优化它的天花板很低）', () => {
  const b = shared.costMulti(3, 5, SHAPE)
  const share = b.parts.coordination / b.inputTokens
  assert(
    share < 0.15,
    `协调开销占 ${(share * 100).toFixed(0)}%。\n` +
      '      以为是协调贵就会去优化任务书格式、压缩报告、改协议——\n' +
      '      而那是在动一个占比很小的部分，天花板就是这个占比',
  )
})

await test('单 agent 的协调开销必须是 0', () => {
  assert(shared.costSingle(5, SHAPE).parts.coordination === 0, '单 agent 没有任务书也没有报告，这一项必须是 0')
})

// ─────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(62))
if (failures.length === 0) {
  console.log(`\x1b[32m全过。${passed} 项。\x1b[0m`)
  console.log('\n接着跑 pnpm compare:multi —— 看 15 倍是怎么来的，以及它里面有多少是协调开销。')
} else {
  console.log(`\x1b[31m${failures.length} 项没过（过了 ${passed} 项）：\x1b[0m`)
  for (const f of failures) console.log(`\x1b[31m  · ${f}\x1b[0m`)
  console.log('\n先跑 MULTI_IMPL=shared pnpm verify:l11 对照参考实现。')
  process.exitCode = 1
}
