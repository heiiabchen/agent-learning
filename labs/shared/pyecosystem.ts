/**
 * 参考实现：Python agent 生态那四件机制的 TypeScript 对照。
 *
 * ★ 这一节和别的节反过来：**Python 是主通道，这个文件是对照。**
 *
 * 但它不是"把 Python 翻译一遍"。四件机制里只有两件在 TS 里真正存在：
 *
 *   schema 解引用   —— **两边都有这个 bug。** 那个真实修复（anything-llm
 *                      的 dereferenceSchema.js）就是 JavaScript 写的
 *   reducer 状态图   —— 语言无关的设计，TS 里写出来甚至更顺（判别联合）
 *
 *   结构化并发       —— TS 里的对应物不是"另一个 API"，是**三个 API 的组合**：
 *                      Promise.all / allSettled / AbortController。
 *                      见下面 runAll 那组
 *   few-shot 编译    —— 生态里没有 TS 版的 DSPy。这一件是真的只有 Python 有，
 *                      而理由在讲义第六节
 */

// ─────────────────────────────────────────────────────────────
// 一、schema 解引用：这个 bug 在 TS 里一模一样
// ─────────────────────────────────────────────────────────────

/**
 * 把本地 $ref 内联进 schema，然后删掉 $defs。
 *
 * ★ 为什么 TS 这边也需要它：**问题不在 pydantic，在工具 API。**
 *
 * Anthropic 不解本地 $ref。而任何一个"从类型生成 JSON Schema"的工具
 * （zod-to-json-schema、typebox、ts-json-schema-generator）在遇到
 * 复用的嵌套类型时，都会生成 $ref —— 因为那是合法且更紧凑的 JSON Schema。
 *
 * 所以这个坑和 Python 无关，它是**类型系统和工具 API 之间那条缝**。
 */
export function dereference(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = {
    ...((schema.definitions as Record<string, unknown>) ?? {}),
    ...((schema.$defs as Record<string, unknown>) ?? {}),
  }
  if (Object.keys(defs).length === 0) return schema

  const cyclic = findCyclic(defs)

  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve)
    if (node === null || typeof node !== 'object') return node

    const obj = node as Record<string, unknown>
    const ref = obj.$ref

    if (typeof ref === 'string') {
      const name = localRefName(ref)
      // 外部引用、解不出来的、以及有环的：原样留下。
      // ★ 留下比丢掉好——悬空指针至少会让请求报错，
      // 而丢掉会让模型看到一个"参数不存在"的 schema，静默走偏。
      if (name === null || !(name in defs) || cyclic.has(name)) {
        return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolve(v)]))
      }
      const resolved = resolve(defs[name])
      // 兄弟键覆盖（JSON Schema 2020-12）：
      // { $ref: X, description: '...' } 里 description 要盖住 X 自带的那个
      const siblings = Object.fromEntries(
        Object.entries(obj).filter(([k]) => k !== '$ref').map(([k, v]) => [k, resolve(v)]),
      )
      return resolved !== null && typeof resolved === 'object' && !Array.isArray(resolved)
        ? { ...(resolved as object), ...siblings }
        : resolved
    }

    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolve(v)]))
  }

  const body = Object.fromEntries(
    Object.entries(schema).filter(([k]) => k !== '$defs' && k !== 'definitions'),
  )
  const out = resolve(body) as Record<string, unknown>

  // 有环的定义必须留着，因为指向它们的 $ref 还在
  if (cyclic.size > 0) {
    out.$defs = Object.fromEntries(Object.entries(defs).filter(([k]) => cyclic.has(k)))
  }
  return out
}

function localRefName(ref: string): string | null {
  for (const prefix of ['#/$defs/', '#/definitions/']) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length)
  }
  return null
}

function collectRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const x of node) collectRefs(x, out)
    return
  }
  if (node === null || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if (typeof obj.$ref === 'string') {
    const name = localRefName(obj.$ref)
    if (name) out.add(name)
  }
  for (const v of Object.values(obj)) collectRefs(v, out)
}

function findCyclic(defs: Record<string, unknown>): Set<string> {
  const edges = new Map<string, Set<string>>()
  for (const [name, body] of Object.entries(defs)) {
    const found = new Set<string>()
    collectRefs(body, found)
    edges.set(name, found)
  }

  const cyclic = new Set<string>()
  for (const start of edges.keys()) {
    const stack = [start]
    const seen = new Set<string>()
    outer: while (stack.length > 0) {
      const cur = stack.pop()!
      for (const next of edges.get(cur) ?? []) {
        if (next === start) {
          cyclic.add(start)
          break outer
        }
        if (!seen.has(next)) {
          seen.add(next)
          stack.push(next)
        }
      }
    }
  }
  return cyclic
}

