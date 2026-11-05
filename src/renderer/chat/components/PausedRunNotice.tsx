import { useEffect, useMemo, useState } from 'react'
import { Pause } from '../../lib/icons'
import { describePausedRun, pausedActionError, type PausedAction, type PausedRunText } from '../../lib/pausedRun'
import { createPausedRunClient, type PausedRunClient } from '../../services/pausedRunClient'
import { useAppStore } from '../../stores/appStore'
import { useComposerNotice, type ComposerNoticeProps } from '../../components/ComposerNotice'
import type { TurnPause } from '../../../shared/types'

/** The relative time ("in 2h 15m") has minute resolution; a half-minute tick keeps it honest. */
const TICK_MS = 30_000

export interface PausedRunNoticeInput {
  pause: TurnPause
  /** The current time, so the relative reset time is a pure function of it. */
  now: number
  /** The press that is in flight, if any. Every button ignores presses until it settles. */
  busy: PausedAction | null
  /** Why the last press failed; the notice shows it until the next press or a dismiss. */
  error: string | null
  onResume: () => void
  onEndPause: () => void
  onDismissError: () => void
}

/**
 * The notice's one line: "Usage limit reached · resumes 3:40 PM (in 2h 15m)". A pause without a timer "resets"
 * instead, since it does not resume by itself; past the reset it says what happens now.
 */
export function pausedRunLine(text: PausedRunText, pause: Pick<TurnPause, 'autoResume' | 'estimated'>): string {
  const head = 'Usage limit reached'
  if (text.stale) return `${head} · resume time unknown`
  if (text.due) return `${head} · ${pause.autoResume ? 'retrying now' : 'should have reset by now'}`
  const when = `${pause.estimated ? 'around ' : ''}${text.resetAt}${text.timeLeft ? ` (in ${text.timeLeft})` : ''}`
  return `${head} · ${pause.autoResume ? 'resumes' : 'resets'} ${when}`
}

/**
 * A run a usage limit paused, as the composer's notice: "Usage limit reached · resumes 3:40 PM (in 2h 15m)", the
 * limit and what happens next in the tooltip, then the one decision: Try now or Cancel. A busy button keeps focus (`aria-disabled`, not `disabled`) so a keyboard press does not lose its place.
 */
export function pausedRunNotice({ pause, now, busy, error, onResume, onEndPause, onDismissError }: PausedRunNoticeInput): ComposerNoticeProps {
  const text = describePausedRun(pause, now)
  const blocked = busy !== null
  const line = pausedRunLine(text, pause)
  return {
    tone: error ? 'error' : 'warning',
    ...(error ? {} : { icon: <Pause size={14} strokeWidth={2} aria-hidden="true" /> }),
    label: 'Run paused by a usage limit',
    title: error ?? line,
    tooltip: error ? `${line}. ${text.detail}` : text.detail,
    actions: [
      { label: busy === 'resume' ? 'Trying…' : 'Try now', primary: true, blocked, busy: busy === 'resume', onClick: onResume },
      { label: busy === 'cancel' ? 'Cancelling…' : 'Cancel', title: 'Drop this run; queued messages still send', blocked, busy: busy === 'cancel', onClick: onEndPause }
    ],
    ...(error ? { onDismiss: onDismissError } : {})
  }
}

/** The pause of `threadId`, from the live turn state; undefined while the thread is not paused. */
export function usePausedRun(threadId: string | null | undefined): TurnPause | undefined {
  return useAppStore((state) => {
    const turn = threadId ? state.turnStates[threadId] : undefined
    return turn?.phase === 'paused' ? turn.pause : undefined
  })
}

/** The notice for a paused thread. Shows nothing for one that is not paused. */
export function PausedRunNotice({ threadId, client }: { threadId?: string | null; client?: PausedRunClient }) {
  const pause = usePausedRun(threadId)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<PausedAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const actions = useMemo(() => client ?? createPausedRunClient(window.mousse.platformRequest), [client])
  const runId = pause?.runId

  useEffect(() => {
    if (!runId) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [runId])
  // A different run (or none) starts clean: an old press or error is not about it.
  useEffect(() => { setBusy(null); setError(null) }, [runId])

  const run = async (action: PausedAction, call: () => Promise<void>) => {
    setBusy(action)
    setError(null)
    try { await call() }
    catch (failure) { setError(pausedActionError(failure, action)) }
    finally { setBusy(null) }
  }
  useComposerNotice(pause ? pausedRunNotice({
    pause,
    now,
    busy,
    error,
    onResume: () => void run('resume', () => actions.resumeNow(pause.runId, threadId ?? undefined)),
    onEndPause: () => void run('cancel', () => actions.cancel(pause.runId, threadId ?? undefined)),
    onDismissError: () => setError(null)
  }) : null)
  return null
}
