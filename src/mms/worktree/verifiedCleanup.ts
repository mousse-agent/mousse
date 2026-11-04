import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { access, lstat, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { withGitMutationLocks } from '../actions/GitOperationCoordinator'
import { gitsFormsAsync } from '../actions/heldBytes'
import { keepCopy, keepExistingCommit, keptCopyWindowMs, KEEP_COPY_LIMITS, KeepCopyRefusedError, KeepCopyTooLargeError, type KeptCopy } from '../actions/keptCopies'
import { threadPreservedIndex } from '../actions/preservedFiles'
import { convertedPathsAsync } from '../actions/snapshots'
import { withGitAccess } from '../git/gitPolicy'
import { LISTING_MAX_BUFFER } from '../git/runGitProcess'
import { lifecycleReadAsync } from '../lifecycle/lifecycleGit'
import { renameFolderAsync } from '../lifecycle/renameFolder'
import { deleteVerifiedAsync, lockedText, sameProven, samePath, unregisterDeletedAsync, walkOwnedContentAsync, worktreeLockAsync, type ContentEntry, type LateWrites, type WalkOptions } from '../lifecycle/verifiedDelete'
import { adminDigest, linkedAdminDir, readAdminFilesAsync, storeAdminBeforeRemoval } from '../lifecycle/worktreeAdminData'
import type { KeepIgnoredFiles, WorktreeCleanupResult } from './WorktreeManager'

/**
 * Agent and dispatch worktree cleanup as a verified delete (`verifiedDelete.ts`), the second caller after the trash
 * expiry. Nothing in the worktree goes unless its bytes are proven held elsewhere:
 *
 * 1. Capture, under the owner's and the repository's locks: Git's own data of the worktree (`storeAdminBeforeRemoval`),
 *    the proof (every entry of the folder with its SHA-256, the id Git gives its bytes, and what `lstat` said of it while
 *    it was read), and a kept copy of every file or link no blob holds: ignored and untracked files, and tracked ones
 *    whose bytes are neither their blob's nor what Git writes from it (CRLF under `core.autocrlf=input`, an edit hidden by
 *    `--assume-unchanged` or `--skip-worktree`).
 * 2. The proof is recorded in Mousse's own folder ({@link CleanupRecord}), bound to the folder it names, before anything
 *    moves.
 * 3. The folder is renamed to a `.deleting-<hex>` sibling in the same folder, so on the same volume: a writer that opens
 *    a file by its old path now fails instead of writing into it. From here the folder is the cleanup's alone, and the
 *    repository's locks are taken again only for what runs Git: keeping a late write, Git's own data before `.git` goes,
 *    and the unregister.
 * 4. It is compared with the proof and deleted entry by entry, `.git` last (`deleteVerifiedAsync`). A write found
 *    meanwhile is kept as another copy and the delete goes on, at most {@link CLEANUP_ROUNDS} rounds; then cleanup stops
 *    and keeps what is left, and the record says what is kept and what is only in the folder.
 * 5. `git worktree remove <old path>` unregisters it, and the record goes.
 *
 * A process that ends part way leaves the renamed folder and its record. The dispatch start check, Storage, or any later
 * cleanup of the same worktree finishes it against the recorded proof ({@link resumeCleanupAsync}), once the record is
 * shown to name exactly this folder and every entry it lists is shown to be held by a kept copy or the last commit.
 */

/** The renamed folder of a cleanup under way: `.deleting-` and its 16-hex-digit id, beside the worktree's own folder. */
export const DELETING_NAME = /^\.deleting-([a-f0-9]{16})$/
const RECORD_NAME = /^([a-f0-9]{16})\.json$/
/** How many times one cleanup deletes, keeping what was written meanwhile, before it stops and keeps what is left. */
export const CLEANUP_ROUNDS = 3
/** How long a cleanup that stopped because files kept changing waits, with nothing changing, before it is tried again. */
export const CLEANUP_QUIET_MS = 60 * 60 * 1000
/**
 * How the worktree is walked for the proof. A file with other hard links (a package manager's store) is allowed: its
 * copy holds its bytes. No byte limit for the walk: files are read in pieces, what is copied is checked against the kept
 * copy's limit from `lstat` before anything is read, and tracked files are not copied.
 */
const CLEANUP_WALK: WalkOptions = { otherLinks: true, signatures: true, limits: { entries: 500_000, fileBytes: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY } }

/** What a cleanup under way records, at `<home>/worktree-cleanups/<id>.json`. */
export interface CleanupRecord {
  schemaVersion: 2
  /** The 16 hex digits of the renamed folder's name. */
  id: string
  /** The worktree's own path, which Git registers. */
  worktreePath: string
  /** Where it was renamed to: `.deleting-<id>` in the same folder. */
  deletingPath: string
  /** The renamed folder's real path, and its device and inode, which a rename keeps: what it must still be. */
  realPath: string
  identity: string
  branch: string
  repositoryRoot: string
  commonDir: string
  /** The worktree's administration folder, `<common>/worktrees/<name>`, whose `gitdir` names `worktreePath`. */
  adminDir: string
  /** The journal folder that owns the copies. */
  owner: string
  /** Git's object format, for the ids in the proof. */
  objectFormat: 'sha1' | 'sha256'
  /** HEAD when the proof was read: its tree holds the tracked files whose bytes are their blobs'. */
  head?: string
  /** Tracked files whose bytes are what Git writes from their HEAD blob rather than the blob itself. */
  heldByForm: string[]
  /** Whether Git's form of a file may run its filter driver (an agent's checkout); never for a dispatch's. */
  filters: boolean
  /** Ignored files it held, for what the person reads. */
  ignoredFiles: number
  /**
   * The person confirmed deleting its ignored files: they are in no copy, and the proof records them by what `lstat`
   * said of them (an empty digest). Any write to one changes that, and it is kept like any other late write.
   */
  deleteIgnored: boolean
  startedAt: string
  /** HEAD and Git's own data of the worktree as captured, to tell whether they changed before `.git` goes. */
  adminState: string
  /**
   * The worktree's `.git` file as it was. A write that lands after it went leaves a folder that is no checkout: it is
   * written back, so Git can keep a copy of that write and what is left stays a working worktree.
   */
  gitFile: string
  /** Every entry of the folder, `.git` left out, as captured; late writes join it. */
  proof: ContentEntry[]
  /** The copy of the files no blob holds, when there were any. */
  copy?: { ref: string; sha: string; files: number }
  /** Copies of writes found while it was being deleted. */
  late: Array<{ ref: string; sha: string; files: number }>
  /** Copies of Git's own data of the worktree: the first from the capture, then any made again before `.git` went. */
  admin: Array<{ ref: string; sha: string }>
  /** When a write was last found in it. */
  changedAt?: string
  /** Why cleanup stopped and kept what is left. */
  stopped?: { reason: string; at: string }
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
const present = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false)
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`
const firstLine = (error: unknown): string => (error as Error).message.split(/\r?\n/)[0]!
const named = (paths: readonly string[]): string => `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}`

/** Where Mousse keeps the records of cleanups under way: in its own folder, never beside the worktree. */
export function cleanupRecordsFolder(home: string): string {
  return join(home, 'worktree-cleanups')
}
function recordPathOf(home: string, id: string): string {
  return join(cleanupRecordsFolder(home), `${id}.json`)
}

/** The record of cleanup `id`, or undefined when there is none or it is not one cleanup wrote. */
export async function loadCleanupRecord(home: string, id: string): Promise<CleanupRecord | undefined> {
  if (!/^[a-f0-9]{16}$/.test(id)) return undefined
  let value: Partial<CleanupRecord>
  try { value = JSON.parse(await readFile(recordPathOf(home, id), 'utf8')) as Partial<CleanupRecord> } catch { return undefined }
  const paths = [value.worktreePath, value.deletingPath, value.realPath, value.repositoryRoot, value.commonDir, value.adminDir, value.owner]
  if (value.schemaVersion !== 2 || value.id !== id || !paths.every((item) => typeof item === 'string' && isAbsolute(item))) return undefined
  if (basename(value.deletingPath!) !== `.deleting-${id}` || !samePath(dirname(value.deletingPath!), dirname(value.worktreePath!))) return undefined
  if (typeof value.branch !== 'string' || typeof value.identity !== 'string' || typeof value.adminState !== 'string' || typeof value.gitFile !== 'string' || !value.gitFile.startsWith('gitdir:')
    || (value.objectFormat !== 'sha1' && value.objectFormat !== 'sha256') || typeof value.filters !== 'boolean' || !Array.isArray(value.heldByForm)
    || typeof value.ignoredFiles !== 'number' || typeof value.deleteIgnored !== 'boolean' || !Array.isArray(value.proof) || !Array.isArray(value.late) || !Array.isArray(value.admin) || !value.admin.length) return undefined
  return value as CleanupRecord
}

/** Every cleanup under way that Mousse recorded. */
export async function listCleanupRecords(home: string): Promise<CleanupRecord[]> {
  let names: string[]
  try { names = await readdir(cleanupRecordsFolder(home)) } catch { return [] }
  const found: CleanupRecord[] = []
  for (const name of names.sort()) {
    const id = RECORD_NAME.exec(name)?.[1]
    const record = id ? await loadCleanupRecord(home, id) : undefined
    if (record) found.push(record)
  }
  return found
}

/** The cleanup under way of the worktree at `worktreePath`, if Mousse recorded one. */
export async function findCleanupRecord(home: string, worktreePath: string): Promise<CleanupRecord | undefined> {
  return (await listCleanupRecords(home)).find((record) => samePath(record.worktreePath, worktreePath))
}

/** The cleanup under way whose renamed folder is `deletingPath`, if Mousse recorded one. */
export async function cleanupRecordFor(home: string, deletingPath: string): Promise<CleanupRecord | undefined> {
  const id = DELETING_NAME.exec(basename(deletingPath))?.[1]
  const record = id ? await loadCleanupRecord(home, id) : undefined
  return record && samePath(record.deletingPath, deletingPath) ? record : undefined
}

// ---------------------------------------------------------------------------------------------------------
// One run per cleanup

const running = new Set<string>()
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
/**
 * Takes cleanup `id` for this run, or undefined when another run (in this process or a live other one) has it. The
 * delete itself holds no repository lock, so this is what keeps two runs from deleting the same folder at once.
 */
export function tryLockCleanup(home: string, id: string): (() => void) | undefined {
  if (running.has(id)) return undefined
  const folder = cleanupRecordsFolder(home), path = join(folder, `${id}.lock`)
  mkdirSync(folder, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' })
      running.add(id)
      return () => { running.delete(id); rmSync(path, { force: true }) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let pid = Number.NaN
      try { pid = Number(readFileSync(path, 'utf8')) } catch { /* Read as stale. */ }
      if (Number.isSafeInteger(pid) && pid !== process.pid && alive(pid)) return undefined
      rmSync(path, { force: true })
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------------------
// The capture

/** HEAD and Git's own data of the worktree at `folder`, as one value to compare. */
async function adminStateAt(folder: string): Promise<string> {
  try {
    const head = await lifecycleReadAsync(folder, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')
    return `${head}\n${adminDigest(await readAdminFilesAsync((await linkedAdminDir(folder)).adminDir))}`
  } catch (error) {
    return `unreadable: ${firstLine(error)}`
  }
}

type Kept = NonNullable<WorktreeCleanupResult['kept']>
type Removed = Pick<WorktreeCleanupResult, 'copy' | 'admin' | 'late'>

export interface CleanupInput {
  /** Mousse's installation home, where the record is kept. */
  home: string
  worktreePath: string
  branch: string
  repositoryRoot: string
  keep: KeepIgnoredFiles
  /** Git in the worktree, with the same overrides as the clean check. */
  git: (args: string[]) => Promise<string>
  /** The ignored files the clean check listed. */
  ignored: readonly string[]
  /**
   * Whether the worktree was checked out with its filter drivers (an agent's): Git's form of a file under one is then
   * what the driver writes, and may be asked for. A dispatch's checkout ran none, and none runs for its cleanup.
   */
  filters: boolean
  /** Test seam: runs right before each entry is removed. */
  beforeRemove?: (path: string) => void
}

/**
 * The tracked paths of the worktree's index: mode and blob, by path, and whether Git is told not to look at the file
 * (`--assume-unchanged`, `--skip-worktree`). Conflict stages make it dirty, so none are here.
 */
async function trackedFiles(git: CleanupInput['git']): Promise<Map<string, { mode: string; blob: string; hidden: boolean }>> {
  const tracked = new Map<string, { mode: string; blob: string; hidden: boolean }>()
  for (const line of (await git(['ls-files', '-z', '-s', '-v'])).split('\0')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const [tag, mode, blob] = line.slice(0, tab).split(' ') as [string, string, string]
    tracked.set(line.slice(tab + 1), { mode, blob, hidden: tag !== tag.toUpperCase() || tag === 'S' })
  }
  return tracked
}

/** The paths among `paths` with a `filter` attribute set. `check-attr` only reads attributes; no driver runs. */
async function filteredPaths(top: string, paths: readonly string[]): Promise<Set<string>> {
  const fields = (await lifecycleReadAsync(top, ['check-attr', '-z', '--stdin', 'filter'], paths.join('\0') + '\0', LISTING_MAX_BUFFER)).split('\0')
  const filtered = new Set<string>()
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const value = fields[index + 2]
    if (value !== 'unspecified' && value !== 'unset') filtered.add(fields[index]!)
  }
  return filtered
}

/** Whether a tracked mode is a regular file's. */
const regular = (mode: string | undefined): boolean => mode === '100644' || mode === '100755'

/**
 * The tracked files and links of the proof whose bytes a blob holds: its own bytes (the id Git gives them equals the
 * index's blob, whatever Git is told to assume), or what Git writes from it (`heldByForm`, read only for files Git
 * converts: line endings, an encoding, a filter). A dispatch's file under a filter driver is compared only with its blob,
 * since asking for Git's form would run the driver.
 */
async function heldByBlobsAsync(top: string, proof: readonly ContentEntry[], tracked: Map<string, { mode: string; blob: string }>, filters: boolean): Promise<{ held: Set<string>; heldByForm: string[]; filtered: Set<string> }> {
  const held = new Set<string>()
  const others: ContentEntry[] = []
  for (const entry of proof) {
    const index = tracked.get(entry.path)
    if (!index || !entry.blob) continue
    if (entry.kind === 'link' && index.mode === '120000' && entry.blob === index.blob) held.add(entry.path)
    else if (entry.kind === 'file' && regular(index.mode)) {
      if (entry.blob === index.blob) held.add(entry.path)
      else others.push(entry)
    }
  }
  const converted = others.length ? await convertedPathsAsync(top, others.map((entry) => entry.path)) : []
  const filtered = converted.length ? await filteredPaths(top, converted) : new Set<string>()
  const asked = converted.filter((path) => filters || !filtered.has(path))
  const forms = asked.length ? await gitsFormsAsync(top, asked.map((path) => ({ path, blob: tracked.get(path)!.blob }))).catch(() => new Map<string, { bytes: number; digest: string }>()) : new Map<string, { bytes: number; digest: string }>()
  const heldByForm: string[] = []
  for (const entry of others) {
    const form = forms.get(entry.path)
    if (form && form.bytes === entry.bytes && form.digest === entry.digest) { held.add(entry.path); heldByForm.push(entry.path) }
  }
  return { held, heldByForm, filtered: filters ? new Set() : filtered }
}

/** The proof as read, and which of its files and links a blob holds; what is left needs a copy. */
interface ReadFiles { proof: ContentEntry[]; heldByForm: string[]; paths: string[] }

/**
 * Reads the proof and finds what needs a copy: every file and link no blob holds ({@link heldByBlobsAsync}), unless the
 * person confirmed deleting the ignored ones. The copy's size is checked from `lstat` before any file is read. Reads only:
 * it needs none of the repository's locks. `changing`: a file changed while it was read.
 */
async function readFilesAsync(input: CleanupInput, kept: (code: Kept['code'], reason: string) => { kept: Kept }, objectFormat: 'sha1' | 'sha256'): Promise<ReadFiles | { kept: Kept } | 'changing'> {
  const { worktreePath: top } = input
  const deleted = input.keep.deleteIgnored ? new Set(input.ignored) : undefined
  const tracked = await trackedFiles(input.git)
  // Only tracked files are read here, for the id Git gives their bytes. Every other file is read once, by its copy, which
  // supplies its digest; one the person confirmed deleting is not read at all. Both are proven meanwhile by `lstat`.
  let proof: ContentEntry[]
  try { proof = await walkOwnedContentAsync(top, true, { ...CLEANUP_WALK, objectFormat, read: (path) => tracked.has(path) }) }
  catch (error) {
    if (/changed while it was read/.test((error as Error).message)) return 'changing'
    return kept('keep_copy_refused', `cleanup could not read every file in it (${firstLine(error)}).`)
  }
  // What needs a copy, by `lstat`, before any of it is read: everything Git does not track.
  const untracked = proof.filter((entry) => entry.kind !== 'directory' && !tracked.has(entry.path) && !deleted?.has(entry.path))
  const total = untracked.reduce((sum, entry) => sum + entry.bytes, 0)
  if (total > KEEP_COPY_LIMITS.bytes) {
    const error = new KeepCopyTooLargeError('Worktree cleanup', total, [...untracked].sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((entry) => ({ path: entry.path, bytes: entry.bytes })))
    return kept('keep_copy_too_large', error.message.replace(/ Nothing was changed\..*$/s, ''))
  }
  const { held, heldByForm, filtered } = await heldByBlobsAsync(top, proof, tracked, input.filters)
  // Copying one would have Git read the index again, which can run the driver: the worktree stays, and the file is named.
  const unheldFiltered = [...filtered].filter((path) => !held.has(path))
  if (unheldFiltered.length) return kept('keep_copy_refused', `${named(unheldFiltered)} ${unheldFiltered.length === 1 ? 'is' : 'are'} written by a filter driver and ${unheldFiltered.length === 1 ? 'differs' : 'differ'} from what Git stores; cleanup cannot keep a copy without running the driver.`)
  return { proof, heldByForm, paths: proof.filter((entry) => entry.kind !== 'directory' && !held.has(entry.path) && !deleted?.has(entry.path)).map((entry) => entry.path) }
}

/**
 * Keeps a copy of what {@link readFilesAsync} found needs one, under the owner's and the repository's locks. `first` is
 * a read made before the locks were taken. A file that changes while it is read, or between the proof and its copy,
 * makes it read again, at most {@link CLEANUP_ROUNDS} times.
 */
async function captureFilesAsync(input: CleanupInput, kept: (code: Kept['code'], reason: string) => { kept: Kept }, objectFormat: 'sha1' | 'sha256', first: ReadFiles | 'changing'): Promise<{ proof: ContentEntry[]; copy?: KeptCopy; files: number; heldByForm: string[] } | { kept: Kept }> {
  let changing: string[] = []
  for (let attempt = 1; attempt <= CLEANUP_ROUNDS; attempt++) {
    const read = attempt === 1 ? first : await readFilesAsync(input, kept, objectFormat)
    if (read === 'changing') { changing = ['the worktree']; continue }
    if ('kept' in read) return read
    const { proof, heldByForm, paths } = read
    if (!paths.length) return { proof, files: 0, heldByForm }
    let copy: KeptCopy
    try {
      copy = await keepCopy({ owner: input.keep.owner, top: input.worktreePath, operationType: 'worktree-cleanup', action: 'Worktree cleanup', paths })
    } catch (error) {
      if (!(error instanceof KeepCopyRefusedError)) throw error
      return kept(error instanceof KeepCopyTooLargeError ? 'keep_copy_too_large' : 'keep_copy_refused', error.message.replace(/ Nothing was changed\..*$/s, ''))
    }
    const expected = new Map(proof.map((entry) => [entry.path, entry]))
    // A file read here too must be the bytes its copy read; any other takes its digest, and its blob id, from its copy.
    changing = paths.filter((path) => expected.get(path)!.digest !== '' && copy.digests.get(path) !== expected.get(path)!.digest)
    if (changing.length) continue
    const blobs = new Map<string, string>()
    for (const line of (await lifecycleReadAsync(input.worktreePath, ['ls-tree', '-r', '-z', '--full-tree', copy.sha], undefined, LISTING_MAX_BUFFER)).split('\0')) {
      const tab = line.indexOf('\t')
      if (tab >= 0) blobs.set(line.slice(tab + 1), line.slice(0, tab).split(' ')[2]!)
    }
    for (const path of paths) {
      const entry = expected.get(path)!
      if (entry.digest !== '') continue
      const digest = copy.digests.get(path), blob = blobs.get(path)
      if (!digest || !blob) { changing = [path]; break }
      entry.digest = digest; entry.blob = blob
    }
    if (!changing.length) return { proof, copy, files: paths.length, heldByForm }
  }
  return kept('keep_copy_refused', `${named(changing)} kept changing while cleanup copied it.`)
}

/** The locks of the owner of the copies and of the repository, for what runs Git. */
function lockedFor(record: Pick<CleanupRecord, 'owner' | 'repositoryRoot'>): <T>(work: () => Promise<T>) => Promise<T> {
  return (work) => withGitMutationLocks(record.owner, record.repositoryRoot, 'worktree-cleanup', work)
}

/** A path whose last part may be gone, with the folders above it spelled as the volume spells them. */
async function canonical(path: string): Promise<string> {
  try { return join(await realpath(dirname(path)), basename(path)) } catch { return path }
}

/**
 * Cleans up a clean worktree with nothing in the way of a copy (see the module comment). The owner's and the
 * repository's locks are held for the capture and the rename, and taken again only for what runs Git afterwards.
 */
export async function verifiedCleanupAsync(input: CleanupInput): Promise<Removed | { kept: Kept }> {
  return withGitAccess('worktree.cleanup', 'owned', async () => {
    const locked = lockedFor({ owner: input.keep.owner, repositoryRoot: input.repositoryRoot })
    // The files are read before the locks are taken: reading needs none, and other Git work in the repository goes on.
    const ignoredFiles = input.keep.deleteIgnored ? 0 : input.ignored.length
    const holds = ignoredFiles ? `Kept, ${plural(ignoredFiles, 'ignored file')}` : 'Kept'
    const kept = (code: Kept['code'], reason: string): { kept: Kept } => ({ kept: { ignoredFiles, code, reason: `${holds}: ${reason}` } })
    let objectFormat: 'sha1' | 'sha256'
    try { objectFormat = (await lifecycleReadAsync((await linkedAdminDir(input.worktreePath)).commonDir, ['rev-parse', '--show-object-format'])) === 'sha256' ? 'sha256' : 'sha1' }
    catch (error) { return kept('keep_copy_refused', `Git's own data of it could not be found (${firstLine(error)}).`) }
    const first = await readFilesAsync(input, kept, objectFormat)
    if (first !== 'changing' && 'kept' in first) return first
    const started = await locked(() => captureAndRenameAsync(input, kept, objectFormat, first))
    if ('kept' in started) return started
    try {
      const finished = await finishCleanupAsync(input.home, started.record, input.beforeRemove, false)
      if (finished !== 'restart') return finished
      await rm(recordPathOf(input.home, started.record.id), { force: true })
      return { kept: { ignoredFiles: started.record.ignoredFiles, code: 'cleanup_stopped', reason: `Kept: it went back to ${input.worktreePath} while cleanup was deleting it.` } }
    } finally { started.release() }
  })
}

