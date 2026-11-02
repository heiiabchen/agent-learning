import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { lessons, stages } from '@/lib/curriculum'
import { useProgressSnapshot } from '@/lib/progress'
import './AppShell.css'

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  const { done: doneSet, read } = useProgressSnapshot()

  useEffect(() => {
    setOpen(false)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [pathname])

  const done = doneSet.size
  const pct = Math.round((done / lessons.length) * 100)

  return (
    <div className="shell">
      <button className="railToggle" onClick={() => setOpen((v) => !v)}>
        {open ? '✕ 关闭' : '☰ 目录'}
      </button>

      <nav className="rail" data-open={open}>
        <div className="railHead">
          <Link to="/" className="mark">
            <h1 className="markTitle">
              Agent <em>学院</em>
            </h1>
            <div className="markSub">前端 → Agent 工程师</div>
          </Link>
          <div className="meter" title={`已学完 ${done} / ${lessons.length} 节`}>
            <div className="meterTrack">
              <div className="meterFill" style={{ width: `${pct}%` }} />
            </div>
            <span className="meterNum">
              {String(done).padStart(2, '0')}/{lessons.length}
            </span>
          </div>
        </div>

        <div className="railScroll">
          {stages.map((stage) => (
            <div className="stageBlock" key={stage.id}>
              <div className="stageName">{stage.name}</div>
              {lessons
                .filter((l) => l.stage === stage.id)
                .map((l) => (
                  <NavLink
                    key={l.id}
                    to={`/lesson/${l.id}`}
                    className="node"
                    data-kind={l.kind}
                    data-planned={l.status === 'planned'}
                    data-state={doneSet.has(l.id) ? 'done' : read.has(l.id) ? 'read' : 'none'}
                    data-active={pathname === `/lesson/${l.id}`}
                  >
                    <span className="nodeNum numeral">{l.num}</span>
                    <span className="nodeTitle">{l.title}</span>
                  </NavLink>
                ))}
            </div>
          ))}
        </div>
      </nav>

      <main className="main">{children}</main>
    </div>
  )
}
