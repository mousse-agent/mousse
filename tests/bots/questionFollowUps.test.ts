/**
 * The rules that decide a question's follow-up (issue #1123), at the modules that decide them: what `ask_owner`'s
 * `ifNoAnswer`, `after` and `default` mean (`questionFollowOf`), the owner's quiet hours (22:00 to 08:00 in their time
 * zone, across a clock change), and a bot's nudge budget (one an hour, three in any 24 hours), as rows.
 */
import { describe, expect, it } from 'vitest'
import { afterQuietHours, nudgeSlot } from '../../src/mms/bots/activation/questionFollowUps'
import { questionFollowOf } from '../../src/shared/bots/personal/questions'

const SPEC = { choices: [{ label: 'Flat A' }, { label: 'Flat B' }] }
const MIN = 60_000
const HOUR = 60 * MIN

describe('ask_owner’s follow-up (questionFollowOf)', () => {
  it.each([
    ['nothing named: a nudge after an hour', {}, { kind: 'nudge', afterMs: 60 * MIN }],
    ['a nudge after 15 minutes, the shortest', { ifNoAnswer: 'nudge', after: 15 }, { kind: 'nudge', afterMs: 15 * MIN }],
    ['a default after half an hour, its label as the choice is written', { ifNoAnswer: 'default', default: 'flat a' }, { kind: 'default', afterMs: 30 * MIN, default: 'Flat A' }],
    ['a default named alone is a default', { default: 'Flat B', after: 45 }, { kind: 'default', afterMs: 45 * MIN, default: 'Flat B' }],
    ['a day, the longest', { ifNoAnswer: 'nudge', after: 1440 }, { kind: 'nudge', afterMs: 1440 * MIN }]
  ])('%s', (_name, args, follow) => {
    expect(questionFollowOf(args, SPEC)).toEqual(follow)
  })

  it.each([
    ['a default with no choice to go with', { ifNoAnswer: 'default' }],
    ['a default that is not one of the choices', { ifNoAnswer: 'default', default: 'Flat C' }],
    ['a default with a nudge', { ifNoAnswer: 'nudge', default: 'Flat A' }],
    ['under 15 minutes', { ifNoAnswer: 'default', default: 'Flat A', after: 10 }],
    ['over a day', { after: 1441 }],
    ['after that is not a number', { after: '30' }],
    ['an unknown follow-up', { ifNoAnswer: 'later' }]
  ])('refuses %s, saying what to fix', (_name, args) => {
    expect(questionFollowOf(args, SPEC)).toEqual({ problem: expect.any(String) })
  })
})

describe('quiet hours (afterQuietHours)', () => {
  it.each([
    ['UTC', '2026-11-07T21:59:00Z', '2026-11-07T21:59:00Z'],
    ['UTC', '2026-11-07T22:00:00Z', '2026-11-08T08:00:00Z'],
    ['UTC', '2026-11-08T03:10:00Z', '2026-11-08T08:00:00Z'],
    ['UTC', '2026-11-08T08:00:00Z', '2026-11-08T08:00:00Z'],
    // 22:30 in India is the next morning's 08:00 there.
    ['Asia/Kolkata', '2026-11-07T17:00:00Z', '2026-11-08T02:30:00Z'],
    ['Asia/Kolkata', '2026-11-07T16:29:00Z', '2026-11-07T16:29:00Z'],
    // New York's clocks go back at 02:00 on 1 November 2026: 23:00 EDT the night before is followed by 08:00 EST.
    ['America/New_York', '2026-11-01T03:00:00Z', '2026-11-01T13:00:00Z']
  ])('%s %s → %s', (zone, at, expected) => {
    expect(new Date(afterQuietHours(Date.parse(at), zone)).toISOString()).toBe(new Date(expected).toISOString())
  })
})

describe('a bot’s nudge budget (nudgeSlot)', () => {
  const at = Date.parse('2026-11-07T12:00:00Z')
  it.each([
    ['none before: now', [], at],
    ['one half an hour ago: an hour after it', [at - 30 * MIN], at + 30 * MIN],
    ['one an hour ago: now', [at - HOUR], at],
    ['three in the last day: once the oldest is a day old', [at - 20 * HOUR, at - 10 * HOUR, at - 2 * HOUR], at + 4 * HOUR],
    ['two in the last day: now', [at - 20 * HOUR, at - 2 * HOUR], at],
    ['a free time at night: the morning', [at - 14 * HOUR, at - 10 * HOUR, at - 2 * HOUR], Date.parse('2026-11-08T08:00:00Z')]
  ])('%s', (_name, nudges, expected) => {
    expect(nudgeSlot(at, nudges, 'UTC')).toBe(expected)
  })
})
