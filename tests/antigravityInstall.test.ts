import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { AntigravityProviderService } from '../src/mms/providers/antigravity/AntigravityProviderService'
import { installAntigravity } from '../src/mms/providers/antigravity/installation'

const fake = vi.hoisted(() => ({ spawnLine: undefined as string | undefined, stdouts: [] as Array<{ write(line: string): void }> }))

vi.mock('../src/mms/providers/antigravity/installation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mms/providers/antigravity/installation')>()),
  installAntigravity: vi.fn()
}))

// The agent process is the only boundary replaced: `launch()` itself runs as in production.
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        exitCode: null, signalCode: null, kill: vi.fn()
      })
      fake.stdouts.push(child.stdout)
      const line = fake.spawnLine
      if (line) setTimeout(() => child.stdout.write(line), 0)
      return child
    }),
    spawnSync: vi.fn((_file: string, args: string[]) => ({
      status: 0, stdout: '', stderr: `__MOUSSE_ANTIGRAVITY_AUTH_URL__${args[0]}\n`
    }))
  }
})

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=owned-state&redirect_uri=http%3A%2F%2F127.0.0.1%3A41414%2F'
const installMock = vi.mocked(installAntigravity)
const homes: string[] = []
const services: AntigravityProviderService[] = []

beforeEach(() => { fake.spawnLine = undefined; fake.stdouts.length = 0 })
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  installMock.mockReset()
  vi.restoreAllMocks()
})

function setup(settings: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-agy-install-'))
  homes.push(home)
  mkdirSync(join(home, 'providers', 'antigravity'), { recursive: true })
  const settingsPath = join(home, 'providers', 'antigravity', 'settings.json')
  writeFileSync(settingsPath, JSON.stringify(settings))
  const service = new AntigravityProviderService(home, home, new UserQuestionService())
  services.push(service)
  const saved = () => JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
  return { home, service, saved }
}

/** An install that stays pending until it is aborted. */
function pendingInstall() {
  installMock.mockImplementation((_home, signal) => new Promise<string>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true })
  }))
}

describe('Antigravity install', () => {
  it('installs, streams progress, replaces a manual path and leaves sign-in alone', async () => {
    const { home, service, saved } = setup({ binaryPath: join('manual', 'agy_acp_server'), signedIn: true, models: [{ id: 'm', label: 'M' }] })
    installMock.mockImplementation(async (_home, _signal, progress) => {
      progress?.('Downloading Google Antigravity ACP agent…')
      progress?.('Verifying agent and local harness…')
      return join(home, 'agy_acp_server')
    })
    const messages: string[] = []
    const changed = vi.fn()
    service.hooks.changed = changed
    const generation = (service as unknown as { launchGeneration: number }).launchGeneration
    const config = await service.install((message) => messages.push(message))
    expect(installMock).toHaveBeenCalledWith(home, expect.any(AbortSignal), expect.any(Function))
    expect(messages).toEqual(['Downloading Google Antigravity ACP agent…', 'Verifying agent and local harness…'])
    expect(changed).toHaveBeenCalledTimes(1)
    expect(config).toMatchObject({ instanceId: 'antigravity', args: [], env: {} })
    expect(config.binaryPath).toBeUndefined()
    expect(saved().binaryPath).toBeUndefined()
    expect(saved()).toMatchObject({ signedIn: true, models: [{ id: 'm', label: 'M' }] })
    expect((service as unknown as { launchGeneration: number }).launchGeneration).toBe(generation + 1)
  })

  it('does not start a sign-in after installing', async () => {
    const { service } = setup()
    installMock.mockResolvedValue('agy')
    const login = vi.spyOn(service, 'login')
    await service.install()
    expect(login).not.toHaveBeenCalled()
    expect(service.configured()).toBe(false)
  })

  it('surfaces a failed download without clearing the manual path', async () => {
    const { service, saved } = setup({ binaryPath: 'kept' })
    installMock.mockRejectedValue(new Error('Google download failed (503)'))
    await expect(service.install()).rejects.toThrow('Google download failed (503)')
    expect(saved().binaryPath).toBe('kept')
  })

  it('leaves the settings alone when a cancel lands after the download finished', async () => {
    const { service, saved } = setup({ binaryPath: 'kept', signedIn: true })
    installMock.mockImplementation(async () => { service.stop(); return 'agy' })
    await expect(service.install()).rejects.toThrow('Antigravity install cancelled')
    expect(saved()).toEqual({ binaryPath: 'kept', signedIn: true })
  })

  it('rejects a duplicate on the same service without orphaning the running install', async () => {
    const { service } = setup()
    pendingInstall()
    const running = service.install()
    const rejected = expect(running).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    await expect(service.install()).rejects.toThrow('already being installed')
    expect(installMock).toHaveBeenCalledTimes(1)
    service.stop() // still reaches the first install
    await rejected
  })

  it('aborts a running install when the provider stops', async () => {
    const { service } = setup()
    pendingInstall()
    const running = service.install()
    const rejected = expect(running).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    service.stop()
    await rejected
  })
})

