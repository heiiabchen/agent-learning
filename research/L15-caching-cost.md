# L15 调研报告 · 性能与成本：把账算明白

> 调研日期：**2026-09-15**（下文所有「访问日期」「抓取日期」若未另注，均为此日）
> 交付物定位：缓存与模型路由
> 硬约束：本节 verify **一次模型都不调**，CI 内确定性，TS / Python 双语言输出逐字节一致
>
> 置信度标记：`[P]` 一手来源直接陈述 · `[P2]` 一手来源但需要推断 · `[S]` 二手来源（本报告中 `[S]` 仅用于线索，不用于任何数字）

---

## 0. 一句话结论

**这节课的中心论点不是「怎么省钱」，而是「怎么知道自己有没有省到钱」。**

缓存、路由、批处理这三件事的共同结构是：**它们失败的时候不报错。** 低于最低 token 数不报错（Anthropic 官方原话：`no error is returned`），兼容层丢掉 `cache_control` 不报错（DeepSeek 官方兼容表里写着 `Ignored`），路由器选错模型不报错，`speed: "fast"` 在 Opus 4.6 上不报错。所以这一节真正要交付的能力是一套**判定器**：给定 `usage` 字段，判断「命中了 / 没命中 / 这个端点根本没法判定」。

推论三条，都会在第 9 节变成可验证的实验：

1. **省钱的单位不是「请求」，是「前缀」。** 缓存命中判定是逐 token 前缀的密码学哈希（Anthropic：`Cache hits require 100% identical prompt segments`），所以「改了哪一个字节」比「改了多少内容」重要一万倍。
2. **报出来的数不等于账单上的数。** `usage.input_tokens` 在 Anthropic 只表示最后一个断点**之后**的 token；OpenAI 旧模型的 `cached_tokens` 向下取整到 128 的倍数；Anthropic 的 OpenAI 兼容层 `usage.prompt_tokens_details` 恒为空。
3. **这一节砍的每一刀，都在切 L14 立起来的边界。** 这不是修辞——OpenAI 自己的文档里写着 `separate keys help prevent cache-hit probing across users`，即厂商承认缓存是一条可探测信道；DeepSeek 把 `user_id` 的作用之一直接命名为 `KVCache Isolation`。

---

## 1. 反转清单（INV-1 … INV-26）

> 每条格式：**广为流传的说法** → **实际情况** → 一手来源 + 逐字引用

### INV-1 · TTL 是从响应结束开始计时的

**流传说法**：Anthropic 的 5 分钟缓存，是响应结束后再算 5 分钟。
**实际**：从**请求开始**计时。生成响应的时间算在 TTL 里面。

> "The lifetime is measured from the start of the request that writes or reads the cache entry, not from the end of its response. Time spent generating a response counts against the lifetime: if a response takes 4 minutes to stream, a follow-up request that reuses the same cached prefix must start within about 1 minute of that response completing."
> —— Anthropic, *Prompt caching*, docs.claude.com/en/docs/build-with-claude/prompt-caching，访问 2026-09-15 `[P]`

FAQ 里又说了一遍，措辞更直接：

> "When does the cache lifetime start? The lifetime is measured from the start of the request that writes or reads the cache entry, not from the end of its response. Time spent generating a response counts against the lifetime, so the window for a follow-up request to reuse the cache is the lifetime minus the generation time." `[P]`

**为什么重要**：agent 的一步经常是「长 thinking + 长输出 + 工具往返」。一个流式输出跑 4 分钟的 agent 步骤，下一步只剩约 1 分钟窗口。**这是「长输出的 agent 必须用 1h 缓存」的真正理由，不是「用户回复慢」。**

---

### INV-2 · `usage.input_tokens` 是这次请求的输入 token 总数

**流传说法**：`input_tokens` 是总输入。很多成本账本就是这么写的（包括本课 L02 之前的写法）。
**实际**：在 Anthropic，它**只**表示最后一个缓存断点之后的部分。

> "`input_tokens`: Number of input tokens which were not read from or used to create a cache (that is, tokens after the last cache breakpoint)."
> "Important: `input_tokens` does NOT represent all input tokens - only the portion after your last cache breakpoint."
> "`total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens`"
> —— Anthropic, *Prompt caching*，访问 2026-09-15 `[P]`

官方给的例子：200k 文档命中缓存 + 50 token 提问 → `cache_read_input_tokens: 200000`，`cache_creation_input_tokens: 0`，`input_tokens: 50`。

**为什么重要**：这是本节最容易出的账本 bug。一个只读 `input_tokens` 的成本监控，在缓存**开始工作**的那天会显示成本下降 99.97%——而真实下降是 90%。**它会让你以为缓存比实际更有效。**

---

### INV-3 · 缓存命中的 token 算不算限流额度，各家一样

**实际**：两家**相反**，而且各自都拿这个当卖点。

Anthropic：
> "Many API providers use a combined 'tokens per minute' (TPM) limit that may include all tokens, both cached and uncached, input and output. For most Claude models, only uncached input tokens count toward your ITPM rate limits. This is a key advantage that makes the rate limits effectively higher than they might initially appear."
> "`cache_read_input_tokens` (tokens read from cache) ✗ Do NOT count toward ITPM for most models"
> "Example: With a 2,000,000 ITPM limit and an 80% cache hit rate, you could effectively process 10,000,000 total input tokens per minute (2M uncached + 8M cached)"
> —— Anthropic, *Rate limits*, docs.claude.com/en/api/rate-limits，访问 2026-09-15 `[P]`

OpenAI：
> "Do cached prompts count toward rate limits? Yes. Cached input tokens still count toward tokens-per-minute limits. Prompt caching does not change how rate limits are calculated."
> —— OpenAI, *Prompt caching*, platform.openai.com/docs/guides/prompt-caching，访问 2026-09-15 `[P]`

**例外要注意**：Anthropic 并非全模型如此。Claude Haiku 3.5 是例外：

> "4 Limit counts `cache_read_input_tokens` toward ITPM usage." （脚注 4，挂在 Claude Haiku 3.5 行上）`[P]`

有意思的是，OpenAI 在 **Bedrock 上的 GPT-5.6** 又变成不计入：
> "Cached tokens do not count toward rate limits — Cached input tokens read through prompt caching do not count against the input-tokens-per-minute quota."
> —— AWS, *Prompt caching*, docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html，访问 2026-09-15 `[P]`

**为什么重要**：「缓存能把你的有效限额放大 5 倍」这句话在 Anthropic 直连是对的，在 OpenAI 直连是错的，在 Bedrock 上的 OpenAI 模型又是对的。**同一句话在三个地方三种真假值。**

---

### INV-4 · `max_tokens` 设大一点没关系 / 会吃限额

**实际**：两家**相反**，而且都是官方明说。

Anthropic：
> "OTPM rate limits are evaluated in real time as output tokens are produced, counting only the actual tokens generated. The `max_tokens` parameter does not factor into OTPM rate limit calculations, so there is no rate limit downside to setting a higher `max_tokens` value." `[P]`

OpenAI：
> "Reduce the `max_tokens` to match the size of your completions. Your rate limit is calculated as the maximum of `max_tokens` and the estimated number of tokens based on the character count of your request. Try to set the `max_tokens` value as close to your expected response size as possible."
> —— OpenAI, *Rate limits*，访问 2026-09-15 `[P]`

**为什么重要**：一份到处抄来的「LLM 最佳实践」里写着「把 max_tokens 设小以免浪费限额」——在 Anthropic 上这条建议**纯粹是在给自己找截断 bug**，一分钱限额都省不到。

---

### INV-5 · 模型越小，最低可缓存 token 数越低

**实际**：反过来。当前 Anthropic 阵容里，**最贵的模型门槛最低（512），而便宜的 Haiku 4.5 门槛最高（4096）**。

> "On the Claude API, Claude Platform on AWS, Google Cloud, and Microsoft Foundry, the minimum cacheable prompt length is:
> - 512 tokens for Claude Fable 5.1, Claude Mythos 5.1, Claude Opus 5, Claude Fable 5, and Claude Mythos 5
> - 2,048 tokens for Claude Mythos Preview and Claude Opus 4.7
> - 4,096 tokens for Claude Opus 4.6 and Claude Opus 4.5
> - 1,024 tokens for Claude Opus 4.8, Claude Sonnet 5, Claude Sonnet 4.6, Claude Sonnet 4.5, Claude Opus 4.1 …, Claude Opus 4 …, and Claude Sonnet 4 …
> - 4,096 tokens for Claude Haiku 4.5
> - 2,048 tokens for Claude Haiku 3.5 …"
> —— Anthropic, *Prompt caching*，访问 2026-09-15 `[P]`

注意门槛甚至**不随版本单调**：Opus 4.5/4.6 是 4096，Opus 4.7 降到 2048，Opus 4.8 降到 1024，Opus 5 降到 512。

**为什么重要**：这是「模型路由」和「prompt caching」直接打架的地方。你把简单任务路由到 Haiku 4.5 省钱，结果那个 1500-token 的 system prompt 在 Haiku 上**根本不够缓存门槛**，于是每次全价——而在 Opus 5 上它是命中的。**路由省下的钱可能小于丢掉的缓存。**

---

### INV-6 · OpenAI 的缓存写入是免费的

**流传说法**：OpenAI 不像 Anthropic，写缓存不额外收费。这在 2024–2025 年是对的。
**实际**：GPT-5.6 及以后**开始收 1.25× 的写入费**，和 Anthropic 一样。

> "For GPT-5.6 and later, cache writes cost 1.25× the standard, uncached input-token rate."
> 模型差异表：「Cache write charge | GPT-5.6 and later: 1.25× the uncached input-token rate | GPT-5.5 and GPT-5.5 Pro: No additional cache-write charge | Other earlier models: No additional cache-write charge」
> —— OpenAI, *Prompt caching*，访问 2026-09-15 `[P]`

微软的文档把这件事说得更像一句警告：
> "Models before the GPT-5.6 family don't charge extra to write to the cache. On GPT-5.6 models and later model families, cache writes can incur charges in addition to discounted cache reads."
> —— Microsoft, *Prompt caching with Azure OpenAI in Microsoft Foundry Models*，访问 2026-09-15 `[P]`

**为什么重要**：所有「OpenAI 缓存是纯赚，无脑开」的教程现在都过期了。OpenAI 自己给了盈亏平衡的算术：

> "Writing a prefix once and fully reusing it once costs 1.35× its ordinary input cost, compared with 2× for processing it twice without caching. The savings grow with each additional cache read: across ten requests, one write and nine full reads cost 2.15×, compared with 10× without caching." `[P]`

**写一次读一次就已经回本**（1.35 < 2）。但「写了从来没读到」是净亏 25%，而这正是断点放错位置时会发生的事（见 INV-11）。

---

### INV-7 · prompt cache 是组织级隔离的

**实际**：粒度**在同一家厂商内部都不统一**，而且这个差异有安全含义。

Anthropic：
> "Prompt caching uses workspace-level isolation. Caches are isolated per workspace, ensuring data separation between workspaces within the same organization. This applies to the Claude API, Claude Platform on AWS, and Microsoft Foundry; **Bedrock and Google Cloud maintain organization-level cache isolation.** If you use multiple workspaces, review your caching strategy to account for this difference."
> —— Anthropic, *Prompt caching § Cache storage and sharing*，访问 2026-09-15 `[P]`

同一份文档 FAQ：
> "On the Claude API, Claude Platform on AWS, and Microsoft Foundry, caches are isolated per workspace within an organization. On Bedrock and Google Cloud, caches are isolated per organization. In every case, caches are never shared across organizations, even for identical prompts." `[P]`

OpenAI：
> "Caches are not shared across organizations and cannot be reused across regional processing boundaries." `[P]`

Azure：
> "The system doesn't share prompt caches between Azure subscriptions."
> —— Microsoft, *Prompt caching…*，访问 2026-09-15 `[P]`

DeepSeek：给了一个**更细**的显式开关——
> "KVCache Isolation：`user_id` is used to isolate KVCache for users on your business side for privacy management"
> —— DeepSeek, *Rate Limit & Isolation*, api-docs.deepseek.com/quick_start/rate_limit，访问 2026-09-15 `[P]`

**汇总**（这是本节最该背下来的一张表）：

| 平台 | 隔离边界 | 一手来源 |
|---|---|---|
| Claude API 直连 | **workspace**（组织内再细分） | Anthropic prompt caching `[P]` |
| Claude Platform on AWS | **workspace** | 同上 `[P]` |
| Microsoft Foundry（Claude） | **workspace** | 同上 `[P]` |
| Amazon Bedrock（Claude） | **organization** | 同上 `[P]` |
| Google Cloud / Vertex（Claude） | **organization** | 同上 `[P]` |
| OpenAI 直连 | **organization**，且不跨 region | OpenAI prompt caching `[P]` |
| Azure OpenAI | **subscription** | Microsoft `[P]` |
| DeepSeek | 账号级，可用 `user_id` 手动细分到终端用户 | DeepSeek `[P]` |

**为什么重要**：如果你做的是多租户 SaaS，「组织级隔离」意味着**你的所有租户共用一个缓存池**——厂商保证的是「别的公司看不到」，不是「你的客户 A 看不到客户 B」。这条边界的名字是你的，不是厂商的。见第 8 节。

---

### INV-8 · Batch API 和 prompt caching 可以叠加

**实际**：**取决于平台，而且两个平台的答案是硬冲突的。**

Anthropic 直连——可以叠加，并给了实测命中率区间：
> "The Message Batches API supports prompt caching, allowing you to potentially reduce costs and processing time for batch requests. The pricing discounts from prompt caching and Message Batches **can stack**, providing even greater cost savings when both features are used together. However, because batch requests are processed asynchronously and concurrently, cache hits are provided on a best-effort basis. **Users typically experience cache hit rates ranging from 30% to 98%**, depending on their traffic patterns."
> —— Anthropic, *Message Batches API*, docs.claude.com/en/docs/build-with-claude/batch-processing，访问 2026-09-15 `[P]`

Bedrock——**不行**：
> "Prompt caching is only supported for on-demand inference endpoints. It is not supported with the batch inference API."
> —— AWS, *Prompt caching*，访问 2026-09-15 `[P]`

Gemini——支持，但计费措辞不同（**没说打折叠加**）：
> "Caching: Context caching is supported for batch requests. Reuse cached content by specifying the `cached_content` resource name in the configuration of individual requests within your batch. If a request in your batch results in a cache hit, **you pay the standard context caching rates**."
> —— Google, *Batch API*, ai.google.dev/gemini-api/docs/batch-api，访问 2026-09-15 `[P]`

**为什么重要**：这决定了课程里一个取舍的讲法。Anthropic 还额外给了一个具体的操作序列，值得原文引：
> "- Gather a set of message requests that have a shared prefix.
> - Send a batch request with a single request that has this shared prefix and a 1-hour cache block. This writes the prefix to the 1-hour cache.
> - As soon as this is complete, submit the rest of the requests. …
> This is typically better than using the 5-minute cache because it's common for batch requests to take between 5 minutes and 1 hour to complete." `[P]`

**但这条路在 batch 内部被堵死了**——Anthropic 明确禁止在 batch 里做缓存预热：
> "Each batched request must have `max_tokens` of at least `1`. `max_tokens: 0` (cache pre-warming) is not supported inside a batch, because an ephemeral cache entry written during batch processing would likely expire before the follow-up request runs." `[P]`

---

### INV-9 · `cache_control` 被忽略了，所以没有缓存

**实际**：在 DeepSeek 上，`cache_control` 确实被忽略，但**缓存照样在跑**，而且是默认开启的。你失去的不是缓存，是对缓存的**控制权和可观测性**。

DeepSeek 的 Anthropic 兼容表里，`cache_control` 出现四次，四次都是 `Ignored`：

| 位置 | Support Status |
|---|---|
| `tools[n].cache_control` | `Ignored` |
| `content` array, `type="text"` → `cache_control` | `Ignored` |
| `content` array, `type="tool_use"` → `cache_control` | `Ignored` |
| `content` array, `type="tool_result"` → `cache_control` | `Ignored` |

—— DeepSeek, *Using the Anthropic API*, api-docs.deepseek.com/guides/anthropic_api，访问 2026-09-15 `[P]`

同时：
> "The DeepSeek API Context Caching on Disk Technology is **enabled by default for all users, allowing them to benefit without needing to modify their code**."
> —— DeepSeek, *Context Caching*, api-docs.deepseek.com/guides/kv_cache，访问 2026-09-15 `[P]`

**为什么重要**：L00 讲义里说的「你以为开了缓存，实际全价付费」在 DeepSeek 上**不成立**——它比那个更微妙：你以为你开了缓存，实际是**它自己开了缓存，但命中规则和你以为的不一样**。DeepSeek 的持久化单元规则和 Anthropic 完全不同：

> "Each request will produce two cache prefix units at the end position of the user input and the end position of the model output."
> "Example 2: A user's first-round request is `A + B`, and the second-round request is `A + C`. The second request **cannot** hit the cache, because `A + C` does not fully match the first round's cache prefix unit (`A + B`). However, at this point the system will detect that the two requests share a common prefix `A`, and persist `A` as a cache prefix unit. When a third-round request `A + D` arrives, it can fully match…" `[P]`

即：**同一个长文档的第二个问题必然 miss，第三个才可能命中。** 这和 Anthropic 「放个断点在文档末尾，第二次就命中」的心智模型完全不同。

---

### INV-10 · 缓存没生效会报错，所以没报错就是生效了

**实际**：**明确不报错**，三家都不报。

> "Shorter prompts cannot be cached, even if marked with `cache_control`. Any requests to cache fewer than this number of tokens will be processed without caching, and **no error is returned**. To verify whether a prompt was cached, check the response usage fields: if both `cache_creation_input_tokens` and `cache_read_input_tokens` are 0, the prompt was not cached (likely because it did not meet the minimum length requirement)."
> —— Anthropic, *Prompt caching § Cache limitations*，访问 2026-09-15 `[P]`

Anthropic 的自动缓存还会**静默回退**：
> "If the last block is not eligible as an automatic cache breakpoint target, the system silently walks backwards to find the nearest eligible block. If none is found, caching is skipped." `[P]`

Bedrock 也强调：
> "Support for prompt caching doesn't guarantee a cache hit for any request. Check the cache usage fields in the model response to determine whether tokens were read from or written to cache." `[P]`

AWS 还说了一个更隐蔽的：
> "If you add a cache checkpoint before the total prompt prefix meets the minimum number of tokens, your inference still succeeds, but your prefix isn't cached." `[P]`

**为什么重要**：这是整节课的方法论支点——**唯一的信号在 `usage` 里**。第 9 节的实验就建在这句话上。

---

### INV-11 · 把断点放在最后一个块上，系统会自动往回找稳定内容

**实际**：lookback **只找「之前的请求已经写过的条目」**，不找「看起来稳定的内容」。这是一个极其常见的误解，Anthropic 专门写了一节叫 "Common mistake"。

> "1. Cache writes happen only at your breakpoint. Marking a block with `cache_control` writes exactly one cache entry: a hash of the prefix ending at that block. **The system does not write entries for any earlier position.**"
> "2. Cache reads look backward for entries that prior requests wrote. … **It is looking for prior writes, not for stable content.**"
> "3. The lookback window is 20 blocks. The system checks at most 20 positions per breakpoint, counting the breakpoint itself as the first."
> —— Anthropic, *Prompt caching § How automatic prefix checking works*，访问 2026-09-15 `[P]`

