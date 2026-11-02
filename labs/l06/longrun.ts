/**
 * L06 任务三：把上下文管理接到 L05 的 agent 上，量出它值多少钱。
 *
 *   pnpm longrun
 *
 * 默认用假模型跑，所以不花钱、结果确定、能反复对比。
 * 最后有一个 TODO 让你换成真模型跑一次——那一次是为了看**质量**差异，
 * 而假模型这一轮是为了看**数量**差异。
 *
 * 这是这一节唯一能"量出来"的任务。前两个任务都是为它做准备。
 */

import type Anthropic from '@anthropic-ai/sdk'
import { runAgent, reasonText, type AgentRun } from '../shared/agent.ts'
import { compress, shouldCompress } from '../shared/compress.ts'
import { formatStats, measure, paginate, defaultBudget } from '../shared/context.ts'
import { fakeModel } from '../shared/fake.ts'
import { ToolBox, optionalInt, requireString, type ToolDef, type ToolResult } from '../shared/tools.ts'

// ─────────────────────────────────────────────────────────────
// 一个假的代码库。每个"文件"都不小，这是重点。
// ─────────────────────────────────────────────────────────────

const FILES: Record<string, string> = {}
for (let i = 0; i < 12; i++) {
  const lines: string[] = [`// src/mod${i}/index.ts`, `import { helper } from '../shared/util'`, '']
  for (let j = 0; j < 400; j++) {
    lines.push(`export function fn${i}_${j}(input: string): string {`)
    lines.push(`  // 这是第 ${j} 个函数的实现细节，对理解架构没有帮助`)
    lines.push(`  return helper(input) + '${i}_${j}'`)
    lines.push('}')
  }
  FILES[`src/mod${i}/index.ts`] = lines.join('\n')
}

/** 裁剪版的 read_file：只给骨架，要细节自己分页 */
function makeReadFile(trim: boolean): ToolDef<{ path: string; offset: number }> {
  return {
    name: 'read_file',
    description: trim
      ? '读文件。默认返回前 60 行，要看后面用 offset。'
      : '读文件，返回全部内容。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' } },
      required: ['path'],
    },
    parse: (raw) => {
      const p = requireString(raw, 'path')
      if (!p.ok) return p
      return { ok: true, input: { path: p.value, offset: optionalInt(raw, 'offset', 0, 0, 1e9) } }
    },
    run: async ({ path, offset }): Promise<ToolResult> => {
      const text = FILES[path]
      if (!text) {
        return { isError: true, content: `没有这个文件：${path}。用 list_dir 看看有哪些。` }
      }
      if (!trim) return { content: text }
      return { content: paginate(text, { offset, limit: 60 }) }
    },
  }
}

const listDir: ToolDef<Record<string, never>> = {
  name: 'list_dir',
  description: '列出仓库里所有文件的路径。',
  inputSchema: { type: 'object', properties: {}, required: [] },
  parse: () => ({ ok: true, input: {} }),
  run: async (): Promise<ToolResult> => ({ content: Object.keys(FILES).join('\n') }),
}

/** ToolBox 的构造签名用了 ToolDef<never>，这是它逼你在 parse 里做校验的方式。 */
function box(trim: boolean): ToolBox {
  return new ToolBox([
    makeReadFile(trim) as unknown as ToolDef<never>,
    listDir as unknown as ToolDef<never>,
  ])
}

const SYSTEM = `你在读一个陌生代码库，目标是写出架构说明。

<workflow>
1. list_dir 摸清结构
2. 逐个 read_file，只看骨架就够
3. 每读完一个模块记下结论
</workflow>

<giving_up>
如果同一个方法试了两次都不行，说明思路不对。停下来说明你卡在哪、需要什么。
</giving_up>`

/** 让假模型按顺序把 12 个文件读一遍，然后给结论 */
function script(): Parameters<typeof fakeModel>[0]['script'] {
  const turns: Parameters<typeof fakeModel>[0]['script'] = [
    { text: '先看看有哪些文件。', toolUses: [{ name: 'list_dir', input: {} }] },
  ]
  for (const path of Object.keys(FILES)) {
    turns.push({ text: `读 ${path}。`, toolUses: [{ name: 'read_file', input: { path } }] })
  }
  turns.push({ text: '读完了。这个代码库有 12 个模块，都依赖 shared/util 的 helper。' })
  return turns
}

// ─────────────────────────────────────────────────────────────
// 跑一次，把上下文变化记下来
// ─────────────────────────────────────────────────────────────

interface RunReport {
  label: string
  run: AgentRun
  peak: number
  peakRatio: number
  cumulativeInput: number
  compressions: number
}

