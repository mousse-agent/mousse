import { lstatSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertFrozenEntryUnchanged, proveFrozenContentEntryAsync, readFrozenEntryAsync, type FrozenEntryProof } from '../lifecycle/verifiedDelete'
import { listZSync } from './git'
import { gitsFormsAsync, readConvertedAsync } from './heldBytes'
import { keepCopy, KeepCopyRefusedError, listZ, listZOver, modesIn, writeBackKeptFiles, type KeepCopyOperation, type KeptCopy } from './keptCopies'
import { removeProvenAsync } from './provenDiscard'

/**
 * Lets Git write over files after keeping what only they hold: Abort's merge, rebase, cherry-pick or revert, and Publish's
 * fast-forward into the person's checkout.
 *
 * 1. The caller says, each round, which paths Git writes `target`'s version at or removes (`writes`), and, for Abort's
 *    autostash, paths kept alongside that Git's run may write over only where an ignored file stands (`alongside`).
 * 2. Those paths are kept as one copy of the owner's (`keepCopy`): staged and working versions, conflict stages, and
 *    whatever stands where Git writes, ignored files included. With `held: 'left'` (Publish), a file whose bytes on disk
 *    are exactly Git's form of its index entry, or a link whose target is its blob, is not kept: the commit Git moves
 *    from already holds it. It stays where it is, proven, and Git writes over it, as it would anyway; unless another path
 *    Git writes is below or above it (a file that becomes a folder, a folder that becomes a file), when it is kept and
 *    removed like the rest. With `untracked`, a kept path the index has no entry for (a file that is not tracked, or
 *    ignored, where Git writes) refuses instead, with nothing removed.
 *    The index entries at those paths are read before the copy and again after it: any change (a flag set, a version
 *    staged) since the first read starts the round again, so nothing is removed on what the index said before the copy.
 * 3. Mousse removes what stands at each kept path Git writes, as far as the copy proves it holds it (`removeProvenAsync`).
 *    At `alongside` paths only ignored files go; the rest stays, proven against the copy. Anything that changed or
 *    appeared since puts back what was removed, and the copy is kept again, up to {@link OVERWRITE_KEEP_ROUNDS} times;
 *    then the action refuses, naming it.
 * 4. Right before Git starts, synchronously, every emptied path must still be empty, every file left in place unchanged,
 *    the index entries at the paths Git writes as they were read, and nothing new may be among what Git writes (`grown`):
 *    anything else puts back, keeps again.
 * 5. Git then only creates files where nothing stands. When it fails, every removed file is put back where nothing
 *    stands; where Git wrote first, the error names the copy and the commands that bring those files back.
 *
 * The limits that remain: a file created at an emptied path after Mousse's last check, while Git starts and before it
 * writes there, is written over by Git or makes Git refuse; a file left in place (held, or flagged) that changes in that
 * moment the same way. If Mousse stops between removing files and Git's run, the files are missing from the folder; the
 * copy holds them, and `holding` is told which paths were about to be emptied before any was, so a caller can put them
 * back on recovery.
 */

/** How many times a copy is kept again because a kept file changed, or something appeared, before Git ran. */
export const OVERWRITE_KEEP_ROUNDS = 3

/** What Git writes in one round, read afresh each time: a file staged since the last round changes it. */
export interface OverwriteRound {
  /** The commit whose versions Git writes at `writes`. */
  target: string
  /** Repository-relative paths Git writes `target`'s version at, or removes. */
  writes: readonly string[]
  /** Paths kept in the same copy that Git's run writes over only where an ignored file stands; anything else there stays. */
  alongside?: readonly string[]
  /** Synchronously, right before Git starts: a path Git would write now that this round does not list, else undefined. */
  grown?: (listed: ReadonlySet<string>) => string | undefined
  /** The index at `writes` ({@link indexAt}), when the caller has just read it; read here otherwise. */
  index?: IndexAt
  /**
   * Whether a flag (`assume-unchanged`, `skip-worktree`) set or cleared once files are removed counts, right before Git
   * starts, as a change: `compare` (the default) where it makes Git leave a path as it is (a rebase's `reset --hard`, a
   * fast-forward); `ignore` where Git writes a flagged entry's file all the same (`reset --merge`), as plain Git would.
   */
  flagsAtStart?: 'compare' | 'ignore'
}

