import type { JobSchedule } from '../../../shared/types'
import { describeSchedule } from '../../../shared/scheduleLabel'

/**
 * English time phrases in the create row ("every weekday at 9 review open PRs"). It never guesses: a phrase it cannot
 * read exactly is `ambiguous`, the When chip says Choose when, and Add stays off. On demand is never read from text;
 * the person picks it.
 */
export type WhenParse =
  | { kind: 'none' }
  | { kind: 'ambiguous'; phrase: string; reason: string }
  | { kind: 'ok'; schedule: JobSchedule; label: string; phrase: string; prompt: string }

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, sundays: 0,
  mon: 1, monday: 1, mondays: 1,
  tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, wednesday: 3, wednesdays: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
  fri: 5, friday: 5, fridays: 5,
  sat: 6, saturday: 6, saturdays: 6
}
const DAY = '(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day)?s?|tuesdays?|wednesdays?|thursdays?|saturdays?'
const PERIOD = '(?:morning|afternoon|evening|night)'

/** A time of day: "9", "9:30", "9am", "9.30 pm", "17:00", "noon", "midnight". */
const TIME = String.raw`(?:noon|midnight|(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?)`

/** The recurring part, without its time. */
const RECURRING = new RegExp(
  String.raw`\b(?:` +
    String.raw`(every\s+day|each\s+day|daily|every\s+${PERIOD}|each\s+${PERIOD}|every\s+weekday|(?:on\s+)?weekdays|every\s+weekend|(?:on\s+)?weekends)` +
    String.raw`|((?:every|each|on)\s+(?:${DAY})(?:\s*(?:,|and|&)\s*(?:${DAY}))*|(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)(?:\s*(?:,|and|&)\s*(?:${DAY}))*)` +
  String.raw`)\b`,
  'i'
)
const INTERVAL = /\b(?:every\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|h|days?)|every\s+(minute|hour|half\s+(?:an\s+)?hour)|(hourly))\b/i
const ONCE = new RegExp(String.raw`\b(today|tonight|tomorrow)(?:\s+${PERIOD})?\b`, 'i')
const IN_DELAY = /\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i
const TIME_AFTER = new RegExp(String.raw`^\s*(?:at\s+|@\s*)?${TIME}\b(?:\s+(?:in\s+the\s+)?${PERIOD})?`, 'i')
const TIME_BEFORE = new RegExp(String.raw`(?:^|\s)(?:at\s+|@\s*)${TIME}(?:\s+(?:in\s+the\s+)?${PERIOD})?\s*$`, 'i')
const LONE_TIME = new RegExp(String.raw`\b(?:at|@)\s*${TIME}\b`, 'i')

type Clock = { hour: number; minute: number } | { ambiguous: string }

