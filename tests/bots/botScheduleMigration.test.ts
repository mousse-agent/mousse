/**
 * Path step 3: the one-time move of bots' schedules from `bots.db` (`bot_schedules`) into the shared scheduled-job
 * store. It keeps ids and next runs, marks the rows instead of deleting them, is idempotent, finishes a move cut short,
 * and can be undone.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOTS_MIGRATIONS, BotStore } from '../../src/mms/bots/store/BotStore'
import { jobToDefinition, MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { botJobThreadGuard } from '../../src/mms/scheduled/botJobs'
import { migrateBotSchedules, unmigrateBotSchedules } from '../../src/mms/scheduled/botScheduleMigration'
import { ScheduledJobService } from '../../src/mms/scheduled/ScheduledJobService'
import { ScheduledJobStore } from '../../src/mms/scheduled/ScheduledJobStore'
import type { ScheduledJob } from '../../src/shared/types'
import { botFixture, createBot, T0 } from './botFixture'

const NOW = new Date('2026-11-09T10:00:00.000Z')

let base: string
let profile: string
let bots: BotStore | undefined
let jobs: ScheduledJobStore

/** A profile an earlier build left: `bots.db` at v4 with three schedules (one removed) and the old scheduler's times. */
function oldProfile(): void {
  const v4 = new ProfileDatabase({ profileHome: profile, name: 'bots' })
  v4.migrate(BOTS_MIGRATIONS.slice(0, 4))
  const schedule = v4.statement('INSERT INTO bot_schedules(id, bot_id, when_json, prompt, label, created_by, created_at, removed_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
  schedule.run('tidy', 'bot-a', JSON.stringify({ kind: 'interval', minutes: 30 }), 'Tidy the notes.', 'every 30 minutes', 'bot', '2026-11-01T08:00:00.000Z', null)
  schedule.run('news', 'bot-a', JSON.stringify({ kind: 'cron', expr: '0 8 * * *' }), 'Morning news\nKeep it short.', 'every day · 08:00', 'owner', '2026-11-02T08:00:00.000Z', null)
  schedule.run('gone', 'bot-a', JSON.stringify({ kind: 'interval', minutes: 60 }), 'Old.', 'every hour', 'owner', '2026-11-01T08:00:00.000Z', '2026-11-03T08:00:00.000Z')
  schedule.run('daily', 'bot-b', JSON.stringify({ kind: 'cron', expr: '0 9 * * 1-5' }), 'Invoices.', 'every weekday · 09:00', 'owner', '2026-11-04T08:00:00.000Z', null)
  const state = v4.statement('INSERT INTO bot_schedule_state(bot_id, schedule_id, spec_json, next_run_at) VALUES(?, ?, ?, ?)')
  state.run('bot-a', 'tidy', JSON.stringify({ kind: 'interval', minutes: 30 }), '2026-11-09T10:20:00.000Z')
  // `news` was edited after its last tick (the spec no longer matches): it starts from now.
  state.run('bot-a', 'news', JSON.stringify({ kind: 'cron', expr: '0 7 * * *' }), '2026-11-10T07:00:00.000Z')
  state.run('bot-b', 'daily', JSON.stringify({ kind: 'cron', expr: '0 9 * * 1-5' }), '2026-11-09T09:00:00.000Z')
  v4.close()
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-move-')))
  profile = join(base, 'profile')
  mkdirSync(profile, { recursive: true })
  oldProfile()
  bots = new BotStore({ profileHome: profile })
  jobs = new ScheduledJobStore(MousseConfigStore.load(join(base, 'home')))
})

afterEach(() => {
  vi.restoreAllMocks()
  bots?.close()
  rmSync(base, { recursive: true, force: true })
})

const move = () => migrateBotSchedules({ bots: bots!, jobs, now: () => NOW })

