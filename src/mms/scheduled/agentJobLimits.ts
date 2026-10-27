import type { ScheduledJob } from '../../shared/types'

/** Active jobs agents may have in a profile at once, counted from the saved jobs (so a restart does not reset it). */
export const AGENT_JOB_MAX_ACTIVE = 10
/** A job an agent creates or changes never runs more often than this. */
export const AGENT_JOB_MIN_INTERVAL_MINUTES = 15
/** A job an agent creates ends after this many days unless a person extends it. */
export const AGENT_JOB_LIFETIME_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

export function agentJobExpiry(from: Date = new Date()): string {
  return new Date(from.getTime() + AGENT_JOB_LIFETIME_DAYS * DAY_MS).toISOString()
}

/** Whether the job is an agent's, still able to run: it counts against `AGENT_JOB_MAX_ACTIVE`. */
export function isActiveAgentJob(job: Pick<ScheduledJob, 'createdBy' | 'enabled' | 'state'>): boolean {
  return Boolean(job.createdBy) && job.enabled && job.state !== 'paused' && job.state !== 'completed'
}

export function isExpired(job: Pick<ScheduledJob, 'expiresAt'>, now: Date = new Date()): boolean {
  if (!job.expiresAt) return false
  const at = Date.parse(job.expiresAt)
  return Number.isFinite(at) && at <= now.getTime()
}

export const AGENT_JOBS_OFF_REASON = 'Agents may create jobs is off, so jobs agents created do not run. Resume the job to run it again once it is on.'
export const AGENT_JOB_EXPIRED_REASON = `Ended: a job an agent creates ends after ${AGENT_JOB_LIFETIME_DAYS} days unless a person extends it.`
