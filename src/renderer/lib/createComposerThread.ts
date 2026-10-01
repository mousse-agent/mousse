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

/** Apply the blank composer's workspace selection before the first send. */
export async function prepareComposerThread(deps: {
  thread?: Thread
  workspace: { projectId?: string; worktreeEnabled: boolean }
  create: (projectId: string | undefined, opts: { worktreeEnabled: boolean }) => Promise<Thread>
  setWorktreeEnabled: (id: string, enabled: boolean) => Promise<Thread>
  update: (thread: Thread) => void
  stillVisible: () => boolean
  activate: (thread: Thread) => void
  select: (id: string) => Promise<void>
}): Promise<string | null> {
  const { thread, workspace } = deps
  const enabled = Boolean(workspace.projectId && workspace.worktreeEnabled)
  if (!thread || thread.projectId !== workspace.projectId) {
    return createComposerThread({ ...deps, create: () => deps.create(workspace.projectId, { worktreeEnabled: enabled }) })
  }
  if (Boolean(thread.worktreeEnabled) !== enabled) {
    const updated = await deps.setWorktreeEnabled(thread.id, enabled)
    if (!deps.stillVisible()) return null
    deps.update(updated)
  }
  return deps.stillVisible() ? thread.id : null
}
