import type { NodeId } from '../../shared/net'
import type { PermissionMode } from '../../shared/permissionMode'
import type { ModelOverride } from '../../shared/providerInstances'
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

/** The branch a new worktree starts from when it is not the project folder's own: made on this computer, in a project. */
export function composerBaseBranch(workspace: { projectId?: string; worktreeEnabled?: boolean; node?: string; baseBranch?: string }): string | undefined {
  return workspace.projectId && workspace.worktreeEnabled && !workspace.node && workspace.baseBranch ? workspace.baseBranch : undefined
}

/**
 * Whether sending the new chat makes a thread instead of using the empty one shown. An empty thread is reused only
 * where the chat is to run: the same computer, the same project, and the same mode (Private is fixed when a thread
 * is created). A worktree from another branch also takes a new thread, since only a new thread can carry it. The
 * composer and `prepareComposerThread` both ask this, so what the composer shows is what the send makes.
 */
export function composerCreatesThread(
  thread: Pick<Thread, 'projectId' | 'node' | 'localOnly'> | undefined,
  workspace: { projectId?: string; worktreeEnabled?: boolean; node?: string; localOnly?: boolean; baseBranch?: string }
): boolean {
  return (
    !thread ||
    thread.projectId !== workspace.projectId ||
    (thread.node ?? undefined) !== (workspace.node ?? undefined) ||
    Boolean(thread.localOnly) !== Boolean(workspace.localOnly) ||
    composerBaseBranch(workspace) !== undefined
  )
}

/**
 * Apply the blank composer's workspace selection before the first send. A chat for another computer is
 * created there (`node`), in that computer's project, and is then written to like any other thread.
 */
export async function prepareComposerThread(deps: {
  thread?: Thread
  workspace: { projectId?: string; worktreeEnabled: boolean; node?: NodeId; localOnly?: boolean; expiryMs?: number; expiryStopsRun?: boolean; baseBranch?: string; worktreePicked?: true }
  create: (projectId: string | undefined, opts: { worktreeEnabled: boolean; node?: NodeId; localOnly?: boolean; expiresAt?: string; expiryStopsRun?: boolean; baseBranch?: string; model?: ModelOverride; permissionMode?: PermissionMode; picked?: Array<'model' | 'permissionMode' | 'worktreeEnabled'>; rememberedChoices?: boolean }) => Promise<Thread>
  /**
   * The model and permission mode the composer shows. A thread made on this computer is made with them, so a send that
   * fails after it was made, and is retried on it, still runs with them. Another computer sets them afterwards.
   */
  shown?: { model?: ModelOverride; permissionMode?: PermissionMode }
  /** Which of the shown values the person picked (the checkout comes from `workspace.worktreePicked`); only those are remembered. */
  picked?: Array<'model' | 'permissionMode'>
  /** A new thread made here takes its project's remembered choices for what is not named in `shown`. */
  rememberedChoices?: boolean
  setWorktreeEnabled: (id: string, enabled: boolean, picked?: boolean) => Promise<Thread>
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
  const baseBranch = composerBaseBranch(workspace)
  const pickedOnCreate: Array<'model' | 'permissionMode' | 'worktreeEnabled'> = [...(deps.picked ?? []), ...(workspace.worktreePicked ? ['worktreeEnabled' as const] : [])]
  if (!thread || composerCreatesThread(thread, workspace)) {
    return createComposerThread({
      ...deps,
      create: () =>
        deps.create(workspace.projectId, {
          worktreeEnabled: enabled,
          ...(workspace.localOnly ? { localOnly: true } : workspace.node ? { node: workspace.node } : {}),
          ...expiry,
          ...(baseBranch ? { baseBranch } : {}),
          ...(!workspace.node && deps.shown?.model ? { model: deps.shown.model } : {}),
          ...(!workspace.node && deps.shown?.permissionMode ? { permissionMode: deps.shown.permissionMode } : {}),
          ...(pickedOnCreate.length && !workspace.node ? { picked: pickedOnCreate } : {}),
          ...(deps.rememberedChoices && !workspace.node ? { rememberedChoices: true } : {})
        })
    })
  }
  // An unset choice is recorded too, so the thread keeps the one it was sent with.
  if (thread.worktreeEnabled !== enabled) {
    const updated = workspace.worktreePicked ? await deps.setWorktreeEnabled(thread.id, enabled, true) : await deps.setWorktreeEnabled(thread.id, enabled)
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
