/**
 * Bot Phase 1 §5.5: schedules in words, shared by the Scheduled panel and bots. The panel's labels
 * are unchanged by the move; bots get their own lower-case form for chips and About.
 */
import { describe, expect, it } from 'vitest'
import * as renderer from '../src/renderer/components/scheduled/scheduledLabels'
import { botScheduleLabel, clockText, describeSchedule, humanCron, parseSimpleCron } from '../src/shared/scheduleLabel'

describe('botScheduleLabel', () => {
  it('words the simple cron forms with a 24-hour time', () => {
    expect(botScheduleLabel({ kind: 'cron', expr: '0 9 * * 1-5' })).toBe('every weekday · 09:00')
    expect(botScheduleLabel({ kind: 'cron', expr: '30 8 * * 1' })).toBe('every Monday · 08:30')
    expect(botScheduleLabel({ kind: 'cron', expr: '0 18 * * *' })).toBe('every day · 18:00')
    expect(botScheduleLabel({ kind: 'cron', expr: '0 10 * * 0,6' })).toBe('every weekend · 10:00')
    expect(botScheduleLabel({ kind: 'cron', expr: '0 7 * * 1,3,5' })).toBe('Mon, Wed, Fri · 07:00')
    expect(botScheduleLabel({ kind: 'cron', expr: '*/15 * * * *' })).toBe('every 15 minutes')
    expect(botScheduleLabel({ kind: 'cron', expr: '15 */2 * * *' })).toBe('every 2 hours · :15')
    expect(botScheduleLabel({ kind: 'cron', expr: '0 9 1 * *' })).toBe('on a custom schedule')
  })

  it('words intervals', () => {
    expect(botScheduleLabel({ kind: 'interval', minutes: 30 })).toBe('every 30 minutes')
    expect(botScheduleLabel({ kind: 'interval', minutes: 60 })).toBe('every hour')
    expect(botScheduleLabel({ kind: 'interval', minutes: 180 })).toBe('every 3 hours')
    expect(botScheduleLabel({ kind: 'interval', minutes: 1440 })).toBe('every day')
    expect(botScheduleLabel({ kind: 'interval', minutes: 90 })).toBe('every 90 minutes')
  })

  it('takes the locale it is given for the time of day', () => {
    expect(botScheduleLabel({ kind: 'cron', expr: '0 9 * * 1-5' }, 'en-US')).toMatch(/^every weekday · 09:00\s?AM$/)
  })
})

describe('the shared Scheduled-panel labels', () => {
  it('are the ones the renderer re-exports, with the same words as before', () => {
    expect(renderer.describeSchedule).toBe(describeSchedule)
    expect(renderer.humanCron).toBe(humanCron)
    expect(renderer.parseSimpleCron).toBe(parseSimpleCron)
    expect(humanCron('0 9 * * 1-5')).toBe(`Weekdays at ${clockText(9, 0)}`)
    expect(describeSchedule({ kind: 'interval', minutes: 30 })).toBe('Every 30 min')
    expect(describeSchedule({ kind: 'manual' })).toBe('Only when run')
  })

  it('pass the locale through', () => {
    expect(clockText(14, 5, 'en-GB')).toBe('14:05')
    expect(humanCron('0 14 * * *', true, 'en-GB')).toBe('Every day at 14:00')
  })
})
