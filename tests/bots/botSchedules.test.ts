/**
 * Path step 3, "One scheduler": a bot's schedules are automations whose Who is the bot, in the shared scheduled-job
 * store, and the one `ScheduledJobService` claims their occurrences. Each due occurrence is one run activation keyed
 * `sched:<botId>:<scheduleId>:<occurrenceAt>`, so a repeated hand-over (after a crash) inserts nothing. The bot keeps
 * its own rules: skipped while it is paused or its last run of the schedule still waits, at most 8, at most every
 * 5 minutes, missed occurrences collapse into one, and nothing runs before the bot startup pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOT_RUN_REPORT_LINE } from '../../src/mms/bots/memory/contextPack'
import { botJobId, botScheduleProblem, scheduleProblem } from '../../src/mms/scheduled/botJobs'
import { nextOccurrenceAfter } from '../../src/mms/scheduled/computeNextRun'
import { botFixture, createBot, flush, runDispatch, T0, type BotFixture } from './botFixture'

const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

let f: BotFixture
let botId: string

beforeEach(async () => {
  f = botFixture()
  ;({ botId } = await createBot(f, { name: 'Site editor', reply: 'Hi.' }))
})

afterEach(() => {
  vi.restoreAllMocks()
  f.close()
})

/** A schedule every 5 minutes, after the startup pass. */
async function scheduled(prompt = 'Tidy the site.', minutes = 5): Promise<string> {
  const { scheduleId } = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes }, prompt }, 'owner')
  await f.bots.reconcileOnStartup()
  return scheduleId
}

const runs = () => f.store.listActivations(botId).filter((row) => row.lane === 'run').sort((a, b) => occurrence(a).localeCompare(occurrence(b)))
const occurrence = (row: { trigger: { kind: string } }) => ('occurrenceAt' in row.trigger ? String(row.trigger.occurrenceAt) : '')
const entry = () => f.book.list(botId)[0]!

