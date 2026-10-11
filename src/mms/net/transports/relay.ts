import { randomBytes } from 'node:crypto'
import { Duplex } from 'node:stream'
import WebSocket, { createWebSocketStream } from 'ws'
import type {
  Clock,
  InboundInfo,
  Listener,
  Transport,
  TransportAddon,
  TransportStatus
} from '../contracts'
import type { NodeId, Route } from '../../../shared/net'
import { isId } from '../../../shared/net/ids'
import { NetError, isNetErrorCode } from '../../../shared/net/errors'
import { decodeBase64 } from '../identity/crypto'
import {
  relayProofBytes,
  relayUrl,
  ticketHash,
  type RelayAuth,
  type RelayIdentity,
  type RelayRendezvous
} from '../relay/protocol'
import { systemClock } from '../clock'
import { PreauthAdmission } from './admission'
export type { RelayIdentity, RelayRendezvous } from '../relay/protocol'

export interface RelaySettings {
  address: string
  priority?: number
}
export interface RelayTransportOptions {
  settings: RelaySettings
  identity(): RelayIdentity
  enrollment?: RelayRendezvous
  clock?: Clock
  admission?: PreauthAdmission
}
type Opened = { ws: WebSocket; paired: Promise<Duplex | undefined> }
function rawStream(ws: WebSocket): Duplex {
  ws.on('message', (_bytes, binary) => {
    if (!binary) ws.terminate()
  })
  const bytes = createWebSocketStream(ws, { highWaterMark: 64 * 1024 })
  const raw = new Duplex({
    highWaterMark: 64 * 1024,
    read() {
      bytes.resume()
    },
    write(chunk: Buffer, _encoding, done) {
      let offset = 0
      const next = (error?: Error | null): void => {
        if (error) {
          done(error)
          return
        }
        if (offset === chunk.length) {
          done()
          return
        }
        const part = chunk.subarray(offset, offset + 64 * 1024)
        offset += part.length
        bytes.write(part, next)
      }
      next()
    },
    final(done) {
      bytes.end(done)
    },
    destroy(error, done) {
      bytes.destroy(error ?? undefined)
      done(error)
    }
  })
  bytes.on('data', (chunk: Buffer) => {
    if (!raw.push(chunk)) bytes.pause()
  })
  bytes.on('end', () => raw.push(null))
  bytes.on('close', () => raw.destroy())
  ws.once('close', () => raw.destroy())
  bytes.on('error', (error) => raw.destroy(error))
  raw.on('error', () => {})
  return raw
}

