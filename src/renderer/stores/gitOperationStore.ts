import { create } from 'zustand'
import type { GitOperationEvent, GitOperationKind } from '../../shared/types'
import { applyOperationEvent, newOperationState, type GitOperationState } from '../components/git/gitOperationLogic'
import { gitErrorCode } from '../components/sideCard/gitSectionLogic'
import { errorText } from '../lib/errorText'

/**
 * The Git action each folder is running or has just ended, followed live. The daemon sends events
 * only to this window, for actions this window started, so entries are matched by the id this store
 * made up when the button was pressed. A failed or cancelled action keeps its output until the
 * next action on the folder or Dismiss; a finished one disappears.
 */
interface GitOperationStoreState {
  operations: Record<string, GitOperationState>
}

export const useGitOperationStore = create<GitOperationStoreState>(() => ({ operations: {} }))

function patch(path: string, change: (state: GitOperationState) => GitOperationState): void {
  useGitOperationStore.setState((store) => {
    const current = store.operations[path]
    if (!current) return store
    const next = change(current)
    return next === current ? store : { operations: { ...store.operations, [path]: next } }
  })
}

let listening = false

/** Starts listening for the daemon's events once; later calls do nothing. */
function listen(): void {
  if (listening) return
  const subscribe = typeof window === 'undefined' ? undefined : window.mousse?.git?.onOperation
  if (!subscribe) return
  listening = true
  subscribe(receiveGitOperationEvent)
}

/** Applies an event to the folder whose action it belongs to. Events of other actions are ignored. */
export function receiveGitOperationEvent(event: GitOperationEvent): void {
  const { operations } = useGitOperationStore.getState()
  const path = Object.keys(operations).find((key) => operations[key].operationId === event.operationId)
  if (path) patch(path, (state) => applyOperationEvent(state, event))
}

/** Registers a new action of the folder, replacing any outcome left from the one before, and returns its id. */
export function beginGitOperation(path: string, kind: GitOperationKind, now: number = Date.now()): string {
  listen()
  const operationId = crypto.randomUUID()
  useGitOperationStore.setState((store) => ({ operations: { ...store.operations, [path]: newOperationState(operationId, kind, now) } }))
  return operationId
}

/** Records how the request ended. The daemon's own last event usually got here first. */
export function finishGitOperation(path: string, operationId: string, outcome: 'done' | 'failed' | 'cancelled', message: string | null = null, now: number = Date.now()): void {
  const { operations } = useGitOperationStore.getState()
  if (operations[path]?.operationId !== operationId) return
  if (outcome === 'done') {
    dismissGitOperation(path)
    return
  }
  patch(path, (state) => {
    if (state.phase !== 'starting' && state.phase !== 'running') return state
    return { ...state, phase: outcome, cancelling: false, endedAt: now, message: message ?? state.message }
  })
}

export function dismissGitOperation(path: string): void {
  useGitOperationStore.setState((store) => {
    if (!store.operations[path]) return store
    const { [path]: _removed, ...rest } = store.operations
    return { operations: rest }
  })
}

/** Asks the daemon to stop the folder's running action. The end arrives as the request's rejection. */
export async function cancelGitOperation(path: string): Promise<void> {
  const state = useGitOperationStore.getState().operations[path]
  if (!state || !state.cancellable || state.cancelling) return
  patch(path, (current) => ({ ...current, cancelling: true }))
  try {
    const { cancelled } = await window.mousse.git.cancelOperation(state.operationId)
    // It had already ended, or cannot be stopped: the button comes back.
    if (!cancelled) patch(path, (current) => ({ ...current, cancelling: false }))
  } catch {
    patch(path, (current) => ({ ...current, cancelling: false }))
  }
}

/** Runs a long Git request as a followed action of the folder: its outcome, and a cancel, end up in the store. */
export async function trackGitOperation<T>(path: string, kind: GitOperationKind, run: (operationId: string) => Promise<T>): Promise<T> {
  const operationId = beginGitOperation(path, kind)
  try {
    const value = await run(operationId)
    finishGitOperation(path, operationId, 'done')
    return value
  } catch (error) {
    finishGitOperation(path, operationId, gitErrorCode(error) === 'git_cancelled' ? 'cancelled' : 'failed', errorText(error))
    throw error
  }
}

export function useGitOperation(path: string | null): GitOperationState | null {
  return useGitOperationStore((store) => (path ? store.operations[path] ?? null : null))
}
