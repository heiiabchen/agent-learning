# L16y 调研：语音 agent——延迟预算就是产品

> 调研日期：2026-10-12。所有「访问日期」未特别注明者均为 2026-10-12。
> 置信度标注：**[P]** 一手直述（规范/官方文档/源码/论文原文）；**[P2]** 一手但需推断；**[S]** 二手（只当线索，不支撑任何数字或结论）。厂商自己发布的基准一律标「厂商自测」。
> 本文件边查边写，§0–§11 均已完成。
> 本地实测脚本：`/tmp/voice-research/split/`（§7）。框架源码：LiveKit Agents commit `cfa9d85e`、Pipecat commit `19fca83d`（`/tmp/voice-research/`）。

## 0. 反转清单（INV-1…34）

格式：**说法/直觉 → 实际情况 → 一手引用**（完整 URL 与访问日期见括号里的章节）。

**A. 人类话轮与延迟的读法**

- **INV-1** 「人类话轮间隙 200ms，agent 也要 200ms 内回答」→ 200ms 是**面对面、是非问句**、含点头等视觉回应的众数/均值；人的语言生产延迟 >600ms，人是**预测**对方说完，不是对静音做反应。→ Stivers 2009："we restricted the comparison to polar questions"；Levinson & Torreira 2015："the latencies involved in language production are much longer (over 600 ms)"（§2.1）[P]
- **INV-2** 「静音阈值调好就能分开'说完了'和'在想'」→ 同一人轮内停顿平均比换人间隙**更长**约 25%，静音长度这一个特征在分布上分不开两类事件；任何阈值都同时切人和慢。→ Levinson & Torreira 转述 ten Bosch 2005："about 140 ms (c. 25%) longer than the average gap in turn transitions"（§2.1）[P2]
- **INV-3** 「慢一点只是体验差一点」→ ≥600–700ms 的沉默会被听者解读为"不情愿/要拒绝"。→ "gaps of 700 ms or more are associated with dispreferred actions … gaps of 600 ms or longer generate inferences of this unwelcome kind"（§2.1）[P；人-机适用性无一手证据]
- **INV-4** 「电话里没有视觉线索，用户更能等」→ 电话语料里换轮反而更快、重叠更多（44%→52%）。→ "transition speeds are higher on the phone than face-to-face"（§2.1）[P2]
- **INV-5** 「论文实测 TTFA 755ms，级联能做到亚秒」→ 755 = LLM 296 + 分句 143 + TTS 316，**不含 STT 和 700ms 静音等待**；按论文自己的数字，用户闭嘴到首音 ≥1.8s。→ 2603.05413 Table 4 与 §5 VAD 状态机（§1.1）[P + P2 算术]
- **INV-6** 「各段 p50 相加 = 端到端 p50」→ 统计上不成立；论文 "Est. E2E" 行连 mean 都不是简单相加。→ 表注 "sequential upper bound"（§1.1、§2.4）[P2]
- **INV-7** 「首音延迟是一个确定的数」→ 至少 4 个起点 × 4 个终点；LiveKit `e2e_latency` 从 VAD 停止到服务端首帧（含话轮等待、不含下行），论文从 LLM 请求到 TTS 首块。→ `e2e_latency = started_speaking_at - user_metrics["stopped_speaking_at"]`（§2.3）[P]
- **INV-8** 「G.114 说语音要 150ms 内响应」→ 150ms 是**单向嘴到耳传输**，不含对方处理；agent 里管道延迟出现两次（上行推迟话轮判定、下行推迟首音）。→ G.114："end-to-end (i.e., "mouth-to-ear" in the case of speech) delays of less than 150 ms"（§2.2）[P]
- **INV-9** 「端到端模型 160/234ms，比级联快一个数量级」→ 那是 **theoretical**（Qwen3-Omni 还限定 cold-start）；第三方在托管 API 上量到 ~702ms，自托管全流水线 ~146s；全双工的"延迟"不是"说完到开口"。→ Moshi "theoretical latency of 160ms, 200ms in practice"；Qwen3-Omni "theoretical end-to-end first-packet latency of 234 ms"（§1.3）[P，厂商自报]
- **INV-10** 「架构就是级联 vs 端到端二选一」→ OpenAI 官方现列三种：GPT-Live（全双工前台 + 委派后台）、Realtime、级联；真正的轴是"说话的模型和做事的模型是否同一个、是否并行"。→ voice-agents.md 架构表（§1.2）[P]

**B. 话轮检测**

- **INV-11** 「OpenAI Realtime 默认就是语义话轮检测」→ 默认 `server_vad`：静音 500ms、阈值 0.5、前置 300ms；`semantic_vad` 要显式开。→ SDK 类型："Defaults to 500ms"（§3.1）[P]
- **INV-12** 「语义话轮模型让 agent 更快接话」→ LiveKit 的模型**只能延长**等待：EOU 概率低于语种阈值时从 `min_delay` 0.5s 切到 `max_delay` 3.0s，从不低于 0.5s。→ `audio_recognition.py` 的 `end_of_turn_probability < unlikely_threshold` 分支（§3.2）[P]
- **INV-13** 「semantic VAD 就是更聪明的快速 VAD」→ `eagerness` 实际控制的是**最长等待**：low/medium/high = 8s/4s/2s。→ "have max timeouts of 8s, 4s, and 2s"（§3.1）[P]
- **INV-14** 「投机生成是高级可选优化」→ LiveKit `preemptive_generation` **默认开**、Pipecat 有 eager 策略；被撤回的生成是常态（Deepgram 自报 "50-70% more LLM calls"，厂商自报）。→ `_PREEMPTIVE_GENERATION_DEFAULTS` enabled True（§3.2、§3.4）[P]
- **INV-15** 「投机结果有效 = 转写没变」→ LiveKit 的有效性是**四元组**：转写（casefold、去标点）、chat_ctx、tools、tool_choice；Flux 则用协议保证 EagerEndOfTurn 与 EndOfTurn 转写一致。→ "because the transcript, chat context, tools, or tool choice changed"（§3.2、§3.4）[P]
- **INV-16** 「投机时用的那版转写写进上下文」→ 写入的永远是 committed 版。→ Pipecat："the user message written to the context is always the committed transcript, never the eager one"（§3.3）[P]
- **INV-17** 「一个话轮阈值通吃所有语言」→ LiveKit 多语种模型每种语言单独校准阈值（zh 0.0066、en 0.011），把 TPR 固定在 ≈0.993；Deepgram `flux-general-multi` 的 10 种语言不含中文。→ HF `languages.json` v0.4.1-intl（§3.4b）[P]

**C. 打断与过期生成**

- **INV-18** 「用户一出声就打断」→ 约 40% 的换轮本来就是重叠，<120ms 的重叠/间隙不被感知，"嗯嗯"不是抢话；LiveKit 打断要求持续 0.5s，误打断 2s 无转写则恢复。→ Levinson & Torreira（Heldner 2011）；`_INTERRUPTION_DEFAULTS`（§2.1、§3.2）[P]
- **INV-19** 「打断后把生成的整句留在历史里没关系」→ 服务端生成快于实时，生成 ≠ 发送 ≠ 播放；不截断，模型会"记得"自己说过用户没听到的话。→ OpenAI："Truncating audio will delete the server-side text transcript to ensure there is not text in the context that hasn't been heard by the user."（§4.1）[P]
- **INV-20** 「各家打断后的历史语义一样」→ Gemini 保留"**已发送**给客户端"的内容，OpenAI 截到"**已播放**"位置，LiveKit 按语速估算已播文本、一帧没播则整条丢弃。→ Gemini："Only the information already sent to the client is retained in the session history"（§3.4c、§4.1）[P]
- **INV-21** 「打断 = abort 所有在途请求」→ **话语**要取消，**后台任务**可以继续；"闭嘴"≠"取消订单"。这是 L16「取消渲染 ≠ 取消生成」在语音里的对应。→ GPT-Live："Interrupting the spoken conversation leaves backend work running."（§4.2）[P]
- **INV-22** 「打断截断是服务端的事」→ 只有 WebRTC/SIP 下服务端知道播放进度并自动截断；WebSocket 下客户端必须自己算 `audio_end_ms` 并发 truncate，且 `output_audio_buffer.clear` 不存在。→ OpenAI SDK 类型 docstring（§4.1、§5.1）[P]
- **INV-23** 「开了 `echoCancellation` 就不会自己打断自己」→ W3C 规范只**保证**消除 `RTCPeerConnection` 来源的远端音频，消除所有系统播放只是 SHOULD；用 WebSocket 收 PCM、`AudioContext` 播放无规范保证。而"agent 说话时压低麦克风"的 echo gate 会连 barge-in 一起废掉。→ W3C："`true` MUST attempt to cancel at least as much as "`remote-only`""（§5.1、§5.4）[P]

**D. 传输**

- **INV-24** 「前端熟 WebSocket，浏览器端用它发 PCM 最简单」→ 官方建议浏览器/移动端用 WebRTC；WebSocket 下采集、缓冲、重采样、截断全归你。→ "For browser and mobile applications, start with WebRTC."（§5.1）[P]
- **INV-25** 「改 `audio.format` 配置就会转码；PCM 随便切块」→ 配置不转换字节；PCM16 块必须偶数字节（和 L16 的 UTF-8 被 chunk 劈开同构）。→ "Changing the format setting does not convert your input bytes." "their byte length must be even"（§5.2）[P]

**E. 语音里的工具调用**

- **INV-26** 「加填充语掩盖延迟总是好的」→ 官方：用不好会**增加**感知延迟；直接答案、确认/纠正、轻量工具都不该加。→ "Used poorly, they become filler and increase perceived latency."（§6.1）[P]
- **INV-27** 「工具开始 N 秒后播填充语」→ LiveKit 要求会话**连续空闲** `delay` 秒才触发，任一方开口就重置；"开始后 N 秒"会和用户的话撞车。→ "waits for the session to be continuously idle for ``delay`` seconds"（§6.1）[P]
- **INV-28** 「延迟和成本是两条独立的轴（L15）」→ GPT-Live 按会话秒数计费，沉默和后台干活都计费，工具慢一秒就多付一秒；Realtime 按 token 计费，VAD 过滤空音频——同厂两产品方向相反。→ "Active session time includes time when … both are silent, or the backend is working."（§6.2）[P]
- **INV-29** 「发起工具调用时就可以口头说'已帮您办好'」→ 口头更新必须匹配**已验证**状态；用户改需求后旧结果作废；重试前先查是否已发生（L19 幂等）。→ "ignore results from the outdated Friday request"；"a lost response should not cause a second booking"（§6.3）[P]
- **INV-30** 「服务端确认收到 = 用户已经听到」→ 确认只代表"估计已注入上下文"，不代表已说出或已播放。→ "The acknowledgment waits for estimated context injection, not for speech or playback to finish."（§6.3）[P]

**F. TTS 分句**

- **INV-31** 「见到句号就切」→ `.` 可能是句号、小数点、缩写、域名，必须前瞻；本地实测 naive 切分在英文样本 8 段里误切 5 处，并把中文后引号甩给下一段。→ Pipecat："``Dr. N`` and ``$29.9`` stay buffered"；§7.3 实测 [P + 实测]
- **INV-32** 「英文上验证过的分句规则，中文也能用」→ 论文规则在中文上 **0 次切分**（首段 = 整个回答，zh-basic 1410ms vs 570ms）；LiveKit 的 `min_sentence_len=20` 字符让中文首段变成 29 字 ≈ 英文首段 4 倍的语音时长，还在中文句间插空格。→ §7.3 实测（LiveKit 真实代码）[实测]
- **INV-33** 「文本越早送进 TTS 越好」→ TTS 要上下文才有好韵律：ElevenLabs 默认首块至少 120 字符，`auto_mode` 只建议整句使用。→ "sending partial phrases will result in highly reduced quality"（§7.1）[P]
- **INV-34** 「同一条正则在 TS 和 Python 里行为一致」→ `\w`、`\d`、`.length` 三处都不同（`\w` 匹配"好"：TS false / Python true；`"好😀".length` 3 vs 2）。→ §7.4 本地探针 [实测]

## 1. 架构：级联 vs 端到端

### 1.1 arXiv 2603.05413（Salesforce AI Research，*Building Enterprise Realtime Voice Agents from Scratch*）——数字要会读

URL：https://arxiv.org/abs/2603.05413 （访问 2026-10-12，HTML 版全文）

这是用户点名的一手论文。它的价值不在结论（"级联仍是自托管的唯一可行架构"），而在于**它自己的数字表把「首音延迟」这个词的歧义暴露得一清二楚**——这正好是课上要教的读数能力。

**它对端到端的实测** [P]：

> "its cloud-only DashScope Realtime API achieves ∼702ms audio-to-audio latency with streaming, but is not self-hostable; its local vLLM deployment supports only the Thinker (text generation from audio, 516ms), not the Talker (audio synthesis); and its local Transformers deployment runs the full pipeline but at ∼146s—far too slow for realtime."

> "Qwen2.5-Omni … the DiT-based Talker operates at ∼0.5× realtime (∼2s to generate 1s of audio), yielding ∼13s TTFA even with sentence-level streaming."

**它对级联的实测**（Table 4，原文）[P]：

| Component | P50 | Mean | Min | Max |
|---|---|---|---|---|
| *With cloud OpenAI API (GPT-4.1-mini)* | | | | |
| Deepgram STT | 402 | 407 | 184 | 601 |
| LLM TTFT | 457 | 622 | 278 | 784 |
| ElevenLabs TTS TTFB | 221 | 226 | 216 | 253 |
| Est. E2E TTFA | 958 | 1054 | 715 | 1606 |
| *Pipeline test (streaming, measured end-to-end)* | | | | |
| LLM TTFT | 296ms | | | |
| Sentence detection | 143ms | | | |
| TTS synthesis | 316ms | | | |
| Measured TTFA | 755ms | | | |

表注原文："TTFA estimated as STT + LLM TTFT + TTS TTFB (sequential upper bound)."

**三处必须教学员读出来的东西** [P2，均为对上表的算术推断]：

1. **「Measured TTFA 755ms」里没有 STT，也没有端点等待。** 296 + 143 + 316 = 755，一毫秒不差，三项分别是 LLM、分句、TTS。而同一篇论文第 5 节写明它的 VAD 状态机是 `LISTENING —silence 700ms→ PROCESSING`，即用户说完之后先要等 700ms 静音才开始处理。所以从**用户闭嘴到听见第一个音**，按它自己的数字至少是 700（静音判定）+ ~400（STT 出终稿，P50）+ 755 ≈ **1.8 秒以上**，而不是标题里的"sub-1-second"。论文正文并没有隐瞒这些数字，只是 "TTFA" 这个词的起点被放在了"LLM 请求发出"。
2. **「Sentence detection 143ms」是一个独立的延迟项。** 分句器要等到第一个句末标点才把文字交给 TTS——这 143ms 是**等字**，不是算力。第 7 节分句实验会量化它。
3. **P50 不能相加。** "Est. E2E TTFA" 的 P50 958 = 402+457+221 是把三个分量的 P50 相加，这在统计上不是总和的 P50（分量不独立、分布偏斜时尤其不是）。Mean 可以相加（1054 ≈ 407+622+226 = 1255？——实际不等，说明这一行也不是简单求和，论文没交代算法）。教学上的结论：**延迟预算按分量的 p95 做加法是保守上界，按 p50 做加法既不是上界也不是中位数。**

它对生产格局的判断 [P，但属作者断言，非测量]：

> "Level 3: Cascaded pipeline (ASR → LLM → TTS) … This is the architecture used by all production voice agents (Vapi, Retell, Bland.ai, and systems built with Pipecat/LiveKit)."

注意这句话是作者的概括，不是调查数据；而且它说的是"自托管"语境。OpenAI Realtime 本身就是生产级的端到端 API，所以"所有生产系统都是级联"作为全称判断不成立，只能读作"自建平台多为级联"。

它对分句器的描述 [P]（第 7 节会用）：

> "1. Detect sentence-ending punctuation (., !, ?) followed by whitespace. 2. Exclude false positives from abbreviations (Dr., Mr., PM.) and decimal numbers. 3. Enforce a minimum sentence length (10 characters) to avoid sending fragments to TTS. 4. Flush any remaining text when the LLM stream ends."

——这条规则**对中文完全失效**：中文句号 `。` 后面不跟空格，`(., !, ?) followed by whitespace` 一个都匹配不到，整段回答会一直攒到流结束才 flush。§7 有实测。

它对回声的处理 [P]：

