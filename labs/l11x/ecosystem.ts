/**
 * L11x（TS 对照）：同样四件事在 TypeScript 里长什么样，以及哪两件根本没有。
 *
 *     cd labs && pnpm eco
 *     cd labs && pnpm eco:shared     # 跑参考实现
 *
 * ★ 这一节反过来了：**Python 是主通道**（`uv run python -m l11x.ecosystem`），
 * 这个文件是对照。
 *
 * 但它不是"把 Python 翻译一遍"。四件机制里只有两件在 TS 这边真正存在，
 * 而搞清楚"哪两件没有、为什么没有"，比抄一遍更有用：
 *
 *   schema 解引用   —— ★ **两边一模一样的 bug。** 那个真实修复
 *                      （anything-llm 的 dereferenceSchema.js）就是 JS 写的
 *   reducer 状态图   —— 语言无关的设计，TS 里写出来甚至更顺
 *
 *   结构化并发       —— 没有对应的 API。TS 这边要用**三个东西拼**：
 *                      Promise.all / allSettled / AbortController
 *   few-shot 编译    —— 生态里没有 TS 版的 DSPy。这一件是真的只有 Python 有
 */

import { isMain } from '../shared/entry.ts'
import {
  addMessages,
  appendReducer,
  dereference as sharedDereference,
  InterruptSignal,
  runAll,
  runSettled,
  runTaskGroup,
  schemaHealth as sharedSchemaHealth,
  StateGraph,
  type Job,
  type Reducer,
} from '../shared/pyecosystem.ts'

const IMPL = process.env.ECO_IMPL === 'shared' ? 'shared' : 'mine'

// ─────────────────────────────────────────────────────────────
// TODO 1：schema 解引用（TS 这边也要写一遍，因为 bug 一样）
//
// ★ 为什么 TS 这边也需要它：**问题不在 pydantic，在工具 API。**
//
// Anthropic 不解本地 $ref。而任何一个"从类型生成 JSON Schema"的工具
// （zod-to-json-schema、typebox、ts-json-schema-generator）在遇到
// 复用的嵌套类型时，都会生成 $ref —— 因为那是合法且更紧凑的 JSON Schema。
//
// 所以这个坑和 Python 无关。它是**类型系统和工具 API 之间那条缝**，
// 谁踩到都一样。
//
// 四个必须处理对的情况见 ecosystem.py 的 TODO 1。
// ─────────────────────────────────────────────────────────────

export function dereference(schema: Record<string, unknown>): Record<string, unknown> {
  throw new Error('TODO: 实现 dereference')
}

// ─────────────────────────────────────────────────────────────
// TODO 2：发出去之前的体检
//
// ★ 存在理由：那三种失效**全都不在你的代码里报错**。
// ─────────────────────────────────────────────────────────────

export function schemaHealth(schema: Record<string, unknown>): string[] {
  throw new Error('TODO: 实现 schemaHealth')
}

// ─────────────────────────────────────────────────────────────
// TODO 3：AbortController 版的"一个失败就全停"
//
// ★ 这是这一节最值得记住的一处语言差异：
//
// Python 的 TaskGroup 是**一个语言原语**——它自己知道怎么取消子任务，
// 因为 asyncio 的 task 本来就可以被取消。
//
// TS 里没有这个原语。**Promise 不可取消。** 所以"一个失败就全停"
// 必须自己拼：一个 AbortController，加上每个 job 都老老实实
// 接受并尊重 signal。
//
// 而"老老实实尊重 signal"是这里全部的难点：**漏一个地方，
// 那个任务就变成孤儿，而没有任何东西会提醒你。**
//
// 这也是为什么结构化并发在 Python 那边是标准库，在这边是纪律。
//
// 要实现的语义：
//   · 并发跑所有 job，每个都传 signal
//   · 第一个**非 AbortError** 的失败 → ctrl.abort() 取消其余
//   · 全部 await 完再返回（所以 orphaned 必然是 0）
//   · 多个失败要都收进 raised，不能只报第一个
//     （对应 Python 的 ExceptionGroup —— 朴素 Promise.all 只给你第一个）
// ─────────────────────────────────────────────────────────────

export interface RunOutcome {
  label: string
  ok: string[]
  failed: string[]
  /** ★ 取消不算失败。分开记才看得清 abort 到底生效了没有。 */
  cancelled: string[]
  orphaned: number
  ms: number
  raised: string | null
}

