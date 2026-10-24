import { useRef, useState } from 'react'
import { X } from '../lib/icons'
import { FloatingPortal } from '../lib/floatingLayer'
import { validateQuickAction, type QuickAction, type QuickActionKind } from '../lib/quickActions'
import type { QuickActionInput } from '../stores/quickActionsStore'
import { useDialogFocus } from './ui/Modal'

const KIND_OPTIONS: { value: QuickActionKind; label: string; hint: string }[] = [
  { value: 'send-current', label: 'Send in current chat', hint: 'Message to send' },
  { value: 'send-new-chat', label: 'Create new chat and send there', hint: 'Message to send' },
  { value: 'bash', label: 'Run bash command', hint: 'Shell command' }
]

interface QuickActionEditorProps {
  /** The action to edit, or null to create one. */
  action: QuickAction | null
  onSave: (input: QuickActionInput) => void
  /** Offered only when editing. */
  onDelete?: () => void
  onClose: () => void
}

/** Dialog for creating or editing a quick action. Mount it while open; it starts from `action` each time. */
export function QuickActionEditor(props: QuickActionEditorProps) {
  return (
    <FloatingPortal>
      <QuickActionDialog {...props} />
    </FloatingPortal>
  )
}

/**
 * The editor's markup. Focus starts on the first field, Tab stays inside, Escape closes
 * and focus returns to whatever opened it, as in the shared modal.
 */
export function QuickActionDialog({ action, onSave, onDelete, onClose }: QuickActionEditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, true, onClose)
  const [draftLabel, setDraftLabel] = useState(action?.label ?? '')
  const [draftKind, setDraftKind] = useState<QuickActionKind>(action?.kind ?? 'send-current')
  const [draftPayload, setDraftPayload] = useState(action?.payload ?? '')
  const [editorError, setEditorError] = useState<string | null>(null)

  const editing = action !== null
  const draftHint = KIND_OPTIONS.find((option) => option.value === draftKind)?.hint ?? 'Content'

  const handleSave = () => {
    const error = validateQuickAction({ label: draftLabel, kind: draftKind, payload: draftPayload })
    if (error) {
      setEditorError(error)
      return
    }
    onSave({ label: draftLabel, kind: draftKind, payload: draftPayload })
    onClose()
  }

  return (
    <div className="quick-actions-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="quick-actions-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit action' : 'Create action'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="quick-actions-dialog-heading">
          <h2>{editing ? 'Edit action' : 'Create action'}</h2>
          <button type="button" className="quick-actions-delete" aria-label="Close" onClick={onClose}>
            <X size={14} strokeWidth={2} />
          </button>
        </div>
        <label className="quick-actions-field">
          <span>Name</span>
          <input
            type="text"
            value={draftLabel}
            maxLength={60}
            placeholder="e.g. Commit and push"
            onChange={(event) => setDraftLabel(event.target.value)}
          />
        </label>
        <label className="quick-actions-field">
          <span>Type</span>
          <select value={draftKind} onChange={(event) => setDraftKind(event.target.value as QuickActionKind)}>
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="quick-actions-field">
          <span>{draftHint}</span>
          <textarea
            value={draftPayload}
            rows={4}
            placeholder={
              draftKind === 'bash' ? 'e.g. git status --short' : 'e.g. Commit and push your changes feature wise'
            }
            onChange={(event) => setDraftPayload(event.target.value)}
          />
        </label>
        {editorError && <div className="quick-actions-error">{editorError}</div>}
        <div className="quick-actions-dialog-actions">
          {editing && onDelete && (
            <button
              type="button"
              className="quick-actions-secondary-btn quick-actions-dialog-delete"
              onClick={() => {
                onDelete()
                onClose()
              }}
            >
              Delete
            </button>
          )}
          <button type="button" className="quick-actions-secondary-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="quick-actions-primary-btn" onClick={handleSave}>
            {editing ? 'Save changes' : 'Save action'}
          </button>
        </div>
      </div>
    </div>
  )
}
