import { useEffect } from 'react'
import { create } from 'zustand'
import type { GitPullRequestLookup } from '../../shared/types'
import { errorText } from '../lib/errorText'
import { anyTurnEnded } from '../lib/turnEnded'
import { useAppStore } from './appStore'

/**
 * One shared pull request lookup per folder and branch. Requests for the same entry
 * share a single in-flight fetch, and nothing polls: the lookup refreshes when a section
 * mounts, the window regains focus, a run ends, or the branch is pushed.
 */

/** A lookup younger than this satisfies an ordinary (not forced) request. */
export const PULL_REQUEST_MAX_AGE_MS = 30_000

export interface PullRequestEntry {
  lookup: GitPullRequestLookup | null
  fetchedAt: number
}

interface PullRequestState {
  entries: Record<string, PullRequestEntry>
}

export const useGitPullRequestStore = create<PullRequestState>(() => ({ entries: {} }))

export function pullRequestKey(path: string, branch: string): string {
  return `${path}\u0000${branch}`
}

export interface PullRequestRefreshOptions {
  /** Fetch again even if the lookup is fresh, and again after a fetch already in flight. */
  force?: boolean
  projectId?: string
}

interface Flight {
  promise: Promise<void>
  rerun: boolean
}

const flights = new Map<string, Flight>()

function setEntry(key: string, entry: PullRequestEntry) {
  useGitPullRequestStore.setState((state) => ({ entries: { ...state.entries, [key]: entry } }))
}

async function fetchInto(path: string, branch: string, projectId: string | undefined): Promise<void> {
  const key = pullRequestKey(path, branch)
  try {
    const lookup = await window.mousse.git.pullRequest(projectId, path, branch)
    setEntry(key, { lookup, fetchedAt: Date.now() })
  } catch (error) {
    // Keep what is on screen; the age still advances so a broken lookup is not retried at once.
    const previous = useGitPullRequestStore.getState().entries[key]?.lookup ?? null
    setEntry(key, {
      lookup: previous ?? { state: 'unavailable', reason: 'error', message: errorText(error) },
      fetchedAt: Date.now()
    })
  }
}

/** Look up the pull request for a branch. Never rejects. */
export function refreshPullRequest(path: string, branch: string, options: PullRequestRefreshOptions = {}): Promise<void> {
  const key = pullRequestKey(path, branch)
  const flight = flights.get(key)
  if (flight) {
    if (options.force) flight.rerun = true
    return flight.promise
  }

  const entry = useGitPullRequestStore.getState().entries[key]
  if (!options.force && entry && Date.now() - entry.fetchedAt < PULL_REQUEST_MAX_AGE_MS) {
    return Promise.resolve()
  }

  const next: Flight = { promise: Promise.resolve(), rerun: false }
  flights.set(key, next)
  next.promise = (async () => {
    try {
      do {
        next.rerun = false
        await fetchInto(path, branch, options.projectId)
      } while (next.rerun)
    } finally {
      flights.delete(key)
    }
  })()
  return next.promise
}

interface Retained {
  path: string
  branch: string
  projectId?: string
  count: number
}

const retained = new Map<string, Retained>()
/** Branches whose create page was opened in the browser; the next focus checks them again. */
const awaitingReturn = new Map<string, { path: string; branch: string; projectId?: string }>()
let detach: (() => void) | null = null

function refreshRetained() {
  for (const { path, branch, projectId } of retained.values()) {
    void refreshPullRequest(path, branch, { projectId })
  }
}

function refreshAwaiting() {
  const pending = [...awaitingReturn.values()]
  awaitingReturn.clear()
  // Nothing may be left holding the listeners once the last reader has gone.
  detachIfIdle()
  for (const { path, branch, projectId } of pending) {
    void refreshPullRequest(path, branch, { force: true, projectId })
  }
}

// One window listener and one store subscription serve every reader.
function attach() {
  if (typeof window === 'undefined' || detach) return
  const onFocus = () => {
    refreshAwaiting()
    refreshRetained()
  }
  window.addEventListener('focus', onFocus)
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (anyTurnEnded(previous.turnStates, state.turnStates)) refreshRetained()
  })
  detach = () => {
    window.removeEventListener('focus', onFocus)
    unsubscribe()
  }
}

function detachIfIdle() {
  if (retained.size === 0 && awaitingReturn.size === 0 && detach) {
    detach()
    detach = null
  }
}

/** Keep a branch's lookup refreshing on focus and run completion until the returned release runs. */
export function retainPullRequest(path: string, branch: string, projectId?: string): () => void {
  const key = pullRequestKey(path, branch)
  const current = retained.get(key)
  retained.set(key, { path, branch, projectId: projectId ?? current?.projectId, count: (current?.count ?? 0) + 1 })
  attach()
  let released = false
  return () => {
    if (released) return
    released = true
    const entry = retained.get(key)
    if (!entry) return
    if (entry.count > 1) retained.set(key, { ...entry, count: entry.count - 1 })
    else retained.delete(key)
    detachIfIdle()
  }
}

/** Open GitHub's create page, then look the branch up again when the window regains focus. */
export async function createPullRequestForBranch(path: string, branch: string, projectId?: string): Promise<void> {
  await window.mousse.git.createPullRequest(projectId, path)
  awaitingReturn.set(pullRequestKey(path, branch), { path, branch, projectId })
  attach()
}

/** The lookup for a branch; null when there is no branch to look up. */
export function usePullRequest(path: string | null, branch: string | null, projectId?: string | null): GitPullRequestLookup | null {
  const key = path && branch ? pullRequestKey(path, branch) : null
  const lookup = useGitPullRequestStore((state) => (key ? state.entries[key]?.lookup ?? null : null))
  const scopedProjectId = projectId ?? undefined

  useEffect(() => {
    if (!path || !branch) return
    const release = retainPullRequest(path, branch, scopedProjectId)
    void refreshPullRequest(path, branch, { projectId: scopedProjectId })
    return release
  }, [path, branch, scopedProjectId])

  return lookup
}
