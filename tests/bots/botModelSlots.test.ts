/**
 * A bot's models by situation (#673): Talk for the chat, Light, Medium and Hard work for the run lane, each a model the
 * owner picked on one entry, at a reasoning level. Covers the rows as stored (older definitions upgraded on read, a
 * round trip through an older build, rows a later build adds), which row a turn takes, a pick running only on its own
 * entry (never another, never a paid key it was not picked on), a pick that can't run leaving the bot stuck with Pick a
 * model and one line for the owner only, a pick at its usage limit making work wait, `set_depth` and `use_model` on the
 * rows, About saving against a change `use_model` made, and an automation's own pick.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBotModelResolver } from '../../src/mms/bots/model/BotModelResolver'
import type { BotRuntimeHold } from '../../src/mms/bots/seams'
import type { BotActivationTrigger, BotModelSlots, BotThreadSpec } from '../../src/shared/bots/personal/definition'
import type { BotModelOption } from '../../src/shared/bots/personal/methods'
import { modelSlotsProblem, ownerNamesModel, pickProblemText, plainLabel, slotsAllOn, slotsOf, slotsWith, turnModelOf, UNPICKED_SLOTS, withSlots, workRowsDiffer } from '../../src/shared/bots/personal/modelSlots'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import type { InstanceModel, RunPolicy } from '../../src/shared/harness/types'
import type { ModelCatalog } from '../../src/shared/modelCatalog'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, type BotFixture } from './botFixture'

const TALK = { instanceId: 'claude', model: 'opus' }
const LIGHT = { instanceId: 'pi:key', model: 'haiku', effort: 'low' }
const MEDIUM = { instanceId: 'pi:key', model: 'sonnet' }
const HARD = { instanceId: 'claude', model: 'opus', effort: 'high' }
const ROWS: BotModelSlots = { talk: TALK, light: LIGHT, medium: MEDIUM, hard: HARD }

/** A right-to-left override, which a label must never carry. */
const RTL = String.fromCharCode(0x202e)
const thread = (model: BotThreadSpec['model'], slots?: BotModelSlots): Pick<BotThreadSpec, 'model' | 'slots'> => ({ model, ...(slots ? { slots } : {}) })
const chatTurn = { lane: 'chat' as const, trigger: { kind: 'manual', input: 'hi' } as BotActivationTrigger }
const work = (level?: 'light' | 'medium' | 'hard') => ({ lane: 'run' as const, trigger: { kind: 'work', input: 'x', title: 'x', from: 'a', ...(level ? { level } : {}) } as BotActivationTrigger })

