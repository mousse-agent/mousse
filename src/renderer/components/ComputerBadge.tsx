import type { Thread } from '../../shared/types'
import { Server } from '../lib/icons'
import { UNKNOWN_COMPUTER_NAME, offlineLabel, threadComputerState, useComputer, type ComputerState } from '../lib/computers'
import '../styles/computers.css'

/** The words a badge gives as its tooltip and accessible name. */
export function computerBadgeTitle(name: string, state: ComputerState, offline = 'Offline'): string {
  if (state === 'online') return `Runs on ${name}`
  if (state === 'not-shared') return `Runs on ${name} · ${name} is not sharing its threads with this computer`
  return `Runs on ${name} · ${offline}`
}

interface ComputerBadgeViewProps {
  name: string
  state: ComputerState
  /** Show the name beside the icon (cards, headers); the compact row shows the icon alone. */
  withName?: boolean
  offline?: string
  className?: string
}

/** Which computer runs a thread, and that it cannot be reached when it cannot. */
export function ComputerBadgeView({ name, state, withName = false, offline, className }: ComputerBadgeViewProps) {
  const title = computerBadgeTitle(name, state, offline)
  return (
    <span className={`computer-badge${className ? ` ${className}` : ''}`} data-state={state} title={title}>
      <Server size={withName ? 11 : 12} strokeWidth={2} aria-label={title} />
      {withName && <span className="computer-badge-name">{name}</span>}
      {withName && state !== 'online' && <span className="computer-badge-state">{state === 'offline' ? 'offline' : 'not shared'}</span>}
    </span>
  )
}

/** The badge of a thread row; nothing for a thread of this computer. */
export function ThreadComputerBadge({ thread, withName, className }: { thread: Pick<Thread, 'node' | 'offline' | 'notShared'>; withName?: boolean; className?: string }) {
  const computer = useComputer(thread.node)
  if (!thread.node) return null
  const state = threadComputerState(thread, computer)
  return (
    <ComputerBadgeView
      name={computer?.name ?? UNKNOWN_COMPUTER_NAME}
      state={state}
      withName={withName}
      offline={offlineLabel(computer, Date.now())}
      className={className}
    />
  )
}
