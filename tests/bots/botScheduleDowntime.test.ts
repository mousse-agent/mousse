import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clockTime } from '../../src/mms/bots/chat/projection'
import { recordTickerHeartbeat } from '../../src/mms/scheduled/ScheduledJobStore'
import { botFixture, chatOf, createBot, flush, runDispatch, T0, type BotFixture } from './botFixture'

const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
let f: BotFixture
let botId: string

beforeEach(async () => {
  f = botFixture()
  ;({ botId } = await createBot(f))
})
afterEach(() => f.close())

async function schedule(minutes = 60) {
  f.bots.addSchedule(botId, { when: { kind: 'interval', minutes }, prompt: 'Check the site.' }, 'owner')
  await f.bots.reconcileOnStartup()
  return T0 + minutes * MIN
}
function heartbeat(at: number) {
  recordTickerHeartbeat(false, join(f.base, 'mousse-home'), new Date(at))
}
const entry = () => f.book.list(botId)[0]!

describe('bot schedules after downtime', () => {
  it('passes the due time and missed counts into the saved trigger and the model request', async () => {
    const due = await schedule()
    heartbeat(T0)
    const { inserted } = await f.tickSchedules(new Date(due + 10 * MIN))
    expect(inserted).toHaveLength(1)
    expect(f.store.activation(inserted[0]!)!.trigger).toMatchObject({ occurrenceAt: iso(due), missed: { count: 1, since: iso(due) } })
    expect(f.store.dispatch(inserted[0]!, 1)!.prompt.text).toContain(`This run was due at ${clockTime(iso(due))}; this computer was off or asleep, and 0 runs were skipped.`)
  })

  it('counts the repeats skipped apart from the occurrence being run', async () => {
    const due = await schedule()
    const result = f.bots.runScheduledOccurrence({ botId, scheduleId: entry().scheduleId, prompt: 'Check the site.', occurrenceAt: iso(due), missed: { count: 4, since: iso(due) } })
    expect(result.kind).toBe('started')
    if (result.kind !== 'started') throw new Error('run did not start')
    await f.bots.maintain(new Date(due))
    await flush()
    expect(f.store.dispatch(result.activationId, 1)!.prompt.text).toContain('3 runs were skipped.')
  })

  it.each([[15, true], [21, false], [22, false]])('a daily 09:00 schedule at %i:00 runs %s', async (hour, runs) => {
    f.clock.now = new Date(2026, 10, 10, 8).getTime()
    f.bots.addSchedule(botId, { when: { kind: 'cron', expr: '0 9 * * *' }, prompt: 'Morning briefing.' }, 'owner')
    await f.bots.reconcileOnStartup()
    const due = new Date(2026, 10, 10, 9).getTime()
    heartbeat(f.clock.now)
    expect((await f.tickSchedules(new Date(2026, 10, 10, hour))).inserted).toHaveLength(runs ? 1 : 0)
    expect(entry().nextAt).toBe(new Date(2026, 10, 11, 9).toISOString())
    if (!runs) expect(entry().skip).toEqual({ at: iso(due), reason: 'Missed Tue 09:00 (computer off)' })
  })

  // Posting time, rather than start time, decides the label. A busy tick has no downtime marker.
  it.each([
    [15 * MIN - 1, true, false],
    [15 * MIN, true, false],
    [15 * MIN + 1, true, true],
    [20 * MIN, false, false]
  ])('report after %i ms, downtime %s, labelled %s', async (delay, offline, labelled) => {
    const due = await schedule()
    heartbeat(offline ? T0 : due + 5 * MIN)
    const { inserted } = await f.tickSchedules(new Date(due + 6 * MIN))
    f.clock.now = due + delay
    await runDispatch(f, inserted[0]!, 1, { text: 'All checked.' })
    const report = chatOf(f, botId).find((row) => row.kind === 'run_report')!
    expect(report.text).toBe(`${labelled ? `(Due ${clockTime(iso(due))}, this computer was off or asleep) ` : ''}All checked.`)
  })

  // Daily and hourly: before, at, after midpoint. Five-minute: a night away, and a load delay control.
  it.each([
    [1440, 360, true, true], [1440, 720, true, false], [1440, 780, true, false],
    [60, 29, true, true], [60, 30, true, false], [60, 31, true, false],
    [5, 720, true, false], [5, 720, false, true]
  ])('every %i minutes, %i minutes late, downtime %s: runs %s', async (minutes, late, offline, runs) => {
    const due = await schedule(minutes)
    heartbeat(offline ? T0 : due + (late - 1) * MIN)
    f.store.bumpFailureStreak(botId)
    f.store.bumpFailureStreak(botId)
    const registry = f.store.registry(botId)!
    const { inserted } = await f.tickSchedules(new Date(due + late * MIN))
    expect(inserted).toHaveLength(runs ? 1 : 0)
    if (!runs) {
      const day = new Date(due).toLocaleDateString('en-US', { weekday: 'short' })
      expect(entry().skip).toEqual({ at: iso(due), reason: `Missed ${day} ${clockTime(iso(due))} (computer off)` })
      expect(f.bots.get(botId).summary.schedules![0]!.skipped).toEqual(entry().skip)
      expect(f.scheduler.getJob(entry().jobId)).toMatchObject({ state: 'scheduled', runHistory: [] })
      expect(f.store.registry(botId)).toMatchObject({ failureStreak: registry.failureStreak, pausedReason: registry.pausedReason })
    }
    expect(Date.parse(entry().nextAt!)).toBeGreaterThan(due + late * MIN)
  })
})
