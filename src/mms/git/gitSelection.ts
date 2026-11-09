/**
 * What the next commit takes, chosen hunk by hunk (`git.changes`, `git.include`, a commit with `selection`).
 *
 * The person sees HEAD → working tree as hunks in Git's clean form. What they choose is the **selection**:
 * - In a project folder it is the real index. Mousse writes it only for what the person chose, never rebuilds an entry
 *   it cannot explain (an index entry that is neither HEAD nor HEAD plus some of the hunks is `indexDiverged`), and
 *   keeps a marker, outside `.git`, for the one state the index cannot hold by itself: everything left out.
 * - In a thread worktree it is an overlay in the thread's folder: only the paths the person changed, each with the
 *   entry chosen and the HEAD entry it was chosen against. A commit builds its index fresh from the current HEAD, the
 *   working tree, and the overlay entries that still hold.
 *
 * Hunk edits never touch the working tree and never run a filter: a chosen version is built from Git's clean form of
 * HEAD and of the working tree and stored with `hash-object --no-filters`. A file whose bytes might not survive that
 * (a filter or clean driver, `ident`, `working-tree-encoding`) is whole-file only, and a whole file is staged by Git.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { AppError, createErrorProvider } from '../../shared/errors'
import type { GitChangedFile, GitChangeHunk, GitChangeLine, GitIncluded, GitSelectionState } from '../../shared/types'
import { privateIndexEnv } from './gitEnv'
import type { GitRun } from './gitProcess'
import { NO_DIFF_PROGRAMS } from './repoPrograms'

export const selectionErrors = createErrorProvider({
  stale: { category: 'conflict', retryable: false, message: 'The changes moved on since they were shown. Look at them again, then try again.' },
  whole_file_only: { category: 'invalid', retryable: false, message: 'Only the whole file can be included or left out.' },
  nothing_selected: { category: 'invalid', retryable: false, message: 'Include something to commit.' },
  git_undo_root: { category: 'invalid', retryable: false, message: 'The first commit of a branch cannot be undone here.' },
  git_undo_merge: { category: 'invalid', retryable: false, message: 'A merge commit cannot be undone here.' }
})

/** Where a folder's selection lives. */
export type SelectionPlace =
  /** A project folder: the real index, plus the "everything left out" marker in the project's own data folder. */
  | { kind: 'project'; markerFile: string; keepOwner?: string; assertIdle?: () => void }
  /** A thread worktree: the overlay file in the thread's folder. */
  | { kind: 'thread'; overlayFile: string; assertIdle?: () => void }
// `assertIdle` refuses a change while a turn works in the folder; it runs inside the folder's Git queue, right before the change.

/** How the selection code runs Git in the repository's top folder. */
export interface SelectionGit {
  /** Mousse's own command: no hook or repository program runs, nothing is refreshed. */
  read(args: readonly string[], options?: { env?: Record<string, string>; input?: string }): Promise<GitRun>
  /** Mousse's own command, with binary input and output. */
  bytes(args: readonly string[], options?: { env?: Record<string, string>; input?: Buffer }): Promise<{ ok: boolean; stdout: Buffer; stderr: string }>
}

/** More files than this are not listed (`truncated`). */
export const SELECTION_MAX_FILES = 3000
/** A side of a file larger than this has no hunks (`tooLarge`). */
export const SELECTION_MAX_FILE_BYTES = 1024 * 1024
/** A side of a file with more lines than this has no hunks (`tooLarge`). */
export const SELECTION_MAX_FILE_LINES = 20_000
/** A hunk longer than this can be included or left out only as a whole. */
const LINE_LEVEL_MAX_HUNK = 2000
/** The alignment gives up (and reports the file as diverged) when it would follow more possibilities than this at once. */
const ALIGN_MAX_STATES = 20_000
/** Hunk lines' text one answer carries at most; files past it are listed without hunks (`tooLarge`). */
export const SELECTION_MAX_ANSWER_BYTES = 32 * 1024 * 1024
/** Files read per `update-index` run; a run that fails reads its files one by one. */
const HASH_BATCH = 500
/** Files read at once. */
const CONCURRENCY = 8

export interface Entry { mode: string; oid: string }

export const sameEntry = (a: Entry | null | undefined, b: Entry | null | undefined): boolean => (!a && !b) || (!!a && !!b && a.mode === b.mode && a.oid === b.oid)
const sha = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 32)
export const isMoussePath = (path: string): boolean => path === '.mousse' || path.startsWith('.mousse/')
const REGULAR = new Set(['100644', '100755'])
const LINK = '120000'
const GITLINK = '160000'

// ---------------------------------------------------------------------------------------------------------
// Stores

interface MarkerFile { version: 1; top: string; head: string; index: string }

/** One path of a thread's overlay: the entry chosen (null: left out), and the HEAD and working-tree entries it was chosen against. */
export interface OverlayEntry { head: Entry | null; working: Entry | null; chosen: Entry | null }
export interface Overlay { version: 1; epoch: string; revision: number; entries: Record<string, OverlayEntry> }

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value))
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function readOverlay(file: string): Promise<Overlay> {
  const found = await readJson<Overlay>(file)
  if (found && found.version === 1 && typeof found.revision === 'number' && found.entries && typeof found.entries === 'object' && typeof found.epoch === 'string') return found
  // No overlay yet: a fixed epoch, so the token stays the same from one read to the next.
  return { version: 1, epoch: '', revision: 0, entries: {} }
}

/**
 * Writes the overlay with the next revision. The revision only grows, and the first write picks a new epoch, so an older
 * token never matches a newer overlay, even after the file was removed.
 */
export async function writeOverlay(file: string, overlay: Overlay, entries: Record<string, OverlayEntry>): Promise<Overlay> {
  const next: Overlay = { version: 1, epoch: overlay.epoch || randomUUID(), revision: overlay.revision + 1, entries }
  await writeJsonAtomic(file, next)
  return next
}

