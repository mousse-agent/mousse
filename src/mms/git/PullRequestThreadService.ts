import { lstat, readFile, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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
import { resolveRepositoryIdentityAsync } from './RepositoryIdentity'
import { repoProgramEnv, withoutRepoProgramsAsync } from './repoPrograms'
import { gitRunError, runGitProcess } from './runGitProcess'
import { rethrowGitPolicyError, type UserAction } from './gitPolicy'
import { getMousseHomeDir } from '../data/paths'
import { unregisterDeletedAsync, worktreeRegisteredAsync } from '../lifecycle/verifiedDelete'
import { verifiedCleanupAsync } from '../worktree/verifiedCleanup'
import { withDrivers } from './gitEnv'
import { ignoredFilesOf } from '../worktree/WorktreeManager'
import { blobId, linkedAdminDir, readAdminFilesAsync } from '../lifecycle/worktreeAdminData'

/**
 * What a start made: the pull request's head it fetched, and Git's own data of the worktree (each file's blob id, by
 * path) as provisioning left it, read once it returned. Absent when provisioning did not finish.
 */
interface StartMade { headSha: string; admin?: { format: string; files: Map<string, string> } }

/** Git's own data of the worktree at `worktreePath`, as {@link StartMade} holds it. */
async function adminFilesOf(worktreePath: string): Promise<NonNullable<StartMade['admin']>> {
  const { adminDir, commonDir } = await linkedAdminDir(worktreePath)
  const format = await git(commonDir, ['rev-parse', '--show-object-format'])
  return { format, files: new Map((await readAdminFilesAsync(adminDir)).map((file) => [file.path, blobId(file.bytes, format)])) }
}

/** Whether anything is at `path`, a link not followed. */
const present = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false)

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

/** Git in the person's repository, without blocking the daemon; the central check runs first. */
async function git(cwd: string, args: string[]): Promise<string> {
  const argv = await withoutRepoProgramsAsync(cwd, args)
  const ran = await runGitProcess(argv, { cwd, env: repoProgramEnv() })
  if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
  return ran.stdout.trim()
}

