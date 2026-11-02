import type { NodeId } from '../../shared/net'
import type { Thread } from '../../shared/types'

/** Keep an asynchronous blank-composer creation from overriding later navigation. */
export async function createComposerThread(deps: {
  create: () => Promise<Thread>
  stillVisible: () => boolean
  activate: (thread: Thread) => void
  select: (id: string) => Promise<void>
}): Promise<string | null> {
  const thread = await deps.create()
  if (!deps.stillVisible()) return null
  deps.activate(thread)
  await deps.select(thread.id)
  return deps.stillVisible() ? thread.id : null
}

/**
 * Apply the blank composer's workspace selection before the first send. A chat for another computer is
 * created there (`node`), in that computer's project, and is then written to like any other thread.
 */
export async function prepareComposerThread(deps: {
  thread?: Thread
  workspace: { projectId?: string; worktreeEnabled: boolean; node?: NodeId }
  create: (projectId: string | undefined, opts: { worktreeEnabled: boolean; node?: NodeId }) => Promise<Thread>
  setWorktreeEnabled: (id: string, enabled: boolean) => Promise<Thread>
  update: (thread: Thread) => void
  stillVisible: () => boolean
  activate: (thread: Thread) => void
  select: (id: string) => Promise<void>
}): Promise<string | null> {
  if (!deps.stillVisible()) return null
  const { thread, workspace } = deps
  const enabled = Boolean(workspace.projectId && workspace.worktreeEnabled)
  // An empty thread is reused only where the chat is to run: the same computer, and the same project.
  if (!thread || thread.projectId !== workspace.projectId || (thread.node ?? undefined) !== (workspace.node ?? undefined)) {
    return createComposerThread({
      ...deps,
      create: () => deps.create(workspace.projectId, { worktreeEnabled: enabled, ...(workspace.node ? { node: workspace.node } : {}) })
    })
  }
  // An unset choice is recorded too, so the thread keeps the one it was sent with.
  if (thread.worktreeEnabled !== enabled) {
    const updated = await deps.setWorktreeEnabled(thread.id, enabled)
    if (!deps.stillVisible()) return null
    deps.update(updated)
  }
  return deps.stillVisible() ? thread.id : null
}