describe('moving bot schedules to the shared store', () => {
  it('opens the old bots.db at v5 and keeps a copy of it as it was', () => {
    expect(bots!.db.userVersion()).toBe(5)
    expect(readdirSync(join(profile, 'bots')).some((name) => name === 'bots.db.pre-v5')).toBe(true)
  })

  it('copies each schedule once, keeping its id, prompt, who added it, when it was made and its next run', () => {
    const result = move()
    expect(result).toEqual({ moved: ['bot-a--tidy', 'bot-a--news', 'bot-b--daily'], marked: [], repaired: [], removed: [], failed: [] })
    expect(jobs.getJob('bot-a--tidy')).toMatchObject({
      name: 'Tidy the notes.',
      prompt: 'Tidy the notes.',
      schedule: { kind: 'interval', minutes: 30 },
      bot: { botId: 'bot-a', scheduleId: 'tidy', createdBy: 'bot' },
      threadId: botJobThreadGuard('bot-a'),
      nextRunAt: '2026-11-09T10:20:00.000Z',
      createdAt: '2026-11-01T08:00:00.000Z',
      state: 'scheduled',
      enabled: true
    })
    // The next run the old scheduler had, even one already due: the scheduler runs it once, as the old one would have.
    expect(jobs.getJob('bot-b--daily')).toMatchObject({ nextRunAt: '2026-11-09T09:00:00.000Z', bot: { createdBy: 'owner' } })
    // A time edited since its last tick starts from now; its name is its prompt's first line.
    expect(jobs.getJob('bot-a--news')).toMatchObject({ name: 'Morning news', nextRunAt: new Date(2026, 10, 10, 8, 0).toISOString() })
    // A removed schedule stays removed.
    expect(jobs.getJob('bot-a--gone')).toBeUndefined()
    // The rows stay, marked with the job each became.
    expect(bots!.schedules('bot-a').map((row) => [row.id, row.migratedJobId, row.migratedAt])).toEqual([
      ['tidy', 'bot-a--tidy', NOW.toISOString()],
      ['news', 'bot-a--news', NOW.toISOString()]
    ])
    expect(bots!.unmigratedSchedules()).toEqual([])
  })

  it('run again, it changes nothing', () => {
    move()
    const before = JSON.stringify(jobs.listJobs())
    expect(move()).toEqual({ moved: [], marked: [], repaired: [], removed: [], failed: [] })
    expect(JSON.stringify(jobs.listJobs())).toBe(before)
    expect(jobs.listJobs()).toHaveLength(3)
  })

  it('a move cut short before a row was marked finishes without making its job twice', () => {
    const mark = bots!.markScheduleMigrated.bind(bots!)
    let marks = 0
    vi.spyOn(bots!, 'markScheduleMigrated').mockImplementation((...args) => {
      if (++marks === 2) throw new Error('Mousse stopped')
      return mark(...args)
    })
    const first = move()
    expect(first.failed).toEqual([{ botId: 'bot-a', scheduleId: 'news', error: 'Mousse stopped' }])
    expect(jobs.listJobs()).toHaveLength(3)
    vi.restoreAllMocks()
    expect(move()).toEqual({ moved: [], marked: ['bot-a--news'], repaired: [], removed: [], failed: [] })
    expect(jobs.listJobs().map((job) => job.id).sort()).toEqual(['bot-a--news', 'bot-a--tidy', 'bot-b--daily'])
    expect(bots!.unmigratedSchedules()).toEqual([])
  })

  it('a move cut short before a job was saved makes it next time, and moves nothing twice', () => {
    const create = jobs.createJob.bind(jobs)
    let creates = 0
    vi.spyOn(jobs, 'createJob').mockImplementation((...args) => {
      if (++creates === 2) throw new Error('disk full')
      return create(...args)
    })
    const first = move()
    expect(first.moved).toEqual(['bot-a--tidy', 'bot-b--daily'])
    expect(first.failed).toMatchObject([{ scheduleId: 'news', error: 'disk full' }])
    expect(bots!.unmigratedSchedules().map((row) => row.id)).toEqual(['news'])
    vi.restoreAllMocks()
    expect(move()).toEqual({ moved: ['bot-a--news'], marked: [], repaired: [], removed: [], failed: [] })
    expect(jobs.listJobs()).toHaveLength(3)
  })

  it('a moved schedule the bot removes later is never moved back', () => {
    move()
    expect(jobs.deleteJob('bot-a--tidy')).toBe(true)
    expect(move()).toEqual({ moved: [], marked: [], repaired: [], removed: [], failed: [] })
    expect(jobs.getJob('bot-a--tidy')).toBeUndefined()
  })

  it('can be undone: the jobs go and the rows are the bots\' again, ready to move once more', () => {
    move()
    expect(unmigrateBotSchedules({ bots: bots!, jobs }).sort()).toEqual(['bot-a--news', 'bot-a--tidy', 'bot-b--daily'])
    expect(jobs.listJobs()).toEqual([])
    expect(bots!.unmigratedSchedules().map((row) => row.id)).toEqual(['tidy', 'news', 'daily'])
    expect(move().moved).toHaveLength(3)
  })

  it('a build that knows no bot field pauses the job instead of running the bot\'s prompt outside the bot', async () => {
    move()
    // What an earlier build reads: the same job without the field it does not know, due now.
    const service = new ScheduledJobService(
      { runIsolated: vi.fn(async () => { throw new Error('ran outside the bot') }) },
      jobs,
      { getThread: () => undefined } as unknown as ConstructorParameters<typeof ScheduledJobService>[2]
    )
    jobs.updateJob('bot-a--tidy', { bot: undefined, nextRunAt: new Date(Date.now() - 1000).toISOString() })
    await service.tickNow()
    expect(jobs.getJob('bot-a--tidy')).toMatchObject({ state: 'paused', pausedReason: 'Its thread was deleted' })
    service.beginShutdown()
  })
})

