import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import { withFileLock } from '../../scheduled/fileLock'
import {
  canonicalizeProfileId,
  DEFAULT_PROFILE_DISPLAY_NAME,
  DEFAULT_PROFILE_SLUG,
  type ProfileId
} from '../../../shared/profiles/ids'
import {
  MigrationValidationError,
  ProfileError
} from '../../../shared/profiles/errors'
import {
  INSTALLATION_SCHEMA_VERSION,
  PROFILE_CONTRACT_ID,
  PROFILE_CONTRACT_VERSION,
  type InstallationManifest,
  type ProfileRecord,
  type RetainedLegacyRoot
} from '../../../shared/profiles/types'
import { isoNow, systemClock, type Clock } from '../clock'
import { createProfilePaths, type InstallationPaths, type ProfilePaths } from '../paths'
import { assertOwnedPath, pathsEqual } from '../pathSafety'
import { ProfileManager } from '../ProfileManager'
import { digestPath, digestsEqual } from './digest'
import { inventoryLegacyHome } from './inventory'
import { emptyJournal, isStepComplete, readJournal, writeJournal } from './journal'
import { copyFileIfPresent, copyTreeAtomic, ensureDir } from './copy'
import { emptySplit, mergeLegacySettings, readRawMousseConf, splitMousseConf } from './configSplit'
import type {
  MigrationFaultHooks,
  MigrationJournal,
  MigrationReport,
  MigrationRollbackReport,
  MigrationStepId,
  ProfileMigrationAdapters,
  ProfileMigrationOptions
} from './types'

const CREDENTIALS_ENC = 'credentials.enc'
const CONTROL_PLAIN_FILES = ['identity.json', 'pairings.json', 'config.json'] as const

export class ProfileMigrationService {
  constructor(
    private readonly installation: InstallationPaths,
    private readonly manager: ProfileManager
  ) {}

  dryRun(options: ProfileMigrationOptions): MigrationReport {
    return this.execute({ ...options, dryRun: true })
  }

  run(options: ProfileMigrationOptions): MigrationReport {
    return this.execute({ ...options, dryRun: false })
  }

  /**
   * Roll back generated v2 state while leaving legacy roots authoritative.
   * Committed migrations require an explicit acknowledgement because profile
   * data may have been written after the manifest was published.
   */
  rollback(options: { allowCommittedDataLoss?: boolean; clock?: Clock } = {}): MigrationRollbackReport {
    const clock = options.clock ?? systemClock
    ensureDir(this.installation.migrationDir)
    return withFileLock(this.installation.migrationLease, () => {
      const journal = this.loadJournalOrEmpty(isoNow(clock), false)
      const committedManifest = this.readCommittedManifest()
      const committed = Boolean(committedManifest)
      if (committed && !options.allowCommittedDataLoss) {
        throw new MigrationValidationError(
          'Committed profile migration requires allowCommittedDataLoss to roll back generated profile data',
          { manifest: this.installation.installationManifest }
        )
      }

      const removedPaths: string[] = []
      const restoredPaths: string[] = []
      const profileId = committedManifest?.defaultProfileId ?? journal.defaultProfileId
      if (profileId && (committed || isStepComplete(journal, 'promote-staging'))) {
        const profileRoot = this.installation.profileRoot(profileId)
        assertOwnedPath(this.installation.profilesDir, profileRoot)
        if (existsSync(profileRoot)) {
          if (lstatSync(profileRoot).isSymbolicLink()) {
            throw new MigrationValidationError('Refusing to roll back a symlinked profile root', { profileRoot })
          }
          rmSync(profileRoot, { recursive: true, force: true })
          removedPaths.push(profileRoot)
        }
      }

      const originalConfig = join(this.installation.migrationSnapshotDir, 'mousse.conf')
      if (existsSync(originalConfig)) {
        if (existsSync(this.installation.mousseConf)) rmSync(this.installation.mousseConf, { force: true })
        copyFileIfPresent(originalConfig, this.installation.mousseConf)
        restoredPaths.push(this.installation.mousseConf)
      } else if (existsSync(this.installation.mousseConf) && (committed || isStepComplete(journal, 'commit-manifest'))) {
        rmSync(this.installation.mousseConf, { force: true })
        removedPaths.push(this.installation.mousseConf)
      }

      if (committed && existsSync(this.installation.installationManifest)) {
        unlinkSync(this.installation.installationManifest)
        removedPaths.push(this.installation.installationManifest)
      }
      if (existsSync(this.installation.migrationStagingDir)) {
        rmSync(this.installation.migrationStagingDir, { recursive: true, force: true })
        removedPaths.push(this.installation.migrationStagingDir)
      }

      const rolledBack = {
        ...emptyJournal(isoNow(clock), false),
        rolledBackAt: isoNow(clock),
        error: {
          step: journal.currentStep,
          message: 'Migration rolled back explicitly; legacy roots remain authoritative'
        }
      }
      this.persist(rolledBack)
      return { committed, removedPaths, restoredPaths, journal: rolledBack }
    })
  }

