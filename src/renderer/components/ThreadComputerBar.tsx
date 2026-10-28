import { useState } from 'react'
import { RefreshCw, Server } from '../lib/icons'
import { UNKNOWN_COMPUTER_NAME, offlineLabel, refreshComputers, threadComputerState, useComputer, type ComputerState } from '../lib/computers'
import { useAppStore } from '../stores/appStore'
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
 * the last transcript stays with a note and Retry. A connected computer shows only its name.
 */
export function ThreadComputerBarView({ name, state, offline, retrying, onRetry }: ThreadComputerBarViewProps) {
  const message = state === 'offline' ? `${name} · ${offline ?? 'Offline'}` : state === 'not-shared' ? `${name} is not sharing its threads with this computer right now` : name
  return (
    <div className="thread-computer-bar" data-state={state} role={state === 'online' ? undefined : 'status'}>
      <Server size={12} strokeWidth={2} aria-hidden="true" />
      <span className="thread-computer-bar-text" title={message}>{state === 'online' ? `Runs on ${name}` : message}</span>
      {state !== 'online' && (
        <button type="button" className="thread-computer-bar-retry" disabled={retrying} onClick={onRetry}>
          <RefreshCw size={12} aria-hidden="true" />Retry
        </button>
      )}
    </div>
  )
}

/** Shown above the selected thread when it runs on another computer. */
export function ThreadComputerBar() {
  const thread = useAppStore((state) => state.threads.find((entry) => entry.id === state.activeThreadId))
  const computer = useComputer(thread?.node)
  const [retrying, setRetrying] = useState(false)
  if (!thread?.node) return null
  const retry = () => {
    // Opening the thread again attaches it afresh, which reads its transcript and queue from the other computer.
    setRetrying(true)
    void Promise.allSettled([refreshComputers(), window.mousse.threads.select(thread.id)]).finally(() => setRetrying(false))
  }
  return (
    <ThreadComputerBarView
      name={computer?.name ?? UNKNOWN_COMPUTER_NAME}
      state={threadComputerState(thread, computer)}
      offline={offlineLabel(computer, Date.now())}
      retrying={retrying}
      onRetry={retry}
    />
  )
}
