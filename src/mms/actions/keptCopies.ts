import { createHash, randomUUID, type Hash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { lstat, open, readFile, readlink, rm, stat, unlink, utimes, writeFile, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createDeflate, deflate as deflateCallback } from 'node:zlib'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { ThreadJournal, type ThreadJournalRecord } from '../data/ThreadJournal'
import { filterRefusal } from '../git/repoPrograms'
import { gitRunError, type GitProcess } from '../git/runGitProcess'
import { KEEP_COPY_OPERATIONS, PRESERVED_REFS, type KeepCopyOperation } from '../../shared/resourceLifecycle'
import { DEFAULT_UNDO_RETENTION_POLICY, retentionWindowText } from '../../shared/undoRetention'
import { gitAsync, gitEnv, guardedAsync, LISTING, mousseCommitEnvNow, NOT_MOUSSE, runGitProcess, tryGitAsync } from './git'
import { UndoRetentionService } from './UndoRetentionService'

/**
 * A copy of what an action is about to remove, kept before it removes anything, under the same
 * `refs/mousse/preserved/<operation>-<12 hex>` refs a restore keeps files under (`preservedFiles.ts`). The operation is
 * recorded in its owner's journal (a thread's; the project's own for the person's checkout, `projectKeptFilesOwner`; or a
 * dispatch's own for its worktree, `dispatchKeptFilesOwner`), so the copy is that owner's: the hourly Undo retention
 * sweep deletes it after the owner's Undo window, and a purge of a thread lists it. Discard keeps one; worktree cleanup
 * keeps one of a worktree's ignored files before it removes the worktree.
 *
 * The copy is one commit laid out the way `git stash` lays one out:
 * - its tree is the working versions, each file's exact bytes on disk: no line-ending conversion, filter or `ident` is
 *   applied (`git cat-file blob <ref>:<path>` gives them back as they were, {@link keptCopyNotice});
 * - parent 1 is HEAD (an empty commit when the branch has none yet);
 * - parent 2 is the staged versions, as the index held them (`git restore --source=<ref>^2 --staged -- <path>`);
 * - parent 3, only when the index has a conflict, holds its stages 1–3 as `stage-1/<path>`, `stage-2/<path>` and
 *   `stage-3/<path>`.
 *
 * The staged versions are written from a private copy of the real index before anything else is put in it; the real
 * index, HEAD and branches are never touched. The working versions are read by Mousse and written, with the trees and
 * commits Git makes for the copy, into one pack that `git index-pack` adds to the repository: however many files the
 * copy holds, it leaves no loose objects behind.
 */
export type { KeepCopyOperation }
export { KEEP_COPY_OPERATIONS }

/** How much one copy may hold. Over it the action is refused, naming the largest paths. Lowered by tests. */
export const KEEP_COPY_LIMITS = { bytes: 2 * 1024 ** 3 }

/** How many of the largest paths a refusal names. */
const NAMED_LARGEST = 5
/** A file up to this size is read in one piece; a larger one is streamed into the pack. */
const WHOLE_FILE_BYTES = 8 * 1024 * 1024
/** How many files are read and compressed at once. */
const READ_AHEAD = 128
/** Small writes to the pack are gathered up to this size. */
const WRITE_BUFFER = 4 * 1024 * 1024

export interface KeptCopy {
  operationId: string
  ref: string
  sha: string
  /** The repository's top folder, which the restore commands run in. */
  top: string
  stagedTree: string
  workingTree: string
  /** Set when the index had a conflict at a kept path. */
  conflictTree?: string
  /** How long the owner keeps it: its Undo window. */
  windowMs: number
  /** The SHA-256 of each working version kept (a link's: of its target), as read when it was kept. */
  digests: ReadonlyMap<string, string>
}

export interface KeepCopyInput {
  /** The owner's folder: the journal the operation is recorded in, and whose Undo window it is kept for. */
  owner: string
  /** The repository's top folder. */
  top: string
  operationType: KeepCopyOperation
  /** The action, as a refusal names it: `Discard`. */
  action: string
  /** Repository-relative paths the action removes or rewrites. Without, the whole working tree but `.mousse/`. */
  paths?: readonly string[]
  /** Without `paths`: ignored files too. */
  includeIgnored?: boolean
  /** With `paths`: paths that are no longer there (a folder that became a file, say), left out of the copy's index. */
  gone?: readonly string[]
}

/** A copy cannot be kept, so the action was refused before anything changed. Its message names the files. */
export class KeepCopyRefusedError extends Error {
  readonly code: string = 'keep_copy_refused'
  constructor(message: string, readonly paths: readonly string[] = []) {
    super(message)
    this.name = 'KeepCopyRefusedError'
  }
}

/** A copy would be larger than {@link KEEP_COPY_LIMITS}. */
export class KeepCopyTooLargeError extends KeepCopyRefusedError {
  override readonly code = 'keep_copy_too_large'
  constructor(action: string, readonly bytes: number, readonly largest: ReadonlyArray<{ path: string; bytes: number }>) {
    super(`${action} would remove ${sizeText(bytes)} of files, more than the ${sizeText(KEEP_COPY_LIMITS.bytes)} Mousse keeps a copy of. The largest: ${largest.map((item) => `${item.path} (${sizeText(item.bytes)})`).join(', ')}. Nothing was changed. Move or commit the largest files first, then try again.`, largest.map((item) => item.path))
    this.name = 'KeepCopyTooLargeError'
  }
}

function sizeText(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return unit === 0 ? `${bytes} bytes` : `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

// ---------------------------------------------------------------------------------------------------------
// Git, read as bytes

/** Runs Mousse's own Git (the central check, no repository programs) and returns what it printed, unchanged. */
async function gitBytes(top: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; inputFile?: string; listing?: boolean } = {}): Promise<GitProcess> {
  const argv = await guardedAsync(top, args, { ...(options.env ? { env: options.env } : {}), ...(options.input !== undefined ? { stdin: options.input } : {}) })
  const ran = await runGitProcess(argv, { cwd: top, env: gitEnv(top, options.env), ...(options.input !== undefined ? { input: options.input } : {}), ...(options.inputFile !== undefined ? { inputFile: options.inputFile } : {}), ...(options.listing ? { maxBuffer: LISTING.maxBuffer } : {}) })
  if (!ran.error && ran.status === 0) return ran
  const refusal = filterRefusal(ran.stderr)
  if (refusal) throw new Error(refusal, { cause: gitRunError(argv, ran) })
  throw gitRunError(argv, ran)
}

/** The NUL-separated fields Git printed with `-z`, exactly as named (a leading space is part of a path). */
async function listZ(top: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string[]> {
  return (await gitBytes(top, args, { ...(env ? { env } : {}), listing: true })).stdout.split('\0').filter(Boolean)
}

// ---------------------------------------------------------------------------------------------------------
// One pack for every object the copy adds

const OBJECT_TYPES = { commit: 1, tree: 2, blob: 3 } as const
type ObjectType = keyof typeof OBJECT_TYPES
const deflate = promisify(deflateCallback)

function objectHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = []
  let byte = (OBJECT_TYPES[type] << 4) | (size & 0x0f)
  let rest = Math.floor(size / 16)
  while (rest > 0) {
    bytes.push(byte | 0x80)
    byte = rest & 0x7f
    rest = Math.floor(rest / 128)
  }
  bytes.push(byte)
  return Buffer.from(bytes)
}

/**
 * A pack written to a file of Mousse's own in the Git folder, then given to `git index-pack --stdin`, which checks every
 * object and adds the pack, with its index, to the repository's packs. The object count in its header is written last.
 */
class PackFile {
  private count = 0
  private pending: Buffer[] = []
  private pendingBytes = 0
  private constructor(readonly path: string, private readonly handle: FileHandle, private readonly algorithm: 'sha1' | 'sha256', private offset: number) {}

  static async create(path: string, algorithm: 'sha1' | 'sha256'): Promise<PackFile> {
    const handle = await open(path, 'w+')
    const header = Buffer.alloc(12)
    header.write('PACK', 0, 'latin1')
    header.writeUInt32BE(2, 4)
    await handle.write(header, 0, 12, 0)
    return new PackFile(path, handle, algorithm, 12)
  }

  get size(): number { return this.count }

  objectId(type: ObjectType, data: Buffer): string {
    return createHash(this.algorithm).update(`${type} ${data.length}\0`).update(data).digest('hex')
  }

  private async write(bytes: Buffer): Promise<void> {
    this.pending.push(bytes)
    this.pendingBytes += bytes.length
    if (this.pendingBytes >= WRITE_BUFFER) await this.flush()
  }

  private async flush(): Promise<void> {
    if (!this.pendingBytes) return
    const bytes = Buffer.concat(this.pending, this.pendingBytes)
    this.pending = []
    this.pendingBytes = 0
    await this.handle.write(bytes, 0, bytes.length, this.offset)
    this.offset += bytes.length
  }

  /** Adds an object whose bytes are in memory, already compressed. */
  async add(type: ObjectType, size: number, compressed: Buffer): Promise<void> {
    await this.write(objectHeader(type, size))
    await this.write(compressed)
    this.count++
  }

  /**
   * Adds a large file as a blob, read and compressed in pieces, and returns its object id. A file whose size changes
   * while it is read is refused: its copy would not be the file.
   */
  async addLargeFile(absolute: string, path: string): Promise<{ id: string; sha256: string }> {
    const file = await open(absolute, 'r')
    try {
      const size = (await file.stat()).size
      const id: Hash = createHash(this.algorithm).update(`blob ${size}\0`)
      const sha256 = createHash('sha256')
      await this.write(objectHeader('blob', size))
      const compressor = createDeflate({ level: 1 })
      const feeding = (async () => {
        const chunk = Buffer.alloc(1024 * 1024)
        let read = 0
        while (true) {
          const { bytesRead } = await file.read(chunk, 0, chunk.length, read)
          if (bytesRead === 0) break
          read += bytesRead
          const piece = Buffer.from(chunk.subarray(0, bytesRead))
          id.update(piece)
          sha256.update(piece)
          if (!compressor.write(piece)) await new Promise((done) => compressor.once('drain', done))
        }
        compressor.end()
        if (read !== size) throw new KeepCopyRefusedError(`${path} changed while its copy was being kept. Nothing was changed; try again once it has stopped changing.`, [path])
      })()
      // A read that fails ends the compressed stream too, so the loop below stops instead of waiting for it.
      feeding.catch((error: Error) => compressor.destroy(error))
      for await (const out of compressor) await this.write(out as Buffer)
      await feeding
      this.count++
      return { id: id.digest('hex'), sha256: sha256.digest('hex') }
    } finally {
      await file.close()
    }
  }

  /** Writes the object count and the checksum, and closes the file. */
  async finish(): Promise<void> {
    await this.flush()
    const count = Buffer.alloc(4)
    count.writeUInt32BE(this.count, 0)
    await this.handle.write(count, 0, 4, 8)
    const checksum = createHash(this.algorithm)
    const chunk = Buffer.alloc(1024 * 1024)
    for (let position = 0; position < this.offset;) {
      const { bytesRead } = await this.handle.read(chunk, 0, Math.min(chunk.length, this.offset - position), position)
      checksum.update(chunk.subarray(0, bytesRead))
      position += bytesRead
    }
    await this.write(checksum.digest())
    await this.flush()
    await this.handle.close()
  }

  async discard(): Promise<void> {
    await this.handle.close().catch(() => undefined)
    await rm(this.path, { force: true })
  }
}

// ---------------------------------------------------------------------------------------------------------
// Settling a keep that stopped

interface KeepDetails { phase: 'intent' | 'outcome'; ref?: string; sha?: string; top?: string; interrupted?: boolean; error?: string }

const detailsOf = (entry: ThreadJournalRecord): KeepDetails | undefined => {
  const details = entry.details as Partial<KeepDetails> | undefined
  return details && (details.phase === 'intent' || details.phase === 'outcome') ? details as KeepDetails : undefined
}

const isKeepOperation = (type: string): boolean => (KEEP_COPY_OPERATIONS as readonly string[]).includes(type)

function samePath(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync.native(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}

/**
 * Settles keeps of the repository at `top` that stopped between their intent and their outcome (the process ended):
 * each is recorded as what the repository holds now, `completed` when its ref is there with the commit the intent
 * named, `failed` otherwise. Only that repository's keeps: the caller holds its locks, so none of them is still running,
 * while a keep in another repository of the same owner may be. Nothing is written to the repository and no removal is
 * replayed: a removal only ever starts after a `completed` outcome. Returns the refs recorded as kept.
 */
export async function settleInterruptedKeeps(owner: string, top: string): Promise<string[]> {
  const journal = new ThreadJournal(owner)
  const kept: string[] = []
  for (const entry of journal.latestByOperation().values()) {
    if (!isKeepOperation(entry.operationType) || entry.state !== 'prepared') continue
    const intent = detailsOf(entry)
    if (intent?.phase !== 'intent' || !intent.ref || !intent.top || !samePath(intent.top, top)) continue
    const found = await tryGitAsync(intent.top, ['rev-parse', '--verify', '-q', `${intent.ref}^{commit}`])
    if (!found.ok && found.stderr) continue // Git could not answer; a later call tries again.
    const present = found.ok && found.stdout === intent.sha
    journal.append({ operationId: entry.operationId, operationType: entry.operationType, state: present ? 'completed' : 'failed',
      details: { phase: 'outcome', ...(present ? { ref: intent.ref, sha: intent.sha } : {}), interrupted: true } satisfies KeepDetails })
    if (present) kept.push(intent.ref)
  }
  return kept
}

/**
 * Names `sha`, a commit already in the repository at `top`, as one of the owner's kept copies: its intent is recorded,
 * the ref created (never moved), and the outcome recorded. A failure is recorded and thrown.
 */
async function recordKept(owner: string, top: string, operationType: KeepCopyOperation, sha: string): Promise<{ operationId: string; ref: string }> {
  const operationId = randomUUID()
  const ref = `${PRESERVED_REFS}${operationId}-${sha.slice(0, 12)}`
  const journal = new ThreadJournal(owner)
  journal.append({ operationId, operationType, state: 'prepared', details: { phase: 'intent', ref, sha, top } satisfies KeepDetails })
  try {
    // Created, never moved: an empty old value means the ref must not exist yet.
    await gitAsync(top, ['update-ref', '--no-deref', ref, sha, ''])
  } catch (error) {
    journal.append({ operationId, operationType, state: 'failed', details: { phase: 'outcome', error: (error as Error).message.split('\n')[0] } satisfies KeepDetails })
    throw error
  }
  journal.append({ operationId, operationType, state: 'completed', details: { phase: 'outcome', ref, sha } satisfies KeepDetails })
  return { operationId, ref }
}

/** Keeps a commit that is already made (a snapshot of the files) as one of the owner's copies, under the same rules. */
export async function keepExistingCommit(input: { owner: string; top: string; operationType: KeepCopyOperation; sha: string }): Promise<{ ref: string; windowMs: number }> {
  const top = resolve(input.top)
  await settleInterruptedKeeps(input.owner, top)
  const { ref } = await recordKept(input.owner, top, input.operationType, input.sha)
  return { ref, windowMs: keptCopyWindowMs(input.owner) }
}

// ---------------------------------------------------------------------------------------------------------
// Keeping a copy

interface Entry { path: string; kind: 'file' | 'link' | 'gone' | 'folder' | 'repository' | 'other'; bytes: number; executable?: boolean }

async function entryOf(top: string, path: string): Promise<Entry> {
  const info = await lstat(join(top, path)).catch(() => undefined)
  if (!info) return { path, kind: 'gone', bytes: 0 }
  if (info.isSymbolicLink()) return { path, kind: 'link', bytes: info.size }
  if (info.isFile()) return { path, kind: 'file', bytes: info.size, executable: (info.mode & 0o111) !== 0 }
  if (info.isDirectory()) return { path, kind: existsSync(join(top, path, '.git')) ? 'repository' : 'folder', bytes: 0 }
  return { path, kind: 'other', bytes: 0 }
}

async function entriesOf(top: string, paths: readonly string[]): Promise<Entry[]> {
  const result: Entry[] = []
  for (let start = 0; start < paths.length; start += 64) result.push(...await Promise.all(paths.slice(start, start + 64).map((path) => entryOf(top, path))))
  return result
}

/** Sizes of objects already in the repository, in the order given; a missing one (a submodule's commit) counts nothing. */
async function objectSizes(top: string, ids: readonly string[]): Promise<number[]> {
  if (!ids.length) return []
  const lines = (await gitBytes(top, ['cat-file', '--batch-check=%(objectsize)'], { input: `${ids.join('\n')}\n`, listing: true })).stdout.split('\n')
  return ids.map((_, index) => Number(lines[index]) || 0)
}

/**
 * Keeps a copy of the staged, working and conflict versions of `paths` (or the whole working tree), then returns it.
 * The caller removes the files only after this returns, and holds the repository's mutation locks.
 *
 * A copy whose staged, working and conflict versions together are over {@link KEEP_COPY_LIMITS} is refused first, with
 * {@link KeepCopyTooLargeError}, before anything is written. Then the objects go into the repository as one pack, the
 * intent is recorded in the owner's journal, the ref is created, and the outcome is recorded.
 */
export async function keepCopy(input: KeepCopyInput): Promise<KeptCopy> {
  const top = resolve(input.top)
  await settleInterruptedKeeps(input.owner, top)
  const gitDir = await gitAsync(top, ['rev-parse', '--absolute-git-dir'])
  const objects = resolve(top, await gitAsync(top, ['rev-parse', '--git-path', 'objects']))
  const realIndex = resolve(top, await gitAsync(top, ['rev-parse', '--git-path', 'index']))
  const algorithm = (await tryGitAsync(top, ['rev-parse', '--show-object-format'])).stdout === 'sha256' ? 'sha256' : 'sha1'
  const head = (await tryGitAsync(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).stdout || undefined
  const fileModes = (await tryGitAsync(top, ['config', '--type=bool', 'core.fileMode'])).stdout !== 'false'
  // Private index files in the Git folder, named as Mousse's own (`gitPolicy`'s owned index rule).
  const working = join(gitDir, `mousse-keep-${randomUUID()}.index`)
  const stages = join(gitDir, `mousse-keep-${randomUUID()}.index`)
  const env = { GIT_INDEX_FILE: working }
  let pack: PackFile | undefined
  try {
    if (existsSync(realIndex)) {
      // Written afresh, then given the real index's times, so Git judges an entry racily clean exactly as it does in the
      // real index: a file changed within the second its entry was written is still read again. With the time of the
      // write, Git would trust the entry's size and time and leave the change out of a whole-tree copy.
      await writeFile(working, await readFile(realIndex))
      const times = await stat(realIndex)
      await utimes(working, times.atime, times.mtime)
    } else {
      await gitAsync(top, head ? ['read-tree', head] : ['read-tree', '--empty'], env)
    }

    const selected = input.paths ? new Set(input.paths) : undefined
    const within = (path: string): boolean => !selected || selected.has(path)
    // A conflict's stages: kept for the paths the action names; every one leaves the copy of the index, which
    // cannot be written as a tree while it has any.
    const unmerged = (await listZ(top, ['ls-files', '-z', '-s', '--unmerged'], env)).map((line) => {
      const tab = line.indexOf('\t')
      const [mode, sha, stage] = line.slice(0, tab).split(' ') as [string, string, string]
      return { mode, sha, stage, path: line.slice(tab + 1) }
    })
    if (unmerged.length) await gitAsync(top, ['update-index', '-z', '--force-remove', '--stdin'], env, `${[...new Set(unmerged.map((entry) => entry.path))].join('\0')}\0`)
    const stagedTree = await gitAsync(top, ['write-tree'], env)
    const conflicts = unmerged.filter((entry) => within(entry.path))

    // What the copy holds that HEAD does not: staged versions that differ from it, conflict stages, working versions.
    const stagedIds = head
      ? stagedChanges(await listZ(top, ['diff-index', '-z', '--cached', '--raw', '--no-renames', head, '--'], env)).filter((item) => within(item.path))
      : (await listZ(top, ['ls-files', '-z', '-s'], env)).flatMap((line) => {
        const tab = line.indexOf('\t')
        const [mode, sha] = line.slice(0, tab).split(' ') as [string, string]
        const path = line.slice(tab + 1)
        return within(path) && mode !== '160000' ? [{ path, sha }] : []
      })
    const paths = selected ? [...selected] : await workingTreeChanges(top, env, input.includeIgnored === true)
    const entries = await entriesOf(top, paths)
    const counted = [
      ...entries.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
      ...(await objectSizes(top, stagedIds.map((item) => item.sha))).map((bytes, index) => ({ path: stagedIds[index]!.path, bytes })),
      ...(await objectSizes(top, conflicts.map((item) => item.sha))).map((bytes, index) => ({ path: conflicts[index]!.path, bytes }))
    ]
    const bytes = counted.reduce((sum, item) => sum + item.bytes, 0)
    if (bytes > KEEP_COPY_LIMITS.bytes) {
      const byPath = new Map<string, number>()
      for (const item of counted) byPath.set(item.path, (byPath.get(item.path) ?? 0) + item.bytes)
      throw new KeepCopyTooLargeError(input.action, bytes, [...byPath].map(([path, size]) => ({ path, bytes: size })).sort((a, b) => b.bytes - a.bytes).slice(0, NAMED_LARGEST))
    }

    // The working versions, byte for byte, into the pack.
    pack = await PackFile.create(join(gitDir, `mousse-keep-${randomUUID()}.pack`), algorithm)
    const indexModes = fileModes ? undefined : await currentModes(top, env)
    const stored: string[] = []
    const digests = new Map<string, string>()
    const kept = entries.filter((entry) => entry.kind === 'file' || entry.kind === 'link')
    for (let start = 0; start < kept.length; start += READ_AHEAD) {
      const batch = kept.slice(start, start + READ_AHEAD)
      const small = await Promise.all(batch.map(async (entry) => {
        if (entry.kind === 'file' && entry.bytes > WHOLE_FILE_BYTES) return undefined
        const absolute = join(top, entry.path)
        const data = entry.kind === 'link' ? await readlink(absolute, { encoding: 'buffer' }) : await readFile(absolute)
        return { data, compressed: await deflate(data, { level: 1 }) }
      }))
      for (const [index, entry] of batch.entries()) {
        const piece = small[index]
        let id: string
        if (piece) {
          id = pack.objectId('blob', piece.data)
          digests.set(entry.path, createHash('sha256').update(piece.data).digest('hex'))
          await pack.add('blob', piece.data.length, piece.compressed)
        } else {
          const large = await pack.addLargeFile(join(top, entry.path), entry.path)
          id = large.id
          digests.set(entry.path, large.sha256)
        }
        const known = indexModes?.get(entry.path)
        const mode = entry.kind === 'link' ? '120000' : fileModes ? (entry.executable ? '100755' : '100644') : known === '100755' || known === '120000' ? known : '100644'
        stored.push(`${mode} ${id}\t${entry.path}`)
      }
    }
    // A path that is gone, or is now a folder, leaves the copy's index, as does a file in the way of a folder that now
    // holds a kept file. A folder that is a repository of its own stays as the index has it.
    const gone = new Set([...entries.filter((entry) => entry.kind === 'gone' || entry.kind === 'folder').map((entry) => entry.path), ...(input.gone ?? [])])
    for (const entry of kept) for (let slash = entry.path.indexOf('/'); slash !== -1; slash = entry.path.indexOf('/', slash + 1)) gone.add(entry.path.slice(0, slash))
    if (gone.size) await gitAsync(top, ['update-index', '-z', '--force-remove', '--stdin'], env, `${[...gone].join('\0')}\0`)
    if (stored.length) {
      try {
        await gitAsync(top, ['update-index', '-z', '--index-info'], env, `${stored.join('\0')}\0`)
      } catch (error) {
        const both = /'([^']+)' appears as both a file and as a directory/.exec(String((error as { stderr?: unknown }).stderr ?? (error as Error).message))
        if (both) throw new KeepCopyRefusedError(`${input.action} could not keep a copy: ${both[1]} is both a file Git tracks and a folder on disk. Nothing was changed. Move one of them aside, then try again.`, [both[1]!])
        throw error
      }
    }
    // The blobs are only in the pack, which is added below: the trees may name them before then.
    const workingTree = await gitAsync(top, ['write-tree', '--missing-ok'], env)

    let conflictTree: string | undefined
    if (conflicts.length) {
      const stageEnv = { GIT_INDEX_FILE: stages }
      await gitAsync(top, ['read-tree', '--empty'], stageEnv)
      await gitAsync(top, ['update-index', '-z', '--index-info'], stageEnv, conflicts.map((entry) => `${entry.mode} ${entry.sha}\tstage-${entry.stage}/${entry.path}`).join('\0') + '\0')
      conflictTree = await gitAsync(top, ['write-tree'], stageEnv)
    }

    const commitEnv = mousseCommitEnvNow()
    const base = head ?? await gitAsync(top, ['commit-tree', await gitAsync(top, ['mktree'], undefined, ''), '-m', 'mousse: no commit yet'], commitEnv)
    const stagedCommit = await gitAsync(top, ['commit-tree', stagedTree, '-p', base, '-m', 'mousse: staged versions'], commitEnv)
    const conflictCommit = conflictTree ? await gitAsync(top, ['commit-tree', conflictTree, '-p', base, '-m', 'mousse: conflict stages'], commitEnv) : undefined
    const sha = await gitAsync(top, ['commit-tree', workingTree, '-p', base, '-p', stagedCommit, ...(conflictCommit ? ['-p', conflictCommit] : []),
      '-m', `mousse: copy kept before ${input.action}`, '-m', `Working versions, as they were on disk: this commit. Staged versions: ^2.${conflictCommit ? ' Conflict stages: ^3, as stage-1/, stage-2/ and stage-3/.' : ''}`], commitEnv)

    // The trees and commits Git just wrote as loose objects go into the same pack, and their loose files then go.
    const folded = await looseObjectsOf(top, objects, sha, head, new Set(stored.map((line) => line.slice(line.indexOf(' ') + 1, line.indexOf('\t')))))
    for (const object of folded) await pack.add(object.type, object.data.length, await deflate(object.data, { level: 1 }))
    await pack.finish()
    await gitBytes(top, ['index-pack', '--stdin'], { inputFile: pack.path })
    await pack.discard()
    pack = undefined
    for (const object of folded) await unlink(join(objects, object.id.slice(0, 2), object.id.slice(2))).catch(() => undefined)

    const { operationId, ref } = await recordKept(input.owner, top, input.operationType, sha)
    return { operationId, ref, sha, top, stagedTree, workingTree, ...(conflictTree ? { conflictTree } : {}), windowMs: keptCopyWindowMs(input.owner), digests }
  } finally {
    await pack?.discard()
    await rm(working, { force: true })
    await rm(stages, { force: true })
  }
}

/** `diff-index -z --raw` fields: each change is a `:modes ids status` field, then its path. Deletions store nothing. */
function stagedChanges(fields: readonly string[]): Array<{ path: string; sha: string }> {
  const changes: Array<{ path: string; sha: string }> = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, dstMode, , sha] = fields[index]!.slice(1).split(' ') as [string, string, string, string]
    if (!/^0+$/.test(sha) && dstMode !== '160000') changes.push({ path: fields[index + 1]!, sha })
  }
  return changes
}

/** The modes the index records, for a repository that does not trust the file system's (`core.fileMode=false`). */
async function currentModes(top: string, env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const modes = new Map<string, string>()
  for (const line of await listZ(top, ['ls-files', '-z', '-s'], env)) {
    const tab = line.indexOf('\t')
    modes.set(line.slice(tab + 1), line.slice(0, line.indexOf(' ')))
  }
  return modes
}

/** The working tree's files that differ from the (private) index or are not in it, as a whole-tree copy keeps them. */
async function workingTreeChanges(top: string, env: NodeJS.ProcessEnv, includeIgnored: boolean): Promise<string[]> {
  const changed = await listZ(top, ['diff-files', '-z', '--name-only', '--', '.', NOT_MOUSSE], env)
  // A repository of its own inside the folder is listed as `name/`; it is left as it is.
  const others = (await listZ(top, ['ls-files', '-z', '--others', ...(includeIgnored ? [] : ['--exclude-standard']), '--', '.', NOT_MOUSSE], env)).filter((path) => !path.endsWith('/'))
  return [...new Set([...changed, ...others])]
}

/**
 * The trees and commits reachable from `sha` that are loose objects, with their bytes: those Git wrote for this copy
 * (and any identical ones it had already). HEAD's are left out. The copy's blobs are not in the repository yet.
 */
async function looseObjectsOf(top: string, objects: string, sha: string, head: string | undefined, packed: ReadonlySet<string>): Promise<Array<{ id: string; type: ObjectType; data: Buffer }>> {
  const ids = (await gitBytes(top, ['rev-list', '--objects', '--no-object-names', '--missing=allow-any', sha, ...(head ? ['--not', head] : [])], { listing: true })).stdout.split('\n').filter(Boolean)
  const loose = ids.filter((id) => !packed.has(id) && existsSync(join(objects, id.slice(0, 2), id.slice(2))))
  if (!loose.length) return []
  const out = (await gitBytes(top, ['cat-file', '--batch'], { input: `${loose.join('\n')}\n`, listing: true })).stdoutBytes
  const found: Array<{ id: string; type: ObjectType; data: Buffer }> = []
  for (let position = 0; position < out.length;) {
    const end = out.indexOf(0x0a, position)
    const [id, type, size] = out.subarray(position, end).toString('latin1').split(' ') as [string, string, string]
    const length = Number(size)
    const data = out.subarray(end + 1, end + 1 + length)
    position = end + 1 + length + 1
    if (type === 'tree' || type === 'commit') found.push({ id, type, data: Buffer.from(data) })
  }
  return found
}

/**
 * The owner's Undo window, which is how long its copies are kept. Read from its retention record; the answer is
 * remembered until the owner's journal changes, so a status read can carry it cheaply.
 */
export function keptCopyWindowMs(owner: string): number {
  const journal = join(owner, 'journal')
  let stamp = 'none'
  try { stamp = String(statSync(journal).mtimeMs) } catch { /* no journal yet: the default policy */ }
  const cached = windows.get(owner)
  if (cached?.stamp === stamp) return cached.windowMs
  let windowMs: number
  // A retention record Mousse cannot read blocks expiry, so nothing is deleted early; the window is then the default.
  try { windowMs = new UndoRetentionService(owner, Date.now, true).policy().windowMs } catch { windowMs = DEFAULT_UNDO_RETENTION_POLICY.windowMs }
  windows.set(owner, { stamp, windowMs })
  if (windows.size > 256) windows.delete(windows.keys().next().value!)
  return windowMs
}
const windows = new Map<string, { stamp: string; windowMs: number }>()

/** The command that writes a kept file back exactly as it was on disk, run in the repository's top folder. */
export function keptCopyRestoreCommand(ref: string): string {
  return `git cat-file blob ${ref}:<path> > <path>`
}

/** What a result says about a copy: where it is, for how long, and how to bring a file back exactly as it was. */
export function keptCopyNotice(kept: Pick<KeptCopy, 'ref' | 'windowMs' | 'top'>): string {
  return `A copy is kept for ${retentionWindowText(kept.windowMs)} as ${kept.ref}. To bring a file back exactly as it was, run in ${kept.top}: ${keptCopyRestoreCommand(kept.ref)} (its staged version: git restore --source=${kept.ref}^2 --staged -- <path>).`
}

// ---------------------------------------------------------------------------------------------------------
// The person's own checkout: copies owned by the project, in the profile

const OWNER_RECORD = 'owner.json'
const PROJECT_IDENTITY = /^[A-Za-z0-9_-]{1,128}$/
/** The folder of every project's owner, beside the project data but never moved with it: copies outlive the project. */
const OWNERS_FOLDER = 'kept-copies'
/** Journal operation type of time a project owner's clock did not count (`recordUncountedTime`). */
export const UNCOUNTED_CLOCK_OPERATION = 'kept-copies-clock-gap'

interface OwnerRecord { schemaVersion: 1; projectId: string; folders: string[] }

/**
 * The folder whose journal owns copies kept from a project's own checkout, where no thread is involved. It is in the
 * profile, not the project's data folder: removing the project moves that folder to the trash, and the copies it kept
 * must still expire.
 */
export function projectKeptFilesOwner(home: string, projectId: string): string {
  if (!PROJECT_IDENTITY.test(projectId)) throw new Error('A project id names the folder that keeps its copies.')
  return join(home, OWNERS_FOLDER, projectId)
}

/**
 * Notes that the project's copies are kept in the repository of `top`, so the hourly sweep finds them there. The
 * owner's retention clock is started by that sweep, under its locks (its pass at start-up included), never here.
 */
export function registerProjectKeptFilesFolder(owner: string, projectId: string, top: string): void {
  const path = join(owner, OWNER_RECORD)
  const record = readOwnerRecord(path) ?? { schemaVersion: 1, projectId, folders: [] }
  const folder = resolve(top)
  if (!record.folders.includes(folder)) atomicWriteJsonSync(path, { ...record, folders: [...record.folders, folder] } satisfies OwnerRecord)
}

function readOwnerRecord(path: string): OwnerRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnerRecord>
    return record.schemaVersion === 1 && typeof record.projectId === 'string' && Array.isArray(record.folders) && record.folders.every((item) => typeof item === 'string')
      ? record as OwnerRecord : undefined
  } catch {
    return undefined
  }
}

/** Every project's owner of copies kept from its own checkout, with the folders they are in. */
export function projectKeptFilesOwners(home: string): Array<{ projectId: string; owner: string; folders: string[] }> {
  let projects: string[]
  try { projects = readdirSync(join(home, OWNERS_FOLDER)) } catch { return [] }
  const owners: Array<{ projectId: string; owner: string; folders: string[] }> = []
  for (const projectId of projects) {
    if (!PROJECT_IDENTITY.test(projectId) || projectId === DISPATCH_OWNERS) continue
    const owner = projectKeptFilesOwner(home, projectId)
    const record = readOwnerRecord(join(owner, OWNER_RECORD))
    if (record) owners.push({ projectId, owner, folders: record.folders })
  }
  return owners
}

// ---------------------------------------------------------------------------------------------------------
// A dispatch's worktree: copies owned by the dispatch, in the profile

/** The folder, inside {@link OWNERS_FOLDER}, of every dispatch's owner. No project is named this. */
const DISPATCH_OWNERS = 'dispatches'
const DISPATCH_IDENTITY = /^dsp_[0-9a-z]{26}$/

interface DispatchOwnerRecord { schemaVersion: 1; dispatchId: string; folders: string[] }

/**
 * The folder whose journal owns the copy a dispatch keeps of its worktree's ignored files before the worktree is
 * removed. The dispatch's record is in the network database, which a journal cannot live in, so its owner is a folder
 * of its own in the profile, beside the projects' owners; the copies expire after its Undo window like theirs.
 */
export function dispatchKeptFilesOwner(home: string, dispatchId: string): string {
  if (!DISPATCH_IDENTITY.test(dispatchId)) throw new Error('A dispatch id names the folder that keeps its copies.')
  return join(home, OWNERS_FOLDER, DISPATCH_OWNERS, dispatchId)
}

/** Notes that the dispatch's copies are kept in the repository of `top` (its main folder), so the hourly sweep finds them. */
export function registerDispatchKeptFilesFolder(owner: string, dispatchId: string, top: string): void {
  const path = join(owner, OWNER_RECORD)
  const record = readDispatchOwnerRecord(path) ?? { schemaVersion: 1, dispatchId, folders: [] }
  const folder = resolve(top)
  if (!record.folders.includes(folder)) atomicWriteJsonSync(path, { ...record, folders: [...record.folders, folder] } satisfies DispatchOwnerRecord)
}

function readDispatchOwnerRecord(path: string): DispatchOwnerRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<DispatchOwnerRecord>
    return record.schemaVersion === 1 && typeof record.dispatchId === 'string' && Array.isArray(record.folders) && record.folders.every((item) => typeof item === 'string')
      ? record as DispatchOwnerRecord : undefined
  } catch {
    return undefined
  }
}

/** Every dispatch's owner of copies, with the folders they are in. */
export function dispatchKeptFilesOwners(home: string): Array<{ dispatchId: string; owner: string; folders: string[] }> {
  let dispatches: string[]
  try { dispatches = readdirSync(join(home, OWNERS_FOLDER, DISPATCH_OWNERS)) } catch { return [] }
  const owners: Array<{ dispatchId: string; owner: string; folders: string[] }> = []
  for (const dispatchId of dispatches) {
    if (!DISPATCH_IDENTITY.test(dispatchId)) continue
    const owner = dispatchKeptFilesOwner(home, dispatchId)
    const record = readDispatchOwnerRecord(join(owner, OWNER_RECORD))
    if (record?.dispatchId === dispatchId) owners.push({ dispatchId, owner, folders: record.folders })
  }
  return owners
}

/**
 * Resumes a project owner's suspended clock (it moved forward more than its policy trusts, after the computer was off
 * for over a week, say). No person reviews a project's clock, so the time from the last trusted reading to now is first
 * recorded as not counted (`uncountedSince`), then the clock resumes: nothing the owner keeps expires sooner because of
 * the jump, and a real gap only keeps copies longer. A crash between the two records the gap again, which only counts
 * less. The caller holds the owner's locks.
 */
export function resumeProjectClockHeld(owner: string, now = Date.now()): { from: number; to: number } | undefined {
  const retention = new UndoRetentionService(owner, () => now)
  const from = retention.suspendedSince()
  if (from === undefined) return undefined
  new ThreadJournal(owner).append({ operationId: randomUUID(), operationType: UNCOUNTED_CLOCK_OPERATION, state: 'completed', details: { from, to: now } })
  retention.resumeUncountedHeld()
  return { from, to: now }
}

/** How much of the time after `since` the owner's clock did not count (`resumeProjectClockHeld`), in milliseconds. */
export function uncountedSince(owner: string, since: number): number {
  let total = 0
  for (const entry of new ThreadJournal(owner, { readOnly: true }).list()) {
    if (entry.operationType !== UNCOUNTED_CLOCK_OPERATION || entry.state !== 'completed') continue
    const { from, to } = (entry.details ?? {}) as { from?: unknown; to?: unknown }
    if (typeof from !== 'number' || typeof to !== 'number' || to <= from) continue
    total += Math.max(0, to - Math.max(from, since))
  }
  return total
}
