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

/** How a streamed Git command ended: it finished, or `deadline` passed and it was stopped. */
interface Streamed { stopped: boolean; stderr: string }

/**
 * Runs one of Mousse's own Git commands with `input`, giving its output to `onData` as it comes. Rejects on failure. At
 * `deadline` (a time in ms), the command is stopped and the run ends as `stopped`, with the output it gave so far. Such
 * a command runs in a process group of its own, and the whole group is stopped: a filter program Git started never
 * outlives the run.
 */
async function streamGitAsync(top: string, args: string[], input: string, onData: (chunk: Buffer) => void, env?: NodeJS.ProcessEnv, deadline?: number): Promise<Streamed> {
  const argv = await guardedAsync(top, args, { stdin: input, ...(env ? { env } : {}) })
  const group = deadline !== undefined && process.platform !== 'win32'
  return await new Promise<Streamed>((settle, fail) => {
    const child = spawn('git', argv, { cwd: top, env: gitEnv(top, env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(group ? { detached: true } : {}) })
    const errors: Buffer[] = []
    let failed: Error | undefined
    let stopped = false
    const stopAll = (): void => {
      if (child.pid === undefined) return
      // Git first, so it never reports the filters it started as failed; then everything else in its group.
      if (group) { child.kill('SIGKILL'); try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }
      else if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill('SIGKILL'))
      else child.kill('SIGKILL')
    }
    const timer = deadline === undefined ? undefined : setTimeout(() => { stopped = true; stopAll() }, Math.max(0, deadline - Date.now()))
    child.stdout.on('data', (chunk: Buffer) => { if (stopped) return; try { onData(chunk) } catch (error) { failed ??= error as Error; child.kill() } })
    child.stderr.on('data', (chunk: Buffer) => { if (errors.length < 64) errors.push(chunk) })
    child.on('error', (error) => { if (timer) clearTimeout(timer); fail(error) })
    // Stopped: the group is gone, so its output closes at once. A program that left the group is not waited for long.
    child.on('exit', () => { if (stopped) setTimeout(() => settle({ stopped, stderr: Buffer.concat(errors).toString('utf8').trim() }), 250).unref() })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const stderr = Buffer.concat(errors).toString('utf8').trim()
      if (failed) fail(failed)
      else if (stopped) settle({ stopped, stderr })
      else if (code === 0) settle({ stopped, stderr })
      else fail(new Error(`Command failed: git ${argv.join(' ')}\n${stderr}`))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

/** What Git writes at a path: its size and SHA-256, and its bytes themselves when there are at most `keepBytes` of them. */
export interface GitsForm { bytes: number; digest: string; head?: Buffer }

/** Git's messages when a filter's program fails, which it reports and goes on from unless the filter is required. */
const FILTER_FAILED = /(external filter|smudge filter|clean filter)\b.*\bfailed|cannot fork to run external filter/i

/**
 * The size and SHA-256 of what Git writes at each path from its blob there (`cat-file --batch --filters`, read as it
 * streams, never held whole), by path. A file is held when its bytes on disk have that size and SHA-256. With `raw`,
 * the blob's own bytes, never converted (`--filters` left off). `env` goes to Git (`GIT_ATTR_SOURCE`, for the attributes
 * of another tree). With `strict`, a run where Git reports a failed filter program fails, though Git went on with the
 * blob as stored. With `deadline`, Git is stopped then, and only the paths it finished are answered. `keepBytes` keeps
 * the bytes of each form at most that long (`head`).
 *
 * Git's header gives the blob's size, not the converted size, so each record starts with a header of ours that begins
 * with a random marker and names the blob and path. A path is answered only when everything checks: the marker appears
 * exactly once per record and nowhere else, and the record's header names its blob and path. Anything else leaves the
 * path out, so its file counts as not held and is kept: never the other way round.
 */
export async function gitsFormsAsync(top: string, entries: ReadonlyArray<{ path: string; blob: string }>, options: { raw?: boolean; env?: NodeJS.ProcessEnv; strict?: boolean; deadline?: number; keepBytes?: number } = {}): Promise<Map<string, GitsForm>> {
  const forms = new Map<string, GitsForm>()
  // Git reads one `<blob> <path>` per line and drops whitespace before the path: those few are kept without asking.
  const asked = entries.filter((entry) => !/[\n\r]/.test(entry.path) && !/^[ \t]/.test(entry.path))
  if (!asked.length) return forms
  const keepBytes = options.keepBytes ?? 0
  const marker = `mousse-${randomUUID()}`
  const separator = Buffer.from(`\n${marker} `)
  const input = asked.map((entry) => `${entry.blob} ${entry.path}`).join('\n') + '\n'
  const records: Array<{ header: Buffer[]; headerBytes: number; headerDone: boolean; hash: Hash; length: number; last?: number; head: Buffer[]; headBytes: number }> = []
  let leading = 0
  let pending = Buffer.from('\n') // The stream as if it began with a line break, so every record starts with `separator`.
  const feed = (record: (typeof records)[number], bytes: Buffer): void => {
    record.hash.update(bytes); record.length += bytes.length
    if (record.headBytes <= keepBytes) { record.head.push(Buffer.from(bytes.subarray(0, keepBytes + 1 - record.headBytes))); record.headBytes += Math.min(bytes.length, keepBytes + 1 - record.headBytes) }
  }
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
    if (record.last !== undefined) feed(record, Buffer.of(record.last))
    feed(record, body.subarray(0, -1))
    record.last = body[body.length - 1]
  }
  const close = (): void => {
    const record = records.at(-1)
    if (record?.last !== undefined) { feed(record, Buffer.of(record.last)); record.last = undefined }
  }
  const scan = (final: boolean): void => {
    for (;;) {
      const found = pending.indexOf(separator)
      if (found < 0) break
      add(pending.subarray(0, found))
      close()
      records.push({ header: [], headerBytes: 0, headerDone: false, hash: createHash('sha256'), length: 0, head: [], headBytes: 0 })
      pending = pending.subarray(found + separator.length)
    }
    const keep = final ? 0 : Math.min(pending.length, separator.length - 1)
    add(pending.subarray(0, pending.length - keep))
    pending = Buffer.from(pending.subarray(pending.length - keep))
  }
  const ran = await streamGitAsync(top, ['cat-file', `--batch=${marker} %(objectname) %(rest)`, ...(options.raw ? [] : ['--filters'])], input, (chunk) => {
    pending = Buffer.concat([pending, chunk])
    scan(false)
  }, options.env, options.deadline)
  // A stopped run's finished records are whole: with every driver required, a failure among them would have ended Git.
  if (options.strict && !ran.stopped && FILTER_FAILED.test(ran.stderr)) throw new Error(`A filter failed: ${ran.stderr.split(/\r?\n/)[0]}`)
  // Stopped: each record a later one follows is whole; the last may not be.
  const finished = ran.stopped ? Math.max(0, records.length - 1) : records.length
  if (!ran.stopped) {
    scan(true)
    const end = records.at(-1)
    if (leading || records.length !== asked.length || end?.last !== 0x0a) return forms
  } else if (leading || records.length > asked.length) return forms
  for (const [index, entry] of asked.slice(0, ran.stopped ? finished : asked.length).entries()) {
    const record = records[index]!
    const header = Buffer.concat(record.header).toString('utf8')
    if (!record.headerDone || record.headerBytes > 16_384 || header !== `${entry.blob} ${entry.path}`) continue
    const head = record.length <= keepBytes ? Buffer.concat(record.head).subarray(0, record.length) : undefined
    forms.set(entry.path, { bytes: record.length, digest: record.hash.digest('hex'), ...(head ? { head } : {}) })
  }
  return forms
}
