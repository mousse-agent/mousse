import { AppError, createErrorProvider } from '../../shared/errors'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import simpleGit, { type SimpleGit, type StatusResult } from 'simple-git'
import { redactGitText } from '../../shared/gitText'
import { holdsRepositoryMutation } from '../actions/GitOperationCoordinator'
import type { CodeHost } from './CodeHost'
import { COMMIT_SUGGESTION_LIMITS, EMPTY_COMMIT_INPUT, fitPatch, parseNumstat, type CommitInput } from './commitSuggestion'
import { explicitActionGitEnv } from './gitEnv'
import { IN_PROGRESS_GIT_MARKERS } from './gitMarkers'
import { OperationStream } from './gitOperationStream'
import { englishMessagesEnv, runGit, type GitLine, type GitRun, type GitRunOptions } from './gitProcess'
import { HookTrace, withHookFailure, type HookTraceEvent } from './gitTrace'
import { GitHubCodeHost } from './GitHubCodeHost'
import { GitHubService } from './GitHubService'
import { PULL_REQUEST_DRAFT_LIMITS, type DraftCommit } from './pullRequestDraft'
import { resolveRepositoryIdentity } from './RepositoryIdentity'
import { acquireRepositoryLease, RepositoryLeaseAbortedError } from './RepositoryLease'
import type {
  GitBranchInfo,
  GitBranchOptions,
  GitCheckoutOptions,
  GitCheckoutResult,
  GitCommit,
  GitCommitOptions,
  GitDeleteBranchOptions,
  GitDiffStats,
  GitFetchResult,
  GitFileChange,
  GitInProgress,
  GitOperationKind,
  GitOperationOptions,
  GitPullOptions,
  GitPullResult,
  GitPushOptions,
  GitStatusSnapshot
} from '../../shared/types'

const gitErrors = createErrorProvider({
  git_push_failed: { category: 'unavailable', retryable: false, message: 'Git push failed. Check the configured upstream, push destination and remote access.' },
  git_detached_head: { category: 'invalid', retryable: false, message: 'Check out a branch before pushing.' },
  git_push_rejected: { category: 'conflict', retryable: false, message: 'The remote has commits this branch does not. Pull them, then push again.' },
  git_push_rejected_by_remote: { category: 'denied', retryable: false, message: 'The remote refused this push, for example because the branch is protected or a server rule failed.' },
  git_auth_failed: { category: 'denied', retryable: false, message: 'The remote refused the sign-in. Check your Git credentials or SSH key.' },
  git_remote_unreachable: { category: 'unavailable', retryable: true, message: 'Could not reach the remote. Check the network and the remote address.' },
  git_host_key_unverified: { category: 'denied', retryable: false, message: 'The remote host key is not trusted yet. Connect once from a terminal to accept it.' },
  git_cancelled: { category: 'cancelled', retryable: false, message: 'Cancelled.' },
  git_operation_exists: { category: 'conflict', retryable: false, message: 'An action with that id is already running.' },
  git_silence_timeout: { category: 'timeout', retryable: false, message: 'Git went silent and was stopped. It may have been waiting for a prompt that cannot be answered here.' },
  git_init_no_folder: { category: 'invalid', retryable: false, message: 'The project folder does not exist.' },
  git_already_repo: { category: 'conflict', retryable: false, message: 'This folder is already a Git repository.' },
  git_no_remote: { category: 'invalid', retryable: false, message: 'Add a remote before pushing.' },
  git_no_upstream: { category: 'invalid', retryable: false, message: 'This branch has no upstream. Push it first to set one.' },
  git_amend_no_commit: { category: 'invalid', retryable: false, message: 'There is no commit to amend.' },
  git_amend_pushed: { category: 'conflict', retryable: false, message: 'The latest commit is already pushed, so it cannot be amended.' },
  git_busy: { category: 'unavailable', retryable: true, message: 'Another Git action on this folder is still running. Try again shortly.' },
  git_branch_changed: { category: 'conflict', retryable: false, message: 'The branch changed while this was open. Review it, then try again.' },
  git_merge_unresolved: { category: 'conflict', retryable: false, message: 'Resolve the conflicted files and stage them, then commit.' },
  git_commit_failed: { category: 'invalid', retryable: false, message: 'Git could not commit.' },
  git_fetch_failed: { category: 'unavailable', retryable: false, message: 'Git fetch failed. Check the remote and your access.' },
  git_pull_failed: { category: 'unavailable', retryable: false, message: 'Git pull failed. Check the remote and your access.' },
  git_pull_diverged: { category: 'conflict', retryable: false, message: 'This branch and its upstream have both moved. Choose merge or rebase to bring them together.' },
  git_pull_dirty: { category: 'conflict', retryable: false, message: 'Uncommitted changes would be overwritten by the pull. Commit or stash them first.' },
  git_checkout_dirty: { category: 'conflict', retryable: false, message: 'Uncommitted changes would be overwritten by the switch.' },
  git_checkout_untracked_collision: { category: 'conflict', retryable: false, message: 'Untracked files in the way would be overwritten by the switch.' },
  git_checkout_failed: { category: 'invalid', retryable: false, message: 'Git could not switch branches.' },
  git_stash_kept: { category: 'conflict', retryable: false, message: 'Git could not put your changes back. They are kept in the stash named "mousse: switch to ...".' },
  git_index_restore_failed: { category: 'internal', retryable: false, message: 'The commit failed and Git could not put the staged files back as they were. Everything is staged; unstage what you do not want to commit.' },
  git_index_locked: { category: 'conflict', retryable: false, message: 'A stopped Git left its lock file .git/index.lock behind. Make sure no Git is running in this folder, delete that file, then check what is staged.' },
  git_stash_failed: { category: 'invalid', retryable: false, message: 'Git could not stash the changes.' },
  git_branch_invalid: { category: 'invalid', retryable: false, message: 'That is not a valid branch name.' },
  git_ref_not_found: { category: 'invalid', retryable: false, message: 'That branch or commit does not exist.' },
  git_branch_exists: { category: 'conflict', retryable: false, message: 'A branch with that name already exists.' },
  git_branch_unmerged: { category: 'conflict', retryable: false, message: 'The branch has commits that are not on any other branch.' },
  git_branch_in_worktree: { category: 'conflict', retryable: false, message: 'The branch is checked out in another worktree.' },
  git_branch_protected: { category: 'denied', retryable: false, message: 'Branches under mousse/ are managed by Mousse and cannot be changed here.' },
  git_branch_current: { category: 'invalid', retryable: false, message: 'Switch to another branch before deleting this one.' },
  git_branch_failed: { category: 'invalid', retryable: false, message: 'Git could not change the branch.' },
  git_path_outside: { category: 'invalid', retryable: false, message: 'That path is outside the project folder.' },
  git_failed: { category: 'invalid', retryable: false, message: 'Git could not complete that action.' }
})

