import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle } from '../../lib/icons'
import { ipcErrorLine } from '../../lib/errorText'
import { useAppStore } from '../../stores/appStore'
import type { WorkspaceRecoverResult, WorkspaceRecovery } from '../../../shared/workspace'
import './workspaceRecoveryBanner.css'

/** A thread stays paused until someone acts, so a fix made by hand in a terminal clears the banner within this long. */
const POLL_MS = 10_000

export type RecoveryAction = 'recover' | 'abort'

/**
 * What the banner shows: a recovery the daemon reported, or `notice` for a kind this build does not know. A notice says
 * what the daemon said and offers nothing, since this build cannot tell what a press would do.
 */
export type ShownRecovery = WorkspaceRecovery | { kind: 'notice'; reason: string }

export interface WorkspaceRecoveryBannerViewProps {
  recovery: ShownRecovery
  /** The press that is in flight, if any. Every button ignores presses until it settles. */
  busy: RecoveryAction | null
  /** A turn of the thread is running: recovery and Abort wait for it, so the button does too. */
  turnRunning?: boolean
  /** What still waits after the last press went through, shown as "Still waiting: …". */
  stillWaiting?: string | null
  /** Why the last press failed, shown under the buttons. */
  error: string | null
  onRecover: () => void
  onAbort: () => void
}

const TITLES: Record<ShownRecovery['kind'], string> = {
  paused: 'This thread is paused until its worktree is recovered.',
  merge: 'A merge from an earlier version of Mousse is still in progress.',
  publish: 'A Publish did not finish.',
  notice: "This thread's worktree needs attention."
}

/** The line under the title: the reason, without repeating the title. */
function detailOf(recovery: ShownRecovery): string {
  if (recovery.kind === 'merge' && recovery.folder) return `In ${recovery.folder}. Abort it, or finish it with Git.`
  if (recovery.kind === 'publish' && recovery.reason === 'A Publish did not finish.') {
    return 'Recovery checks whether it reached the branch and records what happened. Turns keep working meanwhile.'
  }
  return recovery.reason
}

/** "Still waiting: the project folder can't be read…", one sentence ending in a full stop. */
function stillWaitingLine(text: string): string {
  const sentence = text.trim().replace(/\.$/, '')
  return `Still waiting: ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}.`
}

/**
 * What a thread's worktree or its Publish is waiting on, in plain words, with the fix. A thread paused by an unfinished
 * operation and a Publish that did not finish offer Try recovery; a merge an earlier version left in progress offers
 * Abort the merge; a kind this build does not know offers nothing. Nothing here moves the worktree's branch or HEAD.
 * While a turn runs the button waits for it and says so. A busy button keeps focus (`aria-disabled`, not `disabled`).
 */
export function WorkspaceRecoveryBannerView({ recovery, busy, turnRunning = false, stillWaiting, error, onRecover, onAbort }: WorkspaceRecoveryBannerViewProps) {
  const blocked = busy !== null || turnRunning
  const press = (action: () => void) => () => { if (!blocked) action() }
  const action = recovery.kind === 'merge'
    ? { run: onAbort, label: busy === 'abort' ? 'Aborting…' : 'Abort the merge', busy: busy === 'abort' }
    : recovery.kind === 'notice' ? undefined
    : { run: onRecover, label: busy === 'recover' ? 'Recovering…' : 'Try recovery', busy: busy === 'recover' }
  return (
    <div className="chat-workspace-recovery" data-kind={recovery.kind} role="group" aria-label={TITLES[recovery.kind]}>
      <div className="chat-workspace-recovery-text" role="status">
        <span className="chat-workspace-recovery-head">
          <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
          <span className="chat-workspace-recovery-title">{TITLES[recovery.kind]}</span>
        </span>
        <span className="chat-workspace-recovery-detail">{detailOf(recovery)}</span>
      </div>
      {action && (
        <div className="chat-workspace-recovery-actions">
          <button type="button" className="chat-workspace-recovery-btn chat-workspace-recovery-btn-primary" aria-disabled={blocked} aria-busy={action.busy} onClick={press(action.run)}>
            {action.label}
          </button>
        </div>
      )}
      {action && turnRunning && busy === null && <p className="chat-workspace-recovery-note" role="status">Waiting for the current turn to finish.</p>}
      {stillWaiting && !error && <p className="chat-workspace-recovery-note" role="status">{stillWaitingLine(stillWaiting)}</p>}
      {error && <p className="chat-workspace-recovery-error" role="alert">{error}</p>}
    </div>
  )
}

