import { homedir } from 'os'
import { join } from 'path'
import { MousseConfigStore } from './config/MousseConfigStore'
import { MmsProfileServices } from './MmsProfileServices'
import type { MmsOptions } from './MmsOptions'
import { ProviderAuthService } from './providers/ProviderAuthService'
import { DomainHandlerRegistry } from './protocol/domainRegistry'
import { acquireMmsOwnerLease, canonicalizeHome, type MmsOwnerHandle } from './ownership/MmsOwnerLease'

export type { MmsOptions } from './MmsOptions'

/** One installation owner and shared provider catalog; profile services acquire no lease. */
export class MousseMainService extends MmsProfileServices {
  private installationLease: MmsOwnerHandle | null
  private installationStopped = false

  private constructor(
    config: MousseConfigStore,
    options: MmsOptions | undefined,
    owner: MmsOwnerHandle | null,
    installationHome: string,
    providers: ProviderAuthService
  ) {
    super(config, options, owner, installationHome, {
      providerAuth: providers,
      domains: new DomainHandlerRegistry(),
      installationHome
    })
    this.installationLease = owner
  }

  static async create(options?: MmsOptions): Promise<MousseMainService> {
    const home = canonicalizeHome(options?.homeDir ?? process.env.MOUSSE_HOME ?? join(homedir(), '.mousse'))
    // Compatibility bootstrap for remaining legacy consumers. This is always
    // the installation root and must never change during profile binding.
    process.env.MOUSSE_HOME = home
    const owner = options?.requireOwnership === false ? null : acquireMmsOwnerLease(home, {
      kind: options?.ownerKind ?? (options?.headless ? 'cli' : 'gui'),
      version: options?.version ?? process.env.npm_package_version,
      build: options?.build
    })
    let providers: ProviderAuthService | undefined
    let service: MousseMainService | undefined
    try {
      providers = new ProviderAuthService(join(home, 'auth.json'))
      await providers.init()
      const config = MousseConfigStore.load(home)
      service = new MousseMainService(config, options, owner, home, providers)
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

  override async stop(): Promise<void> {
    if (this.installationStopped) return
    this.installationStopped = true
    try { await super.stop() }
    finally {
      this.providerAuth.stop()
      this.installationLease?.release()
      this.installationLease = null
    }
  }
}
