/**
 * Revert of hunks or files (`git.revert`) and its restore (`git.restoreReverted`, `git.revertedList`).
 *
 * A revert keeps a copy first (`keepCopy`, operation `git-revert`), so the person's bytes and staged versions are in a
 * `refs/mousse/preserved/` ref their owner's Undo window keeps, then writes. The owner's journal records, under the
 * copy's own operation id (the `revertId`), what the revert left at each path: the working version's digest, the index
 * entries (project folders), and the thread overlay entries it changed. A restore writes the copy back only while every
 * path is still what the revert left, so nothing written since is lost.
 *
 * Every write here is proven the way a Discard proves its removals (`provenDiscard.ts`): right before the file changes,
 * synchronously, with nothing awaited in between, it is read again and compared with what the change was planned
 * against. A path that changed is left as it is. The paths of one restore change together or not at all
 * ({@link writeProven}), and in a project folder together with the index, under Git's own index lock.
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { ThreadJournal, type ThreadJournalRecord } from '../data/ThreadJournal'
import type { OverlayEntry, SelectionGit } from './gitSelection'

/** The journal operation type of a revert's kept copy and of its record (one of `KEEP_COPY_OPERATIONS`). */
export const REVERT_OPERATION = 'git-revert'
/** The journal operation type that notes a revert was restored. It keeps nothing and settles itself. */
export const REVERT_RESTORED_OPERATION = 'git-revert-restored'
/** How many reverts `git.revertedList` names at most, newest first. */
export const REVERTED_LIST_MAX = 200

/**
 * What stands at a path, as one string: `file:<sha256>` of a file's bytes, `link:<sha256>` of a link's target, `other`
 * for a folder or anything else (or a path below a link or a file), and null for nothing.
 */
export type PathDigest = string | null

/** A {@link PathDigest} for what Git could not tell: nothing on disk ever has it, so a restore finds the path changed. */
export const UNKNOWN_DIGEST = 'unknown'

/**
 * What a revert left at one path, worked out from what it wrote, never read back from disk: a save that lands just
 * after the write is someone's newer work, and must not be taken for the revert's.
 */
export interface RevertedPath {
  path: string
  /** The working version the revert wrote (null: it removed the path). */
  work: PathDigest
  /**
   * Project folders: the digest of the index entries the revert wrote (`stagedEntryDigests`), null for none. Absent
   * when the revert did not write the path's index (someone staged it meanwhile, say): a restore then neither compares
   * nor writes it, so their staging stays.
   */
  index?: string | null
}

/** The record of one revert in its owner's journal (`details.revert`). */
export interface RevertRecord {
  version: 1
  top: string
  path: string
  oldPath?: string
  /**
   * The paths the revert changed, which a restore puts back. A path of a whole-file revert that Discard's proof left
   * as it was (saved, or saved again, meanwhile) is not among them, so a restore never writes over that newer work.
   */
  paths: string[]
  after: RevertedPath[]
  /** Thread worktrees: the overlay entries of `paths` before and after the revert (null: none). */
  overlay?: { before: Record<string, OverlayEntry | null>; after: Record<string, OverlayEntry | null> }
  /** Each kept file's permission bits, which the copy's tree mode does not carry. */
  permissions?: Record<string, number>
  summary: string
  at: number
  windowMs: number
}

export interface FoundRevert {
  revertId: string
  ref: string
  sha: string
  record: RevertRecord
  restored: boolean
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
const absolute = (top: string, path: string): string => join(top, ...path.split('/'))
const gone = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')

/** The digest of a file's bytes as {@link PathDigest} writes it. */
export const fileDigest = (data: Buffer): string => `file:${sha256(data)}`
/** The digest of a link's target as {@link PathDigest} writes it. */
export const linkDigest = (target: Buffer | string): string => `link:${sha256(target)}`

/** What stands at `path`, never read through a link: a path below a link or a file is `other`. */
export async function pathDigest(top: string, path: string): Promise<PathDigest> {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    const info = await lstat(absolute(top, path.slice(0, slash))).catch((error: unknown) => { if (gone(error)) return undefined; throw error })
    if (!info) return null
    if (!info.isDirectory()) return 'other'
  }
  const full = absolute(top, path)
  const info = await lstat(full).catch((error: unknown) => { if (gone(error)) return undefined; throw error })
  if (!info) return null
  if (info.isSymbolicLink()) return linkDigest(await readlink(full, { encoding: 'buffer' }))
  if (info.isFile()) return fileDigest(await readFile(full))
  return 'other'
}

