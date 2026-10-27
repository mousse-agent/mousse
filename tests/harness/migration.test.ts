/**
 * Profiles written by builds before the gateway: their instance map and toggles are read as they
 * are (no seed bump), built-in instances keep their ids, and the vendor launch settings are copied
 * into the instance config once, leaving the vendor files as they were.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeStatus } from '../../src/shared/harness/status'
import { startProfile, type ProfileStore } from './vendorProfile'

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
  // Wired as MmsProfileServices wires it (`vendorProfile.ts`).
  const store: ProfileStore = { instances, seedVersion: 1, writes: [] }
  const profile = startProfile(home, store)
  return {
    home,
    harness: profile.harness,
    section: () => ({ instances: store.instances, instancesSeedVersion: store.seedVersion }),
    writes: store.writes,
    stop: profile.stop
  }
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
      // No seed bump and no toggle changed; the launch settings were copied into the instance once.
      expect(profile.section()).toMatchObject({
        instances: {
          antigravity: { driver: 'antigravity', enabled: true },
          claude: { driver: 'claude', enabled: true, config: { binaryPath: binary, args: ['--verbose'], env: { FOO: 'bar' }, signedOutInMousse: false, vendorMirror: expect.any(String) } },
          codex: { driver: 'codex', enabled: false, config: { signedOutInMousse: false, vendorMirror: expect.any(String) } }
        },
        instancesSeedVersion: 1
      })
      // The vendor settings file is untouched: an older build still reads its own settings.
      expect(JSON.parse(readFileSync(join(profile.home, 'providers', 'claude-subscription', 'settings.json'), 'utf8'))).toMatchObject({ loginPolicy: 'cli', binaryPath: binary, args: ['--verbose'], env: { FOO: 'bar' } })
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

  it('keeps a record of a driver this build does not know untouched, and an ACP selection names no legacy provider', async () => {
    const grok = { driver: 'grok', enabled: true, config: { home: 'private' } }
    const acp = { driver: 'acp', enabled: true, config: { binaryPath: '/opt/agent/bin/agent' } }
    const profile = legacyProfile({ loginPolicy: 'cli' }, { claude: { driver: 'claude', enabled: true }, 'grok:main': grok, 'acp:agent': acp })
    try {
      await profile.harness.instances.setEnabled('claude', { kind: 'device' }, false)
      expect(profile.section().instances).toMatchObject({ 'grok:main': grok, 'acp:agent': acp })
      // An older reader routes nothing of a new driver to the pi loop: there is no legacy name.
      const binding = { instanceId: 'acp:agent', driver: 'acp' as const, accountGeneration: 0, homeId: 'default', configRevision: 0, model: 'default', policy: { mode: 'default' as const, approvals: 'ask' as const } }
      expect(profile.harness.selectionOf(binding)).toEqual({ instanceId: 'acp:agent', llmProvider: '', model: 'default' })
    } finally {
      profile.stop()
    }
  })

  it('keeps a Cursor record untouched, and a Cursor selection names no legacy provider (never the pi:cursor loop)', async () => {
    const cursor = { driver: 'cursor', enabled: true, config: { displayName: 'Work' } }
    const profile = legacyProfile({ loginPolicy: 'cli' }, { claude: { driver: 'claude', enabled: true }, 'cursor:work': cursor })
    try {
      await profile.harness.instances.setEnabled('claude', { kind: 'device' }, false)
      expect(profile.section().instances).toMatchObject({ 'cursor:work': cursor })
      const binding = { instanceId: 'cursor:work', driver: 'cursor' as const, accountGeneration: 0, homeId: 'default', configRevision: 0, model: 'default', policy: { mode: 'default' as const, approvals: 'ask' as const } }
      expect(profile.harness.selectionOf(binding)).toEqual({ instanceId: 'cursor:work', llmProvider: '', model: 'default' })
    } finally {
      profile.stop()
    }
  })

  it('keeps a Grok record untouched, and a Grok selection names no legacy provider (never the pi:xai loop)', async () => {
    const grok = { driver: 'grok', enabled: true, config: { displayName: 'Work', home: 'private' } }
    const profile = legacyProfile({ loginPolicy: 'cli' }, { claude: { driver: 'claude', enabled: true }, 'grok:work': grok })
    try {
      await profile.harness.instances.setEnabled('claude', { kind: 'device' }, false)
      expect(profile.section().instances).toMatchObject({ 'grok:work': grok })
      const binding = { instanceId: 'grok:work', driver: 'grok' as const, accountGeneration: 0, homeId: 'private:grok:work', configRevision: 0, model: 'default', policy: { mode: 'default' as const, approvals: 'ask' as const } }
      expect(profile.harness.selectionOf(binding)).toEqual({ instanceId: 'grok:work', llmProvider: '', model: 'default' })
    } finally {
      profile.stop()
    }
  })
})
