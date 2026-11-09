import { type AppError, knownAppError } from '../../shared/errors'
import type { PendingChangesDetails } from '../../shared/workspace'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { filterRefusal, repoProgramEnv, withoutRepoPrograms, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { IN_PROGRESS_GIT_MARKERS } from '../git/gitMarkers'
import { MOUSSE_COMMIT_EMAIL, MOUSSE_COMMIT_NAME } from '../git/mousseCommitIdentity'
import { readWorkingTreeStatus, readWorkingTreeStatusSync, type StatusEntry } from '../git/workingTreeStatus'
import { rethrowGitPolicyError } from '../git/gitPolicy'
import { activeHiddenStore, checkStoreCommand, checkStoreCommandAsync, hiddenStoreEnv } from '../git/hiddenStore'
import type { GitCheckOptions, RepoProgramOptions } from '../git/repoPrograms'
import { waitForFolderAccess } from '../files/folderAccess'
import { LISTING_MAX_BUFFER, runGitProcess } from '../git/runGitProcess'
import { files, runAsync, step, type Steps } from './steps'
import { discardProvenAsync, stagedEntryDigests, stagedModes, stagedSince, waitForIndexAsync, type DiscardGit, type LeftAsItIs } from './provenDiscard'

/**
 * `args` as Mousse's own commands run them: no repository program, and, for a folder whose snapshots live in a hidden
 * store (see `inHiddenStore`), through that store instead of a repository of the folder's own.
 */
export function guarded(cwd: string, args: string[], options?: RepoProgramOptions & GitCheckOptions): string[] {
  const store = activeHiddenStore(cwd)
  if (!store) return withoutRepoPrograms(cwd, args, options)
  // A store command reads no config but the store's own (`gitEnv` names the store and isolates it), so no program can be
  // configured for it to run. It is never given the folder's own `--git-dir`, which after `git init` is the person's.
  // The central Git check sees it as it runs: lock-free, the store as `GIT_DIR`, its folder as `GIT_WORK_TREE`.
  const run = ['--no-optional-locks', ...args]
  checkStoreCommand(store, cwd, run, { env: options?.env, stdin: options?.stdin, userRequested: options?.userRequested })
  return run
}

/**
 * {@link guarded} without blocking the daemon: it waits until the folder's volume answers, then runs the same central
 * Git check and the same reading of the repository's programs without blocking (`withoutRepoProgramsAsync`).
 */
export async function guardedAsync(cwd: string, args: string[], options?: RepoProgramOptions & GitCheckOptions): Promise<string[]> {
  await waitForFolderAccess([resolve(cwd)])
  const store = activeHiddenStore(cwd)
  if (!store) return withoutRepoProgramsAsync(cwd, args, options)
  const run = ['--no-optional-locks', ...args]
  await checkStoreCommandAsync(store, cwd, run, { env: options?.env, stdin: options?.stdin, userRequested: options?.userRequested })
  return run
}

/**
 * The environment for one of Mousse's Git commands in `cwd`: the process's with `env` on top, and, in a hidden store's
 * scope, isolated from the person's system and global config and attributes so the store keeps exact bytes.
 */
export function gitEnv(cwd: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = repoProgramEnv(env ? { ...process.env, ...env } : process.env)
  const store = activeHiddenStore(cwd)
  return store ? hiddenStoreEnv(store, base) : base
}

export { runGitProcess }

/** The output limit `spawnSync` and `execFileSync` use when none is given. */
const DEFAULT_MAX_BUFFER = 1024 * 1024

export interface GitReadOptions {
  /** Bytes of output Git may print before the run is stopped and fails; 1 MiB when not given (or 256 MiB with input). */
  maxBuffer?: number
  /** Runs synchronously right before Git starts; what it throws is thrown instead, and Git never starts. */
  beforeStart?: () => void
}

/** For a read whose output grows with the repository (see `LISTING_MAX_BUFFER`). */
export const LISTING: GitReadOptions = { maxBuffer: LISTING_MAX_BUFFER }

/**
 * Git for Mousse's own actions (checkpoints, restore, undo, revert): no program the repository
 * configures runs. Files under a filter only the repository defines (git-crypt) are refused, with a
 * message saying why, rather than stored unfiltered. Code that can wait uses {@link gitAsync}.
 */
export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string, options?: GitReadOptions): string {
  try {
    return execFileSync('git', guarded(cwd, args, { ...(env ? { env } : {}), ...(input !== undefined ? { stdin: input } : {}) }), {
      cwd,
      env: gitEnv(cwd, env),
      encoding: 'utf8',
      maxBuffer: options?.maxBuffer ?? (input !== undefined ? LISTING_MAX_BUFFER : DEFAULT_MAX_BUFFER),
      ...(input !== undefined ? { input } : {}),
      stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
    }).trim()
  } catch (error) {
    const refusal = filterRefusal(String((error as { stderr?: unknown }).stderr ?? ''))
    if (refusal) throw new Error(refusal, { cause: error })
    throw error
  }
}

