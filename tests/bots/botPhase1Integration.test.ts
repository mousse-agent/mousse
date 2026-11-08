/**
 * Bot Phase 1 end to end in one process: the real engine (WP2) over a real `bots.db` and run
 * database, WP6's memory (store, journal capture, context packs, memory tools), WP3's activity
 * chips and the bot's own app tools, and WP1's process registry over fake process groups. Only the
 * runtimes and the model resolver are fakes: a dispatch "runs" by the test calling the bot's tools
 * through its authority, writing the assistant's message into the thread, and ending the run.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotEngine, type BotEngineHost } from '../../src/mms/bots/activation/BotEngine'
import type { PreparedBotTurn } from '../../src/mms/bots/activation/dispatcher'
import { createBotActivitySink } from '../../src/mms/bots/activity/BotActivitySink'
import { BotDefinitionStore } from '../../src/mms/bots/definitions/BotDefinitionStore'
import { botFilesFolder } from '../../src/mms/bots/grants/compile'
import { botInstructions } from '../../src/mms/bots/instructions'
import { createBotMemoryAdmin } from '../../src/mms/bots/memory/admin'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { botThreadsForCatchUp, createBotJournal } from '../../src/mms/bots/memory/capture'
import { BOT_RUN_REPORT_LINE, createBotContextProvider } from '../../src/mms/bots/memory/contextPack'
import { createBotProcessRegistry } from '../../src/mms/bots/supervisor/BotProcessRegistry'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import { botMemoryTools } from '../../src/mms/run/mcp/appTools/botMemory'
import { botTools } from '../../src/mms/run/mcp/appTools/bots'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'
import { isBotTurnPayload, type BotTurnPayload } from '../../src/mms/run/types'
import type { BotChatMessage } from '../../src/shared/bots/personal/chat'
import { botScheduleLabel } from '../../src/shared/scheduleLabel'
import type { ChatMessage } from '../../src/shared/types'
import { appTurn } from '../run/appToolsFixture'

const T0 = Date.parse('2026-11-07T09:00:00.000Z')
const HOUR = 60 * 60_000

interface World {
  base: string
  profile: string
  clock: { now: number }
  store: BotStore
  runs: RunEngine
  outbox: EffectOutbox
  engine: BotEngine
  memory: BotMemoryStore
  threads: Map<string, ChatMessage[]>
  tools: Map<string, MousseTool>
  /** Process groups the fake runtime started, alive until their turn ends. */
  alive: Set<number>
  registry: ReturnType<typeof createBotProcessRegistry>
  close(): void
}

let w: World

