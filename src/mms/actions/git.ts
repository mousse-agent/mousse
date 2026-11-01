import { type AppError, knownAppError } from '../../shared/errors'
import type { PendingChangesDetails } from '../../shared/workspace'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { filterRefusal, repoProgramEnv, withoutRepoPrograms } from '../git/repoPrograms'
import { IN_PROGRESS_GIT_MARKERS } from '../git/gitMarkers'

/**
 * Git for Mousse's own actions (checkpoints, restore, undo, revert): no program the repository
 * configures runs. Files under a filter only the repository defines (git-crypt) are refused, with a
 * message saying why, rather than stored unfiltered.
 */
export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('git', withoutRepoPrograms(cwd, args), {
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
    guarded = withoutRepoPrograms(cwd, args)
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
  const result = spawnSync('git', guarded, { cwd, encoding: 'utf8', env: repoProgramEnv(env ? { ...process.env, ...env } : process.env) })
  const stderr = result.stderr.trim()
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: (result.status !== 0 && filterRefusal(stderr)) || stderr }
}

/** How many changed files a message names before it says "and N more". */
const NAMED_FILES = 5
/** Fields before the path in each `git status --porcelain=v2` entry type. */
const FIELDS_BEFORE_PATH: Record<string, number> = { '1': 8, '2': 9, u: 10, '?': 1 }
const OPERATION_OF: Record<(typeof IN_PROGRESS_GIT_MARKERS)[number], PendingChanges['operation']> = {
  MERGE_HEAD: 'merge', REVERT_HEAD: 'revert', CHERRY_PICK_HEAD: 'cherry-pick', REBASE_HEAD: 'rebase', 'rebase-merge': 'rebase', 'rebase-apply': 'rebase'
}
/** Mousse's own files in a checkout; never part of the user's pending changes. */
const MOUSSE_DIRECTORY = '.mousse'
const NOT_MOUSSE = `:(exclude)${MOUSSE_DIRECTORY}`

