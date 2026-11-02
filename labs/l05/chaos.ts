/**
 * L05 · 任务三：故意制造失控，看防线响不响。
 *
 * 跑法：pnpm chaos        （不调 API，全用假模型）
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 这个练习的价值在于：**你亲眼看到每条防线响一次。**
 *
 * 相信「我写了步数上限所以不会死循环」和看到它响，是两件事。
 * 前者在生产环境里经常被证伪——因为你写的那个上限可能一直没生效
 * （比如 repeatKey 的字段顺序问题）。
 *
 * 五个场景，每个对应一种真实的失控方式。前四个我写好了，第五个你补。
 * ───────────────────────────────────────────────────────────────────────────
 */
import { reasonText, runAgent, type StopReason } from '../shared/agent.ts'
import { fakeModel, type FakeTurn } from '../shared/fake.ts'
import { Ledger } from '../shared/ledger.ts'
import { ToolBox, type ToolDef } from '../shared/tools.ts'

/** 一个什么都不做的工具，我们关心的是循环行为，不是工具行为。 */
function tools(): ToolBox {
  const noop: ToolDef<unknown> = {
    name: 'peek',
    description: '看一眼',
    inputSchema: { type: 'object', properties: { at: { type: 'string' } } },
    parse: (raw) => ({ ok: true, input: raw }),
    run: async () => ({ content: '（看到了一些东西）' }),
  }
  return new ToolBox([noop as unknown as ToolDef<never>])
}

interface Scenario {
  name: string
  why: string
  script: FakeTurn[]
  after?: 'repeat_last' | 'final' | 'throw'
  opts?: Parameters<typeof runAgent>[1] extends infer O
    ? O extends object
      ? Partial<Omit<O, 'toolbox' | 'system' | 'call'>>
      : never
    : never
  expect: StopReason[]
}

const SCENARIOS: Scenario[] = [
  {
    name: '场景一 · 丢了 tool_use 块导致的死循环',
    why:
      '真模型不会这样，但**你的代码 bug 会导致这个效果**：\n' +
      '    assistant 消息放回历史时丢了 tool_use 块，模型每轮都重新要求同一件事。\n' +
      '    这是最常见的一种 agent 死循环，特征是调用完全一样、参数都不变。',
    script: [{ toolUses: [{ name: 'peek', input: { at: 'same-place' } }] }],
    after: 'repeat_last',
    opts: { maxSteps: 20, repeatLimit: 2 },
    expect: ['repeat'],
  },
  {
    name: '场景二 · 有变化但没进展（重复检测挡不住）',
    why:
      '每次参数都不同，所以重复检测**完全无效**——这是它的能力边界。\n' +
      '    只有步数上限能兜住。这就是为什么两道防线都要有：\n' +
      '    重复检测更精准但覆盖窄，步数上限更钝但兜得住底。',
    script: Array.from({ length: 50 }, (_, i) => ({
      toolUses: [{ name: 'peek', input: { at: `place-${i}` } }],
    })),
    opts: { maxSteps: 8, repeatLimit: 2 },
    expect: ['step_limit'],
  },
  {
    name: '场景三 · 单步就烧爆预算',
    why:
      '步数上限在这里完全没用——它只跑了两步。\n' +
      '    成本上限防的是另一个维度：**每一步的成本差异可以有两个数量级**。\n' +
      '    一次 list_dir 和一次读进 50KB 文件，不该用同一个计数器衡量。',
    script: [
      { toolUses: [{ name: 'peek', input: { at: 'x' } }], usage: { input: 3_000_000, output: 800_000 } },
    ],
    after: 'repeat_last',
    opts: { maxSteps: 100, maxYuan: 0.3, repeatLimit: 999 },
    expect: ['budget'],
  },
  {
    name: '场景四 · 输出被 max_tokens 截断',
    why:
      '这一步最容易被写成 done——毕竟 stop_reason 不是 tool_use，看着就是「说完了」。\n' +
      '    但那句话是残缺的。报 done 等于把半截答案当成完整答案交出去，\n' +
      '    而它**看起来完全像个答案**。',
    script: [{ text: '这个文件的作用是……', stopReason: 'max_tokens' }],
    opts: {},
    expect: ['error'],
  },
]

async function runScenario(s: Scenario) {
  const fake = fakeModel({ script: s.script, afterScript: s.after ?? 'final' })
  const ledger = new Ledger(s.name)
  const run = await runAgent('做点事', {
    toolbox: tools(),
    system: 'test',
    call: fake.call,
    ledger,
    ...s.opts,
  })

  const hit = s.expect.includes(run.reason)
  const mark = hit ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✕\x1b[0m'

  console.log(`\n\x1b[1m${s.name}\x1b[0m`)
  console.log(`  \x1b[2m${s.why}\x1b[0m`)
  console.log(`  ${mark} reason=${run.reason}（期待 ${s.expect.join(' 或 ')}）· ${reasonText[run.reason]}`)
  console.log(`     步数 ${run.steps} · 工具 ${run.trace.length} 次 · 花了 ¥${run.usage.yuan.toFixed(4)}`)
  if (run.error) console.log(`     异常：${run.error.message}`)
  return hit
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO · 补上场景五：取消
//
//   用 delayMs 让假模型每次慢 50ms，起一个 AbortController，
//   在 120ms 后 abort。然后确认三件事：
//
//     a) reason 是 'cancelled'，不是 'error'
//        （混在一起的后果：用户点了停止，日志里记一条 error，你以为线上有 bug）
//     b) 已经花掉的钱**出现在** usage 里
//        （取消不该让账目消失——那几个请求真的发出去了）
//     c) transcript 里有部分结果，不是空的
//        （用户点停止之后，「已经做了什么」是有价值的信息）
//
// 然后回答一个设计问题：
//
//   场景二里，如果我把 maxSteps 从 8 改成 100，会发生什么？
//   除了「跑得更久」之外，**成本是线性增长还是更快**？
//   （提示：L02 说 API 是无状态的，每轮要重发全部历史）
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('故意制造失控，看每条防线响不响。（不调 API）')

  let ok = 0
  for (const s of SCENARIOS) if (await runScenario(s)) ok++

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${ok}/${SCENARIOS.length} 条防线按预期响了。`)
  console.log('把 TODO 里的场景五补上，五条就齐了。')
}

await main()
