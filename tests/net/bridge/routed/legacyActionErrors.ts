/** Frozen encoder/decoder bodies from 97de427076ee11884922d6b60f0ff85a2e33974b.
 * Only exports and function names differ; these are the actual pre-change Net error rules.
 */
import { NetError, NET_ERRORS, forbiddenReason, isForbiddenReason, type WireError } from '../../../../src/shared/net'
const FORBIDDEN_REASON_PREFIX = 'forbidden.'
export function legacyWireError(error: unknown): WireError {
  const code = error instanceof NetError ? error.code : 'internal'
  // Do not serialize arbitrary provider/OS messages, credentials or payloads. A refusal of a routed
  // call says which kind it was (a fixed word), in the cause slot older peers already accept.
  const reason =
    error instanceof NetError && code === 'forbidden' ? forbiddenReason(error.details) : undefined
  return {
    code,
    message: NET_ERRORS[code].message,
    retryable: NET_ERRORS[code].retryable,
    ...(reason
      ? {
          cause: [{ code: FORBIDDEN_REASON_PREFIX + reason, message: NET_ERRORS.forbidden.message }]
        }
      : {})
  }
}
export const legacyRemoteError = (error: WireError): NetError => {
  const reason =
    error.code === 'forbidden'
      ? error.cause
          ?.find((entry) => entry.code?.startsWith(FORBIDDEN_REASON_PREFIX))
          ?.code?.slice(FORBIDDEN_REASON_PREFIX.length)
      : undefined
  return reason && isForbiddenReason(reason)
    ? new NetError(error.code, undefined, { details: { reason } })
    : new NetError(error.code)
}
