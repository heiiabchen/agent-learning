/**
 * L04 · 任务三：跑通完整的四回合往返。
 *
 * 跑法：pnpm roundtrip
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 这个任务做完，你手上就有了 agent loop 的**全部零件**。
 * L05 只是把它包进一个 while，加上终止条件和预算控制。
 *
 * 所以这里的目标不是「让它工作」，是**把每一步的形状看清楚**。
 * 我在关键位置留了打印，跑起来之后一定要看输出，不要只看最后的答案。
 * ───────────────────────────────────────────────────────────────────────────
 */
import type Anthropic from '@anthropic-ai/sdk'
import { createClient, getProvider } from '../shared/config.ts'
import { Ledger } from '../shared/ledger.ts'
import { textOf } from '../shared/message.ts'
import { withRetry, withTimeout } from '../shared/resilience.ts'
import { standardTools } from '../shared/toolbox.ts'
import { ToolBox, toolResultMessage, toolUsesOf } from '../shared/tools.ts'

const provider = getProvider()
const client = createClient(provider)
const ledger = new Ledger('L04 往返')

/** 把 labs/ 自己当仓库用——读自己的代码，任务比较自然。 */
const ROOT = new URL('..', import.meta.url).pathname

const SYSTEM = [
  '<role>你是一个代码库助手，在一个真实仓库里工作。</role>',
  '',
  '<capabilities>',
  '你可以用工具读文件、列目录、按正则搜索代码。',
  '你没有网络访问，不能安装依赖，不能修改任何文件。',
  '需要仓库外的信息时，直接说你拿不到，不要猜。',
  '</capabilities>',
  '',
  '<rules>',
  '1. 回答之前先用工具查证，不要凭猜测回答关于这个仓库的问题。',
  '2. 一次可以要多个互不依赖的工具调用。',
  '3. 工具报错时，读错误信息里的建议，换个做法，不要重复同样的调用。',
  '</rules>',
].join('\n')

// ─────────────────────────────────────────────────────────────────────────────
// TODO 1 · 走完一次完整往返
//
//   步骤：
//     ① 带 tools 发第一次请求
//     ② 检查 stop_reason === 'tool_use'，取出 tool_use 块
//     ③ 执行（用 Promise.all 保序！），把 assistant 原样 push 回历史，
//        再 push 一条带全部 tool_result 的 user 消息
//     ④ 再发一次请求，拿最终答案
//
//   ★ 三个必须做对的地方（讲义第一节的 Pitfall）：
//     · assistant 那条要**原样**放回去，包含 tool_use 块
//       （丢掉的话模型看不到自己要求过什么，会重新要求 → 死循环）
//     · tool_result 用 user 角色
//     · tool_use_id 精确对应
//
//   每一步都打印出来看：模型要了哪些工具、参数是什么、结果多长。
// ─────────────────────────────────────────────────────────────────────────────

async function ask(
  toolbox: ToolBox,
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.Message> {
  const started = performance.now()
  const res = await withRetry(() =>
    withTimeout(90_000, (signal) =>
      client.messages.create(
        {
          model: provider.models.main,
          max_tokens: 4096,
          system: SYSTEM,
          tools: toolbox.apiTools(),
          messages,
        },
        { signal },
      ),
    ),
  )
  ledger.record({
    label: `第 ${messages.filter((m) => m.role === 'user').length} 轮`,
    id: res.id,
    model: res.model,
    usage: res.usage,
    ms: performance.now() - started,
  })
  return res
}

export async function roundtrip(question: string): Promise<string> {
  const toolbox = new ToolBox(standardTools(ROOT))
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }]

  void ask
  void toolUsesOf
  void toolResultMessage
  void textOf
  void messages

  throw new Error('把 TODO 1 写完，然后删掉这一行')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 2 · 三个问题，跑完回答
//
//   问题一（会触发单个工具调用）：
//     「labs 目录下有哪些子目录？」
//
//   问题二（应该会触发并行调用）：
//     「shared/ledger.ts 和 shared/stream.ts 各自导出了什么？」
//
//   问题三（会触发一次工具报错）：
//     「读一下 shared/nonexistent.ts」
//
//   跑完回答：
//     a) 问题二里，模型是一次要了两个工具，还是分两轮各要一个？
//        如果是分两轮，你的 prompt 里哪句话没说服它并行？
//
//     b) 问题三里，模型收到 isError 之后做了什么？
//        它有没有照着错误信息里的建议去 list_dir？
//        如果没有，把错误信息改得更明确一点再试——**这就是在调工具的 prompt**。
//
//     c) 看账本。第二轮的输入 token 比第一轮多多少？
//        多出来的是什么？（提示：工具结果全都进了历史）
//        按这个增长速度，十轮之后输入会是多少？这就是 L06 那节课的由来。
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`模型 ${provider.models.main} · 仓库根 ${ROOT}\n`)
  void roundtrip
  throw new Error('把 TODO 2 写完，然后删掉这一行')
}

if (import.meta.filename === process.argv[1]) {
  await main()
}
