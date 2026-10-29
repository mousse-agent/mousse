import { useEffect, useState } from 'react'
import type { PendingUserQuestions, ThreadActivitySnapshot } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { permissionRequestOptions } from '../chat/components/agent-elements/tools/permission-request'

/** The threads of `pending` that wait for a permission request (not only an agent question). */
export function threadsAwaitingApproval(pending: readonly PendingUserQuestions[]): Set<string> {
  const out = new Set<string>()
  for (const entry of pending) {
    if (entry.threadId && permissionRequestOptions(entry)) out.add(entry.threadId)
  }
  return out
}

function awaitingKey(activity: ThreadActivitySnapshot): string {
  return Object.keys(activity)
    .filter((threadId) => activity[threadId] === 'awaiting_input')
    .sort()
    .join('\n')
}

/**
 * Which threads that wait for the user wait for an approval, so the sidebar can say so instead of
 * "Input". Read again whenever the set of waiting threads changes, or a request is asked or settled.
 */
export function useThreadsAwaitingApproval(): ReadonlySet<string> {
  const key = useAppStore((state) => awaitingKey(state.threadActivity))
  const [threads, setThreads] = useState<ReadonlySet<string>>(() => new Set())
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const orchestrator = window.mousse?.orchestrator
    if (!orchestrator?.onQuestionsPending) return
    const bump = () => setRevision((value) => value + 1)
    const offPending = orchestrator.onQuestionsPending(bump)
    const offCleared = orchestrator.onQuestionsCleared(bump)
    return () => {
      offPending()
      offCleared()
    }
  }, [])

  useEffect(() => {
    const read = window.mousse?.orchestrator?.pendingQuestions
    if (!key) {
      setThreads((current) => (current.size ? new Set() : current))
      return
    }
    if (!read) return
    let live = true
    void read()
      .then((pending) => {
        if (live) setThreads(threadsAwaitingApproval(pending ?? []))
      })
      .catch(() => {
        // An older daemon: waiting threads keep saying "Input".
      })
    return () => {
      live = false
    }
  }, [key, revision])

  return threads
}
