import { useCallback, useEffect, useState } from 'react'
import type { AnswerMap } from './quiz'

const DRAFT_KEY = (lessonId: string) => `academy:draft:${lessonId}`
const DONE_KEY = 'academy:done'
const READ_KEY = 'academy:read'

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function writeSet(key: string, set: Set<string>) {
  localStorage.setItem(key, JSON.stringify([...set]))
}

/** 草稿自动存本地，刷新页面不丢答案。纯浏览器，不落任何文件。 */
export function useDraft(lessonId: string) {
  const [answers, setAnswers] = useState<AnswerMap>(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY(lessonId))
      return raw ? (JSON.parse(raw) as AnswerMap) : {}
    } catch {
      return {}
    }
  })

  useEffect(() => {
    localStorage.setItem(DRAFT_KEY(lessonId), JSON.stringify(answers))
  }, [lessonId, answers])

  const setAnswer = useCallback((qid: string, value: string | string[]) => {
    setAnswers((prev) => ({ ...prev, [qid]: value }))
  }, [])

  return { answers, setAnswer }
}

/**
 * 「学完了」是你自己标的，不是系统猜的。
 * 自动按「打开过」算完成会让进度条撒谎——扫一眼和学完了是两件事。
 */
export function useDone(lessonId: string) {
  const [done, setDone] = useState(() => readSet(DONE_KEY).has(lessonId))

  useEffect(() => {
    setDone(readSet(DONE_KEY).has(lessonId))
  }, [lessonId])

  const toggle = useCallback(() => {
    const set = readSet(DONE_KEY)
    const next = !set.has(lessonId)
    if (next) set.add(lessonId)
    else set.delete(lessonId)
    writeSet(DONE_KEY, set)
    setDone(next)
    window.dispatchEvent(new Event('academy:progress'))
  }, [lessonId])

  return { done, toggle }
}

export function useProgressSnapshot() {
  const [snapshot, setSnapshot] = useState(() => ({
    done: readSet(DONE_KEY),
    read: readSet(READ_KEY),
  }))

  useEffect(() => {
    const refresh = () => setSnapshot({ done: readSet(DONE_KEY), read: readSet(READ_KEY) })
    window.addEventListener('academy:progress', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('academy:progress', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  return snapshot
}

export function markRead(lessonId: string) {
  const set = readSet(READ_KEY)
  if (set.has(lessonId)) return
  set.add(lessonId)
  writeSet(READ_KEY, set)
  window.dispatchEvent(new Event('academy:progress'))
}