  private execute(options: ProfileMigrationOptions): MigrationReport {
    const clock = options.clock ?? systemClock
    const dryRun = options.dryRun === true
    const committed = this.readCommittedManifest()
    if (committed && !dryRun) {
      const defaultId = committed.defaultProfileId
      const journal = this.loadJournalOrEmpty(isoNow(clock), false)
      return {
        dryRun: false,
        alreadyCommitted: true,
        defaultProfileId: defaultId,
        inventory: journal.inventory,
        unknownConfigKeys: journal.unknownConfigKeys,
        retainedLegacyRoots: journal.retainedLegacyRoots,
        journal,
        installationPaths: this.installation,
        defaultProfilePaths: createProfilePaths(this.installation, defaultId)
      }
    }

    if (dryRun) {
      const inventory = inventoryLegacyHome(this.installation)
      const rawConf = readRawMousseConf(this.installation.mousseConf)
      const split = rawConf ? splitMousseConf(rawConf) : emptySplit()
      const journal = emptyJournal(isoNow(clock), true)
      journal.inventory = inventory.entries
      journal.unknownConfigKeys = split.unknownKeys
      return {
        dryRun: true,
        alreadyCommitted: Boolean(committed),
        inventory: inventory.entries,
        unknownConfigKeys: split.unknownKeys,
        retainedLegacyRoots: [],
        journal,
        installationPaths: this.installation
      }
    }

    ensureDir(this.installation.migrationDir)
    return withFileLock(this.installation.migrationLease, () =>
      this.runLocked(options.adapters, options.hooks ?? {}, clock)
    )
  }

