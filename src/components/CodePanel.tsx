import { useEffect, useState } from 'react'
import { highlight } from '@/lib/highlight'

/** 运行时高亮：题目里的代码来自 TS 数据而非 MDX，拿不到构建期高亮。 */
export function CodePanel({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    highlight(code.trim(), lang)
      .then((out) => alive && setHtml(out))
      .catch(() => alive && setHtml(null))
    return () => {
      alive = false
    }
  }, [code, lang])

  if (!html) {
    return (
      <div className="codePanel">
        <pre>
          <code>{code.trim()}</code>
        </pre>
      </div>
    )
  }

  return <div className="codePanel numbered" dangerouslySetInnerHTML={{ __html: html }} />
}
