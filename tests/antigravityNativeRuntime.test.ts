import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { AntigravityProviderService } from '../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { antigravityConnectionFactory, readAgyAcpFlags } from '../src/mms/harness/acp/presets/antigravity'
import { antigravityDriver } from '../src/mms/harness/drivers/antigravity'
import { NATIVE_AGENT_NAME } from '../src/mms/harness/acp/presets/antigravity/nativeRelease'
import { CliVersionCache } from '../src/mms/harness/cliConfig'
import { LoginSession } from '../src/mms/providers/LoginSession'
import type { DriverContext } from '../src/mms/harness/driver'

// An earlier 1.1.1 install is recognised by its real sizes; here a test names where one is.
const legacy = vi.hoisted(() => ({ path: undefined as string | undefined }))
vi.mock('../src/mms/harness/acp/presets/antigravity/installation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mms/harness/acp/presets/antigravity/installation')>()),
  installedAntigravityBinary: vi.fn(() => legacy.path)
}))

// Only the agent process is replaced, to read what Mousse starts it with.
const spawned = vi.hoisted(() => ({ calls: [] as Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string; stdin: import('node:stream').PassThrough; stdout: import('node:stream').PassThrough; stderr: import('node:stream').PassThrough; child: import('node:events').EventEmitter }>, help: '' }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: vi.fn((file: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, exitCode: null, signalCode: null, kill: vi.fn() })
      spawned.calls.push({ file, args, env: options.env, cwd: options.cwd, stdin, stdout, stderr, child })
      return child
    }),
    // `agy acp --help`, as `spawned.help` says.
    execFile: vi.fn((_file: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => done(null, '', spawned.help)),
    spawnSync: vi.fn((_file: string, args: string[]) => ({ status: 0, stdout: '', stderr: `__MOUSSE_ANTIGRAVITY_AUTH_URL__${args[0]}\n` }))
  }
})

const homes: string[] = []
const services: AntigravityProviderService[] = []
beforeEach(() => { spawned.calls.length = 0; legacy.path = undefined })
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** Google's release of `version` for Windows x64: its bytes name the version, so the start-up check can report it. */
const bytes = (version: string) => Buffer.from(`agy ${version}`)
const assetUrl = (version: string) => `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-1/windows-x64/cli_windows_x64.exe`

/** Google's feed (naming `feed.version`) and its downloads. */
function google(feed: { version: string }) {
  return vi.fn(async (url: string | URL | Request) => String(url).endsWith('.json')
    ? Response.json({ version: feed.version, url: assetUrl(feed.version), sha512: createHash('sha512').update(bytes(feed.version)).digest('hex') })
    : new Response(new Uint8Array(bytes(/antigravity-cli\/([\d.]+)-/.exec(String(url))![1]!))))
}

/** A fake agent process that records what Mousse asks of it; `signedOut` makes `session/new` ask for a sign-in. */
function agentProcess(requests: string[], state: { signedOut: boolean }) {
  const abort = new AbortController()
  return {
    child: { exitCode: 0, signalCode: null, kill: vi.fn() },
    connection: {
      signal: abort.signal,
      close: vi.fn(() => abort.abort(new Error('ACP closed'))),
      agent: {
        request: vi.fn(async (method: string) => {
          requests.push(method)
          if (method === methods.agent.initialize) return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { resume: {} } }, agentInfo: { name: NATIVE_AGENT_NAME, version: '1.5.13' } }
          if ((method === methods.agent.session.new || method === methods.agent.session.resume) && state.signedOut) throw RequestError.authRequired()
          if (method === methods.agent.session.new || method === methods.agent.session.resume)
            return { sessionId: 'agent-session', configOptions: [{ id: 'model', type: 'select', options: [{ value: 'account-model', name: 'Account Model' }] }] }
          return { stopReason: 'end_turn' }
        }),
        notify: vi.fn(async () => undefined)
      }
    },
    onUpdate: undefined as ((update: unknown) => void) | undefined
  }
}

