import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle } from '../../lib/icons'
import { ipcErrorLine } from '../../lib/errorText'
import { useAppStore } from '../../stores/appStore'
import type { WorkspaceRecovery } from '../../../shared/workspace'
import './workspaceRecoveryBanner.css'

/** A thread stays paused until someone acts, so a fix made by hand in a terminal clears the banner within this long. */
const POLL_MS = 10_000

export type RecoveryAction = 'switch' | 'recover'

export interface WorkspaceRecoveryBannerViewProps {
  recovery: WorkspaceRecovery
  /** The press that is in flight, if any. Every button ignores presses until it settles. */
  busy: RecoveryAction | null
  /** Why the last press failed, shown under the buttons. */
  error: string | null
  onSwitchBack: () => void
  onRecover: () => void
}

/**
 * A thread whose worktree needs recovery: every turn, Undo and Publish are refused until it is fixed. Says why in plain
 * words and offers the fix: Switch back and continue when the agent moved the worktree to another branch (its commits
 * stay there), Try recovery for any other reason. A busy button keeps focus (`aria-disabled`, not `disabled`).
 */
export function WorkspaceRecoveryBannerView({ recovery, busy, error, onSwitchBack, onRecover }: WorkspaceRecoveryBannerViewProps) {
  const press = (action: () => void) => () => { if (busy === null) action() }
  const { branch } = recovery
  return (
    <div className="chat-workspace-recovery" role="group" aria-label="Thread paused: its worktree needs recovery">
      <div className="chat-workspace-recovery-text" role="status">
        <span className="chat-workspace-recovery-head">
          <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
          <span className="chat-workspace-recovery-title">
            {branch
              ? <>This thread is paused because the agent switched its worktree to <code>{branch.actual}</code>.</>
              : 'This thread is paused because its worktree needs recovery.'}
          </span>
        </span>
        <span className="chat-workspace-recovery-detail">
          {branch
            ? <>Your commits stay on <code>{branch.actual}</code>. Switching back returns the worktree to <code>{branch.expected}</code> so turns, Undo and Publish work again.</>
            : recovery.reason}
        </span>
      </div>
      <div className="chat-workspace-recovery-actions">
        {branch ? (
          <button type="button" className="chat-workspace-recovery-btn chat-workspace-recovery-btn-primary" aria-disabled={busy !== null} aria-busy={busy === 'switch'} onClick={press(onSwitchBack)}>
            {busy === 'switch' ? 'Switching…' : 'Switch back and continue'}
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

/** `recovery` of a `workspace.getStatus` answer; undefined when the thread is fine or the answer has none. */
export function recoveryOf(status: unknown): WorkspaceRecovery | undefined {
  const value = (status as { recovery?: unknown } | null | undefined)?.recovery
  if (!value || typeof value !== 'object') return undefined
  const { reason, operationId, operationType, branch } = value as Record<string, unknown>
  if (typeof reason !== 'string') return undefined
  const pair = branch && typeof branch === 'object' ? branch as Record<string, unknown> : undefined
  return {
    reason,
    ...(typeof operationId === 'string' ? { operationId } : {}),
    ...(typeof operationType === 'string' ? { operationType } : {}),
    ...(pair && typeof pair.expected === 'string' && typeof pair.actual === 'string' ? { branch: { expected: pair.expected, actual: pair.actual } } : {})
  }
}

/** Why `threadId` needs recovery, read from the workspace status again when a turn changes phase and while it is shown. */
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

/** The banner for a thread that needs recovery. Renders nothing while its workspace is ready. */
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
      await window.mousse.operations.recover(threadId, action === 'switch' ? { switchBack: true } : undefined)
    } catch (failure) {
      setError(ipcErrorLine(failure) || String(failure))
    } finally {
      setBusy(null)
      refresh()
    }
  }
  return <WorkspaceRecoveryBannerView recovery={recovery} busy={busy} error={error} onSwitchBack={() => void run('switch')} onRecover={() => void run('recover')} />
}
