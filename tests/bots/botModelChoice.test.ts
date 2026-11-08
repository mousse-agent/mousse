/**
 * Bot Phase 1 §5.6: the hidden model choice. A depth maps to a tier and an effort; subscriptions,
 * then newer releases, win within a tier; a usage limit moves to the next candidate; a model the
 * owner named is used only while it is there.
 */
import { describe, expect, it } from 'vitest'
import { chooseBotModel, effortFor, nameMatch, type BotModelCandidate } from '../../src/mms/bots/model/chooseModel'
import { botModelTier, patternModelTier } from '../../src/shared/bots/personal/modelTiers'
import type { ModelCatalog } from '../../src/shared/modelCatalog'

const now = new Date('2026-11-07T10:00:00.000Z')
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const claude = (model: string, tier: BotModelCandidate['tier'], released: string, names: string[] = []): BotModelCandidate => ({
  instanceId: 'claude:bots', model, efforts: EFFORTS, defaultEffort: 'medium', tier, credential: 'subscription', released, names
})
const pi = (model: string, tier: BotModelCandidate['tier']): BotModelCandidate => ({
  instanceId: 'pi:openai', model, efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium', tier, credential: 'api_key'
})

const CLAUDE = [
  claude('claude-opus-5-5', 'frontier', '2026-09-22', ['opus', 'claude opus 5.5', 'opus 5.5']),
  claude('claude-sonnet-5-5', 'standard', '2026-09-28', ['sonnet', 'claude sonnet 5.5', 'sonnet 5.5']),
  claude('claude-sonnet-4-6', 'standard', '2026-02-17', ['sonnet', 'sonnet 4.6']),
  claude('claude-haiku-5-5', 'small', '2026-10-07', ['haiku'])
]
const PI = [pi('gpt-5.1', 'standard'), pi('gpt-5.1-mini', 'small'), pi('gpt-5-pro', 'frontier')]
const BOTH = [...PI, ...CLAUDE]

describe('chooseBotModel', () => {
  it('Claude subscription and a Pi OpenAI key: normal is Claude standard at its default effort', () => {
    expect(chooseBotModel({ mode: 'auto', depth: 'normal' }, BOTH, now)).toEqual({ selection: { instanceId: 'claude:bots', model: 'claude-sonnet-5-5', effort: 'medium' } })
  })

  it('the same, deep: Claude frontier at high effort', () => {
    expect(chooseBotModel({ mode: 'auto', depth: 'deep' }, BOTH, now)).toEqual({ selection: { instanceId: 'claude:bots', model: 'claude-opus-5-5', effort: 'high' } })
  })

  it('the same, quick: Claude standard at low effort (not Haiku)', () => {
    expect(chooseBotModel({ mode: 'auto', depth: 'quick' }, BOTH, now)).toEqual({ selection: { instanceId: 'claude:bots', model: 'claude-sonnet-5-5', effort: 'low' } })
  })

  it('Pi only: a Pi model of the right tier for each depth', () => {
    expect(chooseBotModel({ mode: 'auto', depth: 'normal' }, PI, now)).toEqual({ selection: { instanceId: 'pi:openai', model: 'gpt-5.1', effort: 'medium' } })
    expect(chooseBotModel({ mode: 'auto', depth: 'deep' }, PI, now)).toEqual({ selection: { instanceId: 'pi:openai', model: 'gpt-5-pro', effort: 'high' } })
    expect(chooseBotModel({ mode: 'auto', depth: 'quick' }, PI, now)).toEqual({ selection: { instanceId: 'pi:openai', model: 'gpt-5.1', effort: 'low' } })
  })

  it('after a usage limit on Claude, normal falls to Pi; with every candidate limited, all_limited with the earliest reset', () => {
    const limited = BOTH.map((candidate) => (candidate.instanceId === 'claude:bots' ? { ...candidate, limitedUntil: '2026-11-07T14:00:00.000Z' } : candidate))
    expect(chooseBotModel({ mode: 'auto', depth: 'normal' }, limited, now)).toEqual({ selection: { instanceId: 'pi:openai', model: 'gpt-5.1', effort: 'medium' } })
    const all = limited.map((candidate) => (candidate.instanceId === 'pi:openai' ? { ...candidate, limitedUntil: '2026-11-07T12:00:00.000Z' } : candidate))
    expect(chooseBotModel({ mode: 'auto', depth: 'normal' }, all, now)).toEqual({ problem: 'all_limited', until: '2026-11-07T12:00:00.000Z', instanceId: 'pi:openai' })
    // A reset that passed counts for nothing.
    const passed = BOTH.map((candidate) => ({ ...candidate, limitedUntil: '2026-11-07T09:00:00.000Z' }))
    expect(chooseBotModel({ mode: 'auto', depth: 'normal' }, passed, now)).toMatchObject({ selection: { model: 'claude-sonnet-5-5' } })
  })

  it('small is used only when no standard model exists; unknown only when no known tier does', () => {
    const smallOnly = [claude('claude-haiku-5-5', 'small', '2026-10-07'), { ...pi('local-thing', 'unknown') }]
    expect(chooseBotModel({ mode: 'auto', depth: 'quick' }, smallOnly, now)).toMatchObject({ selection: { model: 'claude-haiku-5-5' } })
    expect(chooseBotModel({ mode: 'auto', depth: 'deep' }, smallOnly, now)).toMatchObject({ selection: { model: 'claude-haiku-5-5' } })
    expect(chooseBotModel({ mode: 'auto', depth: 'normal' }, [pi('local-thing', 'unknown')], now)).toMatchObject({ selection: { model: 'local-thing' } })
  })

  it('no candidates: no_provider', () => {
    expect(chooseBotModel({ mode: 'auto', depth: 'normal' }, [], now)).toEqual({ problem: 'no_provider' })
  })

  it('named: an exact name, a family word or an id; a model that is not there is named_unavailable', () => {
    expect(chooseBotModel({ mode: 'named', model: 'opus', depth: 'normal' }, BOTH, now)).toEqual({ selection: { instanceId: 'claude:bots', model: 'claude-opus-5-5', effort: 'medium' } })
    expect(chooseBotModel({ mode: 'named', model: 'Sonnet 4.6', depth: 'deep' }, BOTH, now)).toEqual({ selection: { instanceId: 'claude:bots', model: 'claude-sonnet-4-6', effort: 'high' } })
    // A family word picks the newest of the family.
    expect(chooseBotModel({ mode: 'named', model: 'sonnet', depth: 'normal' }, BOTH, now)).toMatchObject({ selection: { model: 'claude-sonnet-5-5' } })
    expect(chooseBotModel({ mode: 'named', model: 'gpt-5-pro', depth: 'normal' }, BOTH, now)).toMatchObject({ selection: { model: 'gpt-5-pro' } })
    expect(chooseBotModel({ mode: 'named', model: 'grok', depth: 'normal' }, BOTH, now)).toEqual({ problem: 'named_unavailable' })
  })
})

