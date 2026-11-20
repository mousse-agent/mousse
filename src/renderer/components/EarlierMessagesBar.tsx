import { useEffect, useRef, useState } from 'react'
import { hydrateMessageImages } from '../lib/messageImages'
import { ipcErrorLine } from '../lib/errorText'
import { useAppStore } from '../stores/appStore'
import '../styles/computers.css'

interface EarlierMessagesErrorViewProps {
  error: string
  onRetry: () => void
}

/** Above the transcript when a long thread's older messages could not be loaded: why, and Retry. */
export function EarlierMessagesErrorView({ error, onRetry }: EarlierMessagesErrorViewProps) {
  return (
    <div className="earlier-messages-bar">
      <span className="earlier-messages-error" role="alert">{error}</span>
      <button type="button" className="earlier-messages-load" onClick={onRetry}>Retry</button>
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

const LIST = '.an-message-list'

/** Whether the transcript shows its top part: within a screen of its first loaded message. */
const nearTop = (list: HTMLElement): boolean => list.scrollTop <= list.clientHeight

/**
 * The selected thread's older messages load as the reader scrolls its transcript up to the top, a page at a time;
 * nothing shows meanwhile. A scroll up at the very top moves nothing, so a wheel turned up there loads too, and a
 * page that still leaves the reader at the top is followed by the next one. Shows a line only when a page failed.
 */
export function EarlierMessagesBar() {
  const threadId = useAppStore((state) => state.activeThreadId)
  const earlier = useAppStore((state) => (state.activeThreadId ? state.earlierByThread[state.activeThreadId] : undefined))
  const [error, setError] = useState('')
  const marker = useRef<HTMLSpanElement>(null)
  // A page that failed is not loaded again by scrolling; Retry still loads it.
  const failedAt = useRef<string | null>(null)
  const loading = useRef(false)
  // The reader went up to the top for older messages: a page that leaves them there is followed by the next.
  const readingUp = useRef(false)

  useEffect(() => {
    setError('')
    failedAt.current = null
    readingUp.current = false
  }, [threadId])

  useEffect(() => {
    // The transcript this loads for: the one in this pane (a side chat's is not).
    const pane = marker.current?.parentElement
    if (!threadId || !earlier || !pane) return
    const paneList = (target: EventTarget | null): HTMLElement | null => {
      const list = target instanceof Element ? target.closest<HTMLElement>(LIST) : null
      return list && pane.contains(list) ? list : null
    }
    const load = (): void => {
      if (loading.current || failedAt.current === earlier.before) return
      loading.current = true
      readingUp.current = true
      void loadEarlierPage(threadId, earlier.before)
        .then(() => setError(''))
        .catch((cause: unknown) => {
          failedAt.current = earlier.before
          setError(ipcErrorLine(cause) || 'Could not load earlier messages.')
        })
        .finally(() => {
          loading.current = false
        })
    }
    let lastTop = Number.POSITIVE_INFINITY
    const onScroll = (event: Event): void => {
      const list = event.target instanceof HTMLElement && event.target.matches(LIST) ? paneList(event.target) : null
      if (!list) return
      const movingUp = list.scrollTop < lastTop
      lastTop = list.scrollTop
      if (!nearTop(list)) readingUp.current = false
      else if (movingUp) load()
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY >= 0) return
      const list = paneList(event.target)
      if (list && nearTop(list)) load()
    }
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('wheel', onWheel, { capture: true, passive: true })
    // A page just came in (this runs again with the next `earlier`) and the reader is still at the top: the next one.
    let frame = 0
    if (readingUp.current) {
      frame = requestAnimationFrame(() => {
        const list = pane.querySelector<HTMLElement>(LIST)
        if (list && nearTop(list)) load()
      })
    }
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('wheel', onWheel, true)
    }
  }, [threadId, earlier])

  const retry = () => {
    if (loading.current || !threadId || !earlier) return
    failedAt.current = null
    setError('')
    loading.current = true
    void loadEarlierPage(threadId, earlier.before)
      .catch((cause: unknown) => {
        failedAt.current = earlier.before
        setError(ipcErrorLine(cause) || 'Could not load earlier messages.')
      })
      .finally(() => {
        loading.current = false
      })
  }
  return (
    <>
      <span ref={marker} hidden />
      {threadId && earlier && error ? <EarlierMessagesErrorView error={error} onRetry={retry} /> : null}
    </>
  )
}
