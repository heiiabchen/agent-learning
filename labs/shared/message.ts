import type Anthropic from '@anthropic-ai/sdk'

/**
 * 消息与内容块的处理工具。
 *
 * 这两个函数解决的是 L02 第二节讲的两件事：
 *   · content 有 string 和 ContentBlock[] 两种形态，到处 as string 迟早要炸。
 *   · messages 必须严格交替，而违反它的通常是 bug 而不是手写。
 */

type Content = Anthropic.MessageParam['content']

/**
 * 从内容块里把纯文本拼出来。
 *
 * 只取 text 块——thinking 块和 tool_use 块都不算正文。
 * 这是全课统一的出口：凡是要「把回复当字符串用」的地方都走这里。
 */
export function textOf(content: Content | Anthropic.ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

/** 一次响应里模型要调的工具。没有工具调用时是空数组。 */
export function toolCallsOf(content: Anthropic.ContentBlock[]): Anthropic.ToolUseBlock[] {
  return content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
}

/**
 * 把相邻同角色的消息合并，保证严格交替。
 *
 * 为什么需要它：用户连点两次、前端没防抖、上一轮请求失败留下孤儿消息——
 * 这些都会产生连续同角色，而 API 对此的回应是 400，且不可重试。
 *
 * 注意这里返回新数组、不改原对象。原地改 content 会在调用方持有
 * 同一份引用时产生极难查的串话（历史被悄悄改写）。
 */
export function normalizeMessages(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []

  for (const m of msgs) {
    const last = out.at(-1)
    if (last && last.role === m.role) {
      // 合并时用空行分隔，保留两段之间的边界感，否则模型会把它们读成一句话
      out[out.length - 1] = {
        role: last.role,
        content: `${textOf(last.content)}\n\n${textOf(m.content)}`,
      }
      continue
    }
    out.push(m)
  }

  return out
}

/** 会话历史不该以 assistant 结尾（除非你在故意做 prefill，见 L03）。 */
export function endsWithUser(msgs: Anthropic.MessageParam[]): boolean {
  return msgs.at(-1)?.role === 'user'
}
