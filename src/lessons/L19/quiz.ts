import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L19',
  questions: [
    {
      id: 'checkpoint',
      kind: 'choice',
      prompt:
        '你的 agent 在后台跑一个长任务。用户合上笔记本，反向代理掐掉了 SSE 连接；五分钟后他重新打开页面。前端的重连逻辑是：检测到断线 → 用同样的 prompt 再调一次 `POST /jobs`，"这样最保险"。上线一周后，有用户反馈同一个 PR 被开了两次，而日志里每个作业都是 `succeeded`，没有任何报错。正确的修法是？',
      options: [
        { id: 'a', label: '重连时给 `POST /jobs` 加指数退避，避免两次创建离得太近' },
        {
          id: 'b',
          label:
            '断线不改作业状态；客户端带 `lastSeen` 只补 `seq > lastSeen` 的事件；创建请求带客户端生成的意图 ID 作为幂等键',
        },
        { id: 'c', label: '断线时先 `cancel` 旧作业，再创建新作业，保证同时只有一个在跑' },
        { id: 'd', label: '重连时把 `lastSeen` 清零、完整重放事件流，让 UI 和后端完全对齐' },
      ],
      correct: ['b'],
      explain: `B。

这道题的形状就是这一节的中心论点：**上线之后，失败的默认形态是双份，而不是抛异常。** 两个作业都"成功"了，所以日志全绿。

根因是把"连接"和"作业"当成了同一个东西。正确的模型是：**作业事件日志是事实，连接只是它的一个读者**，读者数量从 0 到 N 都合法。SSE 的 \`Last-Event-ID\`、OpenAI 后台模式的 \`starting_after\`、Vercel 可恢复流的 \`activeStreamId\`，都是这个模型。lab 里对应的原语是 \`eventsAfter(events, lastSeen)\`（JOB-10）。

而防"第二个作业"的是**作业级幂等键**：用户点一次「运行」生成一个意图 ID，重连时带同一个 ID。lab 的 \`startJob\` 对同租户、同 key 的终态作业返回 \`replay\`（START-3），对仍在进行的返回 \`reject\`——生产里更好的做法是把进行中的作业 id 还给客户端让它去订阅。

---

**A 是用时序掩盖语义错误。** 退避多久都还是两个作业，只是第二个晚一点创建。

**C 有两层错。** 第一，**断线不是取消**——这是 L16 \`StopPolicy\` 的后端对偶，组件卸载、页面关闭都不该停止生成。第二，取消也不等于已取消：lab 的 \`cancel\` 直接把状态置成 \`cancelled\`，但 worker 要到下一次心跳被拒才知道，在那之前已经发出的 \`git push\` 不会撤回。于是你仍然可能得到两次 push，外加一次被白白丢掉的进度。

**D 把重放当成了对齐。** 重放 \`seq ≤ lastSeen\` 的事件，在 UI 上是"闪一下"；如果某个环节对事件有副作用、而后端工具不幂等，就是真的再执行一次。真正需要"对齐"的情况是游标失效（超前或早于保留下限），那时该做的是拉全量快照，而不是从零重放。`,
    },

    {
      id: 'at-least-once',
      kind: 'choice',
      prompt:
        '你把作业放进 SQS 标准队列：worker 取到消息后跑 agent，跑完再删消息。可见性超时设为 30 秒，任务时长大致均匀分布在 10–120 秒。上线后账单比预估高了一大截，但没有任何报错，每个作业最后都"成功"了。下面哪个判断和修法是对的？',
      options: [
        {
          id: 'a',
          label: '重复投递是罕见的边缘情况。加一张去重表，记下"这条消息开始处理过"，第二次取到就跳过',
        },
        { id: 'b', label: '把可见性超时调到远大于最长任务（比如几个小时），彻底消除重复' },
        {
          id: 'c',
          label:
            '超时短于大部分任务，重复是常态。改成租约加心跳续租，并让每次写入带上「每次认领递增」的 epoch',
        },
        { id: 'd', label: '换一个承诺 exactly-once 投递的队列，问题就从根上消失了' },
      ],
      correct: ['c'],
      explain: `C。

标准队列是 **at-least-once**：消息被取走后，在可见性超时内对别人不可见；超时前没删掉，它会重新可见、被再处理一次。这是设计内行为，不是故障。

本课调研时的本地模拟（10 000 个任务，10–120 秒均匀分布，无心跳，超时即重投）：

    可见性超时   被重复执行的任务   每任务额外执行
       30 s          81.1%            1.63 次
       60 s          54.2%            0.54 次
      120 s           0.0%            0

81.1% 可以手算：111 个取值里 d 在 31..120 的 90 个全部重复，90/111 ≈ 81.1%。所以题干的状况下，**大部分作业被跑了两次以上**——账单高出一截一点都不奇怪。

---

**A 把常态当成了罕见。** 而且"记下开始过就跳过"的去重表有一个更糟的后果：第一个 worker 崩溃时，这张表会把作业**永远挡住**。要让它可恢复，你得给记录加过期时间、让活着的 worker 续期——那就是租约。

**B 的问题是不重复和快恢复不可兼得。** 超时调到几个小时确实不再重复，但 worker 崩溃后，消息要等满整个超时才有人接手。coding agent 的时长从十几秒到几十分钟都有，没有一个静态数值同时满足两头。

**D 回避了真正的问题。** 本课不评判具体队列产品；但即使队列层承诺更强的投递语义，agent 的副作用（改文件、push、开 PR）发生在队列**之外**。"只执行一次"永远是应用层命题，要靠租约、围栏和幂等键自己造出来。

**C 里 epoch 那一半不能省。** 只有租约和心跳，GC 停顿后醒来的旧进程仍然能写——它的 workerId 没变。每次认领递增的 epoch 才能拦住它（JOB-11）。`,
    },

    {
      id: 'epoch-zombie',
      kind: 'choice',
      prompt:
        'worker 用主机名做 `workerId`。主机上的旧进程卡在一次 40 秒的 GC 停顿里，监控把它判死后在同一台主机上拉起新进程（同一个主机名）。作业租约过期、被 `requeue_stale`，新进程又认领了它。这时旧进程醒来，带着 `workerId=w1` 发出一条 checkpoint。你的状态机只比较 workerId。会发生什么，该怎么改？',
      options: [
        { id: 'a', label: '旧写入被接受，但没关系：两个进程都是 w1，跑的是同一份代码' },
        {
          id: 'b',
          label:
            'claim 时递增 epoch，所有写入必须带认领时拿到的 epoch，不匹配就拒；而且这个比较要落在存储层的写入条件里',
        },
        { id: 'c', label: '把 workerId 改成「主机名 + PID」，就不会重名了' },
        { id: 'd', label: '把租约缩短到 1 秒，让旧进程更早失去资格' },
      ],
      correct: ['b'],
      explain: `B。

时间线：

    t=0   w1 认领 job
    t=1   旧进程进入 GC 停顿
    t=6   租约过期 → requeue_stale → 新进程以 w1 之名再次认领
    t=41  旧进程醒来，带着 workerId='w1' 发 checkpoint

只比较 workerId，最后一行会被接受。本课早期草稿就是这样，调研探针实测旧进程的 checkpoint 返回 \`ok=true\`。

**workerId 回答「你是谁」，epoch 回答「你是第几次被授权」。** 重启、同名、GC 后醒来，"你是谁"不变，"第几次"变了。lab 的 \`fence()\` 依次检查 workerId、epoch、租约是否过期；\`heartbeat\`、\`checkpoint\`、\`request_approval\` 都过这道门（JOB-11）。

而"落在存储层"那半句同样重要：\`fence()\` 是纯函数，拿到的是某一时刻读出的快照。并发下真正生效的是写入条件 \`WHERE epoch = :epoch\`，受影响 0 行就是被拒。

---

**A 混淆了"同一份代码"和"同一次授权"。** 两个进程会对同一棵工作树各写各的，checkpoint 互相覆盖——而且全都"成功"。

**C 在这个场景里恰好失效。** 容器里主进程常常就是 PID 1，重启之后还是 PID 1——"主机名 + PID"正好撞上。更一般地说，靠命名纪律保证唯一，比一个由存储检查的单调计数器脆弱得多。

**D 方向反了。** 旧进程醒来的时刻由 GC 决定，不由租约决定；租约越短，健康的 worker 越容易因为一次小停顿被误判过期，重复反而更多——这正是可见性超时那张表的逻辑。而僵尸写入照样被接受，因为你还是只比较 workerId。

一个细节：lab 的 \`succeed\` / \`fail\` 只看 workerId 和 epoch，不看租约。租约过期但没人认领时，原 worker 交差会被接受——epoch 没变，说明没有第二个人被授权过。这是可以辩护的不对称，但你要能说出理由。`,
    },

    {
      id: 'retry-classify',
      kind: 'choice',
      multi: true,
      prompt:
        '下面五次失败都发生在作业级副作用上。按 lab 的 `shouldRetryEffect`（`maxAttempts=3`，当前 `attempt=0`），哪些会被**自动重试**？（多选，全对才算对）',
      options: [
        { id: 'a', label: '`idempotent_write`，有 key，错误码 `429_RATE`' },
        { id: 'b', label: '`idempotent_write`，有 key，错误码 `429`（上游没说是哪种 429）' },
        { id: 'c', label: '`unsafe_write`，无 key，错误码 `TIMEOUT`' },
        { id: 'd', label: '`idempotent_write`，有 key，错误码 `502`' },
        { id: 'e', label: '`unsafe_write`，有 key，错误码 `WEIRD_UPSTREAM`' },
      ],
      correct: ['a', 'd'],
      explain: `A 和 D。

\`shouldRetryEffect\` 的判定顺序是：

    1. attempt >= maxAttempts          → 不重试
    2. classifyError 为 permanent      → 不重试
    3. unsafe_write 且无 key           → 不重试
    4. unsafe_write 且 unknown         → 不重试
    5. 其余                            → 重试

逐条过：

| 选项 | 分类 | 卡在哪一步 | 结果 |
|---|---|---|---|
| A \`429_RATE\` | transient | — | 重试 |
| B 裸 \`429\` | permanent | 第 2 步 | 不重试 |
| C \`TIMEOUT\` | transient | 第 3 步 | 不重试 |
| D \`502\` | transient | — | 重试 |
| E \`WEIRD_UPSTREAM\` | unknown | 第 4 步 | 不重试 |

---

**B 是最容易错的。** 直觉是"429 就等一会儿"。但 L15 讲过，Anthropic 的强制花费上限也返回 429，而且**不带** \`retry-after\`，重试在额度恢复前一直失败。裸 429 分不清是哪种，代价又不对称：把速率限制误判成永久，丢一次自动恢复；把花费上限误判成瞬时，你在一个永远不会成功的请求上退避到超时，期间作业占着 worker。**分不清就按贵的处理，并逼调用方去拆成 \`429_RATE\` / \`429_SPEND\`**（RETRY-6/7/8）。

**C 是这一节最该记住的一条**：TIMEOUT 是 transient，但 transient 不能压过"无幂等键的写"。超时的意思是"不知道做没做"，不是"没做"（RETRY-1）。

**E**：有 key 也不行，因为错误分类是 unknown——你连它是不是瞬时的都不知道，对不安全写就不赌（RETRY-5）。

两件 lab **没做**的事：A 被判"重试"，但 lab 不算延迟——生产里 \`429_RATE\` 的延迟要不小于 \`retry-after\`，抖动用注入的随机源；也没有重试预算，而 agent 的链很深，模型 API × 工具 × 作业 × 用户点重试，四层各 3 次最坏 81 倍。另外别拿 \`shared/resilience.ts\`（L00 的单次 HTTP 重试，429 和 409 都在可重试表里）去包作业级副作用。`,
    },

    {
      id: 'tenant-idem',
      kind: 'choice',
      prompt:
        '你的 `POST /jobs` 支持幂等键，幂等表的主键就是 key 字符串。bob 的客户端偷懒，固定用 `run-1` 当 key；alice 昨天也用过 `run-1`，那个作业已经 `succeeded`。bob 发起请求时，系统应该怎么做？',
      options: [
        { id: 'a', label: '返回 alice 那个作业的结果——同 key 重放，这正是幂等的定义' },
        { id: 'b', label: '返回 409，提示「这个 key 已被使用，请换一个」' },
        {
          id: 'c',
          label:
            '按租户隔离：对 bob 来说没有 prior，正常开工；存储主键改成「租户 + key」，跨租户既不可见、也不泄露 key 是否存在',
        },
        { id: 'd', label: '把 alice 作业里的敏感字段脱敏后再重放给 bob' },
      ],
      correct: ['c'],
      explain: `C。

这是本课调研里唯一一条**直接泄露数据**的缺陷。早期草稿的 \`startJob\` 只比较 key 字符串：\`bob\` 用 \`alice\` 用过的 key，拿到了她的整份作业——成本、token 数、checkpoint 全在里面。

现在的实现：

    // ★ 租户隔离：跨 user 的同 key 当作「没有 prior」——不泄露作业存在与否
    if (input.priorJob.userId === input.usage.userId) { ... }

START-4 断言 bob 拿到的是 \`start\`。Stripe 的幂等键同样是**账号**范围的。

---

**A 是泄露。** 幂等的定义是"同一个调用方的语义等价重放返回同样结果"，不是"同一个字符串返回同样结果"。

**B 是一个存在性预言机。** 攻击者枚举 key，就能从错误类型里得知"有人用过这个 key"。拒绝要做到连存在与否都不泄露。

**D 仍然是错的，而且错得更隐蔽。** 脱敏挡住了字段，挡不住"这个 key 存在"这件事；更根本的是，bob 的请求不是 alice 的请求，重放任何东西给他在语义上都不对。

**C 的后半句才是真正的修法。** lab 只能在判定层"当作没有"，因为 \`priorJob\` 是调用方查出来的。但如果存储主键只是 key，bob 的作业插入时会撞上 alice 那一行——要么失败（又泄露了），要么覆盖（更糟）。**主键必须是租户加 key**，两个租户的同一个字符串在存储层就是两行。

顺带一个相邻的坑：\`startJob\` 只在两边都有 \`payloadHash\` 时才比较载荷。调用方不传指纹，同 key 配一个新 prompt 会拿到旧 prompt 的作业。生产里指纹应该必填。`,
    },

    {
      id: 'fair-cost',
      kind: 'choice',
      prompt:
        '4 个 worker。whale 先提交了 100 个各需 600 秒的作业，minnow 随后提交了 100 个各需 10 秒的作业。你的调度器已经从 FIFO 改成了按 `lastServed` 轮转（谁最久没被服务谁先走）。minnow 抱怨"还是要等好几个小时"。原因和修法是？',
      options: [
        { id: 'a', label: '`lastServed` 的时间戳精度不够，改成毫秒级就能正确轮转' },
        {
          id: 'b',
          label:
            '轮转公平的是调度次数，而 worker 时间按「次数 × 时长」消耗。排序键要换成累计已付成本，并在认领时复核并发上限',
        },
        { id: 'c', label: '给 minnow 一个固定的高优先级常量，让它永远插队' },
        { id: 'd', label: '改成随机选下一个作业，消除系统性偏向' },
      ],
      correct: ['b'],
      explain: `B。

本课调研时做过这个本地模拟（4 个 worker，非抢占，每当有 worker 空闲按策略选下一个）：

| 策略 | 前 1000 秒起跑的 worker 秒数 whale / minnow | minnow 全部完工 |
|---|---|---|
| FIFO | 100% / 0% | 15 250 s |
| 按条数轮转（lab 的 \`fairNext\` 同类） | 98% / 2% | 14 670 s |
| 按累计已付成本轮转 | 75% / 25% | 400 s |

按条数轮转几乎没救到 minnow。机制是：t=0 两个用户交替各拿两个 worker；10 秒后 minnow 的作业结束、空出 worker，而轮转规则把它交替分出去——每轮到 whale 一次，那个 worker 就锁死 600 秒。几轮之后四个 worker 全被 whale 占住。**时长差 60 倍，公平就差 60 倍。**

修法的思想来自 VTC（Sheng 等，*Fairness in Serving Large Language Models*，OSDI '24）：按实际 token 成本记账的虚拟计数器，谁花得少谁先走。注意两点：表里的"按成本轮转"是本课的**作业级类比**，不是 VTC 原始算法；75/25 而不是 50/50，是因为作业不可抢占。结论是排序与量级，不是精确比例。

"认领时复核并发"那半句来自另一个探针：lab 的 \`fairNext\` 不看并发上限——whale 已经跑满，只要它的 \`lastServed\` 更旧，照样被选中。**这两件事 lab 都没实现**。

---

**A**：精度和这个问题无关。轮转本身的语义就是条数公平。

**C** 把饥饿反过来了：whale 会被永远压住。而且固定优先级和"谁实际花了多少"无关——等 minnow 变成重度用户，它仍然插队。

**D** 随机选择在期望上等于按条数公平：两人各 100 个作业，每次抽中 whale 的概率一半，每抽中一次就锁死 600 秒。症状和轮转一样，只是更难复现。`,
    },

    {
      id: 'approval-scope',
      kind: 'choice',
      prompt:
        '用户对 `edit_file` 在 `/repo` 上点了「本会话允许」。随后模型依次请求：① `/repo/src/a.ts` ② `/repo-evil/x.ts` ③ `/repo/a/../../repo-evil/x.ts` ④ `/repo/`。按 lab 的 `scopeCovers`，哪组判定是对的？',
      options: [
        { id: 'a', label: '①②③④ 全部放行——前缀匹配最省心' },
        { id: 'b', label: '只有 ① ④ 放行；② ③ 都不放行' },
        { id: 'c', label: '只有字符串完全等于 `/repo` 的才放行，①②③④ 都要重新问' },
        { id: 'd', label: '① ② ④ 放行；③ 因为含 `..` 一律拒绝' },
      ],
      correct: ['b'],
      explain: `B。

lab 的语义是**路径段边界**：先规整，再按段比较。

    export function scopeCovers(granted: string, requested: string): boolean {
      const g = normalizeScopePath(granted)
      const r = normalizeScopePath(requested)
      if (g === null || r === null) return false
      if (g === r) return true
      if (g === '/') return r.startsWith('/')
      return r.startsWith(g + '/')
    }

规整只用 \`/\` 分段，丢掉空段和 \`.\`，\`..\` 弹出上一段，越过根就返回 \`null\`。逐个过：

- ① \`/repo/src/a.ts\` 以 \`/repo/\` 开头 → 覆盖
- ② \`/repo-evil/x.ts\` 不等于 \`/repo\`，也不以 \`/repo/\` 开头 → 不覆盖
- ③ 规整后是 \`/repo-evil/x.ts\` → 不覆盖
- ④ 规整后是 \`/repo\`，和授权相等 → 覆盖

---

**A 是后门。** \`/repo-evil\` 以 \`/repo\` 开头——这正是 L17 那个 \`startsWith(root)\` 在 \`ws-evil\` 上放行的同一个洞（MEM-2）。

**C 是审批疲劳。** 精确匹配让"记住这个目录"对文件级调用完全没用，用户回到每次都点允许。本课早期草稿就是这样。Anthropic 公布过用户批准了 93% 的权限提示（*Claude Code auto mode* 一文）——"每次都问"本身就是审批失效的方式。

**D 的理由错了。** ③ 被拒不是"因为含 \`..\`"，而是规整之后它落在 \`/repo-evil\`。\`/repo/a/../b.ts\` 规整成 \`/repo/b.ts\`，照样被覆盖。一刀切拒绝 \`..\` 看起来更安全，但它把判断从"落在哪里"换成了"长什么样"，这是另一种字符串匹配。

**还有一层 B 也挡不住**：\`scopeCovers\` 是纯词法的。\`/repo/link\` 若是指向 \`/etc\` 的符号链接，\`/repo/link/passwd\` 在词法上被覆盖。这归 L17 的路径层（\`realpath\` 之后落在 root 外就拒，\`SBX-7\`），而且路径层要排在审批记忆**之前**。`,
    },

    {
      id: 'deny-path',
      kind: 'choice',
      prompt:
        '后台作业停在 `waiting_approval`，等用户批准一次 `git push --force`。用户点了「拒绝」。下面哪种处理最接近本课的设计？',
      options: [
        { id: 'a', label: '把作业置为 `cancelled`——用户明确说了不' },
        {
          id: 'b',
          label:
            '作业回到 `running`，拒绝作为 tool result 回给 agent 让它换路；拒绝累计到阈值再升级给人；无人值守时以「拒绝过多」失败',
        },
        { id: 'c', label: '记一条永久 deny：这个仓库以后所有 git 操作都不再问、直接拒' },
        { id: 'd', label: '作业回到 `running`，但不告诉 agent 被拒了，让它自然超时后重试' },
      ],
      correct: ['b'],
      explain: `B。

Anthropic 的 auto mode 是这样设计的：分类器拒绝之后，拒绝**作为 tool result 回给模型**，提示它换一条更安全的路、不要绕开边界；会话累计 **3 次连续或 20 次总拒绝**，才停下来升级给人（文档说这两个阈值不可配置）。headless 模式没有界面可问，进程终止；CLI 的 \`--permission-prompts none\` 写的是：

> "Pass \`none\` when nobody can answer, and Claude Code denies them instead"

lab 落实了第一步：\`deny\` 把作业从 \`waiting_approval\` 拉回 \`running\`（JOB-12）。

---

**A 会逼用户永远点允许。** 点拒绝的代价如果是"丢掉整个任务"，理性的用户会学会不点拒绝。本课早期草稿就是 \`deny → cancelled\`，调研时被标成"语义写反"。

**C 的 scope 太宽，方向也不对。** 用户拒绝的是 \`git push --force\` 这一刀，不是所有 git 操作。高风险动作的正确策略是**每次都问、只允许 once**，而不是用一条宽 deny 代替判断。deny 记忆确实优先于 allow（MEM-7），但前提是它的 scope 和用户意图一样窄。

**D 会造成循环。** agent 不知道自己被拒，会原样再发一次同样的调用——它没有任何信息可以换路。

**lab 只做到了一半，要知道边界在哪**：\`deny\` 转移里带了 \`reason\`，但状态机不存它；把理由回写成 tool result 是调用方的事。拒绝计数和升级（交互模式转人、后台模式失败）也**未实现**。lab 的 deny 是"不杀作业"，还不是"让 agent 换路"。`,
    },

    {
      id: 'waiting-approval',
      kind: 'choice',
      prompt:
        '作业进入 `waiting_approval` 之后，它所在的 worker 被滚动发布杀掉了。租约过期，调度器对它执行了 `requeue_stale`。半小时后用户回来点了「允许」。在 lab **当前**的状态机里会发生什么？',
      options: [
        { id: 'a', label: '`approve` 成功，作业从 `queued` 直接进入 `running`' },
        {
          id: 'b',
          label:
            '`approve` 返回 `ok:false`：作业已经回到 `queued`，用户的点击丢了，而且没有任何报错',
        },
        { id: 'c', label: '`requeue_stale` 会拒绝 `waiting_approval` 的作业，所以作业还在等，`approve` 正常' },
        { id: 'd', label: '作业被自动置为 `timed_out`，用户需要重新发起' },
      ],
      correct: ['b'],
      explain: `B。

对着代码看：

    case 'requeue_stale':
      if (job.status !== 'running' && job.status !== 'waiting_approval') { ...fail }
      ...
      j.status = 'queued'

    case 'approve':
      if (job.status !== 'waiting_approval') return fail('approve 仅 waiting_approval')

\`requeue_stale\` 接受从 \`waiting_approval\` 出发，作业回到 \`queued\`；\`approve\` 只认 \`waiting_approval\`，于是返回 \`ok:false\`。本课对当前实现跑过，结果就是这样。**用户的那次点击丢了**，没有任何报错告诉他。

---

**A**、**C** 都和代码不符。

**D**：lab 里 \`timed_out\` 只能由显式的 \`timeout\` 转移进入，不会自动发生。

---

这道题真正要问的是设计：**等人的作业不该占着 worker 和租约。** lab 里 \`waiting_approval\` 允许心跳续租，worker 一直挂着；等人可能是小时级，而云端 agent 会话、Cloud Run 请求都有硬时长上限，K8s 终止 Pod 默认只给 30 秒宽限期。

生产里等待审批应该是**停靠（park）**：落 checkpoint、释放租约、不计入运行数；批准事件把作业重新入队，由任意 worker 从 checkpoint 接着跑。这样 worker 死不死都无所谓——审批状态在存储里，不在某个进程里。**lab 未实现停靠。**`,
    },

    {
      id: 'drain-kill',
      kind: 'choice',
      prompt:
        '凌晨账单突然飙升，值班同学把部署状态切到 `kill`。五分钟后告警炸了：所有实例在不停重启，用户连作业状态页都打不开。健康检查用的是 lab 的 `healthCheck`，它被接到了 K8s 的 liveness 探针上。哪个诊断和修法是对的？',
      options: [
        { id: 'a', label: 'kill 本来就该让服务整体停下，重启是预期行为' },
        { id: 'b', label: '应该用 drain 而不是 kill：drain 不会让健康检查变红' },
        {
          id: 'c',
          label:
            '`healthCheck` 把 kill 判成 `ok:false`，而 liveness 失败会重启容器。要把 liveness（进程活着）和 readiness（能接新活）拆开，kill 只影响后者，并且 kill 下仍允许 cancel 与 read',
        },
        { id: 'd', label: '把 kill 写进系统提示，让模型自己停止副作用，就不用动健康检查了' },
      ],
      correct: ['c'],
      explain: `C。

K8s 探针的语义：liveness 失败 → 重启容器；readiness 失败 → 从负载均衡里摘掉。lab 的 \`healthCheck\` 有一项 \`deploy_mode\`，kill 时为 false，整体 \`ok:false\`（DEP-6）。接到 liveness 上，按下 kill 的那一刻编排层开始重启所有实例；接到 readiness 上，所有实例被摘流，状态页都打不开。**你想停的是新副作用，结果停了整个服务。**

lab 还有第二个缺口：\`admitUnderDeploy\` 只有 \`new_job\` / \`resume\` / \`effect\` 三种，kill 下全拒——**没有 \`cancel\` 和 \`read\`**。kill 之后用户既不能取消作业，也不能查看状态。生产里这两种要放行。

---

**A** 混淆了目的和手段。kill 的目的是"一切新副作用停止"，不是宕机。

**B** 混淆了两种模式的语义：

| 模式 | 新任务 | 续跑 | 副作用 |
|---|---|---|---|
| drain | 拒绝 | 允许 | 允许 |
| kill | 拒绝 | 拒绝 | 拒绝 |

drain 是发布用的：进行中的作业继续跑、继续花钱。账单尖刺时用 drain，钱照样在烧。这两者的不对称是故意的。

**D** 是这一节明确反对的做法。Anthropic 的 auto mode 文章把"边界在上下文压缩中丢失"列为一类风险；Replit 事件的公开报道里，agent 违反了明确的代码冻结指令。**写在 prompt 里的约束受压缩、注入和遗忘影响**——kill switch 必须是部署状态，由编排层在每次副作用之前检查，不经过模型（DEP-4）。`,
    },

    {
      id: 'ops-bugs',
      kind: 'debug',
      prompt:
        '下面是某同学对 L19 三个函数的实现。verify 跑下来挂了好几条，但他说"逻辑看起来都对"。找出**至少五个** bug，说明每一个在线上会造成哪种"看起来像成功"的双份或泄露，并指出对应的断言。',
      lang: 'ts',
      code: `function onCheckpoint(
  job: Job,
  ev: { workerId: string; epoch: number; checkpoint: Checkpoint; now: number },
): TransitionResult {
  if (job.status !== 'running') return fail('checkpoint 仅 running')
  if (job.workerId !== ev.workerId) return fail('worker 不匹配')
  if (job.checkpoint && ev.checkpoint.seq < job.checkpoint.seq) return fail('seq 回退')
  return ok({ ...job, checkpoint: ev.checkpoint, updatedAt: ev.now })
}

function startJob(input: StartJobInput): StartJobVerdict {
  if (input.deploy.mode === 'kill') return reject('kill switch')
  if (input.idempotencyKey && input.priorJob?.idempotencyKey === input.idempotencyKey) {
    return { kind: 'replay', job: input.priorJob }
  }
  const a = admitJob(input.usage, input.policy, input.estimatedCostUsd, input.estimatedTokens)
  return a.ok ? { kind: 'start' } : reject(a.reason)
}

function classifyError(code: string): RetryClass {
  if (code.startsWith('429') || code.startsWith('5')) return 'transient'
  if (code === 'CONFLICT' || code === 'PERMISSION') return 'permanent'
  return 'unknown'
}`,
      rubric: [
        '你有没有发现 `onCheckpoint` 没有比较 epoch？同名 worker 重新认领后，GC 醒来的旧进程能写进去。',
        '你有没有发现它也不看租约是否过期？租约过期、还没人来抢时，僵尸能继续写。',
        '你有没有注意到 `<` 应该是 `<=`？同 seq 的重复投递会覆盖已有 checkpoint。',
        '你有没有发现 `startJob` 只拦 kill、不拦 drain，也没比较 userId 和 payloadHash，还会把进行中的作业当结果重放？',
        '你有没有发现 `startsWith(\'429\')` 把 `429_SPEND` 和裸 `429` 都判成了 transient？',
        '你能为每个 bug 说出它在线上的症状吗？它们几乎都不抛异常。',
      ],
      reference: `八个问题，分属三个函数。它们的共同点是**都不抛异常**：每一个都让某种重复或泄露以"成功"的形态通过。

## onCheckpoint：三个

**1. 没有比较 epoch（JOB-11）。**

    if (job.workerId !== ev.workerId) return fail('worker 不匹配')
    // ← 缺 job.epoch !== ev.epoch

同名 worker 重新认领后，GC 停顿醒来的旧进程带着同一个 workerId，写入被接受。两个进程对同一个作业各写各的 checkpoint。workerId 回答"你是谁"，epoch 回答"你是第几次被授权"——只有后者拦得住僵尸。

**2. 没有检查租约是否过期。**

lab 的 \`fence()\` 第三行是 \`now > job.leaseUntil → 租约已过期\`。缺了它，租约过期、还没人来抢的那段时间里，旧 worker 能继续写、继续心跳续命。

**3. \`<\` 应该是 \`<=\`（JOB-4）。**

    if (job.checkpoint && ev.checkpoint.seq < job.checkpoint.seq)

同 seq 的第二次写入会**覆盖**已有的 checkpoint。队列是 at-least-once，同一条 checkpoint 被投递两次是常态；如果两次内容不同（比如中间工作区变了），后到的那份静默胜出。不变量是"严格递增"，同 seq 拒绝而不是覆盖。

## startJob：四个

**4. 只拦 kill，不拦 drain（START-1）。**

drain 的语义是"拒收新任务，进行中的可续跑"。这个实现在滚动发布期间照样接新作业——新作业落在一个即将被 SIGTERM 的实例上，K8s 默认 30 秒的宽限期内根本跑不完。正确做法是调 \`admitUnderDeploy(deploy, 'new_job')\`，让 drain 和 kill 都拒。

**5. 没有比较 userId（START-4）。**

bob 用 alice 用过的 key，拿到了 alice 的整份作业。这是本课调研里唯一一条直接泄露数据的缺陷。跨租户的同 key 要当作"没有 prior"，而且存储主键要是租户加 key。

**6. 没有比较 payloadHash（START-5）。**

同一个 key 配一个新 prompt，返回的是旧 prompt 的作业。按 Stripe 的语义，同 key 不同参数应该报错，而不是重放。

**7. 把进行中的作业当结果重放。**

只有终态作业的结果可以重放（START-3）。对进行中的同 key 作业，lab 返回 \`reject: 同 idempotencyKey 任务仍在进行\`；生产里更好的做法是把作业 id 还给客户端让它去订阅。但无论哪种，都不能当成"结果"。

## classifyError：一个大的，外加两个小的

**8. \`startsWith('429')\` 把花费上限当成了瞬时（RETRY-7、RETRY-8）。**

\`429_SPEND\` 和裸 \`429\` 都会被判 transient。花费上限的 429 不带 \`retry-after\`，重试在额度恢复前永远失败——于是作业在那里指数退避到超时，占着 worker。lab 的规则：\`429_RATE\` 可重试，\`429_SPEND\` 和裸 \`429\` 一律 permanent。

两个小问题：\`startsWith('5')\` 会把 \`501\` 这种"服务端不支持"的错误也当成瞬时；\`409\` 没被列入 permanent，落到 unknown，而 unknown 对 \`idempotent_write\` 是允许重试的——冲突会被反复重放。

## 一条方法论

这八个 bug 里，有六个在"单 worker、单用户、不发布"的开发环境里**完全撞不到**。这就是这一节的意思：上线之后，四个默认（一个进程、一个用户、一条连接、一个人在看）同时失效，而每条断言守的正是其中一个默认失效时的那条静默路径。`,
    },

    {
      id: 'approval-policy',
      kind: 'design',
      prompt:
        '为一个同时支持「交互式」和「后台无人值守」两种模式的 coding agent 设计审批策略。要回答：什么该问、问几次、怎么记住、被拒之后怎么办、无人值守时怎么办。说明你**拒绝**做什么，以及 lab 现有的 `recallApproval` 哪些能直接用、哪些要补。',
      scenario:
        '现状：每个工具调用都弹窗。数据显示用户几乎全点允许。产品经理提议加一个「永远允许这个工具」的勾选框；安全同学反对，但给不出替代方案。下个季度还要上线「夜里后台跑任务、早上看 PR」的功能。',
      reference: `这题没有唯一答案，但有几个点能区分"想过"和"没想过"。

## 一、先读懂"几乎全点允许"

Anthropic 公布过两个数字，**出处和口径不同，引用时不能混用**：

- *Claude Code auto mode* 工程文章：用户批准了 93% 的权限提示；auto mode 分类器在"真实的过度主动动作"上漏报 17%。
- Anthropic 沙箱工程博客：97%；对**计划**的拒绝率 39%，对**单个权限请求**只有 3%。

合理的推断（不是文章原话）：人在计划层还会判断，在单个请求层已经条件反射。所以高批准率不是"流程健康"，而是"每次都问"已经失效的信号。PM 的方向（减少打扰）是对的，方案（永远允许整个工具）是错的。

## 二、问不问按风险，不按工具

| 风险类别（L14 \`classifyRisk\`） | 问不问 | 记多久 | scope |
|---|---|---|---|
| 只读 | 不问 | — | — |
| 工作区内编辑 | 首次问 | session | 路径段边界 |
| 跑测试或构建 | 首次问 | ttl | 规范化命令段集合 |
| 联网 | 首次问 | session | 域名，不含子域 |
| 高风险（删除、push、改 CI、写 secrets） | 每次问 | 只 once | 具体参数 |

Claude Code 自己也是按工具分别定寿命的：Bash 的"不再询问"按项目目录加命令永久记住，文件编辑到会话结束，WebFetch 按域名。

## 三、scope 的三种形态

**路径**：段边界，不是精确也不是前缀。\`/repo\` 覆盖 \`/repo/a.ts\` 和 \`/repo/\`，不覆盖 \`/repo-evil\`；先规整 \`.\` 和 \`..\` 再比。这一块 lab 的 \`scopeCovers\` 可以直接用。符号链接归 L17 的路径层，且排在审批记忆之前。

**命令**：Claude Code 的规则是复合命令按 \`&&\`、\`||\`、\`;\`、管道拆开，**每一段**都要匹配，\`timeout\`、\`nice\` 这类包装器先剥掉。否则"允许 \`npm test\`"会被 \`npm test && curl …\` 搭便车。lab 把命令也当路径处理（\`git\` 在词法上覆盖 \`git/push\`），**这一块要补**。

**域名**：精确匹配，子域要显式授权。

## 四、deny 优先，而且难以被覆盖

评估顺序 deny → ask → allow。lab 的 \`recallApproval\` 已经做到 deny 压过 allow、与数组顺序无关（MEM-7），可以直接用。

但 \`rememberApproval\` 按用户、工具、scope 覆盖旧条目，**不看 mode**：对同一 scope 先记一条 session 级 deny，再记一条 once 级 allow，deny 就没了。生产里 deny 应该只能被显式撤销。

## 五、被拒之后：作业继续

拒绝作为 **tool result** 回给 agent，让它换路；累计 3 次连续或 20 次总拒绝再升级给人（auto mode 的阈值）。作业**不取消**——取消会逼用户永远点允许。

lab 的 \`deny\` 已经回到 \`running\`（JOB-12），但不存理由、没有计数，**这两块要补**。

## 六、无人值守：不问，但有围栏

后台模式没有人能回答。Claude Code CLI 的做法是 \`--permission-prompts none\`：需要提示的权限一律拒绝。所以策略是**启动前一次性预授权一个白名单，其余默认拒绝**，拒绝过多就以失败结束而不是挂起等人。

审批之外，防线前移到部署形态：凭据不进沙箱（Claude Code 网页版由沙箱外的 git 代理认证）；secrets 只在 setup 阶段可用（Codex cloud 在 agent 阶段开始前移除它们）；出站白名单；最终靠 PR 评审。作业以**发起者**的身份和配额运行。

## 七、拒绝做的事

- **不做"永远允许这个工具"。** 它把 scope 从"这块地方"放大成"一切地方"，寿命放大成永久。
- **不做前缀匹配。** \`/repo-evil\` 是同一个洞。
- **不让 deny 取消作业。** 理由见第五节。
- **不把限制写进 prompt。** 压缩会把它压掉；kill switch 和审批都在模型之外。
- **不把高风险动作记住。** 每次都问的成本，远低于一次被记住的 \`git push --force\`。

## 八、和 lab 的对账

能直接用：\`scopeCovers\`（路径段边界）、\`recallApproval\`（deny 优先、ttl 过期、session 绑定）、\`consumeOnce\`、\`deny → running\`。

要补：按风险定默认 mode（L21 留了这道练习）、命令段规范化、deny 只能显式撤销、拒绝理由回写、拒绝计数与升级、无人值守的预授权白名单。`,
      rubric: [
        '你有没有把"批准率高"读成疲劳信号，并且引用数字时带上出处和口径（93% 与 97% 来自两篇文章）？',
        '你的"问不问"是按风险类别分的，而不是按工具一刀切吗？高风险动作是不是每次都问、只允许 once？',
        '你的 scope 是路径段边界吗？你有没有区分路径、命令（复合命令拆段）、域名三种形态？',
        '你有没有让 deny 优先于 allow，并考虑 deny 被后来的 allow 静默覆盖的问题？',
        '被拒之后作业是继续（拒绝回给 agent）还是取消？有没有计数与升级？',
        '无人值守模式下，你是靠预授权白名单加默认拒绝，还是假装还有人能回答？',
        '你能准确说出 lab 已经做了什么、哪些是你要补的吗？',
      ],
    },
  ],
}
