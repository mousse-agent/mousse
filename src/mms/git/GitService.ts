import { createErrorProvider } from '../../shared/errors'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import simpleGit, { type SimpleGit, type StatusResult } from 'simple-git'
import { holdsRepositoryMutation } from '../actions/GitOperationCoordinator'
import { GitHubService } from './GitHubService'
import { resolveRepositoryIdentity } from './RepositoryIdentity'
import { acquireRepositoryLease, RepositoryLeaseAbortedError } from './RepositoryLease'
import type {
  GitBranchInfo,
  GitCommit,
  GitCommitOptions,
  GitDiffStats,
  GitFileChange,
  GitStatusSnapshot
} from '../../shared/types'

const gitErrors = createErrorProvider({
  git_push_failed: { category: 'unavailable', retryable: false, message: 'Git push failed. Check the configured upstream, push destination and remote access.' },
  git_detached_head: { category: 'invalid', retryable: false, message: 'Check out a branch before pushing.' },
  git_push_rejected: { category: 'conflict', retryable: false, message: 'The remote has commits this branch does not. Pull them, then push again.' },
  git_init_no_folder: { category: 'invalid', retryable: false, message: 'The project folder does not exist.' },
  git_already_repo: { category: 'conflict', retryable: false, message: 'This folder is already a Git repository.' },
  git_no_remote: { category: 'invalid', retryable: false, message: 'Add a remote before pushing.' },
  git_amend_no_commit: { category: 'invalid', retryable: false, message: 'There is no commit to amend.' },
  git_amend_pushed: { category: 'conflict', retryable: false, message: 'The latest commit is already pushed, so it cannot be amended.' },
  git_busy: { category: 'unavailable', retryable: true, message: 'Another Git action on this folder is still running. Try again shortly.' }
})

/** How long a Git action waits for another one on the same repository before giving up. */
const LEASE_WAIT_MS = 2 * 60_000
/** Well inside the repository lease's 30 s stale window, so a long hook keeps its lease. */
const LEASE_HEARTBEAT_MS = 5_000
/** A push that prints nothing for this long is waiting on a prompt nobody can answer. */
const PUSH_SILENCE_MS = 2 * 60_000

export interface PushRemoteInputs {
  pushRemote: string | null
  pushDefault: string | null
  remotes: readonly string[]
}

/** Remote used to publish a branch that has no upstream, or null when none is configured. */
export function choosePushRemote({ pushRemote, pushDefault, remotes }: PushRemoteInputs): string | null {
  if (pushRemote) return pushRemote
  if (pushDefault) return pushDefault
  if (remotes.includes('origin')) return 'origin'
  return remotes.length === 1 ? remotes[0] : null
}

/** A push refused because the remote moved on, as opposed to an access or configuration failure. */
export function isPushRejected(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /\[rejected\]|non-fast-forward|fetch first/i.test(text)
}

function mapStatus(entry: StatusResult['files'][number]): GitFileChange | null {
  const path = entry.path.replace(/\\/g, '/')
  const index = entry.index.trim()
  const workdir = entry.working_dir.trim()

  if (index === '?' && workdir === '?') {
    return { path, status: 'untracked', staged: false }
  }
  if (index === '!' || workdir === '!') {
    return { path, status: 'ignored', staged: false }
  }
  if (index === 'U' || workdir === 'U') {
    return { path, status: 'conflicted', staged: index !== ' ' }
  }

  const staged = index !== '' && index !== '?'
  const code = staged ? index : workdir

  const statusMap: Record<string, GitFileChange['status']> = {
    M: 'modified',
    A: 'added',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
    '?': 'untracked'
  }

  const status = statusMap[code]
  if (!status) return null

  return {
    path,
    status,
    staged,
    originalPath: entry.from ? entry.from.replace(/\\/g, '/') : undefined
  }
}

export class GitService {
  /** Profile-scoped GitHub CLI integration alongside the existing Git operations. */
  readonly github = new GitHubService()
  private readonly mutations = new Map<string, Promise<void>>()

  private gitFor(cwd: string): SimpleGit {
    return simpleGit(cwd)
  }

  async isRepo(cwd: string): Promise<boolean> {
    return existsSync(cwd) && this.gitFor(cwd).checkIsRepo().catch(() => false)
  }

