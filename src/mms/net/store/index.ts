import type { DatabaseSync } from 'node:sqlite'
import { NetDatabase } from './database'
import type { DatabaseOptions } from './database'
import { SqliteStreamStore } from './streams'
import type { MetaSnapshotValidator } from './streams'
import { SqliteOutbox } from './outbox'
import { SqliteExecutionLedger } from './executions'
import { SqliteBudgetLedger } from './budgets'
import { FileBlobStore } from './blobs'
import { SqliteQuotaRateLedger } from './limits'

export interface SqliteNetStoreOptions extends DatabaseOptions { validateMetaSnapshot?: MetaSnapshotValidator }

/** Profile-owned durable services. Callbacks share this database/transaction. */
export class SqliteNetStore {
  readonly database: DatabaseSync
  readonly streams: SqliteStreamStore
  readonly outbox: SqliteOutbox
  readonly executions: SqliteExecutionLedger
  readonly budgets: SqliteBudgetLedger
  readonly blobs: FileBlobStore
  readonly limits: SqliteQuotaRateLedger
  private readonly owner: NetDatabase
  constructor(options: SqliteNetStoreOptions) {
    this.owner = new NetDatabase(options)
    this.database = this.owner.database
    this.streams = new SqliteStreamStore(this.owner, options.validateMetaSnapshot)
    this.outbox = new SqliteOutbox(this.owner)
    this.executions = new SqliteExecutionLedger(this.owner)
    this.budgets = new SqliteBudgetLedger(this.owner)
    this.limits = new SqliteQuotaRateLedger(this.owner)
    try { this.blobs = new FileBlobStore(this.owner) } catch (error) { this.owner.close(); throw error }
  }
  transaction<T>(work: () => T): T { return this.owner.transaction(work) }
  afterCommit(callback: () => void): void { this.owner.afterCommit(callback) }
  close(): void { this.streams.close(); this.blobs.close(); this.owner.close() }
}

export { SqliteStreamStore } from './streams'
export type { MetaSnapshotValidator } from './streams'
export { SqliteOutbox } from './outbox'
export { SqliteExecutionLedger } from './executions'
export { SqliteBudgetLedger } from './budgets'
export { FileBlobStore } from './blobs'
export { SqliteQuotaRateLedger } from './limits'
export type { StorageLimitScope } from './limits'