describe('bot schedules in the shared scheduler', () => {
  it('nothing runs before the startup pass, and a new schedule starts from now', async () => {
    const { scheduleId } = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Tidy the site.' }, 'owner')
    expect(entry()).toMatchObject({ scheduleId, nextAt: iso(T0 + 5 * MIN), createdBy: 'owner', tellMe: 'news' })
    // The record is an ordinary job, whose Who is the bot.
    expect(f.scheduler.getJob(botJobId(botId, scheduleId))).toMatchObject({ bot: { botId, scheduleId, createdBy: 'owner' }, prompt: 'Tidy the site.', schedule: { kind: 'interval', minutes: 5 } })
    // Before the pass the occurrence stays due: nothing is inserted and the time does not move.
    expect((await f.tickSchedules(new Date(T0 + 60 * MIN))).inserted).toEqual([])
    expect(entry().nextAt).toBe(iso(T0 + 5 * MIN))
    await f.bots.reconcileOnStartup()
    expect((await f.tickSchedules(new Date(T0 + 60 * MIN))).inserted).toHaveLength(1)
  })

  it('a due occurrence inserts one activation with its key, and the bot starts it in its run lane', async () => {
    const scheduleId = await scheduled()
    const { inserted } = await f.tickSchedules(new Date(T0 + 5 * MIN))
    expect(inserted).toHaveLength(1)
    const [row] = runs()
    expect(row).toMatchObject({
      status: 'running',
      lane: 'run',
      threadId: `thread:bot:${botId}:act:${row!.id}`,
      idempotencyKey: `sched:${botId}:${scheduleId}:${iso(T0 + 5 * MIN)}`,
      trigger: { kind: 'schedule', input: 'Tidy the site.', scheduleId, occurrenceAt: iso(T0 + 5 * MIN) }
    })
    expect(f.store.dispatch(row!.id, 1)).toMatchObject({ prompt: { text: `Tidy the site.\n\n${BOT_RUN_REPORT_LINE}` } })
    expect(entry().nextAt).toBe(iso(T0 + 10 * MIN))
    // The job keeps no run record of its own: the bot's activations are its runs.
    expect(f.scheduler.getJob(entry().jobId)).toMatchObject({ runHistory: [], state: 'scheduled' })
  })

  it('while the bot waits for its owner, occurrences are skipped and say why; the next one after the answer runs', async () => {
    await scheduled()
    await f.tickSchedules(new Date(T0 + 5 * MIN))
    const [first] = runs()
    f.bots.raiseWall(first!.id, { dispatchN: 1, kind: 'gate', permission: { tool: 'write' }, reason: 'I need to write.' })
    expect(f.store.activation(first!.id)!.status).toBe('waiting_grant')
    for (const at of [T0 + 10 * MIN, T0 + 15 * MIN, T0 + 20 * MIN]) expect((await f.tickSchedules(new Date(at))).inserted).toEqual([])
    expect(runs()).toHaveLength(1)
    expect(f.bots.get(botId).summary.schedules).toEqual([{ id: entry().scheduleId, nextRunAt: iso(T0 + 25 * MIN), skipped: { at: iso(T0 + 20 * MIN), reason: 'bot_waiting_for_owner' } }])
    f.store.run("UPDATE bot_activations SET status = 'done' WHERE id = ?", first!.id)
    expect((await f.tickSchedules(new Date(T0 + 25 * MIN))).inserted).toHaveLength(1)
    expect(f.bots.get(botId).summary.schedules![0]!.skipped).toBeNull()
  })

  it('a schedule whose last run still waits in the queue is skipped, never queued twice', async () => {
    const tidy = await scheduled()
    const other = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check links.' }, 'owner').scheduleId
    await f.tickSchedules(new Date(T0 + 5 * MIN))
    await f.tickSchedules(new Date(T0 + 10 * MIN))
    const ids = (rows: ReturnType<typeof runs>) => rows.map((row) => [row.trigger.kind === 'schedule' && row.trigger.scheduleId, row.status])
    expect(ids(runs()).filter(([, status]) => status === 'queued')).toHaveLength(2)
    expect((await f.tickSchedules(new Date(T0 + 15 * MIN))).inserted).toEqual([])
    expect(f.book.list(botId).map((schedule) => [schedule.scheduleId, schedule.skip?.reason])).toEqual(expect.arrayContaining([[tidy, 'previous_run_still_queued'], [other, 'previous_run_still_queued']]))
  })

  it('a hand-over repeated after a crash inserts nothing and dispatches nothing twice', async () => {
    const scheduleId = await scheduled()
    await f.tickSchedules(new Date(T0 + 5 * MIN))
    const [row] = runs()
    const runId = f.store.dispatch(row!.id, 1)!.runId!
    // The scheduler's move was lost: the same occurrence comes again.
    expect(f.bots.runScheduledOccurrence({ botId, scheduleId, prompt: 'Tidy the site.', occurrenceAt: iso(T0 + 5 * MIN) })).toMatchObject({ kind: 'started' })
    await flush()
    expect(runs()).toHaveLength(1)
    expect(f.store.dispatches(row!.id)).toHaveLength(1)
    expect(f.store.dispatch(row!.id, 1)!.runId).toBe(runId)
  })

  it('occurrences missed while Mousse was closed collapse into one', async () => {
    await scheduled()
    const { inserted } = await f.tickSchedules(new Date(T0 + 120 * MIN + 7000))
    expect(inserted).toHaveLength(1)
    expect(runs()[0]!.trigger).toMatchObject({ kind: 'schedule', occurrenceAt: iso(T0 + 5 * MIN) })
    // The next occurrence is after now, not the next missed one.
    expect(entry().nextAt).toBe(iso(T0 + 125 * MIN + 7000))
    expect((await f.tickSchedules(new Date(T0 + 121 * MIN))).inserted).toEqual([])
  })

  it('an occurrence while the bot runs waits in its queue and starts when the bot is free', async () => {
    await scheduled('Tidy.', 5)
    f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Links.' }, 'owner')
    await f.tickSchedules(new Date(T0 + 5 * MIN))
    const [first, second] = runs()
    expect([first!.status, second!.status].sort()).toEqual(['queued', 'running'])
    const running = first!.status === 'running' ? first! : second!
    const queued = first!.status === 'running' ? second! : first!
    await runDispatch(f, running.id, 1, { text: 'Tidied.' })
    expect(f.store.activation(queued.id)!.status).toBe('running')
  })

  it('an edited schedule restarts from now; a removed one is gone', async () => {
    const scheduleId = await scheduled()
    const job = f.scheduler.getJob(entry().jobId)!
    f.clock.now = T0 + 4 * MIN
    f.book.update(job, { schedule: { kind: 'interval', minutes: 60 } })
    expect(entry().nextAt).toBe(iso(T0 + 64 * MIN))
    expect((await f.tickSchedules(new Date(T0 + 5 * MIN))).inserted).toEqual([])
    expect(f.bots.removeSchedule(botId, scheduleId)).toBe(true)
    expect(f.book.list(botId)).toEqual([])
    expect(f.scheduler.getJob(job.id)).toBeUndefined()
  })

  it('an edit from the Automations page keeps Who, Where and May the bot\'s', async () => {
    await scheduled()
    const job = f.scheduler.getJob(entry().jobId)!
    expect(() => f.book.update(job, { selection: { instanceId: 'claude', llmProvider: 'claude', model: 'opus' } })).toThrow(/stay the bot's/)
    expect(() => f.book.update(job, { projectId: 'p1' })).toThrow(/stay the bot's/)
    expect(() => f.book.update(job, { permissionMode: 'full' })).toThrow(/stay the bot's/)
    expect(() => f.book.update(job, { prompt: '/release-notes' })).toThrow(/workflow/)
    expect(() => f.book.update(job, { schedule: { kind: 'once', runAt: iso(T0 + MIN) } })).toThrow(/A bot repeats/)
    expect(() => f.book.update(job, { schedule: { kind: 'interval', minutes: 2 } })).toThrow(/every 5 minutes/)
    f.book.update(job, { name: 'Tidy up', prompt: 'Tidy the blog.', tellMe: 'problems' })
    expect(entry()).toMatchObject({ name: 'Tidy up', prompt: 'Tidy the blog.', tellMe: 'problems' })
    // The bot's own list shows the same record.
    expect(f.bots.listSchedules(botId)).toEqual([{ scheduleId: entry().scheduleId, label: 'every 5 minutes', nextAt: iso(T0 + 5 * MIN) }])
  })

  it('a cron with a step of 0 or a value out of range is refused at once, never searched', () => {
    const started = Date.now()
    for (const expr of ['1-5/0 * * * *', '*/0 * * * *', '0 1-3/0 * * *', 'a b c d e', '60 * * * *', '0 24 * * *', '0 0 0 * *', '5-1 * * * *'])
      expect(scheduleProblem({ id: 'x', when: { kind: 'cron', expr }, prompt: 'p' }), expr).toMatch(/invalid/)
    expect(() => f.bots.addSchedule(botId, { when: { kind: 'cron', expr: '1-5/0 * * * *' }, prompt: 'p' }, 'bot')).toThrow(/invalid/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('a malformed schedule is refused', () => {
    expect(scheduleProblem({ id: 'x', when: { kind: 'interval', minutes: 0 }, prompt: 'p' })).toMatch(/at least 1/)
    expect(scheduleProblem({ id: 'x', when: { kind: 'cron', expr: '* * *' }, prompt: 'p' })).toMatch(/five fields/)
    expect(scheduleProblem({ id: 'x', when: { kind: 'cron', expr: '0 9 * * 1' }, prompt: '' })).toMatch(/something to do/)
    expect(scheduleProblem({ id: 'x', when: { kind: 'cron', expr: '0 9 * * 1' }, prompt: 'p' })).toBeUndefined()
    expect(() => f.bots.addSchedule(botId, { when: { kind: 'cron', expr: '0 9 * * 1' }, prompt: '' }, 'bot')).toThrow(/something to do/)
  })

  it('a bot\'s own schedules: at most 8, at least 5 minutes apart, each with a label and no approval', () => {
    const revision = f.store.registry(botId)!.revision
    expect(() => f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 4 }, prompt: 'p' }, 'bot')).toThrow(/every 5 minutes/)
    expect(() => f.bots.addSchedule(botId, { when: { kind: 'cron', expr: '* * * * *' }, prompt: 'p' }, 'bot')).toThrow(/every 5 minutes/)
    expect(botScheduleProblem({ kind: 'cron', expr: '*/5 * * * *' }, 'p')).toBeUndefined()
    const added = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 30 }, prompt: 'Check links.' }, 'bot')
    expect(added).toMatchObject({ scheduleId: expect.stringMatching(/^s-[0-9a-f]{8}$/), label: 'every 30 minutes', createdBy: 'bot', prompt: 'Check links.' })
    for (let i = 1; i < 8; i += 1) f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, prompt: `p${i}` }, 'bot')
    expect(() => f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, prompt: 'ninth' }, 'bot')).toThrow(expect.objectContaining({ code: 'schedule_limit' }))
    // Schedules change no revision, so no approval is needed.
    expect(f.store.registry(botId)!.revision).toBe(revision)
    expect(f.bots.listSchedules(botId)).toHaveLength(8)
    expect(f.bots.removeSchedule(botId, added.scheduleId)).toBe(true)
    expect(f.bots.removeSchedule(botId, added.scheduleId)).toBe(false)
    expect(f.bots.listSchedules(botId)).toHaveLength(7)
  })

  it('a paused bot skips its occurrences (chat is not affected); resuming runs the next one', async () => {
    await scheduled()
    f.bots.pauseBot(botId)
    expect((await f.tickSchedules(new Date(T0 + 5 * MIN))).inserted).toEqual([])
    expect(entry()).toMatchObject({ skip: { reason: 'paused' }, nextAt: iso(T0 + 10 * MIN) })
    await f.bots.resumeBot(botId)
    expect((await f.tickSchedules(new Date(T0 + 10 * MIN))).inserted).toHaveLength(1)
    expect(entry().skip).toBeUndefined()
  })

  it('a schedule paused from the Automations page is not claimed; resuming starts it from now', async () => {
    await scheduled()
    f.scheduler.pauseJob(entry().jobId)
    expect(entry().paused).toBe(true)
    expect((await f.tickSchedules(new Date(T0 + 30 * MIN))).inserted).toEqual([])
    f.scheduler.resumeJob(entry().jobId)
    expect(entry()).toMatchObject({ paused: false })
  })

  it('a usage-limit pause skips occurrences until its reset, then ends by itself', async () => {
    await scheduled()
    f.store.setPaused(botId, 'usage_limit', iso(T0 + 12 * MIN))
    expect((await f.tickSchedules(new Date(T0 + 5 * MIN))).inserted).toEqual([])
    expect(entry().skip?.reason).toBe('usage_limited')
    expect((await f.tickSchedules(new Date(T0 + 15 * MIN))).inserted).toHaveLength(1)
    expect(f.store.registry(botId)!.pausedReason).toBeNull()
  })

  it('one bot that cannot be read never stops the others\' schedules', async () => {
    await scheduled()
    const { botId: other } = await createBot(f, { name: 'Reporter', reply: 'Hi.' })
    f.bots.addSchedule(other, { when: { kind: 'interval', minutes: 5 }, prompt: 'Report.' }, 'owner')
    const run = f.bots.runScheduledOccurrence.bind(f.bots)
    vi.spyOn(f.bots, 'runScheduledOccurrence').mockImplementation((input) => {
      if (input.botId === botId) throw new Error('Unexpected token in JSON')
      return run(input)
    })
    const { inserted } = await f.tickSchedules(new Date(T0 + 5 * MIN))
    expect(inserted).toHaveLength(1)
    expect(f.store.activation(inserted[0]!)!.botId).toBe(other)
    expect(entry()).toMatchObject({ skip: { reason: 'bot_unavailable' }, nextAt: iso(T0 + 10 * MIN) })
  })

  it('a start that fails is tried again by the next tick, never left queued', async () => {
    await scheduled()
    const pump = vi.spyOn(f.bots as unknown as { pump(botId: string): Promise<void> }, 'pump').mockRejectedValue(new Error('SQLITE_BUSY'))
    const { inserted } = await f.tickSchedules(new Date(T0 + 5 * MIN))
    expect(f.store.activation(inserted[0]!)!.status).toBe('queued')
    pump.mockRestore()
    expect((await f.tickSchedules(new Date(T0 + 6 * MIN))).inserted).toEqual([])
    expect(f.store.activation(inserted[0]!)!.status).toBe('running')
  })

  it('adding or removing a schedule wakes the scheduler, so it is read at once', () => {
    const wake = vi.spyOn(f.scheduler, 'wake')
    const { scheduleId } = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 10 }, prompt: 'p' }, 'owner')
    expect(wake).toHaveBeenCalledTimes(1)
    f.bots.removeSchedule(botId, scheduleId)
    expect(wake).toHaveBeenCalledTimes(2)
  })

  it('a deleted bot\'s schedules start nothing and leave with its purge', async () => {
    await scheduled()
    await f.bots.remove(botId)
    expect((await f.tickSchedules(new Date(T0 + 5 * MIN))).inserted).toEqual([])
    expect(entry().skip?.reason).toBe('bot_deleted')
  })

  it('a run report of a schedule told Only problems is quiet; other rows notify as before', async () => {
    await scheduled()
    f.book.update(f.scheduler.getJob(entry().jobId)!, { tellMe: 'problems' })
    const events: Array<{ message: { kind: string }; quiet?: true }> = []
    f.bots.events.on('message', (event) => events.push(event))
    const { inserted } = await f.tickSchedules(new Date(T0 + 5 * MIN))
    await runDispatch(f, inserted[0]!, 1, { text: 'All tidy.' })
    expect(events.find((event) => event.message.kind === 'run_report')).toMatchObject({ quiet: true })
    f.book.update(f.scheduler.getJob(entry().jobId)!, { tellMe: 'every' })
    const next = await f.tickSchedules(new Date(T0 + 10 * MIN))
    await runDispatch(f, next.inserted[0]!, 1, { text: 'Tidy again.' })
    expect(events.filter((event) => event.message.kind === 'run_report').at(-1)!.quiet).toBeUndefined()
  })

  it('a model picked by hand for an owner\'s automation is its runs\' model; by usage is the default (#673)', async () => {
    await f.bots.reconcileOnStartup()
    const byHand = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Tidy.', model: 'opus' }, 'owner')
    const byUsage = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Links.' }, 'owner')
    // The bot's own schedules never name a model: only the owner picks one.
    const own = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Mine.', model: 'opus' }, 'bot')
    expect([byHand.model, byUsage.model, own.model]).toEqual(['opus', undefined, undefined])
    await f.tickSchedules(new Date(T0 + 5 * MIN))
    const of = (scheduleId: string) => f.store.listActivations(botId).find((row) => row.trigger.kind === 'schedule' && row.trigger.scheduleId === scheduleId)!
    expect(of(byHand.scheduleId).modelOverride).toEqual({ mode: 'named', model: 'opus', depth: 'normal' })
    expect(of(byUsage.scheduleId).modelOverride).toBeNull()
  })

  it('the owner picks the bot\'s model by hand in About, or by usage again, on this computer (#673)', async () => {
    expect(await f.bots.service.modelGet(botId)).toMatchObject({ model: null, computer: 'this_computer', computers: [{ id: 'this_computer' }] })
    const revision = f.store.registry(botId)!.revision
    f.bots.service.modelSet(botId, 'sonnet')
    expect(f.bots.ownerModel(botId)).toBe('sonnet')
    expect(f.bots.definitionOf(botId).main.model).toEqual({ mode: 'named', model: 'sonnet', depth: 'normal' })
    // A new revision with the same grant: no approval.
    expect(f.store.registry(botId)!.revision).not.toBe(revision)
    f.bots.service.modelSet(botId, null)
    expect(f.bots.definitionOf(botId).main.model).toEqual({ mode: 'auto', depth: 'normal' })
  })

  it('nextOccurrenceAfter keeps the cadence when on time and collapses when late', () => {
    const every5 = { kind: 'interval' as const, minutes: 5 }
    expect(nextOccurrenceAfter(every5, iso(T0), new Date(T0 + 1000))).toBe(iso(T0 + 5 * MIN))
    expect(nextOccurrenceAfter(every5, iso(T0), new Date(T0 + 30 * MIN))).toBe(iso(T0 + 35 * MIN))
  })
})
