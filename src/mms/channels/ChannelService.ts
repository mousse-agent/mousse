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
import { ChannelAuth } from './ChannelAuth'
import { ChannelRouter } from './ChannelRouter'
import { ChannelSessionManager } from './ChannelSessionManager'
import { ChannelStore, redactConfigForRenderer } from './ChannelStore'
import { DiscordAdapter } from './adapters/DiscordAdapter'
import { TelegramAdapter } from './adapters/TelegramAdapter'
import { WebhookAdapter } from './adapters/WebhookAdapter'
import type { ChannelAdapter } from './types'

export class ChannelService extends EventEmitter {
  private auth = new ChannelAuth()
  private sessionManager: ChannelSessionManager
  private router: ChannelRouter
  private adapters = new Map<ChannelPlatform, ChannelAdapter>()

  constructor(
    private orchestrator: OrchestratorService,
    threadStore: ThreadDataStore,
    private store: ChannelStore
  ) {
    super()
    this.sessionManager = new ChannelSessionManager(this.store, threadStore)
    this.router = new ChannelRouter(
      this.store,
      this.sessionManager,
      this.auth,
      {
        runChannelTurn: (threadId, text) =>
          orchestrator.runChannelTurn(threadId, text, threadStore)
      },
      (platform) => this.adapters.get(platform),
      () => this.store.getConfig()
    )
    this.router.on('activity', (event: ChannelActivityEvent) => {
      this.emit('activity', event)
    })
    this.router.on('pairing-updated', () => {
      this.emitUpdated()
    })
  }

  getSnapshot(): ChannelsSnapshot {
    const config = redactConfigForRenderer(this.store.getConfig())
    const sessions = this.store.listSessions()
    const statuses = this.getStatuses()
    const directoryUpdatedAt = this.store.rebuildDirectoryFromSessions(sessions)
    return { config, sessions, statuses, directoryUpdatedAt }
  }

  getConfig(): ChannelConfig {
    return redactConfigForRenderer(this.store.getConfig())
  }

  updateConfig(patch: Partial<ChannelConfig>): ChannelConfig {
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
    const rejected = this.auth.rejectPairing(code)
    if (rejected) this.emitUpdated()
    return rejected
  }

  async connect(platform?: ChannelPlatform): Promise<ChannelsSnapshot> {
    const config = this.store.getConfig()
    const targets = platform ? [platform] : (Object.keys(config.platforms) as ChannelPlatform[])

    for (const name of targets) {
      const platformConfig = config.platforms[name]
      if (!platformConfig.enabled) continue
      await this.connectPlatform(name, platformConfig)
    }

    this.emitUpdated()
    return this.getSnapshot()
  }

  async disconnect(platform?: ChannelPlatform): Promise<ChannelsSnapshot> {
    const targets = platform
      ? [platform]
      : ([...this.adapters.keys()] as ChannelPlatform[])

    for (const name of targets) {
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
    return this.router.sendTest(platform, chatId, text, threadId)
  }

  getRecentActivity(limit = 50): ChannelActivityEvent[] {
    return this.router.getRecentActivity(limit)
  }

  async startEnabled(): Promise<void> {
    const config = this.store.getConfig()
    for (const platform of Object.keys(config.platforms) as ChannelPlatform[]) {
      if (config.platforms[platform].enabled) {
        try {
          await this.connectPlatform(platform, config.platforms[platform])
        } catch (err) {
          console.error(`[channels] failed to start ${platform}:`, err)
        }
      }
    }
    this.emitUpdated()
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
      if (config.platforms[platform].enabled) {
        return { platform, state: 'disconnected' as const }
      }
      return { platform, state: 'disconnected' as const }
    })
  }

  private async connectPlatform(
    platform: ChannelPlatform,
    platformConfig: ChannelConfig['platforms'][ChannelPlatform]
  ): Promise<void> {
    await this.adapters.get(platform)?.disconnect()

    let adapter: ChannelAdapter
    switch (platform) {
      case 'telegram':
        adapter = new TelegramAdapter(platformConfig)
        break
      case 'discord':
        adapter = new DiscordAdapter(platformConfig)
        break
      case 'webhook':
        adapter = new WebhookAdapter(platformConfig)
        break
      default:
        throw new Error(`Unknown platform: ${platform}`)
    }

    adapter.setInboundHandler((message) => {
      void this.router.handleInbound(message)
    })

    await adapter.connect()
    this.adapters.set(platform, adapter)
  }

  private emitUpdated(): void {
    this.emit('updated', this.getSnapshot())
  }
}
