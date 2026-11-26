import type { PullRequestCheck, PullRequestReview } from '../../shared/pullRequests'
import { wakeCheckNames, type BotWakeEvent, type BotWakeFired } from '../../shared/bots/personal/wakes'

/**
 * What a bot's wakes wait on, read from the rest of Mousse (`BotEngineHost.wakeThread`, `pullRequestState`): a thread of
 * the owner's as it stands now, and a pull request of a repository the owner has as a project. `MmsProfileServices`
 * wires the reads; these only decide.
 */

/** `runId`: the run it works on now, when running; a wake set then waits for that run's end. */
export type WakeThreadState = { state: 'running' | 'idle' | 'archived' | 'deleted' | 'unreachable'; title?: string; runId?: string; lastRun?: { status: string; endedAt?: string } }

export interface WakeThreadDeps {
  /** The thread's record; undefined when it is gone. */
  thread(threadId: string): { name?: string; archivedAt?: string } | undefined
  /** Whether the thread is in the trash or being deleted. */
  trashed(threadId: string): boolean
  /** Whether a bot whose home thread is `from` may see the thread (`botThreadReach`). */
  reachable(from: string, threadId: string): boolean
  /** Whether a run of the thread works, waits its turn, or is paused by a usage limit (it goes on by itself). */
  working(threadId: string): boolean
  /** The thread's newest run. */
  lastRun(threadId: string): { status: string; endedAt?: string | null } | undefined
  /** The run the thread works on now (live, paused, or the first waiting its turn); undefined when none. */
  currentRun?(threadId: string): string | undefined
  /** One run of the thread, and whether it has ended; undefined when it is unknown. */
  run?(threadId: string, runId: string): { status: string; endedAt?: string | null; ended: boolean } | undefined
}

/**
 * A thread as a wake sees it. Deleted (or trashed) and archived come before reach: a gone thread is gone for anyone.
 * `runId`: the run a wake waits for. Once it has ended the thread is done for that wake, with that run's outcome, though
 * a later run works now; while it works the thread is running, though another run of it just ended.
 */
export function wakeThreadState(deps: WakeThreadDeps, from: string, threadId: string, runId?: string): WakeThreadState {
  const thread = deps.thread(threadId)
  if (!thread || deps.trashed(threadId)) return { state: 'deleted' }
  if (!deps.reachable(from, threadId)) return { state: 'unreachable' }
  const title = thread.name?.trim() || undefined
  if (thread.archivedAt) return { state: 'archived', ...(title ? { title } : {}) }
  const awaited = runId ? deps.run?.(threadId, runId) : undefined
  if (awaited?.ended) return { state: 'idle', ...(title ? { title } : {}), lastRun: { status: awaited.status, ...(awaited.endedAt ? { endedAt: awaited.endedAt } : {}) } }
  if (awaited) return { state: 'running', ...(title ? { title } : {}), runId: runId! }
  if (deps.working(threadId)) {
    const current = deps.currentRun?.(threadId)
    return { state: 'running', ...(title ? { title } : {}), ...(current ? { runId: current } : {}) }
  }
  const last = deps.lastRun(threadId)
  return { state: 'idle', ...(title ? { title } : {}), ...(last ? { lastRun: { status: last.status, ...(last.endedAt ? { endedAt: last.endedAt } : {}) } } : {}) }
}

/** Checks belong to headSha in the same host read; never reuse checks from an earlier head. */
export interface WakePullRequestState {
  state: 'open' | 'closed' | 'merged'
  title?: string
  headSha?: string
  checkRuns?: Array<Pick<PullRequestCheck, 'name' | 'state' | 'completedAt'>>
  reviews?: Array<Pick<PullRequestReview, 'id' | 'state' | 'author' | 'submittedAt'>>
  /** When it merged or closed, by the host's clock. */
  mergedAt?: string | null
  closedAt?: string | null
}

export interface PullRequestStateDeps {
  /** The folders of the owner's projects. */
  folders(): string[]
  /** "owner/name" of a folder's repository (its code host's identity); throws when it has none. */
  repository(folder: string): Promise<string>
  /** A pull request of the folder's repository: its state and title. */
  pullRequest(folder: string, number: number): Promise<WakePullRequestState>
}

/**
 * A pull request's state, read through the first of the owner's projects whose repository is `repo` (compared without
 * case, as GitHub names them). `none` when no project is that repository; `problem` when the read failed.
 */