/** What stood at a path at the last check: put back if a later write of the same batch fails. */
type Found = { kind: 'file'; bytes: Buffer; mode: number } | { kind: 'link'; target: Buffer } | { kind: 'absent' } | { kind: 'other' }

/** {@link pathDigest}, synchronously, for the last check before a write, with what stands there. */
function foundSync(top: string, path: string): { digest: PathDigest; found: Found } {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    let info
    try { info = lstatSync(absolute(top, path.slice(0, slash))) } catch (error) { if (gone(error)) return { digest: null, found: { kind: 'absent' } }; throw error }
    if (!info.isDirectory()) return { digest: 'other', found: { kind: 'other' } }
  }
  const full = absolute(top, path)
  let info
  try { info = lstatSync(full) } catch (error) { if (gone(error)) return { digest: null, found: { kind: 'absent' } }; throw error }
  if (info.isSymbolicLink()) {
    const target = readlinkSync(full, { encoding: 'buffer' })
    return { digest: linkDigest(target), found: { kind: 'link', target } }
  }
  if (info.isFile()) {
    const bytes = readFileSync(full)
    return { digest: fileDigest(bytes), found: { kind: 'file', bytes, mode: info.mode & 0o7777 } }
  }
  return { digest: 'other', found: { kind: 'other' } }
}

/** What a proven write puts at a path. */
export type Replacement =
  | { kind: 'file'; bytes: Buffer; mode: number }
  | { kind: 'link'; target: Buffer }
  | { kind: 'absent' }

/** One path of {@link writeProven}: `next` goes there only while what stands there is `expected`. */
export interface ProvenWrite {
  path: string
  expected: PathDigest
  next: Replacement
}

/** Makes the folders above `path` that are missing, never through a link; false when a file or link is in the way. */
async function foldersAbove(top: string, path: string): Promise<boolean> {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    const folder = absolute(top, path.slice(0, slash))
    const info = await lstat(folder).catch(() => undefined)
    if (!info) await mkdir(folder).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    else if (!info.isDirectory()) return false
  }
  return true
}

/** The kind of link Windows needs for `target` at `full` (other systems ignore it): a folder's, or a file's. */
function linkTypeFor(full: string, target: string): 'dir' | 'file' {
  try { return statSync(resolve(dirname(full), target)).isDirectory() ? 'dir' : 'file' } catch { return 'file' }
}

