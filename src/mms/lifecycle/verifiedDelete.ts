import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmdirSync, unlinkSync, type BigIntStats, type Stats } from 'node:fs'
import { access, lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { assertLifecyclePathAsync } from './ResourceLifecycleStore'
import { lifecycleGitAsync, lifecycleReadAsync } from './lifecycleGit'

/**
 * A verified delete: a folder Mousse removes is removed only as far as it is still exactly what a proof recorded.
 *
 * The proof is every entry of the folder (`ContentEntry`), captured with the bytes kept elsewhere first. After the
 * folder is renamed out of the way, {@link deleteVerifiedAsync} compares it with the proof and removes it entry by
 * entry, deepest first, each file proven again right before its unlink, a checkout's `.git` file last; a write found
 * meanwhile is kept (`keepLate`) and the delete stops. {@link unregisterDeletedAsync} then unregisters the worktree
 * with Git. The caller supplies what is its own through {@link VerifiedDeleteSteps}: its hold of the repository, its
 * record, Git's own data of the worktree and where late writes are kept.
 *
 * The lower-level checks are exported for any caller that removes proven bytes: {@link proveFrozenContentEntryAsync}
 * with {@link assertFrozenEntryUnchanged} for one entry, {@link assertFoldersUnchanged} for the folders above it, and
 * {@link folderSignatureAsync} with {@link assertFolderUnchanged} for a whole folder before it moves.
 */

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
/** `existsSync`, without blocking. */
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

/** One entry of a folder, as a proof records it: a file's or link's SHA-256 (`digest`), its size and its mode. Paths are relative and use `/`. */
export interface ContentEntry { path: string; kind: 'file' | 'directory' | 'link'; digest: string; bytes: number; mode: number }

/** Whether two paths name the same place; on Windows, case aside. */
export function samePath(a: string, b: string): boolean { return (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)) }

/** Whether an entry is exactly the one the proof records. */
export function sameEntry(entry: ContentEntry, proof: ContentEntry | undefined): boolean {
  return Boolean(proof) && entry.kind === proof!.kind && entry.digest === proof!.digest && entry.bytes === proof!.bytes && entry.mode === proof!.mode
}
/** Whether an entry is still what the proof records, by its kind, size, mode and (a link) target; not by a file's bytes. */
function sameShape(entry: ContentEntry, proof: ContentEntry | undefined): boolean {
  return Boolean(proof) && entry.kind === proof!.kind && entry.bytes === proof!.bytes && entry.mode === proof!.mode && (entry.kind !== 'link' || entry.digest === proof!.digest)
}

/** A folder as `lstat` identifies it. */
export function identityOf(stat: { dev: number; ino: number }): string { return `${stat.dev}:${stat.ino}` }
/**
 * Records in `folders` the identity of every folder from the parent of `root` up to `top` (by `resolve`d path), for
 * {@link assertFoldersUnchanged}.
 */
export async function recordFoldersAboveAsync(top: string, root: string, folders: Map<string, string>): Promise<void> {
  for (let at = dirname(root); ; at = dirname(at)) { folders.set(resolve(at), identityOf(await lstat(at))); if (samePath(at, top) || dirname(at) === at) break }
}
/**
 * Synchronously, right before something in `folder` (or `folder` itself) is removed: every folder from `top` down to
 * `folder` is a real folder, no link, and the very one recorded in `folders` (by `resolve`d path). Throws {@link FolderChanged}.
 */
export function assertFoldersUnchanged(top: string, folder: string, folders: ReadonlyMap<string, string>): void {
  for (let at = resolve(folder); ; at = dirname(at)) {
    let stat: Stats
    try { stat = lstatSync(at) } catch { throw new FolderChanged() }
    if (stat.isSymbolicLink() || !stat.isDirectory() || folders.get(at) !== identityOf(stat)) throw new FolderChanged()
    if (samePath(at, top)) return
    if (dirname(at) === at) throw new FolderChanged()
  }
}

/** Whether the volume of `path` tells names apart only by case, as macOS and Windows volumes usually do not. */
export async function caseInsensitiveAt(path: string): Promise<boolean> {
  for (let at = resolve(path); dirname(at) !== at; at = dirname(at)) {
    const name = basename(at), flipped = name.toUpperCase() !== name ? name.toUpperCase() : name.toLowerCase()
    if (flipped === name) continue
    const [real, other] = await Promise.all([lstat(at), lstat(join(dirname(at), flipped)).catch(() => undefined)])
    return Boolean(other && other.ino === real.ino && other.dev === real.dev)
  }
  return false
}