/**
 * 发出去之前查一遍。
 *
 * ★ 存在理由：那三种失效**全都不在你的代码里报错**。
 */
export function schemaHealth(schema: Record<string, unknown>): string[] {
  const problems: string[] = []
  const refs = new Set<string>()
  collectRefs(schema, refs)
  const have = new Set([
    ...Object.keys((schema.$defs as object) ?? {}),
    ...Object.keys((schema.definitions as object) ?? {}),
  ])

  const dangling = [...refs].filter((r) => !have.has(r))
  if (dangling.length > 0) {
    problems.push(
      `悬空 $ref：${JSON.stringify(dangling)}。中间层大概率只复制了 ` +
        `type/properties/required 三个键，把 $defs 丢了。这个还算好——它会让请求直接被拒`,
    )
  }

  const live = [...refs].filter((r) => have.has(r))
  if (live.length > 0) {
    problems.push(
      `schema 里还有本地 $ref：${JSON.stringify(live)}。Anthropic 不解本地引用，` +
        `模型会把那个参数**当成字符串**填——工具调用会成功，参数看起来也像回事，` +
        `只是嵌套对象是个 JSON 字符串`,
    )
  }

  if (hasKey(schema, 'anyOf')) {
    problems.push(
      'schema 里有 anyOf（通常来自可选字段或联合类型）。' +
        '模型挑错分支时不会报错，它会给你一个结构对不上的参数',
    )
  }

  return problems
}

function hasKey(node: unknown, key: string): boolean {
  if (Array.isArray(node)) return node.some((x) => hasKey(x, key))
  if (node === null || typeof node !== 'object') return false
  const obj = node as Record<string, unknown>
  return key in obj || Object.values(obj).some((v) => hasKey(v, key))
}

// ─────────────────────────────────────────────────────────────
// 二、并发：TS 这边的三个 API 对应 Python 的两个
// ─────────────────────────────────────────────────────────────

export interface RunOutcome {
  label: string
  ok: string[]
  failed: string[]
  /** 被取消的。AbortController 版会有，Promise.all 永远是空——**这正是差别所在**。 */
  cancelled: string[]
  /**
   * ★ 失败之后还在跑的任务数。它们在烧 token，
   * 而没有任何人会读它们的结果。
   */
  orphaned: number
  ms: number
  raised: string | null
}

export type Job = (signal?: AbortSignal) => Promise<unknown>

/**
 * `Promise.all`。**这是 bug，不是示例。**
 *
 * 语义和 Python 的朴素 `gather` 一模一样：第一个 reject 立刻上抛，
 * **其余 Promise 继续跑到底**——因为 Promise 一旦创建就无法取消。
 *
 * ★ 而 TS 这边比 Python 更隐蔽一点：Python 至少会在进程退出时
 * 打一句 "Task was destroyed but it is still pending"。
 * JS 什么都不说。孤儿请求安安静静跑完，账单上多一笔。
 */
export async function runAll(jobs: Record<string, Job>): Promise<RunOutcome> {
  const t0 = Date.now()
  const names = Object.keys(jobs)
  const running = new Set(names)
  const ok: string[] = []
  const failed: string[] = []

  const promises = names.map((n) =>
    jobs[n]!()
      .then((v) => {
        running.delete(n)
        ok.push(n)
        return v
      })
      .catch((e) => {
        running.delete(n)
        failed.push(n)
        throw e
      }),
  )

  let raised: string | null = null
  try {
    await Promise.all(promises)
  } catch (err) {
    raised = String((err as Error)?.message ?? err)
  }

  const orphaned = running.size

  // 等它们跑完，免得测试之间互相干扰。
  // ★ 真实代码里没有这一段——所以孤儿任务会跑到进程退出。
  await Promise.allSettled(promises)

  // ★ 朴素 Promise.all 不取消任何东西（Promise 本来就不可取消），
  // 所以 cancelled 永远是空。上面那些"孤儿"不是被取消了，是**跑完了**。
  return {
    label: 'Promise.all（朴素）',
    ok, failed, cancelled: [], orphaned, ms: Date.now() - t0, raised,
  }
}

/**
 * `Promise.allSettled`。对应 Python 的 `gather(return_exceptions=True)`。
 *
 * L11 的 `fanout` 用的就是这个：一个 sub-agent 崩了不该让其余白跑。
 * 没有取消，各自跑完。
 */
