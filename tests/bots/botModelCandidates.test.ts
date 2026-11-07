/**
 * Bot Phase 1 §5.6: the candidates a bot's model is chosen from, and the daemon's resolver. Only
 * ready instances whose runtime can hold the bot count: the owner's own entries (Claude Code, Codex,
 * Pi), never one added for bots. A usage limit is remembered until its reset.
 */
import { describe, expect, it } from 'vitest'
import { createBotModelResolver } from '../../src/mms/bots/model/BotModelResolver'
import { botModelCandidates, signInCandidate } from '../../src/mms/bots/model/candidates'
import type { BotRuntimeHold } from '../../src/mms/bots/seams'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import type { InstanceModel, RunPolicy } from '../../src/shared/harness/types'
import type { ModelCatalog } from '../../src/shared/modelCatalog'

const policy: RunPolicy = { mode: 'default', origin: 'bot', approvals: 'grants', tools: { allow: ['read', 'web_search'] }, authority: { kind: 'bot', digest: 'd1' } }

const catalog: ModelCatalog = {
  format: 1,
  revision: 2,
  models: [
    { id: 'acme-big-2', name: 'Acme Big 2', short: 'Big 2', maker: 'acme', family: 'big', tier: 'frontier', released: '2030-03-01', routes: { claude: { id: 'acme-big-2' } } },
    { id: 'acme-mid-2', name: 'Acme Mid 2', short: 'Mid 2', maker: 'acme', family: 'mid', tier: 'standard', released: '2030-02-01', routes: { claude: { id: 'acme-mid-2' } } }
  ]
}

function snapshot(instanceId: string, patch: { driver?: InstanceSnapshot['driver']; auth?: Partial<InstanceSnapshot['auth']>; enabled?: boolean; runs?: InstanceSnapshot['runs']['state'] } = {}): InstanceSnapshot {
  return {
    instanceId,
    driver: patch.driver ?? 'pi',
    displayName: instanceId,
    builtIn: false,
    scope: { kind: 'device' },
    enabled: { device: patch.enabled ?? true, effective: patch.enabled ?? true, setBy: 'device' },
    runs: { state: patch.runs ?? 'yes' },
    auth: { state: 'signed_in', ...patch.auth }
  } as unknown as InstanceSnapshot
}

