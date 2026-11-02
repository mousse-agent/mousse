import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
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
  /** What is in the worktree but not in the snapshot, and why. Reported, never a reason to fail the snapshot. */
  coverageGaps?: CoverageGap[]
}

export interface CoverageGap { path: string; reason: string }

/** The words for what a snapshot left out, or undefined when it covers everything. Ignored files are left out by design and never listed. */
export function coverageNotice(...lists: Array<CoverageGap[] | undefined>): string | undefined {
  const gaps = [...new Map(lists.flatMap((list) => list ?? []).map((gap) => [`${gap.path}\0${gap.reason}`, gap])).values()]
  if (!gaps.length) return undefined
  const named = gaps.slice(0, 10).map((gap) => `${gap.path} (${gap.reason})`).join(', ')
  return `Not covered: ${named}${gaps.length > 10 ? ` and ${gaps.length - 10} more` : ''}.`
}
const NESTED_WITHOUT_COMMIT = 'nested repository with no commits'
const UNREADABLE = 'unreadable'
const NESTED_COMMIT_ONLY = 'nested repository; only its commit is recorded'

/**
 * Nested repositories (and submodules) the snapshot records as a link to their commit, whose own files differ from
 * it: uncommitted or untracked changes in them are not in the snapshot. A clean one is fully covered by its commit.
 * The check never refreshes the nested repository's index.
 */