export interface OverwriteKeepingCopyInput {
  /** The owner's folder: whose journal records the copy and whose Undo window keeps it. */
  owner: string
  /** The repository's top folder. */
  top: string
  operationType: KeepCopyOperation
  /** The action, as a refusal names it: `Abort`, `Publish`. */
  action: string
  /** What Git writes now, or undefined when there is nothing in progress to write over: `run` then runs with no check. */
  round: () => Promise<OverwriteRound | undefined>
  /** `kept` (the default): every path Git writes is kept. `left`: a file whose bytes are Git's form of its index entry is left out of the copy, proven, and left in place. */
  held?: 'kept' | 'left'
  /** Runs once a round's copy is kept, before anything is removed, with the kept paths about to be emptied and the paths proven held. */
  holding?: (kept: KeptCopy, emptied: readonly string[], held: ReadonlySet<string>) => void | Promise<void>
  /** With it, a kept path the index has no entry for (not tracked, or ignored) refuses with this error before anything is removed. */
  untracked?: (paths: readonly string[]) => Error
  /**
   * Runs Git, throwing when it fails. `beforeStart` must run synchronously right before Git starts (`runGitProcess`'s
   * option of that name); what it throws is to be thrown as it is, with Git not started.
   */
  run: (beforeStart: () => void) => Promise<void>
  /** The error for Git failing after it wrote over `paths`, which the copy holds. */
  stoppedPartWay: (gitError: unknown, kept: KeptCopy, paths: readonly string[]) => Error
}

/**
 * What was written over: the copy, when one was kept; the paths proven held (Git's form of their index entry), whether
 * left in place or kept because another path Git writes is below or above them; and the paths Mousse emptied for Git to
 * write `target`'s version at.
 */
export interface Overwritten { kept?: KeptCopy; held: string[]; emptied: string[] }

/** Something stood at a path Git writes, or a file left in place changed, right before Git was to start. */
class ChangedBeforeGit extends Error {
  constructor(readonly path: string) { super(`${path} changed before Git started`) }
}

const gone = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')
const absolute = (top: string, rel: string): string => join(top, ...rel.split('/'))

/** Paths for a sentence: the first few, and how many more. */
export function namedFew(paths: readonly string[]): string {
  return paths.slice(0, 5).join(', ') + (paths.length > 5 ? ` and ${paths.length - 5} more` : '')
}

/** The index's entries at some paths: modes and blobs, conflicted and flagged paths, and each path's whole entry text. */
export interface IndexAt {
  modes: Map<string, string>
  blobs: Map<string, string>
  unmerged: Set<string>
  /** Paths flagged `assume-unchanged` or `skip-worktree`: Git does not look at their files. */
  flagged: Set<string>
  /** `tag mode blob stage` for each path (each stage, for a conflicted one): what the final check compares. */
  entries: Map<string, string>
}

/** Over this many paths, the whole index is read once and filtered, rather than asked for path by path. */
const WHOLE_INDEX = 200
const INDEX_LISTING = ['ls-files', '-z', '-s', '-v']

/** Whether a path is one of `paths` or below one of them, as a pathspec matches. */
function within(paths: readonly string[]): (path: string) => boolean {
  const set = new Set(paths)
  return (path) => {
    if (set.has(path)) return true
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) if (set.has(path.slice(0, slash))) return true
    return false
  }
}

/** `ls-files -s -v` lines (`tag mode blob stage<TAB>path`), filtered. A lowercase tag is assume-unchanged, `S` skip-worktree. */
function parseIndex(lines: readonly string[], keep: (path: string) => boolean): IndexAt {
  const found: IndexAt = { modes: new Map(), blobs: new Map(), unmerged: new Set(), flagged: new Set(), entries: new Map() }
  // Listings in batches can name one entry twice (a folder in one batch, a path below it in the next): each counts once.
  for (const line of new Set(lines)) {
    const tab = line.indexOf('\t')
    const path = line.slice(tab + 1)
    if (!keep(path)) continue
    const [tag, mode, blob, stage] = line.slice(0, tab).split(' ') as [string, string, string, string]
    found.modes.set(path, mode)
    if (stage === '0') found.blobs.set(path, blob)
    else found.unmerged.add(path)
    if (/^[a-zS]$/.test(tag)) found.flagged.add(path)
    const entry = `${tag} ${mode} ${blob} ${stage}`
    found.entries.set(path, found.entries.has(path) ? `${found.entries.get(path)},${entry}` : entry)
  }
  return found
}

