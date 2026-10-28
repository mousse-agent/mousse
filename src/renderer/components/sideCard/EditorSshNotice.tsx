import type { EditorSshStatus } from '../../../shared/net/local'

/**
 * The one-time notice after Mousse added its `Include` line to `~/.ssh/config`, with Undo, as Settings, Devices
 * shows it. The side card says it with a toast instead (`EditorSshToast`).
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
