import { useEffect } from 'react'
import type { EditorSshStatus } from '../../../shared/net/local'
import { useEditorSsh } from '../../lib/editorSsh'
import { FloatingPortal } from '../../lib/floatingLayer'

/** How long the toast stays before it counts as seen. */
export const EDITOR_SSH_TOAST_MS = 8_000

/** "Added Mousse to ~/.ssh/config", with Undo. Shown once, after the first successful open added the line. */
export function EditorSshToastView({
  status,
  busy,
  onUndo,
  onDismiss
}: {
  status: Pick<EditorSshStatus, 'noticePending' | 'userConfig'> | null
  busy?: boolean
  onUndo: () => void
  onDismiss: () => void
}) {
  if (!status?.noticePending) return null
  return (
    <FloatingPortal>
      <div className="editor-ssh-toast" role="status">
        <span>Added Mousse to {status.userConfig || '~/.ssh/config'}</span>
        <button type="button" className="editor-ssh-toast-action" data-action="undo" disabled={busy} onClick={onUndo}>Undo</button>
        <button type="button" className="editor-ssh-toast-action" data-action="dismiss" disabled={busy} aria-label="Dismiss" onClick={onDismiss}>OK</button>
      </div>
    </FloatingPortal>
  )
}

/**
 * The toast, connected to the daemon. Nothing is read until an open went through (`opened`), since only an open
 * adds the line. It goes away by itself, which counts as seen; Settings shows a notice that is still pending.
 */
export function EditorSshToast({ refreshKey, opened }: { refreshKey: number; opened: boolean }) {
  return refreshKey > 0 && opened ? <ConnectedToast refreshKey={refreshKey} /> : null
}

function ConnectedToast({ refreshKey }: { refreshKey: number }) {
  const { status, busy, reload, disable, acknowledge } = useEditorSsh()
  useEffect(() => { if (refreshKey > 1) void reload() }, [refreshKey, reload])
  const pending = !!status?.noticePending
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => void acknowledge(), EDITOR_SSH_TOAST_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])
  return <EditorSshToastView status={status} busy={busy} onUndo={() => void disable()} onDismiss={() => void acknowledge()} />
}
