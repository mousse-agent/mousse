/**
 * Tickets as the helper writes them, for the fake helper and the checks that tamper with them: base64url of the
 * CBOR map {1: version, 2: kind, 3: host identity, 4: invitation id, 5: secret, 6: expires_at, 7: [routes]}.
 */
import { createHash } from 'node:crypto'

export interface TicketFields {
  version: number
  kind: number
  /** Hex, or any text (put in as its UTF-8 bytes). */
  host: string
  /** Hex, 16 bytes. */
  invitation: string
  /** Hex. */
  secret: string
  expiresAt: number
  routes: string[]
}

const head = (major: number, value: number): Buffer => {
  if (value < 24) return Buffer.from([(major << 5) | value])
  if (value < 256) return Buffer.from([(major << 5) | 24, value])
  if (value < 65536) return Buffer.from([(major << 5) | 25, value >> 8, value & 255])
  const out = Buffer.alloc(5)
  out[0] = (major << 5) | 26
  out.writeUInt32BE(value, 1)
  return out
}
const bytes = (value: Buffer): Buffer => Buffer.concat([head(2, value.byteLength), value])
const text = (value: string): Buffer => {
  const raw = Buffer.from(value, 'utf8')
  return Buffer.concat([head(3, raw.byteLength), raw])
}
const hexOrText = (value: string): Buffer =>
  /^(?:[0-9a-f]{2})+$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value)

export function encodeTicket(fields: TicketFields): string {
  return Buffer.concat([
    head(5, 7),
    head(0, 1),
    head(0, fields.version),
    head(0, 2),
    head(0, fields.kind),
    head(0, 3),
    bytes(hexOrText(fields.host)),
    head(0, 4),
    bytes(Buffer.from(fields.invitation, 'hex')),
    head(0, 5),
    bytes(Buffer.from(fields.secret, 'hex')),
    head(0, 6),
    head(0, fields.expiresAt),
    head(0, 7),
    head(4, fields.routes.length),
    ...fields.routes.map(text)
  ]).toString('base64url')
}

/** Reads a ticket the way the helper does; throws on anything it would refuse to decode. */
export function decodeTicket(ticket: string): TicketFields {
  const fragment = ticket.slice(ticket.lastIndexOf('#') + 1)
  if (!/^[A-Za-z0-9_-]+$/.test(fragment)) throw new Error('encoding')
  const data = Buffer.from(fragment, 'base64url')
  let at = 0
  const byte = () => {
    if (at >= data.byteLength) throw new Error('cbor')
    return data[at++]!
  }
  const arg = (info: number) => {
    if (info < 24) return info
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0
    if (!size) throw new Error('cbor')
    let value = 0
    for (let i = 0; i < size; i++) value = value * 256 + byte()
    return value
  }
  const item = (): unknown => {
    const first = byte()
    const length = arg(first & 31)
    switch (first >> 5) {
      case 0:
        return length
      case 2:
      case 3: {
        if (at + length > data.byteLength) throw new Error('cbor')
        const out = data.subarray(at, at + length)
        at += length
        return first >> 5 === 2 ? Buffer.from(out) : out.toString('utf8')
      }
      case 4:
        return Array.from({ length }, item)
      case 5: {
        const map = new Map<unknown, unknown>()
        for (let i = 0; i < length; i++) map.set(item(), item())
        return map
      }
      default:
        throw new Error('cbor')
    }
  }
  const map = item()
  if (at !== data.byteLength || !(map instanceof Map)) throw new Error('cbor')
  const buf = (key: number) => {
    const value = map.get(key)
    if (!Buffer.isBuffer(value)) throw new Error('field')
    return value.toString('hex')
  }
  const num = (key: number) => {
    const value = map.get(key)
    if (typeof value !== 'number') throw new Error('field')
    return value
  }
  const routes = map.get(7)
  return {
    version: num(1),
    kind: num(2),
    host: buf(3),
    invitation: buf(4),
    secret: buf(5),
    expiresAt: num(6),
    routes: Array.isArray(routes) ? routes.map(String) : []
  }
}

/** The ticket hash: SHA-256 of its bytes, hex. */
export const ticketHash = (ticket: string): string =>
  createHash('sha256')
    .update(Buffer.from(ticket.slice(ticket.lastIndexOf('#') + 1), 'base64url'))
    .digest('hex')
