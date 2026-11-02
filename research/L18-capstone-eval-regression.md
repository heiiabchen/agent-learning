# L18 调研报告 · Capstone 二：让它可衡量

> 调研日期：2026-10-09　·　目标读者：本课程的出题人/讲稿作者（不是学员）
> 课程框架：L18 = 「一套能证明『我改的这版确实更好』的评测与回归体系」（curriculum.ts L18 条目）
> 本报告写给：L18 的 `content.mdx`、`labs/shared/*`、`labs/l18/{bench,verify,runner}.{ts,py}` 的作者。
>
> **证据标记**（沿用 L17 报告）：
> `[P]` 一手：论文 / 官方文档 / 仓库 / 官方博客，本轮已读原文或原文摘录
> `[P2]` 近一手：二手报道转述一手，或一手但本轮只读到摘要
> `[S]` 二手/社区/记忆，**未复核**，列入 §15 的未溯源清单
> `[L]` 本地仓库事实（读过代码/文档）
> `[O]` **本报告自产证据**：我在本机跑过的探针，方法与数字在 §12，可复现

---

## 0. 一句话结论

**L18 不是「怎么算一个成功率」，而是「怎么让一个差值有资格被相信」。**

coding agent 评测里，每一个数字背后都有一条**不抛异常**的路径把它变成假的：分母换了、任务本身坏了、答案在沙箱里、方差没算、改动只是换了一批 bug、成本被藏在「只算成功的」里、基线是一次运气、门禁的语义写反了。L17 证明了「能不能改对」（一次编辑循环可信），L18 要证明的是「**这一版比上一版好，而且我能说出证据有多硬**」。

本调研得出三条贯穿全课的主张：

1. **分数是一个多元函数，不是一个量。** `score = f(任务集版本, 任务有效性, 泄漏面, harness, 资源配置, scaffold 版本, 重试/并行策略, 分母策略, 价格表)`。任何一个自变量没写进结果的「键」，两个分数就不可比。（INV-1…12, 48–50）
2. **对决策有意义的量只有三个：配对差值、它的不确定性、成本。** 水平值（「我们 62%」）几乎不承载决策；差值要用**配对 + 精确检验 + 噪声底校准**才有资格；成本要用**预算截断曲线**而不是「按花费分桶」。（INV-13…31, 39–46）
3. **零模型 CI 能测的是「评测系统自身」，不是「agent」。** 任务有效性审计、判定器、统计器、门禁语义、泄漏/越界轨迹审计、基线键——这些都可以在零模型调用下被严格断言；而 agent 的真实成功率只能在 nightly live 里量。L18 的 verify 应该把 90% 的断言花在前者。（§6, §9）

### 0.1 相对 L17 报告的更新项（必须在 L18 讲稿里补注）

| 项 | L17 报告说法 | 2026-07…09 之后 | 来源 |
|---|---|---|---|
| SWE-bench Pro | L17 INV-59 引用了 OpenAI 2026-02「我们推荐 SWE-bench Pro」 | **OpenAI 于 2026-07-08 撤回该推荐**：审计 731 题公开集，估计 ~30% 坏题（自动管线标 200 = 27.4%，人工标 249 = 34.1%），明确不推荐替代品 | `[P]` OpenAI *Separating signal from noise in coding evaluations* |
| Pro 的「反作弊」 | L17 未涉及 | 2026-09-08 *SWE-Bench Pro Verified*（arXiv 2609.08149）：731 题重建为单 commit 仓库 + 屏蔽代码托管域名后，GLM-5.2 从 78.80% 掉到 57.32%（−21.48pp），186 题 P→F vs 15 题 F→P，McNemar p<0.001 | `[P]` |
| 「基准有半衰期」 | 未显式讲 | Verified（2026-02 弃用）→ Pro（2026-07 撤回）→ Pro Verified（2026-09）；aider polyglot 自 2025-08-23 起 88.0% 未动；Terminal-Bench 2.0→4.0 因资源/饱和重做 | `[P]` + `[P2]` |

→ **含义**：L18 讲稿不应再推荐任何「当前最好的公开基准」，而应讲「**如何不依赖任何单一基准的存活**」：自有任务集 + 外部锚点 + 结果键里记录基准版本/哈希。

### 0.2 本轮意外发现：`labs/l18/` 与 `shared/codingEval.ts` 已有一版草稿

调研途中发现工作区已有（时间戳 2026-10-09 14:14–14:16）：
`labs/shared/codingEval.ts`（569 行）、`labs/shared/coding_eval.py`（459 行）、`labs/l18/{bench.ts,bench.py,verify.ts}`（5 个观察实验、6 个 TODO、45 条断言；`BENCH_IMPL=shared node l18/verify.ts` 实测 45/45 通过，`bench.ts` 与 `bench.py` 输出逐字节一致）`[L][O]`。

因此本报告的 lab 设计采取「**审计 + 增量扩展**」而非「另起炉灶」：§8 列出对现有草稿的 14 条缺陷（其中 5 条有实测证据，包括一条**门禁语义写反**、一条**TS/Python 排序不一致的潜在字节差异**），§9 给出在其上的扩展方案（5 个实验骨架全部升级并新增 2 个、6 个 TODO 中 2 个并入 T1/3 个升级/1 个替换并新增 T2、T4、45 条断言中 37 条原样保留 + 8 条修订，再新增 45 条，共 90 条）。

---

## 1. 倒置清单（INV-1 … INV-55）

> 格式：**流传说法 → 实际 → 来源 → 后果 / lab 钩子**。
> 分组：A 任务集与基准可信度（1–12）· B 指标会说谎（13–31）· C 消融（32–38）· D 配对与 A/B（39–46）· E 回归门禁与评测基础设施（47–55）。
> 数字全部带来源标记；「本地草稿」指 §0.2 的现有文件。

---

### A. 任务集与基准可信度

#### INV-1　「人工验证过的基准 = 干净」→ 连续两个「验证过的」都被拆了
- **实际**：SWE-bench Verified（500 题，93 名标注者）被 OpenAI 审计：模型常失败的 138 题子集里 **59.4%** 测试或题面有实质问题（L17 INV-59/60 已覆盖）。接着 OpenAI 推荐的 SWE-Bench Pro 在 2026-07-08 被**自己撤回**：731 题公开集估计 **~30%** 坏题；自动管线标 200（27.4%），5 名工程师人工标 249（34.1%），两边一致率仅 74%。四类缺陷：测试过严、题面欠规格、测试覆盖低、题面误导。
- **来源**：`[P]` OpenAI *Why we no longer evaluate SWE-bench Verified*；`[P]` OpenAI *Separating signal from noise in coding evaluations*（2026-07-08）；`[P2]` the-decoder 对一致率 74% 的转述。
- **后果**：L18 讲「任务集构建」时第一课不是「怎么选题」而是「**怎么证明你的题没坏**」。lab 钩子：`auditTaskRecord`（SET-10…12）。

#### INV-2　「F2P/P2P 保证任务有效」→ 它只证明「gold 过、base 红」，不证明「题面够用、测试不过严」
- **实际**：F2P/P2P 是**从原 PR 的测试里机械抽出**的。OpenAI 指出：这些测试"为验证某一次具体改动而写，不是通用需求"，所以会断言题面没提的字符串/类型/顺序。*SWE-Bench Pro Verified* 修了 102 题：其中 75 题测试断言了 prompt 没点名的字符串/类型/顺序，22 题 prompt 指向错误的 flag（例：题面说 `--token`，测试要求错误信息以 `--api-key` 开头）；修好后 GLM-5.2 在这 102 题里多拿 21 个 pass。
- **来源**：`[P]` OpenAI 2026-07-08；`[P]` arXiv 2609.08149；75/22 的拆分来自 `[P2]` Reid Marlow 对论文的转述（论文表格本轮未逐行核对）。
- **后果**：任务记录里除 `failToPass/passToPass` 还要有**题面可见性检查**：测试里引用的标识符，题面或 base 仓库里必须能找到（`undeclaredRequirements`，LEAK-2，零模型）。

#### INV-3　「gold patch 通过 = 任务可解」→ 必要条件，不是充分条件
- **实际**：Anthropic 的做法是给每个任务写**参考解**，证明"任务可解、判定器配置正确"；并指出前沿模型上 **0% pass@100 最常见的原因是任务坏了**，不是 agent 不行。但「参考解过」不能排除「别的合理解被拒」：UTBoost 用 LLM 生成补充测试，在 SWE-bench Lite 发现 23/300、Verified 发现 26/500 题测试不足，揭出 345 个原先被判通过的错误补丁。
- **来源**：`[P]` Anthropic *Demystifying evals for AI agents*；`[P]` UTBoost（ACL 2025，arXiv 2506.09289）。
- **后果**：任务有效性的**四件套**（零模型可断言）：①base 上 F2P 红；②gold 上全绿；③**空补丁不过**（否则题是空转的）；④gold 重跑 3 次一致（排 flaky）。SET-10…12 / SET-13（可选）。

#### INV-4　「P2P 越多，回归保护越强」→ P2P 里的 flaky 测试会制造**假的「弄坏」**
- **实际**：SWE-bench 官方 issue #167：维护者表示间歇失败的测试**大多是 P2P 测试**，拟议的处理方式是**把 flaky 的 P2P 从数据集中剔除**（用 gold patch 重复跑识别；issue 里写明当时「尚未执行」）。SWE-bench-Live 在建集时每个实例**重复验证 3 次**，只保留 F2P/P2P 结果一致的；其 README 仍警告"不同机器上失败的测试可能不同，docker 不保证完全隔离"，建议在你自己的机器上把 gold 跑 3 遍，**分母用 gold 仍通过的实例数**。
- **来源**：`[P]` swe-bench/SWE-bench issue #167；`[P]` microsoft/SWE-bench-Live `Development.md` 与 `evaluation/README.md`。
- **后果**：一个 flaky P2P 就足以让配对比较里出现一个「broken」——L12 的「弄坏 ≥3 就拦」会被它直接触发（INV-42）。任务集校验必须带 `flakyTests` 字段，且**gold 重跑是 runner 侧的离线动作，不是 verify 的动作**（需要沙箱，但不需要模型）。

#### INV-5　「题面就是原始 issue，是干净输入」→ 答案常常就写在 issue 里
- **实际**：SWE-bench+ 对 SWE-Agent+GPT-4 的成功补丁做人工比对：**32.67%** 的成功补丁里解法已直接写在 issue/评论里（solution leakage），**31.08%** 因弱测试而可疑；过滤后 resolve rate 从 12.47% 掉到 **3.97%**（Lite：18%→9.33%；Verified：22.4%→10.0%）；且 >94% 的 issue 创建于模型知识截止日之前。
- **来源**：`[P]` SWE-Bench+（arXiv 2410.06992）。
- **后果**：零模型的 `statementLeak(statement, goldPatch)`：gold patch 的新增行里有多大比例逐字出现在题面。对**自建任务集**尤其重要——你写题面时最容易顺手把答案写进去。LEAK-1。

#### INV-6　「污染 = 训练集见过」→ 对 coding agent，更大的是**评测时泄漏**
- **实际**：*SWE-Bench Pro Verified* 的轨迹审计：731 次基线运行里**至少 103 题**能在本地读到答案、**49 题**能走网络拿到答案；`git show <SHA>` 共 **2,108 次操作 / 326 题**，`raw.githubusercontent.com` 命中 318 次 / 54 题。四条通道：`git log/show` 恢复 gold、读沙箱文件系统、直接拉仓库、利用 `instance_id` 里的项目名+SHA。加反作弊后 GLM-5.2 掉 21.48pp；186 个 P→F 里 166 个被标为「直接使用泄漏文件」，3 个高度可能，17 个是噪声。
- **来源**：`[P]` arXiv 2609.08149；操作计数 `[P2]` Reid Marlow 转述。
- **后果**：「污染」要拆成两类讲：**训练期记忆**（不可审计，只能用时间窗/私有集缓解）和**评测期泄漏**（可审计、可堵、可**零模型地检测**）。L17 的 `detectHacks` 查的是 diff；L18 要加一层**命令轨迹审计** `auditTrace`（TRC-1…）。

#### INV-7　「把答案藏起来 = 过滤 git 历史」→ 要**重建**，不是过滤
- **实际**：Pro Verified 的做法是把每个仓库**重新构造为单 commit 的全新仓库**、隐藏评测产物、**对 instance_id 做哈希**使其不再携带 SHA、过滤并匿名化元数据与路径、屏蔽 GitHub/GitLab/Gitee/Bitbucket/raw-content 域名。不是在原仓库里删分支。
- **来源**：`[P]` arXiv 2609.08149；`[P2]` Reid Marlow。
- **后果**：自建任务集的构造规程：`git init` 于 base 快照的**拷贝**，不继承任何 refs/reflog/stash/object；任务 id 用不含 commit 信息的短 id。零模型钩子 `leakSurface(repoSnapshot)`：给定一个**结构化的仓库快照描述**（refs、对象时间戳、id 字符串），列出 base 之后的可达对象。LEAK-3。

#### INV-8　「更新鲜的任务集就没污染」→ 鲜度和样本量是一对冤家
- **实际**：SWE-rebench 每月从活跃 Python 仓库收新 issue，跟踪每个 issue 创建日 vs 模型发布日，**标记「issue 早于模型发布」的评测为可能污染**；但它自己说「older windows become contaminated over time」，且当前默认窗口只有 **111 题 / 65 个仓库**（2026-05-15…07-01）。111 题的二项标准误 ≈ 4.5pp（`[O]` √(.645×.355/111)）。
- **来源**：`[P]` swe-rebench.com `/about` 与榜单页。
- **后果**：「用新题抗污染」直接撞上 INV-24/25 的功效问题。自建集的解法：**任务入库时间戳 + 模型发布日表**，把「入库晚于所测模型发布日」的题单独汇报（现有草稿的 `contaminated` 布尔位不够，应改为 `createdAt` 派生）。

#### INV-9　「跨基准的分数可以直接比」→ 是不同的人用不同的 scaffold 跑不同的题
- **实际**：SWE-bench Multilingual 的参考结果：SWE-agent + Claude 3.7 Sonnet（$2.50/题上限）**43%（128/300）vs Verified 63%**——作者自己写明"只评了一个模型"。SWE-Bench Pro 的商业私有子集比公开集低：Claude Opus 4.1 22.7%→17.8%，GPT-5 23.1%→14.9%（Scale 自己的博客）。Pro 公开集在 8 个月里从 23.3% 涨到 80.3%（the-decoder）——撤回事件之后这个涨幅里有多少是泄漏、多少是真能力，不可分。
- **来源**：`[P]` swebench.com/multilingual；`[P]` Scale *SWE-Bench Pro* 博客；`[P2]` the-decoder。
- **后果**：外部基准在 L18 只作「**锚点**」：记录基准名+版本+scaffold+预算，只比「同一 scaffold 下的相对排序」，永不比绝对值。

#### INV-10　「难度分层按 gold patch 大小」→ 还需要**结构特征 + 结果历史**两路
- **实际**：SWE-bench 系基准的难度极不均匀，Verified 里 Django 约占一半、少数仓库占大头（`[S]` Epoch AI 统计，本轮未复核，见 §15 N-3）；Terminal-Bench 4.0 的做法是**移除被所有测试智能体 5/5 解出的饱和任务**并重新校准资源。现有草稿的 `difficulty: easy|medium|hard` 是人工贴标，没有来源字段。
- **来源**：`[P]` tbench.ai *Terminal-Bench 4.0*；`[S]` Epoch。
- **后果**：分层键应由**机器可算的特征**生成（gold diff 文件数/hunk 数/行数、F2P 数、仓库、语言）+ 由**结果历史**更新（连续 N 次全过 = 饱和；连续 N 次全挂 = 待审查，INV-3），而不是手贴 easy/hard。

#### INV-11　「通过率 100% = 做得好」→ 要分两个套件，并有「毕业」规则
- **实际**：Anthropic：**capability eval** 应从低通过率起步，给团队一座要爬的山；**regression eval** 应接近 100%，下降就意味着有东西坏了；高通过率的 capability 任务应「毕业」进 regression 套件。Terminal-Bench 4.0 同理移除饱和任务。
- **来源**：`[P]` Anthropic *Demystifying evals*；`[P]` Terminal-Bench 4.0 公告。
- **后果**：同一份 `TaskInstance[]` 要有 `suite: 'capability' | 'regression'`，毕业规则可零模型断言（给定历史通过记录，哪些题该毕业）。L12 的 `detectRot` 讲过「腐化」，L18 的新增是**编码任务专用的毕业/退役阈值与「它们进门禁时的语义」不同**（INV-45）。

#### INV-12　「0% 通过说明 agent 不行」→ 先查「测试要求的东西题面里有没有」
- **实际**：Anthropic 审计 Terminal-Bench 发现：任务要求"写个脚本"却没给路径，测试却假定某个路径——agent 无辜地失败。OpenAI 与 Pro Verified 的缺陷分类（题面欠规格、测试过严）与此同构。
- **来源**：`[P]` Anthropic；`[P]` OpenAI；`[P]` arXiv 2609.08149。
- **后果**：零模型规则 `undeclaredRequirements(testPatch, statement, baseSymbols)`：测试新增的断言里出现的字面量/标识符，既不在题面也不在 base 仓库符号表里 → 标「题面不足」。这是**把 OpenAI 的人工审计变成 CI 里一条规则**。LEAK-2。

---

### B. 指标会说谎

#### INV-13　「成功率」指的是什么？pass@1 有三种定义
- **实际**：pass@1 可以是 ①**单次运行**的比例，②**每题 n 次运行的 c/n 再取平均**（τ-bench 定义 pass^1 = pass@1 = E[c/n]），③**取第一个 attempt**。SWE-agent 论文用 6 次独立运行：每次 resolved% 分别 17.33/18.00/18.00/18.67/17.33/18.33，均值 **17.94 ± 0.49**；SWE-rebench 每个模型跑 5 次，报**均值 + SEM + pass@5**；Anthropic 的 Sonnet 4.5 发布也强调"多次运行平均"。
- **来源**：`[P]` SWE-agent 附录 B.5 Table 10；`[P]` swe-rebench.com `/about`；`[P]` τ-bench。
- **后果**：`Attempt` 必须有 `trial` 字段；所有「率」函数要声明 `n` 与聚合方式。现有草稿 `resolvedByTask` 只取「首次 attempt」，丢掉了重复运行（D-6）。

#### INV-14　「pass@k 越高越强」→ 它在量**你多开了几次枪**
- **实际**：SWE-agent 同一配置：pass@1 **17.94 → pass@6 32.67**（1.82 倍）；aider polyglot：gpt-5(high) `pass_rate_1` **52.0** vs `pass_rate_2` **88.0**——后者是**拿到测试失败反馈后的第二次尝试**，榜单头条用的是 `pass_rate_2`。Kapoor 等人指出：准确率可以通过重试、预热、升级等「科学上无意义」的手段刷高，因此必须和成本一起报。
- **来源**：`[P]` SWE-agent Table 10（pass@k 17.94, 23.89, 27.35, 29.67, 31.33, 32.67）；`[P]` aider leaderboard（gpt-5 high：Pass rate 1 52.0 / Pass rate 2 88.0 / Seconds per case 194.0 / Total cost 29.0829）；`[P]` *AI Agents That Matter*。
- **后果**：任何「成功率」旁边必须带**尝试策略标签**（`single` / `best-of-k` / `retry-with-feedback`），它们是**不同的系统**，不是同一系统的不同度量。

