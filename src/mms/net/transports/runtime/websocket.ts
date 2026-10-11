import type { LookupFunction } from 'node:net'
import { Duplex } from 'node:stream'
import WebSocket, { createWebSocketStream } from 'ws'
import { NetError } from '../../../../shared/net/errors'

export function boundedWebSocketBytes(ws: WebSocket): Duplex {
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
  bytes.on('error', (error) => raw.destroy(error))
  raw.on('error', () => {})
  return raw
}

/** An explicit resolver changes only address selection; the URL keeps Host and TLS SNI. */
export function dialWebSocketBytes(
  address: URL,
  signal: AbortSignal,
  lookup?: LookupFunction
): Promise<Duplex> {
  if (signal.aborted) return Promise.reject(new NetError('cancelled'))
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(address, {
      ...(lookup ? { lookup } : {}),
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
      followRedirects: false
    })
    let opened = false
    const failed = (code: 'cancelled' | 'route_unreachable', cause?: unknown) => {
      if (!opened) reject(new NetError(code, undefined, { cause }))
      ws.terminate()
    }
    const abort = () => failed('cancelled')
    ws.once('open', () => {
      opened = true
      const raw = boundedWebSocketBytes(ws)
      resolve(raw)
    })
    ws.on('message', (_bytes, binary) => {
      if (!binary) ws.terminate()
    })
    ws.on('error', (cause) => failed('route_unreachable', cause))
    ws.once('close', () => {
      signal.removeEventListener('abort', abort)
      if (!opened) reject(new NetError('route_unreachable'))
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
