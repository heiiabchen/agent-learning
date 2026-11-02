import { useEffect, useState, type ComponentType } from 'react'
import { Link, useParams } from 'react-router-dom'
import { kindLabel, lessonById, neighbors, stages } from '@/lib/curriculum'
import type { QuizSpec } from '@/lib/quiz'
import { markRead, useDone } from '@/lib/progress'
import { hasContent, loadLesson } from '@/lessons'
import { Quiz } from '@/components/Quiz'
import { SectionRail } from '@/components/SectionRail'
import './Lesson.css'

export function LessonPage() {
  const { id = '' } = useParams()
  const lesson = lessonById.get(id)
  const [mod, setMod] = useState<{ Content: ComponentType; quiz: QuizSpec | null } | null>(null)
  const [failed, setFailed] = useState(false)
  const { done, toggle: toggleDone } = useDone(id)

  const ready = Boolean(lesson && lesson.status === 'ready' && hasContent(id))

  useEffect(() => {
    if (!ready) return
    let alive = true
    setMod(null)
    setFailed(false)
    loadLesson(id)
      .then((m) => alive && setMod(m))
      .catch(() => alive && setFailed(true))
    markRead(id)
    return () => {
      alive = false
    }
  }, [id, ready])

  if (!lesson) {
    return (
      <div className="lesson">
        <div className="locked">
          <h3>没有这一节</h3>
          <p>
            课程编号不存在。<Link to="/">回到课程大纲</Link>。
          </p>
        </div>
      </div>
    )
  }

  const stage = stages.find((s) => s.id === lesson.stage)
  const { prev, next } = neighbors(lesson.id)

  return (
    <article className="lesson">
      <header className="lessonHead">
        <div className="ghostNo numeral">{lesson.num}</div>
        <nav className="crumbs">
          <Link to="/">课程大纲</Link>
          <span className="crumbSep">/</span>
          <span className="crumbNow">
            阶段 {lesson.stage} · {stage?.name}
          </span>
          {lesson.kind !== 'core' && (
            <>
              <span className="crumbSep">/</span>
              <span className="crumbNow">{kindLabel[lesson.kind]}</span>
            </>
          )}
        </nav>
        <h1 className="lessonTitle">{lesson.title}</h1>
        <p className="lessonOutcome">{lesson.outcome}</p>
        <div className="lessonMeta">
          <span>
            第 <b>{lesson.num}</b> 节
          </span>
          <span>
            预计 <b>{lesson.minutes[0]}–{lesson.minutes[1]}</b> 分钟
          </span>
          {lesson.ships && (
            <span className="ship">
              本节交付 <b className="ship">{lesson.ships}</b>
            </span>
          )}
        </div>
      </header>

      {!ready ? (
        <div className="locked">
          <h3>这一节还没写</h3>
          <p>大纲已经定了，讲义还在路上。下面是这节要覆盖的内容，可以先看一眼知道它在整门课里占什么位置。</p>
          <div className="lockedTopics">
            <span className="eyebrow">这一节会覆盖</span>
            <ul>
              {lesson.topics.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : failed ? (
        <div className="locked">
          <h3>讲义加载失败</h3>
          <p>看一眼终端里 Vite 的报错，通常是 MDX 语法问题。</p>
        </div>
      ) : !mod ? (
        <div className="loading">载入讲义…</div>
      ) : (
        <div className="lessonBody">
          <div className="lessonMain">
            <div className="prose">
              <mod.Content />
            </div>
            {mod.quiz && <Quiz spec={mod.quiz} />}
            <button className="doneBtn" onClick={toggleDone} data-done={done}>
              <span className="doneBox" aria-hidden="true">
                {done ? '✓' : ''}
              </span>
              {done ? '这一节标为学完了，点一下撤销' : '标记这一节学完'}
            </button>
          </div>
          <SectionRail contentKey={id} />
        </div>
      )}

      <nav className="lessonNav">
        {prev ? (
          <Link to={`/lesson/${prev.id}`} className="navCell prev">
            <span className="eyebrow">← 上一节 · {prev.num}</span>
            <span className="navTitle">{prev.title}</span>
          </Link>
        ) : (
          <span className="navCell prev empty">
            <span className="eyebrow">← 上一节</span>
            <span className="navTitle">这是第一节</span>
          </span>
        )}
        {next ? (
          <Link to={`/lesson/${next.id}`} className="navCell next">
            <span className="eyebrow">下一节 · {next.num} →</span>
            <span className="navTitle">{next.title}</span>
          </Link>
        ) : (
          <span className="navCell next empty">
            <span className="eyebrow">下一节 →</span>
            <span className="navTitle">课程结束</span>
          </span>
        )}
      </nav>
    </article>
  )
}
