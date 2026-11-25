import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statfsSync,
  writeSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { NetError, STORE_TXN_MAX_BYTES, STORE_TXN_MAX_ROWS } from '../../../shared/net'
import type { Clock } from '../contracts'
import { systemClock } from '../clock'
import { canonicalJson } from '../sync/codec'
import { syncDirectory } from './directorySync'

export type StoreFault = (point: string) => void

/**
 * The most a database may hold in use for its one-time rewrite (`rewriteToReclaim`): the rewrite holds the
 * connection while it copies that much, so it runs once a tidy has made the database small, not before.
 */
export const REWRITE_MAX_IN_USE_BYTES = 128 * 1024 * 1024
/** Free pages below this many are left for SQLite to reuse: giving them back is not worth a write. */
export const RECLAIM_MIN_FREE_PAGES = 256

/** How the database file uses its pages, from `rewriteToReclaim`. */
export interface Reclaimable {
  /** `already`: free pages are given back as they come; `rewritten`: set to do so now; `deferred`: not yet. */
  outcome: 'already' | 'rewritten' | 'deferred'
  /** Why a rewrite waits: too much is in use, the disk has no room for the copy it writes, or a reader holds the file. */
  reason?: 'in_use' | 'disk_space' | 'busy'
  inUseBytes: number
  freeBytes: number
}
export interface DatabaseOptions {
  profileDir: string
  clock?: Clock
  fault?: StoreFault
}

export function integer(value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new NetError('bad_request', 'Expected a bounded nonnegative integer.')
  return value
}
export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
export function json(value: unknown): string {
  return Buffer.from(canonicalJson(value)).toString('utf8')
}
export function same(a: unknown, b: unknown): boolean {
  return json(a) === json(b)
}
export function fail(code: ConstructorParameters<typeof NetError>[0], message: string): never {
  throw new NetError(code, message)
}

/** One connection and one transaction boundary for every participating ledger. */
export class NetDatabase {
  readonly database: DatabaseSync
  readonly path: string
  readonly directory: string
  readonly clock: Clock
  readonly fault?: StoreFault
  private depth = 0
  private rows = 0
  private bytes = 0
  private doomed: unknown
  private deferred: Array<() => void> = []
  private closed = false
  private writeFault?: 'storage_full' | 'storage_corrupt'

