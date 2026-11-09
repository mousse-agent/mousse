import { ipcErrorMessage } from '../../utils/voiceErrors'
import { clockText, WEEKDAY_NAMES } from '../../../shared/scheduleLabel'
import type { JobSchedule } from '../../../shared/types'

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
