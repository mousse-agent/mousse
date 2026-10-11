import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { LegacyControlCredentials } from './LegacyControlCredentials'
import type { ProfileId } from '../../../shared/profiles/ids'
import type { ControlCredentialsPlaintext } from '../../../shared/profiles/types'
import { digestPath } from './digest'
import type {
  ControlCredentialMigrationAdapter,
  GitWorktreeInspection,
  GitWorktreeMigrationAdapter,
  GitWorktreeMigrationResult,
  MigrationCopyAdapter
} from './types'
import { copyTreeAtomic } from './copy'

export function createControlStoreCredentialAdapter(): ControlCredentialMigrationAdapter {
  return {
    decryptFromControlHome(homeDir: string): ControlCredentialsPlaintext | null {
      return new LegacyControlCredentials(homeDir).getCredentials()
    },
    encryptToControlHome(homeDir: string, credentials: ControlCredentialsPlaintext): void {
      new LegacyControlCredentials(homeDir).saveCredentials(credentials)
    },
    verifyReadback(homeDir: string, expected: ControlCredentialsPlaintext): boolean {
      const loaded = new LegacyControlCredentials(homeDir).getCredentials()
      if (!loaded) return false
      return (
        loaded.accountId === expected.accountId &&
        loaded.accessToken === expected.accessToken &&
        loaded.refreshToken === expected.refreshToken &&
        loaded.deviceEnrollmentToken === expected.deviceEnrollmentToken
      )
    }
  }
}

function looksLikeGitWorktree(path: string): GitWorktreeInspection {
  const gitPath = join(path, '.git')
  if (!existsSync(gitPath)) {
    return { path, isGitWorktree: false, registered: false }
  }
  try {
    const stat = lstatSync(gitPath)
    if (stat.isFile()) {
      const raw = readFileSync(gitPath, 'utf8')
      const match = raw.match(/gitdir:\s*(.+)\s*$/m)
      return {
        path,
        isGitWorktree: true,
        registered: true,
        gitDir: match?.[1]?.trim()
      }
    }
    return { path, isGitWorktree: true, registered: true, gitDir: gitPath }
  } catch {
    return { path, isGitWorktree: true, registered: false }
  }
}

function directoryContainsGitWorktree(path: string): boolean {
  if (!existsSync(path)) return false
  const inspection = looksLikeGitWorktree(path)
  if (inspection.isGitWorktree) return true
  let found = false
  const visit = (current: string, depth: number): void => {
    if (found || depth > 6) return
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const child = join(current, entry.name)
      if (looksLikeGitWorktree(child).isGitWorktree) {
        found = true
        return
      }
      visit(child, depth + 1)
    }
  }
  try {
    visit(path, 0)
  } catch {
    return false
  }
  return found
}

/**
 * Default Git adapter: never byte-moves registered worktrees. Retain the legacy
 * physical location with an explicit profile ownership record.
 */
export function createRetainingGitWorktreeAdapter(): GitWorktreeMigrationAdapter {
  return {
    inspect(path: string): GitWorktreeInspection {
      return looksLikeGitWorktree(path)
    },
    migrateWorktreeBase(source: string, _destination: string, _profileId: ProfileId): GitWorktreeMigrationResult {
      if (directoryContainsGitWorktree(source) || looksLikeGitWorktree(source).isGitWorktree) {
        return {
          action: 'retained',
          path: source,
          reason: 'git-worktree-retain'
        }
      }
      return {
        action: 'retained',
        path: source,
        reason: 'explicit-owned-root'
      }
    }
  }
}

export function createHashingCopyAdapter(): MigrationCopyAdapter {
  return {
    copyTree(source: string, destination: string) {
      copyTreeAtomic(source, destination)
      return digestPath(destination)
    }
  }
}
