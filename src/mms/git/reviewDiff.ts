import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import simpleGit from 'simple-git'
import {
  EMPTY_TREE_SHA,
  REVIEW_MAX_COUNTED_UNTRACKED,
  REVIEW_MAX_FILES,
  REVIEW_MAX_FILE_BYTES,
  REVIEW_MAX_FILE_LINES,
  type ReviewFileEntry,
  type ReviewFileResult,
  type ReviewFileSide,
  type ReviewFileStatus,
  type ReviewRange,
  type ReviewSide
} from '../../shared/review'
import { tryGit } from '../actions/git'

/** Git's own heuristic: a NUL byte in the first 8 KB means the file is binary. */
const BINARY_SNIFF_BYTES = 8192
/** Untracked files are inspected this many at a time. */
const UNTRACKED_CONCURRENCY = 8
/** `.mousse/**` is excluded from checkpoints, so it is excluded from every list too. */
const PATHSPEC = ['--', '.', ':(exclude).mousse/**']

export interface ChangedFiles {
  files: ReviewFileEntry[]
  truncated: boolean
  mergeCommits: number
}

export interface ListChangedFilesOptions {
  /** Defaults to `REVIEW_MAX_FILES`; tests use a small value. */
  maxFiles?: number
}

interface NameStatusEntry {
  path: string
  oldPath?: string
  status: ReviewFileStatus
}

interface NumstatEntry {
  path: string
  oldPath?: string
  additions: number
  deletions: number
  binary: boolean
}

function statusOf(code: string): ReviewFileStatus {
  switch (code[0]) {
    case 'A': case 'C': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'T': return 'typechange'
    default: return 'modified'
  }
}

/** Parses `git diff --name-status -z`: `M\0path\0`, and `R100\0old\0new\0` for a rename. */
export function parseNameStatusZ(output: string): NameStatusEntry[] {
  const tokens = output.split('\0')
  const entries: NameStatusEntry[] = []
  let i = 0
  while (i < tokens.length) {
    const code = tokens[i++]
    if (!code) continue
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = tokens[i++]
      const path = tokens[i++]
      if (oldPath === undefined || path === undefined) break
      entries.push({ path, oldPath, status: statusOf(code) })
    } else {
      const path = tokens[i++]
      if (path === undefined) break
      entries.push({ path, status: statusOf(code) })
    }
  }
  return entries
}

/** Parses `git diff --numstat -z`: `1\t2\tpath\0`, `-\t-\tpath\0` for binary, `1\t2\t\0old\0new\0` for a rename. */
export function parseNumstatZ(output: string): NumstatEntry[] {
  const tokens = output.split('\0')
  const entries: NumstatEntry[] = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i++]
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token)
    if (!match) continue
    let path = match[3]
    let oldPath: string | undefined
    if (path === '') {
      oldPath = tokens[i++]
      path = tokens[i++]
      if (oldPath === undefined || path === undefined) break
    }
    const binary = match[1] === '-' || match[2] === '-'
    entries.push({
      path,
      ...(oldPath !== undefined ? { oldPath } : {}),
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary
    })
  }
  return entries
}

function hashEmptyTree(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['hash-object', '-t', 'tree', '--stdin'], { cwd, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout.trim())
    })
    child.stdin?.end()
  })
}

/** The empty tree of this repository. `/dev/null` cannot stand in for it through `execFile` on Windows. */
export async function emptyTreeSha(cwd: string): Promise<string> {
  const format = await simpleGit(cwd).raw(['rev-parse', '--show-object-format']).then((value) => value.trim()).catch(() => 'sha1')
  return format === 'sha256' ? hashEmptyTree(cwd) : EMPTY_TREE_SHA
}

/** Whether a commit object is still in the repository, for example after a receipt's refs were released. */
export function commitExists(cwd: string, sha: string): boolean {
  return tryGit(cwd, ['cat-file', '-e', `${sha}^{commit}`]).ok
}

/** The range for the working tree: HEAD to index when staged, index to working tree otherwise. */
export async function worktreeRange(cwd: string, staged: boolean): Promise<ReviewRange> {
  const head = await simpleGit(cwd).raw(['rev-parse', '--verify', 'HEAD']).then((value) => value.trim()).catch(() => '')
  const headSide: ReviewSide | null = head ? { kind: 'commit', sha: head } : null
  return staged ? { from: headSide, to: { kind: 'index' } } : { from: { kind: 'index' }, to: { kind: 'worktree' } }
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  return simpleGit(cwd).checkIsRepo().catch(() => false)
}

