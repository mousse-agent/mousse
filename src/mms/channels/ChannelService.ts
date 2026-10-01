import { EventEmitter } from 'events'
import type {
  ChannelActivityEvent,
  ChannelConfig,
  ChannelPlatform,
  ChannelsSnapshot,
  ChannelStatus,
  PairingRequest
} from '../../shared/types'
import type { OrchestratorService } from '../orchestrator/OrchestratorService'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import type { SettingsStore } from '../settings/SettingsStore'
import type { ProviderAuthService } from '../providers/ProviderAuthService'
import type { AgentRegistry } from '../agents/AgentRegistry'
import { OwnedWorkBarrier } from '../execution/OwnedWorkBarrier'
import { ChannelAuth } from './ChannelAuth'
import { ChannelRouter } from './ChannelRouter'
import { ChannelSessionManager } from './ChannelSessionManager'
import { ChannelStore, redactConfigForRenderer } from './ChannelStore'
import { DiscordAdapter } from './adapters/DiscordAdapter'
import { TelegramAdapter } from './adapters/TelegramAdapter'
import { WebhookAdapter } from './adapters/WebhookAdapter'
import type { ChannelAdapter } from './types'

export type ChannelAdapterFactory = (
  platform: ChannelPlatform,
  platformConfig: ChannelConfig['platforms'][ChannelPlatform]
) => ChannelAdapter

export interface ChannelServiceOptions {
  createAdapter?: ChannelAdapterFactory
}

function createDefaultAdapter(
  platform: ChannelPlatform,
  platformConfig: ChannelConfig['platforms'][ChannelPlatform]
): ChannelAdapter {
  switch (platform) {
    case 'telegram':
      return new TelegramAdapter(platformConfig)
    case 'discord':
      return new DiscordAdapter(platformConfig)
    case 'webhook':
      return new WebhookAdapter(platformConfig)
    default:
      throw new Error(`Unknown platform: ${platform}`)
  }
}

function isProfileDraining(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'profile_draining')
}

export class ChannelService extends EventEmitter {
  private auth: ChannelAuth
  private sessionManager: ChannelSessionManager
  private router: ChannelRouter
  private adapters = new Map<ChannelPlatform, ChannelAdapter>()
  /** Last connect failure per platform, surfaced as an `error` status until the next attempt. */
  private connectErrors = new Map<ChannelPlatform, string>()
  private readonly lifecycle = new OwnedWorkBarrier()
  private readonly createAdapter: ChannelAdapterFactory
  private disconnecting: Promise<void> | null = null
  private readonly draining = new Set<Promise<unknown>>()

  constructor(
    private orchestrator: OrchestratorService,
    private threadStore: ThreadDataStore,
    private store: ChannelStore,
    private settingsStore: SettingsStore,
    private providerAuth: ProviderAuthService,
    private agentRegistry?: AgentRegistry,
    options?: ChannelServiceOptions
  ) {
    super()
    this.createAdapter = options?.createAdapter ?? createDefaultAdapter
    this.auth = new ChannelAuth(this.store.getPairingDirectory())
    this.sessionManager = new ChannelSessionManager(this.store, threadStore)
    this.router = new ChannelRouter(
      this.store,
      this.sessionManager,
      this.auth,
      {
        runChannelTurn: (threadId, text, opts) =>
          orchestrator.runChannelTurn(threadId, text, threadStore, opts),
        abortChannelTurn: (threadId) => orchestrator.abortChannelTurn(threadId),
        steerChannelTurn: (threadId, text) => orchestrator.steerChannelTurn(threadId, text),
        isChannelTurnActive: (threadId) => orchestrator.isChannelTurnActive(threadId)
      },
      (platform) => this.adapters.get(platform),
      () => this.store.getConfig(),
      {
        settingsStore: this.settingsStore,
        threadStore: this.threadStore,
        listModels: () => this.providerAuth.getConfiguredLlmProviders(),
        getSubscriptionUsage: (providerId) => this.providerAuth.getSubscriptionUsage(providerId),
        listAgents: this.agentRegistry
          ? () =>
              this.agentRegistry!.list().map((agent) => ({
                id: agent.id,
                status: agent.status,
                task: agent.task
              }))
          : undefined
      }
    )
    this.router.on('activity', (event: ChannelActivityEvent) => {
      this.emit('activity', event)
    })
    this.router.on('pairing-updated', () => {
      this.emitUpdated()
    })
  }

