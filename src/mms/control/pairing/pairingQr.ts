/**
 * QR Generator and Strict Parser for Control Protocol 2.0.
 * Aligned with docs/WIRE_PROTOCOL.md §2.
 *
 * URI format: `mousse://pair?v=2&data=<base64url(canonical-json)>`
 *
 * Strict validation:
 * - Query parameters are exactly `v` and `data` (no duplicates, no userinfo, no hash).
 * - `v` is only in the URI query. It is NOT a JSON field.
 * - Decoded JSON is at most 4 KiB.
 * - Key order for encoding is fixed (omit undefined):
 *   mode, controlOrigin, installationId, installationPublicKey,
 *   mmsDeviceId, mmsIdentityPublicKey, pairingId, expiresAt,
 *   protocolMajor, pairingSecret, accountId?
 * - pairingSecret, public keys: unpadded base64url of exactly 32 bytes (43 characters).
 * - controlOrigin: canonical absolute origin (https://host or http://host), no path/query/fragment/trailing slash.
 * - Hosted requires accountId. Self-hosted must omit it.
 * - protocolMajor must be 2.
 * - Reject expired expiresAt (ms since epoch) on parse unless explicitly allowed.
 */

import type { QrPayload, QrV2Payload } from '../../../shared/controlTypes'
import {
  PAIRING_SECRET_BYTES,
  PROTOCOL_MAJOR,
  PUBLIC_KEY_BYTES,
  QR_MAX_PAYLOAD_BYTES
} from '../constants'

export const QR_URI_SCHEME = 'mousse:'
export const QR_URI_HOST = 'pair'
export const QR_VERSION = 2 as const

const QR_PAYLOAD_KEY_ORDER = [
  'mode',
  'controlOrigin',
  'installationId',
  'installationPublicKey',
  'mmsDeviceId',
  'mmsIdentityPublicKey',
  'pairingId',
  'expiresAt',
  'protocolMajor',
  'pairingSecret',
  'accountId'
] as const

export function base64urlLengthForBytes(byteLength: number): number {
  return Math.ceil((byteLength * 4) / 3)
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error('invalid base64url charset')
  }
  return new Uint8Array(Buffer.from(value, 'base64url'))
}

export function canonicalizeQrPayload(payload: QrPayload): string {
  const ordered: Record<string, unknown> = {}
  for (const key of QR_PAYLOAD_KEY_ORDER) {
    const value = payload[key]
    if (value !== undefined) {
      ordered[key] = value
    }
  }
  return JSON.stringify(ordered)
}

function assertNoDuplicateJsonKeys(raw: string): void {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error('QR payload must be an object')
  }
  const keys: string[] = []
  const keyRe = /"((?:\\.|[^"\\])*)"\s*:/g
  let match: RegExpExecArray | null
  while ((match = keyRe.exec(trimmed)) !== null) {
    keys.push(JSON.parse(`"${match[1]}"`) as string)
  }
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) {
      throw new Error(`duplicate QR field: ${key}`)
    }
    seen.add(key)
  }
}

function validateKeyBase64Url(val: unknown, label: string): void {
  if (typeof val !== 'string' || !val.trim()) {
    throw new Error(`Missing or invalid ${label}`)
  }
  let buf: Uint8Array
  try {
    buf = decodeBase64Url(val)
  } catch {
    throw new Error(`${label} must be valid base64url`)
  }
  if (buf.byteLength !== PUBLIC_KEY_BYTES) {
    throw new Error(`Invalid public key length: expected ${PUBLIC_KEY_BYTES} bytes, got ${buf.byteLength}`)
  }
}

function validateSecretBase64Url(val: unknown, label: string): void {
  if (typeof val !== 'string' || !val.trim()) {
    throw new Error(`Missing or invalid ${label}`)
  }
  let buf: Uint8Array
  try {
    buf = decodeBase64Url(val)
  } catch {
    throw new Error(`${label} must be valid base64url`)
  }
  if (buf.byteLength !== PAIRING_SECRET_BYTES) {
    throw new Error(`Invalid pairing secret length: expected ${PAIRING_SECRET_BYTES} bytes, got ${buf.byteLength}`)
  }
}

function validateControlOrigin(origin: string): void {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new Error('invalid controlOrigin URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('controlOrigin must be http(s)')
  }
  if (url.username || url.password) {
    throw new Error('controlOrigin must not include userinfo')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('controlOrigin must not include a path')
  }
  if (url.search || url.hash) {
    throw new Error('controlOrigin must not include query or hash')
  }
  const canonical = `${url.protocol}//${url.host}`
  if (origin !== canonical) {
    throw new Error('controlOrigin must be canonical (no trailing slash)')
  }
}