/** Git revision arguments for a range, or null when the range is known to be empty without asking Git. */
async function revisionArgs(cwd: string, range: ReviewRange): Promise<string[] | null> {
  const { from, to } = range
  if (from?.kind === 'commit' && to.kind === 'commit' && from.sha === to.sha) return null
  const fromRevision = async (): Promise<string> => (from?.kind === 'commit' ? from.sha : from === null ? emptyTreeSha(cwd) : Promise.reject(new Error('Unsupported review range')))
  if (to.kind === 'commit') return [await fromRevision(), to.sha]
  if (to.kind === 'index') return ['--cached', await fromRevision()]
  // A working-tree comparison is never short-circuited: the tree may differ from the commit even at HEAD.
  if (from?.kind === 'index') return []
  return [await fromRevision()]
}

/**
 * Counts lines in the first `maxBytes` of a file. The stream is bounded by construction, so a huge
 * file is never read past the cap. `truncated` means the file is longer than the cap.
 */
export async function countLinesBounded(path: string, maxBytes: number): Promise<{ lines: number; bytesRead: number; binary: boolean; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { start: 0, end: maxBytes })
    let bytesRead = 0
    let newlines = 0
    let lastByte = -1
    let binary = false
    stream.on('data', (chunk) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      const sniff = Math.max(0, Math.min(buffer.length, BINARY_SNIFF_BYTES - bytesRead))
      if (sniff > 0 && buffer.subarray(0, sniff).includes(0)) {
        binary = true
        stream.destroy()
        return
      }
      for (let i = 0; i < buffer.length; i++) if (buffer[i] === 0x0a) newlines++
      bytesRead += buffer.length
      lastByte = buffer[buffer.length - 1]
    })
    stream.on('error', reject)
    stream.on('close', () => {
      if (binary) return resolve({ lines: 0, bytesRead, binary: true, truncated: false })
      const truncated = bytesRead > maxBytes
      resolve({ lines: newlines + (bytesRead > 0 && lastByte !== 0x0a ? 1 : 0), bytesRead, binary: false, truncated })
    })
  })
}

async function inspectUntracked(cwd: string, entry: ReviewFileEntry): Promise<void> {
  entry.countsExact = false
  try {
    const info = await lstat(join(cwd, entry.path))
    if (!info.isFile() || info.size > REVIEW_MAX_FILE_BYTES) return
    const counted = await countLinesBounded(join(cwd, entry.path), REVIEW_MAX_FILE_BYTES)
    if (counted.binary) { entry.binary = true; return }
    if (counted.truncated) return
    entry.additions = counted.lines
    entry.countsExact = true
  } catch {
    /* vanished or unreadable: leave the count unknown */
  }
}

async function forEachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++])
  }))
}

/** Changed files of a range with status and counts. Counts are total: no whitespace flag is passed. */
export async function listChangedFiles(cwd: string, range: ReviewRange, options: ListChangedFilesOptions = {}): Promise<ChangedFiles> {
  const revision = await revisionArgs(cwd, range)
  if (revision === null) return { files: [], truncated: false, mergeCommits: 0 }
  const git = simpleGit(cwd)
  const base = ['diff', '--no-ext-diff', '--no-color', '--relative', '-M', '-z']
  const includeUntracked = range.to.kind === 'worktree'
  const [nameStatus, numstat, untracked] = await Promise.all([
    git.raw([...base, '--name-status', ...revision, ...PATHSPEC]),
    git.raw([...base, '--numstat', ...revision, ...PATHSPEC]),
    includeUntracked ? git.raw(['ls-files', '--others', '--exclude-standard', '-z', ...PATHSPEC]) : Promise.resolve('')
  ])

  const byPath = new Map<string, ReviewFileEntry>()
  for (const item of parseNameStatusZ(nameStatus)) {
    byPath.set(item.path, {
      path: item.path,
      ...(item.oldPath !== undefined ? { oldPath: item.oldPath } : {}),
      status: item.status,
      additions: 0,
      deletions: 0,
      binary: false,
      countsExact: true
    })
  }
  for (const item of parseNumstatZ(numstat)) {
    const entry = byPath.get(item.path)
    if (!entry) continue
    entry.additions = item.additions
    entry.deletions = item.deletions
    entry.binary = item.binary
  }
  const untrackedPaths = untracked.split('\0').filter((path) => path && !byPath.has(path))
  for (const path of untrackedPaths) {
    byPath.set(path, { path, status: 'untracked', additions: 0, deletions: 0, binary: false, countsExact: false })
  }

  // Cut before any content work: only retained files are counted or read.
  const sorted = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const maxFiles = options.maxFiles ?? REVIEW_MAX_FILES
  const files = sorted.slice(0, maxFiles)
  const retainedUntracked = files.filter((file) => file.status === 'untracked')
  await forEachLimited(retainedUntracked.slice(0, REVIEW_MAX_COUNTED_UNTRACKED), UNTRACKED_CONCURRENCY, (entry) => inspectUntracked(cwd, entry))

  let mergeCommits = 0
  if (range.from?.kind === 'commit' && range.to.kind === 'commit') {
    mergeCommits = await git.raw(['rev-list', '--merges', '--count', `${range.from.sha}..${range.to.sha}`])
      .then((value) => Number(value.trim()) || 0).catch(() => 0)
  }
  return { files, truncated: sorted.length > maxFiles, mergeCommits }
}

