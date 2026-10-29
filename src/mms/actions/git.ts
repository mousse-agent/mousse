import { type AppError, knownAppError } from '../../shared/errors'
import type { PendingChangesAction, PendingChangesDetails, PendingChangesFolder } from '../../shared/workspace'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
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

/** How many changed files an error names before it says "and N more". */
const NAMED_FILES = 5
/** Fields before the path in each `git status --porcelain=v2` entry type. */
const FIELDS_BEFORE_PATH: Record<string, number> = { '1': 8, '2': 9, u: 10, '?': 1 }
const OPERATION_OF: Record<(typeof IN_PROGRESS_GIT_MARKERS)[number], PendingChanges['operation']> = {
  MERGE_HEAD: 'merge', REVERT_HEAD: 'revert', CHERRY_PICK_HEAD: 'cherry-pick', REBASE_HEAD: 'rebase', 'rebase-merge': 'rebase', 'rebase-apply': 'rebase'
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
  const entries = git(top, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).split('\0')
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

export interface PendingChangesOptions {
  /** The folder the user may act on with `workspace.resolvePendingChanges`; without it the error offers no action. */
  folder?: PendingChangesFolder
  /** The actions this caller can continue after. Save is never offered for a conflict, nor anything during a rebase. */
  actions?: PendingChangesAction[]
}

function listFiles(files: string[]): string {
  const named = files.slice(0, NAMED_FILES).join(', ')
  return files.length > NAMED_FILES ? `${named} and ${files.length - NAMED_FILES} more` : named
}

/**
 * The refusal for a checkout with pending changes: it names the folder and the first few files, and carries
 * the actions the caller can continue after, which the app shows as buttons.
 */
export function pendingChangesError(cwd: string, label: string, options: PendingChangesOptions = {}, pending = inspectPendingChanges(cwd)): AppError {
  const conflict = pending.unmerged.length > 0 || pending.operation !== undefined
  let actions = options.folder ? options.actions ?? [] : []
  // Committing a conflict would record its markers; a rebase can leave HEAD away from the branch, so nothing is automatic.
  if (conflict) actions = pending.operation === 'rebase' ? [] : actions.filter((action) => action !== 'save')
  const details: PendingChangesDetails = {
    label, path: pending.top, ...(options.folder ? { folder: options.folder } : {}),
    files: pending.files.slice(0, NAMED_FILES), count: pending.files.length, conflict, actions
  }
  const next = actions.includes('save') ? 'Save or discard them, then try again.'
    : actions.includes('discard') ? 'Resolve or discard them, then try again.'
    : conflict ? 'Finish or abort it in a terminal, then try again.' : 'Commit or discard them, then try again.'
  const message = conflict
    ? `${label} ${pending.top} has ${pending.operation ? `a ${pending.operation} in progress` : 'an unresolved conflict'}${pending.unmerged.length ? ` with conflicts in ${listFiles(pending.unmerged)}` : ''}. ${next}`
    : `${label} ${pending.top} has uncommitted changes: ${listFiles(pending.files)}. ${next}`
  return knownAppError({ code: conflict ? 'workspace_conflict' : 'workspace_not_clean', message, details }, { category: 'conflict', retryable: false })
}

export function requireClean(cwd: string, label: string, options?: PendingChangesOptions): void {
  const status = git(cwd, ['status', '--porcelain=v2', '--untracked-files=all'])
  if (status) throw pendingChangesError(cwd, label, options)
}

/**
 * Keeps a copy of every pending change (tracked and untracked, not ignored) as a commit on top of HEAD under
 * `refs/mousse/discarded/<id>`, without touching the index or the files. Uses a private index file.
 */
export function backupPendingChanges(top: string): string {
  const index = join(git(top, ['rev-parse', '--absolute-git-dir']), `mousse-discard-${randomUUID()}.index`)
  const env = { GIT_INDEX_FILE: index }
  try {
    git(top, ['read-tree', 'HEAD'], env)
    git(top, ['add', '-A', '--', '.'], env)
    const tree = git(top, ['write-tree'], env)
    const commit = git(top, ['commit-tree', tree, '-p', 'HEAD', '-m', 'mousse: copy of discarded changes'], MOUSSE_COMMIT_ENV)
    const ref = `refs/mousse/discarded/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    git(top, ['update-ref', ref, commit])
    return ref
  } finally {
    rmSync(index, { force: true })
  }
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
  git(pending.top, ['reset', '--hard', 'HEAD'])
  git(pending.top, ['clean', '-f', '-d', '--', '.', ':(exclude).mousse'])
  const left = inspectPendingChanges(pending.top)
  if (left.files.length || left.operation) throw pendingChangesError(cwd, 'Workspace', {}, left)
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

export const MOUSSE_COMMIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Mousse',
  GIT_AUTHOR_EMAIL: 'mousse@local',
  GIT_COMMITTER_NAME: 'Mousse',
  GIT_COMMITTER_EMAIL: 'mousse@local'
}
