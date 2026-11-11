/** How a bot chat's messages group: one sender, ten minutes apart at most, the same day (messageGroups.ts). */
import { describe, expect, it } from 'vitest'
import { GROUP_GAP_MS, botDayLabel, botGroupTime, botMessageLabel, placeMessages } from '../../src/renderer/components/bots/messageGroups'

describe('labels', () => {
  it('labels a reminder and a work report, and nothing else', () => {
    expect(botMessageLabel({ id: 'bm_rem_1a2b', kind: 'run_report', author: 'bot' })).toBe('Reminder')
    expect(botMessageLabel({ id: 'bm_act_9_report', kind: 'run_report', author: 'bot' })).toBe('Work report')
    expect(botMessageLabel({ id: 'bm_rem_1a2b', kind: 'text', author: 'bot' })).toBeUndefined()
    expect(botMessageLabel({ id: 'm1', kind: 'notice', author: 'bot' })).toBeUndefined()
    expect(botMessageLabel({ id: 'm2', kind: 'run_report', author: 'owner' })).toBeUndefined()
  })
})

const now = new Date(2026, 10, 11, 15, 0)
const at = (day: number, hours: number, minutes: number, seconds = 0) => new Date(2026, 10, day, hours, minutes, seconds).toISOString()
const owner = (when: string) => ({ author: 'owner', at: when })
const bot = (when: string) => ({ author: 'bot', at: when })
/** Each message's place as `[starts, ends]`. */
const shape = (messages: Array<{ author: string; at: string }>) => placeMessages(messages, now).map((place) => [place.starts, place.ends])

describe('groups', () => {
  it('keeps one sender together up to ten minutes apart, across minute changes, and breaks after', () => {
    expect(GROUP_GAP_MS).toBe(10 * 60_000)
    expect(shape([owner(at(11, 11, 27)), owner(at(11, 11, 28)), owner(at(11, 11, 38)), owner(at(11, 11, 48, 1))])).toEqual([
      [true, false], [false, false], [false, true], [true, true]
    ])
  })

  it('breaks on a change of sender, either way', () => {
    expect(shape([owner(at(11, 11, 27)), owner(at(11, 11, 27)), bot(at(11, 11, 27)), bot(at(11, 11, 27)), owner(at(11, 11, 28))])).toEqual([
      [true, false], [false, true], [true, false], [false, true], [true, true]
    ])
  })

  it('breaks at midnight and puts a day line on the first message of each day', () => {
    const places = placeMessages([bot(at(9, 23, 58)), bot(at(10, 0, 1)), bot(at(10, 0, 2)), owner(at(11, 9, 0))], now)
    expect(places.map((place) => [place.starts, place.ends])).toEqual([[true, true], [true, false], [false, true], [true, true]])
    expect(places.map((place) => place.day)).toEqual([botDayLabel(at(9, 23, 58), now), 'Yesterday', undefined, 'Today'])
  })

  it('starts a group on a message with no readable time, and keeps the day for the next', () => {
    const places = placeMessages([owner(at(11, 9, 0)), owner('not a time'), owner(at(11, 9, 1))], now)
    expect(places.map((place) => [place.starts, place.day])).toEqual([[true, 'Today'], [true, undefined], [true, undefined]])
  })

  it('places nothing for no messages', () => {
    expect(placeMessages([], now)).toEqual([])
  })
})

describe('day lines', () => {
  it('says Today, Yesterday, the date, and the year only for another year', () => {
    expect(botDayLabel(at(11, 0, 5), now)).toBe('Today')
    expect(botDayLabel(at(10, 23, 59), now)).toBe('Yesterday')
    expect(botDayLabel(at(3, 12, 0), now)).toBe(new Date(2026, 10, 3).toLocaleDateString([], { day: 'numeric', month: 'short' }))
    expect(botDayLabel(new Date(2025, 10, 3).toISOString(), now)).toContain('2025')
    expect(botDayLabel('nope', now)).toBe('')
  })
})

describe('group times', () => {
  it('writes the hour without a leading zero, and nothing for no readable time', () => {
    expect(botGroupTime(at(11, 13, 59), 'en-US')).toMatch(/^1:59\sPM$/u)
    expect(botGroupTime(at(11, 9, 5), 'en-US')).toMatch(/^9:05\sAM$/u)
    expect(botGroupTime(at(11, 13, 59), 'en-GB')).toBe('13:59')
    expect(botGroupTime('nope')).toBe('')
  })
})
