import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import type {
  GitBranchInfo,
  GitBranchOptions,
  GitCheckoutOptions,
  GitCheckoutResult,
  GitCommit,
  GitCommitSuggestion,
  GitDeleteBranchOptions,
  GitDiffStats,
  GitFetchResult,
  GitPullOptions,
  GitPullResult,
  GitScope,
  GitStatusSnapshot
} from '../../shared/types'
import type { PullRequestScope } from '../../shared/pullRequests'
import { errorText } from '../lib/errorText'
import { anyTurnEnded } from '../lib/turnEnded'
import { useAppStore } from './appStore'
import { trackGitOperation } from './gitOperationStore'
import { createPullRequestForBranch, pullRequestKey, refreshPullRequest, useGitPullRequestStore } from './pullRequestStore'

/**
 * One shared copy of Git state per working folder, read by the Git panel and the
 * thread side card. Requests for the same folder share a single in-flight fetch, so
 * the two surfaces never run the same Git commands twice.
 */

export const GIT_LOG_LIMIT = 40
/** A fetch younger than this satisfies an ordinary (not forced) request. */
export const GIT_STATUS_MAX_AGE_MS = 1500

export interface GitStatusEntry {
  status: GitStatusSnapshot | null
  commits: GitCommit[]
  branches: GitBranchInfo | null
  diffStats: GitDiffStats | null
  /** The first fetch for this folder is running. Later refreshes keep showing the data they have. */
  loading: boolean
  /** The first fetch for this folder has finished, successfully or not. */
  loaded: boolean
  error: string | null
  fetchedAt: number
}

interface GitStatusState {
  entries: Record<string, GitStatusEntry>
}

export const EMPTY_GIT_ENTRY: GitStatusEntry = {
  status: null,
  commits: [],
  branches: null,
  diffStats: null,
  loading: false,
  loaded: false,
  error: null,
  fetchedAt: 0
}

export const useGitStatusStore = create<GitStatusState>(() => ({ entries: {} }))

export interface GitRefreshOptions {
  /** Fetch again even if the data is fresh, and again after a fetch already in flight. */
  force?: boolean
  /** Marks refreshes the user did not ask for. `loading` is only ever set for the first fetch, so this does not change the state. */
  quiet?: boolean
  projectId?: string
}

interface Flight {
  promise: Promise<void>
  rerun: boolean
}

const flights = new Map<string, Flight>()

function patchEntry(path: string, patch: Partial<GitStatusEntry>) {
  useGitStatusStore.setState((state) => ({
    entries: { ...state.entries, [path]: { ...(state.entries[path] ?? EMPTY_GIT_ENTRY), ...patch } }
  }))
}

/** Keep the previous reference when nothing changed, so unchanged data does not re-render readers. */
export function keepIfEqual<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
}

async function fetchInto(path: string, projectId: string | undefined): Promise<void> {
  const git = window.mousse.git
  const [status, log, branches, diffStats] = await Promise.allSettled([
    git.status(projectId, path),
    git.log(GIT_LOG_LIMIT, projectId, path),
    git.branches(projectId, path),
    git.diffStats(projectId, path)
  ])
  const previous = useGitStatusStore.getState().entries[path] ?? EMPTY_GIT_ENTRY

  if (status.status === 'rejected') {
    patchEntry(path, { loaded: true, error: errorText(status.reason), fetchedAt: Date.now() })
    return
  }
  if (!status.value.isRepo) {
    patchEntry(path, {
      status: keepIfEqual(previous.status, status.value),
      commits: previous.commits.length ? [] : previous.commits,
      branches: null,
      diffStats: null,
      loaded: true,
      error: null,
      fetchedAt: Date.now()
    })
    return
  }
  patchEntry(path, {
    status: keepIfEqual(previous.status, status.value),
    commits: log.status === 'fulfilled' ? keepIfEqual(previous.commits, log.value) : previous.commits,
    branches: branches.status === 'fulfilled' ? keepIfEqual(previous.branches, branches.value) : previous.branches,
    diffStats: diffStats.status === 'fulfilled' ? keepIfEqual(previous.diffStats, diffStats.value) : previous.diffStats,
    loaded: true,
    error: null,
    fetchedAt: Date.now()
  })
}

