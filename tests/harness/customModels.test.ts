/**
 * Custom models (S6): a model the user adds to a pi provider in Settings → Providers reaches Pi's
 * agent in its provider's catalogue, with the provider's transport and the capabilities the user
 * declared, although the upstream catalog does not list it. A runtime that cannot run a model by id
 * does not offer adding one.
 */
import { describe, expect, it } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { piRpcProfileOptions } from '../../src/mms/harness/drivers/pi/profile'
import { piRuntimePaths } from '../../src/mms/harness/pi/launch'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { PiStubAdapter } from '../support/piStub'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { piInstanceId } from '../../src/shared/providerInstances'
import { fixtureModel } from '../fixtures/agent-platform/agent-runtime-policy/helpers'

describe('custom models', () => {
  it('a custom model absent from the upstream catalog reaches Pi with its provider transport and declared capabilities', async () => {
    const pi = new PiStubAdapter()
    const harness = testHarness({
      adapters: [pi],
      instances: new ProviderInstanceService({ providerAuth: { credentials: { listProviderIds: () => ['fixture-provider'] } } })
    })
    await harness.instances.setModelPrefs(piInstanceId('fixture-provider'), {
      custom: [{ id: 'fixture-next', label: 'Fixture Next', capabilities: { efforts: ['high'], images: true, contextWindow: 400_000 } }]
    })
    // The upstream catalog lists only the template model.
    const template = { ...fixtureModel('fixture-provider', 'fixture-model'), baseUrl: 'https://fixture.example/v1', headers: { 'x-fixture': '1' } } as unknown as Model<Api>
    // As the profile wires it: the instance's custom models, the gateway's prefs applied.
    const customModels = (instanceId: string) => {
      const custom = harness.catalog.customModel(instanceId, 'fixture-next')
      return custom ? [custom] : []
    }
    const options = piRpcProfileOptions({
      auth: () => ({ has: () => true, storedApiKey: () => 'fixture', models: { getModels: () => [template] }, credentials: { get: () => undefined } }),
      runtime: piRuntimePaths(process.platform === 'win32' ? 'C:\\mousse' : '/mousse'),
      customModels
    })!

    const models = options.catalog('fixture-provider').provider.models
    expect(models.map((model) => model.id)).toEqual(['fixture-model', 'fixture-next'])
    expect(models[1]).toMatchObject({
      id: 'fixture-next', name: 'Fixture Next', provider: 'fixture-provider', api: 'anthropic-messages',
      baseUrl: 'https://fixture.example/v1', headers: { 'x-fixture': '1' },
      input: ['text', 'image'], contextWindow: 400_000, reasoning: true
    })

    // Hidden, it is no longer run.
    await harness.instances.setModelPrefs(piInstanceId('fixture-provider'), { hidden: ['fixture-next'] })
    expect(harness.catalog.customModel(piInstanceId('fixture-provider'), 'fixture-next')).toBeUndefined()
    expect(options.catalog('fixture-provider').provider.models.map((model) => model.id)).toEqual(['fixture-model'])
    harness.stop()
  })

  it('a runtime that runs only the models it lists refuses custom models and says so in its snapshot', async () => {
    const pi = new PiStubAdapter()
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