async function readMarker(file: string): Promise<MarkerFile | null> {
  const found = await readJson<MarkerFile>(file)
  return found && found.version === 1 && typeof found.head === 'string' && typeof found.index === 'string' ? found : null
}

export async function recordMarker(file: string, top: string, head: string | null, index: string): Promise<void> {
  await writeJsonAtomic(file, { version: 1, top: resolve(top), head: head ?? '', index } satisfies MarkerFile)
}

export async function clearMarker(file: string): Promise<void> {
  await rm(file, { force: true })
}

/**
 * Clears a marker recorded for another HEAD: any HEAD change ends "everything left out", so a switch away and back
 * does not bring it back. HEAD is read again first, so a marker recorded meanwhile for a newer HEAD stays.
 */
export async function dropMarkerOfOtherHead(git: SelectionGit, file: string, head: string | null): Promise<void> {
  const marker = await readMarker(file)
  if (!marker || marker.head === (head ?? '')) return
  const now = await git.read(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => null)
  if (!now) return
  if (marker.head !== (now.ok ? now.stdout.trim() : '')) await clearMarker(file)
}

/** Whether the marker in `file` was recorded for this HEAD and this index. */
export async function markerMatches(file: string, top: string, head: string | null, indexDigest: string): Promise<boolean> {
  const marker = await readMarker(file)
  return Boolean(marker && marker.head === (head ?? '') && marker.index === indexDigest && resolve(marker.top) === resolve(top))
}

// ---------------------------------------------------------------------------------------------------------
// Reading the repository

interface PathState {
  path: string
  head: Entry | null
  index: Entry | null
  /** Every `ls-files -s` line of the path, conflict stages included. */
  stages: string[]
  conflicted: boolean
  work: Entry | null
  /** False when the working tree's version could not be read. */
  workKnown: boolean
  /** Raw size on disk, for the size limit. */
  workSize?: number
}

/** What one read of the repository found, before the selection is applied. */
export interface Collected {
  top: string
  head: string | null
  objectFormat: 'sha1' | 'sha256'
  emptyBlob: string
  indexDigest: string
  /** The index holds exactly HEAD's entries (no staged change, no conflict). */
  indexEqualsHead: boolean
  unmerged: boolean
  paths: Map<string, PathState>
  /** New path → old path of a rename Git records in the index. */
  renames: Map<string, string>
}

function objectName(format: string, kind: string, content: Buffer): string {
  return createHash(format === 'sha256' ? 'sha256' : 'sha1').update(`${kind} ${content.length}\0`).update(content).digest('hex')
}

interface RawRecord { srcMode: string; dstMode: string; srcSha: string; dstSha: string; status: string; path: string; from?: string }

function parseRaw(output: string): RawRecord[] {
  const fields = output.split('\0')
  const records: RawRecord[] = []
  for (let index = 0; index < fields.length;) {
    const header = fields[index++]
    if (!header?.startsWith(':')) continue
    const [srcMode, dstMode, srcSha, dstSha, status] = header.slice(1).split(' ')
    if (!status) continue
    const letter = status[0]!
    if (letter === 'R' || letter === 'C') {
      const from = fields[index++] ?? ''
      records.push({ srcMode: srcMode!, dstMode: dstMode!, srcSha: srcSha!, dstSha: dstSha!, status: letter, path: fields[index++] ?? '', from })
    } else records.push({ srcMode: srcMode!, dstMode: dstMode!, srcSha: srcSha!, dstSha: dstSha!, status: letter, path: fields[index++] ?? '' })
  }
  return records
}

const isZero = (oid: string): boolean => /^0+$/.test(oid)

export function gitFailure(run: GitRun | { stderr: string }, fallback: string): AppError {
  const text = ('output' in run ? run.output : run.stderr).trim()
  return new AppError({ code: 'git_failed', message: text || fallback, errorInfo: { category: 'invalid', retryable: false } })
}

async function must(run: Promise<GitRun>, what: string): Promise<string> {
  const done = await run
  if (!done.ok) throw gitFailure(done, `git ${what} failed`)
  return done.stdout
}