describe('the rows as stored', () => {
  it('older definitions are read as rows: Mousse choosing on every row, or one model by name on every row', () => {
    expect(slotsOf(thread({ mode: 'auto', depth: 'normal' }))).toEqual(UNPICKED_SLOTS)
    expect(slotsOf(thread({ mode: 'named', model: 'opus', depth: 'deep' }))).toEqual(slotsAllOn({ model: 'opus' }))
  })

  it('picks are written beside a marked mirror of Talk; one model by name alone needs no rows', () => {
    const written = withSlots(thread({ mode: 'auto', depth: 'deep' }), ROWS)
    expect(written).toEqual({ model: { mode: 'named', model: 'opus ', depth: 'deep' }, slots: ROWS })
    expect(slotsOf(written)).toEqual(ROWS)
    expect(withSlots(written, slotsAllOn({ model: 'opus' }))).toEqual({ model: { mode: 'named', model: 'opus', depth: 'deep' } })
    expect(withSlots(written, UNPICKED_SLOTS)).toEqual({ model: { mode: 'auto', depth: 'deep' } })
    // A bot from before picks whose owner picked Work only: the mirror is Work's model.
    expect(withSlots(thread({ mode: 'auto', depth: 'normal' }), { ...UNPICKED_SLOTS, light: MEDIUM, medium: MEDIUM, hard: MEDIUM }).model).toEqual({ mode: 'named', model: 'sonnet ', depth: 'normal' })
  })

  it('a round trip through an older build: its rewrite of the model drops the rows for good, even when it writes the same model again; a change of depth keeps them', () => {
    const written = withSlots(thread({ mode: 'auto', depth: 'normal' }), ROWS)
    // An older build's set_depth always keeps the mirror as it is and changes the depth only.
    expect(slotsOf({ ...written, model: { mode: 'named', model: 'opus ', depth: 'quick' } })).toEqual(ROWS)
    // Its use_model or single picker writes a name, trimmed: the rows are stale.
    expect(slotsOf({ ...written, model: { mode: 'named', model: 'sonnet', depth: 'normal' } })).toEqual(slotsAllOn({ model: 'sonnet' }))
    // Then the same model as Talk's again: still its own choice, by name, never the old rows.
    expect(slotsOf({ ...written, model: { mode: 'named', model: 'opus', depth: 'normal' } })).toEqual(slotsAllOn({ model: 'opus' }))
    expect(slotsOf({ ...written, model: { mode: 'auto', depth: 'normal' } })).toEqual(UNPICKED_SLOTS)
  })

  it('rows a later build adds are ignored and kept; a malformed known row is refused, and incomplete rows are not read', () => {
    const written = withSlots(thread({ mode: 'auto', depth: 'normal' }), ROWS)
    const later = { ...written, slots: { ...ROWS, images: { instanceId: 'pi:x', model: 'img', size: 'big' } } as unknown as BotModelSlots }
    expect(modelSlotsProblem(later.slots)).toBeUndefined()
    expect(slotsOf(later)).toEqual(ROWS)
    // This build writing the rows again keeps the later row.
    expect((withSlots(later, { ...ROWS, talk: MEDIUM }).slots as unknown as Record<string, unknown>).images).toEqual({ instanceId: 'pi:x', model: 'img', size: 'big' })
    // A field a later build adds to a pick is ignored too.
    expect(modelSlotsProblem({ ...ROWS, talk: { ...TALK, speed: 'fast' } })).toBeUndefined()
    expect(modelSlotsProblem({ ...ROWS, talk: { instanceId: 'claude' } })).toMatch(/model/)
    expect(modelSlotsProblem({ ...ROWS, light: 'opus' })).toBeDefined()
    expect(slotsOf({ ...written, slots: { talk: TALK } as unknown as BotModelSlots })).toEqual(slotsAllOn({ model: 'opus' }))
  })

  it('the simple view is Work on all three levels; Advanced shows when Light or Hard differs from Medium', () => {
    const simple = slotsWith(slotsWith(UNPICKED_SLOTS, 'talk', TALK), 'work', MEDIUM)
    expect(simple).toEqual({ talk: TALK, light: MEDIUM, medium: MEDIUM, hard: MEDIUM })
    expect(workRowsDiffer(simple)).toBe(false)
    expect(workRowsDiffer(ROWS)).toBe(true)
    expect(workRowsDiffer({ ...simple, hard: { ...MEDIUM, effort: 'high' } })).toBe(true)
  })
})

describe('which row a turn takes', () => {
  const spec = withSlots(thread({ mode: 'auto', depth: 'normal' }), ROWS)

  it('a chat turn takes Talk; work takes the row of the level it names, else the standing level', () => {
    expect(turnModelOf(spec, chatTurn)).toEqual({ slot: 'talk', pick: TALK, depth: 'normal' })
    expect(turnModelOf(spec, work('light'))).toEqual({ slot: 'light', pick: LIGHT, depth: 'quick' })
    expect(turnModelOf(spec, work('hard'))).toEqual({ slot: 'hard', pick: HARD, depth: 'deep' })
    expect(turnModelOf(spec, work())).toEqual({ slot: 'medium', pick: MEDIUM, depth: 'normal' })
    // A scheduled run names no level: the standing one, which `set_depth always` moves.
    const schedule = { lane: 'run' as const, trigger: { kind: 'schedule', input: 'x', scheduleId: 's', occurrenceAt: 't' } as BotActivationTrigger }
    expect(turnModelOf(spec, schedule)).toMatchObject({ slot: 'medium' })
    expect(turnModelOf({ ...spec, model: { ...spec.model, depth: 'deep' } }, schedule)).toEqual({ slot: 'hard', pick: HARD, depth: 'deep' })
  })

  it('an activation\'s own choice: set_depth now moves a run to that level\'s row; use_model now and an automation\'s pick replace the row', () => {
    expect(turnModelOf(spec, { ...work('hard'), modelOverride: { mode: 'auto', depth: 'quick' } })).toEqual({ slot: 'light', pick: LIGHT, depth: 'quick' })
    expect(turnModelOf(spec, { ...chatTurn, modelOverride: { mode: 'named', model: 'sonnet', instanceId: 'pi:key', credential: 'api_key', depth: 'normal' } })).toEqual({ slot: 'talk', pick: { instanceId: 'pi:key', model: 'sonnet', credential: 'api_key' }, depth: 'normal' })
    // An automation's model saved by name only (before picks kept their entry).
    expect(turnModelOf(spec, { ...work(), modelOverride: { mode: 'named', model: 'opus', depth: 'normal' } })).toEqual({ slot: 'medium', pick: { model: 'opus' }, depth: 'normal' })
  })
})