  constructor(options: DatabaseOptions) {
    this.clock = options.clock ?? systemClock
    this.fault = options.fault
    const profile = realpathSync(resolve(options.profileDir))
    this.directory = join(profile, 'net')
    if (existsSync(this.directory) && lstatSync(this.directory).isSymbolicLink())
      fail('forbidden', 'Net storage cannot be a symlink.')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (realpathSync(this.directory) !== this.directory)
      fail('forbidden', 'Net storage escaped the profile.')
    this.path = join(this.directory, 'net.db')
    if (existsSync(join(this.directory, 'storage-corrupt-fence')))
      fail(
        'storage_corrupt',
        'Net storage encountered corruption; explicit ledger recovery is required.'
      )
    const established = join(this.directory, 'ledger-established')
    if (!existsSync(this.path) && existsSync(established))
      fail(
        'storage_corrupt',
        'An established net ledger is missing or quarantined; explicit recovery is required.'
      )
    if (
      existsSync(this.path) &&
      (!lstatSync(this.path).isFile() || lstatSync(this.path).isSymbolicLink())
    )
      fail('forbidden', 'Net database is not an owned regular file.')
    this.database = new DatabaseSync(this.path)
    try {
      chmodSync(this.path, 0o600)
      // A new database gives back the pages it frees (`reclaim`); this takes effect only before its first table, and
      // an older one is set to it once by a rewrite (`rewriteToReclaim`).
      this.database.exec(
        'PRAGMA auto_vacuum=INCREMENTAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'
      )
      const integrity = this.database.prepare('PRAGMA quick_check').all()
      if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok')
        fail('storage_corrupt', 'Net database failed its integrity check; recovery is required.')
      const version = Number(this.database.prepare('PRAGMA user_version').get()!.user_version)
      if (version > 1) fail('downgrade_unsupported', 'Net database has a newer schema.')
      this.database.exec('BEGIN IMMEDIATE')
      try {
        // A store this transaction creates is born with every one-time step already done.
        const created = !this.database
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='net_schema_migrations'")
          .get()
        this.database.exec(SCHEMA)
        this.addMissingColumns()
        if (created)
          for (const marker of BORN_MARKERS)
            this.database
              .prepare('INSERT OR IGNORE INTO net_local_markers VALUES(?,?)')
              .run(marker, integer(this.clock.now()))
        this.database
          .prepare('INSERT OR IGNORE INTO net_schema_migrations VALUES(1,?)')
          .run(integer(this.clock.now()))
        this.checkpoint('database.migration.beforeCommit')
        this.database.exec('PRAGMA user_version=1; COMMIT')
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
      // A stage is never authority after a restart. Delete in bounded batches.
      for (;;) {
        const rows = this.database
          .prepare(
            "SELECT rowid FROM net_records WHERE generation IN (SELECT id FROM net_generations WHERE state='staging') LIMIT 500"
          )
          .all()
        if (!rows.length) break
        this.transaction(() => {
          for (const row of rows)
            this.database.prepare('DELETE FROM net_records WHERE rowid=?').run(row.rowid!)
        })
      }
      this.database.exec("DELETE FROM net_generations WHERE state='staging'")
      // Deleting/quarantining net.db must never silently create a fresh dedup
      // ledger on the next start. Recovery must deliberately reconcile this fence.
      if (!existsSync(established)) {
        const fd = openSync(established, 'wx', 0o600)
        try {
          writeSync(fd, 'Net ledger established; replacement requires explicit recovery.\n')
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        syncDirectory(this.directory)
      }
    } catch (error) {
      this.database.close()
      this.closed = true
      const translated = this.translate(error)
      if (translated instanceof NetError && translated.code === 'storage_corrupt') {
        const quarantine = `${this.path}.quarantine-${randomUUID()}`
        for (const suffix of ['', '-wal', '-shm'])
          if (existsSync(`${this.path}${suffix}`))
            renameSync(`${this.path}${suffix}`, `${quarantine}${suffix}`)
        throw new NetError(
          'storage_corrupt',
          'Net database was quarantined; ledger recovery is required before execution.',
          { cause: translated, details: { quarantine } }
        )
      }
      throw translated
    }
  }

  /**
   * Columns added after a table first shipped. Each is added only when the table lacks it, with a default
   * that is the safe value, and `user_version` does not move: an older build still reads and writes the
   * table (it names its columns, and the new one takes its default), so a profile can go back to it.
   */
  private addMissingColumns(): void {
    const has = (table: string, column: string): boolean =>
      this.database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((row) => row.name === column)
    // "Editor connections from this device": off for every device that already has a row.
    if (!has('net_node_policy', 'editor'))
      this.database.exec(
        'ALTER TABLE net_node_policy ADD COLUMN editor INTEGER NOT NULL DEFAULT 0 CHECK(editor IN (0,1))'
      )
    // "Bots on this computer" for each device: on for every device that already has a row, as before the switch. An
    // older build's insert names its columns and gets this default; its update leaves the column as it is.
    if (!has('net_node_policy', 'bots'))
      this.database.exec(
        'ALTER TABLE net_node_policy ADD COLUMN bots INTEGER NOT NULL DEFAULT 1 CHECK(bots IN (0,1))'
      )
    // Which threads a device's agents may change here: the threads they started, for every device that already has a row.
    if (!has('net_node_policy', 'agent_reach'))
      this.database.exec(
        "ALTER TABLE net_node_policy ADD COLUMN agent_reach TEXT NOT NULL DEFAULT 'launched'"
      )
    // "Work on threads from this device": on for every device that already has a row, as before the switch.
    if (!has('net_node_policy', 'work'))
      this.database.exec(
        'ALTER TABLE net_node_policy ADD COLUMN work INTEGER NOT NULL DEFAULT 1 CHECK(work IN (0,1))'
      )
    // Who made a routed call: null for a person on the device, `agent` for a call marked as an agent's.
    if (!has('bridge_audit', 'actor'))
      this.database.exec('ALTER TABLE bridge_audit ADD COLUMN actor TEXT')
  }

  get inTransaction(): boolean {
    return this.depth > 0
  }
  /** Trusted domain coordinators may enforce a prepared callback's declared
   * resource budget against the same counters that enforce the outer commit. */
  get transactionUsage(): Readonly<{ rows: number; bytes: number }> {
    if (!this.depth) fail('forbidden', 'Transaction usage requires an active transaction.')
    return Object.freeze({ rows: this.rows, bytes: this.bytes })
  }
  transaction<T>(work: () => T): T {
    if (this.closed) fail('internal', 'Net database is closed.')
    if (this.writeFault) fail(this.writeFault, 'Net writes are suspended until recovery.')
    if (this.depth) {
      this.depth++
      try {
        const result = work()
        this.assertSynchronous(result)
        return result
      } catch (error) {
        this.doomed = error
        throw this.translate(error)
      } finally {
        this.depth--
      }
    }
    this.depth = 1
    this.rows = 0
    this.bytes = 0
    this.doomed = undefined
    this.deferred = []
    let result: T
    try {
      this.database.exec('BEGIN IMMEDIATE')
      result = work()
      this.assertSynchronous(result)
      if (this.doomed) throw this.doomed
      this.checkpoint('transaction.beforeCommit')
      this.database.exec('COMMIT')
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        /* BEGIN may have failed. */
      }
      this.deferred = []
      throw this.translate(error)
    } finally {
      this.depth = 0
    }
    const deferred = this.deferred
    this.deferred = []
    for (const notify of deferred) {
      try {
        notify()
      } catch {
        /* An observer cannot undo durable commit. */
      }
    }
    return result
  }
  charge(rows: number, bytes = 0): void {
    this.rows += rows
    this.bytes += bytes
    if (this.rows > STORE_TXN_MAX_ROWS || this.bytes > STORE_TXN_MAX_BYTES)
      fail('too_large', 'Net transaction exceeded its row or byte limit.')
  }
  afterCommit(callback: () => void): void {
    if (this.depth) this.deferred.push(callback)
    else callback()
  }
  checkpoint(point: string): void {
    this.fault?.(point)
  }
  /**
   * Gives up to `pages` free pages back to the file system, so what a tidy freed stops taking disk space. A step at a
   * time: the caller pauses between steps. Nothing while fewer than `RECLAIM_MIN_FREE_PAGES` are free, or in a database
   * not set to give pages back (see `rewriteToReclaim`). Returns how many pages went.
   */
  reclaim(pages: number): number {
    integer(pages, 1)
    this.assertCompactable()
    if (this.pragma('auto_vacuum') !== 2) return 0
    const before = this.pragma('freelist_count')
    if (before < RECLAIM_MIN_FREE_PAGES) return 0
    this.compacting(() => this.database.exec(`PRAGMA incremental_vacuum(${pages})`))
    return Math.max(0, before - this.pragma('freelist_count'))
  }
  /**
   * Once, sets a database made before `reclaim` to give back the pages it frees, by rewriting it (`VACUUM`), which also
   * gives back every page free now. The rewrite needs room for what is in use, not for the file: it builds the new
   * content in memory (never in the system temp folder, which may be on a fuller disk), writes it to the write-ahead
   * log next to the database, then folds the log back in, which only shrinks the file. So it runs only while what is
   * in use is at most `REWRITE_MAX_IN_USE_BYTES` and the database's disk has room for twice that; otherwise it is
   * `deferred`, and a later tidy tries again. A rewrite that fails (a full disk included) is rolled back: the database
   * stays as it was, and writes go on.
   */
  rewriteToReclaim(): Reclaimable {
    this.assertCompactable()
    const size = this.pragma('page_size'),
      free = this.pragma('freelist_count'),
      inUseBytes = (this.pragma('page_count') - free) * size,
      freeBytes = free * size
    if (this.pragma('auto_vacuum') === 2) return { outcome: 'already', inUseBytes, freeBytes }
    if (inUseBytes > REWRITE_MAX_IN_USE_BYTES)
      return { outcome: 'deferred', reason: 'in_use', inUseBytes, freeBytes }
    const disk = statfsSync(this.directory)
    if (Number(disk.bavail) * Number(disk.bsize) < 2 * inUseBytes + 64 * 1024 * 1024)
      return { outcome: 'deferred', reason: 'disk_space', inUseBytes, freeBytes }
    // A reader of a copy holds the file open; the rewrite is then tried at a later tidy rather than waited for.
    this.database.exec('PRAGMA busy_timeout=0')
    try {
      this.compacting(() => {
        this.database.exec('PRAGMA auto_vacuum=INCREMENTAL; PRAGMA temp_store=MEMORY')
        this.database.exec('VACUUM')
      })
    } catch (error) {
      if (((error as { errcode?: number })?.errcode ?? 0) % 256 === 5)
        return { outcome: 'deferred', reason: 'busy', inUseBytes, freeBytes }
      throw error
    } finally {
      // The rewrite went through the write-ahead log: fold it back, and let the log shrink, unless a reader holds it.
      try {
        this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        /* The next checkpoint does it. */
      }
      this.database.exec('PRAGMA busy_timeout=5000; PRAGMA temp_store=DEFAULT')
    }
    return {
      outcome: this.pragma('auto_vacuum') === 2 ? 'rewritten' : 'deferred',
      inUseBytes,
      freeBytes
    }
  }
  private pragma(name: 'auto_vacuum' | 'freelist_count' | 'page_count' | 'page_size'): number {
    return Number(Object.values(this.database.prepare(`PRAGMA ${name}`).get()!)[0])
  }
  private assertCompactable(): void {
    if (this.closed) fail('internal', 'Net database is closed.')
    if (this.depth) fail('internal', 'Net storage cannot be compacted during a transaction.')
    if (this.writeFault) fail(this.writeFault, 'Net writes are suspended until recovery.')
  }
  /**
   * Runs a step that only moves pages. One that fails leaves the data as it was, so it does not suspend writes the way
   * a failed transaction does (a full disk here is not a full disk for a write): only corruption is fenced.
   */
  private compacting(work: () => void): void {
    try {
      work()
    } catch (error) {
      const code = (error as { errcode?: number })?.errcode,
        primary = code === undefined ? undefined : code & 255
      if (primary === 11 || primary === 26) {
        this.fenceCorruption()
        throw new NetError('storage_corrupt', undefined, { cause: error })
      }
      if (primary === 13) throw new NetError('storage_full', undefined, { cause: error })
      throw error
    }
  }
  close(): void {
    if (this.closed) return
    if (this.depth) fail('internal', 'Cannot close a database during a transaction.')
    this.database.close()
    this.closed = true
  }
  private assertSynchronous(result: unknown): void {
    if (result && typeof (result as { then?: unknown }).then === 'function')
      fail('bad_request', 'Net transactions cannot await asynchronous work.')
  }
  private translate(error: unknown): Error {
    if (error instanceof NetError) {
      if (error.code === 'storage_full' && this.writeFault !== 'storage_corrupt')
        this.writeFault = 'storage_full'
      if (error.code === 'storage_corrupt') this.fenceCorruption()
      return error
    }
    const code = (error as { errcode?: number })?.errcode
    if (code === 13) {
      if (this.writeFault !== 'storage_corrupt') this.writeFault = 'storage_full'
      return new NetError('storage_full', undefined, { cause: error })
    }
    if (code === 11 || code === 26) {
      this.fenceCorruption()
      return new NetError('storage_corrupt', undefined, { cause: error })
    }
    if (code === 19 || (code !== undefined && (code & 255) === 19))
      return new NetError('conflict', 'Stored uniqueness or integrity constraint failed.', {
        cause: error
      })
    return error instanceof Error
      ? error
      : new NetError('internal', 'Net storage operation failed.', { cause: error })
  }
  private fenceCorruption(): void {
    this.writeFault = 'storage_corrupt'
    // Services composing on this connection may own their transaction boundary.
    // Fence those raw writes too, including statements prepared before the fault.
    if (!this.closed) this.database.exec('PRAGMA query_only=ON')
    const fence = join(this.directory, 'storage-corrupt-fence')
    if (existsSync(fence)) return
    try {
      const fd = openSync(fence, 'wx', 0o600)
      try {
        writeSync(
          fd,
          'Net storage corruption detected; reconcile the ledger before removing this fence.\n'
        )
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      syncDirectory(this.directory)
    } catch (cause) {
      // Keep the running process fenced even when the filesystem cannot record it.
      throw new NetError(
        'storage_corrupt',
        'Net writes are suspended; the corruption fence could not be persisted.',
        { cause }
      )
    }
  }
}

/**
 * One-time steps a store records as done in `net_local_markers`, kept out of `user_version` so an older build still
 * opens the store. A new store is born with all of them.
 */
export const CONNECTIONS_MARKER = 'connections.v1'
const BORN_MARKERS = [CONNECTIONS_MARKER]

const SCHEMA = `
CREATE TABLE IF NOT EXISTS net_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS net_streams(id TEXT PRIMARY KEY, descriptor TEXT NOT NULL, space_id TEXT, kind TEXT NOT NULL, epoch INTEGER NOT NULL, head INTEGER NOT NULL, cursor INTEGER NOT NULL, retained INTEGER NOT NULL, active_generation TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS net_generations(id TEXT PRIMARY KEY, stream TEXT NOT NULL REFERENCES net_streams(id), state TEXT NOT NULL, epoch INTEGER NOT NULL, through_seq INTEGER NOT NULL, projection INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS net_snapshot_progress(generation TEXT PRIMARY KEY REFERENCES net_generations(id) ON DELETE CASCADE, progress TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS net_records(generation TEXT NOT NULL REFERENCES net_generations(id), epoch INTEGER NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, recv_ts INTEGER NOT NULL, envelope BLOB NOT NULL, sig BLOB NOT NULL, PRIMARY KEY(generation,epoch,seq), UNIQUE(generation,id)) STRICT;
CREATE TABLE IF NOT EXISTS net_event_ids(stream TEXT NOT NULL REFERENCES net_streams(id), id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL, recv_ts INTEGER NOT NULL, payload_hash TEXT NOT NULL, signature_hash TEXT NOT NULL, PRIMARY KEY(stream,id)) STRICT;
CREATE INDEX IF NOT EXISTS net_event_positions ON net_event_ids(stream,epoch,seq);
CREATE INDEX IF NOT EXISTS net_record_positions ON net_records(epoch,seq);
CREATE TABLE IF NOT EXISTS net_outbox(id TEXT PRIMARY KEY, stream TEXT NOT NULL, space_id TEXT, envelope BLOB NOT NULL, sig BLOB NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, created_at INTEGER NOT NULL, error TEXT, epoch INTEGER, seq INTEGER) STRICT;
CREATE INDEX IF NOT EXISTS net_outbox_stream ON net_outbox(stream,created_at,id);
CREATE TABLE IF NOT EXISTS net_executions(id TEXT PRIMARY KEY, scope TEXT NOT NULL, target TEXT NOT NULL, trigger TEXT NOT NULL, payload_hash TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, result TEXT, error TEXT, binding TEXT, UNIQUE(scope,target,trigger)) STRICT;
CREATE TABLE IF NOT EXISTS net_budget_config(bot TEXT NOT NULL, space TEXT NOT NULL, units INTEGER NOT NULL, PRIMARY KEY(bot,space)) STRICT;
CREATE TABLE IF NOT EXISTS net_budget_daily(bot TEXT NOT NULL, space TEXT NOT NULL, day INTEGER NOT NULL, units INTEGER NOT NULL, spent INTEGER NOT NULL, PRIMARY KEY(bot,space,day)) STRICT;
CREATE TABLE IF NOT EXISTS net_budget_reservations(execution TEXT PRIMARY KEY REFERENCES net_executions(id), bot TEXT NOT NULL, space TEXT NOT NULL, day INTEGER NOT NULL, ceiling INTEGER NOT NULL, settled INTEGER) STRICT;
CREATE TABLE IF NOT EXISTS net_budget_calls(execution TEXT NOT NULL REFERENCES net_budget_reservations(execution), id TEXT NOT NULL, maximum INTEGER NOT NULL, spent INTEGER, PRIMARY KEY(execution,id)) STRICT;
CREATE TABLE IF NOT EXISTS net_blobs(id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, sealed INTEGER NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS net_blob_orphans(id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS net_blob_gc(id TEXT PRIMARY KEY, bytes INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS net_blob_refs(blob TEXT NOT NULL REFERENCES net_blobs(id), stream TEXT NOT NULL REFERENCES net_streams(id), event TEXT NOT NULL, PRIMARY KEY(blob,stream,event)) STRICT;
CREATE TABLE IF NOT EXISTS net_uploads(id TEXT PRIMARY KEY, blob TEXT NOT NULL, bytes INTEGER NOT NULL, sealed INTEGER NOT NULL, offset INTEGER NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS net_quota_config(scope TEXT PRIMARY KEY, units INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS net_quota_reservations(scope TEXT NOT NULL REFERENCES net_quota_config(scope), id TEXT NOT NULL, units INTEGER NOT NULL, released INTEGER NOT NULL, PRIMARY KEY(scope,id)) STRICT;
CREATE TABLE IF NOT EXISTS net_rate_config(scope TEXT NOT NULL, principal TEXT NOT NULL, max_units INTEGER NOT NULL, window_ms INTEGER NOT NULL, last_now INTEGER NOT NULL, PRIMARY KEY(scope,principal)) STRICT;
CREATE TABLE IF NOT EXISTS net_rate_charges(scope TEXT NOT NULL, principal TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL, units INTEGER NOT NULL, PRIMARY KEY(scope,principal,id), FOREIGN KEY(scope,principal) REFERENCES net_rate_config(scope,principal)) STRICT;
CREATE INDEX IF NOT EXISTS net_rate_window ON net_rate_charges(scope,principal,created_at);
CREATE TABLE IF NOT EXISTS net_node_policy(node TEXT PRIMARY KEY, blocked INTEGER NOT NULL CHECK(blocked IN (0,1)), max_permission_mode TEXT NOT NULL, terminal INTEGER NOT NULL CHECK(terminal IN (0,1)), editor INTEGER NOT NULL DEFAULT 0 CHECK(editor IN (0,1)), bots INTEGER NOT NULL DEFAULT 1 CHECK(bots IN (0,1)), agent_reach TEXT NOT NULL DEFAULT 'launched', work INTEGER NOT NULL DEFAULT 1 CHECK(work IN (0,1)), created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS bridge_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, node TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('change','refused')), method TEXT NOT NULL, thread TEXT, project TEXT, outcome TEXT NOT NULL, actor TEXT) STRICT;
CREATE INDEX IF NOT EXISTS bridge_audit_node ON bridge_audit(node,kind,id);
CREATE TABLE IF NOT EXISTS bridge_audit_reads(node TEXT NOT NULL, hour INTEGER NOT NULL, calls INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(node,hour)) STRICT;
CREATE TABLE IF NOT EXISTS remote_thread_order(node TEXT NOT NULL, thread TEXT NOT NULL, position REAL NOT NULL, PRIMARY KEY(node,thread)) STRICT;
CREATE TABLE IF NOT EXISTS remote_thread_opened(node TEXT NOT NULL, thread TEXT NOT NULL, opened_at INTEGER NOT NULL, PRIMARY KEY(node,thread)) STRICT;
CREATE TABLE IF NOT EXISTS net_local_markers(name TEXT PRIMARY KEY, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS net_connections(node TEXT PRIMARY KEY, state TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS net_lan_port(singleton INTEGER PRIMARY KEY CHECK(singleton=1), port INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS net_lan_last_address(node TEXT PRIMARY KEY, address TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS remote_lists_cache(node TEXT PRIMARY KEY, saved_at INTEGER NOT NULL, snapshot TEXT NOT NULL) STRICT;
`