/** Reads a matched time. `period` is a word around it ("morning", "evening") that says which half of the day. */
function clockOf(text: string, period: string | undefined): Clock {
  const lower = text.toLowerCase().trim().replace(/^(at|@)\s*/, '')
  if (lower.startsWith('noon')) return { hour: 12, minute: 0 }
  if (lower.startsWith('midnight')) return { hour: 0, minute: 0 }
  const match = /^(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/.exec(lower)
  if (!match) return { ambiguous: 'Say the time, like 9:00' }
  let hour = Number(match[1])
  const minute = match[2] === undefined ? 0 : Number(match[2])
  if (minute > 59 || hour > 23) return { ambiguous: `${text.trim()} is not a time` }
  const suffix = match[3]?.replace(/\./g, '')
  const half = suffix ?? (period ? (/morning/.test(period) ? 'am' : 'pm') : undefined)
  if (half) {
    if (hour < 1 || hour > 12) return { ambiguous: `${text.trim()} is not a time` }
    if (half === 'am') hour = hour === 12 ? 0 : hour
    else hour = hour === 12 ? 12 : hour + 12
    return { hour, minute }
  }
  // A 24-hour time, a time written with a leading zero, or a morning hour people say without "am".
  if (hour === 0 || hour >= 13 || /^0\d/.test(match[1]!) || (hour >= 7 && hour <= 12)) return { hour, minute }
  return { ambiguous: `Is ${text.trim()} in the morning or the evening?` }
}

const periodIn = (text: string): string | undefined => new RegExp(PERIOD, 'i').exec(text)?.[0]?.toLowerCase()

/** Removes the phrase from what was typed: what is left is what the agent should do. */
function rest(text: string, start: number, end: number): string {
  return `${text.slice(0, start)} ${text.slice(end)}`.replace(/\s+/g, ' ').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').replace(/^(to|and)\s+/i, '').trim()
}

function daysOf(text: string): number[] | 'all' | 'weekdays' | 'weekends' {
  const lower = text.toLowerCase()
  if (/every\s+day|each\s+day|daily|every\s+(morning|afternoon|evening|night)|each\s+(morning|afternoon|evening|night)/.test(lower)) return 'all'
  if (/weekday/.test(lower)) return 'weekdays'
  if (/weekend/.test(lower)) return 'weekends'
  const days = new Set<number>()
  for (const word of lower.split(/[^a-z]+/)) if (word in DAY_NAMES) days.add(DAY_NAMES[word]!)
  return [...days].sort((a, b) => a - b)
}

function cronDays(days: ReturnType<typeof daysOf>): string {
  if (days === 'all') return '*'
  if (days === 'weekdays') return '1-5'
  if (days === 'weekends') return '0,6'
  return days.join(',')
}

const ok = (schedule: JobSchedule, text: string, start: number, end: number, now: Date): WhenParse => ({
  kind: 'ok',
  schedule,
  label: describeSchedule(schedule, now),
  phrase: text.slice(start, end).trim(),
  prompt: rest(text, start, end)
})

export function parseWhen(text: string, now: Date = new Date()): WhenParse {
  const found: Array<{ start: number; end: number; parse: () => WhenParse }> = []

  const interval = INTERVAL.exec(text)
  if (interval) {
    const start = interval.index
    const end = start + interval[0].length
    found.push({ start, end, parse: () => {
      if (interval[4]) return ok({ kind: 'interval', minutes: 60 }, text, start, end, now)
      if (interval[3]) {
        const unit = interval[3].toLowerCase()
        return ok({ kind: 'interval', minutes: unit === 'minute' ? 1 : unit === 'hour' ? 60 : 30 }, text, start, end, now)
      }
      const count = Number(interval[1])
      const unit = interval[2]!.toLowerCase()
      const minutes = unit.startsWith('d') ? count * 1440 : unit.startsWith('h') ? count * 60 : count
      if (!Number.isInteger(minutes) || minutes < 1) return { kind: 'ambiguous', phrase: interval[0], reason: 'Use a whole number of minutes, at least 1' }
      return ok({ kind: 'interval', minutes }, text, start, end, now)
    } })
  }

  const recurring = RECURRING.exec(text)
  if (recurring) {
    let start = recurring.index
    let end = start + recurring[0].length
    const after = TIME_AFTER.exec(text.slice(end))
    const before = after ? null : TIME_BEFORE.exec(text.slice(0, start))
    let timeText: string | undefined
    if (after) {
      timeText = after[0]
      end += after[0].length
    } else if (before) {
      timeText = before[0]
      start = before.index + (before[0].length - before[0].trimStart().length)
    }
    found.push({ start, end, parse: () => {
      const phrase = text.slice(start, end).trim()
      if (!timeText) return { kind: 'ambiguous', phrase, reason: 'Say the time, like "at 9:00"' }
      const clock = clockOf(timeText, periodIn(phrase))
      if ('ambiguous' in clock) return { kind: 'ambiguous', phrase, reason: clock.ambiguous }
      const days = daysOf(recurring[0])
      if (Array.isArray(days) && days.length === 0) return { kind: 'ambiguous', phrase, reason: 'Say which days' }
      return ok({ kind: 'cron', expr: `${clock.minute} ${clock.hour} * * ${cronDays(days)}` }, text, start, end, now)
    } })
  }

  const once = ONCE.exec(text)
  if (once) {
    let start = once.index
    let end = start + once[0].length
    const after = TIME_AFTER.exec(text.slice(end))
    const before = after ? null : TIME_BEFORE.exec(text.slice(0, start))
    let timeText: string | undefined
    if (after) {
      timeText = after[0]
      end += after[0].length
    } else if (before) {
      timeText = before[0]
      start = before.index + (before[0].length - before[0].trimStart().length)
    }
    found.push({ start, end, parse: () => {
      const phrase = text.slice(start, end).trim()
      if (!timeText) return { kind: 'ambiguous', phrase, reason: 'Say the time, like "tomorrow at 9:00"' }
      const word = once[1]!.toLowerCase()
      const clock = clockOf(timeText, periodIn(phrase) ?? (word === 'tonight' ? 'night' : undefined))
      if ('ambiguous' in clock) return { kind: 'ambiguous', phrase, reason: clock.ambiguous }
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (word === 'tomorrow' ? 1 : 0), clock.hour, clock.minute)
      if (at.getTime() <= now.getTime()) return { kind: 'ambiguous', phrase, reason: 'That time has passed' }
      return ok({ kind: 'once', runAt: at.toISOString() }, text, start, end, now)
    } })
  }

  const delay = IN_DELAY.exec(text)
  if (delay) {
    const start = delay.index
    const end = start + delay[0].length
    found.push({ start, end, parse: () => {
      const count = Number(delay[1])
      const minutes = /^h/i.test(delay[2]!) ? count * 60 : count
      if (minutes < 1) return { kind: 'ambiguous', phrase: delay[0], reason: 'Use at least 1 minute' }
      return ok({ kind: 'once', runAt: new Date(now.getTime() + minutes * 60_000).toISOString() }, text, start, end, now)
    } })
  }

  // Two phrases that do not overlap ("every hour … tomorrow at 9") say two different things.
  const distinct = found.filter((entry, index) => !found.some((other, at) => at < index && entry.start < other.end && other.start < entry.end))
  if (distinct.length > 1) {
    return { kind: 'ambiguous', phrase: distinct.map((entry) => text.slice(entry.start, entry.end).trim()).join(' / '), reason: 'Say one time' }
  }
  if (distinct.length === 1) return distinct[0]!.parse()
  // A time with no day ("at 9 check CI") could be once or every day.
  const lone = LONE_TIME.exec(text)
  if (lone) return { kind: 'ambiguous', phrase: lone[0].trim(), reason: 'Say which days, like "every day at 9"' }
  return { kind: 'none' }
}