  private runLocked(
    adapters: ProfileMigrationAdapters,
    hooks: MigrationFaultHooks,
    clock: Clock
  ): MigrationReport {
    const now = () => isoNow(clock)
    let journal = this.loadJournalOrEmpty(now(), false)

    const runStep = (step: MigrationStepId, fn: () => void): void => {
      if (isStepComplete(journal, step)) return
      journal = { ...journal, currentStep: step, updatedAt: now() }
      this.persist(journal)
      hooks.beforeStep?.(step)
      fn()
      journal = {
        ...journal,
        currentStep: step,
        completedSteps: [...journal.completedSteps, step],
        updatedAt: now()
      }
      this.persist(journal)
      hooks.afterStep?.(step)
    }

    try {
      runStep('acquire-lease', () => {
        ensureDir(this.installation.migrationDir)
        ensureDir(this.installation.migrationSnapshotDir)
        ensureDir(this.installation.migrationStagingDir)
      })

      runStep('inventory', () => {
        const inventory = inventoryLegacyHome(this.installation)
        journal = { ...journal, inventory: inventory.entries }
      })

      if (!journal.defaultProfileId) {
        journal = { ...journal, defaultProfileId: canonicalizeProfileId(randomUUID()), updatedAt: now() }
        this.persist(journal)
      }

      runStep('create-default-staging', () => {
        const id = canonicalizeProfileId(String(journal.defaultProfileId))
        const record = this.defaultRecord(id, now())
        const stagingRoot = this.stagingProfileRoot(id)
        ensureDir(stagingRoot)
        atomicWriteJsonSync(join(stagingRoot, 'profile.json'), record, { mode: 0o600 })
        this.ensureLayout(createProfilePaths(this.installation, id), stagingRoot)
        this.snapshotOriginals()
      })

      if (!journal.defaultProfileId) {
        throw new MigrationValidationError('Migration journal is missing the Default profile id')
      }
      const defaultId = canonicalizeProfileId(journal.defaultProfileId)

      runStep('copy-personal-data', () => {
        const workRoot = this.profileWorkRoot(defaultId)
        this.copyPersonalData(journal, this.pathsForRoot(defaultId, workRoot), workRoot)
      })

      runStep('split-config', () => {
        const workRoot = this.profileWorkRoot(defaultId)
        const rawConf = readRawMousseConf(this.installation.mousseConf)
        const split = rawConf ? splitMousseConf(rawConf) : emptySplit()
        const legacySettingsPath = join(this.installation.homeDir, 'settings.json')
        if (existsSync(legacySettingsPath)) {
          const legacySettings = JSON.parse(readFileSync(legacySettingsPath, 'utf8')) as unknown
          if (!legacySettings || typeof legacySettings !== 'object' || Array.isArray(legacySettings)) {
            throw new MigrationValidationError('Legacy settings.json is not an object', { legacySettingsPath })
          }
          mergeLegacySettings(split.profileConf, legacySettings as Record<string, unknown>)
        }
        atomicWriteJsonSync(join(workRoot, 'mousse.conf'), split.profileConf, { mode: 0o600 })
        atomicWriteJsonSync(
          join(this.installation.migrationStagingDir, 'installation.mousse.conf'),
          split.installationConf,
          { mode: 0o600 }
        )
        journal = { ...journal, unknownConfigKeys: split.unknownKeys }
      })

      runStep('worktrees', () => {
        const retained = this.retainWorktrees(adapters, defaultId)
        journal = { ...journal, retainedLegacyRoots: retained }
      })

      runStep('validate', () => {
        this.validateCopies(journal, this.pathsForRoot(defaultId, this.profileWorkRoot(defaultId)))
      })

      runStep('promote-staging', () => {
        this.promoteStaging(defaultId)
      })

      runStep('migrate-credentials', () => {
        const livePaths = this.pathsForRoot(defaultId, this.installation.profileRoot(defaultId))
        journal = {
          ...journal,
          credentialMigration: this.migrateCredentials(adapters, livePaths)
        }
      })

      runStep('commit-manifest', () => {
        hooks.beforeCommit?.()
        this.commit(journal, defaultId, now())
        journal = {
          ...journal,
          committedAt: now()
        }
        hooks.afterCommit?.()
      })

      runStep('complete', () => {
        /* journal already records the step */
      })

      return this.report(journal, createProfilePaths(this.installation, defaultId))
    } catch (error) {
      journal = {
        ...journal,
        error: {
          step: journal.currentStep,
          message: error instanceof Error ? error.message : String(error)
        },
        updatedAt: now()
      }
      this.persist(journal)
      throw error
    }
  }

  private copyPersonalData(
    journal: MigrationJournal,
    stagingPaths: ProfilePaths,
    stagingRoot: string
  ): void {
    const home = this.installation.homeDir
    const copies: Array<[string, string, string]> = [
      [join(home, 'projects.json'), stagingPaths.projectsJson, 'projects.json'],
      [join(home, 'threads-index.json'), stagingPaths.threadsIndexJson, 'threads-index.json'],
      [join(home, 'active-thread.json'), stagingPaths.activeThreadJson, 'active-thread.json'],
      [join(home, 'line-edits.json'), stagingPaths.lineEditsJson, 'line-edits.json'],
      [join(home, 'thread-data', 'standalone'), stagingPaths.threadDataStandalone, 'thread-data/standalone'],
      [join(home, 'thread-data', 'repositories'), stagingPaths.threadDataRepositories, 'thread-data/repositories'],
      [join(home, 'scheduled'), stagingPaths.scheduledDir, 'scheduled'],
      [join(home, 'channels'), stagingPaths.channelsDir, 'channels'],
      [join(home, 'mcp-oauth'), stagingPaths.mcpOAuthDir, 'mcp-oauth'],
      [join(home, 'agent-configs'), stagingPaths.agentConfigsDir, 'agent-configs'],
      [join(home, 'browser'), stagingPaths.browserDir, 'browser']
    ]

    const digests = { ...journal.treeDigests }
    for (const [source, destination, key] of copies) {
      if (!existsSync(source)) continue
      copyTreeAtomic(source, destination)
      digests[key] = digestPath(destination)
    }

    const legacyData = join(home, '.data')
    if (existsSync(legacyData)) {
      this.mergeLegacyStandalone(legacyData, stagingPaths.threadDataStandalone)
      digests['thread-data/standalone'] = digestPath(stagingPaths.threadDataStandalone)
    }

    this.copyControlPlainFiles(join(home, 'control'), join(stagingRoot, 'control'))
    journal.treeDigests = digests
  }

