import { existsSync, rmdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  parsePullRequestReference,
  pullRequestIdentityKey,
  pullRequestReferenceMismatch,
  type PullRequestDetail,
  type PullRequestIdentity,
  type RepositoryIdentity,
  type StartPullRequestThreadInput,
  type StartPullRequestThreadResult,
  type ThreadPullRequestLink,
  WORKTREE_CONFIG_ENABLED,
  WORKTREE_CONFIG_NEEDED
} from '../../shared/pullRequests'
import { buildPullRequestSeed, pullRequestSeedTrust } from '../../shared/pullRequestSeed'
import type { Thread } from '../../shared/types'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import { perWorktreeConfigEnabled, ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import type { CodeHost } from './CodeHost'
import { PullRequestReadError } from './GitHubCodeHost'
import { acquireRepositoryLease } from './RepositoryLease'
import { resolveRepositoryIdentity } from './RepositoryIdentity'
import { repoProgramEnv, withoutRepoPrograms } from './repoPrograms'
import type { UserAction } from './gitPolicy'

/** A refusal with a code a client can show copy for; the daemon turns it into its own error type. */
export class PullRequestThreadError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'PullRequestThreadError'
  }
}

const THREAD_NAME_MAX = 120

export interface PullRequestThreadDeps {
  codeHost: CodeHost
  projects: { getProject(projectId: string): { id: string; path: string } | undefined }
  threads: Pick<ThreadDataStore, 'createThread' | 'updateThreadMeta' | 'listAllThreads' | 'getThreadDir' | 'discardUnusedThread'>
  /** Moves a thread to the trash through the lifecycle coordinator; used when a failed start cannot simply discard it. */
  trashThread(threadId: string): Promise<unknown>
  /** Finishes a new thread the way every new thread is finished (its model selection). */
  prepareThread?(thread: Thread): Thread
  /** Sends the first message of a thread. */
  send(threadId: string, content: string): Promise<void>
  /** Writes a line into a thread once per `messageId`, waking nothing: how a start says what it changed in the repository. */
  note?(threadId: string, text: string, messageId: string): Promise<unknown>
}

/** What `resolve` tells a client about a pull request before a thread is started. */
export interface ResolvedPullRequest {
  detail: PullRequestDetail
  /** Threads that are linked to this pull request and not archived. */
  threads: Array<{ id: string; name: string }>
  /** Starting would turn on `extensions.worktreeConfig` in the repository, which the start dialog says before it runs. */
  enablesWorktreeConfig: boolean
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', withoutRepoPrograms(cwd, args), { cwd, env: repoProgramEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function sameRepository(link: Pick<ThreadPullRequestLink, 'host' | 'nameWithOwner' | 'number'>, identity: PullRequestIdentity): boolean {
  return link.number === identity.number
    && link.host.toLowerCase() === identity.host.toLowerCase()
    && link.nameWithOwner.toLowerCase() === identity.nameWithOwner.toLowerCase()
}

function linkFromDetail(detail: PullRequestDetail): ThreadPullRequestLink {
  return {
    number: detail.number,
    url: detail.url,
    host: detail.identity.host,
    nameWithOwner: detail.identity.nameWithOwner,
    headRefName: detail.headRefName,
    baseRefName: detail.baseRefName,
    headRepository: detail.headRepository,
    isCrossRepository: detail.isCrossRepository,
    linkedAt: new Date().toISOString(),
    startedFromPullRequest: true
  }
}

/**
 * Starts of one pull request run one at a time per profile, from the duplicate check to the link: two clients
 * (or a retry) cannot both pass the check, and fetches into the same ref never overlap. The service is built
 * per request, so the queue is kept by the profile's thread store.
 */
const queues = new WeakMap<object, Map<string, Promise<void>>>()

async function exclusively<T>(owner: object, key: string, run: () => Promise<T>): Promise<T> {
  let map = queues.get(owner)
  if (!map) queues.set(owner, (map = new Map()))
  const previous = map.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const mine = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => mine)
  map.set(key, tail)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (map.get(key) === tail) map.delete(key)
  }
}