/** Reads HEAD, the index and the working tree of every changed path. Nothing is written but blobs (`hash-object -w`). */
export async function collect(git: SelectionGit, top: string): Promise<Collected> {
  const format = (await git.read(['rev-parse', '--show-object-format'])).stdout.trim() === 'sha256' ? 'sha256' : 'sha1'
  const headRun = await git.read(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  const head = headRun.ok ? headRun.stdout.trim() || null : null
  const headTree = head ? `${head}^{tree}` : objectName(format, 'tree', Buffer.alloc(0))
  const [indexList, staged, unstaged, untracked] = await Promise.all([
    must(git.read(['ls-files', '-s', '-z']), 'ls-files'),
    must(git.read(['diff-index', '--cached', '-z', '--raw', '-M', '--no-abbrev', headTree, '--']), 'diff-index'),
    must(git.read(['diff-files', '-z', '--raw', '--no-abbrev', '--ignore-submodules=dirty', '--']), 'diff-files'),
    must(git.read(['ls-files', '-z', '--others', '--exclude-standard', '--']), 'ls-files')
  ])

  const paths = new Map<string, PathState>()
  const state = (path: string): PathState => {
    let found = paths.get(path)
    if (!found) paths.set(path, found = { path, head: null, index: null, stages: [], conflicted: false, work: null, workKnown: true })
    return found
  }
  const indexEntries = new Map<string, { stages: string[]; zero?: Entry; conflicted: boolean }>()
  for (const line of indexList.split('\0')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const [mode, oid, stage] = line.slice(0, tab).split(' ')
    const path = line.slice(tab + 1)
    let entry = indexEntries.get(path)
    if (!entry) indexEntries.set(path, entry = { stages: [], conflicted: false })
    entry.stages.push(line)
    if (stage === '0') entry.zero = { mode: mode!, oid: oid! }
    else entry.conflicted = true
  }
  const unmerged = [...indexEntries.values()].some((entry) => entry.conflicted)
  const fromIndex = (path: string): PathState => {
    const entry = indexEntries.get(path)
    const found = state(path)
    found.stages = entry?.stages ?? []
    found.index = entry?.zero ?? null
    found.conflicted = entry?.conflicted ?? false
    return found
  }
  const stagedRecords = parseRaw(staged).filter((record) => record.status !== 'U')
  const renames = new Map<string, string>()
  const stagedPaths = new Set<string>()
  for (const record of stagedRecords) {
    if (record.status === 'R' && record.from !== undefined) {
      renames.set(record.path, record.from)
      fromIndex(record.from).head = { mode: record.srcMode, oid: record.srcSha }
      fromIndex(record.path).head = null
      stagedPaths.add(record.from).add(record.path)
      continue
    }
    fromIndex(record.path).head = record.status === 'A' ? null : { mode: record.srcMode, oid: record.srcSha }
    stagedPaths.add(record.path)
  }
  for (const [path, entry] of indexEntries) if (entry.conflicted) fromIndex(path)
  // Paths whose working tree differs from the index by stat: their version is read below.
  const unsure = new Map<string, RawRecord>()
  for (const record of parseRaw(unstaged)) {
    if (record.status === 'U') continue
    fromIndex(record.path)
    unsure.set(record.path, record)
  }
  const untrackedPaths = untracked.split('\0').filter(Boolean)
  for (const path of untrackedPaths) fromIndex(path)

  // HEAD's entry where the index equals HEAD (no staged record) is the index's; a conflicted path's is read from HEAD.
  const conflictedHeads: string[] = []
  for (const found of paths.values()) {
    if (stagedPaths.has(found.path)) continue
    if (found.conflicted) conflictedHeads.push(found.path)
    else found.head = found.index
  }
  if (head && conflictedHeads.length) {
    for (const path of conflictedHeads) state(path).head = await headEntryOf(git, head, path)
  }

  // The working tree's version, in Git's clean form.
  const toHash: PathState[] = []
  const untrackedSet = new Set(untrackedPaths)
  for (const found of paths.values()) {
    const record = unsure.get(found.path)
    if (record) {
      if (record.status === 'D') { found.work = null; continue }
      if (!isZero(record.dstSha)) { found.work = { mode: record.dstMode, oid: record.dstSha }; continue }
      found.work = { mode: record.dstMode, oid: '' }
      toHash.push(found)
      continue
    }
    if (untrackedSet.has(found.path) || found.conflicted) {
      found.work = { mode: '', oid: '' }
      toHash.push(found)
      continue
    }
    // Not changed since the index by stat: the index's version (none when the index has no entry).
    found.work = found.index
  }
  await hashWorking(git, top, toHash)
  return { top, head, objectFormat: format, emptyBlob: objectName(format, 'blob', Buffer.alloc(0)), indexDigest: sha(indexList), indexEqualsHead: !unmerged && stagedRecords.length === 0, unmerged, paths, renames }
}

/** HEAD, the digest of the index (as the token uses it), and whether the index holds exactly HEAD. */
export async function indexState(git: SelectionGit): Promise<{ head: string | null; indexDigest: string; indexEqualsHead: boolean }> {
  const format = (await git.read(['rev-parse', '--show-object-format'])).stdout.trim() === 'sha256' ? 'sha256' : 'sha1'
  const headRun = await git.read(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  const head = headRun.ok ? headRun.stdout.trim() || null : null
  const indexList = await must(git.read(['ls-files', '-s', '-z']), 'ls-files')
  const unmerged = indexList.split('\0').some((line) => / [123]\t/.test(line))
  const same = await git.read(['diff-index', '--cached', '--quiet', head ? `${head}^{tree}` : objectName(format, 'tree', Buffer.alloc(0)), '--'])
  return { head, indexDigest: sha(indexList), indexEqualsHead: !unmerged && same.ok }
}

/** HEAD's entry of one path, or null. */
export async function headEntryOf(git: SelectionGit, head: string | null, path: string): Promise<Entry | null> {
  if (!head) return null
  const run = await git.read(['ls-tree', '-z', '--full-tree', head, '--', path], { env: { GIT_LITERAL_PATHSPECS: '1' } })
  const line = run.ok ? run.stdout.split('\0').find((item) => item.endsWith(`\t${path}`)) : undefined
  if (!line) return null
  const [mode, , oid] = line.slice(0, line.indexOf('\t')).split(' ')
  return { mode: mode!, oid: oid! }
}

/**
 * Reads each path's working-tree entry exactly as `git add` would store it: `update-index --add` into a private index
 * seeded with the path's current index entries, so Git converts it the same way (a file committed with CRLF keeps CRLF
 * under `core.autocrlf`). Files within the size limit are written as blobs; larger ones are only hashed. A nested
 * repository is recorded as a link to its HEAD, as `git add` records it, without running Git inside it. Paths go on
 * standard input, so no command line grows with them.
 */
async function hashWorking(git: SelectionGit, top: string, states: PathState[]): Promise<void> {
  const present: Array<{ found: PathState; name: string; fallback: string }> = []
  for (const found of states) {
    const name = found.path.replace(/\/$/, '')
    const info = await lstat(join(top, name)).catch(() => null)
    if (!info) { found.work = null; continue }
    found.workSize = info.isFile() ? info.size : 0
    // The mode shown when Git cannot read the path.
    const regular = found.work?.mode && REGULAR.has(found.work.mode) ? found.work.mode : found.index && REGULAR.has(found.index.mode) ? found.index.mode : '100644'
    present.push({ found, name, fallback: info.isSymbolicLink() ? LINK : info.isDirectory() ? GITLINK : regular })
  }
  if (!present.length) return
  const unknown = (item: (typeof present)[number]): void => {
    item.found.work = { mode: item.fallback, oid: '' }
    item.found.workKnown = false
  }
  const run = async (args: readonly string[], env: Record<string, string>, input: string): Promise<GitRun | null> => git.read(args, { env, input }).catch(() => null)
  const gitDir = (await run(['rev-parse', '--absolute-git-dir'], {}, ''))?.stdout.trim()
  if (!gitDir) {
    present.forEach(unknown)
    return
  }
  await sweepSelectionIndexes(gitDir)
  // In the Git folder, where Mousse may write an index of its own.
  const file = join(gitDir, `${SELECTION_INDEX_PREFIX}read-${randomUUID()}.index`)
  try {
    const env = privateIndexEnv(file)
    const seed = present.flatMap((item) => item.found.stages)
    if (seed.length && !(await run(['update-index', '-z', '--index-info'], env, nulList(seed)))?.ok) {
      present.forEach(unknown)
      return
    }
    const small = present.filter((item) => (item.found.workSize ?? 0) <= SELECTION_MAX_FILE_BYTES)
    const large = present.filter((item) => (item.found.workSize ?? 0) > SELECTION_MAX_FILE_BYTES)
    const failed = new Set<PathState>()
    const add = async (part: typeof present, write: boolean): Promise<boolean> =>
      Boolean((await run(['update-index', '--add', '--remove', '--replace', ...(write ? [] : ['--info-only']), '-z', '--stdin'], env, nulList(part.map((item) => item.name))))?.ok)
    for (const [items, write] of [[small, true], [large, false]] as const) {
      for (const part of chunks(items, HASH_BATCH)) {
        if (await add(part, write)) continue
        // A path that cannot be read fails the whole run: each is read alone.
        for (const item of part) if (!await add([item], write)) failed.add(item.found)
      }
    }
    const listed = await run(['ls-files', '-s', '-z'], env, '')
    const entries = new Map<string, Entry>()
    for (const line of listed?.ok ? listed.stdout.split('\0') : []) {
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const [mode, oid, stage] = line.slice(0, tab).split(' ')
      if (stage === '0') entries.set(line.slice(tab + 1), { mode: mode!, oid: oid! })
    }
    for (const item of present) {
      if (!listed?.ok || failed.has(item.found)) unknown(item)
      else item.found.work = entries.get(item.name) ?? null
    }
  } finally {
    await rm(file, { force: true }).catch(() => undefined)
    await rm(`${file}.lock`, { force: true }).catch(() => undefined)
  }
}

/** The private index files the selection reads and commits through, in the Git folder. */
export const SELECTION_INDEX_PREFIX = 'mousse-selection-'
/** A private index older than this was left by a run that stopped (a crash): no read or commit takes this long. */
const SELECTION_INDEX_STALE_MS = 60 * 60 * 1000

/** Removes private indexes a stopped run left in `gitDir`. */
export async function sweepSelectionIndexes(gitDir: string): Promise<void> {
  const names = await readdir(gitDir).catch(() => [] as string[])
  const now = Date.now()
  await Promise.all(names.filter((name) => name.startsWith(SELECTION_INDEX_PREFIX) && /\.index(\.lock)?$/.test(name)).map(async (name) => {
    const full = join(gitDir, name)
    const info = await stat(full).catch(() => null)
    if (info && now - info.mtimeMs > SELECTION_INDEX_STALE_MS) await rm(full, { force: true }).catch(() => undefined)
  }))
}

const nulList = (items: readonly string[]): string => `${items.join('\0')}\0`

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Hunks and alignment

/** A file's content as lines, each with its own line ending; the last may have none. */
export function splitLines(content: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let start = 0
  for (let index = 0; index < content.length; index++) {
    if (content[index] === 0x0a) {
      lines.push(content.subarray(start, index + 1))
      start = index + 1
    }
  }
  if (start < content.length) lines.push(content.subarray(start))
  return lines
}

/** One hunk's structure from `git diff -U3`; the lines' bytes are taken from the two versions by their numbers. */
export interface HunkShape { oldStart: number; oldLines: number; newStart: number; newLines: number; kinds: Array<' ' | '-' | '+'> }

/** The hunks of a `git diff` of two blobs, `binary`, or null when the output cannot be read. */
export function parseHunks(diff: string): HunkShape[] | 'binary' | null {
  const hunks: HunkShape[] = []
  let current: HunkShape | null = null
  let olds = 0
  let news = 0
  for (const line of diff.split('\n')) {
    if (current && (olds < current.oldLines || news < current.newLines)) {
      if (line.startsWith('\\')) continue
      // `diff.suppressBlankEmpty` prints an empty context line without its space.
      const kind = line === '' ? ' ' : line[0]
      if (kind !== ' ' && kind !== '-' && kind !== '+') return null
      current.kinds.push(kind)
      if (kind !== '+') olds++
      if (kind !== '-') news++
      continue
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      current = { oldStart: Number(header[1]), oldLines: header[2] === undefined ? 1 : Number(header[2]), newStart: Number(header[3]), newLines: header[4] === undefined ? 1 : Number(header[4]), kinds: [] }
      hunks.push(current)
      olds = 0
      news = 0
      continue
    }
    if (!current && /^Binary files /.test(line)) return 'binary'
  }
  if (current && (olds !== current.oldLines || news !== current.newLines)) return null
  return hunks
}

export interface BuiltHunk {
  shape: HunkShape
  id: string
  lines: GitChangeLine[]
  /** Each line's bytes: HEAD's for ' ' and '-', the working tree's for '+'. */
  bytes: Buffer[]
  /** Too long to choose line by line: only the whole hunk. */
  block: boolean
}

export function buildHunks(shapes: HunkShape[], head: Buffer[], work: Buffer[]): BuiltHunk[] | null {
  const built: BuiltHunk[] = []
  for (const shape of shapes) {
    // A side with no lines names the line before it.
    let oldNo = shape.oldLines === 0 ? shape.oldStart + 1 : shape.oldStart
    let newNo = shape.newLines === 0 ? shape.newStart + 1 : shape.newStart
    const lines: GitChangeLine[] = []
    const bytes: Buffer[] = []
    for (const kind of shape.kinds) {
      const source = kind === '+' ? work[newNo - 1] : head[oldNo - 1]
      if (source === undefined) return null
      bytes.push(source)
      const text = source.toString('utf8').replace(/\n$/, '')
      if (kind === ' ') lines.push({ kind, text, oldNo: oldNo++, newNo: newNo++ })
      else if (kind === '-') lines.push({ kind, text, oldNo: oldNo++ })
      else lines.push({ kind, text, newNo: newNo++ })
    }
    const id = sha({ oldStart: shape.oldStart, lines: lines.map((line, index) => [line.kind, bytes[index]!.toString('base64')]) })
    built.push({ shape, id, lines, bytes, block: lines.length > LINE_LEVEL_MAX_HUNK })
  }
  return built
}

/** Per hunk, per line: whether that line's change is chosen (context lines are always true). */
export type Choices = boolean[][]

type Item =
  | { kind: 'fixed'; line: Buffer }
  | { kind: 'del' | 'add'; line: Buffer; hunk: number; index: number }
  | { kind: 'block'; head: Buffer[]; work: Buffer[]; hunk: number }

function itemsOf(head: Buffer[], hunks: BuiltHunk[]): Item[] {
  const items: Item[] = []
  let position = 0
  hunks.forEach((hunk, number) => {
    const start = hunk.shape.oldLines === 0 ? hunk.shape.oldStart : hunk.shape.oldStart - 1
    for (; position < start; position++) items.push({ kind: 'fixed', line: head[position]! })
    if (hunk.block) {
      items.push({ kind: 'block', head: hunk.bytes.filter((_, index) => hunk.lines[index]!.kind !== '+'), work: hunk.bytes.filter((_, index) => hunk.lines[index]!.kind !== '-'), hunk: number })
    } else {
      hunk.lines.forEach((line, index) => {
        if (line.kind === ' ') items.push({ kind: 'fixed', line: hunk.bytes[index]! })
        else items.push({ kind: line.kind === '-' ? 'del' : 'add', line: hunk.bytes[index]!, hunk: number, index })
      })
    }
    position = start + hunk.shape.oldLines
  })
  for (; position < head.length; position++) items.push({ kind: 'fixed', line: head[position]! })
  return items
}

/** Every change chosen (`true`) or none. */
export function uniformChoices(hunks: BuiltHunk[], value: boolean): Choices {
  return hunks.map((hunk) => hunk.lines.map((line) => (line.kind === ' ' ? true : value)))
}

/** The content HEAD plus the chosen changes makes. A block hunk is taken whole when any of its changes is chosen. */
export function applyChoices(head: Buffer[], hunks: BuiltHunk[], choices: Choices): Buffer {
  const out: Buffer[] = []
  for (const item of itemsOf(head, hunks)) {
    if (item.kind === 'fixed') out.push(item.line)
    else if (item.kind === 'block') {
      const lines = hunks[item.hunk]!.lines
      out.push(...(choices[item.hunk]!.some((value, index) => value && lines[index]!.kind !== ' ') ? item.work : item.head))
    } else {
      const chosen = choices[item.hunk]![item.index]!
      if (item.kind === 'del' ? !chosen : chosen) out.push(item.line)
    }
  }
  return Buffer.concat(out)
}

const linesEqual = (lines: Buffer[], at: number, expected: Buffer[]): boolean => expected.every((line, index) => lines[at + index]?.equals(line) ?? false)

/**
 * Which changes `selected` holds when it is HEAD plus some of the hunks' changes: choices that rebuild it exactly.
 * Null when it is not (diverged), or when telling would take too long. Where two choices give the same content, the
 * change is read as chosen.
 */
export function alignChoices(head: Buffer[], hunks: BuiltHunk[], selected: Buffer[]): Choices | null {
  const items = itemsOf(head, hunks)
  let positions: number[] = [0]
  const history: Array<{ prev: number[]; chosen: boolean[] }> = []
  for (const item of items) {
    const next: number[] = []
    const prev: number[] = []
    const chosen: boolean[] = []
    const seen = new Set<number>()
    const add = (position: number, from: number, value: boolean): void => {
      if (position > selected.length || seen.has(position)) return
      seen.add(position)
      next.push(position); prev.push(from); chosen.push(value)
    }
    positions.forEach((position, from) => {
      switch (item.kind) {
        case 'fixed':
          if (selected[position]?.equals(item.line)) add(position + 1, from, true)
          break
        case 'del':
          add(position, from, true)
          if (selected[position]?.equals(item.line)) add(position + 1, from, false)
          break
        case 'add':
          if (selected[position]?.equals(item.line)) add(position + 1, from, true)
          add(position, from, false)
          break
        case 'block':
          if (linesEqual(selected, position, item.work)) add(position + item.work.length, from, true)
          if (linesEqual(selected, position, item.head)) add(position + item.head.length, from, false)
          break
      }
    })
    if (!next.length || next.length > ALIGN_MAX_STATES) return null
    history.push({ prev, chosen })
    positions = next
  }
  let state = positions.indexOf(selected.length)
  if (state < 0) return null
  const choices = uniformChoices(hunks, false)
  for (let step = items.length - 1; step >= 0; step--) {
    const item = items[step]!
    const record = history[step]!
    const value = record.chosen[state]!
    if (item.kind === 'del' || item.kind === 'add') choices[item.hunk]![item.index] = value
    else if (item.kind === 'block') choices[item.hunk] = hunks[item.hunk]!.lines.map((line) => (line.kind === ' ' ? true : value))
    state = record.prev[state]!
  }
  return choices
}

export function includedOf(hunk: BuiltHunk, choice: boolean[]): GitIncluded {
  const changes = hunk.lines.flatMap((line, index) => (line.kind === ' ' ? [] : [choice[index]!]))
  if (changes.every(Boolean)) return 'yes'
  if (!changes.some(Boolean)) return 'no'
  return 'partial'
}

// ---------------------------------------------------------------------------------------------------------
// The answer

/** Everything known about one listed file, for the answer and for a change of its selection. */
export interface FileView {
  file: GitChangedFile
  /** The paths it covers: the path, and a rename's old path. */
  paths: string[]
  head: Entry | null
  oldHead: Entry | null
  work: Entry | null
  oldWork: Entry | null
  /** False when the working tree's version of a path could not be read (`work` then has no object). */
  workKnown: boolean
  /** The selection's entry for the path, and for a rename's old path. */
  selected: Entry | null
  oldSelected: Entry | null
  /** Hunk-level data of a text file; `choices` is null when the selection is not HEAD plus some of the hunks. */
  text?: { head: Buffer[]; work: Buffer[]; hunks: BuiltHunk[]; choices: Choices | null }
  /** A thread overlay entry chosen against what no longer holds: a chosen commit must refuse until it is chosen again. */
  staleChoice: boolean
}

export interface SelectionView {
  collected: Collected
  /** The files listed: at most the limit. */
  files: FileView[]
  /**
   * Every changed file, past the limit too. A file past it whose selection is neither HEAD's nor the working tree's is
   * checked as a listed one is, so `indexDiverged` and `staleChoice` hold for all of them; the rest have no hunks.
   */
  all: FileView[]
  selection: GitSelectionState
  truncated: boolean
  /** Project folders: whether the marker matches HEAD and the index now. */
  markerValid: boolean
  overlay?: Overlay
}

interface Attributes { roundTrip: boolean; binary: boolean }

async function attributes(git: SelectionGit, paths: string[]): Promise<Map<string, Attributes>> {
  const out = new Map<string, Attributes>()
  if (!paths.length) return out
  const run = await git.read(['check-attr', '-z', '--stdin', 'filter', 'ident', 'working-tree-encoding', 'diff'], { input: `${paths.join('\0')}\0` })
  // Attributes that cannot be read: nothing is taken as round-tripping.
  for (const path of paths) out.set(path, { roundTrip: run.ok, binary: false })
  if (!run.ok) return out
  const fields = run.stdout.split('\0')
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [path, name, value] = [fields[index]!, fields[index + 1]!, fields[index + 2]!]
    const found = out.get(path)
    if (!found) continue
    if (name === 'diff') { if (value === 'unset') found.binary = true }
    else if (value !== 'unspecified' && value !== 'unset') found.roundTrip = false
  }
  return out
}

async function catBlobs(git: SelectionGit, oids: string[]): Promise<Map<string, Buffer> | null> {
  const wanted = [...new Set(oids)]
  if (!wanted.length) return new Map()
  const run = await git.bytes(['cat-file', '--batch'], { input: Buffer.from(`${wanted.join('\n')}\n`) })
  if (!run.ok) return null
  const out = new Map<string, Buffer>()
  let at = 0
  for (const oid of wanted) {
    const end = run.stdout.indexOf(0x0a, at)
    if (end < 0) return null
    const [name, type, size] = run.stdout.subarray(at, end).toString('utf8').split(' ')
    if (type !== 'blob' || name !== oid) return null
    const length = Number(size)
    out.set(oid, run.stdout.subarray(end + 1, end + 1 + length))
    at = end + 1 + length + 1
  }
  return out
}

async function blobSizes(git: SelectionGit, oids: string[]): Promise<Map<string, number>> {
  const wanted = [...new Set(oids.filter(Boolean))]
  const out = new Map<string, number>()
  if (!wanted.length) return out
  const run = await git.read(['cat-file', '--batch-check'], { input: `${wanted.join('\n')}\n` })
  if (!run.ok) return out
  for (const line of run.stdout.split('\n')) {
    const [name, type, size] = line.trim().split(' ')
    if (name && type === 'blob') out.set(name, Number(size))
  }
  return out
}

/** Stores `content` as a blob exactly as given: it is already Git's clean form. */
export async function storeBlob(git: SelectionGit, content: Buffer): Promise<string> {
  const run = await git.bytes(['hash-object', '-w', '--no-filters', '--stdin'], { input: content })
  const oid = run.stdout.toString('utf8').trim()
  if (!run.ok || !oid) throw gitFailure(run, 'Git could not store the chosen version.')
  return oid
}

async function limited<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!)
  }))
}

