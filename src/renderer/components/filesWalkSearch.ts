import type { FileEntry, FileSearchResult } from '../../shared/types'
import { fileMatch, rankFileResults } from './filesSearchState'

/**
 * Finds files by name under a folder that has no search index (any folder outside the project), by listing it
 * the way the tree does: breadth first, a few folders at a time, within a depth, an entry count and a time
 * limit. Folders that are heavy or hidden are skipped, a folder that does not answer is left out (the daemon
 * fails it at once), and the walk stops as soon as it is cancelled.
 */

/** Folder names never walked into: tool output, caches and system folders. Names starting with `.` are skipped too. */
export const WALK_SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'vendor', '__pycache__', 'venv', 'env', 'target', 'dist', 'out', 'build',
  'AppData', 'Library', '$Recycle.Bin', 'System Volume Information', 'Windows', 'Program Files',
  'Program Files (x86)', 'ProgramData', 'proc', 'sys', 'dev'
])

export interface WalkSearchOptions {
  query: string
  /** Lists a folder relative to the walked root (`''` for the root), as `files.list` does. */
  list: (dir: string) => Promise<FileEntry[]>
  signal: AbortSignal
  /** Called with the best results so far, at most every `progressMs`, and once at the end. */
  onProgress: (progress: WalkSearchProgress) => void
  maxDepth?: number
  maxEntries?: number
  maxResults?: number
  timeLimitMs?: number
  /** A folder that takes longer than this is left out. */
  folderTimeoutMs?: number
  concurrency?: number
  progressMs?: number
  now?: () => number
}

export interface WalkSearchProgress {
  results: FileSearchResult[]
  done: boolean
  /** The walk stopped at a limit (depth, entries, results or time): there may be more. */
  capped: boolean
  /** Folders that could not be read (not answering, no access). */
  skipped: number
}

/** The characters of `name` that spell `query` in order, or null. For names that only loosely match. */
function subsequence(query: string, name: string, offset: number): number[] | null {
  const positions: number[] = []
  let at = 0
  for (const char of query) {
    const found = name.indexOf(char, at)
    if (found === -1) return null
    positions.push(offset + found)
    at = found + 1
  }
  return positions
}

/** How `path` matches, or null when it does not at all. Folder matches count only for a query with a `/`. */
export function walkMatch(query: string, path: string): FileSearchResult | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const match = fileMatch(q, path)
  if (match.tier < 4 || (match.tier === 4 && q.includes('/'))) return { path, kind: 'file', score: 0, positions: match.positions }
  if (q.includes('/')) return null
  const slash = path.lastIndexOf('/')
  const loose = subsequence(q, path.slice(slash + 1).toLowerCase(), slash + 1)
  return loose ? { path, kind: 'file', score: 0, positions: loose } : null
}

function withinTime<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error('Folder did not answer in time')), ms)
    const abort = () => { clearTimeout(timer); fail(new Error('cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (value) => { clearTimeout(timer); signal.removeEventListener('abort', abort); settle(value) },
      (error: unknown) => { clearTimeout(timer); signal.removeEventListener('abort', abort); fail(error) }
    )
  })
}

/** Walks the folder and reports what matches; resolves with the last report (not called after cancelling). */
export async function walkSearch(options: WalkSearchOptions): Promise<WalkSearchProgress | null> {
  const {
    query, list, signal, onProgress,
    maxDepth = 8, maxEntries = 20_000, maxResults = 200, timeLimitMs = 8_000,
    folderTimeoutMs = 3_000, concurrency = 4, progressMs = 120, now = () => Date.now()
  } = options
  const started = now()
  const queue: Array<{ dir: string; depth: number }> = [{ dir: '', depth: 0 }]
  const found: FileSearchResult[] = []
  let seen = 0
  let skipped = 0
  let capped = false
  let lastReport = 0
  let rootFailure: unknown = null

  const report = (done: boolean): WalkSearchProgress => {
    const progress = { results: rankFileResults(query, found).slice(0, maxResults), done, capped, skipped }
    if (!signal.aborted) onProgress(progress)
    lastReport = now()
    return progress
  }

  const visit = async (dir: string, depth: number) => {
    let entries: FileEntry[]
    try {
      entries = await withinTime(list(dir), folderTimeoutMs, signal)
    } catch (error) {
      if (signal.aborted) return
      if (dir === '') rootFailure = error
      skipped += 1
      return
    }
    for (const entry of entries) {
      if (signal.aborted) return
      seen += 1
      if (seen > maxEntries) { capped = true; return }
      if (entry.kind === 'directory') {
        if (entry.name.startsWith('.') || WALK_SKIP_DIRS.has(entry.name)) continue
        if (depth + 1 > maxDepth) { capped = true; continue }
        queue.push({ dir: entry.path, depth: depth + 1 })
      } else {
        const match = walkMatch(query, entry.path)
        if (match) {
          found.push(match)
          if (found.length >= maxResults * 4) capped = true
        }
      }
    }
  }

  const worker = async () => {
    while (!signal.aborted && !(capped && found.length >= maxResults * 4)) {
      if (seen > maxEntries) return
      if (now() - started > timeLimitMs) { capped = true; return }
      const next = queue.shift()
      if (!next) {
        // Another worker may still add folders: wait for it briefly, then stop once the queue stays empty.
        if (active === 0) return
        await new Promise((resolve) => setTimeout(resolve, 10))
        continue
      }
      active += 1
      try {
        await visit(next.dir, next.depth)
      } finally {
        active -= 1
      }
      if (now() - lastReport >= progressMs) report(false)
    }
  }
  let active = 0
  await Promise.all(Array.from({ length: concurrency }, worker))
  if (signal.aborted) return null
  if (rootFailure) throw rootFailure
  return report(true)
}