const moveRefused = (error: unknown): boolean => ['EXDEV', 'EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException)?.code ?? '')

/** Removes the file or link standing at `full`, if any. A folder is never removed: a path holding one is never written. */
function clearSync(full: string, found: Found): void {
  if (found.kind === 'file' || found.kind === 'link') unlinkSync(full)
}

/** Puts back what stood at a path before a write of a batch that failed later. */
function putBackSync(full: string, found: Found): void {
  try { unlinkSync(full) } catch (error) { if (!gone(error)) throw error }
  if (found.kind === 'file') {
    writeFileSync(full, found.bytes, { mode: found.mode })
    chmodSync(full, found.mode)
  } else if (found.kind === 'link') {
    symlinkSync(found.target.toString(), full, linkTypeFor(full, found.target.toString()))
  }
}

/** The change itself: the prepared file or link renamed over the path, or the path's file or link removed. */
function applySync(full: string, next: Replacement, found: Found, temporary: string | undefined): void {
  if (next.kind === 'absent') return clearSync(full, found)
  try {
    renameSync(temporary!, full)
    return
  } catch (error) {
    // The Git folder on another volume, or (Windows) a file another program holds open without sharing its deletion.
    if (!moveRefused(error)) throw error
  }
  if (next.kind === 'file') {
    // Written in place; a link standing there is removed first, never written through.
    if (found.kind === 'link') unlinkSync(full)
    writeFileSync(full, next.bytes)
    chmodSync(full, next.mode)
    return
  }
  clearSync(full, found)
  try {
    symlinkSync(next.target.toString(), full, linkTypeFor(full, next.target.toString()))
  } catch (error) {
    putBackSync(full, found)
    throw error
  }
}

/** The {@link PathDigest} a {@link Replacement} leaves at its path. */
const replacementDigest = (next: Replacement): PathDigest =>
  next.kind === 'file' ? fileDigest(next.bytes) : next.kind === 'link' ? linkDigest(next.target) : null

/** The {@link PathDigest} of what {@link foundSync} found. */
const foundDigest = (found: Found): PathDigest =>
  found.kind === 'file' ? fileDigest(found.bytes) : found.kind === 'link' ? linkDigest(found.target) : found.kind === 'absent' ? null : 'other'

/**
 * Puts back what stood at each path, trying every one even when one fails. A path already as it stood is left alone.
 * With `wrote`, a path is put back only while it still holds what the batch wrote there: anything else is someone's
 * newer work, which stays. Returns the paths that could not be put back.
 */
function putBackAllSync(top: string, items: ReadonlyArray<{ path: string; found: Found; wrote?: PathDigest }>): string[] {
  const left: string[] = []
  for (const item of items) {
    try {
      const now = foundSync(top, item.path)
      if (now.found.kind !== 'other' && now.digest === foundDigest(item.found)) continue
      if (item.wrote !== undefined && now.digest !== item.wrote) {
        left.push(item.path)
        continue
      }
      putBackSync(absolute(top, item.path), item.found)
    } catch {
      left.push(item.path)
    }
  }
  return left
}

/** `error`, naming the paths that could not be put back as they were. */
export function notPutBack(error: unknown, paths: readonly string[]): unknown {
  if (!paths.length) return error
  const cause = error instanceof Error ? error : new Error(String(error))
  const wrapped = new Error(`${cause.message} Not put back as before: ${paths.join(', ')}; the earlier versions are in the kept copy.`, { cause })
  return Object.assign(wrapped, { code: (cause as NodeJS.ErrnoException).code, notPutBack: [...paths] })
}

/** What {@link writeProvenUndoable} did. */
export interface ProvenWriteResult {
  /** The first path that changed since it was planned; nothing was written. */
  stopped?: string
  /**
   * Puts back what the writes replaced, where each path still holds what was written (newer work stays). For a step
   * after the writes that fails (the index that should change with them). Returns the paths it could not put back.
   */
  undo: () => string[]
}

/**
 * Makes every write of `writes`, or none. Each new file or link is made in `scratch` first (the repository's Git
 * folder, so a crash never leaves one in the working tree for `Commit all` to take). Then, with nothing awaited from
 * the first check to the last change, every path is read again and compared with its `expected`; one that changed
 * stops the batch before anything is written. A change that fails puts back what the batch had already changed, the
 * failing path's too; the error names any path that could not be put back.
 * Returns the first path that changed, or undefined when every write was made.
 */
export async function writeProven(top: string, scratch: string, writes: readonly ProvenWrite[]): Promise<string | undefined> {
  return (await writeProvenUndoable(top, scratch, writes)).stopped
}

/** {@link writeProven}, with a way to put the writes back if what should change with them fails. */
export async function writeProvenUndoable(top: string, scratch: string, writes: readonly ProvenWrite[]): Promise<ProvenWriteResult> {
  const nothing = (): string[] => []
  const prepared: Array<{ write: ProvenWrite; full: string; temporary?: string }> = []
  try {
    for (const write of writes) {
      if (write.next.kind !== 'absent' && !await foldersAbove(top, write.path)) return { stopped: write.path, undo: nothing }
      const full = absolute(top, write.path)
      if (write.next.kind === 'absent') {
        prepared.push({ write, full })
        continue
      }
      const temporary = join(scratch, `mousse-revert-${randomUUID()}.tmp`)
      prepared.push({ write, full, temporary })
      if (write.next.kind === 'file') {
        await writeFile(temporary, write.next.bytes, { flag: 'wx', mode: write.next.mode })
        // The process's umask narrows what `writeFile` makes; the file gets exactly these bits.
        await chmod(temporary, write.next.mode)
      } else {
        // A link that cannot be made (Windows without the right) fails here, before anything changed.
        const target = write.next.target.toString()
        await symlink(target, temporary, linkTypeFor(full, target))
      }
    }
    // From here to the last change, nothing is awaited: a write that lands meanwhile is found by this read.
    const found: Found[] = []
    for (const item of prepared) {
      const now = foundSync(top, item.write.path)
      if (now.digest !== item.write.expected || now.found.kind === 'other') return { stopped: item.write.path, undo: nothing }
      found.push(now.found)
    }
    let reached = 0
    try {
      for (; reached < prepared.length; reached++) {
        const item = prepared[reached]!
        applySync(item.full, item.write.next, found[reached]!, item.temporary)
      }
    } catch (error) {
      // The failing path may be half changed (a file written in place, a link removed), so it is put back too.
      const back = prepared.slice(0, reached + 1).map((item, at) => ({ path: item.write.path, found: found[at]! })).reverse()
      throw notPutBack(error, putBackAllSync(top, back))
    }
    const written = prepared.map((item, at) => ({ path: item.write.path, found: found[at]!, wrote: replacementDigest(item.write.next) })).reverse()
    let undone = false
    return {
      undo: () => {
        if (undone) return []
        undone = true
        return putBackAllSync(top, written)
      }
    }
  } finally {
    for (const item of prepared) if (item.temporary) rmSync(item.temporary, { force: true })
  }
}

/** A file's permission bits for a Git mode, when nothing better is known. */
export const modeBits = (mode: string | undefined): number => (mode === '100755' ? 0o755 : 0o644)

/** The blob of `bytes` as Git stores them at `path`: with its line-ending conversion (`path` set), or as they are. */
async function hashAs(git: SelectionGit, bytes: Buffer, path?: string): Promise<string | null> {
  const run = await git.bytes(['hash-object', ...(path === undefined ? ['--no-filters'] : [`--path=${path}`]), '--stdin'], { input: bytes }).catch(() => null)
  return run?.ok ? run.stdout.toString('utf8').trim() || null : null
}

/** The bytes of the index's own version of `path` (stage 0, a regular file), or null. */
async function indexedBytes(git: SelectionGit, path: string): Promise<Buffer | null> {
  const listed = await git.read(['ls-files', '-s', '-z', '--', `:(literal)${path}`]).catch(() => null)
  const line = listed?.ok ? listed.stdout.split('\0').find((item) => / 0\t/.test(item)) : undefined
  const [mode, oid] = line?.slice(0, line.indexOf('\t')).split(' ') ?? []
  if (!oid || (mode !== '100644' && mode !== '100755')) return null
  const run = await git.bytes(['cat-file', 'blob', oid]).catch(() => null)
  return run?.ok ? run.stdout : null
}

/**
 * The blob `git add` stores for `bytes` at `path`, or null when Git cannot tell. Only built-in line-ending conversion
 * applies: a file with a filter, `ident` or an encoding is whole-file only and never gets here.
 *
 * `hash-object --path` converts as `git add` does but reads no index, so it misses one rule `git add` follows: an
 * automatic conversion (`text=auto`, `core.autocrlf`) leaves a file alone when the index's version has CRLF (Git's
 * "safer autocrlf"). That rule is applied here, with Git itself answering each part: a conversion is automatic when it
 * leaves content that looks binary alone (`text` converts it too), and the index's version counts as having CRLF when
 * that conversion would change it (an automatic one changes text with CRLF only).
 */
export async function addedBlob(git: SelectionGit, path: string, bytes: Buffer): Promise<string | null> {
  const converted = await hashAs(git, bytes, path)
  const asIs = await hashAs(git, bytes)
  if (!converted || !asIs || converted === asIs) return converted
  const probe = Buffer.from('\0\r\n')
  const [probeConverted, probeAsIs] = [await hashAs(git, probe, path), await hashAs(git, probe)]
  if (!probeConverted || !probeAsIs) return null
  if (probeConverted !== probeAsIs) return converted
  const indexed = await indexedBytes(git, path)
  if (!indexed) return converted
  const [indexedConverted, indexedAsIs] = [await hashAs(git, indexed, path), await hashAs(git, indexed)]
  if (!indexedConverted || !indexedAsIs) return null
  return indexedConverted !== indexedAsIs ? asIs : converted
}

// ---------------------------------------------------------------------------------------------------------
// The owner's journal

interface KeepOutcome { phase?: string; ref?: string; sha?: string; revert?: RevertRecord }

/** Notes the revert in the owner's journal, as the outcome of its copy's own operation, so the sweep keeps both together. */
export function recordRevert(owner: string, revertId: string, ref: string, sha: string, record: RevertRecord): void {
  new ThreadJournal(owner).append({ operationId: revertId, operationType: REVERT_OPERATION, state: 'completed', details: { phase: 'outcome', ref, sha, revert: record } })
}

/** Notes that a revert was restored, so the list leaves it out. Its copy stays for the rest of its window. */
export function recordRestored(owner: string, revertId: string): void {
  new ThreadJournal(owner).append({ operationId: randomUUID(), operationType: REVERT_RESTORED_OPERATION, state: 'completed', details: { revertId } })
}

/** Whether two paths name the same folder on disk. */
export function sameFolder(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync.native(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}

/**
 * What each owner's journal says about reverts, read once: journal records are never changed once written, so a later
 * call reads only the records added since. A journal made anew (its folder replaced) is read again from the start.
 */
interface RevertIndex {
  folder: string
  last: string
  found: Map<string, Omit<FoundRevert, 'restored'>>
  restored: Set<string>
}
const revertIndexes = new Map<string, RevertIndex>()
const REVERT_INDEXES_MAX = 256

function revertIndexOf(owner: string): RevertIndex {
  const directory = join(owner, 'journal')
  let folder = 'none'
  let names: string[] = []
  try {
    const info = statSync(directory)
    folder = `${info.ino}:${info.birthtimeMs}`
    names = readdirSync(directory).filter((name) => /^\d{16}\.json$/.test(name)).sort()
  } catch (error) {
    if (!gone(error)) throw error
  }
  let index = revertIndexes.get(owner)
  if (!index || index.folder !== folder || (index.last && !names.includes(index.last))) {
    index = { folder, last: '', found: new Map(), restored: new Set() }
  }
  for (const name of names) {
    if (name <= index.last) continue
    const entry = JSON.parse(readFileSync(join(directory, name), 'utf8')) as ThreadJournalRecord
    index.last = name
    if (entry.operationType === REVERT_RESTORED_OPERATION) {
      const id = (entry.details as { revertId?: unknown } | undefined)?.revertId
      if (typeof id === 'string') index.restored.add(id)
      continue
    }
    if (entry.operationType !== REVERT_OPERATION) continue
    const details = entry.details as KeepOutcome | undefined
    const record = details?.revert
    if (!record || record.version !== 1 || !details?.ref || !details.sha) continue
    index.found.set(entry.operationId, { revertId: entry.operationId, ref: details.ref, sha: details.sha, record })
  }
  revertIndexes.delete(owner)
  revertIndexes.set(owner, index)
  if (revertIndexes.size > REVERT_INDEXES_MAX) revertIndexes.delete(revertIndexes.keys().next().value!)
  return index
}

/** Every revert the owner recorded for the repository at `top`, newest first. */
export function revertsOf(owner: string, top?: string): FoundRevert[] {
  const index = revertIndexOf(owner)
  return [...index.found.values()]
    .filter((item) => !top || sameFolder(item.record.top, top))
    .map((item) => ({ ...item, restored: index.restored.has(item.revertId) }))
    .sort((a, b) => b.record.at - a.record.at)
}

export function findRevert(owner: string, revertId: string): FoundRevert | undefined {
  const index = revertIndexOf(owner)
  const found = index.found.get(revertId)
  return found ? { ...found, restored: index.restored.has(revertId) } : undefined
}

/** What a revert did, in a few words. */
export function revertSummary(path: string, oldPath: string | undefined, hunks: number, lines: number): string {
  const name = oldPath !== undefined ? `${oldPath} → ${path}` : path
  if (lines) return `${lines} ${lines === 1 ? 'line' : 'lines'} of ${name}`
  if (hunks) return `${hunks} ${hunks === 1 ? 'hunk' : 'hunks'} of ${name}`
  return name
}
