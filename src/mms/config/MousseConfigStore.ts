import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getDefaultSettings, type MousseSettings } from '../../shared/settings'
import {
  getChannelsConfigPath,
  getMousseConfPath,
  getMousseHomeDir,
  getScheduledJobsPath
} from '../data/paths'
import { defaultChannelConfig } from '../channels/ChannelStore'
import type {
  MmsConfigSection,
  MousseAgentsConfig,
  MousseConf,
  MousseProvidersConfig,
  MousseSettingsSection,
  ScheduledConfigSection,
  ScheduledJobDefinition
} from './types'
import { MOUSSE_CONF_VERSION } from './types'
import type { ChannelConfig } from '../../shared/types'
import type { ScheduledJob } from '../../shared/types'

function deepMerge<T extends Record<string, unknown>>(base: T, partial: Partial<T>): T {
  const result = { ...base }
  for (const key of Object.keys(partial) as Array<keyof T>) {
    const value = partial[key]
    if (value === undefined) continue
    const existing = base[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMerge(
        existing as Record<string, unknown>,
        value as Record<string, unknown>
      ) as T[keyof T]
    } else {
      result[key] = value as T[keyof T]
    }
  }
  return result
}

function defaultMmsSection(): MmsConfigSection {
  return { autostart: false, logLevel: 'info' }
}

function splitSettings(full: MousseSettings): {
  settings: MousseSettingsSection
  providers: MousseProvidersConfig
  agents: MousseAgentsConfig
} {
  return {
    settings: {
      profile: full.profile,
      appearance: full.appearance,
      integrations: full.integrations
    },
    providers: { ...full.provider },
    agents: { ...full.agents }
  }
}

function mergeSettings(
  settings: MousseSettingsSection,
  providers: MousseProvidersConfig,
  agents: MousseAgentsConfig
): MousseSettings {
  return {
    ...settings,
    provider: { ...providers },
    agents: { ...agents }
  }
}

function jobToDefinition(job: ScheduledJob): ScheduledJobDefinition {
  return {
    id: job.id,
    name: job.name,
    prompt: job.prompt,
    schedule: job.schedule,
    enabled: job.enabled,
    threadId: job.threadId,
    projectId: job.projectId,
    createThread: job.createThread,
    repeat: job.repeat?.times
      ? { times: job.repeat.times, completed: job.repeat.completed }
      : undefined,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  }
}

function defaultConf(): MousseConf {
  const defaults = getDefaultSettings()
  const split = splitSettings(defaults)
  return {
    version: MOUSSE_CONF_VERSION,
    settings: split.settings,
    providers: split.providers,
    agents: split.agents,
    scheduled: { enabled: true, jobs: [] },
    channels: defaultChannelConfig(),
    mms: defaultMmsSection()
  }
}

function writeMigratedMarker(originalPath: string): void {
  try {
    writeFileSync(`${originalPath}.migrated`, new Date().toISOString(), 'utf-8')
  } catch {
    /* best effort */
  }
}