官方的失败案例：
> "Request 1: Cache write at block 6. The hash includes the timestamp.
> Request 2: The timestamp differs, so the prefix hash at block 6 differs. The lookback walks through blocks 5, 4, 3, 2, and 1, but **the system never wrote an entry at any of those positions**. No cache hit. **You pay for a fresh cache write on every request and never get a read.**"
> "**The lookback does not find stable content behind your breakpoint and cache it.** It finds entries that prior requests already wrote, and writes happen only at breakpoints." `[P]`

**为什么重要**：这个配置错误的代价不是 0，是 **+25%**（每次都付 1.25× 的写入费，一次读都没有）。**它比不开缓存还贵，而且日志上完全正常。**

顺带：Anthropic 明说自动缓存**也会掉进同一个坑**——
> "Automatic caching hits the same trap: it places the breakpoint on the last cacheable block, which in this structure is the one that changes every request, so use an explicit breakpoint on block 5 instead." `[P]`

---

### INV-12 · RouteLLM 证明路由能省 2 倍成本

**实际**：论文自己报的是「over 2 times」，但那是**在 MT Bench 上、且用 GPT-4-as-a-judge 做过数据增强之后**的结果。**在没有领域内增强数据时，多个 router 表现不如随机基线。**

论文摘要（arXiv:2406.18665v4，v1 2024-06-26，最后修订 2025-02-23）：
> "Our evaluation on widely-recognized benchmarks shows that our approach significantly reduces costs-by over 2 times in certain cases-without compromising the quality of responses." `[P]`
> 注意 "in certain cases" 这三个字——摘要里就写了限定词，引用它的人常常删掉。

论文正文 Table 3（8-shot GSM8K，仅用 `D_arena` 训练），APGR Improvement 相对随机基线：

| Method | CPT(50%) | CPT(80%) | APGR | Improvement |
|---|---|---|---|---|
| Random (95% CI) | 50.00(±2)% | 80.08(±1)% | 0.497(±0.01) | +0% |
| BERT | 58.78% | 83.84% | 0.438 | **−11.8%** |
| Causal LLM | 56.09% | 83.56% | 0.461 | **−7.3%** |
| Matrix Factorization | 53.59% | 85.24% | 0.4746 | **−4.5%** |
| SW Ranking | 54.43% | 82.11% | 0.4753 | **−4.3%** |

—— RouteLLM, Table 3 `[P]`

**四个 router 全部比随机差。** MMLU（Table 2）同样：BERT +0.5%、Causal LLM −0.2%、MF +4.9%、SW Ranking −5.4%，论文自己的结论是：

> "On MMLU (Table 2), all routers perform poorly at the level of the random router when trained only on Arena dataset, which we attribute to most MMLU questions being out-of-distribution" `[P]`

---

### INV-13 · 路由器的基线是「全用便宜模型」

**实际**：论文用的基线是**随机路由**，而随机路由的 APGR 恰好是 0.5——这是一个**比大多数人想象中强得多的基线**。

> "Neither of the above metrics alone is sufficient to capture the quality-cost trade-off in routing. For example, a trivial router that always sends queries to the strong model achieves a perfect PGR = 1 but with no cost savings." `[P]`

**为什么重要**：如果你做了一个路由器，它必须显著赢过「抛硬币」才算有价值。INV-12 显示这不是自动成立的。**「我做了个路由器，省了 40% 的钱」这句话在没有质量轴的情况下毫无信息量**——把全部请求扔给便宜模型能省 90%。

---

### INV-14 · RouteLLM 的「不牺牲质量」= 质量不变

**实际**：「不牺牲质量」在论文里的定义是 **CPT(50%)，即恢复了强弱模型差距的 50%**。论文自己把这个翻译成绝对分数：

> "Note that the MT Bench score at CPT(50%), **8.8**, is **95%** that of GPT-4's score (**9.3**)." （Table 1 注）`[P]`
> "Note that the MMLU score at CPT(50%), **75**, is **92%** that of GPT-4's score (**81**)." （Table 2 注）`[P]`
> "Note that the GSM8K score at CPT(50%), **75**, is **87%** that of GPT-4's score (**86**)." （Table 3 注）`[P]`

**同一个「50% PGR」，在三个 benchmark 上对应 95% / 92% / 87% 的绝对质量。** 在 GSM8K 上这是掉了 13 个百分点。**「不牺牲质量」是一个相对指标的名字，不是一个事实陈述。**

---

### INV-15 · 并发翻倍，吞吐翻倍

**实际**：**prefill 阶段几乎不吃 batching。** 只有 decode 吃。

> "Figure 3: Throughput of the prefill and decode phases with different batch sizes for Mistral-7B running on a single A100 GPU. … Note that … **batching boosts decode throughput almost linearly but has a marginal effect on prefill throughput.**"
> "Takeaway-1: The two phases of LLM inference – prefill and decode – demonstrate contrasting behaviors wherein batching boosts decode phase throughput immensely but has little effect on prefill throughput."
> —— Agrawal et al., *Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve*, arXiv:2403.02310v3（v1 2024-03-04，v3 2024-06-17）`[P]`

而且提高吞吐是**以尾延迟为代价**的：
> "Iteration-level batching improves system throughput but we show that it comes at the cost of high TBT latency due to a phenomenon we call **generation stalls**." `[P]`
> Figure 1 说明：「1a highlights one of the many generation stalls lasting over several seconds in vLLM. 1b shows the impact of increasing load on tail latency.」（Yi-34B / 2×A100 / arxiv-summarisation trace）`[P]`

**为什么重要**：agent 的负载是 prefill 重的（长上下文、短输出）。**把并发从 N 提到 2N，在一个 prefill-bound 的 agent 负载上，接近于什么都没做，但把 P99 拉高了。** 这是「并发反转」最扎实的一手解释。

---

### INV-16 · 长输入的首 token 延迟随长度线性增长

**实际**：**线性算子占主导（>80%），但 attention 是二次的**——所以是「近似线性，但上凸」。这个细节有一手数据：

> "From the figure, we see that linear operators contribute to the majority of the runtime cost. **While attention cost grows quadratically with sequence length, linear operators still contribute more than 80% to the total time even at high sequence lengths.**" `[P]`

以及一个极好用的换算：
> "Due to the low arithmetic intensity in decode batches, **the cost of linear operation for 1 decode token is nearly same as 128 prefill tokens.**" （Figure 4 注，Mistral-7B / 单 A100）`[P]`

还有一个非线性拐点：
> "execution time increases only marginally in the beginning i.e., as long as the batch is in a memory-bound regime, but **linearly afterwards** i.e., when the batch becomes compute-bound." （Figure 5，LLaMA2-70B / 4×A100）`[P]`

**为什么重要**：「1 个输出 token ≈ 128 个输入 token 的计算量」是这一节最好用的直觉锚点。它同时解释了为什么输出 token 贵 5–10 倍（价格）而计算量差 128 倍（物理）——**价格和计算量不是一回事，因为输入侧被缓存吃掉了一大块。**

---

### INV-17 · 缓存失效是因为你请求得太慢

**实际**：在 OpenAI 上，**请求得太快也会失效**——超过约 15 RPM 会溢出到别的机器。

> "**Cached states live on individual machines, where traffic above 15 requests per minute can lead to overflow routing.** A request can reuse a cached prefix only if it reaches a machine holding a matching entry that has not expired. Routing requests to the right machine is therefore important for cache reuse."
> —— OpenAI, *Prompt caching § Cache location*，访问 2026-09-15 `[P]`

> "On models before GPT-5.6, use a stable `prompt_cache_key` for requests that share a reusable prefix to help route related requests to the same cache. **For busy groups, aim for about 15 requests per minute in total across all prefixes using each key.** Partition higher-volume traffic across multiple keys using a stable, deterministic mapping. **Keys influence routing; they do not pin requests to a machine or guarantee a cache hit.**" `[P]`

Azure 独立复述了同一个阈值：
> "If requests for the same prefix and `prompt_cache_key` combination exceed **approximately 15 requests per minute**, some requests might miss the cache. For higher-volume workloads, distribute requests across multiple keys while keeping a stable mapping between each key and its shared prompt prefixes."
> —— Microsoft, *Prompt caching…*，访问 2026-09-15 `[P]`

**为什么重要**：这是**扩容会让单位成本变高**的一个真实机制。压测的时候把 QPS 拉到 50，缓存命中率会掉，而你会以为是代码问题。

---

### INV-18 · `prompt_cache_key` 是用来提高命中率的

**实际**：在 GPT-5.6 及以后，它的**主要用途变成了「分账」和「防探测」**，不再是路由优化。

> "On GPT-5.6 and later, OpenAI handles cache routing automatically; **the key is not needed to optimize caching.** You can use separate keys to maintain separate cache accounting for customers or users within your application." `[P]`
> "Using separate keys can make cached token usage and billing easier to explain for each customer or user. For example, **separate keys help prevent cache-hit probing across users: submitting candidate prompts and observing cache hits to learn whether matching content was previously cached.**" `[P]`

**为什么重要**：这句话是本报告里最重要的一句厂商原文——**OpenAI 在自己的性能文档里，把缓存探测攻击写成了一个需要防御的已知风险，并给出了防御手段。** 直接接上 L14。见第 8 节。

---

### INV-19 · `usage` 里的 cached token 数就是真实命中数

**实际**：在 OpenAI GPT-5.5 及更早的模型上，它被**向下取整到 128 的倍数**，并且**扣掉了你看不见的隐藏 system token**。

> "Reported `cached_tokens` is calculated by subtracting the hidden system tokens from the last matched breakpoint, then **rounding down to the nearest multiple of 128**." `[P]`
> 模型差异表：「Cached-token reporting | GPT-5.6 and later: Exact eligible boundary, excluding hidden tokens | GPT-5.5 and GPT-5.5 Pro: Excludes hidden tokens and rounds down to a multiple of 128 | Other earlier models: 同上」`[P]`

Azure 复述：
> "On GPT-5.5 and earlier models, cache hits after the first 1,024 tokens occur in 128-token increments. This rounding doesn't apply to GPT-5.6 models and later model families." `[P]`

而最低门槛的计算也排除隐藏内容：
> "**Tokens in the OpenAI-provided hidden system content do not count toward this minimum.**" `[P]`

**为什么重要**：这就是「报出来的数和账单对不上」的一个**有一手来源的**具体机制。它的方向是确定的：**报出来的 ≤ 实际命中的**（向下取整）。所以你算出来的节省是保守的。

---

### INV-20 · 重试是免费的

**实际**：失败的请求**也计入限额**，所以盲目重试会加深限流。

> "Note that unsuccessful requests contribute to your per-minute limit, so continuously resending a request won't work."
> —— OpenAI, *Rate limits*，访问 2026-09-15 `[P]`

OpenAI 还明确区分了两种 429，**其中一种和你的用量无关**：
> "A `slow_down` error can occur even when your traffic is within its requests-per-minute and tokens-per-minute limits. **It reflects how quickly traffic increased, not whether you exhausted those limits.**" `[P]`
> "As a rule of thumb, once your traffic reaches 1 million input tokens per minute (TPM), **increase it by no more than 50% every 15 minutes.**" `[P]`

Anthropic 有对应的概念：
> "You might also encounter 429 errors because of **acceleration limits** on the API if your organization has a sharp increase in usage. To avoid hitting acceleration limits, ramp up your traffic gradually and maintain consistent usage patterns." `[P]`

**为什么重要**：这意味着「指数退避」不够——你需要的是**限速器（限制发出速率）+ 退避**，而且扩容要有斜率上限。**一个只有退避没有限速的客户端，在 acceleration limit 面前会永远退避下去。**

---

### INV-21 · 429 一定带 `retry-after`，跟着它重试就行

**实际**：Anthropic 的**花费上限 429 没有 `retry-after`**，SDK 自动重试会一路失败。

> "The error type is `rate_limit_error`, the same as for a rate limit, but **the response has no `retry-after` header. Retrying, including the SDKs' automatic retries, fails until access resumes.**"
> "On the Messages API, `error.details.error_code` is `enforced_spend_limit_reached`. Use it to tell this response apart from a rate limit."
> —— Anthropic, *Rate limits § Reaching your spend cap*，访问 2026-09-15 `[P]`

而你**自己设的**上限走的又是另一条路：
> "When usage reaches a spend limit you set, requests return **HTTP 400** with error type `invalid_request_error`." `[P]`

**为什么重要**：三种「没钱/超限」在 HTTP 层面长得不一样（429 带 header / 429 不带 header / 400），而**只有一种该重试**。这是 L13 可观测性那节留下的尾巴在这里收。

---

### INV-22 · Priority Tier 是买延迟保证的标准方案

**实际**：Anthropic 的 Priority Tier **已经停售**。

> "Priority Tier capacity commitments are no longer available for purchase. Organizations with an existing commitment can continue to use Priority Tier through their contract end date, and this page remains available as a reference for them."
> —— Anthropic, *Service tiers*, docs.claude.com/en/api/service-tiers，访问 2026-09-15 `[P]`

取而代之的 fast mode 是 research preview，且**不改善 TTFT**（见 INV-23）。

OpenAI 那边 Priority processing 改名了：
> "Priority processing was renamed **Fast mode** on July 30, 2026. … You can use either `service_tier: "priority"` or `service_tier: "fast"` in your API requests." `[P]`

---

### INV-23 · fast mode / priority tier 让首 token 更快

**实际**：Anthropic 的 fast mode **明确说了不是**。

> "- Up to 2.5x higher output tokens per second compared to standard speed
> - **Speed benefits are focused on output tokens per second (OTPS), not time to first token (TTFT)**
> - Same model weights and behavior (not a different model)"
> —— Anthropic, *Fast mode*, docs.claude.com/en/docs/build-with-claude/fast-mode，访问 2026-09-15 `[P]`

而且它**会打掉缓存**（`speed` 是缓存失效条件之一）：
> 失效表一行：「Speed setting | Tools cache ✓ | System cache ✘ | Messages cache ✘ | Switching between `speed: "fast"` and standard speed invalidates system and message caches」`[P]`

**为什么重要**：在 agent 里，一步的耗时 ≈ TTFT + 输出长度 / OTPS。**fast mode 只动分母。** 对于「想一下、调个工具、再想一下」这种短输出多往返的形态，fast mode 的收益很小而价格翻倍——Anthropic 的价格倍率明确说会和缓存倍率叠乘：

> "Fast mode pricing stacks with other pricing modifiers: Prompt caching multipliers apply on top of fast mode pricing; Data residency multipliers apply on top of fast mode pricing" `[P]`

OpenAI 的 fast mode 给了具体数字：gpt-5.6-sol 的 fast mode 是标准价的 **2 倍**（$8 / $40 短上下文，$16 / $60 长上下文），SLA 是 **99.9% uptime，99% > 80 tokens per second**。`[P]`（openai.com/api-fast-mode/，抓取 2026-09-15）

---

### INV-24 · `speed: "fast"` 不支持的模型会报错

**实际**：Claude Opus 4.6 **既不报错也不加速**，静默跑标准速度。

> "Fast mode is not available on Claude Opus 4.6. Requests to `claude-opus-4-6` with `speed: "fast"` **do not return an error**: they run at standard speed and are billed at standard rates rather than fast mode's premium rates, and the response reports `usage.speed: "standard"`."
> "If you are using Claude Opus 4.6 and request fast mode, its behavior is unique. Instead of returning an error like other models that don't support fast mode, it **silently switches to standard speed**. Though there is no error with Opus 4.6, the `speed` field accurately shows `"standard"`."
> —— Anthropic, *Fast mode*，访问 2026-09-15 `[P]`

而 Opus 4.7 **会**报错。同一个参数，相邻两个版本，三种行为（4.6 静默降级 / 4.7 报错 / 4.8 和 5 正常）。

**为什么重要**：**这是整节课「从 usage 反推」方法论的最干净的范例**——厂商自己承认了静默降级，同时给了一个可读回的字段来检测它。第 9 节的实验就照这个形状做。

---

### INV-25 · 兼容层缺什么，看文档就知道了

**实际**：**Anthropic 自己的 OpenAI 兼容层把这件事写成了一句总纲**：

> "**Most unsupported fields are silently ignored rather than producing errors.** These are all documented in the following sections."
> "Prompt caching is not supported, but it is supported in the Anthropic SDKs"
> —— Anthropic, *OpenAI SDK compatibility*, docs.claude.com/en/api/openai-sdk，访问 2026-09-15 `[P]`

被静默忽略的字段清单（一手，原文 `Ignored`）：`logprobs`、`metadata`、`response_format`、`prediction`、`presence_penalty`、`frequency_penalty`、`seed`、`service_tier`、`audio`、`logit_bias`、`store`、`user`、`modalities`、`top_logprobs`、`reasoning_effort`、`tools[n].function.strict`、`image_url.detail`。`[P]`

而且它**改写了你的请求**而不告诉你：
> "System/developer messages are hoisted and concatenated to the beginning of the conversation, as Anthropic only supports a single initial system message." `[P]`
> "the API takes all system/developer messages and concatenates them together with a single newline (`\n`) in between them." `[P]`

**为什么重要**：第 9 节的关键——**这条兼容层连「有没有命中」都告诉不了你**：
> 响应字段表：「`usage.completion_tokens_details` | **Always empty**」「`usage.prompt_tokens_details` | **Always empty**」「`logprobs` | Always empty」「`service_tier` | Always empty」`[P]`

**`prompt_tokens_details` 恒为空，意味着通过这条兼容层，`cached_tokens` 这个唯一的信号被抹掉了。** 这是「不可判定」这个状态在课程里必须存在的理由。

---

### INV-26 · 模型 ID 传错了会报错

**实际**：DeepSeek 的 Anthropic 兼容端点**静默映射**，而且**映射结果决定你的账单**。

> "**Note: When you pass an unsupported model name to DeepSeek's Anthropic API, the API backend will automatically map it to the `deepseek-flash` model.**"
> "- Models starting with claude-opus are mapped to `deepseek-v4-pro`
> - Models starting with claude-haiku or claude-sonnet are mapped to `deepseek-flash`
> **The claude-opus mapping points to `deepseek-v4-pro`, which is billed at the V4 Pro price.**"
> —— DeepSeek, *Using the Anthropic API*，访问 2026-09-15 `[P]`

按 DeepSeek 官方定价（抓取 2026-09-15），`deepseek-v4-pro` 的 cache miss 输入是 `deepseek-flash` 的 **4.4 倍**（$0.66 vs $0.15，off-peak），输出是 **3.3 倍**（$1.98 vs $0.6）。

**为什么重要**：一个从教程里抄来的 `model: "claude-opus-4-5"`，在这条端点上**不会报错、不会警告，只会把你的单价乘以 4.4**。而 `model: "claude-3-5-sonnet-20241022"` 会被映射到 flash。**模型 ID 在兼容层上是一个计费开关，不是一个标识符。**

---

## 2. 领域一：prompt caching 的真实机制与经济学

### 2.1 Anthropic

**来源**：docs.claude.com/en/docs/build-with-claude/prompt-caching，访问 2026-09-15。全部 `[P]`。

**两种启用方式**（2026 年的新结构，很多教程还停在只有 explicit 的时代）：
> "- **Automatic caching**: Add a single `cache_control` field at the top level of your request. The system automatically applies the cache breakpoint to the last cacheable block and moves it forward as conversations grow.
> - **Explicit cache breakpoints**: Place `cache_control` directly on individual content blocks for fine-grained control over exactly what gets cached."

**断点数量上限：4。**
> "You can define up to 4 cache breakpoints (using `cache_control` parameters) in your prompt."
> 自动缓存会占用其中一个：「When used together, the automatic cache breakpoint uses one of the 4 available breakpoint slots.」
> 边界情况：「If 4 explicit block-level breakpoints already exist, the API returns a 400 error (no slots left for automatic caching).」

