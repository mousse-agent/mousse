import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  BodyTooLargeError,
  declaredLengthExceeds,
  isAllowedLoopbackHost,
  isBrowserOriginated,
  readBodyBytes
} from '../http/loopbackRequest'
import { DEFAULT_SCHEDULED_WEBHOOK_PORT } from '../config/types'
import { FileLockBusyError } from './fileLock'
import { WEBHOOK_TIMESTAMP_TOLERANCE_S, type WebhookTriggerResult } from './ScheduledJobStore'

/**
 * The loopback listener that starts scheduled jobs from signed requests.
 *
 *   POST /hooks/<jobId>
 *   X-Mousse-Timestamp: <unix seconds>
 *   X-Mousse-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>." + raw body bytes)>
 *
 * It binds 127.0.0.1 only. Every authentication failure (an unknown job, a job with no webhook, an
 * unreadable secret, a stale or malformed timestamp, a wrong or missing signature) gets the same 401 body, and
 * the HMAC is computed in every case, against a fixed key when there is no secret, so neither the answer nor
 * the work reveals whether a job exists. A body is never parsed or put in a prompt here.
 */

/** Largest request body accepted. */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024

/** The port a stored value names, or the default when it is missing or not a usable port. */
export function scheduledWebhookPort(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : DEFAULT_SCHEDULED_WEBHOOK_PORT
}

const HOOK_PATH = /^\/hooks\/([A-Za-z0-9_-]{1,128})$/
/** A Unix timestamp in seconds, written without leading zeros. */
const TIMESTAMP_PATTERN = /^[1-9]\d{0,11}$/
const SIGNATURE_PATTERN = /^sha256=([0-9a-fA-F]{64})$/
/** What a request with no secret is checked against, so it costs the same HMAC as one with a secret. */
const DUMMY_KEY = randomBytes(32)
const ZERO_MAC = Buffer.alloc(32)

export interface ScheduledWebhookHooks {
  /**
   * The HMAC key of the job's webhook, or undefined for an unknown job, a job with no webhook or a secret that
   * cannot be read. It must do the same lookups in every case.
   */
  resolveSecret(jobId: string): string | undefined
  /** A verified request: consumes its receipt and decides (the store, under the jobs lock). */
  trigger(jobId: string, request: { ts: number; sig: string; body: Buffer }): WebhookTriggerResult
  /** A request that failed verification, for a job that has a webhook (its delivery log). */
  recordRejection(jobId: string, outcome: 'rejected_signature' | 'too_large', bodyBytes: number): void
  /** A delivery was accepted: the scheduler should start it now. */
  accepted(): void
  /** The clock, in milliseconds; tests move it. */
  now?(): number
}