/** Profile admission bounds paired streams even for an untrusted relay; inner TLS authenticates peers. */
export class RelayTransport implements Transport {
  readonly id = 'relay'
  readonly traits = { canListen: true, canDial: true, readsPlaintext: true, needsAccount: false }
  private readonly clock: Clock
  private statusValue: TransportStatus = { state: 'disabled', routes: [] }
  private readonly sockets = new Set<WebSocket>()
  private readonly listeners = new Set<(status: TransportStatus) => void>()
  private accept?: (raw: Duplex, info: InboundInfo) => void
  private listening = false
  private stopped = false
  private armed = false
  private admissionOff?: () => void
  private failures = 0
  private retry?: { cancel(): void }
  constructor(private readonly options: RelayTransportOptions) {
    this.clock = options.clock ?? systemClock
    relayUrl(options.settings.address)
    if (options.enrollment) {
      decodeBase64(options.enrollment.ticket, 32)
      if (
        options.enrollment.transport !== 'relay' ||
        relayUrl(options.enrollment.relay).toString() !==
          relayUrl(options.settings.address).toString() ||
        !Number.isSafeInteger(options.enrollment.expiresAt)
      )
        throw new NetError('invite_invalid')
    }
  }
  async provision(): Promise<void> {
    if (this.stopped) throw new NetError('cancelled')
    this.changed('ready')
  }
  status(): TransportStatus {
    return structuredClone(this.statusValue)
  }
  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed(state: TransportStatus['state']): void {
    this.statusValue = {
      state,
      routes:
        state === 'ready' && this.listening && !this.options.enrollment
          ? [
              {
                transport: this.id,
                address: relayUrl(
                  this.options.settings.address,
                  this.options.identity().node
                ).toString(),
                priority: this.options.settings.priority ?? 20
              }
            ]
          : []
    }
    for (const listener of this.listeners) listener(this.status())
  }
  private open(
    role: RelayAuth['role'],
    target: NodeId,
    signal?: AbortSignal,
    registration?: { ticketHash: string; expiresAt: number }
  ): Promise<Opened> {
    if (this.stopped || signal?.aborted) return Promise.reject(new NetError('cancelled'))
    const url = relayUrl(this.options.settings.address)
    url.search = ''
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        maxPayload: 64 * 1024,
        perMessageDeflate: false,
        handshakeTimeout: 10_000,
        followRedirects: false
      })
      this.sockets.add(ws)
      let ready = false,
        challenged = false,
        paired = false,
        resolvePaired!: (raw?: Duplex) => void,
        rejectPaired!: (error: unknown) => void
      const pairing = new Promise<Duplex | undefined>((res, rej) => {
        resolvePaired = res
        rejectPaired = rej
      })
      void pairing.catch(() => {})
      const timer = this.clock.setTimeout(() => fail(new NetError('deadline_exceeded')), 10_000)
      const abort = () => fail(new NetError('cancelled'))
      const fail = (error: NetError) => {
        timer.cancel()
        signal?.removeEventListener('abort', abort)
        rejectPaired(error)
        if (!ready) reject(error)
        ws.terminate()
      }
      const message = (bytes: WebSocket.RawData, binary: boolean) => {
        try {
          const count = Array.isArray(bytes)
            ? bytes.reduce((sum, part) => sum + part.length, 0)
            : bytes instanceof ArrayBuffer
              ? bytes.byteLength
              : bytes.length
          if (binary || count > 16 * 1024) throw new NetError('bad_request')
          const value = JSON.parse(bytes.toString()) as {
            t?: string
            nonce?: string
            peer?: string
            code?: string
          }
          if (value.t === 'error' && isNetErrorCode(value.code)) {
            fail(new NetError(value.code))
            return
          }
          if (value.t === 'challenge' && !challenged && !ready) {
            challenged = true
            decodeBase64(value.nonce!, 32)
            const identity = this.options.identity()
            const auth: Omit<RelayAuth, 'sig'> = {
              t: 'auth',
              v: 1,
              nonce: value.nonce!,
              node: identity.node,
              signKey: identity.signKey,
              role,
              target,
              ...(identity.delegation ? { delegation: identity.delegation } : {}),
              ...(identity.roster ? { roster: identity.roster } : {}),
              ...(role === 'dial' && this.options.enrollment
                ? { ticket: this.options.enrollment.ticket }
                : {}),
              ...registration
            }
            const signed = {
              ...auth,
              sig: Buffer.from(identity.sign(relayProofBytes(auth))).toString('base64url')
            }
            const encoded = JSON.stringify(signed)
            if (Buffer.byteLength(encoded) > 16 * 1024) throw new NetError('too_large')
            ws.send(encoded)
          } else if (value.t === 'registered' && role === 'register' && challenged) {
            timer.cancel()
            ready = true
            paired = true
            resolvePaired()
            resolve({ ws, paired: pairing })
            ws.close()
          } else if (value.t === 'ready' && challenged && !ready) {
            ready = true
            timer.cancel()
            resolve({ ws, paired: pairing })
          } else if (
            value.t === 'paired' &&
            ready &&
            !paired &&
            isId('node', value.peer) &&
            (role === 'listen' || value.peer === target)
          ) {
            paired = true
            ws.removeListener('message', message)
            resolvePaired(rawStream(ws))
          } else throw new NetError('bad_request')
        } catch (cause) {
          fail(cause instanceof NetError ? cause : new NetError('bad_request'))
        }
      }
      ws.on('message', message)
      ws.on('error', () => fail(new NetError('route_unreachable')))
      ws.once('close', () => {
        this.sockets.delete(ws)
        timer.cancel()
        signal?.removeEventListener('abort', abort)
        if (!paired) {
          const error = new NetError('route_unreachable')
          rejectPaired(error)
          if (!ready) reject(error)
        }
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
  async listen(accept: (raw: Duplex, info: InboundInfo) => void): Promise<Listener> {
    if (this.options.enrollment) throw new NetError('forbidden')
    if (this.listening) {
      if (this.accept !== accept) throw new NetError('conflict')
      return { close: () => this.stopListening() }
    }
    this.accept = accept
    this.listening = true
    this.admissionOff = this.options.admission?.onAvailable(() => {
      void this.arm().catch(() => {})
    })
    await this.arm()
    return { close: () => this.stopListening() }
  }
  private async arm(): Promise<void> {
    if (!this.listening || this.armed || this.stopped) return
    // The relay cannot multiply admission buckets by inventing advertised peer IDs.
    const endpoint = relayUrl(this.options.settings.address).origin
    if (this.options.admission && !this.options.admission.canAdmit(`relay:${endpoint}`)) return
    this.armed = true
    try {
      const opened = await this.open('listen', this.options.identity().node)
      this.failures = 0
      this.changed('ready')
      void opened.paired.then(
        (raw) => {
          this.armed = false
          if (!this.listening || this.stopped) {
            opened.ws.terminate()
            return
          }
          if (!raw) {
            opened.ws.terminate()
            return
          }
          try {
            this.accept?.(raw, { transport: this.id, remoteAddress: endpoint })
          } catch {
            raw.destroy()
            this.changed('degraded')
          } finally {
            void this.arm().catch(() => {})
          }
        },
        () => {
          this.armed = false
          this.rearm()
        }
      )
    } catch (error) {
      this.armed = false
      this.rearm()
      throw error
    }
  }
  private rearm(): void {
    if (!this.listening || this.stopped || this.retry) return
    this.changed('degraded')
    this.retry = this.clock.setTimeout(
      () => {
        this.retry = undefined
        void this.arm().catch(() => {})
      },
      Math.min(60_000, 1000 * 2 ** Math.min(6, this.failures++))
    )
  }
  async dial(route: Route, signal: AbortSignal): Promise<Duplex> {
    if (route.transport !== this.id || this.statusValue.state === 'disabled')
      throw new NetError('route_unreachable')
    const url = relayUrl(route.address),
      target = url.searchParams.get('node')
    if (!isId('node', target) || relayUrl(this.options.settings.address).origin !== url.origin)
      throw new NetError('bad_request')
    const opened = await this.open('dial', target, signal)
    const timer = this.clock.setTimeout(() => opened.ws.terminate(), 10_000)
    try {
      const raw = await opened.paired
      if (!raw) throw new NetError('internal')
      return raw
    } finally {
      timer.cancel()
    }
  }
  async prepareEnrollmentRendezvous(input: { expiresAt: number }): Promise<RelayRendezvous> {
    if (
      this.options.enrollment ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= this.clock.now()
    )
      throw new NetError('bad_request')
    const ticket = randomBytes(32).toString('base64url')
    await this.open('register', this.options.identity().node, undefined, {
      ticketHash: ticketHash(ticket),
      expiresAt: input.expiresAt
    })
    return {
      transport: 'relay',
      relay: relayUrl(this.options.settings.address).toString(),
      ticket,
      expiresAt: input.expiresAt
    }
  }
  private async stopListening(): Promise<void> {
    this.listening = false
    this.admissionOff?.()
    this.admissionOff = undefined
    this.accept = undefined
    this.retry?.cancel()
    this.retry = undefined
    for (const ws of this.sockets) ws.terminate()
    this.armed = false
    this.changed('ready')
  }
  async teardown(): Promise<void> {
    this.stopped = true
    await this.stopListening()
    this.changed('disabled')
  }
}

export function createRelayAddon(
  identity: () => RelayIdentity,
  admission?: PreauthAdmission
): TransportAddon {
  return {
    manifest: {
      id: 'relay',
      kind: 'transport',
      displayName: 'Self-hosted relay',
      traits: { canListen: true, canDial: true, readsPlaintext: true, needsAccount: false },
      settingsSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['address'],
        properties: {
          address: { type: 'string', minLength: 1, maxLength: 4096 },
          priority: { type: 'integer', minimum: 0, maximum: 1000 }
        }
      },
      setupSteps: [
        {
          title: 'Allow your identity',
          detail:
            'Configure your relay with the allowed public user or node keys. Inner pinned TLS protects content from the relay.'
        }
      ]
    },
    create: (settings, context) =>
      new RelayTransport({
        settings: settings as RelaySettings,
        identity,
        clock: context.clock,
        admission
      })
  }
}