/**
 * Refresh the shared Git state for a folder. Concurrent callers share one fetch; a
 * forced call that arrives mid-fetch queues exactly one more fetch behind it. Never
 * rejects: a failed status fetch is recorded on the entry as `error`.
 */
export function refreshGitStatus(path: string, options: GitRefreshOptions = {}): Promise<void> {
  const flight = flights.get(path)
  if (flight) {
    if (options.force) flight.rerun = true
    return flight.promise
  }

  const entry = useGitStatusStore.getState().entries[path]
  if (!options.force && entry?.loaded && Date.now() - entry.fetchedAt < GIT_STATUS_MAX_AGE_MS) {
    return Promise.resolve()
  }

  const next: Flight = { promise: Promise.resolve(), rerun: false }
  flights.set(path, next)
  // Only a folder with nothing loaded yet shows a spinner; a refresh keeps the cached data on screen.
  patchEntry(path, { loading: !entry?.loaded })
  next.promise = (async () => {
    try {
      do {
        next.rerun = false
        await fetchInto(path, options.projectId)
      } while (next.rerun)
    } finally {
      flights.delete(path)
      patchEntry(path, { loading: false })
    }
  })()
  return next.promise
}

/** The project id a refresh reads with; the daemon names the folder by `scope`, the main process reads it by `path`. */
function refreshProjectId(scope: GitScope): string | undefined {
  return scope.projectId ?? undefined
}

/** Refresh a folder after a mutation, whether it worked or not. */
async function refreshAfterMutation(path: string, scope: GitScope): Promise<void> {
  await refreshGitStatus(path, { force: true, quiet: true, projectId: refreshProjectId(scope) })
}

/** Switch branches, then refresh. Rejects with Git's message when the checkout fails. */
export async function checkoutGitBranch(path: string, branch: string, scope: GitScope, options: GitCheckoutOptions = {}): Promise<GitCheckoutResult> {
  try {
    const result = await trackGitOperation(path, 'checkout', (operationId) => window.mousse.git.checkout(scope, branch, { ...options, operationId }))
    return { stashKept: result.stashKept }
  } finally {
    // A failed stash-and-switch can already have taken the changes out of the working tree.
    await refreshAfterMutation(path, scope)
  }
}

/** Stage these paths, or everything. */
export async function stageGitPaths(path: string, paths: readonly string[] | 'all', scope: GitScope): Promise<void> {
  try {
    await window.mousse.git.stage(scope, paths === 'all' ? { all: true } : { paths: [...paths] })
  } finally {
    await refreshAfterMutation(path, scope)
  }
}

/** Take these paths out of the index, or everything. */
export async function unstageGitPaths(path: string, paths: readonly string[] | 'all', scope: GitScope): Promise<void> {
  try {
    await window.mousse.git.unstage(scope, paths === 'all' ? { all: true } : { paths: [...paths] })
  } finally {
    await refreshAfterMutation(path, scope)
  }
}

/** Throw away the changes to these paths; untracked files are deleted. The caller confirms first. */
export async function discardGitPaths(path: string, paths: readonly string[], scope: GitScope): Promise<void> {
  try {
    await window.mousse.git.discard(scope, [...paths])
  } finally {
    await refreshAfterMutation(path, scope)
  }
}

/** Fetch the branch's remote and say how far behind it is now. */
export async function fetchGit(path: string, scope: GitScope): Promise<GitFetchResult> {
  try {
    const result = await trackGitOperation(path, 'fetch', (operationId) => window.mousse.git.fetch(scope, { operationId }))
    return { behindBefore: result.behindBefore, behindAfter: result.behindAfter }
  } finally {
    await refreshAfterMutation(path, scope)
  }
}

