import type { ScheduledJob } from '../../shared/types'

/**
 * The limits on jobs agents create are settings (`scheduled.agentJobMaxActive`, `agentJobMinIntervalMinutes` and
 * `agentJobLifetimeDays`, `MousseConfigStore.agentJobLimits`); `AGENT_JOB_LIMIT_DEFAULTS` holds their defaults. Read the
 * current ones at the moment of use, never keep them.
 */
export { AGENT_JOB_LIMIT_DEFAULTS, AGENT_JOB_LIMIT_RANGES, type AgentJobLimits } from '../../shared/agentJobLimits'

const DAY_MS = 24 * 60 * 60 * 1000

/** When a job an agent creates now ends: `lifetimeDays` from `from`. A job already made keeps the `expiresAt` it has. */
export function agentJobExpiry(lifetimeDays: number, from: Date = new Date()): string {
  return new Date(from.getTime() + lifetimeDays * DAY_MS).toISOString()
}

/** Whether the job is an agent's, still able to run: it counts against the limit on active jobs. */
export function isActiveAgentJob(job: Pick<ScheduledJob, 'createdBy' | 'enabled' | 'state'>): boolean {
  return Boolean(job.createdBy) && job.enabled && job.state !== 'paused' && job.state !== 'completed'
}

export function isExpired(job: Pick<ScheduledJob, 'expiresAt'>, now: Date = new Date()): boolean {
  if (!job.expiresAt) return false
  const at = Date.parse(job.expiresAt)
  return Number.isFinite(at) && at <= now.getTime()
}

export const AGENT_JOBS_OFF_REASON = 'Agents may create jobs is off, so jobs agents created do not run. Resume the job to run it again once it is on.'

export function agentJobExpiredReason(lifetimeDays: number): string {
  return `Ended: a job an agent creates ends after ${lifetimeDays} ${lifetimeDays === 1 ? 'day' : 'days'} unless a person extends it.`
}
