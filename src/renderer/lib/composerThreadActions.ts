import type { Thread } from '../../shared/types'
import { useAppStore } from '../stores/appStore'

/**
 * The thread operations `prepareComposerThread` needs that do not depend on who
 * is sending, so the composer and quick actions prepare a new thread the same way.
 */
export function composerThreadActions() {
  return {
    create: (projectId: string | undefined, opts: { worktreeEnabled: boolean }) =>
      window.mousse.threads.create(undefined, projectId, opts),
    setWorktreeEnabled: (id: string, enabled: boolean) => window.mousse.threads.setWorktreeEnabled(id, enabled),
    update: (thread: Thread) => useAppStore.getState().upsertThread(thread),
    select: (id: string) => window.mousse.threads.select(id)
  }
}
