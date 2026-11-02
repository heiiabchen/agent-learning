/**
 * 验证 l11x/ecosystem.ts。跑法：pnpm verify:l11x
 *
 * ★ 主通道在 Python 那边（uv run python -m l11x.verify），
 * 这一份只测 TS 这边**真正存在**的那三件事：
 * schema 解引用、AbortController 版的结构化并发、addMessages。
 *
 * few-shot 编译没有 TS 版，理由不是"没人写"——见 demo 五。
 *
 * 带 ★ 的每一条对应一个静默失效：
 * $ref 被当成字符串、环被内联成无限递归、兄弟键被丢掉、
 * 消息按 id 覆盖失效、abort 漏传导致孤儿任务继续烧钱。
 *
 * 先跑 ECO_IMPL=shared pnpm verify:l11x 确认测试本身是对的。
 */

import * as shared from '../shared/pyecosystem.ts'
import type { Job } from '../shared/pyecosystem.ts'

const TARGET = process.env.ECO_IMPL === 'shared' ? 'shared' : 'mine'
const mine = (await import('./ecosystem.ts')) as unknown as {
  dereference: typeof shared.dereference
  schemaHealth: typeof shared.schemaHealth
  runTaskGroupLike: typeof shared.runTaskGroup
  myAddMessages: shared.Reducer
}

const M =
  TARGET === 'shared'
    ? {
        dereference: shared.dereference,
        schemaHealth: shared.schemaHealth,
        runTaskGroup: shared.runTaskGroup,
        addMessages: shared.addMessages,
      }
    : {
        dereference: mine.dereference,
        schemaHealth: mine.schemaHealth,
        runTaskGroup: mine.runTaskGroupLike,
        addMessages: mine.myAddMessages,
      }

console.log(
  TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l11x/ 里你的实现）',
)

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
    for (const line of String((err as Error).message).split('\n')) {
      console.log(`\x1b[31m      ${line}\x1b[0m`)
    }
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

type Sch = Record<string, unknown>

// ─── 素材 ────────────────────────────────────────────────────

const SIMPLE: Sch = {
  type: 'object',
  properties: { f: { $ref: '#/$defs/D' } },
  $defs: { D: { type: 'object', properties: { x: { type: 'string' } } } },
}

const DIAMOND: Sch = {
  type: 'object',
  properties: { a: { $ref: '#/$defs/D' }, b: { $ref: '#/$defs/D' } },
  $defs: { D: { type: 'integer' } },
}

const CHAINED: Sch = {
  type: 'object',
  properties: { a: { $ref: '#/$defs/A' } },
  $defs: {
    A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
    B: { type: 'boolean' },
  },
}

const CYCLE: Sch = {
  type: 'object',
  properties: { n: { $ref: '#/$defs/Node' } },
  $defs: { Node: { type: 'object', properties: { kid: { $ref: '#/$defs/Node' } } } },
}

const SIBLING: Sch = {
  type: 'object',
  properties: { f: { $ref: '#/$defs/D', description: '覆盖后的' } },
  $defs: { D: { type: 'string', description: '原来的' } },
}

const LEGACY: Sch = {
  type: 'object',
  properties: { f: { $ref: '#/definitions/D' } },
  definitions: { D: { type: 'number' } },
}

const DANGLING: Sch = { type: 'object', properties: { f: { $ref: '#/$defs/Gone' } } }
const FLAT: Sch = { type: 'object', properties: { a: { type: 'string' } } }
const ANY_OF: Sch = {
  type: 'object',
  properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
}

const props = (s: Sch) => s.properties as Record<string, Sch>

// ─── 一、schema 解引用 ───────────────────────────────────────
console.log('\n一、schema 解引用（TODO 1）')

await test('简单引用被内联，$defs 删掉', () => {
  const out = M.dereference(SIMPLE)
  assert(
    (props(props(out).f!).x as Sch)?.type === 'string',
    '嵌套定义应该被内联到用点上',
  )
  assert(!('$defs' in out), '内联完 $defs 就该删掉，留着是死重量')
})

await test('★ 菱形引用：两处都拿到值，不是一处拿到一处空', () => {
  const out = M.dereference(DIAMOND)
  assert(
    props(out).a?.type === 'integer' && props(out).b?.type === 'integer',
    '同一个定义被引用两次，两处都要解开。\n' +
      '      只解第一处是最常见的实现 bug——而它不报错，\n' +
      '      第二个参数会静默变成一个空对象',
  )
})

await test('链式引用（A→B→C）要一路解到底', () => {
  assert(
    (props(props(M.dereference(CHAINED)).a!).b as Sch)?.type === 'boolean',
    '只解一层的话，里面那层 $ref 还在，问题原样保留',
  )
})

