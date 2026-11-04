import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync, type Stats } from 'node:fs'
import { copyFile, lstat, open, readdir, readFile, readlink, rename, rm, rmdir, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises'
import { privateIndexEnv } from '../git/gitEnv'
import { assertFoldersUnchanged, assertFrozenEntryUnchanged, identityOf, proveFrozenContentEntryAsync, recordFoldersAboveAsync, type FrozenEntryProof } from '../lifecycle/verifiedDelete'

/**
 * How a Discard removes files: Mousse removes only bytes the kept copy proves it holds, and Git only creates
 * ({@link discardProvenAsync}). In order, after `keepCopy`:
 * 1. Git's index must not be locked, and no discarded path may have been staged anew since the copy: such a path is
 *    left whole.
 * 2. Every entry the discard removes (the file at a path, a folder standing where HEAD has a file with everything in
 *    it, a file or link standing where HEAD needs a folder) is read again and compared with the digest the copy
 *    recorded for it, then removed deepest first, with nothing awaited between its last synchronous check and the
 *    `unlink` ({@link removeProvenAsync}). An entry that changed, or appeared since, is left with everything under it.
 * 3. Git writes HEAD's versions only where nothing is, from a private index ({@link writeFromHeadAsync}:
 *    `checkout-index` without `--force`), so a file saved at an emptied path meanwhile stays as it is.
 * 4. Only then do the index entries of the paths that were emptied and written go back to HEAD, unless they were staged
 *    anew meanwhile: a path left anywhere on the way keeps its staged version, conflict stages included.
 */

/** Why a discarded path was not discarded, or not wholly. */
export type LeftReason =
  /** Something at it changed after the copy was read, or it was staged anew: nothing of it was removed. */
  | 'changed'
  /** Something in the folder at it changed while it was removed: what went before is in the copy, the rest stayed. */
  | 'partly'
  /** Saved again after it was emptied: Git did not write over it. */
  | 'recreated'
  /** Staged anew after its file was removed: its staged version stayed. */
  | 'restaged'
  /** Git's index stayed locked: its staged version stayed. */
  | 'locked'
  /** Git could not write HEAD's version back: the path is empty, its earlier version in the copy. */
  | 'failed'
  /** Git cannot write HEAD's version here (a filter it may not run): nothing of it was removed. */
  | 'unwritable'
  /** Not a discarded path: staged while Discard ran, so the unfinished merge, revert or cherry-pick was not ended. */
  | 'operation'

/** A discarded path that was not discarded, or not wholly, and why. */
export interface LeftAsItIs {
  /** The path the discard was for. */
  path: string
  reason: LeftReason
  /** What changed: the path itself, a file inside the folder in its place, or a file in the way above it. */
  changed: string
  /** With `partly`: the entries removed (kept in the copy) before the change was found. */
  removed?: string[]
  /** With `partly`: what was being removed, the path itself or what stood in its way. Paths sharing it share a sentence. */
  place?: string
  /** With `failed` and `unwritable`: Git's message. */
  detail?: string
}

/**
 * How a caller runs one of its Git commands in the repository: its exit status, its output exactly as written, and
 * Git's messages. `write` marks a command run as the person's Discard: one that changes the index or files, or one that
 * must apply the same filters as those writes.
 */
export type DiscardGit = (args: string[], options?: { input?: string; env?: Record<string, string>; write?: boolean }) => Promise<{ status: number | null; stdout: string; stderr: string }>

/** Git's index stayed locked: nothing was discarded. */
export class IndexLockedError extends Error {
  constructor(readonly lock: string) {
    super(`Git's index is locked (${lock}): another Git command is running, or one stopped without removing its lock. Nothing was discarded. Try again once it has finished; if no Git is running, delete ${lock}.`)
    this.name = 'IndexLockedError'
  }
}

/** How long a Discard waits for another Git command to release the index, and how often it looks. */
const LOCK_WAIT_MS = 2_000
const LOCK_POLL_MS = 100

/** Paths whose entries are walked and proven together. */
const BATCH = 64
/** Paths emptied between two turns of the event loop. */
const UNLINK_BATCH = 256
/** How deep a folder in the way is walked; deeper counts as changed, and stays. */
const MAX_DEPTH = 64

type Planned = { kind: 'file' | 'link'; rel: string; proof: FrozenEntryProof } | { kind: 'directory'; rel: string }

/** What stands at one place the discard empties, proven against the copy. */
interface Victim {
  rel: string
  /** In walk order: every folder before what is in it. */
  entries: Planned[]
  /** The identity of every folder from the repository's top down to and inside the victim. */
  folders: Map<string, string>
  /** The first entry found changed; then nothing more of the victim is removed. */
  changed?: string
  /** Files and links removed before `changed` was found. */
  removed: string[]
}

class Changed extends Error {
  constructor(readonly rel: string) { super(`${rel} changed`) }
}

const gone = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')
const absolute = (top: string, rel: string): string => join(top, ...rel.split('/'))

/**
 * What the discard of `path` removes, as a path relative to `top`: for a path HEAD's version goes back at (`write`), the
 * first file or link above it (Git removes it to make the folder), else the path itself. Undefined when nothing is there,
 * or (a path nothing goes back at) when a folder above it is a link or missing, so the file does not stand there.
 */
async function victimOf(top: string, path: string, write: boolean): Promise<string | undefined> {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    const above = path.slice(0, slash)
    const stat = await lstat(absolute(top, above)).catch((error: unknown) => { if (gone(error)) return undefined; throw error })
    if (!stat) return undefined
    if (stat.isDirectory()) continue
    return write ? above : undefined
  }
  const stat = await lstat(absolute(top, path)).catch((error: unknown) => { if (gone(error)) return undefined; throw error })
  return stat ? path : undefined
}

