/**
 * OpenCode as its own agent entry: Mousse finds the user's `opencode` on PATH or in OpenCode's
 * installer folders and starts it as `opencode acp`; or installs the ACP registry's `opencode`
 * release itself (SHA-256 checked), runs it with its updater off, and refuses it once a file
 * changes. The update command follows who installed the copy. OpenCode processes are recorded, never
 * started (`spawnHarness` is mocked): what the real `opencode acp` does is not observed here.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentInstalls, resetAgentInstallState } from '../../src/mms/harness/agents/install'
import { DIST_DIR } from '../../src/mms/harness/agents/receipt'
import type { RegistryAgent } from '../../src/mms/harness/agents/registry'
import type { DriverContext, DriverRuntime, HarnessDriver } from '../../src/mms/harness/driver'
import { acpDriver } from '../../src/mms/harness/drivers/acp'
import { OPENCODE_AGENT_ID, opencodeDriver } from '../../src/mms/harness/drivers/opencode'
import { findOnPath, instanceEnv, opencodeStandalonePaths, type InstanceEnv } from '../../src/mms/harness/env'
import { updateAffordance } from '../../src/mms/harness/status'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
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

const autoupdateOf = (env: NodeJS.ProcessEnv) => Object.entries(env).find(([key]) => key.toUpperCase() === 'OPENCODE_DISABLE_AUTOUPDATE')?.[1]

function context(env: InstanceEnv, driver: HarnessDriver, options: { stateDir: string; binaryPath?: string; args?: string[]; instanceId?: string }): DriverContext {
  return {
    instanceId: options.instanceId ?? 'opencode:opencode',
    builtIn: false,
    config: { home: 'default', ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}), ...(options.args ? { args: options.args } : {}) },
    env,
    profileHome: options.stateDir,
    installationHome: options.stateDir,
    stateDir: options.stateDir,
    questions: new UserQuestionService(),
    // As the gateway finds it: PATH, then the driver's installer folders.
    findBinary: () => findOnPath(driver.binaryNames, { env: env.env, searchPath: env.driverSearchPath ?? [] }),
    changed: () => {}
  }
}

/** An entry on this computer whose HOME is `home`, with an empty PATH. */
function userSetup(options: { base?: NodeJS.ProcessEnv; binaryPath?: string; args?: string[]; agents?: AgentInstalls; registry?: { agent: (id: string) => Promise<RegistryAgent | undefined> }; instanceId?: string } = {}) {
  const root = tempDir('mousse-opencode-')
  const home = join(root, 'home')
  const emptyPath = join(root, 'empty-path')
  mkdirSync(emptyPath, { recursive: true })
  const instanceId = options.instanceId ?? 'opencode:opencode'
  const env = instanceEnv({
    instanceId,
    driver: 'opencode',
    configRevision: 0,
    searchPath: [],
    base: { PATH: emptyPath, HOME: home, USERPROFILE: home, ...options.base }
  })
  const driver = opencodeDriver({
    ...(options.agents ? { agents: options.agents } : {}),
    ...(options.registry ? { registry: options.registry } : {}),
    pty: { available: () => false }
  })
  const ctx = context(env, driver, { stateDir: join(root, 'state'), ...options })
  const runtime = driver.create(ctx)
  runtimes.push(runtime)
  return { runtime, driver, root, home, env, ctx }
}

