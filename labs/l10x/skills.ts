/**
 * L10x 的脚手架。跑法：pnpm skills
 *
 * 观察实验：同一组 skill 在四种客户端策略下的结局、YAML 陷阱、description 重叠、
 * 目录预算的三个阶段、skill 与 MCP 的上下文账、缓存下的真实成本。
 * 全程零模型，只用确定性假数据。写完七个 TODO 跑 pnpm verify:l10x。
 */

import {
  CACHE_READ,
  catalogCost,
  catalogOrder,
  fmtHundredths,
  parseFrontmatter,
  prefixChangeCost,
  renderCatalog,
  residentCost,
  resolveCollisions,
  skillFromText,
  validateStrict,
  wordJaccardBp,
  type BlockResult,
  type CatalogOpts,
  type CatalogResult,
  type NameCode,
  type ParseResult,
  type Policy,
  type Resolved,
  type ScalarResult,
  type SkillCtx,
  type SkillMeta,
  type SplitResult,
  type ApprovalInput,
  type Approval,
} from '../shared/skills.ts'
import { toolsListCost, type McpTool } from '../shared/mcp.ts'
import type { SafePath } from '../shared/sandbox.ts'
import { isMain } from '../shared/entry.ts'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const w = (s: string) =>
  [...visible(s)].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - w(s)))

function skill(ctx: SkillCtx, front: string): SkillMeta {
  const r = skillFromText(`---\n${front}\n---\n正文。\n`, ctx)
  if (!r.skill) throw new Error(`夹具写错了：${ctx.dir}`)
  return r.skill
}

/** 整数比值，两位小数，不经过浮点格式化。 */
function ratio(a: number, b: number): string {
  return fmtHundredths(Math.floor((a * 100) / b)) + 'x'
}

// ─────────────────────────────────────────────────────────────

function exp1(): void {
  console.log(bold('\n实验一：同一组文件，四种客户端，四种结局'))
  const files: { label: string; s: SkillMeta }[] = [
    {
      label: 'user',
      s: skill({ dir: '/home/me/.agents/skills/pdf', scope: 'user', trust: 'user', alias: '.agents' },
        'name: pdf\ndescription: Extract text from PDF files (my copy).'),
    },
    {
      label: 'project',
      s: skill({ dir: '/repo/.agents/skills/pdf', scope: 'project', trust: 'project-trusted', alias: '.agents' },
        'name: pdf\ndescription: Extract text from PDF files (repo copy).'),
    },
    {
      label: '根 .agents',
      s: skill({ dir: '/repo/.agents/skills/review', scope: 'project', trust: 'project-trusted', alias: '.agents' },
        'name: review\ndescription: Review a diff.'),
    },
    {
      label: 'web .agents',
      s: skill({ dir: '/repo/packages/web/.agents/skills/review', scope: 'project', trust: 'project-trusted', alias: '.agents' },
        'name: review\ndescription: Review a frontend diff.'),
    },
    {
      label: '.gemini',
      s: skill({ dir: '/repo/.gemini/skills/review', scope: 'project', trust: 'project-trusted', alias: '.gemini' },
        'name: review\ndescription: Review a diff (gemini copy).'),
    },
  ]
  const label = (loc: string) => files.find((f) => f.s.location === loc)?.label ?? loc
  const policies: Policy[] = ['agentskills-guide', 'claude-code', 'gemini-cli', 'codex']
  console.log(`  ${pad('策略', 20)}${pad('pdf 用哪份', 14)}${pad('review 用哪份', 16)}${pad('遮蔽条数', 10)}按名字点时有歧义`)
  console.log('  ' + '─'.repeat(78))
  for (const p of policies) {
    const r = resolveCollisions(files.map((f) => f.s), p)
    const pick = (name: string) => {
      const hits = r.active.filter((s) => s.name === name)
      return hits.length === 1 ? label(hits[0]!.location) : `全留（${hits.length} 份）`
    }
    const amb = r.ambiguous.length > 0 ? r.ambiguous.join(', ') : '—'
    console.log(`  ${pad(p, 20)}${pad(pick('pdf'), 14)}${pad(pick('review'), 16)}${pad(String(r.shadowed.length), 10)}${amb}`)
  }

  console.log(bold('\n  同一个文件，作者侧和运行时两种结论'))
  const cases: { file: string; dir: string; front: string }[] = [
    { file: 'report-gen/SKILL.md', dir: 'report-gen', front: 'name: report\ndescription: Generate a weekly report.' },
    {
      file: 'deploy/SKILL.md',
      dir: 'deploy',
      front: 'name: deploy\ndescription: Deploy the app.\nwhen_to_use: When the user says ship it.',
    },
  ]
  console.log(`  ${pad('文件', 22)}${pad('strict（作者侧）', 34)}lenient（运行时）`)
  console.log('  ' + '─'.repeat(78))
  for (const c of cases) {
    const p = parseFrontmatter(`---\n${c.front}\n---\n`, 'strict')
    const strict = p.ok ? validateStrict(p.fm, c.dir).map((d) => d.code + (d.field ? ` ${d.field}` : '')).join(', ') : '解析失败'
    const r = skillFromText(`---\n${c.front}\n---\n`, { dir: `/repo/.agents/skills/${c.dir}`, scope: 'project', trust: 'project-trusted' })
    const lenient = r.skill
      ? `加载为 ${r.skill.name}，${r.diags.length} 条 warning，extra：${Object.keys(r.skill.extra).join(', ') || '—'}`
      : '跳过'
    console.log(`  ${pad(c.file, 22)}${pad(strict || '通过', 34)}${lenient}`)
  }
  console.log(dim('\n  标准只规定了文件长什么样。谁赢、严不严，全是客户端自己的策略。'))
}

