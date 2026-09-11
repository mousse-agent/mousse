import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { MousseConfigStore } from '../config/MousseConfigStore'
import { MmsProfileServices } from '../MmsProfileServices'
import type { MmsOptions } from '../MmsOptions'
import type { ProviderAuthService } from '../providers/ProviderAuthService'
import { DomainHandlerRegistry } from '../protocol/domainRegistry'
import type { ProfileId } from '../../shared/profiles/ids'
import type { ProfilePublicDto, ProfileRecord, ProfileRemovePreview } from '../../shared/profiles/types'
import { ProfileError, ProfileNotFoundError, ProfileRevisionConflictError } from '../../shared/profiles/errors'
import { createInstallationPaths, createProfilePaths, type InstallationPaths } from './paths'
import { ProfileManager } from './ProfileManager'
import { ProfileMigrationService } from './migration/MigrationService'
import {
  createControlStoreCredentialAdapter,
  createRetainingGitWorktreeAdapter
} from './migration/adapters'
import { assertOwnedPath, canonicalizeAbsolutePath } from './pathSafety'

export interface ProfileHostShared {
  providerAuth: ProviderAuthService
  domains: DomainHandlerRegistry
  options?: MmsOptions
}

export class ProfileHost {
  readonly manager: ProfileManager
  readonly installation: InstallationPaths
  readonly installationConfig: MousseConfigStore
  private readonly cache = new Map<string, Promise<MmsProfileServices>>()
  private readonly live = new Map<string, MmsProfileServices>()
  private defaultServices: MmsProfileServices | null = null
  private defaultProfileId: ProfileId | null = null

  constructor(
    readonly shared: ProfileHostShared
  ) {
    this.installation = createInstallationPaths(shared.options?.homeDir ?? '')
    this.manager = ProfileManager.open(this.installation)
    this.installationConfig = MousseConfigStore.loadInstallation(this.installation.homeDir)
  }

  static async bootstrap(
    installationHome: string,
    shared: Omit<ProfileHostShared, 'options'> & { options?: MmsOptions }
  ): Promise<ProfileHost> {
    const installation = createInstallationPaths(installationHome)
    const manager = ProfileManager.open(installation)
    const migration = new ProfileMigrationService(installation, manager)
    migration.run({
      adapters: {
        credentials: createControlStoreCredentialAdapter(),
        gitWorktrees: createRetainingGitWorktreeAdapter()
      }
    })
    if (!manager.isInitialized()) {
      manager.initializeFresh()
    }
    const host = new ProfileHost({
      ...shared,
      options: { ...shared.options, homeDir: installationHome }
    })
    host.defaultProfileId = manager.getDefaultProfileId()
    return host
  }

  getDefaultProfileId(): ProfileId {
    if (!this.defaultProfileId) this.defaultProfileId = this.manager.getDefaultProfileId()
    return this.defaultProfileId
  }

  attachDefault(services: MmsProfileServices, profileId: ProfileId): void {
    this.defaultServices = services
    this.defaultProfileId = profileId
    this.live.set(profileId, services)
    this.cache.set(profileId, Promise.resolve(services))
  }

  activeProfileCount(): number {
    return this.manager.list().filter((record) => record.status === 'active').length
  }

  toPublic(record: ProfileRecord): ProfilePublicDto {
    return {
      id: record.id,
      slug: record.slug,
      displayName: record.displayName,
      color: record.color,
      avatar: record.avatar,
      status: record.status,
      revision: record.revision,
      isDefault: record.id === this.getDefaultProfileId()
    }
  }

  async getProfileServices(profileId: string): Promise<MmsProfileServices> {
    const record = this.manager.get(profileId)
    if (record.status !== 'active') {
      throw new ProfileError('PROFILE_STATE', `Profile ${record.id} is not active`, {
        profileId: record.id,
        status: record.status
      })
    }
    const existing = this.cache.get(record.id)
    if (existing) return existing
    const created = this.compose(record)
    this.cache.set(record.id, created)
    try {
      const services = await created
      this.live.set(record.id, services)
      return services
    } catch (error) {
      this.cache.delete(record.id)
      throw error
    }
  }

  getLive(profileId: string): MmsProfileServices | undefined {
    return this.live.get(profileId)
  }

  async startActiveProfiles(): Promise<void> {
    for (const record of this.manager.list()) {
      if (record.status !== 'active') continue
      const services = await this.getProfileServices(record.id)
      await services.start()
    }
  }

