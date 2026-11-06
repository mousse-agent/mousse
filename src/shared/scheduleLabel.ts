import type { JobSchedule } from './types'

/**
 * Schedules in words, for the Scheduled panel ("Weekdays at 9:00") and for bots' schedule chips and
 * About ("every weekday · 09:00", Bot Phase 1 §5.5). Pure: the locale is passed in (absent: the
 * runtime's own), so the daemon and the renderer word a schedule the same way.
 */

/** A time of day in the person's own clock format: "9:00" or "9:00 AM". */
export function clockText(hour: number, minute: number, locale?: string): string {
  return new Date(2000, 0, 3, hour, minute).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
}

const timeOf = (date: Date, locale?: string) => date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
const DAY_MS = 24 * 3_600_000
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
/** Whole calendar days from `now` to `date`: 0 today, 1 tomorrow, -1 yesterday. */
export const dayOffset = (date: Date, now: Date) => Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS)

/**
 * A saved time said the way a to-do list says it: "15:00" today, "tomorrow 9:00", "yesterday 9:01", "Mon 8:30"
 * within the week either side, else "12 Nov 10:00" (with the year when it is not this year).
 */
export function relativeWhen(iso: string | null | undefined, now: Date = new Date(), locale?: string): string {
  const date = iso ? new Date(iso) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  const time = timeOf(date, locale)
  const offset = dayOffset(date, now)
  if (offset === 0) return time
  if (offset === 1) return `tomorrow ${time}`
  if (offset === -1) return `yesterday ${time}`
  if (Math.abs(offset) < 7) return `${date.toLocaleDateString(locale, { weekday: 'short' })} ${time}`
  const day = date.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
  return `${day} ${time}`
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** A cron expression that a person can read as a sentence: a fixed time on every day, on weekdays, on some days of the week, or every N hours. */
export type SimpleCron =
  | { kind: 'days'; minute: number; hour: number; days: number[] | 'all' }
  | { kind: 'hours'; minute: number; every: number }
  | { kind: 'minutes'; every: number }

const INT = /^\d{1,2}$/

/** Reads the simple cron forms; anything else (day of month, month, ranges of hours) is null. */
export function parseSimpleCron(expr: string | undefined): SimpleCron | null {
  const fields = expr?.trim().split(/\s+/) ?? []
  if (fields.length !== 5) return null
  const [m, h, dom, mon, dow] = fields
  if (dom !== '*' || mon !== '*') return null
  const step = (field: string) => (field === '*' ? 1 : /^\*\/\d{1,2}$/.test(field) ? Number(field.slice(2)) : null)
  if (/^\*\/\d{1,2}$/.test(m) && h === '*' && dow === '*') {
    const every = Number(m.slice(2))
    return every >= 1 && every < 60 ? { kind: 'minutes', every } : null
  }
  if (!INT.test(m) || Number(m) > 59) return null
  const minute = Number(m)
  const hourStep = step(h)
  if (hourStep !== null) return dow === '*' && hourStep >= 1 && hourStep < 24 ? { kind: 'hours', minute, every: hourStep } : null
  if (!INT.test(h) || Number(h) > 23) return null
  const hour = Number(h)
  if (dow === '*') return { kind: 'days', minute, hour, days: 'all' }
  const days = new Set<number>()
  for (const part of dow.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part)
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])]
      if (from > to || to > 7) return null
      for (let day = from; day <= to; day += 1) days.add(day % 7)
    } else if (/^\d$/.test(part) && Number(part) <= 7) days.add(Number(part) % 7)
    else return null
  }
  return { kind: 'days', minute, hour, days: [...days].sort((a, b) => a - b) }
}

const sameDays = (days: number[], wanted: number[]) => days.length === wanted.length && days.every((day, index) => day === wanted[index])
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

function daysText(days: number[] | 'all', long: boolean): string {
  if (days === 'all' || days.length === 7) return long ? 'Every day' : 'Daily'
  if (sameDays(days, [1, 2, 3, 4, 5])) return long ? 'Monday to Friday' : 'Weekdays'
  if (sameDays(days, [0, 6])) return long ? 'Saturday and Sunday' : 'Weekends'
  if (days.length === 1) return long ? `Every ${WEEKDAY_NAMES[days[0]]}` : `${WEEKDAY_NAMES[days[0]]}s`
  return WEEK_ORDER.filter((day) => days.includes(day)).map((day) => WEEKDAY_NAMES[day].slice(0, 3)).join(', ')
}

