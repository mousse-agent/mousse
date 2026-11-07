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
  composerAutoModel,
  composerSelection,
  fallbackModel,
  instanceBadges,
  pickerIdFor,
  pickerOffers,
  pickerProviders,
  showsContextGauge,
  sortInstances,
  useProviderSnapshotsStore
} from '../src/renderer/lib/providerSnapshots'
import { useAppStore } from '../src/renderer/stores/appStore'
import { sendErrorLine } from '../src/renderer/lib/errorText'
import { foldOlderEntries, withOpenListing, getGroupedModelButtonParts, makerLabelOf, modelRowSubtitle, sortPickerEntries } from '../src/renderer/components/ModelFamilyMenu'
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

  it('carries an older model\'s flag to the picker', () => {
    const [entry] = pickerProviders([snapshot({ models: { entries: [model('ember'), model('ember-1', { older: true })], source: 'live' } })], [])
    expect(entry.models).toEqual([{ id: 'ember', label: 'ember' }, { id: 'ember-1', label: 'ember-1', older: true }])
  })

  it('tells a second Claude Code account apart by its instance id', () => {
    const work = snapshot({ instanceId: 'claude:work', displayName: 'Claude Code 2', builtIn: false, models: { entries: claudeModels, source: 'live' } })
    const [entry] = pickerProviders([work], [])
    expect(entry).toMatchObject({ id: 'claude:work', instanceId: 'claude:work', llmProvider: 'claude-subscription' })
    expect(pickerIdFor({ instanceId: 'claude:work', llmProvider: 'claude-subscription' }, [entry])).toBe('claude:work')
    expect(pickerIdFor({ llmProvider: 'claude-subscription' }, [entry])).toBe('claude-subscription')
  })

  it('never offers the locked "Claude for bots" entry, which runs bot turns only', () => {
    const runner = snapshot({ instanceId: 'claude:bots', displayName: 'Claude for bots', builtIn: false, models: { entries: claudeModels, source: 'live' }, config: { home: 'private', args: [], env: {}, profile: 'locked' } })
    expect(pickerProviders([snapshot({ models: { entries: claudeModels, source: 'live' } }), runner], []).map((entry) => entry.instanceId)).toEqual(['claude'])
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

  describe('model a composer starts on without a usable default (#495)', () => {
    const codex = (overrides = {}) =>
      snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex', models: { entries: [model('gpt-5'), model('gpt-5-mini')], source: 'live' }, ...overrides })
    const claude = (overrides = {}) => snapshot({ models: { entries: claudeModels, source: 'live' }, ...overrides })

    it('takes the first listed model of the first ready provider, in picker order', () => {
      const providers = pickerProviders([codex(), claude()], [])
      expect(fallbackModel(providers)).toEqual({ instanceId: 'claude', llmProvider: 'claude-subscription', model: 'claude-opus-4' })
    })

    it('skips a provider that is switched off, signed out, or lists nothing', () => {
      const off = claude({ enabled: { device: false, effective: false, setBy: 'device' } })
      expect(fallbackModel(pickerProviders([off, codex()], []))?.model).toBe('gpt-5')
      const signedOut = claude({ auth: { state: 'signed_out' } })
      expect(fallbackModel(pickerProviders([signedOut, codex()], []))?.model).toBe('gpt-5')
      expect(fallbackModel(pickerProviders([snapshot(), codex()], []))?.model).toBe('gpt-5')
    })

    it('uses the first offered provider when none is ready, and nothing when none is offered', () => {
      expect(fallbackModel(pickerProviders([claude({ auth: { state: 'signed_out' } })], []))?.model).toBe('claude-opus-4')
      expect(fallbackModel([])).toBeUndefined()
    })

    it('treats an empty default, or one on a provider switched off or removed, as not offered', () => {
      const providers = pickerProviders([claude(), codex({ enabled: { device: false, effective: false, setBy: 'device' } })], [])
      expect(pickerOffers({ llmProvider: '', model: '' }, providers)).toBe(false)
      expect(pickerOffers({ instanceId: 'codex', llmProvider: 'codex', model: 'gpt-5' }, providers)).toBe(false)
      expect(pickerOffers({ instanceId: 'claude:gone', llmProvider: 'claude:gone', model: 'claude-opus-4' }, providers)).toBe(false)
      expect(pickerOffers({ instanceId: 'claude', llmProvider: 'claude-subscription', model: 'claude-sonnet-4' }, providers)).toBe(true)
    })

    it('picks only when nothing chosen by hand applies', () => {
      const providers = pickerProviders([claude(), codex()], [])
      const none = { llmProvider: '', model: '' }
      const base = { remote: false, threadModel: undefined, profileDefault: none, providers }
      expect(composerAutoModel(base)?.model).toBe('claude-opus-4')
      // A default the picker offers, a thread's own model, another computer, or settings not read yet.
      expect(composerAutoModel({ ...base, profileDefault: { instanceId: 'codex', llmProvider: 'codex', model: 'gpt-5-mini' } })).toBeUndefined()
      expect(composerAutoModel({ ...base, threadModel: { llmProvider: 'codex', model: 'gpt-5' } })).toBeUndefined()
      expect(composerAutoModel({ ...base, remote: true })).toBeUndefined()
      expect(composerAutoModel({ ...base, profileDefault: undefined })).toBeUndefined()
      // A provider set up later gives a profile still without a default a model.
      expect(composerAutoModel({ ...base, providers: [] })).toBeUndefined()
      expect(composerAutoModel({ ...base, providers: pickerProviders([codex()], []) })?.model).toBe('gpt-5')
    })

    it('shows the thread model, else the one it starts on, else the default, and never nothing in place of a model', () => {
      const providers = pickerProviders([claude(), codex()], [])
      const none = { llmProvider: '', model: '' }
      const thread = { instanceId: 'codex', llmProvider: 'codex', model: 'gpt-5', effort: 'high' }
      // A thread with a model shows it, whatever the default and even before the providers load.
      expect(composerSelection({ threadModel: thread, profileDefault: none, providers: [] })).toBe(thread)
      // No thread model: the model the composer starts on by itself, else the default.
      expect(composerSelection({ threadModel: undefined, profileDefault: none, providers })?.model).toBe('claude-opus-4')
      const chosen = { instanceId: 'codex', llmProvider: 'codex', model: 'gpt-5-mini' }
      expect(composerSelection({ threadModel: undefined, profileDefault: chosen, providers })).toBe(chosen)
      // A default the providers have not listed yet still names a model.
      expect(composerSelection({ threadModel: undefined, profileDefault: chosen, providers: [] })).toBe(chosen)
      // Nothing to show yet: undefined, so the composer keeps the model it shows.
      expect(composerSelection({ threadModel: undefined, profileDefault: none, providers: [] })).toBeUndefined()
    })
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

  describe('older models in the picker', () => {
    // Already sorted: a starred model first, then each provider's rows in order.
    const entries = [
      { id: 'starred-old', listing: 'claude', older: true },
      { id: 'a', listing: 'claude', older: false },
      { id: 'a-old', listing: 'claude', older: true },
      { id: 'a-older', listing: 'claude', older: true },
      { id: 'b', listing: 'codex', older: false },
      { id: 'c', listing: 'pi:x', older: false },
      { id: 'c-old', listing: 'pi:x', older: true }
    ]
    const starred = (entry: { id: string }) => entry.id === 'starred-old'
    const rows = (items: ReturnType<typeof foldOlderEntries<(typeof entries)[number]>>) =>
      items.map((item) => (item.kind === 'model' ? item.entry.id : `${item.open ? 'less' : 'more'}:${item.listing}:${item.count}`))

    it('folds each provider\'s older models behind one row after its last row, keeping starred ones', () => {
      expect(rows(foldOlderEntries(entries, { searching: false, open: new Set(), isFavorite: starred }))).toEqual([
        'starred-old', 'a', 'more:claude:2', 'b', 'c', 'more:pi:x:1'
      ])
    })

    it('shows an open provider\'s older models with the row after them', () => {
      expect(rows(foldOlderEntries(entries, { searching: false, open: new Set(['claude']), isFavorite: starred }))).toEqual([
        'starred-old', 'a', 'a-old', 'a-older', 'less:claude:2', 'b', 'c', 'more:pi:x:1'
      ])
    })

    it('opens the selected model\'s section once its row is known, keeping what is open', () => {
      // The menu opened before the provider's models arrived: nothing is known to open yet.
      const empty: ReadonlySet<string> = new Set()
      expect(withOpenListing(empty, undefined)).toBe(empty)
      // The models arrive and the selected one is older: its provider opens, others stay as they were.
      const open = withOpenListing(new Set(['pi:x']), 'claude')
      expect([...open]).toEqual(['pi:x', 'claude'])
      expect(rows(foldOlderEntries(entries, { searching: false, open, isFavorite: starred }))).toEqual([
        'starred-old', 'a', 'a-old', 'a-older', 'less:claude:2', 'b', 'c', 'c-old', 'less:pi:x:1'
      ])
      // Already open: the same set, so nothing renders again.
      expect(withOpenListing(open, 'claude')).toBe(open)
    })

    it('folds nothing while searching, and adds no row when nothing is folded', () => {
      expect(rows(foldOlderEntries(entries, { searching: true, open: new Set(), isFavorite: starred }))).toEqual(entries.map((entry) => entry.id))
      const current = entries.filter((entry) => !entry.older || starred(entry))
      expect(rows(foldOlderEntries(current, { searching: false, open: new Set(), isFavorite: starred }))).toEqual(current.map((entry) => entry.id))
    })
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

describe('loading the snapshots of a scope', () => {
  const deferred = () => {
    let resolve!: (value: ReturnType<typeof snapshot>[]) => void
    const promise = new Promise<ReturnType<typeof snapshot>[]>((done) => (resolve = done))
    return { promise, resolve }
  }
  const setup = () => {
    const replies: Array<ReturnType<typeof deferred>> = []
    const snapshots = vi.fn(() => {
      const reply = deferred()
      replies.push(reply)
      return reply.promise
    })
    vi.stubGlobal('window', { mousse: { providers: { snapshots } } })
    useAppStore.setState({ profileId: 'p1' })
    useProviderSnapshotsStore.setState({ profileId: 'p1', scopes: {} })
    return { replies }
  }
  const load = async (scope: { kind: 'device' }) => (await import('../src/renderer/lib/providerSnapshots')).loadProviderSnapshots(scope)
  const device = () => useProviderSnapshotsStore.getState().scopes.device

  afterEach(() => {
    vi.unstubAllGlobals()
    useAppStore.setState({ profileId: 'default' })
    useProviderSnapshotsStore.setState({ profileId: null, scopes: {} })
  })

  it('drops a reply that arrives after the window was bound to another profile', async () => {
    const { replies } = setup()
    const loading = load({ kind: 'device' })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    useAppStore.setState({ profileId: 'p2' })
    useProviderSnapshotsStore.setState({ profileId: 'p2', scopes: {} })
    replies[0].resolve([snapshot({ instanceId: 'from-p1' })])
    await loading
    expect(device()?.snapshots).toBeUndefined()
  })

  it('keeps the newest of two overlapping loads, and stays loading until it arrives', async () => {
    const { replies } = setup()
    const first = load({ kind: 'device' })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    const second = load({ kind: 'device' })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    replies[1].resolve([snapshot({ instanceId: 'newer' })])
    await second
    replies[0].resolve([snapshot({ instanceId: 'older' })])
    await first
    expect(device()?.snapshots?.map((entry) => entry.instanceId)).toEqual(['newer'])
    expect(device()?.loading).toBe(false)
  })

  it('does not clear loading when an older load finishes before the newest', async () => {
    const { replies } = setup()
    const first = load({ kind: 'device' })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    const second = load({ kind: 'device' })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    replies[0].resolve([snapshot({ instanceId: 'older' })])
    await first
    expect(device()?.loading).toBe(true)
    expect(device()?.snapshots).toBeUndefined()
    replies[1].resolve([snapshot({ instanceId: 'newer' })])
    await second
    expect(device()).toMatchObject({ loading: false, snapshots: [expect.objectContaining({ instanceId: 'newer' })] })
  })
})