// ─────────────────────────────────────────────────────────────

const YAML_CASES: [string, string, string, string][] = [
  ['01 1.0', 'v: 1.0', 'float:1.0', 'int:1'],
  ['02 no', 'v: no', 'bool:false', 'str:"no"'],
  ['03 on', 'v: on', 'bool:true', 'str:"on"'],
  ['04 yes', 'v: yes', 'bool:true', 'str:"yes"'],
  ['05 0123', 'v: 0123', 'int:83', 'int:123'],
  ['06 0x1F', 'v: 0x1F', 'int:31', 'int:31'],
  ['07 1e3', 'v: 1e3', 'str:"1e3"', 'int:1000'],
  ['08 date', 'v: 2026-10-12', 'date', 'date'],
  ['09 ~', 'v: ~', 'null', 'null'],
  ['10 null', 'v: null', 'null', 'null'],
  ['11 .inf', 'v: .inf', 'float:inf', 'float:Infinity'],
  ['12 colon-space', 'v: Use when: the user asks', 'ERR', 'ERR'],
  ['13 trailing #', 'v: value # comment', 'str:"value"', 'str:"value"'],
  ['14 dq colon', 'v: "quoted: ok"', 'str:"quoted: ok"', 'str:"quoted: ok"'],
  ['15 sq escape', "v: 'it''s'", `str:"it's"`, `str:"it's"`],
  ['16 dq \\u', 'v: "caf\\u00e9"', 'str:"café"', 'str:"café"'],
  ['17 flow seq', 'v: [a, b]', 'list', 'list'],
  ['18 flow map', 'v: {a: b}', 'map', 'map'],
  ['19 block seq', 'v:\n  - a\n  - b', 'list', 'list'],
  ['20 folded >', 'v: >\n  line one\n  line two', 'str:"line one line two"', 'str:"line one line two\\n"'],
  ['21 literal |', 'v: |\n  line one\n  line two', 'str:"line one\\nline two"', 'str:"line one\\nline two\\n"'],
  ['22 anchor', 'a: &x hello\nv: *x', 'str:"hello"', 'str:"hello"'],
  ['23 dup key', 'v: first\nv: second', 'str:"second"', 'ERR'],
  ['24 tab', 'v:\n\t- a', 'ERR', 'ERR'],
]

function showParse(r: ParseResult): string {
  if (!r.ok) return `ERR ${r.diags[r.diags.length - 1]!.code}`
  const v = r.fm.fields['v']
  const warned = r.diags.length > 0 ? ' ⚠' : ''
  return (v === undefined ? '—' : JSON.stringify(v)) + warned
}

