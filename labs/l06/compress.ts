/**
 * L06 任务二：压缩策略与「什么时候不压」。
 *
 *   pnpm compress
 *
 * 不调 API——压缩用的模型也是假的（shared/fake.ts），所以这个任务完全离线。
 * 参考实现在 shared/compress.ts。
 *
 * 这个任务里最值钱的不是 compress，是 shouldCompress。
 * 决定「什么时候不压」比「怎么压」更省钱。
 */

import type Anthropic from '@anthropic-ai/sdk'
import { extractTag } from '../shared/parse.ts'
import { defaultBudget, inputBudget, measure, type ContextStats } from '../shared/context.ts'
import { isMain } from '../shared/entry.ts'

// ─────────────────────────────────────────────────────────────
// TODO 1：结构化摘要的 prompt
//
// ★ 「总结一下前面的对话」得到的是一段散文，模型下一步没法用。
// 必须给固定结构——这是 L03 那条「结构化输出要用标签约束」的直接应用。
//
// 五个标签：goal / done / found / failed / next
//
// 三条硬要求要写进 prompt 里：
//   1. goal 必须是原文，不改写不概括（目标漂移是长任务的头号失败模式）
//   2. failed 不能省。没失败过就写「无」，但不要跳过这一节
//   3. found 里的路径和行号要原样保留
// ─────────────────────────────────────────────────────────────

export function summaryPrompt(): string {
  throw new Error('TODO: 实现 summaryPrompt')
}

// ─────────────────────────────────────────────────────────────
// TODO 2：摘要的解析与渲染
//
// ★ 缺了标签要**抛异常**，不能静默接受。
//
// 静默接受一个缺了 <failed> 的摘要，等于把防线关掉了：
// agent 会把失败过的方法再试一遍，而且会升级成循环
// （试 A 失败 → 试 B 失败 → 压缩丢了 failed → 再试 A）。
// 重复检测（L05）拦不住它，因为参数往往略有不同。
//
// 用 shared/parse.ts 里的 extractTag。注意区分两种情况：
//   标签不存在（extractTag 返回 null）→ 抛异常
//   标签存在但内容是「无」→ 合法，解析成空数组
// ─────────────────────────────────────────────────────────────

export interface Summary {
  goal: string
  done: string[]
  found: string[]
  failed: string[]
  next: string
}

export function renderSummary(s: Summary): string {
  void s
  throw new Error('TODO: 实现 renderSummary')
}

export function parseSummary(text: string): Summary {
  void text
  void extractTag
  throw new Error('TODO: 实现 parseSummary')
}

// ─────────────────────────────────────────────────────────────
// TODO 3：滑动窗口
//
// 只留最近 keepTurns 条。最便宜（不调模型），但最粗暴。
//
// ★ 两个不变量必须守住，否则会构造出 API 直接拒绝的消息序列：
//   1. 第一条（原始任务）永远保留
//   2. 不能让一个 tool_result 失去它对应的 tool_use
//
// 第二条的实现要点：切点落在携带 tool_result 的 user 消息上时，
// 往后挪一位再切。这个 bug 在测试里很容易漏掉，因为它只在
// 切点恰好落在工具轮次中间时才出现。
// ─────────────────────────────────────────────────────────────

export function slidingWindow(
  messages: Anthropic.MessageParam[],
  keepTurns = 6,
): Anthropic.MessageParam[] {
  void messages
  void keepTurns
  throw new Error('TODO: 实现 slidingWindow')
}

// ─────────────────────────────────────────────────────────────
// TODO 4：摘要压缩
//
// 返回的新消息序列是：[原始任务, 摘要, ...最近 keepRecent 条]
//
// 同样要守住 tool_use / tool_result 的配对。
// call 抽象成参数，让 verify 能塞假模型——和 runAgent 同一个模式。
// ─────────────────────────────────────────────────────────────

export interface CompressResult {
  messages: Anthropic.MessageParam[]
  summary: Summary
  saved: number
  cost: { input: number; output: number }
}

export interface CompressOptions {
  call: (messages: Anthropic.MessageParam[]) => Promise<Anthropic.Message>
  keepRecent?: number
}