function nestedWithChanges(top: string, env: NodeJS.ProcessEnv, skip: CoverageGap[]): CoverageGap[] {
  const links = git(top, ['ls-files', '-s', '-z'], env).split('\0').filter((line) => line.startsWith('160000 ')).map((line) => line.slice(line.indexOf('\t') + 1))
  return links.filter((path) => !skip.some((gap) => gap.path === path) && existsSync(join(top, path, '.git')))
    .filter((path) => { const status = tryGit(join(top, path), ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']); return !status.ok || status.stdout !== '' })
    .map((path) => ({ path, reason: NESTED_COMMIT_ONLY }))
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
 * Repositories inside the worktree that have no commit yet (an agent ran `git init` or a project generator there).
 * `git add` records a nested repository as a link to its HEAD, so it cannot add one with none, and the whole snapshot
 * would fail. A snapshot leaves them out instead, as it leaves out the files of every nested repository. Looked for
 * only after an add failed, so a worktree without one is walked once.
 */
function nestedRepositoriesWithoutCommit(top: string, env: NodeJS.ProcessEnv): string[] {
  // Git lists a nested repository it would add as one entry ending in a slash.
  const untracked = git(top, ['ls-files', '-z', '--others', '--exclude-standard'], env).split('\0')
  return untracked.filter((path) => path.endsWith('/')).map((path) => path.slice(0, -1)).filter((path) =>
    !tryGit(join(top, path), ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).ok)
}

const nul = (text: string): string[] => text.split('\0').filter(Boolean)
const literal = (paths: string[]): string[] => paths.map((path) => `:(literal)${path}`)
const ownPath = (path: string): boolean => path !== '.mousse' && !path.startsWith('.mousse/')

/** Git with the paths on standard input, for path lists too long for the command line. */
function gitWithPaths(top: string, args: string[], paths: string[], env?: NodeJS.ProcessEnv): string {
  return git(top, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], env, literal(paths).join('\0') + '\0')
}

/**
 * Makes the private index follow the files Git tracks, for the ones `add -A` cannot see: ignored files. A file that is
 * ignored but tracked by HEAD or by the real index (force-added) is in the snapshot whenever it is on disk, and an
 * ignored file that neither tracks any more leaves it. Reads HEAD and the real index; writes only the private index.
 */
function followTrackedFiles(top: string, env: NodeJS.ProcessEnv, head: string | undefined, skip: string[] = []): void {
  // HEAD's paths the private index lacks (it was seeded from an older HEAD), and the real index's ignored entries.
  const fromHead = head ? nul(git(top, ['diff-index', '--cached', '--no-renames', '--diff-filter=D', '--name-only', '-z', head], env)) : []
  const fromIndex = nul(git(top, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard']))
  const left = (path: string) => skip.some((gap) => path === gap || path.startsWith(`${gap}/`))
  const missing = [...new Set([...fromHead, ...fromIndex])].filter((path) => ownPath(path) && !left(path) && existsSync(join(top, path)))
  if (missing.length) gitWithPaths(top, ['add', '-f'], missing, env)
  const ignored = nul(git(top, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], env))
  if (!ignored.length) return
  // Rare: an ignored file stays in the private index after HEAD and the real index stopped tracking it.
  const tracked = new Set(nul(git(top, ['ls-files', '-z', '--cached', '--', ...literal(ignored)])))
  if (head) for (const path of nul(git(top, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', head, '--', ...ignored]))) tracked.add(path)
  const untracked = ignored.filter((path) => !tracked.has(path))
  if (untracked.length) gitWithPaths(top, ['rm', '-q', '--cached', '--ignore-unmatch'], untracked, env)
}

/**
 * The tree of every file in the worktree, from the persistent private index. The index stays between snapshots so
 * Git's stat cache keeps the next one fast; a missing, locked or corrupt one is rebuilt from HEAD. Every snapshot also
 * brings it in line with the files HEAD and the real index track (`followTrackedFiles`), so a file that is ignored but
 * was force-added and committed later is in it.
 */
function indexTree(top: string, index: string, head: string | undefined): { tree: string; gaps: CoverageGap[] } {
  const env = { GIT_INDEX_FILE: index }
  const addAll = (left: CoverageGap[]) => tryGit(top, ['add', '-A', '--', '.', NOT_MOUSSE, ...left.map((gap) => `:(exclude,literal)${gap.path}`)], env)
  const indexOnce = (): { tree: string; gaps: CoverageGap[] } => {
    if (!existsSync(index)) git(top, head ? ['read-tree', head] : ['read-tree', '--empty'], env)
    // What can be read is recorded; what cannot (an unreadable file or folder, a nested repository with no commit) is
    // left out and named. Git stops at the first file it cannot read, so each one found is left out and it runs again.
    const gaps: CoverageGap[] = []
    let nestedChecked = false
    for (let round = 0; ; round++) {
      const result = addAll(gaps)
      for (const match of result.stderr.matchAll(/could not open directory '([^']+?)\/?': Permission denied/g)) {
        if (!gaps.some((gap) => gap.path === match[1])) gaps.push({ path: match[1]!, reason: UNREADABLE })
      }
      if (result.ok) break
      const found = [...result.stderr.matchAll(/unable to index file '([^']+)'/g)].map((match) => match[1]!).filter((path) => !gaps.some((gap) => gap.path === path))
      if (!found.length && !nestedChecked) {
        nestedChecked = true
        const nested = nestedRepositoriesWithoutCommit(top, env).filter((path) => !gaps.some((gap) => gap.path === path))
        for (const path of nested) gaps.push({ path, reason: NESTED_WITHOUT_COMMIT })
        if (nested.length) continue
      }
      if (!found.length || round >= 200) throw new Error(result.stderr || 'git add failed')
      for (const path of found) gaps.push({ path, reason: UNREADABLE })
    }
    followTrackedFiles(top, env, head, gaps.map((gap) => gap.path))
    gaps.push(...nestedWithChanges(top, env, gaps))
    return { tree: git(top, ['write-tree'], env), gaps }
  }
  try {
    return indexOnce()
  } catch {
    // The caller holds the mutation locks, so a lock file left by a crash is nobody's.
    rmSync(index, { force: true })
    rmSync(`${index}.lock`, { force: true })
    return indexOnce()
  }
}

/** The tree of the worktree's files right now, without writing a commit. */
export function worktreeTree(cwd: string): string {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  return indexTree(top, privateFiles(top).index, headOf(top)).tree
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
  const { tree, gaps: coverageGaps } = indexTree(top, files.index, head)
  const branch = tryGit(top, ['branch', '--show-current']).stdout || undefined
  const operation = operationInProgress(top)
  const state = { tree, ...(head ? { head } : {}), ...(branch ? { branch } : {}), ...(operation ? { operationInProgress: operation } : {}), ...(coverageGaps.length ? { coverageGaps } : {}) }
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
    rewroteHistory, ...(after.operationInProgress ? { operationInProgress: after.operationInProgress } : {}),
    ...(after.coverageGaps?.length ? { coverageGaps: after.coverageGaps } : {})
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

/** Files a restore was about to overwrite or delete that no snapshot held (ignored, for example), kept first under `ref`. */
export interface PreservedFiles { ref: string; paths: string[] }

export type RestoreResult = { snapshot: Snapshot; tree: string; preserved?: PreservedFiles } | { conflicts: string[] }

/** The line a result carries when a restore kept files no snapshot held before writing over them. */
export function preservedNotice(preserved: PreservedFiles): string {
  const named = preserved.paths.slice(0, 10).join(', ') + (preserved.paths.length > 10 ? ` and ${preserved.paths.length - 10} more` : '')
  return `Files no snapshot held were in the way and are kept under ${preserved.ref}: ${named}. Bring one back with git restore --source=${preserved.ref} -- <path>.`
}

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
  // Checked before the intent is recorded: a folder that cannot be kept refuses the restore with nothing pending.
  uncapturedInTheWay(top, treeOf(top, input.ours), merged.tree)
  planned?.(merged.tree)
  const preserved = moveFiles(top, treeOf(top, input.ours), merged.tree, input.operationId)
  return { snapshot: takeSnapshot(top, input), tree: merged.tree, ...(preserved ? { preserved } : {}) }
}

/**
 * Files on disk at the paths a move from `from` to `to` writes or deletes that `from` does not hold: an ignored or
 * excluded file, or what fills a folder where `to` puts a file. These are bytes no snapshot has.
 */
function uncapturedInTheWay(top: string, from: string, to: string): string[] {
  const touched = git(top, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', from, to]).split('\0').filter(Boolean)
  if (!touched.length) return []
  const held = new Set(git(top, ['ls-tree', '-r', '-z', '--name-only', from]).split('\0').filter(Boolean))
  // A nested repository recorded by its commit (a gitlink) is never written into: Git only changes the link.
  const links = new Set([from, to].flatMap((tree) => git(top, ['ls-tree', '-r', '-z', tree]).split('\0').filter((line) => line.startsWith('160000 ')).map((line) => line.slice(line.indexOf('\t') + 1))))
  const found = new Set<string>()
  // A folder too big or too deep to list, or another repository, cannot be kept file by file: the restore is refused
  // before anything is written, naming it, instead of going on with part of it unkept.
  const tooMuch = (path: string): never => { throw new RestoreInTheWayError(path) }
  const visit = (root: string, path: string, depth = 0): void => {
    if (links.has(path)) return
    if (depth > PRESERVE_LIMITS.depth || found.size >= PRESERVE_LIMITS.files) tooMuch(root)
    let stat
    try { stat = lstatSync(join(top, path)) } catch { return }
    if (stat.isDirectory()) {
      if (path === '.mousse') return
      if (path === '.git' || path.endsWith('/.git')) tooMuch(root)
      for (const name of readdirSync(join(top, path))) visit(root, `${path}/${name}`, depth + 1)
    } else if (!held.has(path)) found.add(path)
  }
  for (const path of touched) {
    const parts = path.split('/')
    // A file where `to` needs a folder above the path.
    for (let depth = 1; depth < parts.length; depth++) {
      const above = parts.slice(0, depth).join('/')
      try { if (!lstatSync(join(top, above)).isDirectory() && !held.has(above)) found.add(above) } catch { break }
    }
    visit(path, path)
  }
  return [...found].sort()
}

/** How much a restore keeps file by file before it refuses instead (`uncapturedInTheWay`). Lowered by tests. */
export const PRESERVE_LIMITS = { files: 10_000, depth: 64 }

/** A restore would write over a folder that is too large to keep first, or holds another repository. Nothing was changed. */
export class RestoreInTheWayError extends Error {
  constructor(readonly path: string) {
    super(`The restore would write over ${path}, which holds files no snapshot has and is too large to keep first (or is another repository). Nothing was changed. Move ${path} aside, then try again.`)
    this.name = 'RestoreInTheWayError'
  }
}

/** Stores files as one commit under a new `refs/mousse/preserved/` ref, through a temporary index. Reads them only. */
function preserveFiles(top: string, paths: string[], directory: string, operationId?: string): PreservedFiles {
  const temporary = join(directory, `preserve-${randomUUID()}.index`)
  const env = { GIT_INDEX_FILE: temporary }
  try {
    git(top, ['read-tree', '--empty'], env)
    const entries = paths.map((path) => {
      const absolute = join(top, path)
      const link = lstatSync(absolute).isSymbolicLink()
      const sha = link ? git(top, ['hash-object', '-w', '--stdin'], undefined, readlinkSync(absolute)) : git(top, ['hash-object', '-w', '--no-filters', '--', path])
      const mode = link ? '120000' : (lstatSync(absolute).mode & 0o111) ? '100755' : '100644'
      return `${mode} ${sha}\t${path}`
    })
    git(top, ['update-index', '--index-info'], env, entries.join('\n') + '\n')
    const tree = git(top, ['write-tree'], env)
    const head = headOf(top)
    const sha = git(top, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `${SUBJECT}files kept before a restore`], MOUSSE_COMMIT_ENV)
    const ref = `refs/mousse/preserved/${operationId ?? randomUUID()}-${sha.slice(0, 12)}`
    git(top, ['update-ref', '--no-deref', ref, sha])
    return { ref, paths }
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * Rewrites the files that differ between two trees from the first (what the worktree holds, as of the last snapshot)
 * to the second, through a temporary private index. A file that changed since the snapshot makes Git refuse
 * before anything is written. A file in the way that `from` does not hold (ignored, excluded, or inside a folder
 * that becomes a file) is no snapshot's, so it is kept under a `refs/mousse/preserved/` ref first and returned.
 */
export function moveFiles(top: string, from: string, to: string, operationId?: string): PreservedFiles | undefined {
  if (from === to) return undefined
  const files = privateFiles(top)
  const inTheWay = uncapturedInTheWay(top, from, to)
  const preserved = inTheWay.length ? preserveFiles(top, inTheWay, files.directory, operationId) : undefined
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
  return preserved
}
