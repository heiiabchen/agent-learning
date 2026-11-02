/**
 * 跨课复用的三个基础设施函数。从 L05 的 agent loop 到 L19 的部署都在用。
 *
 * withTimeout —— 给任意异步操作加超时，超时后抛出你自己的 reason
 * withRetry   —— 分类过的指数退避 + 抖动重试
 * pooled      —— 带上限的并发池，返回 PromiseSettledResult 保证单个失败不拖垮整批
 *
 * 两个容易写错、且本地测不出来的地方，已经用 l00/verify.ts 钉住了：
 *
 *   · 没有 status 的错误（超时、连接重置、DNS 失败）属于网络层瞬时故障，要重试。
 *   · 「是不是我超时了」只能问自己的 controller。Anthropic SDK 被 abort 时
 *     会抛它自己的 APIUserAbortError，你传给 abort() 的 reason 会被原地丢掉。
 *
 * 改动这个文件之后跑一次 `pnpm verify`。
 */

export interface RetryOptions {
  /** 总共尝试几次（含第一次），默认 4。 */
  tries?: number
  /** 退避基数，第 n 次失败后等 baseMs * 2^n 再加抖动，默认 1000。测试时传个很小的值。 */
  baseMs?: number
}

/** 可重试的 HTTP 状态码。没有 status 的错误另行判断，见 withRetry。 */
export const RETRIABLE_STATUS = [408, 409, 429, 500, 502, 503, 504, 529]

export async function withTimeout<R>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<R>,
): Promise<R> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('请求超时')), ms);

  try {
    return await fn(ctl.signal);
  } catch (err) {
    if (ctl.signal.aborted) throw ctl.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function withRetry<R>(fn: () => Promise<R>, opts: RetryOptions = {}): Promise<R> {
  let lastError: unknown;
  const { tries = 4, baseMs = 1000 } = opts;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number }).status;
      if (status !== void 0 && !RETRIABLE_STATUS.includes(status)) {
        throw err;
      }
      if (attempt === tries - 1) break;
      const base = baseMs * 2 ** attempt;
      const jitter = Math.random() * base * 0.3;
      const wait = Math.round(base + jitter);
      console.warn(`\x1b[33m第 ${attempt + 1} 次失败，${wait}ms 后重试\x1b[0m`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

export async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i]!, i) };
      } catch (error) {
        results[i] = { status: 'rejected', reason: error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
