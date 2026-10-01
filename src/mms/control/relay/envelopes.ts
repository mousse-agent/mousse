/**
 * Canonical Application Envelopes for Control Protocol 2.0.
 * Aligned with docs/WIRE_PROTOCOL.md §6.
 *
 * Inside the Noise transport plaintext (UTF-8 JSON), validated types:
 * - request
 * - response
 * - event
 * - cancel
 * - snapshotRequired
 * - ping
 */

import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  METHOD_MAX_LENGTH,
  ID_MAX_LENGTH,
  IDEMPOTENCY_KEY_MAX_LENGTH
} from '../constants'
import type {
  ControlCancelEnvelope,
  ControlEnvelope,
  ControlEventEnvelope,
  ControlPingEnvelope,
  ControlRequestEnvelope,
  ControlResponseEnvelope,
  ControlResponseErrorEnvelope,
  ControlResponseResultEnvelope,
  ControlResumeCursor,
  ControlSnapshotRequiredEnvelope
} from '../../../shared/controlTypes'

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

export function requestEnvelope(input: {
  requestId: string
  method: string
  params?: unknown
  idempotencyKey?: string
  protocolMajor?: typeof PROTOCOL_MAJOR
  protocolMinor?: number
}): ControlRequestEnvelope {
  return {
    type: 'request',
    requestId: input.requestId,
    method: input.method,
    params: input.params ?? {},
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    protocolMajor: input.protocolMajor ?? PROTOCOL_MAJOR,
    ...(input.protocolMinor !== undefined ? { protocolMinor: input.protocolMinor } : {})
  }
}

export function responseResultEnvelope(
  requestId: string,
  result: unknown
): ControlResponseResultEnvelope {
  const env: ControlResponseResultEnvelope = {
    type: 'response',
    requestId,
    result
  }
  Object.defineProperties(env, {
    kind: { value: 'response', enumerable: false, writable: true },
    id: { value: requestId, enumerable: false, writable: true },
    ok: { value: true, enumerable: false, writable: true },
    data: { value: result, enumerable: false, writable: true }
  })
  return env
}

export function responseErrorEnvelope(
  requestId: string,
  error: { code: string; message: string; details?: unknown }
): ControlResponseErrorEnvelope {
  const env: ControlResponseErrorEnvelope = {
    type: 'response',
    requestId,
    error
  }
  Object.defineProperties(env, {
    kind: { value: 'response', enumerable: false, writable: true },
    id: { value: requestId, enumerable: false, writable: true },
    ok: { value: false, enumerable: false, writable: true }
  })
  return env
}

export function eventEnvelope(input: {
  instanceId: string
  sequence: number
  eventType: string
  payload?: unknown
}): ControlEventEnvelope {
  const env: ControlEventEnvelope = {
    type: 'event',
    instanceId: input.instanceId,
    sequence: input.sequence,
    eventType: input.eventType,
    payload: input.payload ?? {}
  }
  Object.defineProperties(env, {
    kind: { value: 'event', enumerable: false, writable: true },
    data: { value: input.payload ?? {}, enumerable: false, writable: true }
  })
  return env
}

export function cancelEnvelope(requestId: string): ControlCancelEnvelope {
  return {
    type: 'cancel',
    requestId
  }
}

export function snapshotRequiredEnvelope(input: {
  reason?: 'ring_overflow' | 'restart' | 'authorization_change' | 'gap' | 'explicit' | string
  cursor?: ControlResumeCursor
} = {}): ControlSnapshotRequiredEnvelope {
  return {
    type: 'snapshotRequired',
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {})
  }
}

export function pingEnvelope(input: {
  nonce?: string
  sentAt?: number
} = {}): ControlPingEnvelope {
  return {
    type: 'ping',
    ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {})
  }
}

/**
 * Canonical JSON serialization for encrypted application envelopes.
 * Key insertion order matches schema definitions exactly.
 */
export function canonicalizeEnvelope(envelope: ControlEnvelope): string {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('envelope must be an object')
  }

  const type = (envelope as { type: string }).type
  const ordered: Record<string, unknown> = {}

  if (type === 'request') {
    const req = envelope as ControlRequestEnvelope
    ordered.type = 'request'
    ordered.requestId = req.requestId
    ordered.method = req.method
    ordered.params = req.params ?? {}
    if (req.idempotencyKey !== undefined) {
      ordered.idempotencyKey = req.idempotencyKey
    }
    ordered.protocolMajor = req.protocolMajor ?? PROTOCOL_MAJOR
    if (req.protocolMinor !== undefined) {
      ordered.protocolMinor = req.protocolMinor
    }
    return JSON.stringify(ordered)
  }

  if (type === 'response') {
    const res = envelope as ControlResponseEnvelope
    ordered.type = 'response'
    ordered.requestId = res.requestId
    if ('result' in res && res.result !== undefined) {
      ordered.result = res.result
    } else if ('error' in res && res.error !== undefined) {
      ordered.error = res.error
    } else {
      throw new Error('response envelope must include either result or error')
    }
    return JSON.stringify(ordered)
  }

  if (type === 'event') {
    const evt = envelope as ControlEventEnvelope
    ordered.type = 'event'
    ordered.instanceId = evt.instanceId
    ordered.sequence = evt.sequence
    ordered.eventType = evt.eventType
    ordered.payload = evt.payload ?? {}
    return JSON.stringify(ordered)
  }

  if (type === 'cancel') {
    const can = envelope as ControlCancelEnvelope
    ordered.type = 'cancel'
    ordered.requestId = can.requestId
    return JSON.stringify(ordered)
  }

  if (type === 'snapshotRequired') {
    const snap = envelope as ControlSnapshotRequiredEnvelope
    ordered.type = 'snapshotRequired'
    if (snap.reason !== undefined) ordered.reason = snap.reason
    if (snap.cursor !== undefined) ordered.cursor = snap.cursor
    return JSON.stringify(ordered)
  }

  if (type === 'ping') {
    const ping = envelope as ControlPingEnvelope
    ordered.type = 'ping'
    if (ping.nonce !== undefined) ordered.nonce = ping.nonce
    if (ping.sentAt !== undefined) ordered.sentAt = ping.sentAt
    return JSON.stringify(ordered)
  }

  throw new Error(`unknown envelope type: ${String(type)}`)
}

/** UTF-8 bytes of canonical envelope JSON (Noise transport plaintext). */
export function encodeEnvelopeBytes(envelope: ControlEnvelope): Uint8Array {
  return TEXT_ENCODER.encode(canonicalizeEnvelope(envelope))
}

/** Decode UTF-8 bytes of canonical envelope JSON. */
export function decodeEnvelopeBytes(bytes: Uint8Array): ControlEnvelope {
  const text = TEXT_DECODER.decode(bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('envelope plaintext is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('envelope must be an object')
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.type !== 'string') {
    throw new Error('envelope missing type field')
  }
  return obj as unknown as ControlEnvelope
}
