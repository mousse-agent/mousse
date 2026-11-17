import { isIP } from 'node:net'
import { isId, type NodeId } from '../../../shared/net'
import type { Clock } from '../contracts'
import type { NetDatabase } from './database'

/** The longest last address kept for a device; a LAN or direct WebSocket URL is far shorter. */
const MAX_ADDRESS = 512

/**
 * What this computer remembers on its own about the local network, in its Net database: the port of its automatic
 * LAN listener, kept across restarts, and per device of the user's list the last address a session with it opened
 * over that was not a relay. Neither is ever signed or published; both are only hints, and a dial still
 * authenticates the peer with its pinned TLS key and signed hello.
 */
export class SqliteLanMemory {
  constructor(
    readonly db: NetDatabase,
    private readonly clock: Clock
  ) {}
  /** The port the automatic LAN listener used last, if any. */
  port(): number | undefined {
    const row = this.db.database.prepare('SELECT port FROM net_lan_port WHERE singleton=1').get()
    const port = Number(row?.port)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
  }
  keepPort(port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === this.port()) return
    this.db.transaction(() => {
      this.db.charge(1, 16)
      this.db.database
        .prepare(
          'INSERT INTO net_lan_port(singleton,port) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET port=excluded.port'
        )
        .run(port)
    })
  }
  lastAddress(node: NodeId): string | undefined {
    const row = this.db.database
      .prepare('SELECT address FROM net_lan_last_address WHERE node=?')
      .get(node)
    return typeof row?.address === 'string' && usable(row.address) ? row.address : undefined
  }
  /** A session with `node` opened over `address`, a LAN or direct WebSocket URL (never a relay). */
  remember(node: NodeId, address: string): void {
    if (!isId('node', node) || !usable(address) || this.lastAddress(node) === address) return
    this.db.transaction(() => {
      this.db.charge(1, address.length)
      this.db.database
        .prepare(
          'INSERT INTO net_lan_last_address(node,address,at) VALUES(?,?,?) ON CONFLICT(node) DO UPDATE SET address=excluded.address,at=excluded.at'
        )
        .run(node, address, this.clock.now())
    })
  }
  /** Drops devices that left the list (revoked or replaced). */
  prune(keep: ReadonlySet<NodeId>): void {
    const stale = this.db.database
      .prepare('SELECT node FROM net_lan_last_address')
      .all()
      .map((row) => String(row.node))
      .filter((node) => !keep.has(node as NodeId))
    if (!stale.length) return
    this.db.transaction(() => {
      this.db.charge(stale.length)
      for (const node of stale)
        this.db.database.prepare('DELETE FROM net_lan_last_address WHERE node=?').run(node)
    })
  }
}

/** The address a session accepted on the LAN listener can be dialled back at: the peer's source IPv4, its told port. */
export function lanAddress(remote: string | undefined, port: number): string | undefined {
  const ip = remote?.replace(/^::ffff:/, '')
  if (!ip || isIP(ip) !== 4 || !Number.isInteger(port) || port <= 0 || port > 65535) return
  return `ws://${ip}:${port}/mousse-net`
}

function usable(address: string): boolean {
  if (address.length > MAX_ADDRESS) return false
  try {
    const url = new URL(address)
    return (
      ['ws:', 'wss:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/mousse-net'
    )
  } catch {
    return false
  }
}
