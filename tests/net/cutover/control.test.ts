import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import { ProviderAuthService } from '../../../src/mms/providers/ProviderAuthService'
import { LegacyControlCredentials } from '../../../src/mms/profiles/migration/LegacyControlCredentials'
import { FIXTURE_CONTROL_CREDENTIALS } from '../../../src/shared/profiles'
import { writeOriginalControlCredentials } from '../../fixtures/agent-platform/migration-crash/legacyCredentials'
import { buildTestCli } from '../helpers/build'

const roots: string[] = []
const builds: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of builds.splice(0)) cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})
function temporary(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-control-legacy-')))
  roots.push(root)
  return root
}

describe('retired Control backend files', () => {
  it('migrates the legacy control inventory as inert files and re-encrypts its credentials', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = temporary(),
      home = join(root, 'home')
    writeOriginalControlCredentials(home, { ...FIXTURE_CONTROL_CREDENTIALS })
    const inventory: Record<string, string> = {
      'identity.json': JSON.stringify({ mmsDeviceId: 'mms-legacy', installationId: 'inst-legacy' }),
      'pairings.json': JSON.stringify([
        {
          pairingId: 'legacy-pairing',
          mobileDeviceId: 'legacy-phone',
          mobileStaticPublicKey: 'legacy-mobile-key',
          grantedScopes: ['execute'],
          createdAt: '2026-01-01T00:00:00.000Z',
          status: 'active',
          receiptSignature: 'legacy-signature'
        }
      ]),
      'config.json': JSON.stringify({
        mode: 'hosted',
        controlOrigin: 'https://127.0.0.1:9',
        dashboardUrl: 'https://127.0.0.1:9',
        autoconnect: true
      })
    }
    for (const [name, bytes] of Object.entries(inventory)) writeFileSync(join(home, 'control', name), bytes)
    writeFileSync(join(home, 'mousse.conf'), JSON.stringify({ scheduled: { enabled: false }, channels: {} }))
    const originalCiphertext = readFileSync(join(home, 'control', 'credentials.enc'))
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false, headless: true })
    try {
      await main.start()
      const profileHome = main.getProfileHomeDir()
      for (const [name, bytes] of Object.entries(inventory)) {
        expect(readFileSync(join(profileHome, 'control', name), 'utf8')).toBe(bytes)
        expect(readFileSync(join(home, 'control', name), 'utf8')).toBe(bytes)
      }
      expect(readFileSync(join(home, 'control', 'credentials.enc')).equals(originalCiphertext)).toBe(true)
      expect(readFileSync(join(profileHome, 'control', 'credentials.enc')).equals(originalCiphertext)).toBe(false)
      expect(new LegacyControlCredentials(profileHome).getCredentials()).toEqual(FIXTURE_CONTROL_CREDENTIALS)
    } finally {
      await main.stop()
    }
  }, 30_000)

  it('retired CLI commands fail before daemon creation or credential changes', async () => {
    const built = await buildTestCli()
    builds.push(built.cleanup)
    const bundle = built.entry
    const root = temporary(),
      home = join(root, 'home')
    mkdirSync(home)
    const original = writeOriginalControlCredentials(home, { ...FIXTURE_CONTROL_CREDENTIALS })
    const before = readdirSync(home)
    for (const argv of [
      ['control', 'connect'],
      ['connections', 'pair'],
      ['login', '--token', 'legacy-alias'],
      ['logout']
    ]) {
      const result = spawnSync(process.execPath, [bundle, '--home', home, ...argv], {
        cwd: root,
        env: { ...process.env, MOUSSE_HOME: home },
        encoding: 'utf8',
        timeout: 15_000
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('retired Control Protocol 2.0')
      expect(readdirSync(home)).toEqual(before)
      expect(readFileSync(join(home, 'control', 'credentials.enc')).equals(original)).toBe(true)
      expect(readdirSync(join(home, 'control'))).toEqual(['credentials.enc'])
    }
  }, 65_000)
})