function kindOf(entry: Entry | null): 'file' | 'symlink' | 'submodule' {
  if (entry?.mode === LINK) return 'symlink'
  if (entry?.mode === GITLINK) return 'submodule'
  return 'file'
}

/**
 * What the thread overlay makes the selection of a path: its chosen entry while its HEAD entry holds, HEAD's when a
 * left-out entry's HEAD moved, and the working tree's for a path the person never chose.
 */
function overlaySelected(entry: OverlayEntry | undefined, head: Entry | null, work: Entry | null): { selected: Entry | null; diverged: boolean; staleChoice: boolean } {
  if (!entry) return { selected: work, diverged: false, staleChoice: false }
  const headHolds = sameEntry(entry.head, head)
  if (entry.chosen === null) return { selected: head, diverged: !headHolds, staleChoice: false }
  if (!headHolds) return { selected: entry.chosen, diverged: true, staleChoice: true }
  return { selected: entry.chosen, diverged: false, staleChoice: false }
}

function changeOf(state: PathState, renamed: boolean): GitChangedFile['change'] {
  if (state.conflicted) return 'conflict'
  if (renamed) return 'renamed'
  if (state.head && !state.work) return 'deleted'
  if (!state.head) return 'added'
  return 'modified'
}

/**
 * Reads the changes and the selection. `paths` limits the files listed (a rename's other path comes along); the
 * selection's state and token always cover the whole folder.
 */
