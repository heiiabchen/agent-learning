/**
 * L00 · 任务二：改成流式，让文字一个字一个字出现。
 *
 * 跑法：pnpm stream          参考实现：pnpm stream:sol
 */
import { Anthropic } from '@anthropic-ai/sdk'
import { createClient, getProvider } from '../shared/config.ts'

const provider = getProvider()
const client = createClient(provider)

// ─────────────────────────────────────────────────────────────────────────────
// TODO 1 · 用 stream: true 发请求，边收边打印
//
//   const stream = await client.messages.create({ ..., stream: true })
//   for await (const event of stream) { ... }
//
// 你会收到一串事件，关心的主要是这几种：
//   · message_start          —— 开始了，这里能拿到 input_tokens
//   · content_block_delta    —— 一小块文字，在 event.delta.text 里
//   · message_delta          —— 结束信息，output_tokens 在 event.usage 里
//   · message_stop           —— 结束
//
// 打印时用 process.stdout.write() 而不是 console.log()，
// 因为后者每次都会换行，你就看不到「一个字一个字长出来」的效果了。
//
// TypeScript 会要求你先判断 event.type 再访问 delta，照它说的做。
// ─────────────────────────────────────────────────────────────────────────────

// TODO 2 · 量一下 TTFT 和总时长
//
//   记三个时间点：请求发出、收到第一个文字块、流结束。
//   打印出「首字延迟 xxx ms，总时长 xxx ms」。
//
//   然后做这个对比实验，它是本节最有价值的一步：
//   把问题换成一个需要长回答的（比如「详细解释 HTTP/2 相比 HTTP/1.1 的改进」），
//   再跑一次。你会看到 TTFT 几乎没变，总时长翻了好几倍。
//
//   这就是流式的全部意义：它没让总时间变快一点，但把用户的等待感
//   从「总时长」缩短成了「首字延迟」。这个区别决定了 agent 产品能不能用。

// TODO 3 · 想一想（不用写代码，但本节的设计题会考这个判断）
//
//   如果这是一个 Web 应用，服务端拿到这个流之后要转发给浏览器。
//   L00 讲过的那个「缓冲区拼接」的坑会在哪一层出现？为什么用 SDK 时你没遇到？
let start = Date.now();
let ttft = null;
const stream = await client.messages.create({
  model: provider.models.main,
  max_tokens: 1000,
  messages: [
    { role: 'user', content: '详细解释 HTTP/2 相比 HTTP/1.1 的改进' }
  ],
  stream: true
});

for await (const event of stream) {
  if (event.type === 'message_start') {
    console.log('Input tokens: ', event.message.usage.input_tokens);
  } else if (event.type === 'content_block_delta') {
    if (ttft == null) {
      ttft = Date.now() - start;
      console.log(`TTFT: ${ttft / 1000}s`);
    }

    if (event.delta.type === 'thinking_delta') {
      process.stdout.write((event.delta as Anthropic.ThinkingDelta).thinking);
    } else if (event.delta.type === 'text_delta') {
      process.stdout.write((event.delta as Anthropic.TextDelta).text);
    }
  } else if (event.type === 'message_delta') {
    console.log('Output tokens: ', event.usage.output_tokens);
  } else if (event.type === 'message_stop') {
    console.log('Total time: ', (Date.now() - start) / 1000, 's');
  }
}

// 关于问题 3，我认为缓冲区拼接的坑在服务端会可能遇到。现在没有遇到是因为 sdk 内部帮忙处理了这个问题。
