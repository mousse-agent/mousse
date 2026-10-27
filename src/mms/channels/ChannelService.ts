import type { LlmProviderOption } from '../../shared/settings'
import type { ModelOverride } from '../../shared/providerInstances'
import type { HarnessCaps } from '../../shared/harness/types'
import { EventEmitter } from 'events'
import type {
  ChannelActivityEvent,
  ChannelConfig,
  ChannelOwner,
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
import { ChannelOwnerClaims, type ChannelBots } from './channelBots'
import { CHANNEL_POLICY, ChannelApprovalNotices, channelGate } from './channelModels'
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
  /**
   * Models `/model` offers, after the profile's instance scope and model prefs (disabled
   * instances and hidden models left out). Default: the credentialed pi-ai providers.
   */
  listModels?: () => LlmProviderOption[]
  /**
   * The caps of an instance resolved for a channel turn (`channel_model`); throws when it cannot
   * run one. Picks the one-time approvals notice for a model chosen with `/model`.
   */
  capsOf?: (instanceId: string) => HarnessCaps
  /** The profile's personal bots; absent when bots are unavailable. */
  bots?: ChannelBots
  /** "This is me" codes (tests pass a clock). */
  ownerClaims?: ChannelOwnerClaims
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

/** How long a failed bot reply waits before it is sent again (times the attempt). */
const BOT_REPLY_RETRY_MS = 30_000

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
  private readonly approvalNotices = new ChannelApprovalNotices()
  private readonly ownerClaims: ChannelOwnerClaims
  private readonly bots: ChannelBots | undefined
  private unsubscribeBots: (() => void) | undefined

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
    this.ownerClaims = options?.ownerClaims ?? new ChannelOwnerClaims()
    this.bots = options?.bots
    this.auth = new ChannelAuth(this.store.getPairingDirectory())
    this.sessionManager = new ChannelSessionManager(
      this.store,
      threadStore,
      (override) => orchestrator.migrateModelOverride(override) ?? override,
      (threadId) => orchestrator.isBotThread(threadId)
    )
    this.router = new ChannelRouter(
      this.store,
      this.sessionManager,
      this.auth,
      {
        runChannelTurn: (threadId, text, opts) =>
          orchestrator.runChannelTurn(threadId, text, threadStore, { ...opts, approvals: CHANNEL_POLICY.approvals }),
        abortChannelTurn: (threadId) => orchestrator.abortChannelTurn(threadId),
        stopThread: (threadId) => orchestrator.stopThread(threadId, 'channel'),
        steerChannelTurn: (threadId, text) => orchestrator.steerChannelTurn(threadId, text),
        isChannelTurnActive: (threadId) => orchestrator.isChannelTurnActive(threadId)
      },
      (platform) => this.adapters.get(platform),
      () => this.store.getConfig(),
      {
        settingsStore: this.settingsStore,
        threadStore: this.threadStore,
        listModels: options?.listModels ?? (() => this.providerAuth.getConfiguredLlmProviders()),
        channelGate: (threadId, modelOverride) => {
          const caps = this.turnCaps(threadId, modelOverride, options?.capsOf)
          const gate = channelGate(caps)
          if (gate.refusal) return { refusal: gate.refusal }
          const notice = this.approvalNotices.pending(threadId, caps)
          return notice ? { notice } : {}
        },
        noticeDelivered: (threadId) => this.approvalNotices.delivered(threadId),
        ...(this.bots ? { bots: this.bots } : {}),
        ownerClaims: this.ownerClaims,
        ownerClaimReceived: () => this.emitUpdated(),
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
    // A channel activation tells its chat what it ended with (or that it waits for approval).
    this.unsubscribeBots = this.bots?.onChanged((event) => {
      if (event.activationId) this.sendBotReply(event.activationId)
    })
  }

  /** Posts what a channel activation has to say now; each state is claimed once, only while its chat is reachable. */
  private sendBotReply(activationId: string): void {
    if (!this.bots || this.lifecycle.stopping) return
    let reply: ReturnType<ChannelBots['channelReply']>
    try {
      // Only to a reachable chat, and only while the account that wrote is still the owner: after
      // "Forget" or an owner change, earlier activations no longer post to the old owner's DM.
      reply = this.bots.channelReply(activationId, {
        canSend: (replyTo) => !this.lifecycle.stopping &&
          this.adapters.get(replyTo.platform)?.getStatus().state === 'connected' &&
          replyTo.userId !== undefined && this.store.getOwners()[replyTo.platform]?.userId === replyTo.userId
      })
    } catch (error) {
      console.warn('[channels] bot reply could not be read', error)
      return
    }
    if (!reply) return
    const claimed = reply
    const failed = (error?: unknown) => {
      if (error !== undefined && !isProfileDraining(error)) console.error('[channels] bot reply failed:', error)
      // The claim goes back, and the reply is tried again later (at most three times in a row).
      try { claimed.release() } catch { /* the next change or connect tries again */ }
      this.retryBotReply(activationId)
    }
    void this.router.deliverBotReply(claimed.replyTo, claimed.text).then((sent) => {
      if (sent) this.replyRetries.delete(activationId)
      else failed()
    }, failed)
  }

  private readonly replyRetries = new Map<string, number>()

  private retryBotReply(activationId: string): void {
    if (this.lifecycle.stopping) return
    const tries = (this.replyRetries.get(activationId) ?? 0) + 1
    if (tries > 3) {
      this.replyRetries.delete(activationId)
      return
    }
    this.replyRetries.set(activationId, tries)
    const timer = setTimeout(() => this.sendBotReply(activationId), BOT_REPLY_RETRY_MS * tries)
    timer.unref?.()
  }

  /** Replies channel activations still owe a chat on `platform`, once it is connected. */
  private sweepBotReplies(): void {
    if (!this.bots) return
    let ids: string[] = []
    try { ids = this.bots.recentChannelActivations() } catch { return }
    for (const id of ids) this.sendBotReply(id)
  }

  // -- "This is me" (PR 6 §6) -------------------------------------------------------------------

  /** Each platform's confirmed owner. */
  getOwners(): Partial<Record<ChannelPlatform, ChannelOwner>> {
    return this.store.getOwners()
  }

  /** A one-time code the owner sends with `/owner <code>` from a direct message (10 minutes, one try per account). */
  startOwnerClaim(platform: ChannelPlatform): { code: string; expiresAt: string } {
    this.lifecycle.assertAccepting()
    // A webhook caller names its own user id, so a webhook account can never be confirmed as anyone.
    if (platform === 'webhook') throw Object.assign(new Error('Webhook senders can\'t be confirmed as the owner.'), { code: 'channel_owner_unconfirmed' })
    const claim = this.ownerClaims.start(platform)
    this.emitUpdated()
    return claim
  }

  /** The claim in progress: when it expires, and the account that sent the code, if one did. */
  ownerClaimStatus(platform: ChannelPlatform): ReturnType<ChannelOwnerClaims['status']> {
    return this.ownerClaims.status(platform)
  }

  /** "Is this your account?" — yes: stores the account that sent the code as the platform's owner. */
  confirmOwner(platform: ChannelPlatform, userId: string): Partial<Record<ChannelPlatform, ChannelOwner>> {
    this.lifecycle.assertAccepting()
    const owner = this.ownerClaims.confirm(platform, userId)
    if (!owner) throw Object.assign(new Error('No account sent that code, or the code expired. Start again.'), { code: 'channel_owner_unconfirmed' })
    const owners = this.store.setOwner(platform, owner)
    this.emitUpdated()
    return owners
  }

  /** "No" or "Cancel": ends the claim in progress, so its code stops working; a stored owner stays. */
  cancelOwnerClaim(platform: ChannelPlatform): void {
    this.ownerClaims.cancel(platform)
    this.emitUpdated()
  }

  /** Forgets the platform's owner (and any claim in progress): its bots answer nobody until one is confirmed. */
  clearOwner(platform: ChannelPlatform): Partial<Record<ChannelPlatform, ChannelOwner>> {
    this.lifecycle.assertAccepting()
    this.ownerClaims.cancel(platform)
    const owners = this.store.setOwner(platform, undefined)
    this.emitUpdated()
    return owners
  }

  /** The caps a channel turn on the thread runs on: the `/model` choice, else the thread's selection. */
  private turnCaps(threadId: string, modelOverride: ModelOverride | undefined, capsOf?: (instanceId: string) => HarnessCaps): HarnessCaps | null {
    const instanceId = modelOverride?.instanceId
    if (instanceId && capsOf) {
      try {
        return capsOf(instanceId)
      } catch {
        return null
      }
    }
    return this.orchestrator.capabilitiesForThread(threadId)
  }

  beginShutdown(): void {
    this.unsubscribeBots?.()
    this.unsubscribeBots = undefined
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
    return { config, sessions, statuses, directoryUpdatedAt, owners: this.store.getOwners() }
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
        const incoming = patch.platforms[platform] ?? {}
        const existing = mergedPlatforms[platform]
        const next = { ...existing, ...incoming }
        if (incoming.token?.includes('•')) {
          next.token = existing.token
        }
        if (incoming.webhookSecret?.includes('•')) {
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
    this.sweepBotReplies()
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
