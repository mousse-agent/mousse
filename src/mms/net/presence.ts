import type { NodeId } from '../../shared/net'
import { compareVersions, isDevBuild } from '../../shared/net/version'
import { channelForVersion, parseSelfUpdateReport, type SelfUpdateReport } from '../../shared/updates'
import type { NetDatabase } from './store/database'
import type { Clock } from './contracts'

/** What a device tells another one about itself over the read-only `net.info` rpc. */
export interface PeerInfo {
  v: 1
  version: string
  platform: string
  arch: string
  protoMinor: number
  /** Whether it updates itself; absent from a computer from before the report. */
  update?: SelfUpdateReport
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
  /** Its channel and whether it updates itself; absent until a computer that reports it answered. */
  update?: SelfUpdateReport
  /** The device refused `net.info` as an unknown method: a build from before it existed. */
  legacy: boolean
  link?: PeerLink
  lastSeenAt?: number
}

/** The old networking's devices; created with the other Net tables when the runtime opens. */
export const PEER_PRESENCE_TABLE = 'net_peer_presence'
/** The engine's pairings, by their own ids: kept apart so neither list's pruning drops the other's rows. */
export const ENGINE_PRESENCE_TABLE = 'net_engine_presence'
type PresenceTable = typeof PEER_PRESENCE_TABLE | typeof ENGINE_PRESENCE_TABLE

/**
 * Creates a presence table, or adds the columns a table from an older build lacks. An older build names its columns,
 * so it still reads and writes the table, and a profile can go back to it.
 */
export function ensurePresenceTable(db: NetDatabase, table: PresenceTable = PEER_PRESENCE_TABLE): void {
  db.transaction(() => {
    db.database.exec(
      `CREATE TABLE IF NOT EXISTS ${table}(node TEXT PRIMARY KEY,version TEXT,platform TEXT,arch TEXT,legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),route TEXT,direction TEXT CHECK(direction IN ('in','out')),last_seen_at INTEGER,updater TEXT) STRICT`
    )
    const columns = db.database.prepare(`PRAGMA table_info(${table})`).all()
    // Whether the device updates itself (`SelfUpdateReport` as JSON).
    if (!columns.some((row) => row.name === 'updater')) db.database.exec(`ALTER TABLE ${table} ADD COLUMN updater TEXT`)
  })
}

/**
 * Where a computer's version stands against this one's: `behind`, `newer`, `channel` when the two follow different
 * update channels (nightly and stable, where neither is simply ahead), or undefined when they match or either is
 * unknown or a development build. A computer that reported no version is never called behind; one too old to answer
 * at all (`legacy`) is.
 */
export function versionStanding(
  row: Pick<PeerPresenceRow, 'version' | 'legacy' | 'update'> | undefined,
  current: string
): 'behind' | 'newer' | 'channel' | undefined {
  if (!row || isDevBuild(current)) return undefined
  if (row.legacy) return 'behind'
  if (!row.version || isDevBuild(row.version)) return undefined
  if ((row.update?.channel ?? channelForVersion(row.version)) !== channelForVersion(current)) return 'channel'
  const order = compareVersions(row.version, current)
  return order === -1 ? 'behind' : order === 1 ? 'newer' : undefined
}

const SAFE_TEXT =/^[0-9A-Za-z._+-]{1,64}$/

