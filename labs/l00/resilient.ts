/**
 * L00 · 任务三：把三个基础设施函数写出来。
 *
 * 这三个函数会陪你走完整门课，从 L05 的 agent loop 到 L19 的部署都在用它们。
 * 所以值得自己写一遍，而不是 pnpm add p-limit p-retry。
 *
 * 跑法：pnpm resilient          参考实现：pnpm resilient:sol
 */
import { createClient, getProvider } from '../shared/config.ts'
import { withTimeout, withRetry, pooled } from '../shared/resilience.ts'

const provider = getProvider()
const client = createClient(provider)

// ─────────────────────────────────────────────────────────────────────────────
// TODO 1 · withTimeout —— 给任意异步操作加超时
//
//   export async function withTimeout<R>(ms: number, fn: (signal: AbortSignal) => Promise<R>): Promise<R>
//
// 用 AbortController：创建它、setTimeout 里调 ctl.abort()、把 ctl.signal 交给 fn。
//
// 一个必须写对的细节：clearTimeout 要放在 finally 里，成功时也得清。
// 否则 Node 进程会被未触发的定时器吊住，你的脚本打印完结果还会挂几十秒才退出。
// 这个现象很多人第一次遇到时会以为是网络慢。
// ─────────────────────────────────────────────────────────────────────────────
// export async function withTimeout<R>(ms: number, fn: (signal: AbortSignal) => Promise<R>): Promise<R> {
//   const ctl = new AbortController();
//   const timer = setTimeout(() => ctl.abort(), ms);
//   try {
//     return await fn(ctl.signal);
//   } catch (error) {
//     if (error instanceof Error && error.name === 'AbortError') {
//       throw new Error('Request timed out');
//     }
//     throw error;
//   } finally {
//     clearTimeout(timer);
//   }
// }
// ─────────────────────────────────────────────────────────────────────────────
// TODO 2 · withRetry —— 指数退避 + 抖动
//
//   export async function withRetry<R>(fn: () => Promise<R>, tries = 4): Promise<R>
//
// 三个要点，缺一个这个函数就是有害的：
//
//   a) 先分类再重试。可重试的：408 409 429 500 502 503 504 529 和网络错误。
//      其余（400 401 403 上下文超限）立刻抛出——重试它们只是在烧钱。
//      SDK 抛出的错误对象上有 .status 字段可以判断。
//
//   b) 退避必须加抖动。base = 1000 * 2 ** attempt，然后再加 Math.random() * base * 0.3。
//      不加抖动的话，多个并发请求会同步退避、同步重试，形成惊群，等于没退避。
//
//   c) 最后要抛出**原始错误**，不要抛一个 new Error('重试用尽')。
//      丢掉原始错误意味着线上出问题时你完全无法定位。
// ─────────────────────────────────────────────────────────────────────────────
// const RETRYABLE = [408, 409, 429, 500, 502, 503, 504, 529];

// export async function withRetry<R>(fn: () => Promise<R>, tries = 4): Promise<R> {
//   let lastError: unknown;
  
//   for (let attempt = 0; attempt < tries; attempt++) {
//     try {
//       return await fn();
//     } catch (err) {
//       lastError = err;

//       const status = (err as { status?: number }).status;

//       if (status === void 0 || !RETRYABLE.includes(status)) {
//         throw err; 
//       }
//       if (attempt === tries - 1) break;

//       const base = 1000 * 2 ** attempt;
//       const jitter = Math.random() * base * 0.3;
//       const wait = Math.round(base + jitter);
//       console.warn(`\x1b[33m第 ${attempt + 1} 次失败，${wait}ms 后重试\x1b[0m`);
//       await new Promise((r) => setTimeout(r, wait));
//     }
//   }

//   throw lastError;
// }
// ─────────────────────────────────────────────────────────────────────────────
// TODO 3 · pooled —— 带上限的并发池
//
//   export async function pooled<T, R>(
//     items: T[], limit: number, worker: (item: T, i: number) => Promise<R>
//   ): Promise<PromiseSettledResult<R>[]>
//
// 思路：开 limit 个 runner，每个 runner 循环从共享游标取下一个任务，取完为止。
//
//   let cursor = 0
//   async function run() { while (cursor < items.length) { const i = cursor++; ... } }
//   await Promise.all(Array.from({ length: limit }, run))
//
// 两个细节值得想清楚：
//   · `const i = cursor++` 必须先取后增，否则两个 runner 会抢到同一个下标。
//     这里没有锁——靠的是 JavaScript 单线程在遇到 await 之前不会被打断。
//   · 返回 PromiseSettledResult 而不是 R[]：一个任务失败不该让整批作废。
//     这正是 agent 批量调工具时需要的语义。
// ─────────────────────────────────────────────────────────────────────────────

// export async function pooled<T, R>(
//   items: T[],
//   limit: number,
//   worker: (item: T, index: number) => Promise<R>,
// ): Promise<PromiseSettledResult<R>[]> {
//   const results: PromiseSettledResult<R>[] = new Array(items.length)
//   let cursor = 0

//   async function run(): Promise<void> {
//     while (cursor < items.length) {
//       // 先取后增。没有锁也安全，因为单线程在 await 之前不会被打断。
//       const i = cursor++
//       try {
//         results[i] = { status: 'fulfilled', value: await worker(items[i]!, i) }
//       } catch (reason) {
//         // 不吞错，也不因为一个错让整批崩——这是 agent 需要的语义
//         results[i] = { status: 'rejected', reason }
//       }
//     }
//   }

//   await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, run))
//   return results
// }

// ─────────────────────────────────────────────────────────────────────────────
// TODO 4 · 组装起来验证
//
//   并发问模型下面这五个问题，限制最多 2 路并发，每个请求 20 秒超时、失败重试 3 次。
//   在每个请求开始和结束时打印时间戳，确认它真的是「两个两个来」而不是一起冲出去。
// ─────────────────────────────────────────────────────────────────────────────

export const questions = [
  '一句话说明什么是 prompt injection。',
  '一句话说明什么是 RAG。',
  '一句话说明什么是 MCP。',
  '一句话说明什么是 tool use。',
  '一句话说明什么是 context window。',
]

const t0 = Date.now()
const stamp = () => `\x1b[2m+${String(Date.now() - t0).padStart(5)}ms\x1b[0m`

const results = await pooled(questions, 2, async (question, i) => {
  console.log(`${stamp()} 开始 #${i}`)

  const text = await withRetry(() =>
    withTimeout(20_000, async (signal) => {
      const msg = await client.messages.create(
        {
          model: provider.models.main,
          max_tokens: 256,
          system: '只用一句话回答，不要铺垫。',
          messages: [{ role: 'user', content: question }],
        },
        { signal },
      )
      return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    }),
  )

  console.log(`${stamp()} 完成 #${i}`)
  return text
})

console.log('\n─────────── 结果 ───────────\n')
results.forEach((r, i) => {
  if (r.status === 'fulfilled') {
    console.log(`#${i} ${r.value.trim()}\n`)
  } else {
    console.log(`#${i} \x1b[31m失败：${(r.reason as Error).message}\x1b[0m\n`)
  }
})

const ok = results.filter((r) => r.status === 'fulfilled').length
console.log(`成功 ${ok}/${results.length}，总耗时 ${Date.now() - t0}ms`)