const KINDS: ReadonlyArray<WorkspaceRecovery['kind']> = ['paused', 'merge', 'publish']

/** `recovery` of a `workspace.getStatus` answer; undefined when nothing waits or the answer has none. */
export function recoveryOf(status: unknown): ShownRecovery | undefined {
  const value = (status as { recovery?: unknown } | null | undefined)?.recovery
  if (!value || typeof value !== 'object') return undefined
  const { kind, reason, operationId, operationType, folder } = value as Record<string, unknown>
  if (typeof reason !== 'string') return undefined
  const known = KINDS.find((item) => item === kind)
  // A kind this build does not know (a newer daemon, a missing field): said, never acted on, and it pauses nothing here.
  if (!known) return { kind: 'notice', reason }
  // Abort needs the operation it aborts.
  if (known === 'merge' && typeof operationId !== 'string') return undefined
  return {
    kind: known,
    reason,
    ...(typeof operationId === 'string' ? { operationId } : {}),
    ...(typeof operationType === 'string' ? { operationType } : {}),
    ...(typeof folder === 'string' ? { folder } : {})
  }
}

/** Turn phases in which a turn holds the thread, so recovery and Abort wait for it. */
const RUNNING_PHASES = new Set(['queued', 'thinking', 'streaming', 'tool_running', 'awaiting_input', 'finalizing'])

/** What `threadId` is waiting on, read from the workspace status again when a turn changes phase and while it is shown. */
function useWorkspaceRecovery(threadId: string | null | undefined): { recovery: ShownRecovery | undefined; turnRunning: boolean; refresh: () => void } {
  const phase = useAppStore((state) => (threadId ? state.turnStates[threadId]?.phase : undefined))
  const [read, setRead] = useState<{ threadId: string; recovery: ShownRecovery | undefined } | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((value) => value + 1), [])
  useEffect(() => {
    if (!threadId) return
    let cancelled = false
    void Promise.resolve(window.mousse.workspace.getStatus(threadId)).then(
      (status) => { if (!cancelled) setRead({ threadId, recovery: recoveryOf(status) }) },
      // A failed read says nothing about the worktree: what is shown stays.
      () => undefined
    )
    return () => { cancelled = true }
  }, [threadId, phase, tick])
  const shown = read && read.threadId === threadId ? read.recovery : undefined
  const showing = shown !== undefined
  useEffect(() => {
    if (!showing) return
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [showing, refresh])
  return { recovery: shown, turnRunning: phase !== undefined && RUNNING_PHASES.has(phase), refresh }
}

/** The banner for a thread whose worktree or Publish is waiting on something. Renders nothing otherwise. */
export function WorkspaceRecoveryBanner({ threadId }: { threadId?: string | null }) {
  const { recovery, turnRunning, refresh } = useWorkspaceRecovery(threadId)
  const [busy, setBusy] = useState<RecoveryAction | null>(null)
  const [stillWaiting, setStillWaiting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Another thread starts clean: an old press, result or error is not about it.
  useEffect(() => { setBusy(null); setStillWaiting(null); setError(null) }, [threadId])
  if (!recovery || !threadId) return null
  const run = async (action: RecoveryAction) => {
    setBusy(action)
    setStillWaiting(null)
    setError(null)
    try {
      if (action === 'abort') {
        await window.mousse.operations.abort({ threadId, operationId: recovery.kind === 'merge' ? recovery.operationId : undefined })
      } else {
        // Recovery says what still waits after it ran; a daemon without `settled` reported success only when it was.
        const result = await window.mousse.operations.recover(threadId) as Partial<WorkspaceRecoverResult> | undefined
        if (result?.settled === false) setStillWaiting(result.stillWaiting ?? result.recovery?.reason ?? 'recovery did not finish everything')
      }
    } catch (failure) {
      setError(ipcErrorLine(failure) || String(failure))
    } finally {
      setBusy(null)
      refresh()
    }
  }
  return <WorkspaceRecoveryBannerView recovery={recovery} busy={busy} turnRunning={turnRunning} stillWaiting={stillWaiting} error={error} onRecover={() => void run('recover')} onAbort={() => void run('abort')} />
}
