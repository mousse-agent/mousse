import { randomUUID } from 'node:crypto'
import { access, copyFile, lstat, readFile, rm, stat, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { privateIndexEnv } from '../git/gitEnv'
import { gitAsync, listZSync, MOUSSE_DIRECTORY, NOT_MOUSSE, tryGitAsync } from './git'
import { KeepCopyRefusedError, keptPathsText, listZ, listZOver, pendingWrites, type KeptCopy } from './keptCopies'
import { indexAt, namedFew, OVERWRITE_KEEP_ROUNDS, overwriteKeepingCopy, untrackedInTheWay } from './overwriteKeepingCopy'

/**
 * Abort that never loses an edit: the merge, rebase, cherry-pick or revert Git stopped in is given up only after the
 * files it writes over are kept, and only where plain Git would give it up too.
 *
 * 1. Git's abort goes back to a commit, the abort target: HEAD for a merge or a single cherry-pick or revert, the
 *    commit a rebase started from (`orig-head`), or the commit a run of cherry-picks or reverts started from (the
 *    sequencer's `head`). The paths it writes ({@link abortWrites}), and the paths the autostash it then applies writes
 *    ({@link autostashWrites}), are listed.
 * 2. Where plain Git's abort would refuse and change nothing, this refuses too, naming the files
 *    ({@link refusalOf}): an unstaged change in a file a merge staged, or a file that is not tracked (and not
 *    ignored) where the abort puts a file back. Removing them first would make Git's abort go ahead.
 * Steps 3 to 6 are shared with Publish ({@link overwriteKeepingCopy}); Abort keeps every path, in every repository.
 * 3. Those paths are kept as one copy of the owner's (`keepCopy`, operation `git-abort`): staged and working versions,
 *    conflict stages (`^3`), and whatever stands where Git writes, ignored files included. Its first parent is HEAD as
 *    the abort found it, so commits a rebase made before it stopped stay reachable for the owner's window.
 * 4. Mousse removes what stands at each path Git writes, as far as the copy proves it holds it (`removeProvenAsync`):
 *    each entry is read again and compared with the copy, then removed deepest first, nothing awaited between its last
 *    check and its unlink. At the autostash's paths only ignored files go, which its apply writes over; anything else
 *    there Git leaves, saving the stash, so it stays, proven against the copy. Anything that changed or appeared since the
 *    copy puts back what was removed, and the copy is kept again, up to {@link ABORT_KEEP_ROUNDS} times; then the abort
 *    refuses, naming it.
 * 5. Right before Git starts, synchronously and with nothing awaited until it is started, every path Git writes must
 *    still be empty and every file left in place unchanged, and Git is asked again which paths it writes now (the index
 *    against the target, and for a rebase every changed file): a path the copy does not cover, staged or saved since,
 *    is the same: put back, keep again.
 * 6. Git's abort then writes the target's versions into empty paths. When it fails, every removed file is put back where
 *    nothing stands, so the folder is as it was; where Git wrote first, the error names the copy and the commands that
 *    bring those files back.
 *
 * The limits that remain: a file created at an emptied path after Mousse's last check, while Git starts and before it
 * writes there, is written over by Git (a rebase's abort) or makes Git refuse (the others). And if Mousse stops between
 * removing files and Git's run (the computer turns off), the operation is still in progress with those files missing
 * from the folder; the copy holds them, and nothing announces it.
 */

export type AbortKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

/** How many times a copy is kept again because a kept file changed, or something appeared, before Git ran. */
export const ABORT_KEEP_ROUNDS = OVERWRITE_KEEP_ROUNDS

export interface AbortKeepingCopyInput {
  /** The owner's folder: whose journal records the copy and whose Undo window keeps it. */
  owner: string
  /** The repository's top folder. */
  top: string
  kind: AbortKind
  /** The action, as a refusal names it: `Abort`. */
  action: string
  /**
   * Runs Git's abort (`git <kind> --abort`), throwing when Git fails. `beforeStart` must run synchronously right before
   * Git starts (`runGitProcess`'s option of that name); what it throws is to be thrown as it is, with Git not started.
   */
  abort: (beforeStart: () => void) => Promise<void>
}

/** Git's abort stopped after it wrote: what it wrote over is in the copy, and the message says how to bring it back. */
export class AbortStoppedPartWayError extends Error {
  /** The sentences added to Git's own message. */
  readonly detail: string
  constructor(readonly gitError: unknown, readonly kept: KeptCopy, readonly paths: readonly string[]) {
    const detail = `Git's abort stopped part way, after it wrote over ${paths.length === 1 ? paths[0] : `${paths.length} files`}. ${keptPathsText(kept, paths)}`
    super(`${(gitError instanceof Error ? gitError.message : String(gitError)).trim()} ${detail}`, { cause: gitError })
    this.name = 'AbortStoppedPartWayError'
    this.detail = detail
  }
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
const absolute = (top: string, rel: string): string => join(top, ...rel.split('/'))

async function gitPath(top: string, name: string): Promise<string> {
  return resolve(top, await gitAsync(top, ['rev-parse', '--git-path', name]))
}

async function commitOf(top: string, revision: string): Promise<string | undefined> {
  const found = await tryGitAsync(top, ['rev-parse', '--verify', '-q', `${revision}^{commit}`])
  return found.ok && found.stdout ? found.stdout : undefined
}

/** The first line of a file in the Git folder, or '' when there is none. */
async function gitFile(top: string, name: string): Promise<string> {
  return (await readFile(await gitPath(top, name), 'utf8').catch(() => '')).trim()
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
      const start = await gitFile(top, `${folder}/orig-head`)
      const commit = start ? await commitOf(top, start) : undefined
      if (!commit) throw unknown('rebase')
      return commit
    }
    return undefined
  }
  // A run of picks keeps where it started in the sequencer's folder; a single pick goes back to HEAD.
  if (await exists(await gitPath(top, 'sequencer/head'))) {
    const start = await gitFile(top, 'sequencer/head')
    const commit = start ? await commitOf(top, start) : undefined
    if (!commit) throw unknown(kind)
    return commit
  }
  return await exists(await gitPath(top, kind === 'revert' ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD')) ? commitOf(top, 'HEAD') : undefined
}

/** Whether Git's abort goes back to the target at all: a run of picks after which HEAD moved is only ended ("Not rewinding"). */
async function rewinds(top: string, kind: AbortKind): Promise<boolean> {
  if (kind !== 'cherry-pick' && kind !== 'revert') return true
  const safety = await gitFile(top, 'sequencer/abort-safety')
  return !(safety && await exists(await gitPath(top, 'sequencer/head')) && safety !== await commitOf(top, 'HEAD'))
}

/**
 * Every path Git's abort writes `target`'s version at, or removes. `.mousse/` is left out, as everywhere a copy is kept.
 * - A rebase's abort is `reset --hard <target>`: every path whose staged or working version differs from the target,
 *   conflicted paths, paths Git assumes unchanged, and the paths HEAD and the target differ at
 *   (`git diff --name-only HEAD <target>`). Untracked files elsewhere stay, as Git leaves them.
 * - The others are `reset --merge <target>`: only paths whose staged version differs from the target, and conflicted
 *   paths. A path whose index already equals the target is left alone by Git, its working version included, so it is
 *   not in the set: removing it would lose it from the folder.
 * - A run of picks after which HEAD moved (a commit made at the stop) is not rewound at all: Git only ends it.
 */
export async function abortWrites(top: string, kind: AbortKind, target: string): Promise<string[]> {
  if (!await rewinds(top, kind)) return []
  const unmerged = (await listZ(top, ['ls-files', '-z', '--unmerged', '--', '.', NOT_MOUSSE])).map((line) => line.slice(line.indexOf('\t') + 1))
  if (kind === 'rebase') {
    const moved = await listZ(top, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', 'HEAD', target, '--', '.', NOT_MOUSSE])
    return [...new Set([...await pendingWrites(top, target, { untracked: [] }), ...moved, ...unmerged])]
  }
  const staged = await listZ(top, ['diff-index', '-z', '--cached', '--name-only', '--no-renames', target, '--', '.', NOT_MOUSSE])
  return [...new Set([...staged, ...unmerged])]
}

/**
 * The paths the autostash of a merge or rebase writes when the abort applies it again (`MERGE_AUTOSTASH`,
 * `rebase-merge/autostash`, `rebase-apply/autostash`): what its stash commit changed against its base, in the working
 * tree and in the index, and its untracked files.
 */
export async function autostashWrites(top: string, kind: AbortKind): Promise<string[]> {
  const names = kind === 'merge' ? ['MERGE_AUTOSTASH'] : kind === 'rebase' ? ['rebase-merge/autostash', 'rebase-apply/autostash'] : []
  let stash: string | undefined
  for (const name of names) {
    const named = await gitFile(top, name)
    if (named && (stash = await commitOf(top, named))) break
  }
  if (!stash) return []
  const [base, index, untracked] = (await gitAsync(top, ['rev-list', '--parents', '-n', '1', stash])).split(' ').slice(1)
  if (!base) return []
  const changed = (from: string, to: string): Promise<string[]> => listZ(top, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, to, '--', '.', NOT_MOUSSE])
  const lists = await Promise.all([
    changed(base, stash),
    index ? changed(base, index) : [],
    // `ls-tree` takes no pathspec magic, so `.mousse/` is left out here.
    untracked ? listZ(top, ['ls-tree', '-r', '-z', '--name-only', untracked]).then((paths) => paths.filter((path) => path !== MOUSSE_DIRECTORY && !path.startsWith(`${MOUSSE_DIRECTORY}/`))) : []
  ])
  return [...new Set(lists.flat())]
}

/**
 * Of `paths` (stage-0 entries), those whose file on disk differs from its index entry, as Git's `reset --merge` finds
 * them "not uptodate": read from a private copy of the index refreshed first, so a file touched but not changed is not
 * counted. A file that is gone is not counted either; Git writes it back. An entry Git is told not to look at
 * (`flagged`) is compared all the same, as Git's abort does.
 */
async function unstagedChanges(top: string, paths: readonly string[], flagged: ReadonlySet<string>): Promise<string[]> {
  if (!paths.length) return []
  const gitDir = await gitAsync(top, ['rev-parse', '--absolute-git-dir'])
  const real = resolve(top, await gitAsync(top, ['rev-parse', '--git-path', 'index']))
  // Named as Mousse's own private index (`gitPolicy`'s owned index rule).
  const copy = join(gitDir, `mousse-keep-${randomUUID()}.index`)
  try {
    await copyFile(real, copy)
    const times = await stat(real)
    await utimes(copy, times.atime, times.mtime)
    const env = privateIndexEnv(copy)
    // Git's abort looks at a file it rewrites whatever flag its entry carries, so this copy of the index drops them.
    const cleared = paths.filter((path) => flagged.has(path))
    // One flag per run: given both, `update-index --stdin` clears neither.
    for (const flag of ['--no-assume-unchanged', '--no-skip-worktree']) if (cleared.length) await gitAsync(top, ['update-index', '-z', flag, '--stdin'], env, `${cleared.join('\0')}\0`)
    // Exit status 1 only says some entries changed or are conflicted; the listing below says which.
    await tryGitAsync(top, ['update-index', '-q', '--unmerged', '--refresh'], env)
    const listed = await listZOver(top, ['diff-files', '-z', '--name-only'], paths, env)
    const present = await Promise.all(listed.map((path) => lstat(absolute(top, path)).then(() => true, () => false)))
    return listed.filter((_, index) => present[index])
  } finally {
    await rm(copy, { force: true })
  }
}

/**
 * Why plain Git's abort of `kind` would refuse and change nothing, with the files, or undefined when it would go ahead.
 * Mousse removes the files Git writes over before Git runs, so without this check Git's own refusals would never happen:
 * - `reset --merge` (all but a rebase) refuses a path it rewrites whose file has changes not staged ("not uptodate"), and
 *   so does a rebase's `reset --hard` where the entry is flagged assume-unchanged or skip-worktree;
 * - every abort refuses to write over a file that is not tracked and not ignored, or a folder holding one, where the
 *   target has a file and the index has none, and a file or link of that kind standing where the target has a folder.
 */
export async function refusalOf(top: string, kind: AbortKind, target: string, writes: readonly string[]): Promise<{ message: string; paths: string[] } | undefined> {
  if (!writes.length) return undefined
  const index = await indexAt(top, writes)
  // `reset --merge` checks every stage-0 path it rewrites; `reset --hard` (a rebase) only a flagged entry it changes.
  const changes = kind === 'rebase' && index.flagged.size ? new Set(await listZ(top, ['diff-index', '-z', '--cached', '--name-only', '--no-renames', target, '--', '.', NOT_MOUSSE])) : undefined
  const checked = writes.filter((path) => index.modes.has(path) && !index.unmerged.has(path) && index.modes.get(path) !== '160000' && (!changes || (index.flagged.has(path) && changes.has(path))) && (kind !== 'rebase' || index.flagged.has(path)))
  {
    const dirty = await unstagedChanges(top, checked, index.flagged)
    if (dirty.length) {
      const one = dirty.length === 1
      return { paths: dirty, message: `Abort was stopped: ${namedFew(dirty)} ${one ? 'has' : 'have'} changes that are not staged, and Git's abort refuses to write over them ("not uptodate"). Nothing was changed. Stage those changes or move them aside, then try again.` }
    }
  }
  const untracked = await untrackedInTheWay(top, target, writes, index.modes)
  if (!untracked.length) return undefined
  const one = untracked.length === 1
  return { paths: untracked, message: `Abort was stopped: ${namedFew(untracked)} ${one ? 'is' : 'are'} not tracked and ${one ? 'stands' : 'stand'} where the abort puts a file back, and Git's abort refuses to write over ${one ? 'it' : 'them'}. Nothing was changed. Move ${one ? 'it' : 'them'} aside, then try again.` }
}

/**
 * Gives up the operation of `kind` in progress at `top`, after keeping what its abort writes over (see the top of this
 * file). Returns the copy, or undefined when no such operation is in progress and Git's abort did not fail. The caller
 * holds the repository's mutation locks. A refusal ({@link KeepCopyRefusedError}) names the files and changed nothing;
 * Git failing after it wrote is {@link AbortStoppedPartWayError}.
 */
export async function abortKeepingCopy(input: AbortKeepingCopyInput): Promise<KeptCopy | undefined> {
  const top = resolve(input.top)
  const done = await overwriteKeepingCopy({
    owner: input.owner, top, operationType: 'git-abort', action: input.action,
    round: async () => {
      const target = await abortTarget(top, input.kind)
      // Nothing in progress: Git's abort says so.
      if (!target) return undefined
      const writes = await abortWrites(top, input.kind, target)
      const refusal = await refusalOf(top, input.kind, target, writes)
      if (refusal) throw new KeepCopyRefusedError(refusal.message, refusal.paths)
      const rewound = await rewinds(top, input.kind)
      return {
        target, writes, alongside: await autostashWrites(top, input.kind),
        // What Git writes now, read again: a path staged since the copy, or (a rebase's `reset --hard` writes every changed
        // file) a file changed since, that the copy does not cover, is kept again first.
        grown: (listed) => {
          if (!rewound) return undefined
          const quiet = { GIT_OPTIONAL_LOCKS: '0' }
          const now = [
            ...listZSync(top, ['diff-index', '-z', '--cached', '--name-only', '--no-renames', target, '--', '.', NOT_MOUSSE], quiet),
            ...(input.kind === 'rebase' ? listZSync(top, ['diff-files', '-z', '--name-only', '--', '.', NOT_MOUSSE], quiet) : [])
          ]
          return now.find((path) => !listed.has(path))
        }
      }
    },
    run: input.abort,
    stoppedPartWay: (error, kept, paths) => new AbortStoppedPartWayError(error, kept, paths)
  })
  return done?.kept
}
