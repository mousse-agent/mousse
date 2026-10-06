import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LegacyControlCredentials } from '../src/mms/profiles/migration/LegacyControlCredentials'
import { writeOriginalControlCredentials } from './fixtures/agent-platform/migration-crash/legacyCredentials'
import { FIXTURE_CONTROL_CREDENTIALS, FIXTURE_LEGACY_MOUSSE_CONF } from '../src/shared/profiles'
import { MigrationAmbiguityError, MigrationValidationError } from '../src/shared/profiles/errors'
import {
  createControlStoreCredentialAdapter,
  createInstallationPaths,
  createRetainingGitWorktreeAdapter,
  ProfileManager,
  ProfileMigrationService
} from '../src/mms/profiles'
import type { ProfileMigrationAdapters } from '../src/mms/profiles'

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-profiles-migration-'))
  tempDirs.push(dir)
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  return home
}

function adapters(): ProfileMigrationAdapters {
  return {
    credentials: createControlStoreCredentialAdapter(),
    gitWorktrees: createRetainingGitWorktreeAdapter()
  }
}

function plantLegacyHome(home: string): void {
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'shared' } }))
  writeFileSync(join(home, 'mms.owner.json'), JSON.stringify({ pid: 9, token: 'owner' }))
  writeFileSync(join(home, 'mms.runtime.json'), JSON.stringify({ ready: true }))
  writeFileSync(join(home, 'mousse.conf'), JSON.stringify(FIXTURE_LEGACY_MOUSSE_CONF, null, 2))
  writeFileSync(join(home, 'projects.json'), JSON.stringify([{ id: 'proj-1', path: join(home, '..', 'repo') }]))
  writeFileSync(join(home, 'threads-index.json'), JSON.stringify({ 'thread-1': { title: 'Hello' } }))
  writeFileSync(join(home, 'active-thread.json'), JSON.stringify({ threadId: 'thread-1' }))
  mkdirSync(join(home, 'thread-data', 'standalone', 'thread-1'), { recursive: true })
  writeFileSync(join(home, 'thread-data', 'standalone', 'thread-1', 'transcript.json'), '{"id":"thread-1"}')
  mkdirSync(join(home, 'scheduled'), { recursive: true })
  writeFileSync(join(home, 'scheduled', 'jobs-runtime.json'), JSON.stringify({ 'job-1': { state: 'idle' } }))
  mkdirSync(join(home, 'channels'), { recursive: true })
  writeFileSync(join(home, 'channels', 'sessions.json'), JSON.stringify({ s1: { id: 's1' } }))
  mkdirSync(join(home, 'mcp-oauth'), { recursive: true })
  writeFileSync(join(home, 'mcp-oauth', 'session.json'), JSON.stringify({ token: 'mcp' }))
  mkdirSync(join(home, 'repositories', 'repoaaaa', 'worktrees', 'threads', 'thread-1'), { recursive: true })
  writeFileSync(
    join(home, 'repositories', 'repoaaaa', 'worktrees', 'threads', 'thread-1', '.git'),
    'gitdir: /tmp/fake.git/worktrees/thread-1\n'
  )
  writeOriginalControlCredentials(home, { ...FIXTURE_CONTROL_CREDENTIALS })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('ProfileMigrationService', () => {
  it('inventories without committing on dry-run', () => {
    const home = tempHome()
    plantLegacyHome(home)
    const installation = createInstallationPaths(home)
    const service = new ProfileMigrationService(installation, ProfileManager.open(installation))
    const report = service.dryRun({ adapters: adapters() })
    expect(report.dryRun).toBe(true)
    expect(existsSync(installation.installationManifest)).toBe(false)
    expect(report.inventory.some((entry) => entry.logicalName === 'auth.json' && entry.scope === 'retain-in-place')).toBe(
      true
    )
    expect(report.unknownConfigKeys).toContain('experimentalUnknown')
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  })

  it('does not recursively hash retained repository roots containing worktree links', () => {
    const home = tempHome()
    plantLegacyHome(home)
    const linkedTarget = join(home, '..', 'linked-worktree')
    mkdirSync(linkedTarget, { recursive: true })
    symlinkSync(
      linkedTarget,
      join(home, 'repositories', 'repoaaaa', 'worktrees', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const installation = createInstallationPaths(home)
    const report = new ProfileMigrationService(installation, ProfileManager.open(installation)).dryRun({ adapters: adapters() })
    const repositories = report.inventory.find((entry) => entry.logicalName === 'repositories/')
    expect(repositories).toMatchObject({ exists: true, scope: 'retain-in-place', digest: undefined })
  })

  it('migrates personal stores, splits config, re-encrypts control credentials, and is idempotent', () => {
    const previousHome = process.env.MOUSSE_HOME
    const home = tempHome()
    plantLegacyHome(home)
    const sourceEnc = readFileSync(join(home, 'control', 'credentials.enc'))
    const installation = createInstallationPaths(home)
    const manager = ProfileManager.open(installation)
    const service = new ProfileMigrationService(installation, manager)
    const report = service.run({ adapters: adapters() })

    expect(report.alreadyCommitted).toBe(true)
    expect(report.defaultProfileId).toBeTruthy()
    const defaultId = report.defaultProfileId!
    const liveRoot = installation.profileRoot(defaultId)
    expect(existsSync(join(liveRoot, 'thread-data', 'standalone', 'thread-1', 'transcript.json'))).toBe(true)
    expect(existsSync(join(liveRoot, 'scheduled', 'jobs-runtime.json'))).toBe(true)
    expect(existsSync(join(liveRoot, 'channels', 'sessions.json'))).toBe(true)
    expect(existsSync(join(liveRoot, 'secrets', 'mcp-oauth', 'session.json'))).toBe(true)

    const installationConf = JSON.parse(readFileSync(installation.mousseConf, 'utf8')) as Record<string, unknown>
    const profileConf = JSON.parse(readFileSync(join(liveRoot, 'mousse.conf'), 'utf8')) as Record<string, unknown>
    expect(installationConf.mms).toEqual({ autostart: false, logLevel: 'info' })
    expect(installationConf.experimentalUnknown).toEqual({ keep: true })
    expect(profileConf.providers).toEqual(FIXTURE_LEGACY_MOUSSE_CONF.providers)
    expect(profileConf.scheduled).toEqual(FIXTURE_LEGACY_MOUSSE_CONF.scheduled)
    expect(profileConf.channels).toEqual(FIXTURE_LEGACY_MOUSSE_CONF.channels)

    expect(existsSync(join(home, 'auth.json'))).toBe(true)
    expect(existsSync(join(home, 'mms.owner.json'))).toBe(true)
    expect(existsSync(join(home, 'mms.runtime.json'))).toBe(true)
    expect(report.retainedLegacyRoots.some((root) => root.kind === 'git-worktree-base')).toBe(true)
    expect(existsSync(join(home, 'repositories', 'repoaaaa', 'worktrees', 'threads', 'thread-1', '.git'))).toBe(
      true
    )

    const destEnc = readFileSync(join(liveRoot, 'control', 'credentials.enc'))
    expect(destEnc.equals(sourceEnc)).toBe(false)
    const destStore = new LegacyControlCredentials(liveRoot)
    expect(destStore.getCredentials()?.refreshToken).toBe(FIXTURE_CONTROL_CREDENTIALS.refreshToken)
    expect(new LegacyControlCredentials(home).getCredentials()?.accountId).toBe(FIXTURE_CONTROL_CREDENTIALS.accountId)

    const listed = manager.list()
    expect(listed).toHaveLength(1)
    expect(listed[0].slug).toBe('default')
    const alice = manager.create({ displayName: 'Alice', slug: 'alice' })
    const a = manager.bind(alice.id)
    const d = manager.bind('default')
    expect(a.installation.authJson).toBe(d.installation.authJson)
    expect(a.paths.root).not.toBe(d.paths.root)

    const again = service.run({ adapters: adapters() })
    expect(again.alreadyCommitted).toBe(true)
    expect(again.defaultProfileId).toBe(defaultId)
    expect(process.env.MOUSSE_HOME).toBe(previousHome)
  })

  it('migrates legacy settings and browser storage into Default without changing shared roots', () => {
    const home = tempHome()
    plantLegacyHome(home)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      profile: { username: 'legacy-user' },
      appearance: { theme: 'dark' },
      provider: { llmProvider: 'fixture-provider', model: 'fixture-model' },
      agents: { enabled: { fixture: true } }
    }))
    mkdirSync(join(home, 'browser', 'Default', 'Cookies'), { recursive: true })
    writeFileSync(join(home, 'browser', 'Default', 'Cookies', 'fixture.txt'), 'default-only')
    const installation = createInstallationPaths(home)
    const service = new ProfileMigrationService(installation, ProfileManager.open(installation))
    const report = service.run({ adapters: adapters() })
    const profileRoot = installation.profileRoot(report.defaultProfileId!)
    const profileConf = JSON.parse(readFileSync(join(profileRoot, 'mousse.conf'), 'utf8')) as Record<string, any>
    expect(profileConf.settings.profile.username).toBe('legacy-user')
    expect(profileConf.settings.appearance.theme).toBe('dark')
    expect(profileConf.providers.llmProvider).toBe('fixture-provider')
    expect(profileConf.agents.enabled.fixture).toBe(true)
    expect(readFileSync(join(profileRoot, 'browser', 'Default', 'Cookies', 'fixture.txt'), 'utf8')).toBe('default-only')
    expect(existsSync(join(home, 'auth.json'))).toBe(true)
    expect(existsSync(join(home, 'browser', 'Default', 'Cookies', 'fixture.txt'))).toBe(true)
  })

  it('fails closed on a byte-copied credentials.enc and requires the injectable adapter', () => {
    const home = tempHome()
    const other = join(home, '..', 'other-home')
    mkdirSync(other, { recursive: true })
    writeOriginalControlCredentials(home, { ...FIXTURE_CONTROL_CREDENTIALS })
    mkdirSync(join(other, 'control'), { recursive: true })
    writeFileSync(join(other, 'control', 'credentials.enc'), readFileSync(join(home, 'control', 'credentials.enc')))
    expect(new LegacyControlCredentials(other).getCredentials()).toBeNull()

    const adapter = createControlStoreCredentialAdapter()
    const plain = adapter.decryptFromControlHome(home)
    expect(plain?.accessToken).toBe('access-fixture')
    adapter.encryptToControlHome(other, plain!)
    expect(adapter.verifyReadback(other, plain!)).toBe(true)
    expect(new LegacyControlCredentials(other).getCredentials()?.accountId).toBe('usr-fixture-1')
  })

  it('resumes after a crash before commit without treating staging as authoritative', () => {
    const home = tempHome()
    plantLegacyHome(home)
    const installation = createInstallationPaths(home)
    const service = new ProfileMigrationService(installation, ProfileManager.open(installation))
    expect(() =>
      service.run({
        adapters: adapters(),
        hooks: {
          beforeCommit() {
            throw new Error('injected crash before commit')
          }
        }
      })
    ).toThrow(/injected crash before commit/)
    expect(existsSync(installation.installationManifest)).toBe(false)
    expect(existsSync(installation.migrationJournal)).toBe(true)

    const recovered = service.run({ adapters: adapters() })
    expect(recovered.alreadyCommitted).toBe(true)
    expect(existsSync(installation.installationManifest)).toBe(true)
    expect(JSON.parse(readFileSync(installation.installationManifest, 'utf8')).schemaVersion).toBe(2)
  })

  it('records the interrupted step and can roll back staged v2 state before restart', () => {
    const home = tempHome()
    plantLegacyHome(home)
    const installation = createInstallationPaths(home)
    const service = new ProfileMigrationService(installation, ProfileManager.open(installation))
    expect(() => service.run({
      adapters: adapters(),
      hooks: {
        beforeStep(step) {
          if (step === 'split-config') throw new Error('injected split boundary')
        }
      }
    })).toThrow(/injected split boundary/)
    const journal = JSON.parse(readFileSync(installation.migrationJournal, 'utf8'))
    expect(journal.currentStep).toBe('split-config')
    expect(journal.completedSteps).not.toContain('split-config')
    expect(() => service.rollback()).not.toThrow()
    expect(existsSync(installation.installationManifest)).toBe(false)
    expect(existsSync(installation.migrationStagingDir)).toBe(false)
    expect(service.run({ adapters: adapters() }).alreadyCommitted).toBe(true)
  })

  it('rolls back a profile promoted immediately before the completion journal write', () => {
    const home = tempHome()
    plantLegacyHome(home)
    const installation = createInstallationPaths(home)
    const service = new ProfileMigrationService(installation, ProfileManager.open(installation))
    expect(() => service.run({
      adapters: adapters(),
      hooks: {
        afterStepAction(step) {
          if (step === 'promote-staging') throw new Error('injected crash after profile rename')
        }
      }
    })).toThrow(/injected crash after profile rename/)
    const interrupted = JSON.parse(readFileSync(installation.migrationJournal, 'utf8'))
    const defaultId = interrupted.defaultProfileId as string
    expect(interrupted.currentStep).toBe('promote-staging')
    expect(interrupted.completedSteps).not.toContain('promote-staging')
    expect(existsSync(installation.profileRoot(defaultId))).toBe(true)

    const rolledBack = service.rollback()
    expect(rolledBack.removedPaths).toContain(installation.profileRoot(defaultId))
    expect(existsSync(installation.profileRoot(defaultId))).toBe(false)
    expect(service.run({ adapters: adapters() }).alreadyCommitted).toBe(true)
  })

  it('requires explicit acknowledgement to roll back committed data and restores the legacy config', () => {
    const home = tempHome()
    plantLegacyHome(home)
    const originalConfig = readFileSync(join(home, 'mousse.conf'))
    const installation = createInstallationPaths(home)
    const service = new ProfileMigrationService(installation, ProfileManager.open(installation))
    const report = service.run({ adapters: adapters() })
    expect(() => service.rollback()).toThrow(/allowCommittedDataLoss/)
    const rolledBack = service.rollback({ allowCommittedDataLoss: true })
    expect(rolledBack.committed).toBe(true)
    expect(existsSync(installation.installationManifest)).toBe(false)
    expect(existsSync(installation.profileRoot(report.defaultProfileId!))).toBe(false)
    expect(readFileSync(join(home, 'mousse.conf')).equals(originalConfig)).toBe(true)
    expect(service.run({ adapters: adapters() }).alreadyCommitted).toBe(true)
  })

  it('resumes after a crash after commit as already committed', () => {
    const home = tempHome()
    plantLegacyHome(home)
    const installation = createInstallationPaths(home)
    const service = new ProfileMigrationService(installation, ProfileManager.open(installation))
    expect(() =>
      service.run({
        adapters: adapters(),
        hooks: {
          afterCommit() {
            throw new Error('injected crash after commit')
          }
        }
      })
    ).toThrow(/injected crash after commit/)
    expect(existsSync(installation.installationManifest)).toBe(true)
    const recovered = service.run({ adapters: adapters() })
    expect(recovered.alreadyCommitted).toBe(true)
  })

  it('fails closed on malformed manifests and non-prefix migration journals', () => {
    const malformedManifestHome = tempHome()
    plantLegacyHome(malformedManifestHome)
    const malformedInstallation = createInstallationPaths(malformedManifestHome)
    writeFileSync(malformedInstallation.installationManifest, '{"schemaVersion":2')
    const malformedService = new ProfileMigrationService(
      malformedInstallation,
      ProfileManager.open(malformedInstallation)
    )
    expect(() => malformedService.run({ adapters: adapters() })).toThrow(MigrationValidationError)
    expect(readFileSync(malformedInstallation.installationManifest, 'utf8')).toBe('{"schemaVersion":2')

    const badJournalHome = tempHome()
    plantLegacyHome(badJournalHome)
    const badJournalInstallation = createInstallationPaths(badJournalHome)
    mkdirSync(badJournalInstallation.migrationDir, { recursive: true })
    writeFileSync(badJournalInstallation.migrationJournal, JSON.stringify({
      version: 1,
      dryRun: false,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentStep: 'split-config',
      completedSteps: ['acquire-lease', 'split-config'],
      inventory: [],
      unknownConfigKeys: [],
      retainedLegacyRoots: [],
      treeDigests: {}
    }))
    const badJournalService = new ProfileMigrationService(
      badJournalInstallation,
      ProfileManager.open(badJournalInstallation)
    )
    expect(() => badJournalService.run({ adapters: adapters() })).toThrow(MigrationValidationError)
  })

  it('fails safely when legacy standalone data is ambiguous', () => {
    const home = tempHome()
    mkdirSync(join(home, 'thread-data', 'standalone', 'thread-1'), { recursive: true })
    mkdirSync(join(home, '.data', 'thread-1'), { recursive: true })
    writeFileSync(join(home, 'thread-data', 'standalone', 'thread-1', 'a.json'), '{"v":1}')
    writeFileSync(join(home, '.data', 'thread-1', 'a.json'), '{"v":2}')
    const installation = createInstallationPaths(home)
    const service = new ProfileMigrationService(installation, ProfileManager.open(installation))
    expect(() => service.dryRun({ adapters: adapters() })).toThrow(MigrationAmbiguityError)
    expect(() => service.run({ adapters: adapters() })).toThrow(MigrationAmbiguityError)
    expect(existsSync(installation.installationManifest)).toBe(false)
  })

  it('fails when encrypted control credentials cannot be decrypted by the adapter', () => {
    const home = tempHome()
    plantLegacyHome(home)
    const installation = createInstallationPaths(home)
    const service = new ProfileMigrationService(installation, ProfileManager.open(installation))
    expect(() =>
      service.run({
        adapters: {
          credentials: {
            decryptFromControlHome: () => null,
            encryptToControlHome: () => {
              throw new Error('should not encrypt')
            },
            verifyReadback: () => false
          },
          gitWorktrees: createRetainingGitWorktreeAdapter()
        }
      })
    ).toThrow(MigrationValidationError)
    expect(existsSync(installation.installationManifest)).toBe(false)
  })
})
