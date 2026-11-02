/**
 * 把一节讲义真的渲染成 HTML，然后检查渲染结果——而不是检查源文件。
 *
 * 为什么需要这个：`check-mdx.mjs` 查的是组件白名单，`vite build` 查的是能不能编译。
 * 两者都通过，讲义仍然可能渲染成一堆竖线——MDX 里 JSX 块内的 markdown
 * 需要空行才会被当成 markdown 解析，而少了空行**不报错**。
 *
 * 跑法：node scripts/render-check.mjs L14
 */

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
// @mdx-js/mdx 是 @mdx-js/rollup 的传递依赖，pnpm 不把它提升到顶层，所以直接指路径。
const { compile, run } = await import(
  new URL('../node_modules/.pnpm/@mdx-js+mdx@3.1.1/node_modules/@mdx-js/mdx/index.js', import.meta.url).href
)
import * as runtime from 'react/jsx-runtime'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'

const id = process.argv[2]
if (!id) {
  console.error('用法：node scripts/render-check.mjs L14')
  process.exit(1)
}

const path = `src/lessons/${id}/content.mdx`
const source = readFileSync(path, 'utf8')

// 用最朴素的 stub 换掉那九个组件：它们只要把 children 原样放进 DOM 就行。
// 这样任何"本该是表格却渲染成文本"的情况都会留在 HTML 里。
const stub =
  (label) =>
  ({ title, children }) =>
    createElement('section', { 'data-block': label, 'data-title': title ?? '' }, children)

const components = {
  Key: stub('key'),
  Note: stub('note'),
  Drill: stub('drill'),
  Pitfall: stub('pitfall'),
  Lab: stub('lab'),
  Steps: ({ children }) => createElement('ol', null, children),
  CursorHook: stub('cursor'),
  PyMirror: stub('python'),
  TsMirror: stub('ts'),
}

const compiled = await compile(source, {
  outputFormat: 'function-body',
  remarkPlugins: [remarkGfm],
  rehypePlugins: [rehypeSlug],
})
const { default: Content } = await run(compiled, { ...runtime, baseUrl: import.meta.url })
const html = renderToStaticMarkup(createElement(Content, { components }))

// 先去掉 <pre> 里的内容——代码块里出现 ** 或 | 是正常的。
const text = html
  .replace(/<pre>[\s\S]*?<\/pre>/g, '')
  .replace(/<[^>]+>/g, '\n')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)

const problems = []

// 一、渲染后的**文本**里不该出现组件名或 JSX 语法
for (const name of Object.keys(components)) {
  const leaked = text.filter((l) => l.includes(`<${name}`) || l.includes(`</${name}>`))
  if (leaked.length) problems.push([`组件 ${name} 以文本形式泄漏`, leaked[0]])
}

// 二、不该有渲染成文本的表格分隔行
const pipes = text.filter((l) => /^\|?\s*:?-{3,}/.test(l) || /\|\s*-{3,}\s*\|/.test(l))
if (pipes.length) problems.push([`${pipes.length} 处表格渲染成了竖线文本`, pipes[0]])

// 三、不该有没被解析的粗体
const bold = text.filter((l) => /\*\*[^*]+\*\*/.test(l))
if (bold.length) problems.push([`${bold.length} 处 **粗体** 没被解析`, bold[0]])

// 四、每个 JSX 块里都得有内容
const empty = [...html.matchAll(/<section data-block="([^"]+)"[^>]*><\/section>/g)]
if (empty.length) problems.push([`${empty.length} 个空块`, empty[0][1]])

// 统计
const tables = (html.match(/<table>/g) ?? []).length
const codeBlocks = (html.match(/<pre>/g) ?? []).length
const blocks = (html.match(/<section data-block=/g) ?? []).length
const h2 = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''))
const quotes = (html.match(/<blockquote>/g) ?? []).length

console.log(`\n${path}`)
console.log(`  ${h2.length} 个二级标题 · ${tables} 张表 · ${codeBlocks} 个代码块 · ${blocks} 个折叠块 · ${quotes} 段引文`)
console.log(`\n  标题：`)
for (const t of h2) console.log(`    ${t}`)

if (problems.length) {
  console.log(`\n  ✕ ${problems.length} 类问题：`)
  for (const [what, sample] of problems) console.log(`    · ${what}\n      ${sample.slice(0, 100)}`)
  process.exit(1)
}
console.log(`\n  ✓ 渲染结果干净：没有泄漏的 JSX、没有竖线表格、没有未解析的粗体、没有空块`)
