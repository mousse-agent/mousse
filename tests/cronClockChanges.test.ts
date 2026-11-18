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

  it('leaves a skipped 02:30 unrun and advances to the next day', () => {
    process.env.TZ = row.zone
    const schedule = { kind: 'cron', expr: '30 2 * * *' } as const
    const from = at(row.spring, '01:59', row.springOffset)
    const tomorrow = at(row.spring, '03:00', row.summerOffset)
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(2, 30)
    expect(computeNextRun(schedule, null, from)).toBe(tomorrow.toISOString())
    expect(nextOccurrenceAfter(schedule, from.toISOString(), from)).toBe(tomorrow.toISOString())
    expect(occurrencesSince(schedule, from.toISOString(), at(row.spring, '04:00', row.summerOffset))).toBe(1)
  })

  it('runs a repeated daily time once when advancing from its first occurrence', () => {
    process.env.TZ = row.zone
    const schedule = { kind: 'cron', expr: `30 ${Number(row.repeatedHour)} * * *` } as const
    const first = at(row.fall, `${row.repeatedHour}:30`, row.summerOffset).toISOString()
    expect(computeNextRun(schedule, null, at(row.fall, '00:00', row.summerOffset))).toBe(first)
    const tomorrow = at(row.fall, `${row.repeatedHour}:30`, row.springOffset)
    tomorrow.setDate(tomorrow.getDate() + 1)
    expect(computeNextRun(schedule, first)).toBe(tomorrow.toISOString())
  })

  it('never returns a past daily time when searched inside the second hour', () => {
    process.env.TZ = row.zone
    const from = at(row.fall, `${row.repeatedHour}:10`, row.springOffset)
    const tomorrow = at(row.fall, `${row.repeatedHour}:30`, row.springOffset)
    tomorrow.setDate(tomorrow.getDate() + 1)
    expect(computeNextRun({ kind: 'cron', expr: `30 ${Number(row.repeatedHour)} * * *` }, null, from)).toBe(tomorrow.toISOString())
  })

  it('lists the spring gap date for fixed-hour cron', () => {
    process.env.TZ = row.zone
    const dates = skippedDates({ kind: 'cron', expr: '30 2 * * *' }, at(row.spring, '00:00', row.springOffset), 2)
    expect(dates.map((entry) => entry.date)).toEqual([row.spring])
  })

  it('still lists the spring gap date for hourly cron', () => {
    process.env.TZ = row.zone
    const dates = skippedDates({ kind: 'cron', expr: '30 * * * *' }, at(row.spring, '00:00', row.springOffset), 2)
    expect(dates.map((entry) => entry.date)).toEqual([row.spring])
  })

  it('keeps elapsed intervals and skips the repeated pass for hourly cron', () => {
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

// Santiago repeats the preceding day's 23:00; Havana repeats 00:00 on the transition day.
const midnightFolds = [
  {
    zone: 'America/Santiago', hour: 23, before: '2026-04-04T22:00:00-03:00',
    first: '2026-04-04T23:30:00-03:00', second: '2026-04-04T23:10:00-04:00',
    dailyNext: '2026-04-05T23:30:00-04:00', hourlyNext: '2026-04-05T00:30:00-04:00',
    lastFive: '2026-04-04T23:55:00-03:00', fiveNext: '2026-04-05T00:00:00-04:00'
  },
  {
    zone: 'America/Havana', hour: 0, before: '2026-10-31T23:00:00-04:00',
    first: '2026-11-01T00:30:00-04:00', second: '2026-11-01T00:10:00-05:00',
    dailyNext: '2026-11-02T00:30:00-05:00', hourlyNext: '2026-11-01T01:30:00-05:00',
    lastFive: '2026-11-01T00:55:00-04:00', fiveNext: '2026-11-01T01:00:00-05:00'
  }
]

describe.each(midnightFolds)('a repeated hour at the date boundary in $zone', (row) => {
  it('runs a daily time once and advances to the right calendar day', () => {
    process.env.TZ = row.zone
    const schedule = { kind: 'cron', expr: `30 ${row.hour} * * *` } as const
    expect(computeNextRun(schedule, null, new Date(row.before))).toBe(new Date(row.first).toISOString())
    expect(computeNextRun(schedule, row.first)).toBe(new Date(row.dailyNext).toISOString())
    expect(occurrencesSince(schedule, row.first, new Date(row.second))).toBe(1)
  })

  it('never returns a past daily time when searched inside the second hour', () => {
    process.env.TZ = row.zone
    expect(computeNextRun({ kind: 'cron', expr: `30 ${row.hour} * * *` }, null, new Date(row.second))).toBe(new Date(row.dailyNext).toISOString())
  })

  it('skips the second pass for hourly and five-minute cron too', () => {
    process.env.TZ = row.zone
    for (const [expr, from, next] of [
      ['30 * * * *', row.first, row.hourlyNext],
      ['*/5 * * * *', row.lastFive, row.fiveNext]
    ]) {
      expect(computeNextRun({ kind: 'cron', expr: expr! }, from), `${expr} from ${from}`).toBe(new Date(next!).toISOString())
    }
  })

  it('never returns past hourly or five-minute times inside the second pass', () => {
    process.env.TZ = row.zone
    for (const [expr, next] of [['30 * * * *', row.hourlyNext], ['*/5 * * * *', row.fiveNext]]) {
      expect(computeNextRun({ kind: 'cron', expr: expr! }, null, new Date(row.second)), expr).toBe(new Date(next!).toISOString())
    }
  })
})