type GitErrorCode = Parameters<typeof gitErrors.create>[0]

/** How long a Git action waits for another one on the same repository before giving up. */
const LEASE_WAIT_MS = 2 * 60_000
/** Well inside the repository lease's 30 s stale window, so a long hook keeps its lease. */
const LEASE_HEARTBEAT_MS = 5_000
/** A push that prints nothing for this long is waiting on a prompt nobody can answer. */
const PUSH_SILENCE_MS = 2 * 60_000
/** Fetch prints progress, so the same reasoning as a push applies. */
const FETCH_SILENCE_MS = 2 * 60_000
/** Hooks may run tests without printing; this only stops one that waits on a prompt forever. */
const COMMIT_SILENCE_MS = 10 * 60_000

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
  return /\[rejected\][^\n]*(non-fast-forward|fetch first)/i.test(text) && /failed to push some refs/i.test(text)
}

/** Access and network failures, shared by push, fetch and pull. */
function remoteFailureCode(text: string): 'git_host_key_unverified' | 'git_auth_failed' | 'git_remote_unreachable' | null {
  if (/Host key verification failed/i.test(text)) return 'git_host_key_unverified'
  if (/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled|returned error: 40[13]/i.test(text)) return 'git_auth_failed'
  if (/Could not resolve host|Connection refused|unable to access|Failed to connect/i.test(text)) return 'git_remote_unreachable'
  return null
}

/** Branches Mousse owns for thread worktrees, whatever the case a client spells them in. */
function isManagedBranch(name: string): boolean {
  return name.toLowerCase().startsWith('mousse/')
}

const CONFLICTED_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
/** Conflict pairs whose path has no version in HEAD ("us"). */
const ABSENT_FROM_HEAD_PAIRS = new Set(['DD', 'DU', 'UA'])

const IN_PROGRESS_KIND: Record<(typeof IN_PROGRESS_GIT_MARKERS)[number], GitInProgress> = {
  MERGE_HEAD: 'merge',
  REVERT_HEAD: 'revert',
  CHERRY_PICK_HEAD: 'cherry-pick',
  REBASE_HEAD: 'rebase',
  'rebase-merge': 'rebase',
  'rebase-apply': 'rebase'
}
const IN_PROGRESS_ORDER: readonly GitInProgress[] = ['rebase', 'merge', 'cherry-pick', 'revert']

/** One status line as Git reports it: a code for the index side and one for the working tree side. */
interface RawEntry {
  path: string
  index: string
  workdir: string
  from?: string
}

const statusMap: Record<string, GitFileChange['status']> = {
  M: 'modified',
  T: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied'
}

/** Git prints `/` everywhere; only on Windows can a caller's path use a backslash, elsewhere it is part of a file name. */
function normalizePath(value: string): string {
  return (process.platform === 'win32' ? value.replace(/\\/g, '/') : value).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
}

function rawEntries(status: StatusResult): RawEntry[] {
  return status.files.map((entry) => ({
    path: normalizePath(entry.path),
    index: entry.index.trim(),
    workdir: entry.working_dir.trim(),
    ...(entry.from ? { from: normalizePath(entry.from) } : {})
  }))
}

const isConflicted = (entry: RawEntry): boolean => CONFLICTED_PAIRS.has(`${entry.index || ' '}${entry.workdir || ' '}`)
const isUntracked = (entry: RawEntry): boolean => entry.index === '?' && entry.workdir === '?'
const isIgnored = (entry: RawEntry): boolean => entry.index === '!' || entry.workdir === '!'

/**
 * One change per side. A path with changes in both the index and the working tree
 * (`MM`, `AM`, `RM`, ...) yields a staged and an unstaged change; an untracked file
 * and a conflicted path yield one.
 */
function mapStatus(entry: RawEntry): GitFileChange[] {
  const { path, index, workdir } = entry
  if (isUntracked(entry)) return [{ path, status: 'untracked', staged: false }]
  if (isIgnored(entry)) return [{ path, status: 'ignored', staged: false }]
  if (isConflicted(entry)) return [{ path, status: 'conflicted', staged: false }]

  const changes: GitFileChange[] = []
  const indexStatus = statusMap[index]
  if (indexStatus) changes.push({ path, status: indexStatus, staged: true, ...(index === 'R' || index === 'C' ? { originalPath: entry.from } : {}) })
  const workdirStatus = statusMap[workdir]
  if (workdirStatus) changes.push({ path, status: workdirStatus, staged: false, ...(workdir === 'R' || workdir === 'C' ? { originalPath: entry.from } : {}) })
  return changes
}

/** The entries a caller's paths refer to: an exact path, a directory holding entries, or a rename's old path. */
function selectEntries(entries: readonly RawEntry[], paths: readonly string[]): RawEntry[] {
  const wanted = new Set(paths.map(normalizePath).filter((path) => path !== '' && path !== '.'))
  if (wanted.size === 0) return []
  return entries.filter((entry) => {
    if (isIgnored(entry)) return false
    if (wanted.has(entry.path) || (entry.from !== undefined && wanted.has(entry.from))) return true
    for (let slash = entry.path.indexOf('/'); slash !== -1; slash = entry.path.indexOf('/', slash + 1)) {
      if (wanted.has(entry.path.slice(0, slash))) return true
    }
    return false
  })
}

/** What a long action hands its commands: the signal that stops them and where their output and hooks go. */
interface Live {
  /** Absent when the action must not be cut off halfway, or from the moment it must not be. */
  signal?: AbortSignal
  line: (line: GitLine) => void
  hook: (event: HookTraceEvent) => void
  /** From now on the action can no longer be cancelled: what follows changes the folder. */
  stopCancelling: () => void
}

/**
 * An action registered for its events and for Cancel. A caller that has to wait for its own locks first
 * opens it before waiting, so Cancel works from the start, hands it to the GitService method, and ends it.
 */
export class GitOperationHandle {
  /** @internal */
  readonly live: Live
  private ended = false

  constructor(
    private readonly finish: (error: unknown) => void,
    live: Live
  ) {
    this.live = live
  }

  /** Aborts when the action is cancelled; stays unset for an action that cannot be. */
  get signal(): AbortSignal | undefined {
    return this.live.signal
  }

  /** Reports how the action ended: done, or failed or cancelled with `error`. */
  end(error?: unknown): void {
    if (this.ended) return
    this.ended = true
    this.finish(error)
  }
}

/** What a long GitService action takes: where its events go, and optionally an action opened earlier. */
export type GitOperationRequest = GitOperationOptions & { operation?: GitOperationHandle }

