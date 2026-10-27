import { formatBytes } from '../../../shared/storage'
import type { LifecyclePurgeItem } from '../../../shared/resourceLifecycle'
import { summarizeDeletion, type PurgeConfirmation } from '../../lib/trashInventory'
import { Modal } from '../ui/Modal'

const KIND_LABELS: Record<LifecyclePurgeItem['kind'], string> = { worktree: 'Worktree', ref: 'Branch', path: 'Files', 'scheduled-row': 'Scheduled task' }

/**
 * Confirms a permanent deletion. It leads with what is lost, then what it frees; unpublished
 * work needs its own tick before Delete permanently turns on, and a refusal stays on screen
 * with its reason. Focus starts on that tick or on the dialog, never on the delete button.
 */
export function PermanentDeleteDialog({ confirmation, onDiscardChange, onConfirm, onCancel }: {
  confirmation: PurgeConfirmation
  onDiscardChange: (discard: boolean) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const { preview, name, reclaim, discard, submitting, error } = confirmation
  const summary = summarizeDeletion(preview, name, reclaim)
  const blocked = summary.blockers.length > 0
  const items = [...preview.items].sort((a, b) => Number(Boolean(b.discardRequired)) - Number(Boolean(a.discardRequired)))
  return (
    <Modal
      open
      title={`Delete “${name}” permanently`}
      onClose={() => { if (!submitting) onCancel() }}
      className="trash-delete-overlay"
      footer={<>
        <button type="button" className="settings-btn" disabled={submitting} onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="settings-btn danger"
          data-testid="trash-delete-confirm"
          disabled={submitting || blocked || summary.needsDiscard && !discard}
          onClick={onConfirm}
        >Delete permanently</button>
      </>}
    >
      <section className="trash-delete" aria-label="Permanent deletion preview" data-testid="storage-deletion-preview">
        <p className="trash-delete-headline">{summary.headline}</p>
        <p className="trash-delete-frees">{summary.frees}</p>
        {summary.blockers.map((reason) => <p key={reason} className="trash-delete-error" role="alert">Can’t delete: {reason}</p>)}
        {summary.discardWarning && <div className="trash-delete-warning">
          <p>{summary.discardWarning}</p>
          <label className="trash-delete-discard">
            <input type="checkbox" checked={discard} disabled={submitting} onChange={(event) => onDiscardChange(event.target.checked)} />
            <span>Discard the unpublished work and only-copy files listed under Show details.</span>
          </label>
        </div>}
        {error && <p className="trash-delete-error" role="alert" data-testid="trash-delete-error">{error}</p>}
        <details className="trash-delete-details">
          <summary>Show details</summary>
          <ul>
            {items.map((item) => <li key={item.id}>
              <span className="trash-delete-identity">{item.identity}</span>
              <span className="trash-delete-kind">{item.discardRequired ? `${KIND_LABELS[item.kind]} · Unpublished: ${item.reason ?? 'may contain unpublished work'}` : KIND_LABELS[item.kind]}</span>
              {item.discardRequired && item.content?.some((entry) => entry.kind !== 'directory') && <details className="trash-delete-files">
                <summary>Files to discard</summary>
                {item.content.filter((entry) => entry.kind !== 'directory').map((entry) => <div key={entry.path} className="trash-delete-identity">{entry.path} ({formatBytes(entry.bytes)})</div>)}
              </details>}
            </li>)}
            {preview.retained.map((item) => <li key={item.identity}>
              <span className="trash-delete-identity">{item.identity}</span>
              <span className="trash-delete-kind">Kept · {item.reason}</span>
            </li>)}
          </ul>
        </details>
      </section>
    </Modal>
  )
}
