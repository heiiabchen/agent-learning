/**
 * 把每一节的讲义和 quiz 都真的渲染一遍，检查渲染结果。
 *
 * ★ 为什么 check-mdx 和 tsc 都过了还需要这个：
 *
 *   check-mdx  查的是组件白名单
 *   tsc        查的是类型
 *   vite build 查的是能不能编译
 *
 * 三个都过，页面仍然可能印出 `**「不抽什么」**` 或者一个字面的 `<br />`——
 * 因为 markdown 的 flanking 规则和 quiz 那个自定义解析器的能力边界
 * 都是**静默**的：解析不了就当普通文本输出，不报错。
 *
 * 跑法：node scripts/check-render.mjs
 */

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const lessons = readdirSync('src/lessons', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

let failed = 0
for (const id of lessons) {
  for (const [script, runner] of [
    ['scripts/render-check.mjs', 'node'],
    ['scripts/quiz-check.tsx', 'tsx'],
  ]) {
    const r =
      runner === 'node'
        ? spawnSync('node', [script, id], { encoding: 'utf8' })
        : spawnSync('npx', ['tsx', script, id], { encoding: 'utf8' })
    if (r.status !== 0) {
      failed += 1
      console.log(`\n✕ ${id}`)
      console.log((r.stdout ?? '') + (r.stderr ?? ''))
    }
  }
}

if (failed > 0) {
  console.log(`\n${failed} 处渲染问题。`)
  process.exit(1)
}
console.log(`✓ 渲染检查通过（${lessons.length} 节的讲义与 quiz 都真的渲染了一遍）`)