describe('efforts', () => {
  it('quick low, deep high, normal the default; the nearest offered otherwise', () => {
    expect(effortFor('quick', { efforts: ['medium', 'high'] })).toBe('medium')
    expect(effortFor('deep', { efforts: ['low', 'medium'] })).toBe('medium')
    expect(effortFor('normal', { efforts: ['low', 'medium'], defaultEffort: 'medium' })).toBe('medium')
    expect(effortFor('normal', { efforts: ['low', 'medium'] })).toBeUndefined()
    expect(effortFor('deep', { efforts: [] })).toBeUndefined()
    // "none" is never a depth's effort.
    expect(effortFor('quick', { efforts: ['none', 'medium'] })).toBe('medium')
  })
})

describe('model tiers', () => {
  const catalog: ModelCatalog = {
    format: 1,
    revision: 2,
    models: [{ id: 'acme-ember-2', name: 'Acme Ember 2', short: 'Ember 2', maker: 'acme', tier: 'frontier', released: '2030-01-01', routes: { claude: { id: 'ember-2-route' } } }]
  }

  it('the catalog wins; the pattern table covers models outside it', () => {
    expect(botModelTier('acme-ember-2', catalog)).toBe('frontier')
    expect(botModelTier('ember-2-route', catalog)).toBe('frontier')
    expect(botModelTier('openai/gpt-5.1-mini', catalog)).toBe('small')
    expect(botModelTier('gpt-5.1', catalog)).toBe('standard')
    expect(botModelTier('gpt-5-pro', catalog)).toBe('frontier')
    expect(botModelTier('grok-4.1', catalog)).toBe('standard')
    expect(botModelTier('grok-4-mini', catalog)).toBe('small')
    expect(botModelTier('gemini-3-pro', catalog)).toBe('frontier')
    expect(botModelTier('gemini-3-flash', catalog)).toBe('standard')
    expect(botModelTier('gemini-3-flash-lite', catalog)).toBe('small')
    expect(botModelTier('opus[1m]', catalog)).toBe('frontier')
    expect(botModelTier('sonnet', catalog)).toBe('standard')
    expect(botModelTier('something-local', catalog)).toBe('unknown')
    expect(patternModelTier('haiku')).toBe('small')
  })

  it('names match by exact words before family words', () => {
    expect(nameMatch('claude-opus-5-5', { model: 'claude-opus-5-5' })).toBe(2)
    expect(nameMatch('opus', { model: 'claude-opus-5-5' })).toBe(1)
    expect(nameMatch('Opus 5.5', { model: 'claude-opus-5-5', names: ['opus 5.5'] })).toBe(2)
    expect(nameMatch('gpt', { model: 'claude-opus-5-5' })).toBe(0)
  })
})