function exp2(): void {
  console.log(bold('\n实验二：frontmatter 不是「随便用个 YAML 库」'))
  console.log(dim('  PyYAML 6.0.3 与 js-yaml 4.3.2 两列是调研时的实测结果，写死在这里，lab 不装它们。'))
  console.log(`  ${pad('样例', 16)}${pad('子集 strict', 28)}${pad('子集 lenient', 30)}${pad('PyYAML', 26)}js-yaml`)
  console.log('  ' + '─'.repeat(110))
  let agree = 0
  for (const [id, y, py, js] of YAML_CASES) {
    const text = `---\n${y}\n---\n`
    if (py === js) agree++
    console.log(
      `  ${pad(id, 16)}${pad(showParse(parseFrontmatter(text, 'strict')), 28)}${pad(showParse(parseFrontmatter(text, 'lenient')), 30)}${pad(py, 26)}${js}`,
    )
  }
  console.log(dim(`\n  PyYAML 和 js-yaml 只在 ${agree} / ${YAML_CASES.length} 个样例上一致；`))
  console.log(dim('  加上 yaml 和 strictyaml 四家一起比（报错都算同一种结果），只剩 7 / 24。'))
  console.log(dim('  子集的规则：几家一致的照常支持；不一致的拒绝，或在字段层用显式规则收口。'))
}

// ─────────────────────────────────────────────────────────────

const OVERLAP: [string, string, string][] = [
  [
    'pdf',
    'Use this skill whenever the user mentions PDFs, documents, files, reports, forms or any document processing, even if they do not explicitly ask for it.',
    'Extract text, tables and form fields from existing PDF files. Not for creating new PDFs or editing Word files.',
  ],
  [
    'docx',
    'Use this skill whenever the user mentions Word documents, files, reports, letters or any document editing, even if they do not explicitly ask for it.',
    'Edit existing .docx files: tracked changes, comments, styles. Not for PDFs or plain-text notes.',
  ],
  [
    'xlsx',
    'Use this skill whenever the user mentions spreadsheets, Excel, tables, data, files or any numbers, even if they do not explicitly ask for it.',
    'Read and write .xlsx workbooks, including formulas and cell formatting. Not for CSV files or charts.',
  ],
  [
    'csv',
    'Use this skill whenever the user mentions CSV, data, tables, files, analysis or any dataset, even if they do not explicitly ask for it.',
    'Profile a CSV file: column types, missing values, outliers. Not for Excel workbooks.',
  ],
  [
    'chart',
    'Use this skill whenever the user mentions charts, plots, graphs, data, reports or any visualization, even if they do not explicitly ask for it.',
    'Render a PNG chart from tabular data with matplotlib. Not for dashboards or slide layout.',
  ],
  [
    'report',
    'Use this skill whenever the user mentions reports, summaries, documents, data or any writing task, even if they do not explicitly ask for it.',
    'Draft a weekly status report from a list of merged PRs. Not for emails or slide decks.',
  ],
  [
    'email',
    'Use this skill whenever the user mentions email, messages, letters, documents or any writing task, even if they do not explicitly ask for it.',
    "Draft a reply to an email thread in the user's tone. Not for reports or chat messages.",
  ],
  [
    'slides',
    'Use this skill whenever the user mentions slides, presentations, decks, reports or any document, even if they do not explicitly ask for it.',
    'Build a .pptx deck from an outline, one slide per heading. Not for charts or PDF export.',
  ],
]

function overlapStats(descs: [string, string][]): { avg: number; top: [string, string, number][] } {
  const pairs: [string, string, number][] = []
  for (let i = 0; i < descs.length; i++) {
    for (let j = i + 1; j < descs.length; j++) {
      pairs.push([descs[i]![0], descs[j]![0], wordJaccardBp(descs[i]![1], descs[j]![1])])
    }
  }
  const sum = pairs.reduce((a, p) => a + p[2], 0)
  const top = [...pairs].sort((a, b) => b[2] - a[2] || (a[0] + a[1] < b[0] + b[1] ? -1 : 1)).slice(0, 3)
  return { avg: Math.floor(sum / pairs.length), top }
}