interface Setup {
  settings?: Record<string, unknown>
  /** A manual path: `agy`, or the 1.1.1 server beside its helper. */
  manual?: 'agy' | 'legacy'
  /** The user's own `agy`, and the version it reports. */
  userAgy?: string
  feed?: string
  home?: string
  signedOut?: boolean
  /** Use the gateway's lookup handed in by the driver, as in production. */
  gatewayLookup?: boolean
}

function setup(options: Setup = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'mousse-agy-runtime-'))
  if (!options.home) homes.push(home)
  const dir = join(home, 'providers', 'antigravity')
  mkdirSync(dir, { recursive: true })
  const settingsPath = join(dir, 'settings.json')
  if (options.settings) writeFileSync(settingsPath, JSON.stringify(options.settings))
  const own = join(home, 'own')
  mkdirSync(own, { recursive: true })
  const manualAgy = join(own, 'agy.exe')
  writeFileSync(manualAgy, 'manual agy')
  const manualLegacy = join(own, process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par')
  writeFileSync(manualLegacy, 'legacy')
  writeFileSync(join(own, process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external'), 'helper')
  const userAgy = join(home, 'user-bin', 'agy.exe')
  mkdirSync(join(home, 'user-bin'), { recursive: true })
  writeFileSync(userAgy, 'user agy')
  let launch: { binaryPath?: string } = options.manual === 'agy' ? { binaryPath: manualAgy } : options.manual === 'legacy' ? { binaryPath: manualLegacy } : {}
  const saveLaunch = vi.fn(async (patch: { binaryPath?: string | null }) => { if (patch.binaryPath === null) launch = {} })
  const requests: string[] = []
  const agent = { signedOut: options.signedOut ?? false }
  const feed = { version: options.feed ?? '1.5.13' }
  const fetchFile = google(feed)
  const versions = new CliVersionCache(async () => options.userAgy ?? '')
  const service = new AntigravityProviderService(home, home, new UserQuestionService(), versions, {
    launch: () => launch, saveLaunch,
    connect: () => agentProcess(requests, agent) as never,
    // Without one, no agy is found under test; the gateway's lookup runs only where a test opts in.
    ...(options.userAgy ? { findUserAgy: () => userAgy } : {}),
    ...(options.gatewayLookup ? { gatewayLookupUnderTest: true } : {}),
    native: {
      target: 'windows_amd64', fetch: fetchFile as unknown as typeof fetch,
      verify: async (binary) => ({ name: NATIVE_AGENT_NAME, version: readFileSync(binary, 'utf8').replace('agy ', '') })
    }
  })
  services.push(service)
  const saved = () => JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
  const driver = antigravityDriver({ builtIn: () => service })
  return { home, service, driver, saved, saveLaunch, requests, fetchFile, feed, agent, paths: { manualAgy, manualLegacy, userAgy } }
}

/** The driver's runtime for the instance, as the gateway creates it (its own `agy` lookup is the test's). */
const runtimeOf = (driver: ReturnType<typeof antigravityDriver>, find: () => string | undefined) =>
  driver.create({ findBinary: find } as unknown as DriverContext)

const turn = { threadId: 'thread', model: 'account-model', prompt: 'hello', onText: vi.fn() }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('which Antigravity runs', () => {
  // Every source that can be present, and the one that must run. The 1.1.1 server runs only from a
  // manual path, or from an earlier install until agy is installed.
  it.each([
    { name: 'a manual agy, over the user\'s own and Mousse\'s', setup: { manual: 'agy', userAgy: '1.5.13' }, managed: true, runs: 'manualAgy', kind: 'native' },
    { name: 'a manual 1.1.1 server', setup: { manual: 'legacy', userAgy: '1.5.13' }, managed: true, runs: 'manualLegacy', kind: 'legacy' },
    { name: 'the user\'s own agy, over Mousse\'s', setup: { userAgy: '1.5.13' }, managed: true, runs: 'userAgy', kind: 'native' },
    { name: 'Mousse\'s agy when the user\'s is older than 1.5.0', setup: { userAgy: '1.4.2' }, managed: true, runs: 'managed', kind: 'native' },
    { name: 'Mousse\'s agy when the user has none', setup: {}, managed: true, runs: 'managed', kind: 'native' },
    { name: 'an earlier 1.1.1 install before agy is installed', setup: {}, managed: false, legacy: true, runs: 'legacy', kind: 'legacy' }
  ] as const)('runs $name', async (row) => {
    const first = setup()
    if (row.managed) await first.service.install()
    const { service, paths, home } = setup({ ...row.setup, home: first.home })
    if ('legacy' in row) legacy.path = join(home, 'legacy', 'agy_acp_server.exe')
    // The version of the user's agy is read in the background, once.
    ;(await service.cliConfig())
    await flush()
    const resolved = (await service.cliConfig()).resolvedBinaryPath
    const expected = row.runs === 'managed' ? service.managedRuntime()?.path : row.runs === 'legacy' ? legacy.path : paths[row.runs]
    expect(resolved).toBe(expected)
    expect(resolved).toBeDefined()
    connectOnce(service)
    expect(spawned.calls.at(-1)?.args[0] === 'acp').toBe(row.kind === 'native')
  })

  it('offers the feed\'s release for Mousse\'s own copy and the user\'s agy, never for a manual path', async () => {
    const first = setup({ feed: '1.5.12' })
    await first.service.install()
    const managed = setup({ home: first.home, feed: '1.5.13' })
    expect(managed.driver.latestVersion).toBeUndefined()
    await flush()
    // The feed was read (once it was due) and names a newer release: Update reaches it.
    expect(managed.driver.latestVersion).toEqual({ kind: 'pinned', version: '1.5.13' })
    // The user's agy learns of it too (Update runs `agy update`), and nothing is downloaded over it.
    const user = setup({ home: first.home, userAgy: '1.5.12', feed: '1.5.13' })
    void user.driver.latestVersion
    await flush()
    expect(user.driver.latestVersion).toEqual({ kind: 'pinned', version: '1.5.13' })
    expect(user.fetchFile.mock.calls.filter(([url]) => String(url).endsWith('.exe'))).toHaveLength(0)
    expect(user.service.managedRuntime()).toBeUndefined()
    expect(user.driver.updateCommand?.('standalone')).toBe('agy update')
    expect(user.driver.updateCommand?.('unknown')).toBeUndefined()
    const manual = setup({ home: first.home, manual: 'agy', feed: '1.5.13' })
    void manual.driver.latestVersion
    await flush()
    expect(manual.driver.latestVersion).toBeUndefined()
    expect(manual.fetchFile).not.toHaveBeenCalled()
  })

  it('moves an earlier 1.1.1 install to agy: Update installs the feed\'s release, and threads hand their history over', async () => {
    const { service, home, saved } = setup({ settings: { signedIn: true, models: [{ id: 'account-model', label: 'Account Model' }], sessions: { thread: { sessionId: 'old', historyKey: 'k' } } } })
    legacy.path = join(home, 'legacy', 'agy_acp_server.exe')
    expect(service.managedRuntime()).toEqual({ path: legacy.path, version: '1.1.1' })
    await service.install()
    expect(service.managedRuntime()).toMatchObject({ version: '1.5.13' })
    // agy reads its own sign-in again; the 1.1.1 one is not carried over.
    expect(service.signedIn()).toBe(false)
    expect(await service.checkSignedIn(home)).toBe(true)
    await service.chat({ ...turn, cwd: home })
    expect(saved()).toMatchObject({ sessionsRuntime: 'native' })
  })

  it('updates Mousse\'s own copy on its own once the feed names a newer release and nothing runs', async () => {
    const first = setup({ feed: '1.5.12' })
    await first.service.install()
    const { service, driver, fetchFile } = setup({ home: first.home, feed: '1.5.13' })
    void driver.latestVersion
    await vi.waitFor(() => expect(service.managedRuntime()?.version).toBe('1.5.13'))
    expect(fetchFile.mock.calls.filter(([url]) => String(url).endsWith('.exe'))).toHaveLength(1)
  })

  it('waits while a turn runs', async () => {
    const first = setup({ feed: '1.5.12' })
    await first.service.install()
    const { service, driver, fetchFile } = setup({ home: first.home, feed: '1.5.13' })
    vi.spyOn((service as unknown as { acp: { busy(): boolean } }).acp, 'busy').mockReturnValue(true)
    void driver.latestVersion
    await vi.waitFor(() => expect(fetchFile).toHaveBeenCalled())
    await flush()
    expect(service.managedRuntime()?.version).toBe('1.5.12')
  })

  it('goes back to the last good release when Google\'s feed withdraws the installed one', async () => {
    const first = setup({ feed: '1.5.12' })
    await first.service.install()
    first.feed.version = '1.5.13'
    await first.service.install()
    expect(first.service.managedRuntime()?.version).toBe('1.5.13')
    const { service, driver } = setup({ home: first.home, feed: '1.5.12' })
    void driver.latestVersion
    await vi.waitFor(() => expect(service.managedRuntime()?.version).toBe('1.5.12'))
  })

  it('finds the user\'s agy the way the gateway does once the driver created the runtime', async () => {
    const { service, driver, paths } = setup({ gatewayLookup: true })
    runtimeOf(driver, () => paths.userAgy)
    expect((await service.cliConfig()).resolvedBinaryPath).toBe(paths.userAgy)
  })
})

describe('the shared agy sign-in', () => {
  it('shows Signed in after an explicit check when this computer\'s agy is signed in, without signing in', async () => {
    const { driver, requests, paths } = setup({ userAgy: '1.5.13' })
    const runtime = runtimeOf(driver, () => paths.userAgy)
    // A plain read never starts the agent.
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_out' })
    expect(requests).toEqual([])
    expect(await runtime.identity!(new AbortController().signal)).toBeUndefined()
    expect(requests).toEqual([])
    expect(await runtime.auth({ force: true })).toMatchObject({ state: 'signed_in' })
    expect(requests).toEqual([methods.agent.initialize, methods.agent.session.new])
  })

  it('stays signed out when agy asks for a sign-in, and starts no Google flow', async () => {
    const { driver, requests, paths } = setup({ userAgy: '1.5.13', signedOut: true })
    const runtime = runtimeOf(driver, () => paths.userAgy)
    expect(await runtime.auth({ force: true })).toMatchObject({ state: 'signed_out' })
    expect(requests).not.toContain(methods.agent.authenticate)
  })

  it('does not check on the 1.1.1 server, which keeps its own sign-in', async () => {
    const { driver, requests } = setup({ manual: 'legacy' })
    expect(await runtimeOf(driver, () => undefined).auth({ force: true })).toMatchObject({ state: 'signed_out' })
    expect(requests).toEqual([])
  })
})

/** Opens one agent connection through the real launch, with its process replaced. */
function connectOnce(service: AntigravityProviderService): void {
  const runtime = (service as unknown as { runtime(): { kind: 'native' | 'legacy'; binary: string; source: 'managed' } }).runtime()
  const dir = mkdtempSync(join(tmpdir(), 'mousse-agy-launch-'))
  homes.push(dir)
  antigravityConnectionFactory({ profileDir: dir, profileHome: dir, runtime: () => runtime, args: () => [], env: (base) => base })({ handlers: {} } as never)
}

describe('threads across the switch', () => {
  async function nativeHome() {
    const { home, service } = setup()
    await service.install()
    service.stop()
    return home
  }

  it('resumes a session agy opened', async () => {
    const home = await nativeHome()
    const first = setup({ home, settings: { nativeSignedIn: true, models: [{ id: 'account-model', label: 'Account Model' }] } })
    await first.service.chat({ ...turn, cwd: home })
    first.service.commitConversation('thread', '')
    first.service.stop()
    const second = setup({ home })
    await second.service.chat({ ...turn, cwd: home })
    expect(second.requests).toContain(methods.agent.session.resume)
    expect(second.requests).not.toContain(methods.agent.session.new)
  })

  it('starts a new session, with the thread\'s history, for a session the 1.1.1 server opened', async () => {
    const home = await nativeHome()
    const first = setup({ home, settings: { nativeSignedIn: true, models: [{ id: 'account-model', label: 'Account Model' }] } })
    await first.service.chat({ ...turn, cwd: home })
    first.service.commitConversation('thread', '')
    first.service.stop()
    // The same saved session, as the 1.1.1 server left it (no runtime recorded).
    const path = join(home, 'providers', 'antigravity', 'settings.json')
    const settings = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    delete settings.sessionsRuntime
    writeFileSync(path, JSON.stringify(settings))
    const second = setup({ home })
    await second.service.chat({ ...turn, cwd: home })
    expect(second.requests).toContain(methods.agent.session.new)
    expect(second.requests).not.toContain(methods.agent.session.resume)
    expect(second.saved()).toMatchObject({ sessionsRuntime: 'native' })
  })
})

describe('launching each runtime', () => {
  const start = (kind: 'legacy' | 'native', binary: string, profileDir: string) => {
    const connect = antigravityConnectionFactory({ profileDir, profileHome: profileDir, runtime: () => ({ kind, binary, source: 'managed' }), args: () => ['--user-flag'], env: (base) => base })
    connect({ handlers: {} } as never)
    return spawned.calls.at(-1)!
  }

  it('starts agy as `agy acp` on the profile\'s own folder, after the user\'s flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-agy-launch-'))
    homes.push(dir)
    const call = start('native', join(dir, 'agy.exe'), dir)
    expect(call.args).toEqual(['acp', '--gemini-dir', join(dir, 'gemini-home'), '--app-data-dir', 'antigravity-acp', '--user-flag'])
    // Settings only the 1.1.1 server reads are not passed on.
    expect(call.env.AGY_ACP_FORCE_FILE_STORAGE).toBeUndefined()
    expect(call.env.ANTIGRAVITY_HARNESS_PATH).toBeUndefined()
  })

  describe('a one-shot', () => {
    const HELP = 'Flags:\n  --cli_dir_name   Subdirectory under app_data_dir\n  --include-default-customizations  Include default customizations (default true)\n'
    /** A place's id (`oneShot/places.ts`). */
    const PLACE = '00000000-0000-4000-8000-0000000000a1'
    /**
     * A single request launched on `kind`, in a place's `work` folder made as the service makes it, with `agy acp --help`
     * printing `help`. The place's spawner (`spawnInPlace` in the service) is recorded like any start.
     */
    const launchOneShot = async (kind: 'legacy' | 'native', help = HELP, handlers: Record<string, unknown> = {}, extra: { privateHome?: string; onExit?: () => void } = {}) => {
      const dir = mkdtempSync(join(tmpdir(), 'mousse-agy-launch-'))
      homes.push(dir)
      const binary = join(dir, 'agy.exe')
      writeFileSync(binary, `agy ${help.length}`)
      spawned.help = help
      await readAgyAcpFlags(binary)
      const place = join(dir, 'one-shot', PLACE)
      const cwd = join(place, 'work')
      mkdirSync(cwd, { recursive: true })
      const spawnOneShot = vi.fn((folder: string, launch: { command: string; args: string[]; env: NodeJS.ProcessEnv }) =>
        spawn(launch.command, launch.args, { cwd: folder, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams)
      process.env.MOUSSE_TEST_USER_SECRET = 'kept out'
      try {
        const env = vi.fn((base: NodeJS.ProcessEnv) => ({ ...base, USER_VAR: '1' }))
        const privateHome = extra.privateHome ? join(dir, extra.privateHome) : undefined
        const connection = antigravityConnectionFactory({ profileDir: dir, profileHome: dir, ...(privateHome ? { privateHome } : {}), runtime: () => ({ kind, binary, source: 'user' }), args: () => ['--user-flag'], env, spawnOneShot })(
          { purpose: 'one_shot', cwd, handlers: { requestPermission: vi.fn(), ...handlers }, ...(extra.onExit ? { onExit: extra.onExit } : {}) } as never)
        return { dir, place, cwd, call: spawned.calls.at(-1)!, env, connection, spawnOneShot }
      } finally {
        delete process.env.MOUSSE_TEST_USER_SECRET
      }
    }

    it("starts agy in its place's folder on the place's empty home with its own settings, an allowlisted environment, and none of the user's flags, variables or skill links", async () => {
      const { dir, place, cwd, call, env, spawnOneShot } = await launchOneShot('native')
      const geminiHome = join(dir, 'gemini-home')
      const home = join(place, 'home')
      // Started by the place's spawner, in the place's `work` folder.
      expect(spawnOneShot).toHaveBeenCalledOnce()
      expect(call.cwd).toBe(cwd)
      // The home's hooks and MCP servers (`<gemini-dir>/config`) stay out; its app data (sign-in, sessions) is the entry's.
      expect(call.args).toEqual(['acp', '--gemini-dir', home, '--app-data-dir', join('..', '..', '..', 'gemini-home', 'antigravity-acp'), '--cli_dir_name', `one-shot-${PLACE}`, '--include-default-customizations=false'])
      // Its temporary folder is the place's too, removed with it.
      expect(call.env.TEMP ?? call.env.TMPDIR).toBe(join(place, 'tmp'))
      expect(readdirSync(home)).toEqual([])
      expect(env).not.toHaveBeenCalled()
      expect(call.env.MOUSSE_TEST_USER_SECRET).toBeUndefined()
      expect(call.env.USER_VAR).toBeUndefined()
      expect(call.env.GEMINI_HOME).toBe(home)
      expect(call.env.PATH ?? call.env.Path).toBeDefined()
      const settings = JSON.parse(readFileSync(join(geminiHome, 'antigravity-acp', `one-shot-${PLACE}`, 'settings.json'), 'utf8')) as Record<string, unknown>
      expect(settings).toMatchObject({ toolPermission: 'strict', allowNonWorkspaceAccess: false, agentMode: '', permissions: { deny: expect.arrayContaining(['command(*)', 'write_file(*)', 'read_file(*)', 'mcp(*)']) } })
      // The home's own settings and skill links are left as they are.
      expect(existsSync(join(geminiHome, 'antigravity-acp', 'settings.json'))).toBe(false)
      expect(existsSync(join(geminiHome, 'config', 'skills'))).toBe(false)
    })

    it('leaves out default customizations only where agy lists the flag, and refuses an agy that cannot keep its settings apart', async () => {
      const older = await launchOneShot('native', 'Flags:\n  --cli_dir_name   Subdirectory under app_data_dir\n')
      expect(older.call.args).not.toContain('--include-default-customizations=false')
      await expect(launchOneShot('native', 'Flags:\n  --gemini-dir  Path\n')).rejects.toMatchObject({ code: 'wont_run' })
    })

    it("starts an added entry's single request on its place's empty home, its sign-in still read from its own app data", async () => {
      const { place, call } = await launchOneShot('native', HELP, {}, { privateHome: join('entry', 'home') })
      expect(call.args.slice(0, 5)).toEqual(['acp', '--gemini-dir', join(place, 'home'), '--app-data-dir', join('..', '..', '..', 'entry', 'home', 'gemini-home', 'antigravity-acp')])
      expect(call.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe('1')
    })

    it('sees a tool the agent reports after it exits, and counts it ended only once its output has closed', async () => {
      const observe = vi.fn()
      const onExit = vi.fn()
      const { call } = await launchOneShot('native', HELP, { observe }, { onExit })
      call.child.emit('exit', 0, null)
      call.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write file' } } })}\n`)
      await vi.waitFor(() => expect(observe).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: 'tool_call' }) }) })))
      expect(onExit).not.toHaveBeenCalled()
      call.stdout.end()
      call.child.emit('close', 0, null)
      expect(onExit).toHaveBeenCalledTimes(1)
    })

    it("keeps the 1.1.1 server's ordinary launch, in its place", async () => {
      const { cwd, call } = await launchOneShot('legacy')
      expect(call.args).toContain('--user-flag')
      expect(call.cwd).toBe(cwd)
    })

    it('starts nothing outside a place', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mousse-agy-launch-'))
      homes.push(dir)
      const factory = antigravityConnectionFactory({ profileDir: dir, profileHome: dir, runtime: () => ({ kind: 'native', binary: join(dir, 'agy.exe'), source: 'user' }), args: () => [], env: (base) => base, spawnOneShot: vi.fn() })
      expect(() => factory({ purpose: 'one_shot', cwd: join(dir, 'one-shot', 'request-1'), handlers: {} } as never)).toThrow('place of its own')
      expect(spawned.calls).toHaveLength(0)
    })

    it('refuses a terminal or unknown request that arrives on the wire, and answers it as not found', async () => {
      const refuseRequest = vi.fn(async () => { throw new Error('This request runs no tools.') })
      const { call } = await launchOneShot('native', HELP, { refuseRequest })
      const answers: string[] = []
      call.stdin.on('data', (chunk: Buffer) => answers.push(chunk.toString()))
      call.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: '_google/run_workflow', params: {} })}\n`)
      call.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'terminal/create', params: { sessionId: 's', command: 'ls' } })}\n`)
      await vi.waitFor(() => expect(answers.join('')).toContain('"id":2'))
      expect(refuseRequest.mock.calls).toEqual([['_google/run_workflow'], ['terminal/create']])
      expect(answers.join('')).toContain('"id":1')
    })
  })

  it('takes the Google sign-in link agy prints on stderr, and no other link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-agy-launch-'))
    homes.push(dir)
    const link = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=s1&redirect_uri=http%3A%2F%2F127.0.0.1%3A41414%2F'
    const onAuthUrl = vi.fn()
    antigravityConnectionFactory({ profileDir: dir, profileHome: dir, runtime: () => ({ kind: 'native', binary: join(dir, 'agy.exe'), source: 'user' }), args: () => [], env: (base) => base })({ handlers: {}, onAuthUrl } as never)
    const { stderr } = spawned.calls.at(-1)!
    stderr.write('Open this link in a browser to log in with Google:\n')
    stderr.write(`  ${link}\n`)
    stderr.write('Docs: https://example.com/help\n')
    await flush()
    expect(onAuthUrl.mock.calls).toEqual([[link]])
  })

  it('starts an added entry on its own home, its sign-in kept there over the user\'s variables; the first entry\'s launch is unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-agy-launch-'))
    homes.push(dir)
    const agy = join(dir, 'agy.exe')
    writeFileSync(agy, 'agy')
    const stateDir = join(dir, 'harness', 'antigravity_antigravity-2')
    // Through the driver, as the gateway builds an added entry: its own service, on its own home.
    const runtime = antigravityDriver({ builtIn: () => { throw new Error('an added entry never runs on the first entry\'s service') } }).create({
      instanceId: 'antigravity:antigravity-2', builtIn: false, stateDir, profileHome: dir, installationHome: dir,
      config: { home: 'private', binaryPath: agy, env: { AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '' } },
      env: { home: join(stateDir, 'home') }, questions: new UserQuestionService(),
      findBinary: () => agy, changed: () => {}, signedOut: () => false, saveLaunch: async () => {}
    } as unknown as DriverContext)
    const session = new LoginSession('one')
    const signingIn = runtime.signIn!(session, dir)
    await vi.waitFor(() => expect(spawned.calls).toHaveLength(1))
    session.abort.abort()
    await signingIn
    await runtime.stop()
    const call = spawned.calls[0]!
    expect(call.args.slice(0, 3)).toEqual(['acp', '--gemini-dir', join(stateDir, 'home', 'gemini-home')])
    expect(call.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe('1')
    // The first entry keeps this computer's agy sign-in.
    expect(start('native', agy, dir).env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBeUndefined()
  })

  it('starts the 1.1.1 server as before', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-agy-launch-'))
    homes.push(dir)
    const call = start('legacy', join(dir, 'agy_acp_server.exe'), dir)
    expect(call.args).toEqual([...(process.platform === 'linux' ? ['--uid='] : []), '--user-flag'])
    expect(call.env.AGY_ACP_FORCE_FILE_STORAGE).toBe('1')
    expect(call.env.ANTIGRAVITY_HARNESS_PATH).toBe(join(dir, process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external'))
  })
})
