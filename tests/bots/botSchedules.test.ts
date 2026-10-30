/**
 * PR 6 §6 unit 6d: bot schedules. Each due occurrence is one activation under the key
 * `sched:<botId>:<scheduleId>:<occurrenceAt>`, inserted in the same transaction that moves the
 * schedule on, so a repeated tick or a tick after a crash inserts nothing. Occurrences missed while
 * Mousse was closed collapse into one; a busy bot queues the next one; nothing ticks before the
 * startup pass.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotEngine, type BotEngineHost } from '../../src/mms/bots/activation/BotEngine'
import { BotDefinitionStore } from '../../src/mms/bots/definitions/BotDefinitionStore'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { BOTS_MIGRATIONS, BotStore } from '../../src/mms/bots/store/BotStore'
import { BotScheduler, nextOccurrence, scheduleProblem } from '../../src/mms/bots/triggers/scheduler'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'
import type { BotDefinition, BotSchedule } from '../../src/shared/bots/personal/definition'

let base: string
let profile: string
let root: string
let clock: number
let store: BotStore
let runDb: ProfileDatabase
let runs: RunEngine
let host: BotEngineHost
let bots: BotEngine

const T0 = Date.parse('2026-10-27T09:00:00.000Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const tick = () => new Promise((resolve) => setImmediate(resolve))

const every5: BotSchedule = { id: 'tidy', when: { kind: 'interval', minutes: 5 }, prompt: 'Tidy the site.' }

const definition = (schedules: BotSchedule[] = [every5]): BotDefinition => ({
  id: 'site-editor',
  name: 'Site editor',
  role: 'You keep the site tidy.',
  main: { key: 'main', title: 'Main', agent: { instructions: 'Answer briefly.' }, selection: { instanceId: 'pi:openrouter', model: 'some/model' } },
  context: [],
  permissions: { tools: ['read'], appTools: [], mcp: [], skills: [], workspace: { roots: [root], access: 'read' }, budget: { maxActiveMs: 10 * MIN }, audience: 'owner' },
  triggers: { manual: true, schedules }
})

const publish = (schedules?: BotSchedule[]) => {
  const saved = bots.save(definition(schedules), bots.list().find((bot) => bot.id === 'site-editor')?.draftHash)
  return bots.publish('site-editor', saved.draftHash)
}
const approve = () => bots.approve('site-editor', botManifestDigest(bots.get('site-editor').published!.permissions))
// Oldest occurrence first (the test clock does not move, so creation times tie).
const activations = () => store.listActivations('site-editor').sort((a, b) => occurrence(a).localeCompare(occurrence(b)))
const occurrence = (row: { trigger: { kind: string } }) => ('occurrenceAt' in row.trigger ? String(row.trigger.occurrenceAt) : '')
const scheduleRow = () => store.scheduleStates('site-editor')[0]

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-schedules-')))
  profile = join(base, 'profile')
  root = join(base, 'site')
  mkdirSync(profile, { recursive: true })
  mkdirSync(root, { recursive: true })
  clock = T0
  store = new BotStore({ profileHome: profile, clock: () => clock })
  runDb = new ProfileDatabase({ profileHome: profile, clock: () => clock })
  const runStore = new RunStore(runDb)
  const now = () => new Date(clock).toISOString()
  const outbox = new EffectOutbox(runStore, { now })
  runs = new RunEngine({ store: runStore, outbox, tools: new ToolInvocations(runStore), now, pid: 1 })
  host = {
    profileHome: profile,
    store,
    definitions: new BotDefinitionStore(store.directory, (botId) => store.registry(botId)?.revision ?? null),
    threads: { ensureExecutionThread: (key) => ({ id: `thread:${key}` }) },
    runs: () => runs,
    harness: {
      checkPolicy: () => ({ ok: true }),
      nativeToolNames: (_instanceId, tools) => ({ ok: true, names: tools.flatMap((tool) => [...(PI_NATIVE_TOOLS[tool] ?? [])]) })
    },
    notifyEffects: () => {},
    stopThread: () => {},
    clock: () => clock,
    monotonic: () => clock,
    setTimer: () => ({ clear: () => {} })
  }
  bots = new BotEngine(host)
})

afterEach(() => {
  bots.close()
  store.close()
  runDb.close()
  rmSync(base, { recursive: true, force: true })
})

/** Publishes and approves the bot, runs the startup pass, and lets the first tick start the schedule at T0. */
async function scheduled(schedules?: BotSchedule[]) {
  publish(schedules)
  approve()
  await bots.reconcileOnStartup()
  await bots.tickSchedules(new Date(T0))
}

