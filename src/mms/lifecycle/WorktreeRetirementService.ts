import { MOUSSE_CONTROL_FILE_PATHS } from '../worktree/controlFiles'
import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpath as realpathCallback, rmdirSync, unlinkSync, type BigIntStats, type Stats } from 'node:fs'
import { access, chmod, lstat, mkdir, readdir, readFile, readlink, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { assertLifecyclePath, assertLifecyclePathAsync, ResourceLifecycleStore } from './ResourceLifecycleStore'
import type { RepositoryLeaseHandle } from '../git/RepositoryLease'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { assertHeldThreadLease } from '../actions/GitOperationCoordinator'
import { MOUSSE_COMMIT_ENV, operationInProgressAsync } from '../actions/git'
import { moveFilesAsync, sameTreeAsync, takeSnapshotAsync, worktreeTreeAsync } from '../actions/snapshots'
import { PROCESS_INSTANCE_ID } from '../queue/processLiveness'
import { AgentEpisodeStore } from '../agents/AgentEpisodeStore'
import { WorktreeIdentity } from '../worktree/WorktreeIdentity'
import { ThreadJournal } from '../data/ThreadJournal'
import { claimOverlapsPath, getExternalResourceClaims, getExternalResourceClaimsFromFacts, repositoryTargetAsync, unverifiedOwnerOver } from './LifecycleClaims'
import { canonicalPathAsync } from './canonicalPath'
import { OwnershipFacts } from './ResourceInventory'
import type { ConversationBranch, ThreadAction } from '../../shared/threadActions'
import { gitDirectoryEnvAsync } from '../git/gitEnv'
import { READ_ONLY_GIT_ENV } from '../git/readOnlyGit'
import { repoProgramEnv, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { gitRunError, LISTING_MAX_BUFFER, runGitProcess } from '../git/runGitProcess'
import { renameFolderAsync } from './renameFolder'
import { isIdNamedMousseBranch, isMousseBranchName } from '../../shared/mousseBranches'
import { adminDigest, adminObjectIds, blobId, HEAD_REFLOG, readAdminFilesAsync, replayedAdminFile, type AdminFile } from './worktreeAdminData'
import { keepCopy, keptCopyWindowMs } from '../actions/keptCopies'
import { retentionWindowText } from '../../shared/undoRetention'

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
/** A retired worktree waits in the trash until nothing in it has changed for this long; then its files are snapshotted and it is deleted. */
export const WORKTREE_TRASH_QUIET_MS = 60 * 60_000
/** The record of a worktree in the trash changed or went (a permanent deletion) while it was being expired. */
/** HEAD and Git's own data of a worktree, as compared before its `.git` file is deleted. */
function adminStateOf(head: string, admin: string): string {
  return JSON.stringify([head, admin])
}
/** Whether two lists name the same entries, each exactly, in any order. */
function sameContent(a: readonly ContentEntry[], b: readonly ContentEntry[]): boolean {
  const proof = new Map(b.map((entry) => [entry.path, entry]))
  return a.length === b.length && a.every((entry) => sameEntry(entry, proof.get(entry.path)))
}
/** Whether an entry is exactly the one the proof records. */
function sameEntry(entry: ContentEntry, proof: ContentEntry | undefined): boolean {
  return Boolean(proof) && entry.kind === proof!.kind && entry.digest === proof!.digest && entry.bytes === proof!.bytes && entry.mode === proof!.mode
}
/** Whether an entry is still what the proof records, by its kind, size, mode and (a link) target; not by a file's bytes. */
function sameShape(entry: ContentEntry, proof: ContentEntry | undefined): boolean {
  return Boolean(proof) && entry.kind === proof!.kind && entry.bytes === proof!.bytes && entry.mode === proof!.mode && (entry.kind !== 'link' || entry.digest === proof!.digest)
}
/** How often the trash expiry refreshes the repository lease it holds; well within its stale time. */
const LEASE_HEARTBEAT_MS = 5_000
/** The repository lease was taken by someone else while a folder was being deleted: nothing more is removed. */
class LeaseLost extends Error {}
/** A folder as `lstat` identifies it. */
function identityOf(stat: { dev: number; ino: number }): string { return `${stat.dev}:${stat.ino}` }
/**
 * Synchronously, right before something in `folder` (or `folder` itself) is removed: every folder from `top` down to
 * `folder` is a real folder, no link, and the very one recorded in `folders` (by `resolve`d path). Throws {@link FolderChanged}.
 */
function assertFoldersUnchanged(top: string, folder: string, folders: ReadonlyMap<string, string>): void {
  for (let at = resolve(folder); ; at = dirname(at)) {
    let stat: Stats
    try { stat = lstatSync(at) } catch { throw new FolderChanged() }
    if (stat.isSymbolicLink() || !stat.isDirectory() || folders.get(at) !== identityOf(stat)) throw new FolderChanged()
    if (same(at, top)) return
    if (dirname(at) === at) throw new FolderChanged()
  }
}
/** Why Git has the worktree whose administration folder is `adminDir` locked (empty for no reason given), or undefined. */
function lockReasonSync(adminDir: string): string | undefined {
  try { return readFileSync(join(adminDir, 'locked'), 'utf8').trim() } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; return '' }
}
function lockedText(reason: string, path: string): string {
  return `Git has this worktree locked${reason ? ` (${reason})` : ''}, so it stays in the trash. Run git worktree unlock "${path}" to let it be deleted.`
}
/**
 * The first folder in `root` (relative to it, `''` for `root` itself) whose files this process may not delete, or
 * undefined. Links are not followed. On Windows a folder's read-only flag does not stop that, so nothing is looked at.
 */
async function readOnlyFolderAsync(root: string): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined
  let seen = 0
  const visit = async (path: string, rel: string, depth: number): Promise<string | undefined> => {
    if (++seen > 100_000 || depth > 64) return undefined
    if (!await access(path, fsConstants.W_OK | fsConstants.X_OK).then(() => true, () => false)) return rel
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || depth === 0 && entry.name === '.git') continue
      const found = await visit(join(path, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  return visit(root, '', 0)
}
/** Whether the volume of `path` tells names apart only by case, as macOS and Windows volumes usually do not. */
async function caseInsensitiveAt(path: string): Promise<boolean> {
  for (let at = resolve(path); dirname(at) !== at; at = dirname(at)) {
    const name = basename(at), flipped = name.toUpperCase() !== name ? name.toUpperCase() : name.toLowerCase()
    if (flipped === name) continue
    const [real, other] = await Promise.all([lstat(at), lstat(join(dirname(at), flipped)).catch(() => undefined)])
    return Boolean(other && other.ino === real.ino && other.dev === real.dev)
  }
  return false
}
/**
 * A rebuild writing a worktree's files back from its proof, into the checkout `git worktree add` just made. It never
 * removes or overwrites anything it did not write itself: before an entry in the way is cleared (another kind of entry,
 * another spelling of its name on a volume that does not tell case apart, a file written over), every file and link in
 * it must be exactly what the checkout and snapshot wrote (`fromCheckout`) or what this rebuild wrote (`written`).
 * Anything else, written there by someone while the rebuild ran, is kept as a copy first (`keep`), and only then cleared;
 * when no copy can be kept, the rebuild stops with nothing of it deleted. Links are never followed. A folder made ready
 * is remembered (`placed`) until something at or above it is cleared or renamed.
 */
class Rebuild {
  readonly placed = new Set<string>()
  /** What this rebuild wrote, or kept a copy of, by path below the top: `<kind>:<SHA-256 of the bytes or link target>`. */
  readonly written = new Map<string, string>()
  constructor(
    readonly top: string,
    readonly insensitive: boolean,
    private readonly fromCheckout: (rel: string, kind: 'file' | 'link', bytes: Buffer) => Promise<boolean>,
    private readonly keep: (rels: string[]) => Promise<ReadonlyMap<string, string>>
  ) {}
  private rel(path: string): string { return relative(this.top, path).split(sep).join('/') }
  /** Records a file or link this rebuild wrote, as it wrote it. */
  record(path: string, kind: 'file' | 'link', bytes: Buffer): void { this.written.set(this.rel(path), `${kind}:${hash(bytes)}`) }
  /** Forgets what was remembered at or below `path`: it was cleared, or moved to `to`. */
  private forget(path: string, to?: string): void {
    const rel = this.rel(path), under = (key: string): boolean => key === rel || key.startsWith(`${rel}/`)
    for (const folder of [...this.placed]) if (folder === path || folder.startsWith(`${path}${sep}`)) this.placed.delete(folder)
    for (const [key, value] of [...this.written]) if (under(key)) { this.written.delete(key); if (to) this.written.set(`${this.rel(to)}${key.slice(rel.length)}`, value) }
  }
  /** Whether the file or link at `path` is exactly what this rebuild, or the checkout and snapshot, wrote there. */
  private async mine(path: string, stat: Stats): Promise<boolean> {
    const kind = stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : undefined
    if (!kind) return false
    const bytes = kind === 'link' ? Buffer.from(await readlink(path), 'utf8') : await readFile(path)
    const recorded = this.written.get(this.rel(path))
    if (recorded !== undefined) return recorded === `${kind}:${hash(bytes)}`
    return this.fromCheckout(this.rel(path), kind, bytes)
  }
  /** Keeps a copy of every file and link at or below `path` the rebuild did not write, so none of them is lost. */
  private async keepStrangers(path: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const strangers: Array<{ rel: string; kind: 'file' | 'link' }> = []
      const visit = async (at: string): Promise<void> => {
        const stat = await lstat(at)
        if (stat.isDirectory()) { for (const name of await readdir(at)) await visit(join(at, name)) }
        else if (!await this.mine(at, stat)) strangers.push({ rel: this.rel(at), kind: stat.isSymbolicLink() ? 'link' : 'file' })
      }
      await visit(path)
      if (!strangers.length) return
      if (attempt >= 2) throw new Error(`Files keep changing at ${path} while the worktree is rebuilt; nothing of them was deleted. Try again once they have stopped changing.`)
      const digests = await this.keep(strangers.map((entry) => entry.rel))
      for (const entry of strangers) { const digest = digests.get(entry.rel); if (digest) this.written.set(entry.rel, `${entry.kind}:${digest}`) }
    }
  }
  /** Clears what is at `path`, after `keepStrangers`: a folder with everything in it, a link as the link. */
  private async clear(path: string): Promise<void> {
    await this.keepStrangers(path)
    const remove = async (at: string): Promise<void> => {
      const stat = await lstat(at)
      if (stat.isDirectory()) { for (const name of await readdir(at)) await remove(join(at, name)); await rmdir(at) }
      else await unlink(at)
    }
    await remove(path)
    this.forget(path)
  }
  /**
   * In `parent`, makes `name` ready for an entry of `kind` and returns its path: what is in the way is cleared (see the
   * class); a folder spelled differently is renamed instead, so what it holds stays. A file is written over only when it is
   * one the rebuild wrote, or once a copy of it is kept.
   */
  async place(parent: string, name: string, kind: ContentEntry['kind']): Promise<string> {
    const path = join(parent, name)
    let stat = await lstat(path).catch(() => undefined)
    if (stat && this.insensitive) {
      const other = (await readdir(parent)).find((entry) => entry !== name && entry.toLowerCase() === name.toLowerCase())
      if (other && kind === 'directory' && stat.isDirectory()) { await rename(join(parent, other), path); this.forget(join(parent, other), path); return path }
      if (other) { await this.clear(join(parent, other)); stat = undefined }
    }
    if (stat && kind === 'directory' && stat.isDirectory()) return path
    if (stat && kind === 'file' && stat.isFile()) { await this.keepStrangers(path); return path }
    if (stat) await this.clear(path)
    if (kind === 'directory') await mkdir(path)
    return path
  }
  /** Makes every folder of `parts` (a path below the top) a real folder spelled so; returns the last. */
  async folder(parts: readonly string[]): Promise<string> {
    let at = this.top
    for (const part of parts) {
      const next = join(at, part)
      if (!this.placed.has(next)) { await this.place(at, part, 'directory'); this.placed.add(next) }
      at = next
    }
    return at
  }
}
/** A file another process holds open fails to delete with these codes (on Windows also EPERM and EACCES). */
const IN_USE_CODES = new Set(process.platform === 'win32' ? ['EBUSY', 'EPERM', 'EACCES'] : ['EBUSY'])
interface ExpireOptions {
  now?: number
  inUse?: (path: string) => string | undefined
  /** Test seam: runs between the capture and the check before the rename. */
  afterCapture?: (path: string) => void
  /** Test seam: runs right after the folder was renamed to its `.deleting-` name. */
  afterRename?: (path: string) => void
  /** Test seam: runs right before each entry of the renamed folder is removed, after its last check. */
  beforeRemove?: (path: string) => void
  /** Folders of what is left that a restore made writable (`makeRemnantWritable`), by path: their mode before and after. */
  madeWritable?: ReadonlyMap<string, { from: number; to: number }>
}
/** An entry as it was before a restore made its folder writable, so that change is not taken for a write by someone. */
function beforeMadeWritable(entry: ContentEntry, options: ExpireOptions): ContentEntry {
  const mode = options.madeWritable?.get(entry.path)
  return mode && entry.kind === 'directory' && entry.mode === mode.to ? { ...entry, mode: mode.from } : entry
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
   * Git's own data of the worktree, kept when the trash expiry deletes it: the files of its administration folder
   * (`<common>/worktrees/<name>/`, see `worktreeAdminData.ts`) as the tree `adminTree` of the commit `adminCommit`,
   * pinned under `adminRef`. A later capture that differs makes a new commit on top of the earlier one. A rebuild writes
   * the files back before anything is checked out.
   */
  adminTree?: string
  adminCommit?: string
  adminRef?: string
  /**
   * Files no snapshot holds, kept by the trash expiry before it deletes them: ignored files, and writes that landed while
   * the folder was being deleted. Each entry is one kept copy (`keptCopies.ts`, owned by the thread's journal) whose
   * commit is also pinned under `<prefix>/kept/<sha>` (in `keptRefs`), so it lasts as long as the rest of this record.
   * `paths` are the files it holds for the rebuild; a rebuild writes them over the checkout in this order, a later copy
   * of a path over an earlier one. `folders` are folders that appeared or changed kind with them (a file that became an
   * empty folder): the rebuild makes them, in the same order. A layer of folders only has no copy (`sha`). `content`
   * names the bytes each path must have then.
   */
  keptFiles?: Array<{ sha?: string; paths: string[]; folders?: string[] }>
  /**
   * Files that appeared in the new checkout while it was being rebuilt, in the way of what the proof holds: each was kept
   * in a kept copy (`ref`, owned by the thread's journal) before the rebuild cleared it.
   */
  keptAside?: Array<{ ref: string; paths: string[] }>
  /**
   * Set with state `deleting`: the trash expiry renamed the folder to `path` (a `.deleting-<hex>` sibling in the trash)
   * and is deleting it entry by entry against `content`, the proof the capture recorded. `adminState` is the HEAD and
   * Git's own data of the worktree as captured. `changedAt` is when a write was last found in the folder while it was
   * being deleted; the delete then waits `WORKTREE_TRASH_QUIET_MS` from it.
   */
  deleting?: { path: string; startedAt: string; adminState: string; changedAt?: string }
  /**
   * `prepared`: pins written, folder in place. `trashed`: the folder is in the trash. `deleting`: the trash expiry is
   * deleting it (see `deleting`). `retired`: its files were kept and it was deleted. `materialized`: the worktree is back
   * at its own path.
   */
  state: 'prepared' | 'trashed' | 'deleting' | 'retired' | 'materialized'
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
export async function walkOwnedContentAsync(root: string, skipRootGit = false, options: {
  /** False: files are not read, and their digest is empty; only their kind, size and mode are listed. */
  digests?: boolean
  /** Filled with the identity (`identityOf`) of every folder walked, by `resolve`d path. */
  folders?: Map<string, string>
} = {}): Promise<ContentEntry[]> {
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
      options.folders?.set(resolve(path), identityOf(stat))
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
    entries.push({ path: rel, kind: 'file', digest: options.digests === false ? '' : hash(await readFile(path)), bytes: stat.size, mode: stat.mode })
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
/** How many set-aside files a notice names, each with its own command. */
const NOTICE_PATHS = 5
/** A path or `<ref>:<path>` as one word of a shell command, quoted only when it needs to be. */
function shellWord(value: string): string {
  return /^[\w./@:+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}
/**
 * What a rebuild of the worktree set aside (`keptAside`), in plain words for the thread, with the exact command that
 * brings each file back and how long it is kept; undefined when it set nothing aside. `windowMs` is the owner's Undo
 * window (`keptCopyWindowMs`).
 */
export function keptAsideNotice(manifest: Pick<WorktreeReconstructionManifest, 'keptAside' | 'worktreePath'>, windowMs: number): { id: string; text: string } | undefined {
  const files = (manifest.keptAside ?? []).flatMap((entry) => entry.paths.map((path) => ({ ref: entry.ref, path })))
  if (!files.length) return undefined
  const one = files.length === 1
  const named = files.slice(0, NOTICE_PATHS)
  // In backticks, which the thread shows as commands.
  const commands = named.map(({ ref, path }) => `\`git cat-file blob ${shellWord(`${ref}:${path}`)} > ${shellWord(path)}\``).join('; ')
  const more = files.length > named.length ? `, and the same way for the other ${files.length - named.length} (listed under ${[...new Set(files.slice(NOTICE_PATHS).map((file) => file.ref))].join(', ')})` : ''
  const what = one ? `${files[0]!.path}, which was` : `${files.length} files, which were`
  const list = one ? '' : `: ${named.map((file) => file.path).join(', ')}${files.length > named.length ? ` and ${files.length - named.length} more` : ''}`
  return {
    id: `worktree-set-aside-${manifest.keptAside![0]!.ref.slice(manifest.keptAside![0]!.ref.lastIndexOf('/') + 1)}`,
    text: `While rebuilding this worktree, Mousse set aside ${what} written there during the rebuild${list}. Bring ${one ? 'it' : 'them'} back by running this in ${manifest.worktreePath}: ${commands}${more} (kept for ${retentionWindowText(windowMs)}).`
  }
}

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
    const indexDigest = hash(await lifecycleReadAsync(input.worktreePath, ['ls-files', '--stage', '-v', '-z'], undefined, LISTING_MAX_BUFFER))
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
    if (value.baseRef !== `${prefix}/base` || value.resultRef !== `${prefix}/result` || ![value.worktreePath, value.commonDir, value.gitDirectory, value.sourcePath].every(isAbsolute) || ![value.baseSha, value.resultSha, value.treeSha].every((sha) => /^[a-f0-9]{40,64}$/.test(sha)) || !/^[a-f0-9]{32}$/.test(value.repositoryId) || !Array.isArray(value.content) || !Array.isArray(value.auxiliary) || !['prepared', 'trashed', 'deleting', 'retired', 'materialized'].includes(value.state)) throw new Error('Malformed workspace reconstruction manifest')
    if (value.trashPath !== undefined && !same(value.trashPath, this.trashPathFor(value)) || ['trashed', 'deleting'].includes(value.state) && (!value.trashPath || typeof value.trashedAt !== 'string')) throw new Error('Malformed workspace trash location')
    if ((value.state === 'deleting') !== (value.deleting !== undefined) || value.deleting && (typeof value.deleting.path !== 'string' || !same(dirname(value.deleting.path), dirname(value.trashPath!)) || !/^\.deleting-[a-f0-9]{16}$/.test(basename(value.deleting.path)) || typeof value.deleting.startedAt !== 'string' || typeof value.deleting.adminState !== 'string' || value.deleting.changedAt !== undefined && typeof value.deleting.changedAt !== 'string')) throw new Error('Malformed workspace delete record')
    const relativePath = (path: unknown): boolean => typeof path === 'string' && path !== '' && !isAbsolute(path) && !path.split(/[\\/]/).includes('..')
    if (value.keptFiles !== undefined && (!Array.isArray(value.keptFiles) || !value.keptFiles.every((layer) => (layer?.sha === undefined ? Array.isArray(layer?.paths) && layer.paths.length === 0 : typeof layer.sha === 'string' && /^[a-f0-9]{40,64}$/.test(layer.sha) && value.keptRefs?.includes(`${prefix}/kept/${layer.sha}`)) && Array.isArray(layer.paths) && layer.paths.every(relativePath) && (layer.folders === undefined || Array.isArray(layer.folders) && layer.folders.every(relativePath))))) throw new Error('Malformed workspace kept files')
    if (value.keptAside !== undefined && (!Array.isArray(value.keptAside) || !value.keptAside.every((entry) => typeof entry?.ref === 'string' && entry.ref.startsWith('refs/mousse/preserved/') && Array.isArray(entry.paths) && entry.paths.every(relativePath)))) throw new Error('Malformed workspace kept files')
    if (value.keptRefs !== undefined && (!Array.isArray(value.keptRefs) || !value.keptRefs.every((ref) => typeof ref === 'string' && ref.startsWith(`${prefix}/kept/`)))) throw new Error('Malformed workspace kept pins')
    if (value.adminRef !== undefined && (value.adminRef !== `${prefix}/admin` || ![value.adminTree, value.adminCommit].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40,64}$/.test(sha)))) throw new Error('Malformed workspace Git data pin')
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
    const snapshot = await lifecycleReadAsync(input.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'], undefined, LISTING_MAX_BUFFER) ? await takeSnapshotAsync(input.worktreePath, { reason: 'retirement', threadId: input.taskId }) : undefined
    const treeSha = await lifecycleReadAsync(input.worktreePath, ['rev-parse', 'HEAD^{tree}'])
    const dirty = Boolean(snapshot && snapshot.tree !== treeSha)
    // A result the owner recorded is a commit (the HEAD) or a snapshot of the files; either way the files must still be those.
    if ((input.resultSha && input.resultSha !== resultSha) || (source.resultSha && source.resultSha !== resultSha && !await sameTreeAsync(input.worktreePath, source.resultSha, snapshot?.sha ?? resultSha))) throw new Error('Workspace result changed before retirement')
    if (input.baseSha && source.baseSha && input.baseSha !== source.baseSha) throw new Error('Workspace base changed before retirement')
    const baseSha = input.baseSha ?? source.baseSha ?? resultSha
    await lifecycleReadAsync(input.worktreePath, ['cat-file', '-e', `${baseSha}^{commit}`])
    const { content, auxiliary, sparse } = await this.inspectContent(input.worktreePath, snapshot?.tree)
    const contents = { content, auxiliary, ...(sparse ? { sparse } : {}) }
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
      if (manifest.state === 'deleting' && !options.purging) throw new Error('The worktree is being deleted from the trash; it is retired already')
      // Permanent deletion: what waits in the trash goes too, and what is left of a delete the trash expiry started.
      // Ownership is checked again right before each removal starts.
      if (options.purging && manifest.trashPath) {
        const lease = await this.readRepositoryLease()
        const owned = (): void => {
          this.store.withGate(manifest.taskId, () => this.assertOwnership(manifest.taskId, manifest.commonDir, manifest.repositoryId, lease))
          options.beforeMove?.()
        }
        if (manifest.deleting && await exists(manifest.deleting.path)) await this.removeConfirmed(manifest.deleting.path, owned)
        if (await exists(manifest.trashPath)) await this.removeTrashed(manifest, owned)
        else if (await this.registeredAt(manifest.commonDir, manifest.trashPath)) await lifecycleGitAsync(manifest.commonDir, ['worktree', 'remove', manifest.trashPath], undefined, undefined, undefined, owned)
        delete manifest.deleting
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
    // Compared by real paths and real repositories, so an alias of this checkout, or a record written before the repository
    // moved, still names it.
    const worktreeReal = await canonicalPathAsync(manifest.worktreePath)
    const repository = await repositoryTargetAsync(manifest.commonDir, manifest.repositoryId)
    /** Why another owner keeps this checkout: a claim on it, or a thread whose checkout can't be verified and whose records may name it. */
    const shares = (all: Awaited<ReturnType<typeof getExternalResourceClaims>>, excluded: Set<string>): string | undefined => {
      const claims = all.filter((resource) => !(resource.peerProfileId === this.store.profileId && excluded.has(resource.ownerTaskId)))
      if (claims.some((resource) => claimOverlapsPath(resource, worktreeReal))) return 'Another task or profile retains this checkout; retirement is blocked'
      const unverified = unverifiedOwnerOver(claims, { ...repository, path: worktreeReal })
      return unverified && `${unverified.reason} This checkout is kept until Mousse can check that worktree again.`
    }
    const excluded = excludedNow()
    const blocked = shares(await getExternalResourceClaims(this.store, excluded), excluded)
    if (blocked) throw new Error(blocked)
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
      const late = shares(getExternalResourceClaimsFromFacts(this.store, current, facts), current)
      if (late) throw new Error(late)
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
   * Deletes a worktree that has waited in the trash with nothing in it changing for `WORKTREE_TRASH_QUIET_MS`, keeping
   * every byte of it first. What a snapshot cannot hold that a kept copy can (ignored files) is kept in one; what neither
   * can hold (staged changes, an operation in progress, a repository inside it) keeps it in the trash, and the reason is
   * returned. Needs the repository lease; the thread may be busy, since its own worktree is elsewhere.
   *
   * Order:
   * 1. `inUse` (Windows: open files), then the capture: a snapshot, a kept copy of the files it cannot hold, Git's own
   *    data of the worktree, and the proof, the digest of every entry (`content`), all recorded before anything moves.
   * 2. What `lstat` says of every entry (read before the capture) is compared again, with HEAD and Git's own data; a
   *    change since is captured again and the delete waits for the next run. A worktree Git has locked stays in the
   *    trash, and the lock is named. Otherwise the folder is renamed to a `.deleting-<hex>` sibling in the trash, after its
   *    `deleting` state is recorded: a writer that opens a file by its path in the folder now fails instead of writing into it.
   * 3. It is compared with the proof once more and deleted entry by entry (`deleteRenamed`), its `.git` file last.
   * 4. `git worktree remove` at the old path unregisters it.
   * A write found in it while it is being deleted stops the delete: the write is added to the proof (never in place of
   * it), and what is left waits for the next run.
   *
   * The remaining limits: a write through a handle opened before the rename (a file held open, or a process whose working
   * directory is in the folder) into a file between its last comparison and its unlink is lost with that file; and, with
   * no `unlinkat` in Node, a folder deliberately swapped for a link between the check of the folders above an entry and
   * its removal (see `deleteRenamed`). An accidental redirection outside the trash is not possible.
   * Undefined means there was nothing to do.
   */
  async expireTrash(manifestPath: string, options: ExpireOptions = {}): Promise<{ removed: true } | { kept: string; waiting?: true } | undefined> {
    const manifest = this.load(manifestPath)
    const record = { text: JSON.stringify(manifest) }
    const stopBeating = this.keepLeaseFresh()
    try { return await this.expireLoaded(manifestPath, manifest, record, options) }
    catch (error) {
      if (error instanceof TrashRecordChanged) return { kept: error.message, waiting: true }
      throw error
    } finally { stopBeating() }
  }
  /**
   * The repository lease is kept fresh while the trash expiry holds it: a delete of many files can take longer than the
   * lease's stale time, after which another process could take it. Whether it is still held is checked before each removal.
   */
  private keepLeaseFresh(): () => void {
    const lease = this.ownership?.repositoryLease
    if (!lease) return () => undefined
    const timer = setInterval(() => { lease.heartbeat() }, LEASE_HEARTBEAT_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }
  private async expireLoaded(manifestPath: string, manifest: WorktreeReconstructionManifest, record: { text: string }, options: ExpireOptions): Promise<{ removed: true } | { kept: string; waiting?: true } | undefined> {
    this.assertRepositoryLease(manifest.commonDir, manifest.repositoryId, await this.readRepositoryLease())
    // A move a crash interrupted before it was recorded: the folder is in the trash and starts waiting now.
    if (manifest.state === 'prepared' && manifest.trashPath && await exists(manifest.trashPath) && !await exists(manifest.worktreePath)) {
      await this.settleTrashRegistration(manifest)
      manifest.state = 'trashed'; manifest.trashedAt = new Date(options.now ?? Date.now()).toISOString(); this.saveTrashed(manifestPath, manifest, record)
    }
    if (manifest.state === 'deleting') return await this.continueDeleting(manifestPath, manifest, record, options, true)
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
    // A worktree Git has locked stays in the trash before anything is captured: every run would otherwise capture it
    // again, and keep another copy of its ignored files, only to stop at the check before the rename. That check stays,
    // for a lock given while the capture runs.
    const lockedNow = await this.lockOf(manifest.commonDir, trashPath)
    if (lockedNow !== undefined) return { kept: lockedText(lockedNow, trashPath) }
    // In use (Windows: open files) is asked before anything is captured, so whatever it lets through is in the snapshot.
    const busy = options.inUse?.(trashPath)
    if (busy) return { kept: busy }
    // A folder whose files Mousse may not delete keeps the worktree in the trash, whole, instead of a delete that stops partway.
    const readOnly = await readOnlyFolderAsync(trashPath)
    if (readOnly !== undefined) return { kept: `Mousse may not delete the files in ${readOnly || 'its top folder'}, so the worktree stays in the trash. Make that folder writable to let it be deleted.` }
    // What `lstat` says of every entry is read before the capture reads any bytes: a write from then on changes it, and
    // the check right before the delete state is recorded sees that. Each file is read once here, by the capture.
    let signature: FolderSignature
    try { signature = await folderSignatureAsync(trashPath, true) }
    catch (error) { return { kept: `Kept in the trash at ${trashPath}: ${(error as Error).message}` } }
    const first = await this.captureTrashed(manifestPath, manifest, record)
    if ('kept' in first) return first
    options.afterCapture?.(trashPath)
    const changed = async (): Promise<{ kept: string; waiting: true }> => {
      const retaken = await this.captureTrashed(manifestPath, manifest, record)
      return { kept: `Files in it changed while it was being deleted${'kept' in retaken ? `; ${retaken.kept}` : '; they are kept as a snapshot'}. It is looked at again on the next run.`, waiting: true }
    }
    // HEAD and Git's own data are read again and compared with the capture; a change since is captured and the delete waits.
    if (await this.adminStateAt(trashPath, manifest.commonDir) !== first.admin) return await changed()
    const adminDir = await this.adminDirOf(trashPath, manifest.commonDir)
    const lease = await this.readRepositoryLease()
    const deletingPath = join(dirname(trashPath), `.deleting-${randomBytes(8).toString('hex')}`)
    // With nothing awaited in between: the repository lease is still held, the record is still the one this pass read,
    // Git has no lock on the worktree, nothing in the folder changed since its `lstat`s were read before the capture, and
    // then the `deleting` state is recorded with the proof the capture wrote, before the folder moves. A crash after this
    // finds the folder at one of its two names.
    let locked: string | undefined
    try {
      this.store.withGate(manifest.taskId, () => {
        this.assertRepositoryLease(manifest.commonDir, manifest.repositoryId, lease)
        this.assertTrashRecord(manifestPath, record)
        locked = lockReasonSync(adminDir)
        if (locked !== undefined) return
        assertFolderUnchanged(trashPath, signature, first.content, true)
        manifest.state = 'deleting'
        manifest.deleting = { path: deletingPath, startedAt: new Date(now).toISOString(), adminState: first.admin }
        atomicWriteJsonSync(manifestPath, manifest)
        record.text = JSON.stringify(manifest)
      })
    } catch (error) {
      if (error instanceof FolderChanged) return await changed()
      throw error
    }
    if (locked !== undefined) return { kept: lockedText(locked, trashPath) }
    try { await renameFolderAsync(trashPath, deletingPath) }
    catch (error) {
      // Nothing moved: the folder waits in the trash as it was (on Windows, a file or folder in it is held open).
      manifest.state = 'trashed'; delete manifest.deleting; this.saveTrashed(manifestPath, manifest, record)
      return { kept: `Files in this worktree are in use (${(error as Error).message.split(/\r?\n/)[0]})` }
    }
    options.afterRename?.(deletingPath)
    return await this.continueDeleting(manifestPath, manifest, record, options, false)
  }
  /**
   * Carries on with a worktree in the `deleting` state, from what is on disk and in the record, never by replaying a step:
   * - the folder is at its `.deleting-` name: it is compared with the proof and deleted entry by entry (`deleteRenamed`);
   * - it is still at its trash path (the process stopped between recording the state and the rename): it goes back to
   *   `trashed`, as it was;
   * - it is at neither: only Git's registration of it is left, and it is unregistered.
   * `patient`: after a write was found in it, wait `WORKTREE_TRASH_QUIET_MS` from then before deleting again.
   */
  private async continueDeleting(manifestPath: string, manifest: WorktreeReconstructionManifest, record: { text: string }, options: ExpireOptions, patient: boolean): Promise<{ removed: true } | { kept: string; waiting?: true; readOnly?: true }> {
    const deleting = manifest.deleting!
    const trashPath = manifest.trashPath!
    await assertLifecyclePathAsync(join(this.store.profileHome, 'trash'), deleting.path)
    if (!await exists(deleting.path)) {
      if (await exists(trashPath)) {
        if (!(await lstat(join(trashPath, '.git')).catch(() => undefined))?.isFile()) return { kept: `Files were written at ${trashPath} after the worktree there was deleted; they are kept, and so is Git's registration of the worktree` }
        manifest.state = 'trashed'; delete manifest.deleting; this.saveTrashed(manifestPath, manifest, record)
        return { kept: 'Waiting in the trash', waiting: true }
      }
      return await this.unregisterDeleted(manifestPath, manifest, record)
    }
    const now = options.now ?? Date.now()
    if (patient && deleting.changedAt && now - Date.parse(deleting.changedAt) < WORKTREE_TRASH_QUIET_MS) return { kept: 'Files in it changed while it was being deleted; what is left is deleted once nothing has changed in it for an hour', waiting: true }
    // A lock Git was given after the rename: nothing more is deleted, and it is named.
    const locked = await this.lockOf(manifest.commonDir, trashPath)
    if (locked !== undefined) return { kept: lockedText(locked, trashPath) }
    await this.verifyPins(manifest)
    const stopped = await this.deleteRenamed(manifestPath, manifest, record, options)
    if (stopped) return stopped
    return await this.unregisterDeleted(manifestPath, manifest, record)
  }
  /**
   * Deletes the renamed folder against the proof (`content`). It is walked first (an entry already gone was deleted before
   * a crash, and its bytes are in the proof) and every entry's kind, size and mode compared with the proof, and the
   * identity of every folder from the trash down is recorded. Then, deepest first, each file and link is read and proven
   * again against the proof (`proveFrozenContentEntryAsync`) and, with nothing awaited from its last check to the
   * `unlink`, removed; each folder goes with a plain `rmdir`, which fails when anything new appeared in it. Right before
   * each removal the repository lease must still be held, and every folder from the trash down to it must be the very
   * folder recorded, and no link: a folder swapped for a link, or moved away, stops the delete, so no removal is ever
   * redirected outside the trash. Node has no `unlinkat`, so a deliberate swap between that check and the system call
   * remains possible in principle; an accidental redirection does not.
   * Git's own data and HEAD are compared, and captured again on top of the earlier capture when they changed, while the
   * `.git` file is still there; the `.git` file goes last, then the folder itself. A folder whose `.git` file is gone
   * already (a crash or a file in use right after it went) is no checkout any more: no Git runs in it, and the rest goes.
   * Returns why it stopped, or undefined when the folder is gone.
   */
  private async deleteRenamed(manifestPath: string, manifest: WorktreeReconstructionManifest, record: { text: string }, options: ExpireOptions): Promise<{ kept: string; waiting?: true; readOnly?: true } | undefined> {
    const root = manifest.deleting!.path
    const trash = join(this.store.profileHome, 'trash')
    const proof = new Map(manifest.content.map((entry) => [entry.path, entry]))
    const folders = new Map<string, string>()
    let current: ContentEntry[]
    try {
      for (let at = dirname(root); ; at = dirname(at)) { folders.set(resolve(at), identityOf(await lstat(at))); if (same(at, trash) || dirname(at) === at) break }
      current = (await walkOwnedContentAsync(root, true, { digests: false, folders })).map((entry) => beforeMadeWritable(entry, options))
    } catch (error) { return { kept: `Kept in the trash at ${root}: ${(error as Error).message}` } }
    // The bytes are compared file by file below, right before each one goes; here, what every entry is.
    if (current.some((entry) => !sameShape(entry, proof.get(entry.path)))) return await this.addLateWrites(manifestPath, manifest, record, options)
    const dotGit = join(root, '.git')
    const gitFile = await lstat(dotGit).catch(() => undefined)
    if (gitFile && !gitFile.isFile()) return await this.addLateWrites(manifestPath, manifest, record, options)
    const lease = await this.readRepositoryLease()
    this.store.withGate(manifest.taskId, () => {
      this.assertRepositoryLease(manifest.commonDir, manifest.repositoryId, lease)
      this.assertTrashRecord(manifestPath, record)
    })
    const gone = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
    /** Right before a removal, synchronously: the lease is still held and the folders down to `folder` are the ones recorded. */
    const check = (held: Awaited<ReturnType<WorktreeRetirementService['readRepositoryLease']>>, folder: string): void => {
      try { this.assertRepositoryLease(manifest.commonDir, manifest.repositoryId, held) } catch { throw new LeaseLost() }
      assertFoldersUnchanged(trash, folder, folders)
    }
    const heldNow = (): Promise<Awaited<ReturnType<WorktreeRetirementService['readRepositoryLease']>>> => this.readRepositoryLease().catch(() => undefined)
    let removing = root
    try {
      for (const entry of [...current].reverse()) {
        if (!entry.path) continue
        const path = join(root, entry.path)
        removing = path
        if (entry.kind === 'directory') {
          options.beforeRemove?.(path)
          const held = await heldNow()
          check(held, path)
          try { rmdirSync(path) } catch (error) { if (!gone(error)) throw error }
          continue
        }
        let frozen: FrozenEntryProof
        try { frozen = await proveFrozenContentEntryAsync(root, proof.get(entry.path)!) } catch (error) { if (gone(error)) continue; throw error }
        options.beforeRemove?.(path)
        const held = await heldNow()
        // From here to the unlink nothing is awaited.
        check(held, dirname(path))
        try { assertFrozenEntryUnchanged(frozen); unlinkSync(path) } catch (error) { if (!gone(error)) throw error }
      }
      removing = root
      if (gitFile) {
        if (await this.adminStateAt(root, manifest.commonDir) !== manifest.deleting!.adminState) await this.recaptureAdmin(manifestPath, manifest, record, root)
        options.beforeRemove?.(dotGit)
        const held = await heldNow()
        check(held, root)
        if (!lstatSync(dotGit).isFile()) throw new FolderChanged()
        unlinkSync(dotGit)
      }
      options.beforeRemove?.(root)
      const held = await heldNow()
      check(held, root)
      rmdirSync(root)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (error instanceof LeaseLost) return { kept: `Mousse lost hold of the repository while deleting the worktree from the trash; what is left of it waits at ${root} and is deleted on a later run` }
      if (code && IN_USE_CODES.has(code)) return { kept: `Files in this worktree are in use; what is left of it waits at ${root} and is deleted on a later run` }
      // A folder whose permissions do not let Mousse delete its files: the delete stops there, and a restore rebuilds
      // the worktree from the proof (`reconstruct` makes the folders of what is left writable first).
      if (code === 'EACCES' || code === 'EPERM') return { kept: `Mousse may not delete files in ${relative(root, dirname(removing)) || 'its top folder'}; what is left of the worktree waits at ${root}. Make that folder writable to let it be deleted.`, readOnly: true }
      // A folder swapped for a link right before a file in it was read is a change of kind like any other.
      if (error instanceof FolderChanged || code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR' || /^Frozen content (changed|was replaced)/.test((error as Error).message) || /^Lifecycle path is a link/.test((error as Error).message)) return await this.addLateWrites(manifestPath, manifest, record, options)
      throw error
    }
    return undefined
  }
  /**
   * A write was found in the folder while it was being deleted: what differs from the proof is added to it (a kept copy of
   * the files, the new digests, and the folders), the earlier versions staying where they are, and the delete stops.
   * The newer form of a path wins: when a path changed kind (a file became a folder, a folder a link), the proof's earlier
   * entry for it and everything under it leave the proof, and on a volume that does not tell case apart another spelling
   * of a path is the same path, and the newer spelling stays. Their bytes stay in the snapshot and the earlier copies.
   * Nothing is deleted here; what is left of the folder waits for the next run.
   */
  private async addLateWrites(manifestPath: string, manifest: WorktreeReconstructionManifest, record: { text: string }, options: ExpireOptions): Promise<{ kept: string; waiting?: true }> {
    const root = manifest.deleting!.path
    const changedAt = new Date(options.now ?? Date.now()).toISOString()
    const stop = (kept: string): { kept: string; waiting: true } => {
      manifest.deleting!.changedAt = changedAt; this.saveTrashed(manifestPath, manifest, record)
      return { kept, waiting: true }
    }
    // Without its `.git` file the folder is no checkout any more, and Git run in it would look for one above it.
    if (!(await lstat(join(root, '.git')).catch(() => undefined))?.isFile()) return stop(`Files were written into ${root} as it was being deleted; they are kept there`)
    let current: ContentEntry[]
    try { current = (await walkOwnedContentAsync(root, true)).map((entry) => beforeMadeWritable(entry, options)) }
    catch (error) { return stop(`Kept in the trash at ${root}: ${(error as Error).message}`) }
    const proof = new Map(manifest.content.map((entry) => [entry.path, entry]))
    const late = current.filter((entry) => !sameEntry(entry, proof.get(entry.path)))
    const fold = await caseInsensitiveAt(root) ? (path: string): string => path.toLowerCase() : (path: string): string => path
    const spellings = new Map<string, string[]>()
    for (const path of proof.keys()) spellings.set(fold(path), [...(spellings.get(fold(path)) ?? []), path])
    const gone: string[] = []
    // Shallowest first, so a folder's change is settled before its entries are added.
    for (const entry of [...late].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
      if (!entry.path) continue
      for (const path of spellings.get(fold(entry.path)) ?? []) {
        const old = proof.get(path)
        if (!old || path === entry.path && old.kind === entry.kind) continue
        proof.delete(path)
        // The earlier form leaves the copy's index too, so Git does not keep the old name beside the new one.
        if (path !== entry.path) gone.push(path)
        const inside = [...proof.keys()].filter((inner) => fold(inner).startsWith(`${fold(path)}/`))
        if (old.kind !== entry.kind) {
          for (const inner of inside) { proof.delete(inner); gone.push(inner) }
        } else if (old.kind === 'directory') {
          // The same folder spelled anew: what the proof holds under it keeps its bytes, under the new spelling.
          for (const inner of inside) { const value = proof.get(inner)!; proof.delete(inner); gone.push(inner); const moved = `${entry.path}${inner.slice(path.length)}`; if (!proof.has(moved)) proof.set(moved, { ...value, path: moved }) }
        }
      }
    }
    const files = late.filter((entry) => entry.kind !== 'directory').map((entry) => entry.path)
    // Folders go in the layer too, so a rebuild makes them in order with the files: a file that became an empty folder
    // has nothing else to say so.
    const folders = late.filter((entry) => entry.kind === 'directory' && entry.path).map((entry) => entry.path)
    if (files.length) {
      const copy = await this.keepFiles(root, manifest, files, late, gone)
      if ('kept' in copy) return stop(copy.kept)
      await this.pinKept(root, manifest, copy.sha!)
      manifest.keptFiles = [...(manifest.keptFiles ?? []), { ...copy, ...(folders.length ? { folders } : {}) }]
    } else if (folders.length) manifest.keptFiles = [...(manifest.keptFiles ?? []), { paths: [], folders }]
    for (const entry of late) proof.set(entry.path, entry)
    manifest.content = [...proof.values()]
    return stop('Files in it changed while it was being deleted; the changes are kept with its other files, and what is left is deleted on a later run')
  }
  /** The folder is gone: Git's registration of it at its trash path goes, with Git's own data of it, which is kept. */
  private async unregisterDeleted(manifestPath: string, manifest: WorktreeReconstructionManifest, record: { text: string }): Promise<{ removed: true } | { kept: string }> {
    const trashPath = manifest.trashPath!
    // Git unregisters a worktree whose folder is gone; one at that path again would be someone's new files, and is kept.
    if (await exists(trashPath)) return { kept: `Files were written at ${trashPath} after the worktree there was deleted; they are kept, and so is Git's registration of the worktree` }
    if (await this.registeredAt(manifest.commonDir, trashPath)) {
      // Git refuses to unregister a locked worktree without `--force`, which is never used: the lock is named instead.
      const locked = await this.lockOf(manifest.commonDir, trashPath)
      if (locked !== undefined) return { kept: lockedText(locked, trashPath) }
      const lease = await this.readRepositoryLease()
      try { await lifecycleGitAsync(manifest.commonDir, ['worktree', 'remove', trashPath], undefined, undefined, undefined, () => { try { this.assertRepositoryLease(manifest.commonDir, manifest.repositoryId, lease) } catch { throw new LeaseLost() } }) }
      catch (error) { if (error instanceof LeaseLost) return { kept: 'Mousse lost hold of the repository before Git could unregister the worktree deleted from the trash; a later run does it' }; throw error }
    }
    if (await this.registeredAt(manifest.commonDir, trashPath)) throw new Error('Git still registers the worktree deleted from the trash')
    manifest.state = 'retired'; delete manifest.trashPath; delete manifest.trashedAt; delete manifest.deleting
    this.saveTrashed(manifestPath, manifest, record)
    await this.releaseBranches(manifest); this.saveTrashed(manifestPath, manifest, record)
    return { removed: true }
  }
  /** Why Git has the worktree registered at `path` locked (an empty reason for a lock without one), or undefined. */
  private async lockOf(commonDir: string, path: string): Promise<string | undefined> {
    let inBlock = false
    for (const line of (await lifecycleReadAsync(commonDir, ['worktree', 'list', '--porcelain'])).split(/\r?\n/)) {
      if (line.startsWith('worktree ')) inBlock = same(line.slice(9), path)
      else if (inBlock && (line === 'locked' || line.startsWith('locked '))) return line.slice('locked'.length).trim()
    }
    return undefined
  }
  /** HEAD and Git's own data of a worktree, as one value to compare (see `adminStateOf`). */
  private async adminStateAt(folder: string, commonDir: string): Promise<string> {
    try { return adminStateOf(await lifecycleReadAsync(folder, ['rev-parse', 'HEAD']), adminDigest(await readAdminFilesAsync(await this.adminDirOf(folder, commonDir)))) }
    catch (error) { return `unreadable: ${(error as Error).message}` }
  }
  /**
   * Git's own data of the worktree changed while its folder was being deleted (a commit through a shell still in it, say):
   * it is captured again as a commit on top of the earlier capture, and every commit it names gets a pin.
   */
  private async recaptureAdmin(manifestPath: string, manifest: WorktreeReconstructionManifest, record: { text: string }, folder: string): Promise<void> {
    const admin = await this.storeAdmin(folder, manifest.commonDir, manifest.adminCommit)
    const head = await lifecycleReadAsync(folder, ['rev-parse', 'HEAD'])
    const pinned = [manifest.baseSha, manifest.resultSha, ...(manifest.snapshotSha ? [manifest.snapshotSha] : []), ...(manifest.keptRefs ?? []).map((ref) => ref.slice(ref.lastIndexOf('/') + 1))]
    for (const sha of await this.uncontainedTips(manifest.commonDir, [...new Set([...admin.commits, head])], pinned)) await this.pinKept(folder, manifest, sha)
    this.saveTrashed(manifestPath, manifest, record)
    const adminRef = `${manifest.resultRef.slice(0, -'/result'.length)}/admin`
    if (admin.commit !== admin.previous) await lifecycleGitAsync(manifest.commonDir, ['update-ref', '--no-deref', adminRef, admin.commit, admin.previous ?? '0'.repeat(admin.commit.length)])
    Object.assign(manifest, { adminTree: admin.tree, adminCommit: admin.commit, adminRef })
    manifest.deleting!.adminState = adminStateOf(head, admin.digest)
    this.saveTrashed(manifestPath, manifest, record)
  }
  /** Pins `sha` under `<prefix>/kept/<sha>`, created and never moved, and lists it in `keptRefs`. */
  private async pinKept(cwd: string, manifest: WorktreeReconstructionManifest, sha: string): Promise<void> {
    const ref = `${manifest.resultRef.slice(0, -'/result'.length)}/kept/${sha}`
    if (await readDirectLifecycleRefAsync(cwd, ref) !== sha) await lifecycleGitAsync(cwd, ['update-ref', '--no-deref', ref, sha, '0'.repeat(sha.length)])
    manifest.keptRefs = [...new Set([...(manifest.keptRefs ?? []), ref])]
  }
  /**
   * Keeps `paths` of the folder at `top` in a kept copy owned by the thread's journal (`keepCopy`, the same store Discard
   * uses, with its byte cap) and checks that what the copy read of each is the bytes `proof` names: a file written between
   * the two reads differs, and keeps the folder. `gone` are paths no longer there, left out of the copy. Writes no pin.
   */
  private async keepFiles(top: string, manifest: WorktreeReconstructionManifest, paths: string[], proof: readonly ContentEntry[], gone: readonly string[] = []): Promise<{ sha: string; paths: string[] } | { kept: string }> {
    let copy: Awaited<ReturnType<typeof keepCopy>>
    try { copy = await keepCopy({ owner: this.store.require(manifest.taskId).location, top, operationType: 'worktree-cleanup', action: 'Deleting it from the trash', paths, ...(gone.length ? { gone } : {}) }) }
    catch (error) { return { kept: `Kept in the trash at ${top}: ${(error as Error).message.split(/\r?\n/)[0]}` } }
    const expected = new Map(proof.map((entry) => [entry.path, entry]))
    for (const path of paths) if (copy.digests.get(path) !== expected.get(path)?.digest) return { kept: `Kept in the trash at ${top}: ${path} changed while its copy was being kept` }
    return { sha: copy.sha, paths }
  }
  /** The bytes and mode `commit` holds for each of `paths` that it has. */
  private async keptBlobs(commonDir: string, commit: string, paths: readonly string[]): Promise<Map<string, { mode: string; bytes: Buffer }>> {
    const wanted = new Set(paths)
    const rows = (await lifecycleReadAsync(commonDir, ['ls-tree', '-r', '-z', commit], undefined, LISTING_MAX_BUFFER)).split('\0').filter(Boolean).flatMap((line) => {
      const tab = line.indexOf('\t'), [mode, type, sha] = line.slice(0, tab).split(' '), path = line.slice(tab + 1)
      return type === 'blob' && wanted.has(path) ? [{ mode: mode!, sha: sha!, path }] : []
    })
    const blobs = await this.catBlobs(commonDir, rows.map((row) => row.sha))
    return new Map(rows.map((row, index) => [row.path, { mode: row.mode, bytes: blobs[index]! }]))
  }
  /** The bytes of each blob, in order. */
  private async catBlobs(commonDir: string, ids: readonly string[]): Promise<Buffer[]> {
    if (!ids.length) return []
    const argv = await withoutRepoProgramsAsync(commonDir, ['cat-file', '--batch'])
    const ran = await runGitProcess(argv, { cwd: commonDir, env: repoProgramEnv({ ...process.env, ...READ_ONLY_GIT_ENV }), input: ids.map((id) => `${id}\n`).join(''), timeout: 30_000, maxBuffer: 600 * 1024 * 1024 })
    if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
    const out: Buffer[] = []
    let offset = 0
    for (const id of ids) {
      const headerEnd = ran.stdoutBytes.indexOf(10, offset)
      const [sha, type, size] = ran.stdoutBytes.subarray(offset, headerEnd).toString('utf8').split(' ')
      if (headerEnd < 0 || sha !== id || type !== 'blob' || !/^\d+$/.test(size ?? '')) throw new Error('Kept files are unreadable')
      out.push(ran.stdoutBytes.subarray(headerEnd + 1, headerEnd + 1 + Number(size)))
      offset = headerEnd + 1 + Number(size) + 1
    }
    return out
  }
  /**
   * Writes one layer of `keptFiles` into the new checkout: its folders, shallowest first, then the files its kept copy
   * holds, as the copy holds them. What is in the way of a newer form is cleared by `rebuild`, which never deletes what
   * it did not write.
   */
  private async writeKeptFiles(manifest: WorktreeReconstructionManifest, layer: { sha?: string; paths: string[]; folders?: string[] }, rebuild: Rebuild): Promise<void> {
    for (const folder of [...layer.folders ?? []].sort((a, b) => a.split('/').length - b.split('/').length)) await rebuild.folder(folder.split('/'))
    if (!layer.sha) return
    const stored = await this.keptBlobs(manifest.commonDir, layer.sha, layer.paths)
    for (const path of layer.paths) {
      const file = stored.get(path)
      if (!file) throw new Error(`The kept copy of ${path} is missing`)
      const parts = path.split('/'), name = parts.pop()!
      const parent = await rebuild.folder(parts)
      await assertLifecyclePathAsync(manifest.worktreePath, parent)
      const kind = file.mode === '120000' ? 'link' : 'file'
      const target = await rebuild.place(parent, name, kind)
      if (kind === 'link') await symlink(file.bytes.toString('utf8'), target)
      else await writeFile(target, file.bytes)
      rebuild.record(target, kind, file.bytes)
    }
  }
  /**
   * The rebuild of a retired worktree: what it may clear is what the checkout and snapshot wrote (each compared with the
   * tree's bytes as checked out, or an auxiliary payload) and what it wrote itself; anything else is kept as a copy owned
   * by the thread's journal first (`keptAside`).
   */
  private async rebuildOf(manifest: WorktreeReconstructionManifest): Promise<Rebuild> {
    let tree: Map<string, { mode: string; sha: string }> | undefined
    const auxiliary = new Map(manifest.auxiliary.map((entry) => [entry.path, Buffer.from(entry.content, 'base64')]))
    const fromCheckout = async (rel: string, kind: 'file' | 'link', bytes: Buffer): Promise<boolean> => {
      const payload = auxiliary.get(rel)
      if (payload) return kind === 'file' && payload.equals(bytes)
      tree ??= new Map((await lifecycleReadAsync(manifest.worktreePath, ['ls-tree', '-r', '-z', manifest.snapshotTree ?? manifest.treeSha], undefined, LISTING_MAX_BUFFER)).split('\0').filter(Boolean).map((line) => {
        const tab = line.indexOf('\t'), [mode, , sha] = line.slice(0, tab).split(' ')
        return [line.slice(tab + 1), { mode: mode!, sha: sha! }]
      }))
      const entry = tree.get(rel)
      if (!entry || (entry.mode === '120000') !== (kind === 'link')) return false
      if (kind === 'link') return (await this.catBlobs(manifest.commonDir, [entry.sha]))[0]!.equals(bytes)
      // The bytes the checkout wrote: the blob as checked out, through the worktree's own attributes.
      const argv = await withoutRepoProgramsAsync(manifest.worktreePath, ['cat-file', '--batch', '--filters', '-Z'])
      const ran = await runGitProcess(argv, { cwd: manifest.worktreePath, env: repoProgramEnv(), input: `${entry.sha} ${rel}\0`, timeout: 30_000, maxBuffer: 600 * 1024 * 1024 })
      if (ran.error || ran.status !== 0) return false
      const headerEnd = ran.stdoutBytes.indexOf(0)
      return headerEnd > 0 && ran.stdoutBytes.subarray(headerEnd + 1, ran.stdoutBytes.length - 1).equals(bytes)
    }
    const keep = async (rels: string[]): Promise<ReadonlyMap<string, string>> => {
      let copy: Awaited<ReturnType<typeof keepCopy>>
      try { copy = await keepCopy({ owner: this.store.require(manifest.taskId).location, top: manifest.worktreePath, operationType: 'worktree-cleanup', action: 'Rebuilding the worktree', paths: rels }) }
      catch (error) { throw new Error(`Files appeared in the worktree while it was rebuilt, in the way of its own files, and no copy of them could be kept (${(error as Error).message.split(/\r?\n/)[0]}); nothing of them was deleted: ${rels.join(', ')}`) }
      manifest.keptAside = [...(manifest.keptAside ?? []), { ref: copy.ref, paths: rels }]
      return copy.digests
    }
    return new Rebuild(manifest.worktreePath, await caseInsensitiveAt(manifest.worktreePath), fromCheckout, keep)
  }
  /**
   * Takes a snapshot of the folder in the trash and pins it in place of the earlier pins (`result` at its HEAD,
   * `snapshot` when it has uncommitted files), recording both in the manifest. What a snapshot cannot hold keeps it.
   */
  private async captureTrashed(manifestPath: string, manifest: WorktreeReconstructionManifest, record: { text: string }): Promise<{ content: ContentEntry[]; admin: string } | { kept: string }> {
    const trashPath = manifest.trashPath!
    const head = await lifecycleReadAsync(trashPath, ['rev-parse', 'HEAD'])
    const treeSha = await lifecycleReadAsync(trashPath, ['rev-parse', 'HEAD^{tree}'])
    const snapshot = await lifecycleReadAsync(trashPath, ['status', '--porcelain=v1', '--untracked-files=all'], undefined, LISTING_MAX_BUFFER) ? await takeSnapshotAsync(trashPath, { reason: 'trash expiry', threadId: manifest.taskId }) : undefined
    const dirty = Boolean(snapshot && snapshot.tree !== treeSha)
    let inspected: Awaited<ReturnType<WorktreeRetirementService['inspectContent']>>
    try { inspected = await this.inspectContent(trashPath, dirty ? snapshot!.tree : undefined, { collectUncaptured: true }) }
    catch (error) { return { kept: `Kept in the trash at ${trashPath}: ${(error as Error).message}` } }
    const contents = { content: inspected.content, auxiliary: inspected.auxiliary, ...(inspected.sparse ? { sparse: inspected.sparse } : {}) }
    // Files the snapshot cannot hold (ignored ones) go into a kept copy, checked against the proof, before Git's own data
    // is read: the copy's private index is written in that folder while it is made, and removed again.
    let kept: { sha: string; paths: string[] } | undefined
    if (inspected.uncaptured.length) {
      const copy = await this.keepFiles(trashPath, manifest, inspected.uncaptured, inspected.content)
      if ('kept' in copy) return copy
      kept = copy
    }
    const prefix = manifest.resultRef.slice(0, -'/result'.length)
    const adminRef = `${prefix}/admin`
    // Git's own data of the worktree is stored first, as objects only: what cannot be kept keeps the folder, with no pin moved.
    let admin: Awaited<ReturnType<WorktreeRetirementService['storeAdmin']>>
    try { admin = await this.storeAdmin(trashPath, manifest.commonDir, await readDirectLifecycleRefAsync(trashPath, adminRef)) }
    catch (error) { return { kept: `Kept in the trash at ${trashPath}: Git's own data of it could not be kept (${(error as Error).message.split(/\r?\n/)[0]})` } }
    const pinKept = (sha: string): Promise<void> => this.pinKept(trashPath, manifest, sha)
    // A pin is never replaced by one that does not contain it: the earlier commit or snapshot stays under a ref of its own.
    const keepPin = async (old: string | undefined, next: string): Promise<void> => {
      if (!old || old === next || await gitSucceeds(trashPath, ['merge-base', '--is-ancestor', old, next])) return
      await pinKept(old)
    }
    const previousSnapshot = await readDirectLifecycleRefAsync(trashPath, `${prefix}/snapshot`)
    await keepPin(manifest.resultSha, head)
    if (dirty) await keepPin(previousSnapshot, snapshot!.sha)
    // Every commit the worktree's HEAD history and its own refs name stays: the pins above may already hold it; otherwise
    // the newest of them that holds it gets a kept pin, so Git's garbage collection never takes a commit only they named.
    const pinned = [manifest.baseSha, head, ...(dirty ? [snapshot!.sha] : []), ...(previousSnapshot ? [previousSnapshot] : []), ...(manifest.keptRefs ?? []).map((ref) => ref.slice(ref.lastIndexOf('/') + 1))]
    for (const sha of await this.uncontainedTips(manifest.commonDir, admin.commits, pinned)) await pinKept(sha)
    if (kept) await pinKept(kept.sha)
    this.saveTrashed(manifestPath, manifest, record)
    await lifecycleGitAsync(trashPath, ['update-ref', '--no-deref', manifest.resultRef, head, manifest.resultSha])
    if (dirty) await lifecycleGitAsync(trashPath, ['update-ref', '--no-deref', `${prefix}/snapshot`, snapshot!.sha, previousSnapshot ?? '0'.repeat(snapshot!.sha.length)])
    if (admin.commit !== admin.previous) await lifecycleGitAsync(trashPath, ['update-ref', '--no-deref', adminRef, admin.commit, admin.previous ?? '0'.repeat(admin.commit.length)])
    const headBranch = await lifecycleReadAsync(trashPath, ['branch', '--show-current'])
    // A clean folder drops the snapshot fields; an earlier snapshot ref stays where it is, as every pin does.
    // So does an earlier kept copy: its pin stays, and this capture's copy holds the files the folder has now.
    delete manifest.snapshotSha; delete manifest.snapshotTree; delete manifest.snapshotRef; delete manifest.headBranch; delete manifest.sparse; delete manifest.keptFiles
    Object.assign(manifest, { resultSha: head, treeSha, ...(dirty ? { snapshotSha: snapshot!.sha, snapshotTree: snapshot!.tree, snapshotRef: `${prefix}/snapshot` } : {}), ...(headBranch ? { headBranch } : {}), ...contents, ...(kept ? { keptFiles: [kept] } : {}), adminTree: admin.tree, adminCommit: admin.commit, adminRef })
    this.saveTrashed(manifestPath, manifest, record)
    await this.verifyPins(manifest)
    // What the snapshot holds, not a read of the folder now: `inspectContent` read every entry after the snapshot and proved
    // each against it, so a write made since then (during the waits above) differs from this and is never deleted unseen.
    return { content: contents.content, admin: adminStateOf(head, admin.digest) }
  }
  /** The administration folder of a linked worktree: `<common>/worktrees/<name>`, never anything else. */
  private async adminDirOf(worktreePath: string, commonDir: string): Promise<string> {
    const adminDir = await realpathLikeSync(resolve(worktreePath, await lifecycleReadAsync(worktreePath, ['rev-parse', '--git-dir'])))
    if (!same(dirname(adminDir), join(commonDir, 'worktrees'))) throw new Error('The worktree has no administration folder of its own')
    return adminDir
  }
  /**
   * Stores the files of the worktree's administration folder (see `worktreeAdminData.ts`) as a tree, each blob proven to
   * be the bytes that were read, and a commit of it on top of `previous` (reused when its tree is the same). Returns the
   * commits the folder's reflogs and refs name, and what the files hold, to compare before the delete. Writes no ref.
   */
  private async storeAdmin(trashPath: string, commonDir: string, previous: string | undefined): Promise<{ tree: string; commit: string; previous?: string; digest: string; commits: string[] }> {
    const adminDir = await this.adminDirOf(trashPath, commonDir)
    const files = await readAdminFilesAsync(adminDir)
    const format = await lifecycleReadAsync(commonDir, ['rev-parse', '--show-object-format'])
    const blobs = new Map<string, string>()
    const regular = files.filter((file) => file.mode !== '120000')
    if (regular.some((file) => /[\r\n]/.test(file.path))) throw new Error('A file name Git cannot be given on a line')
    // Git reads the files again: each blob it stores must be the bytes read above, or the folder changed meanwhile.
    const ids = regular.length ? (await lifecycleGitAsync(commonDir, ['hash-object', '-w', '--no-filters', '--stdin-paths'], regular.map((file) => join(adminDir, file.path)).join('\n') + '\n')).split('\n') : []
    for (const [index, file] of regular.entries()) blobs.set(file.path, ids[index]!)
    for (const file of files.filter((entry) => entry.mode === '120000')) blobs.set(file.path, await lifecycleGitAsync(commonDir, ['hash-object', '-w', '--stdin'], file.bytes.toString('utf8')))
    for (const file of files) if (blobs.get(file.path) !== blobId(file.bytes, format)) throw new Error('Its files changed while they were read')
    const tree = await this.writeAdminTree(commonDir, files, blobs)
    const reuse = previous && await lifecycleReadAsync(commonDir, ['rev-parse', `${previous}^{tree}`]).catch(() => undefined) === tree
    const commit = reuse ? previous : await lifecycleGitAsync(commonDir, ['commit-tree', tree, ...(previous ? ['-p', previous] : []), '-m', "mousse: Git's own data of a retired worktree"], undefined, undefined, MOUSSE_COMMIT_ENV)
    // The worktree's own refs as Git lists them too, so a ref store other than plain files is covered as well.
    const listed = (await lifecycleReadAsync(trashPath, ['for-each-ref', '--format=%(objectname)', 'refs/worktree/', 'refs/bisect/', 'refs/rewritten/'])).split('\n')
    const named = [...new Set([...adminObjectIds(files), ...listed.filter((sha) => /^[a-f0-9]{40,64}$/.test(sha))])]
    const types = named.length ? (await lifecycleReadAsync(commonDir, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], named.join('\n') + '\n')).split('\n') : []
    const commits = types.map((line) => line.split(' ')).filter(([sha, type]) => type === 'commit' && named.includes(sha!)).map(([sha]) => sha!)
    return { tree, commit, ...(previous ? { previous } : {}), digest: adminDigest(files), commits }
  }
  /** A tree of the kept files, one `mktree` per folder. */
  private async writeAdminTree(commonDir: string, files: readonly AdminFile[], blobs: ReadonlyMap<string, string>): Promise<string> {
    const write = async (prefix: string): Promise<string> => {
      const rows: string[] = []
      const folders = new Set<string>()
      for (const file of files) {
        if (prefix && !file.path.startsWith(`${prefix}/`)) continue
        const rest = prefix ? file.path.slice(prefix.length + 1) : file.path
        const slash = rest.indexOf('/')
        if (slash < 0) rows.push(`${file.mode} blob ${blobs.get(file.path)!}\t${rest}`)
        else folders.add(rest.slice(0, slash))
      }
      for (const folder of folders) rows.push(`040000 tree ${await write(prefix ? `${prefix}/${folder}` : folder)}\t${folder}`)
      return lifecycleGitAsync(commonDir, ['mktree', '-z'], rows.map((row) => `${row}\0`).join(''))
    }
    return write('')
  }
  /**
   * Of `commits`, the fewest that hold every one not already held by `pinned`: the independent tips of them (none an
   * ancestor of another), less those an existing pin contains. Pinning these keeps every commit in `commits`.
   */
  private async uncontainedTips(commonDir: string, commits: readonly string[], pinned: readonly string[]): Promise<string[]> {
    const held = new Set(pinned)
    const rest = commits.filter((sha) => !held.has(sha))
    if (!rest.length) return []
    const tips = rest.length === 1 ? rest : (await lifecycleReadAsync(commonDir, ['merge-base', '--independent', ...rest])).split('\n').filter(Boolean)
    const uncontained: string[] = []
    for (const tip of tips) {
      let contained = false
      for (const pin of held) if (await gitSucceeds(commonDir, ['merge-base', '--is-ancestor', tip, pin])) { contained = true; break }
      if (!contained) uncontained.push(tip)
    }
    return uncontained
  }
  /**
   * Writes Git's kept data of the worktree into the administration folder `git worktree add` just made, before anything
   * is checked out: its configuration then applies to the checkout. The files `replayedAdminFile` leaves out (the folder's
   * registration, locks, links, HEAD and the index) are never written. The kept HEAD history goes in front of what the
   * rebuild itself recorded. Configuration Mousse puts on an untrusted checkout is applied after this, over it.
   */
  private async restoreAdmin(manifest: WorktreeReconstructionManifest): Promise<void> {
    if (!manifest.adminTree) return
    const adminDir = await this.adminDirOf(manifest.worktreePath, manifest.commonDir)
    const entries = (await lifecycleReadAsync(manifest.commonDir, ['ls-tree', '-r', '-z', manifest.adminTree])).split('\0').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t'), [mode, type, sha] = line.slice(0, tab).split(' ')
      return { mode: mode!, type: type!, sha: sha!, path: line.slice(tab + 1) }
    }).filter((entry) => entry.type === 'blob' && replayedAdminFile(entry.path, entry.mode))
    if (!entries.length) return
    const blobs = await this.catBlobs(manifest.commonDir, entries.map((entry) => entry.sha))
    for (const [index, entry] of entries.entries()) {
      let bytes: Buffer = blobs[index]!
      const target = join(adminDir, entry.path)
      await assertLifecyclePathAsync(adminDir, target)
      await mkdir(dirname(target), { recursive: true })
      if (entry.path === HEAD_REFLOG) bytes = Buffer.concat([bytes, await readFile(target).catch(() => Buffer.alloc(0))])
      await writeFile(target, bytes)
      await chmod(target, entry.mode === '100755' ? 0o755 : 0o644)
    }
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
  /** Points Git's registration at the trash after a move that a crash interrupted. Idempotent. */
  private async settleTrashRegistration(manifest: WorktreeReconstructionManifest): Promise<void> {
    const trashPath = manifest.trashPath
    if (!trashPath || !await exists(join(trashPath, '.git')) || await this.registeredAt(manifest.commonDir, trashPath)) return
    await lifecycleGitAsync(manifest.commonDir, ['worktree', 'repair', trashPath])
  }
  /**
   * A permanent deletion the person confirmed, only: deletes the folder in the trash through Git, so its registration
   * goes with it. The trash expiry never uses this; it deletes against a proof (`deleteRenamed`).
   */
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
      await this.removeConfirmed(trashPath)
    }
    if (await exists(trashPath) || await this.registeredAt(manifest.commonDir, trashPath)) throw new Error('Git did not remove the worktree from the trash')
  }
  /**
   * A permanent deletion the person confirmed, only: deletes a folder in the trash entry by entry, deepest first, links
   * never followed, a worktree's `.git` file last. Every entry and every folder from the trash down is identified when
   * the folder is walked; right before each removal, each folder down to it must be the very one walked, and no link, and
   * the entry the very one walked, or nothing more is removed (as in `deleteRenamed`, a deliberate swap between that check
   * and the system call remains possible in principle). `beforeStart` runs right before the first removal. A file in use
   * stops it; the next pass of the permanent deletion carries on.
   */
  private async removeConfirmed(root: string, beforeStart?: () => void): Promise<void> {
    const trash = join(this.store.profileHome, 'trash')
    await assertLifecyclePathAsync(trash, root)
    const folders = new Map<string, string>()
    for (let at = dirname(root); ; at = dirname(at)) { folders.set(resolve(at), identityOf(await lstat(at))); if (same(at, trash) || dirname(at) === at) break }
    const paths: Array<{ path: string; folder: boolean; identity: string }> = []
    const visit = async (path: string, depth: number): Promise<void> => {
      if (depth > 64 || paths.length > 1_000_000) throw new Error('The folder in the trash is too deep or too large to delete entry by entry')
      const stat = await lstat(path)
      if (stat.isDirectory()) {
        folders.set(resolve(path), identityOf(stat))
        for (const name of (await readdir(path)).sort()) if (!(depth === 0 && name === '.git')) await visit(join(path, name), depth + 1)
      }
      if (path !== root) paths.push({ path, folder: stat.isDirectory(), identity: identityOf(stat) })
    }
    await visit(root, 0)
    const dotGit = join(root, '.git')
    const gitStat = await lstat(dotGit).catch(() => undefined)
    if (gitStat) {
      if (gitStat.isDirectory()) throw new Error('A repository of its own is in the trash; it is kept')
      paths.push({ path: dotGit, folder: false, identity: identityOf(gitStat) })
    }
    paths.push({ path: root, folder: true, identity: folders.get(resolve(root))! })
    beforeStart?.()
    for (const entry of paths) {
      try {
        assertFoldersUnchanged(trash, dirname(entry.path), folders)
        const stat = lstatSync(entry.path)
        if (identityOf(stat) !== entry.identity || stat.isDirectory() !== entry.folder || entry.folder && stat.isSymbolicLink()) throw new FolderChanged()
        if (entry.folder) rmdirSync(entry.path); else unlinkSync(entry.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        if (error instanceof FolderChanged) throw new Error(`Files in ${root} changed while it was being deleted; the rest of it is kept`)
        throw error
      }
    }
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
  /**
   * Gives the owner write permission on every folder of what is left of a delete in the trash, links never followed, and
   * records each folder's mode before and after in `changed`, by path below `root`.
   */
  private async makeRemnantWritable(root: string, changed: Map<string, { from: number; to: number }>): Promise<void> {
    const trash = join(this.store.profileHome, 'trash')
    const visit = async (path: string, rel: string, depth: number): Promise<void> => {
      const stat = await lstat(path)
      if (!stat.isDirectory() || depth > 64) return
      await assertLifecyclePathAsync(trash, path)
      if ((stat.mode & 0o200) === 0) {
        await chmod(path, (stat.mode & 0o7777) | 0o700)
        changed.set(rel, { from: changed.get(rel)?.from ?? stat.mode, to: (await lstat(path)).mode })
      }
      for (const name of await readdir(path)) await visit(join(path, name), rel ? `${rel}/${name}` : name, depth + 1)
    }
    await visit(root, '', 0)
  }
  /** {@link keptAsideNotice} of a rebuilt worktree, with its owner's Undo window. */
  keptAsideNotice(manifest: WorktreeReconstructionManifest): { id: string; text: string } | undefined {
    return manifest.keptAside?.length ? keptAsideNotice(manifest, keptCopyWindowMs(this.store.require(manifest.taskId).location)) : undefined
  }
  async reconstruct(manifestPath: string, untrusted?: { prepare(worktreePath: string): void | Promise<void>; env: NodeJS.ProcessEnv }): Promise<WorktreeReconstructionManifest> {
    const manifest = this.load(manifestPath)
    await this.checkOwnership(manifest.taskId, manifest.commonDir, manifest.repositoryId)
    this.store.withGate(manifest.taskId, () => this.verifySource(manifest))
    await this.verifyPins(manifest)
    // Being deleted from the trash: what is left of the folder is compared with the proof (a write found there is added to
    // it), deleted and unregistered first, so the worktree is rebuilt from the proof and nothing of the old one stays
    // registered. Never from the half-deleted folder.
    if (manifest.state === 'deleting') {
      const record = { text: JSON.stringify(manifest) }
      let outcome: { removed: true } | { kept: string; waiting?: true; readOnly?: true } | undefined
      const stopBeating = this.keepLeaseFresh()
      const madeWritable = new Map<string, { from: number; to: number }>()
      try {
        for (let attempt = 0; attempt < 3 && manifest.state === 'deleting'; attempt++) {
          try { outcome = await this.continueDeleting(manifestPath, manifest, record, { madeWritable }, false) }
          catch (error) { if (error instanceof TrashRecordChanged) throw new Error('The worktree record changed while it was being restored; try again'); throw error }
          // What is left is Mousse's own copy in its trash, and the proof holds its modes: its folders are made writable
          // so the delete can finish, and the rebuild gives each folder the mode the proof records.
          if (outcome && 'readOnly' in outcome) { await this.makeRemnantWritable(manifest.deleting!.path, madeWritable); continue }
          if (outcome && !('removed' in outcome) && !outcome.waiting) break
        }
      } finally { stopBeating() }
      if (manifest.state === 'deleting') throw new Error(`The worktree is still being deleted from the trash, so it cannot be rebuilt yet: ${outcome && 'kept' in outcome ? outcome.kept : 'try again'}`)
    }
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
      // Git's own data first, so its configuration is in place for the fingerprint check and the checkout.
      await this.restoreAdmin(manifest)
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
      // The uncommitted files come back as the snapshot held them, over the fresh checkout of the HEAD it was taken on;
      // then what the kept copies hold (ignored files, writes found while the folder was being deleted), in order.
      if (manifest.snapshotTree) await moveFilesAsync(manifest.worktreePath, manifest.treeSha, manifest.snapshotTree)
      // A later form of a path (another kind, or another spelling on a volume that folds case) clears the earlier one,
      // and only what the rebuild itself wrote is ever cleared.
      // Only what this rebuild sets aside is reported for it.
      delete manifest.keptAside
      const rebuild = manifest.keptFiles?.length ? await this.rebuildOf(manifest) : undefined
      for (const layer of manifest.keptFiles ?? []) await this.writeKeptFiles(manifest, layer, rebuild!)
      for (const entry of manifest.content) {
        const target = join(manifest.worktreePath, entry.path)
        if (entry.kind === 'directory' && rebuild) { if (entry.path) await rebuild.folder(entry.path.split('/')) }
        else if (entry.kind === 'directory') { await assertLifecyclePathAsync(manifest.worktreePath, target); await mkdir(target, { recursive: true }) }
        if (entry.kind !== 'link') { await assertLifecyclePathAsync(manifest.worktreePath, target); await chmod(target, entry.mode & 0o777) }
      }
    }
    const identity = await this.inspectIdentity(manifest.worktreePath, manifest.branch, manifest.repositoryId)
    // With kept copies, the files a snapshot holds are no longer all of them: every entry is compared with the proof.
    const matches = manifest.keptFiles?.length
      ? sameContent(await walkOwnedContentAsync(manifest.worktreePath, true), manifest.content)
      : !(manifest.snapshotTree && await worktreeTreeAsync(manifest.worktreePath) !== manifest.snapshotTree) && JSON.stringify((await this.inspectContent(manifest.worktreePath, manifest.snapshotTree)).content) === JSON.stringify(manifest.content)
    if (await lifecycleGitAsync(manifest.worktreePath, ['rev-parse', 'HEAD^{tree}']) !== manifest.treeSha || !matches) throw new Error('Reconstructed workspace does not match retained content')
    await this.verifyPins(manifest)
    delete manifest.trashPath; delete manifest.trashedAt
    Object.assign(manifest, identity, { state: 'materialized' }); atomicWriteJsonSync(manifestPath, manifest)
    return manifest
  }
  async verifyPins(manifest: WorktreeReconstructionManifest): Promise<void> {
    await assertLifecyclePathAsync(dirname(manifest.commonDir), manifest.commonDir)
    if (hash((await realpathLikeSync(manifest.commonDir)).toLowerCase()).slice(0, 32) !== manifest.repositoryId) throw new Error('Repository identity is unavailable or changed')
    for (const [ref, sha] of [[manifest.baseRef, manifest.baseSha], [manifest.resultRef, manifest.resultSha], ...(manifest.snapshotRef ? [[manifest.snapshotRef, manifest.snapshotSha!]] : []), ...(manifest.adminRef ? [[manifest.adminRef, manifest.adminCommit!]] : [])]) if (await readDirectLifecycleRefAsync(manifest.commonDir, ref) !== sha) throw new Error('Reconstruction pin changed or is unavailable')
    if (manifest.adminCommit && await lifecycleGitAsync(manifest.commonDir, ['rev-parse', `${manifest.adminCommit}^{tree}`]) !== manifest.adminTree) throw new Error('Retained Git data of the worktree changed')
    const prefix = manifest.resultRef.slice(0, -'/result'.length)
    for (const layer of manifest.keptFiles ?? []) if (layer.sha && await readDirectLifecycleRefAsync(manifest.commonDir, `${prefix}/kept/${layer.sha}`) !== layer.sha) throw new Error('A pin of the kept files changed or is unavailable')
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
   * With `collectUncaptured`, files neither the snapshot nor the auxiliary payloads hold (ignored files, say) are listed
   * in `uncaptured` instead of refused, for the caller to keep in a copy of their own.
   */
  async inspectContent(path: string, snapshotTree?: string, options: { collectUncaptured?: boolean } = {}): Promise<Pick<WorktreeReconstructionManifest, 'content' | 'auxiliary' | 'sparse'> & { uncaptured: string[] }> {
    if (!snapshotTree) {
      if (await lifecycleReadAsync(path, ['status', '--porcelain=v1', '--untracked-files=all'], undefined, LISTING_MAX_BUFFER)) throw new Error('Dirty, conflicted or untracked content requires retention')
    } else {
      if (await operationInProgressAsync(path)) throw new Error('A merge, rebase or other Git operation in progress requires retention')
      if (await lifecycleReadAsync(path, ['ls-files', '-u'], undefined, LISTING_MAX_BUFFER)) throw new Error('Conflicted content requires retention')
      if (await lifecycleReadAsync(path, ['diff', '--cached', '--name-only'], undefined, LISTING_MAX_BUFFER)) throw new Error('Staged changes require retention')
    }
    const entries = await walkOwnedContentAsync(path, true)
    const tracked = new Map((await lifecycleReadAsync(path, ['ls-tree', '-r', '-z', snapshotTree ?? 'HEAD'], undefined, LISTING_MAX_BUFFER)).split('\0').filter(Boolean).map((line) => { const tab = line.indexOf('\t'), header = line.slice(0, tab).split(' '); return [line.slice(tab + 1), { mode: header[0], sha: header[2] }] }))
    const configTrue = async (key: string): Promise<boolean> => { try { return await lifecycleGitAsync(path, ['config', '--bool', key]) === 'true' } catch { return false } }
    const sparseEnabled = await configTrue('core.sparseCheckout')
    const sparse = sparseEnabled ? { patterns: await readFile(resolve(path, await lifecycleGitAsync(path, ['rev-parse', '--git-path', 'info/sparse-checkout'])), 'utf8'), cone: await configTrue('core.sparseCheckoutCone') } : undefined
    // A snapshot sees a file outside the sparse patterns as deleted, so it cannot stand for the checkout.
    if (snapshotTree && sparse) throw new Error('A sparse checkout with uncommitted files requires retention')
    const skipped = new Set<string>()
    for (const flag of (await lifecycleReadAsync(path, ['ls-files', '-v', '-z'], undefined, LISTING_MAX_BUFFER)).split('\0').filter(Boolean)) {
      if (/^[a-z]/.test(flag) || (flag.startsWith('S ') && (!sparse || await exists(join(path, flag.slice(2)))))) throw new Error('Hidden index flags require explicit retention')
      if (flag.startsWith('S ')) skipped.add(flag.slice(2))
    }
    const present = new Set(entries.map((entry) => entry.path))
    for (const name of tracked.keys()) if (!present.has(name) && !skipped.has(name)) throw new Error('Missing tracked content is not explained by sparse checkout')
    const auxiliary: Array<{ path: string; content: string }> = []
    const uncaptured: string[] = []
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
      if (!MOUSSE_CONTROL_FILE_PATHS.includes(entry.path) || entry.kind !== 'file' || entry.bytes > 1024 * 1024) {
        if (options.collectUncaptured) { uncaptured.push(entry.path); continue }
        throw new Error(`Uncaptured ignored or untracked content requires retention: ${entry.path}`)
      }
      auxiliary.push({ path: entry.path, content: (await readFile(join(path, entry.path))).toString('base64') })
    }
    // Modes contain platform type bits; reconstruction uses the same platform and Git checkout policy.
    return { content: entries, auxiliary, ...(sparse ? { sparse } : {}), uncaptured }
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
    // A read that meets the file while another process writes it is tried once more before it counts.
    try { return JSON.parse(await readFile(lease.path, 'utf8')) as { token?: string; processInstanceId?: string } }
    catch {
      await new Promise((resume) => setTimeout(resume, 50))
      return JSON.parse(await readFile(lease.path, 'utf8')) as { token?: string; processInstanceId?: string }
    }
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
