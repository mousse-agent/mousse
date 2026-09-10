import { Modal } from '../ui/Modal'

export function UnsavedChangesDialog({
  open,
  onStay,
  onDiscard
}: {
  open: boolean
  onStay: () => void
  onDiscard: () => void
}) {
  return (
    <Modal
      open={open}
      title="Unsaved changes"
      onClose={onStay}
      footer={
        <>
          <button type="button" className="btn" onClick={onStay}>
            Keep editing
          </button>
          <button type="button" className="btn btn-danger" data-action="discard-draft" onClick={onDiscard}>
            Discard changes
          </button>
        </>
      }
    >
      <p>This workflow has unsaved draft changes. Discard them, or stay and review before leaving.</p>
    </Modal>
  )
}

export function DraftConflictDialog({
  open,
  message,
  onReload,
  onKeep
}: {
  open: boolean
  message: string
  onReload: () => void
  onKeep: () => void
}) {
  return (
    <Modal
      open={open}
      title="Draft changed elsewhere"
      onClose={onKeep}
      footer={
        <>
          <button type="button" className="btn" data-action="keep-draft" onClick={onKeep}>
            Keep my edits
          </button>
          <button type="button" className="btn btn-primary" data-action="reload-draft" onClick={onReload}>
            Reload saved draft
          </button>
        </>
      }
    >
      <p>{message}</p>
      <p>Reloading replaces your current editor. Keeping edits does not overwrite the saved draft until you save again.</p>
    </Modal>
  )
}

export function TemplatePickerDialog({
  open,
  templates,
  onClose,
  onSelect
}: {
  open: boolean
  templates: Array<{ id: string; name: string; description: string }>
  onClose: () => void
  onSelect: (id: string) => void
}) {
  return (
    <Modal
      open={open}
      title="New workflow"
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <ul className="wf-template-list">
        {templates.map((template) => (
          <li key={template.id}>
            <button type="button" className="btn" data-template={template.id} onClick={() => onSelect(template.id)}>
              <strong>{template.name}</strong>
              <span>{template.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