  async stopAll(): Promise<void> {
    const errors: unknown[] = []
    for (const [id, services] of this.live) {
      if (services === this.defaultServices) continue
      try {
        await services.stop()
      } catch (error) {
        errors.push(error)
      }
      this.live.delete(id)
      this.cache.delete(id)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Failed to stop profile services')
  }

  /** Lifecycle seam used by the protocol owner when a profile is archived or removed. */
  async disposeProfile(profileId: string): Promise<void> {
    const record = this.manager.get(profileId)
    if (record.id === this.getDefaultProfileId()) {
      throw new ProfileError('PROFILE_STATE', 'The default profile is owned by MousseMainService')
    }
    const services = this.live.get(record.id)
    if (services) await services.stop()
    this.live.delete(record.id)
    this.cache.delete(record.id)
  }

  /** Idempotent host cleanup; shared provider/owner teardown remains with MousseMainService. */
  async dispose(): Promise<void> {
    await this.stopAll()
  }

  previewRemove(profileRef: string): ProfileRemovePreview {
    const record = this.manager.get(profileRef)
    const paths = createProfilePaths(this.installation, record.id)
    const root = canonicalizeAbsolutePath(paths.root)
    assertOwnedPath(this.installation.profilesDir, root)
    const live = this.live.get(record.id)
    return {
      profileId: record.id,
      ownedRoots: [root],
      activeTurns: live ? countActiveTurns(live) : 0,
      scheduledJobs: live?.scheduled.listJobs().filter((job) => job.enabled).length ?? 0,
      channelsEnabled: Boolean(
        live &&
          Object.values(live.channels.getSnapshot()?.config?.platforms ?? {}).some(
            (platform) => (platform as { enabled?: boolean }).enabled
          )
      )
    }
  }

  async remove(profileRef: string, expectedRevision: number): Promise<ProfileRemovePreview> {
    const preview = this.previewRemove(profileRef)
    if (preview.profileId === this.getDefaultProfileId()) {
      throw new ProfileError('PROFILE_STATE', 'Cannot remove the default profile')
    }
    if (preview.activeTurns > 0) {
      throw new ProfileError('PROFILE_STATE', 'Profile still has active turns', preview as unknown as Record<string, unknown>)
    }
    const current = this.manager.get(preview.profileId)
    if (current.revision !== expectedRevision) {
      throw new ProfileRevisionConflictError(current.id, expectedRevision, current.revision)
    }
    await this.disposeProfile(preview.profileId)
    let archived: ProfileRecord | undefined
    try {
      archived = this.manager.archive(preview.profileId, expectedRevision)
      this.manager.forgetArchived(preview.profileId, archived.revision)
    } catch (error) {
      if (archived) this.manager.restore(archived.id, archived.revision)
      await this.getProfileServices(preview.profileId).then((services) => services.start())
      throw error
    }
    const root = preview.ownedRoots[0]
    assertOwnedPath(this.installation.profilesDir, root)
    const trashRoot = join(this.installation.homeDir, 'trash', 'profiles')
    mkdirSync(trashRoot, { recursive: true, mode: 0o700 })
    const destination = join(trashRoot, `${preview.profileId}-${Date.now()}`)
    assertOwnedPath(trashRoot, destination)
    try {
      if (existsSync(root)) renameSync(root, destination)
    } catch (error) {
      this.manager.restoreForgotten(archived)
      this.manager.restore(archived.id, archived.revision)
      await this.getProfileServices(archived.id).then((services) => services.start())
      throw error
    }
    return preview
  }

  private async compose(record: ProfileRecord): Promise<MmsProfileServices> {
    if (this.defaultServices && record.id === this.getDefaultProfileId()) {
      return this.defaultServices
    }
    const paths = createProfilePaths(this.installation, record.id)
    const config = MousseConfigStore.loadProfile(paths.root, this.installationConfig)
    const isDefault = record.id === this.getDefaultProfileId()
    const services = new MmsProfileServices(config, this.shared.options, null, paths.root, {
      providerAuth: this.shared.providerAuth,
      domains: this.shared.domains,
      installationHome: this.installation.homeDir,
      personal: true,
      profileId: record.id,
      allowLegacyProjectData: isDefault,
      inheritChannelEnvironment: isDefault,
      includeExternalCliConfigs: isDefault
    })
    await services.initialize()
    return services
  }
}

function countActiveTurns(services: MmsProfileServices): number {
  let count = 0
  for (const thread of services.threads.listAllThreads()) {
    try {
      if (services.orchestrator.isTurnActive?.(thread.id)) count += 1
    } catch {
      /* ignore */
    }
  }
  return count
}

export function loadProfileConfig(
  installationHome: string,
  profileRoot: string
): { installation: MousseConfigStore; profile: MousseConfigStore } {
  const installation = MousseConfigStore.loadInstallation(installationHome)
  const profile = MousseConfigStore.loadProfile(profileRoot, installation)
  return { installation, profile }
}