/** Pull the upstream into the branch; `conflicted` leaves the merge or rebase for the user. */
export async function pullGit(path: string, scope: GitScope, options: GitPullOptions = {}): Promise<GitPullResult> {
  try {
    const result = await trackGitOperation(path, 'pull', (operationId) => window.mousse.git.pull(scope, { ...options, operationId }))
    return { result: result.result }
  } finally {
    // A conflicted pull rejects nothing, but a failed one may still have changed the folder.
    await refreshAfterMutation(path, scope)
  }
}

/** Abort the merge or rebase that is waiting on the user. */
export async function abortGitInProgress(path: string, kind: 'merge' | 'rebase', scope: GitScope): Promise<void> {
  try {
    await window.mousse.git.abortInProgress(scope, kind)
  } finally {
    await refreshAfterMutation(path, scope)
  }
}

export async function createGitBranch(path: string, name: string, scope: GitScope, options: GitBranchOptions = {}): Promise<void> {
  try {
    await window.mousse.git.createBranch(scope, name, options)
  } finally {
    await refreshAfterMutation(path, scope)
  }
}

export async function renameGitBranch(path: string, name: string, newName: string, scope: GitScope): Promise<void> {
  try {
    await window.mousse.git.renameBranch(scope, name, newName)
  } finally {
    await refreshAfterMutation(path, scope)
  }
}

export async function deleteGitBranch(path: string, name: string, scope: GitScope, options: GitDeleteBranchOptions = {}): Promise<void> {
  try {
    await window.mousse.git.deleteBranch(scope, name, options)
  } finally {
    await refreshAfterMutation(path, scope)
  }
}

/** The step of a running commit flow, in the order the steps happen. */
export type CommitPhase = 'committing' | 'pushing' | 'opening-pr'

/** The daemon's wording for a commit or push that finds HEAD on another branch than the one the user chose. */
export const BRANCH_CHANGED_MESSAGE = 'The branch changed while this was open. Review it, then try again.'

export interface CommitGitOptions {
  /** Rewrite the latest commit instead of adding one. */
  amend?: boolean
  /** Push the branch after the commit. */
  push?: boolean
  /**
   * Push, and then open the Create PR form for this scope, the same form the Create PR row opens. The scope is
   * the one the row would use, captured when the button was pressed; its branch must be the folder's current one.
   */
  openPullRequest?: PullRequestScope
  /** Reports each step, so a button can say what is running. */
  onPhase?: (phase: CommitPhase) => void
}

/** What became of the pull request step of "Commit, push and open PR". */
export type CommitPullRequestOutcome =
  | { kind: 'form' }
  | { kind: 'existing'; number: number; state: 'open' | 'closed' | 'merged' }

export interface CommitGitResult {
  /** Set only when `openPullRequest` was asked for. */
  pullRequest: CommitPullRequestOutcome | null
}

/** The commit landed but the push after it failed; `pushError` is the push's own failure. */
export class CommitPushError extends Error {
  constructor(readonly pushError: unknown) {
    super(errorText(pushError))
    this.name = 'CommitPushError'
  }
}

/** The commit and the push landed but the pull request step could not start; nothing was opened and nothing is half done. */
export class OpenPullRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenPullRequestError'
  }
}

/** Look up the pull request of the folder's current branch again, bypassing its max age. */
async function refreshBranchPullRequest(path: string, projectId: string | undefined): Promise<void> {
  const branch = useGitStatusStore.getState().entries[path]?.status?.branch
  if (branch) await refreshPullRequest(path, branch, { force: true, projectId })
}

/**
 * After a push: look the branch's pull request up past every cache, then show the Create PR form for it, or
 * report the pull request it already has. Opens nothing for a branch that is not pushed, is not the one the
 * flow started on, or cannot get a pull request, and says why.
 */