> "Browser echo cancellation (echoCancellation: true in getUserMedia) handles acoustic echo; the server adds a simple echo gate that attenuates mic input while the agent is speaking."

"echo gate"（agent 说话时压低麦克风）是一个会**直接废掉打断功能**的做法——agent 说话时用户的声音也被压了。见 §5.4。

### 1.2 2026 年的官方答案已经不是二选一：第三条路是「全双工语音前台 + 委派后台」

来源：OpenAI *Voice agents* https://developers.openai.com/api/docs/guides/voice-agents.md ；*Getting started with GPT-Live* https://developers.openai.com/api/docs/guides/live.md ；*Delegation and tools in GPT-Live* https://developers.openai.com/api/docs/guides/live-delegation.md （均访问 2026-10-12）。

OpenAI 官方文档现在给的架构表是**三行**，不是两行 [P]：

| Architecture | Best for | Why choose it |
|---|---|---|
| GPT-Live | Full-duplex conversations with a separate backend | Keep your existing text workflow and choose its backend independently while the conversation continues. |
| Realtime API | Speech, reasoning, and tool use in one session | Use one model to interpret audio, decide what to do, and respond in speech. |
| Chained voice pipeline | Control over each speech and text stage | Inspect or transform intermediate text and replace each component independently. |

GPT-Live 的定义 [P]：

> "GPT-Live can listen and speak at the same time, a capability called **full duplex**. The live model handles the spoken interaction and delegates reasoning and tool use to a separate backend. Users can keep talking while backend work runs."
>
> "Keep speaking behavior in the live model's prompt and business rules in the backend prompt."

级联的官方定位 [P]：

> "Use this path when each stage needs to be visible or replaceable. For example, you might store the transcript, run policy checks before the text agent responds, call internal systems, then generate speech only after the workflow reaches an approved answer."

**这条对课程的意义**：

1. "级联还是端到端"这个暂定主题的框架**在 2026 年已经过时了一半**。真正的设计轴是「**说话的模型**和**做事的模型**是不是同一个」。Realtime = 同一个；级联 = 不同且串行；GPT-Live = 不同且**并行**（说话的模型在后台干活时继续和用户聊）。
2. 并行带来了一个级联和单模型都没有的问题：**说话的模型说了什么，和后台实际做成了什么，可能不一致**。这正是暂定主题里"说到一半的答案与工具结果冲突"——在 GPT-Live 架构下它从边界情况变成了**核心不变量**（§6）。
3. Salesforce 论文（§1.1）那个"自托管只能级联"的结论在 2026-03 发表时成立，但它比较的是"Qwen3-Omni 能不能替代级联"，没有考虑"语音前台 + 文本后台"这种混合形态——这种形态下前台可以是托管的 S2S 模型，后台仍然是你自托管的 agent（GPT-Live 的 client delegation："Connect your own agent or workflow, using the backend model and provider you choose."）。

**生产主流到底是哪个？** 我**没有找到一手的市场份额数据**。Salesforce 论文的"all production voice agents"是作者断言（§1.1）；OpenAI 文档没有说哪种更常见；LiveKit/Pipecat 两个框架同时支持级联和 realtime 模型。所以讲义不应该说"2026 年生产主流是 X"，只能说"三种架构都有官方一手支持，选择轴是可观测性/可替换性 vs 延迟 vs 前后台是否需要并行"。（列入 §11 无来源清单。）

### 1.3 端到端模型的一手延迟数字：「theoretical」这个词要圈出来

**Moshi**（Kyutai，arXiv 2410.00037，https://arxiv.org/abs/2410.00037 ，访问 2026-10-12）[P]：

> "Our resulting model is the first real-time full-duplex spoken large language model, with a theoretical latency of 160ms, 200ms in practice"
>
> "with a theoretical latency of 160 ms—lower than the 230 ms average in natural conversations measured over 10 languages (Stivers et al., 2009)."
>
> "this delay pattern induces a theoretical latency of 8 timesteps, which amounts to 640ms, a latency that is incompatible with the requirements of a real-time dialogue model. … we pretrain Moshi with an acoustic delay of 2 and finetune it with an acoustic delay of 1, for a theoretical latency of 160ms."

**Qwen3-Omni 技术报告**（arXiv 2509.17765，https://arxiv.org/abs/2509.17765 ，访问 2026-10-12）[P，厂商自报]：

> "In cold-start settings (no prior context), Qwen3-Omni achieves a theoretical end-to-end first-packet latency of 234 ms."

**第三方对同一家族的实测**（§1.1，Salesforce 2603.05413）[P]："its cloud-only DashScope Realtime API achieves ∼702ms audio-to-audio latency with streaming … its local Transformers deployment runs the full pipeline but at ∼146s"。

**读法**：
1. **"theoretical" 是模型结构决定的算法延迟**（Moshi = 帧长 × 声学延迟步数），不含网络、排队、批处理、硬件。Moshi 自己报了 practice 200ms；Qwen3-Omni 只报 theoretical 234ms 且限定 "cold-start (no prior context)"。第三方在托管 API 上量到约 702ms——**同一家族差三倍**，而且自托管全流水线跑不起来。
2. **全双工模型的"延迟"和级联的"首音延迟"定义不同**：Moshi 没有"话轮结束"这个事件（它一直在听、一直可以说），160ms 是"输入一帧到能影响输出"的结构延迟，**不是**"用户说完到 agent 开口"。拿 160ms 和级联的 1.8s 比，是在比两个不同的量。
3. Moshi 自己引 Stivers 时写的是 "230 ms average"，而 Stivers 原文全数据均值是 +208ms（§2.1）——小差异（可能是按语种均值再平均），但说明**"人类 200ms"这个数在二次引用中会漂移**，讲义应只引原文。




## 2. 延迟预算拆解与「首音延迟」

### 2.1 人类话轮间隙：「200ms」这个数到底是什么

**Stivers et al. 2009**，*Universals and cultural variation in turn-taking in conversation*，PNAS 106(26)。URL：https://pmc.ncbi.nlm.nih.gov/articles/PMC2705608/ （访问 2026-10-12）

数字本身 [P]：

> "we find that the response timings for each language, although slightly skewed to the right, have a unimodal distribution with a mode offset for each language between 0 and +200 ms, and an overall mode of 0 ms … The medians are also quite uniform, ranging from 0 ms (English, Japanese, Tzeltal, and Yélî-Dnye) to +300 ms (Danish, ‡Ākhoe Hai‖om, Lao) (overall cross-linguistic median +100 ms)."
>
> "Danish has the slowest response time on average (+469 ms) and Japanese has the fastest (+7 ms). The mean response offset for the full dataset is +208 ms"

**但几乎没人引用的适用范围** [P]：

> "To achieve a natural control over the discourse environment to be compared, we took advantage of a universal context for turn transition, namely that between questions and their responses. For optimal comparability we restricted the comparison to polar questions (questions that expect a yes or no answer)."
>
> "In this study, only functional yes–no questions were included."

而且样本是**面对面视频**，回应里包含点头等可见信号 [P]：

> "When visible responses occurred in response to a question, they were faster than speech in every language"
> "We found in 9 of the 10 languages that responses were delivered earlier if the speaker was looking at the recipient while the question was asked"

所以「人类话轮间隙 200ms」严格说是「面对面、对是非问句、含点头等视觉回应」的**众数/均值**。它不是"人类能容忍的上限"，也不是"开放式问题的回答时间"。同一组数据里 [P]：

> "Nonanswer responses are significantly slower than answer responses … Confirmation responses are faster than disconfirmation responses"

**Levinson & Torreira 2015**，*Timing in turn-taking and its implications for processing models of language*，Frontiers in Psychology 6:731。URL：https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2015.00731/full （访问 2026-10-12）

这是本节最承重的一篇，因为它同时给出了**间隙**和**生产延迟**两个数 [P]：

> "the gaps between turns are short (of the order of 200 ms), but the latencies involved in language production are much longer (over 600 ms). This seems to imply that participants in conversation must predict (or 'project' as SSJ have it) the end of the current speaker's turn in order to prepare their response in advance."

**人不是靠"等静音"来接话的** [P]：

> "silence will only become recognizable as silence after c. 200 ms (after all the duration of voiceless stop consonants ranges up to 180 ms; cf. Heldner and Edlund, 2010), at which point it will still take a further minimally 200 ms to react (so 400 ms in total). … We now have, say, 550 ms from actual cessation of speech till beginning of a minimal response, and as Heldner and Edlund (2010) note 70–82% of responses are within 500 ms. Thus reaction to silence, although certainly possible in a minority of cases, would not seem to play a major role in the organization of turn-taking"

→ **一个"静音 N 毫秒后开始处理"的 agent，结构上就是 Levinson 说的那种人类基本不用的"对静音做反应"模型。** 静音计时器再调也追不上人类的 200ms，因为人类是在对方话还没说完时就已经开始准备了。这正是语义话轮模型、`preemptive generation`（§3.2–3.3）、Deepgram 的 `EagerEndOfTurn`（§3.4）存在的理由——它们都是"预测"而不是"反应"。

**沉默本身有含义** [P]：

> "Corpus analysis shows that gaps of 700 ms or more are associated with dispreferred actions, and that gaps longer than the norm (>300 ms) decrease the likelihood of an unqualified acceptance … Experimental work also shows that gaps of 600 ms or longer generate inferences of this unwelcome kind (Roberts et al., 2011)."

→ 这是"延迟预算就是产品"最硬的一条证据：**超过 600–700ms 的停顿不只是"慢"，它会被听者解读成"对方有问题/不情愿"。** 对客服 agent 来说，"您的退款可以办理"如果在 1.5 秒沉默之后才说出来，听者已经预期了一个"不行"。（这是人-人对话的研究，人-机是否同样适用没有一手证据，见 §11 无来源清单。）

**轮内停顿比轮间间隙更长** [P，Levinson & Torreira 转述 ten Bosch et al. 2005，属 P2 级二次引用]：

> "These rules predict that intra-speaker silent gaps (generated by rule 3) will be longer than inter-speaker ones, a fact shown to be correct on large samples of conversation [ten Bosch et al., 2005 report gaps between continuations by the same speaker to be about 140 ms (c. 25%) longer than the average gap in turn transitions between different speakers]."

→ **这一条直接判了"纯静音阈值"的死刑**：如果同一个人自己说话时的停顿平均比换人时的间隙还长，那么任何一个"短到能及时接话"的静音阈值，都必然会切断一部分用户的自然停顿；任何一个"长到不切断"的阈值，都必然比人类接话慢。静音长度这一个特征**在分布上就分不开**这两类事件。lab 观察实验 E1（§10.3）把这件事做成表。

**电话上更快，不是更慢** [P2，转述 Levinson 1983、ten Bosch et al. 2005]：

> "And intriguingly, transition speeds are higher on the phone than face-to-face (Levinson, 1983; ten Bosch et al., 2005)."
> "ten Bosch et al. (2005) report that the proportion of overlaps increases from 44% in face-to-face conversation to 52% in telephone conversation"

但同一篇文章的 Table 1 里标了"无眼神接触"的英语研究（Norwine & Murphy 1938：410ms；Sellen 1995：480ms）均值反而更大——**不同研究的编码方法不同**，作者自己加了 caveat："codings and methods differ somewhat in these studies"。教学结论只能是：**"电话里没有视觉线索所以用户更能等"这个直觉没有证据支持**；电话语料里的间隙均值大约在 350–450ms：

> "Brady (1968) reported average gap durations of 345–456 ms and medians from 264 to 347 ms (depending on the threshold used in the automatic detection of speech) in a corpus of sixteen telephone calls between friends in the USA. Task-oriented interaction shows surprisingly similar patterns [e.g., Verbmobil – a travel scheduling task by telephone, has geometric means of 380 ms (English), 363 ms (German), 389 ms (Japanese)]"

注意括号里那句：**间隙的测量值取决于自动检测语音时用的阈值**。这是一个学员容易忽略的方法学点——"静音多长"本身就依赖 VAD 的阈值，所以两个不同 VAD 下测出的"死寂时长"不可比（§9 评测）。

**重叠是常态，不是故障** [P]：

> "Heldner and Edlund (2010) found closely matching patterns across corpora, with combined scale (FTO) modes for speaker transition at c. 200 ms (i.e., a short gap) and c. 60% of transitions being gaps, 40% overlaps (including any overlap of greater than 10 ms; the modal overlap is less than 50 ms in the Spoken Dutch Corpus)."
>
> "Heldner (2011) himself has gone on to show most usefully that a gap or overlap under 120 ms is not perceived as gap or overlap, respectively."
>
> "overlaps are of different kinds, some (e.g., continuers like hmhm, or minimal terminal overlaps) not being heard as intrusions on the turn"

→ "用户一出声就打断 agent"的实现会把 40% 的正常换轮和所有的"嗯嗯"都当成打断。§4 的打断滞回就是为这个设计的。

### 2.2 电信标准：单向 150ms——它说的是"嘴到耳"，不是"回答时间"

**ITU-T G.114 (05/2003)** *One-way transmission time*（现行有效）。URL：https://www.itu.int/rec/T-REC-G.114-200305-I/en （PDF 访问 2026-10-12）[P]：

> "Regardless of the type of application, it is recommended to not exceed a one-way delay of 400 ms for general network planning"
>
> "Although a few applications may be slightly affected by end-to-end (i.e., "mouth-to-ear" in the case of speech) delays of less than 150 ms, if delays can be kept below this figure, most applications, both speech and non-speech, will experience essentially transparent interactivity."
>
> "NOTE 1 – The curve in Figure 1 is based on the effect of pure delay only, i.e., in the complete absence of any echo. … The effect of echo, as would be incurred due to imperfect echo control, will result in lower speech quality for a given value of one-way delay."

**常见误用**：「G.114 说语音延迟要低于 150ms，所以 voice agent 要在 150ms 内回答」。错的：G.114 讲的是**单向传输**（我的嘴 → 你的耳朵），是"管道"延迟，不包含对方思考的时间。对一个 voice agent 来说，用户听到的响应时间 ≈ **上行单向 + 话轮判定等待 + 处理 + 下行单向 + 播放缓冲**，G.114 的 150ms 只约束其中**两段管道**之和的每一段。

它对 agent 的实际意义有两个：
1. **管道每多 100ms，就是两次 100ms**：上行晚到 100ms 让话轮检测晚 100ms，下行晚到 100ms 让首音晚 100ms。用户感受到的是 200ms。
2. **编解码器本身有不可压缩的延迟**。G.114 附录 A.2.3 给出 IP 场景下每包一帧的编解码延迟 [P]："2 × frame size + look-ahead"（最小），实时最大 "3 × frame size + look-ahead"；每包 N 帧时最小为 "(N + 1) × frame size + look-ahead"。20ms 帧 → 至少 40ms + look-ahead，还没算网络和抖动缓冲。

Opus（WebRTC 的默认语音编码）的算法延迟范围 [P]（RFC 6716 §2，https://www.rfc-editor.org/rfc/rfc6716.txt ，访问 2026-10-12）："with algorithmic delays ranging from 5 ms to 65.2 ms"。

### 2.3 「首音延迟」至少有四种定义，各家用的都不一样

对一个前端工程师，最实用的类比是 L15 的 TTFT：**起点和终点各有好几个候选，选哪个决定了数字能差一倍**。

**起点候选**（从早到晚）：
- (a) 用户**实际**说完最后一个音（只有离线标注才知道）
- (b) VAD 判定的最后一个语音帧（`last_speaking_time`）
- (c) 话轮判定提交（= (b) + 静音等待 / 语义模型判定）
- (d) STT final 转写到达

**终点候选**（从早到晚）：
- (w) TTS 产出第一个音频字节（服务端）
- (x) 服务端把第一帧音频推进传输层
- (y) 客户端收到第一个音频包
- (z) 扬声器播放出第一个**非静音**样本（经过抖动缓冲、AudioContext 输出延迟、以及 TTS 的前导静音）

**各家实际用的** [P]：

| 来源 | 起点 | 终点 | 漏掉了什么 |
|---|---|---|---|
| arXiv 2603.05413 Table 2 "TTFA" | 话轮提交后（(c)/(d)，文中 STT 未计入） | TTS 首块 (w) | 话轮等待（论文自己用 700ms 静音）、STT、上下行网络、客户端缓冲 |
| LiveKit `e2e_latency`（`agent_activity.py`） | (b) VAD `stopped_speaking_at` | (x) 服务端音频输出捕获到第一帧 `started_speaking_at` | 下行网络、客户端缓冲；**包含**话轮等待 |
| LiveKit `EOUMetrics.end_of_utterance_delay` | (b) | (c) | —— 这是一个分段，不是端到端 |
| OpenAI voice agent eval | "audible response latency" / "useful spoken response time" | 可听见的（(z) 方向） | 要求填充语和真答案分开测 |