  private mergeLegacyStandalone(legacyData: string, destination: string): void {
    ensureDir(destination)
    for (const entry of readdirSync(legacyData, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const source = join(legacyData, entry.name)
      const dest = join(destination, entry.name)
      if (existsSync(dest)) {
        if (!digestsEqual(digestPath(source), digestPath(dest))) {
          throw new MigrationValidationError('Legacy .data thread conflicts with thread-data/standalone', {
            threadId: entry.name
          })
        }
        continue
      }
      copyTreeAtomic(source, dest)
    }
  }

  private copyControlPlainFiles(sourceDir: string, destDir: string): void {
    if (!existsSync(sourceDir)) return
    ensureDir(destDir)
    for (const name of CONTROL_PLAIN_FILES) {
      const source = join(sourceDir, name)
      if (existsSync(source)) copyFileIfPresent(source, join(destDir, name))
    }
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (entry.name === CREDENTIALS_ENC) continue
      if (CONTROL_PLAIN_FILES.includes(entry.name as (typeof CONTROL_PLAIN_FILES)[number])) continue
      if (entry.isSymbolicLink()) {
        throw new MigrationValidationError('Refusing to copy a control symlink', {
          path: join(sourceDir, entry.name)
        })
      }
      copyFileIfPresent(join(sourceDir, entry.name), join(destDir, entry.name))
    }
  }

  private migrateCredentials(
    adapters: ProfileMigrationAdapters,
    stagingPaths: ProfilePaths
  ): NonNullable<MigrationJournal['credentialMigration']> {
    const sourceHome = this.installation.homeDir
    const destinationHome = stagingPaths.controlStoreHome
    const sourceEnc = join(sourceHome, 'control', CREDENTIALS_ENC)
    if (!existsSync(sourceEnc)) {
      return { sourceHome, destinationHome, migrated: false }
    }
    const plaintext = adapters.credentials.decryptFromControlHome(sourceHome)
    if (!plaintext) {
      throw new MigrationValidationError(
        'Control credentials exist at the legacy path but could not be decrypted',
        { sourceEnc }
      )
    }
    if (!adapters.credentials.verifyReadback(destinationHome, plaintext)) {
      adapters.credentials.encryptToControlHome(destinationHome, plaintext)
    }
    if (!adapters.credentials.verifyReadback(destinationHome, plaintext)) {
      throw new MigrationValidationError('Control credential readback failed after re-encryption', {
        destinationHome
      })
    }
    const destEnc = join(destinationHome, 'control', CREDENTIALS_ENC)
    if (existsSync(sourceEnc) && existsSync(destEnc)) {
      const sourceBytes = readFileSync(sourceEnc)
      const destBytes = readFileSync(destEnc)
      if (sourceBytes.equals(destBytes)) {
        throw new MigrationValidationError(
          'Destination credentials.enc is a byte-copy of the path-bound source record',
          { sourceEnc, destEnc }
        )
      }
    }
    return {
      sourceHome,
      destinationHome,
      migrated: true,
      accountId: plaintext.accountId
    }
  }

  private retainWorktrees(
    adapters: ProfileMigrationAdapters,
    profileId: ProfileId
  ): RetainedLegacyRoot[] {
    const inventory = inventoryLegacyHome(this.installation)
    const retained: RetainedLegacyRoot[] = []
    for (const source of inventory.repositoryWorktreeBases) {
      const destination = join(
        this.stagingProfileRoot(profileId),
        'repositories',
        source.slice(this.installation.repositoriesDir.length + 1)
      )
      const result = adapters.gitWorktrees.migrateWorktreeBase(source, destination, profileId)
      if (result.action === 'retained') {
        retained.push({
          kind: 'git-worktree-base',
          path: result.path,
          profileId,
          reason: result.reason === 'git-worktree-retain' ? 'git-worktree-retain' : 'explicit-owned-root'
        })
      }
    }
    for (const path of inventory.projectLegacyDataRoots) {
      retained.push({
        kind: 'project-data',
        path,
        profileId,
        reason: 'explicit-owned-root'
      })
    }
    return retained
  }