async function captureAndRenameAsync(input: CleanupInput, kept: (code: Kept['code'], reason: string) => { kept: Kept }, objectFormat: 'sha1' | 'sha256', first: ReadFiles | 'changing'): Promise<{ record: CleanupRecord; release: () => void } | { kept: Kept }> {
  const { keep, worktreePath, branch } = input
  const ignoredFiles = keep.deleteIgnored ? 0 : input.ignored.length
  const holds = ignoredFiles ? `Kept, ${plural(ignoredFiles, 'ignored file')}` : 'Kept'
  keep.record?.({ phase: 'keeping', files: ignoredFiles })
  let commonDir: string, adminDir: string, gitFile: string
  try {
    ({ commonDir, adminDir } = await linkedAdminDir(worktreePath))
    if (!(await lstat(join(worktreePath, '.git'))).isFile()) throw new Error('its .git is not a file')
    gitFile = await readFile(join(worktreePath, '.git'), 'utf8')
  } catch (error) { return { kept: { ignoredFiles, code: 'keep_copy_refused', reason: `${holds}: Git's own data of it could not be found (${firstLine(error)}).` } } }
  const locked = await worktreeLockAsync(commonDir, worktreePath)
  if (locked !== undefined) return { kept: { ignoredFiles, code: 'worktree_locked', reason: `${holds}: ${lockedText(locked, worktreePath, 'cleanup')}` } }
  // Read before the capture, so a change while it runs is captured again before `.git` goes.
  const adminState = await adminStateAt(worktreePath)
  let admin: Awaited<ReturnType<typeof storeAdminBeforeRemoval>>
  try {
    // The worktree's branch counts as going too: what only it holds is kept with Git's data, whatever happens to it later.
    admin = await storeAdminBeforeRemoval(worktreePath, [`refs/heads/${branch}`])
  } catch (error) {
    return { kept: { ignoredFiles, code: 'keep_copy_refused', reason: `${holds}: Git's own data of it (its settings and HEAD history) could not be kept (${firstLine(error)}).` } }
  }
  const head = await lifecycleReadAsync(worktreePath, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).catch(() => '')
  const files = await captureFilesAsync(input, kept, objectFormat, first)
  if ('kept' in files) return files
  const adminKept = await keepExistingCommit({ owner: keep.owner, top: worktreePath, operationType: 'worktree-cleanup', sha: admin.commit })
  const lockedNow = await worktreeLockAsync(commonDir, worktreePath)
  if (lockedNow !== undefined) return { kept: { ignoredFiles, code: 'worktree_locked', reason: `${holds}: ${lockedText(lockedNow, worktreePath, 'cleanup')}` } }

  const id = randomBytes(8).toString('hex')
  const deletingPath = join(dirname(worktreePath), `.deleting-${id}`)
  const root = await lstat(worktreePath, { bigint: true })
  const record: CleanupRecord = {
    schemaVersion: 2, id, worktreePath, deletingPath, realPath: await canonical(deletingPath), identity: `${root.dev}:${root.ino}`,
    branch, repositoryRoot: input.repositoryRoot, commonDir, adminDir, owner: keep.owner, objectFormat, ...(head ? { head } : {}),
    heldByForm: files.heldByForm, filters: input.filters, ignoredFiles, deleteIgnored: keep.deleteIgnored === true, startedAt: new Date().toISOString(), adminState, gitFile, proof: files.proof,
    ...(files.copy ? { copy: { ref: files.copy.ref, sha: files.copy.sha, files: files.files } } : {}),
    late: [], admin: [{ ref: adminKept.ref, sha: admin.commit }]
  }
  const release = tryLockCleanup(input.home, id)
  if (!release) return { kept: { ignoredFiles, code: 'cleanup_running', reason: `${holds}: another cleanup has it.` } }
  // Recorded before the folder moves: a process that ends from here on leaves the folder at one of its two names.
  try {
    atomicWriteJsonSync(recordPathOf(input.home, id), record)
    keep.record?.({ phase: 'deleting', ...(record.copy ? { ref: record.copy.ref, sha: record.copy.sha } : {}), files: ignoredFiles, admin: record.admin[0]!, path: deletingPath })
    await renameFolderAsync(worktreePath, deletingPath)
  } catch (error) {
    await rm(recordPathOf(input.home, id), { force: true })
    release()
    return { kept: { ignoredFiles, code: 'cleanup_stopped', reason: `${holds}: files in it are in use (${firstLine(error)}), so cleanup left it where it is.` } }
  }
  return { record, release }
}