**lookback window：20 个 block。**
> "The lookback window is 20 blocks. The system checks at most 20 positions per breakpoint, counting the breakpoint itself as the first. … On the Claude API, **a run of consecutive `tool_use` blocks counts as one position, and so does a run of consecutive `tool_result` blocks**, so a turn with many parallel tool calls doesn't push the previous request's entry out of the window on its own."

官方的三轮例子（非常适合改成 verify 用例）：
> "- Turn 1: 10 blocks, breakpoint on block 10. No prior cache entries exist. The system writes an entry at block 10.
> - Turn 2: 15 blocks, breakpoint on block 15. Block 15 has no entry, so the system walks back to block 10 and finds the turn-1 entry. Cache hit at block 10; the system processes only blocks 11 through 15 fresh and writes a new entry at block 15.
> - Turn 3: 35 blocks, breakpoint on block 35. The system checks 20 positions (blocks 35 through 16) and finds nothing. The turn-2 entry at block 15 is one position outside the window, so there is no cache hit."

**最小可缓存 token 数**：见 INV-5 的完整清单。补充一句平台无关性：
> "These minimums apply on every platform where each model is available."

**TTL 与计时起点**：见 INV-1。两档：
- 默认 5 分钟（`"ephemeral"` 是目前唯一支持的 type）
- 1 小时：`"cache_control": {"type": "ephemeral", "ttl": "1h"}`
> "The cache is refreshed for no additional cost each time the cached content is used."

**价格倍率**（抓取 2026-09-15）：
> "- 5-minute cache write tokens are **1.25 times** the base input tokens price
> - 1-hour cache write tokens are **2 times** the base input tokens price
> - Cache read tokens are **0.1 times** the base input tokens price (see the table footnote for per-model exceptions)"
> 例外：「Cache hits and refreshes on Claude Fable 5.1 and Claude Mythos 5.1 are priced at **0.025x** the base input price. All other models use the standard 0.1x multiplier.」

即：**未命中 : 命中 = 10 : 1（Fable 5.1 / Mythos 5.1 是 40 : 1）。**

倍率可叠乘：
> "These multipliers stack with other pricing modifiers such as the Batch API discount and data residency."

**命中判定：逐 token 前缀完全一致。**
> "**Exact matching**: Cache hits require 100% identical prompt segments, including all text and images up to and including the block marked with cache control."
> "Cache keys are generated using a cryptographic hash of the prompts up to the cache control point."
> "Because the hash is cumulative, covering everything up to and including the breakpoint, changing any block at or before the breakpoint produces a different hash on the next request."

**前缀顺序约束：`tools` → `system` → `messages`。**
> "Prompt caching references the entire prompt - `tools`, `system`, and `messages` (in that order) up to and including the block designated with `cache_control`."
> "Cache prefixes are created in the following order: `tools`, `system`, then `messages`. This order forms a hierarchy where each level builds upon the previous ones."
> "Changes at each level invalidate that level and all subsequent levels."

**混合 TTL 的计费公式**（这是一个可以直接做成 verify 的精确算法）：
> "You can use both 1-hour and 5-minute cache controls in the same request, but with an important constraint: **Cache entries with longer TTL must appear before shorter TTLs** (that is, a 1-hour cache entry must appear before any 5-minute cache entries)."
> "1. Position `A`: The token count at the highest cache hit (or 0 if no hits).
> 2. Position `B`: The token count at the highest 1-hour `cache_control` block after `A` (or equals `A` if none exist).
> 3. Position `C`: The token count at the last `cache_control` block.
> If `B` or `C` is larger than `A`, it is necessarily a cache miss, because `A` is the highest cache hit.
> You'll be charged for:
> 1. Cache read tokens for `A`.
> 2. 1-hour cache write tokens for `(B - A)`.
> 3. 5-minute cache write tokens for `(C - B)`."

**缓存预热**（新特性，`max_tokens: 0`）：
> "Set `max_tokens: 0` in your request. The API reads your prompt into the model and writes the cache at any `cache_control` breakpoint, then returns immediately without generating any output. The response has an empty `content` array, `stop_reason: "max_tokens"`, and a fully populated `usage` block."
> 一个坑：「Place the `cache_control` breakpoint on the last block that is shared with the follow-up request …, **not on the placeholder user message. Otherwise the cache entry is keyed to the placeholder and the follow-up request won't hit it.**」
> 另一个坑：「Use the same thinking configuration and `output_config.effort` as your follow-up requests too … **a pre-warm with a different configuration can write an entry your real traffic never hits.**」
> 「A pre-warm request incurs a cache write charge if the prefix is not already cached, the same as any other request.」

**并发的坑**：
> "For concurrent requests, note that a cache entry only becomes available after the first response begins. If you need cache hits for parallel requests, wait for the first response before sending subsequent requests."

**不能缓存的东西**：
> "- **Thinking blocks cannot be cached directly with `cache_control`.** However, thinking blocks CAN be cached alongside other content when they appear in previous assistant turns. When cached this way, they DO count as input tokens when read from cache.
> - Sub-content blocks (like citations) themselves cannot be cached directly.
> - Empty text blocks cannot be cached."

**数据保留**：
> "KV (key-value) cache representations and cryptographic hashes of cached content are held in memory only and are not stored at rest. Cached entries have a minimum lifetime of 5 minutes (standard) or 1 hour (extended), after which they are promptly, though not immediately, deleted."
> "Prompt caching (both automatic and explicit) is ZDR eligible."

---

### 2.2 缓存失效的完整触发表（Anthropic 官方，逐行）

> | What changes | Tools cache | System cache | Messages cache | Impact |
> |---|---|---|---|---|
> | Tool definitions | ✘ | ✘ | ✘ | Modifying tool definitions (names, descriptions, parameters) invalidates the entire cache |
> | Web search toggle | ✓ | ✘ | ✘ | Enabling/disabling web search modifies the system prompt |
> | Citations toggle | ✓ | ✘ | ✘ | Enabling/disabling citations modifies the system prompt |
> | Speed setting | ✓ | ✘ | ✘ | Switching between `speed: "fast"` and standard speed invalidates system and message caches |
> | Tool choice | ✓ | ✓ | ✘ | Changes to `tool_choice` parameter only affect message blocks |
> | Images | ✓ | ✓ | ✘ | Adding/removing images anywhere in the prompt affects message blocks |
> | Thinking parameters | Model-specific | Model-specific | ✘ | … |
> | Effort setting | Model-specific | Model-specific | ✘ | … |

`[P]`，访问 2026-09-15。

**用户问到的具体项目，逐条回答**：

| 改动 | 会不会失效 | 依据 |
|---|---|---|
| 改 system prompt | **会**，system + messages 全失效 | 层级规则 `[P]` |
| 改工具定义（名/描述/参数） | **会，整个缓存**（含 tools 层） | 上表第一行 `[P]` |
| 往历史中间插东西 | **会**，从插入点之后全部 | 累积哈希 `[P]` |
| 改 `temperature` / `top_p` / 采样参数 | **官方失效表里没有列出**。**查不到一手来源明确说它会失效。** 表里列出的是 `tool_choice`、images、thinking config、effort、speed、web search、citations —— 采样参数不在其中。 | 见下方说明 |
| 改 `tool_choice` | **会**，但只失效 messages 层 | 上表 `[P]` |
| 改 thinking 配置 / `output_config.effort` | **会**，messages 必失效，tools/system 视模型而定 | 上表 `[P]` |
| 换 API key（同 workspace） | **查不到一手来源**。文档只说隔离边界是 workspace/organization，没有提 API key 粒度。 | Anthropic 隔离章节 `[P]`（只到 workspace） |
| 换 region / `inference_geo` | Anthropic 文档未直接说明缓存跨 geo 的行为；**OpenAI 明说不行**：「cannot be reused across regional processing boundaries」`[P]` |
| 换模型 | **会**。cache diagnostics 有专门的 `model_changed` 类型：「The cache is per-model.」`[P]` |

> **关于采样参数**：严格按一手来源，**`temperature` 不在 Anthropic 公布的失效表里**。合理的推断 `[P2]` 是：缓存的是 prefill 阶段的 KV，而采样发生在 decode 阶段，所以 `temperature` 不应影响前缀哈希。DeepSeek 的文档给了一个侧面佐证：「The hard disk cache only matches the prefix part of the user's input. The output is still generated through computation and inference, and it is influenced by parameters such as temperature, introducing randomness.」`[P]` —— 但这不是 Anthropic 的陈述。**课上讲的时候要说清楚这一条是推断。**

**两个极其实用的失效陷阱（一手）**：
> "Verify that the keys in your `tool_use` content blocks have **stable ordering as some languages (for example, Swift, Go) randomize key order during JSON conversion, breaking caches**." `[P]`

> cache diagnostics 的 `tools_changed` 说明：「tools were added, removed, or reordered between turns, or tool `input_schema` JSON was **serialized non-deterministically**.」`[P]`

**一个反常识的「不失效」**（新特性）：
> "On Claude Fable 5.1, Claude Mythos 5.1, Claude Fable 5, Claude Mythos 5, Claude Opus 4.8, and Claude Opus 5, **you can add a new system instruction partway through a conversation without invalidating the system or message caches.** Append a `{"role": "system"}` message to `messages` instead of editing the top-level `system` field. … **This feature is not available on Claude Sonnet 5.**" `[P]`

---

### 2.3 OpenAI

**来源**：platform.openai.com/docs/guides/prompt-caching，访问 2026-09-15。全部 `[P]`。

**触发阈值**：
> "A prompt prefix must meet the model's minimum cacheable token length before it can be cached. **Tokens in the OpenAI-provided hidden system content do not count toward this minimum.** The minimum cacheable prompt length is **1,024 tokens for GPT-5.6 and later** and varies by request settings for earlier models."
> "For models before GPT-5.6, the minimum cacheable input length varies with request settings, including tools, images, output schemas, reasoning effort, and verbosity."

**折扣率**：cache read = **0.1×** uncached input；cache write = **1.25×**（仅 GPT-5.6+）。摘要里写的是 "discounted up to 90%"。

**TTL**：
> "Use `prompt_cache_options.ttl` to control the minimum cache lifetime. **The only supported value, `30m`, is also the default.** A cached prefix remains eligible for reuse for 30 minutes after its most recent write or reuse, though OpenAI may retain it longer."
> 旧模型走 `prompt_cache_retention`：
> "- `in_memory`: Entries typically remain active for around 5 to 10 minutes of inactivity, up to one hour.
> - `24h`: Extended retention typically keeps entries available for around 30 minutes and can retain them for up to 24 hours."
> "Organizations without Zero Data Retention enabled default to `24h`. Organizations with Zero Data Retention enabled default to `in_memory`."

**机器本地性与 15 RPM 溢出**：见 INV-17，原文已引。补充路由依据：
> "Within an organization and processing region, routing for a given model depends on:
> - Current machine load and available capacity.
> - A hash of the initial tokens after the hidden OpenAI content, including tool definitions when present. The number of tokens hashed varies by model.
> - A supplied `prompt_cache_key` …"

**`prompt_cache_key` 的当前状态**：见 INV-18。一句话：**GPT-5.6+ 上它从「性能参数」变成了「分账 + 防探测参数」，旧模型上仍是性能参数。**

**GPT-5.6+ 的显式断点**（这是新东西，很多人不知道 OpenAI 也有了）：
> "Set `prompt_cache_options.mode` to `explicit` … and mark each desired breakpoint by adding `prompt_cache_breakpoint: { "mode": "explicit" }` to a supported content block."
> "Each request can create up to **four cache writes**."
> "When no explicit breakpoints are placed, the request does not use prompt caching or create cache writes."
> 查找边界：「Explicit-only mode: The first 2 and latest 50 explicit breakpoints. Implicit mode: The first 2 and latest 50 explicit breakpoints, the implicit breakpoint, **up to 20 earlier eligible message endings**, and the endpoint of the initial consecutive block of developer messages.」

**三个官方「Gotchas」**（值得整节搬进讲义）：
1. "A shared prefix is not always a cached prefix" —— 隐式模式下，静态 developer message + 动态 user message，写入穿过了动态内容，下次不命中。
2. "Switching to explicit-only mode can miss an implicit cache write" —— 请求 1 用 implicit 写的条目，请求 2 切到 explicit 就找不到了。
3. "Extending a message can prevent reuse of its cached prefix" —— 把 `Content A` 扩成 `Content A + Content B` **在同一条消息里**，旧断点位置从「消息末尾」变成了「消息中间」，不再是查找边界。

**影响前缀的设置**（官方表）：`model`、`tools`、`parallel_tool_calls`、`text.format`（结构化输出）、`reasoning.effort`、`text.verbosity`、`context_management`（compaction）。`[P]`

**一个新的规避手段**：
> "On GPT-6 Astra, append a `configuration_update` input item to change reasoning effort between responses while keeping request-level `reasoning.effort` unchanged. This preserves the original prefix for cache reuse." `[P]`

以及工具集变化的规避：
> "- **Disable tool use for a request.** Set `tool_choice` to `"none"` instead of removing the tool definitions.
> - **Enable only selected tools.** Use `allowed_tools` to restrict which tools are callable while keeping the supplied `tools` list stable." `[P]`

> 注意这条和 Anthropic **相反**：Anthropic 的失效表里 `tool_choice` 改变**会**失效 messages 缓存。同一个技巧，一家推荐一家禁止。

---

### 2.4 Google Gemini

**Gemini API（AI Studio）**，ai.google.dev/gemini-api/docs/caching + /pricing，访问 2026-09-15：

> "**Implicit caching is enabled by default for all Gemini 2.5 and newer models.** … We automatically pass on cost savings if your request hits caches. There is nothing you need to do in order to enable this." `[P]`

最小 token 数（implicit）`[P]`：

| Model | Min token limit |
|---|---|
| Gemini 3.8 / 3.7 / 3.6 / 3.5 Flash | 4,096 |
| Gemini 3.1 Pro Preview | 4,096 |
| Gemini 2.5 Flash / 2.5 Pro | 2,048 |

> "You can see the number of tokens which were cache hits in the response object's `usage.total_cached_tokens` (Python and JavaScript) field." `[P]`

> ⚠️ 注意：新的 Interactions API **不支持显式缓存**——「The Interactions API only supports implicit caching. Explicit caching (manually creating and managing cache objects) is not supported in the Interactions API. To use explicit caching, switch to the generateContent API.」`[P]`

**存储时长计费（这是 Gemini 独有的一项，另两家没有）**，定价页抓取 2026-09-15 `[P]`：

以 Gemini 3.x Pro 档（input $1.50 / MTok，2027-01-01 起）为例：
> "Context caching price | $0.075 through December 31, 2026. $0.15 starting January 1, 2027. **$0.50 / 1,000,000 tokens per hour (storage price)** through December 31, 2026. **$1.00 / 1,000,000 tokens per hour (storage price)** starting January 1, 2027."

**这是一个和另两家结构完全不同的成本项**：Anthropic / OpenAI 按「写入次数」收费，Google 额外按「token × 小时」收费。做一个 100 万 token 的显式缓存放 24 小时，光存储费就是 $24（2027 年价）——**而这笔钱和你有没有用它无关。**

**Vertex AI / Gemini Enterprise Agent Platform**，cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview，页面自报 "Last updated 2026-09-09 UTC"，访问 2026-09-15 `[P]`：

> "For both implicit and explicit caching, you're billed for the input tokens used to create the cache at the standard input token price. For explicit caching, there are also storage costs based on how long caches are stored. **There are no storage costs for implicit caching.**"
> "Implicit caching provides a **90% discount** on cached tokens compared to standard input tokens."
> "Explicit caching … On Gemini 2.5 or later models, this discount is **90%**; on Gemini 2.0 models, this discount is **75%**."

限制表 `[P]`：
> | Minimum cache token count for implicit and explicit caching | Gemini 3 family models: **4,096** tokens; Gemini 3.0 Flash Preview, 3.1 Pro Preview, 3.7 Flash, and 3.8 Flash (implicit caching only): **6,144** tokens; Gemini 2 family models: **2,048** tokens |
> | Maximum size of content you can cache using a blob or text | **10 MB** |
> | Minimum time before a cache expires after it's created | **1 minute** |
> | Maximum time before a cache expires after it's created | **There isn't a maximum cache duration** |

默认 TTL：
> "Update a context cache's expiration time (Time to Live, or TTL) past the **default 60 minutes**." `[P]`

一个容易踩的坑：
> "Explicit caches interact with implicit caching, potentially leading to additional caching beyond the specified contents when creating a cache. **To prevent cache data retention, disable implicit caching and avoid creating explicit caches.**" `[P]`

隔离：Vertex 的 overview **没有直接陈述缓存的租户隔离粒度**（只说了 VPC-SC 边界：「your cache cannot be exfiltrated beyond your service perimeter」）。Anthropic 侧关于「Claude on Google Cloud 是 organization 级」的陈述是 Anthropic 说的，不是 Google 说的。**Google 自己对 Gemini 缓存隔离粒度的直接表述：查不到一手来源。**

---

### 2.5 计费 token 数 vs 消耗 token 数

**Anthropic 的字段语义**（`[P]`，已在 INV-2 引全）：
- `cache_creation_input_tokens` = 本次写入缓存的 token 数
- `cache_read_input_tokens` = 本次从缓存读取的 token 数
- `input_tokens` = **最后一个断点之后**的 token 数
- 总输入 = 三者之和

1 小时缓存开启后多一层拆分：
> ```json
> "cache_creation": { "ephemeral_5m_input_tokens": 148, "ephemeral_1h_input_tokens": 100 }
> ```
> "Note that the current `cache_creation_input_tokens` field equals the sum of the values in the `cache_creation` object." `[P]`

以及一个会让你困惑的现象：
> "If you see `ephemeral_5m_input_tokens` writes you didn't request while using server tools such as web search, see Tool use with prompt caching." `[P]`
> 即：**用了 server tool 时，你会看到自己没请求过的缓存写入。**

**OpenAI 的字段语义**（`[P]`）：
- `usage.input_tokens` = **总输入**（和 Anthropic 相反！）
- `usage.input_tokens_details.cached_tokens` = 命中数
- `usage.input_tokens_details.cache_write_tokens` = 写入数
- 普通 input = `input_tokens − cached_tokens − cache_write_tokens`

官方给的计费函数（可直接改写成 verify 用例）：
```js
const ordinaryInputTokens = inputTokens - cachedTokens - cacheWriteTokens;
const weightedInputTokens =
  ordinaryInputTokens + cachedTokens * 0.1 + cacheWriteTokens * 1.25;
```
`[P]`

> **⚠️ 这是本节最大的语义陷阱**：`input_tokens` 这个同名字段，在 Anthropic 是「断点之后的部分」，在 OpenAI 是「全部」。一份同时支持两家的成本账本，如果用同一套解析逻辑，**会在其中一家上算出严重错误的数字，而且不报错。**

**DeepSeek 的字段语义**（`[P]`，第三套）：
- `prompt_cache_hit_tokens` = 命中数
- `prompt_cache_miss_tokens` = 未命中数
- **没有「写入」这个概念**（因为写入不额外收费）

**「报出来的数和账单不一致」的已知情况**：

1. **OpenAI 旧模型向下取整到 128 的倍数**（INV-19）——`[P]`，方向确定：报出的 ≤ 实际。
2. **Anthropic cache diagnostics 的 `cache_missed_input_tokens` 明确不是计费数字**：
   > "It is derived from byte lengths before tokenization, so treat it as a **magnitude indicator rather than a billing number**. It can differ from (and occasionally exceed) `usage.input_tokens`." `[P]`
