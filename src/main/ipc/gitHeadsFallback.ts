import type { GitHeadsRequest, GitHeadsResult, GitStatusSnapshot, GitThreadHead } from '../../shared/types'

/** What a thread's `workspace.getStatus` answers that the fallback reads. */
interface WorkspaceStatus {
  metadata?: { kind?: string; branch?: string; generation?: number; lifecycle?: string } | null
  execution?: { projectPath?: string; lifecycle?: string; placement?: string; branch?: string }
  retiredByCleanup?: { at: string; rule: string }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A thread's card from its workspace record, as an older service tells it. */
function threadHeadFromWorkspace(status: WorkspaceStatus): GitThreadHead {
  const { metadata, execution } = status
  if (execution?.placement === 'project-folder' || metadata?.kind === 'project-folder') return { project: true }
  if (!metadata) return { own: true, branch: null, generation: 0, lifecycle: 'unprovisioned' }
  const recorded = { own: true as const, branch: metadata.branch || null, generation: metadata.generation ?? 0, lifecycle: metadata.lifecycle ?? 'ready' }
  if (execution?.lifecycle === 'ready' && execution.projectPath) return { ...recorded, branch: execution.branch ?? null, folder: execution.projectPath }
  return status.retiredByCleanup || execution?.lifecycle === 'missing' ? { ...recorded, missing: true } : recorded
}

/**
 * `git.heads` for a service from before it (it lacks the method): each thread from its workspace record
 * (`workspace.getStatus`); each project from a status read. Slower, since a status read runs
 * Git, and only ever used with an older service.
 */
export async function headsFromOlderService(request: <T>(method: string, params: unknown) => Promise<T>, heads: GitHeadsRequest): Promise<GitHeadsResult> {
  const projects: GitHeadsResult['projects'] = Object.create(null)
  const threads: GitHeadsResult['threads'] = Object.create(null)
  await Promise.all([
    ...(heads.projectIds ?? []).map(async (projectId) => {
      projects[projectId] = await request<{ status: GitStatusSnapshot }>('git.status', { projectId }).then(
        ({ status }) => (status.isRepo ? { repo: true, branch: status.branch, ...(status.tracking === 'detached' ? { detachedAt: '' } : {}) } : { repo: false, branch: null }),
        (error: unknown) => ({ error: message(error) })
      )
    }),
    ...(heads.threadIds ?? []).map(async (threadId) => {
      threads[threadId] = await request<WorkspaceStatus>('workspace.getStatus', { threadId }).then(threadHeadFromWorkspace, (error: unknown) => ({ error: message(error) }))
    })
  ])
  return { projects, threads, legacy: true }
}
