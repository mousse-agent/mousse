import { memo, useSyncExternalStore } from 'react'
import { CircleAlert, CircleCheck, CircleDotDashed, Clock, Loader2, MessageQuestion, Pause, Pencil, Shield } from '../lib/icons'
import { formatPauseUntil } from '../../shared/pauseDisplay'
import { expiresInLabel } from '../../shared/threadExpiry'
import { isThreadActivityActive, type Thread, type ThreadActivitySnapshot, type ThreadActivityState, type TurnPause } from '../../shared/types'
import { threadStatus, type ThreadLinkStatus } from '../../shared/threadAttention'
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
  /** Why its last message did not start (`Thread.setupFailure`); shown while nothing else is going on. */
  setupFailed?: string
}

/** What a row says of a thread whose message did not start, as its tooltip. */
const setupFailedTitle = (reason: string): string => `Didn't start. ${reason}`

/**
 * The mark in the gap before a Projects tree row's title: what the thread is doing, else its unsent draft (which
 * outranks Done: the draft is what the person left to come back to). Nothing for a quiet thread with no draft.
 */
export const ThreadRowStatusIcon = memo(function ThreadRowStatusIcon({ threadId, activity, live, awaitsApproval, setupFailed, draft = false }: RowStatusProps & { draft?: boolean }) {
  countRender(`SidebarStatus:${threadId}`)
  const status = threadStatus(useRowActivity(threadId, activity, live), awaitsApproval)
  const animateWorking = useAppStore((s) => status === 'working' && s.sidebarAnimations)
  const pause = useOwnPause(threadId)
  // When the limit resets moves with the clock; the other icons show no time.
  useAgeClock(status === 'paused')
  if (setupFailed && (status === 'quiet' || status === 'done')) {
    const title = setupFailedTitle(setupFailed)
    return <span className="threads-sidebar-status-icon threads-sidebar-status-icon--failed" title={title}><CircleAlert size={14} strokeWidth={2} aria-label={title} /></span>
  }
  if (draft && (status === 'quiet' || status === 'done')) {
    return (
      <span className="threads-sidebar-status-icon threads-sidebar-draft-icon" role="img" aria-label="Unsent draft" title="Unsent draft">
        <Pencil size={13} strokeWidth={2} aria-hidden="true" />
      </span>
    )
  }
  switch (status) {
    case 'working':
      return animateWorking ? (
        <Loader2 size={14} strokeWidth={2} className="threads-sidebar-status-spinner icon-spin" aria-hidden="true" />
      ) : (
        <span className="threads-sidebar-status-icon threads-sidebar-status-icon--working" role="img" aria-label="Agent is working" title="Working">
          <span className="threads-sidebar-status-dot" aria-hidden="true" />
        </span>
      )
    case 'done':
      return <span className="threads-sidebar-status-icon threads-sidebar-status-icon--completed" title="Done"><CircleCheck size={14} strokeWidth={2} aria-label="Agent finished" /></span>
    case 'approval':
      return <span className="threads-sidebar-status-icon threads-sidebar-status-icon--question" title="Needs your approval"><Shield size={14} strokeWidth={2} aria-label="Agent needs approval" /></span>
    case 'question':
      return <span className="threads-sidebar-status-icon threads-sidebar-status-icon--question" title="Asks you something"><MessageQuestion size={14} strokeWidth={2} aria-label="Agent needs input" /></span>
    case 'waiting':
      return <span className="threads-sidebar-status-icon threads-sidebar-status-icon--waiting" title="Waiting"><CircleDotDashed size={14} strokeWidth={2} aria-label="Agent is waiting" /></span>
    case 'paused':
    {
      const label = pausedStatusLabel(pause, Date.now())
      return <span className="threads-sidebar-status-icon threads-sidebar-status-icon--paused" title={label}><Pause size={14} strokeWidth={2} aria-label={label} /></span>
    }
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
const noClock = (): (() => void) => () => {}

/**
 * Renders again each minute of the shared clock while `enabled`: for what shows a time (an age, when a limit resets,
 * when a thread archives itself). Rows that show none do not subscribe, so the clock renders nothing for them.
 */
export function useAgeClock(enabled: boolean): void {
  useSyncExternalStore(enabled ? subscribeClock : noClock, readClock, readClock)
}

/** A row's "Archives itself" mark; its tooltip says how long until then, kept current by the shared clock. */
export const ThreadExpiryIcon = memo(function ThreadExpiryIcon({ expiresAt, size }: { expiresAt: string; size: number }) {
  useAgeClock(true)
  return (
    <span className="thread-expiry-icon" title={`Archives ${expiresInLabel(expiresAt)}`}>
      <Clock size={size} strokeWidth={2} aria-label="Archives itself" />
    </span>
  )
})

/** What a paused thread's status says when its icon already says Paused: when its limit resets, else Paused. */
function pausedTerseLabel(pause: Pick<TurnPause, 'until' | 'estimated'> | undefined, nowMs: number): string {
  return pause && !pause.estimated ? `until ${formatPauseUntil(pause.until, nowMs)}` : 'Paused'
}

/**
 * A thread's status and age, as an icon and words: Working 5m, Waiting, Approval, Input, Paused, Done, or its age.
 * `withAge` adds the age to Approval, Input, Done and Failed too (a thread link's card, which has no other time).
 * `linkStatus`: the status a thread link shows (`threadLinkStatus`), which keeps Done and Failed once the thread is quiet.
 * `terse`: the icon says Working, Waiting, Paused and Done, so the words are only the time (5m, until 3:40 PM); the
 * states that need the person or went wrong keep their word. `icon: false` leaves the icon out: a Projects tree row
 * shows it in the gap before its title.
 */
export const ThreadCardStatus = memo(function ThreadCardStatus({ threadId, activity, live, awaitsApproval, updatedAt, withAge = false, setupFailed, linkStatus, terse = false, icon = true }: RowStatusProps & { updatedAt?: string; withAge?: boolean; linkStatus?: ThreadLinkStatus; terse?: boolean; icon?: boolean }) {
  countRender(`SidebarStatus:${threadId}`)
  useAgeClock(true)
  const shown = useRowActivity(threadId, activity, live)
  const startedAt = useAppStore((s) => s.turnStates[threadId]?.startedAt)
  const pause = useOwnPause(threadId)
  const age = threadAge(isThreadActivityActive(shown) ? startedAt ?? updatedAt : updatedAt)
  const status: ThreadLinkStatus = linkStatus ?? threadStatus(shown, awaitsApproval)
  // Chat thread links share this card layout but have their own motion.
  const animateWorking = useAppStore((s) => status === 'working' && (linkStatus !== undefined || s.sidebarAnimations))
  const settledAge = withAge && age && age !== 'now' ? ` ${age}` : ''
  const runningAge = age && age !== 'now' ? age : ''
  if (status === 'working') {
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-working" title={terse ? 'Working' : undefined}>
        {icon && (animateWorking
          ? <Loader2 size={12} strokeWidth={2} className="icon-spin" aria-hidden="true" />
          : terse && <span className="threads-sidebar-status-dot" aria-hidden="true" />)}
        {terse ? runningAge : `Working${runningAge ? ` ${runningAge}` : ''}`}
      </span>
    )
  }
  if (status === 'waiting') {
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-waiting" title={terse ? 'Waiting' : undefined}>
        {icon && <CircleDotDashed size={12} strokeWidth={2} aria-hidden="true" />}
        {terse ? runningAge : `Waiting${runningAge ? ` ${runningAge}` : ''}`}
      </span>
    )
  }
  if (status === 'approval') {
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-input" title="Needs your approval">
        {icon && <Shield size={12} strokeWidth={2} aria-hidden="true" />}
        Approval{settledAge}
      </span>
    )
  }
  if (status === 'question') {
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-input">
        {icon && <MessageQuestion size={12} strokeWidth={2} aria-hidden="true" />}
        Input{settledAge}
      </span>
    )
  }
  if (status === 'paused') {
    const now = Date.now()
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-paused" title={terse ? pausedStatusLabel(pause, now) : undefined}>
        {icon && <Pause size={12} strokeWidth={2} aria-hidden="true" />}
        {terse ? pausedTerseLabel(pause, now) : pausedStatusLabel(pause, now)}
      </span>
    )
  }
  if (setupFailed && (status === 'quiet' || status === 'done' || status === 'failed')) {
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-failed" title={setupFailedTitle(setupFailed)}>
        {icon && <CircleAlert size={12} strokeWidth={2} aria-hidden="true" />}
        Didn't start
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-failed">
        {icon && <CircleAlert size={12} strokeWidth={2} aria-hidden="true" />}
        Failed{settledAge}
      </span>
    )
  }
  if (status === 'done') {
    return (
      <span className="threads-sidebar-card-status threads-sidebar-card-status-done" title={terse ? 'Done' : undefined}>
        {icon && <CircleCheck size={12} strokeWidth={2} aria-hidden="true" />}
        {terse ? age : `Done${settledAge}`}
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
