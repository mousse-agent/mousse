import { tellMeOf, type ScheduledJob } from '../../src/shared/types'
/**
 * A bot engine over a real `bots.db` and run database, with fakes for the Bot Phase 1 seams
 * (docs/plans/bot-architecture.md §7.1): the model resolver, the context packs and capture, the
 * journal, chips, memory, and the host's thread operations. Shared by the Bot Phase 1 engine tests.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { BotEngine, type BotEngineHost } from '../../src/mms/bots/activation/BotEngine'
import { BotDefinitionStore } from '../../src/mms/bots/definitions/BotDefinitionStore'
import type { BotActivityCalls, BotDispatchEnd, BotJournalInput, BotModelProblem, BotPickMiss } from '../../src/mms/bots/seams'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'
import { isBotTurnPayload, type BotTurnPayload, type RunOutcome } from '../../src/mms/run/types'
import type { BotChip, BotLaunchedThread } from '../../src/shared/bots/personal/chat'
import type { BotDepth, BotModelPick } from '../../src/shared/bots/personal/definition'
import type { BotDeviceAccess } from '../../src/shared/bots/personal/deviceAccess'
import type { ProviderSelection } from '../../src/shared/harness/types'
import type { PreparedBotTurn } from '../../src/mms/bots/activation/dispatcher'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { ScheduledJobStore } from '../../src/mms/scheduled/ScheduledJobStore'
import { ScheduledJobService } from '../../src/mms/scheduled/ScheduledJobService'
import { BotScheduleBook } from '../../src/mms/scheduled/botJobs'
import { AutomationRuns } from '../../src/mms/automations/AutomationRuns'

export const T0 = Date.parse('2026-11-07T09:00:00.000Z')
export const PI: ProviderSelection = { instanceId: 'pi:openrouter', model: 'some/model' }

export interface BotFixture {
  base: string
  profile: string
  clock: { now: number }
  store: BotStore
  runs: RunEngine
  outbox: EffectOutbox
  bots: BotEngine
  host: BotEngineHost
  /** The one shared scheduler (a real `ScheduledJobService` over a temporary home), on the fixture's clock. */
  scheduler: ScheduledJobService
  /** The scheduler's store, for what only it does (a request URL's delivery). */
  jobStore: ScheduledJobStore
  /** Bots' schedules in the shared store. */
  book: BotScheduleBook
  /** The Automations run log the scheduler records into, as in the app: where a run's `run_report` level is kept. */
  automationRuns: AutomationRuns
  /** One tick of the shared scheduler at `now` (the fixture's clock moves there), and the schedule activations it inserted. */
  tickSchedules(now?: Date): Promise<{ inserted: string[] }>
  /** Candidates the fake resolver walks, in order; a limited one is skipped until its time. */
  candidates: ProviderSelection[]
  limited: Map<string, string>
  /** What the resolver answers instead of a candidate, when set. */
  problem: { problem: BotModelProblem; until?: string; instanceId?: string } | undefined
  /** What each resolve was asked: the turn's pick (null: Automatic) and depth. */
  resolved: Array<{ pick: BotModelPick | null; depth: BotDepth }>
  /** A pick that can't run, and why (the resolver then answers `pick_unavailable` with `missed`). */
  pickMiss?: (pick: BotModelPick) => BotPickMiss | undefined
  /** The threads the bot's threads started that still work (`BotEngineHost.launchedThreads`); absent: none. */
  launched?: (creators: ReadonlySet<string>) => BotLaunchedThread[]
  journal: BotJournalInput[]
  /** Journal rows written outside a transaction (must stay empty). */
  outsideTx: BotJournalInput[]
  cleared: string[]
  archived: string[]
  trashed: string[]
  purged: string[]
  stopped: string[]
  afterDispatch: Array<{ activationId: string; lane: 'chat' | 'run'; threadId: string; endedBy: BotDispatchEnd }>
  packs: Array<{ lane: 'chat' | 'run'; activationId: string; scheduleId?: string }>
  /** Chips the fake sink rolls up per dispatch (`<activationId>:d<n>`). */
  chips: Map<string, BotChip[]>
  /** The calls behind those chips (`drainCalls`), when a test sets them; absent: the sink gives chips only. */
  calls: Map<string, BotActivityCalls>
  allowed: Array<{ tool: string; dispatchId: string }>
  timers: Array<{ fn: () => void; ms: number }>
  oneShot: { answer?: string; fail?: boolean; never?: boolean; prompts: string[] }
  journalFails: { capture: boolean; append: boolean }
  /**
   * Mousse restarts: the bot engine closes, the run database and `bots.db` are closed and opened again, the run engine boots
   * (`reconcileOnBoot`, a new daemon epoch) and then the bot engine (`reconcileOnStartup`), as `MmsProfileServices` does.
   * `crashed`: the last process never shut down (its daemon epoch has no end, and its runs are cut off by the boot);
   * otherwise it shut down cleanly first. `down`: how long Mousse was down (the clock moves on by it before the boot).
   * `whileDown`: runs while both databases are closed (an older build's files, say), given the paths of the run database
   * and `bots.db`.
   */
  restart(options?: { crashed?: boolean; down?: number; whileDown?: (paths: { runDb: string; botsDb: string }) => void }): Promise<void>
  close(): void
}

