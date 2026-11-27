/**
 * The rules that decide a question's follow-up (issue #1123), at the modules that decide them: what `question_ask`'s
 * `ifNoAnswer`, `after` and `default` mean (`questionFollowOf`), and a bot's nudge budget (one an hour, three in any 24
 * hours), as rows.
 */
import { describe, expect, it } from 'vitest'
import { nudgeSlot } from '../../src/mms/bots/activation/questionFollowUps'
import { questionFollowOf } from '../../src/shared/bots/personal/questions'

const SPEC = { choices: [{ label: 'Flat A' }, { label: 'Flat B' }] }
const MIN = 60_000
const HOUR = 60 * MIN

describe('question_ask’s follow-up (questionFollowOf)', () => {
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

describe('a bot’s nudge budget (nudgeSlot)', () => {
  const at = Date.parse('2026-11-07T12:00:00Z')
  it.each([
    ['none before: now', [], at],
    ['one half an hour ago: an hour after it', [at - 30 * MIN], at + 30 * MIN],
    ['one an hour ago: now', [at - HOUR], at],
    ['three in the last day: once the oldest is a day old', [at - 20 * HOUR, at - 10 * HOUR, at - 2 * HOUR], at + 4 * HOUR],
    ['two in the last day: now', [at - 20 * HOUR, at - 2 * HOUR], at],
    // The clock was set back: a nudge "posted" after now still counts, in the hour and in the day.
    ['one posted half an hour from now: an hour after it', [at + 30 * MIN], at + 90 * MIN],
    ['three in the day, one of them from later: once the oldest is a day old', [at - 20 * HOUR, at - 3 * HOUR, at + 2 * HOUR], at + 4 * HOUR]
  ])('%s', (_name, nudges, expected) => {
    expect(nudgeSlot(at, nudges)).toBe(expected)
  })
})
