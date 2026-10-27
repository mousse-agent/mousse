/**
 * The chat title model, each skill's model and agent definitions' models name their provider
 * instance, so a second Claude account runs where it was picked. Records saved before instances
 * (provider name only) still map to the built-in instance.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { SharedAgentModelLookup } from '../../src/mms/platform/SharedAgentModelLookup'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderAdapter } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { parseModelRef } from '../../src/shared/agents/schema'
import { getDefaultSettings, oneShotProviderOptions, resolveModelForMode, type MousseSettings } from '../../src/shared/settings'
import type { OneShotSpec } from '../../src/mms/harness/driver'

const pi = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
const claude: ProviderAdapter = { driver: 'claude', capabilities: pi.capabilities, configured: () => true, startTurn: async () => { throw new Error('unused') }, interrupt: async () => 'not_active' }

/** What the Claude runtime lists: Sonnet takes images and has a long window; Opus states neither. */
const CLAUDE_MODELS = [
  { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'], images: true as const, contextWindow: 200_000 },
  { id: 'opus', label: 'Opus' }
]

/** Built-in Claude and a second account, both enabled; Work hides `opus`. */
async function twoClaudes(work: { enabled: boolean } = { enabled: true }) {
  let stored: unknown = {
    claude: { driver: 'claude', enabled: true },
    'claude:work': { driver: 'claude', enabled: work.enabled, config: { displayName: 'Work' } },
    // An entry the user moved to Work: turned off, its selections run on Work.
    'claude:old': { driver: 'claude', enabled: false, config: { movedTo: 'claude:work' } }
  }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({ drivers: [adapterDriver(pi), adapterDriver(claude, { mcp: true, runtime: { models: () => CLAUDE_MODELS } })], instances })
  await harness.instances.setModelPrefs('claude:work', { hidden: ['opus'] })
  return { harness, instances }
}

const WORK = { instanceId: 'claude:work', llmProvider: 'claude-subscription', model: 'sonnet' }
const LEGACY = { llmProvider: 'claude-subscription', model: 'sonnet' }

/**
 * A profile with Claude Code (built-in and Work) and OpenAI as an API provider; titles run on API
 * providers.
 */
async function titleProfile(options: { work?: boolean } = {}) {
  const piProviders = [{ id: 'openai', label: 'OpenAI', models: [{ id: 'gpt-big', label: 'GPT Big' }, { id: 'gpt-mini', label: 'GPT Mini' }] }]
  let stored: unknown = {
    claude: { driver: 'claude', enabled: true },
    'claude:work': { driver: 'claude', enabled: options.work ?? true, config: { displayName: 'Work' } }
  }
  const instances = new ProviderInstanceService({
    store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } },
    providerAuth: { getConfiguredLlmProviders: () => piProviders, credentials: { listProviderIds: () => ['openai'] } } as never
  })
  const claudeListing = { id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'haiku', label: 'Haiku' }, { id: 'sonnet', label: 'Sonnet' }] }
  // The pi runtime's one request (`DriverRuntime.oneShot`) is a spy.
  const oneShot = vi.fn(async (_spec: OneShotSpec, _signal: AbortSignal) => ({ text: '"A title."' }))
  // The pi runtime lists its provider (as the real one does while credentialed).
  const piListing = adapterDriver(pi, { runtime: { oneShot } })
  const piDriver = { ...piListing, create: (context: Parameters<typeof piListing.create>[0]) => ({ ...piListing.create(context), llmProvider: () => piProviders.find((provider) => `pi:${provider.id}` === context.instanceId) }) }
  const harness = testHarness({ drivers: [piDriver, adapterDriver(claude, { runtime: { llmProvider: () => claudeListing } })], instances })
  return { harness, instances, oneShot }
}