LiveKit 源码定义 [P]：

> `e2e_latency = started_speaking_at - user_metrics["stopped_speaking_at"]`
>
> `end_of_utterance_delay`: "Amount of time between the end of speech from VAD and the decision to end the user's turn."
>
> `transcription_delay`: "Time taken to obtain the transcript after the end of the user's speech."

OpenAI 评测指南 [P]（*Voice agents* § Evaluate and improve）：

> "Use task and latency targets to compare task completion, audible response latency, interruptions, and unwanted silence. For latency targets, compare the median and 95th percentile."
>
> "Measure acknowledgments such as "I'm checking" separately from the answer the caller needs."

→ **教学结论**：
1. 一个 755ms 的 TTFA（论文）和一个 1.4s 的 e2e（假设的 LiveKit 读数）**可能是同一个系统**——差的那部分就是话轮等待。比较延迟数字前先对齐起点和终点。
2. **"首音"应该区分"首个可听见的音"和"首个有用的音"**。一个先说"我查一下"再说答案的 agent，前者 400ms、后者 3s。只报前者是自欺。OpenAI 官方明确要求分开测。
3. 前端能控制的终点段（(y)→(z)）不是零：Web Audio 的输出延迟、播放队列的预缓冲、TTS 音频开头的静音。LiveKit 里有一个 `_AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 0.25`（§3.2 已记）就是为了容忍 TTS 前导静音。

### 2.4 预算表：哪些段能并行、哪些只能串行

把 §1.1 论文的数字、§3 的默认参数、G.114 放到一张表里（**这张表是本报告的拼合，不是任何单一来源的数字**；每格标注来源）：

| 段 | 典型值 | 来源 | 能否和上一段重叠 |
|---|---|---|---|
| 上行网络 + 编码 | 数十 ms | G.114 编解码公式；无一手的典型 RTT | —— |
| 话轮判定等待 | 500ms（OpenAI `silence_duration_ms` 默认）/ 500ms 起（LiveKit `min_delay`）/ 700ms（论文实验） | §3.1–3.2 [P]；论文 [P] | 不能：这段就是在等 |
| STT final | 论文未计 | —— | 能（流式 STT 和话轮等待并行） |
| LLM 首 token | 论文 Table 2 LLM TTFT 列 | §1.1 [P] | 能（`preemptive_generation` 在等待期间就开始） |
| 首句凑够 | 取决于分句规则；Pipecat 自报"等词完整"最多 297ms | §7 [P，vendor 注释] | 部分（流式 LLM 边出边凑） |
| TTS 首块 | 论文 Table 2 TTS TTFB 列 | §1.1 [P] | 能（`preemptive_tts`，LiveKit 默认关） |
| 下行网络 + 抖动缓冲 + 播放 | 数十 ms 级 | 无一手典型值 | —— |

**两条读法**：
- **p50 不能相加**：每段的 p50 加起来不是端到端的 p50（分布不独立、长尾叠加）。论文自己报的是分段 p50，读者不应把它们加成"端到端中位数"。要么测端到端分布，要么在模拟里用 p95 相加做**保守**预算。
- **话轮等待是唯一一段"什么都不做、纯在等"的时间**，而且它在默认配置下就是最大的一段。所以"延迟优化"在语音里的第一刀不是换更快的 LLM，而是**让 LLM 在话轮等待期间就开始**（投机生成）——代价是被撤回的生成（§3.3 Pipecat 的 eager 撤回、§3.4 Flux 自报 "50-70% more LLM calls"）。



## 3. 话轮检测

### 3.1 OpenAI Realtime：默认是静音计时，不是语义

来源：OpenAI *Voice activity detection (VAD)* 指南 https://platform.openai.com/docs/guides/realtime-vad ；openai-python 由 OpenAPI spec 生成的类型 `src/openai/types/realtime/realtime_audio_input_turn_detection.py`（https://github.com/openai/openai-python ，main 分支，访问 2026-10-12）。

**默认模式** [P]：

> "For sessions and models that support VAD, the default value is `server_vad`."
> "`server_vad`: Automatically chunks the audio based on periods of silence."
> "`semantic_vad`: Chunks the audio when the model believes based on the words said by the user that they have completed their utterance."

**默认值**（SDK docstring，生成自官方 OpenAPI spec）[P]：

> `prefix_padding_ms`: "Amount of audio to include before the VAD detected speech (in milliseconds). Defaults to 300ms."
> `silence_duration_ms`: "Duration of silence to detect speech stop (in milliseconds). Defaults to 500ms. With shorter values the model will respond more quickly, but may jump in on short pauses from the user."
> `threshold`: "Activation threshold for VAD (0.0 to 1.0), this defaults to 0.5."

**语义 VAD 的超时上限** [P]：

> `eagerness`: "`auto` is the default and is equivalent to `medium`. `low`, `medium`, and `high` have max timeouts of 8s, 4s, and 2s respectively."

指南对语义 VAD 机制的描述 [P]：

> "This classifier scores the input audio based on the probability that the user is done speaking. When the probability is low, the model will wait for a timeout, whereas when it is high, there is no need to wait. For example, user audio that trails off would result in a longer timeout than a definitive statement."

**教学要点**：

- 「接上 Realtime 就有智能话轮」是错的——**默认是 500ms 静音计时**。语义 VAD 要显式打开。
- 语义 VAD 的"最长等待"是 2–8 秒，比静音计时的 500ms **长一个数量级**。它换来的是少截断，代价是"拖尾的话"会让 agent 在最坏情况下沉默 4 秒（默认 medium）。所以语义话轮不是"又快又准"，是**把延迟分布变成双峰**：确定的句子几乎不等，犹豫的句子等很久。这直接影响 §9 的评测设计——只报 p50 会把这件事藏起来。
- `idle_timeout_ms`（仅 server_vad）[P]："The timeout value will be applied after the last model response's audio has finished playing, i.e. it's set to the `response.done` time plus audio playback duration." ——注意它的计时起点是**播放完**，不是**生成完**。这和 §4 的"服务端比实时快"是同一件事的另一面：服务端的 `response.done` 不等于用户听完。
- `audio_start_ms`（speech_started 事件）[P]："This will correspond to the beginning of audio sent to the model, and thus includes the `prefix_padding_ms` configured in the Session." ——即 VAD 报出的"开始说话"时刻**比真实检测时刻早 300ms**（被 padding 回填了）。用它算"打断响应时间"会算错 300ms。

**push-to-talk 不是退步** [P]（*Realtime conversations* 指南）：

> "For some apps this works surprisingly well -- it gives the users control over interactions, avoids VAD failures, and it feels snappy because we're not waiting for a VAD timeout."

官方自己承认 VAD timeout 是可感知的延迟源。

### 3.2 LiveKit Agents：语义模型只能「延长」等待，不能「缩短」

源码：`livekit/agents`，commit `cfa9d85e69bcef513db055d1973d2ce6ca5ec15d`（2026-10-12），文件 `livekit-agents/livekit/agents/voice/turn.py`、`audio_recognition.py`、`endpointing.py`。文档：https://docs.livekit.io/agents/build/turns/ （访问 2026-10-12）。

**默认值** [P]（`turn.py`）：

```python
_ENDPOINTING_DEFAULTS: EndpointingOptions = {
    "mode": "fixed",
    "min_delay": 0.5,
    "max_delay": 3.0,
    "alpha": 0.9,
}

_STREAMING_ENDPOINTING_DEFAULTS: EndpointingOptions = {
    "mode": "fixed",
    "min_delay": 0.3,
    "max_delay": 2.5,
    "alpha": 0.9,
}
```

docstring 原文："`min_delay`: Minimum time (s) since last detected speech before declaring the user's turn complete. Defaults to ``0.5``." / "`max_delay`: Maximum time (s) the agent waits before terminating the turn. Defaults to ``3.0``."

**语义模型怎么用** [P]（`audio_recognition.py` `_bounce_eou_task`）：

```python
endpointing_delay = self._endpointing.min_delay
...
if (
    end_of_turn_probability is not None
    and unlikely_threshold is not None
    and end_of_turn_probability < unlikely_threshold
):
    endpointing_delay = self._endpointing.max_delay
```

→ **反转**：turn detector 模型**从不让 agent 比 `min_delay` 更快接话**。它只做一件事：当"说完了"的概率低于某个语言相关的阈值时，把等待从 0.5s 延长到 3.0s。所以"上了语义话轮模型 → 响应更快"是错的；它的作用是**少截断**，代价是在"看起来没说完"时多等。速度来自另一个机制——preemptive generation（§3.3 末尾、§8）。

**动态端点** [P]（`endpointing.py` `DynamicEndpointing` docstring）：

> "``min_delay`` is learned from the user's pausing behavior so we don't cut off a user who pauses mid-turn. It adapts from the following pauses: 1. Pauses between utterances … 2. Pauses between an utterance and next immediate interruption: [utterance] [   pause   ] [immediate interruption] (<- this should be a false EOT, and min delay should cover this)"
>
> "``max_delay`` is a fixed ceiling, not learned."

即：**用户在 agent 刚开口时就插话 = 上一次端点判早了**，这个停顿被拿来抬高 `min_delay`。这是一个可以直接写进 lab 的规则：把"立即打断"当作误截断的代理信号。默认 `mode: "fixed"`，即动态学习默认关闭。

**TTS 前导静音的宽限期** [P]（`endpointing.py`）：`_AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 0.25  # seconds`，注释："TTS leading silence can cause the agent speech timestamp to precede actual audible audio, making this look like a backchannel when it's really the user speaking before hearing the agent." ——又一处"已发出 ≠ 已听到"。

### 3.3 Pipecat：VAD 快停 + 模型判定 + 3 秒兜底

源码：`pipecat-ai/pipecat`，commit `19fca83d2e2336b7c82145fe66b7b1cc76e44ac9`（2026-10-11）。

**VAD 默认值** [P]（`src/pipecat/audio/vad/vad_analyzer.py`）：

```python
VAD_CONFIDENCE = 0.7
VAD_START_SECS = 0.2
VAD_STOP_SECS = 0.2
VAD_MIN_VOLUME = 0.6
```

VAD 是一个四态机 [P]：`QUIET → STARTING → SPEAKING → STOPPING`。`STARTING` 状态下任何一帧非语音直接回到 `QUIET`；`STOPPING` 状态下任何一帧语音直接回到 `SPEAKING` 并清零停止计数。帧数由 `round(start_secs / 每帧秒数)` 决定。判定语音的条件是 `confidence >= params.confidence and volume >= params.min_volume`——**置信度和音量两个门槛同时满足**。

**Smart Turn 默认值** [P]（`src/pipecat/audio/turn/smart_turn/base_smart_turn.py`）：

```python
STOP_SECS = 3
PRE_SPEECH_MS = 500
MAX_DURATION_SECONDS = 8  # Max allowed segment duration
```

判定 [P]（`local_smart_turn_v3.py`）：`prediction = 1 if probability > 0.5 else 0`。超过 `stop_secs` 的静音无条件判完成："End of Turn complete due to stop_secs"。只分析**最后 8 秒**音频："slices the array to keep the last max_samples samples, discarding the earlier part."

→ Pipecat 的设计是**把 VAD 的 stop 压到 200ms**（远短于 OpenAI 的 500ms、LiveKit 的 500ms），然后让一个**纯音频**模型判断"是否说完"，判"没说完"就继续等，最长 3 秒。这和 LiveKit 的"先等 min_delay 再问模型要不要延长"是**相反的默认姿态**：Pipecat 默认快、需要时慢；LiveKit 默认中速、需要时慢。两者的最长等待都在 3 秒左右。

**静音计时 + STT 安全网** [P]（`turns/user_stop/speech_timeout_user_turn_stop_strategy.py`）：

> "After the user stops speaking (detected by VAD), this strategy runs two independent timers. The user turn stop is triggered only when both have finished and at least one transcript has been received:
> - user_speech_timeout: Policy floor — the window in which the user may resume speaking after a pause. Always runs to completion.
> - stt_timeout: Safety net for STT latency — the P99 time for the STT service to return a final transcript after VAD stop, adjusted by the VAD stop_secs. Short-circuited when the STT service emits a finalized transcript"

默认 `user_speech_timeout: float=0.6`。→ **端点 = max(策略静音窗, STT 出终稿)**，而且"至少收到一条转写"是硬条件。这是一个学员第一版几乎一定会漏的条件：VAD 说停了但 STT 还没吐字，这时触发 LLM 等于拿空串去问模型。

**投机生成的三种撤回** [P]（`turns/user_stop/eager_user_turn_stop_strategy.py`）：

> "The prediction can be wrong in three ways, and each withdraws the response:
> - the user resumes speaking, and the service withdraws the eager end of turn
> - the committed transcript differs from the eager one, per ``match_policy``
> - the turn never commits within ``speculation_timeout``"
>
> "Nothing the speculation produces reaches the user or the context. The inference runs against a provisional context, and its response is held by the LLM service's SpeculationGate until the turn is confirmed. The turn ends normally: the user message written to the context is always the committed transcript, never the eager one."

默认 `speculation_timeout: float=5.0`。匹配策略 [P]（`eager_match_policy.py`）：`ExactMatch` "Keep the response only when the two transcripts are identical."；`NormalizedMatch` "Compares with case, punctuation and whitespace removed. Services commonly format the committed transcript — capitalizing it, punctuating it — while leaving the eager one raw, which ExactMatch counts as a difference."

**投机闸门** [P]（`turns/speculation_gate.py`）：三态 `OPEN / HOLDING / DROPPING`——

> "A speculative response is generated from an eager end of turn — a provisional guess that the user has finished talking — so it may answer a transcript the user never actually completed. This holds everything such a response produces until the turn is confirmed, then releases it, or discards it if the guess is withdrawn."
>
> "only one speculation is ever in flight, since producing one takes a whole user turn."

→ 这是 lab 里 `speculationValid` + `PlaybackLedger` epoch 机制的原型（§10.2 C/D）。和 L16 的对应：**`HOLDING` 状态的帧 = 已生成未渲染**，`DROPPING` = 对一个已作废的生成继续到达的尾巴静默丢弃（L16 `applyChunk` 里"aborted 之后到达的 delta 丢掉"的同构）。

LiveKit 侧的同一机制 [P]（`agent_activity.py`）：preemptive generation 在话轮提交时校验

```python
if (
    _transcripts_equivalent(preemptive.info.new_transcript, user_message.raw_text_content)
    and preemptive.chat_ctx.is_equivalent(temp_mutable_chat_ctx)
    and preemptive.tools == self.tools
    and preemptive.tool_choice == self._tool_choice
):
```

否则 `"preemptive generation invalidated after `on_user_turn_completed` because the transcript, chat context, tools, or tool choice changed"`。`_transcripts_equivalent` 用 `casefold()` 并忽略标点逐词比较。→ **一个投机生成的有效性是四元组相等，不是只比转写**。学员第一版通常只比转写，于是"用户说完话的同时某个工具列表变了"这种情况会放过一个过期生成。

**LiveKit preemptive 默认开启** [P]（`turn.py`）：

```python
_PREEMPTIVE_GENERATION_DEFAULTS: PreemptiveGenerationOptions = {
    "enabled": True,
    "preemptive_tts": False,
    "max_speech_duration": 10.0,
    "max_retries": 3,
}
```

docstring："When ``False`` (default), only LLM runs preemptively; TTS starts once the turn is confirmed" / "Beyond this threshold, preemptive generation is skipped since long utterances are more likely to change and users may expect slower responses."

→ 投机只投到 LLM，不投到 TTS——因为 TTS 是**按字符计费**且产出的是**用户会听到的东西**；投机 LLM 的浪费是 token，投机 TTS 的浪费是钱且有"放出去收不回来"的风险。这是成本账（接 L15）的一个具体落点。（"TTS 按字符计费"是常识性推断，本轮未逐家核对价格页，标 [P2]。）

### 3.4 Deepgram Flux：把话轮做进 STT 协议里

来源：*Understanding the Flux State Machine* https://developers.deepgram.com/docs/flux/state.md ；*End-of-Turn Detection Parameters* https://developers.deepgram.com/docs/flux/configuration.md ；*Optimize Voice Agent Latency with Eager End of Turn* https://developers.deepgram.com/docs/flux/voice-agent-eager-eot.md ；*Flux Multilingual & Language Prompting* https://developers.deepgram.com/docs/flux/language-prompting.md （均访问 2026-10-12）。