describe('going back to an older build and coming back', () => {
  /** What an older build's save does: it writes every job through its own field list, which knows none of these. */
  function olderBuildSaves(change: (job: ScheduledJob) => ScheduledJob = (job) => job): void {
    const inside = jobs as unknown as { config: MousseConfigStore; saveRuntimeDurably(list: ScheduledJob[]): void }
    const list = jobs.listJobs().map(change)
    const stripped = list.map((job) => jobToDefinition(job)).map(({ bot: _bot, draft: _draft, keys: _keys, tellMe: _tellMe, agent: _agent, cliName: _cliName, ...rest }) => rest)
    inside.config.updateScheduledSection({ jobs: stripped })
    inside.saveRuntimeDurably(list)
  }

  it('gives a moved job its bot back after an older build stripped it and paused it, and it runs again', () => {
    move()
    // The older build's tick: the guard thread does not exist, so it pauses the job. That save is this build's here,
    // so the copy of the fields is behind too: only the bots.db row can repair it.
    jobs.updateJob('bot-a--tidy', { bot: undefined })
    jobs.pauseJob('bot-a--tidy', 'Its thread was deleted')
    const result = move()
    expect(result).toMatchObject({ moved: [], repaired: ['bot-a--tidy'], failed: [] })
    expect(jobs.getJob('bot-a--tidy')).toMatchObject({ bot: { botId: 'bot-a', scheduleId: 'tidy', createdBy: 'bot' }, threadId: botJobThreadGuard('bot-a'), enabled: true, state: 'scheduled' })
    expect(jobs.getJob('bot-a--tidy')?.pausedReason).toBeUndefined()
    expect(move().repaired).toEqual([])
  })

  it('repairs a job the restored bots.db.pre-v5 rows find already there, and removes one the older build removed', () => {
    move()
    jobs.updateJob('bot-a--news', { bot: undefined })
    // bots.db.pre-v5 restored: no marks; the older build then removed `tidy`.
    bots!.run('UPDATE bot_schedules SET migrated_at = NULL, migrated_job_id = NULL')
    bots!.run("UPDATE bot_schedules SET removed_at = ? WHERE id = 'tidy'", '2026-11-08T00:00:00.000Z')
    const result = move()
    expect(result).toMatchObject({ moved: [], marked: ['bot-a--news', 'bot-b--daily'], repaired: ['bot-a--news'], removed: ['bot-a--tidy'], failed: [] })
    expect(jobs.getJob('bot-a--tidy')).toBeUndefined()
    expect(jobs.getJob('bot-a--news')?.bot).toEqual({ botId: 'bot-a', scheduleId: 'news', createdBy: 'owner' })
  })

  it('puts back every field an older build’s save dropped: a bot’s link, a draft, keys, Tell me and a CLI name', () => {
    move()
    const draft = jobs.createJob({ name: 'Draft', prompt: 'x', schedule: { kind: 'interval', minutes: 30 }, draft: { draft: true, draftId: 'd1' } })
    const keyed = jobs.createJob({ name: 'Keyed', prompt: 'x', schedule: { kind: 'manual' }, keys: ['GITHUB_TOKEN'], tellMe: 'every', cliName: 'keyed' })
    // The older build saves: it pauses a bot's job on its guard thread, gives another bot's job a thread of its own,
    // and the person turns on the draft there, which that build shows as an ordinary paused job.
    olderBuildSaves((job) =>
      job.id === 'bot-b--daily' ? { ...job, enabled: false, state: 'paused', pausedAt: NOW.toISOString(), pausedReason: 'Its thread was deleted' }
        : job.id === 'bot-a--news' ? { ...job, threadId: 'a-real-thread' }
          : job.id === draft.id ? { ...job, enabled: true, state: 'scheduled', nextRunAt: NOW.toISOString() }
            : job)
    expect(jobs.getJob('bot-b--daily')).toMatchObject({ state: 'paused' })
    expect(jobs.getJob('bot-b--daily')?.bot).toBeUndefined()
    const before = jobs.getJob(keyed.id)
    expect(before?.keys).toBeUndefined()
    expect(jobs.restoreDroppedFields().sort()).toEqual(['bot-a--news', 'bot-a--tidy', 'bot-b--daily', draft.id, keyed.id].sort())
    // The draft is a draft again, never on, and never due.
    expect(jobs.getJob(draft.id)).toMatchObject({ draft: { draft: true, draftId: 'd1' }, enabled: false, state: 'paused', nextRunAt: null })
    expect(jobs.getJob('bot-a--news')).toMatchObject({ bot: { botId: 'bot-a', scheduleId: 'news' }, threadId: botJobThreadGuard('bot-a') })
    expect(jobs.getJob(keyed.id)).toMatchObject({ keys: ['GITHUB_TOKEN'], tellMe: 'every', cliName: 'keyed' })
    expect(jobs.getJob('bot-b--daily')).toMatchObject({ bot: { botId: 'bot-b', scheduleId: 'daily' }, enabled: true, state: 'scheduled' })
    // The scheduler never starts a draft.
    expect(jobs.claimDueJobs(new Date(NOW.getTime() + 86_400_000)).map((job) => job.id)).not.toContain(draft.id)
    // Nothing more to put back; an edit this build makes afterwards is never undone.
    expect(jobs.restoreDroppedFields()).toEqual([])
    jobs.updateJob(keyed.id, { keys: undefined })
    expect(jobs.restoreDroppedFields()).toEqual([])
  })
})