  private validateCopies(journal: MigrationJournal, stagingPaths: ProfilePaths): void {
    for (const [key, expected] of Object.entries(journal.treeDigests)) {
      const actualPath = this.digestTarget(key, stagingPaths)
      if (!existsSync(actualPath)) {
        throw new MigrationValidationError('Staged migration path is missing during validation', { key, actualPath })
      }
      const actual = digestPath(actualPath)
      if (!digestsEqual(expected, actual)) {
        throw new MigrationValidationError('Staged tree digest does not match the journal', {
          key,
          expected,
          actual
        })
      }
    }
  }

  private promoteStaging(defaultId: ProfileId): void {
    const liveRoot = this.installation.profileRoot(defaultId)
    const stagingRoot = this.stagingProfileRoot(defaultId)
    mkdirSync(this.installation.profilesDir, { recursive: true, mode: 0o700 })
    if (!existsSync(liveRoot)) {
      if (!existsSync(stagingRoot)) {
        throw new MigrationValidationError('Neither staging nor live Default profile root exists at promote', {
          stagingRoot,
          liveRoot
        })
      }
      renameSync(stagingRoot, liveRoot)
      return
    }
    if (existsSync(stagingRoot) && stagingRoot !== liveRoot) {
      const staged = digestPath(stagingRoot)
      const live = digestPath(liveRoot)
      if (!digestsEqual(staged, live)) {
        throw new MigrationValidationError('Live profile root already exists with a different hash', {
          stagingRoot,
          liveRoot
        })
      }
    }
  }

  private commit(
    journal: MigrationJournal,
    defaultId: ProfileId,
    now: string
  ): void {
    const liveRoot = this.installation.profileRoot(defaultId)
    if (!existsSync(liveRoot)) {
      throw new MigrationValidationError('Default profile root is missing at commit', { liveRoot })
    }
    const sourceEnc = join(this.installation.homeDir, 'control', CREDENTIALS_ENC)
    if (existsSync(sourceEnc) && !journal.credentialMigration?.migrated) {
      throw new MigrationValidationError('Control credentials were not migrated before manifest commit')
    }

    const livePaths = createProfilePaths(this.installation, defaultId)
    const record = JSON.parse(readFileSync(livePaths.profileManifest, 'utf8')) as ProfileRecord
    const installationConfPath = join(this.installation.migrationStagingDir, 'installation.mousse.conf')
    if (existsSync(installationConfPath)) {
      const installationConf = JSON.parse(readFileSync(installationConfPath, 'utf8')) as unknown
      atomicWriteJsonSync(this.installation.mousseConf, installationConf, { mode: 0o600 })
    }

    const manifest: InstallationManifest = {
      schemaVersion: INSTALLATION_SCHEMA_VERSION,
      contractId: PROFILE_CONTRACT_ID,
      contractVersion: PROFILE_CONTRACT_VERSION,
      createdAt: record.createdAt,
      updatedAt: now,
      defaultProfileId: defaultId,
      compatibility: { singleProfileLegacyClients: true },
      profiles: [
        {
          id: defaultId,
          slug: record.slug,
          status: record.status,
          rootRelativePath: `profiles/${defaultId}`
        }
      ],
      migration: {
        status: 'committed',
        journalRelativePath: 'migration/journal.json',
        lastCompletedStep: 'commit-manifest',
        committedAt: now,
        defaultProfileId: defaultId
      }
    }
    atomicWriteJsonSync(this.installation.installationManifest, manifest, { mode: 0o600 })
  }

  private profileWorkRoot(profileId: ProfileId): string {
    const liveRoot = this.installation.profileRoot(profileId)
    if (existsSync(liveRoot)) return liveRoot
    return this.stagingProfileRoot(profileId)
  }

  private snapshotOriginals(): void {
    const snapshot = this.installation.migrationSnapshotDir
    ensureDir(snapshot)
    const originals = [
      this.installation.mousseConf,
      join(this.installation.homeDir, 'projects.json'),
      join(this.installation.homeDir, 'threads-index.json')
    ]
    for (const original of originals) {
      if (!existsSync(original)) continue
      const dest = join(snapshot, original.slice(this.installation.homeDir.length + 1).replace(/[\\/]/g, '_'))
      if (!existsSync(dest)) copyFileIfPresent(original, dest)
    }
  }

