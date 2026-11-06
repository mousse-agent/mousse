import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { PendingChangesDetails } from '../../shared/workspace'
import { ipcErrorLine } from '../lib/errorText'
import { useComposerNotice } from './ComposerNotice'
import { Modal } from './ui/Modal'

/** What the Discard dialog says: the title names what goes, one line says how to get it back. */
export function discardDialogText(details: PendingChangesDetails): { title: string; line: string } {
  const what = details.count === 1 ? '1 changed file' : `${details.count} changed files`
  const operation = details.operation ? ` The unfinished ${details.operation} ends too.` : ''
  return { title: `Discard ${what}?`, line: `A copy stays in Git while Undo can reach it.${operation}` }
}

/**
 * A conflict Mousse can't work around in the thread worktree, as the composer's notice, with Discard: it drops
 * the changes after the person confirms in a dialog (a copy is kept), then retries what was refused
 * (`onResolved`). Files that changed after Discard was pressed are left as they are; the notice then names
 * them instead, and Discard stays offered.
 */
export function PendingChangesNotice({ threadId, message, details, onResolved, onDismiss }: {
  threadId: string
  message: string
  details: PendingChangesDetails
  onResolved: () => void
  onDismiss?: () => void
}) {
  const [working, setWorking] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [left, setLeft] = useState<string | null>(null)
  const discard = async () => {
    setConfirming(false)
    if (working) return
    setWorking(true)
    setFailure(null)
    setLeft(null)
    try {
      const result = await window.mousse.workspace.discardPendingChanges(threadId)
      if (result?.left) setLeft(result.left)
      else onResolved()
    } catch (cause) {
      setFailure(ipcErrorLine(cause) || String(cause))
    } finally {
      setWorking(false)
    }
  }
  const text = failure ?? left ?? message
  useComposerNotice({
    tone: 'error',
    title: text,
    tooltip: `${text} (${details.path})`,
    ...(details.discard ? { actions: [{ label: 'Discard', title: 'Discard the changes, then try again', disabled: working, busy: working, onClick: () => setConfirming(true) }] } : {}),
    ...(onDismiss ? { onDismiss } : {})
  })
  if (!confirming) return null
  const dialog = discardDialogText(details)
  // In the page root: the composer area must not clip or contain the dialog.
  return createPortal(
    <Modal
      open={confirming}
      className="composer-discard-dialog"
      title={dialog.title}
      onClose={() => setConfirming(false)}
      footer={<>
        <button type="button" className="btn" onClick={() => setConfirming(false)}>Cancel</button>
        <button type="button" className="btn btn-danger" onClick={() => void discard()}>Discard</button>
      </>}
    >
      <p className="settings-muted">{dialog.line}</p>
    </Modal>,
    document.body
  )
}