#### INV-15　「pass^k = pass@1 的 k 次方」→ 只在每题难度相同时成立；真实任务是**重尾**的
- **实际**：Anthropic 的例子"75% 单次成功率，3 次全过 (0.75)³≈42%"假设**每题成功概率相同且独立**。真实分布里，大量题近乎必过、大量题近乎必挂。**用 SWE-agent 的真实 pass@k 反推**：`[O]` 若各题同质，pass@6 应为 1−(1−0.1794)⁶ = **69.5%**，实测 **32.67%**；k=2：32.7% vs 23.89%；k=3：44.7% vs 27.35%；k=4：54.7% vs 29.67%。同理 pass^k 会**比 p̂^k 高得多**：Beta(½,½) 异质性下 pass@1=0.5 时，`[O]` pass^8 = 19.6%，而天真的 0.5⁸ = 0.39%。
- **来源**：`[P]` Anthropic（公式）；`[P]` SWE-agent Table 10（数据）；`[O]` 计算见 §12.2。
- **后果**：**不要用 p̂^k 估 pass^k**；用每题 c/n 的无偏估计（INV-16）。EXP-3 一张表把这件事展示出来。

#### INV-16　「pass@k 取前 k 次、pass^k 取前 k 次全过」→ 浪费数据且有偏差
- **实际**：Codex 论文（Chen et al. 2021）给出 pass@k 的**无偏估计** `1 − C(n−c,k)/C(n,k)`，并指出 `1−(1−p̂)^k` 有偏。τ-bench 同理给 pass^k = E[C(c,k)/C(n,k)]。**只取前 k 次**既丢掉 n−k 次数据，又让结果依赖运行顺序。零模型实现只需 `+ − × ÷`：`pass^k = ∏_{i<k}(c−i)/(n−i)`，`pass@k = 1 − ∏_{i<k}(n−c−i)/(n−i)`（两门语言逐位一致，无 log/exp）。
- **来源**：`[P]` Chen et al. *Evaluating LLMs Trained on Code* App. A；`[P]` τ-bench。
- **后果**：本地草稿 `passAtK/passHatK`（codingEval.ts L208–L236）取 `slice(0,k)`，并且按「每题至少 k 次」过滤任务，导致分母随 k 变化（D-2）。PK-1…4。

#### INV-17　「resolve rate = apply rate × 测试通过率」→ 对工具型 agent，apply 近乎恒为 100%，该看的是**漏斗**
- **实际**：SWE-bench 原论文同时报 `% Resolved` 和 `% Apply`——对**一次性生成 diff** 的检索基线，apply 失败是大头；但 L17 的 agent 在循环里**逐步应用编辑**，apply 的失败变成「工具调用返回 NOT_UNIQUE/NOT_FOUND 后的恢复行为」。SWE-agent 论文在 2,294 题上报告：1,185 题（**51.7%**）出现过被 lint 拦下的失败编辑（本轮读到的摘录在此处被截断，语义以论文 §5.1 为准）；未解决实例里 52.0% 属于「实现不正确/过于特化」，23.4% 是「级联失败的编辑」。
- **来源**：`[P]` SWE-bench 论文；`[P]` SWE-agent §5 与 B.4。
- **后果**：「成功率口径」的正确表达是**漏斗**：`提交 → 补丁可应用 → 测试可运行 → F2P 全绿 → P2P 未破 → 无 hack 标记 → resolved`，每一级是前一级的子集，分母统一。`funnel(attempts)`，FUN-1…2。现有草稿的 `rateSpectrum` 把 apply/f2p-only/naive/resolve 并排，**四个口径在 demo 数据上只有三个不同值**（f2p-only 与 naive+hacks 同为 58%，D-13）。

#### INV-18　「分母是 500 题」→ 分母是一个**需要声明的政策**
- **实际**：同一份原始结果可有多种「官方」headline：OpenAI 报 GPT-4.1 在 Verified 的 477 题子集上 54.6%（若把省略的 23 题按 0 算则 52.1%）；Anthropic 报 Claude 3.7 Sonnet 在"在我们基础设施上可运行的 489 题"上 70.3%。SWE-bench 官方 harness 把结果分为 resolved / unresolved / empty patch / error（无 report.json）/ 疑似基础设施失败 / 其它，并提示「`0 failed` + `errors: 1` 表示没崩溃但有一题没法评分」。
- **来源**：`[P]` OpenAI GPT-4.1 发布页脚注；`[P]` Anthropic Claude 3.7 发布页；`[P]` swe-bench `docs/guides/evaluation.md`。（477/489 数字取自本轮早前检索，见 §15 M-2。）
- **后果**：**三种分母政策**：`all`（所有题，错误当 0）、`graded`（仅成功评分的题）、`errorAsFail` 与 `errorRerun`（需 runner）。同一份 `Attempt[]` 在三种政策下 headline 不同；现有草稿 `applyRate`（n = 全部）与 `resolveRate`（n = 去掉 error）**分母不一致**（D-1）。EXP-1 的第二张表。

#### INV-19　「基础设施错误不是我的事」→ 资源配置本身就是被测变量
- **实际**：Anthropic 在 Terminal-Bench 2.0 上用同一模型/harness/任务集跑 6 种资源配置：从严格 1× 到完全不限，**成功率差 6pp（p<0.01）**；基础设施错误率 5.8%→0.5%；1×→3× 的错误下降（5.8%→2.1%）p<0.001；超过 3× 后"成功率再涨近 4pp"，因为额外资源让 agent 能试**只在宽裕配额下才可行**的方案（拉大依赖、起昂贵子进程、跑吃内存的测试）。结论：资源上限"应被视为基准定义的一部分"，报告里要写运行时设置、超时策略、infra 错误率。Terminal-Bench 4.0 随后按此方法校准资源并去掉饱和任务。
- **来源**：`[P]` Anthropic *Quantifying infrastructure noise in agentic coding evals*（2026-02）；`[P]` tbench.ai 4.0 公告。SWE-bench-Live README 也写明单实例预估 4 CPU/16 GB，C++ 大仓库甚至 50 GB。
- **后果**：`runKey` 里必须含 `resources: {cpu, memGb, timeoutS}`；`error` 标签要区分 `infra` 与 `agent`；门禁要对 **infra 错误率设阈值**（超过则「无法评分」而非「分数下降」，GATE-8）。

#### INV-20　「平均成本」→ SWE-agent 的 `$ Avg. Cost` **只平均了成功的实例**
- **实际**：SWE-agent 论文原话："`$ Avg. Cost` metric, the API inference cost … averaged over all **successfully resolved** instances"，同时设 $4/题上限，超限则自动提交已有编辑。同一论文发现 **"Agents succeed quickly and fail slowly"**：成功的实例成本**中位数 $1.21、12 步**；未成功的**均值 $2.52、21 步**。若只报前者，成本被系统性低估。`[O]` 在本地草稿的 12 题夹具上：**仅成功**的平均成本 $0.042，**每次尝试**平均 $0.227，**每个成功**的成本 $0.453——同一批数据，三个「平均成本」差 **10.9×**（0.453/0.042）。
- **来源**：`[P]` SWE-agent §4/§5；`[O]` §12.4。
- **后果**：成本曲线的纵轴必须是 **cost per resolved**（总花费 / resolved 数）与 **cost per attempt** 并报。COST-6。

#### INV-21　「按花费分桶看 resolve 率」→ 条件在了**结果的后果**上；该画的是预算截断曲线
- **实际**：成本是**结果之后**才确定的量（失败 → 空转 → 更贵），按它分桶得到的「最贵桶 resolve 最低」是**反向因果**，不是「加预算没用」。SWE-agent：93.0% 的成功实例在耗尽预算前提交，而总体只有 69.0% 在预算内——所以作者推断"提高预算上限不太可能显著提升性能"。正确的曲线是**预算截断**：对每条轨迹，若其累计花费 ≤B 时已达到 resolved，则在预算 B 下算成功；`rate(B) = |{resolved ∧ costToGreen ≤ B}| / N`，单调不降，且能读出「再加钱买不到什么」。`[O]` 本地草稿夹具上 `rate($0.05)=4/12`、`rate($0.10)=6/12`，**$0.10 之后恒为 6/12**。
- **来源**：`[P]` SWE-agent §5「succeed quickly, fail slowly」；`[O]`。
- **后果**：本地草稿 `costCurve`（L291）与 bench 实验三正是「按花费分桶」；它还被**难度混杂**——贵的题本来就难（Simpson）。替换为 `budgetCurve`（COST-7），`Attempt` 增 `costToGreenUsd`。D-3。

#### INV-22　「成本 = 美元」→ 美元 = tokens × 价格表 × **缓存命中**，三者都会动
- **实际**：SWE-rebench 榜单同时列出 cost/problem、tokens/problem、**cached %**：同一榜上 GPT-5.6 Sol[medium] **605,340 tokens/题、$0.85**，而 MiniMax M3 **13,869,459 tokens/题、$0.95**；缓存占比 72.3%–97.0%；Cursor Agent $0.41 / 51.7%，Claude Code $3.39 / 60.4%。榜单作者在 2025-12-05 专门新增了 Cached Tokens 列，说明美元数字不是独立量。
- **来源**：`[P]` swe-rebench.com 榜单（2026-09 抓取快照，数字会变）。
- **后果**：结果里存 **token 分项**（input/cached/output）与**价格表版本**，美元在**展示层**由价格表重算。EXP-9：同一批 tokens 在两张价格表下**排名翻转**（零模型，COST-10）。

#### INV-23　「更强 = 更贵 = 更好」→ 画帕累托前沿，很多点是被支配的
- **实际**：aider polyglot：o3-pro(high) **84.9% / $146.32 / 449 s/case**，被 gpt-5(high) **88.0% / $29.08 / 194 s/case** 在三个轴上全面支配。*AI Agents That Matter*：简单基线（重试、预热、升级）在准确率-成本前沿上支配了许多复杂 agent；HAL（Holistic Agent Leaderboard）主张把成本作为一等公民。
- **来源**：`[P]` aider leaderboard；`[P]` Kapoor et al. *AI Agents That Matter*；`[P]` HAL。
- **后果**：`paretoFrontier(points)`：返回每个点被谁支配；报表默认输出前沿而非排名。COST-9。

#### INV-24　「小样本也能给 CI」→ 正态近似/百分位 bootstrap 在小 N 与边界处会失效
- **实际**：Bowyer 等人：CLT 区间在小 N 下欠覆盖，应改用 Wilson/精确/贝叶斯。`[L][O]` 本地 L12 的 `bootstrapCI`（shared/evals.ts）对 **0/30** 返回 `[0, 0]`，对 **30/30** 返回 `[1, 1]`——**零宽度区间**；对 27/30 返回 `[0.767, 1.0]`，而 Wilson 为 `[0.744, 0.965]`。Wilson 0/30 上界是 **11.4%**。N=10 时 5/10 的 Wilson 区间 `[23.7, 76.3]`，宽 52.7pp。
- **来源**：`[P]` Bowyer et al. *Don't Use the CLT in LLM Evals With Fewer Than a Few Hundred Datapoints*；`[L][O]`。
- **后果**：L12 的 bootstrap 对**连续分数**没问题；对**二值结果的小 N** 不能用。本地草稿的 `resolveRate.ci` 已用 Wilson（正确），但 `ablationTable.decisive`/`compareRuns.significant` 仍用 bootstrap（INV-40）。EXP-2。

#### INV-25　「±1.41% 的误差棒」→ 那是**重跑噪声（SEM over 5 runs）**，不是**任务抽样噪声**
- **实际**：SWE-rebench 榜首 64.5% **± 1.41%**（5 次运行的均值标准误），第 2 名 63.8% ± 0.60%，第 3 名 63.4% ± 1.35%——榜单页自己的注释说"顶部排名未定"。但该窗口只有 **111 题**，`[O]` 仅凭「抽到了这 111 题」的二项标准误就是 **4.5pp**（Wilson 95% [55.6, 73.1]）。误差棒只量了「同一批题再跑几次」，没量「换一批同分布的题」。Miller：把评测题看作从**超总体**抽样，两类误差都要。
- **来源**：`[P]` swe-rebench.com 榜单；`[P]` Miller *Adding Error Bars to Evals*（arXiv 2411.00640）；`[O]` 计算。
- **后果**：报告模板固定输出**两类**不确定性：`seRuns`（重复运行）与 `seTasks`（任务抽样/配对）。本地草稿只有后者的 Wilson。

#### INV-26　「500 题 = 500 个独立样本」→ 同仓库的题彼此相关，标准误被低估
- **实际**：Miller/Anthropic：对相关题目（同段落、同仓库）应使用**聚类标准误**，"在流行评测上，聚类 SE 可比朴素 SE 大 3 倍以上；忽略聚类可能让你检出并不存在的差异"。Pro 每个仓库贡献 50–100 题；Verified 里 Django 占约一半（INV-10）。
- **来源**：`[P]` Anthropic *A statistical approach to model evaluations*；`[P]` Miller。
- **后果**：`TaskInstance` 要有 `repo`（聚类键）；报告里给 `designEffect`。个人任务集往往**只有 1–3 个仓库**——此时「聚类数 G」才是有效样本量，这对 L17→L18 的自建集是硬约束（§3.4）。

#### INV-27　「按语言/仓库切片排名」→ 每片 N≈43，区间互相重叠
- **实际**：SWE-bench Multilingual 参考表（Claude 3.7 + SWE-agent）：C/C++ 12/42=28.57%、Go 13/42=30.95%、JS/TS 15/43=34.88%、Ruby 19/44=43.18%、PHP 21/43=48.84%、Java 23/43=53.49%、Rust 25/43=58.14%。`[O]` Wilson 95%：C/C++ [17.2, 43.6]、Go [19.1, 46.0]、JS/TS [22.4, 49.8]、Ruby [29.7, 57.8]、PHP [34.6, 63.2]、Java [38.9, 67.5]、Rust [43.3, 71.6]——**每片宽约 27–30pp，七片区间几乎全部重叠**；"Rust 最高、C/C++ 最低"几乎没有统计支持。
- **来源**：`[P]` swebench.com/multilingual 表；`[O]` Wilson 计算。
- **后果**：分层/切片报告必须带区间，并禁止在 N<~100 的切片上做排名结论。EXP-2 附表。

#### INV-28　「多看几个指标/切片/配置，总有一个显著」→ L12 讲过公式；coding 的新增是**指标×切片×消融的乘积爆炸**
- **实际**：L12 已有 `1−(1−α)^k`、Bonferroni 与「预注册主指标」。coding agent 评测天然产生大量比较：{resolve, apply, steps, tokens, cost, time, hack 率} × {仓库, 语言, 难度} × {K 个消融配置}。**7×3×6=126 个比较**。
- **来源**：`[L]` L12 content.mdx（公式与规程）；`[P]` Miller（多比较与功效）。
- **后果**：L18 不重讲公式，只给**coding 版的预注册清单**：一个主指标（`resolveRate` 配对差，hack 调整后）、至多 2 个护栏（`brokenCount`、`costPerResolved`）、预先声明的切片（`repo`、`suite`），其余一律标「探索性」。写进 `runKey.plan` 字段（KEY-1）。

#### INV-29　「temperature=0 就确定了」→ 不确定，而且噪声底可以被**测**出来
- **实际**：aider 文档（L17 已引）：OpenAI 聊天接口即使 temperature=0 也不确定。Pro Verified 的配对对照里，**即使 gold 泄漏被堵上**，仍有 15 个 F→P（731 的 2.05%），作者把 186 个 P→F 里的 17 个归为"噪声"。SWE-agent 的 6 次运行里 resolve% 在 17.33–18.67 间摆动，而**每题的结果变化相当大**。
- **来源**：`[P]` arXiv 2609.08149；`[P]` SWE-agent §4；`[P]` aider。
- **后果**：**A/A 运行**（同一配置跑两遍）是 L18 的头号新工具：它的 fixed/broken 数就是该任务集、该 scaffold 下的**噪声底**，门禁阈值应由它校准（INV-42）。EXP-5。

#### INV-30　「离线测试全绿 = 可以合并」→ 约 24pp 的差距
- **实际**：METR 请 4 位维护者（来自 scikit-learn、Sphinx、pytest）审 **296** 个 AI 生成的 PR：对 SWE-bench Verified，**维护者的合并率平均比自动判定器低约 24.2pp（SE 2.7）**；golden patch 本身也只有 68% 会被合并；"通过测试的 PR 约一半不会被合并"，原因：核心功能不对、弄坏其他代码、代码质量；且维护者合并率随时间的提升比自动分数**慢约 9.6pp/年**（作者自称证据较弱）。
- **来源**：`[P]` METR *Many SWE-bench-Passing PRs Would Not Be Merged into Main*（2026-03-10）。
- **后果**：个人 agent 的「更好」不应只有 F2P/P2P。零模型可算的**可评审性代理**：diff 规模、改动文件是否在计划内（L17 `adherence`）、是否改了无关文件、lint 通过与否。这些进 `Attempt.review` 字段并入「护栏」。（用于 §6 门禁，但**不要**把它们当成合并概率。）

#### INV-31　「公开基准能代表我的 agent」→ 厂商自己也不这么用
- **实际**：Cursor：内部 CursorBench（来自真实会话，强调多文件、含糊指令）+ **线上 A/B 实验**共同作用；线上评估"能抓到离线套件错过的退化——输出对评分器看起来正确，但对开发者用起来更糟"；并做过**移除语义搜索工具**的消融来定位哪类场景受益（大仓库问答）。Cursor 同时指出公开基准"题面过度规定、解法狭窄、代码库小"。（厂商自述，外部不可证伪，只能当「方法」而非「证据」。）
- **来源**：`[P]` cursor.com/blog/cursorbench；`[P]` cursor.com/blog/continually-improving-agent-harness；Composer 2 技术报告。
- **后果**：自建任务集（来自自己的仓库/历史 bug）是 L18 的**主指标来源**；公开基准只作锚点（INV-9）。线上 A/B 超出个人 agent 范围，归 L19 的监控（§7）。

---

### C. 消融实验

#### INV-32　「加个规划/反思/多步推理模块一定有用」→ 简单基线常在前沿上支配它们
- **实际**：*AI Agents That Matter* 在 HumanEval 等上发现：简单基线（重试、预热、升级）与复杂 agent 在准确率相当时成本低得多；Agentless（三段式：定位→修复→验证，无 agent 循环）在 SWE-bench Lite 上以更低成本达到 32%（论文报告）。**没有公开数据说明「plan 阶段」在 coding agent 里值多少**（L17 §已列为空白）。
- **来源**：`[P]` Kapoor et al.；`[P]` Agentless（Xia et al. 2024）。
- **后果**：L18 的消融案例**选「plan 阶段」与「verify-before-stop」**：它们是 L17 加的东西，用 L18 的方法给出你自己的答案——这是课程里少数「公开文献没有、学员能产出新证据」的点。