/** "Weekdays at 9:00", "Every 2 hours", or null for a cron expression that is not one of the simple forms. */
export function humanCron(expr: string | undefined, long = false, locale?: string): string | null {
  const cron = parseSimpleCron(expr)
  if (!cron) return null
  if (cron.kind === 'minutes') return `Every ${cron.every} min`
  if (cron.kind === 'hours') {
    const base = cron.every === 1 ? 'Hourly' : `Every ${cron.every} hours`
    return cron.minute === 0 ? base : `${base} at :${String(cron.minute).padStart(2, '0')}`
  }
  return `${daysText(cron.days, long)} at ${clockText(cron.hour, cron.minute, locale)}`
}

function intervalText(minutes: number | undefined): string {
  const value = minutes ?? 0
  if (value === 60) return 'Hourly'
  if (value > 60 && value % 1440 === 0) return value === 1440 ? 'Every day' : `Every ${value / 1440} days`
  if (value > 60 && value % 60 === 0) return `Every ${value / 60} hours`
  return `Every ${value} min`
}

/** The schedule in a few words for a row: "Weekdays at 9:00", "Every 30 min", "Once, tomorrow 10:00", "Only when run". */
export function describeSchedule(schedule: JobSchedule, now: Date = new Date(), locale?: string): string {
  switch (schedule.kind) {
    case 'once':
      return schedule.runAt ? `Once, ${relativeWhen(schedule.runAt, now, locale)}` : 'Once'
    case 'interval':
      return intervalText(schedule.minutes)
    case 'cron':
      return humanCron(schedule.expr, false, locale) ?? 'Custom schedule'
    case 'manual':
      return 'Only when run'
  }
}

/** The schedule as a sentence for the details: "Monday to Friday at 9:00, this computer's time". */
export function describeScheduleLong(schedule: JobSchedule, now: Date = new Date(), locale?: string): string {
  switch (schedule.kind) {
    case 'once':
      return schedule.runAt ? `Once, ${relativeWhen(schedule.runAt, now, locale)}` : 'Once'
    case 'interval':
      return schedule.minutes === 60 ? 'Every hour' : schedule.minutes === 1 ? 'Every minute' : `Every ${schedule.minutes} minutes`
    case 'cron': {
      const text = humanCron(schedule.expr, true, locale)
      return text ? `${text}, this computer's time` : "A custom schedule, this computer's time"
    }
    case 'manual':
      return 'Only when you run it'
  }
}

/** A bot schedule's time: every few minutes, or a five-field cron expression in local time. */
export type BotScheduleWhen = { kind: 'interval'; minutes: number } | { kind: 'cron'; expr: string }

/**
 * A time of day for a bot's label: "09:00" (24-hour, two digits) unless a locale is given, then in
 * that locale's clock ("9:00 AM").
 */
function botClock(hour: number, minute: number, locale?: string): string {
  if (!locale) return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  return new Date(2000, 0, 3, hour, minute).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

function everyMinutes(minutes: number): string {
  if (minutes === 1) return 'every minute'
  if (minutes === 60) return 'every hour'
  if (minutes > 60 && minutes % 1440 === 0) return minutes === 1440 ? 'every day' : `every ${minutes / 1440} days`
  if (minutes > 60 && minutes % 60 === 0) return `every ${minutes / 60} hours`
  return `every ${minutes} minutes`
}

function botDays(days: number[] | 'all'): string {
  if (days === 'all' || days.length === 7) return 'every day'
  if (sameDays(days, [1, 2, 3, 4, 5])) return 'every weekday'
  if (sameDays(days, [0, 6])) return 'every weekend'
  if (days.length === 1) return `every ${WEEKDAY_NAMES[days[0]]}`
  return WEEK_ORDER.filter((day) => days.includes(day)).map((day) => WEEKDAY_NAMES[day].slice(0, 3)).join(', ')
}

/**
 * A bot schedule as its chip and About say it, lower case: "every weekday · 09:00", "every Monday ·
 * 08:30", "every 30 minutes", "every 2 hours · :15". A cron expression outside the simple forms
 * reads "on a custom schedule".
 */
export function botScheduleLabel(when: BotScheduleWhen, locale?: string): string {
  if (when.kind === 'interval') return everyMinutes(when.minutes)
  const cron = parseSimpleCron(when.expr)
  if (!cron) return 'on a custom schedule'
  if (cron.kind === 'minutes') return everyMinutes(cron.every)
  if (cron.kind === 'hours') {
    const base = everyMinutes(cron.every * 60)
    return cron.minute === 0 ? base : `${base} · :${String(cron.minute).padStart(2, '0')}`
  }
  return `${botDays(cron.days)} · ${botClock(cron.hour, cron.minute, locale)}`
}
