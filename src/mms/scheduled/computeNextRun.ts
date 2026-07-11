import type { JobSchedule } from '../../shared/types'

const ONESHOT_GRACE_MS = 120_000

function parseIso(iso: string): Date {
  return new Date(iso)
}

function matchesCronField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true

  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    const base = stepMatch ? stepMatch[1] : part
    const step = stepMatch ? Number(stepMatch[2]) : 1

    if (base.includes('-')) {
      const [start, end] = base.split('-').map(Number)
      for (let i = start; i <= end; i += step) {
        if (i === value) return true
      }
      continue
    }

    const num = Number(base)
    if (!Number.isNaN(num)) {
      if (step === 1 && num === value) return true
      if (step > 1 && value >= num && value <= max && (value - num) % step === 0) return true
      continue
    }

    if (base === '*' && value >= min && value <= max && (value - min) % step === 0) {
      return true
    }
  }

  return false
}

function matchesCronExpr(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length < 5) return false

  const [minute, hour, dom, month, dow] = parts
  const minuteVal = date.getMinutes()
  const hourVal = date.getHours()
  const domVal = date.getDate()
  const monthVal = date.getMonth() + 1
  const dowVal = date.getDay()

  return (
    matchesCronField(minute, minuteVal, 0, 59) &&
    matchesCronField(hour, hourVal, 0, 23) &&
    matchesCronField(dom, domVal, 1, 31) &&
    matchesCronField(month, monthVal, 1, 12) &&
    matchesCronField(dow, dowVal, 0, 6)
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
  const candidate = new Date(base.getTime())
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)

  const limit = base.getTime() + 366 * 24 * 60 * 60 * 1000
  while (candidate.getTime() <= limit) {
    if (matchesCronExpr(expr, candidate)) {
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
