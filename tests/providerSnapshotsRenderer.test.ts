import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmProviderOption } from '../src/shared/settings'
import { groupModelsByFamily } from '../src/shared/modelVariants'
import {
  familyFavoritesPatch,
  importLegacyModelFavorites,
  isFamilyFavorite,
  planLegacyFavoritesImport,
  saveModelPrefs
} from '../src/renderer/lib/modelFavorites'
import {
  beginProfileSwitch,
  instanceBadges,
  pickerIdFor,
  pickerProviders,
  showsContextGauge,
  sortInstances,
  useProviderSnapshotsStore
} from '../src/renderer/lib/providerSnapshots'
import { useAppStore } from '../src/renderer/stores/appStore'
import { sendErrorLine } from '../src/renderer/lib/errorText'
import { getGroupedModelButtonParts, makerLabelOf, modelRowSubtitle, sortPickerEntries } from '../src/renderer/components/ModelFamilyMenu'
import { profilePreferenceKey } from '../src/renderer/lib/profilePreferences'
import { resolveModelChoice } from '../src/renderer/lib/modelChoice'
import { modelLabel } from '../src/shared/modelChoice'
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

  describe('row subtitle', () => {
    const family = (modelId: string, label: string, providerId = 'vercel-ai-gateway') =>
      groupModelsByFamily(providerId, [model(modelId, { label })])[0]!
    const gateway = (modelId: string, label: string) => makerLabelOf('vercel-ai-gateway', 'Vercel AI Gateway', family(modelId, label))

    it('names the maker alone in a list of one provider', () => {
      const entry = { providerName: 'Vercel AI Gateway', makerLabel: gateway('deepseek/deepseek-v4-flash', 'DeepSeek V4.1 Flash') }
      expect(entry.makerLabel).toBe('DeepSeek')
      expect(modelRowSubtitle(entry, true)).toBe('DeepSeek')
    })

    it('keeps the provider with the maker across providers', () => {
      const entry = { providerName: 'Vercel AI Gateway', makerLabel: 'Google' }
      expect(modelRowSubtitle(entry, false)).toBe('Vercel AI Gateway · Google')
      expect(modelRowSubtitle({ providerName: 'Anthropic' }, false)).toBe('Anthropic')
    })

    it('shows no line for a model made by its own provider', () => {
      expect(modelRowSubtitle({ providerName: 'Anthropic', makerLabel: undefined }, true)).toBeUndefined()
      expect(makerLabelOf('anthropic', 'Anthropic', family('claude-opus-4', 'Claude Opus 4', 'anthropic'))).toBeUndefined()
      expect(makerLabelOf('claude', 'Claude Code', family('claude-opus-4', 'Claude Opus 4', 'claude'))).toBeUndefined()
      expect(makerLabelOf('claude:work', 'Claude Code', { brandId: 'anthropic', brandLabel: 'Anthropic' })).toBeUndefined()
    })

    it('never shows a raw provider id as the maker', () => {
      const maker = gateway('ember-1', 'Ember-1')
      expect(maker).toBeUndefined()
      expect(modelRowSubtitle({ providerName: 'Vercel AI Gateway', makerLabel: maker }, false)).toBe('Vercel AI Gateway')
      expect(modelRowSubtitle({ providerName: 'Vercel AI Gateway', makerLabel: maker }, true)).toBeUndefined()
    })
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

  it('names a settings selection by its instance when two accounts share a provider (S7)', () => {
    const listings: LlmProviderOption[] = [
      { id: 'claude-subscription', instanceId: 'claude', label: 'Claude Code', models: [{ id: 'opus', label: 'Claude Opus' }] },
      { id: 'claude-subscription', instanceId: 'claude:work', label: 'Claude Code 2', models: [{ id: 'work-only', label: 'Work Model' }] }
    ]
    expect(getGroupedModelButtonParts('claude-subscription', 'work-only', listings, false, 'claude:work')).toEqual(['Work Model'])
    // Beside the maker's logo the button drops the brand.
    expect(getGroupedModelButtonParts('claude-subscription', 'opus', listings, false, 'claude')).toEqual(['Opus'])
    // Without its instance the selection is not found in a listing, and is named from its id.
    expect(getGroupedModelButtonParts('claude-subscription', 'work-only', listings, false)).toEqual(['Work Only'])
  })

  it('names a hidden model by its listed name on the model button, in a switch marker and in a send error', () => {
    const haiku = model('haiku', { label: 'Haiku 4.5', hidden: true })
    useProviderSnapshotsStore.setState({ scopes: { device: { loading: false, snapshots: [snapshot({ models: { entries: [claudeModels[0], haiku], source: 'live' } })] } } })
    try {
      const listings = pickerProviders(useProviderSnapshotsStore.getState().scopes.device!.snapshots, [])
      expect(getGroupedModelButtonParts('claude-subscription', 'haiku:low', listings, false)).toEqual(['Haiku 4.5'])
      expect(modelLabel(resolveModelChoice({ provider: 'claude-subscription', model: 'haiku:low' }))).toBe('Claude Haiku 4.5 · Low')
      expect(modelLabel(resolveModelChoice({ provider: 'claude-subscription', model: 'claude-opus-4' }))).toBe('Claude Opus 4')
      expect(modelLabel(resolveModelChoice({ provider: 'claude-subscription', model: 'unknown-model' }))).toBe('Unknown Model')
    } finally {
      useProviderSnapshotsStore.setState({ scopes: {} })
    }
    // Before any list loads, a switch marker still reads as names, not ids.
    const named = (provider: string, stored: string) => modelLabel(resolveModelChoice({ provider, model: stored }))
    expect(named('claude-subscription', 'sonnet:low')).toBe('Claude Sonnet · Low')
    expect(named('claude-subscription', 'claude-haiku-5-5')).toBe('Claude Haiku 5.5')
    expect(named('claude-subscription', 'claude-sonnet-4-5-20250929:high')).toBe('Claude Sonnet 4.5 · High')
    expect(named('claude-subscription', 'opus:fast')).toBe('Claude Opus (fast)')
    expect(named('claude-subscription', 'opus@1m:high')).toBe('Claude Opus · 1m · High')
    expect(named('codex', 'gpt-5.3-codex:xhigh')).toBe('GPT-5.3 Codex · XHigh')
    expect(sendErrorLine({ code: 'model_hidden', message: 'Haiku 4.5 is hidden.' })).toBe('Haiku 4.5 is hidden.')
    expect(sendErrorLine({ code: 'internal_error', message: 'Boom' })).toBe('[internal_error] Boom')
  })

  it('names a Codex selection while its list is empty: by the name it last had, else from its id', () => {
    const codex = (names?: Record<string, string>) =>
      snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex', models: { entries: [], source: 'none', ...(names ? { names } : {}) } })
    const codexChoice = { instanceId: 'codex', provider: 'codex', model: 'gpt-6.1-sol:low' }
    useProviderSnapshotsStore.setState({ scopes: { device: { loading: false, snapshots: [codex({ 'gpt-6.1-sol': 'GPT-6.1 Sol (preview)' })] } } })
    try {
      // The empty listing leaves the picker, so the button is named from what the daemon remembers.
      const listings = pickerProviders(useProviderSnapshotsStore.getState().scopes.device!.snapshots, [])
      expect(listings).toEqual([])
      expect(getGroupedModelButtonParts('codex', 'gpt-6.1-sol:low', listings, false, 'codex')).toEqual(['GPT-6.1 Sol'])
      expect(modelLabel(resolveModelChoice(codexChoice))).toBe('GPT-6.1 Sol · Low')
      useProviderSnapshotsStore.setState({ scopes: { device: { loading: false, snapshots: [codex()] } } })
      expect(getGroupedModelButtonParts('codex', 'gpt-6.1-sol:low', [], false, 'codex')).toEqual(['GPT-6.1 Sol'])
    } finally {
      useProviderSnapshotsStore.setState({ scopes: {} })
    }
    // With nothing loaded at all, the stored string never shows.
    for (const stored of ['gpt-6.1-sol:low', 'opus@1m:fast:high', 'claude-3-5-haiku-20241022:max']) {
      const parts = getGroupedModelButtonParts('codex', stored, [], true)
      expect(parts.join(' · ')).not.toContain(':')
      expect(parts.join(' · ')).not.toContain(stored)
    }
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

  it('stars and unstars a whole family as an edit of the stored favorites', () => {
    const ids = family.variants.map((variant) => variant.id)
    expect(familyFavoritesPatch(family, true)).toEqual({ star: ids })
    expect(familyFavoritesPatch(family, false)).toEqual({ unstar: ids })
    expect(isFamilyFavorite(family, new Set(['other', ids[0]!]))).toBe(true)
  })

  it('saves the prefs of one instance one after another, so an older reply never lands last', async () => {
    const replies: Array<() => void> = []
    const setModelPrefs = vi.fn(() => new Promise<never>((_resolve, reject) => replies.push(() => reject(new Error('offline')))))
    vi.stubGlobal('window', { mousse: { providers: { instances: { setModelPrefs } } } })
    try {
      const first = saveModelPrefs('claude', { order: ['b', 'a'] })
      const second = saveModelPrefs('claude', { star: ['a'] })
      await vi.waitFor(() => expect(setModelPrefs).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(setModelPrefs).toHaveBeenCalledTimes(1)
      replies.shift()!()
      await expect(first).rejects.toThrow('offline')
      // A failed save does not stop the next one.
      await vi.waitFor(() => expect(setModelPrefs).toHaveBeenCalledTimes(2))
      expect(setModelPrefs).toHaveBeenLastCalledWith('claude', { star: ['a'] })
      replies.shift()!()
      await expect(second).rejects.toThrow('offline')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  describe('a profile switch while saves wait', () => {
    const SAVED_IN_A = 'claude-opus-4'
    const setup = () => {
      const calls: Array<{ profile: string; patch: unknown }> = []
      let release!: () => void
      const setModelPrefs = async (_id: string, patch: unknown) => {
        calls.push({ profile: useAppStore.getState().profileId, patch })
        if (calls.length === 1) await new Promise<void>((resolve) => (release = resolve))
        return snapshot({ models: { entries: [model(SAVED_IN_A, { favorite: true })], source: 'live' } })
      }
      vi.stubGlobal('window', { mousse: { providers: { instances: { setModelPrefs } } } })
      useAppStore.setState({ profileId: 'a' })
      useProviderSnapshotsStore.setState({ profileId: 'a', scopes: { device: { loading: false, snapshots: [snapshot()] } } })
      return { calls, release: () => release() }
    }
    const bindB = () => {
      useAppStore.setState({ profileId: 'b' })
      useProviderSnapshotsStore.setState({ profileId: 'b', scopes: { device: { loading: false, snapshots: [snapshot()] } } })
    }
    const deviceModels = () => useProviderSnapshotsStore.getState().scopes.device?.snapshots?.[0]?.models.entries.map((entry) => entry.id)

    afterEach(() => {
      vi.unstubAllGlobals()
      useAppStore.setState({ profileId: 'default' })
      useProviderSnapshotsStore.setState({ profileId: null, scopes: {} })
    })

    it('drops the save queued behind a pending one, and the pending reply, once the window is bound to another profile', async () => {
      const { calls, release } = setup()
      const first = saveModelPrefs('claude', { star: ['sonnet'] })
      await vi.waitFor(() => expect(calls).toHaveLength(1))
      const second = saveModelPrefs('claude', { hide: ['opus'] })
      bindB()
      release()
      await Promise.all([first, second])
      expect(calls).toEqual([{ profile: 'a', patch: { star: ['sonnet'] } }])
      // Profile A's reply is not merged into profile B's snapshots.
      expect(deviceModels()).not.toContain(SAVED_IN_A)
      // A save made in profile B is sent there and shown.
      await saveModelPrefs('claude', { star: ['x'] })
      expect(calls[1]).toEqual({ profile: 'b', patch: { star: ['x'] } })
      expect(deviceModels()).toContain(SAVED_IN_A)
    })

    it('drops a queued save as soon as the switch starts, before the renderer learns the new profile', async () => {
      const { calls, release } = setup()
      const first = saveModelPrefs('claude', { star: ['sonnet'] })
      await vi.waitFor(() => expect(calls).toHaveLength(1))
      const second = saveModelPrefs('claude', { hide: ['opus'] })
      const endSwitch = beginProfileSwitch()
      release()
      await Promise.all([first, second])
      // A save made while the switch is under way is not sent either.
      await saveModelPrefs('claude', { unhide: ['opus'] })
      endSwitch(true)
      bindB()
      expect(calls).toEqual([{ profile: 'a', patch: { star: ['sonnet'] } }])
    })

    it('a switch that fails leaves later saves going to the same profile', async () => {
      const { calls, release } = setup()
      beginProfileSwitch()(false)
      const saving = saveModelPrefs('claude', { star: ['sonnet'] })
      await vi.waitFor(() => expect(calls).toHaveLength(1))
      release()
      await saving
      expect(calls).toEqual([{ profile: 'a', patch: { star: ['sonnet'] } }])
      expect(deviceModels()).toContain(SAVED_IN_A)
    })
  })

  it('plans the import of legacy keys onto the instance serving each provider', () => {
    const claude = snapshot({ models: { entries: claudeModels, source: 'live' } })
    const pi = snapshot({ instanceId: 'pi:openai', driver: 'pi', displayName: 'OpenAI', models: { entries: [model('gpt-5', { label: 'GPT-5', favorite: true }), model('gpt-4.1', { label: 'GPT-4.1' })], source: 'live' } })
    const opus = groupModelsByFamily('claude-subscription', claudeModels).find((entry) => entry.familyLabel.includes('Opus'))!
    const gpt41 = groupModelsByFamily('openai', pi.models.entries).find((entry) => entry.familyLabel.includes('4.1'))!
    const patches = planLegacyFavoritesImport(new Set([opus.familyId, gpt41.familyId, 'gone:Old model']), [claude, pi])
    expect(patches.get('claude')).toEqual({ star: ['claude-opus-4'] })
    expect(patches.get('pi:openai')).toEqual({ star: ['gpt-4.1'] })
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
      useAppStore.setState({ profileId: 'p1' })
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      useAppStore.setState({ profileId: 'default' })
      useProviderSnapshotsStore.setState({ profileId: null, scopes: {} })
    })

    it('writes the favorites to the daemon, then removes the key', async () => {
      store.set(key, JSON.stringify([opusKey]))
      const setModelPrefs = vi.fn(async () => 'saved' as const)
      await importLegacyModelFavorites('p1', ready, setModelPrefs)
      expect(setModelPrefs).toHaveBeenCalledWith('claude', { star: ['claude-opus-4'] }, expect.objectContaining({ profileId: 'p1' }))
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
      const setModelPrefs = vi.fn(async () => 'saved' as const)
      await importLegacyModelFavorites('p1', [snapshot({ checkedAt: undefined, models: { entries: [], source: 'none' } })], setModelPrefs)
      expect(setModelPrefs).not.toHaveBeenCalled()
      expect(store.has(key)).toBe(true)
    })

    it('does nothing without legacy favorites', async () => {
      const setModelPrefs = vi.fn(async () => 'saved' as const)
      await importLegacyModelFavorites('p1', ready, setModelPrefs)
      expect(setModelPrefs).not.toHaveBeenCalled()
    })

    describe('a profile switch during an import of several providers', () => {
      const openAiModels = [model('gpt-5', { label: 'GPT-5' }), model('gpt-4.1', { label: 'GPT-4.1' })]
      const both = [
        snapshot({ models: { entries: claudeModels, source: 'live' } }),
        snapshot({ instanceId: 'pi:openai', driver: 'pi', displayName: 'OpenAI', models: { entries: openAiModels, source: 'live' } })
      ]
      const gptKey = groupModelsByFamily('openai', openAiModels).find((entry) => entry.familyLabel.includes('4.1'))!.familyId
      const legacy = JSON.stringify([opusKey, gptKey])
      const setup = () => {
        const calls: Array<{ profile: string; instanceId: string; patch: unknown }> = []
        let release: (() => void) | undefined
        let hold = true
        const setModelPrefs = async (instanceId: string, patch: unknown) => {
          calls.push({ profile: useAppStore.getState().profileId, instanceId, patch })
          if (hold) {
            hold = false
            await new Promise<void>((resolve) => (release = resolve))
          }
          return snapshot({ instanceId })
        }
        vi.stubGlobal('window', { mousse: { providers: { instances: { setModelPrefs } } } })
        useProviderSnapshotsStore.setState({ profileId: 'p1', scopes: { device: { loading: false, snapshots: both } } })
        store.set(key, legacy)
        return { calls, release: () => release!() }
      }

      it('keeps the key when a failed switch skipped a write, and a later load writes everything', async () => {
        const { calls, release } = setup()
        const importing = importLegacyModelFavorites('p1', both, saveModelPrefs)
        await vi.waitFor(() => expect(calls).toHaveLength(1))
        const endSwitch = beginProfileSwitch()
        release()
        await importing
        endSwitch(false)
        // The Claude write went out before the switch; the OpenAI one was skipped, so the key stays.
        expect(calls).toEqual([{ profile: 'p1', instanceId: 'claude', patch: { star: ['claude-opus-4'] } }])
        expect(store.get(key)).toBe(legacy)

        // Still profile p1: the next load imports every favorite and only then removes the key.
        await importLegacyModelFavorites('p1', both, saveModelPrefs)
        expect(calls.slice(1)).toEqual([
          { profile: 'p1', instanceId: 'claude', patch: { star: ['claude-opus-4'] } },
          { profile: 'p1', instanceId: 'pi:openai', patch: { star: ['gpt-4.1'] } }
        ])
        expect(store.has(key)).toBe(false)
      })

      it('sends nothing of the import to the new profile and keeps the key of the profile it started in', async () => {
        const { calls, release } = setup()
        const importing = importLegacyModelFavorites('p1', both, saveModelPrefs)
        await vi.waitFor(() => expect(calls).toHaveLength(1))
        const endSwitch = beginProfileSwitch()
        endSwitch(true)
        useAppStore.setState({ profileId: 'p2' })
        release()
        await importing
        expect(calls).toEqual([{ profile: 'p1', instanceId: 'claude', patch: { star: ['claude-opus-4'] } }])
        expect(store.get(key)).toBe(legacy)
        // An import for p1 does not start while the window is bound to p2.
        await importLegacyModelFavorites('p1', both, saveModelPrefs)
        expect(calls).toHaveLength(1)
      })
    })
  })
})