describe('words for the owner', () => {
  it('names a pick that can\'t run, from text cut to one plain line', () => {
    expect(pickProblemText({ label: 'Opus on Claude Code', reason: 'off' })).toBe('I can\'t use Opus on Claude Code: it\'s turned off.')
    expect(pickProblemText({ label: 'Opus on Claude Code', reason: 'sign_in_changed' })).toBe('I can\'t use Opus on Claude Code: it signs in another way now.')
    expect(plainLabel(`My\nendpoint${RTL}\u0007 [link](http://x)`)).toBe('My endpoint [link](http://x)')
    expect(plainLabel('x'.repeat(80))).toHaveLength(48)
  })

  it('use_model always needs the owner\'s own words to name the model, as whole words', () => {
    expect(ownerNamesModel('Please use Opus 5.5 from now on', ['Opus 5.5'])).toBe(true)
    expect(ownerNamesModel('switch to opus-5-5', ['claude-opus-5-5', 'Opus 5.5'])).toBe(true)
    expect(ownerNamesModel('use opus', ['opus'])).toBe(true)
    expect(ownerNamesModel('think harder please', ['opus', 'Opus 5.5'])).toBe(false)
    expect(ownerNamesModel('the opusculum', ['opus'])).toBe(false)
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

describe('a pick runs on its own entry or not at all', () => {
  const clock = new Date('2030-06-01T10:00:00.000Z')
  const SUB = snapshot('claude', 'Claude Code', { driver: 'claude', auth: { credential: 'subscription', account: { id: 'acct-1', label: 'me@example.com' } } })
  const KEY = snapshot('pi:key', 'Anthropic API', { auth: { credential: 'api_key' } })
  const MODELS: Record<string, InstanceModel[]> = { claude: [model('acme-big-2', 'Big 2'), model('acme-mid-2', 'Mid 2')], 'pi:key': [model('acme-big-2', 'Big 2')] }
  const anyHold: BotRuntimeHold = { canHoldBot: () => ({ ok: true }) }
  const resolver = (snapshots = [SUB, KEY], models = MODELS, hold = anyHold) =>
    createBotModelResolver({ snapshots: async () => snapshots, models: (id) => models[id] ?? [], hold, catalog: () => catalog, now: () => clock })
  const onSub = { instanceId: 'claude', model: 'acme-big-2', credential: 'subscription' as const, account: 'acct-1' }
  const onKey = { instanceId: 'pi:key', model: 'acme-big-2', credential: 'api_key' as const }

  it('lists the same model on both entries, named by entry, with its levels and what each entry signs in with', async () => {
    const options = await resolver().pickable()
    expect(options.map(({ names: _names, ...option }) => option)).toEqual([
      { instanceId: 'claude', entry: 'Claude Code', model: 'acme-big-2', label: 'Big 2', efforts: ['low', 'medium', 'high'], credential: 'subscription', account: 'acct-1' },
      { instanceId: 'claude', entry: 'Claude Code', model: 'acme-mid-2', label: 'Mid 2', efforts: ['low', 'medium', 'high'], credential: 'subscription', account: 'acct-1' },
      { instanceId: 'pi:key', entry: 'Anthropic API', model: 'acme-big-2', label: 'Big 2', efforts: ['low', 'medium', 'high'], credential: 'api_key' }
    ])
  })

  it('runs a pick on the entry it was picked on, at its own level, else the model\'s default at any depth', async () => {
    const chooser = resolver()
    expect(await chooser.resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })).toEqual({ selection: { instanceId: 'pi:key', model: 'acme-big-2', effort: 'medium' } })
    expect(await chooser.resolve({ botId: 'b', pick: onKey, depth: 'deep', policy })).toEqual({ selection: { instanceId: 'pi:key', model: 'acme-big-2', effort: 'medium' } })
    expect(await chooser.resolve({ botId: 'b', pick: { ...onKey, effort: 'high' }, depth: 'quick', policy })).toEqual({ selection: { instanceId: 'pi:key', model: 'acme-big-2', effort: 'high' } })
    expect(await chooser.resolve({ botId: 'b', pick: onSub, depth: 'normal', policy })).toEqual({ selection: { instanceId: 'claude', model: 'acme-big-2', effort: 'medium' } })
    // A pick saved before it remembered the sign-in has nothing to compare, and runs.
    expect(await chooser.resolve({ botId: 'b', pick: { instanceId: 'claude', model: 'acme-big-2' }, depth: 'normal', policy })).toMatchObject({ selection: { instanceId: 'claude' } })
  })

  it('a pick that can\'t run is a problem with why, never a selection on the other entry', async () => {
    const label = 'Big 2 on Anthropic API'
    expect(await resolver([SUB, snapshot('pi:key', 'Anthropic API', { enabled: false })]).resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })).toEqual({ problem: 'pick_unavailable', missed: { label, reason: 'off' } })
    expect(await resolver([SUB, snapshot('pi:key', 'Anthropic API', { auth: { state: 'signed_out' } })]).resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })).toMatchObject({ problem: 'pick_unavailable', missed: { reason: 'signed_out' } })
    // The entry is gone: no entry name, and the model's id when its models can't be read either.
    expect(await resolver([SUB]).resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })).toEqual({ problem: 'pick_unavailable', missed: { label: 'Big 2', reason: 'removed' } })
    expect(await resolver([SUB], { claude: MODELS.claude! }).resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })).toMatchObject({ missed: { label: 'acme-big-2', reason: 'removed' } })
    expect(await resolver([SUB, KEY], { ...MODELS, 'pi:key': [model('acme-big-2', 'Big 2', true)] }).resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })).toMatchObject({ missed: { reason: 'model_gone' } })
    const refuses: BotRuntimeHold = { canHoldBot: (instanceId) => (instanceId === 'pi:key' ? { ok: false, error: { code: 'policy_unenforceable', message: 'no', missing: ['toolControl'] } } : { ok: true }) }
    expect(await resolver([SUB, KEY], MODELS, refuses).resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })).toMatchObject({ problem: 'pick_unavailable', missed: { reason: 'cant_hold' } })
  })

  it('a subscription pick whose entry switched to an API key, or signed in to another account, can\'t run', async () => {
    const switched = snapshot('claude', 'Claude Code', { driver: 'claude', auth: { credential: 'api_key', account: { id: 'acct-1', label: 'API key' } } })
    expect(await resolver([switched, KEY]).resolve({ botId: 'b', pick: onSub, depth: 'normal', policy })).toEqual({ problem: 'pick_unavailable', missed: { label: 'Big 2 on Claude Code', reason: 'sign_in_changed' } })
    // Removed and added again under the same name: the same id, another account.
    const another = snapshot('claude', 'Claude Code', { driver: 'claude', auth: { credential: 'subscription', account: { id: 'acct-2', label: 'them@example.com' } } })
    expect(await resolver([another, KEY]).resolve({ botId: 'b', pick: onSub, depth: 'normal', policy })).toMatchObject({ problem: 'pick_unavailable', missed: { reason: 'account_changed' } })
    // An account the entry can't tell now is not a change.
    const unknown = snapshot('claude', 'Claude Code', { driver: 'claude', auth: { credential: 'subscription', account: { id: 'unknown', label: 'me' } } })
    expect(await resolver([unknown, KEY]).resolve({ botId: 'b', pick: onSub, depth: 'normal', policy })).toMatchObject({ selection: { instanceId: 'claude' } })
  })

  it('a pick at its usage limit waits for its reset, even when the same model is free through a paid API key', async () => {
    const limited = resolver()
    limited.markLimited('claude', '2030-06-01T12:00:00.000Z')
    expect(await limited.resolve({ botId: 'b', pick: onSub, depth: 'normal', policy })).toEqual({ problem: 'all_limited', until: '2030-06-01T12:00:00.000Z', instanceId: 'claude' })
  })

  it('an entry\'s name and a custom model\'s name reach the owner as one plain, short line', async () => {
    const odd = snapshot('pi:key', `Team\nKey${RTL}`.padEnd(80, '!'), { enabled: false })
    const result = await resolver([SUB, odd], { ...MODELS, 'pi:key': [model('acme-big-2', `Big\u0000 [click](http://evil) ${'x'.repeat(70)}`)] }).resolve({ botId: 'b', pick: onKey, depth: 'normal', policy })
    const label = 'missed' in result ? result.missed!.label : ''
    expect(label).not.toContain('\n')
    expect(label).not.toContain(String.fromCharCode(0))
    expect(label).not.toContain(RTL)
    expect(label.length).toBeLessThanOrEqual(48 + 4 + 40)
  })

  it('a bot from before picks: a model by name across entries, subscriptions first, and by usage when it is missing', async () => {
    const chooser = resolver()
    expect(await chooser.resolve({ botId: 'b', pick: { model: 'acme-big-2' }, depth: 'normal', policy })).toEqual({ selection: { instanceId: 'claude', model: 'acme-big-2', effort: 'medium' } })
    expect(await chooser.resolve({ botId: 'b', pick: { model: 'grok' }, depth: 'normal', policy })).toEqual({ selection: { instanceId: 'claude', model: 'acme-mid-2', effort: 'medium' } })
    expect(await chooser.resolve({ botId: 'b', pick: null, depth: 'deep', policy })).toEqual({ selection: { instanceId: 'claude', model: 'acme-big-2', effort: 'high' } })
  })

  it('use_model finds the owner\'s words among the same choices, a subscription first, with its entry\'s sign-in', async () => {
    expect(await resolver().pickFor('Big 2')).toMatchObject({ instanceId: 'claude', model: 'acme-big-2', credential: 'subscription', account: 'acct-1' })
    expect(await resolver([KEY]).pickFor('big')).toMatchObject({ instanceId: 'pi:key', model: 'acme-big-2', credential: 'api_key' })
    expect(await resolver().pickFor('grok')).toBeUndefined()
  })
})