  async getStatus(cwd: string): Promise<GitStatusSnapshot> {
    const isRepo = await this.isRepo(cwd)
    if (!isRepo) {
      return { isRepo: false, branch: null, upstream: null, tracking: 'none', ahead: 0, behind: 0, changes: [], ...(existsSync(cwd) ? {} : { missing: true }) }
    }

    const git = this.gitFor(cwd)
    const status = await git.status()
    const branch = await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).then((value) => value.trim() || null).catch(() => null)
    const hasHead = await git.raw(['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false)
    const upstream = branch && hasHead ? await this.upstream(git) : null
    const hasRemote = await git.raw(['remote']).then((value) => Boolean(value.trim())).catch(() => false)
    const changes = status.files
      .map(mapStatus)
      .filter((entry): entry is GitFileChange => entry !== null)

    let ahead = 0
    let behind = 0
    if (upstream) {
      try {
        const summary = await git.raw(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
        const [behindStr, aheadStr] = summary.trim().split(/\s+/)
        behind = Number(behindStr) || 0
        ahead = Number(aheadStr) || 0
      } catch {
        /* no upstream */
      }
    }

    return { isRepo: true, branch, upstream, tracking: !hasHead ? 'unborn' : !branch ? 'detached' : upstream ? 'tracked' : 'none', ahead, behind, changes, hasRemote }
  }

  private async upstream(git: SimpleGit): Promise<string | null> {
    return git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).then((value) => value.trim() || null).catch(() => null)
  }

  async getDiff(cwd: string, filePath: string, staged: boolean): Promise<string> {
    if (!await this.isRepo(cwd)) return ''
    const git = this.gitFor(cwd)
    if (staged) {
      return git.diff(['--cached', '--', filePath])
    }

    const status = await git.status()
    const normalized = filePath.replace(/\\/g, '/')
    const entry = status.files.find((file) => file.path.replace(/\\/g, '/') === normalized)
    if (entry?.index === '?' && entry.working_dir === '?') {
      const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null'
      return git.diff(['--no-index', nullPath, filePath]).catch(() => '')
    }

    return git.diff(['--', filePath])
  }

  async getLog(cwd: string, limit = 30): Promise<GitCommit[]> {
    if (!await this.isRepo(cwd)) return []
    const git = this.gitFor(cwd)
    const log = await git.log({ maxCount: limit })

    // Commits reachable from HEAD but not the upstream are local/un-pushed.
    const unpushed = new Set<string>()
    let hasUpstream = false
    try {
      if (await this.upstream(git)) {
        const raw = await git.raw(['rev-list', '@{upstream}..HEAD'])
        hasUpstream = true
        for (const line of raw.split('\n')) {
          const hash = line.trim()
          if (hash) unpushed.add(hash)
        }
      }
    } catch {
      /* no upstream / remote — treat commits as local */
    }

    // Commits no remote-tracking branch contains, for example on a branch made from a pushed one.
    const hasRemotes = await git.raw(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes']).then((value) => Boolean(value.trim())).catch(() => false)
    const localOnly = hasRemotes
      ? await git.raw(['rev-list', `--max-count=${limit}`, 'HEAD', '--not', '--remotes']).then((value) => new Set(value.split('\n').map((line) => line.trim()).filter(Boolean))).catch(() => null)
      : null

    return log.all.map((entry) => ({
      hash: entry.hash,
      shortHash: entry.hash.slice(0, 7),
      message: entry.message,
      author: entry.author_name,
      date: entry.date,
      pushed: hasUpstream && !unpushed.has(entry.hash),
      onRemote: localOnly !== null && !localOnly.has(entry.hash)
    }))
  }

  async getBranches(cwd: string): Promise<GitBranchInfo> {
    const isRepo = await this.isRepo(cwd)
    if (!isRepo) return { current: null, branches: [] }

    const git = this.gitFor(cwd)
    const summary = await git.branchLocal()
    return {
      current: summary.current ?? null,
      branches: summary.all.filter((name) => !name.startsWith('mousse/agent-'))
    }
  }

  async getDiffStats(cwd: string): Promise<GitDiffStats> {
    const isRepo = await this.isRepo(cwd)
    if (!isRepo) return { additions: 0, deletions: 0, filesChanged: 0 }

    const git = this.gitFor(cwd)
    const parseNumstat = (output: string): GitDiffStats => {
      let additions = 0
      let deletions = 0
      let filesChanged = 0
      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue
        const [addStr, delStr] = line.split('\t')
        if (addStr === '-' || delStr === undefined) continue
        additions += Number(addStr) || 0
        deletions += Number(delStr) || 0
        filesChanged++
      }
      return { additions, deletions, filesChanged }
    }

    const [unstaged, staged] = await Promise.all([
      git.diff(['--numstat']).catch(() => ''),
      git.diff(['--cached', '--numstat']).catch(() => '')
    ])

    const unstagedStats = parseNumstat(unstaged)
    const stagedStats = parseNumstat(staged)
    return {
      additions: unstagedStats.additions + stagedStats.additions,
      deletions: unstagedStats.deletions + stagedStats.deletions,
      filesChanged: unstagedStats.filesChanged + stagedStats.filesChanged
    }
  }

  /**
   * Runs the changes this app makes to a folder (checkout, commit, push) one at a
   * time, so a push cannot land between the amend check and the amend itself. The
   * desktop app and the background service each run this service, so the queue also
   * holds the repository mutation lease, which every worktree of the repository and
   * every other Git mutation in the app share.
   */
  private serialized<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    const key = resolve(cwd)
    const previous = this.mutations.get(key) ?? Promise.resolve()
    const leased = () => this.withLease(cwd, operation)
    const run = previous.then(leased, leased)
    const settled = run.then(() => undefined, () => undefined)
    this.mutations.set(key, settled)
    void settled.then(() => {
      if (this.mutations.get(key) === settled) this.mutations.delete(key)
    })
    return run
  }

