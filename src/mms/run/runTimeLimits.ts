import type { RunStore } from './RunStore'

/**
 * Running-time limits of runs on this computer (issue #685): table `run_time_limits`. An agent on another computer that
 * starts a subagent here with `maxMinutes` gives the run it starts a limit; `RunTimeLimits` counts the run's running
 * time against it and stops the run when it is used up. The row goes when the run ends.
 */
export interface RunTimeLimitRecord {
  runId: string
  threadId: string
  limitMs: number
  usedMs: number
}

export class RunTimeLimitRecords {
  constructor(private readonly store: RunStore) {}

  /** Gives `runId` a limit; a run that has one keeps it and what it used (a retry of the same send). */
  set(runId: string, threadId: string, limitMs: number): void {
    const now = this.now()
    this.store.db
      .statement(
        `INSERT INTO run_time_limits(run_id, thread_id, limit_ms, used_ms, created_at, updated_at) VALUES(?, ?, ?, 0, ?, ?)
         ON CONFLICT(run_id) DO NOTHING`
      )
      .run(runId, threadId, limitMs, now, now)
  }

  get(runId: string): RunTimeLimitRecord | null {
    const row = this.store.db.statement('SELECT * FROM run_time_limits WHERE run_id = ?').get(runId)
    return row ? { runId: String(row.run_id), threadId: String(row.thread_id), limitMs: Number(row.limit_ms), usedMs: Number(row.used_ms) } : null
  }

  list(): RunTimeLimitRecord[] {
    return this.store.db
      .statement('SELECT * FROM run_time_limits ORDER BY created_at, rowid')
      .all()
      .map((row) => ({ runId: String(row.run_id), threadId: String(row.thread_id), limitMs: Number(row.limit_ms), usedMs: Number(row.used_ms) }))
  }

  has(): boolean {
    return Boolean(this.store.db.statement('SELECT 1 FROM run_time_limits LIMIT 1').get())
  }

  setUsed(runId: string, usedMs: number): void {
    this.store.db.statement('UPDATE run_time_limits SET used_ms = ?, updated_at = ? WHERE run_id = ?').run(Math.round(usedMs), this.now(), runId)
  }

  remove(runId: string): void {
    this.store.db.statement('DELETE FROM run_time_limits WHERE run_id = ?').run(runId)
  }

  private now(): string {
    return new Date(this.store.db.clock()).toISOString()
  }
}
