import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L19x',
  questions: [
    {
      id: 'defaults-one-to-infinity',
      kind: 'choice',
      prompt:
        '同事在三个服务里分别用了 AI SDK 的 `ToolLoopAgent`、OpenAI Agents SDK 的 `run()`、Claude Agent SDK 的 `query()`，三处都没有配步数。他说：「框架都有默认上限，死循环会被兜住。」给一个永远失败、模型每次都重试的工具，三处分别会怎样？哪个判断最准确？',
      options: [
        { id: 'a', label: '三处都在 20 步左右正常返回，`finishReason` 是 `stop`，调用方能看出撞了上限' },
        {
          id: 'b',
          label:
            '`ToolLoopAgent` 跑 20 步后正常返回，`finishReason` 是 `tool-calls`、`text` 为空，只有一条 warning；Agents SDK 跑 10 轮后抛 `MaxTurnsExceededError`；Claude Agent SDK 的 `maxTurns` 没有默认值，实验一里第 50 次被外部掐断。三种结局，没有一种是「显式的停止原因加正常返回」',
        },
        {
          id: 'c',
          label: '真正危险的是裸 `generateText`：它默认没有上限，会一直调到外部掐断；换成 `ToolLoopAgent` 之后才有 20 步保护',
        },
        {
          id: 'd',
          label: '自己写 `stopWhen: isStepCount(cfg.maxSteps)` 就行，配置里写 0 表示「不许多步」，第 1 步就会停',
        },
      ],
      correct: ['b'],
      explain: `B。

实验一就是这道题。\`ToolLoopAgent\` 唯一实质性的默认值是 \`stopWhen ?? createDefaultStopCondition(20)\`：20 次调用、20 次执行之后正常返回，\`finishReason\` 是 \`tool-calls\`，\`text\` 是空串，唯一的信号是一条 warning（E1-A）。Agents SDK 的 \`DEFAULT_MAX_TURNS = 10\`，超限抛 \`MaxTurnsExceededError\`，状态在 \`error.state\` 上；配了 \`errorHandlers.maxTurns\` 才正常返回（E6-E）。Claude Agent SDK 的 \`maxTurns\` 是 No limit，E5-A 在默认配置下一直跑到手动 abort。

三处的结局分别是：看起来像正常返回的空文本、一个异常、根本不停。课程要的是每次运行都有显式的停止原因，撞上限是正常返回，这三处都不是。

---

A 错：默认上限是 20、10、无上限，不是都在 20 左右。撞上限时 AI SDK 的 \`finishReason\` 是 \`tool-calls\`，不是 \`stop\`；停在审批请求上、调了一个没有 \`execute\` 的工具，也都是 \`tool-calls\`，调用方从它分不出原因。

C 错：方向反了。裸 \`generateText\` 带工具时默认 \`isStepCount(1)\`，执行完第一次工具调用就返回（E1-B：1 次调用、1 次执行、\`text\` 为空）。它不会死循环，问题是「工具执行了，但是没有回答」。

D 错：\`isStepCount(n)\` 的实现是 \`steps.length === n\`，传 0 永远不触发，等于没有上限。实验一：\`isStepCount(0)\` 在 20 步里一次都没触发；课程的 \`maxSteps\` 用 ≥ 比较，0 在第 1 步就停。

对应讲义开头、第三节 3.1–3.2；实验一；断言 F1、F2、S5。`,
    },
    {
      id: 'stop-when',
      kind: 'choice',
      multi: true,
      prompt: '关于在框架上落实课程的停止原因（TODO 1），下列哪些说法正确？（多选）',
      options: [
        {
          id: 'a',
          label:
            'AI SDK 的 `stopWhen` 在 do…while 的尾部求值，也就是一步做完之后。由此推出：挂在 `stopWhen` 上的预算条件只能在这一步的钱花完之后才停，预算要在发请求之前另查',
        },
        {
          id: 'b',
          label:
            'Claude Agent SDK 的 `result.subtype` 是四家里唯一直接给出停止原因的；但 `maxTurns`、`maxBudgetUsd` 都没有默认值，预算也是事后检查，文档自己承认会超出一次响应的花费',
        },
        { id: 'c', label: 'OpenAI Agents SDK 撞上默认的 10 轮时，返回到那一轮为止的部分结果，`finalOutput` 是最后一轮的文本' },
        {
          id: 'd',
          label:
            '判 `repeat` 要先于 `max_steps`；调用签名要对参数做规范化，但一步里多个调用的顺序要保留。否则 `{a,b}` 和 `{b,a}` 算两个调用，或者第 3 步撞上限时原因写成 `max_steps`，看不出是在打转',
        },
        { id: 'e', label: 'Mastra 的 `resumeStream` 沿用初次运行的 `maxSteps`，只有初次运行需要设' },
      ],
      correct: ['a', 'b', 'd'],
      explain: `A、B、D。

A 对：\`ai@7.0.137\` 的 \`generate-text.ts\` 里，\`isStopConditionMet\` 写在 do…while 的条件里，这一步的模型调用和工具执行都做完之后才求值。「预算只能事后停」是从这段源码推出来的，不是实测。L05 第一节把检查点放在循环顶部、先查后花，所以预算要在发请求之前查，不能只挂在 \`stopWhen\` 上。

B 对：\`result.subtype\` 区分 \`success\`、\`error_max_turns\`、\`error_max_budget_usd\`、\`error_during_execution\` 等。预算那一条的文档原文："Spend can therefore pass the cap by up to the cost of that one response, plus anything that subagents still running at that moment spend before they stop."

D 对：这是 TODO 1 的两条规则。签名用 \`JSON.stringify\` 时键序不同就算两个调用，S3 抓；一步里的调用先排序再比，\`[x,y]\` 和 \`[y,x]\` 被当成同一步，S4 抓；先查 \`max_steps\` 再查 \`repeat\`，S5 抓。

---

C 错：Agents SDK 撞上限是抛 \`MaxTurnsExceededError\`，不返回部分结果，状态在 \`error.state\` 上。要正常返回得配 \`errorHandlers.maxTurns\`，E6-E 配了之后返回 \`finalOutput: "已到步数上限，停止"\`。

E 错：Mastra 自己的 harness 控制器注释原文："a missing \`maxSteps\` on resume silently caps the resumed run at the agent's small default and ends it mid-task"。续跑时要再传一次，否则在半路按默认的 5 步停下，而且不报错。

对应讲义第三节 3.1、3.2 的 Drill、3.3；实验一；断言 S3、S4、S5。`,
    },
    {
      id: 'debug-tool-error',
      kind: 'debug',
      prompt:
        '同学交上来 TODO 2，说：「实验二最后一行的格式我对上了，三条脱敏规则也都写了。」跑 `pnpm verify:l19x`，E 组哪几条会红、各打印什么？哪一条明明有问题却是绿的，为什么？修好 E7 的第一个检查之后，E7 接下来会红在哪？最后给出修法。',
      lang: 'ts',
      code: `import { ERROR_PREFIX, NEXT_STEP, MAX_ERROR_MESSAGE, errorCode, hintFor } from '../shared/tsecosystem.ts'

export function myRedactSecrets(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9]+/g, 'sk-***')
    .replace(/(secret|token|password|api_key)=\\S+/gi, '$1=***')
    .replace(/Bearer \\S+/g, 'Bearer ***')
}

export function myCourseToolError(e: unknown, ctx: { tool: string }): string {
  const m = (e as { message?: unknown } | null)?.message
  const raw = typeof m === 'string' ? m : String(e)
  let msg = raw.replace(/\\s+/g, ' ')
  if (msg.length > MAX_ERROR_MESSAGE) msg = msg.slice(0, MAX_ERROR_MESSAGE) + '…'
  msg = myRedactSecrets(msg)
  return \`\${ERROR_PREFIX}\${ctx.tool || 'unknown-tool'}: \${msg}\\n\${NEXT_STEP}\${hintFor(errorCode(e, raw))}\`
}`,
      rubric: [
        '你有没有指出 E1 会红，并说出两处：`sk-abc_DEF-123` 只遮掉了 `sk-abc`，尾巴 `_DEF-123` 照样进上下文；`password=hunter2,next` 的 `,next` 被 `\\S+` 一起吃掉？',
        '你有没有指出 E2 红的三类原因：`sk-` 前面不查边界（`task-queue` 被遮成 `task-***`）；`/i` 让 `Token=` 也被替换；`\\S+` 越过了 `)`、`;`、`}`？',
        '你有没有指出 E4 红在实验二那个异常上：右括号被吃掉，得到 `(secret=***` 而不是 `(secret=***)`，第一个检查就失败，体检根本没跑到？',
        '你有没有指出 E6 会红：`null`、`{ message: 42 }`、`undefined` 被 `String(e)` 印成 `null`、`[object Object]`、`undefined`，模型读到的是一段像数据的字符串？',
        '你有没有说出 E7 会一个接一个地红在三处：`\\s+` 把 `\\r\\n` 压成一个空格；按 UTF-16 码元截断切坏 emoji；先截断再脱敏多出一个 `…`？',
        '你有没有说清 E3、E5 为什么是绿的，尤其是 E3：幂等检查只问「再跑一遍变不变」，过度脱敏照样幂等？',
      ],
      reference: `会红五条：E1、E2、E4、E6、E7。E3、E5 是绿的。

## E1、E2：字符类和 \\S+

    E1 打印 ["key sk-***_DEF-123 end","token=*** rejected","Authorization: Bearer ***","password=***","api_key=***","a sk-*** b sk-*** secret=*** token=*** Bearer *** Bearer ***"]
    E2 打印 ["task-*** sk-***","Token=***","(secret=***","token=***","secret=***","xsk-*** sk-"]

\`sk-[A-Za-z0-9]+\` 漏了 \`_\` 和 \`-\`，key 只被遮掉前半截。这是最糟的一种失败：日志里看到的是 \`sk-***\`，像是脱敏了，后半截照样进了模型的上下文。

值用 \`\\S+\` 匹配，会一直吃到下一个空白：\`,next\`、\`;next\`、\`}b\`、右括号都没了。少了后行断言，\`task-queue\` 里那个 \`sk-queue\` 被当成 key，\`xsk-abc\` 同理。\`/i\` 让 \`Token=abc\` 也被替换，而规则只认小写键名。多遮也是错：它改了模型该看到的内容。

## E4：实验二那个异常

    "[tool error] read_file: ENOENT nope (secret=***\\n下一步：路径不存在：先列出目录确认文件名，再换路径调用"

规则一先把 \`sk-123\` 换成 \`sk-***\`，规则二再把 \`secret=\` 后面直到空白的 \`sk-***)\` 整段换掉，右括号没了。E4 的第一个检查就失败，后面的体检根本没跑到。

## E6：String(e)

\`String(null)\` 是 \`null\`，\`String({ message: 42 })\` 是 \`[object Object]\`，\`String(undefined)\` 是 \`undefined\`。模型读到 \`[tool error] unknown-tool: null\`，会以为工具交回了一个叫 null 的东西。规则是：带字符串 message 的对象用 message，字符串用它本身，其余写「（没有错误信息）」。

## E7：一个接一个暴露

E7 里有五个检查，第一个失败就停。这份代码依次红在：

1. 换行：打印 \`"[tool error] t: a b c"\`。规则是 \`\\r\`、\`\\n\` 各换成一个空格，\`a\\nb\\r\\nc\` 应得 \`a b  c\`；\`\\s+\` 把两个换成了一个，还会顺手压掉制表符
2. emoji：修好换行之后，\`.length\` 和 \`slice\` 按 UTF-16 码元算，201 个 emoji 是 402 个码元，截出来只剩 100 个。打印「按 UTF-16 码元截断了：emoji 是一个码点、两个码元」
3. 顺序：修好码点之后，打印 \`先截断再脱敏了："xxxx sk-***…"\`。190 个 x 加 \` sk-\` 加 20 个 A 共 214 个码点，先截断就在 key 中间切了一刀，脱敏之后多出一个 \`…\`；先脱敏只剩 197 个码点，根本不用截

## 为什么 E3、E5 是绿的

E5 只看第二行的提示，而错误码和提示用的是 shared 的 \`errorCode\`、\`hintFor\`，没有被改坏。

E3 只问「脱敏结果再跑一遍变不变」。\`(secret=***\` 再跑一遍还是它，\`api_key=sk-zz,Bearer q\` 被遮成 \`api_key=*** q\`（\`,Bearer\` 被吃掉了）再跑一遍也还是它。幂等检查抓不住过度脱敏，要靠 E1、E2 那种逐条写死的期望值。

## 修法

    import { ERROR_PREFIX, NEXT_STEP, MAX_ERROR_MESSAGE, errorCode, hintFor } from '../shared/tsecosystem.ts'
    const RULES: [RegExp, string][] = [
      [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]+/g, 'sk-***'],
      [/(secret|token|password|api_key)=[^ \\t\\n\\r,;)\\]}'"]+/g, '$1=***'],
      [/Bearer [A-Za-z0-9._~+/=-]+/g, 'Bearer ***'],
    ]
    export function myRedactSecrets(s: string): string {
      let out = s
      for (const [re, to] of RULES) out = out.replace(re, to)
      return out
    }
    export function myCourseToolError(e: unknown, ctx: { tool: string }): string {
      const m = typeof e === 'object' && e !== null ? (e as { message?: unknown }).message : undefined
      const raw = typeof m === 'string' ? m : typeof e === 'string' ? e : '（没有错误信息）'
      let msg = myRedactSecrets(raw.split('\\r').join(' ').split('\\n').join(' '))
      const cps = [...msg]
      if (cps.length > MAX_ERROR_MESSAGE) msg = cps.slice(0, MAX_ERROR_MESSAGE).join('') + '…'
      return \`\${ERROR_PREFIX}\${ctx.tool || 'unknown-tool'}: \${msg}\\n\${NEXT_STEP}\${hintFor(errorCode(e, raw))}\`
    }

先脱敏再截断，按码点截；键名不加 \`/i\`，值的边界写成显式的排除集合，不用 \`\\S\`。`,
    },
    {
      id: 'debug-resume-once',
      kind: 'debug',
      prompt:
        '同学交上来 TODO 3，catch 里有一句注释：「失败了就清掉，让下一次投递能重试」。跑 `pnpm verify:l19x`，R 组哪几条会红、各打印什么？把 R4 那个失败对到实验五的哪一行，线上会发生什么？还有哪些问题 verify 抓不到？最后给出修法。',
      lang: 'ts',
      code: `export function myResumeOnce(store: Kv, approvalId: string, decision: 'approve' | 'reject', resume: () => string): ResumeOutcome {
  const key = \`approval:\${approvalId}\`
  const cur = store.get(key)
  if (cur === 'in-flight') return { status: 'in-flight', result: '' }
  if (cur !== undefined) {
    const [, prev, result] = cur.split(':')
    return prev === decision ? { status: 'already-consumed', result: result ?? '' } : { status: 'conflict', result: prev ?? '' }
  }
  store.set(key, 'in-flight')
  try {
    const r = resume()
    store.set(key, \`done:\${decision}:\${r}\`)
    return { status: 'ran', result: r }
  } catch (e) {
    store.delete(key) // 失败了就清掉，让下一次投递能重试
    return { status: 'crashed', result: (e as Error).message }
  }
}`,
      rubric: [
        '你有没有指出 R2 会红，第二、三次返回的 result 是 `a` 而不是 `a:b:c`，原因是 `split(\':\')` 把结果里的冒号也切了？',
        '你有没有指出 R4 会红、打印「崩溃后记录是 null」，并说清 catch 里删掉 in-flight 的后果：重投递时看不到记录，`resume()` 再执行一次？',
        '你有没有把 R4 对到实验五「a2 恢复时进程被杀」那一行：退款已经发出去（副作用累计 2），删掉记录等于再退一次？',
        '你有没有说出 in-flight 的正确处理不是重跑而是对账：超时的意思是「不知道做没做」，要拿外部副作用 key 去支付网关查？',
        '你有没有指出 verify 抓不到的问题：Map 上先读后写不是原子的，两个 worker 能同时认领；抛出的不是 Error 时 `(e as Error).message` 是 `undefined`？',
        '你的修法有没有只按前两个冒号切、崩溃时把记录留在 in-flight，并且说明生产里的认领要换成存储层的条件写？',
      ],
      reference: `会红两条：R2、R4。R1、R3、R5 是绿的。

## R2：结果里的冒号

    [{"status":"ran","result":"a:b:c"},{"status":"already-consumed","result":"a"},{"status":"already-consumed","result":"a"}]

\`done:approve:a:b:c\` 被 \`split(':')\` 切成五段，解构只拿到第三段。结果里有冒号很常见：时间、URL、带前缀的回执号。重放时交出一个截断的结果，上层拿它去对账，对不上。

R3 是绿的，因为决定只看第二段，冒号不影响它。

## R4：崩溃时删掉了认领

    resume 抛异常 → { status: 'crashed', result: 'killed' }（这一半是对的）
    之后的记录 → 不存在，verify 打印「崩溃后记录是 null」

这就是实验五的第四行。a2 的 worker 是在 \`POST /refund\` 之后被杀的，钱已经退出去了（副作用累计 2）。这份代码在 catch 里删掉记录，下一次投递看到的是「没有记录」，于是再调一次 \`resume()\`：同一笔退款退两次。

注释里那句「让下一次投递能重试」，把「不知道做没做」当成了「没做」，L19 第 5.1 节反对的就是这个。in-flight 的正确处理是不重跑、去对账：拿 L19 第 4.1 节第三层的外部副作用 key（作业 id 加调用 id 派生）去支付网关查这笔退款在不在，在就补写 done，不在再决定要不要重新执行。

## verify 抓不到的

- Map 上先 \`get\` 后 \`set\` 不是原子的。两个 worker 同时拿到同一条审批，都读到 undefined，都执行。生产里认领必须是存储层的条件写，不存在才写入（L19 第 2.5 节）
- 抛出来的不是 Error（\`throw 'killed'\`）时，\`(e as Error).message\` 是 \`undefined\`，而 \`ResumeOutcome\` 的类型说 result 是字符串
- \`crashed\` 不是终态。返回它的地方要把这条审批送进对账队列，不能只打一行日志

## 修法

    export function myResumeOnce(store: Kv, approvalId: string, decision: 'approve' | 'reject', resume: () => string): ResumeOutcome {
      const key = \`approval:\${approvalId}\`
      const cur = store.get(key)
      if (cur === 'in-flight') return { status: 'in-flight', result: '' }
      if (cur !== undefined) {
        const rest = cur.slice('done:'.length)
        const k = rest.indexOf(':')
        const prev = rest.slice(0, k)
        return prev === decision ? { status: 'already-consumed', result: rest.slice(k + 1) } : { status: 'conflict', result: prev }
      }
      store.set(key, 'in-flight') // 生产里：存储层的条件写
      let r: string
      try {
        r = resume()
      } catch (e) {
        const m = typeof e === 'object' && e !== null ? (e as { message?: unknown }).message : undefined
        // 记录留在 in-flight，交给对账
        return { status: 'crashed', result: typeof m === 'string' ? m : typeof e === 'string' ? e : '（没有错误信息）' }
      }
      store.set(key, \`done:\${decision}:\${r}\`)
      return { status: 'ran', result: r }
    }

写 done 放在 try 外面：\`resume()\` 成功、写记录失败的情况不该被当成「工具崩溃」。`,
    },
    {
      id: 'mcp-iserror',
      kind: 'choice',
      multi: true,
      prompt:
        "你用 `@ai-sdk/mcp` 接了一个文件系统 MCP server，模型走 DeepSeek 的 Anthropic 兼容端点。server 对一次越权读返回 `{ isError: true, content: [{ type: 'text', text: 'EACCES: permission denied' }] }`。下列哪些说法正确？（多选）",
      options: [
        { id: 'a', label: 'AI SDK 会把它变成 `tool-error`，线上的 tool_result 带 `is_error: true`，和工具抛异常走同一条路' },
        {
          id: 'b',
          label:
            '`mcp-client.ts:1314` 在 `isError` 时把结果原样作为返回值，步骤内容是 `tool-result`，线上块没有 `is_error`；`onToolExecutionEnd` 和 tracing 也把这次调用记为成功',
        },
        {
          id: 'c',
          label:
            '就算线上块带了 `is_error`，DeepSeek 的兼容表里这个字段是 Ignored，模型能依靠的只有文本；所以课程适配器把失败写进文本：`[tool error] EACCES: permission denied`',
        },
        { id: 'd', label: '判断失败用 `if (r.isError)` 就够了，真值判断能覆盖 `true`、`"true"` 这些写法' },
        {
          id: 'e',
          label: '`content` 为空、只有 `structuredContent` 时交出它的 JSON；什么都没有时交出 `(empty result)`，不给模型一个空串',
        },
      ],
      correct: ['b', 'c', 'e'],
      explain: `B、C、E。

B 对：\`@ai-sdk/mcp@2.0.73\` 的 \`mcp-client.ts:1314\` 是 \`if (result.isError) { return result; }\`，不抛异常。随后的转换不看 \`isError\`，而 Anthropic provider 只对 \`error-text\`、\`error-json\` 设 \`is_error\`。E2 实测的线上块里没有 \`is_error\`。trace 里这次调用是成功，按 trace 统计的工具失败率因此被低估。

C 对：兼容表里 \`tool_result.is_error\` 一行标着 Ignored，由此推出模型只看文本。实验三第一行：AI SDK 路径上模型看到 \`EACCES: permission denied\`，还算好猜；换成 \`quota exceeded\` 这种就猜不出是失败了。课程适配器的前缀让信号在任何端点上都在。

E 对：这是 TODO 4 的规则，M4 抓。实验三最后两行 AI SDK 那一列的空串来自 lab 的简化对照函数 \`aiSdkMcpWire\`（只取 text 块），不是实测；调研只实测了 \`isError\` 那一行。

---

A 错：那是工具抛异常时的路径。MCP server 返回 \`isError: true\` 不是异常，\`@ai-sdk/mcp\` 把它当正常返回值交上去，于是 \`is_error\` 和 \`tool-error\` 都没有。

D 错：真值判断会把 \`0\` 当成成功。规则是只有缺省、\`null\`、\`false\` 算成功，其余一律当失败，M1 抓。反过来写成 \`=== true\` 也不行，字符串 \`"true"\` 会被当成成功（实验三第二行）。

对应讲义第四节 4.2–4.3、第六节；实验三；断言 M1、M4、F4。`,
    },
    {
      id: 'ui-history',
      kind: 'choice',
      prompt:
        'Next.js 应用用 `useChat` 加 `streamText`，客户端执行的工具 `read_file` 报错。第 N 轮模型看到 `Error: ENOENT a.ts; 试试 src/a.ts`，但从第 N+1 轮起它开始在同一个错误上原样重试，DeepSeek 的缓存命中也从这一轮开始掉。最好的修法是？',
      options: [
        { id: 'a', label: '换一个更强的模型。第 N 轮已经给了出路，是模型没记住' },
        {
          id: 'b',
          label:
            'UI 流默认 `onError = () => \'An error occurred.\'`，`useChat` 标准模式下历史由客户端发来，遮罩文本在下一轮成了模型历史。服务端持久化模型消息，下一轮从服务端日志重建，客户端的 UI 消息只用来对账；审批状态同样存服务端或签名',
        },
        { id: 'c', label: '传 `onError: e => String(e)`，UI 消息里保留原始错误，第 N+1 轮就和第 N 轮一样了' },
        { id: 'd', label: '在 tool_result 上加 `cache_control` 断点，把缓存钉住' },
      ],
      correct: ['b'],
      explain: `B。

\`to-ui-message-stream.ts:29\` 的默认值是 \`onError = () => 'An error occurred.'\`。\`useChat\` 的标准模式下，文档原话 "the message history is client-controlled input"：服务端每一轮都从客户端发来的消息重建历史。实验四：第 N 轮模型看到 \`Error: ENOENT a.ts; 试试 src/a.ts\`，UI 消息里存的是 \`An error occurred.\`，第 N+1 轮模型看到的也是它。出路丢了，模型于是原样重试；同一个位置的 tool_result 变了，此后的前缀全部不命中。

修法是让服务端成为历史的真相源。实验四的后半段以日志为准重建：c2 拿回完整的错误和下一步，\`drifted=["c2"]\`；c9 是客户端造出来的一条 \`approved\`，\`forged=["c9"]\`；c3 被客户端丢了，\`dropped=["c3"]\`。审批走的是同一条路，默认不签名，要么存服务端，要么配 \`experimental_toolApprovalSecret\`。

---

A 错：第 N+1 轮模型根本没看到出路。这不是记忆问题，是历史被改写了。

C 错：漂移确实修好了（实验四：传 \`onError: s => s\` 时第 N+1 轮不变），但原始异常整段送进了浏览器，里面的 key 和内部路径下一轮再回到模型的上下文。而且历史仍然是客户端输入，c9 那种伪造的审批照样进来。要传就传第四节那段脱敏过的课程文本。

D 错：DeepSeek 的兼容表里 \`cache_control\` 也被忽略，它做的是自动前缀缓存。就算断点有效，前缀在第 N+1 轮已经变了，变化点之后的内容照样不命中。

对应讲义第七节；实验四；断言 H2、H3、F5。`,
    },
    {
      id: 'claude-agent-sdk',
      kind: 'choice',
      multi: true,
      prompt:
        '团队想把 Claude Agent SDK 接到 DeepSeek 的 Anthropic 端点上，做一个无人值守的后端服务，`query()` 只传了 `model` 和几个 MCP 工具。按实验七和调研标的证据等级，下列哪些说法站得住？（多选）',
      options: [
        {
          id: 'a',
          label:
            '在没有任何 settings 文件的干净机器上，不传 `permissionMode` 就是 `auto`，由模型分类器替你批工具调用；有 settings 文件时，会被里面的 `permissions.defaultMode` 改掉',
        },
        {
          id: 'b',
          label:
            '「每次主循环请求后跟着 10 次分类器请求」是对着本地假服务器测的，假服务器不按 `<severity>` 协议作答；真分类器答得上来时是几次，没有测',
        },
        {
          id: 'c',
          label: '分类器会落到 `deepseek-flash`，而 `deepseek-flash` 答不了 `<severity>` 协议，所以这个服务上线后一定死循环',
        },
        {
          id: 'd',
          label:
            '分类器的花费不进 `total_cost_usd`；fork 出来的会话从父会话的累计值接着算（0.0024 包含了 0.0018），按会话汇总会重复计算',
        },
        { id: 'e', label: '`total_cost_usd` 对 `deepseek-v4-pro` 算出了非零值，说明 SDK 认得 DeepSeek 的价格，可以直接当账单用' },
      ],
      correct: ['a', 'b', 'd'],
      explain: `A、B、D。

A 对：E5-A 在干净环境里读到 \`init.permissionMode\` 是 \`auto\`。\`sdk.d.ts\` 的注释说不传时按 \`claude -p\` 的规则选：先看加载到的 settings 里的 \`permissions.defaultMode\`，否则在可用时用 \`auto\`。而 \`settingSources\` 不传时会加载全部来源，服务器上运行用户的 settings 文件也算。

B 对：这是证据等级的问题。10 次（\`max_tokens\` 64 五次、8192 五次，\`model\` 写死为 \`claude-sonnet-5\`）是对着 127.0.0.1 上的假 Anthropic 服务器测的。假服务器不会回 \`<severity>N</severity>\`，所以每次都走到「答不上来」那条路。

D 对：\`sdk.d.ts\` 原文 "Internal helper calls outside the query pipeline (e.g. the permission classifier, token-count probes) are excluded"。实验七：A2 是 0.0012，resume 之后 0.0018，fork 之后 0.0024，fork 的值里包含了父会话的累计。

---

C 错：两半都没有被证实。分类器落到 \`deepseek-flash\`，是从 DeepSeek 文档的映射规则推出来的（\`claude-sonnet\` 开头的模型名映射到 \`deepseek-flash\`），没有真网络验证；\`deepseek-flash\` 能不能按协议作答，没有一手来源。实测的是另一件事：分类器失败即拒，拒绝文案叫模型 "try this action again as-is"，\`maxTurns\` 又没有默认值，三样叠在一起，在假服务器上死循环。无论分类器答不答得上，修法都一样：显式设 \`permissionMode\`（无人值守用 \`dontAsk\`）、\`maxTurns\`、\`maxBudgetUsd\`，再加 \`settingSources: []\`。

E 错：非零是实测（每次 100 输入、10 输出 token 记 0.0006 美元），但它用的是哪张价目表没有核实，不是 DeepSeek 的价格；分类器的花费也不在里面。成本以你自己的 usage 账为准。

对应讲义第九节 9.1–9.3；实验七；断言 F6。`,
    },
    {
      id: 'dify-plan',
      kind: 'choice',
      prompt:
        '运营同学用 Dify 搭了一个客服流程原型，导出 DSL 交给你：「照着改成代码上线。」`difyPlan` 读出的执行顺序是 start → kr → route → llm → ticket → notify → answer → fallback，问题列表里有一条 `ref-not-upstream:ticket:llm.text`。哪个判断最准确？',
      options: [
        {
          id: 'a',
          label: '误报。拓扑序里 llm 排在 ticket 前面，执行到 ticket 时 llm 已经跑完了，这个引用一定有值',
        },
        {
          id: 'b',
          label:
            'route 的 true 分支走 llm、false 分支走 ticket，ticket 只在知识库没命中时执行，那时 llm 没跑，引用在运行时是空值：这是原型里真正的 bug。改写时还要补：检索换成自己的索引，建工单的 POST 带幂等键，发通知的凭据重新接，LLM 节点的滑动窗口会破坏前缀缓存',
        },
        { id: 'c', label: '不用改写。把 DSL 导入公司自己部署的 Dify 实例就能上线，凭据和知识库会跟着 DSL 一起过去' },
        { id: 'd', label: '直接用 Dify 上线。Dify 是 Apache 2.0，给每个客户开一个 workspace 做成 SaaS 没有许可问题' },
      ],
      correct: ['b'],
      explain: `B。

实验八读的就是这份 DSL。执行顺序是 Kahn 拓扑序，route 那里分成两支：\`route:true->llm\`、\`route:false->ticket\`。ticket 在拓扑序里排在 llm 后面，但两者在互斥的分支上；判上游要沿边反向找祖先，ticket 的祖先里没有 llm。D3 钉的就是这一条。

其余几项是 D2 钉的「改写成代码时要补的」：kr 是 \`rebind-index\`（\`dataset_ids\` 用原租户 id 加密导出）；llm 是 \`sliding-window-breaks-cache\`（\`memory.window\` 开着，size 10）；ticket 是 \`no-retry idempotency-key\`（\`retry_config.enabled\` 为 false，又是一个 POST）；notify 是 \`reconnect-secret\`（导出时删掉了凭据）。

---

A 错：拓扑序在前不等于是上游。这正是 TODO 6 的第一种典型错法，D3 抓。

C 错：导出时默认删掉工具节点的 \`credential_id\`，知识检索的 \`dataset_ids\` 绑在原租户上，webhook URL 被清空。导到另一个实例，检索和凭据都是断的。

D 错：Dify 的许可是 "a modified version of the Apache License 2.0"，附加条件写明不经书面授权不得用它的源码运营多租户环境，而一个 workspace 就是一个租户。给每个客户开一个 workspace，正是它限制的情形。

对应讲义第十节；实验八、实验九；断言 D2、D3、F6。`,
    },
    {
      id: 'paper',
      kind: 'choice',
      prompt:
        '评审会上有人引用 arXiv 2609.00006：「十一个生产 coding agent 没有一个用框架，所以我们也不该用 AI SDK。」哪个回应最准确？',
      options: [
        { id: 'a', label: '论文说得对。生产系统连 provider SDK 都不该用，直接手写 HTTP 请求' },
        {
          id: 'b',
          label:
            '论文查的是 LangChain、LangGraph、AutoGen、CrewAI、Pydantic AI 这类通用 agent 框架，清单里没有 AI SDK、Mastra、Claude Agent SDK、OpenAI Agents SDK；它还专门把 OpenCode 用的 AI SDK 称为 provider 抽象层、不是编排框架。它支持的是「循环手写，provider 层可以用库」',
        },
        { id: 'c', label: '论文的结论是 harness SDK（Claude Agent SDK、OpenAI Agents SDK）才是生产首选，应该换成它们' },
        { id: 'd', label: '只有十一个样本，作者自己也说 "We would be surprised, but not shocked"，结论不可信，可以忽略' },
      ],
      correct: ['b'],
      explain: `B。

论文原文的检查清单："LangChain, LangGraph, LlamaIndex, AutoGen, CrewAI, Pydantic AI, Genkit, Haystack agents, Semantic Kernel, Google's ADK, and several smaller libraries (Smolagents, Swarm, Agno)"。AI SDK 不在里面，而且论文专门写了它："a provider-abstraction layer, not an agent-orchestration framework"。论文证明的是 "Every loop is hand-rolled in the host language's native primitives"，这和这一节的做法一致：provider 层用库，循环和不变量自己写成适配器。

---

A 错：论文没有说不用 provider SDK。它把 OpenCode 用 AI SDK 当作语料里第一个「内循环管线是第三方 SDK」的系统来描述，不是当作反例。

C 错：论文的合流论点是描述，不是推荐：一个 meta-harness 把 \`claude-agent-sdk\` 和 \`openai-agents\` 列为生产依赖，"harnesses did not adopt the frameworks; they replaced them, became importable themselves"。而第九节看到的是，harness SDK 带着一个 coding harness 的默认值。

D 错：那句话说的是论文没检查到的代码路径（动态加载、内部 fork），是对局限的老实交代，不是撤回结论。十一个系统、约四百万行代码里「没有一个导入通用 agent 框架」，是一条精确、可用的事实；问题只在于别把它扩大成「别用任何 SDK」。

对应讲义第十一节。`,
    },
    {
      id: 'design-selection',
      kind: 'design',
      prompt:
        '面试题：「你们要做一个对外的客服 agent，技术栈是 TS。你会选什么框架？」写出你的回答，至少覆盖：分层（哪一层用库、哪一层自己写）、你的不变量分别接在哪个扩展点上、历史和审批放在哪、退款的幂等、tracing 去哪、Claude Agent SDK 和平台各自的位置、版本与升级。',
      scenario:
        '前端是 Next.js 加 `useChat`；模型走 DeepSeek V4 的 Anthropic 兼容端点；agent 能查订单、改地址、退款，退款走第三方支付网关；按客户计费；运营同学已经在 Dify 上搭了一个原型。',
      rubric: [
        '有没有先分层：provider 层和流协议用 AI SDK，编排层的默认值不照单全收，并且显式设 `maxOutputTokens`（未知模型 ID 会被限到 4096）？',
        '终止有没有显式的停止原因（approval、truncated、error、done、repeat、max_steps），接在 `stopWhen` 上、返回后再算一次，预算在发请求之前查？',
        '错误回填有没有前缀、工具名、下一步，先脱敏再截断，接在 `execute` 包装上？有没有承认 DeepSeek 忽略 `is_error`、信号只能放在文本里？MCP 工具有没有包一层把 `isError` 写进文本？',
        '历史有没有以服务端日志为准、客户端 UI 消息只用来对账？审批有没有存服务端或签名？`onError` 有没有避免把原始异常送进浏览器？',
        '退款有没有幂等键、审批恢复只消费一次、in-flight 不重跑而去网关对账？有没有提到模型请求的自动重试不带幂等键、abort 后已完成的步要自己落盘？',
        'tracing 有没有说清 span 去哪：不用会自动注册 exporter 的伞包，记录的输入要脱敏，MCP 的失败要记成失败？成本有没有按自己的 usage 账、按租户汇总？',
        '有没有说清 Claude Agent SDK 什么时候合适，以及用它时要显式关掉哪些默认值？',
        '平台有没有定位成原型和需求文档，指出 DSL 不带凭据和知识库、要先看引用问题，以及 Dify 多租户要书面授权？',
        '有没有锁精确版本、升级时先重录这几处行为，把框架行为的结论当成带有效期的？',
      ],
      reference: `## 一句话

provider 层用 AI SDK，编排层把课程的不变量写成适配器，接到它的扩展点上；Dify 原型当需求文档读；这个场景不用 Claude Agent SDK。

## 分层

- 用库：\`@ai-sdk/anthropic\` 指向 DeepSeek 的 Anthropic 端点，\`streamText\` 加 UI message stream 给 Next.js。省下的是 provider 适配、流协议编解码、schema 校验
- \`maxOutputTokens\` 显式设。不设的话，未知模型 ID 被限到 4096，长回复和工具参数会被截断，停止原因是 \`truncated\`（实验六）
- 编排层的默认值逐个过一遍：\`ToolLoopAgent\` 默认 20 步、撞上限正常返回、没有停止原因；工具错误回填 \`error.toString()\`；UI 错误遮罩会改写下一轮；审批默认不签名

## 适配器接在哪

| 适配器 | 扩展点 | 不变量 |
|---|---|---|
| 停止原因 | \`stopWhen\`，返回后对 \`result.steps\` 再算一次 | I-STOP |
| 错误出口 | 每个工具的 \`execute\` 外面包一层 try/catch | I-ERR |
| MCP 结果 | 包住 \`@ai-sdk/mcp\` 给出的工具的 \`execute\` | I-ERR、L10 |
| 审批恢复 | 执行被批准的那次调用外面 | I-IDEM、I-DENY |
| 历史重建 | 服务端，下一轮请求之前 | I-HIST |
| DSL 读成计划 | 一次性，读运营的原型 | 无 |

## 终止和错误

- 停止原因显式：approval、truncated、error、done、repeat、max_steps 各是各的；上限用 ≥。\`stopWhen\` 在一步做完之后才求值，预算和超时在发请求之前查
- 错误文本：\`[tool error] 工具名: 消息\`，换行，\`下一步：\` 加提示；先脱敏再按码点截断；不叫模型原样重试。DeepSeek 忽略 \`is_error\`，信号只能放在文本里；\`is_error\` 照设，换端点时有用
- MCP 的 \`isError\` 只有缺省、\`null\`、\`false\` 算成功，不认识的内容写出来，不吞

## 历史与审批

- 服务端持久化模型消息（\`response.messages\`），下一轮从日志重建；客户端发来的 UI 消息只用来对账，drifted 记录告警，forged 的审批直接拒
- \`onError\` 返回脱敏后的课程文本，不返回原始异常
- 审批状态存服务端，deny 优先；如果用 AI SDK 的审批，配 \`experimental_toolApprovalSecret\`
- 历史策略用分块截断保前缀，不用每轮都滑动的窗口

## 退款

- 幂等键：作业 id 加调用 id 派生，按租户隔离，交给支付网关（L19 第四节）
- 审批恢复只消费一次：先认领再执行；in-flight 不重跑，拿外部 key 去网关对账；同一条审批先批后拒报 conflict
- 模型请求的自动重试（\`maxRetries\` 默认 2）只重放模型调用，不带幂等键；工具层不自动重试无 key 的写
- abort 时已完成的步不在返回值里，在 \`onStepEnd\` 里落盘

## tracing 与成本

- span 发到自己的 collector；AI SDK 的 telemetry 注册即开、默认记录输入，要过一遍脱敏
- 如果用到 OpenAI Agents SDK，只装 \`@openai/agents-core\`，exporter 自己设；伞包一 import 就注册 OpenAI exporter，默认含敏感数据
- MCP 的失败要记成失败，否则失败率被低估
- 按客户计费：成本按自己记的 usage 算，按租户汇总，不依赖任何 SDK 报的成本

## Claude Agent SDK 和平台

- 这个场景不用 Claude Agent SDK。它跑一个约 240MB 的 Claude Code 二进制，许可是专有的，默认值是 coding harness 的：权限由模型分类器替你批、没有轮数和预算上限、继承机器上的 settings 和环境变量。要的就是一个 coding agent（比如进 CI 改代码）时再考虑，用时显式设 \`permissionMode\`（无人值守用 \`dontAsk\`）、\`maxTurns\`、\`maxBudgetUsd\`、\`settingSources: []\`、\`env\`，被拒看 \`result.permission_denials\`
- Dify 原型：用 \`difyPlan\` 读成代码计划，节点是步骤、边是控制流、引用是数据流。先看 \`ref-not-upstream\` 这类问题；DSL 不带凭据和知识库，检索要换成自己的索引；HTTP 节点默认不重试，改写时补幂等键
- 许可：对外按客户计费，如果直接用 Dify 给每个客户开 workspace，需要 Dify 的书面授权；n8n 不能嵌进对外收费的产品

## 版本

- 锁精确版本，0.x 的包不写 \`^\`
- 升级时先在新版本上重录这几处行为：默认上限、错误回填、MCP 的 \`isError\`、UI 遮罩、状态重放、输出上限。对得上再升，对不上先改适配器`,
    },
  ],
}
