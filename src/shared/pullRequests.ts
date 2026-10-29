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
  /** `others` are the branch's earlier (or other) pull requests in this repository, newest first; absent from older daemons. */
  | { state: 'found'; pullRequest: GitPullRequestInfo; others?: GitPullRequestInfo[] }
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
  /** How the author relates to the repository, as the host says it: `OWNER`, `MEMBER`, `COLLABORATOR`, `NONE`, ... */
  authorAssociation: string
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
  /** Whether the host would merge it now; absent from older daemons, which reads as unknown. */
  mergeState?: PullRequestMergeState
}

/**
 * Whether the host would merge a pull request now (GitHub's `mergeStateStatus`, with `mergeable` for conflicts).
 * `clean` merges; `unstable` merges with checks that are not passing; `unknown` is still being worked out by the host.
 */
export type PullRequestMergeState = 'clean' | 'unstable' | 'blocked' | 'behind' | 'conflicting' | 'draft' | 'unknown'

/** How a pull request is merged: a merge commit, one squashed commit, or its commits rebased onto the base. */
export type PullRequestMergeMethod = 'merge' | 'squash' | 'rebase'

/** A pull request after a merge or a close, read back from the host. */
export interface PullRequestActionResult {
  pullRequest: GitPullRequestInfo
  /** The method a merge used; absent for a close. */
  method?: PullRequestMergeMethod
}

/** One open pull request in the project's list, with what is needed to pick one to start a thread from. */
export interface PullRequestListItem {
  number: number
  title: string
  url: string
  isDraft: boolean
  author: string
  headRefName: string
  /** The head branch lives in another repository (a fork). */
  isCrossRepository: boolean
  updatedAt: string
}

/** A pull request named by the user: a number, or a URL or `gh pr checkout` command that also names a repository. */
export interface PullRequestReference {
  number: number
  /** Present when the text named a repository (a URL). */
  host?: string
  nameWithOwner?: string
}

const PULL_REQUEST_REFERENCE_MAX = 2048
const POSITIVE_INTEGER = /^[1-9]\d{0,14}$/

/**
 * Reads a pull request from what a user pastes: `123`, `#123`, `https://<host>/<owner>/<repo>/pull/123`
 * (with anything after the number, such as `/files`), or `gh pr checkout 123` with a number or URL. Only
 * `http(s)` URLs without credentials count and the number must be a positive integer; anything else is
 * null. Whether the repository is the project's is a separate check (`pullRequestReferenceMismatch`).
 */
export function parsePullRequestReference(text: string): PullRequestReference | null {
  let value = text.trim()
  if (!value || value.length > PULL_REQUEST_REFERENCE_MAX) return null
  const command = /^gh\s+pr\s+checkout\s+(\S+)$/i.exec(value)
  if (command) value = command[1]
  const plain = /^#?(\d+)$/.exec(value)
  if (plain) return POSITIVE_INTEGER.test(plain[1]) ? { number: Number(plain[1]) } : null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !url.hostname) return null
  const [owner, repository, kind, number] = url.pathname.split('/').filter((segment, index) => index > 0 || segment !== '').map((segment) => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return ''
    }
  })
  if (!owner || !repository || kind !== 'pull' || number === undefined || !POSITIVE_INTEGER.test(number)) return null
  if ([owner, repository].some((segment) => /[\s\\/]/.test(segment))) return null
  return { number: Number(number), host: url.host.toLowerCase(), nameWithOwner: `${owner}/${repository}` }
}

/**
 * Why a reference cannot be started from the project whose repository is `identity`; null when it can. A bare
 * number always belongs to the project's repository. A URL must name its host and `owner/repo`, compared
 * ignoring case.
 */
export function pullRequestReferenceMismatch(reference: PullRequestReference, identity: RepositoryIdentity): string | null {
  if (reference.host === undefined || reference.nameWithOwner === undefined) return null
  if (reference.host.toLowerCase() === identity.host.toLowerCase() && reference.nameWithOwner.toLowerCase() === identity.nameWithOwner.toLowerCase()) return null
  return `That pull request belongs to ${reference.host}/${reference.nameWithOwner}, not this project's repository (${identity.host}/${identity.nameWithOwner}).`
}

/** What the start dialog shows for the pull request a pasted reference names. */
export interface PullRequestSummary {
  number: number
  title: string
  url: string
  state: GitPullRequestInfo['state']
  isDraft: boolean
  author: string
  headRefName: string
  isCrossRepository: boolean
}

