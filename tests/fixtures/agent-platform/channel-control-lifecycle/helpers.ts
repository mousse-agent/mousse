import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { lstatSync, mkdtempSync, realpathSync, rmSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { ChannelAuth } from '../../../../src/mms/channels/ChannelAuth'
import { ChannelRouter, type ChannelTurnRunner } from '../../../../src/mms/channels/ChannelRouter'
import { ChannelService } from '../../../../src/mms/channels/ChannelService'
import { ChannelSessionManager } from '../../../../src/mms/channels/ChannelSessionManager'
import { ChannelStore } from '../../../../src/mms/channels/ChannelStore'
import type { ChannelAdapter, InboundChannelMessage, OutboundChannelMessage, SendResult } from '../../../../src/mms/channels/types'
import { MousseConfigStore } from '../../../../src/mms/config/MousseConfigStore'
import { MmsControlService } from '../../../../src/mms/control/MmsControlService'
import type { RemoteMethodExecutionHandler } from '../../../../src/mms/control/relay/remoteDispatcher'
import { ProjectManager } from '../../../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../../../src/mms/data/ThreadDataStore'
import type { OrchestratorService } from '../../../../src/mms/orchestrator/OrchestratorService'
import type { ProviderAuthService } from '../../../../src/mms/providers/ProviderAuthService'
import { SettingsStore } from '../../../../src/mms/settings/SettingsStore'
import type { ChannelPlatform } from '../../../../src/shared/types'

export const FIXTURE_PREFIX = 'mousse-channel-control-lifecycle-'

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export function createOwnedHome(): string {
  return mkdtempSync(join(tmpdir(), FIXTURE_PREFIX))
}

function isReparsePoint(stat: Stats): boolean {
  if (stat.isSymbolicLink()) return true
  const windowsAttrs = (stat as Stats & { reparsePoint?: boolean }).reparsePoint
  return Boolean(windowsAttrs)
}

export function removeOwnedHome(root: string): void {
  const tmp = realpathSync(tmpdir())
  const resolved = realpathSync(root)
  const rel = relative(tmp, resolved)
  if (isAbsolute(rel) || !rel.startsWith(FIXTURE_PREFIX) || rel.split(/[\\/]/).some((part) => part === '..')) {
    throw new Error(`Unexpected fixture root: ${root}`)
  }
  if (isReparsePoint(lstatSync(root))) {
    throw new Error(`Fixture root is a reparse point: ${root}`)
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}

export class FixtureAdapter implements ChannelAdapter {
  inboundHandler: ((message: InboundChannelMessage) => void) | null = null
  sent: OutboundChannelMessage[] = []
  typingCalls = 0
  connectSignal?: AbortSignal
  connected = false
  connectHold?: Promise<void>
  disconnectHold?: Promise<void>
  sendHold?: Promise<void>
  typingHold?: Promise<void>
  ignoreConnectAbort = false
  disconnectCalls = 0

  constructor(readonly platform: ChannelPlatform = 'telegram') {}

  setInboundHandler(handler: (message: InboundChannelMessage) => void): void {
    this.inboundHandler = handler
  }

  getStatus() {
    return {
      platform: this.platform,
      state: this.connected ? ('connected' as const) : ('disconnected' as const)
    }
  }

  async connect(signal?: AbortSignal): Promise<void> {
    this.connectSignal = signal
    if (this.connectHold) {
      if (this.ignoreConnectAbort) await this.connectHold
      else {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
          if (signal?.aborted) {
            onAbort()
            return
          }
          signal?.addEventListener('abort', onAbort, { once: true })
          this.connectHold!.then(
            () => {
              signal?.removeEventListener('abort', onAbort)
              resolve()
            },
            (error) => {
              signal?.removeEventListener('abort', onAbort)
              reject(error)
            }
          )
        })
      }
    } else if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1
    if (this.disconnectHold) await this.disconnectHold
    this.connected = false
  }

  async send(message: OutboundChannelMessage): Promise<SendResult> {
    if (this.sendHold) await this.sendHold
    this.sent.push(message)
    return { success: true, messageId: String(this.sent.length) }
  }

  async sendTyping(): Promise<void> {
    this.typingCalls += 1
    if (this.typingHold) await this.typingHold
  }
}

