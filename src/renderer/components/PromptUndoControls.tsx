import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconArrowBackUp } from '../lib/icons'
import { useAppStore } from '../stores/appStore'
import { isSessionClosing, readableError } from '../lib/errorText'
import { pendingChangesDetails, type PendingChangesDetails } from '../../shared/workspace'
import { PendingChangesNotice } from './PendingChangesNotice'
import { invalidateThreadActionHistory, readThreadActionHistory, type ThreadActionHistory } from '../utils/threadActionHistory'

interface PromptUndoState {
  threadId?: string | null
  history: ThreadActionHistory | null
  busy: boolean
  working: boolean
  /** A failed Undo or Redo the person asked for. Background history reads never set it. */
  error: string | null
  changes: { details: PendingChangesDetails; retry: () => void } | null
  /** What a finished Undo or Redo wants said next to its result, such as commits that were already pushed. */
  notice: string | null
  undo: (messageId: string) => Promise<void>
  redo: () => Promise<void>
  clearError: () => void
  clearNotice: () => void
}
const PromptUndoContext = createContext<PromptUndoState | null>(null)

/** Undo and Redo return a refusal over a conflict instead of throwing it, so its details survive IPC. */
function throwPendingChanges(result: unknown): void {
  if (result && typeof result === 'object' && 'pendingChangesError' in result) throw result.pendingChangesError
}

/** The line a finished Undo or Redo returned with its action, if any. */
function noticeOf(result: unknown): string | null {
  const action = result && typeof result === 'object' ? (result as { action?: unknown }).action : undefined
  const notice = action && typeof action === 'object' ? (action as { notice?: unknown }).notice : undefined
  return typeof notice === 'string' && notice ? notice : null
}

/** One authoritative history read for the entire visible transcript. */
export function PromptUndoProvider({ threadId, busy, revision, children }: {
  threadId?: string | null; busy: boolean; revision: unknown; children: ReactNode
}) {
  const profileId = useAppStore(state => state.profileId)
  const [history, setHistory] = useState<ThreadActionHistory | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Discard for an Undo refused over a conflict, and the prompt to undo again afterwards. */
  const [changes, setChanges] = useState<{ details: PendingChangesDetails; retry: () => void } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const pending = useRef(false)
  const binding = useRef({ threadId, profileId, busy })
  binding.current = { threadId, profileId, busy }
  const isCurrent = useCallback(() => binding.current.threadId === threadId
    && binding.current.profileId === profileId && useAppStore.getState().profileId === profileId, [threadId, profileId])

  useEffect(() => {
    setHistory(null); setError(null); setChanges(null); setNotice(null)
    if (!threadId || busy) return
    let current = true
    const refresh = () => void readThreadActionHistory(threadId, true).then(value => {
      if (current && isCurrent()) setHistory(value)
    }).catch(() => {
      // A background read says nothing: Undo hides until the next read, every few seconds, succeeds.
      // An away computer is shown by the bar above the thread; a closing window needs nothing at all.
      if (current && isCurrent()) setHistory(null)
    })
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => { current = false; window.clearInterval(timer) }
  }, [threadId, profileId, busy, revision, isCurrent])

  const undo = async (messageId: string) => {
    const target = history?.undoTarget
    if (!threadId || !target || target.messageId !== messageId || busy || pending.current) return
    pending.current = true; setWorking(true); setError(null); setChanges(null); setNotice(null)
    try {
      const fresh = await readThreadActionHistory(threadId, true)
      if (!isCurrent() || binding.current.busy) throw new Error('The active conversation changed. Review it before undoing.')
      if (fresh.undoTarget?.actionId !== target.actionId || fresh.undoTarget.turnId !== target.turnId
        || fresh.undoTarget.messageId !== messageId || fresh.undoTarget.journalGeneration !== target.journalGeneration) {
        setHistory(fresh)
        throw new Error('Conversation history changed. Review the latest prompt and try again.')
      }
      const result = await window.mousse.actions.undoLatest(threadId, target.journalGeneration, target.turnId)
      throwPendingChanges(result)
      if (isCurrent()) setNotice(noticeOf(result))
      // The daemon publishes the restored transcript; never remove messages locally.
      invalidateThreadActionHistory(threadId)
      const next = await readThreadActionHistory(threadId, true)
      if (isCurrent()) setHistory(next)
    } catch (cause) {
      if (isCurrent() && !isSessionClosing(cause)) {
        setError(readableError(cause, 'Undo did not finish. Try again.'))
        const details = pendingChangesDetails(cause)
        if (details) setChanges({ details, retry: () => void undo(messageId) })
      }
    } finally {
      pending.current = false
      if (isCurrent()) setWorking(false)
    }
  }

  const redo = async () => {
    const target = history?.redoTarget
    if (!threadId || !target || busy || pending.current) return
    pending.current = true; setWorking(true); setError(null); setChanges(null); setNotice(null)
    try {
      const fresh = await readThreadActionHistory(threadId, true)
      if (!isCurrent() || binding.current.busy) throw new Error('The active conversation changed. Review it before redoing.')
      if (fresh.redoTarget?.actionId !== target.actionId || fresh.redoTarget.turnId !== target.turnId
        || fresh.redoTarget.journalGeneration !== target.journalGeneration) {
        setHistory(fresh)
        throw new Error('Conversation history changed. This turn can no longer be redone.')
      }
      const result = await window.mousse.actions.redo(threadId, target.journalGeneration)
      throwPendingChanges(result)
      if (isCurrent()) setNotice(noticeOf(result))
      invalidateThreadActionHistory(threadId)
      const next = await readThreadActionHistory(threadId, true)
      if (isCurrent()) setHistory(next)
    } catch (cause) {
      if (isCurrent() && !isSessionClosing(cause)) {
        setError(readableError(cause, 'Redo did not finish. Try again.'))
        const details = pendingChangesDetails(cause)
        if (details) setChanges({ details, retry: () => void redo() })
      }
    } finally {
      pending.current = false
      if (isCurrent()) setWorking(false)
    }
  }

  const clearError = () => { setError(null); setChanges(null) }
  const clearNotice = () => setNotice(null)
  return <PromptUndoContext.Provider value={{ threadId, history, busy, working, error, changes, notice, undo, redo, clearError, clearNotice }}>
    {children}
  </PromptUndoContext.Provider>
}

