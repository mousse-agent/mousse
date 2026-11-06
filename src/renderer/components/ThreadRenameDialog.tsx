import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { create } from 'zustand'
import { useAppStore } from '../stores/appStore'
import { Modal } from './ui/Modal'

/** The thread the rename dialog is open for, or null. Opened by the Rename thread command. */
export const useThreadRenameDialog = create<{ threadId: string | null }>(() => ({ threadId: null }))

export function openThreadRenameDialog(threadId: string): void {
  useThreadRenameDialog.setState({ threadId })
}

const closeDialog = (): void => useThreadRenameDialog.setState({ threadId: null })

/** The new name to save, or null when there is nothing to save (blank or unchanged). */
export function renamedThreadName(draft: string, current: string): string | null {
  const name = draft.trim()
  return name === '' || name === current ? null : name
}

/** Renames a thread from the palette, where its sidebar row may be hidden. Enter saves, Escape closes. */
export function ThreadRenameDialog() {
  const threadId = useThreadRenameDialog((state) => state.threadId)
  const thread = useAppStore((state) => (threadId ? state.threads.find((candidate) => candidate.id === threadId) : undefined))
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const formId = useId()
  const currentName = thread?.name ?? ''

  useEffect(() => {
    if (!threadId) return
    setDraft(currentName)
    setError(null)
    setBusy(false)
    // The dialog focuses the field; select the name so typing replaces it.
    requestAnimationFrame(() => inputRef.current?.select())
    // Only when the dialog opens for a thread, not on every name update while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!threadId) return
    const name = renamedThreadName(draft, currentName)
    if (name === null) {
      closeDialog()
      return
    }
    setBusy(true)
    try {
      await window.mousse.threads.rename(threadId, name)
      closeDialog()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <Modal
      open={threadId !== null && thread !== undefined}
      title="Rename thread"
      onClose={closeDialog}
      className="thread-rename-dialog"
      footer={<button type="submit" form={formId} className="settings-btn" disabled={busy}>Rename</button>}
    >
      <form id={formId} onSubmit={(event) => void submit(event)}>
        <input
          ref={inputRef}
          className="settings-input thread-rename-input"
          aria-label="Thread name"
          value={draft}
          maxLength={200}
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        {error && <p role="alert" className="chat-error">Could not rename · {error}</p>}
      </form>
    </Modal>
  )
}
