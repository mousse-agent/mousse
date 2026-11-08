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
 * against. A path that changed is left as it is.
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { ThreadJournal } from '../data/ThreadJournal'
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

/** What a revert left at one path. */
export interface RevertedPath {
  path: string
  work: PathDigest
  /** Project folders: the digest of the path's index entries (`stagedEntryDigests`), null for none. */
  index?: string | null
}

/** The record of one revert in its owner's journal (`details.revert`). */
export interface RevertRecord {
  version: 1
  top: string
  path: string
  oldPath?: string
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

/** {@link pathDigest}, synchronously, for the last check before a write. */
function pathDigestSync(top: string, path: string): PathDigest {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    let info
    try { info = lstatSync(absolute(top, path.slice(0, slash))) } catch (error) { if (gone(error)) return null; throw error }
    if (!info.isDirectory()) return 'other'
  }
  const full = absolute(top, path)
  let info
  try { info = lstatSync(full) } catch (error) { if (gone(error)) return null; throw error }
  if (info.isSymbolicLink()) return linkDigest(readlinkSync(full, { encoding: 'buffer' }))
  if (info.isFile()) return fileDigest(readFileSync(full))
  return 'other'
}

/** What a proven write puts at a path. */
export type Replacement =
  | { kind: 'file'; bytes: Buffer; mode: number }
  | { kind: 'link'; target: Buffer }
  | { kind: 'absent' }

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

/**
 * Puts `next` at `path` only while what stands there is still `expected`. The new bytes are written beside it first;
 * then, with nothing awaited, the path is read and compared once more and the new file renamed over it (or the path
 * removed, or the link made). Returns false, with nothing changed, when the path changed.
 */
export async function replaceProven(top: string, path: string, expected: PathDigest, next: Replacement): Promise<boolean> {
  if (next.kind !== 'absent' && !await foldersAbove(top, path)) return false
  const full = absolute(top, path)
  const temporary = next.kind === 'file' ? join(dirname(full), `.mousse-revert-${randomUUID()}.tmp`) : undefined
  if (temporary && next.kind === 'file') {
    await writeFile(temporary, next.bytes, { flag: 'wx', mode: next.mode })
    // The process's umask narrows what `writeFile` makes; the file gets exactly these bits.
    await chmod(temporary, next.mode)
  }
  try {
    // From here to the change, nothing is awaited: a write that lands meanwhile is found by this read.
    if (pathDigestSync(top, path) !== expected) return false
    if (next.kind === 'absent') {
      if (expected !== null) unlinkSync(full)
      return true
    }
    if (next.kind === 'link') {
      if (expected !== null) unlinkSync(full)
      symlinkSync(next.target.toString(), full)
      return true
    }
    try {
      renameSync(temporary!, full)
    } catch (error) {
      // Windows refuses to rename over a file another program holds open without sharing its deletion: written in place.
      if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      writeFileSync(full, next.bytes)
      chmodSync(full, next.mode)
    }
    return true
  } finally {
    if (temporary) rmSync(temporary, { force: true })
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

/** Every revert the owner recorded for the repository at `top`, newest first. */
export function revertsOf(owner: string, top?: string): FoundRevert[] {
  const journal = new ThreadJournal(owner, { readOnly: true })
  const found = new Map<string, FoundRevert>()
  const restored = new Set<string>()
  for (const entry of journal.list()) {
    if (entry.operationType === REVERT_RESTORED_OPERATION) {
      const id = (entry.details as { revertId?: unknown } | undefined)?.revertId
      if (typeof id === 'string') restored.add(id)
      continue
    }
    if (entry.operationType !== REVERT_OPERATION) continue
    const details = entry.details as KeepOutcome | undefined
    const record = details?.revert
    if (!record || record.version !== 1 || !details?.ref || !details.sha) continue
    if (top && !sameFolder(record.top, top)) continue
    found.set(entry.operationId, { revertId: entry.operationId, ref: details.ref, sha: details.sha, record, restored: false })
  }
  return [...found.values()].map((item) => ({ ...item, restored: restored.has(item.revertId) })).sort((a, b) => b.record.at - a.record.at)
}

export function findRevert(owner: string, revertId: string): FoundRevert | undefined {
  return revertsOf(owner).find((item) => item.revertId === revertId)
}

/** What a revert did, in a few words. */
export function revertSummary(path: string, oldPath: string | undefined, hunks: number, lines: number): string {
  const name = oldPath !== undefined ? `${oldPath} → ${path}` : path
  if (lines) return `${lines} ${lines === 1 ? 'line' : 'lines'} of ${name}`
  if (hunks) return `${hunks} ${hunks === 1 ? 'hunk' : 'hunks'} of ${name}`
  return name
}
