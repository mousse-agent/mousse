import { formatPauseUntil, formatTimeUntil, pauseProviderName, pauseWindowLabel } from '../../shared/pauseDisplay'
import type { TurnPause } from '../../shared/types'

/** How long past its reset an armed pause is still expected to continue by itself (the daemon's staleness rule). */
const AUTO_RESUME_GRACE_MS = 24 * 60 * 60 * 1000

/** The pause as the banner and the lists word it. `due` means the reset time has passed. */
export interface PausedRunText {
  /** "Paused until 3:40 PM", with "(estimated)" when the time is Mousse's guess. */
  headline: string
  /** "Resets in 2h 15m"; absent once the time has passed. */
  relative?: string
  /** Which limit was hit and what happens next. */
  detail: string
  due: boolean
  stale: boolean
}

/** "Claude's 5-hour limit", "Claude's usage limit" or "The usage limit". */
function limitName(pause: Pick<TurnPause, 'provider' | 'limitKind'>): string {
  const provider = pauseProviderName(pause.provider)
  const window = pauseWindowLabel(pause.limitKind)
  if (provider && window) return `${provider}'s ${window} limit`
  if (provider) return `${provider}'s usage limit`
  return 'The usage limit'
}

/** The reset time alone: "Paused until 3:40 PM". The date is added when it is not today. */
export function pausedUntilLabel(pause: Pick<TurnPause, 'until' | 'estimated'>, nowMs: number): string {
  return `Paused until ${formatPauseUntil(pause.until, nowMs)}${pause.estimated ? ' (estimated)' : ''}`
}

/** The words of the chat banner: the reset time (absolute and relative), the limit, and what happens next. */
export function describePausedRun(pause: TurnPause, nowMs: number): PausedRunText {
  const until = Date.parse(pause.until)
  const due = Number.isFinite(until) && until <= nowMs
  // A timer more than a day past its reset is ruled stale the moment the daemon looks at it; say so already.
  const stale = pause.stale === true || (pause.autoResume && isLongOverdue(pause, nowMs))
  const reached = `${limitName(pause)} was reached.`
  const relative = formatTimeUntil(pause.until, nowMs)
  let next: string
  if (stale) next = "The reset passed while Mousse was off, so it won't continue by itself. Press Resume now to continue."
  else if (pause.autoResume) next = due ? 'The limit should have reset, so it continues shortly.' : 'Continues by itself at reset.'
  else next = due ? 'The limit should have reset. Press Resume now to continue.' : "It won't continue by itself. Press Resume now once it resets."
  return {
    headline: pausedUntilLabel(pause, nowMs),
    ...(relative ? { relative: `Resets in ${relative}` } : {}),
    detail: `${reached} ${next}`,
    due,
    stale
  }
}

/** True when a pause is long past its reset: an armed timer that old is ruled stale, not fired. */
function isLongOverdue(pause: Pick<TurnPause, 'until'>, nowMs: number): boolean {
  const until = Date.parse(pause.until)
  return Number.isFinite(until) && nowMs - until > AUTO_RESUME_GRACE_MS
}

/**
 * The thread list's status text for a paused thread: its own reset time ("Paused until 3:40 PM", with a
 * "~" before a time that is Mousse's estimate), or just "Paused" for a row a subagent below it paused.
 */
export function pausedStatusLabel(pause: Pick<TurnPause, 'until' | 'estimated'> | undefined, nowMs: number): string {
  return pause ? `Paused until ${pause.estimated ? '~' : ''}${formatPauseUntil(pause.until, nowMs)}` : 'Paused'
}

export type PausedAction = 'resume' | 'cancel' | 'stop'

/** What the banner says when a button press fails. A run that is no longer paused is the usual cause (the banner lagged a hand-over or a Cancel). */
export function pausedActionError(error: unknown, action: PausedAction): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
  if (code === 'conflict') return 'This run is no longer paused.'
  const message = error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string' ? (error as { message: string }).message : ''
  const line = message.split('\n').map((part) => part.trim()).find(Boolean)
  const what = action === 'resume' ? 'continue the run' : action === 'cancel' ? 'cancel the paused run' : 'stop the thread'
  return line ? `Could not ${what}: ${line}` : `Could not ${what}. Try again.`
}
