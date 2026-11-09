import { ipcErrorMessage } from '../../utils/voiceErrors'
import { WEEKDAY_NAMES } from '../../../shared/scheduleLabel'
import type { JobSchedule } from '../../../shared/types'

// Moved to `src/shared/scheduleLabel.ts` so bots word schedules the same way; re-exported here.
export { clockText, describeSchedule, describeScheduleLong, humanCron, parseSimpleCron, relativeWhen, type SimpleCron } from '../../../shared/scheduleLabel'

export const WEEKDAY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [1, 2, 3, 4, 5, 6, 0].map((day) => ({ value: String(day), label: WEEKDAY_NAMES[day] }))

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
