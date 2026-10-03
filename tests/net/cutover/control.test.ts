import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import { ProviderAuthService } from '../../../src/mms/providers/ProviderAuthService'
import { LegacyControlCredentials } from '../../../src/mms/profiles/migration/LegacyControlCredentials'
import { LocalMmsClient, MmsProtocolServer } from '../../../src/mms/protocol'
import type { NetStatus } from '../../../src/shared/net/local'
import { FIXTURE_CONTROL_CREDENTIALS } from '../../../src/shared/profiles'
import { writeOriginalControlCredentials } from '../../fixtures/agent-platform/migration-crash/legacyCredentials'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})
function temporary(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-control-cutover-')))
  roots.push(root)
  return root
}

describe('Control backend cutover preparation', () => {
  it('migrates autoconnect/pairings as inert inventory and requires separate fresh Net authority', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = temporary(), home = join(root, 'home')
    writeOriginalControlCredentials(home, { ...FIXTURE_CONTROL_CREDENTIALS })
    const rawPair = (type: 'ed25519' | 'x25519') => {
      const pair = generateKeyPairSync(type)
      return { public: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'), private: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64') }
    }
    const installation = rawPair('ed25519'), transport = rawPair('x25519'), signing = rawPair('ed25519')
    const legacyIdentity = { mmsDeviceId: `mms-${randomUUID()}`, installationId: `inst-${randomUUID()}`, installationPublicKey: installation.public, installationPrivateKey: installation.private, transportPublicKey: transport.public, transportPrivateKey: transport.private, signingPublicKey: signing.public, signingPrivateKey: signing.private }
    const inventory: Record<string, string> = {
      'identity.json': JSON.stringify(legacyIdentity),
      'pairings.json': JSON.stringify([{ pairingId: 'legacy-pairing', mobileDeviceId: 'legacy-phone', mobileStaticPublicKey: 'legacy-mobile-key', grantedScopes: ['execute'], createdAt: '2026-01-01T00:00:00.000Z', status: 'active', receiptSignature: 'legacy-signature' }]),
      'config.json': JSON.stringify({ mode: 'hosted', controlOrigin: 'https://127.0.0.1:9', dashboardUrl: 'https://127.0.0.1:9', autoconnect: true })
    }
    for (const [name, bytes] of Object.entries(inventory)) writeFileSync(join(home, 'control', name), bytes)
    writeFileSync(join(home, 'mousse.conf'), JSON.stringify({ scheduled: { enabled: false }, channels: {} }))
    const originalCiphertext = readFileSync(join(home, 'control', 'credentials.enc'))
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false, headless: true })
    const server = new MmsProtocolServer({ mms: main, ownerToken: 'task-owned-cutover-token' })
    let client: LocalMmsClient | undefined
    try {
      await main.start()
      const profileHome = main.getProfileHomeDir()
      expect('control' in main).toBe(false)
      expect(main.net.status()).toEqual({ enabled: false, keystore: 'missing', routes: [], peers: [] })
      expect(existsSync(join(profileHome, 'net', 'net.db'))).toBe(false)
      for (const [name, bytes] of Object.entries(inventory)) {
        expect(readFileSync(join(profileHome, 'control', name), 'utf8')).toBe(bytes)
        expect(readFileSync(join(home, 'control', name), 'utf8')).toBe(bytes)
      }
      expect(readFileSync(join(home, 'control', 'credentials.enc')).equals(originalCiphertext)).toBe(true)
      expect(readFileSync(join(profileHome, 'control', 'credentials.enc')).equals(originalCiphertext)).toBe(false)
      expect(new LegacyControlCredentials(profileHome).getCredentials()).toEqual(FIXTURE_CONTROL_CREDENTIALS)

      const endpoint = await server.start()
      client = new LocalMmsClient({ homeDir: home, endpoint, ownerToken: 'task-owned-cutover-token', requestedCapabilities: ['profiles-v1', 'net.v1', 'control.v2', 'pairing.v2'] })
      const hello = await client.connect()
      for (const retired of ['control.v2', 'pairing.v2', 'connections']) expect(hello.capabilities).not.toContain(retired)
      await client.request('profiles.bind', { profile: main.profileId })
      for (const retired of ['control.status', 'control.login', 'control.enroll', 'control.disconnect', 'control.logout', 'control.setMode', 'pairing.create', 'pairing.list', 'pairing.approve', 'pairing.reject', 'pairing.revoke']) {
        await expect(client.request(retired, {})).rejects.toThrow()
      }
      expect(existsSync(join(profileHome, 'net', 'net.db'))).toBe(false)
      const fresh = await client.request<NetStatus>('net.init', { name: 'Explicit fresh authority' })
      expect(fresh).toMatchObject({ enabled: true, self: { isAuthority: true } })
      expect(fresh.self!.node).not.toBe(legacyIdentity.mmsDeviceId)
      expect(fresh.self!.user).not.toBe(legacyIdentity.installationId)
      const nodes = await client.request<{ nodes: Array<{ node: string; self: boolean }> }>('bridge.nodes')
      expect(nodes.nodes).toEqual([expect.objectContaining({ node: fresh.self!.node, self: true })])
      expect(main.net.runtime().identity.pinnedRootKey(fresh.self!.user)).not.toBe(Buffer.from(installation.public, 'base64').toString('base64url'))
      for (const [name, bytes] of Object.entries(inventory)) expect(readFileSync(join(profileHome, 'control', name), 'utf8')).toBe(bytes)
    } finally { await client?.close(); await server.stop(); await main.stop() }
  }, 30_000)

  it('emitted retired CLI commands fail before daemon creation or credential changes', () => {
    const bundle = resolve('out/cli/index.js')
    expect(existsSync(bundle), 'Build the actual CLI before this emitted qualification').toBe(true)
    const root = temporary(), home = join(root, 'home')
    mkdirSync(home)
    const original = writeOriginalControlCredentials(home, { ...FIXTURE_CONTROL_CREDENTIALS })
    const before = readdirSync(home)
    for (const argv of [['control', 'connect'], ['connections', 'pair'], ['login', '--token', 'legacy-alias'], ['logout']]) {
      const result = spawnSync(process.execPath, [bundle, '--home', home, ...argv], { cwd: root, env: { ...process.env, MOUSSE_HOME: home }, encoding: 'utf8', timeout: 15_000 })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('retired Control Protocol 2.0')
      expect(readdirSync(home)).toEqual(before)
      expect(readFileSync(join(home, 'control', 'credentials.enc')).equals(original)).toBe(true)
      expect(readdirSync(join(home, 'control'))).toEqual(['credentials.enc'])
    }
  }, 65_000)
})
