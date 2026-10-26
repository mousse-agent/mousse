import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeInstanceConfig, type DriverRuntime, type HarnessDriver } from '../../src/mms/harness/driver'
import { cliNames, instanceEnv } from '../../src/mms/harness/env'
import { captureShellPath, parseShellPath, shellPathCommand } from '../../src/mms/harness/shellPath'
import { probeInstance } from '../../src/mms/harness/status'
import { observeHarnessSpawns } from '../../src/mms/harness/spawn'
import { describeStatus } from '../../src/shared/harness/status'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A fake CLI named `fakecli` in its own directory whose `--version` runs `body` (JavaScript). On
 * Windows it is an npm-style `.cmd` shim that `resolveWindowsShim` resolves to node + the script;
 * elsewhere a node script with a shebang.
 */
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

const driver: HarnessDriver = {
  kind: 'claude',
  label: 'Fake CLI',
  binaryNames: cliNames('fakecli'),
  testedVersions: { min: '2.0.0', max: '2.1.999' },
  multiInstance: false,
  privateHome: false,
  canInstall: false,
  methodLabel: 'Fake sign-in',
  decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
  caps: () => ({ steer: 'queue_only', interrupt: false, rollback: 'none', fork: 'portable', events: 'sparse', containment: 'weak', historyInjection: 'prompt', mcp: false, planMode: false, contextUsage: 'none' }),
  updateCommand: (owner) => (owner === 'npm' ? 'npm install -g fakecli@latest' : undefined),
  create: () => runtime()
}

function runtime(auth: DriverRuntime['auth'] = async () => ({ state: 'signed_in', account: { id: 'acct' } })): DriverRuntime {
  return { adapter: {} as DriverRuntime['adapter'], configured: () => true, models: () => [], auth, stop: () => {} }
}

function probe(dir: string | undefined, options: { versionMs?: number; override?: string; auth?: DriverRuntime['auth'] } = {}) {
  // The fake CLI is only on the "login shell" PATH; the inherited PATH supplies node.
  const env = instanceEnv({ instanceId: 'fake', driver: 'claude', configRevision: 0, searchPath: dir ? [dir] : [] })
  return probeInstance({
    driver,
    runtime: runtime(options.auth),
    env,
    force: true,
    ...(options.override ? { override: options.override } : {}),
    timeouts: { versionMs: options.versionMs ?? 10_000, authMs: 2_000 }
  })
}

