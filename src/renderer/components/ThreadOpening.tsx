import { useState, type ReactNode } from 'react'
import { parseQualifiedId } from '../../shared/threadRef'
import { DelayedLoader } from './ui/DelayedLoader'
import { RefreshCw } from '../lib/icons'
import { UNKNOWN_COMPUTER_NAME, offlineLabel, refreshComputers, useComputer } from '../lib/computers'
import { forgetMessageImageRequests } from '../lib/messageImages'
import { retryOpenThread } from '../lib/threadActions'
import { openingCueOf, useAppStore } from '../stores/appStore'
import '../styles/threadOpening.css'

/** The thread slow to open, if any (`openingCueOf`): its row and the title say it is opening. */
export function useOpeningCue(): string | null {
  return useAppStore(openingCueOf)
}

/** The computer a thread runs on, by its row or its qualified id; undefined for this computer. */
function useThreadNode(threadId: string | null): string | undefined {
  const node = useAppStore((s) => (threadId ? s.threads.find((thread) => thread.id === threadId)?.node : undefined))
  return node ?? parseQualifiedId(threadId)?.node
}

function useComputerName(node: string | undefined): string {
  return useComputer(node)?.name ?? UNKNOWN_COMPUTER_NAME
}

/** "Loading from <computer>…" for a thread of another computer, "Opening <title>…" for one of this computer. */
function useOpeningLabel(threadId: string | null): string {
  const node = useThreadNode(threadId)
  const computer = useComputerName(node)
  const name = useAppStore((s) => (threadId ? s.threads.find((thread) => thread.id === threadId)?.name.trim() : undefined))
  if (node) return `Loading from ${computer}…`
  return name ? `Opening ${name}…` : 'Opening…'
}

/** A row's status mark, or a small turning ring while its thread is slow to open. */
export function ThreadOpeningMark({ threadId, children }: { threadId: string; children: ReactNode }) {
  const opening = useAppStore((s) => openingCueOf(s) === threadId)
  if (!opening) return <>{children}</>
  return <ThreadRowOpening threadId={threadId} />
}

function ThreadRowOpening({ threadId }: { threadId: string }) {
  const label = useOpeningLabel(threadId)
  return <span className="thread-opening-mark" title={label}><DelayedLoader size="small" delayMs={0} label={label} /></span>
}

/**
 * The title bar while a thread asked for is still held: the window still shows the thread before, so its path is
 * replaced by what is opening rather than renamed. Null otherwise.
 */
export function ThreadOpeningTitle() {
  const held = useAppStore((s) => {
    const cue = openingCueOf(s)
    return cue !== null && cue === s.openingThreadId ? cue : null
  })
  if (!held) return null
  return <ThreadOpeningTitleView threadId={held} />
}

function ThreadOpeningTitleView({ threadId }: { threadId: string }) {
  const label = useOpeningLabel(threadId)
  return (
    <div className="titlebar-path-opening" role="status">
      <DelayedLoader size="small" delayMs={0} label={label} />
      <span className="titlebar-path-opening-text">{label}</span>
    </div>
  )
}

/**
 * The transcript of the shown thread while it has none to show: waiting for it after a moment (one still line under
 * a turning ring), or "Couldn't reach <computer>" with Retry when it could not be read. Null otherwise.
 */
export function ThreadOpeningView() {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const empty = useAppStore((s) => s.messages.length === 0)
  const loading = useAppStore((s) => s.activeThreadId !== null && openingCueOf(s) === s.activeThreadId)
  const failed = useAppStore((s) => (s.transcriptFailed && s.transcriptFailed.threadId === s.activeThreadId ? s.transcriptFailed : null))
  if (!activeThreadId || !empty) return null
  if (failed) return <ThreadOpenFailed threadId={activeThreadId} reason={failed.reason} />
  if (loading) return <ThreadOpenLoading threadId={activeThreadId} />
  return null
}

function ThreadOpenLoading({ threadId }: { threadId: string }) {
  const node = useThreadNode(threadId)
  const computer = useComputerName(node)
  const label = node ? `Loading from ${computer}…` : 'Loading…'
  return (
    <div className="thread-opening-view" role="status">
      <DelayedLoader delayMs={0} label={label} />
      {node && <p className="thread-opening-line">{label}</p>}
    </div>
  )
}

function ThreadOpenFailed({ threadId, reason }: { threadId: string; reason: string | undefined }) {
  const node = useThreadNode(threadId)
  const computer = useComputer(node)
  const [retrying, setRetrying] = useState(false)
  // Another thread asked for since: Retry would select this one again and cancel that choice.
  const otherOpening = useAppStore((s) => s.openingThreadId !== null && s.openingThreadId !== threadId)
  const line = node ? `Couldn't reach ${computer?.name ?? UNKNOWN_COMPUTER_NAME}` : "Couldn't open this thread"
  const detail = (node && computer && !computer.online ? offlineLabel(computer, Date.now()) : undefined) ?? reason
  const retry = () => {
    setRetrying(true)
    forgetMessageImageRequests(threadId)
    void Promise.allSettled([node ? refreshComputers() : Promise.resolve(), retryOpenThread(threadId)]).finally(() => setRetrying(false))
  }
  return (
    <div className="thread-opening-view" role="alert">
      <p className="thread-opening-line" title={detail}>{line}</p>
      <button type="button" className="thread-opening-retry" disabled={retrying || otherOpening} onClick={retry}>
        <RefreshCw size={14} aria-hidden="true" />Retry
      </button>
    </div>
  )
}

/** Whether the shown thread's failure view is on screen, so the computer bar does not offer a second Retry. */
export function useOpenFailedShown(): boolean {
  return useAppStore((s) => s.transcriptFailed !== null && s.transcriptFailed.threadId === s.activeThreadId && s.messages.length === 0)
}
