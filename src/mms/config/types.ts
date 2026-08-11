import type { AgentTypeId } from '../../shared/settings'
import type { ChannelConfig } from '../../shared/types'
import type { JobSchedule, ScheduledJob } from '../../shared/types'
import type { MousseSettings } from '../../shared/settings'
import type { MousseFeatureFlags } from '../../shared/featureFlags'

export const MOUSSE_CONF_VERSION = 1

export type MmsLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface MmsConfigSection {
  autostart: boolean
  logLevel: MmsLogLevel
}

export interface MousseProvidersConfig {
  llmProvider: string
  model: string
}

export interface MousseAgentsConfig {
  enabled: Record<AgentTypeId, boolean>
  llmProvider: Record<AgentTypeId, string>
  model: Record<AgentTypeId, string>
  headless: Record<AgentTypeId, boolean>
  defaultCli?: AgentTypeId
  permissionFlags?: Partial<Record<AgentTypeId, boolean>>
}

export type MousseSettingsSection = Pick<
  MousseSettings,
  'profile' | 'appearance' | 'notifications' | 'integrations' | 'title'
>

export interface ScheduledConfigSection {
  enabled: boolean
  jobs: ScheduledJobDefinition[]
}

/** Static job fields stored in mousse.conf (runtime state lives under ~/.mousse/scheduled/). */
export interface ScheduledJobDefinition {
  id: string
  name: string
  prompt: string
  schedule: JobSchedule
  enabled: boolean
  threadId?: string
  projectId?: string
  createThread?: boolean
  repeat?: { times: number; completed?: number }
  createdAt: string
  updatedAt: string
}

export interface ScheduledJobRuntime {
  state?: ScheduledJob['state']
  nextRunAt?: string | null
  lastRunAt?: string
  lastStatus?: ScheduledJob['lastStatus']
  lastError?: string
  pausedAt?: string
  pausedReason?: string
  runHistory?: ScheduledJob['runHistory']
  repeat?: { times: number; completed: number }
  runClaim?: ScheduledJob['runClaim']
}

export interface MousseConf {
  version: number
  settings: MousseSettingsSection
  providers: MousseProvidersConfig
  agents: MousseAgentsConfig
  scheduled: ScheduledConfigSection
  channels: ChannelConfig
  mms: MmsConfigSection
  features: MousseFeatureFlags
}