#### INV-33　「SWE-agent 的 ACI 消融证明了某个设计好」→ 单次运行、N=300、差值 1.7–7.7pp
- **实际**：SWE-agent Lite（N=300，GPT-4 Turbo，**单次**）：基线 18.0。No edit 10.3（−7.7）；Iterative search 12.0（−6.0）；**No search 15.7（−2.3）**；窗口 30 行 14.3（−3.7）；整文件 12.7（−5.3）；无 lint 15.0（−3.0）；全历史 15.0（−3.0）；无 demo 16.3（−1.7）。**迭代式搜索比没有搜索工具更差**——因为 agent 对每条命中逐条翻看耗光预算。`[O]` 二项标准误 ≈2.2pp，两次独立运行之差的 SE ≈ **3.1pp**；`w/o demo`（−1.7）与 `No search`（−2.3）落在一个 SE 以内，**不能下结论**；配对分析能收窄但论文没做。
- **来源**：`[P]` SWE-agent §5 Fig. 6/Table；`[O]` 计算。
- **后果**：这个表是「**有决策意义的消融**」与「**噪声级消融**」同时出现在同一张表里的最佳教材。`ablationTable` 的 `decisive` 必须基于精确检验并显示 MDE（INV-35）。

#### INV-34　「一次改一个因素（OFAT）就够了」→ 从**全配置**往下减 vs 从**空配置**往上加，结论可以相反
- **实际**：当组件有交互（A 单独无效、与 B 联用才有效），OFAT-from-full 会说「A 没用」，OFAT-from-empty 会说「A 有用」或反之。HAL 的跨基准实验发现"更高推理强度在多数运行中**降低**准确率"，说明 scaffold×模型×预算之间有非加性。
- **来源**：`[P]` HAL（Holistic Agent Leaderboard）；因子设计是统计学常识（`[S]` 见 §15 N-1）。
- **后果**：`factorialEffects(outcomes, factors)`：给 2^k 个配置的结果，输出主效应、两两交互、以及 OFAT-from-full / from-empty 的符号是否一致。lab 夹具里**故意构造一个交互**。ABL-5/6。

#### INV-35　「去掉 X 分数没掉 = X 没用」→ 三种别的解释
- **实际**：①**功效不足**：`[O]` N=300、真实 +5pp 时配对精确检验功效仅 **30.7%**；②**补偿**：去掉搜索工具后 agent 用 shell 的 grep/find 代偿（SWE-agent No search 只掉 2.3pp）；③**天花板**：任务集饱和，信号被压扁（INV-11）。
- **来源**：`[P]` SWE-agent；`[O]` §12.3。
- **后果**：消融结果输出**三元组**：`delta`、`CI/p`、`mde`；当 `|delta| < mde` 时，结论只能写「**无法检出 ≥mde 的影响**」，不能写「无影响」。ABL-3。

#### INV-36　「消融越多越严谨」→ 只有**会改变一个决定**的消融值得跑
- **实际**：Cursor 的消融是**目的明确**的：移除语义搜索 → 看哪类场景受益 → 决定是否保留/强化该工具。反例是「装饰性消融」：①被消融的工具在所有轨迹里**根本没被调用**（消融是空操作）；②被消融的因素与某项决定无关（改温度、换显示名）。
- **来源**：`[P]` Cursor 博客；`[S]` 「空操作消融」是本报告的归纳（§15 N-2）。
- **后果**：零模型规则 `ablationVacuity(traces, toolName)`：统计被消融工具在基线轨迹里的调用次数，**0 次 → 直接判装饰性**，不用花钱跑实验。ABL-7。

#### INV-37　「换更强的模型 = 最干净的消融」→ 模型换掉的是一整捆东西，**包括作弊倾向**
- **实际**：Pro Verified 的 7 个模型对比显示不同模型的 hack 倾向差异显著（论文称某些模型"表现出更广泛的 hacking 行为"）；GLM-5.2 的 21.48pp 里有大头是泄漏利用。换模型同时换了：工具调用格式、推理强度默认值、temperature 是否可设（mini-SWE-agent 2.x 对 temperature 不设置）、tokenizer、缓存行为、价格。
- **来源**：`[P]` arXiv 2609.08149；`[P]` mini-SWE-agent 文档（本轮早前检索）。
- **后果**：模型消融必须在**反泄漏环境**下做、报**成本**、并明确「这是整捆替换」。

#### INV-38　「scaffold 只是实现细节」→ 它是结果的一部分，必须写进键
- **实际**：aider 榜单每条记录都带 `commit_hash`、`reasoning_effort`、`edit_format`、`versions`；mini-SWE-agent v1→v2 改了动作解析方式并不再设 temperature，**版本间不可比**；SWE-bench Live 要求提交**完整轨迹**以便核对协议（agent 只能看 `problem_statement`，不得访问 gold patch/test patch）。
- **来源**：`[P]` aider yaml；`[P]` mini-SWE-agent；`[P]` SWE-bench-Live README。
- **后果**：`runKey = hash(taskSetVersion, scaffoldCommit, model, reasoningEffort, resources, priceTable, K, plan)`；比较前先比键，**键只允许在「被测因素」上不同**。KEY-1…。

---

### D. 配对与 A/B

#### INV-39　「A/B = 比较两个通过率」→ 不配对就浪费大半功效
- **实际**：评测题在两个版本之间是**同一批题**，前沿模型的逐题得分相关系数在 0.3–0.7（Anthropic），配对差值的方差远小于两个独立样本之差。`[O]` 在「每题成功概率为 U 形分布（Beta(½,½)）」下，**单次运行、真实 +5pp**：N=200 时精确 McNemar 功效 **21.3%**，非配对 z 检验仅 **6.9%**（3.1 倍）；N=500：49.4% vs 25.0%。非配对检验**不是假阳性多**（A/A 假阳性仅 0.7%），而是**保守到几乎看不见效果**。
- **来源**：`[P]` Anthropic *A statistical approach to model evaluations*；`[P]` Miller；`[O]` §12.3。
- **后果**：A/B 的默认形式是**配对转移表**（只在 A 过 / 只在 B 过 / 都过 / 都不过），信息全部在「不一致对」里（`[O]` U 形下不一致对约占 25% 的题）。AB-1。EXP-5。

#### INV-40　「McNemar/bootstrap 都差不多」→ 稀疏不一致对下，**本地 L12 的 bootstrap 反保守**
- **实际**：`[L][O]` 用本地 `compareRuns`（shared/evals.ts）实测（N=40，修好 c / 弄坏 b）：

  | 修好 c | 弄坏 b | bootstrap 判显著？ | 精确 McNemar 双侧 p |
  |---|---|---|---|
  | 3 | 0 | 否 | 0.250 |
  | **4** | **0** | **是**（CI [0.025, 0.200]） | **0.125** |
  | 5 | 0 | 是 | 0.063 |
  | 6 | 0 | 是 | 0.031 |
  | 5 | 1 | 否 | 0.219 |
  | 7 | 1 | 是 | 0.070 |
  | 8 | 2 | 否 | 0.109 |

  N=20、N=100 下**同样**在 (4,0) 处翻为"显著"：百分位 bootstrap 在 b=0 时只要 `(1−c/N)^N < 0.025`（约 c≥4）下界就 >0，**与 N 无关**；而精确检验要 c≥6。
- **来源**：`[L][O]` §12.3。
- **后果**：这是 **L12 → L18 的一处需要明说的修正**：对**二值、配对、小 N** 的结果，用**精确二项（McNemar 精确）**而不是 bootstrap。L12 的工具对连续分数仍成立。`exactMcNemar`（STAT-1…3，AB-2）。

#### INV-41　「一次运行配对就行」→ 一次运行里的翻转有一部分只是运行噪声
- **实际**：McNemar 把每题当作一次伯努利；但 agent 随机，**同一题同一配置跑两次可能一过一挂**（SWE-agent 论文：单题结果变化相当大）。要把「版本带来的翻转」和「运行噪声带来的翻转」分开，需要**每题 K≥2 次**，以每题的 `c/K` 为配对观测，或用**多数/全体一致**的稳健转移。Miller 推荐"重采样答案"以降方差，并给出事先决定可检出差值的样本量公式；SWE-rebench 即每模型跑 5 次。
- **来源**：`[P]` Miller；`[P]` SWE-rebench；`[P]` SWE-agent。
- **后果**：`pairedTransitions(a, b, {k})`：K=1 给出一次转移表；K>1 给出「稳定转移」（在 A 的 K 次中≥ceil(K/2) 过、在 B 的 K 次中<ceil(K/2) 过 → 稳定弄坏）。AB-3。

#### INV-42　「弄坏 ≥3 就拦」（L12 / 本地草稿）→ 这个常数只对某个 N 与某个噪声水平成立
- **实际**：`[L]` 本地 `compareRuns` 与 `codingGate` 都硬编码 `broken.length >= 3`。`[O]` 在「每题成功概率 U 形、均值 0.5」下，**A/A（同一配置两次）的不一致对约占 25% 的题**（一般情形下上界 50%）；N=100 时 A/A 就会触发该规则的概率≈100%。`[O]` 实测草稿 `codingGate`：N=100、真实 0pp 时 **pass 概率 0.00，churn 规则拦截 1.00**；N=30 时 0.04/0.73。**无论真实 +10pp 还是 −10pp，门禁几乎都拦**。`[P]` Pro Verified 把「15/731 个 F→P」作为噪声的下界参考。
- **来源**：`[L][O]` §12.5；`[P]` arXiv 2609.08149。
- **后果**：阈值必须由 **A/A 实测 churn 校准**：`churnThreshold = quantile(aaChurnCounts, 1−α)`，或对「弄坏 vs 修好」做**精确符号检验**（b 显著大于 c 才拦）。AA-1…2，GATE-6。

#### INV-43　「先跑 A 再跑 B」→ 顺序、时间、缓存、共享状态都会混进差值
- **实际**：①**harness 缓存**：SWE-bench 官方 harness 按 `run_id`+`instance_id` 缓存结果，"同一个 run_id 重复评估，即使 prediction diff 不同，也复用第一次的结果"——换了补丁而没换 run_id，你看到的是旧结果；②Anthropic：Claude 在评测里**检查了之前试验遗留的 git 历史**；共享状态让失败相关；③`[P2]` 提示缓存：先跑的臂付冷缓存、后跑的臂可能吃到热缓存，成本比较被扭曲（机制成立，但「后跑更便宜」的幅度本轮无一手数据，见 §15 M-3）；④服务商侧静默变更/限流。
- **来源**：`[P]` swe-bench `docs/guides/evaluation.md`；`[P]` Anthropic *Demystifying evals*；SWE-rebench 榜单显示缓存占比 72–97%。
- **后果**：A/B **按题交错**（A1 B1 A2 B2…）、每次运行**干净工作区**、`runKey` 写进 harness 缓存键；「同 key 不同输入」应抛错而不是静默复用（AB-9）。

#### INV-44　「任何改动都该 A/B」→ 有四类情形**不该**A/B
- **实际**：①**功效不够**：`[O]` 要在每题成功概率 U 形、一次运行的设定下检出 +5pp（80% 功效）需要 **N≈1000**；检出 +10pp 需 ≈300；+15pp 约 200。个人任务集（20–50 题）只能检出**很大的效应**——Anthropic 说"早期效应量大，20–50 个来自真实失败的任务就够起步"；②**改动是确定性的、可单测的**（如 L17 的 `applyEdits` 语义）→ 用单测，别用模型；③**只改成本、不改行为**（如缓存断点位置）→ 用**轨迹回放**重算 tokens/美元，零模型；④**目标是用户体验**（Cursor 的 Keep Rate、满意度）→ 离线套件看不见，需要线上实验（L19）。
- **来源**：`[P]` Anthropic；`[P]` Cursor；`[O]` §12.3。
- **后果**：L18 要教的决策表：**给定「改动类型 × 预期效应量 × 任务数」，该用单测 / 回放 / 配对 A/B / 线上**。`sampleSizePaired` 与 `mdePaired`（STAT-4…5）。

#### INV-45　「显著才能合并」→ 回归门禁要测的是**不劣于**，不是**显著更好**
- **实际**：`[L][O]` 本地草稿 `codingGate`（L540–L546）：「resolve 点估计上升但不显著 → blocker」。这条规则**不对称**：噪声里偶然 +1 的改动被拦，噪声里偶然 −1 的改动放行（除非显著变差）。实测（N=100）：真实 0pp 时 **49% 的 A/A 被这条规则拦**，真实 −5pp 时仅 17%，真实 −10pp 时仅 3%（因为越差越不会「点估计上升」）。两件事被混成一个门：**回归门（regress：能否证明没变差？非劣）**与**宣称门（claim：能否宣称更好？优效）**。
- **来源**：`[L][O]` §12.5；非劣/优效是临床试验与 A/B 的标准区分（`[S]` 见 §15 N-1）。
- **后果**：`gateMode: 'regress' | 'claim'`：`regress` 只在**精确检验显著变差**或 **infra/键/任务集异常**时拦；`claim` 才要求显著更好。GATE-7/10。

#### INV-46　「α=0.05 就够」→ 每晚跑一次，一年 365 次
- **实际**：nightly 对同一基线每天判一次，α=0.05 意味着**平均每 20 晚一次误报**（对 A/A 的拦截）。Anthropic 与 Miller 都强调事先确定主指标与样本量；`[S]` 序贯检验（always-valid）在评测工具中几乎没人实现（evalsig 项目的自述，本轮仅 `[S]`）。
- **来源**：`[L]` L12 多重比较段；`[S]` evalsig。
- **后果**：nightly 门禁用**更严的 α**（如 0.01）+ **连续两晚确认**才拦；PR 级门禁（零模型）无此问题。写入 §6 的规程，不进 lab 断言（需要时间序列）。

---

### E. 回归门禁与评测基础设施

#### INV-47　「回归门禁 = 把基准放进 CI」→ CI 里**不能有模型**；该测的是评测系统本身
- **实际**：模型调用不可复现（INV-29）、昂贵（INV-22）、慢；放进 PR 门禁会得到**随机红灯**。能零模型地断言的东西（§6.1 的 6 类）已经足以拦住绝大多数「评测系统坏了」的事故；真正的「agent 更好了吗」在 **nightly live** 里用 K 次重复 + A/A 校准 + 精确检验回答。Anthropic 的 regression eval 也是接近 100% 的小套件，而不是整个基准。
- **来源**：`[P]` Anthropic；`[L]` L17 runner 注释"不要用这个脚本当 CI 门。成功率不可复现，是 L18 的事"。
- **后果**：§6 给出两层门禁的完整内容清单。

#### INV-48　「基线 = 上次 main 的一次运行」→ 基线本身有噪声，要存**分布**与**键**
- **实际**：单次基线的随机波动会成为每个 PR 的「差值」的一部分（INV-29）。aider 榜单记录 `commit_hash`、`reasoning_effort`、`date`、`versions` 的做法就是把「键」落盘。
- **来源**：`[P]` aider；`[O]`。
- **后果**：基线文件 schema：`{runKey, taskSetHash, scaffoldCommit, perTask: {id: {c, n}}, aaChurn: [...], priceTableVersion, createdAt}`；新运行与基线**键不匹配只允许在声明的因素上**（GATE-9，KEY-2）。

#### INV-49　「判定器是可信的」→ 判定器与解析器是**被测系统**，错误率不小
- **实际**：UTBoost 的改进解析器：SWE-bench Lite **54.6%（164/300）**、Verified **54.2%（271/500）** 的实例标注与原解析器不一致；纠正后 Lite 多出 64、Verified 多出 79 个"原被判通过的错误补丁"；总计 345 个；**排行榜上 Lite 40.9%（18/44）、Verified 24.4%（11/45）的名次发生变化**，Verified 原第一、二名（Amazon Q Developer 与 devlo）并列第一。Anthropic：修复判定器后 CORE-Bench 成绩从 42% 升到 95%（`[P]` 本轮早前检索，见 §15 M-2）。SWE-bench 原论文 A.4：**缺失或非通过的测试一律视为失败**——解析器漏掉一行就会让正确补丁判错。
- **来源**：`[P]` UTBoost；`[P]` SWE-bench 论文；`[P]` Anthropic。
- **后果**：**判定器的单元测试是 L18 零模型断言里性价比最高的一组**：给定固定的 pytest/jest 输出样例（含 xfail/skip/error/重复名/并行乱序），断言 `parseTestOutput` 与 `isResolved`。CLS/SET/STAT 组。

#### INV-50　「任务集一旦建好就不变」→ 任务/测试/解析器改动要**换版本号**，并使旧结果失效
- **实际**：Pro Verified 修订 102 题的题面与测试后，模型成绩立即变动；Terminal-Bench 4.0 调整资源、修题、去饱和任务，要求重跑。结果的「键」里必须有任务集版本。
- **来源**：`[P]` arXiv 2609.08149；`[P]` tbench.ai 4.0。
- **后果**：`taskSetHash`（FNV 式整数哈希，双语言一致）进入 `runKey`；`codingGate` 对**任务 id 集合被换**已有拦截（现有 GATE-4），但**同 id 不同内容**（改了测试/题面）未覆盖——要用哈希。KEY-1，GATE-9。

#### INV-51　「raw 分数就是分数」→ 至少要报三个数：**raw / clean / hack-flagged**
- **实际**：Pro Verified：GLM-5.2 raw 78.80%，clean 57.32%。**两者之差本身就是一个指标**（泄漏利用量）。L17 的 `detectHacks` 给出每次运行的 `block/warn` 标记；L18 把它聚合成「hack-调整后的 resolve」。`resolved` 与 `hacked` 互斥是现有 `classifyAttempt` 的设计，正确。
- **来源**：`[P]` arXiv 2609.08149；`[L]` L17 `detectHacks`。
- **后果**：报表固定三行：`raw f2p-only`、`clean resolved`、`hack-flagged (n, rate)`，并在 `hack-flagged / raw f2p-only > 阈值` 时拦。GATE-11（可选）。

#### INV-52　「读轨迹是人的事」→ 命令轨迹审计可以**零模型回放**
- **实际**：Pro Verified 的审计用的是可枚举的可疑操作类（`git show <sha>`、`git log --all`、`curl raw.githubusercontent.com`、读 `solution`/临时路径等）；HAL 用 LLM 辅助的日志检查发现 agent **在基准的公开站点上搜索基准本身**；Anthropic 建议「读转录」是评测者的基本功。
- **来源**：`[P]` arXiv 2609.08149；`[P]` HAL；`[P]` Anthropic。
- **后果**：`auditTrace(toolLog, policy)`：基于**已落盘的 toolLog**（L17 有 `toolLog` 字段）做规则匹配，零模型。LLM 辅助复核放 runner（R-6）。TRC-1…。

#### INV-53　「榜单名次 = 能力排序」→ 名次噪声 > 名次间距
- **实际**：UTBoost 修正后 24.4–40.9% 的榜单名次变化；Anthropic 的 6pp 资源噪声"超过榜单上相邻名次的间距"；SWE-rebench 前五名的区间重叠；Pro 公开集 8 个月涨 56.7pp 之后被撤回。
- **来源**：`[P]` 以上各条。
- **后果**：报告里**不出现「第几名」**，只出现「A−B 的差值与区间」。