describe('a moved schedule runs in the bot\'s run lane', () => {
  it('keeps its schedule id and next run, and its occurrence starts the bot', async () => {
    const f = botFixture()
    try {
      const { botId } = await createBot(f, { name: 'Pip', reply: 'Hi.' })
      f.store.putSchedule({ id: 'tidy', botId, when: { kind: 'interval', minutes: 30 }, prompt: 'Tidy.', label: 'every 30 minutes', createdBy: 'bot', createdAt: new Date(T0).toISOString() })
      f.store.run('INSERT INTO bot_schedule_state(bot_id, schedule_id, spec_json, next_run_at) VALUES(?, ?, ?, ?)', botId, 'tidy', JSON.stringify({ kind: 'interval', minutes: 30 }), new Date(T0 + 10 * 60_000).toISOString())
      expect(migrateBotSchedules({ bots: f.store, jobs: f.scheduler, now: () => new Date(f.clock.now) }).moved).toEqual([`${botId}--tidy`])
      expect(f.bots.listSchedules(botId)).toEqual([{ scheduleId: 'tidy', label: 'every 30 minutes', nextAt: new Date(T0 + 10 * 60_000).toISOString() }])
      await f.bots.reconcileOnStartup()
      const { inserted } = await f.tickSchedules(new Date(T0 + 10 * 60_000))
      expect(f.store.activation(inserted[0]!)).toMatchObject({ lane: 'run', trigger: { kind: 'schedule', scheduleId: 'tidy', input: 'Tidy.' } })
      expect(existsSync(f.profile)).toBe(true)
    } finally {
      f.close()
    }
  })
})