function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-p1-int-')))
  const profile = join(base, 'profile')
  mkdirSync(profile, { recursive: true })
  const clock = { now: T0 }
  const store = new BotStore({ profileHome: profile, clock: () => clock.now })
  // WP6's store opens on the migrated `bots.db` (v4 creates its tables).
  const memory = new BotMemoryStore({ db: store.db, clock: () => clock.now, timeZone: () => 'UTC' })
  const runDb = new ProfileDatabase({ profileHome: profile, clock: () => clock.now })
  const runStore = new RunStore(runDb)
  const now = () => new Date(clock.now).toISOString()
  const outbox = new EffectOutbox(runStore, { now })
  const runs = new RunEngine({ store: runStore, outbox, tools: new ToolInvocations(runStore), now, pid: 1 })
  const threads = new Map<string, ChatMessage[]>()
  const alive = new Set<number>()
  const journal = createBotJournal({ store: memory, readThread: (threadId) => ({ messages: threads.get(threadId) ?? [] }), listThreads: () => botThreadsForCatchUp(store.allThreads()) })
  let engine!: BotEngine
  const context = createBotContextProvider({
    store: memory,
    journal,
    timeZone: () => 'UTC',
    situation: (botId) => ({ ownerName: 'Ada', schedules: engine.listSchedules(botId) }),
    scheduleCreatedAt: (botId, scheduleId) => store.schedules(botId).find((schedule) => schedule.id === scheduleId)?.createdAt
  })
  const activity = createBotActivitySink({
    emit: (event) => engine.publishActivity(event),
    chipContext: (ctx) => ({ filesFolder: botFilesFolder(profile, ctx.botId), home: base }),
    now: () => clock.now,
    setTimer: () => 0,
    clearTimer: () => {}
  })
  const registry = createBotProcessRegistry({
    store,
    startSupervisor: () => ({ stop: () => {} }),
    token: (pid) => `start:${pid}`,
    scope: {
      platform: 'linux',
      kill: (target: number, signal: NodeJS.Signals | 0) => {
        if (!alive.has(Math.abs(target))) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
        if (signal !== 0) alive.delete(Math.abs(target))
      },
      members: async (pgid: number) => (alive.has(pgid) ? [pgid] : []),
      sleep: async () => {}
    },
    settleGraceMs: 0,
    now: () => clock.now,
    platform: 'linux'
  })
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
    clock: () => clock.now,
    monotonic: () => clock.now,
    setTimer: () => ({ clear: () => {} }),
    models: {
      resolve: async () => ({ selection: { instanceId: 'pi:openrouter', model: 'some/model' } }),
      markLimited: () => {}
    },
    supervision: registry,
    activity,
    context,
    journal,
    memory: createBotMemoryAdmin({ store: memory }),
    clearContext: () => {},
    oneShot: async () => 'Dinner Helper',
    instructions: (bot) => botInstructions(bot),
    scheduleLabel: (when) => botScheduleLabel(when)
  }
  engine = new BotEngine(host)
  const own = botTools(() => ({ host: engine.tools, activity }))
  const remembered = botMemoryTools(() => ({
    activationOf: (threadId) => engine.tools.activationOf(threadId),
    memory,
    onAppResult: (at, tool, result) => activity.onAppResult({ botId: at.botId, activationId: at.activationId, dispatchId: engine.activationOf(at.threadId)?.dispatchId ?? '' }, tool, result)
  }))
  const tools = new Map([...own, ...remembered].map((tool) => [tool.name, tool]))
  return {
    base, profile, clock, store, runs, outbox, engine, memory, threads, tools, alive, registry,
    close: () => {
      engine.close()
      store.close()
      runDb.close()
      rmSync(base, { recursive: true, force: true })
    }
  }
}

beforeEach(async () => {
  w = world()
  // The startup pass (catch-up, supervisor records) lets the schedule tick run.
  await w.engine.reconcileOnStartup()
})
afterEach(() => w.close())

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

function payloadOf(activationId: string, n = 1): BotTurnPayload {
  const dispatch = w.store.dispatch(activationId, n)
  if (!dispatch?.runId) throw new Error(`dispatch ${activationId}:${n} has no run`)
  const effect = w.outbox.listForRun(dispatch.runId).find((entry) => entry.kind === 'turn.start')!
  if (!isBotTurnPayload(effect.payload)) throw new Error('not a bot payload')
  return effect.payload
}

let pids = 4000

