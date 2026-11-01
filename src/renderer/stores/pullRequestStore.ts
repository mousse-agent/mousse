import { useEffect } from 'react'
import { create } from 'zustand'
import type {
  CreatePullRequestResult,
  GitPullRequestInfo,
  PullRequestActionResult,
  PullRequestBaseBranches,
  PullRequestDetail,
  PullRequestDraft,
  PullRequestFormInput,
  PullRequestMergeMethod,
  PullRequestRef,
  PullRequestScope,
  ThreadPullRequestLink
} from '../../shared/pullRequests'
import type { GitPullRequestLookup } from '../../shared/types'
import { errorText, ipcErrorLine } from '../lib/errorText'
import { anyTurnEnded } from '../lib/turnEnded'
import { useAppStore } from './appStore'

/**
 * One shared pull request lookup per folder and branch, and one shared detail (review state, comments,
 * each check) per folder and pull request number, read through the daemon. Requests for the same entry
 * share a single in-flight fetch, and nothing polls: an entry refreshes when a section mounts, the window
 * regains focus or a run ends, or the branch is pushed. Focus and run ends look up a branch only when it
 * has an upstream, since an unpushed branch has no pull request to find; a pull request that was found
 * keeps refreshing either way (its checks and merged state change), until it is merged.
 */

/** A lookup or detail younger than this satisfies an ordinary (not forced) request. */
export const PULL_REQUEST_MAX_AGE_MS = 60_000

export interface PullRequestEntry {
  lookup: GitPullRequestLookup | null
  fetchedAt: number
}

/** What the host last said about one pull request; `error` is the host's message when the last read failed (the previous detail stays). */
export interface PullRequestDetailEntry {
  detail: PullRequestDetail | null
  error: string | null
  fetchedAt: number
}

interface PullRequestState {
  entries: Record<string, PullRequestEntry>
  /** Details by folder and pull request number. */
  details: Record<string, PullRequestDetailEntry>
  /** The scope the create form is open for; the form shows in the section of that folder and branch. */
  createForm: PullRequestScope | null
}

export const useGitPullRequestStore = create<PullRequestState>(() => ({ entries: {}, details: {}, createForm: null }))

/** Lookups kept in memory; the least recently fetched ones that no section shows go first. */
const MAX_PULL_REQUEST_ENTRIES = 200
const MAX_PULL_REQUEST_DETAILS = 100

/** `path` here and in the functions below is the folder's key (`folderKey`), never a path on disk. */
export function pullRequestKey(path: string, branch: string): string {
  return `${path}\u0000${branch}`
}

