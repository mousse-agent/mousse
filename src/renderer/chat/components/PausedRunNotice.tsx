import { useEffect, useMemo, useRef, useState } from 'react'
import { Pause } from '../../lib/icons'
import { describePausedRun, pausedActionError, type PausedAction, type PausedRunText } from '../../lib/pausedRun'
import { createPausedRunClient, type PausedRunClient } from '../../services/pausedRunClient'
import { useAppStore } from '../../stores/appStore'
import { useComposerNotice, type ComposerNoticeProps } from '../../components/ComposerNotice'
import { subagentDescendants } from '../../../shared/threadLineage'
import type { TurnPause } from '../../../shared/types'

/** The relative time ("in 2h 15m") has minute resolution; a half-minute tick keeps it honest. */
const TICK_MS = 30_000

/**
 * How long Try now keeps saying "Resuming…" after the daemon took the press while the run still shows as
 * paused. The continue turn normally starts within seconds; past this the notice says it did not, and the
 * buttons work again.
 */
export const RESUME_WAIT_MS = 60_000

/** The error line when the run still shows as paused `RESUME_WAIT_MS` after a Try now the daemon took. */
export const RESUME_STALLED_TEXT = 'Could not continue the run yet. Try again.'

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
  /**
   * How many subagents below the thread the notice stands for, when the thread is not paused itself but waits on
   * them. The notice then names them, shows the soonest reset (`pause`), and offers only Try now.
   */
  subagents?: number
}

/** "Subagent hit a usage limit", "2 subagents still limited". */
function subagentHead(count: number, again: boolean): string {
  const who = count === 1 ? 'Subagent' : `${count} subagents`
  return again ? `${who} still limited` : `${who} hit a usage limit`
}

/**
 * The notice's one line: "Usage limit reached · resumes 3:40 PM". A pause without a timer "resets" instead,
 * since it does not resume by itself; past the reset it says what happens now. A continue turn that ran into
 * the limit again reads "Still limited", and a Try now on its way "resuming…". For paused subagents the head
 * names them instead.
 */
export function pausedRunLine(text: PausedRunText, pause: Pick<TurnPause, 'autoResume' | 'estimated' | 'again'>, resuming = false, subagents = 0): string {
  const head = subagents > 0 ? subagentHead(subagents, pause.again === true) : pause.again ? 'Still limited' : 'Usage limit reached'
  if (resuming) return `${head} · resuming…`
  if (text.stale) return `${head} · resume time unknown`
  if (text.due) return `${head} · ${pause.autoResume ? 'retrying now' : 'should have reset by now'}`
  return `${head} · ${pause.autoResume ? 'resumes' : 'resets'} ${pause.estimated ? 'around ' : ''}${text.resetAt}`
}

/** The tooltip: the time left ("Resets in 2h 15m."), then the limit and what happens next. */
function pausedRunTooltip(text: PausedRunText, pause: Pick<TurnPause, 'autoResume'>): string {
  const left = text.timeLeft && !text.due && !text.stale ? `${pause.autoResume ? 'Resumes' : 'Resets'} in ${text.timeLeft}. ` : ''
  return `${left}${text.detail}`
}

/**
 * A run a usage limit paused, as the composer's notice: "Usage limit reached · resumes 3:40 PM", the time left,
 * the limit and what happens next in the tooltip, then the one decision: Try now or Cancel. A busy button keeps focus (`aria-disabled`, not `disabled`) so a keyboard press does not lose its place.
 * For subagents the thread waits on, only Try now: cancelling their work is not this notice's decision.
 */
