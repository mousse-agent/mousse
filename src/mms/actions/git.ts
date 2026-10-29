import { type AppError, knownAppError } from '../../shared/errors'
import type { PendingChangesDetails } from '../../shared/workspace'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { filterRefusal, repoProgramEnv, withoutRepoPrograms } from '../git/repoPrograms'
import { IN_PROGRESS_GIT_MARKERS } from '../git/gitMarkers'
import { MOUSSE_COMMIT_EMAIL, MOUSSE_COMMIT_NAME } from '../git/mousseCommitIdentity'
import { readWorkingTreeStatusSync, type StatusEntry } from '../git/workingTreeStatus'
import { rethrowGitPolicyError } from '../git/gitPolicy'

/**
 * Git for Mousse's own actions (checkpoints, restore, undo, revert): no program the repository
 * configures runs. Files under a filter only the repository defines (git-crypt) are refused, with a
 * message saying why, rather than stored unfiltered.
 */
export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('git', withoutRepoPrograms(cwd, args, { env }), {
      cwd,
      env: repoProgramEnv(env ? { ...process.env, ...env } : process.env),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch (error) {
    const refusal = filterRefusal(String((error as { stderr?: unknown }).stderr ?? ''))
    if (refusal) throw new Error(refusal, { cause: error })
    throw error
  }
}

export function tryGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; stdout: string; stderr: string } {
  let guarded: string[]
  try {
    guarded = withoutRepoPrograms(cwd, args, { env })
  } catch (error) {
    // A refusal by the central Git check is its own error, never an ordinary failed run.
    rethrowGitPolicyError(error)
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
  const result = spawnSync('git', guarded, { cwd, encoding: 'utf8', env: repoProgramEnv(env ? { ...process.env, ...env } : process.env) })
  const stderr = result.stderr.trim()
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: (result.status !== 0 && filterRefusal(stderr)) || stderr }
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

/** Git output exactly as printed (NUL-separated lists keep leading and trailing spaces), optionally fed `input`. */
function gitRaw(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): string {
  const result = spawnSync('git', withoutRepoPrograms(cwd, args, { env, stdin: input }), { cwd, encoding: 'utf8', input, env: repoProgramEnv(env ? { ...process.env, ...env } : process.env) })
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim()
    throw new Error(filterRefusal(stderr) || stderr || `git ${args[0]} failed`)
  }
  return result.stdout
}

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
export function inspectPendingChanges(cwd: string): PendingChanges {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  // Plumbing, not `git status`: a check never refreshes and rewrites the index of the checkout it looks at.
  const files: string[] = []
  const unmerged: string[] = []
  for (const entry of readWorkingTreeStatusSync(top)) {
    if (isConflict(entry)) unmerged.push(entry.path)
    else files.push(entry.path)
  }
  const operation = operationInProgress(top)
  return { top, files: [...unmerged, ...files], unmerged, ...(operation ? { operation } : {}) }
}

