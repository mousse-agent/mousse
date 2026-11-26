/**
 * OpenCode as its own agent entry: Mousse finds the user's `opencode` on PATH or in OpenCode's
 * installer folders and starts it as `opencode acp`; or installs the ACP registry's `opencode`
 * release itself (SHA-256 checked), starts it as its install record says with its updater off, and
 * refuses it once a file changes. Its update follows the owner (the registry for Mousse's own copy),
 * and its sign-in is the computer's, never Mousse's. OpenCode processes are recorded, never started
 * (`spawnHarness` is mocked), and ACP sign-in runs against an in-process agent: what the real
 * `opencode acp` does is not observed here.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpConnection, AcpLaunchRequest } from '../../src/mms/harness/acp/connection'
import { AgentInstalls, resetAgentInstallState } from '../../src/mms/harness/agents/install'
import { DIST_DIR } from '../../src/mms/harness/agents/receipt'
import type { RegistryAgent } from '../../src/mms/harness/agents/registry'
import { installOwner, type DriverContext, type DriverRuntime, type HarnessDriver } from '../../src/mms/harness/driver'
import { acpDriver } from '../../src/mms/harness/drivers/acp'
import { OPENCODE_AGENT_ID, opencodeBrewFormulaOf, opencodeDriver, opencodeNpmPackageOf } from '../../src/mms/harness/drivers/opencode'
import { findOnPath, instanceEnv, opencodeStandalonePaths, type InstanceEnv } from '../../src/mms/harness/env'
import { latestSourceFor, type HarnessGatewayEvent } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { LATEST_TTL_MS, LatestVersionCache, type LatestVersionSource } from '../../src/mms/harness/latest'
import { probeVersion, updateAffordance } from '../../src/mms/harness/status'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { LoginSession } from '../../src/mms/providers/LoginSession'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import { testHarness } from '../../src/mms/run/testkit/harness'
import type { InstallOwner } from '../../src/shared/harness/status'
import { tarGzOf } from './archiveFixtures'

const spawned = vi.hoisted(() => [] as Array<{ purpose: string; command: string; args: string[]; env: NodeJS.ProcessEnv }>)
vi.mock('../../src/mms/harness/spawn', async (original) => ({
  ...(await original<typeof import('../../src/mms/harness/spawn')>()),
  // Records the launch and stops it there: no OpenCode runs in these tests.
  spawnHarness: (env: { env: NodeJS.ProcessEnv }, purpose: string, command: string, args: string[]) => {
    spawned.push({ purpose, command, args, env: env.env })
    throw new Error('not started in tests')
  }
}))

const dirs: string[] = []
const runtimes: DriverRuntime[] = []
beforeEach(() => {
  spawned.length = 0
  resetAgentInstallState()
})
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** An executable named like this platform's `opencode` in `directory`. */
function fakeOpencode(directory: string): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
  writeFileSync(path, '#!/bin/sh\necho opencode\n', { mode: 0o755 })
  return path
}

const variableOf = (env: NodeJS.ProcessEnv, name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1]
const autoupdateOf = (env: NodeJS.ProcessEnv) => variableOf(env, 'OPENCODE_DISABLE_AUTOUPDATE')

interface SetupOptions {
  base?: NodeJS.ProcessEnv
  binaryPath?: string
  args?: string[]
  env?: Record<string, string>
  agents?: AgentInstalls
  registry?: Pick<Registry, 'agent' | 'cached'>
  connect?: (context: DriverContext, request: AcpLaunchRequest) => AcpConnection
  /** The clock of the registry's update check. */
  now?: () => number
  /** Reuse another setup's folders (its HOME and the entry's state). */
  root?: string
}

/** An entry on this computer whose HOME is `<root>/home`, with an empty PATH. */
function userSetup(options: SetupOptions = {}) {
  const root = options.root ?? tempDir('mousse-opencode-')
  const home = join(root, 'home')
  const emptyPath = join(root, 'empty-path')
  mkdirSync(emptyPath, { recursive: true })
  const env: InstanceEnv = instanceEnv({
    instanceId: 'opencode:opencode',
    driver: 'opencode',
    configRevision: 0,
    searchPath: [],
    base: { PATH: emptyPath, HOME: home, USERPROFILE: home, ...options.base }
  })
  const driver: HarnessDriver = opencodeDriver({
    ...(options.agents ? { agents: options.agents } : {}),
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.connect ? { connect: options.connect } : {}),
    ...(options.now ? { now: options.now } : {}),
    pty: { available: () => false }
  })
  const stateDir = join(root, 'state')
  const ctx: DriverContext = {
    instanceId: 'opencode:opencode',
    builtIn: false,
    config: driver.decodeConfig({
      ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
      ...(options.args ? { args: options.args } : {}),
      ...(options.env ? { env: options.env } : {})
    }),
    env,
    profileHome: stateDir,
    installationHome: stateDir,
    stateDir,
    questions: new UserQuestionService(),
    // As the gateway finds it: PATH, then the driver's installer folders.
    findBinary: () => findOnPath(driver.binaryNames, { env: env.env, searchPath: env.driverSearchPath ?? [] }),
    changed: () => {}
  }
  const runtime = driver.create(ctx)
  runtimes.push(runtime)
  return { runtime, driver, root, home, env, ctx }
}

