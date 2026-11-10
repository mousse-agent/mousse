import type { NodeId } from '../../shared/net'
import { isThreadStarted } from '../../shared/threadTitle'
import type { PermissionMode } from '../../shared/permissionMode'
import type { ModelOverride } from '../../shared/providerInstances'
import { isTurnActivePhase, type NewThreadChoice, type Project, type TurnPhase } from '../../shared/types'
import { useAppStore } from '../stores/appStore'

/**
 * Where a new chat will run: the project it starts in and whether that is a fresh worktree.
 * `node` names another of the user's computers; without it the chat runs here, and `projectId`
 * then names a project of this computer. With it, `projectId` is that computer's own project id,
 * and `localProjectId` remembers the project the draft had here.
 */
export interface ComposerWorkspace {
  projectId?: string
  worktreeEnabled: boolean
  node?: NodeId
  /** With `node`: the project this draft had on this computer, restored when it is picked again. */
  localProjectId?: string
  /** A private thread (`Thread.localOnly`): it runs on this computer only, so `node` is never set with it. */
  localOnly?: boolean
  /** The new chat deletes itself this long after it is created (`Thread.expiresAt`); absent: never. */
  expiryMs?: number
  /** With `expiryMs`: a run still going at expiry is stopped (`Thread.expiryStopsRun`). */
  expiryStopsRun?: boolean
  /** `expiryMs` came from the private-chat default in Settings, so turning Private off drops it. */
  expiryFromPrivateDefault?: boolean
  /**
   * With `worktreeEnabled`: the branch the new worktree starts from, set only when it is not the project folder's own
   * branch (`threads.create`'s `baseBranch`). Absent: the folder's HEAD, as a daemon without the field does anyway.
   */
  baseBranch?: string
  /** The person chose the checkout (worktree or the project's folder), so a send remembers it for the project. */
  worktreePicked?: true
  /** A model picked for the new chat, applied when a send makes its thread (and remembered for the project). */
  model?: ModelOverride
  /** A permission mode picked for the new chat, applied when a send makes its thread (and remembered for the project). */
  permissionMode?: PermissionMode
}