export async function readSelection(git: SelectionGit, top: string, place: SelectionPlace, options: { paths?: readonly string[]; maxFiles?: number } = {}): Promise<SelectionView> {
  const collected = await collect(git, top)
  const maxFiles = options.maxFiles ?? SELECTION_MAX_FILES
  let markerValid = false
  let overlay: Overlay | undefined
  let selection: GitSelectionState
  if (place.kind === 'project') {
    markerValid = await markerMatches(place.markerFile, top, collected.head, collected.indexDigest)
    if (!markerValid) await dropMarkerOfOtherHead(git, place.markerFile, collected.head)
    // A conflict leaves no tree to compare: nothing counts as chosen.
    const untouched = collected.unmerged || (collected.indexEqualsHead && !markerValid)
    selection = { state: untouched ? 'untouched' : 'chosen', token: sha(['project', collected.head ?? '', collected.indexDigest, markerValid]) }
  } else {
    overlay = await readOverlay(place.overlayFile)
    selection = { state: Object.keys(overlay.entries).length ? 'chosen' : 'untouched', token: sha(['thread', collected.head ?? '', overlay.epoch, overlay.revision]) }
    // A path the person chose is listed even when nothing else lists it (its working tree equals HEAD now).
    for (const path of Object.keys(overlay.entries)) {
      if (collected.paths.has(path)) continue
      const headEntry = await headEntryOf(git, collected.head, path)
      const exists = await lstat(join(top, path)).then(() => true, () => false)
      collected.paths.set(path, { path, head: headEntry, index: headEntry, stages: [], conflicted: false, work: exists ? headEntry : null, workKnown: true })
    }
  }
  const untouched = selection.state === 'untouched'

  // A rename's old path is covered by its new path's file.
  const renamedFrom = new Set(collected.renames.values())
  const wanted = options.paths ? new Set(options.paths) : null
  const views: FileView[] = []
  for (const state of collected.paths.values()) {
    if (renamedFrom.has(state.path) && !collected.renames.has(state.path)) continue
    const oldPath = collected.renames.get(state.path)
    if (wanted && !wanted.has(state.path) && !(oldPath !== undefined && wanted.has(oldPath))) continue
    const old = oldPath !== undefined ? collected.paths.get(oldPath) ?? null : null
    let selected: Entry | null
    let oldSelected: Entry | null = null
    let diverged = false
    let staleChoice = false
    if (place.kind === 'project') {
      selected = state.index
      oldSelected = old?.index ?? null
    } else {
      const chosen = overlaySelected(overlay!.entries[state.path], state.head, state.work)
      ;({ selected, diverged, staleChoice } = chosen)
      if (old) {
        const was = overlaySelected(overlay!.entries[old.path], old.head, old.work)
        oldSelected = was.selected
        diverged ||= was.diverged
        staleChoice ||= was.staleChoice
      }
    }
    const workChanged = !sameEntry(state.head, state.work) || (old !== null && !sameEntry(old.head, old.work))
    const selectionChanged = !sameEntry(selected, state.head) || (old !== null && !sameEntry(oldSelected, old.head))
    if (!workChanged && !selectionChanged && !state.conflicted && !diverged) continue
    // `.mousse/` is Mousse's own: listed only when the selection already holds something of it.
    if (isMoussePath(state.path) && !selectionChanged) continue
    const kind = kindOf(state.work ?? state.head)
    const modeChange = state.head && state.work && state.head.mode !== state.work.mode ? { old: state.head.mode, new: state.work.mode } : undefined
    const file: GitChangedFile = {
      path: state.path,
      ...(old ? { oldPath: old.path } : {}),
      change: changeOf(state, old !== null),
      kind,
      binary: false,
      ...(modeChange ? { mode: modeChange } : {}),
      wholeFileOnly: state.conflicted || kind !== 'file' || Boolean(modeChange) || old !== null || diverged || !state.workKnown,
      indexDiverged: diverged,
      tooLarge: false,
      version: '',
      hunks: [],
      included: 'no'
    }
    views.push({ file, paths: old ? [state.path, old.path] : [state.path], head: state.head, oldHead: old?.head ?? null, work: state.work, oldWork: old?.work ?? null, workKnown: state.workKnown && (old?.workKnown ?? true), selected, oldSelected, staleChoice })
  }
  views.sort((a, b) => (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0))
  const truncated = views.length > maxFiles
  const shown = views.slice(0, maxFiles)
  // Past the limit, a file whose selection is neither HEAD's nor the working tree's is still checked, so a commit or
  // "Leave out all" never takes an unlisted choice as valid when it no longer holds.
  const unlisted = (view: FileView): boolean =>
    !(sameEntry(view.selected, view.work) && sameEntry(view.oldSelected, view.oldWork)) && !(sameEntry(view.selected, view.head) && sameEntry(view.oldSelected, view.oldHead))
  const checked = [...shown, ...views.slice(maxFiles).filter(unlisted)]

  const attrs = await attributes(git, checked.flatMap((view) => view.paths))
  const sizes = await blobSizes(git, checked.flatMap((view) => [view.head?.oid ?? '', view.work?.oid ?? '', view.selected?.oid ?? '']))
  let emptyBlobStored: Promise<unknown> | null = null
  await limited(checked, async (view) => {
    const { file } = view
    const attr = attrs.get(file.path)
    if (attr && !attr.roundTrip) file.wholeFileOnly = true
    if (attr?.binary) file.binary = true
    const regular = (entry: Entry | null): boolean => entry === null || (REGULAR.has(entry.mode) && entry.oid !== '')
    if (file.kind !== 'file' || file.mode || file.oldPath || file.change === 'conflict' || file.binary || !regular(view.work) || !regular(view.head)) return
    const tooBig = [view.head, view.work, view.selected].some((entry) => entry && entry.oid && (sizes.get(entry.oid) ?? SELECTION_MAX_FILE_BYTES + 1) > SELECTION_MAX_FILE_BYTES)
    if (tooBig) { file.tooLarge = true; file.wholeFileOnly = true; return }
    // A diff against "no file" names the empty blob, which may not be stored yet.
    emptyBlobStored ??= git.bytes(['hash-object', '-w', '--no-filters', '--stdin'], { input: Buffer.alloc(0) })
    await emptyBlobStored
    const from = view.head?.oid ?? collected.emptyBlob
    const to = view.work?.oid ?? collected.emptyBlob
    const diff = await git.read(['diff', ...NO_DIFF_PROGRAMS, '--no-color', '--no-prefix', '-U3', '--inter-hunk-context=0', from, to])
    const shapes = diff.ok ? parseHunks(diff.stdout) : null
    if (shapes === 'binary') { file.binary = true; file.wholeFileOnly = true; return }
    const blobs = shapes ? await catBlobs(git, [from, to, ...(view.selected?.oid ? [view.selected.oid] : [])]) : null
    if (!shapes || !blobs) { file.wholeFileOnly = true; return }
    const head = splitLines(blobs.get(from)!)
    const work = splitLines(blobs.get(to)!)
    if (head.length > SELECTION_MAX_FILE_LINES || work.length > SELECTION_MAX_FILE_LINES) { file.tooLarge = true; file.wholeFileOnly = true; return }
    const hunks = buildHunks(shapes, head, work)
    if (!hunks) { file.wholeFileOnly = true; return }
    let choices: Choices | null = null
    if (untouched || sameEntry(view.selected, view.work)) choices = uniformChoices(hunks, true)
    else if (sameEntry(view.selected, view.head)) choices = uniformChoices(hunks, false)
    // Only a selection with the file's mode is HEAD plus some of the hunks: a mode staged alone (`+x` in the index,
    // the file on disk unchanged) is neither, and reads as diverged below.
    // A selection with neither side (a staged addition deleted from disk) is diverged too.
    else if (view.selected && (view.work ?? view.head) && view.selected.mode === (view.work ?? view.head)!.mode && blobs.has(view.selected.oid)) choices = alignChoices(head, hunks, splitLines(blobs.get(view.selected.oid)!))
    view.text = { head, work, hunks, choices }
  })

  const listed = new Set(shown)
  let answerBytes = 0
  for (const view of checked) {
    const { file } = view
    if (file.change === 'conflict') file.included = 'no'
    else if (untouched) file.included = 'yes'
    else if (view.text?.choices) {
      const each = view.text.hunks.map((hunk, index) => includedOf(hunk, view.text!.choices![index]!))
      file.included = each.every((value) => value === 'yes') ? 'yes' : each.every((value) => value === 'no') ? 'no' : 'partial'
      if (!each.length) file.included = sameEntry(view.selected, view.work) ? 'yes' : 'no'
    } else if (sameEntry(view.selected, view.work) && sameEntry(view.oldSelected, view.oldWork)) file.included = 'yes'
    else if (sameEntry(view.selected, view.head) && sameEntry(view.oldSelected, view.oldHead)) file.included = 'no'
    // A project file whose working tree could not be read: what is staged counts as included, never as diverged.
    else if (place.kind === 'project' && !view.workKnown) file.included = 'yes'
    else {
      // Neither HEAD, the working tree, nor HEAD plus some of the hunks: diverged, and only the whole file can be chosen.
      file.included = 'partial'
      file.indexDiverged = true
      file.wholeFileOnly = true
      if (place.kind === 'thread') view.staleChoice = true
    }
    const textBytes = view.text ? view.text.hunks.reduce((total, hunk) => total + hunk.bytes.reduce((sum, line) => sum + line.length, 0), 0) : 0
    if (view.text && listed.has(view) && answerBytes + textBytes > SELECTION_MAX_ANSWER_BYTES) {
      // The answer is full: this file is listed without hunks, whole file only.
      file.tooLarge = true
      file.wholeFileOnly = true
    } else if (view.text && listed.has(view)) {
      answerBytes += textBytes
      file.hunks = view.text.hunks.map((hunk, index): GitChangeHunk => ({
        id: hunk.id,
        oldStart: hunk.shape.oldStart,
        oldLines: hunk.shape.oldLines,
        newStart: hunk.shape.newStart,
        newLines: hunk.shape.newLines,
        lines: hunk.lines,
        included: file.change === 'conflict' ? 'no' : untouched ? 'yes' : view.text!.choices ? includedOf(hunk, view.text!.choices[index]!) : 'partial'
      }))
    }
    file.version = sha({
      head: collected.head,
      path: file.path,
      oldPath: file.oldPath ?? null,
      entries: view.paths.map((path) => {
        const state = collected.paths.get(path)
        return [state?.head ?? null, state?.stages ?? [], state?.work ?? null, overlay?.entries[path] ?? null]
      }),
      state: selection.state
    })
  }
  return { collected, files: shown, all: views, selection, truncated, markerValid, ...(overlay ? { overlay } : {}) }
}