export function pullRequestDetailKey(path: string, number: number): string {
  return `${path}\u0000${number}`
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
  useGitPullRequestStore.setState((state) => {
    const entries = { ...state.entries, [key]: entry }
    const keys = Object.keys(entries)
    if (keys.length > MAX_PULL_REQUEST_ENTRIES) {
      const stale = keys
        .filter((other) => other !== key && !retained.has(other))
        .sort((a, b) => entries[a].fetchedAt - entries[b].fetchedAt)
      for (const other of stale.slice(0, keys.length - MAX_PULL_REQUEST_ENTRIES)) delete entries[other]
    }
    return { entries }
  })
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

const detailFlights = new Map<string, Flight>()

/** Same as a lookup's ref: a thread's folder wins over the project's; a reader that gave neither borrows its retained entry's. */
function detailRefFor(key: string, projectId: string | undefined, threadId: string | undefined): PullRequestRef {
  const known = retainedDetails.get(key)
  const thread = threadId ?? known?.threadId
  if (thread) return { threadId: thread }
  const project = projectId ?? known?.projectId
  return project ? { projectId: project } : {}
}

function setDetailEntry(key: string, next: PullRequestDetailEntry) {
  useGitPullRequestStore.setState((state) => {
    const previous = state.details[key]
    // Unchanged data keeps its reference, so what shows it does not render again and a panel keeps its place.
    const detail = previous?.detail && next.detail && JSON.stringify(previous.detail) === JSON.stringify(next.detail) ? previous.detail : next.detail
    const details = { ...state.details, [key]: { ...next, detail } }
    const keys = Object.keys(details)
    if (keys.length > MAX_PULL_REQUEST_DETAILS) {
      const stale = keys
        .filter((other) => other !== key && !retainedDetails.has(other))
        .sort((a, b) => details[a].fetchedAt - details[b].fetchedAt)
      for (const other of stale.slice(0, keys.length - MAX_PULL_REQUEST_DETAILS)) delete details[other]
    }
    return { details }
  })
}

async function fetchDetailInto(
  path: string,
  number: number,
  projectId: string | undefined,
  threadId: string | undefined,
  force: boolean
): Promise<void> {
  const key = pullRequestDetailKey(path, number)
  const ref = detailRefFor(key, projectId, threadId)
  try {
    const detail = await (force
      ? window.mousse.pullRequests.detail(ref, number, true)
      : window.mousse.pullRequests.detail(ref, number))
    setDetailEntry(key, { detail, error: null, fetchedAt: Date.now() })
  } catch (error) {
    // The host's own message is shown; what is on screen stays, and the age advances so a broken read is not retried at once.
    const previous = useGitPullRequestStore.getState().details[key]?.detail ?? null
    const message = ipcErrorLine(error).replace(/^[A-Za-z]*Error:\s*/, '')
    setDetailEntry(key, { detail: previous, error: message || 'Could not read the pull request.', fetchedAt: Date.now() })
  }
}

/** Read the detail of one pull request. Never rejects. Shares flights and the age rule with `refreshPullRequest`. */
export function refreshPullRequestDetail(path: string, number: number, options: PullRequestRefreshOptions = {}): Promise<void> {
  const key = pullRequestDetailKey(path, number)
  const flight = detailFlights.get(key)
  if (flight) {
    if (options.force) flight.rerun = true
    return flight.promise
  }

  const entry = useGitPullRequestStore.getState().details[key]
  if (!options.force && entry && Date.now() - entry.fetchedAt < PULL_REQUEST_MAX_AGE_MS) {
    return Promise.resolve()
  }

  const next: Flight = { promise: Promise.resolve(), rerun: false }
  detailFlights.set(key, next)
  next.promise = (async () => {
    try {
      let force = options.force === true
      do {
        next.rerun = false
        await fetchDetailInto(path, number, options.projectId, options.threadId, force)
        force = true
      } while (next.rerun)
    } finally {
      detailFlights.delete(key)
    }
  })()
  return next.promise
}

interface Retained {
  path: string
  branch: string
  projectId?: string
  threadId?: string
  /** The branch has an upstream. Focus and run ends look up a branch without one only when it already has a pull request. */
  tracked: boolean
  count: number
}

interface RetainedDetail {
  path: string
  number: number
  projectId?: string
  threadId?: string
  count: number
}

const retained = new Map<string, Retained>()
const retainedDetails = new Map<string, RetainedDetail>()
let detach: (() => void) | null = null

function refreshRetained() {
  const { entries, details } = useGitPullRequestStore.getState()
  for (const { path, branch, projectId, threadId, tracked } of retained.values()) {
    // A branch that already has a pull request keeps refreshing, pushed with `-u` or not: its checks and merged state change.
    const known = entries[pullRequestKey(path, branch)]?.lookup
    const following = known?.state === 'found' && known.pullRequest.state !== 'merged'
    if (tracked || following) void refreshPullRequest(path, branch, { projectId, threadId })
  }
  for (const { path, number, projectId, threadId } of retainedDetails.values()) {
    // Merged is final; anything else can still get a review or a check.
    if (details[pullRequestDetailKey(path, number)]?.detail?.state !== 'merged') void refreshPullRequestDetail(path, number, { projectId, threadId })
  }
}

// One window listener and one store subscription serve every reader.
function attach() {
  if (typeof window === 'undefined' || detach) return
  const onFocus = () => {
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
  if (retained.size === 0 && retainedDetails.size === 0 && detach) {
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

/** Keep a pull request's detail refreshing on focus and run completion until the returned release runs. */
export function retainPullRequestDetail(path: string, number: number, projectId?: string, threadId?: string): () => void {
  const key = pullRequestDetailKey(path, number)
  const current = retainedDetails.get(key)
  retainedDetails.set(key, {
    path,
    number,
    projectId: projectId ?? current?.projectId,
    threadId: threadId ?? current?.threadId,
    count: (current?.count ?? 0) + 1
  })
  attach()
  let released = false
  return () => {
    if (released) return
    released = true
    const entry = retainedDetails.get(key)
    if (!entry) return
    if (entry.count > 1) retainedDetails.set(key, { ...entry, count: entry.count - 1 })
    else retainedDetails.delete(key)
    detachIfIdle()
  }
}

/** Tell the store whether a retained branch has an upstream; a branch without one is looked up on focus or run end only once it has a pull request. */
export function setPullRequestTracked(path: string, branch: string, tracked: boolean): void {
  const entry = retained.get(pullRequestKey(path, branch))
  if (entry) entry.tracked = tracked
}

/**
 * Opens the create form for a scope. The scope is captured here and carried by the form, its draft and
 * its submit; nothing reads the active thread or the current checkout later.
 */
export function openCreatePullRequestForm(scope: PullRequestScope): void {
  useGitPullRequestStore.setState({ createForm: scope })
}

export function closeCreatePullRequestForm(): void {
  useGitPullRequestStore.setState({ createForm: null })
}

/** The entry point of every "create a pull request" action: opens the form for the scope and resolves once it is open. */
export async function createPullRequestForBranch(scope: PullRequestScope): Promise<void> {
  openCreatePullRequestForm(scope)
}

/** A title, description and base proposed for the scope's branch. */
export function draftPullRequestFor(scope: PullRequestScope, base?: string): Promise<PullRequestDraft> {
  return base ? window.mousse.pullRequests.draft(scope, base) : window.mousse.pullRequests.draft(scope)
}

/** The branches the scope's pull request can target. */
export function loadPullRequestBaseBranches(scope: PullRequestScope): Promise<PullRequestBaseBranches> {
  return window.mousse.pullRequests.baseBranches(scope.threadId ? { threadId: scope.threadId } : scope.projectId ? { projectId: scope.projectId } : {})
}

/**
 * Creates the pull request for the scope's branch, or returns the open one it already has. The daemon
 * has checked that the folder is still on `scope.branch`, so the result is stored under the scope's
 * own key. A failure stores nothing and leaves the form as it is.
 */
export async function submitCreatePullRequest(scope: PullRequestScope, input: PullRequestFormInput): Promise<CreatePullRequestResult> {
  const result = await window.mousse.pullRequests.create(scope, input)
  setEntry(pullRequestKey(scope.path, scope.branch), { lookup: { state: 'found', pullRequest: result.pullRequest }, fetchedAt: Date.now() })
  void refreshPullRequest(scope.path, scope.branch, { force: true, projectId: scope.projectId, threadId: scope.threadId })
  return result
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

/** The detail of one pull request of a folder; null while there is nothing to read. Reads once on mount, then refreshes with the lookup. */
export function usePullRequestDetail(
  path: string | null,
  number: number | null,
  projectId?: string | null,
  threadId?: string | null
): PullRequestDetailEntry | null {
  const key = path && number !== null ? pullRequestDetailKey(path, number) : null
  const entry = useGitPullRequestStore((state) => (key ? state.details[key] ?? null : null))
  const scopedProjectId = projectId ?? undefined
  const scopedThreadId = threadId ?? undefined

  useEffect(() => {
    if (!path || number === null) return
    const release = retainPullRequestDetail(path, number, scopedProjectId, scopedThreadId)
    void refreshPullRequestDetail(path, number, { projectId: scopedProjectId, threadId: scopedThreadId })
    return release
  }, [path, number, scopedProjectId, scopedThreadId])

  return entry
}

export interface ThreadPullRequestView {
  /** What the pull request row is built from: the linked pull request's detail, else the branch's lookup. Null until it has loaded. */
  lookup: GitPullRequestLookup | null
  /** Review state, comments and each check of the pull request the row shows; null when it is not open or not read yet. */
  detail: PullRequestDetail | null
  /** The host's message when the pull request could not be read. */
  detailError: string | null
  /** The row's pull request is the thread's own link, not found by the branch name. */
  linked: boolean
}

/**
 * The pull request of a thread's folder. A pull request the thread is linked to is read by its number;
 * a thread with no link (or whose link cannot be read) finds it by its branch, and an open one found
 * that way is read in full too. Everything shares the store's flights and its 60 s age.
 */
export function useThreadPullRequest(input: {
  path: string | null
  branch: string | null
  projectId?: string | null
  /** The thread whose own folder `path` is; null for a folder that is the project's. */
  threadId?: string | null
  /** The branch has an upstream; focus and run ends skip it unless it already has a pull request. */
  tracked?: boolean
  link?: ThreadPullRequestLink | null
}): ThreadPullRequestView {
  const { path, branch, projectId = null, threadId = null, tracked = true } = input
  const linkNumber = input.link?.number ?? null
  const linkedEntry = usePullRequestDetail(path, linkNumber, projectId, threadId)
  const byBranch = findsByBranch(linkNumber, linkedEntry)
  const lookup = usePullRequest(path, byBranch ? branch : null, projectId, threadId, tracked)
  const foundEntry = usePullRequestDetail(path, byBranch ? openFoundNumber(lookup) : null, projectId, threadId)
  return composeThreadPullRequest({ linkNumber, linkedEntry, lookup, foundEntry })
}

/** A thread with no link, or whose linked pull request could not be read, finds its pull request by the branch. */
export function findsByBranch(linkNumber: number | null, linkedEntry: PullRequestDetailEntry | null): boolean {
  return linkNumber === null || (linkedEntry !== null && linkedEntry.detail === null && linkedEntry.error !== null)
}

/** The number of the open pull request a lookup found; a merged or closed one is not read in full. */
export function openFoundNumber(lookup: GitPullRequestLookup | null): number | null {
  return lookup?.state === 'found' && lookup.pullRequest.state === 'open' ? lookup.pullRequest.number : null
}

/** What the side card shows, from the reads of the linked pull request, the branch lookup and the found pull request's detail. */
export function composeThreadPullRequest(input: {
  linkNumber: number | null
  linkedEntry: PullRequestDetailEntry | null
  lookup: GitPullRequestLookup | null
  foundEntry: PullRequestDetailEntry | null
}): ThreadPullRequestView {
  const { linkNumber, linkedEntry, lookup, foundEntry } = input
  if (!findsByBranch(linkNumber, linkedEntry)) {
    const detail = linkedEntry?.detail ?? null
    return {
      lookup: detail ? { state: 'found', pullRequest: detail } : null,
      detail,
      detailError: linkedEntry?.error ?? null,
      linked: true
    }
  }
  return {
    lookup,
    detail: foundEntry?.detail ?? null,
    // A link that could not be read says why, until the branch's own pull request has been read.
    detailError: foundEntry ? foundEntry.error : linkNumber !== null ? linkedEntry?.error ?? null : null,
    linked: false
  }
}

/** One pull request of a section: the folder and branch it was found for, and the thread or project it is read as. */
export interface PullRequestActionTarget {
  /** The folder's key (`folderKey`), not a path. */
  path: string
  branch: string | null
  number: number
  projectId?: string
  threadId?: string
}

/** A lookup with one of its pull requests replaced by what the host says now. */
function withPullRequest(lookup: GitPullRequestLookup | null, next: GitPullRequestInfo): GitPullRequestLookup | null {
  if (lookup?.state !== 'found') return lookup
  if (lookup.pullRequest.number === next.number) return { ...lookup, pullRequest: next }
  if (!lookup.others?.some((other) => other.number === next.number)) return lookup
  return { ...lookup, others: lookup.others.map((other) => (other.number === next.number ? next : other)) }
}

/** Shows the changed pull request at once, then reads the branch's lookup and the pull request's detail again. */
function afterChange(target: PullRequestActionTarget, result: PullRequestActionResult): void {
  const { path, branch, number, projectId, threadId } = target
  if (branch) {
    const key = pullRequestKey(path, branch)
    const entry = useGitPullRequestStore.getState().entries[key]
    if (entry) setEntry(key, { lookup: withPullRequest(entry.lookup, result.pullRequest), fetchedAt: entry.fetchedAt })
    void refreshPullRequest(path, branch, { force: true, projectId, threadId })
  }
  void refreshPullRequestDetail(path, number, { force: true, projectId, threadId })
}

function actionRef(target: PullRequestActionTarget): PullRequestRef {
  return target.threadId ? { threadId: target.threadId } : target.projectId ? { projectId: target.projectId } : {}
}

/**
 * Merges a pull request with `method`, the one its confirmation named, exactly; without one, the repository's usual
 * method, else squash. `headSha` is the head that was shown: the host refuses if more was pushed since. Rejects with
 * the host's reason; the section shows it.
 */
export async function mergePullRequest(target: PullRequestActionTarget, headSha?: string, method?: PullRequestMergeMethod): Promise<PullRequestActionResult> {
  const result = await window.mousse.pullRequests.merge(actionRef(target), target.number, headSha, method)
  afterChange(target, result)
  return result
}

/** The method the host's merge button offers for this target's repository, for the confirmation to name; null when it cannot be read. */
export function pullRequestMergeMethod(target: PullRequestActionTarget): Promise<PullRequestMergeMethod | null> {
  return window.mousse.pullRequests.mergeMethod(actionRef(target))
}

/** Closes a pull request without merging it; its branch stays. Rejects with the host's reason. */
export async function closePullRequest(target: PullRequestActionTarget): Promise<PullRequestActionResult> {
  const result = await window.mousse.pullRequests.close(actionRef(target), target.number)
  afterChange(target, result)
  return result
}