/** Walks `rel` by `lstat` (never through a link) and proves each file and link against `digests`. */
async function proveVictim(top: string, rel: string, digests: ReadonlyMap<string, string>): Promise<Victim | undefined> {
  const victim: Victim = { rel, entries: [], folders: new Map(), removed: [] }
  try {
    await recordFoldersAboveAsync(top, absolute(top, rel), victim.folders)
  } catch {
    return { ...victim, changed: rel }
  }
  const visit = async (at: string, stat: Stats, depth: number): Promise<void> => {
    const path = absolute(top, at)
    if (stat.isSymbolicLink() || stat.isFile()) {
      const digest = digests.get(at)
      if (digest === undefined) throw new Changed(at)
      const kind = stat.isSymbolicLink() ? 'link' : 'file'
      let proof: FrozenEntryProof
      try {
        proof = await proveFrozenContentEntryAsync(top, { path: at, kind, digest, bytes: stat.size, mode: stat.mode }, { otherLinks: true })
      } catch {
        throw new Changed(at)
      }
      victim.entries.push({ kind, rel: at, proof })
      return
    }
    if (!stat.isDirectory() || depth > MAX_DEPTH) throw new Changed(at)
    victim.folders.set(resolve(path), identityOf(stat))
    victim.entries.push({ kind: 'directory', rel: at })
    const names = (await readdir(path).catch(() => { throw new Changed(at) })).sort()
    // A repository of its own appeared in the folder since the copy refused one: its history is never removed.
    if (names.includes('.git')) throw new Changed(`${at}/.git`)
    for (const name of names) {
      const inner = `${at}/${name}`
      const innerStat = await lstat(absolute(top, inner)).catch(() => { throw new Changed(inner) })
      await visit(inner, innerStat, depth + 1)
    }
  }
  try {
    const stat = await lstat(absolute(top, rel)).catch((error: unknown) => { if (gone(error)) return undefined; throw new Changed(rel) })
    // Gone since it was looked at: nothing of it is left to remove.
    if (!stat) return undefined
    await visit(rel, stat, 0)
  } catch (error) {
    if (error instanceof Changed) return { ...victim, entries: [], changed: error.rel }
    throw error
  }
  return victim
}

/**
 * Right before a proven file goes, synchronously: it is still what was proven ({@link assertFrozenEntryUnchanged}). A
 * file whose other names this Discard removed has one link fewer per removed name and a new change time, so for it the
 * rest of its `lstat` (device, inode, mode, size, modification time) must match, and its bytes are read and compared
 * again.
 */
function assertStillProven(proof: FrozenEntryProof, unlinked: ReadonlyMap<string, number>): void {
  try {
    assertFrozenEntryUnchanged(proof)
  } catch (error) {
    const [dev, ino, mode, nlink, size, mtime] = proof.signature.split(':')
    const fewer = unlinked.get(`${dev}:${ino}`)
    if (!fewer || proof.entry.kind !== 'file') throw error
    const now = lstatSync(proof.path, { bigint: true })
    if (`${now.dev}` !== dev || `${now.ino}` !== ino || `${now.mode}` !== mode || `${now.size}` !== size || `${now.mtimeNs}` !== mtime || now.nlink !== BigInt(nlink!) - BigInt(fewer)) throw error
    if (createHash('sha256').update(readFileSync(proof.path)).digest('hex') !== proof.entry.digest) throw error
  }
}

/**
 * Removes what stands at each discarded path, as far as the kept copy holds it (`digests`, the SHA-256 of each working
 * version as `keepCopy` read it). `restore` are paths HEAD's version goes back at: a file or link above one, in the way
 * of its folder, goes too. `remove` are paths nothing goes back at. `cleared` are the paths emptied; `left` the ones not
 * discarded, naming what changed; `removed` every file and link that went. `beforeUnlink` is a test seam: it runs right
 * before each entry's last check.
 */
