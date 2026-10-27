import type { BigIntStats, Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface MeasureOptions {
  /**
   * `reclaim` counts only what removing the tree frees: a file with another hard link frees nothing.
   * `usage` counts every file once per `dev:ino` across the shared `seen` set, so shared files are not doubled.
   */
  mode: 'reclaim' | 'usage'
  budgetMs: number
  /** Stop after looking at this many entries (files and folders). Bounds a walk whose clock cannot be trusted. */
  maxEntries?: number
  /** Ends the walk at the next entry. Used to let a move or removal go first and to stop at shutdown. */
  signal?: AbortSignal
  /** Hard-linked files already counted (usage mode). Only multi-link inodes are recorded. */
  seen?: Pick<Set<string>, 'has' | 'add'> & { delete?(key: string): boolean }
  /** Folders to leave out, as `skipKey` values: another root measures them. */
  skip?: ReadonlySet<string>
  /** Test seams. */
  platform?: NodeJS.Platform
  now?: () => number
  fs?: { lstat: typeof lstat; readdir: (path: string) => Promise<string[]> }
}

export interface Measurement {
  bytes: number
  files: number
  /** Entries looked at (files and folders), whether or not they counted. */
  entries: number
  /** Windows reports logical size, which can differ from the space the files occupy. */
  estimated: boolean
  /** The walk ended early, so `bytes` is a lower bound of what the tree holds. */
  partial: boolean
  /** Entries that exist but could not be read (permissions, a lock, an over-long path) or whose folder was replaced during the walk. They make the figure a lower bound too. */
  unreadable: number
  /** Why the walk ended early on purpose: the time or entry budget, or the signal. Absent for a walk that finished or only met unreadable entries. */
  stopped?: 'time' | 'entries' | 'aborted'
}

/** The form a path takes in `MeasureOptions.skip`: absolute, and case-folded where the file system ignores case. */
export function skipKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const absolute = resolve(path)
  return platform === 'win32' ? absolute.toLowerCase() : absolute
}

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code
const identity = (stat: Pick<BigIntStats, 'dev' | 'ino'>): string => `${stat.dev}:${stat.ino}`

/**
 * Sizes a tree with `lstat` only. Links and junctions are not followed or counted, and a directory
 * on another device is skipped. POSIX counts allocated blocks (a sparse file counts what it
 * occupies); Windows counts logical size and says so. It yields between directories and stops at
 * the time or entry budget, or when the signal fires, instead of running long.
 *
 * Nothing is opened, so a file another process has locked is still sized. An entry that disappears
 * during the walk (a cleanup removing it) is skipped without comment; one that cannot be read for
 * another reason is counted in `unreadable`. Long Windows paths work because Node addresses
 * absolute paths in the extended form.
 *
 * A folder is trusted only while it stays the same folder: its identity (device and 64-bit file id) is
 * read before it is listed and again after its entries were sized. If it was replaced in between, for
 * example by a junction, nothing it contributed is kept and it is counted as unreadable. Hard-link
 * identities use the 64-bit file id, which a plain number cannot hold on Windows.
 */
export async function measureTree(root: string, options: MeasureOptions): Promise<Measurement> {
  const now = options.now ?? Date.now
  const platform = options.platform ?? process.platform
  const windows = platform === 'win32'
  const seen = options.seen ?? new Set<string>()
  const ops = options.fs ?? { lstat, readdir: (path: string) => readdir(path) }
  const started = now()
  const result: Measurement = { bytes: 0, files: 0, entries: 0, estimated: false, partial: false, unreadable: 0 }
  const overBudget = (): boolean => now() - started >= options.budgetMs
  const stop = (reason: 'time' | 'entries' | 'aborted'): void => { result.partial = true; result.stopped ??= reason }
  const fail = (error: unknown): void => {
    if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return
    result.unreadable += 1
    result.partial = true
  }
  const bigLstat = (path: string): Promise<BigIntStats> => ops.lstat(path, { bigint: true }) as Promise<BigIntStats>

  /** What one folder adds; kept apart until the folder is confirmed unchanged. */
  interface Local { bytes: number; files: number; estimated: boolean; added: string[] }
  const count = async (stat: Stats, path: string, into: Local): Promise<void> => {
    if (!stat.isFile()) return
    if (stat.nlink > 1) {
      if (options.mode === 'reclaim') return
      let key = `${stat.dev}:${stat.ino}`
      try { key = identity(await bigLstat(path)) } catch { /* Keep the number-based key. */ }
      if (seen.has(key)) return
      seen.add(key)
      into.added.push(key)
    }
    into.files += 1
    if (windows) { into.bytes += stat.size; into.estimated = true }
    else into.bytes += (stat.blocks ?? Math.ceil(stat.size / 512)) * 512
  }
  const commit = (local: Local): void => {
    result.bytes += local.bytes
    result.files += local.files
    if (local.estimated) result.estimated = true
  }

  let rootStat: Stats
  try { rootStat = await ops.lstat(root) } catch (error) { fail(error); return result }
  result.entries += 1
  if (rootStat.isSymbolicLink()) return result
  if (!rootStat.isDirectory()) {
    const local: Local = { bytes: 0, files: 0, estimated: false, added: [] }
    await count(rootStat, root, local)
    commit(local)
    return result
  }

  const pending = [root]
  while (pending.length) {
    if (options.signal?.aborted) { stop('aborted'); break }
    if (overBudget()) { stop('time'); break }
    const directory = pending.pop()!
    let before: BigIntStats
    try { before = await bigLstat(directory) } catch (error) { fail(error); continue }
    if (before.isSymbolicLink() || !before.isDirectory()) { result.unreadable += 1; result.partial = true; continue }
    let names: string[]
    try { names = await ops.readdir(directory) } catch (error) { fail(error); continue }
    const local: Local = { bytes: 0, files: 0, estimated: false, added: [] }
    const subdirectories: string[] = []
    for (let index = 0; index < names.length; index++) {
      if (options.signal?.aborted) { stop('aborted'); break }
      if (index % 256 === 255 && overBudget()) { stop('time'); break }
      if (options.maxEntries !== undefined && result.entries >= options.maxEntries) { stop('entries'); break }
      const path = join(directory, names[index])
      if (options.skip?.has(skipKey(path, platform))) continue
      let stat: Stats
      try { stat = await ops.lstat(path) } catch (error) { fail(error); continue }
      result.entries += 1
      if (stat.isSymbolicLink() || stat.dev !== rootStat.dev) continue
      if (stat.isDirectory()) subdirectories.push(path)
      else await count(stat, path, local)
    }
    // The folder must still be the one that was approved; otherwise what was read may belong elsewhere.
    let unchanged = false
    try {
      const after = await bigLstat(directory)
      unchanged = !after.isSymbolicLink() && after.isDirectory() && identity(after) === identity(before)
    } catch { /* Gone or unreadable: not confirmed. */ }
    if (unchanged) {
      commit(local)
      pending.push(...subdirectories)
    } else {
      for (const key of local.added) seen.delete?.(key)
      result.unreadable += 1
      result.partial = true
    }
    if (result.stopped) break
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return result
}