#### INV-54　「选一个最好的公开基准用到底」→ 基准的半衰期不到一年
- **实际**：Verified：2026-02 OpenAI 弃用；Pro：2026-02 被推荐、2026-07 被撤回、2026-09 被修补；Terminal-Bench 2.0→4.0；aider polyglot 自 2025-08-23 起顶端 88.0% 没动（`[P2]` 一篇 2026-09 的博客称其"抗刷"但停滞）；SWE-rebench 靠**时间窗**滚动。
- **来源**：`[P]` OpenAI 两篇；`[P]` arXiv 2609.08149；`[P]` tbench.ai；`[P2]` digitortoise.com。
- **后果**：见 INV-9：**自有集为主、公开为锚、结果键记基准版本**。这条同时回答 L17 留下的 IOU「SWE-bench 方法论」：**讲方法论的目的不是教人选对基准，而是教人把「选错基准」的代价变小。**

#### INV-55　「同一段统计代码，TS 和 Python 会输出一样的字节」→ 至少有四处会不一样
- **实际**（`[O]` macOS arm64，Node 22.19.0，Python 3.13.13）：
  1. **舍入**：`(0.5).toFixed(0)`→`"1"`，Python `f"{0.5:.0f}"`→`"0"`；`(2.5)`→`"3"` vs `"2"`；`(12.5)`→`"13"` vs `"12"`；`(0.125).toFixed(2)`→`"0.13"` vs `"0.12"`。JS 在精确平局时取大，Python 取偶。**N=40 的任务集里 1 题命中 = 2.5%，现有 `pct()` 就会 TS 打 "3%"、Python 打 "2%"**（D-9）。
  2. **libm**：对 20 万个随机输入，`log`/`exp`/`pow` 在 V8 与 CPython 之间**末位不同的比例分别约为 4.9% / 10.1% / 9.8%**（§12.1 复跑；另一输入分布下为 6.4/10.0/7.6）；`sqrt`（IEEE 要求正确舍入）**0 差异**。
  3. **排序**：`['B','a','_x','-y','1','Z','ab','a-b'].sort((x,y)=>x.localeCompare(y))` → `_x | -y | 1 | a | a-b | ab | B | Z`；Python `sorted` → `-y | 1 | B | Z | _x | a | a-b | ab`。现有 `ablationTable` 用 `localeCompare`，Python 侧用码点序（D-5）。
  4. **整数**：JS 的 `Number` 在 2^53 之后丢精度，Python `int` 无限；LCG `s*1664525+1013904223` 在 `s<2^32` 时最大约 7.1e15 < 2^53（安全），但换成更大乘子就会静默偏离。
- **来源**：`[O]` §12.1；`[L]` evals.ts `makeRng`。
- **后果**：**数值层规约**（写入 shared 的头注释并做断言 NUM-1…4）：只用 `+ − × ÷ sqrt` 与整数；格式化走**整数缩放的 `fmtFixed`**（两门语言同序操作）；排序用**显式码点比较**；统计里不出现 `log/exp/pow/toFixed/localeCompare`。需要对数的地方（如功效对数似然）一律不进 verify 路径，放 runner 的 Python-only 分析里（并明确它们不参与字节一致性）。

---

> **INV 合计：55 条**（A 12 · B 19 · C 7 · D 8 · E 9）。其中带 `[O]` 自产证据的：INV-15, 20, 21, 24, 25, 27, 33, 35, 39, 40, 42, 44, 45, 55（14 条）；带 `[L]` 本地代码事实的：INV-16, 17, 18, 21, 24, 40, 42, 45, 50, 55（10 条）。

---

## 2. 基准家族方法论拆解（L17 留下的 IOU：「先拆穿方法论」）

> 目的不是做排行榜，而是回答：**每个基准控制了什么、没控制什么、L18 怎么用它**。
> 表中数字均带来源标记；`[S]` 行未在本轮复核，使用前请核对。

| 基准 | 构成 / 规模 | 它控制了什么 | 它没控制（已被证据指出） | L18 的用法 |
|---|---|---|---|---|
| **SWE-bench full** | 2,294 题 / 12 个 Python 仓库 `[P]` | F2P/P2P 判定；Docker 化执行；`%Resolved` 与 `%Apply` 并报 | 题面泄漏 32.67%、弱测试 31.08%（SWE-bench+）；94%+ issue 早于模型知识截止；flaky P2P（issue #167）；解析器错误（UTBoost） | 只作「判定协议」的教材：resolved 的定义、分母口径、harness 结果分类 |
| **Lite** | 300 题 `[P]` | 降成本 | 同 full；N=300 下二项 SE≈2.2pp；UTBoost：40.9% 榜单名次变化 | 论文里的消融几乎都在它上面做（INV-33），拿来当「小 N 噪声」教材 |
| **Verified** | 500 题，OpenAI + 作者，93 名标注者 `[P]` | 人工筛掉不可解/歧义题 | 138 题难子集里 59.4% 有测试/题面问题（OpenAI）；污染；Django 偏重；24.2pp 合并差距（METR）；UTBoost 24.4% 名次变化 | 已被弃用（L17）；仍可当**历史对照** |
| **Multilingual** | 300 题 / 42 仓库 / 9 语言 `[P]` | 非 Python 生态 | 参考结果只评一个模型；每语言 N≈43，切片区间重叠（INV-27） | 教「切片 + 区间」 |
| **Live** | 月更；初始 1,319 题；建集时每实例**验证 3 次** `[P]` | 新题 + flaky 过滤 + 自动建环境（RepoLaunch） | README 仍警告不同机器结果可能不同；资源 4 CPU/16 GB，C++ 可到 50 GB；要求提交轨迹以核对协议 | 教「gold 重跑 3 次」与「分母用 gold 仍通过的实例数」 |
| **rebench** | 滚动时间窗；当前窗口 111 题 / 65 仓库；每模型跑 5 次，报均值±SEM、pass@5、cost/题、tokens/题、cached% `[P]` | 日期 vs 模型发布日；统一 ReAct scaffold；成本与缓存列 | SEM 只量重跑噪声，不量任务抽样（INV-25）；窗口小；自动收集的题不保证全部可解（它自己说明） | 教「两类不确定性」与「成本×缓存」 |
| **Pro** | 1,865 题 / 41 仓库：731 公开（11 个 GPL 仓库）+ 858 held-out（12）+ 276 商业（18 个创业公司私有仓库） `[P]` | 用强 copyleft 许可降低训练污染；商业集不公开；每仓库 50–100 题 | **~30% 坏题（OpenAI 2026-07-08，已撤回推荐）**；评测时泄漏（Pro Verified）；商业集更低（22.7→17.8；23.1→14.9）说明公开集高估 | 当「基准半衰期」案例（INV-54） |
| **Pro Verified** | 731 题 + 102 题修订 + 反作弊沙箱 `[P]` | 单 commit 仓库、id 哈希、屏蔽代码托管域名、隐藏测试 | 修订本身来自「公开报告 + LLM 过滤 + 人工最小修改」，没有独立重审；仅 7 个模型 | 教「评测时泄漏的四通道」与「raw/clean 两个数」 |
| **mini-SWE-agent bash-only** | ~100 行 Python 的最小 scaffold，只有 bash；官方 swebench.com 有对应榜单 `[P]` | 用统一最简 scaffold 隔离**模型**能力 | 与「工具设计」无关；v1/v2 行为不同 | 教「scaffold 固定才能比模型」；也说明为何 L17 的 scaffold 版本进键 |
| **Terminal-Bench 2.0 / 4.0** | 89 题；每题独立环境 + 人写解 + 验证测试；验证检查**最终容器状态**而非命令历史 `[P]` | 任务质量（数小时人工 + LM 辅助验证）；4.0 校准资源、修题、去饱和 | 资源配置 6pp 噪声（Anthropic）；4.0 要求重跑 | 教「资源是基准定义的一部分」 |
| **aider polyglot** | 225 道 Exercism 题 / 6 语言 `[P]` | 记录 `commit_hash/reasoning_effort/edit_format/versions/seconds_per_case/total_cost`；同时给 `pass_rate_1` 与 `pass_rate_2` | 头条用**带反馈的第二次尝试**；几乎饱和；2025-08 后顶端未动（`[P2]`） | 教「尝试策略标签」与「帕累托」（o3-pro vs gpt-5） |
| **CursorBench** | 内部：真实会话、含糊指令、多文件；配合线上 A/B `[P]`（厂商自述） | 贴近真实使用；多维度（正确性/质量/效率/交互） | 外部不可复核；私有 | 作为「自建任务集该长什么样」的方向性参照 |
| **LiveCodeBench** `[S]` | 持续从竞赛网站收新题并记录发布日，可按模型截止日切分；含代码生成/自修复/代码执行/测试输出预测四类场景 | 时间切分抗污染 | 竞赛题 ≠ 仓库级工程；本报告未复核 | 仅在讲「时间窗」时一句带过 |
| **AgentBench** `[S]` | 多环境（OS/DB/知识图谱/游戏/网页等）综合评测 agent；报告商业与开源模型差距 | 跨环境 | 不是 coding-agent 评测；本报告未复核 | 不用 |
| **Devin 的 SWE-bench 报告** `[S]` | 2024-03：在随机 25% 子集（570 题）上不借助人工解出 13.86%（记忆，未复核） | — | 子集 + 自有 harness，与榜单不可比 | 仅作「分母/子集」旁证；使用前复核 |

**这张表要让学员记住的三件事**：
① 没有任何一个基准在**构成 + 判定器 + 环境 + 分母**四处同时没问题；② 每个基准被批评的方式不同——污染（训练期）、泄漏（评测期）、坏题（任务期）、坏判定器（评测器期）、坏统计（报告期）；③ 这五类问题里，**后四类都可以在你自己的评测系统里被零模型地检测**，这正是 L18 verify 的主体。

---

## 3. 任务集构建深潜

### 3.1 `TaskInstance` 应该有哪些字段（对现有草稿的补充）

| 字段 | 现有草稿 | 建议 | 为什么 |
|---|---|---|---|
| `id` | 有 | 保持**不含 SHA/项目名**的短 id | INV-7（Pro 的 id 里有 SHA） |
| `repo` | 无 | **新增**（聚类键） | INV-26 聚类 SE |
| `repoPin` | 非空字符串 | **40 位十六进制 commit** 或 `name@<40hex>`；`SET` 断言格式 | 现有 demo 用 `demo/repo@e1`（以任务 id 当 pin），语义不对 |
| `statementHash` / `goldPatchHash` / `testPatchHash` | 无 | **新增** | INV-50：同 id 不同内容 |
| `createdAt` | 无（用布尔 `contaminated`） | **新增**，`contaminated` 改派生（`createdAt < modelRelease`） | INV-8 |
| `difficulty` | 手贴 easy/medium/hard | 保留，加 `features: {files, hunks, lines, f2pCount}` | INV-10 |
| `suite` | 无 | **新增** `'capability' \| 'regression'` | INV-11 |
| `validity` | 无 | **新增** `{baseRedRuns, goldGreenRuns, emptyGreen, flaky[]}` | INV-3/4 |
| `source` | 无 | **新增** `'own-history' \| 'mutation' \| 'public-anchor'` | 报告里分开汇报 |
| `version` | 无 | **新增**（整数；改题面/测试/解析器就 +1） | INV-50 |

### 3.2 个人 coding agent 的任务来源（从优到劣）

1. **自己的真实 bug-fix 提交**（带测试）：把父提交当 base、修复提交的非测试部分当 gold、测试部分当 test patch。这是 SWE-bench 的原始流水线，也是 Cursor「来自真实会话」的思路。优点：分布真实；缺点：量少、难度分布偏易、题面要**重写**以去掉答案（INV-5）。
2. **变异注入的合成题**（mutation）：对有测试的仓库，用确定性变异算子（翻转比较符、删一行 guard、改常量）生成「引入 bug → 测试变红」的题。优点：几乎免费生成几十到上百题、**效应量大**（所以小 N 也有功效，INV-44）；缺点：分布与真实 bug 不同——只能作 **mechanism micro-eval**（例如「NOT_UNIQUE 恢复」「verify-before-stop」是否起作用），不能当主指标。变异题的**构造是零模型的**，可以进 shared。
3. **公开基准的子集（锚点）**：只作外部锚点，记录版本/scaffold/预算（INV-9/54）。

### 3.3 任务有效性审计：哪些零模型、哪些要沙箱

| 检查 | 内容 | 零模型 verify？ | 说明 |
|---|---|---|---|
| V1 | base 上 F2P 全红（多次） | **是**（吃已落盘的 `validity.baseRedRuns`） | 运行本身在 runner 的 `--audit-tasks`（要沙箱、不要模型） |
| V2 | gold 上 F2P+P2P 全绿 | 是（同上） | 同上 |
| V3 | **空补丁不通过** | 是 | 否则题是空转的 |
| V4 | gold 重跑 3 次一致 | 是 | flaky 名单写回 `validity.flaky` |
| V5 | 题面泄漏：gold 新增行在题面中的逐字覆盖率 | **是，纯字符串** | `statementLeak` |
| V6 | 题面欠规格：测试新增标识符不在题面/base 符号表 | **是，纯字符串 + 符号集** | `undeclaredRequirements` |
| V7 | 泄漏面：base 之后可达的 refs/对象 | **是**（对结构化快照） | `leakSurface` |
| V8 | 变异/补充测试补强（UTBoost 思路） | 否（要 LLM 或人） | 记为 R-4 |

### 3.4 样本量、聚类与「有效样本量」

- **N 不是题数，是 min(题数, 与聚类相关的有效数)**。个人集常只有 1–3 个仓库：同仓库的修复常共享测试夹具、配置、依赖，彼此相关（INV-26）。
- 先做功效再建集（`[O]` §12.3，U 形异质、一次运行、配对精确检验、80% 功效）：

  | 真实效应 | 需要的 N（不一致对占比≈25%） | 不一致对占比≈10% 时 |
  |---|---|---|
  | +5pp | ≈785（正态近似）/ ≈1000（精确检验实测） | ≈314 |
  | +10pp | ≈196 / ≈300（实测 80.5%） | ≈78 |
  | +15pp | ≈90 / ≈200（实测 90.2%） | — |

  公式（正态近似，写进 shared）：`mde ≈ (z_{α/2}+z_β)·√(d/N)`，`N ≈ (z_{α/2}+z_β)²·d/δ²`；其中 `d` 是不一致对占比，取 `z_{α/2}+z_β=1.96+0.8416`。**这就是为什么个人集只能做「大效应」判断**，也是为什么 A/A 与重复运行（降低 `d`）比多收几题更便宜。
- **推荐规模**（与 Anthropic「20–50 题起步」一致）：`capability` 套件 30–60 题（来自自己的失败）、`regression` 套件 15–30 题（毕业而来）、`mutation` 套件 50–100 题（机制 micro-eval）。三套**分开汇报，不混成一个率**。

### 3.5 污染与泄漏：两类，六条通道

| 类别 | 通道 | 防御 | 零模型检测 |
|---|---|---|---|
| 训练期 | 模型记住了该仓库/该 PR | 时间窗（入库晚于模型发布）、私有任务、不公开自建集 | `createdAt` vs 模型发布日表；**不可审计**其余 |
| 评测期 | ① `git log/show/reflog` 恢复 gold | 重建单 commit 仓库 | `leakSurface` |
|  | ② 读沙箱文件系统里的 gold/测试 | 隐藏测试、gold 不放工作区 | `auditTrace`：读已知路径 |
|  | ③ 网络拉仓库/PR | 屏蔽 GitHub/GitLab/…/raw 域名 | `auditTrace`：`curl/wget/git clone` |
|  | ④ `instance_id` 含项目名+SHA | id 哈希 | `SET`：id 不含 40-hex |
|  | ⑤ 前一次试验遗留的状态（Anthropic） | 每次试验干净工作区 | `KEY`：`workspaceFresh` 标志 |
|  | ⑥ 题面里直接写了答案 | 题面审计 | `statementLeak` |

---

## 4. 指标与统计深潜

### 4.1 一份报告行应该长什么样

```
resolve(clean)  = 21/40  52.5%  Wilson95 [37.5, 67.1]   n=40, tasks=40, trials=1, policy=all
f2p-only(raw)   = 24/40  60.0%                          hack-flagged 3 (7.5%)
apply           = 40/40 100.0%                          (denominator = all 40)
cost/attempt    = $0.31   cost/resolved = $0.59   tokens(in/cached/out)=…   priceTable=2026-10-01
pass@1(mean over 3 trials) …  pass^3 (unbiased) …
key = 7f3a9c12  taskSet=v4  scaffold=a1b2c3d  model=…  resources=2cpu/4G/600s  plan=pre-registered
```

三条纪律：**分母必须写出来；尝试策略必须写出来；键必须写出来。**

### 4.2 分母策略对 headline 的影响（EXP-1 要展示的）

同一批 12 个 attempts，其中 2 个是 infra error、1 个是 agent 超时：

| 政策 | 分母 | 含义 | 何时合理 |
|---|---|---|---|
| `all` | 12 | infra error 与 agent 超时都算失败 | **默认**；最保守；与外部「全集」口径一致 |
| `graded` | 9 | 只算成功评分的（去掉 2 个 infra error 与 1 个超时） | 仅当你同时报 infra 错误率，且错误与被测版本无关 |
| `errorRerun`（agent 超时算失败；infra error **重跑**直到出结果或用尽重试） | 11 或 12 | 需要 runner 重跑，verify 只能断言「重跑后」的数据 | nightly 的正式口径 |

SWE-bench 官方 harness 的结果分类（resolved/unresolved/empty patch/error/infra failure/ambiguous failure）就是在告诉你：**分母不是常量**。

### 4.3 pass@k / pass^k 的统一实现

- 输入：每题 `n` 次运行里成功 `c` 次。
- `passAtK(n,c,k) = 1 − ∏_{i=0}^{k−1} (n−c−i)/(n−i)`（当 `n−c<k` 时为 1）
- `passHatK(n,c,k) = ∏_{i=0}^{k−1} (c−i)/(n−i)`（当 `c<k` 时为 0）
- 全集的率 = 每题估计的平均；**每题 n 必须相同或按题加权并声明**；`k>n` 抛错。
- 对照：`naive = (c/n)^k` 与 `1−(1−c/n)^k` 并排——差值就是**异质性**的量（INV-15）。
- **只用乘除**，所以 TS/Python 逐位一致。

### 4.4 两类不确定性必须分开

| 类 | 来源 | 估计 | 报告里叫什么 |
|---|---|---|---|
| 任务抽样 | 「如果换一批同分布的题」 | 二值：Wilson；配对差：精确 McNemar；有聚类时聚类 SE | `seTasks` / 区间 |
| 重跑噪声 | 「同一批题再跑一遍」 | K 次运行的 SEM、A/A churn | `seRuns` / 噪声底 |

SWE-rebench 的 ±1.41% 是第二类（INV-25）。Anthropic 6pp 的资源噪声是第三类**系统性偏差**（INV-19）——不会随 N 增大而消失，只能通过固定配置并写进键来消除。

### 4.5 成本：三个平均、一条曲线、一个前沿

