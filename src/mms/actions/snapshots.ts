import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'
import type { GitRecord } from '../../shared/threadActions'
import { activeHiddenStore, builtInPathspecs, ensureStoreRules, outsideHiddenStore } from '../git/hiddenStore'
import { git, gitEnv, guarded, mergeTrees, MOUSSE_COMMIT_ENV, NOT_MOUSSE, operationInProgress, tryGit, treeOf } from './git'

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
    // The nested repository's own Git, never a hidden store whose folder holds it.
    .filter((path) => { const status = outsideHiddenStore(() => tryGit(join(top, path), ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'])); return !status.ok || status.stdout !== '' })
    .map((path) => ({ path, reason: NESTED_COMMIT_ONLY }))
}

export interface SnapshotInput {
  /** Why it was taken, for the commit message: "turn end", "outside changes". One line. */
  reason: string
  threadId?: string
  operationId?: string
}

const SUBJECT = 'mousse snapshot: '

interface LastSnapshot { sha: string; tree: string; head?: string; uncovered?: string }

/**
 * What a snapshot did not cover, kept with it (a `Mousse-Uncovered:` line of its commit): its coverage gaps, and the
 * ignored files and folders that were there (collapsed to their folder, at most `IGNORED_RECORDED`). A restore reads it
 * so it never deletes or writes over what was there but not recorded. `truncated`: more were ignored than recorded.
 */
export interface Uncovered { gaps: CoverageGap[]; ignored: string[]; truncated: boolean }

const UNCOVERED_LINE = 'Mousse-Uncovered: '
const IGNORED_RECORDED = 2000

/** The ignored files and folders in the folder now, collapsed to their folder; never `.mousse`. */
function ignoredNow(top: string): { ignored: string[]; truncated: boolean } {
  const listed = tryGit(top, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
  if (!listed.ok) return { ignored: [], truncated: true }
  const all = listed.stdout.split('\0').filter((path) => path && path !== '.mousse/' && !path.startsWith('.mousse/'))
  return { ignored: all.slice(0, IGNORED_RECORDED), truncated: all.length > IGNORED_RECORDED }
}

/** The record of what `sha` did not cover, or undefined for a snapshot taken before snapshots kept one. */
export function snapshotUncovered(top: string, sha: string): Uncovered | undefined {
  const commit = tryGit(top, ['cat-file', 'commit', sha])
  if (!commit.ok) return undefined
  const line = commit.stdout.split('\n').find((entry) => entry.startsWith(UNCOVERED_LINE))
  if (!line) return undefined
  try {
    const value = JSON.parse(line.slice(UNCOVERED_LINE.length)) as { g?: CoverageGap[]; i?: string[]; t?: boolean }
    return { gaps: Array.isArray(value.g) ? value.g : [], ignored: Array.isArray(value.i) ? value.i : [], truncated: value.t === true }
  } catch {
    return undefined
  }
}

/** The reason `path` was not covered in `record`, or undefined when the record covers it. */
function uncoveredReason(record: Uncovered, path: string): string | undefined {
  const within = (root: string): boolean => root === '.' || path === root || path.startsWith(`${root.replace(/\/$/, '')}/`)
  const gap = record.gaps.find((entry) => within(entry.path))
  if (gap) return gap.reason
  return record.ignored.some((entry) => entry.endsWith('/') ? within(entry) : entry === path) ? 'ignored' : undefined
}

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

  /** The reason as a coverage gap names it: "too large (more than 1 GB)". */
  get gapReason(): string {
    return this.message.replace(/^Undo is off for this folder because it is /, '').replace(/\.$/, '')
  }
}

function canonicalPath(path: string): string {
  const resolved = resolve(path)
  try { return realpathSync.native(resolved) } catch { return resolved }
}

/** System folders a snapshot never holds, nor anything inside them. */
const SYSTEM_FOLDERS = process.platform === 'win32'
  ? [process.env.SystemRoot ?? 'C:\\Windows', process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', process.env.ProgramData ?? 'C:\\ProgramData']
  : ['/etc', '/usr', '/bin', '/sbin', '/System', '/Library']

/**
 * A folder that must never be snapshotted: the filesystem root, the home folder or a folder that holds it, or a system
 * folder (`/etc`, `/usr`, `/System`, `/Library`, `C:\\Windows`, `C:\\Program Files`, `C:\\ProgramData`) or a folder in one.
 * A project there would put someone's whole account, or the system, in a store.
 */
export function isUnsafeSnapshotRoot(path: string, home = homedir()): boolean {
  const target = canonicalPath(path)
  if (target === parse(target).root) return true
  const user = canonicalPath(home)
  if (user === target || user.startsWith(target.endsWith(sep) ? target : `${target}${sep}`)) return true
  const fold = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  return SYSTEM_FOLDERS.map(canonicalPath).some((system) => fold(target) === fold(system) || fold(target).startsWith(fold(system.endsWith(sep) ? system : `${system}${sep}`)))
}

const UNSAFE_ROOT = 'Undo is off for this folder because it is a home or system folder.'

function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Math.round(bytes / 1024 ** 3)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`
}

/** The files a snapshot would hold, as `git add -A` finds them: tracked by the store's index, or new and not ignored. */
function candidateFiles(top: string): string[] {
  const result = spawnSync('git', guarded(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.', ...builtInPathspecs().exclude]), {
    cwd: top, encoding: 'utf8', env: gitEnv(top), maxBuffer: 32 * 1024 * 1024, timeout: 60_000
  })
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code
  // A listing that does not fit, or does not end in a minute, is a folder past the limit.
  if (code === 'ENOBUFS' || code === 'ETIMEDOUT') throw new SnapshotRefusedError(`Undo is off for this folder because it is too large (more than ${limits.files.toLocaleString('en-US')} files).`)
  if (result.error || result.status !== 0) throw new Error((result.stderr ?? '').trim() || 'git ls-files failed')
  return result.stdout.split('\0').filter(Boolean)
}

/** Built-in exclusions that are not worth naming: Git's and Mousse's own folders, and caches. */
const UNNAMED_EXCLUSIONS = new Set(['.git', '.mousse', '.DS_Store', '__pycache__'])
const LEFT_OUT_BY_MOUSSE = 'dependency or build folder, never kept in snapshots'

/**
 * The folders of the built-in list that are in the folder, read after they were taken out of the store's index: what
 * the snapshot does not hold, whatever the folder's `.gitignore` says. Only the store's exclude file is read, so a
 * `!pattern` of the folder's does not hide one.
 */
function excludedFolders(top: string, gitDir: string): CoverageGap[] {
  const exclude = join(gitDir, 'info', 'exclude')
  const listed = existsSync(exclude)
    ? tryGit(top, ['ls-files', '-z', '--others', '--ignored', '--directory', `--exclude-from=${exclude}`])
    : { ok: true, stdout: '' }
  return (listed.ok ? listed.stdout.split('\0').filter(Boolean) : [])
    .map((path) => path.replace(/\/$/, ''))
    .filter((path) => !UNNAMED_EXCLUSIONS.has(path.split('/').at(-1)!))
    .map((path) => ({ path, reason: LEFT_OUT_BY_MOUSSE }))
}

/**
 * The files over the size limit a hidden store leaves out of a snapshot of its folder (kept out of the store's index).
 * A home or system folder, or one past the file count or total size, cannot be snapshotted at all and is refused. The
 * walk is the one `git add -A` makes next, so Git's own ignore rules and the built-in list decide what counts.
 */
function hiddenStoreCoverage(top: string): { leftOut: CoverageGap[] } {
  if (isUnsafeSnapshotRoot(top)) throw new SnapshotRefusedError(UNSAFE_ROOT)
  const files = candidateFiles(top)
  if (files.length > limits.files) throw new SnapshotRefusedError(`Undo is off for this folder because it is too large (more than ${limits.files.toLocaleString('en-US')} files).`)
  const leftOut: CoverageGap[] = []
  let total = 0
  for (const path of files) {
    let size: number
    try {
      const info = lstatSync(join(top, path))
      // A directory here is a nested repository, kept as a link and not read.
      if (!info.isFile()) continue
      size = info.size
    } catch { continue }
    if (size > limits.fileBytes) {
      leftOut.push({ path, reason: `over ${sizeText(limits.fileBytes)}` })
      continue
    }
    total += size
    if (total > limits.bytes) throw new SnapshotRefusedError(`Undo is off for this folder because it is too large (more than ${sizeText(limits.bytes)}).`)
  }
  return { leftOut }
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
    !outsideHiddenStore(() => tryGit(join(top, path), ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).ok))
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
  // A hidden store first leaves out what it does not keep (files over the size limit) and refuses a folder it cannot
  // snapshot at all; what it leaves out is named with the rest.
  const store = activeHiddenStore(top)
  // Under the store's mutation lock: its exclude list and attributes are current before anything is added.
  if (store) ensureStoreRules(store)
  const hidden = store ? hiddenStoreCoverage(top) : undefined
  const env = { GIT_INDEX_FILE: index }
  // The store's exclude list already leaves `.mousse/` out, and Git refuses an exclusion that names an ignored path.
  const addAll = (left: CoverageGap[]) => tryGit(top, ['add', '-A', '--', '.', ...(hidden ? [] : [NOT_MOUSSE]), ...left.map((gap) => `:(exclude,literal)${gap.path}`)], env)
  const indexOnce = (): { tree: string; gaps: CoverageGap[] } => {
    if (!existsSync(index)) git(top, head ? ['read-tree', head] : ['read-tree', '--empty'], env)
    // What can be read is recorded; what cannot (an unreadable file or folder, a nested repository with no commit) is
    // left out and named. Git stops at the first file it cannot read, so each one found is left out and it runs again.
    const gaps: CoverageGap[] = [...(hidden?.leftOut ?? [])]
    // A file left out must not stay in the store's index from an earlier snapshot: Undo would restore that old copy.
    if (hidden?.leftOut.length) gitWithPaths(top, ['rm', '-q', '--cached', '--ignore-unmatch'], hidden.leftOut.map((gap) => gap.path), env)
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
    if (hidden) {
      // The built-in list holds whatever the folder's `.gitignore` takes back in (`!node_modules/`): what is under it
      // leaves the index here. A hidden store has no HEAD and no index of anyone's to follow.
      git(top, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...builtInPathspecs().match], env)
      gaps.push(...nestedWithChanges(top, env, gaps))
      return { tree: git(top, ['write-tree'], env), gaps: [...gaps, ...excludedFolders(top, store!.gitDir)] }
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
  const hidden = activeHiddenStore(top) !== undefined
  const branch = hidden ? undefined : tryGit(top, ['branch', '--show-current']).stdout || undefined
  const operation = operationInProgress(top)
  const state = { tree, ...(head ? { head } : {}), ...(branch ? { branch } : {}), ...(operation ? { operationInProgress: operation } : {}), ...(coverageGaps.length ? { coverageGaps } : {}) }
  const { ignored, truncated } = ignoredNow(top)
  const uncovered = JSON.stringify({ g: coverageGaps, i: ignored, ...(truncated ? { t: true } : {}) })
  const previous = readLast(files.last)
  // Reused only when what it left out is the same too: a restore reads that from the snapshot.
  if (previous && previous.tree === tree && previous.head === head && previous.uncovered === uncovered && tryGit(top, ['cat-file', '-e', `${previous.sha}^{commit}`]).ok) return { sha: previous.sha, ...state }
  const trailers = [
    input.threadId ? `Mousse-Thread: ${input.threadId}` : '', input.operationId ? `Mousse-Operation: ${input.operationId}` : '',
    head ? `Mousse-Head: ${head}` : '', branch ? `Mousse-Branch: ${branch}` : '',
    // Only when something was not covered: no record and an empty one mean the same to a restore.
    coverageGaps.length || ignored.length || truncated ? `${UNCOVERED_LINE}${uncovered}` : ''
  ].filter(Boolean).join('\n')
  const subject = `${SUBJECT}${input.reason.split(/\r?\n/)[0]!.trim()}`
  const sha = git(top, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', subject, ...(trailers ? ['-m', trailers] : [])], MOUSSE_COMMIT_ENV)
  writeFileSync(files.last, JSON.stringify({ sha, tree, ...(head ? { head } : {}), uncovered } satisfies LastSnapshot))
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

/** A path a restore left as it is because it was not covered on one side, and why. */
export interface LeftAsIs { path: string; reason: string }

export type RestoreResult = { snapshot: Snapshot; tree: string; preserved?: PreservedFiles; leftAsIs?: LeftAsIs[] } | { conflicts: string[] }

/** The line a result carries for the paths a restore left as they are. */
export function leftAsIsNotice(left: LeftAsIs[] | undefined): string | undefined {
  if (!left?.length) return undefined
  const named = left.slice(0, 10).map((entry) => `${entry.path} (${entry.reason})`).join(', ')
  return `Left as it is: ${named}${left.length > 10 ? ` and ${left.length - 10} more` : ''}.`
}

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
  /** Where `theirs` is, in words for the result: "at the start of the turn". */
  restoredTo?: string
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
  const ours = treeOf(top, input.ours)
  const { tree, leftAsIs } = leaveUncovered(top, input, ours, merged.tree)
  // Checked before the intent is recorded: a folder that cannot be kept refuses the restore with nothing pending.
  uncapturedInTheWay(top, ours, tree)
  planned?.(tree)
  const preserved = moveFiles(top, ours, tree, input.operationId)
  return { snapshot: takeSnapshot(top, input), tree, ...(preserved ? { preserved } : {}), ...(leftAsIs.length ? { leftAsIs } : {}) }
}

/**
 * The merge's tree with every path the restore must not touch put back as it is now: a path not covered on the side
 * being restored to (left out, unreadable or ignored there, so its absence there says nothing), a path that would be
 * deleted when the record of that side is incomplete, and a file not covered now (over the size limit) that the
 * restore would write over. Those stay on disk as they are and are named. A snapshot with no record (taken before
 * snapshots kept one) changes nothing here.
 */
function leaveUncovered(top: string, input: RestoreChangeInput, ours: string, merged: string): { tree: string; leftAsIs: LeftAsIs[] } {
  const target = snapshotUncovered(top, input.theirs)
  const now = snapshotUncovered(top, input.ours)
  if (!target && !now) return { tree: merged, leftAsIs: [] }
  const where = input.restoredTo ?? 'in the version restored'
  const changes = git(top, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', ours, merged]).split('\0').filter(Boolean)
  const leftAsIs: LeftAsIs[] = []
  for (let index = 0; index + 1 < changes.length; index += 2) {
    const status = changes[index]!
    const path = changes[index + 1]!
    const there = target ? uncoveredReason(target, path) : undefined
    const current = now?.gaps.length ? uncoveredReason({ ...now, ignored: [] }, path) : undefined
    if (there) leftAsIs.push({ path, reason: `not covered ${where}` })
    else if (target?.truncated && status === 'D') leftAsIs.push({ path, reason: `not known whether it was there ${where}` })
    else if (current && existsSync(join(top, path))) leftAsIs.push({ path, reason: `not covered now: ${current}` })
  }
  if (!leftAsIs.length) return { tree: merged, leftAsIs }
  // The kept paths take their entry from `ours` (or none), through a temporary index: nothing on disk changes here.
  const temporary = join(privateFiles(top).directory, `leave-${randomUUID()}.index`)
  const env = { GIT_INDEX_FILE: temporary }
  try {
    git(top, ['read-tree', merged], env)
    const kept = new Map(git(top, ['ls-tree', '-r', '-z', ours, '--', ...leftAsIs.map((entry) => entry.path)]).split('\0').filter(Boolean)
      .map((line) => { const tab = line.indexOf('\t'); const [mode, , sha] = line.slice(0, tab).split(' '); return [line.slice(tab + 1), `${mode} ${sha}`] as const }))
    const lines = leftAsIs.map((entry) => `${kept.get(entry.path) ?? `0 ${'0'.repeat(merged.length)}`}\t${entry.path}`)
    git(top, ['update-index', '--index-info'], env, lines.join('\n') + '\n')
    return { tree: git(top, ['write-tree'], env), leftAsIs }
  } catch (error) {
    throw new Error(`The restore would change ${leftAsIs[0]!.path}, which was not recorded, and cannot leave it as it is. Nothing was changed.`, { cause: error })
  } finally {
    rmSync(temporary, { force: true })
  }
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