export function pausedRunNotice({ pause, now, busy, error, onResume, onEndPause, onDismissError, subagents = 0 }: PausedRunNoticeInput): ComposerNoticeProps {
  const text = describePausedRun(pause, now)
  const blocked = busy !== null
  const line = pausedRunLine(text, pause, busy === 'resume', subagents)
  const tooltip = pausedRunTooltip(text, pause)
  const resume = { label: busy === 'resume' ? 'Resuming…' : 'Try now', primary: true, blocked, busy: busy === 'resume', onClick: onResume }
  return {
    tone: error ? 'error' : 'warning',
    priority: 'paused',
    ...(error ? {} : { icon: <Pause size={14} strokeWidth={2} aria-hidden="true" /> }),
    label: subagents > 0 ? 'Subagent paused by a usage limit' : 'Run paused by a usage limit',
    title: error ?? line,
    tooltip: error ? `${line}. ${tooltip}` : tooltip,
    actions: subagents > 0
      ? [{ ...resume, title: subagents === 1 ? 'Resume the paused subagent now' : 'Resume the paused subagents now' }]
      : [
          resume,
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

/** A subagent below a thread, paused by a usage limit. */
export interface PausedSubagent {
  threadId: string
  pause: TurnPause
}

const NO_PAUSED_SUBAGENTS: PausedSubagent[] = []

/**
 * The subagents below `threadId` (at any depth) that a usage limit paused, soonest reset first. The thread waits on
 * them while they are paused. Empty for none, and for no thread.
 */
export function usePausedSubagents(threadId: string | null | undefined): PausedSubagent[] {
  // A string, so the selector's result compares by value and the notice renders again only when it changes.
  const found = useAppStore((state) => {
    if (!threadId) return ''
    const paused = Object.values(state.turnStates).filter((turn) => turn.phase === 'paused' && turn.pause && turn.threadId !== threadId)
    if (paused.length === 0) return ''
    const below = new Set(subagentDescendants(threadId, state.threads))
    const mine = paused.filter((turn) => below.has(turn.threadId)).map((turn) => ({ threadId: turn.threadId, pause: turn.pause! }))
    return mine.length ? JSON.stringify(mine) : ''
  })
  return useMemo(() => {
    if (!found) return NO_PAUSED_SUBAGENTS
    return (JSON.parse(found) as PausedSubagent[]).sort((a, b) => Date.parse(a.pause.until) - Date.parse(b.pause.until))
  }, [found])
}

/**
 * The notice for a paused thread. A thread that is not paused itself but waits on subagents a usage limit paused
 * shows the same notice for them: the soonest reset, and Try now resuming each one as its own Try now would (each
 * resume also resumes what is paused below that subagent). Shows nothing otherwise.
 */
export function PausedRunNotice({ threadId, client }: { threadId?: string | null; client?: PausedRunClient }) {
  const own = usePausedRun(threadId)
  const subagents = usePausedSubagents(own ? null : threadId)
  const pause = own ?? subagents[0]?.pause
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<PausedAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const actions = useMemo(() => client ?? createPausedRunClient(window.mousse.platformRequest), [client])
  // What the notice stands for: the thread's own paused run, or the set of paused subagent runs below it.
  const runId = own ? own.runId : subagents.length ? subagents.map((entry) => entry.pause.runId).join(',') : undefined

  useEffect(() => {
    if (!runId) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [runId])
  // A different run (or none) starts clean: an old press or error is not about it.
  useEffect(() => { setBusy(null); setError(null) }, [runId])
  // The run on screen now: a press made for an earlier run reports nothing when it settles.
  const runIdRef = useRef(runId)
  runIdRef.current = runId

  // Try now stays busy after the daemon takes it, until the pause on screen ends (the run continues, or pauses
  // again as another run): the continue turn starts a moment later, and a button that came back in between
  // would look as though nothing happened. If the run still shows as paused after RESUME_WAIT_MS, it says so.
  useEffect(() => {
    if (busy !== 'resume') return
    const timer = setTimeout(() => {
      setBusy(null)
      setError(RESUME_STALLED_TEXT)
    }, RESUME_WAIT_MS)
    return () => clearTimeout(timer)
  }, [busy, runId])

  const run = async (action: PausedAction, pressedFor: string, call: () => Promise<void>) => {
    setBusy(action)
    setError(null)
    let taken = false
    try {
      await call()
      taken = true
    } catch (failure) { if (runIdRef.current === pressedFor) setError(pausedActionError(failure, action)) }
    finally { if (runIdRef.current === pressedFor && !(taken && action === 'resume')) setBusy(null) }
  }
  // Each paused subagent resumes on its own thread; one that is no longer paused does not fail the others.
  const resumeSubagents = async (): Promise<void> => {
    const results = await Promise.allSettled(subagents.map((entry) => actions.resumeNow(entry.pause.runId, entry.threadId)))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed && results.every((result) => result.status === 'rejected')) throw failed.reason
  }
  useComposerNotice(pause && runId ? pausedRunNotice({
    pause,
    now,
    busy,
    error,
    ...(own ? {} : { subagents: subagents.length }),
    onResume: () => void run('resume', runId, own ? () => actions.resumeNow(own.runId, threadId ?? undefined) : resumeSubagents),
    onEndPause: () => { if (own) void run('cancel', runId, () => actions.cancel(own.runId, threadId ?? undefined)) },
    onDismissError: () => setError(null)
  }) : null)
  return null
}
