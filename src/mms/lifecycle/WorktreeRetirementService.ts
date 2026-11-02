import { MOUSSE_CONTROL_FILE_PATHS } from '../worktree/controlFiles'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpath as realpathCallback, type BigIntStats, type Stats } from 'node:fs'
import { access, chmod, lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { assertLifecyclePath, assertLifecyclePathAsync, ResourceLifecycleStore } from './ResourceLifecycleStore'
import type { RepositoryLeaseHandle } from '../git/RepositoryLease'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { assertHeldThreadLease } from '../actions/GitOperationCoordinator'
import { operationInProgressAsync } from '../actions/git'
import { moveFilesAsync, sameTreeAsync, takeSnapshotAsync, worktreeTreeAsync } from '../actions/snapshots'
import { PROCESS_INSTANCE_ID } from '../queue/processLiveness'
import { AgentEpisodeStore } from '../agents/AgentEpisodeStore'
import { WorktreeIdentity } from '../worktree/WorktreeIdentity'
import { ThreadJournal } from '../data/ThreadJournal'
import { getExternalResourceClaims, getExternalResourceClaimsFromFacts } from './LifecycleClaims'
import { OwnershipFacts } from './ResourceInventory'
import type { ConversationBranch, ThreadAction } from '../../shared/threadActions'
import { gitDirectoryEnvAsync } from '../git/gitEnv'
import { READ_ONLY_GIT_ENV } from '../git/readOnlyGit'
import { repoProgramEnv, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { gitRunError, runGitProcess } from '../git/runGitProcess'
import { renameFolderAsync } from './renameFolder'
import { isIdNamedMousseBranch, isMousseBranchName } from '../../shared/mousseBranches'

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
/** A retired worktree waits in the trash until nothing in it has changed for this long; then its files are snapshotted and it is deleted. */
export const WORKTREE_TRASH_QUIET_MS = 60 * 60_000
/** The record of a worktree in the trash changed or went (a permanent deletion) while it was being expired. */
/** A folder in the trash as it is compared before its delete: its HEAD and every entry's bytes. */
function trashedStateOf(head: string, content: readonly ContentEntry[]): string {
  return JSON.stringify([head, content])
}
class TrashRecordChanged extends Error {
  constructor() { super('Its record changed while it was being deleted; it is looked at again on the next run') }
}
/**
 * Git for lifecycle work, without blocking the daemon: it waits until the folder's volume answers, runs the central
 * check, and the command with a 30-second limit. A failure carries Git's `status`, `stdout` and `stderr`.
 * `beforeStart` runs synchronously right before Git starts, after every wait: a check that must hold when a destructive
 * command begins goes there, so nothing is awaited between it and the command.
 */
export async function lifecycleGitAsync(cwd: string, args: string[], input?: string, maxBuffer = 32 * 1024 * 1024, env?: NodeJS.ProcessEnv, beforeStart?: () => void): Promise<string> {
  const argv = await withoutRepoProgramsAsync(cwd, args, { stdin: input, env })
  const runEnv = repoProgramEnv({ ...process.env, ...await gitDirectoryEnvAsync(cwd), ...env })
  beforeStart?.()
  const ran = await runGitProcess(argv, { cwd, input, env: runEnv, timeout: 30_000, maxBuffer })
  if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
  return ran.stdout.trimEnd()
}
/** A lifecycle read (a preview, the checks before a delete): it never refreshes the index and never fetches a missing object. */
export function lifecycleReadAsync(cwd: string, args: string[], input?: string, maxBuffer?: number): Promise<string> {
  return lifecycleGitAsync(cwd, args, input, maxBuffer, READ_ONLY_GIT_ENV)
}
/** Never treat an unreadable reference as absent, and never dereference an owned symbolic ref. */
export async function readDirectLifecycleRefAsync(cwd: string, ref: string): Promise<string | undefined> {
  try { await lifecycleGitAsync(cwd, ['symbolic-ref', '-q', ref]); throw new Error(`Symbolic resource reference is not cleanup authority: ${ref}`) }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error }
  const args = ['for-each-ref', '--format=%(refname)%00%(objectname)', ref]
  const listing = await runGitProcess(await withoutRepoProgramsAsync(cwd, args), { cwd, env: repoProgramEnv({ ...process.env, ...await gitDirectoryEnvAsync(cwd), ...READ_ONLY_GIT_ENV }), timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
  // Git may warn about a corrupt loose ref while exiting successfully and omitting it.
  if (listing.error || listing.status !== 0 || listing.stderr.trim()) throw new Error(`Resource reference inventory is unreadable: ${ref}`)
  const row = listing.stdout.split(/\r?\n/).find((entry) => entry.split('\0')[0] === ref)
  if (!row) return undefined
  const sha = row.split('\0')[1]
  if (!sha || !/^[a-f0-9]{40,64}$/.test(sha) || /^0+$/.test(sha)) throw new Error(`Existing resource reference is malformed or unreadable: ${ref}`)
  return sha
}
function same(a: string, b: string): boolean { return (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)) }
export interface ContentEntry { path: string; kind: 'file' | 'directory' | 'link'; digest: string; bytes: number; mode: number }


export interface WorktreeReconstructionManifest {
  schemaVersion: 1
  profileId: string
  taskId: string
  worktreePath: string
  branch: string
  repositoryId: string
  commonDir: string
  gitDirectory: string
  rootIdentity: { dev: number; ino: number; birthtimeMs: number }
  sourcePath: string
  baseSha: string
  resultSha: string
  treeSha: string
  checkoutFingerprint: string
  baseRef: string
  resultRef: string
  /**
   * Set when the worktree held uncommitted files: `snapshotSha` is a snapshot of all of its files (its parent is the
   * HEAD in `resultSha`), pinned under `snapshotRef`, and `snapshotTree` its tree. Reconstruction writes those files
   * over a checkout of `resultSha`. Absent for a worktree whose files were its HEAD.
   */
  snapshotSha?: string
  snapshotTree?: string
  snapshotRef?: string
  /** The branch HEAD was on when the worktree was retired; absent when it was detached. The agent may have left the thread's own branch. */
  headBranch?: string
  sparse?: { patterns: string; cone: boolean }
  auxiliary: Array<{ path: string; content: string }>
  content: ContentEntry[]
  /**
   * Where the folder waits in Mousse's trash (`trashPathFor`), set before it is moved there. It was moved in one step and
   * stays registered with Git at that path. A process may still have its working directory there and write to it.
   */
  trashPath?: string
  /** When the folder reached the trash; set with state `trashed`. */
  trashedAt?: string
  /**
   * Earlier pins the trash expiry did not replace because the new pin does not contain them (the folder's HEAD moved
   * away from them): each stays under its own ref, `<prefix>/kept/<sha>`, and goes only with the owner.
   */
  keptRefs?: string[]
  /** Owned branches deleted once their tips were kept by the pins here, so a restore can bring them back. */
  deletedBranches?: Array<{ name: string; sha: string }>
  /** Branches a restore could not bring back because their commit is gone from the repository. */
  branchesNotRestored?: Array<{ name: string; sha: string }>
  /**
   * `prepared`: pins written, folder in place. `trashed`: the folder is in the trash. `retired`: its files were
   * snapshotted and it was deleted. `materialized`: the worktree is back at its own path.
   */
  state: 'prepared' | 'trashed' | 'retired' | 'materialized'
}
/** `realpathSync` without blocking (not `fs/promises`' `realpath`, which answers like `realpathSync.native`). */
const realpathLikeSync = promisify(realpathCallback)
/** `existsSync`, without blocking. */
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
/** Entries whose `lstat` is read together, so a large folder is not walked one call at a time. */
const STAT_BATCH = 256

/** The `lstat` of each path in order, read in batches; a failed read is kept to be thrown where the walk meets it. */
async function lstatAll(paths: readonly string[]): Promise<Array<Stats | { error: unknown }>> {
  const stats: Array<Stats | { error: unknown }> = []
  for (let start = 0; start < paths.length; start += STAT_BATCH) {
    stats.push(...await Promise.all(paths.slice(start, start + STAT_BATCH).map((path) => lstat(path).catch((error: unknown) => ({ error })))))
  }
  return stats
}
function statOrThrow(stat: Stats | { error: unknown }): Stats {
  if ('error' in stat) throw stat.error
  return stat
}

/**
 * An entry of frozen content checked without blocking, with what the check was made from: its `lstat` before and after its
 * bytes were read (identical), so {@link assertFrozenEntryUnchanged} can tell, synchronously and right before the entry is
 * changed, that it is still those bytes.
 */
export interface FrozenEntryProof { path: string; entry: ContentEntry; signature: string; coarse: boolean }

/** What an entry's `lstat` says, to tell whether it changed since: device, inode, type, mode, links, size and both times. */
function statSignature(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}
/**
 * Times a write cannot be told apart by: whole milliseconds or coarser (an HFS+ or FAT volume, some network shares).
 * There the bytes themselves are compared again instead.
 */
function coarseTimes(stat: BigIntStats): boolean {
  return stat.mtimeNs % 1_000_000n === 0n && stat.ctimeNs % 1_000_000n === 0n
}
function kindOf(stat: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): ContentEntry['kind'] | 'unknown' {
  return stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unknown'
}

/**
 * Refuses an entry that is no longer exactly as frozen (kind, mode, size, links, content), reading it without blocking, and
 * returns what the check was made from. The entry is read between two `lstat`s that must agree, so the bytes checked are
 * the bytes the returned signature describes. The caller removes it only after {@link assertFrozenEntryUnchanged}, with
 * nothing awaited in between.
 */
export async function proveFrozenContentEntryAsync(root: string, entry: ContentEntry): Promise<FrozenEntryProof> {
  const path = join(root, entry.path)
  await assertLifecyclePathAsync(dirname(root), root)
  if (entry.path) await assertLifecyclePathAsync(root, dirname(path))
  const before = await lstat(path, { bigint: true })
  const kind = kindOf(before)
  if (kind !== entry.kind || Number(before.mode) !== entry.mode || kind !== 'directory' && Number(before.size) !== entry.bytes || kind === 'file' && before.nlink > 1n) throw new Error('Frozen content was replaced before mutation')
  const current = kind === 'link' ? hash(await readlink(path)) : kind === 'file' ? hash(await readFile(path)) : ''
  if (current !== entry.digest) throw new Error('Frozen content changed before mutation')
  const after = await lstat(path, { bigint: true })
  if (statSignature(after) !== statSignature(before)) throw new Error('Frozen content changed before mutation')
  return { path, entry, signature: statSignature(before), coarse: coarseTimes(before) }
}

/**
 * Right before a proven entry is removed, synchronously: it is still the entry {@link proveFrozenContentEntryAsync} read.
 * Its `lstat` must be unchanged, so any write since (which moves its change time) refuses it; where the times are too
 * coarse to show that, its bytes are read and compared again. The entry is under the Mousse home.
 */
export function assertFrozenEntryUnchanged(proof: FrozenEntryProof): void {
  const stat = lstatSync(proof.path, { bigint: true })
  if (statSignature(stat) !== proof.signature) throw new Error('Frozen content changed before mutation')
  if (!proof.coarse || proof.entry.kind === 'directory') return
  const current = proof.entry.kind === 'link' ? hash(readlinkSync(proof.path)) : hash(readFileSync(proof.path))
  if (current !== proof.entry.digest) throw new Error('Frozen content changed before mutation')
}

/**
 * Every entry of a folder as `lstat` describes it (identity, size, mode, links and both times), without its bytes: compared
 * again synchronously right before the folder is deleted, it shows whether anything in it changed since. `coarse` is set
 * when some entry's times cannot show a write (see {@link coarseTimes}).
 */
export interface FolderSignature { text: string; coarse: boolean }

export async function folderSignatureAsync(root: string, skipRootGit = false): Promise<FolderSignature> {
  const rows: string[] = []
  let coarse = false
  const visit = async (path: string, stat: BigIntStats, rel: string, depth: number): Promise<void> => {
    if (depth > 64 || rows.length > 100_000) throw new Error('Owned content exceeds bounded inventory limits')
    rows.push(`${rel}\0${statSignature(stat)}`)
    coarse ||= coarseTimes(stat)
    if (!stat.isDirectory()) return
    const names = (await readdir(path)).sort().filter((name) => !(skipRootGit && !rel && name === '.git'))
    for (let start = 0; start < names.length; start += STAT_BATCH) {
      const batch = names.slice(start, start + STAT_BATCH)
      const stats = await Promise.all(batch.map((name) => lstat(join(path, name), { bigint: true })))
      for (const [index, name] of batch.entries()) await visit(join(path, name), stats[index]!, rel ? `${rel}/${name}` : name, depth + 1)
    }
  }
  await visit(root, await lstat(root, { bigint: true }), '', 0)
  return { text: rows.join('\n'), coarse }
}

/** {@link folderSignatureAsync}, read at once: for the synchronous check right before a delete. The folder is under the Mousse home. */
export function folderSignatureSync(root: string, skipRootGit = false): FolderSignature {
  const rows: string[] = []
  let coarse = false
  const visit = (path: string, stat: BigIntStats, rel: string, depth: number): void => {
    if (depth > 64 || rows.length > 100_000) throw new Error('Owned content exceeds bounded inventory limits')
    rows.push(`${rel}\0${statSignature(stat)}`)
    coarse ||= coarseTimes(stat)
    if (!stat.isDirectory()) return
    for (const name of readdirSync(path).sort()) {
      if (skipRootGit && !rel && name === '.git') continue
      visit(join(path, name), lstatSync(join(path, name), { bigint: true }), rel ? `${rel}/${name}` : name, depth + 1)
    }
  }
  visit(root, lstatSync(root, { bigint: true }), '', 0)
  return { text: rows.join('\n'), coarse }
}

/**
 * The bytes of every file and link of a folder, read at once: only for {@link FolderSignature}s whose times are too coarse
 * to show a write, right before the folder is deleted. The same entries as {@link walkOwnedContentAsync}.
 */
function folderContentSync(root: string, skipRootGit = false): ContentEntry[] {
  const entries: ContentEntry[] = []
  const visit = (path: string, rel: string): void => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) { entries.push({ path: rel, kind: 'link', digest: hash(readlinkSync(path)), bytes: stat.size, mode: stat.mode }); return }
    if (stat.isDirectory()) {
      entries.push({ path: rel, kind: 'directory', digest: '', bytes: 0, mode: stat.mode })
      for (const name of readdirSync(path).sort()) if (!(skipRootGit && !rel && name === '.git')) visit(join(path, name), rel ? `${rel}/${name}` : name)
      return
    }
    entries.push({ path: rel, kind: 'file', digest: hash(readFileSync(path)), bytes: stat.size, mode: stat.mode })
  }
  visit(root, '')
  return entries
}