/** {@link git}, with what Git printed as it printed it: listings with `-z` keep their first entry's leading space. */
async function gitListing(cwd: string, args: string[]): Promise<string> {
  const argv = await withoutRepoProgramsAsync(cwd, args)
  const ran = await runGitProcess(argv, { cwd, env: repoProgramEnv() })
  if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
  return ran.stdout
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
    return { detail, threads: this.threadsOf(detail.identity), enablesWorktreeConfig: !await perWorktreeConfigEnabled(project.path) }
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
      topLevel = await git(project.path, ['rev-parse', '--show-toplevel'])
    } catch {
      throw new PullRequestThreadError('pull_request_not_git', 'The project folder is not a Git repository.')
    }
    // The repository's configuration changes only when the person agreed to it; a client that did not ask (an older one
    // included) is refused before anything is fetched or made.
    if (input.allowWorktreeConfig !== true && !await perWorktreeConfigEnabled(topLevel)) {
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
    const made: StartMade = { headSha }
    try {
      const threadDirectory = this.deps.threads.getThreadDir(thread.id)
      const workspace = await new ThreadWorkspaceManager(threadDirectory).provision(thread.id, 'main', project.path, undefined, undefined, headSha, {
        untrusted: true,
        userRequested,
        nameFrom: name,
        ...(input.allowWorktreeConfig === true ? { enableWorktreeConfig: () => { repositoryConfigChange = WORKTREE_CONFIG_ENABLED } } : {})
      })
      // What Mousse itself wrote there, read before anything else can: a failed start lets go of only these bytes.
      made.admin = await adminFilesOf(workspace.worktreePath).catch(() => undefined)
    } catch (error) {
      await this.discard(thread.id, project.path, topLevel, made)
      const said = repositoryConfigChange ? ` ${repositoryConfigChange}` : ''
      throw new PullRequestThreadError('pull_request_workspace_failed', `Could not create the worktree for pull request #${detail.number}: ${error instanceof Error ? error.message : String(error)}${said}`)
    }
    try {
      thread = this.deps.threads.updateThreadMeta(thread.id, { pullRequest: linkFromDetail(detail) })
      if (this.deps.prepareThread) thread = this.deps.prepareThread(thread)
    } catch (error) {
      await this.discard(thread.id, project.path, topLevel, made)
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
   * branch, its retained ref), then the thread. A thread nothing has used is discarded, so a failed start leaves nothing
   * behind. The worktree's folder is never removed by Git: it is deleted against a proof (`verifiedCleanupAsync`, which
   * takes the thread's and the repository's locks itself), with no filter driver run for someone else's commits, and Git
   * only unregisters a folder that is already gone. Anything unexpected (uncommitted changes, a file in use, a copy kept
   * of files no commit holds, a commit made there, Git's own data of it not exactly what the start wrote) leaves nothing
   * half-removed: the thread goes to the trash, with its branch, its retained ref and every copy it owns.
   */
  private async discard(threadId: string, projectPath: string, topLevel: string, made: StartMade): Promise<void> {
    let removed = true
    let lease: Awaited<ReturnType<typeof acquireRepositoryLease>> | undefined
    try {
      const threadDirectory = this.deps.threads.getThreadDir(threadId)
      const manager = new ThreadWorkspaceManager(threadDirectory)
      const workspace = manager.load()
      if (workspace) {
        const primary = (await manager.resolveRepositoryAsync(projectPath)).primaryCheckoutPath
        const attempt = async (args: string[]): Promise<boolean> => {
          try {
            await git(primary, args)
            return true
          } catch (error) {
            rethrowGitPolicyError(error)
            return false
          }
        }
        const cleaned = await this.deleteWorktree(threadDirectory, primary, workspace, made)
        lease = await acquireRepositoryLease(await resolveRepositoryIdentityAsync(topLevel, { requireMutationCapability: true }))
        // Only this worktree's registration goes, once its folder is gone. No `git worktree prune`: that would drop every
        // stale registration in the person's repository, not just the one this start made.
        const commonDir = resolve(primary, await git(primary, ['rev-parse', '--git-common-dir']))
        if (cleaned && !await present(workspace.worktreePath) && await worktreeRegisteredAsync(commonDir, workspace.worktreePath)) {
          const outcome = await unregisterDeletedAsync({ commonDir, path: workspace.worktreePath, place: 'cleanup', held: async () => () => undefined, unregistered: async () => undefined })
          if ('kept' in outcome) throw new Error(outcome.kept)
        }
        removed = cleaned && !await present(workspace.worktreePath)
        if (removed && typeof cleaned === 'object') {
          // The copy of Git's own data of the worktree holds only what this start wrote there, byte for byte (its settings,
          // HEAD and history at the fetched head, and an index of that head's tree): it goes with the thread, as the branch
          // and the fetched commits do.
          await attempt(['update-ref', '--no-deref', '-d', cleaned.admin.ref, cleaned.admin.sha])
        }
        if (removed) {
          await attempt(['branch', '-D', workspace.branch])
          await attempt(['update-ref', '--no-deref', '-d', workspace.retainedRef])
          try {
            // The folder provisioning made for the worktree; only removed when it is empty.
            await rmdir(dirname(workspace.worktreePath))
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

  /**
   * Deletes the worktree a failed start made, against a proof, with the thread as the owner of what is kept: `true` when
   * there was no folder; the copy of Git's own data of it when it was deleted, nothing else was kept, and that copy holds
   * only what the start itself wrote ({@link releasable}); and `false` otherwise: it stays, or the thread owns bytes no
   * commit of the start holds and is not discarded. Its files are held by the checkout's blobs, compared in Git's form
   * where Git converts them (line endings, say). Someone else's commits run no filter driver for any of it.
   */
  private async deleteWorktree(threadDirectory: string, primary: string, workspace: { worktreePath: string; branch: string; untrusted?: true }, made: StartMade): Promise<boolean | { admin: { ref: string; sha: string } }> {
    if (!await present(workspace.worktreePath)) return true
    const filters = workspace.untrusted !== true
    // Read in the worktree with the repository's programs off and, for someone else's commits, every filter driver off
    // too (its own settings already turn them off), so none runs for the check.
    const inWorktreeGit = (args: string[]) => gitListing(workspace.worktreePath, args)
    const ignored = await withDrivers(filters, workspace.worktreePath, () => ignoredFilesOf(inWorktreeGit))
    if ('dirty' in ignored || ignored.repositories.length) return false
    // Read before the cleanup: the index it is about to keep, shown to hold the fetched head's tree and nothing else.
    const index = await withDrivers(filters, workspace.worktreePath, () => this.startIndex(workspace.worktreePath, made.headSha)).catch(() => undefined)
    const outcome = await verifiedCleanupAsync({
      home: getMousseHomeDir(), worktreePath: workspace.worktreePath, branch: workspace.branch, repositoryRoot: primary,
      keep: { owner: threadDirectory }, git: inWorktreeGit, ignored: ignored.files, filters
    })
    if ('kept' in outcome) {
      console.warn('a failed pull request thread start kept its worktree', { path: workspace.worktreePath, reason: outcome.kept.reason })
      return false
    }
    if (outcome.copy || outcome.late?.length || !outcome.admin) return false
    return await this.releasable(primary, workspace.branch, made, index, outcome.admin) ? { admin: { ref: outcome.admin.ref, sha: outcome.admin.sha } } : false
  }

  /**
   * The blob id of the worktree's index, when it holds exactly the tree of `headSha`, stage 0, and was not written while
   * it was read (the same bytes before and after its listing); undefined otherwise.
   */
  private async startIndex(worktreePath: string, headSha: string): Promise<string | undefined> {
    const { adminDir, commonDir } = await linkedAdminDir(worktreePath)
    const format = await git(commonDir, ['rev-parse', '--show-object-format'])
    const before = await readFile(join(adminDir, 'index'))
    const listed = (await gitListing(worktreePath, ['ls-files', '-s', '-z'])).split('\0').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t'), [mode, blob, stage] = line.slice(0, tab).split(' ')
      return stage === '0' ? `${mode} ${blob}\t${line.slice(tab + 1)}` : `unmerged\t${line}`
    })
    const tree = (await gitListing(commonDir, ['ls-tree', '-r', '-z', headSha])).split('\0').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t'), [mode, , blob] = line.slice(0, tab).split(' ')
      return `${mode} ${blob}\t${line.slice(tab + 1)}`
    })
    const after = await readFile(join(adminDir, 'index'))
    listed.sort(); tree.sort()
    if (!before.equals(after) || listed.length !== tree.length || listed.some((line, at) => line !== tree[at])) return undefined
    return blobId(before, format)
  }

  /**
   * Whether the copy of Git's own data of the deleted worktree holds only what the start itself wrote, so it may go with
   * the thread: the thread's branch is still at the head the start fetched, the copy names no other commit, and every
   * file it holds is byte for byte the one provisioning left (`made.admin`), the index excepted, which must be the one
   * {@link startIndex} proved. A commit made there, a setting added, a version staged: the copy stays, and so does the thread.
   */
  private async releasable(primary: string, branch: string, made: StartMade, index: string | undefined, admin: { sha: string }): Promise<boolean> {
    if (!made.admin || !index) return false
    const tip = await git(primary, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]).catch(() => '')
    if (tip !== made.headSha) return false
    const parents = (await git(primary, ['rev-list', '--parents', '-n', '1', admin.sha])).split(/\s+/).slice(1)
    if (parents.some((parent) => parent !== made.headSha)) return false
    const kept = new Map((await gitListing(primary, ['ls-tree', '-r', '-z', admin.sha])).split('\0').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t')
      return [line.slice(tab + 1), line.slice(0, tab).split(' ')[2]!] as [string, string]
    }))
    const wrote = new Map([...made.admin.files].filter(([path]) => path !== 'index'))
    if (kept.get('index') !== index) return false
    kept.delete('index')
    return kept.size === wrote.size && [...kept].every(([path, blob]) => wrote.get(path) === blob)
  }
}