- **三个平均**：`costPerAttempt = Σcost/N`；`costPerResolved = Σcost/#resolved`（含失败的花费）；`costPerResolvedOnly = Σcost_{resolved}/#resolved`（SWE-agent 的 `$ Avg. Cost`）。恒有 `costPerAttempt ≤ costPerResolved`（因为 resolved 数 ≤ N）；当**失败比成功更贵**（SWE-agent 观测到的常态）时还有 `costPerResolvedOnly ≤ costPerAttempt`，三者形成递增链。`[O]` 本地夹具上分别为 $0.042 / $0.227 / $0.453。
- **一条曲线**：预算截断曲线 `rate(B)`（INV-21）。要求 `Attempt.costToGreenUsd?`：第一次 F2P+P2P 全绿时的累计花费；未达绿则 `undefined`（视为 +∞）。
- **一个前沿**：`paretoFrontier`：点 `(cost/resolved 或 cost/attempt, rate)`；被支配 = 存在另一点 rate 不低且 cost 不高且至少一项严格。
- **重定价**：`reprice(attempts, priceTable)`：同一批 tokens 用两张价格表算美元，**排名可翻转**——因为缓存折扣与输出价的比例不同（INV-22）。

### 4.6 方差的三个来源（讲稿里画一张图）

```
        任务抽样（换一批题）     重跑噪声（同批题再跑）     系统性偏差（环境/配置）
SE来源   二项/聚类               agent 随机性               资源上限、超时、版本
对策     N↑、配对、聚类 SE       K↑、A/A 校准               固定并写进键
对谁有效 区间（Wilson/精确）     SEM / churn 阈值           只能「不变」，不能「平均掉」
```

---

## 5. 消融与 A/B 深潜

### 5.1 一个消融值不值得跑的四问（写进 lab README 的「决策表」）

1. **这个消融的结果会改变我哪个决定？**（保留/删除/加强/换模型）——答不出来就不跑。
2. **被消融的东西在轨迹里被用到了吗？**（`ablationVacuity`；0 次调用 = 装饰性）
3. **我能检出多大的差？**（`mdePaired`；若 `mde` 大于「值得改变决定的最小差」，则先加 N 或降噪，而不是跑）
4. **它与别的因素有交互吗？**（有 → 因子设计，不是 OFAT）

### 5.2 对 L17 capstone 值得做的 5 个消融（及其「决定」）

| 消融 | 假设 | 决定 | 预期效应量 | 建议套件 |
|---|---|---|---|---|
| 去掉 verify-before-stop（L17 `canStop`） | 提前停 → hack/假绿上升，resolve(clean) 下降，成本下降 | 是否保留强制验证 | 大（hack 与假绿直接可见） | capability + mutation |
| 去掉 plan 阶段（L17 `validatePlan/revisePlan`） | 对小题无益、对多文件题有益 | 是否对**小题自动跳过** plan | 小～中，且**与题型交互** | capability 按 `features.files` 分层 |
| 去掉 NOT_UNIQUE/NOT_FOUND 的分级反馈（L17 `applyEdits` 反馈层） | 失败编辑恢复率下降，steps/成本上升 | 是否值得保留复杂反馈 | 中，主要体现在**成本与步数**而非 resolve | mutation（机制） |
| 去掉搜索类工具（对应 Cursor 做过的语义搜索消融） | 大仓库受损、小仓库无差 | 工具集裁剪 | 与仓库规模交互 | capability 按 `repo` 分层 |
| 换模型（含推理强度） | — | 选型 | 整捆变化（INV-37） | 必须在反泄漏环境，必须报成本 |

> **公开文献里没有 plan 阶段的消融数据**（L17 §已记为空白）：这是本课程可以让学员自己产出新证据的地方——但**效应量小、交互强**，也是最容易被 INV-35 咬到的地方。讲稿里要诚实说「你的集可能检不出」，并把这当结论的一部分。

### 5.3 配对 A/B 的协议清单（nightly live 用；runner 里执行）

1. **同一任务集版本、同一 `runKey` 中除被测因素外的所有字段**（INV-38）。
2. **按题交错**：`A1,B1,A2,B2,…`，每题的两臂**相邻执行**（INV-43）；每次试验**全新工作区**。
3. **每题 K≥2**（成本允许时 K=3）；同一臂的 K 次用不同种子，**种子进键**。
4. **先跑 A/A**（同配置两次）得到噪声底：`aaChurn`（fixed+broken 的数量分布）。
5. 分析：`pairedTransitions` → 稳定转移 → `exactMcNemar`（双侧）→ 报 `fixed/broken` 明细（L12 的 churn-first 顺序保留）。
6. 同时报 `Δcost/resolved` 与 `Δhack-flagged`。
7. **预注册**：主指标 = `Δ resolve(clean)`；护栏 = `broken 稳定转移数`、`cost/resolved`。

### 5.4 什么时候**不**该 A/B（给学员的决策表，INV-44）

| 改动类型 | 方法 | 是否需要模型 |
|---|---|---|
| 纯函数/确定性语义（编辑应用、diff 解析） | 单测 | 否 |
| 只改成本（缓存断点、压缩策略的 token 数） | **轨迹回放**：用已落盘的轨迹重算 tokens/美元（价格表版本固定） | 否 |
| 预期效应 > 当前 N 的 MDE | 配对 A/B（nightly） | 是（runner） |
| 预期效应 < MDE | 不 A/B：靠机制 micro-eval（mutation 套件），或承认「检不出」 | 视情况 |
| 目标是用户体验/保留率 | 线上实验（L19） | — |

---

## 6. 回归门禁：零模型 PR 门 vs nightly live

### 6.1 零模型 PR 门（`verify` + CI）该测的 6 类

| # | 类 | 内容 | 例 |
|---|---|---|---|
| G1 | **任务集完整性** | `taskSetHash` 未变或 `version` 已 +1；`validateTaskSet` gaps 为空；`validity` 四件套满足；无 40-hex id | SET-1…12 |
| G2 | **判定器正确性** | `parseTestOutput`/`classifyAttempt`/`isResolved` 对固定样例的输出；`detectHacks` 的规则 | CLS-1…9 |
| G3 | **统计器正确性** | Wilson、精确 McNemar、pass@k/pass^k、MDE、预算曲线、帕累托、因子效应 | STAT/PK/COST |
| G4 | **门禁语义** | 对合成的 A/A、+Δ、−Δ 数据，门禁的 pass/block 行为符合预期（非劣 vs 优效） | GATE-1…10 |
| G5 | **轨迹/泄漏审计规则** | 对已录制的好/坏轨迹夹具，规则命中/不误报 | TRC/LEAK |
| G6 | **键与基线** | `runKey` 对每个字段敏感；基线键不匹配被拒绝 | KEY |

另有 **G7（可选）轨迹回放**：用已落盘的 3–5 条「金轨迹」重放到 `Attempt` 汇总管线，断言输出逐字节不变（防止汇总代码回归）。

### 6.2 nightly live 该测的（`runner.ts` 专属，R-1…R-9 见 §9.6）

K 次重复 × (capability + regression + mutation) 全部任务 → 与基线（K 次）配对 → `exactMcNemar` + A/A 校准阈值 → 报 `Δresolve(clean)`、`fixed/broken`、`Δcost/resolved`、`hack-flagged`、infra 错误率。**连续两晚确认才拦**（INV-46）。

### 6.3 门禁语义（修正现有草稿）

| 门 | 零假设 | 通过条件 | 拦截条件 | 用在 |
|---|---|---|---|---|
| **回归门 regress** | 新版本没有变差 | 稳定「弄坏」不显著多于「修好」且 `broken ≤ churnThreshold(A/A)` 且 infra 错误率 ≤ 阈值且键合法 | **精确检验显著变差**，或 `broken > churnThreshold`，或 infra 错误率超限，或键/任务集异常，或出现新的 `hacked` | **每个 PR / 每晚**（默认） |
| **宣称门 claim** | 新版本没有更好 | 精确检验显著更好**且**回归门通过 | 其它 | **只在写「更好」二字之前**（发布说明、课程里的结论） |

现有草稿把二者合成一个，且用了「点估计上升但不显著 → 拦」（INV-45）。

### 6.4 基线文件 schema（建议）

```json
{
  "runKey": "7f3a9c12",
  "taskSetHash": "...", "taskSetVersion": 4,
  "scaffoldCommit": "a1b2c3d", "model": "...", "reasoningEffort": "...",
  "resources": {"cpu": 2, "memGb": 4, "timeoutS": 600},
  "priceTable": "2026-10-01", "k": 3, "plan": "primary=resolve_clean;guardrails=broken,cost",
  "perTask": {"t01": {"c": 3, "n": 3}, "t02": {"c": 0, "n": 3}},
  "aaChurn": [4, 6, 3, 5],
  "createdAt": "2026-10-09T00:00:00Z"
}
```

`perTask` 存 `(c, n)` 而非单个 0/1：**基线是分布，不是点**（INV-48）。

---

## 7. 边界：L12 / L17 / L19 / L20 / L21

### 7.1 对 L12（通用评测）

| 主题 | L12 已讲（`[L]` content.mdx） | L18 **不重讲**，直接引用 | L18 **新增/修正** |
|---|---|---|---|
| 评测集构成 | 分层抽样、`gaps`、腐化 `detectRot` | `stratifiedSample`、`detectRot` | coding 专用：F2P/P2P、gold 验证四件套、题面泄漏、泄漏面、毕业规则 |
| 区间 | 百分位 bootstrap（N=150→宽 13pp）、CI 表 | `bootstrapCI` 对**连续分数**仍正确 | **二值小 N 用 Wilson/精确**；bootstrap 在 0/N、N/N 处退化（INV-24）；稀疏不一致对下反保守（INV-40） |
| 成对比较 | `compareRuns`：fixed/broken 明细、churn-first | `compareRuns` 的**明细输出顺序** | **精确 McNemar** 取代 bootstrap 判显著；`broken≥3` 常数 → A/A 校准阈值（INV-42） |
| 多重比较 | 公式、Bonferroni、预注册主指标 | 全部 | coding 指标×切片×消融的乘积清单（INV-28） |
| 判定器 | judge 审计、kappa | 全部 | coding 的判定器是**测试输出解析器 + 补丁判定**（INV-49） |
| 门禁 | `regress` 五道门，**先查评测可信再看分数** | 顺序原则 | 非劣 vs 优效；infra 错误率；键；任务集哈希；hack 调整（INV-45/47） |
| 污染 | 概念 | — | 评测期泄漏 vs 训练期；轨迹审计（INV-6/52） |

### 7.2 对 L17

- **L17 回答「能不能改对」**：编辑应用、计划校验、验证循环、`detectHacks`（每次运行的规则）。
- **L18 把它变成「改对的比例」**：把 `detectHacks` 的结果聚合为 `clean/raw/hack-flagged`（INV-51）；把 L17 的 `toolLog` 变成命令轨迹审计的输入（INV-52）；**不重写** L17 的任何编辑/验证逻辑。
- **纠正项**：L17 报告引用的「推荐 SWE-bench Pro」已被撤回（§0.1）。

### 7.3 对 L19（上线）

- L19 拥有：长任务队列、幂等/重试、多用户配额、部署与**线上监控**。
- L18 的**交接物**：①nightly 作业的**入口脚本与退出码约定**（`0` 通过 / `1` 回归 / `2` 无法评分，如 infra 超限）；②基线 schema；③「线上指标」的**清单与口径**（Cursor 的 Keep Rate 类指标）——L19 去实现采集，L18 不实现。
- L18 **不做**：线上 A/B、流量切分、告警。

### 7.4 对 L20/L21

- L20（面试）：「你怎么知道这版更好？」的标准回答 = INV-39/40/42/45 的组合；「你们的成功率是多少？」的反问 = 分母/策略/键。
- L21（知识地图）：INV-54「基准半衰期」是「新论文/新基准怎么读」的现成案例；§2 的表是读基准论文的 checklist（构成 / 判定器 / 环境 / 分母 / 泄漏面）。

---

## 8. 对现有 `labs/l18` + `shared/codingEval.*` 草稿的审计（D-1 … D-14）

> 范围：`labs/shared/codingEval.ts`（569 行）、`labs/shared/coding_eval.py`（459 行）、`labs/l18/bench.ts`、`bench.py`、`verify.ts`。
> 实测：`BENCH_IMPL=shared node l18/verify.ts` → 45/45 通过；`node l18/bench.ts` 与 `python3 -m l18.bench` 的输出 `diff` 为空 `[O]`。
> **草稿的骨架方向是对的**（任务集校验 → Attempt 判定 → 四口径 → 成本 → 消融 → 配对 → 门禁；先查评测可信再看分数），下面是需要在它之上修正/补强的点。

| # | 缺陷 | 证据 | 对应 INV | 严重度 |
|---|---|---|---|---|
| **D-1** | **分母不一致**：`applyRate` 的 n = 全部 attempts（error 只从分子扣），`resolveRate` 的 n = 去掉 error 后；`ablationTable` 的 `deltaVsBaseline` 用后者的率，但 `ci` 用「按位置配对、error 计 0」的 diffs；`pairedAB`/`resolvedByTask` 又把 error 计为 0。同一批数据在四个函数里有三种分母。 | `[L]` codingEval.ts L191–L202、L362–L397、L421–L428 | 18, 19 | 高 |
| **D-2** | **pass@k / pass^k 只取前 k 次**（`slice(0,k)`），且只统计「至少有 k 次」的题 → 丢数据、分母随 k 变、k=1 只用第一次。应改无偏估计。 | `[L]` L208–L236 | 13, 16 | 高 |
| **D-3** | **`costCurve` 按花费分桶**：条件在结果的后果上（反向因果），并被难度混杂；bench 实验三的旁白「最贵那一桶往往是 hard 上空转」是未经证实的机制。应改预算截断曲线。 | `[L]` L291–L316；bench exp3 | 21 | 高 |
| **D-4** | **门禁语义写反 + 常数 + 反保守检验**：(a) 「点估计上升但不显著 → blocker」（L540–L546）把「非劣」与「优效」混成一门；(b) `broken ≥ 3`（L521–L527）是常数；(c) 显著性来自 `compareRuns` 的百分位 bootstrap，(4,0) 即判显著；(d) 不检查 infra 错误率、任务内容哈希、键；(e) hack 检查只看候选。 | `[L][O]` §12.3、§12.5：N=100 真实 0pp 时 **pass=0.00**、churn 规则拦 1.00；点估计上升规则拦 0.49 | 40, 42, 45 | **最高** |
| **D-5** | **`ablationTable`**：排序用 `localeCompare`，Python 用码点序，配置名含大写/下划线时顺序不同；按**位置**配对（调用方需保证顺序）；`decisive` 对 baseline 恒为 true；`AblationRow.ci` 是**率**的区间，不是**差值**的区间（命名易误导）。 | `[L][O]` §12.1：JS `_x,-y,1,a,a-b,ab,B,Z`（逗号分隔）vs Py `-y,1,B,Z,_x,a,a-b,ab` | 55 | 中（潜在字节差异） |
| **D-6** | **`resolvedByTask`/`pairedAB` 只取每题第一次 attempt，且对不匹配 id 静默丢弃**（只有「完全无交集」才抛错）→ 重复运行丢失；换了题集悄悄少几题。（`codingGate` 另有 id 集合检查，但 `pairedAB` 自身不设防。） | `[L]` L421–L450；evals.ts L670 | 13, 41 | 中 |
| **D-7** | **`TaskInstance` 字段不足**：无 `repo`（聚类）、无内容哈希、无 `createdAt`、无 `suite`、无 `validity`；`repoPin` 只检查非空，demo 里甚至把任务 id 当 pin（`demo/repo@e1`）。 | `[L]` L26–L41；bench.ts demoTasks | 3, 4, 8, 26, 50 | 中 |
| **D-8** | **`contaminated` 布尔位**表达力不足（训练期 vs 评测期、哪条通道）；`Attempt` 无泄漏证据字段；`hackFindings` 来自 L17 的 diff 规则，没有命令轨迹审计。 | `[L]` L34–L41、L126–L141 | 6, 52 | 中 |
| **D-9** | **格式化不是字节安全的**：`pct = (x*100).toFixed(0)` 在精确平局上与 Python `:.0f` 不一致（`2.5%`、`12.5%`、`0.5%`）。当前输出一致只是因为 demo 的率恰好不是平局；N=40 任务集 1 题命中=2.5% 就会翻车。 | `[O]` §12.1 | 55 | 中 |
| **D-10** | **有几条断言是同义反复/过宽**：`COST-3/4`（桶按花费排序，所以「均价递增」是构造性成立）；`ABL-3`（baseline 对自己的 Δ=0 恒真）；`GATE-3`（「通过**或**因不显著被拦」两种都接受）；`GATE-5`（`warnings…apply ∨ !gate4.pass`，而 gate4 本来就会拦）；`GATE-2` 绑定具体报错文案。 | `[L]` verify.ts L260–L270、L286–L290、L322–L330、L346–L353 | — | 中 |
| **D-11** | **`Attempt` 缺字段**：`trial`、`costToGreenUsd`、`steps`、token 分项（input/cached/output）、`infra` 标志、`runKey`。 | `[L]` L126–L141 | 13, 19, 21, 22, 38 | 中 |
| **D-12** | **bench 的旁白与表格不一致**：实验四旁白说「no-verify 的 resolve 用严格口径会掉」，但表里 `-17pp / decisive: no`（N=12 下不显著）——这恰恰是 INV-35 的教材，却没有被讲出来。 | `[O]` bench 实验四输出 | 33, 35 | 低（教学机会） |
| **D-13** | **「四种口径」在 demo 上只有三个不同值**：`f2p-only` 与 `naive+hacks` 同为 7/12=58%（因为每个 hacked 都同时 f2p 绿）。 | `[O]` bench 实验一输出 | 17 | 低 |
| **D-14** | **缺失文件**：`bench.ts` 提示 `uv run python -m l18.verify`，但 `labs/l18/` 下没有 `verify.py`（也没有 `runner.ts`）；`verify.ts` 不覆盖 shared 的 Python 镜像（跨语言一致性只靠手动 `diff` bench 输出）。 | `[L]` `ls labs/l18` | — | 中 |

**修订策略一句话**：**保留「Attempt → 判定 → 汇总 → 门禁」的数据流与「先查可信再看分」的顺序**；把**数值层抽出**（`evalStats`）、把**任务/轨迹审计抽出**（`taskAudit`）、把**门禁拆成 regress/claim**、把**分母变成显式参数**。

---

## 9. Lab 设计

### 9.1 文件布局（扩展，不另起炉灶）

```
labs/shared/
  codingEval.ts / coding_eval.py     # 现有：Attempt、classifyAttempt、rateSpectrum、pairedAB、codingGate → 扩展（见 §16）
  evalStats.ts  / eval_stats.py      # 新：纯数值（fmtFixed、wilson、exactMcNemar、passAt/HatK、mde、budgetCurve、pareto…）
  taskAudit.ts  / task_audit.py      # 新：任务记录审计、题面泄漏、未声明要求、泄漏面、命令轨迹审计
labs/l18/
  bench.ts / bench.py                # 观察实验 EXP-1…7（+2 可选）+ 7 个 TODO（T7 为拔高题）
  verify.ts / verify.py              # 90 条断言（TS 与 Python 同 ID、同顺序、同总数）
  runner.ts                          # 仅 live：K 次重复、交错 A/B、A/A、gold 重跑、infra 采集、nightly 编排
```

