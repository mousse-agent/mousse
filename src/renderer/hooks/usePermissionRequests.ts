import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import type { PendingUserQuestions, QuestionAnswerOutcome, ThreadApprovalRequest } from '../../shared/types'
import {
  permissionRequestOptions,
  withPermissionRequests,
  type LocalPermissionAnswer,
  type PermissionRequestControls
} from '../chat/components/agent-elements/tools/permission-request'
import { questionAnswerThreadId } from '../chat/components/agent-elements/tools/quick-action-approval'

/** The decision and scope the option `optionId` of a waiting request means. */
function answerOf(pending: PendingUserQuestions, optionId: string): LocalPermissionAnswer {
  const option = pending.questions[0]?.options.find((candidate) => candidate.id === optionId)
  return { decision: option?.decision === 'allow' ? 'allow' : 'reject', ...(option?.scope ? { scope: option.scope } : {}) }
}

/**
 * The open thread's permission requests (#416): the saved ones with the answers they got, and the
 * waiting ones this window can answer inline. A waiting request comes from the same events the
 * question dialog listens to; the saved list is read again whenever one is asked or settled.
 */
export function usePermissionRequests(
  threadId: string | null | undefined,
  onRefused: (text: string) => void,
  describe: (outcome: QuestionAnswerOutcome | undefined) => string | null
): {
  controls: Readonly<Record<string, PermissionRequestControls>>
  waiting: boolean
  place: (messages: UIMessage[]) => UIMessage[]
} {
  const [waiting, setWaiting] = useState<PendingUserQuestions[]>([])
  const [saved, setSaved] = useState<ThreadApprovalRequest[]>([])
  const [answered, setAnswered] = useState<Record<string, LocalPermissionAnswer>>({})
  const threadRef = useRef(threadId)
  threadRef.current = threadId
  const onRefusedRef = useRef(onRefused)
  onRefusedRef.current = onRefused

  const refresh = useCallback(() => {
    const id = threadRef.current
    const read = window.mousse?.orchestrator?.approvalRequests
    if (!id || !read) return
    void read(id)
      .then((requests) => {
        if (threadRef.current === id) setSaved(requests ?? [])
      })
      .catch(() => {
        // An older daemon, or a thread it cannot read: the waiting requests still show.
      })
  }, [])

  useEffect(() => {
    setWaiting([])
    setSaved([])
    setAnswered({})
    refresh()
    const orchestrator = window.mousse?.orchestrator
    if (!orchestrator) return
    const offPending = orchestrator.onQuestionsPending((payload) => {
      if (payload.threadId && payload.threadId !== threadId) return
      if (!permissionRequestOptions(payload)) return
      setWaiting((current) => [...current.filter((entry) => entry.requestId !== payload.requestId), payload])
      refresh()
    })
    const offCleared = orchestrator.onQuestionsCleared((payload) => {
      if (payload.threadId && payload.threadId !== threadId) return
      setWaiting((current) => current.filter((entry) => entry.requestId !== payload.requestId))
      refresh()
    })
    return () => {
      offPending()
      offCleared()
    }
  }, [threadId, refresh])

  const answer = useCallback(
    (pending: PendingUserQuestions, optionId: string) => {
      const question = pending.questions[0]
      if (!question) return
      const target = questionAnswerThreadId(pending, threadRef.current)
      void window.mousse.orchestrator
        .answerQuestionsDetailed(pending.requestId, { [question.id]: optionId }, target)
        .then((outcome) => {
          // Taken, or no longer waiting (answered elsewhere, closed): either way it is not answerable here any more.
          if (outcome?.ok) setAnswered((current) => ({ ...current, [pending.requestId]: answerOf(pending, optionId) }))
          setWaiting((current) => current.filter((entry) => entry.requestId !== pending.requestId))
          const refusal = describe(outcome)
          if (refusal) onRefusedRef.current(refusal)
          refresh()
        })
        .catch(() => {
          // The answer did not reach the daemon: the request stays answerable.
        })
    },
    [describe, refresh]
  )

  const controls = useMemo(() => {
    const out: Record<string, PermissionRequestControls> = {}
    for (const pending of waiting) {
      const options = permissionRequestOptions(pending)
      if (!options || answered[pending.requestId]) continue
      out[pending.requestId] = {
        options,
        ...(pending.approval ? { approval: pending.approval } : {}),
        onAnswer: (optionId) => answer(pending, optionId)
      }
    }
    return out
  }, [waiting, answered, answer])

  const place = useCallback(
    (messages: UIMessage[]) => withPermissionRequests(messages, saved, waiting, answered),
    [saved, waiting, answered]
  )

  return { controls, waiting: Object.keys(controls).length > 0, place }
}
