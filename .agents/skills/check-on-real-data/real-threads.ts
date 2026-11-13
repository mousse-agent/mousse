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
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface RealThread {
  /** The thread's folder, for naming it in a report. */
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