function exp3(): void {
  console.log(bold('\n实验三：description 写得越「积极」，彼此越像'))
  console.log(dim('  指标是小写词集合的 Jaccard（基点，万分之一）。它只是确定性的重叠代理，不预测真实触发率。'))
  const pushy = overlapStats(OVERLAP.map(([n, p]) => [n, p]))
  const bounded = overlapStats(OVERLAP.map(([n, , b]) => [n, b]))
  console.log(`  ${pad('写法', 24)}${pad('28 对的平均重叠', 18)}最像的三对`)
  console.log('  ' + '─'.repeat(78))
  for (const [label, s] of [
    ['「只要提到就用」', pushy],
    ['意图 + 边界（不适用于…）', bounded],
  ] as const) {
    const top = s.top.map(([a, b, v]) => `${a}/${b} ${v}`).join('  ')
    console.log(`  ${pad(label, 24)}${pad(String(s.avg), 18)}${top}`)
  }
  console.log(dim('\n  官方建议 description 写得 pushy 一点，免得不触发；可每个 skill 都这么写，它们就互相抢。'))
}

// ─────────────────────────────────────────────────────────────

function fakeSkills(n: number): SkillMeta[] {
  const filler = 'Step-by-step guidance with checks, worked examples and the edge cases that usually go wrong. '
  const out: SkillMeta[] = []
  for (let i = 1; i <= n; i++) {
    const id = `skill-${String(i).padStart(3, '0')}`
    const user = i % 2 === 0
    const desc = `Use for workflow ${i}: ${filler.repeat(3)}`.slice(0, 200).replace(/ +$/, '')
    out.push(
      skill(
        user
          ? { dir: `/home/me/.agents/skills/${id}`, scope: 'user', trust: 'user', alias: '.agents' }
          : { dir: `/repo/.agents/skills/${id}`, scope: 'project', trust: 'project-trusted', alias: '.agents' },
        `name: ${id}\ndescription: ${desc}`,
      ),
    )
  }
  return out
}

function exp4(): void {
  console.log(bold('\n实验四：目录预算 8000 字符，装到第几个 skill 开始出事'))
  console.log(`  ${pad('skill 数', 10)}${pad('阶段', 6)}${pad('目录字符', 10)}${pad('description 显示', 18)}${pad('被截短', 8)}省略（project / user）`)
  console.log('  ' + '─'.repeat(78))
  for (const n of [10, 30, 60, 120, 200]) {
    const skills = fakeSkills(n)
    const r = renderCatalog(skills, { budgetChars: 8000, format: 'lines' })
    const shown = r.entries.map((e) => e.shown)
    const range = shown.length === 0 ? '—' : `${Math.min(...shown)}–${Math.max(...shown)}`
    const cut = r.entries.filter((e) => e.shown < e.full).length
    const scopeOf = (name: string) => skills.find((s) => s.name === name)!.scope
    const op = r.omitted.filter((x) => scopeOf(x) === 'project').length
    const ou = r.omitted.filter((x) => scopeOf(x) === 'user').length
    console.log(`  ${pad(String(n), 10)}${pad(String(r.stage), 6)}${pad(String([...r.text].length), 10)}${pad(range, 18)}${pad(String(cut), 8)}${op} / ${ou}`)
  }
  console.log(dim('\n  每条 description 才 200 字符，远低于 1024 的上限，30 个左右就开始截短。'))
  console.log(dim('  到了阶段 3，按目录顺序贪心放，user 层排在最后，最先整条消失。'))
}

// ─────────────────────────────────────────────────────────────

const SAME_DESC =
  'Extract text, tables and form fields from PDF files and return them as Markdown. ' +
  'Use when the user provides a PDF or asks about its contents. Not for creating or editing PDFs.'

function mcpTool(name: string): McpTool {
  return {
    name,
    description: SAME_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the PDF file' },
        pages: { type: 'string', description: 'Page range such as 1-3' },
        format: { type: 'string', enum: ['text', 'markdown'] },
      },
      required: ['path'],
    },
    run: async () => ({ text: '', isError: false }),
  }
}

