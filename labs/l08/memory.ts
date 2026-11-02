/**
 * L08 任务二：长期记忆，以及防止它被污染。
 *
 *   pnpm memory
 *
 * 不调 API。参考实现在 shared/memory.ts。
 *
 * ★ 这个任务的核心判断：**长期记忆的主要风险不是记不住，是记错。**
 *
 * 记不住只是效率损失——重新问一遍就行。
 * 记错是**永久性的**：一条错误的事实写进去之后，每一次会话都会读到它、
 * 基于它做决定、并且从它推导出新的（同样错误的）结论。
 *
 * 所以你要写的大部分代码不是「怎么存」，是「什么不许存」。
 */

import { isMain } from '../shared/entry.ts'

// ─────────────────────────────────────────────────────────────
// 类型定义（已给）
//
// ★ observed 和 derived 必须分开，而且不能互相转化。
//
//   observed —— 直接看到的。「用户说他用 pnpm」
//   derived  —— 推导出来的。「用户偏好现代工具链」
//
// 为什么这个区分重要：**推导会复合误差。**
// 从 derived 再推导一次，误差乘一次；三层之后你得到的是一个和事实
// 只有远亲关系的判断，而它长得和 observed 一模一样。
// ─────────────────────────────────────────────────────────────

export type FactKind = 'observed' | 'derived'

export interface Fact {
  key: string
  value: string
  kind: FactKind
  source: string
  evidence?: string
  depth: number
  confidence: number
  createdAt: number
  updatedAt: number
  hits: number
  ttlMs?: number
}

export interface MemoryOptions {
  minConfidence?: number
  maxDepth?: number
  now?: () => number
}

export class MemoryError extends Error {
  constructor(msg: string, readonly fact: Partial<Fact>) {
    super(msg)
    this.name = 'MemoryError'
  }
}

export interface Conflict {
  key: string
  existing: Fact
  incoming: Omit<Fact, 'createdAt' | 'updatedAt' | 'hits'>
}

export interface RememberResult {
  written: boolean
  conflict?: Conflict
  reason?: string
}

// ─────────────────────────────────────────────────────────────
// TODO 1：Memory 类
//
// remember() 要有四道闸，每一道对应一类污染：
//
//   闸一 · 必须有 source（抛异常）
//          没有出处的事实，发现污染时你没法顺着删掉一整批。
//
//   闸二 · observed 必须有 evidence（抛异常）
//          没有原话的"观察"其实是推导。这道闸把两者强行分开。
//          derived 不强制——它的证据就是被推导的那些 observed。
//
//   闸三 · depth 超过 maxDepth 就不写（返回 written: false）
//          这一道最容易被忽略，也是"记忆慢慢跑偏"的主要机制。
//
//   闸四 · confidence 低于 minConfidence 就不写
//          宁可再问一次。
//
// ★ 冲突处理是这个类最重要的设计：
//
// 同一个 key 已经有一个**不同的** value 时，既不能静默覆盖，
// 也不能静默忽略——两者都是污染的入口：
//
//   静默覆盖 → 一次幻觉就能永久改掉一条正确的事实
//   静默忽略 → 用户真的换了包管理器，你永远记着旧的
//
// 所以返回 conflict，让调用方显式 resolve（'keep' 或 'replace'）。
//
// ★ 还有一条真实的规则：**observed 可以覆盖 derived，反过来不行。**
// 推导出来的结论不该推翻直接观察到的事实。
//
// ★ 一个容易漏的细节：value 变了的时候 hits 不能继承。
// 旧值被用过 50 次不代表新值可靠。
// ─────────────────────────────────────────────────────────────

export class Memory {
  constructor(opts: MemoryOptions = {}) {
    void opts
  }

  remember(
    input: Omit<Fact, 'createdAt' | 'updatedAt' | 'hits'>,
    opts: { resolve?: 'keep' | 'replace' } = {},
  ): RememberResult {
    void input
    void opts
    throw new Error('TODO: 实现 Memory.remember')
  }

