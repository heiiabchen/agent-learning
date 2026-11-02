/**
 * 把一节的 quiz 真的过一遍 RichBlock，检查渲染结果。
 *
 * ★ 为什么需要单独一个：quiz 的解析里**不是** markdown，是
 * src/components/RichText.tsx 里那个只认五种块的小解析器。
 * 在讲义（MDX）里能用的东西，在这里大部分不能用——而它不会报错，
 * 只会把 `## 标题` 和 `<br />` 原样印在页面上。
 *
 * 跑法：npx tsx scripts/quiz-check.tsx L14
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RichBlock, RichText } from '../src/components/RichText'

const id = process.argv[2]
if (!id) {
  console.error('用法：npx tsx scripts/quiz-check.tsx L14')
  process.exit(1)
}

const { quiz } = (await import(`../src/lessons/${id}/quiz.ts`)) as {
  quiz: { lessonId: string; questions: Record<string, unknown>[] }
}

const problems: [string, string, string][] = []
let tables = 0
let codeBlocks = 0

/** 渲染后的文本里出现这些，就说明它没被解析。 */
const HAZARDS: [RegExp, string][] = [
  [/<br\s*\/?>/, '<br /> 原样印出来了（这个解析器不认 HTML 标签）'],
  [/^#{1,6}\s/m, '# 标题没被解析（只认段落／表格／列表／缩进代码／---）'],
  [/^>\s/m, '> 引文没被解析'],
  [/^```/m, '``` 围栏代码块没被解析（这里要用缩进四格）'],
  [/\*\*/, '** 没被解析成加粗'],
  [/^\|?\s*:?-{3,}.*\|/m, '表格分隔行渲染成了文本'],
]

function check(where: string, text: string) {
  const html = renderToStaticMarkup(createElement(RichBlock, { text }))
  tables += (html.match(/<table>/g) ?? []).length
  codeBlocks += (html.match(/<pre>/g) ?? []).length
  // <pre> 和行内 <code> 里的内容按定义就是字面量——`**/.env` 里那两个星号是路径的一部分。
  const rendered = html
    .replace(/<pre>[\s\S]*?<\/pre>/g, '')
    .replace(/<code>[\s\S]*?<\/code>/g, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
  for (const [re, what] of HAZARDS) {
    const m = re.exec(rendered)
    if (m) problems.push([where, what, rendered.slice(Math.max(0, m.index - 20), m.index + 70).replace(/\n/g, '⏎')])
  }
}

for (const q of quiz.questions) {
  const qid = String(q.id)
  check(`${qid}.prompt`, String(q.prompt))
  if (q.kind === 'choice') {
    for (const o of q.options as { id: string; label: string }[]) {
      renderToStaticMarkup(createElement(RichText, { text: o.label }))
    }
    check(`${qid}.explain`, String(q.explain))
  } else {
    if (q.scenario) check(`${qid}.scenario`, String(q.scenario))
    check(`${qid}.reference`, String(q.reference))
    for (const [i, r] of ((q.rubric as string[]) ?? []).entries()) check(`${qid}.rubric[${i}]`, r)
  }
}

console.log(`\nsrc/lessons/${id}/quiz.ts`)
console.log(`  ${quiz.questions.length} 道题 · ${tables} 张表 · ${codeBlocks} 个代码块`)
if (problems.length) {
  console.log(`\n  ✕ ${problems.length} 处：`)
  for (const [where, what, sample] of problems) console.log(`    ${where}\n      ${what}\n      …${sample}…`)
  process.exit(1)
}
console.log(`\n  ✓ 渲染结果干净`)