/** The `X-Mousse-Signature` value for a body (what a sender computes; the docs show the `openssl` form). */
export function signWebhookBody(secret: string, timestamp: number | string, body: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`
}

function headerText(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name]
  return typeof value === 'string' ? value : ''
}

export class ScheduledWebhookServer {
  private server: Server | null = null
  private port: number | null = null
  private closing = false
  private stopping: Promise<void> | null = null
  private readonly inFlight = new Set<Promise<void>>()

  constructor(private readonly hooks: ScheduledWebhookHooks) {}

  /** The port the listener is bound to (the real one when started on port 0), or null when it is down. */
  getPort(): number | null {
    return this.port
  }

  /** Binds `127.0.0.1:<port>`. Already listening on that port is a no-op; another port restarts the listener. */
  async start(port: number): Promise<void> {
    if (this.server && this.port !== null && !this.closing && (port === 0 || this.port === port)) return
    if (this.server || this.stopping) await this.stop()
    this.closing = false
    const server = createServer((req, res) => {
      const work = this.handle(req, res).catch(() => this.send(res, 500, { error: 'internal' }))
      this.inFlight.add(work)
      void work.finally(() => this.inFlight.delete(work))
    })
    // Slow or stuck clients are cut off; this is a local trigger, not a public endpoint.
    server.headersTimeout = 10_000
    server.requestTimeout = 30_000
    server.keepAliveTimeout = 5_000
    server.maxConnections = 128
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      server.close()
      throw error
    }
    server.on('error', () => undefined)
    const address = server.address()
    this.server = server
    this.port = typeof address === 'object' && address ? address.port : port
  }

  /** Stops accepting requests at once, then waits for the ones in flight. Calling it again joins the first stop. */
  stop(): Promise<void> {
    this.closing = true
    if (!this.stopping) {
      this.stopping = this.closeServer().finally(() => {
        this.stopping = null
      })
    }
    return this.stopping
  }

  private async closeServer(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = null
    if (!server) return
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeIdleConnections?.()
    await Promise.allSettled([...this.inFlight])
    server.closeIdleConnections?.()
    await closed
  }

  private send(res: ServerResponse, status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): void {
    if (res.headersSent || res.writableEnded) return
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra })
    res.end(JSON.stringify(body))
  }

  private tooLarge(res: ServerResponse, jobId: string): void {
    // Whether the job exists decides only whether the log hears of it; the answer is the same.
    if (this.hooks.resolveSecret(jobId) !== undefined) this.hooks.recordRejection(jobId, 'too_large', 0)
    this.send(res, 413, { error: 'payload_too_large' }, { Connection: 'close' })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closing) return this.send(res, 503, { error: 'shutting_down' })
    if (isBrowserOriginated(req.headers) || !isAllowedLoopbackHost(req.headers.host, this.port ?? 0)) {
      return this.send(res, 403, { error: 'forbidden' })
    }
    const match = req.method === 'POST' && req.url ? HOOK_PATH.exec(req.url) : null
    if (!match) return this.send(res, 404, { error: 'not_found' })
    const jobId = match[1]

    if (declaredLengthExceeds(req.headers, WEBHOOK_MAX_BODY_BYTES)) return this.tooLarge(res, jobId)
    let body: Buffer
    try {
      body = await readBodyBytes(req, WEBHOOK_MAX_BODY_BYTES)
    } catch (error) {
      if (error instanceof BodyTooLargeError) return this.tooLarge(res, jobId)
      throw error
    }
    if (this.closing) return this.send(res, 503, { error: 'shutting_down' })

    let result: WebhookTriggerResult
    try {
      const verified = this.verify(jobId, req.headers, body)
      if (!verified.ok) {
        if (verified.known) this.hooks.recordRejection(jobId, 'rejected_signature', body.length)
        return this.send(res, 401, { error: 'unauthorized' })
      }
      result = this.hooks.trigger(jobId, { ts: verified.ts, sig: verified.sig, body })
    } catch (error) {
      // Nothing about the failure is shown: the request was not accepted and no receipt is promised.
      if (error instanceof FileLockBusyError) return this.send(res, 503, { error: 'busy' }, { 'Retry-After': '1' })
      console.warn('scheduled webhook request failed', { name: error instanceof Error ? error.name : 'Error', code: (error as NodeJS.ErrnoException | undefined)?.code })
      return this.send(res, 500, { error: 'internal' })
    }
    switch (result.kind) {
      case 'accepted':
        this.send(res, 202, { jobId, occurrenceId: result.occurrenceId })
        try { this.hooks.accepted() } catch { /* the next tick starts it */ }
        return
      case 'unknown':
        return this.send(res, 401, { error: 'unauthorized' })
      case 'rate_limited':
        return this.send(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' })
      default:
        return this.send(res, 409, { error: result.kind })
    }
  }

  /** Checks timestamp and signature in constant time and without branching on which part is wrong. */
  private verify(
    jobId: string,
    headers: IncomingHttpHeaders,
    body: Buffer
  ): { ok: true; ts: number; sig: string } | { ok: false; known: boolean } {
    const secret = this.hooks.resolveSecret(jobId)
    const key = secret === undefined ? DUMMY_KEY : Buffer.from(secret, 'utf8')
    const tsText = headerText(headers, 'x-mousse-timestamp')
    const ts = TIMESTAMP_PATTERN.test(tsText) ? Number(tsText) : Number.NaN
    const nowSec = Math.floor((this.hooks.now?.() ?? Date.now()) / 1000)
    const fresh = Number.isFinite(ts) && Math.abs(nowSec - ts) <= WEBHOOK_TIMESTAMP_TOLERANCE_S
    const expected = createHmac('sha256', key).update(`${tsText}.`).update(body).digest()
    const signatureMatch = SIGNATURE_PATTERN.exec(headerText(headers, 'x-mousse-signature'))
    const provided = signatureMatch ? Buffer.from(signatureMatch[1], 'hex') : ZERO_MAC
    const equal = timingSafeEqual(expected, provided)
    // `&` on purpose: every term is evaluated whatever the earlier ones were.
    const ok = Number(secret !== undefined) & Number(fresh) & Number(signatureMatch !== null) & Number(equal)
    return ok === 1 ? { ok: true, ts, sig: expected.toString('hex') } : { ok: false, known: secret !== undefined }
  }
}
