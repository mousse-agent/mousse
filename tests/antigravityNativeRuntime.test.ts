import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { AntigravityProviderService } from '../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { antigravityConnectionFactory } from '../src/mms/harness/acp/presets/antigravity'
import { antigravityDriver } from '../src/mms/harness/drivers/antigravity'
import { installAntigravity } from '../src/mms/harness/acp/presets/antigravity/installation'
import { NATIVE_AGENT_NAME, type NativeRelease } from '../src/mms/harness/acp/presets/antigravity/nativeRelease'

// The 1.1.1 download is never reached from here; the native install runs for real on a temporary folder.
vi.mock('../src/mms/harness/acp/presets/antigravity/installation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mms/harness/acp/presets/antigravity/installation')>()),
  installAntigravity: vi.fn(async () => 'agy_acp_server')
}))

// Only the agent process is replaced, to read what Mousse starts it with.
const spawned = vi.hoisted(() => ({ calls: [] as Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: vi.fn((file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawned.calls.push({ file, args, env: options.env })
      return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: vi.fn() })
    }),
    spawnSync: vi.fn((_file: string, args: string[]) => ({ status: 0, stdout: '', stderr: `__MOUSSE_ANTIGRAVITY_AUTH_URL__${args[0]}\n` }))
  }
})

const homes: string[] = []
const services: AntigravityProviderService[] = []
beforeEach(() => { spawned.calls.length = 0 })
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  vi.mocked(installAntigravity).mockClear()
})

const payload = Buffer.from('native agy bytes')
const release: NativeRelease = {
  version: '1.5.12', format: 'exe', size: payload.length, executableSize: payload.length,
  url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.12-1/windows-x64/cli_windows_x64.exe',
  sha512: createHash('sha512').update(payload).digest('hex')
}
/** Google's download of the release, and its feed entry for this computer. */
function google(feedVersion = '1.5.12') {
  return vi.fn(async (url: string | URL | Request) => String(url).endsWith('.json')
    ? Response.json({ version: feedVersion, url: release.url.replace('1.5.12', feedVersion), sha512: feedVersion === '1.5.12' ? release.sha512 : 'c'.repeat(128) })
    : new Response(new Uint8Array(payload)))
}