export async function pullRequestStateOf(deps: PullRequestStateDeps, repo: string, number: number): Promise<WakePullRequestState | { none: true } | { problem: string }> {
  const wanted = repo.trim().toLowerCase()
  for (const folder of deps.folders()) {
    let name: string
    try {
      name = await deps.repository(folder)
    } catch {
      continue
    }
    if (name.toLowerCase() !== wanted) continue
    try {
      const read = await deps.pullRequest(folder, number)
      return { state: read.state, ...(read.title ? { title: read.title } : {}), ...(read.headSha ? { headSha: read.headSha } : {}), ...(read.checkRuns ? { checkRuns: read.checkRuns } : {}), ...(read.reviews ? { reviews: read.reviews } : {}), ...(read.mergedAt ? { mergedAt: read.mergedAt } : {}), ...(read.closedAt ? { closedAt: read.closedAt } : {}) }
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error) }
    }
  }
  return { none: true }
}

// -- What a wake decides from those reads ------------------------------------------------------------------------------
//
// One decider for every wake that waits on a thread or a pull request: a personal bot's (`BotEngine`) and a thread
// agent's (`ThreadWakes`). Each reads the thread or the pull request its own way, then asks these.

type ThreadWakeEvent = Extract<BotWakeEvent, { kind: 'thread' }>
/** How often one wake, a bot's or a thread's, reads its pull request. */
export const PR_WAKE_READ_MS = 2 * 60_000

type PullRequestWakeEvent = Extract<BotWakeEvent, { kind: 'pr' }>

/**
 * A wake on a thread as it is kept, once the thread is one it may wait on and is working now (with its title); or why
 * not, in words for the agent. `clock` says a time as the agent reads it.
 */
export function threadWakeEvent(event: Pick<ThreadWakeEvent, 'threadId'>, seen: WakeThreadState | undefined, clock: (iso: string) => string): ThreadWakeEvent | { problem: string } {
  if (!seen) return { problem: 'Wake-ups on threads can\'t be set here.' }
  if (seen.state === 'unreachable') return { problem: `Thread ${event.threadId} is not available to you.` }
  if (seen.state === 'archived' || seen.state === 'deleted') return { problem: `Thread ${event.threadId} is ${seen.state}.` }
  if (seen.state === 'idle') return { problem: `Thread ${event.threadId} isn't working now${seen.lastRun ? `: its last turn ended ${seen.lastRun.status}${seen.lastRun.endedAt ? ` at ${clock(seen.lastRun.endedAt)}` : ''}` : ''}. Read it instead of waiting for it.` }
  return { kind: 'thread', threadId: event.threadId, ...(seen.title ? { title: seen.title.slice(0, 120) } : {}), ...(seen.runId ? { runId: seen.runId } : {}) }
}

/**
 * A wake on a pull request as it is kept, once it is an open pull request of one of the person's projects; or why not.
 * `whose` names the person in the refusal ("your owner's", "the person's"). A review wake keeps a cursor from GitHub's
 * own read, so only a review submitted after it wakes, whatever this computer's clock says.
 */
export function pullRequestWakeEvent(event: Pick<PullRequestWakeEvent, 'repo' | 'number' | 'on'>, read: WakePullRequestState | { none: true } | { problem: string }, whose: string): PullRequestWakeEvent | { problem: string } {
  if (event.on !== undefined && !['merged', 'checks', 'review'].includes(event.on)) return { problem: 'on is merged, checks or review.' }
  if ('none' in read) return { problem: `${event.repo} is not one of ${whose} projects in Mousse, so its pull requests can't be watched.` }
  if ('problem' in read) return { problem: `${event.repo}#${event.number} couldn't be read: ${read.problem}` }
  if (read.state === 'merged') return { problem: `${event.repo}#${event.number} is merged already.` }
  if (read.state === 'closed') return { problem: `${event.repo}#${event.number} is closed without merging.` }
  const submitted = (read.reviews ?? []).filter((review) => review.submittedAt && Number.isFinite(Date.parse(review.submittedAt)))
  const newest = submitted.reduce<string | null>((at, review) => !at || Date.parse(review.submittedAt!) > Date.parse(at) ? review.submittedAt! : at, null)
  const reviewAfter = { at: newest, ids: submitted.filter((review) => newest && Date.parse(review.submittedAt!) === Date.parse(newest)).map((review) => review.id) }
  return { kind: 'pr', repo: event.repo, number: event.number, ...(event.on ? { on: event.on } : {}), ...(event.on === 'review' ? { reviewAfter } : {}) }
}

/** What happened to a wake's thread by now, or undefined while it still works (or can't be read now). */
export function threadWakeOutcome(event: ThreadWakeEvent, seen: WakeThreadState | undefined): BotWakeFired | undefined {
  if (!seen || seen.state === 'running') return undefined
  if (seen.state === 'unreachable') return { kind: 'ended', reason: 'unreachable' }
  if (seen.state === 'archived') return { kind: 'ended', reason: 'thread_archived' }
  if (seen.state === 'deleted') return { kind: 'ended', reason: 'thread_deleted' }
  const title = seen.title ?? event.title
  return { kind: 'thread', threadId: event.threadId, status: seen.lastRun?.status ?? 'completed', ...(title ? { title: title.slice(0, 120) } : {}) }
}

