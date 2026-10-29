import { timingSafeEqual } from 'crypto'
import type { IncomingHttpHeaders, IncomingMessage } from 'http'

/**
 * Helpers for the daemon's loopback HTTP listener (the scheduled-job webhooks): body reading with a
 * hard byte limit, the browser and Host checks, and a constant-time
 * comparison. They deal in raw bytes so a caller can verify a signature over exactly what was sent.
 */

export class BodyTooLargeError extends Error {
  constructor() {
    super('Payload too large')
    this.name = 'BodyTooLargeError'
  }
}

export class BodyTimeoutError extends Error {
  constructor() {
    super('Request body timed out')
    this.name = 'BodyTimeoutError'
  }
}

/** True when a declared `Content-Length` already exceeds `maxBytes` (refuse before reading anything). */
export function declaredLengthExceeds(headers: IncomingHttpHeaders, maxBytes: number): boolean {
  const declared = Number(headers['content-length'])
  return Number.isFinite(declared) && declared > maxBytes
}

/**
 * Reads the request body as bytes, counting what actually arrives: a chunked body or one with no
 * declared length is limited the same as one that declares its size. Rejects with `BodyTooLargeError`
 * as soon as `maxBytes` is passed and stops reading.
 *
 * `abortOnClose` rejects when the connection ends before the body does, and `timeoutMs` rejects when the whole
 * body has not arrived by then, so a stalled client cannot hold a handler (or a shutdown) open. Both are
 * off by default.
 */
export function readBodyBytes(
  req: IncomingMessage,
  maxBytes: number,
  options: { timeoutMs?: number; abortOnClose?: boolean } = {}
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (declaredLengthExceeds(req.headers, maxBytes)) {
      reject(new BodyTooLargeError())
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    let timer: NodeJS.Timeout | undefined
    const finish = (settle: () => void): void => {
      if (timer) clearTimeout(timer)
      settle()
    }
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (done) return
        done = true
        chunks.length = 0
        req.removeAllListeners('data')
        reject(new BodyTimeoutError())
      }, options.timeoutMs)
      timer.unref?.()
    }
    req.on('data', (chunk) => {
      if (done) return
      const buf = Buffer.from(chunk)
      size += buf.length
      if (size > maxBytes) {
        done = true
        chunks.length = 0
        req.pause()
        req.removeAllListeners('data')
        finish(() => reject(new BodyTooLargeError()))
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (!done) finish(() => resolve(Buffer.concat(chunks)))
    })
    req.on('error', (err) => {
      if (!done) finish(() => reject(err))
    })
    if (options.abortOnClose) {
      req.on('close', () => {
        if (!done && !req.complete) {
          done = true
          finish(() => reject(new Error('Connection closed before the body ended')))
        }
      })
    }
  })
}

export function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false
  return value.split(';')[0].trim().toLowerCase() === 'application/json'
}

/** Constant-time equality for two secrets of any length (a length mismatch is not secret here). */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** A request a web page sent: browsers add `Origin`, and `Sec-Fetch-Site` unless the request came from outside a page. */
export function isBrowserOriginated(headers: IncomingHttpHeaders): boolean {
  if (headers.origin !== undefined) return true
  const fetchSite = headers['sec-fetch-site']
  return fetchSite !== undefined && fetchSite !== 'none'
}

/** The `Host` a client uses to reach a loopback listener on `port`; anything else is DNS rebinding or a proxy. */
export function isAllowedLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase())
}
