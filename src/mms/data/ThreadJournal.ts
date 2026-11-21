import { captureThreadLifecyclePath } from '../queue/ThreadLifecycleAdmission'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ChangeReceipt } from '../../shared/threadActions'
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

/** States after which an operation is over; every other state is an operation still to finish or recover. */
const TERMINAL_STATES: ReadonlySet<ThreadJournalState> = new Set(['completed', 'failed', 'cancelled'])

/**
 * What was read from each journal folder, kept between calls so a turn, a thread open or a recovery check costs the
 * records written since the last call, not the thread's whole history (a bot's home thread holds thousands of records).
 * Records are immutable once written (exclusive create, never rewritten or deleted one by one), so the index only folds
 * in names after the last one it read. A folder that was replaced, or whose names before `last` changed, is read again
 * from the start. Another process's appends are new names, so they are seen on the next call exactly as a full read
 * would see them. A record that cannot be parsed yet (another process is still writing it) throws, as a full read does,
 * and the index stops before it, so the next call reads it again.
 */
interface JournalIndex {
  folder: string
  count: number
  last: string
  /** Every record, in name order. */
  all: ThreadJournalRecord[]
  /** `all` as a frozen copy, so a list a caller holds never changes; built again only after a record was added. */
  allList?: readonly ThreadJournalRecord[]
  latest: Map<string, ThreadJournalRecord>
  /** Where each operation's first record is in `all`: the order of `latest`. */
  firstAt: Map<string, number>
  /** The latest records whose state is not terminal (`unsettled`). */
  unsettled: Map<string, ThreadJournalRecord>
  /** `unsettled` in `latest`'s order, built again only after a record was added. */
  unsettledList?: readonly ThreadJournalRecord[]
  /** `latestWhere` results, by test: the latest records that pass it, kept up to date as records are folded in. */
  views: Map<LatestTest, LatestView>
  byOperation: Map<string, ThreadJournalRecord[]>
  byType: Map<string, ThreadJournalRecord[]>
  /** Each receipt by id, its latest record winning, in the order ids first appeared (`ChangeReceiptService.list`). */
  receipts: Map<string, ChangeReceipt>
  /** Every receipt a record carries, in record order, duplicates kept. */
  receiptRecords: ChangeReceipt[]
  /** `receipts` as a frozen list, built again only after a receipt was added. */
  receiptList?: readonly ChangeReceipt[]
  /** The text length of the records read: what the index holds, for the cache's bound. */
  chars: number
}
type LatestTest = (record: ThreadJournalRecord) => boolean
interface LatestView { matches: Map<string, ThreadJournalRecord>; list?: readonly ThreadJournalRecord[] }
/** A test is a module-level function; past this many per folder, the oldest view is dropped and built again when asked. */
const VIEWS_MAX = 8
const indexes = new Map<string, JournalIndex>()
let indexedChars = 0
const INDEXES_MAX = 64
/** Past this much record text across folders, the least recently used folders are dropped (and read again when used). */
const INDEXED_CHARS_MAX = 64 * 1024 * 1024

function emptyIndex(folder: string): JournalIndex {
  return { folder, count: 0, last: '', all: [], latest: new Map(), firstAt: new Map(), unsettled: new Map(), views: new Map(), byOperation: new Map(), byType: new Map(), receipts: new Map(), receiptRecords: [], chars: 0 }
}