/**
 * What happened to a wake's pull request by now, from one read, or undefined while it is still to come or the read
 * failed (tried again later, until the wake gives up). `setAt`: when the wake was set, the cutoff of an older review
 * wake that has no GitHub cursor.
 */
export function pullRequestWakeOutcome(event: PullRequestWakeEvent, read: WakePullRequestState | { none: true } | { problem: string } | undefined, setAt: string): BotWakeFired | undefined {
  return pullRequestWakeHappened(event, read, setAt)?.fired
}

/**
 * As `pullRequestWakeOutcome`, with when it happened by the host's own clock (`at`, ms): the merge, the close, the last
 * check to finish, the review. No `at` when the read gives no time for it (a status check, an older code host).
 */
export function pullRequestWakeHappened(event: PullRequestWakeEvent, read: WakePullRequestState | { none: true } | { problem: string } | undefined, setAt: string): { fired: BotWakeFired; at?: number } | undefined {
  if (!read || 'none' in read || 'problem' in read) return undefined
  const timed = (fired: BotWakeFired, iso: string | null | undefined) => {
    const at = iso ? Date.parse(iso) : Number.NaN
    return Number.isFinite(at) ? { fired, at } : { fired }
  }
  const pr = { kind: 'pr' as const, repo: event.repo, number: event.number, ...(read.title ? { title: read.title.slice(0, 120) } : {}) }
  const ending = read.state === 'merged'
    ? timed(event.on && event.on !== 'merged' ? { kind: 'ended', reason: 'pr_merged' } : { ...pr, state: 'merged' }, read.mergedAt)
    : read.state === 'closed' ? timed({ kind: 'ended', reason: 'pr_closed' }, read.closedAt) : undefined
  if (!event.on || event.on === 'merged') return ending
  const awaited = awaitedPullRequestEvent(event, read, setAt, pr, timed)
  // The checks or the review, and the merge or the close: the one that happened first by the host's own times wins, so a
  // review submitted before a merge both seen in one read still counts. One with no time comes after one with a time.
  if (!ending || !awaited) return ending ?? awaited
  return (awaited.at ?? Number.POSITIVE_INFINITY) < (ending.at ?? Number.POSITIVE_INFINITY) ? awaited : ending
}

/** The finished checks of a checks wake, or the first review after its cutoff of a review wake, whatever the state. */
function awaitedPullRequestEvent(
  event: PullRequestWakeEvent,
  read: WakePullRequestState,
  setAt: string,
  pr: { kind: 'pr'; repo: string; number: number; title?: string },
  timed: (fired: BotWakeFired, iso: string | null | undefined) => { fired: BotWakeFired; at?: number }
): { fired: BotWakeFired; at?: number } | undefined {
  if (event.on === 'checks') {
    const checks = read.checkRuns
    // Missing/unknown checks cannot prove completion; skipped checks are complete but neither passed nor failed.
    if (!read.headSha || !checks?.length || checks.some((check) => !['passing', 'failing', 'skipped', 'waiting'].includes(check.state))) return undefined
    const failedNames = checks.filter((check) => check.state === 'failing').map((check) => check.name)
    const waitingNames = checks.filter((check) => check.state === 'waiting').map((check) => check.name)
    // They finished when the last of them did; one with no time leaves it unknown.
    const ends = checks.map((check) => check.completedAt ? Date.parse(check.completedAt) : Number.NaN)
    const last = ends.every(Number.isFinite) ? new Date(Math.max(...ends)).toISOString() : undefined
    return timed({ ...pr, state: 'checks', headSha: read.headSha.slice(0, 7), waiting: waitingNames.length, waitingNames: wakeCheckNames(waitingNames), passed: checks.filter((check) => check.state === 'passing').length, failed: failedNames.length, failedNames: wakeCheckNames(failedNames) }, last)
  }
  if (event.on === 'review') {
    const review = read.reviews?.filter((review) => {
      if (!review.submittedAt || !Number.isFinite(Date.parse(review.submittedAt))) return false
      // Older stored wakes have no GitHub cursor; retain their original cutoff until they end.
      if (!event.reviewAfter) return Date.parse(review.submittedAt) > Date.parse(setAt)
      if (!event.reviewAfter.at) return true
      const time = Date.parse(review.submittedAt), cutoff = Date.parse(event.reviewAfter.at)
      return time > cutoff || (time === cutoff && !event.reviewAfter.ids.includes(review.id))
    })
      .sort((a, b) => Date.parse(a.submittedAt!) - Date.parse(b.submittedAt!))
      .find((review) => ['approved', 'changes_requested', 'commented'].includes(review.state))
    if (review && (review.state === 'approved' || review.state === 'changes_requested' || review.state === 'commented'))
      return timed({ ...pr, state: 'review', reviewState: review.state, reviewer: review.author }, review.submittedAt)
  }
  return undefined
}
