import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type {
  PiBridgeAddress,
  PiCatalogResponse,
  PiCredentialRequest,
  PiCredentialResponse,
  PiFatalRequest,
  PiGroupRequest,
  PiGateRequest,
  PiGateResponse,
  PiQuiesceRequest,
  PiQuiesceResponse,
  PiReadyRequest,
  PiRequestRequest,
  PiRequestResponse,
  PiSettleRequest,
  PiTurnResponse
} from './extension/protocol'

/**
 * The Pi RPC engine's side of its extension's bridge: JSON over HTTP on `127.0.0.1`, one bearer per
 * Pi process. The bearer is the process's only credential here; each endpoint answers for that
 * process alone. Nothing here decides policy: it hands requests to the process's handlers.
 */

export interface PiBridgeHandlers {
  /** `first`: the factory's request, the only one answered with the stored key. */
  catalog(first: boolean): Promise<PiCatalogResponse>
  ready(request: PiReadyRequest): void
  turn(): Promise<PiTurnResponse>
  gate(request: PiGateRequest): Promise<PiGateResponse>
  /** One model request about to be sent: charged to the live turn, or refused. */
  request(request: PiRequestRequest): Promise<PiRequestResponse>
  /** A reserved request ended: its reservation is settled or released. */
  settle(request: PiSettleRequest): void
  /** Settles when the request's delegation may run; `signal` aborts when the extension gave up. */
  quiesce(request: PiQuiesceRequest, signal: AbortSignal): Promise<PiQuiesceResponse>
  fatal(request: PiFatalRequest): void
  /** Records a shell's group; resolves once recorded (the command runs only then). */
  group?(request: PiGroupRequest): Promise<void>
  /** An OAuth provider's refresh; a throw is answered with no detail (the extension raises a fixed text). */
  credential?(request: PiCredentialRequest): Promise<PiCredentialResponse>
}

export interface PiBridgeRegistration {
  address: PiBridgeAddress
  /** Revokes the bearer; later requests are refused. */
  close(): void
}

/** Gate inputs carry whole files (`write`). */
const MAX_BODY_BYTES = 32 * 1024 * 1024

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class PiBridge {
  private server: Server | null = null
  private starting: Promise<void> | null = null
  private address: AddressInfo | null = null
  private readonly sockets = new Set<Socket>()
  private readonly processes = new Map<string, { handlers: PiBridgeHandlers; catalogs: number }>()

  /** Starts listening (once); later calls wait for the same start. */
  start(): Promise<void> {
    if (this.server && this.address) return Promise.resolve()
    if (this.starting) return this.starting
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        if (!res.headersSent) this.reply(res, 500, { error: error instanceof Error ? error.message : String(error) })
        else res.destroy()
      })
    })
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    this.starting = new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        this.server = server
        this.address = server.address() as AddressInfo
        resolve()
      })
    }).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  get url(): string {
    if (!this.address) throw new Error('The Pi bridge is not running')
    return `http://127.0.0.1:${this.address.port}`
  }

  /** A bearer for one Pi process; its requests go to `handlers`. */
  register(handlers: PiBridgeHandlers): PiBridgeRegistration {
    const token = randomBytes(32).toString('base64url')
    this.processes.set(token, { handlers, catalogs: 0 })
    return { address: { url: this.url, token }, close: () => void this.processes.delete(token) }
  }

  stop(): void {
    this.processes.clear()
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server?.close()
    this.server = null
    this.address = null
  }

  private reply(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }

  private process(req: IncomingMessage): { handlers: PiBridgeHandlers; catalogs: number } | undefined {
    const header = req.headers.authorization
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) return undefined
    for (const [known, entry] of this.processes) if (sameToken(known, token)) return entry
    return undefined
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) throw new Error('The request is too large')
      chunks.push(chunk as Buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : {}
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !req.url?.startsWith('/pi/')) return this.reply(res, 404, { error: 'not found' })
    const entry = this.process(req)
    if (!entry) return this.reply(res, 401, { error: 'unauthorized' })
    const name = req.url.slice('/pi/'.length)
    const body = (await this.body(req)) as Record<string, unknown>
    const { handlers } = entry
    switch (name) {
      case 'catalog':
        entry.catalogs += 1
        return this.reply(res, 200, await handlers.catalog(entry.catalogs === 1))
      case 'ready':
        handlers.ready(body as unknown as PiReadyRequest)
        return this.reply(res, 200, {})
      case 'turn':
        return this.reply(res, 200, await handlers.turn())
      case 'gate':
        return this.reply(res, 200, await handlers.gate(body as unknown as PiGateRequest))
      case 'request':
        return this.reply(res, 200, await handlers.request(body as unknown as PiRequestRequest))
      case 'settle':
        handlers.settle(body as unknown as PiSettleRequest)
        return this.reply(res, 200, {})
      case 'quiesce': {
        const aborted = new AbortController()
        res.on('close', () => {
          if (!res.writableEnded) aborted.abort()
        })
        return this.reply(res, 200, await handlers.quiesce(body as unknown as PiQuiesceRequest, aborted.signal))
      }
      case 'group':
        if (!handlers.group) return this.reply(res, 404, { error: 'not found' })
        await handlers.group(body as unknown as PiGroupRequest)
        return this.reply(res, 200, {})
      case 'credential': {
        if (!handlers.credential) return this.reply(res, 404, { error: 'not found' })
        // Never the reason: it may carry upstream text or credential material.
        const answer = await handlers.credential(body as unknown as PiCredentialRequest).catch(() => undefined)
        return answer ? this.reply(res, 200, answer) : this.reply(res, 403, { error: 'credential_unavailable' })
      }
      case 'fatal':
        handlers.fatal(body as unknown as PiFatalRequest)
        return this.reply(res, 200, {})
      default:
        return this.reply(res, 404, { error: 'not found' })
    }
  }
}