/**
 * Starts a thread from an existing pull request. The thread is an ordinary new thread with its own worktree, begun at
 * the pull request's head commit: that commit is fetched into a ref of Mousse's own from the remote that is the pull
 * request's repository, so a pull request from a fork needs no new remote. The commits are someone else's: the
 * worktree is made and kept so that nothing they carry runs (see `ThreadWorkspaceManager.provision`). The thread is
 * linked to the pull request at once.
 */
export class PullRequestThreadService {
  constructor(private readonly deps: PullRequestThreadDeps) {}

  private project(projectId: string): { id: string; path: string } {
    const project = this.deps.projects.getProject(projectId)
    if (!project) throw new PullRequestThreadError('project_not_found', 'Project not found', { projectId })
    return project
  }

  /** The pull request a reference names in the project's repository: validated, then read in full. */
  async resolve(projectId: string, reference: string, options: { force?: boolean } = {}): Promise<ResolvedPullRequest> {
    const project = this.project(projectId)
    const parsed = parsePullRequestReference(reference)
    if (!parsed) throw new PullRequestThreadError('invalid_params', 'Enter a pull request number, its URL, or a `gh pr checkout` command.')
    let identity: RepositoryIdentity
    try {
      identity = await this.deps.codeHost.repositoryIdentity(project.path)
    } catch (error) {
      throw new PullRequestThreadError('pull_request_unavailable', error instanceof Error ? error.message : String(error))
    }
    const mismatch = pullRequestReferenceMismatch(parsed, identity)
    if (mismatch) throw new PullRequestThreadError('pull_request_wrong_repository', mismatch, { host: parsed.host, nameWithOwner: parsed.nameWithOwner })
    let detail: PullRequestDetail
    try {
      detail = await this.deps.codeHost.getPullRequestDetail(project.path, parsed.number, { force: options.force === true })
    } catch (error) {
      const kind = error instanceof PullRequestReadError ? error.kind : 'error'
      throw new PullRequestThreadError(
        kind === 'not-found' ? 'pull_request_not_found' : kind === 'rate-limited' ? 'pull_request_rate_limited' : 'pull_request_unavailable',
        error instanceof Error ? error.message : String(error),
        { number: parsed.number }
      )
    }
    return { detail, threads: this.threadsOf(detail.identity), enablesWorktreeConfig: !perWorktreeConfigEnabled(project.path) }
  }

  private threadsOf(identity: PullRequestIdentity): Array<{ id: string; name: string }> {
    return this.deps.threads.listAllThreads()
      .filter((thread) => thread.pullRequest && !thread.settledAt && sameRepository(thread.pullRequest, identity))
      .map((thread) => ({ id: thread.id, name: thread.name }))
  }

  /**
   * `userRequested` is the user's Start thread from pull request. It covers the steps that action names and
   * nothing after it: the repository gets `extensions.worktreeConfig` turned on, so the worktree can hold its
   * own safety settings.
   */
  async startThread(input: StartPullRequestThreadInput, userRequested: UserAction): Promise<StartPullRequestThreadResult & { thread: Thread }> {
    const project = this.project(input.projectId)
    const { detail } = await this.resolve(input.projectId, input.reference, { force: true })
    if (detail.state !== 'open' && input.allowClosed !== true) {
      throw new PullRequestThreadError('pull_request_closed', `Pull request #${detail.number} is ${detail.state}. Start from it anyway to see its changes.`, { state: detail.state })
    }
    // From here to the link nobody else starts from this pull request, so the check below holds until the link exists.
    return exclusively(this.deps.threads, pullRequestIdentityKey(detail.identity), () => this.startExclusively(project, detail, input, userRequested))
  }