describe('fake-CLI probes', () => {
  it('finds a CLI on the login-shell PATH, reads its version and its tested range', async () => {
    const result = await probe(fakeCli(`console.log('fakecli 2.1.5 (Fake)')`))
    expect(result).toMatchObject({ install: 'installed', runs: { state: 'yes' }, auth: { state: 'signed_in' }, compatibility: { state: 'tested', testedRange: '2.0.0 – 2.1.999' }, timedOut: false })
    expect(result.binary).toMatchObject({ version: '2.1.5', source: 'path' })
    if (process.platform === 'win32') expect(result.binary?.path).toMatch(/cli\.js$/) // the .cmd shim resolved to node + script
  })

  it('skips the version check for an executable without a version flag; the handshake decides whether it runs', async () => {
    const dir = fakeCli(`process.exit(3)`)
    const spawned: string[][] = []
    const stop = observeHarnessSpawns((entry) => spawned.push(entry.args))
    const env = instanceEnv({ instanceId: 'fake', driver: 'claude', configRevision: 0, searchPath: [dir] })
    const noFlag: HarnessDriver = { ...driver, versionArgs: () => null }
    const handshake = vi.fn(async () => {})
    try {
      const checked = await probeInstance({ driver: noFlag, runtime: { ...runtime(), handshake, runtimeFacts: () => ({ binary: { path: 'x', size: 1, mtimeMs: 1 }, agentInfo: { version: '2.1.0' }, capturedAt: '', source: 'handshake' }) }, env, force: true })
      expect(spawned).toEqual([])
      expect(handshake).not.toHaveBeenCalled()
      expect(checked).toMatchObject({ runs: { state: 'yes' }, compatibility: { state: 'unknown' } })
      expect(checked.binary?.version).toBeUndefined()
      const shook = await probeInstance({ driver: noFlag, runtime: { ...runtime(), handshake, runtimeFacts: () => ({ binary: { path: 'x', size: 1, mtimeMs: 1 }, agentInfo: { version: '2.1.0' }, capturedAt: '', source: 'handshake' }) }, env, force: true, handshake: true })
      expect(handshake).toHaveBeenCalledOnce()
      // The version the agent announced in its handshake.
      expect(shook).toMatchObject({ runs: { state: 'yes' }, binary: { version: '2.1.0' }, compatibility: { state: 'tested' } })
      const failing = await probeInstance({ driver: noFlag, runtime: { ...runtime(), handshake: async () => { throw new Error('exited with code 1') } }, env, force: true, handshake: true })
      expect(failing.runs).toMatchObject({ state: 'no', failure: 'exited' })
    } finally {
      stop()
    }
  })

  it('reports a newer version as newer than tested, never blocking', async () => {
    const result = await probe(fakeCli(`console.log('9.0.0')`))
    expect(result.compatibility.state).toBe('newer_than_tested')
    expect(result.runs.state).toBe('yes')
  })

  it('offers an update command only for a proven owner when the version is too old', async () => {
    const result = await probe(fakeCli(`console.log('1.0.0')`))
    expect(result.compatibility.state).toBe('too_old')
    // A temp-dir binary has no proven owner: no one-click update.
    expect(result.update?.kind).not.toBe('one_click')
  })

  it('a garbage version still runs, with the version unknown', async () => {
    const result = await probe(fakeCli(`console.log('hello there')`))
    expect(result.runs).toMatchObject({ state: 'yes', failure: 'bad_version' })
    expect(result.compatibility.state).toBe('unknown')
    expect(result.binary?.version).toBeUndefined()
  })

  it('a non-zero exit is a broken install that does not run', async () => {
    const result = await probe(fakeCli(`process.exit(3)`))
    expect(result).toMatchObject({ install: 'broken', runs: { state: 'no', failure: 'exited' } })
    expect(result.auth.state).toBe('unknown')
  })

  it('a slow start within the deadline is fine', async () => {
    const result = await probe(fakeCli(`setTimeout(() => console.log('2.1.0'), 600)`))
    expect(result.binary?.version).toBe('2.1.0')
    expect(result.timedOut).toBe(false)
  })

  it('a hang hits the hard deadline, kills the tree and reports a timeout', async () => {
    const started = Date.now()
    const result = await probe(fakeCli(`require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)`), { versionMs: 1_500 })
    expect(Date.now() - started).toBeLessThan(8_000)
    expect(result).toMatchObject({ timedOut: true, runs: { state: 'unknown', failure: 'timeout' } })
  }, 15_000)

  it('nothing on PATH is not installed', async () => {
    const result = await probe(undefined)
    expect(result).toMatchObject({ install: 'not_installed', runs: { state: 'no', failure: 'not_on_path' } })
  })

  it('an override that cannot run reports "Override not found" and never falls back to PATH', async () => {
    const dir = fakeCli(`console.log('2.1.0')`)
    const result = await probe(dir, { override: join(dir, 'missing-binary') })
    expect(result).toMatchObject({ runs: { state: 'no', failure: 'override_not_found' }, binary: { source: 'override' } })
    expect(describeStatus({ ...snapshotOf(result), enabled: { device: true, effective: true, setBy: 'device' } }).headline).toBe('Override not found')
  })

  it('every probe process carries the instance environment', async () => {
    const seen: string[] = []
    const stop = observeHarnessSpawns((spawned) => seen.push(`${spawned.instanceId}:${spawned.purpose}`))
    try {
      await probe(fakeCli(`console.log('2.1.0')`))
    } finally {
      stop()
    }
    expect(seen).toEqual(['fake:version'])
  })
})