describe('Antigravity sign-in state', () => {
  const signedIn = { signedIn: true, models: [{ id: 'm', label: 'M' }] }

  function installedService(settings: Record<string, unknown> = signedIn) {
    const context = setup(settings)
    vi.spyOn(context.service as unknown as { binary: () => string }, 'binary').mockReturnValue(join(context.home, 'agy_acp_server'))
    const changed = vi.fn()
    context.service.hooks.changed = changed
    return { ...context, changed }
  }
  const askForSignIn = () => { fake.spawnLine = `Open the following link to authenticate the ACP server: ${authUrl}\n` }

  it('marks the provider signed out, tells clients and keeps the chat error when a chat is asked to sign in', async () => {
    const { service, home, saved, changed } = installedService()
    expect(service.configured()).toBe(true)
    askForSignIn()
    await expect(service.chat({ threadId: 't', cwd: home, model: 'm', prompt: 'hi', onText: () => undefined }))
      .rejects.toThrow('Sign in to Antigravity in Settings before chatting')
    expect(saved()).toMatchObject({ signedIn: false, models: [] })
    expect(service.configured()).toBe(false)
    expect(service.llmProvider()).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('marks the provider signed out and tells clients when a model refresh hits the sign-in request', async () => {
    const { service, home, saved, changed } = installedService()
    askForSignIn()
    await expect(service.refreshModels(home)).rejects.toThrow('Sign in to Antigravity in Settings before chatting')
    expect(saved()).toMatchObject({ signedIn: false, models: [] })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('ignores a late sign-in request from a process that started before the latest sign-in', async () => {
    const { service, home, saved, changed } = installedService()
    const chat = service.chat({ threadId: 't', cwd: home, model: 'm', prompt: 'hi', onText: () => undefined })
    const rejected = expect(chat).rejects.toThrow('Sign in to Antigravity in Settings before chatting')
    await vi.waitFor(() => expect(fake.stdouts).toHaveLength(1))
    ;(service as unknown as { signInGeneration: number }).signInGeneration += 1 // a login finished meanwhile
    fake.stdouts[0].write(`Open the following link to authenticate the ACP server: ${authUrl}\n`)
    await rejected
    expect(saved()).toMatchObject(signedIn)
    expect(service.configured()).toBe(true)
    expect(changed).not.toHaveBeenCalled()
  })

  it('signs out locally and tells clients even when Google has already revoked the session', async () => {
    const { service, saved, changed } = installedService()
    askForSignIn() // the agent answers the logout launch by asking to sign in again
    await expect(service.logout()).resolves.toBeUndefined()
    expect(saved()).toMatchObject({ signedIn: false, models: [], sessions: {} })
    expect(service.configured()).toBe(false)
    expect(changed).toHaveBeenCalled()
  })

  it('reports its own sign-in state in the config, independent of the provider being switched on', async () => {
    expect(await installedService().service.cliConfig()).toMatchObject({ signedIn: true })
    expect(await installedService({}).service.cliConfig()).toMatchObject({ signedIn: false })
  })
})