/** The draft without the picks made for its chat (after a send applied them, or when its project or computer changes). */
export function withoutPicks(workspace: ComposerWorkspace): ComposerWorkspace {
  const { worktreePicked: _checkout, model: _model, permissionMode: _mode, ...rest } = workspace
  return rest
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

/** The projects a new thread's remembered choices are read from. */
export type ProjectChoices = readonly Pick<Project, 'id' | 'newThread'>[]

/** What a new thread in `projectId` starts with, as last picked in one of the project's threads (`Project.newThread`). */
export function rememberedChoiceOf(projects: ProjectChoices, projectId: string | undefined): NewThreadChoice | undefined {
  return projectId ? projects.find((project) => project.id === projectId)?.newThread : undefined
}

/**
 * Whether a new thread in `projectId` starts in a new worktree: the project's remembered choice, else the global default
 * for new checkouts (`runs.newThreadWorktree`; yes until settings are read).
 */
export function newThreadWorktree(projects: ProjectChoices, projectId: string | undefined, fallback = useAppStore.getState().newThreadWorktree): boolean {
  return rememberedChoiceOf(projects, projectId)?.worktreeEnabled ?? fallback
}

/**
 * The workspace draft for the new chat, falling back to what the thread already has. A thread that never
 * chose (`worktreeEnabled` unset) takes its project's remembered checkout (`newThreadWorktree`).
 */
export function composerWorkspaceFor(
  draft: ComposerWorkspace | undefined,
  thread: { projectId?: string; worktreeEnabled?: boolean; node?: string; localOnly?: boolean } | undefined,
  projects: ProjectChoices
): ComposerWorkspace {
  return draft ?? {
    projectId: thread?.projectId,
    worktreeEnabled: thread?.worktreeEnabled ?? newThreadWorktree(projects, thread?.projectId),
    // An empty thread that was created on another computer is a chat for it.
    ...(thread?.node ? { node: thread.node as NodeId } : {}),
    ...(thread?.localOnly ? { localOnly: true } : {})
  }
}

/**
 * The workspace for work that can only run here (quick actions, file context). A draft that
 * names another computer holds that computer's project ids, so it counts for nothing here.
 */
export function localWorkspaceFor(
  draft: ComposerWorkspace | undefined,
  thread: { projectId?: string; worktreeEnabled?: boolean; node?: string; localOnly?: boolean } | undefined,
  projects: ProjectChoices
): ComposerWorkspace {
  const workspace = composerWorkspaceFor(draft, thread, projects)
  return workspace.node ? { worktreeEnabled: false } : workspace
}

/** The project of this computer a draft stands for, also while another computer is picked. */
export function localProjectIdOf(workspace: ComposerWorkspace): string | undefined {
  return workspace.node ? workspace.localProjectId : workspace.projectId
}

/**
 * The draft after going back to this computer: the project it had here comes back, if it is
 * still there. The worktree choice only counts with a project.
 */
export function workspaceOnThisComputer(
  workspace: ComposerWorkspace,
  localProjects: readonly Pick<Project, 'id'>[]
): ComposerWorkspace {
  const id = localProjectIdOf(workspace)
  const projectId = localProjects.some((project) => project.id === id) ? id : undefined
  return { projectId, worktreeEnabled: Boolean(projectId && workspace.worktreeEnabled), ...(workspace.localOnly ? { localOnly: true } : {}) }
}

/**
 * The draft after picking another computer. `projectId` is that computer's project for the same
 * repository (its row says so: `sameAs`), or none. The project the draft had on this
 * computer is kept, so going back restores it.
 */
export function workspaceOnOtherComputer(
  workspace: ComposerWorkspace,
  node: NodeId,
  matchedProjectId: string | undefined
): ComposerWorkspace {
  const local = localProjectIdOf(workspace)
  return {
    projectId: matchedProjectId,
    worktreeEnabled: Boolean(matchedProjectId && workspace.worktreeEnabled),
    node,
    ...(local ? { localProjectId: local } : {})
  }
}

/**
 * The draft with Private turned on or off. A private thread runs on this computer only, so turning it on
 * brings a draft that named another computer back here.
 */
export function workspaceWithPrivate(
  workspace: ComposerWorkspace,
  localOnly: boolean,
  localProjects: readonly Pick<Project, 'id'>[],
  /** Settings → Runs: when a new private chat deletes itself. Applied only when no expiry was picked. */
  privateDefaultMs?: number
): ComposerWorkspace {
  if (!localOnly) {
    const { localOnly: _off, expiryFromPrivateDefault, ...shared } = workspace
    if (!expiryFromPrivateDefault) return shared
    const { expiryMs: _ms, expiryStopsRun: _stop, ...kept } = shared
    return kept
  }
  const here = workspace.node ? { ...workspaceOnThisComputer(workspace, localProjects), ...withExpiryOf(workspace) } : workspace
  const withDefault = here.expiryMs === undefined && privateDefaultMs !== undefined ? { expiryMs: privateDefaultMs, expiryFromPrivateDefault: true } : {}
  return { ...here, ...withDefault, localOnly: true }
}

/** The draft's expiry fields alone. */
function withExpiryOf(workspace: ComposerWorkspace): Pick<ComposerWorkspace, 'expiryMs' | 'expiryStopsRun' | 'expiryFromPrivateDefault'> {
  return {
    ...(workspace.expiryMs !== undefined ? { expiryMs: workspace.expiryMs } : {}),
    ...(workspace.expiryStopsRun ? { expiryStopsRun: true } : {}),
    ...(workspace.expiryFromPrivateDefault ? { expiryFromPrivateDefault: true } : {})
  }
}

/**
 * The draft after picking a project in the toolbar: it takes that project's remembered checkout (which only counts
 * with a project), and the computer, Private and the expiry stay. A project of this computer replaces the one
 * remembered for another.
 */
export function workspaceWithProject(workspace: ComposerWorkspace, projectId: string | undefined, projects: ProjectChoices): ComposerWorkspace {
  // Another project shows its own remembered choices: what was picked for the previous one goes.
  const { localProjectId: _remembered, baseBranch: _branch, ...rest } = withoutPicks(workspace)
  return { ...rest, projectId, worktreeEnabled: Boolean(projectId && newThreadWorktree(projects, projectId)) }
}

/** The draft with an expiry picked by hand (`ms` from creation, or null for never). */
export function workspaceWithExpiry(workspace: ComposerWorkspace, ms: number | null, stopsRun: boolean): ComposerWorkspace {
  const { expiryMs: _ms, expiryStopsRun: _stop, expiryFromPrivateDefault: _default, ...rest } = workspace
  return ms === null ? rest : { ...rest, expiryMs: ms, ...(stopsRun ? { expiryStopsRun: true } : {}) }
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