export async function removeProvenAsync(input: {
  top: string
  restore: readonly string[]
  remove: readonly string[]
  digests: ReadonlyMap<string, string>
  beforeUnlink?: (path: string) => void
  /** A folder (relative to `top`) that stays even when a removed path leaves it empty: the result still has it. */
  keepFolder?: (rel: string) => boolean
}): Promise<{ cleared: string[]; left: LeftAsItIs[]; removed: string[] }> {
  const top = resolve(input.top)
  const writes = new Set(input.restore)
  const paths = [...new Set([...input.restore, ...input.remove])]
  // Which place each path empties: several paths below one file in the way share it.
  const victimFor = new Map<string, string | undefined>()
  for (let start = 0; start < paths.length; start += BATCH) {
    const batch = paths.slice(start, start + BATCH)
    const found = await Promise.all(batch.map((path) => victimOf(top, path, writes.has(path))))
    batch.forEach((path, index) => victimFor.set(path, found[index]))
  }
  // A place inside another (a file in a folder that stands where HEAD has a file) goes with the outer one.
  const found = new Set([...victimFor.values()].filter((rel): rel is string => rel !== undefined))
  const places = [...found].filter((rel) => !under(rel, found))
  for (const [path, rel] of victimFor) if (rel !== undefined && under(rel, found)) victimFor.set(path, places.find((outer) => rel.startsWith(`${outer}/`)))
  const victims = new Map<string, Victim | undefined>()
  for (let start = 0; start < places.length; start += BATCH) {
    const batch = places.slice(start, start + BATCH)
    const proven = await Promise.all(batch.map((rel) => proveVictim(top, rel, input.digests)))
    batch.forEach((rel, index) => victims.set(rel, proven[index]))
  }

  // Deepest first within each place; between the last check of an entry and its removal nothing is awaited.
  const unlinked = new Map<string, number>()
  let count = 0
  for (const victim of victims.values()) {
    if (!victim || victim.changed) continue
    for (const entry of [...victim.entries].reverse()) {
      const path = absolute(top, entry.rel)
      input.beforeUnlink?.(path)
      try {
        if (entry.kind === 'directory') {
          assertFoldersUnchanged(top, path, victim.folders)
          rmdirSync(path)
        } else {
          assertFoldersUnchanged(top, dirname(path), victim.folders)
          assertStillProven(entry.proof, unlinked)
          unlinkSync(path)
          const [dev, ino] = entry.proof.signature.split(':')
          unlinked.set(`${dev}:${ino}`, (unlinked.get(`${dev}:${ino}`) ?? 0) + 1)
          victim.removed.push(entry.rel)
        }
      } catch {
        // Changed since it was proven, or something new in a folder (named, when it can be read): it stays, with what is
        // left above it.
        let found: string | undefined
        if (entry.kind === 'directory') { try { found = readdirSync(path).sort()[0] } catch { found = undefined } }
        victim.changed = found === undefined ? entry.rel : `${entry.rel}/${found}`
        break
      }
      if (++count % UNLINK_BATCH === 0) await nextTurn()
    }
  }

  const cleared: string[] = []
  const left: LeftAsItIs[] = []
  for (const path of paths) {
    const place = victimFor.get(path)
    const victim = place === undefined ? undefined : victims.get(place)
    if (victim?.changed === undefined) cleared.push(path)
    else if (victim.removed.length) left.push({ path, reason: 'partly', changed: victim.changed, removed: [...victim.removed], place: victim.rel })
    else left.push({ path, reason: 'changed', changed: victim.changed })
  }
  // Like `git clean -d` and `git rm`: a folder a removed path leaves empty goes too.
  await removeEmptiedFolders(top, cleared.filter((path) => !writes.has(path)), input.keepFolder)
  return { cleared, left, removed: [...victims.values()].flatMap((victim) => victim?.removed ?? []) }
}

/**
 * Removes the folders above `paths` that are now empty, deepest first; a folder with anything in it stays, and so does
 * one `keep` names (a folder the result still has: removing it would give it a new identity under any program in it).
 */
async function removeEmptiedFolders(top: string, paths: readonly string[], keep?: (rel: string) => boolean): Promise<void> {
  const root = resolve(top)
  const folders = new Set<string>()
  for (const path of paths) {
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
      const rel = path.slice(0, at)
      if (folders.has(rel)) break
      folders.add(rel)
    }
  }
  for (const rel of [...folders].filter((rel) => !keep?.(rel)).sort((a, b) => b.split('/').length - a.split('/').length)) await rmdir(absolute(root, rel)).catch(() => undefined)
}

/**
 * Removes every empty folder in `folders` (untracked folders, relative to `top`) and the folders themselves when that
 * leaves them empty, as `git clean -d` does. Only `rmdir`: a folder with anything in it, an ignored file say, stays.
 * Links are never followed, and a folder holding a repository of its own is never entered.
 */
async function removeEmptyFoldersUnder(top: string, folders: readonly string[]): Promise<void> {
  const found: string[] = []
  const walk = async (path: string, depth: number): Promise<void> => {
    const stat = await lstat(path).catch(() => undefined)
    if (!stat?.isDirectory() || depth > MAX_DEPTH) return
    const names = await readdir(path).catch(() => [] as string[])
    if (names.includes('.git')) return
    found.push(path)
    for (const name of names) await walk(join(path, name), depth + 1)
  }
  for (const folder of folders) await walk(absolute(top, folder.replace(/\/+$/, '')), 0)
  for (const folder of found.sort((a, b) => b.split(sep).length - a.split(sep).length)) await rmdir(folder).catch(() => undefined)
}

/** Whether `path` lies inside one of `folders` (paths relative to the top, with `/`). */
function under(path: string, folders: ReadonlySet<string>): boolean {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) if (folders.has(path.slice(0, slash))) return true
  return false
}

const exists = (top: string, path: string): Promise<boolean> => lstat(absolute(top, path)).then(() => true, () => false)

/** Whether a file or link stands where a folder above `path` goes (a link to a folder included: Git never writes through one). */
async function inTheWayAbove(top: string, path: string): Promise<boolean> {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    const stat = await lstat(absolute(top, path.slice(0, slash))).catch(() => undefined)
    if (!stat) return false
    if (!stat.isDirectory()) return true
  }
  return false
}

/** Whether something stands at `path`, or a file or link stands where a folder above it goes. */
async function standsInTheWay(top: string, path: string): Promise<boolean> {
  return await inTheWayAbove(top, path) || exists(top, path)
}

/** The NUL-separated fields of a listing, exactly as Git wrote them; a failed run throws with Git's message. */
async function listZ(discardGit: DiscardGit, args: string[], env?: Record<string, string>, input?: string, write = false): Promise<string[]> {
  const ran = await discardGit(args, { ...(env ? { env } : {}), ...(input !== undefined ? { input } : {}), ...(write ? { write } : {}) })
  if (ran.status !== 0) throw new Error(`Command failed: git ${args.join(' ')}\n${ran.stderr.trim()}`)
  return ran.stdout.split('\0').filter(Boolean)
}

/** `paths` as literal pathspecs, a few thousand characters at a time. */
function* literalBatches(paths: readonly string[]): Generator<string[]> {
  for (let start = 0; start < paths.length;) {
    const batch: string[] = []
    for (let length = 0; start < paths.length && (!batch.length || length + paths[start]!.length < 16_000); start++) {
      batch.push(`:(literal)${paths[start]!}`)
      length += paths[start]!.length + 11
    }
    yield batch
  }
}