3. **Batch 可能超出 workspace 花费上限**：
   > "Because of high throughput and concurrent processing, **batches may go slightly over your Workspace's configured spend limit.**" `[P]`
4. **Anthropic 限流 header 的余量是取整过的**：
   > "`anthropic-ratelimit-tokens-remaining` | The number of tokens remaining (**rounded to the nearest thousand**) before being rate limited." `[P]`

除此之外，**「usage 报的数和发票上的数系统性不一致」这件事，查不到一手来源。** 上面四条都是「精度/口径差异」，不是「账单错误」。不要把它们讲成后者。

---

## 3. 领域二：模型路由分级

### 3.1 公开发表的、带数字的方案

**RouteLLM**（arXiv:2406.18665，v1 2024-06-26 / v4 2025-02-23），UC Berkeley + Anyscale + Canva。

评测条件（必须连着数字一起说，否则不可比）`[P]`：
- 强模型 `gpt-4-1106-preview`，弱模型 Mixtral-8x7B
- 训练数据：Chatbot Arena 80k battles（`D_arena`），可选增强 `D_gold`（MMLU validation ~1500 题）或 `D_judge`（GPT-4-as-a-judge）
- Benchmark：MMLU（14,042 题 / 57 学科）、MT Bench（160 题，LLM-as-a-judge）、GSM8K（1000+ 题）
- 做过去污染检查：「we conduct a cross-contamination check between our evaluation and training datasets, and report uncontaminated results below」

核心指标定义 `[P]`：
- **CPT(x%)**：达到 PGR = x% 所需的**最小强模型调用比例**
- **PGR** = `(r(router) − r(weak)) / (r(strong) − r(weak))`
- **APGR**：CPT 曲线下面积

**最好的结果**（MT Bench，`D_arena + D_judge`，Matrix Factorization）`[P]`：
- CPT(50%) = **13.40%**（随机是 49.03%）→ 强模型调用量降到约 1/3.7
- CPT(80%) = **31.31%**（随机 78.08%）
- APGR = **0.802**（+60.4%）
- 而 CPT(50%) 对应的绝对分数是 **8.8 / 9.3 = 95%**

**最差的结果**（GSM8K，仅 `D_arena`，BERT）`[P]`：APGR **0.438**，比随机（0.497）差 **11.8%**。

**跨模型对迁移**（Table 4，同一个 router 不重训）`[P]`：
- Claude 3 Opus / Claude 3 Sonnet：SW Ranking CPT(50%) = 23.27%，APGR 0.772（+56.6%）
- Llama 3.1 70B / Llama 3.1 8B：SW Ranking CPT(50%) = 21.18%，APGR 0.767（+49.8%）

> **该怎么引用这篇论文**：「RouteLLM 在 MT Bench 上、用 GPT-4 judge 增强数据训练的 matrix factorization router，把 GPT-4 调用比例从 49.03% 降到 13.40%，同时保住了 GPT-4 95% 的 MT Bench 分数。但同一批 router 在只用 Arena 数据训练时，在 GSM8K 上全部劣于随机路由。」——**这句话的每个成分都能追到一手来源。**

### 3.2 路由器本身是分类器，它会错分

**有没有一手数据说明错分率和代价？**

**部分有。** RouteLLM 的 APGR 本身就是「错分代价的积分」——APGR = 0.5 意味着「路由器提供的信息量等于零」。GSM8K 上 APGR 0.438 意味着**路由器提供了负信息量**：它系统性地把难题送给弱模型、把易题送给强模型。

但**「错分率」这个数字本身（confusion matrix 形式），论文里查不到**。论文报的是 CPT / PGR / APGR，不是 precision / recall。**不要编一个错分率。**

**另一个一手来源**（厂商侧，非学术）：Microsoft Foundry model router 用「质量带宽」定义了它允许自己犯多大的错：

> "- In **Balanced** mode (default), it considers all underlying models within a small quality range (for example, **1% to 2%** compared with the highest-quality model for that prompt) and picks the most cost-effective model.
> - In **Cost** mode, it considers a larger quality band (for example, **5% to 6%** compared with the highest-quality model for that prompt) and chooses the most cost-effective model.
> - In **Quality** mode, it picks the highest quality rated model for the prompt, ignoring the cost."
> —— Microsoft, *Model router for Microsoft Foundry concepts*, learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-router，访问 2026-09-15 `[P]`

**这是目前能找到的、厂商对「路由的质量代价」最明确的量化承诺：Balanced 模式 1–2 个百分点，Cost 模式 5–6 个百分点。** 注意措辞是 "for example"，不是 SLA。

### 3.3 官方的「按难度自动选模型」能力

| 厂商 | 名称 | 语义 | 来源 |
|---|---|---|---|
| Microsoft Foundry | **Model router**（版本 `2025-11-18`） | 一个**被训练过的语言模型**，实时按复杂度/推理需求/任务类型选底层模型。像普通模型一样部署。 | learn.microsoft.com `[P]` |
| OpenAI 直连 | **查不到一手来源**说有一个按难度自动选模型的官方 API | — | — |
| Anthropic 直连 | **查不到一手来源**。有 `service_tier: "auto"`，但那是**容量分级**不是模型选择 | docs.claude.com/en/api/service-tiers `[P]` |
| OpenRouter（第三方） | `openrouter/auto`，按「市场消费份额」而非质量评估选模型 | openrouter.ai `[P]`（第三方厂商的一手文档） |

**Foundry model router 的关键细节**（全部 `[P]`，访问 2026-09-15）：
> "Model router is a **trained language model** that intelligently routes your prompts in real time to the most suitable large language model (LLM)."
> "It does not store your prompts. It routes only to eligible models based on your access and deployment types, honoring data zone boundaries."

路由池（`2025-11-18` 版）跨厂商：OpenAI（`gpt-5.6-sol`/`terra`/`luna`、`gpt-5.5`、`gpt-5.4`(+mini/nano)、`gpt-5.2`、`gpt-5`(+mini/nano)、`o4-mini`、`gpt-4.1`系、`gpt-4o`系、`gpt-oss-120b`）、Anthropic（`claude-opus-4-8`/`4-7`/`4-6`、`claude-sonnet-4-5`、`claude-haiku-4-5`）、xAI（`grok-4-1-fast-reasoning`、`grok-4`）、DeepSeek（`DeepSeek-V3.2`）、Meta（`Llama-4-Maverick-17B-128E-Instruct-FP8`）。

**三个陷阱，全是官方自己写的**：

1. **上下文窗口塌缩到最小的那个模型**：
> "**The effective context window is limited by the smallest underlying model.** For larger contexts, use model subset to select models that support your requirements."
> "an API call with a larger context will succeed only if the prompt happens to be routed to the right model."
> **即：同一个长 prompt，路由到 A 成功，路由到 B 报错——非确定性失败。**

2. **路由和缓存互相打架**（这条直接回答了本节的核心取舍）：
> "Cache behavior depends on which underlying model the router selects for a given request. Because routing decisions might vary, **caching benefits apply only when the same model handles consecutive requests with overlapping prompt prefixes.**"
> "For stateless Chat Completions conversations, you can use **session affinity** to ask model router to attempt the same eligible model across related turns. This behavior can improve the opportunity for cache reuse, but **it doesn't inspect cache state, guarantee a cache hit, or adaptively switch models based on cache savings.**"

3. **自动更新会悄悄改变成本**：
> "If you select Auto-update at the deployment step …, your model router deployment automatically updates when new versions become available. When that happens, **the set of underlying models also changes, which could affect the overall performance of the model and costs.**"

计费：
> "Model router usage is charged for input prompts at the rate listed on the pricing page." `[P]`
> 即**路由器本身的输入 token 要收钱**——这是「路由的固定开销」的一手确认。具体单价本报告未抓取。

### 3.4 真实产品怎么做（有公开说明的部分）

有公开一手说明的只有 Foundry model router（上面已引）和 OpenRouter。OpenRouter 的 `openrouter/auto` 值得一提，因为它的选择依据**不是质量评估**：

> "The Auto Router routes on the wisdom of the market: what millions of people, in aggregate, spend on for exactly the kind of task your prompt represents. The rankings are computed from aggregate anonymized spend statistics."
> "2. Rank by real-world spend share. For that task type, the router looks up which models the OpenRouter community actually spends on over a **trailing 7-day window**"
> "Requests that set no cost setting route as if you had asked for roughly the `low` band."
> —— OpenRouter, *Auto Router*，访问 2026-09-15 `[P]`

**这是一个应该在课上点破的设计**：它把「哪个模型好」这个问题替换成了「大家在为哪个模型花钱」。这是一个合理的工程近似，但**它不是一个质量信号，它是一个流行度信号**，而且有 7 天的滞后。

至于「Cursor / Claude Code / GitHub Copilot 内部怎么路由」——**查不到一手来源**。这些产品没有公开发布过带数字的路由方案。**不要在课上转述博客里的说法。**

### 3.5 反直觉：便宜模型重试 vs 一次贵模型

**这个论点有没有带数字的一手来源？**

**没有直接的一手来源。** 我没有找到任何厂商文档或论文，直接测量「便宜模型 k 次重试的总成本 vs 贵模型一次」。**这条不能当作有一手依据的事实来讲。**

**但它可以被做成一个纯算术的、可验证的推导**，输入全部来自一手定价——这正好符合本节的实验约束。以 DeepSeek 官方定价（抓取 2026-09-15，off-peak）为例：

| | flash | v4-pro | 比值 |
|---|---|---|---|
| 输入（cache miss） | $0.15 / MTok | $0.66 / MTok | 4.4× |
| 输入（cache hit） | $0.003 / MTok | $0.022 / MTok | 7.33× |
| 输出 | $0.6 / MTok | $1.98 / MTok | 3.3× |

**盈亏平衡点的推导**（纯代数，`[P2]`，输入是一手价格）：

设单次调用成本 `c_weak`、`c_strong`，弱模型单次成功率 `p`，最多重试 `k` 次。
- 「先弱后强」的期望成本 = `c_weak · E[尝试次数] + (1−p)^k · c_strong`
- 全强模型 = `c_strong`
- 令 `r = c_strong / c_weak`，则策略更优的条件是：
  `(1 − (1−p)^k) / p + (1−p)^k · r < r`

代入 `r = 3.3`（输出主导的场景）：
- `p = 0.9, k = 3`：弱侧期望约 1.11 次 → 1.11 + 0.001×3.3 = **1.11 < 3.3** ✅ 划算
- `p = 0.5, k = 3`：1.75 + 0.125×3.3 = **2.16 < 3.3** ✅ 仍划算
- `p = 0.3, k = 2`：1.3 + 0.49×3.3 = **2.92 < 3.3** ✅ 勉强
- `p = 0.2, k = 2`：1.2 + 0.64×3.3 = **3.31 > 3.3** ❌ **翻车**

**结论（这是可以讲的，因为它是算术）**：在 `r ≈ 3.3` 的价差下，**弱模型成功率跌到 20% 左右就到了盈亏平衡点**。价差越小，平衡点越高。**当 `r < 2` 时，即使 `p = 0.5` 也几乎不划算。**

**agent 场景下「每步便宜但步数翻倍」的账怎么算**——这是上面那个模型的真正难点，它有两个乘数而不是一个：

1. **步数乘数**：弱模型走 `2n` 步，强模型走 `n` 步。
2. **上下文乘数**：第 `i` 步的输入是前 `i−1` 步的累积。总输入 token 数是 `O(n²)`，不是 `O(n)`。所以步数翻倍 → **输入 token 数翻四倍**。

这是本节最该讲透的一笔账，而且它完全可以在 verify 里算：

```
总输入(n 步, 每步新增 d token, 基础前缀 B)
  = Σ_{i=1..n} (B + (i−1)·d)
  = n·B + d·n(n−1)/2
```

`n = 10, B = 5000, d = 500` → 72,500 token
`n = 20, B = 5000, d = 500` → 195,000 token（**2.7 倍，不是 2 倍**）

**再叠上缓存**，结论会翻转：如果前缀稳定、缓存命中，每步的**新增**部分才是全价，累积部分按 0.1× 计。那么：
```
有缓存的总输入成本 ≈ (B + n·d)·1.25 + (n·B + d·n(n−1)/2 − B − n·d)·0.1
```
`n = 20` 的场景下，未缓存 195,000 → 等效约 **35,700** token，**降到 18%**。

> **这就是本节的中心算式。** 它说明：**「步数翻倍」的惩罚是超线性的，而「缓存」恰好把超线性的那一部分打到 0.1 倍。** 所以「便宜模型多走几步」这个策略，**在缓存生效时可行，在缓存失效时是灾难**——而模型路由恰恰是打掉缓存的头号原因（`model_changed`，见 INV-24 与 3.3 节）。

---

## 4. 领域三：并发、限流、重试

### 4.1 各家限流机制对照

| | Anthropic | OpenAI | DeepSeek |
|---|---|---|---|
| 算法 | **token bucket**（官方明说） | 未明说算法 | **并发数**，不是速率 |
| 维度 | RPM / ITPM / OTPM，**输入输出分开** | RPM / RPD / TPM / TPD / IPM | 并发连接数 |
| 缓存命中计入？ | **否**（Haiku 3.5 除外） | **是** | 未说明 |
| `max_tokens` 计入？ | **否** | **是**（取 max） | 未说明 |
| 作用域 | organization（可按 workspace 下调） | organization **和** project | account（跨 API key） |

Anthropic `[P]`：
> "The API uses the **token bucket algorithm** to do rate limiting. This means that your capacity is continuously replenished up to your maximum limit, rather than being reset at fixed intervals."
> "You might hit rate limits over shorter time intervals. For instance, **a rate of 60 requests per minute (RPM) might be enforced as 1 request per second.** Short bursts of requests can exceed the limit and trigger rate limit errors."
> "ITPM rate limits are estimated at the beginning of each request, and the estimate is adjusted during the request to reflect the actual number of input tokens used."
> "Rate limits are currently shared across all `inference_geo` values."

DeepSeek `[P]`（和另两家结构完全不同，值得课上专门对比）：
> "| | deepseek-flash | deepseek-v4-pro |
> | Concurrency Limit | **2500** | **500** |"
> "A request counts as one concurrent connection **from the time it is sent until the model response is complete**"
> "Concurrency limits are calculated at the **account level, regardless of which API Key is used**"
> "If the request has not started inference after **10 minutes**, the server will close the connection."

> **这是本节一个很好的教学点**：按并发计费的系统里，**长输出会占住一个槽位**，所以「限制输出长度」在 DeepSeek 上**确实**能提高有效吞吐——而在 Anthropic 上（`max_tokens` 不计入 OTPM）完全没这个效果。**同一个优化动作，在两家的价值截然不同。**

### 4.2 429 响应的 header（确切名字）

**Anthropic**（`[P]`，docs.claude.com/en/api/rate-limits）：

| Header | 含义 |
|---|---|
| `retry-after` | 等待秒数。**不随花费上限 429 返回。** |
| `anthropic-ratelimit-requests-limit` / `-remaining` / `-reset` | 请求数三件套（`-reset` 是 RFC 3339） |
| `anthropic-ratelimit-tokens-limit` / `-remaining` / `-reset` | **最严格的那个限制**的值 |
| `anthropic-ratelimit-input-tokens-limit` / `-remaining` / `-reset` | 输入 token |
| `anthropic-ratelimit-output-tokens-limit` / `-remaining` / `-reset` | 输出 token |
| `anthropic-priority-input-tokens-*` / `-output-tokens-*` | Priority Tier 专用（6 个） |
| `anthropic-workspace-id` | 这次请求算到哪个 workspace 头上 |
| `anthropic-fast-input-tokens-*` / `-output-tokens-*` | fast mode 专用（6 个） |

> "The `anthropic-ratelimit-tokens-*` headers display the values for the **most restrictive limit currently in effect**." `[P]`
> `-remaining` 一律 "rounded to the nearest thousand"。`[P]`

**OpenAI**（`[P]`）：`Retry-After`、`x-ratelimit-limit-requests`、`x-ratelimit-limit-tokens`、`x-ratelimit-remaining-requests`、`x-ratelimit-remaining-tokens`、`x-ratelimit-reset-requests`、`x-ratelimit-reset-tokens`、`x-ratelimit-limit-project-tokens`、`x-ratelimit-remaining-project-tokens`、`x-ratelimit-reset-project-tokens`。

注意 reset 的格式差异：Anthropic 是**绝对时间**（RFC 3339），OpenAI 是**相对时长字符串**（`"6m0s"`、`"1s"`）。**一份同时支持两家的退避逻辑必须分别解析。**

> "`Retry-After` may be present on `429` responses caused by a temporary rate limit and `503` responses caused by temporary model overload. **It does not mean that quota, billing, or other errors that require user action can be resolved by retrying.**" `[P]`

### 4.3 流式请求怎么计入限额

**一手来源有，但很薄。**

Anthropic：**没有针对流式的单独规则**。ITPM 在请求开始时估算并在过程中修正；OTPM「evaluated in real time as output tokens are produced」——**这句话本身就隐含了流式和非流式计入方式相同**。`[P2]`

OpenAI 给了一条**错误处理**上的流式规则，这条很重要：
> "For streaming requests, these HTTP error responses apply **before the stream starts**. An error after streaming begins can arrive as a **stream event**; **don't automatically replay a request after consuming output.**" `[P]`

即：**流已经开始之后的失败，不是 HTTP 错误，而是一个 SSE 事件**，SDK 的自动重试逻辑看不到它。**一个只在 HTTP 层重试的客户端，会在流中断时静默丢数据。**

Anthropic 侧有一条对应的硬约束（Batch 不支持流）：
> "`stream: true` | Batch results come back as a single file, not a stream." `[P]`

DeepSeek 的流式 keep-alive 也值得一提：
> "Streaming requests: Continuously return SSE keep-alive comments (`: keep-alive`)"
> "Non-streaming requests: Continuously return empty lines" `[P]`
> **一个不处理注释行的手写 SSE parser 会在这里崩。** L02 写的流式读取器正好可以在这一节回来被打一次。

**「流式请求在限额上和非流式有区别」——查不到一手来源支持这个说法。** 三家的文档都没有把流式单列为限额维度。

### 4.4 长输出、thinking / reasoning token 怎么计入

- **Anthropic**：OTPM 实时按实际产出计。thinking token 计入 output。从缓存读回的 thinking block **计入 input**：
  > "**Input token counting**: When thinking blocks are read from cache, they count as input tokens in your usage metrics." `[P]`
- **Gemini**：定价页对每个模型都写「Output price (**including thinking tokens**)」。`[P]`
- **OpenAI**：`reasoning_tokens` 在 `completion_tokens_details` 下（见 Azure 的 usage 示例）。`[P]`
- **Anthropic 超长输出**：
  > "A single 300k-token generation can take over an hour to complete, so plan your batch submissions with the 24-hour processing window in mind." `[P]`

### 4.5 官方推荐的退避策略 / 明确反对的做法

**OpenAI 明确推荐的**（`[P]`）：
> "Treat this value as a minimum: wait at least that long and **add a small random delay** so multiple clients don't retry at the same time."
> "If it's missing or invalid, fall back to **exponential backoff with jitter**. **Limit both the number of attempts and the total time spent retrying.**"
> "If you manage retries in your application, **disable SDK retries or account for them in those limits so nested retry loops don't multiply requests.**"