// ---------------------------------------------------------------------------------------------------------
// Finishing

/**
 * Finishes cleanup `id` that a process left part way, or that stopped, against its recorded proof. Another run that has
 * it now gives `cleanup_running` and nothing changes. The record is read again once this run has it, then shown to name
 * exactly this folder and to list only entries held by a kept copy or the last commit; otherwise nothing more is deleted.
 * `restart` means the folder never moved: the record goes, and the caller cleans the worktree up afresh. `owner`, when
 * the caller has one, must be the record's.
 */
export async function resumeCleanupAsync(input: { home: string; id: string; owner?: string; beforeRemove?: (path: string) => void }): Promise<Removed | { kept: Kept } | 'restart' | 'gone'> {
  const release = tryLockCleanup(input.home, input.id)
  if (!release) return { kept: { ignoredFiles: 0, code: 'cleanup_running', reason: 'Kept: another cleanup is finishing it now.' } }
  try {
    const record = await loadCleanupRecord(input.home, input.id)
    if (!record) return 'gone'
    if (input.owner !== undefined && !samePath(input.owner, record.owner)) return { kept: { ignoredFiles: record.ignoredFiles, code: 'cleanup_stopped', reason: `Kept: its cleanup was recorded for another owner of its copies; nothing in ${record.deletingPath} was touched.`, path: record.deletingPath } }
    const finished = await withGitAccess('worktree.cleanup', 'owned', () => finishCleanupAsync(input.home, record, input.beforeRemove, true))
    if (finished === 'restart') await rm(recordPathOf(input.home, record.id), { force: true })
    return finished
  } finally { release() }
}

