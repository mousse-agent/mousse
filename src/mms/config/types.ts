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
  /**
   * Provider instances of this profile, keyed by instance id (SPEC §13.8). Seeded on load by
   * `ProviderInstanceService`; stored entries are never rewritten. Kept as stored (malformed
   * entries included) and validated when read.
   */
  instances?: Record<string, unknown>
  /** Seed version `instances` was last seeded with (`PROVIDER_INSTANCE_SEED_VERSION`). */
  instancesSeedVersion?: number
  /**
   * Model preferences per instance id (hidden, order, favorites, custom models), owned by the
   * harness gateway and validated when read.
   */
  modelPrefs?: Record<string, unknown>
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
  'profile' | 'appearance' | 'notifications' | 'shortcuts' | 'permissions' | 'context' | 'agentAccess' | 'integrations' | 'title'
>

/** Default port of the loopback listener that receives job webhooks. */
export const DEFAULT_SCHEDULED_WEBHOOK_PORT = 18790

export interface ScheduledConfigSection {
  enabled: boolean
  jobs: ScheduledJobDefinition[]
  /** The loopback listener for job webhooks; off until a job's webhook is enabled. */
  webhooks?: { enabled: boolean; port: number }
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
  selection?: ScheduledJob['selection']
  mode?: ScheduledJob['mode']
  workspace?: ScheduledJob['workspace']
  createdBy?: ScheduledJob['createdBy']
  accessCap?: ScheduledJob['accessCap']
  trigger?: ScheduledJob['trigger']
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
  pendingOccurrence?: ScheduledJob['pendingOccurrence']
  pendingTrigger?: ScheduledJob['pendingTrigger']
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
