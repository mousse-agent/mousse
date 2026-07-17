import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
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
import { discordApplicationCommands } from '../slash/registry'

export class DiscordAdapter implements ChannelAdapter {
  readonly platform = 'discord' as const
  private client: Client | null = null
  private inboundHandler: ((message: InboundChannelMessage) => void) | null = null
  private status: ChannelStatus = { platform: 'discord', state: 'disconnected' }
  private pendingInteractionReplies = new Map<
    string,
    { interaction: ChatInputCommandInteraction; replied: boolean }
  >()

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
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) void this.handleSlashCommand(interaction)
    })

    await this.client.login(this.config.token)
    await this.registerApplicationCommands()
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
    this.pendingInteractionReplies.clear()
    this.status = { platform: 'discord', state: 'disconnected' }
  }

  async send(message: OutboundChannelMessage): Promise<SendResult> {
    if (!this.client) {
      return { success: false, error: 'Discord client not connected' }
    }
    try {
      const pending = message.replyToMessageId
        ? this.pendingInteractionReplies.get(message.replyToMessageId)
        : undefined
      if (pending) {
        if (pending.replied) {
          const sent = await pending.interaction.followUp({ content: message.text })
          return { success: true, messageId: sent.id }
        }
        await pending.interaction.editReply({ content: message.text })
        pending.replied = true
        return { success: true, messageId: pending.interaction.id }
      }
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

  private async registerApplicationCommands(): Promise<void> {
    try {
      const client = this.client
      if (!client) return
      if (!client.isReady()) {
        await new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()))
      }
      if (!client.application) {
        throw new Error('Discord application is unavailable after the client became ready')
      }
      await client.application.commands.set(discordApplicationCommands())
    } catch (err) {
      // Retain text-command support when native registration is unavailable.
      console.error('[discord] command registration failed:', err)
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.inboundHandler) return
    try {
      await interaction.deferReply()
      this.pendingInteractionReplies.set(interaction.id, { interaction, replied: false })
      const args = interaction.options.getString('arguments')?.trim()
      const channel = interaction.channel
      this.inboundHandler({
        platform: 'discord',
        chatId: interaction.channelId,
        threadId: channel?.isThread() ? interaction.channelId : undefined,
        chatName:
          channel?.isTextBased() && 'name' in channel && channel.name
            ? channel.name
            : interaction.channelId,
        chatType:
          channel?.type === ChannelType.DM
            ? 'dm'
            : channel?.isThread()
              ? 'thread'
              : interaction.guildId
                ? 'channel'
                : 'group',
        userId: interaction.user.id,
        userName: interaction.user.username,
        text: `/${interaction.commandName}${args ? ` ${args}` : ''}`,
        messageId: interaction.id
      })
    } catch (err) {
      console.error('[discord] slash command handling failed:', err)
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('Could not process this command. Please try again.').catch(() => undefined)
      }
    }
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
