/**
 * Path step 3, "One scheduler": a bot's schedules are automations whose Who is the bot, in the shared scheduled-job
 * store, and the one `ScheduledJobService` claims their occurrences. Each due occurrence is one run activation keyed
 * `sched:<botId>:<scheduleId>:<occurrenceAt>`, so a repeated hand-over (after a crash) inserts nothing. The bot keeps
 * its own rules: skipped while it is paused or its last run of the schedule still waits, at most once a minute, missed occurrences collapse into one, and nothing runs before the bot startup pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOT_RUN_REPORT_LINE } from '../../src/mms/bots/memory/contextPack'
import { botJobId, botScheduleProblem, scheduleProblem, type BotJobWhen } from '../../src/mms/scheduled/botJobs'
import { nextOccurrenceAfter } from '../../src/mms/scheduled/computeNextRun'
import { slotsAllOn } from '../../src/shared/bots/personal/modelSlots'
import type { NotifyLevel, RunLevel } from '../../src/shared/automationInbox'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, T0, type BotFixture } from './botFixture'

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
const scheduledRuns = () => runs().filter((row) => row.trigger.kind === 'schedule')

describe('bot schedules in the shared scheduler', () => {
  it('nothing runs before the startup pass, and a new schedule starts from now', async () => {
    const { scheduleId } = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Tidy the site.' }, 'owner')
    expect(entry()).toMatchObject({ scheduleId, nextAt: iso(T0 + 5 * MIN), createdBy: 'owner', tellMe: 'look' })
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

  it('a schedule whose last run still runs is skipped, never stacked', async () => {
    const tidy = await scheduled()
    const other = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check links.' }, 'owner').scheduleId
    // The two schedules' runs run side by side.
    await f.tickSchedules(new Date(T0 + 5 * MIN))
    expect(runs().map((row) => row.status)).toEqual(['running', 'running'])
    expect((await f.tickSchedules(new Date(T0 + 10 * MIN))).inserted).toEqual([])
    expect(f.book.list(botId).map((schedule) => [schedule.scheduleId, schedule.skip?.reason])).toEqual(expect.arrayContaining([[tidy, 'previous_run_still_running'], [other, 'previous_run_still_running']]))
  })

  it('a schedule every minute runs on each scheduler tick, and skips a tick while its last run still goes', async () => {
    await scheduled('Check the threads.', 1)
    expect(entry().nextAt).toBe(iso(T0 + MIN))
    // The scheduler ticks once a minute, here 20 seconds after each occurrence is due.
    const tick = async (minute: number) => (await f.tickSchedules(new Date(T0 + minute * MIN + 20_000))).inserted
    for (const minute of [1, 2, 3]) {
      const inserted = await tick(minute)
      expect(inserted, `minute ${minute}`).toHaveLength(1)
      expect(f.store.activation(inserted[0]!)!.trigger).toMatchObject({ occurrenceAt: iso(T0 + minute * MIN) })
      await runDispatch(f, inserted[0]!, 1, { text: 'Checked.' })
    }
    // A run longer than a minute: the next occurrence is skipped, not stacked, and the one after it runs.
    const [long] = await tick(4)
    expect(await tick(5)).toEqual([])
    expect(entry().skip?.reason).toBe('previous_run_still_running')
    await runDispatch(f, long!, 1, { text: 'Checked.' })
    expect(await tick(6)).toHaveLength(1)
    expect(scheduledRuns()).toHaveLength(5)
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

  it('an occurrence runs beside what the bot runs, with no queue', async () => {
    await scheduled('Tidy.', 5)
    f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Links.' }, 'owner')
    await f.bots.activate({ botId, input: 'busy', clientRequestId: 'busy' })
    await f.bots.activate({ botId, input: 'busy too', clientRequestId: 'busy2' })
    await f.tickSchedules(new Date(T0 + 5 * MIN))
    expect(scheduledRuns().map((row) => row.status)).toEqual(['running', 'running'])
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
    expect(() => f.book.update(job, { schedule: { kind: 'once', runAt: iso(T0 - MIN) } })).toThrow(/in the past/)
    expect(() => f.book.update(job, { schedule: { kind: 'interval', minutes: 0 } })).toThrow(/at least 1/)
    f.book.update(job, { name: 'Tidy up', prompt: 'Tidy the blog.', tellMe: 'problems' })
    expect(entry()).toMatchObject({ name: 'Tidy up', prompt: 'Tidy the blog.', tellMe: 'needs_you' })
    // The bot's own list shows the same record.
    expect(f.bots.listSchedules(botId)).toEqual([{ scheduleId: entry().scheduleId, label: 'every 5 minutes', nextAt: iso(T0 + 5 * MIN) }])
  })

  it('a cron with a step of 0 or a value out of range is refused', () => {
    for (const expr of ['1-5/0 * * * *', '*/0 * * * *', '0 1-3/0 * * *', 'a b c d e', '60 * * * *', '0 24 * * *', '0 0 0 * *', '5-1 * * * *'])
      expect(scheduleProblem({ id: 'x', when: { kind: 'cron', expr }, prompt: 'p' }), expr).toMatch(/invalid/)
    expect(() => f.bots.addSchedule(botId, { when: { kind: 'cron', expr: '1-5/0 * * * *' }, prompt: 'p' }, 'bot')).toThrow(/invalid/)
  })

  it('a malformed schedule is refused', () => {
    expect(scheduleProblem({ id: 'x', when: { kind: 'interval', minutes: 0 }, prompt: 'p' })).toMatch(/at least 1/)
    expect(scheduleProblem({ id: 'x', when: { kind: 'cron', expr: '* * *' }, prompt: 'p' })).toMatch(/five fields/)
    expect(scheduleProblem({ id: 'x', when: { kind: 'cron', expr: '0 9 * * 1' }, prompt: '' })).toMatch(/something to do/)
    expect(scheduleProblem({ id: 'x', when: { kind: 'cron', expr: '0 9 * * 1' }, prompt: 'p' })).toBeUndefined()
    expect(() => f.bots.addSchedule(botId, { when: { kind: 'cron', expr: '0 9 * * 1' }, prompt: '' }, 'bot')).toThrow(/something to do/)
  })

  it('a bot\'s own schedules: as many as it needs up to a runaway ceiling, at least a minute apart, each with a label and no approval', () => {
    const revision = f.store.registry(botId)!.revision
    // Every minute is the shortest: an interval of whole minutes, at least 1, or any cron expression.
    for (const when of [{ kind: 'interval', minutes: 1 }, { kind: 'interval', minutes: 2 }, { kind: 'cron', expr: '* * * * *' }, { kind: 'cron', expr: '*/2 * * * *' }])
      expect(botScheduleProblem(when, 'p'), JSON.stringify(when)).toBeUndefined()
    for (const minutes of [0, 0.5, -1]) expect(botScheduleProblem({ kind: 'interval', minutes }, 'p'), String(minutes)).toMatch(/at least 1/)
    expect(() => f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 0 }, prompt: 'p' }, 'bot')).toThrow(/at least 1/)
    const added = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 30 }, prompt: 'Check links.' }, 'bot')
    expect(added).toMatchObject({ scheduleId: expect.stringMatching(/^s-[0-9a-f]{8}$/), label: 'every 30 minutes', createdBy: 'bot', prompt: 'Check links.' })
    // More than the eight an older build allowed: the ceiling (`MAX_BOT_SCHEDULES`) is one only a runaway reaches.
    for (let i = 1; i < 9; i += 1) f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, prompt: `p${i}` }, 'bot')
    // Schedules change no revision, so no approval is needed.
    expect(f.store.registry(botId)!.revision).toBe(revision)
    expect(f.bots.listSchedules(botId)).toHaveLength(9)
    expect(f.bots.removeSchedule(botId, added.scheduleId)).toBe(true)
    expect(f.bots.removeSchedule(botId, added.scheduleId)).toBe(false)
    expect(f.bots.listSchedules(botId)).toHaveLength(8)
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
    // Paused once, with why, instead of skipping every occurrence until the purge.
    expect(f.scheduler.getJob(entry().jobId)).toMatchObject({ enabled: false, state: 'paused', pausedReason: 'Its bot was deleted.' })
  })

  it('pauses a bot\'s schedule once in a profile where bots could not be opened, and resumes it once they open', async () => {
    await scheduled()
    const runner = (f.scheduler as unknown as { botRunner: Parameters<typeof f.scheduler.setBotRunner>[0] }).botRunner
    f.scheduler.setBotRunner(null)
    await f.tickSchedules(new Date(T0 + 5 * MIN))
    expect(f.scheduler.getJob(entry().jobId)).toMatchObject({ enabled: false, state: 'paused', pausedReason: expect.stringMatching(/^Bots could not be opened/) })
    // Bots open at the next start: the schedule paused only for that runs again.
    f.scheduler.setBotRunner(runner)
    expect(f.scheduler.getJob(entry().jobId)).toMatchObject({ enabled: true, state: 'scheduled' })
    expect(f.scheduler.getJob(entry().jobId)!.pausedReason).toBeUndefined()
    // One paused for any other reason stays paused.
    f.scheduler.pauseJob(entry().jobId, 'Owner paused it')
    f.scheduler.setBotRunner(runner)
    expect(f.scheduler.getJob(entry().jobId)).toMatchObject({ enabled: false, pausedReason: 'Owner paused it' })
  })

  // Tell me floors × every reported level, plus no report (Worth a look).
  const notificationRows = (['needs_you', 'look', 'fyi', 'every'] as const).flatMap((tellMe) =>
    ([undefined, 'quiet', 'fyi', 'look', 'needs_you'] as const).map((level) => ({
      tellMe, level,
      notifies: tellMe === 'every' || (tellMe === 'needs_you' ? level === 'needs_you' : tellMe === 'look' ? level !== 'fyi' && level !== 'quiet' : level !== 'quiet')
    })))

  it.each(notificationRows)('Tell me $tellMe with report level $level', async ({ tellMe, level, notifies }) => {
    await scheduled()
    f.book.update(f.scheduler.getJob(entry().jobId)!, { tellMe })
    const events: Array<{ message: { kind: string }; quiet?: true }> = []
    f.bots.events.on('message', (event) => events.push(event))
    const { inserted } = await f.tickSchedules(new Date(T0 + 5 * MIN))
    if (level) f.automationRuns.report({ threadId: '', activationId: inserted[0]! }, level, 'Site checked.')
    await runDispatch(f, inserted[0]!, 1, { text: 'Site checked.' })
    const report = events.find((event) => event.message.kind === 'run_report')
    // Quiet runs have no chat row at all, even under Every run.
    if (level === 'quiet') expect(report).toBeUndefined()
    else {
      expect(report).toBeDefined()
      expect(!report!.quiet).toBe(notifies)
      expect(f.store.message((report!.message as { id: string }).id)?.tell).toBe(notifies ? 'soon' : 'later')
    }
  })

  it.each<NotifyLevel>(['needs_you', 'look', 'fyi', 'every'])('failures notify under Tell me %s', async (tellMe) => {
    await scheduled()
    f.book.update(f.scheduler.getJob(entry().jobId)!, { tellMe })
    const events: Array<{ message: { kind: string }; quiet?: true }> = []
    f.bots.events.on('message', (event) => events.push(event))
    const { inserted } = await f.tickSchedules(new Date(T0 + 5 * MIN))
    f.automationRuns.report({ threadId: '', activationId: inserted[0]! }, 'quiet', 'Nothing to report.')
    const { payload } = await start(f, inserted[0]!)
    await finish(f, payload, 'failed', { outcome: { error: 'Site unavailable.' } })
    const error = events.find((event) => event.message.kind === 'error')
    expect(error).toBeDefined()
    expect(error!.quiet).toBeUndefined()
    expect(f.store.message((error!.message as { id: string }).id)?.tell).toBe('soon')
  })

  it('a scheduled run that reports quiet or says [SILENT] posts nothing in the chat; a report, and work the owner asked for, still show', async () => {
    await scheduled()
    const events: Array<{ message: { kind: string; text: string } }> = []
    f.bots.events.on('message', (event) => events.push(event))
    const before = chatOf(f, botId).length
    // Each row is one occurrence's last message, the level its run_report gave (none: it made no report), and
    // whether the chat shows it.
    const rows: Array<[reply: string, level: RunLevel | undefined, shown: boolean]> = [
      ['[SILENT]', undefined, false],
      ['Nothing new on the site.\n[SILENT]', undefined, false],
      ['None of my threads are running, so I had nothing to merge.', 'quiet', false],
      ['Fixed two broken links.', undefined, true],
      ['Fixed two broken links.', 'fyi', true],
      ['The checkout page is down.', 'look', true],
      ['The certificate expires tomorrow: renew it or switch hosts?', 'needs_you', true]
    ]
    for (const [index, [reply, level]] of rows.entries()) {
      const { inserted } = await f.tickSchedules(new Date(T0 + (index + 1) * 5 * MIN))
      // The run's run_report call, as the bot's tool makes it during its turn.
      if (level) f.automationRuns.report({ threadId: '', activationId: inserted[0]! }, level, reply)
      await runDispatch(f, inserted[0]!, 1, { text: reply })
      expect(f.store.activation(inserted[0]!)).toMatchObject({ status: 'done' })
    }
    const shown = rows.filter(([, , keep]) => keep).map(([reply]) => reply)
    expect(chatOf(f, botId).slice(before).map((message) => message.text)).toEqual(shown)
    expect(events.filter((event) => event.message.kind === 'run_report').map((event) => event.message.text)).toEqual(shown)
    // A quiet run stays in Automations with its line.
    expect(f.automationRuns.levelOfActivation(scheduledRuns()[2]!.id)).toBe('quiet')
    // Work the owner asked for is not a scheduled run: its reply is posted as written.
    await f.bots.service.chatSend({ botId, text: 'Check the site now', clientRequestId: 'm1' })
    const turn = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const asked = await start(f, turn.id)
    const work = await f.bots.tools.work.start(botId, turn.id, { title: 'Site check', brief: 'Check the site.', key: 'k1' })
    await finish(f, asked.payload, 'completed', { text: 'On it.' })
    if (work.status !== 'started') throw new Error(`work did not start: ${work.status}`)
    await runDispatch(f, work.workId, 1, { text: '[SILENT]' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'run_report', text: '[SILENT]' })
  })

  it('a model picked by hand for an owner\'s automation is its runs\' pick, on its entry; one saved by name only is matched by name (#673)', async () => {
    await f.bots.reconcileOnStartup()
    const pick = { instanceId: 'claude', model: 'opus', credential: 'subscription' as const }
    const byHand = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Tidy.', model: 'opus', pick }, 'owner')
    const byName = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Older.', model: 'opus' }, 'owner')
    const onWork = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Links.' }, 'owner')
    // The bot's own schedules never name a model: only the owner picks one.
    const own = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Mine.', model: 'opus', pick }, 'bot')
    expect([byHand.model, byName.model, onWork.model, own.model]).toEqual(['opus', 'opus', undefined, undefined])
    expect([byHand.pick, byName.pick, own.pick]).toEqual([pick, undefined, undefined])
    await f.tickSchedules(new Date(T0 + 5 * MIN))
    const of = (scheduleId: string) => f.store.listActivations(botId).find((row) => row.trigger.kind === 'schedule' && row.trigger.scheduleId === scheduleId)!
    expect(of(byHand.scheduleId).modelOverride).toEqual({ mode: 'named', ...pick, depth: 'normal' })
    expect(of(byName.scheduleId).modelOverride).toEqual({ mode: 'named', model: 'opus', depth: 'normal' })
    expect(of(onWork.scheduleId).modelOverride).toBeNull()
  })

  it('the owner picks the bot\'s model by hand in About (the single picker before rows), on this computer (#673)', async () => {
    expect(await f.bots.service.modelGet(botId)).toMatchObject({ model: null, slots: { talk: null, light: null, medium: null, hard: null }, computer: 'this_computer', computers: [{ id: 'this_computer' }] })
    // The person's other computers are listed too, never pickable: a bot runs on the computer that holds it.
    ;(f.bots.service as unknown as { options: { otherComputers?: () => unknown[] } }).options.otherComputers = () => [{ node: 'nod_laptop', name: 'Laptop', online: true }, { node: 'nod_studio', name: 'Studio', online: false }]
    expect((await f.bots.service.modelGet(botId)).computers).toEqual([
      expect.objectContaining({ id: 'this_computer' }),
      { id: 'nod_laptop', name: 'Laptop', unavailable: 'A bot runs on the computer that holds it.' },
      { id: 'nod_studio', name: 'Studio', offline: true, unavailable: 'Studio is offline.' }
    ])
    delete (f.bots.service as unknown as { options: { otherComputers?: unknown } }).options.otherComputers
    const revision = f.store.registry(botId)!.revision
    // Not offered here: refused, never kept by name.
    await expect(f.bots.service.modelSet(botId, 'sonnet')).rejects.toMatchObject({ code: 'model_unavailable' })
    ;(f.bots.service as unknown as { options: { modelOptions?: () => Promise<unknown[]> } }).options.modelOptions = async () => [{ instanceId: 'claude', entry: 'Claude Code', model: 'sonnet', label: 'Sonnet', efforts: [] }]
    await f.bots.service.modelSet(botId, 'sonnet')
    expect((await f.bots.service.modelGet(botId)).model).toBe('sonnet')
    expect(f.bots.ownerSlots(botId)).toEqual(slotsAllOn({ instanceId: 'claude', model: 'sonnet' }))
    expect(f.bots.definitionOf(botId).main.model).toEqual({ mode: 'named', model: 'sonnet ', depth: 'normal' })
    // A new revision with the same grant: no approval.
    expect(f.store.registry(botId)!.revision).not.toBe(revision)
    // A picked bot never goes back to by usage.
    await expect(f.bots.service.modelSet(botId, null)).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('nextOccurrenceAfter keeps the cadence when on time and collapses when late', () => {
    const every5 = { kind: 'interval' as const, minutes: 5 }
    expect(nextOccurrenceAfter(every5, iso(T0), new Date(T0 + 1000))).toBe(iso(T0 + 5 * MIN))
    expect(nextOccurrenceAfter(every5, iso(T0), new Date(T0 + 30 * MIN))).toBe(iso(T0 + 35 * MIN))
  })
})