await test('★ 自引用的类型：$ref 必须留在原地', () => {
  const out = M.dereference(CYCLE)
  assert(
    '$ref' in (props(out).n ?? {}),
    '树节点这种自引用类型**不能内联**——内联一个环是无限递归。\n' +
      '      递归树是很常见的工具参数（文件树、AST、评论楼层）',
  )
  assert(
    '$defs' in out && 'Node' in (out.$defs as object),
    '留了 $ref 就必须留对应的 $defs，否则变成悬空指针',
  )
})

await test('★ 兄弟键覆盖解析出来的值（JSON Schema 2020-12）', () => {
  assert(
    props(M.dereference(SIBLING)).f?.description === '覆盖后的',
    '{$ref: D, description: X} 里 X 要盖住 D 自带的 description。\n' +
      '      弄反了不会报错——你只会得到一个描述不对的参数，\n' +
      '      然后模型按那个错描述填值',
  )
})

await test('旧式 definitions 也要认', () => {
  assert(
    props(M.dereference(LEGACY)).f?.type === 'number',
    'draft-07 用 definitions，2020-12 用 $defs。生态里两种都有，只认一种会漏',
  )
})

await test('解不出来的 $ref 留下，不丢掉', () => {
  assert(
    '$ref' in (props(M.dereference(DANGLING)).f ?? {}),
    '★ 留下比丢掉好：悬空指针至少会让请求报错，\n' +
      '      而丢掉会让模型看到一个「参数不存在」的 schema，静默走偏',
  )
})

await test('没有 $defs 的 schema 原样返回', () => {
  assert(
    props(M.dereference(FLAT)).a?.type === 'string',
    '平坦 schema 不该被动。改了它就等于给所有现有工具引入回归',
  )
})

await test('不改原对象', () => {
  const snap = JSON.stringify(SIMPLE)
  M.dereference(SIMPLE)
  assert(JSON.stringify(SIMPLE) === snap, '原对象必须一个字节都没变')
})

// ─── 二、schema 体检 ─────────────────────────────────────────
console.log('\n二、schema 体检（TODO 2）')

await test('★ 活着的本地 $ref 要报出来', () => {
  const ps = M.schemaHealth(SIMPLE)
  assert(ps.length > 0, '有 $ref 就必须报——这是那个「参数变成字符串」的坑')
  assert(
    ps.some((p) => p.includes('$ref')),
    '报出来的话得说清是 $ref 的问题',
  )
})

await test('悬空 $ref 要报出来', () => {
  assert(M.schemaHealth(DANGLING).length > 0, '$defs 被中间层丢掉是真实发生过的 bug')
})

await test('干净的 schema 不该报任何问题', () => {
  assert(
    M.schemaHealth(M.dereference(SIMPLE)).length === 0,
    '★ 解引用之后必须是干净的。这一条把 TODO 1 和 TODO 2 锁在一起：\n' +
      '      如果解引用漏了什么，体检会当场发现',
  )
})

await test('anyOf 要报出来', () => {
  assert(
    M.schemaHealth(ANY_OF).length > 0,
    'anyOf 通常来自可选字段或联合类型。模型挑错分支不会报错，\n' +
      '      它会给你一个结构对不上的参数',
  )
})

// ─── 三、addMessages ─────────────────────────────────────────
console.log('\n三、addMessages（TODO 4）')

type Msg = Record<string, unknown>
const asMsgs = (v: unknown) => v as Msg[]

await test('★ 按 id 覆盖，不追加', () => {
  const out = asMsgs(M.addMessages([{ id: 'a', t: '1' }], [{ id: 'a', t: '2' }]))
  assert(
    out.length === 1,
    '同 id 必须覆盖。追加会让历史里同时存在改前和改后两条，\n' +
      '      模型看到两条矛盾的消息——而它不报错，它会挑一条',
  )
  assert(out[0]!.t === '2', '覆盖后留下的应该是新的那条')
})

await test('对新 id 追加', () => {
  assert(
    asMsgs(M.addMessages([{ id: 'a' }], [{ id: 'b' }])).length === 2,
    '不同 id 是两条不同的消息，要都留着',
  )
})

await test('保持原有顺序', () => {
  const out = asMsgs(M.addMessages([{ id: 'a' }, { id: 'b' }], [{ id: 'a', t: 'x' }]))
  assert(
    out.map((m) => m.id).join(',') === 'a,b',
    '★ 覆盖不能改位置。把 a 挪到末尾会让对话顺序错乱，\n' +
      '      而模型对消息顺序是敏感的',
  )
})

await test('容忍没有 id 的消息', () => {
  assert(
    asMsgs(M.addMessages([{ t: '1' }], [{ t: '2' }])).length === 2,
    '没有 id 就没法去重，只能追加。这里崩掉会让整个图挂掉',
  )
})

await test('处理 undefined / 空历史', () => {
  assert(asMsgs(M.addMessages(undefined, [{ id: 'a' }])).length === 1, '第一次写入时旧值是空')
  assert(asMsgs(M.addMessages([], [{ id: 'a' }])).length === 1, '空数组也要能写')
})

