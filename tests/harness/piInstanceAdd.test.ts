/**
 * PR 5a-1: a model API is an entry like any other. It is added under a fixed id (`pi:<provider>`),
 * takes its key through `setSecret` or the environment's credentials, and once removed it stays
 * removed in that profile, even while another profile keeps the shared key, until it is added again.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import type { HarnessGatewayEvent } from '../../src/mms/harness/gateway'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { ProviderInstanceService, type StoredProviderInstances } from '../../src/mms/providers/ProviderInstanceService'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { PiInstallationCredentials } from './fixtures/piInstallationCredentials'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

const device = { kind: 'device' } as const

/** One profile: its own instance map over the installation's shared credentials. */
function profile(credentials: PiInstallationCredentials) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-pi-add-'))
  let state: StoredProviderInstances = { instances: {}, seedVersion: 1 }
  let writes = 0
  const instances = new ProviderInstanceService({
    store: { read: () => ({ ...state }), write: (next) => { state = { ...next }; writes += 1 } },
    providerAuth: credentials
  })
  const harness = testHarness({
    profileHome: home,
    instances,
    drivers: [piDriver({ client: () => ({ chat: async () => { throw new Error('no model call in this test') } }) as never, credentials: () => credentials as never })]
  })
  const events: HarnessGatewayEvent[] = []
  harness.instances.subscribe((event) => events.push(event))
  cleanups.push(() => harness.stop(), () => rmSync(home, { recursive: true, force: true }))
  return { instances, harness, events, state: () => state, writes: () => writes }
}

