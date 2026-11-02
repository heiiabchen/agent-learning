/**
 * 讲义里用了 mdx-components.tsx 没注册的组件时，tsc 和 vite build 都不会报错——
 * MDX 编译出的 _missingMdxReference 是运行时才抛的，抛出来整页白屏。
 * 这个脚本把那件事变成构建期错误。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const lessonsDir = join(root, 'src/lessons')

const provided = new Set(
  readFileSync(join(root, 'src/mdx-components.tsx'), 'utf8')
    .split(/export const mdxComponents[^{]*\{/)[1]
    .split('}')[0]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

/** 去掉围栏代码块和行内代码，否则 Array<Anthropic.Message> 会被当成组件。 */
function prose(src) {
  return src
    .replace(/^\s*```[\s\S]*?^\s*```/gm, '')
    .replace(/`[^`\n]*`/g, '')
}

let bad = 0
for (const dir of readdirSync(lessonsDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const file = join(lessonsDir, dir.name, 'content.mdx')
  let src
  try {
    src = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const used = new Set([...prose(src).matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]))
  const missing = [...used].filter((c) => !provided.has(c)).sort()
  if (missing.length) {
    console.error(`✗ ${dir.name}/content.mdx 用了未注册的组件：${missing.join('、')}`)
    bad++
  }
}

if (bad) {
  console.error(`\n在 src/mdx-components.tsx 里注册它们，或改用已有的组件（${[...provided].join('、')}）。`)
  process.exit(1)
}
console.log(`✓ 讲义组件检查通过（可用：${[...provided].join('、')}）`)