function countLines(text: string): number {
  let lines = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
  return text.length > 0 && !text.endsWith('\n') ? lines + 1 : lines
}

/** Applies the binary and line caps to text that is already under the byte cap. */
function classify(content: string, size: number, symlink?: true): ReviewFileSide {
  if (content.slice(0, BINARY_SNIFF_BYTES).includes('\0')) return { binary: true, size }
  const lines = countLines(content)
  if (lines > REVIEW_MAX_FILE_LINES) return { tooLarge: true, size, lines, reason: 'lines' }
  return { content, size, ...(symlink ? { symlink } : {}) }
}

async function readGitObject(cwd: string, spec: string): Promise<ReviewFileSide> {
  const git = simpleGit(cwd)
  const size = await git.raw(['cat-file', '-s', spec]).then((value) => Number(value.trim())).catch(() => null)
  if (size === null || !Number.isFinite(size)) return null
  if (size > REVIEW_MAX_FILE_BYTES) return { tooLarge: true, size, reason: 'bytes' }
  const content = await git.raw(['show', spec]).catch(() => null)
  return content === null ? null : classify(content, size)
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function readWorktreeFile(cwd: string, path: string): Promise<ReviewFileSide> {
  if (path.split('/').includes('.git')) return null
  const absolute = join(cwd, path)
  try {
    // A parent that is a symlink or junction pointing outside the root makes the side absent.
    const realRoot = await realpath(cwd)
    const realParent = await realpath(dirname(absolute))
    if (!isInside(realRoot, realParent)) return null
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) {
      // Shown as Git stores it: the link text. The target is never read.
      const target = await readlink(absolute)
      return { content: target, size: Buffer.byteLength(target), symlink: true }
    }
    if (!info.isFile()) return null
    if (info.size > REVIEW_MAX_FILE_BYTES) return { tooLarge: true, size: info.size, reason: 'bytes' }
    const buffer = await readFile(absolute)
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { binary: true, size: buffer.length }
    return classify(buffer.toString('utf8'), buffer.length)
  } catch {
    return null
  }
}

async function readSide(cwd: string, side: ReviewSide | null, path: string): Promise<ReviewFileSide> {
  if (side === null) return null
  // `./` makes the spec relative to `cwd`, which may be a subdirectory of the repository.
  if (side.kind === 'commit') return readGitObject(cwd, `${side.sha}:./${path}`)
  if (side.kind === 'index') return readGitObject(cwd, `:0:./${path}`)
  return readWorktreeFile(cwd, path)
}

/** Both sides of one file. A rename's original side is read at `oldPath`. */
export async function readFileVersions(cwd: string, range: ReviewRange, path: string, oldPath?: string): Promise<ReviewFileResult> {
  for (const candidate of [path, oldPath]) {
    if (candidate !== undefined && (isAbsolute(candidate) || candidate.split(/[\\/]/).includes('..'))) throw new Error('Path is outside the review root')
  }
  const [original, modified] = await Promise.all([
    readSide(cwd, range.from, oldPath ?? path),
    readSide(cwd, range.to, path)
  ])
  return { root: cwd, path, original, modified }
}
