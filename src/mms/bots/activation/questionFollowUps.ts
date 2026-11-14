/**
 * When a question's follow-up may happen (issue #1123): never in the owner's quiet hours (22:00 to 08:00 in their time
 * zone; it moves to 08:00), and a bot's nudges, all its questions together, at most one an hour and three in any 24 hours
 * (one beyond that moves to the next free time). Pure: the engine passes the time, the zone and the bot's nudges so far.
 */
import { MAX_NUDGES_PER_DAY, NUDGE_SPACING_MS, QUIET_FROM_HOUR, QUIET_UNTIL_HOUR } from '../../../shared/bots/personal/questions'

const DAY_MS = 24 * 60 * 60_000

interface WallTime { year: number; month: number; day: number; hour: number; minute: number }

/** The wall-clock time `at` shows in `zone`. */
function wallTime(at: number, zone: string): WallTime {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(at))
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value ?? 0)
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') }
}

/** The moment a wall-clock time happens in `zone` (across a clock change, the first moment it shows that time or after). */
function momentOf(wall: WallTime, zone: string): number {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  let at = target
  for (let tries = 0; tries < 3; tries += 1) {
    const seen = wallTime(at, zone)
    const off = target - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute)
    if (off === 0) break
    at += off
  }
  return at
}

/** Whether `at` falls in the quiet hours in `zone`. */
export function inQuietHours(at: number, zone: string): boolean {
  const { hour } = wallTime(at, zone)
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR
}

/** `at`, or 08:00 the next morning in `zone` when `at` falls in the quiet hours. */
export function afterQuietHours(at: number, zone: string): number {
  const wall = wallTime(at, zone)
  if (!inQuietHours(at, zone)) return at
  // Before 08:00 it is this morning; from 22:00, the next.
  const day = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + (wall.hour < QUIET_UNTIL_HOUR ? 0 : 1)))
  return Math.max(at, momentOf({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: QUIET_UNTIL_HOUR, minute: 0 }, zone))
}

/**
 * The first time from `at` a bot may post a nudge: an hour after its last one, once fewer than three fall in the 24 hours
 * before, and out of the quiet hours. `nudges`: when the bot's earlier nudges were posted. One posted "later" than `at`
 * (the clock was set back since) counts as just posted, in both budgets: a clock change never frees a slot.
 */
export function nudgeSlot(at: number, nudges: readonly number[], zone: string): number {
  let slot = at
  // Each rule can only move it later, so this settles in a few rounds.
  for (let round = 0; round < 8; round += 1) {
    const before = slot
    const close = nudges.filter((time) => time > slot - NUDGE_SPACING_MS)
    if (close.length) slot = Math.max(...close) + NUDGE_SPACING_MS
    const day = nudges.filter((time) => time > slot - DAY_MS).sort((a, b) => a - b)
    if (day.length >= MAX_NUDGES_PER_DAY) slot = day[day.length - MAX_NUDGES_PER_DAY]! + DAY_MS
    slot = afterQuietHours(slot, zone)
    if (slot === before) break
  }
  return slot
}