/**
 * The index's entries at `paths` and below them: their modes and blobs, which are conflicted, and which carry a flag
 * that tells Git not to look at the file (`assume-unchanged`, `skip-worktree`). One listing; for many paths, of the whole index.
 */
export async function indexAt(top: string, paths: readonly string[]): Promise<IndexAt> {
  if (!paths.length) return parseIndex([], () => false)
  const lines = paths.length > WHOLE_INDEX ? await listZ(top, INDEX_LISTING) : await listZOver(top, INDEX_LISTING, paths)
  return parseIndex(lines, within(paths))
}

/** {@link indexAt}'s entry texts, read synchronously and without taking Git's optional locks: for the check right before Git starts. */
function indexEntriesSync(top: string, paths: readonly string[]): Map<string, string> {
  if (!paths.length) return new Map()
  const quiet = { GIT_OPTIONAL_LOCKS: '0' }
  const lines = paths.length > WHOLE_INDEX ? listZSync(top, INDEX_LISTING, quiet) : listZSync(top, [...INDEX_LISTING, '--', ...paths.map((path) => `:(literal)${path}`)], quiet)
  return parseIndex(lines, within(paths)).entries
}

/**
 * The first path whose index entry differs between two readings, or undefined. With `flags: 'ignore'`, a flag set or
 * cleared alone is not a difference.
 */
function changedEntry(before: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>, flags: 'compare' | 'ignore' = 'compare'): string | undefined {
  const plain = (entry: string | undefined): string | undefined => flags === 'compare' || entry === undefined ? entry : entry.split(',').map((stage) => stage.slice(stage.indexOf(' ') + 1)).join(',')
  for (const [path, entry] of before) if (plain(now.get(path)) !== plain(entry)) return path
  for (const path of now.keys()) if (!before.has(path)) return path
  return undefined
}

/** Ancestors of a slash-separated path, nearest last: `a/b/c` → `a`, `a/b`. */
function ancestorsOf(path: string): string[] {
  const found: string[] = []
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) found.push(path.slice(0, slash))
  return found
}

/**
 * Files that are not tracked (and not ignored) where `target` has a file and the index has none, or standing where a
 * folder above such a path goes: Git refuses to write over them, so an action that empties paths first must refuse too.
 * `indexed` are the paths the index has an entry at, of those written.
 */
export async function untrackedInTheWay(top: string, target: string, writes: readonly string[], indexed: ReadonlyMap<string, string>): Promise<string[]> {
  if (!writes.length) return []
  const targetModes = await modesIn(top, target, writes)
  const wanted = writes.filter((path) => targetModes.has(path) && targetModes.get(path) !== '160000' && !indexed.has(path))
  if (!wanted.length) return []
  // A file or link where a folder above a wanted path goes is in the way too; a real folder there is not.
  const above = new Set<string>()
  for (const path of wanted) {
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
      const info = await lstat(absolute(top, path.slice(0, slash))).catch(() => undefined)
      if (!info) break
      if (!info.isDirectory()) { above.add(path.slice(0, slash)); break }
    }
  }
  return [...new Set(await listZOver(top, ['ls-files', '-z', '--others', '--exclude-standard'], [...wanted, ...above]))].sort()
}

/**
 * Whether anything stands at `rel` now, never through a link, synchronously. For a path Git writes (`write`), a file or
 * link standing where a folder above it goes is in the way too; for one it removes, nothing stands below a link.
 */
function standsAt(top: string, rel: string, write: boolean): boolean {
  for (let slash = rel.indexOf('/'); slash !== -1; slash = rel.indexOf('/', slash + 1)) {
    let info
    try { info = lstatSync(absolute(top, rel.slice(0, slash))) } catch (error) { if (gone(error)) return false; return true }
    if (!info.isDirectory()) return write
  }
  try { lstatSync(absolute(top, rel)); return true } catch (error) { return !gone(error) }
}

