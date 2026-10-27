import { spawn as nodeSpawn } from 'node:child_process'
import { constants, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { FileGrepMatch, FileGrepResponse } from '../../shared/types'
import { SKIP_DIR_NAMES, resolveWithinRoot } from './pathGuard'
import { detectGitRoute, isPhysicallyWithin, type GitRoute } from './WorkspaceIndex'
import { getWorkspaceIndexRegistry, type WorkspaceIndexLookup } from './WorkspaceIndexRegistry'

export interface GrepWorkspaceOptions {
  /** Regular expressions run in `git grep` only; elsewhere the query is searched literally. */
  regex?: boolean
  /** Omitted: case-sensitive only when the query contains an uppercase letter. */
  caseSensitive?: boolean
  wholeWord?: boolean
  /** Matches returned in total. */
  limit?: number
  perFileLimit?: number
  /** Wall-clock budget for the whole call, including waiting for the file index. */
  timeoutMs?: number
  /** A matching line longer than this is skipped and counted instead of returned. */
  maxRecordBytes?: number
  /** Aborting kills the git child and rejects with an `AbortError`. */
  signal?: AbortSignal
  /** Replaceable for tests. */
  deps?: GrepWorkspaceDeps
}

export interface GrepWorkspaceDeps {
  /** Must share its clock with the registry (the default for both is `Date.now`). */
  now?: () => number
  spawn?: typeof nodeSpawn
  detectGit?: (root: string) => Promise<GitRoute>
  /** Whole file contents, or `null` when the file is not a regular file, is too large or cannot be read. */
  readCapped?: (absolutePath: string) => Promise<Buffer | null>
  registry?: { getComplete(root: string, options: { deadline: number }): Promise<WorkspaceIndexLookup> }
}

const DEFAULT_LIMIT = 500
const DEFAULT_PER_FILE_LIMIT = 100
const DEFAULT_TIMEOUT_MS = 1_000
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024
const SNIPPET_UNITS = 400
/** `git grep -m` (matches per file) arrived in 2.38. */
const MAX_COUNT_GIT_VERSION: [number, number] = [2, 38]
const SCAN_MAX_FILE_BYTES = 1024 * 1024
const SCAN_BINARY_PROBE_BYTES = 8 * 1024
const SCAN_CONCURRENCY = 8
/** Room for `path\0line\0column\0` ahead of a record's text. */
const RECORD_PREFIX_ALLOWANCE = 4 * 1024
const STDERR_CAP = 4 * 1024
const REGEX_NEEDS_GIT = 'Regular expressions need a Git repository'

function abortError(): Error {
  const error = new Error('Search was cancelled')
  error.name = 'AbortError'
  return error
}

/** Lowercases without changing the string's length, so UTF-16 offsets stay valid (`İ` would grow). */
function foldCase(value: string): string {
  const lowered = value.toLowerCase()
  if (lowered.length === value.length) return lowered
  return Array.from(value, (char) => {
    const one = char.toLowerCase()
    return one.length === char.length ? one : char
  }).join('')
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

function wordBefore(text: string, index: number): boolean {
  if (index <= 0) return false
  const low = text.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff) return WORD_CHAR.test(text.slice(index - 2, index))
  }
  return WORD_CHAR.test(text[index - 1])
}

function wordAt(text: string, index: number): boolean {
  if (index >= text.length) return false
  const point = text.codePointAt(index)
  return point !== undefined && WORD_CHAR.test(String.fromCodePoint(point))
}

function isWholeWord(text: string, index: number, length: number): boolean {
  return !wordBefore(text, index) && !wordAt(text, index + length)
}

function snippetOf(line: string, columnIndex: number, matchLength: number | null): { text: string; snippetStart: number } {
  if (line.length <= SNIPPET_UNITS) return { text: line, snippetStart: 0 }
  const span = Math.min(matchLength ?? 0, SNIPPET_UNITS)
  let start = Math.max(0, columnIndex - Math.floor((SNIPPET_UNITS - span) / 2))
  start = Math.min(start, line.length - SNIPPET_UNITS)
  let end = start + SNIPPET_UNITS
  // Do not cut a surrogate pair in half.
  if (start > 0 && start < columnIndex) {
    const unit = line.charCodeAt(start)
    if (unit >= 0xdc00 && unit <= 0xdfff) start += 1
  }
  if (end < line.length) {
    const unit = line.charCodeAt(end - 1)
    if (unit >= 0xd800 && unit <= 0xdbff) end -= 1
  }
  return { text: line.slice(start, end), snippetStart: start }
}

