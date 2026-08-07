/** Stable repository identity derived from Git's canonical common directory. */
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

export type RepositoryMutationCapability =
  | { allowed: true }
  | { allowed: false; reason: 'not-a-repository' | 'bare-repository' | 'unborn-head' }

export interface RepositoryIdentity {
  /** Canonical Git common directory; identical for all linked worktrees. */
  commonDir: string
  /** Stable, path-derived identifier suitable for metadata filenames. */
  key: string
  /** Supplied working directory, resolved for diagnostics. */
  worktreePath: string
  metadataDir: string
  capability: RepositoryMutationCapability
  /** Previous canonical location recorded for this key, if the repository was moved. */
  movedFrom?: string
}

export class RepositoryIdentityError extends Error {
  constructor(readonly capability: Exclude<RepositoryMutationCapability, { allowed: true }>) {
    super(`Repository mutations are unavailable: ${capability.reason}`)
    this.name = 'RepositoryIdentityError'
  }
}

export interface ResolveRepositoryIdentityOptions {
  /** Used only when .git metadata is not writable. Defaults to ~/.mousse/repositories. */
  metadataHome?: string
  /** Throw rather than return an identity with a refused capability. */
  requireMutationCapability?: boolean
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return null }
}
function canonical(path: string): string { try { return realpathSync(path) } catch { return resolve(path) } }
function writable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.mousse-write-${process.pid}-${Date.now()}`)
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch { return false }
}

/** Resolve a stable identity. Git's common-dir intentionally makes linked worktrees share it. */
export function resolveRepositoryIdentity(cwd: string, options: ResolveRepositoryIdentityOptions = {}): RepositoryIdentity {
  const worktreePath = canonical(cwd)
  const commonRaw = git(worktreePath, 'rev-parse', '--git-common-dir')
  const bare = git(worktreePath, 'rev-parse', '--is-bare-repository')
  const inside = git(worktreePath, 'rev-parse', '--is-inside-work-tree')
  let capability: RepositoryMutationCapability = { allowed: true }
  if (!commonRaw) capability = { allowed: false, reason: 'not-a-repository' }
  else if (bare === 'true' || inside !== 'true') capability = { allowed: false, reason: 'bare-repository' }
  else if (!git(worktreePath, 'rev-parse', '--verify', '--quiet', 'HEAD')) capability = { allowed: false, reason: 'unborn-head' }
  if (!capability.allowed && options.requireMutationCapability) throw new RepositoryIdentityError(capability)

  const commonDir = commonRaw ? canonical(isAbsolute(commonRaw) ? commonRaw : resolve(worktreePath, commonRaw)) : worktreePath
  const key = createHash('sha256').update(commonDir.toLowerCase()).digest('hex').slice(0, 32)
  const localMetadata = join(commonDir, 'mousse')
  const metadataDir = writable(localMetadata)
    ? localMetadata
    : join(options.metadataHome ?? join(homedir(), '.mousse', 'repositories'), key)
  mkdirSync(metadataDir, { recursive: true })
  const hintPath = join(metadataDir, 'repository-location.json')
  let movedFrom: string | undefined
  try {
    const previous = JSON.parse(readFileSync(hintPath, 'utf8')) as { commonDir?: string }
    if (previous.commonDir && previous.commonDir !== commonDir) movedFrom = previous.commonDir
  } catch { /* first use */ }
  // A fallback directory is stable by common-dir hash; this hint provides diagnostics after a move.
  writeFileSync(hintPath, JSON.stringify({ commonDir, updatedAt: new Date().toISOString() }) + '\n')
  return { commonDir, key, worktreePath, metadataDir, capability, movedFrom }
}

/** Refuse mutation explicitly instead of accidentally locking a bare or unborn repository. */
export function requireRepositoryMutationCapability(identity: RepositoryIdentity): void {
  if (!identity.capability.allowed) throw new RepositoryIdentityError(identity.capability)
}