export function botFixture(options: Pick<BotEngineHost, 'spawnWatcher' | 'deviceAccess'> & { realWipe?: boolean } = {}): BotFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-p1-')))
  const profile = join(base, 'profile')
  mkdirSync(profile, { recursive: true })
  const clock = { now: T0 }
  let store = new BotStore({ profileHome: profile, clock: () => clock.now })
  let runDb = new ProfileDatabase({ profileHome: profile, clock: () => clock.now })
  const now = () => new Date(clock.now).toISOString()
  const openRuns = (pid: number) => {
    const runStore = new RunStore(runDb)
    const outbox = new EffectOutbox(runStore, { now })
    return { outbox, runs: new RunEngine({ store: runStore, outbox, tools: new ToolInvocations(runStore), now, pid }) }
  }
  let { outbox, runs } = openRuns(1)
  // This process's daemon epoch, as a profile's boot opens it.
  runs.reconcileOnBoot()
  const fixture = {
    base, profile, clock, store, runs, outbox,
    candidates: [PI], limited: new Map<string, string>(), problem: undefined,
    resolved: [], journal: [], outsideTx: [], cleared: [], archived: [], trashed: [], purged: [], stopped: [],
    afterDispatch: [], packs: [], chips: new Map(), calls: new Map(), allowed: [], timers: [],
    oneShot: { prompts: [] }, journalFails: { capture: false, append: false }
  } as unknown as BotFixture
  const host: BotEngineHost = {
    profileHome: profile,
    ...options,
    store,
    definitions: new BotDefinitionStore(store.directory, (botId) => fixture.store.registry(botId)?.revision ?? null),
    threads: { ensureExecutionThread: (key) => ({ id: `thread:${key}` }), discardUnusedThread: () => {} },
    runs: () => runs,
    launchedThreads: (creators) => fixture.launched?.(creators) ?? [],
    harness: {
      checkPolicy: () => ({ ok: true }),
      nativeToolNames: (_instanceId, tools) => ({ ok: true, names: tools.flatMap((tool) => [...(PI_NATIVE_TOOLS[tool] ?? [tool])]) })
    },
    notifyEffects: () => {},
    stopThread: (threadId) => { fixture.stopped.push(threadId) },
    clock: () => clock.now,
    monotonic: () => clock.now,
    // Notices start as soon as the lane is free; tests of the settle set their own.
    noticeSettleMs: 0,
    setTimer: (fn, ms) => {
      fixture.timers.push({ fn, ms })
      return { clear: () => {} }
    },
    models: {
      resolve: async (input) => {
        fixture.resolved.push({ pick: input.pick, depth: input.depth })
        if (fixture.problem) return fixture.problem
        // A pick on its entry runs there or not at all, as `BotModelChooser` does: one that can't run is a problem, and
        // one on a limited entry waits for its reset.
        if (input.pick?.instanceId) {
          const missed = fixture.pickMiss?.(input.pick)
          if (missed) return { problem: 'pick_unavailable', missed }
          const until = fixture.limited.get(input.pick.instanceId)
          if (until && Date.parse(until) > clock.now) return { problem: 'all_limited', until, instanceId: input.pick.instanceId }
          return { selection: { instanceId: input.pick.instanceId, model: input.pick.model, ...(input.pick.effort ? { effort: input.pick.effort } : {}) } }
        }
        const free = fixture.candidates.filter((candidate) => {
          const until = fixture.limited.get(candidate.instanceId)
          return !until || Date.parse(until) <= clock.now
        })
        const depth = input.depth
        if (!free.length) {
          const until = [...fixture.limited.values()].sort()[0]
          return { problem: 'all_limited', ...(until ? { until } : {}), instanceId: fixture.candidates[0]?.instanceId }
        }
        // A bot from before picks: the depth's effort on the first free candidate.
        return { selection: { ...free[0]!, ...(depth === 'deep' ? { effort: 'high' } : depth === 'quick' ? { effort: 'low' } : {}) } }
      },
      markLimited: (instanceId, until) => { fixture.limited.set(instanceId, until) },
      clearLimited: (instanceId) => { fixture.limited.delete(instanceId) }
    },
    context: {
      chatPreamble: async ({ activationId }) => {
        fixture.packs.push({ lane: 'chat', activationId })
        return `<bot_memory>chat pack ${activationId}</bot_memory>`
      },
      runPreamble: async ({ activationId, scheduleId }) => {
        fixture.packs.push({ lane: 'run', activationId, ...(scheduleId ? { scheduleId } : {}) })
        return `<bot_memory>run pack ${scheduleId ?? 'manual'}</bot_memory>`
      },
      afterDispatch: async (event) => {
        fixture.afterDispatch.push({ activationId: event.activationId, lane: event.lane, threadId: event.threadId, endedBy: event.endedBy })
        if (fixture.journalFails.capture) throw Object.assign(new Error('disk full'), { code: 'bot_journal_failed' })
      }
    },
    journal: {
      appendInTx: (tx, row) => {
        if (fixture.journalFails.append) throw Object.assign(new Error('disk full'), { code: 'bot_journal_failed' })
        if (!tx.inTransaction) fixture.outsideTx.push(row)
        fixture.journal.push(row)
      },
      syncThread: async () => {},
      catchUp: async () => { fixture.journal.push({ botId: '*', kind: 'notice', sourceKey: 'catchUp', who: 'mousse', text: 'catch up' }) }
    },
    activity: {
      onAllowed: (ctx, call) => { fixture.allowed.push({ tool: call.tool, dispatchId: ctx.dispatchId }) },
      onAppResult: () => {},
      drain: (dispatchId) => fixture.chips.get(dispatchId) ?? [],
      drainCalls: (dispatchId) => {
        const calls = fixture.calls.get(dispatchId)
        return { chips: fixture.chips.get(dispatchId) ?? [], ...(calls ? { calls } : {}) }
      }
    },
    memory: {
      list: () => ({ entries: [], gauge: 'core 0/2,000' }),
      forget: () => ({ redacted: [] }),
      edit: (_botId, id) => { throw Object.assign(new Error(`There is no memory entry ${id}.`), { code: 'not_found' }) },
      export: async () => ({ files: [] }),
      reindex: async () => {},
      purge: async (botId) => { fixture.purged.push(botId) },
      forgetAll: () => 0,
      wipeHistory: (botId) => options.realWipe ? new BotMemoryStore({ db: fixture.store.db }).wipe(botId, true) : 0,
      reset: () => {}
    },
    clearContext: (threadId) => { fixture.cleared.push(threadId) },
    archiveThread: (threadId) => { fixture.archived.push(threadId) },
    trashThread: async (threadId) => { fixture.trashed.push(threadId) },
    oneShot: async ({ prompt, signal }) => {
      fixture.oneShot.prompts.push(prompt)
      if (fixture.oneShot.never) return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timed out'))))
      if (fixture.oneShot.fail) throw new Error('model failed')
      return fixture.oneShot.answer ?? 'Inbox Helper'
    },
    scheduleLabel: (when) => (when.kind === 'cron' && when.expr === '0 9 * * 1-5' ? 'every weekday · 09:00' : when.kind === 'interval' ? `every ${when.minutes} minutes` : when.expr),
    providerLabel: (instanceId) => (instanceId.startsWith('claude') ? 'Claude' : 'OpenAI')
  }
  // The one scheduler: bots' schedules are jobs in the shared store, handed to the engine's run lane.
  const jobStore = new ScheduledJobStore(MousseConfigStore.load(join(base, 'mousse-home')))
  const scheduler = new ScheduledJobService({ runIsolated: async () => { throw new Error('bot tests run no agent jobs') } }, jobStore)
  scheduler.setClock(() => new Date(clock.now))
  const book = new BotScheduleBook({ jobs: scheduler, label: (when) => host.scheduleLabel!(when), now: () => new Date(clock.now) })
  host.schedules = book
  const automationRuns = new AutomationRuns({ profileHome: profile, clock: () => clock.now, botReportLevel: (id, level) => fixture.bots?.scheduledReportLevel(id, level) ?? level })
  scheduler.setRunLedger(automationRuns)
  host.runLevel = (activationId) => automationRuns.levelOfActivation(activationId)
  fixture.scheduler = scheduler
  fixture.jobStore = jobStore
  fixture.book = book
  fixture.automationRuns = automationRuns
  fixture.host = host
  fixture.bots = new BotEngine(host)
  // A work's subagents run on the run engine's delegations, through the bots' port (as `MmsProfileServices` wires it).
  runs.setBotPort(fixture.bots)
  scheduler.on('jobRemoved', (_id: string, job: ScheduledJob) => {
    if (job.bot) fixture.bots.scheduleRemoved(job.bot.botId, job.bot.scheduleId, { tellMe: tellMeOf(job) })
  })
  scheduler.setBotRunner({ editSchedule: (botId, save) => fixture.bots.editSchedule(botId, save), findOccurrence: (input) => fixture.bots.findScheduledOccurrence(input), runOccurrence: (input) => fixture.bots.runScheduledOccurrence(input) })
  scheduler.setTickHook((now) => fixture.bots.maintain(now))
  fixture.tickSchedules = async (now) => {
    if (now) clock.now = now.getTime()
    const before = new Set(store.listActivations().map((row) => row.id))
    await scheduler.tickNow()
    await flush()
    return { inserted: store.listActivations().filter((row) => !before.has(row.id) && row.trigger.kind === 'schedule').map((row) => row.id) }
  }
  let pid = 1
  fixture.restart = async (restart = {}) => {
    fixture.bots.close()
    if (!restart.crashed) {
      // A clean shutdown interrupts what still runs (as the profile's close does), then ends the daemon's epoch.
      for (const run of runs.store.listNonTerminalRuns())
        runs.markTerminal(run.runId, run.status === 'queued' ? 'cancelled' : 'interrupted', run.status === 'queued' ? { error: 'daemon_restart' } : { interruptedBy: 'daemon_restart' })
      runs.shutdown()
    }
    const paths = { runDb: runDb.path, botsDb: store.db.path }
    store.close()
    runDb.close()
    restart.whileDown?.(paths)
    clock.now += restart.down ?? 0
    pid += 1
    runDb = new ProfileDatabase({ profileHome: profile, clock: () => clock.now })
    ;({ outbox, runs } = openRuns(pid))
    runs.reconcileOnBoot()
    store = new BotStore({ profileHome: profile, clock: () => clock.now })
    Object.assign(fixture, { store, runs, outbox })
    host.store = store
    fixture.bots = new BotEngine(host)
    runs.setBotPort(fixture.bots)
    await fixture.bots.reconcileOnStartup()
    await flush(12)
  }
  fixture.close = () => {
    scheduler.beginShutdown()
    fixture.bots.close()
    automationRuns.close()
    store.close()
    runDb.close()
    rmSync(base, { recursive: true, force: true })
  }
  return fixture
}

