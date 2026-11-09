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
}

/**
 * Above the transcript of a long thread, which arrives as its newest part: says how many older messages are
 * left, with a button that loads them. Scrolling the transcript up to its top loads them too.
 */
export function EarlierMessagesBarView({ count, busy, error, onLoad }: EarlierMessagesBarViewProps) {
  return (
    <div className="earlier-messages-bar">
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
  const loading = useRef(false)
  useEffect(() => {
    if (!threadId || !earlier) return
    // Scrolling the transcript up to within a screen of its top loads the page before it, once at a time.
    let lastTop = Number.POSITIVE_INFINITY
    const onScroll = (event: Event): void => {
      const list = event.target
      if (!(list instanceof HTMLElement) || !list.classList.contains('an-message-list')) return
      const movingUp = list.scrollTop < lastTop
      lastTop = list.scrollTop
      if (!movingUp || list.scrollTop > list.clientHeight || loading.current || failedAt.current === earlier.before) return
      loading.current = true
      setBusy(true)
      void loadEarlierPage(threadId, earlier.before)
        .catch((cause: unknown) => {
          failedAt.current = earlier.before
          setError(ipcErrorLine(cause) || 'Could not load earlier messages.')
        })
        .finally(() => {
          loading.current = false
          setBusy(false)
        })
    }
    document.addEventListener('scroll', onScroll, true)
    return () => document.removeEventListener('scroll', onScroll, true)
  }, [threadId, earlier])
  if (!threadId || !earlier) return null
  const load = () => {
    if (busy || loading.current) return
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
  return <EarlierMessagesBarView count={earlier.count} busy={busy} error={error} onLoad={load} />
}
