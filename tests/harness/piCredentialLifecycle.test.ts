/**
 * PR 2c review round 1: what Pi's agent holds of a sign-in ends with it, and a native fork reaches
 * its first turn.
 * - An OAuth handle is valid for one credential epoch: after another sign-in (or a refresh that
 *   returns another account), a refresh with the old handle is refused, also when the change lands
 *   while the refresh is in flight.
 * - Sign-in, sign-out, a credential change seen by the gateway and the engine's stop remove Pi's
 *   `auth.json`.
 * - Credentials whose tokens name no account get a stable identity (a minted credential id that a
 *   refresh keeps; Bedrock's bearer token or default chain), so turns resume their Pi session.
 * - A native fork's branch survives the gateway's admission of the fork's first turn; one that
 *   cannot be opened fails that turn (`binding_stale`) instead of running it without history.
 * - A session no thread maps to any more is deleted, and the handover notice shows once per thread.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriverContext } from '../../src/mms/harness/driver'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { createRpcRuntime } from '../../src/mms/harness/drivers/pi/engines/rpc'
import { piRpcProfileOptions, type PiProfileAuth } from '../../src/mms/harness/drivers/pi/profile'
import { instanceStateDir } from '../../src/mms/harness/instances'
import { PiRpcEngine } from '../../src/mms/harness/pi/engine'
import { piCredentialHandler, piOAuthBroker, piOAuthHandle, writePiAuth, type PiOAuthGrant, type PiOAuthSource } from '../../src/mms/harness/pi/oauthBroker'
import { piRuntimePaths } from '../../src/mms/harness/pi/launch'
import { FileCredentialStore } from '../../src/mms/providers/FileCredentialStore'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import type { TurnInput } from '../../src/mms/run/adapters/ProviderAdapter'
import { testHarness } from '../../src/mms/run/testkit/harness'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-pi-credentials-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const unused = () => { throw new Error('must not spawn or reach a provider') }
const jwt = (sub: string) => `x.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.y`
const grant = (access: string, subject?: string): PiOAuthGrant => ({ access, expires: Date.now() + 3_600_000, fields: {}, ...(subject ? { subject } : {}) })

function runtimeIn(dir: string, source: PiOAuthSource, signIn = vi.fn(async () => ({ success: true }))) {
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const logout = vi.fn(async () => {})
  const context = { instanceId: 'pi:openrouter', builtIn: true, config: { home: 'default', engine: 'rpc' }, env: { instanceId: 'pi:openrouter', homeId: 'x', home, env: {} }, profileHome: dir, installationHome: dir, stateDir: dir, questions: {}, findBinary: () => undefined, changed: () => {} } as unknown as DriverContext
  const runtime = createRpcRuntime(context, 'openrouter', 'OpenRouter', () => ({ logout, runOAuthLogin: signIn, runApiKeyLogin: signIn }) as never, { runtime: unused, catalog: unused, oauth: source })
  cleanups.push(() => runtime.stop())
  const authFile = join(home, 'auth.json')
  const plant = () => writePiAuth(home, 'openrouter', { type: 'oauth', access: 'fake-access-A', refresh: 'fake-handle', expires: Date.now() + 3_600_000 })
  return { runtime, authFile, plant, logout, signIn, engine: () => (runtime.adapter as unknown as { oauthHandle: string }) }
}

describe('OAuth handles end with their credential', () => {
  it('refuses a refresh with the old handle after another sign-in, also when it lands mid-refresh', async () => {
    let epoch = 0
    let current = piOAuthHandle('pi:openrouter')
    const handleOf = (mine: number) => () => (mine === epoch ? current : undefined)
    let vault = grant('fake-A', 'sub:a')
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const source: PiOAuthSource = { credential: async () => vault, refresh: async () => { await held; return vault } }
    const handle = current
    const handler = piCredentialHandler({ provider: 'openrouter', handle: handleOf(0), source })
    // In flight under account A; account B signs in before it returns.
    const pending = handler({ providerId: 'openrouter', handle })
    epoch += 1
    current = piOAuthHandle('pi:openrouter')
    vault = grant('fake-B', 'sub:b')
    release()
    await expect(pending).rejects.toThrow('refused')
    // Any later refresh with A's handle is refused before Mousse refreshes anything.
    await expect(handler({ providerId: 'openrouter', handle })).rejects.toThrow('refused')
  })

  it('refuses a refreshed credential of another account', async () => {
    const handle = piOAuthHandle('pi:openrouter')
    const source = piOAuthBroker({ credentials: { get: () => ({ type: 'oauth', access: jwt('b'), refresh: 'r', expires: Date.now() + 3_600_000 }) }, models: { getAuth: async () => undefined } } as never)
    const handler = piCredentialHandler({ provider: 'openrouter', handle: () => handle, source, accept: (next) => next.subject === 'sub:a' })
    await expect(handler({ providerId: 'openrouter', handle })).rejects.toThrow('refused')
  })

  it('a sign-in on the RPC runtime replaces the handle and removes auth.json', async () => {
    const dir = scratch()
    const s = runtimeIn(dir, { credential: async () => undefined, refresh: async () => undefined })
    const before = s.engine().oauthHandle
    s.plant()
    await s.runtime.signIn!({} as never, dir, 'oauth')
    expect(s.signIn).toHaveBeenCalledTimes(1)
    expect(existsSync(s.authFile)).toBe(false)
    expect(s.engine().oauthHandle).not.toBe(before)
  })
})

describe('Pi’s auth.json ends with the sign-in', () => {
  it('is removed by the RPC runtime’s sign-out, a credential change and stop', async () => {
    const dir = scratch()
    const s = runtimeIn(dir, { credential: async () => undefined, refresh: async () => undefined })
    s.plant()
    await s.runtime.signOut!()
    expect(s.logout).toHaveBeenCalledWith('openrouter')
    expect(existsSync(s.authFile)).toBe(false)
    s.plant()
    await s.runtime.credentialsChanged!()
    expect(existsSync(s.authFile)).toBe(false)
    s.plant()
    await s.runtime.stop()
    expect(existsSync(s.authFile)).toBe(false)
  })

  it('is removed by the gateway’s sign-out of the instance', async () => {
    const dir = scratch()
    const logout = vi.fn(async () => {})
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: { 'pi:openrouter': { driver: 'pi', enabled: true, config: { engine: 'rpc' } } }, seedVersion: 1 }), write: () => {} } })
    const source: PiOAuthSource = { credential: async () => undefined, refresh: async () => undefined }
    const harness = testHarness({ profileHome: dir, instances, drivers: [piDriver({ credentials: () => ({ has: () => true, getConfiguredProviders: () => [], getConfiguredLlmProviders: () => [], logout }) as never, rpc: { runtime: unused, catalog: unused, oauth: source } })] })
    cleanups.push(() => harness.stop())
    harness.resolveStored({ instanceId: 'pi:openrouter', llmProvider: 'openrouter', model: 'm' }, { purpose: 'turn' })
    const home = join(instanceStateDir(dir, 'pi:openrouter'), 'home')
    mkdirSync(home, { recursive: true })
    writePiAuth(home, 'openrouter', { type: 'oauth', access: 'fake-access', refresh: 'h', expires: Date.now() + 3_600_000 })
    await harness.instances.signOut('pi:openrouter')
    expect(logout).toHaveBeenCalledWith('openrouter')
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
  })
})

describe('stable identities for tokens that name no account', () => {
  const runtime = piRuntimePaths(process.platform === 'win32' ? 'C:\\mousse' : '/mousse')

  it('mints a credential id once for an OpenRouter sign-in, and a refresh keeps it', async () => {
    const store = new FileCredentialStore(join(scratch(), 'auth.json'))
    await store.modify('openrouter', async () => ({ type: 'oauth', access: 'sk-or-fake', refresh: '', expires: Number.MAX_SAFE_INTEGER }))
    const auth = { has: () => true, storedApiKey: () => undefined, models: { getModels: () => [] }, credentials: store } as unknown as PiProfileAuth
    const options = piRpcProfileOptions({ auth: () => auth, runtime, env: {} })!
    const first = await options.identity!('openrouter')
    expect(first).toMatch(/^oauth:/)
    expect(await options.identity!('openrouter')).toBe(first)
    // pi-ai's refresh replaces the whole credential; the store keeps Mousse's id.
    await store.modify('openrouter', async () => ({ type: 'oauth', access: 'sk-or-fake-2', refresh: '', expires: Number.MAX_SAFE_INTEGER }))
    expect(await options.identity!('openrouter')).toBe(first)
    // A new sign-in brings its own id.
    await store.modify('openrouter', async () => ({ type: 'oauth', access: 'sk-or-other', refresh: '', expires: Number.MAX_SAFE_INTEGER, credentialId: 'another-sign-in' }) as never)
    expect(await options.identity!('openrouter')).not.toBe(first)
  })

  it('names Bedrock with only a bearer token, and with the default credential chain', async () => {
    const auth = { has: () => false, storedApiKey: () => undefined, models: { getModels: () => [] }, credentials: { get: () => undefined } } as unknown as PiProfileAuth
    const bearer = await piRpcProfileOptions({ auth: () => auth, runtime, env: { AWS_BEARER_TOKEN_BEDROCK: 'fake-bearer' } })!.identity!('amazon-bedrock')
    const chain = await piRpcProfileOptions({ auth: () => auth, runtime, env: {} })!.identity!('amazon-bedrock')
    expect(bearer).toMatch(/^ambient:/)
    expect(chain).toMatch(/^ambient:/)
    expect(bearer).not.toBe(chain)
    expect(bearer).not.toContain('fake-bearer')
  })
})

describe('native forks through the gateway', () => {
  function gateway(dir: string) {
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: { 'pi:openrouter': { driver: 'pi', enabled: true, config: { engine: 'rpc' } } }, seedVersion: 1 }), write: () => {} } })
    const harness = testHarness({ profileHome: dir, instances, drivers: [piDriver({ credentials: () => ({ has: () => true, getConfiguredProviders: () => [], getConfiguredLlmProviders: () => [] }) as never, rpc: { runtime: unused, catalog: unused, identity: () => 'oauth:fake-A' } })] })
    cleanups.push(() => harness.stop())
    return harness
  }
  const turn = (threadId: string) => ({ runId: 'r', attemptId: 'a', threadId, instanceId: 'pi:openrouter', llmProvider: 'openrouter', model: 'm', mode: 'agent', prompt: 'Continue', messages: [], signal: new AbortController().signal })

  it('keeps the branch a fork bound to its thread through the first turn’s admission', async () => {
    const dir = scratch()
    const harness = gateway(dir)
    const binding = await harness.bind(harness.resolveStored({ instanceId: 'pi:openrouter', llmProvider: 'openrouter', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
    const record = (harness as unknown as { records: Map<string, { runtime: { adapter: { startTurn: unknown } } }> }).records.get('pi:openrouter')!
    const file = join(instanceStateDir(dir, 'pi:openrouter'), 'threads.json')
    mkdirSync(join(file, '..'), { recursive: true })
    // As `forkSession` leaves it, and a plain mapping of another thread for contrast.
    writeFileSync(file, JSON.stringify({ 'fork-target': { sessionId: 'fake-branch', historyFingerprint: 'h', pendingFork: true }, plain: { sessionId: 'fake-plain', historyFingerprint: 'h' } }))
    const seen: Array<Record<string, unknown> | undefined> = []
    record.runtime.adapter.startTurn = vi.fn(async (input: TurnInput) => {
      seen.push(JSON.parse(readFileSync(file, 'utf8'))[input.threadId])
      return { text: '', aborted: false, providerRef: { provider: 'openrouter' } }
    })
    const spec = (threadId: string) => ({ binding, input: turn(threadId), sink: { providerRef: () => {} }, control: {}, host: {} }) as never
    await harness.startTurn(spec('fork-target')).result
    await harness.startTurn(spec('plain')).result
    expect(seen).toEqual([{ sessionId: 'fake-branch', historyFingerprint: 'h', pendingFork: true }, undefined])
  })

  it('fails a fork’s first turn whose branch cannot be opened, instead of running it without history', async () => {
    const dir = scratch()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(dir, 'threads.json'), JSON.stringify({ fork: { sessionId: 'missing-branch', historyFingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', pendingFork: true } }))
    const engine = new PiRpcEngine({ instanceId: 'pi:openrouter', provider: 'openrouter', label: 'OpenRouter', capabilities: {} as never, env: () => ({ instanceId: 'pi:openrouter', homeId: 'x', home, env: {} }) as never, stateDir: dir, runtime: unused, catalog: unused })
    cleanups.push(() => engine.stop())
    const input = { ...turn('fork'), cwd: join(dir, 'work'), nativeHistory: '' } as unknown as TurnInput
    await expect(engine.startTurn(input, { providerRef: () => {} } as never, {} as never, {} as never)).rejects.toMatchObject({ code: 'binding_stale' })
    expect(JSON.parse(readFileSync(join(dir, 'threads.json'), 'utf8')).fork).toBeUndefined()
  })
})

describe('sessions and notices of handed-over threads', () => {
  it('deletes a session file no thread maps to any more, and tells a thread once', async () => {
    const dir = scratch()
    const notices: string[] = []
    const engine = new PiRpcEngine({ instanceId: 'pi:openrouter', provider: 'openrouter', label: 'OpenRouter', capabilities: {} as never, env: () => ({ instanceId: 'pi:openrouter', homeId: 'x', env: {} }) as never, stateDir: dir, runtime: unused, catalog: unused, notice: (threadId) => notices.push(threadId) })
    cleanups.push(() => engine.stop())
    mkdirSync(join(dir, 'sessions'))
    const session = (id: string) => join(dir, 'sessions', `2026-10-27T00-00-00-000Z_${id}.jsonl`)
    for (const id of ['only-a', 'shared']) writeFileSync(session(id), '{}\n')
    writeFileSync(join(dir, 'threads.json'), JSON.stringify({ a: { sessionId: 'only-a' }, b: { sessionId: 'shared' }, c: { sessionId: 'shared' } }))
    engine.forgetConversation('a')
    engine.forgetConversation('b')
    expect(existsSync(session('only-a'))).toBe(false)
    // Still mapped by thread c.
    expect(existsSync(session('shared'))).toBe(true)
    const notify = (engine as unknown as { historyNotice(threadId: string): void }).historyNotice.bind(engine)
    notify('a')
    notify('a')
    notify('b')
    expect(notices).toEqual(['a', 'b'])
  })
})
