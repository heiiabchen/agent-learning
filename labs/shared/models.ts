/**
 * 查一下当前账号能用哪些模型 ID。
 *
 * 为什么需要这个脚本：模型 ID 会退役，任何教程里写死的 ID 都有过期的一天。
 * 与其信文档，不如直接问 API。跑法：pnpm models
 *
 * 注意这里走的是 DeepSeek 的 OpenAI 兼容端点（/models），
 * 因为 Anthropic 协议里没有「列模型」这个接口——兼容层不等于功能等同，这是第一个例子。
 */

const key = process.env.DEEPSEEK_API_KEY
if (!key) throw new Error('缺少 DEEPSEEK_API_KEY，先把 .env 配好')

const res = await fetch('https://api.deepseek.com/models', {
  headers: { Authorization: `Bearer ${key}` },
})

if (!res.ok) {
  console.error(`查询失败 HTTP ${res.status}：${await res.text()}`)
  process.exit(1)
}

const body = (await res.json()) as { data?: { id: string }[] }
const ids = body.data?.map((m) => m.id) ?? []

console.log('\n当前可用的模型 ID：\n')
for (const id of ids) console.log(`  · ${id}`)
console.log('\n把你要用的那个写进 .env 的 DEEPSEEK_MODEL_MAIN。\n')
