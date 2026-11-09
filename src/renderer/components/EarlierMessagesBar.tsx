import { useEffect, useRef, useState } from 'react'
import { hydrateMessageImages } from '../lib/messageImages'
import { ipcErrorLine } from '../lib/errorText'
import { useAppStore } from '../stores/appStore'
import '../styles/computers.css'

interface EarlierMessagesBarViewProps {
  count: number
  busy: boolean
  error?: string
  onLoad: () => void
  /** Called once the bar scrolls into view; earlier messages then load without a click. */
  onVisible?: () => void
}

/**
 * Above the transcript of a long thread, which arrives as its newest part: says how many older messages are
 * left, loads them when the bar scrolls into view, and keeps a button for loading them by hand.
 */
export function EarlierMessagesBarView({ count, busy, error, onLoad, onVisible }: EarlierMessagesBarViewProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = ref.current
    if (!element || !onVisible || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onVisible()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [onVisible])
  return (
    <div className="earlier-messages-bar" ref={ref}>
      <span>{count === 1 ? '1 earlier message' : `${count} earlier messages`}</span>
      <button type="button" className="earlier-messages-load" disabled={busy} onClick={onLoad}>
        {busy ? 'Loading…' : 'Load'}
      </button>
      {error && <span className="earlier-messages-error" role="alert">{error}</span>}
    </div>
  )
}

/** Loads the page of messages before `before` into the open thread. */
export async function loadEarlierPage(threadId: string, before: string): Promise<void> {
  const page = await window.mousse.threads.loadEarlier(threadId, before)
  useAppStore.getState().applyEarlierMessages(threadId, page.messages, page.earlier)
  void hydrateMessageImages(threadId)
}

/**
 * Loads earlier pages of the open thread until `messageId` is among its messages (a search result in an older
 * part of a long thread). Stops when there is nothing earlier, the thread changes, or after `maxPages`.
 */
export async function loadEarlierUntil(threadId: string, messageId: string, maxPages = 50): Promise<boolean> {
  for (let page = 0; page < maxPages; page++) {
    const state = useAppStore.getState()
    if (state.activeThreadId !== threadId) return false
    if (state.messages.some((message) => message.id === messageId)) return true
    const earlier = state.earlierByThread[threadId]
    if (!earlier) return false
    await loadEarlierPage(threadId, earlier.before)
  }
  return useAppStore.getState().messages.some((message) => message.id === messageId)
}

/** Shown above the selected thread while its older messages have not been loaded. */
export function EarlierMessagesBar() {
  const threadId = useAppStore((state) => state.activeThreadId)
  const earlier = useAppStore((state) => (state.activeThreadId ? state.earlierByThread[state.activeThreadId] : undefined))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // A page that failed is not loaded again by scrolling; the button still is.
  const failedAt = useRef<string | null>(null)
  if (!threadId || !earlier) return null
  const load = () => {
    if (busy) return
    setBusy(true)
    setError('')
    failedAt.current = null
    void loadEarlierPage(threadId, earlier.before)
      .catch((cause: unknown) => {
        failedAt.current = earlier.before
        setError(ipcErrorLine(cause) || 'Could not load earlier messages.')
      })
      .finally(() => setBusy(false))
  }
  const onVisible = () => {
    if (!busy && failedAt.current !== earlier.before) load()
  }
  return <EarlierMessagesBarView count={earlier.count} busy={busy} error={error} onLoad={load} onVisible={onVisible} />
}
