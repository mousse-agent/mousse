import { create } from 'zustand'
import type { GitOperationEvent, GitOperationKind } from '../../shared/types'
import { applyOperationEvent, isActive, newOperationState, type GitOperationState } from '../components/git/gitOperationLogic'
import { gitErrorCode } from '../components/sideCard/gitSectionLogic'
import { errorText } from '../lib/errorText'

/**
 * The Git action each folder is running or has just ended, followed live. The daemon sends events
 * only to this window, for actions this window started, so entries are matched by the id this store
 * made up when the button was pressed. A failed or cancelled action keeps its output until the
 * next action on the folder or Dismiss; a finished one disappears.
 *
 * A folder shows one action. When a second starts while the first still runs (the daemon queues it
 * behind the first), the first stays on screen with its output and Cancel, and the second waits here
 * and is shown when the first has ended.
 *
 * A folder is named by its key (`folderKey`), which the `path` parameters below hold; never a path on disk.
 */
interface GitOperationStoreState {
  /** What each folder shows. */
  operations: Record<string, GitOperationState>
  /** Actions started behind the one shown, oldest first. */
  waiting: Record<string, GitOperationState[]>
}

export const useGitOperationStore = create<GitOperationStoreState>(() => ({ operations: {}, waiting: {} }))

/** Replaces the shown action of a folder with the next waiting one, or with nothing. */
function promote(state: GitOperationStoreState, path: string): GitOperationStoreState {
  const [next, ...rest] = state.waiting[path] ?? []
  const { [path]: _shown, ...operations } = state.operations
  const { [path]: _queue, ...waiting } = state.waiting
  return {
    operations: next ? { ...operations, [path]: next } : operations,
    waiting: rest.length ? { ...waiting, [path]: rest } : waiting
  }
}

/** Applies `change` to the action with this id, wherever it is. */
function patchById(operationId: string, change: (action: GitOperationState) => GitOperationState): void {
  useGitOperationStore.setState((state) => {
    const path = Object.keys(state.operations).find((key) => state.operations[key].operationId === operationId)
    if (path) {
      const next = change(state.operations[path])
      if (next === state.operations[path]) return state
      const updated = { ...state, operations: { ...state.operations, [path]: next } }
      // The shown action has ended and another waits: that one is shown now.
      return !isActive(next) && state.waiting[path]?.length ? promote(updated, path) : updated
    }
    for (const key of Object.keys(state.waiting)) {
      const index = state.waiting[key].findIndex((action) => action.operationId === operationId)
      if (index === -1) continue
      const next = change(state.waiting[key][index])
      if (next === state.waiting[key][index]) return state
      // A waiting action that ends before it was ever shown has nothing to show.
      const queue = isActive(next) ? state.waiting[key].map((action, at) => (at === index ? next : action)) : state.waiting[key].filter((_, at) => at !== index)
      return { ...state, waiting: { ...state.waiting, [key]: queue } }
    }
    return state
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

/** Applies an event to the action it belongs to. Events of other actions are ignored. */
export function receiveGitOperationEvent(event: GitOperationEvent): void {
  patchById(event.operationId, (action) => applyOperationEvent(action, event))
}

/**
 * Registers a new action of the folder and returns its id. It replaces an outcome left from the one before;
 * if an action is still running, it waits behind it. `threadId` is set when the folder is a thread's own worktree.
 */
export function beginGitOperation(path: string, kind: GitOperationKind, now: number = Date.now(), threadId?: string): string {
  listen()
  const operationId = crypto.randomUUID()
  const action = { ...newOperationState(operationId, kind, now), ...(threadId ? { threadId } : {}) }
  useGitOperationStore.setState((state) => {
    const shown = state.operations[path]
    if (shown && isActive(shown)) return { ...state, waiting: { ...state.waiting, [path]: [...(state.waiting[path] ?? []), action] } }
    return { ...state, operations: { ...state.operations, [path]: action } }
  })
  return operationId
}

/** Records how the request ended. The daemon's own last event usually got here first. */
export function finishGitOperation(path: string, operationId: string, outcome: 'done' | 'failed' | 'cancelled', message: string | null = null, now: number = Date.now()): void {
  const state = useGitOperationStore.getState()
  const shown = state.operations[path]
  if (outcome === 'done' && shown?.operationId === operationId) {
    useGitOperationStore.setState((current) => promote(current, path))
    return
  }
  patchById(operationId, (action) => (isActive(action) ? { ...action, phase: outcome, cancelling: false, endedAt: now, message: message ?? action.message } : action))
}

/** Clears the shown outcome of a folder. A waiting action, if any, is shown next. */
export function dismissGitOperation(path: string): void {
  useGitOperationStore.setState((state) => (state.operations[path] ? promote(state, path) : state))
}

/** Asks the daemon to stop the folder's running action. The end arrives as the request's rejection. */
export async function cancelGitOperation(path: string): Promise<void> {
  const state = useGitOperationStore.getState().operations[path]
  if (!state || !isActive(state) || !state.cancellable || state.cancelling) return
  patchById(state.operationId, (action) => ({ ...action, cancelling: true }))
  try {
    const { cancelled } = state.threadId
      ? await window.mousse.git.cancelOperation(state.operationId, state.threadId)
      : await window.mousse.git.cancelOperation(state.operationId)
    // It had already ended, or cannot be stopped any more: the button comes back.
    if (!cancelled) patchById(state.operationId, (action) => ({ ...action, cancelling: false }))
  } catch {
    patchById(state.operationId, (action) => ({ ...action, cancelling: false }))
  }
}

/**
 * Runs a long Git request as a followed action of the folder: its outcome, and a cancel, end up in the store.
 * `threadId` is set when the folder is a thread's own worktree.
 */
export async function trackGitOperation<T>(path: string, kind: GitOperationKind, run: (operationId: string) => Promise<T>, threadId?: string): Promise<T> {
  const operationId = beginGitOperation(path, kind, Date.now(), threadId)
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
