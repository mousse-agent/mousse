/**
 * MMS contract types for CLI code, re-exported from the real src/mms modules.
 * CLI modules import types from here or serviceLocator — not from ../mms/* directly.
 */

import type { MmsOptions, MousseMainService } from '../mms/MousseMainService'
import type { StartupPlatform } from '../mms/startup'

export type { MmsOptions, MousseMainService }
export type { MousseConf } from '../mms/config/types'
export type { MousseConfigStore } from '../mms/config/MousseConfigStore'
export type { SettingsStore } from '../mms/settings/SettingsStore'
export type { LoginSession } from '../mms/providers/LoginSession'
export type { ProviderAuthService } from '../mms/providers/ProviderAuthService'
export type { ProjectManager } from '../mms/data/ProjectManager'
export type { ThreadDataStore } from '../mms/data/ThreadDataStore'
export type { OrchestratorService } from '../mms/orchestrator/OrchestratorService'
export type { ScheduledJobService } from '../mms/scheduled/ScheduledJobService'
export type { ChannelService } from '../mms/channels/ChannelService'
export type { AgentRegistry } from '../mms/agents/AgentRegistry'
export type { TaskQueue } from '../mms/tasks/TaskQueue'
export type { MmsEvent, MmsEventChannel, MmsEventBus } from '../mms/events'
export type { StartupPlatform }

export interface MousseMainServiceModule {
  MousseMainService: {
    create(opts?: MmsOptions): Promise<MousseMainService>
  }
}

export interface MmsStartupModule {
  detectPlatform(): StartupPlatform
  installStartup(opts: { cliPath: string; homeDir: string }): Promise<void>
  uninstallStartup(): Promise<void>
  startupStatus(): Promise<{ installed: boolean; detail: string }>
}
