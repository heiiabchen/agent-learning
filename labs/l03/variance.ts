/**
 * L03 · 任务二：测方差，不是测「好不好」。
 *
 * 跑法：pnpm variance
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 这是本节最重要的一个练习，也是「会写 prompt」和「会做 agent」的分界线。
 *
 * 大多数人调 prompt 的方式是：改一版，跑一次，看着输出觉得「嗯这个好像好一点」。
 * 这个方法在聊天场景下勉强能用，在 agent 里完全不能用——因为 agent 的下一步
 * 依赖这一步的输出，**不稳定会被逐步放大**。十步各有 10% 的偏移，末端就没法用了。
 *
 * 所以你要的不是「这次答得好不好」，是「跑二十次它们互相之间差多少」。
 * 前者是感觉，后者是数字。
 *
 * 这个脚本一次会打 N×3 个请求（默认 8×3 = 24 个小请求，几分钱）。
 * ───────────────────────────────────────────────────────────────────────────
 */
import { createClient, getProvider } from '../shared/config.ts'
import { Ledger } from '../shared/ledger.ts'
import { textOf } from '../shared/message.ts'
import { pooled, withRetry, withTimeout } from '../shared/resilience.ts'

const provider = getProvider()
const client = createClient(provider)

/** 同一个任务的三个 prompt 版本。差异是刻意设计的，方便归因。 */
const VERSIONS = {
  v1: {
    label: 'v1 · 自然语言',
    system: '你是一个信息提取助手。请从用户给的会议记录里找出待办事项，用 JSON 数组返回，每项包含 task 和 owner 两个字段。只返回 JSON。',
  },
  v2: {
    label: 'v2 · 结构化标签',
    system: [
      '<role>信息提取助手</role>',
      '',
      '<task>从会议记录中提取待办事项</task>',
      '',
      '<output_format>',
      '只输出一个 JSON 数组，不要任何其他文字。',
      '每个元素的形状：{"task": string, "owner": string}',
      'task 用一句话概括要做的事，owner 是负责人姓名。',
      '</output_format>',
      '',
      '<rules>',
      '1. 只提取明确指派了负责人的事项。',
      '2. 没有明确负责人的讨论不要放进结果。',
      '3. 如果没有任何待办，返回空数组 []。',
      '</rules>',
    ].join('\n'),
  },
  v3: {
    label: 'v3 · 结构化 + 样例',
    system: [
      '<role>信息提取助手</role>',
      '',
      '<task>从会议记录中提取待办事项</task>',
      '',
      '<output_format>',
      '只输出一个 JSON 数组，不要任何其他文字。',
      '每个元素的形状：{"task": string, "owner": string}',
      '</output_format>',
      '',
      '<rules>',
      '1. 只提取明确指派了负责人的事项。',
      '2. 没有明确负责人的讨论不要放进结果。',
      '3. 如果没有任何待办，返回空数组 []。',
      '</rules>',
      '',
      '<examples>',
      '<example>',
      '<input>甲：报表我明天发。乙：那个 bug 挺奇怪的。</input>',
      '<output>[{"task":"发送报表","owner":"甲"}]</output>',
      '</example>',
      '<example>',
      '<input>甲：这个方案我觉得可以。乙：我也同意。</input>',
      '<output>[]</output>',
      '</example>',
      '</examples>',
    ].join('\n'),
  },
} as const

const MEETING = `
张伟：这周的登录页改版我来做，下周三之前给出可点的版本。
李娜：那我同步把埋点方案写出来，不过我下周一二在出差，可能要往后挪。
王强：数据库迁移脚本我已经写完了，等评审。
张伟：好，那评审我们放在周四。另外线上那个偶发 500 有人跟吗？
李娜：我看过日志，像是连接池打满，还没定位到根因。
`.trim()

const RUNS = Number(process.env.RUNS ?? 8)

interface Sample {
  raw: string
  parsed: { task: string; owner: string }[] | null
  parseError?: string
}

const ledger = new Ledger('L03 方差测量')