/**
 * Lets Git write over the paths each round names after keeping what they hold (see the top of this file). Returns
 * undefined when `round` finds nothing in progress and `run` did not fail. The caller holds the repository's mutation
 * locks. A refusal ({@link KeepCopyRefusedError}) names the files and changed nothing; Git failing after it wrote is
 * the caller's `stoppedPartWay` error.
 */
export async function overwriteKeepingCopy(input: OverwriteKeepingCopyInput): Promise<Overwritten | undefined> {
  const top = resolve(input.top)
  let changed: string[] = []
  for (let round = 0; round < OVERWRITE_KEEP_ROUNDS; round++) {
    const plan = await input.round()
    if (!plan) { await input.run(() => undefined); return undefined }
    const { target, writes } = plan
    const writeSet = new Set(writes)
    const stashed = (plan.alongside ?? []).filter((path) => !writeSet.has(path))
    const before = plan.index ?? await indexAt(top, writes)

    // A file whose bytes are Git's form of its index entry, or a link whose target is its blob, is held by the commit Git
    // moves from: proven, and left in place, unless another path Git writes is below or above it.
    const heldAll = new Map<string, FrozenEntryProof>()
    if (input.held === 'left') {
      const unflagged = (path: string): boolean => before.blobs.has(path) && !before.flagged.has(path)
      const files = writes.filter((path) => ['100644', '100755'].includes(before.modes.get(path) ?? '') && unflagged(path))
      const links = writes.filter((path) => before.modes.get(path) === '120000' && unflagged(path))
      const [{ read }, targets] = await Promise.all([
        files.length ? readConvertedAsync(top, before.blobs, files) : { read: [] },
        links.length ? gitsFormsAsync(top, links.map((path) => ({ path, blob: before.blobs.get(path)! })), { raw: true }) : new Map<string, { bytes: number; digest: string }>()
      ])
      for (const entry of read) if (entry.held) heldAll.set(entry.path, entry.proof)
      for (const path of links) {
        const proof = await readFrozenEntryAsync(top, path).catch(() => undefined)
        if (proof?.entry.kind === 'link' && proof.entry.digest === targets.get(path)?.digest) heldAll.set(path, proof)
      }
    }
    // Paths with another path Git writes below them (a file that becomes a folder), or above them (a folder that becomes
    // a file): removing the one removes the other, so neither is left in place.
    const above = new Set(writes.flatMap(ancestorsOf))
    const overlaps = (path: string): boolean => above.has(path) || ancestorsOf(path).some((folder) => writeSet.has(folder))
    const held = [...heldAll].filter(([path]) => !overlaps(path)).map(([path, proof]) => ({ path, proof }))
    const heldSet = new Set(held.map((entry) => entry.path))
    // Where nothing stands (a file Git adds), there is nothing to keep; the path must only stay empty until Git runs.
    const empties = input.held === 'left' ? writes.filter((path) => !heldSet.has(path) && !standsAt(top, path, true)) : []
    const emptySet = new Set(empties)
    const keptWrites = writes.filter((path) => !heldSet.has(path) && !emptySet.has(path))
    const kept = input.held !== 'left' || keptWrites.length || stashed.length
      ? await keepCopy({ owner: input.owner, top, operationType: input.operationType, action: input.action, paths: [...keptWrites, ...stashed], writes: [...keptWrites, ...stashed], target })
      : undefined
    // Read again after the copy: what is removed is decided on the index as it is now, and a change since the first
    // reading (a flag set, a version staged) starts the round again before anything is removed.
    const index = await indexAt(top, writes)
    const restaged = changedEntry(before.entries, index.entries)
    if (restaged !== undefined) { changed = [restaged]; continue }
    if (kept && input.untracked) {
      const foreign = [...kept.digests.keys()].filter((path) => !index.modes.has(path)).sort()
      if (foreign.length) throw input.untracked(foreign)
    }

    // A submodule is changed in the index only: its folder is never walked or removed.
    const targetModes = await modesIn(top, target, keptWrites)
    // An entry flagged assume-unchanged or skip-worktree is left to Git, which may leave its file as it is; it is proven
    // unchanged instead.
    const tree = keptWrites.filter((path) => targetModes.get(path) !== '160000' && index.modes.get(path) !== '160000' && !index.flagged.has(path))
    const flaggedInPlace = keptWrites.filter((path) => index.flagged.has(path) && index.modes.get(path) !== '160000')
    // At the paths kept alongside, Git's run writes over an ignored file; anything else there it leaves.
    const ignored = new Set(stashed.length ? await listZOver(top, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], stashed) : [])
    const restore = tree.filter((path) => targetModes.has(path))
    const remove = [...tree.filter((path) => !targetModes.has(path)), ...stashed.filter((path) => ignored.has(path))]
    if (kept) await input.holding?.(kept, [...restore, ...remove], new Set(heldAll.keys()))
    const cleared = kept ? await removeProvenAsync({ top, restore, remove, digests: kept.digests }) : { left: [], removed: [] as string[] }
    const removed = cleared.removed
    const again = async (paths: readonly string[]): Promise<void> => {
      // What was removed is put back as it was kept; the copy is kept again with the change.
      if (kept) await writeBackKeptFiles(top, kept.sha, removed, kept.permissions)
      changed = [...paths]
    }
    if (cleared.left.length) { await again(cleared.left.map((entry) => entry.changed ?? entry.path)); continue }

    // What stays where it is (at the other paths kept alongside, and flagged entries) is proven against the copy now and
    // checked again right before Git starts; an empty path there must stay empty. Held files were proven as they were read,
    // and a path nothing stood at must stay empty too.
    const stays: Array<{ path: string; proof?: FrozenEntryProof }> = [...held, ...empties.map((path) => ({ path }))]
    let appeared: string | undefined
    for (const path of [...stashed.filter((item) => !ignored.has(item)), ...flaggedInPlace]) {
      const info = await lstat(absolute(top, path)).catch((error: unknown) => { if (gone(error)) return undefined; throw error })
      if (!info) { stays.push({ path }); continue }
      if (!info.isFile() && !info.isSymbolicLink()) continue
      const digest = kept?.digests.get(path)
      try {
        if (digest === undefined) throw new Error('not in the copy')
        stays.push({ path, proof: await proveFrozenContentEntryAsync(top, { path, kind: info.isFile() ? 'file' : 'link', digest, bytes: info.size, mode: info.mode }, { otherLinks: true }) })
      } catch { appeared = path; break }
    }
    if (appeared) { await again([appeared]); continue }

    const empty = [...restore.map((path) => ({ path, write: true })), ...remove.map((path) => ({ path, write: false }))]
    const listed = new Set([...writes, ...stashed])
    const beforeStart = (): void => {
      for (const { path, write } of empty) if (standsAt(top, path, write)) throw new ChangedBeforeGit(path)
      const grown = plan.grown?.(listed)
      if (grown !== undefined) throw new ChangedBeforeGit(grown)
      // A version staged or a flag set since the index was read: Git might leave an emptied path empty, or a file in place.
      const restagedNow = changedEntry(index.entries, indexEntriesSync(top, writes), plan.flagsAtStart)
      if (restagedNow !== undefined) throw new ChangedBeforeGit(restagedNow)
      for (const { path, proof } of stays) {
        if (!proof) { if (standsAt(top, path, true)) throw new ChangedBeforeGit(path); continue }
        try { assertFrozenEntryUnchanged(proof) } catch { throw new ChangedBeforeGit(path) }
      }
    }
    try {
      await input.run(beforeStart)
    } catch (error) {
      if (error instanceof ChangedBeforeGit) { await again([error.path]); continue }
      // Git failed: every removed file goes back where nothing stands. Where Git had written first, the error says where
      // the copy is.
      const left = kept ? await writeBackKeptFiles(top, kept.sha, removed, kept.permissions) : []
      if (left.length) throw input.stoppedPartWay(error, kept!, left)
      throw error
    }
    return { ...(kept ? { kept } : {}), held: [...heldAll.keys()], emptied: restore }
  }
  throw new KeepCopyRefusedError(`${input.action} was stopped: ${namedFew(changed)} kept changing while ${changed.length === 1 ? 'its' : 'their'} copy was being kept. Nothing was changed; try again once ${changed.length === 1 ? 'it has' : 'they have'} stopped changing.`, changed)
}
