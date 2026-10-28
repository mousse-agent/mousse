import { useState } from 'react'
import { hydrateMessageImages } from '../lib/messageImages'
import { ipcErrorLine } from '../lib/errorText'
import { useAppStore } from '../stores/appStore'
import '../styles/computers.css'

interface EarlierMessagesBarViewProps {
  count: number
  busy: boolean
  error?: string
  onLoad: () => void
}

/**
 * Above the transcript of a long thread of another computer, which arrives as its newest part: says how
 * many older messages are left and loads them on request.
 */
export function EarlierMessagesBarView({ count, busy, error, onLoad }: EarlierMessagesBarViewProps) {
  return (
    <div className="earlier-messages-bar">
      <span>{count === 1 ? '1 earlier message is not loaded' : `${count} earlier messages are not loaded`}</span>
      <button type="button" className="earlier-messages-load" disabled={busy} onClick={onLoad}>
        {busy ? 'Loading…' : 'Load earlier messages'}
      </button>
      {error && <span className="earlier-messages-error" role="alert">{error}</span>}
    </div>
  )
}

/** Shown above the selected thread while its older messages have not been loaded. */
export function EarlierMessagesBar() {
  const threadId = useAppStore((state) => state.activeThreadId)
  const earlier = useAppStore((state) => (state.activeThreadId ? state.earlierByThread[state.activeThreadId] : undefined))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!threadId || !earlier) return null
  const load = () => {
    setBusy(true)
    setError('')
    void window.mousse.threads
      .loadEarlier(threadId, earlier.before)
      .then((page) => {
        useAppStore.getState().applyEarlierMessages(threadId, page.messages, page.earlier)
        void hydrateMessageImages(threadId)
      })
      .catch((cause: unknown) => setError(ipcErrorLine(cause) || 'Could not load earlier messages.'))
      .finally(() => setBusy(false))
  }
  return <EarlierMessagesBarView count={earlier.count} busy={busy} error={error} onLoad={load} />
}
