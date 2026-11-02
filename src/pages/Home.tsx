import { Link } from 'react-router-dom'
import { kindLabel, lessons, stages } from '@/lib/curriculum'
import type { Lesson } from '@/lib/curriculum'
import { useProgressSnapshot } from '@/lib/progress'
import './Home.css'

const dossier = [
  { k: '起点', v: '前端开发工程师' },
  { k: '终点', v: 'Agent 工程师（能过面试、能接需求）' },
  { k: '周期', v: '约 6 个月 · 每周 2–3 节' },
  { k: '写的语言', v: 'TypeScript' },
  { k: '读的语言', v: 'Python（看懂生态即可）' },
  { k: '模型', v: 'DeepSeek · Anthropic 兼容端点' },
  { k: '贯穿项目', v: 'Mini Coding Agent' },
  { k: '课时', v: `${lessons.length} 节` },
]

function Row({ lesson, done }: { lesson: Lesson; done: boolean }) {
  const planned = lesson.status === 'planned'
  return (
    <Link
      to={`/lesson/${lesson.id}`}
      className="row"
      data-planned={planned}
      data-state={done ? 'done' : 'none'}
    >
      <div className="rowNo numeral">{lesson.num}</div>
      <div>
        <h3 className="rowTitle">{lesson.title}</h3>
        <p className="rowOutcome">{lesson.outcome}</p>
        <div className="chips">
          {lesson.topics.map((t) => (
            <span className="chip" key={t}>
              {t}
            </span>
          ))}
          {lesson.ships && <span className="chip chipShip">交付 · {lesson.ships}</span>}
        </div>
      </div>
      <div className="rowSide">
        {done ? (
          <span className="badge badgeDone">已学完</span>
        ) : lesson.status === 'ready' ? (
          <span className="badge badgeReady">可以开始</span>
        ) : (
          <span className="badge badgePlanned">未完成</span>
        )}
        {lesson.kind !== 'core' && <span className="badge badgeKind">{kindLabel[lesson.kind]}</span>}
        <span className="dur">
          {lesson.minutes[0]}–{lesson.minutes[1]} 分钟
        </span>
      </div>
    </Link>
  )
}

export function Home() {
  const { done } = useProgressSnapshot()
  const firstReady = lessons.find((l) => l.status === 'ready' && !done.has(l.id)) ?? lessons[0]

  return (
    <div className="home">
      <header className="hero">
        <div className="heroEyebrow eyebrow">为你一个人定制 · 2026</div>
        <h1 className="heroTitle">
          从写界面的人,
          <br />
          到<em>造 Agent</em> 的人
        </h1>
        <p className="heroLede">
          这门课不教你调框架。它教你<strong>手写 agent loop</strong>、把上下文当稀缺资源来经营、用 evals
          证明「我这版确实更好」。{lessons.length} 节课累积成同一个能读代码、能改代码的 mini coding
          agent——学完你手里有东西，不是一堆互不相干的 demo。
        </p>

        <div className="dossier">
          {dossier.map((d) => (
            <div className="dossierCell" key={d.k}>
              <div className="dossierKey">{d.k}</div>
              <div className="dossierVal">{d.v}</div>
            </div>
          ))}
        </div>

        <Link className="cta" to={`/lesson/${firstReady.id}`}>
          {done.size > 0 ? '继续' : '从'} {firstReady.num} · {firstReady.title}
          <span className="arrow">→</span>
        </Link>
      </header>

      {stages.map((stage) => (
        <section className="stage" key={stage.id}>
          <div className="stageHead">
            <div className="stageNo numeral">{String(stage.id).padStart(2, '0')}</div>
            <div className="stageMeta">
              <h2>{stage.name}</h2>
              <p>{stage.tagline}</p>
            </div>
          </div>
          {lessons
            .filter((l) => l.stage === stage.id)
            .map((l) => (
              <Row key={l.id} lesson={l} done={done.has(l.id)} />
            ))}
        </section>
      ))}

      <footer className="homeFoot">
        <h3>这门课怎么运作</h3>
        <p>
          每节课的结构固定：网页上读概念、做「原理下钻」，然后去 <code>labs/</code> 里真写代码，回来答题。
          三类题——概念题查漏，改错题看你是否真的读得懂 agent 代码，设计题看架构判断。
        </p>
        <p>
          <strong>答案就附在每道题下面，默认折叠。</strong>
          先自己答一遍再点开对，这一步别省——「看懂了」和「答得出」之间的落差，是唯一能提前发现的东西。设计题没有唯一答案，参考答案给的是判断标准和常见漏项。
        </p>
        <p>
          代码以 TypeScript 为主。每节的实操同时给 <code>.ts</code> 和 <code>.py</code> 两份，跑哪个都行——
          Python 那份不是为了让你转语言，是为了让你读得懂这个生态里绝大多数的开源 agent 代码。
        </p>
      </footer>
    </div>
  )
}
