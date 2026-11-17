/**
 * Every thread of every profile on this machine, read from copies so `~/.mousse` is never opened for
 * writing. Import it from a throwaway check script and run that with `npx tsx` from the task's worktree.
 *
 *   import { realThreads } from '<worktree>/.agents/skills/check-on-real-data/real-threads'
 *   for (const thread of realThreads()) { ... thread.messages ... }
 *
 * Messages are what `thread.db` stores: the rows of the transcript collection, oldest first, hidden ones
 * left out. Images and text over 64 KiB live in the thread's `blobs/` folder, so their place in a row holds
 * an empty string; load the blobs yourself when a check depends on their size.
 *
 * Report aggregates only. `dir` and `id` exist so a script can find a thread again; never print them or
 * any per-thread line. Use `summarizeSizes` and `pickForTiming` below, which return counts and anonymous
 * labels ("largest #1", "median"), and print the totals of your own comparison.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface RealThread {
  /** The thread's folder, for finding it again inside a script. Never print it. */
  dir: string
  id: string
  messages: Array<Record<string, unknown>>
}

function threadDbs(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (name === 'thread.db') out.push(path)
    else if (statSync(path).isDirectory() && name !== 'blobs' && name !== 'journal') threadDbs(path, out)
  }
  return out
}

export function* realThreads(home = process.env.MOUSSE_HOME ?? join(homedir(), '.mousse')): Generator<RealThread> {
  const profiles = join(home, 'profiles')
  const dbs = readdirSync(profiles).flatMap((profile) => {
    const data = join(profiles, profile, 'thread-data')
    return existsSync(data) ? threadDbs(data) : []
  })
  const scratch = mkdtempSync(join(tmpdir(), 'mousse-real-threads-'))
  try {
    for (const db of dbs) {
      // The copy includes the write-ahead log, so recent writes are read too; the original is never opened.
      const copy = join(scratch, 'thread.db')
      for (const suffix of ['-wal', '-shm']) rmSync(copy + suffix, { force: true })
      copyFileSync(db, copy)
      if (existsSync(db + '-wal')) copyFileSync(db + '-wal', copy + '-wal')
      const handle = new DatabaseSync(copy)
      try {
        const rows = handle
          .prepare("SELECT payload FROM items WHERE coll = 'm' AND hidden = 0 ORDER BY ord, rid")
          .all() as Array<{ payload: string }>
        const dir = db.slice(0, -'/thread.db'.length)
        yield { dir, id: dir.split('/').at(-1)!, messages: rows.map((row) => JSON.parse(row.payload)) }
      } finally {
        handle.close()
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export interface SizeSummary {
  count: number
  min: number
  median: number
  p90: number
  max: number
  /** The largest sizes, biggest first, with no thread identity. */
  largest: number[]
}

/** Bounded, identifier-free summary of one size per thread (messages, bytes, nodes...). */
export function summarizeSizes(sizes: number[], top = 5): SizeSummary {
  const sorted = [...sizes].sort((a, b) => a - b)
  const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0)
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    median: at(0.5),
    p90: at(0.9),
    max: sorted.at(-1) ?? 0,
    largest: sorted.slice(-top).reverse()
  }
}

export interface TimingPick {
  /** Anonymous label for the report, such as "largest #2" or "median". */
  label: string
  /** Position of the thread in the order the sizes were given (the order of `realThreads()`). */
  index: number
}

/**
 * Threads worth timing: the `largest` biggest (3 to 5), the median, and the smallest. Add threads of other
 * shapes yourself (one with images, one written by an older version) and label them without naming them.
 */
export function pickForTiming(sizes: number[], largest = 5): TimingPick[] {
  const order = sizes.map((size, index) => ({ size, index })).sort((a, b) => b.size - a.size || a.index - b.index)
  if (!order.length) return []
  const picks: TimingPick[] = order.slice(0, Math.min(largest, order.length)).map((entry, rank) => ({ label: `largest #${rank + 1}`, index: entry.index }))
  const taken = new Set(picks.map((pick) => pick.index))
  const extra = [
    { label: 'median', entry: order[Math.floor(order.length / 2)] },
    { label: 'smallest', entry: order.at(-1)! }
  ]
  for (const { label, entry } of extra) if (!taken.has(entry.index)) { picks.push({ label, index: entry.index }); taken.add(entry.index) }
  return picks
}
