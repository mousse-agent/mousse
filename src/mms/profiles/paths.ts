import { isAbsolute, join } from 'node:path'
import { hashHomeForEndpoint, unixSocketPath, windowsNamedPipePath } from '../protocol/endpoint'
import { canonicalizeHome } from '../ownership/MmsOwnerLease'
import type { ProfileId } from '../../shared/profiles/ids'
import { ProfilePathError } from '../../shared/profiles/errors'
import { assertProfileId, joinOwnedPath } from './pathSafety'

export const PROFILES_DIR_NAME = 'profiles'
export const INSTALLATION_MANIFEST_NAME = 'installation.json'
export const PROFILE_MANIFEST_NAME = 'profile.json'
export const MIGRATION_DIR_NAME = 'migration'

export interface InstallationEndpointIdentity {
  canonicalHome: string
  homeHash: string
  unixSocketPath: string
  windowsNamedPipePath: string
}

export interface InstallationPaths {
  readonly homeDir: string
  readonly installationManifest: string
  readonly mousseConf: string
  readonly authJson: string
  readonly ownerJson: string
  readonly runtimeJson: string
  readonly unixSocket: string
  readonly stopRequestJson: string
  readonly pidFile: string
  readonly providersDir: string
  readonly repositoriesDir: string
  readonly browserBinariesDir: string
  readonly profilesDir: string
  readonly migrationDir: string
  readonly migrationJournal: string
  readonly migrationLease: string
  readonly migrationStagingDir: string
  readonly migrationSnapshotDir: string
  readonly endpoint: InstallationEndpointIdentity
  profileRoot(profileId: string): string
}

export interface ProfilePaths {
  readonly profileId: ProfileId
  readonly root: string
  readonly profileManifest: string
  readonly mousseConf: string
  readonly projectsJson: string
  readonly projectsDir: string
  readonly threadsIndexJson: string
  readonly activeThreadJson: string
  readonly threadsDir: string
  readonly threadDataStandalone: string
  readonly threadDataRepositories: string
  readonly repositoriesDir: string
  readonly agentsDir: string
  readonly workflowsDir: string
  readonly workflowRunsDir: string
  readonly integrationsDir: string
  readonly secretsDir: string
  readonly controlDir: string
  readonly scheduledDir: string
  readonly channelsDir: string
  readonly browserDir: string
  readonly artifactsDir: string
  readonly draftsDir: string
  readonly presentationDir: string
  readonly mcpOAuthDir: string
  readonly agentConfigsDir: string
  readonly lineEditsJson: string
  /** HomeDir argument for existing ControlStore(homeDir) which joins `control`. */
  readonly controlStoreHome: string
  /** HomeDir argument for ThreadStorageLayout(homeDir). */
  readonly threadStorageHome: string
}

export function createInstallationPaths(homeDir: string): InstallationPaths {
  const canonicalHome = canonicalizeHome(homeDir)
  if (!canonicalHome || canonicalHome.includes('\0') || !isAbsolute(canonicalHome)) {
    throw new ProfilePathError('Installation home must resolve to an absolute path', { homeDir })
  }
  const profilesDir = join(canonicalHome, PROFILES_DIR_NAME)
  const migrationDir = join(canonicalHome, MIGRATION_DIR_NAME)
  const paths: InstallationPaths = {
    homeDir: canonicalHome,
    installationManifest: join(canonicalHome, INSTALLATION_MANIFEST_NAME),
    mousseConf: join(canonicalHome, 'mousse.conf'),
    authJson: join(canonicalHome, 'auth.json'),
    ownerJson: join(canonicalHome, 'mms.owner.json'),
    runtimeJson: join(canonicalHome, 'mms.runtime.json'),
    unixSocket: unixSocketPath(canonicalHome),
    stopRequestJson: join(canonicalHome, 'mms.stop.request.json'),
    pidFile: join(canonicalHome, 'mms.pid'),
    providersDir: join(canonicalHome, 'providers'),
    repositoriesDir: join(canonicalHome, 'repositories'),
    browserBinariesDir: join(canonicalHome, 'browser-binaries'),
    profilesDir,
    migrationDir,
    migrationJournal: join(migrationDir, 'journal.json'),
    migrationLease: join(migrationDir, '.lease'),
    migrationStagingDir: join(migrationDir, 'staging'),
    migrationSnapshotDir: join(migrationDir, 'snapshot'),
    endpoint: {
      canonicalHome,
      homeHash: hashHomeForEndpoint(canonicalHome),
      unixSocketPath: unixSocketPath(canonicalHome),
      windowsNamedPipePath: windowsNamedPipePath(canonicalHome)
    },
    profileRoot(profileId: string): string {
      const id = assertProfileId(profileId)
      return joinOwnedPath(profilesDir, id)
    }
  }
  return Object.freeze(paths)
}

export function createProfilePaths(installation: InstallationPaths, profileId: string): ProfilePaths {
  const id = assertProfileId(profileId)
  const root = installation.profileRoot(id)
  const paths: ProfilePaths = {
    profileId: id,
    root,
    profileManifest: join(root, PROFILE_MANIFEST_NAME),
    mousseConf: join(root, 'mousse.conf'),
    projectsJson: join(root, 'projects.json'),
    projectsDir: join(root, 'projects'),
    threadsIndexJson: join(root, 'threads-index.json'),
    activeThreadJson: join(root, 'active-thread.json'),
    threadsDir: join(root, 'threads'),
    threadDataStandalone: join(root, 'thread-data', 'standalone'),
    threadDataRepositories: join(root, 'thread-data', 'repositories'),
    repositoriesDir: join(root, 'repositories'),
    agentsDir: join(root, 'agents'),
    workflowsDir: join(root, 'workflows'),
    workflowRunsDir: join(root, 'workflow-runs'),
    integrationsDir: join(root, 'integrations'),
    secretsDir: join(root, 'secrets'),
    controlDir: join(root, 'control'),
    scheduledDir: join(root, 'scheduled'),
    channelsDir: join(root, 'channels'),
    browserDir: join(root, 'browser'),
    artifactsDir: join(root, 'artifacts'),
    draftsDir: join(root, 'drafts'),
    presentationDir: join(root, 'presentation'),
    mcpOAuthDir: join(root, 'mcp-oauth'),
    agentConfigsDir: join(root, 'agent-configs'),
    lineEditsJson: join(root, 'line-edits.json'),
    controlStoreHome: root,
    threadStorageHome: root
  }
  return Object.freeze(paths)
}

export function assertInstallationHome(paths: InstallationPaths, candidate: string): string {
  const canonical = canonicalizeHome(candidate)
  const same =
    process.platform === 'win32'
      ? canonical.toLowerCase() === paths.homeDir.toLowerCase()
      : canonical === paths.homeDir
  if (!same) {
    throw new ProfilePathError('Path is not the installation home', { home: paths.homeDir, path: canonical })
  }
  return paths.homeDir
}
