import { afterEach, describe, expect, it } from 'vitest'
import { skippedDates } from '../src/renderer/components/automations/automationTime'
import { computeNextRun, nextOccurrenceAfter, occurrencesSince } from '../src/mms/scheduled/computeNextRun'

const originalZone = process.env.TZ
afterEach(() => {
  if (originalZone === undefined) delete process.env.TZ
  else process.env.TZ = originalZone
})

// Berlin repeats 02:00, New York repeats 01:00. Both skip 02:00 in spring.
const zones = [
  { zone: 'Europe/Berlin', spring: '2026-03-29', springOffset: '+01:00', summerOffset: '+02:00', fall: '2026-10-25', repeatedHour: '02' },
  { zone: 'America/New_York', spring: '2026-03-08', springOffset: '-05:00', summerOffset: '-04:00', fall: '2026-11-01', repeatedHour: '01' }
]

describe.each(zones)('cron clock changes in $zone', (row) => {
  const at = (day: string, time: string, offset: string) => new Date(`${day}T${time}:00${offset}`)

  it('runs a skipped 02:30 once at 03:00, then at 02:30 the next day', () => {
    process.env.TZ = row.zone
    const schedule = { kind: 'cron', expr: '30 2 * * *' } as const
    const from = at(row.spring, '01:59', row.springOffset)
    const due = at(row.spring, '03:00', row.summerOffset).toISOString()
    expect(computeNextRun(schedule, null, from)).toBe(due)
    const tomorrow = at(row.spring, '03:00', row.summerOffset)
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(2, 30)
    expect(computeNextRun(schedule, due)).toBe(tomorrow.toISOString())
    expect(nextOccurrenceAfter(schedule, from.toISOString(), from)).toBe(due)
    expect(occurrencesSince(schedule, from.toISOString(), at(row.spring, '04:00', row.summerOffset))).toBe(2)
  })

  it('runs a repeated daily time once, including when searched inside the second hour', () => {
    process.env.TZ = row.zone
    const schedule = { kind: 'cron', expr: `30 ${Number(row.repeatedHour)} * * *` } as const
    const first = at(row.fall, `${row.repeatedHour}:30`, row.summerOffset).toISOString()
    expect(computeNextRun(schedule, null, at(row.fall, '00:00', row.summerOffset))).toBe(first)
    const tomorrow = at(row.fall, `${row.repeatedHour}:30`, row.springOffset)
    tomorrow.setDate(tomorrow.getDate() + 1)
    expect(computeNextRun(schedule, first)).toBe(tomorrow.toISOString())
    expect(computeNextRun(schedule, null, at(row.fall, `${row.repeatedHour}:10`, row.springOffset))).toBe(tomorrow.toISOString())
  })

  it('catches up once from before the gap and respects calendar fields', () => {
    process.env.TZ = row.zone
    const before = at(row.spring, '00:00', row.springOffset)
    const due = at(row.spring, '03:00', row.summerOffset).toISOString()
    const day = before.getDate()
    const month = before.getMonth() + 1
    const schedule = { kind: 'cron', expr: `15,30,45 2 ${day} ${month} 0` } as const
    expect(computeNextRun(schedule, null, before)).toBe(due)
    expect(occurrencesSince(schedule, due, at(row.spring, '04:00', row.summerOffset))).toBe(1)
    expect(computeNextRun({ kind: 'cron', expr: '30 2 * * 1' }, null, before)).not.toBe(due)
    expect(computeNextRun({ kind: 'cron', expr: '30 3 * * *' }, null, before)).toBe(at(row.spring, '03:30', row.summerOffset).toISOString())
  })

  it('does not describe a fixed-hour spring run as a skipped date', () => {
    process.env.TZ = row.zone
    expect(skippedDates({ kind: 'cron', expr: '30 2 * * *' }, at(row.spring, '00:00', row.springOffset), 2)).toEqual([])
  })

  it('keeps elapsed intervals and hourly cron cadence across both changes', () => {
    process.env.TZ = row.zone
    for (const [from, hourly] of [
      [at(row.spring, '01:30', row.springOffset), at(row.spring, '03:30', row.summerOffset)],
      [at(row.fall, `${row.repeatedHour}:30`, row.summerOffset), at(row.fall, `${String(Number(row.repeatedHour) + 1).padStart(2, '0')}:30`, row.springOffset)]
    ]) {
      expect(computeNextRun({ kind: 'interval', minutes: 60 }, from!.toISOString())).toBe(new Date(from!.getTime() + 3_600_000).toISOString())
      expect(computeNextRun({ kind: 'cron', expr: '30 * * * *' }, from!.toISOString())).toBe(hourly!.toISOString())
    }
  })
})
