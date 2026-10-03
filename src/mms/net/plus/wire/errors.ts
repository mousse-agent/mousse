export const RELAY_ERROR_CODES = ['bad_request', 'too_large', 'bad_signature', 'bad_delegation', 'forbidden', 'invite_invalid', 'quota_exceeded', 'conflict', 'route_unreachable', 'cancelled', 'deadline_exceeded', 'internal'] as const
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number]
export function isRelayErrorCode(value: unknown): value is RelayErrorCode { return typeof value === 'string' && (RELAY_ERROR_CODES as readonly string[]).includes(value) }
export class NetRelayError extends Error {
  constructor(readonly code: RelayErrorCode, message: string = code) { super(message); this.name = 'NetRelayError' }
}
export function relayErrorCode(error: unknown): RelayErrorCode {
  return error instanceof NetRelayError ? error.code : 'internal'
}
