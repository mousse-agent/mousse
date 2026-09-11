import { homedir } from 'os'
import { join } from 'path'
import { MousseConfigStore } from './config/MousseConfigStore'
import { MmsProfileServices } from './MmsProfileServices'
import type { MmsOptions } from './MmsOptions'
import { ProviderAuthService } from './providers/ProviderAuthService'
import { DomainHandlerRegistry } from './protocol/domainRegistry'
import { acquireMmsOwnerLease, canonicalizeHome, type MmsOwnerHandle } from './ownership/MmsOwnerLease'
import { createInstallationPaths, createProfilePaths } from './profiles/paths'
import { ProfileManager } from './profiles/ProfileManager'
import { ProfileMigrationService } from './profiles/migration/MigrationService'
import {
  createControlStoreCredentialAdapter,
  createRetainingGitWorktreeAdapter
} from './profiles/migration/adapters'
import { ProfileHost } from './profiles/ProfileHost'
import { registerProfileDomain } from './profiles/profileDomain'
import type { ProfileId } from '../shared/profiles/ids'
import { registerAgentDefinitionMethods } from './agentDefinitions/registerMethods'
import { registerWorkflowDefinitionMethods } from './workflows/registerDefinitionMethods'
import { registerWorkflowRunMethods } from './workflows/registerRunMethods'
import { registerIntegrationMethods, type IntegrationDomainRegistration } from './integrations/registerMethods'
import { ConnectionCommandRouter } from './protocol/connectionCommands'
import { registerBrowserMethods, type BrowserDomainRegistration } from './browser/registerBrowserMethods'
import type { BrowserRuntimePort } from '../shared/browser/runtime'
import { BrowserAutomationError } from './browser/automation/BrowserSessionManager'
import { mainBrowserBinding } from './platform/mainBrowserBinding'
import type { BrowserWorkflowRequest } from '../shared/browser/automation'

export type { MmsOptions } from './MmsOptions'

/** One installation owner and shared provider catalog; profile services acquire no lease. */
export class MousseMainService extends MmsProfileServices {
  readonly browserCommandRouter = new ConnectionCommandRouter()
  private browserDomains?: BrowserDomainRegistration
  private installationLease: MmsOwnerHandle | null
  private installationStopped = false
  private installationStopOperation?: Promise<void>
  private profileHost: ProfileHost | null = null
  private integrationDomains: IntegrationDomainRegistration | null = null
  private readonly domainCleanupSubscriptions: Array<() => void> = []

  private constructor(
    config: MousseConfigStore,
    options: MmsOptions | undefined,
    owner: MmsOwnerHandle | null,
    profileHome: string,
    providers: ProviderAuthService,
    domains: DomainHandlerRegistry,
    installationHome: string,
    profileId: string,
    isDefault: boolean
  ) {
    super(config, options, owner, profileHome, {
      providerAuth: providers,
      domains,
      installationHome,
      personal: true,
      profileId,
      allowLegacyProjectData: isDefault,
      inheritChannelEnvironment: isDefault,
      includeExternalCliConfigs: isDefault
    })
    this.installationLease = owner
  }

  static async create(options?: MmsOptions): Promise<MousseMainService> {
    const home = canonicalizeHome(options?.homeDir ?? process.env.MOUSSE_HOME ?? join(homedir(), '.mousse'))
    // Installation identity only. Profile bind/switch never changes this.
    process.env.MOUSSE_HOME = home
    const owner = options?.requireOwnership === false ? null : acquireMmsOwnerLease(home, {
      kind: options?.ownerKind ?? (options?.headless ? 'cli' : 'gui'),
      version: options?.version ?? process.env.npm_package_version,
      build: options?.build
    })
    let providers: ProviderAuthService | undefined
    let service: MousseMainService | undefined
    try {
      const installation = createInstallationPaths(home)
      providers = new ProviderAuthService(installation.authJson)
      await providers.init()

      const manager = ProfileManager.open(installation)
      const migration = new ProfileMigrationService(installation, manager)
      migration.run({
        adapters: {
          credentials: createControlStoreCredentialAdapter(),
          gitWorktrees: createRetainingGitWorktreeAdapter()
        }
      })
      if (!manager.isInitialized()) manager.initializeFresh()

      const defaultId = manager.getDefaultProfileId()
      const defaultPaths = createProfilePaths(installation, defaultId)
      const installationConfig = MousseConfigStore.loadInstallation(home)
      const profileConfig = MousseConfigStore.loadProfile(defaultPaths.root, installationConfig)
      const domains = new DomainHandlerRegistry()

      service = new MousseMainService(
        profileConfig,
        options,
        owner,
        defaultPaths.root,
        providers,
        domains,
        home,
        defaultId,
        true
      )
      const host = new ProfileHost({
        providerAuth: providers,
        domains,
        options: { ...options, homeDir: home },
        configureServices: (profile) => service!.configureProfileBrowser(profile)
      })
      host.attachDefault(service, defaultId)
      service.profileHost = host
      registerProfileDomain(domains, service)
      service.registerPlatformDomains()
      await service.initialize()
      return service
    } catch (error) {
      if (service) await service.stop()
      else { providers?.stop(); owner?.release() }
      throw error
    }
  }

  override getOwnerLease(): MmsOwnerHandle | null { return this.installationLease }
  override getOwnerRecord() { return this.installationLease?.owner ?? null }

