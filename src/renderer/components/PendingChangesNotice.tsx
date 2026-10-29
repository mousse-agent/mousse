import { useState } from 'react'
import type { PendingChangesAction, PendingChangesDetails } from '../../shared/workspace'
import { ipcErrorLine } from '../lib/errorText'

/** What the person confirms before Discard runs. Nothing is discarded without it. */
export function discardPrompt(details: PendingChangesDetails): string {
  const what = details.count === 1 ? '1 changed file' : `${details.count} changed files`
  const operation = details.conflict ? ' The unfinished merge, revert or cherry-pick is ended too.' : ''
  return `Discard ${what} in ${details.path}?${operation} Mousse keeps a copy in Git under refs/mousse/discarded.`
}

/**
 * A refusal about uncommitted changes, with the actions it offers: Save & continue records them as a
 * checkpoint, Discard drops them after asking. Either one then retries what was refused (`onResolved`).
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
  const run = async (action: PendingChangesAction) => {
    if (!details.folder || working) return
    if (action === 'discard' && !window.confirm(discardPrompt(details))) return
    setWorking(true)
    setFailure(null)
    try {
      await window.mousse.workspace.resolvePendingChanges(threadId, { folder: details.folder, action, ...(action === 'discard' ? { confirmed: true } : {}) })
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
      {details.actions.includes('save') && <button type="button" disabled={working} onClick={() => void run('save')}>Save & continue</button>}
      {details.actions.includes('discard') && <button type="button" disabled={working} onClick={() => void run('discard')}>Discard…</button>}
    </div>
  )
}
