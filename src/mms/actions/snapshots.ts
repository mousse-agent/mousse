import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'
import type { GitRecord } from '../../shared/threadActions'
import { activeHiddenStore } from '../git/hiddenStore'
import { repoProgramEnv } from '../git/repoPrograms'
import { git, guarded, mergeTrees, MOUSSE_COMMIT_ENV, NOT_MOUSSE, operationInProgress, tryGit, treeOf } from './git'

/**
 * Workspace snapshots (docs/workspace-snapshots.md): a commit whose tree is every file of a worktree (tracked and
 * untracked, never ignored files or `.mousse/`), built with a private index so that HEAD, the branches, the real
 * index and the files are never touched. Its parent is the worktree's HEAD, so it is reachable from nowhere until a
 * ref under `refs/mousse/` pins it.
 *
 * A folder with no Git Mousse may use has its snapshots in a hidden store instead (`inHiddenStore`): the same
 * commands run with `--git-dir` and `--work-tree`, the store's own index is the persistent one, and a snapshot has no
 * parent because there is no HEAD.
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

/** What a hidden store refuses to snapshot, so that a folder too large to walk quickly never slows or fails a turn. */
export interface SnapshotLimits {
  /** Files in a snapshot. */
  files: number
  /** Their total size. */
  bytes: number
  /** One file's size. */
  fileBytes: number
}

const DEFAULT_LIMITS: SnapshotLimits = { files: 50_000, bytes: 1024 ** 3, fileBytes: 50 * 1024 ** 2 }
let limits: SnapshotLimits = { ...DEFAULT_LIMITS }

/** For tests: the limits a hidden store applies. No argument restores the defaults. */
export function configureSnapshotLimits(next: Partial<SnapshotLimits> = {}): void {
  limits = { ...DEFAULT_LIMITS, ...next }
}

/** Snapshots are off for this folder: the reason is for the person, and the turn that met it carries on without them. */
export class SnapshotRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotRefusedError'
  }
}

function canonicalPath(path: string): string {
  const resolved = resolve(path)
  try { return realpathSync.native(resolved) } catch { return resolved }
}

/**
 * A folder that must never be snapshotted: the filesystem root, the home folder, or a folder that holds it. A project
 * there would put someone's whole account in a store.
 */
export function isUnsafeSnapshotRoot(path: string, home = homedir()): boolean {
  const target = canonicalPath(path)
  if (target === parse(target).root) return true
  const user = canonicalPath(home)
  return user === target || user.startsWith(target.endsWith(sep) ? target : `${target}${sep}`)
}

const UNSAFE_ROOT = 'Undo is off for this folder because it is a home or system folder.'

