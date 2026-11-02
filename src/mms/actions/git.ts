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
import { runGitProcess } from '../git/runGitProcess'
import { files, runAsync, step, type Steps } from './steps'

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

/**
 * Git for Mousse's own actions (checkpoints, restore, undo, revert): no program the repository
 * configures runs. Files under a filter only the repository defines (git-crypt) are refused, with a
 * message saying why, rather than stored unfiltered. Code that can wait uses {@link gitAsync}.
 */
export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): string {
  try {
    return execFileSync('git', guarded(cwd, args, { ...(env ? { env } : {}), ...(input !== undefined ? { stdin: input } : {}) }), {
      cwd,
      env: gitEnv(cwd, env),
      encoding: 'utf8',
      ...(input !== undefined ? { input, maxBuffer: 256 * 1024 * 1024 } : {}),
      stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
    }).trim()
  } catch (error) {
    const refusal = filterRefusal(String((error as { stderr?: unknown }).stderr ?? ''))
    if (refusal) throw new Error(refusal, { cause: error })
    throw error
  }
}

/** {@link git} without blocking the daemon: the same check, command and answer, and an error carrying Git's `stderr` and `status`. */
export async function gitAsync(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> {
  const argv = await guardedAsync(cwd, args, { ...(env ? { env } : {}), ...(input !== undefined ? { stdin: input } : {}) })
  const ran = await runGitProcess(argv, { cwd, env: gitEnv(cwd, env), input, maxBuffer: input !== undefined ? 256 * 1024 * 1024 : DEFAULT_MAX_BUFFER })
  if (!ran.error && ran.status === 0) return ran.stdout.trim()
  const error = Object.assign(new Error(`Command failed: git ${argv.join(' ')}${ran.stderr ? `\n${ran.stderr}` : ''}`, ran.error ? { cause: ran.error } : undefined), { status: ran.status, stdout: ran.stdout, stderr: ran.stderr })
  const refusal = filterRefusal(ran.stderr)
  if (refusal) throw new Error(refusal, { cause: error })
  throw error
}

export function tryGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; stdout: string; stderr: string } {
  let safe: string[]
  try {
    safe = guarded(cwd, args, { env })
  } catch (error) {
    // A refusal by the central Git check is its own error, never an ordinary failed run.
    rethrowGitPolicyError(error)
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
  const result = spawnSync('git', safe, { cwd, encoding: 'utf8', env: gitEnv(cwd, env) })
  const stderr = result.stderr.trim()
  // Output cut off at the limit is a failure, even when Git exited 0 before it was stopped (`spawnSync` reports both).
  const ok = !result.error && result.status === 0
  return { ok, stdout: result.stdout.trim(), stderr: (!ok && filterRefusal(stderr)) || stderr }
}

/** {@link tryGit} without blocking the daemon. */
export async function tryGitAsync(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  let safe: string[]
  try {
    safe = await guardedAsync(cwd, args, { env })
  } catch (error) {
    rethrowGitPolicyError(error)
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
  const result = await runGitProcess(safe, { cwd, env: gitEnv(cwd, env) })
  const stderr = result.stderr.trim()
  // As in `tryGit`: output cut off at the limit is a failure.
  const ok = !result.error && result.status === 0
  return { ok, stdout: result.stdout.trim(), stderr: (!ok && filterRefusal(stderr)) || stderr }
}

/** {@link git} as a step: see `steps.ts`. */
export function gitStep(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Steps<string> {
  return step(() => git(cwd, args, env, input), () => gitAsync(cwd, args, env, input))
}

/** {@link tryGit} as a step. */
export function tryGitStep(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Steps<{ ok: boolean; stdout: string; stderr: string }> {
  return step(() => tryGit(cwd, args, env), () => tryGitAsync(cwd, args, env))
}

/** How many changed files a message names before it says "and N more". */
const NAMED_FILES = 5
const CONFLICT_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
const isConflict = (entry: StatusEntry): boolean => CONFLICT_PAIRS.has(`${entry.index || ' '}${entry.workdir || ' '}`)
const OPERATION_OF: Record<(typeof IN_PROGRESS_GIT_MARKERS)[number], PendingChanges['operation']> = {
  MERGE_HEAD: 'merge', REVERT_HEAD: 'revert', CHERRY_PICK_HEAD: 'cherry-pick', REBASE_HEAD: 'rebase', 'rebase-merge': 'rebase', 'rebase-apply': 'rebase'
}
/** Mousse's own files in a checkout; never part of the user's pending changes. */
const MOUSSE_DIRECTORY = '.mousse'
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
  const status = yield* gitStep(cwd, ['status', '--porcelain=v2', '--untracked-files=all'])
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

function* withIndexFile<T>(top: string, run: (env: NodeJS.ProcessEnv) => Steps<T>, copyFrom?: string): Steps<T> {
  const file = join(yield* gitStep(top, ['rev-parse', '--absolute-git-dir']), `mousse-pending-${randomUUID()}.index`)
  try {
    if (copyFrom && (yield* files.exists(copyFrom))) yield* files.copyFile(copyFrom, file)
    return yield* run({ GIT_INDEX_FILE: file })
  } finally {
    yield* files.remove(file)
  }
}

export function* treeOfSteps(top: string, revision: string): Steps<string> {
  return yield* gitStep(top, ['rev-parse', `${revision}^{tree}`])
}


export function treeOfAsync(top: string, revision: string): Promise<string> {
  return runAsync(treeOfSteps(top, revision))
}

/** Three-way merge of `theirs` onto `ours` from `base`, without touching the checkout. */
export function* mergeTreesSteps(top: string, base: string, ours: string, theirs: string): Steps<{ tree: string } | { conflicts: string[] }> {
  const result = yield* tryGitStep(top, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${base}`, ours, theirs])
  const [tree, ...files] = result.stdout.split(/\r?\n/)
  if (result.ok && tree) return { tree }
  // Exit 1 lists the conflicted files after the tree; anything else (an old Git without `--merge-base`) is a conflict too.
  return { conflicts: /^[0-9a-f]{40,64}$/.test(tree ?? '') ? files.filter(Boolean) : [] }
}


export function mergeTreesAsync(top: string, base: string, ours: string, theirs: string): Promise<{ tree: string } | { conflicts: string[] }> {
  return runAsync(mergeTreesSteps(top, base, ours, theirs))
}

/**
 * Keeps a copy of every pending change as a commit on top of HEAD under `refs/mousse/discarded/<id>`, without touching
 * the index or the files. It starts from a copy of the real index, so what is staged is in it, a force-added ignored
 * file included, and then adds the files as they are (tracked and untracked, not ignored). Throws when it cannot.
 */
export function* backupPendingChangesSteps(top: string): Steps<string> {
  const realIndex = resolve(top, yield* gitStep(top, ['rev-parse', '--git-path', 'index']))
  return yield* withIndexFile(top, function* (env) {
    if (!(yield* files.exists(realIndex))) yield* gitStep(top, ['read-tree', 'HEAD'], env)
    yield* gitStep(top, ['add', '-A', '--', '.', NOT_MOUSSE], env)
    const tree = yield* gitStep(top, ['write-tree'], env)
    const commit = yield* gitStep(top, ['commit-tree', tree, '-p', 'HEAD', '-m', 'mousse: copy of discarded changes'], MOUSSE_COMMIT_ENV)
    const ref = `refs/mousse/discarded/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    yield* gitStep(top, ['update-ref', '--no-deref', ref, commit])
    return ref
  }, realIndex)
}


/**
 * Drops pending changes, untracked files and an unfinished merge, revert or cherry-pick, after keeping a copy
 * (see `backupPendingChanges`). Ignored files, nested repositories and `.mousse/` stay. A rebase is refused.
 * The caller holds the mutation locks and has the user's confirmation.
 */
export function* discardPendingChangesSteps(cwd: string): Steps<{ backupRef: string }> {
  const pending = yield* inspectPendingChangesSteps(cwd)
  if (pending.operation === 'rebase') throw pendingChangesErrorFor('Workspace', {}, pending)
  const backupRef = yield* backupPendingChangesSteps(pending.top)
  yield* gitStep(pending.top, ['reset', '--hard', '-q', 'HEAD'])
  yield* gitStep(pending.top, ['clean', '-f', '-d', '-q', '--', '.', NOT_MOUSSE])
  const left = yield* inspectPendingChangesSteps(pending.top)
  if (ownPaths(left.files).length || left.operation) throw pendingChangesErrorFor('Workspace', {}, left)
  return { backupRef }
}


export function discardPendingChangesAsync(cwd: string): Promise<{ backupRef: string }> {
  return runAsync(discardPendingChangesSteps(cwd))
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
  const paths = (yield* gitStep(cwd, ['diff', '--name-only', `${start}..${end}`])).split(/\r?\n/).filter(Boolean)
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
