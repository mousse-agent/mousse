import type { GitScope } from '../../shared/types'

/**
 * Daemon parameters for a Git mutation. A thread working in its own worktree is named by the thread,
 * so the daemon applies the thread rules there; any other folder is named by its project.
 * The scope comes from the renderer, so anything but a string id is ignored.
 */
export function daemonGitParams(scope: GitScope | null | undefined, args: Record<string, unknown> = {}): Record<string, unknown> {
  const threadId = typeof scope?.workspaceThreadId === 'string' && scope.workspaceThreadId ? scope.workspaceThreadId : undefined
  const projectId = typeof scope?.projectId === 'string' && scope.projectId ? scope.projectId : undefined
  return threadId ? { ...args, threadId } : { ...args, projectId }
}