/** Lets queued promise work (afterDispatch, advance, pump) run. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

export function payloadOf(f: BotFixture, activationId: string, n = 1): BotTurnPayload {
  const dispatch = f.store.dispatch(activationId, n)
  if (!dispatch?.runId) throw new Error(`dispatch ${activationId}:${n} has no run`)
  const effect = f.outbox.listForRun(dispatch.runId).find((entry) => entry.kind === 'turn.start')!
  if (!isBotTurnPayload(effect.payload)) throw new Error('not a bot payload')
  return effect.payload
}

/** `prepare` as the executor calls it (after `refresh`), and the run starts. */
export async function start(f: BotFixture, activationId: string, n = 1): Promise<{ payload: BotTurnPayload; prepared: PreparedBotTurn }> {
  const payload = payloadOf(f, activationId, n)
  await f.bots.refresh(payload)
  const prepared = f.bots.prepare(payload)
  if ('refused' in prepared) throw new Error(`${prepared.code}: ${prepared.refused}`)
  f.runs.markStarting(payload.runId)
  f.runs.markRunning(payload.runId)
  return { payload, prepared }
}

/**
 * The run ends and the executor settles it with its final message; then everything that follows runs. A work
 * subagent's final message is its run's result, kept in the run's terminal write as the orchestrator keeps it, and the
 * reconciler's pass hands what its delegation published to the bots (`deliverBotResults`).
 */
