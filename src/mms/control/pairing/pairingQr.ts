/**
 * QR v2 Generator and Strict Parser for Control Protocol 2.0.
 *
 * URI format: `mousse://pair?v=2&data=<base64url(canonical-json)>`
 * Strict schema validation:
 * - Rejects unknown major versions (!== 2)
 * - Rejects oversized payloads (> 4 KiB)
 * - Rejects expired payloads
 * - Rejects invalid key lengths (must be 32-byte base64)
 * - Never includes account/session/owner token
 */

import type { QrV2Payload } from '../../../shared/controlTypes'
import {
  PAIRING_SECRET_BYTES,
  PROTOCOL_MAJOR,
  PUBLIC_KEY_BYTES,
  QR_MAX_PAYLOAD_BYTES
} from '../constants'

/**
 * Encode a QrV2Payload into the canonical `mousse://pair?v=2&data=...` URI.
 */
export function encodePairingQrUri(payload: QrV2Payload): string {
  validateQrPayload(payload)

  const jsonStr = JSON.stringify({
    v: payload.v,
    mode: payload.mode,
    controlOrigin: payload.controlOrigin,
    installationId: payload.installationId,
    installationPublicKey: payload.installationPublicKey,
    mmsDeviceId: payload.mmsDeviceId,
    mmsIdentityPublicKey: payload.mmsIdentityPublicKey,
    pairingId: payload.pairingId,
    expiresAt: payload.expiresAt,
    protocolMajor: payload.protocolMajor,
    pairingSecret: payload.pairingSecret,
    ...(payload.accountId ? { accountId: payload.accountId } : {})
  })

  const base64url = Buffer.from(jsonStr, 'utf-8').toString('base64url')
  if (base64url.length > QR_MAX_PAYLOAD_BYTES) {
    throw new Error(`QR payload size ${base64url.length} exceeds maximum allowed ${QR_MAX_PAYLOAD_BYTES}`)
  }

  return `mousse://pair?v=2&data=${base64url}`
}

/**
 * Parse and strictly validate a `mousse://pair` URI or raw base64url data.
 */