export async function runTaskGroupLike(jobs: Record<string, Job>): Promise<RunOutcome> {
  throw new Error('TODO: 实现 runTaskGroupLike')
}

// ─────────────────────────────────────────────────────────────
// TODO 4：addMessages
//
// LangGraph 的 add_messages。和朴素 append（operator.add）差别只有一处，
// 但它决定了"人工改状态再恢复执行"这个功能是否能用：
// **它按 id 去重并覆盖。**
//
// 详细理由见 ecosystem.py 的 TODO 3。
// ─────────────────────────────────────────────────────────────

export const myAddMessages: Reducer = () => {
  throw new Error('TODO: 实现 myAddMessages')
}

// ─────────────────────────────────────────────────────────────
// 观察实验
// ─────────────────────────────────────────────────────────────

const M = {
  dereference: IMPL === 'shared' ? sharedDereference : dereference,
  schemaHealth: IMPL === 'shared' ? sharedSchemaHealth : schemaHealth,
  runTaskGroup: IMPL === 'shared' ? runTaskGroup : runTaskGroupLike,
  addMessages: IMPL === 'shared' ? addMessages : myAddMessages,
}

const line = (n = 66) => '─'.repeat(n)
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

/** zod-to-json-schema 对复用的嵌套类型会生成这个形状。 */
const NESTED: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    filter: { $ref: '#/$defs/Criteria' },
    sort: { $ref: '#/$defs/Criteria', description: '排序条件，覆盖默认描述' },
  },
  required: ['query'],
  $defs: {
    Criteria: {
      type: 'object',
      description: '默认描述',
      properties: { field: { type: 'string' }, op: { type: 'string' } },
    },
  },
}

const CYCLIC: Record<string, unknown> = {
  type: 'object',
  properties: { root: { $ref: '#/$defs/Node' } },
  $defs: {
    Node: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        children: { type: 'array', items: { $ref: '#/$defs/Node' } },
      },
    },
  },
}

function demoSchema(): void {
  console.log(`\n【一】$ref 这个坑和 Python 无关\n${line()}`)

  console.log('  zod-to-json-schema 对复用的嵌套类型生成的 schema：')
  console.log(`    properties.filter = ${JSON.stringify((NESTED.properties as never)['filter'])}`)
  console.log(dim('    （复用一次以上的类型才会被提到 $defs——用一次的会直接内联）'))

  const problems = M.schemaHealth(NESTED)
  console.log(red(`\n  体检查出 ${problems.length} 个问题：`))
  for (const p of problems) console.log(`    · ${p}`)

  const flat = M.dereference(NESTED)
  const props = flat.properties as Record<string, Record<string, unknown>>
  console.log('\n  解引用之后：')
  console.log(`    properties.filter = ${JSON.stringify(props.filter)}`)
  console.log(`    $defs 还在吗       = ${'$defs' in flat}`)
  console.log(`    体检              = ${M.schemaHealth(flat).length} 个问题`)
  console.log(`\n  兄弟键覆盖：sort.description = ${JSON.stringify(props.sort?.description)}`)
  console.log(dim('    （不是 Criteria 自带的「默认描述」——2020-12 规定兄弟键优先）'))

  const cyc = M.dereference(CYCLIC)
  const cycProps = cyc.properties as Record<string, Record<string, unknown>>
  console.log('\n  自引用的类型（树节点这种）不能内联：')
  console.log(`    root 还是 $ref 吗  = ${'$ref' in (cycProps.root ?? {})}`)
  console.log(`    $defs 保留了吗     = ${'$defs' in cyc}`)

  console.log(
    `\n  ★ 这一条是 TS 这边最容易自以为不相关的坑。你会想「我不用 pydantic」——` +
      `\n  但问题从来不在 pydantic，在**工具 API 不解本地引用**。` +
      `\n  zod、typebox 生成的 $ref 一模一样。`,
  )
}