export function validateQrPayload(payload: QrPayload, allowExpired = false): void {
  if (!payload || typeof payload !== 'object') {
    throw new Error('QR payload must be an object')
  }
  if ((payload as any).v !== undefined && (payload as any).v !== PROTOCOL_MAJOR) {
    throw new Error('Unsupported QR payload version: expected 2')
  }
  if (payload.protocolMajor !== PROTOCOL_MAJOR) {
    throw new Error('Unsupported QR payload version: protocolMajor must be 2')
  }
  if (payload.mode !== 'hosted' && payload.mode !== 'self-hosted') {
    throw new Error('Invalid QR mode: expected "hosted" or "self-hosted"')
  }
  if (payload.mode === 'hosted' && (!payload.accountId || !payload.accountId.trim())) {
    throw new Error('hosted QR payloads require accountId')
  }
  if (payload.mode === 'self-hosted' && payload.accountId !== undefined) {
    throw new Error('self-hosted QR payloads must not include accountId')
  }
  validateControlOrigin(payload.controlOrigin)

  if (!payload.installationId || !payload.installationId.trim()) {
    throw new Error('Missing or invalid installationId')
  }
  if (!payload.mmsDeviceId || !payload.mmsDeviceId.trim()) {
    throw new Error('Missing or invalid mmsDeviceId')
  }
  if (!payload.pairingId || !payload.pairingId.trim()) {
    throw new Error('Missing or invalid pairingId')
  }

  if (typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt)) {
    throw new Error('Missing or invalid expiresAt timestamp')
  }
  if (!allowExpired && Date.now() > payload.expiresAt) {
    throw new Error('Pairing QR code has expired')
  }

  validateKeyBase64Url(payload.installationPublicKey, 'installationPublicKey')
  validateKeyBase64Url(payload.mmsIdentityPublicKey, 'mmsIdentityPublicKey')
  validateSecretBase64Url(payload.pairingSecret, 'pairingSecret')
}


/**
 * Encode a QrPayload into the canonical `mousse://pair?v=2&data=...` URI.
 * Query parameter `v=2` is only in query string; NOT in JSON.
 */
export function encodePairingQrUri(payload: QrPayload): string {
  validateQrPayload(payload)
  const canonicalJson = canonicalizeQrPayload(payload)
  const base64url = Buffer.from(canonicalJson, 'utf-8').toString('base64url')

  if (Buffer.byteLength(canonicalJson, 'utf-8') > QR_MAX_PAYLOAD_BYTES) {
    throw new Error(`QR payload size exceeds maximum allowed ${QR_MAX_PAYLOAD_BYTES}`)
  }

  return `mousse://pair?v=2&data=${base64url}`
}

export const encodeQrUri = encodePairingQrUri

/**
 * Parse and strictly validate a `mousse://pair?v=2&data=...` URI.
 */
export function parsePairingQrUri(rawUri: string, options: { rejectExpired?: boolean } | boolean = true): QrPayload {
  const allowExpired = typeof options === 'boolean' ? !options : !(options?.rejectExpired ?? true)

  if (typeof rawUri !== 'string' || !rawUri.trim()) {
    throw new Error('QR payload is empty')
  }

  let url: URL
  try {
    url = new URL(rawUri)
  } catch {
    throw new Error('QR URI is not a valid URL')
  }

  if (url.protocol !== QR_URI_SCHEME) {
    throw new Error(`Invalid QR scheme: expected mousse:, got ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new Error('QR URI must not include userinfo')
  }
  if (url.hostname !== QR_URI_HOST) {
    throw new Error(`Invalid QR action: expected "pair", got "${url.hostname}"`)
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new Error('QR URI must not include a path')
  }
  if (url.hash) {
    throw new Error('QR URI must not include a hash')
  }

  const v = url.searchParams.get('v')
  const data = url.searchParams.get('data')
  if (v === null || data === null) {
    throw new Error('Missing required "v" or "data" parameter')
  }

  // Reject duplicate query keys or unexpected parameters
  const rawQuery = rawUri.includes('?') ? rawUri.slice(rawUri.indexOf('?') + 1) : ''
  const queryKeys = rawQuery
    .split('&')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part.split('=')[0] ?? ''))

  if (queryKeys.length !== 2 || !queryKeys.includes('v') || !queryKeys.includes('data')) {
    throw new Error('QR URI query must contain exactly "v" and "data"')
  }

  if (v !== String(QR_VERSION)) {
    throw new Error(`Unsupported QR version: expected "${QR_VERSION}", got "${v}"`)
  }

  const decodedBytes = decodeBase64Url(data)
  if (decodedBytes.byteLength > QR_MAX_PAYLOAD_BYTES) {
    throw new Error(`QR payload size exceeds maximum allowed ${QR_MAX_PAYLOAD_BYTES}`)
  }

  const jsonStr = Buffer.from(decodedBytes).toString('utf-8')
  assertNoDuplicateJsonKeys(jsonStr)

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    throw new Error('QR payload is not valid JSON')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('QR payload must be an object')
  }

  const record = parsed as Record<string, unknown>
  if ('v' in record) {
    throw new Error('QR JSON must not include field "v"')
  }

  const payload: QrPayload = {
    mode: record.mode as QrPayload['mode'],
    controlOrigin: String(record.controlOrigin ?? ''),
    installationId: String(record.installationId ?? ''),
    installationPublicKey: String(record.installationPublicKey ?? ''),
    mmsDeviceId: String(record.mmsDeviceId ?? ''),
    mmsIdentityPublicKey: String(record.mmsIdentityPublicKey ?? ''),
    pairingId: String(record.pairingId ?? ''),
    expiresAt: Number(record.expiresAt),
    protocolMajor: Number(record.protocolMajor) as 2,
    pairingSecret: String(record.pairingSecret ?? ''),
    ...(record.accountId !== undefined ? { accountId: String(record.accountId) } : {})
  }

  validateQrPayload(payload, allowExpired)
  Object.defineProperty(payload, 'v', { value: 2, enumerable: false, writable: true, configurable: true })
  return payload
}

export const parseQrUri = parsePairingQrUri
