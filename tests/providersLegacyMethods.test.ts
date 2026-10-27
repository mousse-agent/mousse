/**
 * PR 5a-1 only: the old provider methods the shipped renderer and CLI call keep working against
 * the new gateway, and the old Add dialog's key and sign-ins count as an explicit Add (they bring
 * a removed model API back). Deleted in 5a-2 with the methods.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { piDriver } from '../src/mms/harness/drivers/pi'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import { LoginSession } from '../src/mms/providers/LoginSession'
import { ProviderInstanceService, type StoredProviderInstances } from '../src/mms/providers/ProviderInstanceService'
import { PiLoopAdapter } from '../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderAdapter } from '../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../src/mms/run/testkit/harness'
import { PiInstallationCredentials } from './harness/fixtures/piInstallationCredentials'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

const pi = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
const claude: ProviderAdapter = { driver: 'claude', capabilities: pi.capabilities, configured: () => true, startTurn: async () => { throw new Error('unused') }, interrupt: async () => 'not_active' }

/** A profile as the old methods see it: shared pi credentials, a Claude Code entry, and a gateway. */
function profile(options: { removed?: string[]; storeError?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-legacy-methods-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const credentials = new PiInstallationCredentials()
  const sessions = new Map<string, LoginSession>()
  const runApiKeyLogin = vi.fn(async (session: LoginSession, providerId: string) => {
    credentials.keys.set(providerId, 'fixture-guided-key')
    return { success: true, sessionId: session.sessionId }
  })
  const runOAuthLogin = vi.fn(async (session: LoginSession, providerId: string) => {
    credentials.keys.set(providerId, 'fixture-oauth')
    return { success: true, sessionId: session.sessionId }
  })
  const providerAuth = Object.assign(credentials, {
    init: async () => {},
    getCatalogLlmProviders: () => [],
    runApiKeyLogin,
    runOAuthLogin,
    createSession: () => {
      const session = new LoginSession(`session-${sessions.size + 1}`)
      sessions.set(session.sessionId, session)
      return session
    },
    getSession: (id: string) => sessions.get(id),
    endSession: (id: string) => void sessions.delete(id)
  })
  let state: StoredProviderInstances = { instances: { claude: { driver: 'claude', enabled: true } }, seedVersion: 1, removed: options.removed ?? [] }
  let failRead = options.storeError ?? false
  const instances = new ProviderInstanceService({
    store: {
      read: () => {
        if (failRead) throw new Error('fixture: the profile config cannot be read')
        return { ...state }
      },
      write: (next) => { state = { ...next } }
    },
    providerAuth: credentials
  })
  const claudeRefresh = vi.fn(async () => {})
  const claudeSignOut = vi.fn(async () => {})
  const harness = testHarness({
    profileHome: home,
    instances,
    drivers: [
      piDriver({ client: () => ({ chat: async () => { throw new Error('unused') } }) as never, credentials: () => credentials as never }),
      adapterDriver(claude, {
        runtime: {
          configuredProvider: () => ({ id: 'claude-subscription', label: 'Claude Code', authType: 'oauth' }),
          llmProvider: () => ({ id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'sonnet', label: 'Sonnet' }] }),
          refreshModels: claudeRefresh,
          signOut: claudeSignOut
        }
      })
    ]
  })
  cleanups.push(() => harness.stop())
  harness.instanceMap.setListings((instanceId) => {
    if (instanceId !== 'claude') return undefined
    return { configuredProvider: () => ({ id: 'claude-subscription', label: 'Claude Code', authType: 'oauth' }), llmProvider: () => undefined }
  })
  const vendor = (id: string) => ({ status: async () => ({ state: 'connected', checkedAt: '2026-10-27T00:00:00.000Z' }), configured: () => true, loginOption: () => ({ id, label: id, authType: 'oauth', configured: true }) })
  const emitEvent = vi.fn()
  const context = {
    mms: {
      harness,
      providerInstances: instances,
      providerAuth,
      claudeSubscription: vendor('claude-subscription'),
      codex: vendor('codex'),
      antigravity: vendor('antigravity'),
      worktrees: { getRepoRoot: () => home }
    },
    globalSequence: () => 0,
    emitEvent
  } as unknown as HandlerContext
  const call = (method: string, params: Record<string, unknown> = {}) => dispatchMethod(context, method, params) as Promise<Record<string, unknown>>
  return { call, credentials, harness, instances, emitEvent, state: () => state, claudeRefresh, claudeSignOut, runApiKeyLogin, runOAuthLogin, readable: () => { failRead = false } }
}

const idsOf = (result: Record<string, unknown>, key: string) => (result[key] as Array<{ instanceId?: string }>).map((entry) => entry.instanceId)

