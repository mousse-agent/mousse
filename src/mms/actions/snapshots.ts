import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, type Stats } from 'node:fs'
import { lstat, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'
import type { GitRecord, ThreadAction } from '../../shared/threadActions'
import { activeHiddenStore, builtInPathspecs, ensureStoreRules, outsideHiddenStore } from '../git/hiddenStore'
import { gitAsync, gitEnv, gitStep, ownGitRunner, guarded, guardedAsync, LISTING, mergeTreesSteps, MOUSSE_COMMIT_ENV, mousseCommitEnvNow, NOT_MOUSSE, operationInProgressSteps, runGitProcess, tryGit, tryGitAsync, tryGitStep, treeOfSteps } from './git'
import type { FrozenEntryProof } from '../lifecycle/verifiedDelete'
import { readConvertedAsync } from './heldBytes'
import { createOnlyAsync, removeProvenAsync } from './provenDiscard'
import { keepCopy } from './keptCopies'
import { restoreCommandsText, restoreFileCommand, restoreKindOf, restoreShell, type RestoreKind, type RestoreShell } from './restoreCommands'
import { files as disk, runAsync, step, type Steps } from './steps'
import { retentionWindowText } from '../../shared/undoRetention'

/**
 * Workspace snapshots (docs/workspace-snapshots.md): a commit whose tree is every file of a worktree (tracked and
 * untracked, never ignored files or `.mousse/`), built with a private index so that HEAD, the branches, the real
 * index and the files are never touched. Its parent is the worktree's HEAD, so it is reachable from nowhere until a
 * ref under `refs/mousse/` pins it.
 *
 * A folder with no Git Mousse may use has its snapshots in a hidden store instead (`inHiddenStore`): the same
 * commands run with `--git-dir` and `--work-tree`, the store's own index is the persistent one, and a snapshot has no
 * parent because there is no HEAD.
 *
 * Everything here that reads or writes the folder is written as steps (`steps.ts`): each exported function has a
 * synchronous form and an `...Async` form that never blocks the daemon, and both run the same Git commands in the
 * same order. Mousse's actions use the async forms.
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
function* nestedWithChanges(top: string, env: NodeJS.ProcessEnv, skip: CoverageGap[]): Steps<CoverageGap[]> {
  const links = (yield* gitStep(top, ['ls-files', '-s', '-z'], env, undefined, LISTING)).split('\0').filter((line) => line.startsWith('160000 ')).map((line) => line.slice(line.indexOf('\t') + 1))
  const present: string[] = []
  for (const path of links) if (!skip.some((gap) => gap.path === path) && (yield* disk.exists(join(top, path, '.git')))) present.push(path)
  const changed: CoverageGap[] = []
  for (const path of present) {
    // The nested repository's own Git, never a hidden store whose folder holds it.
    const status = yield* outsideStore(join(top, path), ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'])
    if (!status.ok || status.stdout !== '') changed.push({ path, reason: NESTED_COMMIT_ONLY })
  }
  return changed
}

/** `tryGit` in a repository nested in a store's folder: its own Git, never the store. */
function outsideStore(cwd: string, args: string[]): Steps<{ ok: boolean; stdout: string; stderr: string }> {
  return step(() => outsideHiddenStore(() => tryGit(cwd, args)), () => outsideHiddenStore(() => tryGitAsync(cwd, args)))
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
function* ignoredNow(top: string): Steps<{ ignored: string[]; truncated: boolean }> {
  const listed = yield* tryGitStep(top, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], undefined, LISTING)
  if (!listed.ok) return { ignored: [], truncated: true }
  const all = listed.stdout.split('\0').filter((path) => path && path !== '.mousse/' && !path.startsWith('.mousse/'))
  return { ignored: all.slice(0, IGNORED_RECORDED), truncated: all.length > IGNORED_RECORDED }
}

/** The record of what `sha` did not cover, or undefined for a snapshot taken before snapshots kept one. */
export function* snapshotUncoveredSteps(top: string, sha: string): Steps<Uncovered | undefined> {
  const commit = yield* tryGitStep(top, ['cat-file', 'commit', sha], undefined, LISTING)
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


export function snapshotUncoveredAsync(top: string, sha: string): Promise<Uncovered | undefined> {
  return runAsync(snapshotUncoveredSteps(top, sha))
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

function* canonicalPath(path: string): Steps<string> {
  const resolved = resolve(path)
  try { return yield* disk.realpathNative(resolved) } catch { return resolved }
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

/** Whether `path` is a folder a snapshot must never hold (see `unsafeSnapshotRoot`). Reads without blocking. */
export function isUnsafeSnapshotRootAsync(path: string, home = homedir()): Promise<boolean> {
  return runAsync(unsafeSnapshotRoot(path, home))
}

function* unsafeSnapshotRoot(path: string, home = homedir()): Steps<boolean> {
  const target = yield* canonicalPath(path)
  if (target === parse(target).root) return true
  const user = yield* canonicalPath(home)
  if (user === target || user.startsWith(target.endsWith(sep) ? target : `${target}${sep}`)) return true
  const fold = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  const systems: string[] = []
  for (const system of SYSTEM_FOLDERS) systems.push(yield* canonicalPath(system))
  return systems.some((system) => fold(target) === fold(system) || fold(target).startsWith(fold(system.endsWith(sep) ? system : `${system}${sep}`)))
}

const UNSAFE_ROOT = 'Undo is off for this folder because it is a home or system folder.'

function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Math.round(bytes / 1024 ** 3)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`
}

/** The files a snapshot would hold, as `git add -A` finds them: tracked by the store's index, or new and not ignored. */
function candidateFiles(top: string): Steps<string[]> {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.', ...builtInPathspecs().exclude]
  const options = { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }
  return step(
    () => listedCandidates(spawnSync('git', guarded(top, args), { cwd: top, encoding: 'utf8', env: gitEnv(top), ...options })),
    async () => listedCandidates(await runGitProcess(await guardedAsync(top, args), { cwd: top, env: gitEnv(top), ...options }))
  )
}

function listedCandidates(result: { status: number | null; stdout: string; stderr: string; error?: Error }): string[] {
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
function* excludedFolders(top: string, gitDir: string): Steps<CoverageGap[]> {
  const exclude = join(gitDir, 'info', 'exclude')
  const listed = (yield* disk.exists(exclude))
    ? yield* tryGitStep(top, ['ls-files', '-z', '--others', '--ignored', '--directory', `--exclude-from=${exclude}`], undefined, LISTING)
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
function* hiddenStoreCoverage(top: string): Steps<{ leftOut: CoverageGap[] }> {
  if (yield* unsafeSnapshotRoot(top)) throw new SnapshotRefusedError(UNSAFE_ROOT)
  const files = yield* candidateFiles(top)
  if (files.length > limits.files) throw new SnapshotRefusedError(`Undo is off for this folder because it is too large (more than ${limits.files.toLocaleString('en-US')} files).`)
  const leftOut: CoverageGap[] = []
  let total = 0
  for (let start = 0; start < files.length; start += SIZE_BATCH) {
    const batch = files.slice(start, start + SIZE_BATCH)
    const sizes = yield* fileSizes(batch.map((path) => join(top, path)))
    for (const [index, path] of batch.entries()) {
      const size = sizes[index]
      // Not a file (a nested repository, kept as a link and not read), or gone since it was listed.
      if (size === undefined) continue
      if (size > limits.fileBytes) {
        leftOut.push({ path, reason: `over ${sizeText(limits.fileBytes)}` })
        continue
      }
      total += size
      if (total > limits.bytes) throw new SnapshotRefusedError(`Undo is off for this folder because it is too large (more than ${sizeText(limits.bytes)}).`)
    }
  }
  return { leftOut }
}

/** Files whose size is read together, so a folder of many files is not walked one call at a time. */
const SIZE_BATCH = 256

/** The size of each path that is a file; undefined for anything else, or a path that cannot be read. */
function fileSizes(paths: string[]): Steps<Array<number | undefined>> {
  const sizeOf = (info: Stats): number | undefined => info.isFile() ? info.size : undefined
  return step(
    () => paths.map((path) => { try { return sizeOf(lstatSync(path)) } catch { return undefined } }),
    () => Promise.all(paths.map((path) => lstat(path).then(sizeOf, () => undefined)))
  )
}

function* privateFiles(top: string): Steps<{ directory: string; index: string; last: string }> {
  const store = activeHiddenStore(top)
  if (store) {
    // The store has no worktree index of anyone's, so its own is the persistent one: `git diff` against the folder reads it.
    const directory = join(store.gitDir, 'mousse')
    yield* disk.mkdir(directory)
    return { directory, index: join(store.gitDir, 'index'), last: join(directory, 'snapshot-last.json') }
  }
  // `--git-path` keeps names Git doesn't know in the worktree's own Git directory, so each linked worktree has its own.
  const directory = resolve(top, yield* gitStep(top, ['rev-parse', '--git-path', 'mousse']))
  yield* disk.mkdir(directory)
  return { directory, index: join(directory, 'snapshot-index'), last: join(directory, 'snapshot-last.json') }
}

function* headOf(top: string): Steps<string | undefined> {
  // A hidden store has no HEAD, whatever the folder's own repository says.
  if (activeHiddenStore(top)) return undefined
  return (yield* tryGitStep(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).stdout || undefined
}

/**
 * Repositories inside the worktree that have no commit yet (an agent ran `git init` or a project generator there).
 * `git add` records a nested repository as a link to its HEAD, so it cannot add one with none, and the whole snapshot
 * would fail. A snapshot leaves them out instead, as it leaves out the files of every nested repository. Looked for
 * only after an add failed, so a worktree without one is walked once.
 */
function* nestedRepositoriesWithoutCommit(top: string, env: NodeJS.ProcessEnv): Steps<string[]> {
  // Git lists a nested repository it would add as one entry ending in a slash.
  const untracked = (yield* gitStep(top, ['ls-files', '-z', '--others', '--exclude-standard'], env, undefined, LISTING)).split('\0')
  const without: string[] = []
  for (const path of untracked.filter((entry) => entry.endsWith('/')).map((entry) => entry.slice(0, -1))) {
    if (!(yield* outsideStore(join(top, path), ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).ok) without.push(path)
  }
  return without
}

const nul = (text: string): string[] => text.split('\0').filter(Boolean)
const literal = (paths: string[]): string[] => paths.map((path) => `:(literal)${path}`)
const ownPath = (path: string): boolean => path !== '.mousse' && !path.startsWith('.mousse/')

/** Git with the paths on standard input, for path lists too long for the command line. */
function gitWithPaths(top: string, args: string[], paths: string[], env?: NodeJS.ProcessEnv): Steps<string> {
  return gitStep(top, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], env, literal(paths).join('\0') + '\0')
}

/**
 * Makes the private index follow the files Git tracks, for the ones `add -A` cannot see: ignored files. A file that is
 * ignored but tracked by HEAD or by the real index (force-added) is in the snapshot whenever it is on disk, and an
 * ignored file that neither tracks any more leaves it. Reads HEAD and the real index; writes only the private index.
 */
function* followTrackedFiles(top: string, env: NodeJS.ProcessEnv, head: string | undefined, skip: string[] = []): Steps<void> {
  // HEAD's paths the private index lacks (it was seeded from an older HEAD), and the real index's ignored entries.
  const fromHead = head ? nul(yield* gitStep(top, ['diff-index', '--cached', '--no-renames', '--diff-filter=D', '--name-only', '-z', head], env, undefined, LISTING)) : []
  const fromIndex = nul(yield* gitStep(top, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], undefined, undefined, LISTING))
  const left = (path: string) => skip.some((gap) => path === gap || path.startsWith(`${gap}/`))
  const missing: string[] = []
  for (const path of new Set([...fromHead, ...fromIndex])) if (ownPath(path) && !left(path) && (yield* disk.exists(join(top, path)))) missing.push(path)
  if (missing.length) yield* gitWithPaths(top, ['add', '-f'], missing, env)
  const ignored = nul(yield* gitStep(top, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], env, undefined, LISTING))
  if (!ignored.length) return
  // Rare: an ignored file stays in the private index after HEAD and the real index stopped tracking it.
  const tracked = new Set(nul(yield* gitStep(top, ['ls-files', '-z', '--cached', '--', ...literal(ignored)], undefined, undefined, LISTING)))
  if (head) for (const path of nul(yield* gitStep(top, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', head, '--', ...ignored], undefined, undefined, LISTING))) tracked.add(path)
  const untracked = ignored.filter((path) => !tracked.has(path))
  if (untracked.length) yield* gitWithPaths(top, ['rm', '-q', '--cached', '--ignore-unmatch'], untracked, env)
}

/**
 * The tree of every file in the worktree, from the persistent private index. The index stays between snapshots so
 * Git's stat cache keeps the next one fast; a missing, locked or corrupt one is rebuilt from HEAD. Every snapshot also
 * brings it in line with the files HEAD and the real index track (`followTrackedFiles`), so a file that is ignored but
 * was force-added and committed later is in it.
 */
function* indexTree(top: string, index: string, head: string | undefined): Steps<{ tree: string; gaps: CoverageGap[] }> {
  // A hidden store first leaves out what it does not keep (files over the size limit) and refuses a folder it cannot
  // snapshot at all; what it leaves out is named with the rest.
  const store = activeHiddenStore(top)
  // Under the store's mutation lock: its exclude list and attributes are current before anything is added.
  if (store) ensureStoreRules(store)
  const hidden = store ? yield* hiddenStoreCoverage(top) : undefined
  const env = { GIT_INDEX_FILE: index }
  // The store's exclude list already leaves `.mousse/` out, and Git refuses an exclusion that names an ignored path.
  const addAll = (left: CoverageGap[]) => tryGitStep(top, ['add', '-A', '--', '.', ...(hidden ? [] : [NOT_MOUSSE]), ...left.map((gap) => `:(exclude,literal)${gap.path}`)], env, LISTING)
  const indexOnce = function* (): Steps<{ tree: string; gaps: CoverageGap[] }> {
    if (!(yield* disk.exists(index))) yield* gitStep(top, head ? ['read-tree', head] : ['read-tree', '--empty'], env)
    // What can be read is recorded; what cannot (an unreadable file or folder, a nested repository with no commit) is
    // left out and named. Git stops at the first file it cannot read, so each one found is left out and it runs again.
    const gaps: CoverageGap[] = [...(hidden?.leftOut ?? [])]
    // A file left out must not stay in the store's index from an earlier snapshot: Undo would restore that old copy.
    if (hidden?.leftOut.length) yield* gitWithPaths(top, ['rm', '-q', '--cached', '--ignore-unmatch'], hidden.leftOut.map((gap) => gap.path), env)
    let nestedChecked = false
    for (let round = 0; ; round++) {
      const result = yield* addAll(gaps)
      for (const match of result.stderr.matchAll(/could not open directory '([^']+?)\/?': Permission denied/g)) {
        if (!gaps.some((gap) => gap.path === match[1])) gaps.push({ path: match[1]!, reason: UNREADABLE })
      }
      if (result.ok) break
      // Git names a nested repository with no commit as a folder (`'tool/' does not have a commit checked out`).
      const nestedNamed = [...result.stderr.matchAll(/'([^']+?)\/?' does not have a commit checked out/g)].map((match) => match[1]!).filter((path) => !gaps.some((gap) => gap.path === path))
      for (const path of nestedNamed) gaps.push({ path, reason: NESTED_WITHOUT_COMMIT })
      const found = [...result.stderr.matchAll(/unable to index file '([^']+?)\/?'/g)].map((match) => match[1]!).filter((path) => !gaps.some((gap) => gap.path === path))
      if (nestedNamed.length && !found.length) continue
      if (!found.length && !nestedChecked) {
        nestedChecked = true
        const nested = (yield* nestedRepositoriesWithoutCommit(top, env)).filter((path) => !gaps.some((gap) => gap.path === path))
        for (const path of nested) gaps.push({ path, reason: NESTED_WITHOUT_COMMIT })
        if (nested.length) continue
      }
      if (!found.length || round >= 200) throw new Error(result.stderr || 'git add failed')
      for (const path of found) gaps.push({ path, reason: UNREADABLE })
    }
    if (hidden) {
      // The built-in list holds whatever the folder's `.gitignore` takes back in (`!node_modules/`): what is under it
      // leaves the index here. A hidden store has no HEAD and no index of anyone's to follow.
      yield* gitStep(top, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...builtInPathspecs().match], env)
      gaps.push(...yield* nestedWithChanges(top, env, gaps))
      const tree = yield* gitStep(top, ['write-tree'], env)
      return { tree, gaps: [...gaps, ...yield* excludedFolders(top, store!.gitDir)] }
    }
    yield* followTrackedFiles(top, env, head, gaps.map((gap) => gap.path))
    gaps.push(...yield* nestedWithChanges(top, env, gaps))
    return { tree: yield* gitStep(top, ['write-tree'], env), gaps }
  }
  try {
    return yield* indexOnce()
  } catch {
    // The caller holds the mutation locks, so a lock file left by a crash is nobody's.
    yield* disk.remove(index)
    yield* disk.remove(`${index}.lock`)
    return yield* indexOnce()
  }
}

/** The tree of the worktree's files right now, without writing a commit. */
export function* worktreeTreeSteps(cwd: string): Steps<string> {
  const top = yield* gitStep(cwd, ['rev-parse', '--show-toplevel'])
  const index = (yield* privateFiles(top)).index
  return (yield* indexTree(top, index, yield* headOf(top))).tree
}


export function worktreeTreeAsync(cwd: string): Promise<string> {
  return runAsync(worktreeTreeSteps(cwd))
}

function* readLast(path: string): Steps<LastSnapshot | undefined> {
  try { return JSON.parse(yield* disk.readText(path)) as LastSnapshot } catch { return undefined }
}

/**
 * Records the worktree's files as a snapshot commit. It never changes HEAD, a branch, the real index or a file, and
 * it works while a merge or rebase is in progress (the snapshot says so). When the files and HEAD are what the
 * previous snapshot had, that snapshot is returned. The caller holds the mutation locks.
 */
export function* takeSnapshotSteps(cwd: string, input: SnapshotInput): Steps<Snapshot> {
  const top = yield* gitStep(cwd, ['rev-parse', '--show-toplevel'])
  const files = yield* privateFiles(top)
  const head = yield* headOf(top)
  const { tree, gaps: coverageGaps } = yield* indexTree(top, files.index, head)
  const hidden = activeHiddenStore(top) !== undefined
  const branch = hidden ? undefined : (yield* tryGitStep(top, ['branch', '--show-current'])).stdout || undefined
  const operation = yield* operationInProgressSteps(top)
  const state = { tree, ...(head ? { head } : {}), ...(branch ? { branch } : {}), ...(operation ? { operationInProgress: operation } : {}), ...(coverageGaps.length ? { coverageGaps } : {}) }
  const { ignored, truncated } = yield* ignoredNow(top)
  const uncovered = JSON.stringify({ g: coverageGaps, i: ignored, ...(truncated ? { t: true } : {}) })
  const previous = yield* readLast(files.last)
  // Reused only when what it left out is the same too: a restore reads that from the snapshot.
  if (previous && previous.tree === tree && previous.head === head && previous.uncovered === uncovered && (yield* tryGitStep(top, ['cat-file', '-e', `${previous.sha}^{commit}`])).ok) return { sha: previous.sha, ...state }
  const trailers = [
    input.threadId ? `Mousse-Thread: ${input.threadId}` : '', input.operationId ? `Mousse-Operation: ${input.operationId}` : '',
    head ? `Mousse-Head: ${head}` : '', branch ? `Mousse-Branch: ${branch}` : '',
    // Only when something was not covered: no record and an empty one mean the same to a restore.
    coverageGaps.length || ignored.length || truncated ? `${UNCOVERED_LINE}${uncovered}` : ''
  ].filter(Boolean).join('\n')
  const subject = `${SUBJECT}${input.reason.split(/\r?\n/)[0]!.trim()}`
  const sha = yield* gitStep(top, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', subject, ...(trailers ? ['-m', trailers] : [])], MOUSSE_COMMIT_ENV)
  yield* disk.writeText(files.last, JSON.stringify({ sha, tree, ...(head ? { head } : {}), uncovered } satisfies LastSnapshot))
  return { sha, ...state }
}


/** Records the worktree's files as a snapshot (see `takeSnapshotSteps`), without blocking the daemon. */
export function takeSnapshotAsync(cwd: string, input: SnapshotInput): Promise<Snapshot> {
  return runAsync(takeSnapshotSteps(cwd, input))
}

/**
 * Records `tree` as a snapshot commit of the worktree, on its HEAD, without reading the files: the result an
 * interrupted restore planned, once every file it writes is proven to be as planned. Files that appeared since are
 * then edits made after it, not part of it.
 */
export function* snapshotOfTreeSteps(cwd: string, tree: string, input: SnapshotInput): Steps<Snapshot> {
  const top = yield* gitStep(cwd, ['rev-parse', '--show-toplevel'])
  const head = yield* headOf(top)
  const branch = activeHiddenStore(top) ? undefined : (yield* tryGitStep(top, ['branch', '--show-current'])).stdout || undefined
  const operation = yield* operationInProgressSteps(top)
  const { ignored, truncated } = yield* ignoredNow(top)
  const trailers = [
    input.threadId ? `Mousse-Thread: ${input.threadId}` : '', input.operationId ? `Mousse-Operation: ${input.operationId}` : '',
    head ? `Mousse-Head: ${head}` : '', branch ? `Mousse-Branch: ${branch}` : '',
    ignored.length || truncated ? `${UNCOVERED_LINE}${JSON.stringify({ g: [], i: ignored, ...(truncated ? { t: true } : {}) })}` : ''
  ].filter(Boolean).join('\n')
  const subject = `${SUBJECT}${input.reason.split(/\r?\n/)[0]!.trim()}`
  const sha = yield* gitStep(top, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', subject, ...(trailers ? ['-m', trailers] : [])], MOUSSE_COMMIT_ENV)
  return { sha, tree, ...(head ? { head } : {}), ...(branch ? { branch } : {}), ...(operation ? { operationInProgress: operation } : {}) }
}

/** Records `tree` as a snapshot (see `snapshotOfTreeSteps`), without blocking the daemon. */
export function snapshotOfTreeAsync(cwd: string, tree: string, input: SnapshotInput): Promise<Snapshot> {
  return runAsync(snapshotOfTreeSteps(cwd, tree, input))
}

/** The ref that remembers the thread's files as last published into the primary checkout: the next publish brings in only what came after. */
export function publishedRef(threadId: string): string {
  return `refs/mousse/published/${threadId}`
}

/** Whether two revisions (snapshots or commits) hold the same files. Revisions that cannot be read are not the same. */
export function* sameTreeSteps(cwd: string, a: string, b: string): Steps<boolean> {
  if (a === b) return true
  try { return (yield* treeOfSteps(cwd, a)) === (yield* treeOfSteps(cwd, b)) } catch { return false }
}


export function sameTreeAsync(cwd: string, a: string, b: string): Promise<boolean> {
  return runAsync(sameTreeSteps(cwd, a, b))
}

/**
 * The HEAD and branch a snapshot was taken on. A commit that is not a snapshot is an action recorded before
 * snapshots existed, when its start and end were the branch's own commits: it was HEAD itself.
 */
export function* snapshotOriginSteps(cwd: string, sha: string): Steps<{ head?: string; branch?: string }> {
  const body = yield* tryGitStep(cwd, ['log', '-1', '--format=%B', sha])
  if (!body.ok) return {}
  if (!body.stdout.startsWith(SUBJECT)) return { head: sha }
  const trailer = (name: string): string | undefined => body.stdout.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1]?.trim()
  return { head: trailer('Mousse-Head'), branch: trailer('Mousse-Branch') }
}


export function snapshotOriginAsync(cwd: string, sha: string): Promise<{ head?: string; branch?: string }> {
  return runAsync(snapshotOriginSteps(cwd, sha))
}

/**
 * What the thread's Git did between a start (a snapshot or legacy commit) and the `after` snapshot, and the real
 * commits it added to HEAD (first parent, oldest first; none when history was rewritten or HEAD did not move).
 */
export function* describeGitSteps(cwd: string, startSha: string, after: Snapshot): Steps<{ record: GitRecord; commits: string[] }> {
  const before = yield* snapshotOriginSteps(cwd, startSha)
  let commits: string[] = []
  let rewroteHistory = false
  if (before.head && after.head && before.head !== after.head) {
    if ((yield* tryGitStep(cwd, ['merge-base', '--is-ancestor', before.head, after.head])).ok) {
      commits = (yield* gitStep(cwd, ['rev-list', '--first-parent', '--reverse', `${before.head}..${after.head}`], undefined, undefined, LISTING)).split(/\r?\n/).filter(Boolean)
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


export function describeGitAsync(cwd: string, startSha: string, after: Snapshot): Promise<{ record: GitRecord; commits: string[] }> {
  return runAsync(describeGitSteps(cwd, startSha, after))
}

/** The remote-tracking branch that already holds one of `commits`, if any: Undo cannot take a pushed commit back. */
export function* pushedToSteps(cwd: string, commits: string[]): Steps<string | undefined> {
  // A ref that holds a later commit holds every earlier one, so the first is enough.
  const first = commits[0]
  if (!first) return undefined
  const refs = yield* tryGitStep(cwd, ['for-each-ref', '--contains', first, '--format=%(refname:short)', 'refs/remotes/'], undefined, LISTING)
  return refs.ok ? refs.stdout.split(/\r?\n/).find((ref) => ref && !ref.endsWith('/HEAD')) : undefined
}


export function pushedToAsync(cwd: string, commits: string[]): Promise<string | undefined> {
  return runAsync(pushedToSteps(cwd, commits))
}

/** The line a result carries when the turn's commits are already on a remote. */
export function pushedNotice(remote: string, count: number): string {
  return count === 1 ? `This commit was already pushed to ${remote}.` : `These commits were already pushed to ${remote}.`
}

/** What a turn did to Git that a restore of its files leaves in place: as the turn's own action recorded it. */
export type GitLeftInPlaceSource = Pick<ThreadAction, 'commits' | 'git'>

const shortSha = (sha: string): string => sha.slice(0, 7)

function shasInWords(commits: string[]): string {
  const named = commits.slice(0, 3).map(shortSha)
  const rest = commits.length - named.length
  if (rest > 0) return `${named.join(', ')} and ${rest} more`
  return named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0]!
}

/**
 * The line Undo, Redo or a revert carries when the turn it restores also did Git work, which a restore of files
 * never takes back: the commits it made (by short SHA, on the branch they were made on), a branch switch, and
 * rewritten history. It is built from `original`, the turn's own action, since a Redo's target is the Undo's record,
 * whose commits are always empty. Commits are worded as history, and qualified when their branch has moved since.
 */
export function* gitLeftInPlaceNoticeSteps(cwd: string, operation: 'Undo' | 'Redo' | 'Revert', original: GitLeftInPlaceSource): Steps<string | undefined> {
  const { commits, git } = original
  const parts: string[] = []
  const branch = git?.branchAfter
  const last = commits.at(-1)
  if (last) {
    const isAncestor = function* (ref: string): Steps<boolean> {
      return (yield* tryGitStep(cwd, ['merge-base', '--is-ancestor', last, ref])).ok
    }
    const subject = commits.length === 1 ? `Commit ${shasInWords(commits)} from this turn` : `Commits ${shasInWords(commits)} from this turn`
    let where: string
    if (branch && (yield* isAncestor(`refs/heads/${branch}`))) where = `${commits.length === 1 ? 'stays' : 'stay'} on ${branch}`
    else if (branch) {
      const exists = (yield* tryGitStep(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok
      where = `${commits.length === 1 ? 'was' : 'were'} made on ${branch}, which ${exists ? `has moved since and no longer holds ${commits.length === 1 ? 'it' : 'them'}` : 'no longer exists'}`
    } else where = `${commits.length === 1 ? 'was' : 'were'} made on a detached HEAD`
    // Git compares the files with HEAD: while HEAD still holds the commits, the restored files read as taking them back.
    const shown = operation !== 'Redo' && (yield* isAncestor('HEAD'))
      ? `, so Git now shows ${commits.length === 1 ? 'its' : 'their'} changes as ${operation === 'Undo' ? 'undone' : 'reverted'}` : ''
    parts.push(`${subject} ${where}${shown}.`)
  }
  if (git && git.branchBefore !== git.branchAfter && (git.branchBefore || git.branchAfter)) {
    const name = (value?: string) => value ?? 'a detached HEAD'
    parts.push(`This turn switched from ${name(git.branchBefore)} to ${name(git.branchAfter)}; ${operation} leaves the checkout where it is.`)
  }
  if (git?.rewroteHistory) parts.push(`This turn rewrote the history of ${branch ?? 'HEAD'} (a reset or rebase); ${operation} leaves that history as it is.`)
  if (!parts.length) return undefined
  const pushed = yield* pushedToSteps(cwd, commits)
  return [`${operation} restored files only.`, ...parts, ...(pushed ? [pushedNotice(pushed, commits.length)] : [])].join(' ')
}


export function gitLeftInPlaceNoticeAsync(cwd: string, operation: 'Undo' | 'Redo' | 'Revert', original: GitLeftInPlaceSource): Promise<string | undefined> {
  return runAsync(gitLeftInPlaceNoticeSteps(cwd, operation, original))
}

/**
 * Files a restore was about to overwrite or delete that no snapshot held (ignored, for example), kept first under `ref`
 * as their bytes on disk. `paths` are relative to `top`, the repository's top folder.
 */
export interface PreservedFiles {
  ref: string
  paths: string[]
  top: string
  /** Each kept path that is not a plain file: a link or an executable file, so its command makes it again as it was. */
  kinds?: Record<string, RestoreKind>
}

/** A path a restore left as it is because it was not covered on one side, and why. */
export interface LeftAsIs { path: string; reason: string }

/**
 * Files a restore wrote over or removed whose bytes on disk Git would not write back (line endings, an encoding or a
 * filter it converts), kept exactly as they were first: each under the ref of the copy that holds it (one, unless a file
 * changed while the restore ran and was kept again). `windowMs`: how long their owner keeps them; absent when the
 * restore named no owner and they were kept under the restore's own ref.
 */
export interface ExactBytesKept { files: Array<{ path: string; ref: string; kind?: RestoreKind }>; top: string; windowMs?: number }

/** Whose copy a restore keeps of bytes no snapshot holds: the action's owner (a thread's folder), and the action as a refusal names it ("Undo"). */
export interface RestoreKeep { owner: string; action: string }

export type RestoreResult = { snapshot: Snapshot; tree: string; preserved?: PreservedFiles; exact?: ExactBytesKept; leftAsIs?: LeftAsIs[] } | { conflicts: string[] }

/** The line a result carries for the paths a restore left as they are. */
export function leftAsIsNotice(left: LeftAsIs[] | undefined): string | undefined {
  if (!left?.length) return undefined
  const named = left.slice(0, 10).map((entry) => `${entry.path} (${entry.reason})`).join(', ')
  return `Left as it is: ${named}${left.length > 10 ? ` and ${left.length - 10} more` : ''}.`
}

/**
 * The line a result carries when a restore kept files no snapshot held before writing over them, with a command that
 * brings each back byte for byte (`restoreCommands.ts`). They are kept for the thread's Undo retention window
 * (`windowMs`), then expire (`expirePreservedFiles`).
 */
export function preservedNotice(preserved: PreservedFiles, windowMs: number, shell: RestoreShell = restoreShell()): string {
  const named = preserved.paths.slice(0, 10).join(', ') + (preserved.paths.length > 10 ? ` and ${preserved.paths.length - 10} more` : '')
  const commands = restoreCommandsText(preserved.paths.map((path) => ({ ref: preserved.ref, path, ...(preserved.kinds?.[path] ? { kind: preserved.kinds[path] } : {}) })), { shell })
  return `Files no snapshot held were in the way and are kept under ${preserved.ref} for ${retentionWindowText(windowMs)}: ${named}. Bring one back before then by running this in ${preserved.top}: ${commands}.`
}

/**
 * The line a result carries when a restore kept files exactly as they were on disk before writing them in Git's form.
 * Kept short: until snapshots record exact bytes, every Undo in a repository whose files Git converts can carry it.
 */
export function exactBytesNotice(kept: ExactBytesKept, shell: RestoreShell = restoreShell()): string {
  const paths = kept.files.map((file) => file.path)
  const one = paths.length === 1
  const named = paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` and ${paths.length - 3} more` : '')
  const first = kept.files[0]!
  const others = [...new Set(kept.files.map((file) => file.ref))].filter((ref) => ref !== first.ref)
  const rest = one ? '' : `, and the same way for the others${others.length ? ` (some under ${others.join(', ')})` : ''}`
  return `Kept ${named} exactly as ${one ? 'it was' : 'they were'} on disk${kept.windowMs === undefined ? '' : ` for ${retentionWindowText(kept.windowMs)}`}; Git writes ${one ? 'it' : 'them'} with other line endings or encoding. Bring ${one ? 'it' : 'one'} back by running this in ${kept.top}: ${restoreFileCommand(first.ref, first.path, { shell, ...(first.kind ? { kind: first.kind } : {}) })}${rest}.`
}

/** The lines a move's result carries for what it kept exactly and what it left as it is; undefined when neither. */
export function movedFilesNotice(moved: Pick<MovedFiles, 'exact' | 'leftAsIs'>): string | undefined {
  return [moved.exact ? exactBytesNotice(moved.exact) : '', leftAsIsNotice(moved.leftAsIs) ?? ''].filter(Boolean).join(' ') || undefined
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
  /** Who keeps bytes on disk that Git would write back in another form (see `moveFilesSteps`). */
  keep?: RestoreKeep
}

/**
 * Brings `theirs` into the worktree by a three-way merge from `base` onto `ours`, which edits to other lines or
 * files made since survive. Conflicts refuse it with the conflicting paths and change nothing. Otherwise only the
 * files the merge changes are rewritten, through a temporary private index, and the result is recorded as a new
 * snapshot. It never commits, never moves HEAD and never touches the real index. The caller holds the mutation
 * locks and has just taken `ours`. `planned` is told the tree the files are about to become, before they change,
 * so the caller can write it down for recovery.
 */
export function* restoreChangeSteps(cwd: string, input: RestoreChangeInput, planned?: (tree: string) => void): Steps<RestoreResult> {
  const top = yield* gitStep(cwd, ['rev-parse', '--show-toplevel'])
  const merged = yield* mergeTreesSteps(top, input.base, input.ours, input.theirs)
  if ('conflicts' in merged) return merged
  const ours = yield* treeOfSteps(top, input.ours)
  const { tree, leftAsIs } = yield* leaveUncovered(top, input, ours, merged.tree)
  // Checked before the intent is recorded: a folder that cannot be kept refuses the restore with nothing pending.
  yield* uncapturedInTheWay(top, ours, tree)
  planned?.(tree)
  const moved = yield* moveFilesSteps(top, ours, tree, input.operationId, input.keep)
  const snapshot = yield* takeSnapshotSteps(top, input)
  const left = [...leftAsIs, ...(moved.leftAsIs ?? [])]
  return { snapshot, tree, ...(moved.preserved ? { preserved: moved.preserved } : {}), ...(moved.exact ? { exact: moved.exact } : {}), ...(left.length ? { leftAsIs: left } : {}) }
}


/** Brings `theirs` into the worktree (see `restoreChangeSteps`), without blocking the daemon. */
export function restoreChangeAsync(cwd: string, input: RestoreChangeInput, planned?: (tree: string) => void): Promise<RestoreResult> {
  return runAsync(restoreChangeSteps(cwd, input, planned))
}

/**
 * The merge's tree with every path the restore must not touch put back as it is now: a path not covered on the side
 * being restored to (left out, unreadable or ignored there, so its absence there says nothing), a path that would be
 * deleted when the record of that side is incomplete, and a file not covered now (over the size limit) that the
 * restore would write over. Those stay on disk as they are and are named. A snapshot with no record (taken before
 * snapshots kept one) changes nothing here.
 */
function* leaveUncovered(top: string, input: RestoreChangeInput, ours: string, merged: string): Steps<{ tree: string; leftAsIs: LeftAsIs[] }> {
  const target = yield* snapshotUncoveredSteps(top, input.theirs)
  const now = yield* snapshotUncoveredSteps(top, input.ours)
  if (!target && !now) return { tree: merged, leftAsIs: [] }
  const where = input.restoredTo ?? 'in the version restored'
  const changes = (yield* gitStep(top, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', ours, merged], undefined, undefined, LISTING)).split('\0').filter(Boolean)
  const leftAsIs: LeftAsIs[] = []
  for (let index = 0; index + 1 < changes.length; index += 2) {
    const status = changes[index]!
    const path = changes[index + 1]!
    const there = target ? uncoveredReason(target, path) : undefined
    const current = now?.gaps.length ? uncoveredReason({ ...now, ignored: [] }, path) : undefined
    if (there) leftAsIs.push({ path, reason: `not covered ${where}` })
    else if (target?.truncated && status === 'D') leftAsIs.push({ path, reason: `not known whether it was there ${where}` })
    else if (current && (yield* disk.exists(join(top, path)))) leftAsIs.push({ path, reason: `not covered now: ${current}` })
  }
  if (!leftAsIs.length) return { tree: merged, leftAsIs }
  // The kept paths take their entry from `ours` (or none), through a temporary index: nothing on disk changes here.
  const temporary = join((yield* privateFiles(top)).directory, `leave-${randomUUID()}.index`)
  const env = { GIT_INDEX_FILE: temporary }
  try {
    yield* gitStep(top, ['read-tree', merged], env)
    const kept = new Map((yield* gitStep(top, ['ls-tree', '-r', '-z', ours, '--', ...leftAsIs.map((entry) => entry.path)], undefined, undefined, LISTING)).split('\0').filter(Boolean)
      .map((line) => { const tab = line.indexOf('\t'); const [mode, , sha] = line.slice(0, tab).split(' '); return [line.slice(tab + 1), `${mode} ${sha}`] as const }))
    const lines = leftAsIs.map((entry) => `${kept.get(entry.path) ?? `0 ${'0'.repeat(merged.length)}`}\t${entry.path}`)
    yield* gitStep(top, ['update-index', '--index-info'], env, lines.join('\n') + '\n')
    return { tree: yield* gitStep(top, ['write-tree'], env), leftAsIs }
  } catch (error) {
    throw new Error(`The restore would change ${leftAsIs[0]!.path}, which was not recorded, and cannot leave it as it is. Nothing was changed.`, { cause: error })
  } finally {
    yield* disk.remove(temporary)
  }
}

/**
 * Files on disk at the paths a move from `from` to `to` writes or deletes that `from` does not hold: an ignored or
 * excluded file, or what fills a folder where `to` puts a file. These are bytes no snapshot has.
 */
function* uncapturedInTheWay(top: string, from: string, to: string, listed?: string[]): Steps<string[]> {
  const touched = listed ?? (yield* gitStep(top, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', from, to], undefined, undefined, LISTING)).split('\0').filter(Boolean)
  if (!touched.length) return []
  const held = new Set((yield* gitStep(top, ['ls-tree', '-r', '-z', '--name-only', from], undefined, undefined, LISTING)).split('\0').filter(Boolean))
  // A nested repository recorded by its commit (a gitlink) is never written into: Git only changes the link.
  const links = new Set<string>()
  for (const tree of [from, to]) {
    for (const line of (yield* gitStep(top, ['ls-tree', '-r', '-z', tree], undefined, undefined, LISTING)).split('\0')) if (line.startsWith('160000 ')) links.add(line.slice(line.indexOf('\t') + 1))
  }
  const found = new Set<string>()
  // A folder too big or too deep to list, or another repository, cannot be kept file by file: the restore is refused
  // before anything is written, naming it, instead of going on with part of it unkept.
  const tooMuch = (path: string): never => { throw new RestoreInTheWayError(path) }
  const visit = function* (root: string, path: string, depth = 0): Steps<void> {
    if (links.has(path)) return
    if (depth > PRESERVE_LIMITS.depth || found.size >= PRESERVE_LIMITS.files) tooMuch(root)
    let stat
    try { stat = yield* disk.lstat(join(top, path)) } catch { return }
    if (stat.isDirectory()) {
      if (path === '.mousse') return
      if (path === '.git' || path.endsWith('/.git')) tooMuch(root)
      for (const name of yield* disk.readdir(join(top, path))) yield* visit(root, `${path}/${name}`, depth + 1)
    } else if (!held.has(path)) found.add(path)
  }
  for (const path of touched) {
    const parts = path.split('/')
    // A file where `to` needs a folder above the path.
    for (let depth = 1; depth < parts.length; depth++) {
      const above = parts.slice(0, depth).join('/')
      let isFolder: boolean
      try { isFolder = (yield* disk.lstat(join(top, above))).isDirectory() } catch { break }
      if (!isFolder && !held.has(above)) found.add(above)
    }
    yield* visit(path, path)
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
function* preserveFiles(top: string, paths: string[], directory: string, operationId?: string): Steps<PreservedFiles> {
  const temporary = join(directory, `preserve-${randomUUID()}.index`)
  const env = { GIT_INDEX_FILE: temporary }
  try {
    yield* gitStep(top, ['read-tree', '--empty'], env)
    const entries: string[] = []
    const kinds: Record<string, RestoreKind> = {}
    for (const path of paths) {
      const absolute = join(top, path)
      const link = (yield* disk.lstat(absolute)).isSymbolicLink()
      const sha = link ? yield* gitStep(top, ['hash-object', '-w', '--stdin'], undefined, yield* disk.readlink(absolute)) : yield* gitStep(top, ['hash-object', '-w', '--no-filters', '--', path])
      const mode = link ? '120000' : ((yield* disk.lstat(absolute)).mode & 0o111) ? '100755' : '100644'
      if (mode !== '100644') kinds[path] = restoreKindOf(mode)
      entries.push(`${mode} ${sha}\t${path}`)
    }
    yield* gitStep(top, ['update-index', '--index-info'], env, entries.join('\n') + '\n')
    const tree = yield* gitStep(top, ['write-tree'], env)
    const head = yield* headOf(top)
    const sha = yield* gitStep(top, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `${SUBJECT}files kept before a restore`], mousseCommitEnvNow())
    const ref = `refs/mousse/preserved/${operationId ?? randomUUID()}-${sha.slice(0, 12)}`
    yield* gitStep(top, ['update-ref', '--no-deref', ref, sha])
    return { ref, paths, top, ...(Object.keys(kinds).length ? { kinds } : {}) }
  } finally {
    yield* disk.remove(temporary)
  }
}

/** What a move of the files did besides the move: what it kept first, and paths it left as they are. */
export interface MovedFiles { preserved?: PreservedFiles; exact?: ExactBytesKept; leftAsIs?: LeftAsIs[] }

/** The SHA-256 of a file (or a link's target) as the kept ref `ref` holds it, read as Git wrote it, never converted. */
async function keptDigest(top: string, ref: string, path: string): Promise<string> {
  const argv = await guardedAsync(top, ['cat-file', 'blob', `${ref}:${path}`])
  const ran = await runGitProcess(argv, { cwd: top, env: gitEnv(top), maxBuffer: LISTING.maxBuffer })
  if (ran.error || ran.status !== 0) throw new Error(`Command failed: git cat-file blob ${ref}:${path}\n${ran.stderr}`)
  return createHash('sha256').update(ran.stdoutBytes).digest('hex')
}

/** One path the move writes or deletes: its mode and blob in `from` and in `to` (mode `000000` where a tree has none). */
interface Change { fromMode: string; fromBlob: string; toMode: string; toBlob: string }

/**
 * Rewrites the files that differ between two trees from the first (what the worktree holds, as of the last snapshot)
 * to the second, through a temporary private index. A file that changed since the snapshot makes Git refuse
 * before anything is written. A file in the way that `from` does not hold (ignored, excluded, or inside a folder
 * that becomes a file) is no snapshot's, so it is kept under a `refs/mousse/preserved/` ref first and returned.
 *
 * Files Git converts when it writes them (CRLF and LF under `core.autocrlf`, an `eol`, `text`, encoding or filter
 * attribute) are written by `writeConvertedAsync` instead: Git's checks cannot tell their raw forms apart, so Mousse
 * removes each one only once it is proven held or kept, and Git then only creates. Files Git does not convert stay with
 * `read-tree -m -u`, whose refresh is enough there: their stored form is their raw bytes, so after the refresh any write
 * that changes them changes their size or times (Git refuses), or lands in the second of the refresh, when Git compares
 * the raw bytes again and refuses. What that leaves is a write landing while Git itself writes, after it checked.
 */
export function* moveFilesSteps(top: string, from: string, to: string, operationId?: string, keep?: RestoreKeep): Steps<MovedFiles> {
  if (from === to) return {}
  const files = yield* privateFiles(top)
  // Every path the move writes or deletes: `:<mode> <mode> <blob> <blob> <status>`, then the path.
  const raw = (yield* gitStep(top, ['diff-tree', '-r', '-z', '--no-renames', '--raw', from, to], undefined, undefined, LISTING)).split('\0')
  const changes = new Map<string, Change>()
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const [fromMode, toMode, fromBlob, toBlob] = raw[index]!.slice(1).split(' ') as [string, string, string, string]
    changes.set(raw[index + 1]!, { fromMode, fromBlob, toMode, toBlob })
  }
  const touched = [...changes.keys()]
  const heldAsFiles = touched.filter((path) => /^100(?:644|755)$/.test(changes.get(path)!.fromMode))
  const inTheWay = yield* uncapturedInTheWay(top, from, to, touched)
  const preserved = inTheWay.length ? yield* preserveFiles(top, inTheWay, files.directory, operationId) : undefined
  const converted = yield* convertedPaths(top, touched, heldAsFiles)
  const temporary = join(files.directory, `restore-${randomUUID()}.index`)
  const env = { GIT_INDEX_FILE: temporary }
  let written: { exact?: ExactBytesKept; leftAsIs: LeftAsIs[] } = { leftAsIs: [] }
  try {
    // The persistent index was refreshed by the snapshot, so its stat data lets Git see that the files still match.
    if (yield* disk.exists(files.index)) yield* disk.copyFile(files.index, temporary)
    if (!(yield* disk.exists(temporary)) || (yield* gitStep(top, ['write-tree'], env)) !== from) yield* gitStep(top, ['read-tree', from], env)
    // A file saved since with the same bytes (format on save, `touch`) only has new stat data: refreshed, it reads as
    // unchanged, so Git refuses only a file whose bytes changed.
    yield* tryGitStep(top, ['update-index', '-q', '--refresh'], env, LISTING)
    if (!converted.length) yield* gitStep(top, ['read-tree', '-m', '-u', from, to], env)
    else written = yield* asyncOnly(() => writeConvertedAsync({ top, from, to, env, changes, converted, keep, operationId, directory: files.directory, ...(preserved ? { preserved } : {}) }))
  } finally {
    yield* disk.remove(temporary)
  }
  return { ...(preserved ? { preserved } : {}), ...(written.exact ? { exact: written.exact } : {}), ...(written.leftAsIs.length ? { leftAsIs: written.leftAsIs } : {}) }
}


/** Rewrites the files that differ between two trees (see `moveFilesSteps`), without blocking the daemon. */
export function moveFilesAsync(top: string, from: string, to: string, operationId?: string, keep?: RestoreKeep): Promise<MovedFiles> {
  return runAsync(moveFilesSteps(top, from, to, operationId, keep))
}

/** The attributes under which Git writes a file with bytes other than its blob's; `crlf` is `text`'s old name. */
const CONVERTING_ATTRIBUTES = ['text', 'crlf', 'eol', 'filter', 'ident', 'working-tree-encoding'] as const

/**
 * The paths among `files` that Git converts when it writes them: every one when `core.autocrlf` is on (`true` or
 * `input`, as Git reads it in the end) or the move changes a `.gitattributes`, otherwise those `check-attr` finds a
 * converting attribute on. `core.eol` alone converts nothing: it applies to files with a `text` attribute, which
 * `check-attr` finds. In a repository that converts nothing this is two quick reads, and no file is opened.
 */
function* convertedPaths(top: string, touched: string[], files: string[]): Steps<string[]> {
  if (!files.length) return []
  const autocrlf = yield* tryGitStep(top, ['config', '--get', 'core.autocrlf'])
  // A bare `autocrlf` key reads as true.
  if (autocrlf.ok && !/^(false|no|off|0)$/i.test(autocrlf.stdout.trim())) return files
  if (touched.some((path) => path === '.gitattributes' || path.endsWith('/.gitattributes'))) return files
  // For each path, in order, one `path NUL attribute NUL value NUL` per attribute asked.
  const fields = (yield* gitStep(top, ['check-attr', '-z', '--stdin', ...CONVERTING_ATTRIBUTES], undefined, files.join('\0') + '\0', LISTING)).split('\0')
  return files.filter((_, index) => CONVERTING_ATTRIBUTES.some((__, attribute) => {
    const value = fields[(index * CONVERTING_ATTRIBUTES.length + attribute) * 3 + 2]
    return value !== undefined && value !== 'unspecified' && value !== 'unset'
  }))
}

/** A step that runs only without blocking the daemon, as every restore does. */
function asyncOnly<T>(run: () => Promise<T>): Steps<T> {
  return step(() => { throw new Error('This part of a restore runs only without blocking the daemon.') }, run)
}

/** How many times a restore reads and keeps files that keep changing while it does, before it stops. */
const KEEP_ROUNDS = 3
const CHANGED_WHILE_WRITING = 'changed while the restore was writing it'

interface ConvertedWrite {
  top: string; from: string; to: string
  /** The temporary index, holding `from` and just refreshed. */
  env: NodeJS.ProcessEnv
  changes: ReadonlyMap<string, Change>
  /** Paths `from` holds as files that Git converts, which the move writes or deletes. */
  converted: readonly string[]
  keep?: RestoreKeep
  operationId?: string
  directory: string
  /** What this restore kept first of the files in its way (`preserveFiles`). */
  preserved?: PreservedFiles
}

const namedPaths = (paths: readonly string[]): string => paths.slice(0, 5).join(', ') + (paths.length > 5 ? ` and ${paths.length - 5} more` : '')

/**
 * The move, for a repository where Git converts some of the paths it writes. Mousse removes only bytes it has proven are
 * held, and Git only creates, with the same steps a Discard takes (`provenDiscard.ts`):
 * 1. Nothing is written yet. A converted file whose normal form changed since the snapshot refuses the restore, as Git
 *    would. Each converted file on disk is read once and compared with Git's form of it (`heldBytes.ts`); one that
 *    differs is kept by `keep`'s owner (`keepCopy`), and the copy must hold the bytes that were read. A file that changes
 *    meanwhile is read again, up to `KEEP_ROUNDS` times; then the restore is refused, naming it, with nothing written.
 * 2. Git moves every other path (`read-tree -m -u` to a target that leaves the converted paths, and target paths in
 *    their way, as they are), refusing a changed file as before.
 * 3. Mousse removes each converted file, and a folder that becomes a file with the files this restore kept from it, each
 *    entry proven right before its unlink (`removeProvenAsync`). One that changed since is read and kept again (still
 *    bounded); one that keeps changing is left as it is and named. Folders the result still has stay.
 * 4. Git writes the new versions only where nothing is (`createOnlyAsync`, `checkout-index` without `--force`). Every
 *    path it did not write is left as it is and named, with why.
 * A crash between 3 and 4 leaves paths both trees have empty, which recovery reads as a partial restore for a person.
 */
async function writeConvertedAsync(write: ConvertedWrite): Promise<{ exact?: ExactBytesKept; leftAsIs: LeftAsIs[] }> {
  const { top, from, to, env, changes, converted } = write
  const action = write.keep?.action ?? 'The restore'
  const blobs = new Map(converted.map((path) => [path, changes.get(path)!.fromBlob]))
  // As Git refuses a file whose normal form changed since the snapshot: the merge was worked out from that snapshot.
  const listed = new Set(nul(await gitAsync(top, ['diff-files', '--name-only', '-z'], env, undefined, LISTING)))
  const stale: string[] = []
  for (const path of converted) if (listed.has(path) && await lstat(join(top, path)).then(() => true, () => false)) stale.push(path)
  if (stale.length) throw new Error(`${action} stopped because ${namedPaths(stale)} changed after the files were read. Nothing was changed; try again.`)

  const keptAt = new Map<string, string>()
  let windowMs: number | undefined
  /** Reads `paths`, keeps what is not held, and returns the proofs whose bytes are held or kept, and the paths that changed. */
  const readAndKeep = async (paths: readonly string[]): Promise<{ proofs: FrozenEntryProof[]; changed: string[] }> => {
    const { read, changed } = await readConvertedAsync(top, blobs, paths)
    const unheld = read.filter((entry) => !entry.held)
    let copy: { ref: string; digests?: ReadonlyMap<string, string> } | undefined
    if (unheld.length && write.keep) {
      const kept = await keepCopy({ owner: write.keep.owner, top, operationType: 'restore-keep', action: write.keep.action, paths: unheld.map((entry) => entry.path) })
      copy = { ref: kept.ref, digests: kept.digests }
      windowMs = kept.windowMs
    } else if (unheld.length) {
      copy = await runAsync(preserveFiles(top, unheld.map((entry) => entry.path), write.directory, write.operationId))
    }
    const proofs: FrozenEntryProof[] = []
    for (const entry of read) {
      // The copy reads each file again: it must hold the very bytes compared, or the file changed in between.
      if (!entry.held && copy?.digests && copy.digests.get(entry.path) !== entry.proof.entry.digest) { changed.push(entry.path); continue }
      if (!entry.held) keptAt.set(entry.path, copy!.ref)
      proofs.push(entry.proof)
    }
    return { proofs, changed }
  }

  // 1. Read, compare and keep, with nothing written yet.
  const proven = new Map<string, FrozenEntryProof>()
  for (let round = 1, pending: readonly string[] = converted; ; round++) {
    const { proofs, changed } = await readAndKeep(pending)
    for (const proof of proofs) proven.set(proof.entry.path, proof)
    if (!changed.length) break
    if (round >= KEEP_ROUNDS) {
      const one = changed.length === 1
      throw new Error(`${action} stopped because ${namedPaths(changed)} kept changing while ${one ? 'its' : 'their'} copy was being kept. Nothing was changed; try again once ${one ? 'it has' : 'they have'} stopped changing.`)
    }
    pending = changed
  }

  // 2. Git moves everything else. The converted paths keep `from`'s entry in its target, and target paths in their way
  // are left for step 4: inside one, a file where one has a folder, or (on a disk that folds case) another spelling of
  // one, which Git would write over it.
  const ignoreCase = (await tryGitAsync(top, ['config', '--bool', 'core.ignorecase'])).stdout === 'true'
  const fold = (path: string): string => (ignoreCase ? path.toLowerCase() : path)
  const ancestors = (path: string): string[] => path.split('/').slice(0, -1).map((_, depth, parts) => parts.slice(0, depth + 1).join('/'))
  const exactly = new Set(converted)
  const mine = new Set(converted.map(fold))
  const aboveMine = new Set(converted.flatMap(ancestors).map(fold))
  const inTheirWay = [...changes.entries()].filter(([path, change]) => change.toMode !== '000000' && !exactly.has(path)
    && (mine.has(fold(path)) || aboveMine.has(fold(path)) || ancestors(path).some((above) => mine.has(fold(above))))).map(([path]) => path)
  // Folders the result still has: one emptied on the way is never removed, so it keeps its identity.
  const kept = new Set([...changes.entries()].filter(([, change]) => change.toMode !== '000000').flatMap(([path]) => ancestors(path)).map(fold))
  const target = join(write.directory, `restore-target-${randomUUID()}.index`)
  try {
    await gitAsync(top, ['read-tree', to], { GIT_INDEX_FILE: target })
    const lines = [
      ...inTheirWay.map((path) => `0 ${'0'.repeat(from.length)}\t${path}`),
      ...converted.map((path) => { const change = changes.get(path)!; return `${change.fromMode} ${change.fromBlob}\t${path}` })
    ]
    await gitAsync(top, ['update-index', '-z', '--index-info'], { GIT_INDEX_FILE: target }, lines.join('\0') + '\0')
    const around = await gitAsync(top, ['write-tree'], { GIT_INDEX_FILE: target })
    await gitAsync(top, ['read-tree', '-m', '-u', from, around], env)
  } finally {
    await rm(target, { force: true })
  }

  // 3. Mousse removes what it has proven (`removeProvenAsync`), each entry right after its last check. A target file
  // whose place holds a folder goes with that folder, whose other files must be the ones this restore kept first.
  const digests = new Map([...proven.values()].map((proof) => [proof.entry.path, proof.entry.digest]))
  const folderTargets = inTheirWay.filter((path) => aboveMine.has(fold(path)))
  if (write.preserved) for (const path of write.preserved.paths.filter((path) => folderTargets.some((folder) => path.startsWith(`${folder}/`)))) digests.set(path, await keptDigest(top, write.preserved.ref, path))
  const run = ownGitRunner(top)
  const skipped = new Map<string, string>()
  let pending = converted.slice()
  let targets = folderTargets
  for (let round = 1; ; round++) {
    const restore = [...pending.filter((path) => changes.get(path)!.toMode !== '000000'), ...targets]
    const remove = pending.filter((path) => changes.get(path)!.toMode === '000000')
    const { left } = await removeProvenAsync({ top, restore, remove, digests, keepFolder: (rel) => kept.has(fold(rel)) })
    const changed = [...new Set(left.map((entry) => entry.path))]
    // A folder whose other files changed since they were kept stays as it is.
    for (const path of changed.filter((path) => !exactly.has(path))) skipped.set(path, CHANGED_WHILE_WRITING)
    pending = changed.filter((path) => exactly.has(path))
    targets = []
    if (!pending.length) break
    if (round >= KEEP_ROUNDS) { for (const path of pending) skipped.set(path, CHANGED_WHILE_WRITING); break }
    // Files Git has already written are not taken back: one that cannot be kept now is left as it is.
    const again = await readAndKeep(pending).catch(() => undefined)
    if (!again) { for (const path of pending) skipped.set(path, CHANGED_WHILE_WRITING); break }
    for (const proof of again.proofs) digests.set(proof.entry.path, proof.entry.digest)
  }

  // 4. Git writes the new versions only where nothing is (`createOnlyAsync`), and every path it did not write is named.
  // Skipped paths, and every folder above one: a path is blocked when it is one, lies under one, or holds one.
  const skippedAbove = new Set([...skipped.keys()].flatMap(ancestors))
  const blocked = (path: string): boolean => skipped.has(path) || skippedAbove.has(path) || ancestors(path).some((above) => skipped.has(above))
  const toCreate = [...converted.filter((path) => changes.get(path)!.toMode !== '000000'), ...inTheirWay].filter((path) => !blocked(path))
  const { notWritten } = await createOnlyAsync(top, run, toCreate, to)
  for (const [path, why] of notWritten) skipped.set(path, why.reason === 'failed' ? `Git could not write it${why.detail ? `: ${why.detail}` : ''}` : CHANGED_WHILE_WRITING)
  const leftAsIs = [...skipped].sort(([a], [b]) => a.localeCompare(b)).map(([path, reason]) => ({ path, reason }))
  const files = [...keptAt].map(([path, ref]) => {
    const kind = restoreKindOf(changes.get(path)?.fromMode)
    return { path, ref, ...(kind !== 'file' ? { kind } : {}) }
  }).sort((a, b) => a.path.localeCompare(b.path))
  return { ...(files.length ? { exact: { files, top, ...(windowMs !== undefined ? { windowMs } : {}) } } : {}), leftAsIs }
}


/**
 * How far a move of the files from one tree to another got, read path by path from the disk (bytes and mode), for the
 * paths the two trees hold differently: still as in `from` (`unmoved`), as in `to` (`moved`), or neither (`other`,
 * changed by someone since). Ignored files count, since the disk is read directly; files the move never touches do
 * not. A nested repository recorded by its commit is left out. `emptied`: paths in `other` that both trees hold and the
 * disk does not, as a restore leaves a file it removed before Git wrote its new version (`writeConvertedAsync`).
 */
export interface MoveProgress { moved: string[]; unmoved: string[]; other: string[]; emptied?: string[] }

/**
 * Whether a move that stopped landed: every path exactly as planned (`applied`), none of them (`not-applied`), or some
 * only, or some moved and others changed since (`partial`), which is for a person: recording those as moved would make
 * an edit made since part of the result, and a later Redo or switch would write over it.
 */
export function moveOutcome(progress: MoveProgress): 'applied' | 'not-applied' | 'partial' {
  // A path both sides hold, now empty: the restore had started to write. It is never taken as not done.
  if (progress.emptied?.length) return 'partial'
  if (!progress.moved.length) return progress.unmoved.length || progress.other.length ? 'not-applied' : 'applied'
  return progress.unmoved.length || progress.other.length ? 'partial' : 'applied'
}

export function* moveProgressSteps(cwd: string, from: string, to: string): Steps<MoveProgress> {
  const top = yield* gitStep(cwd, ['rev-parse', '--show-toplevel'])
  const progress: MoveProgress = { moved: [], unmoved: [], other: [], emptied: [] }
  const paths = (yield* gitStep(top, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', from, to], undefined, undefined, LISTING)).split('\0').filter(Boolean)
  if (!paths.length) return progress
  const wanted = new Set(paths)
  const entries = function* (tree: string): Steps<Map<string, { mode: string; sha: string }>> {
    const map = new Map<string, { mode: string; sha: string }>()
    for (const line of (yield* gitStep(top, ['ls-tree', '-r', '-z', '--full-tree', tree], undefined, undefined, LISTING)).split('\0')) {
      const tab = line.indexOf('\t')
      if (tab < 0 || !wanted.has(line.slice(tab + 1))) continue
      const [mode, , sha] = line.slice(0, tab).split(' ')
      map.set(line.slice(tab + 1), { mode: mode!, sha: sha! })
    }
    return map
  }
  const before = yield* entries(from)
  const after = yield* entries(to)
  // What is on disk at each path: a file's blob as `git add` would store it (filters applied), a link's target, or nothing.
  const found = new Map<string, { mode: string; sha: string }>()
  const files: string[] = []
  for (const path of paths) {
    if (before.get(path)?.mode === '160000' || after.get(path)?.mode === '160000') continue
    let stat: Stats
    try { stat = yield* disk.lstat(join(top, path)) } catch { continue }
    if (stat.isSymbolicLink()) found.set(path, { mode: '120000', sha: yield* gitStep(top, ['hash-object', '--stdin'], undefined, yield* disk.readlink(join(top, path))) })
    else if (stat.isFile()) {
      found.set(path, { mode: stat.mode & 0o111 ? '100755' : '100644', sha: '' })
      if (path.includes('\n')) found.get(path)!.sha = yield* gitStep(top, ['hash-object', '--', path])
      else files.push(path)
    }
  }
  if (files.length) {
    const shas = (yield* gitStep(top, ['hash-object', '--stdin-paths'], undefined, files.join('\n') + '\n')).split(/\r?\n/)
    files.forEach((path, index) => { found.get(path)!.sha = shas[index] ?? '' })
  }
  // A disk that keeps no executable bit (Windows, FAT, exFAT, some network drives: Git sets `core.fileMode` false there)
  // reads every file as executable or none, so only the bytes are compared there.
  const fileMode = process.platform !== 'win32' && (yield* tryGitStep(top, ['config', '--bool', 'core.fileMode'])).stdout.trim() !== 'false'
  const same = (a?: { mode: string; sha: string }, b?: { mode: string; sha: string }): boolean =>
    !a || !b ? a === b : a.sha === b.sha && (!fileMode || a.mode === b.mode)
  for (const path of paths) {
    if (before.get(path)?.mode === '160000' || after.get(path)?.mode === '160000') continue
    const now = found.get(path)
    if (same(now, before.get(path))) progress.unmoved.push(path)
    else if (same(now, after.get(path))) progress.moved.push(path)
    else {
      progress.other.push(path)
      if (!now && before.has(path) && after.has(path)) progress.emptied!.push(path)
    }
  }
  return progress
}

/** How far a move got (see `moveProgressSteps`), without blocking the daemon. */
export function moveProgressAsync(cwd: string, from: string, to: string): Promise<MoveProgress> {
  return runAsync(moveProgressSteps(cwd, from, to))
}
