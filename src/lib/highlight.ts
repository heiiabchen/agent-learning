import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

/**
 * 只打包题目里用得到的语言，避免 shiki 把上百个语法包都拆成 chunk。
 * 用 JS 正则引擎而不是 oniguruma，省掉一个 wasm。
 */
let pending: Promise<HighlighterCore> | null = null

export function getHighlighter() {
  pending ??= createHighlighterCore({
    themes: [import('@shikijs/themes/github-light')],
    langs: [
      import('@shikijs/langs/typescript'),
      import('@shikijs/langs/python'),
      import('@shikijs/langs/json'),
      import('@shikijs/langs/bash'),
    ],
    engine: createJavaScriptRegexEngine(),
  })
  return pending
}

const ALIAS: Record<string, string> = { ts: 'typescript', js: 'typescript', py: 'python', sh: 'bash' }

export async function highlight(code: string, lang: string) {
  const hl = await getHighlighter()
  return hl.codeToHtml(code, { lang: ALIAS[lang] ?? lang, theme: 'github-light' })
}
