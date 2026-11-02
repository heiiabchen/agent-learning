/**
 * L01 · 任务一：不用任何分词库，把 token 数「测」出来。
 *
 * 跑法：pnpm tokens          参考实现：pnpm tokens:sol
 *
 * 这个实验的真正价值不在于知道中文比英文费多少 token，
 * 而在于学会一种做法：**当你手上没有直接的测量工具时，怎么用差分把它凑出来。**
 * L12 做 evals 时你会反复用到这个思路。
 */
import { createClient, getProvider } from '../shared/config.ts'
import { withRetry, withTimeout, pooled } from '../shared/resilience.ts'

const provider = getProvider()
const client = createClient(provider)

const SAMPLES: { name: string; text: string }[] = [
  { name: '英文散文', text: 'The quick brown fox jumps over the lazy dog near the river bank.' },
  { name: '中文散文', text: '敏捷的棕色狐狸跳过了河岸边那只懒惰的狗，动作干净利落。' },
  { name: 'JSON 数据', text: '{"id":"7f3a-91c2","ts":1738291045,"score":3.14159,"ok":true}' },
  { name: 'TS 代码', text: 'export async function withTimeout<R>(ms: number, fn: () => Promise<R>) {' },
  { name: '缩进空白', text: '        \n        \n        \n        \n        \n' },
  { name: '随机 ID', text: 'a3f9c1e7-4b82-4d16-9f0a-7c2e5b8d3a61' },
]

// ─────────────────────────────────────────────────────────────────────────────
// TODO 1 · measure(text) —— 返回「把 text 作为唯一一条 user 消息发出去时」的 input_tokens
//
//   async function measure(text: string): Promise<number>
//
// 要点：
//   · max_tokens 设成 1。我们只关心 usage.input_tokens，一个输出 token 都不想多付。
//   · 用 withRetry + withTimeout 包起来（你在 L00 写的那两个，现在开始吃自己的狗粮）。
//   · usage 在 msg.usage.input_tokens 里。
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// TODO 2 · 想清楚这里为什么不能直接用 measure(text) 的返回值
//
// 你在 stream.ts 里发过一条只有「你好」两个字的消息，input_tokens 报的是 5。
// 「你好」显然不是 5 个 token——多出来的是**协议固定开销**：
// role 标记、消息边界、可能还有兼容层加的东西。它每条消息都有。
//
// 所以 measure(text) 测到的是 `固定开销 + text 的真实 token 数`，
// 而你不知道固定开销是多少（想直接测它，就得发一条空消息，但空消息会被拒）。
//
// 解法是**差分**：测两次，一次 text，一次 text 重复两遍，相减，固定开销被消掉。
//
//   net(text) = measure(text + text) − measure(text)
//
//   async function net(text: string): Promise<number>
//
// 这个技巧值得记住：**测不到绝对值的时候，去测差值。**
//
// （诚实的小字：两段拼接处的字符有可能被合并成一个 token，所以结果可能偏小 1。
//   对我们要观察的量级来说无所谓，但你应该知道自己的测量有多准。）
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// TODO 3 · 把 SAMPLES 全测一遍，打印一张表
//
// 每行给出：名称、字符数、净 token 数、字符/token 比。
// 用 pooled 限制并发（比如 2 路），别一次冲出去 12 个请求。
//
// 打印格式建议（padEnd / padStart 对齐一下，看着舒服）：
//
//   名称          字符数   token   字符/token
//   英文散文         64      14        4.57
//   中文散文         26      ...       ...
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// TODO 4 · 看着你的表回答三个问题（写在下面的注释里，本节设计题会用到）
//
//   a) 「字符/token」这一列，最高和最低差了几倍？
//      如果你的上下文预算是按**字符数**算的（下面那道改错题里就有这种代码），
//      这个倍数意味着什么？
//
//   b) 随机 ID 那一行的比值为什么那么低？这对「往上下文里塞日志、trace、UUID」
//      意味着什么？
//
//   c) 中文和英文哪个更省 token？和你的直觉一样吗？
//      （提示：注意「字符/token」和「同样意思花多少 token」是两个不同的问题，
//        上表只回答了前者。想回答后者，你得把两段**意思相同**的文本对比着测。
//        有兴趣的话加一组自己测测看。）
//
// 你的回答：
//   a)
//   b)
//   c)
// ─────────────────────────────────────────────────────────────────────────────
