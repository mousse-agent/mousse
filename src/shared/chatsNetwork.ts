import type { Envelope, SpaceId, StreamHead, StreamId, UserId } from './net'
import type { SpaceLocalDelivery } from './spaces/local'

export const CHAT_NETWORK_METHODS = ['chats.publish', 'chats.publication'] as const
export type ChatNetworkMethod = typeof CHAT_NETWORK_METHODS[number]
export interface ChatPublishInput { chatId: string; publicationId: string; name?: string }
export interface ChatNetworkBinding {
  publicationId: string; space: SpaceId; channel: StreamId; owner: UserId; state: 'published'
  localHistory: { messageCount: number; lastMessageId?: string }
}
/** A rebuilt display projection, never a ChatStore record or execution input. */
export interface ChatNetworkProjection {
  binding: ChatNetworkBinding
  head: StreamHead
  records: Array<{ epoch: number; seq: number; recvTs: number; envelope: Envelope }>
  nextAfter?: StreamHead
  delivery?: SpaceLocalDelivery
}
export interface ChatNetworkSendInput {
  chatId: string; text: string; clientMessageId: string; mentions?: import('./net').BotId[]
}
