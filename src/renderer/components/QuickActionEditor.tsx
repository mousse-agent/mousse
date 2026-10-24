import { useCallback, useId, useState } from 'react'
import { FloatingPortal } from '../lib/floatingLayer'
import { validateQuickAction, type QuickAction, type QuickActionKind } from '../lib/quickActions'
import { useAppStore } from '../stores/appStore'
import { useQuickActionsStore, type QuickActionInput } from '../stores/quickActionsStore'
import { refocusActionsSection } from './sideCard/actionsRunLogic'
import { Select } from './ui/Select'
import { Modal } from './ui/Modal'
import './sideCard/actionsSection.css'

const KIND_OPTIONS: { value: QuickActionKind; label: string; hint: string }[] = [
  { value: 'send-current', label: 'Send in current chat', hint: 'Message to send' },
  { value: 'send-new-chat', label: 'Create new chat and send there', hint: 'Message to send' },
  { value: 'bash', label: 'Run bash command', hint: 'Shell command' }
]

const KIND_SELECT_OPTIONS = KIND_OPTIONS.map(({ value, label }) => ({ value, label }))

interface QuickActionEditorProps {
  /** The action to edit, or null to create one. */
  action: QuickAction | null
  onSave: (input: QuickActionInput) => void
  /** Offered only when editing. */
  onDelete?: () => void
  onClose: () => void
}

/**
 * Renders the editor the quick actions store has open. Mounted once at the app root, so
 * the draft survives the side card unmounting (for example when an action opens the app
 * panel). It shows only for the profile it was opened in.
 */
export function QuickActionEditorHost() {
  const editor = useQuickActionsStore((state) => state.editor)
  const profileId = useAppStore((state) => state.profileId)
  const handleClose = useCallback(() => {
    useQuickActionsStore.getState().closeEditor()
    // After the dialog has restored focus itself: if the opener is gone, land in the section.
    requestAnimationFrame(() => refocusActionsSection(document))
  }, [])
  if (!editor || editor.profileId !== profileId) return null
  const editing = editor.target.mode === 'edit' ? editor.target.action : null
  return (
    <QuickActionEditor
      key={`${profileId}:${editing?.id ?? 'new'}`}
      action={editing}
      onSave={(input) => {
        const store = useQuickActionsStore.getState()
        if (editing) store.update(editing.id, input, profileId)
        else store.add(input, profileId)
      }}
      onDelete={editing ? () => useQuickActionsStore.getState().remove(editing.id, profileId) : undefined}
      onClose={handleClose}
    />
  )
}

/** Dialog for creating or editing a quick action. Mount it while open; it starts from `action` each time. */
export function QuickActionEditor(props: QuickActionEditorProps) {
  return (
    <FloatingPortal>
      <QuickActionDialog {...props} />
    </FloatingPortal>
  )
}

/** The editor's markup, in the shared modal, so it looks and behaves like every other dialog. */
export function QuickActionDialog({ action, onSave, onDelete, onClose }: QuickActionEditorProps) {
  const [draftLabel, setDraftLabel] = useState(action?.label ?? '')
  const [draftKind, setDraftKind] = useState<QuickActionKind>(action?.kind ?? 'send-current')
  const [draftPayload, setDraftPayload] = useState(action?.payload ?? '')
  const [editorError, setEditorError] = useState<string | null>(null)
  const kindLabelId = useId()

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
    <Modal
      open
      title={editing ? 'Edit action' : 'Create action'}
      onClose={onClose}
      footer={
        <>
          {editing && onDelete && (
            <button
              type="button"
              className="btn btn-ghost quick-actions-dialog-delete"
              onClick={() => {
                onDelete()
                onClose()
              }}
            >
              Delete
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave}>
            {editing ? 'Save changes' : 'Save action'}
          </button>
        </>
      }
    >
      <div className="quick-actions-form">
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
        <div className="quick-actions-field">
          <span id={kindLabelId}>Type</span>
          <Select
            value={draftKind}
            onChange={setDraftKind}
            options={KIND_SELECT_OPTIONS}
            ariaLabelledBy={kindLabelId}
            className="quick-actions-kind"
          />
        </div>
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
        {editorError && (
          <div className="quick-actions-error" role="alert">
            {editorError}
          </div>
        )}
      </div>
    </Modal>
  )
}
