import type { Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface MeasureOptions {
  /**
   * `reclaim` counts only what removing the tree frees: a file with another hard link frees nothing.
   * `usage` counts every file once per `dev:ino` across the shared `seen` set, so shared files are not doubled.
   */
  mode: 'reclaim' | 'usage'
  budgetMs: number
  /** Hard-linked files already counted (usage mode). Only multi-link inodes are recorded. */
  seen?: Set<string>
  /** Test seams. */
  platform?: NodeJS.Platform
  now?: () => number
}

export interface Measurement {
  bytes: number
  files: number
  /** Windows reports logical size, which can differ from the space the files occupy. */
  estimated: boolean
  /** The budget ended the walk early, so `bytes` is a lower bound of what was reached. */
  partial: boolean
}

/**
 * Sizes a tree with `lstat` only. Links and junctions are not followed or counted, and a directory
 * on another device is skipped. POSIX counts allocated blocks (a sparse file counts what it
 * occupies); Windows counts logical size and says so. It yields between directories and stops at
 * the budget instead of running long.
 */
export async function measureTree(root: string, options: MeasureOptions): Promise<Measurement> {
  const now = options.now ?? Date.now
  const windows = (options.platform ?? process.platform) === 'win32'
  const seen = options.seen ?? new Set<string>()
  const started = now()
  const result: Measurement = { bytes: 0, files: 0, estimated: false, partial: false }
  const overBudget = (): boolean => now() - started >= options.budgetMs

  const count = (stat: Stats): void => {
    if (!stat.isFile()) return
    if (stat.nlink > 1) {
      if (options.mode === 'reclaim') return
      const key = `${stat.dev}:${stat.ino}`
      if (seen.has(key)) return
      seen.add(key)
    }
    result.files += 1
    if (windows) { result.bytes += stat.size; result.estimated = true }
    else result.bytes += (stat.blocks ?? Math.ceil(stat.size / 512)) * 512
  }

  let rootStat: Stats
  try { rootStat = await lstat(root) } catch { return result }
  if (rootStat.isSymbolicLink()) return result
  if (!rootStat.isDirectory()) { count(rootStat); return result }

  const pending = [root]
  while (pending.length) {
    if (overBudget()) { result.partial = true; break }
    const directory = pending.pop()!
    let names: string[]
    try { names = await readdir(directory) } catch { result.partial = true; continue }
    for (let index = 0; index < names.length; index++) {
      if (index % 256 === 255 && overBudget()) { result.partial = true; break }
      const path = join(directory, names[index])
      let stat: Stats
      try { stat = await lstat(path) } catch { continue }
      if (stat.isSymbolicLink() || stat.dev !== rootStat.dev) continue
      if (stat.isDirectory()) pending.push(path)
      else count(stat)
    }
    if (result.partial) break
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return result
}
