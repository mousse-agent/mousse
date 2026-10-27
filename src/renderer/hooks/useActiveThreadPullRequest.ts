import type { ThreadPullRequestLink } from '../../shared/pullRequests'
import { pullRequestReadThreadId } from '../components/sideCard/gitSectionLogic'
import { useThreadPullRequest, type ThreadPullRequestView } from '../stores/pullRequestStore'
import { useAppStore } from '../stores/appStore'
import { gitScopeFor } from '../lib/activeProject'
import { useGitStatus } from '../stores/gitStatusStore'
import { useActiveProjectLocation } from './useActiveProjectPath'

export interface ActiveThreadPullRequest extends ThreadPullRequestView {
  location: ReturnType<typeof useActiveProjectLocation>
  git: ReturnType<typeof useGitStatus>
  /** The key of the folder the pull request is read in (`folderKey`, not a path); null when the thread has no project. */
  path: string | null
  projectId: string | null
  /** The thread whose conversation owns the pull request; null for a new chat that follows the composer's project pick. */
  ownThreadId: string | null
  /** The thread a read is made as, when the folder is that thread's own worktree. */
  folderThreadId: string | null
  /** The pull request the thread is linked to, if any. */
  link: ThreadPullRequestLink | null
  /** The branch the folder is on; null when it is not a repository. */
  branch: string | null
}

/**
 * The pull request of the thread the side card and the pull request panel show: the folder and branch
 * Git works on, the thread's link, and the shared lookup and detail reads. Both surfaces read it here so
 * they always agree on which pull request they mean.
 */
export function useActiveThreadPullRequest(threadId: string | null): ActiveThreadPullRequest {
  // The same project the Git panel opens on, including a new chat's composer pick.
  const location = useActiveProjectLocation()
  const { projectId } = location
  // A project-less thread has no folder of its own to show Git state for.
  const path = projectId ? location.key : null
  const git = useGitStatus(path, gitScopeFor(location))
  // A thread's own conversation drafts and receives its pull request. A new chat that follows the composer's
  // project pick has no thread of its own yet; it asks about the project.
  const threadProjectId = useAppStore((state) => state.threads.find((thread) => thread.id === threadId)?.projectId ?? null)
  const ownThreadId = threadId && projectId !== null && threadProjectId === projectId ? threadId : null
  const folderThreadId = pullRequestReadThreadId(ownThreadId, location.workspaceThreadId)
  const link = useAppStore((state) => (ownThreadId ? state.threads.find((thread) => thread.id === ownThreadId)?.pullRequest ?? null : null))
  const branch = git.status?.isRepo ? git.status.branch : null
  // No branch, or not a repository: nothing to look up. A branch without an upstream is looked up on focus only once it has a pull request.
  const view = useThreadPullRequest({
    path,
    branch,
    projectId,
    threadId: folderThreadId,
    tracked: git.status?.tracking === 'tracked',
    link
  })
  return { ...view, location, git, path, projectId, ownThreadId, folderThreadId, link, branch }
}