function hasSkippedSegment(path: string): boolean {
  return path.split('/').some((segment) => SKIP_DIR_NAMES.has(segment))
}

/**
 * Whether a path reported by git or by the index may be returned and read:
 * relative, no `..`, no drive or UNC prefix (the shared lexical guard lets a
 * path on another drive through on Windows), and inside the root.
 */
function isContainedRelative(root: string, path: string): boolean {
  if (!path || isAbsolute(path) || win32.isAbsolute(path) || /^[a-zA-Z]:/.test(path)) return false
  if (path.split(/[\\/]/).includes('..')) return false
  try {
    resolveWithinRoot(root, path)
    return true
  } catch {
    return false
  }
}

function wallClockRemaining(now: () => number, deadline: number): number {
  return Math.max(0, deadline - now())
}

/** Rejects as soon as `signal` aborts; the underlying work is left to finish or time out on its own. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const onAbort = (): void => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

interface RawRecord {
  path: string
  line: number
  byteColumn: number
  text: Buffer
}

/**
 * Parses `git grep -z --column -n` output as bytes: `path\0line\0column\0text\n`.
 * A record whose text is longer than `maxRecordBytes` is dropped without being
 * held, so the buffer never grows past a record's allowance plus one chunk.
 */
class GrepRecordParser {
  skippedLongLines = 0
  private pending: Buffer = Buffer.alloc(0)
  private skipping = false

  constructor(
    private readonly maxRecordBytes: number,
    private readonly onRecord: (record: RawRecord) => boolean
  ) {}

  /** `false` once `onRecord` asked to stop. */
  push(chunk: Buffer): boolean {
    const buffer = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    let offset = 0
    while (offset < buffer.length) {
      if (this.skipping) {
        const newline = buffer.indexOf(10, offset)
        if (newline < 0) {
          offset = buffer.length
          break
        }
        this.skipping = false
        offset = newline + 1
        continue
      }
      const first = buffer.indexOf(0, offset)
      const second = first < 0 ? -1 : buffer.indexOf(0, first + 1)
      const third = second < 0 ? -1 : buffer.indexOf(0, second + 1)
      const newline = third < 0 ? -1 : buffer.indexOf(10, third + 1)
      if (newline < 0) {
        if (buffer.length - offset > this.maxRecordBytes + RECORD_PREFIX_ALLOWANCE) {
          this.skippedLongLines += 1
          this.skipping = true
          offset = buffer.length
        }
        break
      }
      const textEnd = buffer[newline - 1] === 13 && newline - 1 > third ? newline - 1 : newline
      if (textEnd - third - 1 > this.maxRecordBytes) {
        this.skippedLongLines += 1
      } else {
        const line = Number(buffer.toString('latin1', first + 1, second))
        const byteColumn = Number(buffer.toString('latin1', second + 1, third))
        if (Number.isInteger(line) && line > 0 && Number.isInteger(byteColumn) && byteColumn > 0) {
          const keep = this.onRecord({
            path: buffer.toString('utf8', offset, first),
            line,
            byteColumn,
            // Copy: the record must not pin the whole read buffer.
            text: Buffer.from(buffer.subarray(third + 1, textEnd))
          })
          if (!keep) {
            this.pending = Buffer.alloc(0)
            return false
          }
        }
      }
      offset = newline + 1
    }
    this.pending = offset >= buffer.length ? Buffer.alloc(0) : Buffer.from(buffer.subarray(offset))
    return true
  }
}

interface Accumulator {
  matches: FileGrepMatch[]
  files: Set<string>
  perFile: Map<string, number>
  truncated: boolean
  skippedLongLines: number
}

function newAccumulator(): Accumulator {
  return { matches: [], files: new Set(), perFile: new Map(), truncated: false, skippedLongLines: 0 }
}