  // ───────────────────────────────────────────────────────────
  // TODO 2：recall
  //
  // ★ 过期的事实要**返回但标记 stale**，而不是直接藏起来。
  //
  // 藏起来的后果是模型不知道自己曾经知道过什么，于是重新问一遍——
  // 而重新问一遍在很多场景里比"知道但不确定"更烦人。
  // 标记 stale 之后，prompt 里可以写「这条可能过期了，用之前确认一下」。
  //
  // 要支持前缀查询：传 'user.' 拿到所有 user 命名空间的事实。
  //
  // ★ 返回顺序不是随便排的：observed 排在 derived 前面，
  // 同类按置信度降序。**顺序影响模型的注意力分配**（L05x）。
  //
  // 别忘了 hits++——淘汰策略要用它。
  // ───────────────────────────────────────────────────────────

  recall(keys?: string[]): { fact: Fact; stale: boolean }[] {
    void keys
    throw new Error('TODO: 实现 Memory.recall')
  }

  /** 显式删除。发现污染之后按 source 批量删是最常见的操作。 */
  forget(pred: (f: Fact) => boolean): number {
    void pred
    throw new Error('TODO: 实现 Memory.forget')
  }

  // ───────────────────────────────────────────────────────────
  // TODO 3：evict（淘汰）
  //
  // ★ 遗忘是功能不是 bug。
  //
  // 不淘汰的记忆会累积过期事实，而过期事实的危害和错误事实一样——
  // 「用户偏好用 npm」在六个月后可能已经是错的，但它看起来和真的一样。
  //
  // 淘汰顺序：先过期的，再从没被召回过的，最后最旧的。
  // 已过期的要有一个足够大的负权重，让它一定排在最前面。
  // ───────────────────────────────────────────────────────────

  evict(limit: number): Fact[] {
    void limit
    throw new Error('TODO: 实现 Memory.evict')
  }

  get size(): number {
    throw new Error('TODO: 实现 Memory.size')
  }

  all(): Fact[] {
    throw new Error('TODO: 实现 Memory.all')
  }
}

// ─────────────────────────────────────────────────────────────
// TODO 4：渲染进 prompt
//
// ★ 必须带出处，而且必须区分观察和推导。
//
// 因为模型会把你给它的一切当成事实——你写「用户偏好 pnpm」，
// 它就当这是铁律，哪怕这条是三个月前从一句话推导出来的。
//
// 带上出处和类型之后，模型至少有机会说「我记得你之前提过用 pnpm，
// 现在还是吗」——而这句话正是防止污染扩散的那道人工闸。
//
// 用 <observed> 和 <derived> 两个区块分开（XML 标签，L03）。
// 每条后面附出处、原话（截断）、置信度（低于 0.9 才显示）、stale 标记。
//
// 空记忆返回空字符串，不要返回一个空的 <memory></memory>——
// 那会白占 token 而且让模型以为"记忆是空的"是一条信息。
// ─────────────────────────────────────────────────────────────

export function renderMemory(items: { fact: Fact; stale: boolean }[]): string {
  void items
  throw new Error('TODO: 实现 renderMemory')
}

// ─────────────────────────────────────────────────────────────
// TODO 5：解析抽取结果
//
// 格式：key | value | observed|derived | 置信度 | 原话
//
// ★ 严格解析，坏行**跳过并记数**而不是猜。
//
// 记忆的入口是最不能宽容的地方：一条格式错误的行猜错了字段位置，
// 就是一条错误的事实永久写进去。**宁可少记一条，不要记错一条。**
//
// 这和 L03 那个宽容的 parse 是相反的取向，值得想清楚为什么：
// L03 解析的是**一次性的输出**，错了下次重来；
// 这里解析的是**要长期保存的事实**，错了永久有效。
//
// 五条校验：
//   字段数不足 → 跳过
//   key 或 value 为空 → 跳过
//   kind 不是 observed / derived → 跳过（不要默认成任何一个）
//   confidence 不是 0-1 的数 → 跳过
//   key 里没有点号 → 跳过
//
// 最后一条的理由：不强制命名空间的话，你三个月后会有
// pm、packageManager、package_manager 三条互相矛盾的事实。
//
// NONE 和空行直接忽略，不算坏行。
// 记得剥掉模型爱加的列表符号。
// ─────────────────────────────────────────────────────────────

