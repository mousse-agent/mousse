import { spawn } from 'node:child_process'
import { createHash, randomUUID, type Hash } from 'node:crypto'
import { readFrozenEntryAsync, type FrozenEntryProof } from '../lifecycle/verifiedDelete'
import { gitEnv, guardedAsync } from './git'

/**
 * Which files on disk a restore can remove without a copy: those whose bytes are exactly what Git writes back from their
 * blob in the snapshot (line endings, an encoding and filters applied). Git's own check before it writes over a file
 * compares the file's normal form, so it cannot tell two raw forms of one normal form apart (CRLF and LF under
 * `core.autocrlf`, two byte orders of UTF-16). Each file is read once, between two `lstat`s that agree
 * (`readFrozenEntryAsync`), and compared with Git's form of its blob, streamed from one `cat-file` at the same time
 * ({@link gitsFormsAsync}). The restore keeps the others first, then removes and writes through `provenDiscard.ts`.
 */

/** Files read together, so a large restore is not walked one call at a time. */
const BATCH = 64

/** A file as it was read: what proves it, and whether its bytes are the ones Git writes back from its blob. */
export interface ConvertedRead { path: string; proof: FrozenEntryProof; held: boolean }

/**
 * Reads each of `paths` that is on disk once and compares it with Git's form of its blob in `blobs`, or, for a path in
 * `raw` (whose blob holds the file's exact bytes, see `snapshots.ts`), with the blob itself. A path that is gone is left
 * out (nothing to keep); one that is not a plain file, or changes while it is read, is `changed`.
 */
