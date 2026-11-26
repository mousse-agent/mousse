import type { Thread } from '../../shared/types'
import { Server } from '../lib/icons'
import { UNKNOWN_COMPUTER_NAME, offlineLabel, threadComputerState, useComputer, type ComputerState } from '../lib/computers'
import '../styles/computers.css'

/** What a badge is on: a thread, a project that is on the computer, or a project of this computer that is also there. */
export type BadgeOf = 'thread' | 'project' | 'also'

/** The words a badge gives as its tooltip and accessible name. */
export function computerBadgeTitle(name: string, state: ComputerState, offline = 'Offline', of: BadgeOf = 'thread'): string {
  // A thread runs on a computer; a project is on it; a project of this computer can be on other computers too.
  const lead = of === 'also' ? `Also on ${name}` : of === 'project' ? `On ${name}` : `Runs on ${name}`
  if (state === 'online') return lead
  if (state === 'not-shared') return `${lead} · ${name} is not sharing its threads with this computer`
  return `${lead} · ${offline}`
}

interface ComputerBadgeViewProps {
  name: string
  state: ComputerState
  /** Show the name beside the icon (cards, headers); the compact row shows the icon alone. */
  withName?: boolean
  offline?: string
  /** What the badge is on: a thread (the default), or a project, which is named "On <computer>" ("Also on" for one of this computer's). */
  of?: BadgeOf
  /** Give the words as a hover tooltip too; off where the row's own hover card already names the computer. */
  tooltip?: boolean
  className?: string
}

/**
 * Which computer runs a thread. One that cannot be reached (offline, or not sharing its threads) has its icon struck
 * through; the tooltip says which and since when.
 */
export function ComputerBadgeView({ name, state, withName = false, offline, of, tooltip = true, className }: ComputerBadgeViewProps) {
  const title = computerBadgeTitle(name, state, offline, of)
  return (
    <span className={`computer-badge${className ? ` ${className}` : ''}`} data-state={state} title={tooltip ? title : undefined}>
      <span className="computer-badge-icon">
        <Server size={withName ? 11 : 12} strokeWidth={2} aria-label={title} />
      </span>
      {withName && <span className="computer-badge-name">{name}</span>}
    </span>
  )
}

/** The badge of a thread row; nothing for a thread of this computer. */
export function ThreadComputerBadge({ thread, withName, of, tooltip, className }: { thread: Pick<Thread, 'node' | 'offline' | 'notShared'>; withName?: boolean; of?: BadgeOf; tooltip?: boolean; className?: string }) {
  const computer = useComputer(thread.node)
  if (!thread.node) return null
  const state = threadComputerState(thread, computer)
  return (
    <ComputerBadgeView
      name={computer?.name ?? UNKNOWN_COMPUTER_NAME}
      state={state}
      withName={withName}
      offline={offlineLabel(computer, Date.now())}
      of={of}
      tooltip={tooltip}
      className={className}
    />
  )
}