describe('finding the user’s opencode', () => {
  it('on macOS and Linux searches $OPENCODE_INSTALL_DIR, $XDG_BIN_DIR, ~/bin and ~/.opencode/bin: absolute ones only, each once', () => {
    expect(opencodeStandalonePaths({ HOME: '/home/u', OPENCODE_INSTALL_DIR: '/opt/oc', XDG_BIN_DIR: 'relative/bin' }, 'linux')).toEqual(['/opt/oc', '/home/u/bin', '/home/u/.opencode/bin'])
    expect(opencodeStandalonePaths({ HOME: '/home/u', XDG_BIN_DIR: '/home/u/.opencode/bin/' }, 'darwin')).toEqual(['/home/u/.opencode/bin', '/home/u/bin'])
  })

  it('on Windows reads the home from USERPROFILE, and counts folders that differ only in case once', () => {
    expect(opencodeStandalonePaths({ USERPROFILE: 'C:\\Users\\u', HOME: '/ignored', opencode_install_dir: 'c:\\users\\U\\.OPENCODE\\bin' }, 'win32')).toEqual([
      'c:\\users\\U\\.OPENCODE\\bin',
      'C:\\Users\\u\\bin'
    ])
  })

  it('reads ~/.opencode/bin as OpenCode’s own installer, so Update offers `opencode upgrade`', () => {
    expect(installOwner('/home/u/.opencode/bin/opencode', 'path')).toBe('standalone')
    expect(installOwner('C:\\Users\\u\\.opencode\\bin\\opencode.exe', 'path')).toBe('standalone')
  })

  it('finds an installer copy in ~/.opencode/bin that is not on PATH, and starts it as `opencode acp`', async () => {
    const { runtime, home, root } = userSetup({ args: ['--print-logs'] })
    const program = fakeOpencode(join(home, '.opencode', 'bin'))
    expect(runtime.configured()).toBe(true)
    await runtime.handshake!(new AbortController().signal).catch(() => undefined)
    await runtime.refreshModels!(root).catch(() => undefined)
    expect(spawned.map((entry) => entry.purpose)).toEqual(['acp-handshake', 'acp-models'])
    for (const entry of spawned) {
      expect(entry.command).toBe(program)
      // The entry's own arguments follow `acp`.
      expect(entry.args).toEqual(['acp', '--print-logs'])
      // The user's own OpenCode updates itself as they set it up.
      expect(autoupdateOf(entry.env)).toBeUndefined()
    }
  })

  it('finds a copy in $OPENCODE_INSTALL_DIR', async () => {
    const custom = join(tempDir('mousse-opencode-install-dir-'), 'bin')
    const program = fakeOpencode(custom)
    const { runtime } = userSetup({ base: { OPENCODE_INSTALL_DIR: custom } })
    await runtime.handshake!(new AbortController().signal).catch(() => undefined)
    expect(spawned[0]).toMatchObject({ command: program, args: ['acp'] })
  })

  it('is not configured when there is no opencode anywhere', async () => {
    const { runtime } = userSetup()
    expect(runtime.configured()).toBe(false)
    await expect(runtime.handshake!(new AbortController().signal)).rejects.toThrow(/not installed/)
    expect(spawned).toEqual([])
  })

  it('an executable set on the entry wins over the one found', async () => {
    const own = fakeOpencode(join(tempDir('mousse-opencode-own-'), 'bin'))
    const { runtime, home } = userSetup({ binaryPath: own })
    fakeOpencode(join(home, '.opencode', 'bin'))
    await runtime.handshake!(new AbortController().signal).catch(() => undefined)
    expect(spawned[0]).toMatchObject({ command: own, args: ['acp'] })
  })
})

