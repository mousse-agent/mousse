import { useState } from 'react'
import type { PendingChangesDetails } from '../../shared/workspace'
import { ipcErrorLine } from '../lib/errorText'

/** What the person confirms before Discard runs. Nothing is discarded without it. */
export function discardPrompt(details: PendingChangesDetails): string {
  const what = details.count === 1 ? '1 changed file' : `${details.count} changed files`
  const operation = details.operation ? ` The unfinished ${details.operation} is ended too.` : ''
  return `Discard ${what} in ${details.path}?${operation} Mousse keeps a copy in Git under refs/mousse/discarded.`
}

/**
 * A conflict Mousse can't work around in the thread worktree, with Discard: it drops the changes after asking
 * (a copy is kept), then retries what was refused (`onResolved`).
 */
export function PendingChangesNotice({ threadId, message, details, onResolved, className }: {
  threadId: string
  message: string
  details: PendingChangesDetails
  onResolved: () => void
  className?: string
}) {
  const [working, setWorking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const discard = async () => {
    if (working || !window.confirm(discardPrompt(details))) return
    setWorking(true)
    setFailure(null)
    try {
      await window.mousse.workspace.discardPendingChanges(threadId)
      onResolved()
    } catch (cause) {
      setFailure(ipcErrorLine(cause) || String(cause))
    } finally {
      setWorking(false)
    }
  }
  return (
    <div className={className} role="alert">
      <span>{failure ?? message}</span>
      {details.discard && <button type="button" disabled={working} onClick={() => void discard()}>Discard</button>}
    </div>
  )
}
