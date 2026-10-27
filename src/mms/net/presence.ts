import type { NodeId } from '../../shared/net'
import type { NetDatabase } from './store/database'
import type { Clock } from './contracts'

/** What a device tells another one about itself over the read-only `net.info` rpc. */
export interface PeerInfo {
  v: 1
  version: string
  platform: string
  arch: string
  protoMinor: number
}

/** How the current or last session with a device was carried. */
export interface PeerLink {
  direction: 'in' | 'out'
  transport?: string
  address?: string
}

export interface PeerPresenceRow {
  node: NodeId
  /** Absent until the device answered `net.info`, or when it never can (see `legacy`). */
  version?: string
  platform?: string
  arch?: string
  /** The device refused `net.info` as an unknown method: a build from before it existed. */
  legacy: boolean
  link?: PeerLink
  lastSeenAt?: number
}

/** Created with the other Net tables when the runtime opens; an older daemon ignores it. */
export const PEER_PRESENCE_SCHEMA =
  "CREATE TABLE IF NOT EXISTS net_peer_presence(node TEXT PRIMARY KEY,version TEXT,platform TEXT,arch TEXT,legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),route TEXT,direction TEXT CHECK(direction IN ('in','out')),last_seen_at INTEGER) STRICT"

const SAFE_TEXT =/^[0-9A-Za-z._+-]{1,64}$/

/** Reads a `net.info` result from another device; anything off is ignored, never trusted. */
export function parsePeerInfo(value: unknown): PeerInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (typeof row.version !== 'string' || !SAFE_TEXT.test(row.version)) return undefined
  return {
    v: 1,
    version: row.version,
    platform: typeof row.platform === 'string' && SAFE_TEXT.test(row.platform) ? row.platform : '',
    arch: typeof row.arch === 'string' && SAFE_TEXT.test(row.arch) ? row.arch : '',
    protoMinor: Number.isSafeInteger(row.protoMinor) ? (row.protoMinor as number) : 0
  }
}

/**
 * The last version, route and time this computer saw each of the user's devices, kept in the
 * profile database so the Devices screen can say something about a device that is offline now.
 * Best effort: a failed write never affects a session.
 */
export class PeerPresence {
  constructor(
    readonly db: NetDatabase,
    private readonly clock: Clock
  ) {}
  /** A session with `node` is open: remember how, and when. */
  opened(node: NodeId, link: PeerLink): void {
    this.db.transaction(() => {
      this.db.charge(1, 128)
      this.db.database
        .prepare(
          'INSERT INTO net_peer_presence(node,route,direction,last_seen_at) VALUES(?,?,?,?) ON CONFLICT(node) DO UPDATE SET route=excluded.route,direction=excluded.direction,last_seen_at=excluded.last_seen_at'
        )
        .run(node, link.transport ?? null, link.direction, this.clock.now())
    })
  }
  /** The device is (or was just) connected. */
  seen(node: NodeId): void {
    this.db.database
      .prepare('UPDATE net_peer_presence SET last_seen_at=? WHERE node=?')
      .run(this.clock.now(), node)
  }
  /** The device answered `net.info`. */
  info(node: NodeId, info: PeerInfo): void {
    this.db.transaction(() => {
      this.db.charge(1, 128)
      this.db.database
        .prepare(
          'INSERT INTO net_peer_presence(node,version,platform,arch,legacy) VALUES(?,?,?,?,0) ON CONFLICT(node) DO UPDATE SET version=excluded.version,platform=excluded.platform,arch=excluded.arch,legacy=0'
        )
        .run(node, info.version, info.platform || null, info.arch || null)
    })
  }
  /** Forgets a "too old to answer" verdict that was never earned (the device could not be asked). */
  clearLegacy(node: NodeId): void {
    this.db.database
      .prepare('UPDATE net_peer_presence SET legacy=0 WHERE node=? AND legacy=1')
      .run(node)
  }
  /** Drops devices that left the roster (revoked or replaced), keeping every current one. */
  prune(keep: ReadonlySet<NodeId>): void {
    const rows = this.db.database.prepare('SELECT node FROM net_peer_presence').all()
    const stale = rows.map((row) => String(row.node)).filter((node) => !keep.has(node as NodeId))
    if (!stale.length) return
    this.db.transaction(() => {
      this.db.charge(stale.length)
      for (const node of stale)
        this.db.database.prepare('DELETE FROM net_peer_presence WHERE node=?').run(node)
    })
  }
  /** The device does not know `net.info`: it predates the version report. */
  legacy(node: NodeId): void {
    this.db.transaction(() => {
      this.db.charge(1, 128)
      this.db.database
        .prepare(
          'INSERT INTO net_peer_presence(node,legacy) VALUES(?,1) ON CONFLICT(node) DO UPDATE SET version=NULL,platform=NULL,arch=NULL,legacy=1'
        )
        .run(node)
    })
  }
  get(node: NodeId): PeerPresenceRow | undefined {
    const row = this.db.database.prepare('SELECT * FROM net_peer_presence WHERE node=?').get(node)
    if (!row) return undefined
    return {
      node,
      ...(typeof row.version === 'string' ? { version: row.version } : {}),
      ...(typeof row.platform === 'string' ? { platform: row.platform } : {}),
      ...(typeof row.arch === 'string' ? { arch: row.arch } : {}),
      legacy: row.legacy === 1 || row.legacy === 1n,
      ...(row.direction === 'in' || row.direction === 'out'
        ? {
            link: {
              direction: row.direction,
              ...(typeof row.route === 'string' ? { transport: row.route } : {})
            } as PeerLink
          }
        : {}),
      ...(typeof row.last_seen_at === 'number' ? { lastSeenAt: row.last_seen_at } : {})
    }
  }
}
