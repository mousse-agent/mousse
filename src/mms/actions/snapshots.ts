import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { GitRecord } from '../../shared/threadActions'
import { git, mergeTrees, MOUSSE_COMMIT_ENV, NOT_MOUSSE, operationInProgress, tryGit, treeOf } from './git'

/**
 * Workspace snapshots (docs/workspace-snapshots.md): a commit whose tree is every file of a worktree (tracked and
 * untracked, never ignored files or `.mousse/`), built with a private index so that HEAD, the branches, the real
 * index and the files are never touched. Its parent is the worktree's HEAD, so it is reachable from nowhere until a
 * ref under `refs/mousse/` pins it.
 */
export interface Snapshot {
  sha: string
  tree: string
  /** The worktree's HEAD when the snapshot was taken; absent in a repository with no commit. */
  head?: string
  /** The branch HEAD was on; absent when detached. */
  branch?: string
  /** A merge, rebase, revert or cherry-pick that was waiting in the worktree. */
  operationInProgress?: string
}

export interface SnapshotInput {
  /** Why it was taken, for the commit message: "turn end", "outside changes". One line. */
  reason: string
  threadId?: string
  operationId?: string
}

const SUBJECT = 'mousse snapshot: '

interface LastSnapshot { sha: string; tree: string; head?: string }

function privateFiles(top: string): { directory: string; index: string; last: string } {
  // `--git-path` keeps names Git doesn't know in the worktree's own Git directory, so each linked worktree has its own.
  const directory = resolve(top, git(top, ['rev-parse', '--git-path', 'mousse']))
  mkdirSync(directory, { recursive: true })
  return { directory, index: join(directory, 'snapshot-index'), last: join(directory, 'snapshot-last.json') }
}

function headOf(top: string): string | undefined {
  return tryGit(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).stdout || undefined
}

/**
 * The tree of every file in the worktree, from the persistent private index. The index stays between snapshots so
 * Git's stat cache keeps the next one fast; a missing, locked or corrupt one is rebuilt from HEAD.
 */
function indexTree(top: string, index: string, head: string | undefined): string {
  const env = { GIT_INDEX_FILE: index }
  const attempt = (): string => {
    if (!existsSync(index)) git(top, head ? ['read-tree', head] : ['read-tree', '--empty'], env)
    git(top, ['add', '-A', '--', '.', NOT_MOUSSE], env)
    return git(top, ['write-tree'], env)
  }
  try {
    return attempt()
  } catch {
    // The caller holds the mutation locks, so a lock file left by a crash is nobody's.
    rmSync(index, { force: true })
    rmSync(`${index}.lock`, { force: true })
    return attempt()
  }
}

/** The tree of the worktree's files right now, without writing a commit. */
export function worktreeTree(cwd: string): string {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  return indexTree(top, privateFiles(top).index, headOf(top))
}

function readLast(path: string): LastSnapshot | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as LastSnapshot } catch { return undefined }
}

/**
 * Records the worktree's files as a snapshot commit. It never changes HEAD, a branch, the real index or a file, and
 * it works while a merge or rebase is in progress (the snapshot says so). When the files and HEAD are what the
 * previous snapshot had, that snapshot is returned. The caller holds the mutation locks.
 */
export function takeSnapshot(cwd: string, input: SnapshotInput): Snapshot {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  const files = privateFiles(top)
  const head = headOf(top)
  const tree = indexTree(top, files.index, head)
  const branch = tryGit(top, ['branch', '--show-current']).stdout || undefined
  const operation = operationInProgress(top)
  const state = { tree, ...(head ? { head } : {}), ...(branch ? { branch } : {}), ...(operation ? { operationInProgress: operation } : {}) }
  const previous = readLast(files.last)
  if (previous && previous.tree === tree && previous.head === head && tryGit(top, ['cat-file', '-e', `${previous.sha}^{commit}`]).ok) return { sha: previous.sha, ...state }
  const trailers = [
    input.threadId ? `Mousse-Thread: ${input.threadId}` : '', input.operationId ? `Mousse-Operation: ${input.operationId}` : '',
    head ? `Mousse-Head: ${head}` : '', branch ? `Mousse-Branch: ${branch}` : ''
  ].filter(Boolean).join('\n')
  const subject = `${SUBJECT}${input.reason.split(/\r?\n/)[0]!.trim()}`
  const sha = git(top, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', subject, ...(trailers ? ['-m', trailers] : [])], MOUSSE_COMMIT_ENV)
  writeFileSync(files.last, JSON.stringify({ sha, tree, ...(head ? { head } : {}) } satisfies LastSnapshot))
  return { sha, ...state }
}

/** Whether two revisions (snapshots or commits) hold the same files. Revisions that cannot be read are not the same. */
export function sameTree(cwd: string, a: string, b: string): boolean {
  if (a === b) return true
  try { return treeOf(cwd, a) === treeOf(cwd, b) } catch { return false }
}

/**
 * The HEAD and branch a snapshot was taken on. A commit that is not a snapshot is an action recorded before
 * snapshots existed, when its start and end were the branch's own commits: it was HEAD itself.
 */
export function snapshotOrigin(cwd: string, sha: string): { head?: string; branch?: string } {
  const body = tryGit(cwd, ['log', '-1', '--format=%B', sha])
  if (!body.ok) return {}
  if (!body.stdout.startsWith(SUBJECT)) return { head: sha }
  const trailer = (name: string): string | undefined => body.stdout.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1]?.trim()
  return { head: trailer('Mousse-Head'), branch: trailer('Mousse-Branch') }
}