export interface Extraction {
  key: string
  value: string
  kind: FactKind
  evidence?: string
  confidence: number
}

export function parseExtraction(raw: string): { facts: Extraction[]; skipped: string[] } {
  void raw
  throw new Error('TODO: 实现 parseExtraction')
}

// ─────────────────────────────────────────────────────────────
// TODO 6：检测自相矛盾
//
// 模型在同一次抽取里就可能给出两条冲突的事实（对话里用户改了主意）。
// **在写入之前检测，比写入之后靠冲突解决更便宜。**
// ─────────────────────────────────────────────────────────────

export function findContradictions(facts: Extraction[]): { key: string; values: string[] }[] {
  void facts
  throw new Error('TODO: 实现 findContradictions')
}

// ─────────────────────────────────────────────────────────────
// 观察实验
// ─────────────────────────────────────────────────────────────

const DAY = 86_400_000
let clock = Date.UTC(2026, 0, 1)
const now = () => clock

function fact(o: Partial<Fact> & Pick<Fact, 'key' | 'value'>): Omit<Fact, 'createdAt' | 'updatedAt' | 'hits'> {
  return {
    kind: 'observed',
    source: 'session-1',
    evidence: '（原话）',
    depth: 0,
    confidence: 0.9,
    ...o,
  }
}

function demoGates() {
  console.log('\n【一】四道闸各拦住什么')

  const m = new Memory({ now })

  const cases: [string, Omit<Fact, 'createdAt' | 'updatedAt' | 'hits'>][] = [
    ['正常的观察', fact({ key: 'user.package_manager', value: 'pnpm' })],
    ['没有出处', { ...fact({ key: 'user.editor', value: 'vim' }), source: '' }],
    ['observed 没原话', { ...fact({ key: 'user.shell', value: 'zsh' }), evidence: '' }],
    [
      '二次推导',
      fact({ key: 'user.style', value: '偏好现代工具链', kind: 'derived', depth: 2 }),
    ],
    ['置信度太低', fact({ key: 'user.timezone', value: 'UTC+8', confidence: 0.4 })],
  ]

  for (const [label, f] of cases) {
    try {
      const r = m.remember(f)
      const mark = r.written ? '\x1b[32m写入\x1b[0m' : '\x1b[33m拒绝\x1b[0m'
      console.log(`  ${label.padEnd(16)} ${mark}${r.reason ? ` —— ${r.reason}` : ''}`)
    } catch (err) {
      console.log(`  ${label.padEnd(16)} \x1b[31m抛错\x1b[0m —— ${(err as Error).message}`)
    }
  }

  console.log('\n  前两道闸抛异常（调用方写错了代码），后两道返回 false（数据不够好）。')
  console.log('  这个区分很重要：**代码 bug 要吵，数据不足要静静地不写。**')
}

