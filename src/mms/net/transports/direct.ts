import { createServer, type Server } from 'node:http'
import { isIP, type Socket, type LookupFunction } from 'node:net'
import { lookup } from 'node:dns/promises'
import { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, createWebSocketStream } from 'ws'
import type { Clock, InboundInfo, Listener, Transport, TransportStatus } from '../contracts'
import type { Route } from '../../../shared/net/identity'
import { NetError } from '../../../shared/net/errors'
import { MAX_FRAME_BYTES, PREAUTH_DEADLINE_MS, PREAUTH_MAX_CONNECTIONS, PREAUTH_MAX_PER_ADDRESS } from '../../../shared/net/limits'
import { systemClock } from '../clock'

export interface DirectTransportOptions {
  /** Listening is off unless explicitly enabled. Dialing remains available. */
  enabled?: boolean
  host?: string
  port?: number
  advertiseHost?: string
  clock?: Clock
}
type Lease = { socket: Socket; address: string; bytes: number; authenticated: boolean; timer: { cancel(): void }; raw?: Duplex }

/** Ciphertext writes may exceed a mux frame once TLS adds/coalesces records.
 * Packetize them independently without increasing the untrusted WS frame bound. */
function boundedWebSocketStream(ws: WebSocket): Duplex {
  const bytes = createWebSocketStream(ws, { highWaterMark: MAX_FRAME_BYTES })
  const raw = new Duplex({
    highWaterMark: MAX_FRAME_BYTES,
    read() { bytes.resume() },
    write(input: Buffer, _encoding, done) {
      let offset = 0
      const next = (error?: Error | null): void => {
        if (error) { done(error); return }
        if (offset >= input.length) { done(); return }
        const count = Math.min(MAX_FRAME_BYTES, input.length - offset), part = input.subarray(offset, offset + count)
        offset += count
        bytes.write(part, next)
      }
      next()
    },
    final(done) { bytes.end(done) },
    destroy(error, done) { bytes.destroy(error ?? undefined); done(error) }
  })
  bytes.on('data', (chunk: Buffer) => { if (!raw.push(chunk)) bytes.pause() })
  bytes.on('end', () => raw.push(null))
  bytes.on('close', () => raw.destroy())
  bytes.on('error', error => raw.destroy(error))
  raw.on('error', () => {})
  return raw
}