describe('the old provider methods against the 5a-1 gateway', () => {
  it('listConfigured: pi and vendor rows as before, removed providers left out, the store error kept', async () => {
    const p = profile({ removed: ['pi:openai'] })
    p.credentials.keys.set('openrouter', 'k1')
    p.credentials.keys.set('openai', 'k2')
    expect(idsOf(await p.call('providers.listConfigured'), 'providers')).toEqual(['pi:openrouter', 'claude'])
    const broken = profile({ storeError: true })
    expect(await broken.call('providers.listConfigured')).toMatchObject({ instancesError: 'fixture: the profile config cannot be read' })
  })

  it('getLoginOptions and getAmbientInfo answer as before', async () => {
    const p = profile()
    const options = (await p.call('providers.getLoginOptions')).options as Array<{ id: string; authType: string }>
    expect(options.filter((option) => option.id === 'openai').map((option) => option.authType)).toEqual(['api_key', 'oauth'])
    expect(await p.call('providers.getAmbientInfo', { providerId: 'amazon-bedrock' })).toEqual({ info: { id: 'amazon-bedrock', label: 'Amazon Bedrock', instructions: ['Set AWS_PROFILE or AWS keys.'] } })
  })

  it('setApiKey writes the key, brings a removed provider back, checks it again and announces the change', async () => {
    const p = profile({ removed: ['pi:openrouter'] })
    const result = await p.call('providers.setApiKey', { providerId: 'openrouter', apiKey: 'fixture-key' })
    expect(p.credentials.keys.get('openrouter')).toBe('fixture-key')
    expect(p.state().removed).toEqual([])
    expect(idsOf(result, 'providers')).toEqual(['pi:openrouter', 'claude'])
    expect(p.emitEvent).toHaveBeenCalledWith('providers.changed', { providers: result.providers })
    const snapshot = (await p.harness.instances.snapshots({ kind: 'device' })).find((entry) => entry.instanceId === 'pi:openrouter')
    expect(snapshot?.auth.state).toBe('signed_in')
  })

  it('verifyAmbient saves the environment credentials and brings a removed provider back', async () => {
    const p = profile({ removed: ['pi:amazon-bedrock'] })
    const result = await p.call('providers.verifyAmbient', { providerId: 'amazon-bedrock' })
    expect(result.result).toMatchObject({ success: true })
    expect(p.state().removed).toEqual([])
    expect(idsOf(result, 'providers')).toContain('pi:amazon-bedrock')
  })

  it('logout deletes a pi key and disconnects a vendor entry in Mousse only', async () => {
    const p = profile()
    p.credentials.keys.set('openrouter', 'k1')
    await p.call('providers.logout', { providerId: 'openrouter' })
    expect(p.credentials.keys.has('openrouter')).toBe(false)
    await p.call('providers.logout', { providerId: 'claude-subscription' })
    expect(p.claudeSignOut).toHaveBeenCalledOnce()
    expect(p.state().instances).toMatchObject({ claude: { config: { signedOutInMousse: true } } })
  })

  it('loginApiKey and loginOAuth run the sign-in through a session and bring a removed provider back', async () => {
    const p = profile({ removed: ['pi:openai', 'pi:openrouter'] })
    expect((await p.call('providers.loginApiKey', { providerId: 'openrouter' })).result).toMatchObject({ success: true })
    expect(p.runApiKeyLogin).toHaveBeenCalledWith(expect.any(LoginSession), 'openrouter')
    expect((await p.call('providers.loginOAuth', { providerId: 'openai' })).result).toMatchObject({ success: true })
    expect(p.runOAuthLogin).toHaveBeenCalledWith(expect.any(LoginSession), 'openai')
    expect(p.state().removed).toEqual([])
    expect(Object.keys(p.instances.list()).sort()).toEqual(['claude', 'pi:openai', 'pi:openrouter'])
  })

  it('a failed sign-in brings nothing back', async () => {
    const p = profile({ removed: ['pi:openrouter'] })
    p.runApiKeyLogin.mockImplementationOnce(async (session) => ({ success: false, sessionId: session.sessionId, error: 'Cancelled' }) as never)
    await p.call('providers.loginApiKey', { providerId: 'openrouter' })
    expect(p.state().removed).toEqual(['pi:openrouter'])
  })

  it('refreshModels: a vendor entry through its runtime, a pi provider through the shared catalog; answers with gateway.llmProviders', async () => {
    const p = profile()
    p.credentials.keys.set('openrouter', 'k1')
    const vendor = await p.call('providers.refreshModels', { providerId: 'claude-subscription' })
    expect(p.claudeRefresh).toHaveBeenCalledOnce()
    expect(p.credentials.refreshDynamicModels).not.toHaveBeenCalled()
    expect(idsOf(vendor, 'options')).toEqual(['pi:openrouter', 'claude'])
    await p.call('providers.refreshModels', { providerId: 'openrouter' })
    expect(p.credentials.refreshDynamicModels).toHaveBeenCalledOnce()
    expect(idsOf(vendor, 'options')).toEqual(idsOf({ options: await p.harness.llmProviders({ kind: 'device' }) }, 'options'))
  })
})