function exp5(): void {
  console.log(bold('\n实验五：同一段 description，做成 skill 条目和做成 MCP 工具，差多少'))
  console.log(dim(`  description ${[...SAME_DESC].length} 字符；MCP 那边多一个三参数的 inputSchema。token 用课程的 estimateTokens。`))
  console.log(`  ${pad('N', 6)}${pad('skill（XML）', 14)}${pad('skill（行）', 14)}${pad('MCP tools/list', 16)}MCP / XML`)
  console.log('  ' + '─'.repeat(60))
  for (const n of [3, 10, 30, 120]) {
    const names = Array.from({ length: n }, (_, i) => `pdf-${String(i + 1).padStart(3, '0')}`)
    const skills = names.map((nm) =>
      skill({ dir: `/home/me/.agents/skills/${nm}`, scope: 'user', trust: 'user' }, `name: ${nm}\ndescription: ${SAME_DESC}`),
    )
    const xml = catalogCost(skills, 'xml')
    const lines = catalogCost(skills, 'lines')
    const mcp = toolsListCost(names.map(mcpTool)).tokens
    console.log(`  ${pad(String(n), 6)}${pad(String(xml), 14)}${pad(String(lines), 14)}${pad(String(mcp), 16)}${ratio(mcp, xml)}`)
  }
  console.log(dim('\n  格式本身只差一个 inputSchema。skill 真正省的是把「怎么做」推迟到激活之后。'))

  console.log(bold('\n  会话中途装了一个新 skill，这一轮的输入计费（基础 token 价 = 1）'))
  const layers = { tools: 2965, system: 3000, history: 40000 }
  console.log(dim(`  tools ${layers.tools}、system ${layers.system}、history ${layers.history} token；缓存写 1.25 倍、读 0.1 倍。`))
  console.log(`  ${pad('目录放在哪', 36)}${pad('前缀失效', 12)}本轮计费`)
  console.log('  ' + '─'.repeat(60))
  for (const [label, at] of [
    ['激活工具的 name enum 里', 'tools'],
    ['system prompt 里', 'system'],
    ['作为一条新消息追加在末尾', 'tail'],
  ] as const) {
    const r = prefixChangeCost(layers, at)
    console.log(`  ${pad(label, 36)}${pad(String(r.invalidated), 12)}${fmtHundredths(r.cost)}`)
  }
  console.log(dim('\n  放在 enum 里还是 system 里只差 tools 那一层；大头是对话历史，分水岭是「改没改前缀」。'))
}

// ─────────────────────────────────────────────────────────────

function exp6(): void {
  console.log(bold('\n实验六：有了前缀缓存，skill 比 AGENTS.md 省在哪'))
  const body = 2000
  const entry = 60
  const rounds = 20
  console.log(dim(`  一段 ${body} token 的流程知识，目录条目 ${entry} token，会话 ${rounds} 轮。单位：基础 token 价。`))
  const agents = residentCost(body, rounds)
  const rows: [string, number][] = [
    ['放进 AGENTS.md（常驻）', agents],
    ['做成 skill，整场没激活', residentCost(entry, rounds)],
    ['做成 skill，第 1 轮就激活', residentCost(entry, rounds) + residentCost(body, rounds, 1)],
    ['做成 skill，第 5 轮激活', residentCost(entry, rounds) + residentCost(body, rounds, 5)],
    ['做成 skill，第 15 轮激活', residentCost(entry, rounds) + residentCost(body, rounds, 15)],
  ]
  console.log(`  ${pad('放法', 30)}${pad('20 轮合计', 14)}相对 AGENTS.md`)
  console.log('  ' + '─'.repeat(60))
  for (const [label, cost] of rows) {
    console.log(`  ${pad(label, 30)}${pad(fmtHundredths(cost), 14)}${Math.floor((cost * 100) / agents)}%`)
  }
  console.log(dim(`\n  激活之后正文进了历史，之后每轮按缓存读（${CACHE_READ / 100} 倍）计费，和常驻几乎一样贵。`))
  console.log(dim('  省钱只来自「大多数会话根本不激活」。一个几乎每次都被激活的 skill，应该进 AGENTS.md。'))
}

function observe(): void {
  console.log(bold('L10x · 观察实验（参考实现）'))
  console.log(dim('跑完这些再去写 TODO。每一张表都对应一条「直觉是反的」。'))
  exp1()
  exp2()
  exp3()
  exp4()
  exp5()
  exp6()
  void catalogOrder
}

// ── TODO ─────────────────────────────────────────────────────
//
// 七个 TODO 的契约都在 shared/skills.ts 对应函数的注释里，带 ★ 的是会被 verify 抓的坑。
// 写完一个就可以跑 pnpm verify:l10x 看对应那一组。

/**
 * TODO 1 ★ 切出 frontmatter 的行和正文。
 * 去 BOM，CRLF 和孤立 CR 都换成 LF；第一行必须恰好是 ---；结束符是之后第一个恰好是 --- 的整行。
 * 正文去掉开头的空行。
 */
export function mySplitFrontmatter(text: string): SplitResult {
  throw new Error('TODO 1 未实现')
}