async function openPullRequestAfterPush(path: string, expectedBranch: string, projectId: string | undefined, scope: PullRequestScope): Promise<CommitPullRequestOutcome> {
  await refreshPullRequest(path, expectedBranch, { force: true, projectId, threadId: scope.threadId })
  const status = useGitStatusStore.getState().entries[path]?.status
  if (!status) throw new OpenPullRequestError('Could not read the state of the branch.')
  if (status.branch !== expectedBranch) throw new OpenPullRequestError(BRANCH_CHANGED_MESSAGE)
  // The same rule as the Create PR row: a pull request is only opened for a branch whose commits are all on its upstream.
  if (status.tracking !== 'tracked' || status.ahead > 0) throw new OpenPullRequestError('The branch is not on the remote yet. Push it, then use Create PR.')
  const lookup = useGitPullRequestStore.getState().entries[pullRequestKey(path, expectedBranch)]?.lookup
  if (lookup?.state === 'found') {
    const { number, state } = lookup.pullRequest
    return { kind: 'existing', number, state }
  }
  if (lookup?.state === 'unavailable') throw new OpenPullRequestError(lookup.message)
  if (lookup?.state !== 'none') throw new OpenPullRequestError('Could not look up pull requests for this branch.')
  if (lookup.isDefaultBranch !== false) throw new OpenPullRequestError(lookup.isDefaultBranch ? 'This is the default branch; a pull request needs another branch.' : 'Could not tell whether this is the default branch.')
  await createPullRequestForBranch(scope)
  return { kind: 'form' }
}

/**
 * Stage everything and commit (or amend), optionally push, optionally open the Create PR form, then refresh.
 * Each step runs only if the one before it succeeded. Rejects with Git's message when the commit fails (nothing
 * else ran), with a `CommitPushError` when only the push does (nothing is opened), and with an
 * `OpenPullRequestError` when both landed but the pull request step could not start. A branch that already has
 * a pull request resolves with it instead of a second form.
 */
export async function commitGitChanges(
  path: string,
  message: string,
  scope: GitScope,
  options: CommitGitOptions = {}
): Promise<CommitGitResult> {
  const git = window.mousse.git
  const projectId = refreshProjectId(scope)
  const pullRequestScope = options.openPullRequest
  const push = options.push === true || pullRequestScope !== undefined
  // The branch the user was looking at; the daemon refuses if HEAD is on another one by then.
  const expectedBranch = useGitStatusStore.getState().entries[path]?.status?.branch ?? undefined
  // The form is for the branch the button was pressed on; if the status has moved on, nothing has run yet, so stop here.
  if (pullRequestScope && pullRequestScope.branch !== expectedBranch) throw new Error(BRANCH_CHANGED_MESSAGE)
  options.onPhase?.('committing')
  await trackGitOperation(path, 'commit', (operationId) => git.commit(scope, message, { amend: options.amend === true, expectedBranch, operationId }))
  let pushError: CommitPushError | null = null
  if (push) {
    options.onPhase?.('pushing')
    try {
      await trackGitOperation(path, 'push', (operationId) => git.push(scope, { expectedBranch, operationId }))
    } catch (error) {
      pushError = new CommitPushError(error)
    }
  }
  await refreshGitStatus(path, { force: true, quiet: true, projectId })
  if (pushError) throw pushError
  if (!push) return { pullRequest: null }
  if (!pullRequestScope || !expectedBranch) {
    await refreshBranchPullRequest(path, projectId)
    return { pullRequest: null }
  }
  options.onPhase?.('opening-pr')
  return { pullRequest: await openPullRequestAfterPush(path, expectedBranch, projectId, pullRequestScope) }
}

/**
 * A proposed message for what the next commit takes. Nothing changes in the repository, so there is no
 * refresh. Rejects with the daemon's code, `git_suggest_no_model` among them.
 */
