import type { NetDatabase } from './database'

/** A saved rollout larger than this is not kept: a few dozen computers fit many times over. */
const MAX_BYTES = 256 * 1024

/**
 * Update everywhere's one rollout (`updates/rollout.ts`), kept in the profile's Net database so it outlives a restart
 * of the service, this computer's own install included. Kept on this computer only, never sent anywhere.
 */
export class SqliteUpdateRollout {
  constructor(readonly db: NetDatabase) {}

  read(): unknown {
    const row = this.db.database.prepare('SELECT value FROM net_update_rollout WHERE singleton=1').get()
    if (typeof row?.value !== 'string') return null
    try {
      return JSON.parse(row.value)
    } catch {
      return null
    }
  }

  write(value: unknown): void {
    const text = value === null || value === undefined ? undefined : JSON.stringify(value)
    if (text && text.length > MAX_BYTES) throw new Error('The update of your computers is too large to keep.')
    this.db.transaction(() => {
      this.db.charge(1, text?.length ?? 0)
      if (text === undefined) this.db.database.prepare('DELETE FROM net_update_rollout').run()
      else
        this.db.database
          .prepare('INSERT INTO net_update_rollout(singleton,value) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value')
          .run(text)
    })
  }
}
