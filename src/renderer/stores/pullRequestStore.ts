import { useEffect } from 'react'
import { create } from 'zustand'
import type { PullRequestRef } from '../../shared/pullRequests'
import type { GitPullRequestLookup } from '../../shared/types'
import { errorText } from '../lib/errorText'
import { anyTurnEnded } from '../lib/turnEnded'
import { useAppStore } from './appStore'

/**
 * One shared pull request lookup per folder and branch, read through the daemon. Requests
 * for the same entry share a single in-flight fetch, and nothing polls: the lookup
 * refreshes when a section mounts, the window regains focus or a run ends (only for a
 * branch that has an upstream, since an unpushed branch has no pull request to find),
 * or the branch is pushed.
 */

/** A lookup younger than this satisfies an ordinary (not forced) request. */
export const PULL_REQUEST_MAX_AGE_MS = 60_000

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
  /** The thread whose folder the lookup runs in; wins over `projectId`, so a worktree thread asks about its own folder. */
  threadId?: string
}

interface Flight {
  promise: Promise<void>
  rerun: boolean
}

const flights = new Map<string, Flight>()

function setEntry(key: string, entry: PullRequestEntry) {
  useGitPullRequestStore.setState((state) => ({ entries: { ...state.entries, [key]: entry } }))
}

/** The daemon resolves the folder from a thread or a project; a reader that gave neither borrows its retained entry's. */
function refFor(key: string, projectId: string | undefined, threadId: string | undefined): PullRequestRef {
  const known = retained.get(key)
  const thread = threadId ?? known?.threadId
  if (thread) return { threadId: thread }
  const project = projectId ?? known?.projectId
  return project ? { projectId: project } : {}
}

async function fetchInto(
  path: string,
  branch: string,
  projectId: string | undefined,
  threadId: string | undefined,
  force: boolean
): Promise<void> {
  const key = pullRequestKey(path, branch)
  const ref = refFor(key, projectId, threadId)
  try {
    const lookup = await (force
      ? window.mousse.pullRequests.get(ref, branch, true)
      : window.mousse.pullRequests.get(ref, branch))
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
      let force = options.force === true
      do {
        next.rerun = false
        await fetchInto(path, branch, options.projectId, options.threadId, force)
        // A rerun exists because something changed meanwhile, so it must not be answered from the daemon's cache.
        force = true
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
  threadId?: string
  /** The branch has an upstream. Focus and run ends look up only tracked branches. */
  tracked: boolean
  count: number
}

const retained = new Map<string, Retained>()
/** Branches whose create page was opened in the browser; the next focus checks them again. */
const awaitingReturn = new Map<string, { path: string; branch: string; projectId?: string }>()
let detach: (() => void) | null = null

function refreshRetained() {
  for (const { path, branch, projectId, threadId, tracked } of retained.values()) {
    if (tracked) void refreshPullRequest(path, branch, { projectId, threadId })
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
export function retainPullRequest(path: string, branch: string, projectId?: string, threadId?: string): () => void {
  const key = pullRequestKey(path, branch)
  const current = retained.get(key)
  retained.set(key, {
    path,
    branch,
    projectId: projectId ?? current?.projectId,
    threadId: threadId ?? current?.threadId,
    tracked: current?.tracked ?? true,
    count: (current?.count ?? 0) + 1
  })
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

/** Tell the store whether a retained branch has an upstream; a branch without one is not looked up on focus or run end. */
export function setPullRequestTracked(path: string, branch: string, tracked: boolean): void {
  const entry = retained.get(pullRequestKey(path, branch))
  if (entry) entry.tracked = tracked
}

/** Open GitHub's create page, then look the branch up again when the window regains focus. */
export async function createPullRequestForBranch(path: string, branch: string, projectId?: string): Promise<void> {
  await window.mousse.git.createPullRequest(projectId, path)
  awaitingReturn.set(pullRequestKey(path, branch), { path, branch, projectId })
  attach()
}

/** The lookup for a branch; null when there is no branch to look up. */
export function usePullRequest(
  path: string | null,
  branch: string | null,
  projectId?: string | null,
  threadId?: string | null,
  /** The branch has an upstream; focus and run ends skip it otherwise. Mount always looks up once. */
  tracked = true
): GitPullRequestLookup | null {
  const key = path && branch ? pullRequestKey(path, branch) : null
  const lookup = useGitPullRequestStore((state) => (key ? state.entries[key]?.lookup ?? null : null))
  const scopedProjectId = projectId ?? undefined
  const scopedThreadId = threadId ?? undefined

  useEffect(() => {
    if (!path || !branch) return
    const release = retainPullRequest(path, branch, scopedProjectId, scopedThreadId)
    void refreshPullRequest(path, branch, { projectId: scopedProjectId, threadId: scopedThreadId })
    return release
  }, [path, branch, scopedProjectId, scopedThreadId])

  // After the retain above, which starts every entry tracked; runs again whenever that retain does.
  useEffect(() => {
    if (path && branch) setPullRequestTracked(path, branch, tracked)
  }, [path, branch, scopedProjectId, scopedThreadId, tracked])

  return lookup
}
