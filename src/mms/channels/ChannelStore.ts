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

function ensureChannelsDir(directory: string): void {
  mkdirSync(directory, { recursive: true })
}

function atomicWriteJson(path: string, data: unknown): void {
  ensureChannelsDir(dirname(path))
  const tmpPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  )
  const payload = JSON.stringify(data, null, 2)
  writeFileSync(tmpPath, payload, 'utf-8')
  renameSync(tmpPath, path)
}

function applyEnvOverrides(config: ChannelConfig, environment: NodeJS.ProcessEnv): ChannelConfig {
  const next = structuredClone(config)
  const telegramToken = environment.MOUSSE_TELEGRAM_BOT_TOKEN?.trim()
  if (telegramToken) {
    next.platforms.telegram.enabled = true
    next.platforms.telegram.token = telegramToken
  }
  const discordToken = environment.MOUSSE_DISCORD_BOT_TOKEN?.trim()
  if (discordToken) {
    next.platforms.discord.enabled = true
    next.platforms.discord.token = discordToken
  }
  const webhookPort = environment.MOUSSE_CHANNELS_WEBHOOK_PORT?.trim()
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
  private readonly directory: string
  private readonly lockPath: string
  private readonly sessionsPath: string
  private readonly directoryPath: string
  private readonly environment: NodeJS.ProcessEnv
  constructor(
    private readonly config: MousseConfigStore,
    options: { inheritEnvironment?: boolean; environment?: NodeJS.ProcessEnv } = {}
  ) {
    // Only the explicit legacy/default profile may inherit installation startup
    // credentials. Capture them once: profile switching never changes a store.
    this.environment = { ...(options.environment ?? (options.inheritEnvironment === false ? {} : process.env)) }
    this.directory = join(config.getHomeDir(), 'channels')
    this.lockPath = join(this.directory, '.channels.lock')
    this.sessionsPath = join(this.directory, 'sessions.json')
    this.directoryPath = join(this.directory, 'directory.json')
  }

  getConfig(): ChannelConfig {
    ensureChannelsDir(this.directory)
    return withFileLock(this.lockPath, () => {
      const raw = this.config.getChannelsSection()
      return applyEnvOverrides(mergeChannelDefaults(raw), this.environment)
    })
  }

  getPairingDirectory(): string { return join(this.directory, 'pairing') }

  saveConfig(config: ChannelConfig): ChannelConfig {
    return withFileLock(this.lockPath, () => {
      this.config.updateChannelsSection(config)
      return applyEnvOverrides(config, this.environment)
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
    ensureChannelsDir(this.directory)
    if (!existsSync(this.sessionsPath)) {
      atomicWriteJson(this.sessionsPath, [])
    }
    return withFileLock(this.lockPath, () => {
      try {
        return JSON.parse(readFileSync(this.sessionsPath, 'utf-8')) as ChannelSession[]
      } catch {
        return []
      }
    })
  }

  saveSessions(sessions: ChannelSession[]): void {
    withFileLock(this.lockPath, () => {
      atomicWriteJson(this.sessionsPath, sessions)
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
    ensureChannelsDir(this.directory)
    if (!existsSync(this.directoryPath)) {
      return { telegram: [], discord: [], webhook: [] }
    }
    try {
      const data = JSON.parse(readFileSync(this.directoryPath, 'utf-8')) as {
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
    atomicWriteJson(this.directoryPath, payload)
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
