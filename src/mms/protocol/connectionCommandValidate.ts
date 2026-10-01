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
  browserNavigationUrl,
  validateBrowserActionRequest,
  validateBrowserWait
} from '../../shared/browser/validation'
import type { BrowserWorkerRequest } from '../../shared/browser/types'
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

function id(value: unknown): string {
  if (!isCommandId(value, 160)) throw new Error('invalid identifier')
  return value
}

function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined
  if (!isBoundedString(value, max, { nonEmpty: true })) throw new Error('invalid string')
  return value
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid integer')
  return value
}

/** The attached boundary accepts only parameter DTOs produced by BrowserSessionManager. */
export function validateAttachedBrowserWorkerRequest(value: unknown): BrowserWorkerRequest {
  const request = validateBrowserWorkerRequest(value)
  const p = request.params
  const exact = (required: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
    const result = exactObject(p, required, optional)
    if (!result) throw new Error(`invalid parameters for ${request.method}`)
    return result
  }
  let params: Record<string, unknown>
  switch (request.method) {
    case 'session.open': {
      const v = exact([], ['persistent', 'workspaceId', 'runId', 'threadId', 'url', 'uiTabId'])
      if (v.persistent !== undefined && typeof v.persistent !== 'boolean') throw new Error('invalid persistent flag')
      const workspaceId = v.workspaceId === undefined ? undefined : id(v.workspaceId)
      const runId = optionalString(v.runId, 160)
      const threadId = optionalString(v.threadId, 160)
      const uiTabId = v.uiTabId === undefined ? undefined : id(v.uiTabId)
      const url = v.url === undefined ? undefined : browserNavigationUrl(v.url)
      if (v.persistent === true && workspaceId === undefined) throw new Error('persistent sessions require workspaceId')
      params = {
        ...(v.persistent === undefined ? {} : { persistent: v.persistent }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(runId === undefined ? {} : { runId }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(url === undefined ? {} : { url }),
        ...(uiTabId === undefined ? {} : { uiTabId })
      }
      break
    }
    case 'session.close':
    case 'tabs.list': {
      const v = exact(['sessionId']); params = { sessionId: id(v.sessionId) }; break
    }
    case 'tabs.new': {
      const v = exact(['sessionId'], ['url'])
      params = { sessionId: id(v.sessionId), ...(v.url === undefined ? {} : { url: browserNavigationUrl(v.url) }) }
      break
    }
    case 'tabs.close':
    case 'tabs.switch': {
      const v = exact(['sessionId', 'tabId']); params = { sessionId: id(v.sessionId), tabId: id(v.tabId) }; break
    }
    case 'observe': {
      const v = exact(['sessionId'], ['tabId', 'ref', 'includeScreenshot', 'maxElements'])
      if (v.includeScreenshot !== undefined && typeof v.includeScreenshot !== 'boolean') throw new Error('invalid screenshot flag')
      params = { sessionId: id(v.sessionId),
        ...(v.tabId === undefined ? {} : { tabId: id(v.tabId) }),
        ...(v.ref === undefined ? {} : { ref: id(v.ref) }),
        ...(v.includeScreenshot === undefined ? {} : { includeScreenshot: v.includeScreenshot }),
        ...(v.maxElements === undefined ? {} : { maxElements: integer(v.maxElements, 1, 1000) }) }
      break
    }
    case 'find': {
      const v = exact(['sessionId', 'tabId', 'text'], ['role', 'ref'])
      const text = optionalString(v.text, 8192)
      if (text === undefined) throw new Error('invalid find text')
      params = { sessionId: id(v.sessionId), tabId: id(v.tabId), text,
        ...(v.role === undefined ? {} : { role: optionalString(v.role, 128)! }),
        ...(v.ref === undefined ? {} : { ref: id(v.ref) }) }
      break
    }
    case 'act':
    case 'human.act':
      params = validateBrowserActionRequest(p) as unknown as Record<string, unknown>
      break
    case 'wait': {
      const v = exact(['sessionId', 'tabId', 'condition', 'timeoutMs'])
      params = { sessionId: id(v.sessionId), tabId: id(v.tabId), condition: validateBrowserWait(v.condition), timeoutMs: integer(v.timeoutMs, 1, 120_000) }
      break
    }
    case 'extract': {
      const v = exact(['sessionId', 'tabId'], ['ref'])
      params = { sessionId: id(v.sessionId), tabId: id(v.tabId), ...(v.ref === undefined ? {} : { ref: id(v.ref) }) }
      break
    }
    case 'control.take': {
      const v = exact(['sessionId', 'owner'])
      if (v.owner !== 'agent' && v.owner !== 'human') throw new Error('invalid control owner')
      params = { sessionId: id(v.sessionId), owner: v.owner }
      break
    }
    case 'control.release': {
      const v = exact(['sessionId', 'controlLeaseId'])
      params = { sessionId: id(v.sessionId), controlLeaseId: id(v.controlLeaseId) }
      break
    }
  }
  return { ...request, params }
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
    const request = validateAttachedBrowserWorkerRequest(obj.request)
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