/** Git output exactly as printed (NUL-separated lists keep leading and trailing spaces), optionally fed `input`. */
function gitRaw(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): string {
  const result = spawnSync('git', withoutRepoPrograms(cwd, args), { cwd, encoding: 'utf8', input, env: repoProgramEnv(env ? { ...process.env, ...env } : process.env) })
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
  const entries = gitRaw(top, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).split('\0')
  const files: string[] = []
  const unmerged: string[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const fields = FIELDS_BEFORE_PATH[entry[0]]
    if (!fields) continue
    // The path is everything after the fixed fields, spaces included; a rename or copy is followed by its old name.
    const path = entry.split(' ').slice(fields).join(' ')
    if (entry[0] === '2') index++
    if (entry[0] === 'u') unmerged.push(path)
    else files.push(path)
  }
  let operation: PendingChanges['operation']
  for (const marker of IN_PROGRESS_GIT_MARKERS) {
    const resolved = tryGit(top, ['rev-parse', '--git-path', marker])
    if (resolved.ok && existsSync(resolve(top, resolved.stdout))) { operation = OPERATION_OF[marker]; break }
  }
  return { top, files: [...unmerged, ...files], unmerged, ...(operation ? { operation } : {}) }
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

/**
 * The user's pending changes, kept as a commit shaped like a `git stash` entry under `refs/mousse/pending-changes/`:
 * `commit` has the tracked files as they are on disk and the parents `base` (HEAD), `index` (what was staged) and,
 * when there were any, `untracked` (a root commit of the untracked files). `git stash apply <ref>` restores it too.
 */
export interface PendingChangesSnapshot {
  top: string
  ref: string
  commit: string
  base: string
  index: string
  untracked?: string
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

/** Writes `refs/mousse/pending-changes/<time>-<id>` for the pending changes in `top` without touching the index or the files. */
function snapshotPendingChanges(top: string): PendingChangesSnapshot {
  const base = git(top, ['rev-parse', 'HEAD'])
  const branch = tryGit(top, ['branch', '--show-current']).stdout || 'HEAD'
  const index = git(top, ['commit-tree', git(top, ['write-tree']), '-p', base, '-m', `index on ${branch}: mousse pending changes`], MOUSSE_COMMIT_ENV)
  const untrackedPaths = ownPaths(gitRaw(top, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.', NOT_MOUSSE]).split('\0').filter(Boolean))
  const untracked = untrackedPaths.length ? withIndexFile(top, (env) => {
    gitRaw(top, ['update-index', '--add', '-z', '--stdin'], env, untrackedPaths.map((path) => `${path}\0`).join(''))
    return git(top, ['commit-tree', git(top, ['write-tree'], env), '-m', `untracked files on ${branch}: mousse pending changes`], MOUSSE_COMMIT_ENV)
  }) : undefined
  const tree = withIndexFile(top, (env) => {
    git(top, ['add', '-u', '--', '.', NOT_MOUSSE], env)
    return git(top, ['write-tree'], env)
  }, resolve(top, git(top, ['rev-parse', '--git-path', 'index'])))
  const parents = [base, index, ...(untracked ? [untracked] : [])].flatMap((parent) => ['-p', parent])
  const commit = git(top, ['commit-tree', tree, ...parents, '-m', `On ${branch}: mousse pending changes`], MOUSSE_COMMIT_ENV)
  const ref = `refs/mousse/pending-changes/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  git(top, ['update-ref', ref, commit])
  return { top, ref, commit, base, index, untracked }
}

/**
 * Moves the user's pending changes (tracked and untracked, staged or not; never ignored files, nested
 * repositories or `.mousse/`) out of the way: a snapshot first, then the checkout is reset to HEAD. Undefined
 * when nothing is pending. A conflict or a Git operation in progress is refused. The caller holds the mutation locks.
 */
export function setAsidePendingChanges(cwd: string, label: string, options: PendingChangesOptions = {}): PendingChangesSnapshot | undefined {
  const pending = refuseUnsafeChanges(cwd, label, options)
  if (!ownPaths(pending.files).length) return undefined
  const snapshot = snapshotPendingChanges(pending.top)
  git(pending.top, ['reset', '--hard', '-q', 'HEAD'])
  git(pending.top, ['clean', '-f', '-d', '-q', '--', '.', NOT_MOUSSE])
  const left = ownPaths(inspectPendingChanges(pending.top).files)
  if (left.length) {
    restorePendingChanges(snapshot)
    throw new Error(`Mousse could not set aside the uncommitted changes in ${pending.top}: ${listFiles(left)}. They are saved as ${snapshot.ref}.`)
  }
  return snapshot
}

/** Keeps a snapshot under another ref (pending changes that wait for their conversation branch). */
export function movePendingSnapshot(snapshot: PendingChangesSnapshot, ref: string): PendingChangesSnapshot {
  git(snapshot.top, ['update-ref', ref, snapshot.commit, ''])
  git(snapshot.top, ['update-ref', '-d', snapshot.ref, snapshot.commit])
  return { ...snapshot, ref }
}

/** The snapshots kept under `prefix` (see `movePendingSnapshot`), oldest first. */
export function pendingSnapshotsUnder(cwd: string, prefix: string): PendingChangesSnapshot[] {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  const refs = git(top, ['for-each-ref', '--sort=refname', '--format=%(refname) %(objectname)', prefix]).split(/\r?\n/).filter(Boolean)
  return refs.map((line) => {
    const [ref, commit] = line.split(' ')
    const [base, index, untracked] = commitParents(top, commit)
    return { top, ref, commit, base, index, ...(untracked ? { untracked } : {}) }
  })
}

function occupied(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

function treeOf(top: string, revision: string): string {
  return git(top, ['rev-parse', `${revision}^{tree}`])
}

function treePaths(top: string, tree: string): string[] {
  return gitRaw(top, ['ls-tree', '-r', '-z', '--name-only', tree]).split('\0').filter(Boolean)
}

/** Three-way merge of `theirs` onto `ours` from `base`, without touching the checkout. */
function mergeTrees(top: string, base: string, ours: string, theirs: string): { tree: string } | { conflicts: string[] } {
  const result = tryGit(top, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${base}`, ours, theirs])
  const [tree, ...files] = result.stdout.split(/\r?\n/)
  if (result.ok && tree) return { tree }
  // Exit 1 lists the conflicted files after the tree; anything else (an old Git without `--merge-base`) is a conflict too.
  return { conflicts: /^[0-9a-f]{40,64}$/.test(tree ?? '') ? files.filter(Boolean) : [] }
}

export type PendingChangesRestore = { restored: true } | { restored: false; files: string[] }

/**
 * Puts a snapshot back on top of whatever HEAD is now, as uncommitted changes: what was staged is staged
 * again and untracked files are untracked again. Changes that overlap with what moved HEAD are not merged:
 * nothing is applied, the ref stays, and the overlapping files are returned. Never throws.
 */
export function restorePendingChanges(snapshot: PendingChangesSnapshot): PendingChangesRestore {
  const { top } = snapshot
  try {
    const now = inspectPendingChanges(top)
    if (ownPaths(now.files).length || now.operation) return { restored: false, files: [] }
    const head = git(top, ['rev-parse', 'HEAD'])
    const moved = treeOf(top, head) !== treeOf(top, snapshot.base)
    const worktree = moved ? mergeTrees(top, snapshot.base, head, snapshot.commit) : { tree: treeOf(top, snapshot.commit) }
    if ('conflicts' in worktree) return { restored: false, files: worktree.conflicts }
    let index = treeOf(top, head)
    if (treeOf(top, snapshot.index) !== treeOf(top, snapshot.base)) {
      // Staging that no longer merges cleanly comes back unstaged; the files themselves are already merged above.
      const staged = moved ? mergeTrees(top, snapshot.base, head, snapshot.index) : { tree: treeOf(top, snapshot.index) }
      if ('tree' in staged) index = staged.tree
    }
    const untracked = snapshot.untracked ? treePaths(top, snapshot.untracked) : []
    if (untracked.length) {
      const result = new Set(treePaths(top, worktree.tree))
      const taken = untracked.filter((path) => result.has(path) || occupied(join(top, path)))
      if (taken.length) return { restored: false, files: taken }
    }
    git(top, ['read-tree', '-m', '-u', head, worktree.tree])
    if (snapshot.untracked && untracked.length) {
      withIndexFile(top, (env) => {
        git(top, ['read-tree', snapshot.untracked!], env)
        git(top, ['checkout-index', '-a'], env)
      })
    }
    git(top, ['read-tree', index])
    tryGit(top, ['update-index', '-q', '--refresh'])
    tryGit(top, ['update-ref', '-d', snapshot.ref, snapshot.commit])
    return { restored: true }
  } catch {
    return { restored: false, files: [] }
  }
}

/** Pending changes that could not be put back after an operation; they stay under `ref`. */
export interface KeptPendingChanges {
  path: string
  ref: string
  /** Files changed both by the user and by the operation; empty when the operation left the checkout unfinished. */
  files: string[]
  /** What ran, as it reads in a sentence: "Undo", "the code revert". */
  operation: string
}

export type PendingChangesKeptListener = (kept: KeptPendingChanges) => void

/** For the services that set pending changes aside. */
export interface PendingChangesOwnerOptions {
  /** Told when the user's pending changes could not be put back after the operation (they stay under a ref). */
  onPendingChangesKept?: PendingChangesKeptListener
}

/** The quiet line in the thread when pending changes could not be put back. */
export function keptPendingChangesNotice(kept: KeptPendingChanges): string {
  const why = kept.files.length ? `${listFiles(kept.files)} changed in both` : `${kept.operation} did not finish cleanly`
  return `Your uncommitted changes in ${kept.path} were not put back after ${kept.operation}: ${why}. They are saved in Git; to restore them, run \`git stash apply ${kept.ref}\` in that folder.`
}

export interface SetAsideContext extends PendingChangesOptions {
  label: string
  operation: string
  onKept?: PendingChangesKeptListener
}

/**
 * Runs a Git operation on a clean checkout and puts the user's pending changes back afterwards, staged and
 * untracked files included, whether the operation succeeded or failed. If they no longer fit, the operation's
 * result stays, the changes stay under their ref, and `onKept` is told. The caller holds the mutation locks.
 */
export async function withPendingChangesSetAside<T>(cwd: string, context: SetAsideContext, run: () => Promise<T> | T): Promise<T> {
  const snapshot = setAsidePendingChanges(cwd, context.label, context)
  if (!snapshot) return await run()
  const putBack = () => {
    const outcome = restorePendingChanges(snapshot)
    if (outcome.restored) return
    const kept = { path: snapshot.top, ref: snapshot.ref, files: outcome.files, operation: context.operation }
    if (context.onKept) context.onKept(kept)
    else console.warn('pending changes were kept', kept)
  }
  let result: T
  try {
    result = await run()
  } catch (error) {
    putBack()
    throw error
  }
  putBack()
  return result
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

/** Child commits are contributions of their merge, never a second reversal unit. */
export function introducedCommits(cwd: string, start: string, end: string): string[] {
  if (start === end) return []
  if (!tryGit(cwd, ['merge-base', '--is-ancestor', start, end]).ok) {
    throw new Error('Workspace history diverged from the recorded change boundary.')
  }
  return git(cwd, ['rev-list', '--first-parent', '--reverse', `${start}..${end}`]).split(/\r?\n/).filter(Boolean)
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

/** The author of the commits Mousse makes itself (checkpoints, undo, merges of subagents' work). */
export const MOUSSE_COMMIT_EMAIL = 'mousse@local'

export const MOUSSE_COMMIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Mousse',
  GIT_AUTHOR_EMAIL: MOUSSE_COMMIT_EMAIL,
  GIT_COMMITTER_NAME: 'Mousse',
  GIT_COMMITTER_EMAIL: MOUSSE_COMMIT_EMAIL
}