describe('finding the user’s opencode', () => {
  it('searches OpenCode’s installer folders after PATH: absolute ones only, each once', () => {
    const home = tempDir('mousse-opencode-home-')
    const custom = join(home, 'custom-bin')
    expect(opencodeStandalonePaths({ HOME: home, USERPROFILE: home, OPENCODE_INSTALL_DIR: custom, XDG_BIN_DIR: 'relative/bin' })).toEqual([
      custom,
      join(home, 'bin'),
      join(home, '.opencode', 'bin')
    ])
    expect(opencodeStandalonePaths({ HOME: home, USERPROFILE: home, OPENCODE_INSTALL_DIR: join(home, '.opencode', 'bin') })).toEqual([
      join(home, '.opencode', 'bin'),
      join(home, 'bin')
    ])
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

describe('the update command', () => {
  // The owner is read from where the executable is (`installOwnerOf`); `managed` is Mousse's own copy.
  const ROWS: Array<[InstallOwner, string | undefined]> = [
    ['standalone', 'opencode upgrade'],
    ['npm', 'npm install -g @opencode/cli@latest'],
    ['pnpm', 'pnpm add -g @opencode/cli@latest'],
    ['bun', 'bun add -g @opencode/cli@latest'],
    ['brew', 'brew upgrade anomalyco/tap/opencode-v2'],
    ['winget', undefined],
    ['unknown', undefined]
  ]

  it.each(ROWS)('a newer version for an %s copy offers %s', (owner, command) => {
    const update = updateAffordance(opencodeDriver(), { path: '/x/opencode', source: 'path', owner, version: '2.4.0' }, { state: 'untested' }, '2.4.1')
    if (command) expect(update).toMatchObject({ kind: 'advisory', command, latestVersion: '2.4.1' })
    else expect(update).toEqual({ kind: 'notice', latestVersion: '2.4.1' })
  })

  it('a managed copy updates in one click, and its newest version is read from @opencode/cli', () => {
    expect(updateAffordance(opencodeDriver(), { path: '/x/opencode', source: 'managed', owner: 'managed', version: '2.4.0' }, { state: 'untested' }, '2.4.1')).toMatchObject({ kind: 'one_click' })
    expect(opencodeDriver().latestVersion).toEqual({ kind: 'npm', package: '@opencode/cli' })
  })
})

describe('a managed OpenCode', () => {
  const KEY = 'linux-x86_64' as const
  const PROGRAM = '#!/bin/sh\necho opencode 2.4.1\n'
  const archive = tarGzOf([{ name: 'opencode', data: PROGRAM, mode: 0o755 }])
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const URL_241 = 'https://github.com/anomalyco/opencode/releases/download/v2.4.1/opencode-linux-x64.tar.gz'

  /** The registry's `opencode` entry, as `decodeAgent` reads it. */
  function entry(version: string, digest = sha256): RegistryAgent {
    return {
      id: OPENCODE_AGENT_ID,
      name: 'OpenCode',
      version,
      description: 'The open source coding agent',
      authors: ['Anomaly'],
      distribution: { binary: { [KEY]: { archive: URL_241, cmd: './opencode', sha256: digest, args: ['acp'], env: {} } } }
    }
  }

  function installation(current: RegistryAgent) {
    const installationHome = tempDir('mousse-opencode-installs-')
    const registry = { current, agent: async (id: string) => (registry.current.id === id ? registry.current : undefined), cached: () => [registry.current] }
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
    // `acp` once: the receipt's registry arguments are not added to the preset's.
    expect(spawned[0]!.args).toEqual(['acp'])
    expect(autoupdateOf(spawned[0]!.env)).toBe('1')
  })

  it('refuses a download that does not match the registry checksum', async () => {
    const shared = installation(entry('2.4.1', 'a'.repeat(64)))
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

  it('removeInstall deletes the files and release drops the entry’s reference', async () => {
    const shared = installation(entry('2.4.1'))
    const first = userSetup({ agents: shared.agents, registry: shared.registry })
    await first.runtime.install!(() => {})
    const path = first.runtime.managed!()!.path
    expect(await first.runtime.removeInstall!({ force: false })).toMatchObject({ removed: true })
    expect(existsSync(path)).toBe(false)
    expect(first.runtime.managed!()).toBeUndefined()

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
    const acpRuntime = acp.create({ ...context(acpEnv, acp, { stateDir: acpRoot, instanceId: 'acp:opencode' }), config })
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
})
