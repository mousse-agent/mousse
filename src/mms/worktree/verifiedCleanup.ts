import { randomBytes } from 'node:crypto'
import { access, lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { gitsFormsAsync } from '../actions/heldBytes'
import { keepCopy, keepExistingCommit, keptCopyWindowMs, KeepCopyRefusedError, KeepCopyTooLargeError, type KeptCopy } from '../actions/keptCopies'
import { convertedPathsAsync } from '../actions/snapshots'
import { LISTING_MAX_BUFFER } from '../git/runGitProcess'
import { lifecycleReadAsync } from '../lifecycle/lifecycleGit'
import { renameFolderAsync } from '../lifecycle/renameFolder'
import { deleteVerifiedAsync, lockedText, samePath, unregisterDeletedAsync, walkOwnedContentAsync, worktreeLockAsync, type ContentEntry, type LateWrites, type WalkOptions } from '../lifecycle/verifiedDelete'
import { adminDigest, linkedAdminDir, readAdminFilesAsync, storeAdminBeforeRemoval } from '../lifecycle/worktreeAdminData'
import type { KeepIgnoredFiles, WorktreeCleanupResult } from './WorktreeManager'

/**
 * Agent and dispatch worktree cleanup as a verified delete (`verifiedDelete.ts`), the second caller after the trash
 * expiry. Nothing in the worktree goes unless its bytes are proven held elsewhere:
 *
 * 1. Capture: Git's own data of the worktree (`storeAdminBeforeRemoval`), a kept copy of every file Git cannot write
 *    back (ignored and untracked files, links, and tracked files whose raw bytes differ from what Git writes from their
 *    blob, such as CRLF under `core.autocrlf=input`), and the proof: every entry of the folder with its SHA-256.
 * 2. The proof is recorded in a file beside the folder ({@link CleanupRecord}), state `deleting`, before anything moves.
 * 3. The folder is renamed to a `.deleting-<hex>` sibling in the same folder, so on the same volume: a writer that opens
 *    a file by its old path now fails instead of writing into it.
 * 4. It is compared with the proof and deleted entry by entry, `.git` last (`deleteVerifiedAsync`). A write found
 *    meanwhile is kept as another copy and the delete goes on, at most {@link CLEANUP_ROUNDS} rounds; then cleanup stops
 *    and keeps what is left, and the record says why.
 * 5. `git worktree remove <old path>` unregisters it, and the record goes.
 *
 * A process that ends part way leaves the renamed folder and its record. The dispatch start check, Storage, or any later
 * cleanup of the same worktree finishes it against the recorded proof ({@link resumeCleanupAsync}).
 */

/** The renamed folder of a cleanup under way: `.deleting-` and 16 hex digits, beside the worktree's own folder. */
export const DELETING_NAME = /^\.deleting-[a-f0-9]{16}$/
const RECORD_NAME = /^\.deleting-[a-f0-9]{16}\.json$/
/** How many times one cleanup deletes, keeping what was written meanwhile, before it stops and keeps what is left. */
export const CLEANUP_ROUNDS = 3
/**
 * How the worktree is walked for the proof. A file with other hard links (a package manager's store) is allowed: its
 * copy holds its bytes. No byte limit: what is copied has the kept copy's own limit, and tracked files are not copied.
 */
const CLEANUP_WALK: WalkOptions = { otherLinks: true, limits: { entries: 500_000, fileBytes: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY } }

/** What a cleanup under way records beside the folder, at `<renamed folder>.json`. */
export interface CleanupRecord {
  schemaVersion: 1
  /** The worktree's own path, which Git registers. */
  worktreePath: string
  /** Where it was renamed to: `.deleting-<hex>` in the same folder. */
  deletingPath: string
  branch: string
  repositoryRoot: string
  commonDir: string
  /** The journal folder that owns the copies. */
  owner: string
  /** Ignored files it held, for what the person reads. */
  ignoredFiles: number
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
  /** The copy of the files Git cannot write back, when there were any. */
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
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`
const firstLine = (error: unknown): string => (error as Error).message.split(/\r?\n/)[0]!

export function cleanupRecordPath(deletingPath: string): string {
  return `${deletingPath}.json`
}

/** The record at `path`, or undefined when there is none or it is not one this cleanup wrote. */
export async function loadCleanupRecord(path: string): Promise<CleanupRecord | undefined> {
  let value: Partial<CleanupRecord>
  try { value = JSON.parse(await readFile(path, 'utf8')) as Partial<CleanupRecord> } catch { return undefined }
  const paths = [value.worktreePath, value.deletingPath, value.repositoryRoot, value.commonDir, value.owner]
  if (value.schemaVersion !== 1 || !paths.every((item) => typeof item === 'string' && isAbsolute(item))) return undefined
  if (!DELETING_NAME.test(basename(value.deletingPath!)) || !samePath(dirname(value.deletingPath!), dirname(value.worktreePath!)) || !samePath(cleanupRecordPath(value.deletingPath!), path)) return undefined
  if (typeof value.branch !== 'string' || typeof value.adminState !== 'string' || typeof value.gitFile !== 'string' || !value.gitFile.startsWith('gitdir:') || typeof value.ignoredFiles !== 'number' || !Array.isArray(value.proof) || !Array.isArray(value.late) || !Array.isArray(value.admin) || !value.admin.length) return undefined
  return value as CleanupRecord
}

/** Every cleanup under way recorded in `folder` (a folder of agent worktrees). */
export async function listCleanupRecords(folder: string): Promise<Array<{ path: string; record: CleanupRecord }>> {
  let names: string[]
  try { names = await readdir(folder) } catch { return [] }
  const found: Array<{ path: string; record: CleanupRecord }> = []
  for (const name of names.sort()) {
    if (!RECORD_NAME.test(name)) continue
    const record = await loadCleanupRecord(join(folder, name))
    if (record) found.push({ path: join(folder, name), record })
  }
  return found
}

/** The cleanup under way of the worktree at `worktreePath`, if one is recorded beside it. */
export async function findCleanupRecord(worktreePath: string): Promise<{ path: string; record: CleanupRecord } | undefined> {
  return (await listCleanupRecords(dirname(worktreePath))).find((found) => samePath(found.record.worktreePath, worktreePath))
}

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
  worktreePath: string
  branch: string
  repositoryRoot: string
  keep: KeepIgnoredFiles
  /** Git in the worktree, with the same overrides as the clean check. */
  git: (args: string[]) => Promise<string>
  /** The ignored files the clean check listed. */
  ignored: readonly string[]
  /** Test seam: runs right before each entry is removed. */
  beforeRemove?: (path: string) => void
}

/** The tracked paths of the worktree's index: mode and blob, by path. Conflict stages make it dirty, so none are here. */
async function trackedFiles(git: CleanupInput['git']): Promise<Map<string, { mode: string; blob: string }>> {
  const tracked = new Map<string, { mode: string; blob: string }>()
  for (const line of (await git(['ls-files', '-z', '-s'])).split('\0')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const [mode, blob] = line.slice(0, tab).split(' ') as [string, string]
    tracked.set(line.slice(tab + 1), { mode, blob })
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

/**
 * Reads the proof and keeps a copy of every file it holds that Git cannot write back: anything untracked (ignored files,
 * unless the person confirmed deleting them), every link, and every tracked file whose raw bytes are not what Git writes
 * from its blob. That last check reads Git's form only of files Git converts (`convertedPathsAsync`); any other tracked
 * file's raw bytes are its blob's, since Git still finds the worktree clean after the proof was read. A file that
 * changes between the proof and its copy makes it start again, at most {@link CLEANUP_ROUNDS} times.
 */
async function captureFilesAsync(input: CleanupInput, holds: string, ignoredFiles: number): Promise<{ proof: ContentEntry[]; copy?: KeptCopy; files: number } | { kept: Kept }> {
  const { worktreePath: top } = input
  const kept = (code: Kept['code'], reason: string): { kept: Kept } => ({ kept: { ignoredFiles, code, reason: `${holds}: ${reason}` } })
  let changing: string[] = []
  for (let attempt = 1; attempt <= CLEANUP_ROUNDS; attempt++) {
    let proof: ContentEntry[]
    try { proof = await walkOwnedContentAsync(top, true, CLEANUP_WALK) }
    catch (error) { return kept('keep_copy_refused', `cleanup could not read every file in it (${firstLine(error)}).`) }
    // Still clean once the proof is read: a tracked file Git does not convert is its blob's bytes.
    if ((await input.git(['status', '--porcelain', '--ignore-submodules=none'])).trim()) { changing = ['the worktree']; continue }
    const tracked = await trackedFiles(input.git)
    const regular = proof.filter((entry) => entry.kind === 'file' && /^100(?:644|755)$/.test(tracked.get(entry.path)?.mode ?? ''))
    const converted = new Set(regular.length ? await convertedPathsAsync(top, regular.map((entry) => entry.path)) : [])
    // A filter driver must never run: a file under one is compared with its blob's own bytes instead of Git's form.
    const filtered = converted.size ? await filteredPaths(top, [...converted]) : new Set<string>()
    const asked = (paths: string[], raw: boolean) => paths.length ? gitsFormsAsync(top, paths.map((path) => ({ path, blob: tracked.get(path)!.blob })), { raw }) : Promise.resolve(new Map<string, { bytes: number; digest: string }>())
    const [forms, raws] = await Promise.all([asked([...converted].filter((path) => !filtered.has(path)), false), asked([...filtered], true)])
    const held = new Set(regular.filter((entry) => {
      if (!converted.has(entry.path)) return true
      const form = (filtered.has(entry.path) ? raws : forms).get(entry.path)
      return form !== undefined && form.bytes === entry.bytes && form.digest === entry.digest
    }).map((entry) => entry.path))
    // Copying one would have Git read the index again, which can run the driver: the worktree stays, and the file is named.
    const unheldFiltered = [...filtered].filter((path) => !held.has(path))
    if (unheldFiltered.length) return kept('keep_copy_refused', `${unheldFiltered.slice(0, 3).join(', ')} ${unheldFiltered.length === 1 ? 'is' : 'are'} written by a filter driver and ${unheldFiltered.length === 1 ? 'differs' : 'differ'} from what Git stores; cleanup cannot keep a copy without running the driver.`)
    const deleted = input.keep.deleteIgnored ? new Set(input.ignored) : undefined
    const paths = proof.filter((entry) => entry.kind !== 'directory' && !held.has(entry.path) && !deleted?.has(entry.path)).map((entry) => entry.path)
    if (!paths.length) return { proof, files: 0 }
    let copy: KeptCopy
    try {
      copy = await keepCopy({ owner: input.keep.owner, top, operationType: 'worktree-cleanup', action: 'Worktree cleanup', paths })
    } catch (error) {
      if (!(error instanceof KeepCopyRefusedError)) throw error
      return kept(error instanceof KeepCopyTooLargeError ? 'keep_copy_too_large' : 'keep_copy_refused', error.message.replace(/ Nothing was changed\..*$/s, ''))
    }
    const expected = new Map(proof.map((entry) => [entry.path, entry.digest]))
    changing = paths.filter((path) => copy.digests.get(path) !== expected.get(path))
    if (!changing.length) return { proof, copy, files: paths.length }
  }
  return kept('keep_copy_refused', `${changing.slice(0, 3).join(', ')} kept changing while cleanup copied it.`)
}

/**
 * Cleans up a clean worktree with nothing in the way of a copy (see the module comment). The caller holds the owner's
 * and the repository's locks.
 */
export async function verifiedCleanupAsync(input: CleanupInput): Promise<Removed | { kept: Kept }> {
  const { keep, worktreePath, branch } = input
  const ignoredFiles = keep.deleteIgnored ? 0 : input.ignored.length
  const holds = ignoredFiles ? `Kept, ${plural(ignoredFiles, 'ignored file')}` : 'Kept'
  keep.record?.({ phase: 'keeping', files: ignoredFiles })
  let commonDir: string, gitFile: string
  try {
    commonDir = (await linkedAdminDir(worktreePath)).commonDir
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
  const files = await captureFilesAsync(input, holds, ignoredFiles)
  if ('kept' in files) return files
  const adminKept = await keepExistingCommit({ owner: keep.owner, top: worktreePath, operationType: 'worktree-cleanup', sha: admin.commit })
  const lockedNow = await worktreeLockAsync(commonDir, worktreePath)
  if (lockedNow !== undefined) return { kept: { ignoredFiles, code: 'worktree_locked', reason: `${holds}: ${lockedText(lockedNow, worktreePath, 'cleanup')}` } }

  const deletingPath = join(dirname(worktreePath), `.deleting-${randomBytes(8).toString('hex')}`)
  const record: CleanupRecord = {
    schemaVersion: 1, worktreePath, deletingPath, branch, repositoryRoot: input.repositoryRoot, commonDir, owner: keep.owner, ignoredFiles,
    startedAt: new Date().toISOString(), adminState, gitFile, proof: files.proof,
    ...(files.copy ? { copy: { ref: files.copy.ref, sha: files.copy.sha, files: files.files } } : {}),
    late: [], admin: [{ ref: adminKept.ref, sha: admin.commit }]
  }
  const recordPath = cleanupRecordPath(deletingPath)
  // Recorded before the folder moves: a process that ends from here on leaves the folder at one of its two names.
  atomicWriteJsonSync(recordPath, record)
  keep.record?.({ phase: 'deleting', ...(record.copy ? { ref: record.copy.ref, sha: record.copy.sha } : {}), files: ignoredFiles, admin: record.admin[0]!, path: deletingPath })
  try {
    await renameFolderAsync(worktreePath, deletingPath)
  } catch (error) {
    await rm(recordPath, { force: true })
    return { kept: { ignoredFiles, code: 'cleanup_stopped', reason: `${holds}: files in it are in use (${firstLine(error)}), so cleanup left it where it is.` } }
  }
  const finished = await finishCleanupAsync(recordPath, record, input.beforeRemove)
  if (finished !== 'restart') return finished
  await rm(recordPath, { force: true })
  return { kept: { ignoredFiles, code: 'cleanup_stopped', reason: `${holds}: it went back to ${worktreePath} while cleanup was deleting it.` } }
}

/**
 * Finishes a cleanup a process left part way, against its recorded proof: the renamed folder is compared and deleted, a
 * folder already gone is unregistered. `restart` means it never moved: the record goes, and the caller cleans the
 * worktree up afresh. The caller holds the owner's and the repository's locks.
 */
export async function resumeCleanupAsync(found: { path: string; record: CleanupRecord }, beforeRemove?: (path: string) => void): Promise<Removed | { kept: Kept } | 'restart'> {
  const finished = await finishCleanupAsync(found.path, found.record, beforeRemove)
  if (finished === 'restart') await rm(found.path, { force: true })
  return finished
}

async function finishCleanupAsync(recordPath: string, record: CleanupRecord, beforeRemove?: (path: string) => void): Promise<Removed | { kept: Kept } | 'restart'> {
  const save = (): void => atomicWriteJsonSync(recordPath, record)
  const holds = record.ignoredFiles ? `Kept, ${plural(record.ignoredFiles, 'ignored file')}` : 'Kept'
  const stop = async (reason: string): Promise<{ kept: Kept }> => {
    // What is left stays a working worktree.
    await restoreGitFile(record)
    record.stopped = { reason, at: new Date().toISOString() }
    save()
    return { kept: { ignoredFiles: record.ignoredFiles, code: 'cleanup_stopped', reason: `${holds}: ${reason}`, path: record.deletingPath } }
  }
  if (!await exists(record.deletingPath)) {
    if (await exists(record.worktreePath)) return 'restart'
    return unregister(recordPath, record, stop)
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
      walk: CLEANUP_WALK,
      ...(beforeRemove ? { beforeRemove } : {}),
      steps: {
        // The owner's and the repository's locks are held for the whole cleanup.
        begin: async () => undefined,
        held: async () => () => undefined,
        recaptureAdmin: async (folder) => {
          const state = await adminStateAt(folder)
          if (state === record.adminState) return
          const admin = await storeAdminBeforeRemoval(folder, [`refs/heads/${record.branch}`])
          const kept = await keepExistingCommit({ owner: record.owner, top: folder, operationType: 'worktree-cleanup', sha: admin.commit })
          record.admin.push({ ref: kept.ref, sha: admin.commit })
          record.adminState = state
          save()
        },
        keepLate: async (late) => {
          const outcome = await keepLateWrites(record, late)
          if (outcome) refused = outcome.kept
          return outcome
        },
        save: ({ changedAt, content }) => {
          if (content) { record.proof = content; grew = true }
          record.changedAt = changedAt
          save()
        }
      }
    })
    if (!stopped) return unregister(recordPath, record, stop)
    if (refused || stopped.readOnly) return stop(stopped.kept)
    // Without growth the delete stopped for a reason of its own, unless it was a write after `.git` went: that one is
    // kept in the next round, once `.git` is back.
    if (!grew && (await lstat(join(record.deletingPath, '.git')).catch(() => undefined))?.isFile()) return stop(stopped.kept)
  }
  return stop(`files in it kept changing while cleanup was deleting it, ${CLEANUP_ROUNDS} times. Every version is kept as a copy, and what is left of it is at ${record.deletingPath}.`)
}

/** Writes the worktree's `.git` file back into what is left of it, when it is gone; never over anything there. */
async function restoreGitFile(record: CleanupRecord): Promise<void> {
  if (!await exists(record.deletingPath)) return
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
    return { kept: `Cleanup stopped and kept the worktree at ${late.root}: ${firstLine(error)}` }
  }
  const expected = new Map(late.entries.map((entry) => [entry.path, entry.digest]))
  const changed = late.files.find((path) => copy.digests.get(path) !== expected.get(path))
  if (changed) return { kept: `Cleanup stopped and kept the worktree at ${late.root}: ${changed} changed while its copy was being kept` }
  record.late.push({ ref: copy.ref, sha: copy.sha, files: late.files.length })
  return undefined
}

/** The folder is gone: Git's registration of the worktree at its old path goes, then the record. */
async function unregister(recordPath: string, record: CleanupRecord, stop: (reason: string) => Promise<{ kept: Kept }>): Promise<Removed | { kept: Kept }> {
  const outcome = await unregisterDeletedAsync({
    commonDir: record.commonDir,
    path: record.worktreePath,
    place: 'cleanup',
    held: async () => () => undefined,
    unregistered: async () => { await rm(recordPath, { force: true }) }
  })
  if ('kept' in outcome) return stop(outcome.kept)
  const windowMs = keptCopyWindowMs(record.owner)
  return {
    ...(record.copy ? { copy: { ...record.copy, windowMs } } : {}),
    admin: { ...record.admin[0]!, windowMs },
    ...(record.late.length ? { late: record.late.map((copy) => ({ ...copy, windowMs })) } : {})
  }
}