const cancelledError = (): AppError => gitErrors.create('git_cancelled')

/** Refuses to start work for an action that was cancelled while it waited for its turn. */
function assertNotCancelled(live: Live | undefined): void {
  if (live?.signal?.aborted) throw cancelledError()
}

/** A recognised failure: the code's fixed message, with the redacted Git output kept as the cause. */
function classified(code: GitErrorCode, run: GitRun): AppError {
  return gitErrors.create(code, redactGitText(run.output))
}

/**
 * An unrecognised failure: the message is Git's own redacted output, or the code's
 * fixed text when Git printed nothing.
 */
function failure(code: GitErrorCode, run: GitRun): AppError {
  const fixed = gitErrors.create(code)
  const text = redactGitText(run.output).trim()
  return text ? new AppError({ code, message: text, errorInfo: fixed.errorInfo }) : fixed
}

export interface BranchSummary {
  commits: DraftCommit[]
  stat: string
  patch: string
}

/** How long a read of a branch's history may take before it is given up. */
const SUMMARY_READ_MS = 30_000

/** After a read is given up, how long to wait for the process to end before settling anyway. */
const SUMMARY_KILL_SETTLE_MS = 5_000

/**
 * The first `maxBytes` of a read-only Git command's output; one that fails for another reason yields
 * nothing. Memory stays bounded: output past the limit is read and dropped. The read settles only once
 * the process has closed, so Git never still holds the repository's folder when it resolves (a kill does
 * not wait for exit, and on Windows the `git` on PATH is a launcher around the real process). A command
 * that runs past the time limit is stopped, with its whole process tree on Windows.
 */
function readBoundedGit(cwd: string, args: readonly string[], maxBytes: number): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...englishMessagesEnv(), GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    let done = false
    let backstop: NodeJS.Timeout | undefined
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (backstop) clearTimeout(backstop)
      resolvePromise(ok || truncated ? Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8') : '')
    }
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined)
      else child.kill()
      // Close ends the read; the backstop only covers a process that never closes its pipes.
      backstop = setTimeout(() => finish(false), SUMMARY_KILL_SETTLE_MS)
    }, SUMMARY_READ_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      if (size >= maxBytes) return
      chunks.push(chunk)
      size += chunk.length
      if (size >= maxBytes) truncated = true
    })
    child.on('error', () => finish(false))
    child.on('close', (code) => finish(code === 0))
  })
}

export class GitService {
  /** Profile-scoped GitHub CLI integration alongside the existing Git operations. */
  readonly github = new GitHubService()
  /** Pull request reads and creation; callers depend on the interface, not on GitHub. */
  readonly codeHost: CodeHost = new GitHubCodeHost()
  private readonly mutations = new Map<string, Promise<void>>()
  /** Actions that can be followed and cancelled, by the id their client chose. */
  private readonly operations = new Map<string, { controller: AbortController; owner?: string; cancellable: boolean }>()

  constructor(private readonly options: {
    /** Overrides how long a commit may stay silent; for tests. */
    commitSilenceMs?: number
    /** Overrides how live output is batched and capped; for tests. */
    liveOutput?: { intervalMs?: number; maxLines?: number }
  } = {}) {}

  private gitFor(cwd: string): SimpleGit {
    return simpleGit(cwd)
  }

