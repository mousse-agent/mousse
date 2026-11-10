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
  // A new thread on another computer has no transcript to read yet: its first message is sent
  // while it is opened, as fast as on this computer, instead of after that round trip.
  if (thread.node) void deps.select(thread.id).catch(() => undefined)
  else await deps.select(thread.id)
  return deps.stillVisible() ? thread.id : null
}

/**
 * Whether sending the new chat makes a thread instead of using the empty one shown. An empty thread is reused only
 * where the chat is to run: the same computer, the same project, and the same mode (Private is fixed when a thread
 * is created). A worktree from another branch also takes a new thread (`prepareComposerThread`).
 */
export function composerCreatesThread(
  thread: Pick<Thread, 'projectId' | 'node' | 'localOnly'> | undefined,
  workspace: { projectId?: string; node?: string; localOnly?: boolean }
): boolean {
  return (
    !thread ||
    thread.projectId !== workspace.projectId ||
    (thread.node ?? undefined) !== (workspace.node ?? undefined) ||
    Boolean(thread.localOnly) !== Boolean(workspace.localOnly)
  )
}

/**
 * Apply the blank composer's workspace selection before the first send. A chat for another computer is
 * created there (`node`), in that computer's project, and is then written to like any other thread.
 */
export async function prepareComposerThread(deps: {
  thread?: Thread
  workspace: { projectId?: string; worktreeEnabled: boolean; node?: NodeId; localOnly?: boolean; expiryMs?: number; expiryStopsRun?: boolean; baseBranch?: string }
  create: (projectId: string | undefined, opts: { worktreeEnabled: boolean; node?: NodeId; localOnly?: boolean; expiresAt?: string; expiryStopsRun?: boolean; baseBranch?: string }) => Promise<Thread>
  setWorktreeEnabled: (id: string, enabled: boolean) => Promise<Thread>
  /** Gives a reused empty draft the expiry picked for it. */
  setExpiry?: (id: string, expiresAt: string, stopsRun: boolean) => Promise<Thread>
  now?: () => number
  update: (thread: Thread) => void
  stillVisible: () => boolean
  activate: (thread: Thread) => void
  select: (id: string) => Promise<void>
}): Promise<string | null> {
  if (!deps.stillVisible()) return null
  const { thread, workspace } = deps
  const enabled = Boolean(workspace.projectId && workspace.worktreeEnabled)
  // The expiry counts from now, when the chat is created; a chat on another computer has none (it is set there).
  const expiresAt = workspace.expiryMs !== undefined && !workspace.node ? new Date((deps.now?.() ?? Date.now()) + workspace.expiryMs).toISOString() : undefined
  const expiry = expiresAt ? { expiresAt, ...(workspace.expiryStopsRun ? { expiryStopsRun: true } : {}) } : {}
  // A worktree from another branch is made on this computer, and only a new thread can carry it.
  const baseBranch = enabled && !workspace.node && workspace.baseBranch ? workspace.baseBranch : undefined
  if (!thread || composerCreatesThread(thread, workspace) || baseBranch) {
    return createComposerThread({
      ...deps,
      create: () =>
        deps.create(workspace.projectId, {
          worktreeEnabled: enabled,
          ...(workspace.localOnly ? { localOnly: true } : workspace.node ? { node: workspace.node } : {}),
          ...expiry,
          ...(baseBranch ? { baseBranch } : {})
        })
    })
  }
  // An unset choice is recorded too, so the thread keeps the one it was sent with.
  if (thread.worktreeEnabled !== enabled) {
    const updated = await deps.setWorktreeEnabled(thread.id, enabled)
    if (!deps.stillVisible()) return null
    deps.update(updated)
  }
  if (expiresAt && deps.setExpiry) {
    const updated = await deps.setExpiry(thread.id, expiresAt, workspace.expiryStopsRun === true)
    if (!deps.stillVisible()) return null
    deps.update(updated)
  }
  return deps.stillVisible() ? thread.id : null
}
