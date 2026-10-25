/**
 * Profiles written by builds before the gateway: their instance map, toggles and vendor launch
 * settings are read as they are (no seed bump, no rewrite), and built-in instances keep their ids.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { antigravityDriver } from '../../src/mms/harness/drivers/antigravity'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { piLegacyDriver } from '../../src/mms/harness/drivers/piLegacy'
import { createHarnessGateway } from '../../src/mms/harness/gateway'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { AntigravityProviderService } from '../../src/mms/providers/antigravity/AntigravityProviderService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { createCodexProviderService } from '../../src/mms/providers/codex/CodexProviderService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { describeStatus } from '../../src/shared/harness/status'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function fakeClaude(): string {
  const dir = tempDir('mousse-fakeclaude-')
  mkdirSync(join(dir, 'node_modules', 'claude'), { recursive: true })
  const script = join(dir, 'node_modules', 'claude', 'cli.js')
  writeFileSync(join(dir, 'node_modules', 'claude', 'package.json'), JSON.stringify({ name: 'claude' }))
  writeFileSync(script, `#!/usr/bin/env node\nconsole.log('2.1.300 (Claude Code)')\n`)
  if (process.platform === 'win32') {
    const shim = join(dir, 'claude.cmd')
    writeFileSync(shim, `@ECHO off\r\n"%~dp0\\node_modules\\claude\\cli.js" %*\r\n`)
    return shim
  }
  chmodSync(script, 0o755)
  return script
}

/** A master-era profile: `settings.json` per vendor, the instance map in the profile config. */
function legacyProfile(claudeSettings: Record<string, unknown>, instances: Record<string, unknown>) {
  const home = tempDir('mousse-legacy-profile-')
  mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
  writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify(claudeSettings))
  let section = { instances, instancesSeedVersion: 1 }
  const writes: unknown[] = []
  const instanceMap = new ProviderInstanceService({
    store: {
      read: () => ({ instances: section.instances, seedVersion: section.instancesSeedVersion }),
      write: (next) => {
        writes.push(next)
        section = { instances: next.instances, instancesSeedVersion: next.seedVersion }
      }
    }
  })
  const questions = new UserQuestionService()
  const claude = new ClaudeSubscriptionProviderService(home, questions, {
    findBinary: () => undefined,
    runAuth: async () => JSON.stringify({ loggedIn: true, orgId: 'org-1', subscriptionType: 'max' })
  })
  const codex = createCodexProviderService(home, questions, { findBinary: () => undefined })
  const antigravity = new AntigravityProviderService(home, home, questions)
  const harness = createHarnessGateway({
    profileHome: home,
    installationHome: home,
    instanceMap,
    questions,
    shellPath: async () => ({ entries: [], source: 'failed' }),
    drivers: [
      piLegacyDriver({ client: () => ({ chat: async () => { throw new Error('unused') } }) }),
      claudeCodeDriver({ builtIn: () => claude }),
      codexDriver({ builtIn: () => codex }),
      antigravityDriver({ builtIn: () => antigravity })
    ]
  })
  const stop = () => {
    harness.stop()
    claude.stop()
    codex.stop()
    antigravity.stop()
  }
  return { home, harness, section: () => section, writes, stop }
}

describe('legacy profiles', () => {
  it('a stored Claude binaryPath is the override the snapshot reports, and a toggled instance stays off', async () => {
    const binary = fakeClaude()
    const profile = legacyProfile(
      { loginPolicy: 'cli', binaryPath: binary, args: ['--verbose'], env: { FOO: 'bar' } },
      { antigravity: { driver: 'antigravity', enabled: true }, claude: { driver: 'claude', enabled: true }, codex: { driver: 'codex', enabled: false } }
    )
    try {
      const snapshots = await profile.harness.instances.snapshots({ kind: 'device' })
      expect(snapshots.map((entry) => entry.instanceId)).toEqual(['antigravity', 'claude', 'codex'])
      const claude = snapshots.find((entry) => entry.instanceId === 'claude')!
      expect(claude).toMatchObject({
        builtIn: true,
        binary: { path: binary.endsWith('.cmd') ? expect.stringMatching(/cli\.js$/) : binary, source: 'override', version: '2.1.300' },
        config: { home: 'default', binaryPath: binary, args: ['--verbose'], env: { FOO: 'bar' } },
        auth: { state: 'signed_in', account: { id: expect.any(String), label: 'Claude Max' }, canSignOut: false },
        compatibility: { state: 'tested' }
      })
      expect(describeStatus(claude).headline).toBe('Signed in · Claude Max')
      const codex = snapshots.find((entry) => entry.instanceId === 'codex')!
      expect(codex.enabled).toEqual({ device: false, effective: false, setBy: 'device' })
      expect(describeStatus(codex).headline).toBe('Disabled')
      // Nothing was rewritten: no seed bump, the stored entries are byte-equal.
      expect(profile.section()).toEqual({ instances: { antigravity: { driver: 'antigravity', enabled: true }, claude: { driver: 'claude', enabled: true }, codex: { driver: 'codex', enabled: false } }, instancesSeedVersion: 1 })
      expect(profile.writes).toEqual([])
      // The vendor settings file is untouched.
      expect(JSON.parse(readFileSync(join(profile.home, 'providers', 'claude-subscription', 'settings.json'), 'utf8'))).toMatchObject({ binaryPath: binary, args: ['--verbose'] })
    } finally {
      profile.stop()
    }
  })

  it('a stored binaryPath that no longer exists is "Override not found", never a PATH fallback', async () => {
    const missing = join(tempDir('mousse-gone-'), process.platform === 'win32' ? 'claude.exe' : 'claude')
    const profile = legacyProfile({ loginPolicy: 'cli', binaryPath: missing }, { claude: { driver: 'claude', enabled: true } })
    try {
      const claude = (await profile.harness.instances.snapshots({ kind: 'device' })).find((entry) => entry.instanceId === 'claude')!
      expect(claude).toMatchObject({ runs: { state: 'no', failure: 'override_not_found' }, binary: { path: missing, source: 'override' } })
      expect(describeStatus(claude)).toMatchObject({ headline: 'Override not found', nextStep: { action: 'fix_override' } })
    } finally {
      profile.stop()
    }
  })

  it('enabling an instance writes only that entry, keeping its unknown fields', async () => {
    const profile = legacyProfile({ loginPolicy: 'cli' }, { claude: { driver: 'claude', enabled: true }, codex: { driver: 'codex', enabled: false, note: 'kept' } })
    try {
      await profile.harness.instances.setEnabled('codex', { kind: 'device' }, true)
      expect(profile.section().instances).toMatchObject({ claude: { driver: 'claude', enabled: true }, codex: { driver: 'codex', enabled: true, note: 'kept' } })
      expect(profile.section().instancesSeedVersion).toBe(1)
    } finally {
      profile.stop()
    }
  })
})