/** {@link git} without blocking the daemon: the same check, command and answer, and an error carrying Git's `stderr` and `status`. */
export async function gitAsync(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string, options?: GitReadOptions): Promise<string> {
  const argv = await guardedAsync(cwd, args, { ...(env ? { env } : {}), ...(input !== undefined ? { stdin: input } : {}) })
  const ran = await runGitProcess(argv, { cwd, env: gitEnv(cwd, env), input, maxBuffer: options?.maxBuffer ?? (input !== undefined ? LISTING_MAX_BUFFER : DEFAULT_MAX_BUFFER) })
  if (!ran.error && ran.status === 0) return ran.stdout.trim()
  const error = Object.assign(new Error(`Command failed: git ${argv.join(' ')}${ran.stderr ? `\n${ran.stderr}` : ''}`, ran.error ? { cause: ran.error } : undefined), { status: ran.status, stdout: ran.stdout, stderr: ran.stderr })
  const refusal = filterRefusal(ran.stderr)
  if (refusal) throw new Error(refusal, { cause: error })
  throw error
}

/**
 * The NUL-separated fields of a `-z` listing, exactly as Git wrote them, run synchronously: for a check that must happen
 * with nothing awaited before what it guards (Abort's last check right before Git starts). Throws when Git fails.
 */