const model = (id: string, patch: Partial<InstanceModel> = {}): InstanceModel => ({
  id, label: id, source: 'catalog', capabilities: { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', images: false }, hidden: false, favorite: false, ...patch
})

const MODELS: Record<string, InstanceModel[]> = {
  'claude': [model('acme-big-2'), model('acme-mid-2'), model('acme-hidden', { hidden: true })],
  'pi:openai': [model('gpt-5.1'), model('gpt-5.1-mini')],
  codex: [model('default'), model('gpt-5.1-codex'), model('gpt-5.1-codex-mini')],
  'pi:off': [model('gpt-5.1')],
  'pi:out': [model('gpt-5.1')],
  'pi:refused': [model('gpt-5.1')]
}

const SNAPSHOTS = [
  snapshot('claude', { driver: 'claude', auth: { credential: 'subscription' } }),
  snapshot('pi:openai', { auth: { credential: 'api_key' } }),
  snapshot('codex', { driver: 'codex', auth: { credential: undefined } }),
  snapshot('pi:off', { enabled: false }),
  snapshot('pi:out', { auth: { state: 'signed_out' } }),
  snapshot('pi:refused')
]

const hold: BotRuntimeHold = {
  canHoldBot: (instanceId) => (instanceId === 'pi:refused'
    ? { ok: false, error: { code: 'policy_unenforceable', message: 'no gate', missing: ['toolControl'] } }
    : { ok: true })
}

describe('botModelCandidates', () => {
  it('keeps the owner\'s ready entries that can hold the bot, Claude Code and Codex included, and their visible models with tiers', () => {
    const candidates = botModelCandidates({ snapshots: SNAPSHOTS, models: (id) => MODELS[id] ?? [], hold, policy, catalog })
    expect(candidates.map((candidate) => `${candidate.instanceId}/${candidate.model}`)).toEqual([
      'claude/acme-big-2', 'claude/acme-mid-2', 'pi:openai/gpt-5.1', 'pi:openai/gpt-5.1-mini', 'codex/default', 'codex/gpt-5.1-codex', 'codex/gpt-5.1-codex-mini'
    ])
    expect(candidates[0]).toMatchObject({ tier: 'frontier', credential: 'subscription', released: '2030-03-01', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' })
    expect(candidates[0].names).toEqual(expect.arrayContaining(['acme big 2', 'big 2', 'big']))
    expect(candidates[2]).toMatchObject({ tier: 'standard', credential: 'api_key' })
    expect(candidates[3]).toMatchObject({ tier: 'small' })
  })

  it('gives Codex sensible tiers: its default is standard, a subscription, ranked in its own order', () => {
    const candidates = botModelCandidates({ snapshots: SNAPSHOTS, models: (id) => MODELS[id] ?? [], hold, policy, catalog })
    const codex = candidates.filter((candidate) => candidate.instanceId === 'codex')
    expect(codex.map((candidate) => [candidate.model, candidate.tier, candidate.credential, candidate.listed])).toEqual([
      ['default', 'standard', 'subscription', 0], ['gpt-5.1-codex', 'standard', 'subscription', 1], ['gpt-5.1-codex-mini', 'small', 'subscription', 2]
    ])
    // Claude Code's own aliases: Sonnet is standard, Opus frontier, Haiku small; its `default` is unknown.
    const claude = botModelCandidates({ snapshots: [snapshot('claude', { driver: 'claude', auth: { credential: 'subscription' } })], models: () => [model('default'), model('opus'), model('sonnet'), model('haiku')], hold, policy })
    expect(claude.map((candidate) => [candidate.model, candidate.tier])).toEqual([['default', 'unknown'], ['opus', 'frontier'], ['sonnet', 'standard'], ['haiku', 'small']])
  })

  it('a runtime that cannot hold the bot is never a candidate', () => {
    const candidates = botModelCandidates({ snapshots: SNAPSHOTS, models: (id) => MODELS[id] ?? [], hold, policy, catalog })
    expect(candidates.some((candidate) => candidate.instanceId === 'pi:refused')).toBe(false)
    const any = botModelCandidates({ snapshots: SNAPSHOTS, models: (id) => MODELS[id] ?? [], hold: { canHoldBot: () => ({ ok: true }) }, policy, catalog })
    expect(any.some((candidate) => candidate.instanceId === 'pi:refused')).toBe(true)
  })

  it('carries usage limits by instance', () => {
    const candidates = botModelCandidates({ snapshots: SNAPSHOTS, models: (id) => MODELS[id] ?? [], hold, policy, catalog, limited: new Map([['claude', '2030-01-01T00:00:00.000Z']]) })
    expect(candidates.filter((candidate) => candidate.limitedUntil).map((candidate) => candidate.model)).toEqual(['acme-big-2', 'acme-mid-2'])
  })

  it('names the owner\'s own entry to sign in to when a bot could run after a sign-in', () => {
    const waiting = [snapshot('claude', { driver: 'claude', auth: { state: 'signed_out', canSignIn: true } }), snapshot('pi:x', { auth: { state: 'signed_out', canSignIn: true } })]
    expect(signInCandidate({ snapshots: waiting, hold, policy })).toBe('claude')
    expect(signInCandidate({ snapshots: [snapshot('codex', { driver: 'codex', auth: { state: 'signed_out', canSignIn: true } })], hold, policy })).toBe('codex')
    // The owner's terminal sign-in still opens that entry's card, after one Mousse can sign in itself.
    expect(signInCandidate({ snapshots: [snapshot('codex', { driver: 'codex', auth: { state: 'signed_out' } })], hold, policy })).toBe('codex')
    expect(signInCandidate({ snapshots: [snapshot('codex', { driver: 'codex', auth: { state: 'signed_out' } }), snapshot('pi:x', { auth: { state: 'expired', canSignIn: true } })], hold, policy })).toBe('pi:x')
    expect(signInCandidate({ snapshots: [snapshot('pi:off', { enabled: false, auth: { state: 'signed_out', canSignIn: true } })], hold, policy })).toBeUndefined()
  })
})

describe('BotModelResolver', () => {
  let clock = new Date('2030-06-01T10:00:00.000Z')
  const resolver = (snapshots = SNAPSHOTS) => createBotModelResolver({ snapshots: async () => snapshots, models: (id) => MODELS[id] ?? [], hold, catalog: () => catalog, now: () => clock })

  it('resolves auto per depth, and a limit moves to the next candidate until its reset', async () => {
    const chooser = resolver()
    expect(await chooser.resolve({ botId: 'b1', choice: { mode: 'auto', depth: 'normal' }, policy })).toEqual({ selection: { instanceId: 'claude', model: 'acme-mid-2', effort: 'medium' } })
    expect(await chooser.resolve({ botId: 'b1', choice: { mode: 'auto', depth: 'normal' }, override: { mode: 'auto', depth: 'deep' }, policy })).toEqual({ selection: { instanceId: 'claude', model: 'acme-big-2', effort: 'high' } })
    chooser.markLimited('claude', '2030-06-01T14:00:00.000Z')
    // The next subscription wins over an API key: Codex, on its own default.
    expect(await chooser.resolve({ botId: 'b1', choice: { mode: 'auto', depth: 'normal' }, policy })).toEqual({ selection: { instanceId: 'codex', model: 'default', effort: 'medium' } })
    chooser.markLimited('codex', '2030-06-01T13:00:00.000Z')
    expect(await chooser.resolve({ botId: 'b1', choice: { mode: 'auto', depth: 'normal' }, policy })).toEqual({ selection: { instanceId: 'pi:openai', model: 'gpt-5.1', effort: 'medium' } })
    chooser.markLimited('pi:openai', '2030-06-01T12:00:00.000Z')
    expect(await chooser.resolve({ botId: 'b1', choice: { mode: 'auto', depth: 'normal' }, policy })).toEqual({ problem: 'all_limited', until: '2030-06-01T12:00:00.000Z', instanceId: 'pi:openai' })
    clock = new Date('2030-06-01T15:00:00.000Z')
    expect(await chooser.resolve({ botId: 'b1', choice: { mode: 'auto', depth: 'normal' }, policy })).toMatchObject({ selection: { instanceId: 'claude' } })
  })

  it('a named model that is not there leaves the bot on auto; use_model can ask first', async () => {
    const chooser = resolver()
    expect(await chooser.resolve({ botId: 'b1', choice: { mode: 'named', model: 'grok', depth: 'normal' }, policy })).toMatchObject({ selection: { model: 'acme-mid-2' } })
    expect(await chooser.resolve({ botId: 'b1', choice: { mode: 'named', model: 'Big 2', depth: 'quick' }, policy })).toEqual({ selection: { instanceId: 'claude', model: 'acme-big-2', effort: 'low' } })
    expect(await chooser.namedAvailable('big')).toBe(true)
    expect(await chooser.namedAvailable('grok')).toBe(false)
  })

  it('with no candidate, no_provider names an instance to sign in to when there is one', async () => {
    const out = [snapshot('claude', { driver: 'claude', auth: { state: 'signed_out', canSignIn: true } })]
    expect(await resolver(out).resolve({ botId: 'b1', choice: { mode: 'auto', depth: 'normal' }, policy })).toEqual({ problem: 'no_provider', instanceId: 'claude' })
    expect(await resolver([]).resolve({ botId: 'b1', choice: { mode: 'auto', depth: 'normal' }, policy })).toEqual({ problem: 'no_provider' })
  })

  it('reads the enabled instances\' policy facts again before the hold checks', async () => {
    // A locked entry holds the bot only on a fresh reading, as `canHoldBot` does with a stale one.
    const fresh = new Set<string>()
    const freshHold: BotRuntimeHold = { canHoldBot: (instanceId) => (fresh.has(instanceId) ? { ok: true } : { ok: false, error: { code: 'policy_unenforceable', message: 'stale', missing: ['toolControl'] } }) }
    const refreshed: string[] = []
    const chooser = createBotModelResolver({
      snapshots: async () => [snapshot('claude', { driver: 'claude', auth: { credential: 'subscription' } }), snapshot('pi:off', { enabled: false })],
      models: (id) => MODELS[id] ?? [],
      hold: freshHold,
      refresh: async (instanceId) => { refreshed.push(instanceId); fresh.add(instanceId) },
      catalog: () => catalog,
      now: () => clock
    })
    expect(await chooser.resolve({ botId: 'b1', choice: { mode: 'auto', depth: 'normal' }, policy })).toMatchObject({ selection: { instanceId: 'claude' } })
    expect(refreshed).toEqual(['claude'])
  })
})