export async function finish(f: BotFixture, payload: BotTurnPayload, status: 'completed' | 'failed' | 'interrupted' = 'completed', options: { text?: string; messageId?: string; outcome?: RunOutcome; unanswered?: boolean } = {}): Promise<void> {
  f.runs.markTerminal(payload.runId, status, options.outcome, payload.delegationId !== undefined && options.text !== undefined ? { resultText: options.text } : undefined)
  f.bots.settle(payload, { ...(options.text !== undefined ? { text: options.text } : {}), ...(options.messageId ? { messageId: options.messageId } : {}), ...(options.unanswered ? { unanswered: true } : {}) })
  f.runs.deliverBotResults()
  await flush()
}

/** A work's subagent turns: the child runs of its delegations in the run database, oldest first. */
export function subagentRuns(f: BotFixture, activationId: string): string[] {
  return f.runs.delegations.listForRootActivation(activationId).map((delegation) => delegation.childRunId)
}

/** A work subagent's turn as the executor starts it: its delegation's bot `turn.start`, refreshed and prepared. */
export async function startSubagent(f: BotFixture, childRunId: string): Promise<{ payload: BotTurnPayload; prepared: PreparedBotTurn }> {
  const effect = f.outbox.listForRun(childRunId).find((entry) => entry.kind === 'turn.start')!
  if (!isBotTurnPayload(effect.payload) || effect.payload.delegationId === undefined) throw new Error('not a bot subagent payload')
  const payload = effect.payload
  await f.bots.refresh(payload)
  const prepared = f.bots.prepare(payload)
  if ('refused' in prepared) throw new Error(`${prepared.code}: ${prepared.refused}`)
  f.runs.markStarting(payload.runId)
  f.runs.markRunning(payload.runId)
  return { payload, prepared }
}