function snapshotOf(result: Awaited<ReturnType<typeof probe>>) {
  return {
    instanceId: 'fake', driver: 'claude' as const, displayName: 'Fake', builtIn: true, scope: { kind: 'device' as const },
    enabled: { device: true, effective: true, setBy: 'device' as const },
    install: { state: result.install, canInstall: false }, runs: result.runs, auth: { state: result.auth.state },
    compatibility: result.compatibility, ...(result.binary ? { binary: result.binary } : {}), caps: driver.caps({ home: 'default' }),
    models: { entries: [], source: 'none' as const }, checkedAt: result.checkedAt, stale: false
  }
}

describe('stale status', () => {
  it('a check that times out keeps the last good values and marks the snapshot stale', async () => {
    let calls = 0
    const slowDriver: HarnessDriver = {
      ...driver,
      kind: 'pi',
      binaryNames: [],
      create: () => runtime(async () => {
        calls += 1
        if (calls === 1) return { state: 'signed_in' }
        return new Promise(() => {})
      })
    }
    let stored: unknown = { 'pi:openai': { driver: 'pi', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = testHarness({ drivers: [slowDriver], instances, probeTimeouts: { authMs: 200, versionMs: 200 } })
    const first = (await harness.instances.recheck('pi:openai'))
    expect(first).toMatchObject({ stale: false, auth: { state: 'signed_in' } })
    const second = await harness.instances.recheck('pi:openai')
    expect(second).toMatchObject({ stale: true, auth: { state: 'signed_in' }, lastGoodAt: first.checkedAt })
    expect(describeStatus(second).detail).toMatch(/last good status/)
  })

  it('checks are single-flight per instance', async () => {
    const auth = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { state: 'signed_in' as const }
    })
    let stored: unknown = { 'pi:openai': { driver: 'pi', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = testHarness({ drivers: [{ ...driver, kind: 'pi', binaryNames: [], create: () => runtime(auth) }], instances })
    await Promise.all([harness.instances.snapshots({ kind: 'device' }), harness.instances.snapshots({ kind: 'device' }), harness.instances.recheck('pi:openai')])
    expect(auth).toHaveBeenCalledTimes(1)
    // Cached: a page reopening inside the TTL does not check again.
    await harness.instances.snapshots({ kind: 'device' })
    expect(auth).toHaveBeenCalledTimes(1)
  })
})

describe('login-shell PATH', () => {
  it('parses the marked PATH and drops repeats', () => {
    expect(parseShellPath('motd noise\n__MOUSSE_PATH__/a:/b:/a__MOUSSE_PATH__', 'linux')).toEqual(['/a', '/b'])
    expect(parseShellPath('__MOUSSE_PATH__C:\\a;C:\\b;__MOUSSE_PATH__', 'win32')).toEqual(['C:\\a', 'C:\\b'])
    expect(parseShellPath('no markers', 'linux')).toEqual([])
  })

  it('uses the right command per shell family', () => {
    expect(shellPathCommand('/bin/zsh', 'darwin')).toMatchObject({ command: '/bin/zsh', args: ['-ilc', expect.any(String)] })
    expect(shellPathCommand('/usr/bin/fish', 'linux').args[0]).toBe('-l')
    expect(shellPathCommand('/usr/bin/nu', 'linux').command).toBe('/bin/sh')
    expect(shellPathCommand('C:\\Windows\\cmd.exe', 'win32').command).toBe('powershell.exe')
  })

  it('an empty capture is retried once, then logged as a failure', async () => {
    const run = vi.fn(async () => '')
    const log = vi.fn()
    const result = await captureShellPath({ platform: 'linux', env: { SHELL: '/bin/bash' }, run, log })
    expect(result).toMatchObject({ entries: [], source: 'failed', error: 'empty PATH' })
    expect(run).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('a timed-out first attempt is retried with the 15 s deadline', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce('__MOUSSE_PATH__/opt/bin__MOUSSE_PATH__')
    const result = await captureShellPath({ platform: 'linux', env: { SHELL: '/bin/zsh' }, run, log: () => {} })
    expect(result).toEqual({ entries: ['/opt/bin'], source: 'login_shell' })
    expect(run.mock.calls[0][2]).toMatchObject({ timeoutMs: 15_000 })
  })
})
