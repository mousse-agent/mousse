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
import { registerIntegrationMethods, type IntegrationDomainRegistration } from './integrations/registerMethods'

export type { MmsOptions } from './MmsOptions'

/** One installation owner and shared provider catalog; profile services acquire no lease. */
export class MousseMainService extends MmsProfileServices {
  private installationLease: MmsOwnerHandle | null
  private installationStopped = false
  private profileHost: ProfileHost | null = null
  private integrationDomains: IntegrationDomainRegistration | null = null

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
        options: { ...options, homeDir: home }
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

  override async stop(): Promise<void> {
    if (this.installationStopped) return
    this.installationStopped = true
    this.integrationDomains?.dispose()
    this.integrationDomains = null
    const errors: unknown[] = []
    try {
      try { await this.profileHost?.stopAll() } catch (error) { errors.push(error) }
      try { await super.stop() } catch (error) { errors.push(error) }
    } finally {
      this.providerAuth.stop()
      this.installationLease?.release()
      this.installationLease = null
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to stop installation services')
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
    this.integrationDomains = registerIntegrationMethods(this.domains, async (profileId) => {
      const services = await profile(profileId)
      return {
        profileId, catalog: services.platform.integrations,
        mcpManager: services.mcpManager, projects: services.projects, settings: services.settings
      }
    })
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
