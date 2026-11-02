/**
 * L00 · 任务一：发出你人生第一个 LLM 请求。
 *
 * 跑法：pnpm hello          卡住十分钟以上再看：pnpm hello:sol
 */
import { createClient, getProvider, logUsage } from '../shared/config.ts'

const provider = getProvider()
const client = createClient(provider)

console.log(`provider=${provider.name} model=${provider.models.main}\n`)

// ─────────────────────────────────────────────────────────────────────────────
// TODO 1 · 发一个请求，把模型的回答打印出来
//
//   const msg = await client.messages.create({ ... })
//
// 三个必填字段：model、max_tokens、messages。
//
// · max_tokens 是「这次最多生成多少 token」，不是「上下文上限」。
//   这是新手最常混淆的一对概念，混淆的后果是回答被硬生生截断。
//
// · messages 是数组，每项形如 { role: 'user' | 'assistant', content: '...' }。
//   注意没有 role: 'system'——system prompt 在 Anthropic 协议里是顶层参数，见 TODO 3。
//
// · 返回的 msg.content 是「内容块数组」而不是字符串。为什么不直接给字符串？
//   因为一条回复里可能同时包含文字块和工具调用块（L04 会大量用到）。
//   现在你只需要挑出 type === 'text' 的那一块。TypeScript 会强迫你处理这件事，
//   这是好事——它在提醒你回复的形状比你想的复杂。
// ─────────────────────────────────────────────────────────────────────────────
console.time('Without System');
const msg = await client.messages.create({
  model: provider.models.main,
  max_tokens: 1000,
  messages: [
    { role: 'user', content: '你好' }
  ]
});
console.timeEnd('Without System');
const response = msg.content.find(item => item.type === 'text')?.text;
console.log('LLM Response: ', response);
// TODO 2 · 打印这次调用消耗的 token
//
//   msg.usage 里有 input_tokens 和 output_tokens，直接 logUsage('hello', msg.usage)。
//   从第一天就看账是这门课的规矩。到 L15 你会发现，会算账的人和不会算账的人
//   做出的架构决策完全不同。
logUsage('hello LLM', msg.usage);

// TODO 3 · 加一个 system prompt，要求它「只用一句话回答」，然后重新跑一次
//
//   system 是 create() 的顶层参数：{ system: '...', messages: [...] }。
//
//   跑完对比两件事：输出 token 数、以及整个请求的墙上时间（用 Date.now() 前后夹一下）。
//   你应该会看到输出 token 少了很多，而耗时也跟着明显下降——这就是 L00 里那条
//   「输出长度主导总时长」的结论，你自己实测一遍会比读十遍都记得牢。
console.time('With System');
const msgWithSystem = await client.messages.create({
  model: provider.models.main,
  max_tokens: 1000,
  messages: [
    { role: 'user', content: '你好' }
  ],
  system: '只用一句话回答'
});
console.timeEnd('With System');
const responseWithSystem = msgWithSystem.content.find(item => item.type === 'text')?.text;
console.log('LLM Response with System: ', responseWithSystem);
logUsage('hello LLM with System', msgWithSystem.usage);