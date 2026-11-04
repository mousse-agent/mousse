import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withScopedGitConfig } from '../git/gitEnv'
import { gitAsync } from './git'
import { gitsFormsAsync, type GitsForm } from './heldBytes'

/**
 * Whether a file under a filter comes back as it is (`snapshots.ts`, the exact-bytes note). A filter's clean form is
 * what Git stores; its smudge of that is what a restore writes. The two meet only when the filter round-trips (Git LFS,
 * git-crypt). A lossy one (`nbstripout`, a whitespace stripper with a `cat` smudge) or a smudge that adds bytes does not,
 * and a restore of Git's form alone would lose the file's bytes. So each file is read once, and its bytes are compared
 * with Git's form of its stored blob, written by the smudge (`gitsFormsAsync`), with whatever drivers the checkout runs:
 * none in a checkout no driver may run in, where Git's form is the blob as it is. Equal blob ids prove nothing (a smudge
 * that appends), so the comparison always runs. A lossy file's bytes are stored from that same read, never read again:
 * no object is ever written for bytes that were not the ones compared.
 *
 * - A smudge never fetches: Git LFS runs with `GIT_LFS_SKIP_SMUDGE=1`, and Git's form is then its pointer. A pointer
 *   naming the file's own SHA-256 and size holds it (the media is in Git LFS's store already).
 * - A smudge that fails is never read as a verdict: every driver that may run is required for the check, so Git stops
 *   instead of going on with the stored blob, and a reported failure fails the check too. The file is not checked.
 * - The work is bounded per snapshot ({@link ROUND_TRIP_BUDGET}): files, time (Git is stopped at the deadline, and a
 *   read too), and the bytes stored. What is left is answered as not checked or not stored yet, for a later snapshot.
 */

/** At most this many files, this much time, and this many stored bytes per snapshot. Changed by tests. */
export const ROUND_TRIP_BUDGET = { files: 500, ms: 2000, storeBytes: 200 * 1024 ** 2 }

/** Files checked together: one `cat-file` for Git's form, and their bytes read at the same time. */
const BATCH = 32

export interface RoundTripAsk {
  path: string
  /** The blob id of the file's bytes on disk, from the drivers-off index. */
  raw: string
  /** The blob Git stores for it (the snapshot's tree). */
  normal: string
  /** For Git's form: the attributes of another tree (`GIT_ATTR_SOURCE`), for a file whose filter applied there. */
  source?: string
  /** False for a file whose bytes could not be written back as they are: compared, never stored. */
  store?: false
}

/**
 * Same: Git's form of the stored blob is the file's bytes. Lossy: it is not; `stored` says whether the bytes compared
 * were written as the object `raw` names, and otherwise why not (`size`: over the limit; `budget`: past the snapshot's
 * stored bytes; `failed`: the write failed).
 */
export interface RoundTrip { verdict: 'same' | 'lossy'; size: number; stored?: Stored }
export type Stored = true | 'size' | 'budget' | 'failed'

/** What a check needs besides the files. */
export interface RoundTripOptions {
  /** Where the bytes to store are put for Git to read (Mousse's own folder in the Git directory). */
  directory: string
  /** Files over this many bytes are compared, never stored. */
  limit: number
  /** The settings that empty every driver: Git stores the bytes with none. */
  driversOff: ReadonlyArray<readonly [string, string]>
  /** The settings that make every driver that may run required, so a failing one stops Git. */
  required: ReadonlyArray<readonly [string, string]>
  /** The bytes this snapshot may still store, shared by every call in it. */
  storeBudget: { left: number }
}

/** The file's bytes read once: their size, SHA-256 and the bytes themselves when within `limit`. */
interface Read { size: number; digest: string; bytes?: Buffer }

/**
 * Reads `path` once, when it is still the bytes whose blob id is `raw`: the whole file into memory up to `limit`, past
 * it only its size and digest. Undefined when it is no plain file, changed since its id was read, or `deadline` passed.
 */
