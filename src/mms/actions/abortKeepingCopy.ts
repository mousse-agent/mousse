import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { access, lstat, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertFoldersUnchanged, assertFrozenEntryUnchanged, FolderChanged, proveFrozenContentEntryAsync, recordFoldersAboveAsync, type FrozenEntryProof } from '../lifecycle/verifiedDelete'
import { gitAsync, NOT_MOUSSE, tryGitAsync } from './git'
import { keepCopy, KeepCopyRefusedError, listZ, pendingWrites, writeBackKeptFiles, type KeptCopy } from './keptCopies'

/**
 * Abort that never loses an edit: the merge, rebase, cherry-pick or revert Git stopped in is given up only after the
 * files it writes over are kept.
 *
 * 1. Git's abort goes back to a commit, the abort target: HEAD for a merge or a single cherry-pick or revert, the
 *    commit a rebase started from (`orig-head`), or the commit a run of cherry-picks or reverts started from (the
 *    sequencer's `head`). The paths it writes ({@link abortWrites}) are kept as one copy of the owner's (`keepCopy`,
 *    operation `git-abort`): staged and working versions, conflict stages (`^3`), and whatever stands where Git writes,
 *    ignored files included. Its first parent is HEAD as the abort found it, so commits a rebase made before it stopped
 *    stay reachable for the owner's window.
 * 2. Each kept file still on disk is proven again against the copy's bytes (`proveFrozenContentEntryAsync`). One that
 *    changed since is kept again, up to {@link ABORT_KEEP_ROUNDS} times; then the abort refuses, naming it.
 * 3. Mousse removes the proven files itself, deepest first, each checked again synchronously right before its unlink
 *    with nothing awaited in between, and the folders above it checked to be the very ones recorded. A folder in the
 *    way of a file goes once it is empty. A change found there puts back what was removed and keeps again.
 * 4. Git's abort then writes the target's versions into paths that are empty. When it fails, every removed file is put
 *    back where nothing stands, so the folder is as it was, and Git's error is thrown.
 *
 * The limit that remains: a file created at an emptied path after step 3 and before Git writes there is written over
 * by Git (a rebase's abort) or makes Git refuse (the others). That window is Git's own run, much shorter than the
 * time between keeping the copy and Git's run, which steps 2 and 3 cover.
 */

export type AbortKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

/** How many times a copy is kept again because a kept file changed before it was removed. */
export const ABORT_KEEP_ROUNDS = 3