/** One dispatch as a runtime runs it: prepared, its process reported, the bot's calls, its message, the end. */
async function dispatch(activationId: string, work: (turn: { prepared: PreparedBotTurn; call: (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }> }) => Promise<void> | void, text: string, n = 1): Promise<PreparedBotTurn> {
  const payload = payloadOf(activationId, n)
  await w.engine.refresh(payload)
  const prepared = w.engine.prepare(payload)
  if ('refused' in prepared) throw new Error(`${prepared.code}: ${prepared.refused}`)
  w.runs.markStarting(payload.runId)
  w.runs.markRunning(payload.runId)
  // The runtime reports its process by thread: the armed dispatch takes it.
  const pid = (pids += 1)
  w.alive.add(pid)
  w.registry.attachThread(payload.threadId, pid)
  const ctx: ToolCallContext = {
    caller: { threadId: payload.threadId, runId: payload.runId, provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage' },
    turn: { turnToken: 't', ...appTurn({ threadId: payload.threadId, runId: payload.runId, bot: prepared.authority }) },
    toolCallId: 'call',
    signal: new AbortController().signal,
    transport: 'mcp'
  }
  const call = async (tool: string, args: Record<string, unknown>) => {
    // Each check point checks the call (Pi: its gate and the registry): the chip counts it once.
    for (let check = 0; check < 2; check += 1) {
      const decided = prepared.authority.check({ kind: 'app', tool, args })
      if (!decided.ok) return { text: JSON.stringify(decided), isError: true }
    }
    return w.tools.get(tool)!.handler(args, ctx)
  }
  await work({ prepared, call })
  const messages = w.threads.get(payload.threadId) ?? []
  messages.push({ id: `${payload.runId}:reply`, role: 'assistant', content: text, timestamp: new Date(w.clock.now).toISOString() })
  w.threads.set(payload.threadId, messages)
  w.alive.delete(pid)
  w.runs.markTerminal(payload.runId, 'completed')
  w.engine.settle(payload, { text })
  await flush()
  return prepared
}

const chat = (botId: string) => w.engine.service.chatList(botId, { limit: 100 }).messages
const lastBot = (botId: string): BotChatMessage => chat(botId).filter((message) => message.author === 'bot').at(-1)!
const chatActivation = (botId: string) => w.store.listActivations(botId).filter((row) => row.lane === 'chat' && row.status === 'running').at(-1)!

describe('Bot Phase 1, composed', () => {
  it('create → first message → chat with memory → scheduled runs that see the owner and report', async () => {
    const { bot } = await w.engine.service.create({ look: { colour: 'teal', accessory: 'cap' }, description: 'Plan my dinners and keep my food rules.', clientRequestId: 'create-1' })
    expect(bot.name).toBe('Dinner Helper')
    const botId = bot.id
    const home = w.store.registry(botId)!.homeThreadId!

    // The first message: the system text is built for this dispatch (name, files folder), the chat pack is real.
    const first = await dispatch(chatActivation(botId).id, () => {}, 'I will plan your dinners. Tell me what you eat.')
    expect(first.instructions).toContain('Your name is Dinner Helper.')
    expect(first.instructions).toContain(`Your files folder is ${botFilesFolder(w.profile, botId)}.`)
    expect(first.preamble).toContain('<bot_memory')
    expect(first.policy.tools?.allow).toEqual(expect.arrayContaining(['memory_save', 'memory_search', 'bot_schedule_add']))
    expect(lastBot(botId)).toMatchObject({ kind: 'text', text: 'I will plan your dinners. Tell me what you eat.' })
    // Supervision: the process was recorded on the dispatch (`<activation>:d1`), and is confirmed gone.
    const d1 = w.store.dispatch(w.store.listActivations(botId)[0]!.id, 1)!
    expect(w.store.get('SELECT child_pid, exit_at FROM bot_dispatches WHERE client_request_id = ?', d1.clientRequestId)).toMatchObject({ child_pid: expect.any(Number), exit_at: expect.any(Number) })
    // About never lists the bot's own tools.
    expect(w.engine.service.get(botId).permissions).toEqual([])

    // The owner's chat: the message row belongs to the activation it starts, so its pack leaves it out.
    w.clock.now += 60_000
    const { message: said } = await w.engine.service.chatSend({ botId, text: 'I am vegetarian. Remember that, and plan dinner every hour.', clientRequestId: 'm1' })
    const second = chatActivation(botId)
    expect(said.activationId).toBe(second.id)
    // The memory and schedule tools are listed on the home thread: it runs the chat lane as bot turns.
    expect(w.tools.get('memory_save')!.listed!({ readOnly: false, modeCeiling: 'default', botRole: w.engine.roleOf(home) })).toBe(true)
    const turn2 = await dispatch(second.id, async ({ call }) => {
      expect(await call('memory_save', { text: 'The owner is vegetarian.', kind: 'owner' })).not.toHaveProperty('isError', true)
      expect(JSON.parse((await call('bot_schedule_add', { when: { kind: 'interval', minutes: 60 }, prompt: 'Plan tonight\'s dinner.' })).text)).toMatchObject({ label: 'every hour' })
    }, 'Noted, and I will plan dinner every hour.')
    expect(turn2.preamble).toContain('I will plan your dinners.')
    expect(turn2.preamble).not.toContain('I am vegetarian.')
    expect(turn2.prompt).toContain('I am vegetarian.')
    // One chip per call though each was checked twice; the forgotten text never reaches a chip.
    expect(lastBot(botId).chips).toEqual([
      { icon: 'memory', text: 'remembered', highlight: 'The owner is vegetarian.' },
      { icon: 'schedule', text: 'every hour' }
    ])

    // The next chat's pack carries the saved fact and the earlier chat.
    w.clock.now += 60_000
    await w.engine.service.chatSend({ botId, text: 'What should I cook?', clientRequestId: 'm2' })
    const turn3 = await dispatch(chatActivation(botId).id, () => {}, 'Lentil curry.')
    expect(turn3.preamble).toContain('The owner is vegetarian.')
    expect(turn3.preamble).toContain('I am vegetarian. Remember that')
    expect(turn3.preamble).not.toContain('What should I cook?')

    // The schedule's first run: its request ends with the report line; its report is a run_report row.
    await w.engine.tickSchedules(new Date(w.clock.now))
    w.clock.now += HOUR + 1_000
    await w.engine.tickSchedules(new Date(w.clock.now))
    const run1 = w.store.listActivations(botId).find((row) => row.lane === 'run')!
    const r1 = await dispatch(run1.id, () => {}, 'Tonight: lentil curry.')
    expect(r1.prompt.endsWith(BOT_RUN_REPORT_LINE)).toBe(true)
    expect(r1.preamble).not.toContain(BOT_RUN_REPORT_LINE)
    expect(r1.preamble).toContain('The owner is vegetarian.')
    expect(lastBot(botId)).toMatchObject({ kind: 'run_report', text: 'Tonight: lentil curry.' })
    expect(w.memory.lastOfKind(botId, 'run_end')?.json).toMatchObject({ reason: 'done' })

    // The owner writes between runs; the next run of this schedule sees it, and its last report.
    w.clock.now += 60_000
    await w.engine.service.chatSend({ botId, text: 'Skip Fridays from now on.', clientRequestId: 'm3' })
    await dispatch(chatActivation(botId).id, () => {}, 'Got it.')
    w.clock.now += HOUR
    await w.engine.tickSchedules(new Date(w.clock.now))
    const run2 = w.store.listActivations(botId).filter((row) => row.lane === 'run').find((row) => row.id !== run1.id)!
    // A run asks without waiting: the call is refused, one card is posted, and the run goes on to its report.
    const elsewhere = join(w.base, 'Recipes')
    mkdirSync(elsewhere)
    const r2 = await dispatch(run2.id, ({ prepared }) => {
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(elsewhere, 'list.md') } })).toMatchObject({ ok: false, refused: { askId: expect.stringMatching(/^esc_/) } })
    }, 'Tonight: risotto. I could not read your recipes.')
    expect(r2.preamble).toContain("The owner's messages since this schedule last ran")
    expect(r2.preamble).toContain('Skip Fridays from now on.')
    expect(r2.preamble).toContain('Tonight: lentil curry.')
    expect(w.store.activation(run2.id)).toMatchObject({ status: 'done' })
    const cards = chat(botId).filter((message) => message.ask)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ kind: 'notice', ask: { status: 'open', title: `read files in ${elsewhere}` } })
    expect(lastBot(botId)).toMatchObject({ kind: 'run_report', text: 'Tonight: risotto. I could not read your recipes.' })
    // Allow: the next run may read there, and About lists it.
    await w.engine.service.answer(botId, cards[0]!.ask!.askId, 'allow')
    expect(w.engine.service.get(botId).permissions.map((item) => item.title)).toEqual([`read files in ${elsewhere}`])
  })

  it('forgetting in the chat leaves no forgotten text in the chip that is stored', async () => {
    const { bot } = await w.engine.service.create({ look: { colour: 'teal', accessory: 'cap' }, description: 'Keep my notes.', clientRequestId: 'create-2' })
    await dispatch(chatActivation(bot.id).id, () => {}, 'Hello.')
    await w.engine.service.chatSend({ botId: bot.id, text: 'Remember my door code is the blue door.', clientRequestId: 'f1' })
    await dispatch(chatActivation(bot.id).id, async ({ call }) => { await call('memory_save', { text: 'The owner uses the blue door.', kind: 'owner' }) }, 'Saved.')
    await w.engine.service.chatSend({ botId: bot.id, text: 'Forget the door.', clientRequestId: 'f2' })
    await dispatch(chatActivation(bot.id).id, async ({ call }) => {
      expect(JSON.parse((await call('memory_forget', { id: 'm1', reason: 'owner asked' })).text)).toMatchObject({ forgotten: 'm1' })
    }, 'Forgotten.')
    expect(lastBot(bot.id).chips).toEqual([{ icon: 'memory', text: 'forgot something you asked me to' }])
    const stored = w.store.get('SELECT chips_json FROM bot_messages WHERE id = ?', lastBot(bot.id).id)
    expect(String(stored?.chips_json)).not.toContain('blue door')
  })
})
