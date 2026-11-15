import { expect, it } from 'vitest'
import { OwnerQuietHours } from '../src/mms/notifications/OwnerQuietHours'
// Inputs: absent, daytime, midnight-spanning, device zone, spring gap, autumn overlap, activity expiry.
it.each([
  ['UTC', '2026-11-07T23:00:00Z', '08:00', '2026-11-08T08:00:00.000Z'],
  ['Asia/Kolkata', '2026-11-07T20:00:00Z', '08:00', '2026-11-08T02:30:00.000Z'],
  ['America/New_York', '2026-03-08T06:00:00Z', '03:30', '2026-03-08T07:30:00.000Z'],
  ['America/New_York', '2026-03-08T06:00:00Z', '02:30', '2026-03-08T07:00:00.000Z'],
  ['America/New_York', '2026-11-01T04:00:00Z', '08:00', '2026-11-01T13:00:00.000Z']
])('ends quiet hours in %s across clock changes', (zone, at, to, end) => {
  const q = new OwnerQuietHours(() => ({ from: '22:00', to }), () => Date.parse(at), () => zone)
  expect(q.quietHoursFor()?.end).toBe(Date.parse(end))
})
it('is off unless set and follows the last device only until restart', () => {
  let setting: { from: string; to: string } | undefined
  let now = Date.parse('2026-11-07T20:00:00Z')
  const q = new OwnerQuietHours(() => setting, () => now, () => 'UTC')
  expect(q.quietHoursFor()).toBeUndefined()
  setting = { from: '22:00', to: '08:00' }
  expect(q.quietHoursFor()).toBeUndefined()
  q.report(now, 'Asia/Kolkata')
  expect(q.ownerZone()).toBe('Asia/Kolkata')
  expect(q.quietHoursFor()?.end).toBe(Date.parse('2026-11-08T02:30:00Z'))
  expect(q.active()).toBe(true)
  now += 15 * 60_000
  expect(q.active()).toBe(false)
  expect(new OwnerQuietHours(() => setting, () => now, () => 'UTC').ownerZone()).toBe('UTC')
})

it('handles a same-day interval and both boundaries', () => {
  const q = new OwnerQuietHours(() => ({ from: '09:00', to: '17:00' }), Date.now, () => 'UTC')
  expect(q.quietHoursFor(undefined, Date.parse('2026-11-08T08:59:59Z'))).toBeUndefined()
  expect(q.quietHoursFor(undefined, Date.parse('2026-11-08T09:00:00Z'))?.end).toBe(Date.parse('2026-11-08T17:00:00Z'))
  expect(q.quietHoursFor(undefined, Date.parse('2026-11-08T17:00:00Z'))).toBeUndefined()
})