  private async startExclusively(project: { id: string; path: string }, detail: PullRequestDetail, input: StartPullRequestThreadInput, userRequested: UserAction): Promise<StartPullRequestThreadResult & { thread: Thread }> {
    const existing = this.threadsOf(detail.identity)
    if (existing.length > 0 && input.allowDuplicate !== true) {
      throw new PullRequestThreadError(
        'pull_request_thread_exists',
        `"${existing[0].name}" already works on pull request #${detail.number}.`,
        { threadId: existing[0].id, threadName: existing[0].name }
      )
    }
    // The checkout is only fetched into, so uncommitted changes in it are no reason to refuse.
    let topLevel: string
    try {
      topLevel = git(project.path, ['rev-parse', '--show-toplevel'])
    } catch {
      throw new PullRequestThreadError('pull_request_not_git', 'The project folder is not a Git repository.')
    }
    // The repository's configuration changes only when the person agreed to it; a client that did not ask (an older one
    // included) is refused before anything is fetched or made.
    if (input.allowWorktreeConfig !== true && !perWorktreeConfigEnabled(topLevel)) {
      throw new PullRequestThreadError('pull_request_worktree_config_needed', WORKTREE_CONFIG_NEEDED, { setting: 'extensions.worktreeConfig' })
    }
    let headSha: string
    try {
      headSha = await this.deps.codeHost.fetchPullRequestHead(topLevel, detail.identity)
    } catch (error) {
      throw new PullRequestThreadError('pull_request_fetch_failed', error instanceof Error ? error.message : String(error))
    }
    try {
      return await this.createThread(project, topLevel, detail, headSha, input, userRequested)
    } finally {
      // The thread's own branch and retained ref hold the commit now; the fetched ref was only the way to get it.
      await this.deps.codeHost.releasePullRequestHead(topLevel, detail.identity, headSha)
    }
  }