`package.json` 增：`"verify:l18": "tsx l18/verify.ts"`（已有）、`"l18:live": "tsx l18/runner.ts"`、（可选）`"l18:audit": "tsx l18/runner.ts --audit-tasks"`。

### 9.2 双语言数值规约（写进 `evalStats` 头注释，并由 NUM-1…4 守住）

1. **只用** `+ − × ÷ sqrt` 与整数；**禁用** `log/exp/pow/sin/cos/toFixed/Math.round`（INV-55）。
2. **格式化**统一走 `fmtFixed(x, d)`：`s = x<0 ? -1 : 1; v = floor(abs(x) * 10^d + 0.5)`，再用整数字符串拼接小数点。两门语言**同序同运算**（`10^d` 用循环乘，不用 `**`）。约定「平局远离零」。
3. **排序**用显式 `cmpCodePoint(a,b)`，不用 `localeCompare`/默认 `sort()` 对字符串。
4. **随机**只用 `makeRng`（LCG，现有，已验证安全）；任务难度分布用**离散轮廓**（如 `[0.02,0.1,0.3,0.5,0.7,0.9,0.98]` 循环）而不是 Beta/正态（需要 sin/log）。该轮廓均值 0.5，A/A 不一致对期望占 25.4%（`[O]` 解析：Σ2p(1−p)/7），与 §12.3 的 U 形仿真同量级。
5. **迭代顺序**固定：对象键用显式排序后的数组；`zip(strict=True)`；TS 的 `Record` 遍历前先 `Object.keys().sort(cmpCodePoint)`。
6. **精确检验**用递推 `t₀=2^{-n}`（循环除 2）、`t_{i+1}=t_i·(n−i)/(i+1)`，只乘除；限制 `n≤1000`，超出抛错（避免 `2^{-n}` 下溢）。
7. **不要把 scipy/numpy 放进 verify 路径**；允许在 Python 侧**另设**一个 `oracle` 校验脚本（非字节一致性，只做数值对拍，容差 1e-12），**不计入 90 条断言**。

### 9.3 `shared/` 函数一览（签名草图在 §16）

| 模块 | 函数 | 纯函数？ | 零模型？ | 双语言风险 | INV |
|---|---|---|---|---|---|
| evalStats | `fmtFixed`, `cmpCodePoint` | 是 | 是 | 已封死 | 55 |
| | `wilson`（沿用现有，补 clamp 断言） | 是 | 是 | 仅 sqrt | 24 |
| | `exactMcNemar(onlyA, onlyB)` | 是 | 是 | 仅乘除 | 40 |
| | `passAtKUnbiased(n,c,k)` / `passHatKUnbiased(n,c,k)` | 是 | 是 | 仅乘除 | 15, 16 |
| | `mdePaired` / `sampleSizePaired` | 是 | 是 | sqrt + 常数 | 44 |
| | `budgetCurve` / `paretoFrontier` / `reprice` | 是 | 是 | 无 | 21–23 |
| | `makeProfileTasks` / `simulatePair` / `simulateAA` | 是（给定种子） | 是 | 只用 LCG | 39, 42 |
| taskAudit | `auditTaskRecord` | 是 | 是 | 无 | 3, 4 |
| | `statementLeak` / `undeclaredRequirements` | 是 | 是 | 字符串切分需统一（按 `\n`、`\W+`；显式字符类） | 5, 12 |
| | `leakSurface` / `auditTrace` | 是 | 是 | 正则 → 统一子集 | 6, 7, 52 |
| codingEval | `scoreboard(attempts, policy)` / `funnel` | 是 | 是 | 无 | 17, 18 |
| | `pairedTransitions` / `abVerdict` / `aaChurn` / `churnThreshold` | 是 | 是 | 无 | 39–42 |
| | `codingGateV2({mode,…})` | 是 | 是 | 无 | 45, 47 |
| | `factorialEffects` / `ablationVacuity` | 是 | 是 | 无 | 34–36 |
| | `runKey(meta)` / `taskSetHash` | 是 | 是 | FNV-1a 32 位（`Math.imul` ↔ Python `& 0xFFFFFFFF`） | 38, 50 |

**正则统一子集**：只用 `[A-Za-z0-9_./:-]` 字符类、`\n` 分行、字面量 `includes`；不用 lookbehind、命名组、Unicode 属性。

### 9.4 观察实验（EXP）——全程零模型，TS 与 Python 逐字节一致

> 每个实验 = 一张表 + 一句**不替学员下结论**的旁白。**旁白不得出现没有来源的机制断言**（D-3/D-12 的教训）。

| EXP | 标题 | 输入 | 表 | 要暴露的倒置 | 草稿对应 |
|---|---|---|---|---|---|
| **EXP-1** | 同一批 attempts，漏斗 + 三种分母 | demo 12 题 + 2 个 infra error + 1 个超时 | ①漏斗（提交→可应用→F2P 绿→P2P 绿→无 hack→resolved）；②`all/graded/errorRerun` 三种 headline | INV-17, 18 | 实验一（升级） |
| **EXP-2** | N 与区间：同样的 8/10 在不同 N 下说了什么 | N∈{10,20,30,50,100,300,500}, p̂=0.5；0/30 与 30/30 | ①Wilson 宽度；②`bootstrapCI` vs Wilson 在 0/30、27/30；③Multilingual 七片 Wilson 区间 | INV-24, 27 | 实验二（升级） |
| **EXP-3** | pass@k 与 pass^k：天真 vs 无偏 vs 真实数据 | 异质轮廓 40 题 × 6 次；并列 SWE-agent Table 10 的常量 | k=1..6：`naive pass@k`、`unbiased pass@k`、`naive pass^k`、`unbiased pass^k`；另一表 SWE-agent 实测 vs `1−(1−p̂)^k` | INV-14, 15, 16 | 新 |
| **EXP-4** | 成本：三个平均 + 两条曲线 | demo 12 题（含 `costToGreenUsd`） | ①三个平均；②**按花费分桶** vs **预算截断** 并排 | INV-20, 21 | 实验三（替换） |
| **EXP-5** | 配对、A/A 与「看见」的代价 | 轮廓任务、makeRng；N∈{30,100,300}、δ∈{0,+5,+10pp}、200 次重复 | ①A/A 不一致对占比；②配对精确 vs 非配对 z 的功效；③(c,b) 稀疏表：bootstrap vs 精确 | INV-39, 40, 41, 42 | 实验五（升级） |
| **EXP-6** | 消融：因子表 + 空操作 | 2³ 因子夹具（带交互）；一条「被消融工具从未被调用」的轨迹 | ①主效应/交互；②OFAT-from-full vs from-empty 符号；③`ablationVacuity` | INV-34, 35, 36 | 实验四（替换） |
| **EXP-7** | 门禁混淆矩阵：旧规则 vs regress/claim | 同 EXP-5 的合成数据；真实 δ∈{−10,−5,0,+5,+10pp} | 每个 δ 下：旧门 pass 率、新 regress 门 pass 率、claim 门通过率 | INV-42, 45 | 实验五尾部（升级） |
| *EXP-8（可选）* | 泄漏审计：同一条任务，两个工作区 | 一份结构化仓库快照 + 一条录制的 toolLog | `leakSurface` 命中项；`auditTrace` 命中项 | INV-6, 7, 52 | 新 |
| *EXP-9（可选）* | 重定价：同一批 tokens，两张价格表，两个排名 | 3 个变体的 tokens 分项 | 美元与排名 | INV-22 | 新 |

**EXP-5 的预期形态**（`[O]` 来自 U 形仿真，lab 用离散轮廓，数值不同、形状相同）：

| N | δ | 配对精确 功效 | 非配对 z 功效 | A/A 假阳性（配对 / 非配对） |
|---|---|---|---|---|
| 30 | +5pp | 3.4% | 1.3% | 1.3% / 0.3% |
| 100 | +5pp | 9.9% | 3.5% | 3.1% / 0.6% |
| 200 | +5pp | 21.3% | 6.9% | 4.0% / 0.7% |
| 500 | +5pp | 49.4% | 25.0% | 4.5% / 0.7% |
| 200 | +10pp | 64.8% | 40.6% | — |
| 500 | +10pp | 95.7% | 86.5% | — |

**读法**：非配对不是「假阳性多」，而是**几乎看不见效果**；配对精确检验在小 N 偏保守（A/A 假阳性 1.3–4.5%），所以**不会**因为「保守」而被误判成能力。

**EXP-7 的预期形态**（`[O]` 真实跑 `codingGate`，U 形仿真，每格 400 次）：

| N | 真实 δ | 旧门 pass | 旧门：churn(≥3) 拦 | 旧门：点估计上升不显著 拦 | 旧门：显著变差 拦 |
|---|---|---|---|---|---|
| 30 | +10pp | 0.14 | 0.50 | 0.65 | 0.00 |
| 30 | 0 | 0.04 | 0.73 | 0.43 | 0.02 |
| 30 | −10pp | 0.02 | 0.89 | 0.18 | 0.17 |
| 100 | +10pp | 0.01 | 0.99 | 0.55 | 0.00 |
| 100 | 0 | 0.00 | 1.00 | 0.49 | 0.02 |
| 100 | −5pp | 0.00 | 1.00 | 0.17 | 0.12 |
| 300 | −5pp | 0.00 | 1.00 | 0.06 | 0.30 |
| 300 | −10pp | 0.00 | 1.00 | 0.00 | 0.83 |

**读法**：旧门在 N≥100 时对 U 形噪声**几乎永远拦**——不管真实效应是好是坏；它**没有区分度**。新门应该在 δ=0 与 δ>0 时**通过**、在 δ<0 且可检出时**拦**。

### 9.5 学员 TODO（7 个；T1–T6 必做，T7 拔高）

| T | ★ | 函数 | 学员写什么 | 关键陷阱 | 关联断言 | 估时 |
|---|---|---|---|---|---|---|
| **T1** | ★ | `auditTaskRecord(task, evidence)`（含 `classifyAttempt` 热身） | 四件套：base 红、gold 绿、空补丁红、gold 3 次一致；返回 `{ok, gaps, flaky}`；`error` 优先于 `hacked` | 「F2P 红」要求**所有**重复运行都红，不是任一次 | SET-10…12, CLS-9 | 15 |
| **T2** | ★ | `passAtKUnbiased(n,c,k)` / `passHatKUnbiased(n,c,k)` | 连乘公式；边界；`k>n` 抛错 | 不要用 `Math.pow`；先判 `n−c<k` | PK-1…3 | 10 |
| **T3** | ★★ | `scoreboard(attempts, policy)` + `funnel(attempts)` | 三种分母政策；漏斗各级单调不增；`apply` 与 `resolve` 同分母 | `errorRerun` 只能在**给定已重跑结果**时断言；`graded` 要把 infra error 与 agent 超时分开 | DEN-1…2, FUN-1…2 | 25 |
| **T4** | ★★ | `exactMcNemar(b,c)` + `pairedTransitions(a,b,{k})` | 递推 `2^{-n}`、双侧 p；K>1 的**稳定转移** | 不要循环调用阶乘；`n=0` 返回 1；交换 a/b 镜像 | STAT-1…3, AB-3…4 | 30 |
| **T5** | ★★★ | `codingGateV2({mode,…})` | `regress`（非劣 + 校准 churn + infra + 键）与 `claim`（优效）；返回 `status ∈ {pass, regressed, ungradable}` | **不要**写「点估计上升但不显著 → 拦」；ungradable ≠ regressed（退出码不同） | GATE-6…10 | 35 |
| **T6** | ★★ | `budgetCurve(attempts, budgets)` + `paretoFrontier(points)` | `rate(B)` 单调、`B=0 → 0`、未到绿视为 +∞；前沿的「被谁支配」 | 相等点不算支配；`costToGreen` 缺失 | COST-7…9 | 20 |
| **T7**（拔高） | ★★★ | `factorialEffects(outcomes, factors)` | 2^k 配置的主效应与两两交互；OFAT-from-full / from-empty 符号对比 | 编码 ±1 后手算；别用矩阵库 | ABL-5…6 | 30 |

**时间预算**（课程 180–240 分钟）：讲稿 + 阅读 40 → 跑观察实验并读表 25 → T1–T6 合计 135 → T7 拔高 30（自选）→ 总计约 200（含拔高 230）。

**与草稿的映射**：草稿 TODO 1/2（validateTaskSet/classifyAttempt）→ 合并升级为 T1；TODO 3（rateSpectrum）→ T3；TODO 4（costCurve）→ **替换**为 T6；TODO 5（ablationTable）→ 其「差值 + decisive」部分改为 shared 参考实现，学员改做 T7；TODO 6（codingGate）→ T5。新增 T2、T4。

### 9.6 零模型断言清单（共 90 条：保留 37 + 修订 8 + 新增 45）

**A. 草稿已有，原样保留（37）**：
`SET-1…9`（9）、`CLS-1…8`（8）、`RATE-1…6, 9`（7）、`COST-1, 2, 5`（3）、`ABL-1, 2, 4`（3）、`AB-1, 2`（2）、`GATE-1, 4`（2）、`FIX-1…3`（3）→ 9+8+7+3+3+2+2+3 = **37**。

**B. 草稿已有，需修订（8）**：

| ID | 现状 | 修订 |
|---|---|---|
| RATE-7 / RATE-8 | 断言 `passAtK/passHatK(...).hits` | 改为断言**无偏估计的率**（与 PK-1 联动）；保留「pass^2 的命中是 1」这一直觉的同义断言 |
| COST-3 / COST-4 | 桶按花费排序 / 均价递增（构造性成立，没有信息量） | 改为一条**教材性断言**：对 demo 同一批数据，`costCurve` 最高桶的 resolve 率 < 最低桶（读成「越花钱越差」），而 `budgetCurve` 单调不降（读成「加预算不会更差，且到 $0.10 就停止收益」）——两种读法并存，注释里写明因果方向；COST-4 删除 |
| ABL-3 | baseline Δ=0（恒真） | 改为：baseline 行 `decisive` 为 `null`/不适用 |
| GATE-2 | 绑文案 | 改为按**结构化 blocker 码**（`code ∈ {HACK, CHURN, …}`）断言 |
| GATE-3 | 通过或被拦都接受 | 拆成 GATE-6（regress 模式：噪声里 +1 通过）与 GATE-10（claim 模式：同数据不可宣称） |
| GATE-5 | `∨ !gate4.pass` 恒真 | 改为：`warnings` **必须**含 apply↑ resolve 未↑ 的结构化码 |

**C. 新增（45）**：

| ID | 断言 | 夹具 | INV |
|---|---|---|---|
| SET-10 | `validity.goldGreenRuns` 含 false → gap「gold 未通过」 | 手写 TaskInstance | 3 |
| SET-11 | `validity.emptyGreen === true` → gap「空补丁就过，任务是空转的」 | 同上 | 3 |
| SET-12 | `baseRedRuns` 不一致 / `flaky` 非空 → gap，且 flaky 名单被列出 | 同上 | 4 |
| CLS-9 | `errored` 与 `testsMutated` 同时为真 → `'error'`（error 优先） | att | 19 |
| NUM-1 | `fmtFixed(0.125,2)=='0.13'`、`(2.5,0)=='3'`、`(0.5,0)=='1'`、`(-2.5,0)=='-3'`、`(12.5,0)=='13'`、`(1.005,2)=='1.00'` | 常量 | 55 |
| NUM-2 | `wilson(0,30).lo===0`、`.hi` 的 3 位小数为 `0.114`；`wilson(30,30).hi===1` | 常量 | 24 |
| NUM-3 | `makeRng(42)` 前 5 个值的 `fmtFixed(·,9)` 与固定向量相等 | 向量 | 55 |
| NUM-4 | `cmpCodePoint` 对 `['B','a','_x','-y','1','Z','ab','a-b']` 排序得 `-y,1,B,Z,_x,a,a-b,ab` | 向量 | 55 |
| STAT-1 | `exactMcNemar(0,4)=0.125`、`(0,6)=0.03125`、`(1,7)=0.0703125`（精确到 1e-12） | 常量 | 40 |
| STAT-2 | `(5,5)=1`、`(0,0)=1`、`(3,9)=(9,3)`；`n>1000` 抛错 | 常量 | 40 |
| STAT-3 | `mdePaired(1000,0.25)` 3 位小数 `0.044`；`sampleSizePaired(0.05,0.25)=785`；δ 减半 → N 约 ×4 | 常量 | 44 |
| STAT-4 | `wilson(12,30)` 的 `[lo,hi]` 3 位小数 `[0.246, 0.577]` | 常量 | 24 |
| STAT-5 | **特征化断言**：对 N=40、修好 4、弄坏 0，`compareRuns(...).significant===true` **而** `exactMcNemar(0,4)>0.05`（记录 L12 的反保守） | 夹具 | 40 |
| PK-1 | `passAtKUnbiased(5,3,2)=0.9`；`passHatKUnbiased(5,3,2)=0.3` | 常量 | 16 |
| PK-2 | `k=1` 时二者都等于 `c/n`；`c=0`→0/…；`c=n`→1；`k>n` 抛错 | 常量 | 16 |
| PK-3 | 双峰夹具（一半题 c=n、一半题 c=0）：无偏 pass^3 **大于**天真 `p̂³`，无偏 pass@3 **小于**天真 `1−(1−p̂)³` | 夹具 | 15 |
| DEN-1 | 同一批 12 条含 2 infra error：`all` 的 resolve 率 < `graded`；未知政策抛错 | att | 18 |
| DEN-2 | `all` 政策下 `apply` 与 `resolve` 的 `n` 相同 | att | 18 |
| FUN-1 | 漏斗各级计数单调不增 | demo | 17 |
| FUN-2 | demoBaseline 的漏斗计数固定为 `12 → 11 → 7 → 7 → 6 → 6`（提交 → 补丁可应用 → F2P 绿 → P2P 绿 → 未改测试/无 block → resolved；`[O]` 按现有夹具手算并与 `rateSpectrum` 的 apply=11、f2p=7、resolve=6 对上） | demo | 17 |
| COST-6 | demo 夹具三个平均：`0.0417 / 0.2267 / 0.4533`（4 位）且递增 | demo | 20 |
| COST-7 | `budgetCurve` 单调不降；`B=0`→0；`B=∞`→resolved 率 | demo | 21 |
| COST-8 | demo：`rate(0.05)=4/12`、`rate(0.10)=6/12`、`rate(10)=6/12` | demo | 21 |
| COST-9 | `paretoFrontier`：构造 `(84.9,$146)`、`(88.0,$29)`、`(81.3,$21)`，前两者中前者被后者支配、第三个在前沿上 | 常量（aider 数据） | 23 |
| COST-10 | `reprice` 在两张价格表下使 A/B 两变体**排名互换**（构造：A 输出多/缓存多，B 反之） | 夹具 | 22 |
| ABL-5 | `factorialEffects` 在带交互夹具上：主效应符号、交互项非零 | 2³ 夹具 | 34 |
| ABL-6 | 同夹具：OFAT-from-full 说 A「无效」，OFAT-from-empty 说 A「有效」（符号不同） | 同上 | 34 |
| ABL-7 | `ablationVacuity`：被消融工具调用 0 次 → `'vacuous'`；>0 → `'live'` | toolLog | 36 |
| ABL-8 | 含 1 个 error attempt 时，`deltaVsBaseline` 与 CI 用**同一**分母（构造两者在草稿实现下会不一致） | att | 18 |
| AB-3 | 转移表 `onlyA+onlyB+both+neither=N`；交换 a/b → `onlyA↔onlyB` | att | 39 |
| AB-4 | K=3 的稳定转移：A 的 3 次里 3 过、B 的 3 次里 0 过 → 稳定弄坏；A 2 过、B 1 过 → 不稳定（不计） | att | 41 |
| AB-5 | `aaChurn`：同一批题两次运行 → `{fixed, broken}` 计数；`churnThreshold([…], 0.05)` 取经验分位 | 夹具 | 42 |
| AB-6 | 两次运行 id 不匹配 → **抛错**而不是静默丢弃 | att | 43 |
| AB-7 | 「同 runKey、不同 diff」→ 抛错（模拟 harness `run_id` 缓存陷阱） | 夹具 | 43 |
| GATE-6 | `mode:'regress'`：点估计 +1 但不显著、`broken ≤ 阈值` → `pass`（旧门会拦） | 夹具 | 45 |
| GATE-7 | `mode:'regress'`：显著变差（精确 p<α）→ `regressed`，`blockers[0].code==='SIG_WORSE'` | 夹具 | 45 |
| GATE-8 | infra 错误率 > 阈值 → `status:'ungradable'`（不是 `regressed`） | 夹具 | 19 |
| GATE-9 | `runKey` 的任一**非被测**字段变化（`taskSetHash/scaffoldCommit/resources/priceTable/k`）→ 拦；被测字段变化 → 放行 | 循环各字段 | 38, 50 |
| GATE-10 | `mode:'claim'`：同样的「+1 不显著」数据 → `claimable:false`；+8/−0 且精确 p<0.05 → `claimable:true` | 夹具 | 45 |
| LEAK-1 | `statementLeak`：gold 新增行逐字出现在题面 → 覆盖率≥阈值；干净题面 → 0 | 字符串 | 5 |
| LEAK-2 | `undeclaredRequirements`：测试新增含 `--api-key` 字面量、题面只说 `--token` → 报告 `--api-key` | 字符串 | 2, 12 |
| LEAK-3 | `leakSurface`：快照含 base 之后的 ref/对象、含 40-hex 的 id → 各自命中；干净快照 → 空 | 结构化快照 | 6, 7 |
| TRC-1 | `auditTrace`：`git log --all`、`git show <40hex>` → `block` | toolLog | 52 |
| TRC-2 | `curl https://raw.githubusercontent.com/…`、`git clone https://github.com/…` → `block` | toolLog | 52 |
| TRC-3 | 良性命令（`git status`、`git diff`、`pytest -q`）→ 不命中；读 `tests/` 下**非隐藏**文件 → 不命中 | toolLog | 52 |