export interface AbortKeepingCopyInput {
  /** The owner's folder: whose journal records the copy and whose Undo window keeps it. */
  owner: string
  /** The repository's top folder. */
  top: string
  kind: AbortKind
  /** The action, as a refusal names it: `Abort`. */
  action: string
  /** Runs Git's abort (`git <kind> --abort`), throwing when Git fails. */
  abort: () => Promise<void>
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

async function gitPath(top: string, name: string): Promise<string> {
  return resolve(top, await gitAsync(top, ['rev-parse', '--git-path', name]))
}

async function commitOf(top: string, revision: string): Promise<string | undefined> {
  const found = await tryGitAsync(top, ['rev-parse', '--verify', '-q', `${revision}^{commit}`])
  return found.ok && found.stdout ? found.stdout : undefined
}

/**
 * The commit Git's abort of `kind` goes back to, or undefined when no such operation is in progress (Git's own abort
 * then says so). A rebase or a run of picks whose start cannot be read refuses, since its writes cannot be known.
 */
export async function abortTarget(top: string, kind: AbortKind): Promise<string | undefined> {
  const unknown = (what: string): Error => new KeepCopyRefusedError(`Abort was stopped: the ${what} in progress does not say which commit it started from, so Mousse cannot tell which files the abort would write over. Nothing was changed.`)
  if (kind === 'merge') return await exists(await gitPath(top, 'MERGE_HEAD')) ? commitOf(top, 'HEAD') : undefined
  if (kind === 'rebase') {
    for (const folder of ['rebase-merge', 'rebase-apply']) {
      if (!await exists(await gitPath(top, folder))) continue
      const start = await readFile(await gitPath(top, `${folder}/orig-head`), 'utf8').catch(() => '')
      const commit = start.trim() ? await commitOf(top, start.trim()) : undefined
      if (!commit) throw unknown('rebase')
      return commit
    }
    return undefined
  }
  // A run of picks keeps where it started in the sequencer's folder; a single pick goes back to HEAD.
  const sequencer = await gitPath(top, 'sequencer/head')
  if (await exists(sequencer)) {
    const start = (await readFile(sequencer, 'utf8').catch(() => '')).trim()
    const commit = start ? await commitOf(top, start) : undefined
    if (!commit) throw unknown(kind)
    return commit
  }
  return await exists(await gitPath(top, kind === 'revert' ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD')) ? commitOf(top, 'HEAD') : undefined
}

/**
 * Every path Git's abort writes `target`'s version at, or removes. `.mousse/` is left out, as everywhere a copy is kept.
 * - A rebase's abort is `reset --hard <target>`: every path whose staged or working version differs from the target,
 *   conflicted paths, paths Git assumes unchanged, and the paths HEAD and the target differ at
 *   (`git diff --name-only HEAD <target>`). Untracked files elsewhere stay, as Git leaves them.
 * - The others are `reset --merge <target>`: only paths whose staged version differs from the target, and conflicted
 *   paths. A path whose index already equals the target is left alone by Git, its working version included, so it is
 *   not in the set: removing it would lose it from the folder.
 */
export async function abortWrites(top: string, kind: AbortKind, target: string): Promise<string[]> {
  const unmerged = (await listZ(top, ['ls-files', '-z', '--unmerged', '--', '.', NOT_MOUSSE])).map((line) => line.slice(line.indexOf('\t') + 1))
  if (kind === 'rebase') {
    const moved = await listZ(top, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', 'HEAD', target, '--', '.', NOT_MOUSSE])
    return [...new Set([...await pendingWrites(top, target, { untracked: [] }), ...moved, ...unmerged])]
  }
  const staged = await listZ(top, ['diff-index', '-z', '--cached', '--name-only', '--no-renames', target, '--', '.', NOT_MOUSSE])
  return [...new Set([...staged, ...unmerged])]
}

/** The `lstat` error codes that mean nothing is at a path (or a file stands above it). */
const gone = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')

type Cleared = { removed: string[] } | { changed: string[]; removed: string[]; error?: unknown }

/** An error that means what is on disk is no longer what was kept: something wrote, or a folder was swapped. */
const isChange = (error: unknown): boolean => error instanceof FolderChanged || /^Frozen content (changed|was replaced)|^Lifecycle path is a link/.test((error as Error)?.message ?? '') ||
  ['ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')

/**
 * Removes the files and links the copy holds that are still on disk exactly as kept, then the folders in the way that
 * held them once they are empty. A hard-linked file is left to Git: Git removes one name and writes a new file, so the
 * other names keep their bytes. Returns what was removed, or the first path found changed, with what was removed
 * before that (which the caller puts back); a removal that failed for another reason (a folder Mousse may not change)
 * comes back as `error`.
 */
async function clearKept(top: string, kept: KeptCopy, writes: readonly string[]): Promise<Cleared> {
  const proofs: Array<{ path: string; proof: FrozenEntryProof }> = []
  const folders = new Map<string, string>()
  const changed: string[] = []
  const leftToGit: string[] = []
  for (const [path, digest] of kept.digests) {
    const absolute = join(top, path)
    let info
    try { info = await lstat(absolute) } catch (error) { if (gone(error)) continue; throw error }
    if (!info.isFile() && !info.isSymbolicLink()) { changed.push(path); continue }
    if (info.isFile() && info.nlink > 1) { leftToGit.push(path); continue }
    try {
      proofs.push({ path, proof: await proveFrozenContentEntryAsync(top, { path, kind: info.isFile() ? 'file' : 'link', digest, bytes: info.size, mode: info.mode }) })
      await recordFoldersAboveAsync(top, absolute, folders)
    } catch (error) {
      if (!gone(error)) changed.push(path)
    }
  }
  if (changed.length) return { changed, removed: [] }
  // A folder where the target has a file, and the copy holds what was in it. One that still holds a file left to Git
  // is left to Git as a whole.
  const under = (folder: string, paths: Iterable<string>): boolean => [...paths].some((path) => path.startsWith(`${folder}/`))
  const inTheWay = writes.filter((write) => under(write, kept.digests.keys()) && !under(write, leftToGit))
  const depth = (path: string): number => path.split('/').length
  const removed: string[] = []
  let at = ''
  try {
    // From the first check to the last removal nothing is awaited.
    for (const { path, proof } of proofs.sort((a, b) => depth(b.path) - depth(a.path))) {
      at = path
      assertFoldersUnchanged(top, dirname(proof.path), folders)
      try {
        assertFrozenEntryUnchanged(proof)
        unlinkSync(proof.path)
        removed.push(path)
      } catch (error) {
        // Removed meanwhile by something else: its bytes are in the copy, and Git writes the path.
        if (!gone(error)) throw error
      }
    }
    for (const folder of inTheWay.sort((a, b) => depth(b) - depth(a))) {
      at = folder
      removeEmptyFolders(join(top, folder))
    }
  } catch (error) {
    return { changed: [at], removed, ...(isChange(error) ? {} : { error }) }
  }
  return { removed }
}

/** Removes `folder` and the folders in it, deepest first, each only while it is an empty real folder. Throws when one is not. */
function removeEmptyFolders(folder: string): void {
  let info
  try { info = lstatSync(folder) } catch (error) { if (gone(error)) return; throw error }
  if (!info.isDirectory()) throw Object.assign(new Error(`${folder} is not a folder`), { code: 'ENOTEMPTY' })
  for (const name of readdirSync(folder)) removeEmptyFolders(join(folder, name))
  rmdirSync(folder)
}

/** Paths for a sentence: the first few, and how many more. */
function named(paths: readonly string[]): string {
  return paths.slice(0, 5).join(', ') + (paths.length > 5 ? ` and ${paths.length - 5} more` : '')
}

/**
 * Gives up the operation of `kind` in progress at `top`, after keeping what its abort writes over (see the top of this
 * file). Returns the copy, or undefined when no such operation is in progress and Git's abort did not fail. The caller
 * holds the repository's mutation locks. A refusal ({@link KeepCopyRefusedError}) names the files and changed nothing.
 */
export async function abortKeepingCopy(input: AbortKeepingCopyInput): Promise<KeptCopy | undefined> {
  const top = resolve(input.top)
  let changed: string[] = []
  for (let round = 0; round < ABORT_KEEP_ROUNDS; round++) {
    const target = await abortTarget(top, input.kind)
    // Nothing in progress: Git's abort says so.
    if (!target) { await input.abort(); return undefined }
    const writes = await abortWrites(top, input.kind, target)
    const kept = await keepCopy({ owner: input.owner, top, operationType: 'git-abort', action: input.action, paths: writes, writes, target })
    const cleared = await clearKept(top, kept, writes)
    if ('changed' in cleared) {
      // What was removed is put back as it was kept; the copy is kept again with the change.
      await writeBackKeptFiles(top, kept.sha, cleared.removed)
      if (cleared.error) throw cleared.error
      changed = cleared.changed
      continue
    }
    try {
      await input.abort()
    } catch (error) {
      await writeBackKeptFiles(top, kept.sha, cleared.removed)
      throw error
    }
    return kept
  }
  throw new KeepCopyRefusedError(`${input.action} was stopped: ${named(changed)} kept changing while ${changed.length === 1 ? 'its' : 'their'} copy was being kept. Nothing was changed; try again once ${changed.length === 1 ? 'it has' : 'they have'} stopped changing.`, changed)
}