/** The merge, revert, cherry-pick or rebase that waits for the user in a checkout, if any. */
export function operationInProgress(cwd: string): PendingChanges['operation'] {
  for (const marker of IN_PROGRESS_GIT_MARKERS) {
    const resolved = tryGit(cwd, ['rev-parse', '--git-path', marker])
    if (resolved.ok && existsSync(resolve(cwd, resolved.stdout))) return OPERATION_OF[marker]
  }
  return undefined
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
 * uncommitted changes (`workspace_not_clean`). It names the folder and the first few files.
 */
export function pendingChangesError(cwd: string, label: string, options: PendingChangesOptions = {}, pending = inspectPendingChanges(cwd)): AppError {
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
export function requireClean(cwd: string, label: string): void {
  const status = git(cwd, ['status', '--porcelain=v2', '--untracked-files=all'])
  if (status) throw pendingChangesError(cwd, label)
}

/** Refuses only what Mousse can't safely set aside or save: an unresolved conflict or a Git operation in progress. */
export function refuseUnsafeChanges(cwd: string, label: string, options: PendingChangesOptions = {}): PendingChanges {
  const pending = inspectPendingChanges(cwd)
  if (pending.unmerged.length || pending.operation) throw pendingChangesError(cwd, label, options, pending)
  return pending
}

function withIndexFile<T>(top: string, run: (env: NodeJS.ProcessEnv) => T, copyFrom?: string): T {
  const file = join(git(top, ['rev-parse', '--absolute-git-dir']), `mousse-pending-${randomUUID()}.index`)
  try {
    if (copyFrom && existsSync(copyFrom)) copyFileSync(copyFrom, file)
    return run({ GIT_INDEX_FILE: file })
  } finally {
    rmSync(file, { force: true })
  }
}

export function treeOf(top: string, revision: string): string {
  return git(top, ['rev-parse', `${revision}^{tree}`])
}

/** Three-way merge of `theirs` onto `ours` from `base`, without touching the checkout. */
export function mergeTrees(top: string, base: string, ours: string, theirs: string): { tree: string } | { conflicts: string[] } {
  const result = tryGit(top, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${base}`, ours, theirs])
  const [tree, ...files] = result.stdout.split(/\r?\n/)
  if (result.ok && tree) return { tree }
  // Exit 1 lists the conflicted files after the tree; anything else (an old Git without `--merge-base`) is a conflict too.
  return { conflicts: /^[0-9a-f]{40,64}$/.test(tree ?? '') ? files.filter(Boolean) : [] }
}

/**
 * Keeps a copy of every pending change (tracked and untracked, not ignored) as a commit on top of HEAD under
 * `refs/mousse/discarded/<id>`, without touching the index or the files. Uses a private index file.
 */
export function backupPendingChanges(top: string): string {
  return withIndexFile(top, (env) => {
    git(top, ['read-tree', 'HEAD'], env)
    git(top, ['add', '-A', '--', '.', NOT_MOUSSE], env)
    const tree = git(top, ['write-tree'], env)
    const commit = git(top, ['commit-tree', tree, '-p', 'HEAD', '-m', 'mousse: copy of discarded changes'], MOUSSE_COMMIT_ENV)
    const ref = `refs/mousse/discarded/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    git(top, ['update-ref', ref, commit])
    return ref
  })
}

/**
 * Drops pending changes, untracked files and an unfinished merge, revert or cherry-pick, after keeping a copy
 * (see `backupPendingChanges`). Ignored files, nested repositories and `.mousse/` stay. A rebase is refused.
 * The caller holds the mutation locks and has the user's confirmation.
 */
export function discardPendingChanges(cwd: string): { backupRef: string } {
  const pending = inspectPendingChanges(cwd)
  if (pending.operation === 'rebase') throw pendingChangesError(cwd, 'Workspace', {}, pending)
  const backupRef = backupPendingChanges(pending.top)
  git(pending.top, ['reset', '--hard', '-q', 'HEAD'])
  git(pending.top, ['clean', '-f', '-d', '-q', '--', '.', NOT_MOUSSE])
  const left = inspectPendingChanges(pending.top)
  if (ownPaths(left.files).length || left.operation) throw pendingChangesError(cwd, 'Workspace', {}, left)
  return { backupRef }
}

export function commitParents(cwd: string, sha: string): string[] {
  const line = git(cwd, ['rev-list', '--parents', '-n', '1', sha])
  return line.split(/\s+/).slice(1)
}

export function changedPaths(cwd: string, start: string, end: string): Array<{ path: string; beforeHash?: string; afterHash?: string }> {
  if (start === end) return []
  const paths = git(cwd, ['diff', '--name-only', `${start}..${end}`]).split(/\r?\n/).filter(Boolean)
  const blob = (revision: string, path: string): string | undefined => {
    const result = tryGit(cwd, ['rev-parse', `${revision}:${path}`])
    return result.ok ? result.stdout : undefined
  }
  return paths.map((path) => ({ path, beforeHash: blob(start, path), afterHash: blob(end, path) }))
}

export { MOUSSE_COMMIT_EMAIL }

export const MOUSSE_COMMIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: MOUSSE_COMMIT_NAME,
  GIT_AUTHOR_EMAIL: MOUSSE_COMMIT_EMAIL,
  GIT_COMMITTER_NAME: MOUSSE_COMMIT_NAME,
  GIT_COMMITTER_EMAIL: MOUSSE_COMMIT_EMAIL
}