describe('which OpenCode package an npm, pnpm or bun copy came from', () => {
  // OpenCode is on npm twice: `@opencode/cli` (2.x) and the older `opencode-ai`, still published as
  // the 1.x line. A copy is compared with, and updated within, the package it came from.
  /** Recorded from npm 11.19.0 on Windows: `npm install -g opencode-ai@1.19.6` (or `@opencode/cli@2.4.1`) writes this `opencode.cmd`. */
  const npmCmd = (folder: string) =>
    `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\${folder}\\bin\\opencode.exe"   %*\r\n`
  /** Hand-authored after pnpm's launcher script (`$basedir/global/5/node_modules/<package>/...`); pnpm was not run. */
  const pnpmSh = (folder: string) =>
    `#!/bin/sh\nbasedir=$(dirname "$0")\nexport NODE_PATH="$basedir/global/5/.pnpm/node_modules"\nexec "$basedir/global/5/node_modules/${folder}/bin/opencode.exe" "$@"\n`

  // [what, the path on PATH, where it really is (a link's target), its launcher's text, the package]
  const ROWS: Array<[string, string, string | undefined, string | undefined, string | undefined]> = [
    ['npm on macOS/Linux, linked into lib/node_modules', '/usr/local/bin/opencode', '/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe', undefined, 'opencode-ai'],
    ['npm on macOS/Linux, the 2.x package', '/usr/local/bin/opencode', '/usr/local/lib/node_modules/@opencode/cli/bin/opencode.exe', undefined, '@opencode/cli'],
    ['a link to the 1.x per-platform build', '/usr/local/bin/opencode', '/usr/local/lib/node_modules/opencode-darwin-arm64/bin/opencode', undefined, 'opencode-ai'],
    ['a link to the 2.x per-platform build', '/usr/local/bin/opencode', '/usr/local/lib/node_modules/@opencode/cli-linux-x64-musl/bin/opencode', undefined, '@opencode/cli'],
    ['bun on macOS/Linux', '/home/u/.bun/bin/opencode', '/home/u/.bun/install/global/node_modules/opencode-ai/bin/opencode.exe', undefined, 'opencode-ai'],
    ['pnpm’s store layout', '/home/u/.local/share/pnpm/opencode', '/home/u/.local/share/pnpm/global/5/.pnpm/@opencode+cli@2.4.1/node_modules/@opencode/cli/bin/opencode.exe', undefined, '@opencode/cli'],
    ['npm on Windows (its launcher names the package)', 'C:\\Users\\u\\AppData\\Roaming\\npm\\opencode.cmd', undefined, npmCmd('opencode-ai'), 'opencode-ai'],
    ['npm on Windows, the 2.x package', 'C:\\Users\\u\\AppData\\Roaming\\npm\\opencode.cmd', undefined, npmCmd('@opencode\\cli'), '@opencode/cli'],
    ['pnpm’s launcher script', '/home/u/.local/share/pnpm/opencode', undefined, pnpmSh('opencode-ai'), 'opencode-ai'],
    ['a Windows path that itself names the package', 'C:\\Users\\U\\AppData\\Roaming\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe', undefined, undefined, '@opencode/cli'],
    ['a launcher that names neither', '/usr/local/bin/opencode', undefined, '#!/bin/sh\nexec /opt/other/opencode "$@"\n', undefined],
    ['a launcher that names both', '/usr/local/bin/opencode', undefined, `${pnpmSh('opencode-ai')}${pnpmSh('@opencode/cli')}`, undefined],
    ['a package of a similar name', '/usr/local/bin/opencode', '/usr/local/lib/node_modules/opencode-ai-plugin/bin/opencode', undefined, undefined],
    ['nothing readable', '/usr/local/bin/opencode', undefined, undefined, undefined]
  ]

  it.each(ROWS)('%s', (_what, path, target, launcher, expected) => {
    const read = (file: string) => (file === path ? launcher : undefined)
    expect(opencodeNpmPackageOf(path, { realpath: () => target, read })).toBe(expected)
  })

  it('reads the launchers on disk: npm’s `.cmd`, and bun’s UTF-16 `.bunx` beside its `.exe` on Windows', () => {
    const dir = tempDir('mousse-opencode-launchers-')
    writeFileSync(join(dir, 'opencode.cmd'), npmCmd('opencode-ai'))
    expect(opencodeNpmPackageOf(join(dir, 'opencode.cmd'))).toBe('opencode-ai')
    // Hand-authored after bun's `.bunx` (its target, relative, in UTF-16); bun was not run.
    writeFileSync(join(dir, 'opencode.exe'), Buffer.alloc(128 * 1024))
    writeFileSync(join(dir, 'opencode.bunx'), Buffer.from('..\\install\\global\\node_modules\\@opencode\\cli\\bin\\opencode.exe"', 'utf16le'))
    expect(opencodeNpmPackageOf(join(dir, 'opencode.exe'))).toBe('@opencode/cli')
  })

  it('a copy installed from `opencode-ai` is compared with `opencode-ai` and updated with it, never with `@opencode/cli`', async () => {
    // npm's global layout on Windows: the launcher on PATH, the package beside it. On Windows the
    // launcher resolves to the program it runs (`resolveWindowsShim`), whose path names the package;
    // elsewhere the launcher's text does.
    const prefix = join(tempDir('mousse-opencode-npm-'), 'npm')
    mkdirSync(join(prefix, 'node_modules', 'opencode-ai', 'bin'), { recursive: true })
    writeFileSync(join(prefix, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'), 'MZ not a real program', { mode: 0o755 })
    writeFileSync(join(prefix, 'opencode.cmd'), npmCmd('opencode-ai'), { mode: 0o755 })
    const { driver, env } = userSetup()
    const probe = await probeVersion({ driver, env, override: join(prefix, 'opencode.cmd'), timeoutMs: 10_000 })
    expect(probe.binary).toMatchObject({ owner: 'npm', package: 'opencode-ai' })
    expect(latestSourceFor(driver, probe.binary)).toEqual({ kind: 'npm', package: 'opencode-ai' })
    const update = updateAffordance(driver, { ...probe.binary!, version: '1.19.0' }, { state: 'untested' }, '1.19.6')
    expect(update).toMatchObject({ kind: 'advisory', command: 'npm install -g opencode-ai@latest', latestVersion: '1.19.6' })
  })
})

describe('which Homebrew formula a Homebrew copy came from', () => {
  // homebrew-core's `opencode` is 2.x; OpenCode's tap has `opencode` (1.x) and `opencode-v2` (2.x).
  /** The `source` part of a keg's `INSTALL_RECEIPT.json`, as Homebrew writes it. */
  const receipt = (tap: string) => JSON.stringify({ homebrew_version: '4.6.0', source: { tap, spec: 'stable' } })
  // [what, where the link on PATH leads, the keg's install record, the formula]
  const ROWS: Array<[string, string | undefined, string | undefined, string | undefined]> = [
    ['homebrew-core', '/opt/homebrew/Cellar/opencode/2.4.0/bin/opencode', receipt('homebrew/core'), 'opencode'],
    ['OpenCode’s tap, the 1.x line', '/opt/homebrew/Cellar/opencode/1.19.6/bin/opencode', receipt('anomalyco/tap'), 'anomalyco/tap/opencode'],
    ['OpenCode’s tap, 2.x', '/usr/local/Cellar/opencode-v2/2.4.1/bin/opencode', receipt('anomalyco/tap'), 'anomalyco/tap/opencode-v2'],
    ['`opencode-v2` without an install record', '/home/linuxbrew/.linuxbrew/Cellar/opencode-v2/2.4.1/bin/opencode', undefined, 'anomalyco/tap/opencode-v2'],
    ['`opencode` without an install record (core or tap?)', '/opt/homebrew/Cellar/opencode/2.4.0/bin/opencode', undefined, undefined],
    ['an unreadable install record', '/opt/homebrew/Cellar/opencode/2.4.0/bin/opencode', '{not json', undefined],
    ['another formula', '/opt/homebrew/Cellar/sst/3.0.0/bin/opencode', receipt('homebrew/core'), undefined],
    ['a link that leads nowhere in a keg', undefined, undefined, undefined]
  ]

  it.each(ROWS)('%s', (_what, target, record, expected) => {
    const kegOf = (path: string) => path.split('/bin/')[0]
    const read = (file: string) => (target && file === `${kegOf(target)}/INSTALL_RECEIPT.json` ? record : undefined)
    expect(opencodeBrewFormulaOf('/opt/homebrew/bin/opencode', { realpath: () => target, read })).toBe(expected)
  })

  it('a copy from OpenCode’s tap is compared with that formula and upgraded with it, never with homebrew-core’s', async () => {
    const keg = join(tempDir('mousse-opencode-brew-'), 'Cellar', 'opencode', '1.19.6')
    const program = fakeOpencode(join(keg, 'bin'))
    writeFileSync(join(keg, 'INSTALL_RECEIPT.json'), receipt('anomalyco/tap'))
    const { driver, env } = userSetup()
    const probe = await probeVersion({ driver, env, override: program, timeoutMs: 10_000 })
    expect(probe.binary).toMatchObject({ owner: 'brew', package: 'anomalyco/tap/opencode' })
    expect(latestSourceFor(driver, probe.binary)).toEqual({ kind: 'brew', name: 'anomalyco/tap/opencode' })
    const update = updateAffordance(driver, { ...probe.binary!, version: '1.19.0' }, { state: 'untested' }, '1.19.6')
    expect(update).toMatchObject({ kind: 'advisory', command: 'brew upgrade anomalyco/tap/opencode', latestVersion: '1.19.6' })
  })
})

describe('the update of the user’s own opencode', () => {
  // The owner is read from where the executable is (`installOwnerOf`); a package manager's copy's
  // package or formula from its path (`opencodePackageOf`).
  // [owner, its package or formula, where its newest version is read, the command offered]
  const ROWS: Array<[InstallOwner, string | undefined, LatestVersionSource | undefined, string | undefined]> = [
    ['standalone', undefined, { kind: 'npm', package: '@opencode/cli' }, 'opencode upgrade'],
    // Homebrew's formula the copy came from, which `brew upgrade` reaches.
    ['brew', 'opencode', { kind: 'brew', name: 'opencode' }, 'brew upgrade opencode'],
    ['brew', 'anomalyco/tap/opencode', { kind: 'brew', name: 'anomalyco/tap/opencode' }, 'brew upgrade anomalyco/tap/opencode'],
    // Which `opencode` is unknown: nothing to compare with; OpenCode's own upgrade finds Homebrew.
    ['brew', undefined, undefined, 'opencode upgrade'],
    ['npm', '@opencode/cli', { kind: 'npm', package: '@opencode/cli' }, 'npm install -g @opencode/cli@latest'],
    ['npm', 'opencode-ai', { kind: 'npm', package: 'opencode-ai' }, 'npm install -g opencode-ai@latest'],
    ['pnpm', 'opencode-ai', { kind: 'npm', package: 'opencode-ai' }, 'pnpm add -g opencode-ai@latest'],
    ['bun', '@opencode/cli', { kind: 'npm', package: '@opencode/cli' }, 'bun add -g @opencode/cli@latest'],
    // Which package is unknown: nothing to compare with, nothing to run.
    ['npm', undefined, undefined, undefined],
    ['winget', undefined, { kind: 'npm', package: '@opencode/cli' }, undefined],
    ['unknown', undefined, { kind: 'npm', package: '@opencode/cli' }, undefined]
  ]

  it.each(ROWS)('an %s copy of %s is compared with %o and offers %s', (owner, pkg, source, command) => {
    const binary = { path: '/x/bin/opencode', source: 'path' as const, owner, version: '2.4.0', ...(pkg ? { package: pkg } : {}) }
    expect(latestSourceFor(opencodeDriver(), binary)).toEqual(source)
    const update = updateAffordance(opencodeDriver(), binary, { state: 'untested' }, '2.4.1')
    if (command) expect(update).toMatchObject({ kind: 'advisory', command, latestVersion: '2.4.1' })
    else expect(update).toEqual({ kind: 'notice', latestVersion: '2.4.1' })
  })
})

describe('OpenCode’s sign-in', () => {
  /** An OpenCode over ACP that signs in with one `agent` method and counts what it is asked. */
  function agent() {
    const counts = { authenticate: 0, logout: 0 }
    const fake = inProcessAgent((app) => {
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [{ id: 'opencode-login', name: 'Log in to OpenCode' }] as never }))
        .onRequest(methods.agent.authenticate, () => {
          counts.authenticate += 1
          return {}
        })
        .onRequest(methods.agent.logout, () => {
          counts.logout += 1
          return {}
        })
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'verify' }))
    })
    return { counts, connect: (_context: DriverContext, request: AcpLaunchRequest) => fake.connect(request), connections: fake.connections }
  }

  async function signedIn(options: { args?: string[]; env?: Record<string, string> } = {}) {
    const fake = agent()
    const first = userSetup({ connect: fake.connect, ...options })
    fakeOpencode(join(first.home, '.opencode', 'bin'))
    expect(await first.runtime.signIn!(new LoginSession('op'), process.cwd())).toMatchObject({ success: true })
    expect((await first.runtime.auth({ force: false })).state).toBe('signed_in')
    return { fake, first }
  }

  it('a sign-in counts for the entry’s arguments and variables: changing either asks again', async () => {
    const { fake, first } = await signedIn({ args: ['--print-logs'], env: { OPENCODE_CONFIG: '/a.json' } })
    const same = userSetup({ connect: fake.connect, root: first.root, args: ['--print-logs'], env: { OPENCODE_CONFIG: '/a.json' } })
    expect((await same.runtime.auth({ force: false })).state).toBe('signed_in')
    const otherEnv = userSetup({ connect: fake.connect, root: first.root, args: ['--print-logs'], env: { OPENCODE_CONFIG: '/b.json' } })
    expect((await otherEnv.runtime.auth({ force: false })).state).not.toBe('signed_in')
    const otherArgs = userSetup({ connect: fake.connect, root: first.root, env: { OPENCODE_CONFIG: '/a.json' } })
    expect((await otherArgs.runtime.auth({ force: false })).state).not.toBe('signed_in')
  })

  it('sign-out never asks OpenCode to sign out: its sign-in is the computer’s', async () => {
    const { fake, first } = await signedIn()
    const opened = fake.connections.length
    await first.runtime.signOut!()
    expect(fake.counts.logout).toBe(0)
    expect(fake.connections.length).toBe(opened)
    expect((await first.runtime.auth({ force: false })).state).not.toBe('signed_in')
  })
})

