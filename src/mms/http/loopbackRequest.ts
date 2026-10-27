import { timingSafeEqual } from 'crypto'
import type { IncomingHttpHeaders, IncomingMessage } from 'http'

/**
 * Helpers shared by the daemon's loopback HTTP listeners (the channel webhook and the scheduled-job
 * webhooks): body reading with a hard byte limit, the browser and Host checks, and a constant-time
 * comparison. They deal in raw bytes so a caller can verify a signature over exactly what was sent.
 */

export class BodyTooLargeError extends Error {
  constructor() {
    super('Payload too large')
    this.name = 'BodyTooLargeError'
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
 */
export function readBodyBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (declaredLengthExceeds(req.headers, maxBytes)) {
      reject(new BodyTooLargeError())
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      const buf = Buffer.from(chunk)
      size += buf.length
      if (size > maxBytes) {
        done = true
        chunks.length = 0
        req.pause()
        req.removeAllListeners('data')
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (!done) reject(err)
    })
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