  beginShutdown(): void {
    this.lifecycle.beginShutdown()
    this.router.beginShutdown()
    this.trackDrain(this.disconnectAdapters())
  }

  getActiveCount(): number {
    return this.lifecycle.count + this.router.getActiveCount() + this.draining.size +
      (this.lifecycle.stopping ? this.adapters.size : 0)
  }

  async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    this.beginShutdown()
    const timeoutMs = options?.timeoutMs ?? 30_000
    const results = await Promise.allSettled([
      this.awaitDrain(timeoutMs),
      this.lifecycle.waitForIdle(timeoutMs),
      this.router.shutdown({ timeoutMs })
    ])
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected) throw rejected.reason
  }

  getSnapshot(): ChannelsSnapshot {
    const config = redactConfigForRenderer(this.store.getConfig())
    const sessions = this.store.listSessions()
    const statuses = this.getStatuses()
    // Rebuilding is a persistent derived-data write. Once teardown starts,
    // snapshots must remain read-only even when an earlier connect settles late.
    const directoryUpdatedAt = this.lifecycle.stopping
      ? undefined
      : this.store.rebuildDirectoryFromSessions(sessions)
    return { config, sessions, statuses, directoryUpdatedAt }
  }

  getConfig(): ChannelConfig {
    return redactConfigForRenderer(this.store.getConfig())
  }

  updateConfig(patch: Partial<ChannelConfig>): ChannelConfig {
    this.lifecycle.assertAccepting()
    const current = this.store.getConfig()

    const mergedPlatforms = { ...current.platforms }
    if (patch.platforms) {
      for (const platform of Object.keys(patch.platforms) as ChannelPlatform[]) {
        const incoming = patch.platforms[platform]
        const existing = mergedPlatforms[platform]
        const next = { ...existing, ...incoming }
        if (incoming?.token?.includes('•')) {
          next.token = existing.token
        }
        if (incoming?.webhookSecret?.includes('•')) {
          next.webhookSecret = existing.webhookSecret
        }
        mergedPlatforms[platform] = next
      }
    }

    const merged = this.store.updateConfig({
      ...patch,
      platforms: mergedPlatforms
    })

    for (const platform of Object.keys(merged.platforms) as ChannelPlatform[]) {
      const approved = this.auth.getApprovedUserIds(platform)
      if (approved.length > 0) {
        const allowed = new Set(merged.platforms[platform].allowedUserIds ?? [])
        for (const userId of approved) allowed.add(userId)
        merged.platforms[platform].allowedUserIds = [...allowed]
      }
    }

    this.store.saveConfig(merged)
    this.emitUpdated()
    return redactConfigForRenderer(merged)
  }

  listPairingRequests(): PairingRequest[] {
    return this.auth.listPendingRequests()
  }

  approvePairing(code: string): boolean {
    this.lifecycle.assertAccepting()
    const pending = this.auth.listPendingRequests().find(
      (entry) => entry.code.toUpperCase() === code.trim().toUpperCase()
    )
    const approved = this.auth.approvePairing(code)
    if (approved && pending) {
      this.store.addAllowedUser(pending.platform, pending.userId)
    }
    this.emitUpdated()
    return approved
  }

  rejectPairing(code: string): boolean {
    this.lifecycle.assertAccepting()
    const rejected = this.auth.rejectPairing(code)
    if (rejected) this.emitUpdated()
    return rejected
  }

  async connect(platform?: ChannelPlatform): Promise<ChannelsSnapshot> {
    return this.lifecycle.run('connect', async () => {
      const config = this.store.getConfig()
      const targets = platform ? [platform] : (Object.keys(config.platforms) as ChannelPlatform[])

      for (const name of targets) {
        if (this.lifecycle.stopping) break
        const platformConfig = config.platforms[name]
        if (!platformConfig.enabled) continue
        await this.connectPlatform(name, platformConfig)
      }

      if (!this.lifecycle.stopping) this.emitUpdated()
      return this.getSnapshot()
    })
  }

  async disconnect(platform?: ChannelPlatform): Promise<ChannelsSnapshot> {
    const targets = platform
      ? [platform]
      : ([...this.adapters.keys()] as ChannelPlatform[])

    for (const name of targets) {
      this.connectErrors.delete(name)
      const adapter = this.adapters.get(name)
      if (adapter) {
        await adapter.disconnect()
        this.adapters.delete(name)
      }
    }

    this.emitUpdated()
    return this.getSnapshot()
  }

  async sendTest(
    platform: ChannelPlatform,
    chatId: string,
    text: string,
    threadId?: string
  ): Promise<{ success: boolean; error?: string }> {
    this.lifecycle.assertAccepting()
    return this.router.sendTest(platform, chatId, text, threadId)
  }

  getRecentActivity(limit = 50): ChannelActivityEvent[] {
    return this.router.getRecentActivity(limit)
  }

  async startEnabled(): Promise<void> {
    await this.lifecycle.run('connect', async () => {
      const config = this.store.getConfig()
      for (const platform of Object.keys(config.platforms) as ChannelPlatform[]) {
        if (this.lifecycle.stopping) break
        if (config.platforms[platform].enabled) {
          try {
            await this.connectPlatform(platform, config.platforms[platform])
          } catch (err) {
            if (this.lifecycle.stopping) break
            console.error(`[channels] failed to start ${platform}:`, err)
          }
        }
      }
      if (!this.lifecycle.stopping) this.emitUpdated()
    })
  }

  async stopAll(): Promise<void> {
    await this.disconnect()
  }

  private getStatuses(): ChannelStatus[] {
    const platforms: ChannelPlatform[] = ['telegram', 'discord', 'webhook']
    return platforms.map((platform) => {
      const adapter = this.adapters.get(platform)
      if (adapter) return adapter.getStatus()
      const config = this.store.getConfig()
      const connectError = this.connectErrors.get(platform)
      if (config.platforms[platform].enabled && connectError) {
        return { platform, state: 'error' as const, error: connectError }
      }
      return { platform, state: 'disconnected' as const }
    })
  }

  private async connectPlatform(
    platform: ChannelPlatform,
    platformConfig: ChannelConfig['platforms'][ChannelPlatform]
  ): Promise<void> {
    if (this.lifecycle.stopping) return
    await this.adapters.get(platform)?.disconnect()
    this.adapters.delete(platform)

    const adapter = this.createAdapter(platform, platformConfig)
    adapter.setInboundHandler((message) => {
      void this.router.handleInbound(message).catch((error) => {
        if (isProfileDraining(error)) return
        console.error('[channels] inbound failed:', error)
      })
    })
    // Publish the connecting adapter so a concurrent reversible disconnect can
    // abort and await it instead of returning while it later becomes connected.
    this.adapters.set(platform, adapter)

    try {
      await adapter.connect(this.lifecycle.signal)
    } catch (error) {
      await adapter.disconnect().catch(() => undefined)
      if (this.adapters.get(platform) === adapter) this.adapters.delete(platform)
      if (this.lifecycle.stopping) return
      // Keep the reason visible in snapshots; the failed adapter itself is discarded.
      this.connectErrors.set(platform, error instanceof Error ? error.message : String(error))
      throw error
    }
    this.connectErrors.delete(platform)

    if (this.lifecycle.stopping || this.adapters.get(platform) !== adapter) {
      await adapter.disconnect()
      return
    }
    if (this.lifecycle.stopping) {
      this.adapters.delete(platform)
      await adapter.disconnect()
    }
  }

  private disconnectAdapters(): Promise<void> {
    if (this.disconnecting) return this.disconnecting
    const adapters = [...this.adapters.entries()]
    if (adapters.length === 0) return Promise.resolve()
    this.disconnecting = Promise.allSettled(adapters.map(async ([platform, adapter]) => {
      await adapter.disconnect()
      if (this.adapters.get(platform) === adapter) this.adapters.delete(platform)
    }))
      .then((results) => {
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason)
        if (failures.length) throw new AggregateError(failures, 'One or more channel adapters failed to disconnect')
      })
      .finally(() => {
        this.disconnecting = null
      })
    return this.disconnecting
  }

  private trackDrain(work: Promise<unknown>): void {
    if (this.draining.has(work)) return
    this.draining.add(work)
    void work.then(
      () => this.draining.delete(work),
      () => this.draining.delete(work)
    )
  }

  private async awaitDrain(timeoutMs: number): Promise<void> {
    if (this.draining.size === 0) return
    await this.waitOwned(Promise.all([...this.draining]), timeoutMs)
  }

  private waitOwned(work: Promise<unknown>, timeoutMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new Error('Invalid shutdown timeout'))
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          Object.assign(new Error('Profile work did not finish before the shutdown deadline'), {
            code: 'profile_busy',
            details: { ...this.lifecycle.snapshot(), draining: this.draining.size }
          })
        )
      }, timeoutMs)
      work.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  private emitUpdated(): void {
    this.emit('updated', this.getSnapshot())
  }
}
