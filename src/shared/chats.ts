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
export interface ChatSummary {
  id: string
  kind: 'direct' | 'group'
  name: string
  threadId: string
  projectId?: string
  participants: ChatParticipant[]
  createdAt: string
  updatedAt: string
  lastMessage?: ChatMessage
  run?: ChatRun
}
export interface ChatConversation extends ChatSummary {
  messages: ChatMessage[]
  /** Live daemon-owned approvals; hydrated at read time and never persisted. */
  pendingQuestions?: PendingUserQuestions[]
}
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
export interface ChatSendInput { chatId: string; text: string; clientMessageId?: string }
export interface ChatCancelInput { chatId: string; runId: string }
export interface ChatAssignDeviceInput { agentId: string; deviceId: string }
export const CHAT_METHODS = ['chats.snapshot', 'chats.create', 'chats.get', 'chats.send', 'chats.cancel', 'chats.assignDevice'] as const
export type ChatMethod = (typeof CHAT_METHODS)[number]
export const CHAT_CAPABILITY = 'chats.v1'
