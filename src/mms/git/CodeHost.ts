import type {
  CreatePullRequestInput,
  GitPullRequestInfo,
  GitPullRequestLookup,
  PullRequestBaseBranches,
  PullRequestDetail,
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
   * `PullRequestReadError` carrying the host's own message.
   */
  getPullRequestDetail(cwd: string, number: number, options?: { force?: boolean }): Promise<PullRequestDetail>
  createPullRequest(cwd: string, input: CreatePullRequestInput): Promise<GitPullRequestInfo>
  listBaseBranches(cwd: string): Promise<PullRequestBaseBranches>
  /** The remote that points at the folder's repository, else `origin`, else the only remote; null when there is none. */
  remoteForRepository(cwd: string): Promise<string | null>
  /** The default branch name already looked up for this folder, or undefined. Never contacts the host. */
  cachedDefaultBranch(cwd: string): string | undefined
  /** The account the host's credential belongs to, or null when it cannot be read; cached for 10 minutes per host. */
  viewerLogin(cwd: string): Promise<string | null>
}
