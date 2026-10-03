import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { NetError, STORE_TXN_MAX_BYTES, STORE_TXN_MAX_ROWS } from '../../../shared/net'
import type { Clock } from '../contracts'
import { systemClock } from '../clock'
import { canonicalJson } from '../sync/codec'

export type StoreFault = (point: string) => void
export interface DatabaseOptions { profileDir: string; clock?: Clock; fault?: StoreFault }

export function integer(value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new NetError('bad_request', 'Expected a bounded nonnegative integer.')
  return value
}
export function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
export function json(value: unknown): string { return Buffer.from(canonicalJson(value)).toString('utf8') }
export function same(a: unknown, b: unknown): boolean { return json(a) === json(b) }
export function fail(code: ConstructorParameters<typeof NetError>[0], message: string): never { throw new NetError(code, message) }

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
    if (existsSync(this.directory) && lstatSync(this.directory).isSymbolicLink()) fail('forbidden', 'Net storage cannot be a symlink.')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (realpathSync(this.directory) !== this.directory) fail('forbidden', 'Net storage escaped the profile.')
    this.path = join(this.directory, 'net.db')
    if (existsSync(join(this.directory, 'storage-corrupt-fence'))) fail('storage_corrupt', 'Net storage encountered corruption; explicit ledger recovery is required.')
    const established = join(this.directory, 'ledger-established')
    if (!existsSync(this.path) && existsSync(established)) fail('storage_corrupt', 'An established net ledger is missing or quarantined; explicit recovery is required.')
    if (existsSync(this.path) && (!lstatSync(this.path).isFile() || lstatSync(this.path).isSymbolicLink())) fail('forbidden', 'Net database is not an owned regular file.')
    this.database = new DatabaseSync(this.path)
    try {
      chmodSync(this.path, 0o600)
      this.database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      const integrity = this.database.prepare('PRAGMA quick_check').all()
      if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') fail('storage_corrupt', 'Net database failed its integrity check; recovery is required.')
      const version = Number(this.database.prepare('PRAGMA user_version').get()!.user_version)
      if (version > 1) fail('downgrade_unsupported', 'Net database has a newer schema.')
      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.exec(SCHEMA)
        this.database.prepare('INSERT OR IGNORE INTO net_schema_migrations VALUES(1,?)').run(integer(this.clock.now()))
        this.checkpoint('database.migration.beforeCommit')
        this.database.exec('PRAGMA user_version=1; COMMIT')
      } catch (error) { this.database.exec('ROLLBACK'); throw error }
      // A stage is never authority after a restart. Delete in bounded batches.
      for (;;) {
        const rows = this.database.prepare("SELECT rowid FROM net_records WHERE generation IN (SELECT id FROM net_generations WHERE state='staging') LIMIT 500").all()
        if (!rows.length) break
        this.transaction(() => { for (const row of rows) this.database.prepare('DELETE FROM net_records WHERE rowid=?').run(row.rowid!) })
      }
      this.database.exec("DELETE FROM net_generations WHERE state='staging'")
      // Deleting/quarantining net.db must never silently create a fresh dedup
      // ledger on the next start. Recovery must deliberately reconcile this fence.
      if (!existsSync(established)) {
        const fd = openSync(established, 'wx', 0o600)
        try { writeSync(fd, 'Net ledger established; replacement requires explicit recovery.\n'); fsyncSync(fd) } finally { closeSync(fd) }
        const directoryFd = openSync(this.directory, 'r')
        try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
      }
    } catch (error) {
      this.database.close(); this.closed = true
      const translated = this.translate(error)
      if (translated instanceof NetError && translated.code === 'storage_corrupt') {
        const quarantine = `${this.path}.quarantine-${randomUUID()}`
        for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${this.path}${suffix}`)) renameSync(`${this.path}${suffix}`, `${quarantine}${suffix}`)
        throw new NetError('storage_corrupt', 'Net database was quarantined; ledger recovery is required before execution.', { cause: translated, details: { quarantine } })
      }
      throw translated
    }
  }

  get inTransaction(): boolean { return this.depth > 0 }
  transaction<T>(work: () => T): T {
    if (this.closed) fail('internal', 'Net database is closed.')
    if (this.writeFault) fail(this.writeFault, 'Net writes are suspended until recovery.')
    if (this.depth) {
      this.depth++
      try {
        const result = work()
        this.assertSynchronous(result)
        return result
      } catch (error) { this.doomed = error; throw this.translate(error) }
      finally { this.depth-- }
    }
    this.depth = 1; this.rows = 0; this.bytes = 0; this.doomed = undefined; this.deferred = []
    let result: T
    try {
      this.database.exec('BEGIN IMMEDIATE')
      result = work()
      this.assertSynchronous(result)
      if (this.doomed) throw this.doomed
      this.checkpoint('transaction.beforeCommit')
      this.database.exec('COMMIT')
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch { /* BEGIN may have failed. */ }
      this.deferred = []
      throw this.translate(error)
    } finally { this.depth = 0 }
    const deferred = this.deferred; this.deferred = []
    for (const notify of deferred) { try { notify() } catch { /* An observer cannot undo durable commit. */ } }
    return result
  }
  charge(rows: number, bytes = 0): void {
    this.rows += rows; this.bytes += bytes
    if (this.rows > STORE_TXN_MAX_ROWS || this.bytes > STORE_TXN_MAX_BYTES) fail('too_large', 'Net transaction exceeded its row or byte limit.')
  }
  afterCommit(callback: () => void): void { if (this.depth) this.deferred.push(callback); else callback() }
  checkpoint(point: string): void { this.fault?.(point) }
  close(): void {
    if (this.closed) return
    if (this.depth) fail('internal', 'Cannot close a database during a transaction.')
    this.database.close(); this.closed = true
  }
  private assertSynchronous(result: unknown): void {
    if (result && typeof (result as { then?: unknown }).then === 'function') fail('bad_request', 'Net transactions cannot await asynchronous work.')
  }
  private translate(error: unknown): Error {
    if (error instanceof NetError) {
      if (error.code === 'storage_full' && this.writeFault !== 'storage_corrupt') this.writeFault = 'storage_full'
      if (error.code === 'storage_corrupt') this.fenceCorruption()
      return error
    }
    const code = (error as { errcode?: number })?.errcode
    if (code === 13) { if (this.writeFault !== 'storage_corrupt') this.writeFault = 'storage_full'; return new NetError('storage_full', undefined, { cause: error }) }
    if (code === 11 || code === 26) { this.fenceCorruption(); return new NetError('storage_corrupt', undefined, { cause: error }) }
    if (code === 19 || (code !== undefined && (code & 255) === 19)) return new NetError('conflict', 'Stored uniqueness or integrity constraint failed.', { cause: error })
    return error instanceof Error ? error : new NetError('internal', 'Net storage operation failed.', { cause: error })
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
      try { writeSync(fd, 'Net storage corruption detected; reconcile the ledger before removing this fence.\n'); fsyncSync(fd) } finally { closeSync(fd) }
      const directoryFd = openSync(this.directory, 'r')
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    } catch (cause) {
      // Keep the running process fenced even when the filesystem cannot record it.
      throw new NetError('storage_corrupt', 'Net writes are suspended; the corruption fence could not be persisted.', { cause })
    }
  }
}

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
`
