import type { ProfileId } from './ids'

export const PROFILE_CONTRACT_ID = 'C1' as const
export const PROFILE_CONTRACT_VERSION = '1.0.0' as const
export const INSTALLATION_SCHEMA_VERSION = 2 as const

export type ProfileStatus = 'active' | 'archived'
export type ProfileEventStreamKind =
  | 'threads'
  | 'runs'
  | 'approvals'
  | 'integrations'
  | 'control'
  | 'scheduled'
  | 'channels'
  | 'browser'
  | 'installation'

export interface ProfileAppearanceSeed {
  theme?: string
  accentColor?: string
  acrylic?: boolean
}

export interface ProfileRecord {
  id: ProfileId
  slug: string
  displayName: string
  color?: string
  avatar?: string
  appearanceSeed?: ProfileAppearanceSeed
  createdAt: string
  updatedAt: string
  revision: number
  status: ProfileStatus
  archivedAt?: string
}

export interface ProfileCreateInput {
  displayName: string
  slug?: string
  color?: string
  avatar?: string
  appearanceSeed?: ProfileAppearanceSeed
}

export interface ProfileUpdateInput {
  displayName?: string
  slug?: string
  color?: string | null
  avatar?: string | null
  appearanceSeed?: ProfileAppearanceSeed | null
}

export interface InstallationProfileIndexEntry {
  id: ProfileId
  slug: string
  status: ProfileStatus
  rootRelativePath: string
}

export type MigrationStatus = 'idle' | 'in-progress' | 'committed' | 'failed'

export interface InstallationMigrationState {
  status: MigrationStatus
  journalRelativePath: string
  lastCompletedStep?: string
  committedAt?: string
  defaultProfileId?: ProfileId
}

export interface InstallationManifest {
  schemaVersion: typeof INSTALLATION_SCHEMA_VERSION
  contractId: typeof PROFILE_CONTRACT_ID
  contractVersion: typeof PROFILE_CONTRACT_VERSION
  createdAt: string
  updatedAt: string
  defaultProfileId: ProfileId
  compatibility: {
    /** Legacy clients may use Default only while this remains true. */
    singleProfileLegacyClients: boolean
  }
  profiles: InstallationProfileIndexEntry[]
  migration: InstallationMigrationState
}

export interface ProfileBinding {
  profileId: ProfileId
  epoch: number
  boundAt: string
}

export interface ProfileEventEnvelope {
  profileId: ProfileId
  streamKind: ProfileEventStreamKind
  sequence: number
  objectRevision?: number
  eventId: string
}

export type SettingsScope = 'installation' | 'profile'

export interface SettingsClassificationEntry {
  path: string
  scope: SettingsScope
  notes: string
}

export interface PathOwnershipRule {
  logicalName: string
  scope: SettingsScope
  relativePath: string
  preservedDuringMigration: boolean
  notes: string
}

export interface RetainedLegacyRoot {
  kind: 'git-worktree-base' | 'project-data' | 'other'
  path: string
  profileId: ProfileId
  reason: 'git-worktree-retain' | 'explicit-owned-root' | 'adapter-retain'
}

export interface TreeDigest {
  files: number
  bytes: number
  sha256: string
}

export interface MigrationInventoryEntry {
  logicalName: string
  sourcePath: string
  destinationLogicalName?: string
  scope: SettingsScope | 'discard-ephemeral' | 'retain-in-place'
  exists: boolean
  digest?: TreeDigest
  notes: string
}

export const PROFILES_V1_CAPABILITY = 'profiles-v1'

export interface ProfilePublicDto {
  id: ProfileId
  slug: string
  displayName: string
  color?: string
  avatar?: string
  status: ProfileStatus
  revision: number
  isDefault: boolean
}

export interface ProfileBindResult {
  profile: ProfilePublicDto
  epoch: number
}

export interface ProfileRemovePreview {
  profileId: ProfileId
  ownedRoots: string[]
  activeTurns: number
  /** All profile-owned work, including browser, integrations and processes. */
  ownedActivity?: Record<string, number>
  scheduledJobs: number
  channelsEnabled: boolean
}

export interface ControlCredentialsPlaintext {
  accountId: string
  accountEmail?: string
  accountName?: string
  accessToken?: string
  refreshToken?: string
  deviceEnrollmentToken?: string
  expiresAt?: number
  updatedAt: string
}
