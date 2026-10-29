import type {
  CreatePullRequestInput,
  GitPullRequestInfo,
  GitPullRequestLookup,
  LineCommentRead,
  PullRequestBaseBranches,
  PullRequestDetail,
  PullRequestIdentity,
  PullRequestListItem,
  PullRequestMergeMethod,
  RepositoryIdentity
} from '../../shared/pullRequests'

/**
 * Everything Mousse asks a code hosting service about pull requests. GitHub through `gh` is
 * the only implementation; callers depend on this interface, never on `gh`. `cwd` only picks the
 * command's working folder: shared reads are keyed by the repository, not by folder.
 */
export interface CodeHost {
  /** Host and `owner/repo` of the folder's repository; cached for 10 minutes per folder. */
  repositoryIdentity(cwd: string): Promise<RepositoryIdentity>
  /** The pull request for a branch, by default the folder's current one. Cached for 30 seconds per repository and branch. */
  lookupPullRequest(cwd: string, branch?: string, options?: { force?: boolean }): Promise<GitPullRequestLookup>
  /**
   * One pull request of the folder's repository with its reviews, comments and each check. Cached for 30
   * seconds per pull request and shared by every folder of the repository. A failure throws a
   * `PullRequestReadError` carrying the host's own message. With `lineComments: false` the line comments are not read (`comments` holds
   * the conversation only): a watch reads them itself, a page at a time, and keeps its own cache entry.
   */
  getPullRequestDetail(cwd: string, number: number, options?: { force?: boolean; lineComments?: boolean }): Promise<PullRequestDetail>
  createPullRequest(cwd: string, input: CreatePullRequestInput): Promise<GitPullRequestInfo>
  listBaseBranches(cwd: string): Promise<PullRequestBaseBranches>
  /** The merge method the host's own merge button offers the signed-in account in the folder's repository; null when it cannot be read. */
  defaultMergeMethod(cwd: string): Promise<PullRequestMergeMethod | null>
  /**
   * Merges a pull request of the folder's repository and returns it as read back. The head branch is kept. With `headSha`
   * the host refuses when the head moved since. A failure throws with the host's own reason.
   */
  mergePullRequest(cwd: string, number: number, options: { method: PullRequestMergeMethod; headSha?: string }): Promise<GitPullRequestInfo>
  /** Closes a pull request of the folder's repository without merging it, keeping its branch; returns it as read back. */
  closePullRequest(cwd: string, number: number): Promise<GitPullRequestInfo>
  /**
   * The remote that points at the folder's repository, else `origin`, else the only remote; null when there is none.
   * With `identity` it is only a remote whose URL is exactly that repository (same host and `owner/repo`, whatever
   * the scheme), never a fallback: a fetch or a push must not go to a repository that is merely nearby. With
   * `push` every URL the remote pushes to (`pushurl`, URL rewrites) must be that repository as well.
   */
  remoteForRepository(cwd: string, identity?: RepositoryIdentity, options?: { push?: boolean }): Promise<string | null>
  /** The open pull requests of the folder's repository, most recently updated first. Cached for 30 seconds per repository. */
  listPullRequests(cwd: string, options?: { limit?: number; force?: boolean }): Promise<PullRequestListItem[]>
  /**
   * Fetches a pull request's head commit into `refs/mousse/pull/<number>/head` of the folder's repository from the remote
   * whose URL is the pull request's repository, and returns the commit. The head may live in a fork; it is read through the
   * base repository, so no remote is added. Nothing from the fetched commits runs.
   */
  fetchPullRequestHead(cwd: string, pullRequest: PullRequestIdentity): Promise<string>
  /** Deletes the ref `fetchPullRequestHead` wrote once nothing needs it, only if it still holds `sha`. Never throws. */
  releasePullRequestHead(cwd: string, pullRequest: PullRequestIdentity, sha: string): Promise<void>
  /** The default branch name already looked up for this folder, or undefined. Never contacts the host. */
  cachedDefaultBranch(cwd: string): string | undefined
  /**
   * Line comments of a pull request updated at or after `cursor.since`, oldest update first, `maxPages` pages of 100 from
   * `cursor.page`. Not cached: a watch reads its own position. `drained` is true when a page came back short.
   */
  listLineCommentsSince(cwd: string, pullRequest: PullRequestIdentity, cursor: { since: string; page: number }, maxPages?: number): Promise<LineCommentRead>
  /**
   * Line comments created at or after `createdSince`, newest creation first, from page `page`. Creation order is never changed
   * by an edit, so a read that continues over several calls enumerates the same set. `drained` is true on a short page or as soon
   * as a page holds a comment older than `createdSince` (an older one only appears because it was edited since).
   */
  listLineCommentsCreatedSince(cwd: string, pullRequest: PullRequestIdentity, createdSince: string, page: number, maxPages?: number): Promise<LineCommentRead>
  /** The account the host's credential belongs to, or null when it cannot be read; cached for 10 minutes per host. */
  viewerLogin(cwd: string): Promise<string | null>
}
