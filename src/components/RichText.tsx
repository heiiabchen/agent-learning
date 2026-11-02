import { Fragment, type ReactNode } from 'react'

/**
 * 题目和解析里的行内 markdown。只支持两种记号：`**加粗**` 和 `` `代码` ``。
 *
 * 为什么不直接上 markdown 库：这里要渲染的是**片段**，不是文档。
 * 完整的 markdown 解析器会把单独一行的文本包进 <p>、把数字开头的行变成列表，
 * 在选项标签这种场景里全是麻烦。这里需要的只是行内替换。
 *
 * 不用 dangerouslySetInnerHTML——题目文本里有反引号包着的代码片段，
 * 里面出现 < 和 > 是常事。走 React 节点，转义的事交给 React。
 */

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`)/g

/**
 * allowBold 为 false 时是「加粗内部」那一层，此时只认行内代码。
 * 加粗里包代码很常见（`**别忘了 `await`**`），所以要往下走一层；
 * 而加粗里再包加粗没有意义，用这个开关掐掉递归。
 */
function inline(text: string, allowBold: boolean): ReactNode[] {
  return text.split(TOKEN).map((part, i) => {
    if (!part) return null
    const key = `${i}-${part.slice(0, 8)}`
    if (allowBold && part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{inline(part.slice(2, -2), false)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={key}>{part.slice(1, -1)}</code>
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

export function RichText({ text }: { text: string }) {
  return <>{inline(text, true)}</>
}

/**
 * 多行文本：段落之间留空行，段内的行内记号照样生效。
 *
 * 除了行内记号，这里还认四种块级结构。它们不是为了「支持 markdown」，
 * 而是因为解析里真的会用到，而且**用纯文本表达它们的效果明显更差**：
 *
 *   ---          分隔线。长解析里靠它切「正解」和「看错项」两段
 *   | a | b |    表格。对照两种做法的时候，表格比几段散文清楚得多
 *   缩进四格      代码/示意图。等宽字体是它能读懂的前提
 *   - / 1.       列表
 *
 * 仍然不上 markdown 库：这里的输入是**受控的**（课程自己写的解析文本），
 * 不需要处理任意用户输入，也不需要嵌套。多引一个解析器的收益抵不过体积。
 */

type Block =
  | { kind: 'hr' }
  | { kind: 'code'; lines: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'para'; lines: string[] }

const isRule = (lines: string[]) => lines.length === 1 && /^-{3,}$/.test(lines[0]!.trim())
const isCode = (lines: string[]) => lines.every((l) => l.startsWith('    ') || l.trim() === '')
const isTable = (lines: string[]) =>
  lines.length >= 2 && lines[0]!.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[1]!.trim())
/** 长解析里用 `## 小标题` 分段。判 isCode 之后才轮到它，所以缩进的 # 仍然是代码。 */
const isHeading = (lines: string[]) => lines.length === 1 && /^#{1,6}\s+\S/.test(lines[0]!)
/** 引原始文档用。这一节的解析里引文很多，而印成普通段落会分不清哪句是原话。 */
const isQuote = (lines: string[]) => lines.every((l) => /^>\s?/.test(l))

/** `| a | b |` → `['a', 'b']`。首尾的空串是分隔符本身产生的，切掉。 */
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

function parse(text: string): Block[] {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((chunk): Block => {
      const lines = chunk.split('\n')
      if (isRule(lines)) return { kind: 'hr' }
      if (isCode(lines)) return { kind: 'code', lines: lines.map((l) => l.slice(4)) }
      if (isHeading(lines)) return { kind: 'heading', text: lines[0]!.replace(/^#{1,6}\s+/, '') }
      if (isQuote(lines)) return { kind: 'quote', lines: lines.map((l) => l.replace(/^>\s?/, '')) }
      if (isTable(lines)) {
        return {
          kind: 'table',
          head: cells(lines[0]!),
          rows: lines.slice(2).map(cells),
        }
      }
      const ordered = lines.every((l) => /^\d+\.\s/.test(l))
      if (ordered || lines.every((l) => /^[-·]\s/.test(l))) {
        return {
          kind: 'list',
          ordered,
          items: lines.map((l) => l.replace(/^(?:\d+\.|[-·])\s+/, '')),
        }
      }
      return { kind: 'para', lines }
    })
}

/** 段内换行保留成 <br>——解析里的手工排版（对齐的示意图、分行的判据）靠它。 */
function multiline(lines: string[]): ReactNode[] {
  return lines.map((line, j) => (
    <Fragment key={j}>
      {j > 0 && <br />}
      <RichText text={line} />
    </Fragment>
  ))
}

export function RichBlock({ text }: { text: string }): ReactNode {
  return (
    <>
      {parse(text).map((b, i) => {
        const key = `${i}-${b.kind}`
        switch (b.kind) {
          case 'hr':
            return <hr key={key} />
          case 'code':
            return <pre key={key}>{b.lines.join('\n')}</pre>
          case 'table':
            return (
              <table key={key}>
                <thead>
                  <tr>
                    {b.head.map((c, j) => (
                      <th key={j}>
                        <RichText text={c} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, j) => (
                    <tr key={j}>
                      {row.map((c, k) => (
                        <td key={k}>
                          <RichText text={c} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          case 'heading':
            return (
              <h4 key={key}>
                <RichText text={b.text} />
              </h4>
            )
          case 'quote':
            return (
              <blockquote key={key}>
                <p>{multiline(b.lines)}</p>
              </blockquote>
            )
          case 'list': {
            const items = b.items.map((it, j) => (
              <li key={j}>
                <RichText text={it} />
              </li>
            ))
            return b.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>
          }
          default:
            return <p key={key}>{multiline(b.lines)}</p>
        }
      })}
    </>
  )
}
