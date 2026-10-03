import { createHash } from 'node:crypto'
import type { BotDelegation, EnvelopeAuthor, NodeDelegation, Roster, Signed, UserId } from '../../shared/net'
import { NetError } from '../../shared/net'
import { decodeBase64, verifyDocument } from '../net/identity/crypto'
import { canonicalJson, parseProtocolJson } from '../net/sync/codec'
import type { NetDatabase } from '../net/store/database'

/** Cryptographic evidence is retained separately from identity trust/adoption.
 * A preceding authenticated membership event supplies the root at lookup.
 */
export class RosterEvidence {
  constructor(private readonly db: NetDatabase) {
    db.database.exec('CREATE TABLE IF NOT EXISTS net_space_roster_evidence(hash TEXT PRIMARY KEY,user TEXT NOT NULL,root TEXT NOT NULL,issued INTEGER NOT NULL,bytes INTEGER NOT NULL,signed TEXT NOT NULL) STRICT')
  }
  retain(signed: Signed): void {
    const raw = parseProtocolJson(decodeBase64(signed.payload)) as Roster
    const roster = verifyDocument<Roster>(signed, raw.rootKey, 'roster')
    for (const delegation of roster.nodes) {
      const node = verifyDocument<NodeDelegation>(delegation, roster.rootKey, 'nodeDelegation')
      if (node.owner !== roster.owner) throw new NetError('bad_delegation')
    }
    const bytes = canonicalJson(signed), hash = createHash('sha256').update(bytes).digest('hex')
    this.db.transaction(() => {
      if (this.db.database.prepare('SELECT 1 FROM net_space_roster_evidence WHERE hash=?').get(hash)) return
      const used = this.db.database.prepare('SELECT count(*) AS rows,coalesce(sum(bytes),0) AS bytes FROM net_space_roster_evidence').get()!
      if (Number(used.rows) >= 512 || Number(used.bytes) + bytes.length > 16 * 1024 * 1024) throw new NetError('too_large', 'Retained Space roster evidence exceeds the local qualification bound.')
      this.db.charge(1, bytes.length)
      this.db.database.prepare('INSERT INTO net_space_roster_evidence VALUES(?,?,?,?,?,?)').run(hash,roster.owner,roster.rootKey,roster.issuedAt,bytes.length,Buffer.from(bytes).toString())
    })
  }
  forAuthor(author: EnvelopeAuthor, at: number, root: string): Signed | undefined {
    if (!author.user || author.bot) return undefined
    return this.find(author.user, root, roster => roster.nodes.some(row => {
      const node = verifyDocument<NodeDelegation>(row, root, 'nodeDelegation')
      return node.owner === author.user && node.subject === author.node && node.keyEpoch === author.keyEpoch && node.issuedAt <= at && at < node.expiresAt
    }))
  }
  /** The enclosing validated historical bot record supplies the owner/root. */
  forBot(author: EnvelopeAuthor, owner: UserId, at: number, root: string): Signed | undefined {
    if(!author.bot || author.user)return undefined
    return this.find(owner,root,roster=>roster.bots.some(row=>{
      const bot=verifyDocument<BotDelegation>(row,root,'botDelegation')
      return bot.owner===owner && bot.subject===author.bot && bot.hostNode===author.node && bot.keyEpoch===author.keyEpoch && bot.issuedAt<=at && at<bot.expiresAt
    }))
  }
  at(user: UserId, at: number, root: string): Signed | undefined {
    // Private controls must use roster state independently issued by that time.
    return this.find(user, root, roster => roster.issuedAt <= at)
  }
  private find(user: UserId, root: string, accepts: (roster: Roster) => boolean): Signed | undefined {
    const rows = this.db.database.prepare('SELECT signed FROM net_space_roster_evidence WHERE user=? AND root=? ORDER BY issued DESC,hash LIMIT 512').all(user,root)
    for (const row of rows) {
      const signed = JSON.parse(row.signed as string) as Signed, roster = verifyDocument<Roster>(signed,root,'roster')
      if (roster.owner !== user || roster.rootKey !== root) throw new NetError('storage_corrupt')
      if (accepts(roster)) return signed
    }
    return undefined
  }
}
