import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as scheduleTimes from '../../src/mms/scheduled/computeNextRun'
import { clockTime } from '../../src/mms/bots/chat/projection'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { ScheduledJobService } from '../../src/mms/scheduled/ScheduledJobService'
import { ScheduledJobStore, recordTickerHeartbeat } from '../../src/mms/scheduled/ScheduledJobStore'
import { botFixture, chatOf, createBot, flush, runDispatch, T0, type BotFixture } from './botFixture'

const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
let f: BotFixture
let botId: string

beforeEach(async () => {
  f = botFixture()
  ;({ botId } = await createBot(f))
})
afterEach(() => { vi.restoreAllMocks(); f.close() })

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
  it.each([1, 366])('an every-minute cron after %i days away searches only a short window', async (days) => {
    const now = T0 + 4000
    f.clock.now = T0 - days * 1440 * MIN
    f.bots.addSchedule(botId, { when: { kind: 'cron', expr: '* * * * *' }, prompt: 'Check.' }, 'owner')
    await f.bots.reconcileOnStartup()
    heartbeat(f.clock.now)
    let steps = 0
    const compute = scheduleTimes.computeNextRun
    vi.spyOn(scheduleTimes, 'computeNextRun').mockImplementation((...args) => {
      if (++steps > 80) throw new Error('cron search exceeded its step budget')
      return compute(...args)
    })
    const { inserted } = await f.tickSchedules(new Date(now))
    expect(steps).toBeLessThanOrEqual(65)
    expect(inserted).toHaveLength(1)
    expect(f.store.activation(inserted[0]!)!.trigger).toMatchObject({ occurrenceAt: iso(T0) })
    expect(f.store.dispatch(inserted[0]!, 1)!.prompt.text).toContain('over 999 runs were skipped.')
  })

  it('a sparse cron with a dense old burst also searches only a short window', async () => {
    f.clock.now = new Date(2020, 0, 1).getTime()
    f.bots.addSchedule(botId, { when: { kind: 'cron', expr: '* * 1 1 *' }, prompt: 'Check.' }, 'owner')
    await f.bots.reconcileOnStartup()
    heartbeat(f.clock.now)
    let steps = 0
    const compute = scheduleTimes.computeNextRun
    vi.spyOn(scheduleTimes, 'computeNextRun').mockImplementation((...args) => {
      if (++steps > 100) throw new Error('cron search exceeded its step budget')
      return compute(...args)
    })
    await f.tickSchedules(new Date(2026, 10, 7))
    expect(steps).toBeLessThanOrEqual(90)
    expect(entry().skip).toEqual({ at: new Date(2026, 0, 1, 23, 59).toISOString(), reason: 'Missed Thu 23:59 (computer off)' })
  })

  it.each([70, 100])('retrying an unfinished claim %i minutes late records the original run as started', async (late) => {
    const due = await schedule()
    heartbeat(T0)
    const store = new ScheduledJobStore(MousseConfigStore.load(join(f.base, 'mousse-home')))
    const fresh = new ScheduledJobService({ runIsolated: async () => { throw new Error('not an agent job') } }, store)
    fresh.setClock(() => new Date(f.clock.now))
    fresh.setBotRunner({ findOccurrence: (input) => f.bots.findScheduledOccurrence(input), runOccurrence: (input) => f.bots.runScheduledOccurrence(input) })
    // Crash window: the bot inserted the run but the scheduler never finished its claim.
    vi.spyOn(store, 'finishBotClaim').mockReturnValueOnce(null)
    try {
      f.clock.now = due + 10 * MIN
      await fresh.tickNow()
      await f.bots.maintain(new Date(f.clock.now))
      await flush()
      const first = f.store.listActivations(botId).find((row) => row.trigger.kind === 'schedule')!
      if (late === 70) await runDispatch(f, first.id, 1, { text: 'Finished.' })
      const claim = store.getJob(entry().jobId)!.runClaim!
      expect(claim.occurrenceKey).toBe(iso(due))
      expect(store.releaseClaim(entry().jobId, claim.token)).not.toBeNull()
      f.clock.now = due + late * MIN
      await fresh.tickNow()
      await f.bots.maintain(new Date(f.clock.now))
      await flush()
      expect(f.store.listActivations(botId).filter((row) => row.trigger.kind === 'schedule').map((row) => row.id)).toEqual([first.id])
      expect(first.idempotencyKey).toBe(`sched:${botId}:${entry().scheduleId}:${iso(due)}`)
      expect(store.getJob(entry().jobId)).toMatchObject({ state: 'scheduled', lastRunAt: iso(due), lastStatus: 'ok' })
      expect(entry().skip).toBeUndefined()
      if (late === 100) {
        expect(f.store.activation(first.id)!.status).toBe('running')
        await runDispatch(f, first.id, 1, { text: 'Finished after the retry.' })
        expect(chatOf(f, botId).find((row) => row.kind === 'run_report' && row.activationId === first.id)!.text).toContain('Finished after the retry.')
        expect(entry().skip).toBeUndefined()
      }
    } finally { fresh.beginShutdown() }
  })

  it('passes the due time and missed counts into the saved trigger and the model request', async () => {
    const due = await schedule()
    heartbeat(T0)
    const { inserted } = await f.tickSchedules(new Date(due + 10 * MIN))
    expect(inserted).toHaveLength(1)
    expect(f.store.activation(inserted[0]!)!.trigger).toMatchObject({ occurrenceAt: iso(due), missed: { count: 1, since: iso(due) } })
    expect(f.store.dispatch(inserted[0]!, 1)!.prompt.text).toContain(`This run was due at ${clockTime(iso(due))}; this computer was off or asleep.`)
  })

  // Claims must collapse to the latest occurrence: Sat/Sun are skipped, Monday is still useful.
  it.each([[9, 30, true], [22, 0, false]])('after Friday off, Monday %i:%i runs %s', async (hour, minute, runs) => {
    f.clock.now = new Date(2026, 10, 6, 18).getTime()
    f.bots.addSchedule(botId, { when: { kind: 'cron', expr: '0 9 * * *' }, prompt: 'Morning briefing.' }, 'owner')
    await f.bots.reconcileOnStartup()
    heartbeat(f.clock.now)
    const due = new Date(2026, 10, 9, 9).toISOString()
    const { inserted } = await f.tickSchedules(new Date(2026, 10, 9, hour, minute))
    expect(inserted).toHaveLength(runs ? 1 : 0)
    if (runs) {
      expect(f.store.activation(inserted[0]!)!.trigger).toMatchObject({ occurrenceAt: due, missed: { count: 3, since: new Date(2026, 10, 7, 9).toISOString() } })
      expect(f.store.dispatch(inserted[0]!, 1)!.prompt.text).toContain('This run was due at 09:00; this computer was off or asleep, and 2 runs were skipped.')
      await runDispatch(f, inserted[0]!, 1, { text: 'Briefing.' })
      expect(chatOf(f, botId).find((row) => row.kind === 'run_report')!.text).toBe('(Due 09:00, this computer was off or asleep) Briefing.')
    } else expect(entry().skip).toEqual({ at: due, reason: 'Missed Mon 09:00 (computer off)' })
    expect(entry().nextAt).toBe(new Date(2026, 10, 10, 9).toISOString())
  })

  it('an hourly schedule after two hours off uses the latest hour', async () => {
    const first = await schedule()
    heartbeat(T0)
    const { inserted } = await f.tickSchedules(new Date(first + 80 * MIN))
    expect(inserted).toHaveLength(1)
    expect(f.store.activation(inserted[0]!)!.trigger).toMatchObject({ occurrenceAt: iso(first + 60 * MIN), missed: { count: 2, since: iso(first) } })
    expect(f.store.dispatch(inserted[0]!, 1)!.prompt.text).toContain(`This run was due at ${clockTime(iso(first + 60 * MIN))}; this computer was off or asleep, and 1 run was skipped.`)
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

  it('names the missed time when a caught-up run starts, and the day when it reports', async () => {
    const due = await schedule()
    heartbeat(T0)
    const { inserted } = await f.tickSchedules(new Date(due + 10 * MIN))
    await flush()
    // The run starts at once (#1452), the same day, so the prompt names the time only; a report written the next day names the day.
    expect(f.store.dispatch(inserted[0]!, 1)!.prompt.text).toContain(`This run was due at ${clockTime(iso(due))}; this computer was off or asleep.`)
    f.clock.now = due + 1440 * MIN
    const label = `${new Date(due).toLocaleDateString('en-US', { weekday: 'short' })} ${clockTime(iso(due))}`
    await runDispatch(f, inserted[0]!, 1, { text: 'All checked.' })
    expect(chatOf(f, botId).find((row) => row.kind === 'run_report' && row.activationId === inserted[0])!.text).toBe(`(Due ${label}, this computer was off or asleep) All checked.`)
  })

  it.each([11, 780])('a restart before bots are ready keeps downtime at %i minutes late', async (late) => {
    const due = await schedule(1440)
    heartbeat(T0)
    f.scheduler.setBotRunner({ findOccurrence: () => undefined, runOccurrence: () => ({ kind: 'not_ready' }) })
    await f.tickSchedules(new Date(due + 10 * MIN))
    expect(entry().nextAt).toBe(iso(due))
    // Other ticks may have run while bots were unavailable; restart immediately after one.
    heartbeat(due + (late - 1) * MIN)
    const fresh = new ScheduledJobService({ runIsolated: async () => { throw new Error('not an agent job') } }, new ScheduledJobStore(MousseConfigStore.load(join(f.base, 'mousse-home'))))
    f.clock.now = due + late * MIN
    fresh.setClock(() => new Date(f.clock.now))
    fresh.setBotRunner({ findOccurrence: (input) => f.bots.findScheduledOccurrence(input), runOccurrence: (input) => f.bots.runScheduledOccurrence(input) })
    try {
      await fresh.tickNow()
      await f.bots.maintain(new Date(f.clock.now))
      await flush()
      if (late < 720) {
        const row = f.store.listActivations(botId).find((row) => row.trigger.kind === 'schedule')!
        expect(row.trigger).toMatchObject({ missed: { count: 1, since: iso(due) } })
        expect(f.store.dispatch(row.id, 1)!.prompt.text).toContain('this computer was off or asleep.')
      } else {
        expect(f.store.listActivations(botId).filter((row) => row.trigger.kind === 'schedule')).toEqual([])
        expect(entry().skip?.at).toBe(iso(due))
        expect(entry().skip?.reason).toContain('(computer off)')
      }
    } finally { fresh.beginShutdown() }
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
    [5, 720, true, true], [5, 722.5, true, false], [5, 720, false, true]
  ])('every %i minutes, %i minutes late, downtime %s: runs %s', async (minutes, late, offline, runs) => {
    const due = await schedule(minutes)
    heartbeat(offline ? T0 : due + (late - 1) * MIN)
    f.store.bumpFailureStreak(botId)
    f.store.bumpFailureStreak(botId)
    const registry = f.store.registry(botId)!
    const { inserted } = await f.tickSchedules(new Date(due + late * MIN))
    expect(inserted).toHaveLength(runs ? 1 : 0)
    if (!runs) {
      const latest = due + Math.floor(late / minutes) * minutes * MIN
      const day = new Date(latest).toLocaleDateString('en-US', { weekday: 'short' })
      expect(entry().skip).toEqual({ at: iso(latest), reason: `Missed ${day} ${clockTime(iso(latest))} (computer off)` })
      expect(f.bots.get(botId).summary.schedules![0]!.skipped).toEqual(entry().skip)
      expect(f.scheduler.getJob(entry().jobId)).toMatchObject({ state: 'scheduled', runHistory: [] })
      expect(f.store.registry(botId)).toMatchObject({ failureStreak: registry.failureStreak, pausedReason: registry.pausedReason })
    }
    expect(Date.parse(entry().nextAt!)).toBeGreaterThan(due + late * MIN)
  })
})