/** A file another process holds open fails to delete with these codes (on Windows also EPERM and EACCES). */
const IN_USE_CODES = new Set(process.platform === 'win32' ? ['EBUSY', 'EPERM', 'EACCES'] : ['EBUSY'])
/** Entries whose `lstat` is read together, so a large folder is not walked one call at a time. */
const STAT_BATCH = 256

/** The `lstat` of each path in order, read in batches; a failed read is kept to be thrown where the walk meets it. */
export async function lstatAll(paths: readonly string[]): Promise<Array<Stats | { error: unknown }>> {
  const stats: Array<Stats | { error: unknown }> = []
  for (let start = 0; start < paths.length; start += STAT_BATCH) {
    stats.push(...await Promise.all(paths.slice(start, start + STAT_BATCH).map((path) => lstat(path).catch((error: unknown) => ({ error })))))
  }
  return stats
}
export function statOrThrow(stat: Stats | { error: unknown }): Stats {
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
 * nothing awaited in between. A file with other hard links is refused, as one entry of a folder removed whole, unless
 * `otherLinks` allows it: removing one of its names loses no bytes, and a write through any name still changes its `lstat`.
 */
export async function proveFrozenContentEntryAsync(root: string, entry: ContentEntry, options: { otherLinks?: boolean } = {}): Promise<FrozenEntryProof> {
  const path = join(root, entry.path)
  await assertLifecyclePathAsync(dirname(root), root)
  if (entry.path) await assertLifecyclePathAsync(root, dirname(path))
  const before = await lstat(path, { bigint: true })
  const kind = kindOf(before)
  if (kind !== entry.kind || Number(before.mode) !== entry.mode || kind !== 'directory' && Number(before.size) !== entry.bytes || kind === 'file' && before.nlink > 1n && !options.otherLinks) throw new Error('Frozen content was replaced before mutation')
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

/** Why Git has the worktree registered at `path` locked (an empty reason for a lock without one), or undefined. */
export async function worktreeLockAsync(commonDir: string, path: string): Promise<string | undefined> {
  let inBlock = false
  for (const line of (await lifecycleReadAsync(commonDir, ['worktree', 'list', '--porcelain'])).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) inBlock = samePath(line.slice(9), path)
    else if (inBlock && (line === 'locked' || line.startsWith('locked '))) return line.slice('locked'.length).trim()
  }
  return undefined
}
/** Whether Git lists a worktree at `path`. */
export async function worktreeRegisteredAsync(commonDir: string, path: string): Promise<boolean> {
  return (await lifecycleReadAsync(commonDir, ['worktree', 'list', '--porcelain'])).split(/\r?\n/).some((line) => line.startsWith('worktree ') && samePath(line.slice(9), path))
}
/** The reason a worktree Git has locked is not deleted, with the command that lets it be. */
export function lockedText(reason: string, path: string): string {
  return `Git has this worktree locked${reason ? ` (${reason})` : ''}, so it stays in the trash. Run git worktree unlock "${path}" to let it be deleted.`
}

/** The caller's hold of the repository was lost while a folder was being deleted: nothing more is removed. */
class LeaseLost extends Error {}

/**
 * Reads the caller's hold of the repository without blocking, and returns a synchronous check that it is still held,
 * which throws when it is not. The check runs right before each removal, with nothing awaited between it and the removal.
 */
export type HeldCheck = () => Promise<() => void>

/** Writes found in a folder while it was being deleted, as {@link VerifiedDeleteSteps.keepLate} is given them. */
export interface LateWrites {
  /** The folder being deleted. */
  root: string
  /** The files and links that differ from the proof, to keep a copy of. */
  files: string[]
  /** Folders that appeared or changed kind with them (a file that became an empty folder). */
  folders: string[]
  /** Every entry that differs from the proof, as it is now: what each kept path must be. */
  entries: ContentEntry[]
  /** Paths of the proof that are no longer there (another kind or another spelling took their place). */
  gone: string[]
}

/** What a caller of {@link deleteVerifiedAsync} provides: its own ownership, records and copies. */
export interface VerifiedDeleteSteps {
  /**
   * Right before the first removal: the caller still owns the folder (its repository hold, its record). Throws to stop
   * with nothing removed; the error reaches the caller.
   */
  begin(): Promise<void>
  /** See {@link HeldCheck}. A hold that cannot be read counts as lost. */
  held: HeldCheck
  /**
   * While the `.git` file is still there, right before it goes: compare HEAD and Git's own data of the worktree with
   * the capture, and capture them again on top of it when they changed.
   */
  recaptureAdmin(root: string): Promise<void>
  /**
   * Keep the late writes (a kept copy of `files`, and the folders) and record them. A reason stops the delete without
   * the proof growing; undefined lets the proof take the new entries.
   */
  keepLate(late: LateWrites): Promise<{ kept: string } | undefined>
  /**
   * Record, in one write, that a write was found at `changedAt` and, when given, the new proof `content` (the earlier
   * entries the writes replaced leave it; the late ones join it).
   */
  save(update: { changedAt: string; content?: ContentEntry[] }): void | Promise<void>
}

/** A delete of a renamed folder against its proof; see {@link deleteVerifiedAsync}. */
export interface VerifiedDelete {
  /** The folder, already renamed out of the way so a writer that opens a file by its old path fails. */
  root: string
  /** The folder no removal may leave: every folder from it down to `root` must stay the very one first seen. */
  top: string
  /** The proof: every entry of `root` (paths relative to it, `.git` left out) as captured before the rename. */
  proof: readonly ContentEntry[]
  steps: VerifiedDeleteSteps
  /** When a late write is recorded as found; defaults to now. */
  now?: number
  /** Folders of what is left that a restore made writable, by path: their mode before and after, so that is not taken for a write. */
  madeWritable?: ReadonlyMap<string, { from: number; to: number }>
  /** Test seam: runs right before each entry is removed, after its last check. */
  beforeRemove?: (path: string) => void
}

/** An entry as it was before a restore made its folder writable, so that change is not taken for a write by someone. */
function beforeMadeWritable(entry: ContentEntry, madeWritable: VerifiedDelete['madeWritable']): ContentEntry {
  const mode = madeWritable?.get(entry.path)
  return mode && entry.kind === 'directory' && entry.mode === mode.to ? { ...entry, mode: mode.from } : entry
}

/**
 * Deletes the renamed folder `root` against the proof. It is walked first (an entry already gone was deleted before
 * a crash, and its bytes are in the proof) and every entry's kind, size and mode compared with the proof, and the
 * identity of every folder from `top` down is recorded. Then, deepest first, each file and link is read and proven
 * again against the proof (`proveFrozenContentEntryAsync`) and, with nothing awaited from its last check to the
 * `unlink`, removed; each folder goes with a plain `rmdir`, which fails when anything new appeared in it. Right before
 * each removal the caller's hold (`held`) must still be there, and every folder from `top` down to it must be the very
 * folder recorded, and no link: a folder swapped for a link, or moved away, stops the delete, so no removal is ever
 * redirected outside `top`. Node has no `unlinkat`, so a deliberate swap between that check and the system call
 * remains possible in principle; an accidental redirection does not.
 * Git's own data and HEAD are compared, and captured again when they changed (`recaptureAdmin`), while the `.git` file
 * is still there; the `.git` file goes last, then the folder itself. A folder whose `.git` file is gone already (a
 * crash or a file in use right after it went) is no checkout any more: no Git runs in it, and the rest goes.
 * A write found meanwhile stops the delete and is kept ({@link keepLateWritesAsync}).
 * Returns why it stopped, or undefined when the folder is gone.
 */
export async function deleteVerifiedAsync(input: VerifiedDelete): Promise<{ kept: string; waiting?: true; readOnly?: true } | undefined> {
  const { root, top, steps } = input
  const proof = new Map(input.proof.map((entry) => [entry.path, entry]))
  const folders = new Map<string, string>()
  let current: ContentEntry[]
  try {
    await recordFoldersAboveAsync(top, root, folders)
    current = (await walkOwnedContentAsync(root, true, { digests: false, folders })).map((entry) => beforeMadeWritable(entry, input.madeWritable))
  } catch (error) { return { kept: `Kept in the trash at ${root}: ${(error as Error).message}` } }
  // The bytes are compared file by file below, right before each one goes; here, what every entry is.
  if (current.some((entry) => !sameShape(entry, proof.get(entry.path)))) return await keepLateWritesAsync(input)
  const dotGit = join(root, '.git')
  const gitFile = await lstat(dotGit).catch(() => undefined)
  if (gitFile && !gitFile.isFile()) return await keepLateWritesAsync(input)
  await steps.begin()
  const gone = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
  const lost = (): never => { throw new LeaseLost() }
  /** Right before a removal, synchronously: the hold is still there and the folders down to `folder` are the ones recorded. */
  const check = (assertHeld: () => void, folder: string): void => {
    try { assertHeld() } catch { throw new LeaseLost() }
    assertFoldersUnchanged(top, folder, folders)
  }
  const heldNow = (): Promise<() => void> => steps.held().catch(() => lost)
  let removing = root
  try {
    for (const entry of [...current].reverse()) {
      if (!entry.path) continue
      const path = join(root, entry.path)
      removing = path
      if (entry.kind === 'directory') {
        input.beforeRemove?.(path)
        const held = await heldNow()
        check(held, path)
        try { rmdirSync(path) } catch (error) { if (!gone(error)) throw error }
        continue
      }
      let frozen: FrozenEntryProof
      try { frozen = await proveFrozenContentEntryAsync(root, proof.get(entry.path)!) } catch (error) { if (gone(error)) continue; throw error }
      input.beforeRemove?.(path)
      const held = await heldNow()
      // From here to the unlink nothing is awaited.
      check(held, dirname(path))
      try { assertFrozenEntryUnchanged(frozen); unlinkSync(path) } catch (error) { if (!gone(error)) throw error }
    }
    removing = root
    if (gitFile) {
      await steps.recaptureAdmin(root)
      input.beforeRemove?.(dotGit)
      const held = await heldNow()
      check(held, root)
      if (!lstatSync(dotGit).isFile()) throw new FolderChanged()
      unlinkSync(dotGit)
    }
    input.beforeRemove?.(root)
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
    if (error instanceof FolderChanged || code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR' || /^Frozen content (changed|was replaced)/.test((error as Error).message) || /^Lifecycle path is a link/.test((error as Error).message)) return await keepLateWritesAsync(input)
    throw error
  }
  return undefined
}

/**
 * A write was found in the folder while it was being deleted: what differs from the proof is added to it (a kept copy of
 * the files, through `keepLate`, the new digests, and the folders), the earlier versions staying where they are, and the
 * delete stops. The newer form of a path wins: when a path changed kind (a file became a folder, a folder a link), the
 * proof's earlier entry for it and everything under it leave the proof, and on a volume that does not tell case apart
 * another spelling of a path is the same path, and the newer spelling stays. Their bytes stay in the earlier copies.
 * Nothing is deleted here; what is left of the folder waits for the next run.
 */
async function keepLateWritesAsync(input: VerifiedDelete): Promise<{ kept: string; waiting?: true }> {
  const { root, steps } = input
  const changedAt = new Date(input.now ?? Date.now()).toISOString()
  const stop = async (kept: string, content?: ContentEntry[]): Promise<{ kept: string; waiting: true }> => {
    await steps.save({ changedAt, ...(content ? { content } : {}) })
    return { kept, waiting: true }
  }
  // Without its `.git` file the folder is no checkout any more, and Git run in it would look for one above it.
  if (!(await lstat(join(root, '.git')).catch(() => undefined))?.isFile()) return stop(`Files were written into ${root} as it was being deleted; they are kept there`)
  let current: ContentEntry[]
  try { current = (await walkOwnedContentAsync(root, true)).map((entry) => beforeMadeWritable(entry, input.madeWritable)) }
  catch (error) { return stop(`Kept in the trash at ${root}: ${(error as Error).message}`) }
  const proof = new Map(input.proof.map((entry) => [entry.path, entry]))
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
  // Folders are kept too, so a rebuild makes them in order with the files: a file that became an empty folder has
  // nothing else to say so.
  const folders = late.filter((entry) => entry.kind === 'directory' && entry.path).map((entry) => entry.path)
  const refused = await steps.keepLate({ root, files, folders, entries: late, gone })
  if (refused) return stop(refused.kept)
  for (const entry of late) proof.set(entry.path, entry)
  return stop('Files in it changed while it was being deleted; the changes are kept with its other files, and what is left is deleted on a later run', [...proof.values()])
}

/**
 * The folder at `path` is gone: Git's registration of the worktree there goes. One at that path again would be someone's
 * new files, and is kept, with the registration. A worktree Git has locked is never unregistered (that needs `--force`,
 * which is never used); the lock is named instead. `held` is checked right before Git starts. `unregistered` records it
 * once Git no longer lists the worktree.
 */
export async function unregisterDeletedAsync(input: { commonDir: string; path: string; held: HeldCheck; unregistered: () => Promise<void> }): Promise<{ removed: true } | { kept: string }> {
  const { commonDir, path } = input
  if (await exists(path)) return { kept: `Files were written at ${path} after the worktree there was deleted; they are kept, and so is Git's registration of the worktree` }
  if (await worktreeRegisteredAsync(commonDir, path)) {
    const locked = await worktreeLockAsync(commonDir, path)
    if (locked !== undefined) return { kept: lockedText(locked, path) }
    const assertHeld = await input.held()
    try { await lifecycleGitAsync(commonDir, ['worktree', 'remove', path], undefined, undefined, undefined, () => { try { assertHeld() } catch { throw new LeaseLost() } }) }
    catch (error) { if (error instanceof LeaseLost) return { kept: 'Mousse lost hold of the repository before Git could unregister the worktree deleted from the trash; a later run does it' }; throw error }
  }
  if (await worktreeRegisteredAsync(commonDir, path)) throw new Error('Git still registers the worktree deleted from the trash')
  await input.unregistered()
  return { removed: true }
}
