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
import type { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderAdapter } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { parseModelRef } from '../../src/shared/agents/schema'
import { getDefaultSettings, resolveModelForMode, type MousseSettings } from '../../src/shared/settings'

const pi = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
const claude: ProviderAdapter = { driver: 'claude', capabilities: pi.capabilities, configured: () => true, startTurn: async () => { throw new Error('unused') }, interrupt: async () => 'not_active' }

/** Built-in Claude and a second account, both enabled; Work hides `opus`. */
async function twoClaudes(work: { enabled: boolean } = { enabled: true }) {
  let stored: unknown = {
    claude: { driver: 'claude', enabled: true },
    'claude:work': { driver: 'claude', enabled: work.enabled, config: { displayName: 'Work' } }
  }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({ drivers: [adapterDriver(pi), adapterDriver(claude)], instances })
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
  const harness = testHarness({ drivers: [adapterDriver(pi), adapterDriver(claude, { runtime: { llmProvider: () => claudeListing } })], instances })
  return { harness, instances }
}

const OPENAI_BIG = { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-big' }

/** The orchestrator's title path over a real gateway; the pi call itself is a spy. */
function titleOrchestrator(harness: unknown, title: MousseSettings['title']) {
  const settings = { ...getDefaultSettings(), title }
  const generateTitle = vi.fn(async () => 'A title')
  const orch = Object.assign(Object.create(OrchestratorService.prototype), {
    harness,
    settingsStore: { get: () => settings },
    llm: { generateTitle }
  }) as {
    generateTitleText: (request: string, first: string | undefined, threadId: string | undefined) => Promise<string>
    generateThreadTitle: (messages: Array<{ role: 'user' | 'assistant'; content: string }>) => Promise<string>
  }
  return { orch, generateTitle }
}

describe('chat title model', () => {
  it('Automatic (the default setting) names chats from their first line, with no model call', async () => {
    const { harness } = await titleProfile()
    const { orch, generateTitle } = titleOrchestrator(harness, getDefaultSettings().title)
    // Even with an API provider connected, as on master.
    expect(await orch.generateThreadTitle([{ role: 'user', content: 'hello there' }])).toBe('hello there')
    expect(generateTitle).not.toHaveBeenCalled()
  })

  it('a chosen model runs exactly as chosen; a legacy record resolves to its instance', async () => {
    const { harness } = await titleProfile()
    const chosen = titleOrchestrator(harness, OPENAI_BIG)
    await chosen.orch.generateTitleText('hello', undefined, undefined)
    expect(chosen.generateTitle).toHaveBeenCalledWith('hello', undefined, undefined, OPENAI_BIG)
    const legacy = titleOrchestrator(harness, { llmProvider: 'openai', model: 'gpt-big' })
    await legacy.orch.generateTitleText('hello', undefined, undefined)
    expect(legacy.generateTitle).toHaveBeenCalledWith('hello', undefined, undefined, OPENAI_BIG)
  })

  it('an agent runtime, a disabled instance or a hidden model is refused with its code, never run elsewhere', async () => {
    const vendor = titleOrchestrator((await titleProfile()).harness, WORK)
    await expect(vendor.orch.generateTitleText('hello', undefined, undefined)).rejects.toMatchObject({ code: 'unsupported' })
    expect(vendor.generateTitle).not.toHaveBeenCalled()
    const disabled = titleOrchestrator((await titleProfile({ work: false })).harness, WORK)
    await expect(disabled.orch.generateTitleText('hello', undefined, undefined)).rejects.toMatchObject({ code: 'provider_instance_disabled' })
    expect(disabled.generateTitle).not.toHaveBeenCalled()
    const profile = await titleProfile()
    await profile.harness.instances.setModelPrefs('pi:openai', { hidden: ['gpt-big'] })
    const hidden = titleOrchestrator(profile.harness, OPENAI_BIG)
    await expect(hidden.orch.generateTitleText('hello', undefined, undefined)).rejects.toMatchObject({ code: 'model_hidden' })
    expect(hidden.generateTitle).not.toHaveBeenCalled()
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
  /** A pi catalog that also lists Claude models, so the lookup reaches its catalog step. */
  const providerAuth = {
    models: {
      getModels: () => [
        { id: 'sonnet', name: 'Sonnet', reasoning: true, input: ['text'], api: 'anthropic-messages', contextWindow: 200_000 },
        { id: 'opus', name: 'Opus', reasoning: true, input: ['text'], api: 'anthropic-messages', contextWindow: 200_000 }
      ]
    }
  } as unknown as ProviderAuthService

  it('the stored ref keeps its instance', () => {
    expect(parseModelRef({ providerId: 'claude-subscription', modelId: 'sonnet', instanceId: ' claude:work ' }, '/ref')).toEqual({ providerId: 'claude-subscription', modelId: 'sonnet', instanceId: 'claude:work' })
    expect(parseModelRef({ providerId: 'claude-subscription', modelId: 'sonnet' }, '/ref')).toEqual({ providerId: 'claude-subscription', modelId: 'sonnet' })
    expect(() => parseModelRef({ providerId: 'claude-subscription', modelId: 'sonnet', instanceId: 7 }, '/ref')).toThrow(/instanceId/)
  })

  it('resolves on the instance the picker chose, and a legacy ref on the built-in instance', async () => {
    const { harness } = await twoClaudes()
    const lookup = new SharedAgentModelLookup(providerAuth, () => harness)
    expect(lookup.resolve({ providerId: 'claude-subscription', modelId: 'sonnet', instanceId: 'claude:work' })?.ref.instanceId).toBe('claude:work')
    expect(lookup.resolve({ providerId: 'claude-subscription', modelId: 'sonnet' })?.ref.instanceId).toBe('claude')
  })

  it('a disabled instance or hidden model is unavailable with its code', async () => {
    const off = (await twoClaudes({ enabled: false })).harness
    const disabled = new SharedAgentModelLookup(providerAuth, () => off)
    expect(disabled.resolve({ providerId: 'claude-subscription', modelId: 'sonnet', instanceId: 'claude:work' })).toMatchObject({ available: false, unavailableCode: 'provider_instance_disabled' })
    const on = (await twoClaudes()).harness
    const hidden = new SharedAgentModelLookup(providerAuth, () => on)
    expect(hidden.resolve({ providerId: 'claude-subscription', modelId: 'opus', instanceId: 'claude:work' })).toMatchObject({ available: false, unavailableCode: 'model_hidden' })
    // The built-in instance does not hide it.
    expect(hidden.resolve({ providerId: 'claude-subscription', modelId: 'opus' })).toMatchObject({ available: true })
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