/**
 * Whether the renamed folder is still the one cleanup renamed: a real folder, no link, with the device, inode and real
 * path it had. Nothing is written into or deleted from a folder that is not.
 */
async function sameFolderAsync(record: CleanupRecord): Promise<boolean> {
  try {
    const stat = await lstat(record.deletingPath, { bigint: true })
    return stat.isDirectory() && !stat.isSymbolicLink() && `${stat.dev}:${stat.ino}` === record.identity && samePath(await realpath(record.deletingPath), record.realPath)
  } catch { return false }
}

/**
 * Whether the record is for the worktree Git registers: the `.git` file it recorded names the administration folder it
 * recorded, which is in the repository's `worktrees` folder and whose `gitdir` names the worktree's own path.
 */
async function registeredAsAsync(record: CleanupRecord): Promise<string | undefined> {
  const gitdir = record.gitFile.slice('gitdir:'.length).trim()
  if (!samePath(dirname(record.adminDir), join(record.commonDir, 'worktrees'))) return 'its record names no administration folder of the repository'
  let named: string
  try { named = (await readFile(join(record.adminDir, 'gitdir'), 'utf8')).trim() } catch { return 'Git no longer registers the worktree it records' }
  const real = await realpath(isAbsolute(gitdir) ? gitdir : join(record.worktreePath, gitdir)).catch(() => undefined)
  if (!real || !samePath(real, record.adminDir)) return 'its record names another worktree\'s administration folder'
  if (!samePath(await canonical(dirname(named)), await canonical(record.worktreePath)) || basename(named) !== '.git') return 'Git registers that administration folder for another worktree'
  if (await present(join(record.deletingPath, '.git'))) {
    const current = await readFile(join(record.deletingPath, '.git'), 'utf8').catch(() => undefined)
    if (current?.trim() !== record.gitFile.trim()) return 'its .git file is not the one cleanup recorded'
  }
  return undefined
}