/** One whole dispatch: started, ended, settled. */
export async function runDispatch(f: BotFixture, activationId: string, n = 1, options: { status?: 'completed' | 'failed' | 'interrupted'; text?: string; outcome?: RunOutcome; during?: (prepared: PreparedBotTurn) => void } = {}): Promise<PreparedBotTurn> {
  const { payload, prepared } = await start(f, activationId, n)
  options.during?.(prepared)
  await finish(f, payload, options.status ?? 'completed', { ...(options.text !== undefined ? { text: options.text } : {}), ...(options.outcome ? { outcome: options.outcome } : {}) })
  return prepared
}

/** A new bot through `bots.create`, its first chat message answered with `reply`. */
export async function createBot(f: BotFixture, options: { name?: string; description?: string; reply?: string; access?: BotDeviceAccess; clientRequestId?: string } = {}): Promise<{ botId: string; firstActivation: string }> {
  const { bot } = await f.bots.service.create({ look: { colour: 'teal', accessory: 'cap' }, ...(options.name ? { name: options.name } : {}), description: options.description ?? 'Check my inbox every morning and tell me what matters.', clientRequestId: options.clientRequestId ?? `create-${Math.random().toString(16).slice(2)}`, ...(options.access ? { access: options.access } : {}) })
  const first = f.store.listActivations(bot.id).find((activation) => activation.lane === 'chat')!
  if (options.reply !== undefined) await runDispatch(f, first.id, 1, { text: options.reply })
  return { botId: bot.id, firstActivation: first.id }
}

/** The bot's chat as rows. */
export function chatOf(f: BotFixture, botId: string) {
  return f.bots.service.chatList(botId, { limit: 100 }).messages
}
