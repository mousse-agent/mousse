import type { ChannelPlatformConfig, ChannelStatus } from '../../../shared/types'
import type {
  ChannelAdapter,
  InboundChannelMessage,
  OutboundChannelMessage,
  SendResult
} from '../types'

const TELEGRAM_API = 'https://api.telegram.org'

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = 'telegram' as const
  private token = ''
  private polling = false
  private offset = 0
  private pollTimer: NodeJS.Timeout | null = null
  private inboundHandler: ((message: InboundChannelMessage) => void) | null = null
  private status: ChannelStatus = { platform: 'telegram', state: 'disconnected' }

  constructor(private config: ChannelPlatformConfig) {
    this.token = config.token ?? ''
  }

  setInboundHandler(handler: (message: InboundChannelMessage) => void): void {
    this.inboundHandler = handler
  }

  getStatus(): ChannelStatus {
    return { ...this.status }
  }

  async connect(): Promise<void> {
    if (!this.token) {
      throw new Error('Telegram bot token is required')
    }
    this.status = { platform: 'telegram', state: 'connecting' }
    const me = await this.api<{ ok: boolean; result?: { username?: string } }>('getMe')
    if (!me.ok) {
      this.status = { platform: 'telegram', state: 'error', error: 'Invalid Telegram token' }
      throw new Error('Invalid Telegram bot token')
    }
    this.polling = true
    this.status = {
      platform: 'telegram',
      state: 'connected',
      connectedAt: new Date().toISOString()
    }
    void this.pollLoop()
  }

  async disconnect(): Promise<void> {
    this.polling = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    this.status = { platform: 'telegram', state: 'disconnected' }
  }

  async send(message: OutboundChannelMessage): Promise<SendResult> {
    try {
      const payload: Record<string, unknown> = {
        chat_id: message.chatId,
        text: message.text
      }
      if (message.threadId) {
        payload.message_thread_id = Number(message.threadId)
      }
      if (message.replyToMessageId) {
        payload.reply_to_message_id = Number(message.replyToMessageId)
      }
      const response = await this.api<{ ok: boolean; result?: { message_id?: number }; description?: string }>(
        'sendMessage',
        payload
      )
      if (!response.ok) {
        return { success: false, error: response.description ?? 'Telegram send failed' }
      }
      return { success: true, messageId: String(response.result?.message_id ?? '') }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async sendTyping(chatId: string, threadId?: string): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      action: 'typing'
    }
    if (threadId) {
      payload.message_thread_id = Number(threadId)
    }
    await this.api('sendChatAction', payload)
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const response = await this.api<{
          ok: boolean
          result: Array<Record<string, unknown>>
        }>('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message']
        })

        for (const update of response.result ?? []) {
          const updateId = Number(update.update_id ?? 0)
          if (updateId >= this.offset) {
            this.offset = updateId + 1
          }
          this.handleUpdate(update)
        }
      } catch (err) {
        if (this.polling) {
          console.error('[telegram] poll error:', err)
          await sleep(2000)
        }
      }
    }
  }

  private handleUpdate(update: Record<string, unknown>): void {
    const message = update.message as Record<string, unknown> | undefined
    if (!message || !this.inboundHandler) return

    const from = message.from as Record<string, unknown> | undefined
    const chat = message.chat as Record<string, unknown> | undefined
    const text = String(message.text ?? message.caption ?? '').trim()
    if (!from || !chat || !text) return

    const userId = String(from.id ?? '')
    if (from.is_bot) return

    const chatTypeRaw = String(chat.type ?? 'private')
    const chatType =
      chatTypeRaw === 'private'
        ? 'dm'
        : chatTypeRaw === 'group' || chatTypeRaw === 'supergroup'
          ? 'group'
          : 'channel'

    this.inboundHandler({
      platform: 'telegram',
      chatId: String(chat.id ?? ''),
      threadId: message.message_thread_id ? String(message.message_thread_id) : undefined,
      chatName: String(chat.title ?? chat.username ?? chat.first_name ?? chat.id ?? ''),
      chatType,
      userId,
      userName: String(from.username ?? from.first_name ?? userId),
      text,
      messageId: String(message.message_id ?? '')
    })
  }

  private async api<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${TELEGRAM_API}/bot${this.token}/${method}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
    if (!response.ok) {
      throw new Error(`Telegram API HTTP ${response.status}`)
    }
    return (await response.json()) as T
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
