import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { withFileLock } from '../scheduled/fileLock'
import {
  canonicalizeProfileId,
  canonicalizeProfileSlug,
  DEFAULT_PROFILE_DISPLAY_NAME,
  DEFAULT_PROFILE_SLUG,
  isProfileId,
  type ProfileId
} from '../../shared/profiles/ids'
import {
  ProfileError,
  ProfileIdentityError,
  ProfileNotFoundError,
  ProfilePathError,
  ProfileRevisionConflictError
} from '../../shared/profiles/errors'
import {
  INSTALLATION_SCHEMA_VERSION,
  PROFILE_CONTRACT_ID,
  PROFILE_CONTRACT_VERSION,
  type InstallationManifest,
  type InstallationProfileIndexEntry,
  type ProfileCreateInput,
  type ProfileRecord,
  type ProfileUpdateInput
} from '../../shared/profiles/types'
import { systemClock, type Clock, isoNow } from './clock'
import { createProfilePaths, type InstallationPaths, type ProfilePaths } from './paths'
import { ProfileRuntime } from './ProfileRuntime'
import { joinOwnedPath } from './pathSafety'

const PROFILE_DIR_MODE = 0o700

export interface ProfileManagerOptions {
  clock?: Clock
}

function slugFromDisplayName(displayName: string): string {
  const base = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!base) return 'profile'
  return canonicalizeProfileSlug(base.slice(0, 64).replace(/-+$/g, '') || 'profile')
}

function parseProfileRecord(raw: unknown, expectedId: ProfileId): ProfileRecord {
  if (!raw || typeof raw !== 'object') {
    throw new ProfileError('PROFILE_STATE', 'profile.json is not an object', { expectedId })
  }
  const value = raw as Partial<ProfileRecord>
  const id = canonicalizeProfileId(String(value.id ?? ''))
  if (id !== expectedId) {
    throw new ProfileError('PROFILE_STATE', 'profile.json id does not match directory identity', {
      expectedId,
      actualId: id
    })
  }
  if (typeof value.slug !== 'string' || typeof value.displayName !== 'string') {
    throw new ProfileError('PROFILE_STATE', 'profile.json is missing slug or displayName', { expectedId })
  }
  const displayName = value.displayName.trim()
  if (displayName.length < 1 || displayName.length > 64) {
    throw new ProfileError('PROFILE_STATE', 'profile.json displayName is invalid', { expectedId })
  }
  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 1) {
    throw new ProfileError('PROFILE_STATE', 'profile.json revision is invalid', { expectedId })
  }
  if (value.status !== 'active' && value.status !== 'archived') {
    throw new ProfileError('PROFILE_STATE', 'profile.json status is invalid', { expectedId })
  }
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw new ProfileError('PROFILE_STATE', 'profile.json timestamps are invalid', { expectedId })
  }
  const record: ProfileRecord = {
    id,
    slug: canonicalizeProfileSlug(value.slug),
    displayName,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    revision: value.revision,
    status: value.status
  }
  if (typeof value.color === 'string') record.color = value.color
  if (typeof value.avatar === 'string') record.avatar = value.avatar
  if (value.appearanceSeed && typeof value.appearanceSeed === 'object') {
    record.appearanceSeed = { ...value.appearanceSeed }
  }
  if (typeof value.archivedAt === 'string') record.archivedAt = value.archivedAt
  return record
}

