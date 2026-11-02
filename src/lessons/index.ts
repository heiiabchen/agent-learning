import type { ComponentType } from 'react'
import type { QuizSpec } from '@/lib/quiz'

const contentModules = import.meta.glob<{ default: ComponentType }>('./*/content.mdx')
const quizModules = import.meta.glob<{ quiz: QuizSpec }>('./*/quiz.ts')

export function hasContent(lessonId: string) {
  return `./${lessonId}/content.mdx` in contentModules
}

export async function loadLesson(lessonId: string) {
  const contentKey = `./${lessonId}/content.mdx`
  const quizKey = `./${lessonId}/quiz.ts`
  const loadContent = contentModules[contentKey]
  if (!loadContent) throw new Error(`讲义还没写：${contentKey}`)

  const [content, quizMod] = await Promise.all([
    loadContent(),
    quizModules[quizKey] ? quizModules[quizKey]() : Promise.resolve(null),
  ])

  return { Content: content.default, quiz: quizMod?.quiz ?? null }
}