/**
 * Every file and link the proof lists, shown to be held: the id Git gives its bytes is the blob at its path in a kept
 * copy of this cleanup (present under the ref it recorded, and the owner's) or in the HEAD it recorded; or, for a file
 * held by Git's form, what Git writes from that HEAD blob has its SHA-256. Returns the paths that are not.
 */
async function unheldAsync(record: CleanupRecord): Promise<string[] | string> {
  const index = threadPreservedIndex(record.owner)
  for (const copy of [...(record.copy ? [record.copy] : []), ...record.late, ...record.admin]) {
    const sha = await lifecycleReadAsync(record.commonDir, ['rev-parse', '--verify', '-q', `${copy.ref}^{commit}`]).catch(() => '')
    if (sha !== copy.sha || !index.owns(copy.ref)) return `its copy ${copy.ref} is no longer the owner's`
  }
  const blobs = new Map<string, Set<string>>()
  const add = async (commit: string): Promise<void> => {
    for (const line of (await lifecycleReadAsync(record.commonDir, ['ls-tree', '-r', '-z', '--full-tree', commit], undefined, LISTING_MAX_BUFFER)).split('\0')) {
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const path = line.slice(tab + 1), blob = line.slice(0, tab).split(' ')[2]!
      blobs.set(path, (blobs.get(path) ?? new Set()).add(blob))
    }
  }
  for (const copy of [...(record.copy ? [record.copy] : []), ...record.late]) await add(copy.sha)
  if (record.head) await add(record.head)
  // Ignored files the person confirmed deleting are in no copy; the proof holds them by `lstat` alone.
  const unheld = record.proof.filter((entry) => entry.kind !== 'directory' && !(record.deleteIgnored && entry.kind === 'file' && entry.digest === '' && entry.signature !== undefined) && !(entry.blob && blobs.get(entry.path)?.has(entry.blob)))
  const byForm = new Set(record.heldByForm)
  const form = unheld.filter((entry) => byForm.has(entry.path) && entry.kind === 'file')
  if (form.length && record.head) {
    const heads = new Map<string, string>()
    for (const line of (await lifecycleReadAsync(record.commonDir, ['ls-tree', '-r', '-z', '--full-tree', record.head, '--', ...form.map((entry) => entry.path)], undefined, LISTING_MAX_BUFFER)).split('\0')) {
      const tab = line.indexOf('\t')
      if (tab >= 0) heads.set(line.slice(tab + 1), line.slice(0, tab).split(' ')[2]!)
    }
    const asked = form.filter((entry) => heads.has(entry.path))
    const forms = asked.length ? await gitsFormsAsync(record.deletingPath, asked.map((entry) => ({ path: entry.path, blob: heads.get(entry.path)! }))).catch(() => new Map<string, { bytes: number; digest: string }>()) : new Map()
    return unheld.filter((entry) => { const found = forms.get(entry.path); return !(byForm.has(entry.path) && found && found.bytes === entry.bytes && found.digest === entry.digest) }).map((entry) => entry.path)
  }
  return unheld.map((entry) => entry.path)
}

