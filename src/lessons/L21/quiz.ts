import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L21',
  questions: [
    {
      id: 'fact-vs-invariant',
      kind: 'choice',
      prompt:
        '课程结束后，同事把他的学习笔记整理成一张「知识地图」，每一行是一个节点。下面四行里，哪一行适合当节点的 `invariant`，而不是当一条带日期的证据？',
      options: [
        { id: 'a', label: '「主力模型用 `deepseek-chat`，便宜好用」' },
        { id: 'b', label: '「SWE-bench Verified 是可靠基准，选型看它的 % resolved 就够了」' },
        { id: 'c', label: '「多处匹配零写入；模型必须扩大上下文直到唯一」' },
        { id: 'd', label: '「Cursor 默认每次都问，所以我们的审批 UI 照抄这个默认」' },
      ],
      correct: ['c'],
      explain: `C。

判断一行字是节点还是证据，问一句：**它是名字或数字，还是机制或算术？** 前者回答「现在是什么」，天生带保质期；后者回答「违反了会坏在哪」，保质期取决于机制。

C 是 L17 钉住的不变量。只要你的编辑工具还带唯一性检查，它就成立，而且它能被违反、能被断言——这正是节点该有的形状。

---

另外三行全是**这门课写作期间就已经过期的事实**：

| 选项 | 过期于 | 出处 |
|---|---|---|
| A | \`deepseek-chat\` 2026 年 7 月退役 | L00、\`labs/README.md\` |
| B | 创建者 2026-02 停用 Verified；它推荐的 Pro 又在 2026-07-08 被撤回推荐 | L17、L18 调研 |
| D | Cursor 3.5（2026-05-22）弃用 "Ask Every Time" | L14 |

它们不是没用，而是**放错了位置**。A 应该是配置（\`pnpm models\` 查当前可用的 ID），不是知识；B 和 D 可以作为证据挂在节点下面，但必须带核实日期——到期了就重读。

还要注意 D 的第二半句：「照抄这个默认」把一个厂商默认值变成了你自己的设计依据。默认值一换，你的设计就失去了理由，而且**不会有任何东西报错**。`,
    },

    {
      id: 'stale-reaction',
      kind: 'choice',
      prompt:
        '你在 2026-10-09 跑 `findStale(courseGraph(), now, 60)`，报出 `eval.kappa`，账龄 100 天，`blast = ["eval.gate"]`。同事说：「kappa 是算术，100 天不可能让它变错。把 `evidenceAt` 改成今天，告警就没了。」下面哪种做法对？',
      options: [
        { id: 'a', label: '从地图里删掉 `eval.kappa`，它的证据太旧了' },
        { id: 'b', label: '照同事说的改 `evidenceAt`：过期 ≠ 错误，kappa 不会因为时间变假' },
        {
          id: 'c',
          label: '重读 L12 的 kappa 证据，再按 blast 核对 L18 的门禁，确认叙事仍成立后才更新 `evidenceAt`',
        },
        { id: 'd', label: '把 `maxAgeDays` 调到 120，让它不再报' },
      ],
      correct: ['c'],
      explain: `C。

**B 是最危险的选项，因为它的前半句是对的。** 「过期 ≠ 错误」正是 \`findStale\` 的语义——knowledge.ts 的注释写的是：过期不等于错误，等于「该重读」。

但「该重读」的意思是**读**。没读就改时间戳，等于把告警静音：下一次 \`findStale\` 会告诉你这条证据是今天核实的，而实际上没有人核实过。

而且这次重读真的会读出东西。kappa 本身是算术，但 blast 里的 \`eval.gate\` 是叙事——L18 开头写明，它**修正了 L12 里两处在 coding agent 上不成立的做法**：二值小样本上的 bootstrap，和「弄坏 ≥3 就拦」这个常数。kappa 节点的不变量没变，但「L12 的门禁卫生原样适用于 L18」这句话已经不完全对了。**这就是 blast 存在的理由：过期的节点没坏，被它拖着的叙事可能坏了。**

---

A 把「该重读」当成「该删除」。\`findStale\` 不删任何东西，这是有意的：删掉之后，\`eval.gate\` 那条 \`requires\` 边会悬空，\`validateGraph\` 会报 GRAPH-3 那类错误——你会丢掉门禁卫生从哪来的记录。

D 和 B 是同一个动作的另一种写法：调窗口直到不报，和改时间戳直到不报，都是在调告警而不是处理告警。窗口该按节点类型分（名字类短、机制类长），不该按「这次报了谁」调。`,
    },

    {
      id: 'blast-output',
      kind: 'choice',
      prompt:
        '`blastRadius(courseGraph(), "edit.not_unique")` 的返回值是什么？（骨架图里，`ops.idempotency` 与 `edit.not_unique` 之间有一条 `contrasts` 边，`eval.resolve` 到 `edit.not_unique` 有一条 `measured_by` 边。）',
      options: [
        { id: 'a', label: '`["edit.can_stop", "eval.gate", "eval.resolve", "sandbox.prefix"]`' },
        {
          id: 'b',
          label: '`["edit.can_stop", "eval.gate", "eval.resolve", "ops.idempotency", "sandbox.prefix"]`',
        },
        {
          id: 'c',
          label: '`["edit.can_stop", "edit.not_unique", "eval.gate", "eval.resolve", "sandbox.prefix"]`',
        },
        { id: 'd', label: '`[]`' },
      ],
      correct: ['a'],
      explain: `A。这就是 \`pnpm map\` 实验二打出来的那一行。

\`blastRadius\` 从起点出发，沿 \`requires\` **逆向**做 BFS——找的是「谁依赖我」，不是「我依赖谁」：

    edit.not_unique ← edit.can_stop ← eval.resolve ← eval.gate
    edit.not_unique ← sandbox.prefix

去重、按码点排序、不含起点，就是 A。

---

**B 多了 \`ops.idempotency\`。** 它和 NOT_UNIQUE「都在防双份」，但连着的是 \`contrasts\`。lab 的四个图算法**全部只沿 \`requires\` 走**，另外三种 kind 只是标注。所以 B 描述的是你也许**希望**它做的事，不是它做的事。真想让幂等跟着重核，要么把那条边画成 \`requires\`，要么在你自己的扩展里让 \`contrasts\` 也传播。

同理，\`eval.resolve\` 出现在 A 里，是因为 \`requires\` 链经过 \`edit.can_stop\`，**不是**因为那条 \`measured_by\`。

**C 多了起点自己。** verify 的 BLAST-3 专门断言「不含自身」。起点当然要重核，但它是起点，不是影响面。

**D 是方向写反的典型结果。** 沿 \`prerequisites\`（\`to\` 方向）走，NOT_UNIQUE 没有任何前提，于是什么都找不到——一个最承重的节点，影响面却是空的。这个 bug 不报错，只会让你在最该紧张的时候最放心。`,
    },

    {
      id: 'weight-order',
      kind: 'choice',
      prompt:
        '按 `shared/knowledge.ts` 的 `sourceWeight`，一篇 `kind: "vendor_blog"`、`trust: 0.8`、`reproducible: true`（附了可复跑的代码和数据）的厂商博客，加权后是多少？',
      options: [
        { id: 'a', label: '0.6——厂商博客封顶 0.6，可复核也不例外' },
        { id: 'b', label: '0.7' },
        { id: 'c', label: '0.9——0.8 加上可复核的 0.1' },
        { id: 'd', label: '0.8——可复核时不封顶' },
      ],
      correct: ['b'],
      explain: `B。规则的**顺序**决定答案：

    let t = s.trust                                    // 0.8
    if (s.kind === 'vendor_blog') t = Math.min(t, 0.6) // 0.6  ← 天花板先压
    if (s.reproducible) t = Math.min(1, t + 0.1)       // 0.7  ← 加成后加

天花板在加成之前，所以「封顶 0.6」严格说是「不可复核时封顶 0.6」。同理，可复核的 twitter 是 0.3，不是 0.2。

---

**A 是把讲义上的一句话当成了规则。** 「vendor_blog 封顶」是对的方向，不是精确语义。精确语义只在代码里。

**更值得注意的是：A 这个答案能通过本课初稿的全部 17 条 verify。** SRC-2 和 SRC-3 只测了不可复核的 twitter 和厂商博客；把加成挪到天花板之前，那两条照样绿，SRC-1 和 SRC-4 也照样绿。也就是说，**初稿的 verify 分辨不出这两种顺序**。现在的 SRC-5 就是补的那一条：可复核、trust 0.8 的厂商博客必须是 0.7，可复核、trust 0.9 的 twitter 必须是 0.3。

哪种顺序「更对」是一个策略问题：参考实现的选择是「可复核总值 0.1」，哪怕来源有营销激励。你可以不同意——但不同意要写成断言，不要写成直觉。

C 忽略了天花板，D 发明了一条规则里没有的豁免。`,
    },

    {
      id: 'leaderboard-tweet',
      kind: 'choice',
      prompt:
        '一条转发很多的推文：「新版 agent 在 SWE-bench Verified 上 resolved 涨了 9 个点，赶紧换。」你的团队正在用 L18 的门禁做选型。按这一节的方法，正确的处理是？',
      options: [
        { id: 'a', label: '在地图上加一条边，`evidenceAt` 记今天；数字很具体，可以给高 trust' },
        {
          id: 'b',
          label:
            '进待观察桶：问分母（resolve 还是 apply、第几次尝试、scaffold 版本），注意这个基准已被创建者停用；真想知道，就在自己的任务集上成对跑一次',
        },
        { id: 'c', label: '把「+9」写进 L18 门禁当作候选的预期值，门禁只需确认方向一致' },
        { id: 'd', label: '直接忽略：twitter 的权重封顶，等于没有信息' },
      ],
      correct: ['b'],
      explain: `B。按新论文三问走一遍：

**它推翻哪条边？** 一条都不推翻。它是一个水平差值，碰的是 \`eval.resolve\` 和 \`eval.gate\`，但这两个节点讲的是「怎么判定」和「怎么比较」，一个外部数字改变不了它们。

**分母是什么？** 推文没说，于是要问的全是 L18 的问题：

- resolve 还是 apply？改测试骗绿算不算？
- 第几次尝试？aider 的头条数字就是带测试错误输出的第二次尝试
- scaffold 的 commit hash、重试次数、N 是多少？N=10 时翻一题就是 ±10pp
- 基准本身：OpenAI 2026-02 以污染和测试缺陷为由停用了 Verified

**能零模型复现吗？** 不公开轨迹就不能。

所以它进待观察桶。而「真想知道」的正确动作，是在你自己的任务集上跑**成对**对比，用 claim 门（优效）而不是 regress 门（非劣）——你要证明的是「更好」，不是「没变差」。

---

**A 把「具体」当成了「可信」。** 数字越具体，越像证据，但具体性不是来源属性。按 \`sourceWeight\`，不可复核的 twitter 不管 trust 填多高都压到 0.2。

**C 是一个更隐蔽的错误**：它没有采信这个数字，却让这个数字**塑造了你的门禁**。门禁的预期值来自外部推文，你的 A/B 就变成了「确认别人的结论」。

**D 把封顶理解成了归零。** 0.2 不是 0。讲义的说法是：榜面分数可以当「谁值得一看」的线索，不能当边的 \`evidenceAt\`。值得一看，所以去自己的集上跑；不能当证据，所以不改地图。`,
    },

    {
      id: 'cache-90',
      kind: 'choice',
      prompt:
        '一篇厂商博客说「开启 prompt caching 可节省 90% 的输入成本」。你的服务每个请求都是一次性的长 prompt（几乎不复用），走的是 DeepSeek 的 Anthropic 兼容端点。下面哪种判断对？',
      options: [
        { id: 'a', label: '照 90% 写进成本预测，厂商自己的数字最权威' },
        {
          id: 'b',
          label:
            '90% 是命中部分的读取折扣；一次性 prompt 开缓存反而贵 25%，兼容层还可能不报错地忽略 `cache_control`。先在自己的计价模型上复算，再用 `usage` 字段确认命中',
        },
        { id: 'c', label: '开了之后看 TTFT 有没有变快，变快就说明命中了' },
        { id: 'd', label: '缓存省钱是营销话术，不开' },
      ],
      correct: ['b'],
      explain: `B。三问逐个过：

**90% 是什么？** 读取按 0.1 倍计价，只作用在**命中的那部分前缀**上。它不是「输入成本」，是「被复用的那部分输入的成本」。

**分母是什么？** 复用次数。L15 实验一复算的账：

    N        倍率      省
    1        1.25x  -25.0%
    2        1.35x   32.5%
    10       2.15x   78.5%

你的场景是 N=1：**写入按 1.25 倍计，没有第二次读，净亏 25%。**

**前提呢？** 你走的是兼容端点，DeepSeek 的兼容表里 \`cache_control\` 四次写着 \`Ignored\`——它不报错，只是不缓存。前缀低于门槛也一样：\`no error is returned\`。

**能零模型复现吗？** 能。L15 的计价模型复算出了 OpenAI 原文的 1.35× 和 2.15×。做完这一步，这条知识就从 \`vendor_blog\` 变成了你自己的 \`own_verify\`。

---

**C 是骨架图里专门有一个节点要防的错误**：\`budget.usage\` 的不变量就是「不用 TTFT 侧信道」。命中与否看 \`usage\` 里的缓存字段。缓存确实会降低 TTFT，所以这个方法**看起来能用**；但 L15 查过，没有任何厂商给出可引用的幅度——你在用一个没有刻度的量，去判定一件有精确字段可读的事。

**A 把「一手」当成了「无条件」。** 厂商说的 90% 在它的前提下是对的，只是你的场景不满足那个前提。

**D 犯的是反方向的错。** 只要前缀会被复用第二次，N=2 就已经省 32.5%。「营销话术」的判断和「照搬 90%」一样，都没有算账。`,
    },

    {
      id: 'paper-no-edge',
      kind: 'choice',
      prompt:
        '你读到一篇论文：在一个大型编辑语料上测得「模糊匹配导致的静默错改率很低」。同事据此提议：把编辑工具换成「首命中 + 模糊匹配」，去掉 `NOT_UNIQUE`，因为它让模型多走了很多轮。你怎么回应？',
      options: [
        { id: 'a', label: '采纳：有测量就该更新；`NOT_UNIQUE` 的依据被推翻了' },
        {
          id: 'b',
          label:
            '它没推翻任何边：`NOT_UNIQUE` 的依据是不对称成本，不是发生率。先看 blast，再在自己的任务集上跑这条消融',
        },
        { id: 'c', label: '删掉 `edit.not_unique` 节点，把 `evidenceAt` 置 0 等以后再说' },
        { id: 'd', label: '论文不可能比自己的 verify 更可信，直接拒绝阅读' },
      ],
      correct: ['b'],
      explain: `B。

**问一：它声称推翻哪条边？** 要回答这个问题，你得知道那条边**原本靠什么站着**。L17 调研的 M-6 写得很清楚：模糊匹配会导致静默错改，这在机制上有源码证据；它有多常发生，没有任何一手来源测过。所以当初的决策依据是：

> 因为它的检测成本极低（一次字符串计数），所以即使发生率很低也值得防。

**这是基于不对称成本的决策，不是基于测量的决策。** 一个「发生率很低」的测量，不改变「检测只需一次字符串计数」这件事，也不改变「错改一次的代价是一次静默的错误写入」这件事。它填的是 L17 调研里一个「查不到」的空，不是你图上的一条边。

**第四步：采纳的代价。** \`blastRadius(g, "edit.not_unique")\` 有 4 个节点：L17 的 canStop 与路径检查、L18 的 resolve 口径与门禁。去掉 NOT_UNIQUE，L17 那条「先失败 → 扩大上下文 → 成功」的交互循环就没了。

而「多走了很多轮」是一个可以自己测的假设——L18 的消融表里本来就有「拿掉 \`NOT_UNIQUE\` 的分级反馈」这一行。在自己的集上跑它，结果才配改主路径。

---

**A 是这道题要拦的那个反射。** 「有新测量就更新」听起来很科学，但前提是那个测量**测的正是你的依据**。不先写清楚节点的依据，任何测量都像是在推翻它。

**C 混淆了两件事。** \`evidenceAt = 0\` 表示「证据未知」，而这里的证据（机制 + 不对称成本）一点都没变。

**D 把 \`sourceWeight\` 用反了。** 权重是用来给证据打折的，不是用来拒绝阅读的。这篇论文值得读，也值得作为一条低 trust 的注记挂在节点下——只是它不改主路径。`,
    },

    {
      id: 'tool-three-questions',
      kind: 'choice',
      multi: true,
      prompt:
        '有人推荐一个「智能编辑」库：官方博客说「编辑成功率 98%」；匹配不到原文时它会自动应用到「最接近的位置」，返回值里只有 `ok: true`，没有匹配数之类的字段；仓库里没有测试。下面哪些是**不把它放进主路径**的正当理由？（多选）',
      options: [
        { id: 'a', label: '失败时没有信号：静默应用到最接近的位置，也没有可读回的字段' },
        { id: 'b', label: '「98%」的口径没写死：apply 还是 resolve？分母是什么？' },
        { id: 'c', label: '你写不出一条能进 CI 的零模型断言来证明它在你的场景下没有静默错改' },
        { id: 'd', label: '它的 GitHub 星标和下载量还不够多' },
      ],
      correct: ['a', 'b', 'c'],
      explain: `A、B、C——换工具之前的三问，三问都是「无」。

**A：失败时有没有信号？** 这个库把 L17 的头号静默失效当成了功能：首命中 / 最接近匹配，改错了也 \`ok: true\`。L15 里 fast mode 也静默降速，但它至少有 \`usage.speed\` 可以读回——有读回字段，你能写判定器；连这个都没有，就没有任何办法知道它什么时候错了。

**B：口径写死了吗？** 「98% 成功」大概率是 apply 口径：补丁落下了。L18 的四种口径里，apply 是最宽的那一行，而「打到了错的位置」在 apply 口径下**算成功**。没写口径的成功率，默认按最宽口径理解。

**C：有没有能进 CI 的断言？** 没有测试、没有匹配数字段，你连「同一段文字出现三次时它改了哪一处」都断言不了。L17 lab 的对抗性文件（\`get\` 和 \`peek\` 里有一模一样的三行）就是为这件事准备的——你得能把它喂进去并断言结果。

三问都「无」→ 可以玩，不要进主路径。

---

**D 不是理由，也不是反理由。** 星标和下载量既不是失败信号、也不是口径、也不是断言。一个十万星的库同样可以静默改错位置，而一个没人用的库也可能每一问都过。用流行度做技术判断，就是让别人替你做了三问——而他们大概率没做。`,
    },

    {
      id: 'open-iou',
      kind: 'choice',
      multi: true,
      prompt:
        '课程结束时，下面哪些欠条**仍然是 open**——课程给了方法或者明确留给了你，但没有交付一个能直接用的实现或数字？（多选）',
      options: [
        { id: 'a', label: 'L02 → L16：流式响应头已发出，服务端没法用状态码报错' },
        { id: 'b', label: 'L17 → L18：「改对的比例」怎么算' },
        { id: 'c', label: 'L16 → L17 → L19：TTFT 基线' },
        { id: 'd', label: 'L00 → L16：「你在 L16 会发现自己有别人没有的优势」' },
        { id: 'e', label: 'L15：`temperature` 会不会打掉缓存' },
      ],
      correct: ['c', 'e'],
      explain: `C、E。

**C：方法兑了，数字没有。** L19 把 TTFT 拆成三段——\`queue_wait\`、\`start_latency\`、\`model_ttft\`——并写明前两段能从作业事件推导，第三段只有真实调用才有，lab 没有计算函数。L16 当初的原话是「等你的 capstone 跑起来，那个数字就是你自己的基线」。所以这张欠条最终的债主是你。

**E：查不到一手来源。** L15 在自己的欠条里写明：官方失效表里没有采样参数，合理推断是不会打掉缓存，「但这是推断，不是引用」。后面的课没有再接。它该以一条 \`[P2]\` 级的推断挂在地图上，标成 open，等新证据。

---

A、B、D 都已兑付：

| 欠条 | 兑付 |
|---|---|
| A | L16 的 \`reset-step\`：撤回是协议的一部分 |
| B | L18 的四种口径并排，主指标是 resolve |
| D | L16：优势不是界面好看，是习惯了「内容正在到达、随时会变、屏幕必须自洽」 |

**这道题的真正问题是：你的地图会不会记住 C 和 E？** lab 骨架图里只有一条 \`iou\` 边，而且四个图算法**都不沿 \`iou\` 走**——一张没兑的欠条在 lab 里不会让任何东西报警。而 C 是最容易被误记成「已兑」的一张：L19 确实讲了 TTFT，读完很容易打勾。但 L16 欠的是一个数字，L19 交付的是方法——**「讲过了」和「兑了」是两件事**。`,
    },

    {
      id: 'buggy-map',
      kind: 'debug',
      prompt:
        '一位同学交了 TODO 2、3、4 的实现（TODO 1 和 5 已正确）。跑 `pnpm verify:l21`，19 条断言会挂哪几条？更重要的是：**还有哪些错误 verify 根本抓不到**？逐个说明症状，以及你会补什么断言。',
      lang: 'ts',
      code: `import { prerequisites, type KnowledgeGraph, type Source } from '../shared/knowledge.ts'
import { cmpCodePoint } from '../shared/codingEval.ts'

export function myBlastRadius(g: KnowledgeGraph, id: string): string[] {
  const seen = new Set<string>([id])
  const q = [id]
  while (q.length) {
    const cur = q.shift()!
    for (const next of prerequisites(g, cur)) {
      if (!seen.has(next)) {
        seen.add(next)
        q.push(next)
      }
    }
  }
  return [...seen].sort(cmpCodePoint)
}

export function myFindStale(g: KnowledgeGraph, now: number, maxAgeDays: number) {
  const ms = maxAgeDays * 86_400_000
  return g.nodes
    .filter((n) => now - n.evidenceAt > ms)
    .map((n) => ({
      id: n.id,
      ageDays: Math.round((now - n.evidenceAt) / 86_400_000),
      blast: myBlastRadius(g, n.id),
    }))
    .sort((a, b) => cmpCodePoint(a.id, b.id))
}

export function mySourceWeight(s: Source): number {
  let t = s.trust
  if (s.reproducible) t = Math.min(1, t + 0.1)
  if (s.kind === 'own_verify') t = Math.max(t, 0.9)
  if (s.kind === 'twitter') t = Math.min(t, 0.2)
  if (s.kind === 'vendor_blog') t = Math.min(t, 0.6)
  if (!s.reproducible && s.kind === 'paper') t = Math.min(t, 0.7)
  return Math.round(t * 1000) / 1000
}`,
      rubric: [
        '你有没有发现 `myBlastRadius` 走的是 `prerequisites`（我依赖谁），而影响面要的是 `dependents`（谁依赖我）？',
        '你有没有注意到 `seen` 用起点初始化，于是结果里含起点自己（BLAST-3）？',
        '你能说出 `evidenceAt === 0` 在这个 `findStale` 里会得到什么 `ageDays`，以及为什么它仍然被报出来、却挂了 STALE-3？',
        '你有没有发现 `mySourceWeight` 把加成挪到了天花板之前，并说出是哪条 SRC 抓住了它、SRC-1…4 为什么抓不住？',
        '你有没有注意到 `Math.round` 和 `Math.floor` 的差别在实验三里看不出来，只在时钟不是零点时才出现？',
        '对每个 verify 抓不到的错误，你有没有写出一条能抓住它的断言？',
      ],
      reference: `会挂 **5 条**：BLAST-1、BLAST-2、BLAST-3、STALE-3、SRC-5。另外有**两处**错误 19 条全绿也抓不到。

## 一、blastRadius：方向反了，还带上了自己

    for (const next of prerequisites(g, cur))   // ← 我依赖谁
    const seen = new Set<string>([id])          // ← 起点进了结果

影响面是「谁依赖我」，要沿 \`requires\` **逆向**走，也就是 \`dependents\`。\`edit.not_unique\` 没有任何前提，于是这个实现的返回值是：

    ["edit.not_unique"]

只有它自己。BLAST-1（resolve 被波及）、BLAST-2（gate 被波及）、BLAST-3（不含自身）**三条全挂**。

注意症状：不报错，返回一个看起来合理的数组。更糟的是，图里**最承重**的节点得到了**最小**的影响面——你会在最该紧张的地方最放心。

修法：换成 \`dependents\`，\`seen\` 从空集开始，只在发现新依赖者时加入。

## 二、findStale：未知证据被当成了「很老」

    .filter((n) => now - n.evidenceAt > ms)

\`evidenceAt === 0\` 的节点没有特判。\`now - 0\` 是一个巨大的数，所以它**仍然被报出来**——这就是这个 bug 难发现的原因。但 \`ageDays\` 变成了：

    Math.round(Date.UTC(2026, 9, 9) / 86_400_000)  = 20735

一个 1970 年至今的天数。STALE-3 断言的是 \`Infinity\`，挂。

\`Infinity\` 和 20735 的区别不是格式问题：前者说「从没核实过」，后者说「核实过，很久以前」。按账龄排优先级时，一条从没核实过的证据会被排在一条真的很老的证据后面。

## 三、sourceWeight：加成挪到了天花板之前

| 输入 | 这个实现 | 参考实现 |
|---|---|---|
| vendor_blog，0.8，可复核 | 0.6 | 0.7 |
| twitter，0.9，可复核 | 0.2 | 0.3 |
| own_verify，0.5，可复核 | 0.9 | 1.0 |

SRC-5 挂：前两行要的是 \`[0.7, 0.3]\`，这个实现给 \`[0.6, 0.2]\`。SRC-1…4 抓不住——SRC-1 只断言 own ≥ 0.9，SRC-2 / SRC-3 只测不可复核的来源，SRC-4 只比较两篇论文。本课初稿只有这四条，SRC-5 是照这道题补的。

顺带，最后一行 \`Math.round(t * 1000) / 1000\` 在 TS 里能过 SRC-6（\`0.0625 → 0.063\`）。照搬到 Python 写成 \`round(t, 3)\` 就挂：\`0.0625\` 在二进制里精确，是真平局，Python 取偶得 0.062。

## 四、verify 抓不到的两处

**1. \`Math.round\` 而不是 \`Math.floor\`。** 实验三的时钟是 UTC 零点，所有日期差都是整天，round 和 floor 结果相同。把时钟拨到同一天 15:00：

    eval.kappa   这个实现 101   参考实现 100

过期判定本身用的是毫秒比较，所以**谁被报出来不受影响**，只有显示的账龄多了一天。补一条：用非零点时钟断言 \`ageDays\`。

**2. 报告里的 \`blast\` 也是错的。** \`myFindStale\` 调的是上面那个 \`myBlastRadius\`，于是 \`eval.kappa\` 的 blast 是 \`["eval.kappa"]\` 而不是 \`["eval.gate"]\`。STALE 组只断言了 id 和 \`ageDays\`，没有断言 blast。补一条：\`findStale(g, now, 60)\` 里 \`eval.kappa\` 的 \`blast\` 等于 \`["eval.gate"]\`。

## 这道题想说的

前三个 bug 被 verify 抓到了，因为有人**预先想到**了它们——第三个是这道题自己逼出来的：初稿的 17 条抓不住顺序，于是有了 SRC-5。后两个还没被抓到，因为还没人补。own_verify 的 0.9 地板奖励的是「可重跑」，不是「测对了东西」——L18 调研审计过的那版草稿 45/45 全绿，门禁语义却是写反的。

**verify 全绿的意思是「我想到的都对了」。** 补断言，就是把你新想到的东西也变成能重跑的证据。`,
    },

    {
      id: 'design-own-map',
      kind: 'design',
      prompt:
        '课程结束三个月后，你要为自己（和一个 4 人小组）设计一张真正在用的知识地图：数据结构、证据规范、更新节奏、以及线上失败怎么进图。写出你的设计，重点说清你在 lab 的 `knowledge.ts` 之上**加了什么、拒绝了什么**，以及为什么。',
      scenario:
        '现状：团队的 agent 走一个兼容端点，模型 ID 已经因为退役换过一次；有一套 40 题的 L18 式任务集，nightly 跑；线上有 L19 式的作业队列，偶尔出现死信和幂等冲突。大家的「知识」散落在聊天记录、书签和一份没人维护的 wiki 里，wiki 首页还写着某个基准是「业界最可靠的标准」。有人提议「每周开会过一遍 wiki」。',
      reference: `没有唯一答案，但有几个点能区分「想过」和「没想过」。

## 一、先承认 lab 的四处简化

\`knowledge.ts\` 是教具，它有意保持小。你的设计首先要知道它**没做**什么：

| lab 的现状 | 后果 | 你可能要加的 |
|---|---|---|
| 四个图算法只沿 \`requires\` 走 | \`contrasts\` / \`iou\` 不报警 | 让 \`iou\` 进 \`findStale\`；或单独一个 open 欠条清单 |
| 所有节点同一个 \`maxAgeDays\` | 窗口 7 天时 10 个全报，全报等于不报 | 每个节点自己的保质期，按「名字类 / 机制类」分档 |
| \`Source\` 没有证据标签 | 分不清读了原文还是凭记忆 | \`[P]\` / \`[P2]\` / \`[S]\` / \`[L]\` / \`[O]\` |
| 节点只有一个 \`evidenceAt\` | 不知道证据是什么、谁核的 | 证据列表：来源、标签、核实日期、核实人 |

## 二、节点：不变量，不是产品名

wiki 首页那句「某基准是业界最可靠的标准」是一个反例：它是事实，而且已经过期了——SWE-bench Verified 2026-02 被创建者停用，它推荐的 Pro 又在 2026-07-08 被撤回推荐。

节点该写成「主指标必须是 resolve，不是 apply」这样的话：能被违反、能被断言。基准名进证据，带日期。

模型 ID 根本不进地图——它是配置。地图里该有的是一个节点「模型 ID 是配置，不是常量」，证据是你们那次退役事故。

## 三、证据规范：标签 + 核实日期 + 一句话

    [P]   2026-09-29  某厂商推荐某基准            alice
    [P]   2026-10-09  同一家撤回该推荐            bob
    [O]   2026-10-09  verify：跨租户 key 拿不到作业  ci
    [S]   ——          「某产品内部是这样路由的」    ——

三条规矩：

1. **\`[S]\` 不能单独支撑任何数字**，进单独的清单，到期删或者升级。
2. **核实日期是「最后确认它仍成立」的日子**，不是来源发布日，也不是你第一次读到它的日子。读到一篇 2 月的原文、而作者 7 月已经改口——这件事在这门课的两份调研之间真实发生过。
3. **区分断言类型**：厂商陈述自己的行为（「我们停用了 X」）和厂商宣称能力（「我们提升了 X%」）是两种东西，\`sourceWeight\` 不区分，你的规范要区分。

## 四、节奏：事件驱动 + 周 / 月 / 季

「每周开会过一遍 wiki」的问题是：它没有告诉你**该看哪里**。一张没有过期判定的 wiki，每周过一遍只能是随机抽查。

| 节奏 | 做什么 |
|---|---|
| 每次事件 | 模型退役、厂商公告、线上故障 → 找到节点，跑 blast |
| 每周 | 本周的失败和读到的论文过新论文三问，进图或进待观察桶 |
| 每月 | 查当前模型 ID；名字类节点窗口 30 天 |
| 每季度 | 机制类节点窗口 90 天；重跑全部 own_verify；清点 open 欠条 |

报告按 blast 大小排优先级，不按 id。**重核完才更新核实日期。**

## 五、线上失败怎么进图

L19 留给这一节的话：死信深度、拒绝计数、幂等冲突率会比论文更早告诉你哪里错了。所以第二种证据源是你自己的线上信号，流程是：

1. 复现成确定性输入
2. 分层：机制层写零模型断言；agent 行为层做成任务集的新题，过 \`validateTaskSet\`（有 fail-to-pass、钉 repoPin、每个难度层不为空）
3. 回到图上：违反了已有不变量 → 先跑 blast 再更新；新不变量 → 加节点，**至少用一条 \`requires\` 接上**，否则它不会出现在任何人的影响面里

## 六、要拒绝什么

- **不把排行榜截图当证据。** 它可以当「谁值得一看」的线索。
- **不按流行度给来源加权。** 星标不是失败信号、不是口径、不是断言。
- **不自动删除过期节点。** 过期是重读的触发器，删掉会让 \`requires\` 边悬空。
- **不为了消告警调窗口或改时间戳。** 那是把告警静音。
- **不追求「完整」。** 一张没有 open 欠条的地图不是学完了，是没在记。

## 七、一件必须承认的事

上面的节奏是**这门课的建议，不是测量出来的最优值**。没有任何来源测过「知识地图该多久重核一次」。所以你的设计文档里应该写明：窗口长度是一个可以被你们自己的数据推翻的初始值——第一个季度结束时，看看 findStale 报出来的节点里，有多少真的读出了变化。`,
      rubric: [
        '你的节点是不变量（能被违反、能被断言），而不是产品名、模型 ID 或基准名吗？',
        '你有没有指出 lab 的简化（只沿 requires 走、单一窗口、没有证据标签），并说明你加了什么？',
        '你的证据有没有「标签 + 核实日期」，而且核实日期的含义是「最后确认它仍成立」？',
        '你的节奏有没有区分名字类和机制类节点的保质期，避免「全报等于不报」？',
        '线上失败有没有一条路径变成任务集新题或零模型断言，并且回到图上接一条 requires 边？',
        '你有没有写出明确拒绝做的事，并给出理由？',
        '你有没有承认节奏的数字是初始值而不是测量结果？',
      ],
    },
  ],
}
