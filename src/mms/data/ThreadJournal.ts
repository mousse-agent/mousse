import { captureThreadLifecyclePath } from '../queue/ThreadLifecycleAdmission'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { durableExclusiveWriteSync } from './AtomicFs'

export type ThreadJournalState =
  | 'planned'
  | 'running'
  | 'prepared'
  | 'git_applied'
  | 'context_pending'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'recovery_required'

export interface ThreadJournalRecord<T = unknown> {
  schemaVersion: 1
  sequence: number
  operationId: string
  operationType: string
  state: ThreadJournalState
  createdAt: string
  expectedPreState?: unknown
  resultGenerationId?: string
  details?: T
}

function journalName(sequence: number): string {
  return `${String(sequence).padStart(16, '0')}.json`
}

const JOURNAL_NAME = /^\d{16}\.json$/

/**
 * The latest record of each operation, per journal folder, kept between calls so a turn does not reparse the whole
 * history (a bot's home thread holds thousands of records). Records are immutable once written (exclusive create,
 * never rewritten or deleted one by one), so the index only folds in names after the last one it read. A folder that
 * was replaced, or whose names before `last` changed, is read again from the start. Another process's appends are new
 * names, so they are seen on the next call exactly as a full read would see them.
 */
interface LatestIndex {
  folder: string
  count: number
  last: string
  latest: Map<string, ThreadJournalRecord>
}
const latestIndexes = new Map<string, LatestIndex>()
const LATEST_INDEXES_MAX = 64

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

export class ThreadJournal {
  readonly directory: string
  private readonly assertLifecycleCurrent: () => void

  constructor(threadDirectory: string, options: { readOnly?: boolean } = {}) {
    this.assertLifecycleCurrent = options.readOnly
      ? () => { throw new Error('A read-only journal cannot append lifecycle events.') }
      : captureThreadLifecyclePath(threadDirectory)
    this.directory = join(threadDirectory, 'journal')
  }

  private names(): string[] {
    if (!existsSync(this.directory)) return []
    return readdirSync(this.directory).filter((name) => JOURNAL_NAME.test(name)).sort()
  }

  private read(name: string): ThreadJournalRecord {
    return JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as ThreadJournalRecord
  }

  list(): ThreadJournalRecord[] {
    return this.names().map((name) => this.read(name))
  }

  /** From the last file name: every record is written under its own sequence, so no record is read. */
  latestSequence(): number {
    const last = this.names().at(-1)
    return last ? Number(last.slice(0, 16)) : 0
  }

  append<T>(record: Omit<ThreadJournalRecord<T>, 'schemaVersion' | 'sequence' | 'createdAt'>): ThreadJournalRecord<T> {
    this.assertLifecycleCurrent()
    // Exclusive creation resolves concurrent sequence guesses without overwriting history.
    for (let collision = 0; collision < 100; collision += 1) {
      const sequence = this.latestSequence() + 1
      const value: ThreadJournalRecord<T> = {
        schemaVersion: 1,
        sequence,
        createdAt: new Date().toISOString(),
        ...record
      }
      try {
        durableExclusiveWriteSync(join(this.directory, journalName(sequence)), `${JSON.stringify(value, null, 2)}
`)
        return value
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    throw new Error('Unable to allocate a thread journal sequence after 100 collisions')
  }

  /** A new map each call; its records are shared and frozen. */
  latestByOperation(): Map<string, ThreadJournalRecord> {
    let folder = 'none'
    try {
      const info = statSync(this.directory)
      folder = `${info.ino}:${info.birthtimeMs}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const names = folder === 'none' ? [] : this.names()
    let index = latestIndexes.get(this.directory)
    if (!index || index.folder !== folder || names.length < index.count || (index.count > 0 && names[index.count - 1] !== index.last)) {
      index = { folder, count: 0, last: '', latest: new Map() }
    }
    // A record that cannot be read (another process is still writing it) throws before the index moves past it.
    for (let at = index.count; at < names.length; at += 1) {
      const record = deepFreeze(this.read(names[at]!))
      // Same order as a full read: an operation keeps the place of its first record.
      index.latest.set(record.operationId, record)
      index.count = at + 1
      index.last = names[at]!
    }
    latestIndexes.delete(this.directory)
    latestIndexes.set(this.directory, index)
    if (latestIndexes.size > LATEST_INDEXES_MAX) latestIndexes.delete(latestIndexes.keys().next().value!)
    return new Map(index.latest)
  }
}
