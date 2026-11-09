import { THREAD_EVENT_KINDS, isThreadEventKind, type ScheduledJob, type ThreadEventKind } from '../../shared/types'
import type { PullRequestWatchRead, PullRequestWatchUpdate, WatchRemark } from '../git/PullRequestWatchService'

/**
 * Thread-event automations wake on their pull request's activity, read by the thread's watch
 * (`PullRequestWatchService`). This maps the watch's changes onto each automation's events and leaves out what the
 * automation's own run caused, so it cannot wake itself in a loop:
 *
 * - a review or comment is its own when the signed-in account (the one its run acts as) wrote it during the run, or
 *   in the few minutes after it, before the watch read again;
 * - checks are its own when they are for a head the watch first saw during the run or those minutes after (its push).
 *
 * The rate limit (one run per 10 minutes) is the store's (`ScheduledJobStore.queueThreadEvent`).
 */

/** After a run ends, what the watch sees for this long is still taken as the run's: the watch reads every 1 to 10 minutes. */
export const OWN_RUN_GRACE_MS = 15 * 60_000

/** The heads a thread's watch has seen, with when it first saw each; a thread keeps its newest few. */
const HEADS_KEPT = 20

/** The events a watch change stands for; `ended:<reason>` and anything else stand for none. */
export function eventKindsOf(changes: readonly string[]): ThreadEventKind[] {
  return THREAD_EVENT_KINDS.filter((kind) => changes.includes(kind))
}

/** When the job's runs went, as [start, end] times: its recorded runs, and the one under way (to now). */
export function ownRunWindows(job: Pick<ScheduledJob, 'runHistory' | 'runClaim' | 'pendingOccurrence'>, now: number): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = []
  for (const record of job.runHistory ?? []) {
    const start = Date.parse(record.startedAt ?? record.runAt)
    // A run still waiting or queued has not ended; a record without an end ended when it was written.
    const open = record.status === 'queued' || (record.status === 'waiting' && !record.usageLimitUntil)
    const end = open ? now : Date.parse(record.endedAt ?? record.runAt)
    if (Number.isFinite(start) && Number.isFinite(end)) windows.push({ start, end })
  }
  const claimed = Date.parse(job.runClaim?.claimedAt ?? '')
  if (Number.isFinite(claimed)) windows.push({ start: claimed, end: now })
  return windows
}

function within(at: number, windows: ReadonlyArray<{ start: number; end: number }>, graceMs: number): boolean {
  return Number.isFinite(at) && windows.some((window) => at >= window.start && at <= window.end + graceMs)
}

/**
 * Splits an update's events into those the automation should wake on and those its own run caused (with why). A review
 * or comment kind is its own only when every remark of that kind is; checks are its own when their head was its push.
 */
export function splitOwnEvents(input: {
  kinds: readonly ThreadEventKind[]
  remarks: readonly WatchRemark[]
  viewer: string | null | undefined
  /** When the watch first saw the head these checks are for; undefined when it does not know. */
  headFirstSeenAt: number | undefined
  windows: ReadonlyArray<{ start: number; end: number }>
  graceMs?: number
}): { wake: ThreadEventKind[]; own: Array<{ kind: ThreadEventKind; reason: string }> } {
  const grace = input.graceMs ?? OWN_RUN_GRACE_MS
  const viewer = input.viewer?.toLowerCase() ?? null
  const wake: ThreadEventKind[] = []
  const own: Array<{ kind: ThreadEventKind; reason: string }> = []
  for (const kind of input.kinds) {
    if (kind === 'review' || kind === 'comment') {
      const remarks = input.remarks.filter((remark) => remark.kind === kind)
      const mine = remarks.length > 0 && viewer !== null && remarks.every((remark) => remark.author.toLowerCase() === viewer && within(remark.at, input.windows, grace))
      if (mine) own.push({ kind, reason: kind === 'review' ? 'its own review' : 'its own comment' })
      else wake.push(kind)
      continue
    }
    if (input.headFirstSeenAt !== undefined && within(input.headFirstSeenAt, input.windows, grace)) own.push({ kind, reason: 'its own push' })
    else wake.push(kind)
  }
  return { wake, own }
}

export interface ThreadEventTriggerDeps {
  jobs(): ScheduledJob[]
  /** Hands events to the store (`ScheduledJobService.queueThreadEvent`); `own` logs ones its own run caused. */
  queue(jobId: string, kinds: ThreadEventKind[], options?: { own?: string }): void
  now?(): number
  graceMs?: number
}

/** Listens to the watch and wakes the thread-event automations of the thread whose pull request changed. */
export class ThreadEventTriggers {
  /** Per thread, the heads its watch has seen and when it first saw each. */
  private readonly heads = new Map<string, Map<string, number>>()

  constructor(private readonly deps: ThreadEventTriggerDeps) {}

  /** A watch read: a head it had not seen is remembered with the time, so checks for it can be traced to a push. */
  onRead(event: PullRequestWatchRead): void {
    // Only a head that moved since the read before has a known first sighting (now); one that was already there does not.
    if (!event.headSha || !event.previousHead || event.previousHead === event.headSha) return
    const seen = this.heads.get(event.threadId) ?? new Map<string, number>()
    this.heads.set(event.threadId, seen)
    if (seen.has(event.headSha)) return
    seen.set(event.headSha, event.at)
    if (seen.size > HEADS_KEPT) seen.delete(seen.keys().next().value!)
  }

  /** What changed on a watched pull request: each automation on that thread whose events match wakes, unless it caused them. */
  onUpdated(event: PullRequestWatchUpdate): void {
    const kinds = eventKindsOf(event.changes)
    if (!kinds.length) return
    const now = this.deps.now?.() ?? Date.now()
    let jobs: ScheduledJob[]
    try {
      jobs = this.deps.jobs()
    } catch {
      return
    }
    for (const job of jobs) {
      const trigger = job.trigger?.threadEvent
      if (!trigger || trigger.threadId !== event.threadId) continue
      const wanted = kinds.filter((kind) => trigger.events.some((entry) => isThreadEventKind(entry) && entry === kind))
      if (!wanted.length) continue
      const split = splitOwnEvents({
        kinds: wanted,
        remarks: event.remarks ?? [],
        viewer: event.viewer,
        headFirstSeenAt: event.headSha ? this.heads.get(event.threadId)?.get(event.headSha) : undefined,
        windows: ownRunWindows(job, now),
        ...(this.deps.graceMs !== undefined ? { graceMs: this.deps.graceMs } : {})
      })
      try {
        if (split.own.length) this.deps.queue(job.id, split.own.map((entry) => entry.kind), { own: [...new Set(split.own.map((entry) => entry.reason))].join(', ') })
        if (split.wake.length) this.deps.queue(job.id, split.wake)
      } catch (error) {
        console.warn('a pull request event did not reach its automation', { jobId: job.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}
