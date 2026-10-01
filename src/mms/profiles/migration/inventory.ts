import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MigrationAmbiguityError } from '../../../shared/profiles/errors'
import type { MigrationInventoryEntry, TreeDigest } from '../../../shared/profiles/types'
import type { InstallationPaths } from '../paths'
import { digestPath } from './digest'

export interface LegacyHomeInventory {
  entries: MigrationInventoryEntry[]
  ambiguousThreadIds: string[]
  projectLegacyDataRoots: string[]
  repositoryWorktreeBases: string[]
  hasLegacyPersonalData: boolean
}

function fileEntry(
  logicalName: string,
  sourcePath: string,
  scope: MigrationInventoryEntry['scope'],
  notes: string,
  destinationLogicalName?: string
): MigrationInventoryEntry {
  const exists = existsSync(sourcePath)
  let digest: TreeDigest | undefined
  // Retained installation roots are referenced in place and are never copied or
  // validated as owned profile content. In particular, repositories may contain
  // Git worktree junctions/symlinks, so recursively hashing them would reject a
  // valid installation before the worktree retention adapter can classify them.
  if (exists && scope !== 'retain-in-place') {
    const stat = lstatSync(sourcePath)
    if (stat.isSymbolicLink()) {
      throw new MigrationAmbiguityError('Legacy path is a symlink; refusing to inventory it as owned data', {
        sourcePath,
        logicalName
      })
    }
    digest = digestPath(sourcePath)
  }
  return {
    logicalName,
    sourcePath,
    destinationLogicalName,
    scope,
    exists,
    digest,
    notes
  }
}

function listChildNames(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
}

export function inventoryLegacyHome(installation: InstallationPaths): LegacyHomeInventory {
  const home = installation.homeDir
  const entries: MigrationInventoryEntry[] = [
    fileEntry('auth.json', installation.authJson, 'retain-in-place', 'Shared provider credentials stay installation-scoped.'),
    fileEntry('mms.owner.json', installation.ownerJson, 'retain-in-place', 'Installation owner lease stays at the home root.'),
    fileEntry('mms.runtime.json', installation.runtimeJson, 'retain-in-place', 'Daemon discovery stays at the home root.'),
    fileEntry('mms.sock', installation.unixSocket, 'retain-in-place', 'Unix endpoint identity stays at the home root.'),
    fileEntry('providers/', installation.providersDir, 'retain-in-place', 'Shared provider catalog/cache.'),
    fileEntry('repositories/', installation.repositoriesDir, 'retain-in-place', 'Shared repository identity/leases. Worktrees are not ordinary directories.'),
    fileEntry('browser-binaries/', installation.browserBinariesDir, 'retain-in-place', 'Verified browser distributions.'),
    fileEntry('mousse.conf', installation.mousseConf, 'installation', 'Split into installation and Default profile conf files.'),
    fileEntry('projects.json', join(home, 'projects.json'), 'profile', 'Personal project registry.', 'projects.json'),
    fileEntry('threads-index.json', join(home, 'threads-index.json'), 'profile', 'Thread metadata index.', 'threads-index.json'),
    fileEntry('active-thread.json', join(home, 'active-thread.json'), 'profile', 'Last active thread.', 'active-thread.json'),
    fileEntry('thread-data/standalone', join(home, 'thread-data', 'standalone'), 'profile', 'Durable standalone thread layout.', 'thread-data/standalone'),
    fileEntry('thread-data/repositories', join(home, 'thread-data', 'repositories'), 'profile', 'Durable repository-backed thread layout.', 'thread-data/repositories'),
    fileEntry('.data', join(home, '.data'), 'profile', 'Legacy standalone thread data.', 'thread-data/standalone'),
    fileEntry('scheduled/', join(home, 'scheduled'), 'profile', 'Scheduler runtime and history.', 'scheduled'),
    fileEntry('channels/', join(home, 'channels'), 'profile', 'Channel sessions, directory, and pairing.', 'channels'),
    fileEntry('control/', join(home, 'control'), 'profile', 'Plus/control stores. Credentials are re-encrypted, not byte-copied.', 'control'),
    fileEntry('mcp-oauth/', join(home, 'mcp-oauth'), 'profile', 'Integration OAuth sessions.', 'mcp-oauth'),
    fileEntry('agent-configs/', join(home, 'agent-configs'), 'profile', 'Generated agent configs.', 'agent-configs'),
    fileEntry('browser/', join(home, 'browser'), 'profile', 'Legacy browser storage is assigned to Default only.', 'browser'),
    fileEntry('line-edits.json', join(home, 'line-edits.json'), 'profile', 'Personal usage attribution.', 'line-edits.json'),
    fileEntry('settings.json', join(home, 'settings.json'), 'profile', 'Legacy settings file if still present.', 'settings.json.legacy')
  ]

  const standalone = join(home, 'thread-data', 'standalone')
  const legacyData = join(home, '.data')
  const standaloneIds = new Set(listChildNames(standalone))
  const legacyIds = new Set(listChildNames(legacyData))
  const ambiguousThreadIds: string[] = []
  for (const threadId of legacyIds) {
    if (!standaloneIds.has(threadId)) continue
    const a = digestPath(join(standalone, threadId))
    const b = digestPath(join(legacyData, threadId))
    if (a.sha256 !== b.sha256) ambiguousThreadIds.push(threadId)
  }
  if (ambiguousThreadIds.length > 0) {
    throw new MigrationAmbiguityError('Standalone thread data exists in both .data and thread-data with different hashes', {
      threadIds: ambiguousThreadIds
    })
  }

  const projectLegacyDataRoots: string[] = []
  const projectsPath = join(home, 'projects.json')
  if (existsSync(projectsPath)) {
    const parsed = JSON.parse(readFileSync(projectsPath, 'utf8')) as unknown
    const projectPaths = extractProjectPaths(parsed)
    for (const projectPath of projectPaths) {
      const legacyRoot = join(projectPath, '.mousse', '.data')
      if (existsSync(legacyRoot)) projectLegacyDataRoots.push(legacyRoot)
    }
  }

  const repositoryWorktreeBases: string[] = []
  if (existsSync(installation.repositoriesDir)) {
    for (const repo of listChildNames(installation.repositoriesDir)) {
      const worktrees = join(installation.repositoriesDir, repo, 'worktrees')
      if (existsSync(worktrees)) repositoryWorktreeBases.push(worktrees)
    }
  }

  const hasLegacyPersonalData = entries.some(
    (entry) => entry.scope === 'profile' && entry.exists && (entry.digest?.files ?? 0) > 0
  )

  return {
    entries,
    ambiguousThreadIds,
    projectLegacyDataRoots,
    repositoryWorktreeBases,
    hasLegacyPersonalData
  }
}

function extractProjectPaths(parsed: unknown): string[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => extractProjectPaths(item))
  }
  if (!parsed || typeof parsed !== 'object') return []
  const record = parsed as Record<string, unknown>
  const paths: string[] = []
  for (const key of ['path', 'projectPath', 'root']) {
    if (typeof record[key] === 'string' && record[key]) paths.push(record[key] as string)
  }
  if (Array.isArray(record.projects)) paths.push(...extractProjectPaths(record.projects))
  return paths
}