状态机 [P]：`Initial —StartOfTurn→ TurnOngoing —EagerEndOfTurn→ AwaitingEnd`，`AwaitingEnd —TurnResumed→ TurnOngoing`，`AwaitingEnd —EndOfTurn→ Initial`，任意在轮状态 `—ForceEndTurn→ Initial`。

**协议级保证**（这些可以直接变成 verify 断言）[P]：

> "2. An `EagerEndOfTurn` message always contains a nonempty transcript.
> 3. A `TurnResumed` message can only follow a preceding `EagerEndOfTurn` message.
> 4. The `EndOfTurn` transcript will always match the immediately preceding `EagerEndOfTurn` transcript. If the transcript changes after an `EagerEndOfTurn`, a `TurnResumed` event will occur first.
> 5. The `turn_index` increments immediately following an `EndOfTurn` message.
> 7. Every `EndOfTurn` event includes a `trigger` field — `model` (native detection), `manual` (`ForceEndTurn`), or `timeout` (`eot_timeout_ms`) — indicating what ended the turn."

> "Important: The transcript in `EagerEndOfTurn` will exactly match the transcript in the subsequent `EndOfTurn` event (if no `TurnResumed` occurs). This guarantees consistency for caching strategies."

→ 第 4 条是一个非常漂亮的设计：**它把"投机结果是否还有效"从调用方的模糊比较（LiveKit 的 casefold、Pipecat 的 NormalizedMatch）变成了协议保证**——只要没收到 `TurnResumed`，投机生成就一定有效。对比之下，没有这条保证的系统必须自己写匹配策略，而 Pipecat 那个 `NormalizedMatch` 存在的原因正是"终稿会加标点和大写"。

**打断信号** [P]：

> "Flux's `StartOfTurn` event is the recommended way to trigger barge-in — it's more reliable than an external VAD because every `StartOfTurn` is guaranteed to contain a non-empty transcript."

→ "用 VAD 触发打断"vs"用有转写的事件触发打断"：后者天然过滤了咳嗽、关门声、回声里的无字噪声，代价是多等 STT 出第一个词的时间。这和 LiveKit `min_words`、`false_interruption_timeout` 是同一个权衡。

**默认值** [P]：

| 参数 | 范围 | 默认 |
|---|---|---|
| `eot_threshold` | 0.5–1.0 | 0.7 |
| `eager_eot_threshold` | 0.3–0.9 | 不设（eager 关闭） |
| `eot_timeout_ms` | 500–60000 | 5000 |

> "`eager_eot_threshold` must be less than or equal to `eot_threshold` (if both are set). Setting `eager_eot_threshold > eot_threshold` will result in an error"

**成本** [P，厂商文档自述，无数据支撑]：

> "Good for trimming that last 100-200ms of end-to-end latency at the cost of 50-70% more LLM calls."

这是厂商文档里的一句定性估计，没有给测量方法；只能当"量级线索"，不能当数字引用。

**中文不在支持列表里** [P]：`flux-general-multi` 的 10 种语言是 en/es/fr/de/hi/ru/pt/ja/it/nl。**中文话轮场景不能用 Flux。**

### 3.4b LiveKit 多语种话轮模型的校准数据（含中文）

来源：LiveKit 源码 `livekit-plugins-turn-detector/.../models.py` 固定 `"multilingual": "v0.4.1-intl"`；该 revision 在 HuggingFace 上的 `languages.json`：https://huggingface.co/livekit/turn-detector/raw/v0.4.1-intl/languages.json （访问 2026-10-12）。

节选 [P，厂商自测]：

```json
"zh": { "threshold": 0.0066, "tpr": 0.9933, "tnr": 0.8661 },
"en": { "threshold": 0.011,  "tpr": 0.993,  "tnr": 0.8696 },
"ja": { "threshold": 0.0096, "tpr": 0.9934, "tnr": 0.888 },
"ko": { "threshold": 0.0156, "tpr": 0.9937, "tnr": 0.9449 },
"ru": { "threshold": 0.0032, "tpr": 0.9933, "tnr": 0.8803 },
"hi": { "threshold": 0.0398, "tpr": 0.994,  "tnr": 0.9627 }
```

源码里这个 `threshold` 就是 §3.2 那段 `unlikely_threshold`（`base.py`：`lang_data = self._languages.get(language.iso)` → `{"threshold": threshold}`）。

**读法** [P2，文件本身没有定义 tpr/tnr 的正类，以下按"正类 = 话轮结束"推断]：

1. 14 种语言的 TPR **全部被钉在 0.993–0.994**，而阈值在 0.0032（俄语）到 0.0398（印地语）之间相差 12 倍。也就是说阈值是**按语言倒推出来的**，目标是"真正说完的话轮里只有约 0.7% 被多等 2.5 秒"。这是一个**明确偏向低延迟**的设计选择：宁可漏抓没说完的，也不让说完的人多等。
2. 中文 TNR 0.8661 → 在已经静音满 `min_delay` 的"没说完"停顿里，约 **13%** 仍会被当作说完而被截断。这就是 §9 "误截断率"的一个厂商自测基线（注意它是在厂商自己的测试集上，且只覆盖"静音已满 min_delay"的子集）。
3. **阈值是概率值的千分之几**——这说明模型输出的 P(EOT) 分布极度偏斜。学员如果拿 0.5 当阈值（"概率过半就算说完"），在这个模型上会得到几乎永远"说完了"的结果。这是一个"看起来对、实际错"的实现，lab 可以用一个偏斜的合成概率序列抓住它。

### 3.4c Gemini Live：打断后保留的是「已发送」，不是「已播放」

来源：*Live API capabilities guide* https://ai.google.dev/gemini-api/docs/live-guide ；*Tool use with Live API* https://ai.google.dev/gemini-api/docs/live-tools （访问 2026-10-12；页面标注 "Preview: The Live API is in preview."）

**打断语义** [P]：

> "When VAD detects an interruption, the ongoing generation is canceled and discarded. Only the information already sent to the client is retained in the session history. The server then sends a `BidiGenerateContentServerContent` message to report the interruption."

→ **和 OpenAI 的关键差别** [P2]：OpenAI 的截断点是"客户端**播放**到哪里"（`audio_end_ms`，WebRTC 下服务端自己跟踪播放缓冲）；Gemini 的保留点是"已经**发送**给客户端的"。而服务端生成比实时快（OpenAI 文档明文，见 §4.1），所以"已发送"一般**领先于**"已播放"——客户端缓冲里还没播出来的那几秒，在 Gemini 的历史里算"说过了"。Gemini Live 文档里没有找到与 `conversation.item.truncate` 对等的客户端截断事件。课上的结论是：**"厂商自动处理打断"不等于"厂商把历史截到了用户听到的位置"，要逐家读语义。**

**音频格式** [P]：

> "Audio data in the Live API is always raw, little-endian, 16-bit PCM. Audio output always uses a sample rate of 24kHz. Input audio is natively 16kHz, but the Live API will resample if needed so any sample rate can be sent."

**VAD 配置字段** [P]：`realtimeInputConfig.automaticActivityDetection` 下有 `start_of_speech_sensitivity`、`end_of_speech_sensitivity`、`prefix_padding_ms`、`silence_duration_ms`、`disabled`。指南示例值是 `prefix_padding_ms: 20, silence_duration_ms: 100`——**这是示例，不是默认值**；本轮没有在官方 API reference 里找到这两个字段的默认值（见 §11 无来源清单）。

> "Alternatively, the automatic VAD can be disabled … In this configuration the client is responsible for detecting user speech and sending `activityStart` and `activityEnd` messages at the appropriate times."

**`send_realtime_input` 牺牲顺序换响应** [P]：

> "While `send_client_content` adds messages to the model context in order, `send_realtime_input` is optimized for responsiveness at the expense of deterministic ordering."

**模型代际与异步函数调用** [P]（live-guide 的 Model comparison 表，2026-10-12 版本）：Gemini 3.8 Live —— "Asynchronous function calling (`behavior: NON_BLOCKING`) … Supported (default). … Function scheduling (`SILENT`, `WHEN_IDLE`, `INTERRUPTED`) is supported."；Gemini 3.1 Flash Live Preview —— "Not supported. Function calling is sequential only. The model will not start responding until you've sent the tool response."

**文档内部不一致** [P]：同一时刻 *Tool use with Live API* 页的表格只列 "Gemini 3.1 Flash Live Preview | Gemini 2.5 Flash Live Preview"，写 2.5 支持 "synchronous and asynchronous"，并说 "Function calling executes sequentially by default"；而 live-guide 说 3.8 Live 异步是默认。两页对"默认是否阻塞"的说法依赖模型代际，且工具页没有更新到 3.8。**引用时必须带模型名。** scheduling 三值的定义以工具页为准 [P]：

> "Interrupt what it's doing and tell you about the response it got right away (`scheduling="INTERRUPT"`), Wait until it's finished with what it's currently doing (`scheduling="WHEN_IDLE"`), Or do nothing and use that knowledge later on in the discussion (`scheduling="SILENT"`)"

（注意 guide 页写 `INTERRUPTED`、工具页写 `INTERRUPT`——又一处不一致；以 SDK 枚举为准，本轮未核对 SDK。）

### 3.5 话轮检测的教学结论（汇总）

| 系统 | 默认静音窗 | 语义/模型判定 | 最长等待 | 投机 |
|---|---|---|---|---|
| OpenAI Realtime | 500ms（server_vad） | 需显式开 `semantic_vad` | semantic: 8/4/2s（low/medium/high） | 服务端内部，不暴露 |
| LiveKit | 0.5s（流式检测器 0.3s） | 默认开；只在"不像说完"时延长 | 3.0s（流式 2.5s） | 默认开，只投 LLM |
| Pipecat | VAD stop 0.2s；或 0.6s 静音策略 | Smart Turn（纯音频，>0.5 判完） | 3s | `EagerUserTurnStopStrategy`，超时 5s |
| Deepgram Flux | —（模型置信度驱动） | `eot_threshold` 0.7 | 5s | `eager_eot_threshold`，默认关 |

**这张表本身就是一条反转**：四家的"静音窗"从 0.2s 到 0.6s 不等，最长等待从 2s 到 8s 不等，**没有一个"行业标准值"**。而人类研究给出的"轮内停顿比轮间间隙更长"（§2.1）解释了为什么：单一静音阈值在原理上就分不开这两类停顿，所以每家都在静音之外叠了第二个信号（语义模型、音频模型、STT 置信度），而第二个信号的介入方式不同，导致第一个阈值的最优值不同。



## 4. 打断与过期生成

### 4.1 「服务端比实时快」——为什么必须截断历史

来源：OpenAI *Realtime conversations* 指南 § Interruption and Truncation https://platform.openai.com/docs/guides/realtime-conversations ；openai-python `conversation_item_truncate_event.py`、`conversation_item_truncated_event.py`、`output_audio_buffer_clear_event.py`、`response_cancel_event.py`（访问 2026-10-12）。

**根因** [P]（truncate 事件 docstring）：

> "Send this event to truncate a previous assistant message's audio. The server will produce audio faster than realtime, so this event is useful when the user interrupts to truncate audio that has already been sent to the client but not yet played. This will synchronize the server's understanding of the audio with the client's playback."

> "Truncating audio will delete the server-side text transcript to ensure there is not text in the context that hasn't been heard by the user."

**指南给出的动机** [P]：

> "Realtime API handles interruptions when VAD is enabled, in that it detects user speech, cancels the ongoing response, and starts a new one. However in this scenario you will want the model to know where it was interrupted, so it can continue the conversation naturally (for example if the user says "what was that last thing?"). We call this truncating the model's last response, that is, removing the unplayed portion of the model's last response from the conversation."

**传输决定谁负责** [P]：

> "In WebRTC and SIP connections the server manages a buffer of output audio, and thus knows how much audio has been played at a given moment. The server will automatically truncate unplayed audio when there's a user interruption."
>
> "With a WebSocket connection the client manages audio playback, and thus must stop playback and handle truncation."

WebSocket 下的三步 [P]：

> "1. The client monitors for new `input_audio_buffer.speech_started` events from the server, which indicate the user has started speaking. The server will automatically cancel any in-progress model response and a `response.cancelled` event will be emitted.
> 2. When the client detects this event, it should immediately stop playback of any audio currently being played from the model. It should note how much of the last audio response was played before the interruption.
> 3. The client should send a `conversation.item.truncate` event to remove the unplayed portion of the model's last response from the conversation."

```json
{ "type": "conversation.item.truncate", "item_id": "item_1234", "content_index": 0, "audio_end_ms": 1500 }
```

**三条容易写错的约束** [P]：

> `audio_end_ms`: "Inclusive duration up to which audio is truncated, in milliseconds. If the audio_end_ms is greater than the actual audio duration, the server will respond with an error."
> `item_id`: "Only assistant message items can be truncated."
> `content_index`: "Set this to `0`."

**文字稿不能精确截断** [P]：

> "What about truncating the transcript as well? The realtime model doesn't have enough information to precisely align transcript and audio, and thus `conversation.item.truncate` will cut the audio at a given place and remove the text transcript for the unplayed portion. This solves the problem of removing unplayed audio but doesn't provide a truncated transcript."

**WebRTC 下的手动清空** [P]：

> `output_audio_buffer.clear`: "**WebRTC/SIP Only:** Emit to cut off the current audio response. This will trigger the server to stop generating audio and emit a `output_audio_buffer.cleared` event. This event should be preceded by a `response.cancel` client event to stop the generation of the current response."

push-to-talk 流程第 4 步 [P]："send an `output_audio_buffer.clear` event to clear out the unplayed audio, this truncates the conversation as well."

**`response.cancel` 的幂等性** [P]：

> "If there is no response to cancel, the server will respond with an error. It's safe to call `response.cancel` even if no response is in progress, an error will be returned the session will remain unaffected."

### 4.2 和 L16 的同构关系（课上要点明）

| L16（文本） | L16y（语音） |
|---|---|
| `reset-step`：服务端说"这一步作废" | `response.cancelled`：服务端说"这次回复作废" |
| 已渲染 ≠ 已生成；撤回要删到 step 边界 | **已生成 ≠ 已播放 ≠ 已听到**；截断要删到播放位置 |
| 前端知道自己画了什么，服务端不知道 | 客户端知道自己播了多少，服务端不知道（WebSocket 下） |
| 不撤回 → 屏幕上重复半句话 | 不截断 → **模型以为用户听到了没播出来的内容**（"我刚才说过了，费用是 …"） |
| `onUnmount` 不该停止生成 | 打断应该停止**话语**生成，但**不一定**停止后台任务 |

最后一行要拆成两半讲，因为它一半和 L16 方向相反、一半方向相同：

- **话语（speech）方向相反**：L16 说"取消渲染 ≠ 取消生成"，组件卸载不要停生成；语音里用户一开口，正在生成的**那段话**就一定过期了（它是基于用户上一句话写的，而用户已经在说新的话）。所以对话语来说，打断 = 取消播放 **且** 取消生成 **且** 回滚历史。
- **后台任务（task）方向相同**：OpenAI GPT-Live 文档明文 [P]：

  > "Backend work can continue when the caller interrupts the assistant; your application decides whether to finish or cancel it."（*Getting started with GPT-Live*）
  >
  > "Interrupting the spoken conversation leaves backend work running."（*Delegation and tools*）
  >
  > "Handle changes to a task separately from interruptions to speech. "Stop talking" asks the assistant to yield; "Cancel my booking" asks the backend to take an action."（*Prompting GPT-Live* https://developers.openai.com/api/docs/guides/live-prompting.md ）

  这就是 L16"取消渲染 ≠ 取消生成"在语音里的精确对应：**"闭嘴" ≠ "取消订单"**。一个把 barge-in 直接接到"abort 所有在途请求"上的实现，会在用户说"嗯等一下"时把一笔已经在支付网关里跑的扣款请求的结果丢掉——钱扣了，agent 不知道。

所以语音的中断语义至少是 **两个信号 × 三个动作**：信号是"话语打断"和"任务取消"；动作是"停播放""停生成""改历史"。L16 的四种中断语义在这里变成了一张 2×3 的表，lab 的 `PlaybackLedger.bargeIn` 只做话语那一行，任务那一行交给 `TaskBoard`（§10.2 D/H）。