async function once(version: keyof typeof VERSIONS): Promise<Sample> {
  const v = VERSIONS[version]
  const started = performance.now()

  const res = await withRetry(() =>
    withTimeout(60_000, (signal) =>
      client.messages.create(
        {
          model: provider.models.main,
          max_tokens: 1500,
          system: v.system,
          messages: [{ role: 'user', content: MEETING }],
        },
        { signal },
      ),
    ),
  )

  ledger.record({
    label: v.label,
    id: res.id,
    model: res.model,
    usage: res.usage,
    ms: performance.now() - started,
  })

  const raw = textOf(res.content)

  // 这里故意用最朴素的解析：本任务要测的是**模型输出有多稳**，
  // 不是我的解析器有多能兜。用 shared/parse.ts 会把 prompt 的差异抹平，
  // 那就测不出 v1 和 v3 的区别了。
  try {
    const start = raw.indexOf('[')
    const end = raw.lastIndexOf(']')
    if (start === -1 || end === -1) throw new Error('找不到数组边界')
    return { raw, parsed: JSON.parse(raw.slice(start, end + 1)) }
  } catch (err) {
    return { raw, parsed: null, parseError: (err as Error).message }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 1 · parseRate(samples)
//
//   一次成功解析的比例。这是最该先看的指标，因为它完全自动、不需要标注答案。
//   v1 在这里输了的话，后面都不用比了。
// ─────────────────────────────────────────────────────────────────────────────

function parseRate(samples: Sample[]): number {
  void samples
  throw new Error('TODO 1 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 2 · countStats(samples)
//
//   提取出的条目数的分布：min / max / 众数 / 有多少次和众数不一致。
//
//   为什么看条目数而不看内容：**条目数不一致是最硬的不稳定信号**。
//   同一段输入，这次提出 3 条下次提出 5 条，说明 prompt 里「什么算待办」没定义清楚。
//   这个信号不需要标准答案就能读。
// ─────────────────────────────────────────────────────────────────────────────

interface CountStats {
  min: number
  max: number
  mode: number
  offMode: number
}

function countStats(samples: Sample[]): CountStats | null {
  void samples
  throw new Error('TODO 2 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 3 · setStability(samples)
//
//   把每次提取的 task 集合两两比较，算平均 Jaccard 相似度
//   （交集大小 / 并集大小，1 表示每次都完全一样）。
//
//   直接比字符串太严了——「发送报表」和「发报表」会被判成不同。
//   先做一层归一化：去掉空格和标点再比。这个归一化本身就是一个判断：
//   **你认为什么程度的差异算「同一件事」？** 想清楚再写。
// ─────────────────────────────────────────────────────────────────────────────

function setStability(samples: Sample[]): number | null {
  void samples
  throw new Error('TODO 3 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 4 · 把三个版本跑起来并打成一张表
//
//   每个版本跑 RUNS 次（用 pooled 控制并发，别一次打 24 个把自己限流了）。
//   输出一张表，列：版本 / 解析成功率 / 条目数范围 / 集合稳定度 / 平均输入 token / 平均耗时
//   最后打 ledger.report()。
//
//   跑完回答四个问题：
//
//     a) 哪个版本的**方差**最小？它是不是也是解析成功率最高的？
//        （这两个指标可以背离，如果背离了，说明什么？）
//
//     b) v3 比 v2 多花多少输入 token？换算成「跑一万次」是多少钱？
//        这个稳定性提升值这个价吗？
//
//     c) 把 temperature 设成 0 再跑一遍 v1。方差降了多少？
//        如果降得很少，说明不稳定的来源不是采样，而是你的 prompt 本身有歧义
//        ——这个对比能定位问题在哪一层，是本练习最值钱的一招。
//
//     d) 三个版本里，「连接池打满那个 500」这条有没有被提取出来？
//        不同版本的判断一样吗？这暴露了你的规则里哪一条没写清楚？
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`模型 ${provider.models.main} · 每个版本 ${RUNS} 次\n`)

  void once
  void parseRate
  void countStats
  void setStability
  void pooled

  throw new Error('把 TODO 4 写完，然后删掉这一行')
}

if (import.meta.filename === process.argv[1]) {
  await main()
}
