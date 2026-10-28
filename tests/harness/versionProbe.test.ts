/**
 * The version-only probe (plan PR 5 §5): it takes no runtime, so it cannot check a sign-in, start
 * the agent or list models; it runs the version flag and nothing else. The upkeep script runs it.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessDriver } from '../../src/mms/harness/driver'
import { cliNames, instanceEnv } from '../../src/mms/harness/env'
import { observeHarnessSpawns } from '../../src/mms/harness/spawn'
import { probeVersion } from '../../src/mms/harness/status'
import { checkAgentVersions, formatAgentVersions } from '../../src/mms/harness/versionCheck'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake CLI named `fakecli` whose every run executes `body` (JavaScript). */
function fakeCli(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-fakecli-'))
  dirs.push(dir)
  const script = join(dir, 'node_modules', 'fakecli', 'cli.js')
  mkdirSync(join(dir, 'node_modules', 'fakecli'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'fakecli', 'package.json'), JSON.stringify({ name: 'fakecli', bin: 'cli.js' }))
  writeFileSync(script, `#!/usr/bin/env node\n${body}\n`)
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'fakecli.cmd'), `@ECHO off\r\n"%~dp0\\node_modules\\fakecli\\cli.js" %*\r\n`)
  } else {
    writeFileSync(join(dir, 'fakecli'), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)})\n`)
    chmodSync(join(dir, 'fakecli'), 0o755)
  }
  return dir
}

const forbidden = (what: string) => () => {
  throw new Error(`the version probe reached ${what}`)
}

/** A driver whose runtime would throw on every call the version probe must never make. */
const driver: HarnessDriver = {
  kind: 'claude',
  label: 'Fake CLI',
  binaryNames: cliNames('fakecli'),
  testedVersions: { min: '2.0.0', max: '2.1.999' },
  knownBroken: [{ range: '2.1.5', reason: 'Turns stop early' }],
  multiInstance: false,
  privateHome: false,
  canInstall: false,
  decodeConfig: () => ({ home: 'default' }),
  caps: forbidden('caps') as never,
  create: () => ({
    adapter: {} as never,
    configured: forbidden('configured'),
    models: forbidden('models'),
    auth: forbidden('auth'),
    handshake: forbidden('handshake'),
    refreshModels: forbidden('refreshModels'),
    runtimeFacts: forbidden('runtimeFacts'),
    stop: () => {}
  }),
  updateCommand: () => undefined
}
const throwingDriver: HarnessDriver = { ...driver, create: forbidden('driver.create') as never }

function recordSpawns() {
  const spawned: Array<{ command: string; args: string[]; purpose: string }> = []
  const stop = observeHarnessSpawns((entry) => spawned.push({ command: entry.command, args: entry.args, purpose: entry.purpose }))
  return { spawned, stop }
}

describe('probeVersion', () => {
  it('runs only the version flag, and reads the version against the table', async () => {
    const dir = fakeCli(`if (process.argv[2] !== '--version') process.exit(9); console.log('fakecli 2.1.5')`)
    const env = instanceEnv({ instanceId: 'fake', driver: 'claude', configRevision: 0, searchPath: [dir] })
    const { spawned, stop } = recordSpawns()
    try {
      const found = await probeVersion({ driver: throwingDriver, env })
      expect(found).toMatchObject({ install: 'installed', runs: { state: 'yes' }, binary: { version: '2.1.5', source: 'path' }, compatibility: { state: 'known_broken', knownProblem: { reason: 'Turns stop early' } } })
      expect(found.fingerprint).toMatchObject({ path: found.binary?.path })
    } finally {
      stop()
    }
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({ purpose: 'version' })
    expect(spawned[0]!.args.at(-1)).toBe('--version')
  })

  it('without a version flag the version is unknown and nothing is started', async () => {
    const dir = fakeCli(`process.exit(9)`)
    const env = instanceEnv({ instanceId: 'fake', driver: 'claude', configRevision: 0, searchPath: [dir] })
    const { spawned, stop } = recordSpawns()
    try {
      const found = await probeVersion({ driver: { ...throwingDriver, versionArgs: () => null }, env })
      expect(found).toMatchObject({ runs: { state: 'yes' }, compatibility: { state: 'unknown' }, note: 'No version flag' })
      expect(found.binary?.version).toBeUndefined()
    } finally {
      stop()
    }
    expect(spawned).toEqual([])
  })

  it('a managed install is read from its receipt, with no spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-managed-'))
    dirs.push(dir)
    const binary = join(dir, 'agent')
    writeFileSync(binary, 'x')
    chmodSync(binary, 0o755)
    const env = instanceEnv({ instanceId: 'fake', driver: 'claude', configRevision: 0, searchPath: [] })
    const { spawned, stop } = recordSpawns()
    try {
      const found = await probeVersion({ driver: throwingDriver, env, managed: { path: binary, version: '2.1.0', receiptHash: 'c'.repeat(64) }, pinned: true })
      expect(found).toMatchObject({ binary: { source: 'managed', version: '2.1.0' }, compatibility: { state: 'tested' }, receiptHash: 'c'.repeat(64) })
    } finally {
      stop()
    }
    expect(spawned).toEqual([])
  })
})

describe('the upkeep script', () => {
  it('lists the agents on PATH against the table on the same fakes, running only their version flags', async () => {
    const dir = fakeCli(`if (process.argv[2] !== '--version') process.exit(9); console.log('2.1.5')`)
    const { spawned, stop } = recordSpawns()
    let reports
    try {
      reports = await checkAgentVersions({
        drivers: [
          { ...throwingDriver, key: 'claude' },
          { ...throwingDriver, label: 'Missing CLI', binaryNames: cliNames('no-such-cli-for-mousse'), key: 'codex' },
          // A runtime Mousse ships has nothing to find on PATH.
          { ...throwingDriver, label: 'Bundled', binaryNames: [], key: 'pi' }
        ],
        searchPath: [dir]
      })
    } finally {
      stop()
    }
    expect(reports).toEqual([
      expect.objectContaining({ label: 'Fake CLI', key: 'claude', source: 'path', version: '2.1.5', state: 'known_broken', note: 'Turns stop early' }),
      expect.objectContaining({ label: 'Missing CLI', key: 'codex', state: 'not_found' })
    ])
    expect(spawned.map((entry) => entry.args.at(-1))).toEqual(['--version'])
    const text = formatAgentVersions(reports)
    expect(text).toContain('Fake CLI [claude] 2.1.5, on PATH: known_broken (tested: 2.0.0 – 2.1.999) - Turns stop early')
    expect(text).toContain('Missing CLI [codex]: not found')
  })

  it('lists the agents Mousse installed from their receipts, without starting them', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-installation-'))
    dirs.push(home)
    const root = join(home, 'agents', 'grok', '1.0.70', 'node')
    mkdirSync(join(root, 'dist', 'bin'), { recursive: true })
    writeFileSync(join(root, 'dist', 'bin', 'grok'), 'x')
    chmodSync(join(root, 'dist', 'bin', 'grok'), 0o755)
    writeFileSync(join(root, 'receipt.json'), JSON.stringify({
      agentId: 'grok', version: '1.0.70', platform: 'node', distribution: 'npx', artifactUrl: '@xai-official/grok@1.0.70',
      files: { 'bin/grok': 'h' }, bytes: 1, launch: { cmd: 'bin/grok', args: [], env: {} }, checksum: 'registry', installedAt: '2026-10-28T00:00:00Z'
    }))
    const { spawned, stop } = recordSpawns()
    let reports
    try {
      reports = await checkAgentVersions({ drivers: [], installationHome: home })
    } finally {
      stop()
    }
    expect(reports).toEqual([expect.objectContaining({ label: 'grok', key: 'acp:grok', source: 'managed', version: '1.0.70', state: 'tested' })])
    expect(spawned).toEqual([])
  })
})
