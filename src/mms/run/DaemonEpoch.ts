import type { RunStore } from './RunStore'
import type { DaemonEpochRecord } from './types'

type Row = Record<string, unknown>

/**
 * Daemon generations (SPEC §12.1, §12.5). Each boot inserts a row; a clean shutdown sets
 * `ended_at`. A previous row without `ended_at` means the previous daemon crashed.
 */
export class DaemonEpoch {
  constructor(readonly store: RunStore) {}

  begin(
    pid: number,
    now: string
  ): { epoch: number; previous: DaemonEpochRecord | null; previousCrashed: boolean } {
    return this.store.db.transaction(() => {
      const previous = this.current()
      const result = this.store.db
        .statement('INSERT INTO daemon_epochs(pid, started_at, heartbeat_at) VALUES(?, ?, ?)')
        .run(pid, now, now)
      return {
        epoch: Number(result.lastInsertRowid),
        previous,
        previousCrashed: previous !== null && previous.endedAt === null
      }
    })
  }

  heartbeat(epoch: number, now: string): boolean {
    return this.store.db.transaction(
      () =>
        Number(
          this.store.db
            .statement(
              'UPDATE daemon_epochs SET heartbeat_at = ? WHERE epoch = ? AND ended_at IS NULL'
            )
            .run(now, epoch).changes
        ) === 1
    )
  }

  end(epoch: number, now: string): boolean {
    return this.store.db.transaction(
      () =>
        Number(
          this.store.db
            .statement(
              'UPDATE daemon_epochs SET ended_at = ?, heartbeat_at = ? WHERE epoch = ? AND ended_at IS NULL'
            )
            .run(now, now, epoch).changes
        ) === 1
    )
  }

  /** The newest epoch row, live or not. */
  current(): DaemonEpochRecord | null {
    const row = this.store.db
      .statement('SELECT * FROM daemon_epochs ORDER BY epoch DESC LIMIT 1')
      .get()
    return row ? toEpoch(row) : null
  }
}

function toEpoch(row: Row): DaemonEpochRecord {
  return {
    epoch: Number(row.epoch),
    pid: Number(row.pid),
    startedAt: String(row.started_at),
    heartbeatAt: String(row.heartbeat_at),
    endedAt: typeof row.ended_at === 'string' ? row.ended_at : null
  }
}