  private defaultRecord(id: ProfileId, now: string): ProfileRecord {
    return {
      id,
      slug: DEFAULT_PROFILE_SLUG,
      displayName: DEFAULT_PROFILE_DISPLAY_NAME,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      status: 'active'
    }
  }

  private ensureLayout(paths: ProfilePaths, rootOverride: string): void {
    const dirs = [
      join(rootOverride, 'projects'),
      join(rootOverride, 'threads'),
      join(rootOverride, 'thread-data', 'standalone'),
      join(rootOverride, 'thread-data', 'repositories'),
      join(rootOverride, 'repositories'),
      join(rootOverride, 'agents'),
      join(rootOverride, 'workflows'),
      join(rootOverride, 'workflow-runs'),
      join(rootOverride, 'control'),
      join(rootOverride, 'secrets'),
      join(rootOverride, 'scheduled'),
      join(rootOverride, 'channels'),
      join(rootOverride, 'browser'),
      join(rootOverride, 'artifacts'),
      join(rootOverride, 'drafts'),
      join(rootOverride, 'presentation'),
      join(rootOverride, 'mcp-oauth'),
      join(rootOverride, 'agent-configs'),
      join(rootOverride, 'integrations', 'skills'),
      join(rootOverride, 'integrations', 'state')
    ]
    for (const dir of dirs) ensureDir(dir)
    void paths
  }

  private pathsForRoot(profileId: ProfileId, root: string): ProfilePaths {
    const live = createProfilePaths(this.installation, profileId)
    return Object.freeze({
      ...live,
      root,
      profileManifest: join(root, 'profile.json'),
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
    })
  }

  private stagingProfileRoot(profileId: ProfileId): string {
    return join(this.installation.migrationStagingDir, 'profiles', profileId)
  }

  private digestTarget(key: string, paths: ProfilePaths): string {
    const map: Record<string, string> = {
      'projects.json': paths.projectsJson,
      'threads-index.json': paths.threadsIndexJson,
      'active-thread.json': paths.activeThreadJson,
      'line-edits.json': paths.lineEditsJson,
      'thread-data/standalone': paths.threadDataStandalone,
      'thread-data/repositories': paths.threadDataRepositories,
      scheduled: paths.scheduledDir,
      channels: paths.channelsDir,
      'mcp-oauth': paths.mcpOAuthDir,
      'agent-configs': paths.agentConfigsDir,
      browser: paths.browserDir
    }
    const target = map[key]
    if (!target) throw new MigrationValidationError(`Unknown digest key ${key}`)
    return target
  }

  private persist(journal: MigrationJournal): void {
    writeJournal(this.installation.migrationJournal, journal)
  }

  private loadJournalOrEmpty(now: string, dryRun: boolean): MigrationJournal {
    return readJournal(this.installation.migrationJournal) ?? emptyJournal(now, dryRun)
  }

  private readCommittedManifest(): InstallationManifest | null {
    if (!existsSync(this.installation.installationManifest)) return null
    try {
      const parsed = JSON.parse(
        readFileSync(this.installation.installationManifest, 'utf8')
      ) as InstallationManifest
      if (parsed.schemaVersion === INSTALLATION_SCHEMA_VERSION && parsed.migration.status === 'committed') {
        return parsed
      }
      return null
    } catch {
      return null
    }
  }

  private report(journal: MigrationJournal, defaultPaths: ProfilePaths): MigrationReport {
    return {
      dryRun: false,
      alreadyCommitted: Boolean(journal.committedAt),
      defaultProfileId: journal.defaultProfileId,
      inventory: journal.inventory,
      unknownConfigKeys: journal.unknownConfigKeys,
      retainedLegacyRoots: journal.retainedLegacyRoots,
      journal,
      installationPaths: this.installation,
      defaultProfilePaths: defaultPaths
    }
  }
}

export function createProfileMigrationService(
  installation: InstallationPaths,
  manager = ProfileManager.open(installation)
): ProfileMigrationService {
  if (!pathsEqual(manager.installation.homeDir, installation.homeDir)) {
    throw new ProfileError('PROFILE_PATH_INVALID', 'Migration service manager home does not match installation paths')
  }
  return new ProfileMigrationService(installation, manager)
}

/** Durable write helper used by tests to plant a crash-before-commit journal. */
export function writeMigrationJournalForTests(path: string, journal: MigrationJournal): void {
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`)
}