async function demoConcurrency(): Promise<void> {
  console.log(`\n【二】Promise 不可取消，所以这件事在 TS 是纪律不是 API\n${line()}`)

  const paid: string[] = []

  const job =
    (name: string, ms: number, boom = false): Job =>
    async (signal?: AbortSignal) => {
      if (boom) {
        await sleep(10)
        throw new Error(`${name} 挂了`)
      }
      await sleep(ms, signal)
      // ★ 这一行代表"这个 sub-agent 真的跑完了、真的花了钱"
      paid.push(name)
      return name
    }

  const jobs = (): Record<string, Job> => ({
    boom: job('boom', 10, true),
    'slow-1': job('slow-1', 120),
    'slow-2': job('slow-2', 120),
    'slow-3': job('slow-3', 120),
  })

  const runs: [(j: Record<string, Job>) => Promise<RunOutcome>, string][] = [
    [runAll, '★ 第一个 reject 立刻上抛，其余 Promise **继续跑到底**'],
    [M.runTaskGroup, 'AbortController：第一个真失败 → abort 其余'],
    [runSettled, '各自跑完，全部收回来（L11 的 fanout 用这个）'],
  ]

  for (const [runner, note] of runs) {
    paid.length = 0
    let r: RunOutcome
    try {
      r = await runner(jobs())
    } catch (err) {
      console.log(`\n  ${red(`还没实现：${(err as Error).message}`)}`)
      continue
    }
    const paint = r.orphaned > 0 ? red : green
    console.log(`\n  ${r.label}`)
    console.log(
      `    成功 ${r.ok.length}  失败 ${r.failed.length}  取消 ${r.cancelled.length}  ` +
        paint(`失败瞬间还在跑 ${r.orphaned} 个`),
    )
    console.log(`    真正花了钱的：${paid.length} 个  ${dim(`[${paid.join(', ')}]`)}`)
    console.log(`    抛出：${r.raised ?? '（没有）'}`)
    console.log(`    ${note}`)
  }

  console.log(`\n  ★ 看第一组：失败之后还有 3 个在跑，而且它们**最后都真的跑完了**。`)
  console.log('  在 agent 里的后果很具体：一个 sub-agent 崩了，fanout 抛异常返回，')
  console.log('  而另外三个还在调模型、还在跑工具、还在花钱——只是没人会读结果。')
  console.log(`\n  ★ 而 TS 这边比 Python 更隐蔽：`)
  console.log('  Python 至少会在进程退出时打 "Task was destroyed but it is still pending"。')
  console.log(red('  JS 什么都不说。') + '孤儿请求安安静静跑完，账单上多一笔。')
  console.log('\n  ★ 判据和 Python 一样，只是名字换了：')
  console.log('  要「一个失败就全停」→ AbortController（Python: TaskGroup）')
  console.log('  要「各自跑完再看」→ allSettled（Python: gather(return_exceptions=True)）')
  console.log('  ' + red('Promise.all 两个都不是——它是一个 bug 的名字。'))
}

function demoReducer(): void {
  console.log(`\n【三】reducer：这件事语言无关，TS 里写出来甚至更顺\n${line()}`)

  const old = [{ id: 'm1', role: 'user', text: '帮我删掉临时文件' }]
  const fix = [{ id: 'm1', role: 'user', text: '帮我删掉 /tmp 下我自己建的临时文件' }]

  const naive = appendReducer(old, fix) as Record<string, unknown>[]
  console.log(`\n    appendReducer（operator.add）  →  ${naive.length} 条消息`)
  for (const m of naive) console.log(`        ${m.id}: ${m.text}`)
  console.log(red('      ★ 历史里同时存在改前和改后两条。'))
  console.log('      模型看到两条互相矛盾的指令，而它不会报错——它会挑一条。')

  try {
    const smart = M.addMessages(old, fix) as Record<string, unknown>[]
    console.log(`\n    addMessages                   →  ${smart.length} 条消息`)
    for (const m of smart) console.log(`        ${m.id}: ${m.text}`)
    console.log(green('      按 id 覆盖。') + '这就是它和 operator.add 的全部差别。')
  } catch (err) {
    console.log(`\n    ${red(`还没实现：${(err as Error).message}`)}`)
  }

  const g = new StateGraph({ findings: appendReducer })
  const { state, clobbered } = g.mergeParallel(
    { findings: [], current: null },
    [
      { findings: ['auth 模块缺测试'], current: 'worker-1' },
      { findings: ['billing 缺测试'], current: 'worker-2' },
      { findings: ['api 缺测试'], current: 'worker-3' },
    ],
  )

  console.log('\n  并发分支的合并：')
  console.log(`    findings（有 reducer）  →  ${(state.findings as unknown[]).length} 条，全保住了`)
  console.log(`    current（没有 reducer） →  ${JSON.stringify(state.current)}`)
  console.log(red(`\n    被静默覆盖的字段：${JSON.stringify(clobbered)}`))
  console.log('\n  真 LangGraph 遇到这个会直接报 InvalidUpdateError。')
  console.log('  ★ 它宁可让你的图跑不起来，也不让你丢一次结果而不知道。')
}

