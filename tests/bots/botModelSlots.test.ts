/**
 * A bot's models by situation (#673): Talk for the chat, Light, Medium and Hard work for the run lane, each a model the
 * owner picked on one entry, at a reasoning level. Covers the rows as stored (older definitions upgraded on read, a
 * round trip through an older build, rows a later build adds), which row a turn takes, a pick running only on its own
 * entry (never another, never a paid key it was not picked on), a pick that can't run leaving the bot stuck with Pick a
 * model and one line for the owner only, a pick at its usage limit making work wait, `set_depth` and `use_model` on the
 * rows, About saving against a change `use_model` made, and an automation's own pick.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OLD_MODEL_NAME_IGNORED } from '../../src/mms/bots/activation/BotEngine'
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

  it('Resume forgets an entry\'s usage limit in the model choice: the next turn tries it again', async () => {
    const limited = resolver()
    limited.markLimited('claude', '2030-06-01T12:00:00.000Z')
    limited.clearLimited('claude')
    expect(await limited.resolve({ botId: 'b', pick: onSub, depth: 'normal', policy })).toMatchObject({ selection: { instanceId: 'claude' } })
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

  it('Talk can\'t run: every owner message gets the line with no model call, working rows keep their schedules, and it clears by itself', async () => {
    f.bots.setOwnerSlots(botId, { talk: SUB_TALK, light: KEY_OPUS, medium: KEY_OPUS, hard: KEY_OPUS })
    f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 30 }, prompt: 'Headlines' }, 'owner')
    f.pickMiss = (pick) => (pick.instanceId === 'claude:sub' ? { label: 'Opus on Team Claude', reason: 'off' } : undefined)
    const line = 'I can\'t use Opus on Team Claude: it\'s turned off.'
    const said = () => chatOf(f, botId).filter((message) => message.error?.text === line)
    const chats = () => f.store.listActivations(botId).filter((row) => row.lane === 'chat' && (row.trigger.input === 'Hi' || row.trigger.input === 'Again'))
    await f.bots.service.chatSend({ botId, text: 'Hi', clientRequestId: 'm1' })
    await flush()
    // The turn never ran on the API key beside it, nor on anything: no model call.
    expect(f.store.listActivations(botId).filter((row) => row.selection?.instanceId === 'pi:key')).toEqual([])
    expect(said()).toMatchObject([{ kind: 'error', error: { action: { kind: 'pick_model', label: 'Pick a model' } } }])
    expect(f.bots.service.get(botId).summary).toMatchObject({ state: 'stuck', stateText: `Needs you: ${line}`, error: { text: line, action: { kind: 'pick_model' } } })
    // Journaled as a hidden kind: no pack, search or read gives it to the bot.
    const journaled = f.journal.filter((row) => row.text === line)
    expect(journaled.map((row) => row.kind)).toEqual(['model_change'])
    // A second message is answered the same way: no message goes unanswered.
    await f.bots.service.chatSend({ botId, text: 'Again', clientRequestId: 'm2' })
    await flush()
    expect(said()).toHaveLength(2)
    for (const row of chats()) {
      expect(row).toMatchObject({ status: 'failed', endReason: 'bot_pick_unavailable', selection: null })
      expect(f.store.dispatches(row.id).every((dispatch) => dispatch.runId === null && dispatch.startedAt === null)).toBe(true)
    }
    expect(f.store.registry(botId)).toMatchObject({ failureStreak: 0, pausedReason: null })
    // Work on its own entry keeps running its schedules.
    const { inserted: [scheduled] } = await f.tickSchedules(new Date(f.clock.now + 31 * 60_000))
    const run = await start(f, scheduled!)
    expect(run.prepared.selection).toMatchObject({ instanceId: 'pi:key', model: 'opus' })
    await finish(f, run.payload, 'completed', { text: 'Done.' })
    expect(f.bots.service.get(botId).summary.error?.text).toBe(line)
    // The entry is back: the next check clears it without a word, and the messages sent meanwhile are not run.
    f.pickMiss = undefined
    const messages = chatOf(f, botId).length
    await f.tickSchedules(new Date(f.clock.now + 60_000))
    expect(f.bots.service.get(botId).summary.error).toBeUndefined()
    expect(chatOf(f, botId)).toHaveLength(messages)
    expect(chats().filter((row) => row.status !== 'failed')).toEqual([])
    const next = await chat('Now?', 'm3')
    expect(next.prepared.selection).toEqual({ instanceId: 'claude:sub', model: 'opus' })
  })

  it('Work can\'t run while Talk can: schedules skip with the reason and no run thread, work is not started, one line, no flapping; it clears by itself', async () => {
    f.bots.setOwnerSlots(botId, { talk: SUB_TALK, light: KEY_OPUS, medium: KEY_OPUS, hard: KEY_OPUS })
    f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 30 }, prompt: 'Headlines' }, 'owner')
    f.pickMiss = (pick) => (pick.instanceId === 'pi:key' ? { label: 'Opus on Anthropic API', reason: 'off' } : undefined)
    const line = 'I can\'t use Opus on Anthropic API: it\'s turned off.'
    const said = () => chatOf(f, botId).filter((message) => message.error?.text === line)
    const runs = () => f.store.listActivations(botId).filter((row) => row.lane === 'run')
    // The first run finds out: it ends, and the chat says so once.
    const { inserted: [first] } = await f.tickSchedules(new Date(f.clock.now + 31 * 60_000))
    await flush()
    expect(f.store.activation(first!)).toMatchObject({ status: 'failed', endReason: 'bot_pick_unavailable' })
    expect(said()).toHaveLength(1)
    expect(f.bots.service.get(botId).summary).toMatchObject({ state: 'stuck', error: { text: line, action: { kind: 'pick_model' } } })
    expect(f.bots.situationLines(botId)).toEqual([expect.stringMatching(/^Work can't run now: .*won't start, and its schedules are skipped\. .*About → Runs on\.$/)])
    // Talk still works, and a finished chat turn does not clear Work's state, nor say the line again.
    const turn = await chat('Hi', 'm1')
    expect(turn.prepared.selection).toEqual({ instanceId: 'claude:sub', model: 'opus' })
    // Work the owner asks for is not started; the bot is told why.
    await expect(f.bots.tools.work.start(botId, turn.activation.id, { title: 'Research', brief: 'Research it.', key: 'k1' })).rejects.toThrow(/medium work can't run now\. Pick one in About → Runs on\./)
    await finish(f, turn.payload, 'completed', { text: 'Hello.' })
    expect(f.bots.service.get(botId).summary.error?.text).toBe(line)
    // Picking Talk again does not clear Work.
    f.bots.setOwnerSlots(botId, { talk: SUB_WORK })
    expect(f.bots.service.get(botId).summary.error?.text).toBe(line)
    // The next occurrence is skipped with the reason, with no run made.
    const before = runs().length
    const { inserted } = await f.tickSchedules(new Date(f.clock.now + 31 * 60_000))
    expect(inserted).toEqual([])
    expect(runs()).toHaveLength(before)
    expect(f.scheduler.listJobs().find((job) => job.bot?.botId === botId)?.botSkip).toMatchObject({ reason: 'model_unavailable' })
    expect(said()).toHaveLength(1)
    // The entry is back: cleared by itself, without a word, and the next occurrence runs on Work's entry.
    f.pickMiss = undefined
    const messages = chatOf(f, botId).length
    await f.tickSchedules(new Date(f.clock.now + 60_000))
    expect(f.bots.service.get(botId).summary.error).toBeUndefined()
    expect(chatOf(f, botId)).toHaveLength(messages)
    const { inserted: [third] } = await f.tickSchedules(new Date(f.clock.now + 31 * 60_000))
    const run = await start(f, third!)
    expect(run.prepared.selection).toMatchObject({ instanceId: 'pi:key', model: 'opus' })
  })

  it('a stuck row clears when the owner picks again for that row', async () => {
    f.bots.setOwnerSlots(botId, { talk: SUB_TALK, light: KEY_OPUS, medium: KEY_OPUS, hard: KEY_OPUS })
    f.pickMiss = (pick) => (pick.instanceId === 'pi:key' ? { label: 'Opus on Anthropic API', reason: 'off' } : undefined)
    f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 30 }, prompt: 'Headlines' }, 'owner')
    await f.tickSchedules(new Date(f.clock.now + 31 * 60_000))
    await flush()
    expect(f.bots.stuckRows(botId).map(([key]) => key)).toEqual(['light', 'medium', 'hard'])
    f.bots.setOwnerSlots(botId, { light: SUB_WORK, medium: SUB_WORK, hard: SUB_WORK })
    expect(f.bots.stuckRows(botId)).toEqual([])
    expect(f.bots.service.get(botId).summary.error).toBeUndefined()
  })

  it('a continuation checks the pick\'s sign-in again: an entry switched to an API key while the chat waited never runs it', async () => {
    f.bots.setOwnerSlots(botId, slotsAllOn(SUB_TALK))
    const turn = await chat('Hi', 'm1')
    expect(turn.prepared.selection).toEqual({ instanceId: 'claude:sub', model: 'opus' })
    // The turn ends at the turn cap; meanwhile the entry is switched to an API key.
    f.pickMiss = (pick) => (pick.instanceId === 'claude:sub' ? { label: 'Opus on Claude', reason: 'sign_in_changed' } : undefined)
    f.resolved.length = 0
    await finish(f, turn.payload, 'failed', { outcome: { error: '[provider_turn_cap] Reached maximum number of turns (30)' } })
    await flush()
    expect(f.resolved.map((entry) => entry.pick?.instanceId)).toEqual(['claude:sub'])
    expect(f.store.activation(turn.activation.id)).toMatchObject({ status: 'failed', endReason: 'bot_pick_unavailable' })
    // The continuation was never sent.
    expect(f.store.dispatches(turn.activation.id).slice(1).every((dispatch) => dispatch.runId === null && dispatch.startedAt === null)).toBe(true)
    expect(chatOf(f, botId).some((message) => message.error?.text === 'I can\'t use Opus on Claude: it signs in another way now.')).toBe(true)
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
    // Only its own pick is ever asked for (the run, then the check whether it can run again).
    expect(new Set(f.resolved.map((entry) => entry.pick?.model))).toEqual(new Set(['opus']))
    // While it can't run, its later occurrences are skipped with the reason, with no run made.
    const { inserted } = await f.tickSchedules(new Date(f.clock.now + 31 * 60_000))
    expect(inserted).toEqual([])
    expect(f.scheduler.listJobs().find((job) => job.bot?.botId === botId)?.botSkip).toMatchObject({ reason: 'model_unavailable' })
  })

  it('an automation saved with a model by name, on a bot whose rows are all picked, runs on Work and says so once; on a bot by usage, by name as before', async () => {
    // Made before any bot has picks, so it starts by usage.
    const other = (await createBot(f, { name: 'Old', description: 'From before picks.', reply: 'Hi.' })).botId
    f.bots.setOwnerSlots(botId, { talk: SUB_TALK, light: SUB_WORK, medium: SUB_WORK, hard: SUB_WORK })
    f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 30 }, prompt: 'Headlines', model: 'grok' }, 'owner')
    const { inserted: [first] } = await f.tickSchedules(new Date(f.clock.now + 31 * 60_000))
    const run = await start(f, first!)
    expect(run.prepared.selection).toEqual({ instanceId: 'claude:sub', model: 'sonnet' })
    expect(f.resolved.at(-1)?.pick).toEqual(SUB_WORK)
    await finish(f, run.payload, 'completed', { text: 'Done.' })
    const { inserted: [second] } = await f.tickSchedules(new Date(f.clock.now + 31 * 60_000))
    await finish(f, (await start(f, second!)).payload, 'completed', { text: 'Done.' })
    const notes = chatOf(f, botId).filter((message) => message.text === OLD_MODEL_NAME_IGNORED)
    expect(notes.map((message) => message.activationId)).toEqual([first])
    // A bot that still runs by usage: the automation's model by name, as before.
    expect(f.bots.definitionOf(other).main.slots).toBeUndefined()
    f.bots.addSchedule(other, { when: { kind: 'interval', minutes: 30 }, prompt: 'Headlines', model: 'grok' }, 'owner')
    const { inserted: [old] } = await f.tickSchedules(new Date(f.clock.now + 31 * 60_000))
    await start(f, old!)
    expect(f.resolved.at(-1)?.pick).toEqual({ model: 'grok' })
  })

  it('a usage limit on one of two entries holds only the rows on it: the others keep their schedules; said once; Resume clears it', async () => {
    f.bots.setOwnerSlots(botId, { talk: SUB_TALK, light: KEY_OPUS, medium: KEY_OPUS, hard: KEY_OPUS })
    f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 30 }, prompt: 'Headlines' }, 'owner')
    const until = new Date(f.clock.now + 5 * HOUR).toISOString()
    const limits = () => chatOf(f, botId).filter((message) => message.error?.text?.startsWith('Paused until'))
    // Talk meets its entry's limit.
    const turn = await chat('Hi', 'm1')
    await finish(f, turn.payload, 'failed', { outcome: { error: 'provider_usage_limit', usageLimitUntil: until } })
    await flush()
    expect(limits()).toHaveLength(1)
    expect(f.bots.service.get(botId).summary).toMatchObject({ state: 'paused', stateText: expect.stringMatching(/^Paused until /) })
    // Another message while limited: no call, and no second line.
    await f.bots.service.chatSend({ botId, text: 'Again', clientRequestId: 'm2' })
    await flush()
    expect(limits()).toHaveLength(1)
    // Work on the other entry keeps running its schedule.
    const { inserted: [scheduled] } = await f.tickSchedules(new Date(f.clock.now + 31 * 60_000))
    const run = await start(f, scheduled!)
    expect(run.prepared.selection).toMatchObject({ instanceId: 'pi:key' })
    await finish(f, run.payload, 'completed', { text: 'Done.' })
    // Resume clears the limit and tries again.
    await f.bots.service.resume(botId)
    expect(f.bots.service.get(botId).summary.state).not.toBe('paused')
    const after = await chat('Now?', 'm3')
    expect(after.prepared.selection).toEqual({ instanceId: 'claude:sub', model: 'opus' })
  })

  it('a limit the provider names for one family holds only that family\'s models on the entry', async () => {
    f.bots.setOwnerSlots(botId, { talk: SUB_TALK, light: SUB_WORK, medium: SUB_WORK, hard: SUB_WORK })
    f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 30 }, prompt: 'Headlines' }, 'owner')
    const until = new Date(f.clock.now + 24 * HOUR).toISOString()
    const turn = await chat('Hi', 'm1')
    await finish(f, turn.payload, 'failed', { outcome: { error: 'provider_usage_limit', usageLimitUntil: until, usageLimitKind: 'seven_day_opus' } })
    await flush()
    // Sonnet on the same entry is not at that limit: its schedule runs.
    const { inserted: [scheduled] } = await f.tickSchedules(new Date(f.clock.now + 31 * 60_000))
    expect((await start(f, scheduled!)).prepared.selection).toMatchObject({ instanceId: 'claude:sub', model: 'sonnet' })
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
