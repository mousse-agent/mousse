import { randomUUID } from 'node:crypto'
import { NetError } from '../../../shared/net'
import type { SpaceId, StreamHead } from '../../../shared/net'
import { NetDatabase, json } from '../../net/store/database'
import type { ArchiveState } from './contracts'

export interface ArchiveOperation {
  id: string
  space: SpaceId
  state: ArchiveState
  frozen: StreamHead
  digest?: string
  mode: 'source' | 'restore' | 'move'
}
const transitions: Partial<Record<ArchiveState, readonly ArchiveState[]>> = {
  frozen: ['exporting'],
  exporting: ['exported', 'failedFrozen'],
  failedFrozen: ['exporting'],
  exported: ['retiring'],
  retiring: ['retired'],
  importing: ['importedFrozen'],
  importedFrozen: ['activating'],
  activating: ['activeNew', 'importedFrozen']
}
/** Domain journal shares the NetDatabase transaction with every visibility flip. */
export class ArchiveJournal {
  constructor(readonly db: NetDatabase) {
    db.database.exec(
      'CREATE TABLE IF NOT EXISTS net_space_archive_operations(id TEXT PRIMARY KEY,space TEXT NOT NULL,state TEXT NOT NULL,value TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS net_space_archive_active(space TEXT PRIMARY KEY,operation TEXT NOT NULL REFERENCES net_space_archive_operations(id)) STRICT'
    )
    // Never resume an interrupted export or activate imported state automatically.
    const rows = db.database
      .prepare(
        "SELECT value FROM net_space_archive_operations o JOIN net_space_archive_active a ON a.operation=o.id WHERE state IN ('exporting','activating') LIMIT 129"
      )
      .all()
    if (rows.length > 128) throw new NetError('too_large')
    for (const row of rows) {
      const op = JSON.parse(row.value as string) as ArchiveOperation
      this.transition(op.id, op.state, op.state === 'exporting' ? 'failedFrozen' : 'importedFrozen')
    }
  }
  forSpace(space: SpaceId): ArchiveOperation | undefined {
    const row = this.db.database
      .prepare(
        'SELECT value FROM net_space_archive_operations o JOIN net_space_archive_active a ON a.operation=o.id WHERE a.space=?'
      )
      .get(space)
    return row ? JSON.parse(row.value as string) : undefined
  }
  create(
    space: SpaceId,
    frozen: StreamHead,
    state: 'frozen' | 'importing' = 'frozen',
    mode: ArchiveOperation['mode'] = 'source',
    digest?: string
  ): ArchiveOperation {
    if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest)) throw new NetError('bad_request')
    const op = { id: randomUUID(), space, state, frozen, mode, ...(digest ? { digest } : {}) }
    this.db.transaction(() => {
      if (
        Number(
          this.db.database.prepare('SELECT count(*) AS n FROM net_space_archive_operations').get()!
            .n
        ) >= 4096
      )
        throw new NetError('too_large')
      this.db.charge(2, Buffer.byteLength(json(op)))
      this.db.database
        .prepare('INSERT INTO net_space_archive_operations VALUES(?,?,?,?)')
        .run(op.id, space, state, json(op))
      this.db.database
        .prepare(
          'INSERT INTO net_space_archive_active VALUES(?,?) ON CONFLICT(space) DO UPDATE SET operation=excluded.operation'
        )
        .run(space, op.id)
    })
    return op
  }
  transition(
    id: string,
    expected: ArchiveState,
    state: ArchiveState,
    digest?: string
  ): ArchiveOperation {
    return this.db.transaction(() => {
      const row = this.db.database
        .prepare('SELECT value FROM net_space_archive_operations WHERE id=? AND state=?')
        .get(id, expected)
      if (
        !row ||
        !transitions[expected]?.includes(state) ||
        (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest))
      )
        throw new NetError('conflict')
      const op = {
        ...JSON.parse(row.value as string),
        state,
        ...(digest ? { digest } : {})
      } as ArchiveOperation
      if (state === 'exported' && !op.digest) throw new NetError('conflict')
      this.db.charge(1, Buffer.byteLength(json(op)))
      this.db.database
        .prepare('UPDATE net_space_archive_operations SET state=?,value=? WHERE id=?')
        .run(state, json(op), id)
      return op
    })
  }
  allows(space: SpaceId, action: 'read' | 'write'): boolean {
    const op = this.forSpace(space),
      state = op?.state
    if (!state || state === 'activeNew') return true
    return (
      action === 'read' &&
      op?.mode === 'source' &&
      ['frozen', 'exporting', 'exported', 'failedFrozen'].includes(state)
    )
  }
}
