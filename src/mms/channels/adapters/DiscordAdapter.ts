import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type MessageActionRowComponentBuilder,
  type SendableChannels,
  type StringSelectMenuInteraction
} from 'discord.js'
import type { ChannelPlatformConfig, ChannelStatus } from '../../../shared/types'
import type {
  ChannelAdapter,
  ChannelMenu,
  InboundChannelMessage,
  OutboundChannelMessage,
  SendResult
} from '../types'
import { discordApplicationCommands } from '../slash/registry'

type PendingInteraction =
  | ChatInputCommandInteraction
  | StringSelectMenuInteraction
  | ButtonInteraction

export class DiscordAdapter implements ChannelAdapter {
  readonly platform = 'discord' as const
  private client: Client | null = null
  private inboundHandler: ((message: InboundChannelMessage) => void) | null = null
  private status: ChannelStatus = { platform: 'discord', state: 'disconnected' }
  private pendingInteractionReplies = new Map<
    string,
    { interaction: PendingInteraction; replied: boolean }
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

    this.client.on(Events.MessageCreate, (message) => this.handleMessage(message))
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) {
        void this.handleSlashCommand(interaction)
      } else if (interaction.isStringSelectMenu() || interaction.isButton()) {
        void this.handleMenuInteraction(interaction)
      }
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
      const components = message.menu ? buildDiscordMenu(message.menu) : []
      if (pending) {
        if (pending.replied) {
          const sent = await pending.interaction.followUp({ content: message.text, components })
          return { success: true, messageId: sent.id }
        }
        await pending.interaction.editReply({ content: message.text, components })
        pending.replied = true
        return { success: true, messageId: pending.interaction.id }
      }

      const channel = (await this.client.channels.fetch(message.chatId)) as SendableChannels | null
      if (!channel || !('send' in channel)) {
        return { success: false, error: 'Discord channel not found or not text-based' }
      }
      const sent = await channel.send({
        content: message.text,
        components,
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

    this.inboundHandler({
      platform: 'discord',
      chatId: message.channel.id,
      threadId: message.channel.isThread() ? message.channel.id : undefined,
      chatName: this.channelDisplayName(message),
      chatType: this.resolveChatType(message),
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
      this.inboundHandler({
        ...this.interactionMessageBase(interaction),
        text: `/${interaction.commandName}${args ? ` ${args}` : ''}`
      })
    } catch (err) {
      console.error('[discord] slash command handling failed:', err)
      if (interaction.deferred || interaction.replied) {
        await interaction
          .editReply('Could not process this command. Please try again.')
          .catch(() => undefined)
      }
    }
  }

  private async handleMenuInteraction(
    interaction: StringSelectMenuInteraction | ButtonInteraction
  ): Promise<void> {
    if (!this.inboundHandler) return
    const match = /^mousse:([a-zA-Z0-9]+):(select|prev|next)$/.exec(interaction.customId)
    if (!match) return

    try {
      await interaction.deferUpdate()
      this.pendingInteractionReplies.set(interaction.id, { interaction, replied: false })
      const value = interaction.isStringSelectMenu() ? interaction.values[0] : match[2]
      if (!value) return
      this.inboundHandler({
        ...this.interactionMessageBase(interaction),
        text: '[menu selection]',
        menuSelection: { menuId: match[1]!, value }
      })
    } catch (err) {
      console.error('[discord] menu interaction handling failed:', err)
      if (interaction.deferred || interaction.replied) {
        await interaction
          .editReply({
            content: 'Could not process this menu. Please run the command again.',
            components: []
          })
          .catch(() => undefined)
      }
    }
  }

  private interactionMessageBase(
    interaction: PendingInteraction
  ): Omit<InboundChannelMessage, 'text'> {
    const channel = interaction.channel
    return {
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
      messageId: interaction.id
    }
  }

  private resolveChatType(message: Message): InboundChannelMessage['chatType'] {
    if (message.channel.type === ChannelType.DM) return 'dm'
    if (message.channel.isThread()) return 'thread'
    if (message.channel.type === ChannelType.GuildText) return 'channel'
    return 'group'
  }

  private channelDisplayName(message: Message): string {
    if (message.channel.type === ChannelType.DM) return message.author.username
    if ('name' in message.channel && message.channel.name) return message.channel.name
    return message.channel.id
  }
}

function buildDiscordMenu(
  menu: ChannelMenu
): Array<ActionRowBuilder<MessageActionRowComponentBuilder>> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`mousse:${menu.id}:select`)
    .setPlaceholder(menu.placeholder.slice(0, 150))
    .addOptions(
      menu.options.map((option) => ({
        label: option.label.slice(0, 100),
        value: option.value,
        ...(option.description ? { description: option.description.slice(0, 100) } : {})
      }))
    )
  const rows: Array<ActionRowBuilder<MessageActionRowComponentBuilder>> = [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select)
  ]

  if (menu.pageCount > 1) {
    const navigation = new ActionRowBuilder<MessageActionRowComponentBuilder>()
    if (menu.page > 0) {
      navigation.addComponents(
        new ButtonBuilder()
          .setCustomId(`mousse:${menu.id}:prev`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
      )
    }
    if (menu.page + 1 < menu.pageCount) {
      navigation.addComponents(
        new ButtonBuilder()
          .setCustomId(`mousse:${menu.id}:next`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
      )
    }
    rows.push(navigation)
  }
  return rows
}
