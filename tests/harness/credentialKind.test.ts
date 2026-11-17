/**
 * PR 6 §2: what an instance runs on (`InstanceSnapshot.auth.credential`), from each driver's own
 * sign-in check with nothing more: on Pi the stored credential (a key, a subscription sign-in, or
 * the ambient marker of Bedrock's or Vertex's cloud credentials); on Claude Code what the same
 * `claude auth status` reports (its sign-in method and API provider), in any home.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { piInstanceRuntime } from '../../src/mms/harness/drivers/pi/instance'
import type { DriverContext } from '../../src/mms/harness/driver'
import { PI_AMBIENT_MARKER } from '../../src/mms/harness/pi/envKeys'
import { credentialKind } from '../../src/mms/harness/policy'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService, claudeCredentialKind } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { PiStubAdapter } from '../support/piStub'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import type { ConfiguredProvider } from '../../src/shared/providerAuth'

const repoRoot = resolve(__dirname, '..', '..')
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
    const pi = new PiStubAdapter()
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
  const runtime = (providerId: string, provider: Partial<ConfiguredProvider> | null, stored?: string | (() => string | undefined)) =>
    piInstanceRuntime(`pi:${providerId}`, providerId, () => ({
      has: () => provider !== null,
      getConfiguredProviders: () => (provider ? [{ id: providerId, label: providerId, authType: 'api_key', ...provider }] : []),
      storedApiKey: typeof stored === 'function' ? stored : () => stored
    }), new PiStubAdapter())

  it.each([
    ['a stored key', 'openrouter', { authType: 'api_key' as const }, 'sk-or-1', 'api_key'],
    ['a subscription sign-in', 'openai-codex', { authType: 'oauth' as const }, undefined, 'subscription'],
    ['AWS credentials (Bedrock)', 'amazon-bedrock', { authType: 'api_key' as const }, PI_AMBIENT_MARKER, 'ambient'],
    ['Google application default credentials (Vertex)', 'google-vertex', { authType: 'api_key' as const }, PI_AMBIENT_MARKER, 'ambient'],
    // A real key saved for Vertex (by hand, or found in GOOGLE_CLOUD_API_KEY) is what Pi signs in with.
    ['a Vertex API key', 'google-vertex', { authType: 'api_key' as const }, 'AIza-vertex-key', 'api_key'],
    ['a key saved for Bedrock', 'amazon-bedrock', { authType: 'api_key' as const }, 'bedrock-bearer', 'api_key'],
    ['a cloud credential with no stored key to read', 'google-vertex', { authType: 'api_key' as const }, undefined, 'unknown']
  ])('runs on %s', async (_name, providerId, provider, stored, expected) => {
    expect(await runtime(providerId, provider, stored).auth({ force: false })).toMatchObject({ state: 'signed_in', credential: expected })
  })

  it('calls a cloud credential that cannot be read unknown', async () => {
    const reading = await runtime('google-vertex', { authType: 'api_key' }, () => { throw new Error('locked') }).auth({ force: false })
    expect(reading.credential).toBe('unknown')
  })

  it('has no kind when signed out', async () => {
    expect((await runtime('openrouter', null).auth({ force: false })).credential).toBeUndefined()
  })

  it('takes the ambient marker from the pinned pi-ai, which Mousse stores for cloud credentials', () => {
    const source = readFileSync(join(repoRoot, 'node_modules/@earendil-works/pi-ai/dist/env-api-keys.js'), 'utf8')
    expect(source).toContain(`return "${PI_AMBIENT_MARKER}"`)
  })
})

describe('Claude Code instances', () => {
  it.each([
    [{ authMethod: 'claude.ai' }, 'subscription'],
    [{ authMethod: 'oauth_token' }, 'subscription'],
    [{ authMethod: 'api_key' }, 'api_key'],
    [{ authMethod: 'console' }, 'api_key'],
    [{ authMethod: 'claude.ai', apiProvider: 'firstParty' }, 'subscription'],
    [{ authMethod: 'api_key', apiProvider: 'bedrock' }, 'ambient'],
    [{ apiProvider: 'vertex' }, 'ambient'],
    [{ apiProvider: 'anthropicAws' }, 'ambient'],
    [{ apiProvider: 'foundry' }, 'unknown'],
    [{ apiProvider: 'gateway', authMethod: 'claude.ai' }, 'unknown'],
    [{ authMethod: 'something_new' }, 'unknown'],
    [{}, 'unknown']
  ] as const)('maps claude auth status %j to %s', (status, expected) => {
    expect(claudeCredentialKind(status)).toBe(expected)
  })

  it.each([
    ['a private home signed in with an API key', true, { authMethod: 'api_key' }, 'api_key'],
    ['a private home signed in with claude.ai', true, { authMethod: 'claude.ai', subscriptionType: 'max' }, 'subscription'],
    ['a private home on Bedrock', true, { authMethod: 'api_key', apiProvider: 'bedrock' }, 'ambient'],
    ['the user\'s own home signed in with claude.ai', false, { authMethod: 'claude.ai', subscriptionType: 'pro' }, 'subscription'],
    ['the user\'s own home with a Console sign-in', false, { authMethod: 'console' }, 'api_key']
  ] as const)('%s: read from the one auth status check, never another', async (_name, privateHome, status, expected) => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-claude-credential-'))
    homes.push(home)
    const runAuth = vi.fn(async () => JSON.stringify({ loggedIn: true, ...status }))
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      findBinary: () => process.execPath,
      runAuth,
      ...(privateHome ? { stateDir: join(home, 'state'), baseEnv: () => ({ CLAUDE_CONFIG_DIR: join(home, 'claude-home') }) } : {})
    })
    try {
      const driver = claudeCodeDriver(privateHome ? { createService: () => service } : { builtIn: () => service })
      const runtime = driver.create({
        instanceId: privateHome ? 'claude:bot' : 'claude',
        builtIn: !privateHome,
        profileHome: home,
        stateDir: join(home, 'state'),
        config: { home: privateHome ? 'private' : 'default' },
        env: { instanceId: 'claude', driver: 'claude', configRevision: 0, homeId: 'default', env: {}, searchPath: [], ...(privateHome ? { home: join(home, 'claude-home') } : {}) }
      } as unknown as DriverContext)
      expect(await runtime.auth({ force: true })).toMatchObject({ state: 'signed_in', credential: expected })
      expect(runAuth).toHaveBeenCalledTimes(1)
    } finally {
      service.stop()
    }
  })
})