/** Reads a `net.info` result from another device; anything off is ignored, never trusted. */
export function parsePeerInfo(value: unknown): PeerInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (typeof row.version !== 'string' || !SAFE_TEXT.test(row.version)) return undefined
  const update = parseSelfUpdateReport(row.update)
  return {
    v: 1,
    version: row.version,
    platform: typeof row.platform === 'string' && SAFE_TEXT.test(row.platform) ? row.platform : '',
    arch: typeof row.arch === 'string' && SAFE_TEXT.test(row.arch) ? row.arch : '',
    protoMinor: Number.isSafeInteger(row.protoMinor) ? (row.protoMinor as number) : 0,
    ...(update ? { update } : {})
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
    private readonly clock: Pick<Clock, 'now'>,
    private readonly table: PresenceTable = PEER_PRESENCE_TABLE
  ) {}
  /** A session with `node` is open: remember how, and when. */
  opened(node: NodeId, link: PeerLink): void {
    this.db.transaction(() => {
      this.db.charge(1, 128)
      this.db.database
        .prepare(
          `INSERT INTO ${this.table}(node,route,direction,last_seen_at) VALUES(?,?,?,?) ON CONFLICT(node) DO UPDATE SET route=excluded.route,direction=excluded.direction,last_seen_at=excluded.last_seen_at`
        )
        .run(node, link.transport ?? null, link.direction, this.clock.now())
    })
  }
  /** The device is (or was just) connected. */
  seen(node: NodeId): void {
    this.db.database
      .prepare(`UPDATE ${this.table} SET last_seen_at=? WHERE node=?`)
      .run(this.clock.now(), node)
  }
  /** The device answered `net.info`. */
  info(node: NodeId, info: PeerInfo): void {
    this.db.transaction(() => {
      this.db.charge(1, 128)
      this.db.database
        .prepare(
          `INSERT INTO ${this.table}(node,version,platform,arch,legacy,updater) VALUES(?,?,?,?,0,?) ON CONFLICT(node) DO UPDATE SET version=excluded.version,platform=excluded.platform,arch=excluded.arch,legacy=0,updater=excluded.updater`
        )
        .run(node, info.version, info.platform || null, info.arch || null, info.update ? JSON.stringify(info.update) : null)
    })
  }
  /** The device could not be asked: what it said before may be out of date, so nothing is claimed of it. */
  unknown(node: NodeId): void {
    this.db.database
      .prepare(`UPDATE ${this.table} SET version=NULL,platform=NULL,arch=NULL,legacy=0,updater=NULL WHERE node=?`)
      .run(node)
  }
  /** Forgets a "too old to answer" verdict that was never earned (the device could not be asked). */
  clearLegacy(node: NodeId): void {
    this.db.database
      .prepare(`UPDATE ${this.table} SET legacy=0 WHERE node=? AND legacy=1`)
      .run(node)
  }
  /** Drops devices that left the roster (revoked or replaced), keeping every current one. */
  prune(keep: ReadonlySet<NodeId>): void {
    const rows = this.db.database.prepare(`SELECT node FROM ${this.table}`).all()
    const stale = rows.map((row) => String(row.node)).filter((node) => !keep.has(node as NodeId))
    if (!stale.length) return
    this.db.transaction(() => {
      this.db.charge(stale.length)
      for (const node of stale)
        this.db.database.prepare(`DELETE FROM ${this.table} WHERE node=?`).run(node)
    })
  }
  /** The device does not know `net.info`: it predates the version report. */
  legacy(node: NodeId): void {
    this.db.transaction(() => {
      this.db.charge(1, 128)
      this.db.database
        .prepare(
          `INSERT INTO ${this.table}(node,legacy) VALUES(?,1) ON CONFLICT(node) DO UPDATE SET version=NULL,platform=NULL,arch=NULL,legacy=1,updater=NULL`
        )
        .run(node)
    })
  }
  get(node: NodeId): PeerPresenceRow | undefined {
    const row = this.db.database.prepare(`SELECT * FROM ${this.table} WHERE node=?`).get(node)
    if (!row) return undefined
    let update: SelfUpdateReport | undefined
    try {
      update = typeof row.updater === 'string' ? parseSelfUpdateReport(JSON.parse(row.updater)) : undefined
    } catch {
      update = undefined
    }
    return {
      node,
      ...(typeof row.version === 'string' ? { version: row.version } : {}),
      ...(typeof row.platform === 'string' ? { platform: row.platform } : {}),
      ...(typeof row.arch === 'string' ? { arch: row.arch } : {}),
      ...(update ? { update } : {}),
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