**"已听到"比"已播放"还要再往前一点** [P2]：OpenAI 的 `audio_end_ms` 是"客户端播放到哪里"，但播放缓冲（jitter buffer、AudioWorklet 队列、蓝牙耳机的额外缓冲）意味着"送进播放管线"≠"扬声器发出声音"。客户端应该用**实际播放位置**（如 `AudioContext.currentTime` 推导的已播样本数）而不是"已经 enqueue 的字节数"来算 `audio_end_ms`。官方文档只说 "note how much of the last audio response was played"，没有规定怎么算——这是推断，lab 里用"已入队 vs 已播放"两个计数器把它做成可断言的差别。



## 5. 传输

### 5.1 WebRTC vs WebSocket：官方建议按"谁在采集音频"选

OpenAI 两套产品的官方建议一致 [P]：

> "For browser and mobile applications, start with WebRTC."（*GPT-Live WebSocket guide* https://developers.openai.com/api/docs/guides/voice-websockets.md ）
>
> "WebSockets are a broadly supported API for realtime data transfer, and a great choice for connecting to the OpenAI Realtime API in server-to-server applications. For browser and mobile clients, we recommend connecting via WebRTC."（同页 Realtime 部分）
>
> "Use a primary WebSocket when your server captures audio or relays an audio stream for a client."

**为什么前端工程师的直觉在这里会错**：前端工程师对 WebSocket 很熟，对 WebRTC 陌生，第一反应是"用 WebSocket 发 PCM 不就完了"。官方给的理由（§3 已记的 "more consistent performance"）之外，有三个具体的、能在课上讲清楚的差异：

1. **打断时谁来清播放队列**。OpenAI Realtime：WebRTC/SIP 下服务端知道播放进度、自动截断；WebSocket 下**客户端**必须自己算播放到哪了并发 `conversation.item.truncate`（§4.1 [P]）。`output_audio_buffer.clear` 只在 WebRTC/SIP 下存在。→ 用 WebSocket，§4 的整套"截断到用户听到的位置"逻辑就落到了前端代码里。
2. **回声消除只保证覆盖 WebRTC 来源的声音**。W3C *Media Capture and Streams* 对 `echoCancellation` 的规定 [P]（https://www.w3.org/TR/mediacapture-streams/ ，访问 2026-10-12）：

   > "`true` means that the UA decides what audio will be removed from the signals recorded by the microphone. `true` MUST attempt to cancel at least as much as "`remote-only`" and SHOULD attempt to cancel as much as "`all`"."
   >
   > ""`remote-only`": The system MUST attempt to remove the sound from incoming audio `MediaStreamTrack` s sourced from WebRTC `RTCPeerConnection` s."

   也就是说：**标准只保证（MUST）消除来自 `RTCPeerConnection` 的远端音频**；消除"系统播放的所有声音"只是 SHOULD。用 WebSocket 收 PCM、用 `AudioContext` 播放的 agent 语音，**规范层面不保证**会被浏览器的回声消除去掉——agent 的声音从扬声器回到麦克风，被 VAD 当成用户说话，agent 打断自己（自打断）。实际浏览器行为**我没有一手测量**（列入 §11）；但规范给的保证就只有这么多，这足以解释为什么官方把浏览器端导向 WebRTC。
3. **背压与实时节奏**。WebSocket 是 TCP 上的有序可靠流：丢包会重传、后面的包排队（队头阻塞）。官方 WebSocket 指南对客户端的要求 [P]："supply a continuous microphone stream paced at its recorded sample rate. Piping an entire file at once does not simulate a live microphone." 以及 "your application handles capture, buffering, playback, and resampling when needed."——**这些在 WebRTC 下是浏览器替你做的**。

### 5.2 格式与采样率：一张对照表

| 产品 | 输入 | 输出 | 来源 |
|---|---|---|---|
| OpenAI GPT-Live（WebSocket） | `audio/pcm` 24kHz（默认）、16kHz；`audio/pcmu`、`audio/pcma` 8kHz | 同配置 | voice-websockets.md [P] |
| OpenAI Realtime API | PCM 24kHz；G.711 μ-law / A-law | 同 | openai-python 类型 [P]（§3.1 已记） |
| Gemini Live | 16-bit PCM 16kHz little-endian | 24kHz | Gemini Live guide [P]（§3.4c） |
| 电话（PSTN 经 SIP） | G.711 8kHz（窄带，Opus 定义里 NB = 4kHz 音频带宽 / 8kHz 采样） | 同 | RFC 6716 §2 表 [P] |

GPT-Live 原文 [P]：

> "- `{"type":"audio/pcm","rate":24000}`: mono signed 16-bit little-endian PCM at 24 kHz; the default.
> - `{"type":"audio/pcm","rate":16000}`: mono signed 16-bit little-endian PCM at 16 kHz.
> - `{"type":"audio/pcmu","rate":8000}`: G.711 μ-law at 8 kHz, one byte per sample.
> - `{"type":"audio/pcma","rate":8000}`: G.711 A-law at 8 kHz, one byte per sample."
>
> "PCM chunks must contain complete 16-bit samples, so their byte length must be even. … Chunk boundaries are otherwise arbitrary: preserve a continuous, ordered stream."
>
> "Resample audio when its sample rate differs from the configured rate. Changing the format setting does not convert your input bytes."

**前端易错点**（全部来自上面这几句一手原文，换成前端语言）：
- `ArrayBuffer` 切片时切到奇数字节 → 一个 16-bit 样本被劈成两半，后面全部错位成噪声。官方示例专门"carries a trailing byte into the next input chunk"。这是 L16 §3 "UTF-8 多字节字符被 chunk 劈开"在音频里的精确同构——**流的边界不对齐语义单位**。
- `AudioContext` 默认采样率通常是 44.1k/48k（取决于设备），**不等于** 24k；改配置不会转换字节，必须自己重采样。
- 字节数 ↔ 时长换算：PCM16 单声道 24kHz = 48,000 字节/秒 → 20ms = 960 字节；G.711 8kHz = 8,000 字节/秒 → 20ms = 160 字节。lab 的播放进度追踪用这个换算（纯算术，可断言）。

### 5.3 电话：8kHz、SIP、以及"谁拥有副作用"

OpenAI GPT-Live SIP 文档 [P]（https://developers.openai.com/api/docs/guides/voice-sip.md ）：

> "Direct SIP keeps call audio on the provider-to-OpenAI media path. SIP signaling uses TLS, and GPT-Live requires SRTP for call audio."
>
> "SIP negotiates the audio format, so omit `audio.format`."
>
> "Use a sideband connection when your backend needs to receive session events or send commands. … Assign one handler to each action so that duplicate webhook deliveries or events observed on multiple connections don't execute tools twice."
>
> "SIP carries the call audio. Use the sideband for transcripts, delegation, tools, commands, and reflected audio. Choose one owner for each side effect, even if multiple connections observe an event."

外呼 [P]："Use a trunk that supports TLS signaling, Opus audio, and SDES-SRTP media."

→ 电话场景的课程要点**不在编解码**，而在"**多连接观察同一事件 → 工具执行两次**"。这是 L19 幂等键在语音里的一个新来源：一个 SIP 通话可能同时有媒体路径、sideband WebSocket、webhook 三条通道看到同一个"调用工具"事件。

**8kHz 对 ASR 和话轮模型的影响**：我**没有找到**一手的、针对 2026 年主流 ASR 在 8kHz vs 16kHz 下的 WER 对比数据（只有厂商营销页）。列入 §11。可以讲的只有一手的事实：G.711 是窄带（4kHz 音频带宽，RFC 6716 表），而 Gemini Live 要求 16kHz 输入、OpenAI 默认 24kHz——**电话音频进这些模型要上采样，上采样不会恢复丢掉的高频**。

### 5.4 回声与自打断

把 §1.1 的论文做法和 §5.1 的 W3C 规范放在一起看：

- 论文的 "echo gate"：agent 说话期间压低/丢弃麦克风输入 [P，§1.1]。→ 能消除自打断，**但同时消除了 barge-in**。
- 浏览器 AEC：规范只保证消除 `RTCPeerConnection` 来源 [P]。
- OpenAI Realtime 的 `server_vad` 默认 `threshold` 0.5（§3.1）："A higher threshold will require louder audio to activate the model, and thus might perform better in noisy environments." [P，SDK 类型 docstring]

→ 三种方案代表三种取舍：**关耳朵**（echo gate，无自打断、无 barge-in）、**靠 AEC**（依赖传输方式和设备）、**抬阈值**（减少误触发，也让轻声说话的用户打断不了）。LiveKit 的打断默认还要求 `min_duration` 0.5s（§3.2）——**持续 500ms 的声音才算打断**，这同时过滤了回声尖峰和"嗯"。lab 的 `judgeBargeIn` 用这个参数，观察实验 E5 展示"阈值/持续时长 × 回声/嗯/真打断"的混淆矩阵。

## 6. 语音里的工具调用

### 6.1 等待期在语音里没有屏幕可用

L16 的等待期设计（§6，"把等待期变成有信息的"）依赖一块屏幕：工具卡片、diff 预览、进度。语音 agent **只有一条串行的音频通道**，而且用户在这条通道上也要说话。所以：

- 等待期能放的东西只有**声音**——填充语（preamble/filler）、或者等待音。
- 而填充语**占用的正是用户可能要插话的那条通道**，而且它本身会被计入"首音延迟"的统计（§2、§9）。

**OpenAI 对填充语的官方立场** [P]（*Realtime prompting guide* https://developers.openai.com/api/docs/guides/voice-prompting.md ，访问 2026-10-12）：

> "Preambles are short spoken updates that keep a voice agent feeling responsive while it reasons, looks something up, or calls a tool. Used well, they reassure the user that the assistant is working. Used poorly, they become filler and increase perceived latency."
>
> "`gpt-realtime-2` generates preambles by default."

何时**不要**用 [P]：

> "- the answer is direct and can be given immediately;
> - the user is only confirming, correcting, or declining something;
> - the audio is unclear and you need clarification;
> - the latest audio is silence, background noise, hold music, TV audio, or side conversation;
> - the tool call is lightweight and the user would not benefit from an update."

要避免的措辞 [P]："Let me think..." / "Hmm..." / "One moment while I process that..." / "I am now going to access the tool..."

→ **反转**：「加填充语掩盖延迟」不是免费的。官方明说用不好会 "increase perceived latency"。原因（P2 推断）：填充语是一段**必须播完**的音频（或者被打断），如果工具在填充语播到一半时就返回了，真正的答案要排在填充语后面；短工具调用加填充语，等于把一个 200ms 的等待换成一个 1.5 秒的句子。

**LiveKit 的填充调度** [P]（`voice/events.py` `with_filler`）：

> "While the context is open, a background scheduler waits for the session to be continuously idle for ``delay`` seconds, then plays ``source``. With ``interval`` set, it then sleeps that many wall-clock seconds before restarting the dwell wait. ``interval=None`` (default) fires at most once."

默认 `delay: float = 0, interval: float | None = None, max_steps: int | None = None`。调度器在 agent 进入 `speaking`/`thinking` 或用户进入 `speaking` 时重置等待（`filler_scheduler.py`）。

→ 这给了一个干净的纯函数：**输入 = 工具开始/结束时间 + 双方说话区间；输出 = 填充语在哪些时刻触发**。关键规则是"**连续**空闲满 delay 才触发"——不是"工具开始后 delay 秒触发"。两者的差别在用户正在说话、或者 agent 正在播前一句时最明显：后者会让填充语和用户的话撞车。lab TODO `myScheduleFillers`（§10.4）。

### 6.2 工具延迟预算：语音里沉默是要计费的

**GPT-Live 按会话时长计费** [P]（*Cost optimization* https://developers.openai.com/api/docs/guides/voice-latency-cost.md ）：

> "GPT-Live voice sessions are billed per second at the current model rate. Session duration is not rounded up to the next whole minute."
>
> "Active session time includes time when the user speaks, the assistant speaks, both are silent, or the backend is working."

> "Shorter waits can improve the user experience and reduce voice-session costs. For example, suppose your backend uses `gpt-5.6-luna` with Fast mode and runs independent tool calls in parallel. If these optimizations help the user finish and close the voice session one minute sooner, you save $0.05 in voice charges."

（文中 $0.05/min 被标为 "an illustrative voice rate"——**示例价，不是实价**，讲义不得当真实价格引用。）

> "A `POST /v1/live/sessions` request to create a WebRTC session bills 15 seconds of voice duration while the session initializes."

**对比 Realtime API 的 token 计费** [P]（同页 § Realtime API costs）：

> "Audio tokens in user messages are 1 token per 100 ms of audio, while audio tokens in assistant messages are 1 token per 50ms of audio."
>
> "VAD will effectively filter out empty input audio, so empty audio doesn't count as input tokens unless the client manually adds it as conversation input."

→ **反转**（接 L15）：L15 的结论是"延迟和成本是两条独立的轴，fast mode 用钱换速度"。在按时长计费的语音前台上，**两条轴耦合了**：工具多慢一秒，语音前台就多收一秒钱。官方自己举的例子就是"用更贵的 fast mode 后台换更短的会话，总价可能更低"。这是 L15 里没有出现过的成本结构。而 Realtime API（按 token）下沉默不计费——**同一家厂商的两个语音产品，延迟对账单的影响方向不同**。

**投机工具调用的成本要算进去** [P]：

> "You can also start a speculative lookup from transcript fragments before a delegation event arrives. Include unused speculative work in your backend cost measurements."

### 6.3 说到一半的答案与工具结果冲突

这是语音工具调用最承重的一条，而 OpenAI 的 GPT-Live 文档把它写成了一组明确规则 [P]（*Delegation and tools*）：

**口头更新必须匹配已验证的状态**：

> "For spoken updates, send `session.commentary.append` with content that matches the task's verified state:"

| State | Example content |
|---|---|
| Still working | "I'm checking the available appointments." |
| Completed | "You're booked for Thursday at 2:00 PM." |
| Failed | "That time is no longer available." |
| Cancellation confirmed | "Your appointment has been canceled." |

**用户改了需求，旧结果作废**：

> "When the user changes a request, update the active task in your application. For example, if they change Friday to Thursday, use Thursday for subsequent work and ignore results from the outdated Friday request. Manage any cancellation in the backend, and confirm it succeeded before telling the user that the work was canceled."

**重试前先查是否已经发生**（接 L19 幂等）：

> "Before retrying a failed tool call, check whether the original action already happened. For example, a lost response should not cause a second booking. If the outcome is unclear, say so and offer the next useful step."

**两个结果要分别验证**：

> "Verify that the backend completed the intended action and that the client played the expected spoken result. … The backend can finish while the spoken answer is interrupted, so test these outcomes separately."

**确认送达 ≠ 已经说出来**：

> "The acknowledgment waits for estimated context injection, not for speech or playback to finish."

**转写片段可能被后面的话推翻**：

> "Process accumulated text when meaningful new information arrives. A fragment may be incomplete, and later speech can change the request. Discard outdated results, coordinate with subsequent delegated work to avoid duplicate actions, and apply your usual permission and confirmation checks before consequential actions."

→ **教学结论**：这一组规则可以压成一个数据结构——**任务表里每个任务带一个 `epoch`（用户每次改需求就 +1），工具结果回来时如果 epoch 已过期就丢弃；口头确认只能从"已验证状态"生成，不能从"已发起请求"生成**。这和 §4 的"历史截断到用户听到的位置"是一对：一个管"agent 说过什么"必须是真的听到了，一个管"agent 说做成了什么"必须是真的做成了。lab 的 `TaskBoard` 是这个。

### 6.4 用户在工具运行时说话：静音、排队还是打断

三家给了三种不同的默认：

- **Pipecat** 提供 `FunctionCallUserMuteStrategy` [P]（`turns/user_mute/function_call_user_mute_strategy.py`）："User mute strategy that mutes the user while a function call is executing. This strategy ensures that user input does not interfere with ongoing function execution. While a function call is active, all user frames are muted."——这是**可选策略**，不是默认。
- **Gemini 3.8 Live** 默认 `NON_BLOCKING`，并让你在工具结果上声明 `INTERRUPT / WHEN_IDLE / SILENT`（§3.4c）——**结果到达时机**由你决定。
- **OpenAI GPT-Live**：后台和对话并行，用户可以在后台跑的时候继续说（"Users can keep talking while backend work runs."），打断不取消后台。

→ "用户在工具执行期间说话怎么办"**没有一个正确默认**，取决于工具是否有副作用。Pipecat 的静音策略在"正在扣款"时是对的（不让用户的"嗯"打断确认流程），在"正在查天气"时是错的（用户说"不对，是上海"应该立刻生效）。lab 里用一个 `sideEffect: boolean` 字段把这个决定显式化。