  private async createThread(
    project: { id: string; path: string },
    topLevel: string,
    detail: PullRequestDetail,
    headSha: string,
    input: StartPullRequestThreadInput,
    userRequested: UserAction
  ): Promise<StartPullRequestThreadResult & { thread: Thread }> {
    const headMoved = headSha.toLowerCase() !== detail.headSha.toLowerCase()
    const name = `PR #${detail.number}: ${detail.title}`.replace(/\s+/g, ' ').trim().slice(0, THREAD_NAME_MAX)
    let thread = this.deps.threads.createThread(name, project.id, project.path, { worktreeEnabled: true })
    // The one change this start may make to the person's repository configuration, only when they agreed to it, made
    // under the repository's lease once nothing can refuse, and said in the result and in the thread. Never turned off
    // again: other worktrees may rely on it by then.
    let repositoryConfigChange: string | null = null
    try {
      const threadDirectory = this.deps.threads.getThreadDir(thread.id)
      await new ThreadWorkspaceManager(threadDirectory).provision(thread.id, 'main', project.path, undefined, undefined, headSha, {
        untrusted: true,
        userRequested,
        ...(input.allowWorktreeConfig === true ? { enableWorktreeConfig: () => { repositoryConfigChange = WORKTREE_CONFIG_ENABLED } } : {})
      })
    } catch (error) {
      await this.discard(thread.id, project.path, topLevel)
      const said = repositoryConfigChange ? ` ${repositoryConfigChange}` : ''
      throw new PullRequestThreadError('pull_request_workspace_failed', `Could not create the worktree for pull request #${detail.number}: ${error instanceof Error ? error.message : String(error)}${said}`)
    }
    try {
      thread = this.deps.threads.updateThreadMeta(thread.id, { pullRequest: linkFromDetail(detail) })
      if (this.deps.prepareThread) thread = this.deps.prepareThread(thread)
    } catch (error) {
      await this.discard(thread.id, project.path, topLevel)
      const said = repositoryConfigChange ? ` ${repositoryConfigChange}` : ''
      throw new PullRequestThreadError('pull_request_workspace_failed', `Could not set up the thread for pull request #${detail.number}: ${error instanceof Error ? error.message : String(error)}${said}`)
    }

    if (repositoryConfigChange && this.deps.note) {
      await this.deps.note(thread.id, repositoryConfigChange, `msg:worktree-config:${thread.id}`).catch((error: unknown) => {
        console.warn('the repository setting notice could not be written', { threadId: thread.id, error: error instanceof Error ? error.message : String(error) })
      })
    }

    const seed = buildPullRequestSeed(detail, { headSha })
    let sent = false
    let withheld: string | null = null
    if (input.send === true) {
      // Text from strangers is never a turn nobody read: only owners, members and collaborators may be quoted in one.
      const trust = pullRequestSeedTrust(detail)
      if (!trust.trusted) {
        const reasons = [
          ...(trust.untrusted.length ? [`the message quotes people who are not owners, members or collaborators (${trust.untrusted.slice(0, 5).join(', ')})`] : []),
          // A failed read (often GitHub's rate limit) is not a verdict on the person.
          ...(trust.unchecked.length ? [`GitHub could not be asked whether ${trust.unchecked.slice(0, 5).join(', ')} ${trust.unchecked.length === 1 ? 'is an owner, member or collaborator' : 'are owners, members or collaborators'}`] : [])
        ]
        withheld = `Not sent: ${reasons.join(', and ')}. Read it and send it yourself.`
      } else {
        const message = input.message?.trim()
        try {
          await this.deps.send(thread.id, message ? `${seed}\n\n${message}` : seed)
          sent = true
        } catch (error) {
          // The thread exists and is linked; only its first message did not go.
          withheld = `The first message could not be sent: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
    return { thread, seed, headSha, headMoved, sent, withheld, repositoryConfigChange }
  }

  /**
   * Removes a thread whose start failed: whatever the failed provisioning left in the repository (a worktree, its
   * branch, its retained ref), under the repository's lease like provisioning itself, then the thread. A thread
   * nothing has used is discarded, so a failed start leaves nothing behind. When the worktree cannot be removed
   * (a file in it is held open) or the thread cannot be discarded, nothing is half-removed: the thread goes to the trash.
   */
  private async discard(threadId: string, projectPath: string, topLevel: string): Promise<void> {
    let removed = true
    let lease: Awaited<ReturnType<typeof acquireRepositoryLease>> | undefined
    try {
      const manager = new ThreadWorkspaceManager(this.deps.threads.getThreadDir(threadId))
      const workspace = manager.load()
      if (workspace) {
        lease = await acquireRepositoryLease(resolveRepositoryIdentity(topLevel, { requireMutationCapability: true }))
        const primary = manager.resolveRepository(projectPath).primaryCheckoutPath
        const attempt = (args: string[]) => {
          try {
            git(primary, args)
            return true
          } catch {
            return false
          }
        }
        // Only this worktree's registration goes, also when its folder is already gone. No `git worktree prune`: that
        // would drop every stale registration in the person's repository, not just the one this start made.
        attempt(['worktree', 'remove', '--force', workspace.worktreePath])
        removed = !existsSync(workspace.worktreePath)
        if (removed) {
          attempt(['branch', '-D', workspace.branch])
          attempt(['update-ref', '-d', workspace.retainedRef])
          try {
            // The folder provisioning made for the worktree; only removed when it is empty.
            rmdirSync(dirname(workspace.worktreePath))
          } catch {
            // Not empty or already gone.
          }
        }
      }
    } catch (error) {
      removed = false
      console.warn('a failed pull request thread start could not clean its worktree', { threadId, error: error instanceof Error ? error.message : String(error) })
    } finally {
      lease?.release()
    }
    if (removed) {
      try {
        this.deps.threads.discardUnusedThread(threadId)
        return
      } catch (error) {
        console.warn('a failed pull request thread start could not discard its thread; trashing it', { threadId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    await this.deps.trashThread(threadId).catch((trashError: unknown) => {
      console.warn('a failed pull request thread start could not trash its thread', { threadId, error: trashError instanceof Error ? trashError.message : String(trashError) })
    })
  }
}
