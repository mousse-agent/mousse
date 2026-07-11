import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type SendableChannels
} from 'discord.js'
import type { ChannelPlatformConfig, ChannelStatus } from '../../../shared/types'
import type {
  ChannelAdapter,
  InboundChannelMessage,
  OutboundChannelMessage,
  SendResult
} from '../types'

export class DiscordAdapter implements ChannelAdapter {
  readonly platform = 'discord' as const
  private client: Client | null = null
  private inboundHandler: ((message: InboundChannelMessage) => void) | null = null
  private status: ChannelStatus = { platform: 'discord', state: 'disconnected' }

  constructor(private config: ChannelPlatformConfig) {}

  setInboundHandler(handler: (message: InboundChannelMessage) => void): void {
    this.inboundHandler = handler
  }

  getStatus(): ChannelStatus {
    return { ...this.status }
  }

  async connect(): Promise<void> {
    if (!this.config.token) {
      throw new Error('Discord bot token is required')
    }

    this.status = { platform: 'discord', state: 'connecting' }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel, Partials.Message]
    })

    this.client.on(Events.MessageCreate, (message) => {
      this.handleMessage(message)
    })

    await this.client.login(this.config.token)
    this.status = {
      platform: 'discord',
      state: 'connected',
      connectedAt: new Date().toISOString()
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.destroy()
      this.client = null
    }
    this.status = { platform: 'discord', state: 'disconnected' }
  }

  async send(message: OutboundChannelMessage): Promise<SendResult> {
    if (!this.client) {
      return { success: false, error: 'Discord client not connected' }
    }
    try {
      const channel = (await this.client.channels.fetch(message.chatId)) as SendableChannels | null
      if (!channel || !('send' in channel)) {
        return { success: false, error: 'Discord channel not found or not text-based' }
      }
      const sent = await channel.send({
        content: message.text,
        reply: message.replyToMessageId
          ? { messageReference: message.replyToMessageId }
          : undefined
      })
      return { success: true, messageId: sent.id }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.client) return
    const channel = await this.client.channels.fetch(chatId)
    if (channel && 'sendTyping' in channel && typeof channel.sendTyping === 'function') {
      await channel.sendTyping()
    }
  }

  private handleMessage(message: Message): void {
    if (!this.inboundHandler || message.author.bot) return
    const text = message.content.trim()
    if (!text) return

    const chatType = this.resolveChatType(message)
    const chatName = this.channelDisplayName(message)

    this.inboundHandler({
      platform: 'discord',
      chatId: message.channel.id,
      threadId: message.channel.isThread() ? message.channel.id : undefined,
      chatName,
      chatType,
      userId: message.author.id,
      userName: message.author.username,
      text,
      messageId: message.id
    })
  }

  private resolveChatType(message: Message): InboundChannelMessage['chatType'] {
    if (message.channel.type === ChannelType.DM) return 'dm'
    if (message.channel.isThread()) return 'thread'
    if (message.channel.type === ChannelType.GuildText) return 'channel'
    return 'group'
  }

  private channelDisplayName(message: Message): string {
    if (message.channel.type === ChannelType.DM) {
      return message.author.username
    }
    if ('name' in message.channel && message.channel.name) {
      return message.channel.name
    }
    return message.channel.id
  }
}
