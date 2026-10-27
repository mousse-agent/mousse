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
  /** The branch the pull request is opened from, named explicitly so a checkout that moved meanwhile cannot change it. */
  head: string
}

/** What the create form submits; the scope supplies the branch and the folder. */
export interface PullRequestFormInput {
  title: string
  body: string
  base: string
  draft: boolean
}

/** A title and description proposed for a branch. `source` says whether a model or the plain fallback wrote it. */
export interface PullRequestDraft {
  title: string
  body: string
  base: string
  source: 'model' | 'heuristic'
}

/** `existing` is true when the branch already had an open pull request, which is returned instead of a new one. */
export interface CreatePullRequestResult {
  pullRequest: GitPullRequestInfo
  existing: boolean
}

/** Names the folder a pull request call runs in: a project's folder or a thread's own worktree. */
export interface PullRequestRef {
  projectId?: string
  threadId?: string
}

/**
 * Everything a pull request action needs, captured when it starts and never read from the active
 * thread or the current checkout afterwards: the folder (`projectId` or `threadId`, as for every
 * pull request call), the thread whose conversation drafts the description and receives the link,
 * the folder's path (the key of the cached lookup) and the branch the action is bound to.
 */
export interface PullRequestScope extends PullRequestRef {
  originThreadId: string | null
  path: string
  branch: string
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

/** What the host says about the approval of a pull request; null when no review is required and none was given. */
export type PullRequestReviewDecision = 'approved' | 'changes_requested' | 'review_required'

export type PullRequestReviewVerdict = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending'

export interface PullRequestReview {
  id: string
  author: string
  /** The host's word for how the author relates to the repository, for example `OWNER`, `MEMBER` or `NONE`. */
  authorAssociation: string
  state: PullRequestReviewVerdict
  body: string
  bodyTruncated: boolean
  submittedAt: string | null
  /** The author changed the review after posting it. */
  edited: boolean
  url: string
}

/** A comment on the conversation (`path` is null) or on a line of the diff. */
export interface PullRequestComment {
  id: string
  author: string
  authorAssociation: string
  body: string
  /** The body was cut; the full text is on the host. */
  bodyTruncated: boolean
  createdAt: string
  edited: boolean
  url: string
  path: string | null
  /** Null for a conversation comment, and for a line comment whose line is no longer in the diff. */
  line: number | null
  startLine: number | null
  side: 'LEFT' | 'RIGHT' | null
  inReplyTo: string | null
}

/** A pull request with everything the side card and the pull request panel show. */
export interface PullRequestDetail extends GitPullRequestInfo {
  identity: PullRequestIdentity
  body: string
  author: string
  headRefName: string
  baseRefName: string
  headSha: string
  /** `owner/repo` of the head branch; null when that repository was deleted. */
  headRepository: string | null
  baseRepository: string
  isCrossRepository: boolean
  reviewDecision: PullRequestReviewDecision | null
  reviews: PullRequestReview[]
  /** Conversation comments and line comments, oldest first. */
  comments: PullRequestComment[]
  /** More line comments exist than the newest ones held in `comments`. */
  commentsTruncated: boolean
  /** Every check with its own state and link. */
  checkRuns: PullRequestCheck[]
  updatedAt: string
  mergedAt: string | null
  closedAt: string | null
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
