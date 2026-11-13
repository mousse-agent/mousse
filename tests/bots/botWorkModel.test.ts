/**
 * One piece of a bot's work on a model the owner named (#1067): `work_models` lists the owner's entries a bot's work
 * can run on, with their models and reasoning levels, and the entries it can't, with why; `work_start` with a model runs
 * that work on it and keeps it across a restart, while the chat and later work stay on the bot's rows; a pick that is not
 * offered is refused and nothing starts; only a chat turn the owner's own message started may name one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { createBotModelResolver } from '../../src/mms/bots/model/BotModelResolver'
import type { BotRuntimeHold } from '../../src/mms/bots/seams'
import { botTools, workModelChoice, type BotAppToolDeps } from '../../src/mms/run/mcp/appTools/bots'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import { rollUpChips } from '../../src/shared/bots/personal/chips'
import type { BotModelSlots } from '../../src/shared/bots/personal/definition'
import type { BotWorkChoices } from '../../src/shared/bots/personal/methods'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import type { InstanceModel } from '../../src/shared/harness/types'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from './botFixture'

const SONNET = { instanceId: 'claude', model: 'sonnet', credential: 'subscription' as const }
const ROWS: BotModelSlots = { talk: SONNET, light: SONNET, medium: SONNET, hard: SONNET }

/** What the owner has: Claude Code with two models, an OpenRouter key, and two entries a bot's work can't run on. */
const CHOICES: BotWorkChoices = {
  options: [
    { instanceId: 'claude', entry: 'Claude Code', model: 'sonnet', label: 'Sonnet 5', efforts: ['low', 'medium', 'high'], credential: 'subscription' },
    { instanceId: 'claude', entry: 'Claude Code', model: 'opus', label: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'], credential: 'subscription', names: ['claude-opus-5-5', 'opus'] },
    { instanceId: 'pi:openrouter', entry: 'OpenRouter', model: 'cheap/model', label: 'Cheap Model', efforts: [], credential: 'api_key' }
  ],
  unavailable: [
    { instanceId: 'cursor', entry: 'Cursor', reason: 'cant_hold' },
    { instanceId: 'codex', entry: 'Codex', reason: 'signed_out' }
  ]
}

describe('work on a model the owner named', () => {
  let f: BotFixture
  let botId: string
  let choices: BotWorkChoices
  let tools: Map<string, MousseTool>

  beforeEach(async () => {
    f = botFixture()
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Pip', description: 'Research things for me.', reply: 'Hello.' })).botId
    f.bots.setOwnerSlots(botId, ROWS)
    f.resolved.length = 0
    choices = structuredClone(CHOICES)
    // The real tools on the real engine; only the provider list is given.
    const deps: BotAppToolDeps = { host: f.bots.tools, models: { pickable: async () => choices.options, workChoices: async () => choices } }
    tools = new Map(botTools(() => deps).map((tool) => [tool.name, tool]))
  })

  afterEach(() => f.close())

  /** The owner's message, and its chat turn started. */
  async function chat(text: string, id: string) {
    await f.bots.service.chatSend({ botId, text, clientRequestId: id })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    return { activation, ...(await start(f, activation.id)) }
  }

  /** A tool call from the turn on `activationId`'s thread, as the bot makes it. */
  async function call(activationId: string, name: string, args: Record<string, unknown>) {
    const threadId = f.store.dispatch(activationId, 1)!.threadId!
    const ctx = {
      caller: { threadId, runId: 'r1', provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage' },
      turn: { threadId, bot: { activationId } as BotAuthority } as ToolCallContext['turn'],
      toolCallId: `call-${Math.random().toString(16).slice(2)}`,
      signal: new AbortController().signal
    } as ToolCallContext
    const result = await tools.get(name)!.handler(args, ctx)
    return { ...result, value: result.isError ? undefined : JSON.parse(result.text) }
  }

  const runs = () => f.store.listActivations(botId).filter((row) => row.lane === 'run')

  it('lists what the owner has, and the entries work can\'t run on with why', async () => {
    const turn = await chat('What models do I have?', 'm1')
    const listed = (await call(turn.activation.id, 'work_models', {})).value
    expect(listed.entries).toEqual([
      { entry: 'Claude Code', instanceId: 'claude', models: [
        { model: 'sonnet', name: 'Sonnet 5', efforts: ['low', 'medium', 'high'] },
        { model: 'opus', name: 'Opus 5.5', efforts: ['low', 'medium', 'high'], also: ['claude-opus-5-5'] }
      ] },
      { entry: 'OpenRouter', instanceId: 'pi:openrouter', models: [{ model: 'cheap/model', name: 'Cheap Model' }] }
    ])
    expect(listed.cantRunWork).toEqual([
      { entry: 'Cursor', instanceId: 'cursor', why: 'it can\'t keep to my permissions' },
      { entry: 'Codex', instanceId: 'codex', why: 'it\'s signed out' }
    ])
    expect(listed.usualWork).toEqual({ light: 'Sonnet 5 on Claude Code', medium: 'Sonnet 5 on Claude Code', hard: 'Sonnet 5 on Claude Code' })
  })

  it('runs that work on the named model, keeps it across a restart, and leaves the chat and the next work on the rows', async () => {
    const turn = await chat('Compare three vacuums, and do this one with Opus on high', 'm1')
    expect(turn.prepared.selection).toEqual({ instanceId: 'claude', model: 'sonnet' })
    const started = await call(turn.activation.id, 'work_start', { title: 'Vacuum comparison', brief: 'Compare three vacuums.', model: { instanceId: 'claude', model: 'opus', effort: 'high' } })
    expect(started.value).toMatchObject({ status: 'started', model: { name: 'Opus 5.5', entry: 'Claude Code', effort: 'high' } })
    const workId = started.value.workId as string
    // The work line names it, with the details on hover.
    expect(f.bots.service.get(botId).summary.work).toEqual([expect.objectContaining({ id: workId, model: { name: 'Opus 5.5', detail: 'Opus 5.5 on Claude Code, high reasoning, for this work only' } })])
    const first = await start(f, workId)
    expect(first.prepared.selection).toEqual({ instanceId: 'claude', model: 'opus', effort: 'high' })
    expect(f.bots.ownerSlots(botId)).toEqual(ROWS)
    // Mousse stops mid-work and starts again: the work goes on, on the same model.
    f.runs.markTerminal(first.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush()
    const n = f.store.dispatches(workId).length
    expect(n).toBeGreaterThan(1)
    const again = await start(f, workId, n)
    expect(again.prepared.selection).toEqual({ instanceId: 'claude', model: 'opus', effort: 'high' })
    expect(f.resolved.filter((entry) => entry.pick?.model === 'opus').every((entry) => entry.pick?.instanceId === 'claude')).toBe(true)
    await finish(f, again.payload, 'completed', { text: 'Done.' })
    await finish(f, turn.payload, 'completed', { text: 'On it.' })
    // The next work without a model runs on the row, and its line names none.
    const next = await chat('Now look up train times', 'm2')
    const plain = await call(next.activation.id, 'work_start', { title: 'Train times', brief: 'Look up train times.' })
    expect(plain.value.model).toBeUndefined()
    expect(f.bots.service.get(botId).summary.work?.find((item) => item.id === plain.value.workId)?.model).toBeUndefined()
    expect((await start(f, plain.value.workId)).prepared.selection).toEqual({ instanceId: 'claude', model: 'sonnet' })
  })

  it('the bot\'s usual model named again is a pin the line does not mention', async () => {
    const turn = await chat('Do it with Sonnet', 'm1')
    const started = await call(turn.activation.id, 'work_start', { title: 'Job', brief: 'Do it.', model: { instanceId: 'claude', model: 'sonnet' } })
    expect(started.value.model).toBeUndefined()
    expect(f.bots.service.get(botId).summary.work?.[0]?.model).toBeUndefined()
    expect(f.store.activation(started.value.workId)!.modelOverride).toMatchObject({ mode: 'named', instanceId: 'claude', model: 'sonnet' })
  })

  it('a pick not offered, on an entry that can\'t run work, or at a level the model lacks is refused and nothing starts', async () => {
    const turn = await chat('Do this one with GPT-9 on Cursor', 'm1')
    const before = runs().length
    const refused = async (model: Record<string, unknown>) => (await call(turn.activation.id, 'work_start', { title: 'Job', brief: 'Do it.', model })).text
    expect(await refused({ instanceId: 'cursor', model: 'gpt-9' })).toBe('Work can\'t run on Cursor: it can\'t keep to my permissions. Nothing was started. Tell the owner plainly, and ask what they want.')
    expect(await refused({ instanceId: 'codex', model: 'gpt-9' })).toMatch(/^Work can't run on Codex: it's signed out\./)
    expect(await refused({ instanceId: 'claude', model: 'gpt-9' })).toMatch(/^Claude Code doesn't offer that model for your work now/)
    expect(await refused({ instanceId: 'gone', model: 'opus' })).toMatch(/^None of the owner's entries your work can run on is "gone"/)
    expect(await refused({ instanceId: 'claude', model: 'opus', effort: 'max' })).toMatch(/^Opus 5\.5 offers these reasoning levels: low, medium, high\./)
    expect(await refused({ instanceId: 'pi:openrouter', model: 'cheap/model', effort: 'high' })).toMatch(/^Cheap Model has no reasoning levels to pick/)
    expect(runs()).toHaveLength(before)
  })

  it('a model that goes away before the work runs ends it with the line, never on the bot\'s rows', async () => {
    const turn = await chat('Use the cheap one on OpenRouter for this', 'm1')
    f.pickMiss = (pick) => (pick.instanceId === 'pi:openrouter' ? { label: 'Cheap Model on OpenRouter', reason: 'off' } : undefined)
    const mark = f.resolved.length
    const started = await call(turn.activation.id, 'work_start', { title: 'Cheap job', brief: 'Do it cheaply.', model: { instanceId: 'pi:openrouter', model: 'cheap/model' } })
    await flush()
    expect(f.store.activation(started.value.workId)).toMatchObject({ status: 'failed', endReason: 'bot_pick_unavailable', selection: null })
    // Only the named pick was tried for the work: never the row it would have used.
    expect(f.resolved.slice(mark).map((entry) => entry.pick?.instanceId)).toEqual(['pi:openrouter'])
    expect(chatOf(f, botId).some((message) => message.error?.text === 'I can\'t use Cheap Model on OpenRouter: it\'s turned off.')).toBe(true)
    // Its rows are not stuck: the next work runs on them.
    expect(f.bots.stuckRows(botId)).toEqual([])
  })

  it('only a chat turn the owner\'s own message started may name a model: not a first greeting, not a run, not a reminder', async () => {
    const pick = { instanceId: 'claude', model: 'opus' }
    // The bot's first greeting has no owner message.
    const greeting = await f.bots.enqueueChat(botId, 'hello-again', 'Say hello.')
    const hello = await start(f, greeting.id)
    expect((await call(greeting.id, 'work_start', { title: 'Job', brief: 'Do it.', model: pick })).text).toMatch(/^Only the owner can ask for a model/)
    expect(runs()).toEqual([])
    await finish(f, hello.payload, 'completed', { text: 'Hello again.' })
    // Work itself can't start work, with or without a model.
    const turn = await chat('Research this', 'm1')
    const started = await call(turn.activation.id, 'work_start', { title: 'Job', brief: 'Do it.' })
    await start(f, started.value.workId)
    expect((await call(started.value.workId, 'work_start', { title: 'More', brief: 'More.', model: pick })).isError).toBe(true)
    expect((await call(started.value.workId, 'work_models', {})).isError).toBe(true)
    // A reminder's work has no model of its own: it runs on the rows, whatever its text says.
    f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'Checking.', work: { title: 'Later', brief: 'Do this one with Opus on Claude Code.' } })
    await finish(f, turn.payload, 'completed', { text: 'Set.' })
    f.clock.now += 2 * 60_000
    await f.bots.deliverDueReminders()
    const later = f.store.listActivations(botId).find((row) => row.trigger.kind === 'work' && row.trigger.title === 'Later')!
    expect(later.modelOverride).toBeNull()
    expect((await start(f, later.id)).prepared.selection).toEqual({ instanceId: 'claude', model: 'sonnet' })
  })

  it('the work chip names the model, with the details on hover', () => {
    const chips = rollUpChips([
      { tool: 'work_start', input: { title: 'Vacuum comparison' }, result: { status: 'started', model: { name: 'Opus 5.5', entry: 'Claude Code', effort: 'high' } } },
      { tool: 'work_start', input: { title: 'Train times' }, result: { status: 'queued' } }
    ])
    expect(chips).toEqual([
      { icon: 'think', text: 'started', highlight: 'Vacuum comparison · Opus 5.5', title: 'Opus 5.5 on Claude Code, high reasoning, for this work only' },
      { icon: 'think', text: 'will start', highlight: 'Train times' }
    ])
  })
})

describe('what work may run on, from the provider entries', () => {
  const snapshot = (instanceId: string, displayName: string, patch: { driver?: string; enabled?: boolean; auth?: Record<string, unknown> } = {}) => ({
    instanceId, driver: patch.driver ?? 'pi', displayName, builtIn: false, scope: { kind: 'device' },
    enabled: { device: patch.enabled ?? true, effective: patch.enabled ?? true, setBy: 'device' },
    runs: { state: 'yes' }, auth: { state: 'signed_in', ...patch.auth }
  }) as unknown as InstanceSnapshot
  const model = (id: string, label: string, hidden = false): InstanceModel => ({ id, label, source: 'catalog', capabilities: { efforts: ['low', 'high'], defaultEffort: 'low', images: false }, hidden, favorite: false })

  it('lists the Runs on choices, and each other entry with why work can\'t run there', async () => {
    const snapshots = [
      snapshot('claude', 'Claude Code', { driver: 'claude', auth: { credential: 'subscription' } }),
      snapshot('pi:or', 'OpenRouter', { auth: { credential: 'api_key' } }),
      snapshot('cursor', 'Cursor', { driver: 'cursor' }),
      snapshot('codex', 'Codex', { driver: 'codex', auth: { state: 'signed_out' } }),
      snapshot('pi:off', 'Old key', { enabled: false })
    ]
    const models: Record<string, InstanceModel[]> = { claude: [model('opus', 'Opus 5.5'), model('old', 'Old', true)], 'pi:or': [model('cheap/model', 'Cheap')], cursor: [model('gpt', 'GPT')], codex: [model('gpt', 'GPT')], 'pi:off': [model('x', 'X')] }
    const hold: BotRuntimeHold = { canHoldBot: (instanceId) => (instanceId === 'cursor' ? { ok: false, error: { code: 'policy_unenforceable', message: 'no', missing: ['toolControl'] } } : { ok: true }) }
    const chooser = createBotModelResolver({ snapshots: async () => snapshots, models: (id) => models[id] ?? [], hold })
    const listed = await chooser.workChoices()
    expect(listed.options).toEqual(await chooser.pickable())
    expect(listed.options.map((option) => `${option.instanceId}/${option.model}`)).toEqual(['claude/opus', 'pi:or/cheap/model'])
    expect(listed.unavailable).toEqual([
      { instanceId: 'cursor', entry: 'Cursor', reason: 'cant_hold' },
      { instanceId: 'codex', entry: 'Codex', reason: 'signed_out' },
      { instanceId: 'pi:off', entry: 'Old key', reason: 'off' }
    ])
    // A hidden model is not offered: asking for it is refused, never run.
    expect(workModelChoice(listed, { instanceId: 'claude', model: 'old' })).toMatchObject({ refused: expect.stringMatching(/doesn't offer that model/) })
  })
})