  private async withLease<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    let identity: ReturnType<typeof resolveRepositoryIdentity> | null = null
    try {
      identity = existsSync(cwd) ? resolveRepositoryIdentity(cwd) : null
    } catch {
      identity = null
    }
    // Not a repository yet, or no commit yet: there is nothing a push or an amend could race with.
    if (!identity?.capability.allowed) return operation()
    // Background Git actions already hold this lease when they call in; taking it again would wait on itself.
    if (holdsRepositoryMutation(identity.key)) return operation()
    let lease: Awaited<ReturnType<typeof acquireRepositoryLease>>
    try {
      lease = await acquireRepositoryLease(identity, { signal: AbortSignal.timeout(LEASE_WAIT_MS) })
    } catch (error) {
      if (error instanceof RepositoryLeaseAbortedError) throw gitErrors.create('git_busy', error)
      throw error
    }
    const heartbeat = setInterval(() => lease.heartbeat(), LEASE_HEARTBEAT_MS)
    heartbeat.unref?.()
    try {
      return await operation()
    } finally {
      clearInterval(heartbeat)
      lease.release()
    }
  }

  /** Turns a project folder into a Git repository. Never touches an existing one. */
  async init(cwd: string): Promise<void> {
    await this.serialized(cwd, async () => {
      const info = await stat(cwd).catch(() => null)
      if (!info?.isDirectory()) throw gitErrors.create('git_init_no_folder')
      if (await this.isRepo(cwd)) throw gitErrors.create('git_already_repo')
      await this.gitFor(cwd).init()
    })
  }

  async checkout(cwd: string, branch: string): Promise<void> {
    await this.serialized(cwd, async () => {
      await this.gitFor(cwd).checkout(branch)
    })
  }

  async commit(cwd: string, message: string, options: GitCommitOptions = {}): Promise<void> {
    await this.serialized(cwd, async () => {
      const git = this.gitFor(cwd)
      if (options.amend) {
        await this.assertAmendable(git)
        await git.add(['-A'])
        await git.raw(['commit', '--amend', '-m', message])
        return
      }
      await git.add(['-A'])
      await git.commit(message)
    })
  }

  async lastCommitMessage(cwd: string): Promise<string | null> {
    if (!await this.isRepo(cwd)) return null
    return this.gitFor(cwd).raw(['log', '-1', '--format=%B']).then((value) => value.trim() || null).catch(() => null)
  }

  /**
   * Amending a commit any remote already has would need a force push, which is never
   * done. This also covers a new branch whose only commit came from a pushed branch.
   */
  private async assertAmendable(git: SimpleGit): Promise<void> {
    const hasHead = await git.raw(['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false)
    if (!hasHead) throw gitErrors.create('git_amend_no_commit')
    const onRemote = await git.raw(['for-each-ref', '--count=1', '--contains', 'HEAD', '--format=%(refname)', 'refs/remotes'])
      .then((value) => Boolean(value.trim()))
    if (onRemote) throw gitErrors.create('git_amend_pushed')
  }

  async push(cwd: string): Promise<void> {
    await this.serialized(cwd, () => this.pushNow(cwd))
  }

  private async pushNow(cwd: string): Promise<void> {
    // A push waiting on a prompt nobody can answer would hold the folder's lease; stop it once it goes silent.
    const git = simpleGit({ baseDir: cwd, timeout: { block: PUSH_SILENCE_MS } })
    const branch = (await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null))?.trim()
    if (!branch) throw gitErrors.create('git_detached_head')
    const hasUpstream = Boolean(await this.upstream(git))
    const remote = hasUpstream ? null : await this.publishRemote(git, branch)
    if (!hasUpstream && !remote) throw gitErrors.create('git_no_remote')
    try {
      // With an upstream, let Git resolve pushRemote, remote.pushDefault, refspecs and push.default.
      // Progress output keeps a slow but healthy upload from looking silent.
      if (remote) await git.raw(['push', '--progress', '-u', remote, branch])
      else await git.raw(['push', '--progress'])
    } catch (error) {
      throw gitErrors.create(isPushRejected(error) ? 'git_push_rejected' : 'git_push_failed', error)
    }
  }

  private async publishRemote(git: SimpleGit, branch: string): Promise<string | null> {
    const config = (key: string): Promise<string | null> =>
      git.raw(['config', '--get', key]).then((value) => value.trim() || null).catch(() => null)
    const [pushRemote, pushDefault, remotes] = await Promise.all([
      config(`branch.${branch}.pushRemote`),
      config('remote.pushDefault'),
      git.raw(['remote']).then((value) => value.split('\n').map((line) => line.trim()).filter(Boolean)).catch(() => [])
    ])
    return choosePushRemote({ pushRemote, pushDefault, remotes })
  }
}