function demoInterrupt(): void {
  console.log(`\n【四】恢复会重跑节点，所以之前的代码必须幂等\n${line()}`)

  const db: string[] = []
  const g = new StateGraph({})
  g.addNode('risky', (state) => {
    db.push(`row-${state.task}`) // 副作用
    if (state._resume === undefined) {
      throw new InterruptSignal({ question: `要执行 ${state.task} 吗？`, rows: db.length })
    }
    return { done: true, approved: state._resume }
  })
  g.addEdge('risky', null)

  const r1 = g.invoke({ task: 'delete' }, 't1')
  const it = r1.__interrupt__ as { question: string }
  console.log(`  第一次跑：停在 interrupt，问「${it.question}」`)
  console.log(`    数据库里现在有 ${db.length} 条记录`)

  const r2 = g.invoke({}, 't1', { resume: true })
  console.log(`\n  批准之后恢复：done=${r2.done} approved=${r2.approved}`)
  console.log(red(`    数据库里现在有 ${db.length} 条记录`))

  console.log('\n  ★ 两条。而这是 LangGraph 的正常行为，不是 bug。')
  console.log('\n  原因是**检查点存在「超步」边界上，不在节点函数中间**。')
  console.log('  恢复的时候，被中断那个节点从函数开头重跑一遍——')
  console.log('  interrupt 之前的代码和副作用会再执行一次。')
  console.log('\n  ★ 而它和 L08 那节的幂等键是同一件事：')
  console.log('  **恢复不是「接着往下走」，是「重放到断点」。**')
}

function demoWhatIsMissing(): void {
  console.log(`\n【五】TS 这边真的没有的那一件\n${line()}`)

  console.log('  前面四个 demo 里，你写了三件事的 TS 版：')
  console.log('    schema 解引用   ✓  两边一样的 bug，两边一样的修法')
  console.log('    结构化并发       ✓  但要用 AbortController 手拼，不是 API')
  console.log('    reducer 状态图   ✓  语言无关，TS 里甚至更顺')
  console.log('\n  第四件没有：')
  console.log(red('    few-shot 编译   ✗  生态里没有 TS 版的 DSPy'))

  console.log('\n  ★ 而这件事缺的理由不是"没人写"，是**依赖不在这边**。')
  console.log('  DSPy 的 optimizer 要做的是：')
  console.log('    · 在候选空间里搜索（MIPROv2 用的是贝叶斯优化 / TPE）')
  console.log('    · 对着 dev set 反复评分，判断提升是否显著')
  console.log('    · 处理小样本下的方差')
  console.log('\n  这三件都要统计和数值计算的库。而 numpy / scipy / pandas')
  console.log('  这一层在 JS 生态里没有等价物——不是差一点，是没有。')
  console.log('\n  所以结论很实用主义：')
  console.log('  **agent 的运行时可以是 TS，但 agent 的评测和优化大概率跑在 Python 里。**')
  console.log('  这两件事本来就该分开部署——评测是离线批处理，不是请求路径。')
  console.log('\n  下一节（L12）会把这条线补上：先有指标，才谈优化。')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const t = setTimeout(resolve, ms)
    // ★ 这一句就是"老老实实尊重 signal"。漏了它，这个任务就是孤儿。
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(abortError())
    })
  })
}

function abortError(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

async function main(): Promise<void> {
  console.log(`\n${'═'.repeat(66)}`)
  console.log(`L11x · TS 对照：哪两件有、哪两件没有（实现：${IMPL}）`)
  console.log('═'.repeat(66))

  const demos: [string, () => void | Promise<void>][] = [
    ['一', demoSchema],
    ['二', demoConcurrency],
    ['三', demoReducer],
    ['四', demoInterrupt],
    ['五', demoWhatIsMissing],
  ]

  for (const [n, fn] of demos) {
    try {
      await fn()
    } catch (err) {
      console.log(`\n【${n}】${red(`还没实现：${(err as Error).message}`)}`)
    }
  }

  console.log(`\n${line()}`)
  console.log('主通道在 Python 那边：uv run python -m l11x.ecosystem')
}

// 被 verify.ts import 时不要跑 demo。
if (isMain(import.meta.url)) await main()
