import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { AntigravityProviderService } from '../src/mms/providers/antigravity/AntigravityProviderService'
import { installAntigravity } from '../src/mms/providers/antigravity/installation'

const fake = vi.hoisted(() => ({ spawnLine: undefined as string | undefined }))

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

beforeEach(() => { fake.spawnLine = undefined })
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

/** An install that stays pending until it is aborted or released. */
function pendingInstall() {
  let release!: (path: string) => void
  installMock.mockImplementation((_home, signal) => new Promise<string>((resolve, reject) => {
    release = resolve
    signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true })
  }))
  return { release: (path = 'agy') => release(path) }
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
    const generation = (service as unknown as { launchGeneration: number }).launchGeneration
    const config = await service.install((message) => messages.push(message))
    expect(installMock).toHaveBeenCalledWith(home, expect.any(AbortSignal), expect.any(Function))
    expect(messages).toEqual(['Downloading Google Antigravity ACP agent…', 'Verifying agent and local harness…'])
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

  it('cancels a running install, keeps the settings and allows a new install', async () => {
    const { service, saved } = setup({ binaryPath: 'kept' })
    pendingInstall()
    const running = service.install()
    const rejected = expect(running).rejects.toThrow('Antigravity install cancelled')
    await vi.waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    expect(service.cancelInstall()).toBe(true)
    await rejected
    expect(saved().binaryPath).toBe('kept')
    expect(service.cancelInstall()).toBe(false)
    installMock.mockResolvedValue('agy')
    await expect(service.install()).resolves.toMatchObject({ instanceId: 'antigravity' })
  })

  it('rejects a second install while one is running', async () => {
    const { service } = setup()
    const first = pendingInstall()
    const running = service.install()
    await vi.waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
    await expect(service.install()).rejects.toThrow('already being installed')
    expect(installMock).toHaveBeenCalledTimes(1)
    first.release()
    await expect(running).resolves.toMatchObject({ instanceId: 'antigravity' })
  })

  it('surfaces a failed download without clearing the manual path', async () => {
    const { service, saved } = setup({ binaryPath: 'kept' })
    installMock.mockRejectedValue(new Error('Google download failed (503)'))
    await expect(service.install()).rejects.toThrow('Google download failed (503)')
    expect(saved().binaryPath).toBe('kept')
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

describe('Antigravity install requests', () => {
  it('streams progress as install events, announces the provider change and cancels through the daemon', async () => {
    const { service } = setup()
    installMock.mockImplementation(async (_home, _signal, progress) => { progress?.('Downloading Google Antigravity ACP agent…'); return 'agy' })
    const emitEvent = vi.fn()
    const providers = [{ id: 'antigravity' }]
    const context = {
      mms: { antigravity: service, providerInstances: { configuredProviders: () => providers } },
      globalSequence: () => 0,
      emitEvent
    } as unknown as HandlerContext
    const result = await dispatchMethod(context, 'providers.installAntigravity', {}) as { config: { instanceId: string }; providers: unknown[] }
    expect(result).toMatchObject({ config: { instanceId: 'antigravity' }, providers })
    expect(emitEvent.mock.calls).toEqual([
      ['providers.install-event', { event: { instanceId: 'antigravity', type: 'progress', message: 'Downloading Google Antigravity ACP agent…' } }],
      ['providers.changed', { providers }]
    ])
    expect(await dispatchMethod(context, 'providers.cancelAntigravityInstall', {})).toEqual({ cancelled: false })
    pendingInstall()
    const running = dispatchMethod(context, 'providers.installAntigravity', {})
    const rejected = expect(running).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(installMock).toHaveBeenCalledTimes(2))
    expect(await dispatchMethod(context, 'providers.cancelAntigravityInstall', {})).toEqual({ cancelled: true })
    await rejected
  })
})

describe('Antigravity asks for Google sign-in outside Settings', () => {
  const signedIn = { signedIn: true, models: [{ id: 'm', label: 'M' }] }

  function installedService() {
    const context = setup(signedIn)
    vi.spyOn(context.service as unknown as { binary: () => string }, 'binary').mockReturnValue(join(context.home, 'agy_acp_server'))
    expect(context.service.configured()).toBe(true)
    fake.spawnLine = `Open the following link to authenticate the ACP server: ${authUrl}\n`
    return context
  }

  it('marks the provider signed out and keeps the chat error', async () => {
    const { service, home, saved } = installedService()
    await expect(service.chat({ threadId: 't', cwd: home, model: 'm', prompt: 'hi', onText: () => undefined }))
      .rejects.toThrow('Sign in to Antigravity in Settings before chatting')
    expect(saved()).toMatchObject({ signedIn: false, models: [] })
    expect(service.configured()).toBe(false)
    expect(service.llmProvider()).toBeUndefined()
  })

  it('marks the provider signed out when a model refresh hits the sign-in request', async () => {
    const { service, home, saved } = installedService()
    await expect(service.refreshModels(home)).rejects.toThrow('Sign in to Antigravity in Settings before chatting')
    expect(saved()).toMatchObject({ signedIn: false, models: [] })
  })
})