function parseManifest(raw: unknown): InstallationManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProfileError('PROFILE_STATE', 'installation.json is not an object')
  }
  const value = raw as Partial<InstallationManifest>
  if (value.schemaVersion !== INSTALLATION_SCHEMA_VERSION) {
    throw new ProfileError('PROFILE_STATE', 'installation.json schemaVersion is not v2', {
      schemaVersion: value.schemaVersion
    })
  }
  if (value.contractId !== PROFILE_CONTRACT_ID || value.contractVersion !== PROFILE_CONTRACT_VERSION) {
    throw new ProfileError('PROFILE_STATE', 'installation.json contract is not C1@1.0.0', {
      contractId: value.contractId,
      contractVersion: value.contractVersion
    })
  }
  if (!Array.isArray(value.profiles) || typeof value.defaultProfileId !== 'string') {
    throw new ProfileError('PROFILE_STATE', 'installation.json is missing profiles or defaultProfileId')
  }
  const defaultProfileId = canonicalizeProfileId(value.defaultProfileId)
  const ids = new Set<string>()
  const slugs = new Set<string>()
  const profiles = value.profiles.map((rawEntry) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new ProfileError('PROFILE_STATE', 'installation.json contains an invalid profile entry')
    }
    const entry = rawEntry as Partial<InstallationProfileIndexEntry>
    const id = canonicalizeProfileId(String(entry.id ?? ''))
    const slug = canonicalizeProfileSlug(String(entry.slug ?? ''))
    if (entry.status !== 'active' && entry.status !== 'archived') {
      throw new ProfileError('PROFILE_STATE', 'installation.json profile status is invalid', { id })
    }
    if (entry.rootRelativePath !== `profiles/${id}`) {
      throw new ProfileError('PROFILE_STATE', 'installation.json profile root does not match its identity', { id })
    }
    if (ids.has(id) || slugs.has(slug)) {
      throw new ProfileError('PROFILE_STATE', 'installation.json contains duplicate profile identity', { id, slug })
    }
    ids.add(id)
    slugs.add(slug)
    return { id, slug, status: entry.status, rootRelativePath: entry.rootRelativePath }
  })
  const defaultEntry = profiles.find((entry) => entry.id === defaultProfileId)
  if (!defaultEntry || defaultEntry.status !== 'active') {
    throw new ProfileError('PROFILE_STATE', 'installation.json default profile must exist and be active')
  }
  if (!value.compatibility || typeof value.compatibility.singleProfileLegacyClients !== 'boolean') {
    throw new ProfileError('PROFILE_STATE', 'installation.json compatibility settings are invalid')
  }
  if (!value.migration || !['idle', 'in-progress', 'committed', 'failed'].includes(value.migration.status)) {
    throw new ProfileError('PROFILE_STATE', 'installation.json migration state is invalid')
  }
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw new ProfileError('PROFILE_STATE', 'installation.json timestamps are invalid')
  }
  return { ...value, defaultProfileId, profiles } as InstallationManifest
}

export class ProfileManager {
  readonly installation: InstallationPaths
  private readonly clock: Clock
  private readonly lockPath: string
  private epoch = 0

  private constructor(installation: InstallationPaths, clock: Clock) {
    this.installation = installation
    this.clock = clock
    this.lockPath = join(installation.homeDir, '.profiles.lock')
  }

  static open(installation: InstallationPaths, options: ProfileManagerOptions = {}): ProfileManager {
    mkdirSync(installation.homeDir, { recursive: true, mode: PROFILE_DIR_MODE })
    return new ProfileManager(installation, options.clock ?? systemClock)
  }

  isInitialized(): boolean {
    return existsSync(this.installation.installationManifest)
  }

  getInstallationPaths(): InstallationPaths {
    return this.installation
  }

  initializeFresh(defaultProfile?: ProfileCreateInput): ProfileRecord {
    return this.withLock(() => {
      if (this.isInitialized()) {
        throw new ProfileError('PROFILE_STATE', 'Installation already has a v2 manifest')
      }
      let created: ProfileRecord | undefined
      try {
        created = this.writeNewProfileUnlocked({
          displayName: defaultProfile?.displayName ?? DEFAULT_PROFILE_DISPLAY_NAME,
          slug: defaultProfile?.slug ?? DEFAULT_PROFILE_SLUG,
          color: defaultProfile?.color,
          avatar: defaultProfile?.avatar,
          appearanceSeed: defaultProfile?.appearanceSeed
        })
        this.writeManifestUnlocked({
          schemaVersion: INSTALLATION_SCHEMA_VERSION,
          contractId: PROFILE_CONTRACT_ID,
          contractVersion: PROFILE_CONTRACT_VERSION,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
          defaultProfileId: created.id,
          compatibility: { singleProfileLegacyClients: true },
          profiles: [this.toIndexEntry(created)],
          migration: {
            status: 'idle',
            journalRelativePath: 'migration/journal.json',
            defaultProfileId: created.id
          }
        })
        return created
      } catch (error) {
        if (created) this.removeNewProfileRoot(created.id)
        throw error
      }
    })
  }

  create(input: ProfileCreateInput): ProfileRecord {
    return this.withLock(() => {
      const manifest = this.requireManifestUnlocked()
      let created: ProfileRecord | undefined
      try {
        created = this.writeNewProfileUnlocked(input)
        this.writeManifestUnlocked({
          ...manifest,
          updatedAt: created.updatedAt,
          profiles: [...manifest.profiles, this.toIndexEntry(created)]
        })
        return created
      } catch (error) {
        if (created) this.removeNewProfileRoot(created.id)
        throw error
      }
    })
  }

