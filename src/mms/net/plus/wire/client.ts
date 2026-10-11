import { randomBytes } from 'node:crypto'
import { Duplex } from 'node:stream'
import WebSocket, { createWebSocketStream } from 'ws'
import { parseBoundedJsonDocument } from './codec.js'
import { decodeBase64, isNodeId, ticketHash } from './crypto.js'
import { isRelayErrorCode, NetRelayError } from './errors.js'
import { AUTH_MAX_BYTES, canonicalAudience, FRAME_MAX_BYTES, hostedRelayProofBytes } from './protocol.js'
import type { HostedRelayAuth, HostedRelayRegistration, HostedRelayRendezvous, RelayIdentity, RelayRole } from './types.js'

export interface HostedRelayTransportOptions {
  id?: string
  audience: string
  identity(): RelayIdentity
  registration(): HostedRelayRegistration | Promise<HostedRelayRegistration>
  enrollment?: HostedRelayRendezvous
  priority?: number
}
export interface HostedRelayRoute { transport: string; address: string; priority: number }
export interface HostedRelayStatus { state: 'disabled' | 'ready' | 'degraded'; routes: HostedRelayRoute[] }
/** Derived from native RelayTransport rawStream, preserving ordered 64 KiB segmentation. */
function rawStream(ws: WebSocket): Duplex {
  ws.on('message', (_bytes, binary) => { if (!binary) ws.terminate() })
  const bytes = createWebSocketStream(ws, { highWaterMark: FRAME_MAX_BYTES })
  const raw = new Duplex({
    highWaterMark: FRAME_MAX_BYTES,
    read() { bytes.resume() },
    write(chunk: Buffer, _encoding, done) {
      let offset = 0
      const next = (error?: Error | null): void => {
        if (error) { done(error); return }
        if (offset === chunk.length) { done(); return }
        const part = chunk.subarray(offset, offset + FRAME_MAX_BYTES); offset += part.length; bytes.write(part, next)
      }
      next()
    },
    final(done) { bytes.end(done) },
    destroy(error, done) { bytes.destroy(error ?? undefined); done(error) }
  })
  bytes.on('data', (chunk: Buffer) => { if (!raw.push(chunk)) bytes.pause() })
  bytes.on('end', () => raw.push(null)); bytes.on('close', () => raw.destroy()); bytes.on('error', error => raw.destroy(error)); raw.on('error', () => {})
  // A consumer may never read a failed handshake. Socket close must still tear
  // down the Duplex without waiting for its readable queue to be consumed.
  ws.once('close', () => raw.destroy())
  return raw
}
/** Outer WSS retains standard certificate/hostname verification. Inner TLS belongs to Net. */
export class HostedRelayTransport {
  readonly id: string
  readonly traits = { canListen: true, canDial: true, readsPlaintext: true, needsAccount: true }
  private readonly sockets = new Set<WebSocket>()
  private readonly statusListeners = new Set<(status: HostedRelayStatus) => void>()
  private readonly audience: string
  private statusValue: HostedRelayStatus = { state: 'disabled', routes: [] }
  private accept?: (raw: Duplex, info: { transport: string }) => void
  private stopped = false
  private listening = false
  private armed = false
  private failures = 0
  private retry?: ReturnType<typeof setTimeout>
  constructor(private readonly options: HostedRelayTransportOptions) {
    this.id = options.id ?? 'relay'
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(this.id)) throw new NetRelayError('bad_request')
    this.audience = canonicalAudience(options.audience)
    if (options.enrollment && (options.enrollment.transport !== this.id || canonicalAudience(options.enrollment.relay) !== this.audience || !Number.isSafeInteger(options.enrollment.expiresAt))) throw new NetRelayError('invite_invalid')
    if (options.enrollment) decodeBase64(options.enrollment.ticket, 32)
  }
  async provision(): Promise<void> { if (this.stopped) throw new NetRelayError('cancelled'); this.changed('ready') }
  status(): HostedRelayStatus { return structuredClone(this.statusValue) }
  onStatus(listener: (status: HostedRelayStatus) => void): () => void { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener) } }
  private changed(state: HostedRelayStatus['state']): void {
    const routes:HostedRelayRoute[]=[]
    if(state==='ready'&&this.listening&&!this.options.enrollment){
      const url = new URL(this.audience); url.searchParams.set('node', this.options.identity().node)
      routes.push({transport:this.id,address:url.toString(),priority:this.options.priority??20})
    }
    this.statusValue = { state, routes }
    for (const listener of this.statusListeners) listener(this.status())
  }
  private open(role: RelayRole, target: `nod_${string}`, signal?: AbortSignal, rendezvous?: HostedRelayAuth['rendezvous']): Promise<{ ws: WebSocket; paired: Promise<Duplex | undefined> }> {
    if (this.stopped || signal?.aborted) return Promise.reject(new NetRelayError('cancelled'))
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.audience, { maxPayload: FRAME_MAX_BYTES, perMessageDeflate: false, handshakeTimeout: 5000, followRedirects: false })
      this.sockets.add(ws)
      let state: 'challenge' | 'signing' | 'auth' | 'ready' | 'paired' | 'failed' = 'challenge'
      let resolvePaired!: (raw?: Duplex) => void, rejectPaired!: (error: unknown) => void
      const paired = new Promise<Duplex | undefined>((res, rej) => { resolvePaired = res; rejectPaired = rej }); void paired.catch(() => {})
      let timer = setTimeout(() => fail(new NetRelayError('deadline_exceeded')), 5000)
      const abort = () => fail(new NetRelayError('cancelled'))
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      const fail = (error: unknown) => {
        if (state === 'failed') return
        const ready = state === 'ready' || state === 'paired'; state = 'failed'; cleanup(); rejectPaired(error); if (!ready) reject(error); ws.terminate()
      }
      const message = (input: WebSocket.RawData, binary: boolean) => {
        try {
          const bytes = Array.isArray(input) ? Buffer.concat(input) : Buffer.from(input as ArrayBuffer)
          if (binary) throw new NetRelayError('bad_request')
          const value = parseBoundedJsonDocument(bytes, AUTH_MAX_BYTES) as Record<string, unknown>
          if (!value || typeof value !== 'object' || value.v !== 1) throw new NetRelayError('bad_request')
          if (value.t === 'error') {
            if (Object.keys(value).sort().join(',') !== 'code,t,v' || !isRelayErrorCode(value.code)) throw new NetRelayError('bad_request')
            fail(new NetRelayError(value.code)); return
          }
          if (value.t === 'challenge' && state === 'challenge') {
            if (Object.keys(value).sort().join(',') !== 'audience,nonce,t,v' || value.audience !== this.audience || canonicalAudience(String(value.audience)) !== this.audience) throw new NetRelayError('forbidden')
            decodeBase64(value.nonce as string, 32); state = 'signing'
            void Promise.resolve(this.options.registration()).then(registration => {
              if (state !== 'signing' || signal?.aborted || this.stopped) throw new NetRelayError('cancelled')
              const who = this.options.identity()
              const auth: Omit<HostedRelayAuth, 'sig'> = { t: 'auth', v: 1, audience: this.audience, nonce: value.nonce as string, node: who.node, signKey: who.signKey, role, target, registrationId: registration.registrationId, generation: registration.generation, ...(rendezvous ? { rendezvous } : {}) }
              const encoded = JSON.stringify({ ...auth, sig: Buffer.from(who.sign(hostedRelayProofBytes(auth))).toString('base64url') })
              if (Buffer.byteLength(encoded) > AUTH_MAX_BYTES) throw new NetRelayError('too_large')
              state = 'auth'; ws.send(encoded)
            }).catch(fail)
          } else if (value.t === 'registered' && role === 'register' && state === 'auth' && Object.keys(value).length === 2) {
            state = 'paired'; cleanup(); resolvePaired(); resolve({ ws, paired }); ws.close()
          } else if (value.t === 'ready' && role !== 'register' && state === 'auth' && Object.keys(value).length === 2) {
            state = 'ready'; clearTimeout(timer); timer = setTimeout(() => fail(new NetRelayError('deadline_exceeded')), 60_000); resolve({ ws, paired })
          } else if (value.t === 'paired' && state === 'ready' && Object.keys(value).sort().join(',') === 'circuitId,peer,t,v' && isNodeId(value.peer) && (role === 'listen' || value.peer === target) && typeof value.circuitId === 'string' && value.circuitId.length <= 128) {
            state = 'paired'; cleanup(); ws.removeListener('message', message); resolvePaired(rawStream(ws))
          } else throw new NetRelayError('bad_request')
        } catch (error) { fail(error) }
      }
      ws.on('message', message); ws.on('error', () => fail(new NetRelayError('route_unreachable')))
      ws.once('close', () => { this.sockets.delete(ws); cleanup(); if (state !== 'paired' && state !== 'failed') fail(new NetRelayError('route_unreachable')) })
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    })
  }
  async listen(accept: (raw: Duplex, info: { transport: string }) => void): Promise<{ close(): Promise<void> }> {
    if (this.options.enrollment) throw new NetRelayError('forbidden')
    if (this.listening) { if (this.accept !== accept) throw new NetRelayError('conflict'); return { close: () => this.stopListening() } }
    this.accept = accept; this.listening = true
    await this.arm(); return { close: () => this.stopListening() }
  }
  private async arm(): Promise<void> {
    if (!this.listening || this.armed || this.stopped) return
    this.armed = true
    try {
      const opened = await this.open('listen', this.options.identity().node)
      this.failures = 0; this.changed('ready')
      void opened.paired.then(raw => {
        this.armed = false
        if (!raw || !this.listening || this.stopped) { opened.ws.terminate(); return }
        try { this.accept?.(raw, { transport: this.id }) } catch { raw.destroy(); this.changed('degraded') }
        finally { void this.arm().catch(() => {}) }
      }, () => { this.armed = false; this.rearm() })
    } catch (error) { this.armed = false; this.rearm(); throw error }
  }
  private rearm(): void {
    if (!this.listening || this.stopped || this.retry) return
    this.changed('degraded')
    this.retry = setTimeout(() => { this.retry = undefined; void this.arm().catch(() => {}) }, Math.min(60_000, 1000 * 2 ** Math.min(6, this.failures++)))
  }
  async dial(route: HostedRelayRoute, signal: AbortSignal): Promise<Duplex> {
    if (route.transport !== this.id || this.statusValue.state === 'disabled') throw new NetRelayError('route_unreachable')
    const url = new URL(route.address), target = url.searchParams.get('node')
    if (!isNodeId(target) || [...url.searchParams.keys()].some(key => key !== 'node') || url.searchParams.getAll('node').length !== 1) throw new NetRelayError('bad_request')
    url.search = ''; if (canonicalAudience(url.toString()) !== this.audience) throw new NetRelayError('forbidden')
    const opened = await this.open('dial', target, signal, this.options.enrollment ? { ticket: this.options.enrollment.ticket } : undefined)
    const timer = setTimeout(() => opened.ws.terminate(), 10_000)
    try { const raw = await opened.paired; if (!raw) throw new NetRelayError('internal'); return raw } finally { clearTimeout(timer) }
  }
  async prepareEnrollmentRendezvous(input: { expiresAt: number }): Promise<HostedRelayRendezvous> {
    if (this.options.enrollment || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) throw new NetRelayError('bad_request')
    const ticket = randomBytes(32).toString('base64url')
    await this.open('register', this.options.identity().node, undefined, { ticketHash: ticketHash(ticket), expiresAt: input.expiresAt })
    return { transport: this.id, relay: this.audience, ticket, expiresAt: input.expiresAt }
  }
  private async stopListening(): Promise<void> { this.listening = false; this.accept = undefined; clearTimeout(this.retry); this.retry = undefined; for (const ws of this.sockets) ws.terminate(); this.armed = false; this.changed('ready') }
  async teardown(): Promise<void> { this.stopped = true; await this.stopListening(); this.changed('disabled') }
}
