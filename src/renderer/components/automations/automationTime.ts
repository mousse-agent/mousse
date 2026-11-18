import type { JobSchedule } from '../../../shared/types'

/**
 * Times on the Automations page follow the owning computer's clock: a time is shown in that computer's zone, and the
 * zone is named only when it differs from this computer's (before Add, Next always names it).
 */

/** This computer's IANA time zone. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** The calendar parts of an instant on a zone's clock. */
export function zonedParts(at: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23'
  }).formatToParts(at)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0'
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')] ?? 0
  }
}

const dayNumber = (parts: Pick<ZonedParts, 'year' | 'month' | 'day'>) => Math.round(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000)

/** Whole days from `now` to `at` on the zone's calendar: 0 today, 1 tomorrow. */
export function zonedDayOffset(at: Date, now: Date, timeZone: string): number {
  return dayNumber(zonedParts(at, timeZone)) - dayNumber(zonedParts(now, timeZone))
}

/** The zone's short name at that instant: "IST", "GMT+5:30", "PST". */
export function zoneName(timeZone: string, at: Date = new Date(), locale?: string): string {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' }).formatToParts(at).find((entry) => entry.type === 'timeZoneName')
    return part?.value ?? timeZone
  } catch {
    return timeZone
  }
}

/** A time of day on the zone's clock, in the person's format: "9:00" or "9:00 AM". */
export function zonedClock(at: Date, timeZone: string, locale?: string): string {
  return at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone })
}

/**
 * When a run is, the way the list says it, on the owning computer's clock: "9:00" today, "Tomorrow 9:00", "Fri 16:00"
 * within the week, else "12 Nov 9:00".
 */
export function whenText(iso: string, now: Date, timeZone: string, locale?: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const clock = zonedClock(at, timeZone, locale)
  const offset = zonedDayOffset(at, now, timeZone)
  if (offset === 0) return clock
  if (offset === 1) return `Tomorrow ${clock}`
  if (offset === -1) return `Yesterday ${clock}`
  if (Math.abs(offset) < 7) return `${at.toLocaleDateString(locale, { weekday: 'short', timeZone })} ${clock}`
  return `${at.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone })} ${clock}`
}

/** "<when>", with "<Computer> time" after it when the owning computer's zone is not this one's. */
export function ownedWhenText(iso: string, now: Date, owner: { name: string; timeZone: string }, viewerZone: string, locale?: string): string {
  // A computer that has not said its zone yet is read on this clock, with its name.
  const text = whenText(iso, now, owner.timeZone || viewerZone, locale)
  return owner.timeZone === viewerZone ? text : `${text} ${owner.name} time`
}

/** How long ago, short: "just now", "5 min ago", "2 h ago", "3 d ago". */
/** How long ago, short: "just now", "5 min ago", "2 h ago", "3 d ago". */
export function agoText(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ''
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`
  return `${Math.floor(ms / 86_400_000)} d ago`
}

/** One cron field as the values it allows. */
function cronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const match = /^(\*|\d{1,2}|\d{1,2}-\d{1,2})(?:\/(\d{1,2}))?$/.exec(part)
    if (!match) return null
    const step = match[2] === undefined ? 1 : Number(match[2])
    if (step < 1) return null
    const [start, end] = match[1] === '*'
      ? [min, max]
      : match[1]!.includes('-')
        ? (match[1]!.split('-').map(Number) as [number, number])
        : [Number(match[1]), match[2] === undefined ? Number(match[1]) : max]
    if (start < min || end > max || start > end) return null
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values
}

export interface SkippedDate {
  /** The day, "YYYY-MM-DD" (a day of the month that does not exist keeps its number). */
  date: string
  /** The skip in words. */
  reason: string
}

/**
 * The days in the coming year on which a cron schedule says it runs but cannot, on this computer's clock: a time the
 * clock skips when it moves forward (daylight saving), or a day of the month that a month does not have (the 31st,
 * Feb 29). Repeats of an interval and one-time runs skip nothing. Read on this computer's clock, as the scheduler reads it.
 */
export function skippedDates(schedule: JobSchedule, from: Date = new Date(), days = 366, limit = 6): SkippedDate[] {
  if (schedule.kind !== 'cron' || !schedule.expr) return []
  const fields = schedule.expr.trim().split(/\s+/)
  if (fields.length < 5) return []
  const minutes = cronField(fields[0]!, 0, 59)
  const hours = cronField(fields[1]!, 0, 23)
  const doms = cronField(fields[2]!, 1, 31)
  const months = cronField(fields[3]!, 1, 12)
  const dows = cronField(fields[4]!, 0, 7)
  if (!minutes || !hours || !doms || !months || !dows) return []
  if (dows.has(7)) dows.add(0)
  const domAll = fields[2] === '*'
  const out: SkippedDate[] = []
  const iso = (year: number, month: number, day: number) => `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  // A day of the month that some months lack.
  if (!domAll) {
    for (let offset = 0; offset < 13 && out.length < limit; offset += 1) {
      const year = from.getFullYear() + Math.floor((from.getMonth() + offset) / 12)
      const month = (from.getMonth() + offset) % 12
      if (!months.has(month + 1)) continue
      const length = new Date(year, month + 1, 0).getDate()
      for (const day of [...doms].sort((a, b) => a - b)) {
        if (day > length && out.length < limit) out.push({ date: iso(year, month, day > 31 ? 31 : day), reason: `No run in ${new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}: it has no day ${day}` })
      }
    }
  }
  // A time the clock jumps over.
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  for (let offset = 0; offset < days && out.length < limit; offset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset)
    if (!months.has(day.getMonth() + 1) || !dows.has(day.getDay()) || !doms.has(day.getDate())) continue
    for (const hour of hours) {
      const missing = [...minutes].some((minute) => {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute)
        return at.getHours() !== hour || at.getMinutes() !== minute
      })
      if (missing) {
        out.push({ date: iso(day.getFullYear(), day.getMonth(), day.getDate()), reason: `No run on ${day.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}: the clock skips ${String(hour).padStart(2, '0')}:00 (daylight saving)` })
        break
      }
    }
  }
  return out
}
