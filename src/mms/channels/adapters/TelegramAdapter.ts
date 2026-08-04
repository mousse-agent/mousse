import type { ChannelPlatformConfig, ChannelStatus } from '../../../shared/types'
import type {
  ChannelAdapter,
  InboundChannelMessage,
  OutboundChannelMessage,
  SendResult
} from '../types'
import { telegramBotCommands } from '../slash/registry'

const TELEGRAM_API = 'https://api.telegram.org'
const TELEGRAM_REQUEST_ATTEMPTS = 3
const TELEGRAM_RETRY_DELAY_MS = 250
const TELEGRAM_POLL_RETRY_MIN_MS = 1000
const TELEGRAM_POLL_RETRY_MAX_MS = 30_000

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = 'telegram' as const
  private token = ''
  private polling = false
  private offset = 0
  private pollTimer: NodeJS.Timeout | null = null
  private resolvePollDelay: (() => void) | null = null
  private pollFailureCount = 0
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
    await this.registerBotCommands()
    this.pollFailureCount = 0
    this.polling = true
    this.status = {
      platform: 'telegram',
      state: 'connected',
      connectedAt: new Date().toISOString()
    }
    void this.pollLoop()
  }

  private async registerBotCommands(): Promise<void> {
    try {
      const commands = telegramBotCommands()
      const response = await this.api<{ ok: boolean; description?: string }>('setMyCommands', {
        commands
      })
      if (!response.ok) {
        console.error('[telegram] setMyCommands failed:', response.description ?? 'unknown error')
      }
    } catch (err) {
      console.error('[telegram] setMyCommands error:', err)
    }
  }

  async disconnect(): Promise<void> {
    this.polling = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    this.resolvePollDelay?.()
    this.resolvePollDelay = null
    this.pollFailureCount = 0
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
      if (message.menu) {
        const rows: Array<Array<{ text: string; callback_data: string }>> = message.menu.options.map(
          (option) => [
            {
              text: option.description
                ? `${option.label} — ${option.description}`.slice(0, 64)
                : option.label.slice(0, 64),
              callback_data: `mousse:${message.menu!.id}:${option.value}`
            }
          ]
        )
        if (message.menu.pageCount > 1) {
          const navigation: Array<{ text: string; callback_data: string }> = []
          if (message.menu.page > 0) {
            navigation.push({ text: '‹ Previous', callback_data: `mousse:${message.menu.id}:prev` })
          }
          if (message.menu.page + 1 < message.menu.pageCount) {
            navigation.push({ text: 'Next ›', callback_data: `mousse:${message.menu.id}:next` })
          }
          if (navigation.length) rows.push(navigation)
        }
        payload.reply_markup = { inline_keyboard: rows }
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
    try {
      await this.api('sendChatAction', payload)
    } catch (err) {
      // Typing indicators are best-effort and must not create an unhandled rejection.
      console.error('[telegram] sendChatAction failed:', formatError(err))
    }
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
          allowed_updates: ['message', 'callback_query']
        })

        const recovered = this.pollFailureCount > 0
        this.pollFailureCount = 0
        if (recovered) {
          console.info('[telegram] polling recovered')
        }

        for (const update of response.result ?? []) {
          const updateId = Number(update.update_id ?? 0)
          if (updateId >= this.offset) {
            this.offset = updateId + 1
          }
          this.handleUpdate(update)
        }
      } catch (err) {
        if (!this.polling) break
        this.pollFailureCount += 1
        const retryMs = getPollRetryDelayMs(this.pollFailureCount)
        // Telegram occasionally ends long polls with a 502. This is recoverable;
        // avoid dumping a stack on every reconnect attempt while still surfacing
        // prolonged outages periodically.
        if (this.pollFailureCount === 1 || this.pollFailureCount % 5 === 0) {
          console.warn(
            `[telegram] polling temporarily unavailable: ${formatError(err)}; ` +
              `retrying in ${Math.round(retryMs / 1000)}s`
          )
        }
        await this.waitForPollRetry(retryMs)
      }
    }
  }

  private async waitForPollRetry(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        if (this.pollTimer) clearTimeout(this.pollTimer)
        this.pollTimer = null
        this.resolvePollDelay = null
        resolve()
      }
      this.resolvePollDelay = finish
      this.pollTimer = setTimeout(finish, ms)
    })
  }

  private handleUpdate(update: Record<string, unknown>): void {
    if (!this.inboundHandler) return

    const callback = update.callback_query as Record<string, unknown> | undefined
    if (callback) {
      this.handleCallbackQuery(callback)
      return
    }

    const message = update.message as Record<string, unknown> | undefined
    if (!message) return

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

  private handleCallbackQuery(callback: Record<string, unknown>): void {
    const data = String(callback.data ?? '')
    const match = /^mousse:([a-zA-Z0-9]+):(\d+|prev|next)$/.exec(data)
    const message = callback.message as Record<string, unknown> | undefined
    const from = callback.from as Record<string, unknown> | undefined
    const chat = message?.chat as Record<string, unknown> | undefined
    const callbackId = String(callback.id ?? '')

    if (callbackId) {
      void this.api('answerCallbackQuery', { callback_query_id: callbackId }).catch((err) => {
        console.error('[telegram] answerCallbackQuery failed:', formatError(err))
      })
    }
    if (!match || !message || !from || !chat || from.is_bot) return

    const chatTypeRaw = String(chat.type ?? 'private')
    const chatType =
      chatTypeRaw === 'private'
        ? 'dm'
        : chatTypeRaw === 'group' || chatTypeRaw === 'supergroup'
          ? 'group'
          : 'channel'
    const userId = String(from.id ?? '')
    this.inboundHandler?.({
      platform: 'telegram',
      chatId: String(chat.id ?? ''),
      threadId: message.message_thread_id ? String(message.message_thread_id) : undefined,
      chatName: String(chat.title ?? chat.username ?? chat.first_name ?? chat.id ?? ''),
      chatType,
      userId,
      userName: String(from.username ?? from.first_name ?? userId),
      text: '[menu selection]',
      messageId: String(message.message_id ?? ''),
      menuSelection: { menuId: match[1]!, value: match[2]! }
    })
  }

  private async api<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${TELEGRAM_API}/bot${this.token}/${method}`
    // getUpdates already has its own reconnect loop. Other calls get a few quick
    // retries because Telegram/undici connections can occasionally be reset
    // after a long poll, which otherwise drops the entire outbound reply.
    const maxAttempts = method === 'getUpdates' ? 1 : TELEGRAM_REQUEST_ATTEMPTS

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined
        })
      } catch (err) {
        if (attempt < maxAttempts) {
          await sleep(TELEGRAM_RETRY_DELAY_MS * attempt)
          continue
        }
        throw new Error(
          `Telegram API ${method} network error after ${maxAttempts} attempts: ${formatError(err)}`,
          { cause: err }
        )
      }

      const payload = await parseTelegramResponse(response, method)
      if (response.ok) return payload as T

      const description = getTelegramDescription(payload)
      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        const retryAfterSeconds = getTelegramRetryAfter(payload)
        await sleep(retryAfterSeconds * 1000 || TELEGRAM_RETRY_DELAY_MS * attempt)
        continue
      }
      throw new Error(
        `Telegram API ${method} HTTP ${response.status}${description ? `: ${description}` : ''}`
      )
    }

    throw new Error(`Telegram API ${method} request failed`)
  }
}

async function parseTelegramResponse(response: Response, method: string): Promise<unknown> {
  try {
    return await response.json()
  } catch (err) {
    throw new Error(`Telegram API ${method} returned invalid JSON: ${formatError(err)}`, {
      cause: err
    })
  }
}

function getTelegramDescription(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const description = (payload as Record<string, unknown>).description
  return typeof description === 'string' ? description : undefined
}

function getTelegramRetryAfter(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 0
  const parameters = (payload as Record<string, unknown>).parameters
  if (!parameters || typeof parameters !== 'object') return 0
  const retryAfter = Number((parameters as Record<string, unknown>).retry_after)
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0
}

function formatError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const code =
    'code' in err && typeof (err as Error & { code?: unknown }).code === 'string'
      ? (err as Error & { code: string }).code
      : undefined
  const current = `${code ? `${code}: ` : ''}${err.message}`
  const cause = err.cause
  return cause === undefined ? current : `${current} (${formatError(cause)})`
}

function getPollRetryDelayMs(failureCount: number): number {
  const exponent = Math.max(0, Math.min(5, failureCount - 1))
  return Math.min(TELEGRAM_POLL_RETRY_MAX_MS, TELEGRAM_POLL_RETRY_MIN_MS * 2 ** exponent)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
