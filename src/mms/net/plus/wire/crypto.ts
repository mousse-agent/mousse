// Public-key decoding/verification follow pinned Mousse identity/crypto.ts; see UPSTREAM.md.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { NetRelayError } from './errors.js'
import { parseBoundedJsonDocument } from './codec.js'
import type { Signed } from './types.js'

export function decodeBase64(value: string, length?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new NetRelayError('bad_request')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value || (length !== undefined && bytes.length !== length)) throw new NetRelayError('bad_request')
  return bytes
}
export function verifyBytes(bytes: Uint8Array, signature: Uint8Array, publicKey: string): void {
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decodeBase64(publicKey, 32)]), type: 'spki', format: 'der' })
    if (signature.length !== 64 || !verify(null, bytes, key, signature)) throw new Error('Signature mismatch')
  } catch { throw new NetRelayError('bad_signature') }
}
export function ticketHash(ticket: string): string { return createHash('sha256').update(decodeBase64(ticket, 32)).digest('base64url') }
export function isNodeId(value: unknown): value is `nod_${string}` { return typeof value === 'string' && /^nod_[0-9a-hjkmnp-tv-z]{26}$/.test(value) }
export function isUserId(value: unknown): value is `usr_${string}` { return typeof value === 'string' && /^usr_[0-9a-hjkmnp-tv-z]{26}$/.test(value) }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new NetRelayError('bad_delegation')
}
function integer(value: unknown, minimum = 0): void { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new NetRelayError('bad_delegation') }
function text(value: unknown, minimum: number, maximum: number): void { if (typeof value !== 'string' || Array.from(value).length < minimum || Array.from(value).length > maximum) throw new NetRelayError('bad_delegation') }
function encoded(value: unknown, maximum: number, fixed?: number): void {
  if (typeof value !== 'string' || value.length > maximum) throw new NetRelayError('bad_delegation')
  decodeBase64(value, fixed)
}
function signed(value: unknown): void {
  object(value, ['payload', 'sig']); encoded(value.payload, Math.ceil(65536 * 4 / 3)); encoded(value.sig, 86, 64)
}
/** Exact upstream identity subset, including unknown-field rejection. Freshness is hosted policy. */
export function validateIdentityDocument(value: unknown, kind: 'nodeDelegation' | 'roster'): void {
  if (kind === 'nodeDelegation') {
    object(value, ['v', 'kind', 'subject', 'keys', 'owner', 'name', 'caps', 'keyEpoch', 'issuedAt', 'expiresAt'])
    if (value.v !== 1 || value.kind !== 'node' || !isNodeId(value.subject) || !isUserId(value.owner)) throw new NetRelayError('bad_delegation')
    object(value.keys, ['sign', 'agree', 'transport']); encoded(value.keys.sign, 43, 32); encoded(value.keys.agree, 43, 32); encoded(value.keys.transport, 512)
    text(value.name, 1, 256); integer(value.keyEpoch, 1); integer(value.issuedAt); integer(value.expiresAt)
    if (!Array.isArray(value.caps) || value.caps.length > 5 || new Set(value.caps).size !== value.caps.length || value.caps.some(cap => !['read', 'chat', 'write', 'terminal', 'settings'].includes(cap))) throw new NetRelayError('bad_delegation')
  } else {
    object(value, ['v', 'owner', 'rootKey', 'recoveryEpoch', 'lineage', 'version', 'authorityNode', 'nodes', 'bots', 'revoked', 'issuedAt'])
    if (value.v !== 1 || !isUserId(value.owner) || !isNodeId(value.authorityNode)) throw new NetRelayError('bad_delegation')
    encoded(value.rootKey, 43, 32); integer(value.recoveryEpoch); integer(value.version, 1); integer(value.issuedAt); text(value.lineage, 1, 128)
    for (const name of ['nodes', 'bots']) { const items = value[name]; if (!Array.isArray(items) || items.length > 256) throw new NetRelayError('bad_delegation'); items.forEach(signed) }
    if (!Array.isArray(value.revoked) || value.revoked.length > 512) throw new NetRelayError('bad_delegation')
    for (const entry of value.revoked) { object(entry, ['subject', 'throughKeyEpoch', 'revokedAt']); if (!isNodeId(entry.subject) && !(typeof entry.subject === 'string' && /^bot_[0-9a-hjkmnp-tv-z]{26}$/.test(entry.subject))) throw new NetRelayError('bad_delegation'); integer(entry.throughKeyEpoch, 1); integer(entry.revokedAt) }
  }
}
/** Verify the transmitted payload bytes before parsing; never sign a reserialization. */
export function verifyDocument<T>(document: Signed, key: string, kind?: 'nodeDelegation' | 'roster'): T {
  signed(document)
  const payload = decodeBase64(document.payload)
  if (payload.length > 65536) throw new NetRelayError('too_large')
  verifyBytes(payload, decodeBase64(document.sig, 64), key)
  const value = parseBoundedJsonDocument(payload, 65536)
  if (kind) validateIdentityDocument(value, kind)
  return value as T
}
