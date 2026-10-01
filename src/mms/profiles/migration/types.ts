import type { ProfileId } from '../../../shared/profiles/ids'
import type {
  ControlCredentialsPlaintext,
  MigrationInventoryEntry,
  RetainedLegacyRoot,
  TreeDigest
} from '../../../shared/profiles/types'
import type { Clock } from '../clock'
import type { InstallationPaths, ProfilePaths } from '../paths'

export const MIGRATION_STEPS = [
  'acquire-lease',
  'inventory',
  'create-default-staging',
  'copy-personal-data',
  'split-config',
  'worktrees',
  'validate',
  'promote-staging',
  'migrate-credentials',
  'commit-manifest',
  'complete'
] as const

export type MigrationStepId = (typeof MIGRATION_STEPS)[number]

export interface MigrationFaultHooks {
  beforeStep?(step: MigrationStepId): void
  /** Test seam at the crash window after a step's I/O but before its completion is journaled. */
  afterStepAction?(step: MigrationStepId): void
  afterStep?(step: MigrationStepId): void
  beforeCommit?(): void
  afterCommit?(): void
}

export interface ControlCredentialMigrationAdapter {
  decryptFromControlHome(homeDir: string): ControlCredentialsPlaintext | null
  encryptToControlHome(homeDir: string, credentials: ControlCredentialsPlaintext): void
  verifyReadback(homeDir: string, expected: ControlCredentialsPlaintext): boolean
}

export interface GitWorktreeInspection {
  path: string
  isGitWorktree: boolean
  registered: boolean
  gitDir?: string
}

export interface GitWorktreeMigrationResult {
  action: 'moved' | 'retained'
  path: string
  reason: string
}

export interface GitWorktreeMigrationAdapter {
  inspect(path: string): GitWorktreeInspection
  migrateWorktreeBase(
    source: string,
    destination: string,
    profileId: ProfileId
  ): GitWorktreeMigrationResult
}

export interface MigrationCopyAdapter {
  copyTree(source: string, destination: string): TreeDigest
}

export interface ProfileMigrationAdapters {
  credentials: ControlCredentialMigrationAdapter
  gitWorktrees: GitWorktreeMigrationAdapter
  copy?: MigrationCopyAdapter
}

export interface ProfileMigrationOptions {
  dryRun?: boolean
  clock?: Clock
  adapters: ProfileMigrationAdapters
  hooks?: MigrationFaultHooks
}

export interface ConfigSplitResult {
  installationConf: Record<string, unknown>
  profileConf: Record<string, unknown>
  unknownKeys: string[]
}

export interface MigrationJournal {
  version: 1
  dryRun: boolean
  startedAt: string
  updatedAt: string
  defaultProfileId?: ProfileId
  currentStep: MigrationStepId
  completedSteps: MigrationStepId[]
  inventory: MigrationInventoryEntry[]
  unknownConfigKeys: string[]
  retainedLegacyRoots: RetainedLegacyRoot[]
  treeDigests: Record<string, TreeDigest>
  /** Exact staged tree recorded before the staging-to-live rename. */
  promotionDigest?: TreeDigest
  credentialMigration?: {
    sourceHome: string
    destinationHome: string
    migrated: boolean
    accountId?: string
  }
  error?: { step: MigrationStepId; message: string }
  committedAt?: string
  rolledBackAt?: string
}

export interface MigrationReport {
  dryRun: boolean
  alreadyCommitted: boolean
  defaultProfileId?: ProfileId
  inventory: MigrationInventoryEntry[]
  unknownConfigKeys: string[]
  retainedLegacyRoots: RetainedLegacyRoot[]
  journal: MigrationJournal
  installationPaths: InstallationPaths
  defaultProfilePaths?: ProfilePaths
}

export interface MigrationRollbackReport {
  committed: boolean
  removedPaths: string[]
  restoredPaths: string[]
  journal: MigrationJournal
}