function inLatestOrder(index: JournalIndex, records: Map<string, ThreadJournalRecord>): readonly ThreadJournalRecord[] {
  return Object.freeze([...records.values()].sort((a, b) => index.firstAt.get(a.operationId)! - index.firstAt.get(b.operationId)!))
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

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

  /**
   * Every record, in sequence order. The list and its records are shared and frozen: a caller that changes one copies
   * it first. Costs the records written since the last call (see `JournalIndex`).
   */
  list(): readonly ThreadJournalRecord[] {
    const index = this.index()
    index.allList ??= Object.freeze(index.all.slice())
    return index.allList
  }

  /** The records of one operation, in sequence order. */
  history(operationId: string): readonly ThreadJournalRecord[] {
    return this.index().byOperation.get(operationId)?.slice() ?? []
  }

  /** The records of the given operation types, in sequence order. */
  ofTypes(...operationTypes: string[]): readonly ThreadJournalRecord[] {
    const index = this.index()
    const lists = operationTypes.map((type) => index.byType.get(type) ?? [])
    const found = lists.flat()
    return lists.filter((list) => list.length).length > 1 ? found.sort((a, b) => a.sequence - b.sequence) : found
  }

  /** Each change receipt by id, the latest record of an id winning, in the order ids first appeared. Shared and frozen. */
  receipts(): readonly ChangeReceipt[] {
    const index = this.index()
    index.receiptList ??= Object.freeze([...index.receipts.values()])
    return index.receiptList
  }

  /** Every receipt the records carry, in record order, duplicates kept. A new list; its receipts are shared and frozen. */
  receiptRecords(): readonly ChangeReceipt[] {
    return this.index().receiptRecords.slice()
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
    return new Map(this.index().latest)
  }

  /** The latest record of one operation; shared and frozen. */
  latestOf(operationId: string): ThreadJournalRecord | undefined {
    return this.index().latest.get(operationId)
  }

  /**
   * The latest record of each operation that has not finished (its state is not `completed`, `failed` or `cancelled`),
   * in `latestByOperation` order. Kept with the index, so a check for pending work costs the operations still open, not
   * every operation the thread has run. Shared and frozen.
   */
  unsettled(): readonly ThreadJournalRecord[] {
    const index = this.index()
    index.unsettledList ??= inLatestOrder(index, index.unsettled)
    return index.unsettledList
  }

  /**
   * The latest records that pass `test`, in `latestByOperation` order. `test` must be a module-level function of the
   * record alone: its results are kept with the index and updated as records are folded in, so a call costs the records
   * written since the last one. Shared and frozen.
   */
  latestWhere(test: LatestTest): readonly ThreadJournalRecord[] {
    const index = this.index()
    let view = index.views.get(test)
    if (view) index.views.delete(test)
    else {
      view = { matches: new Map() }
      for (const record of index.latest.values()) if (test(record)) view.matches.set(record.operationId, record)
    }
    index.views.set(test, view)
    if (index.views.size > VIEWS_MAX) index.views.delete(index.views.keys().next().value!)
    view.list ??= inLatestOrder(index, view.matches)
    return view.list
  }

  private index(): JournalIndex {
    let folder = 'none'
    try {
      const info = statSync(this.directory)
      folder = `${info.ino}:${info.birthtimeMs}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const names = folder === 'none' ? [] : this.names()
    let index = indexes.get(this.directory)
    if (index) {
      indexes.delete(this.directory)
      indexedChars -= index.chars
    }
    if (!index || index.folder !== folder || names.length < index.count || (index.count > 0 && names[index.count - 1] !== index.last)) index = emptyIndex(folder)
    try {
      for (let at = index.count; at < names.length; at += 1) {
        // A record that cannot be read (another process is still writing it) throws before the index moves past it.
        const text = readFileSync(join(this.directory, names[at]!), 'utf8')
        const record = deepFreeze(JSON.parse(text) as ThreadJournalRecord)
        index.all.push(record)
        index.allList = undefined
        // Same order as a full read: an operation keeps the place of its first record.
        index.latest.set(record.operationId, record)
        if (!index.firstAt.has(record.operationId)) index.firstAt.set(record.operationId, at)
        if (TERMINAL_STATES.has(record.state)) index.unsettled.delete(record.operationId)
        else index.unsettled.set(record.operationId, record)
        index.unsettledList = undefined
        for (const [test, view] of index.views) {
          if (test(record)) view.matches.set(record.operationId, record)
          else view.matches.delete(record.operationId)
          view.list = undefined
        }
        push(index.byOperation, record.operationId, record)
        push(index.byType, record.operationType, record)
        const receipt = (record.details as { receipt?: ChangeReceipt } | undefined)?.receipt
        if (receipt) {
          index.receiptRecords.push(receipt)
          if (receipt.id) { index.receipts.set(receipt.id, receipt); index.receiptList = undefined }
        }
        index.chars += text.length
        index.count = at + 1
        index.last = names[at]!
      }
    } finally {
      this.keep(index)
    }
    return index
  }

  private keep(index: JournalIndex): void {
    if (index.chars > INDEXED_CHARS_MAX) return
    indexes.set(this.directory, index)
    indexedChars += index.chars
    while (indexes.size > INDEXES_MAX || indexedChars > INDEXED_CHARS_MAX) {
      const [oldest, dropped] = indexes.entries().next().value!
      indexes.delete(oldest)
      indexedChars -= dropped.chars
    }
  }
}