async function once(label: string, trim: boolean, withCompress: boolean): Promise<RunReport> {
  // 标题先打，因为压缩的日志是在跑的过程中产生的——
  // 先跑后打标题会让日志出现在上一轮的标题下面。
  console.log(`\n  ${label}`)
  const toolbox = box(trim)
  const fake = fakeModel({ script: script(), afterScript: 'final' })
  const tools = toolbox.apiTools()

  let peak = 0
  let cumulativeInput = 0
  let compressions = 0
  const totalSteps = script().length

  // 在 call 这一层介入，是为了不改 runAgent 本身。
  // 这个位置能看到每一步真实发出去的 messages——也是唯一能看到的地方。
  const call = async (messages: Anthropic.MessageParam[], signal?: AbortSignal) => {
    const stats = measure({ system: SYSTEM, tools, messages })
    peak = Math.max(peak, stats.tokens)
    cumulativeInput += stats.tokens

    if (withCompress) {
      const stepsLeft = Math.max(0, totalSteps - fake.calls.length)
      const d = shouldCompress({ stats, stepsLeft })
      if (d.compress) {
        compressions++
        console.log(`      ↳ 第 ${fake.calls.length + 1} 步压缩：${d.why}`)
        const r = await compress(messages, { call: summarizer, keepRecent: 4 })
        // 原地改写调用方的数组：runAgent 持有的是同一个引用。
        // 这是个真实的取舍——干净的做法是让 runAgent 支持 hook，
        // 但那要改 L05 的签名。这里选了侵入式，代价是必须原地改。
        messages.splice(0, messages.length, ...r.messages)
      }
    }

    return fake.call(messages, signal)
  }

  const run = await runAgent('读懂这个代码库，写一份架构说明。', {
    toolbox,
    system: SYSTEM,
    call,
    maxSteps: 40,
    maxYuan: 5,
  })

  return {
    label,
    run,
    peak,
    peakRatio: peak / (defaultBudget.window - defaultBudget.reserveOutput),
    cumulativeInput,
    compressions,
  }
}

/** 压缩用的假模型：返回一份结构良好的摘要 */
const summarizer = async (messages: Anthropic.MessageParam[]): Promise<Anthropic.Message> => {
  const files = JSON.stringify(messages).match(/src\/mod\d+\/index\.ts/g) ?? []
  const uniq = [...new Set(files)]
  const text = `<goal>读懂这个代码库，写一份架构说明</goal>
<done>
${uniq.map((f) => `- 读完 ${f}，是一组导出函数，依赖 shared/util`).join('\n') || '- 无'}
</done>
<found>
- 所有模块都依赖 shared/util 的 helper
- 每个模块导出 400 个同构的函数，实现细节对架构无意义
</found>
<failed>无</failed>
<next>继续读剩下的模块</next>`

  return {
    id: 'msg_sum',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-v4-flash',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 8000,
      output_tokens: 400,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message
}

function report(r: RunReport) {
  console.log(`    终止原因   ${r.run.reason}（${reasonText[r.run.reason]}）`)
  console.log(`    步数       ${r.run.steps}`)
  console.log(`    峰值上下文 ${r.peak} tok（占可用额度 ${Math.round(r.peakRatio * 100)}%）`)
  console.log(`    累积输入   ${r.cumulativeInput} tok`)
  console.log(`    压缩次数   ${r.compressions}`)
  if (r.run.error) console.log(`    异常       ${r.run.error.message}`)
}

async function main() {
  console.log('同一个长任务，四种上下文策略。不调 API。')

  const bare = await once('一 · 什么都不做', false, false)
  report(bare)
  console.log('    ↳ 峰值超过了可用额度，真实 API 会在中途直接报错。')

  const onlyCompress = await once('二 · 只做摘要压缩（手段三）', false, true)
  report(onlyCompress)

  const onlyTrim = await once('三 · 只做源头裁剪（手段一）', true, false)
  report(onlyTrim)

  const both = await once('四 · 两个都做', true, true)
  report(both)

  console.log('\n' + '─'.repeat(60))
  const cut = (a: number, b: number) => `${Math.round((1 - b / a) * 100)}%`

  console.log('峰值上下文（决定"会不会撞上限、会不会变笨"）：')
  console.log(`  一 ${bare.peak}　二 ${onlyCompress.peak}　三 ${onlyTrim.peak}　四 ${both.peak}`)
  console.log(`    只压缩：砍掉 ${cut(bare.peak, onlyCompress.peak)}，代价是 ${onlyCompress.compressions} 次压缩调用 + 丢信息 + 毁缓存`)
  console.log(`    只裁剪：砍掉 ${cut(bare.peak, onlyTrim.peak)}，代价是零`)

  console.log('\n累积输入（决定账单）：')
  console.log(
    `  一 ${bare.cumulativeInput}　二 ${onlyCompress.cumulativeInput}　` +
      `三 ${onlyTrim.cumulativeInput}　四 ${both.cumulativeInput}`,
  )

  console.log(`\n★ 看第四轮的压缩次数：${both.compressions}。`)
  console.log('  源头裁剪做够了之后，压缩一次都没触发——因为它根本没到触发线。')
  console.log('  这就是「手段按代价排序」的意思：把第一档做完，第三档常常就不需要了。')
  console.log('  而大多数人跳过第一档直接做第三档，于是一边漏水一边擦地。')

  const stats = measure({ system: SYSTEM, tools: box(true).apiTools(), messages: both.run.transcript })
  console.log(`\n最终上下文构成：${formatStats(stats)}`)
  console.log('  work 仍然占九成以上——它永远是大头，所以永远先看它。')
}

// ─────────────────────────────────────────────────────────────
// TODO：换成真模型跑一次
//
// 上面三轮用的都是假模型，所以量出来的是**数量**差异（峰值、累积、花费）。
// 但有一个东西假模型量不出来：**质量**。
//
// 把 call 换成 shared/models.ts 里真实的 client 调用，跑同一个任务，然后看：
//
// 1. 不做任何处理那一轮，agent 在第几步开始重复读同一个文件？
// 2. 它最后给的架构说明，有没有漏掉「所有模块都依赖 shared/util」这个事实？
// 3. 加上压缩之后，那个事实还在不在？
//
// 第 3 问是这一节最重要的检验：**压缩有没有把关键事实丢掉。**
// 而检验它的唯一办法是事先准备一份「必须提到的事实」清单——
// 这也是 L12 做 evals 的入门形态。
// ─────────────────────────────────────────────────────────────

await main()