/**
 * What the thread's Git did between a start (a snapshot or legacy commit) and the `after` snapshot, and the real
 * commits it added to HEAD (first parent, oldest first; none when history was rewritten or HEAD did not move).
 */
export function describeGit(cwd: string, startSha: string, after: Snapshot): { record: GitRecord; commits: string[] } {
  const before = snapshotOrigin(cwd, startSha)
  let commits: string[] = []
  let rewroteHistory = false
  if (before.head && after.head && before.head !== after.head) {
    if (tryGit(cwd, ['merge-base', '--is-ancestor', before.head, after.head]).ok) {
      commits = git(cwd, ['rev-list', '--first-parent', '--reverse', `${before.head}..${after.head}`]).split(/\r?\n/).filter(Boolean)
    } else rewroteHistory = true
  }
  const record: GitRecord = {
    ...(before.head ? { headBefore: before.head } : {}), ...(after.head ? { headAfter: after.head } : {}),
    ...(before.branch ? { branchBefore: before.branch } : {}), ...(after.branch ? { branchAfter: after.branch } : {}),
    rewroteHistory, ...(after.operationInProgress ? { operationInProgress: after.operationInProgress } : {})
  }
  return { record, commits }
}

/** The remote-tracking branch that already holds one of `commits`, if any: Undo cannot take a pushed commit back. */
export function pushedTo(cwd: string, commits: string[]): string | undefined {
  // A ref that holds a later commit holds every earlier one, so the first is enough.
  const first = commits[0]
  if (!first) return undefined
  const refs = tryGit(cwd, ['for-each-ref', '--contains', first, '--format=%(refname:short)', 'refs/remotes/'])
  return refs.ok ? refs.stdout.split(/\r?\n/).find((ref) => ref && !ref.endsWith('/HEAD')) : undefined
}

/** The line a result carries when the turn's commits are already on a remote: only files are taken back. */
export function pushedNotice(operation: string, remote: string): string {
  return `These commits were already pushed to ${remote}; ${operation} restores files only.`
}

export type RestoreResult = { snapshot: Snapshot; tree: string } | { conflicts: string[] }

export interface RestoreChangeInput extends SnapshotInput {
  /** The code the change started from; with `theirs` it is what is taken back (Undo: the turn's end). */
  base: string
  /** The code now: a snapshot of the worktree taken under the same lock. */
  ours: string
  /** The code to bring in (Undo: the turn's start). */
  theirs: string
}

/**
 * Brings `theirs` into the worktree by a three-way merge from `base` onto `ours`, which edits to other lines or
 * files made since survive. Conflicts refuse it with the conflicting paths and change nothing. Otherwise only the
 * files the merge changes are rewritten, through a temporary private index, and the result is recorded as a new
 * snapshot. It never commits, never moves HEAD and never touches the real index. The caller holds the mutation
 * locks and has just taken `ours`. `planned` is told the tree the files are about to become, before they change,
 * so the caller can write it down for recovery.
 */
export function restoreChange(cwd: string, input: RestoreChangeInput, planned?: (tree: string) => void): RestoreResult {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  const merged = mergeTrees(top, input.base, input.ours, input.theirs)
  if ('conflicts' in merged) return merged
  planned?.(merged.tree)
  moveFiles(top, treeOf(top, input.ours), merged.tree)
  return { snapshot: takeSnapshot(top, input), tree: merged.tree }
}

/**
 * Rewrites the files that differ between two trees from the first (what the worktree holds, as of the last snapshot)
 * to the second, through a temporary private index. A file that changed since the snapshot makes Git refuse
 * before anything is written.
 */
export function moveFiles(top: string, from: string, to: string): void {
  if (from === to) return
  const files = privateFiles(top)
  const temporary = join(files.directory, `restore-${randomUUID()}.index`)
  const env = { GIT_INDEX_FILE: temporary }
  try {
    // The persistent index was refreshed by the snapshot, so its stat data lets Git see that the files still match.
    if (existsSync(files.index)) copyFileSync(files.index, temporary)
    if (!existsSync(temporary) || git(top, ['write-tree'], env) !== from) {
      git(top, ['read-tree', from], env)
      tryGit(top, ['update-index', '-q', '--refresh'], env)
    }
    git(top, ['read-tree', '-m', '-u', from, to], env)
  } finally {
    rmSync(temporary, { force: true })
  }
}