interface SearchContext {
  root: string
  query: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  limit: number
  perFileLimit: number
  maxRecordBytes: number
  deadline: number
  signal: AbortSignal | undefined
  now: () => number
  deps: GrepWorkspaceDeps
}

/** Match length for a fixed-string hit that starts at `columnIndex`, or `null` when the line does not confirm it. */
function fixedMatchLength(line: string, columnIndex: number, query: string, caseSensitive: boolean): number | null {
  const candidate = line.slice(columnIndex, columnIndex + query.length)
  if (candidate.length !== query.length) return null
  if (caseSensitive ? candidate === query : foldCase(candidate) === foldCase(query)) return query.length
  return null
}

interface GitRunResult {
  /** git failed on its own (bad pattern, damaged repository). */
  failed: boolean
  stderr: string
}

async function grepWithGit(
  context: SearchContext,
  route: Extract<GitRoute, { ok: true }>
): Promise<Omit<FileGrepResponse, 'root' | 'source' | 'elapsedMs'>> {
  const { root, query, now, deadline, signal } = context
  const spawnGit = context.deps.spawn ?? nodeSpawn
  const supportsMaxCount =
    route.version[0] > MAX_COUNT_GIT_VERSION[0] ||
    (route.version[0] === MAX_COUNT_GIT_VERSION[0] && route.version[1] >= MAX_COUNT_GIT_VERSION[1])
  let acc = newAccumulator()
  let timedOut = false

  const run = (mode: 'regex' | 'fixed'): Promise<GitRunResult> =>
    new Promise<GitRunResult>((resolvePromise, reject) => {
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      // The query is the value of `-e` and everything after `--` is a pathspec,
      // so no query can be read as an option. Arguments are an array: no shell.
      const args = ['grep', '-I', '-n', '--column', '--no-color', '-z', '--untracked']
      // One more than the per-file limit, so the parser can tell the cap was hit.
      if (supportsMaxCount) args.push('-m', String(context.perFileLimit + 1))
      if (!context.caseSensitive) args.push('-i')
      if (context.wholeWord) args.push('-w')
      args.push(mode === 'regex' ? '-E' : '-F', '-e', query, '--')

      const child = spawnGit('git', args, {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
      })
      let stoppedByUs = false
      let deadlineHit = false
      let aborted = false
      let spawnError: Error | null = null
      let stderr = ''

      const stop = (): void => {
        if (stoppedByUs) return
        stoppedByUs = true
        child.kill()
      }
      const timer = setTimeout(() => {
        deadlineHit = true
        stop()
      }, wallClockRemaining(now, deadline))
      const onAbort = (): void => {
        aborted = true
        stop()
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      const parser = new GrepRecordParser(context.maxRecordBytes, (record) => {
        let path = record.path
        if (process.platform === 'win32') path = path.replace(/\\/g, '/')
        if (!isContainedRelative(root, path) || hasSkippedSegment(path)) return true
        const seen = acc.perFile.get(path) ?? 0
        if (seen >= context.perFileLimit) {
          acc.truncated = true
          return true
        }
        if (acc.matches.length >= context.limit) {
          acc.truncated = true
          return false
        }
        acc.perFile.set(path, seen + 1)
        acc.files.add(path)
        const byteColumn = Math.min(record.byteColumn, record.text.length + 1)
        const line = record.text.toString('utf8')
        const column = Math.min(record.text.subarray(0, byteColumn - 1).toString('utf8').length, line.length)
        // A regular expression's match length is unknown (POSIX syntax is not translated to JavaScript).
        const matchLength = mode === 'fixed' ? fixedMatchLength(line, column, query, context.caseSensitive) : null
        const snippet = snippetOf(line, column, matchLength)
        acc.matches.push({ path, line: record.line, column: column + 1, matchLength, text: snippet.text, snippetStart: snippet.snippetStart })
        return true
      })

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stoppedByUs) return
        if (!parser.push(chunk)) stop()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8', 0, STDERR_CAP - stderr.length)
      })
      child.on('error', (error: Error) => {
        spawnError = error
      })
      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        acc.skippedLongLines += parser.skippedLongLines
        if (aborted) {
          reject(abortError())
          return
        }
        if (spawnError) {
          reject(spawnError)
          return
        }
        if (deadlineHit) timedOut = true
        // Exit 1 is "no matches"; a child we stopped has no meaningful code.
        resolvePromise({ failed: !stoppedByUs && code !== 0 && code !== 1, stderr })
      })
    })

  let regexError: string | undefined
  let result = await run(context.regex ? 'regex' : 'fixed')
  if (result.failed && context.regex) {
    // git rejected the pattern: tell the caller and search the text literally.
    regexError = describeGitFailure(result.stderr) || 'Invalid regular expression'
    acc = newAccumulator()
    result = await run('fixed')
  }
  if (result.failed) throw new Error(describeGitFailure(result.stderr) || 'git grep failed')

  return {
    matches: acc.matches,
    filesWithMatches: acc.files.size,
    truncated: acc.truncated,
    timedOut,
    indexing: false,
    skippedLongLines: acc.skippedLongLines,
    ...(regexError ? { regexError } : {})
  }
}