function demoConflict() {
  console.log('\n【二】冲突：既不能静默覆盖，也不能静默忽略')

  const m = new Memory({ now })
  m.remember(fact({ key: 'user.package_manager', value: 'pnpm', evidence: '我用 pnpm' }))

  const r = m.remember(fact({ key: 'user.package_manager', value: 'npm', evidence: '换成 npm 了' }))
  console.log(`  第二次写不同的值：written=${r.written}，conflict=${r.conflict ? '有' : '无'}`)
  if (r.conflict) {
    console.log(`    旧：${r.conflict.existing.value}（${r.conflict.existing.source}）`)
    console.log(`    新：${r.conflict.incoming.value}（${r.conflict.incoming.source}）`)
  }

  const replaced = m.remember(
    fact({ key: 'user.package_manager', value: 'npm', evidence: '换成 npm 了' }),
    { resolve: 'replace' },
  )
  console.log(`  显式 resolve='replace'：written=${replaced.written}`)

  console.log('\n  为什么不能默认覆盖：一次幻觉就能永久改掉一条正确的事实。')
  console.log('  为什么不能默认忽略：用户真的换了工具，你永远记着旧的。')
  console.log('  **两个默认都错，所以必须让调用方显式决定，而这个决定要被记下来。**')

  // observed vs derived
  const m2 = new Memory({ now })
  m2.remember(fact({ key: 'user.pm', value: 'pnpm', evidence: '我用 pnpm' }))
  const bad = m2.remember(
    fact({ key: 'user.pm', value: 'yarn', kind: 'derived', depth: 1, evidence: undefined }),
    { resolve: 'replace' },
  )
  console.log(`\n  推导结果想覆盖观察事实：written=${bad.written}`)
  console.log(`    ${bad.reason}`)
}

function demoDepth() {
  console.log('\n【三】推导深度：记忆怎么慢慢跑偏')

  console.log('  一条真实的漂移链：')
  console.log('    depth 0（观察）：用户说「这个项目用 pnpm」')
  console.log('    depth 1（推导）：用户偏好现代工具链')
  console.log('    depth 2（推导）：用户会接受激进的重构建议')
  console.log('    depth 3（推导）：可以不问就改动构建配置')
  console.log('\n  第四条已经是一个会造成事故的"事实"，而它和第一条')
  console.log('  在存储里长得**一模一样**——都是一行 key = value。')
  console.log('\n  ★ maxDepth 默认是 1，意思是：**不允许从推导结果再推导。**')
  console.log('  这个限制看起来严苛，但漂移是复合的，放开一层就挡不住了。')

  const m = new Memory({ now, maxDepth: 1 })
  for (const d of [0, 1, 2, 3]) {
    const r = m.remember(
      fact({
        key: `t.d${d}`,
        value: `深度 ${d} 的结论`,
        kind: d === 0 ? 'observed' : 'derived',
        depth: d,
      }),
    )
    console.log(`  depth=${d} → ${r.written ? '写入' : '拒绝'}`)
  }
}

function demoStale() {
  console.log('\n【四】过期：标记而不是隐藏')

  const m = new Memory({ now })
  m.remember(fact({ key: 'project.node_version', value: '20', ttlMs: 30 * DAY }))
  m.remember(fact({ key: 'user.name', value: '张三' })) // 没有 ttl

  clock += 60 * DAY
  const items = m.recall()
  for (const { fact: f, stale } of items) {
    console.log(`  ${f.key.padEnd(22)} ${stale ? '\x1b[33mstale\x1b[0m' : '新鲜'}`)
  }

  console.log('\n  渲染出来是这样：\n')
  console.log(
    renderMemory(items)
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n'),
  )
  console.log('\n  ★ 关键是最后那个「可能已过期」标记。')
  console.log('  藏起来的话模型只会重新问一遍；标出来的话它能说')
  console.log('  「我记得之前是 Node 20，现在还是吗」——而这句话是防污染的人工闸。')
}

