/**
 * L00 · 任务一参考实现。
 *
 * 关键点集中在两处：content 是块数组（不是字符串），system 是顶层参数（不是一条 message）。
 */
import type Anthropic from '@anthropic-ai/sdk'
import { createClient, getProvider, logUsage } from '../../shared/config.ts'

const provider = getProvider()
const client = createClient(provider)

/** 从内容块数组里把文字拼出来。这个小函数后面每节课都会用到。 */
function textOf(blocks: Anthropic.ContentBlock[]): string {
  return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

async function ask(question: string, system?: string) {
  const startedAt = Date.now()

  const msg = await client.messages.create({
    model: provider.models.main,
    max_tokens: 1024,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: question }],
  })

  const elapsed = Date.now() - startedAt
  console.log(textOf(msg.content))
  logUsage(system ? '带 system' : '无 system', msg.usage)
  console.log(`\x1b[2m耗时 ${elapsed}ms\x1b[0m\n`)

  return { tokens: msg.usage.output_tokens, elapsed }
}

const question = '什么是 AI agent？'

console.log('── 不加约束 ──')
const free = await ask(question)

console.log('── 要求一句话 ──')
const terse = await ask(question, '你只能用一句话回答，不要分点，不要铺垫。')

// 这个对比是这个练习真正的目的
const tokenDrop = Math.round((1 - terse.tokens / free.tokens) * 100)
const timeDrop = Math.round((1 - terse.elapsed / free.elapsed) * 100)
console.log(`输出 token 减少 ${tokenDrop}%，耗时减少 ${timeDrop}%。`)
console.log('两个百分比通常很接近——因为耗时几乎完全由输出 token 数决定。')
