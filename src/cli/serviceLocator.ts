export type {
  MmsOptions,
  MousseConf,
  MousseConfigStore,
  SettingsStore,
  LoginSession,
  ProviderAuthService,
  ProjectManager,
  ThreadDataStore,
  OrchestratorService,
  ScheduledJobService,
  ChannelService,
  AgentRegistry,
  TaskQueue,
  MmsEvent,
  MmsEventChannel,
  MmsEventBus,
  MousseMainService,
  MousseMainServiceModule,
  StartupPlatform,
  MmsStartupModule
} from './contract'

import type { MmsOptions, MmsStartupModule, MousseMainService, MousseMainServiceModule } from './contract'

export async function loadMousseMainService(): Promise<MousseMainServiceModule> {
  return import('../mms/MousseMainService')
}

export async function loadMmsEvents(): Promise<{ MmsEventBus: new () => import('./contract').MmsEventBus }> {
  return import('../mms/events')
}

export async function loadMmsStartup(): Promise<MmsStartupModule> {
  return import('../mms/startup')
}

export async function createMms(opts?: MmsOptions): Promise<MousseMainService> {
  const { MousseMainService } = await loadMousseMainService()
  return MousseMainService.create(opts)
}

export async function detectStartupPlatform(): Promise<import('./contract').StartupPlatform> {
  const startup = await loadMmsStartup()
  return startup.detectPlatform()
}

export async function installMmsStartup(opts: {
  cliPath: string
  homeDir: string
}): Promise<void> {
  const startup = await loadMmsStartup()
  return startup.installStartup(opts)
}

export async function uninstallMmsStartup(): Promise<void> {
  const startup = await loadMmsStartup()
  return startup.uninstallStartup()
}

export async function getMmsStartupStatus(): Promise<{ installed: boolean; detail: string }> {
  const startup = await loadMmsStartup()
  return startup.startupStatus()
}