/** A fake agent process that records what Mousse asks of it. */
function agentProcess(requests: string[]) {
  const abort = new AbortController()
  return {
    child: { exitCode: 0, signalCode: null, kill: vi.fn() },
    connection: {
      signal: abort.signal,
      close: vi.fn(() => abort.abort(new Error('ACP closed'))),
      agent: {
        request: vi.fn(async (method: string) => {
          requests.push(method)
          if (method === methods.agent.initialize) return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { resume: {} } }, agentInfo: { name: NATIVE_AGENT_NAME, version: '1.5.12' } }
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

function setup(options: { settings?: Record<string, unknown>; manual?: boolean; qualified?: boolean; feed?: string; home?: string } = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'mousse-agy-runtime-'))
  if (!options.home) homes.push(home)
  const dir = join(home, 'providers', 'antigravity')
  mkdirSync(dir, { recursive: true })
  const settingsPath = join(dir, 'settings.json')
  if (options.settings) writeFileSync(settingsPath, JSON.stringify(options.settings))
  // The user's own 1.1.1 server: the agent beside its helper.
  const manualDir = join(home, 'manual')
  mkdirSync(manualDir, { recursive: true })
  const manualAgent = join(manualDir, process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par')
  writeFileSync(manualAgent, 'legacy')
  writeFileSync(join(manualDir, process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external'), 'helper')
  let launch: { binaryPath?: string } = options.manual ? { binaryPath: manualAgent } : {}
  const saveLaunch = vi.fn(async (patch: { binaryPath?: string | null }) => { if (patch.binaryPath === null) launch = {} })
  const requests: string[] = []
  const fetchFile = google(options.feed)
  const service = new AntigravityProviderService(home, home, new UserQuestionService(), undefined, {
    launch: () => launch, saveLaunch,
    connect: () => agentProcess(requests) as never,
    native: {
      qualified: () => options.qualified ?? true, target: 'windows_amd64', release, fetch: fetchFile as unknown as typeof fetch,
      verify: async () => ({ name: NATIVE_AGENT_NAME, version: '1.5.12' })
    }
  })
  services.push(service)
  const saved = () => JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
  return { home, service, saved, saveLaunch, requests, fetchFile, manualAgent }
}

const turn = { threadId: 'thread', model: 'account-model', prompt: 'hello', onText: vi.fn() }

describe('which Antigravity runs', () => {
  it('stays on the 1.1.1 server where the native CLI has not qualified', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-agy-runtime-'))
    homes.push(home)
    // No seam: the shipped qualification table decides for this computer.
    const service = new AntigravityProviderService(home, home, new UserQuestionService())
    services.push(service)
    expect(service.pinnedVersion()).toBe('1.1.1')
    await service.install()
    expect(installAntigravity).toHaveBeenCalledTimes(1)
    expect(existsSync(join(home, 'providers', 'antigravity', 'native'))).toBe(false)
  })

  it('offers Update to the reviewed native release, then asks for a new sign-in on it', async () => {
    const { service, saved, saveLaunch, manualAgent } = setup({ manual: true, settings: { signedIn: true, models: [{ id: 'account-model', label: 'Account Model' }] } })
    expect(service.managedRuntime()).toBeUndefined()
    expect(service.signedIn()).toBe(true)
    expect(service.pinnedVersion()).toBe('1.5.12')
    await service.install()
    expect(installAntigravity).not.toHaveBeenCalled()
    expect(saveLaunch).toHaveBeenCalledWith({ binaryPath: null })
    expect(service.managedRuntime()).toMatchObject({ version: '1.5.12' })
    expect((await service.cliConfig()).version).toBe('1.5.12')
    // The 1.1.1 sign-in is not carried over: the native CLI keeps its own, so the card asks again.
    expect(service.signedIn()).toBe(false)
    expect(service.configured()).toBe(false)
    expect(saved()).toMatchObject({ signedIn: true })
    // The user's own 1.1.1 server is left as it was.
    expect(readFileSync(manualAgent, 'utf8')).toBe('legacy')
  })

  it('makes the reviewed native release the version Update reaches, only where it qualifies', () => {
    const qualified = setup({ manual: true })
    expect(antigravityDriver({ builtIn: () => qualified.service }).latestVersion).toEqual({ kind: 'pinned', version: '1.5.12' })
    const closed = setup({ manual: true, qualified: false })
    expect(antigravityDriver({ builtIn: () => closed.service }).latestVersion).toEqual({ kind: 'pinned', version: '1.1.1' })
    expect(closed.fetchFile).not.toHaveBeenCalled()
  })

  it('keeps a manual 1.1.1 path running the 1.1.1 server even with the native CLI installed', async () => {
    const first = setup()
    await first.service.install()
    const { service, manualAgent } = setup({ home: first.home, manual: true })
    expect((await service.cliConfig()).resolvedBinaryPath).toBe(manualAgent)
  })

  it('does not install or offer a release Google withdrew', async () => {
    const { service } = setup({ feed: '1.5.11' })
    await expect(service.install()).rejects.toThrow(/withdrew/)
    expect(service.managedRuntime()).toBeUndefined()
    expect(service.pinnedVersion()).toBe('1.1.1')
  })
})

describe('threads across the switch', () => {
  async function nativeHome() {
    const { home, service } = setup()
    await service.install()
    service.stop()
    return home
  }

  it('resumes a session the native CLI opened', async () => {
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
    const connect = antigravityConnectionFactory({ profileDir, profileHome: profileDir, runtime: () => ({ kind, binary }), args: () => ['--user-flag'], env: (base) => base })
    connect({ handlers: {} } as never)
    return spawned.calls.at(-1)!
  }

  it('starts the native CLI as `agy acp` on the profile\'s own folder, after the user\'s flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-agy-launch-'))
    homes.push(dir)
    const call = start('native', join(dir, 'agy.exe'), dir)
    expect(call.args).toEqual(['acp', '--gemini-dir', join(dir, 'gemini-home'), '--app-data-dir', 'antigravity-acp', '--user-flag'])
    // Settings only the 1.1.1 server reads are not passed on.
    expect(call.env.AGY_ACP_FORCE_FILE_STORAGE).toBeUndefined()
    expect(call.env.ANTIGRAVITY_HARNESS_PATH).toBeUndefined()
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