/**
 * A bot's automation the owner turned on from the Automations page may run once, only when it is run (Run now, the
 * CLI) or on a request URL; a schedule the bot adds itself still repeats. Each start is one run in the bot's lane, and
 * the schedule stays the bot's while it runs (a schedule that is gone cancels its runs).
 */
describe('a bot automation that does not repeat', () => {
  const ownerAdds = (when: BotJobWhen, extra: { prompt?: string; cliName?: string } = {}) => f.book.add(botId, { when, prompt: 'Tidy the site.', ...extra }, 'owner')

  it('on demand: nothing runs by itself; Run now starts one run, and the job waits for its next start', async () => {
    await f.bots.reconcileOnStartup()
    const added = ownerAdds({ kind: 'manual' }, { cliName: 'tidy' })
    expect(added).toMatchObject({ when: { kind: 'manual' }, label: 'when you run it' })
    expect(added.nextAt).toBeUndefined()
    expect(f.scheduler.getJob(added.jobId)).toMatchObject({ schedule: { kind: 'manual' }, state: 'scheduled', nextRunAt: null, cliName: 'tidy' })
    expect((await f.tickSchedules(new Date(T0 + 60 * MIN))).inserted).toEqual([])
    // Run now (and `mousse automation run tidy`) makes it due now, on the real clock.
    f.scheduler.triggerJob(added.jobId)
    const { inserted } = await f.tickSchedules(new Date(Date.now() + MIN))
    expect(inserted).toHaveLength(1)
    expect(f.store.activation(inserted[0]!)).toMatchObject({ lane: 'run', trigger: { kind: 'schedule', input: 'Tidy the site.', scheduleId: added.scheduleId } })
    expect(f.scheduler.getJob(added.jobId)).toMatchObject({ state: 'scheduled', nextRunAt: null, lastStatus: 'ok' })
    expect(f.scheduler.getJob(added.jobId)!.lastError).toBeUndefined()
    f.bots.schedulesEdited(botId)
    expect(f.book.get(botId, added.scheduleId)).toBeDefined()
    expect(f.store.activation(inserted[0]!)!.status).not.toBe('cancelled')
  })

  it('once: runs at its time and completes, and stays the bot\'s while its run goes on', async () => {
    await f.bots.reconcileOnStartup()
    const added = ownerAdds({ kind: 'once', runAt: iso(T0 + 30 * MIN) })
    expect(added.nextAt).toBe(iso(T0 + 30 * MIN))
    expect((await f.tickSchedules(new Date(T0 + 29 * MIN))).inserted).toEqual([])
    const { inserted } = await f.tickSchedules(new Date(T0 + 30 * MIN))
    expect(inserted).toHaveLength(1)
    expect(f.scheduler.getJob(added.jobId)).toMatchObject({ state: 'completed', nextRunAt: null, lastStatus: 'ok' })
    f.bots.schedulesEdited(botId)
    expect(f.book.get(botId, added.scheduleId)).toBeDefined()
    expect(f.store.activation(inserted[0]!)!.status).not.toBe('cancelled')
    expect((await f.tickSchedules(new Date(T0 + 90 * MIN))).inserted).toEqual([])
    expect(() => ownerAdds({ kind: 'once', runAt: iso(T0) })).toThrow(/in the past/)
  })

  it('a request URL starts the bot\'s run with the request\'s fields, and never moves its timer', async () => {
    await f.bots.reconcileOnStartup()
    const added = ownerAdds({ kind: 'manual' }, { prompt: 'Look at {{body.title}}.' })
    f.jobStore.setWebhookTrigger(added.jobId, { scheme: 'mousse', secretRef: `scheduled-webhook-${added.jobId}`, createdAt: iso(T0) })
    const now = Date.now()
    expect(f.jobStore.triggerFromWebhook(added.jobId, { ts: Math.floor(now / 1000), sig: 'a'.repeat(64), body: Buffer.from('{"title":"Fix the cache"}'), now })).toMatchObject({ kind: 'accepted' })
    const { inserted } = await f.tickSchedules(new Date(now))
    expect(inserted).toHaveLength(1)
    const row = f.store.activation(inserted[0]!)!
    expect(row.trigger).toMatchObject({ kind: 'schedule', scheduleId: added.scheduleId, occurrenceAt: iso(now) })
    expect(row.trigger.kind === 'schedule' && row.trigger.input).toContain('Fix the cache')
    expect(f.scheduler.getJob(added.jobId)).toMatchObject({ state: 'scheduled', nextRunAt: null })
    expect(f.jobStore.listWebhookDeliveries(added.jobId)[0]).toMatchObject({ outcome: 'completed' })
  })

  it('a schedule the bot adds itself still repeats', () => {
    expect(() => f.book.add(botId, { when: { kind: 'manual' }, prompt: 'p' }, 'bot')).toThrow(/A bot repeats/)
    expect(() => f.book.add(botId, { when: { kind: 'once', runAt: iso(T0 + MIN) }, prompt: 'p' }, 'bot')).toThrow(/A bot repeats/)
    const own = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'p' }, 'bot')
    expect(() => f.book.update(f.scheduler.getJob(own.jobId)!, { schedule: { kind: 'manual' } })).toThrow(/A bot repeats/)
  })
})

