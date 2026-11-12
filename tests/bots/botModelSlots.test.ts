/**
 * A bot's models by situation (#673): Talk for the chat, Light, Medium and Hard work for the run lane, each Automatic
 * or a pick on its own entry at a reasoning level. Covers the rows as stored (older definitions upgraded on read), which
 * row a turn takes, a pick keeping its entry when two entries offer the same model, the one chat line for a pick that
 * can't run, `work_start`'s level, and `set_depth` and `use_model` on the rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBotModelResolver } from '../../src/mms/bots/model/BotModelResolver'
import type { BotRuntimeHold } from '../../src/mms/bots/seams'
import type { BotActivationTrigger, BotModelSlots, BotThreadSpec } from '../../src/shared/bots/personal/definition'
import { AUTOMATIC_SLOTS, missingAfter, pickMissText, slotsAllOn, slotsOf, slotsWith, turnModelOf, withSlots, workRowsDiffer } from '../../src/shared/bots/personal/modelSlots'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import type { InstanceModel, RunPolicy } from '../../src/shared/harness/types'
import type { ModelCatalog } from '../../src/shared/modelCatalog'
import { botFixture, chatOf, createBot, finish, PI, start, type BotFixture } from './botFixture'

const TALK = { instanceId: 'claude', model: 'opus' }
const LIGHT = { instanceId: 'pi:key', model: 'haiku', effort: 'low' }
const MEDIUM = { instanceId: 'pi:key', model: 'sonnet' }
const HARD = { instanceId: 'claude', model: 'opus', effort: 'high' }
const ROWS: BotModelSlots = { talk: TALK, light: LIGHT, medium: MEDIUM, hard: HARD }

const thread = (model: BotThreadSpec['model'], slots?: BotModelSlots): Pick<BotThreadSpec, 'model' | 'slots'> => ({ model, ...(slots ? { slots } : {}) })
const chatTurn = { lane: 'chat' as const, trigger: { kind: 'manual', input: 'hi' } as BotActivationTrigger }
const work = (level?: 'light' | 'medium' | 'hard') => ({ lane: 'run' as const, trigger: { kind: 'work', input: 'x', title: 'x', from: 'a', ...(level ? { level } : {}) } as BotActivationTrigger })

describe('the rows as stored', () => {
  it('older definitions are read as rows: automatic on every row, or one model by name on every row', () => {
    expect(slotsOf(thread({ mode: 'auto', depth: 'normal' }))).toEqual(AUTOMATIC_SLOTS)
    expect(slotsOf(thread({ mode: 'named', model: 'opus', depth: 'deep' }))).toEqual(slotsAllOn({ model: 'opus' }))
  })

  it('rows are written beside a model that mirrors Talk, and left out when the model alone says them', () => {
    const written = withSlots(thread({ mode: 'auto', depth: 'deep' }), ROWS)
    expect(written).toEqual({ model: { mode: 'named', model: 'opus', depth: 'deep' }, slots: ROWS })
    expect(slotsOf(written)).toEqual(ROWS)
    expect(withSlots(written, AUTOMATIC_SLOTS)).toEqual({ model: { mode: 'auto', depth: 'deep' } })
    expect(withSlots(written, slotsAllOn({ model: 'opus' }))).toEqual({ model: { mode: 'named', model: 'opus', depth: 'deep' } })
    // A pick on an entry, or at a level of its own, needs the rows.
    expect(withSlots(written, slotsAllOn(TALK)).slots).toEqual(slotsAllOn(TALK))
  })

  it('an older build that changed the model wins: its model on every row; one that changed only the level keeps the rows', () => {
    const written = withSlots(thread({ mode: 'auto', depth: 'normal' }), ROWS)
    expect(slotsOf({ ...written, model: { mode: 'named', model: 'sonnet', depth: 'normal' } })).toEqual(slotsAllOn({ model: 'sonnet' }))
    expect(slotsOf({ ...written, model: { mode: 'auto', depth: 'normal' } })).toEqual(AUTOMATIC_SLOTS)
    expect(slotsOf({ ...written, model: { mode: 'named', model: 'opus', depth: 'quick' } })).toEqual(ROWS)
    // Rows this build can't read are ignored the same way.
    expect(slotsOf({ ...written, slots: { talk: null } as unknown as BotModelSlots })).toEqual(slotsAllOn({ model: 'opus' }))
  })

  it('the simple view is Work on all three levels; Advanced shows when Light or Hard differs from Medium', () => {
    const simple = slotsWith(slotsWith(AUTOMATIC_SLOTS, 'talk', TALK), 'work', MEDIUM)
    expect(simple).toEqual({ talk: TALK, light: MEDIUM, medium: MEDIUM, hard: MEDIUM })
    expect(workRowsDiffer(simple)).toBe(false)
    expect(workRowsDiffer(ROWS)).toBe(true)
    expect(workRowsDiffer({ ...simple, hard: { ...MEDIUM, effort: 'high' } })).toBe(true)
  })
})

describe('which row a turn takes', () => {
  const spec = withSlots(thread({ mode: 'auto', depth: 'normal' }), ROWS)

  it('a chat turn takes Talk at the standing level; work takes the row of the level it names, else the standing level', () => {
    expect(turnModelOf(spec, chatTurn)).toEqual({ slot: 'talk', pick: TALK, depth: 'normal' })
    expect(turnModelOf(spec, work('light'))).toEqual({ slot: 'light', pick: LIGHT, depth: 'quick' })
    expect(turnModelOf(spec, work('hard'))).toEqual({ slot: 'hard', pick: HARD, depth: 'deep' })
    expect(turnModelOf(spec, work())).toEqual({ slot: 'medium', pick: MEDIUM, depth: 'normal' })
    // A scheduled run names no level: the standing one, which `set_depth always` moves.
    const schedule = { lane: 'run' as const, trigger: { kind: 'schedule', input: 'x', scheduleId: 's', occurrenceAt: 't' } as BotActivationTrigger }
    expect(turnModelOf(spec, schedule)).toMatchObject({ slot: 'medium' })
    expect(turnModelOf({ ...spec, model: { ...spec.model, depth: 'deep' } }, schedule)).toEqual({ slot: 'hard', pick: HARD, depth: 'deep' })
    expect(turnModelOf({ ...spec, model: { ...spec.model, depth: 'deep' } }, work('light'))).toMatchObject({ slot: 'light' })
  })

  it('the simple view runs every level on Work, at the depth of its level (Default reasoning follows it)', () => {
    const simple = withSlots(thread({ mode: 'auto', depth: 'normal' }), { talk: TALK, light: MEDIUM, medium: MEDIUM, hard: MEDIUM })
    expect(['light', 'medium', 'hard'].map((level) => turnModelOf(simple, work(level as 'light')))).toEqual([
      { slot: 'light', pick: MEDIUM, depth: 'quick' }, { slot: 'medium', pick: MEDIUM, depth: 'normal' }, { slot: 'hard', pick: MEDIUM, depth: 'deep' }
    ])
  })

  it('an activation\'s own choice: set_depth now moves a run to that level\'s row; use_model now replaces the chat\'s row', () => {
    expect(turnModelOf(spec, { ...work('hard'), modelOverride: { mode: 'auto', depth: 'quick' } })).toEqual({ slot: 'light', pick: LIGHT, depth: 'quick' })
    expect(turnModelOf(spec, { ...chatTurn, modelOverride: { mode: 'auto', depth: 'deep' } })).toEqual({ slot: 'talk', pick: TALK, depth: 'deep' })
    expect(turnModelOf(spec, { ...chatTurn, modelOverride: { mode: 'named', model: 'sonnet', instanceId: 'pi:key', depth: 'normal' } })).toEqual({ slot: 'talk', pick: { instanceId: 'pi:key', model: 'sonnet' }, depth: 'normal' })
    // An automation's model by hand, by name.
    expect(turnModelOf(spec, { ...work(), modelOverride: { mode: 'named', model: 'opus', depth: 'normal' } })).toEqual({ slot: 'medium', pick: { model: 'opus' }, depth: 'normal' })
  })
})

describe('the said-once list', () => {
  it('remembers a pick that could not run, forgets it once it runs, and says a new reason again', () => {
    const off = { key: 'claude|opus|off' }
    expect(missingAfter(undefined, TALK, off)).toEqual(['claude|opus|off'])
    expect(missingAfter(['claude|opus|off'], TALK, off)).toEqual(['claude|opus|off'])
    expect(missingAfter(['claude|opus|off'], TALK, { key: 'claude|opus|signed_out' })).toEqual(['claude|opus|signed_out'])
    expect(missingAfter(['claude|opus|off', 'pi:key|sonnet|off'], TALK, undefined)).toEqual(['pi:key|sonnet|off'])
    expect(missingAfter(['claude|opus|off'], null, undefined)).toEqual(['claude|opus|off'])
    expect(pickMissText({ label: 'Opus (Claude Code)', reason: 'off' })).toBe('I can\'t use Opus (Claude Code): it\'s turned off, so I\'m using Automatic for now.')
  })
})

// -- The resolver, with the same model on two entries ------------------------------------------------------------

const policy: RunPolicy = { mode: 'default', origin: 'bot', approvals: 'grants', tools: { allow: ['read'] }, authority: { kind: 'bot', digest: 'd1' } }
const catalog: ModelCatalog = {
  format: 1,
  revision: 2,
  models: [
    { id: 'acme-big-2', name: 'Acme Big 2', short: 'Big 2', maker: 'acme', family: 'big', tier: 'frontier', released: '2030-03-01', routes: { claude: { id: 'acme-big-2' } } },
    { id: 'acme-mid-2', name: 'Acme Mid 2', short: 'Mid 2', maker: 'acme', family: 'mid', tier: 'standard', released: '2030-02-01', routes: { claude: { id: 'acme-mid-2' } } }
  ]
}

function snapshot(instanceId: string, displayName: string, patch: { driver?: InstanceSnapshot['driver']; enabled?: boolean; auth?: Partial<InstanceSnapshot['auth']> } = {}): InstanceSnapshot {
  return {
    instanceId,
    driver: patch.driver ?? 'pi',
    displayName,
    builtIn: false,
    scope: { kind: 'device' },
    enabled: { device: patch.enabled ?? true, effective: patch.enabled ?? true, setBy: 'device' },
    runs: { state: 'yes' },
    auth: { state: 'signed_in', ...patch.auth }
  } as unknown as InstanceSnapshot
}

const model = (id: string, label: string, hidden = false): InstanceModel => ({
  id, label, source: 'catalog', capabilities: { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', images: false }, hidden, favorite: false
})

describe('a pick keeps its entry', () => {
  const clock = new Date('2030-06-01T10:00:00.000Z')
  const SUB = snapshot('claude', 'Claude Code', { driver: 'claude', auth: { credential: 'subscription' } })
  const KEY = snapshot('pi:key', 'Anthropic API', { auth: { credential: 'api_key' } })
  const MODELS: Record<string, InstanceModel[]> = { claude: [model('acme-big-2', 'Big 2'), model('acme-mid-2', 'Mid 2')], 'pi:key': [model('acme-big-2', 'Big 2')] }
  const anyHold: BotRuntimeHold = { canHoldBot: () => ({ ok: true }) }
  const resolver = (snapshots = [SUB, KEY], models = MODELS, hold = anyHold) =>
    createBotModelResolver({ snapshots: async () => snapshots, models: (id) => models[id] ?? [], hold, catalog: () => catalog, now: () => clock })
  const onKey = { instanceId: 'pi:key', model: 'acme-big-2' }
  const automatic = { instanceId: 'claude', model: 'acme-mid-2', effort: 'medium' }

  it('lists the same model on both entries for the picker, named by entry, with its reasoning levels', async () => {
    expect(await resolver().pickable()).toEqual([
      { instanceId: 'claude', entry: 'Claude Code', model: 'acme-big-2', label: 'Big 2', efforts: ['low', 'medium', 'high'] },
      { instanceId: 'claude', entry: 'Claude Code', model: 'acme-mid-2', label: 'Mid 2', efforts: ['low', 'medium', 'high'] },
      { instanceId: 'pi:key', entry: 'Anthropic API', model: 'acme-big-2', label: 'Big 2', efforts: ['low', 'medium', 'high'] }
    ])
  })

  it('runs a pick on the entry it was picked on, even when a subscription offers the same model; Default reasoning follows the depth', async () => {
    const chooser = resolver()
    expect(await chooser.resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })).toEqual({ selection: { instanceId: 'pi:key', model: 'acme-big-2', effort: 'medium' } })
    expect(await chooser.resolve({ botId: 'b', pick: onKey, depth: 'quick', policy })).toEqual({ selection: { instanceId: 'pi:key', model: 'acme-big-2', effort: 'low' } })
    expect(await chooser.resolve({ botId: 'b', pick: { ...onKey, effort: 'high' }, depth: 'quick', policy })).toEqual({ selection: { instanceId: 'pi:key', model: 'acme-big-2', effort: 'high' } })
    expect(await chooser.resolve({ botId: 'b', pick: { instanceId: 'claude', model: 'acme-big-2' }, depth: 'normal', policy })).toEqual({ selection: { instanceId: 'claude', model: 'acme-big-2', effort: 'medium' } })
    // A level the model no longer offers: the depth's.
    expect(await chooser.resolve({ botId: 'b', pick: { ...onKey, effort: 'max' }, depth: 'deep', policy })).toEqual({ selection: { instanceId: 'pi:key', model: 'acme-big-2', effort: 'high' } })
    // A pick by name from an older bot: across entries, subscriptions first, as before.
    expect(await chooser.resolve({ botId: 'b', pick: { model: 'acme-big-2' }, depth: 'normal', policy })).toEqual({ selection: { instanceId: 'claude', model: 'acme-big-2', effort: 'medium' } })
  })

  it('a pick that can\'t run never moves to the other entry: Automatic for that turn, and why', async () => {
    const label = 'Big 2 (Anthropic API)'
    const off = await resolver([SUB, snapshot('pi:key', 'Anthropic API', { enabled: false })]).resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })
    expect(off).toEqual({ selection: automatic, missed: { key: 'pi:key|acme-big-2|off', label, reason: 'off' } })
    const out = await resolver([SUB, snapshot('pi:key', 'Anthropic API', { auth: { state: 'signed_out' } })]).resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })
    expect(out).toMatchObject({ selection: automatic, missed: { reason: 'signed_out' } })
    // The entry is gone: no entry name, and the model's id when its models can't be read either.
    expect(await resolver([SUB]).resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })).toMatchObject({ selection: automatic, missed: { label: 'Big 2', reason: 'removed' } })
    expect(await resolver([SUB], { claude: MODELS.claude! }).resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })).toMatchObject({ missed: { label: 'acme-big-2', reason: 'removed' } })
    expect(await resolver([SUB, KEY], { ...MODELS, 'pi:key': [model('acme-big-2', 'Big 2', true)] }).resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })).toMatchObject({ missed: { reason: 'removed' } })
    const refuses: BotRuntimeHold = { canHoldBot: (instanceId) => (instanceId === 'pi:key' ? { ok: false, error: { code: 'policy_unenforceable', message: 'no', missing: ['toolControl'] } } : { ok: true }) }
    expect(await resolver([SUB, KEY], MODELS, refuses).resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })).toMatchObject({ selection: automatic, missed: { reason: 'cant_hold' } })
    const limited = resolver()
    limited.markLimited('pi:key', '2030-06-01T12:00:00.000Z')
    expect(await limited.resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })).toEqual({ selection: automatic, missed: { key: 'pi:key|acme-big-2|limited', label, reason: 'limited' } })
  })

  it('use_model finds the owner\'s words among the same choices, a subscription first', async () => {
    expect(await resolver().pickFor('Big 2')).toEqual({ instanceId: 'claude', model: 'acme-big-2' })
    expect(await resolver([KEY]).pickFor('big')).toEqual({ instanceId: 'pi:key', model: 'acme-big-2' })
    expect(await resolver().pickFor('grok')).toBeUndefined()
  })
})

// -- The engine ----------------------------------------------------------------------------------------------------

describe('the engine on rows', () => {
  let f: BotFixture
  let botId: string

  beforeEach(async () => {
    f = botFixture()
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Pip', description: 'Keep my day in order.', reply: 'Hello.' })).botId
    f.resolved.length = 0
  })

  afterEach(() => f.close())

  async function chat(text: string, id: string) {
    await f.bots.service.chatSend({ botId, text, clientRequestId: id })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    return { activation, ...(await start(f, activation.id)) }
  }

  it('a chat turn runs on Talk; work runs on the row of the level it names, else Medium (#673)', async () => {
    f.bots.setOwnerSlots(botId, ROWS)
    const turn = await chat('Three jobs', 'm1')
    expect(f.resolved.at(-1)).toEqual({ pick: TALK, depth: 'normal' })
    expect(turn.prepared.selection).toEqual({ instanceId: 'claude', model: 'opus' })
    const levels = [['hard', HARD, 'deep'], [undefined, MEDIUM, 'normal'], ['light', LIGHT, 'quick']] as const
    for (const [n, [level, pick, depth]] of levels.entries()) {
      const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: `Job ${n}`, brief: `Do ${n}.`, key: `k${n}`, ...(level ? { level } : {}) })
      expect(f.store.activation(workId)!.trigger).toMatchObject(level ? { level } : { kind: 'work' })
      const run = await start(f, workId)
      expect(f.resolved.at(-1)).toEqual({ pick, depth })
      expect(run.prepared.selection).toEqual({ instanceId: pick.instanceId, model: pick.model, ...('effort' in pick ? { effort: pick.effort } : {}) })
      await finish(f, run.payload, 'completed', { text: 'Done.' })
    }
    await finish(f, turn.payload, 'completed', { text: 'On it.' })
  })

  it('set_depth always moves the standing level (work that names none); set_depth now moves one run to another row', async () => {
    f.bots.setOwnerSlots(botId, ROWS)
    const turn = await chat('Think harder from now on', 'm1')
    f.bots.tools.setModel(botId, turn.activation.id, 'always', { depth: 'deep' })
    expect(f.bots.definitionOf(botId).main.model).toEqual({ mode: 'named', model: 'opus', depth: 'deep' })
    expect(f.bots.ownerSlots(botId)).toEqual(ROWS)
    const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Job', brief: 'Do it.', key: 'k1' })
    await start(f, workId)
    expect(f.resolved.at(-1)).toEqual({ pick: HARD, depth: 'deep' })
    f.bots.tools.setModel(botId, workId, 'now', { depth: 'quick' })
    expect(f.store.activation(workId)!.modelOverride).toEqual({ mode: 'auto', depth: 'quick' })
    expect(turnModelOf(f.bots.definitionOf(botId).main, f.store.activation(workId)!)).toEqual({ slot: 'light', pick: LIGHT, depth: 'quick' })
    // A run never switches its model.
    expect(() => f.bots.tools.setModel(botId, workId, 'now', { pick: TALK })).toThrow(/owner/)
  })

  it('use_model always puts a choice on the rows the owner said; now, on this chat only', async () => {
    const turn = await chat('Use Opus', 'm1')
    f.bots.tools.setModel(botId, turn.activation.id, 'always', { pick: TALK, rows: 'work' })
    expect(f.bots.ownerSlots(botId)).toEqual({ talk: null, light: TALK, medium: TALK, hard: TALK })
    f.bots.tools.setModel(botId, turn.activation.id, 'always', { pick: MEDIUM, rows: 'talk' })
    expect(f.bots.ownerSlots(botId)).toEqual({ talk: MEDIUM, light: TALK, medium: TALK, hard: TALK })
    f.bots.tools.setModel(botId, turn.activation.id, 'always', { pick: TALK })
    expect(f.bots.ownerSlots(botId)).toEqual(slotsAllOn(TALK))
    f.bots.tools.setModel(botId, turn.activation.id, 'now', { pick: { instanceId: 'pi:key', model: 'sonnet' } })
    expect(f.store.activation(turn.activation.id)!.modelOverride).toEqual({ mode: 'named', model: 'sonnet', instanceId: 'pi:key', depth: 'normal' })
  })

  it('a picked row that can\'t run: Automatic, and one line in the chat while it lasts; said again after it ran (#673)', async () => {
    f.bots.setOwnerSlots(botId, slotsAllOn(TALK))
    const broken = { key: 'claude|opus|off', label: 'Opus (Claude Code)', reason: 'off' as const }
    f.pickMiss = (pick) => (pick.instanceId === 'claude' ? broken : undefined)
    const line = 'I can\'t use Opus (Claude Code): it\'s turned off, so I\'m using Automatic for now.'
    const said = () => chatOf(f, botId).filter((message) => message.text === line).length
    const first = await chat('Hi', 'm1')
    expect(first.prepared.selection).toEqual(PI)
    expect(chatOf(f, botId).find((message) => message.text === line)).toMatchObject({ kind: 'notice' })
    await finish(f, first.payload, 'completed', { text: 'Hello.' })
    // The next chat turn and a piece of work on the same pick: no second line.
    const second = await chat('Again', 'm2')
    const { workId } = await f.bots.tools.work.start(botId, second.activation.id, { title: 'Job', brief: 'Do it.', key: 'k1' })
    const run = await start(f, workId)
    expect(run.prepared.selection).toEqual(PI)
    await finish(f, run.payload, 'completed', { text: 'Done.' })
    await finish(f, second.payload, 'completed', { text: 'Sure.' })
    expect(said()).toBe(1)
    // It runs again, then breaks again: said once more.
    f.pickMiss = undefined
    const third = await chat('Now?', 'm3')
    expect(third.prepared.selection).toEqual({ instanceId: 'claude', model: 'opus' })
    await finish(f, third.payload, 'completed', { text: 'Yes.' })
    expect(f.store.registry(botId)!.model!.missing).toBeUndefined()
    f.pickMiss = (pick) => (pick.instanceId === 'claude' ? broken : undefined)
    const fourth = await chat('And now?', 'm4')
    await finish(f, fourth.payload, 'completed', { text: 'Hm.' })
    expect(said()).toBe(2)
  })

  it('a bot from before rows keeps working: its one model by name on Talk and Work', async () => {
    await f.bots.service.modelSet(botId, 'opus')
    expect(f.bots.definitionOf(botId).main.slots).toBeUndefined()
    const turn = await chat('Hi', 'm1')
    expect(f.resolved.at(-1)).toEqual({ pick: { model: 'opus' }, depth: 'normal' })
    const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Job', brief: 'Do it.', key: 'k1', level: 'hard' })
    await start(f, workId)
    expect(f.resolved.at(-1)).toEqual({ pick: { model: 'opus' }, depth: 'deep' })
  })
})