**Realtime 提示词里的副作用确认表** [P]（*Realtime prompting guide*）：

> "| Account changes | Confirm before calling. |
> | Purchases, cancellations, payments | Confirm amount, target, and consequence before calling. |"

## 7. TTS 分句（含本地实测）

### 7.1 为什么要分句：TTS 要上下文，首音要快——两者直接冲突

ElevenLabs WebSocket TTS 官方文档 [P]（https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input.mdx ，访问 2026-10-12；同文也出现在官方 SDK 类型 `GenerationConfig.d.ts`）：

> "All text sent to the WebSocket endpoint is added to this buffer and only when that buffer reaches a certain size is an audio generation attempted. This is because our model provides higher quality audio when the model has longer inputs, and can deduce more context about how the text should be delivered."
>
> "The default value for `chunk_length_schedule` is: [120, 160, 250, 290]. This means that the first chunk of audio will not be generated until you send text that totals at least 120 characters long."
>
> "Each item should be in the range 50-500."

`auto_mode` [P]（官方 SDK `StreamInputQueryParameters.d.ts`）：

> "This parameter focuses on reducing the latency by disabling the chunk schedule and all buffers. It is only recommended when sending full sentences or phrases, sending partial phrases will result in highly reduced quality. By default it's set to false."

LiveKit 的 ElevenLabs 插件 [P]（`livekit-plugins-elevenlabs/.../tts.py`）：

> "auto_mode (bool): Reduces latency by disabling chunk schedule and buffers. Sentence tokenizer will be used to synthesize one sentence at a time. Defaults to True unless ``chunk_length_schedule`` is provided."

→ **两个读法**：
1. TTS 厂商自己的默认值是**偏质量**的（首块至少 120 字符）；框架把它关掉，改成"**客户端分句、一句一送**"。所以**分句器的质量直接决定首音延迟和韵律**——它不是一个可以随便写的工具函数。
2. 厂商的阈值单位是"**字符**"。120 个英文字符 ≈ 20 个词 ≈ 1–2 句；120 个汉字是一大段话。ElevenLabs 文档**没有说明** CJK 字符如何计数（我没找到一手说明），所以"中文下 120 字符阈值意味着什么"只能做推断，不能当事实讲。但这暴露了一个普遍问题：**以字符计的阈值跨语言不等价**——下面 LiveKit 的 `min_sentence_len=20` 实测就是一个一手可复现的例子。

### 7.2 三个框架/论文的分句规则（一手）

| 来源 | 句末集合 | 最小长度 | 前瞻 | 中文行为 |
|---|---|---|---|---|
| arXiv 2603.05413 §（sentence buffer） | `.` `!` `?` **后跟空白** | 10 字符 | 等一个空白 | **永远不触发**（中文句号后无空格） |
| LiveKit `split_sentences` | `[.!?。！？]` | `len(buff) > 20` 字符 | 流式时 `stream_context_len` 10 | 句号能切，但 20 字符阈值把短句合并，**并在句间插入 ASCII 空格** |
| Pipecat `SimpleTextAggregator` + `match_endofsentence` | Latin 集合交给 sentencex；`。？！；．｡` 等"无歧义"标点直接切 | 无 | **等句末后第一个非空白字符**才判定 | 句号能切；`，` 不在集合里 |

论文原文 [P]（§1.1 已引）："1. Detect sentence-ending punctuation (., !, ?) followed by whitespace. 2. Exclude false positives from abbreviations (Dr., Mr., PM.) and decimal numbers. 3. Enforce a minimum sentence length (10 characters) to avoid sending fragments to TTS. 4. Flush any remaining text when the LLM stream ends."

Pipecat 前瞻的设计说明 [P]（`utils/text/simple_text_aggregator.py`）：

> "Clear boundaries can emit at the first character; unresolved ones wait for a complete word. For example, "Hello. N" can emit without waiting for "Next ". Waiting for word completion added up to 297 ms in our Anthropic sample."
>
> "``Hello.`` or ``Hello. ``: keep buffering until meaningful text follows. ``Hello. N``: check immediately and emit ``Hello.``. In contrast, ``Dr. N`` and ``$29.9`` stay buffered as an abbreviation and a decimal."

（"297 ms" 是 Pipecat 在自己一个样本上的观察，属厂商自报的单点数字，不能当普遍值。）

→ Pipecat 这段注释是全报告里**对"分句为什么必须有前瞻"最好的一手解释**：看到 `.` 的那一刻你不知道它是句号、小数点（`$29.9`）还是缩写（`Dr.`）——**必须等下一个字符**。这和 L16 的"chunk 边界不对齐语义单位"是同一个问题，只是这次的语义单位是"句子"。

### 7.3 本地实测：同一组中英文样本，三种分句器的首段时间与误切

**实验设定**（全部合成、确定性）：
- token 流：中文每个汉字/全角标点 1 个 token，ASCII 连续串（含前导空格）1 个 token；第 i 个 token 在虚拟时刻 `300 + 30·i` ms 到达（300ms 当作 LLM 首 token，30ms/token；**这是合成参数，不是测量值**）。
- `first_ms` = 第一段被交给 TTS 的虚拟时刻；`first_units` = 第一段的"语音单位"（1 个汉字 = 1，1 个 ASCII 字母数字串 = 1）；`bad` = 误切次数（切在 `3.5`/`1.2.3`/`example.com` 内部，或切在 `Dr.`/`p.m.` 之后）。
- 三个分句器：`naive`（见到 `.!?。！？` 立刻切——前端工程师的第一版）、`paper`（论文四条规则的忠实实现）、`proposed`（本报告给 lab 的提案，见下）。

脚本：`/tmp/voice-research/split/split.ts` 与 `split.py`（同逻辑两种语言）。

`proposed` 分句器的核心（TS，节选自 `split.ts`）：

```typescript
const HARD_CJK = "。！？；";
const HARD_ASCII = "!?;";
const CLOSERS = "”’」』）)\"";
const SOFT = "，,、：:";
const ABBR = ["Dr", "Mr", "Mrs", "Ms", "Prof", "St", "vs", "e.g", "i.e", "p.m", "a.m", "etc"];
const FIRST_MIN = 4;
const LATER_MIN = 8;

function splitProposed(toks: Tok[]): Seg[] {
  const segs: Seg[] = [];
  let buf: string[] = [];
  let pendingDot = false; // saw "." and waiting for 1 char lookahead
  let pendingCloser = false; // saw a hard CJK ender; absorb closers before cutting
  const cutAt = (k: number, t: number) => {
    const text = buf.slice(0, k).join("").trim();
    buf = buf.slice(k);
    while (buf.length && buf[0] === " ") buf.shift();
    if (text) segs.push({ t, text });
  };
  const minFor = () => (segs.length === 0 ? FIRST_MIN : LATER_MIN);
  const enough = (k: number) => units(buf.slice(0, k).join("")) >= minFor();
  for (const tk of toks) {
    for (const c of Array.from(tk.s)) {
      if (pendingCloser) {
        if (CLOSERS.includes(c)) { buf.push(c); continue; }
        pendingCloser = false;
        if (enough(buf.length)) cutAt(buf.length, tk.t);
      }
      if (pendingDot) {
        pendingDot = false;
        const k = buf.length; // buf ends with "."
        const before = buf.slice(0, k - 1).join("");
        const m = before.match(/([A-Za-z.]+)$/);
        const prevWord = m ? m[1] : "";
        const isAbbr = ABBR.includes(prevWord) || /^[A-Za-z]$/.test(prevWord);
        if ((c === " " || isCJK(c)) && !isAbbr && enough(k)) cutAt(k, tk.t);
      }
      buf.push(c);
      if (HARD_CJK.includes(c) || HARD_ASCII.includes(c)) { pendingCloser = true; continue; }
      if (c === ".") { pendingDot = true; continue; }
      if (segs.length === 0 && SOFT.includes(c) && enough(buf.length)) cutAt(buf.length, tk.t);
    }
  }
  const last = toks[toks.length - 1].t + DT;
  if (buf.join("").trim()) segs.push({ t: last, text: buf.join("").trim() });
  return segs;
}
```

设计要点：(1) 中文句末标点**无歧义**，但要多等 1 个字符以吸收后引号 `”」`；(2) `.` 必须前瞻 1 个字符：下一个是空格或汉字、且前一个词不是缩写，才切；(3) **第一段**允许在逗号处切（只要够 4 个语音单位），后续段至少 8 个单位——首段为延迟服务，后续段为韵律服务（和 ElevenLabs 递增的 `chunk_length_schedule` 同一个思路）；(4) 长度阈值按"语音单位"而不是字符计。

**运行**：

```bash
cd /tmp/voice-research/split
node --experimental-strip-types split.ts 2>/dev/null > out_ts.txt   # Node v22.19.0
python3 split.py > out_py.txt                                         # Python 3.13.13
diff out_ts.txt out_py.txt
```

**输出**（TS 与 Python 第 1–51 行逐字节相同；第 52–54 行是故意放进去的跨语言探针，见 §7.4）：

```text
splitter sample        first_ms first_units segs bad
naive    zh-basic      570      8           3    0
naive    zh-decimal    480      7           5    3
naive    zh-longcomma  1920     52          1    0
naive    zh-mixed      390      4           4    2
naive    zh-quote      510      5           2    0
naive    en-basic      420      5           5    2
naive    en-tricky     390      4           8    5
naive    en-short      300      1           1    0
paper    zh-basic      1410     32          1    0
paper    zh-decimal    1020     24          1    0
paper    zh-longcomma  1950     52          1    0
paper    zh-mixed      840      15          1    0
paper    zh-quote      750      10          1    0
paper    en-basic      450      5           4    1
paper    en-tricky     480      7           3    0
paper    en-short      330      1           1    0
proposed zh-basic      600      8           3    0
proposed zh-decimal    540      9           3    0
proposed zh-longcomma  540      8           2    0
proposed zh-mixed      510      7           2    0
proposed zh-quote      570      5           2    0
proposed en-basic      450      5           2    0
proposed en-tricky     480      7           3    0
proposed en-short      330      1           1    0

naive/zh-basic: 570|好的，我帮您查一下。 ‖ 1140|您的订单已经发货了，预计明天下午送到。 ‖ 1380|还有其他问题吗？
naive/zh-decimal: 480|这款套餐每月39. ‖ 720|9元，比原来便宜3. ‖ 780|5元。 ‖ 930|详情见第2. ‖ 990|1节。
naive/zh-longcomma: 1920|根据您提供的信息，我查到您在上周三下单的那台笔记本电脑目前正在从上海仓库发出，物流单号已经同步到您的手机上了。
naive/zh-mixed: 390|请访问 example. ‖ 660|com 查看，或者联系 Dr. ‖ 720|Wang。 ‖ 810|谢谢！
naive/zh-quote: 510|他说：“明天见。 ‖ 720|”然后就走了。
naive/en-basic: 420|Sure, let me check that. ‖ 540|Your order shipped yesterday. ‖ 720|It should arrive by 3 p. ‖ 720|m. ‖ 750|tomorrow.
naive/en-tricky: 390|The plan costs $39. ‖ 450|99 per month. ‖ 480|Dr. ‖ 600|Smith recommended version 1. ‖ 600|2. ‖ 660|3 for you. ‖ 720|Visit example. ‖ 780|com for details.
naive/en-short: 300|Yes.
paper/zh-basic: 1410|好的，我帮您查一下。您的订单已经发货了，预计明天下午送到。还有其他问题吗？
paper/zh-decimal: 1020|这款套餐每月39.9元，比原来便宜3.5元。详情见第2.1节。
paper/zh-longcomma: 1950|根据您提供的信息，我查到您在上周三下单的那台笔记本电脑目前正在从上海仓库发出，物流单号已经同步到您的手机上了。
paper/zh-mixed: 840|请访问 example.com 查看，或者联系 Dr. Wang。谢谢！
paper/zh-quote: 750|他说：“明天见。”然后就走了。
paper/en-basic: 450|Sure, let me check that. ‖ 570|Your order shipped yesterday. ‖ 750|It should arrive by 3 p.m. ‖ 780|tomorrow.
paper/en-tricky: 480|The plan costs $39.99 per month. ‖ 690|Dr. Smith recommended version 1.2.3 for you. ‖ 810|Visit example.com for details.
paper/en-short: 330|Yes.
proposed/zh-basic: 600|好的，我帮您查一下。 ‖ 1170|您的订单已经发货了，预计明天下午送到。 ‖ 1410|还有其他问题吗？
proposed/zh-decimal: 540|这款套餐每月39.9元， ‖ 810|比原来便宜3.5元。 ‖ 1020|详情见第2.1节。
proposed/zh-longcomma: 540|根据您提供的信息， ‖ 1950|我查到您在上周三下单的那台笔记本电脑目前正在从上海仓库发出，物流单号已经同步到您的手机上了。
proposed/zh-mixed: 510|请访问 example.com 查看， ‖ 840|或者联系 Dr. Wang。谢谢！
proposed/zh-quote: 570|他说：“明天见。” ‖ 750|然后就走了。
proposed/en-basic: 450|Sure, let me check that. ‖ 780|Your order shipped yesterday. It should arrive by 3 p.m. tomorrow.
proposed/en-tricky: 480|The plan costs $39.99 per month. ‖ 690|Dr. Smith recommended version 1.2.3 for you. ‖ 810|Visit example.com for details.
proposed/en-short: 330|Yes.

probe .length=3 codepoints=2
probe \w matches 好: false
probe \d matches ３ (fullwidth): false
```

Python 版最后三行（`diff` 只报告这三行不同）：

```text
probe .length=2 codepoints=2
probe \w matches 好: true
probe \d matches ３ (fullwidth): true
```

**同样的样本跑 LiveKit 真实代码**（`/tmp/voice-research/split/lk_real.py`，直接 `importlib` 加载 commit cfa9d85 的 `tokenize/_basic_sent.py`，非流式，默认 `min_sentence_len=20`）：

```text
zh-basic (min_sentence_len=20): '好的，我帮您查一下。 您的订单已经发货了，预计明天下午送到。' ‖ '还有其他问题吗？'
zh-decimal (min_sentence_len=20): '这款套餐每月39.9元，比原来便宜3.5元。' ‖ '详情见第2.1节。'
zh-longcomma (min_sentence_len=20): '根据您提供的信息，我查到您在上周三下单的那台笔记本电脑目前正在从上海仓库发出，物流单号已经同步到您的手机上了。'
zh-mixed (min_sentence_len=20): '请访问 example.com 查看，或者联系 Dr. Wang。' ‖ '谢谢！'
zh-quote (min_sentence_len=20): '他说：“明天见。” 然后就走了。'
en-basic (min_sentence_len=20): 'Sure, let me check that.' ‖ 'Your order shipped yesterday.' ‖ 'It should arrive by 3 p.m. tomorrow.'
en-tricky (min_sentence_len=20): 'The plan costs $39.99 per month.' ‖ 'Dr. Smith recommended version 1.2.3 for you.' ‖ 'Visit example.com for details.'
```

### 7.4 读结果：六个反直觉点

