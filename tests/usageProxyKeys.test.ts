import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeSubscriptionProviderService } from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { UsageProxyKeyStore } from '../src/mms/providers/usageProxyKeys'
import type { SecretCodec } from '../src/mms/providers/secretCodec'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { dispatchMethod } from '../src/mms/protocol/handlers'

/**
 * The management key of a local CLI API proxy, entered in Mousse: kept in an encrypted secret file,
 * for the proxy origin it was checked against only, never handed back, and second to a key the user
 * set in Claude's own environment.
 */

/** Reverses the bytes: enough to show the file never holds the key as written. */
const codec: SecretCodec = {
  encryptionRequired: true,
  canEncrypt: () => true,
  encrypt: (plain) => Buffer.from([...Buffer.from(plain, 'utf8')].reverse()),
  decrypt: (stored) => Buffer.from([...stored].reverse()).toString('utf8')
}
const KEY = 'mgmt-secret-1234'
const homes: string[] = []
const services: ClaudeSubscriptionProviderService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
const scratch = () => {
  const home = mkdtempSync(join(tmpdir(), 'usage-proxy-keys-'))
  homes.push(home)
  return home
}

describe('the proxy key store', () => {
  it('keeps the key encrypted on disk, and gives it back only for the origin it was saved for', () => {
    const path = join(scratch(), 'usage-proxy-keys.json')
    const store = new UsageProxyKeyStore(path, codec)
    store.set('http://100.101.102.103:8317', KEY)
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('__mousse_encrypted_v1')
    expect(raw).not.toContain(KEY)
    expect(raw).not.toContain('100.101.102.103')
    expect(store.get('http://100.101.102.103:8317')).toBe(KEY)
    expect(store.get('http://100.101.102.103:8318')).toBeUndefined()
    expect(store.get('http://127.0.0.1:8317')).toBeUndefined()
    store.clear('http://100.101.102.103:8317')
    expect(store.has('http://100.101.102.103:8317')).toBe(false)
  })

  it('a file it cannot decrypt is no key, and is not overwritten by a save', () => {
    const path = join(scratch(), 'usage-proxy-keys.json')
    new UsageProxyKeyStore(path, codec).set('http://127.0.0.1:8317', KEY)
    const locked = new UsageProxyKeyStore(path, { canEncrypt: () => true, encrypt: () => null, decrypt: () => null })
    expect(locked.get('http://127.0.0.1:8317')).toBeUndefined()
    expect(() => locked.set('http://127.0.0.1:8317', 'other')).toThrow()
    expect(new UsageProxyKeyStore(path, codec).get('http://127.0.0.1:8317')).toBe(KEY)
  })
})