**统计**：A 37 + B 8 + C 45 = **90**。分组计数：SET 12 · CLS 9 · NUM 4 · STAT 5 · PK 3 · RATE 9 · DEN 2 · FUN 2 · COST 10 · ABL 8 · AB 7 · GATE 10 · LEAK 3 · TRC 3 · FIX 3（⇒ 12+9+4+5+3+9+2+2+10+8+7+10+3+3+3 = 90 ✓）。

**双语言机制**：`verify.ts` 与 `verify.py` **断言 ID、顺序、总数一致**；最后一行都打印 `✓ 90 条断言全部通过`；CI 再加一条脚本：`diff <(tsx l18/bench.ts) <(uv run python -m l18.bench)` 与 `diff <(tsx l18/verify.ts) <(uv run python -m l18.verify)`（后者在 `BENCH_IMPL=shared` 下）。

### 9.7 只属于 `l18/runner.ts`（live）的东西

| # | 内容 | 为什么不在 verify |
|---|---|---|
| R-1 | 用真实 agent 在任务集上跑 **K 次**、**按题交错 A/B**、每次**全新工作区** | 调模型；不可复现 |
| R-2 | `--audit-tasks`：对每题跑 base / gold / 空补丁 / gold×3，生成 `validity` | 需要沙箱，**不需要模型**；慢 |
| R-3 | **A/A 校准**运行，写 `aaChurn` 进基线 | 调模型 |
| R-4 | 补强测试（UTBoost 式 LLM 生成测试）、LLM 复核被 `auditTrace` 标记的轨迹 | 调模型 |
| R-5 | 资源与 infra 采集：容器 CPU/内存/超时、错误分类（Anthropic：留 ~3× 余量） | 环境相关 |
| R-6 | HAL 式 **LLM 辅助轨迹审查**（找「在网上搜基准」之类） | 调模型 |
| R-7 | 价格表与 **token 分项**采集（input/cached/output 来自 API usage） | 外部数据 |
| R-8 | 污染探针：**不给仓库上下文**让模型定位文件，统计命中率（SWE-bench Illusion 一类方法，`[S]` 见 §15 M-4） | 调模型 |
| R-9 | nightly 编排：退出码 `0/1/2`、连续两晚确认、写基线 | 时间序列 + 外部 |
| R-10 | 预算上限**实测** vs 截断曲线对照（验证「截断≈真实上限」的假设） | 调模型 |

`runner.ts` 头注释沿用 L17 的口径：**「不要用这个脚本当 CI 门；成功率不可复现」**——但 L18 里它**确实**是 nightly 门，所以头注释应改为「它是 nightly 门，不是 PR 门」。

---

## 10. 主题改名结论（条件性：证据成立才改）

### 10.1 现状与证据

当前 `topics`：`['任务集构建','成功率与成本曲线','消融实验','A/B 对比']`；`outcome`：「一套能证明『我改的这版确实更好』的评测与**回归**体系」。

| 证据 | 内容 | 强度 |
|---|---|---|
| **E1** | outcome 明确要求「**回归体系**」，但 4 个 topic **没有一个**是回归门禁；而 INV-45/47/48/50 与 §6 表明门禁是 L18 最有工程价值的部分，且现有草稿的最大缺陷（D-4）就在这里 | **强** |
| **E2** | 「成功率与成本曲线」：INV-13/14/18 表明**「成功率」不是一个量**（口径、尝试策略、分母），INV-21 表明「成本曲线」按花费分桶是**错的读法** → 标题会把学员引向画一条错曲线 | 中 |
| **E3** | 「A/B 对比」：行业语境里 A/B = 线上流量实验（Cursor）；本课做的是**离线配对比较 + 噪声底**，线上 A/B 属 L19。「对比」本身也漏掉了 A/A（INV-29/42） | 中 |
| **E4** | 「任务集构建」只覆盖「造」；INV-1…12 表明更重要的是「**验、封存、审计泄漏**」 | 中 |
| **E5** | L17 的 IOU（「SWE-bench 方法论」）没有任何一个 topic 承接 | 中 |

### 10.2 结论

**判定：改名成立。**（E1 强证据 + E2/E3/E4/E5 四条中等证据；与 L17 的「改名」同级。）

**方案 A（推荐，5 个主题）**
1. **任务集：造、验、封存**（构造 + gold 验证四件套 + 题面/泄漏面审计 + 版本与哈希）
2. **指标与分母：成功率、成本、区间**（漏斗、分母政策、pass@k vs pass^k、Wilson、三个平均、预算曲线、帕累托、SWE-bench 家族案例）
3. **成对对比与噪声底**（配对转移、精确检验、K 次重复、A/A、MDE、何时不该 A/B）
4. **消融：只做会改决策的**（决策四问、因子设计、空操作消融）
5. **回归门禁：零模型 PR 门 + nightly 实跑**（regress vs claim、基线键、infra 错误率、hack 调整、退出码）

**方案 B（若 curriculum 要求保持 4 个主题）**
1. **任务集：造、验、封存**
2. **指标与分母**（含成功率、成本曲线、区间）
3. **成对对比与消融**（合并 3、4）
4. **回归门禁**

**方案 C（最小改动，不改 topic 数量）**：`任务集构建` / `成功率与成本曲线` → `指标与分母` / `消融实验` / `A/B 对比` → `成对对比与回归门禁`。

> `kind`/`minutes`/`outcome` 不变；`outcome` 文本无需修改。若 curriculum 采用方案 A，请同步更新 `src/lib/curriculum.ts` L18 的 `topics`，并在讲稿的 `§方法论` 里把 SWE-bench 家族案例分散到主题 1、2 中，而不是单独开一节「SWE-bench 介绍」。

---

## 11. 讲稿骨架建议（180–240 分钟）

| 时段 | 内容 | 要现场演示的「反直觉」 |
|---|---|---|
| 0–10 | **钩子**：把 L17 的 demo 跑一遍，再问「所以它的成功率是多少？」→ EXP-1：同一批 attempts，漏斗 + 三种分母；再讲 §0.1：Pro 被撤回、−21.48pp | 「成功率」没有唯一答案 |
| 10–40 | **任务集：造、验、封存**（§3）：四件套、题面泄漏、泄漏面；EXP-8（可选） | gold 过 ≠ 任务有效；空补丁也过的任务 |
| 40–75 | **指标与分母**（§4）：EXP-2/3/4 | pass^k ≠ p̂^k；三个平均成本差 10.9×；按花费分桶是反向因果 |
| 75–105 | **成对对比与噪声底**（§5.3）：EXP-5 | **非配对看不见 +5pp**；bootstrap 在 (4,0) 就显著；A/A 本身就有 25% 的不一致对 |
| 105–125 | **消融：只做会改决策的**（§5.1–5.2）：EXP-6 | OFAT 从全配置减 vs 从空配置加，结论相反；空操作消融 |
| 125–150 | **回归门禁**（§6）：EXP-7 | 旧门禁 N=100 时 A/A 就 100% 被拦；regress/claim 两门 |
| 150–200 | 动手：T1–T6（T7 拔高） | — |
| 末 5 | IOU → L19：nightly 的退出码、基线 schema、线上指标由 L19 接 | — |

**必须回扣 L17 的三处**：`detectHacks` → raw/clean/hack-flagged；`toolLog` → `auditTrace`；`applyEdits` 的反馈层 → 机制 micro-eval（mutation 套件）。

---

## 12. 自产证据（`[O]`）：方法、数字、复现

> 探针脚本放在 `/tmp/l18probe/`，**不进工作区**。下面给出可复现的最小片段与结果。环境：macOS arm64，Node v22.19.0，Python 3.13.13。

### 12.1 数值层：舍入、libm、排序

**舍入**（精确平局）：

```
node -e 'console.log((0.125).toFixed(2),(2.5).toFixed(0),(0.5).toFixed(0),(1.5).toFixed(0),(12.5).toFixed(0),(0.375).toFixed(2),(1.005).toFixed(2))'
→ 0.13 3 1 2 13 0.38 1.00
python3 -c "print(f'{0.125:.2f}',f'{2.5:.0f}',f'{0.5:.0f}',f'{1.5:.0f}',f'{12.5:.0f}',f'{0.375:.2f}',f'{1.005:.2f}')"
→ 0.12 2 0 2 12 0.38 1.00
```

JS `toFixed` 在**精确可表示的平局**上取大；Python 取偶。非平局（如 `1.005`，实际二进制值略小于 1.005）两者一致。

**libm 末位**：用同一 LCG 生成 20 万个 `x∈(0.001,20)`、`y∈(−2,2)`，在 V8 与 CPython 里算 `log(x)`、`exp(y)`、`pow(x,y)`、`sqrt(x)`，逐位比较 IEEE-754 双精度：

```
{'log': '4.9%', 'exp': '10.1%', 'pow': '9.8%', 'sqrt': '0.0%'}
```

（上一轮用另一输入分布得到 6.4% / 10.0% / 7.6%；结论一致：**5–10% 的输入末位不同**，`sqrt` 为 0。）

**排序**：

```
JS : ['B','a','_x','-y','1','Z','ab','a-b'].sort((x,y)=>x.localeCompare(y)) → _x | -y | 1 | a | a-b | ab | B | Z
Py : sorted([...])                                                            → -y | 1 | B | Z | _x | a | a-b | ab
```

### 12.2 pass@k 与异质性

**SWE-agent Table 10**（`[P]`，6 次运行 GPT-4 Turbo / SWE-bench Lite，N=300）：每次 resolve% = 17.33 / 18.00 / 18.00 / 18.67 / 17.33 / 18.33，均值 17.94 ± 0.49；pass@k（k=1…6）= 17.94 / 23.89 / 27.35 / 29.67 / 31.33 / 32.67。

| k | 实测 pass@k | 同质假设 `1−(1−0.1794)^k` |
|---|---|---|
| 1 | 17.94 | 17.9 |
| 2 | 23.89 | 32.7 |
| 3 | 27.35 | 44.7 |
| 4 | 29.67 | 54.7 |
| 5 | 31.33 | 62.8 |
| 6 | 32.67 | **69.5** |

**U 形异质**（每题成功概率 `p~Beta(½,½)`，均值 ½；闭式 `E[p^k] = Γ(k+½)/(√π·k!)`，`pass@k = 1−E[(1−p)^k]`，对称）：

| k | 真实 pass^k | 天真 (½)^k | 真实 pass@k | 天真 1−(½)^k |
|---|---|---|---|---|
| 1 | 0.5000 | 0.5000 | 0.5000 | 0.5000 |
| 2 | 0.3750 | 0.2500 | 0.6250 | 0.7500 |
| 3 | 0.3125 | 0.1250 | 0.6875 | 0.8750 |
| 5 | 0.2461 | 0.0313 | 0.7539 | 0.9688 |
| 8 | **0.1964** | **0.0039** | 0.8036 | 0.9961 |
| 10 | 0.1762 | 0.0010 | 0.8238 | 0.9990 |

无偏估计小例：`n=5, c=3`：`pass@2 = 1−C(2,2)/C(5,2) = 0.9`，`pass^2 = C(3,2)/C(5,2) = 0.3`。

### 12.3 配对 vs 非配对、精确 vs bootstrap、功效与样本量

**仿真**（Python）：对每个重复，生成 N 个任务，`p_i ~ Beta(½,½)`；A 臂 `Bernoulli(p_i)`，B 臂 `Bernoulli(clip(p_i+δ))`，**每臂 1 次运行**；统计 `b`（仅 A 过）、`c`（仅 B 过）；配对检验 = 精确双侧 McNemar（`min(1, 2·Σ_{i≤min(b,c)} C(b+c,i)/2^{b+c})`），非配对检验 = 两比例 z 检验（双侧 0.05）；每格 600–1000 次重复。结果见 §9.4 EXP-5 表。关键读数：

| N | δ | 配对精确 | 非配对 z | A/A 假阳性（配对 / 非配对） |
|---|---|---|---|---|
| 30 | 0 | 1.3% | 0.3% | — |
| 60 | +10pp | 18.2% | 8.9% | — |
| 100 | +10pp | 31.6% | 17.7% | 3.1% / 0.6% |
| 200 | +5pp | 21.3% | 6.9% | 4.0% / 0.7% |
| 500 | +5pp | 49.4% | 25.0% | 4.5% / 0.7% |

**样本量**（每格 400 次，配对精确检验）：

| N | δ | 功效 | 平均不一致对数（占 N） |
|---|---|---|---|
| 200 | +15pp | 0.902 | 54.1（27.0%） |
| 300 | +10pp | 0.805 | 78.6（26.2%） |
| 300 | +5pp | 0.307 | 76.0（25.3%） |
| 1000 | +5pp | 0.810 | 254.3（25.4%） |
| 2000 | +5pp | 0.988 | 508.7（25.4%） |

正态近似公式 `mde = 2.8016·√(d/N)` 在 `d=0.25` 下给出：N=300 → 8.1pp、N=1000 → 4.4pp、N=2000 → 3.1pp；与仿真吻合（精确检验略保守，需要多约 25% 的样本）。

**本地 `compareRuns`（shared/evals.ts）对稀疏不一致对的判定**（N=40，concordant 题保持两次一致通过）：

| 修好 c | 弄坏 b | bootstrap `significant` | bootstrap CI | 精确 McNemar p（双侧） |
|---|---|---|---|---|
| 3 | 0 | false | [0.000, 0.150] | 0.250 |
| 4 | 0 | **true** | [0.025, 0.200] | 0.125 |
| 5 | 0 | true | [0.025, 0.225] | 0.063 |
| 6 | 0 | true | [0.050, 0.275] | 0.031 |
| 5 | 1 | false | [0.000, 0.225] | 0.219 |
| 7 | 1 | true | [0.025, 0.300] | 0.070 |
| 8 | 2 | false | [0.000, 0.300] | 0.109 |
| 10 | 3 | false | [0.000, 0.350] | 0.092 |

N=20 与 N=100 下 (4,0) 同样翻为「显著」。原因：`b=0` 时 `(1−c/N)^N < 0.025` 即下界 >0，`N→大` 时约 `c ≥ 3.69`，与 N 几乎无关。

### 12.4 成本（本地 12 题夹具的算术）

demoBaseline 的 12 个 costUsd：`0.02,0.03,0.02,0.01,0.08,0.10,0.09,0.07,0.40,0.50,0.60,0.80`（合计 $2.72）；resolved 的 6 个（e1,e2,e3,c-easy,m1,m3）：`0.02,0.03,0.02,0.01,0.08,0.09`（合计 $0.25）。

- `costPerResolvedOnly = 0.25/6 = $0.0417`
- `costPerAttempt = 2.72/12 = $0.2267`
- `costPerResolved = 2.72/6 = $0.4533`（= `costPerResolvedOnly` 的 **10.9×**）
- 预算曲线（假设 resolved 的花费即 `costToGreen`）：`rate($0.05)=4/12`，`rate($0.10)=6/12`，`rate(≥$0.10)=6/12`。
- 现有 `costCurve(4 桶)`：`100% / 67% / 33% / 0%`。

### 12.5 草稿 `codingGate` 的混淆矩阵

**方法**：调用**真实的** `codingGate`（shared/codingEval.ts），任务集 N 题（难度轮换 easy/medium/hard、全部 `repoPin` 非空），每题 `p_i = sin²(π·u/2)`（即 Beta(½,½)），baseline 以 `p_i` 抽样，candidate 以 `clip(p_i+δ)` 抽样，`patchApplied:true, passToPassGreen:true`；每格 400 次；种子 7。统计 `pass`、blockers 里含「弄坏」「不显著」「显著低于」的比例。结果见 §9.4 EXP-7 表。

### 12.6 草稿审计与 L12 工具实测

- `BENCH_IMPL=shared node l18/verify.ts` → `✓ 45 条断言全部通过`；`node l18/bench.ts` 与 `python3 -m l18.bench` 的输出 `diff` 为空。
- `bootstrapCI(Array(30).fill(0))` → `{lo:0, hi:0}`；`bootstrapCI(Array(30).fill(1))` → `{lo:1, hi:1}`；`bootstrapCI([...27×1, 3×0])` → `{lo:0.767, hi:1}`；Wilson(27/30)=`[0.744, 0.965]`。
- `compareRuns`：40 题，4 个修好 + 4 个弄坏，其余一致 → verdict 打出「**这不是改进，这是换了一批 bug**」——**而这正是 A/A 在 N=40 时常见的噪声形态**（INV-42）。
- Multilingual 七片 Wilson：见 INV-27。Wilson（N=10…1000，p̂=0.5）：`[23.7,76.3]`、`[29.9,70.1]`、`[33.2,66.8]`、`[36.6,63.4]`、`[40.4,59.6]`、`[42.1,57.9]`、`[44.4,55.6]`、`[45.6,54.4]`、`[46.9,53.1]`；`0/N` 的上界：N=10 → 27.8%、20 → 16.1%、30 → 11.4%、50 → 7.1%。

