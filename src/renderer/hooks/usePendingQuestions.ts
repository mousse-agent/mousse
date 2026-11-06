import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { PendingUserQuestions } from '../../shared/types'
import { permissionRequestOptions } from '../chat/components/agent-elements/tools/permission-request'

/** Whether `pending` was asked in the thread `threadId` (the blank composer has none). */
function askedIn(pending: PendingUserQuestions, threadId: string | null | undefined): boolean {
  return (pending.threadId || undefined) === (threadId || undefined)
}

/**
 * The open thread's agent questions, for the question card above the composer. Each one is kept with
 * the thread that asked it: a question from another thread is dropped, and switching threads leaves
 * the last thread's question behind (selecting that thread again sends it again). Permission requests
 * are answered inline in the transcript (`usePermissionRequests`), never here.
 */
export function usePendingQuestions(
  threadId: string | null | undefined
): [PendingUserQuestions | null, Dispatch<SetStateAction<PendingUserQuestions | null>>] {
  const [pending, setPending] = useState<PendingUserQuestions | null>(null)

  useEffect(() => {
    setPending(null)
    const orchestrator = window.mousse.orchestrator
    const offPending = orchestrator.onQuestionsPending((payload) => {
      if (permissionRequestOptions(payload)) return
      if (payload.threadId && payload.threadId !== threadId) return
      setPending({ ...payload, threadId: payload.threadId || threadId || undefined })
    })
    const offCleared = orchestrator.onQuestionsCleared((payload) => {
      if (payload.threadId && payload.threadId !== threadId) return
      // The daemon settled this question without this window (answered elsewhere, dismissed, timed
      // out, or rejected by a newer send): drop it so the message it led to is all that waits.
      setPending((current) => (current?.requestId === payload.requestId ? null : current))
    })
    return () => {
      offPending()
      offCleared()
    }
  }, [threadId])

  // Until the reset above runs, the render right after a switch still holds the last thread's question.
  return [pending && askedIn(pending, threadId) ? pending : null, setPending]
}
