export const RELAY_ERROR_CODES = ['bad_request', 'too_large', 'bad_signature', 'bad_delegation', 'forbidden', 'invite_invalid', 'quota_exceeded', 'conflict', 'route_unreachable', 'cancelled', 'deadline_exceeded', 'internal'] as const
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number]
export function isRelayErrorCode(value: unknown): value is RelayErrorCode { return typeof value === 'string' && (RELAY_ERROR_CODES as readonly string[]).includes(value) }
export class NetRelayError extends Error {
  constructor(readonly code: RelayErrorCode, message: string = code) { super(message); this.name = 'NetRelayError' }
}
/** Policy refusals the wire has no code for, by the nearest one it has. */
const POLICY_CODES: Readonly<Record<string, RelayErrorCode>> = { revoked: 'forbidden', expired: 'forbidden', unauthorized: 'forbidden', not_found: 'forbidden' }
/**
 * The code a client is told. A policy (the hosted one throws its own error class) refuses with a
 * code too, and it is passed on, so a device can tell a quota from a revocation instead of `internal`.
 */
export function relayErrorCode(error: unknown): RelayErrorCode {
  if (error instanceof NetRelayError) return error.code
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return 'internal'
  return isRelayErrorCode(code) ? code : POLICY_CODES[code] ?? 'internal'
}