/** What is in the renamed folder now that no proof entry describes: written there and held only by the folder. */
export async function onlyInFolderAsync(record: CleanupRecord): Promise<string[]> {
  if (!await sameFolderAsync(record)) return []
  try {
    const proof = new Map(record.proof.map((entry) => [entry.path, entry]))
    return (await walkOwnedContentAsync(record.deletingPath, true, { ...CLEANUP_WALK, objectFormat: record.objectFormat }))
      .filter((entry) => entry.kind !== 'directory' && !sameProven(entry, proof.get(entry.path))).map((entry) => entry.path)
  } catch { return [] }
}

/** What the person reads of a cleanup that stopped: why, and exactly which files are only in the folder. */
async function stoppedText(record: CleanupRecord, why: string): Promise<string> {
  const only = await onlyInFolderAsync(record)
  const copies = (record.copy ? 1 : 0) + record.late.length
  const kept = copies ? `Its other files are in ${copies === 1 ? '1 kept copy' : `${copies} kept copies`} or its last commit.` : 'Its other files are in its last commit.'
  return `${why}${/[.!]$/.test(why) ? '' : '.'} ${only.length ? `${plural(only.length, 'file')} written into it ${only.length === 1 ? 'is' : 'are'} only in ${record.deletingPath} (${named(only)}). ` : `What is left of it is at ${record.deletingPath}. `}${kept}`
}