export async function runSettled(jobs: Record<string, Job>): Promise<RunOutcome> {
  const t0 = Date.now()
  const names = Object.keys(jobs)
  const settled = await Promise.allSettled(names.map((n) => jobs[n]!()))

  return {
    label: 'Promise.allSettled',
    ok: names.filter((_, i) => settled[i]!.status === 'fulfilled'),
    failed: names.filter((_, i) => settled[i]!.status === 'rejected'),
    cancelled: [],
    orphaned: 0,
    ms: Date.now() - t0,
    raised: null,
  }
}

/**
 * `AbortController` + `allSettled`。对应 Python 的 `TaskGroup`。
 *
 * ★ 这是这一小节最值得记住的一处对照：
 *
 * Python 的 `TaskGroup` 是**一个语言原语**——它自己知道怎么取消子任务，
 * 因为 asyncio 的 task 本来就可以被取消。
 *
 * TS 里没有这个原语。Promise **不可取消**，所以"一个失败就全停"
 * 必须自己拼：一个 `AbortController`，加上每个 job 都老老实实
 * 接受并尊重 `signal`。
 *
 * 而"老老实实尊重 signal"是这里全部的难点：**漏一个地方，
 * 那个任务就变成孤儿，而没有任何东西会提醒你。**
 * 这也是为什么结构化并发这件事在 Python 那边是标准库，在这边是纪律。
 */
export async function runTaskGroup(jobs: Record<string, Job>): Promise<RunOutcome> {
  const t0 = Date.now()
  const names = Object.keys(jobs)
  const ctrl = new AbortController()
  const errors: string[] = []
  const cancelled: string[] = []

  const promises = names.map((n) =>
    jobs[n]!(ctrl.signal).catch((e) => {
      const msg = String((e as Error)?.message ?? e)
      // 取消导致的失败不算失败——它是我们自己要求的
      if ((e as Error)?.name === 'AbortError') {
        cancelled.push(n)
      } else {
        errors.push(`${n}: ${msg}`)
        // ★ 第一个真失败就取消其余，这是 TaskGroup 的核心语义
        ctrl.abort()
      }
      throw e
    }),
  )

  const settled = await Promise.allSettled(promises)

  return {
    label: 'AbortController + allSettled',
    ok: names.filter((_, i) => settled[i]!.status === 'fulfilled'),
    // ★ 取消不算失败——它是我们自己要求的。分开记才看得清这里干了什么。
    failed: names.filter(
      (name, i) => settled[i]!.status === 'rejected' && !cancelled.includes(name),
    ),
    cancelled,
    // 全部 await 过了，不可能有在跑的
    orphaned: 0,
    ms: Date.now() - t0,
    raised: errors.length > 0 ? `AggregateError: ${errors.join('; ')}` : null,
  }
}

// ─────────────────────────────────────────────────────────────
// 三、reducer 状态图：LangGraph 的核心，TS 里写出来更顺
// ─────────────────────────────────────────────────────────────

export type Reducer = (old: unknown, next: unknown) => unknown

export const appendReducer: Reducer = (old, next) => {
  const add = Array.isArray(next) ? next : [next]
  return [...((old as unknown[]) ?? []), ...add]
}

/**
 * LangGraph 的 `add_messages`。
 *
 * ★ 它和 `operator.add`（这里的 appendReducer）的差别是这一小节
 * 最值得记住的一处：**它按 id 去重并覆盖。**
 *
 * 为什么必须这样：人工改状态（把某条消息改掉再恢复执行）时，
 * 单纯追加会让历史里同时存在改前和改后两条。
 * 模型看到两条互相矛盾的消息，而它不会报错——它会挑一条。
 */
export const addMessages: Reducer = (old, next) => {
  const oldList = ((old as Record<string, unknown>[]) ?? []).slice()
  const nextList = (Array.isArray(next) ? next : [next]) as Record<string, unknown>[]

  const byId = new Map<unknown, number>()
  oldList.forEach((m, i) => {
    if (m && m.id !== undefined) byId.set(m.id, i)
  })

  for (const m of nextList) {
    const i = m?.id !== undefined ? byId.get(m.id) : undefined
    if (i !== undefined) oldList[i] = m
    else oldList.push(m)
  }
  return oldList
}

/**
 * 默认行为：后写盖前写。
 *
 * ★ 这是 LangGraph 里没声明 reducer 的字段的行为，
 * 也是并发扇出时最容易出事的那个默认值——
 * 两个节点同时写，一个的结果无声消失。
 */