/**
 * Redo, progress and a failed Undo or Redo, as one notice above the composer. It is rendered inside the
 * composer block, so it sits with the composer's other notices instead of below the chat.
 */
export function PromptUndoNotice() {
  const state = useContext(PromptUndoContext)
  if (!state) return null
  const { threadId, history, busy, working, error, changes, notice } = state
  if (error) {
    return changes && threadId
      ? <PendingChangesNotice className="connection-failed-pill" threadId={threadId} message={error} details={changes.details}
          onResolved={() => { state.clearError(); changes.retry() }} />
      : <div className="connection-failed-pill" role="alert">
          <span>{error}</span>
          <button type="button" onClick={state.clearError}>Dismiss</button>
        </div>
  }
  if (working) return <div className="connection-failed-pill prompt-undo-notice" role="status"><span>Updating conversation…</span></div>
  const message = [history?.redoTarget ? 'Turn undone' : null, notice].filter(Boolean).join('. ')
  if (!message) return null
  return <div className="connection-failed-pill prompt-undo-notice" role="status">
    <span>{message}</span>
    {history?.redoTarget && <button type="button" disabled={busy} onClick={() => void state.redo()}>Redo last undo</button>}
    {notice && <button type="button" onClick={state.clearNotice}>Dismiss</button>}
  </div>
}

/** This is the actual control in each prompt toolbar, not a parallel history action. */
export function PromptUndoButton({ messageId }: { messageId: string }) {
  const state = useContext(PromptUndoContext)
  const target = state?.history?.undoTarget
  if (!state || !target || target.messageId !== messageId) return null
  const available = !state.busy && !state.working
  const reason = state.working ? 'Undoing turn…' : state.busy ? 'Wait for the active turn to finish before undoing.'
    : 'Undo this turn'
  return <button type="button" aria-label="Undo" title={reason} disabled={!available}
    onClick={() => { if (available) void state.undo(messageId) }}
    onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
    className="size-6 flex items-center justify-center rounded-md opacity-50 bg-transparent enabled:hover:opacity-100 enabled:hover:bg-an-foreground/10 disabled:cursor-not-allowed">
    <IconArrowBackUp className="w-3.5 h-3.5 text-an-foreground-muted" />
  </button>
}