describe('a bot automation\'s request URL and one-time run, held until the bot can take them', () => {
  const ownerAdds = (when: BotJobWhen, prompt = 'Look at {{body.title}}.') => f.book.add(botId, { when, prompt }, 'owner')
  const hooked = () => {
    const added = ownerAdds({ kind: 'manual' })
    f.jobStore.setWebhookTrigger(added.jobId, { scheme: 'mousse', secretRef: `scheduled-webhook-${added.jobId}`, createdAt: iso(T0) })
    return added
  }
  let signed = 0
  const send = (jobId: string, title: string) => {
    signed += 1
    return f.jobStore.triggerFromWebhook(jobId, { ts: Math.floor(f.clock.now / 1000), sig: String(signed % 10).repeat(64), body: Buffer.from(JSON.stringify({ title })), now: f.clock.now })
  }
  beforeEach(() => { f.clock.now = Date.now() })

  it('a request that comes before the bots are ready runs once they are', async () => {
    const added = hooked()
    expect(send(added.jobId, 'First')).toMatchObject({ kind: 'accepted' })
    expect((await f.tickSchedules(new Date(f.clock.now))).inserted).toEqual([])
    expect(f.scheduler.getJob(added.jobId)!.pendingTrigger).toBeDefined()
    await f.bots.reconcileOnStartup()
    const { inserted } = await f.tickSchedules(new Date(f.clock.now + 1000))
    expect(inserted).toHaveLength(1)
    expect(f.store.activation(inserted[0]!)!.trigger).toMatchObject({ input: expect.stringContaining('First') })
  })

  it('a request while the bot\'s previous run still goes waits for it, and the next one is answered busy', async () => {
    await f.bots.reconcileOnStartup()
    const added = hooked()
    expect(send(added.jobId, 'First')).toMatchObject({ kind: 'accepted' })
    const [first] = (await f.tickSchedules(new Date(f.clock.now))).inserted
    expect(first).toBeDefined()
    const second = send(added.jobId, 'Second')
    expect(second).toMatchObject({ kind: 'accepted' })
    expect((await f.tickSchedules(new Date(f.clock.now + 1000))).inserted).toEqual([])
    expect(f.scheduler.getJob(added.jobId)!.pendingTrigger).toMatchObject({ occurrenceId: second.kind === 'accepted' ? second.occurrenceId : '' })
    expect(send(added.jobId, 'Third').kind).toBe('pending')
    await runDispatch(f, first!, 1, { text: 'Looked.' })
    const { inserted } = await f.tickSchedules(new Date(f.clock.now + 2000))
    expect(inserted).toHaveLength(1)
    expect(f.store.activation(inserted[0]!)!.trigger).toMatchObject({ input: expect.stringContaining('Second') })
  })

  it('a one-time automation run early with Run now stays spent through Pause and Resume', async () => {
    await f.bots.reconcileOnStartup()
    const runAt = f.clock.now + 60 * MIN
    const added = ownerAdds({ kind: 'once', runAt: iso(runAt) }, 'Tidy the site.')
    f.scheduler.triggerJob(added.jobId)
    const [early] = (await f.tickSchedules(new Date(Date.now() + 1000))).inserted
    expect(early).toBeDefined()
    await runDispatch(f, early!, 1, { text: 'Tidied.' })
    expect(f.scheduler.getJob(added.jobId)).toMatchObject({ state: 'completed', nextRunAt: null })
    f.scheduler.pauseJob(added.jobId)
    f.scheduler.resumeJob(added.jobId)
    expect(f.scheduler.getJob(added.jobId)).toMatchObject({ state: 'completed', nextRunAt: null, enabled: true })
    expect((await f.tickSchedules(new Date(runAt + MIN))).inserted).toEqual([])
  })
})
