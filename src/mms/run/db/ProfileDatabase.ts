import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { RunStoreError, fail } from './RunStoreError'

export type ProfileDatabaseFault = (point: string) => void

export interface ProfileDatabaseOptions {
  profileHome: string
  /** Storage name: opens `<profileHome>/<name>/<name>.db`. Defaults to `run`. */
  name?: string
  /** Milliseconds since the epoch. */
  clock?: () => number
  /** Fault-injection hook called at named checkpoints. Throwing aborts the operation. */
  fault?: ProfileDatabaseFault
}

export interface Migration {
  version: number
  sql: string
}

// SQLite primary result codes (node:sqlite reports extended codes in `errcode`).
const SQLITE_IOERR = 10
const SQLITE_CORRUPT = 11
const SQLITE_FULL = 13
const SQLITE_CONSTRAINT = 19
const SQLITE_NOTADB = 26

/**
 * One profile-scoped SQLite connection with a single synchronous transaction boundary.
 * Extracted from the Net store; see docs/run-engine/SPEC.md §8.
 */
export class ProfileDatabase {
  readonly database: DatabaseSync
  readonly path: string
  readonly directory: string
  readonly clock: () => number
  readonly fault?: ProfileDatabaseFault
  private depth = 0
  private doomed: unknown
  private deferred: Array<() => void> = []
  private closed = false
  private statements = new Map<string, StatementSync>()

  constructor(options: ProfileDatabaseOptions) {
    this.clock = options.clock ?? Date.now
    this.fault = options.fault
    const name = options.name ?? 'run'
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) fail('bad_request', 'Invalid profile database name.')
    const profile = realpathSync(resolve(options.profileHome))
    this.directory = join(profile, name)
    if (existsSync(this.directory) && lstatSync(this.directory).isSymbolicLink())
      fail('bad_request', 'Profile database directory cannot be a symlink.')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (realpathSync(this.directory) !== this.directory)
      fail('bad_request', 'Profile database directory escaped the profile.')
    this.path = join(this.directory, `${name}.db`)
    if (existsSync(this.path)) {
      const stat = lstatSync(this.path)
      if (stat.isSymbolicLink() || !stat.isFile())
        fail('bad_request', 'Profile database is not an owned regular file.')
    }
    try {
      this.database = new DatabaseSync(this.path)
    } catch (error) {
      throw this.translate(error)
    }
    try {
      chmodSync(this.path, 0o600)
      this.database.exec(
        'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'
      )
      const integrity = this.database.prepare('PRAGMA quick_check').all()
      if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok')
        fail(
          'storage_corrupt',
          'Profile database failed its integrity check; recovery is required.'
        )
    } catch (error) {
      this.database.close()
      this.closed = true
      throw this.translate(error)
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0
  }

  /** Cached prepared statement on this connection. */
  statement(sql: string): StatementSync {
    if (this.closed) fail('internal', 'Profile database is closed.')
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.database.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  /**
   * Runs `work` inside `BEGIN IMMEDIATE`. Nested calls join the outer transaction; an error
   * thrown by a nested call dooms the outer transaction even if the caller catches it.
   * `work` must be synchronous: no I/O and no awaiting inside a transaction.
   */
  transaction<T>(work: () => T): T {
    if (this.closed) fail('internal', 'Profile database is closed.')
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
        /* BEGIN may have failed, or SQLite already rolled back. */
      }
      this.deferred = []
      throw this.translate(error)
    } finally {
      this.depth = 0
      this.doomed = undefined
    }
    const deferred = this.deferred
    this.deferred = []
    for (const notify of deferred) {
      try {
        notify()
      } catch {
        /* An observer cannot undo a durable commit. */
      }
    }
    return result
  }

  /** Runs `callback` after the outermost transaction commits; immediately when outside one. */
  afterCommit(callback: () => void): void {
    if (this.depth) this.deferred.push(callback)
    else callback()
  }

  checkpoint(point: string): void {
    this.fault?.(point)
  }

  /**
   * Applies migrations newer than `PRAGMA user_version`, each in its own transaction, and
   * records them in `run_schema_migrations`. Refuses a database newer than the known schema.
   */
  migrate(migrations: readonly Migration[]): void {
    let previous = 0
    for (const migration of migrations) {
      if (!Number.isSafeInteger(migration.version) || migration.version <= previous)
        fail('bad_request', 'Migrations must have strictly increasing positive versions.')
      previous = migration.version
    }
    const current = this.userVersion()
    if (current > previous)
      fail(
        'downgrade_unsupported',
        `Profile database schema ${current} is newer than this build (${previous}).`
      )
    for (const migration of migrations) {
      if (migration.version <= current) continue
      this.transaction(() => {
        this.database.exec(migration.sql)
        this.database.exec(
          'CREATE TABLE IF NOT EXISTS run_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT'
        )
        this.database
          .prepare('INSERT INTO run_schema_migrations(version, applied_at) VALUES(?, ?)')
          .run(migration.version, new Date(this.clock()).toISOString())
        this.checkpoint('migration.beforeCommit')
        this.database.exec(`PRAGMA user_version=${migration.version}`)
      })
    }
  }

  userVersion(): number {
    return Number(this.database.prepare('PRAGMA user_version').get()!.user_version)
  }

  close(): void {
    if (this.closed) return
    if (this.depth) fail('internal', 'Cannot close a database during a transaction.')
    this.statements.clear()
    this.database.close()
    this.closed = true
  }

  private assertSynchronous(result: unknown): void {
    if (result && typeof (result as { then?: unknown }).then === 'function')
      fail('bad_request', 'Profile database transactions cannot await asynchronous work.')
  }

  private translate(error: unknown): Error {
    if (error instanceof RunStoreError) return error
    const errcode = (error as { errcode?: number })?.errcode
    const code = errcode === undefined ? undefined : errcode & 255
    if (code === SQLITE_FULL || code === SQLITE_IOERR)
      return new RunStoreError('storage_full', 'Profile database storage is full or failing.', {
        cause: error
      })
    if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB)
      return new RunStoreError('storage_corrupt', 'Profile database is corrupt.', { cause: error })
    if (code === SQLITE_CONSTRAINT)
      return new RunStoreError('conflict', 'Stored uniqueness or integrity constraint failed.', {
        cause: error
      })
    return error instanceof Error
      ? error
      : new RunStoreError('internal', 'Profile database operation failed.', { cause: error })
  }
}