const OPENAI_BIG = { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-big' }

/** The orchestrator's title path over a real gateway (`gateway.oneShot`); the pi request itself is a spy. */
function titleOrchestrator(profile: Awaited<ReturnType<typeof titleProfile>>, title: MousseSettings['title']) {
  const settings = { ...getDefaultSettings(), title }
  const orch = Object.assign(Object.create(OrchestratorService.prototype), {
    harness: profile.harness,
    settingsStore: { get: () => settings }
  }) as {
    generateTitleText: (request: string, first: string | undefined, threadId: string | undefined) => Promise<string>
    generateThreadTitle: (messages: Array<{ role: 'user' | 'assistant'; content: string }>) => Promise<string>
  }
  return { orch, oneShot: profile.oneShot }
}

describe('chat title model', () => {
  it('Automatic (the default setting) names chats from their first line, with no model call', async () => {
    const { orch, oneShot } = titleOrchestrator(await titleProfile(), getDefaultSettings().title)
    // Even with an API provider connected, as on master.
    expect(await orch.generateThreadTitle([{ role: 'user', content: 'hello there' }])).toBe('hello there')
    expect(oneShot).not.toHaveBeenCalled()
  })

  it('a chosen model runs exactly as chosen; a legacy record resolves to its instance', async () => {
    const profile = await titleProfile()
    const chosen = titleOrchestrator(profile, OPENAI_BIG)
    // The answer is cleaned the way titles always were: no quotes, no ending punctuation.
    expect(await chosen.orch.generateTitleText('hello', undefined, undefined)).toBe('A title')
    expect(profile.oneShot).toHaveBeenCalledTimes(1)
    expect(profile.oneShot.mock.calls[0]![0]).toMatchObject({ model: 'gpt-big', system: expect.stringContaining('name chat threads') })
    expect(profile.oneShot.mock.calls[0]![0].prompt).toContain('User request: hello')
    const legacy = titleOrchestrator(profile, { llmProvider: 'openai', model: 'gpt-big' })
    expect(await legacy.orch.generateTitleText('hello', undefined, undefined)).toBe('A title')
    expect(profile.oneShot).toHaveBeenCalledTimes(2)
  })

  it('an agent runtime, a disabled instance or a hidden model is refused with its code, never run elsewhere', async () => {
    const vendor = titleOrchestrator(await titleProfile(), WORK)
    await expect(vendor.orch.generateTitleText('hello', undefined, undefined)).rejects.toMatchObject({ code: 'unsupported' })
    expect(vendor.oneShot).not.toHaveBeenCalled()
    const disabled = titleOrchestrator(await titleProfile({ work: false }), WORK)
    // The gateway's own code for it (oneShot reports harness errors).
    await expect(disabled.orch.generateTitleText('hello', undefined, undefined)).rejects.toMatchObject({ code: 'instance_disabled' })
    expect(disabled.oneShot).not.toHaveBeenCalled()
    const profile = await titleProfile()
    await profile.harness.instances.setModelPrefs('pi:openai', { hidden: ['gpt-big'] })
    const hidden = titleOrchestrator(profile, OPENAI_BIG)
    await expect(hidden.orch.generateTitleText('hello', undefined, undefined)).rejects.toMatchObject({ code: 'model_hidden' })
    expect(hidden.oneShot).not.toHaveBeenCalled()
  })

  it('the title picker offers only instances that run one request, without their Bedrock models', async () => {
    const { harness } = await titleProfile()
    const listings = harness.listedLlmProviders({ kind: 'device' })
    expect(listings.find((option) => option.instanceId === 'pi:openai')?.oneShot).toBe(true)
    expect(listings.find((option) => option.instanceId === 'claude')?.oneShot).toBe(false)
    const bedrock = { id: 'amazon-bedrock', instanceId: 'pi:amazon-bedrock', label: 'Bedrock', oneShot: true, models: [{ id: 'claude-on-aws', label: 'Claude on AWS', oneShot: false as const }] }
    const mixed = { id: 'openrouter', instanceId: 'pi:openrouter', label: 'OpenRouter', oneShot: true, models: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', oneShot: false as const }] }
    const choices = oneShotProviderOptions([...listings, bedrock, mixed])
    expect(choices.map((option) => option.instanceId)).toEqual(['pi:openai', 'pi:openrouter'])
    expect(choices.find((option) => option.instanceId === 'pi:openrouter')?.models.map((model) => model.id)).toEqual(['a'])
  })
})

describe('skill model', () => {
  /** The orchestrator's turn selection for a skill mode: settings, migrate-on-read, then resolve. */
  function skillTurn(context: Awaited<ReturnType<typeof twoClaudes>>, model: MousseSettings['integrations']['skills']['model'][string]) {
    const settings = getDefaultSettings()
    settings.integrations.skills.model.review = model
    const selection = context.instances.migrate(resolveModelForMode(settings, { type: 'skill', skillId: 'review' }, context.harness.configuredProviderIds()))
    return context.harness.resolveStored(selection, { purpose: 'turn' })
  }

  it('runs on the instance the picker chose', async () => {
    expect(skillTurn(await twoClaudes(), WORK).instanceId).toBe('claude:work')
  })

  it('a legacy record resolves to the built-in instance', async () => {
    expect(skillTurn(await twoClaudes(), LEGACY).instanceId).toBe('claude')
  })

  it('a disabled instance or hidden model is refused with its code', async () => {
    const disabled = await twoClaudes({ enabled: false })
    expect(() => skillTurn(disabled, WORK)).toThrow(expect.objectContaining({ code: 'provider_instance_disabled' }))
    const hidden = await twoClaudes()
    expect(() => skillTurn(hidden, { ...WORK, model: 'opus' })).toThrow(expect.objectContaining({ code: 'model_hidden' }))
  })
})

describe('agent definition model', () => {
  it('the stored ref keeps its instance', () => {
    expect(parseModelRef({ providerId: 'claude-subscription', modelId: 'sonnet', instanceId: ' claude:work ' }, '/ref')).toEqual({ providerId: 'claude-subscription', modelId: 'sonnet', instanceId: 'claude:work' })
    expect(parseModelRef({ providerId: 'claude-subscription', modelId: 'sonnet' }, '/ref')).toEqual({ providerId: 'claude-subscription', modelId: 'sonnet' })
    expect(() => parseModelRef({ providerId: 'claude-subscription', modelId: 'sonnet', instanceId: 7 }, '/ref')).toThrow(/instanceId/)
  })

  it('resolves on the instance the picker chose, and a legacy ref on the built-in instance', async () => {
    const { harness } = await twoClaudes()
    const lookup = new SharedAgentModelLookup(() => harness)
    expect(lookup.resolve({ providerId: 'claude-subscription', modelId: 'sonnet', instanceId: 'claude:work' })?.ref.instanceId).toBe('claude:work')
    expect(lookup.resolve({ providerId: 'claude-subscription', modelId: 'sonnet' })?.ref.instanceId).toBe('claude')
  })

  it('a disabled instance or hidden model is unavailable with its code', async () => {
    const off = (await twoClaudes({ enabled: false })).harness
    const disabled = new SharedAgentModelLookup(() => off)
    expect(disabled.resolve({ providerId: 'claude-subscription', modelId: 'sonnet', instanceId: 'claude:work' })).toMatchObject({ available: false, unavailableCode: 'provider_instance_disabled' })
    const on = (await twoClaudes()).harness
    const hidden = new SharedAgentModelLookup(() => on)
    expect(hidden.resolve({ providerId: 'claude-subscription', modelId: 'opus', instanceId: 'claude:work' })).toMatchObject({ available: false, unavailableCode: 'model_hidden' })
    // The built-in instance does not hide it.
    expect(hidden.resolve({ providerId: 'claude-subscription', modelId: 'opus' })).toMatchObject({ available: true })
  })

  it("reads the model's facts from the gateway catalogue of the ref's instance", async () => {
    const { harness } = await twoClaudes()
    const lookup = new SharedAgentModelLookup(() => harness)
    // `tools` comes from the driver serving Mousse's tools; vision and the window from the listing.
    expect(lookup.resolve({ providerId: 'claude-subscription', modelId: 'sonnet', instanceId: 'claude:work' })).toMatchObject({
      available: true, label: 'Sonnet', efforts: ['low', 'high'], capabilities: ['reasoning', 'vision', 'tools', 'long_context']
    })
    expect(lookup.resolve({ providerId: 'claude-subscription', modelId: 'opus' })).toMatchObject({ available: true, efforts: [], capabilities: ['tools'] })
    // A model the instance does not list is not in the catalogue.
    expect(lookup.resolve({ providerId: 'claude-subscription', modelId: 'absent' })).toBeNull()
    // A ref on an entry that moved names, for the run, the model the entry it moved to runs.
    expect(lookup.resolve({ providerId: 'claude-subscription', modelId: 'claude-legacy', instanceId: 'claude:old' })).toMatchObject({
      available: true, ref: { instanceId: 'claude:work', modelId: 'sonnet' }
    })
    // An instance that lists nothing (signed out): unavailable, saying to sign in again.
    const none = await twoClaudes()
    const empty = new SharedAgentModelLookup(() => ({ resolveStored: none.harness.resolveStored.bind(none.harness), catalog: { ...none.harness.catalog, models: () => [] } }))
    expect(empty.resolve({ providerId: 'claude-subscription', modelId: 'sonnet' })).toMatchObject({ available: false, unavailableCode: 'signed_out', unavailableReasons: [expect.stringMatching(/signed out.*Sign in again/)] })
    // No gateway yet: nothing resolves.
    expect(new SharedAgentModelLookup(() => undefined).resolve({ providerId: 'claude-subscription', modelId: 'sonnet' })).toBeNull()
  })
})

describe('stored selections', () => {
  it('title and skill models keep their instance; a choice by provider name alone clears it', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-instance-selections-'))
    try {
      const settings = new SettingsStore(MousseConfigStore.load(home))
      settings.set({ title: WORK, integrations: { skills: { model: { review: WORK } } } })
      const reloaded = new SettingsStore(MousseConfigStore.load(home))
      expect(reloaded.get().title).toEqual(WORK)
      expect(reloaded.get().integrations.skills.model.review).toEqual(WORK)

      reloaded.set({ title: LEGACY, integrations: { skills: { model: { review: LEGACY } } } })
      const cleared = new SettingsStore(MousseConfigStore.load(home)).get()
      expect(cleared.title).toEqual(LEGACY)
      expect(cleared.integrations.skills.model.review).toEqual(LEGACY)

      // Only a string names an instance.
      reloaded.set({ title: { ...LEGACY, instanceId: 7 as unknown as string } })
      expect(reloaded.get().title).toEqual(LEGACY)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})