/**
 * Right before a folder is deleted, synchronously and with nothing awaited before the delete starts: nothing in it changed
 * since `signature` was read. With coarse times its bytes are compared with `content` too. Throws {@link FolderChanged}.
 */
export function assertFolderUnchanged(root: string, signature: FolderSignature, content: readonly ContentEntry[], skipRootGit = false): void {
  let now: FolderSignature
  try { now = folderSignatureSync(root, skipRootGit) } catch { throw new FolderChanged() }
  if (now.text !== signature.text) throw new FolderChanged()
  if ((signature.coarse || now.coarse) && JSON.stringify(folderContentSync(root, skipRootGit)) !== JSON.stringify(content)) throw new FolderChanged()
}

/** A folder changed between the check that allowed its deletion and the moment the deletion would start. Nothing was deleted. */
export class FolderChanged extends Error {
  constructor() { super('Files in it changed right before it would have been deleted') }
}

/**
 * A bounded walk that never follows links, crosses devices or enters Git administration. Reads without blocking the
 * daemon; the entries of a folder are looked at in batches.
 */
export async function walkOwnedContentAsync(root: string, skipRootGit = false): Promise<ContentEntry[]> {
  await assertLifecyclePathAsync(dirname(root), root)
  const rootStat = await lstat(root)
  const entries: ContentEntry[] = []
  let bytes = 0
  const walk = async (path: string, stat: Stats, depth: number): Promise<void> => {
    if (depth > 64 || entries.length >= 100_000) throw new Error('Owned content exceeds bounded inventory limits')
    if (stat.dev !== rootStat.dev) throw new Error('Owned content crosses a filesystem boundary')
    const rel = relative(root, path).split('\\').join('/')
    if (stat.isSymbolicLink()) { entries.push({ path: rel, kind: 'link', digest: hash(await readlink(path)), bytes: stat.size, mode: stat.mode }); return }
    if (stat.isDirectory()) {
      entries.push({ path: rel, kind: 'directory', digest: '', bytes: 0, mode: stat.mode })
      const names = (await readdir(path)).sort()
      const stats = await lstatAll(names.map((name) => join(path, name)))
      for (const [index, name] of names.entries()) {
        if (skipRootGit && !rel && name === '.git') continue
        if (skipRootGit && name === '.git') throw new Error('Nested repository requires explicit retention')
        await walk(join(path, name), statOrThrow(stats[index]!), depth + 1)
      }
      return
    }
    if (!stat.isFile() || stat.nlink > 1) throw new Error('Special or multiply linked content requires explicit retention')
    bytes += stat.size
    if (stat.size > 64 * 1024 * 1024 || bytes > 512 * 1024 * 1024) throw new Error('Owned content exceeds bounded byte limits')
    entries.push({ path: rel, kind: 'file', digest: hash(await readFile(path)), bytes: stat.size, mode: stat.mode })
  }
  await walk(root, rootStat, 0)
  return entries
}

/** The latest change time of anything in a folder, links not followed; `Infinity` when it is too large to tell. Never blocks. */
async function newestChange(root: string): Promise<number> {
  let newest = 0, seen = 0
  const walk = async (path: string, stat: Stats, depth: number): Promise<boolean> => {
    if (++seen > 100_000 || depth > 64) return false
    newest = Math.max(newest, stat.mtimeMs, stat.ctimeMs)
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const names = await readdir(path)
      const stats = await lstatAll(names.map((name) => join(path, name)))
      for (const [index, name] of names.entries()) {
        if (!await walk(join(path, name), statOrThrow(stats[index]!), depth + 1)) return false
      }
    }
    return true
  }
  return await walk(root, await lstat(root), 0) ? newest : Infinity
}

