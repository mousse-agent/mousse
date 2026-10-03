/** P0 executable encoding contract; transport/session/authorization are implemented in P1. */
import { NetError } from '../../../shared/net/errors'
import type { Envelope } from '../../../shared/net/envelope'
import { MAX_INLINE_ENVELOPE_BYTES, PREAUTH_MAX_BYTES, REPLAY_BATCH_BYTES } from '../../../shared/net/limits'
import { classifyWireMessage, validateEnvelope } from '../../../shared/net/schemas'
import { laneFor, type Lane, type WireMessage } from '../../../shared/net/wire'

export const MAX_MESSAGE_HEADER_BYTES = 64 * 1024
/** Prefix and header are included; mux fragments are separate. */
export const MAX_MESSAGE_BYTES = REPLAY_BATCH_BYTES
export const MAX_JSON_DEPTH = 32
export const MAX_JSON_NODES = 16_384
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const fail = (message: string): never => { throw new NetError('bad_request', message) }
const large = (message: string): never => { throw new NetError('too_large', message) }

/** No normalization or duplicate-key ambiguity in signed or header JSON. */
export function parseProtocolJson(bytes: Uint8Array): unknown {
  return parseBoundedJsonDocument(bytes, MAX_MESSAGE_BYTES)
}

/** Trusted assembled documents may have a larger byte budget; grammar, depth,
 * node count and duplicate-key protections remain the wire parser's rules. */
export function parseBoundedJsonDocument(bytes: Uint8Array, maximumBytes: number): unknown {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 32 * 1024 * 1024) return fail('Invalid JSON document byte bound.')
  if (bytes.length > maximumBytes) return large('JSON document exceeds its byte bound.')
  let source: string
  try { source = decoder.decode(bytes) } catch { return fail('Invalid UTF-8.') }
  let index = 0
  let nodes = 0
  const ws = (): void => { while (/[\x20\x09\x0a\x0d]/.test(source[index] ?? '\0')) index++ }
  const string = (): string => {
    const start = index++
    while (index < source.length) {
      const char = source[index++]
      if (char === '"') {
        let value: string
        try { value = JSON.parse(source.slice(start, index)) as string } catch { return fail('Invalid JSON string.') }
        if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return fail('Unpaired Unicode surrogate.')
        return value
      }
      if (char === '\\') index++
    }
    return fail('Unterminated JSON string.')
  }
  const value = (depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH || ++nodes > MAX_JSON_NODES) return large('JSON structure exceeds bounds.')
    ws()
    const char = source[index]
    if (char === '"') return string()
    if (char === '{') {
      index++; ws()
      const result = Object.create(null) as Record<string, unknown>
      if (source[index] === '}') { index++; return result }
      for (;;) {
        ws(); if (source[index] !== '"') return fail('Expected JSON object key.')
        if (++nodes > MAX_JSON_NODES) return large('JSON structure exceeds bounds.')
        const key = string()
        if (Object.hasOwn(result, key)) return fail('Duplicate JSON object key.')
        ws(); if (source[index++] !== ':') return fail('Expected colon.')
        result[key] = value(depth + 1); ws()
        const next = source[index++]
        if (next === '}') return result
        if (next !== ',') return fail('Expected object delimiter.')
      }
    }
    if (char === '[') {
      index++; ws()
      const result: unknown[] = []
      if (source[index] === ']') { index++; return result }
      for (;;) {
        result.push(value(depth + 1)); ws()
        const next = source[index++]
        if (next === ']') return result
        if (next !== ',') return fail('Expected array delimiter.')
      }
    }
    for (const [token, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(token, index)) { index += token.length; return parsed }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index))?.[0]
    if (!number) return fail('Invalid JSON value.')
    index += number.length
    const parsed = Number(number)
    if (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))) return fail('Unsafe JSON number.')
    return parsed
  }
  const result = value(0); ws()
  if (index !== source.length) return fail('Trailing JSON content.')
  return result
}