await test('接受单条（不只是数组）', () => {
  assert(
    asMsgs(M.addMessages([], { id: 'a' })).length === 1,
    '节点返回单条消息是常见写法，reducer 要两种都吃',
  )
})

// ─── 四、AbortController 版的结构化并发 ─────────────────────
console.log('\n四、AbortController 版的"一个失败就全停"（TODO 3）')

/** 一个尊重 signal 的 job 工厂。paid 记录"真的跑完了、钱真的花了"。 */
function makeJobs(paid: string[]): Record<string, Job> {
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortErr())
      const t = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(t)
        reject(abortErr())
      })
    })

  return {
    boom: async () => {
      await sleep(5)
      throw new Error('挂了')
    },
    s1: async (signal) => {
      await sleep(60, signal)
      paid.push('s1')
      return 's1'
    },
    s2: async (signal) => {
      await sleep(60, signal)
      paid.push('s2')
      return 's2'
    },
  }
}

function abortErr(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

await test('★ 朴素 Promise.all 会留下还在烧钱的孤儿任务', async () => {
  const paid: string[] = []
  const r = await shared.runAll(makeJobs(paid))
  assert(
    r.orphaned === 2,
    '★ 第一个 reject 立刻上抛，**其余 Promise 继续跑到底**——\n' +
      '      因为 Promise 一旦创建就无法取消。\n' +
      '      在 agent 里就是：一个 sub-agent 崩了，另外两个还在调模型、\n' +
      '      还在花钱——只是没有人会读它们的结果了',
  )
  assert(r.cancelled.length === 0, '朴素 Promise.all 不取消任何东西，这一项必须是空')
  assert(
    paid.length === 2,
    '★ 那两个「孤儿」最后是真的跑完了、钱真的花了。\n' +
      '      而 JS 连一句警告都不打——Python 至少会说 \n' +
      '      "Task was destroyed but it is still pending"',
  )
})

await test('★ AbortController 版：第一个真失败要取消其余', async () => {
  const paid: string[] = []
  const r = await M.runTaskGroup(makeJobs(paid))
  assert(
    r.cancelled.length === 2,
    '★ 这是 TaskGroup 的核心语义，也是这个 TODO 的全部意义：\n' +
      '      第一个真失败 → abort 其余。\n' +
      '      cancelled 是 0 说明 abort 没生效——通常是 signal 没往下传',
  )
  assert(
    paid.length === 0,
    '★ 被取消了就不该跑完，钱也不该花。\n' +
      '      这里不是 0 说明有 job 没尊重 signal——而那个 job 就是孤儿，\n' +
      '      **没有任何东西会提醒你**',
  )
})

await test('取消不算失败，要分开记', async () => {
  const r = await M.runTaskGroup(makeJobs([]))
  assert(
    r.failed.length === 1,
    '只有 boom 是真失败。把被取消的也记成失败，\n' +
      '      报告里就会出现"3 个失败"，而实际只有 1 个出了问题',
  )
})

await test('多个失败要都收进 raised', async () => {
  const jobs: Record<string, Job> = {
    a: async () => {
      throw new Error('a 挂了')
    },
    b: async () => {
      throw new Error('b 挂了')
    },
  }
  const r = await M.runTaskGroup(jobs)
  assert(
    r.raised !== null && r.raised.includes('a 挂了') && r.raised.includes('b 挂了'),
    '★ 对应 Python 的 ExceptionGroup：多个任务同时失败时要给全部。\n' +
      '      只报第一个的话，你会修完一个再发现还有一个——\n' +
      '      而朴素 Promise.all 就只给你第一个',
  )
})

await test('全部成功时不该抛，也不该有取消', async () => {
  const jobs: Record<string, Job> = { a: async () => 'a', b: async () => 'b' }
  const r = await M.runTaskGroup(jobs)
  assert(r.ok.length === 2 && r.raised === null, '没人失败就不该 abort')
  assert(r.cancelled.length === 0, '没人失败就不该有取消')
})

await test('返回前所有任务都已结束（orphaned 必须是 0）', async () => {
  const r = await M.runTaskGroup(makeJobs([]))
  assert(
    r.orphaned === 0,
    '★ 结构化并发的定义就是这个：**没有任务能活过这个作用域。**\n' +
      '      漏 await 会让"已经处理完了"这个判断变成假的',
  )
})

// ─────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(62))
if (failures.length === 0) {
  console.log(`\x1b[32m全过。${passed} 项。\x1b[0m`)
  console.log('\n主通道在 Python 那边：uv run python -m l11x.verify（39 项，含 DSPy 那组）')
} else {
  console.log(`\x1b[31m${failures.length} 项没过（过了 ${passed} 项）：\x1b[0m`)
  for (const f of failures) console.log(`\x1b[31m  · ${f}\x1b[0m`)
  console.log('\n先跑 ECO_IMPL=shared pnpm verify:l11x 对照参考实现。')
  process.exitCode = 1
}