**OpenAI 明确反对的**（`[P]`）：
> "**Don't retry quota, billing, or other errors that require you to take action.**"
> "**don't automatically replay a request after consuming output.**"
> "**If a valid server delay exceeds the supported or configured maximum retry delay, stop retrying and defer the request rather than retrying sooner.**"
> "Note that unsuccessful requests contribute to your per-minute limit, so **continuously resending a request won't work.**"

以及一条对官方自己示例代码的警告（少见且值得引）：
> "The Python examples below demonstrate fallback backoff. **They don't inspect `Retry-After`: before using them, add handling for valid server hints so the wrappers don't retry sooner than requested.**" `[P]`

**Anthropic 明确反对的**（`[P]`）：
> "To avoid hitting acceleration limits, **ramp up your traffic gradually and maintain consistent usage patterns.**"
> 花费上限 429：「Retrying, including the SDKs' automatic retries, **fails until access resumes.**」

**斜率上限的具体数字**（`[P]`）：
- OpenAI 通用：「once your traffic reaches **1 million input tokens per minute (TPM)**, increase it by **no more than 50% every 15 minutes**」
- OpenAI Fast mode 降级触发条件：「the ramp rate limit may apply if you're sending **at least 1 million TPM and >50% TPM increase within 15 minutes**」，降级后 `service_tier` 返回 `"default"`

### 4.6 并发的反转：为什么 N → 2N 吞吐不翻倍

见 INV-15。三条一手机制：

1. **prefill 不吃 batching**（Sarathi-Serve Takeaway-1）`[P]`
2. **generation stall**：新请求的 prefill 会打断在跑的 decode。「1a highlights one of the many generation stalls lasting over **several seconds** in vLLM」`[P]`
3. **限流本身**：更高并发 → 更容易触发 429 → 失败请求仍占额度（INV-20）→ 有效吞吐反而下降 `[P]`

再加一条厂商侧的：**OpenAI 的 15 RPM 缓存溢出**（INV-17）意味着**提高并发会降低缓存命中率**，从而提高单位成本。`[P]`

Sarathi-Serve 的正面数字（说明这是个调度问题，不是物理上限）`[P]`：
> "For Mistral-7B on single A100 GPUs, we achieve **2.6x** higher serving capacity and up to **3.7x** higher serving capacity for the Yi-34B model on two A100 GPUs as compared to vLLM. When used with pipeline parallelism on Falcon-180B, Sarathi-Serve provides up to **5.6x** gain in the end-to-end serving capacity."

注意 "capacity" 的定义带了延迟约束：
> "we use a throughput metric, **Capacity**, defined as the maximum request load (queries-per-second) a system can sustain **while meeting certain latency targets**." `[P]`
> **一个不带延迟约束的吞吐数字没有意义。** 这是本节该教的判定标准。

---

## 5. 领域四：批处理（Batch API）

### 5.1 三家对照（全部 `[P]`，访问 2026-09-15）

| | Anthropic Message Batches | OpenAI Batch | Gemini Batch |
|---|---|---|---|
| 折扣 | **50%** | **50%** | **50%** |
| 承诺完成时间 | "most batches completing within 1 hour"；**24 小时过期** | "Each batch completes within **24 hours**" | 目标 24 小时；**48 小时过期** |
| 规模上限 | **100,000 条**或 **256 MB**，先到为准 | 文件 **200 MB** | 输入文件 **2 GB** |
| 结果保留 | **29 天**（从 `created_at` 算，不是 `ended_at`） | — | — |
| 作用域 | **Workspace** | — | — |
| 与缓存叠加 | **可以叠加**，best-effort，命中率 30%–98% | 未在缓存文档中明确 | 支持，但「pay the standard context caching rates」 |
| 队列限额 | 排队中的 batch request 数（Start 200k / Build 300k / Scale 500k） | 按排队的 input token 总数计 | — |

### 5.2 失败语义（部分失败怎么办）

**Anthropic 的四态，以及计费规则**（`[P]`，这是三家里最清楚的）：

> | Result type | Description |
> |---|---|
> | `succeeded` | Request was successful. Includes the message result. |
> | `errored` | Request encountered an error and a message was not created. … **You will not be billed for these requests.** |
> | `canceled` | User canceled the batch before this request could be sent to the model. **You will not be billed for these requests.** |
> | `expired` | Batch reached its 24-hour expiration before this request could be sent to the model. **You will not be billed for these requests.** |

**三条极其重要的操作细节**：
> "**Batch results may not match input order**" + "Use meaningful `custom_id` values to easily match results with requests, since order is not guaranteed." `[P]`
> "Validation of the `params` object for each message request is performed **asynchronously**, and validation errors are returned **when processing of the entire batch has ended.**" `[P]`
> —— **即：一个拼错字段名的请求，你要等到整个 batch 跑完才知道。** 官方的对策：「Dry run a single request shape with the Messages API to avoid validation errors.」`[P]`
> "Canceled batches end up with a status of `ended` and **may contain partial results** for requests that were processed before cancellation." `[P]`

**错误分类的可重试性**（官方示例代码里的判断逻辑，可直接做成 verify）：
> ```python
> case "errored":
>     if result.result.error.error.type == "invalid_request_error":
>         # Request body must be fixed before re-sending request
>     else:
>         # Request can be retried directly
> ```
> `[P]`

**Gemini 的状态机** `[P]`：`JOB_STATE_RUNNING` / `JOB_STATE_SUCCEEDED` / `JOB_STATE_FAILED` / `JOB_STATE_CANCELLED` / `JOB_STATE_EXPIRED`（"expired because it was running or pending for more than **48 hours**"）。

Gemini 的一个坑：
> "**Submit jobs once**: The creation of a batch job is **not idempotent**. If you send the same creation request twice, two separate batch jobs will be created." `[P]`
> —— 在一个有重试逻辑的 CI 里，这条会让你付两次钱。

### 5.3 Batch 里不能用的参数

Anthropic 明确拒绝三个 `[P]`：
> | `stream: true` | Batch results come back as a single file, not a stream. |
> | `speed` (Fast mode) | Fast mode tunes synchronous latency, which doesn't apply to asynchronous batch processing. |
> | `max_tokens: 0` | （缓存预热，见 INV-8） |

### 5.4 Batch 在什么场景下根本不适用

**agent 的交互回路显然不行**——这不需要来源，它是定义问题：batch 的语义是「提交一批、异步等结果」，而 agent loop 的第 `i` 步依赖第 `i−1` 步的输出。

但**有两个更微妙的不适用场景，有一手依据**：

1. **需要缓存的长上下文重复查询，在 Bedrock 上不能用 batch**（INV-8）`[P]`
2. **超长输出的 batch 有过期风险**：「A single 300k-token generation can take over an hour to complete, so plan your batch submissions with the 24-hour processing window in mind.」`[P]` + 「processing may be slowed down based on current demand and your request volume. In that case, **you may see more requests expiring after 24 hours.**」`[P]`

### 5.5 Batch 在 agent 工程里真正的用处：跑 evals

这不是推测，**OpenAI 把它列在了 Batch 用例的第一条**：

> "Batch processing jobs are often helpful in use cases like:
> 1. **Running evaluations**
> 2. Classifying large datasets
> 3. Embedding content repositories
> 4. Queuing large offline video-render jobs"
> —— OpenAI, *Batch API*，访问 2026-09-15 `[P]`

Google 也是：
> "Use Batch API for large-scale, non-urgent tasks such as data pre-processing or **running evaluations** where an immediate response is not required." `[P]`

**这条直接接 L12。** L12 那节建的 eval suite，如果跑一次要调 500 次模型，用 batch 就是**一半的钱**，代价是从「几分钟」变成「最多 24 小时」。而 eval 恰好是全课里**唯一**能接受 24 小时延迟的工作负载。

**再叠上缓存**：eval suite 的每个用例通常共享同一个 system prompt + 同一套工具定义。用 Anthropic 的 1 小时缓存 + 先发一条预热请求（5.1 节引的官方序列），可以在 50% batch 折扣之上再叠 90% 的前缀折扣。**这是全课能算出来的最大的一笔节省，而且它落在一个真实的工程场景上。**

---

## 6. 领域五：兼容层的特性缺口

> **L00 承诺的「L15 会专门做一次实测来量这个缺口」，在这一节兑现。而好消息是：本课用的 provider 自己把缺口清单写在文档里了，不用猜。**

### 6.1 DeepSeek 的 Anthropic 兼容端点（本课直接相关）

**来源**：api-docs.deepseek.com/guides/anthropic_api，访问 2026-09-15。全部 `[P]`。
**base_url**：`https://api.deepseek.com/anthropic`

**HTTP Header**：

| Field | Support Status |
|---|---|
| `anthropic-beta` | Ignored for `/messages`; required (`files-api-2025-04-14`) for Files API endpoints |
| `anthropic-version` | **Ignored** |
| `x-api-key` | Fully Supported |

**Simple Fields**（挑出有成本/性能含义的）：

| Field | Support Status | 本节含义 |
|---|---|---|
| `model` | Use DeepSeek Model Instead | **静默映射，决定单价**（INV-26） |
| `metadata` | `user_id` is supported, others are ignored | **KVCache 隔离的唯一开关** |
| `service_tier` | **Ignored** | 服务分级不可用 |
| `thinking` | Supported (**`budget_tokens` is ignored**) | 想控制 thinking 成本？不行 |
| `output_config` | Only `effort` is supported | |
| `top_k` | **Ignored** | |
| `top_p` | Only takes effect in thinking mode (lower bound `0.95`); **in non-thinking mode it is fixed at `1.0`** | |
| `temperature` | Fully Supported (range [0.0 ~ 2.0]) | |

**`cache_control` 的四处 `Ignored`**（这就是「实测的缺口」本身）：

| 位置 | Support Status |
|---|---|
| `tools[n].cache_control` | **Ignored** |
| `content` array `type="text"` → `cache_control` | **Ignored** |
| `content` array `type="tool_use"` → `cache_control` | **Ignored** |
| `content` array `type="tool_result"` → `cache_control` | **Ignored** |

**其它高级特性**：

| 特性 | 状态 |
|---|---|
| vision（`type="image"`） | **Supported**（base64: jpeg/png/gif/webp，或 url，或 file） |
| `type="document"` | **Not Supported** |
| `type="search_result"` | **Not Supported** |
| `type="thinking"` | Supported |
| `type="redacted_thinking"` | **Not Supported** |
| `tool_choice`（`none`/`auto`/`any`/`tool`） | Supported，但 **`disable_parallel_tool_use` is ignored** |
| `citations` | **Ignored** |
| `is_error`（tool_result） | **Ignored** |
| `mcp_tool_use` / `mcp_tool_result` | **Not Supported** |
| `code_execution_tool_result` | **Not Supported** |

> **注意「Ignored」和「Not Supported」在这份表里是两个不同的词。** 从文档结构判断（`[P2]`），`Not Supported` 更可能报错，`Ignored` 一定不报错。**课上要让学生自己发现这个区别。**

### 6.2 Anthropic 自己的 OpenAI 兼容端点

**来源**：docs.claude.com/en/api/openai-sdk，访问 2026-09-15。全部 `[P]`。

总纲三句，逐字：
> "This compatibility layer is primarily intended to **test and compare model capabilities**, and is not considered a long-term or production-ready solution for most use cases."
> "**Prompt caching is not supported**, but it is supported in the Anthropic SDKs"
> "**Most unsupported fields are silently ignored rather than producing errors.**"

被静默忽略的请求字段（一手清单）：
`logprobs`、`metadata`、`response_format`、`prediction`、`presence_penalty`、`frequency_penalty`、`seed`、`service_tier`、`audio`、`logit_bias`、`store`、`user`、`modalities`、`top_logprobs`、`reasoning_effort`、`tools[n].function.strict`、`functions[n].strict`、`image_url.detail`、各 role 的 `name`、`assistant.refusal`、`assistant.audio`。

被**改写**的（不是忽略，是改写）：
> "System/developer messages are hoisted and concatenated to the beginning of the conversation … the API takes all system/developer messages and concatenates them together with a single newline (`\n`) in between them."

被**静默截断**的：
> "`temperature` | Between 0 and 1 (inclusive). **Values greater than 1 are capped at 1.**"
> —— 传 `temperature: 1.5` 不报错，按 1.0 跑。

**响应端「Always empty」清单**（这是本节实验的关键）：
`usage.completion_tokens_details`、**`usage.prompt_tokens_details`**、`choices[].message.refusal`、`choices[].message.audio`、`logprobs`、`service_tier`、`system_fingerprint`、`openai-processing-ms`。

> **`prompt_tokens_details` 恒为空 = `cached_tokens` 恒不可见 = 缓存是否生效在这条通道上不可判定。**
> 这不是「没命中」，是「测不出来」。**课程必须教这第三种状态。**

### 6.3 有没有厂商文档里的「不支持」清单？

**有，而且不止一份。** 上面两份（DeepSeek、Anthropic）都是厂商自己维护的、逐字段的支持状态表。这已经回答了这个问题——**不需要去 issue tracker 上找。**

补充两条：
- Bedrock 上的 Anthropic 自动缓存不可用：「Automatic caching is available on every platform **except the legacy Amazon Bedrock (Opus 4.6 and earlier) integration**. On that integration, the API returns a **400 error** for a top-level `cache_control` field」`[P]` ← **这条是报错的，不是静默的。**
- Cache diagnostics 不可用于任何云平台：「Platforms: Claude API (beta); **not available on Claude Platform on AWS, Amazon Bedrock, Google Cloud, Microsoft Foundry**」`[P]`

### 6.4 最阴的情况是不报错：怎么从 `usage` 反推缓存到底生效了没有

**这是本节交付物的核心。** 一手来源给了三条判定规则，可以拼成一个完整的判定器。

**规则 A（Anthropic 直连，官方给的判定法）**：
> "To verify whether a prompt was cached, check the response usage fields: **if both `cache_creation_input_tokens` and `cache_read_input_tokens` are 0, the prompt was not cached**" `[P]`

**规则 B（OpenAI / Bedrock 上的 GPT-5.6，官方给的判定法）**：
> "When `cached_tokens` is greater than zero and `cache_write_tokens` is zero, your request fully matched an existing cache entry — no new writes occurred, and you received the maximum cost savings." `[P]`

**规则 C（Anthropic fast mode，同构的「静默降级检测」）**：
> "The response `usage` object includes a `speed` field that indicates which speed was used, either `"fast"` or `"standard"`." `[P]`

**由此得出的四态判定器**（这是我建议课程交付的那个函数）：

| 输入（归一化后的 usage） | 判定 |
|---|---|
| 存在缓存字段 且 read > 0 | `HIT`（附命中比例） |
| 存在缓存字段 且 read == 0 且 write > 0 | `WRITE_ONLY`（**第一次是正常的，连续两次就是 bug**） |
| 存在缓存字段 且 read == 0 且 write == 0 | `MISS`（再查是否低于最低门槛 → `BELOW_MINIMUM`） |
| **缓存字段缺失 / 恒为空** | **`UNDETERMINABLE`** ← 兼容层的形状 |

**四种 provider 的字段形状（归一化表，一手）**：

| Provider | 命中字段 | 写入字段 | 非缓存输入字段 | 总输入 |
|---|---|---|---|---|
| Anthropic Messages | `cache_read_input_tokens` | `cache_creation_input_tokens` | `input_tokens`（**仅断点后**） | 三者之和 |
| OpenAI Responses | `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens` | `input_tokens − cached − write` | `input_tokens`（**已含全部**） |
| Azure Chat Completions | `prompt_tokens_details.cached_tokens` | `prompt_tokens_details.cache_write_tokens` | — | `prompt_tokens` |
| DeepSeek | `prompt_cache_hit_tokens` | **无此概念** | `prompt_cache_miss_tokens` | 两者之和 |
| Anthropic 的 OpenAI 兼容层 | **恒为空** | **恒为空** | `usage.prompt_tokens` | `prompt_tokens` |

`[P]`（各家文档，访问 2026-09-15）

**一个必须警告学生的判定陷阱**：**用响应时间（TTFT）来判断缓存是否命中，是错的做法**——它正是第 8 节要讲的那条侧信道，而且噪声极大。**官方的判定法全部是读字段，没有一家建议看时间。**

**Anthropic 的 cache diagnostics 提供了第二个维度**（这是目前最完整的一手判定框架，值得整表搬进讲义）：

> "`diagnostics` answers 'did my request change?' while `usage.cache_read_input_tokens` answers 'did the cache hit?'. Combining them tells you where to look."
>
> | Diagnostics result | Cache read tokens | Interpretation |
> |---|---|---|
> | `null` | high | Working as expected. Your prefix is stable and the cache hit. |
> | `null` | low or zero | Your requests match but the cache entry was no longer available. Consider shortening gaps between turns or using the 1-hour cache TTL. |
> | `cache_miss_reason` is a `*_changed` type | low or zero | **Your bug.** The request changed; fix the cause indicated by `type`. |
> | `cache_miss_reason` is a `*_changed` type | high | Rare. A change occurred late in the prompt but an earlier `cache_control` breakpoint still hit. |
>
> —— Anthropic, *Cache diagnostics*, platform.claude.com/docs/en/build-with-claude/cache-diagnostics，访问 2026-09-15 `[P]`

`cache_miss_reason.type` 的完整取值 `[P]`：`model_changed` / `system_changed` / `tools_changed` / `messages_changed` / `previous_message_not_found` / `unavailable`。
beta header：`cache-diagnosis-2026-04-07`。

**这张 2×2 表就是本节交付物的规格说明。** 它把「缓存没命中」拆成了两种**要采取不同行动**的情况：「你的代码变了」（改代码）vs「缓存过期了」（改 TTL 或改节奏）。**把这两种混为一谈，是缓存调优最常见的浪费时间方式。**

---

## 7. 领域六：延迟

### 7.1 TTFT vs 总时长在 agent 里的不同意义

一步的墙钟时间 ≈ `排队延迟 + TTFT + 输出 token 数 / OTPS`。

- **在聊天产品里**：TTFT 决定「感觉快不快」，因为流式输出一开始用户就有东西看。
- **在 agent 里**：用户看不到中间步骤的输出。**一个 15 步的 agent，用户感知的是 15 × (TTFT + 输出时间) 的总和。** TTFT 从 2 秒降到 1 秒，在 15 步里就是 15 秒——**TTFT 在 agent 里被步数放大了。**

这正是 L00 里 Cursor 那段「一顿一顿的节奏」说的事。

**哪些手段只改善感知延迟？**
- 流式输出：不改变总时长，只改变「第一个字出现的时间」。
- 并行工具调用：**真的**缩短总时长（如果工具真的能并行）。
- 「先吐出思考过程」：只改善感知。

### 7.2 首 token 延迟与 prompt 长度的关系

见 INV-16。一手结论：
- prefill 阶段线性算子占 >80% 运行时间，attention 是二次的 → **近似线性但上凸** `[P]`
- batching 对 prefill 吞吐几乎无效 `[P]`
- 1 个 decode token 的线性算子开销 ≈ 128 个 prefill token `[P]`

**「TTFT 随输入长度线性增长」——严格说不准确，但在常见长度范围内是好用的近似，且有一手数据支持这个近似（>80% 的时间来自线性算子）。**

### 7.3 缓存命中对 TTFT 的改善有没有官方数字

**查不到一手来源给出具体百分比。**

能找到的官方表述只有定性的：
> Anthropic：「The 5-minute and 1-hour cache behave the same with respect to latency. **You will generally see improved time-to-first-token for long documents.**」`[P]`
> Anthropic：「Cache pre-warming … eliminates the cache-miss latency penalty on the first user interaction, **reducing time-to-first-token (TTFT)** for latency-sensitive applications.」`[P]`
> OpenAI：「**Faster**: Reduce the time spent processing input before the response starts.」`[P]`
> Azure：「Prompt caching reduces overall request latency and cost for longer prompts…」`[P]`

