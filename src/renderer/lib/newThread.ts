import type { NodeId } from '../../shared/net'
import { isThreadStarted } from '../../shared/threadTitle'
import { isTurnActivePhase, type Project, type TurnPhase } from '../../shared/types'

/**
 * Where a new chat will run: the project it starts in and whether that is a fresh worktree.
 * `node` names another of the user's computers; without it the chat runs here, and `projectId`
 * then names a project of this computer. With it, `projectId` is that computer's own project id.
 */
export interface ComposerWorkspace {
  projectId?: string
  worktreeEnabled: boolean
  node?: NodeId
}

/**
 * True for the composer's new-chat state: no thread selected yet, or a selected
 * thread that has not been started and has no messages. The composer and the
 * thread side card both use this to decide when the workspace can still change.
 */
export function isNewEmptyThread(
  activeThreadId: string | null,
  thread: { startedAt?: string; name?: string } | undefined,
  messageCount: number
): boolean {
  return !activeThreadId || Boolean(thread && !isThreadStarted(thread) && messageCount === 0)
}

/** The workspace draft for the new chat, falling back to what the thread already has. */
export function composerWorkspaceFor(
  draft: ComposerWorkspace | undefined,
  thread: { projectId?: string; worktreeEnabled?: boolean } | undefined
): ComposerWorkspace {
  return draft ?? { projectId: thread?.projectId, worktreeEnabled: Boolean(thread?.worktreeEnabled) }
}

/**
 * The workspace for work that can only run here (quick actions, file context). A draft that
 * names another computer holds that computer's project ids, so it counts for nothing here.
 */
export function localWorkspaceFor(
  draft: ComposerWorkspace | undefined,
  thread: { projectId?: string; worktreeEnabled?: boolean } | undefined
): ComposerWorkspace {
  return draft?.node ? { worktreeEnabled: false } : composerWorkspaceFor(draft, thread)
}

/**
 * The draft after picking where the chat runs. The project carries over only when the new
 * place has a project at the same path; otherwise the chat starts without a project.
 */
export function workspaceForDevice(
  workspace: ComposerWorkspace,
  from: readonly Pick<Project, 'id' | 'path'>[],
  to: readonly Pick<Project, 'id' | 'path'>[],
  node: NodeId | undefined
): ComposerWorkspace {
  const path = from.find((project) => project.id === workspace.projectId)?.path
  const match = path === undefined ? undefined : to.find((project) => project.path === path)
  return {
    projectId: match?.id,
    worktreeEnabled: Boolean(match && workspace.worktreeEnabled),
    ...(node ? { node } : {})
  }
}

/**
 * Key of one new thread or blank draft whose workspace is being prepared. It
 * carries the profile so a preparation that outlives a profile switch can only
 * ever clear its own entry.
 */
export function workspacePendingKey(profileId: string, threadId: string | null): string {
  return `${profileId}:${threadId ?? '__blank__'}`
}

/** True while the selected thread or blank draft is having its workspace prepared by a send. */
export function isWorkspacePending(state: {
  profileId?: string
  activeThreadId: string | null
  workspacePending?: Record<string, true>
}): boolean {
  if (!state.workspacePending || state.profileId === undefined) return false
  return Boolean(state.workspacePending[workspacePendingKey(state.profileId, state.activeThreadId)])
}

/**
 * True while a send is in flight for the selected thread, when the workspace
 * can no longer change. The composer toolbar and the thread side card both
 * lock on this, so a send that is still preparing a new thread (from the composer
 * or a quick action) locks both.
 */
export function isComposerWorkspaceLocked(state: {
  loading: boolean
  activeThreadId: string | null
  turnStates: Record<string, { phase: TurnPhase } | undefined>
  profileId?: string
  workspacePending?: Record<string, true>
}): boolean {
  const phase = state.activeThreadId ? state.turnStates[state.activeThreadId]?.phase : undefined
  return state.loading || isTurnActivePhase(phase ?? 'idle') || isWorkspacePending(state)
}