/** Whether Git exits 0 for a question it answers by its status alone (`merge-base --is-ancestor`, `cat-file -e`). */
async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  const argv = await withoutRepoProgramsAsync(cwd, args)
  return (await runGitProcess(argv, { cwd, env: repoProgramEnv() })).status === 0
}
export interface RetirementInput { taskId: string; worktreePath: string; branch: string; sourcePath: string; repositoryId?: string; baseSha?: string; resultSha?: string }
export interface RetirementOwnership { repositoryLease: RepositoryLeaseHandle; taskLease?: ThreadLeaseHandle; cleanupTaskId?: string; cleanupToken?: string; cleanupGeneration?: number }

/**
 * Call under task execution ownership followed by repository mutation ownership. Every method runs without blocking the
 * daemon. The task's lifecycle gate is held only for short synchronous steps (the ownership checks and the source and
 * manifest records), never across an await: the gate also admits every write to the thread. The leases the caller holds
 * keep the checkout to this work in between, and ownership is checked again, under the gate, right before each move.
 */
export class WorktreeRetirementService {
  constructor(readonly store: ResourceLifecycleStore, private readonly ownership?: RetirementOwnership) {}
  pathFor(taskId: string, worktreePath: string): string { return join(this.store.root, 'workspaces', taskId, `${hash(resolve(worktreePath))}.json`) }
  /** The one place a retired worktree waits in Mousse's trash; next to the profile, so the move stays on one disk. */
  trashPathFor(manifest: Pick<WorktreeReconstructionManifest, 'taskId' | 'worktreePath'>): string {
    return join(this.store.profileHome, 'trash', 'worktrees', hash(manifest.taskId).slice(0, 16), hash(resolve(manifest.worktreePath)).slice(0, 32))
  }
  async inspectForDiscard(input: RetirementInput) {
    const identity = await this.inspectIdentity(input.worktreePath, input.branch, input.repositoryId)
    this.verifySource({ ...input, repositoryId: identity.repositoryId })
    const resultSha = await lifecycleReadAsync(input.worktreePath, ['rev-parse', 'HEAD'])
    const indexDigest = hash(await lifecycleReadAsync(input.worktreePath, ['ls-files', '--stage', '-v', '-z']))
    return { ...identity, resultSha, indexDigest, content: await walkOwnedContentAsync(input.worktreePath, true) }
  }
  /**
   * The branch an owner's record names for the checkout at `worktreePath`. The checkout may be on another branch
   * (the agent is free to switch), so the branch that proves ownership is read from the record, not from HEAD.
   */
  ownedBranch(sourcePath: string, worktreePath: string): string | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(sourcePath, 'utf8'))
      const record = (row: unknown): row is { worktreePath: string; branch: string } => Boolean(row) && typeof row === 'object' && (row as { worktreePath?: unknown }).worktreePath === worktreePath && typeof (row as { branch?: unknown }).branch === 'string'
      const episodes = value && typeof value === 'object' && Array.isArray((value as { episodes?: unknown }).episodes) ? (value as { episodes: Array<{ binding?: unknown }> }).episodes.map((episode) => episode.binding) : []
      return [...(Array.isArray(value) ? value : [value]), ...episodes].find(record)?.branch
    } catch { return undefined }
  }
  load(path: string): WorktreeReconstructionManifest {
    assertLifecyclePath(this.store.root, path)
    const value = JSON.parse(readFileSync(path, 'utf8')) as WorktreeReconstructionManifest
    if (value.schemaVersion !== 1 || value.profileId !== this.store.profileId || !same(path, this.pathFor(value.taskId, value.worktreePath)) || !isMousseBranchName(value.branch)) throw new Error('Invalid workspace reconstruction authority')
    const prefix = `refs/mousse/lifecycle/${this.store.profileId}/${value.taskId}/${hash(value.worktreePath).slice(0, 32)}`
    if (value.snapshotSha !== undefined && (value.snapshotRef !== `${prefix}/snapshot` || ![value.snapshotSha, value.snapshotTree].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40,64}$/.test(sha)))) throw new Error('Malformed workspace reconstruction manifest')
    if (value.baseRef !== `${prefix}/base` || value.resultRef !== `${prefix}/result` || ![value.worktreePath, value.commonDir, value.gitDirectory, value.sourcePath].every(isAbsolute) || ![value.baseSha, value.resultSha, value.treeSha].every((sha) => /^[a-f0-9]{40,64}$/.test(sha)) || !/^[a-f0-9]{32}$/.test(value.repositoryId) || !Array.isArray(value.content) || !Array.isArray(value.auxiliary) || !['prepared', 'trashed', 'retired', 'materialized'].includes(value.state)) throw new Error('Malformed workspace reconstruction manifest')
    if (value.trashPath !== undefined && !same(value.trashPath, this.trashPathFor(value)) || value.state === 'trashed' && (!value.trashPath || typeof value.trashedAt !== 'string')) throw new Error('Malformed workspace trash location')
    if (value.keptRefs !== undefined && (!Array.isArray(value.keptRefs) || !value.keptRefs.every((ref) => typeof ref === 'string' && ref.startsWith(`${prefix}/kept/`)))) throw new Error('Malformed workspace kept pins')
    if (value.deletedBranches !== undefined && (!Array.isArray(value.deletedBranches) || !value.deletedBranches.every((entry) => isMousseBranchName(entry?.name) && /^[a-f0-9]{40,64}$/.test(entry?.sha)))) throw new Error('Malformed workspace branch record')
    for (const entry of value.content) if (isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..') || !['file', 'directory', 'link'].includes(entry.kind) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Manifest content path is invalid')
    for (const entry of value.auxiliary) if (!MOUSSE_CONTROL_FILE_PATHS.includes(entry.path) || typeof entry.content !== 'string' || entry.content.length > 2 * 1024 * 1024) throw new Error('Manifest auxiliary payload is invalid')
    if (!/^[a-f0-9]{64}$/.test(value.checkoutFingerprint) || !value.rootIdentity || !Object.values(value.rootIdentity).every(Number.isFinite) || value.sparse && (typeof value.sparse.patterns !== 'string' || typeof value.sparse.cone !== 'boolean')) throw new Error('Manifest reconstruction state is invalid')
    return value
  }
  async prepare(input: RetirementInput): Promise<WorktreeReconstructionManifest> {
    const identity = await this.inspectIdentity(input.worktreePath, input.branch, input.repositoryId)
    const lease = await this.readRepositoryLease()
    const source = this.store.withGate(input.taskId, () => {
      const source = this.verifySource({ ...input, repositoryId: identity.repositoryId })
      this.assertOwnership(input.taskId, identity.commonDir, identity.repositoryId, lease)
      this.store.enableCleanupWriter()
      return source
    })
    const resultSha = await lifecycleReadAsync(input.worktreePath, ['rev-parse', 'HEAD'])
    // Uncommitted files are kept as a snapshot: a worktree whose status is clean has nothing to snapshot.
    const snapshot = await lifecycleReadAsync(input.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']) ? await takeSnapshotAsync(input.worktreePath, { reason: 'retirement', threadId: input.taskId }) : undefined
    const treeSha = await lifecycleReadAsync(input.worktreePath, ['rev-parse', 'HEAD^{tree}'])
    const dirty = Boolean(snapshot && snapshot.tree !== treeSha)
    // A result the owner recorded is a commit (the HEAD) or a snapshot of the files; either way the files must still be those.
    if ((input.resultSha && input.resultSha !== resultSha) || (source.resultSha && source.resultSha !== resultSha && !await sameTreeAsync(input.worktreePath, source.resultSha, snapshot?.sha ?? resultSha))) throw new Error('Workspace result changed before retirement')
    if (input.baseSha && source.baseSha && input.baseSha !== source.baseSha) throw new Error('Workspace base changed before retirement')
    const baseSha = input.baseSha ?? source.baseSha ?? resultSha
    await lifecycleReadAsync(input.worktreePath, ['cat-file', '-e', `${baseSha}^{commit}`])
    const contents = await this.inspectContent(input.worktreePath, snapshot?.tree)
    const key = hash(input.worktreePath).slice(0, 32)
    const prefix = `refs/mousse/lifecycle/${this.store.profileId}/${input.taskId}/${key}`
    const headBranch = await lifecycleReadAsync(input.worktreePath, ['branch', '--show-current'])
    const checkoutFingerprint = await this.checkoutFingerprint(input.worktreePath)
    const manifest: WorktreeReconstructionManifest = { schemaVersion: 1, profileId: this.store.profileId, ...input, ...identity, baseSha, resultSha, treeSha, checkoutFingerprint, baseRef: `${prefix}/base`, resultRef: `${prefix}/result`, ...(dirty ? { snapshotSha: snapshot!.sha, snapshotTree: snapshot!.tree, snapshotRef: `${prefix}/snapshot` } : {}), ...(headBranch ? { headBranch } : {}), ...contents, state: 'prepared' }
    const manifestPath = this.pathFor(input.taskId, input.worktreePath)
    // Intent precedes pins. Recovery can distinguish an incomplete preparation from retirement.
    const leaseNow = await this.readRepositoryLease()
    this.store.withGate(input.taskId, () => {
      this.assertOwnership(input.taskId, identity.commonDir, identity.repositoryId, leaseNow)
      if (!existsSync(manifestPath) || JSON.stringify(JSON.parse(readFileSync(manifestPath, 'utf8'))) !== JSON.stringify(manifest)) atomicWriteJsonSync(manifestPath, manifest)
    })
    for (const [ref, sha] of [[manifest.baseRef, baseSha], [manifest.resultRef, resultSha], ...(manifest.snapshotRef ? [[manifest.snapshotRef, manifest.snapshotSha!]] : [])]) {
      const old = await readDirectLifecycleRefAsync(input.worktreePath, ref) ?? '0'.repeat(sha.length)
      await lifecycleGitAsync(input.worktreePath, ['update-ref', '--no-deref', ref, sha, old])
    }
    await this.verifyPins(manifest)
    return manifest
  }
  /**
   * Moves the worktree into Mousse's trash in one step; Git's registration follows it there. Nothing is deleted and
   * nothing has to be proven unchanged first: a write that lands after `prepare` moves with the folder. The folder is
   * deleted later by `expireTrash`, after a snapshot of it, or right away when `purging` (a permanent deletion the
   * person confirmed). Owned branches whose tips the pins keep are deleted once no worktree has them checked out.
   */
  async retire(manifestPath: string, options: {
    purging?: boolean
    /**
     * The caller's own checks, run synchronously right before the worktree moves (or, for a purge of one already in the
     * trash, right before Git deletes it), after the ownership and claims checks and with nothing awaited in between. It
     * refuses by throwing; nothing has moved then.
     */
    beforeMove?: () => void
  } = {}): Promise<WorktreeReconstructionManifest> {
    const manifest = this.load(manifestPath)
    await this.checkOwnership(manifest.taskId, manifest.commonDir, manifest.repositoryId)
    await this.verifyPins(manifest)
    const save = (): void => { if (!options.purging) atomicWriteJsonSync(manifestPath, manifest) }
    await this.settleTrashRegistration(manifest)
    if (!await exists(manifest.worktreePath)) {
      if (await this.registered(manifest)) throw new Error('Missing worktree remains registered; recovery is required')
      // Permanent deletion: what waits in the trash goes too. Ownership is checked again right before Git deletes it.
      if (options.purging && manifest.trashPath && await exists(manifest.trashPath)) {
        const lease = await this.readRepositoryLease()
        await this.removeTrashed(manifest, () => {
          this.store.withGate(manifest.taskId, () => this.assertOwnership(manifest.taskId, manifest.commonDir, manifest.repositoryId, lease))
          options.beforeMove?.()
        })
      }
      manifest.state = manifest.trashPath && await exists(manifest.trashPath) ? 'trashed' : 'retired'; save(); return manifest
    }
    this.store.withGate(manifest.taskId, () => this.verifySource(manifest, options.purging))
    const identity = await this.inspectIdentity(manifest.worktreePath, manifest.branch, manifest.repositoryId)
    if (JSON.stringify(identity.rootIdentity) !== JSON.stringify(manifest.rootIdentity) || identity.gitDirectory !== manifest.gitDirectory || identity.commonDir !== manifest.commonDir) throw new Error('Workspace directory was replaced')
    const excludedNow = (): Set<string> => {
      const excluded = new Set([this.ownership?.cleanupTaskId ?? manifest.taskId])
      if (this.ownership?.cleanupTaskId) {
        const records = this.store.list()
        for (let added = true; added;) { added = false; for (const record of records) if (record.parentTaskId && excluded.has(record.parentTaskId) && record.state !== 'trashed' && !excluded.has(record.taskId)) { excluded.add(record.taskId); added = true } }
      }
      return excluded
    }
    const overlaps = (left: string, right: string) => { const rel = relative(resolve(left), resolve(right)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) }
    const shares = (claims: Awaited<ReturnType<typeof getExternalResourceClaims>>, excluded: Set<string>): boolean => claims.some((resource) => !(resource.peerProfileId === this.store.profileId && excluded.has(resource.ownerTaskId)) && isAbsolute(resource.identity) && (overlaps(resource.identity, manifest.worktreePath) || overlaps(manifest.worktreePath, resource.identity)))
    const blocked = 'Another task or profile retains this checkout; retirement is blocked'
    const excluded = excludedNow()
    if (shares(await getExternalResourceClaims(this.store, excluded), excluded)) throw new Error(blocked)
    await this.verifyPins(manifest)
    const trashPath = this.trashPathFor(manifest)
    if (await exists(trashPath)) throw new Error(`An earlier copy of this worktree is still in the trash at ${trashPath}; it is kept`)
    await mkdir(dirname(trashPath), { recursive: true })
    // Right before the move, with nothing awaited between these checks and its start: the checkouts other records name
    // are read again now, then the leases, the reservation, the source and every claim are checked from the records, and
    // last the caller's own checks run. A claim on a checkout not read here fails closed.
    const facts = new OwnershipFacts()
    // Only the facts are wanted: a refusal is made again, from the records, by the check below.
    await getExternalResourceClaims(this.store, excludedNow(), facts).catch(() => undefined)
    const lease = await this.readRepositoryLease()
    this.store.withGate(manifest.taskId, () => {
      this.assertOwnership(manifest.taskId, manifest.commonDir, manifest.repositoryId, lease)
      this.verifySource(manifest, options.purging)
      const current = excludedNow()
      if (shares(getExternalResourceClaimsFromFacts(this.store, current, facts), current)) throw new Error(blocked)
    })
    options.beforeMove?.()
    // The destination is fixed by the manifest, so a crash after the move finds the folder there.
    manifest.trashPath = trashPath; save()
    try { await renameFolderAsync(manifest.worktreePath, trashPath) }
    catch (error) { throw new Error(`The worktree could not be moved to the trash; files in it may be in use (${(error as Error).message.split(/\r?\n/)[0]})`) }
    await this.settleTrashRegistration(manifest)
    if (await this.registered(manifest)) throw new Error('Git still registers the worktree at its old path')
    if (options.purging) { await this.removeTrashed(manifest); manifest.state = 'retired'; return manifest }
    manifest.state = 'trashed'; manifest.trashedAt = new Date().toISOString(); save()
    await this.releaseBranches(manifest); save()
    return manifest
  }
  /**
   * Deletes a worktree that has waited in the trash with nothing in it changing for `WORKTREE_TRASH_QUIET_MS`: a snapshot
   * of its files is pinned first (it replaces the pins `prepare` made), then Git removes it. What a snapshot cannot hold
   * (ignored or untracked files Git does not see, staged changes, an operation in progress) keeps it in the trash, and
   * the reason is returned. Needs the repository lease; the thread may be busy, since its own worktree is elsewhere.
   * Order: `inUse` (Windows: open files), then the snapshot, then a second read of the folder; a change since the
   * snapshot is captured again and the delete waits for the next run. Undefined means there was nothing to do.
   */
  async expireTrash(manifestPath: string, options: { now?: number; inUse?: (path: string) => string | undefined; /** Test seam: runs between the snapshot and the check before the delete. */ afterCapture?: (path: string) => void } = {}): Promise<{ removed: true } | { kept: string; waiting?: true } | undefined> {
    const manifest = this.load(manifestPath)
    const record = { text: JSON.stringify(manifest) }
    try { return await this.expireLoaded(manifestPath, manifest, record, options) }
    catch (error) {
      if (error instanceof TrashRecordChanged) return { kept: error.message, waiting: true }
      throw error
    }
  }
  private async expireLoaded(manifestPath: string, manifest: WorktreeReconstructionManifest, record: { text: string }, options: { now?: number; inUse?: (path: string) => string | undefined; afterCapture?: (path: string) => void }): Promise<{ removed: true } | { kept: string; waiting?: true } | undefined> {
    this.assertRepositoryLease(manifest.commonDir, manifest.repositoryId, await this.readRepositoryLease())
    // A move a crash interrupted before it was recorded: the folder is in the trash and starts waiting now.
    if (manifest.state === 'prepared' && manifest.trashPath && await exists(manifest.trashPath) && !await exists(manifest.worktreePath)) {
      await this.settleTrashRegistration(manifest)
      manifest.state = 'trashed'; manifest.trashedAt = new Date(options.now ?? Date.now()).toISOString(); this.saveTrashed(manifestPath, manifest, record)
    }
    if (manifest.state !== 'trashed' || !manifest.trashPath) return undefined
    const trashPath = manifest.trashPath
    if (!await exists(trashPath)) {
      // Deleted by someone else: the pins from `prepare` are what is left.
      manifest.state = 'retired'; delete manifest.trashPath; delete manifest.trashedAt; this.saveTrashed(manifestPath, manifest, record)
      return undefined
    }
    await this.settleTrashRegistration(manifest)
    const now = options.now ?? Date.now()
    if (now - Date.parse(manifest.trashedAt!) < WORKTREE_TRASH_QUIET_MS) return { kept: 'Waiting in the trash', waiting: true }
    if (now - await newestChange(trashPath) < WORKTREE_TRASH_QUIET_MS) return { kept: 'Files in it changed within the last hour', waiting: true }
    await this.verifyPins(manifest)
    // In use (Windows: open files) is asked before anything is captured, so whatever it lets through is in the snapshot.
    const busy = options.inUse?.(trashPath)
    if (busy) return { kept: busy }
    const first = await this.captureTrashed(manifestPath, manifest, record)
    if ('kept' in first) return first
    options.afterCapture?.(trashPath)
    const changed = async (): Promise<{ kept: string; waiting: true }> => {
      const retaken = await this.captureTrashed(manifestPath, manifest, record)
      return { kept: `Files in it changed while it was being deleted${'kept' in retaken ? `; ${retaken.kept}` : '; they are kept as a snapshot'}. It is looked at again on the next run.`, waiting: true }
    }
    // Right before the delete, the folder is read again and compared with what the snapshot holds: a change since the
    // snapshot is captured and the delete waits. What `lstat` says of every entry is read first, so a write after this
    // read is still seen by the check right before Git starts.
    let signature: FolderSignature
    try { signature = await folderSignatureAsync(trashPath, true) } catch { return await changed() }
    if (await this.trashedState(manifest) !== first.state) return await changed()
    // Right before Git deletes it, with nothing awaited in between: the repository lease is still held, the record is
    // still the one this pass read, and nothing in the folder changed since it was compared with the snapshot.
    const lease = await this.readRepositoryLease()
    try {
      await this.removeTrashed(manifest, () => this.store.withGate(manifest.taskId, () => {
        this.assertRepositoryLease(manifest.commonDir, manifest.repositoryId, lease)
        this.assertTrashRecord(manifestPath, record)
        assertFolderUnchanged(trashPath, signature, first.content, true)
      }))
    } catch (error) {
      if (error instanceof FolderChanged) return await changed()
      throw error
    }
    manifest.state = 'retired'; delete manifest.trashPath; delete manifest.trashedAt
    this.saveTrashed(manifestPath, manifest, record)
    await this.releaseBranches(manifest); this.saveTrashed(manifestPath, manifest, record)
    return { removed: true }
  }
  /**
   * Takes a snapshot of the folder in the trash and pins it in place of the earlier pins (`result` at its HEAD,
   * `snapshot` when it has uncommitted files), recording both in the manifest. What a snapshot cannot hold keeps it.
   */
  private async captureTrashed(manifestPath: string, manifest: WorktreeReconstructionManifest, record: { text: string }): Promise<{ state: string; content: ContentEntry[] } | { kept: string }> {
    const trashPath = manifest.trashPath!
    const head = await lifecycleReadAsync(trashPath, ['rev-parse', 'HEAD'])
    const treeSha = await lifecycleReadAsync(trashPath, ['rev-parse', 'HEAD^{tree}'])
    const snapshot = await lifecycleReadAsync(trashPath, ['status', '--porcelain=v1', '--untracked-files=all']) ? await takeSnapshotAsync(trashPath, { reason: 'trash expiry', threadId: manifest.taskId }) : undefined
    const dirty = Boolean(snapshot && snapshot.tree !== treeSha)
    let contents: Awaited<ReturnType<WorktreeRetirementService['inspectContent']>>
    try { contents = await this.inspectContent(trashPath, dirty ? snapshot!.tree : undefined) }
    catch (error) { return { kept: `Kept in the trash at ${trashPath}: ${(error as Error).message}` } }
    const prefix = manifest.resultRef.slice(0, -'/result'.length)
    // A pin is never replaced by one that does not contain it: the earlier commit or snapshot stays under a ref of its own.
    const keepPin = async (old: string | undefined, next: string): Promise<void> => {
      if (!old || old === next || await gitSucceeds(trashPath, ['merge-base', '--is-ancestor', old, next])) return
      const ref = `${prefix}/kept/${old}`
      if (await readDirectLifecycleRefAsync(trashPath, ref) !== old) await lifecycleGitAsync(trashPath, ['update-ref', '--no-deref', ref, old, '0'.repeat(old.length)])
      manifest.keptRefs = [...new Set([...(manifest.keptRefs ?? []), ref])]
    }
    const previousSnapshot = await readDirectLifecycleRefAsync(trashPath, `${prefix}/snapshot`)
    await keepPin(manifest.resultSha, head)
    if (dirty) await keepPin(previousSnapshot, snapshot!.sha)
    this.saveTrashed(manifestPath, manifest, record)
    await lifecycleGitAsync(trashPath, ['update-ref', '--no-deref', manifest.resultRef, head, manifest.resultSha])
    if (dirty) await lifecycleGitAsync(trashPath, ['update-ref', '--no-deref', `${prefix}/snapshot`, snapshot!.sha, previousSnapshot ?? '0'.repeat(snapshot!.sha.length)])
    const headBranch = await lifecycleReadAsync(trashPath, ['branch', '--show-current'])
    // A clean folder drops the snapshot fields; an earlier snapshot ref stays where it is, as every pin does.
    delete manifest.snapshotSha; delete manifest.snapshotTree; delete manifest.snapshotRef; delete manifest.headBranch; delete manifest.sparse
    Object.assign(manifest, { resultSha: head, treeSha, ...(dirty ? { snapshotSha: snapshot!.sha, snapshotTree: snapshot!.tree, snapshotRef: `${prefix}/snapshot` } : {}), ...(headBranch ? { headBranch } : {}), ...contents })
    this.saveTrashed(manifestPath, manifest, record)
    await this.verifyPins(manifest)
    // What the snapshot holds, not a read of the folder now: `inspectContent` read every entry after the snapshot and proved
    // each against it, so a write made since then (during the waits above) differs from this and is never deleted unseen.
    return { state: trashedStateOf(head, contents.content), content: contents.content }
  }
  /**
   * The record of a worktree in the trash is written only while it is still the one this pass read or last wrote, checked
   * under the task's gate in the same synchronous step: a permanent deletion may have removed it meanwhile, and it is
   * never written back then.
   */
  private saveTrashed(manifestPath: string, manifest: WorktreeReconstructionManifest, record: { text: string }): void {
    this.store.withGate(manifest.taskId, () => {
      this.assertTrashRecord(manifestPath, record)
      atomicWriteJsonSync(manifestPath, manifest)
      record.text = JSON.stringify(manifest)
    })
  }
  private assertTrashRecord(manifestPath: string, record: { text: string }): void {
    let current: string | undefined
    try { current = JSON.stringify(JSON.parse(readFileSync(manifestPath, 'utf8'))) } catch { current = undefined }
    if (current !== record.text) throw new TrashRecordChanged()
  }
  /** What the folder in the trash holds now, to compare with what was captured: HEAD and every entry's bytes. */
  private async trashedState(manifest: WorktreeReconstructionManifest): Promise<string> {
    const trashPath = manifest.trashPath!
    try {
      return trashedStateOf(await lifecycleReadAsync(trashPath, ['rev-parse', 'HEAD']), await walkOwnedContentAsync(trashPath, true))
    } catch (error) { return `unreadable: ${(error as Error).message}` }
  }
  /** Points Git's registration at the trash after a move that a crash interrupted. Idempotent. */
  private async settleTrashRegistration(manifest: WorktreeReconstructionManifest): Promise<void> {
    const trashPath = manifest.trashPath
    if (!trashPath || !await exists(join(trashPath, '.git')) || await this.registeredAt(manifest.commonDir, trashPath)) return
    await lifecycleGitAsync(manifest.commonDir, ['worktree', 'repair', trashPath])
  }
  /** Deletes the folder in the trash through Git, so its registration goes with it. */
  private async removeTrashed(manifest: WorktreeReconstructionManifest, beforeStart?: () => void): Promise<void> {
    const trashPath = manifest.trashPath!
    await assertLifecyclePathAsync(join(this.store.profileHome, 'trash'), trashPath)
    // Whether the checks before Git passed: a refusal there deletes nothing, by Git or otherwise.
    let cleared = false
    try { await lifecycleGitAsync(manifest.commonDir, ['worktree', 'remove', '--force', trashPath], undefined, undefined, undefined, () => { beforeStart?.(); cleared = true }) }
    catch (error) {
      if (!cleared) throw error
      // Git deleted `.git` and unregistered it, then stopped at a file in use: what is left is no checkout any more.
      if (!await exists(trashPath) || await exists(join(trashPath, '.git')) || await this.registeredAt(manifest.commonDir, trashPath)) throw error
      await rm(trashPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
    if (await exists(trashPath) || await this.registeredAt(manifest.commonDir, trashPath)) throw new Error('Git did not remove the worktree from the trash')
  }
  /**
   * Deletes the worktree's owned `mousse/*` branches whose tips the pins keep (a tip that is HEAD or the commit a pinned
   * snapshot was taken on, or an ancestor of one), unless a worktree has the branch checked out. Those are the thread's
   * own branch, and the branch HEAD was on when that is another of Mousse's id-named ones; a branch the agent made itself,
   * whatever its name, is never touched. Each deletion is recorded so a restore brings the branch back.
   */
  private async releaseBranches(manifest: WorktreeReconstructionManifest): Promise<void> {
    const checkedOut = new Set((await lifecycleReadAsync(manifest.commonDir, ['worktree', 'list', '--porcelain'])).split(/\r?\n/).filter((line) => line.startsWith('branch refs/heads/')).map((line) => line.slice('branch refs/heads/'.length)))
    const pins = [manifest.resultSha, manifest.snapshotSha].filter((sha): sha is string => Boolean(sha))
    const owned = [manifest.branch, ...(isIdNamedMousseBranch(manifest.headBranch) ? [manifest.headBranch] : [])]
    for (const name of new Set(owned)) {
      if (!name || !isMousseBranchName(name) || checkedOut.has(name)) continue
      const tip = await this.tip(manifest, name)
      if (!tip) continue
      let kept = false
      for (const pin of pins) if (pin === tip || await gitSucceeds(manifest.commonDir, ['merge-base', '--is-ancestor', tip, pin])) { kept = true; break }
      if (!kept) continue
      await lifecycleGitAsync(manifest.commonDir, ['update-ref', '--no-deref', '-d', `refs/heads/${name}`, tip])
      manifest.deletedBranches = [...(manifest.deletedBranches ?? []).filter((entry) => entry.name !== name), { name, sha: tip }]
    }
  }
  /** Brings back the branches `releaseBranches` deleted, at their tips, where nothing has taken the name since. */
  private async restoreBranches(manifest: WorktreeReconstructionManifest): Promise<void> {
    const missing: Array<{ name: string; sha: string }> = []
    for (const entry of manifest.deletedBranches ?? []) {
      if (await this.branchTaken(manifest, entry.name)) continue
      // A commit that is no longer in the repository cannot be a branch again; it is reported, never a reason to fail.
      if (!await gitSucceeds(manifest.commonDir, ['cat-file', '-e', `${entry.sha}^{commit}`])) { missing.push(entry); continue }
      await lifecycleGitAsync(manifest.commonDir, ['update-ref', '--no-deref', `refs/heads/${entry.name}`, entry.sha, '0'.repeat(entry.sha.length)])
    }
    delete manifest.deletedBranches
    if (missing.length) manifest.branchesNotRestored = missing
  }
  /**
   * `untrusted` is for a checkout of someone else's commits: `prepare` runs on the new worktree before anything is checked
   * out into it (it puts the safety configuration in place) and `env` goes to the checkout.
   */
  async reconstruct(manifestPath: string, untrusted?: { prepare(worktreePath: string): void | Promise<void>; env: NodeJS.ProcessEnv }): Promise<WorktreeReconstructionManifest> {
    const manifest = this.load(manifestPath)
    await this.checkOwnership(manifest.taskId, manifest.commonDir, manifest.repositoryId)
    this.store.withGate(manifest.taskId, () => this.verifySource(manifest))
    await this.verifyPins(manifest)
    await this.settleTrashRegistration(manifest)
    if (!await exists(manifest.worktreePath) && manifest.trashPath && await exists(manifest.trashPath)) {
      await assertLifecyclePathAsync(dirname(manifest.worktreePath), manifest.worktreePath)
      if (await this.registered(manifest)) throw new Error('Absent worktree has a stale registration')
      // Still in the trash, maybe still in use: the folder itself comes back, as it is now. Nothing is rebuilt beside it.
      await mkdir(dirname(manifest.worktreePath), { recursive: true })
      // Ownership is checked again right before the move.
      await this.checkOwnership(manifest.taskId, manifest.commonDir, manifest.repositoryId)
      await renameFolderAsync(manifest.trashPath, manifest.worktreePath)
      await lifecycleGitAsync(manifest.commonDir, ['worktree', 'repair', manifest.worktreePath])
      await this.restoreBranches(manifest)
      const identity = await this.inspectIdentity(manifest.worktreePath, manifest.branch, manifest.repositoryId)
      delete manifest.trashPath; delete manifest.trashedAt
      Object.assign(manifest, identity, { state: 'materialized' }); atomicWriteJsonSync(manifestPath, manifest)
      return manifest
    }
    if (!await exists(manifest.worktreePath)) {
      await assertLifecyclePathAsync(dirname(manifest.worktreePath), manifest.worktreePath)
      if (await this.registered(manifest)) throw new Error('Absent worktree has a stale registration')
      await mkdir(dirname(manifest.worktreePath), { recursive: true })
      // Ownership is checked again right before the worktree is made.
      await this.checkOwnership(manifest.taskId, manifest.commonDir, manifest.repositoryId)
      await this.restoreBranches(manifest)
      // On the branch it was on when the tip is still the HEAD it had; otherwise at that HEAD, detached. The branches stay the agent's to move.
      let onBranch: string | undefined
      for (const name of [manifest.headBranch, manifest.branch]) if (name && await this.tip(manifest, name) === manifest.resultSha) { onBranch = name; break }
      if (!onBranch || !await this.tryAdd(manifest, [manifest.worktreePath, onBranch])) await lifecycleGitAsync(manifest.commonDir, ['worktree', 'add', '--no-checkout', '--detach', manifest.worktreePath, manifest.resultSha])
      await untrusted?.prepare(manifest.worktreePath)
      if (await this.checkoutFingerprint(manifest.worktreePath) !== manifest.checkoutFingerprint) throw new Error('Checkout conversion policy changed; reconstruction requires recovery')
      if (manifest.sparse) await lifecycleGitAsync(manifest.worktreePath, ['sparse-checkout', 'set', manifest.sparse.cone ? '--cone' : '--no-cone', '--stdin'], manifest.sparse.patterns)
      await lifecycleGitAsync(manifest.worktreePath, ['checkout', 'HEAD'], undefined, undefined, untrusted?.env)
      for (const auxiliary of manifest.auxiliary) {
        const target = join(manifest.worktreePath, auxiliary.path)
        await assertLifecyclePathAsync(manifest.worktreePath, target); await mkdir(dirname(target), { recursive: true })
        await writeFile(target, Buffer.from(auxiliary.content, 'base64'))
      }
      if (manifest.auxiliary.some((entry) => entry.path === '.mousse/materialized-inputs.exclude')) await lifecycleGitAsync(manifest.worktreePath, ['config', '--worktree', 'core.excludesFile', join(manifest.worktreePath, '.mousse', 'materialized-inputs.exclude')])
      // The uncommitted files come back as the snapshot held them, over the fresh checkout of the HEAD it was taken on.
      if (manifest.snapshotTree) await moveFilesAsync(manifest.worktreePath, manifest.treeSha, manifest.snapshotTree)
      for (const entry of manifest.content) {
        const target = join(manifest.worktreePath, entry.path)
        if (entry.kind === 'directory') { await assertLifecyclePathAsync(manifest.worktreePath, target); await mkdir(target, { recursive: true }) }
        if (entry.kind !== 'link') { await assertLifecyclePathAsync(manifest.worktreePath, target); await chmod(target, entry.mode & 0o777) }
      }
    }
    const identity = await this.inspectIdentity(manifest.worktreePath, manifest.branch, manifest.repositoryId)
    if (await lifecycleGitAsync(manifest.worktreePath, ['rev-parse', 'HEAD^{tree}']) !== manifest.treeSha || (manifest.snapshotTree && await worktreeTreeAsync(manifest.worktreePath) !== manifest.snapshotTree) || JSON.stringify((await this.inspectContent(manifest.worktreePath, manifest.snapshotTree)).content) !== JSON.stringify(manifest.content)) throw new Error('Reconstructed workspace does not match retained content')
    await this.verifyPins(manifest)
    delete manifest.trashPath; delete manifest.trashedAt
    Object.assign(manifest, identity, { state: 'materialized' }); atomicWriteJsonSync(manifestPath, manifest)
    return manifest
  }
  async verifyPins(manifest: WorktreeReconstructionManifest): Promise<void> {
    await assertLifecyclePathAsync(dirname(manifest.commonDir), manifest.commonDir)
    if (hash((await realpathLikeSync(manifest.commonDir)).toLowerCase()).slice(0, 32) !== manifest.repositoryId) throw new Error('Repository identity is unavailable or changed')
    for (const [ref, sha] of [[manifest.baseRef, manifest.baseSha], [manifest.resultRef, manifest.resultSha], ...(manifest.snapshotRef ? [[manifest.snapshotRef, manifest.snapshotSha!]] : [])]) if (await readDirectLifecycleRefAsync(manifest.commonDir, ref) !== sha) throw new Error('Reconstruction pin changed or is unavailable')
    if (await lifecycleGitAsync(manifest.commonDir, ['rev-parse', `${manifest.resultSha}^{tree}`]) !== manifest.treeSha) throw new Error('Retained result tree changed')
    if (manifest.snapshotSha && await lifecycleGitAsync(manifest.commonDir, ['rev-parse', `${manifest.snapshotSha}^{tree}`]) !== manifest.snapshotTree) throw new Error('Retained snapshot tree changed')
  }
  /**
   * The commit a branch points at, never following a symbolic ref: a branch that is a symbolic ref (or unreadable) is
   * not owned, so it is neither deleted nor used as a checkout target.
   */
  private async tip(manifest: WorktreeReconstructionManifest, branch: string): Promise<string | undefined> {
    try { return await readDirectLifecycleRefAsync(manifest.commonDir, `refs/heads/${branch}`) } catch { return undefined }
  }
  /** Whether a branch name is taken at all, as a branch or as a symbolic ref. */
  private async branchTaken(manifest: WorktreeReconstructionManifest, branch: string): Promise<boolean> {
    return await gitSucceeds(manifest.commonDir, ['show-ref', '--verify', '-q', `refs/heads/${branch}`])
      || await gitSucceeds(manifest.commonDir, ['symbolic-ref', '-q', `refs/heads/${branch}`])
  }
  /** Adds the worktree on a branch; false when Git refuses, as when another worktree has the branch checked out. */
  private async tryAdd(manifest: WorktreeReconstructionManifest, target: string[]): Promise<boolean> {
    try { await lifecycleGitAsync(manifest.commonDir, ['worktree', 'add', '--no-checkout', ...target]); return true } catch { return false }
  }
  private registered(manifest: WorktreeReconstructionManifest): Promise<boolean> { return this.registeredAt(manifest.commonDir, manifest.worktreePath) }
  private async registeredAt(commonDir: string, path: string): Promise<boolean> { return (await lifecycleReadAsync(commonDir, ['worktree', 'list', '--porcelain'])).split(/\r?\n/).some((line) => line.startsWith('worktree ') && same(line.slice(9), path)) }
  private verifySource(input: RetirementInput, purging = false): { baseSha?: string; resultSha?: string } {
    const task = this.store.require(input.taskId)
    if (['purged', 'blocked'].includes(task.state) || task.state === 'purge-started' && (!purging || !task.purge?.items.some((item) => item.kind === 'worktree' && item.identity === input.worktreePath && item.status === 'pending'))) throw new Error('Workspace owner is unavailable for retirement or recall')
    // Locate a moved source by its relative position in the stable owner history.
    let sourcePath = input.sourcePath
    for (const location of task.locations) { const rel = relative(location, sourcePath); if (rel && !rel.startsWith('..') && !isAbsolute(rel)) { sourcePath = join(task.location, rel); break } }
    const insideTask = !relative(task.location, sourcePath).startsWith('..') && !isAbsolute(relative(task.location, sourcePath))
    if (insideTask) assertLifecyclePath(task.location, sourcePath)
    else assertLifecyclePath(this.store.profileHome, sourcePath)
    const value: unknown = JSON.parse(readFileSync(sourcePath, 'utf8'))
    if (!input.repositoryId || !/^[a-f0-9]{32}$/.test(input.repositoryId)) throw new Error('Workspace source requires verified repository identity')
    const installationHome = basename(dirname(this.store.profileHome)) === 'profiles' ? dirname(dirname(this.store.profileHome)) : this.store.profileHome
    const worktreeBase = join(installationHome, 'repositories', input.repositoryId, 'worktrees')
    const owns = (row: Record<string, unknown>): boolean => row.worktreePath === input.worktreePath && row.branch === input.branch
    let owned = false
    let baseSha: string | undefined, resultSha: string | undefined
    if (insideTask && dirname(sourcePath) === task.location && basename(sourcePath) === 'workspace.json') {
      const row = value as Record<string, unknown>
      const journal = new ThreadJournal(task.location, { readOnly: true }).list()
      const provisions = journal.filter((entry) => {
        const intent = entry.expectedPreState as { branch?: string; worktreePath?: string } | undefined
        // The worktree is at `threads/<task>/<conversation branch>`; its branch is `mousse/<slug>`, named once when it was
        // made, or for a thread made before that, `mousse/thread/<task>/<conversation branch>`.
        const leaf = typeof intent?.worktreePath === 'string' ? basename(intent.worktreePath) : undefined
        const branchFits = typeof intent?.branch === 'string' && (intent.branch.startsWith('mousse/thread/') ? intent.branch === `mousse/thread/${task.taskId}/${leaf}` : !isIdNamedMousseBranch(intent.branch) && isMousseBranchName(intent.branch))
        return entry.schemaVersion === 1 && entry.operationType === 'workspace-provision' && entry.state === 'planned' && branchFits && Boolean(leaf && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(leaf)) && typeof intent!.worktreePath === 'string' && same(intent!.worktreePath, input.worktreePath) && same(input.worktreePath, join(worktreeBase, 'threads', task.taskId, leaf!))
      })
      let branchOwned = provisions.some((entry) => (entry.expectedPreState as { branch?: string }).branch === input.branch)
      if (!branchOwned && typeof row.conversationBranchId === 'string') {
        const branchesPath = join(task.location, 'conversation-branches.json')
        assertLifecyclePath(task.location, branchesPath)
        const stat = lstatSync(branchesPath)
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Conversation branch authority is not a bounded record')
        const branches: unknown = JSON.parse(readFileSync(branchesPath, 'utf8'))
        if (!Array.isArray(branches)) throw new Error('Conversation branch authority is invalid')
        const branch = (branches as ConversationBranch[]).find((entry) => entry?.id === row.conversationBranchId)
        if (branch && branch.creationReason === 'fork' && branch.lifecycle === 'active' && /^[a-f0-9-]{36}$/i.test(branch.id) && typeof branch.parentTurnId === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(branch.parentTurnId) && branch.gitBranch === input.branch && input.branch === `mousse/thread/${branch.parentTurnId}/${branch.id}` && branch.retainedRef === `refs/mousse/conversation-branches/${branch.id}` && row.retainedRef === branch.retainedRef) {
          branchOwned = journal.some((entry) => {
            const details = entry.details as { branchId?: string; actionId?: string } | undefined
            if (entry.operationType !== 'conversation-fork' || entry.state !== 'completed' || details?.branchId !== branch.id || !details.actionId) return false
            return journal.some((actionEntry) => {
              const action = (actionEntry.details as { action?: ThreadAction } | undefined)?.action
              return actionEntry.operationType === 'action-checkpoint' && actionEntry.operationId === details.actionId && action?.id === details.actionId && action.turnId === branch.parentTurnId && action.conversationBranchId === branch.parentBranchId && journal.some((completed) => completed.operationType === 'action-checkpoint' && completed.operationId === action.id && completed.state === 'completed')
            })
          })
        }
      }
      owned = row.schemaVersion === 1 && row.threadId === task.taskId && provisions.length > 0 && branchOwned && owns(row)
      baseSha = typeof row.baseSha === 'string' ? row.baseSha : undefined
    } else if (insideTask && dirname(sourcePath) === task.location && basename(sourcePath) === 'agent-episodes.json') {
      const state = new AgentEpisodeStore(task.location).read()
      const episode = state.episodes.find((entry) => entry.policy.workspace === 'isolated' && entry.binding.worktreePath === input.worktreePath && entry.binding.branch === input.branch && input.branch === `mousse/agent/${entry.id}`)
      owned = Boolean(episode && same(input.worktreePath, WorktreeIdentity.forAgent(join(worktreeBase, 'agents'), episode.id).path))
      baseSha = episode?.binding.baseSha
      resultSha = episode?.result?.resultSha
    } else if (insideTask && dirname(sourcePath) === task.location && ['agents.json', 'mousse-agent-sessions.json'].includes(basename(sourcePath)) && Array.isArray(value)) {
      owned = value.some((row) => row && typeof row === 'object' && owns(row) && typeof (row.agentId ?? row.id) === 'string' && input.branch === `mousse/agent/${row.agentId ?? row.id}` && same(input.worktreePath, WorktreeIdentity.forAgent(join(worktreeBase, 'agents'), row.agentId ?? row.id).path))
    } else if (!insideTask && dirname(sourcePath) === join(this.store.profileHome, 'workflow-agent-bindings', 'workspaces') && value && typeof value === 'object' && !Array.isArray(value)) {
      const row = value as Record<string, unknown>
      const key = typeof row.idempotencyKey === 'string' ? row.idempotencyKey : ''
      const agentId = `wf-${hash(`${this.store.profileId}:${task.taskId}:${key}`).slice(0, 40)}`
      const expectedPath = WorktreeIdentity.forAgent(join(installationHome, 'wf', input.repositoryId.slice(0, 16), hash(`${this.store.profileId}:${task.taskId}`).slice(0, 24)), agentId).path
      owned = row.version === 1 && row.kind === 'git-worktree' && row.profileId === this.store.profileId && row.threadId === task.taskId && Boolean(key) && basename(sourcePath) === `${/^[a-f0-9]{64}$/i.test(key) ? key.toLowerCase() : hash(key)}.json` && row.retainedRef === `refs/mousse/workflows/${this.store.profileId}/${task.taskId}/${agentId}` && input.branch === `mousse/agent/${agentId}` && same(input.worktreePath, expectedPath) && owns(row)
      baseSha = typeof row.baseSha === 'string' ? row.baseSha : undefined
      resultSha = typeof row.resultSha === 'string' ? row.resultSha : undefined
    }
    if (!owned) throw new Error('Known source no longer owns the exact task, generated workspace location and branch; legacy or relocated checkout is retained')
    if ([baseSha, resultSha].some((sha) => sha !== undefined && !/^[a-f0-9]{40,64}$/.test(sha))) throw new Error('Owner source contains an invalid Git boundary')
    return { baseSha, resultSha }
  }
  private async inspectIdentity(path: string, branch: string, expectedRepository?: string) {
    await assertLifecyclePathAsync(dirname(path), path)
    if (!isAbsolute(path) || !(await lstat(join(path, '.git'))).isFile() || !isMousseBranchName(branch)) throw new Error('Only owned linked worktrees can retire')
    // The branch is the owner's record of the thread's own branch; the agent may have switched to another, so it is not compared with HEAD's.
    if (!same(await realpathLikeSync(path), await lifecycleReadAsync(path, ['rev-parse', '--show-toplevel']))) throw new Error('Worktree root changed')
    const commonDir = await realpathLikeSync(resolve(path, await lifecycleReadAsync(path, ['rev-parse', '--git-common-dir'])))
    const repositoryId = hash(commonDir.toLowerCase()).slice(0, 32)
    if (expectedRepository && expectedRepository !== repositoryId) throw new Error('Worktree repository changed')
    const gitDirectory = await realpathLikeSync(resolve(path, await lifecycleReadAsync(path, ['rev-parse', '--git-dir'])))
    const stat = await lstat(path)
    const identity = { commonDir, repositoryId, gitDirectory, rootIdentity: { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs } }
    if (!await this.registered({ ...identity, worktreePath: path } as WorktreeReconstructionManifest)) throw new Error('Worktree is not registered')
    return identity
  }
  /**
   * Throws unless the checkout holds only tracked, exactly reconstructible content. Reads only; writes nothing.
   * `snapshotTree` is the tree of the worktree's files (a snapshot, see `takeSnapshot`): uncommitted files are then
   * acceptable, because the snapshot holds them, and the files are compared with it instead of with HEAD. What a
   * snapshot does not hold is refused: staged changes, an unresolved conflict, a merge or rebase in progress, a sparse checkout.
   */
  async inspectContent(path: string, snapshotTree?: string): Promise<Pick<WorktreeReconstructionManifest, 'content' | 'auxiliary' | 'sparse'>> {
    if (!snapshotTree) {
      if (await lifecycleReadAsync(path, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('Dirty, conflicted or untracked content requires retention')
    } else {
      if (await operationInProgressAsync(path)) throw new Error('A merge, rebase or other Git operation in progress requires retention')
      if (await lifecycleReadAsync(path, ['ls-files', '-u'])) throw new Error('Conflicted content requires retention')
      if (await lifecycleReadAsync(path, ['diff', '--cached', '--name-only'])) throw new Error('Staged changes require retention')
    }
    const entries = await walkOwnedContentAsync(path, true)
    const tracked = new Map((await lifecycleReadAsync(path, ['ls-tree', '-r', '-z', snapshotTree ?? 'HEAD'])).split('\0').filter(Boolean).map((line) => { const tab = line.indexOf('\t'), header = line.slice(0, tab).split(' '); return [line.slice(tab + 1), { mode: header[0], sha: header[2] }] }))
    const configTrue = async (key: string): Promise<boolean> => { try { return await lifecycleGitAsync(path, ['config', '--bool', key]) === 'true' } catch { return false } }
    const sparseEnabled = await configTrue('core.sparseCheckout')
    const sparse = sparseEnabled ? { patterns: await readFile(resolve(path, await lifecycleGitAsync(path, ['rev-parse', '--git-path', 'info/sparse-checkout'])), 'utf8'), cone: await configTrue('core.sparseCheckoutCone') } : undefined
    // A snapshot sees a file outside the sparse patterns as deleted, so it cannot stand for the checkout.
    if (snapshotTree && sparse) throw new Error('A sparse checkout with uncommitted files requires retention')
    const skipped = new Set<string>()
    for (const flag of (await lifecycleReadAsync(path, ['ls-files', '-v', '-z'])).split('\0').filter(Boolean)) {
      if (/^[a-z]/.test(flag) || (flag.startsWith('S ') && (!sparse || await exists(join(path, flag.slice(2)))))) throw new Error('Hidden index flags require explicit retention')
      if (flag.startsWith('S ')) skipped.add(flag.slice(2))
    }
    for (const name of tracked.keys()) if (!entries.some((entry) => entry.path === name) && !skipped.has(name)) throw new Error('Missing tracked content is not explained by sparse checkout')
    const auxiliary: Array<{ path: string; content: string }> = []
    const files = entries.filter((entry) => entry.kind === 'file' && tracked.has(entry.path))
    if (files.length) {
      const attributes = (await lifecycleGitAsync(path, ['check-attr', '-z', '--stdin', 'filter'], files.map((entry) => entry.path).join('\0') + '\0')).split('\0')
      for (let index = 2; index < attributes.length; index += 3) if (!['unspecified', 'unset'].includes(attributes[index])) throw new Error('External checkout filters require retained auxiliary payloads')
      const argv = await withoutRepoProgramsAsync(path, ['cat-file', '--batch', '--filters', '-Z'])
      const ran = await runGitProcess(argv, { cwd: path, env: repoProgramEnv(), input: files.map((entry) => `${tracked.get(entry.path)!.sha} ${entry.path}\0`).join(''), timeout: 30_000, maxBuffer: 600 * 1024 * 1024 })
      if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
      const materialized = ran.stdoutBytes
      let offset = 0
      for (const entry of files) {
        const headerEnd = materialized.indexOf(0, offset)
        const header = materialized.subarray(offset, headerEnd).toString('utf8').split(' ')
        if (headerEnd < offset || header[0] !== tracked.get(entry.path)!.sha || header[1] !== 'blob') throw new Error('Incomplete materialized-content proof')
        offset = headerEnd + 1
        // Git reports the raw object size even with --filters. The expected actual byte count
        // safely delimits the proof: every digest, terminator, next header and final length must match.
        if (hash(materialized.subarray(offset, offset + entry.bytes)) !== entry.digest || materialized[offset + entry.bytes] !== 0) throw new Error('Tracked bytes cannot be reconstructed exactly from the retained result')
        offset += entry.bytes + 1
      }
      if (offset !== materialized.length) throw new Error('Materialized result has unexpected bytes')
    }
    for (const entry of entries) {
      if (entry.kind === 'directory') continue
      if (tracked.has(entry.path)) {
        const expected = tracked.get(entry.path)!
        if (expected.mode === '160000') throw new Error('Nested repository cannot be retired')
        if (entry.kind === 'link' && expected.mode !== '120000') throw new Error('Unexpected link in workspace')
        if (entry.kind === 'link' && await lifecycleGitAsync(path, ['hash-object', '--stdin'], await readlink(join(path, entry.path))) !== expected.sha) throw new Error('Tracked link differs from the durable result tree')
        continue
      }
      if (!MOUSSE_CONTROL_FILE_PATHS.includes(entry.path) || entry.kind !== 'file' || entry.bytes > 1024 * 1024) throw new Error(`Uncaptured ignored or untracked content requires retention: ${entry.path}`)
      auxiliary.push({ path: entry.path, content: (await readFile(join(path, entry.path))).toString('base64') })
    }
    // Modes contain platform type bits; reconstruction uses the same platform and Git checkout policy.
    return { content: entries, auxiliary, ...(sparse ? { sparse } : {}) }
  }
  private async checkoutFingerprint(path: string): Promise<string> {
    const read = async (key: string): Promise<string> => { try { return await lifecycleGitAsync(path, ['config', '--get', key]) } catch (error) { if ((error as { status?: number }).status !== 1) throw error; return '' } }
    const common = resolve(path, await lifecycleGitAsync(path, ['rev-parse', '--git-common-dir']))
    const infoAttributes = join(common, 'info', 'attributes')
    const externalAttributes = await read('core.attributesFile')
    const autocrlf = await read('core.autocrlf'), eol = await read('core.eol'), symlinks = await read('core.symlinks')
    return hash(JSON.stringify({ autocrlf, eol, symlinks, infoAttributes: await exists(infoAttributes) ? hash(await readFile(infoAttributes)) : '', externalAttributes, externalDigest: externalAttributes ? hash(await readFile(externalAttributes)) : '' }))
  }
  /** The repository lease file as it is now: it is kept in the repository's own metadata folder, so it is read without blocking. */
  private async readRepositoryLease(): Promise<{ token?: string; processInstanceId?: string } | undefined> {
    const lease = this.ownership?.repositoryLease
    if (!lease) return undefined
    return JSON.parse(await readFile(lease.path, 'utf8')) as { token?: string; processInstanceId?: string }
  }
  private assertRepositoryLease(commonDir: string, repositoryId: string, current: { token?: string; processInstanceId?: string } | undefined): void {
    const lease = this.ownership?.repositoryLease
    if (!lease || lease.owner.pid !== process.pid || lease.owner.processInstanceId !== PROCESS_INSTANCE_ID || lease.identity.key !== repositoryId || !same(lease.identity.commonDir, commonDir) || !same(lease.path, join(lease.identity.metadataDir, 'repository-mutation.lease'))) throw new Error('Retirement requires the exact held repository lease')
    if (current?.token !== lease.owner.token || current.processInstanceId !== PROCESS_INSTANCE_ID) throw new Error('Retirement repository ownership was lost')
  }
  /** Reads the repository lease without blocking, then checks it and the task's ownership under the task's gate. */
  private async checkOwnership(taskId: string, commonDir: string, repositoryId: string): Promise<void> {
    const lease = await this.readRepositoryLease()
    this.store.withGate(taskId, () => this.assertOwnership(taskId, commonDir, repositoryId, lease))
  }
  private assertOwnership(taskId: string, commonDir: string, repositoryId: string, lease: { token?: string; processInstanceId?: string } | undefined): void {
    this.assertRepositoryLease(commonDir, repositoryId, lease)
    const ownership = this.ownership!
    const task = this.store.require(taskId)
    if (ownership.taskLease) {
      assertHeldThreadLease(task.location, ownership.taskLease)
      this.store.captureAdmission(taskId, task.location)
      return
    }
    if (!ownership.cleanupTaskId) throw new Error('Retirement requires task execution ownership or an exact cleanup reservation')
    const cleanup = this.store.require(ownership.cleanupTaskId)
    if (!['trashed', 'purge-started'].includes(cleanup.state) || cleanup.generation !== ownership.cleanupGeneration || cleanup.cleanupOwner?.token !== ownership.cleanupToken || cleanup.cleanupOwner?.pid !== process.pid || cleanup.cleanupOwner?.processInstanceId !== PROCESS_INSTANCE_ID) throw new Error('Retirement cleanup ownership was lost')
    let owner = task
    const seen = new Set<string>()
    while (owner.taskId !== cleanup.taskId) {
      if (seen.has(owner.taskId) || !owner.parentTaskId || owner.state !== 'active') throw new Error('Cleanup reservation does not own this workspace')
      seen.add(owner.taskId); owner = this.store.require(owner.parentTaskId)
    }
  }
}