1. **论文的规则在中文上完全失效**：`paper/zh-*` 全部只有 1 段，首段时间 = 整个回答生成完（zh-basic 1410ms，naive 是 570ms）。原因是规则 1 要求"标点后跟空白"，中文句号后面没有空格。一个在英文上测出"sub-1-second"的级联，换成中文后**分句这一步退化成"等 LLM 全部说完"**，TTFA 直接加上整段生成时间。这不是论文的错误（它只测英文），但它是"从英文 demo 搬到中文产品"时最容易漏掉的一点。
2. **`naive` 首段最快但误切严重**：英文 tricky 样本 8 段里 5 处误切（`$39.`/`Dr.`/`1.`/`2.`/`example.`），中文小数样本 3 处。TTS 会把 `39.` 读成"三十九。"然后停顿，再读"九元"。还有一个更隐蔽的：`naive/zh-quote` 第二段以 `”` 开头——后引号被甩给了下一段。
3. **LiveKit 的英文规则非常扎实**（`p.m.`、`Dr.`、`$39.99`、`1.2.3`、`example.com` 全对），但**中文首段被 20 字符阈值合并成了 29 字符**（`好的，我帮您查一下。 您的订单已经发货了，预计明天下午送到。`），而英文首段只有 24 字符 / 5 个词。按 LiveKit 自己用于转写同步的语速常数（`voice/transcription/synchronizer.py`：`STANDARD_SPEECH_RATE = 3.83  # hyphens (syllables) per second`；中文 1 字 ≈ 1 音节），中文首段约 27 个音节 ≈ 7 秒语音，英文首段约 6 个音节 ≈ 1.6 秒。**同一个 `min_sentence_len=20`，中文要多等约 4 倍的 LLM 输出才能开始说话。**
4. **LiveKit 会在中文句间插入 ASCII 空格**（`查一下。 您的`、`明天见。” 然后`）。原因是 `pre_pad = " "` 拼接——对英文是正确的，对中文是在改写模型输出。大多数 TTS 对此不敏感（我没有一手证据说明某个中文 TTS 会因此出错），但它说明**分句器默认假设"句子之间有空格"**，这条假设贯穿了论文规则和 LiveKit。
5. **长逗号句是中文的特有问题**：`zh-longcomma` 52 个字只有一个句号。`naive`/`paper`/LiveKit 都要等到 1920–1950ms 才出第一段；`proposed` 允许**第一段**在逗号处切，540ms 出首段（"根据您提供的信息，"）。代价是第一段韵律更碎——但只有第一段这样，后续段要求 ≥8 单位。这是"首段为延迟、后续为韵律"的非对称策略。Pipecat 的 `SENTENCE_ENDING_PUNCTUATION` 不含 `，`，所以它在这个样本上也会等到句号（推断自源码，未实测运行 Pipecat，因为它依赖 sentencex 库）。
6. **前瞻有固定成本**：`proposed/zh-basic` 首段 600ms，比 `naive` 慢 30ms（一个 token）——这就是"吸收后引号"所要求的那 1 个字符前瞻。Pipecat 的注释说"等词完整"在他们的样本上最多花了 297ms；本实验里前瞻只等 1 个字符，所以只花 1 个 token。**前瞻窗口越大越准，越大越慢**——这是可以在 lab 里直接测出来的取舍。

**跨语言探针（lab 必须避开的三个坑）**：

| 探针 | TS | Python | lab 规定 |
|---|---|---|---|
| `"好😀".length` / `len()` | 3（UTF-16 码元） | 2（码点） | 一律 `Array.from(s).length` / `len(s)`；样本限 BMP |
| `\w` 匹配 `好` | false | true | 禁用 `\w`，写显式字符类 |
| `\d` 匹配全角 `３` | false | true | 禁用 `\d`，写 `[0-9]`（和 L16 同一个坑） |

这三个探针**故意**让两种语言输出不同，以证明"把 TS 的正则原样搬到 Python"不能保证字节一致。lab 的中文分句正则必须只用显式 Unicode 范围（`[\u4e00-\u9fff]` 等）和 ASCII 类。

### 7.5 中文特有的文本归一化问题（只列有一手来源的）

- **数字读法**：`39.9元` 应读"三十九点九元"，`第2.1节` 读"第二点一节"，`2026年` 读"二零二六年"而不是"两千零二十六年"。ElevenLabs 有 `apply_text_normalization`（`auto`/`on`/`off`）参数 [P，LiveKit 插件 docstring 转述："When set to 'auto', the system will automatically decide whether to apply text normalization (e.g., spelling out numbers)"]。中文数字读法的规则细节我**没有找到** 2026 年主流 TTS 厂商的一手规范文档，列入 §11。
- **分句器不应做归一化**：分句只决定"在哪切"，不改字符。LiveKit 插空格是反例。lab 的不变量："所有段拼接（去掉切点处的空白）== 原文"。

## 8. 框架：LiveKit Agents / Pipecat

细节和原文引用都在 §3、§4、§6、§7。这里只做一张"设计取向"对照，帮学员在课上快速定位（源码版本：LiveKit commit cfa9d85，Pipecat commit 19fca83，均 2026-10-11/12 拉取）。

| 维度 | LiveKit Agents | Pipecat | 讲义可用的一句话 |
|---|---|---|---|
| 话轮判定主干 | 静音计时 `min_delay` 0.5s，语义模型低概率时**延长**到 `max_delay` 3.0s | VAD 快停 0.2s + Smart Turn 模型（`probability > 0.5`）+ `STOP_SECS` 3s 兜底 | LiveKit"默认快、怀疑时等"；Pipecat"模型说了算、超时兜底" |
| 投机生成 | `preemptive_generation` **默认开**，TTS 投机默认关；有效性 = 转写+上下文+工具+tool_choice 四元组 | Eager 策略 + `SpeculationGate`；三种撤回；"committed transcript, never the eager one" 写入上下文 | 两家都默认"先算再说"，区别在怎么判定投机作废 |
| 打断判定 | `min_duration` 0.5s、`min_words` 0；`resume_false_interruption` 开，2.0s 无转写则恢复 | 可选 `FunctionCallUserMuteStrategy` 等静音策略 | LiveKit 允许"误打断后接着说" |
| 历史截断 | 按音节速率 3.83/s 估算已播文本；一帧没播则整条丢弃 | （未在本次调研中深读，不下结论） | 估算，不是精确对齐 |
| 分句 | 规则正则，`min_sentence_len=20`（字符） | sentencex + 无歧义标点集合 + 前瞻状态机 | 都按字符计，中文吃亏（§7 实测） |
| 填充语 | `with_filler(delay, interval, max_steps)`，连续空闲才触发 | （未深读） | "连续空闲"是关键 |

**两个框架共同的、值得讲的设计原则**（从源码归纳，P2）：
1. **话轮判定和打断判定是两个独立的状态机**，参数分开（LiveKit 的 `_ENDPOINTING_DEFAULTS` 和 `_INTERRUPTION_DEFAULTS` 是两个字典）。学员常把它们写成一个"用户在不在说话"的布尔值。
2. **投机是默认，不是优化选项**：两家都默认开启某种投机生成。这意味着"被丢弃的生成"是常态，计量和计费都要算进去（OpenAI："Include unused speculative work in your backend cost measurements."）。

## 9. 评测

### 9.1 官方给的评测维度

OpenAI *Voice agents* § Evaluate and improve [P]：

> "Use task and latency targets to compare task completion, audible response latency, interruptions, and unwanted silence. For latency targets, compare the median and 95th percentile."
>
> "Measure acknowledgments such as "I'm checking" separately from the answer the caller needs."

GPT-Live 委派 [P]："The backend can finish while the spoken answer is interrupted, so test these outcomes separately."

### 9.2 本课建议的指标（定义必须写死起止点）

| 指标 | 定义（起点 → 终点） | 为什么要单列 | 关联 INV |
|---|---|---|---|
| 死寂 p50/p95（dead air） | 用户**真实**说完（合成数据的标注）→ 第一个**可听见**的 agent 样本 | 用户真正感受到的等待 | INV 首音定义 |
| 有用答案延迟 | 同上起点 → 第一个**非填充语**样本 | 防止用"我查一下"刷数字 | INV 填充语 |
| 误切率（false cut-off） | 话轮提交后 N ms 内用户继续说话的轮次 / 总轮次 | 静音阈值越短越高 | INV 轮内停顿 |
| 打断响应时间 | 用户开口（标注）→ agent 播放停止（最后一个播出样本） | 包含 `min_duration`、清缓冲、网络 | INV 打断滞回 |
| 误打断率 | agent 因回声/嗯嗯/噪声停下的次数 / agent 发言次数 | 打断阈值越低越高 | INV 回声、backchannel |
| 历史保真度 | 历史里的 assistant 文本 vs 实际播放到的文本 | 截断写错了，agent 会"记得"用户没听到的话 | INV 截断 |
| 投机浪费率 | 被撤回的 LLM 调用 / 总 LLM 调用 | Flux 自报 "50-70% more LLM calls"（厂商自报） | INV 投机 |
| 任务-话语一致性 | 口头说"已完成"的任务中，后台实际完成的比例 | GPT-Live verified-state 规则 | INV 后台继续 |

### 9.3 三个方法学陷阱（均有一手依据）

1. **"静音多长"依赖 VAD 阈值**：Levinson & Torreira 转述 Brady 1968，间隙均值 "345–456 ms … (depending on the threshold used in the automatic detection of speech)" [P2]。→ 两个不同 VAD 下测出的死寂时长**不可比**。lab 的评测在同一个 VAD 参数下比较。
2. **离线评测必须按实时节奏喂音频**：OpenAI："supply a continuous microphone stream paced at its recorded sample rate. Piping an entire file at once does not simulate a live microphone." [P]。话轮检测、打断都是**时间驱动**的；一次性灌入的评测测不出它们。→ lab 用虚拟时钟逐帧推进，这是同一件事的确定性版本。
3. **阈值对比要固定一端**：LiveKit 多语种模型的 `languages.json` 把每种语言的阈值校准到几乎相同的 TPR（≈0.993，§3.4b）[P]。→ 比较两个话轮策略时，先把"误切率"固定到同一水平，再比死寂时长；否则"更快"可能只是"切得更多"。

## 10. Lab 提案

### 10.1 原则

- 沿用 `labs/shared/wire.ts` 的风格：纯函数 + 小 reducer、`★` 注释写"看起来对但不对"、`VOICE_IMPL=shared pnpm verify:l16y` 先验证测试本身、学员 TODO 用 `My*`/`my_*` 前缀。
- **时间全部是注入的整数毫秒**；输入是合成的：20ms 一帧的 VAD 概率、带时间戳的 STT 事件、LLM token 流、TTS 块（文本 + 时长）、播放进度。没有真实音频、不调模型、不加依赖。
- 跨语言字节一致的硬规定（§7.4 实测）：禁用 `\w` `\d`；长度一律按码点（TS `Array.from(s).length`）；观察实验样本限 BMP，verify 专设一条非 BMP 断言（F10）抓 UTF-16 截断；百分位用整数公式 `rank = (q·n + 99) // 100`；整数除法用 `Math.floor(a*b/c)` / `a*b//c`（非负整数）；表格用固定宽度 `pad`，不用 `toFixed`/`f"{:.2f}"` 以外的浮点格式化（需要小数时统一 `toFixed(1)` 对 `f"{x:.1f}"`，并避免 .x5 边界值）。

### 10.2 `labs/shared/voice.ts` API 草图（Python 版 `voice.py` 同名 snake_case）

```typescript
export type Ms = number                      // integer virtual ms
export const FRAME_MS = 20

// ---------- A. VAD 四态滞回（Pipecat VADParams 默认：confidence 0.7, start 0.2s, stop 0.2s）
export type VadState = 'quiet' | 'starting' | 'speaking' | 'stopping'
export interface VadParams { threshold: number; startMs: Ms; stopMs: Ms }
export const VAD_DEFAULTS: VadParams = { threshold: 0.7, startMs: 200, stopMs: 200 }
export interface VadMachine { state: VadState; since: Ms; lastSpeechAt: Ms | null }
export type VadEvent = { kind: 'speech_start' | 'speech_end'; t: Ms; lastSpeechAt: Ms }
export function vadStep(m: VadMachine, frame: { t: Ms; p: number }, p: VadParams): [VadMachine, VadEvent | null]
export function runVad(frames: { t: Ms; p: number }[], p: VadParams): VadEvent[]

// ---------- B. 端点（LiveKit：min 500 / max 3000，EOU 概率低于语种阈值才用 max）
export interface EndpointParams { minDelayMs: Ms; maxDelayMs: Ms; unlikelyThreshold: number }
export const ENDPOINT_ZH: EndpointParams = { minDelayMs: 500, maxDelayMs: 3000, unlikelyThreshold: 0.0066 }
export const ENDPOINT_EN: EndpointParams = { minDelayMs: 500, maxDelayMs: 3000, unlikelyThreshold: 0.011 }
export function endpointDelay(eouProb: number, p: EndpointParams): Ms
// commitAt = max(lastSpeechAt + delay, firstFinalAt)；若在 commitAt 之前出现新的 speech_start → null（不提交）
export function commitTurn(lastSpeechAt: Ms, eouProb: number, sttFinalAt: Ms | null,
                           nextSpeechStart: Ms | null, p: EndpointParams): Ms | null

// ---------- C. 投机有效性（LiveKit 四元组）
export interface SpecKey { transcript: string; ctxVersion: number; toolsVersion: number; toolChoice: string }
export function normalizeTranscript(s: string): string     // casefold + 去 ASCII/CJK 标点 + 压空白
export function speculationValid(spec: SpecKey, committed: SpecKey): boolean

// ---------- D. 播放账本 + 截断 + epoch（OpenAI truncate 语义）
export interface TtsChunk { epoch: number; itemId: string; text: string; ms: Ms }
export interface Truncation { itemId: string; audioEndMs: Ms; heardText: string; dropItem: boolean }
export class PlaybackLedger {
  epoch: number
  enqueue(c: TtsChunk, t: Ms): 'queued' | 'stale'           // c.epoch < epoch → stale，丢弃
  playedMsAt(t: Ms): Ms                                      // 单通道串行播放，按 enqueue 顺序
  bargeIn(t: Ms): Truncation | null                          // epoch++，清队列，返回截断信息
}
export function heardText(chunks: TtsChunk[], playedMs: Ms): string   // 整块 + 当前块按码点比例 floor

// ---------- E. 打断判定（LiveKit：min_duration 0.5s；false_interruption_timeout 2.0s）
export interface BargeInParams { minDurationMs: Ms; falseInterruptionTimeoutMs: Ms }
export const BARGE_IN_DEFAULTS: BargeInParams = { minDurationMs: 500, falseInterruptionTimeoutMs: 2000 }
export type BargeInVerdict = 'ignore' | 'interrupt' | 'resume'
export function judgeBargeIn(userSpeech: { start: Ms; end: Ms }, agentSpeaking: boolean,
                             firstTranscriptAt: Ms | null, p: BargeInParams): BargeInVerdict

// ---------- F. 中英文流式分句（§7 proposed）
export interface Seg { t: Ms; text: string }
export function speechUnits(s: string): number
export function splitStream(tokens: { t: Ms; text: string }[], endAt: Ms): Seg[]

// ---------- G. 填充语调度（LiveKit with_filler：连续空闲 delay 才触发）
export interface FillerParams { delayMs: Ms; intervalMs: Ms | null; maxSteps: number | null }
export function scheduleFillers(toolStart: Ms, toolEnd: Ms, busy: { start: Ms; end: Ms }[],
                                fillerMs: Ms, p: FillerParams): Ms[]

// ---------- H. 任务板（GPT-Live verified-state）
export type TaskState = 'working' | 'completed' | 'failed' | 'cancel_confirmed'
export class TaskBoard {
  start(id: string): number                    // 返回 epoch
  amend(id: string): number                    // 用户改需求，epoch++
  result(id: string, epoch: number, ok: boolean): 'accepted' | 'stale'
  utterable(id: string): TaskState             // 口头更新只能从这里取
}

// ---------- I. 延迟账
export interface TurnTimeline { userEndTrue: Ms; vadLastSpeech: Ms; commitAt: Ms; llmRequestAt: Ms;
  firstSegAt: Ms; ttsFirstChunkAt: Ms; serverFirstFrameAt: Ms; firstAudibleAt: Ms; firstUsefulAt: Ms }
export function ledger(t: TurnTimeline): { paperTtfa: Ms; livekitE2e: Ms; deadAir: Ms; usefulLatency: Ms; endpointWait: Ms }
export function percentile(xs: Ms[], q: number): Ms          // nearest-rank：ceil(q/100·n) 位
```

### 10.3 观察实验（先跑参考实现，打印表；TS/Python 逐字节一致）

| # | 实验 | 打印什么 | 揭示 |
|---|---|---|---|
| E1 | 静音阈值扫描 | 12 个合成用户话轮（含轮内停顿与真实结束标注）× 阈值 200/300/500/700/1000ms → 误切次数、平均死寂 | 没有一个阈值同时做到"不切人"和"不慢"（INV-2） |
| E2 | 语义模型只延长 | 同一语料，纯静音 500ms vs LiveKit min/max 规则（给每个停顿一个 EOU 概率）→ 误切、死寂分布、最小等待 | 误切下降，但死寂最小值仍是 500ms、低概率轮次变 3000ms（INV-12） |
| E3 | 首音延迟四种算法 | 一个话轮时间线 → `paperTtfa / livekitE2e / deadAir / usefulLatency`；再用 9 个话轮演示 Σp50 ≠ p50(Σ) | 同一系统四个数字（INV-5/6/7） |
| E4 | 生成 ≠ 发送 ≠ 播放 | TTS 以 3 倍实时产出 3000ms 音频，用户在播放 1200ms 时打断 → 三种历史策略（全留 / 留已发送 / 截到已播放）的 assistant 文本 | 只有第三种不含用户没听到的话（INV-19/20） |
| E5 | 打断判定混淆矩阵 | 回声尖峰 120ms、"嗯" 300ms、咳嗽 80ms、真打断 900ms、"嗯"但 2s 内无转写 × `minDurationMs` 0/200/500 | 0 阈值把所有东西当打断；500ms + resume 才分得开（INV-18/23） |
| E6 | 中英文分句 | §7.3 那张表（naive / paper / proposed） | INV-31/32 |
| E7 | 填充语时机 | 工具 1800ms 且用户在中途说话 / 工具 300ms → "开始后 N ms"与"连续空闲"两种调度的触发时刻、是否与用户重叠、有用答案被推迟多少 | INV-26/27 |
| E8 | 过期结果 | 用户把"周五"改成"周四"，周五的结果后到 → 任务板接受/丢弃、可说出口的状态 | INV-29/30 |

