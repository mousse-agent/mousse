import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmProviderOption } from '../src/shared/settings'
import { groupModelsByFamily } from '../src/shared/modelVariants'
import {
  familyFavoritesPatch,
  importLegacyModelFavorites,
  isFamilyFavorite,
  planLegacyFavoritesImport
} from '../src/renderer/lib/modelFavorites'
import { instanceBadges, pickerIdFor, pickerProviders, showsContextGauge, sortInstances } from '../src/renderer/lib/providerSnapshots'
import { sortPickerEntries } from '../src/renderer/components/ModelFamilyMenu'
import { profilePreferenceKey } from '../src/renderer/lib/profilePreferences'
import { model, snapshot } from './providerSnapshotFixture'

const claudeModels = [model('claude-opus-4', { label: 'Claude Opus 4' }), model('claude-sonnet-4', { label: 'Claude Sonnet 4' })]

describe('composer picker from snapshots', () => {
  const catalog: LlmProviderOption[] = [
    { id: 'claude-subscription', instanceId: 'claude', label: 'Claude Code', models: [{ id: 'claude-opus-4', label: 'Claude Opus 4', speed: 'fast' }] }
  ]

  it('shows the daemon catalog as it is until snapshots arrive', () => {
    expect(pickerProviders(undefined, catalog)).toEqual([{ ...catalog[0], llmProvider: 'claude-subscription' }])
  })

  it('lists enabled instances with their visible models, caps and status', () => {
    const providers = pickerProviders(
      [
        snapshot({ models: { entries: [claudeModels[0], { ...claudeModels[1], hidden: true }], source: 'live' } }),
        snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex', enabled: { device: true, project: false, effective: false, setBy: 'project' }, models: { entries: [model('gpt-5')], source: 'live' } })
      ],
      catalog
    )
    expect(providers).toHaveLength(1)
    expect(providers[0]).toMatchObject({
      id: 'claude-subscription',
      instanceId: 'claude',
      llmProvider: 'claude-subscription',
      label: 'Claude Code',
      models: [{ id: 'claude-opus-4', label: 'Claude Opus 4', speed: 'fast' }],
      status: { headline: 'Signed in · Max plan', tone: 'ready' }
    })
    expect(providers[0].caps?.planMode).toBe(true)
  })

  it('tells a second Claude Code account apart by its instance id', () => {
    const work = snapshot({ instanceId: 'claude:work', displayName: 'Claude Code 2', builtIn: false, models: { entries: claudeModels, source: 'live' } })
    const [entry] = pickerProviders([work], [])
    expect(entry).toMatchObject({ id: 'claude:work', instanceId: 'claude:work', llmProvider: 'claude-subscription' })
    expect(pickerIdFor({ instanceId: 'claude:work', llmProvider: 'claude-subscription' }, [entry])).toBe('claude:work')
    expect(pickerIdFor({ llmProvider: 'claude-subscription' }, [entry])).toBe('claude-subscription')
  })

  it('orders providers as Settings does: Claude Code and its accounts, Codex, Antigravity, then APIs by name (D8)', () => {
    const order = sortInstances([
      snapshot({ instanceId: 'pi:zai', driver: 'pi', displayName: 'Z.ai' }),
      snapshot({ instanceId: 'antigravity', driver: 'antigravity', displayName: 'Antigravity' }),
      snapshot({ instanceId: 'claude:work', displayName: 'Claude Code 2', builtIn: false }),
      snapshot({ instanceId: 'pi:anthropic', driver: 'pi', displayName: 'Anthropic' }),
      snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex' }),
      snapshot()
    ])
    expect(order.map((entry) => entry.instanceId)).toEqual(['claude', 'claude:work', 'codex', 'antigravity', 'pi:anthropic', 'pi:zai'])
    const providers = pickerProviders(
      [snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex', models: { entries: [model('gpt-5')], source: 'live' } }), snapshot({ models: { entries: claudeModels, source: 'live' } })],
      []
    )
    expect(providers.map((entry) => entry.instanceId)).toEqual(['claude', 'codex'])
  })

  it('keeps the saved model order and puts favorites first in the picker (D6)', () => {
    const entries = [
      { id: 'a', providerRank: 0, familyRank: 0 },
      { id: 'b', providerRank: 0, familyRank: 1 },
      { id: 'c', providerRank: 1, familyRank: 0 },
      { id: 'd', providerRank: 1, familyRank: 1 }
    ]
    expect(sortPickerEntries(entries, () => false).map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(sortPickerEntries([...entries].reverse(), (entry) => entry.id === 'd').map((entry) => entry.id)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('badges a second account that shares a logo with what sets its name apart (D5)', () => {
    const badges = instanceBadges([
      { key: 'claude-subscription', iconKey: 'claude', label: 'Claude Code' },
      { key: 'codex', iconKey: 'openai', label: 'Codex' },
      { key: 'claude:work', iconKey: 'claude', label: 'Claude Code 2' },
      { key: 'claude:team', iconKey: 'claude', label: 'Team Max' }
    ])
    expect(Object.fromEntries(badges)).toEqual({ 'claude:work': '2', 'claude:team': 'TM' })
  })

  it('reads the context gauge from caps, keeping it when unknown', () => {
    const caps = snapshot().caps
    expect(showsContextGauge({ id: 'x', label: 'x', models: [], caps: { ...caps, contextUsage: 'none' } })).toBe(false)
    expect(showsContextGauge({ id: 'x', label: 'x', models: [], caps: { ...caps, contextUsage: 'measured' } })).toBe(true)
    expect(showsContextGauge(undefined)).toBe(true)
  })
})

describe('favorites', () => {
  const family = groupModelsByFamily('claude-subscription', claudeModels)[0]

  it('stars and unstars a whole family', () => {
    const starred = familyFavoritesPatch(family, new Set(['other']), true).favorites ?? []
    expect(isFamilyFavorite(family, new Set(starred))).toBe(true)
    expect(familyFavoritesPatch(family, new Set(starred), false).favorites).toEqual(['other'])
  })

  it('plans the import of legacy keys onto the instance serving each provider', () => {
    const claude = snapshot({ models: { entries: claudeModels, source: 'live' } })
    const pi = snapshot({ instanceId: 'pi:openai', driver: 'pi', displayName: 'OpenAI', models: { entries: [model('gpt-5', { label: 'GPT-5', favorite: true }), model('gpt-4.1', { label: 'GPT-4.1' })], source: 'live' } })
    const opus = groupModelsByFamily('claude-subscription', claudeModels).find((entry) => entry.familyLabel.includes('Opus'))!
    const gpt41 = groupModelsByFamily('openai', pi.models.entries).find((entry) => entry.familyLabel.includes('4.1'))!
    const patches = planLegacyFavoritesImport(new Set([opus.familyId, gpt41.familyId, 'gone:Old model']), [claude, pi])
    expect(patches.get('claude')).toEqual({ favorites: ['claude-opus-4'] })
    expect(patches.get('pi:openai')).toEqual({ favorites: ['gpt-5', 'gpt-4.1'] })
  })

  describe('one-time import from localStorage', () => {
    const store = new Map<string, string>()
    const key = profilePreferenceKey('p1', 'modelFavorites')
    const ready = [snapshot({ models: { entries: claudeModels, source: 'live' } })]
    const opusKey = groupModelsByFamily('claude-subscription', claudeModels).find((entry) => entry.familyLabel.includes('Opus'))!.familyId

    beforeEach(() => {
      store.clear()
      vi.stubGlobal('localStorage', {
        getItem: (name: string) => store.get(name) ?? null,
        setItem: (name: string, value: string) => void store.set(name, value),
        removeItem: (name: string) => void store.delete(name)
      })
    })
    afterEach(() => vi.unstubAllGlobals())

    it('writes the favorites to the daemon, then removes the key', async () => {
      store.set(key, JSON.stringify([opusKey]))
      const setModelPrefs = vi.fn(async () => undefined)
      await importLegacyModelFavorites('p1', ready, setModelPrefs)
      expect(setModelPrefs).toHaveBeenCalledWith('claude', { favorites: ['claude-opus-4'] })
      expect(store.has(key)).toBe(false)
    })

    it('keeps the key when the daemon write fails, so the next load tries again', async () => {
      store.set(key, JSON.stringify([opusKey]))
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      await importLegacyModelFavorites('p1', ready, async () => {
        throw new Error('not_implemented')
      })
      expect(store.get(key)).toBe(JSON.stringify([opusKey]))
    })

    it('waits until every instance has finished a check', async () => {
      store.set(key, JSON.stringify([opusKey]))
      const setModelPrefs = vi.fn(async () => undefined)
      await importLegacyModelFavorites('p1', [snapshot({ checkedAt: undefined, models: { entries: [], source: 'none' } })], setModelPrefs)
      expect(setModelPrefs).not.toHaveBeenCalled()
      expect(store.has(key)).toBe(true)
    })

    it('does nothing without legacy favorites', async () => {
      const setModelPrefs = vi.fn(async () => undefined)
      await importLegacyModelFavorites('p1', ready, setModelPrefs)
      expect(setModelPrefs).not.toHaveBeenCalled()
    })
  })
})