export function parsePairingQrUri(rawUri: string, allowExpired = false): QrV2Payload {
  if (typeof rawUri !== 'string' || !rawUri.trim()) {
    throw new Error('QR payload is empty')
  }

  let dataParam = rawUri
  if (rawUri.includes('://')) {
    if (!rawUri.startsWith('mousse://pair')) {
      throw new Error(`Invalid QR scheme: expected mousse://pair, got ${rawUri}`)
    }
    try {
      const url = new URL(rawUri)
      if (url.hostname !== 'pair') {
        throw new Error(`Invalid QR action: expected "pair", got "${url.hostname}"`)
      }
      const v = url.searchParams.get('v')
      if (v !== '2') {
        throw new Error(`Unsupported QR version: expected "2", got "${v}"`)
      }
      const data = url.searchParams.get('data')
      if (!data) {
        throw new Error('Missing "data" parameter in pairing URI')
      }
      dataParam = data
    } catch (err) {
      throw new Error(`Invalid pairing URI: ${(err as Error).message}`)
    }
  }

  if (dataParam.length > QR_MAX_PAYLOAD_BYTES) {
    throw new Error(`QR data exceeds max length of ${QR_MAX_PAYLOAD_BYTES} bytes`)
  }

  let parsed: unknown
  try {
    const jsonStr = Buffer.from(dataParam, 'base64url').toString('utf-8')
    parsed = JSON.parse(jsonStr)
  } catch {
    throw new Error('QR payload is not valid base64url-encoded JSON')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('QR payload root must be an object')
  }

  const payload = parsed as Record<string, unknown>

  if (payload.v !== 2 || payload.protocolMajor !== PROTOCOL_MAJOR) {
    throw new Error(`Incompatible protocol major version: expected ${PROTOCOL_MAJOR}`)
  }

  if (payload.mode !== 'hosted' && payload.mode !== 'self-hosted') {
    throw new Error('Invalid QR mode: expected "hosted" or "self-hosted"')
  }

  if (typeof payload.controlOrigin !== 'string' || !payload.controlOrigin.startsWith('http')) {
    throw new Error('Invalid controlOrigin URL')
  }

  if (typeof payload.installationId !== 'string' || !payload.installationId.trim()) {
    throw new Error('Missing or invalid installationId')
  }

  if (typeof payload.mmsDeviceId !== 'string' || !payload.mmsDeviceId.trim()) {
    throw new Error('Missing or invalid mmsDeviceId')
  }

  if (typeof payload.pairingId !== 'string' || !payload.pairingId.trim()) {
    throw new Error('Missing or invalid pairingId')
  }

  if (typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt)) {
    throw new Error('Missing or invalid expiresAt timestamp')
  }

  if (!allowExpired && Date.now() > payload.expiresAt) {
    throw new Error('QR pairing code has expired')
  }

  validateKeyBase64(payload.installationPublicKey, 'installationPublicKey')
  validateKeyBase64(payload.mmsIdentityPublicKey, 'mmsIdentityPublicKey')

  if (typeof payload.pairingSecret !== 'string') {
    throw new Error('Missing pairingSecret in QR payload')
  }
  const secretBuf = Buffer.from(payload.pairingSecret, 'base64url')
  if (secretBuf.length !== PAIRING_SECRET_BYTES) {
    throw new Error(
      `Invalid pairingSecret length: expected ${PAIRING_SECRET_BYTES} bytes, got ${secretBuf.length}`
    )
  }

  if (payload.accountId !== undefined && (typeof payload.accountId !== 'string' || !payload.accountId.trim())) {
    throw new Error('Invalid accountId in QR payload')
  }

  return {
    v: 2,
    mode: payload.mode,
    controlOrigin: payload.controlOrigin,
    installationId: payload.installationId,
    installationPublicKey: payload.installationPublicKey as string,
    mmsDeviceId: payload.mmsDeviceId,
    mmsIdentityPublicKey: payload.mmsIdentityPublicKey as string,
    pairingId: payload.pairingId,
    expiresAt: payload.expiresAt,
    protocolMajor: 2,
    pairingSecret: payload.pairingSecret,
    ...(payload.accountId ? { accountId: payload.accountId as string } : {})
  }
}

function validateKeyBase64(val: unknown, fieldName: string): void {
  if (typeof val !== 'string' || !val.trim()) {
    throw new Error(`Missing or invalid ${fieldName}`)
  }
  try {
    const buf = Buffer.from(val, 'base64')
    if (buf.length !== PUBLIC_KEY_BYTES) {
      throw new Error(`Invalid public key length for ${fieldName}: expected ${PUBLIC_KEY_BYTES} bytes (got ${buf.length})`)
    }
  } catch (err) {
    if ((err as Error).message.includes('Invalid public key length')) throw err
    throw new Error(`${fieldName} is not valid base64`)
  }
}

export function validateQrPayload(payload: QrV2Payload, allowExpired = false): void {
  if (payload.v !== 2 || payload.protocolMajor !== 2) {
    throw new Error('Unsupported QR payload version: expected version 2')
  }
  if (!allowExpired && payload.expiresAt && payload.expiresAt < Date.now()) {
    throw new Error('Pairing QR code has expired')
  }
  if (!payload.controlOrigin || !payload.installationId || !payload.mmsDeviceId || !payload.pairingId) {
    throw new Error('Required payload fields missing')
  }
  validateKeyBase64(payload.installationPublicKey, 'installationPublicKey')
  validateKeyBase64(payload.mmsIdentityPublicKey, 'mmsIdentityPublicKey')
  const secretBuf = Buffer.from(payload.pairingSecret, 'base64url')
  if (secretBuf.length !== PAIRING_SECRET_BYTES) {
    throw new Error(`Invalid pairing secret length: expected ${PAIRING_SECRET_BYTES} bytes`)
  }
}
