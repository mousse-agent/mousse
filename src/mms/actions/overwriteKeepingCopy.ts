import { lstatSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertFrozenEntryUnchanged, proveFrozenContentEntryAsync, type FrozenEntryProof } from '../lifecycle/verifiedDelete'
import { readConvertedAsync } from './heldBytes'
import { keepCopy, KeepCopyRefusedError, listZOver, modesIn, writeBackKeptFiles, type KeepCopyOperation, type KeptCopy } from './keptCopies'
import { removeProvenAsync } from './provenDiscard'

/**
 * Lets Git write over files after keeping what only they hold: Abort's merge, rebase, cherry-pick or revert, and Publish's
 * fast-forward into the person's checkout.
 *
 * 1. The caller says, each round, which paths Git writes `target`'s version at or removes (`writes`), and, for Abort's
 *    autostash, paths kept alongside that Git's run may write over only where an ignored file stands (`alongside`).
 * 2. Those paths are kept as one copy of the owner's (`keepCopy`): staged and working versions, conflict stages, and
 *    whatever stands where Git writes, ignored files included. With `held: 'left'` (Publish), a file whose bytes on disk
 *    are exactly Git's form of its index entry is not kept: the commit Git moves from already holds it. It stays where it
 *    is, proven, and Git writes over it, as it would anyway.
 * 3. Mousse removes what stands at each kept path Git writes, as far as the copy proves it holds it (`removeProvenAsync`).
 *    At `alongside` paths only ignored files go; the rest stays, proven against the copy. Anything that changed or
 *    appeared since puts back what was removed, and the copy is kept again, up to {@link OVERWRITE_KEEP_ROUNDS} times;
 *    then the action refuses, naming it.
 * 4. Right before Git starts, synchronously, every emptied path must still be empty, every file left in place unchanged,
 *    and nothing new may be among what Git writes (`grown`): anything else puts back, keeps again.
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
  /** Runs once a round's copy is kept, before anything is removed, with the kept paths that are about to be emptied. */
  holding?: (kept: KeptCopy, emptied: readonly string[]) => void | Promise<void>
  /**
   * Runs Git, throwing when it fails. `beforeStart` must run synchronously right before Git starts (`runGitProcess`'s
   * option of that name); what it throws is to be thrown as it is, with Git not started.
   */
  run: (beforeStart: () => void) => Promise<void>
  /** The error for Git failing after it wrote over `paths`, which the copy holds. */
  stoppedPartWay: (gitError: unknown, kept: KeptCopy, paths: readonly string[]) => Error
}

/** What was written over: the copy, when one was kept, and the files left out of it because their commit holds them. */
export interface Overwritten { kept?: KeptCopy; held: string[] }

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

/**
 * The index's entries at `paths`: their modes and blobs, which are conflicted, and which carry a flag that tells Git not
 * to look at the file (`assume-unchanged`, `skip-worktree`).
 */
export async function indexAt(top: string, paths: readonly string[]): Promise<{ modes: Map<string, string>; blobs: Map<string, string>; unmerged: Set<string>; flagged: Set<string> }> {
  const modes = new Map<string, string>()
  const blobs = new Map<string, string>()
  const unmerged = new Set<string>()
  const flagged = new Set<string>()
  if (!paths.length) return { modes, blobs, unmerged, flagged }
  for (const line of await listZOver(top, ['ls-files', '-z', '-s'], paths)) {
    const tab = line.indexOf('\t')
    const [mode, blob, stage] = line.slice(0, tab).split(' ') as [string, string, string]
    const path = line.slice(tab + 1)
    modes.set(path, mode)
    if (stage === '0') blobs.set(path, blob)
    else unmerged.add(path)
  }
  // `ls-files -v`: a lowercase tag is assume-unchanged, `S` (or `s`) skip-worktree.
  for (const line of await listZOver(top, ['ls-files', '-z', '-v'], paths)) if (/^[a-zS] /.test(line)) flagged.add(line.slice(2))
  return { modes, blobs, unmerged, flagged }
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
    const index = await indexAt(top, writes)

    // A file whose bytes are Git's form of its index entry is held by the commit Git moves from: proven, and left.
    const held: Array<{ path: string; proof: FrozenEntryProof }> = []
    if (input.held === 'left') {
      const candidates = writes.filter((path) => ['100644', '100755'].includes(index.modes.get(path) ?? '') && index.blobs.has(path) && !index.flagged.has(path))
      const { read } = candidates.length ? await readConvertedAsync(top, index.blobs, candidates) : { read: [] }
      for (const entry of read) if (entry.held) held.push({ path: entry.path, proof: entry.proof })
    }
    const heldSet = new Set(held.map((entry) => entry.path))
    // Where nothing stands (a file Git adds), there is nothing to keep; the path must only stay empty until Git runs.
    const empties = input.held === 'left' ? writes.filter((path) => !heldSet.has(path) && !standsAt(top, path, true)) : []
    const emptySet = new Set(empties)
    const keptWrites = writes.filter((path) => !heldSet.has(path) && !emptySet.has(path))
    const kept = input.held !== 'left' || keptWrites.length || stashed.length
      ? await keepCopy({ owner: input.owner, top, operationType: input.operationType, action: input.action, paths: [...keptWrites, ...stashed], writes: [...keptWrites, ...stashed], target })
      : undefined

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
    if (kept) await input.holding?.(kept, [...restore, ...remove])
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
    return { ...(kept ? { kept } : {}), held: [...heldSet] }
  }
  throw new KeepCopyRefusedError(`${input.action} was stopped: ${namedFew(changed)} kept changing while ${changed.length === 1 ? 'its' : 'their'} copy was being kept. Nothing was changed; try again once ${changed.length === 1 ? 'it has' : 'they have'} stopped changing.`, changed)
}
