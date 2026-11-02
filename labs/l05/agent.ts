/**
 * L05 · 任务二：拿真模型跑你的 agent。
 *
 * 跑法：pnpm agent "labs 里哪个文件最长？"
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 这是第一次把所有零件接到一起：L02 的账本、L04 的工具与沙箱、L05 的循环。
 * 仓库根就是 labs/ 自己——让它读自己的代码，任务比较自然。
 *
 * 我把 runAgent 的调用写好了（用 shared/agent.ts 那版），你要做的是：
 * 换成你自己的 l05/loop.ts，然后把观察题跑出答案。
 * ───────────────────────────────────────────────────────────────────────────
 */
import type Anthropic from '@anthropic-ai/sdk'
import { runAgent, reasonText } from '../shared/agent.ts'
import { createClient, getProvider } from '../shared/config.ts'
import { Ledger } from '../shared/ledger.ts'
import { withRetry, withTimeout } from '../shared/resilience.ts'
import { standardTools } from '../shared/toolbox.ts'
import { ToolBox } from '../shared/tools.ts'

const provider = getProvider()
const client = createClient(provider)
const ROOT = new URL('..', import.meta.url).pathname

const SYSTEM = [
  '<role>你是一个代码库助手，在一个真实仓库里工作。</role>',
  '',
  '<capabilities>',
  '你可以用工具读文件、列目录、按正则搜索代码。',
  '你没有网络访问，不能安装依赖，不能修改任何文件。',
  '</capabilities>',
  '',
  '<rules>',
  '1. 回答之前先用工具查证，不要凭猜测回答关于这个仓库的问题。',
  '2. 一次可以要多个互不依赖的工具调用。',
  '3. 工具报错时读错误信息里的建议，换个做法，不要重复同样的调用。',
  '4. 拿到足够信息就直接给答案，不要为了保险再多查几遍。',
  '</rules>',
  '',
  '<giving_up>',
  // ★ 这一段是刻意加的。讲义第二节讲过：模型的训练分布里「继续尝试」的概率
  //   远高于「宣告失败」，所以「放弃」必须被明确授权，而且要给一个格式——
  //   没有格式的授权等于没有授权。
  '如果连续两次尝试同一个方向都失败，停止尝试，输出：',
  '<blocked>你尝试了什么、观察到什么、需要什么才能继续</blocked>',
  '</giving_up>',
].join('\n')

async function call(messages: Anthropic.MessageParam[], signal?: AbortSignal) {
  return withRetry(() =>
    withTimeout(90_000, (inner) =>
      client.messages.create(
        {
          model: provider.models.main,
          max_tokens: 4096,
          system: SYSTEM,
          tools: toolbox.apiTools(),
          messages,
        },
        { signal: signal ?? inner },
      ),
    ),
  )
}

const toolbox = new ToolBox(standardTools(ROOT))

async function main() {
  const task = process.argv.slice(2).join(' ') || 'labs/shared 下有哪些模块？各自大概是干什么的？'
  const ledger = new Ledger('agent')

  // Ctrl-C 走取消路径而不是直接杀进程——这样能看到部分结果和已花的钱。
  const ac = new AbortController()
  process.on('SIGINT', () => {
    console.log('\n收到中断，正在停…')
    ac.abort()
  })

  console.log(`\x1b[2m模型 ${provider.models.main} · 工具 ${toolbox.names.join('、')}\x1b[0m`)
  console.log(`\x1b[1m任务：\x1b[0m${task}\n`)

  const run = await runAgent(task, {
    toolbox,
    system: SYSTEM,
    call,
    ledger,
    maxSteps: 15,
    maxYuan: 0.5,
    maxMs: 180_000,
    signal: ac.signal,
    onStep: (e) => {
      const mark = e.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✕\x1b[0m'
      const args = JSON.stringify(e.input).slice(0, 60)
      console.log(`  ${mark} [${e.step}] ${e.toolName} ${args}  \x1b[2m${e.ms.toFixed(0)}ms\x1b[0m`)
      console.log(`      \x1b[2m${e.preview}\x1b[0m`)
    },
  })

  console.log(`\n${'─'.repeat(60)}`)
  console.log(run.text || '（没有正文）')
  console.log(`${'─'.repeat(60)}`)
  console.log(`\n结束原因：${reasonText[run.reason]}`)
  if (run.error) console.log(`异常：${run.error.message}`)
  console.log(`步数 ${run.steps} · 工具调用 ${run.trace.length} 次`)
  console.log(`\n${ledger.report()}`)

  // ───────────────────────────────────────────────────────────────────────
  // TODO · 观察题。跑几个不同的任务，然后回答：
  //
  //   a) 看账本里每一步的输入 token。它是怎么增长的？
  //      第 5 步的输入是第 1 步的多少倍？
  //      按这个速度，第 15 步会是多少？（这就是 L06 那节课的由来）
  //
  //   b) 故意问一个仓库里查不到的问题（比如「这个项目的 CI 配置在哪」，
  //      而 labs 里没有 CI 配置）。它会：
  //        · 老实说找不到
  //        · 还是一直换关键词搜下去，直到撞上限
  //      如果是后者，去掉 SYSTEM 里 <giving_up> 那段再跑一遍，对比差异。
  //
  //   c) 把 maxSteps 改成 3 跑一个复杂任务。
  //      注意 run.text 是什么——它**看起来像不像一个完整答案**？
  //      如果 reason 字段不存在，你能分辨出这是被掐断的吗？
  //
  //   d) 跑到一半按 Ctrl-C。reason 是 cancelled 吗？账本里有没有已花的钱？
  // ───────────────────────────────────────────────────────────────────────
}

await main()
