import type { PendingUserQuestions } from './types'

/** Agents and people share participant identities; remote people remain a future transport. */
export interface ChatParticipant {
  id: string
  kind: 'agent' | 'person'
  name: string
  slug?: string
  definitionId?: string
  definitionRevision?: string
  deviceId?: string
}
export type ChatRunState = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface ChatMessage {
  id: string
  participantId: string
  text: string
  createdAt: string
  runId?: string
  replyToMessageId?: string
  status: Exclude<ChatRunState, 'running'>
  error?: string
}
export interface ChatRun {
  id: string
  state: ChatRunState
  startedAt: string
  finishedAt?: string
  agentId?: string
  error?: string
}
export interface LocalChatSummary {
  presentation?: 'local'
  id: string
  kind: 'direct' | 'group'
  name: string
  threadId: string
  /** Only groups can be associated with a project. */
  projectId?: string
  participants: ChatParticipant[]
  createdAt: string
  updatedAt: string
  lastMessage?: ChatMessage
  run?: ChatRun
}
export interface LocalChatConversation extends LocalChatSummary {
  messages: ChatMessage[]
  /** Network records remain a separate projection; local messages keep their UUID identities. */
  network?: import('./chatsNetwork').ChatNetworkProjection
  /** Live daemon-owned approvals; hydrated at read time and never persisted. */
  pendingQuestions?: PendingUserQuestions[]
}
export type ChatSummary = LocalChatSummary | import('./chatsNetwork').NetworkChatSummary
export type ChatConversation = LocalChatConversation | import('./chatsNetwork').NetworkChatConversation
export interface ChatAgent {
  id: string
  name: string
  slug: string
  purpose: string
  definitionRevision: string
  deviceId: string
  available: boolean
  unavailableReason?: string
}
export interface ChatDevice {
  id: string
  name: string
  platform?: string
  isLocal: boolean
  online: boolean
}
export interface ChatsSnapshot { agents: ChatAgent[]; chats: ChatSummary[]; devices: ChatDevice[] }
export interface ChatCreateInput { kind: 'direct' | 'group'; agentIds: string[]; name?: string; projectId?: string }
export interface ChatSendInput { chatId: string; text: string; clientMessageId?: string; mentions?: import('./net').BotId[] }
export interface ChatCancelInput { chatId: string; runId: string }
export interface LocalChatAssignDeviceInput { agentId: string; deviceId: string }
export type ChatAssignDeviceInput = LocalChatAssignDeviceInput | import('./chatsNetwork').ChatTaskSelectionInput
export const CHAT_METHODS = ['chats.snapshot', 'chats.create', 'chats.get', 'chats.send', 'chats.cancel', 'chats.assignDevice'] as const
export type ChatMethod = (typeof CHAT_METHODS)[number]
export const CHAT_CAPABILITY = 'chats.v1'