// -- The engine ----------------------------------------------------------------------------------------------------

const SUB_TALK = { instanceId: 'claude:sub', model: 'opus', credential: 'subscription' as const }
const SUB_WORK = { instanceId: 'claude:sub', model: 'sonnet', credential: 'subscription' as const }
const KEY_OPUS = { instanceId: 'pi:key', model: 'opus', credential: 'api_key' as const }
const HOUR = 60 * 60_000
const limitedRun = (until: string) => ({ status: 'failed' as const, outcome: { error: 'provider_usage_limit', usageLimitUntil: until } })

describe('the engine on rows', () => {
  let f: BotFixture
  let botId: string

  beforeEach(async () => {
    f = botFixture()
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Pip', description: 'Keep my day in order.', reply: 'Hello.' })).botId
    // From here a paid API key is ready beside the subscription: a pick must never move to it.
    f.candidates = [{ instanceId: 'pi:key', model: 'opus' }]
    f.resolved.length = 0
  })

  afterEach(() => f.close())

  async function chat(text: string, id: string) {
    await f.bots.service.chatSend({ botId, text, clientRequestId: id })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    return { activation, ...(await start(f, activation.id)) }
  }

  it('a chat turn runs on Talk; work runs on the row of the level it names, else Medium', async () => {
    f.bots.setOwnerSlots(botId, ROWS)
    const turn = await chat('Three jobs', 'm1')
    expect(f.resolved.at(-1)).toEqual({ pick: TALK, depth: 'normal' })
    expect(turn.prepared.selection).toEqual({ instanceId: 'claude', model: 'opus' })
    const levels = [['hard', HARD, 'deep'], [undefined, MEDIUM, 'normal'], ['light', LIGHT, 'quick']] as const
    for (const [n, [level, pick, depth]] of levels.entries()) {
      const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: `Job ${n}`, brief: `Do ${n}.`, key: `k${n}`, ...(level ? { level } : {}) })
      const run = await start(f, workId)
      expect(f.resolved.at(-1)).toEqual({ pick, depth })
      expect(run.prepared.selection).toEqual({ instanceId: pick.instanceId, model: pick.model, ...('effort' in pick ? { effort: pick.effort } : {}) })
      await finish(f, run.payload, 'completed', { text: 'Done.' })
    }
    await finish(f, turn.payload, 'completed', { text: 'On it.' })
  })

  it('Talk and Work on different models journal a model change only when a row\'s model changes', async () => {
    f.bots.setOwnerSlots(botId, { talk: SUB_TALK, light: SUB_WORK, medium: SUB_WORK, hard: SUB_WORK })
    const changes = () => f.journal.filter((row) => row.kind === 'model_change' && row.botId === botId && (row.json as { row?: string } | undefined)?.row).length
    const before = changes()
    for (const n of [1, 2, 3]) {
      const turn = await chat(`Job ${n}`, `m${n}`)
      const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: `Job ${n}`, brief: 'Do it.', key: `k${n}` })
      await finish(f, turn.payload, 'completed', { text: 'On it.' })
      const run = await start(f, workId)
      await finish(f, run.payload, 'completed', { text: 'Done.' })
    }
    // Talk once (its model changed from before picks), Medium work once: no row on every alternation.
    expect(changes() - before).toBe(2)
  })

  it('set_depth: always moves the standing level; now moves a run to another row; on a pick that stays the same it changes nothing and says so', async () => {
    f.bots.setOwnerSlots(botId, ROWS)
    const turn = await chat('Think harder from now on', 'm1')
    expect(f.bots.tools.setModel(botId, turn.activation.id, 'always', { depth: 'deep' })).toEqual({ changed: true })
    expect(f.bots.definitionOf(botId).main.model).toEqual({ mode: 'named', model: 'opus ', depth: 'deep' })
    expect(f.bots.ownerSlots(botId)).toEqual(ROWS)
    const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Job', brief: 'Do it.', key: 'k1' })
    await start(f, workId)
    expect(f.resolved.at(-1)).toEqual({ pick: HARD, depth: 'deep' })
    expect(f.bots.tools.setModel(botId, workId, 'now', { depth: 'quick' })).toEqual({ changed: true })
    expect(turnModelOf(f.bots.definitionOf(botId).main, f.store.activation(workId)!)).toEqual({ slot: 'light', pick: LIGHT, depth: 'quick' })
    // In the chat Talk's pick keeps its model and level: nothing is set, so the turn does not restart.
    expect(f.bots.tools.setModel(botId, turn.activation.id, 'now', { depth: 'deep' })).toEqual({ changed: false })
    expect(f.store.activation(turn.activation.id)!).toMatchObject({ modelOverride: null, reloadPending: false })
    // One pick on all work: the standing level picks the same row's model either way.
    f.bots.setOwnerSlots(botId, { light: MEDIUM, hard: MEDIUM })
    expect(f.bots.tools.setModel(botId, turn.activation.id, 'always', { depth: 'quick' })).toEqual({ changed: false })
    // A run never switches its model.
    expect(() => f.bots.tools.setModel(botId, workId, 'now', { pick: TALK })).toThrow(/owner/)
  })

  it('use_model puts a pick, with its sign-in, on the rows the owner said; About then saves its own row over it, keeping the change', async () => {
    const turn = await chat('Use Opus for work from now on', 'm1')
    f.bots.tools.setModel(botId, turn.activation.id, 'always', { pick: SUB_TALK, rows: 'work' })
    expect(f.bots.ownerSlots(botId)).toEqual({ talk: null, light: SUB_TALK, medium: SUB_TALK, hard: SUB_TALK })
    f.bots.tools.setModel(botId, turn.activation.id, 'now', { pick: KEY_OPUS })
    expect(f.store.activation(turn.activation.id)!.modelOverride).toEqual({ mode: 'named', ...KEY_OPUS, depth: 'normal' })
    // About was opened before the change and shows the old rows; the owner picks Talk there. Only Talk is saved.
    const options = (f.bots.service as unknown as { options: { modelOptions?: () => Promise<BotModelOption[]> } }).options
    options.modelOptions = async () => [{ instanceId: 'claude:sub', entry: 'Claude', model: 'sonnet', label: 'Sonnet', efforts: [], credential: 'subscription' }]
    await f.bots.service.modelSlotsSet(botId, { slots: { talk: { instanceId: 'claude:sub', model: 'sonnet' } } })
    expect(f.bots.ownerSlots(botId)).toEqual({ talk: SUB_WORK, light: SUB_TALK, medium: SUB_TALK, hard: SUB_TALK })
    // Every row is a pick now: the single picker of an older app can't set it back to by usage.
    await expect(f.bots.service.modelSet(botId, null)).rejects.toMatchObject({ code: 'invalid_params' })
    // Closing Advanced copies Medium work's pick as it is, even when it is not offered now.
    f.bots.setOwnerSlots(botId, { light: SUB_WORK })
    await f.bots.service.modelSlotsSet(botId, { oneWork: true })
    expect(f.bots.ownerSlots(botId)).toEqual({ talk: SUB_WORK, light: SUB_TALK, medium: SUB_TALK, hard: SUB_TALK })
  })

  it('a pick that can\'t run: nothing else runs, the bot is stuck with Pick a model, and one line for the owner that the bot never sees', async () => {
    f.bots.setOwnerSlots(botId, slotsAllOn(SUB_TALK))
    f.pickMiss = (pick) => (pick.instanceId === 'claude:sub' ? { label: 'Opus on Team Claude', reason: 'off' } : undefined)
    const line = 'I can\'t use Opus on Team Claude: it\'s turned off.'
    const said = () => chatOf(f, botId).filter((message) => message.error?.text === line)
    await f.bots.service.chatSend({ botId, text: 'Hi', clientRequestId: 'm1' })
    await flush()
    // The turn never ran on the API key beside it.
    expect(f.store.listActivations(botId).filter((row) => row.selection?.instanceId === 'pi:key')).toEqual([])
    expect(said()).toMatchObject([{ kind: 'error', error: { action: { kind: 'pick_model', label: 'Pick a model' } } }])
    expect(f.bots.service.get(botId).summary).toMatchObject({ state: 'stuck', error: { text: line, action: { kind: 'pick_model' } } })
    // Journaled as a hidden kind: no pack, search or read gives it to the bot.
    const journaled = f.journal.filter((row) => row.text === line)
    expect(journaled.map((row) => row.kind)).toEqual(['model_change'])
    // Said once while it lasts: another message, and work, fail without a second line.
    await f.bots.service.chatSend({ botId, text: 'Again', clientRequestId: 'm2' })
    await flush()
    expect(said()).toHaveLength(1)
    expect(f.store.registry(botId)).toMatchObject({ failureStreak: 0, pausedReason: null })
    // It runs again: the bot is no longer stuck, and a later problem is said again.
    f.pickMiss = undefined
    const third = await chat('Now?', 'm3')
    expect(third.prepared.selection).toEqual({ instanceId: 'claude:sub', model: 'opus' })
    await finish(f, third.payload, 'completed', { text: 'Yes.' })
    expect(f.bots.service.get(botId).summary.error).toBeUndefined()
  })

  it('a usage limit on a subscription pick: the work waits for the reset and goes on, on the same entry; never on the paid key', async () => {
    f.bots.setOwnerSlots(botId, slotsAllOn(SUB_TALK))
    const turn = await chat('Research this', 'm1')
    const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Research', brief: 'Research it.', key: 'k1' })
    await finish(f, turn.payload, 'completed', { text: 'On it.' })
    await flush()
    expect(f.store.activation(workId)!.selection).toMatchObject({ instanceId: 'claude:sub' })
    const until = new Date(f.clock.now + 2 * HOUR).toISOString()
    await runDispatch(f, workId, 1, limitedRun(until))
    await flush()
    // Retried on the same pick, which is limited: it waits instead of moving entries.
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'usage_limit' })
    expect(f.resolved.filter((entry) => entry.pick?.instanceId !== 'claude:sub')).toEqual([])
    expect(f.store.listActivations(botId).filter((row) => row.selection?.instanceId === 'pi:key')).toEqual([])
    expect(chatOf(f, botId).filter((message) => message.kind === 'error').map((message) => message.error?.text)).toEqual([expect.stringMatching(/^Paused until .*I'll carry on with this then\.$/)])
    // At the reset the work goes on in its own thread, on the same entry.
    await f.tickSchedules(new Date(Date.parse(until) + 60_000))
    expect(f.store.activation(workId)).toMatchObject({ status: 'running', selection: { instanceId: 'claude:sub', model: 'opus' } })
    expect(f.store.dispatches(workId).at(-1)!.threadId).toBe(f.store.dispatch(workId, 1)!.threadId)
  })

  it('an automation\'s own pick runs on its entry; when it can\'t, the run ends stuck, never on the bot\'s Work row', async () => {
    f.bots.setOwnerSlots(botId, slotsAllOn(SUB_WORK))
    const options = (f.bots.service as unknown as { options: { modelOptions?: () => Promise<BotModelOption[]> } }).options
    options.modelOptions = async () => [{ instanceId: 'claude:sub', entry: 'Claude', model: 'opus', label: 'Opus', efforts: [], credential: 'subscription' }]
    await f.bots.service.addSchedule(botId, { kind: 'interval', minutes: 30 }, 'Headlines', 'opus')
    expect(f.bots.listSchedules(botId)).toHaveLength(1)
    expect(f.book.list(botId)[0]).toMatchObject({ model: 'opus', pick: SUB_TALK })
    // Not offered now: refused, never saved by name.
    await expect(f.bots.service.addSchedule(botId, { kind: 'interval', minutes: 30 }, 'News', 'grok')).rejects.toMatchObject({ code: 'model_unavailable' })
    const { inserted: [first] } = await f.tickSchedules(new Date(f.clock.now + 31 * 60_000))
    const run = await start(f, first!)
    expect(run.prepared.selection).toEqual({ instanceId: 'claude:sub', model: 'opus' })
    await finish(f, run.payload, 'completed', { text: 'Done.' })
    // Its entry is turned off: the next run ends with the pick's problem, and nothing runs on Work's model.
    f.pickMiss = (pick) => (pick.model === 'opus' ? { label: 'Opus on Claude', reason: 'off' } : undefined)
    f.resolved.length = 0
    const { inserted: [second] } = await f.tickSchedules(new Date(f.clock.now + 31 * 60_000))
    await flush()
    expect(f.store.activation(second!)).toMatchObject({ status: 'failed', endReason: 'bot_pick_unavailable' })
    expect(f.resolved.map((entry) => entry.pick?.model)).toEqual(['opus'])
  })

  it('a bot from before rows keeps working: its one model by name on Talk and Work', async () => {
    await f.bots.service.modelSet(botId, null)
    f.bots.setOwnerSlots(botId, slotsAllOn({ model: 'opus' }))
    expect(f.bots.definitionOf(botId).main.slots).toBeUndefined()
    const turn = await chat('Hi', 'm1')
    expect(f.resolved.at(-1)).toEqual({ pick: { model: 'opus' }, depth: 'normal' })
    const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Job', brief: 'Do it.', key: 'k1', level: 'hard' })
    await start(f, workId)
    expect(f.resolved.at(-1)).toEqual({ pick: { model: 'opus' }, depth: 'deep' })
  })
})
