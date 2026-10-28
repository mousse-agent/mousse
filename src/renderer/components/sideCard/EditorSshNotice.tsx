import { useEffect } from 'react'
import type { EditorSshStatus } from '../../../shared/net/local'
import { useEditorSsh } from '../../lib/editorSsh'

/**
 * The one-time notice after Mousse added its `Include` line to `~/.ssh/config`, with Undo. It shows until
 * the person has seen it; the daemon remembers that across restarts (`net.editor.ssh.ack`).
 */
export function EditorSshNoticeView({
  status,
  busy,
  error,
  onUndo,
  onDismiss
}: {
  status: Pick<EditorSshStatus, 'noticePending' | 'notice'> | null
  busy?: boolean
  error?: string
  onUndo: () => void
  onDismiss: () => void
}) {
  if (!status?.noticePending || !status.notice) return null
  return (
    <div className="side-card-ssh-notice" role="status">
      <p className="side-card-ssh-notice-text">{status.notice}</p>
      <div className="side-card-ssh-notice-actions">
        <button type="button" className="side-card-open-editor-link" disabled={busy} onClick={onUndo}>Undo</button>
        <button type="button" className="side-card-open-editor-link" disabled={busy} onClick={onDismiss}>Got it</button>
      </div>
      {error && <p className="side-card-ssh-notice-error" role="alert">{error}</p>}
    </div>
  )
}

/**
 * The notice, connected to the daemon. Nothing is read until an open has been tried (`refreshKey` counts
 * them), since only an open adds the line; Settings shows a notice that is still pending after a restart.
 */
export function EditorSshNotice({ refreshKey }: { refreshKey: number }) {
  return refreshKey > 0 ? <ConnectedNotice refreshKey={refreshKey} /> : null
}

function ConnectedNotice({ refreshKey }: { refreshKey: number }) {
  const { status, busy, error, reload, disable, acknowledge } = useEditorSsh()
  // The first read happens on mount; later opens read again.
  useEffect(() => { if (refreshKey > 1) void reload() }, [refreshKey, reload])
  return (
    <EditorSshNoticeView
      status={status}
      busy={busy}
      error={error}
      // Undo removes the line, turns the feature off and counts as having seen the notice.
      onUndo={() => void disable()}
      onDismiss={() => void acknowledge()}
    />
  )
}