export async function readConvertedAsync(top: string, blobs: ReadonlyMap<string, string>, paths: readonly string[], raw: ReadonlySet<string> = new Set()): Promise<{ read: ConvertedRead[]; changed: string[] }> {
  // Git's form does not depend on the disk, so it streams while the files are read.
  const entries = paths.map((path) => ({ path, blob: blobs.get(path)! }))
  const converted = entries.filter((entry) => !raw.has(entry.path))
  const exact = entries.filter((entry) => raw.has(entry.path))
  const forms = Promise.all([gitsFormsAsync(top, converted), gitsFormsAsync(top, exact, { raw: true })]).then(([a, b]) => new Map([...a, ...b]))
  forms.catch(() => undefined)
  const proofs: FrozenEntryProof[] = []
  const changed: string[] = []
  const checked = new Set<string>()
  for (let start = 0; start < paths.length; start += BATCH) {
    await Promise.all(paths.slice(start, start + BATCH).map(async (path) => {
      try {
        const proof = await readFrozenEntryAsync(top, path, checked)
        if (proof.entry.kind === 'file') proofs.push(proof)
        else changed.push(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') changed.push(path)
      }
    }))
  }
  const written = await forms
  const held = (proof: FrozenEntryProof): boolean => {
    const form = written.get(proof.entry.path)
    return form !== undefined && form.bytes === proof.entry.bytes && form.digest === proof.entry.digest
  }
  return { read: proofs.map((proof) => ({ path: proof.entry.path, proof, held: held(proof) })), changed }
}

/** Runs one of Mousse's own Git commands with `input`, giving its output to `onData` as it comes. Rejects on failure. */
async function streamGitAsync(top: string, args: string[], input: string, onData: (chunk: Buffer) => void): Promise<void> {
  const argv = await guardedAsync(top, args, { stdin: input })
  await new Promise<void>((settle, fail) => {
    const child = spawn('git', argv, { cwd: top, env: gitEnv(top), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const errors: Buffer[] = []
    let failed: Error | undefined
    child.stdout.on('data', (chunk: Buffer) => { try { onData(chunk) } catch (error) { failed ??= error as Error; child.kill() } })
    child.stderr.on('data', (chunk: Buffer) => { if (errors.length < 64) errors.push(chunk) })
    child.on('error', fail)
    child.on('close', (code) => {
      if (failed) fail(failed)
      else if (code === 0) settle()
      else fail(new Error(`Command failed: git ${argv.join(' ')}\n${Buffer.concat(errors).toString('utf8').trim()}`))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

/**
 * The size and SHA-256 of what Git writes at each path from its blob there (`cat-file --batch --filters`, read as it
 * streams, never held whole), by path. A file is held when its bytes on disk have that size and SHA-256. With `raw`,
 * the blob's own bytes, never converted (`--filters` left off).
 *
 * Git's header gives the blob's size, not the converted size, so each record starts with a header of ours that begins
 * with a random marker and names the blob and path. A path is answered only when everything checks: the marker appears
 * exactly once per record and nowhere else, and the record's header names its blob and path. Anything else leaves the
 * path out, so its file counts as not held and is kept: never the other way round.
 *
 * `raw`: the blob's own bytes instead, with no conversion and no filter driver run, for a file whose driver must not
 * run: bytes equal to them are held by the blob as they are.
 */
export async function gitsFormsAsync(top: string, entries: ReadonlyArray<{ path: string; blob: string }>, options: { raw?: boolean } = {}): Promise<Map<string, { bytes: number; digest: string }>> {
  const forms = new Map<string, { bytes: number; digest: string }>()
  // Git reads one `<blob> <path>` per line and drops whitespace before the path: those few are kept without asking.
  const asked = entries.filter((entry) => !/[\n\r]/.test(entry.path) && !/^[ \t]/.test(entry.path))
  if (!asked.length) return forms
  const marker = `mousse-${randomUUID()}`
  const separator = Buffer.from(`\n${marker} `)
  const input = asked.map((entry) => `${entry.blob} ${entry.path}`).join('\n') + '\n'
  const records: Array<{ header: Buffer[]; headerBytes: number; headerDone: boolean; hash: Hash; length: number; last?: number }> = []
  let leading = 0
  let pending = Buffer.from('\n') // The stream as if it began with a line break, so every record starts with `separator`.
  const add = (bytes: Buffer): void => {
    if (!bytes.length) return
    const record = records.at(-1)
    if (!record) { leading += bytes.length; return }
    let at = 0
    if (!record.headerDone) {
      const end = bytes.indexOf(0x0a)
      const part = end < 0 ? bytes : bytes.subarray(0, end)
      record.headerBytes += part.length
      if (record.headerBytes <= 16_384) record.header.push(Buffer.from(part))
      if (end < 0) return
      record.headerDone = true
      at = end + 1
    }
    // The last byte is held back: at the end of the output it is the record's closing line break, not its bytes.
    const body = bytes.subarray(at)
    if (!body.length) return
    if (record.last !== undefined) { record.hash.update(Buffer.of(record.last)); record.length++ }
    record.hash.update(body.subarray(0, -1)); record.length += body.length - 1
    record.last = body[body.length - 1]
  }
  const close = (): void => {
    const record = records.at(-1)
    if (record?.last !== undefined) { record.hash.update(Buffer.of(record.last)); record.length++; record.last = undefined }
  }
  const scan = (final: boolean): void => {
    for (;;) {
      const found = pending.indexOf(separator)
      if (found < 0) break
      add(pending.subarray(0, found))
      close()
      records.push({ header: [], headerBytes: 0, headerDone: false, hash: createHash('sha256'), length: 0 })
      pending = pending.subarray(found + separator.length)
    }
    const keep = final ? 0 : Math.min(pending.length, separator.length - 1)
    add(pending.subarray(0, pending.length - keep))
    pending = Buffer.from(pending.subarray(pending.length - keep))
  }
  await streamGitAsync(top, ['cat-file', `--batch=${marker} %(objectname) %(rest)`, ...(options.raw ? [] : ['--filters'])], input, (chunk) => {
    pending = Buffer.concat([pending, chunk])
    scan(false)
  })
  scan(true)
  const end = records.at(-1)
  if (leading || records.length !== asked.length || end?.last !== 0x0a) return forms
  for (const [index, entry] of asked.entries()) {
    const record = records[index]!
    const header = Buffer.concat(record.header).toString('utf8')
    if (record.headerDone && record.headerBytes <= 16_384 && header === `${entry.blob} ${entry.path}`) forms.set(entry.path, { bytes: record.length, digest: record.hash.digest('hex') })
  }
  return forms
}
