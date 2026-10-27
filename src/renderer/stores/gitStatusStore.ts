import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import type {
  GitBranchInfo,
  GitBranchOptions,
  GitCheckoutOptions,
  GitCheckoutResult,
  GitCommit,
  GitDeleteBranchOptions,
  GitDiffStats,
  GitFetchResult,
  GitPullOptions,
  GitPullResult,
  GitScope,
  GitStatusSnapshot
} from '../../shared/types'
import { errorText } from '../lib/errorText'
import { anyTurnEnded } from '../lib/turnEnded'
import { useAppStore } from './appStore'
import { refreshPullRequest } from './pullRequestStore'

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
  const result = await window.mousse.git.checkout(scope, branch, options)
  await refreshAfterMutation(path, scope)
  return { stashKept: result.stashKept }
}

/** Stage these paths, or everything. */
export async function stageGitPaths(path: string, paths: readonly string[] | 'all', scope: GitScope): Promise<void> {
  await window.mousse.git.stage(scope, paths === 'all' ? { all: true } : { paths: [...paths] })
  await refreshAfterMutation(path, scope)
}

/** Take these paths out of the index, or everything. */
export async function unstageGitPaths(path: string, paths: readonly string[] | 'all', scope: GitScope): Promise<void> {
  await window.mousse.git.unstage(scope, paths === 'all' ? { all: true } : { paths: [...paths] })
  await refreshAfterMutation(path, scope)
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
  const result = await window.mousse.git.fetch(scope)
  await refreshAfterMutation(path, scope)
  return { behindBefore: result.behindBefore, behindAfter: result.behindAfter }
}

/** Pull the upstream into the branch; `conflicted` leaves the merge or rebase for the user. */
export async function pullGit(path: string, scope: GitScope, options: GitPullOptions = {}): Promise<GitPullResult> {
  try {
    const result = await window.mousse.git.pull(scope, options)
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
  await window.mousse.git.createBranch(scope, name, options)
  await refreshAfterMutation(path, scope)
}

export async function renameGitBranch(path: string, name: string, newName: string, scope: GitScope): Promise<void> {
  await window.mousse.git.renameBranch(scope, name, newName)
  await refreshAfterMutation(path, scope)
}

export async function deleteGitBranch(path: string, name: string, scope: GitScope, options: GitDeleteBranchOptions = {}): Promise<void> {
  await window.mousse.git.deleteBranch(scope, name, options)
  await refreshAfterMutation(path, scope)
}

export interface CommitGitOptions {
  /** Rewrite the latest commit instead of adding one. */
  amend?: boolean
  /** Push the branch after the commit. */
  push?: boolean
  /** Reports each step, so a button can say what is running. */
  onPhase?: (phase: 'committing' | 'pushing') => void
}

/** The commit landed but the push after it failed; `pushError` is the push's own failure. */
export class CommitPushError extends Error {
  constructor(readonly pushError: unknown) {
    super(errorText(pushError))
    this.name = 'CommitPushError'
  }
}

/** Look up the pull request of the folder's current branch again, bypassing its max age. */
async function refreshBranchPullRequest(path: string, projectId: string | undefined): Promise<void> {
  const branch = useGitStatusStore.getState().entries[path]?.status?.branch
  if (branch) await refreshPullRequest(path, branch, { force: true, projectId })
}

/**
 * Stage everything and commit (or amend), optionally push, then refresh. Rejects with
 * Git's message when the commit fails, and with a `CommitPushError` when only the push does.
 */
export async function commitGitChanges(
  path: string,
  message: string,
  scope: GitScope,
  options: CommitGitOptions = {}
): Promise<void> {
  const git = window.mousse.git
  const projectId = refreshProjectId(scope)
  // The branch the user was looking at; the daemon refuses if HEAD is on another one by then.
  const expectedBranch = useGitStatusStore.getState().entries[path]?.status?.branch ?? undefined
  options.onPhase?.('committing')
  await git.commit(scope, message, { amend: options.amend === true, expectedBranch })
  let pushError: CommitPushError | null = null
  if (options.push) {
    options.onPhase?.('pushing')
    try {
      await git.push(scope, { expectedBranch })
    } catch (error) {
      pushError = new CommitPushError(error)
    }
  }
  await refreshGitStatus(path, { force: true, quiet: true, projectId })
  if (pushError) throw pushError
  if (options.push) await refreshBranchPullRequest(path, projectId)
}

/** Push the current branch (publishing it when it has no upstream), then refresh. Rejects with Git's message. */
export async function pushGitBranch(path: string, scope: GitScope): Promise<void> {
  const expectedBranch = useGitStatusStore.getState().entries[path]?.status?.branch ?? undefined
  await window.mousse.git.push(scope, { expectedBranch })
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