  private runGit(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<GitRun> {
    return runGit(cwd, args, options)
  }

  /**
   * Stops a running action, and every process it started, when the client that started it asks.
   * False when no such action is running, it cannot be stopped (a branch switch must not be cut
   * off halfway), or another client started it.
   */
  cancelOperation(operationId: string, owner?: string): boolean {
    const operation = this.operations.get(operationId)
    if (!operation?.cancellable || operation.owner !== owner) return false
    operation.controller.abort()
    return true
  }

  /**
   * Runs a long action with its events. Registered before it waits for the repository's lease, so Cancel
   * works while it is still queued. The last event follows the outcome: done, failed, or cancelled.
   */
  private async runOperation<T>(cwd: string, kind: GitOperationKind, options: GitOperationRequest, cancellable: boolean, work: (live: Live) => Promise<T>): Promise<T> {
    // An action opened by the caller is ended by the caller, after it has also released its own locks.
    const opened = options.operation
    const operation = opened ?? this.openOperation(cwd, kind, options, cancellable)
    try {
      const result = await work(operation.live)
      if (!opened) operation.end()
      return result
    } catch (error) {
      if (!opened) operation.end(error)
      throw error
    }
  }

  /** The error an action ends with when it was cancelled. */
  cancelledError(): AppError {
    return cancelledError()
  }

  /**
   * Registers an action and reports it as started. Cancel finds it from now on, also while it waits for
   * its turn or for locks. It ends with `end()`; without it the action stays registered.
   */
  openOperation(cwd: string, kind: GitOperationKind, options: GitOperationOptions, cancellable = true): GitOperationHandle {
    const { operationId, owner, lifetime } = options
    if (operationId !== undefined && this.operations.has(operationId)) throw gitErrors.create('git_operation_exists')
    const controller = new AbortController()
    const entry = { controller, owner, cancellable }
    if (operationId !== undefined) this.operations.set(operationId, entry)
    const stream = new OperationStream({ operationId: operationId ?? '', kind, path: cwd, onEvent: options.onEvent, ...this.options.liveOutput })
    const live: Live = {
      signal: cancellable ? controller.signal : undefined,
      line: (line) => stream.line(line),
      hook: (hook) => stream.hook(hook),
      stopCancelling: () => {
        // Between the last check for a cancel and this line there is no await, so a cancel is either seen before or refused after.
        entry.cancellable = false
        live.signal = undefined
        stream.integrating()
      }
    }
    // The client that started it is gone and nobody can cancel it any more: stop it while it still can be stopped.
    const onGone = (): void => {
      if (entry.cancellable) controller.abort()
    }
    if (lifetime?.aborted) onGone()
    else lifetime?.addEventListener('abort', onGone, { once: true })
    stream.started(cancellable)
    return new GitOperationHandle((error) => {
      lifetime?.removeEventListener('abort', onGone)
      if (operationId !== undefined) this.operations.delete(operationId)
      if (error === undefined) stream.end('done')
      else if (error instanceof AppError && error.code === 'git_cancelled') stream.end('cancelled')
      else stream.end('failed', { message: error instanceof Error ? error.message : String(error), code: error instanceof AppError ? error.code : undefined })
    }, live)
  }

  /**
   * Runs a long Git command with its output streamed and, when `hooks` is set, its hooks followed. A failed
   * hook's name and exit status lead the error text, so a rejected commit says which hook said no.
   */
  private async runLive(cwd: string, args: readonly string[], live: Live | undefined, options: { env?: Record<string, string>; silenceMs?: number; hooks?: boolean } = {}): Promise<GitRun> {
    const trace = options.hooks && live ? await HookTrace.start(live.hook) : null
    let run: GitRun
    try {
      run = await this.runGit(cwd, args, { env: { ...options.env, ...trace?.env }, silenceMs: options.silenceMs, signal: live?.signal, onLine: live?.line })
    } finally {
      await trace?.stop()
    }
    return trace?.failedHook && !run.ok && !run.cancelled && !run.stalled ? { ...run, output: withHookFailure(run.output, trace.failedHook) } : run
  }

  /** The trimmed output of a Git read, or null when the command fails. */
  private async read(cwd: string, args: readonly string[]): Promise<string | null> {
    const run = await this.runGit(cwd, args)
    return run.ok ? run.stdout.trim() : null
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
    const changes = rawEntries(status).flatMap(mapStatus)

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

    const inProgress = await this.inProgress(cwd)
    return { isRepo: true, branch, upstream, tracking: !hasHead ? 'unborn' : !branch ? 'detached' : upstream ? 'tracked' : 'none', ahead, behind, changes, inProgress, hasRemote }
  }

  /** The merge, rebase, cherry-pick or revert Git is stopped in, found the way the checkpoint guard finds it. */
  private async inProgress(cwd: string): Promise<GitInProgress | null> {
    const paths = await this.read(cwd, ['rev-parse', ...IN_PROGRESS_GIT_MARKERS.flatMap((marker) => ['--git-path', marker])])
    if (paths === null) return null
    const lines = paths.split(/\r?\n/)
    const found = new Set<GitInProgress>()
    IN_PROGRESS_GIT_MARKERS.forEach((marker, index) => {
      const path = lines[index]
      if (path && existsSync(resolve(cwd, path))) found.add(IN_PROGRESS_KIND[marker])
    })
    return IN_PROGRESS_ORDER.find((kind) => found.has(kind)) ?? null
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
      // Thread, agent and workflow branches live under mousse/ and are managed by the app.
      branches: summary.all.filter((name) => !isManagedBranch(name))
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
  private serialized<T>(cwd: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const key = resolve(cwd)
    const previous = this.mutations.get(key) ?? Promise.resolve()
    let turn = false
    const leased = () => {
      turn = true
      // A cancel that came while it waited: its turn passes without running anything.
      if (signal?.aborted) throw cancelledError()
      return this.withLease(cwd, operation, signal)
    }
    const run = previous.then(leased, leased)
    const settled = run.then(() => undefined, () => undefined)
    this.mutations.set(key, settled)
    void settled.then(() => {
      if (this.mutations.get(key) === settled) this.mutations.delete(key)
    })
    if (!signal) return run
    // While it waits behind another action, a cancel answers at once instead of when that action ends.
    return new Promise<T>((resolvePromise, reject) => {
      const onAbort = (): void => { if (!turn) reject(cancelledError()) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      run.then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  private async withLease<T>(cwd: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
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
      const wait = AbortSignal.timeout(LEASE_WAIT_MS)
      lease = await acquireRepositoryLease(identity, { signal: signal ? AbortSignal.any([wait, signal]) : wait })
    } catch (error) {
      if (error instanceof RepositoryLeaseAbortedError) throw signal?.aborted ? cancelledError() : gitErrors.create('git_busy', error)
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

  /**
   * The top of the repository. Status paths are relative to it, not to the project folder,
   * which can be a subfolder, so every action that takes such paths runs from here.
   */
  private async toplevel(cwd: string): Promise<string> {
    return resolve(await this.read(cwd, ['rev-parse', '--show-toplevel']) ?? cwd)
  }

  private async statusEntries(cwd: string): Promise<RawEntry[]> {
    return rawEntries(await this.gitFor(cwd).status())
  }

  private async hasHead(cwd: string): Promise<boolean> {
    return (await this.read(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])) !== null
  }

  /**
   * Runs `git <command> --pathspec-from-file` over the paths. The list goes through a
   * temp file because simple-git has no stdin and a long list would exceed the
   * command-line limit; the paths are literal, so `*` and `[` in names match themselves.
   */
  private async withPathspecFile(cwd: string, command: readonly string[], paths: readonly string[], fail: GitErrorCode = 'git_failed'): Promise<void> {
    if (paths.length === 0) return
    const dir = await mkdtemp(join(tmpdir(), 'mousse-pathspec-'))
    try {
      const file = join(dir, 'paths')
      await writeFile(file, `${paths.join('\0')}\0`)
      const run = await this.runGit(cwd, [...command, `--pathspec-from-file=${file}`, '--pathspec-file-nul'], { env: { GIT_LITERAL_PATHSPECS: '1' } })
      if (!run.ok) throw failure(fail, run)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Stages the working tree state of these paths, including deletions and new files. Paths with nothing to stage are skipped. */
  async stage(cwd: string, paths: readonly string[]): Promise<void> {
    await this.serialized(cwd, async () => {
      const top = await this.toplevel(cwd)
      const targets = selectEntries(await this.statusEntries(top), paths).filter((entry) => entry.workdir !== '')
      await this.withPathspecFile(top, ['add'], targets.map((entry) => entry.path))
    })
  }

  async stageAll(cwd: string): Promise<void> {
    await this.serialized(cwd, async () => {
      const run = await this.runGit(await this.toplevel(cwd), ['add', '-A'])
      if (!run.ok) throw failure('git_failed', run)
    })
  }

  /** Takes these paths out of the index and leaves the working tree alone. A staged rename is unstaged on both names. */
  async unstage(cwd: string, paths: readonly string[]): Promise<void> {
    await this.serialized(cwd, async () => {
      const top = await this.toplevel(cwd)
      const targets = selectEntries(await this.statusEntries(top), paths).filter((entry) => entry.index !== '' && entry.index !== '?' && !isConflicted(entry))
      const names = new Set<string>()
      for (const entry of targets) {
        names.add(entry.path)
        if (entry.index === 'R' && entry.from) names.add(entry.from)
      }
      const unborn = !await this.hasHead(top)
      // `-f` lets `rm --cached` drop an index entry whose content differs from the file; the file itself is kept.
      await this.withPathspecFile(top, unborn ? ['rm', '--cached', '-r', '-f', '--ignore-unmatch'] : ['restore', '--staged'], [...names])
    })
  }

  async unstageAll(cwd: string): Promise<void> {
    await this.serialized(cwd, async () => {
      const top = await this.toplevel(cwd)
      const unborn = !await this.hasHead(top)
      const run = await this.runGit(top, unborn ? ['rm', '--cached', '-r', '-f', '--ignore-unmatch', '-q', '--', '.'] : ['restore', '--staged', '--', '.'])
      if (!run.ok) throw failure('git_failed', run)
    })
  }

  /**
   * Throws the changes of these paths away: tracked files go back to HEAD (index and
   * working tree), files HEAD does not have are removed, untracked files are deleted.
   * This cannot be undone, so the caller confirms first.
   */
  async discard(cwd: string, paths: readonly string[]): Promise<void> {
    await this.serialized(cwd, async () => {
      const top = await this.toplevel(cwd)
      const selected = selectEntries(await this.statusEntries(top), paths)
      const unborn = !await this.hasHead(top)
      const restore = new Set<string>()
      const remove = new Set<string>()
      const untracked: string[] = []
      for (const entry of selected) {
        if (isUntracked(entry)) {
          untracked.push(entry.path)
          continue
        }
        const pair = `${entry.index || ' '}${entry.workdir || ' '}`
        // A path added to the index (also intent-to-add), the new name of a rename or copy, or a conflict whose "us" side lacks the path has no version in HEAD.
        const absent = unborn || ABSENT_FROM_HEAD_PAIRS.has(pair) || (!isConflicted(entry) && (entry.index === 'A' || entry.index === 'R' || entry.index === 'C' || (entry.index === '' && entry.workdir === 'A')))
        if (absent) remove.add(entry.path)
        else restore.add(entry.path)
        if (!unborn && entry.index === 'R' && entry.from) restore.add(entry.from)
      }
      await this.withPathspecFile(top, ['restore', '--source=HEAD', '--staged', '--worktree'], [...restore])
      await this.withPathspecFile(top, ['rm', '-f', '-r', '--ignore-unmatch', '-q'], [...remove])
      await this.removeUntracked(top, untracked)
    })
  }

  /**
   * `git clean` takes no pathspec file, so untracked paths are removed directly, each confined
   * to the repository. Like `git clean -d`, a nested Git repository is left alone: it shows up
   * as one untracked directory, and removing it would delete its history.
   */
  private async removeUntracked(top: string, paths: readonly string[]): Promise<void> {
    const root = resolve(top)
    for (const path of paths) {
      const target = resolve(root, path)
      if (target === root || !target.startsWith(root + sep)) throw gitErrors.create('git_path_outside')
      if (existsSync(join(target, '.git'))) continue
      await rm(target, { recursive: true, force: true })
      // Like `git clean -d`, leave no empty directory behind.
      for (let dir = dirname(target); dir !== root && dir.startsWith(root + sep); dir = dirname(dir)) {
        if (!await rmdir(dir).then(() => true, () => false)) break
      }
    }
  }

  async fetch(cwd: string, options: GitOperationRequest = {}): Promise<GitFetchResult> {
    return this.runOperation(cwd, 'fetch', options, true, (live) => this.serialized(cwd, async () => {
      assertNotCancelled(live)
      const git = this.gitFor(cwd)
      const remotes = await this.read(cwd, ['remote'])
      if (!remotes) throw gitErrors.create('git_no_remote')
      const behindBefore = await this.behindCount(git)
      // No pruning and no background gc: a fetch that was only asked for news must not rewrite local refs or stall on housekeeping.
      const run = await this.runLive(cwd, ['fetch', '--no-auto-gc', '--progress'], live, { env: explicitActionGitEnv(), silenceMs: FETCH_SILENCE_MS })
      if (!run.ok) {
        if (run.cancelled) throw cancelledError()
        if (run.stalled) throw gitErrors.create('git_silence_timeout')
        const code = remoteFailureCode(run.output)
        throw code ? classified(code, run) : failure('git_fetch_failed', run)
      }
      return { behindBefore, behindAfter: await this.behindCount(git) }
    }, live.signal))
  }

  private async behindCount(git: SimpleGit): Promise<number> {
    return git.raw(['rev-list', '--count', 'HEAD..@{upstream}']).then((value) => Number(value.trim()) || 0).catch(() => 0)
  }

  /**
   * Brings in the upstream's commits. Fast-forward only by default; the caller chooses
   * merge or rebase when the branch has diverged. A merge or rebase that stops on
   * conflicts is returned as `conflicted` and left as Git left it, for the user to
   * resolve or abort.
   */
  async pull(cwd: string, options: GitPullOptions & GitOperationRequest = {}): Promise<GitPullResult> {
    const strategy = options.strategy ?? 'ff-only'
    return this.runOperation(cwd, 'pull', options, true, (live) => this.serialized(cwd, async () => {
      assertNotCancelled(live)
      const git = this.gitFor(cwd)
      const branch = await this.currentBranch(cwd)
      if (!branch) throw gitErrors.create('git_detached_head')
      if (!await this.upstream(git)) throw gitErrors.create('git_no_upstream')
      const before = await this.read(cwd, ['rev-parse', 'HEAD'])
      // A merge or rebase already waiting makes Git refuse the pull; that is an error, not a new conflict.
      const waiting = await this.inProgress(cwd)
      // Two steps instead of `git pull`, so only the first can be cancelled. The download changes no file of the
      // folder and may be stopped, and it has the fetch silence timer. A merge or rebase killed halfway can leave
      // changed files with nothing to abort and, on Windows, a lock file, so it never is: not by a timer, not by Cancel.
      const target = await this.branchUpstream(cwd, branch)
      if (target) {
        const fetched = await this.runLive(cwd, ['fetch', '--no-auto-gc', '--progress', target.remote], live, { env: explicitActionGitEnv(), silenceMs: FETCH_SILENCE_MS })
        if (!fetched.ok) {
          if (fetched.cancelled) throw cancelledError()
          if (fetched.stalled) throw gitErrors.create('git_silence_timeout')
          const code = remoteFailureCode(fetched.output)
          throw code ? classified(code, fetched) : failure('git_pull_failed', fetched)
        }
      }
      assertNotCancelled(live)
      live.stopCancelling()
      const integrate = strategy === 'ff-only' ? ['merge', '--ff-only', '@{upstream}'] : strategy === 'merge' ? ['merge', '--no-edit', '@{upstream}'] : ['rebase', '@{upstream}']
      const run = await this.runLive(cwd, integrate, live, { env: explicitActionGitEnv() })
      if (!run.ok) {
        if (!waiting && await this.inProgress(cwd)) return { result: 'conflicted' }
        const text = run.output
        if (/Not possible to fast-forward|Need to specify how to reconcile/i.test(text)) throw classified('git_pull_diverged', run)
        if (/would be overwritten|commit your changes or stash|You have unstaged changes|cannot pull with rebase|cannot rebase/i.test(text)) throw classified('git_pull_dirty', run)
        if (/no tracking information|no upstream/i.test(text)) throw classified('git_no_upstream', run)
        const code = remoteFailureCode(text)
        throw code ? classified(code, run) : failure('git_pull_failed', run)
      }
      const after = await this.read(cwd, ['rev-parse', 'HEAD'])
      if (before === after) return { result: 'up-to-date' }
      if (strategy === 'merge') {
        const parents = (await this.read(cwd, ['rev-list', '--parents', '-n', '1', 'HEAD']))?.split(/\s+/) ?? []
        return { result: parents.length > 2 ? 'merged' : 'fast-forwarded' }
      }
      if (strategy === 'rebase') {
        const forwarded = before !== null && (await this.runGit(cwd, ['merge-base', '--is-ancestor', before, 'HEAD'])).ok
        return { result: forwarded ? 'fast-forwarded' : 'rebased' }
      }
      return { result: 'fast-forwarded' }
    }, live.signal))
  }

  /** Gives up a merge or rebase that stopped on conflicts. Only ever called by an explicit user action. */
  async abortInProgress(cwd: string, kind: 'merge' | 'rebase'): Promise<void> {
    await this.serialized(cwd, async () => {
      const run = await this.runGit(cwd, [kind, '--abort'])
      if (!run.ok) throw failure('git_failed', run)
    })
  }

  /** The checked-out branch, or null for a detached HEAD. */
  async currentBranch(cwd: string): Promise<string | null> {
    return (await this.read(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) || null
  }

  /**
   * The remote and branch a local branch is set to push to and track, or null when it has none (an
   * unpublished branch, or one that tracks a local branch).
   */
  async branchUpstream(cwd: string, branch: string): Promise<{ remote: string; branch: string } | null> {
    if (!branch || branch.startsWith('-')) return null
    const remote = await this.read(cwd, ['config', '--get', `branch.${branch}.remote`])
    const merge = await this.read(cwd, ['config', '--get', `branch.${branch}.merge`])
    if (!remote || remote === '.' || !merge?.startsWith('refs/heads/')) return null
    return { remote, branch: merge.slice('refs/heads/'.length) }
  }

  /** Refuses with `git_branch_changed` when `expected` is given and HEAD is on another branch. */
  async assertBranch(cwd: string, expected: string | undefined): Promise<void> {
    if (expected !== undefined && await this.currentBranch(cwd) !== expected) throw gitErrors.create('git_branch_changed')
  }

  /**
   * What a branch adds to its base, for describing it: its commits, a diffstat and the patch. Always read
   * from the named branch's ref, never from HEAD, and bounded in size. The base is its remote-tracking
   * branch when there is one, else the local branch; with neither, nothing is read.
   */
  async readBranchSummary(
    cwd: string,
    { branch, base, remote }: { branch: string; base: string; remote: string | null }
  ): Promise<BranchSummary> {
    const none: BranchSummary = { commits: [], stat: '', patch: '' }
    if (!branch || !base || branch.startsWith('-') || base.startsWith('-') || (remote?.startsWith('-') ?? false)) return none
    const head = `refs/heads/${branch}`
    let from: string | null = null
    for (const ref of [...(remote ? [`refs/remotes/${remote}/${base}`] : []), `refs/heads/${base}`]) {
      if (await this.read(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null) {
        from = ref
        break
      }
    }
    if (!from || await this.read(cwd, ['rev-parse', '--verify', '--quiet', `${head}^{commit}`]) === null) return none
    // No external diff driver or text conversion: a repository's configuration must not run programs here.
    const diff = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']
    const [log, stat, patch] = await Promise.all([
      readBoundedGit(cwd, ['log', '--no-color', '--max-count=50', '--format=%x1e%s%x1f%b', `${from}..${head}`], 2 * PULL_REQUEST_DRAFT_LIMITS.commits),
      readBoundedGit(cwd, [...diff, '--stat=100', `${from}...${head}`], 2 * PULL_REQUEST_DRAFT_LIMITS.stat),
      readBoundedGit(cwd, [...diff, '--unified=3', `${from}...${head}`], 2 * PULL_REQUEST_DRAFT_LIMITS.patch)
    ])
    const commits = log.split('\x1e').filter((entry) => entry.trim()).map((entry) => {
      const [subject = '', ...body] = entry.split('\x1f')
      return { subject: subject.trim(), body: body.join('\x1f').trim() }
    })
    return { commits, stat: stat.trim(), patch }
  }

  /**
   * The changes the next commit would take, reduced for describing them to a model. Staged changes when
   * any are staged, otherwise the working tree against HEAD with untracked files named only; `all` is a
   * commit that takes everything whatever the index holds (a thread's worktree), leaving out `.mousse/`.
   * Nothing outside that set is read, ignored files are never listed, and what is read is bounded: a patch
   * of `maxBytes` at most, binary files as "Binary files differ", files that changed a great many lines
   * left out of the patch (they stay in the summary), and each list capped.
   */
  async describeCommitInput(cwd: string, options: { all?: boolean; maxBytes?: number } = {}): Promise<CommitInput> {
    if (!await this.isRepo(cwd)) return EMPTY_COMMIT_INPUT
    const limits = COMMIT_SUGGESTION_LIMITS
    const maxBytes = options.maxBytes ?? limits.diff
    // From the top, like the commit: paths and pathspecs below are relative to it, not to a project subfolder.
    const top = await this.toplevel(cwd)
    const staged = !options.all && await readBoundedGit(top, ['diff', '--cached', '--name-only', '-z'], 64) !== ''
    const against = staged || !await this.hasHead(top) ? ['--cached'] : ['HEAD']
    // A repository's configuration must not run programs here: no external diff driver, no text conversion.
    const diff = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']
    const scope = options.all ? [':(exclude).mousse/**'] : []

    const numstatLimit = 64 * 1024
    const numstatRaw = await readBoundedGit(top, [...diff, '--numstat', '-z', ...against, '--', '.', ...scope], numstatLimit)
    const entries = parseNumstat(numstatRaw)
    const huge = entries.filter((entry) => (entry.added ?? 0) + (entry.deleted ?? 0) > limits.hugeFileLines)
    const excluded = huge.slice(0, limits.excludedFiles).map((entry) => `:(exclude,literal)${entry.path}`)

    const patchLimit = 3 * maxBytes
    const [statRaw, patchRaw, untrackedRaw] = await Promise.all([
      readBoundedGit(top, [...diff, '--stat=120', `--stat-count=${limits.excludedFiles}`, ...against, '--', '.', ...scope], 2 * limits.stat),
      readBoundedGit(top, [...diff, '--unified=3', ...against, '--', '.', ...scope, ...excluded], patchLimit),
      // Only a commit that stages everything takes new files; the index alone never does.
      staged ? Promise.resolve('') : readBoundedGit(top, ['ls-files', '--others', '--exclude-standard', '-z'], numstatLimit)
    ])
    const patch = fitPatch(patchRaw, { maxBytes, perFileBytes: Math.floor(maxBytes / 2), readCut: Buffer.byteLength(patchRaw) >= patchLimit - 4 })
    const tracked = entries.map((entry) => entry.path)
    const untracked = untrackedRaw.split('\0').filter((path) => path && !(options.all && (path === '.mousse' || path.startsWith('.mousse/'))))
    const statCut = Buffer.byteLength(statRaw) >= 2 * limits.stat - 4
    const statLines = statRaw.split('\n')
    const stat = statCut ? statLines.slice(0, -1).join('\n') : statRaw
    const files = [...tracked, ...untracked]
    return {
      diff: redactGitText(patch.text),
      stat: redactGitText(stat.trim()),
      truncated: patch.truncated || huge.length > 0 || statCut || files.length > limits.files || Buffer.byteLength(numstatRaw) >= numstatLimit - 4,
      files: files.slice(0, limits.files),
      untracked: untracked.slice(0, limits.files)
    }
  }

  /** A name Git accepts for a branch, and one that cannot be mistaken for an option. */
  private async assertBranchName(cwd: string, name: string): Promise<void> {
    if (isManagedBranch(name)) throw gitErrors.create('git_branch_protected')
    const checked = name.startsWith('-') ? null : await this.read(cwd, ['check-ref-format', '--branch', name])
    if (checked !== name) throw gitErrors.create('git_branch_invalid')
  }

  /**
   * Whether a local branch has exactly this name. `rev-parse refs/heads/<name>` is not enough: a loose ref is
   * a file, so on Windows and macOS it is found whatever the case, while the guards compare names exactly.
   */
  private async branchExists(cwd: string, name: string): Promise<boolean> {
    const listed = await this.read(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
    return (listed ?? '').split('\n').includes(name)
  }

  async createBranch(cwd: string, name: string, options: GitBranchOptions = {}): Promise<void> {
    await this.serialized(cwd, async () => {
      await this.assertBranchName(cwd, name)
      if (await this.branchExists(cwd, name)) throw gitErrors.create('git_branch_exists')
      const from = options.from
      if (from !== undefined && (from.startsWith('-') || await this.read(cwd, ['rev-parse', '--verify', '--quiet', `${from}^{commit}`]) === null)) throw gitErrors.create('git_ref_not_found')
      const args = options.checkout === false ? ['branch', name] : ['switch', '-c', name]
      if (from !== undefined) args.push(from)
      const run = await this.runGit(cwd, args)
      if (!run.ok) throw this.checkoutFailure(run, 'git_branch_failed')
    })
  }

  async renameBranch(cwd: string, name: string, newName: string): Promise<void> {
    await this.serialized(cwd, async () => {
      if (isManagedBranch(name)) throw gitErrors.create('git_branch_protected')
      await this.assertBranchName(cwd, newName)
      if (!await this.branchExists(cwd, name)) throw gitErrors.create('git_ref_not_found')
      if (name !== newName && await this.branchExists(cwd, newName)) throw gitErrors.create('git_branch_exists')
      const run = await this.runGit(cwd, ['branch', '-m', '--', name, newName])
      if (!run.ok) throw failure('git_branch_failed', run)
    })
  }

  async deleteBranch(cwd: string, name: string, options: GitDeleteBranchOptions = {}): Promise<void> {
    await this.serialized(cwd, async () => {
      if (isManagedBranch(name)) throw gitErrors.create('git_branch_protected')
      // Only an exact name is deleted; a differently cased one could still reach the current or a managed branch.
      if (!await this.branchExists(cwd, name)) throw gitErrors.create('git_ref_not_found')
      if ((await this.currentBranch(cwd))?.toLowerCase() === name.toLowerCase()) throw gitErrors.create('git_branch_current')
      const run = await this.runGit(cwd, ['branch', options.force ? '-D' : '-d', '--', name])
      if (run.ok) return
      if (/not fully merged/i.test(run.output)) throw classified('git_branch_unmerged', run)
      if (/checked out at|used by worktree/i.test(run.output)) throw classified('git_branch_in_worktree', run)
      throw failure('git_branch_failed', run)
    })
  }

  private checkoutFailure(run: GitRun, fallback: GitErrorCode): AppError {
    if (/Your local changes to the following files would be overwritten|Please commit your changes or stash them/i.test(run.output)) return classified('git_checkout_dirty', run)
    if (/untracked working tree files would be overwritten/i.test(run.output)) return classified('git_checkout_untracked_collision', run)
    return failure(fallback, run)
  }

  private async switchTo(cwd: string, branch: string, live?: Live): Promise<void> {
    if (branch.startsWith('-')) throw gitErrors.create('git_branch_invalid')
    // Never on a timer, and no Cancel: a checkout killed halfway leaves a half-switched tree.
    const run = await this.runLive(cwd, ['checkout', branch, '--'], live, { env: explicitActionGitEnv() })
    if (!run.ok) throw this.checkoutFailure(run, 'git_checkout_failed')
  }

  /**
   * Switches branches. With `dirty: 'stash'` the uncommitted changes (untracked files
   * included) are stashed, the switch happens, and they are re-applied; if re-applying
   * conflicts, the stash is kept and `stashKept` says so.
   */
  async checkout(cwd: string, branch: string, options: GitCheckoutOptions & GitOperationRequest = {}): Promise<GitCheckoutResult> {
    return this.runOperation(cwd, 'checkout', options, false, (live) => this.serialized(cwd, async () => {
      if (options.dirty !== 'stash') {
        await this.switchTo(cwd, branch, live)
        return {}
      }
      const stashRef = () => this.read(cwd, ['rev-parse', '-q', '--verify', 'refs/stash'])
      const before = await stashRef()
      const push = await this.runGit(cwd, ['stash', 'push', '-u', '-m', `mousse: switch to ${branch}`])
      // With nothing to stash Git exits 0 and says so; popping then would apply an older, unrelated stash.
      const stashed = await stashRef() !== before
      if (!push.ok) {
        // A stash can exist even though Git reported a failure, for example when it could not remove an untracked file.
        if (stashed && !await this.popStash(cwd)) throw gitErrors.create('git_stash_kept', push.output)
        throw failure('git_stash_failed', push)
      }
      try {
        await this.switchTo(cwd, branch, live)
      } catch (error) {
        if (stashed && !await this.popStash(cwd)) throw gitErrors.create('git_stash_kept', error)
        throw error
      }
      if (!stashed) return {}
      return await this.popStash(cwd) ? {} : { stashKept: true }
    }))
  }

  /**
   * Puts the newest stash back, with its staged part, so a file that was staged and edited
   * again comes back the same. If the staged part cannot be re-applied Git refuses before
   * touching anything, and the plain pop still brings the edits back. False means the stash is kept.
   */
  private async popStash(cwd: string): Promise<boolean> {
    const indexed = await this.runGit(cwd, ['stash', 'pop', '--index'])
    if (indexed.ok) return true
    if (/Conflicts in index|Try without --index/i.test(indexed.output)) return (await this.runGit(cwd, ['stash', 'pop'])).ok
    return false
  }

  private async hasStagedChanges(cwd: string): Promise<boolean> {
    const run = await this.runGit(cwd, ['diff', '--cached', '--quiet'])
    return !run.ok
  }

  /**
   * Commits the index when anything is staged, so files staged on purpose commit alone.
   * With an empty index, or with `all`, everything is staged first. That `git add -A` is
   * undone if the commit fails (a hook rejects it), so the index is left as the user
   * had it. A commit during a merge keeps the merge's second parent.
   *
   * The undo restores the index from a tree object. A repository with a sparse checkout
   * loses its skip-worktree marks in that restore, and an intent-to-add entry comes back
   * as an untracked file.
   */
  async commit(cwd: string, message: string, options: GitCommitOptions & GitOperationRequest = {}): Promise<void> {
    await this.runOperation(cwd, 'commit', options, true, (live) => this.serialized(cwd, async () => {
      assertNotCancelled(live)
      const git = this.gitFor(cwd)
      await this.assertBranch(cwd, options.expectedBranch)
      // `add -A` would record unresolved conflict markers as resolved.
      if ((await this.statusEntries(cwd)).some(isConflicted)) throw gitErrors.create('git_merge_unresolved')
      if (options.amend) await this.assertAmendable(git)

      let snapshot: string | null = null
      if (options.all || !await this.hasStagedChanges(cwd)) {
        const tree = await this.runGit(cwd, ['write-tree'])
        if (!tree.ok) throw failure('git_commit_failed', tree)
        snapshot = tree.stdout.trim()
        // From the top of the repository: the project can be a subfolder, and the checkpoint that follows sweeps the whole tree.
        const add = await this.runGit(await this.toplevel(cwd), ['add', '-A', ...(options.all ? ['--', '.', ':(exclude).mousse/**'] : [])])
        if (!add.ok) {
          await this.restoreIndex(cwd, snapshot, add)
          throw failure('git_commit_failed', add)
        }
        // Nothing to commit is not an error, except that finishing a merge needs a commit even when the tree is unchanged.
        if (!options.amend && !await this.hasStagedChanges(cwd) && await this.inProgress(cwd) !== 'merge') return
      }

      const headBefore = await this.read(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
      const lock = await this.indexLock(cwd)
      const lockedBefore = lock !== null && existsSync(lock)
      const run = await this.runLive(cwd, ['commit', ...(options.amend ? ['--amend'] : []), '-m', message], live, { env: explicitActionGitEnv(), silenceMs: this.options.commitSilenceMs ?? COMMIT_SILENCE_MS, hooks: true })
      if (run.ok) return
      // The commit was recorded and only something after it failed or was stopped (a slow post-commit hook). Putting the old index back now would stage the commit's reversal.
      if (await this.read(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== headBefore) return
      let restoreError: unknown = null
      if (snapshot !== null) await this.restoreIndex(cwd, snapshot, run).catch((error: unknown) => { restoreError = error })
      // A Git stopped by force can leave its index lock behind (Windows cannot end a process gently). Whose lock it is cannot be told:
      // Git does not hold it while a hook runs, and a terminal or an editor may have taken it meanwhile. It is never deleted here.
      if ((run.cancelled || run.stalled) && lock !== null && !lockedBefore && existsSync(lock)) throw gitErrors.create('git_index_locked', restoreError, { path: lock })
      if (restoreError) throw restoreError
      if (run.cancelled) throw cancelledError()
      throw run.stalled ? gitErrors.create('git_silence_timeout') : failure('git_commit_failed', run)
    }, live.signal))
  }

  /** Where Git keeps the lock it holds while writing this folder's index. */
  private async indexLock(cwd: string): Promise<string | null> {
    const path = await this.read(cwd, ['rev-parse', '--git-path', 'index.lock'])
    return path ? resolve(cwd, path) : null
  }

  /** Puts the index back as it was before `add -A`. If that fails the caller is told, because everything is staged now. */
  private async restoreIndex(cwd: string, tree: string, cause: GitRun): Promise<void> {
    const run = await this.runGit(cwd, ['read-tree', tree])
    if (!run.ok) throw gitErrors.create('git_index_restore_failed', redactGitText(`${cause.output}
${run.output}`))
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

  async push(cwd: string, options: GitPushOptions & GitOperationRequest = {}): Promise<void> {
    await this.runOperation(cwd, 'push', options, true, (live) => this.serialized(cwd, () => this.pushNow(cwd, options, live), live.signal))
  }

  private async pushNow(cwd: string, options: GitPushOptions, live: Live): Promise<void> {
    assertNotCancelled(live)
    await this.assertBranch(cwd, options.expectedBranch)
    const git = this.gitFor(cwd)
    const branch = await this.currentBranch(cwd)
    if (!branch) throw gitErrors.create('git_detached_head')
    const hasUpstream = Boolean(await this.upstream(git))
    const remote = hasUpstream ? null : await this.publishRemote(git, branch)
    if (!hasUpstream && !remote) throw gitErrors.create('git_no_remote')
    // With an upstream, let Git resolve pushRemote, remote.pushDefault, refspecs and push.default.
    // Progress output keeps a slow but healthy upload from looking silent; a push that does go
    // silent is waiting on a prompt nobody can answer and is stopped before it holds the folder's lease.
    const run = await this.runLive(cwd, remote ? ['push', '--progress', '-u', remote, branch] : ['push', '--progress'], live, { env: explicitActionGitEnv(), silenceMs: PUSH_SILENCE_MS, hooks: true })
    if (run.ok) return
    if (run.cancelled) throw cancelledError()
    if (run.stalled) throw gitErrors.create('git_silence_timeout')
    throw this.pushFailure(run)
  }

  private pushFailure(run: GitRun): AppError {
    const text = run.output
    const remoteCode = remoteFailureCode(text)
    if (remoteCode) return classified(remoteCode, run)
    if (/\[remote rejected\]/i.test(text)) return classified('git_push_rejected_by_remote', run)
    if (isPushRejected(text)) return classified('git_push_rejected', run)
    return failure('git_push_failed', run)
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
