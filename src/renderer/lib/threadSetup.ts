import type { PermissionMode } from '../../shared/permissionMode'
import type { ModelOverride } from '../../shared/providerInstances'
import type { Thread } from '../../shared/types'
import { useAppStore } from '../stores/appStore'

/**
 * What a new chat's thread still has to be given after it was made: the model and permission mode the composer showed.
 * A thread made on this computer is made with them; one made on another computer gets them in calls after, and those
 * can fail. The setup stays with the thread (`AppState.pendingThreadSetup`) until every call went through.
 *
 * `base` is what the thread had for each field when that field was recorded. A field whose thread value changed since
 * (another window, another computer, the CLI) is dropped instead of applied: the newer choice wins.
 */
export interface ThreadSetup {
  model?: ModelOverride
  permissionMode?: PermissionMode
  base?: { model?: ModelOverride | null; permissionMode?: PermissionMode | null }
}

/** What `finishThreadSetup` did not apply because the thread changed meanwhile. */
export type DroppedSetup = Array<'model' | 'permissionMode'>

const sameModel = (a: ModelOverride | null | undefined, b: ModelOverride | null | undefined): boolean =>
  (a?.instanceId ?? '') === (b?.instanceId ?? '') && (a?.model ?? '') === (b?.model ?? '') && (a?.effort ?? '') === (b?.effort ?? '')

/**
 * Records what `thread` still has to be given. A field left out keeps what was recorded before; a field recorded for
 * the first time takes the thread's current value as its base.
 */
export function recordThreadSetup(thread: Pick<Thread, 'id' | 'modelOverride' | 'permissionMode'>, setup: Pick<ThreadSetup, 'model' | 'permissionMode'>): void {
  const store = useAppStore.getState()
  const before = store.pendingThreadSetup[thread.id]
  const base = { ...before?.base }
  if (setup.model && !before?.model) base.model = thread.modelOverride ?? null
  if (setup.permissionMode && !before?.permissionMode) base.permissionMode = thread.permissionMode ?? null
  const model = setup.model ?? before?.model
  const permissionMode = setup.permissionMode ?? before?.permissionMode
  store.setPendingThreadSetup(thread.id, model || permissionMode ? { ...(model ? { model } : {}), ...(permissionMode ? { permissionMode } : {}), base } : undefined)
}

/** Forgets one field of `threadId`'s setup (it went through, or the thread changed meanwhile). */
function forget(threadId: string, field: 'model' | 'permissionMode'): void {
  const store = useAppStore.getState()
  const current = store.pendingThreadSetup[threadId]
  if (!current) return
const next: ThreadSetup = { ...current, base: { ...current.base } }
  delete next[field]
  delete next.base![field]
  store.setPendingThreadSetup(threadId, next.model || next.permissionMode ? next : undefined)
}

/** The error a send shows when its thread's setup did not finish: nothing was sent. */
export class ThreadSetupError extends Error {
  constructor(cause: unknown) {
    super(`Nothing was sent: this chat's model and permissions could not be set. ${cause instanceof Error ? cause.message : String(cause)}`.trim())
    this.name = 'ThreadSetupError'
  }
}

/**
 * Gives `threadId` what its setup still holds, one call at a time, and forgets each part once it went through. A part
 * whose thread value changed since it was recorded is not applied and is forgotten; it is returned, so the caller can
 * show the thread's current values before anything is sent. Throws `ThreadSetupError` when a call fails, or when the
 * thread is not listed (its current values can't be compared), so the caller sends nothing; the rest stays recorded.
 */
export async function finishThreadSetup(threadId: string, calls: {
  setModel: (id: string, model: ModelOverride) => Promise<Thread | null | undefined>
  setPermissionMode: (id: string, mode: PermissionMode) => Promise<Thread | null | undefined>
  update: (thread: Thread) => void
}): Promise<DroppedSetup> {
  const setup = useAppStore.getState().pendingThreadSetup[threadId]
  if (!setup) return []
  const thread = useAppStore.getState().threads.find((entry) => entry.id === threadId)
  if (!thread) throw new ThreadSetupError(new Error('This chat is not listed right now.'))
  const dropped: DroppedSetup = []
  // Compared before anything is applied, so a change this call makes is never mistaken for another route's.
  const modelChanged = Boolean(setup.model) && !sameModel(thread.modelOverride, setup.base?.model)
  const modeChanged = Boolean(setup.permissionMode) && (thread.permissionMode ?? null) !== (setup.base?.permissionMode ?? null)
  try {
    if (setup.model) {
      if (modelChanged) dropped.push('model')
      else {
        const updated = await calls.setModel(threadId, setup.model)
        if (updated) calls.update(updated)
      }
      forget(threadId, 'model')
    }
    if (setup.permissionMode) {
      if (modeChanged) dropped.push('permissionMode')
      else {
        const updated = await calls.setPermissionMode(threadId, setup.permissionMode)
        if (updated) calls.update(updated)
      }
      forget(threadId, 'permissionMode')
    }
  } catch (error) {
    throw new ThreadSetupError(error)
  }
  return dropped
}