type Registry = { current: RegistryAgent; agent: (id: string) => Promise<RegistryAgent | undefined>; cached: () => RegistryAgent[]; asked: number }

describe('a managed OpenCode', () => {
  const KEY = 'linux-x86_64' as const
  const PROGRAM = '#!/bin/sh\necho opencode 2.4.1\n'
  const archive = tarGzOf([{ name: 'opencode', data: PROGRAM, mode: 0o755 }])
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const URL_241 = 'https://github.com/anomalyco/opencode/releases/download/v2.4.1/opencode-linux-x64.tar.gz'

  /** The registry's `opencode` entry, as `decodeAgent` reads it. */
  function entry(version: string, options: { digest?: string; args?: string[]; env?: Record<string, string> } = {}): RegistryAgent {
    return {
      id: OPENCODE_AGENT_ID,
      name: 'OpenCode',
      version,
      description: 'The open source coding agent',
      authors: ['Anomaly'],
      distribution: { binary: { [KEY]: { archive: URL_241, cmd: './opencode', sha256: options.digest ?? sha256, args: options.args ?? ['acp'], env: options.env ?? {} } } }
    }
  }

  /**
   * The registry: `current` is what it publishes now, `cached()` what Mousse last read from it, which
   * changes only when it is asked (`agent`), as `AcpRegistry` keeps its snapshot.
   */
  function installation(current: RegistryAgent) {
    const installationHome = tempDir('mousse-opencode-installs-')
    let snapshot = [current]
    const registry: Registry = {
      current,
      asked: 0,
      agent: async (id: string) => {
        registry.asked += 1
        snapshot = [registry.current]
        return registry.current.id === id ? registry.current : undefined
      },
      cached: () => snapshot
    }
    const downloads: string[] = []
    const agents = new AgentInstalls({
      installationHome,
      profileId: 'p1',
      registry,
      platformKeys: [KEY],
      exitGraceMs: 50,
      fetch: (async (url: string) => {
        downloads.push(url)
        return new Response(archive, { headers: { 'content-length': String(archive.length) } })
      }) as unknown as typeof fetch
    })
    return { agents, registry, downloads, installationHome }
  }

  it('installs the registry’s release, checked against its SHA-256, and runs it with its updater off', async () => {
    const shared = installation(entry('2.4.1'))
    const { runtime, home } = userSetup({ agents: shared.agents, registry: shared.registry })
    // The user's own copy is there too: Mousse's own install is what runs once it exists.
    fakeOpencode(join(home, '.opencode', 'bin'))
    await runtime.install!(() => {})
    expect(shared.downloads).toEqual([URL_241])
    const managed = runtime.managed!()
    expect(managed).toMatchObject({ version: '2.4.1', checksum: 'registry' })
    expect(managed!.path).toBe(join(shared.installationHome, 'agents', 'opencode', '2.4.1', KEY, DIST_DIR, 'opencode'))
    await runtime.handshake!(new AbortController().signal).catch(() => undefined)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.command).toBe(managed!.path)
    expect(spawned[0]!.args).toEqual(['acp'])
    expect(autoupdateOf(spawned[0]!.env)).toBe('1')
  })

  it('starts as its install record says, the entry’s arguments and variables after, and the updater off whatever the entry sets', async () => {
    const shared = installation(entry('2.4.1', { args: ['acp', '--from-registry'], env: { OPENCODE_FROM_REGISTRY: '1', OPENCODE_SHARED: 'registry' } }))
    const { runtime } = userSetup({ agents: shared.agents, registry: shared.registry, args: ['--print-logs'], env: { OPENCODE_SHARED: 'entry', OPENCODE_DISABLE_AUTOUPDATE: '0' } })
    await runtime.install!(() => {})
    await runtime.handshake!(new AbortController().signal).catch(() => undefined)
    const [launch] = spawned
    // `acp` once, the registry's flags kept, the entry's own after.
    expect(launch!.args).toEqual(['acp', '--from-registry', '--print-logs'])
    expect(variableOf(launch!.env, 'OPENCODE_FROM_REGISTRY')).toBe('1')
    expect(variableOf(launch!.env, 'OPENCODE_SHARED')).toBe('entry')
    expect(autoupdateOf(launch!.env)).toBe('1')
  })

  it('refuses a download that does not match the registry checksum', async () => {
    const shared = installation(entry('2.4.1', { digest: 'a'.repeat(64) }))
    const { runtime } = userSetup({ agents: shared.agents, registry: shared.registry })
    await expect(runtime.install!(() => {})).rejects.toThrow(/does not match the registry checksum/)
    expect(runtime.managed!()).toBeUndefined()
  })

  it('refuses to start once an installed file changed, and says so on the card', async () => {
    const shared = installation(entry('2.4.1'))
    const { runtime } = userSetup({ agents: shared.agents, registry: shared.registry })
    await runtime.install!(() => {})
    appendFileSync(runtime.managed!()!.path, 'tampered\n')
    await expect(runtime.handshake!(new AbortController().signal)).rejects.toThrow(/Installed files changed/)
    expect(spawned).toEqual([])
    await runtime.verifyInstall!(new AbortController().signal)
    expect(runtime.managed!()!.broken).toMatch(/opencode/)
    expect(runtime.configured()).toBe(false)
  })

  it('an executable set on the entry still runs when the managed copy’s files changed, as the user set it up', async () => {
    const shared = installation(entry('2.4.1'))
    const managedEntry = userSetup({ agents: shared.agents, registry: shared.registry })
    await managedEntry.runtime.install!(() => {})
    appendFileSync(managedEntry.runtime.managed!()!.path, 'tampered\n')
    await managedEntry.runtime.verifyInstall!(new AbortController().signal)
    const broken = managedEntry.runtime.managed!()!
    expect(broken.broken).toBeTruthy()

    const own = fakeOpencode(join(tempDir('mousse-opencode-own-'), 'bin'))
    const { runtime, driver, env } = userSetup({ agents: shared.agents, registry: shared.registry, binaryPath: own })
    // Recheck reads the installed files only of a copy that runs: this entry's copy is not, so it
    // is never found broken and the entry stays usable.
    await runtime.verifyInstall!(new AbortController().signal)
    expect(runtime.managed!()!.broken).toBeUndefined()
    expect(runtime.configured()).toBe(true)
    // A start checks no managed files either: the user's executable starts.
    await runtime.handshake!(new AbortController().signal).catch(() => undefined)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({ command: own, args: ['acp'] })
    expect(autoupdateOf(spawned[0]!.env)).toBeUndefined()
    // The check reads the executable, not the broken copy.
    // (Node stands in for the user's executable, so the version check has something to run.)
    const probe = await probeVersion({ driver, env, override: process.execPath, managed: broken, timeoutMs: 10_000 })
    expect(probe.install).not.toBe('broken')
    expect(probe.binary).toMatchObject({ path: process.execPath, source: 'override' })
  })

  it('a newer registry release replaces the old version on Reinstall', async () => {
    const shared = installation(entry('2.4.1'))
    const { runtime } = userSetup({ agents: shared.agents, registry: shared.registry })
    await runtime.install!(() => {})
    const old = runtime.managed!()!.path
    shared.registry.current = entry('2.4.2')
    await runtime.install!(() => {})
    expect(runtime.managed!()).toMatchObject({ version: '2.4.2' })
    expect(existsSync(old)).toBe(false)
  })

  it('reports a newer registry release only when the version changed, and waits as long after a failed lookup', async () => {
    // The wait itself and a real change are observed through Settings → Providers below.
    const shared = installation(entry('2.4.1'))
    const clock = { now: 1_000_000 }
    const { runtime } = userSetup({ agents: shared.agents, registry: shared.registry, now: () => clock.now })
    expect(await runtime.refreshManagedLatest!()).toBe(false)
    expect(shared.registry.asked).toBe(1)

    const answer = shared.registry.agent
    shared.registry.agent = async () => {
      shared.registry.asked += 1
      throw new Error('offline')
    }
    clock.now += LATEST_TTL_MS
    expect(await runtime.refreshManagedLatest!()).toBe(false)
    expect(shared.registry.asked).toBe(2)
    shared.registry.agent = answer
    shared.registry.current = entry('2.4.2')
    clock.now += LATEST_TTL_MS - 1_000
    expect(await runtime.refreshManagedLatest!()).toBe(false)
    expect(shared.registry.asked).toBe(2)
  })

  it('removeInstall deletes the files, after which the user’s own opencode runs; release drops the entry’s reference', async () => {
    const shared = installation(entry('2.4.1'))
    const first = userSetup({ agents: shared.agents, registry: shared.registry })
    await first.runtime.install!(() => {})
    const path = first.runtime.managed!()!.path
    const own = fakeOpencode(join(first.home, '.opencode', 'bin'))
    expect(await first.runtime.removeInstall!({ force: false })).toMatchObject({ removed: true })
    expect(existsSync(path)).toBe(false)
    expect(first.runtime.managed!()).toBeUndefined()
    await first.runtime.handshake!(new AbortController().signal).catch(() => undefined)
    expect(spawned.at(-1)).toMatchObject({ command: own, args: ['acp'] })

    const second = userSetup({ agents: shared.agents, registry: shared.registry })
    await second.runtime.install!(() => {})
    await second.runtime.release!()
    expect(shared.agents.reference(OPENCODE_AGENT_ID, 'opencode:opencode')).toBeUndefined()
  })

  it('leaves an OpenCode added earlier from the registry (an ACP agent entry) working, on the same files', async () => {
    const shared = installation(entry('2.4.1'))
    // An entry added through "More ACP agents…" before OpenCode had its own.
    const acp = acpDriver({ agents: shared.agents })
    const config = acp.decodeConfig({ source: { kind: 'registry', agentId: 'opencode', version: '2.4.1', distribution: 'binary' } })
    expect(config.source).toEqual({ kind: 'registry', agentId: 'opencode', version: '2.4.1', distribution: 'binary' })
    const acpRoot = tempDir('mousse-opencode-acp-entry-')
    const acpEnv = instanceEnv({ instanceId: 'acp:opencode', driver: 'acp', configRevision: 0, searchPath: [], base: { PATH: '' } })
    const acpRuntime = acp.create({
      instanceId: 'acp:opencode',
      builtIn: false,
      config,
      env: acpEnv,
      profileHome: acpRoot,
      installationHome: acpRoot,
      stateDir: acpRoot,
      questions: new UserQuestionService(),
      findBinary: () => undefined,
      changed: () => {}
    })
    runtimes.push(acpRuntime)
    await acpRuntime.install!(() => {})

    const own = userSetup({ agents: shared.agents, registry: shared.registry })
    await own.runtime.install!(() => {})
    // One copy serves both; removing it from the OpenCode entry asks first, since the ACP entry uses it.
    expect(own.runtime.managed!()!.path).toBe(acpRuntime.managed!()!.path)
    expect(await own.runtime.removeInstall!({ force: false })).toMatchObject({ removed: false })
    expect(acpRuntime.configured()).toBe(true)
    await acpRuntime.handshake!(new AbortController().signal).catch(() => undefined)
    expect(spawned.at(-1)).toMatchObject({ purpose: 'acp-handshake', command: acpRuntime.managed!()!.path, args: ['acp'] })
  })

  describe('in Settings → Providers', () => {
    const device = { kind: 'device' } as const
    const ID = 'opencode:opencode'

    async function waitFor(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
      const deadline = Date.now() + ms
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error('timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }

    /** The gateway over one managed OpenCode entry; npm says `npmVersion` is the newest `@opencode/cli`. */
    async function providers(npmVersion: string) {
      const shared = installation(entry('2.4.1'))
      // Installed for the entry before the page opens.
      await userSetup({ agents: shared.agents, registry: shared.registry }).runtime.install!(() => {})
      const clock = { now: Date.now() }
      const npmAsked: string[] = []
      const fetchImpl = (async (url: string) => {
        npmAsked.push(url)
        return Response.json({ version: npmVersion })
      }) as unknown as typeof fetch
      const fake = inProcessAgent((app) => {
        app.onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
      })
      const profileHome = tempDir('mousse-opencode-gateway-')
      let stored: unknown = { [ID]: { driver: 'opencode', enabled: true } }
      const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
      const harness = testHarness({
        drivers: [opencodeDriver({ agents: shared.agents, registry: shared.registry, connect: (_context, request) => fake.connect(request), pty: { available: () => false }, now: () => clock.now })],
        instances,
        profileHome,
        latest: new LatestVersionCache(profileHome, { fetchImpl })
      })
      const snapshot = async () => (await harness.instances.snapshots(device)).find((entry) => entry.instanceId === ID)!
      await waitFor(async () => (await snapshot()).binary?.source === 'managed')
      return { harness, shared, clock, npmAsked, fake, snapshot }
    }

    it('updates a managed copy to the registry’s release, never to a newer npm one, and asks only the registry', async () => {
      const { harness, shared, clock, npmAsked, snapshot } = await providers('2.5.0')
      expect((await snapshot()).update).toBeUndefined()
      expect(npmAsked).toEqual([])
      // Opening the page asked the registry already.
      const asked = shared.registry.asked

      // The registry publishes 2.4.2. Within the wait it is not asked again, so nothing is offered.
      shared.registry.current = entry('2.4.2')
      const events: HarnessGatewayEvent[] = []
      const unsubscribe = harness.instances.subscribe((event) => events.push(event))
      clock.now += LATEST_TTL_MS - 1_000
      expect((await snapshot()).update).toBeUndefined()
      expect(shared.registry.asked).toBe(asked)

      // Once it is due, the next look asks it, and the open page is sent the newer release without a recheck.
      clock.now += 1_000
      await snapshot()
      expect(shared.registry.asked).toBe(asked + 1)
      const offered = (event: HarnessGatewayEvent) =>
        event.type === 'snapshots' && event.data.snapshots.some((entry) => entry.instanceId === ID && entry.update?.latestVersion === '2.4.2')
      await waitFor(() => events.some(offered))
      expect((await snapshot()).update).toEqual({ kind: 'one_click', owner: 'managed', latestVersion: '2.4.2' })

      await harness.instances.update(ID)
      await waitFor(async () => (await snapshot()).binary?.version === '2.4.2')
      expect((await snapshot()).update).toBeUndefined()
      expect(npmAsked).toEqual([])
      unsubscribe()
      harness.stop()
    })

    it('sign-out leaves the computer’s OpenCode sign-in alone, and signing in again only clears Mousse’s flag', async () => {
      const { harness, fake, snapshot } = await providers('2.4.1')
      const signedOut = await harness.instances.signOut(ID)
      expect(signedOut.auth).toMatchObject({ state: 'signed_out', message: expect.stringMatching(/OpenCode sign-in on this computer is unchanged/) })
      const opened = fake.connections.length
      await harness.instances.signIn(ID)
      await waitFor(async () => (await snapshot()).auth.state !== 'signed_out')
      // No ACP sign-in ran: no agent was started for it.
      expect(fake.connections.slice(opened).filter((connection) => connection.request.purpose === 'sign_in')).toEqual([])
      harness.stop()
    })
  })
})

describe('OpenCode one-shots', () => {
  const inline = (env: NodeJS.ProcessEnv) => JSON.parse(variableOf(env, 'OPENCODE_CONFIG_CONTENT') ?? 'null') as Record<string, unknown> | null
  const titleSpec = { model: 'default', system: 'You name chats.', prompt: 'fix the login bug', onActivity: () => {} }

  it('is declared, so OpenCode is offered for chat titles', () => {
    expect(opencodeDriver().oneShot).toBe(true)
  })

  it('starts its process with every permission denied; other launches run as the user set OpenCode up', async () => {
    const { runtime, home, root } = userSetup()
    fakeOpencode(join(home, '.opencode', 'bin'))
    await runtime.handshake!(new AbortController().signal).catch(() => undefined)
    await runtime.oneShot!(titleSpec, new AbortController().signal).catch(() => undefined)
    expect(spawned.map((entry) => entry.purpose)).toEqual(['acp-handshake', 'acp-one_shot'])
    expect(inline(spawned[0]!.env)).toBeNull()
    expect(inline(spawned[1]!.env)).toEqual({ permission: { '*': 'deny' } })
    // The one-shot's own folder is gone afterwards.
    expect(existsSync(join(root, 'state', 'one-shot')) ? readdirSync(join(root, 'state', 'one-shot')) : []).toEqual([])
  })

  it.each([
    ['an inline config of the user’s', '{"model":"anthropic/claude"}', { model: 'anthropic/claude', permission: { '*': 'deny' } }],
    ['an inline config that allows tools', '{"permission":{"bash":"allow"},"permissions":[{"action":"*","effect":"allow"}]}', { permission: { '*': 'deny' } }],
    ['an inline config that is not JSON', 'not json', { permission: { '*': 'deny' } }]
  ])('keeps %s except its permissions', async (_name, content, expected) => {
    const { runtime, home } = userSetup({ base: { OPENCODE_CONFIG_CONTENT: content } })
    fakeOpencode(join(home, '.opencode', 'bin'))
    await runtime.oneShot!(titleSpec, new AbortController().signal).catch(() => undefined)
    expect(inline(spawned.at(-1)!.env)).toEqual(expected)
  })
})