  override getInstallationHost(): ProfileHost | null {
    return this.profileHost
  }

  async getProfileServices(profileId: string): Promise<MmsProfileServices> {
    const host = this.requireHost()
    if (profileId === this.profileId || profileId === host.getDefaultProfileId()) return this
    return host.getProfileServices(profileId)
  }

  override async start(): Promise<void> {
    await super.start()
    const host = this.profileHost
    if (!host) return
    for (const record of host.manager.list()) {
      if (record.status !== 'active' || record.id === this.profileId) continue
      const services = await host.getProfileServices(record.id)
      await services.start()
    }
  }

  override stop(options: { timeoutMs?: number } = {}): Promise<void> {
    this.beginShutdown()
    if (this.installationStopped) return Promise.resolve()
    if (this.installationStopOperation) return this.installationStopOperation
    const operation = (async () => {
      const results = await Promise.allSettled([this.profileHost?.stopAll(), super.stop(options)])
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason)
      // An unsuccessful drain still owns the installation. Releasing the lease
      // would allow a second daemon to write alongside unfinished personal work.
      if (errors.length) throw new AggregateError(errors, 'Failed to stop installation services')
      await this.browserCommandRouter.shutdown({ timeoutMs: options.timeoutMs ?? 30_000 })
      this.browserDomains?.dispose()
      this.browserDomains = undefined
      for (const unsubscribe of this.domainCleanupSubscriptions.splice(0)) unsubscribe()
      this.integrationDomains?.dispose()
      this.integrationDomains = null
      this.providerAuth.stop()
      this.installationLease?.release()
      this.installationLease = null
      this.installationStopped = true
    })()
    this.installationStopOperation = operation
    void operation.catch(() => { if (this.installationStopOperation === operation) this.installationStopOperation = undefined })
    return operation
  }

  private registerPlatformDomains(): void {
    const registeredProfiles = new WeakSet<MmsProfileServices>()
    const profile = async (profileId: string): Promise<MmsProfileServices> => {
      const services = await this.getProfileServices(profileId)
      if (!registeredProfiles.has(services)) {
        services.platform.onDispose(() => this.integrationDomains?.disposeProfile(profileId))
        registeredProfiles.add(services)
      }
      return services
    }
    registerAgentDefinitionMethods(this.domains, async (profileId, request) =>
      (await profile(profileId)).platform.agentDomain(request.method, request.params))
    registerWorkflowDefinitionMethods(this.domains, async (profileId) =>
      (await profile(profileId)).platform.workflowDefinitions)
    registerWorkflowRunMethods(this.domains, async (profileId) =>
      (await profile(profileId)).platform.workflowRuns)
    this.browserDomains = registerBrowserMethods(this.domains, async (profileId) =>
      (await profile(profileId)).platform.browser)
    this.integrationDomains = registerIntegrationMethods(this.domains, async (profileId) => {
      const services = await profile(profileId)
      return {
        profileId, catalog: services.platform.integrations,
        mcpManager: services.mcpManager, projects: services.projects, settings: services.settings
      }
    })
    const integrationDomains = this.integrationDomains
    this.domainCleanupSubscriptions.push(
      this.domains.onConnectionClosed((id) => integrationDomains.disconnect(id)),
      this.domains.onProfileDisposed((id) => integrationDomains.disposeProfile(id))
    )
  }

  private configureProfileBrowser(services: MmsProfileServices): void {
    services.platform.configureBrowser({ installationBrowserRoot: join(this.getHomeDir(), 'browser') })
    services.platform.setBrowserCommandRouter(this.browserCommandRouter)
    const runtime: BrowserRuntimePort = {
      resolveTarget: (context) => {
        if (context.profileId !== services.profileId) throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'Browser context belongs to another profile' })
        if (context.source !== 'gui') return { backend: 'managed-chromium' }
        const selected = services.platform.browser.selectedTarget(context.threadId)
        if (!selected) throw new BrowserAutomationError({ code: 'setup_required', message: 'Open Browser and choose Use with agent on a tab for this thread' })
        return selected
      },
      dispatch: async (context, name, args) => {
        const result = await services.platform.browser.dispatch(context, name, args)
        if (!result.ok) throw new BrowserAutomationError(result.error)
        return result.value
      }
    }
    services.platform.agentRuns.setBrowserRuntime(runtime)
    services.platform.workflowAgents.setBrowserRuntime(runtime)
    services.orchestrator.setBrowserRuntime(runtime)
    services.orchestrator.setMainAgentBrowserFactory((turn) => mainBrowserBinding(services, turn))
    services.platform.workflowRuns.configureAdapters({ browser: {
      kind: 'browser',
      invoke: (request) => {
        if (!['browser-session', 'browser-observe', 'browser-action', 'browser-extract', 'browser-task'].includes(request.nodeType)) {
          throw new BrowserAutomationError({ code: 'unsupported', message: 'Unsupported workflow browser node' })
        }
        return services.platform.browser.workflow.invoke({ ...request, nodeType: request.nodeType as BrowserWorkflowRequest['nodeType'], vision: false })
      }
    } })
  }

  private requireHost(): ProfileHost {
    if (!this.profileHost) throw new Error('Profile host is not attached')
    return this.profileHost
  }
}

export function asProfileHost(services: MmsProfileServices): ProfileHost | null {
  return services.getInstallationHost()
}

export type { ProfileId }
