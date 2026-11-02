import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L13',
  questions: [
    {
      id: 'tokens',
      kind: 'choice',
      prompt:
        '你的 agent 接了 Anthropic 和 OpenAI 两家。埋点代码把两家的 `usage.input_tokens` 都映射到 `gen_ai.usage.input_tokens`。上线后 OpenAI 那一路的 token 统计和账单完全吻合，Anthropic 那一路的统计只有账单的千分之几。代码里哪里错了？',
      options: [
        { id: 'a', label: 'Anthropic 的埋点漏掉了流式响应最后那个 usage 事件，所以大部分调用没被统计' },
        {
          id: 'b',
          label:
            'Anthropic 的 `input_tokens` 不含缓存 token，要加上 `cache_read_input_tokens` 和 `cache_creation_input_tokens`；OpenAI 的已经含了',
        },
        { id: 'c', label: 'Anthropic 按字符计费而 OpenAI 按 token 计费，需要做单位换算' },
        { id: 'd', label: '两家的 tokenizer 不同，需要用各自的 tokenizer 重新算一遍' },
      ],
      correct: ['b'],
      explain: `B。这是整节课最容易错一个数量级的地方，而它的成因只有一句话：**同一个字段名，两家相反的语义。**

    Anthropic：input_tokens 不含缓存
               总输入 = input_tokens + cache_read + cache_creation

    OpenAI：   input_tokens 已含缓存
               普通输入 = input_tokens − cached − cache_write

拿一次具体调用：10 万 token 的系统 prompt 命中缓存，用户消息 50 token。

| 提供方 | 原始 \`input_tokens\` | 照字段名映射 | 正确值 |
|---|---|---|---|
| Anthropic | 50 | **50** | 100,050 |
| OpenAI | 100,050 | 100,050 | 100,050 |

**少算 2001 倍。** 而"千分之几"这个症状正好对上——缓存命中率越高，少算得越厉害。

Anthropic 自己的字段定义写的是"不是从缓存读取、也不是用于创建缓存的输入 token 数（即最后一个缓存断点之后的 token）"，文档里还专门有一句提醒：\`input_tokens\` 在你有效使用缓存时"通常会**远小于**你的总输入"。

★ 而这个 bug 最坏的性质是**它在 OpenAI 上完全正确**。所以你在一家上写好、测好、上线，然后接第二家的时候复制粘贴——没有任何一层会报错。

OTel 规范把这个不对称显式编码进去了，这是最好的印证：

· Anthropic 提供方页注 \`[27]\`：input_tokens **excludes** cached tokens，注 \`[22]\`/\`[23]\` 都用了 **MUST be added**
· OpenAI 提供方页注 \`[24]\`：cache_read 对应 \`cached_tokens\`，**不加**
· 通用注册表：input_tokens "SHOULD include all types of input tokens, **including cached tokens**"

也就是说约定的口径是"input_tokens 是全量总和"——和 OpenAI 的原始字段一致，和 Anthropic 的正好相反。

---

为什么其他几个不对：

**A** 描述的是一个真实存在的 bug 类型，但症状不对。漏掉 usage 事件会让统计**按调用次数**成比例地少，不会产生"千分之几"这种和缓存命中率相关的比例。

**C** 两家都按 token 计费。

**D** tokenizer 不同是真的，但你不该自己算——你该用响应里返回的 usage。而且自己算会得到一个**接近但不等于**账单的数字，那是另一类坑（规范还专门规定过：有的提供方同时报"计费单位"和"消耗单位"，埋点 SHOULD 报**计费**的那个，否则你的数字永远对不上发票）。`,
    },

    {
      id: 'metrics',
      kind: 'choice',
      prompt:
        '你按一篇广为流传的最佳实践做了成本看板：数据源用 `gen_ai.client.token.usage` 这个 metric，按 `gen_ai.token.type` 拆成输入和输出，乘上单价。span 只留给调试用。这个看板上线后，报出的成本一直比账单高一大截。最根本的原因是什么？',
      options: [
        { id: 'a', label: 'metric 有聚合窗口，边界上的数据会被重复计入，需要改用 delta temporality' },
        { id: 'b', label: '埋点在双发过渡期，新旧属性名都在发，导致重复计数' },
        {
          id: 'c',
          label:
            '`gen_ai.token.type` 只有 `input` 和 `output` 两个取值，没有缓存维度——所以 1x / 0.1x / 1.25x / 2x 的 token 全塌进同一个桶',
        },
        { id: 'd', label: '看板漏算了推理 token，而推理 token 按输出价计费' },
      ],
      correct: ['c'],
      explain: `C。这道题的价值在于：那条建议听起来完全合理，而推翻它只需要读一个枚举的取值列表。

**\`gen_ai.token.type\` 只有两个 well-known 取值：\`input\` 和 \`output\`。** 没有 cache 维度，没有 reasoning 维度，没有 modality 维度。

而 \`gen_ai.client.token.usage\` 这个 metric 的**全部**属性是：

    gen_ai.operation.name
    gen_ai.provider.name
    gen_ai.request.model
    gen_ai.response.model
    gen_ai.token.type
    server.address
    server.port

**没有缓存维度。** 于是这些价格全部塌进 \`token.type=input\` 一个桶：

| token 类别 | 倍率 |
|---|---|
| 普通输入 | 1x |
| 缓存读 | 0.1x（两个新模型上 0.025x） |
| 5 分钟档缓存写 | 1.25x |
| 1 小时档缓存写 | 2x |

跨度 20 倍，算上 0.025x 那两个模型是 **80 倍**。

而"高估"这个方向也对得上：缓存读通常是长上下文 agent 里 token 量最大的一类，而它是最便宜的（0.1x）。把它按 1x 算，自然高估。

    普通输入        200 tok  ×1      $0.000600
    缓存读       180000 tok  ×0.1    $0.054000
    5 分钟写       4000 tok  ×1.25   $0.015000
    1 小时写      16000 tok  ×2      $0.096000
    输出            800 tok          $0.012000
    ────────────────────────────────────────────
    从 span 算                       $0.177600
    从 metric 算                     $0.612600   高估 245%

★ 所以正确的分工和常见建议是**反的**：

    metrics → 量、延迟、loop 长度 SLO
    spans   → 成本

所有缓存和推理的拆分**只存在于 span 属性上**。要用 metric 算成本，你得自己定义一个带缓存维度的 metric。

---

**B 是个真实的坑，只是不是这道题的答案。** 双发确实会让花费翻倍（而两个键各自的值都是对的），但它的表现是**整数倍**——通常正好两倍。缓存维度缺失的偏差比例取决于缓存命中率，不是整数倍。

**D 方向反了。** 推理 token **已经包含在** \`output_tokens\` 里，规范明写了 \`gen_ai.usage.reasoning.output_tokens\` "SHOULD be included in \`gen_ai.usage.output_tokens\`"——所以**不要再加**。再加一次才会高估。

**A** 是 metric 的真实问题类型，但它产生的是抖动和边界误差，不是稳定的系统性高估。`,
    },

    {
      id: 'sampling',
      kind: 'choice',
      prompt:
        '你的 agent 平均运行 3 分钟，失败率 4%。为了控制遥测成本，你从 head 采样切到了 tail 采样，并写了一条正好瞄着你要的东西的策略：`keep = (失败) || (轮数 ≥ 20)`。配置其余部分用的都是默认值。上线一周后，你打开采样后的数据集，发现失败的 trace 一条都没有。为什么？',
      options: [
        { id: 'a', label: '策略写错了，应该用 `&&` 而不是 `||`' },
        {
          id: 'b',
          label:
            '`decision_wait` 默认 30 秒，而运行要跑 3 分钟——决策是在第 30 秒做的，那时候它还没失败，也还没跑到 20 轮',
        },
        { id: 'c', label: 'tail 采样要求 span 上有 `sampling.priority` 属性，没有的话策略不生效' },
        { id: 'd', label: '失败的 trace 因为带了 error 状态，被 collector 的错误处理管道单独吞掉了' },
      ],
      correct: ['b'],
      explain: `B。**策略写得再对也没用，因为它是在错误的时刻被执行的。**

\`tailsamplingprocessor\` 的 \`decision_wait\` 默认值是 **30 秒**。而 agent 运行经常是几分钟。于是：

    第 0 秒    运行开始
    第 30 秒   ★ 采样决策在这里做出
               此刻：还没失败（ok）、轮数才 4（< 20）
               → keep = false → 丢掉
    第 180 秒  运行失败，跑到了第 31 轮
               → 但决策早就做完了

一条瞄准失败的策略，失败召回率 **0%**。

而这个数字不需要想象——用 1000 次运行（5% 失败、失败的跑 200 秒）跑一遍就是：

    tail 采样（全用默认值）：
      策略写的是「失败的留下，跑够 20 轮的留下」——正好瞄着我们要的那些。
      留下 0 条，失败召回 0%

★ 而这一整套默认值里还有两个同类的坑，都值得一起记：

| 配置项 | 默认值 | 对 agent 的后果 |
|---|---|---|
| \`decision_wait\` | **30s** | 就是这道题 |
| \`num_traces\` | 50,000 | 环形缓冲，满了**淘汰最老的**——而长 agent trace 永远是最老的 |
| \`sampled_cache_size\` | **0** | 缓存不启用，见下 |

最后那个的后果最脏，README 自己写了：

> After the sampling decision is removed from the buffer, it's as if this component has never seen the trace before: the late spans are buffered for \`decision_wait\` seconds and **a new sampling decision is made**.

也就是说一次长运行的**前半段被留下、后半段被丢掉**。而你打开它的时候，看到的是一条**看起来完整的、只是有点短的** trace。

修法：\`decision_wait\` 调到超过你的 p99 运行时长；\`sampled_cache_size\` / \`non_sampled_cache_size\` 设成远大于 \`num_traces\`；同时监控采样器自己的四个指标（\`trace_dropped_too_early\`、\`trace_removal_age\`、\`late_span_age\`、\`decision_timer_latency\`）。

---

顺带说一下你切走的那个 head 采样为什么也不行，因为理由更根本：**它在运行开始前做决定**，那时候没有任何可依据的信息。所以 10% 的采样率保留 10% 的成功，**也保留 10% 的失败**。

★ 推论：你的调试语料不只是生产的一个小样本，它是一个**有偏的**样本，而且偏的方向正好是错的。head 采样的"统计无偏"恰恰是它在这里的缺陷。

而这一节还有一个出路，它绕过了整个采样问题：\`gen_ai.invoke_agent.inference_calls\` 和 \`.tool_calls\` 是 **Histogram 而不是 Counter**，所以 **p99 的 loop 长度可以在不存任何一条 trace 的前提下报警**。那是所有采样缺陷唯一影响不到的数字。`,
    },

    {
      id: 'wall',
      kind: 'choice',
      prompt:
        '你的 collector 日志里偶尔出现 `dropped_items: 4137`，报错是 `received message after decompression larger than max (4194305 vs. 4194304)`。丢掉的那批里包含大量和 LLM 无关的普通 span。你检查了 SDK 配置，`send_batch_max_size` 是 512，而这批只有 41 个 span。哪个判断是对的？',
      options: [
        {
          id: 'a',
          label:
            'batch processor 按条数分批而不按字节，所以少数几个大 LLM span 就能让整批超过 OTLP 的 4 MiB 上限——而那是不可重试错误，整批一起丢',
        },
        { id: 'b', label: 'OTel SDK 默认在 128 字符处截断属性值，这批里有属性绕过了截断' },
        { id: 'c', label: '压缩后体积反而变大了，应该关掉 gzip' },
        { id: 'd', label: '`send_batch_max_size` 设得太大，降到 50 以下就能解决' },
      ],
      correct: ['a'],
      explain: `A。这是一条三段组合，每一段单独看都很合理。

**第一段**，OTLP 规范（1.11.0）：

> The server implementations typically enforce a default incoming message size limit of **4 MiB**... If the limit is exceeded, the gRPC server implementations MUST report a \`RESOURCE_EXHAUSTED\` code as a **non-retryable** error.

注意 **non-retryable**。丢了就是丢了。

**第二段**，一个 LLM span 的输入可以合法地达到 ~3.2 MB。推导：整个 message 数组必须塞得进上下文窗口，多数框架在 80% 处压缩，所以 1M token 上下文下上限约是 \`0.8 × 1M\` ≈ 3.2 MB 的 JSON。

**第三段**，也是关键的一段：**batch processor 按条数分批，不按字节。** \`send_batch_max_size\` 数的是 span **个数**，没有字节上限。

组合起来：两个各自完全合法的 2.4 MB span 打进同一批，4.8 MiB，超限，**整批作为不可重试错误被丢掉**——连带那 39 个毫不相关的 span。

而报错里那个大小值得看一眼：\`4194305 vs. 4194304\`，**恰好是上限 + 1 字节**。

★ 这道墙最坏的性质：**它系统性地杀掉最有价值的 trace。** 最胖的 span 来自最长、最复杂、最该被看的那次运行。

修法两层：分批按字节算；单条就超限的必须**内容外部化**（存对象存储，span 上只留引用）——分批救不了它。

---

**B 是个流传很广的错误，而它值得单独破掉。**

"OTel 默认在 128 字符处截断"把**数量**限制看成了**长度**限制：

| 配置项 | 默认值 | 它限的是 |
|---|---|---|
| \`AttributeCountLimit\` | **128** | 每条记录最多几个**属性** |
| \`AttributeValueLengthLimit\` | **Infinity** | 单个属性值的**长度** |

（\`EventCountLimit\`、\`LinkCountLimit\`、\`AttributePerEventCountLimit\`、\`AttributePerLinkCountLimit\` 也都是 128——所以那个数字确实到处都是，只是它从来不是长度。）

所以一个 3 MB 的 prompt 字符串**不会被截断**。它一路顺畅地穿过 SDK，撞到 4 MiB 那道墙上。SDK 那一层不会救你。

**C** 方向反了。gzip 会让体积变小，而那个报错说的是"decompression **after**"——解压之后的大小超限。关掉压缩只会让它更早触发。

**D** 降低 \`send_batch_max_size\` 能**降低概率**，但不能解决问题：只要单个 span 能到 3.2 MB，两个就超限，而 \`send_batch_max_size=2\` 显然不可行。这是"按条数"这个维度本身错了，不是它的取值错了。`,
    },

    {
      id: 'replay',
      kind: 'choice',
      prompt:
        '一次线上事故后，你想复现它。你的 trace 完整、采样率 100%、内容采集也开了。你搭了一套重放：把录下来的模型响应和工具响应按顺序回放。同事问"这样能保证和线上一模一样吗"。最准确的回答是什么？',
      options: [
        { id: 'a', label: '能，只要 temperature 设成 0 并且用同一个模型版本' },
        { id: 'b', label: '能，只要额外记录并回放 seed 和 system_fingerprint' },
        {
          id: 'c',
          label:
            '不能——你重放的是一份录音而不是一次计算。模型输出被当成 oracle 回放，并没有重新执行模型',
        },
        { id: 'd', label: '不能，因为浮点运算在 GPU 上本身就不确定，所以这件事没有解' },
      ],
      correct: ['c'],
      explain: `C。这个区分不是吹毛求疵——它决定了这个工具能回答什么问题。

所有声称 "deterministic replay for agents" 的工具做的都是**把模型输出缓存下来当成 oracle 再发一遍**。你重放的是一份**录音**，不是一次**计算**。

于是：

| 问题 | 能答吗 |
|---|---|
| 当时到底发生了什么 | 能，但 trace 也能告诉你 |
| 换个模型会怎样 | **不能**，那是两个不同的 prompt |
| 如果当时那个工具返回的是别的，后面会怎样 | **能，而且只有 hybrid 模式能** |

★ 最后那个才是事故当下你真正想问的问题。**hybrid 模式**——重放录音直到第一次分叉，然后转真实调用——是这个领域里最值得学的一个设计。纯重放只能告诉你已经发生过的事。

---

**A 和 B 都基于同一个错误假设：模型可以被重新执行成同样的结果。**

A 不成立的原因，Thinking Machines 的 *Defeating Nondeterminism in LLM Inference* 讲得最清楚。真正的机制是**缺少批不变性**：kernel 的逐元素数值会随 batch size 变化，而 batch size 由**服务器负载**决定。

★ 从你的角度看，**其他并发用户不是这个系统的输入，而是它的一个不确定属性**。

实测：Qwen3-235B，temperature 0，同一个 prompt，1000 次 × 1000 token → **80 个不同的完成**，第一次分叉在**第 103 个 token**。

B 有一个更硬的障碍：**\`seed\` 在 OpenAI 的 Responses API 里不存在**——而 Responses 正是 OpenAI Agents SDK 的底座。\`openai-node\` issue #1613 至今 open，2026-07-06 被官方账号打上了 \`upstream\` 标签。那个标签就是答案：不是 SDK 的缺口，是 API 的缺口。

而 \`system_fingerprint\` 的用法多数人理解反了：它**不保证**指纹相同就输出相同，它保证的是**指纹变了你就该预期漂移**。它是一个**漂移检测信号，不是确定性契约**。

---

**D 的结论对了一半，理由是错的，而这个理由值得纠正。**

"GPU 浮点不确定"这个解释被论文明确否掉了：LLM 前向传播用到的所有 kernel **都是确定的**，\`torch.mm(A, B)\` 跑 1000 次逐位相同。而且它**不是 GPU 问题**——论文原话，"LLM inference endpoints served from CPUs or TPUs will also have this source of nondeterminism"。

D 说"没有解"也不对。批不变 kernel 已经在 vLLM 里落地了：

    VLLM_BATCH_INVARIANT=1 vllm serve meta-llama/Llama-3.1-8B-Instruct

代价实测：单卡 Qwen3-8B、1000 条序列，默认 26 秒 → 确定性版本 42 秒（1.6x）。

但注意它**不等于可移植**：论文的脚注说批不变结果"is not hardware/software version invariant"——逐位可复现的作用域是一套硬件加一个框架版本。`,
    },

    {
      id: 'attribute',
      kind: 'choice',
      prompt:
        '你想统计"上下文压缩和失败率的关系"，于是写了个查询：把 `gen_ai.conversation.compacted != true` 的运行归为「没压缩过」，另一边归为「压缩过」。结果显示压缩过的运行失败率高得多，你据此推动了一次 context 策略的重构。这个分析的问题在哪？',
      options: [
        { id: 'a', label: '相关不等于因果——失败的运行更长，所以更容易触发压缩，方向可能是反的' },
        {
          id: 'b',
          label:
            '规范规定这个属性 SHOULD NOT 设成 `false`，所以字段缺失意味着「不知道」而不是「没压缩」——「没压缩过」那一组混进了全部未埋点的运行',
        },
        { id: 'c', label: '这个属性是 Development 级别的，随时可能被移除，不该用来做分析' },
        { id: 'd', label: '压缩是在 SDK 内部发生的，span 上根本拿不到这个信息' },
      ],
      correct: ['b'],
      explain: `B。\`gen_ai.conversation.compacted\` 有一条容易忽略的规定：**它是一个只表示肯定的指标。**

规范原文：埋点 "SHOULD NOT set it to \`false\`；SHOULD leave it unset otherwise"。

于是这个字段有三种状态，而你的查询只认了两种：

| 字段值 | 含义 |
|---|---|
| \`true\` | 压缩过 |
| 不存在 | **不知道**——可能没压缩，也可能这条路径没埋点 |
| \`false\` | 规范说不该出现 |

一个写成 \`compacted != true\` 的过滤器把「不知道」全部划进了「没压缩」。所以你的对照组里混了：真的没压缩的运行 + 用旧版埋点库的运行 + 走了另一条没埋点的代码路径的运行。

★ 而这个错误的方向很坏：**它会让"压缩过"这一组显得格外干净**，因为那一组是被明确标记过的、也就是埋点覆盖到的那部分。你比较的其实是"埋点好的路径"和"埋点不明的路径"。

这是这一节反复出现的那个模式的又一个实例：**把「未知」写成「没有」。** 而它不抛异常，它给你一张漂亮的对比图。

修法：查询里显式区分三态，把 unset 的那部分单独列出来。如果它占比很大，那这个分析根本做不了——你得先补埋点。

---

**A 说的是一个真问题，而且在这道题里也确实存在**（失败的运行更长 → 更容易触发压缩 → 反向因果）。但它是**在数据可信之后**才需要处理的问题。而这道题的数据本身就不可信——所以 B 是更根本的那一层。

这个顺序和 L12 的五道闸门、和这一节的复盘报告是同一个道理：**先判数据可不可信，再看它说了什么。**

**C** 属性是 Development 级别是事实（这套约定里**每一个** GenAI 元素都是），但那意味着"要盯着它改名"，不意味着"不能用"。不用它你就没有这个信号。

**D** 恰恰相反——这个属性存在的全部意义就是让 span 上能拿到压缩信号。它在 2026 年被加进约定，正因为上下文压缩是 agent 失败的一个主要原因，也是缓存命中率突然掉崖的解释（压缩改变了前缀，所以压缩后第一个请求复用不了之前的缓存）。`,
    },

    {
      id: 'harness',
      kind: 'debug',
      prompt:
        '这是一个团队用了两个月的埋点与复盘工具。它每天在生产环境跑，从来没报过错，Grafana 上的面板全是绿的。找出让这套遥测失去意义的问题——至少有六处，每一处都不抛异常。',
      lang: 'typescript',
      code: `import { trace, SpanKind } from '@opentelemetry/api'

const tracer = trace.getTracer('agent')

interface Usage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** 跑一次 agent，把每一步记成 span。 */
export async function runAgent(task: string, provider: 'anthropic' | 'openai') {
  const opts = { kind: SpanKind.INTERNAL }
  return tracer.startActiveSpan('invoke_agent', opts, async (root) => {
    const messages: Msg[] = [{ role: 'user', content: task }]
    let totalIn = 0
    let totalOut = 0

    for (let turn = 0; turn < 100; turn++) {
      const span = tracer.startSpan('chat')

      const res = await callModel(messages)
      messages.push(res.message)

      // 把 usage 记到 span 上
      const u: Usage = res.usage
      span.setAttribute('gen_ai.usage.prompt_tokens', u.input_tokens)
      span.setAttribute('gen_ai.usage.input_tokens', u.input_tokens)
      span.setAttribute('gen_ai.usage.output_tokens', u.output_tokens)
      if (u.cache_read_input_tokens) {
        span.setAttribute('gen_ai.usage.cache_read.input_tokens', u.cache_read_input_tokens)
      }
      totalIn += u.input_tokens
      totalOut += u.output_tokens

      // 完整的输入输出，方便事后重放
      span.setAttribute('gen_ai.input.messages', JSON.stringify(messages))
      span.setAttribute('gen_ai.output.messages', JSON.stringify(res.message))

      // 采样相关的属性，在这里补齐
      span.setAttribute('gen_ai.operation.name', 'chat')
      span.setAttribute('gen_ai.provider.name', provider)
      span.setAttribute('gen_ai.request.model', res.model)
      span.end()

      if (!res.toolCalls?.length) break

      for (const tc of res.toolCalls) {
        const ts = tracer.startSpan('execute_tool', { kind: SpanKind.INTERNAL })
        ts.setAttribute('gen_ai.tool.name', tc.name)
        messages.push(await runTool(tc))
        ts.end()
      }
    }

    root.setAttribute('gen_ai.usage.input_tokens', totalIn)
    root.setAttribute('gen_ai.usage.output_tokens', totalOut)
    root.end()
    return messages
  })
}

/** 失败复盘：从 trace 里判断哪里坏了。 */
export async function postmortem(traceId: string) {
  const spans = await fetchSpans(traceId)

  const totalIn = spans.reduce(
    (s, sp) => s + (sp.attributes['gen_ai.usage.input_tokens'] ?? 0),
    0,
  )
  const cost = (totalIn / 1e6) * PRICE_PER_M_INPUT

  // 让模型看 trace，告诉我们哪里坏了
  const diagnosis = await callModel([
    { role: 'user', content: \`这是一次失败的 agent 运行，找出根因：\\n\${JSON.stringify(spans)}\` },
  ])

  return { cost, diagnosis: diagnosis.message.content }
}
`,
      reference: `这套代码有**八处**问题，每一处都不报错。按"会让你多相信一个错的数字"的严重程度排：

---

## 1. ★ Anthropic 的 usage 没归一 —— 少算最多 2001 倍

    span.setAttribute('gen_ai.usage.input_tokens', u.input_tokens)

Anthropic 的 \`input_tokens\` **不含缓存**，OpenAI 的**已含**。同一段代码在 OpenAI 上完全正确，在 Anthropic 上把 100,050 记成 50。

而这里更糟一点：\`cache_read_input_tokens\` 被单独记了下来，所以 span 上同时有 \`input_tokens: 50\` 和 \`cache_read: 100000\`——**缓存比总输入还多**。这个矛盾是可检测的，代码里没检测。

修法：

    const inputTokens = provider === 'anthropic'
      ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      : u.input_tokens

## 2. ★ 双发 —— 报告花费翻一倍

    span.setAttribute('gen_ai.usage.prompt_tokens', u.input_tokens)
    span.setAttribute('gen_ai.usage.input_tokens', u.input_tokens)

同一个值写到新旧两个键上。任何 \`SUM(prompt_tokens) + SUM(input_tokens)\` 的查询翻倍——而**两个键各自的值都是对的**。

写新的那个就够了。旧键在读取侧做兼容，不在写入侧双发。

## 3. ★ 根 span 也带 token —— 按 span 求和重复计算

    root.setAttribute('gen_ai.usage.input_tokens', totalIn)

子 span 上有 token，父 span 上又有一份总和。\`postmortem\` 里那个 \`reduce\` 会把它们**全部加起来**，得到整整两倍。

而这正是 OTel v1.41.0 拆分 \`invoke_agent\` 时解决的问题：internal 那种 span **显式不带 token usage 属性**，就是为了让按 span 求和不重复计算。

要在根上放聚合值的话，用一个自定义的键名（比如 \`app.agent.total_input_tokens\`），别复用规范的键。

## 4. ★ sampling-relevant 属性设得太晚

    // 采样相关的属性，在这里补齐
    span.setAttribute('gen_ai.operation.name', 'chat')
    span.setAttribute('gen_ai.provider.name', provider)

这五个属性（\`operation.name\`、\`provider.name\`、\`request.model\`、\`server.address\`、\`server.port\`）被标记为 **sampling-relevant**，规范要求它们**在 span 创建时就存在**。

在 \`span.end()\` 之前才补，tail 采样器看不到它们——**而你的采样策略会静默地不再区分任何东西**。它不会报错，它会开始留下一个随机子集。

修法是在 \`startSpan\` 的 \`attributes\` 选项里传进去。

顺带：\`server.address\` 和 \`server.port\` 这里根本没设，而它们也在那个列表里。

## 5. ★ 二次方增长 —— 一次运行能写 160 MB

    span.setAttribute('gen_ai.input.messages', JSON.stringify(messages))

每一轮都把**整个** messages 数组记一遍。k 轮下来存了 \`k(k+1)/2\` 条消息，而唯一的只有 k 条。

50 轮 → 存 1275 条 / 唯一 50 条，**~98% 是重复字节**。逼近上下文上限时一次运行写 ~160 MB。

而 \`for (let turn = 0; turn < 100; turn++)\` 这个上限意味着最坏情况是 \`100 × 101 / 2 = 5050\` 条。

修法是内容寻址：哈希每条消息的**规范化**（排过键的）JSON，每个 trace 只存一份，读的时候拼回来。

## 6. ★ 4 MiB 那道墙

第 5 条直接导致这个：一个接近上下文上限的 \`input.messages\` 可以到 3.2 MB。两个这样的 span 打进一批就超过 OTLP 的 **4 MiB**，而那是**不可重试**的错误——整批消失，连带无关的 span。

而 SDK 不会救你：\`AttributeValueLengthLimit\` 的默认值是 **Infinity**（那个到处流传的"128 字符截断"是 \`AttributeCountLimit\`，限的是**属性个数**）。

修法：超过阈值的内容外部化，span 上只留引用。规范还留了一个钩子给这件事，而且那个钩子的设计很聪明——它 "SHOULD 在采样决策之外独立运行"，那正是"trace 采样到 1%、录音留全量"这个架构。

## 7. 工具 span 之间没有并发标记，而循环是顺序的

    for (const tc of res.toolCalls) {
      ...
      messages.push(await runTool(tc))
    }

这一条不是遥测 bug，是它**暴露的**一个性能 bug：多个工具调用被串行执行。而重放侧还有个连带问题——真正并发的调用是按**完成顺序**录的，顺序不稳定时匹配只能是 best-effort。

如果改成并行（应该改），重放的顺序匹配就需要额外处理。

## 8. ★ 把 trace 丢给模型让它找根因

    const diagnosis = await callModel([
      { role: 'user', content: \`...\\n\${JSON.stringify(spans)}\` },
    ])

两个问题，都很硬：

**(a) 它做不到。** TRAIL 基准（148 条 OTel trace / 1987 span / 841 条标注错误）里，最好的模型联合准确率是 **GAIA 18.3% / SWE-Bench 5.0%**。而分项更说明问题：**Context Handling Failures 几乎所有模型 F1 = 0.00**，Task Orchestration 除一个 0.47 之外全在 0.00–0.08。

★ **agent 独有的那些失败，恰恰是 LLM judge 看不见的。**（对比：Language-Only 幻觉所有模型都测得不错，0.14–0.59。所以"用 judge 查幻觉"可行，"用 judge 定位 agent 故障"不可行。）

**(b) 它常常连不进去。** TRAIL 里 8 个模型有 **3 个直接上下文超限**。GAIA 那一份在 Claude-3.7 的 tokenizer 下**平均**长度 262.67K，超过它 200K 的窗口。而这里 \`JSON.stringify(spans)\` 还包含了第 5 条那些重复的完整 message 数组——所以它比 TRAIL 的样本更长。

修法：程序能判的用规则（步骤重复、轮数超限、压缩标记、工具错误率），判不了的**明确标出来交给人**，而不是假装 judge 能处理。

---

## 还有一件事：报告的顺序

\`postmortem\` 直接算成本、直接要诊断。它从来没问过**这份 trace 可不可信**。

而上面第 4、5、6 条全都会让轨迹缺失或缺项。所以正确的顺序是：

    ① 这份 trace 可不可信（采样配置、分批、属性代次）
    ② 能重放吗
    ③ 程序判出什么
    ④ 成本
    ⑤ 明确交给人的部分

和 L12 的五道闸门同一个道理：**一旦你先看了结论，你就有了立场。**`,
    },

    {
      id: 'design',
      kind: 'design',
      prompt:
        '你接手一个已经上线半年的编码 agent，它每天跑约 2000 次，用户抱怨"有时候它会卡住半天然后放弃"，但你手上什么都没有——只有应用日志（非结构化的 console.log）和账单。团队给你两周，一个人。给出你的方案，并明确说出你**不做**什么，以及为什么。',
      scenario: `已知条件：

· 每天约 2000 次运行，p50 约 40 秒，长尾能到 8 分钟
· 应用日志是非结构化的，只有 console.log，没有 trace id，留 7 天
· 账单每月 $18000，而团队没人能解释这个数字是怎么构成的
· 用了 prompt caching，系统 prompt 约 12k token
· 同时接了 Anthropic 和 OpenAI，按任务类型路由
· "卡住然后放弃"这个抱怨每周有三四次，但没人能复现过一次
· 你能拿到的资源：你自己，加一台能跑 collector 的机器`,
      reference: `这道题的重点不在于列出所有能做的事，而在于**在两周、一个人、零现有遥测的约束下排序**。

而排序的依据要说清楚：**先让"卡住然后放弃"这件事可观测，再让账单可解释，最后才是完整 tracing。**

---

## 第一天：先拿到那两个直方图

★ 反直觉的第一步：**不要先接 tracing。**

理由是这一节第八节那个结论：\`gen_ai.invoke_agent.inference_calls\` 和 \`.tool_calls\` 是 **Histogram**，所以

**p99 的 loop 长度可以在不存任何一条 trace 的前提下报警。**

而"卡住然后放弃"几乎肯定就是 loop 长度失控。所以第一天的产出是两个 metric 加一个面板：

    gen_ai.invoke_agent.inference_calls    Histogram
    gen_ai.invoke_agent.tool_calls         Histogram
    gen_ai.invoke_agent.duration           Histogram

这三个是**全量**的（metric 不采样），成本可以忽略，而且它们立刻回答"每周三四次"到底是三四次还是三四十次。

如果 p99 是 8 而 max 是 60，那这个问题就定性了：**不是慢，是循环。** 而这个判断在你写第一行 span 代码之前就能拿到。

## 第二到三天：token 归一 + 成本拆分

账单 \$18000 没人能解释，而这里有两个已知的量级错误在等着：

**1. 两家的 \`input_tokens\` 语义相反。** Anthropic 的不含缓存，OpenAI 的含。12k token 的系统 prompt 加 prompt caching，意味着 Anthropic 那一路的统计可能只有真实值的百分之几。

**2. 成本必须从 span 算，不能从 metric 算。** \`gen_ai.token.type\` 只有 \`input\` 和 \`output\`，而缓存读（0.1x）、5 分钟写（1.25x）、1 小时写（2x）、普通输入（1x）全塌进一个桶。

所以这两天的产出是一个**归一层**：

    normalizeUsage(provider, rawUsage) → {
      inputTokens,      // 含缓存，OTel 口径
      cacheRead,
      cacheWrite5m,     // ★ 必须读 cache_creation 明细，
      cacheWrite1h,     //   顶层字段是两档之和，分不出 1.25x 和 2x
      reasoning,        // ★ 已在 output 里，不要再加
      freshInput,
    }

加一个自带缓存维度的自定义 metric（因为规范的那个没有）。

**这一步的验收标准很硬：算出来的月度总额要和账单对得上，误差在 5% 以内。** 对不上就说明归一层还有 bug，而不是"大概差不多"。

## 第四到七天：结构化 trace

现在才开始接 tracing。span 形状按规范的预期：**一个 \`invoke_agent\` 下面一排兄弟**，不是嵌套链，跨轮次关联靠 \`gen_ai.conversation.id\`。

四个必须一开始就做对的细节，因为事后补都很痛：

1. **五个 sampling-relevant 属性在 \`startSpan\` 时就传进去**，不是 end 之前补。否则 tail 采样器看不到它们，采样策略会静默失效。
2. **按字节分批，不按条数。** 一个 LLM span 能到 3.2 MB，两个就超 OTLP 的 4 MiB，而那是不可重试错误——整批消失。
3. **内容外部化。** \`input.messages\` 不直接放 span 上，做内容寻址（哈希规范化 JSON），span 上只留引用。这同时解决二次方增长和第 2 点。
4. **只在子 span 上放 token**，根 span 不放规范的那几个键，否则按 span 求和翻倍。

## 第八到十天：采样

**这里要抵抗一个诱惑：直接上 tail 采样，用默认值。**

默认值在 agent 上是坏的：

| 配置项 | 默认 | 我们的现实 |
|---|---|---|
| \`decision_wait\` | 30s | 长尾 8 分钟 = 16 倍 |
| \`sampled_cache_size\` | 0 | 一次运行可能拿到两个矛盾决策 |
| \`num_traces\` | 50k | 淘汰最老的 = 系统性丢长运行 |

所以配置是：\`decision_wait\` 设到 **600 秒**（超过 8 分钟长尾），\`sampled_cache_size\` / \`non_sampled_cache_size\` 设成远大于 \`num_traces\`。

策略：**失败全留、\`inference_calls\` 超过 p95 全留、成功的按 2% 留。**

注意最后一档存在的理由不是省钱，是**你需要一个健康基线来对比**。只留失败的话，你永远不知道正常运行长什么样。

而 \`decision_wait\` 600 秒的代价要算清楚：collector 要在内存里缓 10 分钟的 span。所以 \`num_traces\` 得按 \`2000/天 × 10 分钟窗口\` 反过来估，并且监控四个采样器自身指标（\`trace_dropped_too_early\`、\`trace_removal_age\`、\`late_span_age\`、\`decision_timer_latency\`）。

**★ 而这里有一个部署约束在单机演示里完全看不见：tail 采样不能跑在节点本地的 collector 上**，因为一条 trace 的 span 散在多个节点。它必须在 gateway 上，多副本还要 \`loadbalancing\` exporter 按 \`trace_id\` 路由。我们只有一台机器，所以现在没问题——但这个约束要写进文档，否则它会在第一次扩容的那天出现。

## 第十一到十四天：失败分类 + 复盘报告

分类学只收**程序能判**的，理由是 TRAIL：最好的模型联合准确率 18.3%/5.0%，而 Context Handling Failures 几乎所有模型 **F1 = 0.00**。

★ agent 独有的失败恰恰是 judge 看不见的。所以：

| 判得了 | 判不了，交给人 |
|---|---|
| 步骤重复（同工具超 N 次） | 推理与行动不一致 |
| 轮数超限未结束 | 验证错误 |
| 一轮结束无工具调用 | 违背任务规格 |
| 工具错误率 | 压缩是否导致了失败 |

复盘报告的顺序是刻意的，和 L12 的五道闸门同一个道理：

    ① 这份 trace 可不可信
    ② 能重放吗
    ③ 程序判出什么
    ④ 成本
    ⑤ 明确交给人的部分

并且必须显式处理一个情况：**运行失败了但一条规则都没命中。** 那不是"没有失败模式"，是分类学的缺口，要报出来。

---

# 我不做什么

**不做确定性重放。**

理由不是没时间，是**它办不到**。temperature 0 下输出取决于别人的负载（批不变性），而 \`seed\` 在 Responses API 里根本不存在。我们能建的是**录音回放**，而且它的价值集中在 hybrid 模式（重放到分叉再转真实调用）。

两周里我只做**录音的采集**（内容外部化那一步顺带就有了），不做回放器。等第一次真正需要"如果那一步返回的是别的会怎样"的时候再建，而那时候需求会具体得多。

**不修那些非结构化的应用日志。**

它们只留 7 天，而且没有 trace id——补 trace id 的工作量和重写差不多。新的结构化遥测上线后它们自然退役。**在旧日志上花的每一小时都是沉没成本。**

**不做 LLM 自动根因分析。**

见上面 TRAIL 的数字。而且它有个隐性成本：一个准确率 18% 的诊断**看起来很像**一个准确率 80% 的诊断，于是团队会开始相信它。★ 这比没有诊断更糟——和 L12 那句"一个错的评测比没有评测更糟"完全同构。

**不追求 100% 采样。**

2000 次/天 × 长尾 8 分钟的运行，全量带内容的 trace 是二次方增长的。上面那个"失败全留 + 长运行全留 + 成功 2%"的策略在成本上可行，在信息上够用。

**不上厂商的一站式 agent 可观测性平台。**

不是因为它们不好，而是因为**两周里我需要先搞清楚我要什么**。这一节所有的坑（token 语义、缓存维度、decision_wait、4 MiB）在任何平台上都存在，只是被藏起来了。先用 OTel 原语建一遍，我就知道该问供应商什么问题。

**不改 collector 配置以外的任何生产行为。**

第七条那个串行工具调用如果存在，我会记录下来但不改。**遥测项目改生产逻辑，是把两件事的风险乘在一起。**

---

# 两周结束时的验收

| 问题 | 能回答吗 |
|---|---|
| "卡住然后放弃"每周发生几次 | ✓ 第一天就有 |
| p99 的 loop 长度是多少 | ✓ 第一天就有 |
| \$18000 是怎么构成的 | ✓ 第三天，误差 <5% |
| 某一次具体失败当时发生了什么 | ✓ 只要它被采样到 |
| 换个模型能省多少 | ✗ 需要真跑，录音回放答不了 |
| 根因是什么 | 部分——程序判得了的那几类 |

最后一行是刻意留白的。**这一节给的是"可复现、可归因"的地基，不是一个会告诉你答案的系统。**`,
    },
  ],
}
