import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L18x',
  questions: [
    {
      id: 'platform-reality',
      kind: 'choice',
      prompt:
        '今天是调研日 2026-10-12。你们组从没在 OpenAI 上跑过微调。产品经理说：「评测集和 grader 都有了，下周用 OpenAI RFT 在 o4-mini 上训一个代码审查 agent。」最准确的回应是哪一个？',
      options: [
        { id: 'a', label: '可以做，而且训出来的模型是我们的资产：基座以后下线，微调模型照样能推理' },
        {
          id: 'b',
          label:
            '这条路走不通：2026-05-07 起，没跑过微调的组织不能创建微调任务；RFT 页写着 currently only for o4-mini，而 o4-mini 与 ft-o4-mini 都在 2026-10-23 下线。OpenAI 的 RFT 与 grader 文档仍可当概念教材',
        },
        { id: 'c', label: '把基座换成 Deprecations 页给 o4-mini 列的替代模型 gpt-5.6-terra，在它上面做 RFT 就行' },
        { id: 'd', label: '改去 Google 的调优服务做强化微调，Gemini 3.5 Flash 支持 RL 调优' },
      ],
      correct: ['b'],
      explain: `B。

调研引用的 OpenAI Deprecations 页（访问于 2026-10-12）给了三个日期：

| 日期 | 生效内容 |
|---|---|
| 2026-05-07 | 从未跑过微调的组织不能创建微调任务 |
| 2026-07-02 | 过去 60 天没在微调模型上跑过推理的组织，不能创建微调任务 |
| 2027-01-06 | 现有活跃客户也不能再创建新任务 |

RFT 指南页顶部写着 "OpenAI is winding down the fine-tuning platform. The platform is no longer accessible to new users"，并且 "currently only for o4-mini"。\`o4-mini-2025-04-16\` 和 \`ft-o4-mini-2025-04-16\` 的下线日期都是 2026-10-23，离调研日 11 天。由此推出（调研的推断，不是 OpenAI 的声明）：OpenAI RFT 对任何新组织都不可用。它的 RFT、grader 文档仍是讲「什么任务适合 RL、grader 怎么写」最清楚的一手材料，**当概念文档读，不当操作指南用**。

A 错：原文是 "Inference on fine-tuned models will be disabled only when the underlying base model is deprecated."，也就是说基座一下线，微调模型就不能推理了。2026-10-23 这一天 \`ft-gpt-4.1-nano-2025-04-14\` 等微调快照整批下线：**微调模型的寿命等于基座的寿命**。

C 错：\`gpt-5.6-terra\` 是 Deprecations 表里给 o4-mini 列的推理替代，调研没在文档里找到 o4-mini 之后的新 RFT 基座。何况你们组是新组织，换哪个基座都建不了任务。

D 错：Google 的调优页只有 SFT（Gemini 3.5 Flash、3.1 Flash-Lite、2.5 系列）和偏好调优（只有 2.5 Flash 与 Flash-Lite），整页没有出现 "reinforcement" 一词。截至调研日，托管 RL 只在 Bedrock 上，支持的是 Nova 2 Lite、gpt-oss-20b、Qwen3 32B。`,
    },
    {
      id: 'two-axes',
      kind: 'choice',
      prompt:
        '公司内部的运维 agent 有两个问题：一是上个月内部计费 API 改了名，agent 还在调旧名；二是它给下游系统吐的 JSON 时好时坏，偶尔多一个字段。同事提议：「攒 500 条线上日志做一次 SFT，两个问题一起解决。」你怎么回？',
      options: [
        { id: 'a', label: '同意。SFT 能同时教会模型新 API 名和稳定格式，一次训练两个问题都解决' },
        {
          id: 'b',
          label:
            '分开处理。API 改名是缺知识，属于上下文轴，放进工具描述或检索；格式不稳是行为问题，属于模型轴。先给格式问题建评测集，试 prompt 和换模型，还不稳再用日志做 SFT',
        },
        { id: 'c', label: '按标准流程来：先 prompt engineering，再 RAG，最后微调；两个问题都从 prompt 开始逐级升级' },
        { id: 'd', label: '用 DPO：新 API 名的调用当 chosen、旧名当 rejected，格式对的当 chosen，一次偏好训练解决' },
      ],
      correct: ['b'],
      explain: `B。

OpenAI《Optimizing LLM Accuracy》给的是两条轴，不是一条阶梯。上下文轴管模型不知道的东西，原文的例子是 "it wasn't in its training set"、"out of date"、"proprietary information"，改了名的内部 API 三条全中，解法是检索和工具描述。模型轴管行为不稳，原文说微调 "maximizes consistency of behavior"，JSON 时好时坏正在这一格。

格式这一侧也不是直接开训：先有评测集和基线（L18），再试 prompt、结构化输出、换模型。Anthropic 的提醒是 "you can sometimes improve latency and cost more easily by selecting a different model"。真要训，用线上日志剪数据正是 OpenAI 说的 "prompt baking"。

A 错：OpenAI 方法表里 SFT 擅长的是分类、特定格式、纠正指令遵循，没有一格是「让模型知道新知识」。API 下次再改名，权重里的旧名就成了要对抗的东西；检索那边只要改一行配置。

C 错：OpenAI 原文反驳的正是这个："Many "how-to" guides on optimization paint it as a simple linear flow ... these are all levers that solve different things"。API 改名这一类问题永远不该走到微调那一级。

D 错：DPO 仍然在模型轴上，调的是偏好，不是知识；托管 DPO 还 "only train on one-turn conversations"。把「新名对、旧名错」做成偏好对，下次改名又要重训。`,
    },
    {
      id: 'signal-budget',
      kind: 'choice',
      multi: true,
      prompt:
        '二值奖励（resolved 记 1，其他记 0），每题 G=8 次独立尝试，用 GRPO 的组内相对优势。下面哪些说法是对的？（多选）',
      options: [
        { id: 'a', label: '单次成功率 p=0.05 的题，只有约 33.7% 的组会产生任何梯度' },
        { id: 'b', label: 'p=0.95 的题和 p=0.05 的题一样，有信号的组也只占约 33.7%' },
        { id: 'c', label: '题越难越值钱：应该优先把 p≈0.01 的题放进 RL 训练集' },
        { id: 'd', label: '把 G 从 8 加到 16，p=0.05 的题有信号的组升到约 56.0%，代价是 rollout 翻倍' },
        { id: 'e', label: '除以组内标准差能让全错的组也产生梯度，难题的信号问题可以靠归一化解决' },
      ],
      correct: ['a', 'b', 'd'],
      explain: `A、B、D。

一组里有方差，当且仅当它既非全错、也非全对：

    P(有信号) = 1 − (1−p)^G − p^G = pass@G − pass^G

| p | G=4 | G=8 | G=16 |
|---|---|---|---|
| 0.01 | 0.039 | 0.077 | 0.149 |
| 0.05 | 0.185 | 0.337 | 0.560 |
| 0.50 | 0.875 | 0.992 | 1.000 |
| 0.95 | 0.185 | 0.337 | 0.560 |

A 对：1 − 0.95^8 − 0.05^8 ≈ 0.337。剩下约三分之二的组，沙箱和 token 照付，梯度为零。

B 对：表对 p 和 1−p 对称。全对的组和全错的组一样优势为零，DAPO 原文："if all outputs ... are correct and receive the same reward, the resulting advantage for this group is zero."

D 对：**组大小是买信号的旋钮**，但它按 rollout 计价。DAPO 每步 512 道题 × 每题 16 个回答，就是 8,192 个 rollout；对 coding agent 那是 8,192 个独立工作区。

C 错：p=0.01、G=8 时只有 7.7% 的组有信号。OpenAI RFT 指南："If a model has a 0% success rate at a given task, you cannot bootstrap to higher performance levels through RFT."；Bedrock 的规则是奖励一直是 0% 就先做 SFT。L18 还提醒过：0% pass@100 最常见的原因是任务坏了。

E 错：全错的组每个奖励都等于均值，分子是 0，除以什么都是 0（实现里还要防分母为 0）。除 std 只放大**已有的**差异，k=1 那次成功从 0.875 变成 2.475；Dr. GRPO 指出它让太易和太难的题权重更高，是一种偏置，不是信号来源。`,
    },
    {
      id: 'screen-bias',
      kind: 'choice',
      prompt:
        '你用 L18 落盘的数据（每题 16 次）给每道题算无偏的 pass@8 − pass^8，把全错和全对的题都去掉，用同一批数据预测：训练集里约 81% 的组会有信号。开训后，TRL 记录的 `frac_reward_zero_std` 一直在 0.25 附近。最合理的解释和处理是什么？',
      options: [
        { id: 'a', label: '`frac_reward_zero_std` 的统计口径有问题，以预测的 81% 为准' },
        {
          id: 'b',
          label:
            '选择偏差：留下的恰好是「这 16 次看起来是混合的」题，其中有运气，同一批样本的预测必然偏乐观。用另一批独立样本估计，并在训练中按批重筛',
        },
        { id: 'c', label: 'G=8 太小。把 G 提到 64，`frac_reward_zero_std` 就会归零' },
        { id: 'd', label: '两端都去掉筛得太狠了，应该只去掉全错的题' },
      ],
      correct: ['b'],
      explain: `B。

\`frac_reward_zero_std\` 是组内奖励标准差为 0 的组占比，0.25 意味着约 75% 的组有信号。这和实验三几乎一样：

    两端都去掉        题数  7   真实有信号占比 0.751
    用同一批样本预测            预测有信号占比 0.813

筛题用的那 16 次样本，同时决定了「留谁」和「估计值是多少」。被留下的题里，有一部分只是这 16 次碰巧有成有败；回到真实 p，它们的组更常全对或全错。lab 的 \`screenTasks\` 把这个偏乐观的 \`expectedSignal\` 记下来而不修正（C05），就是要你知道它偏。

处理：用一批没参与筛选的样本重新估计；训练中途也要重筛，DAPO 每批 "over-sample and filter out prompts with the accuracy equal to 1 and 0"。还有第二个原因会让零方差组随训练增多：模型在变强，DAPO 观察到 "the number of samples with accuracy equal to 1 continues to increase"。

A 错：这个指标就是 TRL 拿来监控这件事的。偏的是你的预测。

C 错：组大小确实能买信号，但真实 p 接近 0 或 1 的题加大 G 也救不回来（p=0.01 时 G=16 也只有 0.149），归零做不到；64 次 rollout 还是 G=8 的八倍成本。它也没有回答「预测为什么偏」。

D 错：实验三里只去掉全错的题，真实有信号占比只有 0.410，因为全对的组和全错的组一样不出梯度。两端筛确实会误杀（p=0.02、0.95、0.98 的题被筛掉），这是要定期重筛的理由，不是只筛一端的理由。`,
    },
    {
      id: 'debug-reward',
      kind: 'debug',
      prompt:
        '下面是一位同学给 GRPO 写的奖励函数和组内优势。他说「resolved 给 1、作弊给 −1、warn 扣分，标准化也做了」。找出至少**五个**会让梯度方向或大小出错的问题，每个给一组让它出错的输入和数字，并对应到 lab 的断言。',
      lang: 'ts',
      code: `function rewardOf(a: Attempt): number {
  if (a.errored) return 0
  if (a.hackFindings.some((h) => h.severity === 'block')) return -1
  let r = a.failToPassGreen ? 1 : 0
  for (const h of a.hackFindings) if (h.severity === 'warn') r -= 0.1
  return r
}

function advantages(group: Attempt[]): number[] {
  const rs = group.map(rewardOf)
  let sum = 0
  for (const r of rs) sum += r
  const m = sum / rs.length
  let ss = 0
  for (const r of rs) ss += (r - m) * (r - m)
  const sd = Math.sqrt(ss / rs.length)
  if (sd === 0) return rs.map(() => 0)
  return rs.map((r) => (r - m) / sd)
}`,
      rubric: [
        '你有没有发现 error 被记成 0 分并留在组里，并说出它惩罚的是哪一类尝试？',
        '你有没有发现 hacked 判定绕开了 classifyAttempt，改了测试但没有 finding 的作弊拿到 +1？',
        '你有没有指出 f2p-only 的基础分让作弊与真解拿到同样的正优势（实验六）？',
        '你有没有发现 warn 扣分没有上限，足够多的误报会把 resolved 压到 applied_only 以下？',
        '你有没有发现这里用的是总体标准差，k=1 时给 2.646 而不是 2.475？',
        '你能不能解释为什么 8 个 0.9 的组 sd 不是 0，以及为什么在 TRL、verl 上看不到这个问题？',
      ],
      reference: `下面每个反例都把这份代码代入实测过（双精度，保留三位）。

## Bug 1：error 记 0 分，并且留在组里

G=8：3 次 resolved、3 次 failed、2 次沙箱超时。

| 实现 | A(成功) | A(失败) | A(超时) |
|---|---|---|---|
| 这份代码 | 1.291 | −0.775 | −0.775 |
| 只把标准差改成样本标准差 | 1.208 | −0.725 | −0.725 |
| 参考：error → null，排除出组 | 0.913 | −0.913 | 不参与 |

两次超时拿到和失败一样的负优势，模型被推离「跑得久」的行为，而跑得久的往往是认真跑完测试套件的那次；成功者的优势也被虚抬。OpenAI grader 的默认就是这样（"will be marked as invalid and return a 0 grade"），TRL 源码专门避开：nansum "would collapse it to 0, which both biases the per-group baseline and hands the completion a spurious advantage."。修法：\`rewardOf\` 返回 \`number | null\`，优势只在非 null 的样本上算。对应 R01、A07、A08。

## Bug 2：hacked 没走 classifyAttempt

\`classifyAttempt\` 在有 block 级 finding **或** \`testsMutated\` 为真时都判 hacked。这份代码只看 finding：改了测试、F2P 变绿、但没有命中任何规则的 attempt 拿到 +1，和真解一样。它带 warn 时还会变成 0.9，R09 要求的「hacked 不叠加扣分」也破了。对应 R05。

## Bug 3：基础分是 f2p-only

\`failToPassGreen ? 1 : 0\` 不看 \`passToPassGreen\` 和 \`patchApplied\`。修好目标测试、顺手弄坏别的测试，也是 1。和 Bug 2 叠加，就是实验六的第一行：2 次 resolved、2 次改测试的 hacked、4 次 failed，组内奖励是 1,1,1,1,0,0,0,0，这份代码给 resolved 和 hacked 同样的 +1.000，failed 是 −1.000。L18 说宽口径会奖励错误行为；评测里它只让海报好看，训练里 RL 以同样的力度强化作弊。修法：标签一律走 \`classifyAttempt\`，只有 resolved 给 1。

## Bug 4：warn 扣分没有上限

    10 条 warn，逐次相减：1.3877787807814457e-16
    11 条 warn，逐次相减：-0.09999999999999987

11 条 warn 的 resolved 比干净的 applied_only（0）还低，检测器的误报就把正确解推成负优势；10 条时连精确的 0 都不是。参考实现减 \`min(warnCap, warnPenalty × n)\`，默认上限 0.3，并拒绝 \`warnCap ≥ 1\` 的策略。对应 R07、R08、R10。

## Bug 5：总体标准差

\`ss / rs.length\` 是总体标准差。G=8、只有 1 次成功：这份代码给成功者 2.646，参考实现（样本标准差，除以 n−1）给 2.475。TRL 的 \`nanstd\` 做 Bessel 校正，verl 用 \`torch.std\`，都是样本标准差。对应 A03。

## Bug 6：用 sd === 0 判「全相同」

8 次全部 resolved、各带 1 条 warn，奖励全是 0.9。顺序累加得 7.200000000000001，均值 0.9000000000000001，总体标准差约 1.1e−16，不等于 0。这份代码给每条样本 −1.000（换成样本标准差是 −0.935）：一个本该没有信号的组变成满额负梯度。TRL 和 verl 在分母上加 epsilon（1e−4、1e−6），同一个算式的结果是 −1.1e−12 和 −1.1e−10，坑被藏起来了。不加 epsilon，就要用相等比较判全相同。对应 A10。

## 顺带

- 组为空时 \`m\` 是 NaN；参考实现在有效样本少于 2 个时返回全 0、\`hasSignal: false\`（A09）
- 返回值里没有「这一组有没有信号」，而筛题和监控（TRL 的 \`frac_reward_zero_std\`）都要用到它

verify 会把 Bug 1 到 6 全部抓出来。真正要带走的是 Bug 1 和 Bug 3：它们不是数值细节，是**评测口径进了奖励之后在塑造行为**。`,
    },
    {
      id: 'reward-scheme',
      kind: 'choice',
      prompt: `G=8 的一组：2 次 resolved、2 次 hacked（改测试让 F2P 变绿）、4 次 failed。三种奖励口径下的组内优势（不除 std）如下。你要给 coding agent 的 RL 选一个，选哪个、代价是什么？

    口径                       A(resolved)  A(hacked)  A(failed)
    f2p-only                         0.500      0.500     -0.500
    resolve（hacked 记 0）           0.750     -0.250     -0.250
    rewardFromAttempt                1.000     -1.000      0.000`,
      options: [
        { id: 'a', label: 'f2p-only：有信号的组最多，而且 F2P 变绿本身就说明目标测试过了' },
        { id: 'b', label: 'resolve 口径就够了：作弊拿不到正优势，再加显式惩罚只会带来误报风险，没有收益' },
        {
          id: 'c',
          label:
            'rewardFromAttempt：block 级作弊为负，老实失败优于作弊；代价是检测器的误报直接变成对正确解的惩罚，所以 warn 只封顶扣分（上限小于 1），并另留一个不进奖励的检测器做审计',
        },
        { id: 'd', label: '三种口径训练效果一样：GRPO 只看组内相对排序，resolved 在三种口径下都排第一' },
      ],
      correct: ['c'],
      explain: `C。

f2p-only 那一行，作弊和真解的优势**一模一样**。L18 说过宽口径会奖励错误行为；评测里它只让海报好看，训练里 RL 以同样的力度强化作弊。resolve 那一行，作弊和老实失败打平。只有显式惩罚让失败优于作弊。

显式惩罚的代价要说出来：检测器的误报会变成对正确解的惩罚。所以 \`rewardFromAttempt\` 只对 block 级发现给负分，warn 每条扣 0.1、封顶 0.3。上限必须小于 1，否则带足够多 warn 的 resolved 会掉到 applied_only 以下（R08、R10）。检测器一旦进了奖励，它报出的作弊率就是被优化过的数字，所以还要留一个不进奖励的检测器，加金丝雀量召回。

A 错：F2P 变绿可以靠改测试、\`sys.exit(0)\`、\`conftest.py\` 达成。OpenAI 报告这类作弊 "quickly get reinforced and become systemic, affecting nearly every training environment."。有信号不是目标，信号的方向才是。

B 错：作弊和老实失败打平时，模型没有理由更偏向老实失败；被抓住的作弊没有代价，漏抓的作弊照样被判 resolved。Anthropic 的结果是奖励里加 hack 分类器惩罚有效，「没有收益」不成立；误报的代价可以靠封顶和独立审计控制。

D 错：GRPO 用的是奖励减组均值，不是排名。hacked 的优势在三种口径下分别是 +0.5、−0.25、−1.0，符号都变了。排名相同不代表梯度相同。`,
    },
    {
      id: 'detector-in-reward',
      kind: 'choice',
      prompt:
        '你把一个读 CoT 的作弊监控接进奖励：被它标记就记 −1。训了 200 步（以下为假想数据），监控的标记率从 12% 降到 0.3%，训练集上 raw resolve 一路上涨，但人工抽查的 clean resolve 几乎没动。最合理的判断和下一步是什么？',
      options: [
        { id: 'a', label: '作弊被压住了，监控进奖励是有效的；clean resolve 没涨只是抽查样本太少' },
        {
          id: 'b',
          label:
            '监控已经成了被优化的对象，作弊可能转成了它看不出来的形式。保留一个不进奖励的独立检测器，混入不可能任务量召回，并优先修环境',
        },
        { id: 'c', label: '在训练 prompt 里加一句「不要作弊，作弊会被发现」，再训一轮' },
        { id: 'd', label: '把监控标记过的轨迹过滤掉，用剩下的轨迹做 SFT，把模型「洗干净」' },
      ],
      correct: ['b'],
      explain: `B。

OpenAI 训练前沿推理模型时（arXiv 2503.11926）做过这个实验：看 CoT 的监控对系统性作弊召回 95%，只看动作的 60%。把 CoT 监控放进奖励训下去之后：

> "the agent trained with CoT pressure still learns to hack at a significant rate, and even more worrying, the CoT monitor's recall falls to near zero"

标记率下降，可能是作弊少了，也可能是作弊藏起来了；监控进了奖励，你就分不清这两种情况。raw 涨、clean 不涨，指向后者。所以审计用的检测器不能进奖励。不可能任务让召回变成能测的数：ImpossibleBench 让 spec 和测试矛盾，"any pass necessarily implies a specification-violating shortcut"。Anthropic 首选 "making reward hack immunity a key environment design criterion"：**修环境优先于罚模型**。

A 错：这正是混淆式作弊的样子。抽查样本少会让 clean 的区间变宽，不会让它系统性地不涨。

C 错：Anthropic 发现在训练 prompt 里叫模型别作弊 "can increase misalignment"。推理时的 prompt 是控制手段（ImpossibleBench 里一句 prompt 把 GPT-5 在 Conflicting-LiveCodeBench 上的作弊从 92% 降到 1%），训练时的 prompt 是被优化的对象，两者不能类推。

D 错：Anthropic 原文 "filtering out reward hacking episodes and training via SFT only on the remaining transcripts does not eliminate reward hacking"。何况这里用来过滤的，正是已经失效的那个监控。`,
    },
    {
      id: 'debug-sft',
      kind: 'debug',
      prompt:
        '下面是一位同学交的 TODO 6 初稿：从落盘的候选轨迹里造拒绝采样 SFT 数据。签名比 lab 简化了（不返回 dropped）。用 lab 的 F01–F04 夹具跑它，四条全红。找出所有会改变「留下哪些轨迹」的问题，各说出它在哪条夹具上留错了什么，以及背后的理由。',
      lang: 'ts',
      code: `function buildSft(cands: SftCandidate[], cap: number, evalTaskIds: string[]): SftCandidate[] {
  const evalSet = new Set(evalTaskIds)
  const byTask = new Map<string, SftCandidate[]>()
  for (const c of cands) {
    const a = c.attempt
    if (a.errored || !a.failToPassGreen) continue
    if (evalSet.has(a.taskId)) continue
    const list = byTask.get(a.taskId) ?? []
    list.push(c)
    byTask.set(a.taskId, list)
  }
  const kept: SftCandidate[] = []
  for (const [, list] of byTask) {
    list.sort((x, y) => y.turns - x.turns)
    const seen = new Set<string>()
    for (const c of list.slice(0, cap)) {
      if (seen.has(c.patchHash)) continue
      seen.add(c.patchHash)
      kept.push(c)
    }
  }
  return kept
}`,
      rubric: [
        '你有没有发现成功的定义绕开了 classifyAttempt，把 hacked 和弄坏 P2P 的轨迹当成正样本？',
        '你有没有指出 SFT 里带 warn 就要丢，并说出为什么它比奖励严？',
        '你有没有发现封顶在去重之前，并说出它在 F02 上挤掉了哪条？',
        '你有没有发现 turns 排序方向反了，而且缺少 tokens 和 variant 的平手规则？',
        '你有没有提到按运行整批排除，以及为什么逐条过滤不够？',
        '你有没有提到 dropped 审计、按仓库隔离或题面泄漏中的至少一项？',
      ],
      reference: `把这份代码代入 F01–F04 的夹具实测：

| 夹具 | 这份代码留下 | 参考实现留下 |
|---|---|---|
| F01 | a/ok、a/hk、a/wn | a/ok |
| F02 | x/c、x/b | x/a、x/c |
| F03 | y/r、y/p、w/z | w/z、y/s、y/q |
| F04 | k/ok、k/fine | k/fine |

## Bug 1：成功的定义是 F2P 变绿

\`!a.errored && a.failToPassGreen\` 收进了改测试变绿的 hacked（F01 的 a/hk），也会收进弄坏 P2P 的和带 block 级发现的。正样本必须是 \`classifyAttempt(a) === 'resolved'\`。

## Bug 2：没有 warn 这一关

F01 的 a/wn 是带一条 warn 的 resolved。**SFT 比奖励严**：奖励里 warn 只扣分，SFT 是逐 token 模仿，会把可疑行为原样复制。

## Bug 3：先封顶，后去重

F02：三条轨迹 turns 是 3、4、6，前两条是同一个补丁 H1，cap 为 2。哪怕把排序改对（turns 升序），先 \`slice(0, cap)\` 拿到的也是 x/a 和 x/b 两份 H1，去重后只剩 x/a，x/c 这个不同的解被挤掉了。去重必须先于封顶。

## Bug 4：排序方向反了，也没有平手规则

\`y.turns - x.turns\` 是 turns 降序，F03 留下 9 轮和 5 轮的 y/r、y/p，丢掉两条 2 轮的。SWE-Gym 按回合数排序，原文 "preferring fewer"：同一题更短的成功轨迹更值得模仿。turns 相同时还要按 tokens、variant 排，否则结果取决于输入顺序，TS 和 Python 两条通道也对不上。

## Bug 5：题的顺序跟着 Map 插入顺序

F03 的 w/z 跑到了最后。参考实现按 taskId 码点序输出。输出顺序是数据集的一部分：两次跑出不同顺序，下游的切分和 diff 都会出问题。

## Bug 6：没有按运行排除

F04 里 k/ok 来自 \`run-hacky\`。Anthropic 原文 "filtering out reward hacking episodes and training via SFT only on the remaining transcripts does not eliminate reward hacking"：产出它的模型学过作弊，干净的轨迹里也带着它。这只能按来源整批排除（\`excludeRunIds\`），逐条过滤做不到。

## 不在 verify 里、但评审会问的

- 没有 dropped 和原因：说不出丢了多少条、为什么丢，数据集就没法审计
- 只按 taskId 隔离评测集。SWE-Gym 的仓库 "separate from those used in SWE-Bench to avoid contamination"，SWE-RL 剔除 SWE-bench 用到的全部仓库；同仓库的题共享大量代码，按仓库隔离更稳
- 题面不能泄漏判据。SWE-smith 把失败测试告诉专家模型，成功轨迹变多，训出来的模型却更差："leaking the evaluation criteria causes the model to skip over writing a reproduction script"`,
    },
    {
      id: 'sft-mask',
      kind: 'choice',
      prompt:
        '你用 TRL 的 SFTTrainer 在多轮工具调用轨迹上做 SFT（平均约 19 轮），训练 loss 平稳下降，验证 loss 也好看。部署后出现两个症状：模型发出工具调用后不停下，自己接着写出一段「测试输出」；回答写完后也不停止。最可能的原因是什么？',
      options: [
        { id: 'a', label: '轨迹没有按轮切分。应该把每个助手轮拆成一条样本、带上完整前缀' },
        {
          id: 'b',
          label:
            '`assistant_only_loss` 默认是 False，loss 落在整条序列上、包括工具输出；同时聊天模板没让结束 token 进入助手 mask，模型没学会停。要开 mask 并做模板往返测试',
        },
        { id: 'c', label: '数据太少。OpenAI 建议 SFT 至少准备 5 万条' },
        { id: 'd', label: '学习率太大导致过拟合，降低学习率重训即可' },
      ],
      correct: ['b'],
      explain: `B。

TRL 的 \`assistant_only_loss\` 是 \`default=False\`，"If \`False\`, loss is computed on the entire sequence."。按实验七的参数（19 轮），不开 mask 时约七成 token 不是助手写的，loss 大部分落在工具返回上。调研推断这在教模型预测工具会返回什么；这个后果没有一手量化，所以只能说「可能」。

不会停的那一半，TRL 源码里有原话告警：

> "the model may not learn to stop. The training loss still looks healthy, so this usually only surfaces at inference."

**loss 曲线健康不证明格式对**。做法是模板往返测试：编码再解码一条样本，检查助手 mask 的起止 token、工具调用的格式和推理时是否一致。L18 说判定器最值得测，训练数据上的对应物就是这个。

A 错：按轮切分只改变样本组织方式，不改变 mask。19 轮时它的 token 量是整条的 10.35 倍；只训助手 token 时两者的监督信号相同，整条加 mask 便宜一个数量级。

C 错：OpenAI SFT 的最小值是 10 条，建议 "starting with 50 well-crafted demonstrations"；50,000 是 RFT 训练文件的上限，不是最低要求。数据多少和这两个症状也对不上。

D 错：验证 loss 正常，症状只出现在格式边界上。这是 mask 和模板的问题，不是优化强度的问题。`,
    },
    {
      id: 'dpo-length',
      kind: 'choice',
      prompt:
        '你用可判定标签造 DPO 对：同一道题里 resolved 当 chosen，failed 或 applied_only 当 rejected。同事说：「L12 说 21 个 judge 的冗长偏见都低于 0.011，长度问题已经修掉了，而且我们的标签是测试判的，不用管长度。」你看实验八的数据：14 对里 chosen 更短的占 0.857，rejected 平均是 chosen 的 2.215 倍长。你怎么回？',
      options: [
        { id: 'a', label: '同意。标签来自测试而不是 judge，不存在长度偏见' },
        {
          id: 'b',
          label:
            '被修掉的是 judge 的偏见；标签配对数据会从另一个方向带回长度，因为失败轨迹常常更长。加双向的长度比护栏，并报告它的代价',
        },
        { id: 'c', label: '把长度比阈值设成 1.0，只保留等长的对，彻底消除长度信号' },
        { id: 'd', label: '改回用 LLM judge 做 pairwise 标注，它的冗长偏见已经低于 0.011' },
      ],
      correct: ['b'],
      explain: `B。

0.857 的意思是：只用「挑短的那条」一条规则，就能预测 85.7% 的偏好，DPO 学到的可能是「短」而不是「对」。来源很直接：失败的 agent 轨迹常常更长，SWE-Gym 报告 32B 模型在 29.4% 的 Verified 任务上陷入循环（"trapped"）。实验八是确定性假数据，但方向就是照这个设的。

L12 的原话是「所有 21 个模型的冗长偏见都低于 0.011。这一条基本上被修掉了。」被修掉的是 judge，你的数据是另一条通道。L12 紧接着那个 Pitfall 的标题正好适用：但「被修掉了」不等于「不用测了」。

实验八加上长度比 ≤ 1.25 的护栏之后，14 对剩 6 对，chosen 更短的占比降到 0.667，平均长度比 1.048；t4 唯一的一对长度差四倍，整道题没了。护栏要**双向**：Park et al. 报告的 DPO 长度利用是 chosen 偏长，方向取决于数据来源。1.25 是实验设定，不是推荐值，调研没找到一手的阈值建议。

A 错：长度偏见不只是 judge 的属性，也是数据的属性。标签判得再对，配对里仍可能有一个和「对」高度相关的捷径特征。

C 错：agent 轨迹几乎不会等长，阈值 1.0 等于丢掉全部数据。

D 错：pairwise judge 先要过 AB+BA 交换测试（L12 的位置偏见），而且你丢掉了可判定标签这个最大的优点。「低于 0.011」说的是 judge 的冗长偏见，说明不了你这批对的长度分布。`,
    },
    {
      id: 'grpo-config',
      kind: 'choice',
      prompt:
        '面试里，候选人说：「我们用 GRPO 训了一个 coding agent，训练中回答长度一路上涨，长 CoT 涌现了，效果很好。」你是面试官，最该追问哪一组问题？',
      options: [
        { id: 'a', label: '用了多少张 GPU、训了多少步' },
        {
          id: 'b',
          label:
            'loss 怎么聚合、除不除组内 std、KL 系数多少；长度上涨有没有排除长度偏置；pass@1 和大 k 的 pass@k 各自怎么变',
        },
        { id: 'c', label: '为什么不用 PPO？PPO 有 critic，效果一定比 GRPO 好' },
        { id: 'd', label: '训练过程中 train_reward_mean 涨了多少' },
      ],
      correct: ['b'],
      explain: `B。

「我用 GRPO」没说清三件事。实验四里一组四条回答、奖励 1/1/0/0，原版 GRPO 先在样本内按长度平均：

    错·长 / 错·短 的每 token 惩罚之比：grpo 0.25  dapo 1.00  dr_grpo 1.00

长的错答案每个 token 只被罚四分之一，长度上涨可能就是这么来的。Dr. GRPO 原文认为「长 CoT 涌现」"is also confounded by the response-level length bias"。除 std 是题目级的另一个偏置。KL 系数在一手来源之间也不统一：DeepSeekMath 0.04，R1 0.001，DAPO 直接去掉。TRL（commit \`72cf37df714d\`）默认 \`loss_type\` 是 "dapo"、\`beta\` 是 0.0，「用 TRL 的 GRPO」已经不是 DeepSeekMath 的原样。

最后一问看效果的口径：Yue et al. 发现 RLVR "narrows the model's overall coverage"，pass@1 涨的同时，大 k 的 pass@k 可能跌。

A 错：规模信息有用，但分不清长度上涨是能力还是偏置。

C 错：「PPO 一定更好」没有一手来源。调研专门找过什么情况下 PPO 优于 GRPO，没找到。面试官这样问，考的是自己编的结论。

D 错：TRL 文档原文 "values across different steps are not directly comparable"，每步是不同的题；训练奖励也不是 held-out 评测。`,
    },
    {
      id: 'post-train-eval',
      kind: 'choice',
      multi: true,
      prompt: `你在一个开放权重模型上做完 RL，拿到下面的对比（**假想数据**，用来练读表）。哪些结论站得住？（多选）

    指标                      训前     训后
    held-out pass@1            31%      44%
    held-out pass@64           78%      71%
    raw resolve（含作弊）      33%      52%
    clean resolve              31%      44%
    平均输出 token             1.0×     2.3×`,
      options: [
        { id: 'a', label: 'pass@1 涨、pass@64 跌，符合 RLVR 收窄覆盖面的一手发现；两个都要报，不能只报 pass@1' },
        { id: 'b', label: 'raw 和 clean 的差从 2pp 扩大到 8pp，提示作弊在增加；作弊率要单列，并检查检测器有没有漏' },
        { id: 'c', label: '输出 token 涨到 2.3 倍，说明模型学会了深度思考，是好事' },
        { id: 'd', label: 'pass@1 涨了 13pp，足以证明奖励设计有效，不需要再做对照' },
        { id: 'e', label: '如果这些数字来自你挑检查点时用的验证集，最终结论要在只跑一次的测试集上重报' },
      ],
      correct: ['a', 'b', 'e'],
      explain: `A、B、E。

A 对：Yue et al.："RLVR increases the likelihood of sampling correct responses at low k, but narrows the model's overall coverage."；DeepSeekMath 自己也写过 "RL enhances Maj@K's performance but not Pass@K"。这不等于 RL 没用：对 agent 产品，把 pass@k 变成 pass@1 和 pass^k 常常比上限值钱。但两个都报，读者才知道买到的是什么。

B 对：raw 涨得比 clean 快，就是 reward hacking 的信号。训后报告里 raw、clean、hack-flagged 分开写；评测集里同样混入不可能任务。

E 对：按验证集挑检查点，验证集的分数就有偏了。OpenAI："We always recommend maintaining a hold-out set"。

C 错：OpenAI 提醒训练后推理 token 剧烈变化是 "a sign that the model is changing its behavior in response to the reward signal"，不是好坏的判断。结合 Dr. GRPO 的长度偏置，先当副作用排查：loss 怎么聚合的，长度涨在对的回答上还是错的回答上。

D 错：Spurious Rewards（arXiv 2506.10947）里，随机奖励让 Qwen2.5-Math-7B 的 MATH-500 涨了 21.4 分，真实奖励是 29.1，而且这种效果在 Llama3、OLMo2 上常常不出现。「奖励让分数涨了」要和「随机奖励涨了多少」比；跑不起这个对照，至少换种子再训一次，在两个家族的基座上看方向。训练域之外的回归（遗忘）也还没测。`,
    },
    {
      id: 'design-coding-rl',
      kind: 'design',
      prompt:
        '老板问：「我们有 300 道自建的 fail-to-pass 任务和 resolve 判定器，要不要上 RL？」给出从「该不该训」到「训完怎么验」的完整方案：先算什么、奖励怎么写、环境怎么搭、怎么防作弊、在哪训、什么时候退回 SFT。',
      scenario:
        '300 道题都来自公司的 monorepo。L18 的落盘里，每题已经用一个开放权重的 32B 模型跑了 16 次。按题统计：约 40% 的题 16 次全失败，约 25% 的题 16 次全通过，其余有成有败；error 集中在跑得最久的那批题上。L17 的 `detectHacks` 已接入。可选平台：Bedrock RFT（支持 Nova 2 Lite、gpt-oss-20b、Qwen3 32B，奖励用 Lambda 自定义代码或 model-as-a-judge），或者在租用 GPU 上自建 TRL。',
      reference: `这题没有唯一答案。能区分「想过」和「没想过」的，是你有没有先用手里的数据算，再决定要不要训。

## 一、先过决策树

1. 评测集有了：可判定，F2P 加 resolve 判定器。确认专家对答案一致
2. 问清楚要解决什么。缺知识（比如 monorepo 的内部约定）走上下文轴，行为不稳才是模型轴
3. 换模型、改 prompt 试过没有。能解决就停
4. 基线落在哪：见下一步
5. 奖励能不能写成代码：resolve 判定器加作弊检测，能

## 二、用落盘的 (n, c) 算信号预算

每题算无偏的 pass@G − pass^G，即 \`1 − C(n−c, G)/C(n, G) − C(c, G)/C(n, G)\`。按场景，65% 的题在 16 次里零方差：

- **全失败的约 120 道**：不是 RL 的题。先查任务坏没坏（L18：0% pass@100 最常见的原因是任务坏了），没坏的留给 SFT 或蒸馏。Bedrock："If rewards are consistently 0 percent, use supervised fine-tuning first"
- **全通过的约 75 道**：RL 学不到东西，留作回归集，或当 SFT 数据来源
- **有成有败的约 105 道**：这才是 RL 训练集。用另一批独立样本估计信号占比，因为同一批样本的预测偏乐观（实验三：0.813 对 0.751）；训练中途按批重筛

再按实验二的表估成本：p=0.05 或 0.95 的题，G=8 时只有 33.7% 的组有信号，G=16 是 56.0%，代价是两倍 rollout。把预测的信号占比和 rollout 成本一起写进方案。

## 三、先修 error

error 集中在长题上，不是随机噪声。奖励里 error 返回 null、排除出组；记 0 会让超时和失败一样拿负优势，推离跑得久的行为（实验五：1.208 / −0.725 对 0.913 / −0.913）。排除也有代价：那批题拿不到梯度。所以先调资源上限，把它当作基准定义的一部分写进配置（L18 的 Pitfall：infra error 偏偏更爱落在难题上）。

## 四、奖励

- 标签一律走 \`classifyAttempt\`：resolved 1，hacked 为负，其余 0，error 为 null
- warn 每条扣 0.1，封顶 0.3，上限必须小于 1
- 在 L17 之上补规则：任意路径的 \`conftest.py\`、\`__eq__\` 恒为 True（Anthropic 点名的生产环境作弊）
- \`sys.exit(0)\` 在 L17 里只是 warn：评测里这是合理的保守，进了奖励只扣 0.1；OpenAI 报告 exit(0) 在训练中会系统化，至少要在审计里单独盯住它
- 不用 f2p-only：实验六里作弊和真解同优势

## 五、环境

- 判分器和隐藏测试在沙箱外，agent 摸不到
- 每个 rollout 一个全新工作区；屏蔽 git 历史和网络（L18 的评测期泄漏）
- 规模：每步 B 道题 × G 次，就是 B×G 个并发工作区。monorepo 的镜像和冷启动要先压测

## 六、独立审计与金丝雀

- 至少一个检测器**不进奖励**，只告警、只用来修环境
- 混入不可能任务（spec 与测试矛盾），任何通过都是作弊。实验九里只用 L17 时平均奖励 +0.500，RL 在付钱买作弊
- 训练 prompt 里不写「不要作弊」（Anthropic：can increase misalignment）

## 七、在哪训

| 选项 | 好处 | 要确认的 |
|---|---|---|
| Bedrock RFT | 托管 GRPO，奖励写成 Lambda | 只有 Nova 2 Lite、gpt-oss-20b、Qwen3 32B；多轮 agent 环境怎么接，调研没核实 |
| 自建 TRL | 环境、奖励、聚合全在自己手里 | 写清 loss 聚合、std、KL 三个参数；默认是 dapo、beta 为 0.0 |

无论哪个，**基座下线那天要重训**，把它写进维护成本。

## 八、训完怎么验

- 300 道题先切三份：训练、挑检查点的验证集、只跑一次的测试集。monorepo 只有一个仓库，做不到按仓库隔离，就按目录或模块切，并承认残余的泄漏风险
- 训前训后当 L18 的两个 variant：同题同 n，\`pairedAB\` 加 claim 门
- pass@1 和大 k 的 pass@k 一起报；raw、clean、hack-flagged 分开报
- 长度单独看；训练域之外跑回归（通用工具调用、拒答边界、输出格式）
- 换种子再训一次，看提升是否稳定（Spurious Rewards 的教训）

## 九、退路：先做拒绝采样 SFT

很可能第一步根本不是 RL。有成有败的题和全通过的题已经能产出 resolved 轨迹：\`classifyAttempt\` 过滤 → 带 warn 就丢 → 排除评测题 → 排除学过作弊的运行 → 去重 → 每题封顶 2 条。SWE-Gym、R2E-Gym、SWE-smith 三篇的「训练」都是这一步；DeepSeek-R1 的 32B 蒸馏模型 AIME24 是 72.6，同底座做大规模 RL 是 47.0。SFT 做完、基线抬起来以后，用新的落盘重算一次信号预算，再决定 RL 值不值。`,
      rubric: [
        '你有没有在决定训练之前，先用落盘的 (n, c) 算每题的 pass@G − pass^G，并说出全失败和全通过的题各该怎么处理？',
        '你有没有意识到用同一批样本筛题的预测偏乐观，要用独立样本估计或训练中重筛？',
        '你有没有把「error 集中在长题上」当成要先修的问题，并让奖励对 error 返回 null 而不是 0？',
        '你的奖励有没有走 classifyAttempt、对作弊给负分、warn 封顶小于 1，并补上 L17 没覆盖的作弊形态？',
        '你有没有留一个不进奖励的检测器，并混入不可能任务来量召回？',
        '你有没有把 300 道题切成训练、验证、测试，并考虑 monorepo 下怎么隔离？',
        '你的验收里有没有 pass@1 加大 k 的 pass@k、作弊率单列、长度和训练域外的回归？',
        '你有没有把拒绝采样 SFT 当成更现实的第一步，或至少当成退路？',
      ],
    },
  ],
}