export function listZSync(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string[] {
  const result = spawnSync('git', guarded(cwd, args, { ...(env ? { env } : {}) }), { cwd, encoding: 'utf8', env: gitEnv(cwd, env), maxBuffer: LISTING_MAX_BUFFER })
  if (result.error || result.status !== 0) throw new Error(`Command failed: git ${args.join(' ')}${result.stderr ? `\n${result.stderr.trim()}` : ''}`)
  return result.stdout.split('\0').filter(Boolean)
}

export function tryGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv, options?: GitReadOptions): { ok: boolean; stdout: string; stderr: string } {
  let safe: string[]
  try {
    safe = guarded(cwd, args, { env })
  } catch (error) {
    // A refusal by the central Git check is its own error, never an ordinary failed run.
    rethrowGitPolicyError(error)
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
  const result = spawnSync('git', safe, { cwd, encoding: 'utf8', env: gitEnv(cwd, env), maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER })
  const stderr = result.stderr.trim()
  // Output cut off at the limit is a failure, even when Git exited 0 before it was stopped (`spawnSync` reports both).
  const ok = !result.error && result.status === 0
  return { ok, stdout: result.stdout.trim(), stderr: (!ok && filterRefusal(stderr)) || stderr }
}

/** {@link tryGit} without blocking the daemon. */
export async function tryGitAsync(cwd: string, args: string[], env?: NodeJS.ProcessEnv, options?: GitReadOptions): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  let safe: string[]
  try {
    safe = await guardedAsync(cwd, args, { env })
  } catch (error) {
    rethrowGitPolicyError(error)
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
  const result = await runGitProcess(safe, { cwd, env: gitEnv(cwd, env), maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER, ...(options?.beforeStart ? { beforeStart: options.beforeStart } : {}) })
  const stderr = result.stderr.trim()
  // As in `tryGit`: output cut off at the limit is a failure.
  const ok = !result.error && result.status === 0
  return { ok, stdout: result.stdout.trim(), stderr: (!ok && filterRefusal(stderr)) || stderr }
}

/**
 * {@link tryGitAsync} with Git's output exactly as written, not trimmed, and the exit status, for `-z` listings whose
 * names may begin or end with blanks. `input` goes to Git's standard input. Output cut off at the limit is a failure;
 * a listing passes {@link LISTING}.
 */
export async function tryGitRawAsync(cwd: string, args: string[], input?: string, options?: GitReadOptions): Promise<{ ok: boolean; status: number | null; stdout: string; stderr: string }> {
  let safe: string[]
  try {
    safe = await guardedAsync(cwd, args, input !== undefined ? { stdin: input } : undefined)
  } catch (error) {
    rethrowGitPolicyError(error)
    return { ok: false, status: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
  const result = await runGitProcess(safe, { cwd, env: gitEnv(cwd), ...(input !== undefined ? { input } : {}), maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER })
  const ok = !result.error && result.status === 0
  return { ok, status: result.error ? null : result.status, stdout: result.stdout, stderr: (!ok && filterRefusal(result.stderr.trim())) || result.stderr }
}

/** {@link git} as a step: see `steps.ts`. */
export function gitStep(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string, options?: GitReadOptions): Steps<string> {
  return step(() => git(cwd, args, env, input, options), () => gitAsync(cwd, args, env, input, options))
}

/** {@link tryGit} as a step. */
export function tryGitStep(cwd: string, args: string[], env?: NodeJS.ProcessEnv, options?: GitReadOptions): Steps<{ ok: boolean; stdout: string; stderr: string }> {
  return step(() => tryGit(cwd, args, env, options), () => tryGitAsync(cwd, args, env, options))
}

/**
 * Mousse's own Git in `top` as the proven write steps run it (`provenDiscard.ts`): the central check, no repository
 * programs, the exit status, the output exactly as written, and Git's messages.
 */
export function ownGitRunner(top: string): DiscardGit {
  return async (args, options = {}) => {
    const argv = await guardedAsync(top, args, { ...(options.env ? { env: options.env } : {}), ...(options.input !== undefined ? { stdin: options.input } : {}) })
    const ran = await runGitProcess(argv, { cwd: top, env: gitEnv(top, options.env), ...(options.input !== undefined ? { input: options.input } : {}), maxBuffer: LISTING_MAX_BUFFER })
    return { status: ran.error ? null : ran.status, stdout: ran.stdout, stderr: (filterRefusal(ran.stderr.trim()) || ran.stderr) }
  }
}

/** How many changed files a message names before it says "and N more". */
const NAMED_FILES = 5
const CONFLICT_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
const isConflict = (entry: StatusEntry): boolean => CONFLICT_PAIRS.has(`${entry.index || ' '}${entry.workdir || ' '}`)
const OPERATION_OF: Record<(typeof IN_PROGRESS_GIT_MARKERS)[number], PendingChanges['operation']> = {
  MERGE_HEAD: 'merge', REVERT_HEAD: 'revert', CHERRY_PICK_HEAD: 'cherry-pick', 'rebase-merge': 'rebase', 'rebase-apply': 'rebase'
}
/** Mousse's own files in a checkout; never part of the user's pending changes. */
export const MOUSSE_DIRECTORY = '.mousse'
export const NOT_MOUSSE = `:(exclude)${MOUSSE_DIRECTORY}`

export interface PendingChanges {
  /** The repository's top level, which every path below is relative to. */
  top: string
  /** Every changed, added, deleted or untracked (not ignored) path, conflicted ones first. */
  files: string[]
  /** Paths with an unresolved conflict. */
  unmerged: string[]
  /** A merge, revert, cherry-pick or rebase that waits for the user. */
  operation?: 'merge' | 'revert' | 'cherry-pick' | 'rebase'
}

/** What is pending in a checkout, read from the top of the repository. */
export function* inspectPendingChangesSteps(cwd: string): Steps<PendingChanges> {
  // A hidden store has no index of the person's, no merge and no rebase: nothing in it waits for them.
  const store = activeHiddenStore(cwd)
  if (store) return { top: store.workTree, files: [], unmerged: [] }
  const top = yield* gitStep(cwd, ['rev-parse', '--show-toplevel'])
  // Plumbing, not `git status`: a check never refreshes and rewrites the index of the checkout it looks at.
  const files: string[] = []
  const unmerged: string[] = []
  for (const entry of yield* step(() => readWorkingTreeStatusSync(top), () => readWorkingTreeStatus(top))) {
    if (isConflict(entry)) unmerged.push(entry.path)
    else files.push(entry.path)
  }
  const operation = yield* operationInProgressSteps(top)
  return { top, files: [...unmerged, ...files], unmerged, ...(operation ? { operation } : {}) }
}


export function inspectPendingChangesAsync(cwd: string): Promise<PendingChanges> {
  return runAsync(inspectPendingChangesSteps(cwd))
}

/** The merge, revert, cherry-pick or rebase that waits for the user in a checkout, if any. */
export function* operationInProgressSteps(cwd: string): Steps<PendingChanges['operation']> {
  if (activeHiddenStore(cwd)) return undefined
  for (const marker of IN_PROGRESS_GIT_MARKERS) {
    const resolved = yield* tryGitStep(cwd, ['rev-parse', '--git-path', marker])
    if (resolved.ok && (yield* files.exists(resolve(cwd, resolved.stdout)))) return OPERATION_OF[marker]
  }
  return undefined
}


export function operationInProgressAsync(cwd: string): Promise<PendingChanges['operation']> {
  return runAsync(operationInProgressSteps(cwd))
}

/** Pending paths Mousse sets aside: not `.mousse/`, and not a nested repository (listed as `dir/`), which stays in place. */
function ownPaths(files: string[]): string[] {
  return files.filter((path) => !path.endsWith('/') && path !== MOUSSE_DIRECTORY && !path.startsWith(`${MOUSSE_DIRECTORY}/`))
}

function listFiles(files: string[]): string {
  const named = files.slice(0, NAMED_FILES).join(', ')
  return files.length > NAMED_FILES ? `${named} and ${files.length - NAMED_FILES} more` : named
}

export interface PendingChangesOptions {
  /** The error offers Discard (thread worktrees only; never during a rebase). */
  discard?: boolean
}

/**
 * The refusal for a checkout Mousse can't work in by itself: an unresolved conflict or a merge, revert,
 * cherry-pick or rebase in progress (`workspace_conflict`), or, for checks after Mousse's own steps, plain
 * uncommitted changes (`workspace_not_clean`). It names the folder and the first few files of what is pending.
 */
export function pendingChangesErrorFor(label: string, options: PendingChangesOptions, pending: PendingChanges): AppError {
  const conflict = pending.unmerged.length > 0 || pending.operation !== undefined
  const discard = conflict && options.discard === true && pending.operation !== 'rebase'
  const details: PendingChangesDetails = {
    label, path: pending.top, files: pending.files.slice(0, NAMED_FILES), count: pending.files.length, conflict, discard,
    ...(pending.operation ? { operation: pending.operation } : {})
  }
  const what = pending.operation ? `a ${pending.operation} in progress` : 'an unresolved conflict'
  const where = pending.unmerged.length ? `${pending.operation ? ' with conflicts' : ''} in ${listFiles(pending.unmerged)}` : ''
  const next = discard ? 'Resolve it or discard the changes, then try again.' : 'Finish or abort it in a terminal, then try again.'
  const message = conflict
    ? `${label} ${pending.top} has ${what}${where}. ${next}`
    : `${label} ${pending.top} has uncommitted changes: ${listFiles(pending.files)}.`
  return knownAppError({ code: conflict ? 'workspace_conflict' : 'workspace_not_clean', message, details }, { category: 'conflict', retryable: false })
}

/** For checks after Mousse's own steps (an aborted merge, a worker's result): any change is refused. */
export function* requireCleanSteps(cwd: string, label: string): Steps<void> {
  if (activeHiddenStore(cwd)) return
  const status = yield* gitStep(cwd, ['status', '--porcelain=v2', '--untracked-files=all'], undefined, undefined, LISTING)
  if (status) throw pendingChangesErrorFor(label, {}, yield* inspectPendingChangesSteps(cwd))
}


export function requireCleanAsync(cwd: string, label: string): Promise<void> {
  return runAsync(requireCleanSteps(cwd, label))
}

/** Refuses only what Mousse can't safely set aside or save: an unresolved conflict or a Git operation in progress. */
export function* refuseUnsafeChangesSteps(cwd: string, label: string, options: PendingChangesOptions = {}): Steps<PendingChanges> {
  const pending = yield* inspectPendingChangesSteps(cwd)
  if (pending.unmerged.length || pending.operation) throw pendingChangesErrorFor(label, options, pending)
  return pending
}


export function refuseUnsafeChangesAsync(cwd: string, label: string, options: PendingChangesOptions = {}): Promise<PendingChanges> {
  return runAsync(refuseUnsafeChangesSteps(cwd, label, options))
}

export function* treeOfSteps(top: string, revision: string): Steps<string> {
  return yield* gitStep(top, ['rev-parse', `${revision}^{tree}`])
}


export function treeOfAsync(top: string, revision: string): Promise<string> {
  return runAsync(treeOfSteps(top, revision))
}

/** Three-way merge of `theirs` onto `ours` from `base`, without touching the checkout. */
export function* mergeTreesSteps(top: string, base: string, ours: string, theirs: string): Steps<{ tree: string } | { conflicts: string[] }> {
  const result = yield* tryGitStep(top, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${base}`, ours, theirs], undefined, LISTING)
  const [tree, ...files] = result.stdout.split(/\r?\n/)
  if (result.ok && tree) return { tree }
  // Exit 1 lists the conflicted files after the tree; anything else (an old Git without `--merge-base`) is a conflict too.
  return { conflicts: /^[0-9a-f]{40,64}$/.test(tree ?? '') ? files.filter(Boolean) : [] }
}


export function mergeTreesAsync(top: string, base: string, ours: string, theirs: string): Promise<{ tree: string } | { conflicts: string[] }> {
  return runAsync(mergeTreesSteps(top, base, ours, theirs))
}

/** What {@link discardPendingChangesAsync} asks its `keep` to keep a copy of: `keepCopy`'s `paths` and `writes`. */
export interface DiscardScope {
  /** Every path the discard removes or writes HEAD's version back at. */
  paths: string[]
  /** The paths HEAD's version is written back at; what stands in their way is kept too. */
  writes: string[]
}

/** The NUL-separated fields of a Git listing, exactly as named (a leading space is part of a path). */
async function listZAsync(top: string, args: string[]): Promise<string[]> {
  const ran = await tryGitRawAsync(top, args, undefined, LISTING)
  if (!ran.ok) throw new Error(`Command failed: git ${args.join(' ')}\n${ran.stderr.trim()}`)
  return ran.stdout.split('\0').filter(Boolean)
}

/** The mode HEAD has at each of `paths` it has, asked a few thousand characters of literal paths at a time. */
async function headModesAsync(top: string, paths: readonly string[]): Promise<Map<string, string>> {
  const modes = new Map<string, string>()
  for (let start = 0; start < paths.length;) {
    const batch: string[] = []
    for (let length = 0; start < paths.length && (!batch.length || length + paths[start]!.length < 16_000); start++) {
      batch.push(`:(literal)${paths[start]!}`)
      length += paths[start]!.length + 11
    }
    for (const line of await listZAsync(top, ['ls-tree', '-z', 'HEAD', '--', ...batch])) modes.set(line.slice(line.indexOf('\t') + 1), line.slice(0, line.indexOf(' ')))
  }
  return modes
}

/**
 * Drops pending changes, untracked files and an unfinished merge, revert or cherry-pick, after `keep` has kept a copy
 * of them (`keepCopy` over `scope`: staged, working and conflict versions, and what stands where a file goes back,
 * ignored files included). Other ignored files, nested repositories and `.mousse/` stay. A rebase is refused. The
 * caller holds the mutation locks and has the user's confirmation.
 *
 * Mousse removes only what the copy proves it holds, and Git only creates (`discardProvenAsync`). A path where
 * something changed after the copy was read, that was staged anew, or that was saved again after it was emptied, is not
 * discarded, keeps its staged version (conflict stages included) and is named in `left`; then the unfinished operation
 * stays too. Only once every path was written back does the whole index go back to HEAD (`git reset`, which leaves the
 * files alone), ending the operation. Another Git command holding the index refuses it first (`IndexLockedError`).
 * `beforeUnlink` is a test seam: it runs right before each removed entry's last check.
 */
export async function discardPendingChangesAsync<T extends { digests: ReadonlyMap<string, string> }>(
  cwd: string,
  keep: (top: string, scope: DiscardScope) => Promise<T>,
  options: { beforeUnlink?: (path: string) => void } = {}
): Promise<T & { left: LeftAsItIs[] }> {
  const pending = await runAsync(inspectPendingChangesSteps(cwd))
  if (pending.operation === 'rebase') throw pendingChangesErrorFor('Workspace', {}, pending)
  const top = pending.top
  const head = (await tryGitAsync(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).stdout || undefined
  const [indexBefore, others, staged, working, unmerged, flagged] = await Promise.all([
    listZAsync(top, ['ls-files', '-s', '-z']),
    listZAsync(top, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.', NOT_MOUSSE]),
    head ? listZAsync(top, ['diff-index', '-z', '--cached', '--name-only', '--no-renames', head, '--', '.', NOT_MOUSSE]) : Promise.resolve([]),
    head ? listZAsync(top, ['diff-index', '-z', '--name-only', '--no-renames', head, '--', '.', NOT_MOUSSE]) : Promise.resolve([]),
    listZAsync(top, ['ls-files', '-z', '--unmerged', '--', '.', NOT_MOUSSE]),
    listZAsync(top, ['ls-files', '-z', '-v', '--', '.', NOT_MOUSSE])
  ])
  // A repository of its own inside is listed as `name/`; like `git clean -d`, it stays.
  const untracked = others.filter((path) => !path.endsWith('/'))
  // Without a commit every staged path goes; otherwise what differs from HEAD, conflicts, and the paths Git is told to
  // assume unchanged (their edits are overwritten too, though Git does not list them).
  const tracked = [...new Set(head
    ? [...staged, ...working, ...unmerged.map((line) => line.slice(line.indexOf('\t') + 1)), ...flagged.filter((line) => /^[a-z] /.test(line)).map((line) => line.slice(2))]
    : stagedModes(indexBefore).keys())].filter((path) => path !== '.mousse' && !path.startsWith('.mousse/'))
  const headModes = head ? await headModesAsync(top, tracked) : new Map<string, string>()
  const indexModes = stagedModes(indexBefore)
  // A submodule changes in the index only: its folder is never walked, removed or written. One staged where HEAD has a
  // file is in the way of that file, and the copy refuses it.
  const submodule = (path: string): boolean => headModes.has(path) ? headModes.get(path) === '160000' : indexModes.get(path) === '160000'
  const restore = tracked.filter((path) => headModes.has(path) && !submodule(path))
  const remove = [...tracked.filter((path) => !headModes.has(path) && !submodule(path)), ...untracked]
  const run = ownGitRunner(top)
  // Another Git command holding the index refuses the discard before anything is kept or removed.
  await waitForIndexAsync(top, run)
  const kept = await keep(top, { paths: [...tracked, ...untracked], writes: restore })
  const { left, endedOperation, stagedElsewhere, indexWritten } = await discardProvenAsync({
    top,
    ...(head ? { head } : {}),
    restore,
    remove: tracked.filter((path) => !headModes.has(path) && !submodule(path)),
    untracked,
    indexOnly: tracked.filter(submodule),
    stagedBefore: stagedEntryDigests(indexBefore),
    digests: kept.digests,
    discardGit: run,
    // Folders `git clean -d` would remove once empty: untracked ones, listed as `name/`.
    wholeTree: { untrackedFolders: (await listZAsync(top, ['ls-files', '-z', '--others', '--directory', '--exclude-standard', '--', '.', NOT_MOUSSE])).filter((path) => path.endsWith('/')) },
    ...(options.beforeUnlink ? { beforeUnlink: options.beforeUnlink } : {})
  })
  if (endedOperation) {
    // The whole index went back to HEAD with the rest, which ended the merge, revert or cherry-pick. What is still
    // pending is refused, except an entry someone staged after the index was written: that is their newer work.
    const after = await runAsync(inspectPendingChangesSteps(top))
    const now = stagedEntryDigests(await listZAsync(top, ['ls-files', '-s', '-z']))
    const stagedSinceWrite = new Set(indexWritten ? stagedSince(indexWritten, now, [...new Set([...indexWritten.keys(), ...now.keys()])]) : [])
    if (ownPaths(after.files).some((path) => !stagedSinceWrite.has(path)) || after.operation) throw pendingChangesErrorFor('Workspace', {}, after)
  } else if (!left.length && pending.operation) {
    // Everything was discarded, but something else was staged meanwhile: the index stays, and so does the operation.
    for (const path of stagedElsewhere) left.push({ path, reason: 'operation', changed: path })
  }
  return { ...kept, left }
}

export function* commitParentsSteps(cwd: string, sha: string): Steps<string[]> {
  const line = yield* gitStep(cwd, ['rev-list', '--parents', '-n', '1', sha])
  return line.split(/\s+/).slice(1)
}


export function commitParentsAsync(cwd: string, sha: string): Promise<string[]> {
  return runAsync(commitParentsSteps(cwd, sha))
}

export function* changedPathsSteps(cwd: string, start: string, end: string): Steps<Array<{ path: string; beforeHash?: string; afterHash?: string }>> {
  if (start === end) return []
  const paths = (yield* gitStep(cwd, ['diff', '--name-only', `${start}..${end}`], undefined, undefined, LISTING)).split(/\r?\n/).filter(Boolean)
  const blob = function* (revision: string, path: string): Steps<string | undefined> {
    const result = yield* tryGitStep(cwd, ['rev-parse', `${revision}:${path}`])
    return result.ok ? result.stdout : undefined
  }
  const changed: Array<{ path: string; beforeHash?: string; afterHash?: string }> = []
  for (const path of paths) changed.push({ path, beforeHash: yield* blob(start, path), afterHash: yield* blob(end, path) })
  return changed
}


export function changedPathsAsync(cwd: string, start: string, end: string): Promise<Array<{ path: string; beforeHash?: string; afterHash?: string }>> {
  return runAsync(changedPathsSteps(cwd, start, end))
}

export { MOUSSE_COMMIT_EMAIL }

export const MOUSSE_COMMIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: MOUSSE_COMMIT_NAME,
  GIT_AUTHOR_EMAIL: MOUSSE_COMMIT_EMAIL,
  GIT_COMMITTER_NAME: MOUSSE_COMMIT_NAME,
  GIT_COMMITTER_EMAIL: MOUSSE_COMMIT_EMAIL
}

/**
 * `MOUSSE_COMMIT_ENV` with the commit times set to Mousse's clock now, for a commit whose time a retention rule reads
 * (files a restore kept): a `GIT_COMMITTER_DATE` or `GIT_AUTHOR_DATE` inherited from the environment never dates it.
 */
export function mousseCommitEnvNow(now = Date.now()): NodeJS.ProcessEnv {
  const date = `@${Math.floor(now / 1000)} +0000`
  return { ...MOUSSE_COMMIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
}
