/**
 * Pull request types shared by the daemon, the desktop app and other clients. They name
 * no hosting service: a `CodeHost` implementation fills them in.
 */

export type PullRequestCheckState = 'passing' | 'failing' | 'pending' | 'none'

export interface GitPullRequestInfo {
  number: number
  title: string
  url: string
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  /** The branch the pull request comes from and the one it targets; the host reports them with the lookup. */
  headRefName?: string
  baseRefName?: string
  checks: PullRequestCheckState
  /** `waiting` counts checks that need a maintainer's approval to run; they are also in `pending`. */
  checkCounts: { passed: number; failed: number; pending: number; waiting: number; total: number }
}

export type GitPullRequestLookup =
  | { state: 'found'; pullRequest: GitPullRequestInfo }
  /** isDefaultBranch is null when the repository's default branch could not be read. */
  | { state: 'none'; isDefaultBranch: boolean | null }
  | {
      state: 'unavailable'
      reason: 'gh-missing' | 'unauthenticated' | 'not-github' | 'no-branch' | 'error'
      message: string
    }

export interface PullRequestCheck {
  name: string
  state: PullRequestCheckState | 'skipped' | 'waiting'
  url: string | null
  workflowName?: string
}

/** The branches a pull request can target, the repository's default branch first. */
export interface PullRequestBaseBranches {
  defaultBranch: string | null
  branches: string[]
}

export interface CreatePullRequestInput {
  title: string
  body: string
  base: string
  draft: boolean
  /** The branch the pull request is opened from; the checked-out branch when absent. */
  head?: string
}

/** Names the folder a pull request call runs in: a project's folder or a thread's own worktree. */
export interface PullRequestRef {
  projectId?: string
  threadId?: string
}

export interface RepositoryIdentity {
  host: string
  nameWithOwner: string
}

export interface PullRequestIdentity extends RepositoryIdentity {
  number: number
}

/** The key shared reads of one pull request use, whichever folder asked. */
export function pullRequestIdentityKey(identity: PullRequestIdentity): string {
  return `${identity.host.toLowerCase()}\u0000${identity.nameWithOwner.toLowerCase()}\u0000${identity.number}`
}

/** A thread's link to a pull request, set when it creates one, starts from one, or watches one. */
export interface ThreadPullRequestLink {
  number: number
  url: string
  host: string
  nameWithOwner: string
  headRefName: string
  baseRefName: string
  headRepository: string | null
  isCrossRepository: boolean
  linkedAt: string
  watch?: 'off' | 'notify' | 'act'
}