/** Canonical compact sorted-key JSON for presence and enrollment proof inputs only. */
export function canonicalJson(value: unknown): Uint8Array {
  let nodes = 0
  const serialize = (item: unknown, depth: number): string => {
    if (depth > MAX_JSON_DEPTH || ++nodes > MAX_JSON_NODES) return large('JSON structure exceeds bounds.')
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) return fail('Unsafe JSON number.')
      return JSON.stringify(item)
    }
    if (typeof item === 'string') {
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item)) return fail('Unpaired Unicode surrogate.')
      return JSON.stringify(item)
    }
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) if (!Object.hasOwn(item, i)) return fail('Sparse arrays are not canonical JSON.')
      return `[${item.map((entry) => serialize(entry, depth + 1)).join(',')}]`
    }
    if (typeof item === 'object' && item !== null && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      return `{${Object.keys(item).sort().map((key) => `${serialize(key, depth + 1)}:${serialize((item as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`
    }
    return fail('Expected a JSON value.')
  }
  return encoder.encode(serialize(value, 0))
}

function declaredParts(header: WireMessage): number[] {
  return 'parts' in header ? header.parts : []
}
function checkHeader(value: unknown): WireMessage {
  const classification = classifyWireMessage(value)
  if (classification === 'unknown') throw new NetError('unsupported_version', 'Unknown wire message type.')
  if (classification !== 'valid') return fail('Invalid wire message schema.')
  const header = value as WireMessage
  if (header.t === 'subscribed' && header.replayThrough !== header.head.seq) return fail('Replay boundary differs from captured head.')
  return header
}
function checkParts(header: WireMessage, parts: readonly Uint8Array[]): void {
  const lengths = declaredParts(header)
  if (parts.length !== lengths.length) return fail('Binary part count mismatch.')
  for (let i = 0; i < parts.length; i++) {
    if (!(parts[i] instanceof Uint8Array) || parts[i].byteLength !== lengths[i]) return fail('Binary part length mismatch.')
  }
  if (header.t === 'events' || header.t === 'snapshot.chunk') {
    if (lengths.length !== header.records.length * 2) return fail('Each record needs envelope and signature parts.')
    for (let i = 0; i < lengths.length; i += 2) if (lengths[i + 1] !== 64) return fail('Ed25519 signatures must be 64 bytes.')
    for (let i = 1; i < header.records.length; i++) {
      const prev = header.records[i - 1], next = header.records[i]
      if (next.epoch !== prev.epoch || next.seq !== prev.seq + 1) return fail('Record batch is not a dense sequence.')
    }
    if (header.t === 'snapshot.chunk' && header.records.some((entry) => entry.epoch > header.epoch || (entry.epoch === header.epoch && entry.seq > header.throughSeq))) return fail('Snapshot record exceeds declared position.')
  }
}

export function encodeMessage(header: WireMessage, parts: readonly Uint8Array[] = []): Uint8Array {
  const headerBytes = canonicalJson(header)
  if (headerBytes.length > MAX_MESSAGE_HEADER_BYTES) return large('Message header exceeds 64 KiB.')
  checkHeader(parseProtocolJson(headerBytes))
  checkParts(header, parts)
  const length = 4 + headerBytes.length + parts.reduce((total, part) => total + part.length, 0)
  if (length > MAX_MESSAGE_BYTES) return large('Message exceeds 1 MiB.')
  if (header.t === 'space.join.request' && length > PREAUTH_MAX_BYTES) return large('Space join request exceeds 16 KiB preauthentication limit.')
  const bytes = new Uint8Array(length)
  new DataView(bytes.buffer).setUint32(0, headerBytes.length, false)
  bytes.set(headerBytes, 4)
  let offset = 4 + headerBytes.length
  for (const part of parts) { bytes.set(part, offset); offset += part.length }
  return bytes
}

export function decodeMessage(bytes: Uint8Array, lane?: Lane): { header: WireMessage; parts: Uint8Array[] } {
  if (bytes.length > MAX_MESSAGE_BYTES) return large('Message exceeds 1 MiB.')
  if (bytes.length < 4) return fail('Truncated message prefix.')
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)
  if (headerLength > MAX_MESSAGE_HEADER_BYTES) return large('Message header exceeds 64 KiB.')
  if (headerLength === 0 || headerLength + 4 > bytes.length) return fail('Truncated message header.')
  const header = checkHeader(parseProtocolJson(bytes.subarray(4, 4 + headerLength)))
  if (header.t === 'space.join.request' && bytes.length > PREAUTH_MAX_BYTES) return large('Space join request exceeds 16 KiB preauthentication limit.')
  if (lane !== undefined && laneFor(header) !== lane) return fail('Message arrived on the wrong lane.')
  const parts: Uint8Array[] = []
  let offset = 4 + headerLength
  for (const length of declaredParts(header)) {
    if (length > bytes.length - offset) return fail('Truncated binary part.')
    parts.push(bytes.subarray(offset, offset + length)); offset += length
  }
  if (offset !== bytes.length) return fail('Undeclared trailing bytes.')
  checkParts(header, parts)
  return { header, parts }
}

/** Structural validation only. IdentityService verifies the returned exact bytes separately. */
export function decodeEnvelope(bytes: Uint8Array): { envelope: Envelope; bytes: Uint8Array } {
  if (bytes.length > MAX_INLINE_ENVELOPE_BYTES) return large('Envelope exceeds 64 KiB.')
  const envelope = parseProtocolJson(bytes)
  if (typeof envelope === 'object' && envelope !== null && 'v' in envelope && typeof envelope.v === 'number' && Number.isSafeInteger(envelope.v) && envelope.v > 1) throw new NetError('unsupported_version', 'Unsupported envelope version.')
  if (!validateEnvelope(envelope)) return fail('Invalid envelope schema.')
  return { envelope, bytes }
}

/** Serialize a new envelope once, then sign these returned bytes; retries retain them verbatim. */
export function encodeEnvelope(envelope: Envelope): Uint8Array {
  const bytes = canonicalJson(envelope)
  decodeEnvelope(bytes)
  return bytes
}