> **三家都只说「更快」，都不给数字。** 历史上 Anthropic 曾在 2024 年的发布博客里给过「up to 85% latency reduction」这类数字，但那是博客不是文档，而且当前文档里已经没有了。**本报告不引用它。课上如果要给延迟数字，只能是学生自己测的，并且必须标明测量条件。**

侧面佐证（学术，非厂商）：CVE-2025-46570 的实验说明**命中/未命中的时间差大到可以做统计分类**——8 token 前缀的 ROC AUC 达到 0.99 `[P]`。这说明差异是**显著的**，但那是 vLLM 本地部署的测量，不能外推到托管 API 的绝对数值。

### 7.4 官方的延迟服务分级

| 厂商 | 名称 | 参数 | 价格关系 | 延迟承诺 |
|---|---|---|---|---|
| Anthropic | **Priority Tier** | `service_tier: "auto"` / `"standard_only"` | 容量承诺制 | "targets **99.5% uptime**"；**已停售** |
| Anthropic | **Fast mode**（research preview） | `speed: "fast"` + beta header `fast-mode-2026-02-01` | 标准价的倍率（仅 Opus 5 / Opus 4.8） | **up to 2.5x OTPS，明确不改善 TTFT** |
| OpenAI | **Fast mode**（原 Priority processing，2026-07-30 改名） | `service_tier: "fast"` 或 `"priority"` | gpt-5.6-sol **2×**（$8/$40 短上下文，$16/$60 长上下文） | **99.9% uptime；99% > 80 tokens per second** |
| OpenAI | Batch | — | **0.5×** | 24 小时 |
| Anthropic | Batch | — | **0.5×** | 24 小时（多数 <1 小时） |

全部 `[P]`，访问/抓取 2026-09-15。

**价格与延迟的关系，三档一线**（这是课上最该画的那张图）：

```
                价格倍率
  Fast mode  ────  2.0×   ← 换 2.5× 的 OTPS（不是 TTFT）
  Standard   ────  1.0×
  Batch      ────  0.5×   ← 付出 24 小时
```

**再叠上缓存这条正交轴**：cache read 是 0.1×，且**和上面三档相乘**（Anthropic：「These multipliers stack with other pricing modifiers such as the Batch API discount and data residency.」`[P]`；「Prompt caching multipliers apply on top of fast mode pricing」`[P]`）。

所以理论最低单价 = `Batch(0.5×) × cache read(0.1×) = 0.05×`，即**标准输入价的 1/20**。这就是「砍一个数量级」这个学习目标的出处——**而且它是算出来的，不是拍的。**

一个补充的 `[P]`：OpenAI Fast mode 的降级是**静默的**，只能从 `service_tier` 字段读回：
> "If the ramp rate limit is exceeded, the response will show `service_tier="default"`." `[P]`
> —— **又一个「从 usage/response 字段反推真实发生了什么」的实例。**

---

## 8. 领域七：与 L14 的冲突

> L14 结尾的那句话是对的，而且比它说的更具体：**这一节要教的每一个优化手段，都对应 L14 建立的一条具体边界。**

### 8.1 prompt cache 作为侧信道：已发表的研究

**有，而且有 CVE。**

#### 8.1.1 CVE-2025-46570（vLLM 前缀缓存时序侧信道）

- **标识**：CVE-2025-46570 / GHSA-4qjh-9fv9-r85r / PYSEC-2025-53
- **NVD 发布**：2025-05-29；GitHub advisory 发布 2025-05-28
- **影响版本**：vLLM < 0.9.0（`0.9.0` 修复）
- **CVSS v3.1**：**2.6 (Low)**，向量 `CVSS:3.1/AV:N/AC:H/PR:L/UI:R/S:U/C:L/I:N/A:N`
- **CWE**：CWE-208（Observable Timing Discrepancy）

> "When a new prompt is processed, if the PageAttention mechanism finds a matching prefix chunk, the prefill process speeds up, which is reflected in the TTFT (Time to First Token). Our tests revealed that the timing differences caused by matching chunks are significant enough to be recognized and exploited."
> "For instance, if the victim has submitted a sensitive prompt or if a valuable system prompt has been cached, an attacker sharing the same backend could attempt to guess the victim's input. By measuring the TTFT based on prefix matches, the attacker could verify if their guess is correct, leading to potential leakage of private information."
> —— GHSA-4qjh-9fv9-r85r / osv.dev，访问 2026-09-15 `[P]`

**测出来的准确率**（这是你要的数字）：
> "- With a **1-token prefix**, the ROC curve yielded an **AUC value of 0.571**, indicating that even with a short prefix, an attacker can reasonably distinguish between cache hits and misses based on response times.
> - When the prefix length increases to **8 tokens**, the **AUC value rises significantly to 0.99**, showing that the attacker can almost perfectly identify cache hits with a longer prefix." `[P]`

实验环境（必须一起引）：LLaMA2-70B-GPTQ，NVIDIA A100 (40G)，CUDA 11.8，PyTorch 2.3.1，Ubuntu 18.04，vLLM v0.5.1，`chunk_size=2`。`[P]`

#### 8.1.2 PROMPTPEEK（NDSS 2025）

> "we propose PROMPTPEEK, which leverages the changes of serving order as side channel information, to repeatedly extract other users' prompts from the LLM service. … PROMPTPEEK utilizes the side channel information to monitor the KV cache hits and extracts one token at a time from another user's prompt."
> "Our results show that the adversary can achieve an average success rate of **99%** in fully or partially reversing the prompt input, **98%** in reversing the prompt template, and **95%** without additional background knowledge, when tested on a **Llama2-13B model on an A100 80G GPU**."
> —— *I Know What You Asked: Prompt Leakage via KV-Cache Sharing in Multi-Tenant LLM Serving*, NDSS Symposium 2025，访问 2026-09-15 `[P]`

**注意这是 99%，而 CVE 的评级是 Low (2.6)。** 这个落差本身就是一条反转（INV-19 的延伸）：**CVSS 评的是「在通用威胁模型下的可利用性」，论文测的是「在受控多租户环境下的成功率」。** 两个数字都对，回答的是不同问题。

#### 8.1.3 InputSnatch（arXiv:2411.18191）

> "For requests of specified lengths, our timing analyzer achieves **87.13% accuracy** in determining cache hit prefix lengths. In medical question-answering systems with static prompt engineering, our attacks achieve a **62% success rate** in extracting exact disease inputs and **13.5%** for precise symptom descriptions. For legal consultation services implementing RAG, the semantic extraction success rates range from **43% to 100%**."
> "…achieves **62%** success rate in exact partial input recovery and **12.5%** in exact complete input extraction, while demonstrating **79.5%** effectiveness in semantic-level content reconstruction under real-world deployment constraints." `[P]`

这篇还额外覆盖了 **semantic caching**（GPTCache 那类语义缓存），比 prefix caching 更危险——因为命中条件是相似度阈值而不是精确前缀。

#### 8.1.4 Auditing Prompt Caching（arXiv:2502.07776，Stanford）

这篇最重要，因为它**实测了真实厂商**。

- v1 2025-02-11，v2 2025-07-13。审计执行时间：**2024 年 9–10 月**。
- 方法：双样本 Kolmogorov–Smirnov 检验，单侧；`PromptLength=5000`，`NumSamples=250`，显著性水平 **α = 10⁻⁸**。

> "We conducted audits on real-world LLM API providers in September and October 2024. **We detected prompt caching in 8 out of 17 API providers. In 7 of these providers, we detected global cache sharing.**" `[P]`

审计了 17 家：Anthropic, Amazon Bedrock, Microsoft Azure OpenAI, Cohere, Deep Infra, DeepSeek, Fireworks AI, Google, Groq, Hyperbolic, Lepton AI, Mistral, OctoAI, OpenAI, Perplexity, Replicate, Together AI。`[P]`

**结果表（逐行照抄）** `[P]`：

| Provider | Model | Same prompt, Per-user | Same prefix Per-user | Per-org. | **Global** | Avg. precision (Client) | (Server) |
|---|---|---|---|---|---|---|---|
| Azure | text-embedding-3-small | ✓ | ✓ | — | **✓** | 0.80 | — |
| Deep Infra | Llama 3.1 8B Instruct | ✓ | ✓ | — | **✓** | 0.84 | — |
| Fireworks | Llama 3.1 8B Instruct | ✓ | ✓ | ✓ | **✓** | 0.77 | 0.79 |
| Lepton | Llama 3.1 8B Instruct | ✓ | ✓ | — | **✓** | 0.71 | 0.70 |
| OpenAI | text-embedding-3-small | ✓ | ✓ | ✓ | **✓** | 0.78 | 0.79 |
| Perplexity | Llama 3.1 8B Instruct | ✓ | ✓ | — | **✓** | 0.90 | — |
| Replicate | Llama 3 8B Instruct | ✓ | ✓ | — | **✓** | — | **1.00** |
| **Anthropic** | Claude 3 Haiku | ✓ | ✓ | ✓ | **✗** | 0.84 | — |
| **OpenAI** | GPT-4o mini | ✓ | ✓ | ✓ | **✗** | 0.79 | 0.86 |

**INV-18 的完整版**：**「prompt cache 会泄露别的用户的 prompt」这句话被严重过度概括了。** 对于 Anthropic 的 Claude 3 Haiku 和 OpenAI 的 GPT-4o mini，论文**测出的是 `✗`（没有全局共享）**。真正测到全局共享的是 7 家（其中包含 OpenAI 的 embedding 模型和 Azure 的 embedding 模型，**不是它们的 chat 模型**）。

**但「per-org. ✓」这一格才是本课学生真正要关心的那一格**：如果你是一个多租户 SaaS，你的**所有终端用户都在你这一个 organization 底下**。厂商保证的边界（组织之间）和你需要的边界（你的客户之间）**不是同一条边界**。

责任披露与后续 `[P]`：
> "In October 2024, we disclosed our audit results with each API provider in which we detected prompt caching. We gave providers 60 days to address the vulnerabilities before publicly releasing our findings… To our knowledge, **at least five providers made changes to mitigate vulnerabilities, e.g., disabling global cache sharing across organizations and updating documentation.**"

附带的架构泄漏：
> "By detecting prompt prefix caching, we find evidence that OpenAI's **text-embedding-3-small** model has a **decoder-only architecture**, which was previously not publicly known." `[P]`
> —— **缓存时序不只泄漏内容，还泄漏模型结构。**

### 8.2 跨用户/跨租户共享：有没有厂商明确的隔离承诺

**有，而且相当具体**（全部已在 INV-7 引全）：

- Anthropic：workspace / organization 双层，并明确列出哪个平台是哪个粒度。「Different organizations **never** share caches, even if they use identical prompts.」`[P]`
- OpenAI：「Caches are not shared across organizations and cannot be reused across regional processing boundaries.」`[P]`
- Azure：「The system doesn't share prompt caches between Azure subscriptions.」`[P]`
- Google Vertex：**只承诺 VPC-SC 边界**（「your cache cannot be exfiltrated beyond your service perimeter」），**对租户隔离粒度没有直接陈述**。`[P]`（承诺内容）/ **查不到一手来源**（隔离粒度）
- DeepSeek：提供 `user_id` 做 **KVCache Isolation**。`[P]`

**「有没有已知事故」**：
- 有**已发表的审计**（8.1.4），有**已修复的 CVE**（8.1.1）。
- **「某厂商因为缓存共享泄露了真实用户数据」这样的公开事故——查不到一手来源。** 论文说的是「potential privacy leakage」和「in principle」，不是实际泄露。**不要在课上讲成已发生的事故。**

**最强的厂商侧承认**，是 OpenAI 自己把防御手段写进了性能文档（INV-18）：
> "separate keys help prevent **cache-hit probing across users**: submitting candidate prompts and observing cache hits to learn whether matching content was previously cached." `[P]`

### 8.3 这一节的每个优化手段，分别动了 L14 的哪条边界

| 本节要教的优化 | 动的是 L14 的哪条边界 | 具体机制（一手依据） |
|---|---|---|
| **跨会话复用 prompt 前缀** | **通道枚举**（L14「看不见的通道 ≠ 加了过滤的通道」） | 缓存命中与否是一个**你没枚举过的、一 bit 的出站信道**。L14 的 `auditChannels` 里没有这一条。 |
| **缓存共享到组织级** | **租户隔离** | 「Bedrock and Google Cloud maintain organization-level cache isolation」`[P]` —— 你的多租户边界比厂商的边界细一层。 |
| **把工具定义放进缓存前缀** | **rug pull 哈希钉定**（L14 第七节） | 缓存**要求**工具定义逐字节稳定（`tools_changed`），L14 **也要求**工具定义逐字节稳定（指纹钉定）。**这两件事第一次指向同一个方向。** 缓存命中率可以当作 rug pull 的免费探测器。 |
| **缓存 `tool_result`** | **污点传播**（L14「一条不可信来源就足以污染整个下游」） | `tool_result` 里装的是不可信数据（L14 的 `WEB` 来源）。把它写进一个**共享的**缓存，等于把不可信数据的存在性写进了一条共享信道。 |
| **模型路由** | **审批门的确定性** | 不同模型对同一个 prompt 的行为不同。L14 的 reviewer（`ReviewContext`）如果跑在被路由的模型上，**你的安全门的判断标准会随流量波动**。而且 `model_changed` 会打掉缓存。 |
| **便宜模型多轮重试** | **熔断器与不可逆动作** | 重试 = 同一个高风险动作被提交多次。L14 的熔断器判的是单条命令，**不判「这是第 4 次尝试」**。 |
| **Batch API** | **人工审批**（L14 第六节） | batch 是异步的、无人值守的、24 小时窗口的。**一个 `critical` 档动作进了 batch，就没有人在回路里了。** |
| **降低延迟 / 去掉检查** | **L14 每一层检查的存在理由** | L14 加的每一层（污点、契约、通道审计、指纹、熔断、审批）都有延迟和 token 成本。**这一节要砍的正是这些。** |
| **`prompt_cache_key` 分组** | **隔离边界的显式声明** | OpenAI 和 DeepSeek 都提供了把缓存按终端用户切开的参数。**这是本节唯一一个「性能参数同时是安全参数」的地方。** |

**这一节该给学生的那句话**：

> **L14 教你「拿掉能力」，L15 教你「复用状态」。复用状态就是在制造能力。**
> 所以这一节每加一个优化，都要回去在 L14 的通道清单上补一行——**而且大部分时候，正确的处理是「显式声明隔离边界」（`user_id` / `prompt_cache_key`），而不是「关掉缓存」。**

**一个正面的发现**：缓存和安全**不总是对立的**。工具定义的逐字节稳定性，是缓存命中的**必要条件**，也是 L14 rug pull 钉定的**核心要求**。**一个缓存命中率突然掉到 0 的 agent，可能是有人改了你的 MCP server 的工具描述。** 把 `cache_read_input_tokens` 接到告警上，你就免费得到了一个 rug pull 检测器。**这是两节课之间最漂亮的一个连接点，建议做成讲义的结尾。**

---

## 9. 建议的课程结构与实验设计

### 9.1 90–120 分钟的结构建议

| 时长 | 内容 | 核心动作 |
|---|---|---|
| 0–10' | **开场：算一笔账** | 用 3.5 节的 `n·B + d·n(n−1)/2` 公式，让学生算一个 20 步 agent 的输入 token 总数。**先让他被那个 2.7 倍吓一跳。** |
| 10–35' | **缓存的真实机制** | 前缀哈希、四断点、20-block lookback、失效表、最低门槛。重点讲 INV-11（断点放错位置比不开缓存还贵 25%）。 |
| 35–55' | **实验一：前缀失效定位器**（见 9.3-A） | 写 `firstDivergence()`，对齐 Anthropic cache diagnostics 的 `cache_miss_reason`。 |
| 55–75' | **实验二：usage 判定器**（见 9.3-B，**交付物核心**） | 四态判定 + 五种 provider 字段归一化。**必须包含 `UNDETERMINABLE`。** |
| 75–95' | **实验三：路由成本曲线**（见 9.3-C，**交付物核心**） | 给定难度分布 + 路由器混淆矩阵，算总成本与质量，画出与「全用贵模型」的对比。 |
| 95–110' | **L14 冲突** | 8.3 的那张表。结尾给「缓存命中率 = rug pull 检测器」那个连接。 |
| 110–120' | **收尾：不要做的事** | 第 10 节。 |

### 9.2 实验设计的硬约束怎么满足

**约束**：verify 一次模型都不调、CI 里确定、TS 和 Python 输出逐字节一致。

**这个约束其实是这一节最好的礼物**，因为缓存和成本的**核心性质全都是结构性的**：
- 缓存命中是**前缀哈希相等**——纯字符串/序列比较。
- 计费是**token 数 × 单价倍率**——纯算术。
- 限流是**token bucket**——纯状态机。
- 路由成本是**概率 × 单价的加权和**——纯算术。

**唯一需要模型的，是「token 数」本身**，而这可以用一个**确定性的假 tokenizer**（例如「每 4 个字节 = 1 token，向上取整」）绕过。**课上要明说这是个 stub，真实 token 数要用 `count_tokens` 端点。**

**三个双语言逐字节一致的坑，必须提前处理**：

1. **浮点格式化**。`0.1 + 0.2` 在两边都是 `0.30000000000000004`，但 `str()` 的输出不同（Python `0.30000000000000004`，JS `0.30000000000000004` 其实一样；但 `1e21`、`-0`、`1/3` 的位数策略不同）。
   **对策：所有金额用整数「微分」（1 美元 = 10⁸ 微分）做整数运算，只在最后格式化时手写定点输出。** 不要用 `toFixed` / `round`（两边的 banker's rounding 行为不同）。
2. **字典/对象的键序**。Python 3.7+ 的 dict 保序、JS 的对象对整数键会重排。
   **对策：所有输出前 `sort()` 键，或用数组代替对象。** 这一条正好呼应 Anthropic 的原话：「some languages (for example, Swift, Go) randomize key order during JSON conversion, breaking caches」——**课上可以把这个坑变成一个教学点：你为了让 verify 两边一致要做的事，正好就是让缓存命中要做的事。**
3. **随机数**。`Math.random()` 和 `random.random()` 即使同种子也不同。
   **对策：自己实现一个 32 位 LCG**（`s = (s * 1664525 + 1013904223) mod 2^32`），两边逐位一致。退避 jitter 的测试需要它。

### 9.3 七个具体实验（按优先级排序）

#### A. 前缀失效定位器 `firstDivergence()` ★★★ 强烈建议

**对标**：Anthropic cache diagnostics 的 `cache_miss_reason` + `cache_missed_input_tokens`。

**签名**：
```ts
type Req = { model: string; tools: Tool[]; system: Block[]; messages: Block[] }
type Divergence =
  | { type: 'model_changed' }
  | { type: 'tools_changed'; at: number; cacheMissedTokens: number }
  | { type: 'system_changed'; at: number; cacheMissedTokens: number }
  | { type: 'messages_changed'; at: number; cacheMissedTokens: number }
  | null   // 无分歧
function firstDivergence(prev: Req, curr: Req): Divergence
```

