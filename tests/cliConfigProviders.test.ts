/**
 * PR 5a-2: `mousse config providers` adds a model API through the gateway and saves its key, and the
 * global `--api-key` only replaces the key of an entry that is added. The CLI talks to a daemon whose
 * provider methods are the real handlers over a test gateway; no key leaves the fixture.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addProvider, setProviderKey, type ProviderRequester } from '../src/cli/providerSetup'
import { piDriver } from '../src/mms/harness/drivers/pi'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import { ProviderInstanceService, type StoredProviderInstances } from '../src/mms/providers/ProviderInstanceService'
import { testHarness } from '../src/mms/run/testkit/harness'
import { PiInstallationCredentials } from './harness/fixtures/piInstallationCredentials'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

/** A daemon serving the provider methods for one profile; `calls` lists what the CLI asked. */
function daemon() {
  const home = mkdtempSync(join(tmpdir(), 'mousse-cli-providers-'))
  const credentials = new PiInstallationCredentials()
  let state: StoredProviderInstances = { instances: {}, seedVersion: 1 }
  const instances = new ProviderInstanceService({ store: { read: () => ({ ...state }), write: (next) => { state = { ...next } } }, providerAuth: credentials })
  const harness = testHarness({
    profileHome: home,
    instances,
    drivers: [piDriver({ client: () => ({ chat: async () => { throw new Error('no model call in this test') } }) as never, credentials: () => credentials as never })]
  })
  cleanups.push(() => harness.stop(), () => rmSync(home, { recursive: true, force: true }))
  const context = { mms: { harness, providerInstances: instances, providerAuth: credentials }, globalSequence: () => 0 } as unknown as HandlerContext
  const calls: string[] = []
  const client: ProviderRequester = {
    request: async <T>(method: string, params?: unknown) => {
      calls.push(method)
      return (await dispatchMethod(context, method, params ?? {})) as T
    }
  }
  return { client, calls, credentials, harness, instances }
}

describe('mousse config providers', () => {
  it('adds the provider and saves the key; a second run changes nothing and reads it configured', async () => {
    const d = daemon()
    expect(await addProvider(d.client, 'openrouter', 'fixture-key')).toEqual({ instanceId: 'pi:openrouter', configured: true })
    expect(d.calls).toEqual(['providers.catalog.addOptions', 'providers.instances.add', 'providers.instances.setSecret', 'providers.snapshots'])
    expect(d.credentials.keys.get('openrouter')).toBe('fixture-key')
    expect(Object.keys(d.instances.list())).toEqual(['pi:openrouter'])
    const saves = d.credentials.setApiKey.mock.calls.length
    // Without a key: the entry is returned as it is and nothing is saved.
    expect(await addProvider(d.client, 'openrouter', undefined)).toEqual({ instanceId: 'pi:openrouter', configured: true })
    expect(d.credentials.setApiKey.mock.calls.length).toBe(saves)
    expect(Object.keys(d.instances.list())).toEqual(['pi:openrouter'])
  })

  it('reads an added provider without a key as not configured, and refuses one Mousse does not offer', async () => {
    const d = daemon()
    expect(await addProvider(d.client, 'openai', undefined)).toEqual({ instanceId: 'pi:openai', configured: false })
    await expect(addProvider(d.client, 'not-a-provider', 'fixture-key')).rejects.toThrow('Mousse cannot add the model provider "not-a-provider".')
    expect(d.credentials.setApiKey).not.toHaveBeenCalled()
  })
})

describe('mousse config providers for cloud credentials', () => {
  it('checks them before adding, and adds nothing when they are missing', async () => {
    const d = daemon()
    d.credentials.verifyAmbientProvider.mockResolvedValueOnce({ success: false, error: 'Amazon Bedrock credentials were not detected in the environment.' } as never)
    await expect(addProvider(d.client, 'amazon-bedrock', undefined)).rejects.toThrow('Amazon Bedrock credentials were not detected in the environment.')
    expect(d.instances.list()).toEqual({})
    expect(await addProvider(d.client, 'amazon-bedrock', undefined)).toEqual({ instanceId: 'pi:amazon-bedrock', configured: true })
  })
})

describe('the global --api-key', () => {
  it('replaces the key of an added provider', async () => {
    const d = daemon()
    await addProvider(d.client, 'openrouter', 'fixture-old-key')
    await setProviderKey(d.client, 'openrouter', 'fixture-new-key')
    expect(d.credentials.keys.get('openrouter')).toBe('fixture-new-key')
  })

  it('fails for a removed provider and adds nothing back', async () => {
    const d = daemon()
    await addProvider(d.client, 'openrouter', 'fixture-key')
    await d.harness.instances.remove('pi:openrouter')
    d.calls.length = 0
    await expect(setProviderKey(d.client, 'openrouter', 'fixture-new-key')).rejects.toThrow(
      'OpenRouter is not added. Run `mousse config providers --provider openrouter --api-key …`.'
    )
    expect(d.calls).not.toContain('providers.instances.add')
    expect(d.calls).not.toContain('providers.instances.setSecret')
    expect(d.instances.isRemoved('pi:openrouter')).toBe(true)
    expect(d.credentials.keys.has('openrouter')).toBe(false)
  })
})

describe('providers Mousse runs through an agent', () => {
  it('are not added as model APIs, and the global --api-key points to Settings', async () => {
    const d = daemon()
    const listed = d.credentials.getLoginOptions
    d.credentials.getLoginOptions = () => [...listed(), { id: 'anthropic', label: 'Anthropic', authType: 'api_key', configured: false }]
    await expect(addProvider(d.client, 'anthropic', 'fixture-key')).rejects.toThrow('Mousse runs Anthropic through its agent (claude). Add it, or replace its key, in Settings → Providers.')
    await expect(setProviderKey(d.client, 'anthropic', 'fixture-key')).rejects.toThrow('Mousse runs Anthropic through its agent (claude).')
    expect(d.calls).not.toContain('providers.instances.add')
    expect(d.credentials.setApiKey).not.toHaveBeenCalled()
  })

  it('an id that is no model provider says so', async () => {
    const d = daemon()
    await expect(setProviderKey(d.client, 'claude-subscription', 'fixture-key')).rejects.toThrow('Mousse has no model provider "claude-subscription" that takes an API key.')
  })
})
