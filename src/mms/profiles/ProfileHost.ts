import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
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
import { assertOwnedPath, assertProfileId, canonicalizeAbsolutePath } from './pathSafety'

interface PendingProfileRemoval {
  version: 1
  profileId: ProfileId
  destinationName: string
  archivedRevision: number
  archivedRecord: ProfileRecord
  createdAt: string
}

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
    this.recoverPendingRemovals()
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
    if (!existsSync(preview.ownedRoots[0])) {
      throw new ProfileError('PROFILE_STATE', 'Profile root is missing; refusing destructive removal', {
        profileId: preview.profileId,
        root: preview.ownedRoots[0]
      })
    }
    await this.disposeProfile(preview.profileId)
    let archived: ProfileRecord | undefined
    let pending: PendingProfileRemoval | undefined
    let markerPath: string | undefined
    let destination: string | undefined
    let moved = false
    try {
      archived = this.manager.archive(preview.profileId, expectedRevision)
      const trashRoot = join(this.installation.homeDir, 'trash', 'profiles')
      const pendingRoot = join(trashRoot, '.pending')
      mkdirSync(pendingRoot, { recursive: true, mode: 0o700 })
      const token = randomUUID()
      pending = {
        version: 1,
        profileId: archived.id,
        destinationName: `${archived.id}-${token}`,
        archivedRevision: archived.revision,
        archivedRecord: archived,
        createdAt: new Date().toISOString()
      }
      markerPath = join(pendingRoot, `${pending.destinationName}.json`)
      destination = join(trashRoot, pending.destinationName)
      assertOwnedPath(pendingRoot, markerPath)
      assertOwnedPath(trashRoot, destination)
      atomicWriteJsonSync(markerPath, pending, { mode: 0o600 })
      this.manager.forgetArchived(preview.profileId, archived.revision, archived)
      const root = preview.ownedRoots[0]
      if (existsSync(root)) {
        renameSync(root, destination)
        moved = true
      }
      unlinkSync(markerPath)
      return preview
    } catch (error) {
      try {
        if (moved && destination && !existsSync(preview.ownedRoots[0]) && existsSync(destination)) {
          renameSync(destination, preview.ownedRoots[0])
        }
        if (archived) {
          try {
            const indexed = this.manager.get(archived.id)
            if (indexed.status === 'archived') this.manager.restore(indexed.id, indexed.revision)
          } catch {
            this.manager.restoreForgotten(archived)
            this.manager.restore(archived.id, archived.revision)
          }
        }
        if (markerPath && existsSync(markerPath)) unlinkSync(markerPath)
      } finally {
        await this.getProfileServices(preview.profileId).then((services) => services.start())
      }
      throw error
    }
  }

  /** Complete or fail closed on a removal interrupted after its archive journal was written. */
  private recoverPendingRemovals(): void {
    const pendingRoot = join(this.installation.homeDir, 'trash', 'profiles', '.pending')
    if (!existsSync(pendingRoot)) return
    for (const name of readdirSync(pendingRoot)) {
      if (!name.endsWith('.json')) continue
      const markerPath = join(pendingRoot, name)
      const pending = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<PendingProfileRemoval>
      const profileId = assertProfileId(String(pending.profileId ?? ''))
      const destinationName = String(pending.destinationName ?? '')
      if (!/^[-0-9a-f]{36}-[0-9a-f-]{36}$/i.test(destinationName) || !Number.isInteger(pending.archivedRevision)) {
        throw new ProfileError('PROFILE_STATE', 'Pending profile removal journal is invalid', { markerPath })
      }
      const root = this.installation.profileRoot(profileId)
      const trashRoot = join(this.installation.homeDir, 'trash', 'profiles')
      const destination = join(trashRoot, destinationName)
      assertOwnedPath(this.installation.profilesDir, root)
      assertOwnedPath(trashRoot, destination)
      let indexed: ProfileRecord | undefined
      let indexPresent = false
      try {
        indexed = this.manager.get(profileId)
        indexPresent = true
      } catch (error) {
        // A crash after root rename leaves the index entry pointing at a
        // missing profile.json. The durable journal remains authoritative for
        // this one archived record until forgetArchived completes.
        if (error instanceof ProfileError && error.code === 'PROFILE_STATE') indexPresent = true
        else if (!(error instanceof ProfileError) || error.code !== 'PROFILE_NOT_FOUND') throw error
      }
      if (indexed && indexed.status !== 'archived') {
        throw new ProfileError('PROFILE_STATE', 'Pending profile removal targets an active profile', { profileId })
      }
      if (existsSync(root) && existsSync(destination)) {
        throw new ProfileError('PROFILE_STATE', 'Pending profile removal has two owned roots', { profileId })
      }
      if (existsSync(root)) renameSync(root, destination)
      if (indexPresent) {
        this.manager.forgetArchived(profileId, Number(pending.archivedRevision), pending.archivedRecord)
      } else if (!existsSync(destination)) {
        throw new ProfileError('PROFILE_STATE', 'Pending profile removal lost its owned root', { profileId })
      }
      unlinkSync(markerPath)
    }
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