**要测的性质（每条对应一个一手事实）**：
- 层级顺序：`tools` → `system` → `messages`，**只报最早的那一个**（官方：「The response reports the earliest divergence only」）。
- 改工具**描述**里的一个字符 → `tools_changed`（对应 L14 的 rug pull）。
- 改工具**顺序**（内容完全相同）→ **也要报 `tools_changed`**（官方：「tools were added, removed, or **reordered**」）。
- 工具 `input_schema` 的 **JSON 键序**不同 → **也要报**（官方：「serialized non-deterministically」）。
- 往 messages **中间**插一条 → `messages_changed`，`at` = 插入位置。
- 往 messages **末尾**追加 → **返回 `null`**（追加不产生分歧）。
- 换模型 → `model_changed`，**且不再检查其它层**。
- `cacheMissedTokens` = 分歧点之后的 token 数。

**★ 最该教的那条**：system prompt 里插了一个时间戳 → 每次都 `system_changed`，`cacheMissedTokens` 等于**整个前缀**。这就是 INV-11 的那个「+25% 且日志全绿」的场景。

#### B. usage 判定器 `cacheVerdict()` ★★★ 交付物核心

**签名**：
```ts
type Verdict = 'HIT' | 'WRITE_ONLY' | 'MISS' | 'BELOW_MINIMUM' | 'UNDETERMINABLE'
function cacheVerdict(provider: Provider, usage: unknown, model: string):
  { verdict: Verdict; readTokens: number; writeTokens: number; totalInput: number; reason: string }
```

**要测的性质**：
- 五种 provider 的字段形状全部归一化正确（表见 6.4）。
- **★ Anthropic 的 `input_tokens` 不参与「总输入」以外的任何计算。** 一个把 `input_tokens` 当总输入的实现，在这条测试上会挂——而这正是 INV-2。
- **★ Anthropic 的 OpenAI 兼容层（`prompt_tokens_details` 为空）必须返回 `UNDETERMINABLE`，不能返回 `MISS`。** 这两个状态混淆是本节最重要的那个 bug。
- **★ DeepSeek 没有 write 字段**，`writeTokens` 应为 `0` 且 `reason` 要说明「该 provider 不区分写入」，不能报 `UNDETERMINABLE`（它的 read 字段是有的）。
- read=0 且 write=0 且**前缀 token 数 < 该模型最低门槛** → `BELOW_MINIMUM`（需要一张 INV-5 的门槛表）。
- read=0 且 write>0 → `WRITE_ONLY`。**连续两次 `WRITE_ONLY` 要能被上层判为异常。**

#### C. 路由成本/质量曲线 `routeCurve()` ★★★ 交付物核心

**签名**：
```ts
type Task = { id: string; trueDifficulty: 'easy'|'hard'; inputTokens: number; outputTokens: number }
type Router = { // 混淆矩阵：P(判为 hard | 真实难度)
  pHardGivenHard: Ratio; pHardGivenEasy: Ratio  // 用整数分数，不用浮点
}
function routeCurve(tasks: Task[], router: Router, prices: PriceTable, thresholds: number[]):
  Array<{ threshold: number; costMicros: bigint; qualityNumer: bigint; qualityDenom: bigint; vsAllStrongPct: ... }>
```

**要测的性质**：
- **★ 随机路由必须是基线**（对应 INV-13）。一个 `pHardGivenHard == pHardGivenEasy` 的路由器，其曲线必须与随机路由重合。
- **★ 一个「反着判」的路由器（`pHardGivenEasy > pHardGivenHard`）必须产出**比随机差**的曲线**——对应 RouteLLM 在 GSM8K 上的 −11.8%。**这条测试的存在，就是在教「路由器可以是负价值的」。**
- **★ 便宜模型的重试要算进去**：一个 `hard` 任务被错判到弱模型 → 失败 → 重试到强模型。总成本 = 弱模型一次 + 强模型一次，**大于直接用强模型**。这就是那条反直觉。
- **★ 缓存必须参与计算**：`model_changed` 会打掉缓存。测一个「路由器抖动」的场景：连续 10 步在两个模型之间来回跳，**缓存命中率为 0**；对比「session affinity」场景，命中率为 9/10。**这是 3.5 节那个「路由和缓存打架」的量化版本。**
- 全部用整数（微分）运算。

#### D. 缓存前缀模拟器 `simulateCache()` ★★ 建议

模拟 Anthropic 的写入/读取规则，纯状态机：
- 写只发生在断点，且只写一个条目（官方：「Marking a block with `cache_control` writes exactly one cache entry」）
- 读向后走最多 **20 个位置**，只找**之前写过的**条目
- 连续 `tool_use` 算一个位置，连续 `tool_result` 算一个位置
- 断点上限 4；超过报错

**★ 必须包含官方的三轮例子**（2.2 节引的 Turn 1/2/3）：Turn 3 的 35 个 block 必须 **miss**，因为 Turn 2 的条目在 block 15，正好在窗口外一格。**这个用例的价值是它是官方原文给的，不是我们编的。**

#### E. 混合 TTL 计费 `mixedTtlBill()` ★★ 建议

直接实现 2.2 节那个 A / B / C 公式。纯算术，一手来源，输入输出都是整数。
**★ 要测「1 小时条目必须排在 5 分钟条目之前」这条约束——违反时应该报错。**

#### F. token bucket + 退避 `limiter()` ★★ 建议

- token bucket 的**连续补充**语义（不是固定窗口重置）——对应 Anthropic 原话。
- 注入一个**确定性时钟**（毫秒整数），不用 `Date.now()`。
- **★ 60 RPM 要能在「1 秒内发 60 个」时拒绝**——对应官方的「a rate of 60 RPM might be enforced as 1 request per second」。
- **★ 三种「超限」要分开处理**：429 带 `retry-after`（按它等）、429 不带（`enforced_spend_limit_reached`，**不重试**）、400（自设上限，**不重试**）。
- jitter 用 9.2 里的 LCG。
- **★ 失败请求也要消耗桶里的令牌**——对应 INV-20。

#### G. Batch 结果归并 `reconcileBatch()` ★ 可选

- 结果**乱序**，必须按 `custom_id` 归并（官方：「order is not guaranteed」）。
- 四态 `succeeded` / `errored` / `canceled` / `expired`，**后三种不计费**。
- `errored` 里再分 `invalid_request_error`（**改代码**）vs 其它（**可直接重试**）——官方示例代码的分支。
- **★ `expired` 不是失败，是「没轮到」**，重新提交即可，且**不该计入错误率**。

### 9.4 明确不要做成实验的（因为做不出可信数字）

见第 10 节。

---

## 10. 不要尝试清单

> 一节 90–120 分钟的课里，下面这些事会让你的时间爆炸、或者教出错误直觉、或者做不出可信的数字。

**10.1 不要在课上实测延迟。**
网络抖动、时段（DeepSeek 的峰谷差在 01:00–04:00 / 06:00–10:00 UTC）、地域、服务端负载、并发邻居——这些因素的方差**大于**你想测的效应。一个学生在深圳晚上测出「缓存让 TTFT 降了 40%」，另一个在上海早上测出「降了 5%」，两个人都会以为对方错了。**延迟只能在受控环境下、用大样本、报分布而不是均值来测。** 这不是 90 分钟能做的事，而且它需要调模型——违反硬约束。

**10.2 不要真的跑一次 Batch API。**
承诺完成时间是 24 小时。课上等不了。**演示 batch 的正确方式是给一份真实的 `.jsonl` 结果文件（乱序、含四种状态），让学生写归并逻辑。** 那才是 batch 真正难的部分。

**10.3 不要试图复现缓存侧信道攻击。**
三个理由：(a) 对托管 API 做探测可能违反服务条款；(b) Anthropic 和 OpenAI 的 chat 模型在 2024 年的审计里**就没有**全局共享，你测不出来；(c) 那篇论文用了 `NumSamples=250`、`α=10⁻⁸` 才敢下结论——课上跑 20 次得到的任何"差异"都是噪声。
**正确做法**：把 8.1.4 那张表直接讲出来，讲方法论（KS 检验、显著性水平、责任披露 60 天），不复现。

**10.4 不要试图实测 OpenAI 的 15 RPM 溢出阈值。**
官方措辞是 "can lead to overflow routing" 和 "approximately"，不是硬阈值。而且它依赖「current machine load and available capacity」。**你测出来的任何一个具体数字都不可复现。**

**10.5 不要训练一个路由器。**
RouteLLM 用了 80k Chatbot Arena battles + 数据增强，训练出来的 BERT router 在 GSM8K 上**还是不如随机**。90 分钟里训不出一个比随机强的分类器，而且**训出一个比随机差的，会教出完全错误的直觉**（学生会以为「路由这条路不通」，而真实结论是「路由需要领域内的标注数据」）。
**正确做法**：给一个**混淆矩阵参数**，让学生算这个矩阵下的成本/质量曲线（实验 C）。**这样错分率是输入而不是输出，学生学到的是「错分率怎么影响账」，这才是工程师要会的那件事。**

**10.6 不要让学生做跨厂商比价表当交付物。**
价格三个月就变一次（本报告里就有三个「through December 31, 2026」和一个「at least through November 21, 2026」）。一张过期的比价表比没有表更糟。
**正确做法**：教**倍率**（cache read 0.1×、cache write 1.25×/2×、batch 0.5×、fast mode 2×）。倍率比绝对价格稳定得多，而且倍率才是做决策用的东西。

**10.7 不要用响应时间判断缓存是否命中。**
三家官方给的判定法**全都是读 `usage` 字段**，没有一家建议看时间。用时间判断的问题：(a) 噪声大；(b) 它本身就是第 8 节讲的那条侧信道，**你在教学生用攻击手法做监控**；(c) 一个流式响应的 TTFT 测量本身就有坑（keep-alive 注释行、首字节 vs 首 delta）。

**10.8 不要在 verify 里直接比较浮点数。**
理由见 9.2。金额一律整数微分。**这条要写进 verify 的注释里，因为它会在学生第一次跑双语言对拍时咬他们。**

**10.9 不要试图"在兼容端点上打开缓存"。**
DeepSeek 的文档明写 `cache_control: Ignored`（四处）。这不是配置问题，不是 header 问题，不是 SDK 版本问题——**是这条端点不接受这个参数。** 一个学生会在这上面耗掉 40 分钟。
**正确做法**：把这件事当成**本节的主教材**。「你发现你控制不了它」和「你发现它其实一直在自己缓存」这两个发现，比成功打开缓存有价值得多。

**10.10 不要在 verify 里用语言内置的随机数或哈希。**
`Math.random()` / `random.random()` 不可对齐；`hash()` 在 Python 里对 str 默认加盐（`PYTHONHASHSEED`）；`JSON.stringify` 和 `json.dumps` 的默认分隔符和转义规则不同（`json.dumps` 默认 `", "` 和 `": "`，JS 是 `,` 和 `:`）。
**对策**：LCG 自己写；哈希用自己实现的 FNV-1a 或直接用规范化后的字符串比较；序列化统一走一个自写的 `canonicalJson()`（排序键 + 固定分隔符 + 固定数字格式）。**顺带，`canonicalJson()` 正好就是「让工具定义可缓存」需要的那个函数**——一石二鸟。

**10.11 不要教"把并发调大"作为性能优化。**
Sarathi-Serve 的数据（INV-15）说明：prefill-bound 的负载（也就是 agent 的负载）提高并发几乎不涨吞吐，但会涨尾延迟、涨 429、并且在 OpenAI 上会降低缓存命中率。**「先算 P99 再调并发」才是这一节该给的纪律。**

**10.12 不要把 CVE 的 CVSS 分数当作严重性结论。**
CVE-2025-46570 是 **2.6 (Low)**，而 PROMPTPEEK 在类似机制上测到 **99%** 的重建成功率。这两个数字不矛盾（评的是不同东西），但**只引其中一个会严重误导**。如果课上要提这个 CVE，**两个数字必须一起出现**。

**10.13 不要承诺"砍一半延迟"是靠缓存做到的。**
学习目标里写了「把延迟砍一半」，但**三家厂商都没有公布缓存对 TTFT 改善的具体数字**（7.3 节）。这个目标要么改成「把可控的那部分延迟砍掉」（并行工具调用、去掉不必要的串行检查、流式），要么就要求学生自己测并报告置信区间。**不要引用任何一个没有一手来源的百分比。**

---

## 11. 数字汇总表

> 抓取/访问日期统一为 **2026-09-15**，除非另注。

### 11.1 缓存价格倍率

| 值 | 含义 | 来源 | 日期 | 置信度 |
|---|---|---|---|---|
| **1.25×** | Anthropic 5 分钟 cache write / base input | docs.claude.com prompt-caching | 2026-09-15 | `[P]` |
| **2×** | Anthropic 1 小时 cache write / base input | 同上 | 2026-09-15 | `[P]` |
| **0.1×** | Anthropic cache read / base input（多数模型） | 同上 | 2026-09-15 | `[P]` |
| **0.025×** | Anthropic cache read（仅 Claude Fable 5.1 / Mythos 5.1） | 同上（脚注 1） | 2026-09-15 | `[P]` |
| **1.25×** | OpenAI cache write（**仅 GPT-5.6 及以后**） | platform.openai.com prompt-caching | 2026-09-15 | `[P]` |
| **0×** | OpenAI cache write（GPT-5.5 及更早，无额外收费） | 同上（模型差异表） | 2026-09-15 | `[P]` |
| **0.1×** | OpenAI cache read（GPT-5.6+） | 同上 | 2026-09-15 | `[P]` |
| **90%** | Vertex AI implicit + explicit 缓存折扣（Gemini 2.5+） | cloud.google.com context-cache-overview | 2026-09-15 | `[P]` |
| **75%** | Vertex AI explicit 缓存折扣（Gemini 2.0） | 同上 | 2026-09-15 | `[P]` |
| **$1.00 / 1M tokens / 小时** | Gemini 显式缓存**存储**价（2027-01-01 起；2026-12-31 前为 $0.50） | ai.google.dev/gemini-api/docs/pricing | 2026-09-15 | `[P]` |
| **$0** | Gemini implicit 缓存存储价（无存储费） | cloud.google.com context-cache-overview | 2026-09-15 | `[P]` |
| **1.35× vs 2×** | OpenAI：写一次 + 完整读一次 vs 不缓存处理两次 | platform.openai.com prompt-caching | 2026-09-15 | `[P]` |
| **2.15× vs 10×** | OpenAI：写一次 + 读九次 vs 不缓存十次 | 同上 | 2026-09-15 | `[P]` |
| **0.05×** | 理论最低单价倍率 = Batch 0.5× × cache read 0.1× | 由 `[P]` 倍率相乘；叠乘经 Anthropic 明文允许 | 2026-09-15 | `[P2]` |

### 11.2 缓存门槛与结构参数

| 值 | 含义 | 来源 | 日期 | 置信度 |
|---|---|---|---|---|
| **4** | Anthropic 缓存断点上限（每请求） | docs.claude.com prompt-caching | 2026-09-15 | `[P]` |
| **4** | OpenAI 每请求 cache write 上限（GPT-5.6+） | platform.openai.com prompt-caching | 2026-09-15 | `[P]` |
| **4** | Bedrock 每请求 cache checkpoint 上限（Claude） | docs.aws.amazon.com prompt-caching | 2026-09-15 | `[P]` |
| **20 blocks** | Anthropic lookback 窗口 | docs.claude.com prompt-caching | 2026-09-15 | `[P]` |
| **~20 blocks** | Bedrock 简化缓存管理的回看范围 | docs.aws.amazon.com prompt-caching | 2026-09-15 | `[P]` |
| **50** | OpenAI 缓存**读取**时考虑的最近断点数 | platform.openai.com prompt-caching | 2026-09-15 | `[P]` |
| **512** | Anthropic 最低可缓存 token（Fable 5.1 / Mythos 5.1 / Opus 5 / Fable 5 / Mythos 5） | docs.claude.com prompt-caching | 2026-09-15 | `[P]` |
| **1,024** | Anthropic 最低（Opus 4.8 / Sonnet 5 / Sonnet 4.6 / Sonnet 4.5 / Opus 4.1 / Opus 4 / Sonnet 4） | 同上 | 2026-09-15 | `[P]` |
| **2,048** | Anthropic 最低（Mythos Preview / Opus 4.7 / Haiku 3.5） | 同上 | 2026-09-15 | `[P]` |
| **4,096** | Anthropic 最低（Opus 4.6 / Opus 4.5 / **Haiku 4.5**） | 同上 | 2026-09-15 | `[P]` |
| **1,024** | OpenAI 最低可缓存（GPT-5.6+，不含隐藏 system token） | platform.openai.com prompt-caching | 2026-09-15 | `[P]` |
| **1,024** | Azure OpenAI 最低，且「first 1,024 tokens must be identical」 | learn.microsoft.com prompt-caching | 2026-09-15 | `[P]` |
| **2,048** | Gemini 2.5 Flash / 2.5 Pro 隐式缓存最低 | ai.google.dev/gemini-api/docs/caching | 2026-09-15 | `[P]` |
| **4,096** | Gemini 3.5–3.8 Flash / 3.1 Pro Preview 隐式缓存最低 | 同上 | 2026-09-15 | `[P]` |
| **6,144** | Vertex：3.0 Flash Preview / 3.1 Pro Preview / 3.7 / 3.8 Flash 隐式最低 | cloud.google.com context-cache-overview | 2026-09-15 | `[P]` |
| **10 MB** | Vertex 显式缓存单个 blob/text 上限 | 同上 | 2026-09-15 | `[P]` |
| **128** | OpenAI ≤GPT-5.5 的 `cached_tokens` 向下取整粒度 | platform.openai.com prompt-caching | 2026-09-15 | `[P]` |

### 11.3 TTL 与生命周期

| 值 | 含义 | 来源 | 日期 | 置信度 |
|---|---|---|---|---|
| **5 分钟** | Anthropic 默认 TTL（`ephemeral`） | docs.claude.com prompt-caching | 2026-09-15 | `[P]` |
| **1 小时** | Anthropic 扩展 TTL（`ttl: "1h"`） | 同上 | 2026-09-15 | `[P]` |
| **请求开始** | Anthropic TTL 计时起点（**不是响应结束**） | 同上 | 2026-09-15 | `[P]` |
| **约 1 分钟** | 一个流了 4 分钟的响应之后，5 分钟缓存的剩余窗口 | 同上（官方举例） | 2026-09-15 | `[P]` |
| **30m** | OpenAI GPT-5.6+ 的 `prompt_cache_options.ttl`，**唯一取值** | platform.openai.com prompt-caching | 2026-09-15 | `[P]` |
| **5–10 分钟（最长 1 小时）** | OpenAI `in_memory` 保留 | 同上 | 2026-09-15 | `[P]` |
| **~30 分钟（最长 24 小时）** | OpenAI `24h` 保留 | 同上 | 2026-09-15 | `[P]` |
| **60 分钟** | Vertex 显式缓存默认 TTL | cloud.google.com context-cache-overview | 2026-09-15 | `[P]` |
| **1 分钟 / 无上限** | Vertex 显式缓存的最短 / 最长过期时间 | 同上 | 2026-09-15 | `[P]` |
| **30 分钟** | Bedrock 上 GPT-5.6 系列的最短 TTL | docs.aws.amazon.com prompt-caching | 2026-09-15 | `[P]` |

### 11.4 限流

