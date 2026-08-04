import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { durableExclusiveWriteSync } from './AtomicFs'

export type ThreadJournalState =
  | 'planned'
  | 'running'
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

export class ThreadJournal {
  readonly directory: string

  constructor(threadDirectory: string) {
    this.directory = join(threadDirectory, 'journal')
  }

  list(): ThreadJournalRecord[] {
    if (!existsSync(this.directory)) return []
    return readdirSync(this.directory)
      .filter((name) => /^\d{16}\.json$/.test(name))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as ThreadJournalRecord)
  }

  latestSequence(): number {
    const records = this.list()
    return records.at(-1)?.sequence ?? 0
  }

  append<T>(record: Omit<ThreadJournalRecord<T>, 'schemaVersion' | 'sequence' | 'createdAt'>): ThreadJournalRecord<T> {
    mkdirSync(this.directory, { recursive: true })
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
        durableExclusiveWriteSync(join(this.directory, journalName(sequence)), `${JSON.stringify(value, null, 2)}\n`)
        return value
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    throw new Error('Unable to allocate a thread journal sequence after 100 collisions')
  }

  latestByOperation(): Map<string, ThreadJournalRecord> {
    const latest = new Map<string, ThreadJournalRecord>()
    for (const record of this.list()) latest.set(record.operationId, record)
    return latest
  }
}