function demoEvict() {
  console.log('\n【五】淘汰：什么先被忘掉')

  const m = new Memory({ now })
  m.remember(fact({ key: 'a.often_used', value: 'x' }))
  m.remember(fact({ key: 'b.never_used', value: 'y' }))
  m.remember(fact({ key: 'c.expired', value: 'z', ttlMs: DAY }))
  m.remember(fact({ key: 'd.derived', value: 'w', kind: 'derived', depth: 1 }))

  // 让 a 被召回几次
  clock += 2 * DAY
  m.recall(['a.often_used'])
  m.recall(['a.often_used'])
  m.recall(['a.often_used'])

  const dropped = m.evict(2)
  console.log(`  淘汰前 4 条，限制 2 条 → 淘汰了 ${dropped.map((f) => f.key).join('、')}`)
  console.log(`  留下：${m.all().map((f) => f.key).join('、')}`)
  console.log('\n  过期的先走，然后是从没被用过的。被反复召回的留下——')
  console.log('  **使用频率是"这条还有用"的最好代理指标**，比置信度可靠，')
  console.log('  因为置信度是模型自己报的，而使用频率是观察到的。')
}

function demoParse() {
  console.log('\n【六】解析：宁可少记一条，不要记错一条')

  const raw = `user.package_manager | pnpm | observed | 0.95 | 我们项目用 pnpm
project.test_runner | vitest | observed | 0.9 | 测试跑 vitest
pm | pnpm | observed | 0.9 | 没有命名空间
user.editor | vim | maybe | 0.8 | kind 写错了
user.shell | zsh | observed | 高 | 置信度不是数字
user.style | 偏好现代工具 | derived | 0.7 |
这一行完全不符合格式
NONE`

  const { facts, skipped } = parseExtraction(raw)
  console.log(`  收下 ${facts.length} 条，跳过 ${skipped.length} 条`)
  for (const f of facts) console.log(`    \x1b[32m✓\x1b[0m ${f.key} = ${f.value} (${f.kind})`)
  for (const s of skipped) console.log(`    \x1b[33m✕\x1b[0m ${s.slice(0, 44)}`)

  console.log('\n  注意 kind 写错的那条被跳过了，而不是默认成 observed。')
  console.log('  默认成 observed 的后果：一条推测被当成事实永久存下来。')
  console.log('\n  ★ 这和 L03 那个宽容的 parse 取向相反，值得想清楚为什么：')
  console.log('  L03 解析的是一次性输出，错了下次重来；')
  console.log('  这里解析的是要长期保存的事实，**错了永久有效**。')

  const dup = parseExtraction(`user.pm | pnpm | observed | 0.9 | 用 pnpm
user.pm | npm | observed | 0.8 | 算了改用 npm`)
  const conflicts = findContradictions(dup.facts)
  console.log(`\n  同一次抽取里的自相矛盾：${conflicts.map((c) => `${c.key}(${c.values.join(' vs ')})`).join('、')}`)
  console.log('  用户在同一段对话里改了主意。**写入前检测比写入后解决便宜得多。**')
}

// ─────────────────────────────────────────────────────────────
// TODO 7：想一个你自己的污染场景
//
// 假设你的 agent 在第一次会话里从一句玩笑话推导出
// 「用户不在乎代码可读性」并写进了长期记忆。
//
// 1. 这条事实会怎么影响后面每一次会话？
// 2. 用户要过多久才可能发现？他会怎么描述这个问题？
// 3. 这个模块里的哪一道闸本来应该拦住它？为什么可能没拦住？
// 4. 如果它已经写进去了，你靠哪个字段能找到并删掉它？
// ─────────────────────────────────────────────────────────────

function main() {
  console.log('长期记忆与记忆污染。不调 API。')
  demoGates()
  demoConflict()
  demoDepth()
  demoStale()
  demoEvict()
  demoParse()
  console.log('\n' + '─'.repeat(60))
  console.log('接着跑 pnpm resume，把这两块接到 L05 的 agent 上。')
  console.log('别忘了 TODO 7——它没有代码，但它是这一节最该想清楚的东西。')
}

// verify.ts 会 import 这个文件来测你写的函数。不加这道判断的话，
// import 的那一刻观察实验就跑起来了，verify 的输出会变成第一个 TODO
// 的堆栈，而不是一张「还有哪些没写」的清单。
if (isMain(import.meta.url)) main()