export async function suggestGitCommitMessage(path: string, scope: GitScope): Promise<GitCommitSuggestion> {
  const expectedBranch = useGitStatusStore.getState().entries[path]?.status?.branch ?? undefined
  const suggestion = await window.mousse.git.suggestCommitMessage(scope, { expectedBranch })
  return { message: suggestion.message, truncated: suggestion.truncated }
}

/** Push the current branch (publishing it when it has no upstream), then refresh. Rejects with Git's message. */
export async function pushGitBranch(path: string, scope: GitScope): Promise<void> {
  const expectedBranch = useGitStatusStore.getState().entries[path]?.status?.branch ?? undefined
  await trackGitOperation(path, 'push', (operationId) => window.mousse.git.push(scope, { expectedBranch, operationId }))
  await refreshAfterMutation(path, scope)
  await refreshBranchPullRequest(path, refreshProjectId(scope))
}

/**
 * Make the folder a Git repository, then refresh so the section switches to its normal view.
 * Rejects with Git's message. Only a project folder can be initialised, so the thread is left out.
 */
export async function initGitRepository(path: string, scope: GitScope): Promise<void> {
  const projectScope = { projectId: scope.projectId, workspaceThreadId: null }
  await window.mousse.git.init(projectScope)
  await refreshAfterMutation(path, projectScope)
}

const retained = new Map<string, { count: number; projectId?: string }>()
let detach: (() => void) | null = null

function refreshRetained(force: boolean) {
  for (const [path, { projectId }] of retained) {
    void refreshGitStatus(path, { force, quiet: true, projectId })
  }
}

// One window listener and one store subscription serve every reader, however many
// there are: the window regaining focus, and a run finishing (it has been editing files).
function attach() {
  if (typeof window === 'undefined' || detach) return
  const onFocus = () => refreshRetained(false)
  window.addEventListener('focus', onFocus)
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (anyTurnEnded(previous.turnStates, state.turnStates)) refreshRetained(true)
  })
  detach = () => {
    window.removeEventListener('focus', onFocus)
    unsubscribe()
  }
}

/** Keep a folder's state refreshing on focus and run completion until the returned release runs. */
export function retainGitPath(path: string, projectId?: string): () => void {
  const current = retained.get(path)
  retained.set(path, { count: (current?.count ?? 0) + 1, projectId: projectId ?? current?.projectId })
  attach()
  let released = false
  return () => {
    // A second call would take a count that belongs to another holder.
    if (released) return
    released = true
    const entry = retained.get(path)
    if (!entry) return
    if (entry.count > 1) retained.set(path, { ...entry, count: entry.count - 1 })
    else retained.delete(path)
    if (retained.size === 0 && detach) {
      detach()
      detach = null
    }
  }
}

export interface GitStatusView extends Omit<GitStatusEntry, 'fetchedAt'> {
  /** Force a fresh fetch and wait for it. */
  refresh: () => Promise<void>
}

/** Shared Git state for a folder; null path means there is nothing to read. */
export function useGitStatus(path: string | null, projectId?: string | null): GitStatusView {
  const entry = useGitStatusStore((state) => (path ? state.entries[path] : undefined)) ?? EMPTY_GIT_ENTRY
  const scopedProjectId = projectId ?? undefined

  useEffect(() => {
    if (!path) return
    const release = retainGitPath(path, scopedProjectId)
    void refreshGitStatus(path, { projectId: scopedProjectId })
    return release
  }, [path, scopedProjectId])

  const refresh = useCallback(
    () => (path ? refreshGitStatus(path, { force: true, projectId: scopedProjectId }) : Promise.resolve()),
    [path, scopedProjectId]
  )

  return {
    status: entry.status,
    commits: entry.commits,
    branches: entry.branches,
    diffStats: entry.diffStats,
    loading: path ? !entry.loaded || entry.loading : false,
    loaded: entry.loaded,
    error: entry.error,
    refresh
  }
}
