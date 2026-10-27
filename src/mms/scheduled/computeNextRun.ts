import type { JobSchedule } from '../../shared/types'

const ONESHOT_GRACE_MS = 120_000

function parseIso(iso: string): Date {
  return new Date(iso)
}

/** Each field's allowed range: minute, hour, day of month, month, day of week (7 is Sunday too). */
const CRON_FIELDS: ReadonlyArray<readonly [number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

/** The values one cron field allows, or null when it is malformed (a step below 1, a value out of range). */
function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const match = /^(\*|\d{1,2}|\d{1,2}-\d{1,2})(?:\/(\d{1,2}))?$/.exec(part)
    if (!match) return null
    const step = match[2] === undefined ? 1 : Number(match[2])
    if (step < 1) return null
    let start: number
    let end: number
    if (match[1] === '*') {
      start = min
      end = max
    } else if (match[1]!.includes('-')) {
      ;[start, end] = match[1]!.split('-').map(Number) as [number, number]
    } else {
      start = Number(match[1])
      // `n/step` runs from n to the end of the range.
      end = match[2] === undefined ? start : max
    }
    if (start < min || end > max || start > end) return null
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values
}

/**
 * A cron expression's five fields as sets of allowed values; extra fields are ignored. Null when
 * it is malformed, so a bad expression never runs and is never searched.
 */
function parseCron(expr: string): Array<Set<number>> | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length < 5) return null
  const fields: Array<Set<number>> = []
  for (let index = 0; index < 5; index += 1) {
    const [min, max] = CRON_FIELDS[index]!
    const values = parseCronField(parts[index]!, min, max)
    if (!values) return null
    fields.push(values)
  }
  if (fields[4]!.has(7)) fields[4]!.add(0)
  return fields
}

/** Why a cron expression is malformed, or undefined when every field is valid. */
export function cronProblem(expr: string): string | undefined {
  if (expr.trim().split(/\s+/).length < 5) return 'A cron expression needs five fields.'
  return parseCron(expr) ? undefined : 'A cron field is invalid: use numbers in range, ranges, lists and steps of at least 1.'
}

function matchesCron(fields: Array<Set<number>>, date: Date): boolean {
  return (
    fields[0]!.has(date.getMinutes()) &&
    fields[1]!.has(date.getHours()) &&
    fields[2]!.has(date.getDate()) &&
    fields[3]!.has(date.getMonth() + 1) &&
    fields[4]!.has(date.getDay())
  )
}

function recoverableOneshotRunAt(schedule: JobSchedule, now: Date, lastRunAt?: string | null): string | null {
  const runAt = schedule.runAt
  if (!runAt) return null
  if (lastRunAt) return null

  const runAtDate = parseIso(runAt)
  if (runAtDate.getTime() >= now.getTime() - ONESHOT_GRACE_MS) {
    return runAt
  }
  return null
}

function nextCronRun(expr: string, base: Date): Date | null {
  const fields = parseCron(expr)
  if (!fields) return null
  const candidate = new Date(base.getTime())
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)

  const limit = base.getTime() + 366 * 24 * 60 * 60 * 1000
  while (candidate.getTime() <= limit) {
    if (matchesCron(fields, candidate)) {
      return new Date(candidate.getTime())
    }
    candidate.setMinutes(candidate.getMinutes() + 1)
  }
  return null
}

export function computeNextRun(
  schedule: JobSchedule,
  lastRunAt?: string | null,
  now: Date = new Date()
): string | null {
  // No clock: the job runs only when something starts it.
  if (schedule.kind === 'manual') return null

  if (schedule.kind === 'once') {
    return recoverableOneshotRunAt(schedule, now, lastRunAt)
  }

  if (schedule.kind === 'interval') {
    const minutes = schedule.minutes ?? 1
    if (lastRunAt) {
      const last = parseIso(lastRunAt)
      return new Date(last.getTime() + minutes * 60_000).toISOString()
    }
    return new Date(now.getTime() + minutes * 60_000).toISOString()
  }

  if (schedule.kind === 'cron' && schedule.expr) {
    const base = lastRunAt ? parseIso(lastRunAt) : now
    const next = nextCronRun(schedule.expr, base)
    return next ? next.toISOString() : null
  }

  return null
}

export function isSilentOutput(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (trimmed === '[SILENT]') return true
  const lines = trimmed.split('\n').map((line) => line.trim())
  if (lines[0] === '[SILENT]' || lines[lines.length - 1] === '[SILENT]') return true
  return false
}
