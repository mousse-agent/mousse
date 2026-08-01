import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type {
  ChannelActivityEvent,
  ChannelConfig,
  ChannelPlatform
} from '../../shared/types'
import type { LlmProviderOption } from '../../shared/settings'
import type { SettingsStore } from '../settings/SettingsStore'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import { ChannelAuth } from './ChannelAuth'
import { ChannelSessionManager } from './ChannelSessionManager'
import { ChannelStore } from './ChannelStore'
import { chunkMessage } from './chunkMessage'
import { isSilenceNarration } from './delivery'
import { dispatchSlashCommand, parseSlashCommand } from './slash'
import type { SlashAgentInfo } from './slash'
import { detectThreadRuntime, type ThreadTurnControls } from './threadRuntime'
import type { ChannelAdapter, InboundChannelMessage, OutboundChannelMessage } from './types'
import { buildSessionKey } from './types'

export interface ChannelTurnRunner {
  runChannelTurn(
    threadId: string,
    content: string,
    opts?: {
      modelOverride?: { llmProvider: string; model: string }
      signal?: AbortSignal
      drainSteer?: () => string | undefined
    }
  ): Promise<{ text: string; silent: boolean; error?: string; aborted?: boolean }>
  abortChannelTurn?: (threadId: string) => boolean
  steerChannelTurn?: (threadId: string, text: string) => boolean
  isChannelTurnActive?: (threadId: string) => boolean
  /** Optional future MMS thread-runtime surface (feature-detected). */
  enqueueThreadMessage?: ThreadTurnControls['enqueue']
  listThreadQueue?: ThreadTurnControls['listQueue']
  isThreadTurnActive?: (threadId: string) => boolean
  abortThreadTurn?: (threadId: string) => boolean
  steerThreadTurn?: (threadId: string, text: string) => boolean
  threadRuntime?: import('./threadRuntime').MmsThreadRuntime
}

export interface ChannelRouterDeps {
  settingsStore: SettingsStore
  threadStore: ThreadDataStore
  listModels: () => LlmProviderOption[]
  listAgents?: () => SlashAgentInfo[]
}

export class ChannelRouter extends EventEmitter {
  /**
   * Per-session (or MMS per-thread) FIFO turn chains.
   * Different sessions/threads must not serialize behind one global lock.
   */
  private sessionQueues = new Map<string, Promise<void>>()
  private recentActivity: ChannelActivityEvent[] = []
  private sessionGenerations = new Map<string, number>()
  /** Per-session mid-run control (abort + steer) for the active channel turn. */
  private activeSessionTurns = new Map<
    string,
    { abort: AbortController; pendingSteer: string[]; threadId: string }
  >()
  private readonly threadControls: ThreadTurnControls

  constructor(
    private store: ChannelStore,
    private sessionManager: ChannelSessionManager,
    private auth: ChannelAuth,
    private runner: ChannelTurnRunner,
    private getAdapter: (platform: ChannelPlatform) => ChannelAdapter | undefined,
    private getConfig: () => ChannelConfig,
    private deps: ChannelRouterDeps
  ) {
    super()
    this.threadControls = detectThreadRuntime(runner)
  }

  bumpGeneration(sessionKey: string): number {
    const next = (this.sessionGenerations.get(sessionKey) ?? 0) + 1
    this.sessionGenerations.set(sessionKey, next)
    return next
  }

  getGeneration(sessionKey: string): number {
    return this.sessionGenerations.get(sessionKey) ?? 0
  }

  private abortSessionTurn(sessionKey: string, threadId: string): boolean {
    this.bumpGeneration(sessionKey)
    const local = this.activeSessionTurns.get(sessionKey)
    let aborted = false
    if (local && !local.abort.signal.aborted) {
      local.pendingSteer = []
      local.abort.abort()
      aborted = true
    }
    if (this.threadControls.abort(threadId)) {
      aborted = true
    }
    return aborted
  }