/** Ends an activation's main run as completed and lets the engine move on. */
async function complete(activationId: string) {
  const runId = store.dispatch(activationId, 1)!.runId!
  runs.markStarting(runId)
  runs.markRunning(runId)
  runs.markTerminal(runId, 'completed')
  bots.settleRun(runId)
  await tick()
  await tick()
}

describe('bot schedules', () => {
  it('the tick does nothing before the startup pass, and a new schedule starts from now', async () => {
    publish()
    approve()
    // Before the pass: no state, no activation, even far past any occurrence.
    expect(await bots.tickSchedules(new Date(T0 + 60 * MIN))).toEqual({ inserted: [] })
    expect(store.scheduleStates('site-editor')).toEqual([])
    await bots.reconcileOnStartup()
    expect(await bots.tickSchedules(new Date(T0))).toEqual({ inserted: [] })
    expect(scheduleRow()).toMatchObject({ scheduleId: 'tidy', nextRunAt: iso(T0 + 5 * MIN) })
    expect(activations()).toEqual([])
  })

  it('a due occurrence inserts one activation with its key, and the bot starts it', async () => {
    await scheduled()
    const { inserted } = await bots.tickSchedules(new Date(T0 + 5 * MIN))
    expect(inserted).toHaveLength(1)
    const [row] = activations()
    expect(row).toMatchObject({
      status: 'running',
      idempotencyKey: `sched:site-editor:tidy:${iso(T0 + 5 * MIN)}`,
      trigger: { kind: 'schedule', input: 'Tidy the site.', scheduleId: 'tidy', occurrenceAt: iso(T0 + 5 * MIN) }
    })
    expect(store.dispatch(row!.id, 1)).toMatchObject({ prompt: { text: 'Tidy the site.' } })
    expect(scheduleRow()!.nextRunAt).toBe(iso(T0 + 10 * MIN))
  })

  it('while the bot waits for its owner, ticks insert nothing: each occurrence is skipped and the owner told once', async () => {
    await scheduled()
    await bots.tickSchedules(new Date(T0 + 5 * MIN))
    const [first] = activations()
    bots.raiseWall(first!.id, { dispatchN: 1, kind: 'gate', permission: { tool: 'write' }, reason: 'I need to write.' })
    expect(store.activation(first!.id)!.status).toBe('waiting_grant')
    const changes: unknown[] = []
    bots.events.on('changed', (event) => changes.push(event))
    for (const at of [T0 + 5 * MIN, T0 + 6 * MIN, T0 + 10 * MIN, T0 + 15 * MIN, T0 + 20 * MIN])
      expect((await bots.tickSchedules(new Date(at))).inserted).toEqual([])
    expect(activations()).toHaveLength(1)
    // The skip is shown on the bot, and announced once, not once per occurrence.
    expect(bots.get('site-editor').summary.schedules).toEqual([{ id: 'tidy', nextRunAt: iso(T0 + 25 * MIN), skipped: { at: iso(T0 + 10 * MIN), reason: 'bot_waiting_for_owner' } }])
    expect(changes).toEqual([{ botId: 'site-editor' }])
    // Once the owner answered, the next occurrence runs again and the skip is cleared.
    store.run("UPDATE bot_activations SET status = 'done' WHERE id = ?", first!.id)
    expect((await bots.tickSchedules(new Date(T0 + 25 * MIN))).inserted).toHaveLength(1)
    expect(bots.get('site-editor').summary.schedules![0]!.skipped).toBeNull()
  })

  it('a schedule whose previous run still waits in the queue is skipped, never queued twice', async () => {
    await scheduled()
    publish([every5, { id: 'other', when: { kind: 'interval', minutes: 5 }, prompt: 'Check links.' }])
    approve()
    await bots.tickSchedules(new Date(T0 + 1000))
    await bots.tickSchedules(new Date(T0 + 5 * MIN))
    // `tidy` runs; `other` starts from this tick.
    await bots.tickSchedules(new Date(T0 + 10 * MIN))
    expect(activations().map((row) => [row.trigger.kind === 'schedule' && row.trigger.scheduleId, row.status])).toEqual([['tidy', 'running'], ['other', 'queued'], ['tidy', 'queued']])
    expect((await bots.tickSchedules(new Date(T0 + 15 * MIN))).inserted).toEqual([])
    expect(store.scheduleStates('site-editor').map((state) => [state.scheduleId, state.lastSkipReason])).toEqual([['other', 'previous_run_still_queued'], ['tidy', 'previous_run_still_queued']])
  })

  it('a crash after the insert: the next boot neither inserts it again nor dispatches it twice', async () => {
    await scheduled()
    await bots.tickSchedules(new Date(T0 + 5 * MIN))
    const [row] = activations()
    const runId = store.dispatch(row!.id, 1)!.runId!
    // Crash: the process is gone; the next one opens the same bots.db.
    bots.close()
    bots = new BotEngine(host)
    await bots.reconcileOnStartup()
    await bots.tickSchedules(new Date(T0 + 5 * MIN))
    // Even with the schedule's move lost, the same occurrence finds its activation and inserts nothing.
    store.putScheduleState('site-editor', 'tidy', store.scheduleStates('site-editor')[0]!.spec, iso(T0 + 5 * MIN))
    expect((await bots.tickSchedules(new Date(T0 + 5 * MIN + 1000))).inserted).toEqual([])
    expect(activations()).toHaveLength(1)
    expect(store.dispatches(row!.id)).toHaveLength(1)
    expect(store.dispatch(row!.id, 1)!.runId).toBe(runId)
    expect(scheduleRow()!.nextRunAt).toBe(iso(T0 + 10 * MIN))
  })

  it('occurrences missed while Mousse was closed collapse into one catch-up occurrence', async () => {
    await scheduled()
    const { inserted } = await bots.tickSchedules(new Date(T0 + 120 * MIN + 7000))
    expect(inserted).toHaveLength(1)
    expect(activations()[0]!.trigger).toMatchObject({ kind: 'schedule', occurrenceAt: iso(T0 + 5 * MIN) })
    // The next occurrence is after now, not the next missed one.
    expect(scheduleRow()!.nextRunAt).toBe(iso(T0 + 125 * MIN + 7000))
    expect((await bots.tickSchedules(new Date(T0 + 121 * MIN))).inserted).toEqual([])
  })

  it('an occurrence while the bot runs waits in its queue and starts when the bot is free', async () => {
    await scheduled()
    await bots.tickSchedules(new Date(T0 + 5 * MIN))
    await bots.tickSchedules(new Date(T0 + 10 * MIN))
    const [first, second] = activations()
    expect([first!.status, second!.status]).toEqual(['running', 'queued'])
    await complete(first!.id)
    expect(store.activation(first!.id)!.status).toBe('done')
    expect(store.activation(second!.id)!.status).toBe('running')
  })

  it('a bot that needs approval skips the occurrence, and approving later runs no backlog', async () => {
    publish()
    await bots.reconcileOnStartup()
    await bots.tickSchedules(new Date(T0))
    expect((await bots.tickSchedules(new Date(T0 + 5 * MIN))).inserted).toEqual([])
    expect(scheduleRow()!.nextRunAt).toBe(iso(T0 + 10 * MIN))
    approve()
    expect((await bots.tickSchedules(new Date(T0 + 6 * MIN))).inserted).toEqual([])
    expect((await bots.tickSchedules(new Date(T0 + 10 * MIN))).inserted).toHaveLength(1)
  })

  it('an edited schedule restarts from now; a removed one forgets its state', async () => {
    await scheduled()
    publish([{ ...every5, when: { kind: 'interval', minutes: 60 } }])
    approve()
    await bots.tickSchedules(new Date(T0 + 4 * MIN))
    expect(scheduleRow()!.nextRunAt).toBe(iso(T0 + 64 * MIN))
    expect((await bots.tickSchedules(new Date(T0 + 5 * MIN))).inserted).toEqual([])
    publish([])
    await bots.tickSchedules(new Date(T0 + 6 * MIN))
    expect(store.scheduleStates('site-editor')).toEqual([])
  })

  it('a cron with a step of 0 or a value out of range is refused at publish at once, never searched', () => {
    const started = Date.now()
    for (const expr of ['1-5/0 * * * *', '*/0 * * * *', '0 1-3/0 * * *', 'a b c d e', '60 * * * *', '0 24 * * *', '0 0 0 * *', '5-1 * * * *'])
      expect(scheduleProblem({ id: 'x', when: { kind: 'cron', expr }, prompt: 'p' }), expr).toMatch(/invalid/)
    const saved = bots.save(definition([{ id: 'bad', when: { kind: 'cron', expr: '1-5/0 * * * *' }, prompt: 'p' }]))
    expect(() => bots.publish('site-editor', saved.draftHash)).toThrow(/invalid/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('a malformed schedule is refused at publish', () => {
    expect(scheduleProblem({ id: 'x', when: { kind: 'interval', minutes: 0 }, prompt: 'p' })).toMatch(/at least 1/)
    expect(scheduleProblem({ id: 'x', when: { kind: 'cron', expr: '* * *' }, prompt: 'p' })).toMatch(/five fields/)
    expect(scheduleProblem({ id: 'x', when: { kind: 'cron', expr: '0 9 * * 1' }, prompt: '' })).toMatch(/something to do/)
    expect(scheduleProblem({ id: 'x', when: { kind: 'cron', expr: '0 9 * * 1' }, prompt: 'p' })).toBeUndefined()
    const saved = bots.save({ ...definition([every5, every5]) })
    expect(() => bots.publish('site-editor', saved.draftHash)).toThrow(/own id/)
  })

  it('one bot that cannot be read never stops the others\' schedules', async () => {
    await scheduled()
    const other = bots.save({ ...definition([{ id: 'hourly', when: { kind: 'interval', minutes: 60 }, prompt: 'Report.' }]), id: 'reporter', name: 'Reporter' })
    bots.publish('reporter', other.draftHash)
    bots.approve('reporter', botManifestDigest(bots.get('reporter').published!.permissions))
    await bots.tickSchedules(new Date(T0))
    const revision = host.definitions.revision.bind(host.definitions)
    vi.spyOn(host.definitions, 'revision').mockImplementation((botId, rev) => {
      if (botId === 'site-editor') throw new Error('Unexpected token in JSON')
      return revision(botId, rev)
    })
    const { inserted } = await bots.tickSchedules(new Date(T0 + 60 * MIN))
    expect(inserted).toHaveLength(1)
    expect(store.activation(inserted[0]!)!.botId).toBe('reporter')
  })

  it('a start that fails during a tick is tried again by the next tick, never left queued', async () => {
    await scheduled()
    const pump = vi.spyOn(bots as unknown as { pump(botId: string): Promise<void> }, 'pump').mockRejectedValueOnce(new Error('SQLITE_BUSY'))
    const { inserted } = await bots.tickSchedules(new Date(T0 + 5 * MIN))
    expect(store.activation(inserted[0]!)!.status).toBe('queued')
    pump.mockRestore()
    expect((await bots.tickSchedules(new Date(T0 + 6 * MIN))).inserted).toEqual([])
    expect(store.activation(inserted[0]!)!.status).toBe('running')
  })

  it('publishing tells the scheduler, so a new schedule is read at once', () => {
    let told = 0
    bots.close()
    bots = new BotEngine({ ...host, schedulesChanged: () => { told += 1 } })
    publish()
    expect(told).toBe(1)
  })

  it('nextOccurrence keeps the cadence when on time and collapses when late', () => {
    expect(nextOccurrence(every5, iso(T0), new Date(T0 + 1000))).toBe(iso(T0 + 5 * MIN))
    expect(nextOccurrence(every5, iso(T0), new Date(T0 + 30 * MIN))).toBe(iso(T0 + 35 * MIN))
  })

  it('the scheduler ticks once started, and again on wake', async () => {
    const seen: number[] = []
    const scheduler = new BotScheduler({ tick: async (now) => { seen.push(now.getTime()) }, clock: () => clock, intervalMs: 60 * 60_000 })
    await scheduler.wake()
    expect(seen).toEqual([])
    scheduler.start()
    await tick()
    clock += 1000
    await scheduler.wake()
    scheduler.stop()
    expect(seen).toEqual([T0, T0 + 1000])
  })
})

describe('activation requests', () => {
  it('two deliveries of one request at the same time give one activation, and no error', async () => {
    publish([])
    approve()
    const input = { botId: 'site-editor', input: 'Fix it', clientRequestId: 'c2' }
    // The second delivery reads no activation yet, then finds the first one's at its insert.
    const byKey = store.activationByKey.bind(store)
    let reads = 0
    vi.spyOn(store, 'activationByKey').mockImplementation((key) => (++reads === 1 ? undefined : byKey(key)))
    const [a, b] = await Promise.all([bots.activate(input), bots.activate(input)])
    expect(a.id).toBe(b.id)
    expect(store.listActivations('site-editor')).toHaveLength(1)
  })
})

describe('bots.db v3', () => {
  it('a populated v2 database migrates and keeps its activations', () => {
    const home = join(base, 'v2-profile')
    mkdirSync(home, { recursive: true })
    const v2 = new ProfileDatabase({ profileHome: home, name: 'bots', clock: () => clock })
    v2.migrate(BOTS_MIGRATIONS.slice(0, 2))
    v2.statement("INSERT INTO bot_registry(bot_id, revision, created_at) VALUES('site-editor', 'r1', 'x')").run()
    for (const [id, status] of [['act_done', 'done'], ['act_wait', 'waiting_grant']])
      v2.statement("INSERT INTO bot_activations(id, bot_id, revision, grant_digest, trigger_json, idempotency_key, status, created_at, result) VALUES(?, 'site-editor', 'r1', 'g', ?, ?, ?, 'x', 'Done.')")
        .run(id, JSON.stringify({ kind: 'manual', input: 'Fix it' }), `manual:${id}`, status)
    v2.statement("INSERT INTO bot_escalations(id, activation_id, dispatch_n, kind, permission_json, reason, status, created_at, expires_at) VALUES('esc_1', 'act_wait', 1, 'gate', '{}', 'r', 'open', 'x', 'y')").run()
    v2.close()
    const v3 = new BotStore({ profileHome: home, clock: () => clock })
    try {
      expect(v3.activation('act_done')).toMatchObject({ status: 'done', result: 'Done.', trigger: { kind: 'manual', input: 'Fix it' } })
      expect(v3.activation('act_wait')!.status).toBe('waiting_grant')
      expect(v3.escalations({ activationId: 'act_wait', status: 'open' })).toHaveLength(1)
      // `reply_status` stays in the schema (the removed Channels feature wrote it).
      expect(v3.all("SELECT reply_status FROM bot_activations WHERE id = 'act_done'")).toEqual([{ reply_status: null }])
      v3.putScheduleState('site-editor', 'tidy', '{}', iso(T0))
      v3.setScheduleSkip('site-editor', 'tidy', 'bot_waiting_for_owner', iso(T0))
      expect(v3.scheduleStates('site-editor')).toEqual([{ scheduleId: 'tidy', spec: '{}', nextRunAt: iso(T0), lastSkipAt: iso(T0), lastSkipReason: 'bot_waiting_for_owner' }])
    } finally {
      v3.close()
    }
  })
})
