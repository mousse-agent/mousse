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
    expect(database.userVersion()).toBe(RUN_MIGRATIONS.at(-1)!.version)
    const applied = database.database.prepare('SELECT version FROM run_schema_migrations').all()
    expect(applied).toEqual(RUN_MIGRATIONS.map(({ version }) => ({ version })))
    const journal = database.database.prepare('PRAGMA journal_mode').get()!
    expect(journal.journal_mode).toBe('wal')
  })

  it('refuses a database whose schema is newer than the known migrations', () => {
    const database = open()
    database.migrate(RUN_MIGRATIONS)
    database.database.exec(`PRAGMA user_version=${RUN_MIGRATIONS.at(-1)!.version + 1}`)
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

  describe('the agent access level columns (the migration after the runs rebuild)', () => {
    const access = RUN_MIGRATIONS.find((migration) => migration.sql.includes('access_level'))!
    const before = RUN_MIGRATIONS.filter((migration) => migration.version < access.version)

    it('comes after the runs rebuild, so a profile already at the rebuild\'s version still gets it', () => {
      const rebuild = RUN_MIGRATIONS.find((migration) => migration.foreignKeys === 'off')!
      expect(access.version).toBeGreaterThan(rebuild.version)
      expect(RUN_MIGRATIONS.map((migration) => migration.version)).toEqual(RUN_MIGRATIONS.map((_migration, index) => index + 1))
    })

    it('upgrades a database that has credentials and delegations: old rows read as lineage, and the levels are checked', () => {
      const database = open()
      database.migrate(before)
      expect(database.userVersion()).toBe(access.version - 1)
      database.database
        .prepare(`INSERT INTO runs(run_id, thread_id, ordinal, status, epoch, source, requested_at, stop_generation)
          VALUES('r-old', 't1', 1, 'completed', 0, 'gui', '2026-10-12T00:00:00.000Z', 0)`)
        .run()
      database.database
        .prepare("INSERT INTO credentials(token_hash, thread_id, run_id, provider, mode_ceiling, created_at, revoked_at, last_seen_at) VALUES('old', 't1', 'r1', 'claude', 'default', '2026-10-12T00:00:00.000Z', NULL, '2026-10-12T00:00:00.000Z')")
        .run()
      database.database
        .prepare(`INSERT INTO delegations(delegation_id, parent_run_id, parent_thread_id, child_thread_id, child_run_id, provider, model, prompt_digest, wake, status, result, created_at, completed_at, mode_ceiling, workspace, role)
          VALUES('d-old', 'rp', 'tp', 'tc', 'rc', NULL, NULL, 'digest', 'always', 'running', NULL, '2026-10-12T00:00:00.000Z', NULL, NULL, NULL, NULL)`)
        .run()
      database.migrate(RUN_MIGRATIONS)
      expect(database.userVersion()).toBe(RUN_MIGRATIONS.at(-1)!.version)
      expect(database.database.prepare("SELECT access_level FROM credentials WHERE token_hash = 'old'").get()).toEqual({ access_level: 'lineage' })
      expect(database.database.prepare("SELECT access_level FROM delegations WHERE delegation_id = 'd-old'").get()).toEqual({ access_level: null })
      expect(database.database.prepare("SELECT access_grant FROM runs").all()).toEqual([{ access_grant: null }])
      expect(() => database.database.prepare("UPDATE credentials SET access_level = 'root'").run()).toThrow(/CHECK/)
      expect(() => database.database.prepare("UPDATE delegations SET access_level = 'root'").run()).toThrow(/CHECK/)
      expect(() => database.database.prepare("UPDATE runs SET access_grant = 'root'").run()).toThrow(/CHECK/)
    })
  })

  describe('the runs rebuild (a migration that runs with foreign keys off)', () => {
    const rebuild = RUN_MIGRATIONS.find((migration) => migration.foreignKeys === 'off')!
    const older = RUN_MIGRATIONS.filter((migration) => migration.version < rebuild.version)
    const foreignKeys = (database: ProfileDatabase): number => Number(database.database.prepare('PRAGMA foreign_keys').get()!.foreign_keys)
    // The columns the rebuild copied; a later migration adds more (access_grant), which these tests do not compare.
    const runs = (database: ProfileDatabase) => database.database.prepare('SELECT * FROM runs ORDER BY run_id').all().map(({ access_grant: _grant, ...row }) => row)
    const insertRun = (database: ProfileDatabase, status: string): void => {
      database.database
        .prepare(
          `INSERT INTO runs(run_id, thread_id, ordinal, status, epoch, active_attempt_id, source, client_request_id,
             user_message_id, requested_at, started_at, completed_at, outcome, heartbeat_at, stop_generation)
           VALUES(?, ?, 1, ?, 0, NULL, 'gui', NULL, NULL, '2026-10-12T00:00:00.000Z', NULL, NULL, NULL, NULL, 0)`
        )
        .run(`run:${status}`, `thread-${status}`, status)
    }

    /** A database at the version before the rebuild, with runs that set every column to a non-default value. */
    const seeded = (fault?: (point: string) => void): ProfileDatabase => {
      const database = open(fault)
      database.migrate(older)
      const run = database.database.prepare(
        `INSERT INTO runs(run_id, thread_id, ordinal, status, epoch, active_attempt_id, source, client_request_id,
           user_message_id, requested_at, started_at, completed_at, outcome, heartbeat_at, stop_generation)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      run.run('run:a', 't1', 1, 'running', 3, 'attempt:run:a:1', 'gui', 'req-a', 'msg-a', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:01.000Z', null, '{"stopRequested":true}', '2026-10-12T00:00:09.000Z', 4)
      run.run('run:b', 't1', 2, 'completed', 5, null, 'wake', null, null, '2026-10-12T00:01:00.000Z', '2026-10-12T00:01:01.000Z', '2026-10-12T00:02:00.000Z', '{"continuationOf":"run:a"}', null, 0)
      run.run('run:c', 't2', 1, 'queued', 0, null, 'delegation', 'req-c', null, '2026-10-12T00:03:00.000Z', null, null, null, null, 2)
      const attempt = database.database.prepare(
        `INSERT INTO run_attempts(attempt_id, run_id, ordinal, reason, status, provider_ref, started_at, completed_at, execution_binding)
         VALUES(?, ?, 1, 'initial', ?, ?, ?, ?, ?)`
      )
      attempt.run('attempt:run:a:1', 'run:a', 'running', '{"provider":"claude"}', '2026-10-12T00:00:01.000Z', null, '{"instanceId":"claude"}')
      attempt.run('attempt:run:b:1', 'run:b', 'completed', null, null, '2026-10-12T00:02:00.000Z', null)
      return database
    }

    it('keeps every row, every reference and the index, accepts paused, and turns foreign keys back on', () => {
      const database = seeded()
      const rows = runs(database)
      const attempts = database.database.prepare('SELECT * FROM run_attempts ORDER BY attempt_id').all()
      // Before the rebuild the CHECK refuses paused.
      expect(() => insertRun(database, 'paused')).toThrow(/CHECK/)
      expect(database.userVersion()).toBe(rebuild.version - 1)

      database.migrate(RUN_MIGRATIONS)

      expect(database.userVersion()).toBe(RUN_MIGRATIONS.at(-1)!.version)
      expect(runs(database)).toEqual(rows)
      expect(database.database.prepare('SELECT * FROM run_attempts ORDER BY attempt_id').all()).toEqual(attempts)
      expect(database.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(database.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runs_thread_status'").all()).toHaveLength(1)
      // The rebuild's columns in order, then the one the next migration adds.
      expect(database.database.prepare('PRAGMA table_info(runs)').all().map((column) => column.name)).toEqual([
        'run_id', 'thread_id', 'ordinal', 'status', 'epoch', 'active_attempt_id', 'source', 'client_request_id',
        'user_message_id', 'requested_at', 'started_at', 'completed_at', 'outcome', 'heartbeat_at', 'stop_generation', 'access_grant'
      ])
      // The new CHECK takes paused and still refuses anything else.
      insertRun(database, 'paused')
      expect(() => insertRun(database, 'sleeping')).toThrow(/CHECK/)
      // Foreign keys are enforced again on the connection that migrated.
      expect(foreignKeys(database)).toBe(1)
      expect(() => database.database
        .prepare("INSERT INTO run_attempts(attempt_id, run_id, ordinal, reason, status) VALUES('attempt:ghost:1', 'run:ghost', 1, 'initial', 'pending')")
        .run()).toThrow(/FOREIGN KEY/)
    })

    it('rolls back to the old schema, rows and version when the commit fails', () => {
      let armed = false
      const database = seeded((point) => {
        if (armed && point === 'migration.beforeCommit') throw new Error('injected')
      })
      const rows = runs(database)
      armed = true
      expect(() => database.migrate(RUN_MIGRATIONS)).toThrow('injected')
      armed = false

      expect(database.userVersion()).toBe(rebuild.version - 1)
      expect(runs(database)).toEqual(rows)
      expect(database.database.prepare("SELECT name FROM sqlite_master WHERE name = 'runs_new'").all()).toEqual([])
      expect(() => insertRun(database, 'paused')).toThrow(/CHECK/)
      expect(foreignKeys(database)).toBe(1)
      // The failure left nothing behind: the same migration applies on the next open.
      database.migrate(RUN_MIGRATIONS)
      expect(database.userVersion()).toBe(RUN_MIGRATIONS.at(-1)!.version)
      expect(runs(database)).toEqual(rows)
    })

    it('rolls back when the rebuilt table leaves an invalid reference', () => {
      const database = seeded()
      const rows = runs(database)
      // A rebuild that loses a run its attempts still name.
      const lossy = { ...rebuild, sql: `${rebuild.sql}\nDELETE FROM runs WHERE run_id = 'run:a';` }

      expect(codeOf(() => database.migrate([...older, lossy]))).toBe('internal')

      expect(database.userVersion()).toBe(rebuild.version - 1)
      expect(runs(database)).toEqual(rows)
      expect(database.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(foreignKeys(database)).toBe(1)
      expect(database.database.prepare('SELECT version FROM run_schema_migrations ORDER BY version').all().at(-1)).toEqual({ version: rebuild.version - 1 })
    })

    it('refuses to run inside a transaction, where foreign keys cannot be switched off', () => {
      const database = seeded()
      expect(codeOf(() => database.transaction(() => database.migrate(RUN_MIGRATIONS)))).toBe('bad_request')
      expect(database.userVersion()).toBe(rebuild.version - 1)
      expect(foreignKeys(database)).toBe(1)
    })
  })

  describe('the approval requests table (migration 12)', () => {
    const migration = RUN_MIGRATIONS.find((candidate) => candidate.sql.includes('CREATE TABLE approval_requests'))!
    const before = RUN_MIGRATIONS.filter((candidate) => candidate.version < migration.version)
    const columns = (database: ProfileDatabase) => database.database.prepare('PRAGMA table_info(approval_requests)').all().map((column) => String(column.name))
    const tables = (database: ProfileDatabase) => database.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => String(row.name))
    /** A database from before the table, with a run, an event and a receipt in it. */
    const seeded = (): ProfileDatabase => {
      const database = open()
      database.migrate(before)
      database.database.exec(
        `INSERT INTO runs(run_id, thread_id, ordinal, status, epoch, source, requested_at) VALUES('run:a', 't1', 1, 'interrupted', 2, 'gui', '2026-10-12T00:00:00.000Z');
         INSERT INTO thread_events(thread_id, run_id, type, payload, created_at) VALUES('t1', 'run:a', 'restart.note', '{}', '2026-10-12T00:00:01.000Z')`
      )
      insert(database, 'receipt-a')
      return database
    }

    it('is a new version, after the pause rebuild', () => {
      expect(migration.version).toBeGreaterThan(10)
      expect(RUN_MIGRATIONS.at(-1)).toBe(migration)
      expect(migration.foreignKeys).toBeUndefined()
    })

    it('adds the table and its two indexes to an older database and keeps everything else as it was', () => {
      const database = seeded()
      const tablesBefore = tables(database)
      expect(columns(database)).toEqual([])
      const run = database.database.prepare('SELECT * FROM runs').all()
      const events = database.database.prepare('SELECT * FROM thread_events').all()

      database.migrate(RUN_MIGRATIONS)

      expect(database.userVersion()).toBe(migration.version)
      expect(tables(database)).toEqual([...tablesBefore, 'approval_requests'].sort())
      expect(columns(database)).toEqual([
        'request_id', 'thread_id', 'run_id', 'instance_id', 'provider', 'action', 'permission_key', 'fingerprint', 'questions',
        'reason', 'answer_path', 'uncertain', 'uncertain_tools', 'status', 'answers', 'decision', 'decision_scope', 'feedback',
        'answered_by', 'cancel_reason', 'continuation_run_id', 'grant_consumed_at', 'delivered_at', 'created_at', 'settled_at'
      ])
      expect(database.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approval_requests' AND name LIKE 'approval_requests_%' ORDER BY name").all())
        .toEqual([{ name: 'approval_requests_run' }, { name: 'approval_requests_thread' }])
      expect(database.database.prepare('SELECT * FROM runs').all()).toEqual(run)
      expect(database.database.prepare('SELECT * FROM thread_events').all()).toEqual(events)
      expect(count(database)).toBe(1)
      expect(database.database.prepare('SELECT COUNT(*) AS n FROM approval_requests').get()).toEqual({ n: 0 })
    })

    it('stores a request with its defaults, refuses a row missing a required column, and is STRICT about types', () => {
      const database = seeded()
      database.migrate(RUN_MIGRATIONS)
      database.database
        .prepare(`INSERT INTO approval_requests(request_id, thread_id, instance_id, provider, action, permission_key, questions, answer_path, status, created_at)
                  VALUES('r1', 't1', 'claude', 'claude', 'command', 'claude:command', '[]', 'live', 'pending', '2026-10-12T00:00:02.000Z')`)
        .run()
      expect(database.database.prepare('SELECT uncertain, run_id, fingerprint, delivered_at FROM approval_requests').get()).toEqual({ uncertain: 0, run_id: null, fingerprint: null, delivered_at: null })
      expect(() => database.database.prepare("INSERT INTO approval_requests(request_id, thread_id) VALUES('r2', 't1')").run()).toThrow(/NOT NULL/)
      expect(() => database.database
        .prepare(`INSERT INTO approval_requests(request_id, thread_id, instance_id, provider, action, permission_key, questions, answer_path, uncertain, status, created_at)
                  VALUES('r3', 't1', 'claude', 'claude', 'command', 'claude:command', '[]', 'live', 'yes', 'pending', 'now')`)
        .run()).toThrow(/cannot store TEXT value in INTEGER column|datatype/i)
    })

    it('opens idempotently, and a build that predates it refuses the newer database instead of reading it wrong', () => {
      const database = open()
      database.migrate(RUN_MIGRATIONS)
      database.migrate(RUN_MIGRATIONS)
      expect(database.database.prepare('SELECT version FROM run_schema_migrations ORDER BY version').all().at(-1)).toEqual({ version: migration.version })
      expect(codeOf(() => database.migrate(before))).toBe('downgrade_unsupported')
      expect(database.userVersion()).toBe(migration.version)
    })

    it('rolls back with its version when the commit fails, and applies on the next open', () => {
      let armed = false
      profileHome = mkdtempSync(join(tmpdir(), 'mousse-run-db-'))
      db = new ProfileDatabase({ profileHome, fault: (point) => { if (armed && point === 'migration.beforeCommit') throw new Error('injected') } })
      db.migrate(before)
      armed = true
      expect(() => db!.migrate(RUN_MIGRATIONS)).toThrow('injected')
      armed = false
      expect(db.userVersion()).toBe(before.at(-1)!.version)
      expect(columns(db)).toEqual([])
      db.migrate(RUN_MIGRATIONS)
      expect(db.userVersion()).toBe(migration.version)
      expect(columns(db)).toContain('request_id')
    })
  })

  it('refuses a symlinked run directory', () => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-run-db-'))
    const elsewhere = join(profileHome, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(profileHome, 'run'))
    expect(codeOf(() => new ProfileDatabase({ profileHome: profileHome! }))).toBe('bad_request')
  })
})
