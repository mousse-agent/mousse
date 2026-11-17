import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { PendingUserQuestions } from '../../shared/types'
import { permissionRequestOptions } from '../chat/components/agent-elements/tools/permission-request'

/** Whether `pending` was asked in the thread `threadId` (the blank composer has none). */
function askedIn(pending: PendingUserQuestions, threadId: string | null | undefined): boolean {
  return (pending.threadId || undefined) === (threadId || undefined)
}

/**
 * The question the card shows: the first one the agent waits on, else the oldest asked without waiting (the agent
 * keeps working while that is open).
 */
export function shownQuestion(list: readonly PendingUserQuestions[]): PendingUserQuestions | null {
  return list.find((entry) => entry.wait !== false) ?? list[0] ?? null
}

/**
 * The open thread's agent questions, for the question card above the composer. Several can be open at once (an agent
 * that asks without waiting may ask again): the card shows one (`shownQuestion`), and the next once it is answered.
 * Each is kept with the thread that asked it: a question from another thread is dropped, and switching threads leaves
 * the last thread's questions behind (selecting that thread again sends them again). Permission requests are answered
 * inline in the transcript (`usePermissionRequests`), never here.
 *
 * The setter acts on the shown question: `null` removes it (the next one shows), another value replaces it.
 */
export function usePendingQuestions(
  threadId: string | null | undefined
): [PendingUserQuestions | null, Dispatch<SetStateAction<PendingUserQuestions | null>>] {
  const [list, setList] = useState<PendingUserQuestions[]>([])

  useEffect(() => {
    setList([])
    const orchestrator = window.mousse.orchestrator
    const offPending = orchestrator.onQuestionsPending((payload) => {
      if (permissionRequestOptions(payload)) return
      if (payload.threadId && payload.threadId !== threadId) return
      const entry = { ...payload, threadId: payload.threadId || threadId || undefined }
      setList((current) => {
        const at = current.findIndex((each) => each.requestId === entry.requestId)
        return at === -1 ? [...current, entry] : current.map((each, index) => (index === at ? entry : each))
      })
    })
    const offCleared = orchestrator.onQuestionsCleared((payload) => {
      if (payload.threadId && payload.threadId !== threadId) return
      // The daemon settled this question without this window (answered elsewhere, dismissed, withdrawn, timed out, or
      // rejected by a newer send): drop it so the message it led to is all that waits.
      setList((current) => current.filter((each) => each.requestId !== payload.requestId))
    })
    return () => {
      offPending()
      offCleared()
    }
  }, [threadId])

  const setShown = useCallback<Dispatch<SetStateAction<PendingUserQuestions | null>>>((action) => {
    setList((current) => {
      const shown = shownQuestion(current)
      const next = typeof action === 'function' ? action(shown) : action
      if (next === shown) return current
      const others = shown ? current.filter((each) => each.requestId !== shown.requestId) : current
      return next ? [next, ...others.filter((each) => each.requestId !== next.requestId)] : others
    })
  }, [])

  // Until the reset above runs, the render right after a switch still holds the last thread's questions.
  const shown = shownQuestion(list.filter((entry) => askedIn(entry, threadId)))
  return [shown, setShown]
}
