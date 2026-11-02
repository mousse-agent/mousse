/** Stable repository identity derived from Git's canonical common directory. */
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { repoProgramEnv, withoutRepoPrograms, withoutRepoProgramsAsync } from './repoPrograms'

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
    return execFileSync('git', withoutRepoPrograms(cwd, args), { cwd, env: repoProgramEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
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

/** What a repository allows, from Git's answers; `head` is asked only when the rest allow a mutation. */
function capabilityOf(commonRaw: string | null, bare: string | null, inside: string | null, head: () => string | null): RepositoryMutationCapability {
  if (!commonRaw) return { allowed: false, reason: 'not-a-repository' }
  if (bare === 'true' || inside !== 'true') return { allowed: false, reason: 'bare-repository' }
  if (!head()) return { allowed: false, reason: 'unborn-head' }
  return { allowed: true }
}

function keyOf(commonDir: string): string {
  return createHash('sha256').update(commonDir.toLowerCase()).digest('hex').slice(0, 32)
}

/** Resolve a stable identity. Git's common-dir intentionally makes linked worktrees share it. Code that can wait uses {@link resolveRepositoryIdentityAsync}. */
export function resolveRepositoryIdentity(cwd: string, options: ResolveRepositoryIdentityOptions = {}): RepositoryIdentity {
  const worktreePath = canonical(cwd)
  const commonRaw = git(worktreePath, 'rev-parse', '--git-common-dir')
  const bare = git(worktreePath, 'rev-parse', '--is-bare-repository')
  const inside = git(worktreePath, 'rev-parse', '--is-inside-work-tree')
  const capability = capabilityOf(commonRaw, bare, inside, () => git(worktreePath, 'rev-parse', '--verify', '--quiet', 'HEAD'))
  if (!capability.allowed && options.requireMutationCapability) throw new RepositoryIdentityError(capability)

  const commonDir = commonRaw ? canonical(isAbsolute(commonRaw) ? commonRaw : resolve(worktreePath, commonRaw)) : worktreePath
  const key = keyOf(commonDir)
  // Not a repository: the folder is the person's and no mutation lease is ever taken in it, so nothing is written there.
  if (!commonRaw) return { commonDir, key, worktreePath, metadataDir: '', capability }
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

function gitAsync(cwd: string, ...args: string[]): Promise<string | null> {
  return withoutRepoProgramsAsync(cwd, args).then(
    (argv) => new Promise<string | null>((settle) => {
      execFile('git', argv, { cwd, env: repoProgramEnv(), encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => settle(error ? null : stdout.trim()))
    }),
    () => null
  )
}

async function canonicalAsync(path: string): Promise<string> {
  try { return await realpath(path) } catch { return resolve(path) }
}

async function writableAsync(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true })
    const probe = join(dir, `.mousse-write-${process.pid}-${Date.now()}`)
    await writeFile(probe, '')
    await unlink(probe)
    return true
  } catch { return false }
}

/** How long the metadata folder chosen for a repository is reused before it is checked again. */
const METADATA_REUSE_MS = 60_000
const METADATA_LIMIT = 256

interface Metadata { at: number; metadataDir: string }

/** The metadata folder chosen for each repository (and fallback home), with when it was chosen. */
const metadataFolders = new Map<string, Metadata>()
/** Choices being made, so callers at the same time share one. */
const choosing = new Map<string, Promise<{ metadataDir: string; movedFrom?: string }>>()

/**
 * The repository's metadata folder: its own `mousse` folder when it can be written, else one under
 * `metadataHome`. It is chosen, created and its location hint written as {@link resolveRepositoryIdentity}
 * does, then reused for {@link METADATA_REUSE_MS} while the folder is still there. `movedFrom` is only
 * reported by the call that chose it, as a second synchronous call would not report it either.
 */
async function metadataFor(commonDir: string, key: string, metadataHome: string | undefined): Promise<{ metadataDir: string; movedFrom?: string }> {
  const id = `${commonDir}\0${metadataHome ?? ''}`
  const known = metadataFolders.get(id)
  if (known && Date.now() - known.at < METADATA_REUSE_MS && await stat(known.metadataDir).then((found) => found.isDirectory(), () => false)) {
    return { metadataDir: known.metadataDir }
  }
  const pending = choosing.get(id)
  if (pending) return pending
  const choice = (async () => {
    const localMetadata = join(commonDir, 'mousse')
    const metadataDir = await writableAsync(localMetadata)
      ? localMetadata
      : join(metadataHome ?? join(homedir(), '.mousse', 'repositories'), key)
    await mkdir(metadataDir, { recursive: true })
    const hintPath = join(metadataDir, 'repository-location.json')
    let movedFrom: string | undefined
    try {
      const previous = JSON.parse(await readFile(hintPath, 'utf8')) as { commonDir?: string }
      if (previous.commonDir && previous.commonDir !== commonDir) movedFrom = previous.commonDir
    } catch { /* first use */ }
    // A fallback directory is stable by common-dir hash; this hint provides diagnostics after a move.
    await writeFile(hintPath, JSON.stringify({ commonDir, updatedAt: new Date().toISOString() }) + '\n')
    if (metadataFolders.size >= METADATA_LIMIT) metadataFolders.delete(metadataFolders.keys().next().value!)
    metadataFolders.set(id, { at: Date.now(), metadataDir })
    return { metadataDir, movedFrom }
  })()
  choosing.set(id, choice)
  try {
    return await choice
  } finally {
    choosing.delete(id)
  }
}

/**
 * {@link resolveRepositoryIdentity} without blocking the daemon: Git runs as a child process (after its
 * folder's volume answers) and the metadata folder is checked and written with async calls. The same
 * Git questions are asked on every call, so the capability is always current; only the metadata folder
 * is reused for a minute, so a status poll does not write to the repository each time.
 */
export async function resolveRepositoryIdentityAsync(cwd: string, options: ResolveRepositoryIdentityOptions = {}): Promise<RepositoryIdentity> {
  const worktreePath = await canonicalAsync(cwd)
  const commonRaw = await gitAsync(worktreePath, 'rev-parse', '--git-common-dir')
  const bare = await gitAsync(worktreePath, 'rev-parse', '--is-bare-repository')
  const inside = await gitAsync(worktreePath, 'rev-parse', '--is-inside-work-tree')
  const head = commonRaw && bare !== 'true' && inside === 'true' ? await gitAsync(worktreePath, 'rev-parse', '--verify', '--quiet', 'HEAD') : null
  const capability = capabilityOf(commonRaw, bare, inside, () => head)
  if (!capability.allowed && options.requireMutationCapability) throw new RepositoryIdentityError(capability)

  const commonDir = commonRaw ? await canonicalAsync(isAbsolute(commonRaw) ? commonRaw : resolve(worktreePath, commonRaw)) : worktreePath
  const key = keyOf(commonDir)
  // Not a repository: the folder is the person's and no mutation lease is ever taken in it, so nothing is written there.
  if (!commonRaw) return { commonDir, key, worktreePath, metadataDir: '', capability }
  const { metadataDir, movedFrom } = await metadataFor(commonDir, key, options.metadataHome)
  return { commonDir, key, worktreePath, metadataDir, capability, movedFrom }
}

/** For tests: forget the metadata folders chosen. */
export function clearRepositoryIdentityCache(): void {
  metadataFolders.clear()
}

/** Refuse mutation explicitly instead of accidentally locking a bare or unborn repository. */
export function requireRepositoryMutationCapability(identity: RepositoryIdentity): void {
  if (!identity.capability.allowed) throw new RepositoryIdentityError(identity.capability)
}
