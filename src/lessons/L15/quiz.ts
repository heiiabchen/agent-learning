import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L15',
  questions: [
    {
      id: 'total-input',
      kind: 'choice',
      prompt:
        '你的成本面板只读 Anthropic 响应里的 `usage.input_tokens`。上线 prompt caching 的那天，面板显示输入 token 从 200,050 掉到 50，你据此在周报里写"缓存让输入成本降了 99.97%"。真实的降幅是多少，以及这个误差的**方向**为什么比大小更值得担心？',
      options: [
        {
          id: 'a',
          label: '真实降幅约 90%。误差偏乐观，会让你以为缓存已经榨干了，从而停止继续优化',
        },
        { id: 'b', label: '真实降幅约 99.97%，面板是对的，只是没算输出 token' },
        {
          id: 'c',
          label: '真实降幅约 99.97%，但因为缓存写入收 1.25 倍，实际只有 75% 左右',
        },
        {
          id: 'd',
          label: '真实降幅无法确定，因为 `input_tokens` 的语义在文档里没有定义',
        },
      ],
      correct: ['a'],
      explain: `A。

\`usage.input_tokens\` 在 Anthropic 不是总输入。官方原话：

> "\`input_tokens\`: Number of input tokens which were not read from or used to create a cache (that is, tokens after the last cache breakpoint)."
>
> "Important: \`input_tokens\` does NOT represent all input tokens — only the portion after your last cache breakpoint."
>
> "\`total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens\`"

所以那 200,000 个 token 没有消失，它们搬到了 \`cache_read_input_tokens\` 里，**并且仍然要付钱**——按 0.1 倍。

| | 上线前 | 上线后 |
|---|---|---|
| 计费的等效 token | 200,050 | 200,000 × 0.1 + 50 = 20,050 |
| 降幅 | — | **约 90%** |

**方向为什么更要紧。** 99.97% 和 90% 都是"大幅下降"，如果只关心结论，这个错误好像无所谓。

但它偏的方向是**乐观**：它让你以为只剩 0.03% 的空间，而真实情况是还有 10 个百分点没动。于是你把"再看看缓存"从待办里划掉了。

**一个偏乐观的监控比没有监控更危险，因为它会让你停止查。** 这一节所有判定器的设计都在防这件事——包括 \`UNDETERMINABLE\` 这个状态的存在。

C 错在它把倍率算在了错的基数上；D 错在这件事文档里说得非常明确，还专门加了一句 "Important"。`,
    },
    {
      id: 'write-only',
      kind: 'choice',
      prompt:
        '一个 agent 连续跑了五步，每一步的 `usage` 都是 `cache_read_input_tokens: 0`、`cache_creation_input_tokens: 575`。五次请求全部返回 200，日志里没有任何异常。这个 agent 的缓存配置处于什么状态？',
      options: [
        { id: 'a', label: '缓存正在预热。前几次只写不读是正常的，跑久一点就会开始命中' },
        {
          id: 'b',
          label: '断点挂在一个每次都变的块后面。它永远不会命中，而且比不开缓存贵 25%',
        },
        { id: 'c', label: '前缀低于最低可缓存长度，所以写入被静默丢弃了' },
        { id: 'd', label: '缓存条目在 5 分钟 TTL 内过期了，应该换成 1 小时缓存' },
      ],
      correct: ['b'],
      explain: `B。

**单独一次 \`WRITE_ONLY\` 是正常的冷启动。连续五次是 bug**，而这个区别只能靠跨请求的状态判断，看单次响应看不出来。

原因是 lookback 的真实语义。官方的 "Common mistake" 一节：

> "1. Cache writes happen only at your breakpoint. … **The system does not write entries for any earlier position.**"
>
> "2. Cache reads look backward for entries that prior requests wrote. … **It is looking for prior writes, not for stable content.**"

所以如果断点挂在一个每次都变的块上（经典例子是 system prompt 末尾的时间戳），每次的前缀哈希都不同；往回找的时候，更早的位置**从来没有被写过**，于是找不到任何东西。

官方对这个场景的结论：

> "No cache hit. **You pay for a fresh cache write on every request and never get a read.**"

代价是 **+25%**——每次付 1.25 倍写入费，一次读都没拿到。**比不开缓存还贵。**

**为什么 A 特别值得警惕**：它是最自然的解释，而且"预热"这个词让人觉得只要等就好。但这里没有什么在预热，状态是稳定的——稳定地亏。

C 可以排除：低于门槛时两个字段**都是 0**（官方给的判定法），而这里写入是 575。
D 可以排除：TTL 过期会让你看到偶发的 \`MISS\`，不是稳定的 \`WRITE_ONLY\`；而且过期的前提是曾经写成功过又被读到过。

顺带，自动缓存救不了这个：它的策略是"挂在最后一个可缓存的块上"，在这个结构里最后一块正是时间戳。官方明说 "Automatic caching hits the same trap"。`,
    },
    {
      id: 'undeterminable',
      kind: 'choice',
      prompt:
        '你的成本审计跑在一个通过 Anthropic 的 OpenAI 兼容端点发出的请求上。响应的 `usage` 只有 `prompt_tokens` 和 `completion_tokens`，没有任何缓存字段（官方文档对 `usage.prompt_tokens_details` 的描述是 "Always empty"）。审计工具应该把这一步判成什么，为什么这个选择比另外两个都重要？',
      options: [
        {
          id: 'a',
          label: '判 `MISS`。没有命中的证据就应当按未命中计，这样报出的省钱比例是保守的',
        },
        {
          id: 'b',
          label:
            '判 `UNDETERMINABLE`，并让整份报告拒绝给出省钱比例。判 `MISS` 会让你去优化一个观测不到的东西，判 `HIT` 则是编数',
        },
        {
          id: 'c',
          label: '判 `HIT`。兼容层底下还是同一个模型，缓存照样在跑，只是不报字段',
        },
        {
          id: 'd',
          label: '用响应时间兜底：TTFT 明显低于基线就判 `HIT`，否则判 `MISS`',
        },
      ],
      correct: ['b'],
      explain: `B。

这是本节唯一一个"新增的状态"，而它的必要性来自厂商文档的一句总纲：

> "**Most unsupported fields are silently ignored rather than producing errors.**"
> "Prompt caching is not supported, but it is supported in the Anthropic SDKs"

加上响应字段表里那两行 **"Always empty"**。\`cached_tokens\` 是唯一的信号，而它被抹掉了——**"缓存生效了吗"这个问题在响应里没有答案。**

三个选择的后果：

| 判成 | 后果 |
|---|---|
| \`MISS\` | 报出偏悲观但**看起来精确**的数字，然后你会去优化一个观测不到的东西 |
| \`HIT\` | 报出偏乐观的数字，纯属编造 |
| \`UNDETERMINABLE\` | 这一段账拒绝结论 |

**A 的迷惑性最大**，因为"保守估计"在工程上通常是个好习惯。但这里的问题不是数字偏哪边，是**它给了你一个不该有的确定性**。一个标着"未命中"的步骤会让你去查断点、查前缀、查 TTL——而真实情况是这条端点上你查不了，唯一的行动是换 SDK。

**C 甚至可能事实上是对的**（缓存可能真的在跑），但这不影响判定：审计工具报的不是"发生了什么"，是"我能证明什么"。

**D 是这一节明确反对的做法**，而且它错得有两层。近的一层是噪声大于效应。远的一层在第八节：OpenAI 在自己的文档里把"提交候选 prompt 并观察是否命中"写成了一个需要防御的攻击手段（cache-hit probing）。**你不该把监控建在一条你同时要防御的信道上。**

代价是报告里会出现"这部分证明不了"。这个代价必须付——一个成本审计的价值全在于它的数字能不能被反驳。`,
    },
    {
      id: 'divergence-gap',
      kind: 'choice',
      prompt:
        '审计报告里同一个步骤出现了两个看起来矛盾的数字：归因那节说"分歧只有 64 token"，而判定那节说这一步"写入 575 token、读到 0"。差了将近十倍。下面哪个说法是对的？',
      options: [
        {
          id: 'a',
          label: '归因算错了。分歧点之前逐字节相同，所以那 567 个 token 应该命中，实际损失就是 64',
        },
        {
          id: 'b',
          label:
            '两个数都对。分歧点之前虽然逐字节相同，但那些位置从来没被写过，所以往回找也找不到——"分歧小"不等于"损失小"',
        },
        { id: 'c', label: '判定算错了。写入不可能超过分歧点之后的 token 数' },
        {
          id: 'd',
          label: '两个数量的单位不同：一个是 block 数，一个是 token 数，不该直接比',
        },
      ],
      correct: ['b'],
      explain: `B。这个缺口不是 bug，它就是 lookback 语义的直接后果，而且是这一节最容易被忽略的一条推论。

分歧点之前那 567 个 token 确实逐字节相同。按"缓存应该能复用相同前缀"的直觉，这部分该命中。

但系统不这么工作：

> "**It is looking for prior writes, not for stable content.**"

写入只发生在断点上。断点在那个会变的块上，所以**更早的位置从来没有被写过**，往回走 20 格也找不到任何条目。于是每次请求都在全额重写 575 token。

**这条推论值得单独记住：**

> "我只改了一个字节"是一句关于**分歧**的陈述，不是一句关于**损失**的陈述。

损失的大小取决于断点在哪、之前写过什么，和你改了多少内容没有直接关系。

**所以审计报告必须分别报这两个数，而且要说明它们为什么不一致。** 定位数字（64）告诉你去改哪里，判定数字（575）告诉你在亏多少。把前者当损失估算，你会觉得"就这么点儿，先不管了"。

A 的问题正是在这儿：它用直觉替换了官方语义。C 的问题是它把因果搞反了——写入量等于断点处的前缀长度，和分歧点无关。`,
    },
    {
      id: 'lookback-offbyone',
      kind: 'choice',
      prompt:
        '按 Anthropic 官方给的三轮例子：Turn 1 有 10 个 block、断点在 10；Turn 2 有 15 个、断点在 15，命中于位置 10；Turn 3 有 35 个、断点在 35。Turn 3 的结果是什么，原因是什么？',
      options: [
        { id: 'a', label: '命中于位置 15，因为 Turn 2 在那里写过条目' },
        {
          id: 'b',
          label: '未命中。窗口是 35 往回 20 格即 16–35，而 Turn 2 的条目在位置 15——差一格',
        },
        { id: 'c', label: '命中于位置 10，因为那是最早写入的稳定条目' },
        { id: 'd', label: '未命中，因为一个请求最多只能有 4 个断点，35 个 block 超限了' },
      ],
      correct: ['b'],
      explain: `B。官方原话：

> "Turn 3: 35 blocks, breakpoint on block 35. The system checks 20 positions (blocks 35 through 16) and finds nothing. **The turn-2 entry at block 15 is one position outside the window, so there is no cache hit.**"

**差一格。** 窗口是 20 格，且"断点自己算第一个"——所以从 35 往回只覆盖到 16。

这个例子的实用价值在于它揭示了一个静默的失效模式：**一轮里塞很多 block，会把上一轮的缓存条目挤出窗口。** 而这件事没有任何信号，你只会看到命中率莫名下降。

官方对此有一条缓解措施，而它正好解释了为什么并行工具调用是安全的：

> "a run of consecutive \`tool_use\` blocks counts as one position, and so does a run of consecutive \`tool_result\` blocks, so a turn with many parallel tool calls doesn't push the previous request's entry out of the window on its own."

所以 L07 讲的并行工具调用在缓存这一层被特意照顾过了：**八个并行调用算两个位置，不是十六个。**

D 提到的 4 个断点上限是真的（"You can define up to 4 cache breakpoints"，而且自动缓存会占用其中一个名额），但它和 block 总数无关——35 个 block 配 1 个断点完全合法。`,
    },
    {
      id: 'router-baseline',
      kind: 'choice',
      prompt:
        '同事说："我给我们的 agent 做了个模型路由器，线上跑了一周，成本降了 40%。" 在你追问之前，这句话包含多少关于这个路由器价值的信息？',
      options: [
        {
          id: 'a',
          label: '相当多。40% 是个大数字，说明分类器的准确率不低',
        },
        {
          id: 'b',
          label:
            '接近于零。把全部请求扔给便宜模型能省 90% 且不需要路由器；没有质量轴的成本数字无法评价路由',
        },
        { id: 'c', label: '取决于两个模型的价差。价差大于 3 倍时 40% 才有意义' },
        {
          id: 'd',
          label: '相当多，只要他同时确认了缓存命中率没有下降',
        },
      ],
      correct: ['b'],
      explain: `B。

**成本和质量必须一起报，否则数字没有意义。** RouteLLM 论文把这件事说得很直接：

> "Neither of the above metrics alone is sufficient to capture the quality-cost trade-off in routing. For example, a trivial router that always sends queries to the strong model achieves a perfect PGR = 1 but with no cost savings."

而对称的那一端更要紧：一个"总是选便宜模型"的路由器能省下几乎全部差价，**而它根本不是路由器。**

更麻烦的是，"比随机好"这件事不是自动成立的。论文 Table 3（GSM8K，只用 Arena 数据训练）：

| 方法 | APGR | 相对随机基线 |
|---|---|---|
| Random（基线） | 0.497 | +0% |
| BERT | 0.438 | **−11.8%** |
| Causal LLM | 0.461 | **−7.3%** |
| Matrix Factorization | 0.4746 | **−4.5%** |
| SW Ranking | 0.4753 | **−4.3%** |

**四个路由器全部比抛硬币差。** 论文自己的话：在 MMLU 上 "all routers perform poorly at the level of the random router when trained only on Arena dataset"。

APGR 低于 0.5 意味着路由器提供了**负信息量**——它系统性地把难题送给弱模型、把易题送给强模型。这就是为什么交付物的路由表里有一行叫"反着判"：它让"路由器可以是负价值的"有了一个具体数字。

**D 的方向是对的**（缓存命中率确实是必须问的第二个问题，见下一题），但它漏了第一个问题：**降 40% 的同时质量掉了多少。** 光有缓存没掉，不能说明路由器比随机强。

还要注意"不牺牲质量"这个说法本身。论文里它的定义是 CPT(50%)，翻译成绝对分数是 MT Bench 95%、MMLU 92%、**GSM8K 87%**——最后一个是掉了 13 个百分点。**它是一个相对指标的名字，不是一个事实陈述。**`,
    },
    {
      id: 'routing-vs-caching',
      kind: 'choice',
      prompt:
        '你的 agent 每个请求带一段 8,000 token 的稳定共享前缀（系统约定 + 工具定义 + 项目背景），任务本身大约 1,000 token 输入 / 200 token 输出。你上了一个**完美**的模型路由器——它从不错分。相比"全部请求都用强模型"，成本会怎么变？',
      options: [
        { id: 'a', label: '显著下降。完美路由零重试，把简单任务都送去了便宜模型' },
        {
          id: 'b',
          label: '大幅上升到 2 倍以上。基线全程不换模型，前缀写一次读 N−1 次；每次切模型都要重写整段 8,000 token 前缀',
        },
        { id: 'c', label: '基本不变。前缀成本对两种策略是一样的，抵消掉了' },
        {
          id: 'd',
          label: '略微下降。缓存打断的损失存在，但会被单价差抵掉大部分',
        },
      ],
      correct: ['b'],
      explain: `B。lab 里这一格是 **215.7%**。

四种路由器（完美 / 随机 / 反着判 / 全用便宜的）**全部输给基线**，最差的到 400.6%。

原因不在路由决策的质量上。前缀是任务本身的 8 倍，而基线**全程不换模型**，它的前缀写一次、读九十九次（0.1 倍）。任何切模型的策略每切一次就要重写一遍整段前缀（1.25 倍）。**这笔钱盖过了单价差。**

cache diagnostics 里有一个专门的类型叫 \`model_changed\`，官方解释只有一句：**"The cache is per-model."**

厂商自己也承认这个矛盾。Microsoft Foundry 的 model router 文档：

> "Cache behavior depends on which underlying model the router selects for a given request. … **caching benefits apply only when the same model handles consecutive requests with overlapping prompt prefixes.**"

它提供了 session affinity 作为缓解，同时明确说这个机制 "doesn't inspect cache state, guarantee a cache hit, or adaptively switch models based on cache savings"。

**把对照组放在一起看，结论才完整。** 同一批路由器，去掉共享前缀：

| | 无前缀 | 8,000 token 前缀 |
|---|---|---|
| 完美路由（每请求） | **68.6%** | **215.7%** |
| 完美路由（每 10 个） | 88.6% | 208.2% |

**同一个路由器，同一批任务，一个省 31% 一个亏 116%。** 唯一的变量是前缀和任务的比例。

而决策粒度这个旋钮在两张表里**方向相反**：有前缀时粘性路由有帮助（215.7% → 208.2%），无前缀时它反而变差（68.6% → 88.6%）——因为粘性是拿准确率换缓存命中，没有前缀可缓存时这笔交易是纯亏。

所以结论不是"路由能省 N 倍"，也不是"路由没用"，而是：**先量一下前缀和任务的比例，再决定要不要路由、在什么粒度上路由。** 这个比例是你自己系统的数。

顺带还有一层：便宜模型的**最低可缓存门槛更高**。Haiku 4.5 是 4,096，Opus 5 是 512——高八倍。一段 1,500 token 的 system prompt 在 Opus 5 上能进缓存，在 Haiku 上进不去，而且不报错。`,
    },
    {
      id: 'ratelimit-429',
      kind: 'choice',
      prompt:
        '你的客户端对所有 429 做指数退避重试，最多 8 次。某天线上开始出现大量请求最终失败，日志显示每个失败请求都完整退避了 8 次、总耗时接近两分钟。响应体里有 `error.details.error_code: "enforced_spend_limit_reached"`。问题出在哪？',
      options: [
        {
          id: 'a',
          label: '退避次数不够。应该提高到 16 次并加长上限',
        },
        {
          id: 'b',
          label:
            '这类 429 不带 `retry-after`，重试到访问恢复前一律失败。三种"超限"里只有真的限流该重试，而失败的请求还会计入限额',
        },
        { id: 'c', label: '退避的抖动没做好，多个客户端在同一时刻重试导致惊群' },
        { id: 'd', label: '应该改成固定间隔重试，指数退避在花费上限场景下太激进' },
      ],
      correct: ['b'],
      explain: `B。官方原话：

> "The error type is \`rate_limit_error\`, the same as for a rate limit, but **the response has no \`retry-after\` header. Retrying, including the SDKs' automatic retries, fails until access resumes.**"
>
> "On the Messages API, \`error.details.error_code\` is \`enforced_spend_limit_reached\`. Use it to tell this response apart from a rate limit."

**三种"超限"在 HTTP 层面长得不一样，而只有一种该重试：**

| 情况 | 状态码 | \`retry-after\` | 该重试吗 |
|---|---|---|---|
| 真的限流 | 429 | 有 | **该** |
| 触发强制花费上限 | 429 | **没有** | 不该 |
| 触发你自己设的上限 | 400 | — | 不该 |

**对一个"花费上限已到"的错误做指数退避，你会在那里转到超时。它永远不会成功**，而且每次尝试都在消耗限额：

> "Note that unsuccessful requests contribute to your per-minute limit, so continuously resending a request won't work."

所以 A 的方向完全相反——加重试次数只会让浪费更久。

**这题还有个更深的层次值得一起记。** 即使是真的限流，光有退避也不够。OpenAI 区分了两种 429，其中一种和你的用量无关：

> "A \`slow_down\` error can occur even when your traffic is within its requests-per-minute and tokens-per-minute limits. **It reflects how quickly traffic increased, not whether you exhausted those limits.**"
>
> "once your traffic reaches 1 million input tokens per minute (TPM), **increase it by no more than 50% every 15 minutes.**"

Anthropic 管这个叫 acceleration limit。**一个只有退避没有限速的客户端，在 acceleration limit 面前会永远退避下去**——因为退避结束后它又会一次性放出全部积压请求。

你需要的是**限速器 + 退避**，而限速器要用 token bucket（连续补充）而不是固定窗口。官方提示："a rate of 60 RPM might be enforced as **1 request per second**"——一个按固定窗口实现的限速器会在每分钟开头突发 60 个，然后吃一串 429，**而它自己的计数器显示"没超"。**`,
    },
    {
      id: 'append-truncate',
      kind: 'debug',
      prompt:
        '下面这个前缀分歧定位函数有**两个**bug，而它们的表现都是"报告一切正常"。找出来，并说明各自会在什么真实场景下触发。提示：想一想 `tools` / `system` / `messages` 这三层的顺序意味着什么，以及 L06 的上下文压缩会对 `messages` 做什么。',
      lang: 'ts',
      code: `type Layer = 'tools' | 'system' | 'messages'

/** 返回两个请求最早分歧的层与位置；完全一致时返回 null。 */
function firstDivergence(prev: Req, curr: Req): Divergence | null {
  if (prev.model !== curr.model) {
    return { type: 'model_changed', at: null }
  }

  for (const layer of ['tools', 'system', 'messages'] as Layer[]) {
    const a = prev[layer].map(canonicalJson)
    const b = curr[layer].map(canonicalJson)

    // 逐个比到较短的那个为止；前面都一样就认为没有分歧
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) {
        return { type: \`\${layer}_changed\`, at: i }
      }
    }
  }

  return null
}`,
      reference: `两个 bug 都出在那句注释上——"前面都一样就认为没有分歧"。

## Bug 1：把上游层的追加当成良性

循环比到 \`Math.min(a.length, b.length)\` 就停，所以**在末尾追加**永远返回 \`null\`。

对 \`messages\` 这是对的。对 \`tools\` 和 \`system\` 是**错的**，原因是层级规则：

> "Cache prefixes are created in the following order: \`tools\`, \`system\`, then \`messages\`. … **Changes at each level invalidate that level and all subsequent levels.**"

\`tools\` 排在最前面。**给工具清单加一个工具，会把后面所有内容的位置全部位移**，于是 \`system\` 和 \`messages\` 两层的断点哈希全变。

**触发场景**：给 agent 加一个新工具——这是最常见的功能迭代。整个缓存失效，而定位工具说"一切正常"，于是你会去查 TTL、查请求节奏，查一个不存在的问题。

**修法**：给内部比较加一个"追加是否良性"的开关，只有最后一层（\`messages\`）为真。

    function firstDiffIndex(a: string[], b: string[], appendIsBenign: boolean): number | null {
      const n = Math.min(a.length, b.length)
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
      if (a.length === b.length) return null
      // 长度变了：只有最后一层的「追加」才是良性的
      if (appendIsBenign && b.length > a.length) return null
      return n
    }


## Bug 2：把截断当成追加

\`Math.min\` 对两个方向的长度变化一视同仁，所以 \`messages\` **变短**也返回 \`null\`。

但追加和截断对缓存的后果**完全相反**：追加保留前缀，截断改变了前缀的结束位置。

**触发场景**：上下文压缩（L06）。它会截断历史，而这是 agent 里最频繁的结构性变化。一个把两者等同处理的定位工具，会把**每一次上下文压缩都报成"一切正常"**。

**修法**：上面那段代码里的 \`b.length > a.length\` 已经覆盖了——只有变长才是良性，变短返回 \`n\`（也就是较短那个的长度，正是截断点）。

## 两个 bug 的共同点

它们都不抛异常，而且**错的方向都是"报告正常"**。

这是这一节反复出现的形状：静默失败的工具比没有工具更糟，因为它会让你停止查。verify 里有四条测试专门盯这两个 bug（工具末尾加一个、system 末尾加一块、messages 末尾追加、messages 被截断），其中三条期望"报出分歧"，一条期望 \`null\`。

**顺带一个不算 bug 但值得注意的地方**：这个实现依赖 \`canonicalJson\` 而不是 \`JSON.stringify\`，这是对的。官方提示：

> "Verify that the keys in your \`tool_use\` content blocks have **stable ordering as some languages (for example, Swift, Go) randomize key order during JSON conversion, breaking caches**."

如果这里用 \`JSON.stringify\`，那么两个语义相同但键序不同的工具定义会被报成 \`tools_changed\`——一个**假阳性**。假阳性的危害小于假阴性，但它同样会浪费你的时间。`,
      rubric: [
        '找出"上游层的追加被当成良性"这个 bug，并指出它的根据是 tools → system → messages 的层级失效规则',
        '找出"截断被当成追加"这个 bug，并把它和 L06 的上下文压缩联系起来',
        '说清两个 bug 的表现都是"报告一切正常"，也就是假阴性',
        '修法里区分了"只有最后一层允许把追加当良性"，而不是一律允许或一律禁止',
        '（加分）注意到截断点恰好是较短那个数组的长度',
        '（加分）注意到依赖 canonicalJson 而非 JSON.stringify 是刻意的，并说得出理由',
      ],
    },
    {
      id: 'audit-design',
      kind: 'design',
      prompt:
        '你要给团队做一个成本审计工具，接手的人会拿它的输出去跟财务对账、去说服 leader 批预算。设计它的输出规格：它报哪些数字、拒绝报哪些、怎么处理观测不到的部分。重点解释你的取舍，而不是罗列字段。',
      scenario:
        '现状：服务同时走三条端点（Anthropic 直连、一条 OpenAI 兼容层、DeepSeek），其中兼容层不返回任何缓存字段。上个月有人用"缓存让我们省了 60%"申请过预算，后来发现那个数字是拿 usage.input_tokens 的降幅算的。',
      reference: `这题没有唯一答案，但有几个能区分"想过"和"没想过"的点。

## 一、最重要的取舍：宁可少报，不可编数

题干里那个 60% 就是编出来的——不是有人故意造假，是**工具给了一个它没资格给的确定性**。

所以第一条规格：**任何无法证明的部分，报告必须显式拒绝给出结论**，而不是用一个"保守估计"填上。

这意味着输出里要有一个类似这样的段落：

    拒绝报出省钱比例。
    有步骤走的端点不返回缓存字段，这段账里有一部分不可观测。
    把不可观测当成「没命中」会给你一个偏悲观但看起来精确的数字，
    当成「命中」则偏乐观。两种都是编。所以这里什么都不报。


**为什么"保守估计"也不行**：偏悲观的数字同样会驱动错的行动。一个标着"未命中"的步骤会让接手的人去查断点、查 TTL——而真实情况是这条端点上查不了，唯一的行动是换 SDK。

## 二、三个基线，而不是一个

只报"我们花了 X 元"没有信息量。至少要三条：

| 基线 | 它回答什么 |
|---|---|
| 完全不开缓存 | **这才是分母。** 省钱比例只有相对它才有意义 |
| 实际付了 | 现状 |
| 理论最优（前缀写一次，其余全命中） | 还剩多少空间 |

lab 里这三个数是 0.004966 / 0.005541 / 0.002855——**实付是"不开缓存"的 111.5%**。也就是说这个配置下开缓存是**亏的**，而只有并排放着才看得出来。

只报"实付 vs 理论最优"会漏掉这个结论；只报"实付"什么都看不出来。

## 三、把"你的 bug"和"过期了"分开

这是 Anthropic cache diagnostics 那张 2×2 表的核心价值：

| 诊断 | 缓存读 | 行动 |
|---|---|---|
| \`null\` | 低 | 缓存过期了 → **改 TTL 或改节奏** |
| \`*_changed\` | 低 | **你的 bug** → 按 type 改代码 |

**把这两类混成一句"缓存命中率低"，是缓存调优最常见的浪费时间方式。** 一份只报命中率的报告，会让人在"该改代码"的时候去调 TTL。

## 四、分歧数字和损失数字必须分开报，并解释为什么不一致

这是最容易漏的一条。报告里会同时出现"分歧 64 token"和"写入 575 token"，差近十倍。

如果不解释，接手的人会认为工具算错了，然后不再信任它的其他数字。所以报告里要有一段说明：写入只发生在断点上，分歧点之前的位置从来没被写过，所以"分歧小"不等于"损失小"。

## 五、跨请求的状态：单次响应看不出的东西

有些结论只能跨请求得出：

- **连续两次 \`WRITE_ONLY\`** = 断点挂在会变的块后面（单次是正常冷启动）
- 命中率随 QPS 上升而下降 = 可能撞上了"15 RPM 溢出"那条机制

第一条尤其值得做成一条显式告警，因为它的代价是 +25% 而表现是 100% 成功。

## 六、退出码

如果它要进 CI，就得能让 CI 变红。lab 里的那份报告在发现问题时退出码是 1。

一个只会打印漂亮表格但永远退出 0 的工具，实际上只是个报表。

## 七、几个值得主动声明的边界

一份给人看的报告应该说清自己的适用范围：

- 这些单价是哪天抓的（定价会变，而 GPT-5.6 开始收缓存写入费就是个例子）
- 隔离边界是 workspace 还是 organization（多租户的话这条直接影响能不能共享前缀）
- 哪些结论是引用、哪些是算术推导。第五节那张重试盈亏表就是纯算术，**没有厂商测过**

**一句话总结这个规格**：这个工具的价值不在于它报的数字好看，在于**它报的每个数字都能被反驳**。做不到的地方，它闭嘴。`,
      rubric: [
        '把"拒绝报出无法证明的数字"作为首要原则，而不是用保守估计填补',
        '说得出为什么"偏悲观的估计"也不行（它会驱动错的行动）',
        '至少三条基线，且明确"完全不开缓存"才是分母',
        '把 *_changed（改代码）和 unavailable/过期（改 TTL 或节奏）分成两类行动',
        '分歧 token 数和实际损失 token 数分开报，并解释不一致的原因',
        '有跨请求的判断，至少包括"连续 WRITE_ONLY"',
        '（加分）能进 CI，发现问题时退出码非 0',
        '（加分）主动声明适用边界：单价抓取日期、隔离粒度、哪些结论是推导而非实测',
      ],
    },
  ],
}