export const lastWriteWins: Reducer = (_old, next) => next

export interface Checkpoint {
  step: number
  node: string
  state: Record<string, unknown>
  interrupt?: unknown
}

/** 节点里抛这个 = LangGraph 的 `interrupt()`。它不是错误，是控制流原语。 */
export class InterruptSignal extends Error {
  constructor(readonly value: unknown) {
    super('interrupted')
    this.name = 'InterruptSignal'
  }
}

export type NodeFn = (state: Record<string, unknown>) => Record<string, unknown>

export class StateGraph {
  private readonly nodes = new Map<string, NodeFn>()
  private readonly edges = new Map<string, string | null>()
  private readonly logs = new Map<string, Checkpoint[]>()
  private entry = ''

  constructor(readonly reducers: Record<string, Reducer>) {}

  addNode(name: string, fn: NodeFn): this {
    this.nodes.set(name, fn)
    if (!this.entry) this.entry = name
    return this
  }

  addEdge(src: string, dst: string | null): this {
    this.edges.set(src, dst)
    return this
  }

  merge(state: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
    const out = { ...state }
    for (const [k, v] of Object.entries(update)) {
      out[k] = (this.reducers[k] ?? lastWriteWins)(out[k], v)
    }
    return out
  }

  /**
   * 并发分支的合并。返回被静默覆盖的字段名。
   *
   * ★ 这个函数是整个 reducer 设计存在的理由。
   *
   * 三个节点并发跑完各自返回一份 update。没有 reducer 的字段
   * 只能后写盖前写——那意味着有节点的工作成果消失了，
   * **而且没有任何地方会记录这件事**。
   *
   * 真 LangGraph 的做法更硬：没声明 reducer 的字段被多个分支同时写，
   * 它直接报 InvalidUpdateError。
   */
  mergeParallel(
    state: Record<string, unknown>,
    updates: Record<string, unknown>[],
  ): { state: Record<string, unknown>; clobbered: string[] } {
    const out = { ...state }
    // 去重但保持顺序：这是字段名的集合，不是"覆盖发生了几次"的计数
    const clobbered = new Set<string>()
    const written = new Set<string>()

    for (const update of updates) {
      for (const [k, v] of Object.entries(update)) {
        if (!(k in this.reducers) && written.has(k)) clobbered.add(k)
        written.add(k)
        out[k] = (this.reducers[k] ?? lastWriteWins)(out[k], v)
      }
    }
    return { state: out, clobbered: [...clobbered] }
  }

  /**
   * 跑图。撞到 InterruptSignal 就存检查点并返回。
   *
   * ★ 恢复的语义是最容易漏掉的一条：
   * **检查点存在"超步"边界上，不在节点函数中间。**
   *
   * 所以恢复的时候，被中断那个节点会从函数开头**重跑一遍**——
   * interrupt 之前的代码和副作用会再执行一次。
   *
   * 这就是 LangGraph 文档里"interrupt 之前的代码必须幂等"的由来，
   * 而它和 L08 那节的幂等键是同一件事：
   * **恢复不是"接着往下走"，是"重放到断点"。**
   */
  invoke(
    state: Record<string, unknown>,
    threadId: string,
    opts: { resume?: unknown; maxSteps?: number } = {},
  ): Record<string, unknown> {
    const { resume, maxSteps = 32 } = opts
    const log = this.logs.get(threadId) ?? []
    this.logs.set(threadId, log)

    let cur: string | null = this.entry
    let step = log.length
    let cs = state

    const last = log[log.length - 1]
    if (resume !== undefined && last?.interrupt !== undefined) {
      cs = { ...last.state, _resume: resume }
      cur = last.node
    }

    while (cur && step < maxSteps) {
      const fn = this.nodes.get(cur)!
      let update: Record<string, unknown>
      try {
        update = fn(cs)
      } catch (err) {
        if (err instanceof InterruptSignal) {
          log.push({ step, node: cur, state: { ...cs }, interrupt: err.value })
          return { ...cs, __interrupt__: err.value }
        }
        throw err
      }
      cs = this.merge(cs, update)
      log.push({ step, node: cur, state: { ...cs } })
      step++
      cur = this.edges.get(cur) ?? null
    }

    return cs
  }

  /** 时间旅行。对照 L13 的重放调试。 */
  history(threadId: string): Checkpoint[] {
    return [...(this.logs.get(threadId) ?? [])]
  }
}