async function readOnceAsync(top: string, path: string, raw: string, limit: number, deadline: number): Promise<Read | undefined> {
  const absolute = join(top, path)
  try {
    const before = await lstat(absolute)
    if (!before.isFile()) return undefined
    const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const digest = createHash('sha256')
      // The blob id is SHA-1 or SHA-256, as the repository's: its header holds the size `lstat` gave.
      const id = createHash(raw.length === 64 ? 'sha256' : 'sha1').update(`blob ${before.size}\0`)
      const whole = before.size <= limit ? Buffer.alloc(before.size) : undefined
      const chunk = whole ?? Buffer.alloc(1024 * 1024)
      let size = 0
      for (;;) {
        if (Date.now() >= deadline) return undefined
        const into = whole ? size : 0
        const room = whole ? whole.length - size : chunk.length
        // Past the expected end, one byte more shows a file that grew.
        const { bytesRead } = room ? await file.read(chunk, into, room, size) : await file.read(Buffer.alloc(1), 0, 1, size)
        if (!bytesRead) break
        if (!room) return undefined
        const part = chunk.subarray(into, into + bytesRead)
        digest.update(part); id.update(part)
        size += bytesRead
      }
      // Changed since the index read it: answered by a later snapshot.
      if (size !== before.size || id.digest('hex') !== raw) return undefined
      return { size, digest: digest.digest('hex'), ...(whole ? { bytes: whole } : {}) }
    } finally {
      await file.close()
    }
  } catch {
    return undefined
  }
}

/** The SHA-256 and size a Git LFS pointer names, when `form` is one. */
function lfsPointer(form: GitsForm): { oid: string; size: number } | undefined {
  const text = form.head?.toString('utf8')
  const match = text ? /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:[^\n]*\n)*?oid sha256:([0-9a-f]{64})\n(?:[^\n]*\n)*?size (\d+)\n/.exec(text) : null
  return match ? { oid: match[1]!, size: Number(match[2]) } : undefined
}

/** A pointer is at most 1 KiB; Git's form is kept whole up to that. */
const POINTER_BYTES = 1024

/**
 * Git's form of each ask's blob, by path; a batch Git stops on (a failed smudge) is split until the files that stop it
 * are found, while there is time, and those are left out. Git is stopped at `deadline`, answering what it finished.
 */
async function formsAsync(top: string, asks: readonly RoundTripAsk[], deadline: number, required: RoundTripOptions['required']): Promise<Map<string, GitsForm>> {
  if (!asks.length || Date.now() >= deadline) return new Map()
  const env = { GIT_LFS_SKIP_SMUDGE: '1', ...(asks[0]?.source ? { GIT_ATTR_SOURCE: asks[0].source } : {}) }
  try {
    return await withScopedGitConfig(required, () => gitsFormsAsync(top, asks.map((ask) => ({ path: ask.path, blob: ask.normal })), { env, strict: true, deadline, keepBytes: POINTER_BYTES }))
  } catch {
    if (asks.length === 1) return new Map()
    const half = Math.ceil(asks.length / 2)
    const first = await formsAsync(top, asks.slice(0, half), deadline, required)
    return new Map([...first, ...await formsAsync(top, asks.slice(half), deadline, required)])
  }
}

/**
 * Stores each of `items`' bytes as a blob, with no filter and no driver, through files of Mousse's own (so a path's name
 * never reaches Git), and returns the paths whose blob is the id they were checked as. Never throws: a failure stores
 * nothing for those paths.
 */
