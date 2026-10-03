import type { BotId, BotProfile, Envelope, NodeId, SpaceId, StreamHead, StreamId, UserId } from './net'
import type { SpaceLocalDelivery } from './spaces/local'

export const CHAT_NETWORK_METHODS = ['chats.publish', 'chats.publication', 'chats.bind'] as const
export type ChatNetworkMethod = typeof CHAT_NETWORK_METHODS[number]
export interface ChatPublishInput { chatId: string; publicationId: string; name?: string }
export interface ChatBindInput { bindingId: string; space: SpaceId; channel: StreamId }
export interface ChatNetworkPageInput { after?: StreamHead; limit?: number }
export interface NetworkChatParticipant {
  id: UserId | BotId; kind: 'person' | 'agent'; name: string; active: boolean
  deviceId?: NodeId; profile?: BotProfile
  slug?: never; definitionId?: never; definitionRevision?: never
}
/** A joined presentation allocates neither a local executable thread nor a workspace. */
export interface NetworkChatSummary {
  presentation: 'network'; id: string; kind: 'group'; name: string
  participants: NetworkChatParticipant[]; createdAt: string; updatedAt: string
  binding: ChatNetworkBinding
  threadId?: never; projectId?: never; run?: never; lastMessage?: never
}
export interface NetworkChatConversation extends NetworkChatSummary {
  messages: never[]; network: ChatNetworkProjection; pendingQuestions?: never
}
export interface ChatNetworkBinding {
  publicationId: string; space: SpaceId; channel: StreamId; owner: UserId; state: 'published'
  localHistory: { messageCount: number; lastMessageId?: string }
}
/** A rebuilt display projection, never a ChatStore record or execution input. */
export interface ChatNetworkProjection {
  binding: ChatNetworkBinding
  head: StreamHead
  cursor: StreamHead
  participants: NetworkChatParticipant[]
  offline: boolean
  readonly: boolean
  records: Array<{ epoch: number; seq: number; recvTs: number; envelope: Envelope }>
  nextAfter?: StreamHead
  delivery?: SpaceLocalDelivery
}
export interface ChatNetworkSendInput {
  chatId: string; text: string; clientMessageId: string; mentions?: import('./net').BotId[]
}
