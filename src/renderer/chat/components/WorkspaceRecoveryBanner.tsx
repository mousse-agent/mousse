import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle } from '../../lib/icons'
import { ipcErrorLine } from '../../lib/errorText'
import { useAppStore } from '../../stores/appStore'
import type { WorkspaceRecovery } from '../../../shared/workspace'
import './workspaceRecoveryBanner.css'

/** A thread stays paused until someone acts, so a fix made by hand in a terminal clears the banner within this long. */
const POLL_MS = 10_000

export type RecoveryAction = 'recover' | 'abort'

export interface WorkspaceRecoveryBannerViewProps {
  recovery: WorkspaceRecovery
  /** The press that is in flight, if any. Every button ignores presses until it settles. */
  busy: RecoveryAction | null
  /** Why the last press failed, shown under the buttons. */
  error: string | null
  onRecover: () => void
  onAbort: () => void
}

const TITLES: Record<WorkspaceRecovery['kind'], string> = {
  paused: 'This thread is paused until its worktree is recovered.',
  merge: 'A merge from an earlier version of Mousse is still in progress.',
  publish: 'A Publish did not finish.'
}

/** The line under the title: the reason, without repeating the title. */
function detailOf(recovery: WorkspaceRecovery): string {
  if (recovery.kind === 'merge' && recovery.folder) return `In ${recovery.folder}. Abort it, or finish it with Git.`
  if (recovery.kind === 'publish' && recovery.reason === 'A Publish did not finish.') {
    return 'Recovery checks whether it reached the branch and records what happened. Turns keep working meanwhile.'
  }
  return recovery.reason
}

/**
 * What a thread's worktree or its Publish is waiting on, in plain words, with the fix. A thread paused by an unfinished
 * operation and a Publish that did not finish offer Try recovery; a merge an earlier version left in progress offers
 * Abort the merge. Nothing here moves the worktree's branch or HEAD. A busy button keeps focus (`aria-disabled`, not
 * `disabled`).
 */
export function WorkspaceRecoveryBannerView({ recovery, busy, error, onRecover, onAbort }: WorkspaceRecoveryBannerViewProps) {
  const press = (action: () => void) => () => { if (busy === null) action() }
  const merge = recovery.kind === 'merge'
  return (
    <div className="chat-workspace-recovery" data-kind={recovery.kind} role="group" aria-label={TITLES[recovery.kind]}>
      <div className="chat-workspace-recovery-text" role="status">
        <span className="chat-workspace-recovery-head">
          <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
          <span className="chat-workspace-recovery-title">{TITLES[recovery.kind]}</span>
        </span>
        <span className="chat-workspace-recovery-detail">{detailOf(recovery)}</span>
      </div>
      <div className="chat-workspace-recovery-actions">
        {merge ? (
          <button type="button" className="chat-workspace-recovery-btn chat-workspace-recovery-btn-primary" aria-disabled={busy !== null} aria-busy={busy === 'abort'} onClick={press(onAbort)}>
            {busy === 'abort' ? 'Aborting…' : 'Abort the merge'}
          </button>
        ) : (
          <button type="button" className="chat-workspace-recovery-btn chat-workspace-recovery-btn-primary" aria-disabled={busy !== null} aria-busy={busy === 'recover'} onClick={press(onRecover)}>
            {busy === 'recover' ? 'Recovering…' : 'Try recovery'}
          </button>
        )}
      </div>
      {error && <p className="chat-workspace-recovery-error" role="alert">{error}</p>}
    </div>
  )
}

const KINDS: ReadonlyArray<WorkspaceRecovery['kind']> = ['paused', 'merge', 'publish']

/** `recovery` of a `workspace.getStatus` answer; undefined when nothing waits or the answer has none. */
export function recoveryOf(status: unknown): WorkspaceRecovery | undefined {
  const value = (status as { recovery?: unknown } | null | undefined)?.recovery
  if (!value || typeof value !== 'object') return undefined
  const { kind, reason, operationId, operationType, folder } = value as Record<string, unknown>
  if (typeof reason !== 'string') return undefined
  // A daemon from before kinds only reported what pauses a thread.
  const known = KINDS.find((item) => item === kind) ?? 'paused'
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

/** What `threadId` is waiting on, read from the workspace status again when a turn changes phase and while it is shown. */
function useWorkspaceRecovery(threadId: string | null | undefined): { recovery: WorkspaceRecovery | undefined; refresh: () => void } {
  const phase = useAppStore((state) => (threadId ? state.turnStates[threadId]?.phase : undefined))
  const [read, setRead] = useState<{ threadId: string; recovery: WorkspaceRecovery | undefined } | null>(null)
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
  return { recovery: shown, refresh }
}

/** The banner for a thread whose worktree or Publish is waiting on something. Renders nothing otherwise. */
export function WorkspaceRecoveryBanner({ threadId }: { threadId?: string | null }) {
  const { recovery, refresh } = useWorkspaceRecovery(threadId)
  const [busy, setBusy] = useState<RecoveryAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Another thread starts clean: an old press or error is not about it.
  useEffect(() => { setBusy(null); setError(null) }, [threadId])
  if (!recovery || !threadId) return null
  const run = async (action: RecoveryAction) => {
    setBusy(action)
    setError(null)
    try {
      if (action === 'abort') await window.mousse.operations.abort({ threadId, operationId: recovery.operationId })
      else await window.mousse.operations.recover(threadId)
    } catch (failure) {
      setError(ipcErrorLine(failure) || String(failure))
    } finally {
      setBusy(null)
      refresh()
    }
  }
  return <WorkspaceRecoveryBannerView recovery={recovery} busy={busy} error={error} onRecover={() => void run('recover')} onAbort={() => void run('abort')} />
}
