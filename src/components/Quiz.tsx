import { useMemo, useState } from 'react'
import { gradeChoice, kindMeta } from '@/lib/quiz'
import type { AnswerMap, ChoiceQuestion, Question, QuizSpec } from '@/lib/quiz'
import { useDraft } from '@/lib/progress'
import { CodePanel } from './CodePanel'
import { RichBlock, RichText } from './RichText'
import './Quiz.css'

function optVerdict(q: ChoiceQuestion, optId: string, picked: string[]) {
  const isCorrect = q.correct.includes(optId)
  const isPicked = picked.includes(optId)
  if (isPicked && isCorrect) return 'hit'
  if (isPicked && !isCorrect) return 'miss'
  if (!isPicked && isCorrect) return 'missed-right'
  return undefined
}

const verdictText = {
  hit: '✓ 选对了',
  miss: '✕ 这个不对',
  'missed-right': '↑ 这个才对',
} as const

function Choice({
  q,
  value,
  onChange,
  revealed,
}: {
  q: ChoiceQuestion
  value: string | string[] | undefined
  onChange: (v: string | string[]) => void
  revealed: boolean
}) {
  const picked = Array.isArray(value) ? value : value ? [value] : []

  const toggle = (optId: string) => {
    if (!q.multi) return onChange(optId)
    onChange(picked.includes(optId) ? picked.filter((p) => p !== optId) : [...picked, optId])
  }

  return (
    <div className="opts">
      {q.options.map((o) => {
        // 展开答案之后才显示对错，这样想自测的时候忍得住
        const verdict = revealed ? optVerdict(q, o.id, picked) : undefined
        return (
          <label className="opt" key={o.id} data-picked={picked.includes(o.id)} data-verdict={verdict}>
            <input
              type={q.multi ? 'checkbox' : 'radio'}
              name={q.id}
              checked={picked.includes(o.id)}
              onChange={() => toggle(o.id)}
            />
            <span className="optLabel">
              <RichText text={o.label} />
            </span>
            {verdict && <span className="optTag">{verdictText[verdict]}</span>}
          </label>
        )
      })}
    </div>
  )
}

function QuestionCard({
  q,
  index,
  answers,
  setAnswer,
  revealed,
  onToggle,
}: {
  q: Question
  index: number
  answers: AnswerMap
  setAnswer: (id: string, v: string | string[]) => void
  revealed: boolean
  onToggle: () => void
}) {
  const meta = kindMeta[q.kind]
  const text = typeof answers[q.id] === 'string' ? (answers[q.id] as string) : ''
  const verdict = q.kind === 'choice' ? gradeChoice(q, answers[q.id]) : null

  return (
    <section className="q" data-kind={q.kind}>
      <div className="qTop">
        <span className="qIdx">{String(index + 1).padStart(2, '0')}</span>
        <span className="qKind">{meta.label}</span>
        <span className="qHint">{meta.hint}</span>
      </div>

      <p className="qPrompt">
        <RichText text={q.prompt} />
      </p>

      {q.kind === 'design' && q.scenario && <div className="qScenario">{q.scenario.trim()}</div>}
      {q.kind === 'debug' && <CodePanel code={q.code} lang={q.lang} />}

      {q.kind === 'choice' ? (
        <Choice q={q} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} revealed={revealed} />
      ) : (
        <div className="answerArea">
          <textarea
            value={text}
            onChange={(e) => setAnswer(q.id, e.target.value)}
            placeholder={
              q.kind === 'debug'
                ? '指出有问题的行，说明它为什么错，以及你会怎么改。'
                : '先给结论，再说理由和你放弃的方案。字数不重要，判断和取舍才重要。'
            }
            spellCheck={false}
          />
          <span className="charCount">{text.trim().length} 字</span>
        </div>
      )}

      <button className="revealToggle" onClick={onToggle} aria-expanded={revealed} data-open={revealed}>
        <span className="chev" aria-hidden="true">
          ▶
        </span>
        <span>{revealed ? '收起答案' : q.kind === 'choice' ? '看答案与解析' : '看参考答案'}</span>
        {revealed && verdict?.answered && (
          <span className={`tick ${verdict.correct ? 'ok' : 'no'}`}>
            {verdict.correct ? '你答对了' : '你答错了'}
          </span>
        )}
      </button>

      {revealed && (
        <div className="reveal">
          <div className="revealHead">{q.kind === 'choice' ? '为什么' : '参考答案'}</div>
          <div className="revealBody">
            <RichBlock text={q.kind === 'choice' ? q.explain : q.reference} />
            {q.kind !== 'choice' && q.rubric && q.rubric.length > 0 && (
              <div className="rubric">
                <div className="rubricTitle">自查清单</div>
                <ul>
                  {q.rubric.map((r) => (
                    <li key={r}>
                      <RichText text={r} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

export function Quiz({ spec, intro }: { spec: QuizSpec; intro?: string }) {
  const { answers, setAnswer } = useDraft(spec.lessonId)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())

  const counts = useMemo(() => {
    const byKind = { choice: 0, debug: 0, design: 0 }
    for (const q of spec.questions) byKind[q.kind]++
    return byKind
  }, [spec])

  const allOpen = open.size === spec.questions.length

  const toggleOne = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const toggleAll = () => setOpen(allOpen ? new Set() : new Set(spec.questions.map((q) => q.id)))

  return (
    <div className="quiz">
      <div className="quizHead">
        <div>
          <div className="eyebrow">本节自测</div>
          <h2 className="quizTitle">{spec.questions.length} 道题，答案就在题目下面</h2>
        </div>
        <button className="ghostBtn" onClick={toggleAll}>
          {allOpen ? '全部收起' : '全部展开'}
        </button>
      </div>
      <p className="quizIntro">
        {intro ??
          `${counts.choice} 道概念题查漏，${counts.debug} 道改错题看你是否真的读得懂 agent 代码，${counts.design} 道设计题看架构判断。答案默认折叠，先自己答一遍再点开对——直接看也行，但那样这些题就只剩阅读价值了。设计题没有唯一答案，参考答案给的是判断标准和常见漏项。`}
      </p>

      {spec.questions.map((q, i) => (
        <QuestionCard
          key={q.id}
          q={q}
          index={i}
          answers={answers}
          setAnswer={setAnswer}
          revealed={open.has(q.id)}
          onToggle={() => toggleOne(q.id)}
        />
      ))}
    </div>
  )
}
