import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L16y',
  questions: [
    {
      id: 'ttfa-755',
      kind: 'choice',
      prompt:
        '一位同事拿 arXiv 2603.05413 的「Measured TTFA 755ms」做立项依据：「级联已经 sub-second 了，我们照这个架构做中文客服，用户说完不到一秒就能听到回答。」哪个判断最准确？',
      options: [
        { id: 'a', label: '对。755ms 是论文实测的端到端首音延迟，用户说完不到一秒就能听到回答' },
        {
          id: 'b',
          label:
            '不对。755 = 296 + 143 + 316（LLM 首 token、分句、TTS），不含 STT（P50 402ms），也不含论文自己 VAD 的 700ms 静音等待；按论文自己的数字，用户闭嘴到听见第一个音在 1.8 秒以上。比数字之前先对齐起止点',
        },
        {
          id: 'c',
          label: '不对。应该把 Table 4 里 STT、LLM TTFT、TTS TTFB 三个分量的 P50 相加：402 + 457 + 221 = 1080ms，这才是用户等待的中位数',
        },
        { id: 'd', label: '不对。ITU-T G.114 要求端到端延迟不超过 150ms，755ms 远超标准，级联架构本身就不可用' },
      ],
      correct: ['b'],
      explain: `B。

755 = 296 + 143 + 316，三项分别是 LLM 首 token、分句、TTS 合成，一毫秒不差。同一篇论文的 Table 4 里 Deepgram STT 的 P50 是 402ms，第 5 节的 VAD 状态机是 \`LISTENING —silence 700ms→ PROCESSING\`。从用户闭嘴到听见第一个音，按论文自己的数字至少 700 + 约 400 + 755，也就是 1.8 秒以上。论文没有隐瞒任何数字，只是 TTFA 的起点放在了「LLM 请求发出」那一刻。

lab 的实验三把这件事做成了一条时间线：同一个话轮，论文口径 540ms、LiveKit e2e 1060ms、死寂 1180ms、有用延迟 2900ms，差五倍多。H1 钉前三个数，H2 钉有填充语时有用延迟严格大于死寂。

还有一层是中文特有的：论文的分句规则要求「标点后跟空白」，中文句号后面没有空格。实验六里 \`paper\` 在 zh-basic 上首段 1410ms，也就是整段生成完才开口；\`proposed\` 是 600ms（F2 要求五个中文样本都至少切出 2 段）。搬到中文，那 143ms 的分句会退化成「等 LLM 说完」。

---

A 错：755 的起点是 LLM 请求发出，终点是 TTS 首块。它不含话轮等待和 STT，也不含下行和客户端播放缓冲。

C 错：分段百分位不能相加。实验三九个话轮上，各段 p50 相加 1050ms，总耗时 p50 是 1590ms（H3）。论文自己的表也是例子：Table 4 的 "Est. E2E TTFA" 写 P50 958、Mean 1054，而三个分量的 P50 相加是 1080，Mean 相加是 407 + 622 + 226 = 1255，两个都对不上。何况这个和里仍然没有 700ms 的话轮等待。

D 错：G.114 的 150ms 是 "mouth-to-ear" 的单向传输延迟，不含对方思考的时间，不能拿来当话轮延迟的标准。它对 agent 的意义是：上行和下行各晚一段，管道延迟在一个话轮里出现两次。

对应讲义开头、第一节 1.2–1.3、第五节 5.2；实验三、实验六；断言 H1、H2、H3、F2。`,
    },
    {
      id: 'percentile-sum',
      kind: 'choice',
      multi: true,
      prompt:
        '你的监控面板按段记录话轮等待、LLM 首句、TTS 首块，各自算 p50 和 p95，再把三段相加报成「端到端 p50 / p95」。lab 实验三的九个话轮上：各段 p50 相加 1050ms，总耗时 p50 1590ms；各段 p95 相加 4540ms，总耗时 p95 4100ms。下列哪些说法正确？（多选）',
      options: [
        {
          id: 'a',
          label: '各段 p50 相加偏低：每段慢的都不到一半，各段中位数都落在快的一侧，而九轮里有八轮至少一段是慢的。1050 不是总耗时的中位数',
        },
        { id: 'b', label: '各段 p95 相加总是总耗时 p95 的上界，所以拿 4540ms 当 SLO 预算是安全的' },
        { id: 'c', label: '应该直接测端到端的分布，报中位数和 p95，并把「我查一下」这类确认和真正的答案分开测' },
        { id: 'd', label: '打开 semantic VAD 之后等待时间更集中，只报 p50 就够了' },
        {
          id: 'e',
          label: '分位数没有可加性：两段各自有 4% 的概率出现 100ms 尖峰时，每段 p95 都是 0，总耗时 p95 却是 100',
        },
      ],
      correct: ['a', 'c', 'e'],
      explain: `A、C、E。

A 对：每一段单看，慢的都不到一半（话轮等待 3 轮是 3000，LLM 4 轮在 860 以上，TTS 3 轮在 600 以上），所以各段中位数都落在快的那一侧；但九轮里有八轮至少有一段是慢的，总耗时的中位数把它们都算了进去。H3 钉住 1050 对 1590。

C 对：OpenAI 评测指南原文 "compare the median and 95th percentile"，以及 "Measure acknowledgments such as "I'm checking" separately from the answer the caller needs."。实验三同一个话轮，死寂 1180ms、有用延迟 2900ms，中间差的就是一句填充语（H2）。

E 对：这正是 B 的反例。625 个话轮，两段各自独立地有 4% 的概率出现 100ms 尖峰，否则为 0。按 nearest-rank（H4 钉的定义），每段的 p95 都是 0；至少一段出尖峰的话轮占 1 − 0.96² = 7.84%，超过 5%，总耗时的 p95 是 100。

---

B 错：实验三里 p95 相加 4540 确实大于总耗时 p95 4100，因为它把每段最慢的那一次加在一起（3000 + 900 + 640），而这三次从没出现在同一轮。所以它常被当作保守预算。但这是这组数据的性质，不是定理，E 就是反例。

D 错：方向反了。OpenAI \`semantic_vad\` 的 \`eagerness\` 控制的是最长等待："\`low\`, \`medium\`, and \`high\` have max timeouts of 8s, 4s, and 2s respectively"。确定的句子几乎不等，拖尾的句子最坏等满，分布是双峰的，p50 恰好把慢的那一峰藏起来。

对应讲义第一节 1.3 和其中的 Drill、第二节 2.2 的 Pitfall；实验三；断言 H2、H3、H4。`,
    },
    {
      id: 'silence-threshold',
      kind: 'choice',
      prompt:
        '产品经理看了实验一的表（静音阈值 200 / 300 / 500 / 700 / 1000ms，误切 8/12、8/12、5/12、3/12、1/12），说：「取 1000ms，误切只剩一个；再调到 1200ms 就零误切了。」最好的回应是哪个？',
      options: [
        { id: 'a', label: '同意。在这组数据上 1200ms 就零误切了，死寂多几百毫秒用户感觉不出来' },
        { id: 'b', label: '应该取 200ms：Stivers 2009 测出人类话轮间隙约 200ms，agent 要和人一样快' },
        {
          id: 'c',
          label:
            '没有一个阈值能同时做到不切人和不慢：同一个人说话时的停顿平均比换人间隙还长约 25%，死寂随阈值一毫秒不差地涨，1000ms 仍切了 t06。要叠第二个信号，并在等待期间就开始生成',
        },
        { id: 'd', label: '不需要调：OpenAI Realtime 默认就是 semantic_vad，接上就有智能话轮' },
      ],
      correct: ['c'],
      explain: `C。

Levinson & Torreira 转述 ten Bosch et al. 2005：同一个人说话时的停顿 "about 140 ms (c. 25%) longer than the average gap in turn transitions between different speakers"。静音长度这一个特征，在分布上就分不开「说完了」和「在想」。实验一把它变成了数：误切从 8/12 降到 1/12，平均死寂从 200ms 一毫秒不差地涨到 1000ms（final 转写在说完后 200ms 到，不超过阈值，死寂就等于阈值）。1000ms 仍然切了 t06「嗯……让我想想……还是算了吧」里那个 1100ms 的停顿。

出路是叠第二个信号、把等待期用起来：语义话轮模型只在「不像说完」时延长等待（实验二），提交前必须等到 final 转写（B5、B8），等待期间就开始投机生成（讲义 2.5）。

---

A 错：在这组合成数据上 1200ms 确实零误切，因为数据里最长的停顿恰好是 1100ms；真实用户没有这个上限。代价是每一轮都多等 1.2 秒。人-人研究里 600–700ms 以上的停顿会被听者读成对方不情愿；这在人-机对话里是否成立没有一手证据，但也没有理由假设用户更能等。

B 错：Stivers 2009 的数是面对面、是非问句、含点头这类可见回应的众数（0ms）和均值（208ms），不是可以照搬的阈值。实验一里 200ms 误切 8/12。Levinson & Torreira 的结论是人在预测话轮结束，不是在对静音做反应。

D 错：OpenAI Realtime 的默认值是 \`server_vad\`：500ms 静音、阈值 0.5、前置 padding 300ms。\`semantic_vad\` 要显式打开。

对应讲义第一节 1.1、第二节 2.1–2.2；实验一、实验二；断言 B5、B8。`,
    },
    {
      id: 'semantic-only-extends',
      kind: 'choice',
      prompt:
        '团队把「静音 500ms 即提交」换成 LiveKit 风格的话轮模型（min 500ms、max 3000ms、中文阈值 0.0066）。评审会上有人说：「语义模型能判断用户说完了，接话会比纯静音快。」按实验二和 LiveKit 的源码，哪个说法对？',
      options: [
        { id: 'a', label: '对。模型判断「说完了」的概率很高时，会把等待缩短到 500ms 以下，平均死寂下降' },
        { id: 'b', label: '误切会降到 0：语义模型能识别所有没说完的停顿，t09 也不会被切' },
        { id: 'c', label: '中英文共用一个阈值即可：同一个概率 0.008，中英文的等待时间相同' },
        {
          id: 'd',
          label:
            '误切从 5 降到 1，但死寂下限仍是 500ms，平均从 500 涨到 954，最大 3000（t07、t12）。模型只在「说完了」的概率低于阈值时把等待延长到 max，从不缩短；更快要靠等待期间就开始的投机生成',
        },
      ],
      correct: ['d'],
      explain: `D。

LiveKit \`audio_recognition.py\` 里，\`endpointing_delay\` 先取 \`min_delay\`，只有当话轮结束概率低于语种阈值时才改成 \`max_delay\`。没有任何一条分支让它比 \`min_delay\` 更短。实验二用同一组话轮对比：

    静音 500：误切 5，死寂 最小 500 / 平均 500 / 最大 500
    LiveKit ：误切 1，死寂 最小 500 / 平均 954 / 最大 3000

模型买的是少截断，不是更快。结尾拖着的 t07「那如果我……」和 t12「我再看看……那个……」要等满 3000ms。所以 LiveKit 默认同时开着 \`preemptive_generation\`：话轮等待是唯一一段纯在等的时间，让 LLM 在这段时间里就开始。

---

A 错：这正是 B3 要抓的错法。B3 对 8 个概率逐个断言等待不短于 \`minDelayMs\`；B1、B2 分别钉「概率高等 500」「概率低于中文阈值等 3000」。

B 错：t09 的停顿 520ms、概率 0.05，高于中文阈值 0.0066，模型照样切。LiveKit 的 \`languages.json\` 里中文 TNR 0.8661：在厂商自己的测试集上，静音已满 \`min_delay\` 的「没说完」停顿约 13% 仍被判成说完。B6 用你的实现重跑实验二，要求 LiveKit 规则恰好误切 \`t09\`。

C 错：阈值按语种分开校准，中文 0.0066、英文 0.011，各语种 TPR 都钉在 0.993 附近。B4 断言同一个 0.008，中文等 500、英文等 3000。

对应讲义第二节 2.4–2.6；实验二；断言 B1、B2、B3、B4、B6。`,
    },
    {
      id: 'debug-speculation',
      kind: 'debug',
      prompt:
        '同学交上来 TODO 3，说：「C1、C5 都过了，英文的大小写和标点都处理对了。」跑 `pnpm verify:l16y`，C 组哪几条会红、各红在什么输入上、打印什么？同样的逻辑翻译到 Python 通道，哪一条红的会变绿，为什么这反而更危险？最后给出修法。',
      lang: 'ts',
      code: `export function myNormalizeTranscript(s: string): string {
  return s.toLowerCase().replace(/[^\\w\\s]/g, '').replace(/\\s+/g, ' ').trim()
}

export function mySpeculationValid(spec: SpecKey, committed: SpecKey): boolean {
  return myNormalizeTranscript(spec.transcript) === myNormalizeTranscript(committed.transcript)
}`,
      rubric: [
        '你有没有指出 C2 会红、打印「归一化结果 ""」，并说清原因：TS 的 `\\w` 只认 `[A-Za-z0-9_]`，`[^\\w\\s]` 把汉字当标点删光？',
        '你有没有说出 C2 背后的线上后果：任何两句中文都归一化成空串，投机结果永远「有效」，用户改了口，agent 仍按改口前的转写回答？',
        '你有没有指出 C3、C4 会红（只比了转写，没比 toolsVersion、ctxVersion、toolChoice），并说出这意味着基于旧工具列表或旧上下文的回答被直接播出去？',
        '你有没有发现 C6 红在 `\\u00a0x` 上：JS 的 `\\s` 和 `trim()` 都认不间断空格，而 lab 只去 ASCII 空格？',
        '你有没有说清 Python 通道里 C2 会变绿（Python 的 `\\w` 认汉字），而 C3、C4、C6 仍然红，所以最严重的那个 bug 在一条通道里看不见？',
        '你的修法有没有用显式的标点集合和只针对 ASCII 空格的处理，而不是 `\\w`、`\\s`、`trim()`，并且把四样都比上？',
      ],
      reference: `会红四条：C2、C3、C4、C6。C1、C5 会过。

## C2：TS 的 \\w 不认汉字

    myNormalizeTranscript('好的，查一下。')   // 期望 '好的查一下'，实际 ''

verify 打印「归一化结果 ""」。JS 正则的 \`\\w\` 只等于 \`[A-Za-z0-9_]\`，于是 \`[^\\w\\s]\` 把每一个汉字都当成标点删掉。后果比「C2 红了」严重得多：任何两句中文都归一化成空串，C2 第三条「好的查一下」对「好的取消」也会判成有效。用户在话轮等待期间改了口，agent 照旧按改口前的转写回答。

## C3、C4：只比了转写

    C3：toolsVersion 1 → 2，打印「应无效」
    C4：ctxVersion 3 → 4，打印「ctxVersion 变了应无效」

C4 在第一个检查就失败，所以 \`toolChoice\` 那一半不会被打印出来，但同样是错的。LiveKit 在提交时比四样：转写（\`casefold()\`、忽略标点）、chat context、tools、tool_choice，任一变了就 "preemptive generation invalidated"。话轮等待期间工具列表或上下文变了（比如上一个工具结果刚写进上下文），投机出来的回答是基于旧世界的。

## C6：不间断空格被去掉了

    myNormalizeTranscript('\\u00a0x')   // 期望原样保留，实际 'x'

JS 的 \`\\s\` 认 U+00A0：先被 \`\\s+\` 换成普通空格，再被 \`trim()\` 去掉。前面几个幂等检查都能过，红在最后一行，打印「不间断空格不是 ASCII 空格，不该被去掉」。

## 换到 Python：C2 变绿

| 断言 | TS | Python（同一行正则） |
|---|---|---|
| C2 | 红：汉字被删光，得到空串 | 绿：Python 的 \\w 认汉字，得到「好的查一下」 |
| C3、C4 | 红 | 红 |
| C6 | 红 | 红：Python 的 \\s 和 strip() 也认 U+00A0，得到「x」 |

同一行正则，两条通道错在不同的地方。Python 那边 C2 是绿的，最严重的那个 bug 在 Python 通道里根本看不见；如果团队只跑 Python 的 verify，它就带着上线了。这就是 lab 禁用 \`\\w\`、\`\\d\` 的原因（讲义第五节的 PyMirror）。

## 修法

    // PUNCT：自己写一份显式的中英文标点集合（参考实现里那份没有导出）
    export function myNormalizeTranscript(s: string): string {
      let out = ''
      for (const c of Array.from(s)) {
        if (PUNCT.has(c)) continue
        if (c === '\\t' || c === '\\n' || c === '\\r') out += ' '
        else if (c >= 'A' && c <= 'Z') out += c.toLowerCase()
        else out += c
      }
      return out.replace(/ +/g, ' ').replace(/^ +/, '').replace(/ +$/, '')
    }

    export function mySpeculationValid(spec: SpecKey, committed: SpecKey): boolean {
      return (
        myNormalizeTranscript(spec.transcript) === myNormalizeTranscript(committed.transcript) &&
        spec.ctxVersion === committed.ctxVersion &&
        spec.toolsVersion === committed.toolsVersion &&
        spec.toolChoice === committed.toolChoice
      )
    }

只动 ASCII 字母和 ASCII 空格，标点用白名单；中文、全角数字、不间断空格都原样留下。`,
    },
    {
      id: 'truncate-to-played',
      kind: 'choice',
      prompt:
        '客服 agent 走 OpenAI Realtime 的 WebSocket 传输。一条回复切成 5 块、每块 1000ms，TTS 以 3 倍实时生成、生成完立刻发给客户端。用户在播放到 1200ms 时打断。之后对话历史里这条 assistant 消息应该保留到哪里？`conversation.item.truncate` 的 `audio_end_ms` 填多少？',
      options: [
        {
          id: 'a',
          label: '截到已播放：历史只剩「您的订单已经发货了，预」，`audio_end_ms` 填 1200，按客户端实际播放的位置算',
        },
        { id: 'b', label: '整段保留，`audio_end_ms` 填 5000：模型下一轮需要知道自己完整的意图' },
        {
          id: 'c',
          label: '保留已发送到客户端的部分（到「优惠券也补发到您的账户，」为止），`audio_end_ms` 填 4000：服务端发出去了，就算说过了',
        },
        { id: 'd', label: '客户端什么都不用算：发一个 `output_audio_buffer.clear`，服务端会自己把历史截到播放位置' },
      ],
      correct: ['a'],
      explain: `A。

OpenAI truncate 事件的说明第一句就是根因："The server will produce audio faster than realtime, so this event is useful when the user interrupts to truncate audio that has already been sent to the client but not yet played." 第二句是目的："Truncating audio will delete the server-side text transcript to ensure there is not text in the context that hasn't been heard by the user."

实验四就是这道题：打断时已发送 4000ms 音频，实际播放 1200ms；三种历史分别是整段、到「优惠券也补发到您的账户，」为止、「您的订单已经发货了，预」。生成、发送、播放是三本账，这是 L16「撤回已渲染的内容」的语音版。

这个 1200 怎么得到也有讲究：要用实际播放位置（比如由 \`AudioContext.currentTime\` 推出的已播样本数），不能用交给播放管线的字节数。字节后面还有抖动缓冲、\`AudioWorklet\` 队列、蓝牙耳机的缓冲，按字节算会系统性偏大，偏大的正好是用户没听到的部分。

---

B 错：整段留着，历史里就有用户没听到的话。下一轮用户问运费，模型会说「我刚才说过了，运费已经原路退回」。

C 错：这是 Gemini Live 的语义（"Only the information already sent to the client is retained in the session history."），不是 OpenAI 的。服务端比实时快，「已发送」一般领先于「已播放」，客户端缓冲里没播的 2800ms 在这种历史里算说过了。用 Gemini 时要知道这一点，用 OpenAI 时不该自己退化成它。

D 错：\`output_audio_buffer.clear\` 标着 WebRTC/SIP Only。WebSocket 下 "the client manages audio playback, and thus must stop playback and handle truncation"。另外三条约束：\`audio_end_ms\` 超过实际音频时长服务端会报错；只有 assistant 消息能截断；\`content_index\` 填 0。

对应讲义第三节 3.1–3.4 和 3.6 的 Drill；实验四；断言 D2、D3、D4。`,
    },
    {
      id: 'debug-barge-in',
      kind: 'debug',
      prompt:
        '同学的 TODO 4。他说：「D1、D10 都过了，播放时间算对了；D5 也过了，按比例截文字也对。」跑 `pnpm verify:l16y`，哪几条会红、各红在什么输入上？为什么 D1、D10 抓不到其中最要紧的那个 bug？它在线上什么场景下出事？另外还有一处 verify 完全不覆盖的错误，找出来。',
      lang: 'ts',
      code: `export class MyPlaybackLedger extends PlaybackLedger {
  override bargeIn(t: Ms): Truncation | null {
    if (!this.speakingAt(t)) return null
    const cur = this.scheduled.find((s) => s.start <= t && t < s.start + s.chunk.ms) ?? this.scheduled[0]!
    const itemId = cur.chunk.itemId
    const mine = this.scheduled.filter((s) => s.chunk.itemId === itemId)
    const played = this.playedMsAt(t)
    const text = mine.map((s) => s.chunk.text).join('')
    const total = mine.reduce((n, s) => n + s.chunk.ms, 0)
    const heard = text.slice(0, Math.floor((text.length * played) / total))
    this.scheduled = []
    this.freeAt = t
    return { itemId, audioEndMs: played, heardText: heard, dropItem: played === 0 }
  }
}`,
      rubric: [
        '你有没有指出 D2 红在第二个输入上：两条 item 时 audioEndMs 是 2400 而不是 a2 的 400，因为 playedMsAt 算的是整个账本，不是这个 item？',
        '你有没有指出 D4 会红：文字按整个 item 的总长度成比例截，得到「您的订单已经发货了」，少了第二块已播的「预」？',
        '你有没有指出 D7 会红：epoch 没有加一，打断后迟到的旧块还会被入队播出来？',
        '你有没有指出 F10 会红：text.length 和 slice 按 UTF-16 码元，截出「好」加一个孤立代理项？',
        '你能不能说清 D1、D10 为什么抓不到：它们的 fixture 只有一条 item，整个账本播了多少恰好等于这条 item 播了多少？',
        '你能不能举出线上场景：填充语和答案是两条 item 排在一起，用户在答案中途打断，audioEndMs 把填充语也算了进去？',
        '你有没有发现回退到 scheduled[0] 的问题：打断落在两条 item 之间的空档里时，会去截已经播完的那条，而一帧没播的下一条没有被 dropItem？',
      ],
      reference: `会红四条：D2、D4、D7、F10。D1、D3、D5、D6、D8、D9、D10 会过。

## D2：playedMsAt 是整个账本的

D2 的第一个输入是三块同属 a1、从 100 起播，1300 时打断，期望 1200，这份代码过了。第二个输入是两块 a1 加一块 a2，2400 时打断：

    期望：itemId a2，audioEndMs 400
    实际：{"itemId":"a2","audioEndMs":2400,"heardText":"下一条","dropItem":false}

\`this.playedMsAt(t)\` 把账本里所有块播过的时长都加起来，a1 的 2000ms 也算到了 a2 头上。\`audioEndMs\` 应该是这个 item 内的毫秒：只对 \`mine\` 逐块累加 \`max(0, min(块时长, t − 块开始))\`。

## D4：文字要逐块截

    three().bargeIn(1300)   // 期望 '您的订单已经发货了预'，实际 '您的订单已经发货了'

整条 item 24 个字、3000ms，按 1200 / 3000 成比例截出 9 个字。但第一块 9 个字已经整块播完，第二块 8 个字播了 200ms，应该再加 1 个字「预」。shared 的 \`heardText\` 是逐块累加、只对当前块按码点比例向下取整。D5 只有一块，两种算法结果相同，所以过了。

## D7：epoch 没加一

verify 打印「epoch 应为 1，实际 0」。后果是用户刚说「停」，迟到的 TTS 块照样入队、照样播出来半句话。这就是 L16 lab 里「\`aborted\` 之后还往屏幕上写字」。

## F10：按 UTF-16 截

\`"好😀好".length\` 是 4，播一半截出 \`slice(0, 2)\`，verify 打印 \`实际 "好\\ud83d"\`。要按码点：\`Array.from(text)\`。

## 为什么 D1、D10 抓不到 D2 那个 bug

D1、D10 的 fixture 里所有块都属于同一条 item，整个账本播了多少，恰好就是这条 item 播了多少。单 item 的测试再多也测不出「算错了范围」，只有 D2 的第二个输入放了两条 item。

线上的典型场景是填充语和答案排在一起。下面这个输入 verify 里没有，用参考实现和这份代码各跑一遍：

    「我查一下」1200ms（item f1）+ 答案两块各 1000ms（item a2），全部 0 时入队，1700 时打断
    参考实现：a2 播到 500，听到「您的订单」
    这份代码：a2 播到 1700，听到「您的订单已经发货了预计明天下」

WebSocket 下这个 1700 会原样进 \`conversation.item.truncate\`：历史里留下一大段用户没听到的话。如果打断再晚一点、算出来的值超过了 a2 的实际音频时长，服务端直接报错。

## verify 不覆盖的：回退到 scheduled[0]

    「我查一下」1000ms（f1）在 0 入队，答案（a2）在 1500 才入队，1200 时打断
    参考实现：{"itemId":"a2","audioEndMs":0,"heardText":"","dropItem":true}
    这份代码：{"itemId":"f1","audioEndMs":1000,"heardText":"我查一下","dropItem":false}

1200 落在两条 item 之间的空档里，没有块在播。参考实现取第一个还没播完的块，也就是一帧都没播的 a2，整条丢掉；这份代码回退到队首，去截已经播完的 f1（等于什么都没截），a2 一帧没播却留在了历史里。D3 的空档在同一条 item 里，所以测不出来。

## 小结

| bug | 后果 | 被哪条抓到 |
|---|---|---|
| playedMsAt 算整个账本 | 多条 item 时截错位置，可能报错 | D2 第二个输入 |
| 按整条 item 成比例截文字 | 听到的文字少字或多字 | D4 |
| 忘了 epoch | 打断后旧块又播出来 | D7 |
| 按 UTF-16 截 | 截出半个 emoji | F10 |
| 回退到队首 | 空档里打断时没播的 item 留在历史里 | 无 |

修法：当前 item 取「t 时正在播的块，否则第一个还没播完的块」；\`audioEndMs\` 只对这条 item 的块累加；\`heardText\` 用 shared 的函数；最后 \`this.epoch++\`、清空队列、\`freeAt = t\`。`,
    },
    {
      id: 'shut-up-vs-cancel',
      kind: 'choice',
      prompt:
        '用户说：「帮我把周五的预约改成周四。」后端开始改约，还没回来，用户又说：「嗯，等一下……」。你的实现把 barge-in 接在一个 `AbortController` 上：用户一开口就 `abort()` 这一轮所有在途请求，然后 agent 说「好的，已经帮您取消了」。哪个评价最准确？',
      options: [
        { id: 'a', label: '合理。用户打断就是不想继续了，停掉一切最安全' },
        { id: 'b', label: '只错在措辞：应该说「正在取消」而不是「已取消」，abort 本身没问题' },
        {
          id: 'c',
          label:
            '话语打断和任务取消被接成了一个信号。打断只该停播放、停生成、把历史截到已播放，后台任务照常跑；abort 丢掉的只是结果，改约请求可能已经生效。「已取消」只能在后端确认之后说，重试前要先查是否已经发生',
        },
        { id: 'd', label: '合理，只要把 abort 之后迟到的结果都标成 stale，就不会出现重复预约' },
      ],
      correct: ['c'],
      explain: `C。

GPT-Live 委派文档两句话把它说清了："Interrupting the spoken conversation leaves backend work running." 以及 "Handle changes to a task separately from interruptions to speech. "Stop talking" asks the assistant to yield; "Cancel my booking" asks the backend to take an action."

| 信号 | 话语（播放、生成、历史） | 后台任务 | 口头能说什么 |
|---|---|---|---|
| 话语打断：用户开口了 | 停播放、停生成，历史截到已播放 | 照常跑 | 已验证状态不变 |
| 任务取消：「帮我取消预约」 | 不必停 | 后端执行取消 | 后端确认成功之后才能说「已取消」 |

这道题里还有两层：

- 「嗯，等一下」很可能根本不该算打断。实验五里 300ms 的「嗯」在 min=500 时是 ignore（E2）；min=0 时它有转写，会被当成真打断
- abort 管得了你的连接，管不了预约系统。请求早发出去了，abort 丢掉的只是结果：预约可能已经改了，agent 不知道，下一轮可能再改一次。GPT-Live 的要求是 "a lost response should not cause a second booking"，这是 L19 幂等键的事

---

A 错：用户开口只说明正在说的那段话过期了，不说明任务该停。GPT-Live 的设计前提就是 "Users can keep talking while backend work runs."

B 错：措辞改了，abort 的问题还在。而且「正在取消」也不对：用户根本没要求取消，只是说了句「等一下」。

D 错：stale 管的是能说什么，不管发生了什么。实验八里周五的结果迟到、被判 stale，状态仍是 working（G5），这保证 agent 不会说「您已订好周五」；但周五那个请求在后端是否生效，epoch 管不了。防重复执行要靠每个副作用一个 owner 加幂等键，SIP 文档："Choose one owner for each side effect, even if multiple connections observe an event."

对应讲义第四节 4.1 的 Pitfall、4.2；实验五、实验八；断言 E2、G5、G6。`,
    },
    {
      id: 'filler-timing',
      kind: 'choice',
      prompt:
        '工具调用前配了一句填充语「我查一下」（1200ms）。同事甲：「工具开始后 500ms 还没回来就说。」同事乙：「用 LiveKit 的 `with_filler`，默认参数就行。」按实验七（工具 1800ms，用户在 400–900ms 之间还在补充说话；另一个场景工具只要 300ms），哪个说法对？',
      options: [
        { id: 'a', label: '甲的做法最好：500ms 准时开口，答案推迟 0ms' },
        { id: 'b', label: '连续空闲调度既不会撞上用户，也不会推迟答案，是严格更优的做法' },
        { id: 'c', label: '填充语播放期间 session 也算空闲，所以第二句填充语可以在第一句开始后 interval 毫秒准时插进去' },
        {
          id: 'd',
          label:
            '连续空闲调度在 1400ms 才说、不撞上用户，但填充语一开口就要说完，答案从 1800 推到 2600（推迟 800ms）；乙的默认 delay=0 会让 300ms 的工具也先说 1.2 秒填充语，答案推迟 900ms。要用连续空闲加一个不为零的 delay，并在答案能直接给出时不说',
        },
      ],
      correct: ['d'],
      explain: `D。

实验七：

    场景                                  调度        触发    撞上用户  答案推迟
    工具 1800ms，用户在 400–900 说话      开始后计时  500     是        0ms
                                          连续空闲    1400    否        800ms
    工具 300ms，delay=0（LiveKit 默认）   开始后计时  0       否        900ms
                                          连续空闲    0       否        900ms
    工具 300ms，delay=500                 开始后计时  —       否        0ms
                                          连续空闲    —       否        0ms

LiveKit \`with_filler\` 的语义是 "waits for the session to be continuously idle for \`delay\` seconds"，任一方开口都重置计时，默认 \`delay\` 是 0。OpenAI Realtime prompting guide 对填充语的评价是 "Used well, they reassure the user that the assistant is working. Used poorly, they become filler and increase perceived latency."，不该说的情形里有一条是 "the tool call is lightweight and the user would not benefit from an update"。

---

A 错：500ms 正好落在用户 400–900ms 说话的那段上，agent 和用户抢同一条通道。答案「推迟 0ms」只是因为填充语在 1700 说完、工具 1800 才回来，碰巧没挡路。

B 错：连续空闲不撞车，但不是没有代价。填充语 1400 开口、2600 说完，工具 1800 就回来了，答案只能排到 2600。

C 错：填充语本身的播放算忙。G4：\`maxSteps=2\`、\`intervalMs=1000\` 时结果是 \`[500,2200]\`。interval 从上次触发按墙钟算，到 1500 时第一句还在播（500–1700），要等 1700 播完再连续空闲满 500，2200 才说第二句。

对应讲义第四节 4.3；实验七；断言 G1、G2、G3、G4。`,
    },
    {
      id: 'zh-splitter',
      kind: 'choice',
      prompt:
        '你把一个英文上测出 sub-second 的级联搬到中文客服，分句沿用论文的规则：`.` `!` `?` 后跟空白才切，最小 10 字符。上线后中文的首音明显变慢。实验六里第 i 个 token 在 300 + 30·i ms 到达，下面哪个说法对？',
      options: [
        { id: 'a', label: '换成「见到 `.!?。！？` 立刻切」就行：zh-basic 首段 570ms，最快，没有副作用' },
        {
          id: 'b',
          label:
            '论文规则要求标点后跟空白，中文句号后面没有空格：`paper` 在五个中文样本上都只有 1 段，zh-basic 首段 1410ms，也就是整段生成完；`proposed` 是 600ms。中文句末直接切但多等 1 个字符吸收后引号，`.` 要前瞻，首段可在逗号处切，长度按语音单位',
        },
        { id: 'c', label: '直接用 LiveKit 的 `split_sentences` 默认参数，中英文都没有问题' },
        { id: 'd', label: '干脆不分句，把 LLM 的每个 token 直接送进 ElevenLabs 并打开 `auto_mode`，延迟最低、质量不受影响' },
      ],
      correct: ['b'],
      explain: `B。

    分句器    样本           首段ms  首段单位  段数  误切
    naive     zh-basic          570         8     3     0
    naive     zh-decimal        480         7     5     3
    naive     en-tricky         390         4     8     5
    paper     zh-basic         1410        32     1     0
    paper     zh-longcomma     1950        52     1     0
    proposed  zh-basic          600         8     3     0
    proposed  zh-longcomma      540         8     2     0
    proposed  en-tricky         480         7     3     0

论文原文 "Detect sentence-ending punctuation (., !, ?) followed by whitespace"。它只测了英文，这不是它的错；但搬到中文，分句这一步退化成「等 LLM 说完」。\`proposed\` 的四条：中文句末无歧义但多等 1 个字符，让后引号跟着这一句走（F6）；\`.\` 前瞻 1 个字符、查缩写（F3–F5）；第一段够 4 个语音单位就可以在逗号处切，后续段至少 8 个、不在逗号处切（F7、F8）；长度按语音单位，一个汉字算 1，一串 ASCII 字母数字算 1。\`proposed\` 在 zh-basic 上比 \`naive\` 慢 30ms，就是那 1 个字符的前瞻。F1 钉住 \`proposed\` 在全部 8 个样本上的四列。

---

A 错：\`naive\` 最快，但 en-tricky 8 段里 5 处误切（\`$39.\`、\`Dr.\`、\`1.\`、\`2.\`、\`example.\`），zh-decimal 3 处：交给 TTS 的第一段是 \`这款套餐每月39.\`，第二段从「9元」开始。zh-quote 上它把后引号甩到下一段开头。zh-longcomma 只有一个句号，它也要等到 1920ms。

C 错：LiveKit 的英文规则很扎实（\`p.m.\`、\`Dr.\`、\`$39.99\`、\`1.2.3\`、\`example.com\` 全对），但最小长度 20 字符把中文首段合并成了 \`好的，我帮您查一下。 您的订单已经发货了，预计明天下午送到。\`：按语音单位是 25 个，英文首段只有 5 个。拼接时还在中文句间插了一个 ASCII 空格，而 F9 要求分句不改字符。

D 错：ElevenLabs 对 \`auto_mode\` 的原文是 "It is only recommended when sending full sentences or phrases, sending partial phrases will result in highly reduced quality." TTS 要上下文才有好韵律，所以 LiveKit 的 ElevenLabs 插件开 \`auto_mode\` 时是一句一送，分句器同时决定首音延迟和韵律。

对应讲义第五节；实验六；断言 F1、F2、F6、F7、F9。`,
    },
    {
      id: 'design-voice-agent',
      kind: 'design',
      prompt:
        '为一家电商设计中文语音客服 agent，两个入口：网页客服（浏览器）和电话（SIP）。能力：查订单、改收货地址、退款。老板只给了一个指标：「首音延迟 p95 小于 1 秒」。写出你的设计，至少覆盖：指标怎么定义和测、话轮检测与投机、打断后的历史（分传输讲）、打断判定、填充语、后台任务与口头更新、中文分句、上线前的评测。',
      scenario:
        '技术栈是级联：流式 STT → LLM（带工具调用）→ ElevenLabs WebSocket TTS。话轮检测可以用 LiveKit 的话轮模型，也可以自己写。退款走第三方支付网关，请求一旦发出就无法从客户端撤回。',
      rubric: [
        '有没有先定义延迟的起点和终点，区分死寂和有用延迟，并且测端到端分布，而不是把分段百分位相加？',
        '有没有指出话轮等待有下限、语义模型最坏等到 max，「p95 小于 1 秒」要和误切率一起谈，而不是只调静音阈值？',
        '话轮提交有没有等 final 转写、处理复说取消？投机的有效性有没有比四样（转写、上下文、工具、tool_choice）？',
        '打断后的历史有没有截到已播放，并分别说清 WebRTC、WebSocket、SIP 下谁来算、谁来截？',
        '打断判定有没有持续时长阈值和误打断恢复？有没有避开 echo gate？',
        '有没有把话语打断和任务取消分成两个信号，口头确认只来自后端确认过的状态，退款有「先查再重试」或幂等键？',
        '填充语有没有按连续空闲调度、给出不为零的 delay，并承认它会推迟答案？',
        '中文分句有没有处理无空格的句末、后引号、小数和缩写、首段逗号软切，并按语音单位计长度？',
        '评测有没有按实时节奏喂音频，覆盖中文特有的样本，并把重复副作用当成必须为零的指标？',
      ],
      reference: `## 先改指标

「首音延迟 p95 小于 1 秒」在定义起止点之前没有意义。同一个话轮，论文口径 540ms、LiveKit e2e 1060ms、死寂 1180ms、有用延迟 2900ms（实验三）。我会报下面三个数，延迟一律测端到端分布的 p50 和 p95，不把分段百分位相加：

- 死寂：用户实际说完（离线标注）到第一个可听见的音
- 有用延迟：用户实际说完到第一个有用的音，填充语不算。OpenAI："Measure acknowledgments such as "I'm checking" separately from the answer the caller needs."
- 误切率：和死寂一起报。比较两个话轮策略时先把误切率固定在同一水平再比死寂，否则「更快」可能只是「切得更多」

然后和老板对齐预期：话轮等待本身有 500ms 下限，语义模型在拖尾句上会等到 max（3000ms），只要超过 5% 的话轮触发 max，p95 就在 3 秒以上。能承诺的是死寂 p50、误切率上限、有用延迟 p95，以及 max 本身取多少。

## 话轮与投机

- VAD 四态滞回（阈值 0.7、start 200ms、stop 200ms），说完时刻记最后一个有声帧，不记判定时刻
- 提交时刻 = max(最后有声帧 + 等待, final 转写到达)；没有 final 不提交；提交前用户又开口就取消
- 中文用 LiveKit 多语种模型的阈值 0.0066，min 500、max 3000。它只延长不缩短；厂商测试集上中文 TNR 0.8661。Deepgram 的 flux-general-multi 不含中文
- VAD 一说停就开始投机生成 LLM；提交时比四样：归一化转写、上下文版本、工具版本、tool_choice，归一化不用 \\w
- 投机的输出先扣住，确认后才放行（Pipecat SpeculationGate 的做法）；其中的工具调用等提交有效之后再执行
- 没用上的投机计入成本

## 打断与历史

- 浏览器走 WebRTC：服务端知道播放进度、自动截断；浏览器 AEC 也只对 RTCPeerConnection 来源有规范保证
- 如果某处只能走 WebSocket：客户端维护播放账本，audio_end_ms 是该 item 实际播放的毫秒（按播放位置，不按交出去的字节），发 conversation.item.truncate；一帧没播的 item 整条丢；epoch 加一，迟到的块丢弃
- SIP：服务端管播放缓冲；但媒体路径、sideband、webhook 可能都看到同一个工具调用，每个副作用指定一个 owner
- 换厂商要重读语义：Gemini Live 保留的是已发送，不是已播放

## 打断判定

- 声音持续 500ms 才算打断，停下后 2 秒内没有转写就恢复（LiveKit 默认）。实验五里 min=500 判错 0 次，代价是关门声这类够长的噪声会造成一次卡顿
- 不用 echo gate：它同时关掉了打断。研究表明电话上的接话比面对面更快，不要假设电话用户更能等

## 后台任务与口头更新

- 话语打断只停播放和生成，不碰任务；任务取消是单独的意图，交给后端
- 任务板：用户每改一次需求 epoch 加一，旧结果 stale；口头更新只取已验证的状态
- 「已退款」只在网关确认之后说；调用前按 Realtime prompting guide 确认金额、对象和后果；重试前先查是否已经发生，幂等键见 L19
- 用户在退款执行中说话：这一步可以只记录、不打断确认流程；查订单时不静音，用户改口要立刻生效

## 填充语

- 只在工具慢时说：连续空闲满一个不为零的 delay（比如 500ms），填充语本身算忙，最多一两次
- 答案能直接给、用户只是确认或纠正、最新音频是噪声时不说
- 量答案被推迟了多少：实验七里两种情况分别推迟 800ms 和 900ms
- 如果用的是按时长计费的产品，后台慢一秒就多付一秒

## 中文分句

- 中文句末直接切，但多等 1 个字符吸收后引号；. 要前瞻并查缩写；首段够 4 个语音单位可在逗号处切，后续段至少 8 个；长度按语音单位；分句不改字符
- ElevenLabs 开 auto_mode 时只送整句
- 数字读法（39.9元、2026年）没有可依赖的一手规范，要自己做 TTS 侧的测试

## 上线前评测

- 音频按实时节奏喂。OpenAI："supply a continuous microphone stream paced at its recorded sample rate"。话轮和打断都是时间驱动的，一次性灌入测不出来
- 中文测试集要有长逗号句、小数、中英混排、拖尾句、「嗯」、咳嗽、回声
- 指标：误切率、死寂与有用延迟的 p50 和 p95、打断判错数、截断后的历史与实际播放是否一致、重复副作用次数（必须是 0）、投机浪费比例
- 电话入口单独测：8kHz 音频上采样到模型的采样率，丢掉的高频回不来；8kHz 对中文 ASR 的影响没有一手数据，要自己量`,
    },
  ],
}
