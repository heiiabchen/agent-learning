import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L17',
  questions: [
    {
      id: 'not-unique',
      kind: 'choice',
      prompt:
        '你的 coding agent 用 search/replace 改文件。模型要改 `get()` 里的 `return None`，但同文件的 `peek()` 里有一模一样的三行。一个「更鲁棒」的实现选择改第一处并返回成功——lab 实验一里这一行写的是「碰巧对」。这个决定错在哪里？',
      options: [
        { id: 'a', label: '错在性能：为了判断唯一要扫描全文件，大文件上太慢' },
        {
          id: 'b',
          label: '错在信号：改对和改错的返回值完全一样，模型也永远学不会扩大上下文',
        },
        { id: 'c', label: '错在兼容性：aider 的所有编辑格式都要求唯一匹配，首命中和生态不一致' },
        {
          id: 'd',
          label: '没错——Anthropic 的 text editor 在服务端保证了唯一性，客户端改第一处只是兜底',
        },
      ],
      correct: ['b'],
      explain: `**B**。

实验一的前两行是同一个实现、同一个返回值：意图改 \`get\` 时碰巧对，意图改 \`peek\` 时改错了。**改对的那次和改错的那次在返回值上无法区分**——这就是「没有信号」的精确含义。正确的循环是先 \`NOT_UNIQUE\`（零写入）→ 模型扩大上下文 → 成功；静默改第一处的实现让这个循环永远转不起来。

A 不成立：数一遍 \`matchCount\` 是一次线性扫描，和你本来就要做的 \`indexOf\` 同阶。而代价是不对称的——检测几乎免费，漏掉的是一个通过了所有检查的错误改动。

C 是反的：aider 的 \`diff\` 格式明写只改第一处，\`udiff\` 格式才抛 \`SearchTextNotUnique\`。同一个仓库里两个格式语义相反，「生态一致」本身就不存在。

D 也是反的：text editor 是 client-side 工具，执行在你的代码里。官方原话是 \`Your application should ensure that there is exactly one match\`——唯一性是你要保证的，不是 API 保证的。`,
    },
    {
      id: 'strip-tier',
      kind: 'choice',
      prompt: `一段 Python：

    def process(items):
        for item in items:
            if item.ok:
                return item
        return None

模型想改 \`return item\`，但它发来的 \`old\` 只有 8 个空格缩进（实际是 12 个）。你的编辑器怎么处理才对？`,
      options: [
        { id: 'a', label: '加一档逐行 `strip()` 匹配：命中后用模型给的 8 个空格写回' },
        { id: 'b', label: '加一档编辑距离匹配（相似度 0.8）：找最像的那一段' },
        {
          id: 'c',
          label: '整块统一缩进偏移命中，但写回时用原文件命中位置的实际缩进（12 个空格）作基准',
        },
        { id: 'd', label: '缩进不同就一律 `NO_MATCH`——任何缩进宽容都不安全' },
      ],
      correct: ['c'],
      explain: `**C**——这就是 lab 的 \`blockIndent\` 档。在这个例子上它会命中，并以 12 个空格写回。

A 是 OpenAI 参考实现的 \`fuzz=100\` 档。它会命中，然后用 8 个空格写回：\`return item\` 落到 \`for\` 的层级，循环第一次迭代就返回。语法合法、\`exit code\` 为 0，而那个 \`fuzz\` 值在顶层被 \`_fuzz\` 丢掉了。

B 是 aider 留在文件里、却被一个裸 \`return\` 挡成不可达代码的那段逻辑。相似度匹配能命中一段「长得像」的别的代码——它不保语义。

D 是安全的，但过度了。整块统一缩进偏移不改变「匹配到的是哪段代码」，属于保语义的规范化，拒绝它只会让模型多一轮。lab 的 \`blockIndent\` 本身也比 aider 窄：它要求 \`old\` 的所有非空行共享同一缩进，跨两层缩进整体偏移的块会 \`NO_MATCH\`。那是往 D 的方向收紧，方向安全。

原则只有一句：**规范化只发生在匹配阶段，绝不发生在写入阶段。**`,
    },
    {
      id: 'splitlines',
      kind: 'choice',
      prompt:
        '为了让 TS 和 Python 的编辑器输出逐字节一致，Python 侧应该怎么切行？文件内容里可能出现 `\\u2028`（JSON 字符串里合法）和 `\\f`。',
      options: [
        { id: 'a', label: '`str.splitlines()`——它是标准库，专门处理各种行尾' },
        { id: 'b', label: '`content.split("\\n")`——和 JS 一样简单' },
        {
          id: 'c',
          label:
            '手写：只在 `\\r\\n` / `\\n` / `\\r` 上切。`splitlines()` 还会在 `\\v`、`\\u2028` 等码点上切，JS 不会',
        },
        { id: 'd', label: '先把整个文件统一转成 LF，再 `split("\\n")`' },
      ],
      correct: ['c'],
      explain: `**C**。

\`splitlines()\` 除了三种标准行尾，还在 \`\\v\` \`\\f\` \`\\x1c\` \`\\x1d\` \`\\x1e\` \`\\x85\` \`\\u2028\` \`\\u2029\` 上切。\`"a\\x85b\\u2028c\\vd".splitlines()\` 是 4 段，本节的 \`split_lines\` 是 1 段。TS 侧手写三种行尾、Python 侧用 \`splitlines()\`，行号就在这个文件上错位——而两边的测试各自都是绿的。

A 错在「专门处理各种行尾」：它处理的比你要的多。

B 只认 \`\\n\`：CRLF 文件会把 \`\\r\` 留在每行末尾，老式的纯 \`\\r\` 文件会变成一整行。

D 看起来干净，但写回时整个文件变成另一种行尾，\`git diff\` 报整文件改动。而且它没有回答「什么算一行」，只是把问题挪了位置。

同一个病还会在正则锚点里复发——见下一题。`,
    },
    {
      id: 'regex-anchor',
      kind: 'choice',
      prompt: `你把一个 TS 写的测试输出解析器原样移植到了 Python，两边都用多行正则匹配 pytest 的 summary 行。喂同一段输出：

    progress 50%\\r===== 3 passed in 0.10s =====

TS 判 \`exact\`、绿；Python 判 \`unparsed\`、不绿。最可能的原因是？`,
      options: [
        { id: 'a', label: 'Python 的 `re` 对 `[0-9.]+` 这种字符类的处理和 JS 不同' },
        {
          id: 'b',
          label: 'JS 的 `m` 标志下 `^` 在 `\\r`、`\\u2028`、`\\u2029` 之后也算行首；Python 的 `re.M` 只认 `\\n`',
        },
        { id: 'c', label: 'TS 侧反向扫描、Python 侧正向扫描，取到了不同的 summary' },
        { id: 'd', label: 'Python 侧没有剥掉 ANSI 转义序列' },
      ],
      correct: ['b'],
      explain: `**B**。这是上一题那个病换了个地方：两边标准库对「什么算一行」的定义不同。进度条用 \`\\r\` 回到行首是终端的标准操作，所以这不是理论分叉——lab 的参考实现最早就在这段输入上给出了不同的 \`isGreen\`，而两边的 verify 都没有喂过裸 \`\\r\`。

A 不成立，\`[0-9.]+\` 在两边语义相同。

C 和 D 在 lab 里两边是一致的：都取最后一个匹配，都先剥 ANSI。而且这段输入里既没有第二个 summary，也没有转义序列。

这一段输入上 Python 侧是假红；换成 \`note\\u2028===== …\`，TS 侧会判绿而 Python 不会。修法是两边都先用自己的 \`splitLines\` 切行，再对每一行做**不带多行标志**的匹配——让「行」的定义只有一个来源。lab 现在就是这么做的，\`PARSE-8\` 到 \`PARSE-10\` 钉住。`,
    },
    {
      id: 'move-code',
      kind: 'choice',
      prompt: `你的编辑工具是**首命中**语义。文件是：

    A
    B
    function helper() {}
    C

模型要把 \`helper\` 挪到文件开头，分两次调用：先在 \`A\` 前插入一份 \`function helper() {}\`，再删掉 \`function helper() {}\`。两次调用都返回成功。文件最后是什么样？`,
      options: [
        { id: 'a', label: '`helper` 被正确挪到了开头' },
        { id: 'b', label: '文件和原来一模一样，而 agent 会汇报「已移动」' },
        { id: 'c', label: '文件里有两份 `helper`' },
        { id: 'd', label: '第二次调用会失败，因为 `old` 已经不在原来的位置' },
      ],
      correct: ['b'],
      explain: `**B**。插入之后文件里有两份 \`function helper() {}\`：第 1 行（新插的）和第 4 行（原来的）。首命中删掉的是第 1 行——刚插进去的那份。文件回到原样，两次调用都「成功」。

A 是意图，不是结果。

C 是「删除没有执行」时的样子。但删除确实执行了，只是删错了那一份。

D 混淆了两种语义：首命中不关心「原来的位置」，它只找第一次出现。

在唯一性语义下，第二次调用会变成 \`NOT_UNIQUE\`，并告诉模型两处匹配在第 1 行和第 4 行——一个有信号的失败。而如果把两条编辑放进**同一次**调用，lab 会把两条都定位在原文件上，移动正确完成。这就是「定位基于原文件、不是串行 replace」的价值。`,
    },
    {
      id: 'stale-prettier',
      kind: 'choice',
      prompt:
        'agent 读了 5 个文件，然后跑了 `prettier --write .`，接着拿它记得的片段去编辑其中一个文件。在 lab 的 `Workspace` 里，这次 `edit` 会怎样？',
      options: [
        { id: 'a', label: '照常成功——prettier 只改格式，不改语义' },
        { id: 'b', label: '`STALE_READ`：lab 比较 mtime，发现文件在 read 之后被改过' },
        {
          id: 'c',
          label: '`READ_REQUIRED`：非只读命令之后，`invalidateAfterCommand` 清空了所有读哈希',
        },
        { id: 'd', label: '靠 `NO_MATCH` 就够了：片段变了自然匹配不上，不需要额外的读状态' },
      ],
      correct: ['c'],
      explain: `**C**。陈旧最常见的来源不是别人，是 agent 自己。lab 在任何非只读命令之后清空所有读哈希，下一次编辑必然 \`READ_REQUIRED\`——模型被迫重新看一眼被格式化过的文件。

A 混淆了「语义」和「字节」：编辑工具匹配的是字节。prettier 可能改了引号、缩进和换行，模型记得的片段已经是旧的。

B 有两处错。lab 判定陈旧用的是**内容哈希**，不是 mtime——mtime 分辨率不够，\`git checkout\` 会抹平它。而且这个场景里先触发的是 \`READ_REQUIRED\`，因为哈希已经被清掉了。

D 只覆盖了一半：片段恰好没被改动时 \`NO_MATCH\` 不触发，编辑会基于一个过时的心智模型落盘。读后写的哈希是一次 compare-and-swap，它不管片段变没变，只管文件变没变。

还有一个边界要知道：lab 的 \`isReadonlyCommand\` 是前缀匹配，\`git status && rm -rf .\` 会被判成只读。lab 不执行命令所以无害，接上 shell 之后这就是一个洞。`,
    },
    {
      id: 'replay',
      kind: 'choice',
      prompt: `SSE 断线重连后，同一个 \`edit_file\` 调用被执行了两次：

    { old: 'init()\\n', new: 'init()\\nlogStart()\\n' }

第一次成功了。在 lab 的 \`Workspace\` 里，第二次会怎样？`,
      options: [
        { id: 'a', label: '`STALE_READ`：文件在上次 read 之后被改过' },
        { id: 'b', label: '`NO_MATCH`，`alreadyApplied` 为真——lab 能识别重复应用' },
        { id: 'c', label: '再成功一次，文件里出现两行 `logStart()`' },
        { id: 'd', label: '`NOT_UNIQUE`：`init()` 现在出现了两次' },
      ],
      correct: ['c'],
      explain: `**C**。第一次成功后，\`Workspace\` 把读哈希更新成它自己写出的内容——这是 \`STALE-5\`，为了让 agent 能连续编辑自己刚写的文件。所以第二次到达时哈希比对通过。而 \`new\` 包含 \`old\`，\`init()\\n\` 在新文件里仍然唯一地出现一次，于是再插一行。

A 错在把 compare-and-swap 当成了幂等键。哈希防的是「别人在我读之后改了文件」，防不了「我自己的调用到了两次」。

B 只在 \`new\` **不包含** \`old\` 时成立：那时 \`old\` 已经消失、\`new\` 已在，lab 返回 \`NO_MATCH\` 并标 \`alreadyApplied\`（\`NL-2\`）。这道题恰好是它救不了的形状。

D 数错了：\`init()\` 只出现一次，多出来的是 \`logStart()\`。

L08 的重放表里 \`write_file\` 是幂等的，\`edit_file\` 是 \`once\`。修法是把模型 read 时看到的哈希放进请求本身——重放的请求带的是旧哈希，比对自然失败。lab 没有实现这一条。`,
    },
    {
      id: 'parse-truncation',
      kind: 'choice',
      prompt:
        '你的解析器规则是：匹配到 `/(\\d+) passed/` 且没匹配到 `/(\\d+) failed/` 就算绿。真实的 summary 是 `===== 3 passed, 2 failed in 0.21s =====`，但工具输出在 `3 passed` 之后被截断了。lab 的参考解析器靠哪一条挡住了这种假绿？',
      options: [
        {
          id: 'a',
          label: 'summary 正则要求整行完整、以 `\\n` 结尾；认不出完整 summary 就是 `unparsed`，而 `unparsed` 一律不绿',
        },
        { id: 'b', label: '正向扫描：先看到 `passed`，再继续找 `failed`' },
        { id: 'c', label: '只看 exit code：pytest 有失败时 exit 1，所以解析结果无所谓' },
        { id: 'd', label: '统计输出里 `.` 和 `F` 的个数' },
      ],
      correct: ['a'],
      explain: `**A**。lab 的 pytest 正则是 \`/^=+ ([^=]+?) in [0-9.]+s =+\\n/m\`。截断在 summary 行中间的输出不匹配它，\`confidence\` 是 \`unparsed\`，\`isGreen\` 是 false。实验二把一段 155 字节的输出在每个偏移处切断，只有完整的那一个偏移是绿的；naive 的 \`/(\\d+) passed/\` 在偏移 128 就变绿了，summary 改成 \`3 passed, 2 failed\` 之后仍在 128 变绿。

B 恰好是反的：lab **反向**扫描，因为测试自己 print 的 \`"3 passed"\` 会出现在真正的 summary 之前。

C 有用但不够。exit code 是 \`isGreen\` 的条件之一，但它是可配置的：pytest 文档推荐的 \`pytest-custom_exit_code\` 插件能把「没收集到测试」的 exit 5 改成 0，包装脚本也可能吞掉退出码。所以 exit code 只能和解析结果互相兜底，不能单独当判据。

D 依赖进度输出的格式，\`-q\`、xdist、插件都会改变它；截断时它同样会算出一个错误的数。

这条规则有代价：一段完整但没有结尾换行的输出也会判 \`unparsed\`。这是有意的不对称——假红多跑一次测试，假绿放过一个没通过的改动。`,
    },
    {
      id: 'startswith',
      kind: 'choice',
      prompt:
        '工作区根是 `/repo/ws`。模型请求 `../ws-evil/x`，解析后是 `/repo/ws-evil/x`。下面哪个检查会错误地放行？',
      options: [
        { id: 'a', label: '`path.is_relative_to(root)`（Python）' },
        { id: 'b', label: '`relative(root, full)` 后检查是否以 `..` 开头（TS）' },
        { id: 'c', label: '规范化之后 `full.startsWith(root)`' },
        { id: 'd', label: '先 `realpath` 再做 relative 检查' },
      ],
      correct: ['c'],
      explain: `**C**。\`"/repo/ws-evil/x".startsWith("/repo/ws")\` 是 \`true\`——规范化之后它**确实**以 root 开头。实验三里这一行在「norm+starts」那一列仍是 \`ALLOW ✗\`，要到加了分隔符的那一列才挡住（\`SBX-4\`）。

A 和 B 都对：\`is_relative_to\` 和 \`relative()\` 看的是路径组件，不是字符串前缀，\`ws-evil\` 和 \`ws\` 是两个不同的组件。

D 也对，而且多挡住一类：root 里一个指向外面的符号链接，字符串层面的检查全过，\`realpath\` 之后才露馅。

但 D 也有盲区，lab 的初稿就踩过：\`realpath\` 只能作用于**已存在**的路径。在一个指向外部的符号链接目录下**新建**文件，目标还不存在，检查就退化成纯路径层，文件会落在 root 外面。后面那道 debug 题就是它。`,
    },
    {
      id: 'can-stop',
      kind: 'choice',
      prompt:
        '日志顺序是：edit(seq=1) → verify(seq=2, 全绿) → edit(seq=3) → 模型 finish。`canStop` 应该返回什么？',
      options: [
        { id: 'a', label: 'true——已经绿过，而且模型说完成了' },
        { id: 'b', label: 'true——最后一次 verify 的 exit code 是 0' },
        { id: 'c', label: 'false——verify 不在最后一次 edit 之后' },
        { id: 'd', label: 'false——但只因为模型 finish 不能信，和其他无关' },
      ],
      correct: ['c'],
      explain: `**C**。\`lastVerifySeq\` 必须大于 \`lastEditSeq\`。绿过一次又改了一刀，必须再验证——这是 \`STOP-3\`，也是实验五中间那一行。

A 把「模型说完成了」当成了终止条件，而 \`canStop\` 的设计原则就是不读模型的任何陈述。

B 看的是一个已经过期的结果：exit 0 描述的是 seq=2 时的代码，不是 seq=3 之后的代码。

D 结论对、理由错：即使完全信任模型的 finish，verify 过期这一条本身就足以返回 false。

这一条最容易漏，因为人的直觉是「刚才已经测过了」。`,
    },
    {
      id: 'plan-prose',
      kind: 'choice',
      prompt: '关于 coding agent 里的「计划」步骤，这一节的立场是什么？',
      options: [
        { id: 'a', label: '每个任务都应该先写计划，这是有消融实验支持的最佳实践' },
        {
          id: 'b',
          label: '如果你要有计划，它必须是可校验的 DAG；如果它只是散文，就别要',
        },
        { id: 'c', label: '计划应该写进 system prompt，让模型每一步自己对照' },
        { id: 'd', label: '计划阶段和执行阶段用同一组工具，靠 prompt 约束模型不要提前编辑' },
      ],
      correct: ['b'],
      explain: `**B**。

A 没有证据：调研查不到任何公开的消融实验证明「加计划步骤能提升成功率」。Anthropic 自己的指引还说 \`If you could describe the diff in one sentence, skip the plan.\`

C 把计划变成了一段 prompt——没有任何代码能检查执行有没有偏离它。

D 是最常见的错：靠 prompt 约束「不要提前编辑」，模型可以忽略。

真正有约束力的分离是**能力边界**：plan 阶段的工具列表里根本没有 \`edit_file\`（\`PHASE-1\`）。Claude Code 的 plan mode 也是一个权限模式，不是一段指令。计划本身要是带 \`dependsOn\` 的 DAG，\`validatePlan\` 能抓出环、悬空依赖、缺 verify 步，以及「edit 没有被某个祖先 read 覆盖」（\`PLAN-6\`）。`,
    },
    {
      id: 'hack-detector',
      kind: 'choice',
      prompt: 'verify 套件要覆盖 reward hacking，但规定一次模型都不调。正确的测法是什么？',
      options: [
        { id: 'a', label: '用温度 0 跑一百次真实任务，统计作弊率' },
        {
          id: 'b',
          label: '测检测器：喂 mock diff / mock 输出，断言该报警的报警、正常修复不报警',
        },
        { id: 'c', label: '让模型写一段「假装作弊」的代码，看 `canStop` 是否挡住' },
        { id: 'd', label: 'reward hacking 无法自动测，只能人工 review' },
      ],
      correct: ['b'],
      explain: `**B**。把「检测器」和「被检测的行为」分开。你测的不是「模型会不会作弊」，而是「如果它作弊了，检测器会不会报警」：给 \`detectHacks\` 喂一段改了 \`tests/\` 的 diff、一段新增 \`@pytest.mark.skip\` 的 diff、一个 skipped 比 baseline 多的结果，断言报警；再喂一段正常的 bug 修复，断言**不**报警（\`HACK-11\`）。

A 不可复现、要花钱，而且厂商自己说压力测试 \`do not reflect real-world hacking rates\`。你拿到的数字说明不了部署时的情况。

C 测的是模型「假装作弊」的能力，不是检测器。它仍然要调模型，而模型写出来的「作弊」未必覆盖你要测的那条规则。

D 太悲观：已知模式完全可以自动测。真正测不了的是**未知**模式——Baker et al. 自己说可能有很多 hack 他们的 monitor 没发现。所以 \`detectHacks\` 返回空只代表「没命中已知模式」，不代表「没作弊」。`,
    },
    {
      id: 'atomic-batch',
      kind: 'debug',
      prompt: '这段批量编辑实现在测试里全过了。指出它的静默错误。',
      lang: 'ts',
      code: `function applyAll(file: string, edits: {old: string; new: string}[]) {
  let content = read(file)
  for (const e of edits) {
    if (!content.includes(e.old)) throw new Error('no match')
    content = content.replace(e.old, e.new)  // 第一次出现
    write(file, content)                     // 每条都落盘
  }
}`,
      rubric: [
        '你有没有看到 `replace` 只改第一处，而 `includes` 只证明了「至少一处」？',
        '你有没有看到每条编辑都立刻 write——第 k 条失败时前 k-1 条已经落盘？',
        '你有没有想到定位应该基于原文件，而不是串行 replace 的中间态？',
        '你的修法是不是「先全部校验、再一次写入」，而不是「失败时尝试撤回」？',
      ],
      reference: `三个问题，没有一个会抛出「看起来像成功」之外的信号：

1. **首命中。**\`String.replace\` 只替换第一处。\`includes\` 只证明「至少一处」，不证明「恰好一处」——多处匹配时静默改错，没有 \`NOT_UNIQUE\`。
2. **非原子。**循环里每条都 \`write\`。第 k 条 \`throw\` 时前 k-1 条已经落盘，文件是半成品，调用方只看到一个异常。aider 也是逐条写，但它至少告诉模型 \`Don't re-send them\`；这里什么都没告诉。
3. **串行定位。**第 2 条在第 1 条的产物上找 \`old\`。如果第 1 条的 \`new\` 里恰好含有第 2 条的 \`old\`，第 2 条会改到刚插入的内容上。

lab 的 \`applyEdits\` 是这样做的：先在内存里对**原文件**逐条数 \`matchCount\`，多于一处就 \`NOT_UNIQUE\` 并带上 \`failedAt\`；排序后检查区间重叠（\`OVERLAP\`）；全部通过后从后往前替换，最后只写一次。对应断言 \`EDIT-2\`、\`BATCH-1\`、\`BATCH-2\`、\`BATCH-3\`。`,
    },
    {
      id: 'symlink-create',
      kind: 'debug',
      prompt:
        '这是一个写操作的路径检查。它挡住了 `../etc/passwd`、`../ws-evil/x`，也挡住了 root 里指向外面的符号链接 `link/passwd`。找出它仍然放行、并且能写到 root 外面的情况，给出修法。',
      lang: 'ts',
      code: `function resolveForWrite(root: string, input: string): string {
  const full = path.resolve(root, input)
  const rel = path.relative(root, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('ESCAPES_ROOT')
  try {
    const real = fs.realpathSync(full)
    const realRel = path.relative(fs.realpathSync(root), real)
    if (realRel.startsWith('..')) throw new Error('SYMLINK_ESCAPES_ROOT')
  } catch (e) {
    if ((e as Error).message === 'SYMLINK_ESCAPES_ROOT') throw e
    // 文件不存在：路径层已经检查过了
  }
  if (DENIED.some((d) => rel.startsWith(d))) throw new Error('DENIED_PATH')
  return full
}`,
      rubric: [
        '你有没有构造出「root 里一个指向外部目录的符号链接，在它下面新建文件」这个输入？',
        '你有没有指出问题在于 `realpath` 只能作用于已存在的路径，而不是 relative 检查本身？',
        '你的修法是不是 realpath 最近的已存在祖先，而不是「文件不存在就放行」？判断「已存在」用的是 lstat 还是 existsSync？',
        "加分：你有没有注意到 catch 也吞掉了符号链接环的错误、deny 列表大小写敏感、而且只查请求的路径？`startsWith('..')` 不带分隔符，会误杀根内的 `..notes.md`？",
      ],
      reference: `**放行的情况**：root 里有一个 \`out\` 指向外部目录，模型请求创建 \`out/new.txt\`。

    root/out -> /elsewhere
    resolveForWrite(root, 'out/new.txt')
    // full = root/out/new.txt，路径层检查通过
    // realpathSync(full) 抛 ENOENT：new.txt 还不存在
    // catch 吞掉，返回 full，写入落在 /elsewhere/new.txt

注释里那句「路径层已经检查过了」只对读成立：读一个不存在的文件，最终会报「文件不存在」。对**创建**来说，「不存在」恰恰是正常状态，跳过 \`realpath\` 就等于跳过了符号链接检查。lab 的 \`safePath\` 初稿里有一条意思相同的注释（「这不是安全问题——上面的路径层检查已经过了」），也有同一个缺口，TS 和 Python 两侧都能复现；现在由 \`SBX-8\` 钉住。

**修法**：从 \`full\` 往上找到最近的已存在祖先，对它做 \`realpath\`，再拼上剩下的组件，然后对结果做 relative 检查。

    const rest: string[] = []
    let p = full
    for (;;) {
      try { real = path.join(fs.realpathSync(p), ...rest); break }
      catch (e) {
        if (e.code === 'ELOOP') throw new Error('SYMLINK_LOOP')
        if (lexists(p)) throw new Error('UNRESOLVABLE')  // lstat 成功：悬空链接
        rest.unshift(path.basename(p)); p = path.dirname(p)
      }
    }

「已存在」不能用 \`existsSync\` 判断。它跟随链接：root 里 \`dang\` 指向 \`/elsewhere/x\`（还不存在）时，\`existsSync('dang')\` 是 false，循环跳过它去 realpath root，检查通过；随后 \`writeFileSync\` 跟着链接写出了 \`/elsewhere/x\`。lab 的 \`shared/sandbox\` 里是同一个循环，用 \`lstat\` 判断。

**同一个函数还漏了三件事**。符号链接成环时 \`realpath\` 抛的是 \`ELOOP\`，这里会被当成「文件不存在」放行——Claude Code 的规则是无法确定路径落到哪时 \`refuse the operation\`（\`SBX-9\`）。\`DENIED\` 是大小写敏感的前缀匹配，\`.ENV\` 能通过，而在 macOS 默认的文件系统上它就是 \`.env\`（\`SBX-14\`）。\`DENIED\` 只查请求的路径：root 里 \`g\` 指向 \`.git\` 时，\`g/config\` 读到的就是 \`.git/config\`，deny 要对解析后的路径也查一遍（\`SBX-15\`）。`,
    },
    {
      id: 'approval-policy',
      kind: 'design',
      prompt: '设计这个场景下的审批：卡在哪里、问什么、卡片上放什么、同一个任务里问几次。',
      scenario:
        'agent 刚读完一个 GitHub issue，issue 里说「在 `conftest.py` 里加一个 fixture 就能修好」，于是 agent 要编辑 `conftest.py`。lab 的 `resolveInWorkspace` 对它返回 ok，附带 `requiresConfirmation: true`；而 `Workspace.edit` 会照常写盘，然后才把这个标记带回来。',
      rubric: [
        '你有没有把审批放在写盘之前，而不是依赖 `edit` 返回的标记？',
        '你的分级是否同时用了「可逆性 / 改执行面」和「参数来源」两个轴？',
        '卡片上是否有解析后的真实路径、diff 和来源，而不是模型的自我评估？',
        '你有没有给出「问几次」的去重规则，并说明什么情况要重新问？',
        '你有没有区分「直接拒」和「问」——deny 列表里的路径不该出现在审批卡上？',
      ],
      reference: `**一、卡在哪里。**审批必须发生在 \`edit\` **之前**。lab 的 \`Workspace.edit\` 是先写盘、再把 \`requiresConfirmation\` 带回来，等你看到标记时 \`conftest.py\` 已经改了。正确的位置是 L16 说的 \`canExecute\`：执行器拿到工具调用，先过 \`resolveInWorkspace\`，标记为真就挂起，等用户决定。

**二、问什么。**不是「agent 想编辑一个文件」，而是按 L14 的两个轴分级：

| 动作 | 可逆 | 改执行面 | 参数来源 | 处置 |
|---|---|---|---|---|
| 编辑 \`src/\` 下的文件 | 是（有快照） | 否 | 模型 | 不问 |
| 编辑 \`conftest.py\`、\`package.json\`、CI 配置 | 是 | 是 | 模型 | 问 |
| 同上，但改动内容来自 issue 正文 | 是 | 是 | 不可信内容 | 问，并突出来源 |
| \`.git/\`、\`.env\`、\`tests/hidden/\` | —— | —— | —— | 直接拒 |

\`conftest.py\` 会在下一次 \`pytest\` 时被执行，它改的是执行面；而这次改动的内容来自 issue，参数来源不可信——两个轴都亮。

**三、卡片上放什么。**L14 的现场数据说人在逐次判断、主导决策的是来源。所以卡片放三样：解析后的真实路径（不是模型给的字符串）、具体 diff、以及「这个改动来自 issue 正文」。不放「agent 认为这是安全的」——那是模型的陈述。

**四、问几次。**同一个任务里，对同一个文件的同类改动问一次；diff 发生实质变化（比如新增 import 或网络调用）就重新问。跨会话的「记住」需要持久化，留到 L19。

**五、lab 没做的。**\`HIGH_RISK\` 列表里没有 \`pyproject.toml\`、\`AGENTS.md\`、\`.vscode/\`；\`requiresConfirmation\` 只是一个标记，没有任何代码阻塞在它上面。`,
    },
  ],
}
