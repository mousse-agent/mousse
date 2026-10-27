import type {
  CreatePullRequestInput,
  GitPullRequestInfo,
  GitPullRequestLookup,
  PullRequestBaseBranches,
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
  createPullRequest(cwd: string, input: CreatePullRequestInput): Promise<GitPullRequestInfo>
  listBaseBranches(cwd: string): Promise<PullRequestBaseBranches>
  /** The account the host's credential belongs to, or null when it cannot be read; cached for 10 minutes per host. */
  viewerLogin(cwd: string): Promise<string | null>
}
