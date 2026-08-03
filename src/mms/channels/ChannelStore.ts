import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'fs'
import { basename, dirname, join } from 'path'
import type {
  ChannelConfig,
  ChannelDirectoryEntry,
  ChannelPlatform,
  ChannelSession
} from '../../shared/types'
import type { MousseConfigStore } from '../config/MousseConfigStore'
import {
  getChannelsDirectoryPath,
  getChannelsDir,
  getChannelsLockPath,
  getChannelsSessionsPath
} from '../data/paths'
import { withFileLock } from '../scheduled/fileLock'

export function defaultChannelConfig(): ChannelConfig {
  return {
    platforms: {
      telegram: { enabled: false, allowedUserIds: [], allowAllUsers: false },
      discord: { enabled: false, allowedUserIds: [], allowAllUsers: false },
      webhook: {
        enabled: false,
        allowedUserIds: [],
        allowAllUsers: true,
        webhookPort: 18789,
        webhookSecret: ''
      }
    },
    filterSilenceNarration: true,
    unauthorizedDmBehavior: 'pair'
  }
}

function ensureChannelsDir(): void {
  mkdirSync(getChannelsDir(), { recursive: true })
}

function atomicWriteJson(path: string, data: unknown): void {
  ensureChannelsDir()
  const tmpPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  )
  const payload = JSON.stringify(data, null, 2)
  writeFileSync(tmpPath, payload, 'utf-8')
  renameSync(tmpPath, path)
}

function applyEnvOverrides(config: ChannelConfig): ChannelConfig {
  const next = structuredClone(config)
  const telegramToken = process.env.MOUSSE_TELEGRAM_BOT_TOKEN?.trim()
  if (telegramToken) {
    next.platforms.telegram.enabled = true
    next.platforms.telegram.token = telegramToken
  }
  const discordToken = process.env.MOUSSE_DISCORD_BOT_TOKEN?.trim()
  if (discordToken) {
    next.platforms.discord.enabled = true
    next.platforms.discord.token = discordToken
  }
  const webhookPort = process.env.MOUSSE_CHANNELS_WEBHOOK_PORT?.trim()
  if (webhookPort) {
    const parsed = Number(webhookPort)
    if (!Number.isNaN(parsed) && parsed > 0) {
      next.platforms.webhook.webhookPort = parsed
    }
  }
  return next
}

function mergeChannelDefaults(raw: ChannelConfig): ChannelConfig {
  return {
    ...defaultChannelConfig(),
    ...raw,
    platforms: {
      ...defaultChannelConfig().platforms,
      ...raw.platforms
    }
  }
}

export class ChannelStore {
  constructor(private readonly config: MousseConfigStore) {}

  getConfig(): ChannelConfig {
    ensureChannelsDir()
    return withFileLock(getChannelsLockPath(), () => {
      const raw = this.config.getChannelsSection()
      return applyEnvOverrides(mergeChannelDefaults(raw))
    })
  }

  saveConfig(config: ChannelConfig): ChannelConfig {
    return withFileLock(getChannelsLockPath(), () => {
      this.config.updateChannelsSection(config)
      return applyEnvOverrides(config)
    })
  }

  updateConfig(patch: Partial<ChannelConfig>): ChannelConfig {
    const current = this.getConfig()
    const next: ChannelConfig = {
      ...current,
      ...patch,
      platforms: {
        ...current.platforms,
        ...(patch.platforms ?? {})
      }
    }
    return this.saveConfig(next)
  }

  addAllowedUser(platform: ChannelPlatform, userId: string): ChannelConfig {
    const config = this.getConfig()
    const platformConfig = config.platforms[platform]
    const allowed = new Set(platformConfig.allowedUserIds ?? [])
    allowed.add(userId)
    platformConfig.allowedUserIds = [...allowed]
    return this.saveConfig(config)
  }

  listSessions(): ChannelSession[] {
    ensureChannelsDir()
    if (!existsSync(getChannelsSessionsPath())) {
      atomicWriteJson(getChannelsSessionsPath(), [])
    }
    return withFileLock(getChannelsLockPath(), () => {
      try {
        return JSON.parse(readFileSync(getChannelsSessionsPath(), 'utf-8')) as ChannelSession[]
      } catch {
        return []
      }
    })
  }

  saveSessions(sessions: ChannelSession[]): void {
    withFileLock(getChannelsLockPath(), () => {
      atomicWriteJson(getChannelsSessionsPath(), sessions)
    })
  }

  upsertSession(session: ChannelSession): ChannelSession[] {
    const sessions = this.listSessions()
    const index = sessions.findIndex((entry) => entry.sessionKey === session.sessionKey)
    if (index >= 0) {
      sessions[index] = session
    } else {
      sessions.push(session)
    }
    this.saveSessions(sessions)
    return sessions
  }

  getDirectory(): Record<ChannelPlatform, ChannelDirectoryEntry[]> {
    ensureChannelsDir()
    if (!existsSync(getChannelsDirectoryPath())) {
      return { telegram: [], discord: [], webhook: [] }
    }
    try {
      const data = JSON.parse(readFileSync(getChannelsDirectoryPath(), 'utf-8')) as {
        platforms?: Record<string, ChannelDirectoryEntry[]>
      }
      return {
        telegram: data.platforms?.telegram ?? [],
        discord: data.platforms?.discord ?? [],
        webhook: data.platforms?.webhook ?? []
      }
    } catch {
      return { telegram: [], discord: [], webhook: [] }
    }
  }

  saveDirectory(platforms: Record<ChannelPlatform, ChannelDirectoryEntry[]>): string {
    const payload = {
      updatedAt: new Date().toISOString(),
      platforms
    }
    atomicWriteJson(getChannelsDirectoryPath(), payload)
    return payload.updatedAt
  }

  rebuildDirectoryFromSessions(sessions: ChannelSession[]): string {
    const platforms: Record<ChannelPlatform, ChannelDirectoryEntry[]> = {
      telegram: [],
      discord: [],
      webhook: []
    }
    const seen = new Set<string>()

    for (const session of sessions) {
      const key = `${session.platform}:${session.chatId}:${session.threadId ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      platforms[session.platform].push({
        id: session.threadId ? `${session.chatId}:${session.threadId}` : session.chatId,
        name: session.chatName ?? session.chatId,
        type: session.chatType,
        threadId: session.threadId
      })
    }

    return this.saveDirectory(platforms)
  }
}

export function maskToken(token: string | undefined): string {
  if (!token) return ''
  if (token.length <= 8) return '••••••••'
  return `${token.slice(0, 4)}••••${token.slice(-4)}`
}

export function redactConfigForRenderer(config: ChannelConfig): ChannelConfig {
  const clone = structuredClone(config)
  for (const platform of Object.keys(clone.platforms) as ChannelPlatform[]) {
    const entry = clone.platforms[platform]
    if (entry.token) {
      entry.token = maskToken(entry.token)
    }
    if (entry.webhookSecret) {
      entry.webhookSecret = maskToken(entry.webhookSecret)
    }
  }
  return clone
}
