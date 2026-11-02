/**
 * 验证 shared/resilience.ts 的三个函数。跑法：pnpm verify
 *
 * 注意这里一次 API 都没调——全部用「可控的假失败」来测。
 * 这很关键：你那两个 bug 本地之所以测不出来，正是因为本地网络从来不超时、
 * 从来不返回 429。真实故障等不来，就得自己造。
 *
 * 这套「注入故障 → 断言行为」的思路，就是 L12 evals 的雏形。
 */
import { pooled, withRetry, withTimeout } from '../shared/resilience.ts'

// ── 一个够用的迷你测试器，不需要装任何框架 ──────────────────────────────

let passed = 0
const failures: string[] = []

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`\x1b[32m  ✓\x1b[0m ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`\x1b[31m  ✕ ${name}\x1b[0m`)
    console.log(`\x1b[31m      ${(err as Error).message}\x1b[0m`)
  }
}

function assert(ok: boolean, msg: string) {
  if (!ok) throw new Error(msg)
}

/** 期待 fn 抛错，把错误交回来给调用方断言。 */
async function catchOf(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (e) {
    return e
  }
  throw new Error('期待抛错，但它成功返回了')
}

/**
 * 一个永不返回的假请求，行为对齐真实的 Anthropic SDK。
 *
 * 关键的一点：SDK 被 abort 时抛的是它自己造的 APIUserAbortError，
 * 你传给 ctl.abort(reason) 的那个 reason 会被原地丢掉——见 client.js：
 *
 *     if (options.signal?.aborted) { throw new Errors.APIUserAbortError() }
 *
 * 所以「我是不是超时了」这个判断不能指望从抛出来的错误里读，
 * 必须问你自己手上的那个 controller。
 */
const never = (signal?: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal?.addEventListener('abort', () => {
      const abortError = new Error('Request was aborted.')
      Object.assign(abortError, { status: undefined })
      reject(abortError)
    })
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── withTimeout ──────────────────────────────────────────────────────────

console.log('\nwithTimeout')

await test('正常返回时原样透传结果', async () => {
  const out = await withTimeout(1000, async () => 42)
  assert(out === 42, `期待 42，实际 ${out}`)
})

await test('★ 超时时抛出的是你自己的 reason，哪怕被包裹的函数把它吞了', async () => {
  const err = await catchOf(() => withTimeout(60, never))
  const msg = (err as Error).message
  assert(
    /超时|timed?\s*out/i.test(msg),
    `错误消息里认不出「超时」的意思：${JSON.stringify(msg)}。\n` +
      `      SDK 不会把你的 reason 透传出来，它抛的是自己的 "Request was aborted."。\n` +
      `      所以别指望从 catch 到的错误里读信息——问你手上的 controller：\n` +
      `      catch (err) { if (ctl.signal.aborted) throw ctl.signal.reason; throw err }`,
  )
})

await test('signal 确实被传给了被包裹的函数', async () => {
  let got: AbortSignal | null = null
  await withTimeout(1000, async (signal) => {
    got = signal
    return 1
  })
  assert(got !== null, 'fn 没有收到 signal')
})

await test('函数自身抛的错要原样抛出，不能被误判成超时', async () => {
  const boom = new Error('业务错误')
  const err = await catchOf(() =>
    withTimeout(1000, async () => {
      throw boom
    }),
  )
  assert(err === boom, `期待原样抛出业务错误，实际拿到 ${JSON.stringify((err as Error).message)}`)
})

// ── withRetry ────────────────────────────────────────────────────────────

console.log('\nwithRetry')

const fast = { tries: 3, baseMs: 5 } as const

/** 造一个「前 n 次失败，之后成功」的假请求，并记录被调用了几次。 */
function flaky(failTimes: number, error: unknown) {
  let calls = 0
  const fn = async () => {
    calls++
    if (calls <= failTimes) throw error
    return 'ok'
  }
  return { fn, calls: () => calls }
}

await test('成功时只调用一次', async () => {
  const f = flaky(0, null)
  await withRetry(f.fn, fast)
  assert(f.calls() === 1, `期待 1 次，实际 ${f.calls()} 次`)
})

await test('429 会重试', async () => {
  const f = flaky(1, { status: 429 })
  const out = await withRetry(f.fn, fast)
  assert(out === 'ok' && f.calls() === 2, `期待重试后成功，实际调用 ${f.calls()} 次`)
})

await test('400 立刻放弃，不浪费钱', async () => {
  const f = flaky(99, { status: 400 })
  await catchOf(() => withRetry(f.fn, fast))
  assert(f.calls() === 1, `期待 1 次就放弃，实际 ${f.calls()} 次`)
})

await test('★ 没有 status 的网络层错误必须重试（这是你原来的 bug）', async () => {
  const f = flaky(1, new Error('socket hang up'))
  const out = await withRetry(f.fn, fast)
  assert(
    out === 'ok' && f.calls() === 2,
    `期待重试后成功，实际只调用了 ${f.calls()} 次。` +
      `超时、连接重置、DNS 失败都没有 status，它们恰恰是最该重试的一类。`,
  )
})

await test('重试用尽后抛的是原始错误，不是包装过的', async () => {
  const original = { status: 503, message: '我是原始错误' }
  const f = flaky(99, original)
  const err = await catchOf(() => withRetry(f.fn, fast))
  assert(err === original, '期待原样抛出最后一次的错误，丢掉它线上就无法定位了')
})

await test('退避真的在等，而且次数对得上', async () => {
  const f = flaky(99, { status: 503 })
  const t = Date.now()
  await catchOf(() => withRetry(f.fn, { tries: 3, baseMs: 40 }))
  const spent = Date.now() - t
  assert(f.calls() === 3, `期待尝试 3 次，实际 ${f.calls()} 次`)
  // 两次等待：40 + 80 = 120ms 起步，抖动只会更多
  assert(spent >= 110, `总耗时 ${spent}ms，看起来没有真的退避`)
})

await test('★★ 组合场景：withRetry 包住 withTimeout 时，超时能被重试', async () => {
  let calls = 0
  const out = await withRetry(async () => {
    calls++
    // 第一次故意超时，第二次正常
    return withTimeout(60, calls === 1 ? never : async () => 'ok')
  }, fast)
  assert(
    out === 'ok' && calls === 2,
    `期待超时后重试并成功，实际调用 ${calls} 次。` +
      `这是最值钱的一条：两个函数单独看都对，组合起来才暴露问题。`,
  )
})

// ── pooled ───────────────────────────────────────────────────────────────

console.log('\npooled')

await test('并发确实被限制住了', async () => {
  let running = 0
  let peak = 0
  await pooled([1, 2, 3, 4, 5, 6], 2, async () => {
    running++
    peak = Math.max(peak, running)
    await sleep(20)
    running--
    return null
  })
  assert(peak === 2, `并发峰值应该是 2，实际是 ${peak}`)
})

await test('结果顺序和输入一致，不受完成先后影响', async () => {
  // 故意让后面的任务先完成
  const out = await pooled([50, 10, 30], 3, async (ms, i) => {
    await sleep(ms)
    return i
  })
  const values = out.map((r) => (r.status === 'fulfilled' ? r.value : -1))
  assert(
    JSON.stringify(values) === '[0,1,2]',
    `期待 [0,1,2]，实际 ${JSON.stringify(values)}。结果必须按输入下标放，不能按完成顺序 push。`,
  )
})

await test('一个失败不影响其余，失败信息被保留', async () => {
  const out = await pooled([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('第二个坏了')
    return n
  })
  assert(out.filter((r) => r.status === 'fulfilled').length === 2, '应该有 2 个成功')
  assert(out[1]?.status === 'rejected', '第二个应该是 rejected 而不是被吞掉')
})

// ── 收尾 ─────────────────────────────────────────────────────────────────

const total = passed + failures.length
console.log(`\n${'─'.repeat(46)}`)
if (failures.length === 0) {
  console.log(`\x1b[32m全绿 ${passed}/${total}。\x1b[0m 回聊天说一声，我们进 L01。`)
} else {
  console.log(`\x1b[31m${failures.length}/${total} 没过：\x1b[0m`)
  failures.forEach((f) => console.log(`  · ${f}`))
  console.log('\n带 ★ 的两条是你这次真正的 bug，其余是防止改出新问题的护栏。')
  process.exitCode = 1
}
