import { useEffect, useState } from 'react'
import { retiredWorktreeNote } from '../../lib/storageCopy'

/**
 * "Worktree removed by cleanup on …" while a cleanup rule's retirement of the thread's worktree stands: from opening
 * the thread until the worktree is back, or for as long as it cannot come back. Read with the workspace status, which
 * never restores; read again once the thread's folder has resolved (`settled`), which is when a restore has finished.
 */
export function useRetiredWorktreeNote(threadId: string | null, settled: boolean): string | null {
  const [note, setNote] = useState<{ threadId: string; text: string } | null>(null)
  useEffect(() => {
    if (!threadId) return
    let cancelled = false
    void Promise.resolve()
      .then(() => window.mousse.workspace.getStatus(threadId) as Promise<{ retiredByCleanup?: { at: string } } | null>)
      .then((status) => {
        if (cancelled) return
        const text = status?.retiredByCleanup ? retiredWorktreeNote(status.retiredByCleanup.at) : ''
        setNote(text ? { threadId, text } : null)
      })
      .catch(() => { if (!cancelled) setNote(null) })
    return () => { cancelled = true }
  }, [threadId, settled])
  return note && note.threadId === threadId ? note.text : null
}