function atomicWriteJson(path: string, data: unknown): void {
  const dir = join(path, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const tmpPath = join(tmpdir(), `mousse-conf-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmpPath, path)
}

export class MousseConfigStore {
  private conf: MousseConf
  private confPath: string
  private watcher: FSWatcher | null = null
  private reloadListeners = new Set<() => void>()

  private constructor(confPath: string, conf: MousseConf) {
    this.confPath = confPath
    this.conf = conf
  }

  static load(homeDir?: string): MousseConfigStore {
    if (homeDir) {
      process.env.MOUSSE_HOME = homeDir
    }
    const confPath = getMousseConfPath()
    const conf = MousseConfigStore.readOrMigrate(confPath)
    return new MousseConfigStore(confPath, conf)
  }

  static readOrMigrate(confPath: string): MousseConf {
    if (existsSync(confPath)) {
      try {
        const raw = JSON.parse(readFileSync(confPath, 'utf-8')) as Partial<MousseConf>
        return MousseConfigStore.normalize(raw)
      } catch (err) {
        console.error('[MousseConfigStore] Failed to parse mousse.conf, using defaults:', err)
      }
    }

    const migrated = MousseConfigStore.migrateLegacyConfig()
    atomicWriteJson(confPath, migrated)
    return migrated
  }

  private static normalize(raw: Partial<MousseConf>): MousseConf {
    const base = defaultConf()
    return {
      version: raw.version ?? MOUSSE_CONF_VERSION,
      settings: deepMerge(
        base.settings as unknown as Record<string, unknown>,
        (raw.settings ?? {}) as Partial<Record<string, unknown>>
      ) as unknown as MousseSettingsSection,
      providers: { ...base.providers, ...(raw.providers ?? {}) },
      agents: deepMerge(
        base.agents as unknown as Record<string, unknown>,
        (raw.agents ?? {}) as Partial<Record<string, unknown>>
      ) as unknown as MousseAgentsConfig,
      scheduled: {
        enabled: raw.scheduled?.enabled ?? base.scheduled.enabled,
        jobs: raw.scheduled?.jobs ?? base.scheduled.jobs
      },
      channels: deepMerge(
        base.channels as unknown as Record<string, unknown>,
        (raw.channels ?? {}) as Partial<Record<string, unknown>>
      ) as unknown as ChannelConfig,
      mms: { ...base.mms, ...(raw.mms ?? {}) }
    }
  }

  private static migrateLegacyConfig(): MousseConf {
    const conf = defaultConf()
    const home = getMousseHomeDir()
    const settingsPath = join(home, 'settings.json')

    if (existsSync(settingsPath) && !existsSync(`${settingsPath}.migrated`)) {
      try {
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Partial<MousseSettings>
        const merged = deepMerge(
          getDefaultSettings() as unknown as Record<string, unknown>,
          parsed as Partial<Record<string, unknown>>
        ) as unknown as MousseSettings
        const split = splitSettings(merged)
        conf.settings = split.settings
        conf.providers = split.providers
        conf.agents = split.agents
        writeMigratedMarker(settingsPath)
      } catch (err) {
        console.error('[MousseConfigStore] settings.json migration failed:', err)
      }
    }

    const channelsPath = getChannelsConfigPath()
    if (existsSync(channelsPath) && !existsSync(`${channelsPath}.migrated`)) {
      try {
        const raw = JSON.parse(readFileSync(channelsPath, 'utf-8')) as ChannelConfig
        conf.channels = deepMerge(
          defaultChannelConfig() as unknown as Record<string, unknown>,
          raw as unknown as Partial<Record<string, unknown>>
        ) as unknown as ChannelConfig
        writeMigratedMarker(channelsPath)
      } catch (err) {
        console.error('[MousseConfigStore] channels config migration failed:', err)
      }
    }

    const jobsPath = getScheduledJobsPath()
    if (existsSync(jobsPath) && !existsSync(`${jobsPath}.migrated`)) {
      try {
        const jobs = JSON.parse(readFileSync(jobsPath, 'utf-8')) as ScheduledJob[]
        conf.scheduled.jobs = jobs.map(jobToDefinition)
        writeMigratedMarker(jobsPath)
      } catch (err) {
        console.error('[MousseConfigStore] scheduled jobs migration failed:', err)
      }
    }

    return conf
  }

  getPath(): string {
    return this.confPath
  }

  getSnapshot(): MousseConf {
    return structuredClone(this.conf)
  }

  getSettingsSection(): MousseSettingsSection {
    return structuredClone(this.conf.settings)
  }

  getProvidersSection(): MousseProvidersConfig {
    return structuredClone(this.conf.providers)
  }

  getAgentsSection(): MousseAgentsConfig {
    return structuredClone(this.conf.agents)
  }

  getScheduledSection(): ScheduledConfigSection {
    return structuredClone(this.conf.scheduled)
  }

  getChannelsSection(): ChannelConfig {
    return structuredClone(this.conf.channels)
  }

  getMmsSection(): MmsConfigSection {
    return structuredClone(this.conf.mms)
  }

  /** Dotted-path read access (CLI `config get`); without a path returns the full snapshot. */
  get(): MousseConf
  get(path: string): unknown
  get(path?: string): unknown {
    const snapshot = this.getSnapshot()
    if (!path) return snapshot
    return getAtPath(snapshot as unknown as Record<string, unknown>, path.split('.').filter(Boolean))
  }

  /** Dotted-path write access (CLI `config set`). Call save() to persist. */
  set(path: string, value: unknown): void {
    const segments = path.split('.').filter(Boolean)
    if (segments.length === 0) {
      throw new Error('config set requires a key path')
    }
    const sections = ['settings', 'providers', 'agents', 'scheduled', 'channels', 'mms']
    if (!sections.includes(segments[0])) {
      throw new Error(`Unknown config section '${segments[0]}'. Expected one of: ${sections.join(', ')}`)
    }
    setAtPath(this.conf as unknown as Record<string, unknown>, segments, value)
  }

  /** Flattened dotted-key listing (CLI `config list`), optionally filtered by prefix. */
  list(prefix?: string): Record<string, unknown> {
    const flat: Record<string, unknown> = {}
    flattenInto(flat, this.getSnapshot() as unknown as Record<string, unknown>, '')
    if (!prefix) return flat
    const filtered: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(flat)) {
      if (key === prefix || key.startsWith(`${prefix}.`)) filtered[key] = value
    }
    return filtered
  }

  save(): void {
    this.persist()
  }

  /** Assemble full MousseSettings for SettingsStore compatibility. */
  assembleSettings(): MousseSettings {
    return mergeSettings(this.conf.settings, this.conf.providers, this.conf.agents)
  }

  updateSettingsSection(partial: Partial<MousseSettingsSection>): void {
    this.conf.settings = deepMerge(
      this.conf.settings as unknown as Record<string, unknown>,
      partial as Partial<Record<string, unknown>>
    ) as unknown as MousseSettingsSection
    this.persist()
  }

  updateProvidersSection(partial: Partial<MousseProvidersConfig>): void {
    this.conf.providers = { ...this.conf.providers, ...partial }
    this.persist()
  }

  updateAgentsSection(partial: Partial<MousseAgentsConfig>): void {
    this.conf.agents = deepMerge(
      this.conf.agents as unknown as Record<string, unknown>,
      partial as Partial<Record<string, unknown>>
    ) as unknown as MousseAgentsConfig
    this.persist()
  }

  updateScheduledSection(partial: Partial<ScheduledConfigSection>): void {
    if (partial.enabled !== undefined) {
      this.conf.scheduled.enabled = partial.enabled
    }
    if (partial.jobs !== undefined) {
      this.conf.scheduled.jobs = partial.jobs
    }
    this.persist()
  }

  updateChannelsSection(config: ChannelConfig): void {
    this.conf.channels = structuredClone(config)
    this.persist()
  }

  updateMmsSection(partial: Partial<MmsConfigSection>): void {
    this.conf.mms = { ...this.conf.mms, ...partial }
    this.persist()
  }

  /** Apply a MousseSettingsUpdate-shaped patch across settings/providers/agents sections. */
  applySettingsPatch(partial: Partial<MousseSettings>): void {
    if (partial.profile || partial.appearance || partial.integrations) {
      this.updateSettingsSection({
        ...(partial.profile ? { profile: partial.profile as MousseSettingsSection['profile'] } : {}),
        ...(partial.appearance
          ? { appearance: partial.appearance as MousseSettingsSection['appearance'] }
          : {}),
        ...(partial.integrations
          ? { integrations: partial.integrations as MousseSettingsSection['integrations'] }
          : {})
      })
    }
    if (partial.provider) {
      this.updateProvidersSection(partial.provider)
    }
    if (partial.agents) {
      this.updateAgentsSection(partial.agents as Partial<MousseAgentsConfig>)
    }
  }

  persist(): void {
    atomicWriteJson(this.confPath, this.conf)
  }

  reloadFromDisk(): boolean {
    if (!existsSync(this.confPath)) return false
    try {
      const mtime = statSync(this.confPath).mtimeMs
      const raw = JSON.parse(readFileSync(this.confPath, 'utf-8')) as Partial<MousseConf>
      this.conf = MousseConfigStore.normalize(raw)
      void mtime
      for (const listener of this.reloadListeners) {
        listener()
      }
      return true
    } catch {
      return false
    }
  }

  startWatching(onReload?: () => void): void {
    if (onReload) {
      this.reloadListeners.add(onReload)
    }
    if (this.watcher) return
    const dir = join(this.confPath, '..')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    this.watcher = watch(this.confPath, () => {
      this.reloadFromDisk()
    })
  }

  stopWatching(): void {
    this.watcher?.close()
    this.watcher = null
    this.reloadListeners.clear()
  }
}

function getAtPath(obj: Record<string, unknown>, segments: string[]): unknown {
  let current: unknown = obj
  for (const segment of segments) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function setAtPath(obj: Record<string, unknown>, segments: string[], value: unknown): void {
  let current = obj
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]
    const next = current[segment]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      current[segment] = {}
    }
    current = current[segment] as Record<string, unknown>
  }
  current[segments[segments.length - 1]] = value
}

function flattenInto(target: Record<string, unknown>, obj: Record<string, unknown>, prefix: string): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenInto(target, value as Record<string, unknown>, path)
    } else {
      target[path] = value
    }
  }
}

export { jobToDefinition, mergeSettings, splitSettings }
