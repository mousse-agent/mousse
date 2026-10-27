import type { ScheduledJob } from '../../shared/types'

/**
 * Why Run now cannot start the job at this moment, or undefined when it can. A job with a run in flight or
 * waiting in a queue has one occurrence outstanding; starting another would stack a second behind it. The
 * protocol's `scheduled.run` and the agents' `schedule_run` refuse by the same rule.
 */
export function runNowRefusal(job: Pick<ScheduledJob, 'name' | 'state' | 'runClaim' | 'pendingOccurrence'>): string | undefined {
  if (job.state === 'running' || job.runClaim) return `Job is already running: ${job.name}`
  if (job.pendingOccurrence) {
    return `Job already has a run ${job.pendingOccurrence.state === 'queued' ? 'waiting in the queue' : 'in progress'}: ${job.name}. It can run again when that run ends.`
  }
  return undefined
}