/**
 * TODO 2a ★★ 单行标量。不做任何类型推断。
 * 支持 plain、"双引号"（转义只认 \\ \" \n \t \uXXXX，拒绝代理对）、'单引号'（'' 是 '）、行尾 ` #` 注释。
 * 以 [ { & * ! % @ ` | > 开头的拒绝；`- `、`? ` 开头的拒绝。
 * plain 里出现 `: ` 或以 `:` 结尾时 colon 为 true（是否报错由调用方按 mode 决定）。
 */
export function myParseScalar(raw: string): ScalarResult {
  throw new Error('TODO 2a 未实现')
}

/**
 * TODO 2b ★★ 块标量。header 是 | |- > >- 之一，lines 是带原始缩进的续行。
 * 缩进以第一个非空行为准；clip 固定为恰好一个末尾 \n；folded 里更深的缩进拒绝。
 */
export function myBlockScalar(header: string, lines: string[]): BlockResult {
  throw new Error('TODO 2b 未实现')
}

/** TODO 3a ★ 码点长度。 */
export function myCpLen(s: string): number {
  throw new Error('TODO 3a 未实现')
}

/**
 * TODO 3b ★ name 校验。空 → NAME_MISSING；超过 64 个码点 → NAME_LENGTH；
 * 不是 ASCII 小写字母数字加单个连字符（首尾不能是连字符） → NAME_CHARSET；否则 null。
 */
export function myValidateName(name: string): NameCode | null {
  throw new Error('TODO 3b 未实现')
}

/**
 * TODO 4 ★★ 按策略合并同名 skill。规则见 POLICY_RANK、aliasRank 和 resolveCollisions 的注释。
 * 胜出的是整条记录；每个败者一条 Shadow；codex 策略全留并记进 ambiguous。
 * active 按 name、再按 location 排序；shadowed 按 name 排，同名的败者按策略优先级从高到低排。
 */
export function myResolveCollisions(skills: SkillMeta[], policy: Policy): Resolved {
  throw new Error('TODO 4 未实现')
}

/**
 * TODO 5 ★★ 渲染目录，带三阶段预算。可以用 catalogOrder、catalogDesc、renderEntry、wrapCatalog。
 * 预算按 text 的码点数算；阶段 2 从排序后的第一个开始轮转，每次加一个码点；
 * 阶段 3 去掉全部 description，按顺序放，第一个放不下的起全部省略。
 */
export function myRenderCatalog(skills: SkillMeta[], opts: CatalogOpts): CatalogResult {
  throw new Error('TODO 5 未实现')
}

/**
 * TODO 6 ★ 把 skill 资源路径解析到 skill 目录之内。用 safePath，不要自己拼字符串。
 * 解析结果是目录本身（realRel 为 '.'）时返回 INVALID。
 */
export function myResolveSkillResource(skill: SkillMeta, rel: string): SafePath {
  throw new Error('TODO 6 未实现')
}

/**
 * TODO 7 ★★ 一条命令要不要问人。可以用 DANGEROUS_PATTERNS 和 SHELL_META；
 * Bash / Bash(cmd) / Bash(prefix:*) 三种规则的匹配自己写，不要直接调 matchAllowed。
 * untrusted → deny；危险模式即使被预批准也要 ask；没被精确命中 → ask；哈希缺失或变了 → ask；否则 auto。
 * reasons 依次是 DANGEROUS:<id>…、NOT_PREAPPROVED、NOT_APPROVED 或 HASH_CHANGED。
 */
export function myScriptApproval(a: ApprovalInput): { decision: Approval; reasons: string[] } {
  throw new Error('TODO 7 未实现')
}

void mySplitFrontmatter
void myParseScalar
void myBlockScalar
void myCpLen
void myValidateName
void myResolveCollisions
void myRenderCatalog
void myResolveSkillResource
void myScriptApproval

if (isMain(import.meta.url)) {
  observe()
  console.log(
    dim(
      '\n  下一步：实现文件下半部分的七个 TODO，然后跑 pnpm verify:l10x（或 uv run python -m l10x.verify）。',
    ) +
      dim('\n  想先确认测试本身是对的，跑 SKILLS_IMPL=shared 下的 verify。') +
      dim('\n  观察实验：pnpm skills / uv run python -m l10x.skills\n'),
  )
}
