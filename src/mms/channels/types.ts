import type { ChannelChatType, ChannelPlatform } from '../../shared/types'

export interface InboundChannelMessage {
  platform: ChannelPlatform
  chatId: string
  threadId?: string
  chatName?: string
  chatType: ChannelChatType
  userId: string
  userName?: string
  text: string
  messageId?: string
  isBot?: boolean
}

export interface OutboundChannelMessage {
  platform: ChannelPlatform
  chatId: string
  threadId?: string
  text: string
  replyToMessageId?: string
}

export interface SendResult {
  success: boolean
  messageId?: string
  error?: string
}

export interface ChannelAdapter {
  readonly platform: ChannelPlatform
  connect(): Promise<void>
  disconnect(): Promise<void>
  getStatus(): import('../../shared/types').ChannelStatus
  setInboundHandler(handler: (message: InboundChannelMessage) => void): void
  send(message: OutboundChannelMessage): Promise<SendResult>
  sendTyping?(chatId: string, threadId?: string): Promise<void>
}

export function buildSessionKey(
  platform: ChannelPlatform,
  chatId: string,
  threadId?: string
): string {
  const safeChat = String(chatId).replace(/[/\\..]/g, '_')
  if (threadId) {
    return `${platform}:${safeChat}:${threadId}`
  }
  return `${platform}:${safeChat}`
}

export function isPathUnsafe(value: string): boolean {
  if (!value) return false
  if (value.includes('..') || value.includes('/') || value.includes('\\')) return true
  return value.length >= 2 && value[0]!.match(/[a-zA-Z]/) !== null && value[1] === ':'
}
