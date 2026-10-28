import { useEffect, useMemo, useState } from 'react'
import { Pause } from '../../lib/icons'
import { describePausedRun, pausedActionError, type PausedAction } from '../../lib/pausedRun'
import { createPausedRunClient, type PausedRunClient } from '../../services/pausedRunClient'
import { useAppStore } from '../../stores/appStore'
import type { TurnPause } from '../../../shared/types'
import './pausedRunBanner.css'

/** The relative time ("Resets in 2h 15m") has minute resolution; a half-minute tick keeps it honest. */
const TICK_MS = 30_000

export interface PausedRunBannerViewProps {
  pause: TurnPause
  /** The current time, so the relative reset time is a pure function of it. */
  now: number
  /** The press that is in flight, if any. Every button ignores presses until it settles. */
  busy: PausedAction | null
  /** Why the last press failed, shown under the buttons. */
  error: string | null
  onResume: () => void
  onCancel: () => void
  /** Stops the thread and what it started. Omitted where the shell has no Stop. */
  onStop?: () => void
}

/**
 * A run a usage limit paused: when the limit resets (clock time and time left), which limit it was, and
 * the three ways on. Resume now continues at once, Cancel ends the paused run, Stop stops the thread and
 * its subagents. The buttons are ordinary buttons in reading order, so Tab and Enter or Space reach them.
 * A busy button keeps focus (`aria-disabled`, not `disabled`) so a keyboard press does not lose its place.
 */
export function PausedRunBannerView({ pause, now, busy, error, onResume, onCancel, onStop }: PausedRunBannerViewProps) {
  const text = describePausedRun(pause, now)
  const press = (action: () => void) => () => { if (busy === null) action() }
  return (
    <div className="chat-run-paused" role="group" aria-label="Run paused by a usage limit" data-paused-state={text.stale ? 'stale' : text.due ? 'due' : 'waiting'}>
      <div className="chat-run-paused-text" role="status">
        <span className="chat-run-paused-head">
          <Pause size={13} strokeWidth={2} aria-hidden="true" />
          <span className="chat-run-paused-until">{text.headline}</span>
          {text.relative && <span className="chat-run-paused-relative">{text.relative}</span>}
        </span>
        <span className="chat-run-paused-detail">{text.detail}</span>
      </div>
      <div className="chat-run-paused-actions">
        <button type="button" className="chat-run-paused-btn chat-run-paused-btn-primary" aria-disabled={busy !== null} aria-busy={busy === 'resume'} onClick={press(onResume)}>
          {busy === 'resume' ? 'Resuming…' : 'Resume now'}
        </button>
        <button type="button" className="chat-run-paused-btn" aria-disabled={busy !== null} aria-busy={busy === 'cancel'} title="End the pause without continuing; queued messages go on" onClick={press(onCancel)}>
          {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
        </button>
        {onStop && (
          <button type="button" className="chat-run-paused-btn" aria-disabled={busy !== null} title="Stop this thread and the subagents it started" onClick={press(onStop)}>
            Stop
          </button>
        )}
      </div>
      {error && <p className="chat-run-paused-error" role="alert">{error}</p>}
    </div>
  )
}

/** The pause of `threadId`, from the live turn state; undefined while the thread is not paused. */
export function usePausedRun(threadId: string | null | undefined): TurnPause | undefined {
  return useAppStore((state) => {
    const turn = threadId ? state.turnStates[threadId] : undefined
    return turn?.phase === 'paused' ? turn.pause : undefined
  })
}

/** The banner for a paused thread. Renders nothing for one that is not paused. */
export function PausedRunBanner({ threadId, onStop, client }: { threadId?: string | null; onStop?: () => void; client?: PausedRunClient }) {
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

  if (!pause) return null
  const run = async (action: PausedAction, call: () => Promise<void>) => {
    setBusy(action)
    setError(null)
    try { await call() }
    catch (failure) { setError(pausedActionError(failure, action)) }
    finally { setBusy(null) }
  }
  return (
    <PausedRunBannerView
      pause={pause}
      now={now}
      busy={busy}
      error={error}
      onResume={() => void run('resume', () => actions.resumeNow(pause.runId, threadId ?? undefined))}
      onCancel={() => void run('cancel', () => actions.cancel(pause.runId, threadId ?? undefined))}
      {...(onStop ? { onStop } : {})}
    />
  )
}
