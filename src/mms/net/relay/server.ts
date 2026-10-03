import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket, { WebSocketServer } from 'ws'
import type { Clock } from '../contracts'
import type { NodeDelegation, NodeId, Roster, UserId } from '../../../shared/net'
import { isId } from '../../../shared/net/ids'
import { NetError } from '../../../shared/net/errors'
import { decodeBase64, verifyBytes, verifyDocument } from '../identity/crypto'
import { parseProtocolJson } from '../sync/codec'
import { systemClock } from '../clock'
import { relayProofBytes, ticketHash, type RelayAuth } from './protocol'

export interface RelayServerOptions {
  databasePath: string; host?: string; port?: number; publicAddress?: string; clock?: Clock;
  allowNodes?: Array<{ node: NodeId; signKey: string }>;
  allowUsers?: Array<{ user: UserId; rootKey: string }>;
  bytesPerHour?: number; connectionsPerHour?: number; maxConnections?: number; maxConnectionsPerPrincipal?: number; maximumQueuedBytes?: number;
}
type Endpoint = { ws: WebSocket; address: string; nonce: string; timer: { cancel(): void }; principal?: string; node?: NodeId; target?: NodeId; role?: RelayAuth['role']; peer?: Endpoint; waiting?: boolean; count: number }

/** Outer rendezvous and opaque forwarding only. It never authenticates MMS domain traffic. */
export class RelayServer {
  private readonly db: DatabaseSync
  private readonly clock: Clock
  private server?: Server
  private wss?: WebSocketServer
  private readonly endpoints = new Set<Endpoint>()
  private readonly waitingListeners = new Map<NodeId, Endpoint>()
  private readonly waitingDialers = new Set<Endpoint>()
  private endpoint?: string
  private closed = false
  constructor(private readonly options: RelayServerOptions) {
    this.clock = options.clock ?? systemClock
    for (const node of options.allowNodes ?? []) { if (!isId('node', node.node)) throw new NetError('bad_request'); decodeBase64(node.signKey, 32) }
    for (const user of options.allowUsers ?? []) { if (!isId('user', user.user)) throw new NetError('bad_request'); decodeBase64(user.rootKey, 32) }
    for (const value of [options.bytesPerHour, options.connectionsPerHour, options.maxConnections, options.maxConnectionsPerPrincipal, options.maximumQueuedBytes]) if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new NetError('bad_request')
    mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(options.databasePath); chmodSync(options.databasePath, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS relay_usage(principal TEXT NOT NULL, bucket INTEGER NOT NULL, bytes INTEGER NOT NULL, connections INTEGER NOT NULL, last_now INTEGER NOT NULL, PRIMARY KEY(principal,bucket));
      CREATE TABLE IF NOT EXISTS relay_rendezvous(hash TEXT PRIMARY KEY, issuer TEXT NOT NULL, target TEXT NOT NULL, expires INTEGER NOT NULL, node TEXT, sign_key TEXT, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS relay_clock(id INTEGER PRIMARY KEY CHECK(id=1), last_now INTEGER NOT NULL);
      INSERT OR IGNORE INTO relay_clock VALUES(1,0);`)
    if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') { this.db.close(); throw new NetError('storage_corrupt') }
  }
  address(): string { if (!this.endpoint) throw new NetError('route_unreachable'); return this.endpoint }
  activeConnections(): number { return this.endpoints.size }
  private transaction<T>(work: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = work(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error } }
  private charge(principal: string, bytes: number, connections: number): void {
    this.transaction(() => {
      const now = this.clock.now(), previous = Number(this.db.prepare('SELECT last_now FROM relay_clock WHERE id=1').get()!.last_now)
      if (!Number.isSafeInteger(now) || now < previous) throw new NetError('clock_skew')
      const bucket = Math.floor(now / 3_600_000)
      const old = this.db.prepare('SELECT bytes,connections FROM relay_usage WHERE principal=? AND bucket=?').get(principal, bucket)
      const totalBytes = Number(old?.bytes ?? 0) + bytes, totalConnections = Number(old?.connections ?? 0) + connections
      if (totalBytes > (this.options.bytesPerHour ?? 1024 * 1024 * 1024) || totalConnections > (this.options.connectionsPerHour ?? 120)) throw new NetError('quota_exceeded')
      this.db.prepare('INSERT INTO relay_usage VALUES(?,?,?,?,?) ON CONFLICT(principal,bucket) DO UPDATE SET bytes=excluded.bytes,connections=excluded.connections,last_now=excluded.last_now').run(principal, bucket, totalBytes, totalConnections, now)
      this.db.prepare('UPDATE relay_clock SET last_now=? WHERE id=1').run(now)
      // Bound cleanup per admission; no historical all-principal scan/write transaction.
      this.db.prepare('DELETE FROM relay_usage WHERE rowid IN (SELECT rowid FROM relay_usage WHERE bucket<? LIMIT 64)').run(bucket - 1)
      this.db.prepare('DELETE FROM relay_rendezvous WHERE rowid IN (SELECT rowid FROM relay_rendezvous WHERE expires<=? LIMIT 64)').run(now)
    })
  }
  private trusted(auth: RelayAuth): { principal: string; expiresAt: number } {
    const node = this.options.allowNodes?.find(entry => entry.node === auth.node && entry.signKey === auth.signKey)
    if (node) return { principal: `node:${auth.node}`, expiresAt: this.clock.now() + 7 * 86_400_000 }
    if (!auth.delegation || !auth.roster) throw new NetError('forbidden')
    const decoded = parseProtocolJson(decodeBase64(auth.delegation.payload)) as NodeDelegation
    const user = this.options.allowUsers?.find(entry => entry.user === decoded.owner)
    if (!user) throw new NetError('forbidden')
    const delegation = verifyDocument<NodeDelegation>(auth.delegation, user.rootKey, 'nodeDelegation')
    const roster = verifyDocument<Roster>(auth.roster, user.rootKey, 'roster')
    const now = this.clock.now()
    if (delegation.subject !== auth.node || delegation.keys.sign !== auth.signKey || delegation.issuedAt > now || delegation.expiresAt <= now || delegation.expiresAt - delegation.issuedAt > 7 * 86_400_000 || roster.owner !== user.user || roster.rootKey !== user.rootKey || roster.revoked.some(entry => entry.subject === auth.node && entry.throughKeyEpoch >= delegation.keyEpoch)) throw new NetError('forbidden')
    const sameKey = roster.nodes.some(signed => {
      const claim = verifyDocument<NodeDelegation>(signed, user.rootKey, 'nodeDelegation')
      return claim.subject === auth.node && claim.keyEpoch === delegation.keyEpoch && claim.keys.sign === auth.signKey
    })
    if (!sameKey) throw new NetError('forbidden')
    return { principal: `user:${user.user}`, expiresAt: delegation.expiresAt }
  }
  private authenticate(endpoint: Endpoint, bytes: Uint8Array): void {
    if (bytes.length > 16 * 1024 || ++endpoint.count > 1) throw new NetError('too_large')
    const auth = parseProtocolJson(bytes) as RelayAuth
    const allowed = ['t','v','nonce','node','signKey','role','target','sig','delegation','roster','ticket','ticketHash','expiresAt']
    if (!auth || auth.t !== 'auth' || auth.v !== 1 || auth.nonce !== endpoint.nonce || !isId('node', auth.node) || !isId('node', auth.target) || !['listen','dial','register'].includes(auth.role) || Object.keys(auth).some(key => !allowed.includes(key))) throw new NetError('bad_request')
    decodeBase64(auth.signKey, 32); verifyBytes(relayProofBytes(auth), decodeBase64(auth.sig, 64), auth.signKey)
    let principal: string
    if (auth.ticket !== undefined) {
      if (auth.role !== 'dial' || auth.ticketHash !== undefined || auth.expiresAt !== undefined) throw new NetError('forbidden')
      const hash = ticketHash(auth.ticket)
      principal = this.transaction(() => {
        const record = this.db.prepare('SELECT * FROM relay_rendezvous WHERE hash=?').get(hash)
        if (!record || Number(record.expires) <= this.clock.now() || record.target !== auth.target || Number(record.attempts) >= 64 || (record.node !== null && (record.node !== auth.node || record.sign_key !== auth.signKey))) throw new NetError('invite_invalid')
        this.db.prepare('UPDATE relay_rendezvous SET node=?,sign_key=?,attempts=attempts+1 WHERE hash=?').run(auth.node, auth.signKey, hash)
        return `rendezvous:${hash}`
      })
    } else {
      const trust = this.trusted(auth); principal = trust.principal
      if (auth.role === 'register') {
        if (auth.target !== auth.node || typeof auth.ticketHash !== 'string' || !Number.isSafeInteger(auth.expiresAt) || auth.expiresAt! <= this.clock.now() || auth.expiresAt! > trust.expiresAt) throw new NetError('bad_request')
        decodeBase64(auth.ticketHash, 32)
        const active = Number(this.db.prepare('SELECT count(*) AS n FROM relay_rendezvous WHERE issuer=? AND expires>?').get(principal, this.clock.now())!.n)
        if (active >= 32) throw new NetError('quota_exceeded')
        this.charge(principal, bytes.length, 1)
        this.db.prepare('INSERT INTO relay_rendezvous(hash,issuer,target,expires) VALUES(?,?,?,?)').run(auth.ticketHash, principal, auth.node, auth.expiresAt!)
        endpoint.timer.cancel(); endpoint.ws.send(JSON.stringify({ t: 'registered' })); endpoint.ws.close(); return
      }
      if (auth.ticketHash !== undefined || auth.expiresAt !== undefined) throw new NetError('bad_request')
    }
    if (auth.role === 'listen' && auth.target !== auth.node) throw new NetError('forbidden')
    if ([...this.endpoints].filter(entry => entry.principal === principal).length >= (this.options.maxConnectionsPerPrincipal ?? 8)) throw new NetError('quota_exceeded')
    this.charge(principal, bytes.length, 1)
    endpoint.principal = principal; endpoint.node = auth.node; endpoint.target = auth.target; endpoint.role = auth.role; endpoint.waiting = true
    endpoint.timer.cancel()
    endpoint.timer = this.clock.setTimeout(() => endpoint.ws.terminate(), 60_000)
    endpoint.ws.send(JSON.stringify({ t: 'ready' }))
    if (auth.role === 'listen') {
      const existing = this.waitingListeners.get(auth.node)
      if (existing) throw new NetError('conflict')
      this.waitingListeners.set(auth.node, endpoint)
      const dialer = [...this.waitingDialers].find(entry => entry.target === auth.node)
      if (dialer) this.pair(endpoint, dialer)
    } else {
      this.waitingDialers.add(endpoint)
      const listener = this.waitingListeners.get(auth.target)
      if (listener) this.pair(listener, endpoint)
    }
  }
  private pair(listener: Endpoint, dialer: Endpoint): void {
    this.waitingListeners.delete(listener.node!); this.waitingDialers.delete(dialer)
    for (const [left, right] of [[listener, dialer], [dialer, listener]]) {
      left.timer.cancel(); left.waiting = false; left.peer = right
      left.ws.send(JSON.stringify({ t: 'paired', peer: right.node }))
    }
  }
  async listen(): Promise<void> {
    if (this.server) return
    if (this.closed) throw new NetError('cancelled')
    const server = this.server = createServer({ maxHeaderSize: 8192 }, (_request, response) => { response.writeHead(404, { Connection: 'close' }); response.end() })
    const wss = this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false })
    server.headersTimeout = 10_000; server.requestTimeout = 10_000
    const rawConnections = new Map<import('node:net').Socket, { timer: { cancel(): void }; address: string }>()
    server.on('connection', socket => {
      const address = socket.remoteAddress ?? 'unknown'
      if (rawConnections.size >= (this.options.maxConnections ?? 32) || [...rawConnections.values()].filter(entry => entry.address === address).length >= 4) { socket.destroy(); return }
      const lease = { address, timer: this.clock.setTimeout(() => socket.destroy(), 10_000) }; rawConnections.set(socket, lease)
      let bytes = 0; socket.on('data', chunk => { if (!rawConnections.has(socket)) return; bytes += chunk.length; if (bytes > 20 * 1024) socket.destroy() })
      socket.once('close', () => { lease.timer.cancel(); rawConnections.delete(socket) }); socket.on('error', () => {})
    })
    server.on('upgrade', (request, socket, head) => {
      const lease = rawConnections.get(request.socket)
      if (!lease || request.url !== '/mousse-relay' || this.endpoints.size >= (this.options.maxConnections ?? 32)) { socket.destroy(); return }
      wss.handleUpgrade(request, socket, head, ws => {
        lease.timer.cancel()
        const endpoint: Endpoint = { ws, address: lease.address, nonce: randomBytes(32).toString('base64url'), timer: this.clock.setTimeout(() => ws.terminate(), 10_000), count: 0 }
        this.endpoints.add(endpoint)
        ws.send(JSON.stringify({ t: 'challenge', nonce: endpoint.nonce }))
        ws.on('message', (input, binary) => {
          try {
            const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input as ArrayBuffer)
            if (!endpoint.principal) {
              if (binary) throw new NetError('bad_request')
              this.authenticate(endpoint, bytes)
              if (endpoint.principal) rawConnections.delete(request.socket)
            } else {
              if (!binary || !endpoint.peer || endpoint.waiting) throw new NetError('bad_request')
              this.charge(endpoint.principal, bytes.length, 0)
              const peer = endpoint.peer.ws
              if (peer.bufferedAmount + bytes.length > (this.options.maximumQueuedBytes ?? 256 * 1024)) throw new NetError('quota_exceeded')
              peer.send(bytes, { binary: true }, error => { if (error) endpoint.ws.terminate() })
            }
          } catch (error) {
            ws.send(JSON.stringify({ t: 'error', code: error instanceof NetError ? error.code : 'internal' }))
            ws.close(1008)
            endpoint.timer.cancel(); endpoint.timer = this.clock.setTimeout(() => ws.terminate(), 1000)
          }
        })
        ws.on('error', () => ws.terminate())
        ws.once('close', () => {
          endpoint.timer.cancel(); this.endpoints.delete(endpoint); rawConnections.delete(request.socket)
          if (endpoint.node && this.waitingListeners.get(endpoint.node) === endpoint) this.waitingListeners.delete(endpoint.node)
          this.waitingDialers.delete(endpoint); endpoint.peer?.ws.terminate()
        })
      })
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new NetError('internal')
    this.endpoint = this.options.publicAddress ?? `ws://127.0.0.1:${address.port}/mousse-relay`
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true
    for (const endpoint of this.endpoints) { endpoint.timer.cancel(); endpoint.ws.terminate() }
    this.wss?.close()
    if (this.server?.listening) { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server!.close(() => resolve())) }
    this.db.close(); this.endpoint = undefined
  }
}