export interface ResolvedPullRequestSummary {
  pullRequest: PullRequestSummary
  /** Threads that already work on this pull request (not archived). */
  threads: Array<{ id: string; name: string }>
}

export interface StartPullRequestThreadInput {
  projectId: string
  /** A number, or a URL or `gh pr checkout` command naming the pull request. */
  reference: string
  /** Send the seed (and `message`) as the thread's first message; the GUI puts the seed in the composer instead. */
  send?: boolean
  message?: string
  /** Allow a merged or closed pull request. */
  allowClosed?: boolean
  /** Start even though another thread already works on this pull request. */
  allowDuplicate?: boolean
}

/** What starting a thread from a pull request returns beside the thread itself. */
export interface StartPullRequestThreadResult {
  /** The message the thread starts from: the pull request's title, description and open review comments. */
  seed: string
  /** The commit the thread's worktree starts at. */
  headSha: string
  /** The pull request's head moved between the host's answer and the fetch, so the thread starts at the newer commit. */
  headMoved: boolean
  /** True when the seed was sent as the thread's first message. */
  sent: boolean
  /** Why a requested send did not happen (the text is from people who are not owners, members or collaborators, or the send failed); null otherwise. */
  withheld: string | null
}

/** Where a thread's Push goes and why, when the thread is linked to a pull request. */
export interface PullRequestPushTarget {
  /** The local remote and the branch Push updates; null when Push keeps its usual target. */
  remote: string | null
  branch: string | null
  /** Why Push keeps its usual target ("push by hand"); null when the pull request's branch is the target. */
  reason: string | null
}

/** What a watch does when its pull request changes: nothing, tell the thread, or tell the thread and wake the agent. */
export type PullRequestWatchMode = 'off' | 'notify' | 'act'

/** One page-bounded read of line comments: `drained` says the read reached the end; otherwise it continues at `nextPage`. */
export interface LineCommentRead {
  comments: PullRequestComment[]
  drained: boolean
  nextPage: number
  /** The latest time any comment read was updated, as the host wrote it; null when none was read. */
  newestUpdatedAt: string | null
  /** How many requests the read made. */
  pages?: number
}

/** Why a watch ended; the thread gets a line that names it. */
export type PullRequestWatchEnd =
  | 'merged'
  | 'closed'
  | 'id_cap'
  | 'read_failures'
  | 'not_found'
  | 'signed_out'
  | 'stopped'
  | 'unlinked'
  | 'project_missing'
  | 'settled'
  | 'trashed'

/** What a thread's watch is doing now, for the side card. */
export interface PullRequestWatchStatus {
  threadId: string
  mode: PullRequestWatchMode
  /** `watching`: polling; `paused`: waiting out a rate limit or a sign-out; `ended`: stopped on its own, see `ended`; `off`. */
  state: 'watching' | 'paused' | 'ended' | 'off'
  /** When the next read is due; null when nothing is scheduled. */
  nextCheckAt: string | null
  ended: { reason: PullRequestWatchEnd; at: string } | null
  /** The account the host's credential belongs to; its own comments are not reported. */
  viewer: string | null
  host: string | null
  /** `act` cannot be turned on: a subagent's pending notice would hold its parent's task open. */
  actRefusal: string | null
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
  /** The thread was started from this pull request, so its worktree begins at the pull request's head and Push may go to its branch. */
  startedFromPullRequest?: true
  watch?: PullRequestWatchMode
}

/** Whether `link` is the same pull request as `other` (host, repository and number, ignoring case). */
export function sameLinkedPullRequest(link: Pick<ThreadPullRequestLink, 'host' | 'nameWithOwner' | 'number'> | undefined, other: Pick<ThreadPullRequestLink, 'host' | 'nameWithOwner' | 'number'> | undefined): boolean {
  if (!link || !other) return false
  return link.number === other.number && link.host.toLowerCase() === other.host.toLowerCase() && link.nameWithOwner.toLowerCase() === other.nameWithOwner.toLowerCase()
}

/**
 * The link a thread keeps when `next` replaces `previous`. A new record always carries no watch, so a link written again
 * for the same pull request (a re-link, the create form finding the pull request it made) keeps the thread's watch; a
 * different pull request starts unwatched, because what was watched is no longer what the thread is linked to.
 */
export function relinked(previous: ThreadPullRequestLink | undefined, next: ThreadPullRequestLink): ThreadPullRequestLink {
  if (next.watch !== undefined || !previous?.watch || !sameLinkedPullRequest(previous, next)) return next
  return { ...next, watch: previous.watch }
}
