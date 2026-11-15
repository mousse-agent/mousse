import type { MouseEvent, ReactNode } from 'react'
import { MessageSquare } from '../lib/icons'
import { UNKNOWN_COMPUTER_NAME, threadComputerState, useComputers, type Computer } from '../lib/computers'
import { useAppStore } from '../stores/appStore'
import { openLinkedThread } from '../utils/chatLinks'
import { showToast } from './ui/Toast'
import { threadStatus, type ThreadStatus } from '../../shared/threadAttention'
import { threadLink } from '../../shared/threadLink'
import { parseQualifiedId } from '../../shared/threadRef'
import type { Thread, ThreadActivityState } from '../../shared/types'
import '../styles/threadChip.css'

/**
 * What a thread chip shows of its thread. `listed`: this window lists it (with its live status). `offline` and
 * `not-shared`: it runs on another computer that is not connected, or no longer shares its threads with this one (a row
 * of the merged lists says so, or, for a thread the window never listed, the device list). `missing`: not listed here,
 * so deleted.
 */
export type ThreadChipState =
  | { kind: 'listed'; title: string; status: ThreadStatus | 'archived' }
  | { kind: 'offline' | 'not-shared'; title?: string; computer: string }
  | { kind: 'missing' }

/** The words a chip says for a thread's status; a quiet thread says nothing. */
const STATUS_WORDS: Record<ThreadStatus | 'archived', string | null> = {
  working: 'Working',
  waiting: 'Waiting',
  approval: 'Needs you',
  question: 'Needs you',
  paused: 'Paused',
  done: 'Done',
  archived: 'Archived',
  quiet: null
}

/**
 * The state of the chip for `threadId`, from what this window holds: the thread's row if it lists one, its activity,
 * whether other rows of its computer say that computer stopped sharing (`notSharing`), and the computers.
 */
export function threadChipState(
  threadId: string,
  thread: Thread | undefined,
  activity: ThreadActivityState | undefined,
  notSharing: boolean,
  computers: Readonly<Record<string, Computer>>
): ThreadChipState {
  const node = thread?.node ?? parseQualifiedId(threadId)?.node
  const computer = node ? computers[node] : undefined
  const computerName = computer?.name ?? UNKNOWN_COMPUTER_NAME
  if (thread) {
    const title = thread.name.trim() || 'Untitled thread'
    const reach = node ? threadComputerState(thread, computer) : 'online'
    if (reach !== 'online') return { kind: reach, title, computer: computerName }
    return { kind: 'listed', title, status: thread.settledAt ? 'archived' : threadStatus(activity) }
  }
  if (node) {
    // Not listed, but its computer's other rows say it stopped sharing, or the device list says it is not connected.
    if (notSharing) return { kind: 'not-shared', computer: computerName }
    if (!computer || !computer.online) return { kind: 'offline', computer: computerName }
  }
  return { kind: 'missing' }
}

/** What the chip's state says, after its title: shown beside it and read as part of its name. */
function stateWords(state: ThreadChipState): string | null {
  switch (state.kind) {
    case 'listed':
      return STATUS_WORDS[state.status]
    case 'offline':
      return `${state.computer} is offline`
    case 'not-shared':
      return `${state.computer} is not sharing`
    case 'missing':
      return 'Deleted'
  }
}

/** What a click says when the thread cannot be opened. */
function unreachableText(state: ThreadChipState): string {
  if (state.kind === 'offline') return `${state.computer} is not connected, so this thread cannot be opened now.`
  if (state.kind === 'not-shared') return `${state.computer} no longer shares its threads with this computer.`
  return 'That thread is no longer here.'
}

/**
 * A link to a Mousse thread, drawn as a chip: the thread's title (or the link's own text) and its live status. A click
 * switches the main view to the thread in this window, and Back returns (the thread history records the switch). A
 * thread that is not listed here says why instead: deleted, or on a computer that is not connected or not sharing.
 */
export function ThreadChip({ threadId, label }: { threadId: string; label?: ReactNode }) {
  const thread = useAppStore((state) => state.threads.find((entry) => entry.id === threadId))
  const activity = useAppStore((state) => state.threadActivity[threadId])
  const node = thread?.node ?? parseQualifiedId(threadId)?.node
  // Only a chip naming another computer asks for the device list.
  const { byNode } = useComputers(node !== undefined)
  const notSharing = useAppStore((state) => !thread && node !== undefined && state.threads.some((entry) => entry.node === node && entry.notShared === true))
  const state = threadChipState(threadId, thread, activity, notSharing, byNode)
  const title = 'title' in state && state.title !== undefined ? state.title : null
  const words = stateWords(state)
  const shown = label ?? title ?? (state.kind === 'missing' ? 'A thread' : 'A thread on another computer')
  const name = [typeof label === 'string' ? label : title ?? (state.kind === 'missing' ? 'Thread' : 'Thread on another computer'), words].filter(Boolean).join(', ')
  const openable = state.kind === 'listed' || ((state.kind === 'offline' || state.kind === 'not-shared') && title !== null)
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (openable) openLinkedThread(threadId)
    else showToast({ key: 'thread-link-missing', message: unreachableText(state) })
  }
  return (
    <a
      href={threadLink(threadId)}
      className="thread-chip"
      data-state={state.kind}
      {...(state.kind === 'listed' ? { 'data-status': state.status } : {})}
      aria-label={openable ? `Open thread ${name}` : name}
      {...(openable ? {} : { 'aria-disabled': true })}
      title={openable ? `Open ${title ?? 'thread'}` : unreachableText(state)}
      onClick={onClick}
    >
      <MessageSquare size={12} strokeWidth={2} aria-hidden="true" className="thread-chip-icon" />
      <span className="thread-chip-title">{shown}</span>
      {words && (
        <span className="thread-chip-status">
          <span className="thread-chip-dot" aria-hidden="true" />
          {words}
        </span>
      )}
    </a>
  )
}
