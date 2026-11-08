import { useEffect, useRef } from 'react'
import { Modal } from '../ui/Modal'
import { AUTOSAVE_DELAY_MS, fixIssuesLabel, publishImpactLine, SAVE_STATE_LABELS, type DefinitionSaveState } from './editorState'
import './automations.css'

/** The draft's state next to the editor title. `data-editor-status` is what scripted checks read. */
export function SaveStateLabel({ state, extra }: { state: DefinitionSaveState; extra?: string | null }) {
  return (
    <span className="automation-save-state" data-editor-status="" data-state={state}>
      {SAVE_STATE_LABELS[state]}
      {extra ? <span className="automation-save-state__extra"> · {extra}</span> : null}
    </span>
  )
}

/** Shown while blocking issues keep Publish disabled: names the count, and takes you to the first one. */
export function FixIssuesLink({ id, issues, onShow }: { id?: string; issues: readonly { message: string }[]; onShow: () => void }) {
  if (issues.length === 0) return null
  return (
    <button type="button" id={id} className="automation-issue-link" data-action="show-blocking-issue" title={issues[0].message} onClick={onShow}>
      {fixIssuesLabel(issues.length)}
    </button>
  )
}

/**
 * Archive always asks, even for a clean draft. Focus starts on the dialog, not on Archive, and
 * Escape or Cancel leaves the definition as it was.
 */
export function ArchiveDefinitionDialog({
  open,
  kind,
  name,
  dirty,
  onCancel,
  onConfirm
}: {
  open: boolean
  kind: 'agent' | 'workflow'
  name: string
  dirty: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const library = kind === 'agent' ? 'Agents' : 'Workflows'
  return (
    <Modal
      open={open}
      title={`Archive “${name}”?`}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" data-action="cancel-archive" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" data-action="confirm-archive" onClick={onConfirm}>
            Archive
          </button>
        </>
      }
    >
      <p>
        It leaves the {library} library.
        {dirty ? ' Your unsaved edits are discarded.' : ''}
      </p>
    </Modal>
  )
}

/**
 * Autosave: an edit saves itself once typing pauses. `save` resolves false when it failed; that draft is not tried again
 * by itself (the editor shows the error with Retry), and the next edit tries again.
 */
export function useAutosave<T>(draft: T, { dirty, canSave, save }: { dirty: boolean; canSave: boolean; save: () => Promise<boolean> }): void {
  const failed = useRef<T | null>(null)
  const latest = useRef(save)
  latest.current = save
  useEffect(() => {
    if (!dirty || !canSave || failed.current === draft) return
    const handle = window.setTimeout(() => {
      void latest.current().then((ok) => { failed.current = ok ? null : draft })
    }, AUTOSAVE_DELAY_MS)
    return () => window.clearTimeout(handle)
  }, [draft, dirty, canSave])
}

/** A save that failed: said plainly, with Retry. */
export function SaveFailed({ message, busy, onRetry }: { message: string; busy?: boolean; onRetry: () => void }) {
  return (
    <div className="automation-save-failed" role="alert" data-testid="editor-save-error">
      <span>{`Not saved: ${message}`}</span>
      <button type="button" className="btn btn-sm" data-action="retry-save" disabled={busy} onClick={onRetry}>Retry</button>
    </div>
  )
}

/** One automation that uses what is being published. */
export interface PublishUser { id: string; name: string }

/**
 * Before publishing a saved agent or workflow that automations use: "Used by N automations · they get this on their
 * next run", with the list. Publish goes ahead; Cancel leaves it unpublished.
 */
export function PublishImpactDialog({ users, onCancel, onPublish }: { users: readonly PublishUser[]; onCancel: () => void; onPublish: () => void }) {
  return (
    <Modal
      open
      title="Publish?"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" data-action="confirm-publish" onClick={onPublish}>Publish</button>
        </>
      }
    >
      <div data-testid="publish-impact">
        <p>{publishImpactLine(users.length)}</p>
        <ul className="publish-impact-list">
          {users.map((user) => <li key={user.id}>{user.name}</li>)}
        </ul>
      </div>
    </Modal>
  )
}
