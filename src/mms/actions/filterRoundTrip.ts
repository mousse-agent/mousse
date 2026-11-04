import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { gitsFormsAsync } from './heldBytes'

/**
 * Whether a file under a filter comes back as it is (`snapshots.ts`, the exact-bytes note). A filter's clean form is
 * what Git stores; its smudge of that is what a restore writes. The two meet only when the filter round-trips (Git LFS,
 * git-crypt). A lossy one (`nbstripout`, a whitespace stripper with a `cat` smudge) or a smudge that adds bytes does not,
 * and a restore of Git's form alone would lose the file's bytes. So each file's bytes on disk are compared with Git's
 * form of its stored blob, written by the smudge (`gitsFormsAsync`), with whatever drivers the checkout runs: none in a
 * checkout no driver may run in, where Git's form is the blob as it is. Equal blob ids prove nothing (a smudge that
 * appends), so the comparison always runs.
 *
 * The work is bounded per snapshot ({@link ROUND_TRIP_BUDGET}): what is left is answered as not checked yet, and a later
 * snapshot checks it.
 */

/** At most this many files, and about this much time, are checked in one snapshot. Changed by tests. */
export const ROUND_TRIP_BUDGET = { files: 500, ms: 2000 }

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
}

/** Same: Git's form of the stored blob is the file's bytes. Lossy: it is not. Failed: the smudge failed. */
export interface RoundTrip { verdict: 'same' | 'lossy' | 'failed'; size: number }

/** The size and SHA-256 of a file's bytes, read once, when they are still the bytes whose blob id is `raw`. */
async function rawBytesAsync(top: string, path: string, raw: string): Promise<{ size: number; digest: string } | undefined> {
  const absolute = join(top, path)
  try {
    const before = await lstat(absolute)
    if (!before.isFile()) return undefined
    const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const digest = createHash('sha256')
      // The blob id is SHA-1 or SHA-256, as the repository's: its header holds the size `lstat` gave.
      const id = createHash(raw.length === 64 ? 'sha256' : 'sha1').update(`blob ${before.size}\0`)
      const chunk = Buffer.alloc(1024 * 1024)
      let size = 0
      for (;;) {
        const { bytesRead } = await file.read(chunk, 0, chunk.length, size)
        if (!bytesRead) break
        digest.update(chunk.subarray(0, bytesRead)); id.update(chunk.subarray(0, bytesRead))
        size += bytesRead
      }
      // Changed since the index read it: answered by a later snapshot.
      if (size !== before.size || id.digest('hex') !== raw) return undefined
      return { size, digest: digest.digest('hex') }
    } finally {
      await file.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Git's form of each ask's blob, by path, or `failed` for one whose smudge failed: a batch Git stops on is split until
 * the file that stops it is found, while there is time.
 */
async function formsAsync(top: string, asks: readonly RoundTripAsk[], deadline: number): Promise<Map<string, { bytes: number; digest: string } | 'failed'>> {
  const env = asks[0]?.source ? { GIT_ATTR_SOURCE: asks[0].source } : undefined
  try {
    return await gitsFormsAsync(top, asks.map((ask) => ({ path: ask.path, blob: ask.normal })), env ? { env } : {})
  } catch {
    if (asks.length === 1) return new Map([[asks[0]!.path, 'failed']])
    if (Date.now() >= deadline) return new Map()
    const half = Math.ceil(asks.length / 2)
    const first = await formsAsync(top, asks.slice(0, half), deadline)
    return new Map([...first, ...await formsAsync(top, asks.slice(half), deadline)])
  }
}

/**
 * Checks as many of `asks` as the budget allows, in order. A path absent from the answer is not checked yet: the budget
 * ran out, its bytes changed since its blob id was read, or Git could not be asked about its name.
 */
export async function roundTripsAsync(top: string, asks: readonly RoundTripAsk[]): Promise<Map<string, RoundTrip>> {
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
      const [raws, forms] = await Promise.all([Promise.all(batch.map((ask) => rawBytesAsync(top, ask.path, ask.raw))), formsAsync(top, batch, deadline)])
      for (const [at, ask] of batch.entries()) {
        const raw = raws[at]
        const form = forms.get(ask.path)
        if (!raw || !form) continue
        answers.set(ask.path, { size: raw.size, verdict: form === 'failed' ? 'failed' : form.bytes === raw.size && form.digest === raw.digest ? 'same' : 'lossy' })
      }
    }
  }
  return answers
}
