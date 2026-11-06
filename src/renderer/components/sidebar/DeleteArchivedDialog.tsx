import { deleteDialogCopy, type DeleteRequest } from '../../lib/archivedThreads'
import { Modal } from '../ui/Modal'

/**
 * Confirms a permanent delete of archived threads. Focus starts on the dialog, never on Delete, so a stray Enter
 * does nothing; Escape, Cancel and a click outside delete nothing. A refusal stays on screen with its reason.
 */
export function DeleteArchivedDialog({ request, busy, error, onConfirm, onCancel }: {
  request: DeleteRequest
  busy: boolean
  error?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const copy = deleteDialogCopy(request)
  return (
    <Modal
      open
      title={copy.title}
      className="archived-delete-dialog"
      closeDisabled={busy}
      onClose={() => { if (!busy) onCancel() }}
      footer={<>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-danger" data-testid="archived-delete-confirm" disabled={busy} onClick={onConfirm}>
          {busy ? 'Deleting…' : copy.confirm}
        </button>
      </>}
    >
      <p className="archived-delete-body">{copy.body}</p>
      {error && <p className="archived-delete-error" role="alert" data-testid="archived-delete-error">{error}</p>}
    </Modal>
  )
}
