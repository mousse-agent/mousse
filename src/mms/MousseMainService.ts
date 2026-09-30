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
import { createBrowserSetupService, type BrowserSetupService } from './browser/BrowserSetupService'
import { createManagedBrowserInstaller } from './browser/install'
import { registerBrowserSetupMethods, type BrowserSetupDomainRegistration } from './browser/registerBrowserSetupMethods'

export type { MmsOptions } from './MmsOptions'

/** One installation owner and shared provider catalog; profile services acquire no lease. */
export class MousseMainService extends MmsProfileServices {
  readonly browserCommandRouter = new ConnectionCommandRouter()
  readonly browserSetup: BrowserSetupService
  private browserSetupDomains?: BrowserSetupDomainRegistration
  private readonly browserProfiles = new Set<MmsProfileServices>()
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
    this.browserSetup = createBrowserSetupService({
      root: join(installationHome, 'browser'),
      installer: createManagedBrowserInstaller(),
      activity: { activeManagedSessions: () => [...this.browserProfiles].reduce((sum, services) => sum + services.platform.getManagedBrowserActiveCount(), 0) }
    })
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
    this.browserSetup.beginShutdown()
    if (this.installationStopped) return Promise.resolve()
    if (this.installationStopOperation) return this.installationStopOperation
    const operation = (async () => {
      const results = await Promise.allSettled([this.profileHost?.stopAll(), super.stop(options), this.browserSetup.shutdown(options)])
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason)
      // An unsuccessful drain still owns the installation. Releasing the lease
      // would allow a second daemon to write alongside unfinished personal work.
      if (errors.length) throw new AggregateError(errors, 'Failed to stop installation services')
      await this.browserCommandRouter.shutdown({ timeoutMs: options.timeoutMs ?? 30_000 })
      this.browserDomains?.dispose()
      this.browserDomains = undefined
      this.browserSetupDomains?.dispose()
      this.browserSetupDomains = undefined
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
    this.browserSetupDomains = registerBrowserSetupMethods(this.domains, this.browserSetup)
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
    this.browserProfiles.add(services)
    services.platform.onDispose(() => {
      if (services.platform.getManagedBrowserActiveCount() > 0) throw new Error('Managed browser work is still draining')
      this.browserProfiles.delete(services)
    })
    services.platform.configureBrowser({
      installationBrowserRoot: join(this.getHomeDir(), 'browser'),
      admitManagedLaunch: async () => {
        const admission = this.browserSetup.admitManagedLaunch()
        try {
          const status = await this.browserSetup.status()
          if (status.availability !== 'ready') throw new BrowserAutomationError({ code: 'setup_required', message: status.message })
          return admission
        } catch (error) {
          admission.release()
          throw error
        }
      }
    })
    services.platform.setBrowserCommandRouter(this.browserCommandRouter)
    const runtime: BrowserRuntimePort = {
      capabilities: (context) => {
        if (context.profileId !== services.profileId) return undefined
        const target = context.source === 'gui' ? services.platform.browser.selectedTarget(context.threadId) : { backend: 'managed-chromium' as const }
        return services.platform.browser.sessions.listThreadSessions({ profileId: context.profileId, threadId: context.threadId })
          .find((session) => session.backend === target?.backend && session.runId === context.runId && session.lifecycle !== 'closed' && session.lifecycle !== 'disconnected')?.capabilities
      },
      readScreenshot: async (context, sessionId, artifactId) => {
        if (!context.vision || context.execution.profileId !== services.profileId) throw new BrowserAutomationError({ code: 'policy_denied', message: 'Screenshot image delivery requires a vision-capable model in the owning profile' })
        const owner = services.platform.browser.sessions.trustedSessionScope({ profileId: services.profileId, threadId: context.execution.threadId, sessionId })
        if (owner.runId !== context.execution.runId) throw new BrowserAutomationError({ code: 'policy_denied', message: 'Screenshot belongs to another execution' })
        const artifact = await services.platform.browser.artifacts.read({ profileId: services.profileId, threadId: owner.threadId, runId: owner.runId, sessionId }, artifactId, Math.min(context.policy.maxArtifactBytes, 16 * 1024 * 1024))
        if (artifact.ref.mediaType !== 'image/png') throw new BrowserAutomationError({ code: 'invalid_action', message: 'Browser screenshot must be PNG' })
        return { data: Buffer.from(artifact.bytes).toString('base64'), mimeType: 'image/png' }
      },
      requestAccess: (context, signal) => services.platform.browser.requestAccess(context, signal),
      resolveTarget: (context) => {
        if (context.profileId !== services.profileId) throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'Browser context belongs to another profile' })
        if (context.source !== 'gui') return { backend: 'managed-chromium' }
        const selected = services.platform.browser.selectedTarget(context.threadId)
        if (!selected) throw new BrowserAutomationError({ code: 'setup_required', message: 'No available in-app browser tab is connected. Open a browser tab and retry.' })
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
