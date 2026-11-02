import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L11x',
  questions: [
    {
      id: 'ref-symptom',
      kind: 'choice',
      prompt:
        '一个 Python MCP server 上线三个月一直好用。今天有人给某个工具加了个可选的筛选参数，用的是一个已有的嵌套 model（这个 model 在别处已经用过一次）。改完之后，那个工具偶尔会让服务端抛 TypeError: string indices must be integers，栈顶在工具实现里。CI 全绿，schema 校验也过。最可能的原因是什么？',
      options: [
        { id: 'a', label: '模型幻觉出了一个不存在的参数值，需要在工具里加类型校验' },
        {
          id: 'b',
          label:
            '嵌套 model 被复用到第二次，pydantic 把它提到了 $defs 并留下 $ref；模型解不开本地引用，于是把那个参数当成字符串填了',
        },
        { id: 'c', label: '可选参数生成了 anyOf，模型挑错了分支' },
        { id: 'd', label: 'MCP 协议的 tools/list 有大小限制，schema 被截断了' },
      ],
      correct: ['b'],
      explain: `B。

这道题的每个细节都是线索，而**"上线三个月一直好用"是最重要的那个**——它说明问题不在模型、不在协议，在这次改动带进来的东西。

**为什么"复用到第二次"是关键：**

schema 生成器（pydantic、zod、typebox 都一样）有一个共同行为：**用一次的类型直接内联，用两次才提到 \`$defs\` 并留 \`$ref\`。** 因为那样更紧凑。

所以这个 bug 的触发条件不是"加了嵌套参数"，是"某个类型被用到了第二次"。而那次改动看起来和工具调用毫无关系——你只是复用了一个已有的 model。

**然后 Anthropic 的 tools API 不解本地 \`$ref\`。** 模型看到 \`{"$ref": "#/$defs/Criteria"}\` 不会去查 \`$defs\`，它会把那个参数**当成字符串**填。

于是：

| 你看到的 | 实际发生的 |
|---|---|
| 工具调用成功了 | 是的，参数名对，格式合法 |
| 参数看起来像回事 | 是的，它是一个 JSON 字符串 |
| \`args["filter"]["status"]\` 抛 TypeError | 因为 \`args["filter"]\` 是 \`str\`，不是 \`dict\` |
| 栈顶在你的工具里 | 而真正的原因在 schema 生成那一层 |

★ **"偶尔"这个词也对得上**——模型不是每次都会填那个可选参数。不填就没事，填了就炸。

**修法：** 发出去之前 \`dereference\`，把本地 \`$ref\` 内联掉、\`$defs\` 删掉。加上一道 \`schema_health\` 主动检查，因为**这三种失效全都不在你的代码里报错**。

---

**看错项：**

**A（幻觉 + 加类型校验）**——最危险的错项，因为**照它做能"修好"**。你在工具里加一句 \`if isinstance(v, str): v = json.loads(v)\`，TypeError 就没了。

但你留下的是：一个每次都要多解析一次 JSON 的工具、一个模型永远拿不到正确参数结构的 schema、以及**同一个坑在下一个复用嵌套 model 的工具上重演**。这是在症状上打补丁。

**C（anyOf 挑错分支）**——这是**真实存在的另一个坑**，而且题目里"可选参数"确实会生成 \`anyOf\`。但它对不上症状：挑错分支给你的是结构不对的对象，不是字符串，报的错也不会是 \`string indices\`。★ 两个坑同时存在，要靠症状区分。

**D（截断）**——tools/list 没有这种截断行为，而且截断会导致 schema 不合法、请求被拒，不会静默走到工具里。`,
    },
    {
      id: 'concurrency-choice',
      kind: 'choice',
      prompt:
        '你在 Python 里重写 L11 那个 fanout：把一个任务拆成 4 份，交给 4 个 sub-agent 并行跑，最后合并报告。其中一个 sub-agent 可能会因为工具报错而失败，但你希望另外三个的结果照样能用。下面哪个写法是对的？',
      options: [
        { id: 'a', label: 'await asyncio.gather(*tasks)' },
        { id: 'b', label: 'await asyncio.gather(*tasks, return_exceptions=True)' },
        { id: 'c', label: 'async with asyncio.TaskGroup() as tg: ...' },
        { id: 'd', label: 'for t in tasks: await t' },
      ],
      correct: ['b'],
      explain: `B。

判据是题目最后半句：**"另外三个的结果照样能用"。**

| 写法 | 一个失败时 | 适合 |
|---|---|---|
| \`gather(*tasks)\` | 立刻上抛，**其余不取消、继续跑完** | **没有场景。这是 bug** |
| \`gather(..., return_exceptions=True)\` | 各自跑完，异常当成值收回来 | ✓ **本题** |
| \`TaskGroup\` | 取消其余，打包成 ExceptionGroup | 一个失败就全停 |
| \`for t in tasks: await t\` | 串行，第一个失败就停 | 不并行的场景 |

**A 为什么是纯 bug：**

它两个语义都不是。第一个异常立刻上抛，而**其余任务不会被取消，会继续跑到底**。

在 agent 里的后果很具体：你的 \`fanout\` 抛异常返回了，而另外三个 sub-agent **还在调模型、还在跑工具、还在花钱**——只是没有人会读它们的结果了。

lab 里能量出来：

    asyncio.gather（朴素）
      成功 3  失败 1  取消 0   失败瞬间还在跑 3 个
      真正花了钱的：3 个

Python 至少会在进程退出时打一句 \`Task was destroyed but it is still pending\`，但那条日志离原因隔了很远，通常没人看。

**C 为什么在这道题里是错的：**

\`TaskGroup\` 本身是好东西，它是结构化并发的标准答案。但它的语义是"一个失败就全停"——第一个 sub-agent 失败会**取消另外三个**。

那正好是题目不要的：三个已经跑到一半的 sub-agent 被取消，钱花了，结果没有。

★ **判据一句话：要"一个失败就全停"用 \`TaskGroup\`，要"各自跑完再看"用 \`return_exceptions=True\`。**

而**扇出通常要后者**——L11 那节整节都在说这件事：多 agent 的价值是并行，一个分支挂了不该让其余白跑。\`TaskGroup\` 更适合"这几步必须全成功才有意义"的场景，比如三个写操作要么都成要么都别做。

**D**——串行就没有并行的意义了。而且第一个失败照样会停掉后面的。`,
    },
    {
      id: 'reducer',
      kind: 'choice',
      prompt:
        '一个 LangGraph 流程会停下来让人审核，人可以修改已有的消息再恢复执行。state 里 messages 字段声明的是 Annotated[list, operator.add]。上线后发现：人改过的指令有时候被执行成改之前的版本，有时候是改之后的，没有规律。原因是什么？',
      options: [
        { id: 'a', label: 'checkpointer 没配持久化，恢复时读到了旧快照' },
        {
          id: 'b',
          label:
            'operator.add 只追加，改过的消息被追加到末尾，历史里同时存在改前和改后两条，模型会挑一条',
        },
        { id: 'c', label: 'thread_id 串了，读到了别人的会话' },
        { id: 'd', label: '恢复时节点重跑了一遍，副作用执行了两次' },
      ],
      correct: ['b'],
      explain: `B。

**"没有规律"是这道题的指纹。**

配置错误、状态串了、副作用重放——这些的表现都是确定的。而"有时候这样有时候那样"指向一个地方：**模型在两个都合法的输入之间做选择。**

**机制：**

\`operator.add\` 就是拼接。人改了 \`m1\` 这条消息，改后的版本被**追加**到列表末尾：

    m1: 帮我删掉临时文件                          ← 改之前
    m1: 帮我删掉 /tmp 下我自己建的临时文件         ← 改之后

模型看到两条 **id 相同、内容矛盾**的消息。而它不会报错——它会挑一条，通常是后一条，有时不是。于是你得到一个"大部分时候对"的 bug，而这种 bug 最难查。

**修法：** 换成 \`Annotated[list, add_messages]\`。

\`add_messages\` 和 \`operator.add\` 的差别只有一处：**它按 id 去重并覆盖。**

| | operator.add | add_messages |
|---|---|---|
| 新 id | 追加 | 追加 |
| 已有 id | **也追加** | **覆盖原位置** |
| 位置 | 新的在末尾 | ★ **保持原位置** |

最后一行容易写漏。把被改的那条挪到列表末尾，会让对话顺序错乱——而模型对消息顺序是敏感的。

★ 这就是为什么 LangGraph 专门提供 \`add_messages\` 而不是让你用 \`operator.add\`：**"人工修改状态再恢复"这个功能，靠 \`operator.add\` 是实现不了的。**

---

**看错项：**

**A（checkpointer 没持久化）**——那样的表现是**每次都**读到旧版本，不是随机。而且 \`MemorySaver\` 在同一个进程里是能正常读写的。

**C（thread_id 串了）**——会话串了的表现是答案里出现完全不相关的内容，不是"同一条指令的两个版本"。

**D（恢复重跑节点）**——**这是真实存在的另一个坑**，而且题目场景确实会触发它。但它的表现是**副作用执行两次**（数据库里两条记录），不是"执行了旧版本的指令"。★ 两个坑都真，靠症状区分：随机选择 → reducer；重复副作用 → 幂等。`,
    },
    {
      id: 'idempotency',
      kind: 'choice',
      prompt:
        '一个 LangGraph 节点先给用户发一封通知邮件，然后调 interrupt() 等人审批，批准后执行操作。测试的时候发现每次审批流程走完，用户会收到两封一样的邮件。下面哪个判断是对的？',
      options: [
        { id: 'a', label: 'interrupt 被调了两次，需要在 state 里加个标记防重入' },
        {
          id: 'b',
          label:
            '这是 LangGraph 的正常行为：检查点在超步边界上，恢复时节点从函数开头重跑，interrupt 之前的副作用会再执行一次',
        },
        { id: 'c', label: 'checkpointer 存了两份检查点，恢复时重放了两遍' },
        { id: 'd', label: 'Command(resume=...) 调了两次，前端重复提交了' },
      ],
      correct: ['b'],
      explain: `B。**而重点是"这是正常行为"这半句。**

如果你以为这是 bug，你会去找哪里重复调用了——而那个地方不存在，于是你会查很久。

**机制，一句话：**

★ **检查点存在"超步"边界上，不在节点函数中间。**

所以恢复的时候，LangGraph 没有办法"从 \`interrupt()\` 那一行接着往下走"——它没存那个位置。它存的是**进入这个节点之前的状态**。于是恢复 = 拿那份状态，**把节点函数从头跑一遍**。

\`interrupt()\` 之前的代码全部再执行一次。发邮件就发第二封。

这就是 LangGraph 文档里那句"\`interrupt\` 之前的代码必须幂等"的由来。

**而它和 L08 那节是同一件事：**

| L08 | LangGraph |
|---|---|
| 事件日志 + 快照 | checkpointer |
| session id | thread_id |
| 幂等键 | ★ **同一个要求** |

一句话：**恢复不是"接着往下走"，是"重放到断点"。**

同一条规则还适用于 \`interrupt_before\`、任务重试、以及进程崩溃后的恢复——三种场景，一个机制。

**三种修法：**

1. **把副作用拆到前一个节点**（最干净）。发邮件是一个节点，审批是另一个节点
2. **用幂等键**。邮件带一个由 thread_id + step 算出来的 key，发送方去重
3. **在 state 里放标记**。\`if not state.get("mail_sent")\`

★ 注意第 3 种和选项 A 的区别：**A 的诊断是错的**（以为 interrupt 被调了两次），但它给出的手段（state 里加标记）恰好是三种正确修法之一。**手段对、诊断错**，所以它不是答案——因为诊断错了你就不会知道这条规则还适用于重试和崩溃恢复。

---

**看错项：**

**C（存了两份检查点）**——检查点是按 step 存的，不会重复。而且就算重复了，重放的也是同一个状态，不会导致副作用翻倍。

**D（前端重复提交）**——如果是这样，你会看到两次审批请求，而且换个客户端（比如直接在脚本里 \`invoke\`）就不复现了。★ 这是值得先排除的一项，因为它最好验证。`,
    },
    {
      id: 'dspy',
      kind: 'choice',
      prompt:
        '你有 60 条标注好的样本，写了个 DSPy 程序做工单分类，指标是 severity 和 component 两个字段都精确匹配才算 1 分。跑 BootstrapFewShot 编译，结果一条示例都没攒到，报告显示 trials=60、kept=0。下一步最该做什么？',
      options: [
        { id: 'a', label: '标更多数据，60 条对 bootstrap 来说太少' },
        { id: 'b', label: '换成 MIPROv2，它能重写指令，比只找示例强' },
        {
          id: 'c',
          label:
            '先手动看几条零样本的实际输出，检查签名和指标——kept=0 意味着零样本成功率是 0',
        },
        { id: 'd', label: '把 threshold 从 1.0 降到 0.5，先让示例攒起来' },
      ],
      correct: ['c'],
      explain: `C。

**kept=0 是一个诊断信号，不是一个需要调参绕过的障碍。**

它的含义很精确：\`trials=60\` 说明 60 条全试过了，\`kept=0\` 说明**指标一次都没判过**。也就是**零样本成功率是 0**。

而"一次都没对"这件事，在一个你已经标了 60 条数据、认真写了签名的任务上，几乎不可能是"模型能力不够"。它通常是下面某一个：

| 真实原因 | 怎么发现 |
|---|---|
| 签名的字段名/描述和你的期望不一致 | 看一条实际输出，对照 expected |
| 指标太严（大小写、空格、"P0" vs "p0"） | 把 out 和 expected 并排 print |
| 输出格式对了但外面裹了东西（"severity: P0"） | 同上 |
| 标注本身有问题 | 抽查几条 |

**全都能靠"看几条实际输出"在五分钟内定位。** 而这就是 C。

★ 这道题的核心是一条工作习惯：**当一个自动化流程报出"零命中"，先去看原始数据，不要先调参数。** 零命中几乎总是接口对不齐，不是程度不够。

---

**看错项，三个都是"绕过信号"：**

**A（标更多数据）**——★ 最贵的错项。零样本成功率是 0 的时候，**数据量不是瓶颈**。60 条错 60 条，600 条会错 600 条。你会花一周标数据，然后得到同一个 kept=0。

**B（换 MIPROv2）**——换 optimizer 不解决这个问题，而且更贵。\`MIPROv2\` 的 bootstrap 阶段做的是同一件事，它照样攒不到示例；\`auto="heavy"\` 还能跑到几千次调用、几十美元。★ **不记账的优化循环和 L11 那个"多 agent 是花钱策略"是同一个坑。**

**D（降 threshold）**——最有害的一项，因为**它会让流程看起来跑通了**。

阈值降到 0.5，于是"severity 对了但 component 错了"的样本被当成好示例攒进去。你得到一份编译产物、一个不为零的分数、和一组**教模型把 component 填错**的示例。

而 bootstrap 留下的示例，输出是**模型自己产的**——所以这些错误示范会被固化下来，然后放大。

**这三个错项的共同点：都在让那个信号消失，而不是读它。**`,
    },
    {
      id: 'debug',
      kind: 'debug',
      prompt:
        '下面这段 Python 是同事写的 sub-agent 扇出，思路是"并行跑几个 sub-agent，谁失败了记下来，其余的结果照样合并"。它跑起来不报错，测试也过。但线上有两个问题：账单比预期高，以及某些超时的任务会让整个进程挂住不退出。找出全部问题。',
      lang: 'python',
      code: `import asyncio
from dataclasses import dataclass

@dataclass
class Result:
    name: str
    findings: list = []          # ①
    ok: bool = True

async def run_subagent(brief: str, name: str) -> Result:
    try:
        out = await call_model(brief)          # 可能超时，可能报错
        return Result(name=name, findings=out)
    except Exception as e:                     # ②
        return Result(name=name, ok=False)

async def fanout(briefs: dict[str, str]) -> list[Result]:
    tasks = [
        asyncio.create_task(run_subagent(b, n))
        for n, b in briefs.items()
    ]
    results = await asyncio.gather(*tasks)     # ③
    return results

def merge(results: list[Result]) -> dict:
    all_findings = []
    for r in results:
        all_findings.extend(r.findings)        # ④
    return {"findings": all_findings}`,
      reference: `五个问题，其中两个直接对应题目说的那两个症状。

---

**① \`findings: list = []\` —— dataclass 的可变默认值**

这一行**运行时就会报错**（Python 会拒绝 \`list\` 作默认值），所以它是五个里唯一不静默的。但值得知道它防的是什么：

如果 Python 允许，这个 \`[]\` 会在**类定义时创建一次**，然后被所有实例共享。一个 sub-agent 往 findings 里 append，另一个的 findings 里也会出现——**结果串台，而且不报错。**

    findings: list[str] = field(default_factory=list)

★ 这就是 \`field(default_factory=...)\` 存在的全部理由。TS 那边没有对应的坑，因为类字段初始化器每次构造都会重新执行。

---

**② \`except Exception\` 吞掉超时 —— 这是"进程挂住"的原因**

看起来这一句挺负责：接住异常，标记失败，返回。问题在它接住了什么。

\`asyncio.CancelledError\` 在 3.8+ **不是 \`Exception\` 的子类**（它直接继承 \`BaseException\`），所以这一句**接不到取消**——这部分是好的。

但 \`asyncio.TimeoutError\` 是。而 \`asyncio.timeout()\` 这类超时机制**内部是用取消实现的**：它给任务发取消，然后等任务结束。如果外层有人给这个 fanout 包了超时，取消信号会变成 \`CancelledError\` 传进来；而如果 \`call_model\` 内部有 \`except Exception\` 把 \`TimeoutError\` 咽掉了，超时就不生效了。

要写对得显式放行取消，而且**接住之后必须 raise**：

    except asyncio.CancelledError:
        raise                                  # 必须往上抛
    except Exception:
        return Result(name=name, ok=False)

★ 官方文档明确写了：一个协程如果把 \`CancelledError\` 咽掉，\`TaskGroup\` 和 \`asyncio.timeout()\` 会失灵。而**失灵的表现是卡住，不是报错**——正好对上题目说的"挂住不退出"。

---

**③ 朴素 \`gather\` —— 这是"账单比预期高"的原因**

题目说"谁失败了记下来，其余的结果照样合并"。那个语义要的是 \`return_exceptions=True\`。

    results = await asyncio.gather(*tasks, return_exceptions=True)

而朴素 \`gather\` 的语义是：第一个异常立刻上抛，**其余任务不取消、继续跑到底**。

这里有个额外的转折：因为 ② 把异常都吞了，\`run_subagent\` 几乎不抛异常，所以 ③ 在**大多数时候看起来是好的**——这就是"测试也过"的原因。但只要有一个异常漏出来（比如 \`BaseException\` 那一类，或者 \`call_model\` 之外的代码报错），另外几个 sub-agent 就变成孤儿：还在调模型、还在花钱，而没有人会读它们的结果。

★ 两个 bug 互相掩护，这是这道题最值得留意的结构：**② 让 ③ 在测试里不暴露。**

---

**④ 没检查 \`r.ok\` —— 失败的 sub-agent 被当成"没有发现"**

\`merge\` 无条件 \`extend(r.findings)\`。一个失败的 sub-agent 的 findings 是空列表，于是它对合并结果的贡献是**零**——和"我认真查了，什么问题都没有"完全一样。

    def merge(results):
        ok = [r for r in results if r.ok]
        gaps = [r.name for r in results if not r.ok]
        return {
            "findings": [f for r in ok for f in r.findings],
            "gaps": gaps,          # ★ 必须显式交出去
        }

这是 L11 那节讲过的：**报告里的"缺口"必须显式，不能靠读者从缺失中推断。** 四个 sub-agent 里一个挂了，合并报告要说"三份结果 + 一个未完成"，不能只交三份结果。

---

**⑤ 没有并发上限，也没有取消**

\`briefs\` 有多少条就并发多少个 task。而扇出宽度正是 L11 那节量出来的成本主因。

要么用信号量封顶，要么在上层用 \`TaskGroup\`（如果语义是"一个失败就全停"）：

    sem = asyncio.Semaphore(4)
    async def guarded(b, n):
        async with sem:
            return await run_subagent(b, n)

★ 另外 \`create_task\` 只被局部变量 \`tasks\` 持有引用，这里没问题；但如果哪天有人改成不保存返回值的写法，事件循环只持弱引用，任务可能在跑完前被 GC 掉——症状是"某些 sub-agent 偶尔没有结果"。\`TaskGroup\` 会持强引用，这也是它比裸 \`create_task\` 更安全的一处。`,
      rubric: [
        '找到 ① dataclass 的可变默认值要用 field(default_factory=list)',
        '找到 ② except Exception 会吞掉 TimeoutError，且接住取消后必须 raise——这是"进程挂住"的原因',
        '找到 ③ 朴素 gather 不取消其余任务，孤儿任务继续花钱——这是"账单高"的原因',
        '看出 ② 和 ③ 互相掩护：异常被吞掉，所以 gather 的问题在测试里不暴露',
        '找到 ④ merge 没区分"失败"和"没有发现"，缺口必须显式交出去',
        '找到 ⑤ 扇出宽度没有上限（L11 量过：宽度就是成本主因）',
      ],
    },
    {
      id: 'design',
      kind: 'design',
      prompt:
        '你们的 agent 是 TypeScript 写的，跑在 Node 服务里，已经上线。团队想开始做正经的评测：不是"跑几个 case 看看输出对不对"，而是能回答"这次改动让成功率涨了还是跌了、涨的那点是不是噪声"。团队里没人写 Python，有人提议"用 TS 写评测，别引入第二门语言"。给出你的方案和理由。',
      scenario:
        '现状：agent 每天处理约 800 个请求，已经有结构化日志（每个请求一条 JSON，含输入、工具调用序列、最终输出）。没有标注数据。团队 4 个前端工程师，1 个后端。',
      reference: `**先说结论：运行时留在 TS，评测跑在 Python，两边通过 JSONL 解耦。**

而"别引入第二门语言"这个顾虑要正面回答，不能绕。它在多数场景下是对的——**在这一个场景里不对，理由很具体。**

---

**一、为什么这件事不能全在 TS 做**

团队要的是"涨的那点是不是噪声"。这句话就是统计检验，而它需要：

| 需要什么 | Python | JS 生态 |
|---|---|---|
| 显著性检验（配对检验、bootstrap 置信区间） | \`scipy.stats\` 几行 | 没有等价物 |
| 按维度切片看结果 | \`pandas\` groupby | 手写，容易错 |
| 小样本方差处理 | 现成 | 自己实现 |

不是"差一点"，是**没有那一层**。而这些东西自己实现的风险不是写不出来，是**写错了不知道**——统计代码的 bug 不会崩，它会给你一个错的置信区间，然后你据此做决策。

★ 800 请求/天这个规模让这件事更要紧：一个改动带来 2% 的差异，在 200 条评测样本上完全可能是噪声。**而团队目前没有能力判断这一点，这正是他们要解决的问题。**

**二、为什么引入 Python 的成本比想象的低**

"引入第二门语言"通常贵在：要维护两套部署、两套依赖、两套 CI、两边的人都要会。

而这里几乎都不适用：

- **不在请求路径上。** 评测是离线批处理，跑在 CI 或者一台机器上，挂了不影响线上
- **不需要写服务。** 就是脚本：读 JSONL、算指标、出报告
- **接口是数据不是代码。** 一份 JSONL，两边都不需要理解对方的实现
- **需要的 Python 能力有边界。** 能改指标函数、能跑通脚本。★ 不是"团队要学会 Python"，是"能读懂并修改一个 200 行的脚本"

**三、具体怎么落地**

**第一步（本周）：把日志变成可评测的数据。** 这一步在 TS 侧做，不需要 Python。

现有日志已经是结构化的，缺的是**一个稳定的样本标识**和**输入的完整快照**。确保每条记录能独立重放，字段固定下来（改字段名会让历史数据不可比）。

**第二步：定义指标，而这是唯一真正难的一步。**

注意题目里的现状：**没有标注数据。** 所以第二步不是写代码，是回答"什么叫对"。

从生产日志里抽 100-150 条，人工标注。抽样要覆盖失败模式，不能只抽正常路径。这件事没法外包给工具，也没法跳过——**L12 整节课讲的就是它。**

**第三步：Python 侧的评测脚本。** 读 JSONL、跑指标、算显著性、出报告。三四百行的量级。

**第四步：接进 CI。** 每次改 prompt 或改工具跑一次，报告里必须有**改动前后两个数字**和一个"这个差异是否显著"的判断。

**四、要提前说清的三件事**

1. **评测集会腐化。** 修 bug 是照着评测集修的，修完那些 case 就不再有区分度。要定期从生产日志补新样本
2. **指标会被优化。** 只判精确匹配，就会有人去改输出格式凑分数。这不是道德问题，是指标设计问题
3. **前期评测集会很小。** 150 条样本的置信区间是宽的。**要在第一份报告里就把这件事写出来**，不然团队会对着噪声做决策——而那比没有评测更糟，因为它带着数字的权威

**五、什么情况下"全在 TS"是对的**

如果团队要的只是"回归测试"——一组固定 case，输出变了就报警——那 TS 完全够，用 vitest 就行，别引入 Python。

★ **分界线是"要不要回答显著性问题"。** 只要不问这个，就不需要统计库。而题目明确问了。`,
      rubric: [
        '明确分层：运行时 TS，评测 Python，接口是 JSONL 数据而不是共享代码',
        '正面回答"别引入第二门语言"这个顾虑，而不是绕开它',
        '指出评测在离线路径上，所以引入语言的常见成本大部分不适用',
        '指出真正的瓶颈是"没有标注数据"，第一步不是写代码而是定义"什么叫对"',
        '要求报告同时给改动前后两个数字，以及显著性判断',
        '提到评测集会腐化、指标会被优化、小样本置信区间宽这三个风险中至少两个',
        '给出"什么情况下不该引入 Python"的边界（只做回归测试就用 vitest）',
      ],
    },
  ],
}
