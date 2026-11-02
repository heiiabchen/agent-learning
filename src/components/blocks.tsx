import { useId, useState, type ReactNode } from 'react'
import './blocks.css'

type Tone = 'drill' | 'cursor' | 'python' | 'lab' | 'warn' | 'key'

interface BlockProps {
  tone: Tone
  glyph: string
  label: string
  note?: string
  collapsible?: boolean
  defaultOpen?: boolean
  children: ReactNode
}

function Block({ tone, glyph, label, note, collapsible, defaultOpen = false, children }: BlockProps) {
  const [open, setOpen] = useState(!collapsible || defaultOpen)
  const bodyId = useId()

  return (
    <aside className="block" data-tone={tone} data-open={open}>
      {collapsible ? (
        <button className="blockHead" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={bodyId}>
          <span className="blockGlyph">{glyph}</span>
          <span className="blockLabel">{label}</span>
          {note && <span className="blockNote">{note}</span>}
          <span className="chev">▶</span>
        </button>
      ) : (
        <div className="blockHead">
          <span className="blockGlyph">{glyph}</span>
          <span className="blockLabel">{label}</span>
          {note && <span className="blockNote">{note}</span>}
        </div>
      )}
      {open && (
        <div className="blockBody" id={bodyId}>
          {children}
        </div>
      )}
    </aside>
  )
}

/** 原理下钻：讲当节工程决策背后的模型机制。默认折叠，不阻塞主线阅读。 */
export function Drill({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Block tone="drill" glyph="◈" label="原理下钻" note={title} collapsible>
      {children}
    </Block>
  )
}

/** 把已有的 Cursor 使用直觉接到正确的术语上。 */
export function CursorHook({ children }: { children: ReactNode }) {
  return (
    <Block tone="cursor" glyph="⌘" label="你每天用的 Cursor 里" collapsible defaultOpen>
      {children}
    </Block>
  )
}

/** Python 对照：只读不写，目标是看懂生态里的代码。 */
export function PyMirror({ children }: { children: ReactNode }) {
  return (
    <Block tone="python" glyph="⟐" label="Python 对照" note="只读不写" collapsible>
      {children}
    </Block>
  )
}

/**
 * TypeScript 对照。
 *
 * 和 PyMirror 反着来，只在 L11x 这种"主体是 Python"的选修节里用：
 * 那一节的目的是看懂生态里的 Python 代码，所以要对照的反而是
 * "同一个问题在 TS 里长什么样"。
 */
export function TsMirror({ children }: { children: ReactNode }) {
  return (
    <Block tone="cursor" glyph="⟐" label="TypeScript 对照" note="你熟的那一侧" collapsible>
      {children}
    </Block>
  )
}

/** 实操任务：必须离开网页去 IDE 里真写的部分。 */
export function Lab({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Block tone="lab" glyph="▶" label="动手" note={title}>
      {children}
    </Block>
  )
}

/** 坑：真实项目里会咬人的地方。 */
export function Pitfall({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <Block tone="warn" glyph="⚠" label="坑" note={title}>
      {children}
    </Block>
  )
}

export function Note({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <Block tone="key" glyph="※" label="旁注" note={title}>
      {children}
    </Block>
  )
}

/** 核心论断：整节课如果只记一句话，就是这句。 */
export function Key({ children }: { children: ReactNode }) {
  return <p className="keyIdea">{children}</p>
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="labSteps">{children}</ol>
}