export async function compress(
  messages: Anthropic.MessageParam[],
  opts: CompressOptions,
): Promise<CompressResult> {
  void messages
  void opts
  throw new Error('TODO: 实现 compress')
}

// ─────────────────────────────────────────────────────────────
// TODO 5：该不该压 —— 这个文件最值钱的函数
//
// ★ 只看当前长度是不够的，必须把「预计还要走多少步」算进来。
//
// 原因：压缩改写了历史 → 前缀变了 → 从改动点往后的 KV cache 全部作废
// （L05x 那条纪律）。压缩之后的那一次调用要重新 prefill 全部内容，付全价。
//
// 这笔账：
//   省下的 = (当前长度 - 目标长度) × 剩余步数 × 缓存折扣
//   花掉的 = 压缩调用本身 + 一次全额 prefill（失去缓存折扣）
//
// **剩余步数少的时候，不压更便宜。**
//
// 还要处理两个边界：
//   没到触发线            → 不压
//   已经到可用额度的 90%  → 无条件压（这时候不是省钱问题，是能不能跑的问题）
//
// why 字段要能读——它会进日志，而日志是给三个月后的你看的。
// ─────────────────────────────────────────────────────────────

export interface CompressDecision {
  compress: boolean
  why: string
  net?: number
}

export interface DecisionInput {
  stats: ContextStats
  stepsLeft: number
  cacheDiscount?: number
}

export function shouldCompress(input: DecisionInput): CompressDecision {
  void input
  void inputBudget
  throw new Error('TODO: 实现 shouldCompress')
}

// ─────────────────────────────────────────────────────────────
// 观察实验
// ─────────────────────────────────────────────────────────────

const GOOD_SUMMARY = `<goal>读懂 src/auth 模块，说明登录流程，找出安全问题</goal>
<done>
- 定位入口：src/auth/login.ts:34 的 handleLogin
- 读完 session 管理：src/auth/session.ts，用的是 JWT，7 天过期
</done>
<found>
- src/auth/login.ts:88 密码比较用的是 === 而不是恒定时间比较
- src/auth/session.ts:12 JWT 密钥从环境变量读，但有一个硬编码的默认值
</found>
<failed>
- 试过用 search_code 搜 "bcrypt"，零结果——这个项目没用 bcrypt
- 试过读 src/auth/crypto.ts，文件不存在
</failed>
<next>看 src/auth/middleware.ts 确认 token 校验的时机</next>`

const LAZY_SUMMARY = `<goal>看看那个 auth 模块</goal>
<done>
- 看了几个文件，大致了解了登录流程
</done>
<found>
- 用的是 JWT
</found>
<next>继续看</next>`

function demoSummaryQuality() {
  console.log('\n【一】两份摘要，差别在哪')

  console.log('\n  好的那份：')
  const good = parseSummary(GOOD_SUMMARY)
  console.log(`    goal   ${good.goal}`)
  console.log(`    done   ${good.done.length} 条`)
  console.log(`    found  ${good.found.length} 条（带路径和行号）`)
  console.log(`    failed ${good.failed.length} 条 ← 关键`)

  console.log('\n  偷懒的那份（缺 failed）：')
  try {
    parseSummary(LAZY_SUMMARY)
    console.log('    解析通过了 —— 这是个 bug，缺 failed 应该被拦住')
  } catch (err) {
    console.log(`    被拦下：${(err as Error).message}`)
  }

  console.log('\n  另外注意 goal 那一行：好的那份是原文，偷懒的那份被概括成了')
  console.log('  「看看那个 auth 模块」——**安全问题这个要求消失了**。')
  console.log('  再压缩两次，agent 就在做一件和原始请求只有远亲关系的事。')
}