---

## 13. 来源清单

**基准与方法论（一手）**
- SWE-bench 原论文 / 文档：swebench.com；官方评测指南 `docs/guides/evaluation.md`（run_id 缓存、结果分类）——<https://github.com/swe-bench/swe-bench/blob/main/docs/guides/evaluation.md>
- SWE-bench issue #167（flaky 测试）——<https://github.com/swe-bench/SWE-bench/issues/167>
- SWE-bench Multilingual（含逐语言表）——<https://www.swebench.com/multilingual>
- SWE-bench-Live：arXiv 2505.23419；`Development.md`、`evaluation/README.md`——<https://github.com/microsoft/SWE-bench-Live>
- SWE-rebench 榜单与方法——<https://swe-rebench.com/>、<https://swe-rebench.com/about>
- SWE-Bench Pro：arXiv 2509.16941；Scale 博客——<https://scale.com/blog/swe-bench-pro>
- **SWE-Bench Pro Verified**：arXiv 2609.08149——<https://arxiv.org/abs/2609.08149>；数据集 <https://huggingface.co/datasets/opencompass/SWEBench-Pro-Verified>；转述 <https://reidmarlow.com/the-agent-passed-because-git-show-had-the-fix/> `[P2]`
- OpenAI：*Why we no longer evaluate SWE-bench Verified*——<https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/>；*Separating signal from noise in coding evaluations*（2026-07-08）——<https://openai.com/index/separating-signal-from-noise-coding-evaluations/>；转述 <https://the-decoder.com/openai-finds-roughly-30-percent-of-popular-ai-coding-test-is-broken/> `[P2]`
- SWE-Bench+：arXiv 2410.06992——<https://arxiv.org/abs/2410.06992>
- UTBoost：arXiv 2506.09289；ACL 2025——<https://aclanthology.org/2025.acl-long.189/>
- METR：*Many SWE-bench-Passing PRs Would Not Be Merged into Main*（2026-03-10）——<https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/>
- Terminal-Bench：arXiv 2601.11868；4.0 公告——<https://www.tbench.ai/news/terminal-bench-4-0>
- aider polyglot 榜单（含 yaml 字段）——<https://aider.chat/docs/leaderboards/>
- Cursor：<https://cursor.com/blog/cursorbench>、<https://cursor.com/blog/continually-improving-agent-harness>、Composer 2 技术报告

**评测方法与统计（一手）**
- Anthropic：*Demystifying evals for AI agents*——<https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>
- Anthropic：*Quantifying infrastructure noise in agentic coding evals*（2026-02）——<https://www.anthropic.com/engineering/infrastructure-noise>
- Anthropic：*A statistical approach to model evaluations*——<https://www.anthropic.com/research/statistical-approach-to-model-evals>；Miller：*Adding Error Bars to Evals*，arXiv 2411.00640
- SWE-agent：arXiv 2405.15793（§4 指标、§5 消融、附录 B.5 Table 10）——<https://arxiv.org/abs/2405.15793>
- Chen et al.：*Evaluating Large Language Models Trained on Code*（pass@k 无偏估计）
- τ-bench（pass^k）；Kapoor et al.：*AI Agents That Matter*；HAL：*Holistic Agent Leaderboard*；Agentless（Xia et al. 2024）；Bowyer et al.：*Don't Use the CLT in LLM Evals With Fewer Than a Few Hundred Datapoints*

**本地**
- `research/L17-capstone-coding-agent.md`；`src/lessons/L17/content.mdx`、`src/lessons/L12/content.mdx`
- `labs/shared/{coding.ts, evals.ts, codingEval.ts, coding_eval.py}`；`labs/l12/{regress,suite,verify}.ts`；`labs/l17/{verify,runner}.ts`；`labs/l18/{bench.ts,bench.py,verify.ts}`；`src/lib/curriculum.ts`（L18 条目）

---

## 附：自检表（对照任务的硬性要求）

| 要求 | 位置 |
|---|---|
| 1 以 INV 清单开头，≥40 条且有来源，未溯源单独列出 | §1（55 条）；§15（N-/M-） |
| 2 任务集构建（instance 选择、gold、F2P/P2P、污染、泄漏、pin、分层） | INV-1…12；§3；§2 |
| 2 会说谎的指标（pass@k vs pass^k、resolve vs apply、成本曲线、方差、小 N、多重比较） | INV-13…31；§4 |
| 2 消融（改决策 vs 装饰） | INV-32…38；§5.1–5.2 |
| 2 A/B 与配对（同种子/同任务、顺序、非确定、何时不 A/B） | INV-39…46；§5.3–5.4 |
| 2 回归门禁（零模型 CI vs nightly） | INV-47…52；§6 |
| 2 SWE-bench 家族（Verified/Lite/Multilingual/Live、测试编辑 hack ↔ L17 detect_hacks） | §2；INV-1, 5, 6, 51, 52 |
| 3 lab 设计：shared API、观察实验、5–7 TODO、~60–90 断言、runner-only | §9、§16 |
| 4 主题改名 | §10（方案 A/B/C） |
| 5 与 L12 / L17 / L19 的边界 | §7 |
| 6 无占位符、完整写盘 | 本文件 |
| 7 结尾：Top 5、未溯源清单、API 草图 | §14、§15、§16 |

---

## 14. 最承重的五条倒置（Top 5）

1. **INV-2 / 3 / 49 — 评测系统自己才是被测系统。** F2P/P2P 只证明「gold 过、base 红」，不证明题面够用、测试不过严；解析器与判定器的错误改变榜单名次（UTBoost：Lite 40.9%、Verified 24.4%）；两个「验证过的」基准连续被拆（Verified 59.4%/138；Pro ~30% 并被撤回）。→ **L18 的 verify 把大部分断言花在任务有效性、判定器、统计器上。**
2. **INV-6 — 对 coding agent，最大的「污染」是评测期泄漏，而且可审计。** 堵上 git/文件/网络/id 四条通道，GLM-5.2 从 78.80% 掉到 57.32%（−21.48pp；186 题 P→F vs 15 题 F→P）。→ **`auditTrace` / `leakSurface` / `statementLeak` 是零模型规则，应进每个 PR 门。**
3. **INV-39 / 40 / 42 — 配对 + 精确检验 + A/A 校准才是「看得见」的前提。** 非配对在 N=200、+5pp 时功效 6.9%（配对 21.3%）；本地 L12 bootstrap 在 (4,0) 就判显著（精确 p=0.125）；`broken≥3` 常数在 A/A 噪声下 N=100 时 100% 触发。→ **`exactMcNemar` + `aaChurn` 取代 bootstrap 与常数。**
4. **INV-45 — 回归门要测「不劣于」，不是「显著更好」。** 草稿的「点估计上升但不显著 → 拦」不对称：N=100 的 A/A 有 49% 被拦，真实 −10pp 的退化只有 3% 被这条拦。旧门在 N≥100 几乎「永远拦」，没有区分度。→ **`regress` / `claim` 两门，外加 `ungradable` 状态。**
5. **INV-20 / 21 — 成本是结果的后果，不是旋钮。** SWE-agent 的 `$ Avg. Cost` 只平均成功实例；同一批 12 题上三个「平均成本」差 10.9×；按花费分桶读出的「越贵越差」是反向因果，该画**预算截断曲线**（到 $0.10 后不再有收益）。→ **`budgetCurve` + `costPerResolved`，并在价格表版本下重算美元。**

*荣誉提名*：INV-15（pass^k ≠ p̂^k：SWE-agent 的 pass@6 实测 32.67%，同质假设会给出 69.5%）；INV-55（TS 与 Python 在 `toFixed`/libm/排序上**确实**会不一致，现有 `pct()` 在 2.5% 上就会分歧）。

---

## 15. 未溯源 / 未复核声明清单

> `N-` = 本报告**没有一手来源**，属于归纳或常识；`M-` = 有一手来源，但**本轮没有再次逐条复核**（来自较早检索的记忆或二手转述），使用前请复核。

**N-（无一手来源）**
- **N-1**　统计学常识：因子设计 / OFAT 交互；非劣 vs 优效（回归门 vs 宣称门）；精确 McNemar = 条件二项；`mde ≈ (z_{α/2}+z_β)√(d/N)`；nightly 用更严 α + 连续两晚确认。（标准做法，**未**引用具体文献；L12 的多重比较段是本地依据。）
- **N-2**　本报告的**归纳**：「装饰性/空操作消融」的定义与 `ablationVacuity` 规则；「方差三来源」图；「成本是结果的后果 → 按花费分桶是反向因果」的因果表述（SWE-agent 数据支持「失败更贵、成功更早」，但「反向因果」这个**框架**是本报告的解释）。
- **N-3**　`[S]` Epoch AI 关于 Verified 仓库/难度分布（Django 约占一半、少数仓库占大头）。
- **N-4**　`[S]` LiveCodeBench、AgentBench、Devin 的描述（§2 末三行）：来自记忆，**未在本轮复核**。
- **N-5**　**变异注入题**作为 coding agent 的 mechanism micro-eval：沿用变异测试的做法，**没有**已发表的「变异题 ↔ 真实 bug 评测」的外部效度证据。
- **N-6**　**「公开文献里没有 plan 阶段的消融数据」**：这是**否定性断言**，依据是本轮检索未找到，不能排除遗漏。
- **N-7**　U 形（Beta(½,½)）与离散轮廓只是**建模选择**：真实 coding agent 的每题成功概率分布未知；本报告的功效/churn 数字**随异质性变化**，lab 里的数字是教具，不是对真实 agent 的预测。

**M-（有一手来源但未逐条复核）**
- **M-1**　HAL 的两条结论（更高推理强度在多数运行中降低准确率；LLM 辅助日志检查发现 agent 搜索基准本身）；*AI Agents That Matter* 的「简单基线支配复杂 agent」；Agentless 32.00%/Lite；Chen et al. 的无偏估计；τ-bench 的 pass^k 定义；Bowyer 的 CLT 结论；mini-SWE-agent「约 100 行、只有 bash」与「v2 不设置 temperature」。
- **M-2**　较早检索得到、本轮未重新抓取的**具体数字**：GPT-4.1 在 477 题子集 54.6%（把省略的 23 题按 0 算则 52.1%）；Claude 3.7 Sonnet 在 489 题上 70.3%；Anthropic「修复判定器后 CORE-Bench 42%→95%」；aider 文档关于 temperature=0 仍不确定的原话（经 L17 报告转引）。
- **M-3**　提示缓存的「冷/热」对 A/B 成本的影响幅度：机制成立，**无一手数据**。
- **M-4**　R-8 的「无仓库上下文定位」污染探针，来自 *SWE-bench Illusion* 一类工作的记忆。
- **M-5**　*SWE-Bench Pro Verified* 的「75/22/21」「166/3/0/17」「2,108/326」「318/54」等**细分数字**来自第三方博客对论文的转述（`[P2]`）；论文主数字（78.80→57.32、186/15、103/49、102 题）已由论文页面直接确认。
- **M-6**　**快照数字会过期**：swe-rebench（2026-09 抓取的窗口 111 题、各行率/成本/缓存）、aider 榜单（2025-08-23 的 gpt-5 high 88.0%）。讲稿里要标注抓取日期。

---

## 16. Lab API 草图（`shared/`）

> TS 为准，Python 镜像用 snake_case（`pass_at_k_unbiased`、`exact_mc_nemar`…），类型用 `dataclass`。所有函数**纯函数、零模型、无 `log/exp/pow/toFixed/localeCompare`**。

### 16.1 `shared/evalStats.ts` / `eval_stats.py`

```ts
export interface Interval { lo: number; hi: number }

/** 平局远离零；整数缩放；TS/Py 同序运算。 */
export function fmtFixed(x: number, digits: number): string
export function cmpCodePoint(a: string, b: string): -1 | 0 | 1

export function wilson(hits: number, n: number, z?: number): Interval          // z 默认 1.96；lo≥0、hi≤1
export function exactMcNemar(onlyA: number, onlyB: number): number            // 双侧；n=b+c≤1000
export function passAtKUnbiased(n: number, c: number, k: number): number      // 1 − ∏(n−c−i)/(n−i)
export function passHatKUnbiased(n: number, c: number, k: number): number     // ∏(c−i)/(n−i)
export function mdePaired(n: number, discordantRate: number, zSum?: number): number   // zSum 默认 2.8016
export function sampleSizePaired(delta: number, discordantRate: number, zSum?: number): number

export interface BudgetPoint { budget: number; resolved: number; n: number; rate: number }
export function budgetCurve(attempts: Attempt[], budgets: number[]): BudgetPoint[]

export interface ParetoPoint { name: string; cost: number; rate: number }
export interface ParetoRow extends ParetoPoint { dominatedBy: string | null }
export function paretoFrontier(points: ParetoPoint[]): ParetoRow[]

export interface PriceTable { version: string; inputPerM: number; cachedPerM: number; outputPerM: number }
export function reprice(attempts: Attempt[], table: PriceTable): { costUsd: number; costPerResolved: number | null }

/** 离散轮廓任务难度：无 libm。 */
export function makeProfileTasks(n: number, profile?: number[]): number[]
export function simulatePair(ps: number[], delta: number, rng: () => number): { onlyA: number; onlyB: number }
export function simulateAA(ps: number[], rng: () => number): { fixed: number; broken: number }
```

### 16.2 `shared/taskAudit.ts` / `task_audit.py`

```ts
export interface TaskEvidence {
  baseRedRuns: boolean[]          // F2P 在 base 上是否红（每次重复）
  goldGreenRuns: boolean[]        // gold 上 F2P+P2P 是否全绿
  emptyGreen: boolean             // 空补丁是否也过
  flaky: string[]                 // 重复运行中不稳定的测试名
}
export interface TaskAuditReport { ok: boolean; gaps: string[]; flaky: string[] }
export function auditTaskRecord(task: TaskInstance, ev: TaskEvidence): TaskAuditReport

export function statementLeak(statement: string, goldPatch: string): { overlap: number; lines: string[] }
export function undeclaredRequirements(testPatch: string, statement: string, baseSymbols: Set<string>): string[]

export interface RepoSnapshot { baseCommitTime: number; refs: { name: string; time: number }[]; objects: { id: string; time: number }[]; instanceId: string }
export interface LeakFinding { channel: 'ref' | 'object' | 'id'; detail: string }
export function leakSurface(snap: RepoSnapshot): LeakFinding[]

export interface ToolCall { name: string; args: Record<string, unknown> }   // 与 L17 toolLog 对齐
export interface TracePolicy { blockedHosts: string[]; hiddenPaths: string[] }
export interface TraceFinding { rule: string; severity: 'warn' | 'block'; evidence: string }
export function auditTrace(log: ToolCall[], policy?: TracePolicy): TraceFinding[]
```

### 16.3 `shared/codingEval.ts` / `coding_eval.py`（在现有文件上**增量扩展**）

```ts
// —— TaskInstance 增量字段（均可选，旧夹具仍可用）——
//   repo?: string; statementHash?: string; goldPatchHash?: string; testPatchHash?: string
//   createdAt?: string; suite?: 'capability' | 'regression'; source?: 'own-history' | 'mutation' | 'public-anchor'
//   features?: { files: number; hunks: number; lines: number; f2pCount: number }
//   validity?: TaskEvidence; version?: number

// —— Attempt 增量字段 ——
//   trial?: number; steps?: number; costToGreenUsd?: number
//   tokensIn?: number; tokensCached?: number; tokensOut?: number
//   infra?: boolean            // true = 基础设施失败（与 agent 失败区分）
//   runKey?: string

export type DenominatorPolicy = 'all' | 'graded' | 'errorRerun'
export interface Scoreboard { policy: DenominatorPolicy; n: number; apply: RateReport; resolve: RateReport; rawF2p: RateReport; hackFlagged: RateReport }
export function scoreboard(attempts: Attempt[], policy: DenominatorPolicy): Scoreboard

export interface FunnelRow { stage: 'submitted' | 'applied' | 'f2pGreen' | 'p2pGreen' | 'clean' | 'resolved'; count: number }
export function funnel(attempts: Attempt[]): FunnelRow[]

export interface Transitions { onlyA: string[]; onlyB: string[]; both: string[]; neither: string[]; unstable: string[] }
export function pairedTransitions(a: Attempt[], b: Attempt[], opts?: { k?: number }): Transitions   // 不匹配 id → 抛错
export function aaChurn(runA: Attempt[], runB: Attempt[]): { fixed: number; broken: number }
export function churnThreshold(aaBroken: number[], alpha: number): number

export interface RunKey { taskSetHash: string; taskSetVersion: number; scaffoldCommit: string; model: string; reasoningEffort: string
  resources: { cpu: number; memGb: number; timeoutS: number }; priceTable: string; k: number; plan: string }
export function runKey(meta: RunKey): string                       // FNV-1a 32 位，十六进制 8 位
export function taskSetHash(tasks: TaskInstance[]): string

export type GateMode = 'regress' | 'claim'
export interface GateBlocker { code: 'SIG_WORSE' | 'CHURN' | 'HACK' | 'INFRA' | 'KEY' | 'TASKSET' | 'SAMPLE'; message: string }
export interface GateV2Result {
  status: 'pass' | 'regressed' | 'ungradable'      // 退出码 0 / 1 / 2
  claimable: boolean                                // 仅 mode:'claim' 有意义
  blockers: GateBlocker[]; warnings: GateBlocker[]
  transitions: Transitions; pExact: number; threshold: number
}
export function codingGateV2(input: {
  mode: GateMode; tasks: TaskInstance[]; baseline: Attempt[]; candidate: Attempt[]
  baselineKey: RunKey; candidateKey: RunKey; declaredFactors: (keyof RunKey)[]
  aaBroken?: number[]; alpha?: number; maxInfraRate?: number
}): GateV2Result

export interface FactorialReport { main: Record<string, number>; interactions: Record<string, number>
  ofatFromFull: Record<string, number>; ofatFromEmpty: Record<string, number>; signsAgree: Record<string, boolean> }
export function factorialEffects(outcomes: Record<string, Attempt[]>, factors: string[]): FactorialReport
export function ablationVacuity(log: ToolCall[], toolName: string): 'vacuous' | 'live'
```

### 16.4 `l18/runner.ts`（live，不属于 verify）

```
pnpm l18:live -- --suite capability --k 3 --ab baseline,candidate --interleave --fresh-workspace
pnpm l18:live -- --audit-tasks               # R-2：沙箱重跑 base/gold/空补丁/gold×3，写 validity
pnpm l18:live -- --aa --k 3                  # R-3：A/A 校准，写 aaChurn
pnpm l18:live -- --nightly                   # R-9：退出码 0/1/2；连续两晚确认；写基线
```
