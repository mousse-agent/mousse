/**
 * Exact-key parsers for reverse-command envelopes. Unknown methods/fields,
 * malformed inner worker payloads, and size overflow fail closed.
 */

import { BROWSER_ATTACHED_DISPATCH_METHOD } from '../../shared/browser/connectionCommands'
import {
  validateBrowserWorkerRequest,
  validateBrowserWorkerResponse
} from '../../shared/browser/envelope'
import {
  MMS_PROTOCOL_MAX_COMMAND_PAYLOAD_BYTES,
  MMS_PROTOCOL_MAX_ID_LENGTH,
  type ProtocolClientCommandResponse,
  type ProtocolServerCommandCancel,
  type ProtocolServerCommandRequest
} from './types'

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isBoundedString(v: unknown, maxLen: number, opts?: { nonEmpty?: boolean }): v is string {
  if (typeof v !== 'string') return false
  if (opts?.nonEmpty && !v.trim()) return false
  return v.length <= maxLen
}

const COMMAND_ID_PATTERN = /^[a-zA-Z0-9:_-]+$/
const SERVER_REQ_REQUIRED = [
  'kind',
  'id',
  'method',
  'registrationId',
  'registrationEpoch',
  'profileId',
  'profileEpoch',
  'request'
] as const
const CLIENT_RES_REQUIRED = [
  'kind',
  'id',
  'registrationId',
  'registrationEpoch',
  'requestId',
  'ok'
] as const
const CLIENT_RES_OPTIONAL = ['result', 'error'] as const
const SERVER_CANCEL_REQUIRED = ['kind', 'id', 'registrationId', 'registrationEpoch'] as const

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> | null {
  if (!isObject(value)) return null
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return null
  const allowed = new Set<string>([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return null
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return null
  }
  return value
}

export function isCommandId(value: unknown, maxLen = MMS_PROTOCOL_MAX_ID_LENGTH): value is string {
  return (
    isBoundedString(value, maxLen, { nonEmpty: true }) && COMMAND_ID_PATTERN.test(value)
  )
}

export function isCommandEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

export function commandPayloadBytes(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return null
  }
}

export function payloadWithinCommandBound(value: unknown): boolean {
  const bytes = commandPayloadBytes(value)
  return bytes !== null && bytes <= MMS_PROTOCOL_MAX_COMMAND_PAYLOAD_BYTES
}

function parseCommandError(raw: unknown): { code: string; message: string } | null {
  const error = exactObject(raw, ['code', 'message'])
  if (!error) return null
  if (!isBoundedString(error.code, 64, { nonEmpty: true })) return null
  if (!isBoundedString(error.message, 4096, { nonEmpty: true })) return null
  return { code: error.code, message: error.message }
}

export function parseServerCommandRequest(raw: unknown): ProtocolServerCommandRequest | null {
  const obj = exactObject(raw, SERVER_REQ_REQUIRED)
  if (!obj || obj.kind !== 'server_req') return null
  if (!isCommandId(obj.id) || !isCommandId(obj.registrationId) || !isCommandId(obj.profileId)) {
    return null
  }
  if (obj.method !== BROWSER_ATTACHED_DISPATCH_METHOD) return null
  if (!isCommandEpoch(obj.registrationEpoch) || !isCommandEpoch(obj.profileEpoch)) return null
  if (!payloadWithinCommandBound(obj.request)) return null
  try {
    const request = validateBrowserWorkerRequest(obj.request)
    if (request.profileId !== obj.profileId) return null
    return {
      kind: 'server_req',
      id: obj.id,
      method: BROWSER_ATTACHED_DISPATCH_METHOD,
      registrationId: obj.registrationId,
      registrationEpoch: obj.registrationEpoch,
      profileId: obj.profileId,
      profileEpoch: obj.profileEpoch,
      request
    }
  } catch {
    return null
  }
}

export function parseClientCommandResponse(raw: unknown): ProtocolClientCommandResponse | null {
  const obj = exactObject(raw, CLIENT_RES_REQUIRED, CLIENT_RES_OPTIONAL)
  if (!obj || obj.kind !== 'client_res') return null
  if (
    !isCommandId(obj.id) ||
    !isCommandId(obj.registrationId) ||
    !isCommandId(obj.requestId) ||
    !isCommandEpoch(obj.registrationEpoch)
  ) {
    return null
  }
  if (typeof obj.ok !== 'boolean') return null
  if (obj.ok) {
    if (obj.error !== undefined || obj.result === undefined) return null
    if (!payloadWithinCommandBound(obj.result)) return null
    try {
      const result = validateBrowserWorkerResponse(obj.result)
      if (result.id !== obj.requestId) return null
      return {
        kind: 'client_res',
        id: obj.id,
        registrationId: obj.registrationId,
        registrationEpoch: obj.registrationEpoch,
        requestId: obj.requestId,
        ok: true,
        result
      }
    } catch {
      return null
    }
  }
  if (obj.result !== undefined) return null
  const error = parseCommandError(obj.error)
  if (!error) return null
  return {
    kind: 'client_res',
    id: obj.id,
    registrationId: obj.registrationId,
    registrationEpoch: obj.registrationEpoch,
    requestId: obj.requestId,
    ok: false,
    error
  }
}

export function parseServerCommandCancel(raw: unknown): ProtocolServerCommandCancel | null {
  const obj = exactObject(raw, SERVER_CANCEL_REQUIRED)
  if (!obj || obj.kind !== 'server_cancel') return null
  if (!isCommandId(obj.id) || !isCommandId(obj.registrationId) || !isCommandEpoch(obj.registrationEpoch)) {
    return null
  }
  return {
    kind: 'server_cancel',
    id: obj.id,
    registrationId: obj.registrationId,
    registrationEpoch: obj.registrationEpoch
  }
}

/**
 * Best-effort correlation from a malformed server_req so the client can reject
 * without dispatching. Missing/invalid correlation means drop the frame.
 */
export function correlationFromMalformedServerReq(raw: unknown): {
  id: string
  registrationId: string
  registrationEpoch: number
  requestId: string
} | null {
  if (!isObject(raw) || raw.kind !== 'server_req') return null
  if (
    !isCommandId(raw.id) ||
    !isCommandId(raw.registrationId) ||
    !isCommandEpoch(raw.registrationEpoch)
  ) {
    return null
  }
  const requestId =
    isObject(raw.request) && isCommandId(raw.request.id) ? raw.request.id : null
  if (!requestId) return null
  return {
    id: raw.id,
    registrationId: raw.registrationId,
    registrationEpoch: raw.registrationEpoch,
    requestId
  }
}
