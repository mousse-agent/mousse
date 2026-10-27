import type { ProviderScope } from '../../shared/harness/types'
import type { ModelOverride } from '../../shared/providerInstances'
import type { ScheduledJob, Thread } from '../../shared/types'
import type { ThreadWorkspaceMetadata } from '../../shared/workspace'
import { pathsEqual } from '../profiles/pathSafety'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'

/** What the validator needs to know about the profile; the protocol handler wires the real services in. */
export interface ScheduledJobOptionsDeps {
  /** `ProviderInstanceService.overrideFor`: the instance must exist and be enabled; throws the instance errors. */
  overrideFor(input: { instanceId?: string; llmProvider?: string; model: string }): ModelOverride
  /** `harness.resolveStored`: refuses a hidden model, a disabled instance and an `uncontrolled` instance for `schedule`. */
  resolveStored(selection: ModelOverride, options: { purpose: 'schedule'; scope: ProviderScope }): unknown
  getProject(projectId: string): { id: string; path: string } | undefined
  getThread(threadId: string): Thread | undefined
  /** Every thread of the project. */
  listProjectThreads(projectId: string): Thread[]
  loadWorkspace(threadId: string): ThreadWorkspaceMetadata | undefined
  isGitBacked(projectPath: string): boolean
}

/** The profile services behind `ScheduledJobOptionsDeps`; the protocol handlers and the agent tools wire the same ones. */
export interface ScheduledJobOptionsSources {
  providerInstances: { overrideFor: ScheduledJobOptionsDeps['overrideFor'] }
  /** The harness gateway; throws when the profile has not composed it yet. */
  harness(): { resolveStored: ScheduledJobOptionsDeps['resolveStored'] }
  projects: { getProject(projectId: string): { id: string; path: string } | undefined }
  threads: {
    getThread(threadId: string): Thread | undefined
    listAllThreads(): Thread[]
    getThreadDir(threadId: string): string
  }
}

export function scheduledJobOptionsDepsFrom(sources: ScheduledJobOptionsSources): ScheduledJobOptionsDeps {
  const { threads, projects } = sources
  return {
    overrideFor: (input) => sources.providerInstances.overrideFor(input),
    resolveStored: (selection, options) => sources.harness().resolveStored(selection, options),
    getProject: (projectId) => projects.getProject(projectId),
    getThread: (threadId) => threads.getThread(threadId),
    listProjectThreads: (projectId) => threads.listAllThreads().filter((thread) => thread.projectId === projectId),
    loadWorkspace: (threadId) => new ThreadWorkspaceManager(threads.getThreadDir(threadId)).load(),
    isGitBacked: (projectPath) => {
      try {
        return new ThreadWorkspaceManager('').resolveRepository(projectPath).capability.gitBacked
      } catch {
        return false
      }
    }
  }
}

/** The fields of a job these checks read; the caller passes the job as it would be after the change. */
export type ScheduledJobOptionsInput = Pick<ScheduledJob, 'threadId' | 'projectId' | 'selection' | 'mode' | 'workspace'>

/** The thread that owns a ready worktree at `path`, among the threads of one project. */
export function findWorktreeOwner(
  threads: Thread[],
  path: string,
  loadWorkspace: (threadId: string) => ThreadWorkspaceMetadata | undefined
): Thread | undefined {
  for (const thread of threads) {
    if (thread.settledAt) continue
    let workspace: ThreadWorkspaceMetadata | undefined
    try {
      workspace = loadWorkspace(thread.id)
    } catch {
      continue
    }
    if (workspace?.lifecycle === 'ready' && pathsEqual(workspace.worktreePath, path)) return thread
  }
  return undefined
}

/**
 * Checks the model, mode and workspace of a scheduled job. Throws with a message a person can act on.
 * Returns the selection as the profile stores it, and the thread a `worktree` workspace resolves to
 * (the caller stores that as the job's `threadId`).
 */
export function validateScheduledJobOptions(
  job: ScheduledJobOptionsInput,
  deps: ScheduledJobOptionsDeps
): { selection?: ModelOverride; threadId?: string } {
  const projectId = job.projectId ?? (job.threadId ? deps.getThread(job.threadId)?.projectId : undefined)
  let selection: ModelOverride | undefined
  if (job.selection) {
    if (!job.selection.model?.trim()) throw new Error('selection.model is required')
    selection = deps.overrideFor({ instanceId: job.selection.instanceId, llmProvider: job.selection.llmProvider, model: job.selection.model })
    deps.resolveStored(selection, { purpose: 'schedule', scope: projectId ? { kind: 'project', projectId } : { kind: 'device' } })
  }
  if (job.mode !== undefined && job.mode !== 'agent' && job.mode !== 'plan') throw new Error("mode must be 'agent' or 'plan'")
  return { ...(selection ? { selection } : {}), ...validateScheduledJobWorkspace(job, projectId, deps) }
}

function validateScheduledJobWorkspace(job: ScheduledJobOptionsInput, projectId: string | undefined, deps: ScheduledJobOptionsDeps): { threadId?: string } {
  const workspace = job.workspace
  if (!workspace) return {}
  if (workspace.kind === 'worktree') {
    if (typeof workspace.path !== 'string' || !workspace.path.trim()) throw new Error('workspace.path is required for an existing worktree')
    if (!projectId) throw new Error('A job that runs in an existing worktree needs a project')
    const owner = findWorktreeOwner(deps.listProjectThreads(projectId), workspace.path, deps.loadWorkspace)
    if (!owner) throw new Error('No thread in this project owns a ready worktree at ' + workspace.path)
    if (job.threadId && job.threadId !== owner.id) throw new Error('The worktree belongs to a different thread than the job targets')
    return { threadId: owner.id }
  }
  // A bound job runs in its thread's own workspace; only `worktree` names that thread.
  if (job.threadId) throw new Error('A job bound to a thread runs in that thread\'s workspace; remove workspace or the thread')
  if (!job.projectId) throw new Error(workspace.kind === 'newWorktree' ? 'A job that runs in a new worktree needs a project' : 'A job that names a workspace needs a project')
  if (workspace.kind === 'newWorktree') {
    if (job.mode === 'plan') throw new Error('A plan-mode job never provisions a worktree; use workspace project or mode agent')
    const project = deps.getProject(job.projectId)
    if (!project) throw new Error('Project not found: ' + job.projectId)
    if (!deps.isGitBacked(project.path)) throw new Error('A new worktree needs a project backed by a Git repository')
  }
  return {}
}
