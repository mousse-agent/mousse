import type { GitScope } from '../../shared/types'
import { isQualifiedId } from '../../shared/threadRef'

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

/**
 * {@link daemonGitParams} for a Git panel read, with what a current service checks: the worktree generation the window
 * looked up (a rebuilt worktree is refused, not read as the old one) and a Retry's number (a fresh read, never one
 * already in flight). Neither goes to an older service (`current` false) or to another computer, whose methods do not
 * take them.
 */
export function daemonGitReadParams(scope: GitScope | null | undefined, current: boolean, args: Record<string, unknown> = {}): Record<string, unknown> {
  const params = daemonGitParams(scope, args)
  const named = params.threadId ?? params.projectId
  if (!current || !scope || isQualifiedId(named)) return params
  const { workspaceGeneration, attempt: retry } = scope
  const generation = Number.isSafeInteger(workspaceGeneration) && params.threadId ? { workspaceGeneration } : {}
  const attempt = Number.isSafeInteger(retry) ? { attempt: retry } : {}
  return { ...params, ...generation, ...attempt }
}
