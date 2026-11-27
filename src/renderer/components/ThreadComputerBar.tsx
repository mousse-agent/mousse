import { useState } from 'react'
import { RefreshCw, Server } from '../lib/icons'
import { UNKNOWN_COMPUTER_NAME, offlineLabel, refreshComputers, threadComputerState, useComputer, type ComputerState } from '../lib/computers'
import { forgetMessageImageRequests } from '../lib/messageImages'
import { useAppStore } from '../stores/appStore'
import { useOpenFailedShown } from './ThreadOpening'
import '../styles/computers.css'

interface ThreadComputerBarViewProps {
  name: string
  state: ComputerState
  /** "Offline · last seen 5m ago", when the computer is offline. */
  offline?: string
  retrying?: boolean
  onRetry: () => void
}

/**
 * Top of a thread that runs on another computer: whose it is, and when that computer cannot be reached,
 * the last transcript stays with a note and Retry. A connected computer shows nothing.
 */
export function ThreadComputerBarView({ name, state, offline, retrying, onRetry }: ThreadComputerBarViewProps) {
  // A connected computer shows nothing here: the chat looks like one on this computer, and the
  // device menu under the transcript already names where it runs.
  if (state === 'online') return null
  const message = state === 'offline' ? `${name} · ${offline ?? 'Offline'}` : state === 'not-shared' ? `${name} is not sharing its threads with this computer right now` : name
  return (
    <div className="thread-computer-bar" data-state={state} role="status">
      <Server size={12} strokeWidth={2} aria-hidden="true" />
      <span className="thread-computer-bar-text" title={message}>{message}</span>
      <button type="button" className="thread-computer-bar-retry" disabled={retrying} onClick={onRetry}>
        <RefreshCw size={12} aria-hidden="true" />Retry
      </button>
    </div>
  )
}

/** Shown above the selected thread when it runs on another computer. */
export function ThreadComputerBar() {
  const thread = useAppStore((state) => state.threads.find((entry) => entry.id === state.activeThreadId))
  const computer = useComputer(thread?.node)
  const [retrying, setRetrying] = useState(false)
  // A thread that could not be read says so in its transcript, with its own Retry.
  const failedShown = useOpenFailedShown()
  // Another thread asked for since: selecting this one again would cancel that choice.
  const otherOpening = useAppStore((state) => state.openingThreadId !== null && state.openingThreadId !== state.activeThreadId)
  if (!thread?.node || failedShown) return null
  const retry = () => {
    if (useAppStore.getState().openingThreadId !== null) return
    // Opening the thread again attaches it afresh, which reads its transcript and queue from the other computer.
    setRetrying(true)
    forgetMessageImageRequests(thread.id)
    void Promise.allSettled([refreshComputers(), window.mousse.threads.select(thread.id)]).finally(() => setRetrying(false))
  }
  return (
    <ThreadComputerBarView
      name={computer?.name ?? UNKNOWN_COMPUTER_NAME}
      state={threadComputerState(thread, computer)}
      offline={offlineLabel(computer, Date.now())}
      retrying={retrying || otherOpening}
      onRetry={retry}
    />
  )
}
