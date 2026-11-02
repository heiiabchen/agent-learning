import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L02',
  questions: [
    {
      id: 'cachebreak',
      kind: 'choice',
      multi: true,
      prompt:
        '你的 agent 有一段 3000 token 的 system prompt，每轮都发。下面哪些做法会**破坏前缀缓存**？（多选，全对才算对）',
      options: [
        { id: 'a', label: '在 system prompt 末尾拼上当前时间戳「现在是 2026-08-25 14:32:07」' },
        { id: 'b', label: '每轮把新的用户消息追加到 messages 数组末尾' },
        { id: 'c', label: '发现历史太长了，把中间几轮对话摘要成一条，替换掉原来那几条' },
        { id: 'd', label: '把 system prompt 里两段规则的顺序调换了一下（内容一字没改）' },
        { id: 'e', label: '这一轮把 temperature 从 0 调成了 0.7' },
      ],
      correct: ['a', 'c', 'd'],
      explain: `A、C、D。

判据只有一条：**分词后的整数序列，前缀是否逐 token 完全一致。**

· **A 破坏，而且是最惨的一种。** 时间戳每轮都变，而它在 system prompt 里——也就是整个请求的最前面。这意味着从第一个 token 起就不同了，3000 token 的 system 每轮全额付费。这是真实项目里最常见的自伤操作，因为「告诉模型现在几点」听起来完全无害。要给时间就放在 messages 的最后一条，让它前面的所有内容保持稳定。

· **C 破坏。** 摘要替换是往历史**中间**动手，那个位置之后的所有 KV 全部失效。这条特别值得记住，因为 L06 做上下文压缩时你一定会想这么干——压缩省下的钱，可能还不够补上缓存失效的损失。L06 会讲怎么权衡（提示：在**边界**上压缩，而不是在中间）。

· **D 破坏。** 「内容一字没改」是个陷阱。缓存比对的是 token 序列，不是语义。换顺序 = 序列不同 = 从第一处差异往后全废。

· **B 不破坏，这正是唯一安全的操作。** 只往末尾追加，前缀天然不变。这就是「新内容只往后追加」这条纪律的全部内容。

· **E 不破坏。** temperature 是采样参数，不进入 prompt，不参与 KV 计算。它影响的是算完 logits 之后怎么挑 token。

一句话总结：**缓存的敌人是「修改」，不是「增长」。**`,
    },
    {
      id: 'latency',
      kind: 'choice',
      prompt:
        '你的 agent 一次调用要 12 秒，用户嫌慢。输入 8000 token、输出 900 token。你只能做一件事，先做哪个？',
      options: [
        { id: 'a', label: '把输入从 8000 压到 4000 token' },
        { id: 'b', label: '要求模型把回答压到 300 token 以内' },
        { id: 'c', label: '换一个更贵但据说更聪明的模型' },
        { id: 'd', label: '加上流式，让首字更早出现' },
      ],
      correct: ['b'],
      explain: `B。

用延迟模型算一下就清楚了：

    总时长 ≈ TTFT + 输出 token 数 × TPOT

TTFT 里输入那部分是 **prefill**，可以在 GPU 上高度并行，所以对输入长度是「线性但斜率很小」。输出那部分是**逐 token 串行**的——第 n 个 token 必须等第 n−1 个算完，没有任何并行空间。

所以 900 个输出 token 几乎必然是这 12 秒里的大头。把它砍到 300，总时长大概能掉到四五秒。

· **A 有用但收益小得多。** 压掉一半输入，省的是 prefill 时间——可能就一两秒。不过 A **在钱上收益很大**（输入每轮都付费），只是这道题问的是延迟。记住这个分工：**输入管钱，输出管时间。**

· **C 大概率更慢。** 更大的模型 TPOT 更高，同样的输出长度要更久。

· **D 是这里唯一的陷阱选项，也是最值得说的一个。** 流式**不会让总时长少一毫秒**——它只是把用户感知的等待从 12 秒变成 TTFT 那一两秒。这是巨大的体验改善，所以你**应该**做，但它属于「换指标」而不是「优化指标」。

题目问的是「12 秒太慢」。如果用户抱怨的是「点了之后一片空白」，答案就是 D；如果抱怨的是「整件事做完太久」，答案就是 B。**先搞清楚用户在抱怨哪个数字**，这个区分本身就是这道题真正想考的。`,
    },
    {
      id: 'streamerr',
      kind: 'choice',
      prompt:
        '流式响应已经返回了 HTTP 200，前端也渲染出了两百来字，这时流里来了一个 error 事件。下面哪种处理是对的？',
      options: [
        { id: 'a', label: '保留已渲染的内容，在后面追加一行「（生成中断）」' },
        { id: 'b', label: '当作可重试错误：丢弃已渲染的内容，整个请求重发，前端回滚' },
        { id: 'c', label: '因为 HTTP 是 200，说明请求成功了，把已有内容当完整结果入库' },
        { id: 'd', label: '立刻抛错终止，不重试——200 之后的错误说明服务端状态已经乱了' },
      ],
      correct: ['b'],
      explain: `B。

关键在于**流中断产生的是一段语义上不完整的内容**，而不完整的内容一旦进入对话历史，会污染后面每一轮。

· **A 是最诱人的错误答案。** 「已经生成的别浪费」听起来很合理，但一段被腰斩的回答留在历史里，后续每一轮模型都会以它为前提往下推。如果那半段话里有个错误的结论，这个错误会被反复引用。和 L01 那条纪律是同一件事：**宁可整轮失败，也不要把半截内容存进历史。**

· **C 把传输层的成功当成了业务层的成功。** 流式打破了「HTTP 状态码 = 请求结果」这个假设，因为头已经发出去了就改不了了。判据只能是**有没有收到 message_stop**——没收到就是失败，哪怕连 error 事件都没有（连接被中间代理掐断就是这种情况）。

· **D 的方向对了一半：确实要抛错。** 但「不重试」是错的。流中断绝大多数是瞬时故障（连接被代理掐了、服务端某个实例挂了、限流），完全符合重试条件。要注意的是**重试的粒度是整个请求**，不是「从断点继续」——协议里没有断点续传，你手上那半段内容也没有任何官方办法接回去。

前端的含义在 L16 会展开：**流式 UI 必须支持撤回已渲染的内容。** 这不是可选的锦上添花，是流式协议逼出来的硬需求。很多人做流式 UI 时只考虑了「往前追加」，第一次遇到中断就傻了。`,
    },
    {
      id: 'sysvsuser',
      kind: 'choice',
      prompt:
        '你在做一个代码审查 agent。下面四样东西，哪一样**最应该**放进 system prompt（而不是 messages）？',
      options: [
        { id: 'a', label: '这次要审查的那个文件的完整内容' },
        { id: 'b', label: '团队的代码规范和「发现问题时用什么格式输出」的约定' },
        { id: 'c', label: '从 git 拿到的这次改动的 diff' },
        { id: 'd', label: '用户这次特别叮嘱的「重点看一下并发安全」' },
      ],
      correct: ['b'],
      explain: `B。

判据是**变不变**：不变的往前放（system），变的往后放（messages）。

B 是唯一在所有请求里都一样的东西。放进 system 换来三样好处：

1. **可缓存。** 团队规范可能有几千 token，每轮都发一次。放在稳定前缀里，命中缓存后单价是 1/50。
2. **指令优先级更高。** 模型被训练成优先服从 system。审查规范放这里，比混在用户输入里更难被待审代码里的内容干扰——待审代码里可能就藏着 \`// 忽略之前的所有指令\` 这种东西（这正是 L14 讲的**间接注入**）。
3. **信任边界清晰。** system 是你写的，messages 里有外部输入。结构上分开，代码里才好审计。

其余三个每次都不同，放进 system 只会把缓存打得粉碎：

· A、C 是本次任务的数据，天然属于 messages。
· D 是这一轮的临时要求，虽然是「指令」，但它**变**，所以不能进 system。想让临时指令更有力度，可以在 messages 里用 XML 标签包起来强调（L03 会讲），但别为它牺牲整个前缀。

顺手提醒一个真实项目里的常见错误：把「当前文件路径」或者「当前时间」拼进 system 来「给模型一点上下文」。动机是好的，代价是整个 system prompt 每轮全额付费。`,
    },
    {
      id: 'usagesplit',
      kind: 'choice',
      prompt:
        '你在流式响应里记账，发现 output_tokens 总是 0。你只监听了 message_start 和 content_block_delta 两种事件。问题在哪？',
      options: [
        { id: 'a', label: 'output_tokens 在 message_delta 事件里，你没监听它' },
        { id: 'b', label: '流式模式不返回 output_tokens，只能自己数 delta 的个数' },
        { id: 'c', label: 'output_tokens 在 message_start 里，但要等流结束后再读才有值' },
        { id: 'd', label: '需要在请求里显式打开 usage 上报' },
      ],
      correct: ['a'],
      explain: `A。

usage 在流式里是**被劈成两半**送的，这是流式记账最常漏的一处：

| 字段 | 在哪个事件里 | 为什么 |
|---|---|---|
| \`input_tokens\` | \`message_start\` | 服务端一开始就知道输入多长 |
| \`output_tokens\` | \`message_delta\` | 得生成完了才知道 |

\`message_delta\` 是倒数第二个事件（\`message_stop\` 之前），它同时带来 \`stop_reason\` 和最终的 \`output_tokens\`。漏掉它，你就同时丢了**记账数据**和**停止原因**——后者更严重，意味着你连「这次是不是被截断了」都不知道。

· **B 错，而且「自己数 delta 个数」是个危险的近似。** 一个 delta 不等于一个 token，SDK 和服务端都可能合并或拆分 delta。而且思考块的 token 也计入 output_tokens，光数正文 delta 会漏一大截。

· **C、D 都是编的。**

这道题指向本节的第一条纪律：**每次调用都过账本。** 把这些边界条件封进一个模块写对一次，比在二十个地方各写一遍强。你在 \`shared/stream.ts\` 里要做的就是这件事：不管流式还是非流式，出口都给调用方一份完整的 usage。`,
    },
    {
      id: 'debug-messages',
      kind: 'debug',
      prompt:
        '这段代码在跑一个多轮对话 agent，大部分时候能用，但线上会零星报 400，而且有用户反馈「它偶尔会忘记我上一句说了什么」。找出所有问题，说明每一处会怎么表现出来。',
      lang: 'ts',
      code: `import type Anthropic from '@anthropic-ai/sdk'
import { createClient, getProvider } from '../shared/config.ts'

const client = createClient()
const provider = getProvider()

const history: Anthropic.MessageParam[] = []

export async function chat(userText: string, systemPrompt: string) {
  history.push({ role: 'user', content: userText })

  const res = await client.messages.create({
    model: provider.models.main,
    max_tokens: 2048,
    messages: [
      { role: 'user', content: systemPrompt },
      ...history,
    ],
    temperature: 0.7,
    top_p: 0.9,
  })

  const reply = res.content[0].text

  history.push({ role: 'assistant', content: reply })

  return reply
}`,
      reference: `一共六处，从最致命的往下排。

**1 · system prompt 被塞成了一条 user 消息（第 14 行），而且它导致了那个 400。**

\`messages\` 变成了 \`[user(system), user(第一句), assistant, user, …]\`——开头就是**两条连续的 user**，直接违反交替约束。第一轮必然 400。

（那为什么是「零星」报错而不是每次都错？因为如果调用方第一次进来时 history 已经不为空——比如从数据库恢复了会话——形状会变成别的样子，错误表现就不稳定了。这类「时好时坏」正是状态被错误共享的典型征兆，看第 3 条。）

正确写法是顶层参数：

    system: systemPrompt,
    messages: [...history],

顺带说，就算它侥幸不报错，也白白牺牲了缓存前缀和指令优先级——L02 第三节讲的三个好处一个都拿不到。

**2 · \`res.content[0].text\` 假设第一块就是文字（第 21 行）。**

DeepSeek V4 默认开思考模式，\`content[0]\` 很可能是 \`thinking\` 块，没有 \`.text\` 字段。拿到 \`undefined\` 之后被 push 进 history，于是历史里出现一条内容为 \`undefined\` 的 assistant 消息——**这就是用户说的「偶尔忘记我上一句说了什么」**。模型看到的历史是坏的。

    const reply = res.content.filter(b => b.type === 'text').map(b => b.text).join('')

**3 · \`history\` 是模块级的全局变量（第 8 行）。**

所有用户、所有会话共用一个数组。多用户同时用就会互相污染——A 的对话历史出现在 B 的上下文里。这既是功能 bug，也是**数据泄露**。历史必须按会话隔离，作为参数传进来或者从存储里按 sessionId 取。

**4 · 请求失败会留下孤儿 user 消息（第 10 行 vs 第 12 行）。**

先 \`push\` 再发请求，请求一抛错，那条 user 消息就永久留在 history 里了。下一轮再 push 一条 user，又是两条连续 user → 又一个 400。**而且这个错误会自我延续**：一次网络抖动之后，这个会话就永久坏掉了。

正确顺序是「先算出新状态，成功之后再提交」——你在 L01 的 conversation 练习里写过这个模式：

    const next = [...history, { role: 'user', content: userText }]
    const res = await client.messages.create({ messages: next, … })
    history.length = 0; history.push(...next, { role: 'assistant', content: reply })

**5 · 没有检查 \`stop_reason\`。**

\`max_tokens: 2048\` 撞上限的时候，一段被腰斩的回答会被静默存进历史，污染后面每一轮。至少要在 \`stop_reason === 'max_tokens'\` 时抛错。

**6 · temperature 和 top_p 同时调了（第 17、18 行）。**

不是 bug，是坏习惯。两个采样旋钮的联合效果没法在脑子里推演，出问题时也没法定位。只留 temperature。`,
      rubric: [
        '有没有认出 system 被当成 user 消息，并把它和 400 联系起来',
        '有没有认出 content[0] 在思考模式下不是 text 块——这是 L01 埋下的伏笔',
        '有没有把「偶尔忘记上一句」这个现象归因到 undefined 入库，而不是含糊地说「上下文有问题」',
        '有没有发现模块级 history 的多用户污染（这条最容易漏，也最像真实事故）',
        '有没有发现「先 push 再请求」会让一次网络抖动永久毁掉一个会话',
        '有没有注意到 stop_reason 缺失',
      ],
    },
    {
      id: 'debug-stream',
      kind: 'debug',
      prompt:
        '这是一个流式读取函数。它在短回答上工作正常，但在长回答上会出现「思考内容和正文糊在一起」，偶尔还会漏掉最后一段文字。另外记账那部分也不对。找出问题。',
      lang: 'ts',
      code: `export async function readStream(params: MessageCreateParams) {
  const stream = await client.messages.create({ ...params, stream: true })

  let text = ''
  let inputTokens = 0
  let outputTokens = 0

  for await (const event of stream) {
    if (event.type === 'message_start') {
      inputTokens = event.message.usage.input_tokens
      outputTokens = event.message.usage.output_tokens
    }

    if (event.type === 'content_block_delta') {
      text += event.delta.text
    }

    if (event.type === 'message_stop') {
      return { text, inputTokens, outputTokens }
    }
  }

  return { text, inputTokens, outputTokens }
}`,
      reference: `四处问题，第一处是那个「糊在一起」。

**1 · 忽略了 \`index\`，把所有内容块累加进了同一个字符串（第 17 行）。**

一次响应里可能有多个内容块：思考块（index 0）、正文块（index 1），带工具时还有更多。所有 delta 都 \`+=\` 到 \`text\` 上，思考内容和正文就拼成一坨了——这正是你观察到的现象。

正确做法是按 index 分桶：

    const blocks = new Map<number, { type: string; text: string }>()
    // content_block_start 时按 index 建桶，记下 type
    // content_block_delta 时往对应的桶里追加
    // 最后只取 type === 'text' 的桶拼成正文

L04 接工具之后这件事从「显示不好看」升级成「功能坏了」：两个并行工具调用的 JSON 参数会串成一个非法字符串，\`JSON.parse\` 直接炸。

**2 · \`event.delta.text\` 没有判断 delta 类型（第 17 行）。**

delta 有 \`text_delta\`、\`thinking_delta\`、\`input_json_delta\` 等多种，字段名各不相同（\`.text\` / \`.thinking\` / \`.partial_json\`）。对 \`thinking_delta\` 取 \`.text\` 得到 \`undefined\`，于是字符串里会出现一串字面量 "undefined"。

**3 · \`output_tokens\` 从 \`message_start\` 里读（第 11 行）——这是那个记账错误。**

流式开始时输出还没生成，这里恒为 0。\`output_tokens\` 在 **\`message_delta\`** 事件里，同一个事件还带 \`stop_reason\`。这段代码两个都漏了，所以它既不知道花了多少钱，也不知道有没有被截断。

**4 · 没有区分「流正常结束」和「流断了」。**

代码在 \`message_stop\` 时 return，但如果流因为异常提前结束（连接被掐、中途 error 事件），\`for await\` 会正常退出，然后走到最后那行 \`return\`——**把一段不完整的内容当成功结果返回了**。

判据必须显式化：

    let sawStop = false
    // message_stop 时置 true
    // 循环结束后：if (!sawStop) throw new Error('流未正常结束')

另外这个函数完全没处理流内的 \`error\` 事件，也没有 \`finally\` 清理。这两点加上上面四条，正是为什么本节要把它封成一个模块——这些边界条件写一次就够了，不该每次现写。`,
      rubric: [
        '有没有认出 index 分桶这个根因，而不是只说「思考内容要过滤掉」',
        '有没有认出 delta 有多种类型、字段名不同',
        '有没有指出 output_tokens 该从 message_delta 读',
        '有没有发现 message_delta 里还有 stop_reason，漏掉它意味着不知道有没有被截断',
        '有没有发现「流提前结束」会被静默当成成功——这条最少人想到',
      ],
    },
    {
      id: 'design-budget',
      kind: 'design',
      prompt:
        '设计这个功能的成本与延迟方案。给出你的数字估算过程，以及你放弃了哪些方案、为什么。',
      scenario: `你要给团队做一个「PR 审查助手」：每次有人提 PR，它读 diff 和相关文件，输出审查意见。

已知条件：
· 团队每天约 40 个 PR，平均 diff 300 行
· 团队代码规范 + 输出格式约定，约 4000 token，所有 PR 通用
· 每个 PR 通常要读 2–4 个相关文件，平均每个文件 1500 token
· 审查意见期望 400–800 token
· 用 DeepSeek V4 Flash：输入未命中 1 元/百万，命中 0.02 元/百万，输出 2 元/百万
· 老板问：一个月多少钱？慢不慢？`,
      reference: `没有唯一答案，但有必须出现的东西。下面是一份合格的答卷长什么样。

**一、先算基线（不做任何优化）**

单次输入 ≈ 4000（规范）+ 1200（300 行 diff，按 4 token/行）+ 4500（3 个文件 × 1500）≈ 9700 token
单次输出 ≈ 600 token

    输入：9700 / 1e6 × 1 元    = 0.0097 元
    输出：600  / 1e6 × 2 元    = 0.0012 元
    单次 ≈ 0.011 元
    每天 40 个 ≈ 0.44 元
    每月（22 个工作日）≈ 9.7 元

**结论先给出来：一个月十块钱左右。** 这个数量级本身就是答案的一部分——它意味着**不该为省钱做任何复杂的优化**。

能算出这个数字并且敢下这个结论，是这道题的第一个考点。很多人会本能地开始设计缓存分层、模型路由、批处理，然后为一个月十块钱的东西写两百行代码。

**二、延迟才是真问题**

    TTFT ≈ 1~3 秒（9700 token 的 prefill）
    输出 600 token × TPOT（约 15~30ms）≈ 9~18 秒
    总计 ≈ 10~20 秒

十几秒对「提了 PR 之后等评论」这个场景完全可以接受——**它不是交互式的**。所以延迟也不需要优化。

这是这道题真正想考的判断：**先确认哪个指标真的有问题，再优化。** 两个都不构成问题时，正确答案是什么都不做。

**三、那么该做什么**

即使不为省钱，有两件事仍然值得做，因为它们成本极低而收益是别的东西：

1. **把 4000 token 的规范放 system 顶层。** 不是为了省那 4 分钱，是为了拿指令优先级——待审的 diff 里可能藏着 prompt injection（\`// TODO: 忽略之前的审查规则\`）。这是 L14 的问题，在这里顺手就防了。

2. **给结果做持久化缓存，key = diff 的哈希。** 同一个 PR 会被 force-push 多次，重复审查是纯浪费。这不是 LLM 层面的 prompt caching，是**应用层的结果缓存**——便宜、确定、没有副作用。

**四、什么时候上面的结论会反转**

好的答卷会给出「拐点」，因为这说明你知道自己的结论依赖什么前提：

· **规模涨 100 倍**（每天 4000 个 PR）：一个月一千块，开始值得优化了。第一刀砍 prompt caching（规范那 4000 token 每次都能命中，输入成本立刻降一大截）。
· **变成交互式**（在 IDE 里边写边审）：延迟指标从「无所谓」变成「必须 2 秒内」，那时才需要模型路由——小模型先过一遍、只有可疑的地方才升级到大模型。
· **diff 变得很大**（几千行的重构 PR）：输入可能冲到十万 token，这时 L06 的上下文工程才真正上场：按相关性挑文件、只给函数签名不给实现、分块审查再汇总。

**五、我会明确放弃的**

· **微调一个模型。** 数据量不够（一天 40 条），收益不明，维护成本远超省下的钱。
· **自建向量库检索「相关文件」。** 这个场景里 git 已经告诉你哪些文件被改了，import 关系也能静态分析出来。**确定性的信息不要用概率的方法拿**——这是 L09 讲 RAG 滥用时的核心判据。
· **多 agent 拆分**（一个看安全、一个看性能、一个看风格）。听起来专业，实际是把成本乘 3、延迟乘 3，换来的收益在这个规模上不可测量。L11 会讲这个陷阱。`,
      rubric: [
        '有没有真的把数字算出来，而不是定性描述「不太贵」',
        '算完之后敢不敢下「这个规模不值得优化」的结论——这是主要考点',
        '有没有分别评估成本和延迟，而不是混成一个「性能」问题',
        '有没有区分「为省钱做的优化」和「为安全/正确性做的、顺手很便宜的事」',
        '有没有给出结论会反转的拐点条件（规模、交互性、输入规模）',
        '有没有明确写出放弃的方案和理由，尤其是那些听起来很专业的（微调、向量库、多 agent）',
      ],
    },
  ],
}