const firstLine = (text: string): string => text.split('\n').map((line) => line.trim()).find(Boolean) ?? ''

/** Whether two entries on disk are the same: both files with the same bytes, or both links to the same target. */
async function sameEntryBytes(a: string, b: string): Promise<boolean> {
  const [one, two] = await Promise.all([lstat(a).catch(() => undefined), lstat(b).catch(() => undefined)])
  if (!one || !two) return false
  if (one.isSymbolicLink() && two.isSymbolicLink()) return (await readlink(a)) === (await readlink(b))
  if (!one.isFile() || !two.isFile() || one.size !== two.size) return false
  const [x, y] = await Promise.all([readFile(a), readFile(b)])
  return x.equals(y)
}

/** Has Git write HEAD's version of `paths` only where nothing is (see {@link createOnlyAsync}). */
function writeFromHeadAsync(top: string, discardGit: DiscardGit, paths: readonly string[]): Promise<{ notWritten: Map<string, { reason: 'recreated' | 'failed'; detail?: string }>; entries: Map<string, string> }> {
  return createOnlyAsync(top, discardGit, paths, 'HEAD')
}

/**
 * Has Git write `tree`'s version of `paths` only where nothing is, from a private index that holds just those entries:
 * `checkout-index` without `--force` leaves an existing file or folder as it is, and never waits for the real index's
 * lock. A run Git stopped (a folder it could not make) is finished one path at a time, for the paths still empty. Which
 * paths Git wrote is read from the private index afterwards (`diff-files`), never from its messages. Returns the paths
 * it did not write and why.
 */