function demoDecision() {
  console.log('\n【二】同样的长度，该压还是不该压')
  console.log('唯一的变量是「预计还要走多少步」。\n')

  const available = inputBudget(defaultBudget)
  // 造一个占到 70% 的假统计
  const stats: ContextStats = {
    tokens: Math.round(available * 0.7),
    ratio: 0.7,
    breakdown: { system: 900, toolDefs: 1800, task: 400, summary: 0, work: 75_300 },
    top: 'work',
    budget: defaultBudget,
  }

  for (const stepsLeft of [1, 2, 5, 10, 30]) {
    const d = shouldCompress({ stats, stepsLeft })
    const mark = d.compress ? '压' : '不压'
    console.log(`  还剩 ${String(stepsLeft).padStart(2)} 步 → ${mark}　${d.why}`)
  }

  console.log('\n  长度一模一样，结论相反。因为压缩的收益乘的是剩余步数，')
  console.log('  而代价（重建缓存）是一次性的。**剩余步数少的时候，不压更便宜。**')
}

function demoCeiling() {
  console.log('\n【三】快撑爆时的例外')

  const available = inputBudget(defaultBudget)
  for (const ratio of [0.5, 0.65, 0.88, 0.95]) {
    const stats: ContextStats = {
      tokens: Math.round(available * ratio),
      ratio,
      breakdown: { system: 900, toolDefs: 1800, task: 400, summary: 0, work: 1 },
      top: 'work',
      budget: defaultBudget,
    }
    const d = shouldCompress({ stats, stepsLeft: 1 })
    console.log(`  占 ${String(Math.round(ratio * 100)).padStart(2)}% · 剩 1 步 → ${d.compress ? '压' : '不压'}　${d.why}`)
  }

  console.log('\n  到 90% 之后即使只剩一步也要压——这时候不是省钱问题，')
  console.log('  是「下一步的工具结果会不会直接把窗口撑爆」的问题。')
}

function demoSliding() {
  console.log('\n【四】滑动窗口的 tool_use 配对陷阱')

  const msgs: Anthropic.MessageParam[] = [{ role: 'user', content: '原始任务' }]
  for (let i = 0; i < 6; i++) {
    msgs.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name: 'read_file', input: { path: `f${i}.ts` } }],
    })
    msgs.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `内容 ${i}` }],
    })
  }

  console.log(`\n  原始 ${msgs.length} 条`)
  for (const keep of [3, 4, 5, 6]) {
    const out = slidingWindow(msgs, keep)
    const orphan = out.some((m, i) => i > 0 && hasToolResult(m) && !hasToolUse(out[i - 1]))
    console.log(
      `  keep=${keep} → ${out.length} 条 · ${orphan ? '✗ 有 tool_result 找不到它的 tool_use' : '✓ 配对完整'}`,
    )
  }

  console.log('\n  上面某个 keep 值出现 ✗ 的话，那就是这个坑：切点落在工具轮次中间，')
  console.log('  tool_result 失去了它的 tool_use，然后 API 直接报 400。')
  console.log('  注意它只在特定的 keep 值下出现——只测一个值很容易漏掉。')
}

function hasToolResult(m: Anthropic.MessageParam | undefined): boolean {
  if (!m || typeof m.content === 'string') return false
  return m.content.some((b) => (b as { type: string }).type === 'tool_result')
}

function hasToolUse(m: Anthropic.MessageParam | undefined): boolean {
  if (!m || typeof m.content === 'string') return false
  return m.content.some((b) => (b as { type: string }).type === 'tool_use')
}

// ─────────────────────────────────────────────────────────────
// TODO 6：亲手算一次那笔账
//
// 把 demoDecision 里的 cacheDiscount 从默认的 0.1 改成 1
// （相当于"没有 prompt 缓存"）。
//
// 结论会怎么变？为什么？
// 然后回答：如果你的 agent 完全没用 prompt 缓存，压缩策略该更激进还是更保守？
// ─────────────────────────────────────────────────────────────

function main() {
  console.log('压缩不是越多越好。这个任务重点在"什么时候不压"。')
  demoSummaryQuality()
  demoDecision()
  demoCeiling()
  demoSliding()
  console.log('\n' + '─'.repeat(60))
  console.log('下一个任务把这套东西接到 L05 的 agent 上，跑一个真的长任务。')
  console.log('别忘了 TODO 6。')
  void measure
}

// verify.ts 会 import 这个文件来测你写的函数。不加这道判断的话，
// import 的那一刻观察实验就跑起来了，verify 的输出会变成第一个 TODO
// 的堆栈，而不是一张「还有哪些没写」的清单。
if (isMain(import.meta.url)) main()