/** Untrusted binary WebSocket byte streams; inner pinned TLS is mandatory at the caller. */
export class DirectTransport implements Transport {
  readonly id = 'direct'
  readonly traits = { canListen: true, canDial: true, readsPlaintext: false, needsAccount: false }
  private readonly clock: Clock
  private state: TransportStatus['state'] = 'disabled'
  private lastError?: TransportStatus['lastError']
  private server?: Server
  private wsServer?: WebSocketServer
  private endpoint?: string
  private listening?: Promise<Listener>
  private accepting?: (stream: Duplex, info: InboundInfo) => void
  private readonly leases = new Map<Socket, Lease>()
  private readonly streams = new Set<Duplex>()
  private readonly statusListeners = new Set<(status: TransportStatus) => void>()
  private readonly resolved = new Map<string, Array<{ address: string; family: number }>>()
  private readonly byStream = new Map<Duplex, Lease>()
  constructor(private readonly options: DirectTransportOptions = {}) {
    this.clock = options.clock ?? systemClock
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new NetError('bad_request', 'Invalid direct listener port.')
  }
  async provision(): Promise<void> { if (this.state === 'ready') return; this.state = 'ready'; this.lastError = undefined; this.changed() }
  status(): TransportStatus { return { state: this.state, routes: this.endpoint ? [{ transport: this.id, address: this.endpoint, priority: 0 }] : [], ...(this.lastError ? { lastError: this.lastError } : {}) } }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener) } }
  private changed(): void { for (const listener of this.statusListeners) listener(this.status()) }
  private failure(cause: unknown): NetError {
    const error = cause instanceof NetError ? cause : new NetError('route_unreachable', 'Direct transport failed.', { cause })
    this.lastError = { code: error.code, message: error.message, cause: error.cause }; this.changed(); return error
  }
  async listen(onConnection: (stream: Duplex, info: InboundInfo) => void): Promise<Listener> {
    if (this.state !== 'ready') throw new NetError('route_unreachable', 'Direct transport is not provisioned.')
    if (!this.options.enabled) throw new NetError('forbidden', 'Direct listening is disabled.')
    if (this.listening) {
      if (this.accepting !== onConnection) throw new NetError('conflict', 'Direct listener already has an owner.')
      return this.listening
    }
    this.accepting = onConnection
    this.listening = this.openListener(onConnection)
    try { return await this.listening } catch (error) { this.listening = undefined; this.accepting = undefined; throw error }
  }
  private async openListener(onConnection: (stream: Duplex, info: InboundInfo) => void): Promise<Listener> {
    const server = createServer({ maxHeaderSize: 8192 }, (_req, response) => { response.writeHead(404, { Connection: 'close' }); response.end() })
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false })
    this.server = server; this.wsServer = wss
    server.headersTimeout = PREAUTH_DEADLINE_MS; server.requestTimeout = PREAUTH_DEADLINE_MS
    server.on('connection', socket => {
      const address = socket.remoteAddress ?? 'unknown'
      const unauthenticated = [...this.leases.values()].filter(lease => !lease.authenticated)
      if (unauthenticated.length >= PREAUTH_MAX_CONNECTIONS || unauthenticated.filter(lease => lease.address === address).length >= PREAUTH_MAX_PER_ADDRESS) { socket.destroy(); return }
      const lease: Lease = { socket, address, bytes: 0, authenticated: false, timer: this.clock.setTimeout(() => socket.destroy(), PREAUTH_DEADLINE_MS) }
      this.leases.set(socket, lease)
      socket.on('data', bytes => {
        if (lease.authenticated) return
        lease.bytes += bytes.length
        // Raw bytes include HTTP/WebSocket framing and TLS records; SyncSession
        // separately applies the stricter 16KiB application quarantine budget.
        if (lease.bytes > 64 * 1024) socket.destroy()
      })
      socket.once('close', () => { lease.timer.cancel(); this.leases.delete(socket); if (lease.raw) this.byStream.delete(lease.raw) })
      socket.on('error', () => {})
    })
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/mousse-net' || !this.leases.has(socket as Socket)) { socket.destroy(); return }
      wss.handleUpgrade(request, socket, head, ws => {
        const lease = this.leases.get(request.socket)
        if (!lease) { ws.terminate(); return }
        ws.on('message', (_data, binary) => { if (!binary) ws.terminate() })
        ws.on('error', error => { this.failure(error) })
        const raw = boundedWebSocketStream(ws)
        lease.raw = raw; this.byStream.set(raw, lease); this.track(raw); ws.once('close', () => this.streams.delete(raw))
        try { onConnection(raw, { transport: this.id, remoteAddress: lease.address }) } catch (error) { raw.destroy(); this.failure(error) }
      })
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    server.on('error', error => { this.failure(error) })
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.removeListener('listening', opened); reject(this.failure(error)) }
      const opened = () => { server.removeListener('error', failed); resolve() }
      server.once('error', failed); server.once('listening', opened)
      server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1')
    }).catch(async error => { await this.closeListener(); throw error })
    const address = server.address()
    if (!address || typeof address === 'string') throw new NetError('internal', 'Direct listener did not bind a TCP address.')
    let host = this.options.advertiseHost ?? this.options.host ?? '127.0.0.1'
    if (host === '0.0.0.0' || host === '::') host = '127.0.0.1'
    this.endpoint = `ws://${host.includes(':') ? `[${host}]` : host}:${address.port}/mousse-net`; this.changed()
    return { close: () => this.closeListener() }
  }
  /** Called only after TLS certificate/delegation/hello or enrollment gates succeed. */
  markAuthenticated(raw: Duplex): void { const lease = this.byStream.get(raw); if (!lease || lease.authenticated) return; lease.authenticated = true; lease.timer.cancel() }
  private track(raw: Duplex): void { this.streams.add(raw); raw.on('error', () => {}); raw.once('close', () => { this.streams.delete(raw) }) }
  /** RouteManager uses this optional helper to budget DNS separately from TCP/WS connect. */
  async resolve(route: Route, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new NetError('cancelled')
    const address = new URL(route.address), hostname = address.hostname.replace(/^\[|\]$/g, '')
    if (!['ws:', 'wss:'].includes(address.protocol)) throw new NetError('bad_request', 'Invalid direct route URL.')
    const answer = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : (await lookup(hostname, { all: true })).slice(0, 32)
    if (signal.aborted) throw new NetError('cancelled')
    if (this.resolved.size >= 32) this.resolved.delete(this.resolved.keys().next().value!)
    this.resolved.set(route.address, answer)
  }
  async dial(route: Route, signal: AbortSignal): Promise<Duplex> {
    if (signal.aborted) throw new NetError('cancelled', undefined, { cause: signal.reason })
    if (this.state !== 'ready' || route.transport !== this.id) throw new NetError('route_unreachable')
    let address: URL
    try { address = new URL(route.address) } catch (cause) { throw new NetError('bad_request', 'Invalid direct route URL.', { cause }) }
    if (!['ws:', 'wss:'].includes(address.protocol) || address.username || address.password || address.hash || address.pathname !== '/mousse-net') throw new NetError('bad_request', 'Invalid direct route URL.')
    const resolved = this.resolved.get(route.address)
    this.resolved.delete(route.address)
    const resolvedLookup: LookupFunction | undefined = resolved ? (_hostname, options, callback) => {
      queueMicrotask(() => {
        const selected = options.family ? resolved.filter(answer => answer.family === options.family) : resolved
        if (options.all) callback(null, selected)
        else if (selected[0]) callback(null, selected[0].address, selected[0].family)
        else callback(Object.assign(new Error('No resolved route address.'), { code: 'ENOTFOUND' }), '')
      })
    } : undefined
    return new Promise((resolve, reject) => {
      const clientOptions = { ...(resolvedLookup ? { lookup: resolvedLookup } : {}), maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, handshakeTimeout: 10_000, followRedirects: false }
      const ws = new WebSocket(address, clientOptions)
      let settled = false
      const abort = () => { if (!settled) finish(new NetError('cancelled', undefined, { cause: signal.reason })); ws.terminate() }
      const closed = () => finish(new NetError('route_unreachable', 'WebSocket closed while dialing.'))
      const finish = (error: NetError) => { if (settled) return; settled = true; ws.removeListener('open', opened); signal.removeEventListener('abort', abort); ws.terminate(); reject(this.failure(error)) }
      const opened = () => {
        if (settled) return
        settled = true; ws.removeListener('close', closed)
        ws.on('message', (_bytes, binary) => { if (!binary) ws.terminate() })
        const raw = boundedWebSocketStream(ws); this.track(raw); ws.once('close', () => this.streams.delete(raw))
        raw.once('close', () => signal.removeEventListener('abort', abort)); resolve(raw)
      }
      ws.on('error', cause => finish(new NetError('route_unreachable', 'WebSocket dial failed.', { cause }))); ws.once('close', closed); ws.once('open', opened)
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    })
  }
  private async closeListener(): Promise<void> {
    const server = this.server, wss = this.wsServer
    this.server = undefined; this.wsServer = undefined; this.endpoint = undefined; this.listening = undefined; this.accepting = undefined
    for (const lease of this.leases.values()) { lease.timer.cancel(); lease.socket.destroy() }
    this.leases.clear(); this.byStream.clear()
    wss?.close()
    if (server?.listening) await new Promise<void>(resolve => { server.close(() => resolve()) })
    this.changed()
  }
  async teardown(): Promise<void> { await this.closeListener(); for (const raw of this.streams) raw.destroy(); this.streams.clear(); this.resolved.clear(); this.state = 'disabled'; this.changed() }
}