function sizeText(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

/** The files a snapshot would hold, as `git add -A` finds them: tracked by the store's index, or new and not ignored. */
function candidateFiles(top: string): string[] {
  const result = spawnSync('git', guarded(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']), {
    cwd: top, encoding: 'utf8', env: repoProgramEnv(), maxBuffer: 32 * 1024 * 1024, timeout: 60_000
  })
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code
  // A listing that does not fit, or does not end in a minute, is a folder past the limit.
  if (code === 'ENOBUFS' || code === 'ETIMEDOUT') throw new SnapshotRefusedError(`Undo is off for this folder because it is too large (more than ${limits.files.toLocaleString('en-US')} files).`)
  if (result.error || result.status !== 0) throw new Error((result.stderr ?? '').trim() || 'git ls-files failed')
  return result.stdout.split('\0').filter(Boolean)
}

/**
 * Refuses a hidden store's folder that is a home or system folder, or past a limit, before anything is added to the
 * store. The walk is the one `git add -A` makes next, so Git's own ignore rules decide what counts.
 */
function assertSnapshotable(top: string): void {
  if (isUnsafeSnapshotRoot(top)) throw new SnapshotRefusedError(UNSAFE_ROOT)
  const files = candidateFiles(top)
  if (files.length > limits.files) throw new SnapshotRefusedError(`Undo is off for this folder because it is too large (more than ${limits.files.toLocaleString('en-US')} files).`)
  let total = 0
  for (const path of files) {
    let size: number
    try {
      const info = lstatSync(join(top, path))
      // A directory here is a nested repository, kept as a link and not read.
      if (!info.isFile()) continue
      size = info.size
    } catch { continue }
    if (size > limits.fileBytes) throw new SnapshotRefusedError(`Undo is off for this folder because it is too large (${path} is over ${sizeText(limits.fileBytes)}).`)
    total += size
    if (total > limits.bytes) throw new SnapshotRefusedError(`Undo is off for this folder because it is too large (more than ${sizeText(limits.bytes)}).`)
  }
}

function privateFiles(top: string): { directory: string; index: string; last: string } {
  const store = activeHiddenStore(top)
  if (store) {
    // The store has no worktree index of anyone's, so its own is the persistent one: `git diff` against the folder reads it.
    const directory = join(store.gitDir, 'mousse')
    mkdirSync(directory, { recursive: true })
    return { directory, index: join(store.gitDir, 'index'), last: join(directory, 'snapshot-last.json') }
  }
  // `--git-path` keeps names Git doesn't know in the worktree's own Git directory, so each linked worktree has its own.
  const directory = resolve(top, git(top, ['rev-parse', '--git-path', 'mousse']))
  mkdirSync(directory, { recursive: true })
  return { directory, index: join(directory, 'snapshot-index'), last: join(directory, 'snapshot-last.json') }
}

function headOf(top: string): string | undefined {
  // A hidden store has no HEAD, whatever the folder's own repository says.
  if (activeHiddenStore(top)) return undefined
  return tryGit(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).stdout || undefined
}

/**
 * Repositories inside the worktree that have no commit yet (an agent ran `git init` or a project generator there).
 * `git add` records a nested repository as a link to its HEAD, so it cannot add one with none, and the whole snapshot
 * would fail. A snapshot leaves them out instead, as it leaves out the files of every nested repository. Looked for
 * only after an add failed, so a worktree without one is walked once.
 */
function nestedRepositoriesWithoutCommit(top: string, env: NodeJS.ProcessEnv): string[] {
  // Git lists a nested repository it would add as one entry ending in a slash.
  const untracked = git(top, ['ls-files', '-z', '--others', '--exclude-standard'], env).split('\0')
  return untracked.filter((path) => path.endsWith('/')).map((path) => path.slice(0, -1)).filter((path) =>
    spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: join(top, path), env: repoProgramEnv(), stdio: 'ignore' }).status !== 0)
}

/**
 * The tree of every file in the worktree, from the persistent private index. The index stays between snapshots so
 * Git's stat cache keeps the next one fast; a missing, locked or corrupt one is rebuilt from HEAD.
 */
function indexTree(top: string, index: string, head: string | undefined): string {
  const hidden = activeHiddenStore(top) !== undefined
  if (hidden) assertSnapshotable(top)
  const env = { GIT_INDEX_FILE: index }
  // The store's exclude list already leaves `.mousse/` out, and Git refuses an exclusion that names an ignored path.
  const add = (skipped: string[]) => git(top, ['add', '-A', '--', '.', ...(hidden ? [] : [NOT_MOUSSE]), ...skipped.map((path) => `:(exclude,literal)${path}`)], env)
  const attempt = (): string => {
    if (!existsSync(index)) git(top, head ? ['read-tree', head] : ['read-tree', '--empty'], env)
    try {
      add([])
    } catch (error) {
      const skipped = nestedRepositoriesWithoutCommit(top, env)
      if (!skipped.length) throw error
      add(skipped)
    }
    // A `.gitignore` of the folder's that takes `.mousse/` back in is answered by dropping it from the index.
    if (hidden && existsSync(join(top, '.mousse'))) git(top, ['rm', '-r', '--cached', '--ignore-unmatch', '-q', '--', '.mousse'], env)
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
  const hidden = activeHiddenStore(top) !== undefined
  const branch = hidden ? undefined : tryGit(top, ['branch', '--show-current']).stdout || undefined
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

/** The ref that remembers the thread's files as last published into the primary checkout: the next publish brings in only what came after. */
export function publishedRef(threadId: string): string {
  return `refs/mousse/published/${threadId}`
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
