function durationParts(milliseconds: number): { hours: number; minutes: number; seconds: number } {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000))
  return {
    hours: Math.floor(totalSeconds / 3_600),
    minutes: Math.floor((totalSeconds % 3_600) / 60),
    seconds: totalSeconds % 60,
  }
}

/** "12s", "4m 12s", "4m", "1h 2m", "1h": seconds only under an hour. */
export function formatDurationShort(milliseconds: number): string {
  const { hours, minutes, seconds } = durationParts(milliseconds)
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
  return `${seconds}s`
}

const countLabel = (count: number, singular: string): string => `${count} ${singular}${count === 1 ? '' : 's'}`

/** "1 hour and 2 minutes", "4 minutes and 12 seconds", "12 seconds": the same parts as the short form, spelled out. */
export function formatDurationLong(milliseconds: number): string {
  const { hours, minutes, seconds } = durationParts(milliseconds)
  if (hours) return minutes ? `${countLabel(hours, 'hour')} and ${countLabel(minutes, 'minute')}` : countLabel(hours, 'hour')
  if (minutes) return seconds ? `${countLabel(minutes, 'minute')} and ${countLabel(seconds, 'second')}` : countLabel(minutes, 'minute')
  return countLabel(seconds, 'second')
}

/** "Worked for 4m 12s" under a finished turn. */
export const formatWorkedFor = (milliseconds: number): string => `Worked for ${formatDurationShort(milliseconds)}`

/** "Working · 4m 12s" while a turn runs. */
export const formatWorkingFor = (milliseconds: number): string => `Working · ${formatDurationShort(milliseconds)}`