  private steerSessionTurn(sessionKey: string, threadId: string, text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed) return false
    const local = this.activeSessionTurns.get(sessionKey)
    if (local && !local.abort.signal.aborted) {
      local.pendingSteer.push(trimmed)
      return true
    }
    return this.threadControls.steer(threadId, trimmed)
  }

  private isSessionTurnActive(sessionKey: string, threadId: string): boolean {
    const local = this.activeSessionTurns.get(sessionKey)
    if (local && !local.abort.signal.aborted) return true
    return this.threadControls.isActive(threadId)
  }

  async handleInbound(message: InboundChannelMessage): Promise<void> {
    if (message.isBot) return
    const text = message.text.trim()
    if (!text) return

    const config = this.getConfig()
    if (!this.auth.isAuthorized(config, message)) {
      await this.handleUnauthorized(config, message)
      return
    }

    this.recordActivity('inbound', message.platform, message, text)

    const session = this.sessionManager.resolveThread(message)
    const sessionKey = session.sessionKey

    const parsed = parseSlashCommand(text)
    if (parsed) {
      const result = await dispatchSlashCommand({
        message,
        session,
        args: parsed.args,
        parsed,
        sessionManager: this.sessionManager,
        store: this.store,
        settings: this.deps.settingsStore,
        threadStore: this.deps.threadStore,
        listModels: this.deps.listModels,
        listAgents: this.deps.listAgents,
        bumpGeneration: (key) => this.bumpGeneration(key),
        getGeneration: (key) => this.getGeneration(key),
        abortTurn: () => this.abortSessionTurn(sessionKey, session.mousseThreadId),
        steerTurn: (steerText) => this.steerSessionTurn(sessionKey, session.mousseThreadId, steerText),
        isTurnActive: () => this.isSessionTurnActive(sessionKey, session.mousseThreadId)
      })
      if (result.handled) {
        if (result.reply) {
          await this.deliverReply(message, result.reply)
        }
        return
      }
    }

    // Same-session/thread FIFO stacking only. Unrelated sessions run concurrently;
    // MMS per-thread execution control serializes same-thread work when available.
    const queueKey = session.mousseThreadId
      ? `thread:${session.mousseThreadId}`
      : `session:${sessionKey}`

    if (this.threadControls.hasMmsQueue && this.threadControls.enqueue) {
      // Prefer MMS-owned queue so we never double-persist a local stack.
      if (this.threadControls.isActive(session.mousseThreadId)) {
        await this.threadControls.enqueue(session.mousseThreadId, text)
        return
      }
    }

    const previous = this.sessionQueues.get(queueKey) ?? Promise.resolve()
    const next = previous
      .then(() => this.processTurn(message, session.mousseThreadId, text, sessionKey))
      .catch((err) => {
        console.error('[channels] turn failed:', err)
      })
    this.sessionQueues.set(queueKey, next)
    await next
  }

  private async handleUnauthorized(
    config: ChannelConfig,
    message: InboundChannelMessage
  ): Promise<void> {
    if (message.chatType !== 'dm') return

    const adapter = this.getAdapter(message.platform)
    if (!adapter) return

    if (config.unauthorizedDmBehavior === 'ignore') {
      return
    }

    const request = this.auth.createPairingRequest(message)
    if (!request) {
      await adapter.send({
        platform: message.platform,
        chatId: message.chatId,
        threadId: message.threadId,
        text: 'Too many pairing requests. Try again later.'
      })
      return
    }

    await adapter.send({
      platform: message.platform,
      chatId: message.chatId,
      threadId: message.threadId,
      text:
        `Unauthorized. Ask the Mousse owner to approve pairing code:\n` +
        `\`${request.code}\`\n` +
        `(expires ${new Date(request.expiresAt).toLocaleString()})`
    })
    this.emit('pairing-updated')
  }

  private async processTurn(
    message: InboundChannelMessage,
    threadId: string,
    text: string,
    sessionKey: string
  ): Promise<void> {
    const adapter = this.getAdapter(message.platform)
    if (!adapter) return

    const genAtStart = this.getGeneration(sessionKey)
    const liveSession = this.sessionManager.getSession(sessionKey)
    const modelOverride = liveSession?.modelOverride
    // Prefer latest bound thread (e.g. after /new raced); fall back to captured
    const effectiveThreadId = liveSession?.mousseThreadId ?? threadId

    if (adapter.sendTyping) {
      void adapter.sendTyping(message.chatId, message.threadId)
    }

    if (this.getGeneration(sessionKey) !== genAtStart) {
      return
    }

    const turn = {
      abort: new AbortController(),
      pendingSteer: [] as string[],
      threadId: effectiveThreadId
    }
    this.activeSessionTurns.set(sessionKey, turn)

    try {
      const result = await this.runner.runChannelTurn(effectiveThreadId, text, {
        modelOverride,
        signal: turn.abort.signal,
        drainSteer: () => {
          if (turn.pendingSteer.length === 0) return undefined
          const steer = turn.pendingSteer.join('\n')
          turn.pendingSteer = []
          return steer
        }
      })

      if (this.getGeneration(sessionKey) !== genAtStart || result.aborted) {
        return
      }

      if (result.error) {
        await this.deliverReply(message, `Error: ${result.error}`)
        return
      }
      if (result.silent) return

      const config = this.getConfig()
      if (config.filterSilenceNarration && isSilenceNarration(result.text)) {
        return
      }

      await this.deliverReply(message, result.text)
    } finally {
      this.activeSessionTurns.delete(sessionKey)
    }
  }

  private async deliverReply(message: InboundChannelMessage, text: string): Promise<void> {
    const adapter = this.getAdapter(message.platform)
    if (!adapter) return

    const chunks = chunkMessage(text)
    for (const chunk of chunks) {
      const outbound: OutboundChannelMessage = {
        platform: message.platform,
        chatId: message.chatId,
        threadId: message.threadId,
        text: chunk,
        replyToMessageId: message.messageId
      }
      const result = await adapter.send(outbound)
      if (!result.success) {
        console.error('[channels] outbound failed:', result.error)
        break
      }
      this.recordActivity('outbound', message.platform, message, chunk)
    }
  }

  async sendTest(
    platform: ChannelPlatform,
    chatId: string,
    text: string,
    threadId?: string
  ): Promise<{ success: boolean; error?: string }> {
    const adapter = this.getAdapter(platform)
    if (!adapter) {
      return { success: false, error: `No adapter for ${platform}` }
    }
    const result = await adapter.send({ platform, chatId, threadId, text })
    return { success: result.success, error: result.error }
  }

  getRecentActivity(limit = 50): ChannelActivityEvent[] {
    return this.recentActivity.slice(-limit)
  }

  private recordActivity(
    direction: ChannelActivityEvent['direction'],
    platform: ChannelPlatform,
    message: InboundChannelMessage,
    text: string
  ): void {
    const event: ChannelActivityEvent = {
      id: uuidv4(),
      direction,
      platform,
      sessionKey: buildSessionKey(message.platform, message.chatId, message.threadId),
      text: text.slice(0, 500),
      timestamp: new Date().toISOString()
    }
    this.recentActivity.push(event)
    if (this.recentActivity.length > 200) {
      this.recentActivity = this.recentActivity.slice(-200)
    }
    this.emit('activity', event)
  }
}