describe('Claude usage through a proxy, with a key entered in Mousse', () => {
  const proxyBase = 'http://100.101.102.103:8317'
  function fixture(env: Record<string, string>, checkProxyKey = vi.fn(async () => ({ ok: true as const }))) {
    const home = scratch()
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const keys = new UsageProxyKeyStore(join(home, 'keys.json'), codec)
    const proxyUsage = vi.fn(async () => ({ status: 'unavailable' as const, windows: [], message: 'x' }))
    const query = (() => ({ close: vi.fn() }) as unknown as Query) as (input: { options: Options; prompt: unknown }) => Query
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      query,
      runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
      launchConfig: () => ({ binaryPath: binary }),
      // Claude's settings folder is the fixture's: the user's real settings are not read.
      baseEnv: () => ({ CLAUDE_CONFIG_DIR: join(home, 'claude-config'), ...env }),
      proxyUsage,
      checkProxyKey,
      proxyKeys: keys
    })
    services.push(service)
    return { home, service, keys, proxyUsage, checkProxyKey }
  }

  it('saves a key only after the proxy accepts it, for that origin, and never returns it', async () => {
    const { service, keys, checkProxyKey } = fixture({ ANTHROPIC_BASE_URL: `${proxyBase}/` })
    const result = await service.setUsageProxyKey(` ${KEY} `)
    expect(result).toEqual({ ok: true })
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(checkProxyKey).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: `${proxyBase}/`, key: ` ${KEY} ` }))
    expect(keys.get(proxyBase)).toBe(KEY)
  })

  it('a rejected or unreachable key is reported and not saved; a base URL that is no local proxy gets no key', async () => {
    const rejected = fixture({ ANTHROPIC_BASE_URL: proxyBase }, vi.fn(async () => ({ ok: false as const, reason: 'rejected' as const })))
    expect(await rejected.service.setUsageProxyKey(KEY)).toEqual({ ok: false, reason: 'rejected' })
    expect(rejected.keys.has(proxyBase)).toBe(false)
    const unreachable = fixture({ ANTHROPIC_BASE_URL: proxyBase }, vi.fn(async () => ({ ok: false as const, reason: 'unreachable' as const })))
    expect(await unreachable.service.setUsageProxyKey(KEY)).toEqual({ ok: false, reason: 'unreachable' })
    const remote = fixture({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
    expect(await remote.service.setUsageProxyKey(KEY)).toEqual({ ok: false, reason: 'no_proxy' })
    expect(remote.checkProxyKey).not.toHaveBeenCalled()
  })

  it("uses the saved key for its proxy, but a key in Claude's environment wins", async () => {
    const saved = fixture({ ANTHROPIC_BASE_URL: proxyBase })
    saved.keys.set(proxyBase, KEY)
    await saved.service.getUsage(saved.home)
    expect(saved.proxyUsage).toHaveBeenCalledWith(expect.objectContaining({ managementKey: KEY, keySource: 'saved' }))
    const fromEnv = fixture({ ANTHROPIC_BASE_URL: proxyBase, CLIPROXY_MANAGEMENT_KEY: 'from-env' })
    fromEnv.keys.set(proxyBase, KEY)
    await fromEnv.service.getUsage(fromEnv.home)
    expect(fromEnv.proxyUsage).toHaveBeenCalledWith(expect.objectContaining({ managementKey: 'from-env', keySource: 'environment' }))
  })

  it('a base URL that moved to another host is not sent the key saved for the old one', async () => {
    const moved = fixture({ ANTHROPIC_BASE_URL: 'http://192.168.1.20:8317' })
    moved.keys.set(proxyBase, KEY)
    await moved.service.getUsage(moved.home)
    expect(moved.proxyUsage).toHaveBeenCalledWith(expect.objectContaining({ managementKey: undefined }))
    expect(JSON.stringify(moved.proxyUsage.mock.calls)).not.toContain(KEY)
  })

  it('Remove forgets the key of the current proxy', async () => {
    const { service, keys } = fixture({ ANTHROPIC_BASE_URL: proxyBase })
    keys.set(proxyBase, KEY)
    service.clearUsageProxyKey()
    expect(keys.has(proxyBase)).toBe(false)
  })
})

describe('the usage proxy key methods', () => {
  const call = (clientType: 'gui' | 'bridge', method: string) => {
    const claudeSubscription = { setUsageProxyKey: vi.fn(async () => ({ ok: true })), clearUsageProxyKey: vi.fn() }
    const result = dispatchMethod({ mms: { claudeSubscription } as never, globalSequence: () => 0, connection: { clientType } as never }, method, { providerId: 'claude-subscription', key: 'k' })
    return { result, claudeSubscription }
  }

  it('answer a window on this computer', async () => {
    const set = call('gui', 'providers.setUsageProxyKey')
    await expect(set.result).resolves.toEqual({ ok: true })
    expect(set.claudeSubscription.setUsageProxyKey).toHaveBeenCalledWith('k')
    const clear = call('gui', 'providers.clearUsageProxyKey')
    await expect(clear.result).resolves.toEqual({ ok: true })
  })

  it('refuse another computer or a phone, and never reach the service', async () => {
    for (const method of ['providers.setUsageProxyKey', 'providers.clearUsageProxyKey']) {
      const { result, claudeSubscription } = call('bridge', method)
      await expect(result).rejects.toMatchObject({ code: 'forbidden' })
      expect(claudeSubscription.setUsageProxyKey).not.toHaveBeenCalled()
      expect(claudeSubscription.clearUsageProxyKey).not.toHaveBeenCalled()
    }
  })
})
