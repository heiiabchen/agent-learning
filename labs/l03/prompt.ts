/**
 * L03 · 任务一：可测试的 prompt 拼装。
 *
 * 跑法：pnpm prompt        验证：pnpm verify:l03
 *
 * `shared/prompt.ts` 里有我的实现。**先别看。**
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 这个任务看起来是「写几个字符串函数」，但它考的是一件具体的事：
 * **让 prompt 的错误在编译期或启动期暴露，而不是在模型行为变差时才被察觉。**
 *
 * L03 那道改错题里那个 `${opts.tools}` 把数组渲染成 `read,write` 的 bug，
 * 就是这个模块要挡住的东西。它不报错、不崩溃，只是让 agent「有时候不太聪明」。
 * ───────────────────────────────────────────────────────────────────────────
 */

export class PromptVarError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
    readonly unused: string[] = [],
  ) {
    super(message)
    this.name = 'PromptVarError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 1 · fill(template, vars)
//
//   把 {name} 形式的占位符换成 vars 里的值。
//
//   两个方向都要报错：
//     · 模板需要但 vars 里没有  → 抛 PromptVarError，missing 里列出来
//     · vars 里有但模板没用到  → 也抛错，unused 里列出来
//
//   第二条很多人觉得多余。想一下：多出来的变量通常意味着你改了模板忘了改调用方，
//   或者反过来。这是一个不要钱的一致性检查。
//
//   注意 vars 的值允许是 number（maxSteps 这种），别只处理 string。
// ─────────────────────────────────────────────────────────────────────────────

export function fill(template: string, vars: Record<string, string | number>): string {
  void template
  void vars
  throw new Error('TODO 1 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 2 · assertRendered(text)
//
//   渲染完之后再扫一遍，还有 {xxx} 就抛错。
//   防的是模板里写成 {max steps}（带空格）这种、TODO 1 的正则匹配不到的形式。
//
//   ★ 有个必须避开的误报，我第一版就踩了：
//   `<output_format>` 段里几乎一定会写 {"task": string, "owner": string} 这种形状说明。
//   如果你的正则是 /\{[^}]+\}/，它会把这个当成未渲染的占位符——
//   于是这个检查在最该用它的地方拦住了完全正确的 prompt。
//   想清楚「长得像变量名」和「长得像 JSON」怎么区分。
// ─────────────────────────────────────────────────────────────────────────────

export function assertRendered(text: string): void {
  void text
  throw new Error('TODO 2 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 3 · section({ tag, body })
//
//   渲染成：
//     <tag>
//     内容
//     </tag>
//
//   三条要求：
//     · body 是数组 → 渲染成 `1. xxx` 编号列表（编号是为了能在 eval 里逐条统计）
//     · body 是空字符串 / 空数组 / undefined / null → 返回 ''，整段省掉
//     · 数组里的空元素要过滤掉，不要渲染出 `3. ` 这种空条目
//
//   为什么空内容不能留 <rules></rules> 空壳：模型会试图理解「这里为什么是空的」，
//   而且空壳照样占 token。
// ─────────────────────────────────────────────────────────────────────────────

export interface Section {
  tag: string
  body: string | string[] | undefined | null
}

export function section(s: Section): string {
  void s
  throw new Error('TODO 3 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 4 · build(sections)
//
//   按数组顺序拼，段间空一行，空段跳过。
//   顺序就是缓存边界——稳定的段放前面（L02 那条纪律）。
// ─────────────────────────────────────────────────────────────────────────────

export function build(sections: Section[]): string {
  void sections
  throw new Error('TODO 4 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 5 · wrapUntrusted(tag, content, attrs?)
//
//   把不可信的外部内容（用户提交的代码、检索回来的文档）包进标签。
//
//   要处理的攻击面：content 里可以自带一个 `</code>` 把你的结构提前关掉，
//   后面的文字就从「数据」变成了「指令」。想个办法把内容里的同名闭合标签打断。
//
//   attrs 用来带 path 这类元信息，渲染成 <code path="src/a.ts">。
//
//   写完之后回答一个问题（这题 L14 会正面考）：
//   你这个处理是**安全边界**，还是只是**提高了门槛**？
//   如果攻击者知道你怎么打断的，他能绕过吗？
// ─────────────────────────────────────────────────────────────────────────────

export function wrapUntrusted(tag: string, content: string, attrs?: Record<string, string>): string {
  void tag
  void content
  void attrs
  throw new Error('TODO 5 还没实现')
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO 6 · 用上面的零件拼出 L03 第三节那个六段骨架
//
//   写一个 buildAgentPrompt(vars)，产出 role / capabilities / rules /
//   output_format / examples 五段（context 是动态的，不放 system）。
//
//   然后做一件事，这是本任务真正的收尾：
//   **故意漏传一个变量，确认它抛错**。你要亲眼看到它响，而不是相信它会响。
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentPromptVars {
  cwd: string
  toolNames: string[]
  maxSteps: number
}

export function buildAgentPrompt(vars: AgentPromptVars): string {
  void vars
  throw new Error('TODO 6 还没实现')
}

if (import.meta.filename === process.argv[1]) {
  console.log(
    buildAgentPrompt({
      cwd: '/repo',
      toolNames: ['read_file', 'list_dir', 'run_tests'],
      maxSteps: 12,
    }),
  )
}
