import type { ModelOverride } from '../../shared/providerInstances'
import type { ChannelSession } from '../../shared/types'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import { ChannelStore } from './ChannelStore'
import type { InboundChannelMessage } from './types'
import { buildSessionKey } from './types'

export class ChannelSessionManager {
  constructor(
    private store: ChannelStore,
    private threadStore: ThreadDataStore,
    /**
     * Migrate-on-read for a session model (SPEC §13.8): adds the provider instance an older
     * `llmProvider` maps to, so the next save writes the instance shape. Never throws.
     */
    private migrateModel: (override: ModelOverride) => ModelOverride = (override) => override
  ) {}

  resolveThread(message: InboundChannelMessage): ChannelSession {
    const sessionKey = buildSessionKey(message.platform, message.chatId, message.threadId)
    const existing = this.store.listSessions().find((entry) => entry.sessionKey === sessionKey)
    if (existing) {
      const updated: ChannelSession = {
        ...existing,
        ...(existing.modelOverride ? { modelOverride: this.migrateModel(existing.modelOverride) } : {}),
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

  getSession(sessionKey: string): ChannelSession | undefined {
    return this.store.listSessions().find((entry) => entry.sessionKey === sessionKey)
  }

  setModelOverride(
    sessionKey: string,
    override: ChannelSession['modelOverride'] | undefined
  ): ChannelSession | undefined {
    const existing = this.getSession(sessionKey)
    if (!existing) return undefined
    const updated: ChannelSession = { ...existing }
    if (override) {
      updated.modelOverride = this.migrateModel(override)
    } else {
      delete updated.modelOverride
    }
    this.store.upsertSession(updated)
    return updated
  }

  /** Attaches the session to a personal bot (`/bot <name>`), or detaches it with undefined. */
  setBot(sessionKey: string, botId: string | undefined): ChannelSession | undefined {
    const existing = this.getSession(sessionKey)
    if (!existing) return undefined
    const updated: ChannelSession = { ...existing }
    if (botId) updated.botId = botId
    else delete updated.botId
    this.store.upsertSession(updated)
    return updated
  }

  /**
   * Rebind this channel session to an existing Mousse thread without wiping history.
   * Unlike resetSession (/new), does not create a thread or clear model overrides.
   */
  bindThread(sessionKey: string, mousseThreadId: string): ChannelSession | undefined {
    const existing = this.getSession(sessionKey)
    if (!existing) return undefined
    const thread = this.threadStore.getThread(mousseThreadId)
    if (!thread) return undefined
    const updated: ChannelSession = {
      ...existing,
      mousseThreadId: thread.id,
      lastMessageAt: new Date().toISOString()
    }
    this.store.upsertSession(updated)
    return updated
  }

  resetSession(
    messageOrSession: InboundChannelMessage | ChannelSession,
    title?: string
  ): ChannelSession {
    const isSession = 'sessionKey' in messageOrSession
    const sessionKey = isSession
      ? messageOrSession.sessionKey
      : buildSessionKey(
          messageOrSession.platform,
          messageOrSession.chatId,
          messageOrSession.threadId
        )

    const existing = this.getSession(sessionKey)
    const base = {
      sessionKey,
      platform: messageOrSession.platform,
      chatId: messageOrSession.chatId,
      threadId: messageOrSession.threadId,
      chatName: messageOrSession.chatName ?? existing?.chatName,
      userId: messageOrSession.userId ?? existing?.userId,
      userName: messageOrSession.userName ?? existing?.userName,
      chatType: messageOrSession.chatType
    }

    let threadName: string
    if (title?.trim()) {
      threadName = title.trim()
    } else if (!isSession) {
      threadName = `${this.buildThreadName(messageOrSession)} (new)`
    } else {
      const platformLabel =
        base.platform.charAt(0).toUpperCase() + base.platform.slice(1)
      const label =
        base.chatType === 'dm'
          ? `${platformLabel} DM: ${base.userName ?? base.userId ?? base.chatId}`
          : base.chatName
            ? `${platformLabel}: ${base.chatName}`
            : `${platformLabel}: ${base.chatId}`
      threadName = `${label} (new)`
    }

    const thread = this.threadStore.createThread(threadName)
    const now = new Date().toISOString()
    const session: ChannelSession = {
      ...base,
      mousseThreadId: thread.id,
      lastMessageAt: now,
      createdAt: existing?.createdAt ?? now
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
