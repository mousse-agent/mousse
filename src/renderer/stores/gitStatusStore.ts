import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import {
  isTurnActivePhase,
  type GitBranchInfo,
  type GitCommit,
  type GitDiffStats,
  type GitStatusSnapshot,
  type TurnStateSnapshot
} from '../../shared/types'
import { useAppStore } from './appStore'

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/** Switch branches, then refresh. Rejects with Git's message when the checkout fails. */
export async function checkoutGitBranch(path: string, branch: string, projectId?: string): Promise<void> {
  await window.mousse.git.checkout(branch, projectId, path)
  await refreshGitStatus(path, { force: true, quiet: true, projectId })
}

/** Stage everything and commit, then refresh. Rejects with Git's message when the commit fails. */
export async function commitGitChanges(path: string, message: string, projectId?: string): Promise<void> {
  await window.mousse.git.commit(message, projectId, path)
  await refreshGitStatus(path, { force: true, quiet: true, projectId })
}

/** Whether any turn went from running to finished between two snapshots. */
export function anyTurnEnded(previous: TurnStateSnapshot, next: TurnStateSnapshot): boolean {
  if (previous === next) return false
  return Object.values(previous).some((turn) => {
    const after = next[turn.threadId]
    return isTurnActivePhase(turn.phase) && after !== undefined && !isTurnActivePhase(after.phase)
  })
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
