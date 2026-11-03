/** Stable repository identity derived from Git's canonical common directory. */
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, mkdirSync, realpath as realpathCallback, realpathSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { repoProgramEnv, withoutRepoPrograms, withoutRepoProgramsAsync } from './repoPrograms'
import { waitForFolderAccess } from '../files/folderAccess'

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

/** `realpathSync` without blocking. Not `fs/promises`' `realpath`, which answers like `realpathSync.native` and can spell the same folder differently (Unicode normalization, Windows short names), so keys would differ. */
const realpathLikeSync = promisify(realpathCallback)

async function canonicalAsync(path: string): Promise<string> {
  try { return await realpathLikeSync(path) } catch { return resolve(path) }
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

/** The repository key (`RepositoryIdentity.key`) of a common Git directory, read without blocking. */
export async function repositoryKeyOfCommonDir(commonDir: string): Promise<string> {
  return keyOf(await canonicalAsync(commonDir))
}

// ---------------------------------------------------------------------------------------------------------
// The metadata folder

/** How long the metadata folder chosen for a repository is reused before it is chosen again. */
const METADATA_REUSE_MS = 60_000
const METADATA_LIMIT = 256

/**
 * The metadata folder chosen for each repository (and fallback home), shared by the synchronous and the async
 * call, so both always name the same folder and so the same lease file.
 */
const metadataFolders = new Map<string, { at: number; metadataDir: string }>()

type MetadataStep =
  /** Whether a folder chosen before is still a folder Mousse may write to. */
  | { kind: 'usable'; path: string }
  | { kind: 'writable'; dir: string }
  | { kind: 'mkdir'; dir: string }
  | { kind: 'read'; path: string }
  | { kind: 'write'; path: string; content: string }

/**
 * The repository's metadata folder: its own `mousse` folder when it can be written, else one under
 * `metadataHome`. Once chosen (created, and its location hint written) the choice is reused for
 * {@link METADATA_REUSE_MS} while the folder is still there, so a status poll does not write to the repository
 * each time. `movedFrom` is reported by the call that chose it. Run by both the synchronous and the async call.
 */
function* chooseMetadata(commonDir: string, key: string, metadataHome: string | undefined): Generator<MetadataStep, { metadataDir: string; movedFrom?: string }, unknown> {
  const id = `${commonDir}\0${metadataHome ?? ''}`
  const known = metadataFolders.get(id)
  // A folder that stopped being writable is chosen again at once, as every call did before choices were reused.
  if (known && Date.now() - known.at < METADATA_REUSE_MS && (yield { kind: 'usable', path: known.metadataDir })) return { metadataDir: known.metadataDir }
  const localMetadata = join(commonDir, 'mousse')
  const metadataDir = (yield { kind: 'writable', dir: localMetadata })
    ? localMetadata
    : join(metadataHome ?? join(homedir(), '.mousse', 'repositories'), key)
  yield { kind: 'mkdir', dir: metadataDir }
  const hintPath = join(metadataDir, 'repository-location.json')
  let movedFrom: string | undefined
  try {
    const previous = JSON.parse((yield { kind: 'read', path: hintPath }) as string) as { commonDir?: string }
    if (previous.commonDir && previous.commonDir !== commonDir) movedFrom = previous.commonDir
  } catch { /* first use */ }
  // A fallback directory is stable by common-dir hash; this hint provides diagnostics after a move.
  yield { kind: 'write', path: hintPath, content: JSON.stringify({ commonDir, updatedAt: new Date().toISOString() }) + '\n' }
  metadataFolders.delete(id)
  if (metadataFolders.size >= METADATA_LIMIT) metadataFolders.delete(metadataFolders.keys().next().value!)
  metadataFolders.set(id, { at: Date.now(), metadataDir })
  return { metadataDir, movedFrom }
}

/** A name no other probe uses, so probes at the same time never remove each other's file. */
function writeProbe(dir: string): string {
  return join(dir, `.mousse-write-${process.pid}-${randomUUID()}`)
}

/** Answers a step at once. A failed `read` throws into the choice, as `readFileSync` did; a failed `mkdir` or `write` throws out of it. */
function metadataStepSync(step: MetadataStep): unknown {
  switch (step.kind) {
    case 'usable':
      try {
        accessSync(step.path, constants.W_OK)
        return statSync(step.path).isDirectory()
      } catch { return false }
    case 'writable':
      try {
        mkdirSync(step.dir, { recursive: true })
        const probe = writeProbe(step.dir)
        writeFileSync(probe, '')
        unlinkSync(probe)
        return true
      } catch { return false }
    case 'mkdir': return mkdirSync(step.dir, { recursive: true })
    case 'read': return readFileSync(step.path, 'utf8')
    case 'write': return writeFileSync(step.path, step.content)
  }
}

async function metadataStepAsync(step: MetadataStep): Promise<unknown> {
  switch (step.kind) {
    case 'usable': return access(step.path, constants.W_OK).then(() => stat(step.path)).then((found) => found.isDirectory(), () => false)
    case 'writable':
      try {
        await mkdir(step.dir, { recursive: true })
        const probe = writeProbe(step.dir)
        await writeFile(probe, '')
        await unlink(probe)
        return true
      } catch { return false }
    case 'mkdir': return mkdir(step.dir, { recursive: true })
    case 'read': return readFile(step.path, 'utf8')
    case 'write': return writeFile(step.path, step.content)
  }
}

type MetadataChoice = Generator<MetadataStep, { metadataDir: string; movedFrom?: string }, unknown>

function metadataFor(commonDir: string, key: string, metadataHome: string | undefined): { metadataDir: string; movedFrom?: string } {
  const choice: MetadataChoice = chooseMetadata(commonDir, key, metadataHome)
  let step = choice.next()
  while (!step.done) {
    let answer: unknown
    try { answer = metadataStepSync(step.value) } catch (error) {
      if (step.value.kind !== 'read') throw error
      step = choice.throw(error)
      continue
    }
    step = choice.next(answer)
  }
  return step.value
}

/** Async lookups under way, by repository and fallback home, so lookups at the same time share one. */
const choosing = new Map<string, Promise<{ metadataDir: string; movedFrom?: string }>>()

function metadataForAsync(commonDir: string, key: string, metadataHome: string | undefined): Promise<{ metadataDir: string; movedFrom?: string }> {
  const id = `${commonDir}\0${metadataHome ?? ''}`
  const pending = choosing.get(id)
  if (pending) return pending
  const lookup = runMetadataChoiceAsync(commonDir, key, metadataHome).finally(() => { if (choosing.get(id) === lookup) choosing.delete(id) })
  choosing.set(id, lookup)
  return lookup
}

async function runMetadataChoiceAsync(commonDir: string, key: string, metadataHome: string | undefined): Promise<{ metadataDir: string; movedFrom?: string }> {
  const choice: MetadataChoice = chooseMetadata(commonDir, key, metadataHome)
  let step = choice.next()
  while (!step.done) {
    let answer: unknown
    try { answer = await metadataStepAsync(step.value) } catch (error) {
      if (step.value.kind !== 'read') throw error
      step = choice.throw(error)
      continue
    }
    step = choice.next(answer)
  }
  return step.value
}

// ---------------------------------------------------------------------------------------------------------
// The identity

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
  const { metadataDir, movedFrom } = metadataFor(commonDir, key, options.metadataHome)
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

/**
 * {@link resolveRepositoryIdentity} without blocking the daemon. It first waits until the folder's volume
 * answers; then Git runs as a child process and the folder is read and written with async calls. It asks Git
 * the same questions on every call, so the capability is always current, and it shares the metadata folder
 * choice with the synchronous call, so both name the same lease file.
 */
export async function resolveRepositoryIdentityAsync(cwd: string, options: ResolveRepositoryIdentityOptions = {}): Promise<RepositoryIdentity> {
  await waitForFolderAccess([resolve(cwd)])
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
  const { metadataDir, movedFrom } = await metadataForAsync(commonDir, key, options.metadataHome)
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