  list(): ProfileRecord[] {
    if (!this.isInitialized()) return []
    return this.withLock(() => {
      const manifest = this.requireManifestUnlocked()
      return manifest.profiles.map((entry) => this.readProfileUnlocked(entry.id))
    })
  }

  get(profileRef: string): ProfileRecord {
    return this.withLock(() => this.getUnlocked(profileRef))
  }

  getDefaultProfileId(): ProfileId {
    return this.requireManifest().defaultProfileId
  }

  getPaths(profileRef: string): ProfilePaths {
    const record = this.get(profileRef)
    return createProfilePaths(this.installation, record.id)
  }

  update(profileRef: string, patch: ProfileUpdateInput, expectedRevision: number): ProfileRecord {
    return this.withLock(() => {
      const current = this.getUnlocked(profileRef)
      if (current.revision !== expectedRevision) {
        throw new ProfileRevisionConflictError(current.id, expectedRevision, current.revision)
      }
      const nextSlug =
        patch.slug !== undefined ? canonicalizeProfileSlug(patch.slug) : current.slug
      this.assertSlugAvailableUnlocked(nextSlug, current.id)
      const updated: ProfileRecord = {
        ...current,
        displayName:
          patch.displayName !== undefined ? this.assertDisplayName(patch.displayName) : current.displayName,
        slug: nextSlug,
        revision: current.revision + 1,
        updatedAt: isoNow(this.clock)
      }
      if (patch.color === null) delete updated.color
      else if (patch.color !== undefined) updated.color = patch.color
      if (patch.avatar === null) delete updated.avatar
      else if (patch.avatar !== undefined) updated.avatar = patch.avatar
      if (patch.appearanceSeed === null) delete updated.appearanceSeed
      else if (patch.appearanceSeed !== undefined) updated.appearanceSeed = patch.appearanceSeed
      this.writeProfileUnlocked(updated)
      const manifest = this.requireManifestUnlocked()
      this.writeManifestUnlocked({
        ...manifest,
        updatedAt: updated.updatedAt,
        profiles: manifest.profiles.map((entry) =>
          entry.id === updated.id ? this.toIndexEntry(updated) : entry
        )
      })
      return updated
    })
  }

  archive(profileRef: string, expectedRevision: number): ProfileRecord {
    return this.mutateStatus(profileRef, expectedRevision, 'archived')
  }

  restore(profileRef: string, expectedRevision: number): ProfileRecord {
    return this.mutateStatus(profileRef, expectedRevision, 'active')
  }

  /** Remove an archived profile from the live installation index before its root is trashed. */
  forgetArchived(profileRef: string, expectedRevision: number, fallback?: ProfileRecord): ProfileRecord {
    return this.withLock(() => {
      let current: ProfileRecord
      try {
        current = this.getUnlocked(profileRef)
      } catch (error) {
        if (
          !fallback ||
          !(error instanceof ProfileError) ||
          error.code !== 'PROFILE_STATE' ||
          fallback.revision !== expectedRevision ||
          fallback.status !== 'archived'
        ) throw error
        current = fallback
      }
      if (current.revision !== expectedRevision) {
        throw new ProfileRevisionConflictError(current.id, expectedRevision, current.revision)
      }
      if (current.status !== 'archived') {
        throw new ProfileError('PROFILE_STATE', 'Only an archived profile can be removed', { profileId: current.id })
      }
      const manifest = this.requireManifestUnlocked()
      this.writeManifestUnlocked({
        ...manifest,
        updatedAt: isoNow(this.clock),
        profiles: manifest.profiles.filter((entry) => entry.id !== current.id)
      })
      return current
    })
  }

  /** Roll back a failed trash move while the archived profile root is still present. */
  restoreForgotten(record: ProfileRecord): void {
    this.withLock(() => {
      const manifest = this.requireManifestUnlocked()
      if (manifest.profiles.some((entry) => entry.id === record.id || entry.slug === record.slug)) {
        throw new ProfileError('PROFILE_STATE', 'Cannot restore duplicate profile index entry', { profileId: record.id })
      }
      this.writeManifestUnlocked({
        ...manifest,
        updatedAt: isoNow(this.clock),
        profiles: [...manifest.profiles, this.toIndexEntry(record)]
      })
    })
  }

