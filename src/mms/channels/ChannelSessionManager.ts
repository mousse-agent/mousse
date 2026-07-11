import type { ChannelSession } from '../../shared/types'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import { ChannelStore } from './ChannelStore'
import type { InboundChannelMessage } from './types'
import { buildSessionKey } from './types'

export class ChannelSessionManager {
  constructor(
    private store: ChannelStore,
    private threadStore: ThreadDataStore
  ) {}

  resolveThread(message: InboundChannelMessage): ChannelSession {
    const sessionKey = buildSessionKey(message.platform, message.chatId, message.threadId)
    const existing = this.store.listSessions().find((entry) => entry.sessionKey === sessionKey)
    if (existing) {
      const updated: ChannelSession = {
        ...existing,
        chatName: message.chatName ?? existing.chatName,
        userName: message.userName ?? existing.userName,
        lastMessageAt: new Date().toISOString()
      }
      this.store.upsertSession(updated)
      return updated
    }

    const threadName = this.buildThreadName(message)
    const thread = this.threadStore.createThread(threadName)
    const createdAt = new Date().toISOString()
    const session: ChannelSession = {
      sessionKey,
      platform: message.platform,
      chatId: message.chatId,
      threadId: message.threadId,
      chatName: message.chatName,
      userId: message.userId,
      userName: message.userName,
      chatType: message.chatType,
      mousseThreadId: thread.id,
      lastMessageAt: createdAt,
      createdAt
    }
    this.store.upsertSession(session)
    return session
  }

  private buildThreadName(message: InboundChannelMessage): string {
    const platformLabel =
      message.platform.charAt(0).toUpperCase() + message.platform.slice(1)
    if (message.chatType === 'dm') {
      return `${platformLabel} DM: ${message.userName ?? message.userId}`
    }
    if (message.chatName) {
      return `${platformLabel}: ${message.chatName}`
    }
    return `${platformLabel}: ${message.chatId}`
  }
}
