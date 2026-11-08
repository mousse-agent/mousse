import { ipcErrorMessage } from '../../utils/voiceErrors'
import { clockText, parseSimpleCron, WEEKDAY_NAMES } from '../../../shared/scheduleLabel'
import type { JobSchedule, ScheduledWebhookDelivery, ScheduledWebhookDeliveryOutcome } from '../../../shared/types'

export type SchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'custom'

// Moved to `src/shared/scheduleLabel.ts` so bots word schedules the same way; re-exported here.
export { clockText, describeSchedule, describeScheduleLong, humanCron, parseSimpleCron, relativeWhen, type SimpleCron } from '../../../shared/scheduleLabel'

export const WEEKDAY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [1, 2, 3, 4, 5, 6, 0].map((day) => ({ value: String(day), label: WEEKDAY_NAMES[day] }))

/**
 * The common schedules, each kept in a representation the scheduler already has: an hourly interval, and cron
 * expressions the scheduler reads on this computer's clock (`computeNextRun` uses local time).
 */
export const SCHEDULE_PRESETS: ReadonlyArray<{
  value: Exclude<SchedulePreset, 'custom'>
  label: string
  summary: string
  schedule: { kind: 'interval'; minutes: number } | { kind: 'cron'; expr: string }
}> = [
  { value: 'hourly', label: 'Hourly', summary: 'Every hour', schedule: { kind: 'interval', minutes: 60 } },
  { value: 'daily', label: `Daily ${clockText(9, 0)}`, summary: `Every day at ${clockText(9, 0)}`, schedule: { kind: 'cron', expr: '0 9 * * *' } },
  { value: 'weekdays', label: `Weekdays ${clockText(9, 0)}`, summary: `Monday to Friday at ${clockText(9, 0)}`, schedule: { kind: 'cron', expr: '0 9 * * 1-5' } }
]

/** The schedule as saved, for the details and tooltips: the cron expression or the interval. */
export function scheduleCode(schedule: JobSchedule): string | null {
  if (schedule.kind === 'cron') return schedule.expr?.trim() ?? null
  if (schedule.kind === 'interval') return `${schedule.minutes} min`
  return null
}

/**
 * When a new automation would first run, for the create row's Next line only. Intervals count from now; the simple cron forms
 * are read on this computer's clock as the scheduler reads them. Anything else is null (the row shows the stored next run once saved).
 */
export function firstRunOf(schedule: JobSchedule, now: Date = new Date()): Date | null {
  if (schedule.kind === 'interval') return schedule.minutes ? new Date(now.getTime() + schedule.minutes * 60_000) : null
  if (schedule.kind === 'once') return schedule.runAt ? new Date(schedule.runAt) : null
  if (schedule.kind !== 'cron') return null
  const cron = parseSimpleCron(schedule.expr)
  if (!cron) return null
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1)
  for (let step = 0; step < 8 * 24 * 60; step += 1) {
    const at = new Date(candidate.getTime() + step * 60_000)
    const minuteOk = cron.kind === 'minutes' ? at.getMinutes() % cron.every === 0 : at.getMinutes() === cron.minute
    const hourOk = cron.kind === 'days' ? at.getHours() === cron.hour : cron.kind === 'hours' ? at.getHours() % cron.every === 0 : true
    const dayOk = cron.kind !== 'days' || cron.days === 'all' || cron.days.includes(at.getDay())
    if (minuteOk && hourOk && dayOk) return at
  }
  return null
}

/** An automation's name from what the person typed: its first sentence, cut to about 70 characters. */
export function nameFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/)[0]?.trim() ?? ''
  const sentence = /^(.+?[.!?])(\s|$)/.exec(firstLine)?.[1] ?? firstLine
  const name = sentence.replace(/[.!]$/, '')
  return name.length > 70 ? `${name.slice(0, 69).trimEnd()}…` : name
}

/** An error from the main process without the prefix Electron adds. */
export function errorText(error: unknown): string {
  return ipcErrorMessage(error) || String(error)
}

interface OutcomeText {
  label: string
  /** Shown when the log has no reason of its own for the row. */
  reason: string
  refused: boolean
}

/** How each request ended, in words. A refused request started nothing. */
export const DELIVERY_OUTCOME: Record<ScheduledWebhookDeliveryOutcome, OutcomeText> = {
  accepted: { label: 'Accepted', reason: 'Waiting for the scheduler to start it.', refused: false },
  queued: { label: 'Accepted', reason: 'Waiting in the queue behind another run.', refused: false },
  completed: { label: 'Accepted', reason: 'The run finished.', refused: false },
  failed: { label: 'Accepted', reason: 'The run failed or was interrupted.', refused: false },
  dispatch_failed: { label: 'Accepted', reason: 'The run could not be started.', refused: false },
  uncertain: { label: 'Accepted', reason: 'The run may have made changes before it stopped.', refused: false },
  running: { label: 'Refused', reason: 'The job was already running.', refused: true },
  pending: { label: 'Refused', reason: 'An earlier request is still waiting to start.', refused: true },
  paused: { label: 'Refused', reason: 'The job is paused.', refused: true },
  replay: { label: 'Refused', reason: 'The same signed request was sent again.', refused: true },
  rejected_signature: { label: 'Refused', reason: 'The signature did not match.', refused: true },
  rate_limited: { label: 'Refused', reason: 'Too many requests in a minute.', refused: true },
  too_large: { label: 'Refused', reason: 'The request body was too large.', refused: true }
}

export function describeDelivery(delivery: ScheduledWebhookDelivery): OutcomeText & { detail: string; bytes: string; missing: string | null } {
  const outcome = DELIVERY_OUTCOME[delivery.outcome] ?? { label: delivery.outcome, reason: '', refused: false }
  return {
    ...outcome,
    detail: delivery.error?.trim() || outcome.reason,
    bytes: `${delivery.bodyBytes} ${delivery.bodyBytes === 1 ? 'byte' : 'bytes'}`,
    missing: delivery.missingPlaceholders?.length ? delivery.missingPlaceholders.join(', ') : null
  }
}
