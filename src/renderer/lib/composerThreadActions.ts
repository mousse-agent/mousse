import type { PermissionMode } from '../../shared/permissionMode'
import type { ModelOverride } from '../../shared/providerInstances'
import type { Thread } from '../../shared/types'
import { useAppStore } from '../stores/appStore'

/**
 * The thread operations `prepareComposerThread` needs that do not depend on who
 * is sending, so the composer and quick actions prepare a new thread the same way.
 */
export function composerThreadActions() {
  return {
    create: (projectId: string | undefined, opts: { worktreeEnabled: boolean; localOnly?: boolean; expiresAt?: string; expiryStopsRun?: boolean; baseBranch?: string; model?: ModelOverride; permissionMode?: PermissionMode }) =>
      window.mousse.threads.create(undefined, projectId, opts),
    setWorktreeEnabled: (id: string, enabled: boolean) => window.mousse.threads.setWorktreeEnabled(id, enabled),
    setExpiry: (id: string, expiresAt: string, stopsRun: boolean) => window.mousse.threads.setExpiry(id, expiresAt, stopsRun),
    update: (thread: Thread) => useAppStore.getState().upsertThread(thread),
    select: (id: string) => window.mousse.threads.select(id)
  }
}
