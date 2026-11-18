import { NetError } from '../../shared/net/errors'

/** What this computer reads from a pairing ticket before it joins (the helper checks the rest). */
export interface TicketFacts {
  /** The host's helper identity, hex. */
  host: string
  /** The invitation id, hex: the joiner's receipt for the grant it gives back. */
  invitation: string
  /** When the ticket's invitation ends, in seconds since 1970. */
  expiresAt?: number
  /** The addresses the ticket names. */
  routes: string[]
}

const badTicket = (why: string): NetError =>
  new NetError('bad_request', "This isn't a Mousse pairing code.", {
    details: { reason: 'bad_ticket', why }
  })

/**
 * Reads a ticket: the part after `#` of a pairing link (or the bare text), base64url without padding, of a CBOR map
 * {1: version, 2: kind, 3: host identity, 4: invitation id, 5: secret, 6: expires_at, 7: [routes]}.
 */
export function readTicket(ticket: string): TicketFacts {
  const text = ticket.trim()
  const encoded = text.includes('#') ? text.slice(text.lastIndexOf('#') + 1) : text
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw badTicket('not base64url')
  const bytes = Buffer.from(encoded, 'base64url')
  let value: unknown
  try {
    const reader = new CborReader(bytes)
    value = reader.item(0)
    if (reader.at !== bytes.byteLength) throw new Error('trailing bytes')
  } catch (error) {
    throw badTicket(error instanceof Error ? error.message : 'not CBOR')
  }
  if (!(value instanceof Map)) throw badTicket('not a map')
  const host = value.get(3),
    invitation = value.get(4),
    expires = value.get(6),
    routes = value.get(7)
  if (!(host instanceof Uint8Array) || !host.byteLength) throw badTicket('no host identity')
  if (!(invitation instanceof Uint8Array) || invitation.byteLength !== 16)
    throw badTicket('no invitation id')
  return {
    host: Buffer.from(host).toString('hex'),
    invitation: Buffer.from(invitation).toString('hex'),
    ...(typeof expires === 'number' ? { expiresAt: expires } : {}),
    routes: Array.isArray(routes)
      ? routes.filter((route): route is string => typeof route === 'string')
      : []
  }
}

/** Enough CBOR for a ticket: integers, byte and text strings, arrays, maps and the simple values. */
class CborReader {
  at = 0
  constructor(private readonly bytes: Uint8Array) {}

  item(depth: number): unknown {
    if (depth > 8) throw new Error('nested too deep')
    const first = this.byte()
    const major = first >> 5
    const length = this.argument(first & 0x1f)
    switch (major) {
      case 0:
        return length
      case 1:
        return -1 - length
      case 2:
        return this.take(length)
      case 3:
        return Buffer.from(this.take(length)).toString('utf8')
      case 4: {
        const out: unknown[] = []
        for (let i = 0; i < length; i++) out.push(this.item(depth + 1))
        return out
      }
      case 5: {
        const out = new Map<unknown, unknown>()
        for (let i = 0; i < length; i++) {
          const key = this.item(depth + 1)
          out.set(key, this.item(depth + 1))
        }
        return out
      }
      case 7:
        if ((first & 0x1f) === 20) return false
        if ((first & 0x1f) === 21) return true
        if ((first & 0x1f) === 22) return null
        throw new Error('unsupported simple value')
      default:
        throw new Error('unsupported type')
    }
  }

  private byte(): number {
    if (this.at >= this.bytes.byteLength) throw new Error('truncated')
    return this.bytes[this.at++]!
  }
  private argument(info: number): number {
    if (info < 24) return info
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
    if (!size) throw new Error('indefinite lengths are not used')
    let value = 0
    for (let i = 0; i < size; i++) value = value * 256 + this.byte()
    if (!Number.isSafeInteger(value)) throw new Error('number too large')
    return value
  }
  private take(length: number): Uint8Array {
    if (this.at + length > this.bytes.byteLength) throw new Error('truncated')
    const out = this.bytes.subarray(this.at, this.at + length)
    this.at += length
    return out
  }
}
