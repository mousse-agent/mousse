import type { BrowserErrorCode, BrowserWorkerRequest, BrowserWorkerResponse } from './types'
import { BROWSER_PROBLEM_CODES, type BrowserProblem } from './navigation'

const METHODS: readonly BrowserWorkerRequest['method'][] = [
  'session.open', 'session.close', 'tabs.list', 'tabs.new', 'tabs.close', 'tabs.switch',
  'observe', 'find', 'act', 'human.act', 'wait', 'extract', 'control.take', 'control.release', 'frame', 'frame.next', 'frame.stop', 'human.input'
]

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('invalid_action: expected object')
  }
  for (const key of Object.keys(value)) if (!keys.includes(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('invalid_action: unexpected field ' + key)
  return value as Record<string, unknown>
}

function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || !value.trim()) throw new Error('invalid_action: invalid string')
  return value
}

function id(value: unknown): string {
  const result = string(value, 160)
  if (!/^[a-zA-Z0-9:_-]+$/.test(result)) throw new Error('invalid_action: invalid identifier')
  return result
}

const ERROR_CODES: readonly BrowserErrorCode[] = [
  'setup_required', 'profile_mismatch', 'session_closed', 'stale_generation', 'stale_observation', 'stale_ref',
  'invalid_geometry', 'not_actionable', 'policy_denied', 'approval_required', 'human_controlled', 'timeout',
  'cancelled', 'worker_disconnected', 'unsupported', 'invalid_action', 'no_progress', 'download_failed', 'artifact_denied',
  ...Object.values(BROWSER_PROBLEM_CODES)
]

const PROBLEM_KINDS: readonly BrowserProblem['kind'][] = ['unreachable', 'blocked', 'needs-you', 'browser-refused', 'cannot-start']
const PROBLEM_REASONS: readonly NonNullable<BrowserProblem['reason']>[] = ['sign-in', 'consent', 'human-check', 'unsafe-port', 'browser-rules', 'certificate']

/** A failed navigation's class, from a worker error's details: bounded plain fields only. */
function problemDetails(value: unknown): { problem?: BrowserProblem } | undefined {
  if (value === undefined) return undefined
  const details = object(value, ['problem'])
  if (details.problem === undefined) return {}
  const p = object(details.problem, ['kind', 'reason', 'code', 'host', 'cause'])
  if (!PROBLEM_KINDS.includes(p.kind as BrowserProblem['kind'])) throw new Error('invalid_action: unsupported problem kind')
  if (p.reason !== undefined && !PROBLEM_REASONS.includes(p.reason as NonNullable<BrowserProblem['reason']>)) throw new Error('invalid_action: unsupported problem reason')
  const text = (field: unknown, max: number) => field === undefined ? undefined : string(field, max)
  const code = text(p.code, 128)
  const host = text(p.host, 255)
  const cause = text(p.cause, 1024)
  return {
    problem: {
      kind: p.kind as BrowserProblem['kind'],
      ...(p.reason ? { reason: p.reason as BrowserProblem['reason'] } : {}),
      ...(code ? { code } : {}),
      ...(host ? { host } : {}),
      ...(cause ? { cause } : {})
    }
  }
}

export function validateBrowserWorkerRequest(value: unknown): BrowserWorkerRequest {
  const p = object(value, ['version', 'id', 'profileId', 'method', 'params'])
  if (p.version !== 1) throw new Error('invalid_action: unsupported worker protocol version')
  const method = string(p.method, 64)
  if (!METHODS.includes(method as BrowserWorkerRequest['method'])) throw new Error('invalid_action: unsupported method')
  if (!p.params || typeof p.params !== 'object' || Array.isArray(p.params)) throw new Error('invalid_action: params must be an object')
  for (const key of Object.keys(p.params)) if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('invalid_action: unexpected field ' + key)
  return {
    version: 1,
    id: id(p.id),
    profileId: id(p.profileId),
    method: method as BrowserWorkerRequest['method'],
    params: p.params as Record<string, unknown>
  }
}

export function validateBrowserWorkerResponse(value: unknown): BrowserWorkerResponse {
  const p = object(value, ['version', 'id', 'ok', 'result', 'error'])
  if (p.version !== 1) throw new Error('invalid_action: unsupported worker protocol version')
  if (typeof p.ok !== 'boolean') throw new Error('invalid_action: expected boolean')
  if (p.ok) {
    if (p.error !== undefined) throw new Error('invalid_action: unexpected field error')
    return { version: 1, id: id(p.id), ok: true, ...(p.result === undefined ? {} : { result: p.result }) }
  }
  const error = object(p.error, ['code', 'message', 'details'])
  const code = string(error.code, 64)
  if (!ERROR_CODES.includes(code as BrowserErrorCode)) throw new Error('invalid_action: unsupported error code')
  const details = problemDetails(error.details)
  return {
    version: 1,
    id: id(p.id),
    ok: false,
    error: { code: code as BrowserErrorCode, message: string(error.message, 4096), ...(details?.problem ? { details } : {}) }
  }
}

export const BROWSER_WORKER_METHODS = METHODS
