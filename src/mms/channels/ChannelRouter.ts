import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type {
  ChannelActivityEvent,
  ChannelConfig,
  ChannelPlatform,
  ChannelStatus
} from '../../shared/types'
import { SILENT_MARKER } from '../../shared/types'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import { ChannelAuth } from './ChannelAuth'
import { ChannelSessionManager } from './ChannelSessionManager'
import { ChannelStore, redactConfigForRenderer } from './ChannelStore'
import { chunkMessage } from './chunkMessage'
import { isSilenceNarration } from './delivery'
import type { ChannelAdapter, InboundChannelMessage, OutboundChannelMessage } from './types'
import { buildSessionKey } from './types'

export interface ChannelTurnRunner {
  runChannelTurn(
    threadId: string,
    content: string
  ): Promise<{ text: string; silent: boolean; error?: string }>
}

export class ChannelRouter extends EventEmitter {
  private sessionQueues = new Map<string, Promise<void>>()
  private globalTurn: Promise<void> = Promise.resolve()
  private recentActivity: ChannelActivityEvent[] = []

  constructor(
    private store: ChannelStore,
    private sessionManager: ChannelSessionManager,
    private auth: ChannelAuth,
    private runner: ChannelTurnRunner,
    private getAdapter: (platform: ChannelPlatform) => ChannelAdapter | undefined,
    private getConfig: () => ChannelConfig
  ) {
    super()
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

    const previous = this.sessionQueues.get(sessionKey) ?? Promise.resolve()
    const next = previous
      .then(() => this.processTurn(message, session.mousseThreadId, text))
      .catch((err) => {
        console.error('[channels] turn failed:', err)
      })
    this.sessionQueues.set(sessionKey, next)
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
    text: string
  ): Promise<void> {
    const adapter = this.getAdapter(message.platform)
    if (!adapter) return

    if (adapter.sendTyping) {
      void adapter.sendTyping(message.chatId, message.threadId)
    }

    const run = async (): Promise<void> => {
      const result = await this.runner.runChannelTurn(threadId, text)
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
    }

    this.globalTurn = this.globalTurn.then(run, run)
    await this.globalTurn
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
