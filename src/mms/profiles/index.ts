export {
  canonicalizeAbsolutePath,
  isPathInsideRoot,
  joinOwnedPath,
  assertOwnedPath,
  assertProfileId,
  pathKey,
  pathsEqual
} from './pathSafety'
export {
  createInstallationPaths,
  createProfilePaths,
  INSTALLATION_MANIFEST_NAME,
  MIGRATION_DIR_NAME,
  PROFILE_MANIFEST_NAME,
  PROFILES_DIR_NAME,
  type InstallationEndpointIdentity,
  type InstallationPaths,
  type ProfilePaths
} from './paths'
export { ProfileManager, type ProfileManagerOptions } from './ProfileManager'
export { ProfileRuntime } from './ProfileRuntime'
export { ProfileScopedAccess, assertSameProfile } from './ownership'
export { systemClock, type Clock } from './clock'
export { ProfileMigrationService, createProfileMigrationService } from './migration/MigrationService'
export {
  createControlStoreCredentialAdapter,
  createRetainingGitWorktreeAdapter,
  createHashingCopyAdapter
} from './migration/adapters'
export { splitMousseConf, readRawMousseConf } from './migration/configSplit'
export { digestPath, digestsEqual } from './migration/digest'
export { inventoryLegacyHome } from './migration/inventory'
export {
  MIGRATION_STEPS,
  type ControlCredentialMigrationAdapter,
  type GitWorktreeMigrationAdapter,
  type MigrationCopyAdapter,
  type MigrationFaultHooks,
  type MigrationJournal,
  type MigrationReport,
  type MigrationStepId,
  type ProfileMigrationAdapters,
  type ProfileMigrationOptions
} from './migration/types'