  /**
   * Bind a profile for a caller. Increments a per-manager epoch and never writes
   * process.env.MOUSSE_HOME or an installation-wide current-profile file.
   */
  bind(profileRef: string): ProfileRuntime {
    const record = this.get(profileRef)
    if (record.status !== 'active') {
      throw new ProfileError('PROFILE_STATE', `Profile ${record.id} is not active`, {
        profileId: record.id,
        status: record.status
      })
    }
    this.epoch += 1
    return new ProfileRuntime({
      binding: {
        profileId: record.id,
        epoch: this.epoch,
        boundAt: isoNow(this.clock)
      },
      record,
      paths: createProfilePaths(this.installation, record.id),
      installation: this.installation
    })
  }

  replaceManifestForMigration(manifest: InstallationManifest): void {
    this.withLock(() => {
      this.writeManifestUnlocked(manifest)
    })
  }

  writeProfileRecordForMigration(record: ProfileRecord): void {
    this.withLock(() => {
      this.writeProfileUnlocked(record)
    })
  }

  private mutateStatus(
    profileRef: string,
    expectedRevision: number,
    status: ProfileRecord['status']
  ): ProfileRecord {
    return this.withLock(() => {
      const current = this.getUnlocked(profileRef)
      if (current.revision !== expectedRevision) {
        throw new ProfileRevisionConflictError(current.id, expectedRevision, current.revision)
      }
      if (status === 'archived') {
        const manifest = this.requireManifestUnlocked()
        const activeCount = manifest.profiles.filter((entry) => entry.status === 'active').length
        if (current.status === 'active' && activeCount <= 1) {
          throw new ProfileError('PROFILE_STATE', 'Cannot archive the last active profile', {
            profileId: current.id
          })
        }
        if (manifest.defaultProfileId === current.id) {
          throw new ProfileError('PROFILE_STATE', 'Cannot archive the default profile', {
            profileId: current.id
          })
        }
      }
      const updated: ProfileRecord = {
        ...current,
        status,
        revision: current.revision + 1,
        updatedAt: isoNow(this.clock)
      }
      if (status === 'archived') updated.archivedAt = updated.updatedAt
      else delete updated.archivedAt
      this.writeProfileUnlocked(updated)
      const manifest = this.requireManifestUnlocked()
      this.writeManifestUnlocked({
        ...manifest,
        updatedAt: updated.updatedAt,
        profiles: manifest.profiles.map((entry) =>
          entry.id === updated.id ? this.toIndexEntry(updated) : entry
        )
      })
      return updated
    })
  }

  private getUnlocked(profileRef: string): ProfileRecord {
    const manifest = this.requireManifestUnlocked()
    const entry = this.findIndexEntry(manifest, profileRef)
    if (!entry) throw new ProfileNotFoundError(profileRef)
    const record = this.readProfileUnlocked(entry.id)
    if (record.slug !== entry.slug || record.status !== entry.status) {
      throw new ProfileError('PROFILE_STATE', 'Profile index and profile.json disagree', {
        profileId: entry.id,
        indexedSlug: entry.slug,
        recordSlug: record.slug,
        indexedStatus: entry.status,
        recordStatus: record.status
      })
    }
    return record
  }

  private findIndexEntry(
    manifest: InstallationManifest,
    profileRef: string
  ): InstallationProfileIndexEntry | undefined {
    const trimmed = profileRef.trim()
    if (isProfileId(trimmed)) {
      const id = canonicalizeProfileId(trimmed)
      return manifest.profiles.find((entry) => entry.id === id)
    }
    const matches = manifest.profiles.filter((entry) => entry.slug === trimmed.toLowerCase())
    if (matches.length > 1) {
      throw new ProfileIdentityError(`Ambiguous profile slug: ${trimmed}`, { slug: trimmed })
    }
    return matches[0]
  }

  private requireManifest(): InstallationManifest {
    return this.withLock(() => this.requireManifestUnlocked())
  }