export async function createOnlyAsync(top: string, discardGit: DiscardGit, paths: readonly string[], tree: string): Promise<{ notWritten: Map<string, { reason: 'recreated' | 'failed'; detail?: string }>; entries: Map<string, string> }> {
  const notWritten = new Map<string, { reason: 'recreated' | 'failed'; detail?: string }>()
  const byPath = new Map<string, string>()
  if (!paths.length) return { notWritten, entries: byPath }
  // Something already there, or a file or link in the way of its folder: saved after the path was emptied, it stays.
  const asked: string[] = []
  for (let start = 0; start < paths.length; start += BATCH) {
    const batch = paths.slice(start, start + BATCH)
    const blocked = await Promise.all(batch.map((path) => standsInTheWay(top, path)))
    batch.forEach((path, index) => { if (blocked[index]) notWritten.set(path, { reason: 'recreated' }); else asked.push(path) })
  }
  if (!asked.length) return { notWritten, entries: byPath }
  const heads = await headEntries(discardGit, tree, asked)
  for (const [path, line] of heads) byPath.set(path, line)
  const gitDir = resolve(top, firstLine((await discardGit(['rev-parse', '--absolute-git-dir'])).stdout))
  const index = join(gitDir, `mousse-discard-${randomUUID()}.index`)
  const env = privateIndexEnv(index)
  const scratch = `${index}.check`
  try {
    const info = [...heads.values()]
    const made = await discardGit(['update-index', '-z', '--index-info'], { env, input: `${info.join('\0')}\0`, write: true })
    if (made.status !== 0) throw new Error(`Command failed: git update-index\n${made.stderr.trim()}`)
    const writeHeadBatch = (batch: readonly string[]) => discardGit(['checkout-index', '-u', '-z', '--stdin'], { env, input: `${batch.join('\0')}\0`, write: true })
    const ran = await writeHeadBatch(asked)
    const errors = new Map<string, string>()
    if (ran.status !== 0 && ran.status !== 1) {
      for (const path of asked) {
        if (await exists(top, path)) continue
        const one = await writeHeadBatch([path])
        if (one.status !== 0) errors.set(path, firstLine(one.stderr))
      }
      // A run Git stopped wrote some files without recording them: refreshed, those it wrote are not listed below.
      await discardGit(['update-index', '-q', '--refresh'], { env, write: true })
    }
    // The private index has only these entries: the ones whose file is missing or not as Git recorded writing it are
    // listed, with the same conversions as the write.
    const wanted = new Set(asked)
    const listed = (await listZ(discardGit, ['diff-files', '-z', '--name-only'], env, undefined, true)).filter((path) => wanted.has(path))
    const there: string[] = []
    for (const path of listed) {
      // A link or file that appeared above it after the check: Git did not write through it, whatever is found there.
      if (await inTheWayAbove(top, path)) notWritten.set(path, { reason: 'recreated' })
      else if (await exists(top, path)) there.push(path)
      // Something saved in the way of its folder after the path was emptied, or Git could not write it.
      else if (await standsInTheWay(top, path)) notWritten.set(path, { reason: 'recreated' })
      else notWritten.set(path, { reason: 'failed', detail: errors.get(path) ?? firstLine(ran.stderr) })
    }
    // A listed file may still be exactly what Git writes (a blob that does not survive its own line-ending conversion,
    // say): it is written again into a scratch folder and compared byte for byte. Only one that differs was saved by
    // someone else after the path was emptied.
    if (there.length) {
      await discardGit(['checkout-index', '-f', `--prefix=${scratch}/`, '-z', '--stdin'], { env, input: `${there.join('\0')}\0`, write: true })
      for (const path of there) if (!await sameEntryBytes(absolute(top, path), absolute(scratch, path))) notWritten.set(path, { reason: 'recreated' })
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
    await rm(index, { force: true })
    await rm(`${index}.lock`, { force: true })
  }
  return { notWritten, entries: byPath }
}

/** The real index's lock file. */
async function indexLockOf(top: string, discardGit: DiscardGit): Promise<string> {
  return resolve(top, firstLine((await discardGit(['rev-parse', '--git-path', 'index.lock'])).stdout))
}

/**
 * Waits briefly for another Git command to release the index; one that keeps it locked (a running command, or the lock
 * of one that stopped) refuses with {@link IndexLockedError}. Run before anything is removed.
 */
export async function waitForIndexAsync(top: string, discardGit: DiscardGit): Promise<void> {
  const lock = await indexLockOf(top, discardGit)
  for (const until = Date.now() + LOCK_WAIT_MS; await lstat(lock).then(() => true, () => false);) {
    if (Date.now() >= until) throw new IndexLockedError(lock)
    await sleep(LOCK_POLL_MS)
  }
}

/** The index's entries as one digest each, by path, read without writing it. */
async function stagedNow(discardGit: DiscardGit): Promise<Map<string, string>> {
  return stagedEntryDigests(await listZ(discardGit, ['ls-files', '-s', '-z']))
}

/** A command on a private index that must succeed. */
async function discardGitOrThrow(discardGit: DiscardGit, args: string[], env: Record<string, string>, input?: string): Promise<void> {
  const ran = await discardGit(args, { env, write: true, ...(input !== undefined ? { input } : {}) })
  if (ran.status !== 0) throw new Error(`Command failed: git ${args.join(' ')}\n${ran.stderr.trim()}`)
}

/** What the transaction on the real index changes ({@link commitIndexAsync}). */
interface IndexPlan {
  /** HEAD's entries to put in, as `update-index --index-info` takes them, by path. */
  put: ReadonlyMap<string, string>
  /** Paths whose entries go. */
  drop: readonly string[]
  /** Paths outside the sparse checkout, marked skip-worktree as `reset --hard` leaves them. */
  sparse: readonly string[]
  /** End the merge, revert or cherry-pick: the whole index goes back to HEAD, if nothing else in it changed. */
  wholeTree: boolean
}

/**
 * Changes the real index as one compare-and-swap, the way Git itself writes it: Mousse creates `index.lock` (waiting
 * briefly for another Git command to finish), copies the index into a private file, compares each entry it would
 * change with what was read before anything was removed (`before`), applies only the unchanged ones there, and then
 * writes the result into the lock and renames it over the index. While the lock is held no Git command can stage
 * anything, so nothing staged between the comparison and the write can be lost. An entry staged anew is left as it is
 * (`restaged`). The whole-tree reset that ends an operation runs on the copy only when no entry anywhere changed
 * (`elsewhere` names those that did). Assume-unchanged and skip-worktree flags stay. Returns `locked` with nothing
 * changed when the lock stays taken.
 */
async function commitIndexAsync(top: string, discardGit: DiscardGit, head: string | undefined, before: ReadonlyMap<string, string>, plan: IndexPlan): Promise<{ restaged: string[]; elsewhere: string[]; ended: boolean; written?: Map<string, string>; locked?: string }> {
  const indexPath = resolve(top, firstLine((await discardGit(['rev-parse', '--git-path', 'index'])).stdout))
  const lockPath = `${indexPath}.lock`
  let handle: FileHandle | undefined
  for (const until = Date.now() + LOCK_WAIT_MS; !handle;) {
    try {
      handle = await open(lockPath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= until) return { restaged: [], elsewhere: [], ended: false, locked: lockPath }
      await sleep(LOCK_POLL_MS)
    }
  }
  const gitDir = resolve(top, firstLine((await discardGit(['rev-parse', '--absolute-git-dir'])).stdout))
  const copy = join(gitDir, `mousse-discard-${randomUUID()}.index`)
  const env = privateIndexEnv(copy)
  let committed = false
  try {
    const original = await stat(indexPath).catch(() => undefined)
    if (original) await copyFile(indexPath, copy)
    const now = stagedEntryDigests(await listZ(discardGit, ['ls-files', '-s', '-z'], env))
    const paths = [...plan.put.keys(), ...plan.drop]
    const restaged = new Set(stagedSince(before, now, paths))
    const changing = new Set(paths.filter((path) => !restaged.has(path)))
    // `ls-files -v`: a lowercase tag is assume-unchanged, `S` (or `s`) skip-worktree.
    const tags = new Map((await listZ(discardGit, ['ls-files', '-v', '-z'], env)).map((line) => [line.slice(2), line[0]!]))
    const drop = plan.drop.filter((path) => changing.has(path))
    const put = [...plan.put].filter(([path]) => changing.has(path)).map(([, line]) => line)
    if (drop.length) await discardGitOrThrow(discardGit, ['update-index', '-z', '--force-remove', '--stdin'], env, `${drop.join('\0')}\0`)
    // An entry put in afresh has no stat data, so Git reads the file before calling it unchanged: a converted file
    // (CRLF, say) of another size is not taken for a change. Stage 0 replaces conflict stages.
    if (put.length) await discardGitOrThrow(discardGit, ['update-index', '-z', '--index-info'], env, `${put.join('\0')}\0`)
    const elsewhere = plan.wholeTree ? stagedSince(before, now, [...new Set([...before.keys(), ...now.keys()])]).filter((path) => !plan.put.has(path) && !plan.drop.includes(path)) : []
    const ended = plan.wholeTree && !restaged.size && !elsewhere.length
    // The whole index back to HEAD, which also ends the merge, revert or cherry-pick (`reset` does that itself).
    if (ended && head) await discardGitOrThrow(discardGit, ['reset', '-q'], env)
    else if (ended) await discardGitOrThrow(discardGit, ['read-tree', '--empty'], env)
    else await discardGit(['update-index', '-q', '--refresh'], { env, write: true })
    const assumed = [...changing].filter((path) => plan.put.has(path) && /^[a-z]$/.test(tags.get(path) ?? '') && tags.get(path) !== 's')
    const skipWorktree = [...new Set([...plan.sparse.filter((path) => changing.has(path)), ...[...changing].filter((path) => plan.put.has(path) && /^[sS]$/.test(tags.get(path) ?? ''))])]
    if (assumed.length) await discardGitOrThrow(discardGit, ['update-index', '-z', '--assume-unchanged', '--stdin'], env, `${assumed.join('\0')}\0`)
    if (skipWorktree.length) await discardGitOrThrow(discardGit, ['update-index', '-z', '--skip-worktree', '--stdin'], env, `${skipWorktree.join('\0')}\0`)
    // What the index holds once written, to tell later changes by someone else from what this discard left.
    const written = stagedEntryDigests(await listZ(discardGit, ['ls-files', '-s', '-z'], env))
    const bytes = await readFile(copy).catch(() => undefined)
    if (bytes) {
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(lockPath, indexPath)
      committed = true
    }
    return { restaged: [...restaged], elsewhere, ended, written }
  } finally {
    if (handle) await handle.close()
    if (!committed) await rm(lockPath, { force: true })
    await rm(copy, { force: true })
    await rm(`${copy}.lock`, { force: true })
  }
}

export interface ProvenDiscardInput {
  top: string
  /** HEAD's commit; undefined before the first commit. */
  head?: string
  /** Tracked paths HEAD has a file or link at: emptied, then HEAD's version is written back. */
  restore: readonly string[]
  /** Tracked paths HEAD does not have: emptied, and their index entries go. */
  remove: readonly string[]
  /** Untracked paths: emptied. */
  untracked: readonly string[]
  /** Paths changed in the index only (submodules): their entries go back to HEAD. */
  indexOnly: readonly string[]
  /** {@link stagedEntryDigests} of the index, read before the copy was kept. */
  stagedBefore: ReadonlyMap<string, string>
  /** What the copy holds: `KeptCopy.digests`. */
  digests: ReadonlyMap<string, string>
  discardGit: DiscardGit
  /** The pending-changes Discard: HEAD's versions are written only inside the sparse checkout, as Git would, and empty untracked folders go too. */
  wholeTree?: { untrackedFolders: readonly string[] }
  beforeUnlink?: (path: string) => void
}

/**
 * Discards the paths after their copy was kept: see the top of this file. Returns the paths not discarded, or not
 * wholly, and why, and whether the whole index may go back to HEAD now (`wholeTreeReset`: everything was discarded and
 * nobody staged anything meanwhile), which ends a merge, revert or cherry-pick. Throws {@link IndexLockedError} with
 * nothing removed when Git's index stays locked. A failure once files were removed is returned as `failed` for the paths
 * not finished, so the caller still shows the copy.
 */
export async function discardProvenAsync(input: ProvenDiscardInput): Promise<{ left: LeftAsItIs[]; endedOperation: boolean; stagedElsewhere: string[]; indexWritten?: Map<string, string> }> {
  const { top, discardGit } = input
  await waitForIndexAsync(top, discardGit)
  const discarded = [...new Set([...input.restore, ...input.remove, ...input.untracked, ...input.indexOnly])]
  // A path staged anew since the copy is someone's newer work: nothing of it is touched.
  const restagedEarly = new Set(stagedSince(input.stagedBefore, await stagedNow(discardGit), discarded))
  const left: LeftAsItIs[] = [...restagedEarly].map((path) => ({ path, reason: 'changed', changed: path }))
  // A file under a filter Git cannot run here could not be written back: it is left whole.
  const attributesDiscarded = discarded.some((path) => path === '.gitattributes' || path.endsWith('/.gitattributes'))
  const unwritable = await unwritableAsync(top, discardGit, input.head, input.restore.filter((path) => !restagedEarly.has(path)), attributesDiscarded)
  for (const [path, detail] of unwritable) left.push({ path, reason: 'unwritable', changed: path, detail })
  const keep = (path: string): boolean => !restagedEarly.has(path) && !unwritable.has(path)
  const emptied = await removeProvenAsync({
    top,
    restore: input.restore.filter(keep),
    remove: [...input.remove, ...input.untracked].filter(keep),
    digests: input.digests,
    ...(input.beforeUnlink ? { beforeUnlink: input.beforeUnlink } : {})
  })
  left.push(...emptied.left)
  const cleared = new Set(emptied.cleared)
  // Settled: left with a reason, or finished with nothing more to do (an untracked path emptied).
  const settled = new Set<string>([...left.map((item) => item.path), ...emptied.cleared.filter((path) => input.untracked.includes(path))])
  try {
    if (input.wholeTree) await removeEmptyFoldersUnder(top, input.wholeTree.untrackedFolders)
    // HEAD's versions, only into empty paths, and (for the pending-changes Discard) only inside the sparse checkout.
    let write = input.restore.filter((path) => cleared.has(path))
    const outside = input.wholeTree ? await outsideSparseCheckout(discardGit, write) : new Set<string>()
    write = write.filter((path) => !outside.has(path))
    const { notWritten, entries } = await writeFromHeadAsync(top, discardGit, write)
    for (const [path, why] of notWritten) {
      left.push({ path, reason: why.reason, changed: path, ...(why.detail ? { detail: why.detail } : {}) })
      settled.add(path)
    }
    // One transaction on the real index, under its lock, which Mousse takes itself: each entry changes only if it is still
    // what was read before anything was removed. One staged anew meanwhile keeps its staged version and is named, and
    // the whole index (ending a merge, revert or cherry-pick) goes back to HEAD only if nothing in it changed.
    const done = [...cleared, ...input.indexOnly.filter(keep)].filter((path) => !settled.has(path) && !input.untracked.includes(path))
    const put = new Map<string, string>()
    const drop: string[] = []
    const indexOnlyHead = input.head ? await headEntries(discardGit, input.head, input.indexOnly.filter((path) => done.includes(path))) : new Map<string, string>()
    for (const path of done) {
      const line = entries.get(path) ?? indexOnlyHead.get(path)
      if (line !== undefined) put.set(path, line)
      // Outside the sparse checkout, a path HEAD has and that was not written still gets HEAD's entry, marked skip-worktree.
      else if (outside.has(path)) put.set(path, '')
      else drop.push(path)
    }
    if (outside.size && input.head) {
      for (const [path, line] of await headEntries(discardGit, input.head, [...put].filter(([, line]) => line === '').map(([path]) => path))) put.set(path, line)
    }
    for (const [path, line] of [...put]) if (!line) { put.delete(path); drop.push(path) }
    const committed = await commitIndexAsync(top, discardGit, input.head, input.stagedBefore, { put, drop, sparse: [...outside].filter((path) => put.has(path)), wholeTree: input.wholeTree !== undefined && !left.length })
    if (committed.locked) {
      for (const path of done) left.push({ path, reason: 'locked', changed: path })
      return { left, endedOperation: false, stagedElsewhere: [] }
    }
    for (const path of committed.restaged) left.push({ path, reason: 'restaged', changed: path })
    return { left, endedOperation: committed.ended, stagedElsewhere: committed.elsewhere, ...(committed.written ? { indexWritten: committed.written } : {}) }
  } catch (error) {
    // Files were removed: the copy is still the answer, with what was not finished and why.
    const detail = firstLine((error as Error).message)
    for (const path of discarded) if (!settled.has(path) && !left.some((item) => item.path === path)) left.push({ path, reason: 'failed', changed: path, detail })
    return { left, endedOperation: false, stagedElsewhere: [] }
  }
}

/**
 * Of `paths`, those under a `filter` attribute whose HEAD version Git cannot write as this caller runs it (a filter only
 * the repository configures, which Mousse's own commands do not run), with Git's message. Asked before anything is
 * removed, so such a path is never emptied. The check is the write itself, into a scratch folder in the Git folder: the
 * same `checkout-index`, from a private index of HEAD's entries, once for all the paths (one at a time only when that
 * fails). When a `.gitattributes` is among the discarded paths it goes back to HEAD's too, so then the attributes as
 * HEAD has them are tried as well (`attributesDiscarded`).
 */
async function unwritableAsync(top: string, discardGit: DiscardGit, head: string | undefined, paths: readonly string[], attributesDiscarded: boolean): Promise<Map<string, string>> {
  const unwritable = new Map<string, string>()
  if (!head || !paths.length) return unwritable
  const sources: Array<Record<string, string>> = attributesDiscarded ? [{}, { GIT_ATTR_SOURCE: head }] : [{}]
  const filtered = new Set<string>()
  for (const source of sources) {
    const attrs = await discardGit(['check-attr', '-z', '--stdin', 'filter'], { input: `${paths.join('\0')}\0`, env: source })
    if (attrs.status !== 0) continue
    const fields = attrs.stdout.split('\0')
    for (let at = 0; at + 2 < fields.length; at += 3) if (fields[at + 2] !== 'unspecified' && fields[at + 2] !== 'unset') filtered.add(fields[at]!)
  }
  if (!filtered.size) return unwritable
  const entries = await headEntries(discardGit, head, [...filtered])
  const gitDir = resolve(top, firstLine((await discardGit(['rev-parse', '--absolute-git-dir'])).stdout))
  const scratch = join(gitDir, `mousse-discard-check-${randomUUID()}`)
  const index = `${scratch}.index`
  try {
    const made = await discardGit(['update-index', '-z', '--index-info'], { env: privateIndexEnv(index), input: `${[...entries.values()].join('\0')}\0`, write: true })
    if (made.status !== 0) return unwritable
    const asked = [...entries.keys()]
    for (const source of sources) {
      const env = privateIndexEnv(index, source)
      const all = await discardGit(['checkout-index', '-f', `--prefix=${scratch}/`, '-z', '--stdin'], { env, input: `${asked.join('\0')}\0`, write: true })
      await rm(scratch, { recursive: true, force: true })
      if (all.status === 0) continue
      for (const path of asked) {
        if (unwritable.has(path)) continue
        const one = await discardGit(['checkout-index', '-f', `--prefix=${scratch}/`, '-z', '--stdin'], { env, input: `${path}\0`, write: true })
        await rm(scratch, { recursive: true, force: true })
        if (one.status !== 0) unwritable.set(path, firstLine(one.stderr) || 'its filter did not discardGit')
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
    await rm(index, { force: true })
    await rm(`${index}.lock`, { force: true })
  }
  return unwritable
}

/** HEAD's entry for each of `paths` it has, as `update-index --index-info` takes it (`<mode> <object>\t<path>`), by path. */
async function headEntries(discardGit: DiscardGit, head: string, paths: readonly string[]): Promise<Map<string, string>> {
  const byPath = new Map<string, string>()
  for (const batch of literalBatches(paths)) {
    for (const line of await listZ(discardGit, ['ls-tree', '-z', head, '--', ...batch])) {
      const tab = line.indexOf('\t')
      const [mode, , object] = line.slice(0, tab).split(' ')
      byPath.set(line.slice(tab + 1), `${mode} ${object}${line.slice(tab)}`)
    }
  }
  return byPath
}

/** Of `paths`, those outside the sparse checkout, when there is one (`sparse-checkout check-rules`, Git 2.42 and later). */
async function outsideSparseCheckout(discardGit: DiscardGit, paths: readonly string[]): Promise<Set<string>> {
  if (!paths.length || firstLine((await discardGit(['config', '--type=bool', 'core.sparseCheckout'])).stdout) !== 'true') return new Set()
  const ran = await discardGit(['sparse-checkout', 'check-rules', '-z'], { input: `${paths.join('\0')}\0` })
  if (ran.status !== 0) return new Set()
  const inside = new Set(ran.stdout.split('\0').filter(Boolean))
  return new Set(paths.filter((path) => !inside.has(path)))
}

/**
 * The index's entries (`ls-files -s -z`: mode, object, stage and path) as one digest each, by path: compared before and
 * after the files go, so an entry staged by someone else meanwhile is not reset. Stat data is left out, so Git
 * refreshing the index changes nothing here.
 */
export function stagedEntryDigests(listing: readonly string[]): Map<string, string> {
  const lines = new Map<string, string[]>()
  for (const line of listing) {
    const path = line.slice(line.indexOf('\t') + 1)
    lines.set(path, [...(lines.get(path) ?? []), line])
  }
  return new Map([...lines].map(([path, entries]) => [path, createHash('sha256').update(entries.join('\0')).digest('hex')]))
}

/** The mode of each path's index entry (`ls-files -s -z` lines), by path. */
export function stagedModes(listing: readonly string[]): Map<string, string> {
  return new Map(listing.map((line) => [line.slice(line.indexOf('\t') + 1), line.slice(0, line.indexOf(' '))]))
}

/** The paths whose index entries differ between two {@link stagedEntryDigests}, among `paths`. */
export function stagedSince(before: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>, paths: readonly string[]): string[] {
  return paths.filter((path) => before.get(path) !== now.get(path))
}

/** How many paths a sentence names before it says "and N more". */
const NAMED = 3

function listed(paths: readonly string[]): string {
  const named = paths.slice(0, NAMED)
  if (paths.length > NAMED) return `${named.join(', ')} and ${paths.length - NAMED} more`
  return named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0]!
}

/**
 * The lines a result shows for paths a discard did not discard, or not wholly, or undefined when there are none. One
 * sentence per reason, for example: "base.txt changed after you pressed Discard, so it was left as it is."
 */
export function leftAsItIsText(left: readonly LeftAsItIs[]): string | undefined {
  const by = (reason: LeftReason): LeftAsItIs[] => left.filter((item) => item.reason === reason)
  const paths = (items: readonly LeftAsItIs[]): string[] => [...new Set(items.map((item) => item.path))]
  const one = (items: readonly LeftAsItIs[]): boolean => paths(items).length === 1
  const sentences: string[] = []
  const changed = by('changed')
  if (changed.length) sentences.push(`${listed(paths(changed))} changed after you pressed Discard, so ${one(changed) ? 'it was left as it is' : 'they were left as they are'}.`)
  // One sentence per place, however many discarded paths lie in it.
  const places = new Map<string, LeftAsItIs>()
  for (const item of by('partly')) if (!places.has(item.place ?? item.path)) places.set(item.place ?? item.path, item)
  for (const [place, item] of places) {
    const removed = item.removed ?? []
    const what = removed.length === 1 ? `${removed[0]} was removed before that and is` : `${removed.length} files in it were removed before that and are`
    sentences.push(`${item.changed} changed while Discard was removing ${place}, so the rest of ${place} was left as it is; ${what} in the copy.`)
  }
  const recreated = by('recreated')
  if (recreated.length) sentences.push(`${listed(paths(recreated))} ${one(recreated) ? 'was' : 'were'} saved again after Discard removed ${one(recreated) ? 'it' : 'them'}, so the new ${one(recreated) ? 'version was' : 'versions were'} left as ${one(recreated) ? 'it is' : 'they are'}.`)
  const restaged = by('restaged')
  if (restaged.length) sentences.push(`${listed(paths(restaged))} ${one(restaged) ? 'was' : 'were'} staged again while Discard ran, so the staged ${one(restaged) ? 'version was' : 'versions were'} kept; the earlier ${one(restaged) ? 'file is' : 'files are'} in the copy.`)
  const locked = by('locked')
  if (locked.length) sentences.push(`Git's index stayed locked by another Git command, so the staged ${one(locked) ? 'version' : 'versions'} of ${listed(paths(locked))} ${one(locked) ? 'was' : 'were'} left as ${one(locked) ? 'it was' : 'they were'}; the files went back to HEAD's versions.`)
  const failed = by('failed')
  if (failed.length) sentences.push(`Git could not put back ${listed(paths(failed))}${failed[0]!.detail ? ` (${failed[0]!.detail})` : ''}; the earlier ${one(failed) ? 'version is' : 'versions are'} in the copy.`)
  const operation = by('operation')
  if (operation.length) sentences.push(`${listed(paths(operation))} ${one(operation) ? 'was' : 'were'} staged while Discard ran, so the unfinished merge, revert or cherry-pick was not ended.`)
  const unwritable = by('unwritable')
  if (unwritable.length) sentences.push(`Git cannot write ${listed(paths(unwritable))} back here${unwritable[0]!.detail ? ` (${unwritable[0]!.detail})` : ''}, so ${one(unwritable) ? 'it was left as it is' : 'they were left as they are'}.`)
  return sentences.length ? sentences.join(' ') : undefined
}