| 值 | 含义 | 来源 | 日期 | 置信度 |
|---|---|---|---|---|
| **token bucket** | Anthropic 限流算法（官方点名） | docs.claude.com rate-limits | 2026-09-15 | `[P]` |
| **2,000,000 ITPM / 400,000 OTPM / 1,000 RPM** | Anthropic Start tier，Claude Opus 5 | 同上 | 2026-09-15 | `[P]` |
| **10,000,000 ITPM / 2,000,000 OTPM / 10,000 RPM** | Anthropic Scale tier，Claude Opus 5 | 同上 | 2026-09-15 | `[P]` |
| **不计入** | Anthropic：`cache_read_input_tokens` 不占 ITPM（Haiku 3.5 除外） | 同上 | 2026-09-15 | `[P]` |
| **计入** | OpenAI：cached input tokens 计入 TPM | platform.openai.com prompt-caching | 2026-09-15 | `[P]` |
| **不计入** | Bedrock 上的 GPT-5.6：cached tokens 不占 ITPM | docs.aws.amazon.com prompt-caching | 2026-09-15 | `[P]` |
| **不计入** | Anthropic：`max_tokens` 不影响 OTPM | docs.claude.com rate-limits | 2026-09-15 | `[P]` |
| **计入（取 max）** | OpenAI：限额 = max(`max_tokens`, 估算 token 数) | platform.openai.com rate-limits | 2026-09-15 | `[P]` |
| **1,000,000 TPM / +50% / 15 分钟** | OpenAI 扩容斜率上限的经验法则 | 同上 | 2026-09-15 | `[P]` |
| **1,000,000 TPM 且 >50% / 15 分钟** | OpenAI Fast mode 降级触发条件 | openai.com/api-fast-mode/ | 2026-09-15 | `[P]` |
| **2,500 / 500** | DeepSeek 并发上限（flash / v4-pro），账号级 | api-docs.deepseek.com rate_limit | 2026-09-15 | `[P]` |
| **10 分钟** | DeepSeek：未开始推理则关闭连接 | 同上 | 2026-09-15 | `[P]` |
| **最近的千位** | Anthropic 限流 header `-remaining` 的取整粒度 | docs.claude.com rate-limits | 2026-09-15 | `[P]` |
| **~15 RPM** | OpenAI 缓存溢出路由阈值（每 prefix+key） | platform.openai.com prompt-caching | 2026-09-15 | `[P]` |
| **~15 RPM** | Azure 独立复述的同一阈值 | learn.microsoft.com prompt-caching | 2026-09-15 | `[P]` |

### 11.5 批处理

| 值 | 含义 | 来源 | 日期 | 置信度 |
|---|---|---|---|---|
| **50%** | Anthropic / OpenAI / Gemini Batch 折扣（三家一致） | 各家 batch 文档 | 2026-09-15 | `[P]` |
| **100,000 条 / 256 MB** | Anthropic 单个 batch 上限（先到为准） | docs.claude.com batch-processing | 2026-09-15 | `[P]` |
| **24 小时** | Anthropic batch 过期时间 | 同上 | 2026-09-15 | `[P]` |
| **29 天** | Anthropic batch 结果保留（从 `created_at` 算） | 同上 | 2026-09-15 | `[P]` |
| **30% – 98%** | Anthropic batch + 缓存的实测命中率区间 | 同上 | 2026-09-15 | `[P]` |
| **200 MB** | OpenAI Batch 上传文件上限 | platform.openai.com/docs/guides/batch | 2026-09-15 | `[P]` |
| **2 GB** | Gemini Batch 输入文件上限 | ai.google.dev/gemini-api/docs/batch-api | 2026-09-15 | `[P]` |
| **48 小时** | Gemini batch `JOB_STATE_EXPIRED` 触发时长 | 同上 | 2026-09-15 | `[P]` |
| **不支持** | Bedrock：prompt caching 不能用于 batch inference API | docs.aws.amazon.com prompt-caching | 2026-09-15 | `[P]` |
| **200,000 / 300,000 / 500,000** | Anthropic batch 排队上限（Start / Build / Scale） | docs.claude.com rate-limits | 2026-09-15 | `[P]` |

### 11.6 路由

| 值 | 含义 | 来源 | 日期 | 置信度 |
|---|---|---|---|---|
| **>2×** | RouteLLM 摘要报的成本降幅（含限定词 "in certain cases"） | arXiv:2406.18665v4 | 2025-02-23（v4） | `[P]` |
| **13.40%** | MT Bench CPT(50%)，MF + `D_arena+D_judge`（随机为 49.03%） | 同上 Table 1 | 2025-02-23 | `[P]` |
| **8.8 / 9.3 = 95%** | MT Bench，CPT(50%) 处的绝对分数 vs GPT-4 | 同上 Table 1 注 | 2025-02-23 | `[P]` |
| **75 / 81 = 92%** | MMLU，CPT(50%) 处 vs GPT-4 | 同上 Table 2 注 | 2025-02-23 | `[P]` |
| **75 / 86 = 87%** | GSM8K，CPT(50%) 处 vs GPT-4 | 同上 Table 3 注 | 2025-02-23 | `[P]` |
| **−11.8%** | GSM8K，BERT router 仅用 `D_arena` 的 APGR 改善（**劣于随机**） | 同上 Table 3 | 2025-02-23 | `[P]` |
| **0.497 / 0.500** | 随机路由的 APGR 基线（GSM8K / MT Bench） | 同上 Tables 1,3 | 2025-02-23 | `[P]` |
| **23.27% / 21.18%** | 跨模型对迁移 CPT(50%)（Claude 3 Opus/Sonnet；Llama 3.1 70B/8B） | 同上 Table 4 | 2025-02-23 | `[P]` |
| **1–2 个百分点** | Foundry model router **Balanced** 模式允许的质量损失带宽 | learn.microsoft.com model-router | 2026-09-15 | `[P]` |
| **5–6 个百分点** | Foundry model router **Cost** 模式的质量损失带宽 | 同上 | 2026-09-15 | `[P]` |
| **7 天** | OpenRouter Auto Router 的市场消费份额统计窗口 | openrouter.ai auto-router | 2026-09-15 | `[P]` |

### 11.7 延迟与服务分级

| 值 | 含义 | 来源 | 日期 | 置信度 |
|---|---|---|---|---|
| **2.5×** | Anthropic fast mode 的 OTPS 提升上限（**不改善 TTFT**） | docs.claude.com fast-mode | 2026-09-15 | `[P]` |
| **2.5×** | OpenAI Fast mode 对 gpt-5.6-sol 的加速上限 | openai.com/api-fast-mode/ | 2026-09-15 | `[P]` |
| **2×** | OpenAI Fast mode 对 gpt-5.6-sol 的价格倍率 | 同上 | 2026-09-15 | `[P]` |
| **$8 / $40** | gpt-5.6-sol Fast mode 短上下文 输入/输出（每 MTok） | 同上 | 2026-09-15 | `[P]` |
| **$16 / $60** | gpt-5.6-sol Fast mode 长上下文 输入/输出 | 同上 | 2026-09-15 | `[P]` |
| **99.9% / 99% > 80 tps** | OpenAI Fast mode 的 uptime SLA / 吞吐 SLA | 同上 | 2026-09-15 | `[P]` |
| **99.5%** | Anthropic Priority Tier 的 uptime 目标（**已停售**） | docs.claude.com service-tiers | 2026-09-15 | `[P]` |
| **0.1 / 1.25 / 2.00** | Anthropic Priority Tier 容量扣减系数（cache read / 5m write / 1h write） | 同上 | 2026-09-15 | `[P]` |
| **1.1×** | Anthropic `inference_geo: "us"` 在 Claude 4.6+ 上的容量扣减与定价倍率 | 同上 | 2026-09-15 | `[P]` |
| **10%** | OpenAI 数据驻留端点的价格上浮（2026-03-05 及之后发布的模型） | developers.openai.com/api/docs/pricing | 2026-09-15 | `[P]` |
| **128** | 1 个 decode token 的线性算子开销 ≈ 多少个 prefill token（Mistral-7B / A100） | arXiv:2403.02310v3 Fig.4 | 2024-06-17（v3） | `[P]` |
| **>80%** | 线性算子在总运行时间中的占比（即使在长序列下） | 同上 | 2024-06-17 | `[P]` |
| **2.6× / 3.7× / 5.6×** | Sarathi-Serve 相对 vLLM 的 serving capacity 提升（Mistral-7B 1×A100 / Yi-34B 2×A100 / Falcon-180B PP） | 同上（摘要） | 2024-06-17 | `[P]` |

### 11.8 安全 / 侧信道

| 值 | 含义 | 来源 | 日期 | 置信度 |
|---|---|---|---|---|
| **8 / 17** | 检测到 prompt caching 的厂商数 / 审计总数 | arXiv:2502.07776v2 | 审计 2024-09~10；v2 2025-07-13 | `[P]` |
| **7** | 检测到**全局**缓存共享的厂商数 | 同上 | 同上 | `[P]` |
| **✗** | Anthropic Claude 3 Haiku 的全局共享检测结果（**未检测到**） | 同上 Table 1 | 同上 | `[P]` |
| **✗** | OpenAI GPT-4o mini 的全局共享检测结果（**未检测到**） | 同上 Table 1 | 同上 | `[P]` |
| **✓** | OpenAI / Azure 的 text-embedding-3-small **检测到**全局共享 | 同上 Table 1 | 同上 | `[P]` |
| **0.70 – 1.00** | 各厂商缓存命中分类的 average precision 区间 | 同上 Table 1 | 同上 | `[P]` |
| **α = 10⁻⁸** | 审计使用的显著性水平 | 同上 | 同上 | `[P]` |
| **5000 / 250** | `PromptLength` / `NumSamples` | 同上 | 同上 | `[P]` |
| **≥5** | 披露后做出缓解改动的厂商数（作者所知） | 同上 | 同上 | `[P]` |
| **CVE-2025-46570** | vLLM < 0.9.0 前缀缓存时序侧信道 | GHSA-4qjh-9fv9-r85r / NVD | NVD 2025-05-29 | `[P]` |
| **2.6 (Low)** | 该 CVE 的 CVSS v3.1 基准分（`AV:N/AC:H/PR:L/UI:R/S:U/C:L/I:N/A:N`） | 同上 | 2025-05-29 | `[P]` |
| **AUC 0.571 / 0.99** | 1-token 前缀 / 8-token 前缀下区分命中的 ROC AUC | 同上 | 2025-05-29 | `[P]` |
| **99% / 98% / 95%** | PROMPTPEEK 三种背景知识下的 prompt 重建成功率（Llama2-13B / A100 80G） | NDSS 2025 论文 | 2025 | `[P]` |
| **87.13%** | InputSnatch 判定缓存命中前缀长度的准确率 | arXiv:2411.18191 | 2024-11（v1） | `[P]` |
| **62% / 13.5%** | InputSnatch 在医疗问答中精确提取疾病 / 症状描述的成功率 | 同上 | 同上 | `[P]` |
| **43% – 100%** | InputSnatch 在 RAG 法律咨询中的语义提取成功率区间 | 同上 | 同上 | `[P]` |

### 11.9 DeepSeek（本课 provider）

| 值 | 含义 | 来源 | 日期 | 置信度 |
|---|---|---|---|---|
| **$0.003 / $0.15** | `deepseek-flash` off-peak 输入：cache hit / cache miss（每 MTok） | api-docs.deepseek.com pricing | 2026-09-15 | `[P]` |
| **50×** | `deepseek-flash` 未命中 / 命中 的价格比 | 由上两行相除 | 2026-09-15 | `[P2]` |
| **$0.022 / $0.66** | `deepseek-v4-pro` off-peak：cache hit / cache miss | 同上 | 2026-09-15 | `[P]` |
| **30×** | `deepseek-v4-pro` 未命中 / 命中 的价格比 | 由上行相除 | 2026-09-15 | `[P2]` |
| **$0.6 / $1.98** | flash / v4-pro off-peak 输出价（每 MTok） | 同上 | 2026-09-15 | `[P]` |
| **2×** | peak / off-peak 价格比（「Off-peak rates are half of the peak rates」） | 同上 | 2026-09-15 | `[P]` |
| **01:00–04:00 与 06:00–10:00 UTC，周一至周五** | peak 时段（**其余全部是 off-peak**，即约 79% 的时间是便宜的） | 同上 | 2026-09-15 | `[P]` |
| **4.4× / 3.3×** | v4-pro 相对 flash 的输入（miss）/ 输出 价格比 | 由定价表相除 | 2026-09-15 | `[P2]` |
| **1M** | 两个模型的 context length | 同上 | 2026-09-15 | `[P]` |
| **384K** | 最大输出 | 同上 | 2026-09-15 | `[P]` |
| **512** | `user_id` 字符串最大长度，正则 `[a-zA-Z0-9\-_]+` | api-docs.deepseek.com rate_limit | 2026-09-15 | `[P]` |

### 11.10 明确「查不到一手来源」的条目

> 这些是用户问到、但我**没有**找到一手来源的。**课上不要给数字。**

| 问题 | 状态 |
|---|---|
| 缓存命中对 TTFT 的改善百分比 | **查不到一手来源。** 三家都只有定性表述（"faster" / "improved TTFT"）。 |
| `temperature` 等采样参数是否会让缓存失效 | **查不到一手来源明确说会。** Anthropic 的失效表里没有它。推断为「不会」，但这是 `[P2]`。 |
| 换 API key（同 workspace 内）是否失效 | **查不到一手来源。** 文档的隔离粒度只写到 workspace / organization / subscription。 |
| Anthropic 缓存跨 `inference_geo` 的行为 | **查不到一手来源。** 只知道限流是共享的（`[P]`），缓存未说明。 |
| Google Gemini 缓存的租户隔离粒度（Google 自己的表述） | **查不到一手来源。** Google 只承诺 VPC-SC 边界。「Google Cloud 是 organization 级」这个说法来自 **Anthropic** 的文档（针对 Claude on Google Cloud），不是 Google 的。 |
| 路由器错分率的 confusion matrix 形式数据 | **查不到一手来源。** RouteLLM 报的是 CPT / PGR / APGR，不是 precision / recall。 |
| 「便宜模型多轮重试总成本高于一次贵模型」的实测数据 | **查不到一手来源。** 本报告 3.5 节给的是从一手定价出发的代数推导，标 `[P2]`。 |
| Cursor / Claude Code / Copilot 的内部路由方案 | **查不到一手来源。** 无公开的带数字说明。 |
| 因缓存共享导致的**真实已发生**的数据泄露事故 | **查不到一手来源。** 现有研究讲的都是 "potential" / "in principle"。 |
| 「流式请求在限额上有单独规则」 | **查不到一手来源。** 三家都没把流式单列为限额维度。 |
| Foundry model router 本身的 token 单价 | 文档说「charged for input prompts at the rate listed on the pricing page」`[P]`，**具体数值本报告未抓取。** |
| `usage` 报的数与发票系统性不一致 | **查不到一手来源。** 已知的只有口径/精度差异（128 取整、byte-length 估算、batch 略超 spend limit），不是账单错误。 |

---

## 12. 来源清单

### 厂商官方文档（一手）

**Anthropic / Claude**
- Prompt caching — https://docs.claude.com/en/docs/build-with-claude/prompt-caching
- Cache diagnostics (beta) — https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics
- Rate limits — https://docs.claude.com/en/api/rate-limits
- Message Batches API — https://docs.claude.com/en/docs/build-with-claude/batch-processing
- Service tiers — https://docs.claude.com/en/api/service-tiers
- Fast mode — https://docs.claude.com/en/docs/build-with-claude/fast-mode
- OpenAI SDK compatibility — https://docs.claude.com/en/api/openai-sdk

**OpenAI**
- Prompt caching — https://platform.openai.com/docs/guides/prompt-caching
- Rate limits — https://platform.openai.com/docs/guides/rate-limits
- Batch API — https://platform.openai.com/docs/guides/batch
- Pricing — https://developers.openai.com/api/docs/pricing
- Fast mode — https://developers.openai.com/api/docs/guides/fast-mode
- Fast mode for API Customers — https://openai.com/api-fast-mode/
- Priority processing — https://developers.openai.com/api/docs/guides/priority-processing
- Fast mode FAQ — https://help.openai.com/en/articles/11647665-fast-mode-faq

**Google**
- Context caching (Gemini API) — https://ai.google.dev/gemini-api/docs/caching
- Pricing (Gemini API) — https://ai.google.dev/gemini-api/docs/pricing
- Batch API (Gemini API) — https://ai.google.dev/gemini-api/docs/batch-api
- Context caching overview (Vertex / Gemini Enterprise Agent Platform) — https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview

**Amazon Web Services**
- Prompt caching (Bedrock) — https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html

**Microsoft**
- Prompt caching with Azure OpenAI in Microsoft Foundry Models — https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/prompt-caching
- Model router concepts — https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-router
- How to use model router — https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/model-router

**DeepSeek（本课 provider）**
- Using the Anthropic API（兼容性逐字段表） — https://api-docs.deepseek.com/guides/anthropic_api
- Context Caching — https://api-docs.deepseek.com/guides/kv_cache
- Models & Pricing — https://api-docs.deepseek.com/quick_start/pricing
- Rate Limit & Isolation — https://api-docs.deepseek.com/quick_start/rate_limit

**OpenRouter（第三方厂商的一手文档）**
- Auto Router — https://openrouter.ai/docs/guides/routing/routers/auto-router
- Provider Routing — https://openrouter.ai/docs/guides/routing/provider-selection

### 学术论文（一手）

- Ong, Almahairi, Wu, Chiang, Wu, Gonzalez, Kadous, Stoica. **RouteLLM: Learning to Route LLMs with Preference Data.** arXiv:2406.18665（v1 2024-06-26，v4 2025-02-23）— https://arxiv.org/abs/2406.18665
- Gu, Li, Kuditipudi, Liang, Hashimoto. **Auditing Prompt Caching in Language Model APIs.** arXiv:2502.07776（v1 2025-02-11，v2 2025-07-13）— https://arxiv.org/abs/2502.07776 ｜ 代码/数据 https://github.com/chenchenygu/auditing-prompt-caching
- Agrawal, Kedia, Panwar, Mohan, Kwatra, Gulavani, Tumanov, Ramjee. **Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve.** arXiv:2403.02310（v1 2024-03-04，v3 2024-06-17）— https://arxiv.org/abs/2403.02310
- Zheng, Han, Shi, Fang, Du, Guo, Hu. **InputSnatch: Stealing Input in LLM Services via Timing Side-Channel Attacks.** arXiv:2411.18191 — https://arxiv.org/html/2411.18191
- **I Know What You Asked: Prompt Leakage via KV-Cache Sharing in Multi-Tenant LLM Serving (PROMPTPEEK).** NDSS Symposium 2025 — https://www.ndss-symposium.org/wp-content/uploads/2025-1772-paper.pdf

### 漏洞数据库（一手）

- **CVE-2025-46570** / GHSA-4qjh-9fv9-r85r / PYSEC-2025-53 — Potential Timing Side-Channel Vulnerability in vLLM's Chunk-Based Prefix Caching
  - OSV — https://osv.dev/vulnerability/GHSA-4qjh-9fv9-r85r
  - NVD — https://nvd.nist.gov/vuln/detail/CVE-2025-46570
  - GitHub advisory — https://github.com/vllm-project/vllm/security/advisories/GHSA-4qjh-9fv9-r85r
  - 修复 PR — https://github.com/vllm-project/vllm/pull/17045

### 本课内部交叉引用

- `src/lessons/L14/content.mdx`（L14 结尾对本节的预告）
- `src/lessons/L02/content.mdx`（50 倍价差、「不变的往前放」）
- `src/lessons/L11/quiz.ts`（前缀缓存的成本上限约 25%）
- `src/lessons/L00/content.mdx` + `quiz.ts`（兼容层静默降级的承诺：「L15 会专门做一次实测来量这个缺口」）
- `labs/l14/verify.ts`（99 项测试的组织方式，本节实验的结构参照）

---

*报告完。全部数字均可追溯至上述一手来源；标注「查不到一手来源」的条目（见 11.10）未给出数值，请勿用二手来源补齐。*
