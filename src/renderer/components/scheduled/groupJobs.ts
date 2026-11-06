import type { ScheduledJob } from '../../../shared/types'
import { isToday, newestRecord } from './scheduledLabels'

export type TaskGroupKey = 'today' | 'upcoming' | 'onDemand' | 'paused' | 'done'

export interface TaskGroup {
  key: TaskGroupKey
  label: string
  jobs: ScheduledJob[]
}

const LABELS: Record<TaskGroupKey, string> = {
  today: 'Today',
  upcoming: 'Upcoming',
  onDemand: 'On demand',
  paused: 'Paused',
  done: 'Done'
}

const ORDER: TaskGroupKey[] = ['today', 'upcoming', 'onDemand', 'paused', 'done']

const isLive = (job: ScheduledJob) => Boolean(job.liveStatus || job.state === 'running' || job.pendingOccurrence)

/** The last run ended badly, or the scheduler could not run the task: a person should look. */
const failed = (job: ScheduledJob) => {
  const status = newestRecord(job)?.status ?? job.lastStatus
  return job.state === 'error' || status === 'error' || status === 'interrupted' || status === 'uncertain'
}

/** Which group a task belongs in. A task that is running or needs a person is always Today. */
export function groupOf(job: ScheduledJob, now: Date = new Date()): TaskGroupKey {
  if (isLive(job)) return 'today'
  if (job.state === 'paused') return 'paused'
  if (job.state === 'completed') return 'done'
  const lastRun = newestRecord(job)?.runAt ?? job.lastRunAt
  if (job.state === 'error' || isToday(lastRun, now) || isToday(job.nextRunAt, now)) return 'today'
  if (job.schedule.kind === 'manual') return 'onDemand'
  // A task with nothing ahead of it that is not done (a failed one-time task) waits on a person.
  if (!job.nextRunAt) return failed(job) ? 'today' : 'upcoming'
  return 'upcoming'
}

const time = (iso: string | null | undefined) => {
  const value = iso ? new Date(iso).getTime() : Number.NaN
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value
}

/** In Today, what needs a person comes first: an answer, then a failure, then what is running. */
const urgency = (job: ScheduledJob) => (job.liveStatus === 'needs_answer' ? 0 : failed(job) && !isLive(job) ? 1 : isLive(job) ? 2 : 3)

const byName = (a: ScheduledJob, b: ScheduledJob) => a.name.localeCompare(b.name)

const COMPARE: Record<TaskGroupKey, (a: ScheduledJob, b: ScheduledJob) => number> = {
  today: (a, b) => urgency(a) - urgency(b) || time(a.nextRunAt) - time(b.nextRunAt) || byName(a, b),
  upcoming: (a, b) => time(a.nextRunAt) - time(b.nextRunAt) || byName(a, b),
  onDemand: byName,
  paused: byName,
  // Most recently finished first.
  done: (a, b) => time(b.lastRunAt) - time(a.lastRunAt) || byName(a, b)
}

/**
 * The page's groups in order: Today, Upcoming, On demand, Paused, and Done only when asked for. Empty groups are left out.
 */
export function groupJobs(jobs: ScheduledJob[], options: { now?: Date; showDone?: boolean } = {}): TaskGroup[] {
  const now = options.now ?? new Date()
  const buckets = new Map<TaskGroupKey, ScheduledJob[]>()
  for (const job of jobs) {
    const key = groupOf(job, now)
    buckets.set(key, [...(buckets.get(key) ?? []), job])
  }
  return ORDER.filter((key) => (key !== 'done' || options.showDone) && buckets.has(key)).map((key) => ({
    key,
    label: LABELS[key],
    jobs: [...buckets.get(key)!].sort(COMPARE[key])
  }))
}

/** How many tasks are done (hidden until "Show done"). */
export const doneCount = (jobs: ScheduledJob[], now: Date = new Date()): number => jobs.filter((job) => groupOf(job, now) === 'done').length