export async function storeBytesAsync(top: string, items: ReadonlyArray<{ path: string; raw: string; bytes: Buffer }>, options: Pick<RoundTripOptions, 'directory' | 'driversOff'>): Promise<Set<string>> {
  const stored = new Set<string>()
  if (!items.length || /[\n\r"]/.test(options.directory)) return stored
  let folder: string | undefined
  try {
    folder = await mkdtemp(join(options.directory, 'filtered-'))
    const files = items.map((_, at) => join(folder!, String(at)))
    await Promise.all(items.map((item, at) => writeFile(files[at]!, item.bytes, { flag: 'wx' })))
    const ids = (await withScopedGitConfig(options.driversOff, () => gitAsync(top, ['hash-object', '-w', '--no-filters', '--stdin-paths'], undefined, files.join('\n') + '\n'))).split('\n')
    for (const [at, item] of items.entries()) if (ids[at] === item.raw) stored.add(item.path)
  } catch {
    // Nothing is named stored that Git did not answer for.
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
  return stored
}

/**
 * Reads each of `items` once and stores its bytes when they are still the ones `raw` names, within the snapshot's
 * stored bytes: for a file a snapshot already found lossy whose bytes no object holds yet. A path left out changed
 * since, or the time ran out.
 */
export async function storeCheckedAsync(top: string, items: ReadonlyArray<{ path: string; raw: string }>, options: RoundTripOptions): Promise<Map<string, Stored>> {
  const answers = new Map<string, Stored>()
  const deadline = Date.now() + ROUND_TRIP_BUDGET.ms
  for (let start = 0; start < items.length; start += BATCH) {
    const batch = items.slice(start, start + BATCH)
    const reads = await Promise.all(batch.map((item) => readOnceAsync(top, item.path, item.raw, options.limit, deadline)))
    const writes: Array<{ path: string; raw: string; bytes: Buffer }> = []
    for (const [at, item] of batch.entries()) {
      const read = reads[at]
      if (!read) continue
      if (!read.bytes) answers.set(item.path, 'size')
      else if (read.size > options.storeBudget.left) answers.set(item.path, 'budget')
      else { options.storeBudget.left -= read.size; writes.push({ ...item, bytes: read.bytes }) }
    }
    const stored = await storeBytesAsync(top, writes, options)
    for (const write of writes) answers.set(write.path, stored.has(write.path) ? true : 'failed')
  }
  return answers
}

/**
 * Checks as many of `asks` as the budget allows, in order, and stores each lossy file's bytes from the read compared. A
 * path absent from the answer is not checked yet: the budget ran out, its bytes changed since its blob id was read, its
 * smudge failed, or Git could not be asked about its name.
 */
export async function roundTripsAsync(top: string, asks: readonly RoundTripAsk[], options: RoundTripOptions): Promise<Map<string, RoundTrip>> {
  const answers = new Map<string, RoundTrip>()
  const deadline = Date.now() + ROUND_TRIP_BUDGET.ms
  const groups = new Map<string, RoundTripAsk[]>()
  for (const ask of asks) groups.set(ask.source ?? '', [...groups.get(ask.source ?? '') ?? [], ask])
  let count = 0
  for (const group of groups.values()) {
    for (let start = 0; start < group.length; start += BATCH) {
      if (count >= ROUND_TRIP_BUDGET.files || Date.now() >= deadline) return answers
      const batch = group.slice(start, start + Math.min(BATCH, ROUND_TRIP_BUDGET.files - count))
      count += batch.length
      const [reads, forms] = await Promise.all([Promise.all(batch.map((ask) => readOnceAsync(top, ask.path, ask.raw, options.limit, deadline))), formsAsync(top, batch, deadline, options.required)])
      const writes: Array<{ path: string; raw: string; bytes: Buffer }> = []
      for (const [at, ask] of batch.entries()) {
        const read = reads[at]
        const form = forms.get(ask.path)
        if (!read || !form) continue
        const pointer = lfsPointer(form)
        const same = (form.bytes === read.size && form.digest === read.digest) || (pointer !== undefined && pointer.oid === read.digest && pointer.size === read.size)
        if (same) { answers.set(ask.path, { verdict: 'same', size: read.size }); continue }
        if (ask.store === false) answers.set(ask.path, { verdict: 'lossy', size: read.size })
        else if (!read.bytes) answers.set(ask.path, { verdict: 'lossy', size: read.size, stored: 'size' })
        else if (read.size > options.storeBudget.left) answers.set(ask.path, { verdict: 'lossy', size: read.size, stored: 'budget' })
        else { options.storeBudget.left -= read.size; writes.push({ path: ask.path, raw: ask.raw, bytes: read.bytes }) }
      }
      const stored = await storeBytesAsync(top, writes, options)
      for (const write of writes) answers.set(write.path, { verdict: 'lossy', size: write.bytes.length, stored: stored.has(write.path) ? true : 'failed' })
    }
  }
  return answers
}
