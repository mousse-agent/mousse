import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconArrowBackUp } from '../lib/icons'
import { useAppStore } from '../stores/appStore'
import { errorText, ipcErrorLine, isComputerOffline } from '../lib/errorText'
import { pendingChangesDetails, type PendingChangesDetails } from '../../shared/workspace'
import { PendingChangesNotice } from './PendingChangesNotice'
import { invalidateThreadActionHistory, readThreadActionHistory, type ThreadActionHistory } from '../utils/threadActionHistory'

interface PromptUndoState {
  history: ThreadActionHistory | null
  busy: boolean
  working: boolean
  unavailableReason?: string
  undo: (messageId: string) => Promise<void>
}
const PromptUndoContext = createContext<PromptUndoState | null>(null)

/** Undo and Redo return a refusal over uncommitted changes instead of throwing it, so its actions survive IPC. */
function throwPendingChanges(result: unknown): void {
  if (result && typeof result === 'object' && 'pendingChangesError' in result) throw result.pendingChangesError
}

/** One authoritative history read for the entire visible transcript. */
export function PromptUndoProvider({ threadId, busy, revision, children }: {
  threadId?: string | null; busy: boolean; revision: unknown; children: ReactNode
}) {
  const profileId = useAppStore(state => state.profileId)
  const [history, setHistory] = useState<ThreadActionHistory | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Discard for an Undo refused over uncommitted changes, and the prompt to undo again afterwards. */
  const [changes, setChanges] = useState<{ details: PendingChangesDetails; retry: () => void } | null>(null)
  const pending = useRef(false)
  const binding = useRef({ threadId, profileId, busy })
  binding.current = { threadId, profileId, busy }
  const isCurrent = useCallback(() => binding.current.threadId === threadId
    && binding.current.profileId === profileId && useAppStore.getState().profileId === profileId, [threadId, profileId])

  useEffect(() => {
    setHistory(null); setError(null); setChanges(null)
    if (!threadId || busy) return
    let current = true
    const refresh = () => void readThreadActionHistory(threadId, true).then(value => {
      if (current && isCurrent()) setHistory(value)
    }).catch(cause => {
      // A computer that is away is said so once, by the bar above the thread, not by this poll every few seconds.
      if (current && isCurrent()) { setHistory(null); setError(isComputerOffline(cause) ? null : ipcErrorLine(cause) || String(cause)) }
    })
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => { current = false; window.clearInterval(timer) }
  }, [threadId, profileId, busy, revision, isCurrent])

  const undo = async (messageId: string) => {
    const target = history?.undoTarget
    if (!threadId || !target || target.messageId !== messageId || busy || pending.current) return
    pending.current = true; setWorking(true); setError(null); setChanges(null)
    try {
      const fresh = await readThreadActionHistory(threadId, true)
      if (!isCurrent() || binding.current.busy) throw new Error('The active conversation changed. Review it before undoing.')
      if (fresh.undoTarget?.actionId !== target.actionId || fresh.undoTarget.turnId !== target.turnId
        || fresh.undoTarget.messageId !== messageId || fresh.undoTarget.journalGeneration !== target.journalGeneration) {
        setHistory(fresh)
        throw new Error('Conversation history changed. Review the latest prompt and try again.')
      }
      throwPendingChanges(await window.mousse.actions.undoLatest(threadId, target.journalGeneration, target.turnId))
      // The daemon publishes the restored transcript; never remove messages locally.
      invalidateThreadActionHistory(threadId)
      const next = await readThreadActionHistory(threadId, true)
      if (isCurrent()) setHistory(next)
    } catch (cause) {
      if (isCurrent()) {
        setError(errorText(cause))
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
    pending.current = true; setWorking(true); setError(null); setChanges(null)
    try {
      const fresh = await readThreadActionHistory(threadId, true)
      if (!isCurrent() || binding.current.busy) throw new Error('The active conversation changed. Review it before redoing.')
      if (fresh.redoTarget?.actionId !== target.actionId || fresh.redoTarget.turnId !== target.turnId
        || fresh.redoTarget.journalGeneration !== target.journalGeneration) {
        setHistory(fresh)
        throw new Error('Conversation history changed. This turn can no longer be redone.')
      }
      throwPendingChanges(await window.mousse.actions.redo(threadId, target.journalGeneration))
      invalidateThreadActionHistory(threadId)
      const next = await readThreadActionHistory(threadId, true)
      if (isCurrent()) setHistory(next)
    } catch (cause) {
      if (isCurrent()) {
        setError(errorText(cause))
        const details = pendingChangesDetails(cause)
        if (details) setChanges({ details, retry: () => void redo() })
      }
    } finally {
      pending.current = false
      if (isCurrent()) setWorking(false)
    }
  }

  return <PromptUndoContext.Provider value={{ history, busy, working, undo, unavailableReason: !history && error ? `Undo unavailable: ${error}` : undefined }}>
    {children}
    {history?.redoTarget && <button type="button" disabled={busy || working} onClick={() => void redo()}>Redo last undo</button>}
    {working && <div role="status">Updating conversation…</div>}
    {error && (changes && threadId
      ? <PendingChangesNotice threadId={threadId} message={error} details={changes.details} onResolved={() => { setError(null); setChanges(null); changes.retry() }} />
      : <div role="alert">{error}</div>)}
  </PromptUndoContext.Provider>
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
