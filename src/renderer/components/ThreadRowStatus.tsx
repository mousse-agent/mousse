import { memo, useSyncExternalStore } from 'react'
import { CircleCheck, CircleDotDashed, Loader2, MessageQuestion, Pause, Shield } from '../lib/icons'
import { isThreadActivityActive, type Thread, type ThreadActivitySnapshot, type ThreadActivityState, type TurnPause } from '../../shared/types'
import { threadStatus } from '../../shared/threadAttention'
import { isSubagentThread } from '../../shared/threadLineage'
import { pausedStatusLabel } from '../lib/pausedRun'
import { useAppStore } from '../stores/appStore'
import { countRender } from '../chat/components/agent-elements/render-counts'

/**
 * A sidebar row's status, apart from the row: pushes of the threads' activity and turns render the status of the
 * thread they changed, not the list and its other rows.
 *
 * The list passes the activity it computed (`activity`: rolled up over a thread's subagents, Working for a send
 * still starting). A plain thread (`live`: no subagents, not a subagent, nothing put in its place) shows its own
 * activity, read here, so Working and Waiting can swap on it without the list rendering (see `sameListedActivity`).
 */
function useRowActivity(threadId: string, activity: ThreadActivityState | undefined, live: boolean): ThreadActivityState | undefined {
  const own = useAppStore((s) => (live ? s.threadActivity[threadId] : undefined))
  return live ? own : activity
}

/** The thread's own pause (not one a subagent below it is in): when its limit resets. */
function useOwnPause(threadId: string): Pick<TurnPause, 'until' | 'estimated'> | undefined {
  return useAppStore((s) => {
    const turn = s.turnStates[threadId]
    return turn?.phase === 'paused' ? turn.pause : undefined
  })
}

interface RowStatusProps {
  threadId: string
  activity?: ThreadActivityState
  live: boolean
  /** The input it waits for is a permission request. */
  awaitsApproval: boolean
}

/** The icon at the end of a Projects tree row. Nothing for a quiet thread. */
export const ThreadRowStatusIcon = memo(function ThreadRowStatusIcon({ threadId, activity, live, awaitsApproval }: RowStatusProps) {
  countRender(`SidebarStatus:${threadId}`)
  const status = threadStatus(useRowActivity(threadId, activity, live), awaitsApproval)
  const pause = useOwnPause(threadId)
  switch (status) {
    case 'working':
      return <Loader2 size={14} strokeWidth={2} className="threads-sidebar-status-spinner icon-spin" aria-hidden="true" />
    case 'done':
      return <CircleCheck size={14} strokeWidth={2} className="threads-sidebar-status-icon threads-sidebar-status-icon--completed" aria-label="Agent finished" />
    case 'approval':
      return <Shield size={14} strokeWidth={2} className="threads-sidebar-status-icon threads-sidebar-status-icon--question" aria-label="Agent needs approval" />
    case 'question':
      return <MessageQuestion size={14} strokeWidth={2} className="threads-sidebar-status-icon threads-sidebar-status-icon--question" aria-label="Agent needs input" />
    case 'waiting':
      return <CircleDotDashed size={14} strokeWidth={2} className="threads-sidebar-status-icon threads-sidebar-status-icon--waiting" aria-label="Agent is waiting" />
    case 'paused':
      return <Pause size={14} strokeWidth={2} className="threads-sidebar-status-icon threads-sidebar-status-icon--paused" aria-label={pausedStatusLabel(pause, Date.now())} />
    case 'quiet':
      return null
  }
})

/** How long ago `iso` was, as a row says it: now, 5m, 3h, 2d. */
export function threadAge(iso?: string): string {
  if (!iso) return ''
  const delta = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(delta) || delta < 45_000) return 'now'
  const minutes = Math.round(delta / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

// One clock for every row age on screen: a minute, while any is shown. Ages used to move only when a push rendered
// the whole list again; a row now renders only for its own changes.
const AGE_TICK_MS = 60_000
const clockListeners = new Set<() => void>()
let clockTimer: ReturnType<typeof setInterval> | null = null
let clockMinute = 0

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener)
  if (!clockTimer) {
    clockTimer = setInterval(() => {
      clockMinute += 1
      for (const notify of clockListeners) notify()
    }, AGE_TICK_MS)
  }
  return () => {
    clockListeners.delete(listener)
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

const readClock = (): number => clockMinute

/** The status and age in a Threads tab card's top line: Working 5m, Waiting, Approval, Input, Paused, Done, or its age. */
export const ThreadCardStatus = memo(function ThreadCardStatus({ threadId, activity, live, awaitsApproval, updatedAt }: RowStatusProps & { updatedAt?: string }) {
  countRender(`SidebarStatus:${threadId}`)
  useSyncExternalStore(subscribeClock, readClock, readClock)
  const shown = useRowActivity(threadId, activity, live)
  const startedAt = useAppStore((s) => s.turnStates[threadId]?.startedAt)
  const pause = useOwnPause(threadId)
  const age = threadAge(isThreadActivityActive(shown) ? startedAt ?? updatedAt : updatedAt)
  const status = threadStatus(shown, awaitsApproval)
  if (status === 'working') {
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-working">
        <Loader2 size={12} strokeWidth={2} className="icon-spin" aria-hidden="true" />
        Working{age && age !== 'now' ? ` ${age}` : ''}
      </span>
    )
  }
  if (status === 'waiting') {
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-waiting">
        <CircleDotDashed size={12} strokeWidth={2} aria-hidden="true" />
        Waiting{age && age !== 'now' ? ` ${age}` : ''}
      </span>
    )
  }
  if (status === 'approval') {
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-input" title="Needs your approval">
        <Shield size={12} strokeWidth={2} aria-hidden="true" />
        Approval
      </span>
    )
  }
  if (status === 'question') {
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-input">
        <MessageQuestion size={12} strokeWidth={2} aria-hidden="true" />
        Input
      </span>
    )
  }
  if (status === 'paused') {
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-paused">
        <Pause size={12} strokeWidth={2} aria-hidden="true" />
        {pausedStatusLabel(pause, Date.now())}
      </span>
    )
  }
  if (status === 'done') {
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-done">
        <CircleCheck size={12} strokeWidth={2} aria-hidden="true" />
        Done
      </span>
    )
  }
  return <span className="threads-sidebar-card-age">{age}</span>
})

/** The threads with no subagent above or below them: what their row shows is their own activity. */
export function plainThreads(threads: readonly Thread[]): ReadonlySet<string> {
  const related = new Set<string>()
  for (const thread of threads) {
    if (!isSubagentThread(thread)) continue
    related.add(thread.id)
    related.add(thread.lineage!.parentThreadId)
  }
  return new Set(threads.flatMap((thread) => (related.has(thread.id) ? [] : [thread.id])))
}

const isWorking = (state: ThreadActivityState | undefined): boolean => state === 'processing' || state === 'waiting'

/**
 * Whether the list shows the same with activity `next` as with `held`: every thread's state is the same, except that
 * a plain thread (`plain`: no subagents above or below it) may swap Working and Waiting, which only its status shows.
 */
export function sameListedActivity(held: ThreadActivitySnapshot, next: ThreadActivitySnapshot, plain: ReadonlySet<string>): boolean {
  if (held === next) return true
  const keys = Object.keys(next)
  if (keys.length !== Object.keys(held).length) return false
  return keys.every((key) => {
    if (!Object.prototype.hasOwnProperty.call(held, key)) return false
    const a = held[key]
    const b = next[key]
    return a === b || (plain.has(key) && isWorking(a) && isWorking(b))
  })
}