### 10.4 学员 TODO（6 个）

| TODO | 难度 | 内容 | 对应 INV | 典型"看起来对"的错法 |
|---|---|---|---|---|
| `myVadStep` | ★ | 四态滞回：`starting` 需连续 ≥startMs 高于阈值才进 `speaking`，`stopping` 需连续 ≥stopMs 低于阈值才回 `quiet`；`lastSpeechAt` 记最后一个高于阈值的帧 | 2、18 | 单帧过阈值就切状态；`speech_end` 时间戳用判定时刻而不是最后语音帧 |
| `myCommitTurn` | ★★ | 端点：按 EOU 概率选 min/max；等 final 转写；提交前用户复说则取消 | 2、12 | 用 `eouProb` 缩短延迟到 min 以下；不等 final 就提交；忘了"复说取消" |
| `mySpeculationValid` | ★ | 四元组 + 中英文标点归一化 | 15、16 | 只比转写；用 `\w` 去标点（TS 下把汉字也删了） |
| `MyPlaybackLedger.bargeIn` | ★★ | 截断到**已播放**、`audioEndMs ≤ 已入队总时长`、epoch++ 后迟到块判 stale、一帧没播 `dropItem` | 19、20、22 | 截到已生成/已发送；忘了 epoch，打断后迟到的 TTS 块又被播出来 |
| `mySplitStream` | ★★ | §7 proposed 规则：中文句末 + 后引号吸收、`.` 前瞻、首段软切、按语音单位计长度 | 31、32、34 | 见句号就切；只认 `.!?`；按字符计最小长度 |
| `myScheduleFillers` | ★ | 连续空闲满 `delayMs` 才触发；任一方说话重置；`intervalMs`/`maxSteps` | 26、27 | `toolStart + delay` 直接触发；填充语播放期间也当作"空闲" |

### 10.5 verify 断言清单（56 条，TS/Python 同数）

分组：A VAD 7 · B 端点 8 · C 投机 6 · D 播放截断 10 · E 打断 5 · F 分句 10 · G 填充语与任务板 6 · H 延迟账 4。★ = 专门抓"看起来对"的实现。

**A. VAD 滞回（7）**
- A1 全静音帧 → 无事件（不变量）
- A2 连续 10 帧 p=0.9 → 恰好 1 个 `speech_start`，t = 第 10 帧（200ms 满足）（INV-18）
- A3★ 单帧 p=0.9 夹在静音中 → 无 `speech_start`（单帧尖峰不是说话）（INV-18/23）
- A4★ 说话中夹一段 160ms 低概率 → 不产生 `speech_end`（stopMs=200）（INV-2）
- A5★ `speech_end.lastSpeechAt` = 最后一个高于阈值的帧时刻，不是判定时刻（INV-7）
- A6 `starting` 中途掉到阈值下 → 回 `quiet`，计时清零
- A7 p 恰等于阈值的处理在两种语言一致（`>=`）（跨语言不变量）

**B. 端点（8）**
- B1 `endpointDelay(0.5, ENDPOINT_ZH)` = 500
- B2★ `endpointDelay(0.001, ENDPOINT_ZH)` = 3000（低概率延长）（INV-12）
- B3★ 对任意 eouProb，`endpointDelay ≥ minDelayMs`（模型从不缩短）（INV-12）
- B4 同一 eouProb=0.008：zh 返回 500，en 返回 3000（阈值按语种）（INV-17）
- B5★ final 转写晚于 `lastSpeech+delay` → `commitAt = sttFinalAt`（INV-7）
- B6★ `nextSpeechStart < commitAt` → `null`（复说取消，不误切）（INV-2）
- B7 `nextSpeechStart ≥ commitAt` → 照常提交
- B8 `sttFinalAt = null` → 不提交（Pipecat：至少一个转写）

**C. 投机（6）**
- C1 转写只差大小写与末尾句号 → 有效（INV-15）
- C2★ 中文只差全角标点（"好的，查一下。" vs "好的查一下"）→ 有效（TS 若用 `\w` 会失败）（INV-34）
- C3★ 转写相同但 `toolsVersion` 变了 → 无效（INV-15）
- C4★ 转写相同但 `ctxVersion` 变了 → 无效（INV-15）
- C5 转写多一个词 → 无效
- C6 `normalizeTranscript` 幂等（不变量）

**D. 播放账本与截断（10）**
- D1 入队 3 块共 3000ms，t0 起播，`playedMsAt(t0+1200)` = 1200
- D2★ `bargeIn(t0+1200).audioEndMs` = 1200，不是 3000（生成 ≠ 播放）（INV-19）
- D3★ `audioEndMs ≤ 已入队总时长`（OpenAI 超出即报错）（INV-22）
- D4★ `heardText` 不含第 3 块任何字符（INV-19）
- D5 当前块按码点比例 floor 截断：块 "您的订单已经发货了"（9 字、1000ms），播放 500ms → "您的订单"（4 字）
- D6★ 一帧没播就打断 → `dropItem = true`（LiveKit 语义）（INV-20）
- D7★ 打断后 epoch+1；旧 epoch 的块再 `enqueue` → `'stale'`，`playedMsAt` 不增长（INV-19）
- D8 新 epoch 的块正常入队播放
- D9 两次连续 `bargeIn` 第二次返回 `null`（队列已空）（幂等）
- D10★ 播放速率与生成速率无关：块在 t0 一次性全部入队，`playedMsAt` 仍按实时增长（"server faster than realtime"）（INV-19）

**E. 打断判定（5）**
- E1 agent 没在说话 → `'ignore'`（这是话轮开始，不是打断）
- E2★ 300ms 的"嗯" → `'ignore'`（minDuration 500）（INV-18）
- E3★ 120ms 回声尖峰 → `'ignore'`（INV-23）
- E4 900ms 且有转写 → `'interrupt'`
- E5★ 900ms 但 2000ms 内无转写 → `'resume'`（误打断恢复）（INV-18）

**F. 分句（10）**
- F1 "好的，我帮您查一下。您的订单…" 首段 = "好的，我帮您查一下。"（INV-32）
- F2★ 中文无空格样本至少切出 2 段（抓"只认 `.!?` + 空白"的实现）（INV-32）
- F3★ "39.9元" 不在小数点处切（INV-31）
- F4★ "Dr. Wang" 不在缩写后切（INV-31）
- F5★ "example.com" 不切（INV-31）
- F6 "他说：“明天见。”然后…" 第一段以 `”` 结尾，第二段不以 `”` 开头（INV-31）
- F7★ 长逗号句首段在第一个逗号处出（t 远早于句号）（INV-32）
- F8 非首段不在逗号处切（首段/后续段非对称）
- F9 所有段拼接（去切点空白）== 原文（分句不改字符；抓 LiveKit 式插空格）（不变量）
- F10★ 按码点截断：块 "好😀好"（3 个码点、1000ms）播放 500ms → `heardText` = "好"；按 UTF-16 `slice` 的实现会得到 "好" + 孤立代理项（`"好😀好".length` = 4）（INV-34）

**G. 填充语与任务板（6）**
- G1 工具 300ms、delay 500 → 不触发（INV-26）
- G2★ 工具 1800ms、用户在 [400,900) 说话、delay 500 → 首次触发 = 1400，不是 500（INV-27）
- G3 `intervalMs=null` → 最多一次
- G4 `maxSteps=2`、长工具 → 恰好 2 次
- G5★ `amend` 后旧 epoch 的 `result` → `'stale'`，`utterable` 仍为 `'working'`（INV-29）
- G6★ 只有 `result(ok=true)` 被接受后 `utterable` 才是 `'completed'`（不能从"已发起"说"已完成"）（INV-29/30）

**H. 延迟账（4）**
- H1★ 同一时间线 `paperTtfa < livekitE2e < deadAir`（定义不同，数字不同）（INV-5/7）
- H2 `usefulLatency ≥ deadAir`，有填充语时严格大于（INV-26）
- H3★ 构造 9 个话轮使 Σ(各段 p50) ≠ p50(各轮总和)（INV-6）
- H4 `percentile` nearest-rank：`[100..900]` 的 p95 = 900、p50 = 500

### 10.6 与 L15 / L16 / L19 的边界

| 已学 | L16y 怎么用 | 不重讲 |
|---|---|---|
| L15 TTFT、缓存、fast mode | "起止点决定数字"直接迁移到首音延迟（§2.3）；新增"按时长计费让延迟变成成本"（INV-28） | 缓存机制、fast mode 原理 |
| L16 撤回、中断四语义、等待期、打字机代价 | 截断历史 = 撤回的语音版；"闭嘴 ≠ 取消订单" = "取消渲染 ≠ 取消生成"；PCM 奇数字节 / 分句前瞻 = chunk 边界不对齐语义单位；`\d` 跨语言坑再现 | SSE 分帧、JSON 参数累积、渲染层 |
| L19 queue_wait、start_latency、幂等 | 工具重试与 SIP 多连接重复事件引用 L19 的幂等键（§5.3、§6.3） | 队列、调度、重试退避 |

**L16y 独有、别处没有的**：话轮检测（VAD 滞回 + 端点 + 投机）、"生成 ≠ 发送 ≠ 播放"三层账、打断判定的混淆矩阵、中文分句、填充语调度。

## 11. 结尾：top 5 / 无一手来源清单 / API 草图 / 课时主题

### 11.1 最承重的 5 条反转

1. **INV-2 静音阈值在分布上就分不开"说完"和"在想"**（轮内停顿比换人间隙还长约 25%）。整个话轮检测章节、投机生成、语义模型的存在理由都从这里推出来；E1 实验直接把它变成一张表。
2. **INV-5 / INV-7 "首音延迟"至少有四种算法**：论文的 755ms 不含 STT 和 700ms 静音等待，LiveKit 的 e2e 含话轮等待但不含下行。学员带走的读数能力是"先对齐起止点再比数字"——这是 L15 TTFT 一课的直接延伸。
3. **INV-19 生成 ≠ 发送 ≠ 播放，历史必须截到用户听到的位置**（OpenAI truncate 原文明说）；Gemini 留"已发送"、LiveKit 按语速估算，三家语义还不一样（INV-20）。这是 L16"撤回已渲染内容"的语音版，也是 lab 里最容易写错的 TODO。
4. **INV-21 "闭嘴" ≠ "取消订单"**：话语打断必须停生成，后台任务可以继续，口头更新只能来自已验证状态（INV-29）。它把 L16 的"取消渲染 ≠ 取消生成"变成了一张 2×3 的表，也是 2026 年官方 GPT-Live 架构的核心不变量。
5. **INV-32 英文上验证过的分句规则在中文上失效**：论文规则在中文上 0 次切分（首音 = 整段生成完），LiveKit 的 20 字符阈值让中文首段语音时长约为英文 4 倍。本地实测可复现，而且直接打在中文学员的产品上。

### 11.2 查不到一手来源的说法（讲义不得当事实讲）

| 说法 | 现状 |
|---|---|
| "2026 年生产主流是级联/端到端" | 无市场份额一手数据；2603.05413 的 "all production voice agents" 是作者断言 |
| 人-人对话里"≥600ms 沉默被解读为拒绝"同样适用于人-机对话 | 只有人-人研究（Levinson & Torreira 引 Roberts 2011） |
| Gemini Live 自动 VAD 的默认参数 | 文档只给示例值（20/100），不是默认值 |
| 浏览器对 WebSocket + `AudioContext` 播放的 agent 语音实际做不做回声消除 | 只有 W3C 规范的 MUST/SHOULD，无一手实测 |
| 2026 年主流 ASR 在 8kHz 电话音频 vs 16kHz 下的 WER 差 | 只找到厂商营销页 |
| 中文 TTS 对数字、小数、版本号、英文缩写的读法规则 | 无厂商一手规范文档 |
| ElevenLabs `chunk_length_schedule` 对 CJK 字符怎么计数 | 文档只说 "characters" |
| 典型上下行 RTT、客户端抖动缓冲的数值 | 无一手典型值（G.114 只给编解码公式与上限） |
| Deepgram Flux "50-70% more LLM calls" | 厂商自报，无独立复现 |
| Pipecat "等词完整最多 297 ms" | 厂商单样本注释 |
| Qwen3-Omni 234ms 首包延迟 | 厂商 theoretical + cold-start；第三方托管实测 ~702ms |
| GPT-Live 实际每分钟价格 | 文档 $0.05/min 标为 illustrative |
| LiveKit 在中文句间插入的空格会不会影响中文 TTS | 无证据 |
| Pipecat 打断后的历史截断语义 | 本次调研未深读源码 |
| "TTS 按字符计费，所以 LiveKit 默认不投机 TTS"（§3.3 的推断） | 未逐家核对 TTS 价格页；LiveKit 源码只说明了默认值，没说明理由 |

### 11.3 Lab API 草图摘要（全文见 §10.2）

`labs/shared/voice.ts` / `voice.py` 九个纯函数模块，全部吃整数毫秒虚拟时钟：
A `vadStep/runVad`（四态滞回，Pipecat 默认 0.7/200/200）· B `endpointDelay/commitTurn`（LiveKit min 500 / max 3000，按语种阈值，复说取消）· C `normalizeTranscript/speculationValid`（四元组）· D `PlaybackLedger`（enqueue/playedMsAt/bargeIn + epoch + `heardText`）· E `judgeBargeIn`（min 500ms、2s 误打断恢复）· F `speechUnits/splitStream`（中英文分句）· G `scheduleFillers`（连续空闲）· H `TaskBoard`（verified-state + epoch）· I `ledger/percentile`（四种首音延迟）。
学员 6 个 TODO（★×3、★★×3），8 个观察实验，verify 56 条断言（A7 B8 C6 D10 E5 F10 G6 H4），每条对应 INV 或不变量。

### 11.4 课时主题建议（5 个，含证据）

建议把暂定的"级联还是端到端"降级为开场 10 分钟的框架（INV-9、INV-10：官方已是三种架构，生产份额无一手数据），其余按下面五个主题组织：

| # | 主题（标题建议） | 核心证据 | 时长 | lab |
|---|---|---|---|---|
| 1 | **首音延迟从哪一刻算起** | Stivers 2009 的适用范围；Levinson & Torreira 的 600ms 生产延迟；2603.05413 的 755ms 拆解；LiveKit `e2e_latency` 定义；G.114（INV-1/5/6/7/8） | 20 min | E3、H 组 |
| 2 | **静音不等于说完了** | 轮内停顿比换人间隙长；OpenAI 默认 `server_vad` 500ms；LiveKit 语义模型只延长；Pipecat/Flux 投机与撤回；多语种阈值（INV-2/11–17） | 25 min | E1、E2、TODO 1–3 |
| 3 | **用户听到的才算说过** | OpenAI truncate 原文；Gemini "already sent"；LiveKit 估算截断；WebRTC vs WebSocket 谁负责截断；W3C 回声消除保证范围；打断滞回（INV-18–25） | 25 min | E4、E5、TODO 4 |
| 4 | **"闭嘴"不等于"取消订单"** | GPT-Live 委派文档（后台继续、verified-state、旧结果作废、重试前查重）；填充语官方立场与 LiveKit 连续空闲调度；按秒计费（INV-21/26–30） | 20 min | E7、E8、TODO 6 |
| 5 | **中文的句号后面没有空格** | ElevenLabs 首块 120 字符；Pipecat 前瞻状态机；本地实测三种分句器 + LiveKit 真实代码；跨语言正则探针（INV-31–34） | 15 min | E6、TODO 5 |

合计约 105 分钟（加开场 10 分钟），落在 90–120 分钟的选修课时内。主题 3 和 4 是和 L16 同构最强的两块，可以直接用 L16 的"中断四语义"表做对照开场。
