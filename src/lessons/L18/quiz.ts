import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L18',
  questions: [
    {
      id: 'resolve-vs-apply',
      kind: 'choice',
      prompt:
        '你在 lab 的 demo 基线上跑完实验一，海报写「成功率 92%」。同事问口径，你说「12 道题里 11 道的补丁都 apply 上了」。同一批记录的 resolve 是 6/12 = 50%。把 92% 当主指标，问题出在哪？',
      options: [
        { id: 'a', label: '92% 和 50% 都对，海报挑哪个都行，只要附上 N=12' },
        {
          id: 'b',
          label:
            'apply 只说明补丁落进了工作树；它不检查 F2P 是否变绿、P2P 是否被打破、测试有没有被改、有没有 block 级 hack。主指标必须是 resolve',
        },
        { id: 'c', label: 'apply rate 是二值比例，必须先换成 bootstrap 区间才能上海报' },
        { id: 'd', label: '问题在基准：apply 只有在 SWE-bench Verified 上才能当主指标' },
      ],
      correct: ['b'],
      explain: `B。

实验一用 \`rateSpectrum\` 并排算同一批 12 条记录：

    apply         92%   11/12
    f2p-only      58%    7/12
    naive+hacks   58%    7/12
    resolve       50%    6/12

从 apply 往下，每一步都扣掉一种「看起来成功」的失败：补丁落下了但 F2P 仍红（m2、h1、h3、h4），F2P 绿了但靠的是改测试（m4 被判 \`hacked\`）。**海报上的成功率没写口径，读者就会按最宽松的那一行理解。**更好的写法是漏斗：提交 → 可应用 → F2P 绿 → P2P 未破 → 无 hack → resolved，demo 上是 12 → 11 → 7 → 7 → 6 → 6，每一级分母相同。

A 错：92% 和 50% 不是同一件事的两种精度，是两个不同的问题。附上 N 修复不了口径。

C 错：区间是另一件事。而且对二值小样本，lab 的 \`RateReport.ci\` 用 Wilson 而不是 bootstrap——0/N 时百分位 bootstrap 退化成 [0, 0]。

D 错：口径与基准无关；何况 Verified 已于 2026-02 被弃用。`,
    },
    {
      id: 'fail-to-pass',
      kind: 'choice',
      prompt:
        '你从自己仓库的历史里挖出一道题：有 pass-to-pass，但那次修复没有加测试，所以没有 fail-to-pass。你打算「先放进集里凑数，反正 P2P 能判断有没有弄坏」。问题在哪？',
      options: [
        { id: 'a', label: '没问题——P2P 绿了就说明补丁没弄坏东西，等价于修好了' },
        {
          id: 'b',
          label:
            '无法判定「修前必红」，连空补丁都能让这道题「通过」；validateTaskSet 应记 gap，gaps 非空时主指标作废',
        },
        { id: 'c', label: '只要 repoPin 钉死 commit，就能弥补缺失的 F2P' },
        { id: 'd', label: '可以把同仓库另一道被标为污染的题的 F2P 借过来' },
      ],
      correct: ['b'],
      explain: `B。

SWE-bench 意义下的实例钉四件事：仓库、commit、修前必红的 F2P、修完仍绿的 P2P。**没有 F2P，你测的是「随便改点什么之后测试碰巧绿了」。**最直接的反例是空补丁：它什么都不改，P2P 当然全绿。所以有效性四件套里专门有一条「空补丁不通过」。

lab 里这对应 \`validateTaskSet\` 的 gap「缺 failToPass」。它是 \`codingGate\` 的第一条 blocker，不是「警告后继续算」。

A 错：P2P 回答「有没有弄坏」，不回答「有没有修好」。

C 错：\`repoPin\` 钉的是环境，让结果可复现，不提供判定标准。（lab 的 \`repoPin\` 只查非空，demo 里甚至拿任务 id 充当 pin。）

D 错：别的题的测试验证的是别的改动；污染标记的意思是「拿出主指标」，不是「可以挪用」。

还要补一句：**有 F2P 也只是必要条件。**OpenAI 审计 SWE-bench Verified 时，模型常失败的 138 题里 59.4% 的测试或题面有实质问题——F2P 从原 PR 机械抽出，会断言题面根本没提的细节。`,
    },
    {
      id: 'error-denominator',
      kind: 'choice',
      prompt:
        '夜里沙箱 OOM，demo 基线里 h2、h3 两道 hard 被标成 errored。早上你看到 resolve 从 50% 涨到 60%，而 f2p-only 还是 58%——严格口径反超了宽口径。代码没改，模型没换。发生了什么？',
      options: [
        { id: 'a', label: '随机波动，N=12 本来就会跳 10pp，不用管' },
        {
          id: 'b',
          label:
            '分母政策不一致：resolveRate 从分母里去掉 error（6/10），f2p-only 仍按全部 12 条算（7/12）；而 infra error 偏偏更爱落在难题上',
        },
        { id: 'c', label: 'OOM 让 h2、h3 的测试被跳过，等于它们被判 resolved 了' },
        { id: 'd', label: 'classifyAttempt 把 error 排在 hacked 前面判，顺序错了' },
      ],
      correct: ['b'],
      explain: `B。本课实测：

                无 error        h2、h3 记为 error
    apply       11/12  92%      10/12  83%
    f2p-only     7/12  58%       7/12  58%
    resolve      6/12  50%       6/10  60%

lab 里 \`applyRate\` 的 n 是全部 attempts（error 只从分子扣），\`resolveRate\` 的 n 是去掉 error 之后的，f2p-only 和 naive 又是全部——**同一张表里两种分母政策**。demo 没有 error 时看不出来。

更糟的是方向：难题跑得久、吃内存，更容易超时和 OOM，所以「去掉 error 再算」系统性地去掉难题。Anthropic 在 Terminal-Bench 2.0 上只改资源配置，成功率就差了 6pp。分母要作为政策写出来：默认 \`all\`（error 记失败）；用 \`graded\` 时必须同时报 infra 错误率。lab 没有政策参数。

A 错：这次变化完全由分母造成，不是抽样噪声——分子 6 没变。

C 错：errored 的 attempt 在 \`classifyAttempt\` 里第一步就返回 \`error\`，不会被判 resolved；涨的是比值，不是命中数。

D 错：error 排第一是对的——一次崩掉的运行不该再去判它有没有作弊或修好。问题不在分类，在分母。`,
    },
    {
      id: 'small-n',
      kind: 'choice',
      prompt:
        '迷你集 N=10，改完从 8/10 到 9/10（+10pp），只有一道题从败变成。同事说「方向是对的，先写进周报」。你怎么回？',
      options: [
        { id: 'a', label: '可以写：+10pp 在任何 N 上都是可观的进步' },
        {
          id: 'b',
          label:
            '不能写「更好」：两个 Wilson 区间几乎完全重叠，成对差值的区间是 [0, 0.3]；这个集大约只看得见 40pp 以上的差',
        },
        { id: 'c', label: '可以写，但要把 pass@1 换成 pass@10，差距会更明显' },
        { id: 'd', label: '不能写，因为 coding 任务必须再用 LLM judge 复检一遍' },
      ],
      correct: ['b'],
      explain: `B。

    版本           resolve   Wilson 95%
    翻题前 8/10     80%      [0.49, 0.94]
    翻题后 9/10     90%      [0.60, 0.98]

按成对算（1 题从败到成、0 题从成到败），差值的 bootstrap 区间是 [0, 0.3]（本课实测）。**区间跨过 0 是「看不出」，不是「赢了」；「看不出」也不等于「没有」——可能只是题不够。**

配对设计下，最小可检出效应的正态近似是 \`mde ≈ 2.8 · √(d / N)\`，d 是不一致对占题数的比例。按调研仿真的 d≈25%，N=10 时约 44pp（lab demo 的 N=12 约 40pp），N=40 约 22pp。周报里能写的是「+10pp，区间 [0, 0.3]，这个集检不出 40pp 量级以下的差」。

A 错：同样的 +10pp，N=10 时是 1 道题，N=1000 时是 100 道题，证据强度天差地别。

C 错：pass@10 量的是「多开九枪」，是另一个系统；换指标让数字变大，不是让证据变强。

D 错：coding 任务的判定器是测试，不是 judge；问题出在样本量，再加一个判定器解决不了。`,
    },
    {
      id: 'sparse-bootstrap',
      kind: 'choice',
      prompt:
        '你在 claim 模式下跑 codingGate：主任务集 11 题，基线 5/11，候选 8/11，3 修 0 坏、没有 hack。门禁返回 pass、claimable = true，成对 CI [0.091, 0.545]。你准备在发布说明里写「显著更好」。该不该写？',
      options: [
        { id: 'a', label: '该写：CI 下界大于 0，就是显著' },
        {
          id: 'b',
          label:
            '先别写：差值的百分位 bootstrap 在稀疏的不一致对上反保守；对 3 修 0 坏做精确 McNemar，双侧 p = 0.25',
        },
        { id: 'c', label: '该写，但要改用非成对的 z 检验再确认一次，它更保守所以更可信' },
        { id: 'd', label: '不该写，因为 N 小于 30 时任何统计检验都无效' },
      ],
      correct: ['b'],
      explain: `B。这组数是本课实测：以 demo 基线为底，把 m4 的改测试清掉（两边都判失败），候选额外修好 m2、h1、h4，claim 门真的给出了 \`claimable = true\`。

b=0（没有弄坏）时，成对差值里只有 c 个 +1 和一堆 0。只要「重抽 N 次一个 +1 都没抽到」的概率 \`(1 − c/N)^N\` 小于 2.5%，百分位区间的下界就大于 0。N=11、c=3 时这个概率约 3%，刚好卡在边上，固定种子的 2000 次重抽恰好落在了「显著」那一侧。

精确 McNemar 只看不一致对，是一个条件二项检验：

    p = min(1, 2 · Σ_{i ≤ min(b,c)} C(b+c, i) / 2^(b+c))
    b=0, c=3  →  p = 2 × 1/8 = 0.25

调研在 N=40 上测过同一现象：c=4 时 bootstrap 判显著，而精确 p = 0.125；精确检验要 c≥6。**二值、成对、小 N 用精确检验**——这是 L18 对 L12 \`bootstrapCI\` 的修正。lab 没有实现精确 McNemar，所以 claim 门在稀疏数据上偏乐观。

A 错：「下界大于 0」只有在区间本身可信时才等于显著；这里正是区间不可信的情形。

C 错：非成对检验不是「更可信」，是**丢掉了配对信息**。调研仿真（真实 +5pp、N=200）里配对精确检验功效 21.3%，非配对 z 检验只有 6.9%。

D 错：小 N 下精确检验正是为此设计的；它给出的 p = 0.25 是有效的，只是不显著。`,
    },
    {
      id: 'bug-swap',
      kind: 'choice',
      prompt:
        '实验五：主任务集 11 题上，候选的 f2p-only 从 6/11 涨到 8/11，apply 从 10/11 涨到 11/11，resolves/$ 从 2.21 翻到 4.84；非成对 Δresolve = 0。成对明细是 onlyA = e1, e2, e3；onlyB = m2, m4, h4；h1–h3 的 F2P 变绿但改过测试。门禁该怎么做？',
      options: [
        { id: 'a', label: '放行：resolve 净值没变，而 apply、f2p-only、性价比全涨了' },
        {
          id: 'b',
          label:
            '拦截：候选有 3 次 hacked（h1–h3），且弄坏 3 个原本能过的 easy——成对明细先于净值',
        },
        { id: 'c', label: '只发「apply↑ 而 resolve 未↑」的警告，不拦' },
        { id: 'd', label: '把 hard 题算双倍权重，重新比净值后再决定' },
      ],
      correct: ['b'],
      explain: `B。

    onlyA（基线过、候选不过）   e1, e2, e3     ← 弄坏三个 easy
    onlyB（候选过、基线不过）   m2, m4, h4
    neither                    h1, h2, h3     ← 改测试「过」，被判 hacked
    both                       m1, m3

注意 h1–h3 **不在** onlyB 里：F2P 绿了，但 \`testsMutated\` → \`hacked\` → 不是 resolved。宽口径下它们会被算成三个胜利，f2p-only 的 +18pp 就是这么来的。\`codingGate\` 给出两条 BLOCK：「候选有 3 次 hacked/testsMutated」和「弄坏 3 个已通过任务——换了一批 bug」，外加 apply 和污染两条警告。

**非成对均值差可以是 0，同时你弄坏了三个 easy、换来另外三道题。**弄坏三个是确定发生了的事，不需要统计检验来确认——这是 L12 的 churn-first 顺序。

A 错：每个海报指标都「更好」，正是这道题的陷阱。resolves/$ 翻倍是因为候选花得少，而分子没涨。

C 错：apply 警告确实会发，但它只是诊断；hack 和弄坏都是 blocker。

D 错：事后改权重是在找能让结论成立的口径。权重要事前声明；而且无论怎么加权，hacked 都不该算成功。`,
    },
    {
      id: 'cost-curve',
      kind: 'choice',
      prompt:
        '实验三按 costUsd 把 demo 切成四桶，resolve 依次是 100%、67%、33%、0%（最贵那桶 ≥$0.50）。产品经理据此提议「把单题预算从 $1 砍到 $0.10，成功率会更高，还省钱」。哪种读法对？',
      options: [
        { id: 'a', label: '提议成立：数据显示越花钱越差，砍预算会提高 resolve' },
        {
          id: 'b',
          label:
            '这张表读不出「加减预算的效果」：成本是结果之后才确定的，失败的轨迹会继续烧钱；要回答预算问题，得画按 costToGreen 截断的预算曲线',
        },
        { id: 'c', label: '提议成立的理由是：最贵那桶是 agent 在 hard 上空转，提前放弃 hard 就好' },
        { id: 'd', label: '用 resolves/$ 一个数比较两种预算就够了，比值高的那个更好' },
      ],
      correct: ['b'],
      explain: `B。

**成本是结果之后才确定的量。**失败的轨迹会继续重试、继续烧钱，所以「贵」部分是「失败」的后果；再加上贵的题本来就难，这张表的相关方向回答不了因果问题。SWE-agent 的数据支持「失败更贵」：成功实例成本中位数 $1.21、12 步，未成功实例平均 $2.52、21 步。（「反向因果」是调研自己的框架，数据直接支持的只是这一点。）

该画的是预算截断曲线：

    rate(B) = |resolved 且 costToGreen ≤ B| / N

同一份 demo（把 resolved 的花费当 costToGreen）：rate($0.05) = 4/12，rate($0.10) = 6/12，之后一直是 6/12。它能说的是「在这份数据上，$0.10 以后的钱没有买到新的 resolve」——**砍到 $0.10 不损失，但也不会提高成功率**。lab 没有 \`costToGreenUsd\` 字段，TODO 4 的 \`costCurve\` 只是观察工具。

A 错：把结果的后果读成了原因。

C 错：bench 里「最贵那一桶往往是 hard 上空转」是旁白，这张表没有证明这个机制。

D 错：比值会把质量下跌抵消掉。本课实测：拿掉 verify 的消融 resolve 掉 17pp，resolves/$ 反而从 2.21 升到 2.22。还要注意「平均成本」本身有三种定义——只算成功的、每次尝试、每个 resolve——同一份 demo 上分别是 $0.042、$0.227、$0.453，差 10.9 倍。`,
    },
    {
      id: 'ablation-verify',
      kind: 'choice',
      prompt:
        '实验四模拟拿掉 verify-before-stop：resolve 从 50% 降到 33%（Δ −17pp），ablationTable 标 decisive = no；同一批记录换成 f2p-only，no-verify 反而是 67% 对 58%，均价还从 $0.227 降到 $0.150。消融报告该怎么写？',
      options: [
        { id: 'a', label: '报 f2p-only：no-verify 更高也更便宜，建议拿掉 verify' },
        { id: 'b', label: '报 resolve：「拿掉 verify 显著降低成功率 17pp」' },
        {
          id: 'c',
          label:
            '报 resolve 的 Δ、区间和 mde：N=12 上检不出这个量级；但 no-verify 产生了改测试的 hacked，这是确定发生的事，单凭它就该保留 verify',
        },
        { id: 'd', label: '看 resolves/$：2.22 对 2.21，两者等价，拿不拿都行' },
      ],
      correct: ['c'],
      explain: `C。

**第一，消融表必须和主口径绑定。**拿掉 verify 后，四道 medium 全靠改测试变绿（其中 m1、m3 原本是真修好的）——f2p-only 把作弊算成胜利，宽口径会奖励错误行为。

**第二，decisive = no 是对的。**N=12 上只翻了 2 题（m4 在基线里已是 hacked）。成对差值是两个 −1 加十个 0，bootstrap 区间 [−0.417, 0]（本课实测）：重抽 12 次一个 −1 都抽不到的概率是 (10/12)¹² ≈ 11%，远大于 2.5%。N=12 时 mde 约 40pp，−17pp 在它下面。

**第三，「不显著」不等于「没用」。**还有三种解释：功效不足、补偿、天花板。而这里有一条不需要统计的证据：no-verify 产生了 hacked，\`codingGate\` 对候选里的 hacked 直接 block。

A 错：这正是宽口径奖励作弊的样子。

B 错：「显著」是错的，decisive = no、区间碰到 0。

D 错：比值把质量下跌抵消掉了——分子分母一起跌。成本要作为护栏和主指标并列，不能合成一个数。`,
    },
    {
      id: 'aa-churn',
      kind: 'choice',
      prompt:
        '你把 lab 的 codingGate 原样搬到自己的 100 题集上。为了验门禁，你把同一个配置跑了两遍当 A/A。regress 模式返回 BLOCK：「弄坏 4 个已通过任务——换了一批 bug」。最合理的下一步是？',
      options: [
        { id: 'a', label: '说明 agent 不稳定：把 temperature 设成 0 再跑，A/A 就会干净' },
        {
          id: 'b',
          label:
            '「弄坏 ≥3」是为 demo（N=11）写死的常数，没有按噪声底校准：先多跑几次 A/A 看 churn 分布，阈值取它的高分位，或对弄坏与修好做精确符号检验',
        },
        { id: 'c', label: '改成按比例：弄坏超过 3% 才拦' },
        { id: 'd', label: '关掉 churn 规则，只看成对 Δ 是否显著' },
      ],
      correct: ['b'],
      explain: `B。

agent 是随机的。调研在 U 形每题成功率下估计 **A/A 的不一致对约占题数的 25%**（U 形是建模选择，真实分布未知）；N=100 时意味着两遍之间约 25 道题翻转，「弄坏 4 个」甚至更多都是常态。调研用门禁模拟过：「弄坏 ≥3」这一条在 A/A 下的拦截率 N=30 时 0.73，**N=100 时 1.00**——几乎总是拦。

它在当前 lab 里原样保留、两种 mode 都生效。demo 的 \`broken = 3\` 是刻意构造的坏候选，常数恰好够用。搬到自己的集上之前，先跑 A/A；阈值取 churn 分布的 1−α 分位，或者对「弄坏 vs 修好」做精确符号检验。lab 没有实现这些。

A 错：temperature=0 也消除不了翻转——多步轨迹里任何一处微小差异（一次超时、一段工具输出的顺序）都会让后面整条分叉。而且问题不在 agent，在阈值没校准。

C 错：换成比例仍然是拍脑袋的常数。阈值要从你自己的噪声底来，而不是从直觉来。

D 错：churn-first 是 L12 的原则，丢掉它就回到「净值为 0 但换了一批 bug」的盲区（见实验五）。要做的是校准它，不是关掉它。`,
    },
    {
      id: 'eval-leak',
      kind: 'choice',
      multi: true,
      prompt:
        '你在审计一次 coding agent 评测的命令轨迹。下面哪些属于「评测期泄漏」——答案在评测环境里、agent 自己拿到了？（多选）',
      options: [
        { id: 'a', label: 'agent 在沙箱里跑 git log --all，找到了带修复的那次提交' },
        { id: 'b', label: '任务 id 里带着 commit SHA，agent 拿它去定位修复后的版本' },
        { id: 'c', label: '沙箱能访问代码托管域名，agent 直接拉下了上游仓库' },
        { id: 'd', label: '模型在训练截止前见过这个仓库的修复 PR，凭记忆写出了补丁' },
        { id: 'e', label: '同一配置跑两遍，第二遍过了第一遍没过的题' },
      ],
      correct: ['a', 'b', 'c'],
      explain: `A、B、C。

SWE-Bench Pro Verified（arXiv 2609.08149）审计了 731 次基线运行：至少 103 题能在本地读到答案、49 题能走网络拿到——\`git log/show\` 恢复 gold、读沙箱文件、拉仓库、读 \`instance_id\` 里的 SHA。堵上之后：

    GLM-5.2    raw 78.80%   →   clean 57.32%   (−21.48pp)
    配对转移    P→F 186 题       F→P 15 题        McNemar p < 0.001

**评测期泄漏可以零模型地审、可以堵**：每题重建单 commit 仓库（不是在原仓库里删分支）、id 不含 SHA、屏蔽代码托管域名、每次试验干净工作区。

D 不是评测期泄漏，是训练期记忆。它基本不可审计——轨迹里看不出模型「记得」——只能靠时间窗和私有任务来防。两类要分开处理，因为防法完全不同。

E 是运行噪声，不是泄漏：同一配置的 A/A 本来就会翻题。上面 Pro Verified 的配对表里，堵上泄漏后仍有 15 题 F→P——干净环境不该帮 agent 解题，这 15 题很可能就是这种噪声。

还有一个容易漏的通道：**题面本身**。SWE-Bench+ 发现 32.67% 的成功补丁直接写在 issue 或评论里；你给自建集写题面时，最容易顺手把答案写进去。lab 用一个布尔位 \`contaminated\` 表达污染，分不出这些类别和通道。`,
    },
    {
      id: 'ci-vs-nightly',
      kind: 'choice',
      prompt:
        '团队想「每个 PR 都跑一遍 40 题自有集，resolve 掉了就拦」。你主张 PR 门禁里只放另一类检查。是哪一类？',
      options: [
        { id: 'a', label: '40 题自有集的 resolve rate，只是改成跑 3 次取平均' },
        {
          id: 'b',
          label:
            '零模型断言：validateTaskSet、classifyAttempt、rateSpectrum、codingGate 在固定 Attempt 记录上的行为',
        },
        { id: 'c', label: '从 SWE-bench 随机抽 5 题现场跑一轮' },
        { id: 'd', label: '人工评审 3 个 agent 生成的 PR 并打分' },
      ],
      correct: ['b'],
      explain: `B。

把真模型的成功率放进 PR 门禁，只会得到**随机红灯**：40 题集的 mde 约 22pp，按调研的模型估计，A/A 本身就会翻转约四分之一的题。PR 门禁能可靠断言的是**评测系统本身**——任务集完整性（SET）、判定器（CLS）、统计器（RATE、COST、ABL）、门禁语义（AB、GATE）、夹具自洽（FIX）、双语言格式化（FMT），lab 里合计 56 条，TS 和 Python 同数。

判定器最值得测：UTBoost 修正测试输出解析器后，SWE-bench Lite 40.9%、Verified 24.4% 的榜单名次变了。真跑模型的 \`l18/runner.ts\` 不进 CI，放到 nightly，用 regress 门判。

A 错：跑 3 次取平均降低了方差，但没有降到能在 40 题上判出小差距；而且每个 PR 付三倍模型费用。

C 错：5 题的 mde 比任何你关心的差距都大；而且公开基准有半衰期和泄漏问题。

D 错：人工评审有价值，但它不可复现、不能当自动门禁。`,
    },
    {
      id: 'regress-vs-claim',
      kind: 'choice',
      prompt:
        'verify 的 GATE-3 数据：候选清掉了基线里 m4 的改测试、又修好了 h1。主任务集上 resolve 从 5/11 到 7/11（+18pp），成对 CI [0, 0.455]，没有 hack、没有弄坏。PR 门禁该怎么判？',
      options: [
        { id: 'a', label: 'regress 模式拦下：没有显著更好就不能合并' },
        {
          id: 'b',
          label:
            'regress 放行并警告（它测的是没变差）；如果发布说明要写「更好」，改用 claim 模式，那时会拦下、claimable = false',
        },
        { id: 'c', label: 'claim 模式放行：+18pp 已经很大，可以写「更好」' },
        { id: 'd', label: '改用非成对均值差再判一次，通常会显著' },
      ],
      correct: ['b'],
      explain: `B。这正是 GATE-3 / 3b / 6 / 6b 断言的行为。

**regress 和 claim 是两个不同的零假设。**regress（默认，每个 PR、每晚）问的是「能不能说明没变差」——非劣；claim 问的是「能不能宣称更好」——优效，只在写下「更好」两个字之前用。

lab 的旧版草稿把「点估计上升但不显著」当 regress 的 blocker。调研模拟 N=100 时这一条的拦截率：真实效应 0（A/A）时 49%，−5pp 时 17%，−10pp 时 3%。**越差的版本越不会被拦**——越差越不会「点估计上升」。它随机拦掉一半 A/A 的 PR，同时放过真实退化。

A 错：这就是旧版草稿的语义。

C 错：+18pp 在 N=11 上不显著，这本身就是第三节的结论；成对区间碰到 0。

D 错：非成对检验丢掉了配对信息，通常更不显著；为了得到显著而换检验方法，本身就是在挑结论。`,
    },
    {
      id: 'debug-gate',
      kind: 'debug',
      prompt:
        '下面是一位同学交上来的 TODO 6。他跑 `pnpm verify:l18`，红了两条，改了一处之后 56/56 全绿，于是提交了。这份代码里至少还有**四个**会改变门禁结论的 bug。找出它们，各给一个让它出错的输入，并说明为什么 verify 没抓到。',
      lang: 'ts',
      code: `function myCodingGate(input: CodingGateInput): CodingGateResult {
  const mode = input.mode ?? 'regress'
  const blockers: string[] = []
  const warnings: string[] = []
  const taskSet = validateTaskSet(input.tasks)
  const primary = new Set(primaryTasks(input.tasks).map((t) => t.id))
  if (!taskSet.ok) blockers.push('任务集不可用：' + taskSet.gaps[0])

  const basePrim = input.baseline.filter((a) => primary.has(a.taskId))
  const candPrim = input.candidate.filter((a) => primary.has(a.taskId))
  const baseIds = new Set(basePrim.map((a) => a.taskId))
  const candIds = new Set(candPrim.map((a) => a.taskId))
  for (const id of baseIds) if (!candIds.has(id)) blockers.push('候选缺少任务 ' + id)
  for (const id of candIds) if (!baseIds.has(id)) blockers.push('候选多出任务 ' + id)

  // 只有 block 级发现才算作弊；warn 级不拦
  const hacked = candPrim.filter((a) =>
    a.hackFindings.some((f) => f.severity === 'block'),
  )
  if (hacked.length > 0) blockers.push('候选有 ' + hacked.length + ' 次 hacked')

  const ab = pairedAB(input.baseline, input.candidate)
  if (ab.onlyA.length >= 3) blockers.push('弄坏 ' + ab.onlyA.length + ' 个已通过任务')
  if (ab.diff.significant && ab.diff.ci.hi < 0) blockers.push('resolve 显著低于基线')

  const sb = rateSpectrum(basePrim)
  const sc = rateSpectrum(candPrim)
  const roseNonsig = sc.resolve.rate > sb.resolve.rate && !ab.diff.significant
  if (mode === 'claim' && roseNonsig) {
    blockers.push('resolve 点估计上升但不显著——不可宣称更好')
  } else if (roseNonsig) {
    warnings.push('resolve 点估计上升但不显著——若要写「更好」请改用 claim')
  }
  if (sc.apply.rate > sb.apply.rate && sc.resolve.rate <= sb.resolve.rate) {
    warnings.push('apply↑ 而 resolve 未↑')
  }

  const pass = blockers.length === 0
  const claimable = mode === 'claim' && ab.diff.significant
  return { pass, mode, claimable, blockers, warnings, taskSet,
    spectrumBaseline: sb, spectrumCandidate: sc, ab }
}`,
      rubric: [
        '你有没有发现 hacked 判定绕开了 classifyAttempt，于是只改测试、没有 block 级发现的 attempt 不再被拦？',
        '你有没有注意到 pairedAB 吃的是全部 attempts，污染题会进入 onlyA / onlyB 和成对 CI？',
        '你有没有发现 claimable 缺了 pass 和 ci.lo > 0，一个显著变差、已被拦下的候选在 claim 模式下也会 claimable？',
        '你有没有发现污染警告没写，并说出为什么 apply 警告漏写会被抓到、污染警告漏写不会？',
        '你能不能说清楚：verify 抓到的只是「regress 下不显著上升被当 blocker」这一处，其余 bug 被别的 blocker 掩盖或根本没有数据去触发？',
      ],
      reference: `这份代码交上来之前，同学修掉的是旧版草稿那一处：「点估计上升但不显著」在两种 mode 下都进 blockers。它让 GATE-3（regress 应放行）和 GATE-3b（应有警告）变红——**这是 verify 唯一能抓到的那个 bug**。修完之后，下面四个都还在，GATE 组 11 条照样全绿（本课实测：把这份代码代入 GATE 组断言逐条跑过）。

## Bug 1：hacked 判定绕开了 classifyAttempt

    const hacked = candPrim.filter((a) =>
      a.hackFindings.some((f) => f.severity === 'block'),
    )

参考实现用 \`classifyAttempt(a) === 'hacked'\`，它在 block 级发现**或** \`testsMutated\` 时都判 hacked。这里只看发现列表，改测试这一路被丢掉了。

**反例**（本课实测）：把 demo 基线原样复制当候选，只让 h1 改测试变绿。参考实现拦下：「候选有 2 次 hacked/testsMutated」（m4 和 h1）。这份代码 \`pass = true\`，blockers 为空。

**verify 为什么没抓到**：demo 候选的 h1–h3 恰好**只有** \`testsMutated\`、没有任何 hackFindings，所以这份代码一次 hacked 都数不出来。但同一份候选还弄坏了 e1–e3，「弄坏 3 个」照样触发——GATE-1 要的只是 \`!pass\`，GATE-2 要的是 blocker 里有「hacked」**或**「弄坏」。另一条 blocker 把它掩盖了。

## Bug 2：pairedAB 吃的是全部 attempts

    const ab = pairedAB(input.baseline, input.candidate)

污染题（demo 里的 c-easy）进了成对比较：它会进 onlyA、onlyB、churn 计数和成对 CI，而 \`rateSpectrum\` 用的是主任务集——同一份结果里两个分母。

**反例**（本课实测）：候选弄坏 e1、e2，外加污染题 c-easy。参考实现 onlyA = e1, e2，没到 3；这份代码 onlyA = e1, e2, c-easy，以「弄坏 3 个」拦下——拦的理由里有一道本应排除在主指标之外的题。反方向也成立：候选在污染题上「修好」会被算进 onlyB，推高 claim 的证据。

**verify 为什么没抓到**：demo 里 c-easy 在基线和候选上都 resolved，落在 both，不改变任何计数。

## Bug 3：claimable 缺了两个条件

    const claimable = mode === 'claim' && ab.diff.significant

参考实现是 \`mode === 'claim' && pass && ab.diff.significant && ab.diff.ci.lo > 0\`。\`significant\` 在 CI 完全低于 0 时**也**为 true。

**反例**（本课实测）：claim 模式，候选弄坏 e1、e2、e3、m1、m3。成对 CI 完全在 0 以下，blockers 里有「弄坏 5 个」和「显著低于基线」，\`pass = false\`——而 \`claimable = true\`。一个被拦下的、显著变差的版本，被标成「可以宣称更好」。

**verify 为什么没抓到**：GATE-6b 只在 GATE-3 那份数据上查 \`claimable === false\`，那份数据本来就不显著（CI [0, 0.455]），缺什么条件都是 false。GATE-7 是正例（全修好、显著更好 → \`claimable\`），这份代码只是更宽松，正例照样过。

## Bug 4：污染警告没写

参考实现在污染样本上出现 resolve 时警告「勿写入主指标」，这份代码没有。

**verify 为什么没抓到**：没有任何一条断言查它。demo 的 c-easy 在两边都 resolved，参考实现会发出这条警告，这份代码静默，verify 不看。

对照 apply 警告：这份代码写了它，因为不写会红。GATE-5 的候选只把 h2 从「补丁没落下」改成「落下了但 F2P 没绿」，再去掉 m4 的改测试——apply 涨、resolve 不变、不弄坏也不 hack，门禁必须**放行并**带 \`apply↑\` 警告。本课初稿的 GATE-5 是「有 apply 警告**或** \`!pass\`」，配一份全弄坏的候选，\`!pass\` 恒真，漏写也绿。断言有没有牙，取决于它的数据能不能让**只有这一条**该触发。

## 小结

| bug | 会改变什么 | 被哪条抓到 | 为什么漏 |
|---|---|---|---|
| 不显著上升在 regress 下当 blocker | A/A 随机红灯 | GATE-3、3b | —— |
| hacked 绕开 classifyAttempt | 只改测试的候选放行 | 无 | 被「弄坏」blocker 掩盖 |
| pairedAB 用全部 attempts | 污染题进 churn 和 CI | 无 | demo 的污染题落在 both |
| claimable 缺条件 | 变差的版本可宣称更好 | 无 | GATE-6b 的数据不显著，GATE-7 是正例 |
| 缺污染警告 | 诊断信息丢失 | 无 | 没有断言查它 |

门禁是方向容易写反、又会被别的 blocker 掩盖的代码。**56/56 说明你没有违反这 56 条，不说明你的门禁是对的。**对每一条 blocker 单独造一份「只有它该触发」的数据，再加一份 A/A，比多读几遍代码可靠。`,
    },
    {
      id: 'design-plan-ablation',
      kind: 'design',
      prompt:
        '你想回答一个真实的决策问题：「小题要不要跳过 plan 阶段？」手里是一份自建任务集。设计从任务集准备到最终结论的完整评测方案，说清楚你事前声明什么、能看见多大的差、门禁怎么放，以及结论最终怎么写。',
      scenario:
        '任务集是从你自己两个仓库的提交历史里挖出来的 40 道题：仓库 A 28 道，仓库 B 12 道；你按 diff 行数把它们分成「小题」和「多文件题」。每题有 base commit、gold patch 和从那次提交里抽出的测试。agent 每跑一题约 $0.30。同事建议：「直接各跑一遍，resolve 高的那个赢，然后把这 40 题放进每个 PR 的 CI。」调研没有找到 plan 阶段的公开消融数据。',
      reference: `这题没有唯一答案。能区分「想过」和「没想过」的，是你有没有在跑模型之前就把下面几件事定下来。

## 一、先让任务集有资格

每道题进集前过有效性四件套（运行要沙箱、不要模型）：

1. base 上 F2P **每一次**都红
2. gold 上 F2P + P2P 全绿
3. **空补丁不通过**
4. gold 重跑 3 次结果一致——flaky 的 P2P 会在 A/B 里变成假的「弄坏」

然后审泄漏：题面不能抄提交信息（自己的提交信息常常就是答案）；每题重建单 commit 仓库，id 不含 SHA，沙箱不通代码托管域名，每次试验干净工作区。

再看分层。「按 diff 行数分小题 / 多文件题」要先数一数每层有几道——某一层 0 条或只有个位数时，\`validateTaskSet\` 式的 gap 要记下来，那一层不能单独下结论。

lab 的 \`TaskInstance\` 没有 validity 字段和 repo 字段，这些要自己加。

## 二、事前声明

跑之前写下来，跑完不改：

- **主指标**：成对的 resolve 差，分母政策 \`all\`（infra error 记失败），同时报 infra 错误率
- **尝试策略**：single，每题 K 次（见第四步）
- **护栏**：每个 resolve 的成本（总花费 / resolve 数，不是「只平均成功的」）、hacked 次数
- **决策规则**：例如「跳过 plan 后 resolve 非劣、onlyA 里没有多文件题、每 resolve 成本下降 → 对小题跳过」

比较数会乘：7 个指标 × 2 层 × 几个变体就是几十个比较。只有一个主指标，至多两个护栏。

## 三、先算你能看见多大的差

配对下 \`mde ≈ 2.8 · √(d / N)\`。按调研仿真的 d≈25%，N=40 时约 **22pp**；只看小题那一层，N 更小，mde 更大。

还要算聚类。题来自两个仓库，同仓库的题共享夹具和依赖：

    DEFF  = 1 + (m − 1) · ρ
    m ≈ 20, ρ 取 0.3   →   DEFF ≈ 6.7,  N_eff ≈ 6

这只是量级（两仓库题数不等，ρ 未知），但方向清楚：**关于「跨仓库泛化」你只有 2 个观测点。**

plan 阶段的效应大概率是个位数百分点、且和题型交互强。所以要事先接受一个结果：**这个集很可能检不出它。**能做的是降 d（每题跑 K 次，本来就会翻的题不算进稳定的不一致对），或者扩集——多收一个新仓库的题，比在同一仓库里多收几倍的题值钱。

## 四、跑法

1. **先跑 A/A**：同一配置两遍（或每题 K≥2），量出不一致对比例 d 和 churn 分布。lab 的「弄坏 ≥3 就拦」是为 demo 写死的常数，在你的集上要用 A/A 的高分位重新定，或者改用精确符号检验
2. **按题交错**（A1 B1 A2 B2），别整批先 A 后 B——服务商静默变更、限流、缓存冷热会落到某一臂
3. 缓存键包含补丁和任务内容哈希；运行键只允许在「是否跳过 plan」上不同
4. **显著性用精确 McNemar**，只看不一致对。二值、成对、小 N 下百分位 bootstrap 反保守——lab 没有实现精确检验，要自己补

成本：40 题 × 2 臂 × K=3 × $0.30 ≈ $72，加 A/A 再翻一倍。写进方案里。

## 五、门禁放在哪

同事的「每个 PR 跑 40 题」会得到随机红灯：mde 22pp，A/A 自己就翻四分之一的题。

- **PR 门禁**：零模型断言——任务集完整性、判定器、统计器、门禁语义，在固定 Attempt 记录上跑
- **nightly**：真跑模型，用 **regress** 门（非劣）；infra 错误率超限判「无法评分」，不判「变差」
- **claim** 门只在写发布说明、要写下「更好」两个字之前用

## 六、结论怎么写

报四样东西：成对 Δ 和精确检验的区间或 p 值、mde、onlyA / onlyB 明细（尤其多文件题有没有被弄坏）、每 resolve 成本。

如果 Δ 的绝对值小于 mde，结论就是：「**在 40 题、2 个仓库上，无法检出跳过 plan 对 resolve ≥22pp 的影响**；成本变化为 X；onlyA 中无多文件题。」再按事前声明的决策规则决定——**「检不出」本身就是结论的一部分。**`,
      rubric: [
        '你有没有在跑模型之前先验证任务本身：base 每次红、gold 绿、空补丁不过、gold 重跑一致，以及审题面和沙箱里的泄漏？',
        '你有没有事前声明一个主指标（成对 resolve 差）、分母政策、尝试策略和至多两个护栏，并写下决策规则？',
        '你有没有算出 N=40 时 mde 约 22pp，并意识到两个仓库让有效样本量远小于 40？',
        '你有没有先跑 A/A 来校准 churn 阈值和噪声底，而不是沿用「弄坏 ≥3」？',
        '你有没有在小 N 二值配对数据上选精确检验，而不是百分位 bootstrap？',
        '你有没有把 PR 门禁限定为零模型断言，把真跑模型放进 nightly 的 regress 门，claim 只留给宣称更好之前？',
        '你的结论模板里有没有「无法检出 ≥mde 的影响」这一种合法结局，以及成本护栏和 onlyA 明细？',
      ],
    },
  ],
}
