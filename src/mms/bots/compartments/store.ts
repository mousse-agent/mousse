import type { CompartmentBinding, CompartmentStore } from '../../net/contracts'
import type { BotId, SpaceId, StreamId, UserId } from '../../../shared/net'
import { isId, NetError } from '../../../shared/net'
import { NetDatabase, integer, json, same } from '../../net/store/database'
import { decodeBase64 } from '../../net/identity/crypto'
export type CompartmentTurn = { role: 'user' | 'assistant'; author?: UserId | BotId; text: string; ts: number }
/** Executor-local context. These tables are deliberately absent from every space snapshot/export. */
export class SqliteCompartmentStore implements CompartmentStore {
  constructor(readonly db: NetDatabase, readonly profileId: string) {
    if (!profileId || profileId.length > 256) throw new NetError('bad_request')
    db.transaction(() => db.database.exec(`
      CREATE TABLE IF NOT EXISTS net_bot_compartments(id TEXT PRIMARY KEY,profile TEXT NOT NULL,binding TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS net_bot_compartment_turns(id INTEGER PRIMARY KEY,compartment TEXT NOT NULL REFERENCES net_bot_compartments(id) ON DELETE CASCADE,turn TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS net_bot_context_order ON net_bot_compartment_turns(compartment,id);
    `))
  }
  publicId(bot: BotId, space: SpaceId): string {
    if (!isId('bot', bot) || !isId('space', space)) throw new NetError('bad_request')
    return `cmp1/public/${bot}/${space}`
  }
  privateId(bot: BotId, stream: StreamId, visibilityEpoch: number): string {
    if (!isId('bot', bot) || !isId('stream', stream)) throw new NetError('bad_request')
    integer(visibilityEpoch, 1)
    return `cmp1/private/${bot}/${stream}/${visibilityEpoch}`
  }
  bind(id: string, binding: CompartmentBinding): void {
    this.validate(id, binding)
    this.db.transaction(() => {
      const previous = this.binding(id)
      if (previous) { if (!same(previous, binding)) throw new NetError('conflict'); return }
      const text = json(binding); this.db.charge(1, Buffer.byteLength(text))
      this.db.database.prepare('INSERT INTO net_bot_compartments VALUES(?,?,?)').run(id, this.profileId, text)
    })
  }
  binding(id: string): CompartmentBinding | undefined {
    const row = this.db.database.prepare('SELECT profile,binding FROM net_bot_compartments WHERE id=?').get(id)
    if (!row) return undefined
    if (row.profile !== this.profileId) throw new NetError('forbidden')
    const binding = JSON.parse(row.binding as string); this.validate(id, binding); return binding
  }
  appendTurn(id: string, turn: CompartmentTurn): void {
    if (!this.binding(id)) throw new NetError('forbidden')
    if (!['user','assistant'].includes(turn.role) || typeof turn.text !== 'string' || Buffer.byteLength(turn.text) > 65536 || turn.author !== undefined && !isId('user', turn.author) && !isId('bot', turn.author)) throw new NetError('bad_request')
    integer(turn.ts)
    this.db.transaction(() => {
      if (!this.binding(id)) throw new NetError('forbidden')
      const text = json(turn); this.db.charge(1, Buffer.byteLength(text))
      this.db.database.prepare('INSERT INTO net_bot_compartment_turns(compartment,turn) VALUES(?,?)').run(id, text)
    })
  }
  history(id: string, limit: number): CompartmentTurn[] {
    integer(limit, 1); if (limit > 100) throw new NetError('too_large')
    if (!this.binding(id)) throw new NetError('forbidden')
    const rows = this.db.database.prepare('SELECT turn FROM net_bot_compartment_turns WHERE compartment=? ORDER BY id DESC LIMIT ?').all(id, limit).reverse()
    if (rows.reduce((n, row) => n + Buffer.byteLength(row.turn as string), 0) > 1024 * 1024) throw new NetError('too_large')
    return rows.map(row => JSON.parse(row.turn as string))
  }
  drop(id: string): void {
    this.db.transaction(() => {
      if (!this.binding(id)) throw new NetError('forbidden')
      const live = this.db.database.prepare("SELECT 1 FROM net_executions WHERE state IN ('accepted','running','waitingApproval') AND json_extract(binding,'$.compartment')=? LIMIT 1").get(id)
      if (live) throw new NetError('conflict')
      // Large contexts use bounded transactions. Marking/deleting identity first would expose partial drop.
      const rows = this.db.database.prepare('SELECT id FROM net_bot_compartment_turns WHERE compartment=? LIMIT 499').all(id)
      const count = Number(this.db.database.prepare('SELECT count(*) AS n FROM net_bot_compartment_turns WHERE compartment=?').get(id)!.n)
      if (count > 499) throw new NetError('too_large', 'Context deletion requires bounded owner retention.')
      this.db.charge(rows.length + 1)
      this.db.database.prepare('DELETE FROM net_bot_compartments WHERE id=?').run(id)
    })
  }
  private validate(id: string, b: CompartmentBinding): void {
    if (b.profileId !== this.profileId || !isId('space', b.space) || !isId('bot', b.bot) || Object.keys(b).some(k => !['profileId','space','bot','privateStream','visibilityEpoch','participantHash'].includes(k))) throw new NetError('forbidden')
    if (b.privateStream === undefined) {
      if (id !== this.publicId(b.bot, b.space) || b.visibilityEpoch !== undefined || b.participantHash !== undefined) throw new NetError('forbidden')
    } else {
      if (id !== this.privateId(b.bot, b.privateStream, b.visibilityEpoch!) || typeof b.participantHash !== 'string') throw new NetError('forbidden')
      decodeBase64(b.participantHash, 32)
    }
  }
}
