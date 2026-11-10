import type { PermissionMode } from '../../shared/permissionMode'
import type { ModelOverride } from '../../shared/providerInstances'
import type { Thread } from '../../shared/types'
import { useAppStore } from '../stores/appStore'

/**
 * What a new chat's thread still has to be given after it was made: the model and permission mode the composer showed.
 * A thread made on this computer is made with them; one made on another computer gets them in calls after, and those
 * can fail. The setup stays with the thread (`AppState.pendingThreadSetup`) until every call went through.
 */
export interface ThreadSetup {
  model?: ModelOverride
  permissionMode?: PermissionMode
}

/** Records what `threadId` still has to be given; a field left out keeps what was recorded before. */
export function recordThreadSetup(threadId: string, setup: ThreadSetup): void {
  const store = useAppStore.getState()
  const merged: ThreadSetup = { ...store.pendingThreadSetup[threadId], ...setup }
  store.setPendingThreadSetup(threadId, merged.model || merged.permissionMode ? merged : undefined)
}

/** The error a send shows when its thread's setup did not finish: nothing was sent. */
export class ThreadSetupError extends Error {
  constructor(cause: unknown) {
    super(`Nothing was sent: this chat's model and permissions could not be set. ${cause instanceof Error ? cause.message : String(cause)}`.trim())
    this.name = 'ThreadSetupError'
  }
}

/**
 * Gives `threadId` what its setup still holds, one call at a time, and forgets each part once it went through. Throws
 * `ThreadSetupError` when a call fails, so the caller sends nothing; the rest stays recorded for the next send.
 */
export async function finishThreadSetup(threadId: string, calls: {
  setModel: (id: string, model: ModelOverride) => Promise<Thread | null | undefined>
  setPermissionMode: (id: string, mode: PermissionMode) => Promise<Thread | null | undefined>
  update: (thread: Thread) => void
}): Promise<void> {
  const setup = useAppStore.getState().pendingThreadSetup[threadId]
  if (!setup) return
  try {
    if (setup.model) {
      const updated = await calls.setModel(threadId, setup.model)
      if (updated) calls.update(updated)
      const { model: _done, ...rest } = useAppStore.getState().pendingThreadSetup[threadId] ?? {}
      useAppStore.getState().setPendingThreadSetup(threadId, rest.permissionMode ? rest : undefined)
    }
    if (setup.permissionMode) {
      const updated = await calls.setPermissionMode(threadId, setup.permissionMode)
      if (updated) calls.update(updated)
      const { permissionMode: _done, ...rest } = useAppStore.getState().pendingThreadSetup[threadId] ?? {}
      useAppStore.getState().setPendingThreadSetup(threadId, rest.model ? rest : undefined)
    }
  } catch (error) {
    throw new ThreadSetupError(error)
  }
}
