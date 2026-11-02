export interface ChoiceQuestion {
  id: string
  kind: 'choice'
  /** 多选题。多选时必须全对才算对，这是故意的。 */
  multi?: boolean
  prompt: string
  options: { id: string; label: string }[]
  correct: string[]
  explain: string
}

export interface DebugQuestion {
  id: string
  kind: 'debug'
  prompt: string
  lang: string
  code: string
  reference: string
  /** 自查清单：对着这几条看自己的答案，比对着标准答案逐字比更有用。 */
  rubric?: string[]
}

export interface DesignQuestion {
  id: string
  kind: 'design'
  prompt: string
  scenario?: string
  reference: string
  rubric?: string[]
}

export type Question = ChoiceQuestion | DebugQuestion | DesignQuestion

export interface QuizSpec {
  lessonId: string
  questions: Question[]
}

export type AnswerMap = Record<string, string | string[]>

export const kindMeta: Record<Question['kind'], { label: string; hint: string }> = {
  choice: { label: '概念题', hint: '选完再点开答案，对一下' },
  debug: { label: '改错题', hint: '先自己找一遍，找完再看' },
  design: { label: '设计题', hint: '开放题，参考答案给的是判断标准' },
}

/** 概念题判分。多选必须完全一致——半对不算对，因为漏掉的那个往往正是关键。 */
export function gradeChoice(q: ChoiceQuestion, answer: string | string[] | undefined) {
  const picked = Array.isArray(answer) ? [...answer].sort() : answer ? [answer] : []
  const want = [...q.correct].sort()
  return {
    answered: picked.length > 0,
    correct: picked.length === want.length && picked.every((v, i) => v === want[i]),
  }
}
