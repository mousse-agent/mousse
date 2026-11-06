/**
 * A bot engine over a real `bots.db` and run database, with fakes for the Bot Phase 1 seams
 * (docs/plans/bot-architecture.md §7.1): the model resolver, the context packs and capture, the
 * journal, chips, memory, and the host's thread operations. Shared by the Bot Phase 1 engine tests.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotEngine, type BotEngineHost } from '../../src/mms/bots/activation/BotEngine'
import { BotDefinitionStore } from '../../src/mms/bots/definitions/BotDefinitionStore'
import type { BotDispatchEnd, BotJournalInput, BotModelProblem } from '../../src/mms/bots/seams'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'
import { isBotTurnPayload, type BotTurnPayload, type RunOutcome } from '../../src/mms/run/types'
import type { BotChip } from '../../src/shared/bots/personal/chat'
import type { BotModelChoice } from '../../src/shared/bots/personal/definition'
import type { ProviderSelection } from '../../src/shared/harness/types'
import type { PreparedBotTurn } from '../../src/mms/bots/activation/dispatcher'

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
  /** Candidates the fake resolver walks, in order; a limited one is skipped until its time. */
  candidates: ProviderSelection[]
  limited: Map<string, string>
  /** What the resolver answers instead of a candidate, when set. */
  problem: { problem: BotModelProblem; until?: string; instanceId?: string } | undefined
  resolved: Array<{ choice: BotModelChoice; override?: BotModelChoice }>
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
  /** Chips the fake sink rolls up per dispatch (run id). */
  chips: Map<string, BotChip[]>
  allowed: Array<{ tool: string; dispatchId: string }>
  timers: Array<{ fn: () => void; ms: number }>
  oneShot: { answer?: string; fail?: boolean; never?: boolean; prompts: string[] }
  journalFails: { capture: boolean; append: boolean }
  close(): void
}

export function botFixture(): BotFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-p1-')))
  const profile = join(base, 'profile')
  mkdirSync(profile, { recursive: true })
  const clock = { now: T0 }
  const store = new BotStore({ profileHome: profile, clock: () => clock.now })
  const runDb = new ProfileDatabase({ profileHome: profile, clock: () => clock.now })
  const runStore = new RunStore(runDb)
  const now = () => new Date(clock.now).toISOString()
  const outbox = new EffectOutbox(runStore, { now })
  const runs = new RunEngine({ store: runStore, outbox, tools: new ToolInvocations(runStore), now, pid: 1 })
  const fixture = {
    base, profile, clock, store, runs, outbox,
    candidates: [PI], limited: new Map<string, string>(), problem: undefined,
    resolved: [], journal: [], outsideTx: [], cleared: [], archived: [], trashed: [], purged: [], stopped: [],
    afterDispatch: [], packs: [], chips: new Map(), allowed: [], timers: [],
    oneShot: { prompts: [] }, journalFails: { capture: false, append: false }
  } as unknown as BotFixture
  const host: BotEngineHost = {
    profileHome: profile,
    store,
    definitions: new BotDefinitionStore(store.directory, (botId) => store.registry(botId)?.revision ?? null),
    threads: { ensureExecutionThread: (key) => ({ id: `thread:${key}` }) },
    runs: () => runs,
    harness: {
      checkPolicy: () => ({ ok: true }),
      nativeToolNames: (_instanceId, tools) => ({ ok: true, names: tools.flatMap((tool) => [...(PI_NATIVE_TOOLS[tool] ?? [tool])]) })
    },
    notifyEffects: () => {},
    stopThread: (threadId) => { fixture.stopped.push(threadId) },
    clock: () => clock.now,
    monotonic: () => clock.now,
    setTimer: (fn, ms) => {
      fixture.timers.push({ fn, ms })
      return { clear: () => {} }
    },
    models: {
      resolve: async (input) => {
        fixture.resolved.push({ choice: input.choice, ...(input.override ? { override: input.override } : {}) })
        if (fixture.problem) return fixture.problem
        const free = fixture.candidates.filter((candidate) => {
          const until = fixture.limited.get(candidate.instanceId)
          return !until || Date.parse(until) <= clock.now
        })
        const depth = (input.override ?? input.choice).depth
        if (!free.length) {
          const until = [...fixture.limited.values()].sort()[0]
          return { problem: 'all_limited', ...(until ? { until } : {}), instanceId: fixture.candidates[0]?.instanceId }
        }
        return { selection: { ...free[0]!, ...(depth === 'deep' ? { effort: 'high' } : depth === 'quick' ? { effort: 'low' } : {}) } }
      },
      markLimited: (instanceId, until) => { fixture.limited.set(instanceId, until) }
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
      drain: (dispatchId) => fixture.chips.get(dispatchId) ?? []
    },
    memory: {
      list: () => ({ entries: [], gauge: 'core 0/2,000' }),
      forget: () => ({ redacted: [] }),
      export: async () => ({ files: [] }),
      reindex: async () => {},
      purge: async (botId) => { fixture.purged.push(botId) }
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
  fixture.host = host
  fixture.bots = new BotEngine(host)
  fixture.close = () => {
    fixture.bots.close()
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

/** The run ends and the executor settles it with its final message; then everything that follows runs. */
export async function finish(f: BotFixture, payload: BotTurnPayload, status: 'completed' | 'failed' | 'interrupted' = 'completed', options: { text?: string; outcome?: RunOutcome } = {}): Promise<void> {
  f.runs.markTerminal(payload.runId, status, options.outcome)
  f.bots.settle(payload, options.text !== undefined ? { text: options.text } : {})
  await flush()
}

/** One whole dispatch: started, ended, settled. */
export async function runDispatch(f: BotFixture, activationId: string, n = 1, options: { status?: 'completed' | 'failed' | 'interrupted'; text?: string; outcome?: RunOutcome; during?: (prepared: PreparedBotTurn) => void } = {}): Promise<PreparedBotTurn> {
  const { payload, prepared } = await start(f, activationId, n)
  options.during?.(prepared)
  await finish(f, payload, options.status ?? 'completed', { ...(options.text !== undefined ? { text: options.text } : {}), ...(options.outcome ? { outcome: options.outcome } : {}) })
  return prepared
}

/** A new bot through `bots.create`, its first chat message answered with `reply`. */
export async function createBot(f: BotFixture, options: { name?: string; description?: string; reply?: string } = {}): Promise<{ botId: string; firstActivation: string }> {
  const { bot } = await f.bots.service.create({ look: { colour: 'teal', accessory: 'cap' }, ...(options.name ? { name: options.name } : {}), description: options.description ?? 'Check my inbox every morning and tell me what matters.', clientRequestId: `create-${Math.random().toString(16).slice(2)}` })
  const first = f.store.listActivations(bot.id).find((activation) => activation.lane === 'chat')!
  if (options.reply !== undefined) await runDispatch(f, first.id, 1, { text: options.reply })
  return { botId: bot.id, firstActivation: first.id }
}

/** The bot's chat as rows. */
export function chatOf(f: BotFixture, botId: string) {
  return f.bots.service.chatList(botId, { limit: 100 }).messages
}