const codeOf = async (run: () => Promise<unknown> | unknown): Promise<string | undefined> => {
  try {
    await run()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describe('adding a model API', () => {
  it('adds pi:<provider>; adding it again returns the entry unchanged; an unknown or retired provider is refused', async () => {
    const a = profile(new PiInstallationCredentials())
    const added = await a.harness.instances.addInstance({ driver: 'pi', config: { provider: 'openrouter' } })
    expect(added.existed).toBe(false)
    expect(added.snapshot.instanceId).toBe('pi:openrouter')
    // The id carries the provider: nothing about it is stored in the entry.
    expect(a.state().instances).toEqual({ 'pi:openrouter': { driver: 'pi', enabled: true } })
    const writes = a.writes()
    const again = await a.harness.instances.addInstance({ driver: 'pi', config: { provider: 'openrouter' } })
    expect(again).toMatchObject({ existed: true, snapshot: { instanceId: 'pi:openrouter' } })
    expect(a.writes()).toBe(writes)
    expect(await codeOf(() => a.harness.instances.add({ driver: 'pi', config: { provider: 'not-a-provider' } }))).toBe('unsupported')
    expect(await codeOf(() => a.harness.instances.add({ driver: 'pi', config: { provider: 'openai-codex' } }))).toBe('unsupported')
    expect(await codeOf(() => a.harness.instances.add({ driver: 'pi' }))).toBe('unsupported')
    // The provider is fixed by the id.
    expect(await codeOf(() => a.harness.instances.configure('pi:openrouter', { provider: 'openai' }))).toBe('unsupported')
  })

  it('setSecret saves the key, checks the entry again and keeps the value out of every event', async () => {
    const credentials = new PiInstallationCredentials()
    const a = profile(credentials)
    await a.harness.instances.add({ driver: 'pi', config: { provider: 'openrouter' } })
    const snapshot = await a.harness.instances.setSecret('pi:openrouter', '  fixture-secret-value  ')
    expect(credentials.setApiKey).toHaveBeenCalledWith('openrouter', '  fixture-secret-value  ')
    expect(credentials.keys.get('openrouter')).toBe('fixture-secret-value')
    expect(snapshot.auth.state).toBe('signed_in')
    expect(a.harness.listedLlmProviders(device).map((option) => option.instanceId)).toEqual(['pi:openrouter'])
    expect(JSON.stringify(a.events)).not.toContain('fixture-secret-value')
    expect(await codeOf(() => a.harness.instances.setSecret('pi:not-added', 'x'))).toBe('instance_unknown')
  })

  it('ambient sign-in saves the environment credentials as the provider credential', async () => {
    const credentials = new PiInstallationCredentials()
    const a = profile(credentials)
    await a.harness.instances.add({ driver: 'pi', config: { provider: 'amazon-bedrock' } })
    const done = new Promise<HarnessGatewayEvent>((resolve) => a.harness.instances.subscribe((event) => {
      if (event.type === 'operation' && (event.data.phase === 'completed' || event.data.phase === 'failed')) resolve(event)
    }))
    await a.harness.instances.signIn('pi:amazon-bedrock', 'ambient')
    expect(await done).toMatchObject({ data: { phase: 'completed', instanceId: 'pi:amazon-bedrock' } })
    expect(credentials.verifyAmbientProvider).toHaveBeenCalledWith('amazon-bedrock')
    expect(credentials.has('amazon-bedrock')).toBe(true)
  })
})

describe('a removed model API stays removed in its profile', () => {
  it('add → setSecret → remove → absent while another profile saves the shared key → add again', async () => {
    const credentials = new PiInstallationCredentials()
    const a = profile(credentials)
    const b = profile(credentials)
    await a.harness.instances.add({ driver: 'pi', config: { provider: 'openrouter' } })
    await a.harness.instances.setSecret('pi:openrouter', 'fixture-key-a')
    const resolved = a.harness.resolveStored({ instanceId: 'pi:openrouter', model: 'openrouter-model' }, { purpose: 'turn' })

    await a.harness.instances.remove('pi:openrouter')
    // Remove deletes the saved key, as Remove always did (it is shared by the profiles).
    expect(credentials.logout).toHaveBeenCalledWith('openrouter')
    expect(a.state().removed).toEqual(['pi:openrouter'])

    // Profile B saves the shared key again: B gets the entry, A does not.
    await b.harness.instances.add({ driver: 'pi', config: { provider: 'openrouter' } })
    await b.harness.instances.setSecret('pi:openrouter', 'fixture-key-b')
    expect(Object.keys(b.instances.list())).toEqual(['pi:openrouter'])
    expect(Object.keys(a.instances.list())).toEqual([])
    expect(a.instances.get('pi:openrouter')).toBeUndefined()
    expect((await a.harness.instances.snapshots(device)).map((snapshot) => snapshot.instanceId)).toEqual([])
    expect((await a.harness.llmProviders(device)).map((option) => option.instanceId)).toEqual([])
    expect(a.instances.configuredProviders().map((provider) => provider.instanceId)).toEqual([])
    expect(a.harness.catalog.addOptions().find((option) => option.id === 'openrouter')).toMatchObject({ added: false, hasSavedKey: true })
    // A selection pinned to the removed entry runs nowhere: it resolves as an unknown instance (the
    // run engine's code), and a binding made before the removal is refused before any start.
    expect(await codeOf(() => a.harness.resolveStored({ instanceId: 'pi:openrouter', model: 'openrouter-model' }, { purpose: 'turn' }))).toBe('provider_instance_unknown')
    expect(await codeOf(() => a.harness.bind(resolved, { mode: 'default' }))).toBe('instance_unknown')
    expect(await codeOf(() => a.harness.instances.setEnabled('pi:openrouter', device, true))).toBe('instance_unknown')

    // Add brings it back in one step, with the key B saved.
    const added = await a.harness.instances.addInstance({ driver: 'pi', config: { provider: 'openrouter' } })
    expect(added.existed).toBe(false)
    expect(a.state().removed).toEqual([])
    expect(Object.keys(a.instances.list())).toEqual(['pi:openrouter'])
    expect((await a.harness.llmProviders(device)).map((option) => option.instanceId)).toEqual(['pi:openrouter'])
  })
})

describe('catalog.addOptions', () => {
  it('lists each provider once with its methods, the exact add input, and whether it is added', async () => {
    const credentials = new PiInstallationCredentials()
    credentials.keys.set('opencode-go', 'fixture-saved')
    const a = profile(credentials)
    await a.harness.instances.add({ driver: 'pi', config: { provider: 'openrouter' } })
    const options = a.harness.catalog.addOptions()
    expect(options.map((option) => option.id)).toEqual(['amazon-bedrock', 'openai', 'opencode-go', 'openrouter'])
    expect(options.find((option) => option.id === 'openai')).toEqual({
      id: 'openai',
      label: 'OpenAI',
      description: 'API key',
      methods: ['api_key', 'oauth'],
      add: { driver: 'pi', config: { provider: 'openai' } },
      added: false,
      hasSavedKey: false
    })
    expect(options.find((option) => option.id === 'amazon-bedrock')).toMatchObject({
      methods: ['ambient'],
      ambientInfo: { label: 'Amazon Bedrock', instructions: ['Set AWS_PROFILE or AWS keys.'] }
    })
    expect(options.find((option) => option.id === 'openrouter')).toMatchObject({ added: true })
    // A key another profile saved is offered without retyping it.
    expect(options.find((option) => option.id === 'opencode-go')).toMatchObject({ added: true, hasSavedKey: true })
    // Each option's `add` is exactly what `instances.add` takes.
    for (const option of options) await a.harness.instances.add(option.add)
    expect(Object.keys(a.instances.list()).sort()).toEqual(['pi:amazon-bedrock', 'pi:openai', 'pi:opencode-go', 'pi:openrouter'])
  })
})

describe('review round 1', () => {
  it('a failed tombstone write leaves the provider and its shared key as they were', async () => {
    const credentials = new PiInstallationCredentials()
    credentials.keys.set('openrouter', 'fixture-key')
    let state: StoredProviderInstances = { instances: {}, seedVersion: 1 }
    let failWrites = false
    const instances = new ProviderInstanceService({
      store: {
        read: () => ({ ...state }),
        write: (next) => {
          if (failWrites) throw new Error('fixture: mousse.conf is locked')
          state = { ...next }
        }
      },
      providerAuth: credentials
    })
    const harness = testHarness({ instances, drivers: [piDriver({ client: () => ({ chat: async () => { throw new Error('unused') } }) as never, credentials: () => credentials as never })] })
    cleanups.push(() => harness.stop())
    expect(Object.keys(instances.list())).toEqual(['pi:openrouter'])
    failWrites = true
    await expect(harness.instances.remove('pi:openrouter')).rejects.toThrow(/could not save/)
    expect(credentials.logout).not.toHaveBeenCalled()
    expect(credentials.keys.get('openrouter')).toBe('fixture-key')
    expect(instances.isRemoved('pi:openrouter')).toBe(false)
    // Removing it again once the file can be written finishes the removal.
    failWrites = false
    await harness.instances.remove('pi:openrouter')
    expect(credentials.has('openrouter')).toBe(false)
    expect(state.removed).toEqual(['pi:openrouter'])
  })

  it('a custom provider with no sign-in of its own can be added back after its removal', async () => {
    const credentials = new PiInstallationCredentials()
    credentials.customProviders.push('fixture-custom')
    credentials.keys.set('fixture-custom', 'fixture-key')
    const a = profile(credentials)
    expect(Object.keys(a.instances.list())).toEqual(['pi:fixture-custom'])
    await a.harness.instances.remove('pi:fixture-custom')
    credentials.keys.set('fixture-custom', 'fixture-key-again')
    expect(a.instances.list()).toEqual({})
    expect((await a.harness.instances.addInstance({ driver: 'pi', config: { provider: 'fixture-custom' } })).existed).toBe(false)
    expect(Object.keys(a.instances.list())).toEqual(['pi:fixture-custom'])
  })

  it('settings.getOptions offers no speech model of a provider removed from the profile', async () => {
    const credentials = new PiInstallationCredentials()
    credentials.keys.set('openai', 'fixture-key')
    credentials.getConfiguredLlmProviders = () => [...credentials.keys.keys()].map((id) => ({ id, label: id, models: [{ id: 'gpt-4o-mini-tts', label: 'TTS' }, { id: 'whisper-1', label: 'Whisper' }] }))
    const a = profile(credentials)
    const b = profile(credentials)
    await a.harness.instances.remove('pi:openai')
    // Another profile saves the shared key again.
    await b.harness.instances.setSecret('pi:openai', 'fixture-key-b')
    const optionsOf = async (p: ReturnType<typeof profile>) => {
      const context = { mms: { harness: p.harness, providerAuth: { init: async () => {}, getCatalogLlmProviders: () => [] } }, globalSequence: () => 0 } as unknown as HandlerContext
      return ((await dispatchMethod(context, 'settings.getOptions', {})) as { options: { llmProviders: Array<{ instanceId?: string; models: Array<{ id: string }> }> } }).options.llmProviders
    }
    const speechModels = (listed: Awaited<ReturnType<typeof optionsOf>>) => listed.flatMap((option) => option.models.map((model) => model.id)).filter((id) => /tts|whisper/.test(id))
    expect(speechModels(await optionsOf(a))).toEqual([])
    expect(speechModels(await optionsOf(b))).toEqual(['gpt-4o-mini-tts', 'whisper-1'])
  })
})