export function inbound(
  text: string,
  extra: Partial<InboundChannelMessage> = {}
): InboundChannelMessage {
  return {
    platform: 'telegram',
    chatId: '42',
    chatType: 'dm',
    userId: 'user-1',
    userName: 'fixture',
    text,
    ...extra
  }
}

export function createChannelWorld(home: string, adapter: ChannelAdapter = new FixtureAdapter()) {
  const configStore = MousseConfigStore.load(home)
  const store = new ChannelStore(configStore, { inheritEnvironment: false, environment: {} })
  store.updateConfig({
    platforms: {
      telegram: { enabled: adapter.platform === 'telegram', allowAllUsers: true },
      discord: { enabled: adapter.platform === 'discord', allowAllUsers: true },
      webhook: { enabled: adapter.platform === 'webhook', webhookPort: 0, allowAllUsers: true }
    }
  })
  const projects = new ProjectManager(home)
  const threads = new ThreadDataStore(projects, home)
  projects.setThreadStore(threads)
  const sessionManager = new ChannelSessionManager(store, threads)
  const settings = new SettingsStore(configStore)
  return { configStore, store, projects, threads, sessionManager, settings, adapter }
}

export function createRouter(
  home: string,
  runner: ChannelTurnRunner,
  adapter: ChannelAdapter = new FixtureAdapter()
) {
  const world = createChannelWorld(home, adapter)
  const router = new ChannelRouter(
    world.store,
    world.sessionManager,
    new ChannelAuth(world.store.getPairingDirectory()),
    runner,
    () => adapter,
    () => world.store.getConfig(),
    {
      settingsStore: world.settings,
      threadStore: world.threads,
      listModels: () => []
    }
  )
  return { ...world, router }
}

export function createChannelService(
  home: string,
  runner: ChannelTurnRunner,
  adapter: ChannelAdapter = new FixtureAdapter()
) {
  const world = createChannelWorld(home, adapter)
  const orchestrator = {
    runChannelTurn: (threadId: string, text: string, _store: unknown, opts?: Parameters<ChannelTurnRunner['runChannelTurn']>[2]) =>
      runner.runChannelTurn(threadId, text, opts),
    abortChannelTurn: () => true,
    steerChannelTurn: () => true,
    isChannelTurnActive: () => false
  } as unknown as OrchestratorService
  const providerAuth = {
    getConfiguredLlmProviders: () => [],
    getSubscriptionUsage: async () => undefined
  } as unknown as ProviderAuthService
  const service = new ChannelService(
    orchestrator,
    world.threads,
    world.store,
    world.settings,
    providerAuth,
    undefined,
    {
      createAdapter: () => adapter
    }
  )
  return { ...world, service }
}

export function createControlService(
  home: string,
  executor?: RemoteMethodExecutionHandler
): MmsControlService {
  return new MmsControlService({
    homeDir: home,
    instanceId: `fixture-${home.slice(-8)}`,
    executor: executor ?? { execute: async () => ({ ok: true }) }
  })
}

export function heldTurnRunner(
  entered: { resolve: () => void },
  release: { promise: Promise<void> },
  afterRelease?: (text: string) => void
): ChannelTurnRunner {
  return {
    runChannelTurn: async (_threadId, text) => {
      entered.resolve()
      await release.promise
      afterRelease?.(text)
      return { text: `reply:${text}`, silent: false }
    }
  }
}

export function listenLocal(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  const server = createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind local fixture server'))
        return
      }
      resolve({
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()))
          })
      })
    })
  })
}