function describeGitFailure(stderr: string): string {
  const first = stderr.split(/\r?\n/).find((line) => line.trim()) ?? ''
  return first.replace(/^(fatal|error): /, '').trim()
}

interface ScanFileResult {
  matches: FileGrepMatch[]
  /** Matching lines past `perFileLimit` existed. */
  moreInFile: boolean
  skippedLongLines: number
}

const EMPTY_SCAN: ScanFileResult = { matches: [], moreInFile: false, skippedLongLines: 0 }

async function readCappedFile(absolutePath: string): Promise<Buffer | null> {
  let handle: FileHandle | undefined
  try {
    // Non-blocking open so a file swapped for a pipe cannot park a thread.
    handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    const info = await handle.stat()
    if (!info.isFile() || info.size > SCAN_MAX_FILE_BYTES) return null
    return await handle.readFile()
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function scanText(path: string, text: string, context: SearchContext): ScanFileResult {
  const { query, wholeWord, perFileLimit, maxRecordBytes, caseSensitive } = context
  const haystack = caseSensitive ? text : foldCase(text)
  const needle = caseSensitive ? query : foldCase(query)
  const matches: FileGrepMatch[] = []
  let skippedLongLines = 0
  let lineNumber = 1
  let counted = 0
  let position = 0

  while (position <= haystack.length) {
    const index = haystack.indexOf(needle, position)
    if (index < 0) break
    const lineStart = text.lastIndexOf('\n', index - 1) + 1
    let lineEnd = text.indexOf('\n', index)
    if (lineEnd < 0) lineEnd = text.length
    const next = lineEnd + 1
    if (wholeWord && !isWholeWord(text, index, needle.length)) {
      position = index + 1
      continue
    }
    // One match per line, like git: the first qualifying occurrence.
    position = next
    let newline = text.indexOf('\n', counted)
    while (newline >= 0 && newline < lineStart) {
      lineNumber += 1
      counted = newline + 1
      newline = text.indexOf('\n', counted)
    }
    const end = text[lineEnd - 1] === '\r' && lineEnd - 1 >= lineStart ? lineEnd - 1 : lineEnd
    if (end - lineStart > maxRecordBytes) {
      skippedLongLines += 1
      continue
    }
    if (matches.length >= perFileLimit) return { matches, moreInFile: true, skippedLongLines }
    const line = text.slice(lineStart, end)
    const columnIndex = index - lineStart
    const snippet = snippetOf(line, columnIndex, query.length)
    matches.push({
      path,
      line: lineNumber,
      column: columnIndex + 1,
      matchLength: query.length,
      text: snippet.text,
      snippetStart: snippet.snippetStart
    })
  }
  return { matches, moreInFile: false, skippedLongLines }
}

async function grepByScan(
  context: SearchContext
): Promise<Omit<FileGrepResponse, 'root' | 'source' | 'elapsedMs' | 'fallbackReason'>> {
  const { root, now, deadline, signal } = context
  const registry = context.deps.registry ?? getWorkspaceIndexRegistry()
  const readCapped = context.deps.readCapped ?? readCappedFile
  const regexError = context.regex ? REGEX_NEEDS_GIT : undefined
  const acc = newAccumulator()
  let timedOut = false

  // The index wait and the scan share one deadline, so waiting never restarts the budget.
  const lookup = await abortable(registry.getComplete(root, { deadline }), signal)
  const snapshot = lookup.snapshot
  if (!snapshot) {
    return { matches: [], filesWithMatches: 0, truncated: false, timedOut: true, indexing: true, skippedLongLines: 0, ...(regexError ? { regexError } : {}) }
  }
  const rootReal = await realpath(root)
  const files = snapshot.files

  const scanFile = async (path: string): Promise<ScanFileResult> => {
    if (!isContainedRelative(root, path)) return EMPTY_SCAN
    const absolute = join(root, path)
    // The index lists links that stay inside the root; check again right before reading.
    if (!(await isPhysicallyWithin(rootReal, absolute))) return EMPTY_SCAN
    const buffer = await readCapped(absolute)
    if (!buffer || buffer.subarray(0, SCAN_BINARY_PROBE_BYTES).includes(0)) return EMPTY_SCAN
    return scanText(path, buffer.toString('utf8'), context)
  }

  outer: for (let start = 0; start < files.length; start += SCAN_CONCURRENCY) {
    if (signal?.aborted) throw abortError()
    if (now() >= deadline) {
      timedOut = true
      break
    }
    const results = await Promise.all(files.slice(start, start + SCAN_CONCURRENCY).map(scanFile))
    for (const result of results) {
      acc.skippedLongLines += result.skippedLongLines
      if (result.moreInFile) acc.truncated = true
      for (const match of result.matches) {
        if (acc.matches.length >= context.limit) {
          acc.truncated = true
          break outer
        }
        acc.matches.push(match)
        acc.files.add(match.path)
      }
    }
    await yieldToEventLoop()
  }

  return {
    matches: acc.matches,
    filesWithMatches: acc.files.size,
    // A capped index means files past the cap were never looked at.
    truncated: acc.truncated || snapshot.truncated,
    timedOut,
    indexing: lookup.indexing || !snapshot.complete,
    skippedLongLines: acc.skippedLongLines,
    ...(regexError ? { regexError } : {})
  }
}

/**
 * Searches file contents under `root`: `git grep` in a Git repository (which
 * honours `.gitignore` and supports regular expressions), otherwise a
 * fixed-string scan of the workspace index. Results carry UTF-16 columns.
 * Returns what was found with `timedOut` when the budget runs out.
 */
export async function grepWorkspace(
  root: string,
  query: string,
  options: GrepWorkspaceOptions = {}
): Promise<FileGrepResponse> {
  const deps = options.deps ?? {}
  const now = deps.now ?? Date.now
  const started = now()
  const absoluteRoot = resolve(root)
  const context: SearchContext = {
    root: absoluteRoot,
    query,
    regex: options.regex === true,
    caseSensitive: options.caseSensitive ?? /\p{Lu}/u.test(query),
    wholeWord: options.wholeWord === true,
    limit: options.limit ?? DEFAULT_LIMIT,
    perFileLimit: options.perFileLimit ?? DEFAULT_PER_FILE_LIMIT,
    maxRecordBytes: options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
    deadline: started + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    signal: options.signal,
    now,
    deps
  }
  if (options.signal?.aborted) throw abortError()

  const route = await abortable((deps.detectGit ?? detectGitRoute)(absoluteRoot), options.signal)
  const head = {
    root: absoluteRoot,
    source: route.ok ? ('git' as const) : ('walk' as const),
    ...(route.ok ? {} : { fallbackReason: route.reason })
  }

  // A line can never contain a line break or NUL, and neither can a command-line argument.
  if (!query || /[\r\n\0]/.test(query)) {
    return { ...head, matches: [], filesWithMatches: 0, truncated: false, timedOut: false, indexing: false, skippedLongLines: 0, elapsedMs: now() - started }
  }

  const body = route.ok ? await grepWithGit(context, route) : await grepByScan(context)
  return { ...head, ...body, elapsedMs: now() - started }
}
