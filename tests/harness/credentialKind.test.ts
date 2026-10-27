/**
 * PR 6 §2: what an instance runs on (`InstanceSnapshot.auth.credential`), from each driver's own
 * sign-in check with nothing more: a stored key, a subscription sign-in or the environment's cloud
 * credentials on Pi; an API key or Claude's own sign-in in a Mousse-owned home on Claude Code; and
 * `unknown` in the user's own Claude home, without another `claude auth status`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeCodeDriver, claudeCredential } from '../../src/mms/harness/drivers/claudeCode'
import { piInstanceRuntime } from '../../src/mms/harness/drivers/pi/engines/legacy'
import type { DriverContext } from '../../src/mms/harness/driver'
import { credentialKind } from '../../src/mms/harness/policy'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import type { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import type { ConfiguredProvider } from '../../src/shared/providerAuth'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const auth = (state: InstanceSnapshot['auth']['state'], credential?: InstanceSnapshot['auth']['credential']): Pick<InstanceSnapshot, 'auth'> =>
  ({ auth: { state, ...(credential ? { credential } : {}) } })

describe('credentialKind', () => {
  it('reads a signed-in instance\'s kind, and unknown otherwise', () => {
    expect(credentialKind(auth('signed_in', 'api_key'))).toBe('api_key')
    expect(credentialKind(auth('signed_in', 'subscription'))).toBe('subscription')
    expect(credentialKind(auth('signed_in', 'ambient'))).toBe('ambient')
    expect(credentialKind(auth('signed_in'))).toBe('unknown')
    expect(credentialKind(auth('signed_out', 'api_key'))).toBe('unknown')
    expect(credentialKind(auth('expired', 'subscription'))).toBe('unknown')
  })

  it('reaches the snapshot from the driver\'s reading', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-credential-'))
    homes.push(home)
    const pi = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
    const driver = adapterDriver(pi, { runtime: { auth: async () => ({ state: 'signed_in', credential: 'subscription' }) } })
    const instances = new ProviderInstanceService({
      store: { read: () => ({ instances: undefined }), write: () => {} },
      providerAuth: { credentials: { listProviderIds: () => ['openrouter'] } }
    })
    const harness = testHarness({ drivers: [driver], instances, profileHome: home })
    const snapshot = await harness.instances.recheck('pi:openrouter')
    expect(snapshot.auth).toMatchObject({ state: 'signed_in', credential: 'subscription' })
    expect(credentialKind(snapshot)).toBe('subscription')
  })
})

describe('Pi instances', () => {
  const runtime = (providerId: string, provider: Partial<ConfiguredProvider> | null) => piInstanceRuntime(`pi:${providerId}`, providerId, () => ({
    has: () => provider !== null,
    getConfiguredProviders: () => (provider ? [{ id: providerId, label: providerId, authType: 'api_key', ...provider }] : [])
  }), new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } })))

  it.each([
    ['a stored key', 'openrouter', { authType: 'api_key' as const }, 'api_key'],
    ['a subscription sign-in', 'openai-codex', { authType: 'oauth' as const }, 'subscription'],
    ['AWS credentials (Bedrock)', 'amazon-bedrock', { authType: 'api_key' as const }, 'ambient'],
    ['Google application default credentials (Vertex)', 'google-vertex', { authType: 'api_key' as const }, 'ambient']
  ])('runs on %s', async (_name, providerId, provider, expected) => {
    expect(await runtime(providerId, provider).auth({ force: false })).toMatchObject({ state: 'signed_in', credential: expected })
  })

  it('has no kind when signed out', async () => {
    expect((await runtime('openrouter', null).auth({ force: false })).credential).toBeUndefined()
  })
})

describe('Claude Code instances', () => {
  const context = (config: DriverContext['config'], home?: string) => ({ config, env: { home } } as unknown as DriverContext)

  it('reads the kind from the instance\'s settings alone', () => {
    expect(claudeCredential(context({ home: 'private', loginMethod: 'api_key' }, '/h'))).toBe('api_key')
    expect(claudeCredential(context({ home: 'private' }, '/h'))).toBe('subscription')
    expect(claudeCredential(context({ home: 'default' }))).toBe('unknown')
  })

  it('checks a default home once, as before, and calls it unknown without another check', async () => {
    const service = {
      status: vi.fn(async () => ({ state: 'connected' })),
      account: vi.fn(() => ({ label: 'Max', subject: 'acct-1' })),
      accountSubject: vi.fn(() => 'acct-1'),
      stop: vi.fn()
    }
    const driver = claudeCodeDriver({ builtIn: () => service as unknown as ClaudeSubscriptionProviderService })
    const runtime = driver.create({
      instanceId: 'claude',
      builtIn: true,
      config: { home: 'default' },
      env: { instanceId: 'claude', driver: 'claude', configRevision: 0, homeId: 'default', env: {}, searchPath: [] }
    } as unknown as DriverContext)
    const reading = await runtime.auth({ force: true })
    expect(reading).toMatchObject({ state: 'signed_in', credential: 'unknown', subject: 'acct-1' })
    expect(service.status).toHaveBeenCalledTimes(1)
    expect(service.accountSubject).not.toHaveBeenCalled()
  })
})
