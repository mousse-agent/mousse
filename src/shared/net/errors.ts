import type { ErrorDefinition } from '../errors'

/**
 * Stable Mousse Net error codes. The code is the contract; messages may change.
 * `retryable` classifies the failure only: the caller still decides replay safety.
 */
export const NET_ERRORS = {
  unsupported_version: { category: 'unsupported', retryable: false, message: 'The peer uses an unsupported protocol version.' },
  incompatible_peer: { category: 'unsupported', retryable: false, message: 'This device and the peer run incompatible versions.' },
  upgrade_required: { category: 'unsupported', retryable: false, message: 'This space uses a feature that needs a newer version.' },
  downgrade_unsupported: { category: 'unsupported', retryable: false, message: 'The stored data was written by a newer version.' },
  bad_request: { category: 'invalid', retryable: false, message: 'The request is malformed.' },
  too_large: { category: 'invalid', retryable: false, message: 'The payload exceeds the size limit.' },
  bad_signature: { category: 'denied', retryable: false, message: 'The signature does not verify.' },
  bad_delegation: { category: 'denied', retryable: false, message: 'The delegation is invalid or expired.' },
  peer_key_mismatch: { category: 'denied', retryable: false, message: 'The peer did not present the expected key.' },
  revoked: { category: 'denied', retryable: false, message: 'This device has been revoked.' },
  not_enrolled: { category: 'denied', retryable: false, message: 'This device is not enrolled.' },
  not_member: { category: 'denied', retryable: false, message: 'Not a member of this space.' },
  forbidden: { category: 'denied', retryable: false, message: 'Not permitted.' },
  invite_invalid: { category: 'denied', retryable: false, message: 'The invite is invalid, expired or already used.' },
  roster_conflict: { category: 'conflict', retryable: false, message: 'Conflicting identity records were found; choose an authority to continue.' },
  conflict: { category: 'conflict', retryable: false, message: 'The same identifier was used with different content.' },
  stream_unknown: { category: 'invalid', retryable: false, message: 'Unknown stream.' },
  snapshot_required: { category: 'conflict', retryable: true, message: 'The position is no longer available; a snapshot is needed.' },
  meta_stale: { category: 'unavailable', retryable: true, message: 'Membership information is not up to date yet.' },
  space_frozen: { category: 'unavailable', retryable: false, message: 'This space is frozen.' },
  rate_limited: { category: 'unavailable', retryable: true, message: 'Too many requests.' },
  quota_exceeded: { category: 'unavailable', retryable: false, message: 'The storage quota is exhausted.' },
  storage_full: { category: 'unavailable', retryable: false, message: 'The disk is full.' },
  storage_corrupt: { category: 'internal', retryable: false, message: 'Stored data failed an integrity check.' },
  keystore_locked: { category: 'unavailable', retryable: false, message: 'The key store is locked.' },
  keystore_missing: { category: 'unavailable', retryable: false, message: 'No identity exists on this device yet.' },
  clock_skew: { category: 'unavailable', retryable: true, message: 'The clock differs too much from the peer.' },
  route_unreachable: { category: 'unavailable', retryable: true, message: 'No route to the peer is reachable.' },
  peer_offline: { category: 'unavailable', retryable: true, message: 'The peer is offline.' },
  deadline_exceeded: { category: 'timeout', retryable: true, message: 'The operation timed out.' },
  cancelled: { category: 'cancelled', retryable: false, message: 'The operation was cancelled.' },
  budget_exhausted: { category: 'unavailable', retryable: false, message: 'The bot budget is exhausted.' },
  profile_unsupported: { category: 'unsupported', retryable: false, message: 'This runtime cannot enforce the requested bot profile.' },
  repo_not_bound: { category: 'unavailable', retryable: false, message: 'This repository is not linked on the target device.' },
  outcome_uncertain: { category: 'conflict', retryable: false, message: 'The operation may have partly happened; check before retrying.' },
  internal: { category: 'internal', retryable: false, message: 'Internal error.' }
} as const satisfies Record<string, ErrorDefinition>

export type NetErrorCode = keyof typeof NET_ERRORS

export function isNetErrorCode(value: unknown): value is NetErrorCode {
  return typeof value === 'string' && Object.hasOwn(NET_ERRORS, value)
}

/** Error with a stable code and an optional preserved cause chain. */
export class NetError extends Error {
  readonly code: NetErrorCode
  readonly details?: unknown

  constructor(code: NetErrorCode, message?: string, options?: { cause?: unknown; details?: unknown }) {
    super(message ?? NET_ERRORS[code].message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'NetError'
    this.code = code
    this.details = options?.details
  }

  get retryable(): boolean {
    return NET_ERRORS[this.code].retryable
  }
}
