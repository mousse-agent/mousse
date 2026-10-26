/**
 * Custom models (S6): a model the user adds to a pi provider in Settings → Providers runs on the pi
 * loop with its provider's transport and the capabilities the user declared, although the upstream
 * catalog does not list it. A runtime that cannot run a model by id does not offer adding one.
 */
import { describe, expect, it, vi } from 'vitest'
import { customModelDefinition } from '../../src/mms/harness/catalog'
import { LlmClient } from '../../src/mms/orchestrator/LlmClient'
import { userMessage } from '../../src/mms/orchestrator/nativeContext'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { piInstanceId } from '../../src/shared/providerInstances'
import { getDefaultSettings } from '../../src/shared/settings'
import { fixtureModel, providerResponse, streamOf } from '../fixtures/agent-platform/agent-runtime-policy/helpers'

describe('custom models', () => {
  it('a custom model absent from the upstream catalog is dispatched with its provider transport and declared capabilities', async () => {
    const pi = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
    const harness = testHarness({
      adapters: [pi],
      instances: new ProviderInstanceService({ providerAuth: { credentials: { listProviderIds: () => ['fixture-provider'] } } })
    })
    await harness.instances.setModelPrefs(piInstanceId('fixture-provider'), {
      custom: [{ id: 'fixture-next', label: 'Fixture Next', capabilities: { efforts: ['high'], images: true, contextWindow: 400_000 } }]
    })
    const template = { ...fixtureModel('fixture-provider', 'fixture-model'), baseUrl: 'https://fixture.example/v1', headers: { 'x-fixture': '1' } }
    const streamed: Array<Record<string, unknown>> = []
    const models = {
      // The upstream catalog lists only the template model.
      getModel: (provider: string, id: string) => (provider === 'fixture-provider' && id === 'fixture-model' ? template : undefined),
      getModels: () => [template],
      getAuth: vi.fn(async () => ({ apiKey: 'fixture' })),
      streamSimple: (model: Record<string, unknown>) => {
        streamed.push(model)
        return streamOf(providerResponse([{ type: 'text', text: 'hello from next' }], 'stop'))
      }
    }
    const settings = getDefaultSettings()
    settings.provider = { llmProvider: 'fixture-provider', model: 'fixture-next' }
    settings.integrations.skills.enabled = false
    // As `OrchestratorService.customPiModel` resolves it: the gateway's prefs, the provider's transport.
    const customModel = (provider: string, modelId: string) => {
      const custom = harness.catalog.customModel(piInstanceId(provider), modelId)
      return custom ? customModelDefinition(models.getModels()[0] as never, custom) : undefined
    }
    const client = new LlmClient({ get: () => settings } as never, {
      has: () => true, credentials: { listProviderIds: () => ['fixture-provider'] }, models
    } as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { customModel })

    const result = await client.chat([userMessage('hi')], undefined, { retryDelayMs: 0 })
    expect(result.text).toBe('hello from next')
    expect(streamed).toHaveLength(1)
    expect(streamed[0]).toMatchObject({
      id: 'fixture-next', name: 'Fixture Next', provider: 'fixture-provider', api: 'anthropic-messages',
      baseUrl: 'https://fixture.example/v1', headers: { 'x-fixture': '1' },
      input: ['text', 'image'], contextWindow: 400_000, reasoning: true
    })
    expect(models.getAuth).toHaveBeenCalledWith(expect.objectContaining({ id: 'fixture-next', provider: 'fixture-provider' }))

    // Hidden, it is no longer run.
    await harness.instances.setModelPrefs(piInstanceId('fixture-provider'), { hidden: ['fixture-next'] })
    expect(harness.catalog.customModel(piInstanceId('fixture-provider'), 'fixture-next')).toBeUndefined()
    harness.stop()
  })

  it('a runtime that runs only the models it lists refuses custom models and says so in its snapshot', async () => {
    const pi = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
    const antigravity = { ...adapterDriver({ ...pi, driver: 'antigravity', startTurn: pi.startTurn.bind(pi), interrupt: pi.interrupt.bind(pi) }), customModels: false }
    const harness = testHarness({ drivers: [adapterDriver(pi), antigravity], instances: new ProviderInstanceService() })
    await expect(harness.instances.setModelPrefs('antigravity', { custom: [{ id: 'x', capabilities: { efforts: [], images: false } }] }))
      .rejects.toMatchObject({ code: 'unsupported' })
    // Hiding and ordering still work.
    const snapshot = await harness.instances.setModelPrefs('antigravity', { hidden: ['y'] })
    expect(snapshot.models.canAddCustom).toBe(false)
    expect((await harness.instances.setModelPrefs(piInstanceId('openai'), { order: [] })).models.canAddCustom).toBe(true)
    harness.stop()
  })
})