  private requireManifestUnlocked(): InstallationManifest {
    if (!this.isInitialized()) {
      throw new ProfileError('INSTALLATION_UNINITIALIZED', 'Installation manifest is missing')
    }
    try {
      return parseManifest(JSON.parse(readFileSync(this.installation.installationManifest, 'utf8')))
    } catch (error) {
      if (error instanceof ProfileError) throw error
      throw new ProfileError('PROFILE_STATE', 'Failed to read installation.json', {
        cause: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private writeNewProfileUnlocked(input: ProfileCreateInput): ProfileRecord {
    const displayName = this.assertDisplayName(input.displayName)
    const slug = canonicalizeProfileSlug(input.slug ?? slugFromDisplayName(displayName))
    if (this.isInitialized()) this.assertSlugAvailableUnlocked(slug)
    const id = canonicalizeProfileId(randomUUID())
    const root = this.installation.profileRoot(id)
    if (existsSync(root)) {
      throw new ProfilePathError('Generated profile root already exists', { profileId: id, root })
    }
    const now = isoNow(this.clock)
    const record: ProfileRecord = {
      id,
      slug,
      displayName,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      status: 'active'
    }
    if (input.color) record.color = input.color
    if (input.avatar) record.avatar = input.avatar
    if (input.appearanceSeed) record.appearanceSeed = input.appearanceSeed
    this.writeProfileUnlocked(record)
    try {
      this.ensureProfileLayout(record.id)
    } catch (error) {
      this.removeNewProfileRoot(record.id)
      throw error
    }
    return record
  }

  private removeNewProfileRoot(profileId: ProfileId): void {
    const root = this.installation.profileRoot(profileId)
    try {
      if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Preserve the original creation/manifest error. A later startup audit
      // can report the contained orphan rather than deleting an unexpected path.
    }
  }

  private assertSlugAvailableUnlocked(slug: string, exceptId?: ProfileId): void {
    if (!this.isInitialized()) return
    const manifest = this.requireManifestUnlocked()
    const conflict = manifest.profiles.find((entry) => entry.slug === slug && entry.id !== exceptId)
    if (conflict) {
      throw new ProfileError('PROFILE_SLUG_CONFLICT', `Profile slug already exists: ${slug}`, { slug })
    }
  }

  private assertDisplayName(displayName: string): string {
    const trimmed = displayName.trim()
    if (trimmed.length < 1 || trimmed.length > 64) {
      throw new ProfileIdentityError('Profile display name must be 1-64 characters')
    }
    return trimmed
  }

  private readProfileUnlocked(profileId: ProfileId): ProfileRecord {
    const paths = createProfilePaths(this.installation, profileId)
    if (!existsSync(paths.profileManifest)) {
      throw new ProfileError('PROFILE_STATE', 'profile.json is missing', { profileId })
    }
    const raw = JSON.parse(readFileSync(paths.profileManifest, 'utf8')) as unknown
    return parseProfileRecord(raw, profileId)
  }

  private writeProfileUnlocked(record: ProfileRecord): void {
    const paths = createProfilePaths(this.installation, record.id)
    mkdirSync(paths.root, { recursive: true, mode: PROFILE_DIR_MODE })
    atomicWriteJsonSync(paths.profileManifest, record, { mode: 0o600 })
  }

  private writeManifestUnlocked(manifest: InstallationManifest): void {
    mkdirSync(this.installation.homeDir, { recursive: true, mode: PROFILE_DIR_MODE })
    atomicWriteJsonSync(this.installation.installationManifest, manifest, { mode: 0o600 })
  }

  private ensureProfileLayout(profileId: ProfileId): void {
    const paths = createProfilePaths(this.installation, profileId)
    const directories = [
      paths.projectsDir,
      paths.threadsDir,
      paths.threadDataStandalone,
      paths.threadDataRepositories,
      paths.repositoriesDir,
      paths.agentsDir,
      paths.workflowsDir,
      paths.workflowRunsDir,
      paths.integrationsDir,
      paths.secretsDir,
      paths.controlDir,
      paths.scheduledDir,
      paths.channelsDir,
      paths.browserDir,
      paths.artifactsDir,
      paths.draftsDir,
      paths.presentationDir,
      joinOwnedPath(paths.integrationsDir, 'skills'),
      joinOwnedPath(paths.integrationsDir, 'state')
    ]
    for (const directory of directories) {
      mkdirSync(directory, { recursive: true, mode: PROFILE_DIR_MODE })
    }
  }

  private toIndexEntry(record: ProfileRecord): InstallationProfileIndexEntry {
    return {
      id: record.id,
      slug: record.slug,
      status: record.status,
      rootRelativePath: `profiles/${record.id}`
    }
  }

  private withLock<T>(fn: () => T): T {
    try {
      return withFileLock(this.lockPath, fn)
    } catch (error) {
      if (error instanceof ProfilePathError || error instanceof ProfileError) throw error
      throw error
    }
  }
}
