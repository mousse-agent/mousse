import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RUN_MIGRATIONS } from '../../src/mms/run/db/migrations'
import { RunStoreError } from '../../src/mms/run/db/RunStoreError'

function codeOf(work: () => unknown): string | undefined {
  try {
    work()
  } catch (error) {
    if (error instanceof RunStoreError) return error.code
    throw error
  }
  return undefined
}

describe('ProfileDatabase', () => {
  let profileHome: string | undefined
  let db: ProfileDatabase | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  const open = (fault?: (point: string) => void): ProfileDatabase => {
    profileHome ??= mkdtempSync(join(tmpdir(), 'mousse-run-db-'))
    db = new ProfileDatabase({ profileHome, fault })
    return db
  }
  const count = (database: ProfileDatabase): number =>
    Number(database.database.prepare('SELECT COUNT(*) AS n FROM receipts').get()!.n)
  const insert = (database: ProfileDatabase, id: string): void => {
    database.database
      .prepare(
        "INSERT INTO receipts VALUES(?, 'thread', 'send', 'accepted', NULL, '2026-10-12T00:00:00.000Z')"
      )
      .run(id)
  }

  it('opens <profileHome>/run/run.db with owner-only permissions and migrates idempotently', () => {
    const database = open()
    expect(database.path).toBe(join(database.directory, 'run.db'))
    expect(statSync(database.directory).mode & 0o777).toBe(0o700)
    expect(statSync(database.path).mode & 0o777).toBe(0o600)
    database.migrate(RUN_MIGRATIONS)
    database.migrate(RUN_MIGRATIONS)
    expect(database.userVersion()).toBe(1)
    const applied = database.database.prepare('SELECT version FROM run_schema_migrations').all()
    expect(applied).toEqual([{ version: 1 }])
    const journal = database.database.prepare('PRAGMA journal_mode').get()!
    expect(journal.journal_mode).toBe('wal')
  })

  it('refuses a database whose schema is newer than the known migrations', () => {
    const database = open()
    database.migrate(RUN_MIGRATIONS)
    database.database.exec('PRAGMA user_version=2')
    expect(codeOf(() => database.migrate(RUN_MIGRATIONS))).toBe('downgrade_unsupported')
  })

  it('commits a transaction', () => {
    const database = open()
    database.migrate(RUN_MIGRATIONS)
    expect(database.transaction(() => (insert(database, 'a'), 'done'))).toBe('done')
    expect(count(database)).toBe(1)
  })

  it('rolls back when work throws', () => {
    const database = open()
    database.migrate(RUN_MIGRATIONS)
    expect(() =>
      database.transaction(() => {
        insert(database, 'a')
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(count(database)).toBe(0)
    expect(database.inTransaction).toBe(false)
  })

  it('dooms the outer transaction when a nested transaction throws', () => {
    const database = open()
    database.migrate(RUN_MIGRATIONS)
    expect(() =>
      database.transaction(() => {
        insert(database, 'a')
        try {
          database.transaction(() => {
            throw new Error('inner')
          })
        } catch {
          /* swallowed by the caller; the outer transaction must still roll back */
        }
      })
    ).toThrow('inner')
    expect(count(database)).toBe(0)
  })

  it('runs afterCommit callbacks only after commit and never on rollback', () => {
    const database = open()
    database.migrate(RUN_MIGRATIONS)
    const calls: string[] = []
    database.transaction(() => {
      database.afterCommit(() => calls.push(`committed:${database.inTransaction}`))
      database.transaction(() => database.afterCommit(() => calls.push('nested')))
      calls.push('work')
    })
    expect(calls).toEqual(['work', 'committed:false', 'nested'])
    calls.length = 0
    expect(() =>
      database.transaction(() => {
        database.afterCommit(() => calls.push('should-not-run'))
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(calls).toEqual([])
  })

  it('rejects asynchronous work with bad_request and rolls back', () => {
    const database = open()
    database.migrate(RUN_MIGRATIONS)
    expect(
      codeOf(() =>
        database.transaction(() => {
          insert(database, 'a')
          return Promise.resolve()
        })
      )
    ).toBe('bad_request')
    expect(count(database)).toBe(0)
  })

  it('rolls back when the beforeCommit fault hook throws', () => {
    let armed = false
    const points: string[] = []
    const database = open((point) => {
      points.push(point)
      if (armed && point === 'transaction.beforeCommit') throw new Error('injected')
    })
    database.migrate(RUN_MIGRATIONS)
    armed = true
    expect(() => database.transaction(() => insert(database, 'a'))).toThrow('injected')
    expect(count(database)).toBe(0)
    expect(points).toContain('transaction.beforeCommit')
  })

  it('refuses to close during a transaction', () => {
    const database = open()
    expect(codeOf(() => database.transaction(() => database.close()))).toBe('internal')
  })

  it('refuses a symlinked run directory', () => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-run-db-'))
    const elsewhere = join(profileHome, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(profileHome, 'run'))
    expect(codeOf(() => new ProfileDatabase({ profileHome: profileHome! }))).toBe('bad_request')
  })
})