async function finishCleanupAsync(home: string, record: CleanupRecord, beforeRemove: ((path: string) => void) | undefined, resuming: boolean): Promise<Removed | { kept: Kept } | 'restart'> {
  const save = (): void => atomicWriteJsonSync(recordPathOf(home, record.id), record)
  const locked = lockedFor(record)
  const holds = record.ignoredFiles ? `Kept, ${plural(record.ignoredFiles, 'ignored file')}` : 'Kept'
  const stop = async (why: string, untouched = false): Promise<{ kept: Kept }> => {
    // What is left stays a working worktree.
    if (!untouched) await restoreGitFile(record)
    const reason = untouched ? `${why}; nothing in ${record.deletingPath} was touched.` : await stoppedText(record, why)
    record.stopped = { reason, at: new Date().toISOString() }
    save()
    return { kept: { ignoredFiles: record.ignoredFiles, code: 'cleanup_stopped', reason: `${holds}: ${reason}`, path: record.deletingPath } }
  }
  if (!await present(record.deletingPath)) {
    if (await exists(record.worktreePath)) return 'restart'
    return locked(() => unregister(home, record, stop))
  }
  if (!await sameFolderAsync(record)) return stop(`Cleanup stopped: ${record.deletingPath} is no longer the folder it renamed`, true)
  if (resuming) {
    const unregistered = await registeredAsAsync(record)
    if (unregistered) return stop(`Cleanup stopped: ${unregistered}`, true)
    // `.git` back first, when it went: Git's form of a file is read in the folder.
    await restoreGitFile(record)
    const unheld = await unheldAsync(record)
    if (typeof unheld === 'string') return stop(`Cleanup stopped: ${unheld}`, true)
    if (unheld.length) return stop(`Cleanup stopped: its record lists ${named(unheld)}, which no kept copy or commit holds`, true)
  }
  delete record.stopped
  for (let round = 1; round <= CLEANUP_ROUNDS; round++) {
    let refused: string | undefined
    let grew = false
    // A write that landed after `.git` went (in an earlier round, or before a process ended) is kept by Git through it.
    await restoreGitFile(record)
    const stopped = await deleteVerifiedAsync({
      root: record.deletingPath,
      top: dirname(record.deletingPath),
      proof: record.proof,
      place: 'cleanup',
      walk: { ...CLEANUP_WALK, objectFormat: record.objectFormat },
      ...(beforeRemove ? { beforeRemove } : {}),
      steps: {
        // The folder is the cleanup's alone since the rename; `tryLockCleanup` keeps other runs out.
        begin: async () => undefined,
        held: async () => () => undefined,
        recaptureAdmin: (folder) => locked(async () => {
          const state = await adminStateAt(folder)
          if (state === record.adminState) return
          const admin = await storeAdminBeforeRemoval(folder, [`refs/heads/${record.branch}`])
          const kept = await keepExistingCommit({ owner: record.owner, top: folder, operationType: 'worktree-cleanup', sha: admin.commit })
          record.admin.push({ ref: kept.ref, sha: admin.commit })
          record.adminState = state
          save()
        }),
        keepLate: (late) => locked(async () => {
          const outcome = await keepLateWrites(record, late)
          if (outcome) refused = outcome.kept
          return outcome
        }),
        save: ({ changedAt, content }) => {
          if (content) { record.proof = content; grew = true }
          record.changedAt = changedAt
          save()
        }
      }
    })
    if (!stopped) return locked(() => unregister(home, record, stop))
    if (refused || stopped.readOnly) return stop(stopped.kept)
    // Without growth the delete stopped for a reason of its own, unless it was a write after `.git` went: that one is
    // kept in the next round, once `.git` is back.
    if (!grew && (await lstat(join(record.deletingPath, '.git')).catch(() => undefined))?.isFile()) return stop(stopped.kept)
  }
  return stop(`Cleanup stopped: files in it kept changing while it was being deleted, ${CLEANUP_ROUNDS} times`)
}

