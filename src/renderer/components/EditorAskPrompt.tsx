import { useEffect } from 'react'
import { EDITOR_ASK_WARNING, editorAskQuestion, type EditorAskView } from '../../shared/bridge/editorAsk'
import { useAppStore } from '../stores/appStore'
import { currentEditorAsk, useEditorAskStore, useEditorAskWatch } from '../stores/editorAskStore'
import { Check } from '../lib/icons'
import { Modal } from './ui/Modal'

export function EditorAskPrompt({
  ask,
  busy,
  error,
  onDecide,
  onClose
}: {
  ask: EditorAskView
  busy: boolean
  error: string
  onDecide: (allow: boolean) => void
  onClose: () => void
}) {
  return (
    <Modal
      open
      className="editor-ask-prompt"
      title={editorAskQuestion(ask.name)}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="settings-btn" data-action="decline-editor-ask" disabled={busy} onClick={() => onDecide(false)}>
            Not now
          </button>
          <button type="button" className="settings-btn" data-action="allow-editor-ask" disabled={busy} onClick={() => onDecide(true)}>
            <Check size={14} className="settings-status-ok" />
            Allow
          </button>
        </>
      }
    >
      {error && <p role="alert" className="chat-error">{error}</p>}
      <p className="editor-ask-warning">{EDITOR_ASK_WARNING}</p>
      <p className="editor-ask-detail">
        {ask.name} signs in to this computer's own SSH server as you for as long as its editor stays connected. You can turn it off any time in Settings, Devices.
      </p>
    </Modal>
  )
}

/**
 * Asks over any screen when another computer wants to open its editor here. Closing without a choice hides
 * the ask until it runs out; Settings → Devices still shows it. The main process shows the desktop notice.
 */
export function EditorAskHost() {
  const profileId = useAppStore((s) => s.profileId)
  useEditorAskWatch(true, profileId)
  const { asks, dismissed, busy, error, errorNode, answer, dismiss, prune } = useEditorAskStore()
  const current = currentEditorAsk({ asks, dismissed })

  // An ask that runs out while the window is idle sends no event here in time, so close it on its own clock.
  useEffect(() => {
    if (!current) return
    const timer = setTimeout(() => prune(), Math.max(0, current.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [current, prune])

  if (!current) return null
  return (
    <EditorAskPrompt
      ask={current}
      busy={busy}
      error={errorNode === current.node ? error : ''}
      onDecide={(allow) => void answer(current.node, allow)}
      onClose={() => dismiss(current.node)}
    />
  )
}