/**
 * Writes the worktree's `.git` file back into what is left of it, when it is gone, never over anything there, and only
 * into the very folder cleanup renamed ({@link sameFolderAsync}).
 */
async function restoreGitFile(record: CleanupRecord): Promise<void> {
  if (!await sameFolderAsync(record)) return
  try { await writeFile(join(record.deletingPath, '.git'), record.gitFile, { flag: 'wx' }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
}

/** Keeps writes found during the delete as one more copy of the owner's, checked against what was found. */
async function keepLateWrites(record: CleanupRecord, late: LateWrites): Promise<{ kept: string } | undefined> {
  if (!late.files.length) return undefined
  let copy: KeptCopy
  try {
    copy = await keepCopy({ owner: record.owner, top: late.root, operationType: 'worktree-cleanup', action: 'Worktree cleanup', paths: late.files, ...(late.gone.length ? { gone: late.gone } : {}) })
  } catch (error) {
    return { kept: `Cleanup stopped: a copy of what was written into it could not be kept (${firstLine(error)})` }
  }
  const expected = new Map(late.entries.map((entry) => [entry.path, entry.digest]))
  const changed = late.files.find((path) => copy.digests.get(path) !== expected.get(path))
  if (changed) return { kept: `Cleanup stopped: ${changed} changed while its copy was being kept` }
  record.late.push({ ref: copy.ref, sha: copy.sha, files: late.files.length })
  return undefined
}

/** The folder is gone: Git's registration of the worktree at its old path goes, then the record. */
async function unregister(home: string, record: CleanupRecord, stop: (why: string) => Promise<{ kept: Kept }>): Promise<Removed | { kept: Kept }> {
  const outcome = await unregisterDeletedAsync({
    commonDir: record.commonDir,
    path: record.worktreePath,
    place: 'cleanup',
    held: async () => () => undefined,
    unregistered: async () => { await rm(recordPathOf(home, record.id), { force: true }) }
  })
  if ('kept' in outcome) return stop(outcome.kept)
  const windowMs = keptCopyWindowMs(record.owner)
  return {
    ...(record.copy ? { copy: { ...record.copy, windowMs } } : {}),
    admin: { ...record.admin[0]!, windowMs },
    ...(record.late.length ? { late: record.late.map((copy) => ({ ...copy, windowMs })) } : {})
  }
}
